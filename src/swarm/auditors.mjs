/**
 * K independent manual auditors for the S5 terminal audit.
 *
 * The module has four responsibilities and no others:
 *
 * 1. `snapshotWorkspace` records the protected part of the one main workspace
 *    so a later comparison can prove the auditors did not change product
 *    source, tests, configuration, documents, or `.herd` control state.
 *    Evidence, transcripts, and audit receipts are outside the protected set,
 *    because an auditor is expected to write them.
 * 2. `startAuditBatch` starts one visible `Manual Auditor` per CASE at the same
 *    time. Each auditor receives only its own CASE record and observes the
 *    main workspace read-only: there is no worktree, no temporary copy, and
 *    no second workspace. The batch never serializes the CASEs and never
 *    skips one because another is simpler.
 * 3. `validateSubmissions` performs the per-submission checks only: known CASE
 *    id, finite scores in 0..100, non-empty report, evidence paths that exist
 *    and stay inside `plans/<slug>/evidence/<case_id>/`, and an unchanged
 *    protected workspace. Cross-submission reconciliation, thresholds, the
 *    final report, and the approval belong to the caller.
 * 4. `deriveRepairSlices` turns failed audit rows into runtime repair
 *    proposals. It never edits a stage document and never collapses an audit
 *    anomaly into a code repair; a timeout or missing submission is a retry,
 *    not a defect the swarm can fix.
 *
 * The CASE records come from `.herd/missions/<slug>/s2-cases.edn`; the caller
 * parses that file and passes the array. This module never reads a stage
 * document, never hashes a dataset, and never checks a contract line.
 *
 * Every host, settings, event-bus, prompt, and submission-collection
 * dependency is injected through `deps`. This module imports no host module,
 * no sandbox module, and no scoring module, so the owners of those modules can
 * change them without creating an import cycle here.
 *
 * Submission order fixed by this module: the auditor calls
 * `submit_case_audit` exactly once with the full object, then yields only a
 * minimal completion confirmation. The full content comes from the injected
 * durable `collectSubmission`/`readSubmission` port or from the real
 * `submit_case_audit` tool input; the yield and output artifacts are never
 * treated as a submission. Every structured receipt is retained; a second one
 * is rejected instead of overwriting the first. If a timed-out or cancelled
 * runtime does not confirm exit, the whole batch is marked uncertain: no after
 * snapshot is taken and no aggregate input is produced.
 */

import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { __test as contractCodec } from "../stages/contract.mjs";
import { writeEdnAtomic } from "../util/atomic-write.mjs";
import { ERROR_CODES, herdError, messageOf, printEdn } from "../util/errors.mjs";

export const DEFAULT_AUDIT_TIMEOUT_MS = 30 * 60 * 1000;
const EXIT_CONFIRM_GRACE_MS = 250;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CASE_ID_PATTERN = /^CASE-[A-Za-z0-9_-]+$/;
const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const CASE_SPEC_FIELDS = Object.freeze(["case_id", "path", "threshold", "steps", "expected", "rubric"]);
const CASE_SPEC_FIELD_SET = new Set(CASE_SPEC_FIELDS);

/** Dependency and metadata trees ignored at any depth. */
const IGNORED_ANYWHERE = new Set([".cache", ".git", ".herd-worktrees", "node_modules"]);

/** Local state and build output ignored only at the repository root. */
const IGNORED_ROOT = new Set([".audit-tmp", ".pi", ".tmp", "build", "coverage", "dist", "tmp"]);

/**
 * The JSON schema the auditor's `submit_case_audit` tool and final yield use.
 * `startAuditBatch` narrows `case_id` to one value for each auditor.
 */
export const AUDIT_SUBMISSION_SCHEMA = Object.freeze({
	type: "object",
	additionalProperties: false,
	required: ["case_id", "user_score", "developer_score", "report_markdown", "evidence_paths"],
	properties: {
		case_id: { type: "string", minLength: 1 },
		user_score: { type: "number", minimum: 0, maximum: 100 },
		developer_score: { type: "number", minimum: 0, maximum: 100 },
		report_markdown: { type: "string", minLength: 1 },
		evidence_paths: {
			type: "array",
			minItems: 1,
			items: { type: "string", minLength: 1 },
		},
	},
});

/**
 * Strict completion schema for the auditor's final yield.
 *
 * The durable submission is `submit_case_audit`'s real payload. The yield is
 * only a completion signal: no field is required, and extra fields are allowed,
 * so a minimal `{ok:true}` is valid and the model is never asked to duplicate
 * the full audit object.
 */
export const AUDIT_CONFIRMATION_SCHEMA = Object.freeze({
	type: "object",
	additionalProperties: true,
	properties: {
		ok: { type: "boolean" },
		...AUDIT_SUBMISSION_SCHEMA.properties,
	},
});

