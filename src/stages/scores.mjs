/**
 * Aggregate K independent CASE audits into one mission verdict.
 *
 * `aggregate` is a pure reconciliation step: it never reads or writes files.
 * The submitted CASE records from `.herd/missions/<slug>/s2-cases.edn` are the
 * only authority for ids, order, and thresholds. Each record is
 * `{case_id,path,threshold,steps,expected,rubric}`; this module validates the
 * fields it consumes. Every submission is matched exactly once; missing,
 * unknown, duplicate, non-finite, out-of-range, empty-report, evidence, and
 * snapshot problems are reported together instead of thrown.
 *
 * The contract carries only `{missionId, revision}`. There is no contract-line
 * and no frozen-hash recheck: approval binds to the mission id and revision.
 *
 * `writeS5Report` is the only file-writing step. It writes
 * `plans/<slug>/s5-report.md` only for a clean PASS, computes the report
 * sha256, and asks the injected ApprovalPort to issue the one-time
 * `(missionId, revision)` approval. It never writes `mission.edn`, never
 * generates an approval token, and never returns `completed: true`; marking
 * the mission complete stays with the caller and the approval owner.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFileAtomic } from "../util/atomic-write.mjs";
import { ERROR_CODES, messageOf } from "../util/errors.mjs";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CASE_ID_PATTERN = /^CASE-[A-Za-z0-9_-]+$/;
const CASE_SPEC_FIELDS = new Set(["case_id", "path", "threshold", "steps", "expected", "rubric"]);
const APPROVAL_REQUIRED = ":APPROVAL_REQUIRED";
const REPORT_FILE = "s5-report.md";

function describe(value) {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
	if (typeof value === "bigint") return `${value}N`;
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function isPlainObject(value) {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function rejection(code, message, data = {}) {
	const name = code.startsWith(":") ? code.slice(1) : code;
	const keyword = ERROR_CODES[name] ?? ERROR_CODES.INVALID_ARGUMENT;
	const result = { code: keyword, message, ...data };
	if (keyword === ERROR_CODES.INVALID_ARGUMENT && name !== "INVALID_ARGUMENT") {
		result.reportedCode = code;
	}
	return result;
}

function detailOf(value) {
	if (!isPlainObject(value)) return "";
	if (typeof value.message !== "string" || value.message.trim() === "") return "";
	return `: ${value.message}`;
}

function validateCaseSpecs(caseSpecs, invalid) {
	const problems = [];
	if (!Array.isArray(caseSpecs)) {
		problems.push(
			rejection("INVALID_ARGUMENT", `caseSpecs must be an array, got ${describe(caseSpecs)}`, {
				field: "caseSpecs",
			}),
		);
		invalid.push(...problems);
		return null;
	}
	if (caseSpecs.length === 0) {
		problems.push(rejection("INVALID_ARGUMENT", "caseSpecs must contain at least one CASE", { field: "caseSpecs" }));
		invalid.push(...problems);
		return null;
	}

	const specs = [];
	const seen = new Set();
	for (let index = 0; index < caseSpecs.length; index += 1) {
		const raw = caseSpecs[index];
		if (!isPlainObject(raw)) {
			problems.push(
				rejection("INVALID_ARGUMENT", `caseSpecs[${index}] must be an object, got ${describe(raw)}`, {
					field: "caseSpecs",
					index,
				}),
			);
			continue;
		}
		const unknown = Object.keys(raw).filter((key) => !CASE_SPEC_FIELDS.has(key));
		if (unknown.length > 0) {
			problems.push(
				rejection("INVALID_ARGUMENT", `caseSpecs[${index}] has unknown fields: ${unknown.join(", ")}`, {
					field: "caseSpecs",
					index,
					unknown,
				}),
			);
			continue;
		}
		const id = raw.case_id;
		if (typeof id !== "string" || !CASE_ID_PATTERN.test(id)) {
			problems.push(
				rejection("INVALID_ARGUMENT", `caseSpecs[${index}].case_id must match ${CASE_ID_PATTERN}`, {
					field: "caseSpecs.case_id",
					index,
					actual: describe(id),
				}),
			);
			continue;
		}
		if (seen.has(id)) {
			problems.push(
				rejection("INVALID_ARGUMENT", `caseSpecs contains duplicate CASE id ${id}`, {
					field: "caseSpecs.case_id",
					index,
					caseId: id,
				}),
			);
			continue;
		}
		seen.add(id);
		const threshold = raw.threshold;
		if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
			problems.push(
				rejection("INVALID_ARGUMENT", `${id}: threshold ${describe(threshold)} must be a finite number in 0..100`, {
					field: "caseSpecs.threshold",
					index,
					caseId: id,
					actual: describe(threshold),
				}),
			);
			continue;
		}
		const path = raw.path;
		if (typeof path !== "string" || path.trim() === "") {
			problems.push(
				rejection("INVALID_ARGUMENT", `${id}: path must be a non-empty string`, {
					field: "caseSpecs.path",
					index,
					caseId: id,
					actual: describe(path),
				}),
			);
			continue;
		}
		specs.push({ case_id: id, threshold, path: path.trim() });
	}

	if (problems.length > 0) {
		invalid.push(...problems);
		return null;
	}
	return specs;
}

function validateContract(contract, invalid) {
	if (!isPlainObject(contract)) {
		invalid.push(
			rejection("INVALID_ARGUMENT", `contract must be an object, got ${describe(contract)}`, {
				field: "contract",
			}),
		);
		return null;
	}

	const problems = [];
	if (typeof contract.missionId !== "string" || contract.missionId.trim() === "") {
		problems.push(
			rejection("INVALID_ARGUMENT", "contract.missionId must be a non-empty string", {
				field: "contract.missionId",
				actual: describe(contract.missionId),
			}),
		);
	}
	if (!Number.isInteger(contract.revision) || contract.revision < 0) {
		problems.push(
			rejection("INVALID_ARGUMENT", `contract.revision ${describe(contract.revision)} must be an integer >= 0`, {
				field: "contract.revision",
				actual: describe(contract.revision),
			}),
		);
	}
	if (problems.length > 0) {
		invalid.push(...problems);
		return null;
	}
	return {
		missionId: contract.missionId,
		revision: contract.revision,
	};
}

function normalizeAudit(audit, contract, invalid) {
	const source = isPlainObject(audit) ? audit : {};
	if (audit !== undefined && !isPlainObject(audit)) {
		invalid.push(rejection("INVALID_ARGUMENT", `audit must be an object, got ${describe(audit)}`, { field: "audit" }));
	}
	const contractEnvironment =
		isPlainObject(contract) && typeof contract.environment === "string" ? contract.environment.trim() : "";
	const environment = typeof source.environment === "string" ? source.environment.trim() : contractEnvironment;
	if (environment === "") {
		invalid.push(
			rejection("INVALID_ARGUMENT", "audit.environment must be a non-empty string (or contract.environment)", {
				field: "audit.environment",
				actual: describe(audit?.environment),
			}),
		);
	}
	return {
		environment,
		limitations: textOf(source.limitations),
		lessons: textOf(source.lessons),
	};
}

function textOf(value) {
	if (typeof value === "string") return value.trim();
	if (Array.isArray(value)) {
		return value
			.filter((item) => typeof item === "string" && item.trim() !== "")
			.map((item) => item.trim())
			.join("\n");
	}
	return "";
}

function canonicalValue(value, seen = new Set()) {
	if (typeof value === "bigint") return `${value}N`;
	if (Array.isArray(value)) {
		if (seen.has(value)) return "[cycle]";
		seen.add(value);
		const result = value.map((item) => canonicalValue(item, seen));
		seen.delete(value);
		return result;
	}
	if (isPlainObject(value)) {
		if (seen.has(value)) return "[cycle]";
		seen.add(value);
		const result = {};
		for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key], seen);
		seen.delete(value);
		return result;
	}
	if (value === undefined) return null;
	return value;
}

function canonicalSnapshot(snapshot) {
	if (!isPlainObject(snapshot)) return null;
	if (!Array.isArray(snapshot.files) || snapshot.files.length === 0) return null;
	const digest = typeof snapshot.digest === "string" ? snapshot.digest : "";

	const files = [];
	for (const file of snapshot.files) {
		if (
			!isPlainObject(file) ||
			typeof file.path !== "string" ||
			file.path === "" ||
			typeof file.sha256 !== "string" ||
			file.sha256 === ""
		) {
			return null;
		}
		files.push({ path: file.path, sha256: file.sha256, stamp: canonicalValue(file.stamp) });
	}
	files.sort((left, right) => {
		if (left.path !== right.path) return left.path < right.path ? -1 : 1;
		if (left.sha256 !== right.sha256) return left.sha256 < right.sha256 ? -1 : 1;
		return 0;
	});
	return `digest:${digest}|files:${JSON.stringify(files)}`;
}

function cloneValue(value) {
	try {
		return structuredClone(value);
	} catch {
		return value;
	}
}

function compareSnapshots(snapshotBefore, snapshotAfter, invalid) {
	const before = canonicalSnapshot(snapshotBefore);
	const after = canonicalSnapshot(snapshotAfter);
	if (before === null) {
		invalid.push(
			rejection("INVALID_ARGUMENT", `snapshotBefore is not a usable snapshot: ${describe(snapshotBefore)}`, {
				field: "snapshotBefore",
			}),
		);
	}
	if (after === null) {
		invalid.push(
			rejection("INVALID_ARGUMENT", `snapshotAfter is not a usable snapshot: ${describe(snapshotAfter)}`, {
				field: "snapshotAfter",
			}),
		);
	}
	if (before === null || after === null) {
		return {
			checked: false,
			mutated: false,
			before: before === null ? null : cloneValue(snapshotBefore),
		};
	}
	if (before !== after) {
		invalid.push(
			rejection("AUDIT_WORKSPACE_MUTATED", "the main workspace changed during the audit; the whole batch is void", {
				field: "snapshotAfter",
			}),
		);
		return { checked: true, mutated: true, before: cloneValue(snapshotBefore) };
	}
	return { checked: true, mutated: false, before: cloneValue(snapshotBefore) };
}

function readScore(caseId, field, value, invalid) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		invalid.push(
			rejection("AUDIT_INVALID_SCORE", `${caseId}: ${field} ${describe(value)} is not a finite number`, {
				caseId,
				field,
				actual: describe(value),
			}),
		);
		return null;
	}
	if (value < 0 || value > 100) {
		invalid.push(
			rejection("AUDIT_INVALID_SCORE", `${caseId}: ${field} ${value} is outside 0..100`, {
				caseId,
				field,
				actual: value,
			}),
		);
		return null;
	}
	return value;
}

function readValidation(caseId, index, value, invalid) {
	if (value === undefined) return { valid: false, provided: false };
	if (!isPlainObject(value) || typeof value.ok !== "boolean") {
		invalid.push(
			rejection("INVALID_ARGUMENT", `${caseId}: validation must be an object with a boolean ok`, {
				caseId,
				field: "validation",
				index,
				actual: describe(value),
			}),
		);
		return { valid: false, provided: true };
	}
	if (value.ok === true) return { valid: true, provided: true };

	const errors = Array.isArray(value.errors) ? value.errors : [];
	if (errors.length === 0) {
		invalid.push(
			rejection("INVALID_ARGUMENT", `${caseId}: pre-validation marked this submission invalid without an error`, {
				caseId,
				field: "validation",
				index,
			}),
		);
		return { valid: false, provided: true };
	}
	for (let errorIndex = 0; errorIndex < errors.length; errorIndex += 1) {
		const error = errors[errorIndex];
		if (isPlainObject(error) && typeof error.code === "string" && error.code.trim() !== "") {
			invalid.push(
				rejection(
					error.code,
					typeof error.message === "string" && error.message.trim() !== ""
						? error.message
						: `${caseId}: pre-validation failed`,
					{
						caseId,
						field: typeof error.field === "string" ? error.field : "validation",
						index,
						errorIndex,
					},
				),
			);
		} else {
			invalid.push(
				rejection("INVALID_ARGUMENT", `${caseId}: pre-validation error ${errorIndex} has no usable code`, {
					caseId,
					field: "validation",
					index,
					errorIndex,
				}),
			);
		}
	}
	return { valid: false, provided: true };
}

function readEvidence(caseId, value, invalid, checkEvidence) {
	if (!Array.isArray(value) || value.length === 0) {
		invalid.push(
			rejection("AUDIT_EVIDENCE_MISSING", `${caseId}: evidence_paths must be a non-empty array`, {
				caseId,
				field: "evidence_paths",
				actual: describe(value),
			}),
		);
		return null;
	}

	const paths = [];
	for (let index = 0; index < value.length; index += 1) {
		const path = value[index];
		if (typeof path !== "string" || path.trim() === "") {
			invalid.push(
				rejection("AUDIT_EVIDENCE_MISSING", `${caseId}: evidence_paths[${index}] must be a non-empty string`, {
					caseId,
					field: "evidence_paths",
					index,
					actual: describe(path),
				}),
			);
			continue;
		}
		paths.push(path);
	}
	if (paths.length !== value.length || paths.length === 0) return null;

	if (typeof checkEvidence === "function") {
		try {
			const checked = checkEvidence({ caseId, paths });
			if (checked?.ok !== true) {
				invalid.push(
					rejection("AUDIT_EVIDENCE_MISSING", `${caseId}: evidence paths were rejected${detailOf(checked)}`, {
						caseId,
						field: "evidence_paths",
						missing: isPlainObject(checked) && Array.isArray(checked.missing) ? checked.missing : [],
						outside: isPlainObject(checked) && Array.isArray(checked.outside) ? checked.outside : [],
					}),
				);
				return null;
			}
		} catch (error) {
			invalid.push(
				rejection("AUDIT_EVIDENCE_MISSING", `${caseId}: evidence check failed: ${messageOf(error)}`, {
					caseId,
					field: "evidence_paths",
				}),
			);
			return null;
		}
	}

	return paths;
}

function emptyRow(spec) {
	return {
		caseId: spec.case_id,
		path: spec.path,
		threshold: spec.threshold,
		userScore: null,
		developerScore: null,
		score: null,
		valid: false,
		passed: false,
		evidencePaths: [],
		reportMarkdown: null,
	};
}

function repairIdFor(contractInfo, failedCases) {
	const missionId = contractInfo === null ? "unknown" : contractInfo.missionId;
	const revision = contractInfo === null ? 0 : contractInfo.revision + 1;
	const digest = createHash("sha256")
		.update(`${missionId}:${revision}:${failedCases.join(",")}`, "utf8")
		.digest("hex");
	return `repair-${digest.slice(0, 16)}`;
}

function deriveRepairSpec(rows, invalid, contractInfo) {
	const defectsByCase = new Map();
	for (const entry of invalid) {
		if (typeof entry.caseId !== "string") continue;
		const defects = defectsByCase.get(entry.caseId);
		if (defects) defects.push(entry.message);
		else defectsByCase.set(entry.caseId, [entry.message]);
	}

	const failed = [];
	for (const row of rows) {
		// Only a valid submission that misses its threshold is a code-repair
		// target. Missing, duplicate, malformed, timed-out, or contaminated
		// audits are retries, not repairs.
		if (!row.valid || row.passed) continue;
		const defects = [...(defectsByCase.get(row.caseId) ?? [])];
		if (row.userScore < row.threshold) {
			defects.push(`user_score ${row.userScore} is below threshold ${row.threshold}`);
		}
		if (row.developerScore < row.threshold) {
			defects.push(`developer_score ${row.developerScore} is below threshold ${row.threshold}`);
		}
		failed.push({
			case_id: row.caseId,
			path: row.path,
			threshold: row.threshold,
			user_score: row.userScore,
			developer_score: row.developerScore,
			final: row.score,
			evidence_paths: row.evidencePaths,
			defects: [...new Set(defects)],
		});
	}

	if (failed.length === 0) return null;
	const failedCases = failed.map((entry) => entry.case_id);
	const inputs = [];
	for (const entry of failed) {
		for (const path of entry.evidence_paths) {
			if (!inputs.includes(path)) inputs.push(path);
		}
	}
	if (inputs.length === 0) inputs.push(...failedCases.map((caseId) => `case:${caseId}`));
	return {
		repair_id: repairIdFor(contractInfo, failedCases),
		failed_cases: failedCases,
		goal: `修复未达标 CASE 并重新审计：${failedCases.join(", ")}`,
		inputs,
		done_when: "每个 failed_cases 的 min(user_score, developer_score) 达到其 PASS threshold，且重新审计通过",
		mapped_cases: failedCases,
		revision: contractInfo === null ? null : contractInfo.revision,
		next_revision: contractInfo === null ? null : contractInfo.revision + 1,
		cases: failed,
	};
}

function buildResult({ rows, missing, unknown, duplicates, invalid, contractInfo, auditInfo, snapshot }) {
	const rejected =
		invalid.length > 0 ||
		missing.length > 0 ||
		unknown.length > 0 ||
		duplicates.length > 0 ||
		snapshot.mutated ||
		!snapshot.checked;
	const allPassed = rows.length > 0 && rows.every((row) => row.passed);
	const verdict = rejected ? "INCOMPLETE" : allPassed ? "PASS" : "FAIL";

	return {
		ok: verdict === "PASS",
		verdict,
		contract: contractInfo === null ? null : { ...contractInfo },
		audit: auditInfo,
		rows,
		caseIds: rows.map((row) => row.caseId),
		missing,
		unknown,
		duplicates,
		invalid,
		workspaceMutated: snapshot.mutated,
		snapshotChecked: snapshot.checked,
		snapshotBefore: snapshot.before,
		rejected,
		repairSpec: deriveRepairSpec(rows, invalid, contractInfo),
		retryRequired: rejected,
	};
}

/**
 * Reconcile every S2 CASE with exactly one auditor submission.
 *
 * Inputs:
 * - `caseSpecs`: validated CASE records
 *   `{case_id,path,threshold,steps,expected,rubric}` in
 *   `.herd/missions/<slug>/s2-cases.edn` order. That order is the order of
 *   `rows`, `caseIds`, and the sections of the final report.
 * - `submissions`: raw auditor fields
 *   `{case_id, user_score, developer_score, report_markdown, evidence_paths}`;
 *   an optional `validation: {ok, errors?}` carries B3's single-submission
 *   result, so a failed evidence or snapshot check can never be masked by
 *   high scores.
 * - `contract`: `{missionId, revision}`. Exactly these two fields bind the
 *   final approval; there is no contract-line and no frozen hash to recheck.
 * - `snapshotBefore` / `snapshotAfter`: `{files: [{path, sha256, stamp}], digest?}`
 *   with a non-empty `files` list. Both are required for a clean PASS.
 * - `audit`: `{environment, limitations?, lessons?}` for the final report;
 *   `environment` may instead live on `contract.environment`, but a clean
 *   PASS requires one of them.
 * - `ports.checkEvidence({caseId, paths})`: optional synchronous evidence
 *   existence/containment check. B3's `validation` field remains authoritative.
 *   A `ports.verifyContract` value is ignored: contract hashes are gone.
 *
 * Output: `{ok, verdict, contract, audit, rows, missing, unknown, duplicates,
 * invalid, workspaceMutated, snapshotChecked, snapshotBefore, rejected,
 * repairSpec, retryRequired, caseIds}`. `snapshotBefore` is a deep copy of the
 * audit-time snapshot, so a later recheck port can compare the current
 * workspace without observing a caller-mutated object.
 *
 * `verdict` is `PASS` only when the CASE set is complete and exact, every
 * score is finite and in 0..100, every report and evidence list is non-empty,
 * both snapshots match, and every `min(user_score, developer_score)` reaches
 * its S2 threshold. A score-only miss yields `FAIL` with a `RepairSpec`; any
 * reconciliation or contamination problem yields `INCOMPLETE` and must be
 * retried. Malformed input never throws.
 */
