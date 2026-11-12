/**
 * T2: mission contract, stage freezing, realignment, and one-time approval.
 *
 * The module owns `.herd/missions/<slug>/mission.edn`, the stage documents
 * under `plans/<slug>/`, the asynchronous gate record `pending-gate.edn`, and
 * the per-call receipts under `receipts/`.
 *
 * Storage is injected:
 *   store.read()                  -> mission | null
 *   store.transaction(fn)         -> fn(current) -> {mission?, response, commit?}
 *   documents.readText(path)      -> {ok:true, text} | {ok:false, code, message}
 *   documents.writeText(path,text)-> {ok:true} | {ok:false, code, message}
 *   documents.remove(path)        -> {ok:true} | {ok:false, code, message}
 *   documents.listDir(path)       -> {ok:true, names} | {ok:false, code, message}
 *
 * The default ports use the shared atomic write and lock primitives. Tests and
 * the gate layer may inject a transactional store so two writers cannot race on
 * the mission revision.
 *
 * All public functions return `{ok:true, ...}` or
 * `{ok:false, error:{code, message, data}}`. Expected failures never throw.
 * A malformed `mission.edn`, a strange port, or a store protocol violation is
 * a failure, never an implicit "continue with defaults".
 *
 * Limits:
 * - Completion is issued only through the one-time process authority returned
 *   by `takeApprovalAuthority()`; its port is the only completion path.
 * - The approval token is `HMAC-SHA256(approval.key, mission-id:revision:
 *   contract-line:report-sha256)`. The framework writes a fresh random key to
 *   `.herd/missions/<slug>/approval.key` only inside the completion
 *   transaction, so editing `mission.edn` alone cannot mint an approval. The
 *   key persists next to the mission and a fresh process re-verifies with it.
 * - The key is the only approval control state. A missing, empty, or
 *   malformed key fails closed: the completed mission cannot be verified and
 *   cannot be reissued.
 * - T4 owns full CASE reconciliation, row/score checks, evidence checks, and
 *   snapshot comparison. The completion port only checks that the audit was
 *   PASS and that T4's second recheck passed and is bound to this mission,
 *   revision, and report.
 * - The mission lock serializes framework writers. A human edit of a stage
 *   file is not prevented; it is detected by the next hash check and must be
 *   accepted with `realign` before S5 may start or the mission may close.
 * - A receipt file is named by the call-id digest, so an arbitrary call-id
 *   cannot escape `receipts/`; the call-id itself is stored inside.
 * - Callers must give each gate phase its own call-id; the gate layer derives
 *   distinct save/freeze ids from one user call-id.
 * - Failed attempts do not write a receipt. Only a committed transition is
 *   replayed for the same call-id.
 */

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "../util/atomic-write.mjs";
import { herdError, isHerdError, messageOf, printEdn } from "../util/errors.mjs";
import { withLock } from "../util/file-lock.mjs";
import { normalizeCaseSpecs } from "./parsers.mjs";

export const STAGE_IDS = Object.freeze(["s1", "s2", "s3", "s4"]);
export const MISSION_STAGES = Object.freeze(["s1", "s2", "s3", "s4", "s5", "completed"]);

export const STAGE_DOCUMENTS = Object.freeze({
	s1: Object.freeze({ stage: "s1", file: "s1-brainstorm.md" }),
	s2: Object.freeze({ stage: "s2", file: "s2-manual-tests.md" }),
	s3: Object.freeze({ stage: "s3", file: "s3-dev-guide.md" }),
	s4: Object.freeze({ stage: "s4", file: "s4-coordination.md" }),
});

/** Seven control-state entries; this order is the contract-line order. */
export const FROZEN_KEYS = Object.freeze(["s1", "s1-summary", "s2", "s2-cases", "s3", "s3-modules", "s4"]);

export function controlPaths(slug) {
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new TypeError("invalid mission slug");
	return Object.freeze({
		missionDir: `.herd/missions/${slug}`,
		s1: `plans/${slug}/s1-brainstorm.md`,
		s1Summary: `.herd/missions/${slug}/s1-summary.md`,
		s2: `plans/${slug}/s2-manual-tests.md`,
		cases: `.herd/missions/${slug}/cases.edn`,
		s3: `plans/${slug}/s3-dev-guide.md`,
		s4: `plans/${slug}/s4-coordination.md`,
	});
}

export const CONTRACT_PREFIX = "Verification contract: MANUAL ACCEPTANCE —";
export const CONTRACT_SUFFIX =
	"execute every CASE and score min(user_score, developer_score) out of 100; automated tests are NOT acceptance evidence.";

const NEXT_STAGE = Object.freeze({ s1: "s2", s2: "s3", s3: "s4", s4: "s5" });
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HASH_RE = /^[0-9a-f]{64}$/i;
const REPORT_PATH = "s5-report.md";
const MAX_CALL_ID = 256;

/**
 * One-time approval issuance capabilities. Possession of this object is the
 * permission to create an approval port. `takeApprovalAuthority()` hands the
 * authority to the framework assembly exactly once.
 */
