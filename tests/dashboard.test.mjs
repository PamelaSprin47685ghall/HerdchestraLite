import { describe, expect, it } from "bun:test";
import { readHealth, recordHealth } from "../src/host/health.mjs";
import { deriveDashboard, renderDashboardText } from "../src/tui/dashboard-model.mjs";
import { applyStableHeightBound, mountDashboard, truncateToWidth, visibleWidth } from "../src/tui/dashboard-widget.mjs";

const START = 1_000_000;
const NOW = START + 125_000;

const mission = (overrides = {}) => ({
	slug: "demo",
	title: "演示使命",
	stage: "S5",
	revision: 7,
	contractLine: "sha256:abc",
	startedAt: START,
	tokens: { input: 1000, output: 500 },
	...overrides,
});

const SLICES = [
	{ slice_id: "slice-a", status: "running", worktree: ".herd-worktrees/demo/slice-a", last_event: "action started" },
	{ slice_id: "slice-b", status: "queued", worktree: ".herd-worktrees/demo/slice-b" },
	{ slice_id: "slice-c", status: "joined", worktree: ".herd-worktrees/demo/slice-c" },
	{ slice_id: "slice-d", status: "abandoned", worktree: ".herd-worktrees/demo/slice-d" },
];

const BOARD = {
	board_version: 9,
	tasks: {
		"T-1": { title: "根任务", state: "waiting", wait_for: ["T-2", "T-3"], needs_token: true },
		"T-2": { title: "准备契约", state: "ready" },
		"T-3": { title: "等待外部", state: "waiting", wait_for: ["T-9"] },
		"T-4": { title: "已完成", state: "done", parent: "T-1" },
	},
	actions: { "a-1": { state: "running", owner: "agent-a" } },
	actors: {
		"slot-1": {
			agent_id: "agent-a",
			life_state: "alive",
			reincarnations: 1,
			current_action: "a-1 提交",
		},
		"slot-2": { agent_id: "agent-b", life_state: "dead", reincarnations: 2 },
	},
	token_slot: {
		holder: { agent_id: "agent-a", term_id: "term-9", slot_id: "slot-1" },
		responsibility: ["T-1", "T-2"],
		waiting: ["T-9", "T-10"],
	},
	write_lock: {
		holder: { agent_id: "agent-b", term_id: "term-2" },
		action: "a-2 覆盖",
		queue: ["agent-c"],
		last_conflict: "stamp mismatch",
	},
};

const AUDIT = {
	active: true,
	phase: "submit",
	total: 4,
	auditors: [{ id: "auditor-1" }],
	cases: [
		{ case_id: "CASE-01", threshold: 85 },
		{ case_id: "CASE-02", threshold: 90 },
		{ case_id: "CASE-03", threshold: 90 },
		{ case_id: "CASE-04", threshold: 90 },
	],
	submissions: [
		{
			case_id: "CASE-01",
			user_score: 90,
			developer_score: 85,
			evidence_paths: ["plans/demo/evidence/CASE-01/report.md"],
		},
		{ case_id: "CASE-02", user_score: 95, developer_score: 80 },
		{ case_id: "CASE-04", user_score: 120, developer_score: 80 },
	],
};

const dashboard = (overrides = {}) =>
	deriveDashboard({
		mission: overrides.mission === undefined ? mission() : overrides.mission,
		slices: overrides.slices === undefined ? SLICES : overrides.slices,
		boards: overrides.boards === undefined ? { "slice-a": BOARD } : overrides.boards,
		audit: overrides.audit === undefined ? AUDIT : overrides.audit,
		focus: overrides.focus,
		writeLock: overrides.writeLock,
		now: overrides.now === undefined ? NOW : overrides.now,
	});

