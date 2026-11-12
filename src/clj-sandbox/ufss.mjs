/**
 * EDN reader and deterministic EDN + UFSS printer.
 *
 * The reader accepts the EDN subset used by the sandbox: nil, booleans,
 * numbers, strings, keywords, symbols, lists, vectors, maps, and sets.
 * Strings also accept the three UFSS forms: standard escaped strings,
 * single-line raw fences, and indented multi-line blocks.
 *
 * The printer follows AGENTS.md §5.5.2. It never emits JSON escape noise
 * for text that a raw fence can carry.
 */

import { herdError } from "../util/errors.mjs";

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

const INT_TOKEN = /^[+-]?\d+$/;
const BIGINT_TOKEN = /^[+-]?\d+N$/;
const FLOAT_TOKEN = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;

/**
 * An EDN keyword. Keywords are values, not strings; the printer keeps the
 * leading colon and the reader interns repeated keywords inside one document.
 */
export class EdnKeyword {
	constructor(name) {
		this.name = name;
		Object.freeze(this);
	}

	toString() {
		return `:${this.name}`;
	}
}

/** An EDN symbol. */
export class EdnSymbol {
	constructor(name) {
		this.name = name;
		Object.freeze(this);
	}

	toString() {
		return this.name;
	}
}

/** An EDN list. Vectors are plain arrays; lists keep their own identity. */
export class EdnList extends Array {}

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

function hasInvisibleControl(text) {
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code < 32 && code !== TAB && code !== NEWLINE) {
			return true;
		}
	}
	return false;
}

function hasTripleQuote(text) {
	return text.includes('"""');
}

function multiLineCanUseBareFence(text) {
	if (hasTripleQuote(text) || text.includes("\\")) {
		return false;
	}
	return !text.split("\n").some((line) => line.startsWith('"""'));
}

function maxHashRunAfterQuotes(text, quoteCount) {
	let maximum = 0;
	let index = 0;

	while (index < text.length) {
		if (text[index] !== '"') {
			index += 1;
			continue;
		}

		const start = index;
		while (index < text.length && text[index] === '"') {
			index += 1;
		}
		if (index - start < quoteCount) {
			continue;
		}

		let hashes = 0;
		while (text[index + hashes] === "#") {
			hashes += 1;
		}
		if (hashes > maximum) {
			maximum = hashes;
		}
	}

	return maximum;
}

function smallestSingleFence(text) {
	return maxHashRunAfterQuotes(text, 1) + 1;
}

function smallestMultiFence(text) {
	return maxHashRunAfterQuotes(text, 3) + 1;
}

function escapeStandardString(text) {
	let output = '"';
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		switch (code) {
			case QUOTE:
				output += '\\"';
				break;
			case BACKSLASH:
				output += "\\\\";
				break;
			case 0x08:
				output += "\\b";
				break;
			case TAB:
				output += "\\t";
				break;
			case NEWLINE:
				output += "\\n";
				break;
			case 0x0c:
				output += "\\f";
				break;
			case CARRIAGE_RETURN:
				output += "\\r";
				break;
			default:
				if (code < 32) {
					output += `\\u${code.toString(16).padStart(4, "0")}`;
				} else {
					output += text[index];
				}
		}
	}
	return `${output}"`;
}

function formatString(text, indent) {
	if (hasInvisibleControl(text)) {
		return escapeStandardString(text);
	}

	if (!text.includes("\n")) {
		if (!text.includes('"') && !text.includes("\\")) {
			return `"${text}"`;
		}
		const fence = "#".repeat(smallestSingleFence(text));
		return `${fence}"${text}"${fence}`;
	}

	const fence = multiLineCanUseBareFence(text) ? "" : "#".repeat(smallestMultiFence(text));
	const prefix = " ".repeat(indent);
	const body = text
		.split("\n")
		.map((line) => (line === "" ? "" : prefix + line))
		.join("\n");
	return `${fence}"""\n${body}\n${prefix}"""${fence}`;
}

function formatCollection(open, close, values, indent) {
	if (values.length === 0) {
		return `${open}${close}`;
	}

	const childIndent = indent + 1;
	const prefix = " ".repeat(childIndent);
	const parts = values.map((value) => formatValue(value, childIndent));
	if (parts.every((part) => !part.includes("\n"))) {
		return `${open}${parts.join(" ")}${close}`;
	}
	return `${open}\n${parts.map((part) => prefix + part).join("\n")}\n${" ".repeat(indent)}${close}`;
}

function formatMap(value, indent) {
	if (value.size === 0) {
		return "{}";
	}

	const entryIndent = indent + 1;
	const prefix = " ".repeat(entryIndent);
	const entries = [];
	for (const [key, entryValue] of value) {
		const keyText = formatValue(key, entryIndent);
		const valueText = formatValue(entryValue, entryIndent);
		const separator = keyText.includes("\n") ? `\n${prefix}` : " ";
		entries.push(`${prefix}${keyText}${separator}${valueText}`);
	}
	return `{\n${entries.join("\n")}\n${" ".repeat(indent)}}`;
}

