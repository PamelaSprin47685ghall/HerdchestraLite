import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as contractModule from "../src/stages/contract.mjs";
import {
	__test,
	beginRework,
	buildContractLine,
	CONTRACT_PREFIX,
	CONTRACT_SUFFIX,
	commitS2,
	createMemoryDocuments,
	createMemoryMissionStore,
	createMission,
	FROZEN_KEYS,
	freezeStage,
	listMissions,
	normalizeStage,
	parseContractLine,
	readMission,
	readPendingGate,
	readS1Summary,
	readS2Cases,
	readS4Slices,
	realign,
	STAGE_IDS,
	saveS1Summary,
	saveS2Cases,
	saveStageDocument,
	stageDocumentPath,
	takeApprovalAuthority,
	validateMission,
	verifyApproval,
	verifyContract,
	verifyFrozenPrefix,
	writePendingGate,
} from "../src/stages/contract.mjs";
import { printEdn } from "../src/util/errors.mjs";

const ROOT = "/virtual/herd";
const NOW = "2026-11-11T00:00:00.000Z";
const approvalAuthority = takeApprovalAuthority();
if (!approvalAuthority) throw new Error("the approval authority must be available to this test file");

const S1_DOC = "# S1 头脑风暴\n\n## 一句话目标与用户可见结果\n\n用户能看到真实结果。\n";
const S2_DOC = [
	"# S2 手工测试",
	"",
	"## CASE 清单",
	"",
	"### CASE-01",
	"- PASS threshold: 90/100",
	"- 路径：正常",
	"- 评分细则：观察真实输出，把证据映射到 0-100。",
	"",
].join("\n");
const S3_DOC = [
	"# S3 开发指南",
	"",
	"## 模块边界",
	"",
	"模块 `src/a.mjs` 隐藏实现。",
	"",
	"## 依赖图",
	"",
	"无环。",
	"",
	"## 失败隔离",
	"",
	"失败即拒绝。",
	"",
	"## CASE 对应表",
	"",
	"CASE-01。",
	"",
].join("\n");
const S4_DOC = [
	"# S4 协调手册",
	"",
	"## 伪代码",
	"",
	"按序。",
	"",
	"## Safety",
	"",
	"互斥。",
	"",
	"## Liveness",
	"",
	"可收束。",
	"",
	"## 合并顺序",
	"",
	"拓扑。",
	"",
	"## 切片",
	"",
	"slice_id: alpha",
	"",
].join("\n");

const roots = [];

function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function printEdnCases(cases) {
	return printEdn(cases, { indent: " " });
}

function absolute(relative) {
	return join(ROOT, relative);
}

function harness() {
	const store = createMemoryMissionStore();
	const documents = createMemoryDocuments();
	const ports = { store, documents, now: () => NOW };
	return { root: ROOT, store, documents, ports };
}

async function create(h, options = {}) {
	const created = await createMission(h.root, {
		slug: "demo",
		missionId: "M-1",
		seed: "seed",
		...h.ports,
		...options,
	});
	if (created.ok) {
		await saveS1Summary(h.root, "demo", "已批准摘要", h.ports);
		await saveS2Cases(h.root, "demo", CASES, h.ports);
		await h.store.transaction(async (current) => ({
			mission: {
				...structuredClone(current),
				"s3-modules": structuredClone(MODULES),
				"s4-slices": structuredClone(SLICES),
			},
			response: null,
			commit: true,
		}));
	}
	return created;
}

async function missionOf(h) {
	const read = await readMission(h.root, "demo", h.ports);
	expect(read.ok).toBe(true);
	return read.mission;
}

async function mutateMission(h, transform) {
	await h.store.transaction(async (current) => ({
		mission: transform(structuredClone(current)),
		response: null,
		commit: true,
	}));
}

const CASES = [
	{
		"case-id": "CASE-01",
		threshold: 90,
		path: "正常",
		steps: ["执行真实命令。", "记录可观察输出。"],
		expected: "输出符合契约。",
		rubric: "把可观察证据映射到 0-100；90 及格，85 差一档。",
	},
	{
		"case-id": "CASE-02",
		threshold: 90,
		path: "错误",
		steps: ["提交非法输入。", "记录拒绝码。"],
		expected: "非法输入被拒绝且状态不变。",
		rubric: "把拒绝证据映射到 0-100；90 及格，85 差一档。",
	},
	{
		"case-id": "CASE-03",
		threshold: 90,
		path: "边界",
		steps: ["执行边界样本。", "记录边界输出。"],
		expected: "边界输出符合契约。",
		rubric: "把边界证据映射到 0-100；90 及格，85 差一档。",
	},
	{
		"case-id": "CASE-04",
		threshold: 90,
		path: "并发",
		steps: ["并发触发两个操作。", "记录最终顺序与状态。"],
		expected: "并发交错不破坏不变量。",
		rubric: "把交错证据映射到 0-100；90 及格，85 差一档。",
	},
	{
		"case-id": "CASE-05",
		threshold: 90,
		path: "恢复",
		steps: ["中断后重试。", "记录恢复状态。"],
		expected: "恢复后不重复或丢失责任。",
		rubric: "把恢复证据映射到 0-100；90 及格，85 差一档。",
	},
];
const CASE_IDS = CASES.map((entry) => entry["case-id"]);
const MODULES = [{ path: "src/a.mjs", "secret-owned": "实现", "depends-on": [], "mapped-cases": [...CASE_IDS] }];
const SLICES = [
	{
		"slice-id": "alpha",
		goal: "全部路径",
		inputs: [...CASE_IDS],
		"depends-on": [],
		"done-when": "通过",
		"mapped-cases": [...CASE_IDS],
	},
];

async function freezeAll(h, { s1 = S1_DOC } = {}) {
	expect((await create(h)).ok).toBe(true);
	expect((await saveStageDocument(h.root, "demo", "s1", S1_DOC, h.ports)).ok).toBe(true);
	expect((await saveS1Summary(h.root, "demo", "已批准摘要", h.ports)).ok).toBe(true);
	h.documents.files.set(absolute("plans/demo/s1-brainstorm.md"), s1);
	expect((await writePendingGate(h.root, "demo", { stage: "s1", "call-id": "s1-wait" }, h.ports)).ok).toBe(true);
	const first = await freezeStage(h.root, "demo", "s1", undefined, { ...h.ports, callId: "freeze-s1" });
	expect(first.ok).toBe(true);
	expect((await saveS2Cases(h.root, "demo", CASES, h.ports)).ok).toBe(true);
	const second = await freezeStage(h.root, "demo", "s2", S2_DOC, {
		...h.ports,
		callId: "freeze-s2",
		structure: { cases: [{ case_id: "CASE-01" }] },
	});
	expect(second.ok).toBe(true);
	const third = await freezeStage(h.root, "demo", "s3", S3_DOC, {
		...h.ports,
		callId: "freeze-s3",
		modules: MODULES,
		structure: { modules: [{ path: "src/a.mjs" }] },
	});
	expect(third.ok).toBe(true);
	const fourth = await freezeStage(h.root, "demo", "s4", S4_DOC, {
		...h.ports,
		callId: "freeze-s4",
		slices: SLICES,
		structure: { slices: [{ slice_id: "alpha" }] },
	});
	expect(fourth.ok).toBe(true);
	return [first, second, third, fourth];
}

async function reportHash(h, text = "# S5 报告\n\n全部 CASE 通过。\n") {
	await h.documents.writeText(absolute("plans/demo/s5-report.md"), text);
	return sha256(text);
}

function approvalPort(h, options = {}) {
	return approvalAuthority.createPort(h.root, "demo", { ...h.ports, ...options });
}

function auditEvidence(mission, reportSha256, overrides = {}) {
	const evidence = {
		verdict: "PASS",
		caseCount: Math.max(1, mission.frozen?.s2?.structure?.ids?.cases?.length ?? 1),
		recheck: {
			ok: true,
			missionId: mission["mission-id"],
			revision: mission.revision,
			reportSha256,
		},
	};
	return {
		...evidence,
		...overrides,
		recheck: { ...evidence.recheck, ...(overrides.recheck ?? {}) },
	};
}