let approvalAuthorityTaken = false;

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isText(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeHash(value) {
	if (typeof value !== "string") return undefined;
	const text = value.trim().toLowerCase();
	return HASH_RE.test(text) ? text : undefined;
}

function canonicalJson(value) {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function clone(value) {
	return structuredClone(value);
}

function normalizeCallId(value) {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (text.length === 0 || text.length > MAX_CALL_ID) return null;
	if ([...text].some((character) => character.codePointAt(0) < 0x20)) return null;
	return text;
}

function callIdFrom(options) {
	if (!isPlainObject(options)) return undefined;
	return normalizeCallId(options.callId ?? options.call_id);
}

// ---------------------------------------------------------------------------
// Result helpers and error normalization
// ---------------------------------------------------------------------------

function keywordCode(code) {
	const name = typeof code === "string" && code.startsWith(":") ? code.slice(1) : String(code ?? "INVALID_ARGUMENT");
	return `:${name}`;
}

function failure(code, message, data = {}) {
	return {
		ok: false,
		error: {
			code: keywordCode(code),
			message: message === undefined || message === null ? "" : String(message),
			data: isPlainObject(data) ? data : {},
		},
	};
}

function codeOf(error) {
	if (isHerdError(error)) return error.code;
	if (typeof error?.code === "string" && error.code.startsWith(":")) return error.code;
	return ":INVALID_ARGUMENT";
}

function dataOf(error) {
	if (isHerdError(error) && isPlainObject(error.data)) return { ...error.data };
	const data = {};
	if (typeof error?.code === "string") data["system-code"] = error.code;
	return data;
}

function invalidArgument(message, data = {}) {
	return failure(":INVALID_ARGUMENT", message, data);
}

// ---------------------------------------------------------------------------
// Stage helpers
// ---------------------------------------------------------------------------

/**
 * Canonical stage id without the EDN colon. Accepts `s1`, `:s1`, `S1`, and
 * `1`. Returns `undefined` for anything else.
 */
export function normalizeStage(value) {
	if (typeof value === "number") {
		if (Number.isInteger(value) && value >= 1 && value <= 5) return `s${value}`;
		return undefined;
	}
	if (typeof value !== "string") return undefined;
	const text = value.trim().replace(/^:/, "").toLowerCase();
	if (MISSION_STAGES.includes(text)) return text;
	if (text === "5") return "s5";
	return undefined;
}

function stageValue(stage) {
	return `:${stage}`;
}

/**
 * Repository-relative path of one S1-S4 stage document.
 *
 * Throws on an invalid slug or a non-stage id: both are programmer errors, not
 * user input. Gate payload validation happens before this helper is called.
 */
export function stageDocumentPath(slug, stage) {
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new TypeError("invalid mission slug");
	const id = normalizeStage(stage);
	if (!STAGE_IDS.includes(id)) throw new TypeError("stage must be s1, s2, s3, or s4");
	return `plans/${slug}/${STAGE_DOCUMENTS[id].file}`;
}

function documentPath(root, slug, stage) {
	return join(root, stageDocumentPath(slug, stage));
}

function missionDirectory(root, slug) {
	return join(root, ".herd", "missions", slug);
}
function controlPath(root, slug, key) {
	return join(
		root,
		controlPaths(slug)[
			{
				s1: "s1",
				"s1-summary": "s1Summary",
				s2: "s2",
				"s2-cases": "cases",
				s3: "s3",
				s4: "s4",
				s4s: "s4",
			}[key]
		],
	);
}

function controlRelativePath(slug, key) {
	const paths = controlPaths(slug);
	if (key === "s1-summary") return paths.s1Summary;
	if (key === "s2-cases") return paths.cases;
	if (key === "s3-modules") return null;
	if (key === "s4-slices") return null;
	return paths[key];
}

function canonicalInlineBytes(value) {
	return printEdn(value, { indent: " " });
}

function canonicalEdnFile(value) {
	return `${printEdn(value, { indent: " " })}\n`;
}

function normalizeModuleRecord(entry) {
	if (!isPlainObject(entry)) return entry;
	return {
		path: entry.path,
		"secret-owned": entry["secret-owned"] ?? entry.secret_owned,
		"depends-on": entry["depends-on"] ?? entry.depends_on ?? [],
		"mapped-cases": entry["mapped-cases"] ?? entry.mapped_cases ?? [],
	};
}

function normalizeSliceRecord(entry) {
	if (!isPlainObject(entry)) return entry;
	return {
		"slice-id": entry["slice-id"] ?? entry.slice_id ?? entry.sliceId,
		goal: entry.goal,
		inputs: entry.inputs,
		"depends-on": entry["depends-on"] ?? entry.depends_on ?? [],
		"done-when": entry["done-when"] ?? entry.done_when,
		"mapped-cases": entry["mapped-cases"] ?? entry.mapped_cases ?? [],
	};
}

const CASE_INPUT_FIELDS = new Set(["case-id", "case_id", "path", "threshold", "steps", "expected", "rubric"]);

function toCaseSnake(entry, index) {
	if (!isPlainObject(entry)) return entry;
	for (const key of Object.keys(entry)) {
		if (!CASE_INPUT_FIELDS.has(key)) {
			throw herdError(":INVALID_ARGUMENT", `cases[${index}].${key} is not an allowed CASE field`, {
				field: `cases[${index}].${key}`,
				index,
			});
		}
	}
	const hasKebabId = Object.hasOwn(entry, "case-id");
	const hasSnakeId = Object.hasOwn(entry, "case_id");
	if (hasKebabId && hasSnakeId) {
		throw herdError(":INVALID_ARGUMENT", `cases[${index}] uses both case-id and case_id`, {
			field: `cases[${index}].case_id`,
			index,
		});
	}
	return {
		case_id: hasKebabId ? entry["case-id"] : entry.case_id,
		path: entry.path,
		threshold: entry.threshold,
		steps: entry.steps,
		expected: entry.expected,
		rubric: entry.rubric,
	};
}

function toCaseKebab(entry) {
	return {
		"case-id": entry.case_id,
		path: entry.path,
		threshold: entry.threshold,
		steps: [...entry.steps],
		expected: entry.expected,
		rubric: entry.rubric,
	};
}

function canonicalCases(value) {
	const normalized = normalizeCaseSpecs(Array.isArray(value) ? value.map(toCaseSnake) : value);
	if (!normalized.ok) {
		const first = normalized.errors?.[0];
		throw herdError(":INVALID_ARGUMENT", first?.message ?? "CASE dataset is invalid", {
			errors: normalized.errors ?? [],
		});
	}
	return normalized.cases.map(toCaseKebab);
}

function parseCasesDocument(text) {
	const value = parseEdn(text);
	if (!Array.isArray(value) || value.length === 0) {
		throw herdError(":INVALID_ARGUMENT", "cases.edn must hold a non-empty CASE vector", {});
	}
	return canonicalCases(value);
}

function caseIdsOf(cases) {
	return cases.map((entry) => entry["case-id"]);
}

function mappingProblem(cases, modules, slices) {
	const ids = new Set(caseIdsOf(cases));
	if (Array.isArray(modules)) {
		for (const module of modules) {
			if (!isPlainObject(module) || !Array.isArray(module["mapped-cases"])) continue;
			for (const caseId of module["mapped-cases"]) {
				if (!ids.has(caseId)) return { kind: "modules", caseId, reason: "unknown-case" };
			}
		}
		const covered = new Set(
			modules.flatMap((module) => (Array.isArray(module?.["mapped-cases"]) ? module["mapped-cases"] : [])),
		);
		const missing = [...ids].filter((caseId) => !covered.has(caseId));
		if (missing.length > 0) return { kind: "modules", missing, reason: "uncovered-cases" };
	}
	if (Array.isArray(slices)) {
		for (const slice of slices) {
			if (!isPlainObject(slice) || !Array.isArray(slice["mapped-cases"])) continue;
			for (const caseId of slice["mapped-cases"]) {
				if (!ids.has(caseId)) return { kind: "slices", caseId, reason: "unknown-case" };
			}
		}
		const covered = new Set(
			slices.flatMap((slice) => (Array.isArray(slice?.["mapped-cases"]) ? slice["mapped-cases"] : [])),
		);
		const missing = [...ids].filter((caseId) => !covered.has(caseId));
		if (missing.length > 0) return { kind: "slices", missing, reason: "uncovered-cases" };
	}
	return undefined;
}

function missionPath(root, slug) {
	return join(missionDirectory(root, slug), "mission.edn");
}

function pendingPath(root, slug) {
	return join(missionDirectory(root, slug), "pending-gate.edn");
}

function reportPath(root, slug, options = {}) {
	if (isText(options.reportPath)) return resolve(root, options.reportPath);
	return join(root, "plans", slug, REPORT_PATH);
}

function approvalKeyPath(root, slug) {
	return join(missionDirectory(root, slug), "approval.key");
}

function receiptKey(callId) {
	return callId;
}

function receiptPath(root, slug, key) {
	return join(missionDirectory(root, slug), "receipts", `${sha256(key)}.edn`);
}

function missionLockPath(root, slug) {
	return join(root, ".herd", "locks", `mission-${slug}.lock`);
}

// ---------------------------------------------------------------------------
// Contract line
// ---------------------------------------------------------------------------

/**
 * Render the contract line from the seven frozen control-state entries.
 * `:frozen` is authoritative; this line is only a deterministic view.
 */
export function buildContractLine(slug, frozen) {
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new TypeError("invalid mission slug");
	if (!isPlainObject(frozen)) throw new TypeError("frozen must be an object");
	const entries = [];
	for (const key of FROZEN_KEYS) {
		const entry = frozen[key];
		if (!isPlainObject(entry)) throw new TypeError(`frozen.${key} is missing`);
		const hash = normalizeHash(entry.sha256);
		if (!hash) throw new TypeError(`frozen.${key}.sha256 must be 64 hex characters`);
		if (key === "s3-modules") {
			if (entry.path !== undefined && entry.path !== null) {
				throw new TypeError("frozen.s3-modules is inline and must not carry a path");
			}
			entries.push(`s3-modules: inline sha256=${hash}`);
			continue;
		}
		const expected = controlRelativePath(slug, key);
		if (entry.path !== expected) throw new TypeError(`frozen.${key}.path must be ${expected}`);
		entries.push(`${key}: ${expected} sha256=${hash}`);
	}
	return `${CONTRACT_PREFIX} ${entries.join("; ")}; ${CONTRACT_SUFFIX}`;
}

/**
 * Parse the exact seven-entry contract line. The frozen map is returned only
 * for display/compatibility; callers must still verify the live files.
 */
export function parseContractLine(line) {
	if (typeof line !== "string" || line.includes("\n") || line.includes("\r")) {
		return invalidArgument("contract-line must be one line", { field: "contract-line" });
	}
	const text = line.trim();
	if (!text.startsWith(`${CONTRACT_PREFIX} `) || !text.endsWith(`; ${CONTRACT_SUFFIX}`)) {
		return failure(":CONTRACT_HASH_MISMATCH", "contract-line has an unknown prefix or suffix", {
			reason: "contract-line",
		});
	}
	const middle = text.slice(CONTRACT_PREFIX.length + 1, text.length - CONTRACT_SUFFIX.length - 2).trim();
	const parts = middle
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (parts.length !== FROZEN_KEYS.length) {
		return failure(":CONTRACT_HASH_MISMATCH", "contract-line must name all seven frozen entries", {
			reason: "contract-line",
			count: parts.length,
		});
	}
	const raw = [];
	let slug;
	for (let index = 0; index < FROZEN_KEYS.length; index += 1) {
		const key = FROZEN_KEYS[index];
		const part = parts[index];
		if (key === "s3-modules") {
			const match = /^s3-modules:\s+inline\s+sha256=([0-9a-fA-F]{64})$/.exec(part);
			if (!match) {
				return failure(":CONTRACT_HASH_MISMATCH", "contract-line s3-modules entry is malformed", {
					reason: "contract-line",
					entry: part,
				});
			}
			raw.push({ key, sha256: match[1].toLowerCase() });
			continue;
		}
		const match = new RegExp(`^${key}:\\s+(\\S+)\\s+sha256=([0-9a-fA-F]{64})$`).exec(part);
		if (!match) {
			return failure(":CONTRACT_HASH_MISMATCH", `contract-line entry ${key} is malformed`, {
				reason: "contract-line",
				key,
				entry: part,
			});
		}
		raw.push({ key, path: match[1], sha256: match[2].toLowerCase() });
		if (key === "s1") {
			const found = /^plans\/([^/]+)\/([^/]+)$/.exec(match[1]);
			if (!found) {
				return failure(":CONTRACT_HASH_MISMATCH", "contract-line s1 path is not canonical", {
					reason: "contract-line",
					path: match[1],
				});
			}
			slug = found[1];
		}
	}
	if (slug === undefined || !SLUG_RE.test(slug)) {
		return failure(":CONTRACT_HASH_MISMATCH", "contract-line names no mission", { reason: "contract-line" });
	}
	const frozen = {};
	for (const entry of raw) {
		const expected = controlRelativePath(slug, entry.key);
		if (expected !== null && entry.path !== expected) {
			return failure(":CONTRACT_HASH_MISMATCH", `contract-line ${entry.key} path is not canonical`, {
				reason: "contract-line",
				key: entry.key,
				expected,
				actual: entry.path,
			});
		}
		frozen[entry.key] = expected === null ? { sha256: entry.sha256 } : { path: entry.path, sha256: entry.sha256 };
	}
	return {
		ok: true,
		slug,
		frozen,
		hashes: Object.fromEntries(FROZEN_KEYS.map((key) => [key, frozen[key].sha256])),
	};
}

// ---------------------------------------------------------------------------
// Minimal EDN reader for the values printEdn emits
// ---------------------------------------------------------------------------

class EdnReader {
	constructor(text) {
		this.text = text;
		this.pos = 0;
	}

	done() {
		return this.pos >= this.text.length;
	}

	skip() {
		while (!this.done()) {
			const ch = this.text[this.pos];
			if (ch === ";" || ch === "," || /\s/.test(ch)) {
				if (ch === ";") {
					const end = this.text.indexOf("\n", this.pos);
					this.pos = end === -1 ? this.text.length : end + 1;
				} else {
					this.pos += 1;
				}
				continue;
			}
			if (ch === "^") {
				this.pos += 1;
				this.readValue();
				continue;
			}
			if (this.text.startsWith("#_", this.pos)) {
				this.pos += 2;
				this.readValue();
				continue;
			}
			break;
		}
	}

	readValue() {
		this.skip();
		if (this.done()) throw this.error("unexpected end of EDN");
		const ch = this.text[this.pos];
		if (ch === "{") return this.readMap();
		if (ch === "[") return this.readVector();
		if (ch === "(") return this.readVector();
		if (ch === '"') {
			if (this.text.startsWith('"""', this.pos)) {
				this.pos += 3;
				return this.readBlockString(0);
			}
			return this.readString();
		}
		if (ch === ":") return this.readKeyword();
		if (ch === "\\") return this.readCharacter();
		if (ch === "#") return this.readDispatch();
		if (ch === "^") {
			this.pos += 1;
			this.readValue();
			return this.readValue();
		}
		return this.readAtom();
	}

	readMap() {
		this.pos += 1;
		const result = {};
		while (true) {
			this.skip();
			if (this.done()) throw this.error("unterminated EDN map");
			if (this.text[this.pos] === "}") {
				this.pos += 1;
				return result;
			}
			const key = this.readValue();
			const name = typeof key === "string" ? key.replace(/^:/, "") : String(key);
			this.skip();
			if (this.done() || this.text[this.pos] === "}") throw this.error("EDN map key has no value");
			result[name] = this.readValue();
		}
	}

	readVector() {
		const close = this.text[this.pos] === "(" ? ")" : "]";
		this.pos += 1;
		const result = [];
		while (true) {
			this.skip();
			if (this.done()) throw this.error("unterminated EDN vector");
			if (this.text[this.pos] === close) {
				this.pos += 1;
				return result;
			}
			result.push(this.readValue());
		}
	}

	readString() {
		this.pos += 1;
		let result = "";
		while (!this.done()) {
			const ch = this.text[this.pos];
			this.pos += 1;
			if (ch === '"') return result;
			if (ch !== "\\") {
				result += ch;
				continue;
			}
			if (this.done()) throw this.error("unterminated string escape");
			const escaped = this.text[this.pos];
			this.pos += 1;
			if (escaped === "n") result += "\n";
			else if (escaped === "r") result += "\r";
			else if (escaped === "t") result += "\t";
			else if (escaped === "b") result += "\b";
			else if (escaped === "f") result += "\f";
			else if (escaped === "u") {
				const hex = this.text.slice(this.pos, this.pos + 4);
				if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.error("invalid unicode escape");
				result += String.fromCodePoint(Number.parseInt(hex, 16));
				this.pos += 4;
			} else {
				result += escaped;
			}
		}
		throw this.error("unterminated string");
	}

	readKeyword() {
		this.pos += 1;
		const token = this.readToken();
		if (token.length === 0) throw this.error("empty keyword");
		return `:${token}`;
	}

	readCharacter() {
		this.pos += 1;
		const token = this.readToken();
		if (token.startsWith("u") && /^u[0-9a-fA-F]{4}$/.test(token)) {
			return String.fromCodePoint(Number.parseInt(token.slice(1), 16));
		}
		if (token === "newline") return "\n";
		if (token === "space") return " ";
		if (token === "tab") return "\t";
		if (token.length === 0) throw this.error("empty character literal");
		return token[0];
	}

	readDispatch() {
		// The caller sits on '#'.
		if (this.text.startsWith("#_", this.pos)) {
			this.pos += 2;
			this.readValue();
			return this.readValue();
		}
		if (this.text.startsWith("#{", this.pos)) {
			this.pos += 2;
			const result = [];
			while (true) {
				this.skip();
				if (this.done()) throw this.error("unterminated EDN set");
				if (this.text[this.pos] === "}") {
					this.pos += 1;
					return result;
				}
				result.push(this.readValue());
			}
		}
		let hashes = 0;
		while (this.text[this.pos] === "#") {
			hashes += 1;
			this.pos += 1;
		}
		if (this.text.startsWith('"""', this.pos)) {
			this.pos += 3;
			return this.readBlockString(hashes);
		}
		if (this.text[this.pos] === '"') {
			this.pos += 1;
			return this.readLineRawString(hashes);
		}
		const tag = this.readToken();
		this.skip();
		if (tag.length === 0) throw this.error("empty dispatch tag");
		// Tags such as #inst and #uuid carry one value; the mission state does
		// not need the tag itself, only the payload.
		return this.readValue();
	}

	readLineRawString(hashes) {
		const close = `"${"#".repeat(hashes)}`;
		const end = this.text.indexOf(close, this.pos);
		if (end === -1) throw this.error("unterminated raw string");
		const value = this.text.slice(this.pos, end);
		this.pos = end + close.length;
		return value;
	}

	readBlockString(hashes) {
		const close = `"""${"#".repeat(hashes)}`;
		const end = this.text.indexOf(close, this.pos);
		if (end === -1) throw this.error("unterminated block string");
		let body = this.text.slice(this.pos, end);
		if (body.startsWith("\n")) body = body.slice(1);
		const lastBreak = body.lastIndexOf("\n");
		const indent = lastBreak === -1 ? "" : body.slice(lastBreak + 1);
		if (lastBreak !== -1) body = body.slice(0, lastBreak);
		const lines = body.split("\n").map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line));
		this.pos = end + close.length;
		return lines.join("\n");
	}

	readAtom() {
		const token = this.readToken();
		if (token === "nil") return null;
		if (token === "true") return true;
		if (token === "false") return false;
		if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?N?$/.test(token)) {
			return Number(token.replace(/N$/, ""));
		}
		if (token.length === 0) throw this.error("empty EDN atom");
		return token;
	}

	readToken() {
		const start = this.pos;
		while (!this.done()) {
			const ch = this.text[this.pos];
			if (/\s/.test(ch) || ch === "," || ch === ";" || ch === '"' || "{}[]()".includes(ch)) break;
			this.pos += 1;
		}
		return this.text.slice(start, this.pos);
	}

	error(message) {
		return new Error(`${message} at EDN offset ${this.pos}`);
	}
}

function parseEdn(text) {
	if (typeof text !== "string") throw new TypeError("EDN text must be a string");
	const reader = new EdnReader(text);
	const value = reader.readValue();
	reader.skip();
	if (!reader.done()) throw reader.error("unexpected trailing EDN input");
	return value;
}

// ---------------------------------------------------------------------------
// Storage ports
// ---------------------------------------------------------------------------

function readDiskMission(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw herdError(":INVALID_ARGUMENT", `mission.edn is unreadable: ${messageOf(error)}`, {
			path,
			"system-code": error?.code ?? null,
		});
	}
	try {
		const value = parseEdn(text);
		if (!isPlainObject(value)) {
			throw herdError(":INVALID_ARGUMENT", "mission.edn must hold one EDN map", { path });
		}
		return value;
	} catch (error) {
		if (isHerdError(error)) throw error;
		throw herdError(":INVALID_ARGUMENT", `mission.edn is not valid EDN: ${messageOf(error)}`, { path }, error);
	}
}

/**
 * Durable mission store for one mission. The transaction holds
 * `.herd/locks/mission-<slug>.lock` while it reads, transforms, and atomically
 * writes `mission.edn`, so two gate calls cannot both advance the revision.
 */
function createDiskMissionStore(root, slug, options = {}) {
	const path = missionPath(root, slug);
	const lockPath = missionLockPath(root, slug);
	return {
		async read() {
			return readDiskMission(path);
		},
		async transaction(fn) {
			const acquired = await withLock(
				lockPath,
				{
					purpose: "mission",
					token: randomUUID(),
					owner_agent_id: isText(options.agentId) ? options.agentId.trim() : undefined,
					started_at: new Date().toISOString(),
				},
				async () => {
					const current = readDiskMission(path);
					const outcome = await fn(current);
					if (outcome && outcome.commit !== false && outcome.mission !== undefined) {
						writeFileAtomic(dirname(path), "mission.edn", `${printEdn(outcome.mission, { indent: " " })}\n`);
					}
					return outcome?.response;
				},
			);
			if (!acquired.ok) {
				if (acquired.error) {
					return {
						ok: false,
						error: {
							code: acquired.error.code,
							message: acquired.error.message,
							data: {
								...(isPlainObject(acquired.error.data) ? acquired.error.data : {}),
								slug,
								reason: "mission-lock",
							},
						},
					};
				}
				return failure(":STAGE_MISMATCH", "mission is locked by another writer", {
					slug,
					reason: "mission-busy",
					lock: acquired.lock,
				});
			}
			return (
				acquired.value ?? invalidArgument("mission store returned no response", { slug, reason: "store-protocol" })
			);
		},
	};
}

/**
 * In-memory store for tests and for the gate layer when it already owns a
 * process-local transaction. One transaction runs at a time, mirroring the
 * mission lock.
 */
export function createMemoryMissionStore(options = {}) {
	const initial = isPlainObject(options) && options.initial !== undefined ? options.initial : null;
	let state = initial === null ? null : clone(initial);
	let tail = Promise.resolve();
	return {
		async read() {
			return state === null ? null : clone(state);
		},
		transaction(fn) {
			const run = tail.then(async () => {
				const current = state === null ? null : clone(state);
				const outcome = await fn(current);
				if (outcome && outcome.commit !== false && outcome.mission !== undefined) {
					state = clone(outcome.mission);
				}
				return outcome?.response;
			});
			tail = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		},
		snapshot() {
			return state === null ? null : clone(state);
		},
	};
}