function formatValue(value, indent) {
	if (value === null) {
		return "nil";
	}
	if (value === true || value === false) {
		return String(value);
	}
	if (typeof value === "string") {
		return formatString(value, indent);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw invalidValue("Numbers must be finite EDN numbers", value);
		}
		if (Object.is(value, -0)) {
			return "-0";
		}
		if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
			return value.toExponential();
		}
		return String(value);
	}
	if (typeof value === "bigint") {
		return `${value}N`;
	}
	if (value instanceof EdnKeyword || value instanceof EdnSymbol) {
		return value.toString();
	}
	if (value instanceof EdnList) {
		return formatCollection("(", ")", value, indent);
	}
	if (Array.isArray(value)) {
		return formatCollection("[", "]", value, indent);
	}
	if (value instanceof Set) {
		return formatCollection("#{", "}", [...value], indent);
	}
	if (value instanceof Map) {
		return formatMap(value, indent);
	}
	throw invalidValue("Value cannot be printed as EDN", value);
}

function invalidValue(message, value) {
	const type = value === null ? "null" : typeof value;
	return herdError("INVALID_ARGUMENT", `${message}: ${type}`, { type });
}

class Reader {
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

	makeError(code, message, index) {
		const position = Math.max(0, Math.min(index, this.length));
		const { line, column } = this.locate(position);
		const error = herdError(code, `${message} at line ${line}, column ${column}`, {
			line,
			column,
			position,
		});
		error.line = line;
		error.column = column;
		error.position = position;
		return error;
	}

	fail(code, message, index) {
		throw this.makeError(code, message, index);
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
					return this.readMultiLineRaw(0, this.index, this.index);
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

	readStandardString() {
		const start = this.index;
		this.index += 1;
		let output = "";

		while (this.index < this.length) {
			const code = this.text.charCodeAt(this.index);
			if (code === QUOTE) {
				this.index += 1;
				return output;
			}
			if (code === BACKSLASH) {
				output += this.readEscape();
				continue;
			}
			if (code < 32 && code !== TAB && code !== NEWLINE) {
				this.fail("INVALID_ARGUMENT", "Raw control character in string", this.index);
			}
			output += this.text[this.index];
			this.index += 1;
		}

		this.fail("UFSS_UNCLOSED", "Unclosed string", start);
	}

	readEscape() {
		const start = this.index;
		this.index += 1;
		if (this.index >= this.length) {
			this.fail("UFSS_UNCLOSED", "Unclosed string escape", start);
		}
		const code = this.text[this.index];
		this.index += 1;
		switch (code) {
			case '"':
				return '"';
			case "\\":
				return "\\";
			case "/":
				return "/";
			case "b":
				return "\b";
			case "f":
				return "\f";
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			case "u": {
				const hex = this.text.slice(this.index, this.index + 4);
				if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
					this.fail("INVALID_ARGUMENT", "Unicode escape needs four hex digits", start);
				}
				this.index += 4;
				return String.fromCharCode(Number.parseInt(hex, 16));
			}
			default:
				this.fail("INVALID_ARGUMENT", `Unknown escape \\${code}`, start);
		}
	}

	readHashValue() {
		const start = this.index;
		if (this.text.startsWith("#{", this.index)) {
			return this.readSet();
		}

		let hashes = 0;
		while (this.text[this.index + hashes] === "#") {
			hashes += 1;
		}
		const quote = this.index + hashes;
		if (this.text[quote] !== '"') {
			this.fail("INVALID_ARGUMENT", "Unknown # dispatch", start);
		}

		if (this.text.startsWith('"""', quote) && this.text[quote + 3] === "\n") {
			return this.readMultiLineRaw(hashes, start, quote);
		}
		return this.readSingleLineRaw(hashes, start, quote);
	}

	readSingleLineRaw(hashes, start, quote) {
		const fence = "#".repeat(hashes);
		this.index = quote + 1;

		while (this.index < this.length) {
			const code = this.text.charCodeAt(this.index);
			if (code === QUOTE && this.text.startsWith(fence, this.index + 1)) {
				const value = this.text.slice(quote + 1, this.index);
				this.index += 1 + hashes;
				return value;
			}
			if (code === NEWLINE || code === CARRIAGE_RETURN) {
				this.fail("UFSS_UNCLOSED", "Raw string fence does not close on this line", start);
			}
			if (code < 32 && code !== TAB) {
				this.fail("INVALID_ARGUMENT", "Raw control character in string", this.index);
			}
			this.index += 1;
		}

		this.fail("UFSS_UNCLOSED", "Unclosed raw string", start);
	}