async function issueAuditApproval(h, mission, reportSha256, options = {}) {
	const port = approvalPort(h, options.portOptions);
	return port.issue(
		mission["mission-id"],
		mission.revision,
		reportSha256,
		options.evidence ?? auditEvidence(mission, reportSha256, options.evidenceOverrides),
	);
}

function restartVerification(root, slug) {
	const moduleUrl = new URL("../src/stages/contract.mjs", import.meta.url).href;
	const script = `
import(${JSON.stringify(moduleUrl)}).then(async (module) => {
	const result = await module.verifyApproval(${JSON.stringify(root)}, ${JSON.stringify(slug)});
	const read = await module.readMission(${JSON.stringify(root)}, ${JSON.stringify(slug)});
	console.log("RESULT:" + JSON.stringify({ ...result, readValid: read.valid, readAuthorized: read.authorized }));
}).catch((error) => {
	console.error(error && error.stack ? error.stack : String(error));
	process.exit(1);
});
`;
	const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000 });
	const line = (child.stdout ?? "").split(/\r?\n/).find((entry) => entry.startsWith("RESULT:"));
	if (!line) {
		throw new Error(`restart verification child failed: ${child.stderr || child.stdout || "no output"}`);
	}
	return JSON.parse(line.slice("RESULT:".length));
}

afterEach(() => {
	while (roots.length > 0) {
		rmSync(roots.pop(), { recursive: true, force: true });
	}
});

describe("contract line", () => {
	const frozenFixture = () => ({
		s1: { path: "plans/demo/s1-brainstorm.md", sha256: "a".repeat(64) },
		"s1-summary": { path: ".herd/missions/demo/s1-summary.md", sha256: "b".repeat(64) },
		s2: { path: "plans/demo/s2-manual-tests.md", sha256: "c".repeat(64) },
		"s2-cases": { path: ".herd/missions/demo/cases.edn", sha256: "d".repeat(64) },
		s3: { path: "plans/demo/s3-dev-guide.md", sha256: "e".repeat(64) },
		"s3-modules": { sha256: "f".repeat(64) },
		s4: { path: "plans/demo/s4-coordination.md", sha256: "0".repeat(64) },
	});

	it("builds the exact seven-entry line and parses it back", () => {
		const frozen = frozenFixture();
		const line = buildContractLine("demo", frozen);

		expect(line).toBe(
			`${CONTRACT_PREFIX} s1: plans/demo/s1-brainstorm.md sha256=${frozen.s1.sha256}; s1-summary: .herd/missions/demo/s1-summary.md sha256=${frozen["s1-summary"].sha256}; s2: plans/demo/s2-manual-tests.md sha256=${frozen.s2.sha256}; s2-cases: .herd/missions/demo/cases.edn sha256=${frozen["s2-cases"].sha256}; s3: plans/demo/s3-dev-guide.md sha256=${frozen.s3.sha256}; s3-modules: inline sha256=${frozen["s3-modules"].sha256}; s4: plans/demo/s4-coordination.md sha256=${frozen.s4.sha256}; ${CONTRACT_SUFFIX}`,
		);
		const parsed = parseContractLine(line);
		expect(parsed.ok).toBe(true);
		expect(parsed.slug).toBe("demo");
		expect(parsed.frozen).toEqual(frozen);
	});

	it("rejects reordered, short, extra, and multi-slug lines", () => {
		const frozen = frozenFixture();
		const good = buildContractLine("demo", frozen);

		expect(parseContractLine(good.replace("s1:", "s2:")).ok).toBe(false);
		expect(
			parseContractLine(good.replace(`sha256=${frozen.s1.sha256}`, `sha256=${frozen.s1.sha256.slice(0, 63)}`)).ok,
		).toBe(false);
		expect(parseContractLine(`${good} extra`).ok).toBe(false);
		expect(
			parseContractLine(good.replace("s3: plans/demo/s3-dev-guide.md", "s3: plans/other/s3-dev-guide.md")).ok,
		).toBe(false);
		expect(parseContractLine(good.replace("s3-modules: inline", "s3-modules: plans/demo/x")).ok).toBe(false);
	});

	it("normalizes stage names", () => {
		expect(normalizeStage(":s1")).toBe("s1");
		expect(normalizeStage("S4")).toBe("s4");
		expect(normalizeStage(5)).toBe("s5");
		expect(normalizeStage("completed")).toBe("completed");
		expect(normalizeStage("s6")).toBeUndefined();
	});
});

describe("mission creation", () => {
	it("creates one S1 mission with revision zero and refuses a second slug", async () => {
		const h = harness();
		const created = await create(h);

		expect(created.ok).toBe(true);
		expect(created.mission.stage).toBe(":s1");
		expect(created.mission.revision).toBe(0);
		expect(created.mission["mission-id"]).toBe("M-1");
		expect(created.mission.approval).toBeNull();
		expect(created.mission.frozen).toEqual({});

		expect(await create(h)).toEqual({
			ok: false,
			error: { code: ":SLUG_TAKEN", message: "mission already exists: demo", data: { slug: "demo" } },
		});
		expect((await readMission(h.root, "demo", h.ports)).valid).toBe(true);

		await mutateMission(h, (mission) => ({ ...mission, slug: "other" }));
		const mismatch = await readMission(h.root, "demo", h.ports);
		expect(mismatch.valid).toBe(false);
		expect(mismatch.error.data.reason).toBe("slug-mismatch");
	});

	it("refuses to verify an incomplete contract", async () => {
		const h = harness();
		await create(h);

		const verified = await verifyContract(h.root, "demo", h.ports);
		expect(verified.ok).toBe(false);
		expect(verified.error.code).toBe(":STAGE_MISMATCH");
		expect(verified.error.data.reason).toBe("contract-incomplete");
	});
});