function createDiskDocuments() {
	return {
		async readText(path) {
			try {
				return { ok: true, text: readFileSync(path, "utf8") };
			} catch (error) {
				return { ok: false, code: error?.code ?? "EIO", message: messageOf(error) };
			}
		},
		async writeText(path, text) {
			try {
				writeFileAtomic(dirname(path), basename(path), text);
				return { ok: true, path };
			} catch (error) {
				return { ok: false, code: error?.code ?? "EIO", message: messageOf(error) };
			}
		},
		async remove(path) {
			try {
				rmSync(path, { force: true });
				return { ok: true };
			} catch (error) {
				return { ok: false, code: error?.code ?? "EIO", message: messageOf(error) };
			}
		},
		async listDir(path) {
			try {
				const entries = readdirSync(path, { withFileTypes: true });
				return { ok: true, names: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name) };
			} catch (error) {
				if (error?.code === "ENOENT") return { ok: true, names: [] };
				return { ok: false, code: error?.code ?? "EIO", message: messageOf(error) };
			}
		},
	};
}

/**
 * In-memory documents port for tests. `files` keeps the exact text keyed by
 * the path the caller passes.
 */
export function createMemoryDocuments(options = {}) {
	const files = new Map();
	if (isPlainObject(options) && isPlainObject(options.files)) {
		for (const [path, text] of Object.entries(options.files)) {
			if (typeof text === "string") files.set(path, text);
		}
	}
	return {
		files,
		async readText(path) {
			if (!files.has(path)) return { ok: false, code: "ENOENT", message: "not found" };
			return { ok: true, text: files.get(path) };
		},
		async writeText(path, text) {
			files.set(path, String(text));
			return { ok: true, path };
		},
		async remove(path) {
			files.delete(path);
			return { ok: true };
		},
		async listDir(path) {
			const prefix = path.endsWith("/") ? path : `${path}/`;
			const names = new Set();
			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				const slash = rest.indexOf("/");
				if (slash > 0) names.add(rest.slice(0, slash));
			}
			return { ok: true, names: [...names] };
		},
	};
}

function resolveRoot(root) {
	if (typeof root !== "string" || root.trim().length === 0) {
		throw new TypeError("root must be a non-empty string");
	}
	return resolve(root);
}

function portsFor(root, slug, optionsInput = {}) {
	const options = isPlainObject(optionsInput) ? optionsInput : {};
	const store = options.store ?? createDiskMissionStore(root, slug, options);
	const documents = options.documents ?? createDiskDocuments();
	if (typeof store?.read !== "function" || typeof store?.transaction !== "function") {
		throw new TypeError("store must provide read() and transaction(fn)");
	}
	for (const method of ["readText", "writeText", "remove", "listDir"]) {
		if (typeof documents?.[method] !== "function") {
			throw new TypeError(`documents must provide ${method}()`);
		}
	}
	return {
		root,
		slug,
		store,
		documents,
		options,
		now: typeof options.now === "function" ? options.now : () => new Date().toISOString(),
	};
}

async function runTransaction(ports, fn) {
	try {
		const response = await ports.store.transaction(fn);
		if (response === undefined) {
			return invalidArgument("mission store returned no response", {
				slug: ports.slug,
				reason: "store-protocol",
			});
		}
		return response;
	} catch (error) {
		return failure(codeOf(error), messageOf(error), dataOf(error));
	}
}

async function readTextFile(documents, path) {
	let result;
	try {
		result = await documents.readText(path);
	} catch (error) {
		return { ok: false, kind: "io", message: messageOf(error), systemCode: error?.code ?? null };
	}
	if (result?.ok !== true) {
		const code = typeof result?.code === "string" ? result.code : "EIO";
		return {
			ok: false,
			kind: code === "ENOENT" ? "missing" : "io",
			message: typeof result?.message === "string" ? result.message : code,
			systemCode: code,
		};
	}
	if (typeof result.text !== "string") {
		return { ok: false, kind: "io", message: "readText did not return a string", systemCode: null };
	}
	if (result.text.trim().length === 0) {
		return { ok: false, kind: "empty", message: "file is empty", systemCode: null };
	}
	return { ok: true, text: result.text };
}

async function writeTextFile(documents, path, text) {
	try {
		const result = await documents.writeText(path, text);
		if (result?.ok !== true) {
			return invalidArgument(`could not write ${path}`, {
				reason: "document-write",
				path,
				"system-code": typeof result?.code === "string" ? result.code : null,
			});
		}
		return { ok: true };
	} catch (error) {
		return invalidArgument(`could not write ${path}: ${messageOf(error)}`, {
			reason: "document-write",
			path,
			"system-code": error?.code ?? null,
		});
	}
}

async function removeFile(documents, path) {
	try {
		const result = await documents.remove(path);
		if (result?.ok !== true) {
			return invalidArgument(`could not remove ${path}`, {
				reason: "document-remove",
				path,
				"system-code": typeof result?.code === "string" ? result.code : null,
			});
		}
		return { ok: true };
	} catch (error) {
		return invalidArgument(`could not remove ${path}: ${messageOf(error)}`, {
			reason: "document-remove",
			path,
			"system-code": error?.code ?? null,
		});
	}
}

async function readApprovalKey(documents, path) {
	const read = await readTextFile(documents, path);
	if (!read.ok) {
		return { ok: false, reason: read.kind, message: read.message };
	}
	const key = normalizeHash(read.text.trim());
	if (!key) {
		return { ok: false, reason: "invalid", message: "approval.key must contain 64 hex characters" };
	}
	return { ok: true, key };
}

// ---------------------------------------------------------------------------
// Mission shape, receipts, and preconditions
// ---------------------------------------------------------------------------

function normalizeApproval(raw) {
	if (!isPlainObject(raw)) return undefined;
	const issuedAt = raw["issued-at"] ?? raw.issuedAt;
	const reportSha256 = normalizeHash(raw.reportSha256 ?? raw["report-sha256"]);
	const token = normalizeHash(raw.token);
	if (!Number.isInteger(raw.revision) || raw.revision < 0) return undefined;
	if (!token || !reportSha256 || !isText(issuedAt)) return undefined;
	return { revision: raw.revision, token, reportSha256, issuedAt };
}

function approvalView(approval, missionId) {
	return {
		missionId,
		revision: approval.revision,
		token: approval.token,
		reportSha256: approval.reportSha256,
		issuedAt: approval["issued-at"] ?? approval.issuedAt,
	};
}

function missionShapeProblem(mission) {
	if (!isPlainObject(mission)) return failure(":INVALID_ARGUMENT", "mission must be an EDN map", {});
	if (!isText(mission["mission-id"])) {
		return failure(":INVALID_ARGUMENT", "mission.edn has no mission-id", { field: "mission-id" });
	}
	if (typeof mission.slug !== "string" || !SLUG_RE.test(mission.slug)) {
		return failure(":INVALID_ARGUMENT", "mission.edn has an invalid slug", { field: "slug" });
	}
	const stage = normalizeStage(mission.stage);
	if (!stage) return failure(":STAGE_MISMATCH", "mission.edn has an unknown stage", { stage: mission.stage });
	if (!Number.isInteger(mission.revision) || mission.revision < 0) {
		return failure(":STAGE_MISMATCH", "mission.edn revision must be a non-negative integer", {
			revision: mission.revision,
		});
	}
	if (!isText(mission["created-at"]) || !isText(mission["updated-at"])) {
		return failure(":INVALID_ARGUMENT", "mission.edn timestamps are missing", {});
	}
	if (!isPlainObject(mission.frozen)) {
		return failure(":INVALID_ARGUMENT", "mission.edn frozen must be a map", { field: "frozen" });
	}
	if (
		mission["contract-line"] !== null &&
		mission["contract-line"] !== undefined &&
		!isText(mission["contract-line"])
	) {
		return failure(":CONTRACT_HASH_MISMATCH", "mission.edn contract-line is malformed", {
			reason: "contract-line",
		});
	}
	if (stage === "completed") {
		const approval = normalizeApproval(mission.approval);
		if (!approval) {
			return failure(":APPROVAL_REQUIRED", "completed mission has no verifiable approval record", {
				reason: "completed-without-approval",
			});
		}
		if (!isText(mission["contract-line"])) {
			return failure(":APPROVAL_REQUIRED", "completed mission has no frozen contract line", {
				reason: "completed-without-contract",
			});
		}
		if (approval.revision !== mission.revision) {
			return failure(":APPROVAL_REQUIRED", "approval revision does not match the mission revision", {
				reason: "revision",
				expected: mission.revision,
				actual: approval.revision,
			});
		}
	} else if (mission.approval !== null && mission.approval !== undefined) {
		return failure(":APPROVAL_REQUIRED", "mission holds an approval before completion", {
			reason: "approval-before-completion",
		});
	}
	return undefined;
}

/**
 * Structural mission check. Approval presence is checked; the approval token
 * and the frozen documents are checked by `verifyApproval` and
 * `verifyContract`.
 */
export function validateMission(mission) {
	const problem = missionShapeProblem(mission);
	return problem ?? { ok: true };
}

function missionPrecondition(current, slug) {
	if (!current) {
		return failure(":STAGE_MISMATCH", `mission not found: ${slug}`, { slug, reason: "mission-missing" });
	}
	const invalid = validateMission(current);
	if (!invalid.ok) return invalid;
	if (current.slug !== slug) {
		return failure(":STAGE_MISMATCH", "mission slug does not match the requested slug", {
			slug,
			"mission-slug": current.slug,
			reason: "slug-mismatch",
		});
	}
	return { ok: true };
}

function recordReceipt(mission, key, payloadHash, receipt) {
	if (key === undefined) return;
	mission.receipts = isPlainObject(mission.receipts) ? mission.receipts : {};
	mission.receipts[key] = { "payload-hash": payloadHash, receipt: clone(receipt) };
}

function replayReceipt(mission, key, payloadHash, callId = key) {
	if (key === undefined) return undefined;
	const entry = isPlainObject(mission.receipts) ? mission.receipts[key] : undefined;
	if (!isPlainObject(entry)) return undefined;
	if (entry["payload-hash"] !== payloadHash) {
		return failure(":CALL_REPLAY_MISMATCH", "call-id was already used with a different payload", {
			"call-id": callId,
			"receipt-key": key,
			expected: entry["payload-hash"],
			actual: payloadHash,
		});
	}
	const receipt = clone(entry.receipt);
	if (isPlainObject(receipt)) receipt.replayed = true;
	return receipt;
}

async function writeReceiptFile(ports, record) {
	const text = `${printEdn(
		{
			"call-id": record.callId,
			op: record.op,
			"payload-hash": record.payloadHash,
			receipt: record.receipt,
		},
		{ indent: " " },
	)}\n`;
	try {
		await ports.documents.writeText(receiptPath(ports.root, ports.slug, record.key), text);
	} catch {
		// The mission receipt map is authoritative; the per-call file is a
		// human-readable mirror. A mirror failure must not turn a committed
		// gate into a reported failure.
	}
}

// ---------------------------------------------------------------------------
// Structure snapshots and realignment hints
// ---------------------------------------------------------------------------

function normalizeStructure(input) {
	if (input === undefined || input === null) return { ok: true, structure: null };
	if (!isPlainObject(input)) {
		return invalidArgument("structure must be an object of {cases, modules, slices}", { field: "structure" });
	}
	const result = { cases: [], modules: [], slices: [], supplied: [] };
	for (const category of ["cases", "modules", "slices"]) {
		const raw = input[category];
		if (raw === undefined) continue;
		if (!Array.isArray(raw)) {
			return invalidArgument(`structure.${category} must be an array`, { field: `structure.${category}` });
		}
		result.supplied.push(category);
		const seen = new Set();
		for (const entry of raw) {
			let id;
			if (typeof entry === "string") id = entry;
			else if (isPlainObject(entry)) {
				if (category === "cases") {
					if (Object.hasOwn(entry, "case_id") && Object.hasOwn(entry, "case-id")) {
						return invalidArgument("structure.cases entry cannot carry both case_id and case-id", {
							field: "structure.cases",
						});
					}
					id = entry.case_id ?? entry["case-id"];
				} else if (category === "modules") id = entry.path;
				else {
					if (Object.hasOwn(entry, "slice_id") && Object.hasOwn(entry, "slice-id")) {
						return invalidArgument("structure.slices entry cannot carry both slice_id and slice-id", {
							field: "structure.slices",
						});
					}
					id = entry.slice_id ?? entry["slice-id"];
				}
			}
			if (!isText(id)) {
				return invalidArgument(`structure.${category} entries need a non-empty id`, {
					field: `structure.${category}`,
				});
			}
			const text = id.trim();
			if (seen.has(text)) continue;
			seen.add(text);
			result[category].push(text);
		}
	}
	return { ok: true, structure: result };
}

