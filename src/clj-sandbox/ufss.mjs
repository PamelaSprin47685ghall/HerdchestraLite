/**
 * UFSS: one reader, one writer, one file.
 *
 * Reader: a pre-pass rewrites UFSS fences into standard CLJS strings, then the
 * official CLJS reader owns every `#` dispatch. `readCljs` currently delegates
 * to the EDN reader until an official CLJS reader is wired in; the pre-pass
 * itself is independent of that choice.
 *
 * Writer: values print as plain CLJS/EDN with standard escaped strings, then a
 * post-pass upgrades escaped strings to the smallest raw fence. The two passes
 * share the single fence grammar below; UFSS implements no CLJS semantics.
 */

import { herdError } from "../util/errors.mjs";
import * as cherry from "cherry-cljs/cljs.core.js";
import { parseStandardString } from "./string-literal.mjs";
import { wrapStrings } from "./wrap-strings.mjs";

export const keyword = cherry.keyword;
export const symbol = cherry.symbol;
export const list = cherry.list;
export const vector = cherry.vector;
export const hashMap = cherry.array_map;
export const hashSet = cherry.hash_set;
export const isKeyword = cherry.keyword_QMARK_;
export const isSymbol = cherry.symbol_QMARK_;
export const isList = cherry.list_QMARK_;
export const toArray = cherry.to_array;

/** Full keyword name without the leading colon (namespace included). */
export function keywordName(value) {
	return String(value).slice(1);
}

/** Full symbol name (namespace included). */
export function symbolName(value) {
	return String(value);
}

const TAB = 0x09;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const COMMA = 0x2c;
const SEMICOLON = 0x3b;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_PAREN = 0x28;
const CLOSE_PAREN = 0x29;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const HASH = 0x23;
const COLON = 0x3a;

// ---------------------------------------------------------------------------
// The one fence grammar
// ---------------------------------------------------------------------------

function literalFailure(code, message, index, data = {}) {
	return { ok: false, code, message, index, data };
}

/**
 * Read one UFSS fence at `index`.
 *
 * Depth zero is a bare `"""` block; depth one or more is `#"..."#`. The caller
 * decides whether depth one is available (CLJS reserves `#"` for regex).
 */
export function readUfssLiteral(text, index) {
	if (typeof text !== "string") {
		return literalFailure("INVALID_ARGUMENT", "UFSS literal needs a string", index);
	}
	let hashes = 0;
	while (text[index + hashes] === "#") {
		hashes += 1;
	}
	if (hashes === 0) {
		if (!text.startsWith('"""', index) || text[index + 3] !== "\n") {
			return literalFailure("INVALID_ARGUMENT", "UFSS literal must start with #", index);
		}
		return readMultiLine(text, index, 0, index);
	}
	const quote = index + hashes;
	if (text[quote] !== '"') {
		return literalFailure("INVALID_ARGUMENT", "Unknown # dispatch", index);
	}
	if (text.startsWith('"""', quote) && text[quote + 3] === "\n") {
		return readMultiLine(text, index, hashes, quote);
	}
	return readSingleLine(text, index, hashes, quote);
}

function readSingleLine(text, start, hashes, quote) {
	const fence = "#".repeat(hashes);
	let cursor = quote + 1;
	while (cursor < text.length) {
		const code = text.charCodeAt(cursor);
		if (code === QUOTE && text.startsWith(fence, cursor + 1)) {
			return { ok: true, value: text.slice(quote + 1, cursor), nextIndex: cursor + 1 + hashes };
		}
		if (code === NEWLINE || code === CARRIAGE_RETURN) {
			return literalFailure("UFSS_UNCLOSED", "Raw string fence does not close on this line", start);
		}
		if (code < 32 && code !== TAB) {
			return literalFailure("INVALID_ARGUMENT", "Raw control character in string", cursor);
		}
		cursor += 1;
	}
	return literalFailure("UFSS_UNCLOSED", "Unclosed raw string", start);
}