describe("stage freezing", () => {
	it("re-reads the S1 file at approval instead of using a stale in-memory copy", async () => {
		const h = harness();
		await create(h);
		await saveStageDocument(h.root, "demo", "s1", S1_DOC, h.ports);
		await writePendingGate(h.root, "demo", { stage: "s1", "call-id": "wait-1" }, h.ports);

		const edited = `${S1_DOC}\n## 未决问题\n\n人类补充。\n`;
		h.documents.files.set(absolute("plans/demo/s1-brainstorm.md"), edited);

		const frozen = await freezeStage(h.root, "demo", "s1", undefined, {
			...h.ports,
			callId: "approve-1",
		});

		expect(frozen.ok).toBe(true);
		expect(frozen.revision).toBe(1);
		expect(frozen.missionStage).toBe("s2");
		expect(frozen.sha256).toBe(sha256(edited));
		expect(await readPendingGate(h.root, "demo", h.ports)).toEqual({ ok: true, pending: null });
		const mission = await missionOf(h);
		expect(mission.stage).toBe(":s2");
		expect(mission.frozen.s1.sha256).toBe(sha256(edited));
	});

	it("never overwrites an existing S1 file with a stale approval payload", async () => {
		const h = harness();
		await create(h);
		await h.documents.writeText(absolute("plans/demo/s1-brainstorm.md"), S1_DOC);

		const frozen = await freezeStage(h.root, "demo", "s1", "stale markdown that must not win", {
			...h.ports,
			callId: "approve-stale",
		});

		expect(frozen.ok).toBe(true);
		expect(frozen.sha256).toBe(sha256(S1_DOC));
		expect(h.documents.files.get(absolute("plans/demo/s1-brainstorm.md"))).toBe(S1_DOC);
	});

	it("freezes S2-S4, advances to S5, and writes the contract line", async () => {
		const h = harness();
		const receipts = await freezeAll(h);

		expect(receipts.map((receipt) => receipt.revision)).toEqual([1, 2, 3, 4]);
		const mission = await missionOf(h);
		expect(mission.stage).toBe(":s5");
		expect(mission.revision).toBe(4);
		expect(mission["contract-line"]).toBe(buildContractLine("demo", mission.frozen));
		for (const stage of STAGE_IDS) {
			expect(mission.frozen[stage].sha256).toBe(
				sha256(h.documents.files.get(absolute(stageDocumentPath("demo", stage)))),
			);
			expect(mission.frozen[stage].path).toBe(stageDocumentPath("demo", stage));
		}

		const verified = await verifyContract(h.root, "demo", h.ports);
		expect(verified.ok).toBe(true);
		expect(verified.contract.revision).toBe(4);
		expect(verified.contract.hashes).toEqual({
			s1: mission.frozen.s1.sha256,
			"s1-summary": mission.frozen["s1-summary"].sha256,
			s2: mission.frozen.s2.sha256,
			"s2-cases": mission.frozen["s2-cases"].sha256,
			s3: mission.frozen.s3.sha256,
			"s3-modules": mission.frozen["s3-modules"].sha256,
			s4: mission.frozen.s4.sha256,
		});
	});

	it("preserves the gate-provided S2 CASE order in the frozen structure", async () => {
		const h = harness();
		await create(h);
		await saveStageDocument(h.root, "demo", "s1", S1_DOC, h.ports);
		h.documents.files.set(absolute("plans/demo/s1-brainstorm.md"), S1_DOC);
		expect((await freezeStage(h.root, "demo", "s1", undefined, { ...h.ports, callId: "order-s1" })).ok).toBe(true);
		const s2 = `${S2_DOC}\n引用 CASE-99。\n\n### CASE-02\n- PASS threshold: 80/100\n- 路径：边界\n- 评分细则：边界证据。\n`;
		expect(
			(
				await freezeStage(h.root, "demo", "s2", s2, {
					...h.ports,
					callId: "order-s2",
					structure: { cases: ["CASE-02", "CASE-01"] },
				})
			).ok,
		).toBe(true);
		const mission = await missionOf(h);
		expect(mission.frozen.s2.structure.ids.cases.map((entry) => entry.id)).toEqual(["CASE-02", "CASE-01"]);
		expect(mission.frozen.s2.structure.declared.cases).toEqual(["CASE-02", "CASE-01"]);
	});

	it("is idempotent per call-id and rejects a different payload", async () => {
		const h = harness();
		await create(h);
		await saveStageDocument(h.root, "demo", "s1", S1_DOC, h.ports);
		h.documents.files.set(absolute("plans/demo/s1-brainstorm.md"), S1_DOC);
		expect((await freezeStage(h.root, "demo", "s1", undefined, { ...h.ports, callId: "freeze-s1" })).ok).toBe(true);

		const first = await freezeStage(h.root, "demo", "s2", S2_DOC, {
			...h.ports,
			callId: "replay-s2",
			structure: { cases: [{ case_id: "CASE-01" }] },
		});
		expect(first.ok).toBe(true);
		expect(first.revision).toBe(2);

		const replay = await freezeStage(h.root, "demo", "s2", S2_DOC, {
			...h.ports,
			callId: "replay-s2",
			structure: { cases: [{ case_id: "CASE-01" }] },
		});
		expect(replay.ok).toBe(true);
		expect(replay.replayed).toBe(true);
		expect(replay.revision).toBe(2);
		expect((await missionOf(h)).revision).toBe(2);

		const mismatch = await freezeStage(h.root, "demo", "s2", `${S2_DOC}\nedit\n`, {
			...h.ports,
			callId: "replay-s2",
			structure: { cases: [{ case_id: "CASE-01" }] },
		});
		expect(mismatch.ok).toBe(false);
		expect(mismatch.error.code).toBe(":CALL_REPLAY_MISMATCH");

		const h2 = harness();
		await create(h2);
		const saved = await saveStageDocument(h2.root, "demo", "s1", S1_DOC, { ...h2.ports, callId: "save-1" });
		expect(saved.ok).toBe(true);
		const replayed = await saveStageDocument(h2.root, "demo", "s1", S1_DOC, {
			...h2.ports,
			callId: "save-1",
		});
		expect(replayed.ok).toBe(true);
		expect(replayed.replayed).toBe(true);
		expect(replayed.sha256).toBe(saved.sha256);
		const saveMismatch = await saveStageDocument(h2.root, "demo", "s1", `${S1_DOC}\nedit\n`, {
			...h2.ports,
			callId: "save-1",
		});
		expect(saveMismatch.ok).toBe(false);
		expect(saveMismatch.error.code).toBe(":CALL_REPLAY_MISMATCH");
	});

	it("uses distinct gate phase call-ids for S1 save and approval", async () => {
		const h = harness();
		await create(h);
		const saved = await saveStageDocument(h.root, "demo", "s1", S1_DOC, {
			...h.ports,
			callId: "gate-1:save",
		});
		expect(saved.ok).toBe(true);
		const edited = `${S1_DOC}\n人类编辑。\n`;
		h.documents.files.set(absolute("plans/demo/s1-brainstorm.md"), edited);

		const frozen = await freezeStage(h.root, "demo", "s1", undefined, {
			...h.ports,
			callId: "gate-1:freeze",
		});
		expect(frozen.ok).toBe(true);
		expect(frozen.sha256).toBe(sha256(edited));
		expect(frozen.missionStage).toBe("s2");

		const saveReplay = await saveStageDocument(h.root, "demo", "s1", S1_DOC, {
			...h.ports,
			callId: "gate-1:save",
		});
		expect(saveReplay.ok).toBe(true);
		expect(saveReplay.replayed).toBe(true);
		const freezeReplay = await freezeStage(h.root, "demo", "s1", undefined, {
			...h.ports,
			callId: "gate-1:freeze",
		});
		expect(freezeReplay.ok).toBe(true);
		expect(freezeReplay.replayed).toBe(true);
		const reuse = await freezeStage(h.root, "demo", "s1", undefined, {
			...h.ports,
			callId: "gate-1:save",
		});
		expect(reuse.ok).toBe(false);
		expect(reuse.error.code).toBe(":CALL_REPLAY_MISMATCH");
	});
});

describe("contract verification", () => {
	it("detects a changed document with expected and actual hashes", async () => {
		const h = harness();
		await freezeAll(h);
		const before = await missionOf(h);
		const changed = `${S2_DOC}\n人类改动。\n`;
		await h.documents.writeText(absolute("plans/demo/s2-manual-tests.md"), changed);

		const verified = await verifyContract(h.root, "demo", h.ports);
		expect(verified.ok).toBe(false);
		expect(verified.error.code).toBe(":CONTRACT_HASH_MISMATCH");
		expect(verified.error.data.key).toBe("s2");
		expect(verified.error.data.expected).toBe(before.frozen.s2.sha256);
		expect(verified.error.data.actual).toBe(sha256(changed));
	});

	it("detects missing, empty, stale-line, and incomplete contracts", async () => {
		const h = harness();
		await freezeAll(h);

		h.documents.files.delete(absolute("plans/demo/s3-dev-guide.md"));
		let verified = await verifyContract(h.root, "demo", h.ports);
		expect(verified.ok).toBe(false);
		expect(verified.error.data.reason).toBe("missing");

		h.documents.files.set(absolute("plans/demo/s3-dev-guide.md"), "   \n");
		verified = await verifyContract(h.root, "demo", h.ports);
		expect(verified.ok).toBe(false);
		expect(verified.error.data.reason).toBe("empty");

		h.documents.files.set(absolute("plans/demo/s3-dev-guide.md"), S3_DOC);
		await mutateMission(h, (mission) => ({ ...mission, "contract-line": "Verification contract: nope" }));
		verified = await verifyContract(h.root, "demo", h.ports);
		expect(verified.ok).toBe(true);
		expect(verified.contract.contractLineStale).toBe(true);
		expect(verified.contract.warning.code).toBe(":CONTRACT_LINE_STALE");
		expect(verified.contract.contractLine).toBe(buildContractLine("demo", verified.contract.frozen));

		await mutateMission(h, (mission) => {
			const frozen = { ...mission.frozen };
			delete frozen.s4;
			return { ...mission, frozen };
		});
		verified = await verifyContract(h.root, "demo", h.ports);
		expect(verified.ok).toBe(false);
		expect(verified.error.code).toBe(":STAGE_MISMATCH");
		expect(verified.error.data.reason).toBe("contract-incomplete");
	});
});