function fenceState(line, fence) {
	if (fence) {
		const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
		if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) return undefined;
		return fence;
	}
	const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
	if (!opening) return null;
	return { char: opening[1][0], length: opening[1].length };
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scanStructure(markdown, declared) {
	const lines = markdown.split(/\r?\n/);
	const sections = [];
	const lineSections = [];
	const fenceFlags = [];
	const stack = [];
	const seenPaths = new Map();
	let fence;
	let current = { path: "<preamble>", line: 1, content: [] };
	sections.push(current);

	for (let index = 0; index < lines.length; index += 1) {
		const raw = lines[index];
		const nextFence = fenceState(raw, fence);
		fenceFlags[index] = Boolean(fence) || Boolean(nextFence);
		if (fence) {
			current.content.push(raw);
			lineSections[index] = current.path;
			fence = nextFence;
			continue;
		}
		if (nextFence) {
			current.content.push(raw);
			lineSections[index] = current.path;
			fence = nextFence;
			continue;
		}
		const heading = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(raw);
		if (!heading) {
			current.content.push(raw);
			lineSections[index] = current.path;
			continue;
		}
		const level = heading[1].length;
		const text = heading[2].trim().replace(/[ \t]+#+[ \t]*$/, "");
		while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
		stack.push({ level, text });
		const base = stack.map((entry) => entry.text).join(" > ");
		const count = (seenPaths.get(base) ?? 0) + 1;
		seenPaths.set(base, count);
		current = { path: count === 1 ? base : `${base} [${count}]`, line: index + 1, content: [] };
		sections.push(current);
		lineSections[index] = current.path;
	}

	const sectionRows = sections.map((section) => ({
		path: section.path,
		line: section.line,
		sha256: sha256(section.content.join("\n")),
	}));

	const ids = { cases: new Map(), modules: new Map(), slices: new Map() };
	const add = (category, id, section) => {
		if (!isText(id)) return;
		const text = id.trim();
		if (text.length === 0 || text.length > 256) return;
		const byId = ids[category];
		const set = byId.get(text) ?? new Set();
		set.add(section);
		byId.set(text, set);
	};
	const declaredIds = declared ?? { cases: [], modules: [], slices: [], supplied: [] };
	const mention = (category, id) => {
		const pattern = new RegExp(`\\b${escapeRegExp(id)}\\b`);
		const found = new Set();
		for (let index = 0; index < lines.length; index += 1) {
			if (fenceFlags[index]) continue;
			if (pattern.test(lines[index])) found.add(lineSections[index] ?? "<preamble>");
		}
		if (found.size === 0) add(category, id, "<undeclared>");
		else for (const section of found) add(category, id, section);
	};

	let scanFence;
	for (let index = 0; index < lines.length; index += 1) {
		const raw = lines[index];
		const nextFence = fenceState(raw, scanFence);
		if (scanFence) {
			scanFence = nextFence;
			continue;
		}
		if (nextFence) {
			scanFence = nextFence;
			continue;
		}
		const section = lineSections[index] ?? "<preamble>";
		for (const match of raw.matchAll(/CASE-[A-Za-z0-9_-]+/g)) add("cases", match[0], section);
		for (const match of raw.matchAll(/`([^`\n]+)`/g)) {
			const value = match[1].trim();
			if (value.includes("://") || value.includes("<") || value.includes(" ")) continue;
			if (/^[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+$/.test(value)) add("modules", value, section);
		}
		for (const match of raw.matchAll(/\bslice[ _-]?id\b\s*[:=]\s*[`|]?\s*([a-z0-9][a-z0-9_-]{0,63})\b/gi)) {
			add("slices", match[1], section);
		}
		if (/^ {0,3}#{1,6}[ \t]+/.test(raw)) {
			for (const match of raw.matchAll(/\bSlice\s+([a-z0-9][a-z0-9_-]{0,63})\b/g)) {
				add("slices", match[1], section);
			}
		}
	}

	for (const category of ["cases", "modules", "slices"]) {
		for (const id of declaredIds[category] ?? []) mention(category, id);
	}

	const sortedIds = {};
	const declaredSnapshot = {};
	const supplied = new Set(declaredIds.supplied ?? []);
	for (const category of ["cases", "modules", "slices"]) {
		const declaredOrder = declaredIds[category] ?? [];
		if (supplied.has(category)) {
			declaredSnapshot[category] = [...declaredOrder];
			sortedIds[category] = declaredOrder
				.map((id) => {
					const sectionSet = ids[category].get(id);
					return sectionSet ? { id, sections: [...sectionSet].sort() } : undefined;
				})
				.filter(Boolean);
			continue;
		}
		const declaredSet = new Set(declaredOrder);
		const entries = [];
		for (const id of declaredOrder) {
			const sectionSet = ids[category].get(id);
			if (sectionSet) entries.push({ id, sections: [...sectionSet].sort() });
		}
		const extras = [...ids[category].entries()]
			.filter(([id]) => !declaredSet.has(id))
			.map(([id, sectionSet]) => ({ id, sections: [...sectionSet].sort() }));
		// CASE order is the S2 document order; the map already follows the first
		// mention in the document. Module and Slice ids are unordered sets, so
		// sorting them keeps receipts deterministic.
		if (category !== "cases") {
			extras.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
		}
		sortedIds[category] = [...entries, ...extras];
	}
	return { sections: sectionRows, ids: sortedIds, declared: declaredSnapshot };
}

function affectedIds(previous, next, changedPaths) {
	const oldMap = new Map((previous ?? []).map((entry) => [entry.id, entry.sections]));
	const newMap = new Map((next ?? []).map((entry) => [entry.id, entry.sections]));
	const result = [];
	for (const id of new Set([...oldMap.keys(), ...newMap.keys()])) {
		const before = oldMap.get(id) ?? [];
		const after = newMap.get(id) ?? [];
		const added = !oldMap.has(id) || !newMap.has(id);
		const moved = before.length !== after.length || before.some((section, index) => section !== after[index]);
		const touched =
			before.some((section) => changedPaths.has(section)) || after.some((section) => changedPaths.has(section));
		const unseen = (before.length === 0 || after.length === 0) && changedPaths.size > 0;
		if (added || moved || touched || unseen) result.push(id);
	}
	return result.sort();
}

function diffStructure(previous, next, stage, structureSupplied) {
	if (!isPlainObject(previous) || !Array.isArray(previous.sections)) {
		const affected = {};
		for (const category of ["cases", "modules", "slices"]) {
			affected[category] = (next.ids[category] ?? []).map((entry) => entry.id);
		}
		return { changedSections: [], affected, unknown: ["all"] };
	}
	const before = new Map(previous.sections.map((section) => [section.path, section.sha256]));
	const after = new Map(next.sections.map((section) => [section.path, section.sha256]));
	const changedSections = [];
	const changedPaths = new Set();
	for (const [path, hash] of after) {
		if (!before.has(path)) {
			changedSections.push({ path, change: "added" });
			changedPaths.add(path);
		} else if (before.get(path) !== hash) {
			changedSections.push({ path, change: "modified" });
			changedPaths.add(path);
		}
	}
	for (const path of before.keys()) {
		if (!after.has(path)) {
			changedSections.push({ path, change: "removed" });
			changedPaths.add(path);
		}
	}
	const affected = {
		cases: affectedIds(previous.ids?.cases, next.ids.cases, changedPaths),
		modules: affectedIds(previous.ids?.modules, next.ids.modules, changedPaths),
		slices: affectedIds(previous.ids?.slices, next.ids.slices, changedPaths),
	};
	const unknown = [];
	if (!structureSupplied) {
		if (stage === "s3") unknown.push("modules");
		if (stage === "s4") unknown.push("slices");
	}
	return { changedSections, affected, unknown };
}

// ---------------------------------------------------------------------------
// Contract verification
// ---------------------------------------------------------------------------

function allFrozen(frozen) {
	return FROZEN_KEYS.every((key) => {
		const entry = frozen?.[key];
		if (!isPlainObject(entry) || normalizeHash(entry.sha256) === undefined) return false;
		if (key === "s3-modules") return entry.path === undefined || entry.path === null;
		return isText(entry.path);
	});
}

async function verifyFrozenEntry(mission, ports, key) {
	const frozen = mission.frozen;
	const entry = isPlainObject(frozen) ? frozen[key] : undefined;
	if (!isPlainObject(entry) || normalizeHash(entry.sha256) === undefined) {
		return {
			ok: false,
			code: ":STAGE_MISMATCH",
			message: `the contract is incomplete: ${key} is missing`,
			data: { reason: "contract-incomplete", key, slug: mission.slug },
		};
	}
	const expected = normalizeHash(entry.sha256);
	if (key === "s3-modules") {
		if (entry.path !== undefined && entry.path !== null) {
			return {
				ok: false,
				code: ":CONTRACT_HASH_MISMATCH",
				message: "frozen s3-modules must be inline",
				data: { reason: "contract-path", key },
			};
		}
		if (!Array.isArray(mission["s3-modules"])) {
			return {
				ok: false,
				code: ":CONTRACT_HASH_MISMATCH",
				message: "mission s3-modules is missing",
				data: { reason: "inline-missing", key },
			};
		}
		const actual = sha256(canonicalInlineBytes(mission["s3-modules"]));
		if (actual !== expected) {
			return {
				ok: false,
				code: ":CONTRACT_HASH_MISMATCH",
				message: "frozen s3-modules changed after freezing",
				data: { reason: "hash", key, expected, actual },
			};
		}
		return { ok: true, key, path: null, sha256: actual };
	}
	const relative = controlRelativePath(mission.slug, key);
	if (entry.path !== relative) {
		return {
			ok: false,
			code: ":CONTRACT_HASH_MISMATCH",
			message: `frozen ${key} path is not canonical`,
			data: { reason: "contract-path", key, expected: relative, actual: entry.path },
		};
	}
	const read = await readTextFile(ports.documents, controlPath(ports.root, mission.slug, key));
	if (!read.ok) {
		return {
			ok: false,
			code: ":CONTRACT_HASH_MISMATCH",
			message: `frozen ${key} cannot be read: ${read.message}`,
			data: { reason: read.kind, key, path: relative, "system-code": read.systemCode },
		};
	}
	const actual = sha256(read.text);
	if (actual !== expected) {
		return {
			ok: false,
			code: ":CONTRACT_HASH_MISMATCH",
			message: `frozen ${key} changed after freezing`,
			data: { reason: "hash", key, path: relative, expected, actual },
		};
	}
	return { ok: true, key, path: relative, sha256: actual };
}

async function verifyFrozenKeys(mission, ports, keys) {
	const entries = {};
	const hashes = {};
	const errors = [];
	for (const key of keys) {
		const result = await verifyFrozenEntry(mission, ports, key);
		entries[key] = result.ok ? { path: result.path, sha256: result.sha256 } : { error: result };
		if (result.ok) hashes[key] = result.sha256;
		else errors.push(result);
	}
	return { ok: errors.length === 0, entries, hashes, errors };
}

export async function verifyFrozenPrefix(root, slug, options = {}) {
	const rootPath = resolveRoot(root);
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	const opts = isPlainObject(options) ? options : {};
	const keys = opts.keys === undefined ? [...FROZEN_KEYS] : opts.keys;
	if (!Array.isArray(keys) || keys.some((key) => !FROZEN_KEYS.includes(key))) {
		return invalidArgument("keys must be a subset of the seven frozen entries", { field: "keys" });
	}
	const ports = portsFor(rootPath, slug, opts);
	return runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		const verified = await verifyFrozenKeys(current, ports, keys);
		let expectedContractLine;
		let contractLineStale = false;
		if (allFrozen(current.frozen)) {
			expectedContractLine = buildContractLine(slug, current.frozen);
			contractLineStale = current["contract-line"] !== expectedContractLine;
		}
		const response = {
			ok: verified.ok,
			frozen: clone(current.frozen ?? {}),
			hashes: verified.hashes,
			entries: verified.entries,
			expectedContractLine,
			contractLineStale,
			warning: contractLineStale ? { code: ":CONTRACT_LINE_STALE" } : null,
		};
		if (!verified.ok) {
			response.error = {
				code: verified.errors[0].code,
				message: verified.errors[0].message,
				data: { ...verified.errors[0].data, errors: verified.errors.map((entry) => entry.data) },
			};
		}
		return { response, commit: false };
	});
}

async function verifyContractAgainst(mission, ports) {
	const invalid = missionShapeProblem(mission);
	if (invalid) return invalid;
	const verified = await verifyFrozenKeys(mission, ports, FROZEN_KEYS);
	if (!verified.ok) {
		const first = verified.errors[0];
		return failure(first.code, first.message, first.data);
	}
	let expectedContractLine;
	try {
		expectedContractLine = buildContractLine(mission.slug, mission.frozen);
	} catch (error) {
		return failure(":CONTRACT_HASH_MISMATCH", `contract-line cannot be rebuilt: ${messageOf(error)}`, {
			reason: "contract-line",
			slug: mission.slug,
		});
	}
	const contractLineStale = mission["contract-line"] !== expectedContractLine;
	return {
		ok: true,
		contract: {
			slug: mission.slug,
			missionId: mission["mission-id"],
			revision: mission.revision,
			contractLine: expectedContractLine,
			savedContractLine: mission["contract-line"] ?? null,
			contractLineStale,
			warning: contractLineStale ? { code: ":CONTRACT_LINE_STALE" } : null,
			hashes: verified.hashes,
			frozen: clone(mission.frozen),
		},
	};
}

async function verifyApprovalAgainst(mission, ports, options = {}) {
	if (normalizeStage(mission.stage) !== "completed") {
		return failure(":APPROVAL_REQUIRED", "mission is not completed", {
			reason: "not-completed",
			stage: mission.stage,
		});
	}
	const approval = normalizeApproval(mission.approval);
	if (!approval) {
		return failure(":APPROVAL_REQUIRED", "mission has no valid approval record", {
			reason: "missing-approval",
		});
	}
	if (approval.revision !== mission.revision) {
		return failure(":APPROVAL_REQUIRED", "approval revision does not match the mission revision", {
			reason: "revision",
			expected: mission.revision,
			actual: approval.revision,
		});
	}
	const contract = await verifyContractAgainst(mission, ports);
	if (!contract.ok) return contract;
	const keyRead = await readApprovalKey(ports.documents, approvalKeyPath(ports.root, mission.slug));
	if (!keyRead.ok) {
		return failure(":APPROVAL_REQUIRED", `the protected approval key cannot be read: ${keyRead.message}`, {
			reason: keyRead.reason === "missing" ? "key-missing" : "key-invalid",
		});
	}
	const expected = approvalToken(mission, approval.reportSha256, keyRead.key, contract.contract.contractLine);
	if (approval.token !== expected) {
		return failure(":APPROVAL_REQUIRED", "approval token does not match the protected key and mission binding", {
			reason: "token",
		});
	}
	if (options.verifyReport !== false) {
		const path = reportPath(ports.root, mission.slug, options);
		const read = await readTextFile(ports.documents, path);
		if (!read.ok) {
			return failure(":APPROVAL_REQUIRED", `s5 report cannot be read: ${read.message}`, {
				reason: read.kind === "missing" ? "report-missing" : "report-unreadable",
				path,
			});
		}
		const actual = sha256(read.text);
		if (actual !== approval.reportSha256) {
			return failure(":APPROVAL_REQUIRED", "s5 report changed after approval", {
				reason: "report-changed",
				expected: approval.reportSha256,
				actual,
			});
		}
	}
	return {
		ok: true,
		authorized: true,
		approval: approvalView(approval, mission["mission-id"]),
		missionId: mission["mission-id"],
		slug: mission.slug,
		revision: mission.revision,
		contractLine: mission["contract-line"],
	};
}

// ---------------------------------------------------------------------------
// Public mission lifecycle
// ---------------------------------------------------------------------------

/**
 * Create one mission in stage S1 with revision 0.
 *
 * `options` may carry `missionId`, `seed`, `limits`, `settings`, and the
 * injected `store`, `documents`, and `now` ports.
 */