function isPlainObject(value) {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isText(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function describe(value) {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
	if (typeof value === "bigint") return `${value}N`;
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function failure(code, message, data = {}) {
	const name = code.startsWith(":") ? code.slice(1) : code;
	const keyword = ERROR_CODES[name] ?? ERROR_CODES.INVALID_ARGUMENT;
	return { code: keyword, message, ...data };
}

function sha256Bytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function sha256Text(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function bigintText(value) {
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return null;
}

function stampOf(stats) {
	const mtimeNs = stats.mtimeNs;
	if (typeof mtimeNs === "bigint") {
		const second = 1_000_000_000n;
		const mtimeSec = mtimeNs >= 0n ? mtimeNs / second : (mtimeNs - (second - 1n)) / second;
		return {
			mtimeSec,
			mtimeNsec: mtimeNs - mtimeSec * second,
			size: stats.size,
		};
	}
	return {
		mtimeSec: BigInt(Math.trunc(Number(stats.mtimeMs) / 1000)),
		mtimeNsec: BigInt(Math.trunc((Number(stats.mtimeMs) % 1000) * 1_000_000)),
		size: BigInt(stats.size),
	};
}

/**
 * Ignore paths whose writes do not belong to the protected product surface.
 *
 * The main workspace snapshot is intentionally smaller than "every byte under
 * root". Auditors must write evidence, transcript artifacts, and audit receipts;
 * the host and other sessions may write caches. Treating those expected writes
 * as product tampering would void every audit that succeeds.
 */
function isIgnoredPath(segments, name) {
	if (IGNORED_ANYWHERE.has(name)) return true;
	if (segments.length === 1 && IGNORED_ROOT.has(name)) return true;
	if (name === ".DS_Store") return true;
	if (name.startsWith(".tmp-") || name.endsWith(".tmp")) return true;
	const text = segments.join("/");
	if (text.startsWith(".herd/artifacts/") || text === ".herd/artifacts") return true;
	if (text.startsWith(".herd/audit/") || text === ".herd/audit") return true;
	// `.herd/missions/<slug>/audit/**` and `.herd/missions/<slug>/artifacts/**`
	// are runtime-owned audit state.
	if (segments.length >= 4 && segments[0] === ".herd" && segments[1] === "missions") {
		const owned = segments[3];
		if (owned === "audit" || owned === "artifacts") return true;
	}
	if (segments[0] === "plans" && segments.length >= 3 && segments[2] === "evidence") return true;
	return false;
}

function walkSnapshot(absoluteDir, relativeDir, files, errors, seenReal) {
	let entries;
	try {
		entries = readdirSync(absoluteDir, { withFileTypes: true });
	} catch (error) {
		errors.push(
			failure("INVALID_ARGUMENT", `cannot read directory ${relativeDir || "."}: ${messageOf(error)}`, {
				path: relativeDir,
			}),
		);
		return;
	}
	entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

	for (const entry of entries) {
		const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
		const segments = relativePath.split("/").filter((segment) => segment !== "");
		if (isIgnoredPath(segments, entry.name)) continue;

		const absolutePath = join(absoluteDir, entry.name);
		if (entry.isSymbolicLink()) {
			try {
				const target = readlinkSync(absolutePath);
				const stats = lstatSync(absolutePath, { bigint: true });
				files.push({
					path: relativePath,
					kind: "symlink",
					sha256: sha256Text(`symlink\u0000${target}`),
					stamp: stampOf(stats),
				});
			} catch (error) {
				errors.push(
					failure("INVALID_ARGUMENT", `cannot read symlink ${relativePath}: ${messageOf(error)}`, {
						path: relativePath,
					}),
				);
			}
			continue;
		}
		if (entry.isDirectory()) {
			// Do not follow a directory symlink into a place outside the root;
			// the symlink itself was recorded above.
			try {
				const real = realpathSync(absolutePath);
				if (seenReal.has(real)) continue;
				seenReal.add(real);
			} catch (error) {
				errors.push(
					failure("INVALID_ARGUMENT", `cannot resolve directory ${relativePath}: ${messageOf(error)}`, {
						path: relativePath,
					}),
				);
				continue;
			}
			walkSnapshot(absolutePath, relativePath, files, errors, seenReal);
			continue;
		}
		if (!entry.isFile()) continue;
		try {
			const stats = lstatSync(absolutePath, { bigint: true });
			const bytes = readFileSync(absolutePath);
			files.push({
				path: relativePath,
				kind: "file",
				sha256: sha256Bytes(bytes),
				stamp: stampOf(stats),
			});
		} catch (error) {
			errors.push(
				failure("INVALID_ARGUMENT", `cannot read file ${relativePath}: ${messageOf(error)}`, {
					path: relativePath,
				}),
			);
		}
	}
}

function digestSnapshot(files) {
	const hash = createHash("sha256");
	for (const file of files) {
		const stamp = file.stamp ?? {};
		hash.update(file.path);
		hash.update("\u0000");
		hash.update(file.kind ?? "file");
		hash.update("\u0000");
		hash.update(file.sha256 ?? "");
		hash.update("\u0000");
		hash.update(bigintText(stamp.mtimeSec) ?? "");
		hash.update("\u0000");
		hash.update(bigintText(stamp.mtimeNsec) ?? "");
		hash.update("\u0000");
		hash.update(bigintText(stamp.size) ?? "");
		hash.update("\n");
	}
	return hash.digest("hex");
}

/**
 * Record the protected files under `root`.
 *
 * Output: `{ok, root, files, digest, errors}`. Each file is
 * `{path, kind, sha256, stamp: {mtimeSec, mtimeNsec, size}}` with relative,
 * slash-separated paths and bigint stamps. `digest` hashes the sorted manifest.
 *
 * The function is synchronous and deterministic, so two calls with no writes
 * return the same digest. It records symlinks instead of following them and
 * stops at the first repeated real directory, which prevents a symlink loop.
 * A read error makes `ok` false; the caller must refuse to start an audit with
 * an unusable "before" snapshot and must refuse to accept an unusable "after"
 * snapshot.
 */
export function snapshotWorkspace(root) {
	const errors = [];
	if (!isText(root)) {
		return {
			ok: false,
			root: null,
			files: [],
			digest: null,
			errors: [failure("INVALID_ARGUMENT", "root must be a non-empty path string", { field: "root" })],
		};
	}
	const absoluteRoot = resolve(root);
	let rootStats;
	try {
		rootStats = statSync(absoluteRoot, { bigint: true });
	} catch (error) {
		return {
			ok: false,
			root: absoluteRoot,
			files: [],
			digest: null,
			errors: [
				failure("INVALID_ARGUMENT", `workspace root is not readable: ${messageOf(error)}`, { path: absoluteRoot }),
			],
		};
	}
	if (!rootStats.isDirectory()) {
		return {
			ok: false,
			root: absoluteRoot,
			files: [],
			digest: null,
			errors: [failure("INVALID_ARGUMENT", "workspace root must be a directory", { path: absoluteRoot })],
		};
	}

	const files = [];
	const seenReal = new Set();
	try {
		seenReal.add(realpathSync(absoluteRoot));
	} catch {
		// The root itself is readable above; a missing realpath is not fatal.
	}
	walkSnapshot(absoluteRoot, "", files, errors, seenReal);
	files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	return {
		ok: errors.length === 0,
		root: absoluteRoot,
		files,
		digest: digestSnapshot(files),
		errors,
	};
}

function canonicalStamp(stamp) {
	if (!isPlainObject(stamp)) return null;
	const mtimeSec = bigintText(stamp.mtimeSec ?? stamp["mtime-sec"]);
	const mtimeNsec = bigintText(stamp.mtimeNsec ?? stamp["mtime-nsec"]);
	const size = bigintText(stamp.size);
	if (mtimeSec === null || mtimeNsec === null || size === null) return null;
	return { mtimeSec, mtimeNsec, size };
}

/**
 * Reduce a snapshot to one comparable signature, matching T4's accepted
 * `{digest}` and `{files}` shapes. `null` means the value is not usable as
 * evidence of workspace protection.
 */
function snapshotSignature(snapshot) {
	if (typeof snapshot === "string" && snapshot.length > 0) return `digest:${snapshot}`;
	if (!isPlainObject(snapshot)) return null;
	if (typeof snapshot.digest === "string" && snapshot.digest.length > 0) return `digest:${snapshot.digest}`;
	if (!Array.isArray(snapshot.files)) return null;
	const files = [];
	for (const file of snapshot.files) {
		if (!isPlainObject(file) || !isText(file.path) || !isText(file.sha256)) return null;
		const stamp = canonicalStamp(file.stamp);
		if (stamp === null) return null;
		files.push({ path: file.path, sha256: file.sha256, stamp });
	}
	files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	return `files:${JSON.stringify(files)}`;
}

function compareSnapshots(snapshotBefore, snapshotAfter) {
	const before = snapshotSignature(snapshotBefore);
	const after = snapshotSignature(snapshotAfter);
	const errors = [];
	if (before === null) {
		errors.push(
			failure("INVALID_ARGUMENT", `snapshotBefore is not a usable snapshot: ${describe(snapshotBefore)}`, {
				field: "snapshotBefore",
			}),
		);
	}
	if (after === null) {
		errors.push(
			failure("INVALID_ARGUMENT", `snapshotAfter is not a usable snapshot: ${describe(snapshotAfter)}`, {
				field: "snapshotAfter",
			}),
		);
	}
	if (before === null || after === null) {
		return { checked: false, mutated: false, errors };
	}
	if (before !== after) {
		errors.push(
			failure("AUDIT_WORKSPACE_MUTATED", "the protected workspace changed during the audit; the whole batch is void", {
				field: "snapshotAfter",
			}),
		);
		return { checked: true, mutated: true, errors };
	}
	return { checked: true, mutated: false, errors: [] };
}

function normalizeCaseSpecs(value) {
	const errors = [];
	if (!Array.isArray(value)) {
		errors.push(
			failure("INVALID_ARGUMENT", `caseSpecs must be an array, got ${describe(value)}`, { field: "caseSpecs" }),
		);
		return { ok: false, specs: [], errors };
	}
	if (value.length === 0) {
		errors.push(failure("INVALID_ARGUMENT", "caseSpecs must contain at least one CASE", { field: "caseSpecs" }));
		return { ok: false, specs: [], errors };
	}

	const specs = [];
	const seen = new Set();
	for (let index = 0; index < value.length; index += 1) {
		const raw = value[index];
		if (!isPlainObject(raw)) {
			errors.push(failure("INVALID_ARGUMENT", `caseSpecs[${index}] must be an object`, { field: "caseSpecs", index }));
			continue;
		}
		const unknown = Object.keys(raw).filter((key) => !CASE_SPEC_FIELD_SET.has(key));
		if (unknown.length > 0) {
			errors.push(
				failure("INVALID_ARGUMENT", `caseSpecs[${index}] has unknown fields: ${unknown.join(", ")}`, {
					field: "caseSpecs",
					index,
					unknown,
				}),
			);
			continue;
		}
		const id = typeof raw.case_id === "string" ? raw.case_id.trim() : "";
		if (!CASE_ID_PATTERN.test(id)) {
			errors.push(
				failure("INVALID_ARGUMENT", `caseSpecs[${index}].case_id must match ${CASE_ID_PATTERN.source}`, {
					field: "caseSpecs.case_id",
					index,
					actual: describe(raw.case_id),
				}),
			);
			continue;
		}
		if (seen.has(id)) {
			errors.push(
				failure("AUDIT_DUPLICATE_CASE", `caseSpecs contains duplicate CASE id ${id}`, {
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
			errors.push(
				failure("INVALID_ARGUMENT", `${id}: threshold ${describe(threshold)} must be a finite number in 0..100`, {
					field: "caseSpecs.threshold",
					index,
					caseId: id,
				}),
			);
			continue;
		}
		const path = raw.path;
		if (typeof path !== "string" || path.trim() === "") {
			errors.push(
				failure("INVALID_ARGUMENT", `${id}: path must be a non-empty string`, {
					field: "caseSpecs.path",
					index,
					caseId: id,
				}),
			);
			continue;
		}
		const steps = raw.steps;
		if (
			!Array.isArray(steps) ||
			steps.length === 0 ||
			steps.some((step) => typeof step !== "string" || step.trim() === "")
		) {
			errors.push(
				failure("INVALID_ARGUMENT", `${id}: steps must be a non-empty array of non-empty strings`, {
					field: "caseSpecs.steps",
					index,
					caseId: id,
				}),
			);
			continue;
		}
		const expected = raw.expected;
		if (typeof expected !== "string" || expected.trim() === "") {
			errors.push(
				failure("INVALID_ARGUMENT", `${id}: expected must be a non-empty string`, {
					field: "caseSpecs.expected",
					index,
					caseId: id,
				}),
			);
			continue;
		}
		const rubric = raw.rubric;
		if (typeof rubric !== "string" || rubric.trim() === "") {
			errors.push(
				failure("INVALID_ARGUMENT", `${id}: rubric must be a non-empty string`, {
					field: "caseSpecs.rubric",
					index,
					caseId: id,
				}),
			);
			continue;
		}
		specs.push({
			case_id: id,
			threshold,
			path,
			steps: [...steps],
			expected,
			rubric,
		});
	}
	return { ok: errors.length === 0, specs, errors };
}

function publicCaseSpec(spec) {
	return {
		case_id: spec.case_id,
		path: spec.path,
		threshold: spec.threshold,
		steps: [...spec.steps],
		expected: spec.expected,
		rubric: spec.rubric,
	};
}


function validateScoreValue(value, field, caseId, errors) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		errors.push(
			failure("AUDIT_INVALID_SCORE", `${caseId}: ${field} ${describe(value)} is not a finite number`, {
				caseId,
				field,
				actual: describe(value),
			}),
		);
		return false;
	}
	if (value < 0 || value > 100) {
		errors.push(
			failure("AUDIT_INVALID_SCORE", `${caseId}: ${field} ${value} is outside 0..100`, {
				caseId,
				field,
				value,
			}),
		);
		return false;
	}
	return true;
}

function isInside(parent, child) {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Check one auditor's evidence paths.
 *
 * Paths may be relative to the repository root or absolute. Every path must
 * describe `plans/<slug>/evidence/<case_id>/...`; when `slug` is absent, any
 * one-segment slug is accepted so the four-argument call still works.
 * Existence is checked under `root`. A symlink whose real target leaves the
 * evidence directory is rejected even when its lexical path looks valid.
 */
function verifyEvidencePaths({ root, slug, caseId, paths }) {
	const errors = [];
	if (!Array.isArray(paths) || paths.length === 0) {
		errors.push(
			failure("AUDIT_EVIDENCE_MISSING", `${caseId}: evidence_paths must be a non-empty array of paths`, {
				caseId,
				field: "evidence_paths",
			}),
		);
		return { ok: false, errors, resolved: [] };
	}
	if (!isText(root)) {
		errors.push(
			failure("AUDIT_EVIDENCE_MISSING", `${caseId}: root is required to verify evidence paths`, {
				caseId,
				field: "evidence_paths",
			}),
		);
		return { ok: false, errors, resolved: [] };
	}
	const absoluteRoot = resolve(root);
	let realRoot;
	try {
		realRoot = realpathSync(absoluteRoot);
	} catch {
		realRoot = absoluteRoot;
	}
	const resolved = [];
	const checkedRoots = new Map();

	for (let index = 0; index < paths.length; index += 1) {
		const raw = paths[index];
		if (!isText(raw)) {
			errors.push(
				failure("AUDIT_EVIDENCE_MISSING", `${caseId}: evidence_paths[${index}] must be a non-empty string`, {
					caseId,
					field: "evidence_paths",
					index,
				}),
			);
			continue;
		}
		if (raw.includes("\u0000")) {
			errors.push(
				failure("AUDIT_EVIDENCE_MISSING", `${caseId}: evidence path contains a NUL byte`, {
					caseId,
					field: "evidence_paths",
					index,
				}),
			);
			continue;
		}
		const candidate = isAbsolute(raw) ? resolve(raw) : resolve(absoluteRoot, raw);
		if (!isInside(absoluteRoot, candidate)) {
			errors.push(
				failure("PATH_ESCAPE", `${caseId}: evidence path escapes the repository: ${raw}`, {
					caseId,
					field: "evidence_paths",
					index,
					path: raw,
				}),
			);
			continue;
		}
		const rootRelative = relative(absoluteRoot, candidate).split(sep).join("/");
		const segments = rootRelative.split("/");
		if (
			segments.length < 5 ||
			segments[0] !== "plans" ||
			segments[2] !== "evidence" ||
			segments[3] !== caseId ||
			!SLUG_PATTERN.test(segments[1] ?? "") ||
			(slug !== undefined && slug !== null && segments[1] !== slug)
		) {
			errors.push(
				failure(
					"AUDIT_EVIDENCE_MISSING",
					`${caseId}: evidence path must stay inside plans/${slug ?? "<slug>"}/evidence/${caseId}/`,
					{ caseId, field: "evidence_paths", index, path: raw },
				),
			);
			continue;
		}
		const allowedDir = join(absoluteRoot, "plans", segments[1], "evidence", caseId);
		let realAllowed = checkedRoots.get(allowedDir);
		if (realAllowed === undefined) {
			try {
				realAllowed = realpathSync(allowedDir);
			} catch {
				realAllowed = null;
			}
			checkedRoots.set(allowedDir, realAllowed);
		}
		if (realAllowed !== null && !isInside(realRoot, realAllowed)) {
			errors.push(
				failure("PATH_ESCAPE", `${caseId}: the evidence directory is a symlink that leaves the repository`, {
					caseId,
					field: "evidence_paths",
					index,
					path: raw,
				}),
			);
			continue;
		}
		let stats;
		try {
			stats = statSync(candidate);
		} catch (error) {
			errors.push(
				failure("AUDIT_EVIDENCE_MISSING", `${caseId}: evidence path does not exist: ${raw}`, {
					caseId,
					field: "evidence_paths",
					index,
					path: raw,
					cause: messageOf(error),
				}),
			);
			continue;
		}
		try {
			const realCandidate = realpathSync(candidate);
			const lexicalInside = isInside(allowedDir, candidate);
			const realInside = realAllowed !== null ? isInside(realAllowed, realCandidate) : lexicalInside;
			if (!lexicalInside || !realInside) {
				errors.push(
					failure("PATH_ESCAPE", `${caseId}: evidence symlink leaves its evidence directory: ${raw}`, {
						caseId,
						field: "evidence_paths",
						index,
						path: raw,
					}),
				);
				continue;
			}
		} catch (error) {
			errors.push(
				failure("AUDIT_EVIDENCE_MISSING", `${caseId}: evidence path is not readable: ${raw}`, {
					caseId,
					field: "evidence_paths",
					index,
					path: raw,
					cause: messageOf(error),
				}),
			);
			continue;
		}
		if (!stats.isFile() && !stats.isDirectory()) {
			errors.push(
				failure("AUDIT_EVIDENCE_MISSING", `${caseId}: evidence path is not a file or directory: ${raw}`, {
					caseId,
					field: "evidence_paths",
					index,
					path: raw,
				}),
			);
			continue;
		}
		resolved.push(candidate);
	}

	return { ok: errors.length === 0, errors, resolved };
}

/**
 * Read the durable EDN receipt written by the real `submit_case_audit` tool.
 *
 * Contract with the main assembly: the tool reads its parent-assigned
 * `<artifactsDir>/audit-context.edn`, then writes the complete submission to
 * `<root>/.herd/missions/<slug>/audit/<batch-id>/<case-id>.submit.edn`. The
 * EDN map is kebab-case and carries at least `:batch-id`, `:case-id`,
 * `:user-score`, `:developer-score`, `:report-markdown`, and
 * `:evidence-paths`. A batch id in the path and map keeps old attempts
 * isolated, so retries never depend on wall-clock time. Pass `directory` to
 * use a different agreed audit root; `<batch-id>/<case-id>.submit.edn` is still
 * appended.
 *
 * The returned port has the `collectSubmission` shape:
 * `({caseId}) -> {ok:true, submission, path} | {ok:false, error}`.
 */
export function createFileSubmissionReader({ root, slug, batchId, directory } = {}) {
	let baseDir = null;
	if (isText(directory)) {
		baseDir = resolve(directory);
	} else if (isText(root) && isText(slug) && SLUG_PATTERN.test(slug)) {
		baseDir = join(resolve(root), ".herd", "missions", slug, "audit");
	}
	const batchValid = typeof batchId === "string" && BATCH_ID_PATTERN.test(batchId) && !batchId.includes("..");
	return ({ caseId } = {}) => {
		if (baseDir === null) {
			return {
				ok: false,
				error: failure("INVALID_ARGUMENT", "submission reader needs a valid root/slug or directory", {
					field: "root/slug",
				}),
			};
		}
		if (!batchValid) {
			return {
				ok: false,
				error: failure("INVALID_ARGUMENT", "submission reader needs a valid batch id", {
					field: "batchId",
					actual: describe(batchId),
				}),
			};
		}
		if (typeof caseId !== "string" || !CASE_ID_PATTERN.test(caseId)) {
			return {
				ok: false,
				error: failure("INVALID_ARGUMENT", "submission reader needs a valid CASE id", {
					field: "caseId",
					actual: describe(caseId),
				}),
			};
		}
		const path = join(baseDir, batchId, `${caseId}.submit.edn`);
		try {
			const parsed = contractCodec.parseEdn(readFileSync(path, "utf8"));
			if (!isPlainObject(parsed)) {
				return {
					ok: false,
					error: failure("AUDIT_MISSING", `${caseId}: durable submission is not an EDN map`, {
						caseId,
						path,
					}),
				};
			}
			const fileBatch = parsed["batch-id"] ?? parsed.batch_id;
			const fileCase = parsed["case-id"] ?? parsed.case_id;
			if (fileBatch !== batchId) {
				return {
					ok: false,
					error: failure("AUDIT_MISSING", `${caseId}: durable submission belongs to another audit batch`, {
						caseId,
						path,
						expectedBatchId: batchId,
						actualBatchId: fileBatch ?? null,
					}),
				};
			}
			if (fileCase !== caseId) {
				return {
					ok: false,
					error: failure("AUDIT_UNKNOWN_CASE", `${caseId}: durable submission names another CASE`, {
						caseId,
						submittedCaseId: fileCase ?? null,
						path,
					}),
				};
			}
			const submission = {
				case_id: fileCase,
				user_score: parsed["user-score"] ?? parsed.user_score,
				developer_score: parsed["developer-score"] ?? parsed.developer_score,
				report_markdown: parsed["report-markdown"] ?? parsed.report_markdown,
				evidence_paths: parsed["evidence-paths"] ?? parsed.evidence_paths,
			};
			if (!isCompleteSubmission(submission)) {
				return {
					ok: false,
					error: failure("AUDIT_MISSING", `${caseId}: durable submission is not a complete audit object`, {
						caseId,
						path,
					}),
				};
			}
			return { ok: true, submission, path };
		} catch (error) {
			return {
				ok: false,
				error: failure("AUDIT_MISSING", `${caseId}: durable submission cannot be read: ${messageOf(error)}`, {
					caseId,
					path,
					cause: messageOf(error),
				}),
			};
		}
	};
}

/**
 * Persist one real `submit_case_audit` payload exactly once per batch/CASE.
 *
 * The tool calls this after reading its parent-assigned
 * `<artifactsDir>/audit-context.edn`. The file is created with `wx`, so a second
 * valid submission in the same batch returns `:AUDIT_DUPLICATE_CASE` and leaves
 * the first file byte-for-byte untouched. A different batch gets a different
 * directory, so old evidence is never overwritten.
 */
export function writeSubmissionOnce({ root, slug, batchId, caseId, submission, directory } = {}) {
	let baseDir = null;
	if (isText(directory)) {
		baseDir = resolve(directory);
	} else if (isText(root) && isText(slug) && SLUG_PATTERN.test(slug)) {
		baseDir = join(resolve(root), ".herd", "missions", slug, "audit");
	}
	if (baseDir === null) {
		return {
			ok: false,
			code: ERROR_CODES.INVALID_ARGUMENT,
			message: "submission writer needs a valid root/slug or directory",
		};
	}
	if (typeof batchId !== "string" || !BATCH_ID_PATTERN.test(batchId) || batchId.includes("..")) {
		return {
			ok: false,
			code: ERROR_CODES.INVALID_ARGUMENT,
			message: "submission writer needs a valid batch id",
		};
	}
	if (typeof caseId !== "string" || !CASE_ID_PATTERN.test(caseId)) {
		return {
			ok: false,
			code: ERROR_CODES.INVALID_ARGUMENT,
			message: "submission writer needs a valid CASE id",
		};
	}
	if (!isCompleteSubmission(submission)) {
		return {
			ok: false,
			code: ERROR_CODES.INVALID_ARGUMENT,
			message: "submission writer needs the complete audit fields",
		};
	}
	if (submission.case_id !== caseId) {
		return {
			ok: false,
			code: ERROR_CODES.AUDIT_UNKNOWN_CASE,
			message: `${caseId}: submission names another CASE`,
		};
	}
	const path = join(baseDir, batchId, `${caseId}.submit.edn`);
	const text = `${printEdn({
		"batch-id": batchId,
		"case-id": caseId,
		"user-score": submission.user_score,
		"developer-score": submission.developer_score,
		"report-markdown": submission.report_markdown,
		"evidence-paths": submission.evidence_paths,
	})}\n`;
	let fd = -1;
	let created = false;
	try {
		mkdirSync(dirname(path), { recursive: true });
		fd = openSync(path, "wx", 0o600);
		created = true;
		writeSync(fd, text);
		fsyncSync(fd);
		closeSync(fd);
		fd = -1;
		return { ok: true, path };
	} catch (error) {
		if (fd !== -1) {
			try {
				closeSync(fd);
			} catch {
				// The write failure remains the primary error.
			}
		}
		if (error?.code === "EEXIST") {
			return {
				ok: false,
				code: ERROR_CODES.AUDIT_DUPLICATE_CASE,
				path,
				message: `${caseId}: a submission already exists in this audit batch`,
			};
		}
		if (created) {
			try {
				rmSync(path, { force: true });
			} catch {
				// A partial file is worse than a system-error report; remove best effort.
			}
		}
		return {
			ok: false,
			code: typeof error?.code === "string" ? error.code : ERROR_CODES.INVALID_ARGUMENT,
			path,
			message: messageOf(error),
		};
	}
}

/**
 * Validate every submission on its own.
 *
 * Inputs:
 * - `caseSpecs`: the validated six-field CASE records in `s2-cases.edn` order.
 * - `submissions`: raw `{case_id, user_score, developer_score,
 *   report_markdown, evidence_paths}` objects collected from the auditors.
 * - `snapshotBefore`, `snapshotAfter`: snapshots from `snapshotWorkspace`.
 * - `root`, `slug`: optional but required for evidence existence checks. The
 *   four-argument call still performs structural containment; a missing
 *   root fails closed rather than pretending existence was checked.
 *
 * Output: `{ok, errors, workspaceMutated, snapshotChecked, submissions,
 * invalidCount, validCount}`. Each normalized submission keeps every original
 * field and gains `validation: {ok, errors}`. This is the only value T4 treats
 * as authoritative for evidence and workspace checks; missing, unknown, and
 * duplicate CASE reconciliation stay with T4 so there is one owner for that
 * decision.
 *
 * The function never throws and never writes a file.
 */
export function validateSubmissions({ caseSpecs, submissions, snapshotBefore, snapshotAfter, root, slug } = {}) {
	const errors = [];
	const specsResult = normalizeCaseSpecs(caseSpecs);
	if (!specsResult.ok) errors.push(...specsResult.errors);
	const specById = new Map(specsResult.specs.map((spec) => [spec.case_id, spec]));
	const snapshot = compareSnapshots(snapshotBefore, snapshotAfter);
	errors.push(...snapshot.errors);

	const normalized = [];
	if (!Array.isArray(submissions)) {
		errors.push(
			failure("INVALID_ARGUMENT", `submissions must be an array, got ${describe(submissions)}`, {
				field: "submissions",
			}),
		);
	} else {
		for (let index = 0; index < submissions.length; index += 1) {
			const raw = submissions[index];
			if (!isPlainObject(raw)) {
				normalized.push({
					validation: {
						ok: false,
						errors: [
							failure("INVALID_ARGUMENT", `submissions[${index}] must be an object`, {
								field: "submissions",
								index,
							}),
						],
					},
				});
				continue;
			}
			const entry = { ...raw };
			const submissionErrors = [];
			const caseId = typeof entry.case_id === "string" ? entry.case_id.trim() : "";
			if (caseId === "") {
				submissionErrors.push(
					failure("INVALID_ARGUMENT", "case_id must be a non-empty string", {
						field: "case_id",
						index,
					}),
				);
			} else {
				entry.case_id = caseId;
				if (!specById.has(caseId)) {
					submissionErrors.push(
						failure("AUDIT_UNKNOWN_CASE", `${caseId}: no such CASE in s2-cases.edn`, {
							caseId,
							index,
						}),
					);
				}
			}

			validateScoreValue(entry.user_score, "user_score", caseId || `submissions[${index}]`, submissionErrors);
			validateScoreValue(entry.developer_score, "developer_score", caseId || `submissions[${index}]`, submissionErrors);

			if (!isText(entry.report_markdown)) {
				submissionErrors.push(
					failure(
						"AUDIT_EVIDENCE_MISSING",
						`${caseId || `submissions[${index}]`}: report_markdown must be a non-empty string`,
						{
							caseId: caseId || undefined,
							field: "report_markdown",
							index,
						},
					),
				);
			}

			if (caseId === "") {
				submissionErrors.push(
					failure("AUDIT_EVIDENCE_MISSING", "evidence paths cannot be checked without a case_id", {
						field: "evidence_paths",
						index,
					}),
				);
			} else {
				const evidence = verifyEvidencePaths({ root, slug, caseId, paths: entry.evidence_paths });
				submissionErrors.push(...evidence.errors);
			}

			if (snapshot.mutated) {
				submissionErrors.push(
					failure("AUDIT_WORKSPACE_MUTATED", `${caseId || `submissions[${index}]`}: the protected workspace changed`, {
						caseId: caseId || undefined,
						field: "snapshotAfter",
					}),
				);
			} else if (!snapshot.checked) {
				submissionErrors.push(
					failure("INVALID_ARGUMENT", `${caseId || `submissions[${index}]`}: workspace snapshots were not usable`, {
						caseId: caseId || undefined,
						field: "snapshot",
					}),
				);
			}

			entry.validation = { ok: submissionErrors.length === 0, errors: submissionErrors };
			if (!entry.validation.ok) errors.push(...submissionErrors);
			normalized.push(entry);
		}
	}

	return {
		ok: errors.length === 0,
		errors,
		workspaceMutated: snapshot.mutated,
		snapshotChecked: snapshot.checked,
		submissions: normalized,
		validCount: normalized.filter((entry) => entry.validation?.ok === true).length,
		invalidCount: normalized.filter((entry) => entry.validation?.ok !== true).length,
	};
}


function submissionSchemaFor(caseId) {
	return {
		...AUDIT_SUBMISSION_SCHEMA,
		properties: {
			...AUDIT_SUBMISSION_SCHEMA.properties,
			case_id: { type: "string", enum: [caseId] },
		},
	};
}

function confirmationSchemaFor(caseId) {
	return {
		...AUDIT_CONFIRMATION_SCHEMA,
		properties: {
			...AUDIT_CONFIRMATION_SCHEMA.properties,
			case_id: { type: "string", enum: [caseId] },
		},
	};
}

function defaultSystemPrompt() {
	return [
		"You are an independent Manual Auditor in the Herdchestra S5 terminal audit.",
		"You audit exactly one CASE and nothing else.",
		"You never accept an executor's summary, commit message, task count, or completion claim as evidence.",
		"You observe the real host and capture real screens.",
		"The main workspace is shared and read-only for you: never create, edit, delete, or move anything there.",
		"There is no worktree and no temporary copy of the project; do not look for one and do not create one.",
		"You write only your evidence directory and your own artifacts directory.",
		"You never spawn subagents.",
		`When you finish, call submit_case_audit exactly once and then yield a minimal confirmation such as {"ok": true}. Do not repeat the submission in the yield.`,
	].join("\n");
}

function ensureYieldConfirmation(prompt) {
	const text = typeof prompt === "string" ? prompt : "";
	if (/\byield\b/i.test(text)) return text;
	return [
		text.trim(),
		"",
		"## Completion",
		"",
		'After submit_case_audit succeeds, yield a minimal confirmation object such as {"ok": true}. The framework reads the durable tool submission, not the yield; do not duplicate the audit fields in the yield.',
	]
		.join("\n")
		.trim();
}

function ensureIsolationPaths(prompt, isolation) {
	const text = typeof prompt === "string" ? prompt : "";
	const missing = [];
	if (!text.includes(isolation.evidenceDir)) {
		missing.push(`- Write evidence here: ${isolation.evidenceDir}/`);
	}
	if (!text.includes(isolation.artifactsDir)) {
		missing.push(`- Write your transcript and receipts here: ${isolation.artifactsDir}/`);
	}
	if (!text.includes("read-only")) {
		missing.push(
			"- The main workspace is read-only for you: observe it, never write it. There is no worktree and no temporary copy.",
		);
	}
	if (!text.includes("Do not spawn subagents")) {
		missing.push("- Do not spawn subagents.");
	}
	if (missing.length === 0) return text;
	return [text.trim(), "", "## Framework placement", "", ...missing].join("\n").trim();
}

function buildIsolation({ root, slug, batchId, caseId, timeoutMs, tools }) {
	const evidenceDir = join(root, "plans", slug, "evidence", caseId);
	const artifactsDir = join(root, ".herd", "artifacts", slug, "audit", batchId, caseId);
	const relativeEvidence = relative(root, evidenceDir).split(sep).join("/");
	const relativeArtifacts = relative(root, artifactsDir).split(sep).join("/");
	return {
		mainWorkspace: root,
		readOnlyWorkspace: true,
		evidenceDir: relativeEvidence,
		artifactsDir: relativeArtifacts,
		tools: [...tools],
		timeoutMs,
	};
}

function normalizeError(error, fallbackCode, message) {
	if (isPlainObject(error) && typeof error.code === "string" && typeof error.message === "string") {
		return error;
	}
	if (error && typeof error === "object" && typeof error.code === "string") {
		return failure(error.code, typeof error.message === "string" ? error.message : messageOf(error), {});
	}
	return failure(fallbackCode, message ?? messageOf(error), {});
}

function resolveStarter(deps) {
	if (typeof deps.runtime?.start === "function") {
		return { ok: true, start: (options) => deps.runtime.start(options) };
	}
	if (typeof deps.start === "function") return { ok: true, start: (options) => deps.start(options) };
	if (typeof deps.spawnAgent === "function") {
		return {
			ok: true,
			start: (options) => ({ handle: null, done: Promise.resolve(deps.spawnAgent(options)) }),
		};
	}
	return {
		ok: false,
		errors: [
			failure("HOST_API_MISMATCH", "startAuditBatch needs an injected runtime.start, deps.start, or deps.spawnAgent", {
				field: "deps",
				next: "pass the host createAgentRuntime() object as deps.runtime",
			}),
		],
	};
}

function looksLikeSubmission(value) {
	if (!isPlainObject(value)) return false;
	if (typeof value.case_id !== "string") return false;
	// A tool result such as {ok, case_id} is not a submission. An actual
	// attempt carries at least one audit field; validation then reports every
	// missing field instead of silently treating the attempt as absent.
	return "user_score" in value || "developer_score" in value || "report_markdown" in value || "evidence_paths" in value;
}

function isCompleteSubmission(value) {
	if (!isPlainObject(value) || typeof value.case_id !== "string") return false;
	for (const field of ["user_score", "developer_score"]) {
		const score = value[field];
		if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) return false;
	}
	if (typeof value.report_markdown !== "string" || value.report_markdown.trim() === "") return false;
	return (
		Array.isArray(value.evidence_paths) &&
		value.evidence_paths.length > 0 &&
		value.evidence_paths.every((path) => isText(path))
	);
}

function toolDataContainers(outcome) {
	const containers = [];
	if (isPlainObject(outcome?.extractedToolData)) containers.push(outcome.extractedToolData);
	if (isPlainObject(outcome?.result?.extractedToolData)) containers.push(outcome.result.extractedToolData);
	if (isPlainObject(outcome?.result?.result?.extractedToolData)) {
		containers.push(outcome.result.result.extractedToolData);
	}
	return containers;
}

/**
 * Collect every successful `submit_case_audit` receipt in the result graph.
 *
 * The audit rule forbids a second write for the same CASE. Returning only
 * the last receipt would hide exactly that violation, so the receipt count, not
 * the count of parseable payloads, decides whether the auditor submitted twice.
 */
function collectToolSubmissions(outcome) {
	const submissions = [];
	const receipts = [];
	const seenEntries = new Set();
	for (const container of toolDataContainers(outcome)) {
		if (!("submit_case_audit" in container)) continue;
		const entries = Array.isArray(container.submit_case_audit)
			? container.submit_case_audit
			: [container.submit_case_audit];
		for (const entry of entries) {
			if (!isPlainObject(entry) || seenEntries.has(entry)) continue;
			seenEntries.add(entry);
			if (typeof entry.status === "string" && entry.status !== "success") continue;
			if (entry.schemaOverridden === true) continue;
			receipts.push(entry);
			for (const candidate of [entry, entry.data, entry.input, entry.arguments, entry.params, entry.args]) {
				if (!isPlainObject(candidate) || !looksLikeSubmission(candidate) || seenEntries.has(candidate)) continue;
				seenEntries.add(candidate);
				submissions.push(candidate);
				break;
			}
		}
	}
	return { submissions, receipts };
}

function normalizePortSubmissions(value) {
	if (!Array.isArray(value)) return null;
	const submissions = [];
	for (const item of value) {
		if (!isPlainObject(item)) continue;
		for (const candidate of [item, item.data, item.input, item.arguments, item.params, item.args]) {
			if (!isPlainObject(candidate) || !looksLikeSubmission(candidate)) continue;
			submissions.push(candidate);
			break;
		}
	}
	return submissions;
}

function duplicateSubmissionResult(caseId, submissions, source, count = submissions.length, receipts = submissions) {
	const total = Number.isInteger(count) ? count : submissions.length;
	return {
		ok: false,
		duplicate: true,
		submission: null,
		submissions,
		receipts,
		source,
		error: failure(
			"AUDIT_DUPLICATE_CASE",
			`${caseId}: ${total} structured submissions were recorded; exactly one is allowed`,
			{ caseId, count: total, parsed: submissions.length, source },
		),
	};
}

async function collectAuditorSubmission({ caseId, auditor, outcome, deps, batchId }) {
	const { submissions: toolSubmissions, receipts: toolReceipts } = collectToolSubmissions(outcome);
	if (toolReceipts.length > 1) {
		return duplicateSubmissionResult(caseId, toolSubmissions, "tool", toolReceipts.length, toolReceipts);
	}
	const port =
		typeof deps.collectSubmission === "function"
			? deps.collectSubmission
			: typeof deps.readSubmission === "function"
				? deps.readSubmission
				: null;
	let portError = null;
	if (typeof port === "function") {
		try {
			const collected = await port({
				caseId,
				auditor,
				outcome,
				batchId,
			});
			if (collected === null || collected === undefined) {
				// Fall through to the result extraction.
			} else if (isPlainObject(collected) && collected.ok === false) {
				portError = normalizeError(
					collected.error ?? (Array.isArray(collected.errors) ? collected.errors[0] : undefined) ?? collected,
					"AUDIT_MISSING",
					`${caseId}: the submission collection port failed`,
				);
			} else if (isPlainObject(collected) && Array.isArray(collected.submissions)) {
				const submissions = normalizePortSubmissions(collected.submissions);
				if (submissions.length > 1) return duplicateSubmissionResult(caseId, submissions, "port");
				if (submissions.length === 1) {
					return { ok: true, submission: submissions[0], submissions, receipts: submissions, source: "port" };
				}
				portError = failure("AUDIT_MISSING", `${caseId}: the collection port returned no submission object`, {
					caseId,
				});
			} else if (isPlainObject(collected) && "submission" in collected) {
				if (isPlainObject(collected.submission)) {
					return {
						ok: true,
						submission: collected.submission,
						submissions: [collected.submission],
						receipts: [collected.submission],
						source: "port",
					};
				}
				portError = failure("AUDIT_MISSING", `${caseId}: the collection port returned no submission object`, {
					caseId,
				});
			} else if (isPlainObject(collected) && isPlainObject(collected.data) && looksLikeSubmission(collected.data)) {
				return {
					ok: true,
					submission: collected.data,
					submissions: [collected.data],
					receipts: [collected.data],
					source: "port",
				};
			} else if (isPlainObject(collected) && looksLikeSubmission(collected)) {
				return { ok: true, submission: collected, submissions: [collected], receipts: [collected], source: "port" };
			} else {
				portError = failure("AUDIT_MISSING", `${caseId}: the collection port returned an unusable value`, {
					caseId,
				});
			}
		} catch (error) {
			portError = normalizeError(error, "AUDIT_MISSING", `${caseId}: the submission collection port threw`);
		}
	}
	if (portError?.code === ERROR_CODES.AUDIT_DUPLICATE_CASE) {
		const submissions = Array.isArray(portError.submissions) ? portError.submissions : [];
		return {
			ok: false,
			duplicate: true,
			submission: null,
			submissions,
			receipts: submissions,
			source: "port",
			error: portError,
		};
	}
	if (toolSubmissions.length === 1) {
		return {
			ok: true,
			submission: toolSubmissions[0],
			submissions: toolSubmissions,
			receipts: toolReceipts,
			source: "tool",
		};
	}
	return {
		ok: false,
		submission: null,
		submissions: [],
		receipts: toolReceipts,
		error:
			portError ??
			failure("AUDIT_MISSING", `${caseId}: no durable full submit_case_audit submission was found`, {
				caseId,
				next: "persist the tool parameters in the real submission file and inject deps.collectSubmission/readSubmission",
			}),
	};
}

function publicAuditorRecord(record) {
	return {
		caseId: record.caseId,
		name: record.name,
		agentId: record.agentId,
		status: record.status,
		evidenceDir: record.evidenceDir,
		artifactsDir: record.artifactsDir,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
	};
}

function auditorOutputRecord(record) {
	return {
		caseId: record.caseId,
		name: record.name,
		agentId: record.agentId,
		status: record.status,
		evidenceDir: record.evidenceDir,
		artifactsDir: record.artifactsDir,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		submission: record.submission,
		submissions: record.submissions,
		receipts: record.receipts,
		submissionSource: record.submissionSource,
		exitConfirmed: record.exitConfirmed,
		validation: record.validation,
		error: record.error,
	};
}

function auditorResultError(record, code, message, data = {}) {
	const name = code.startsWith(":") ? code.slice(1) : code;
	const keyword = ERROR_CODES[name] ?? ERROR_CODES.INVALID_ARGUMENT;
	record.status =
		keyword === ERROR_CODES.AUDIT_TIMEOUT ? "timeout" : keyword === ERROR_CODES.AUDIT_ABORTED ? "aborted" : "crashed";
	record.error = failure(keyword, message, { caseId: record.caseId, ...data });
	record.finishedAt = record.now();
}

function abortAuditRecord(record, reason, timedOut = false) {
	if (timedOut) record.timedOut = true;
	else record.cancelled = true;
	record.controller.abort(reason);
	record.handle?.abort?.(reason);
	record.resolveAbort?.({ kind: record.timedOut ? "timeout" : "aborted" });
}

function abortLateStart(record, reason) {
	Promise.resolve(record.started)
		.then((late) => {
			late?.handle?.abort?.(reason);
		})
		.catch(() => {});
}

async function waitForExitConfirmation(started, record) {
	if (record.exitConfirmed === true) return true;
	if (record.doneSettled === true) {
		record.exitConfirmed = true;
		return true;
	}
	if (!isPlainObject(started) || started.done === undefined) return false;
	let timer;
	const grace = new Promise((resolve) => {
		timer = setTimeout(() => resolve(false), EXIT_CONFIRM_GRACE_MS);
	});
	const settled = Promise.resolve(started.done).then(
		() => true,
		() => true,
	);
	const confirmed = await Promise.race([settled, grace]);
	clearTimeout(timer);
	if (confirmed) {
		record.doneSettled = true;
		record.exitConfirmed = true;
	}
	return confirmed;
}

async function confirmLateExit(record) {
	if (record.exitConfirmed === true) return true;
	if (record.doneSettled === true) {
		record.exitConfirmed = true;
		return true;
	}
	if (record.spawnAttempted !== true) return true;
	let timer;
	const grace = new Promise((resolve) => {
		timer = setTimeout(() => resolve({ kind: "grace" }), EXIT_CONFIRM_GRACE_MS);
	});
	const startOutcome = await Promise.race([
		Promise.resolve(record.started).then(
			(value) => ({ kind: "started", value }),
			() => ({ kind: "error" }),
		),
		grace,
	]);
	clearTimeout(timer);
	if (startOutcome.kind !== "started" || !isPlainObject(startOutcome.value)) return false;
	startOutcome.value.handle?.abort?.("auditor aborted");
	return waitForExitConfirmation(startOutcome.value, record);
}

function prepareDirectory(path, options = {}) {
	try {
		mkdirSync(path, { recursive: true });
		const stats = statSync(path);
		if (!stats.isDirectory()) return failure("INVALID_ARGUMENT", "path exists but is not a directory", { path });
		if (isText(options.root)) {
			const realRoot = realpathSync(resolve(options.root));
			const realPath = realpathSync(path);
			if (!isInside(realRoot, realPath)) {
				return failure("PATH_ESCAPE", `directory is a symlink that leaves the workspace: ${path}`, {
					path,
					root: options.root,
				});
			}
		}
		return null;
	} catch (error) {
		return failure("INVALID_ARGUMENT", `cannot create directory ${path}: ${messageOf(error)}`, {
			path,
			cause: messageOf(error),
		});
	}
}

function freshRoleNonce(idFactory, index) {
	const suffix = index.toString(36);
	const base = String(idFactory() ?? "")
		.replace(/[^A-Za-z0-9_-]/g, "")
		.slice(0, 128 - suffix.length);
	return `${base || "auditor"}${suffix}`;
}

function freshIdToken(idFactory) {
	const token = String(idFactory() ?? "")
		.replace(/[^A-Za-z0-9_-]/g, "")
		.slice(0, 64);
	return token || "audit";
}

function auditorName(slug, caseId) {
	const prefix = "Auditor-";
	const max = 80;
	const tail = `-${caseId}`;
	const available = max - prefix.length - tail.length;
	if (available >= 1) return `${prefix}${slug.slice(0, available)}${tail}`;
	return `${prefix}${caseId}`.slice(0, max);
}

/**
 * Start one visible Manual Auditor per CASE and collect their submissions.
 *
 * Inputs: repository `root`, mission `slug`, and the already validated
 * `caseSpecs` array (`{case_id,path,threshold,steps,expected,rubric}`) in
 * `.herd/missions/<slug>/s2-cases.edn` order. Each auditor receives only its
 * own public CASE record; no S1 summary, stage document, contract, or dataset
 * hash is copied into the prompt.
 *
 * There is one main workspace. The auditor observes it read-only and writes
 * only `plans/<slug>/evidence/<case_id>/` and its own artifacts directory.
 * There is no worktree and no temporary project copy.
 *
 * Required `deps` port: `runtime.start(options) -> {handle, done}` (the host
 * `createAgentRuntime()` object), or `start`, or promise-only `spawnAgent`.
 * The runtime must be built with the host's live `Settings` port; the caller
 * also forwards `deps.settings` as the request's live Settings instance.
 * Production also passes `eventBus`, `modelRegistry`, `capabilities`, the
 * parent model pattern in `model`, and `preloadedExtensionPaths`.
 * `parentHandle` (or `parent`), `parentSessionFile` (or `sessionFile`),
 * `systemPrompt`, `buildPrompt`, `collectSubmission` or `readSubmission`,
 * `signal`, `timeoutMs`, `maxRuntimeMs`, `now`, `randomUUID`, and
 * `submissionDirectory` are optional. When no collection port is injected,
 * only the real `submit_case_audit` tool input/arguments count; yield data and
 * output artifacts are never accepted as the submission.
 *
 * Output: `{ok, state, uncertain, closureBlocked, uncertainCases,
 * exitConfirmed, batchId, slug, caseSpecs, auditors, submissions,
 * missingCases, unknownCases, duplicateCases, duplicateSubmissionCases,
 * validation, snapshotBefore, snapshotAfter, workspaceMutated, retryRequired,
 * aggregateInput, errors, ...}`. `aggregateInput` is
 * `{caseSpecs,submissions,snapshotBefore,snapshotAfter}`.
 *
 * `ok` means every auditor started, submitted, passed the evidence/snapshot
 * validation, and the protected workspace stayed unchanged. It does not mean
 * the CASE scores reached their thresholds; the caller owns that decision.
 *
 * The function starts all K auditors before awaiting any one of them. It does
 * not serialize, skip, or downgrade a CASE. A timeout or abort is an audit
 * anomaly, not a pass and not a code defect.
 */
export async function startAuditBatch({ root, slug, caseSpecs, deps } = {}) {
	const globalErrors = [];
	const depsSet = isPlainObject(deps) ? deps : {};
	const now = typeof depsSet.now === "function" ? depsSet.now : Date.now;
	const newId = typeof depsSet.randomUUID === "function" ? depsSet.randomUUID : nodeRandomUUID;
	const startedAt = now();
	const batchId = `audit-${typeof slug === "string" ? slug : "unknown"}-${freshIdToken(newId)}`;

	if (!isText(root)) {
		globalErrors.push(failure("INVALID_ARGUMENT", "root must be a non-empty path string", { field: "root" }));
	}
	if (!isText(slug) || !SLUG_PATTERN.test(slug)) {
		globalErrors.push(
			failure("INVALID_ARGUMENT", `slug must match ${SLUG_PATTERN.source}`, { field: "slug", actual: describe(slug) }),
		);
	}
	if (
		depsSet.signal !== undefined &&
		(depsSet.signal === null ||
			typeof depsSet.signal !== "object" ||
			typeof depsSet.signal.aborted !== "boolean" ||
			typeof depsSet.signal.addEventListener !== "function")
	) {
		globalErrors.push(failure("INVALID_ARGUMENT", "deps.signal must be an AbortSignal", { field: "deps.signal" }));
	}
	const absoluteRoot = isText(root) ? resolve(root) : null;
	const specsResult = normalizeCaseSpecs(caseSpecs);
	if (!specsResult.ok) globalErrors.push(...specsResult.errors);
	if (typeof depsSet.buildPrompt !== "function") {
		globalErrors.push(
			failure("INVALID_ARGUMENT", "deps.buildPrompt must inject the role prompt builder", {
				field: "deps.buildPrompt",
				next: "pass buildCaseAuditorPrompt from prompts/roles in the main assembly",
			}),
		);
	}
	const refuse = ({
		errors = [],
		snapshotBefore = null,
		root: rootPath = isText(root) ? resolve(root) : null,
		caseSpecs: refusedSpecs = specsResult.specs,
	} = {}) => ({
		ok: false,
		state: "refused",
		batchId,
		slug: isText(slug) ? slug : null,
		root: rootPath,
		caseSpecs: refusedSpecs.map(publicCaseSpec),
		auditors: [],
		submissions: [],
		missingCases: refusedSpecs.map((spec) => spec.case_id),
		unknownCases: [],
		duplicateCases: [],
		validation: { ok: false, errors, workspaceMutated: false, snapshotChecked: false },
		snapshotBefore,
		snapshotAfter: null,
		workspaceMutated: false,
		retryRequired: false,
		aggregateInput: null,
		errors,
		startedAt: now(),
		finishedAt: now(),
		durationMs: 0,
	});
	if (globalErrors.length > 0) {
		return refuse({ errors: globalErrors });
	}

	const specs = specsResult.specs;
	const snapshotBefore = snapshotWorkspace(absoluteRoot);
	if (!snapshotBefore.ok) {
		return refuse({
			errors: snapshotBefore.errors,
			snapshotBefore,
			root: absoluteRoot,
			caseSpecs: specs,
		});
	}
	const starter = resolveStarter(depsSet);
	if (!starter.ok) {
		return refuse({
			errors: starter.errors,
			snapshotBefore,
			root: absoluteRoot,
			caseSpecs: specs,
		});
	}

	const timeoutMs =
		Number.isFinite(depsSet.timeoutMs) && depsSet.timeoutMs > 0
			? Math.trunc(depsSet.timeoutMs)
			: DEFAULT_AUDIT_TIMEOUT_MS;
	const maxRuntimeMs =
		Number.isFinite(depsSet.maxRuntimeMs) && depsSet.maxRuntimeMs > 0 ? Math.trunc(depsSet.maxRuntimeMs) : timeoutMs;
	const tools =
		Array.isArray(depsSet.tools) && depsSet.tools.length > 0
			? depsSet.tools.map(String)
			: ["clj_auditor", "submit_case_audit", "yield"];
	const submissionPort =
		typeof depsSet.collectSubmission === "function"
			? depsSet.collectSubmission
			: typeof depsSet.readSubmission === "function"
				? depsSet.readSubmission
				: createFileSubmissionReader({
						root: absoluteRoot,
						slug,
						batchId,
						directory: depsSet.submissionDirectory,
					});
	const auditorDeps = { ...depsSet, collectSubmission: submissionPort };

	const batchController = new AbortController();
	const parentSignal = depsSet.signal;
	const parentAbort = () => {
		batchController.abort(parentSignal?.reason ?? "parent aborted");
	};
	if (parentSignal?.aborted) parentAbort();
	else parentSignal?.addEventListener("abort", parentAbort, { once: true });
	if (parentSignal?.aborted) parentAbort();

	const records = [];
	const onBatchAbort = () => {
		const reason = batchController.signal.reason ?? "batch aborted";
		for (const record of records) {
			abortAuditRecord(record, reason, false);
		}
	};
	batchController.signal.addEventListener("abort", onBatchAbort, { once: true });

	const startTasks = [];
	for (let index = 0; index < specs.length; index += 1) {
		const spec = specs[index];
		startTasks.push(
			(async () => {
				const name = auditorName(slug, spec.case_id);
				const isolation = buildIsolation({
					root: absoluteRoot,
					slug,
					batchId,
					caseId: spec.case_id,
					timeoutMs,
					tools,
				});
				const evidenceDir = join(absoluteRoot, isolation.evidenceDir);
				const artifactsDir = join(absoluteRoot, isolation.artifactsDir);
				const setupErrors = [];
				const record = {
					caseId: spec.case_id,
					name,
					agentId: null,
					status: "starting",
					evidenceDir: isolation.evidenceDir,
					artifactsDir: isolation.artifactsDir,
					startedAt: now(),
					finishedAt: null,
					submission: null,
					submissions: [],
					receipts: [],
					submissionSource: null,
					validation: null,
					error: null,
					now,
					controller: new AbortController(),
					handle: null,
					started: null,
					startFailure: null,
					spawnAttempted: false,
					doneSettled: false,
					exitConfirmed: false,
					timer: null,
					timeoutPromise: null,
					abortPromise: null,
					cancelled: false,
					timedOut: false,
				};

				record.abortPromise = new Promise((resolveAbort) => {
					record.resolveAbort = resolveAbort;
				});
				record.controller.signal.addEventListener(
					"abort",
					() => record.resolveAbort({ kind: record.timedOut ? "timeout" : "aborted" }),
					{ once: true },
				);
				record.timeoutPromise = new Promise((resolveTimeout) => {
					record.timer = setTimeout(() => {
						const reason = herdError(":AUDIT_TIMEOUT", `${spec.case_id}: audit timed out after ${timeoutMs}ms`, {
							caseId: spec.case_id,
							timeoutMs,
						});
						abortAuditRecord(record, reason, true);
						resolveTimeout({ kind: "timeout" });
					}, timeoutMs);
					record.timer.unref?.();
				});
				if (record.controller.signal.aborted) {
					record.resolveAbort({ kind: record.timedOut ? "timeout" : "aborted" });
				}
				records.push(record);

				if (batchController.signal.aborted) {
					abortAuditRecord(record, batchController.signal.reason ?? "batch aborted", false);
					record.started = Promise.resolve(null);
					return;
				}

				for (const directory of [evidenceDir, artifactsDir]) {
					const problem = prepareDirectory(directory, { root: absoluteRoot });
					if (problem !== null) setupErrors.push(problem);
				}
				const submissionRelative = `.herd/missions/${slug}/audit/${batchId}/${spec.case_id}.submit.edn`;
				try {
					await writeEdnAtomic(join(artifactsDir, "audit-context.edn"), {
						"batch-id": batchId,
						"case-id": spec.case_id,
						slug,
						"workspace-root": absoluteRoot,
						"read-only-workspace": true,
						"submission-path": submissionRelative,
						"artifacts-dir": artifactsDir,
						"evidence-dir": evidenceDir,
					});
				} catch (error) {
					setupErrors.push(
						failure("INVALID_ARGUMENT", `${spec.case_id}: audit context cannot be written: ${messageOf(error)}`, {
							caseId: spec.case_id,
							path: join(artifactsDir, "audit-context.edn"),
						}),
					);
				}
				if (setupErrors.length > 0) {
					record.error = setupErrors[0];
					record.startFailure = setupErrors[0];
					globalErrors.push(...setupErrors);
					record.started = Promise.resolve(null);
					return;
				}

				const submissionSchema = submissionSchemaFor(spec.case_id);
				const confirmationSchema = confirmationSchemaFor(spec.case_id);
				const promptCaseSpec = publicCaseSpec(spec);
				let promptCandidate;
				try {
					promptCandidate = depsSet.buildPrompt({
						slug,
						caseSpec: promptCaseSpec,
						isolation,
						submissionSchema,
						auditorName: name,
					});
				} catch (error) {
					globalErrors.push(
						failure("INVALID_ARGUMENT", `${spec.case_id}: the injected prompt builder failed: ${messageOf(error)}`, {
							caseId: spec.case_id,
							field: "deps.buildPrompt",
						}),
					);
					promptCandidate = null;
				}
				if (promptCandidate !== null && typeof promptCandidate?.then === "function") {
					globalErrors.push(
						failure("INVALID_ARGUMENT", `${spec.case_id}: deps.buildPrompt must return synchronously`, {
							caseId: spec.case_id,
							field: "deps.buildPrompt",
						}),
					);
					promptCandidate = null;
				}
				if (typeof promptCandidate !== "string" || promptCandidate.trim() === "") {
					const failureError = failure(
						"INVALID_ARGUMENT",
						`${spec.case_id}: deps.buildPrompt returned an empty prompt`,
						{
							caseId: spec.case_id,
							field: "deps.buildPrompt",
						},
					);
					globalErrors.push(failureError);
					record.startFailure = failureError;
					record.started = Promise.resolve(null);
					return;
				}
				const prompt = ensureIsolationPaths(ensureYieldConfirmation(promptCandidate), isolation);
				const systemPrompt =
					typeof depsSet.systemPrompt === "string" && depsSet.systemPrompt.trim() !== ""
						? depsSet.systemPrompt
						: defaultSystemPrompt();
				let roleNonce;
				try {
					roleNonce =
						typeof depsSet.roleNonceFor === "function"
							? depsSet.roleNonceFor(spec.case_id)
							: typeof depsSet.roleNonce === "string"
								? depsSet.roleNonce
								: freshRoleNonce(newId, index);
				} catch (error) {
					globalErrors.push(
						failure("INVALID_ARGUMENT", `${spec.case_id}: the role nonce port failed: ${messageOf(error)}`, {
							caseId: spec.case_id,
							field: "deps.roleNonceFor",
						}),
					);
					roleNonce = freshRoleNonce(newId, index);
				}
				if (typeof roleNonce !== "string" || !NONCE_PATTERN.test(roleNonce)) {
					globalErrors.push(
						failure("INVALID_ARGUMENT", `${spec.case_id}: the role nonce must be 8-128 URL-safe characters`, {
							caseId: spec.case_id,
							field: "deps.roleNonce",
						}),
					);
					roleNonce = freshRoleNonce(newId, index);
				}
				const options = {
					role: "Manual Auditor",
					name,
					description: `Independent manual audit for ${spec.case_id}`,
					systemPrompt,
					task: prompt,
					assignment: prompt,
					cwd: absoluteRoot,
					tools,
					model: depsSet.model,
					modelRegistry: depsSet.modelRegistry,
					parentActiveModelPattern: depsSet.parentActiveModelPattern,
					settings: depsSet.settings,
					signal: record.controller.signal,
					parent: depsSet.parentHandle ?? depsSet.parent,
					sessionFile: depsSet.parentSessionFile ?? depsSet.sessionFile,
					eventBus: depsSet.eventBus,
					artifactsDir,
					requireArtifacts: true,
					visible: true,
					restrictToolNames: false,
					enableMCP: false,
					enableLsp: false,
					enableIrc: false,
					capabilities: depsSet.capabilities,
					preloadedExtensionPaths: depsSet.preloadedExtensionPaths,
					preloadedCustomToolPaths: depsSet.preloadedCustomToolPaths,
					allowExtensionDiscovery: depsSet.allowExtensionDiscovery,
					outputSchema: confirmationSchema,
					outputSchemaMode: "strict",
					timeoutMs,
					maxRuntimeMs,
					index,
					taskDepth: Number.isInteger(depsSet.taskDepth) ? depsSet.taskDepth : 0,
					roleNonce,
					allowModelFallback: depsSet.allowModelFallback === true,
				};
				if (now() - record.startedAt >= timeoutMs) {
					const reason = herdError(":AUDIT_TIMEOUT", `${spec.case_id}: audit timed out during setup`, {
						caseId: spec.case_id,
						timeoutMs,
					});
					abortAuditRecord(record, reason, true);
					record.started = Promise.resolve(null);
					return;
				}
				record.spawnAttempted = true;
				try {
					const started = starter.start(options);
					record.started = Promise.resolve(started);
					if (isPlainObject(started) && started.handle !== undefined) record.handle = started.handle;
					if (isPlainObject(started) && started.agentId !== undefined) record.agentId = started.agentId;
				} catch (error) {
					record.startFailure = normalizeError(
						error,
						"AGENT_SPAWN_FAILED",
						`${spec.case_id}: the auditor failed to start`,
					);
					globalErrors.push(record.startFailure);
				}
			})(),
		);
	}
	await Promise.all(startTasks);

	async function finishRecord(record) {
		try {
			if (record.startFailure !== null) {
				record.exitConfirmed = !record.spawnAttempted;
				auditorResultError(record, "AGENT_SPAWN_FAILED", `${record.caseId}: the auditor failed to start`, {
					cause: record.startFailure.message,
				});
				return record;
			}
			const startOutcome = await Promise.race([
				Promise.resolve(record.started).then(
					(value) => ({ kind: "started", value }),
					(error) => ({ kind: "start-error", error }),
				),
				record.timeoutPromise,
				record.abortPromise,
			]);
			if (record.timedOut || startOutcome.kind === "timeout") {
				abortLateStart(
					record,
					herdError(":AUDIT_TIMEOUT", `${record.caseId}: audit timed out after ${timeoutMs}ms`, {
						caseId: record.caseId,
						timeoutMs,
					}),
				);
				record.exitConfirmed = await confirmLateExit(record);
				auditorResultError(record, "AUDIT_TIMEOUT", `${record.caseId}: audit timed out after ${timeoutMs}ms`, {
					timeoutMs,
				});
				return record;
			}
			if (record.cancelled || batchController.signal.aborted || startOutcome.kind === "aborted") {
				abortLateStart(record, batchController.signal.reason ?? "batch aborted");
				record.exitConfirmed = await confirmLateExit(record);
				auditorResultError(record, "AUDIT_ABORTED", `${record.caseId}: audit was aborted`, {
					reason: String(batchController.signal.reason ?? "aborted"),
				});
				return record;
			}
			if (startOutcome.kind === "start-error") {
				record.exitConfirmed = !record.spawnAttempted;
				auditorResultError(record, "AGENT_SPAWN_FAILED", `${record.caseId}: the auditor failed`, {
					cause: messageOf(startOutcome.error),
				});
				return record;
			}
			const started = startOutcome.value;
			if (started === null || started === undefined || !("done" in Object(started))) {
				record.exitConfirmed = !record.spawnAttempted;
				auditorResultError(record, "HOST_API_MISMATCH", `${record.caseId}: runtime.start returned no done handle`, {});
				return record;
			}
			record.handle = started.handle ?? record.handle;
			record.agentId = started.agentId ?? started.handle?.agentId ?? record.agentId;
			if (record.timedOut) {
				started.handle?.abort?.(
					herdError(":AUDIT_TIMEOUT", `${record.caseId}: audit timed out after ${timeoutMs}ms`, {
						caseId: record.caseId,
						timeoutMs,
					}),
				);
				record.exitConfirmed = await waitForExitConfirmation(started, record);
				auditorResultError(record, "AUDIT_TIMEOUT", `${record.caseId}: audit timed out after ${timeoutMs}ms`, {
					timeoutMs,
				});
				return record;
			}
			if (batchController.signal.aborted) {
				started.handle?.abort?.(batchController.signal.reason ?? "batch aborted");
				record.exitConfirmed = await waitForExitConfirmation(started, record);
				auditorResultError(record, "AUDIT_ABORTED", `${record.caseId}: audit was aborted`, {
					reason: String(batchController.signal.reason ?? "aborted"),
				});
				return record;
			}

			const donePromise = Promise.resolve(started.done).then(
				(result) => {
					record.doneSettled = true;
					record.exitConfirmed = true;
					return { kind: "done", result };
				},
				(error) => {
					record.doneSettled = true;
					record.exitConfirmed = true;
					return { kind: "threw", error };
				},
			);
			donePromise.catch(() => {});
			const outcome = await Promise.race([donePromise, record.timeoutPromise, record.abortPromise]);

			if (record.timedOut || outcome.kind === "timeout") {
				started.handle?.abort?.(
					herdError(":AUDIT_TIMEOUT", `${record.caseId}: audit timed out after ${timeoutMs}ms`, {
						caseId: record.caseId,
						timeoutMs,
					}),
				);
				record.exitConfirmed = await waitForExitConfirmation(started, record);
				auditorResultError(record, "AUDIT_TIMEOUT", `${record.caseId}: audit timed out after ${timeoutMs}ms`, {
					timeoutMs,
				});
				return record;
			}
			if (record.cancelled || batchController.signal.aborted) {
				started.handle?.abort?.(batchController.signal.reason ?? "batch aborted");
				record.exitConfirmed = await waitForExitConfirmation(started, record);
				auditorResultError(record, "AUDIT_ABORTED", `${record.caseId}: audit was aborted`, {
					reason: String(batchController.signal.reason ?? "aborted"),
				});
				return record;
			}
			if (outcome.kind === "threw") {
				const code = outcome.error?.code;
				const timeoutLike = outcome.error?.data?.timeoutMs !== undefined || /timeout/i.test(messageOf(outcome.error));
				if (code === ERROR_CODES.UPSTREAM_ABORTED && timeoutLike && !record.cancelled) {
					auditorResultError(record, "AUDIT_TIMEOUT", `${record.caseId}: audit timed out`, {
						timeoutMs,
					});
				} else if (code === ERROR_CODES.UPSTREAM_ABORTED) {
					auditorResultError(record, "AUDIT_ABORTED", `${record.caseId}: audit was aborted`, {
						reason: messageOf(outcome.error),
					});
				} else {
					auditorResultError(record, "AGENT_SPAWN_FAILED", `${record.caseId}: the auditor run threw`, {
						cause: messageOf(outcome.error),
					});
				}
				return record;
			}

			const result = outcome.result;
			if (isPlainObject(result) && typeof result.agentId === "string") record.agentId = result.agentId;
			const abortedResult =
				isPlainObject(result) && result.aborted === true
					? result
					: isPlainObject(result?.result) && result.result.aborted === true
						? result.result
						: null;
			if (abortedResult !== null) {
				const timeoutLike =
					record.timedOut ||
					/timeout/i.test(typeof abortedResult.abortReason === "string" ? abortedResult.abortReason : "");
				if (timeoutLike) {
					auditorResultError(record, "AUDIT_TIMEOUT", `${record.caseId}: audit timed out`, { timeoutMs });
				} else {
					auditorResultError(record, "AUDIT_ABORTED", `${record.caseId}: audit was aborted`, {
						reason: typeof abortedResult.abortReason === "string" ? abortedResult.abortReason : "aborted",
					});
				}
				return record;
			}
			if (isPlainObject(result) && result.ok === false) {
				const code = result.error?.code;
				const timeoutLike = result.error?.data?.timeoutMs !== undefined || /timeout/i.test(result.error?.message ?? "");
				if (code === ERROR_CODES.UPSTREAM_ABORTED && timeoutLike && !record.cancelled) {
					auditorResultError(record, "AUDIT_TIMEOUT", `${record.caseId}: audit timed out`, {
						timeoutMs,
					});
				} else if (code === ERROR_CODES.UPSTREAM_ABORTED) {
					auditorResultError(record, "AUDIT_ABORTED", `${record.caseId}: audit was aborted`, {
						reason: result.error?.message ?? "upstream aborted",
					});
				} else {
					record.status = "crashed";
					record.error = normalizeError(result.error, "AGENT_SPAWN_FAILED", `${record.caseId}: the auditor run failed`);
					record.finishedAt = now();
				}
				return record;
			}
			const nestedResult = isPlainObject(result?.result) ? result.result : undefined;
			const exitCode = result?.exitCode ?? nestedResult?.exitCode;
			const rawError = result?.error ?? nestedResult?.error;
			const hasRawError = rawError !== undefined && rawError !== null && rawError !== false && rawError !== "";
			if ((exitCode !== undefined && exitCode !== 0) || hasRawError) {
				record.status = "crashed";
				record.error = normalizeError(
					rawError,
					"AGENT_SPAWN_FAILED",
					`${record.caseId}: the auditor run failed with exit code ${String(exitCode ?? "unknown")}`,
				);
				record.finishedAt = now();
				return record;
			}
			const fallback = result?.resolvedModelIsFallback === true || nestedResult?.resolvedModelIsFallback === true;
			if (fallback && depsSet.allowModelFallback !== true) {
				record.status = "crashed";
				record.error = failure(
					"MODEL_FALLBACK",
					`${record.caseId}: the auditor resolved to an unauthorized fallback model`,
					{
						caseId: record.caseId,
					},
				);
				record.finishedAt = now();
				return record;
			}

			const collection = collectAuditorSubmission({
				caseId: record.caseId,
				auditor: publicAuditorRecord(record),
				outcome: result,
				deps: auditorDeps,
				batchId,
			});
			const collectionOutcome = await Promise.race([
				collection.then(
					(value) => ({ kind: "collected", value }),
					(error) => ({ kind: "collection-error", error }),
				),
				record.timeoutPromise,
				record.abortPromise,
			]);
			if (record.timedOut || collectionOutcome.kind === "timeout") {
				record.exitConfirmed = true;
				auditorResultError(record, "AUDIT_TIMEOUT", `${record.caseId}: audit timed out after ${timeoutMs}ms`, {
					timeoutMs,
				});
				return record;
			}
			if (record.cancelled || batchController.signal.aborted || collectionOutcome.kind === "aborted") {
				record.exitConfirmed = true;
				auditorResultError(record, "AUDIT_ABORTED", `${record.caseId}: audit was aborted`, {
					reason: String(batchController.signal.reason ?? "aborted"),
				});
				return record;
			}
			if (collectionOutcome.kind === "collection-error") {
				record.exitConfirmed = true;
				auditorResultError(record, "AGENT_SPAWN_FAILED", `${record.caseId}: the submission collector threw`, {
					cause: messageOf(collectionOutcome.error),
				});
				return record;
			}
			const collected = collectionOutcome.value;
			if (record.timedOut) {
				record.exitConfirmed = true;
				auditorResultError(record, "AUDIT_TIMEOUT", `${record.caseId}: audit timed out after ${timeoutMs}ms`, {
					timeoutMs,
				});
				return record;
			}
			if (record.cancelled || batchController.signal.aborted) {
				record.exitConfirmed = true;
				auditorResultError(record, "AUDIT_ABORTED", `${record.caseId}: audit was aborted`, {
					reason: String(batchController.signal.reason ?? "aborted"),
				});
				return record;
			}
			record.submissions = Array.isArray(collected.submissions) ? collected.submissions : [];
			record.receipts = Array.isArray(collected.receipts) ? collected.receipts : [];
			if (collected.duplicate === true) {
				record.exitConfirmed = true;
				record.submission = null;
				record.submissionSource = collected.source ?? null;
				record.status = "duplicate_submission";
				record.error = collected.error;
				record.finishedAt = now();
				return record;
			}
			if (!collected.ok) {
				record.exitConfirmed = true;
				record.status = "missing_submission";
				record.error = collected.error;
				record.finishedAt = now();
				return record;
			}
			record.submission = collected.submission;
			record.submissionSource = collected.source ?? null;
			record.status = "submitted";
			record.exitConfirmed = true;
			record.finishedAt = now();
			return record;
		} finally {
			clearTimeout(record.timer);
		}
	}

	const finished = await Promise.all(
		records.map((record) =>
			finishRecord(record).catch((error) => {
				record.exitConfirmed = record.doneSettled === true;
				auditorResultError(record, "AGENT_SPAWN_FAILED", `${record.caseId}: the auditor runner threw`, {
					cause: messageOf(error),
				});
				globalErrors.push(record.error);
				return record;
			}),
		),
	);
	batchController.signal.removeEventListener("abort", onBatchAbort);
	parentSignal?.removeEventListener("abort", parentAbort);

	const duplicateSubmissionCases = [];
	for (const record of finished) {
		if (record.status !== "duplicate_submission") continue;
		if (!duplicateSubmissionCases.includes(record.caseId)) duplicateSubmissionCases.push(record.caseId);
		if (record.error) globalErrors.push(record.error);
	}
	const uncertainCases = finished.filter((record) => record.exitConfirmed !== true).map((record) => record.caseId);
	const uncertain = uncertainCases.length > 0;
	let uncertainError = null;
	if (uncertain) {
		uncertainError = failure(
			"STALLED",
			"one or more auditor runtimes did not confirm exit; the batch is uncertain and cannot be closed",
			{ caseIds: uncertainCases },
		);
		globalErrors.push(uncertainError);
	}
	const snapshotAfter = uncertain ? null : snapshotWorkspace(absoluteRoot);
	const rawSubmissions = finished
		.filter((record) => isPlainObject(record.submission))
		.map((record) => record.submission);
	let validation;
	if (uncertain) {
		validation = {
			ok: false,
			errors: [uncertainError],
			workspaceMutated: null,
			snapshotChecked: false,
			submissions: rawSubmissions.map((entry) => ({
				...entry,
				validation: { ok: false, errors: [uncertainError] },
			})),
			validCount: 0,
			invalidCount: rawSubmissions.length,
		};
	} else {
		validation = validateSubmissions({
			caseSpecs: specs.map(publicCaseSpec),
			submissions: rawSubmissions,
			snapshotBefore,
			snapshotAfter,
			root: absoluteRoot,
			slug,
		});
	}

	const missingCases = [];
	const unknownCases = [];
	const duplicateCases = [];
	const counts = new Map();
	for (const record of finished) {
		if (!isPlainObject(record.submission)) {
			missingCases.push(record.caseId);
			continue;
		}
		const submittedId = typeof record.submission.case_id === "string" ? record.submission.case_id.trim() : "";
		const count = (counts.get(submittedId) ?? 0) + 1;
		counts.set(submittedId, count);
	}
	for (const [caseId, count] of counts) {
		if (!specs.some((spec) => spec.case_id === caseId)) {
			if (!unknownCases.includes(caseId)) unknownCases.push(caseId);
		}
		if (count > 1 && !duplicateCases.includes(caseId)) duplicateCases.push(caseId);
	}
	for (const spec of specs) {
		if (!counts.has(spec.case_id) && !missingCases.includes(spec.case_id)) missingCases.push(spec.case_id);
	}
	if (missingCases.length > 0) {
		for (const caseId of missingCases) {
			if (duplicateSubmissionCases.includes(caseId)) continue;
			globalErrors.push(failure("AUDIT_MISSING", `${caseId}: no audit submission was collected`, { caseId }));
		}
	}
	if (unknownCases.length > 0) {
		for (const caseId of unknownCases) {
			globalErrors.push(failure("AUDIT_UNKNOWN_CASE", `${caseId}: no such CASE in s2-cases.edn`, { caseId }));
		}
	}
	if (duplicateCases.length > 0) {
		for (const caseId of duplicateCases) {
			globalErrors.push(
				failure("AUDIT_DUPLICATE_CASE", `${caseId}: more than one auditor submitted this CASE`, { caseId }),
			);
		}
	}
	if (batchController.signal.aborted) {
		globalErrors.push(failure("AUDIT_ABORTED", "the audit batch was aborted; no submission can be accepted", {}));
	}
	if (snapshotAfter !== null && !snapshotAfter.ok) globalErrors.push(...snapshotAfter.errors);
	if (globalErrors.length > 0) {
		// T4 sees only per-submission validation receipts. A batch-level failure
		// (missing CASE, setup error, cancellation, unusable after-snapshot) must
		// therefore poison every receipt, or a high score could hide it.
		for (const entry of validation.submissions) {
			const prior = isPlainObject(entry.validation) ? entry.validation : { ok: true, errors: [] };
			const priorErrors = Array.isArray(prior.errors) ? prior.errors : [];
			entry.validation = { ok: false, errors: [...priorErrors, ...globalErrors] };
		}
		validation.ok = false;
	}

	const byCase = new Map();
	for (const entry of validation.submissions) {
		if (typeof entry.case_id === "string" && entry.case_id !== "") byCase.set(entry.case_id, entry);
	}
	for (const record of finished) {
		const entry = byCase.get(record.caseId);
		if (isPlainObject(record.submission) && entry !== undefined) record.validation = entry.validation;
		if (isPlainObject(record.submission)) {
			const submittedId = typeof record.submission.case_id === "string" ? record.submission.case_id.trim() : "";
			if (submittedId !== record.caseId) {
				record.validation = {
					ok: false,
					errors: [
						failure("AUDIT_UNKNOWN_CASE", `${record.caseId}: the auditor submitted CASE ${submittedId || "<empty>"}`, {
							caseId: record.caseId,
							submittedCaseId: submittedId || null,
						}),
					],
				};
			}
		}
	}

	const ok =
		!uncertain &&
		!batchController.signal.aborted &&
		globalErrors.length === 0 &&
		validation.ok &&
		snapshotAfter?.ok &&
		missingCases.length === 0 &&
		unknownCases.length === 0 &&
		duplicateCases.length === 0 &&
		duplicateSubmissionCases.length === 0 &&
		finished.length === specs.length &&
		finished.every((record) => record.status === "submitted" && record.validation?.ok === true);
	const errors = [...new Set([...globalErrors, ...validation.errors])];
	const aggregateInput = uncertain
		? null
		: {
				caseSpecs: specs.map(publicCaseSpec),
				submissions: validation.submissions,
				snapshotBefore,
				snapshotAfter: snapshotAfter.ok ? snapshotAfter : null,
			};

	return {
		ok,
		state: uncertain ? "uncertain" : batchController.signal.aborted ? "aborted" : ok ? "completed" : "failed",
		uncertain,
		closureBlocked: !ok,
		uncertainCases,
		exitConfirmed: finished.every((record) => record.exitConfirmed === true),
		batchId,
		slug,
		root: absoluteRoot,
		caseSpecs: specs.map(publicCaseSpec),
		auditors: finished.map(auditorOutputRecord),
		submissions: validation.submissions,
		missingCases,
		unknownCases,
		duplicateCases,
		duplicateSubmissionCases,
		validation: {
			ok: !uncertain && validation.ok && globalErrors.length === 0 && snapshotAfter?.ok,
			errors,
			workspaceMutated: uncertain ? null : validation.workspaceMutated,
			snapshotChecked: !uncertain && validation.snapshotChecked && snapshotAfter?.ok,
		},
		snapshotBefore,
		snapshotAfter,
		workspaceMutated: uncertain ? null : validation.workspaceMutated || !snapshotAfter.ok,
		retryRequired: !ok,
		aggregateInput,
		errors,
		startedAt: now(),
		finishedAt: now(),
		durationMs: Math.max(0, now() - startedAt),
	};
}

function normalizeRepairCase(raw, index, invalidByCase) {
	if (!isPlainObject(raw)) return null;
	const rawCaseId = raw.caseId ?? raw.case_id;
	const caseId = typeof rawCaseId === "string" ? rawCaseId.trim() : "";
	if (!CASE_ID_PATTERN.test(caseId)) return null;
	const defects = Array.isArray(raw.defects)
		? raw.defects.filter((defect) => isText(defect)).map((defect) => defect.trim())
		: [];
	for (const problem of invalidByCase.get(caseId) ?? []) {
		if (!defects.includes(problem)) defects.push(problem);
	}
	const userScore = raw.userScore ?? raw.user_score;
	const developerScore = raw.developerScore ?? raw.developer_score;
	const score = raw.score ?? raw.final;
	const evidencePaths = raw.evidencePaths ?? raw.evidence_paths;
	return {
		caseId,
		case_id: caseId,
		path: typeof raw.path === "string" ? raw.path : "",
		threshold: typeof raw.threshold === "number" && Number.isFinite(raw.threshold) ? raw.threshold : null,
		userScore: typeof userScore === "number" && Number.isFinite(userScore) ? userScore : null,
		user_score: typeof userScore === "number" && Number.isFinite(userScore) ? userScore : null,
		developerScore: typeof developerScore === "number" && Number.isFinite(developerScore) ? developerScore : null,
		developer_score: typeof developerScore === "number" && Number.isFinite(developerScore) ? developerScore : null,
		score: typeof score === "number" && Number.isFinite(score) ? score : null,
		final: typeof score === "number" && Number.isFinite(score) ? score : null,
		evidencePaths: Array.isArray(evidencePaths) ? evidencePaths.filter((path) => isText(path)) : [],
		evidence_paths: Array.isArray(evidencePaths) ? evidencePaths.filter((path) => isText(path)) : [],
		defects: defects.length > 0 ? [...new Set(defects)] : ["the CASE did not pass its audit"],
		index,
	};
}

function repairSliceId(caseId, revision, used) {
	const base = `repair-${caseId
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")}-r${revision ?? 0}`;
	let candidate = base.slice(0, 64).replace(/-+$/g, "");
	if (candidate === "") candidate = `repair-case-r${revision ?? 0}`;
	let suffix = 2;
	while (used.has(candidate)) {
		const tail = `-${suffix}`;
		candidate = `${base.slice(0, 64 - tail.length).replace(/-+$/g, "")}${tail}`;
		suffix += 1;
	}
	used.add(candidate);
	return candidate;
}

/**
 * Turn the caller's aggregate verdict into repair work for the swarm.
 *
 * Input: the T4 `aggregate` result. Output:
 * `{ok, retryRequired, revision, nextRevision, repairSpec, repairSlices,
 * mappedCases, errors}`.
 *
 * - PASS returns no slices.
 * - INCOMPLETE, a contaminated snapshot, a missing submission, or any
 *   `retryRequired` flag returns `retryRequired: true` and no repair slices.
 *   An audit anomaly is not a code defect and must not be sent to builders.
 * - FAIL returns one repair proposal per failed CASE. Every proposal maps only
 *   that CASE, carries the defects, and depends on nothing, so the repairs can
 *   run in parallel. No stage document is modified; these objects are runtime
 *   repair proposals. The caller's RepairSpec is accepted in its snake_case
 *   form (`case_id`, `next_revision`, `failed_cases`) and in the equivalent
 *   camelCase form.
 *
 * The function never throws and never writes a file.
 */
export function deriveRepairSlices({ aggregateResult } = {}) {
	const errors = [];
	if (!isPlainObject(aggregateResult)) {
		return {
			ok: false,
			retryRequired: false,
			revision: null,
			nextRevision: null,
			repairSpec: null,
			repairSlices: [],
			mappedCases: [],
			errors: [
				failure("INVALID_ARGUMENT", "aggregateResult must be an aggregate result object", {
					field: "aggregateResult",
				}),
			],
		};
	}
	const result = aggregateResult;
	const repairSpec = isPlainObject(result.repairSpec) ? result.repairSpec : null;
	const revision =
		Number.isInteger(repairSpec?.revision) && repairSpec.revision >= 0 ? repairSpec.revision : null;
	const rawNextRevision = repairSpec?.nextRevision ?? repairSpec?.next_revision;
	const nextRevision =
		Number.isInteger(rawNextRevision) && rawNextRevision >= 0
			? rawNextRevision
			: revision === null
				? null
				: revision + 1;

	if (result.verdict === "PASS" || (result.ok === true && result.verdict !== "FAIL")) {
		return {
			ok: true,
			retryRequired: false,
			revision,
			nextRevision,
			repairSpec: null,
			repairSlices: [],
			mappedCases: [],
			errors: [],
		};
	}
	if (result.retryRequired === true || result.verdict === "INCOMPLETE") {
		const retryErrors = Array.isArray(result.invalid) && result.invalid.length > 0 ? [...result.invalid] : [];
		if (retryErrors.length === 0) {
			retryErrors.push(
				failure("AUDIT_MISSING", "the audit batch is incomplete and must be retried before code repair", {}),
			);
		}
		return {
			ok: false,
			retryRequired: true,
			revision,
			nextRevision,
			repairSpec: null,
			repairSlices: [],
			mappedCases: [],
			errors: retryErrors,
		};
	}
	if (result.verdict !== "FAIL") {
		return {
			ok: false,
			retryRequired: false,
			revision,
			nextRevision,
			repairSpec: null,
			repairSlices: [],
			mappedCases: [],
			errors: [
				failure("INVALID_ARGUMENT", `aggregateResult.verdict ${describe(result.verdict)} cannot derive repairs`, {
					field: "aggregateResult.verdict",
				}),
			],
		};
	}

	const invalidByCase = new Map();
	if (Array.isArray(result.invalid)) {
		for (const entry of result.invalid) {
			if (!isPlainObject(entry)) continue;
			const caseId = entry.caseId ?? entry.case_id;
			if (!isText(caseId)) continue;
			const list = invalidByCase.get(caseId) ?? [];
			if (isText(entry.message)) list.push(entry.message);
			invalidByCase.set(caseId, list);
		}
	}
	const rawCases = Array.isArray(repairSpec?.cases) ? repairSpec.cases : [];
	let cases = rawCases
		.map((entry, index) => normalizeRepairCase(entry, index, invalidByCase))
		.filter((entry) => entry !== null);
	if (cases.length === 0 && Array.isArray(result.rows)) {
		cases = result.rows
			.map((row, index) => {
				if (!isPlainObject(row) || row.passed === true) return null;
				return normalizeRepairCase(
					{
						caseId: row.caseId,
						path: row.path,
						threshold: row.threshold,
						userScore: row.userScore,
						developerScore: row.developerScore,
						score: row.score,
						evidencePaths: row.evidencePaths,
						defects: [],
					},
					index,
					invalidByCase,
				);
			})
			.filter((entry) => entry !== null);
	}
	if (cases.length === 0) {
		return {
			ok: false,
			retryRequired: false,
			revision,
			nextRevision,
			repairSpec: null,
			repairSlices: [],
			mappedCases: [],
			errors: [
				failure("INVALID_ARGUMENT", "aggregateResult is FAIL but carries no failed CASE detail", {
					field: "aggregateResult.repairSpec",
				}),
			],
		};
	}

	const missionSlug =
		typeof repairSpec?.slug === "string" && repairSpec.slug.trim() !== ""
			? repairSpec.slug.trim()
			: typeof result.slug === "string" && result.slug.trim() !== ""
				? result.slug.trim()
				: null;
	const usedIds = new Set();
	const repairSlices = cases.map((entry) => {
		const inputs =
			entry.evidencePaths.length > 0
				? entry.evidencePaths
				: missionSlug === null
					? []
					: [`.herd/missions/${missionSlug}/s2-cases.edn`];
		const defectText = entry.defects.join("; ");
		return {
			slice_id: repairSliceId(entry.caseId, nextRevision, usedIds),
			goal: `Repair ${entry.caseId} after the independent audit: ${defectText}`,
			inputs,
			depends_on: [],
			done_when:
				entry.threshold === null
					? `A fresh independent re-audit of ${entry.caseId} passes every defect and evidence check.`
					: `A fresh independent re-audit of ${entry.caseId} reaches at least ${entry.threshold}/100 for both user_score and developer_score with valid evidence and an unchanged workspace.`,
			mapped_cases: [entry.caseId],
			source: "audit-repair",
			derived: true,
			defects: entry.defects,
			threshold: entry.threshold,
			path: entry.path,
			user_score: entry.userScore,
			developer_score: entry.developerScore,
			final_score: entry.score,
			evidence_paths: entry.evidencePaths,
		};
	});
	const mappedCases = repairSlices.map((slice) => slice.mapped_cases[0]);
	const missionId =
		typeof repairSpec?.missionId === "string"
			? repairSpec.missionId
			: typeof repairSpec?.mission_id === "string"
				? repairSpec.mission_id
				: typeof result.missionId === "string"
					? result.missionId
					: null;
	const normalizedRepairSpec = {
		...(repairSpec ?? {}),
		missionId,
		mission_id: missionId,
		revision,
		nextRevision,
		next_revision: nextRevision,
		cases: cases.map(({ index, ...entry }) => entry),
		mappedCases,
		mapped_cases: mappedCases,
		failedCases: mappedCases,
		failed_cases: mappedCases,
	};

	return {
		ok: true,
		retryRequired: false,
		revision,
		nextRevision,
		repairSpec: normalizedRepairSpec,
		repairSlices,
		mappedCases,
		errors,
	};
}
