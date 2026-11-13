/**
 * UFSS pre-pass for ClojureScript source.
 *
 * The pre-pass does not parse ClojureScript. It walks the source in one of
 * four lexical states (code, string, comment, character) and recognizes the
 * single `#` shape that the official reader does not define: a fence with two
 * or more hashes followed by a quote. Every official dispatch — `#(`, `#_`,
 * `#?`, `#:`, `#'`, `#"regex"`, `#{set}`, `##Inf` — is copied byte for byte.
 *
 * A recognized fence is consumed by `readUfssLiteral` and replaced with a
 * standard escaped ClojureScript string holding the exact body. The rewritten
 * source is plain CLJS; the official reader owns all remaining syntax.
 *
 * Each replacement records an offset segment so a reader error at a rewritten
 * position can be reported at the matching original position.
 */

import { escapeStandardString } from "./edn-writer.mjs";
import { readUfssLiteral } from "./ufss-literal.mjs";

/**
 * Rewrite UFSS fences into standard strings.
 *
 * @param {string} source
 * @returns {{source:string, segments:Array<{originalStart:number, originalEnd:number, rewrittenStart:number, rewrittenEnd:number}>}}
 */
export function ufssToCljs(source) {
	if (typeof source !== "string") {
		throw new TypeError("ufssToCljs expects a string");
	}
	let rewritten = "";
	const segments = [];
	let index = 0;

	while (index < source.length) {
		const code = source.charCodeAt(index);

		if (code === 0x3b) {
			// Line comment: copy through the newline.
			const newline = source.indexOf("\n", index);
			const end = newline === -1 ? source.length : newline + 1;
			rewritten += source.slice(index, end);
			index = end;
			continue;
		}

		if (code === 0x22) {
			const end = skipString(source, index);
			rewritten += source.slice(index, end);
			index = end;
			continue;
		}

		if (code === 0x5c) {
			// Character literal: backslash plus one character.
			const end = Math.min(source.length, index + 2);
			rewritten += source.slice(index, end);
			index = end;
			continue;
		}

		if (code === 0x23) {
			let hashes = 0;
			while (source[index + hashes] === "#") {
				hashes += 1;
			}
			// `#"` is the official regex literal; only two or more hashes are UFSS.
			if (hashes >= 2 && source[index + hashes] === '"') {
				const literal = readUfssLiteral(source, index);
				if (literal.ok === true) {
					const text = escapeStandardString(literal.value);
					segments.push({
						originalStart: index,
						originalEnd: literal.nextIndex,
						rewrittenStart: rewritten.length,
						rewrittenEnd: rewritten.length + text.length,
					});
					rewritten += text;
					index = literal.nextIndex;
					continue;
				}
			}
		}

		rewritten += source[index];
		index += 1;
	}

	return { source: rewritten, segments };
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

/**
 * Map a rewritten offset back to the original source.
 *
 * Offsets inside a replaced fence map to the fence start; offsets after it are
 * shifted by the accumulated replacement delta. Callers use this for reader
 * errors only.
 */
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