function fakeUi({ rejectFactory = false, rejectAll = false } = {}) {
	const calls = [];
	let factory = null;
	let inputHandler = null;
	let unsubscribed = false;
	const ui = {
		setWidget(key, content, widgetOptions) {
			if (rejectAll) throw new Error("widget unavailable");
			if (typeof content === "function" && rejectFactory) throw new Error("factory rejected");
			calls.push({ key, content, options: widgetOptions });
			if (typeof content === "function") factory = content;
			return undefined;
		},
		onTerminalInput(handler) {
			inputHandler = handler;
			return () => {
				unsubscribed = true;
			};
		},
		setHookWidget() {
			throw new Error("setHookWidget is a private host method");
		},
	};
	return {
		ctx: { ui },
		calls,
		getFactory: () => factory,
		getInput: () => inputHandler,
		isUnsubscribed: () => unsubscribed,
	};
}

describe("deriveDashboard compact view", () => {
	it("collects title, three-state status, stage, elapsed, tokens, slices, focus, and audit progress", () => {
		const model = dashboard();
		const text = model.compact.text;

		expect(text).toContain("Herdchestra Lite · 演示使命 · demo");
		expect(text).toContain("状态 进行中 · 阶段 S5 · 耗时 2m 05s · Token 1.5k");
		expect(text).toContain("Slice 4");
		expect(text).toContain("运行 1 · 排队 1 · 合入 1 · 放弃 1");
		expect(text).toContain("焦点 T-1 根任务 · 等待 [T-2, T-3]（解除后回 :ready）");
		expect(text).toContain("审计 逐 CASE 提交 · 已提交 3 / 4 · PASS 1 · FAIL 1 · PENDING 1 · INVALID 1");
		expect(text).toContain("Esc 取消");
		expect(model.compact.text).toBe(model.compact.lines.join("\n"));
		expect(model.status.compactText).toBe(model.compact.text);
		expect(model.status.text).toBe(model.compact.text);
	});

	it("shows only the three user-facing status words", () => {
		const running = dashboard();
		expect(running.mission.userState).toBe("进行中");
		const delivered = dashboard({
			mission: mission({ stage: "completed", approval: { valid: true }, reportPath: "plans/demo/s5-report.md" }),
		});
		expect(delivered.mission.userState).toBe("已交付");
		expect(delivered.compact.text).toContain("报告 plans/demo/s5-report.md");
		const undelivered = dashboard({
			mission: mission({
				userState: "未交付",
				outcome: { reason: "外部依赖不可用", lessons: "先验证依赖", retry: "/herd 重试" },
			}),
		});
		expect(undelivered.mission.userState).toBe("未交付");
		expect(undelivered.compact.text).toContain("原因 外部依赖不可用 · 教训 先验证依赖");
		expect(undelivered.compact.text).toContain("可重试 /herd 重试");
	});
});

describe("mission state discipline", () => {
	it("does not trust a hand-edited completed stage without an approval", () => {
		const model = dashboard({ mission: mission({ stage: "completed" }) });
		expect(model.mission.userState).toBe("进行中");
		expect(model.compact.text).toContain("状态 进行中");
	});

	it("reports missing undelivered reason and lessons as degradation", () => {
		const model = dashboard({ mission: mission({ userState: "未交付" }) });
		expect(model.degradation.degraded).toBe(true);
		expect(model.degradation.reasons).toContain("undelivered-reason-missing");
		expect(model.degradation.reasons).toContain("undelivered-lessons-missing");
		expect(model.compact.text).toContain("原因 未提供具体理由");
	});
});

