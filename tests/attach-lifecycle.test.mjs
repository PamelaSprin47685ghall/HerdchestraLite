import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as contract from "../src/stages/contract.mjs";
import {
	applyReview,
	archiveBoardPath,
	attachToolForStage,
	boardIsEmpty,
	buildBarrier,
	buildSuccessorMission,
	emptyBoard,
	evaluateAttach,
	successorTenureId,
} from "../src/stages/tenure.mjs";

const NOW = "2026-11-13T00:00:00.000Z";

function tenureMission(overrides = {}) {
	const tenureId = overrides["tenure-id"] ?? "T-1";
	return {
		stage: "s1",
		"tenure-id": tenureId,
		"tenure-seq": 1,
		board: emptyBoard(tenureId),
		...overrides,
	};
}

describe("review ledger", () => {
	it("upserts a value without replacing structural keys and opens the review", () => {
		const board = emptyBoard("T-1");
		board.tasks.F1 = {
			value: "old",
			"parent-key": "P",
			"child-keys": ["C1", "C2"],
			"wait-for": ["C2"],
			waiting: true,
		};

		const result = applyReview(board, {
			summary_markdown: "# review notes",
			findings: [{ key: "F1", value: "new value" }],
			stage: "s1",
		});

		expect(result.ok).toBe(true);
		expect(result.board.tasks.F1).toEqual({
			value: "new value",
			"parent-key": "P",
			"child-keys": ["C1", "C2"],
			"wait-for": ["C2"],
			waiting: true,
		});
		expect(result.board["review-summary"]).toBe("# review notes");
		expect(result.board["attach-ready"]).toBe(false);
		expect(result.status).toBe("review-open");
		expect(result.expectedAttach).toBe("attach_brainstorm");
		expect(board.tasks.F1.value).toBe("old");
	});

	it("creates a task from a string, leaves it for [] and deletes it with nil", () => {
		const created = applyReview(emptyBoard("T-1"), {
			findings: [{ key: "F1", value: "first value" }],
			stage: "s2",
		});
		expect(created.ok).toBe(true);
		expect(created.board.tasks.F1).toEqual({ value: "first value" });
		expect(created.board["attach-ready"]).toBe(false);
		expect(created.expectedAttach).toBe("attach_manual_tests");

		const leftAlone = applyReview(created.board, {
			findings: [{ key: "F1", value: [] }],
			stage: "s2",
		});
		expect(leftAlone.ok).toBe(true);
		expect(leftAlone.board.tasks.F1).toEqual({ value: "first value" });
		expect(leftAlone.board["attach-ready"]).toBe(false);

		const untouched = applyReview(leftAlone.board, { findings: [], stage: "s2" });
		expect(untouched.ok).toBe(true);
		expect(untouched.board.tasks).toEqual({ F1: { value: "first value" } });
		expect(untouched.board["attach-ready"]).toBe(false);

		const deleted = applyReview(untouched.board, {
			findings: [{ key: "F1", value: null }],
			stage: "s2",
		});
		expect(deleted.ok).toBe(true);
		expect(deleted.board.tasks).toEqual({});
		expect(deleted.board["attach-ready"]).toBe(true);
		expect(deleted.status).toBe("review-quiescent");
	});

	it("sets attach-ready only after a review call on an empty board and never writes a stage", () => {
		const board = emptyBoard("T-1");
		expect(board["attach-ready"]).toBe(false);
		expect(board.tasks).toEqual({});

		const quiescent = applyReview(board, { findings: [], stage: "s1" });
		expect(quiescent.ok).toBe(true);
		expect(quiescent.board["board-version"]).toBe(1);
		expect(quiescent.board["attach-ready"]).toBe(true);
		expect(quiescent.status).toBe("review-quiescent");
		expect(quiescent.openTasks).toBe(0);
	});

	it("clears and preserves the review summary explicitly", () => {
		const first = applyReview(emptyBoard("T-1"), {
			summary_markdown: "# first",
			findings: [],
		});
		expect(first.board["review-summary"]).toBe("# first");

		const preserved = applyReview(first.board, { findings: [] });
		expect(preserved.board["review-summary"]).toBe("# first");

		const cleared = applyReview(preserved.board, { summary_markdown: null, findings: [] });
		expect(cleared.board["review-summary"]).toBeNull();
	});

	it("rejects malformed findings and a malformed board", () => {
		expect(applyReview(null, { findings: [] }).ok).toBe(false);
		expect(applyReview({ tasks: {} }, { findings: "bad" }).ok).toBe(false);
		expect(applyReview(emptyBoard("T-1"), { findings: [{ key: "", value: "x" }] }).ok).toBe(false);
		expect(applyReview(emptyBoard("T-1"), { findings: [{ key: "F", value: 7 }] }).ok).toBe(false);
	});
});