describe("realignment", () => {
	it("updates the hash, bumps revision, and names the affected CASE", async () => {
		const h = harness();
		await freezeAll(h);
		const newCase = [
			"### CASE-02",
			"- PASS threshold: 80/100",
			"- 路径：边界",
			"- 评分细则：边界证据映射到 0-100。",
			"",
		].join("\n");
		const changed = `${S2_DOC}\n${newCase}`;
		await h.documents.writeText(absolute("plans/demo/s2-manual-tests.md"), changed);

		const result = await realign(h.root, "demo", "s2", {
			...h.ports,
			callId: "realign-s2",
			structure: { cases: [{ case_id: "CASE-01" }, { case_id: "CASE-02" }] },
		});

		expect(result.ok).toBe(true);
		expect(result.status).toBe("realigned");
		expect(result.revision).toBe(5);
		expect(result.sha256).toBe(sha256(changed));
		expect(result.changedSections.some((section) => section.change === "added")).toBe(true);
		expect(result.affected.cases).toContain("CASE-02");
		const mission = await missionOf(h);
		expect(mission.revision).toBe(5);
		expect(mission.frozen.s2.sha256).toBe(sha256(changed));
		expect(mission["contract-line"]).toBe(buildContractLine("demo", mission.frozen));
		expect((await verifyContract(h.root, "demo", h.ports)).ok).toBe(true);
	});

	it("does not bump revision when the frozen bytes did not change", async () => {
		const h = harness();
		await freezeAll(h);
		const mission = await missionOf(h);

		const result = await realign(h.root, "demo", "s2", { ...h.ports, callId: "realign-unchanged" });

		expect(result.ok).toBe(true);
		expect(result.status).toBe("unchanged");
		expect(result.revision).toBe(mission.revision);
		expect((await missionOf(h)).revision).toBe(mission.revision);
	});

	it("refuses an unfrozen stage and any realignment after completion", async () => {
		const h = harness();
		await create(h);
		await h.documents.writeText(absolute("plans/demo/s1-brainstorm.md"), S1_DOC);

		const unfrozen = await realign(h.root, "demo", "s1", h.ports);
		expect(unfrozen.ok).toBe(false);
		expect(unfrozen.error.data.reason).toBe("not-frozen");

		const h2 = harness();
		await freezeAll(h2);
		const report = await reportHash(h2);
		expect((await issueAuditApproval(h2, await missionOf(h2), report)).ok).toBe(true);
		await h2.documents.writeText(absolute("plans/demo/s1-brainstorm.md"), `${S1_DOC}\nlater\n`);

		const completed = await realign(h2.root, "demo", "s1", h2.ports);
		expect(completed.ok).toBe(false);
		expect(completed.error.code).toBe(":APPROVAL_REQUIRED");
		expect(completed.error.data.reason).toBe("completed");
	});
});

describe("one-time approval", () => {
	it("binds mission-id, revision, contract line, and report hash", async () => {
		const early = harness();
		await create(early);
		await saveStageDocument(early.root, "demo", "s1", S1_DOC, early.ports);
		early.documents.files.set(absolute("plans/demo/s1-brainstorm.md"), S1_DOC);
		expect((await freezeStage(early.root, "demo", "s1", undefined, { ...early.ports, callId: "e-s1" })).ok).toBe(true);
		expect((await freezeStage(early.root, "demo", "s2", S2_DOC, { ...early.ports, callId: "e-s2" })).ok).toBe(true);
		expect((await freezeStage(early.root, "demo", "s3", S3_DOC, { ...early.ports, callId: "e-s3" })).ok).toBe(true);
		const earlyReport = await reportHash(early);
		const earlyDenied = await issueAuditApproval(early, await missionOf(early), earlyReport);
		expect(earlyDenied.ok).toBe(false);
		expect(earlyDenied.code).toBe(":STAGE_MISMATCH");
		expect(earlyDenied.error.data.reason).toBe("not-s5");

		const wrong = "f".repeat(64);
		const h2 = harness();
		await freezeAll(h2);
		const mission = await missionOf(h2);
		const approvedReport = await reportHash(h2);
		const wrongHash = await issueAuditApproval(h2, mission, wrong);
		expect(wrongHash.ok).toBe(false);
		expect(wrongHash.code).toBe(":APPROVAL_REQUIRED");
		expect(wrongHash.error.data.reason).toBe("report-changed");

		const issued = await issueAuditApproval(h2, mission, approvedReport);
		expect(issued.ok).toBe(true);
		expect(issued.completed).toBe(true);
		expect(issued.approval.revision).toBe(mission.revision);
		expect(issued.approval.reportSha256).toBe(approvedReport);
		expect(issued.approval.token).toMatch(/^[0-9a-f]{64}$/);

		const completed = await missionOf(h2);
		expect(completed.stage).toBe(":completed");
		expect(completed.approval.revision).toBe(mission.revision);
		expect(completed.approval.token).toBe(issued.approval.token);
		const verified = await verifyApproval(h2.root, "demo", h2.ports);
		expect(verified.ok).toBe(true);
		expect(verified.authorized).toBe(true);
		expect(verified.approval).toEqual(issued.approval);

		await mutateMission(h2, (current) => ({ ...current, revision: current.revision + 1 }));
		const stale = await verifyApproval(h2.root, "demo", h2.ports);
		expect(stale.ok).toBe(false);
		expect(stale.error.code).toBe(":APPROVAL_REQUIRED");
		expect(stale.error.data.reason).toBe("revision");
	});

	it("rejects a forged token, a completed stage with no approval, and a reused approval", async () => {
		const h = harness();
		await freezeAll(h);
		const report = await reportHash(h);
		const issued = await issueAuditApproval(h, await missionOf(h), report);
		expect(issued.ok).toBe(true);

		await mutateMission(h, (current) => ({
			...current,
			approval: { ...current.approval, token: "0".repeat(64) },
		}));
		let verified = await verifyApproval(h.root, "demo", h.ports);
		expect(verified.ok).toBe(false);
		expect(verified.error.data.reason).toBe("token");

		await mutateMission(h, (current) => ({ ...current, approval: null }));
		verified = await verifyApproval(h.root, "demo", h.ports);
		expect(verified.ok).toBe(false);
		expect(verified.error.data.reason).toBe("completed-without-approval");

		const read = await readMission(h.root, "demo", h.ports);
		expect(read.ok).toBe(true);
		expect(read.valid).toBe(false);
		expect(read.error.code).toBe(":APPROVAL_REQUIRED");

		const h2 = harness();
		await freezeAll(h2);
		const secondReport = await reportHash(h2);
		const first = await issueAuditApproval(h2, await missionOf(h2), secondReport);
		expect(first.ok).toBe(true);
		const again = await issueAuditApproval(h2, await missionOf(h2), secondReport);
		expect(again.ok).toBe(true);
		expect(again.approval.token).toBe(first.approval.token);

		const different = await issueAuditApproval(h2, await missionOf(h2), "a".repeat(64), {
			portOptions: { verifyReport: false },
			evidenceOverrides: { recheck: { reportSha256: "a".repeat(64) } },
		});
		expect(different.ok).toBe(false);
		expect(different.code).toBe(":APPROVAL_REQUIRED");
		expect(different.error.data.reason).toBe("already-completed");

		const rework = await beginRework(h2.root, "demo", { ...h2.ports, reason: "more work" });
		expect(rework.ok).toBe(false);
		expect(rework.error.code).toBe(":APPROVAL_REQUIRED");
	});

	it("bumps revision before rework and invalidates the old binding", async () => {
		const h = harness();
		await freezeAll(h);
		const mission = await missionOf(h);

		const rework = await beginRework(h.root, "demo", { ...h.ports, reason: "CASE-01 failed" });
		expect(rework.ok).toBe(true);
		expect(rework.revision).toBe(mission.revision + 1);
		const after = await missionOf(h);
		expect(after.stage).toBe(":s5");
		expect(after.revision).toBe(mission.revision + 1);
		expect(after["last-rework"].reason).toBe("CASE-01 failed");

		const report = await reportHash(h);
		const issued = await issueAuditApproval(h, await missionOf(h), report);
		expect(issued.ok).toBe(true);
		expect(issued.approval.revision).toBe(after.revision);
	});
});