describe("deriveDashboard expanded view", () => {
	it("renders the five drill-down layers with distinct task and token semantics", () => {
		const model = dashboard({ audit: null });
		const expanded = model.expanded;

		expect(expanded.regime).toBe("expanded");
		expect(expanded.layers.map((layer) => layer.key)).toEqual(["fleet", "tasks", "slots", "token", "write-lock"]);
		const text = expanded.text;
		expect(text).toContain("0. Fleet 总览");
		expect(text).toContain("slice-a · :running · 根任务 3");
		expect(text).toContain(".herd-worktrees/demo/slice-a");
		expect(text).toContain("最近: action started");
		expect(text).toContain("图例：等待解除回 :ready；只有 :done 表示任务完成。");
		expect(text).toContain("- T-1 根任务 [:waiting; wait-for: T-2, T-3 → :ready; 需令牌]");
		expect(text).toContain("  - T-4 已完成 [:done]");
		expect(text).toContain("slot-1 · agent-a · :alive · 转世 1 · 动作 a-1 提交");
		expect(text).toContain("Holder agent-a · term term-9 · slot slot-1");
		expect(text).toContain("责任: T-1, T-2");
		expect(text).toContain("等待令牌: T-9, T-10");
		expect(text).toContain("持有人 agent-b · term term-2 · 动作 a-2 覆盖 · 队列 1 · 最近冲突 stamp mismatch");
	});

	it("reads the board kernel's kebab-case control state", () => {
		const model = dashboard({
			audit: null,
			slices: [{ "slice-id": "slice-a", state: "running", worktree: ".herd-worktrees/demo/slice-a" }],
			boards: {
				"slice-a": {
					"board-version": 4,
					tasks: {
						"T-1": {
							"task-id": "T-1",
							goal: "根任务",
							state: "waiting",
							"wait-for": [],
							"needs-token": true,
							"owner-id": null,
						},
						"T-2": { "task-id": "T-2", goal: "子任务", state: "done", "parent-id": "T-1" },
					},
					actions: {
						"A-1": { "action-id": "A-1", phase: "running", "agent-id": "agent-a", "task-id": "T-1" },
					},
					actors: {
						"agent-a": {
							"agent-id": "agent-a",
							"slot-id": "slot-9",
							"life-state": "alive",
							"active-action-id": "A-1",
						},
					},
					"token-slot": { "holder-id": "agent-a", "term-id": "TERM-1", state: "held" },
				},
			},
			focus: { sliceId: "slice-a" },
			writeLock: {
				slice_id: "slice-a",
				owner_agent_id: "agent-c",
				owner_term_id: "TERM-9",
				purpose: "writeW",
				lock_id: "lock-1",
			},
		});
		const text = model.expanded.text;

		expect(text).toContain("slice-a · :running · 根任务 1");
		expect(text).toContain("- T-1 根任务 [:waiting; 需令牌]");
		expect(text).toContain("  - T-2 子任务 [:done]");
		expect(text).toContain("slot-9 · agent-a · :alive · 转世 0 · 动作 A-1");
		expect(text).toContain("Holder agent-a · term TERM-1");
		expect(text).toContain("责任: T-1, A-1");
		expect(text).toContain("4. 写锁 W");
		expect(text).toContain("持有人 agent-c · term TERM-9 · 动作 writeW · 队列 0");
	});
});