export function aggregate({ caseSpecs, submissions, contract, snapshotBefore, snapshotAfter, audit, ports } = {}) {
	const invalid = [];
	const missing = [];
	const unknown = [];
	const duplicates = [];
	const rows = [];
	const portSet = isPlainObject(ports) ? ports : {};

	const specs = validateCaseSpecs(caseSpecs, invalid);
	const contractInfo = validateContract(contract, invalid);
	const auditInfo = normalizeAudit(audit, contract, invalid);
	const snapshot = compareSnapshots(snapshotBefore, snapshotAfter, invalid);

	if (specs === null) {
		return buildResult({
			rows,
			missing,
			unknown,
			duplicates,
			invalid,
			contractInfo,
			auditInfo,
			snapshot,
		});
	}

	const specById = new Map(specs.map((spec) => [spec.case_id, spec]));
	const byCase = new Map();
	if (!Array.isArray(submissions)) {
		invalid.push(
			rejection("INVALID_ARGUMENT", `submissions must be an array, got ${describe(submissions)}`, {
				field: "submissions",
			}),
		);
	} else {
		for (let index = 0; index < submissions.length; index += 1) {
			const raw = submissions[index];
			if (!isPlainObject(raw)) {
				invalid.push(
					rejection("INVALID_ARGUMENT", `submissions[${index}] is not an object: ${describe(raw)}`, {
						field: "submissions",
						index,
					}),
				);
				continue;
			}
			const caseId = typeof raw.case_id === "string" ? raw.case_id.trim() : "";
			if (caseId === "") {
				invalid.push(
					rejection("INVALID_ARGUMENT", `submissions[${index}].case_id must be a non-empty string`, {
						field: "case_id",
						index,
						actual: describe(raw.case_id),
					}),
				);
				continue;
			}
			if (!specById.has(caseId)) {
				if (!unknown.includes(caseId)) unknown.push(caseId);
				invalid.push(
					rejection("AUDIT_UNKNOWN_CASE", `${caseId}: no such CASE in the S2 dataset`, {
						caseId,
						index,
					}),
				);
				continue;
			}
			const list = byCase.get(caseId);
			if (list) list.push({ index, entry: raw });
			else byCase.set(caseId, [{ index, entry: raw }]);
		}
	}

	const checkEvidence = typeof portSet.checkEvidence === "function" ? portSet.checkEvidence : null;

	for (const spec of specs) {
		const entries = byCase.get(spec.case_id) ?? [];
		if (entries.length === 0) {
			missing.push(spec.case_id);
			invalid.push(
				rejection("AUDIT_MISSING", `${spec.case_id}: no audit submission was collected`, {
					caseId: spec.case_id,
				}),
			);
			rows.push(emptyRow(spec));
			continue;
		}
		if (entries.length > 1) {
			duplicates.push(spec.case_id);
			invalid.push(
				rejection(
					"AUDIT_DUPLICATE_CASE",
					`${spec.case_id}: ${entries.length} audit submissions were provided; exactly one is allowed`,
					{ caseId: spec.case_id, count: entries.length },
				),
			);
			rows.push(emptyRow(spec));
			continue;
		}

		const { index, entry } = entries[0];
		const validation = readValidation(spec.case_id, index, entry.validation, invalid);
		const userScore = readScore(spec.case_id, "user_score", entry.user_score, invalid);
		const developerScore = readScore(spec.case_id, "developer_score", entry.developer_score, invalid);
		const reportMarkdown = typeof entry.report_markdown === "string" ? entry.report_markdown : "";
		if (reportMarkdown.trim() === "") {
			invalid.push(
				rejection("AUDIT_EVIDENCE_MISSING", `${spec.case_id}: report_markdown must be a non-empty string`, {
					caseId: spec.case_id,
					field: "report_markdown",
					index,
					actual: describe(entry.report_markdown),
				}),
			);
		}
		const evidencePaths = readEvidence(spec.case_id, entry.evidence_paths, invalid, checkEvidence);
		if (validation.provided === false && checkEvidence === null) {
			invalid.push(
				rejection(
					"AUDIT_EVIDENCE_MISSING",
					`${spec.case_id}: evidence_paths were not validated by B3 or a checkEvidence port`,
					{ caseId: spec.case_id, field: "validation", index },
				),
			);
		}
		const evidenceValidated =
			validation.valid || (validation.provided === false && checkEvidence !== null && evidencePaths !== null);
		const valid =
			evidenceValidated &&
			userScore !== null &&
			developerScore !== null &&
			reportMarkdown.trim() !== "" &&
			evidencePaths !== null;
		const score = userScore !== null && developerScore !== null ? Math.min(userScore, developerScore) : null;

		rows.push({
			caseId: spec.case_id,
			path: spec.path,
			threshold: spec.threshold,
			userScore,
			developerScore,
			score,
			valid,
			passed: valid && score >= spec.threshold,
			evidencePaths: evidencePaths ?? [],
			reportMarkdown: reportMarkdown === "" ? null : reportMarkdown,
		});
	}

	return buildResult({
		rows,
		missing,
		unknown,
		duplicates,
		invalid,
		contractInfo,
		auditInfo,
		snapshot,
	});
}

