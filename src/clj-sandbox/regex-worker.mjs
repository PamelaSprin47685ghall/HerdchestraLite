/**
 * Regex execution in a terminable worker.
 *
 * The evaluator sends one task to a fresh worker. The worker returns one
 * message. A deadline or abort terminates the worker, so a catastrophic
 * regular expression cannot block the host.
 *
 * Worker protocol:
 *   task   = {op, pattern, text?, firstOnly?}
 *   result = {ok: true, result} | {ok: false, error: {kind, name, message}}
 *
 * `op` is "pattern", "find", "matches", "seq", "replace-matches", or
 * "replace-string".
 * Regex patterns use {source, flags}; replacement patterns may use
 * {literal} instead. Match results keep the Clojure shape: the full match as
 * a string when there are no groups, otherwise an array whose first item is
 * the full match and whose later items are groups or null.
 *
 * "replace-matches" returns spans for a callback replacement.
 * "replace-string" returns the final text with Cherry's string replacement
 * rules, including `$` expansion and its flag normalization.
 */
import { parentPort, Worker, workerData } from "node:worker_threads";
import { herdError } from "../util/errors.mjs";

function invalid(message, data = {}) {
	const error = new Error(message);
	error.name = "RegexTaskError";
	error.kind = "invalid";
	error.data = data;
	return error;
}

function patternError(error) {
	const failure = new Error(error?.message ?? "invalid regular expression");
	failure.name = "RegexTaskError";
	failure.kind = "pattern";
	return failure;
}

function asPatternText(value) {
	if (typeof value !== "string") {
		throw invalid("regex pattern must be a string");
	}
	return value;
}

function asRegexSpec(value, allowLiteral = false) {
	if (typeof value === "string") {
		if (!allowLiteral) throw invalid("regex pattern must be {source, flags}");
		return { literal: value };
	}
	if (value === null || typeof value !== "object") {
		throw invalid("regex pattern must be {source, flags}");
	}
	if (allowLiteral && typeof value.literal === "string") {
		return { literal: value.literal };
	}
	if (typeof value.source !== "string") {
		throw invalid("regex pattern needs a string source");
	}
	const flags = value.flags ?? "";
	if (typeof flags !== "string") {
		throw invalid("regex flags must be a string");
	}
	return { source: value.source, flags };
}

/** Compile a Clojure `re-pattern` string, including leading `(?flags)`. */
export function compileClojurePattern(source) {
	const text = asPatternText(source);
	const leading = /^\(\?([idmsux]*)\)/.exec(text);
	try {
		if (leading === null) {
			return new RegExp(text);
		}
		return new RegExp(text.slice(leading[0].length), leading[1]);
	} catch (error) {
		throw patternError(error);
	}
}

function compileRegex(spec) {
	if (spec.literal !== undefined) {
		throw invalid("this operation needs a regular expression, not a literal");
	}
	try {
		return new RegExp(spec.source, spec.flags);
	} catch (error) {
		throw patternError(error);
	}
}

function clojureMatchValue(match) {
	if (match.length === 1) {
		return match[0];
	}
	return Array.from(match, (group) => group ?? null);
}

function matchRecord(match) {
	return {
		index: match.index,
		end: match.index + match[0].length,
		value: clojureMatchValue(match),
	};
}

function requireText(task) {
	if (typeof task.text !== "string") {
		throw invalid("regex task needs a string text");
	}
	return task.text;
}

function findMatch(task) {
	const text = requireText(task);
	const regex = compileRegex(asRegexSpec(task.pattern));
	const match = regex.exec(text);
	return match === null ? null : matchRecord(match);
}

function matchesWhole(task) {
	const text = requireText(task);
	const regex = compileRegex(asRegexSpec(task.pattern));
	const match = regex.exec(text);
	if (match === null || match[0] !== text) {
		return null;
	}
	return matchRecord(match);
}

/**
 * Match one re-seq slice and report the slice for the next step.
 *
 * Cherry's re_seq reuses one RegExp and matches the next string slice. The
 * `advance` value keeps its observable ^, lastIndex, and trailing-empty
 * behavior; `regex.lastIndex` remains the caller's state.
 */