function readMultiLine(text, start, hashes, quote) {
	const fence = `"""${"#".repeat(hashes)}`;
	const bodyStart = quote + 4;
	let lineStart = bodyStart;

	for (;;) {
		let cursor = lineStart;
		while (text[cursor] === " ") {
			cursor += 1;
		}
		if (text.startsWith(fence, cursor)) {
			const afterFence = cursor + fence.length;
			let tail = afterFence;
			while (text[tail] === " " || text[tail] === "\t") {
				tail += 1;
			}
			if (tail < text.length && text[tail] !== "\n") {
				return literalFailure("INVALID_ARGUMENT", "Closing fence must stand on its own line", tail);
			}

			const indent = cursor - lineStart;
			const bodyEnd = lineStart > bodyStart ? lineStart - 1 : bodyStart;
			const body = text.slice(bodyStart, bodyEnd);
			const value = stripBlockIndent(body, bodyStart, indent);
			if (value.ok !== true) {
				return value;
			}
			return { ok: true, value: value.value, nextIndex: tail };
		}

		const newline = text.indexOf("\n", lineStart);
		if (newline === -1) {
			return literalFailure("UFSS_UNCLOSED", "Unclosed raw block", start);
		}
		lineStart = newline + 1;
	}
}

function stripBlockIndent(body, bodyStart, indent) {
	const lines = body.split("\n");
	let offset = 0;
	const output = [];

	for (const line of lines) {
		if (line.length === 0) {
			output.push("");
			offset += 1;
			continue;
		}

		let spaces = 0;
		while (spaces < line.length && line[spaces] === " ") {
			spaces += 1;
		}
		if (spaces < indent || line.length < indent) {
			return literalFailure(
				"UFSS_INDENT_VIOLATION",
				`Block line has ${spaces} leading spaces; ${indent} required`,
				bodyStart + offset,
				{ expectedIndent: indent, actualIndent: spaces },
			);
		}
		for (let cursor = indent; cursor < line.length; cursor += 1) {
			const code = line.charCodeAt(cursor);
			if (code < 32 && code !== TAB) {
				return literalFailure("INVALID_ARGUMENT", "Raw control character in block", bodyStart + offset + cursor);
			}
		}
		output.push(line.slice(indent));
		offset += line.length + 1;
	}

	return { ok: true, value: output.join("\n") };
}

// ---------------------------------------------------------------------------
// Reader: pre-pass + CLJS/EDN
// ---------------------------------------------------------------------------

/**
 * Rewrite UFSS fences into standard strings.
 *
 * Four lexical states: code, string, comment, character. Only code-state
 * fences with two or more hashes are rewritten. `#"` stays the official regex;
 * `#(`, `#_`, `#?`, `#:`, `#'`, `#{`, and `##Inf` pass through byte for byte.
 */


/**
 * Walk code-state literals and let `render` decide each replacement.
 *
 * Comments and character literals are copied whole. Strings, fences, and bare
 * blocks are identified by the same scanner; pre-pass and post-pass differ only
 * in their render callback.
 */




/** Map a rewritten offset back to the original source. */


function isDelimiter(code) {
	return (
		code === undefined ||
		code === SPACE ||
		code === TAB ||
		code === NEWLINE ||
		code === CARRIAGE_RETURN ||
		code === COMMA ||
		code === SEMICOLON ||
		code === QUOTE ||
		code === OPEN_PAREN ||
		code === CLOSE_PAREN ||
		code === OPEN_BRACKET ||
		code === CLOSE_BRACKET ||
		code === OPEN_BRACE ||
		code === CLOSE_BRACE
	);
}

const INT_TOKEN = /^[+-]?\d+$/;
const BIGINT_TOKEN = /^[+-]?\d+N$/;
const FLOAT_TOKEN = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;





class EdnReader {
	constructor(text) {
		this.text = text;
		this.length = text.length;
		this.index = 0;
		this.keywords = new Map();
	}

	locate(index) {
		let line = 1;
		let column = 1;
		for (let cursor = 0; cursor < index && cursor < this.length; cursor += 1) {
			if (this.text.charCodeAt(cursor) === NEWLINE) {
				line += 1;
				column = 1;
			} else {
				column += 1;
			}
		}
		return { line, column };
	}

	makeError(code, message, index, extra = {}) {
		const position = Math.max(0, Math.min(index, this.length));
		const { line, column } = this.locate(position);
		const error = herdError(code, `${message} at line ${line}, column ${column}`, {
			line,
			column,
			position,
			...extra,
		});
		error.line = line;
		error.column = column;
		error.position = position;
		return error;
	}

	fail(code, message, index, extra) {
		throw this.makeError(code, message, index, extra);
	}

