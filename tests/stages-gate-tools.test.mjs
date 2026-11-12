import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import * as contract from "../src/stages/contract.mjs";
import { createGateService, GATE_TOOL_NAMES, registerGateTools } from "../src/stages/gate-tools.mjs";
import { printEdn } from "../src/util/errors.mjs";

const ROOT = "/repo";
const SLUG = "mission";
const STAMP = "2026-01-01T00:00:00.000Z";

const S1_DOC = [
	"# S1",
	"## 一句话目标与用户可见结果",
	"一个只读的健康子命令。",
	"## 决策框架",
	"目标、备选、信息、价值与 VoI。",
	"## 现状事实与根因",
	"旧入口仍在清单中。",
	"## 单向门 / 双向门",
	"删除旧入口是单向门。",
	"## 事前验尸",
	"若失败，则旧入口继续被加载。",
	"## Non-Goals",
	"不实现独立标准版。",
	"## 成功标准",
	"用户能看到真实版本。",
	"## 未决问题",
	"无。",
].join("\n\n");

const S1_SUMMARY = "只读健康子命令；真实版本可见；不实现标准版。";

const CASES = [
	{
		case_id: "CASE-01",
		path: "正常",
		threshold: 90,
		steps: ["运行 omp", "检查输出"],
		expected: "输出包含版本号",
		rubric: "证据映射 0-100；恰好及格 90，差一档 85。",
	},
	{
		case_id: "CASE-02",
		path: "错误",
		threshold: 90,
		steps: ["输入非法参数"],
		expected: "返回明确错误",
		rubric: "错误分支可复现；硬失败为 0。",
	},
	{
		case_id: "CASE-03",
		path: "边界",
		threshold: 90,
		steps: ["输入边界值"],
		expected: "边界值被接受",
		rubric: "边界值可观察；无证据为 0。",
	},
	{
		case_id: "CASE-04",
		path: "并发",
		threshold: 90,
		steps: ["并发启动两个会话"],
		expected: "两者互不覆盖",
		rubric: "并发证据独立；丢失证据为 0。",
	},
	{
		case_id: "CASE-05",
		path: "恢复",
		threshold: 90,
		steps: ["提交后中断", "重启并恢复"],
		expected: "不出现半提交",
		rubric: "恢复后状态一致；半提交为 0。",
	},
];
const CASE_IDS = CASES.map((entry) => entry.case_id);

const S3_DOC = [
	"# S3 开发指南",
	"## 模块边界",
	"每个模块只隐藏一个变化点。",
	"## 依赖图",
	"`src/b.mjs` 依赖 `src/a.mjs`。",
	"## 失败隔离",
	"校验失败不保存。",
	"## CASE 对应表",
	"每个 CASE 有模块映射。",
].join("\n\n");

const S3_PAYLOAD_DOC = [
	"# S3 开发指南",
	"## 模块契约",
	"每个模块守住一个变化秘密。",
	"## 模块 DAG",
	"模块依赖单向，无环。",
	"## 用例到模块的映射",
	"结构性映射由 modules[].mapped_cases 承载。",
].join("\n\n");

const MODULES = [
	{
		path: "src/a.mjs",
		secret_owned: "变化点 A",
		depends_on: [],
		mapped_cases: ["CASE-01", "CASE-02", "CASE-03"],
	},
	{
		path: "src/b.mjs",
		secret_owned: "变化点 B",
		depends_on: ["src/a.mjs"],
		mapped_cases: ["CASE-04", "CASE-05"],
	},
];

const S4_DOC = [
	"# S4 协调手册",
	"## 文学化伪代码",
	"```text",
	"board_take_or_die(actor):",
	"  if token is free: actor becomes holder",
	"```",
	"## Safety",
	"至多一个 Holder。",
	"## Liveness",
	"无死锁，无睡死。",
	"## 拓扑合并顺序",
	"先 alpha 后 beta。",
].join("\n\n");

const S4_UPPER_DOC = S4_DOC.replace("## 拓扑合并顺序", "## 合并拓扑");