function matchSeqStep(regex, text, offset) {
	const match = regex.exec(text);
	if (match === null) {
		return { record: null, done: true, advance: 0 };
	}
	const record = {
		index: offset + match.index,
		end: offset + match.index + match[0].length,
		value: clojureMatchValue(match),
	};
	const advance = match.index + Math.max(1, match[0].length);
	return { record, done: advance > text.length, advance };
}

function allMatches(task) {
	const text = requireText(task);
	const regex = compileRegex(asRegexSpec(task.pattern));
	const matches = [];
	let rest = text;
	let offset = 0;
	for (;;) {
		const step = matchSeqStep(regex, rest, offset);
		if (step.record === null) {
			break;
		}
		matches.push(step.record);
		if (step.done) {
			break;
		}
		offset += step.advance;
		rest = rest.slice(step.advance);
	}
	return matches;
}

/**
 * Produce one re-seq match from a carried `{offset, rest, lastIndex}` state.
 *
 * This is the same loop as `allMatches`, split into steps so the evaluator can
 * pull matches lazily and interrupt a catastrophic step at the deadline. The
 * regex is fresh per call; `lastIndex` is the only mutable state `exec` uses,
 * so restoring it reproduces Cherry's global/sticky behavior exactly.
 */
function seqStep(task) {
	const text = requireText(task);
	const offset = task.offset;
	const lastIndex = task.lastIndex;
	if (!Number.isInteger(offset) || offset < 0) {
		throw invalid("seq-step offset must be a non-negative integer");
	}
	if (!Number.isInteger(lastIndex) || lastIndex < 0) {
		throw invalid("seq-step lastIndex must be a non-negative integer");
	}
	const regex = compileRegex(asRegexSpec(task.pattern));
	regex.lastIndex = lastIndex;
	const step = matchSeqStep(regex, text, offset);
	if (step.record === null) {
		return { match: null, done: true, next: null };
	}
	if (step.done) {
		return { match: step.record, done: true, next: null };
	}
	return {
		match: step.record,
		done: false,
		next: {
			offset: offset + step.advance,
			rest: text.slice(step.advance),
			lastIndex: regex.lastIndex,
		},
	};
}

function literalMatches(text, literal, firstOnly) {
	const matches = [];
	if (literal.length === 0) {
		const limit = firstOnly ? 1 : text.length + 1;
		for (let index = 0; index < limit; index += 1) {
			matches.push({ index, end: index, value: "" });
		}
		return matches;
	}
	let from = 0;
	for (;;) {
		const index = text.indexOf(literal, from);
		if (index === -1) {
			break;
		}
		matches.push({ index, end: index + literal.length, value: literal });
		from = index + literal.length;
		if (firstOnly) {
			break;
		}
	}
	return matches;
}

/**
 * Enumerate matches for `clojure.string/replace` and `replace-first`.
 *
 * This is the same matching rule the evaluator used inline: a literal uses
 * indexOf, and a regex uses one exec for first-only or matchAll for all.
 */
function collectReplaceMatches(task) {
	const text = requireText(task);
	const spec = asRegexSpec(task.pattern, true);
	const firstOnly = task.firstOnly === true;
	if (spec.literal !== undefined) {
		return literalMatches(text, spec.literal, firstOnly);
	}
	const regex = compileRegex(spec);
	const flags = firstOnly
		? regex.flags.replaceAll("g", "")
		: regex.flags.includes("g")
			? regex.flags
			: `${regex.flags}g`;
	let compiled;
	try {
		compiled = new RegExp(regex.source, flags);
	} catch (error) {
		throw patternError(error);
	}
	if (firstOnly) {
		const match = compiled.exec(text);
		return match === null ? [] : [matchRecord(match)];
	}
	const matches = [];
	for (const match of text.matchAll(compiled)) {
		matches.push(matchRecord(match));
	}
	return matches;
}

function replacementFlags(flags) {
	return `g${flags.includes("i") ? "i" : ""}${flags.includes("m") ? "m" : ""}${flags.includes("u") ? "u" : ""}`;
}

/**
 * Apply a string replacement with Cherry's observable clojure.string rules.
 *
 * `clojure.string/replace` escapes literal patterns, keeps only g/i/m/u on
 * regex patterns, and expands `$` replacement tokens. `replace-first`
 * delegates to String#replace with the original pattern and flags.
 */