describe("audit score table", () => {
	it("shows user_score, developer_score, min, threshold, and a textual verdict for each CASE", () => {
		const model = dashboard();
		const text = model.expanded.text;

		expect(model.audit.active).toBe(true);
		expect(model.audit.phaseIndex).toBe(2);
		expect(model.audit.phaseLabel).toBe("逐 CASE 提交");
		expect(model.audit.counts).toEqual({
			submitted: 3,
			total: 4,
			pass: 1,
			fail: 1,
			pending: 1,
			invalid: 1,
		});
		expect(model.expanded.regime).toBe("audit");
		expect(model.expanded.layers.map((layer) => layer.key)).toEqual([
			"audit-contract",
			"audit-start",
			"audit-submit",
			"audit-aggregate",
			"audit-close",
		]);
		expect(text).toContain("契约复核");
		expect(text).toContain("审计员启动");
		expect(text).toContain("逐 CASE 提交");
		expect(text).toContain("汇总");
		expect(text).toContain("结案/返工");
		expect(text).toContain(
			"CASE-01 user_score=90 developer_score=85 min=85 threshold=85 PASS 证据 plans/demo/evidence/CASE-01/report.md",
		);
		expect(text).toContain("CASE-02 user_score=95 developer_score=80 min=80 threshold=90 FAIL");
		expect(text).toContain("CASE-03 user_score=— developer_score=— min=— threshold=90 PENDING");
		expect(text).toContain(
			"CASE-04 user_score=— developer_score=80 min=— threshold=90 INVALID 分数必须是 0–100 的整数",
		);
		expect(model.compact.text).toContain("已提交 3 / 4");
	});

	it("uses min(user_score, developer_score) and the inclusive threshold", () => {
		const model = deriveDashboard({
			mission: mission(),
			slices: [],
			boards: {},
			now: NOW,
			audit: {
				active: true,
				total: 1,
				cases: [
					{
						case_id: "CASE-01",
						threshold: 85,
						user_score: 85,
						developer_score: 100,
					},
				],
			},
		});
		expect(model.audit.cases[0].final).toBe(85);
		expect(model.audit.cases[0].verdict).toBe("PASS");
	});

	it("never lets an explicit pass override a below-threshold score, and honors an explicit fail", () => {
		const below = deriveDashboard({
			mission: mission(),
			audit: {
				total: 1,
				cases: [{ case_id: "CASE-01", threshold: 90, user_score: 80, developer_score: 100, verdict: "PASS" }],
			},
		});
		expect(below.audit.cases[0].verdict).toBe("FAIL");
		const explicitFail = deriveDashboard({
			mission: mission(),
			audit: {
				total: 1,
				cases: [{ case_id: "CASE-01", threshold: 80, user_score: 100, developer_score: 100, passed: false }],
			},
		});
		expect(explicitFail.audit.cases[0].verdict).toBe("FAIL");
	});

	it("keeps the score table in verbose text after the audit window closes", () => {
		const model = dashboard({
			audit: {
				active: false,
				closed: true,
				total: 1,
				cases: [{ case_id: "CASE-01", threshold: 85, user_score: 90, developer_score: 85 }],
			},
		});
		expect(model.expanded.regime).toBe("expanded");
		expect(model.compact.text).toContain("已提交 1 / 1");
		expect(model.expanded.text).toContain("审计得分");
		expect(model.expanded.text).toContain("CASE-01 user_score=90 developer_score=85 min=85 threshold=85 PASS");
	});

	it("counts unregistered CASEs as pending when only submissions are provided", () => {
		const model = dashboard({
			audit: {
				active: true,
				total: 3,
				submissions: [{ case_id: "CASE-01", user_score: 90, developer_score: 90, threshold: 85 }],
			},
		});
		expect(model.audit.counts).toMatchObject({ submitted: 1, total: 3, pass: 1, pending: 2 });
		expect(model.compact.text).toContain("已提交 1 / 3");
	});
});

describe("degradation and same-source text", () => {
	it("keeps rendering when sections are missing and lists the reasons", () => {
		const model = deriveDashboard({ mission: "broken", slices: 42, boards: [], audit: 9, now: NOW });
		expect(model.degradation.degraded).toBe(true);
		expect(model.degradation.reasons).toContain("mission-unreadable");
		expect(model.degradation.reasons).toContain("slices-unreadable");
		expect(model.degradation.reasons).toContain("audit-unreadable");
		expect(model.compact.text).toContain("无活跃使命");
	});

	it("renders verbose text from the same expanded model", () => {
		const model = dashboard();
		expect(renderDashboardText(model)).toBe(model.compact.text);
		expect(renderDashboardText(model, { mode: "verbose" })).toBe(model.expanded.text);
		expect(renderDashboardText(model, { mode: "expanded" })).toBe(model.expanded.text);
	});

	it("keeps every dashboard line on one terminal line and strips control bytes", () => {
		const model = dashboard({
			mission: mission({ title: "标题\n第二行" }),
			slices: [{ slice_id: "slice-a", status: "running", last_event: "事件\x1b[31m注入" }],
		});
		expect(model.compact.lines.every((line) => !line.includes("\n"))).toBe(true);
		expect(model.expanded.lines.every((line) => !line.includes("\n"))).toBe(true);
		expect(model.expanded.lines.every((line) => !line.includes("\x1b"))).toBe(true);
		expect(model.compact.text).toContain("标题 第二行");
	});
});

