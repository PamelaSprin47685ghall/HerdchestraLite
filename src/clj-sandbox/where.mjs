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
const NEAREST_LINE_LIMIT = 2000;
const NEAREST_DISTANCE_BAND = 64;
const DP_CELL_BUDGET = 10_000_000;
const NEAREST_TEXT_LIMIT = 200;

function truncateText(line) {
	if (line.length <= NEAREST_TEXT_LIMIT) {
		return line;
	}
	let text = line.slice(0, NEAREST_TEXT_LIMIT);
	const last = text.charCodeAt(text.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) {
		text = text.slice(0, -1);
	}
	return text;
}

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

function findNearestLine(content, needle) {
	let nearest = null;
	let remaining = DP_CELL_BUDGET;
	let budgetExhausted = false;
	let scanned = 0;
	let lineStart = 0;

	while (scanned < NEAREST_LINE_LIMIT && lineStart <= content.length) {
		let lineEnd = content.indexOf("\n", lineStart);
		if (lineEnd === -1) {
			lineEnd = content.length;
		}

		const line = content.slice(lineStart, lineEnd);
		if (line.length > 0 && line.trim().length > 0) {
			const measure = boundedDistance(needle, line, remaining);
			remaining = measure.remaining;
			if (measure.exhausted) {
				budgetExhausted = true;
				break;
			}
			if (measure.distance <= NEAREST_DISTANCE_BAND) {
				if (nearest === null || measure.distance < nearest.distance) {
					const truncated = line.length > NEAREST_TEXT_LIMIT;
					nearest = {
						span: [lineStart, lineEnd],
						text: truncateText(line),
						distance: measure.distance,
					};
					if (truncated) {
						nearest.truncated = true;
					}
				}
			}
			scanned += 1;
		}

		if (lineEnd === content.length) {
			break;
		}
		lineStart = lineEnd + 1;
	}

	return { nearest, budgetExhausted };
}

/**
 * Levenshtein distance within the K band.
 *
 * Returns `distance: Infinity` when the real distance exceeds K or the line
 * length difference already exceeds K. The caller treats exhaustion as a stop
 * signal and keeps the best nearest line found so far.
 */
function boundedDistance(left, right, remaining) {
	if (Math.abs(left.length - right.length) > NEAREST_DISTANCE_BAND) {
		return { distance: Infinity, remaining, exhausted: false };
	}

	let prefix = 0;
	while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
		prefix += 1;
	}

	let leftEnd = left.length;
	let rightEnd = right.length;
	while (leftEnd > prefix && rightEnd > prefix && left[leftEnd - 1] === right[rightEnd - 1]) {
		leftEnd -= 1;
		rightEnd -= 1;
	}

	const leftMiddle = left.slice(prefix, leftEnd);
	const rightMiddle = right.slice(prefix, rightEnd);
	if (leftMiddle.length === 0 || rightMiddle.length === 0) {
		const distance = Math.max(leftMiddle.length, rightMiddle.length);
		return {
			distance: distance <= NEAREST_DISTANCE_BAND ? distance : Infinity,
			remaining,
			exhausted: false,
		};
	}

	const leftLength = leftMiddle.length;
	const rightLength = rightMiddle.length;
	const infinity = Number.POSITIVE_INFINITY;
	let previous = new Float64Array(rightLength + 1).fill(infinity);
	let current = new Float64Array(rightLength + 1).fill(infinity);
	previous[0] = 0;
	for (let column = 1; column <= Math.min(rightLength, NEAREST_DISTANCE_BAND); column += 1) {
		previous[column] = column;
	}

	for (let row = 1; row <= leftLength; row += 1) {
		const low = Math.max(0, row - NEAREST_DISTANCE_BAND);
		const high = Math.min(rightLength, row + NEAREST_DISTANCE_BAND);

		if (low === 0) {
			current[0] = row;
		} else {
			current[low - 1] = infinity;
		}

		const first = low === 0 ? 1 : low;
		for (let column = first; column <= high; column += 1) {
			if (remaining <= 0) {
				return { distance: Infinity, remaining: 0, exhausted: true };
			}
			remaining -= 1;

			const replaceCost = leftMiddle.charCodeAt(row - 1) === rightMiddle.charCodeAt(column - 1) ? 0 : 1;
			let best = previous[column] + 1;
			const insert = current[column - 1] + 1;
			if (insert < best) {
				best = insert;
			}
			const replace = previous[column - 1] + replaceCost;
			if (replace < best) {
				best = replace;
			}
			current[column] = best;
		}

		const swap = previous;
		previous = current;
		current = swap;
	}

	const distance = previous[rightLength];
	return {
		distance: distance <= NEAREST_DISTANCE_BAND ? distance : Infinity,
		remaining,
		exhausted: false,
	};
}
