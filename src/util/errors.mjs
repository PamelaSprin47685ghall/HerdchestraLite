/**
 * Herdchestra error vocabulary and deterministic EDN rendering.
 *
 * `ERROR_CODES` is the only accepted error vocabulary. `herdError` normalizes
 * names to keyword form. `renderError` renders any thrown value as EDN with
 * UFSS strings and never throws. `printEdn` renders supported values without a
 * trailing newline, so atomic writers can append exactly one.
 *
 * This module imports nothing and touches no filesystem or process state.
 */

const ERROR_CODE_NAMES = [
	"SLUG_TAKEN",
	"STAGE_MISMATCH",
	"CALL_REPLAY_MISMATCH",
	"CONTRACT_HASH_MISMATCH",
	"APPROVAL_REQUIRED",
	"INSUFFICIENT_WORKTREES",
	"RESOURCES_NOT_QUIESCENT",
	"FF_NOT_READY",
	"NO_RESULTS",
	"S1_SUMMARY_HASH_MISMATCH",
	"CONTRACT_LINE_STALE",
	"S3_MODULES_HASH_MISMATCH",
	"CASE_SCHEMA_INVALID",
	"CASE_DUPLICATE_ID",
	"CASE_THRESHOLD_INVALID",
	"CASE_REQUIRED_PATH_MISSING",
	"CASE_HASH_MISMATCH",
	"MAPPED_CASE_UNKNOWN",
	"MAPPED_CASE_MISSING",
	"MAPPING_REALIGN_REQUIRED",
	"BOARD_CONFLICT",
	"TASK_NOT_READY",
	"CLAIM_CONFLICT",
	"PARENT_NOT_READY",
	"TOKEN_REQUIRED",
	"CONFIRMATION_REQUIRED",
	"TENURE_RETIRED",
	"ACTOR_DEAD",
	"CLAIM_CHANGED",
	"NO_PROGRESSABLE_WORK",
	"TASK_HAS_CHILDREN",
	"NAME_TAKEN",
	"FILE_CONFLICT",
	"STRUCTURE_CONFLICT",
	"PREPARE_REJECTED",
	"LIMIT_EXCEEDED",
	"changed-during-read",
	"PATH_ESCAPE",
	"NOT_UTF8",
	"OUTPUT_TRUNCATED",
	"CAPABILITY_DENIED",
	"PROGRAM_UNKNOWN",
	"STALE_CONTROL",
	"INVALID_ARGUMENT",
	"BOARD_NOT_QUIESCENT",
	"ATTACH_ALREADY_PENDING",
	"ATTACH_STAGE_MISMATCH",
	"REVIEW_LEDGER_NOT_EMPTY",
	"ATTACH_NOT_READY",
	"UFSS_INDENT_VIOLATION",
	"UFSS_UNCLOSED",
	"SCOPE_UNINITIALIZED",
	"SCOPE_BUDGET_SPENT",
	"INTENT_REQUIRED",
	"SCOPE_INVALID",
	"ASK_FORBIDDEN_OUTSIDE_S1",
	"AUDIT_MISSING",
	"AUDIT_UNKNOWN_CASE",
	"AUDIT_DUPLICATE_CASE",
	"AUDIT_INVALID_SCORE",
	"AUDIT_WORKSPACE_MUTATED",
	"AUDIT_TIMEOUT",
	"AUDIT_ABORTED",
	"STALLED",
	"UPSTREAM_ABORTED",
	"AGENT_SPAWN_FAILED",
	"HOST_API_MISMATCH",
	"SETTINGS_UNAVAILABLE",
	"MODEL_FALLBACK",
	"LOCK_OWNER_DEAD",
];

/**
 * Registered error codes. Keys are bare names; values are EDN keywords.
 */
export const ERROR_CODES = Object.freeze(Object.fromEntries(ERROR_CODE_NAMES.map((name) => [name, `:${name}`])));

// biome-ignore lint/suspicious/noControlCharactersInRegex: UFSS falls back to escapes exactly for these characters.
const CONTROL_CHARACTER = /[\r\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
const KEYWORD_PART = /^[\p{L}_*+!?$%&=<>.-][\p{L}\p{N}_*+!?$%&=<>.-]*$/u;
const MAX_CAUSE_DEPTH = 8;

class HerdError extends Error {
	constructor(code, message, data, cause) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "HerdError";
		this.code = code;
		this.data = data;
	}
}