	skipIgnored() {
		for (;;) {
			while (this.index < this.length) {
				const code = this.text.charCodeAt(this.index);
				if (code === SPACE || code === TAB || code === NEWLINE || code === CARRIAGE_RETURN || code === COMMA) {
					this.index += 1;
					continue;
				}
				if (code === SEMICOLON) {
					const newline = this.text.indexOf("\n", this.index);
					this.index = newline === -1 ? this.length : newline;
					continue;
				}
				break;
			}

			if (!this.text.startsWith("#_", this.index)) {
				return;
			}
			const marker = this.index;
			this.index += 2;
			this.skipIgnored();
			if (this.index >= this.length) {
				this.fail("INVALID_ARGUMENT", "Discard marker needs a form", marker);
			}
			this.readValue();
		}
	}

	readDocument() {
		this.skipIgnored();
		if (this.index >= this.length) {
			this.fail("INVALID_ARGUMENT", "Expected an EDN form", this.index);
		}
		const value = this.readValue();
		this.skipIgnored();
		if (this.index < this.length) {
			this.fail("INVALID_ARGUMENT", "Trailing data after EDN form", this.index);
		}
		return value;
	}

	readValue() {
		this.skipIgnored();
		if (this.index >= this.length) {
			this.fail("INVALID_ARGUMENT", "Expected an EDN form", this.index);
		}

		const code = this.text.charCodeAt(this.index);
		switch (code) {
			case QUOTE:
				if (this.text.startsWith('"""', this.index) && this.text[this.index + 3] === "\n") {
					return this.readLiteral();
				}
				return this.readStandardString();
			case HASH:
				return this.readHashValue();
			case COLON:
				return this.readKeyword();
			case OPEN_PAREN:
				return this.readList();
			case OPEN_BRACKET:
				return this.readVector();
			case OPEN_BRACE:
				return this.readMap();
			case CLOSE_PAREN:
			case CLOSE_BRACKET:
			case CLOSE_BRACE:
				this.fail("INVALID_ARGUMENT", "Unexpected closing delimiter", this.index);
				break;
			default:
				return this.readTokenValue();
		}
	}

	readLiteral() {
		const literal = readUfssLiteral(this.text, this.index);
		if (literal.ok === true) {
			this.index = literal.nextIndex;
			return literal.value;
		}
		this.fail(literal.code, literal.message, literal.index, literal.data);
	}

	readStandardString() {
		const parsed = parseStandardString(this.text, this.index, (code, message, index) =>
			this.fail(code, message, index),
		);
		this.index = parsed.end;
		return parsed.body;
	}

	readHashValue() {
		if (this.text.startsWith("#{", this.index)) {
			return this.readSet();
		}
		return this.readLiteral();
	}

	readList() {
		const start = this.index;
		this.index += 1;
		const values = [];
		for (;;) {
			this.skipIgnored();
			if (this.index >= this.length) {
				this.fail("INVALID_ARGUMENT", "Unclosed list", start);
			}
			if (this.text[this.index] === ")") {
				this.index += 1;
				return cherry.list(...values);
			}
			values.push(this.readValue());
		}
	}

	readVector() {
		const start = this.index;
		this.index += 1;
		const values = [];
		for (;;) {
			this.skipIgnored();
			if (this.index >= this.length) {
				this.fail("INVALID_ARGUMENT", "Unclosed vector", start);
			}
			if (this.text[this.index] === "]") {
				this.index += 1;
				return cherry.vector(...values);
			}
			values.push(this.readValue());
		}
	}

	readMap() {
		const start = this.index;
		this.index += 1;
		const values = new Map();
		const keys = new Set();
		for (;;) {
			this.skipIgnored();
			if (this.index >= this.length) {
				this.fail("INVALID_ARGUMENT", "Unclosed map", start);
			}
			if (this.text[this.index] === "}") {
				this.index += 1;
				return values;
			}

			const keyIndex = this.index;
			const key = this.readValue();
			this.skipIgnored();
			if (this.text[this.index] === "}") {
				this.fail("INVALID_ARGUMENT", "Map has a key without a value", keyIndex);
			}
			const value = this.readValue();

			if (keys.some((existing) => cherry._EQ_(existing, key))) {
				this.fail("INVALID_ARGUMENT", "Map has a duplicate key", keyIndex);
			}
			keys.push(key);
			entries.push(key, value);
		}
		return cherry.array_map(...entries);
	}