function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function cell(value) {
	return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function trimTrailing(value) {
	return typeof value === "string" ? value.replace(/\s+$/u, "") : "";
}

function composeReport(result, slug) {
	const { contract, audit, rows } = result;
	const limitations = typeof audit.limitations === "string" && audit.limitations !== "" ? audit.limitations : "无记录";
	const lessons = typeof audit.lessons === "string" && audit.lessons !== "" ? audit.lessons : "无记录";
	const lines = [
		`# S5 手工验收报告：${contract.missionId}`,
		"",
		`- 用例集：\`.herd/missions/${slug}/s2-cases.edn\``,
		`- 使命：${contract.missionId}`,
		`- 修订：${contract.revision}`,
		`- 审计环境：${audit.environment}`,
		"- 总判定：PASS",
		"",
		"## 逐 CASE 得分",
		"",
		"| CASE | 路径 | user_score | developer_score | final | threshold | 结果 |",
		"|---|---|---|---|---|---|---|",
	];

	for (const row of rows) {
		lines.push(
			`| ${cell(row.caseId)} | ${cell(row.path)} | ${row.userScore} | ${row.developerScore} | ${row.score} | ${row.threshold} | ${row.passed ? "PASS" : "FAIL"} |`,
		);
	}

	lines.push("", "## 证据路径", "");
	for (const row of rows) {
		lines.push(`### ${row.caseId}`, "");
		for (const path of row.evidencePaths) lines.push(`- \`${String(path).replace(/`/g, "\\`")}\``);
		lines.push("");
	}

	lines.push("## 审计员报告", "");
	for (const row of rows) {
		lines.push(`### ${row.caseId}`, "", trimTrailing(row.reportMarkdown), "");
	}

	lines.push(
		"## 总判定",
		"",
		`PASS：${rows.length}/${rows.length} 个 CASE 的 min(user_score, developer_score) 达到或超过各自的 PASS threshold。`,
		"",
		"## 限制与教训",
		"",
		"### 限制",
		"",
		limitations,
		"",
		"### 教训",
		"",
		lessons,
	);

	return `${lines.join("\n")}\n`;
}

