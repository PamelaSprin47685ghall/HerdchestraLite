/**
 * Plan-stage persistence and mission control.
 *
 * The module owns `.herd/missions/<slug>/mission.edn`, the stage documents
 * under `plans/<slug>/`, the S2 CASE dataset, the asynchronous S1 gate record
 * `pending-gate.edn`, and the one-time approval record.
 *
 * There is no frozen hash map, no contract line, and no realignment in this
 * layer. A stage document is written once by its attach tool and then read as
 * plain text. A human edit is allowed; nothing detects or replays it.
 *
 * Storage is injected:
 *   store.read()                  -> mission | null
 *   store.transaction(fn)         -> fn(current) -> {mission?, response, commit?}
 *   documents.readText(path)      -> {ok:true, text} | {ok:false, code, message}
 *   documents.writeText(path,text)-> {ok:true} | {ok:false, code, message}
 *   documents.remove(path)        -> {ok:true} | {ok:false, code, message}
 *   documents.listDir(path)       -> {ok:true, names} | {ok:false, code, message}
 *
 * S1-S4 have a single writer, so the disk store takes no mission lock: one
 * read-transform-atomic-write pass is enough. The documents port writes
 * through `writeFileAtomic` (temp file, fsync, rename).
 *
 * All public functions return `{ok:true, ...}` or
 * `{ok:false, error:{code, message, data}}`. Expected failures never throw.
 * A malformed `mission.edn`, a strange port, or a store protocol violation is
 * a failure, never an implicit "continue with defaults".
 *
 * Limits:
 * - The approval token is `HMAC-SHA256(approval.key, mission-id:revision:
 *   report-sha256)`. The framework writes a fresh random key to
 *   `.herd/missions/<slug>/approval.key` only inside the completion
 *   transaction, so editing `mission.edn` alone cannot mint an approval.
 * - The key is the only approval control state. A missing, empty, or
 *   malformed key fails closed.
 * - `updateMission` is the single mission write path for the attach layer. It
 *   keeps every field the patch does not name and refuses to remove the
 *   protected control fields.
 */

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "../util/atomic-write.mjs";
import { herdError, isHerdError, messageOf, printEdn } from "../util/errors.mjs";
import { normalizeCaseSpecs } from "./parsers.mjs";
import {
	archiveBoardPath as tenureArchiveBoardPath,
	attachToolForStage,
	emptyBoard as tenureEmptyBoard,
	successorTenureId,
} from "./tenure.mjs";

/** Plan stages that own one attach tool each. */
export const STAGE_IDS = Object.freeze(["s1", "s2", "s3", "s4"]);
export const MISSION_STAGES = Object.freeze(["s1", "s2", "s3", "s4", "s5", "completed"]);

/**
 * Deterministic document names. S4 owns a second document, `s4-promela`,
 * because the coordination stage attaches both prose and a Promela sketch.
 */
export const STAGE_DOCUMENTS = Object.freeze({
	s1: Object.freeze({ stage: "s1", file: "s1-brainstorm.md" }),
	s2: Object.freeze({ stage: "s2", file: "s2-manual-tests.md" }),
	s3: Object.freeze({ stage: "s3", file: "s3-dev-guide.md" }),
	s4: Object.freeze({ stage: "s4", file: "s4-coordination.md" }),
	"s4-promela": Object.freeze({ stage: "s4-promela", file: "s4-promela.md" }),
});

export const DOCUMENT_STAGES = Object.freeze(["s1", "s2", "s3", "s4", "s4-promela"]);

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEX64_RE = /^[0-9a-f]{64}$/i;
const REPORT_PATH = "s5-report.md";
const S2_CASES_PATH = "s2-cases.edn";

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

function isSlug(value) {
	return typeof value === "string" && SLUG_RE.test(value);
}

function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
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

