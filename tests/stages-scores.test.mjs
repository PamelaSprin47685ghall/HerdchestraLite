import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate, writeS5Report } from "../src/stages/scores.mjs";

const hash = (character) => character.repeat(64);

const FROZEN = {
	s1: { sha256: hash("a") },
	"s1-summary": { sha256: hash("b") },
	s2: { sha256: hash("c") },
	"s2-cases": { sha256: hash("d") },
	s3: { sha256: hash("e") },
	s4: { sha256: hash("f") },
	"s3-modules": { sha256: hash("0") },
};

const CONTRACT = {
	missionId: "mission-clean-break",
	revision: 4,
	contractLine:
		"Verification contract: MANUAL ACCEPTANCE — " +
		`s1: plans/demo/s1-brainstorm.md sha256=${FROZEN.s1.sha256}; ` +
		`s1-summary: .herd/missions/demo/s1-summary.md sha256=${FROZEN["s1-summary"].sha256}; ` +
		`s2: plans/demo/s2-manual-tests.md sha256=${FROZEN.s2.sha256}; ` +
		`s2-cases: .herd/missions/demo/cases.edn sha256=${FROZEN["s2-cases"].sha256}; ` +
		`s3: plans/demo/s3-dev-guide.md sha256=${FROZEN.s3.sha256}; ` +
		`s4: plans/demo/s4-coordination.md sha256=${FROZEN.s4.sha256}; ` +
		`s3-modules: inline sha256=${FROZEN["s3-modules"].sha256}; ` +
		"execute every CASE and score min(user_score, developer_score) out of 100; " +
		"automated tests are NOT acceptance evidence.",
	frozen: FROZEN,
};

const AUDIT = {
	environment: "omp 18.16.0 / linux x64 / tmux 会话 herd-demo-CASE-01",
	limitations: "只在 tmux 抓屏与 /tmp 副本中观察。",
	lessons: "先抓屏再打分，失败分支必须单独留证。",
};

const SNAPSHOT = {
	digest: "workspace-digest-before",
	files: [{ path: "src/main.mjs", sha256: hash("e"), stamp: { mtimeSec: 1n, mtimeNsec: 2n, size: 3n } }],
};

const SPECS = [
	{
		case_id: "CASE-01",
		threshold: 80,
		path: "正常",
		steps: ["Exercise the normal path."],
		expected: "The normal path is observable.",
		rubric: "score the normal path",
	},
	{
		case_id: "CASE-02",
		threshold: 70,
		path: "错误",
		steps: ["Exercise the error path."],
		expected: "The error path is observable.",
		rubric: "score the error path",
	},
];

function submission(caseId, overrides = {}) {
	return {
		case_id: caseId,
		user_score: 90,
		developer_score: 90,
		report_markdown: `# ${caseId}\n\n执行者、环境、逐步骤观察与证据路径。`,
		evidence_paths: [`plans/demo/evidence/${caseId}/screen.txt`],
		validation: { ok: true },
		...overrides,
	};
}

function baseInput(overrides = {}) {
	const { ports, ...rest } = overrides;
	return {
		caseSpecs: SPECS,
		submissions: [
			submission("CASE-01", { user_score: 90, developer_score: 80 }),
			submission("CASE-02", { user_score: 70, developer_score: 95 }),
		],
		contract: CONTRACT,
		snapshotBefore: SNAPSHOT,
		snapshotAfter: SNAPSHOT,
		audit: AUDIT,
		ports: { verifyContract: () => ({ ok: true }), ...(ports ?? {}) },
		...rest,
	};
}

function codesOf(result) {
	return result.invalid.map((entry) => entry.code);
}

function boundApproval(missionId, revision, reportSha256) {
	return { ok: true, approval: { token: "approval-token", missionId, revision, reportSha256 } };
}

function okRecheck() {
	return { ok: true };
}