export async function createMission(root, options = {}) {
	const rootPath = resolveRoot(root);
	const opts = isPlainObject(options) ? options : {};
	const slug = opts.slug;
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
		return invalidArgument("slug must be 1-64 lowercase letters, digits, or hyphens, starting with a letter or digit", {
			field: "slug",
		});
	}
	if (opts.seed !== undefined && opts.seed !== null && typeof opts.seed !== "string") {
		return invalidArgument("seed must be a string or null", { field: "seed" });
	}
	if (opts.limits !== undefined && !isPlainObject(opts.limits)) {
		return invalidArgument("limits must be an object", { field: "limits" });
	}
	if (opts.settings !== undefined && !isPlainObject(opts.settings)) {
		return invalidArgument("settings must be an object", { field: "settings" });
	}
	const ports = portsFor(rootPath, slug, opts);
	return runTransaction(ports, async (current) => {
		if (current) {
			return {
				response: failure(":SLUG_TAKEN", `mission already exists: ${slug}`, { slug }),
				commit: false,
			};
		}
		const timestamp = ports.now();
		const mission = {
			"mission-id": isText(opts.missionId) ? opts.missionId.trim() : randomUUID(),
			slug,
			seed: opts.seed ?? null,
			"created-at": timestamp,
			"updated-at": timestamp,
			stage: stageValue("s1"),
			revision: 0,
			"contract-line": null,
			frozen: {},
			approval: null,
			receipts: {},
			limits: opts.limits ?? {},
			settings: opts.settings ?? {},
		};
		return { mission, response: { ok: true, mission: clone(mission) }, commit: true };
	});
}

/**
 * Read one mission without changing it.
 *
 * Returns `{ok:true, mission, valid, authorized}`. A missing mission returns
 * `mission:null`; a malformed mission returns `valid:false` with the
 * structural error. A completed mission is `authorized:true` only when its
 * approval token recomputes from the mission, revision, contract line, report
 * bytes, and the persisted `approval.key`, and the live contract still
 * matches.
 */
export async function readMission(root, slug, options = {}) {
	const rootPath = resolveRoot(root);
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	const ports = portsFor(rootPath, slug, options);
	try {
		const mission = await ports.store.read();
		if (mission === null || mission === undefined) {
			return { ok: true, mission: null, valid: true, authorized: true };
		}
		const valid = validateMission(mission);
		if (!valid.ok) return { ok: true, mission, valid: false, authorized: false, error: valid.error };
		if (mission.slug !== slug) {
			return {
				ok: true,
				mission,
				valid: false,
				authorized: false,
				error: failure(":STAGE_MISMATCH", "mission.edn slug does not match its directory", {
					slug,
					"mission-slug": mission.slug,
					reason: "slug-mismatch",
				}).error,
			};
		}
		if (normalizeStage(mission.stage) !== "completed") {
			return { ok: true, mission, valid: true, authorized: true, error: null };
		}
		const verified = await verifyApprovalAgainst(mission, ports, options);
		return {
			ok: true,
			mission,
			valid: true,
			authorized: verified.ok === true,
			error: verified.ok ? null : verified.error,
		};
	} catch (error) {
		return failure(codeOf(error), messageOf(error), dataOf(error));
	}
}

const DEVOPS_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const DEVOPS_NONCE_RE = /^[A-Za-z0-9_-]{8,128}$/;

function normalizeDevopsSessionRef(ref, mission) {
	if (!isPlainObject(ref)) {
		return invalidArgument("devops session ref must be an object", { field: "devops-session" });
	}
	const agentId = ref.agentId ?? ref["agent-id"];
	const artifactsDir = ref.artifactsDir ?? ref["artifacts-dir"];
	const agentName = ref.agentName ?? ref["agent-name"];
	const roleNonce = ref.roleNonce ?? ref["role-nonce"];
	const model = ref.model;
	if (typeof agentId !== "string" || !DEVOPS_SESSION_ID_RE.test(agentId)) {
		return invalidArgument("devops session id is invalid", { field: "agent-id" });
	}
	if (typeof artifactsDir !== "string" || artifactsDir.trim().length === 0) {
		return invalidArgument("devops artifacts directory is invalid", { field: "artifacts-dir" });
	}
	if (typeof agentName !== "string" || agentName.trim().length === 0) {
		return invalidArgument("devops agent name is invalid", { field: "agent-name" });
	}
	if (typeof roleNonce !== "string" || !DEVOPS_NONCE_RE.test(roleNonce)) {
		return invalidArgument("devops role nonce is invalid", { field: "role-nonce" });
	}
	if (!Array.isArray(model) || model.length === 0 || model.some((entry) => typeof entry !== "string")) {
		return invalidArgument("devops model patterns must be a non-empty string array", { field: "model" });
	}
	return {
		ok: true,
		value: {
			"mission-id": mission["mission-id"],
			revision: mission.revision,
			"agent-id": agentId,
			"artifacts-dir": artifactsDir,
			"agent-name": agentName,
			"role-nonce": roleNonce,
			model: [...model],
		},
	};
}

/**
 * Persist the one Plan DevOps child used by this mission tenure.
 *
 * The entry is deliberately minimal: the registry id, the artifacts
 * directory, the display name, the resolved @task model patterns, and the
 * mission revision at registration. It does not copy the AgentDefinition.
 * Re-registering the same id is idempotent; replacing it with a different id
 * is refused so a restart cannot silently create a second investigator.
 *
 * A concurrent mission writer can return the existing store's retryable
 * `:STAGE_MISMATCH` / `mission-busy` response; retry after the lock clears.
 */
export async function writeDevopsSessionRef(root, slug, ref, options = {}) {
	const rootPath = resolveRoot(root);
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	const ports = portsFor(rootPath, slug, options);
	return runTransaction(ports, async (current) => {
		const precondition = missionPrecondition(current, slug);
		if (!precondition.ok) return { response: precondition, commit: false };
		const normalized = normalizeDevopsSessionRef(ref, current);
		if (!normalized.ok) return { response: normalized, commit: false };
		const existing = current["devops-session"];
		if (existing !== undefined && existing !== null && !isPlainObject(existing)) {
			return {
				response: invalidArgument("mission devops-session is malformed", { field: "devops-session" }),
				commit: false,
			};
		}
		if (existing && existing["agent-id"] !== normalized.value["agent-id"]) {
			return {
				response: failure(":STALE_CONTROL", "mission already owns a different Plan DevOps session", {
					slug,
					expected: existing["agent-id"],
					actual: normalized.value["agent-id"],
				}),
				commit: false,
			};
		}
		const next = clone(current);
		next["devops-session"] = normalized.value;
		next["updated-at"] = ports.now();
		return {
			mission: next,
			response: { ok: true, mission: clone(next), session: clone(normalized.value) },
			commit: true,
		};
	});
}

/**
 * List missions on disk. A corrupt mission is reported in `invalid` instead of
 * being skipped silently.
 */
export async function listMissions(root, options = {}) {
	const rootPath = resolveRoot(root);
	const opts = isPlainObject(options) ? options : {};
	const documents = opts.documents ?? createDiskDocuments();
	const directory = join(rootPath, ".herd", "missions");
	let listed;
	try {
		listed = await documents.listDir(directory);
	} catch (error) {
		return failure(codeOf(error), messageOf(error), dataOf(error));
	}
	if (listed?.ok !== true) {
		return invalidArgument("could not list missions", {
			reason: "document-list",
			"system-code": typeof listed?.code === "string" ? listed.code : null,
		});
	}
	const missions = [];
	const invalid = [];
	for (const name of listed.names ?? []) {
		if (typeof name !== "string" || !SLUG_RE.test(name)) continue;
		const read = await readMission(rootPath, name, opts);
		if (!read.ok || read.mission === null) {
			invalid.push({
				slug: name,
				error: read.ok ? failure(":STAGE_MISMATCH", "mission missing", { slug: name }).error : read.error,
			});
			continue;
		}
		missions.push({
			slug: name,
			mission: read.mission,
			valid: read.valid,
			authorized: read.authorized === true,
			error: read.error ?? null,
		});
	}
	missions.sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
	invalid.sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
	return { ok: true, missions, invalid };
}

/**
 * Save an S1-S4 document without freezing it. `advance_s1` uses this before
 * the human-approval wait; S2-S4 callers use `freezeStage` directly.
 */
export async function saveStageDocument(root, slug, stageInput, markdown, options = {}) {
	const rootPath = resolveRoot(root);
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	const stage = normalizeStage(stageInput);
	if (!STAGE_IDS.includes(stage)) {
		return failure(":STAGE_MISMATCH", "stage must be s1, s2, s3, or s4", { stage: stageInput });
	}
	if (typeof markdown !== "string" || markdown.trim().length === 0) {
		return invalidArgument("markdown must be a non-empty string", { field: "markdown", stage: stageValue(stage) });
	}
	const opts = isPlainObject(options) ? options : {};
	const callId = callIdFrom(opts);
	if (callId === null) return invalidArgument("call-id is malformed", { field: "call_id" });
	const ports = portsFor(rootPath, slug, opts);
	const op = "saveStageDocument";
	const key = receiptKey(callId);
	const payloadHash = sha256(canonicalJson({ op, stage, markdown: sha256(markdown) }));
	let receiptRecord;
	const response = await runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		const replay = replayReceipt(current, key, payloadHash, callId);
		if (replay) return { response: replay, commit: false };
		if (normalizeStage(current.stage) !== stage || current.frozen?.[stage]) {
			return {
				response: failure(":STAGE_MISMATCH", `cannot save ${stage} while the mission is at ${current.stage}`, {
					stage: stageValue(stage),
					"mission-stage": current.stage,
					frozen: Boolean(current.frozen?.[stage]),
				}),
				commit: false,
			};
		}
		const path = documentPath(rootPath, slug, stage);
		const written = await writeTextFile(ports.documents, path, markdown);
		if (!written.ok) return { response: written, commit: false };
		const read = await readTextFile(ports.documents, path);
		if (!read.ok) {
			return {
				response: invalidArgument(`saved ${stage} document cannot be read back: ${read.message}`, {
					stage: stageValue(stage),
					path: stageDocumentPath(slug, stage),
					reason: read.kind,
					"system-code": read.systemCode,
				}),
				commit: false,
			};
		}
		const hash = sha256(read.text);
		const next = clone(current);
		next["updated-at"] = ports.now();
		const receipt = {
			ok: true,
			stage,
			path: stageDocumentPath(slug, stage),
			sha256: hash,
			revision: next.revision,
			missionStage: stage,
		};
		recordReceipt(next, key, payloadHash, receipt);
		if (key !== undefined) receiptRecord = { callId, op, key, payloadHash, receipt };
		return { mission: next, response: receipt, commit: true };
	});
	if (response?.ok && receiptRecord) await writeReceiptFile(ports, receiptRecord);
	return response;
}

async function saveControlFile(root, slug, key, text, op, options = {}, behavior = {}) {
	const rootPath = resolveRoot(root);
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	const opts = isPlainObject(options) ? options : {};
	const callId = callIdFrom(opts);
	if (callId === null) return invalidArgument("call-id is malformed", { field: "call_id" });
	const ports = portsFor(rootPath, slug, opts);
	const relative = controlRelativePath(slug, key);
	const absolute = controlPath(rootPath, slug, key);
	const payloadHash = sha256(canonicalJson({ op, key, sha256: sha256(text) }));
	let receiptRecord;
	const response = await runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		const replay = replayReceipt(current, receiptKey(callId), payloadHash, callId);
		if (replay) return { response: replay, commit: false };
		const existing = await readTextFile(ports.documents, absolute);
		if (existing.ok && existing.text === text) {
			const hash = sha256(existing.text);
			const receipt = { ok: true, path: relative, sha256: hash, replayed: true };
			if (callId === undefined) return { response: receipt, commit: false };
			const next = clone(current);
			next["updated-at"] = ports.now();
			recordReceipt(next, receiptKey(callId), payloadHash, receipt);
			receiptRecord = { callId, op, key: receiptKey(callId), payloadHash, receipt };
			return { mission: next, response: receipt, commit: true };
		}
		if (existing.ok) {
			const canReplace =
				behavior.allowReplace === true && current.frozen?.[key] === undefined && current.frozen?.s1 === undefined;
			if (!canReplace) {
				return {
					response: failure(":FILE_CONFLICT", `${relative} already contains different bytes`, {
						path: relative,
						expected: sha256(text),
						actual: sha256(existing.text),
					}),
					commit: false,
				};
			}
		}
		const written = await writeTextFile(ports.documents, absolute, text);
		if (!written.ok) return { response: written, commit: false };
		const read = await readTextFile(ports.documents, absolute);
		if (!read.ok) {
			return {
				response: invalidArgument(`saved ${relative} cannot be read back: ${read.message}`, {
					path: relative,
					reason: read.kind,
				}),
				commit: false,
			};
		}
		const hash = sha256(read.text);
		const next = clone(current);
		next["updated-at"] = ports.now();
		const receipt = { ok: true, path: relative, sha256: hash, replayed: false };
		recordReceipt(next, receiptKey(callId), payloadHash, receipt);
		if (callId !== undefined) receiptRecord = { callId, op, key: receiptKey(callId), payloadHash, receipt };
		return { mission: next, response: receipt, commit: true };
	});
	if (response?.ok && receiptRecord) await writeReceiptFile(ports, receiptRecord);
	return response;
}

export async function saveS1Summary(root, slug, summary, options = {}) {
	if (typeof summary !== "string" || summary.trim().length === 0) {
		return invalidArgument("summary must be a non-empty string", { field: "summary" });
	}
	return saveControlFile(root, slug, "s1-summary", summary, "saveS1Summary", options, { allowReplace: true });
}

export async function saveS2Cases(root, slug, cases, options = {}) {
	if (!Array.isArray(cases) || cases.length === 0) {
		return invalidArgument("cases must be a non-empty array", { field: "cases" });
	}
	let bytes;
	try {
		cases = canonicalCases(cases);
		bytes = canonicalEdnFile(cases);
	} catch (error) {
		return failure(codeOf(error), messageOf(error), dataOf(error));
	}
	return saveControlFile(root, slug, "s2-cases", bytes, "saveS2Cases", options);
}