const SLICES = [
	{
		slice_id: "alpha",
		goal: "解析层",
		inputs: ["S1-S4 文档"],
		depends_on: [],
		done_when: "全部校验有回执",
		mapped_cases: ["CASE-01", "CASE-02", "CASE-03"],
	},
	{
		slice_id: "beta",
		goal: "集成层",
		inputs: "alpha 的接口",
		depends_on: ["alpha"],
		done_when: "端到端门禁可运行",
		mapped_cases: ["CASE-04", "CASE-05"],
	},
];

function sha256(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function clone(value) {
	return structuredClone(value);
}

async function makeHarness(overrides = {}) {
	const store = contract.createMemoryMissionStore();
	const documents = contract.createMemoryDocuments();
	const created = await contract.createMission(ROOT, { slug: SLUG, store, documents, now: () => STAMP });
	expect(created.ok).toBe(true);
	const calls = { confirm: [], stage: [], fork: [] };
	const host = {
		async confirm(args) {
			calls.confirm.push(args);
			return overrides.confirm ? overrides.confirm(args) : { decision: "approve" };
		},
		async resumeApproval(args) {
			calls.confirm.push(args);
			return { decision: "approve" };
		},
		async onStageChange(args) {
			calls.stage.push(args);
			return { ok: true };
		},
	};
	const runner = {
		async forkSlices(args) {
			calls.fork.push(args);
			return { ok: true, forked: args.slices.map((slice) => slice.slice_id) };
		},
		async assertInitialEmptyLedger() {
			return { ok: true };
		},
		async submitReview() {
			return { ok: true, phase: "join" };
		},
	};
	const deps = {
		contract,
		contractOptions: { store, documents },
		documents,
		host,
		runner,
		root: ROOT,
		base: "main",
		slugOf: () => SLUG,
		now: () => STAMP,
		...overrides.deps,
	};
	return {
		store,
		documents,
		calls,
		deps,
		service: createGateService(deps),
	};
}

async function missionOf(harness) {
	const read = await contract.readMission(ROOT, SLUG, {
		store: harness.store,
		documents: harness.documents,
	});
	expect(read.ok).toBe(true);
	return read.mission;
}

async function advanceToS2(harness, callId = "s1") {
	const result = await harness.service.advanceS1(
		{
			slug: SLUG,
			brainstorm_markdown: S1_DOC,
			summary: S1_SUMMARY,
			non_goals: ["不实现标准版"],
		},
		{ callId },
	);
	expect(result.ok).toBe(true);
	expect(result.missionStage).toBe("s2");
	return result;
}

async function advanceToS5(harness) {
	await advanceToS2(harness, "s1");
	const s2 = await harness.service.advanceS2(
		{ slug: SLUG, manual_tests_markdown: "# S2 方法论\n\nTesting != Checking.", cases: clone(CASES) },
		{ callId: "s2" },
	);
	expect(s2.ok).toBe(true);
	const s3 = await harness.service.advanceS3(
		{ slug: SLUG, dev_guide_markdown: S3_DOC, modules: clone(MODULES) },
		{ callId: "s3" },
	);
	expect(s3.ok).toBe(true);
	const s4 = await harness.service.advanceS4(
		{ slug: SLUG, coordination_markdown: S4_DOC, slices: clone(SLICES) },
		{ callId: "s4" },
	);
	expect(s4.ok).toBe(true);
	return s4;
}

describe("S1 summary freeze", () => {
	it("saves the exact summary bytes and freezes both s1 and s1-summary", async () => {
		const harness = await makeHarness();
		await advanceToS2(harness);
		const mission = await missionOf(harness);
		expect(mission.stage).toBe(":s2");
		expect(mission.frozen.s1.sha256).toBe(sha256(S1_DOC));
		expect(mission.frozen["s1-summary"].sha256).toBe(sha256(S1_SUMMARY));
		const summary = await harness.documents.readText(join(ROOT, `.herd/missions/${SLUG}/s1-summary.md`));
		expect(summary.ok).toBe(true);
		expect(summary.text).toBe(S1_SUMMARY);
	});

	it("freezes the latest human-edited S1 document but keeps the submitted summary bytes", async () => {
		const edited = `${S1_DOC}\n\n<!-- human edit -->\n`;
		const harness = await makeHarness({
			confirm: async ({ pending }) => {
				await harness.documents.writeText(join(ROOT, pending.path), edited);
				return { decision: "approve" };
			},
		});
		await advanceToS2(harness);
		const mission = await missionOf(harness);
		expect(mission.frozen.s1.sha256).toBe(sha256(edited));
		expect(mission.frozen.s1.sha256).not.toBe(sha256(S1_DOC));
		expect(mission.frozen["s1-summary"].sha256).toBe(sha256(S1_SUMMARY));
	});

	it("allows a revise round to replace the unfrozen summary and document before approval", async () => {
		let round = 0;
		const revisedSummary = "修订后的摘要：只读健康子命令，范围收窄。";
		const revisedDoc = `${S1_DOC}\n\n<!-- revised after human feedback -->\n`;
		const harness = await makeHarness({
			confirm: () => {
				round += 1;
				return round === 1 ? { decision: "revise", feedback: "narrow the scope" } : { decision: "approve" };
			},
		});
		const first = await harness.service.advanceS1(
			{
				slug: SLUG,
				brainstorm_markdown: S1_DOC,
				summary: S1_SUMMARY,
				non_goals: ["不实现标准版"],
			},
			{ callId: "s1-round-1" },
		);
		expect(first.ok).toBe(true);
		expect(first.status).toBe("revision-requested");
		expect((await missionOf(harness)).stage).toBe(":s1");

		const second = await harness.service.advanceS1(
			{
				slug: SLUG,
				brainstorm_markdown: revisedDoc,
				summary: revisedSummary,
				non_goals: ["不实现标准版"],
			},
			{ callId: "s1-round-2" },
		);
		expect(second.ok).toBe(true);
		expect(second.missionStage).toBe("s2");
		const mission = await missionOf(harness);
		expect(mission.frozen.s1.sha256).toBe(sha256(revisedDoc));
		expect(mission.frozen["s1-summary"].sha256).toBe(sha256(revisedSummary));
		const summary = await harness.documents.readText(join(ROOT, `.herd/missions/${SLUG}/s1-summary.md`));
		expect(summary.text).toBe(revisedSummary);
		const document = await harness.documents.readText(join(ROOT, `plans/${SLUG}/s1-brainstorm.md`));
		expect(document.text).toBe(revisedDoc);
	});
});

describe("S2 structured CASE commit", () => {
	it("commits cases.edn and the methodology document, then reads the same structured records", async () => {
		const harness = await makeHarness();
		await advanceToS2(harness);
		const result = await harness.service.advanceS2(
			{
				slug: SLUG,
				manual_tests_markdown: "# S2 方法论\n\nTesting != Checking.",
				cases: clone(CASES),
			},
			{ callId: "s2-roundtrip" },
		);
		expect(result.ok).toBe(true);
		expect(result.missionStage).toBe("s3");
		expect(result.caseIds).toEqual(CASE_IDS);

		const read = await contract.readS2Cases(ROOT, SLUG, {
			store: harness.store,
			documents: harness.documents,
		});
		expect(read.ok).toBe(true);
		expect(read.cases).toHaveLength(5);
		expect(read.cases[0]).toEqual({
			"case-id": "CASE-01",
			path: "正常",
			threshold: 90,
			steps: ["运行 omp", "检查输出"],
			expected: "输出包含版本号",
			rubric: "证据映射 0-100；恰好及格 90，差一档 85。",
		});
		expect(Array.isArray(read.cases[0].steps)).toBe(true);
		expect(read.caseIds).toEqual(CASE_IDS);
		const mission = await missionOf(harness);
		expect(mission.frozen["s2-cases"].sha256).toBe(read.sha256);
		expect(mission.stage).toBe(":s3");
	});

	it("ignores CASE text in the methodology markdown", async () => {
		const harness = await makeHarness();
		await advanceToS2(harness);
		const markdown = [
			"# S2 方法论",
			"### CASE-99",
			"- PASS threshold: 1/100",
			"- 路径：正常",
			"- 评分细则：伪 CASE",
		].join("\n\n");
		const result = await harness.service.advanceS2(
			{ slug: SLUG, manual_tests_markdown: markdown, cases: clone(CASES) },
			{ callId: "s2-fake-markdown" },
		);
		expect(result.ok).toBe(true);
		const read = await contract.readS2Cases(ROOT, SLUG, {
			store: harness.store,
			documents: harness.documents,
		});
		expect(read.caseIds).toEqual(CASE_IDS);
	});

	it("rejects a rubric_summary-shaped case and does not advance or write cases.edn", async () => {
		const harness = await makeHarness();
		await advanceToS2(harness);
		const bad = clone(CASES);
		bad[0].rubric_summary = "legacy";
		const result = await harness.service.advanceS2(
			{ slug: SLUG, manual_tests_markdown: "# S2", cases: bad },
			{ callId: "s2-bad" },
		);
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":INVALID_ARGUMENT");
		expect(result.error.data.errors[0].code).toBe("CASE_SCHEMA_INVALID");
		expect((await missionOf(harness)).stage).toBe(":s2");
		const read = await contract.readS2Cases(ROOT, SLUG, {
			store: harness.store,
			documents: harness.documents,
		});
		expect(read.ok).toBe(false);
	});

	it("rejects missing required path categories", async () => {
		const harness = await makeHarness();
		await advanceToS2(harness);
		const bad = clone(CASES).filter((entry) => entry.path !== "恢复");
		const result = await harness.service.advanceS2(
			{ slug: SLUG, manual_tests_markdown: "# S2", cases: bad },
			{ callId: "s2-path" },
		);
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":INVALID_ARGUMENT");
		expect(result.error.data.errors[0].code).toBe("CASE_REQUIRED_PATH_MISSING");
	});
});

