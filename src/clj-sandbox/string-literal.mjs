/**
 * Standard ClojureScript string literals.
 *
 * One parser, one escaper, one skip function. The UFSS modifiers share these;
 * no other module re-implements string boundaries.
 */

const TAB = 0x09;
const NEWLINE = 0x0a;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/**
 * Decode one escape sequence starting at the backslash.
 * @returns {{value:string, end:number}}
 */
function decodeEscape(text, index, fail) {
	const start = index;
	index += 1;
	if (index >= text.length) {
		fail("UFSS_UNCLOSED", "Unclosed string escape", start);
	}
	const code = text[index];
	index += 1;
	switch (code) {
		case '"':
			return { value: '"', end: index };
		case "\\":
			return { value: "\\", end: index };
		case "/":
			return { value: "/", end: index };
		case "b":
			return { value: "\b", end: index };
		case "f":
			return { value: "\f", end: index };
		case "n":
			return { value: "\n", end: index };
		case "r":
			return { value: "\r", end: index };
		case "t":
			return { value: "\t", end: index };
		case "u": {
			const hex = text.slice(index, index + 4);
			if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
				fail("INVALID_ARGUMENT", "Unicode escape needs four hex digits", start);
			}
			return { value: String.fromCharCode(Number.parseInt(hex, 16)), end: index + 4 };
		}
		default:
			fail("INVALID_ARGUMENT", `Unknown escape \\${code}`, start);
	}
}

/**
 * Parse one standard string starting at the opening quote.
 * @returns {{body:string, end:number}}
 */
export function parseStandardString(text, start, fail) {
	let index = start + 1;
	let body = "";

	while (index < text.length) {
		const code = text.charCodeAt(index);
		if (code === QUOTE) {
			return { body, end: index + 1 };
		}
		if (code === BACKSLASH) {
			const decoded = decodeEscape(text, index, fail);
			body += decoded.value;
			index = decoded.end;
			continue;
		}
		if (code < 32 && code !== TAB && code !== NEWLINE) {
			fail("INVALID_ARGUMENT", "Raw control character in string", index);
		}
		body += text[index];
		index += 1;
	}

	fail("UFSS_UNCLOSED", "Unclosed string", start);
}

/** Escape a body as a standard ClojureScript string. */
export function escapeStandardString(text) {
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
			case 0x0d:
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

/** Return the index just after a standard string, or the end of text. */
export function skipString(text, start) {
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

/** Number of leading spaces on the line containing `lineStart`. */
export function leadingSpaces(text, lineStart) {
	let spaces = 0;
	while (text[lineStart + spaces] === " ") {
		spaces += 1;
	}
	return spaces;
}