async function readControlFile(root, slug, key, options = {}) {
	const rootPath = resolveRoot(root);
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	const opts = isPlainObject(options) ? options : {};
	const ports = portsFor(rootPath, slug, opts);
	const relative = controlRelativePath(slug, key);
	const absolute = controlPath(rootPath, slug, key);
	return runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		const entry = current.frozen?.[key];
		if (opts.verifyFrozen !== false) {
			if (!isPlainObject(entry) || normalizeHash(entry.sha256) === undefined) {
				return {
					response: failure(":STAGE_MISMATCH", `${key} is not frozen`, {
						key,
						path: relative,
					}),
					commit: false,
				};
			}
			if (entry.path !== relative) {
				return {
					response: failure(":CONTRACT_HASH_MISMATCH", `${key} frozen path is not canonical`, {
						expected: relative,
						actual: entry.path,
					}),
					commit: false,
				};
			}
		}
		const raw = await readTextFile(ports.documents, absolute);
		if (!raw.ok) {
			return {
				response: invalidArgument(`cannot read ${relative}: ${raw.message}`, {
					path: relative,
					reason: raw.kind,
					"system-code": raw.systemCode,
				}),
				commit: false,
			};
		}
		const hash = sha256(raw.text);
		if (opts.verifyFrozen !== false && hash !== normalizeHash(entry.sha256)) {
			return {
				response: failure(":CONTRACT_HASH_MISMATCH", `${key} bytes do not match the frozen hash`, {
					path: relative,
					expected: normalizeHash(entry.sha256),
					actual: hash,
				}),
				commit: false,
			};
		}
		return {
			response: { ok: true, path: relative, bytes: Buffer.from(raw.text, "utf8"), text: raw.text, sha256: hash },
			commit: false,
		};
	});
}

export async function readS2Cases(root, slug, options = {}) {
	const read = await readControlFile(root, slug, "s2-cases", options);
	if (!read?.ok) return read;
	try {
		const cases = parseCasesDocument(read.text);
		return { ...read, cases, caseIds: caseIdsOf(cases) };
	} catch (error) {
		return failure(codeOf(error), messageOf(error), dataOf(error));
	}
}

export async function readS1Summary(root, slug, options = {}) {
	const read = await readControlFile(root, slug, "s1-summary", options);
	if (!read?.ok) return read;
	if (read.text.trim().length === 0) {
		return failure(":INVALID_ARGUMENT", "s1-summary.md is empty", { path: read.path });
	}
	return read;
}

export async function readS4Slices(root, slug, options = {}) {
	const rootPath = resolveRoot(root);
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	const ports = portsFor(rootPath, slug, isPlainObject(options) ? options : {});
	return runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		const slices = current["s4-slices"];
		if (!Array.isArray(slices)) {
			return {
				response: failure(":STAGE_MISMATCH", "s4-slices is missing", { key: "s4-slices" }),
				commit: false,
			};
		}
		return { response: { ok: true, slices: clone(slices) }, commit: false };
	});
}

/**
 * Commit S2's two authoritative inputs under one mission-lock transaction:
 * `.herd/missions/<slug>/cases.edn` and `plans/<slug>/s2-manual-tests.md`.
 *
 * Both files are written/reused, read back, and hashed before the mission
 * record advances. A retry with the same call-id is idempotent; a different
 * external byte sequence is never overwritten and fails closed.
 */
export async function commitS2(root, slug, params = {}, options = {}) {
	const rootPath = resolveRoot(root);
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	const markdown = params.manual_tests_markdown;
	const casesInput = params.cases;
	if (typeof markdown !== "string" || markdown.trim().length === 0) {
		return invalidArgument("manual_tests_markdown must be a non-empty string", {
			field: "manual_tests_markdown",
		});
	}
	if (!Array.isArray(casesInput) || casesInput.length === 0) {
		return invalidArgument("cases must be a non-empty array", { field: "cases" });
	}
	let cases;
	let casesBytes;
	try {
		cases = canonicalCases(casesInput);
		casesBytes = canonicalEdnFile(cases);
		parseCasesDocument(casesBytes);
	} catch (error) {
		return failure(codeOf(error), messageOf(error), dataOf(error));
	}
	const opts = isPlainObject(options) ? options : {};
	const callId = callIdFrom(opts);
	if (callId === null) return invalidArgument("call-id is malformed", { field: "call_id" });
	const normalized = normalizeStructure(opts.structure);
	if (!normalized.ok) return normalized;
	const structure = normalized.structure;
	const ports = portsFor(rootPath, slug, opts);
	const write = opts.write !== false;
	const docRelative = stageDocumentPath(slug, "s2");
	const casesRelative = controlRelativePath(slug, "s2-cases");
	const docAbsolute = documentPath(rootPath, slug, "s2");
	const casesAbsolute = controlPath(rootPath, slug, "s2-cases");
	const payloadHash = sha256(
		canonicalJson({
			op: "commitS2",
			markdown: sha256(markdown),
			cases: sha256(casesBytes),
			structure,
			write,
		}),
	);
	const key = receiptKey(callId);
	let receiptRecord;
	const response = await runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		const replay = replayReceipt(current, key, payloadHash, callId);
		if (replay) {
			if (replay.ok === true) {
				const replayCases = await readTextFile(ports.documents, casesAbsolute);
				const replayDoc = await readTextFile(ports.documents, docAbsolute);
				if (!replayCases.ok || replayCases.text !== casesBytes) {
					return {
						response: failure(":CASE_HASH_MISMATCH", "cases.edn changed after the recorded S2 commit", {
							path: casesRelative,
							expected: sha256(casesBytes),
							actual: replayCases.ok ? sha256(replayCases.text) : null,
						}),
						commit: false,
					};
				}
				if (!replayDoc.ok || replayDoc.text !== markdown) {
					return {
						response: failure(":FILE_CONFLICT", "s2-manual-tests.md changed after the recorded S2 commit", {
							path: docRelative,
							expected: sha256(markdown),
							actual: replayDoc.ok ? sha256(replayDoc.text) : null,
						}),
						commit: false,
					};
				}
			}
			return { response: replay, commit: false };
		}
		if (normalizeStage(current.stage) !== "s2") {
			return {
				response: failure(":STAGE_MISMATCH", `expected stage s2, mission is at ${current.stage}`, {
					stage: "s2",
					"mission-stage": current.stage,
				}),
				commit: false,
			};
		}
		if (current.frozen?.s2 || current.frozen?.["s2-cases"]) {
			return {
				response: failure(":STAGE_MISMATCH", "s2 is already frozen", {
					stage: "s2",
					revision: current.revision,
				}),
				commit: false,
			};
		}
		const prefix = await verifyFrozenKeys(current, ports, ["s1", "s1-summary"]);
		if (!prefix.ok) {
			const first = prefix.errors[0];
			return { response: failure(first.code, first.message, first.data), commit: false };
		}
		const existingCases = await readTextFile(ports.documents, casesAbsolute);
		if (existingCases.ok) {
			if (existingCases.text !== casesBytes) {
				return {
					response: failure(":CASE_HASH_MISMATCH", "cases.edn already contains different bytes", {
						path: casesRelative,
						expected: sha256(casesBytes),
						actual: sha256(existingCases.text),
					}),
					commit: false,
				};
			}
		} else if (!write) {
			return {
				response: failure(":FILE_CONFLICT", "cases.edn is missing for a no-write retry", {
					path: casesRelative,
				}),
				commit: false,
			};
		} else {
			const written = await writeTextFile(ports.documents, casesAbsolute, casesBytes);
			if (!written.ok) return { response: written, commit: false };
		}
		const existingDoc = await readTextFile(ports.documents, docAbsolute);
		if (existingDoc.ok) {
			if (existingDoc.text !== markdown) {
				return {
					response: failure(":FILE_CONFLICT", "s2-manual-tests.md already contains different bytes", {
						path: docRelative,
						expected: sha256(markdown),
						actual: sha256(existingDoc.text),
					}),
					commit: false,
				};
			}
		} else if (!write) {
			return {
				response: failure(":FILE_CONFLICT", "s2-manual-tests.md is missing for a no-write retry", {
					path: docRelative,
				}),
				commit: false,
			};
		} else {
			const written = await writeTextFile(ports.documents, docAbsolute, markdown);
			if (!written.ok) return { response: written, commit: false };
		}
		const casesRead = await readTextFile(ports.documents, casesAbsolute);
		const docRead = await readTextFile(ports.documents, docAbsolute);
		if (!casesRead.ok || !docRead.ok) {
			return {
				response: invalidArgument("S2 inputs cannot be read back after writing", {
					path: !casesRead.ok ? casesRelative : docRelative,
				}),
				commit: false,
			};
		}
		let readCases;
		try {
			readCases = parseCasesDocument(casesRead.text);
		} catch (error) {
			return { response: failure(codeOf(error), messageOf(error), dataOf(error)), commit: false };
		}
		const docHash = sha256(docRead.text);
		const casesHash = sha256(casesRead.text);
		const snapshot = scanStructure(docRead.text, structure);
		const next = clone(current);
		next.frozen = {
			...(isPlainObject(next.frozen) ? next.frozen : {}),
			s2: { path: docRelative, sha256: docHash, "frozen-at": ports.now(), structure: snapshot },
			"s2-cases": { path: casesRelative, sha256: casesHash, "frozen-at": ports.now() },
		};
		next.revision = current.revision + 1;
		next.stage = stageValue(NEXT_STAGE.s2);
		if (allFrozen(next.frozen)) next["contract-line"] = buildContractLine(slug, next.frozen);
		next["updated-at"] = ports.now();
		const receipt = {
			ok: true,
			stage: "s2",
			path: docRelative,
			sha256: docHash,
			casesPath: casesRelative,
			casesSha256: casesHash,
			caseIds: caseIdsOf(readCases),
			revision: next.revision,
			missionStage: "s3",
			advanced: true,
			contractLine: next["contract-line"] ?? null,
		};
		recordReceipt(next, key, payloadHash, receipt);
		if (key !== undefined) receiptRecord = { callId, op: "commitS2", key, payloadHash, receipt };
		return { mission: next, response: receipt, commit: true };
	});
	if (response?.ok && receiptRecord) await writeReceiptFile(ports, receiptRecord);
	return response;
}

/**
 * Freeze one stage from the bytes actually on disk and advance the mission.
 *
 * S1 never writes the supplied markdown when the file exists: approval must
 * use the latest human-edited bytes. S2-S4 write the submitted markdown, read
 * it back, hash the read-back text, then update `mission.edn` in the same
 * transaction.
 *
 * `meta` may carry `callId`, `structure` (`{cases, modules, slices}` for the
 * realignment hint), and `write:false` to require a previous crash-recovery
 * save.
 */
export async function freezeStage(root, slug, stageInput, markdown, meta = {}) {
	const rootPath = resolveRoot(root);
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	const stage = normalizeStage(stageInput);
	if (!STAGE_IDS.includes(stage)) {
		return failure(":STAGE_MISMATCH", "stage must be s1, s2, s3, or s4", { stage: stageInput });
	}
	if (markdown !== undefined && markdown !== null && typeof markdown !== "string") {
		return invalidArgument("markdown must be a string when supplied", {
			field: "markdown",
			stage: stageValue(stage),
		});
	}
	const opts = isPlainObject(meta) ? meta : {};
	const callId = callIdFrom(opts);
	if (callId === null) return invalidArgument("call-id is malformed", { field: "call_id" });
	const normalized = normalizeStructure(opts.structure);
	if (!normalized.ok) return normalized;
	const structure = normalized.structure;
	const ports = portsFor(rootPath, slug, opts);
	const write = opts.write !== false;
	const markdownHash = typeof markdown === "string" ? sha256(markdown) : "<disk>";
	const op = "freezeStage";
	const key = receiptKey(callId);
	const payloadHash = sha256(canonicalJson({ op, stage, markdown: markdownHash, write, structure }));
	let receiptRecord;
	const response = await runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		const replay = replayReceipt(current, key, payloadHash, callId);
		if (replay) return { response: replay, commit: false };
		if (current.frozen?.[stage]) {
			return {
				response: failure(":STAGE_MISMATCH", `${stage} is already frozen`, {
					stage: stageValue(stage),
					revision: current.revision,
				}),
				commit: false,
			};
		}
		if (normalizeStage(current.stage) !== stage) {
			return {
				response: failure(":STAGE_MISMATCH", `expected stage ${stage}, mission is at ${current.stage}`, {
					stage: stageValue(stage),
					"mission-stage": current.stage,
				}),
				commit: false,
			};
		}

		const path = documentPath(rootPath, slug, stage);
		let mustWrite = write && stage !== "s1" && typeof markdown === "string";
		if (stage === "s1" && typeof markdown === "string") {
			const existing = await ports.documents.readText(path);
			mustWrite = existing?.ok !== true;
		}
		if (mustWrite) {
			const written = await writeTextFile(ports.documents, path, markdown);
			if (!written.ok) return { response: written, commit: false };
		}

		const read = await readTextFile(ports.documents, path);
		if (!read.ok) {
			return {
				response: invalidArgument(`cannot freeze ${stage}: ${read.message}`, {
					stage: stageValue(stage),
					path: stageDocumentPath(slug, stage),
					reason: read.kind,
					"system-code": read.systemCode,
				}),
				commit: false,
			};
		}
		const hash = sha256(read.text);
		const frozenAt = ports.now();
		let summaryHash;
		let casesHash;
		let modules;
		let slices;
		if (stage === "s1") {
			const summary = await readTextFile(ports.documents, controlPath(rootPath, slug, "s1-summary"));
			if (!summary.ok) {
				return {
					response: failure(":FILE_CONFLICT", "s1-summary.md is missing; save the submitted summary before approval", {
						path: controlRelativePath(slug, "s1-summary"),
						reason: summary.kind,
					}),
					commit: false,
				};
			}
			summaryHash = sha256(summary.text);
		}
		if (stage === "s2") {
			const casesRead = await readTextFile(ports.documents, controlPath(rootPath, slug, "s2-cases"));
			if (!casesRead.ok) {
				return {
					response: failure(":FILE_CONFLICT", "cases.edn is missing; save the submitted CASE vector before freezing", {
						path: controlRelativePath(slug, "s2-cases"),
						reason: casesRead.kind,
					}),
					commit: false,
				};
			}
			try {
				parseCasesDocument(casesRead.text);
			} catch (error) {
				return { response: failure(codeOf(error), messageOf(error), dataOf(error)), commit: false };
			}
			casesHash = sha256(casesRead.text);
		}
		if (stage === "s3") {
			if (Array.isArray(opts.modules)) modules = clone(opts.modules.map(normalizeModuleRecord));
			else if (Array.isArray(current["s3-modules"])) modules = clone(current["s3-modules"]);
			else {
				return {
					response: invalidArgument("s3 freeze requires the complete modules array", { field: "modules" }),
					commit: false,
				};
			}
			if (modules.length === 0) {
				return { response: invalidArgument("modules must not be empty", { field: "modules" }), commit: false };
			}
			if (
				Array.isArray(current["s3-modules"]) &&
				Array.isArray(opts.modules) &&
				canonicalInlineBytes(current["s3-modules"]) !== canonicalInlineBytes(modules)
			) {
				return {
					response: failure(":FILE_CONFLICT", "s3-modules already staged with different content", {
						field: "s3-modules",
					}),
					commit: false,
				};
			}
		}
		if (stage === "s4" && Array.isArray(opts.slices)) slices = clone(opts.slices.map(normalizeSliceRecord));
		const snapshot = scanStructure(read.text, structure);
		const next = clone(current);
		const frozen = {
			...(isPlainObject(next.frozen) ? next.frozen : {}),
			[stage]: {
				path: stageDocumentPath(slug, stage),
				sha256: hash,
				"frozen-at": frozenAt,
				structure: snapshot,
			},
		};
		if (stage === "s1") {
			frozen["s1-summary"] = {
				path: controlRelativePath(slug, "s1-summary"),
				sha256: summaryHash,
				"frozen-at": frozenAt,
			};
		}
		if (stage === "s2") {
			frozen["s2-cases"] = {
				path: controlRelativePath(slug, "s2-cases"),
				sha256: casesHash,
				"frozen-at": frozenAt,
			};
		}
		if (stage === "s3") {
			next["s3-modules"] = modules;
			frozen["s3-modules"] = {
				sha256: sha256(canonicalInlineBytes(modules)),
				"frozen-at": frozenAt,
			};
		}
		if (slices !== undefined) next["s4-slices"] = slices;
		next.frozen = frozen;
		next.revision = current.revision + 1;
		const nextStage = NEXT_STAGE[stage];
		next.stage = stageValue(nextStage);
		if (nextStage === "s5" && allFrozen(next.frozen)) {
			next["contract-line"] = buildContractLine(slug, next.frozen);
		}
		next["updated-at"] = ports.now();
		const receipt = {
			ok: true,
			stage,
			path: stageDocumentPath(slug, stage),
			sha256: hash,
			revision: next.revision,
			missionStage: nextStage,
			advanced: true,
			contractLine: next["contract-line"] ?? null,
		};
		recordReceipt(next, key, payloadHash, receipt);
		if (key !== undefined) receiptRecord = { callId, op, key, payloadHash, receipt };
		return { mission: next, response: receipt, commit: true };
	});
	if (response?.ok && receiptRecord) await writeReceiptFile(ports, receiptRecord);
	if (response?.ok && stage === "s1") {
		// The mission commit is already durable. A crash between the commit and
		// this removal leaves only a stale pending-gate record, which the gate
		// service safely clears on the next resume; the old order lost the
		// pending record on a failed commit instead.
		const removed = await removeFile(ports.documents, pendingPath(rootPath, slug));
		response.pendingCleared = removed.ok;
		if (!removed.ok) {
			response.warning =
				"the mission advanced to s2, but pending-gate.edn could not be removed; the next resume will clear it";
		}
	}
	return response;
}

