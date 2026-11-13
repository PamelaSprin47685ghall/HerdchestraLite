/**
 * The single source walker under the UFSS and await modifiers.
 *
 * The walker owns code-state navigation only:
 *
 * - comments and character literals are copied whole;
 * - string literals, UFSS fences, and bare blocks are offered to `onLiteral`;
 * - a complete list is offered to `onForm` with its head symbol, raw text, and
 *   body, but only when the caller supplies `onForm`;
 * - quote/syntax-quote/unquote prefixes are copied and mark the next form as
 *   quoted, so a modifier can leave data alone;
 * - every replaced range is recorded as an offset segment.
 *
 * The walker does not know what a fence or a suspend form means. Modifiers do.
 */

import { herdError } from "../util/errors.mjs";
import { parseStandardString } from "./string-literal.mjs";
import { readUfssLiteral } from "./ufss-literal.mjs";

const SEMICOLON = 0x3b;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_PAREN = 0x28;
const SINGLE_QUOTE = 0x27;
const BACKTICK = 0x60;
const TILDE = 0x7e;

function isDelimiter(code) {
	return (
		code === undefined ||
		code === 0x20 ||
		code === 0x09 ||
		code === 0x0a ||
		code === 0x0d ||
		code === 0x2c ||
		code === SEMICOLON ||
		code === QUOTE ||
		code === OPEN_PAREN ||
		code === 0x29 ||
		code === 0x5b ||
		code === 0x5d ||
		code === 0x7b ||
		code === 0x7d
	);
}

function skipString(text, start) {
	let index = start + 1;
	while (index < text.length) {
		if (text[index] === "\\") {
			index += 2;
			continue;
		}
		if (text[index] === '"') {
			return index + 1;
		}
		index += 1;
	}
	return text.length;
}

/** Return the index just after the matching close bracket, or -1. */
export function matchBracket(text, start) {
	const open = text[start];
	const close = open === "(" ? ")" : open === "[" ? "]" : "}";
	let depth = 0;
	let index = start;
	while (index < text.length) {
		const code = text.charCodeAt(index);
		if (code === QUOTE) {
			index = skipString(text, index);
			continue;
		}
		if (code === SEMICOLON) {
			const newline = text.indexOf("\n", index);
			index = newline === -1 ? text.length : newline + 1;
			continue;
		}
		if (code === BACKSLASH) {
			index += 2;
			continue;
		}
		if (text[index] === open) {
			depth += 1;
		} else if (text[index] === close) {
			depth -= 1;
			if (depth === 0) {
				return index + 1;
			}
		}
		index += 1;
	}
	return -1;
}

function readLiteralAt(text, index) {
	const code = text.charCodeAt(index);
	if (code === QUOTE) {
		if (text.startsWith('"""', index) && text[index + 3] === "\n") {
			const literal = readUfssLiteral(text, index);
			if (literal.ok === true) {
				return {
					kind: "bare",
					body: literal.value,
					start: index,
					end: literal.nextIndex,
					raw: text.slice(index, literal.nextIndex),
				};
			}
		}
		const parsed = parseStandardString(text, index, (errorCode, message, position) => {
			throw herdError(errorCode, `${message} at position ${position}`);
		});
		return { kind: "standard", body: parsed.body, start: index, end: parsed.end, raw: text.slice(index, parsed.end) };
	}
	if (code === 0x23) {
		let hashes = 0;
		while (text[index + hashes] === "#") {
			hashes += 1;
		}
		if (hashes >= 2 && text[index + hashes] === '"') {
			const literal = readUfssLiteral(text, index);
			if (literal.ok === true) {
				return {
					kind: "fence",
					body: literal.value,
					start: index,
					end: literal.nextIndex,
					raw: text.slice(index, literal.nextIndex),
				};
			}
		}
	}
	return null;
}

function readFormAt(text, index) {
	const end = matchBracket(text, index);
	if (end === -1) {
		return null;
	}
	let cursor = index + 1;
	while (cursor < end && !isDelimiter(text.charCodeAt(cursor))) {
		cursor += 1;
	}
	const head = text.slice(index + 1, cursor);
	if (head.length === 0) {
		return null;
	}
	return {
		head,
		start: index,
		end,
		raw: text.slice(index, end),
		body: text.slice(cursor, end - 1),
	};
}

/**
 * Walk one source string.
 *
 * @param {string} source
 * @param {{
 *   onLiteral?: (literal: {kind:"standard"|"fence"|"bare", body:string, raw:string, start:number, end:number, quoted:boolean}, output:string) => string,
 *   onForm?: (form: {head:string, raw:string, body:string, start:number, end:number, quoted:boolean}, output:string) => string
 * }} visitors
 * @returns {{source:string, segments:Array<{originalStart:number, originalEnd:number, rewrittenStart:number, rewrittenEnd:number}>}}
 */
export function walkSource(source, { onLiteral, onForm } = {}) {
	let output = "";
	const segments = [];
	let index = 0;
	let quoted = false;

	while (index < source.length) {
		const code = source.charCodeAt(index);

		if (code === SEMICOLON) {
			const newline = source.indexOf("\n", index);
			const end = newline === -1 ? source.length : newline + 1;
			output += source.slice(index, end);
			index = end;
			continue;
		}

		if (code === BACKSLASH) {
			const end = Math.min(source.length, index + 2);
			output += source.slice(index, end);
			index = end;
			quoted = false;
			continue;
		}

		if (code === SINGLE_QUOTE || code === BACKTICK || code === TILDE) {
			output += source[index];
			index += 1;
			if (source[index] === "@") {
				output += source[index];
				index += 1;
			}
			quoted = true;
			continue;
		}

		const literal = readLiteralAt(source, index);
		if (literal !== null) {
			const rendered = onLiteral ? onLiteral({ ...literal, quoted }, output) : literal.raw;
			segments.push({
				originalStart: index,
				originalEnd: literal.end,
				rewrittenStart: output.length,
				rewrittenEnd: output.length + rendered.length,
			});
			output += rendered;
			index = literal.end;
			quoted = false;
			continue;
		}

		if (code === OPEN_PAREN && onForm) {
			const form = readFormAt(source, index);
			if (form !== null) {
				const rendered = onForm({ ...form, quoted }, output);
				segments.push({
					originalStart: index,
					originalEnd: form.end,
					rewrittenStart: output.length,
					rewrittenEnd: output.length + rendered.length,
				});
				output += rendered;
				index = form.end;
				quoted = false;
				continue;
			}
		}

		output += source[index];
		index += 1;
		if (!isDelimiter(code)) {
			quoted = false;
		}
	}

	return { source: output, segments };
}

/** Map a rewritten offset back to the original source. */
export function mapRewrittenOffset(segments, offset) {
	let delta = 0;
	for (const segment of segments) {
		if (offset < segment.rewrittenStart) break;
		if (offset < segment.rewrittenEnd) {
			return segment.originalStart;
		}
		delta = segment.originalEnd - segment.rewrittenEnd;
	}
	return offset + delta;
}