describe("approval authority bypass and tamper", () => {
	it("has no public report-hash completion path and consumes the authority once", async () => {
		const h = harness();
		await freezeAll(h);
		const mission = await missionOf(h);
		const report = await reportHash(h);
		const port = approvalPort(h);

		expect(contractModule.issueApproval).toBeUndefined();
		expect(takeApprovalAuthority()).toBeNull();

		const onlyHash = await port.issue(mission["mission-id"], mission.revision, report);
		expect(onlyHash.ok).toBe(false);
		expect(onlyHash.code).toBe(":APPROVAL_REQUIRED");
		expect(onlyHash.error.data.reason).toBe("audit-evidence-required");

		const fake = await port.issue(mission["mission-id"], mission.revision, report, {
			aggregate: { verdict: "PASS", ok: true },
			recheck: { ok: true },
		});
		expect(fake.ok).toBe(false);
		expect(fake.code).toBe(":APPROVAL_REQUIRED");
		expect((await missionOf(h)).stage).toBe(":s5");
	});

	it("rejects a non-PASS aggregate, zero CASE count, and a recheck binding mismatch", async () => {
		const h = harness();
		await freezeAll(h);
		const mission = await missionOf(h);
		const report = await reportHash(h);
		const port = approvalPort(h);

		const notPass = await port.issue(
			mission["mission-id"],
			mission.revision,
			report,
			auditEvidence(mission, report, { verdict: "FAIL" }),
		);
		expect(notPass.ok).toBe(false);
		expect(notPass.error.data.reason).toBe("audit-not-pass");

		const noCases = await port.issue(
			mission["mission-id"],
			mission.revision,
			report,
			auditEvidence(mission, report, { caseCount: 0 }),
		);
		expect(noCases.ok).toBe(false);
		expect(noCases.error.data.reason).toBe("case-count");

		const recheckResult = await port.issue(
			mission["mission-id"],
			mission.revision,
			report,
			auditEvidence(mission, report, { recheck: { revision: mission.revision + 1 } }),
		);
		expect(recheckResult.ok).toBe(false);
		expect(recheckResult.error.data.reason).toBe("recheck-binding");

		expect((await missionOf(h)).stage).toBe(":s5");
	});

	it("does not accept a hand-edited stage/approval or a changed contract", async () => {
		const h = harness();
		await freezeAll(h);
		const report = await reportHash(h);
		await mutateMission(h, (current) => ({
			...current,
			stage: ":completed",
			approval: {
				revision: current.revision,
				token: "1".repeat(64),
				reportSha256: report,
				"issued-at": NOW,
			},
		}));
		const forged = await verifyApproval(h.root, "demo", h.ports);
		expect(forged.ok).toBe(false);
		expect(forged.error.code).toBe(":APPROVAL_REQUIRED");
		expect(forged.error.data.reason).toBe("key-missing");
		expect((await readMission(h.root, "demo", h.ports)).authorized).toBe(false);

		const h2 = harness();
		await freezeAll(h2);
		const mission2 = await missionOf(h2);
		const report2 = await reportHash(h2);
		expect((await issueAuditApproval(h2, mission2, report2)).ok).toBe(true);

		const keyPath = absolute(".herd/missions/demo/approval.key");
		const realKey = h2.documents.files.get(keyPath);
		expect(realKey.trim()).toMatch(/^[0-9a-f]{64}$/);
		const completed2 = await missionOf(h2);
		const publicToken = sha256(
			`${mission2["mission-id"]}:${mission2.revision}:${mission2["contract-line"]}:${report2}`,
		);
		expect(completed2.approval.token).not.toBe(publicToken);

		await mutateMission(h2, (current) => ({
			...current,
			approval: { ...current.approval, token: publicToken },
		}));
		const publicFormula = await verifyApproval(h2.root, "demo", h2.ports);
		expect(publicFormula.ok).toBe(false);
		expect(publicFormula.error.data.reason).toBe("token");

		await mutateMission(h2, (current) => ({
			...current,
			revision: current.revision + 1,
			approval: { ...current.approval, token: completed2.approval.token, revision: current.revision + 1 },
		}));
		const reboundRevision = await verifyApproval(h2.root, "demo", h2.ports);
		expect(reboundRevision.ok).toBe(false);
		expect(reboundRevision.error.data.reason).toBe("token");

		await mutateMission(h2, (current) => ({
			...current,
			"mission-id": "M-OTHER",
			revision: current.revision - 1,
			approval: { ...current.approval, revision: current.revision - 1 },
		}));
		const reboundMission = await verifyApproval(h2.root, "demo", h2.ports);
		expect(reboundMission.ok).toBe(false);
		expect(reboundMission.error.data.reason).toBe("token");

		await mutateMission(h2, (current) => ({
			...current,
			"mission-id": mission2["mission-id"],
		}));
		h2.documents.files.set(keyPath, `${"0".repeat(64)}\n`);
		const replacedKey = await verifyApproval(h2.root, "demo", h2.ports);
		expect(replacedKey.ok).toBe(false);
		expect(replacedKey.error.data.reason).toBe("token");

		h2.documents.files.set(keyPath, realKey);
		expect((await verifyApproval(h2.root, "demo", h2.ports)).authorized).toBe(true);

		h2.documents.files.set(absolute("plans/demo/s1-brainstorm.md"), "changed after approval\n");
		const contractTampered = await verifyApproval(h2.root, "demo", h2.ports);
		expect(contractTampered.ok).toBe(false);
		expect(contractTampered.error.code).toBe(":CONTRACT_HASH_MISMATCH");
	});

	it("verifies a completed mission without a live authority", async () => {
		const h = harness();
		await freezeAll(h);
		const mission = await missionOf(h);
		const report = await reportHash(h);
		expect((await issueAuditApproval(h, mission, report)).ok).toBe(true);

		const verified = await verifyApproval(h.root, "demo", h.ports);
		expect(verified.ok).toBe(true);
		expect(verified.authorized).toBe(true);
		const read = await readMission(h.root, "demo", h.ports);
		expect(read.valid).toBe(true);
		expect(read.authorized).toBe(true);

		h.documents.files.set(absolute("plans/demo/s5-report.md"), "# changed after approval\n");
		const changedReport = await verifyApproval(h.root, "demo", h.ports);
		expect(changedReport.ok).toBe(false);
		expect(changedReport.error.data.reason).toBe("report-changed");
		expect((await readMission(h.root, "demo", h.ports)).authorized).toBe(false);
	});
});

