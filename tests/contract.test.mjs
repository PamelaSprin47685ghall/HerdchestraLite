import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	freezeManualAcceptanceObjective,
	manualAcceptanceEffectiveContract,
	manualAcceptanceFrozenLine,
	manualProposeGateRejection,
	parseManualContract,
	parseManualContractParts,
	validateManualDocuments,
} from "../src/manual-acceptance/contract.mjs";
import {
	manualAcceptanceDir,
	manualAcceptanceDocumentError,
	manualAcceptanceWriteDocument,
} from "../src/manual-acceptance/documents.mjs";

const HASH_A = "A".repeat(64);
const HASH_B = "B".repeat(64);
const HASH_C = "C".repeat(64);
const A = HASH_A.toLowerCase();
const B = HASH_B.toLowerCase();
const C = HASH_C.toLowerCase();

const roots = [];

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), "herd-contract-"));
	roots.push(root);
	return root;
}

function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function contractLine(slug, { hashes = false, key = "sha256" } = {}) {
	const token = (hash) => (hashes ? ` ${key}=${hash}` : "");
	return [
		"Verification contract: MANUAL ACCEPTANCE —",
		`requirements: docs/manual-acceptance/${slug}/requirements.md${token(HASH_A)};`,
		`development-guide: docs/manual-acceptance/${slug}/development-guide.md${token(HASH_B)};`,
		`coordination: docs/manual-acceptance/${slug}/coordination.md${token(HASH_C)};`,
		"execute every CASE and score it out of 100;",
		"automated tests are NOT acceptance evidence.",
	].join(" ");
}

afterEach(() => {
	while (roots.length > 0) {
		rmSync(roots.pop(), { recursive: true, force: true });
	}
});

describe("parseManualContractParts", () => {
	it("uses the last contract line", () => {
		const objective = ["目标说明。", contractLine("first"), contractLine("second")].join("\n");

		const parsed = parseManualContractParts(objective);

		expect(parsed.ok).toBe(true);
		expect(parsed.contract.slug).toBe("second");
		expect(parsed.hashes.size).toBe(0);
	});

	it("normalizes hash keys and lowercases hex digits", () => {
		const objective = contractLine("demo", { hashes: true, key: "Sha256   " });
		const parsed = parseManualContractParts(objective);

		expect(parsed.ok).toBe(true);
		expect(parsed.hashes.get("requirements.md")).toBe(A);
		expect(parsed.hashes.get("development-guide.md")).toBe(B);
		expect(parsed.hashes.get("coordination.md")).toBe(C);
		expect(parseManualContract(objective)?.slug).toBe("demo");
	});

	it("rejects an unknown document file", () => {
		const objective = [
			"Verification contract: MANUAL ACCEPTANCE —",
			"requirements: docs/manual-acceptance/demo/requirements.md;",
			"development-guide: docs/manual-acceptance/demo/development-guide.md;",
			"coordination: docs/manual-acceptance/demo/coordination.md;",
			"notes: docs/manual-acceptance/demo/notes.md;",
		].join(" ");

		expect(parseManualContractParts(objective)).toEqual({ ok: false, reason: "contract" });
	});

	it("rejects a repeated document file", () => {
		const objective = [
			"Verification contract: MANUAL ACCEPTANCE —",
			"requirements: docs/manual-acceptance/demo/requirements.md;",
			"requirements: docs/manual-acceptance/demo/requirements.md;",
			"development-guide: docs/manual-acceptance/demo/development-guide.md;",
			"coordination: docs/manual-acceptance/demo/coordination.md;",
		].join(" ");

		expect(parseManualContractParts(objective)).toEqual({ ok: false, reason: "contract" });
	});

	it("rejects paths from more than one slug", () => {
		const objective = [
			"Verification contract: MANUAL ACCEPTANCE —",
			"requirements: docs/manual-acceptance/alpha/requirements.md;",
			"development-guide: docs/manual-acceptance/beta/development-guide.md;",
			"coordination: docs/manual-acceptance/alpha/coordination.md;",
		].join(" ");

		expect(parseManualContractParts(objective)).toEqual({ ok: false, reason: "contract" });
	});

	it("rejects a hash token that names no document", () => {
		const objective = `${contractLine("demo")} sha256=${HASH_A}`;

		expect(parseManualContractParts(objective)).toEqual({ ok: false, reason: "hash" });
	});

	it("requires three hashes for a completable contract", () => {
		const objective = [
			"Verification contract: MANUAL ACCEPTANCE —",
			`requirements: docs/manual-acceptance/demo/requirements.md sha256=${HASH_A};`,
			"development-guide: docs/manual-acceptance/demo/development-guide.md;",
			"coordination: docs/manual-acceptance/demo/coordination.md;",
		].join(" ");

		expect(parseManualContractParts(objective).ok).toBe(true);
		expect(parseManualContract(objective)).toBeUndefined();
	});
});