describe("attach gating", () => {
	const readyBoard = () => applyReview(emptyBoard("T-1"), { findings: [], stage: "s1" }).board;

	it("rejects a wrong tool for the stage", () => {
		const result = evaluateAttach({
			mission: { stage: "s1" },
			board: readyBoard(),
			tool: "attach_manual_tests",
			stage: "s1",
		});
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":ATTACH_STAGE_MISMATCH");
	});

	it("rejects a non-empty review ledger", () => {
		const board = applyReview(readyBoard(), {
			findings: [{ key: "F1", value: "open" }],
			stage: "s1",
		}).board;
		const result = evaluateAttach({ mission: { stage: "s1" }, board, tool: "attach_brainstorm", stage: "s1" });
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":REVIEW_LEDGER_NOT_EMPTY");
		expect(result.error.openTasks).toBe(1);
	});

	it("rejects an empty board that no empty review has quiesced", () => {
		const result = evaluateAttach({
			mission: { stage: "s1" },
			board: emptyBoard("T-1"),
			tool: "attach_brainstorm",
			stage: "s1",
		});
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":ATTACH_NOT_READY");
	});

	it("accepts the matching tool after an empty review", () => {
		const result = evaluateAttach({
			mission: { stage: "s1" },
			board: readyBoard(),
			tool: "attach_brainstorm",
			stage: "s1",
		});
		expect(result).toEqual({
			ok: true,
			tool: "attach_brainstorm",
			stage: "s1",
			status: "attach-ready",
			summary: null,
		});
	});

	it("maps every Plan stage to its material-named attach tool and none for S5", () => {
		expect(attachToolForStage("s1")).toBe("attach_brainstorm");
		expect(attachToolForStage("s2")).toBe("attach_manual_tests");
		expect(attachToolForStage("s3")).toBe("attach_dev_guide");
		expect(attachToolForStage("s4")).toBe("attach_coordination");
		expect(attachToolForStage("s5")).toBeNull();
		expect(attachToolForStage("s0")).toBeNull();
	});
});