/**
 * Recompute the seven frozen control-state hashes from current disk/inline
 * bytes. A missing entry, unreadable file, non-canonical path, or digest
 * mismatch rejects the whole check. A stale contract-line is reported as a
 * warning; frozen entries remain authoritative.
 */
export async function verifyContract(root, slug, options = {}) {
	const rootPath = resolveRoot(root);
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	const ports = portsFor(rootPath, slug, options);
	const response = await runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		const verified = await verifyContractAgainst(current, ports);
		return { response: verified, commit: false };
	});
	return response;
}

/**
 * Recompute one frozen stage after a human edit, update its hash, and bump the
 * revision. When a previous structural snapshot exists, the result names the
 * changed sections and the CASE/module/Slice ids touched. The old hash is
 * never retained.
 *
 * `options.structure` may carry the gate's structured `{cases, modules,
 * slices}` list to make module/Slice impact exact; without it those categories
 * are reported as unknown for S3/S4.
 */
const CONTROL_TARGETS = Object.freeze(["s1-summary", "s2-cases", "s3-modules", "s4-slices"]);

async function realignControl(rootPath, slug, target, opts, ports) {
	const key = receiptKey(callIdFrom(opts));
	return runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		if (normalizeStage(current.stage) === "completed") {
			return {
				response: failure(":APPROVAL_REQUIRED", "a completed mission cannot be realigned", {
					reason: "completed",
					slug,
				}),
				commit: false,
			};
		}
		let cases;
		const modules = Array.isArray(opts.modules) ? clone(opts.modules) : undefined;
		const slices = Array.isArray(opts.slices) ? clone(opts.slices) : undefined;
		let hash;
		let path = null;
		if (target === "s1-summary") {
			const read = await readTextFile(ports.documents, controlPath(rootPath, slug, "s1-summary"));
			if (!read.ok) {
				return {
					response: invalidArgument(`cannot realign s1-summary: ${read.message}`, {
						path: controlRelativePath(slug, "s1-summary"),
						reason: read.kind,
					}),
					commit: false,
				};
			}
			if (read.text.trim().length === 0) {
				return {
					response: invalidArgument("s1-summary.md must not be empty", {
						path: controlRelativePath(slug, "s1-summary"),
					}),
					commit: false,
				};
			}
			hash = sha256(read.text);
			path = controlRelativePath(slug, "s1-summary");
		} else {
			const casesRead = await readTextFile(ports.documents, controlPath(rootPath, slug, "s2-cases"));
			if (!casesRead.ok) {
				return {
					response: invalidArgument(`cannot realign ${target}: cases.edn is unavailable`, {
						path: controlRelativePath(slug, "s2-cases"),
						reason: casesRead.kind,
					}),
					commit: false,
				};
			}
			try {
				cases = parseCasesDocument(casesRead.text);
			} catch (error) {
				return { response: failure(codeOf(error), messageOf(error), dataOf(error)), commit: false };
			}
			if (target === "s3-modules" && modules === undefined) {
				return {
					response: invalidArgument("s3-modules realign requires the complete modules array", {
						field: "modules",
					}),
					commit: false,
				};
			}
			if (target === "s4-slices" && slices === undefined) {
				return {
					response: invalidArgument("s4-slices realign requires the complete slices array", {
						field: "slices",
					}),
					commit: false,
				};
			}
			const effectiveModules = modules ?? current["s3-modules"];
			const effectiveSlices = slices ?? current["s4-slices"];
			const mapping = mappingProblem(cases, effectiveModules, effectiveSlices);
			if (mapping) {
				return {
					response: failure(":MAPPING_REALIGN_REQUIRED", "CASE IDs require a structured mapping realign", mapping),
					commit: false,
				};
			}
			hash = target === "s2-cases" ? sha256(casesRead.text) : undefined;
			path = target === "s2-cases" ? controlRelativePath(slug, "s2-cases") : null;
		}
		const next = clone(current);
		const frozen = { ...(isPlainObject(next.frozen) ? next.frozen : {}) };
		if (target === "s1-summary") {
			const before = frozen["s1-summary"];
			if (!isPlainObject(before)) {
				return {
					response: failure(":STAGE_MISMATCH", "s1-summary is not frozen", { key: "s1-summary" }),
					commit: false,
				};
			}
			frozen["s1-summary"] = { ...before, sha256: hash, "realigned-at": ports.now() };
		}
		if (target === "s2-cases") {
			const before = frozen["s2-cases"];
			if (!isPlainObject(before)) {
				return {
					response: failure(":STAGE_MISMATCH", "s2-cases is not frozen", { key: "s2-cases" }),
					commit: false,
				};
			}
			if (hash === normalizeHash(before.sha256) && modules === undefined && slices === undefined) {
				return {
					response: { ok: true, status: "unchanged", target, path, sha256: hash, revision: current.revision },
					commit: false,
				};
			}
			frozen["s2-cases"] = { ...before, sha256: hash, "realigned-at": ports.now() };
		}
		if (modules !== undefined) {
			next["s3-modules"] = modules;
			frozen["s3-modules"] = {
				...(isPlainObject(frozen["s3-modules"]) ? frozen["s3-modules"] : {}),
				sha256: sha256(canonicalInlineBytes(modules)),
				"realigned-at": ports.now(),
			};
		}
		if (slices !== undefined) next["s4-slices"] = slices;
		next.frozen = frozen;
		next.revision = current.revision + 1;
		if (allFrozen(next.frozen)) next["contract-line"] = buildContractLine(slug, next.frozen);
		next["updated-at"] = ports.now();
		const receipt = {
			ok: true,
			status: "realigned",
			target,
			path,
			sha256: hash ?? (modules !== undefined ? sha256(canonicalInlineBytes(modules)) : null),
			revision: next.revision,
			affected: {
				cases: caseIdsOf(cases ?? []),
				modules: modules?.map((entry) => entry.path) ?? [],
				slices: slices?.map((entry) => entry.slice_id ?? entry.sliceId) ?? [],
			},
			frozen: clone(next.frozen),
			contractLine: next["contract-line"] ?? null,
			caseIds: cases === undefined ? undefined : caseIdsOf(cases),
			unknown: [],
		};
		if (key !== undefined) recordReceipt(next, key, sha256(canonicalJson({ op: "realign", target, hash })), receipt);
		return { mission: next, response: receipt, commit: true };
	});
}

export async function realign(root, slug, stageInput, options = {}) {
	const rootPath = resolveRoot(root);
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	const target = CONTROL_TARGETS.includes(stageInput) ? stageInput : normalizeStage(stageInput);
	if (!STAGE_IDS.includes(target) && !CONTROL_TARGETS.includes(target)) {
		return failure(":STAGE_MISMATCH", "target must be s1, s1-summary, s2, s2-cases, s3, s3-modules, s4, or s4-slices", {
			target: stageInput,
		});
	}
	const opts = isPlainObject(options) ? options : {};
	const callId = callIdFrom(opts);
	if (callId === null) return invalidArgument("call-id is malformed", { field: "call_id" });
	const ports = portsFor(rootPath, slug, opts);
	if (CONTROL_TARGETS.includes(target)) return realignControl(rootPath, slug, target, opts, ports);
	const stage = target;
	const normalized = normalizeStructure(opts.structure);
	if (!normalized.ok) return normalized;
	const structure = normalized.structure;
	const op = "realign";
	const key = receiptKey(callId);
	let receiptRecord;
	const response = await runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		if (normalizeStage(current.stage) === "completed") {
			return {
				response: failure(":APPROVAL_REQUIRED", "a completed mission cannot be realigned", {
					reason: "completed",
					slug,
				}),
				commit: false,
			};
		}
		const before = current.frozen?.[stage];
		if (!isPlainObject(before) || !isText(before.path) || !normalizeHash(before.sha256)) {
			return {
				response: failure(":STAGE_MISMATCH", `${stage} is not frozen`, {
					stage: stageValue(stage),
					reason: "not-frozen",
				}),
				commit: false,
			};
		}
		if (before.path !== stageDocumentPath(slug, stage)) {
			return {
				response: failure(":CONTRACT_HASH_MISMATCH", `${stage} frozen path is not canonical`, {
					reason: "contract-path",
					stage: stageValue(stage),
					expected: stageDocumentPath(slug, stage),
					actual: before.path,
				}),
				commit: false,
			};
		}
		const path = documentPath(rootPath, slug, stage);
		const read = await readTextFile(ports.documents, path);
		if (!read.ok) {
			return {
				response: invalidArgument(`cannot realign ${stage}: ${read.message}`, {
					stage: stageValue(stage),
					path: stageDocumentPath(slug, stage),
					reason: read.kind,
					"system-code": read.systemCode,
				}),
				commit: false,
			};
		}
		const hash = sha256(read.text);
		const payloadHash = sha256(canonicalJson({ op, stage, sha256: hash, structure }));
		const replay = replayReceipt(current, key, payloadHash, callId);
		if (replay) return { response: replay, commit: false };

		if (hash === normalizeHash(before.sha256)) {
			const receipt = {
				ok: true,
				status: "unchanged",
				stage,
				path: stageDocumentPath(slug, stage),
				sha256: hash,
				revision: current.revision,
				changedSections: [],
				affected: { cases: [], modules: [], slices: [] },
				unknown: [],
			};
			if (key === undefined) return { response: receipt, commit: false };
			const next = clone(current);
			next["updated-at"] = ports.now();
			recordReceipt(next, key, payloadHash, receipt);
			receiptRecord = { callId, op, key, payloadHash, receipt };
			return { mission: next, response: receipt, commit: true };
		}

		const snapshot = scanStructure(read.text, structure);
		const supplied = structure !== null && structure.supplied.length > 0;
		const change = diffStructure(before.structure, snapshot, stage, supplied);
		const next = clone(current);
		next.frozen = {
			...next.frozen,
			[stage]: {
				...before,
				sha256: hash,
				"realigned-at": ports.now(),
				structure: snapshot,
			},
		};
		if (stage === "s3" && Array.isArray(opts.modules)) {
			const normalizedModules = opts.modules.map(normalizeModuleRecord);
			const casesRead = await readTextFile(ports.documents, controlPath(rootPath, slug, "s2-cases"));
			if (!casesRead.ok) {
				return {
					response: invalidArgument("cannot update s3-modules without cases.edn", {
						path: controlRelativePath(slug, "s2-cases"),
					}),
					commit: false,
				};
			}
			let cases;
			try {
				cases = parseCasesDocument(casesRead.text);
			} catch (error) {
				return { response: failure(codeOf(error), messageOf(error), dataOf(error)), commit: false };
			}
			const mapping = mappingProblem(cases, normalizedModules, current["s4-slices"]);
			if (mapping) {
				return {
					response: failure(":MAPPING_REALIGN_REQUIRED", "S3 modules do not cover the frozen CASE IDs", mapping),
					commit: false,
				};
			}
			next["s3-modules"] = clone(normalizedModules);
			next.frozen["s3-modules"] = {
				...(isPlainObject(next.frozen["s3-modules"]) ? next.frozen["s3-modules"] : {}),
				sha256: sha256(canonicalInlineBytes(normalizedModules)),
				"realigned-at": ports.now(),
			};
		}
		if (stage === "s4" && Array.isArray(opts.slices)) next["s4-slices"] = clone(opts.slices.map(normalizeSliceRecord));
		next.revision = current.revision + 1;
		if (allFrozen(next.frozen)) {
			next["contract-line"] = buildContractLine(slug, next.frozen);
		}
		next["updated-at"] = ports.now();
		const receipt = {
			ok: true,
			status: "realigned",
			stage,
			path: stageDocumentPath(slug, stage),
			sha256: hash,
			revision: next.revision,
			changedSections: change.changedSections,
			affected: change.affected,
			frozen: clone(next.frozen),
			contractLine: next["contract-line"] ?? null,
			unknown: change.unknown,
			"structure-supplied": supplied,
		};
		recordReceipt(next, key, payloadHash, receipt);
		if (key !== undefined) receiptRecord = { callId, op, key, payloadHash, receipt };
		return { mission: next, response: receipt, commit: true };
	});
	if (response?.ok && receiptRecord) await writeReceiptFile(ports, receiptRecord);
	return response;
}