function applyStringReplacement(task) {
	const text = requireText(task);
	const replacement = task.replacement;
	if (typeof replacement !== "string") {
		throw invalid("string replacement must be a string");
	}
	const spec = asRegexSpec(task.pattern, true);
	const firstOnly = task.firstOnly === true;
	if (firstOnly) {
		if (spec.literal !== undefined) {
			return text.replace(spec.literal, replacement);
		}
		return text.replace(compileRegex(spec), replacement);
	}
	if (spec.literal !== undefined) {
		const escaped = spec.literal.replace(/([-()[\]{}+?*.$^|,:#<!\\])/g, "\\$1").replaceAll("\x08", "\\x08");
		return text.replace(new RegExp(escaped, "g"), replacement);
	}
	return text.replace(compileRegex({ source: spec.source, flags: replacementFlags(spec.flags) }), replacement);
}

function compilePattern(task) {
	const regex = compileClojurePattern(asPatternText(task.pattern));
	return { source: regex.source, flags: regex.flags };
}

/**
 * Execute one regex task synchronously. The module also runs this function in
 * the worker, so tests can call it directly when the task is known to finish.
 */
export function executeRegexTask(task) {
	if (task === null || typeof task !== "object") {
		throw invalid("regex task must be an object");
	}
	switch (task.op) {
		case "pattern":
			return compilePattern(task);
		case "find":
			return findMatch(task);
		case "matches":
			return matchesWhole(task);
		case "seq":
			return allMatches(task);
		case "seq-step":
			return seqStep(task);
		case "replace-matches":
			return collectReplaceMatches(task);
		case "replace-string":
			return applyStringReplacement(task);
		default:
			throw invalid("unknown regex operation", { op: task.op });
	}
}

if (parentPort !== null && workerData?.__regexTask === true) {
	let response;
	try {
		response = { ok: true, result: executeRegexTask(workerData.task) };
	} catch (error) {
		response = {
			ok: false,
			error: {
				kind: error?.kind ?? "runtime",
				name: error?.name ?? "Error",
				message: error?.message ?? String(error),
			},
		};
	}
	parentPort.postMessage(response);
	parentPort.close();
}

function taskFailure(reason, message, data = {}) {
	const code =
		reason === "deadline" || reason === "abort"
			? "UPSTREAM_ABORTED"
			: reason === "runtime"
				? "HOST_API_MISMATCH"
				: "INVALID_ARGUMENT";
	const error = herdError(code, message, { ...data, reason });
	error.reason = reason;
	return error;
}

function deadlineLeft(options) {
	let left = Number.POSITIVE_INFINITY;
	if (options.timeoutMs !== undefined) {
		if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
			throw taskFailure("invalid", "timeoutMs must be a finite non-negative number");
		}
		if (options.timeoutMs > 0) left = Math.min(left, options.timeoutMs);
	}
	if (options.deadlineAt !== undefined) {
		if (!Number.isFinite(options.deadlineAt)) {
			throw taskFailure("invalid", "deadlineAt must be a finite timestamp");
		}
		left = Math.min(left, options.deadlineAt - Date.now());
	}
	return left;
}

function abortSignalOf(options) {
	const signal = options.signal;
	if (signal === undefined) return null;
	if (typeof signal?.aborted !== "boolean" || typeof signal.addEventListener !== "function") {
		throw taskFailure("invalid", "signal must be an AbortSignal");
	}
	return signal;
}

/**
 * Run one regex task in a worker and settle on result, deadline, or abort.
 *
 * `timeoutMs` is a relative limit; `deadlineAt` is an absolute epoch
 * timestamp. `timeoutMs: 0` disables that limit. When both are present the
 * earlier limit wins. A deadline or abort terminates the worker and rejects
 * with a registered `:UPSTREAM_ABORTED` error whose `data.reason` is
 * "deadline" or "abort".
 */
export function runRegexTask(task, options = {}) {
	const settings = options ?? {};
	let left;
	let signal;
	try {
		left = deadlineLeft(settings);
		signal = abortSignalOf(settings);
	} catch (error) {
		return Promise.reject(error);
	}
	if (signal?.aborted) {
		return Promise.reject(taskFailure("abort", "regex task aborted before start", { operation: task?.op }));
	}
	if (left <= 0) {
		return Promise.reject(taskFailure("deadline", "regex task deadline already expired", { operation: task?.op }));
	}

	return new Promise((resolve, reject) => {
		let worker;
		try {
			worker = new Worker(new URL("./regex-worker.mjs", import.meta.url), { workerData: { __regexTask: true, task } });
		} catch (error) {
			reject(taskFailure("runtime", "cannot start regex worker", { cause: error?.message ?? String(error) }));
			return;
		}

		let settled = false;
		let timer = null;
		const cleanup = () => {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			signal?.removeEventListener("abort", onAbort);
		};
		const succeed = (value) => {
			if (settled) return;
			settled = true;
			cleanup();
			worker.unref?.();
			resolve(value);
		};
		const failTask = (reason, message, data = {}) => {
			if (settled) return;
			settled = true;
			cleanup();
			const error = taskFailure(reason, message, { ...data, operation: task?.op });
			worker.terminate().catch(() => {});
			reject(error);
		};
		const onAbort = () => {
			failTask("abort", "regex task aborted", { abortReason: String(signal?.reason ?? "") });
		};

		worker.once("message", (message) => {
			if (message?.ok === true) {
				succeed(message.result);
				return;
			}
			const failure = message?.error;
			failTask(
				failure?.kind === "pattern" || failure?.kind === "invalid" ? failure.kind : "runtime",
				failure?.message ?? "regex worker failed",
				{ workerError: failure?.name ?? "Error" },
			);
		});
		worker.once("error", (error) => {
			failTask("runtime", "regex worker crashed", { cause: error?.message ?? String(error) });
		});
		worker.once("exit", (code) => {
			if (!settled) {
				failTask("runtime", "regex worker exited without a result", { exitCode: code });
			}
		});
		if (signal !== null) {
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) {
				onAbort();
				return;
			}
		}
		if (left !== Number.POSITIVE_INFINITY) {
			timer = setTimeout(
				() => {
					failTask("deadline", "regex task exceeded its deadline", { timeoutMs: settings.timeoutMs });
				},
				Math.max(1, Math.ceil(left)),
			);
			timer.unref?.();
		}
	});
}

function regexSpec(pattern) {
	if (pattern instanceof RegExp) {
		return { source: pattern.source, flags: pattern.flags };
	}
	if (pattern !== null && typeof pattern === "object" && typeof pattern.source === "string") {
		return { source: pattern.source, flags: pattern.flags ?? "" };
	}
	throw taskFailure("invalid", "pattern must be a RegExp or {source, flags}");
}

/** Return the Clojure `re-find` value, or null. */
export async function reFind(pattern, text, options) {
	const match = await runRegexTask({ op: "find", pattern: regexSpec(pattern), text }, options);
	return match === null ? null : match.value;
}

/** Return the Clojure `re-matches` value, or null. */
export async function reMatches(pattern, text, options) {
	const match = await runRegexTask({ op: "matches", pattern: regexSpec(pattern), text }, options);
	return match === null ? null : match.value;
}

/** Return the Clojure `re-seq` values as an array. */
export async function reSeq(pattern, text, options) {
	const matches = await runRegexTask({ op: "seq", pattern: regexSpec(pattern), text }, options);
	return matches.map((match) => match.value);
}

/**
 * Return the next `re-seq` match and the state for the following step.
 *
 * `state` is `{offset, rest, lastIndex}`. The first call uses
 * `{offset: 0, rest: text, lastIndex: 0}`.
 */
export async function reSeqStep(pattern, text, state, options) {
	return runRegexTask(
		{
			op: "seq-step",
			pattern: regexSpec(pattern),
			text,
			offset: state.offset,
			lastIndex: state.lastIndex,
		},
		options,
	);
}

/**
 * Enumerate replacement matches. Each item has index, end, and the Clojure
 * replacement argument as `value`.
 */
function replacementSpec(pattern) {
	return pattern instanceof RegExp
		? { source: pattern.source, flags: pattern.flags }
		: typeof pattern === "string"
			? { literal: pattern }
			: pattern;
}

export async function replaceMatches(text, pattern, firstOnly = false, options) {
	return runRegexTask({ op: "replace-matches", pattern: replacementSpec(pattern), text, firstOnly }, options);
}

/**
 * Return the final string for `clojure.string/replace` or
 * `clojure.string/replace-first` with a string replacement.
 */
export async function stringReplace(text, pattern, replacement, firstOnly = false, options) {
	return runRegexTask(
		{
			op: "replace-string",
			pattern: replacementSpec(pattern),
			text,
			replacement,
			firstOnly,
		},
		options,
	);
}