describe("storage boundaries", () => {
	it("leaves the mission unchanged when the stage write fails", async () => {
		const h = harness();
		await create(h);
		const failing = {
			...createMemoryDocuments(),
			async writeText(path, text) {
				if (path.endsWith(".md")) return { ok: false, code: "EACCES", message: "denied" };
				return createMemoryDocuments().writeText(path, text);
			},
		};
		const ports = { ...h.ports, documents: failing };

		const frozen = await freezeStage(h.root, "demo", "s1", S1_DOC, { ...ports, callId: "denied" });

		expect(frozen.ok).toBe(false);
		expect(frozen.error.data.reason).toBe("document-write");
		const mission = await missionOf(h);
		expect(mission.stage).toBe(":s1");
		expect(mission.revision).toBe(0);
		expect(mission.frozen).toEqual({});
	});

	it("keeps the S1 pending gate when its cleanup fails after the mission commit", async () => {
		const h = harness();
		await create(h);
		await saveStageDocument(h.root, "demo", "s1", S1_DOC, h.ports);
		await writePendingGate(h.root, "demo", { stage: "s1", "call-id": "wait" }, h.ports);
		const failing = {
			...h.documents,
			async remove(path) {
				if (path.endsWith("pending-gate.edn")) {
					return { ok: false, code: "EACCES", message: "denied" };
				}
				return h.documents.remove(path);
			},
		};
		const ports = { ...h.ports, documents: failing };

		const frozen = await freezeStage(h.root, "demo", "s1", undefined, {
			...ports,
			callId: "approve-with-cleanup-failure",
		});

		expect(frozen.ok).toBe(true);
		expect(frozen.pendingCleared).toBe(false);
		expect(frozen.warning).toContain("pending-gate.edn");
		expect((await missionOf(h)).stage).toBe(":s2");
		expect((await readPendingGate(h.root, "demo", h.ports)).pending).not.toBeNull();
		expect((await writePendingGate(h.root, "demo", null, h.ports)).ok).toBe(true);
		expect((await readPendingGate(h.root, "demo", h.ports)).pending).toBeNull();
	});

	it("serializes concurrent S2 freezes so only one revision bump survives", async () => {
		const h = harness();
		await create(h);
		await saveStageDocument(h.root, "demo", "s1", S1_DOC, h.ports);
		h.documents.files.set(absolute("plans/demo/s1-brainstorm.md"), S1_DOC);
		expect((await freezeStage(h.root, "demo", "s1", undefined, { ...h.ports, callId: "s1" })).ok).toBe(true);

		const [first, second] = await Promise.all([
			freezeStage(h.root, "demo", "s2", S2_DOC, { ...h.ports, callId: "race-a" }),
			freezeStage(h.root, "demo", "s2", `${S2_DOC}\nB\n`, { ...h.ports, callId: "race-b" }),
		]);
		expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
		const loser = first.ok ? second : first;
		expect(loser.error.code).toBe(":STAGE_MISMATCH");
		const mission = await missionOf(h);
		expect(mission.stage).toBe(":s3");
		expect(mission.revision).toBe(2);
	});

	it("round-trips mission, pending gate, and reports through the disk adapter", async () => {
		const root = mkdtempSync(join(tmpdir(), "herd-stage-contract-"));
		roots.push(root);
		const seed = "第一行\n第二行";
		const created = await createMission(root, { slug: "disk", missionId: "M-D", seed });
		expect(created.ok).toBe(true);

		const missionText = readFileSync(join(root, ".herd", "missions", "disk", "mission.edn"), "utf8");
		expect(missionText).toContain(":stage :s1");
		expect(missionText).toContain(':mission-id "M-D"');
		expect(missionText).toContain("第一行");
		expect(missionText).toContain("第二行");
		const read = await readMission(root, "disk");
		expect(read.ok).toBe(true);
		expect(read.mission.seed).toBe(seed);

		expect((await writePendingGate(root, "disk", { stage: "s1", "call-id": "wait" })).ok).toBe(true);
		expect((await readPendingGate(root, "disk")).pending).toEqual({ stage: "s1", "call-id": "wait" });
		expect((await writePendingGate(root, "disk", null)).ok).toBe(true);
		expect((await readPendingGate(root, "disk")).pending).toBeNull();

		expect((await saveStageDocument(root, "disk", "s1", S1_DOC)).ok).toBe(true);
		expect((await saveS1Summary(root, "disk", "已批准摘要")).ok).toBe(true);
		expect((await freezeStage(root, "disk", "s1", undefined, { callId: "approve" })).ok).toBe(true);
		const listed = await listMissions(root);
		expect(listed.ok).toBe(true);
		expect(listed.missions.map((entry) => entry.slug)).toEqual(["disk"]);
		expect(listed.missions[0].mission.stage).toBe(":s2");
	});

	it("runs the full disk-backed freeze, realign, and approval path", async () => {
		const root = mkdtempSync(join(tmpdir(), "herd-stage-contract-"));
		roots.push(root);
		expect((await createMission(root, { slug: "full", missionId: "M-F" })).ok).toBe(true);
		expect((await saveStageDocument(root, "full", "s1", S1_DOC)).ok).toBe(true);
		expect((await saveS1Summary(root, "full", "已批准摘要")).ok).toBe(true);
		expect((await freezeStage(root, "full", "s1", undefined, { callId: "d1" })).ok).toBe(true);
		expect((await saveS2Cases(root, "full", CASES)).ok).toBe(true);
		expect(
			(
				await freezeStage(root, "full", "s2", S2_DOC, {
					callId: "d2",
					structure: { cases: [{ case_id: "CASE-01" }] },
				})
			).ok,
		).toBe(true);
		expect(
			(
				await freezeStage(root, "full", "s3", S3_DOC, {
					callId: "d3",
					modules: MODULES,
					structure: { modules: [{ path: "src/a.mjs" }] },
				})
			).ok,
		).toBe(true);
		expect(
			(
				await freezeStage(root, "full", "s4", S4_DOC, {
					callId: "d4",
					slices: SLICES,
					structure: { slices: [{ slice_id: "alpha" }] },
				})
			).ok,
		).toBe(true);
		expect((await verifyContract(root, "full")).ok).toBe(true);

		const s2Path = join(root, "plans", "full", "s2-manual-tests.md");
		const changed = `${S2_DOC}\n### CASE-02\n- PASS threshold: 80/100\n- 路径：边界\n- 评分细则：边界证据。\n`;
		writeFileSync(s2Path, changed, "utf8");
		const aligned = await realign(root, "full", "s2", {
			callId: "d5",
			structure: { cases: [{ case_id: "CASE-01" }, { case_id: "CASE-02" }] },
		});
		expect(aligned.ok).toBe(true);
		expect(aligned.status).toBe("realigned");
		expect(aligned.revision).toBe(5);
		expect(aligned.affected.cases).toContain("CASE-02");

		const reportText = "# S5 报告\n\n全部 CASE 通过。\n";
		writeFileSync(join(root, "plans", "full", "s5-report.md"), reportText, "utf8");
		const reportSha256 = sha256(reportText);
		const diskMission = (await readMission(root, "full")).mission;
		const port = approvalAuthority.createPort(root, "full");
		const issued = await port.issue(
			diskMission["mission-id"],
			diskMission.revision,
			reportSha256,
			auditEvidence(diskMission, reportSha256),
		);
		expect(issued.ok).toBe(true);
		expect((await verifyApproval(root, "full")).ok).toBe(true);
		const mission = (await readMission(root, "full")).mission;
		expect(mission.stage).toBe(":completed");
		expect(mission.frozen.s2.structure.ids.cases.map((entry) => entry.id)).toContain("CASE-02");
		expect(Object.values(mission.receipts).some((entry) => entry.receipt.completed === true)).toBe(true);

		const restarted = restartVerification(root, "full");
		expect(restarted.ok).toBe(true);
		expect(restarted.authorized).toBe(true);
		expect(restarted.readValid).toBe(true);
		expect(restarted.readAuthorized).toBe(true);

		const missionFile = join(root, ".herd", "missions", "full", "mission.edn");
		const originalMission = readFileSync(missionFile, "utf8");
		const publicToken = sha256(
			`${mission["mission-id"]}:${mission.revision}:${mission["contract-line"]}:${reportSha256}`,
		);
		expect(mission.approval.token).not.toBe(publicToken);
		const forgedMission = originalMission.replace(/:token "[0-9a-f]{64}"/, `:token "${publicToken}"`);
		writeFileSync(missionFile, forgedMission, "utf8");
		const tamperedRestart = restartVerification(root, "full");
		expect(tamperedRestart.ok).toBe(false);
		expect(tamperedRestart.error.data.reason).toBe("token");
		expect(tamperedRestart.readAuthorized).toBe(false);

		writeFileSync(missionFile, originalMission, "utf8");
		const keyFile = join(root, ".herd", "missions", "full", "approval.key");
		const approvalKey = readFileSync(keyFile, "utf8").trim();
		expect(approvalKey).toMatch(/^[0-9a-f]{64}$/);
		if (process.platform !== "win32") expect(statSync(keyFile).mode & 0o777).toBe(0o600);
		rmSync(keyFile, { force: true });
		const missingKeyRestart = restartVerification(root, "full");
		expect(missingKeyRestart.ok).toBe(false);
		expect(missingKeyRestart.error.data.reason).toBe("key-missing");
		expect(missingKeyRestart.readAuthorized).toBe(false);

		writeFileSync(keyFile, `${approvalKey}\n`, "utf8");
		expect(restartVerification(root, "full").ok).toBe(true);

		rmSync(join(root, "plans", "full", "s5-report.md"), { force: true });
		const missingReportRestart = restartVerification(root, "full");
		expect(missingReportRestart.ok).toBe(false);
		expect(missingReportRestart.error.data.reason).toBe("report-missing");
		expect(missingReportRestart.readAuthorized).toBe(false);
	});

	it("rejects a hand-written completed mission without an approval record", async () => {
		const root = mkdtempSync(join(tmpdir(), "herd-stage-contract-"));
		roots.push(root);
		const dir = join(root, ".herd", "missions", "hand");
		const file = join(dir, "mission.edn");
		await createMission(root, { slug: "hand", missionId: "M-H" });
		rmSync(file);
		const forged = [
			'{:mission-id "M-H"',
			' :slug "hand"',
			' :created-at "2026-11-11T00:00:00.000Z"',
			' :updated-at "2026-11-11T00:00:00.000Z"',
			" :stage :completed",
			" :revision 4",
			" :contract-line nil",
			" :frozen {}",
			" :approval nil",
			" :receipts {}",
			" :limits {}",
			" :settings {}}",
			"",
		].join("\n");
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, forged, "utf8");

		const read = await readMission(root, "hand");
		expect(read.ok).toBe(true);
		expect(read.valid).toBe(false);
		expect(read.error.code).toBe(":APPROVAL_REQUIRED");
		expect(read.error.data.reason).toBe("completed-without-approval");
		expect((await verifyApproval(root, "hand")).ok).toBe(false);
		expect(validateMission(read.mission).ok).toBe(false);
	});
});