/**
 * Read the asynchronous S1 gate record. A missing or empty file means no gate
 * is waiting. Corrupt EDN is a hard failure, not "no pending gate".
 */
export async function readPendingGate(root, slug, options = {}) {
	const rootPath = resolveRoot(root);
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	const ports = portsFor(rootPath, slug, options);
	const path = pendingPath(rootPath, slug);
	let raw;
	try {
		raw = await ports.documents.readText(path);
	} catch (error) {
		return failure(codeOf(error), messageOf(error), dataOf(error));
	}
	if (raw?.ok !== true) {
		if (raw?.code === "ENOENT") return { ok: true, pending: null };
		return invalidArgument("could not read pending-gate.edn", {
			reason: "document-read",
			path: basename(path),
			"system-code": typeof raw?.code === "string" ? raw.code : null,
		});
	}
	if (typeof raw.text !== "string") {
		return invalidArgument("pending-gate.edn must be text", { reason: "pending-gate" });
	}
	if (raw.text.trim().length === 0) return { ok: true, pending: null };
	try {
		const pending = parseEdn(raw.text);
		if (!isPlainObject(pending)) {
			return invalidArgument("pending-gate.edn must hold one EDN map", { reason: "pending-gate" });
		}
		return { ok: true, pending };
	} catch (error) {
		return invalidArgument(`pending-gate.edn is not valid EDN: ${messageOf(error)}`, { reason: "pending-gate" });
	}
}

/**
 * Persist the asynchronous S1 gate record, or remove it with `null`.
 *
 * The write runs inside the mission transaction, so it cannot interleave with
 * a freeze that clears the same file.
 */
export async function writePendingGate(root, slug, pending, options = {}) {
	const rootPath = resolveRoot(root);
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	if (pending !== null && pending !== undefined && !isPlainObject(pending)) {
		return invalidArgument("pending must be an EDN map or null", { field: "pending" });
	}
	const opts = isPlainObject(options) ? options : {};
	const ports = portsFor(rootPath, slug, opts);
	const path = pendingPath(rootPath, slug);
	const response = await runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		if (pending === null || pending === undefined) {
			const removed = await removeFile(ports.documents, path);
			return { response: removed.ok ? { ok: true, pending: null } : removed, commit: false };
		}
		const text = `${printEdn(pending, { indent: " " })}\n`;
		const written = await writeTextFile(ports.documents, path, text);
		return { response: written.ok ? { ok: true, pending: clone(pending) } : written, commit: false };
	});
	return response;
}

function approvalToken(mission, reportSha256, key, contractLine = mission["contract-line"]) {
	return createHmac("sha256", key)
		.update(`${mission["mission-id"]}:${mission.revision}:${contractLine}:${reportSha256}`, "utf8")
		.digest("hex");
}

function approvalRefusal(message, data = {}) {
	return failure(":APPROVAL_REQUIRED", message, { reason: "audit-evidence", ...data });
}

/**
 * The minimal audit gate. T4 already proved full CASE reconciliation, scores,
 * evidence, and snapshot cleanliness before it calls the approval port; this
 * only proves that the call came from a PASS aggregation with a bound second
 * recheck. Re-checking those facts here would duplicate T4's work.
 */
function validateCompletionEvidence(evidence, mission, reportSha256) {
	if (!isPlainObject(evidence)) {
		return approvalRefusal("audit PASS evidence and a bound recheck are required", {
			reason: "audit-evidence-required",
		});
	}
	if (evidence.verdict !== "PASS") {
		return approvalRefusal("the audit aggregate is not PASS", {
			reason: "audit-not-pass",
			verdict: evidence.verdict ?? null,
		});
	}
	if (!Number.isInteger(evidence.caseCount) || evidence.caseCount <= 0) {
		return approvalRefusal("the audit aggregate carries no CASE count", { reason: "case-count" });
	}
	const recheck = evidence.recheck;
	if (!isPlainObject(recheck) || recheck.ok !== true) {
		return approvalRefusal("the second contract/snapshot recheck did not pass", { reason: "recheck-failed" });
	}
	if (
		recheck.missionId !== mission["mission-id"] ||
		recheck.revision !== mission.revision ||
		normalizeHash(recheck.reportSha256) !== reportSha256
	) {
		return approvalRefusal("the second recheck is not bound to this mission, revision, and report", {
			reason: "recheck-binding",
		});
	}
	return { ok: true };
}

/**
 * Take the one-time process authority for approval issuance. The framework
 * assembly calls this once and passes the returned object's ports to the
 * audit/score layer. Later calls return `null`, so a tool handler that runs
 * after assembly cannot mint an approval.
 */
export function takeApprovalAuthority() {
	if (approvalAuthorityTaken) return null;
	approvalAuthorityTaken = true;
	const authority = Object.freeze({
		createPort(root, slug, options = {}) {
			return createApprovalPort(root, slug, options);
		},
	});
	return authority;
}

function asApprovalPortResult(result) {
	if (result !== null && typeof result === "object" && result.ok === true) return result;
	const error = isPlainObject(result?.error)
		? result.error
		: { code: ":APPROVAL_REQUIRED", message: "approval was refused", data: {} };
	return {
		ok: false,
		code: error.code,
		message: error.message,
		error,
	};
}

function createApprovalPort(rootInput, slug, options = {}) {
	const root = resolveRoot(rootInput);
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
		throw new TypeError("approval port needs a valid mission slug");
	}
	const opts = isPlainObject(options) ? options : {};
	let consumed = false;
	let issued = null;
	return Object.freeze({
		/**
		 * The only completion path. `evidence` must be the exact audit
		 * aggregate that reached PASS plus the bound second-recheck result.
		 */
		async issue(missionId, revision, reportSha256Input, evidence) {
			const reportSha256 = normalizeHash(reportSha256Input);
			if (!reportSha256) {
				return asApprovalPortResult(
					invalidArgument("reportSha256 must be 64 hex characters", { field: "reportSha256" }),
				);
			}
			if (!isPlainObject(evidence)) {
				return asApprovalPortResult(
					approvalRefusal(
						"audit aggregate and recheck evidence are required; a report hash alone cannot complete a mission",
						{ reason: "audit-evidence-required" },
					),
				);
			}
			if (consumed) {
				if (
					issued &&
					issued.missionId === missionId &&
					issued.revision === revision &&
					issued.reportSha256 === reportSha256
				) {
					return {
						ok: true,
						alreadyIssued: true,
						approval: issued.approval,
						missionId,
						revision,
					};
				}
				return asApprovalPortResult(
					approvalRefusal("the approval port was already consumed by another mission binding", {
						reason: "port-consumed",
					}),
				);
			}
			const result = await completeAfterAudit({
				root,
				slug,
				missionId,
				revision,
				reportSha256,
				evidence,
				options: opts,
			});
			if (result.ok) {
				consumed = true;
				issued = {
					missionId,
					revision,
					reportSha256,
					approval: result.approval,
				};
			}
			return asApprovalPortResult(result);
		},
	});
}

async function completeAfterAudit({ root, slug, missionId, revision, reportSha256, evidence, options }) {
	const ports = portsFor(root, slug, options);
	const op = "auditApproval";
	const callId = `audit:${missionId}:${revision}:${reportSha256}`;
	const key = receiptKey(callId);
	const payloadHash = sha256(canonicalJson({ op, missionId, revision, reportSha256 }));
	let receiptRecord;
	const response = await runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		const replay = replayReceipt(current, key, payloadHash, callId);
		if (replay) return { response: replay, commit: false };
		if (normalizeStage(current.stage) === "completed") {
			const verified = await verifyApprovalAgainst(current, ports, options);
			if (verified.ok && verified.approval.reportSha256 === reportSha256) {
				return { response: { ok: true, alreadyIssued: true, ...verified }, commit: false };
			}
			return {
				response: approvalRefusal("mission is already completed with a different approval", {
					reason: "already-completed",
					slug,
				}),
				commit: false,
			};
		}
		if (current.approval !== null && current.approval !== undefined) {
			return {
				response: approvalRefusal("mission holds an approval before completion", {
					reason: "approval-present",
					slug,
				}),
				commit: false,
			};
		}
		if (normalizeStage(current.stage) !== "s5") {
			return {
				response: failure(":STAGE_MISMATCH", "approval can only be issued at stage s5", {
					reason: "not-s5",
					stage: current.stage,
				}),
				commit: false,
			};
		}
		if (current["mission-id"] !== missionId || current.revision !== revision) {
			return {
				response: approvalRefusal("the approval port is bound to a different mission or revision", {
					reason: "mission-binding",
					expected: { missionId: current["mission-id"], revision: current.revision },
					actual: { missionId, revision },
				}),
				commit: false,
			};
		}
		const contract = await verifyContractAgainst(current, ports);
		if (!contract.ok) return { response: contract, commit: false };
		const path = reportPath(root, slug, options);
		const report = await readTextFile(ports.documents, path);
		if (!report.ok) {
			return {
				response: approvalRefusal(`s5 report cannot be read: ${report.message}`, {
					reason: report.kind === "missing" ? "report-missing" : "report-unreadable",
					path: `plans/${slug}/${REPORT_PATH}`,
				}),
				commit: false,
			};
		}
		const reportActual = sha256(report.text);
		if (reportActual !== reportSha256) {
			return {
				response: approvalRefusal("s5 report hash does not match the submitted reportSha256", {
					reason: "report-changed",
					expected: reportSha256,
					actual: reportActual,
				}),
				commit: false,
			};
		}
		const audit = validateCompletionEvidence(evidence, current, reportSha256);
		if (!audit.ok) return { response: audit, commit: false };
		const approvalKey = randomBytes(32).toString("hex");
		const keyWritten = await writeTextFile(ports.documents, approvalKeyPath(root, slug), `${approvalKey}\n`);
		if (!keyWritten.ok) return { response: keyWritten, commit: false };
		const token = approvalToken(current, reportSha256, approvalKey, contract.contract.contractLine);
		const next = clone(current);
		next["contract-line"] = contract.contract.contractLine;
		next.approval = {
			revision: current.revision,
			token,
			reportSha256,
			"issued-at": ports.now(),
		};
		next.stage = stageValue("completed");
		next["updated-at"] = ports.now();
		const receipt = {
			ok: true,
			completed: true,
			missionId: next["mission-id"],
			slug,
			revision: next.revision,
			contractLine: next["contract-line"],
			approval: approvalView(next.approval, next["mission-id"]),
		};
		recordReceipt(next, key, payloadHash, receipt);
		receiptRecord = { callId, op, key, payloadHash, receipt };
		return { mission: next, response: receipt, commit: true };
	});
	if (response?.ok && receiptRecord) await writeReceiptFile(ports, receiptRecord);
	return response;
}

/**
 * Verify that a completed mission's approval still binds
 * `(mission-id, revision)` and the current contract and report bytes. The
 * token is recomputed from disk state and the persisted `approval.key`, so
 * this works in a fresh process after a restart.
 */
export async function verifyApproval(root, slug, options = {}) {
	const rootPath = resolveRoot(root);
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	const ports = portsFor(rootPath, slug, options);
	const response = await runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		const verified = await verifyApprovalAgainst(current, ports, options);
		return { response: verified, commit: false };
	});
	return response;
}

/**
 * Bump the revision before another audit/rework round. The old approval
 * binding is invalid by construction because the token contains the revision.
 */
export async function beginRework(root, slug, options = {}) {
	const rootPath = resolveRoot(root);
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	const opts = isPlainObject(options) ? options : {};
	const reason = isText(opts.reason) ? opts.reason.trim() : undefined;
	if (!reason) return invalidArgument("rework reason must be a non-empty string", { field: "reason" });
	const callId = callIdFrom(opts);
	if (callId === null) return invalidArgument("call-id is malformed", { field: "call_id" });
	const ports = portsFor(rootPath, slug, opts);
	const op = "beginRework";
	const key = receiptKey(callId);
	const payloadHash = sha256(canonicalJson({ op, reason }));
	let receiptRecord;
	const response = await runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		const replay = replayReceipt(current, key, payloadHash, callId);
		if (replay) return { response: replay, commit: false };
		if (normalizeStage(current.stage) === "completed") {
			return {
				response: failure(":APPROVAL_REQUIRED", "a completed mission cannot enter rework", {
					reason: "completed",
					slug,
				}),
				commit: false,
			};
		}
		if (normalizeStage(current.stage) !== "s5") {
			return {
				response: failure(":STAGE_MISMATCH", "rework can only start at stage s5", {
					reason: "not-s5",
					stage: current.stage,
				}),
				commit: false,
			};
		}
		if (current.approval !== null && current.approval !== undefined) {
			return {
				response: failure(":APPROVAL_REQUIRED", "mission holds an approval before completion", {
					reason: "approval-present",
					slug,
				}),
				commit: false,
			};
		}
		const next = clone(current);
		next.revision = current.revision + 1;
		next["rework-count"] = (Number.isInteger(next["rework-count"]) ? next["rework-count"] : 0) + 1;
		next["last-rework"] = { reason, revision: next.revision, at: ports.now() };
		next["updated-at"] = ports.now();
		const receipt = { ok: true, status: "rework", stage: "s5", revision: next.revision };
		recordReceipt(next, key, payloadHash, receipt);
		if (key !== undefined) receiptRecord = { callId, op, key, payloadHash, receipt };
		return { mission: next, response: receipt, commit: true };
	});
	if (response?.ok && receiptRecord) await writeReceiptFile(ports, receiptRecord);
	return response;
}

// Exported only so tests can prove the EDN round trip without exposing the
// reader as a general-purpose API.
export const __test = Object.freeze({ parseEdn, sha256, canonicalJson });
