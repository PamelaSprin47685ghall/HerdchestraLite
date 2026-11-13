import { describe, expect, it } from "bun:test";
import {
	AUDIT_PHASES,
	DASHBOARD_MODEL_VERSION,
	STAGE_ATTACH,
	deriveDashboard,
	renderDashboardText,
} from "../src/tui/dashboard-model.mjs";

const START = 1_000_000;
const NOW = START + 125_000;

const mission = (overrides = {}) => ({
	slug: "demo",
	title: "演示使命",
	stage: "S5",
	tenure: "T-3",
	startedAt: START,
	...overrides,
});

const board = (overrides = {}) => ({
	board_version: 9,
	tasks: {
		"T-1": {
			title: "根任务",
			state: "waiting",
			wait_for: ["T-2"],
			needs_token: true,
			owner: "agent-a",
			child_keys: ["T-4"],
		},
		"T-2": { title: "准备契约", state: "ready" },
		"T-4": { title: "已完成", state: "done" },
	},
	...overrides,
});

const AUDIT_ALL_PASS = {
	active: true,
	phase: "submit",
	total: 2,
	auditors: 2,
	cases: [
		{ case_id: "CASE-01", threshold: 85, user_score: 90, developer_score: 85 },
		{ case_id: "CASE-02", threshold: 90, user_score: 95, developer_score: 92 },
	],
};

const AUDIT_WITH_FAIL = {
	...AUDIT_ALL_PASS,
	cases: [
		{ case_id: "CASE-01", threshold: 85, user_score: 90, developer_score: 85 },
		{ case_id: "CASE-02", threshold: 90, user_score: 80, developer_score: 92 },
	],
};

const dashboard = (input = {}) =>
	deriveDashboard({
		mission: mission(),
		boards: {},
		audit: null,
		now: NOW,
		...input,
	});

describe("dashboard section order", () => {
	it("renders stage, tenure, attach, review, board, and audit in that order", () => {
		const model = dashboard({
			mission: mission({ stage: "S2", attached: ["s2-cases.edn"] }),
			boards: board({ findings: { "F-1": "修复登录" } }),
			audit: AUDIT_ALL_PASS,
		});
		const text = model.compact.text;
		const anchors = [
			"阶段 S2",
			"任期 T-3",
			"交付物 已 attach",
			"审查 发现 1 项 · wake-all",
			"焦点 T-1 根任务 · 等待 [T-2]（解除后回 :ready）",
			"审计 逐 CASE 提交 · 已提交 2 / 2 · PASS 2 · FAIL 0 · PENDING 0",
		];
		const positions = anchors.map((anchor) => text.indexOf(anchor));
		for (const [index, position] of positions.entries()) {
			expect(position).toBeGreaterThanOrEqual(0);
			if (index > 0) expect(position).toBeGreaterThan(positions[index - 1]);
		}
		expect(model.compact.lines[0]).toBe("Herdchestra Lite · 演示使命 · demo");
		expect(model.compact.lines).toContain("状态 进行中 · 阶段 S2 · 任期 T-3 · 耗时 2m 05s");
		expect(model.status.stage).toBe("S2");
		expect(model.status.tenure).toBe("T-3");
		expect(DASHBOARD_MODEL_VERSION).toBe(1);
		expect(AUDIT_PHASES.map((phase) => phase.key)).toEqual(["start", "submit", "aggregate", "close"]);
		expect(renderDashboardText(model)).toBe(model.compact.text);
		expect(renderDashboardText(model, { mode: "verbose" })).toBe(model.expanded.text);
	});
});

describe("review section", () => {
	it("shows the attach hint and the no-review line for an empty board", () => {
		const model = dashboard({ mission: mission({ stage: "S2" }) });
		const lines = model.compact.lines;
		const attachIndex = lines.findIndex((line) => line.startsWith("交付物 "));
		expect(lines[attachIndex]).toBe("交付物 待 attach · 下一步 attach_manual_tests → s2-cases.edn");
		expect(lines[attachIndex + 1]).toBe("审查 尚无 review 记录");
		expect(model.review).toBeNull();
		expect(model.status.reviewOpen).toBe(false);
		expect(model.status.findings).toBe(0);
	});

	it("shows the number of open findings", () => {
		const model = dashboard({
			mission: mission({ stage: "S5" }),
			boards: board({ findings: { "F-1": "修复登录", "F-2": "补齐测试" } }),
		});
		expect(model.review.open).toBe(true);
		expect(model.review.findings.map((entry) => entry.key)).toEqual(["F-1", "F-2"]);
		expect(model.compact.text).toContain("审查 发现 2 项 · wake-all");
		expect(model.expanded.text).toContain("findings: F-1, F-2");
		expect(model.status.findings).toBe(2);
	});

	it("treats an empty findings array as quiescent without changing the board", () => {
		const model = dashboard({
			mission: mission({ stage: "S2" }),
			boards: board({ findings: [] }),
		});
		expect(model.review.present).toBe(true);
		expect(model.review.open).toBe(false);
		expect(model.review.findings).toEqual([]);
		expect(model.compact.text).toContain("审查 quiescent");
		expect(model.compact.text).not.toContain("发现");
	});
});