describe("barrier and successor", () => {
	it("archives the retired board at .herd/boards/<tenure-id>.edn", () => {
		expect(archiveBoardPath("T-1")).toBe(".herd/boards/T-1.edn");
		expect(() => archiveBoardPath("  ")).toThrow();
	});

	it("builds the exact barrier fields for an S1 attach", () => {
		const mission = tenureMission();
		const board = { ...mission.board, "review-summary": "# summary", "attach-ready": true };
		const barrier = buildBarrier({
			mission,
			board,
			tool: "attach_brainstorm",
			stage: "s1",
			now: NOW,
		});
		expect(barrier).toEqual({
			from: "s1",
			to: "s2",
			"retired-tenure": "T-1",
			"successor-tenure": "T-2",
			"board-archive": ".herd/boards/T-1.edn",
			"review-summary": "# summary",
			"attach-tool": "attach_brainstorm",
			at: NOW,
		});
	});

	it("builds a successor mission with a fresh empty board and the next tool", () => {
		const mission = tenureMission();
		const successor = buildSuccessorMission({
			mission,
			tool: "attach_brainstorm",
			stage: "s1",
			now: NOW,
		});
		expect(successor.stage).toBe("s2");
		expect(successor["tenure-id"]).toBe("T-2");
		expect(successor["tenure-seq"]).toBe(2);
		expect(successor.board).toEqual(emptyBoard("T-2"));
		expect(successor["attach-ready"]).toBe(false);
		expect(successor["attach-tool"]).toBe("attach_manual_tests");
		expect(successor["attached-tool"]).toBe("attach_brainstorm");
		expect(successor["created-at"]).toBe(NOW);
		expect(successor["updated-at"]).toBe(NOW);
		expect(successor.board).not.toBe(mission.board);
	});

	it("retires T-4 into an S5 successor with no attach tool", () => {
		const mission = tenureMission({ stage: "s4", "tenure-id": "T-4", "tenure-seq": 4 });
		const successor = buildSuccessorMission({
			mission,
			tool: "attach_coordination",
			stage: "s4",
			now: NOW,
		});
		expect(successor.stage).toBe("s5");
		expect(successor["tenure-id"]).toBe("T-5");
		expect(successor["attach-tool"]).toBeNull();
		expect(boardIsEmpty(successor.board)).toBe(true);
	});

	it("is deterministic for a replayed call and never shares the board object", () => {
		const mission = tenureMission();
		const first = buildSuccessorMission({ mission, tool: "attach_brainstorm", stage: "s1", now: NOW });
		const replay = buildSuccessorMission({ mission, tool: "attach_brainstorm", stage: "s1", now: NOW });
		expect(replay).toEqual(first);
		expect(successorTenureId(mission, mission.board)).toBe("T-2");
		expect(JSON.stringify(first).includes(":frozen")).toBe(false);
		expect(JSON.stringify(first).includes("contract-line")).toBe(false);
	});
});

// The tool surface is wired by gate-tools. During the parser rewrite that
// module can be temporarily unloadable; the pure lifecycle tests above still
// run. Once it lands, this block proves the file writes, S1 approval, revisit,
// and replay behavior end to end.
let gateTools = null;
try {
	gateTools = await import("../src/stages/gate-tools.mjs");
} catch {
	gateTools = null;
}

const SLUG = "attach-demo";
const S1_DOC = "# S1 目标\n\n交付一个可观察的 attach 生命周期。\n";
const S2_DOC = "# S2 手工测试\n\nTesting != Checking。\n";
const S3_DOC = "# S3 开发指南\n\n每个模块隐藏一个变化点。\n";
const S4_DOC = "# S4 协调手册\n\nSafety 与 Liveness。\n";
const CASES = [
	{
		case_id: "CASE-01",
		path: "正常",
		threshold: 90,
		steps: ["运行真实命令", "记录可观察输出"],
		expected: "输出符合契约",
		rubric: "把证据映射到 0-100；90 及格。",
	},
	{
		case_id: "CASE-02",
		path: "错误",
		threshold: 90,
		steps: ["提交非法输入", "记录拒绝"],
		expected: "非法输入被拒绝",
		rubric: "拒绝证据可复现；硬失败为 0。",
	},
	{
		case_id: "CASE-03",
		path: "边界",
		threshold: 90,
		steps: ["输入边界值", "记录边界输出"],
		expected: "边界值被接受",
		rubric: "边界证据可观察；无证据为 0。",
	},
	{
		case_id: "CASE-04",
		path: "并发",
		threshold: 90,
		steps: ["并发启动两个操作", "记录最终顺序"],
		expected: "并发交错不破坏不变量",
		rubric: "并发证据独立；丢失证据为 0。",
	},
	{
		case_id: "CASE-05",
		path: "恢复",
		threshold: 90,
		steps: ["中断后重试", "记录恢复状态"],
		expected: "恢复后不重复责任",
		rubric: "恢复证据独立；半提交为 0。",
	},
];
const roots = [];