function isPassResult(result) {
	return (
		isPlainObject(result) &&
		result.ok === true &&
		result.verdict === "PASS" &&
		result.repairSpec === null &&
		isPlainObject(result.contract) &&
		Array.isArray(result.caseIds) &&
		result.caseIds.length > 0 &&
		Array.isArray(result.rows) &&
		result.rows.length === result.caseIds.length
	);
}

async function requestApproval(result, reportSha256, approvalPort, recheck) {
	const missionId = result.contract.missionId;
	const revision = result.contract.revision;
	if (!approvalPort || typeof approvalPort.issue !== "function") {
		return {
			ok: false,
			code: APPROVAL_REQUIRED,
			errors: [
				rejection("APPROVAL_REQUIRED", "no ApprovalPort was injected; the mission stays in progress", {
					missionId,
					revision,
				}),
			],
		};
	}
	try {
		const issued = await approvalPort.issue(missionId, revision, reportSha256, {
			verdict: "PASS",
			caseCount: result.caseIds.length,
			recheck,
		});
		if (isPlainObject(issued) && issued.ok === true && isPlainObject(issued.approval)) {
			if (typeof issued.approval.token === "string" && issued.approval.token.trim() !== "") {
				return { ok: true, approval: issued.approval };
			}
		}
		const code =
			isPlainObject(issued) && typeof issued.code === "string" && issued.code.trim() !== ""
				? issued.code
				: APPROVAL_REQUIRED;
		const message =
			isPlainObject(issued) && typeof issued.message === "string" && issued.message.trim() !== ""
				? issued.message
				: "the ApprovalPort did not issue a one-time approval";
		const refusal = rejection(code, message, { missionId, revision });
		return {
			ok: false,
			code: refusal.code,
			errors: [refusal],
		};
	} catch (error) {
		return {
			ok: false,
			code: APPROVAL_REQUIRED,
			errors: [
				rejection("APPROVAL_REQUIRED", `the ApprovalPort failed: ${messageOf(error)}`, {
					missionId,
					revision,
				}),
			],
		};
	}
}

