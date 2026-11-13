/**
 * Output modifier: standard strings become the shortest UFSS fence.
 *
 * The printer first emits plain CLJS strings through `pr_str`; this modifier
 * rewrites each one only when a fence is shorter and carries the body without
 * escapes. Fence depth is chosen so the closing sequence cannot appear in the
 * body: single-line fences avoid `"#`, multi-line fences avoid `"""#`.
 */

import { leadingSpaces } from "./string-literal.mjs";
import { walkSource } from "./walk-source.mjs";

const TAB = 0x09;
const NEWLINE = 0x0a;

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

/**
 * Render one body as the shortest safe literal.
 *
 * @param {string} text body
 * @param {number} indent leading spaces of the containing line
 * @returns {string}
 */
export function renderLiteral(text, indent) {
	if (hasInvisibleControl(text)) {
		return null;
	}

	if (!text.includes("\n")) {
		if (!text.includes('"') && !text.includes("\\")) {
			return null;
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

/**
 * Upgrade eligible standard strings to fences.
 *
 * @param {string} text printed CLJS/EDN
 * @returns {{source:string, segments:Array<object>}}
 */
export function wrapStrings(text) {
	return walkSource(text, {
		onLiteral(literal, output) {
			if (literal.kind !== "standard") {
				return literal.raw;
			}
			const lineStart = output.lastIndexOf("\n") + 1;
			const rendered = renderLiteral(literal.body, leadingSpaces(output, lineStart));
			return rendered === null ? literal.raw : rendered;
		},
	});
}