describe("EDN reader", () => {
	it("round-trips the values printEdn produces", () => {
		const { parseEdn } = __test;
		expect(parseEdn("{:stage :s1 :revision 3 :ok true :none nil}")).toEqual({
			stage: ":s1",
			revision: 3,
			ok: true,
			none: null,
		});
		expect(parseEdn('#"a \\"quoted\\" path"#')).toBe('a \\"quoted\\" path');
		expect(parseEdn('#"""\n  line one\n  line two\n  """#')).toBe("line one\nline two");
	});
});

describe("D13 control state", () => {
	it("saves summary and cases idempotently and reads frozen bytes once", async () => {
		const h = harness();
		const created = await createMission(h.root, { slug: "demo", missionId: "M-1", seed: "seed", ...h.ports });
		expect(created.ok).toBe(true);
		const summary = await saveS1Summary(h.root, "demo", "摘要原字节", { ...h.ports, callId: "sum-1" });
		expect(summary.ok).toBe(true);
		const summaryReplay = await saveS1Summary(h.root, "demo", "摘要原字节", { ...h.ports, callId: "sum-1" });
		expect(summaryReplay).toMatchObject({ ok: true, replayed: true, sha256: summary.sha256 });
		const summaryConflict = await saveS1Summary(h.root, "demo", "另一个摘要", {
			...h.ports,
			callId: "sum-1",
		});
		expect(summaryConflict.error.code).toBe(":CALL_REPLAY_MISMATCH");

		const cases = await saveS2Cases(h.root, "demo", CASES, { ...h.ports, callId: "cases-1" });
		expect(cases.ok).toBe(true);
		const casesReplay = await saveS2Cases(h.root, "demo", CASES, { ...h.ports, callId: "cases-1" });
		expect(casesReplay).toMatchObject({ ok: true, replayed: true, sha256: cases.sha256 });
		const casesConflict = await saveS2Cases(h.root, "demo", [...CASES, { ...CASES[0], "case-id": "CASE-X" }], {
			...h.ports,
			callId: "cases-1",
		});
		expect(casesConflict.error.code).toBe(":CALL_REPLAY_MISMATCH");

		const h2 = harness();
		await freezeAll(h2);
		const s1 = await readS1Summary(h2.root, "demo", h2.ports);
		expect(s1.ok).toBe(true);
		expect(s1.bytes.toString("utf8")).toBe("已批准摘要");
		const s2 = await readS2Cases(h2.root, "demo", h2.ports);
		expect(s2.ok).toBe(true);
		expect(s2.caseIds).toEqual(CASE_IDS);
		expect(s2.cases[0].steps).toEqual(["执行真实命令。", "记录可观察输出。"]);
		expect(s2.sha256).toBe(sha256(s2.bytes));
		const prefix = await verifyFrozenPrefix(h2.root, "demo", { ...h2.ports, keys: ["s1", "s1-summary"] });
		expect(prefix.ok).toBe(true);
		expect(prefix.hashes["s1-summary"]).toBe(s1.sha256);
		const slices = await readS4Slices(h2.root, "demo", h2.ports);
		expect(slices).toMatchObject({ ok: true, slices: [{ "slice-id": "alpha" }] });
		expect(FROZEN_KEYS).toEqual(["s1", "s1-summary", "s2", "s2-cases", "s3", "s3-modules", "s4"]);
	});

	it("rejects string and mixed steps through the shared CASE validator", async () => {
		const h = harness();
		await createMission(h.root, { slug: "demo", missionId: "M-1", seed: "seed", ...h.ports });
		const stringSteps = await saveS2Cases(h.root, "demo", [{ ...CASES[0], steps: "执行" }], h.ports);
		expect(stringSteps.ok).toBe(false);
		expect(stringSteps.error.code).toBe(":INVALID_ARGUMENT");
		const mixedSteps = await saveS2Cases(h.root, "demo", [{ ...CASES[0], steps: ["执行", 42] }], h.ports);
		expect(mixedSteps.ok).toBe(false);
		expect(mixedSteps.error.code).toBe(":INVALID_ARGUMENT");
		const emptySteps = await saveS2Cases(h.root, "demo", [{ ...CASES[0], steps: [] }], h.ports);
		expect(emptySteps.ok).toBe(false);
		expect(emptySteps.error.code).toBe(":INVALID_ARGUMENT");
	});

	it("accepts case_id/case-id in structure but rejects legacy id-only CASE entries", async () => {
		const h = harness();
		await create(h);
		await saveStageDocument(h.root, "demo", "s1", S1_DOC, h.ports);
		expect((await freezeStage(h.root, "demo", "s1", undefined, { ...h.ports, callId: "shape-s1" })).ok).toBe(true);
		const legacy = await freezeStage(h.root, "demo", "s2", S2_DOC, {
			...h.ports,
			callId: "shape-legacy",
			structure: { cases: [{ id: "CASE-01" }] },
		});
		expect(legacy.ok).toBe(false);
		expect(legacy.error.code).toBe(":INVALID_ARGUMENT");
		const dual = await freezeStage(h.root, "demo", "s2", S2_DOC, {
			...h.ports,
			callId: "shape-dual",
			structure: { cases: [{ case_id: "CASE-01", "case-id": "CASE-01" }] },
		});
		expect(dual.ok).toBe(false);
		expect(dual.error.code).toBe(":INVALID_ARGUMENT");
	});

	it("iterates S1 summary with a new call-id before freeze and blocks it after", async () => {
		const h = harness();
		await createMission(h.root, { slug: "demo", missionId: "M-1", seed: "seed", ...h.ports });
		const first = await saveS1Summary(h.root, "demo", "第一版摘要", { ...h.ports, callId: "summary-v1" });
		expect(first.ok).toBe(true);
		const revised = await saveS1Summary(h.root, "demo", "第二版摘要", { ...h.ports, callId: "summary-v2" });
		expect(revised.ok).toBe(true);
		expect(h.documents.files.get(absolute(".herd/missions/demo/s1-summary.md"))).toBe("第二版摘要");
		const sameCall = await saveS1Summary(h.root, "demo", "第三版摘要", { ...h.ports, callId: "summary-v2" });
		expect(sameCall.error.code).toBe(":CALL_REPLAY_MISMATCH");
		await saveStageDocument(h.root, "demo", "s1", S1_DOC, h.ports);
		expect((await freezeStage(h.root, "demo", "s1", undefined, { ...h.ports, callId: "s1-freeze" })).ok).toBe(true);
		const frozenChange = await saveS1Summary(h.root, "demo", "冻结后摘要", {
			...h.ports,
			callId: "summary-v3",
		});
		expect(frozenChange.ok).toBe(false);
		expect(frozenChange.error.code).toBe(":FILE_CONFLICT");
		expect(h.documents.files.get(absolute(".herd/missions/demo/s1-summary.md"))).toBe("第二版摘要");
	});

	it("rejects unknown CASE keys and kebab/snake id aliases before normalization", async () => {
		const h = harness();
		await createMission(h.root, { slug: "demo", missionId: "M-1", seed: "seed", ...h.ports });
		const unknown = await saveS2Cases(h.root, "demo", [{ ...CASES[0], extra: true }], h.ports);
		expect(unknown.ok).toBe(false);
		expect(unknown.error.code).toBe(":INVALID_ARGUMENT");
		expect(unknown.error.message).toContain("extra");
		expect(h.documents.files.has(absolute(".herd/missions/demo/cases.edn"))).toBe(false);
		const dualAlias = await saveS2Cases(h.root, "demo", [{ ...CASES[0], case_id: "CASE-01" }], h.ports);
		expect(dualAlias.ok).toBe(false);
		expect(dualAlias.error.code).toBe(":INVALID_ARGUMENT");

		const h2 = harness();
		await freezeAll(h2);
		const casesPath = absolute(".herd/missions/demo/cases.edn");
		const tampered = `${printEdnCases([{ ...CASES[0], extra: true }])}\n`;
		h2.documents.files.set(casesPath, tampered);
		const tamperedHash = sha256(tampered);
		await mutateMission(h2, (mission) => ({
			...mission,
			frozen: {
				...mission.frozen,
				"s2-cases": { ...mission.frozen["s2-cases"], sha256: tamperedHash },
			},
		}));
		const reread = await readS2Cases(h2.root, "demo", h2.ports);
		expect(reread.ok).toBe(false);
		expect(reread.error.code).toBe(":INVALID_ARGUMENT");
	});

	it("fails closed when required control files are missing", async () => {
		const h = harness();
		await createMission(h.root, { slug: "demo", missionId: "M-1", seed: "seed", ...h.ports });
		await saveStageDocument(h.root, "demo", "s1", S1_DOC, h.ports);
		const noSummary = await freezeStage(h.root, "demo", "s1", undefined, { ...h.ports, callId: "missing-summary" });
		expect(noSummary.error.code).toBe(":FILE_CONFLICT");
		await saveS1Summary(h.root, "demo", "摘要", h.ports);
		expect((await freezeStage(h.root, "demo", "s1", undefined, { ...h.ports, callId: "s1" })).ok).toBe(true);
		const noCases = await freezeStage(h.root, "demo", "s2", S2_DOC, { ...h.ports, callId: "missing-cases" });
		expect(noCases.error.code).toBe(":FILE_CONFLICT");
		await saveS2Cases(h.root, "demo", CASES, h.ports);
		expect((await freezeStage(h.root, "demo", "s2", S2_DOC, { ...h.ports, callId: "s2" })).ok).toBe(true);
		const noModules = await freezeStage(h.root, "demo", "s3", S3_DOC, { ...h.ports, callId: "missing-modules" });
		expect(noModules.error.code).toBe(":INVALID_ARGUMENT");
	});

	it("commits S2 cases and document under one mission transaction and fails external edits", async () => {
		const h = harness();
		await create(h);
		await saveStageDocument(h.root, "demo", "s1", S1_DOC, h.ports);
		expect((await freezeStage(h.root, "demo", "s1", undefined, { ...h.ports, callId: "s1" })).ok).toBe(true);
		const committed = await commitS2(
			h.root,
			"demo",
			{ manual_tests_markdown: S2_DOC, cases: CASES },
			{ ...h.ports, callId: "s2-commit" },
		);
		expect(committed.ok).toBe(true);
		expect(committed.revision).toBe(2);
		expect(committed.missionStage).toBe("s3");
		const read = await readS2Cases(h.root, "demo", h.ports);
		expect(read.ok).toBe(true);
		expect(read.sha256).toBe(committed.casesSha256);
		const replay = await commitS2(
			h.root,
			"demo",
			{ manual_tests_markdown: S2_DOC, cases: CASES },
			{ ...h.ports, callId: "s2-commit" },
		);
		expect(replay.replayed).toBe(true);
		expect(replay.revision).toBe(2);
		h.documents.files.set(
			absolute(".herd/missions/demo/cases.edn"),
			`${printEdnCases([CASES[0], { ...CASES[0], "case-id": "CASE-X" }])}\n`,
		);
		const tampered = await commitS2(
			h.root,
			"demo",
			{ manual_tests_markdown: S2_DOC, cases: CASES },
			{ ...h.ports, callId: "s2-commit" },
		);
		expect(tampered.error.code).toBe(":CASE_HASH_MISMATCH");

		const h2 = harness();
		await create(h2);
		await saveStageDocument(h2.root, "demo", "s1", S1_DOC, h2.ports);
		expect((await freezeStage(h2.root, "demo", "s1", undefined, { ...h2.ports, callId: "s1" })).ok).toBe(true);
		h2.documents.files.set(
			absolute(".herd/missions/demo/cases.edn"),
			`${printEdnCases([CASES[0], { ...CASES[0], "case-id": "CASE-X" }])}\n`,
		);
		const external = await commitS2(
			h2.root,
			"demo",
			{ manual_tests_markdown: S2_DOC, cases: CASES },
			{ ...h2.ports, callId: "s2-external" },
		);
		expect(external.ok).toBe(false);
		expect(external.error.code).toBe(":CASE_HASH_MISMATCH");
		expect((await missionOf(h2)).stage).toBe(":s2");
	});

	it("realigns summary and CASE IDs with a single structured revision", async () => {
		const h = harness();
		await freezeAll(h);
		const before = await missionOf(h);
		const s1Hash = before.frozen.s1.sha256;
		const summaryPath = absolute(".herd/missions/demo/s1-summary.md");
		h.documents.files.set(summaryPath, "人类更新后的摘要");
		const summary = await realign(h.root, "demo", "s1-summary", { ...h.ports, callId: "align-summary" });
		expect(summary.ok).toBe(true);
		const afterSummary = await missionOf(h);
		expect(afterSummary.frozen["s1-summary"].sha256).toBe(sha256("人类更新后的摘要"));
		expect(afterSummary.frozen.s1.sha256).toBe(s1Hash);

		const casesTwo = [
			...CASES,
			{
				...CASES[0],
				"case-id": "CASE-06",
				path: "恢复",
				steps: ["执行附加恢复样本。"],
				expected: "恢复输出符合契约。",
			},
		];
		h.documents.files.set(absolute(".herd/missions/demo/cases.edn"), `${printEdnCases(casesTwo)}\n`);
		const blocked = await realign(h.root, "demo", "s2-cases", { ...h.ports, callId: "align-cases-blocked" });
		expect(blocked.error.code).toBe(":MAPPING_REALIGN_REQUIRED");
		const mappedModules = [
			{
				path: "src/a.mjs",
				"secret-owned": "实现",
				"depends-on": [],
				"mapped-cases": [...CASE_IDS, "CASE-06"],
			},
		];
		const mappedSlices = [
			{
				"slice-id": "alpha",
				goal: "正常与边界",
				inputs: [...CASE_IDS, "CASE-06"],
				"depends-on": [],
				"done-when": "通过",
				"mapped-cases": [...CASE_IDS, "CASE-06"],
			},
		];
		const revisionBefore = (await missionOf(h)).revision;
		const aligned = await realign(h.root, "demo", "s2-cases", {
			...h.ports,
			callId: "align-cases",
			modules: mappedModules,
			slices: mappedSlices,
		});
		expect(aligned.ok).toBe(true);
		expect(aligned.revision).toBe(revisionBefore + 1);
		expect(aligned.caseIds).toEqual([...CASE_IDS, "CASE-06"]);
		expect(aligned.frozen["s2-cases"].sha256).toBe(aligned.sha256);
		expect(typeof aligned.contractLine).toBe("string");
		const afterCases = await missionOf(h);
		expect(afterCases.frozen["s2-cases"].sha256).toBe(
			sha256(h.documents.files.get(absolute(".herd/missions/demo/cases.edn"))),
		);
		expect(afterCases["s3-modules"][0]["mapped-cases"]).toEqual([...CASE_IDS, "CASE-06"]);
		expect(afterCases["s4-slices"][0]["mapped-cases"]).toEqual([...CASE_IDS, "CASE-06"]);
	});
});