	readSet() {
		const start = this.index;
		this.index += 2;
		const values = [];
		for (;;) {
			this.skipIgnored();
			if (this.index >= this.length) {
				this.fail("INVALID_ARGUMENT", "Unclosed set", start);
			}
			if (this.text[this.index] === "}") {
				this.index += 1;
				return values;
			}

			const valueIndex = this.index;
			const value = this.readValue();
			if (values.some((existing) => cherry._EQ_(existing, value))) {
				this.fail("INVALID_ARGUMENT", "Set has a duplicate value", valueIndex);
			}
			values.push(value);
		}
		return cherry.hash_set(...values);
	}

	readKeyword() {
		const start = this.index;
		this.index += 1;
		while (this.index < this.length && !isDelimiter(this.text.charCodeAt(this.index))) {
			this.index += 1;
		}

		const name = this.text.slice(start + 1, this.index);
		if (name.length === 0 || name.startsWith(":") || name.endsWith("/")) {
			this.fail("INVALID_ARGUMENT", "Invalid keyword", start);
		}

		return cherry.keyword(name);
	}

	readTokenValue() {
		const start = this.index;
		while (this.index < this.length && !isDelimiter(this.text.charCodeAt(this.index))) {
			this.index += 1;
		}
		const token = this.text.slice(start, this.index);
		if (token.length === 0) {
			this.fail("INVALID_ARGUMENT", "Expected an EDN token", start);
		}

		if (token === "nil") {
			return null;
		}
		if (token === "true") {
			return true;
		}
		if (token === "false") {
			return false;
		}
		if (BIGINT_TOKEN.test(token)) {
			return BigInt(token.slice(0, -1));
		}
		if (INT_TOKEN.test(token)) {
			const value = Number(token);
			if (!Number.isSafeInteger(value)) {
				return BigInt(token);
			}
			return value;
		}
		if (FLOAT_TOKEN.test(token) && (token.includes(".") || /[eE]/.test(token))) {
			const value = Number(token);
			if (!Number.isFinite(value)) {
				this.fail("INVALID_ARGUMENT", "Floating point value is not finite", start);
			}
			return value;
		}
		if (/^[+-]?(?:\d|\.\d)/.test(token)) {
			this.fail("INVALID_ARGUMENT", "Invalid number", start);
		}
		return cherry.symbol(token);
	}
}

/** Read EDN + UFSS data. Official Clojure reader macros are rejected. */
export function readUfss(text) {
	if (typeof text !== "string") {
		throw herdError("INVALID_ARGUMENT", "readUfss expects a string", { type: typeof text });
	}
	return new EdnReader(text).readDocument();
}

/**
 * Read a ClojureScript source form.
 *
 * The pre-pass upgrades UFSS fences to standard strings; the CLJS reader owns
 * every official `#` dispatch. Until that reader is wired in, the EDN reader
 * consumes the rewritten form.
 */
export function readCljs(text) {
	return new EdnReader(ufssToCljs(text).source).readDocument();
}

// ---------------------------------------------------------------------------
// Writer: CLJS pretty print + post-pass
// ---------------------------------------------------------------------------




















/** Print every string as a standard escaped CLJS/EDN string. */




/**
 * Post-pass: upgrade standard strings to raw fences where a fence is shorter
 * and carries the body without escapes.
 */




/** Print a value as deterministic EDN + UFSS. */
export function printUfss(value, options = {}) {
	const indent = options.indent ?? 0;
	if (!Number.isInteger(indent) || indent < 0) {
		throw herdError("INVALID_ARGUMENT", "printUfss indent must be a non-negative integer", { indent });
	}
	if (typeof value === "bigint") {
		return `${value}N`;
	}
	return wrapStrings(cherry.pr_str(value)).source;
}

/** Print a tool receipt: deterministic EDN + UFSS followed by one newline. */
export function renderReceipt(value) {
	return `${printUfss(value)}\n`;
}

// ---------------------------------------------------------------------------
// Model-facing note
// ---------------------------------------------------------------------------