describe("contract freezing", () => {
	it("builds the frozen line verbatim", () => {
		const contract = {
			slug: "demo",
			requirementsPath: "docs/manual-acceptance/demo/requirements.md",
			guidePath: "docs/manual-acceptance/demo/development-guide.md",
			coordinationPath: "docs/manual-acceptance/demo/coordination.md",
		};
		const hashes = new Map([
			["requirements.md", A],
			["development-guide.md", B],
			["coordination.md", C],
		]);

		expect(manualAcceptanceFrozenLine(contract, hashes)).toBe(
			`Verification contract: MANUAL ACCEPTANCE — requirements: docs/manual-acceptance/demo/requirements.md sha256=${A}; development-guide: docs/manual-acceptance/demo/development-guide.md sha256=${B}; coordination: docs/manual-acceptance/demo/coordination.md sha256=${C}; execute every CASE and score it out of 100; automated tests are NOT acceptance evidence.`,
		);
	});

	it("replaces only the last contract line", () => {
		const objective = ["目标说明。", contractLine("first"), contractLine("second")].join("\n");
		const frozen = "Verification contract: MANUAL ACCEPTANCE — frozen";

		expect(freezeManualAcceptanceObjective(objective, frozen)).toBe(
			["目标说明。", contractLine("first"), frozen].join("\n"),
		);
		expect(freezeManualAcceptanceObjective("没有契约", frozen)).toBeUndefined();
	});

	it("extracts the effective contract from an embedded line or the goal field", () => {
		expect(
			manualAcceptanceEffectiveContract({ objective: contractLine("demo"), verificationContract: "ignored" }),
		).toBe(contractLine("demo"));
		expect(manualAcceptanceEffectiveContract({ objective: "", verificationContract: " MANUAL ACCEPTANCE — x " })).toBe(
			"Verification contract: MANUAL ACCEPTANCE — x",
		);
		expect(manualAcceptanceEffectiveContract({ objective: "" })).toBeUndefined();
	});

	it("formats the propose-gate rejection with the contract template", () => {
		expect(manualProposeGateRejection("a non-empty string objective")).toBe(
			[
				"propose_goal_draft REJECTED (manual acceptance gate).",
				"Missing: a non-empty string objective.",
				"The objective must contain one line:",
				"Verification contract: MANUAL ACCEPTANCE — requirements: docs/manual-acceptance/<slug>/requirements.md sha256=<64hex>; development-guide: docs/manual-acceptance/<slug>/development-guide.md sha256=<64hex>; coordination: docs/manual-acceptance/<slug>/coordination.md sha256=<64hex>; execute every CASE and score it out of 100; automated tests are NOT acceptance evidence.",
			].join("\n"),
		);
	});
});