function stageValue(stage) {
	return `:${stage}`;
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
 * Canonical mission stage id without the EDN colon. Accepts `s1`, `:s1`, `S1`,
 * and `1`. Returns `undefined` for anything else.
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

/**
 * Canonical document stage id without the EDN colon. Accepts the four plan
 * stages plus `s4-promela` and `s4_promela`.
 */
export function normalizeDocumentStage(value) {
	if (typeof value !== "string") return undefined;
	const text = value
		.trim()
		.replace(/^:/, "")
		.toLowerCase()
		.replace(/_/g, "-");
	if (text === "s4-promela" || text === "s4promela") return "s4-promela";
	const stage = normalizeStage(text);
	return STAGE_IDS.includes(stage) ? stage : undefined;
}

/** The mission stage that owns one document stage. */
export function hostStageOf(value) {
	const stage = normalizeDocumentStage(value);
	if (!stage) return undefined;
	return stage === "s4-promela" ? "s4" : stage;
}

/**
 * Repository-relative path of one S1-S4 stage document.
 *
 * Throws on an invalid slug or a non-document stage: both are programmer
 * errors, not user input. Gate payload validation happens before this helper
 * is called.
 */
export function stageDocumentPath(slug, stage) {
	if (!isSlug(slug)) throw new TypeError("invalid mission slug");
	const id = normalizeDocumentStage(stage);
	if (!id) throw new TypeError("stage must be s1, s2, s3, s4, or s4-promela");
	return `plans/${slug}/${STAGE_DOCUMENTS[id].file}`;
}

/** Repository-relative path of the S2 CASE dataset. */
export function s2CasesPath(slug) {
	if (!isSlug(slug)) throw new TypeError("invalid mission slug");
	return `.herd/missions/${slug}/${S2_CASES_PATH}`;
}

/** Repository-relative path of one mission's `mission.edn`. */
export function missionPathOf(slug) {
	if (!isSlug(slug)) throw new TypeError("invalid mission slug");
	return `.herd/missions/${slug}/mission.edn`;
}

function missionDirectory(root, slug) {
	return join(root, ".herd", "missions", slug);
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
// CASE dataset helpers
// ---------------------------------------------------------------------------

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
		throw herdError(":INVALID_ARGUMENT", "s2-cases.edn must hold a non-empty CASE vector", {});
	}
	return canonicalCases(value);
}

function caseIdsOf(cases) {
	return cases.map((entry) => entry["case-id"]);
}