async function withTempRoot(work) {
	const root = mkdtempSync(join(tmpdir(), "herd-stages-scores-"));
	try {
		return await work(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("aggregate", () => {
	it("passes only when every CASE reaches min(user_score, developer_score), in S2 order", () => {
		const result = aggregate(
			baseInput({
				submissions: [
					submission("CASE-02", { user_score: 70, developer_score: 95 }),
					submission("CASE-01", { user_score: 90, developer_score: 80 }),
				],
			}),
		);

		expect(result.ok).toBe(true);
		expect(result.verdict).toBe("PASS");
		expect(
			result.rows.map((row) => [row.caseId, row.userScore, row.developerScore, row.score, row.threshold, row.passed]),
		).toEqual([
			["CASE-01", 90, 80, 80, 80, true],
			["CASE-02", 70, 95, 70, 70, true],
		]);
		expect(result.caseIds).toEqual(["CASE-01", "CASE-02"]);
		expect(result.invalid).toEqual([]);
		expect(result.repairSpec).toBeNull();
		expect(result.retryRequired).toBe(false);
	});

	it("ignores a submitted total score and uses the two perspectives", () => {
		const result = aggregate(
			baseInput({
				submissions: [
					submission("CASE-01", { score: 100, user_score: 40, developer_score: 90 }),
					submission("CASE-02"),
				],
			}),
		);

		expect(result.ok).toBe(false);
		expect(result.verdict).toBe("FAIL");
		expect(result.rows[0].score).toBe(40);
		expect(result.rows[0].passed).toBe(false);
		expect(result.invalid).toEqual([]);
	});

	it("accepts the inclusive 0 and 100 boundaries", () => {
		const zero = aggregate(
			baseInput({
				caseSpecs: [
					{
						case_id: "CASE-01",
						threshold: 0,
						path: "边界",
						steps: ["Exercise the boundary."],
						expected: "The boundary is observable.",
						rubric: "score the boundary",
					},
				],
				submissions: [submission("CASE-01", { user_score: 0, developer_score: 100 })],
			}),
		);
		expect(zero.ok).toBe(true);
		expect(zero.rows[0].score).toBe(0);

		const hundred = aggregate(
			baseInput({
				caseSpecs: [
					{
						case_id: "CASE-01",
						threshold: 100,
						path: "边界",
						steps: ["Exercise the boundary."],
						expected: "The boundary is observable.",
						rubric: "score the boundary",
					},
				],
				submissions: [submission("CASE-01", { user_score: 100, developer_score: 100 })],
			}),
		);
		expect(hundred.ok).toBe(true);
		expect(hundred.rows[0].score).toBe(100);
	});

	it("fails a CASE below the threshold and produces the frozen RepairSpec shape", () => {
		const result = aggregate(
			baseInput({
				submissions: [submission("CASE-01", { user_score: 60, developer_score: 100 }), submission("CASE-02")],
			}),
		);

		expect(result.ok).toBe(false);
		expect(result.verdict).toBe("FAIL");
		expect(result.repairSpec).toMatchObject({
			repair_id: expect.any(String),
			failed_cases: ["CASE-01"],
			goal: expect.stringContaining("CASE-01"),
			done_when: expect.any(String),
			mapped_cases: ["CASE-01"],
			revision: 4,
			next_revision: 5,
		});
		expect(result.repairSpec.inputs).toContain("plans/demo/evidence/CASE-01/screen.txt");
		expect(result.repairSpec.cases[0]).toMatchObject({
			case_id: "CASE-01",
			user_score: 60,
			developer_score: 100,
			final: 60,
		});
	});

	it("reports a missing CASE as an audit retry, not a code repair", () => {
		const result = aggregate(baseInput({ submissions: [submission("CASE-01")] }));

		expect(result.ok).toBe(false);
		expect(result.verdict).toBe("INCOMPLETE");
		expect(result.missing).toEqual(["CASE-02"]);
		expect(codesOf(result)).toContain(":AUDIT_MISSING");
		expect(result.repairSpec).toBeNull();
		expect(result.retryRequired).toBe(true);
	});

	it("reports unknown and duplicated CASEs once and fails the verdict", () => {
		const unknown = aggregate(
			baseInput({
				submissions: [submission("CASE-01"), submission("CASE-02"), submission("CASE-99"), submission("CASE-99")],
			}),
		);
		expect(unknown.ok).toBe(false);
		expect(unknown.unknown).toEqual(["CASE-99"]);
		expect(codesOf(unknown).filter((code) => code === ":AUDIT_UNKNOWN_CASE")).toHaveLength(2);

		const duplicate = aggregate(
			baseInput({
				submissions: [
					submission("CASE-01"),
					submission("CASE-02"),
					submission("CASE-01", { user_score: 100, developer_score: 100 }),
				],
			}),
		);
		expect(duplicate.ok).toBe(false);
		expect(duplicate.duplicates).toEqual(["CASE-01"]);
		expect(duplicate.rows[0]).toMatchObject({ valid: false, passed: false, score: null });
		expect(duplicate.repairSpec).toBeNull();
	});

	it("rejects non-finite, non-numeric, and out-of-range scores", () => {
		const values = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 101, -1, "90", null, true];

		for (const value of values) {
			const result = aggregate(
				baseInput({ submissions: [submission("CASE-01", { user_score: value }), submission("CASE-02")] }),
			);
			expect(result.ok).toBe(false);
			expect(result.verdict).toBe("INCOMPLETE");
			expect(
				result.invalid.some(
					(entry) =>
						entry.code === ":AUDIT_INVALID_SCORE" && entry.caseId === "CASE-01" && entry.field === "user_score",
				),
			).toBe(true);
			expect(result.rows[0].valid).toBe(false);
		}
	});

	it("rejects an empty report or malformed evidence_paths", () => {
		for (const override of [{ report_markdown: "   " }, { evidence_paths: [] }, { evidence_paths: ["ok", ""] }]) {
			const result = aggregate(baseInput({ submissions: [submission("CASE-01", override), submission("CASE-02")] }));
			expect(result.ok).toBe(false);
			expect(result.verdict).toBe("INCOMPLETE");
			expect(
				result.invalid.some((entry) => entry.code === ":AUDIT_EVIDENCE_MISSING" && entry.caseId === "CASE-01"),
			).toBe(true);
			expect(result.repairSpec).toBeNull();
		}
	});

	it("requires B3 validation or an evidence port instead of trusting raw evidence", () => {
		const unvalidated = aggregate(
			baseInput({ submissions: [submission("CASE-01", { validation: undefined }), submission("CASE-02")] }),
		);
		expect(unvalidated.ok).toBe(false);
		expect(
			unvalidated.invalid.some((entry) => entry.code === ":AUDIT_EVIDENCE_MISSING" && entry.field === "validation"),
		).toBe(true);

		const checked = aggregate(
			baseInput({
				submissions: [submission("CASE-01", { validation: undefined }), submission("CASE-02")],
				ports: { checkEvidence: () => ({ ok: true }) },
			}),
		);
		expect(checked.ok).toBe(true);
	});

	it("consults an injected evidence port and never lets a throw escape", () => {
		const rejected = aggregate(
			baseInput({
				ports: {
					checkEvidence: ({ caseId }) =>
						caseId === "CASE-02" ? { ok: false, missing: ["/tmp/missing.txt"] } : { ok: true },
				},
			}),
		);
		expect(rejected.ok).toBe(false);
		expect(
			rejected.invalid.some(
				(entry) =>
					entry.code === ":AUDIT_EVIDENCE_MISSING" && entry.caseId === "CASE-02" && entry.field === "evidence_paths",
			),
		).toBe(true);

		const thrown = aggregate(
			baseInput({
				ports: {
					checkEvidence: () => {
						throw new Error("disk gone");
					},
				},
			}),
		);
		expect(thrown.ok).toBe(false);
		expect(thrown.invalid.some((entry) => entry.message.includes("disk gone"))).toBe(true);
	});

	it("treats B3 pre-validation failures, timeouts, and aborts as incomplete retries", () => {
		for (const code of ["AUDIT_EVIDENCE_MISSING", "AUDIT_TIMEOUT", "AUDIT_ABORTED"]) {
			const result = aggregate(
				baseInput({
					submissions: [
						submission("CASE-01", {
							validation: { ok: false, errors: [{ code, message: `${code} from B3` }] },
						}),
						submission("CASE-02"),
					],
				}),
			);
			expect(result.ok).toBe(false);
			expect(result.verdict).toBe("INCOMPLETE");
			expect(result.retryRequired).toBe(true);
			expect(result.repairSpec).toBeNull();
			expect(codesOf(result)).toContain(`:${code}`);
		}
	});

	it("voids the batch when the snapshot changed or is unusable", () => {
		const mutated = aggregate(
			baseInput({
				snapshotAfter: { ...SNAPSHOT, files: [{ ...SNAPSHOT.files[0], sha256: hash("f") }] },
			}),
		);
		expect(mutated.ok).toBe(false);
		expect(mutated.workspaceMutated).toBe(true);
		expect(codesOf(mutated)).toContain(":AUDIT_WORKSPACE_MUTATED");

		const missing = aggregate(baseInput({ snapshotBefore: undefined }));
		expect(missing.ok).toBe(false);
		expect(missing.snapshotChecked).toBe(false);

		const digestOnly = aggregate(
			baseInput({ snapshotBefore: { digest: "digest-only" }, snapshotAfter: { digest: "digest-only" } }),
		);
		expect(digestOnly.ok).toBe(false);
	});

	it("compares file snapshots without depending on order and ignores digest-only shape", () => {
		const before = {
			files: [
				{ path: "src/a.mjs", sha256: hash("1"), stamp: { size: 1n } },
				{ path: "src/b.mjs", sha256: hash("2"), stamp: { size: 2n } },
			],
		};
		const after = {
			files: [
				{ path: "src/b.mjs", sha256: hash("2"), stamp: { size: 2n } },
				{ path: "src/a.mjs", sha256: hash("1"), stamp: { size: 1n } },
			],
		};
		expect(aggregate(baseInput({ snapshotBefore: before, snapshotAfter: after })).ok).toBe(true);
	});

	it("requires the injected T2 verification port and propagates its refusal", () => {
		const noPort = aggregate(baseInput({ ports: { verifyContract: undefined } }));
		expect(noPort.ok).toBe(false);
		expect(noPort.invalid.some((entry) => entry.field === "contract.verification")).toBe(true);

		const refused = aggregate(
			baseInput({
				ports: { verifyContract: () => ({ ok: false, message: "s2 hash differs from mission.edn" }) },
			}),
		);
		expect(refused.ok).toBe(false);
		expect(codesOf(refused)).toContain(":CONTRACT_HASH_MISMATCH");
	});

	it("rejects invalid specs and malformed submissions without throwing", () => {
		const badThreshold = aggregate(
			baseInput({
				caseSpecs: [
					{
						case_id: "CASE-01",
						threshold: Number.NaN,
						path: "正常",
						steps: ["Exercise it."],
						expected: "It is observable.",
						rubric: "score it",
					},
				],
			}),
		);
		expect(badThreshold.ok).toBe(false);
		expect(badThreshold.rows).toEqual([]);

		const empty = aggregate(baseInput({ caseSpecs: [], submissions: [] }));
		expect(empty.ok).toBe(false);
		expect(empty.rows).toEqual([]);

		const legacy = aggregate(baseInput({ caseSpecs: [{ id: "CASE-01", threshold: 80, path: "正常" }] }));
		expect(legacy.ok).toBe(false);
		expect(legacy.invalid.some((entry) => Array.isArray(entry.unknown) && entry.unknown.includes("id"))).toBe(true);

		const duplicateSpecs = aggregate(
			baseInput({
				caseSpecs: [
					{
						case_id: "CASE-01",
						threshold: 80,
						path: "正常",
						steps: ["Exercise it."],
						expected: "It is observable.",
						rubric: "score it",
					},
					{
						case_id: "CASE-01",
						threshold: 80,
						path: "正常",
						steps: ["Exercise it."],
						expected: "It is observable.",
						rubric: "score it",
					},
				],
			}),
		);
		expect(duplicateSpecs.ok).toBe(false);

		const malformed = aggregate(
			baseInput({
				submissions: [
					null,
					[],
					"score",
					{ case_id: "  " },
					{ case_id: 7 },
					submission("CASE-01"),
					submission("CASE-02"),
				],
			}),
		);
		expect(malformed.ok).toBe(false);
		expect(malformed.invalid.filter((entry) => entry.code === ":INVALID_ARGUMENT")).toHaveLength(5);
		expect(malformed.rows.every((row) => row.passed)).toBe(true);
	});

	it("returns INCOMPLETE for a completely empty call instead of throwing", () => {
		const result = aggregate();
		expect(result.ok).toBe(false);
		expect(result.verdict).toBe("INCOMPLETE");
		expect(result.repairSpec).toBeNull();
	});
});

describe("writeS5Report", () => {
	it("writes the report, rechecks it, then sends only the compact audit evidence to the approval port", async () => {
		await withTempRoot(async (root) => {
			const result = aggregate(baseInput());
			const order = [];
			let observedRecheck = null;
			let observedApproval = null;
			const outcome = await writeS5Report(root, "demo", result, {
				recheckPort: ({ reportPath, reportSha256, snapshotBefore }) => {
					const markdown = readFileSync(reportPath, "utf8");
					const fileSha = createHash("sha256").update(markdown, "utf8").digest("hex");
					observedRecheck = { fileSha, reportSha256, snapshotBefore };
					order.push("recheck");
					return fileSha === reportSha256
						? { ok: true, snapshotDigest: "digest-after-report" }
						: { ok: false, code: ":AUDIT_WORKSPACE_MUTATED", message: "report bytes changed" };
				},
				approvalPort: {
					issue: (missionId, revision, reportSha256, evidence) => {
						order.push("approval");
						observedApproval = { missionId, revision, reportSha256, evidence };
						return boundApproval(missionId, revision, reportSha256);
					},
				},
			});

			expect(outcome.ok).toBe(true);
			expect(outcome.completed).toBe(false);
			expect(order).toEqual(["recheck", "approval"]);
			expect(observedRecheck.fileSha).toBe(observedRecheck.reportSha256);
			expect(observedRecheck.snapshotBefore).toEqual(result.snapshotBefore);
			expect(observedApproval.missionId).toBe(CONTRACT.missionId);
			expect(observedApproval.revision).toBe(CONTRACT.revision);
			expect(observedApproval.reportSha256).toBe(outcome.sha256);
			expect(observedApproval.evidence).toMatchObject({
				verdict: "PASS",
				caseCount: 2,
				recheck: {
					ok: true,
					missionId: CONTRACT.missionId,
					revision: CONTRACT.revision,
					reportSha256: outcome.sha256,
					snapshotDigest: "digest-after-report",
				},
			});

			const file = join(root, "plans", "demo", "s5-report.md");
			const markdown = readFileSync(file, "utf8");
			expect(markdown).toBe(outcome.markdown);
			expect(markdown).toContain(CONTRACT.contractLine);
			expect(markdown).toContain("| CASE-01 | 正常 | 90 | 80 | 80 | 80 | PASS |");
			expect(markdown).toContain("| CASE-02 | 错误 | 70 | 95 | 70 | 70 | PASS |");
			expect(markdown).toContain("## 证据路径");
			expect(markdown).toContain("## 审计员报告");
			expect(markdown).toContain("## 限制与教训");
			expect(outcome.sha256).toBe(createHash("sha256").update(markdown, "utf8").digest("hex"));
		});
	});

	it("fails closed when the mandatory recheck port is missing", async () => {
		await withTempRoot(async (root) => {
			const result = aggregate(baseInput());
			const approvalCalls = [];
			const outcome = await writeS5Report(root, "demo", result, {
				approvalPort: {
					issue: (...args) => {
						approvalCalls.push(args);
						return boundApproval(...args);
					},
				},
			});

			expect(outcome.ok).toBe(false);
			expect(outcome.code).toBe(":INVALID_ARGUMENT");
			expect(outcome.errors[0].field).toBe("recheckPort");
			expect(outcome.approval).toBeNull();
			expect(approvalCalls).toHaveLength(0);
			expect(existsSync(outcome.path)).toBe(true);
		});
	});

	it("fails closed when the post-report recheck fails or throws", async () => {
		await withTempRoot(async (root) => {
			const result = aggregate(baseInput());
			const approvalCalls = [];
			const failed = await writeS5Report(root, "demo", result, {
				recheckPort: () => ({
					ok: false,
					code: ":AUDIT_WORKSPACE_MUTATED",
					message: "workspace changed after the report was written",
				}),
				approvalPort: {
					issue: (...args) => {
						approvalCalls.push(args);
						return boundApproval(...args);
					},
				},
			});
			expect(failed.ok).toBe(false);
			expect(failed.code).toBe(":AUDIT_WORKSPACE_MUTATED");
			expect(failed.errors[0].message).toBe("workspace changed after the report was written");
			expect(failed.approval).toBeNull();
			expect(approvalCalls).toHaveLength(0);

			const thrown = await writeS5Report(root, "demo", result, {
				recheckPort: () => {
					throw new Error("snapshot unavailable");
				},
				approvalPort: {
					issue: (...args) => {
						approvalCalls.push(args);
						return boundApproval(...args);
					},
				},
			});
			expect(thrown.ok).toBe(false);
			expect(thrown.code).toBe(":APPROVAL_REQUIRED");
			expect(thrown.errors[0].message).toContain("snapshot unavailable");
			expect(approvalCalls).toHaveLength(0);
		});
	});

	it("writes the report but does not approve when no ApprovalPort is injected", async () => {
		await withTempRoot(async (root) => {
			const result = aggregate(baseInput());
			const outcome = await writeS5Report(root, "demo", result, { recheckPort: okRecheck });

			expect(outcome.ok).toBe(false);
			expect(outcome.code).toBe(":APPROVAL_REQUIRED");
			expect(outcome.approval).toBeNull();
			expect(existsSync(outcome.path)).toBe(true);
		});
	});

	it("propagates an ApprovalPort refusal and keeps the report on disk", async () => {
		await withTempRoot(async (root) => {
			const result = aggregate(baseInput());
			const outcome = await writeS5Report(root, "demo", result, {
				recheckPort: okRecheck,
				approvalPort: { issue: () => ({ ok: false, code: ":STAGE_MISMATCH", message: "stale revision" }) },
			});

			expect(outcome.ok).toBe(false);
			expect(outcome.code).toBe(":STAGE_MISMATCH");
			expect(outcome.errors[0].message).toBe("stale revision");
			expect(outcome.approval).toBeNull();
			expect(existsSync(outcome.path)).toBe(true);
		});
	});

	it("rejects an approval without a token", async () => {
		await withTempRoot(async (root) => {
			const result = aggregate(baseInput());
			const outcome = await writeS5Report(root, "demo", result, {
				recheckPort: okRecheck,
				approvalPort: { issue: () => ({ ok: true, approval: {} }) },
			});

			expect(outcome.ok).toBe(false);
			expect(outcome.code).toBe(":APPROVAL_REQUIRED");
			expect(outcome.approval).toBeNull();
		});
	});

	it("refuses a non-PASS result before writing anything", async () => {
		await withTempRoot(async (root) => {
			const result = aggregate(
				baseInput({
					submissions: [submission("CASE-01", { user_score: 10, developer_score: 10 }), submission("CASE-02")],
				}),
			);
			const outcome = await writeS5Report(root, "demo", result, { recheckPort: okRecheck });

			expect(outcome.ok).toBe(false);
			expect(outcome.code).toBe(":APPROVAL_REQUIRED");
			expect(existsSync(join(root, "plans", "demo", "s5-report.md"))).toBe(false);
		});
	});

	it("rejects an unsafe slug before writing anything", async () => {
		await withTempRoot(async (root) => {
			const result = aggregate(baseInput());
			const outcome = await writeS5Report(root, "../escape", result, {});

			expect(outcome.ok).toBe(false);
			expect(outcome.errors[0].code).toBe(":INVALID_ARGUMENT");
			expect(existsSync(join(root, "escape", "s5-report.md"))).toBe(false);
			expect(existsSync(join(root, "plans", "s5-report.md"))).toBe(false);
		});
	});
});
