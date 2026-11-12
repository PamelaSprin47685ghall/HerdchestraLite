/**
 * Exact UTF-16 slice lookup and nearest-line diagnostics.
 *
 * `findAll` and `findUnique` match literal characters. They do not trim,
 * ignore indentation, or treat the needle as a regular expression. Spans are
 * UTF-16 code-unit offsets, so `content.slice(begin, end)` always returns the
 * matched needle.
 */

import { herdError } from "../util/errors.mjs";

const MAX_CANDIDATES = 8;
const CONTEXT_RADIUS = 80;
const NEAREST_DISTANCE_BAND = 64;
const DP_CELL_BUDGET = 10_000_000;
const DP_INF = 0x3fffffff;

function invalidArgument(message, data = {}) {
	return herdError("INVALID_ARGUMENT", message, data);
}

function checkInputs(content, needle) {
	if (typeof content !== "string") {
		throw invalidArgument("content must be a string", { field: "content", type: typeof content });
	}
	if (typeof needle !== "string") {
		throw invalidArgument("needle must be a string", { field: "needle", type: typeof needle });
	}
	if (needle.length === 0) {
		throw invalidArgument("needle must not be empty", { field: "needle", value: needle });
	}
}

function collectMatches(content, needle, limit) {
	const spans = [];
	let from = 0;
	while (spans.length < limit) {
		const begin = content.indexOf(needle, from);
		if (begin === -1) {
			break;
		}
		spans.push([begin, begin + needle.length]);
		from = begin + 1;
	}
	return spans;
}

function candidateContext(content, span) {
	const begin = Math.max(0, span[0] - CONTEXT_RADIUS);
	const end = Math.min(content.length, span[1] + CONTEXT_RADIUS);
	return content.slice(begin, end);
}

/**
 * Find the unique exact span, or return ambiguity evidence, or diagnose the
 * closest line when the needle never appears.
 */
export function findUnique(content, needle) {
	checkInputs(content, needle);

	const spans = collectMatches(content, needle, MAX_CANDIDATES + 1);
	if (spans.length === 1) {
		return { kind: "unique", span: spans[0] };
	}
	if (spans.length > 1) {
		const candidates = spans.slice(0, MAX_CANDIDATES).map((span) => ({
			span,
			context: candidateContext(content, span),
		}));
		const result = { kind: "ambiguous", candidates };
		if (spans.length > MAX_CANDIDATES) {
			result.truncated = true;
		}
		return result;
	}

	const { nearest, budgetExhausted } = findNearestLine(content, needle);
	return { kind: "none", nearest, budgetExhausted };
}

/** Return every exact overlapping span. Zero matches return an empty array. */
export function findAll(content, needle) {
	checkInputs(content, needle);
	const spans = [];
	let from = 0;
	for (;;) {
		const begin = content.indexOf(needle, from);
		if (begin === -1) {
			return spans;
		}
		spans.push([begin, begin + needle.length]);
		from = begin + 1;
	}
}

function hasNonWhitespace(content, start, end) {
	for (let i = start; i < end; i += 1) {
		const code = content.charCodeAt(i);
		if (code > 32 && code !== 160 && code !== 0xfeff) {
			return true;
		}
	}
	return start < end && content.slice(start, end).trim().length > 0;
}

function findNearestLine(content, needle) {
	let nearest = null;
	let remaining = DP_CELL_BUDGET;
	let budgetExhausted = false;
	let lineStart = 0;
	const needleLen = needle.length;
	const scratch = {
		prev: new Int32Array(needleLen + NEAREST_DISTANCE_BAND + 2),
		curr: new Int32Array(needleLen + NEAREST_DISTANCE_BAND + 2),
	};

	while (lineStart <= content.length) {
		let lineEnd = content.indexOf("\n", lineStart);
		if (lineEnd === -1) {
			lineEnd = content.length;
		}

		const lineLen = lineEnd - lineStart;
		if (lineLen > 0 && hasNonWhitespace(content, lineStart, lineEnd)) {
			if (Math.abs(needleLen - lineLen) <= NEAREST_DISTANCE_BAND) {
				const measure = boundedDistanceRange(needle, content, lineStart, lineEnd, remaining, scratch);
				remaining = measure.remaining;
				if (measure.exhausted) {
					budgetExhausted = true;
					break;
				}
				if (measure.distance <= NEAREST_DISTANCE_BAND) {
					if (nearest === null || measure.distance < nearest.distance) {
						nearest = {
							span: [lineStart, lineEnd],
							text: content.slice(lineStart, lineEnd),
							distance: measure.distance,
						};
					}
				}
			}
		}

		if (lineEnd === content.length) {
			break;
		}
		lineStart = lineEnd + 1;
	}

	return { nearest, budgetExhausted };
}