describe("validateManualDocuments", () => {
	const requirements = [
		"# 验收需求",
		"",
		"### CASE-01",
		"- PASS threshold: 80 / 100",
		"- 路径：正常",
		"- 评分细则：满足。",
		"",
	].join("\n");
	const guide = "# 开发指南\n\n## 实现\n";
	const coordination = "# 协调\n\n## 任务分解\n\n切片。\n\n## 合并顺序\n\n按序。\n";

	function writeDocs(cwd) {
		const dir = join(cwd, "docs", "manual-acceptance", "demo");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "requirements.md"), requirements, "utf8");
		writeFileSync(join(dir, "development-guide.md"), guide, "utf8");
		writeFileSync(join(dir, "coordination.md"), coordination, "utf8");
		return dir;
	}

	function frozenObjective() {
		return [
			"目标说明。",
			[
				"Verification contract: MANUAL ACCEPTANCE —",
				`requirements: docs/manual-acceptance/demo/requirements.md sha256=${sha256(requirements)};`,
				`development-guide: docs/manual-acceptance/demo/development-guide.md sha256=${sha256(guide)};`,
				`coordination: docs/manual-acceptance/demo/coordination.md sha256=${sha256(coordination)};`,
				"execute every CASE and score it out of 100;",
				"automated tests are NOT acceptance evidence.",
			].join(" "),
		].join("\n");
	}

	it("accepts matching documents and returns their contents", () => {
		const cwd = sandbox();
		writeDocs(cwd);

		const result = validateManualDocuments(cwd, frozenObjective());

		expect(result.ok).toBe(true);
		expect(result.docs.contract.slug).toBe("demo");
		expect(result.docs.requirementsMarkdown).toBe(requirements);
		expect(result.docs.guideMarkdown).toBe(guide);
		expect(result.docs.coordinationMarkdown).toBe(coordination);
	});

	it("reports a changed document as a hash mismatch", () => {
		const cwd = sandbox();
		const dir = writeDocs(cwd);
		writeFileSync(join(dir, "development-guide.md"), "# changed\n", "utf8");

		expect(validateManualDocuments(cwd, frozenObjective())).toEqual({
			ok: false,
			error:
				"docs/manual-acceptance/demo/development-guide.md hash mismatch (the file changed after the contract was frozen)",
		});
	});

	it("reports a missing document with the submit hint", () => {
		const cwd = sandbox();
		const dir = writeDocs(cwd);
		rmSync(join(dir, "coordination.md"));

		expect(validateManualDocuments(cwd, frozenObjective())).toEqual({
			ok: false,
			error: "docs/manual-acceptance/demo/coordination.md (not found; submit it before proposing the goal)",
		});
	});

	it("rejects an objective without three hashes", () => {
		const cwd = sandbox();
		writeDocs(cwd);

		expect(validateManualDocuments(cwd, contractLine("demo"))).toEqual({
			ok: false,
			error:
				"the verification contract must include sha256=<64hex> for each document (requirements.md, development-guide.md, coordination.md)",
		});
	});
});

describe("document helpers", () => {
	it("resolves a safe slug and rejects an invalid one", () => {
		const cwd = sandbox();

		expect(manualAcceptanceDir(cwd, "demo")).toBe(join(cwd, "docs", "manual-acceptance", "demo"));
		expect(() => manualAcceptanceDir(cwd, "../demo")).toThrow(
			"invalid goal_slug: use 1-64 lowercase letters, digits, or hyphens, starting with a letter or digit",
		);
	});

	it("reports whether the target already existed", () => {
		const root = sandbox();

		expect(manualAcceptanceWriteDocument(root, "requirements.md", "# one\n")).toBe(false);
		expect(manualAcceptanceWriteDocument(root, "requirements.md", "# two\n")).toBe(true);
	});

	it("rejects documents that miss the required section shapes", () => {
		expect(manualAcceptanceDocumentError("", "guide_markdown")).toBe("guide_markdown must be a non-empty string.");
		expect(manualAcceptanceDocumentError("没有小节", "guide_markdown")).toBe(
			'guide_markdown must contain at least one "## " section.',
		);
		expect(manualAcceptanceDocumentError("## 概要\n", "guide_markdown")).toBe(
			'guide_markdown must contain "S2" or a "## ...实现/步骤..." heading.',
		);
		expect(manualAcceptanceDocumentError("## 设计\n", "coordination_markdown")).toBe(
			'coordination_markdown must contain a 切片/任务分解 section and a "## ...合并顺序" heading.',
		);
		expect(manualAcceptanceDocumentError("## 实现\n", "guide_markdown")).toBeUndefined();
		expect(manualAcceptanceDocumentError("## 切片\n\n## 合并顺序\n", "coordination_markdown")).toBeUndefined();
	});
});
