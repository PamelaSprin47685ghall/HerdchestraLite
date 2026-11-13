/**
 * The single UFSS extension point for an EDN or ClojureScript reader.
 *
 * A reader owns tokenization, collections, comments, and every official `#`
 * dispatch. UFSS defines exactly one dispatch that the official readers do not:
 * a raw string fence (`##"..."##` or `##"""..."""##`). When a reader reaches a
 * `#` it does not define, it hands its cursor to `readUfssLiteral`; a successful
 * read returns a plain string and the next cursor. The reader decides what to
 * do on failure — normally its own "unknown dispatch" error.
 *
 * This module never rewrites source text. It advances an index over the
 * original text and reports `nextIndex`, so the reader architecture stays in
 * charge of the surrounding forms.
 */

const TAB = 0x09;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const QUOTE = 0x22;

function fail(code, message, index, data = {}) {
	return { ok: false, code, message, index, data };
}

/**
 * Try to read one UFSS fence at `index`.
 *
 * @param {string} text
 * @param {number} index position of the first `#`
 * @returns {{ok:true, value:string, nextIndex:number} | {ok:false, code:string, message:string, index:number}}
 */
export function readUfssLiteral(text, index) {
	if (typeof text !== "string") {
		return fail("INVALID_ARGUMENT", "UFSS literal needs a string", index);
	}
	let hashes = 0;
	while (text[index + hashes] === "#") {
		hashes += 1;
	}
	if (hashes === 0) {
		if (!text.startsWith('"""', index) || text[index + 3] !== "\n") {
			return fail("INVALID_ARGUMENT", "UFSS literal must start with #", index);
		}
		return readMultiLine(text, index, 0, index);
	}
	const quote = index + hashes;
	if (text[quote] !== '"') {
		return fail("INVALID_ARGUMENT", "Unknown # dispatch", index);
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
			return fail("UFSS_UNCLOSED", "Raw string fence does not close on this line", start);
		}
		if (code < 32 && code !== TAB) {
			return fail("INVALID_ARGUMENT", "Raw control character in string", cursor);
		}
		cursor += 1;
	}
	return fail("UFSS_UNCLOSED", "Unclosed raw string", start);
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
				return fail("INVALID_ARGUMENT", "Closing fence must stand on its own line", tail);
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
			return fail("UFSS_UNCLOSED", "Unclosed raw block", start);
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
			return fail(
				"UFSS_INDENT_VIOLATION",
				`Block line has ${spaces} leading spaces; ${indent} required`,
				bodyStart + offset,
				{ expectedIndent: indent, actualIndent: spaces },
			);
		}
		for (let cursor = indent; cursor < line.length; cursor += 1) {
			const code = line.charCodeAt(cursor);
			if (code < 32 && code !== TAB) {
				return fail("INVALID_ARGUMENT", "Raw control character in block", bodyStart + offset + cursor);
			}
		}
		output.push(line.slice(indent));
		offset += line.length + 1;
	}

	return { ok: true, value: output.join("\n") };
}