/**
 * Zero-allocation Ukkonen banded Levenshtein distance between `left` and
 * `rightContent[rightStart..rightEnd)`.
 */
function boundedDistanceRange(left, rightContent, rightStart, rightEnd, remaining, scratch) {
	const leftLen = left.length;
	const rightLen = rightEnd - rightStart;
	if (Math.abs(leftLen - rightLen) > NEAREST_DISTANCE_BAND) {
		return { distance: DP_INF, remaining, exhausted: false };
	}

	let prefix = 0;
	const minLen = leftLen < rightLen ? leftLen : rightLen;
	while (prefix < minLen && left.charCodeAt(prefix) === rightContent.charCodeAt(rightStart + prefix)) {
		prefix += 1;
	}

	let leftEnd = leftLen;
	let rEnd = rightEnd;
	while (
		leftEnd > prefix &&
		rEnd > rightStart + prefix &&
		left.charCodeAt(leftEnd - 1) === rightContent.charCodeAt(rEnd - 1)
	) {
		leftEnd -= 1;
		rEnd -= 1;
	}

	const leftMiddleLen = leftEnd - prefix;
	const rightMiddleLen = rEnd - (rightStart + prefix);
	if (leftMiddleLen === 0 || rightMiddleLen === 0) {
		const distance = leftMiddleLen > rightMiddleLen ? leftMiddleLen : rightMiddleLen;
		return {
			distance: distance <= NEAREST_DISTANCE_BAND ? distance : DP_INF,
			remaining,
			exhausted: false,
		};
	}

	const needed = rightMiddleLen + 1;
	if (scratch.prev.length < needed) {
		scratch.prev = new Int32Array(needed);
		scratch.curr = new Int32Array(needed);
	}
	let previous = scratch.prev;
	let current = scratch.curr;
	previous.fill(DP_INF, 0, needed);
	current.fill(DP_INF, 0, needed);
	previous[0] = 0;
	const initLimit = rightMiddleLen < NEAREST_DISTANCE_BAND ? rightMiddleLen : NEAREST_DISTANCE_BAND;
	for (let column = 1; column <= initLimit; column += 1) {
		previous[column] = column;
	}

	const rightBase = rightStart + prefix;
	for (let row = 1; row <= leftMiddleLen; row += 1) {
		const low = row > NEAREST_DISTANCE_BAND ? row - NEAREST_DISTANCE_BAND : 0;
		const highRaw = row + NEAREST_DISTANCE_BAND;
		const high = highRaw < rightMiddleLen ? highRaw : rightMiddleLen;

		if (low === 0) {
			current[0] = row;
		} else {
			current[low - 1] = DP_INF;
		}

		const leftCode = left.charCodeAt(prefix + row - 1);
		const first = low === 0 ? 1 : low;
		for (let column = first; column <= high; column += 1) {
			if (remaining <= 0) {
				return { distance: DP_INF, remaining: 0, exhausted: true };
			}
			remaining -= 1;

			const replaceCost = leftCode === rightContent.charCodeAt(rightBase + column - 1) ? 0 : 1;
			let best = previous[column] + 1;
			const insert = current[column - 1] + 1;
			if (insert < best) best = insert;
			const replace = previous[column - 1] + replaceCost;
			if (replace < best) best = replace;
			current[column] = best;
		}

		const swap = previous;
		previous = current;
		current = swap;
	}

	const distance = previous[rightMiddleLen];
	return {
		distance: distance <= NEAREST_DISTANCE_BAND ? distance : DP_INF,
		remaining,
		exhausted: false,
	};
}