describe("applyStableHeightBound", () => {
	it("locks the first height, truncates growth, and pads shrinkage", () => {
		let lines = ["a", "b", "c"];
		const bound = applyStableHeightBound("compact", () => lines, { maxHeight: 5 });

		expect(bound.render(80)).toEqual(["a", "b", "c"]);
		expect(bound(80)).toEqual(["a", "b", "c"]);
		expect(bound.height).toBe(3);
		lines = ["a", "b", "c", "d"];
		expect(bound.render(80)).toEqual(["a", "b", "c"]);
		expect(bound.truncated).toBe(true);
		lines = ["a"];
		expect(bound.render(80)).toEqual(["a", "", ""]);
		expect(bound.truncated).toBe(false);
		expect(lines).toEqual(["a"]);
	});

	it("re-locks on a regime change, a width change, and a terminal-row change", () => {
		let lines = ["a", "b"];
		let rows = 40;
		const bound = applyStableHeightBound("regime-a", () => lines, {
			maxHeight: 5,
			terminalRows: () => rows,
			reserveRows: 6,
			maxFraction: 0.5,
		});
		expect(bound.render(80)).toEqual(["a", "b"]);
		lines = ["a", "b", "c", "d"];
		bound.render(81);
		expect(bound.height).toBe(4);
		bound.reset("regime-b");
		lines = ["x", "y", "z"];
		expect(bound.render(80)).toEqual(["x", "y", "z"]);
		rows = 9;
		lines = ["1", "2", "3", "4", "5", "6"];
		expect(bound.render(80)).toEqual(["1", "2", "3"]);
		expect(bound.height).toBe(3);
	});

	it("never exceeds the terminal budget", () => {
		const bound = applyStableHeightBound("budget", () => ["1", "2", "3", "4", "5", "6"], {
			maxHeight: 20,
			terminalRows: 10,
			reserveRows: 6,
			maxFraction: 0.5,
		});
		expect(bound.render(80)).toHaveLength(4);
	});
});