	readMultiLineRaw(hashes, start, quote) {
		const fence = `${'"""'}${"#".repeat(hashes)}`;
		const bodyStart = quote + 4;
		let lineStart = bodyStart;

		for (;;) {
			let cursor = lineStart;
			while (this.text[cursor] === " ") {
				cursor += 1;
			}
			if (this.text.startsWith(fence, cursor)) {
				const afterFence = cursor + fence.length;
				let tail = afterFence;
				while (this.text[tail] === " " || this.text[tail] === "\t") {
					tail += 1;
				}
				if (tail < this.length && this.text[tail] !== "\n") {
					this.fail("INVALID_ARGUMENT", "Closing fence must stand on its own line", tail);
				}

				const indent = cursor - lineStart;
				const bodyEnd = lineStart > bodyStart ? lineStart - 1 : bodyStart;
				const body = this.text.slice(bodyStart, bodyEnd);
				const value = this.stripBlockIndent(body, bodyStart, indent);
				this.index = tail;
				return value;
			}

			const newline = this.text.indexOf("\n", lineStart);
			if (newline === -1) {
				this.fail("UFSS_UNCLOSED", "Unclosed raw block", start);
			}
			lineStart = newline + 1;
		}
	}

	stripBlockIndent(body, bodyStart, indent) {
		const lines = body.split("\n");
		let offset = 0;

		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (line.length === 0) {
				offset += 1;
				continue;
			}

			let spaces = 0;
			while (spaces < line.length && line[spaces] === " ") {
				spaces += 1;
			}
			if (spaces < indent || line.length < indent) {
				const error = this.makeError(
					"UFSS_INDENT_VIOLATION",
					`Block line has ${spaces} leading spaces; ${indent} required`,
					bodyStart + offset,
				);
				error.data.expectedIndent = indent;
				error.data.actualIndent = spaces;
				throw error;
			}

			for (let cursor = indent; cursor < line.length; cursor += 1) {
				const code = line.charCodeAt(cursor);
				if (code < 32 && code !== TAB) {
					this.fail("INVALID_ARGUMENT", "Raw control character in block", bodyStart + offset + cursor);
				}
			}

			lines[index] = line.slice(indent);
			offset += line.length + 1;
		}

		return lines.join("\n");
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

		let keyword = this.keywords.get(name);
		if (keyword === undefined) {
			keyword = new EdnKeyword(name);
			this.keywords.set(name, keyword);
		}
		return keyword;
	}

	readTokenValue() {
		const start = this.index;
		while (this.index < this.length && !isDelimiter(this.text.charCodeAt(this.index))) {
			this.index += 1;
		}

		const token = this.text.slice(start, this.index);
		if (token.length === 0) {
			this.fail("INVALID_ARGUMENT", "Expected an EDN form", start);
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
			if (Number.isSafeInteger(value)) {
				return value;
			}
			return BigInt(token);
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
		return new EdnSymbol(token);
	}

	readList() {
		const start = this.index;
		this.index += 1;
		const values = new EdnList();
		for (;;) {
			this.skipIgnored();
			if (this.index >= this.length) {
				this.fail("INVALID_ARGUMENT", "Unclosed list", start);
			}
			if (this.text[this.index] === ")") {
				this.index += 1;
				return values;
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
				return values;
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

			const identity = printUfss(key);
			if (keys.has(identity) || values.has(key)) {
				this.fail("INVALID_ARGUMENT", "Map has a duplicate key", keyIndex);
			}
			keys.add(identity);
			values.set(key, value);
		}
	}

	readSet() {
		const start = this.index;
		this.index += 2;
		const values = new Set();
		const seen = new Set();
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
			const identity = printUfss(value);
			if (seen.has(identity) || values.has(value)) {
				this.fail("INVALID_ARGUMENT", "Set has a duplicate value", valueIndex);
			}
			seen.add(identity);
			values.add(value);
		}
	}
}

/**
 * Read one EDN value, including UFSS raw string forms.
 *
 * Throws an error with `code`, `line`, `column`, and `data` when the text is
 * not valid EDN or a UFSS fence is broken.
 */
export function readUfss(text) {
	if (typeof text !== "string") {
		throw herdError("INVALID_ARGUMENT", "readUfss expects a string", { type: typeof text });
	}
	return new Reader(text).readDocument();
}

/**
 * Print a value as deterministic EDN + UFSS.
 *
 * `indent` sets the left margin for multi-line strings and nested
 * collections. The first line carries no margin; the caller places it.
 */
export function printUfss(value, options = {}) {
	const indent = options.indent ?? 0;
	if (!Number.isInteger(indent) || indent < 0) {
		throw herdError("INVALID_ARGUMENT", "printUfss indent must be a non-negative integer", { indent });
	}
	return formatValue(value, indent);
}

/** Print a tool receipt: deterministic EDN + UFSS followed by one newline. */
export function renderReceipt(value) {
	return `${printUfss(value)}\n`;
}