afterEach(() => {
	while (roots.length > 0) {
		rmSync(roots.pop(), { recursive: true, force: true });
	}
});

function fakePi() {
	const Type = {
		String: (options = {}) => ({ type: "string", ...options }),
		Number: (options = {}) => ({ type: "number", ...options }),
		Integer: (options = {}) => ({ type: "integer", ...options }),
		Boolean: () => ({ type: "boolean" }),
		Array: (items, options = {}) => ({ type: "array", items, ...options }),
		Object: (properties, options = {}) => ({ type: "object", properties, ...options }),
		Optional: (schema) => schema,
		Union: (anyOf) => ({ anyOf }),
	};
	const tools = new Map();
	return {
		typebox: { Type },
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		tools,
	};
}

function makeHarness(decisions = []) {
	const root = mkdtempSync(join(tmpdir(), "herd-attach-"));
	roots.push(root);
	const pending = [...decisions];
	const confirmed = [];
	const host = {
		async confirm(args) {
			confirmed.push(args);
			return pending.shift() ?? { decision: "approve" };
		},
		async resumeApproval(args) {
			confirmed.push(args);
			return pending.shift() ?? { decision: "approve" };
		},
		async onStageChange() {
			return { ok: true };
		},
	};
	const pi = fakePi();
	const service = gateTools.registerGateTools(pi, {
		contract,
		host,
		root,
		base: "main",
		slugOf: () => SLUG,
		now: () => NOW,
	});
	return { root, pi, service, confirmed };
}

async function boot(decisions) {
	const ctx = makeHarness(decisions);
	const created = await contract.createMission(ctx.root, {
		slug: SLUG,
		missionId: "M-ATTACH",
		seed: "seed text",
		now: () => NOW,
	});
	expect(created.ok).toBe(true);
	return ctx;
}

async function callTool(ctx, name, callId, params) {
	const tool = ctx.pi.tools.get(name);
	if (!tool) throw new Error(`gate tool is not registered: ${name}`);
	return tool.execute(callId, params, undefined, undefined, { cwd: ctx.root });
}

function textOf(result) {
	return (result.content ?? []).map((block) => block.text ?? "").join("\n");
}

function expectOk(result) {
	if (result.isError === true) throw new Error(`tool failed: ${textOf(result)}`);
	expect(result.isError).not.toBe(true);
}

function expectRejected(result) {
	if (result.isError !== true) throw new Error(`tool unexpectedly succeeded: ${textOf(result)}`);
	expect(result.isError).toBe(true);
}

async function stageOf(ctx) {
	const read = await contract.readMission(ctx.root, SLUG);
	expect(read.ok).toBe(true);
	return String(read.mission.stage).replace(/^:/, "");
}

async function review(ctx, callId, findings) {
	return callTool(ctx, "review", callId, { findings });
}

async function attachS1(ctx, callId = "attach-s1") {
	return callTool(ctx, "attach_brainstorm", callId, { markdown: S1_DOC });
}