export const UFSS_PROMPT_NOTE = [
	"# Universal Fence-Scaled String (UFSS): Arbitrary-Depth Raw Fences",
	"UFSS is the raw string notation used in every EDN receipt. It avoids escaping quotes, backslashes, and newlines by choosing a fence deeper than any closing sequence in the body. Use `##` by default for ordinary text; use `###` when developing HerdchestraLite itself, because its source, docs, and prompts contain many quotes, backslashes, and fence-like sequences. Fence depth is arbitrary: zero hashes (bare multi-line), one, or more all work; the printer picks the smallest, but you're free. Raise the fence instead of escaping.",
	"",
	"Every receipt you get is EDN, and every string in it is printed as UFSS (Universal Fence-Scaled String). You are not restricted to one escaping style; you are expected to pick the strongest one.",
	"",
	"Three string forms, all accepted by the same reader:",
	"1. Standard escaped string — only for short text with no quote, no backslash, no newline. This is the fallback, not the default.",
	"2. Single-line raw fence: `##\"...\"##` for ordinary text, or `###\"...\"###` when developing HerdchestraLite. The body is taken verbatim: quotes, backslashes, and hash characters inside stay literal.",
	"3. Multi-line raw block: `##\"\"\"...\"\"\"##` for ordinary text, or `###\"\"\"...\"\"\"###` when developing HerdchestraLite. The closing indent is stripped from every non-empty body line; a trailing newline is preserved exactly.",
	"",
	"Scaling is the point. With two hashes the forms are `##\"...\"##` and `##\"\"\"...\"\"\"##`; with three hashes, `###\"...\"###` and `###\"\"\"...\"\"\"###`. If the body already contains a quote, a backslash, or a line beginning with three quotes, raise the fence by one hash; continue without a ceiling. The printer chooses the smallest n whose closing sequence does not appear in the body, so a raw fence always exists. The reader and printer are a bijection: round-tripping any string returns it byte for byte.",
	"",
	"Examples (all obey the default depth):",
	"- Ordinary text: `##\"He said \"hello\".\"##`",
	"- Herd source: `###\"const marker = '\"\"\"';\"###`",
	"- Ordinary block:",
	"##\"\"\"",
	"ordinary body with \"quotes\"",
	"\"\"\"##",
	"- Herd block:",
	"###\"\"\"",
	"const marker = '\"\"\"';",
	"\"\"\"###",
	"",
	"",
	"Concrete repair example (Herd source, so `###`):",
	"LLM classic: models often say `strawberry` has two r's. The wrong text is `2 r's`; the repair must hit that exact occurrence and leave the rest untouched.",
	"Before: `###\"export const STRAWBERRY_FACT = \"strawberry has 2 r's\";\"###`",
	"Program:",
	"(let [path \"src/llm-meme.mjs\"",
	"      src  (cat {:path path})",
	"      [b e] (where {:content src",
	"                    :needle ###\"export const STRAWBERRY_FACT = \"strawberry has 2 r's\";\"###})]",
	"  (write {:path path",
	"          :content (str (subs src 0 b)",
	"                        ###\"export const STRAWBERRY_FACT = \"strawberry has 3 r's\";\"###",
	"                        (subs src e))}))",
	"",
	"Why this beats `python/replace` or `apply_patch`:",
	"- `cat` is byte-exact; `read` may reformat and is not a patch basis.",
	"- `where` returns one exact UTF-16 span; 0 or multiple matches park with candidates instead of guessing.",
	"- UFSS `###` keeps inner quotes literal; the needle and replacement need no escaping.",
	"- `write` replaces only `[b e]`; surrounding text is never retyped.",
	"- Python `str.replace` defaults to all occurrences and silently no-ops when the target drifts; regex adds escaping noise.",
	"- `apply_patch` depends on diff context and line drift; the model must reproduce surrounding lines. This path uses the real file text and exact spans.",
	"",
	"WARNING — the mistakes that actually break a fence:",
	"- A raw fence is not a regex. `##\"...\"##` is a raw string; write regexes as `(re-pattern ##\"...\"##)`.",
	"- Never hand-build backslash escapes for quotes, backslashes, or newlines in code, paths, diffs, or multi-line prose. If the body needs those escapes, raise the fence depth instead.",
	"- The closing fence must stand alone on its own line, at the same indent as the opening line. Any trailing parenthesis or text makes it a parse error, not a closing fence.",
	"- Every non-empty body line must carry at least the closing fence indent. A short line is `:UFSS_INDENT_VIOLATION`, never silently swallowed.",
	"- If the body contains three consecutive quotes, a closing-fence sequence, or a line of hashes, raise the fence by one hash until the closing sequence does not occur in the body.",
	"- Control characters other than newline and tab cannot live in a raw fence; use a standard escaped string for those.",
	"- JSON, standard EDN, and UFSS are all accepted on input and normalized. On output the framework never sends escaped JSON noise for text a fence can carry; do not pre-escape it yourself.",
].join("\n");