/**
 * Write the final `plans/<slug>/s5-report.md` and request the one-time approval.
 *
 * Inputs: repository root, mission slug, the result of `aggregate`, and
 * `{approvalPort, recheckPort?}`. The report lists every CASE in
 * `.herd/missions/<slug>/s2-cases.edn` order. `recheckPort` is optional: when
 * present it runs after the report is written and may reject a changed
 * workspace; it receives `{root, slug, missionId, revision, contract,
 * reportPath, reportSha256, snapshotBefore}`. It is not a contract-hash
 * recheck, because approval binds only to `(missionId, revision)`. The
 * ApprovalPort receives `(missionId, revision, reportSha256, {verdict,
 * caseCount, recheck})`; T2 owns the remaining approval checks. `completed`
 * stays false because T4 never writes mission state.
 */
export async function writeS5Report(root, slug, result, options) {
	const errors = [];
	if (typeof root !== "string" || root.trim() === "") {
		errors.push(
			rejection("INVALID_ARGUMENT", "root must be a non-empty string", {
				field: "root",
				actual: describe(root),
			}),
		);
	}
	if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
		errors.push(
			rejection("INVALID_ARGUMENT", `slug must match ${SLUG_PATTERN}`, {
				field: "slug",
				actual: describe(slug),
			}),
		);
	}
	if (!isPlainObject(result)) {
		errors.push(
			rejection("INVALID_ARGUMENT", `aggregate result must be an object, got ${describe(result)}`, {
				field: "result",
			}),
		);
	}
	if (errors.length > 0) return { ok: false, errors, completed: false };
	const settings = isPlainObject(options) ? options : {};

	if (!isPassResult(result)) {
		return {
			ok: false,
			code: APPROVAL_REQUIRED,
			errors: [rejection("APPROVAL_REQUIRED", "refusing to write s5-report.md: aggregate is not a clean PASS")],
			completed: false,
		};
	}

	const markdown = composeReport(result, slug);
	const targetDir = join(root, "plans", slug);
	let written;
	try {
		written = writeFileAtomic(targetDir, REPORT_FILE, markdown);
	} catch (error) {
		return {
			ok: false,
			code: typeof error?.code === "string" ? error.code : ERROR_CODES.INVALID_ARGUMENT,
			message: messageOf(error),
			error,
			completed: false,
		};
	}

	const reportSha256 = sha256(markdown);
	const recheckPort = settings.recheckPort;
	let recheck = null;
	if (typeof recheckPort === "function") {
		let recheckResult;
		try {
			recheckResult = await recheckPort({
				root,
				slug,
				missionId: result.contract.missionId,
				revision: result.contract.revision,
				contract: result.contract,
				reportPath: written.path,
				reportSha256,
				snapshotBefore: result.snapshotBefore,
			});
		} catch (error) {
			const refusal = rejection(
				"APPROVAL_REQUIRED",
				`post-report workspace recheck failed: ${messageOf(error)}; approval was not issued`,
				{ field: "recheck" },
			);
			return {
				ok: false,
				code: refusal.code,
				path: written.path,
				sha256: reportSha256,
				markdown,
				approval: null,
				recheck: { ok: false, message: messageOf(error) },
				errors: [refusal],
				completed: false,
			};
		}
		if (!isPlainObject(recheckResult) || recheckResult.ok !== true) {
			const code =
				isPlainObject(recheckResult) && typeof recheckResult.code === "string" && recheckResult.code.trim() !== ""
					? recheckResult.code
					: APPROVAL_REQUIRED;
			const message =
				isPlainObject(recheckResult) &&
				typeof recheckResult.message === "string" &&
				recheckResult.message.trim() !== ""
					? recheckResult.message
					: "the post-report workspace recheck did not pass; approval was not issued";
			const refusal = rejection(code, message, {
				field: "recheck",
				mismatches:
					isPlainObject(recheckResult) && Array.isArray(recheckResult.mismatches) ? recheckResult.mismatches : [],
			});
			return {
				ok: false,
				code: refusal.code,
				path: written.path,
				sha256: reportSha256,
				markdown,
				approval: null,
				recheck: recheckResult,
				errors: [refusal],
				completed: false,
			};
		}
		recheck = {
			...recheckResult,
			missionId: result.contract.missionId,
			revision: result.contract.revision,
			reportSha256,
		};
	}

	const approval = await requestApproval(result, reportSha256, settings.approvalPort, recheck);
	if (!approval.ok) {
		return {
			ok: false,
			code: approval.code ?? APPROVAL_REQUIRED,
			path: written.path,
			sha256: reportSha256,
			markdown,
			approval: null,
			recheck,
			errors: approval.errors,
			completed: false,
		};
	}

	return {
		ok: true,
		path: written.path,
		sha256: reportSha256,
		markdown,
		approval: approval.approval,
		recheck,
		errors: [],
		completed: false,
	};
}