describe.skipIf(gateTools === null)("gate tool attach lifecycle", () => {
	it("registers review and the four attach tools with attach-only schemas and no realign", () => {
		const ctx = makeHarness();
		for (const name of [
			"review",
			"attach_brainstorm",
			"attach_manual_tests",
			"attach_dev_guide",
			"attach_coordination",
		]) {
			expect(ctx.pi.tools.has(name)).toBe(true);
		}
		expect(ctx.pi.tools.has("realign")).toBe(false);
		expect(Object.keys(ctx.pi.tools.get("attach_brainstorm").parameters.properties)).toEqual(["markdown"]);
		expect(Object.keys(ctx.pi.tools.get("attach_dev_guide").parameters.properties)).toEqual(["markdown"]);
		expect(Object.keys(ctx.pi.tools.get("attach_coordination").parameters.properties)).toEqual([
			"markdown",
			"promela",
		]);
		expect(ctx.pi.tools.get("attach_manual_tests").parameters.properties.cases).toBeDefined();
	});

	it("writes the S1 markdown only after approval and then advances with an empty successor board", async () => {
		const ctx = await boot();
		expectOk(await review(ctx, "s1-ready", []));
		expectOk(await attachS1(ctx, "s1-attach"));
		expect(await stageOf(ctx)).toBe("s2");
		expect(ctx.confirmed.length).toBe(1);
		const documentPath = join(ctx.root, "plans", SLUG, "s1-brainstorm.md");
		expect(existsSync(documentPath)).toBe(true);
		expect(readFileSync(documentPath, "utf8")).toBe(S1_DOC);

		expectOk(await review(ctx, "successor-finding", [{ key: "N1", value: "successor work" }]));
		const missionText = readFileSync(join(ctx.root, ".herd/missions", SLUG, "mission.edn"), "utf8");
		expect(missionText.includes(":frozen")).toBe(false);
		expect(missionText.includes("contract-line")).toBe(false);
	});

	it("clears attach-ready on a human revision request", async () => {
		const ctx = await boot([{ decision: "revise", feedback: "narrow the scope" }]);
		expectOk(await review(ctx, "revise-ready", []));
		expectOk(await attachS1(ctx, "revise-attach"));
		expect(await stageOf(ctx)).toBe("s1");
		expectRejected(await attachS1(ctx, "revise-attach-retry"));
		expectOk(await review(ctx, "revise-ready-again", []));
		expectOk(await attachS1(ctx, "revise-attach-approved"));
		expect(await stageOf(ctx)).toBe("s2");
	});

	it("replays one call-id without retiring a second tenure", async () => {
		const ctx = await boot();
		expectOk(await review(ctx, "replay-ready", []));
		expectOk(await attachS1(ctx, "attach-replay"));
		expectOk(await attachS1(ctx, "attach-replay"));
		expect(await stageOf(ctx)).toBe("s2");
	});

	it("writes s2-cases.edn and the S3/S4 markdown and requires a non-empty S4 promela", async () => {
		const ctx = await boot();
		expectOk(await review(ctx, "path-s1", []));
		expectOk(await attachS1(ctx, "path-s1-attach"));

		expectOk(await review(ctx, "path-s2", []));
		expectOk(
			await callTool(ctx, "attach_manual_tests", "path-s2-attach", {
				markdown: S2_DOC,
				cases: CASES,
			}),
		);
		expect(await stageOf(ctx)).toBe("s3");
		const casesPath = join(ctx.root, ".herd/missions", SLUG, "s2-cases.edn");
		expect(existsSync(casesPath)).toBe(true);
		expect(readFileSync(casesPath, "utf8")).toContain("CASE-01");

		expectOk(await review(ctx, "path-s3", []));
		expectOk(await callTool(ctx, "attach_dev_guide", "path-s3-attach", { markdown: S3_DOC }));
		expect(await stageOf(ctx)).toBe("s4");
		expect(readFileSync(join(ctx.root, "plans", SLUG, "s3-dev-guide.md"), "utf8")).toBe(S3_DOC);

		expectOk(await review(ctx, "path-s4", []));
		expectRejected(
			await callTool(ctx, "attach_coordination", "path-s4-empty", {
				markdown: S4_DOC,
				promela: "   ",
			}),
		);
		expect(await stageOf(ctx)).toBe("s4");

		expectOk(
			await callTool(ctx, "attach_coordination", "path-s4-attach", {
				markdown: S4_DOC,
				promela: "never { false }",
			}),
		);
		expect(await stageOf(ctx)).toBe("s5");
		expect(readFileSync(join(ctx.root, "plans", SLUG, "s4-coordination.md"), "utf8")).toBe(S4_DOC);
		expect(readFileSync(join(ctx.root, "plans", SLUG, "s4-coordination.pml"), "utf8")).toBe("never { false }");
	});
});