describe("S3/S4 structured mapping", () => {
	it("persists full modules with mapped_cases and covers every frozen case", async () => {
		const harness = await makeHarness();
		await advanceToS2(harness);
		await harness.service.advanceS2(
			{ slug: SLUG, manual_tests_markdown: "# S2", cases: clone(CASES) },
			{ callId: "s2" },
		);
		const result = await harness.service.advanceS3(
			{ slug: SLUG, dev_guide_markdown: S3_DOC, modules: clone(MODULES) },
			{ callId: "s3" },
		);
		expect(result.ok).toBe(true);
		expect(result.missionStage).toBe("s4");
		const mission = await missionOf(harness);
		expect(mission["s3-modules"]).toHaveLength(2);
		expect(mission["s3-modules"].map((module) => module.path)).toEqual(["src/a.mjs", "src/b.mjs"]);
		const prefix = await contract.verifyFrozenPrefix(ROOT, SLUG, {
			store: harness.store,
			documents: harness.documents,
			keys: ["s3-modules"],
		});
		expect(prefix.ok).toBe(true);
	});

	it("accepts 模块 DAG without requiring a CASE mapping Markdown heading", async () => {
		const harness = await makeHarness();
		await advanceToS2(harness);
		await harness.service.advanceS2(
			{ slug: SLUG, manual_tests_markdown: "# S2", cases: clone(CASES) },
			{ callId: "s2" },
		);
		const result = await harness.service.advanceS3(
			{ slug: SLUG, dev_guide_markdown: S3_PAYLOAD_DOC, modules: clone(MODULES) },
			{ callId: "s3-payload" },
		);
		expect(result.ok).toBe(true);
		expect(result.missionStage).toBe("s4");
	});

	it("rejects unknown and uncovered module mapped_cases", async () => {
		const harness = await makeHarness();
		await advanceToS2(harness);
		await harness.service.advanceS2(
			{ slug: SLUG, manual_tests_markdown: "# S2", cases: clone(CASES) },
			{ callId: "s2" },
		);
		const unknown = clone(MODULES);
		unknown[0].mapped_cases.push("CASE-99");
		const unknownResult = await harness.service.advanceS3(
			{ slug: SLUG, dev_guide_markdown: S3_DOC, modules: unknown },
			{ callId: "s3-unknown" },
		);
		expect(unknownResult.error.code).toBe(":INVALID_ARGUMENT");
		expect(unknownResult.error.data.errors[0].code).toBe("MAPPED_CASE_UNKNOWN");

		const missing = clone(MODULES);
		missing[1].mapped_cases = ["CASE-04"];
		const missingResult = await harness.service.advanceS3(
			{ slug: SLUG, dev_guide_markdown: S3_DOC, modules: missing },
			{ callId: "s3-missing" },
		);
		expect(missingResult.error.code).toBe(":INVALID_ARGUMENT");
		expect(missingResult.error.data.errors[0].code).toBe("MAPPED_CASE_MISSING");
		expect((await missionOf(harness)).stage).toBe(":s3");
	});

	it("persists s4-slices, covers every frozen case, and freezes S5", async () => {
		const harness = await makeHarness();
		const result = await advanceToS5(harness);
		expect(result.missionStage).toBe("s5");
		const mission = await missionOf(harness);
		expect(mission.stage).toBe(":s5");
		expect(mission["s4-slices"]).toHaveLength(2);
		const slices = await contract.readS4Slices(ROOT, SLUG, {
			store: harness.store,
			documents: harness.documents,
		});
		expect(slices.ok).toBe(true);
		expect(slices.slices).toEqual(
			SLICES.map((slice) => ({
				"slice-id": slice.slice_id,
				goal: slice.goal,
				inputs: slice.inputs,
				"depends-on": slice.depends_on,
				"done-when": slice.done_when,
				"mapped-cases": slice.mapped_cases,
			})),
		);
		expect(mission["contract-line"]).toContain("Verification contract: MANUAL ACCEPTANCE");
		expect(mission["contract-line"]).toContain("s1-summary:");
		expect(mission["contract-line"]).toContain("s2-cases:");
		expect(mission["contract-line"]).toContain("s3-modules: inline sha256=");
	});

	it("rejects uncovered S4 mapped_cases", async () => {
		const harness = await makeHarness();
		await advanceToS2(harness);
		await harness.service.advanceS2(
			{ slug: SLUG, manual_tests_markdown: "# S2", cases: clone(CASES) },
			{ callId: "s2" },
		);
		await harness.service.advanceS3(
			{ slug: SLUG, dev_guide_markdown: S3_DOC, modules: clone(MODULES) },
			{ callId: "s3" },
		);
		const slices = clone(SLICES);
		slices[1].mapped_cases = ["CASE-04"];
		const result = await harness.service.advanceS4(
			{ slug: SLUG, coordination_markdown: S4_DOC, slices },
			{ callId: "s4-missing" },
		);
		expect(result.error.code).toBe(":INVALID_ARGUMENT");
		expect(result.error.data.errors[0].code).toBe("MAPPED_CASE_MISSING");
		expect((await missionOf(harness)).stage).toBe(":s4");
	});

	it("accepts uppercase slice ids and 合并拓扑 on the real S4 path", async () => {
		const harness = await makeHarness();
		await advanceToS2(harness);
		await harness.service.advanceS2(
			{ slug: SLUG, manual_tests_markdown: "# S2", cases: clone(CASES) },
			{ callId: "s2" },
		);
		await harness.service.advanceS3(
			{ slug: SLUG, dev_guide_markdown: S3_DOC, modules: clone(MODULES) },
			{ callId: "s3" },
		);
		const slices = clone(SLICES).map((slice) => ({
			...slice,
			slice_id: slice.slice_id.toUpperCase(),
			depends_on: slice.depends_on.map((dependency) => dependency.toUpperCase()),
		}));
		const result = await harness.service.advanceS4(
			{ slug: SLUG, coordination_markdown: S4_UPPER_DOC, slices },
			{ callId: "s4-upper" },
		);
		expect(result.ok).toBe(true);
		expect(result.missionStage).toBe("s5");
		expect((await missionOf(harness)).stage).toBe(":s5");
	});
});