describe("dashboard widget", () => {
	it("mounts a component factory above the editor and renders model lines without color", () => {
		const harness = fakeUi();
		const health = [];
		const model = dashboard();
		const mount = mountDashboard(harness.ctx, model, { recordHealth: (entry) => health.push(entry) });

		expect(mount.ok).toBe(true);
		expect(mount.mode).toBe("component");
		expect(harness.calls).toHaveLength(1);
		expect(harness.calls[0].key).toBe("herdchestra-dashboard");
		expect(harness.calls[0].options).toEqual({ placement: "aboveEditor" });
		expect(typeof harness.calls[0].content).toBe("function");

		let renders = 0;
		const component = harness.getFactory()({ requestRender: () => renders++ }, {});
		const lines = component.render(200);
		expect(lines).toEqual(model.compact.lines);
		expect(mount.height).toBe(model.compact.lines.length);
		expect(lines.some((line) => line.includes("\x1b["))).toBe(false);
		expect(renders).toBe(0);
		mount.toggle();
		expect(renders).toBe(1);
	});

	it("accepts a raw state snapshot as the model source", () => {
		const harness = fakeUi();
		const mount = mountDashboard(
			harness.ctx,
			{ mission: mission(), slices: SLICES, boards: { "slice-a": BOARD }, audit: AUDIT, now: NOW },
			{ recordHealth: () => {} },
		);
		const component = harness.getFactory()({ requestRender: () => {} }, {});
		expect(mount.model.version).toBe(1);
		expect(component.render(120).join("\n")).toContain("Herdchestra Lite · 演示使命 · demo");
	});

	it("locks height across growth and shrinkage, then re-locks on width and regime changes", () => {
		const harness = fakeUi();
		const mount = mountDashboard(harness.ctx, dashboard(), { recordHealth: () => {} });
		const component = harness.getFactory()({ requestRender: () => {} }, {});
		const compactHeight = component.render(100).length;

		const undelivered = dashboard({
			mission: mission({
				userState: "未交付",
				outcome: { reason: "外部依赖不可用", lessons: "先验证依赖" },
			}),
		});
		mount.update(undelivered);
		const grown = component.render(100);
		expect(grown).toHaveLength(compactHeight);
		expect(grown[grown.length - 1]).toContain("已截断");
		expect(mount.height).toBe(compactHeight);

		const wider = component.render(120);
		expect(wider).toHaveLength(compactHeight + 1);
		expect(mount.height).toBe(compactHeight + 1);

		mount.toggle();
		const expanded = component.render(120);
		expect(expanded[0]).toContain("0. 契约复核");
		expect(expanded.length).toBeLessThanOrEqual(22);
		expect(mount.height).toBe(expanded.length);
		expect(expanded.join("\n")).toContain("4. 结案/返工");
		expect(expanded.join("\n")).toContain("审计得分");

		mount.toggle();
		expect(component.render(120)).toHaveLength(compactHeight + 1);
	});

	it("switches to a narrow priority view with a verbose hint", () => {
		const harness = fakeUi();
		const model = dashboard();
		const mount = mountDashboard(harness.ctx, model, { recordHealth: () => {} });
		const component = harness.getFactory()({ requestRender: () => {} }, {});
		const lines = component.render(40);

		expect(lines.length).toBeLessThanOrEqual(model.compact.essentialCount + 1);
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
		expect(lines.some((line) => line.includes("状态"))).toBe(true);
		expect(lines.some((line) => line.includes("焦点"))).toBe(true);
		expect(lines.join("\n")).toContain("verbose");
		expect(lines.some((line) => line.includes("\x1b["))).toBe(false);
		expect(mount.setExpanded(true)).toBe(true);
		expect(component.render(40).join("\n")).toContain("状态");
	});

	it("reserves the bottom input area instead of filling the terminal", () => {
		const harness = fakeUi();
		const mount = mountDashboard(harness.ctx, dashboard(), {
			terminalRows: 10,
			reserveRows: 6,
			maxFraction: 0.5,
			recordHealth: () => {},
		});
		const component = harness.getFactory()({ requestRender: () => {} }, {});
		expect(component.render(100)).toHaveLength(4);
		expect(mount.height).toBe(4);
	});

	it("falls back to a string array capped at 10 lines when the factory is rejected", () => {
		const harness = fakeUi({ rejectFactory: true });
		const health = [];
		const mount = mountDashboard(harness.ctx, dashboard(), { recordHealth: (entry) => health.push(entry) });

		expect(mount.ok).toBe(true);
		expect(mount.mode).toBe("text");
		expect(harness.calls).toHaveLength(1);
		const lines = harness.calls[0].content;
		expect(Array.isArray(lines)).toBe(true);
		expect(lines.length).toBeLessThanOrEqual(10);
		expect(lines.join("\n")).toContain("Herdchestra Lite");
		expect(health.some((entry) => entry.error.includes("component-factory-failed"))).toBe(true);
		expect(health.some((entry) => entry.error.includes("text-fallback-active"))).toBe(true);
		expect(harness.calls[0].options).toEqual({ placement: "aboveEditor" });
	});

	it("caps forced expanded text at 10 lines and updates the same array slot", () => {
		const harness = fakeUi();
		const mount = mountDashboard(harness.ctx, dashboard({ audit: null }), {
			forceText: true,
			expanded: true,
			terminalColumns: 120,
			terminalRows: 40,
			recordHealth: () => {},
		});

		expect(mount.mode).toBe("text");
		expect(mount.ok).toBe(true);
		const expandedLines = harness.calls[0].content;
		expect(expandedLines.length).toBeLessThanOrEqual(10);
		expect(expandedLines.join("\n")).toContain("0. Fleet 总览");
		expect(expandedLines[expandedLines.length - 1]).toContain("verbose");

		mount.toggle();
		expect(harness.calls).toHaveLength(2);
		expect(harness.calls[1].content.length).toBeLessThanOrEqual(10);
		expect(harness.calls[1].content.join("\n")).toContain("状态 进行中");
	});

	it("stays alive and records health when the widget API is missing", () => {
		const health = [];
		const mount = mountDashboard({ ui: {} }, dashboard(), { recordHealth: (entry) => health.push(entry) });

		expect(mount.ok).toBe(false);
		expect(mount.mode).toBe("unavailable");
		expect(mount.reason).toBe("setWidget-unavailable");
		expect(mount.renderText()).toContain("Herdchestra Lite");
		expect(health[0]).toMatchObject({
			entry: "tui.dashboard",
			status: "failed",
			degraded: true,
			version: "1",
		});
		expect(health[0].capabilities.setWidget).toBe(false);
	});

	it("records a degradation through the real host health registry", () => {
		const mount = mountDashboard({ ui: {} }, dashboard(), { recordHealth });
		expect(mount.ok).toBe(false);
		const entry = readHealth().entries.find((item) => item.entry === "tui.dashboard");
		expect(entry.status).toBe("failed");
		expect(entry.degraded).toBe(true);
		expect(entry.error).toContain("setWidget-unavailable");
	});

	it("survives a throwing model provider and keeps serving the last good dashboard", () => {
		const harness = fakeUi();
		const health = [];
		const mount = mountDashboard(
			harness.ctx,
			() => {
				throw new Error("state store unavailable");
			},
			{ recordHealth: (entry) => health.push(entry) },
		);
		expect(mount.ok).toBe(true);
		const component = harness.getFactory()({ requestRender: () => {} }, {});
		expect(component.render(100).join("\n")).toContain("无活跃使命");
		expect(health.some((entry) => entry.error.includes("model-provider-failed"))).toBe(true);
	});

	it("toggles from the public terminal-input hook and closes cleanly", () => {
		const harness = fakeUi();
		const mount = mountDashboard(harness.ctx, dashboard(), { recordHealth: () => {} });

		expect(harness.getInput()("\x1b[116;5u")).toEqual({ consume: true });
		expect(mount.expanded).toBe(true);
		expect(harness.getInput()("x")).toBeUndefined();
		expect(mount.close()).toBe(true);
		expect(harness.calls.at(-1).content).toBeUndefined();
		expect(harness.isUnsubscribed()).toBe(true);
	});

	it("leaves the shortcut to the extension when shortcutProvided is set", () => {
		const harness = fakeUi();
		const health = [];
		const mount = mountDashboard(harness.ctx, dashboard(), {
			shortcutProvided: true,
			recordHealth: (entry) => health.push(entry),
		});
		expect(mount.shortcut).toBe("ctrl+shift+t");
		expect(harness.getInput()).toBeNull();
		expect(health).toHaveLength(0);
		expect(mount.toggle()).toBe(true);
	});
});

describe("width helpers", () => {
	it("counts CJK as two columns and truncates within the requested width", () => {
		expect(visibleWidth("状态")).toBe(4);
		expect(visibleWidth("\x1b[31m状态\x1b[0m")).toBe(4);
		const cut = truncateToWidth("状态进行中", 5);
		expect(cut.endsWith("…")).toBe(true);
		expect(visibleWidth(cut)).toBeLessThanOrEqual(5);
	});
});