/**
 * Readable text for any thrown value.
 *
 * Inputs: whatever a `catch` block caught.
 * Output: `Error#message` for errors, `String(value)` otherwise.
 * Never throws, so callers can format an error while handling an error.
 */
export function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * `code` of a filesystem or system error.
 *
 * Inputs: whatever a `catch` block caught.
 * Output: the string `code` when the value carries one, `undefined` otherwise.
 * Only the raw code is returned; call sites format suffixes such as ` (EACCES)`
 * themselves so that user-visible text stays under their control.
 */
export function errorCode(error) {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
		return error.code;
	}
	return undefined;
}

/**
 * Build a registered herd error.
 *
 * Inputs: a registered code with or without a leading colon, a message, plain
 * object `data` (shallow copied), and an optional cause.
 *
 * Output: an `Error` with `name === "HerdError"`, colon-prefixed `code`, plain
 * object `data`, and `cause` when supplied.
 *
 * Unknown codes and non-object `data` are argument bugs, so they throw
 * `TypeError`. Register every new code in `ERROR_CODES` first.
 */
export function herdError(code, message = "", data = {}, cause) {
	return new HerdError(
		normalizeCode(code),
		message === undefined || message === null ? "" : String(message),
		copyData(data),
		cause,
	);
}

/**
 * Report whether a value was built by `herdError`.
 */
export function isHerdError(value) {
	return value instanceof Error && value.name === "HerdError" && typeof value.code === "string";
}

/**
 * Render any thrown value as EDN with UFSS strings and one trailing newline.
 *
 * Herd errors show `:code`, `:message`, `:data`, and `:cause` when present. Raw
 * exceptions show `:code nil`, `:message`, and `:data {:system-code ...}`.
 *
 * This function never throws. If a value cannot be rendered, it returns a
 * constant `:INVALID_ARGUMENT` document with the same trailing newline.
 */
export function renderError(error) {
	try {
		const seen = new Set();
		const trackable = isObjectLike(error);
		if (trackable) seen.add(error);
		return `${renderErrorBody(error, "", seen, 0)}\n`;
	} catch {
		return '{:code :INVALID_ARGUMENT\n :message "renderError failed"\n :data {}}\n';
	}
}

/**
 * Print a supported JavaScript value as deterministic EDN.
 *
 * Inputs: nil, boolean, finite number, bigint, string, Array, Map, Set, or a
 * plain object; optional `indent` prefix and `keywordStrings: false` to keep
 * colon-prefixed strings quoted.
 *
 * Output: EDN text with no trailing newline. Object keys that are legal keyword
 * names print as `:key`; other keys print as EDN strings. Object entries with
 * `undefined` values are skipped. A string value that is a legal colon-prefixed
 * keyword prints as a keyword. Circular references and unsupported values
 * throw `herdError("INVALID_ARGUMENT", ...)`.
 */
export function printEdn(value, options = {}) {
	const settings = options !== null && typeof options === "object" ? options : {};
	const indent = normalizeIndent(settings.indent);
	const keywordStrings = settings.keywordStrings !== false;
	return renderValue(value, indent, keywordStrings, new Set());
}

function normalizeCode(code) {
	if (typeof code !== "string") {
		throw new TypeError("herdError: code must be a string");
	}
	const name = code.startsWith(":") ? code.slice(1) : code;
	if (!Object.hasOwn(ERROR_CODES, name)) {
		throw new TypeError(`herdError: unknown error code ${JSON.stringify(code)}`);
	}
	return ERROR_CODES[name];
}

function copyData(data) {
	if (data === undefined || data === null) return {};
	if (!isPlainObject(data)) {
		throw new TypeError("herdError: data must be a plain object");
	}
	return { ...data };
}