describe("realign controls", () => {
	it("realigns only the S1 document and leaves the frozen summary unchanged", async () => {
		const harness = await makeHarness();
		await advanceToS5(harness);
		const before = await missionOf(harness);
		const edited = `${S1_DOC}\n\n<!-- later human edit -->\n`;
		await harness.documents.writeText(join(ROOT, `plans/${SLUG}/s1-brainstorm.md`), edited);
		const result = await harness.service.realign({ slug: SLUG, target: "s1" }, { callId: "realign-s1" });
		expect(result.ok).toBe(true);
		expect(result.status).toBe("realigned");
		const after = await missionOf(harness);
		expect(after.frozen.s1.sha256).toBe(sha256(edited));
		expect(after.frozen["s1-summary"].sha256).toBe(before.frozen["s1-summary"].sha256);
		expect(after.revision).toBe(before.revision + 1);
	});

	it("realigns s2-cases with a strict record and updates the frozen CASE hash", async () => {
		const harness = await makeHarness();
		await advanceToS5(harness);
		const changed = clone(CASES);
		changed[0] = { ...changed[0], threshold: 95 };
		const externalBytes = `${printEdn(
			changed.map((entry) => ({
				"case-id": entry.case_id,
				path: entry.path,
				threshold: entry.threshold,
				steps: entry.steps,
				expected: entry.expected,
				rubric: entry.rubric,
			})),
		)}\n`;
		await harness.documents.writeText(join(ROOT, `.herd/missions/${SLUG}/cases.edn`), externalBytes);
		const result = await harness.service.realign({ slug: SLUG, target: "s2-cases" }, { callId: "realign-cases" });
		expect(result.ok).toBe(true);
		const read = await contract.readS2Cases(ROOT, SLUG, {
			store: harness.store,
			documents: harness.documents,
		});
		expect(read.ok).toBe(true);
		expect(read.cases[0].threshold).toBe(95);
		expect(Array.isArray(read.cases[0].steps)).toBe(true);
		expect((await missionOf(harness)).frozen["s2-cases"].sha256).toBe(read.sha256);
	});
});