describe("attach section", () => {
	it("renders the pending attachment with tool and document", () => {
		const model = dashboard({ mission: mission({ stage: "S3" }) });
		expect(model.mission.attach.ready).toBe(false);
		expect(model.mission.attach.expectedTool).toBe("attach_dev_guide");
		expect(model.mission.attach.expectedDocument).toBe("dev-guide.md");
		expect(model.compact.text).toContain("交付物 待 attach · 下一步 attach_dev_guide → dev-guide.md");
	});

	it("renders a ready attachment when the stage document is attached", () => {
		const model = dashboard({ mission: mission({ stage: "S3", attached: ["dev-guide.md"] }) });
		expect(model.mission.attach.ready).toBe(true);
		expect(model.compact.text).toContain("交付物 已 attach");
	});

	it("keeps only the ready and pending states; approved and revise do not exist", () => {
		const model = dashboard({ mission: mission({ stage: "S4" }) });
		expect(Object.keys(model.mission.attach).sort()).toEqual([
			"expectedDocument",
			"expectedTool",
			"ready",
		]);
		expect(STAGE_ATTACH.S4).toEqual({ tool: "attach_coordination", document: "coordination.md" });
	});
});

describe("board section", () => {
	const model = () => dashboard({ mission: mission({ stage: "S2" }), boards: board() });

	it("renders the flat task map with state, parent, wait-for, and owner", () => {
		const tasks = model().expanded.layers.find((layer) => layer.key === "tasks");
		expect(tasks.title).toBe("1. 任务树 · review board");
		const text = tasks.lines.join("\n");
		expect(text).toContain("图例：等待解除回 :ready；只有 :done 表示任务完成。");
		expect(text).toContain("- T-1 根任务 [:waiting; wait-for: T-2 → :ready; 需令牌; owner: agent-a]");
		expect(text).toContain("- T-4 已完成 [:done]");
		expect(text).toContain("- T-2 准备契约 [:ready]");
	});

	it("nests child keys under the parent key", () => {
		const lines = model().expanded.layers.find((layer) => layer.key === "tasks").lines;
		const parentIndex = lines.findIndex((line) => line.includes("- T-1 根任务"));
		const childIndex = lines.findIndex((line) => line.includes("- T-4 已完成"));
		const siblingIndex = lines.findIndex((line) => line.includes("- T-2 准备契约"));
		expect(parentIndex).toBeGreaterThanOrEqual(0);
		expect(childIndex).toBeGreaterThan(parentIndex);
		expect(childIndex).toBeLessThan(siblingIndex);
		expect(lines[parentIndex]).toMatch(/^ {2}- /);
		expect(lines[childIndex]).toMatch(/^ {4}- /);
	});

	it("does not render a claim id because the source has no claim-id field", () => {
		const text = model().expanded.text;
		expect(text).not.toContain("claim-id");
		expect(text).not.toContain("claim_id");
	});
});

describe("audit section", () => {
	it("renders one PASS line per case and a full-pass summary", () => {
		const model = dashboard({ mission: mission(), boards: board(), audit: AUDIT_ALL_PASS });
		expect(model.audit.active).toBe(true);
		expect(model.audit.counts).toEqual({
			submitted: 2,
			total: 2,
			pass: 2,
			fail: 0,
			pending: 0,
			invalid: 0,
		});
		expect(model.expanded.regime).toBe("audit");
		const text = model.expanded.text;
		expect(text).toContain("CASE-01 user_score=90 developer_score=85 min=85 threshold=85 PASS");
		expect(text).toContain("CASE-02 user_score=95 developer_score=92 min=92 threshold=90 PASS");
		expect(text).toContain("汇总 已提交 2 / 2 · PASS 2 · FAIL 0 · PENDING 0");
		expect(text).toContain("全部 CASE PASS：等待一次性批准");
		expect(model.audit.cases).toHaveLength(2);
		expect(model.audit.cases.every((entry) => entry.line.split("CASE-").length === 2)).toBe(true);
	});

	it("renders FAIL text and the rework decision when a case misses the threshold", () => {
		const model = dashboard({ mission: mission(), boards: board(), audit: AUDIT_WITH_FAIL });
		const text = model.expanded.text;
		expect(model.audit.counts).toEqual({
			submitted: 2,
			total: 2,
			pass: 1,
			fail: 1,
			pending: 0,
			invalid: 0,
		});
		expect(text).toContain("CASE-02 user_score=80 developer_score=92 min=80 threshold=90 FAIL");
		expect(text).toContain("存在 FAIL：转入返工 Slice，不结案");
		expect(model.compact.text).toContain("审计 逐 CASE 提交 · 已提交 2 / 2 · PASS 1 · FAIL 1 · PENDING 0");
	});
});

describe("removed mechanisms stay out of the rendered text", () => {
	it("never renders contractLine, worktree, slice, realign, or frozen", () => {
		const model = dashboard({
			mission: mission({ stage: "S2", tenure: "T-3" }),
			boards: board({ findings: [] }),
			audit: AUDIT_ALL_PASS,
		});
		const text = `${model.compact.text}\n${model.expanded.text}`;
		for (const banned of ["contractLine", "contract-line", "worktree", "realign", "frozen", "frozenHash"]) {
			expect(text).not.toContain(banned);
		}
		expect(text.toLowerCase()).not.toContain("slice");
		expect(text).not.toContain("冻结");
	});

	it("keeps the S5 single-workspace wording without fork or join", () => {
		const model = dashboard({ mission: mission({ stage: "S5" }) });
		expect(model.compact.text).toContain("工作区 单一主工作区 · Reviewer 1 · Swarm board 1");
		expect(model.compact.text).toContain("工作区 0 · 主工作区未启动");
		const text = model.compact.text.toLowerCase();
		expect(text).not.toContain("worktree");
		expect(text).not.toContain("fork");
		expect(text).not.toContain("join");
	});
});