function isPlainObject(value) {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isObjectLike(value) {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isKeywordName(name) {
	if (typeof name !== "string" || name.length === 0) return false;
	const parts = name.split("/");
	if (parts.length === 1) return KEYWORD_PART.test(parts[0]);
	return (
		parts.length === 2 &&
		parts[0].length > 0 &&
		parts[1].length > 0 &&
		KEYWORD_PART.test(parts[0]) &&
		KEYWORD_PART.test(parts[1])
	);
}

function isKeywordLiteral(value) {
	return value.startsWith(":") && isKeywordName(value.slice(1));
}

function invalid(message, data = {}) {
	return herdError("INVALID_ARGUMENT", message, data);
}

function normalizeIndent(indent) {
	if (typeof indent === "string") return indent;
	if (typeof indent === "number" && Number.isFinite(indent) && indent > 0) {
		return " ".repeat(Math.floor(indent));
	}
	return "";
}

function renderValue(value, indent, keywordStrings, active) {
	if (value === null) return "nil";
	switch (typeof value) {
		case "boolean":
			return value ? "true" : "false";
		case "number":
			if (!Number.isFinite(value)) {
				throw invalid("printEdn: numbers must be finite", { value: String(value) });
			}
			return String(value);
		case "bigint":
			return `${value}N`;
		case "string":
			return keywordStrings && isKeywordLiteral(value) ? value : printString(value, indent);
		case "object":
			break;
		default:
			throw invalid(`printEdn: unsupported value type ${typeof value}`);
	}

	if (Array.isArray(value)) return renderVector(value, indent, keywordStrings, active);
	if (value instanceof Map) return renderMap(value, [...value.entries()], indent, keywordStrings, active);
	if (value instanceof Set) return renderSet(value, indent, keywordStrings, active);
	if (isPlainObject(value)) return renderObject(value, indent, keywordStrings, active);
	throw invalid("printEdn: unsupported object");
}

function renderVector(items, indent, keywordStrings, active) {
	if (items.length === 0) return "[]";
	enter(active, items);
	try {
		const itemIndent = `${indent} `;
		const parts = items.map((item) => renderValue(item, itemIndent, keywordStrings, active));
		return renderSequence("[", "]", parts, itemIndent);
	} finally {
		active.delete(items);
	}
}

function renderSet(items, indent, keywordStrings, active) {
	if (items.size === 0) return "#{}";
	enter(active, items);
	try {
		const itemIndent = `${indent}  `;
		const parts = [...items].map((item) => renderValue(item, itemIndent, keywordStrings, active));
		return renderSequence("#{", "}", parts, itemIndent);
	} finally {
		active.delete(items);
	}
}

function renderSequence(open, close, parts, itemIndent) {
	if (parts.every((part) => !part.includes("\n"))) {
		return `${open}${parts.join(" ")}${close}`;
	}
	let text = `${open}${parts[0]}`;
	for (let index = 1; index < parts.length; index += 1) {
		text += `\n${itemIndent}${parts[index]}`;
	}
	return `${text}${close}`;
}

function renderObject(value, indent, keywordStrings, active) {
	const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
	if (entries.length === 0) return "{}";
	enter(active, value);
	try {
		return renderEntries(entries, indent, keywordStrings, active, true);
	} finally {
		active.delete(value);
	}
}

function renderMap(value, entries, indent, keywordStrings, active) {
	if (entries.length === 0) return "{}";
	enter(active, value);
	try {
		return renderEntries(entries, indent, keywordStrings, active, false);
	} finally {
		active.delete(value);
	}
}

function renderEntries(entries, indent, keywordStrings, active, keywordizeKeys) {
	const entryIndent = `${indent} `;
	const lines = entries.map(([key, entryValue]) => {
		const keyText = keywordizeKeys
			? renderObjectKey(key, entryIndent)
			: renderValue(key, entryIndent, keywordStrings, active);
		const valueIndent = entryIndent + " ".repeat(keyText.length + 1);
		const valueText = renderValue(entryValue, valueIndent, keywordStrings, active);
		return `${keyText} ${valueText}`;
	});
	let text = `{${lines[0]}`;
	for (let index = 1; index < lines.length; index += 1) {
		text += `\n${entryIndent}${lines[index]}`;
	}
	return `${text}}`;
}

function renderObjectKey(key, indent) {
	const name = key.startsWith(":") ? key.slice(1) : key;
	return isKeywordName(name) ? `:${name}` : printString(key, indent);
}

function enter(active, value) {
	if (active.has(value)) {
		throw invalid("printEdn: circular reference", { kind: "cycle" });
	}
	active.add(value);
}

function printString(value, indent) {
	if (CONTROL_CHARACTER.test(value)) return escapeString(value);
	if (!value.includes("\n")) {
		if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
		return printRawLine(value);
	}
	return printBlock(value, indent);
}

function escapeString(value) {
	let text = '"';
	for (const character of value) {
		switch (character) {
			case '"':
				text += '\\"';
				break;
			case "\\":
				text += "\\\\";
				break;
			case "\n":
				text += "\\n";
				break;
			case "\r":
				text += "\\r";
				break;
			case "\t":
				text += "\\t";
				break;
			default: {
				const code = character.codePointAt(0);
				text += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : character;
			}
		}
	}
	return `${text}"`;
}

function printRawLine(value) {
	let hashes = 1;
	while (value.includes(`"${"#".repeat(hashes)}`)) hashes += 1;
	const fence = "#".repeat(hashes);
	return `${fence}"${value}"${fence}`;
}

function printBlock(value, indent) {
	const lines = value.split("\n");
	const bare = !value.includes('"""') && !value.includes("\\") && !lines.some((line) => line.startsWith('"""'));
	let hashes = 0;
	if (!bare) {
		hashes = 1;
		while (value.includes(`"""${"#".repeat(hashes)}`)) hashes += 1;
	}
	const fence = `${"#".repeat(hashes)}"""`;
	const close = `"""${"#".repeat(hashes)}`;
	const body = lines.map((line) => (line === "" ? "" : `${indent}${line}`)).join("\n");
	return `${fence}\n${body}\n${indent}${close}`;
}

function renderErrorBody(error, indent, seen, depth) {
	const herd = isHerdError(error);
	const codeIndent = `${indent}       `;
	const messageIndent = `${indent}          `;
	const dataIndent = `${indent}       `;
	const causeIndent = `${indent}        `;
	const code = herd ? renderErrorCode(error.code, codeIndent) : null;

	let body = `{:code ${code === null ? "nil" : code}`;
	body += `\n${indent} :message ${printString(safeMessage(error), messageIndent)}`;
	body += `\n${indent} :data ${renderErrorData(error, herd, dataIndent)}`;

	if (herd) {
		let cause;
		let hasCause = false;
		try {
			hasCause = "cause" in error;
			if (hasCause) cause = error.cause;
		} catch {
			hasCause = false;
		}
		if (hasCause && cause !== undefined) {
			const trackable = isObjectLike(cause);
			if ((trackable && seen.has(cause)) || depth >= MAX_CAUSE_DEPTH) {
				body += `\n${indent} :cause nil`;
			} else {
				if (trackable) seen.add(cause);
				try {
					body += `\n${indent} :cause ${renderErrorBody(cause, causeIndent, seen, depth + 1)}`;
				} finally {
					if (trackable) seen.delete(cause);
				}
			}
		}
	}
	return `${body}}`;
}

function renderErrorCode(code, indent) {
	if (typeof code !== "string") return null;
	const name = code.startsWith(":") ? code.slice(1) : code;
	if (Object.hasOwn(ERROR_CODES, name)) return ERROR_CODES[name];
	return printString(code, indent);
}

function renderErrorData(error, herd, indent) {
	let data;
	if (herd) {
		try {
			data = isPlainObject(error.data) ? error.data : {};
		} catch {
			data = {};
		}
	} else {
		let systemCode = null;
		try {
			const code = errorCode(error);
			systemCode = typeof code === "string" ? code : null;
		} catch {
			systemCode = null;
		}
		data = { "system-code": systemCode };
	}
	try {
		return printEdn(data, { indent });
	} catch (failure) {
		const fallback = { "render-error": safeMessage(failure) };
		try {
			const code = errorCode(failure);
			if (typeof code === "string" && code.length > 0) fallback["error-code"] = code;
		} catch {
			// The fallback already carries the message.
		}
		try {
			return printEdn(fallback, { indent });
		} catch {
			return "{}";
		}
	}
}

function safeMessage(value) {
	try {
		const text = messageOf(value);
		return typeof text === "string" ? text : String(text);
	} catch {
		return "unprintable error value";
	}
}
