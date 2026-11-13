/**
 * LLM-facing await macros.
 *
 * Cherry's self-hosted compiler does not expand `defmacro` inside one file,
 * so the framework performs the only macro expansion the sandbox needs: forms
 * that suspend (`park`, `where`, `unpark`, `abandon`) become
 * `(js/await (sandbox/<form> ...))`. The model writes the plain form; the
 * expansion is invisible.
 *
 * The expander walks code, string, comment, and character states. It matches a
 * complete list whose head is exactly one of the suspend forms; nested forms
 * are expanded recursively. No other syntax is touched.
 */

const SUSPEND_FORMS = new Set(["park", "where", "unpark", "abandon"]);

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
		code === 0x3b ||
		code === 0x22 ||
		code === 0x28 ||
		code === 0x29 ||
		code === 0x5b ||
		code === 0x5d ||
		code === 0x7b ||
		code === 0x7d
	);
}

function skipString(source, start) {
	let index = start + 1;
	while (index < source.length) {
		if (source[index] === "\\") {
			index += 2;
			continue;
		}
		if (source[index] === '"') {
			return index + 1;
		}
		index += 1;
	}
	return source.length;
}

/** Return the index just after the matching close bracket, or -1. */
function matchBracket(source, start) {
	const open = source[start];
	const close = open === "(" ? ")" : open === "[" ? "]" : "}";
	let depth = 0;
	let index = start;
	while (index < source.length) {
		const code = source.charCodeAt(index);
		if (code === QUOTE) {
			index = skipString(source, index);
			continue;
		}
		if (code === SEMICOLON) {
			const newline = source.indexOf("\n", index);
			index = newline === -1 ? source.length : newline + 1;
			continue;
		}
		if (code === BACKSLASH) {
			index += 2;
			continue;
		}
		if (source[index] === open) {
			depth += 1;
		} else if (source[index] === close) {
			depth -= 1;
			if (depth === 0) {
				return index + 1;
			}
		}
		index += 1;
	}
	return -1;
}

/** Skip one complete form: string, bracketed form, or atom. */
function skipForm(source, start) {
	let index = start;
	while (index < source.length && /\s/.test(source[index])) {
		index += 1;
	}
	if (index >= source.length) {
		return source.length;
	}
	const code = source.charCodeAt(index);
	if (code === QUOTE) {
		return skipString(source, index);
	}
	if (code === OPEN_PAREN || code === 0x5b || code === 0x7b) {
		const end = matchBracket(source, index);
		return end === -1 ? source.length : end;
	}
	while (index < source.length && !isDelimiter(source.charCodeAt(index))) {
		index += 1;
	}
	return index;
}

/**
 * Expand suspend forms into awaited sandbox calls.
 *
 * @param {string} source ClojureScript source
 * @returns {string}
 */
export function expandAwaitMacros(source) {
	let output = "";
	let index = 0;

	while (index < source.length) {
		const code = source.charCodeAt(index);

		if (code === QUOTE) {
			const end = skipString(source, index);
			output += source.slice(index, end);
			index = end;
			continue;
		}

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
			continue;
		}

		if (code === SINGLE_QUOTE || code === BACKTICK || code === TILDE) {
			output += source[index];
			index += 1;
			if (source[index] === "@") {
				output += source[index];
				index += 1;
			}
			const end = skipForm(source, index);
			output += source.slice(index, end);
			index = end;
			continue;
		}

		if (code === OPEN_PAREN) {
			let cursor = index + 1;
			while (cursor < source.length && !isDelimiter(source.charCodeAt(cursor))) {
				cursor += 1;
			}
			const head = source.slice(index + 1, cursor);
			if (SUSPEND_FORMS.has(head) && isDelimiter(source.charCodeAt(cursor))) {
				const end = matchBracket(source, index);
				if (end !== -1) {
					const body = expandAwaitMacros(source.slice(cursor, end - 1));
					output += `(js/await (sandbox/${head}${body}))`;
					index = end;
					continue;
				}
			}
		}

		output += source[index];
		index += 1;
	}

	return output;
}