describe("registerGateTools", () => {
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

	it("registers the structured CASE/module/slice schemas and keeps stage slugs explicit", () => {
		const harness = { deps: {} };
		const pi = fakePi();
		// The schema is built before contract calls, so a contract stub is enough here.
		harness.deps = {
			contract: {
				readMission() {},
				saveStageDocument() {},
				freezeStage() {},
				readPendingGate() {},
				writePendingGate() {},
			},
			root: ROOT,
		};
		registerGateTools(pi, harness.deps);
		expect([...pi.tools.keys()].sort()).toEqual([...GATE_TOOL_NAMES].sort());
		expect(pi.tools.get("advance_s1").parameters.properties.slug).toBeDefined();
		const caseProperties = pi.tools.get("advance_s2").parameters.properties.cases.items.properties;
		expect(caseProperties.case_id).toBeDefined();
		expect(caseProperties.steps).toBeDefined();
		expect(caseProperties.expected).toBeDefined();
		expect(caseProperties.rubric).toBeDefined();
		expect(caseProperties.rubric_summary).toBeUndefined();
		expect(pi.tools.get("advance_s3").parameters.properties.modules.items.properties.mapped_cases).toBeDefined();
	});

	it("renders the exact missing path set and correction in the advance_s2 receipt", async () => {
		const harness = await makeHarness();
		await advanceToS2(harness);
		const pi = fakePi();
		registerGateTools(pi, harness.deps);
		const cases = clone(CASES).map((entry) => ({ ...entry, path: "/repo/README.md" }));
		const result = await pi.tools
			.get("advance_s2")
			.execute("s2-path-receipt", { slug: SLUG, manual_tests_markdown: "# S2", cases }, undefined, undefined, {
				cwd: ROOT,
			});
		expect(result.isError).toBe(true);
		const text = result.content[0].text;
		expect(text).toContain("CASE_REQUIRED_PATH_MISSING");
		for (const category of ["正常", "错误", "边界", "并发", "恢复"]) {
			expect(text).toContain(category);
		}
		expect(text).toContain("received");
		expect(text).toContain("filesystem path");
	});
});