function canonicalEdnFile(value) {
	return `${printEdn(value, { indent: " " })}\n`;
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
 * Durable mission store for one mission. S1-S4 have a single writer, so no
 * mission lock is taken: the store reads, transforms, and writes `mission.edn`
 * atomically in one pass.
 */
function createDiskMissionStore(root, slug) {
	const path = missionPath(root, slug);
	return {
		async read() {
			return readDiskMission(path);
		},
		async transaction(fn) {
			const current = readDiskMission(path);
			const outcome = await fn(current);
			if (outcome && outcome.commit !== false && outcome.mission !== undefined) {
				writeFileAtomic(dirname(path), "mission.edn", `${printEdn(outcome.mission, { indent: " " })}\n`);
			}
			return outcome?.response;
		},
	};
}

/**
 * In-memory store for tests and for the gate layer when it already owns a
 * process-local transaction. One transaction runs at a time.
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
	const store = options.store ?? createDiskMissionStore(root, slug);
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
			return invalidArgument("mission store returned no response", { slug: ports.slug, reason: "store-protocol" });
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
	const key = read.text.trim();
	if (!HEX64_RE.test(key)) {
		return { ok: false, reason: "invalid", message: "approval.key must contain 64 hex characters" };
	}
	return { ok: true, key };
}

// ---------------------------------------------------------------------------
// Mission shape and preconditions
// ---------------------------------------------------------------------------

function normalizeApproval(raw) {
	if (!isPlainObject(raw)) return undefined;
	const issuedAt = raw["issued-at"] ?? raw.issuedAt;
	const reportSha256 = raw.reportSha256 ?? raw["report-sha256"];
	const token = raw.token;
	if (!Number.isInteger(raw.revision) || raw.revision < 0) return undefined;
	if (typeof token !== "string" || !HEX64_RE.test(token)) return undefined;
	if (typeof reportSha256 !== "string" || !HEX64_RE.test(reportSha256)) return undefined;
	if (!isText(issuedAt)) return undefined;
	return { revision: raw.revision, token, reportSha256, issuedAt };
}

function approvalView(approval, missionId) {
	return {
		missionId,
		revision: approval.revision,
		token: approval.token,
		reportSha256: approval.reportSha256,
		issuedAt: approval.issuedAt,
	};
}

function missionShapeProblem(mission) {
	if (!isPlainObject(mission)) return failure(":INVALID_ARGUMENT", "mission must be an EDN map", {});
	if (!isText(mission["mission-id"])) {
		return failure(":INVALID_ARGUMENT", "mission.edn has no mission-id", { field: "mission-id" });
	}
	if (!isSlug(mission.slug)) {
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
	if (mission.tenure !== undefined && mission.tenure !== null) {
		if (!isPlainObject(mission.tenure) || !isText(mission.tenure["tenure-id"])) {
			return failure(":INVALID_ARGUMENT", "mission.edn tenure is malformed", { field: "tenure" });
		}
	}
	if (mission.attach !== undefined && mission.attach !== null && !isPlainObject(mission.attach)) {
		return failure(":INVALID_ARGUMENT", "mission.edn attach must be a map", { field: "attach" });
	}
	if (mission.barrier !== undefined && mission.barrier !== null && !isPlainObject(mission.barrier)) {
		return failure(":INVALID_ARGUMENT", "mission.edn barrier must be a map or null", { field: "barrier" });
	}
	if (stage === "completed") {
		const approval = normalizeApproval(mission.approval);
		if (!approval) {
			return failure(":APPROVAL_REQUIRED", "completed mission has no verifiable approval record", {
				reason: "completed-without-approval",
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
 * Structural mission check. Approval presence is checked here; the token and
 * the report binding are checked by `verifyApproval`.
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

const PROTECTED_MISSION_KEYS = Object.freeze([
	"mission-id",
	"slug",
	"revision",
	"created-at",
	"stage",
	"tenure",
	"attach",
	"barrier",
	"approval",
]);

function applyMissionPatch(current, patch, timestamp) {
	const next = clone(current);
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) {
			if (PROTECTED_MISSION_KEYS.includes(key)) {
				return invalidArgument(`mission field ${key} cannot be removed`, { field: key });
			}
			delete next[key];
			continue;
		}
		next[key] = clone(value);
	}
	next["updated-at"] = isText(patch["updated-at"]) ? patch["updated-at"] : timestamp;
	return { ok: true, mission: next };
}

// ---------------------------------------------------------------------------
// Public mission lifecycle
// ---------------------------------------------------------------------------

/**
 * Create one mission in stage S1 with revision 0.
 *
 * `options` may carry `missionId`, `seed`, `limits`, `settings`, `tenure`,
 * `attach`, and the injected `store`, `documents`, and `now` ports.
 */
export async function createMission(root, options = {}) {
	const rootPath = resolveRoot(root);
	const opts = isPlainObject(options) ? options : {};
	const slug = opts.slug;
	if (!isSlug(slug)) {
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
			tenure: isPlainObject(opts.tenure)
				? clone(opts.tenure)
				: { "tenure-id": randomUUID(), index: 1, "started-at": timestamp, "ended-at": null },
			attach: isPlainObject(opts.attach) ? clone(opts.attach) : {},
			barrier: null,
			approval: null,
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
 * approval token recomputes from the mission, revision, report bytes, and the
 * persisted `approval.key`.
 */
export async function readMission(root, slug, options = {}) {
	const rootPath = resolveRoot(root);
	if (!isSlug(slug)) {
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
		const verified = await verifyApprovalAgainst(mission, ports);
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
 * Re-registering the same id is idempotent; replacing it with a different id
 * is refused so a restart cannot silently create a second investigator.
 */
export async function writeDevopsSessionRef(root, slug, ref, options = {}) {
	const rootPath = resolveRoot(root);
	if (!isSlug(slug)) {
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
 * The single mission write path for the attach layer.
 *
 * `update` is a plain patch map or a function that receives a cloned mission
 * and returns a patch (or null for no change). The patch is applied with
 * shallow merge semantics: an absent key keeps its current value, a present
 * key replaces it, and `undefined` deletes an optional key. The protected
 * control fields (`mission-id`, `slug`, `revision`, `created-at`, `stage`,
 * `tenure`, `attach`, `barrier`, `approval`) cannot be removed, so an attach
 * tool cannot accidentally drop the approval record or the tenure identity.
 *
 * The read, patch, structural validation, and atomic `mission.edn` write run
 * in one store transaction. `updated-at` is refreshed unless the patch names
 * it explicitly.
 */
export async function updateMission(root, slug, update, options = {}) {
	const rootPath = resolveRoot(root);
	if (!isSlug(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	if (typeof update !== "function" && !isPlainObject(update)) {
		return invalidArgument("update must be an object or a function", { field: "update" });
	}
	const ports = portsFor(rootPath, slug, isPlainObject(options) ? options : {});
	return runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		let patch;
		try {
			patch = typeof update === "function" ? await update(clone(current)) : update;
		} catch (error) {
			return { response: failure(codeOf(error), messageOf(error), dataOf(error)), commit: false };
		}
		if (patch === null || patch === undefined) {
			return { response: { ok: true, mission: clone(current), changed: false }, commit: false };
		}
		if (!isPlainObject(patch)) {
			return {
				response: invalidArgument("update function must return an object or null", { field: "update" }),
				commit: false,
			};
		}
		const applied = applyMissionPatch(current, patch, ports.now());
		if (!applied.ok) return { response: applied, commit: false };
		const valid = validateMission(applied.mission);
		if (!valid.ok) return { response: valid, commit: false };
		return {
			mission: applied.mission,
			response: { ok: true, mission: clone(applied.mission), changed: true },
			commit: true,
		};
	});
}

// ---------------------------------------------------------------------------
// Stage documents and the S2 dataset
// ---------------------------------------------------------------------------

/**
 * Write one stage document from the supplied markdown and return its
 * repository-relative path.
 *
 * The write is atomic, is read back byte-for-byte, and does not advance the
 * mission stage. The mission must already sit on the document's host stage:
 * `s4-promela` belongs to S4. Manual edits are allowed; the next write simply
 * replaces the file.
 */
export async function saveDocument(root, slug, stageInput, markdown, options = {}) {
	const rootPath = resolveRoot(root);
	if (!isSlug(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	const stage = normalizeDocumentStage(stageInput);
	if (!stage) {
		return failure(":STAGE_MISMATCH", "stage must be s1, s2, s3, s4, or s4-promela", {
			stage: stageInput,
		});
	}
	if (typeof markdown !== "string" || markdown.trim().length === 0) {
		return invalidArgument("markdown must be a non-empty string", { field: "markdown", stage: stageValue(stage) });
	}
	const ports = portsFor(rootPath, slug, isPlainObject(options) ? options : {});
	const relative = stageDocumentPath(slug, stage);
	const absolute = join(rootPath, relative);
	const host = hostStageOf(stage);
	return runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		if (normalizeStage(current.stage) !== host) {
			return {
				response: failure(":STAGE_MISMATCH", `cannot write ${stage} while the mission is at ${current.stage}`, {
					stage: stageValue(stage),
					"mission-stage": current.stage,
				}),
				commit: false,
			};
		}
		const written = await writeTextFile(ports.documents, absolute, markdown);
		if (!written.ok) return { response: written, commit: false };
		const read = await readTextFile(ports.documents, absolute);
		if (!read.ok || read.text !== markdown) {
			return {
				response: invalidArgument(`saved ${relative} cannot be read back unchanged`, {
					path: relative,
					reason: read.ok ? "readback-mismatch" : read.kind,
					"system-code": read.systemCode ?? null,
				}),
				commit: false,
			};
		}
		const next = clone(current);
		next["updated-at"] = ports.now();
		return {
			mission: next,
			response: {
				ok: true,
				stage,
				path: relative,
				bytes: Buffer.byteLength(markdown, "utf8"),
			},
			commit: true,
		};
	});
}

/**
 * Commit S2's two authoritative inputs atomically enough for a single writer:
 * `.herd/missions/<slug>/s2-cases.edn` and
 * `plans/<slug>/s2-manual-tests.md`.
 *
 * Both files are written, read back, and compared before the mission record
 * advances its `updated-at`. The mission stage is not advanced here; the
 * attach tool owns the barrier and the successor tenure.
 */
export async function commitS2(root, slug, params = {}, options = {}) {
	const rootPath = resolveRoot(root);
	if (!isSlug(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	if (!isPlainObject(params)) {
		return invalidArgument("S2 params must be an object", { field: "params" });
	}
	const markdown = params.markdown ?? params.manual_tests_markdown;
	const casesInput = params.cases;
	if (typeof markdown !== "string" || markdown.trim().length === 0) {
		return invalidArgument("markdown must be a non-empty string", { field: "markdown" });
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
	const ports = portsFor(rootPath, slug, isPlainObject(options) ? options : {});
	const docRelative = stageDocumentPath(slug, "s2");
	const casesRelative = s2CasesPath(slug);
	const docAbsolute = join(rootPath, docRelative);
	const casesAbsolute = join(rootPath, casesRelative);
	return runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		if (normalizeStage(current.stage) !== "s2") {
			return {
				response: failure(":STAGE_MISMATCH", `expected stage s2, mission is at ${current.stage}`, {
					stage: "s2",
					"mission-stage": current.stage,
				}),
				commit: false,
			};
		}
		const casesWritten = await writeTextFile(ports.documents, casesAbsolute, casesBytes);
		if (!casesWritten.ok) return { response: casesWritten, commit: false };
		const docWritten = await writeTextFile(ports.documents, docAbsolute, markdown);
		if (!docWritten.ok) return { response: docWritten, commit: false };
		const casesRead = await readTextFile(ports.documents, casesAbsolute);
		const docRead = await readTextFile(ports.documents, docAbsolute);
		if (!casesRead.ok || casesRead.text !== casesBytes) {
			return {
				response: invalidArgument("s2-cases.edn cannot be read back unchanged", {
					path: casesRelative,
					reason: casesRead.ok ? "readback-mismatch" : casesRead.kind,
				}),
				commit: false,
			};
		}
		if (!docRead.ok || docRead.text !== markdown) {
			return {
				response: invalidArgument("s2-manual-tests.md cannot be read back unchanged", {
					path: docRelative,
					reason: docRead.ok ? "readback-mismatch" : docRead.kind,
				}),
				commit: false,
			};
		}
		let stored;
		try {
			stored = parseCasesDocument(casesRead.text);
		} catch (error) {
			return { response: failure(codeOf(error), messageOf(error), dataOf(error)), commit: false };
		}
		const next = clone(current);
		next["updated-at"] = ports.now();
		return {
			mission: next,
			response: {
				ok: true,
				stage: "s2",
				path: docRelative,
				casesPath: casesRelative,
				caseIds: caseIdsOf(stored),
				cases: clone(stored),
			},
			commit: true,
		};
	});
}

/**
 * Read the S2 CASE dataset. Returns the parsed cases and their ids; no hash or
 * byte mirror is exposed because the dataset is authoritative on its own.
 */
export async function readS2Cases(root, slug, options = {}) {
	const rootPath = resolveRoot(root);
	if (!isSlug(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	const opts = isPlainObject(options) ? options : {};
	const documents = opts.documents ?? createDiskDocuments();
	const relative = s2CasesPath(slug);
	const read = await readTextFile(documents, join(rootPath, relative));
	if (!read.ok) {
		return invalidArgument(`cannot read ${relative}: ${read.message}`, {
			path: relative,
			reason: read.kind,
			"system-code": read.systemCode,
		});
	}
	try {
		const cases = parseCasesDocument(read.text);
		return { ok: true, path: relative, cases, caseIds: caseIdsOf(cases) };
	} catch (error) {
		return failure(codeOf(error), messageOf(error), dataOf(error));
	}
}

// ---------------------------------------------------------------------------
// Asynchronous S1 gate record
// ---------------------------------------------------------------------------

/**
 * Read the asynchronous S1 gate record. A missing or empty file means no gate
 * is waiting. Corrupt EDN is a hard failure, not "no pending gate".
 */
export async function readPendingGate(root, slug, options = {}) {
	const rootPath = resolveRoot(root);
	if (!isSlug(slug)) {
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
 * The record is a single atomic document write; it does not touch
 * `mission.edn`, so an attach tool can clear it without racing the mission
 * transaction.
 */
export async function writePendingGate(root, slug, pending, options = {}) {
	const rootPath = resolveRoot(root);
	if (!isSlug(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	if (pending !== null && pending !== undefined && !isPlainObject(pending)) {
		return invalidArgument("pending must be an EDN map or null", { field: "pending" });
	}
	const opts = isPlainObject(options) ? options : {};
	const ports = portsFor(rootPath, slug, opts);
	const current = await ports.store.read();
	const ready = missionPrecondition(current, slug);
	if (!ready.ok) return ready;
	const path = pendingPath(rootPath, slug);
	if (pending === null || pending === undefined) {
		const removed = await removeFile(ports.documents, path);
		return removed.ok ? { ok: true, pending: null } : removed;
	}
	const text = `${printEdn(pending, { indent: " " })}\n`;
	const written = await writeTextFile(ports.documents, path, text);
	return written.ok ? { ok: true, pending: clone(pending) } : written;
}

// ---------------------------------------------------------------------------
// One-time approval
// ---------------------------------------------------------------------------

function approvalToken(mission, reportSha256, key) {
	return createHmac("sha256", key)
		.update(`${mission["mission-id"]}:${mission.revision}:${reportSha256}`, "utf8")
		.digest("hex");
}

function approvalRefusal(message, data = {}) {
	return failure(":APPROVAL_REQUIRED", message, { reason: "audit-evidence", ...data });
}

/**
 * The minimal audit gate. T4 already proved full CASE reconciliation, scores,
 * evidence, and workspace cleanliness before it calls the approval port; this
 * only proves that the call came from a PASS aggregation with a bound second
 * recheck.
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
		typeof recheck.reportSha256 !== "string" ||
		!HEX64_RE.test(recheck.reportSha256) ||
		recheck.reportSha256 !== reportSha256
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
	if (!isSlug(slug)) {
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
			const reportSha256 = typeof reportSha256Input === "string" ? reportSha256Input.trim().toLowerCase() : "";
			if (!HEX64_RE.test(reportSha256)) {
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
	const response = await runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		if (normalizeStage(current.stage) === "completed") {
			const verified = await verifyApprovalAgainst(current, ports);
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
		const report = await readTextFile(ports.documents, reportPath(root, slug, options));
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
		const token = approvalToken(current, reportSha256, approvalKey);
		const next = clone(current);
		next.approval = {
			revision: current.revision,
			token,
			reportSha256,
			"issued-at": ports.now(),
		};
		next.stage = stageValue("completed");
		next["updated-at"] = ports.now();
		return {
			mission: next,
			response: {
				ok: true,
				completed: true,
				missionId: next["mission-id"],
				slug,
				revision: next.revision,
				approval: approvalView(normalizeApproval(next.approval), next["mission-id"]),
			},
			commit: true,
		};
	});
	return response;
}

/**
 * Verify that a completed mission's approval still binds `(mission-id,
 * revision)` and the current report bytes. The token is recomputed from disk
 * state and the persisted `approval.key`, so this works in a fresh process
 * after a restart.
 */
export async function verifyApproval(root, slug, options = {}) {
	const rootPath = resolveRoot(root);
	if (!isSlug(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	const ports = portsFor(rootPath, slug, options);
	const response = await runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		const verified = await verifyApprovalAgainst(current, ports);
		return { response: verified, commit: false };
	});
	return response;
}

async function verifyApprovalAgainst(mission, ports) {
	const approval = normalizeApproval(mission.approval);
	if (!approval) {
		return approvalRefusal("mission has no verifiable approval record", { reason: "approval-missing" });
	}
	if (approval.revision !== mission.revision) {
		return approvalRefusal("approval revision does not match the mission revision", {
			reason: "revision",
			expected: mission.revision,
			actual: approval.revision,
		});
	}
	const keyRead = await readApprovalKey(ports.documents, approvalKeyPath(ports.root, ports.slug));
	if (!keyRead.ok) {
		return approvalRefusal(`approval.key is unusable: ${keyRead.message}`, { reason: keyRead.reason });
	}
	const expected = approvalToken(mission, approval.reportSha256, keyRead.key);
	if (expected !== approval.token) {
		return approvalRefusal("approval token does not recompute", { reason: "token" });
	}
	const report = await readTextFile(ports.documents, reportPath(ports.root, ports.slug, ports.options));
	if (!report.ok) {
		return approvalRefusal(`s5 report cannot be read: ${report.message}`, {
			reason: report.kind === "missing" ? "report-missing" : "report-unreadable",
		});
	}
	const actual = sha256(report.text);
	if (actual !== approval.reportSha256) {
		return approvalRefusal("s5 report changed after approval", {
			reason: "report-changed",
			expected: approval.reportSha256,
			actual,
		});
	}
	return { ok: true, approval: approvalView(approval, mission["mission-id"]) };
}

/**
 * Bump the revision before another audit/rework round. The old approval
 * binding is invalid by construction because the token contains the revision.
 */
export async function beginRework(root, slug, options = {}) {
	const rootPath = resolveRoot(root);
	if (!isSlug(slug)) {
		return invalidArgument("invalid mission slug", { field: "slug" });
	}
	const opts = isPlainObject(options) ? options : {};
	const reason = isText(opts.reason) ? opts.reason.trim() : undefined;
	if (!reason) return invalidArgument("rework reason must be a non-empty string", { field: "reason" });
	const ports = portsFor(rootPath, slug, opts);
	const response = await runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
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
		return {
			mission: next,
			response: { ok: true, status: "rework", stage: "s5", revision: next.revision },
			commit: true,
		};
	});
	return response;
}

// Exported only so tests can prove the EDN round trip without exposing the
// reader as a general-purpose API.
export const __test = Object.freeze({ parseEdn, sha256, canonicalJson });

// ---------------------------------------------------------------------------
// Plan board and tenure advance ports
// ---------------------------------------------------------------------------

function boardPathOf(slug) {
	return `.herd/missions/${slug}/board.edn`;
}

function boardText(board) {
	return `${printEdn(board, { indent: " " })}\n`;
}

function emptyPlanBoard(tenureId) {
	if (isText(tenureId)) return tenureEmptyBoard(tenureId.trim());
	return {
		"board-version": 0,
		"tenure-id": null,
		"review-summary": null,
		tasks: {},
		"attach-ready": false,
	};
}

function nextPlanStage(stage) {
	const index = STAGE_IDS.indexOf(stage);
	if (index === -1 || index === STAGE_IDS.length - 1) return "s5";
	return STAGE_IDS[index + 1];
}

function tenureSequenceOf(tenureId, fallback) {
	const match = /\d+$/.exec(typeof tenureId === "string" ? tenureId : "");
	if (match !== null) return Number(match[0]);
	return Number.isInteger(fallback) && fallback >= 0 ? fallback + 1 : 1;
}

function boardTenureId(board, mission) {
	const fromBoard = isPlainObject(board) && isText(board["tenure-id"]) ? board["tenure-id"].trim() : null;
	if (fromBoard !== null) return fromBoard;
	if (isPlainObject(mission?.tenure) && isText(mission.tenure["tenure-id"])) return mission.tenure["tenure-id"].trim();
	if (isText(mission?.["tenure-id"])) return mission["tenure-id"].trim();
	return null;
}

function invalidBoard(message, data = {}) {
	return failure(":BOARD_CONFLICT", message, data);
}

/**
 * Read one Plan tenure's review board from `.herd/missions/<slug>/board.edn`.
 *
 * A missing board is not an error: the tenure starts with an empty board whose
 * tenure id comes from `mission.edn`. A corrupt board is a `:BOARD_CONFLICT`.
 * `pendingAttach` mirrors the board's optional `pending-attach` map.
 */
export async function readBoard(root, slug, options = {}) {
	const rootPath = resolveRoot(root);
	if (!isSlug(slug)) return invalidArgument("invalid mission slug", { field: "slug" });
	const ports = portsFor(rootPath, slug, isPlainObject(options) ? options : {});
	const relative = boardPathOf(slug);
	const absolute = join(rootPath, relative);
	let read;
	try {
		read = await ports.documents.readText(absolute);
	} catch (error) {
		return invalidBoard(`cannot read ${relative}: ${messageOf(error)}`, {
			path: relative,
			"system-code": error?.code ?? null,
		});
	}
	if (read?.ok !== true) {
		if (read?.code !== "ENOENT") {
			return invalidBoard(`cannot read ${relative}`, {
				path: relative,
				"system-code": typeof read?.code === "string" ? read.code : null,
			});
		}
		let mission;
		try {
			mission = await ports.store.read();
		} catch (error) {
			return failure(codeOf(error), messageOf(error), dataOf(error));
		}
		return { ok: true, board: emptyPlanBoard(boardTenureId(null, mission)), pendingAttach: null, path: relative };
	}
	if (typeof read.text !== "string" || read.text.trim().length === 0) {
		return invalidBoard(`${relative} is empty`, { path: relative, reason: "board-empty" });
	}
	let board;
	try {
		board = parseEdn(read.text);
	} catch (error) {
		return invalidBoard(`${relative} is not valid EDN: ${messageOf(error)}`, { path: relative, reason: "board-edn" });
	}
	if (!isPlainObject(board) || !isPlainObject(board.tasks)) {
		return invalidBoard(`${relative} must hold one EDN map with a tasks map`, {
			path: relative,
			reason: "board-shape",
		});
	}
	const pendingAttach = isPlainObject(board["pending-attach"]) ? board["pending-attach"] : null;
	return { ok: true, board, pendingAttach, path: relative };
}

/**
 * Atomically write one Plan tenure's review board and read it back.
 */
export async function writeBoard(root, slug, board, options = {}) {
	const rootPath = resolveRoot(root);
	if (!isSlug(slug)) return invalidArgument("invalid mission slug", { field: "slug" });
	if (!isPlainObject(board) || !isPlainObject(board.tasks)) {
		return invalidArgument("board must be a plain object with a tasks map", { field: "board" });
	}
	const ports = portsFor(rootPath, slug, isPlainObject(options) ? options : {});
	const relative = boardPathOf(slug);
	const text = boardText(board);
	const written = await writeTextFile(ports.documents, join(rootPath, relative), text);
	if (!written.ok) return invalidBoard(written.error.message, { ...written.error.data, path: relative });
	const read = await readTextFile(ports.documents, join(rootPath, relative));
	if (!read.ok || read.text !== text) {
		return invalidBoard(`saved ${relative} cannot be read back unchanged`, {
			path: relative,
			reason: read.ok ? "readback-mismatch" : read.kind,
			"system-code": read.systemCode ?? null,
		});
	}
	return { ok: true, board: clone(board), path: relative };
}

/**
 * Archive one retired tenure's board at `.herd/boards/<tenure-id>.edn`.
 */
export async function archiveBoard(root, slug, board, options = {}) {
	const rootPath = resolveRoot(root);
	if (!isSlug(slug)) return invalidArgument("invalid mission slug", { field: "slug" });
	if (!isPlainObject(board) || !isPlainObject(board.tasks)) {
		return invalidArgument("board must be a plain object with a tasks map", { field: "board" });
	}
	const ports = portsFor(rootPath, slug, isPlainObject(options) ? options : {});
	let tenureId = boardTenureId(board, null);
	if (tenureId === null) {
		let mission;
		try {
			mission = await ports.store.read();
		} catch (error) {
			return failure(codeOf(error), messageOf(error), dataOf(error));
		}
		tenureId = boardTenureId(null, mission);
	}
	if (tenureId === null) return invalidBoard("board has no tenure-id", { slug, reason: "tenure-missing" });
	const relative = tenureArchiveBoardPath(tenureId);
	const text = boardText(board);
	const written = await writeTextFile(ports.documents, join(rootPath, relative), text);
	if (!written.ok) return invalidBoard(written.error.message, { ...written.error.data, path: relative });
	return { ok: true, path: relative };
}

/**
 * Retire the current tenure: write the stage deliverables, archive the board,
 * open the successor board, and move `mission.edn` to the next stage.
 *
 * `attach` is the gate payload: `{stage, tool, board, barrier, successor,
 * markdown, cases, promela, call_id, digest}`. The mission lock is not taken;
 * every document is an atomic write, and `mission.edn` moves in one store
 * transaction after the documents land.
 */
export async function advanceTenure(root, slug, attach = {}, options = {}) {
	const rootPath = resolveRoot(root);
	if (!isSlug(slug)) return invalidArgument("invalid mission slug", { field: "slug" });
	if (!isPlainObject(attach)) return invalidArgument("attach must be an object", { field: "attach" });
	const stage = normalizeStage(attach.stage);
	if (stage === undefined || stage === "s5" || stage === "completed") {
		return failure(":STAGE_MISMATCH", "advanceTenure needs one Plan stage: s1, s2, s3, or s4", {
			stage: attach.stage ?? null,
		});
	}
	const tool = isText(attach.tool) ? attach.tool.trim() : null;
	if (tool === null) {
		return invalidArgument("tool must be a non-empty string", { field: "tool", stage: stageValue(stage) });
	}
	if (typeof attach.markdown !== "string" || attach.markdown.trim().length === 0) {
		return invalidArgument("markdown must be a non-empty string", { field: "markdown", stage: stageValue(stage) });
	}
	const board = attach.board;
	if (!isPlainObject(board) || !isPlainObject(board.tasks)) {
		return invalidArgument("board must be a plain object with a tasks map", { field: "board" });
	}
	let casesText = null;
	if (stage === "s2") {
		if (!Array.isArray(attach.cases) || attach.cases.length === 0) {
			return invalidArgument("cases must be a non-empty array", { field: "cases" });
		}
		try {
			casesText = canonicalEdnFile(canonicalCases(attach.cases));
		} catch (error) {
			return failure(codeOf(error), messageOf(error), dataOf(error));
		}
	}
	if (stage === "s4" && (typeof attach.promela !== "string" || attach.promela.trim().length === 0)) {
		return invalidArgument("promela must be a non-empty string", { field: "promela" });
	}
	const ports = portsFor(rootPath, slug, isPlainObject(options) ? options : {});
	const now = ports.now();
	const successorIdFromAttach =
		isPlainObject(attach.successor) && isText(attach.successor["tenure-id"])
			? attach.successor["tenure-id"].trim()
			: null;
	return runTransaction(ports, async (current) => {
		const ready = missionPrecondition(current, slug);
		if (!ready.ok) return { response: ready, commit: false };
		if (normalizeStage(current.stage) !== stage) {
			return {
				response: failure(":STAGE_MISMATCH", `cannot advance ${stage} while the mission is at ${current.stage}`, {
					stage: stageValue(stage),
					"mission-stage": current.stage,
				}),
				commit: false,
			};
		}
		const tenureId = boardTenureId(board, current);
		if (tenureId === null) {
			return { response: invalidBoard("board has no tenure-id", { slug, reason: "tenure-missing" }), commit: false };
		}
		const successorId = successorIdFromAttach ?? successorTenureId(current, board);
		const nextStage = nextPlanStage(stage);
		const archiveRelative = tenureArchiveBoardPath(tenureId);
		const writes = [[stageDocumentPath(slug, stage), attach.markdown]];
		if (stage === "s2") writes.push([s2CasesPath(slug), casesText]);
		if (stage === "s4") writes.push([stageDocumentPath(slug, "s4-promela"), attach.promela]);
		for (const [relative, text] of writes) {
			const absolute = join(rootPath, relative);
			const written = await writeTextFile(ports.documents, absolute, text);
			if (!written.ok) return { response: written, commit: false };
			const read = await readTextFile(ports.documents, absolute);
			if (!read.ok || read.text !== text) {
				return {
					response: invalidArgument(`saved ${relative} cannot be read back unchanged`, {
						path: relative,
						reason: read.ok ? "readback-mismatch" : read.kind,
						"system-code": read.systemCode ?? null,
					}),
					commit: false,
				};
			}
		}
		const archived = await writeTextFile(ports.documents, join(rootPath, archiveRelative), boardText(board));
		if (!archived.ok) return { response: archived, commit: false };
		const successorBoard = tenureEmptyBoard(successorId);
		const successorWritten = await writeTextFile(
			ports.documents,
			join(rootPath, boardPathOf(slug)),
			boardText(successorBoard),
		);
		if (!successorWritten.ok) return { response: successorWritten, commit: false };
		const barrier = isPlainObject(attach.barrier)
			? clone(attach.barrier)
			: {
					from: stage,
					to: nextStage,
					"retired-tenure": tenureId,
					"successor-tenure": successorId,
					"board-archive": archiveRelative,
					"review-summary": board["review-summary"] ?? null,
					"attach-tool": tool,
					at: now,
				};
		const attached = {
			stage,
			tool,
			"call-id": attach.call_id ?? null,
			digest: attach.digest ?? null,
			"board-archive": archiveRelative,
			at: now,
		};
		const sequence = tenureSequenceOf(
			successorId,
			Number.isInteger(current["tenure-seq"]) ? current["tenure-seq"] : current.tenure?.index,
		);
		const next = clone(current);
		next.stage = stageValue(nextStage);
		next.tenure = { "tenure-id": successorId, index: sequence, "started-at": now, "ended-at": null };
		next.attach = { ...(isPlainObject(current.attach) ? current.attach : {}), [stage]: attached };
		next.barrier = barrier;
		next["tenure-seq"] = sequence;
		next.board = successorBoard;
		next["updated-at"] = now;
		if (isText(attach.call_id)) {
			next.receipts = { ...(isPlainObject(current.receipts) ? current.receipts : {}) };
			next.receipts[attach.call_id] = { digest: attach.digest ?? null, tool, stage, at: now };
		}
		const successor = {
			stage: nextStage,
			"tenure-id": successorId,
			"tenure-seq": sequence,
			"attach-ready": false,
			"attach-tool": nextStage === "s5" ? null : attachToolForStage(nextStage),
			"attached-tool": tool,
			"updated-at": now,
			board: successorBoard,
		};
		return {
			mission: next,
			response: { ok: true, stage: nextStage, successor, attached, barrier, archive: archiveRelative },
			commit: true,
		};
	});
}

