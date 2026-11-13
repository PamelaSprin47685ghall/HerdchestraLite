/**
 * EDN reader with one extension point for UFSS raw strings.
 *
 * The reader owns EDN tokenization, comments, collections, sets, and discard
 * forms. It defines no ClojureScript reader macros: `#(` and friends are
 * outside EDN and are rejected here. The single supported `#` extension is the
 * UFSS fence, delegated to `readUfssLiteral`, which returns a plain string and
 * the next cursor. The CLJS pre-pass reuses the same delegate; neither path
 * duplicates fence grammar.
 */

import { herdError } from "../util/errors.mjs";
import { EdnKeyword, EdnList, EdnSymbol, ednIdentity } from "./edn-value.mjs";
import { readUfssLiteral } from "./ufss-literal.mjs";

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
		if (this.text.startsWith("#{", this.index)) {
			return this.readSet();
		}
		return this.readLiteral();
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

			const identity = ednIdentity(key);
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
			const identity = ednIdentity(value);
			if (seen.has(identity) || values.has(value)) {
				this.fail("INVALID_ARGUMENT", "Set has a duplicate value", valueIndex);
			}
			seen.add(identity);
			values.add(value);
		}
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
		return new EdnSymbol(token);
	}
}

/** Read one EDN + UFSS value. */
export function readEdn(text) {
	if (typeof text !== "string") {
		throw herdError("INVALID_ARGUMENT", "readEdn expects a string", { type: typeof text });
	}
	return new EdnReader(text).readDocument();
}
