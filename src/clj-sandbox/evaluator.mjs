/**
 * Promise-CPS evaluator for the ClojureScript sandbox.
 *
 * The evaluator is a deterministic CEK machine: the control expression, the
 * lexical environment, and an explicit continuation stack are the only state.
 * Capability calls are awaited one at a time; higher-order sequence functions
 * are machine frames, not JavaScript callbacks, so a park inside a callback
 * keeps the whole continuation.
 *
 * Security: every source form is analysed before execution. A symbol is legal
 * only when it is locally bound, a builtin, or an allowed capability. There is
 * no lookup against `globalThis`, no `eval`, and no `Function` constructor.
 *
 * Persistence: programs live in one in-memory table per session, keyed by
 * `program_name`. A parked program keeps its continuation, lexical frames,
 * pending VFS state, read-set, and capability snapshot. Nothing is written to
 * disk by this module; a caller-supplied commit port performs protected writes.
 *
 * Ports (all optional; see `createSandboxSession`):
 * - `createCapabilities({session, program, programName, code, intent})` returns
 *   an object, Map, or name array. External capability functions receive a
 *   null-prototype plain object built from the single EDN map argument, plus
 *   `{session, program, map}` as a second context argument.
 * - `commit({session, program, name, value, readSet, capabilities})` performs
 *   the protected write; `discard(...)` drops a failed batch. The `call`
 *   capability owns its pre-call drain after its own validation and signal
 *   checks, so the evaluator never commits staged writes before a rejected
 *   call. A result with `ok:false` or `status` `:rejected`, `:uncertain`, or
 *   `:cancelled` is a failure.
 * - `cat` may return `{content, stamp}` or a string; `stat`/`ls` results may use
 *   C3's camelCase fields, which are exposed with EDN kebab-case aliases too.
 */

import { ERROR_CODES, herdError, isHerdError } from "../util/errors.mjs";
import { loadCherry } from "./cherry.mjs";
import {
	reFind as regexWorkerFind,
	reMatches as regexWorkerMatches,
	replaceMatches as regexWorkerReplaceMatches,
	reSeqStep as regexWorkerSeqStep,
	stringReplace as regexWorkerStringReplace,
} from "./regex-worker.mjs";
import { EdnKeyword, EdnList, EdnSymbol, printUfss, readUfss } from "./ufss.mjs";
import { findAll, findUnique } from "./where.mjs";

const TEXT_ENCODER = new TextEncoder();
const MAX_MATERIALIZED_ITEMS = 200_000;

/**
 * Cherry data runtime. One Cherry instance is shared by every session because
 * H0 caches the module instance; values from different sessions must compare.
 */
let DATA = null;

function data() {
	if (DATA === null) {
		fail("HOST_API_MISMATCH", "cherry-cljs data runtime is not loaded", {
			module: "cherry-cljs",
		});
	}
	return DATA;
}

async function ensureDataRuntime(session) {
	if (DATA !== null) {
		return DATA;
	}
	const injected = session?.cherry;
	const loaded =
		injected !== undefined && injected !== null
			? { ok: true, cherry: await injected, error: undefined }
			: await loadCherry();
	if (!loaded.ok) {
		fail(
			loaded.error?.code ?? "HOST_API_MISMATCH",
			loaded.error?.message ?? "cherry-cljs is unavailable",
			loaded.error?.data ?? { module: "cherry-cljs" },
		);
	}
	DATA = makeDataRuntime(loaded.cherry);
	return DATA;
}

function makeDataRuntime(cherry) {
	const core = cherry?.core;
	if (core === null || typeof core !== "object") {
		fail("HOST_API_MISMATCH", "cherry-cljs core runtime is unavailable", {
			module: "cherry-cljs/cljs.core.js",
		});
	}
	for (const name of ["keyword", "vector", "hash_map", "hash_set", "list", "_EQ_", "seq"]) {
		if (typeof core[name] !== "function") {
			fail("HOST_API_MISMATCH", `cherry-cljs core lacks ${name}`, { export: name });
		}
	}

	const seqToArray = (value) => {
		if (value === null || value === undefined) {
			return [];
		}
		if (typeof value === "string") {
			return [...value];
		}
		if (Array.isArray(value)) {
			return value.slice();
		}
		const sequence = core.seq(value);
		if (sequence === null || sequence === undefined) {
			return [];
		}
		const items = [];
		for (const item of sequence) {
			if (items.length >= MAX_MATERIALIZED_ITEMS) {
				fail("LIMIT_EXCEEDED", "sequence exceeds the materialization limit", {
					limit: MAX_MATERIALIZED_ITEMS,
					reason: "lazy-or-infinite-sequence",
				});
			}
			items.push(item);
		}
		return items;
	};

	const vectorFromArray = (items) => {
		let vector = core.vector();
		for (const item of items) {
			vector = core.conj(vector, item);
		}
		return vector;
	};

	const listFromArray = (items) => {
		let list = core.list();
		for (let index = items.length - 1; index >= 0; index -= 1) {
			list = core.conj(list, items[index]);
		}
		return list;
	};

	const mapFromEntries = (entries) => {
		let map = core.hash_map();
		for (const [key, value] of entries) {
			map = core.assoc(map, key, value);
		}
		return map;
	};

	const setFromArray = (items) => {
		let set = core.hash_set();
		for (const item of items) {
			set = core.conj(set, item);
		}
		return set;
	};

	const mapEntries = (map) => {
		const entries = [];
		for (const entry of seqToArray(map)) {
			entries.push(seqToArray(entry));
		}
		return entries;
	};

	return Object.freeze({
		cherry,
		core,
		string: cherry.string,
		set: cherry.set,
		walk: cherry.walk,
		seqToArray,
		vectorFromArray,
		listFromArray,
		mapFromEntries,
		mapEntries,
		setFromArray,
		emptyMap: () => core.hash_map(),
		emptySet: () => core.hash_set(),
		keyword: (name) => core.keyword(name),
		symbol: (name) => core.symbol(name),
		isKeyword: (value) => core.keyword_QMARK_(value),
		isSymbol: (value) => core.symbol_QMARK_(value),
		isVector: (value) => core.vector_QMARK_(value),
		isMap: (value) => core.map_QMARK_(value),
		isSet: (value) => core.set_QMARK_(value),
		isList: (value) => core.list_QMARK_(value),
		isColl: (value) => core.coll_QMARK_(value),
		equals: (left, right) => core._EQ_(left, right),
		get: (...args) => (args.length === 3 ? core.get(args[0], args[1], args[2]) : core.get(args[0], args[1])),
		assoc: (coll, key, value) => core.assoc(coll, key, value),
		conj: (coll, value) => core.conj(coll, value),
		name: (value) => core.name(value),
		namespace: (value) => core.namespace(value),
	});
}

/*
 * Load the data runtime once at module evaluation. H0 caches the Cherry
 * modules, so this does not duplicate state; it removes the only await before
 * a program is registered, which keeps an immediate AbortSignal meaningful.
 * A missing Cherry stays DATA === null and every run fails closed later.
 */
const INITIAL_CHERRY = await loadCherry();
if (INITIAL_CHERRY.ok) {
	DATA = makeDataRuntime(INITIAL_CHERRY.cherry);
}

/** Program states from AGENTS.md §4.4.2. */
const RUNNING = "running";
const WAITING = "waiting";
const PARKED = "parked";
const COMPLETED = "completed";
const FAILED = "failed";
const ACTIVE_STATES = new Set([RUNNING, WAITING, PARKED]);

/** Capabilities implemented by the evaluator itself, not by a caller port. */
const INTERNAL_CAPABILITIES = new Set(["park", "unpark", "where", "whereAll"]);

/** Capability names that read the filesystem and therefore join the read-set. */
const READ_CAPABILITIES = new Set(["cat", "stat"]);

/** Capability names that stage a write in the caller's VFS. */
const WRITE_CAPABILITIES = new Set(["write", "mkdir", "rm", "mv"]);

/**
 * Symbols that must never resolve, even if a caller accidentally lists them.
 * A ClojureScript program has no path to the JavaScript global object.
 */
const DENIED_SYMBOLS = new Set([
	"eval",
	"read-string",
	"load-string",
	"load-file",
	"load",
	"resolve",
	"set!",
	"aget",
	"aset",
	"js*",
	"js-await",
	"import",
	"require",
	"process",
	"Bun",
	"Deno",
	"globalThis",
	"window",
	"document",
	"fetch",
	"XMLHttpRequest",
	"WebSocket",
	"Function",
	"eval",
	"constructor",
	"__proto__",
	"prototype",
	"this",
	"super",
	"new",
	"ns",
	"in-ns",
	"refer",
	"use",
	"alias",
	"compile",
]);

const DENIED_NAMESPACES = new Set(["js", "goog"]);

/** Special forms recognized by the machine. */
const SPECIAL_FORMS = new Set([
	"defprogram",
	"quote",
	"if",
	"do",
	"let",
	"loop",
	"recur",
	"fn",
	"def",
	"when",
	"cond",
	"and",
	"or",
	"doseq",
	"when-let",
	"if-let",
	"letfn",
	"for",
	"throw",
	"comment",
	"try",
]);

const HOF_NAMES = new Set([
	"map",
	"mapv",
	"mapcat",
	"filterv",
	"keep",
	"filter",
	"remove",
	"reduce",
	"some",
	"every?",
	"not-any?",
	"not-every?",
	"apply",
	"clojure.walk/postwalk",
	"clojure.walk/prewalk",
	"clojure.walk/walk",
	"clojure.set/walk",
	"update",
	"map-indexed",
	"keep-indexed",
	"group-by",
	"take-while",
	"drop-while",
	"sort-by",
	"clojure.set/select",
	"clojure.string/replace",
	"clojure.string/replace-first",
	"reduce-kv",
	"reductions",
	"partition-by",
	"split-with",
	"tree-seq",
	"run!",
	"trampoline",
	"transduce",
	"sequence",
	"eduction",
	"into",
]);

/**
 * Interned keyword cache. Both the reader and capability results pass through
 * this cache so that keyword identity is stable enough for JavaScript maps.
 */
const KEYWORD_CACHE = new Map();

function EDN_K(name) {
	let keyword = KEYWORD_CACHE.get(name);
	if (keyword === undefined) {
		keyword = new EdnKeyword(name);
		KEYWORD_CACHE.set(name, keyword);
	}
	return keyword;
}

function V(name) {
	return data().keyword(name);
}

/** True when `value` carries the shared herd error vocabulary. */
export function isSandboxError(value) {
	return isHerdError(value);
}

function normalizeCode(code) {
	if (code instanceof EdnKeyword) {
		return code.name;
	}
	if (typeof code === "string") {
		return code.startsWith(":") ? code.slice(1) : code;
	}
	return "INVALID_ARGUMENT";
}

function fail(code, message, data = {}, cause) {
	const name = normalizeCode(code);
	const safeCode = Object.hasOwn(ERROR_CODES, name) ? name : "INVALID_ARGUMENT";
	const safeData = isPlainObject(data) ? data : { value: data };
	throw herdError(safeCode, message, safeData, cause);
}

function arity(name, args, minimum, maximum = minimum) {
	if (args.length < minimum || args.length > maximum) {
		fail(
			"INVALID_ARGUMENT",
			`${name} expects ${minimum === maximum ? minimum : `${minimum}..${maximum}`} argument(s)`,
			{ function: name, got: args.length },
		);
	}
}

function isThenable(value) {
	return value !== null && typeof value === "object" && typeof value.then === "function";
}

function isPlainObject(value) {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isAstVector(value) {
	return Array.isArray(value) && !(value instanceof EdnList);
}

function isUnboundedRange(value) {
	return (
		value !== null &&
		typeof value === "object" &&
		value.end === Number.MAX_VALUE &&
		typeof value.start === "number" &&
		typeof value.step === "number" &&
		"chunk" in value
	);
}

function truthy(value) {
	return value !== null && value !== false;
}

function cljEquals(left, right) {
	if (left === right) {
		return true;
	}
	if (left === null || right === null || left === undefined || right === undefined) {
		return false;
	}
	if (isLazySeqValue(left) || isLazySeqValue(right)) {
		if (!isSequentialCollValue(left) || !isSequentialCollValue(right)) {
			return false;
		}
		const leftItems = seqToArray(left);
		const rightItems = seqToArray(right);
		return (
			leftItems.length === rightItems.length && leftItems.every((item, index) => cljEquals(item, rightItems[index]))
		);
	}
	return data().equals(left, right);
}

function sameArguments(left, right) {
	if (left.length !== right.length) {
		return false;
	}
	for (let index = 0; index < left.length; index += 1) {
		if (!cljEquals(left[index], right[index])) {
			return false;
		}
	}
	return true;
}

function isLazySeqValue(value) {
	return (
		DATA?.isColl(value) && !DATA.isMap(value) && !DATA.isSet(value) && !DATA.isVector(value) && !DATA.isList(value)
	);
}

function containsLazySeq(value, seen = new WeakSet(), depth = 0) {
	if (depth > 100 || value === null || typeof value !== "object") {
		return false;
	}
	if (isLazySeqValue(value)) {
		return true;
	}
	if (seen.has(value)) {
		return false;
	}
	seen.add(value);
	if (DATA?.isMap(value)) {
		return DATA.mapEntries(value).some(
			([key, entry]) => containsLazySeq(key, seen, depth + 1) || containsLazySeq(entry, seen, depth + 1),
		);
	}
	if (DATA?.isColl(value) || Array.isArray(value)) {
		return seqToArray(value).some((item) => containsLazySeq(item, seen, depth + 1));
	}
	if (isPlainObject(value)) {
		return Object.values(value).some((entry) => containsLazySeq(entry, seen, depth + 1));
	}
	return false;
}

function isSequentialCollValue(value) {
	return DATA?.isColl(value) && !DATA.isMap(value) && !DATA.isSet(value);
}

const MISSING = Symbol("missing");

function mapGet(map, key, notFound = null) {
	return data().get(map, key, notFound);
}

function mapAssoc(map, key, value) {
	return data().assoc(map, key, value);
}

function seqToArray(value) {
	if (isEduction(value)) {
		fail("CAPABILITY_DENIED", "eduction must be consumed by into, transduce, sequence, vec, count, or first", {
			reason: "eduction-requires-lazy-consumer",
		});
	}
	if (isLazyStream(value)) {
		fail("CAPABILITY_DENIED", "lazy stream must be consumed with take/vec/count/into/doall", {
			reason: "lazy-stream-requires-machine-consumer",
		});
	}
	return data().seqToArray(value);
}

function nthOf(value, index, notFound = MISSING) {
	const items = seqToArray(value);
	if (!Number.isInteger(index) || index < 0) {
		fail("INVALID_ARGUMENT", "nth index must be a non-negative integer", { index });
	}
	if (index >= items.length) {
		if (notFound !== MISSING) {
			return notFound;
		}
		fail("INVALID_ARGUMENT", "nth index is out of bounds", { index, count: items.length });
	}
	return items[index];
}

function stringify(value) {
	if (value === null || value === undefined) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (DATA?.isKeyword(value)) {
		const namespace = DATA.namespace(value);
		const name = DATA.name(value);
		return namespace === null || namespace === undefined ? `:${name}` : `:${namespace}/${name}`;
	}
	if (DATA?.isSymbol(value)) {
		const namespace = DATA.namespace(value);
		const name = DATA.name(value);
		return namespace === null || namespace === undefined ? name : `${namespace}/${name}`;
	}
	if (value instanceof EdnKeyword) {
		return `:${value.name}`;
	}
	if (value instanceof EdnSymbol) {
		return value.name;
	}
	return safePrStr(value);
}

function safePrStr(value) {
	try {
		return printUfss(ednSafe(value));
	} catch (error) {
		if (isHerdError(error)) {
			throw error;
		}
		if (value && typeof value === "object" && value.kind === "fn") {
			return "#<function>";
		}
		return "#<object>";
	}
}

function ednSafe(value, seen = new WeakSet()) {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return value;
	}
	if (typeof value === "bigint") {
		return value;
	}
	if (DATA?.isKeyword(value)) {
		const namespace = DATA.namespace(value);
		const name = DATA.name(value);
		return new EdnKeyword(namespace === null || namespace === undefined ? name : `${namespace}/${name}`);
	}
	if (DATA?.isSymbol(value)) {
		const namespace = DATA.namespace(value);
		const name = DATA.name(value);
		return new EdnSymbol(namespace === null || namespace === undefined ? name : `${namespace}/${name}`);
	}
	if (DATA?.isVector(value)) {
		return seqToArray(value).map((item) => ednSafe(item, seen));
	}
	if (DATA?.isList(value)) {
		const result = new EdnList();
		for (const item of seqToArray(value)) {
			result.push(ednSafe(item, seen));
		}
		return result;
	}
	if (DATA?.isMap(value)) {
		let result = new Map();
		for (const [key, entry] of DATA.mapEntries(value)) {
			result = mapAssocEdn(result, ednSafe(key, seen), ednSafe(entry, seen));
		}
		return result;
	}
	if (DATA?.isSet(value)) {
		const result = new Set();
		for (const item of seqToArray(value)) {
			result.add(ednSafe(item, seen));
		}
		return result;
	}
	if (DATA?.isColl(value)) {
		return seqToArray(value).map((item) => ednSafe(item, seen));
	}
	if (value instanceof EdnKeyword) {
		return EDN_K(value.name);
	}
	if (value instanceof EdnSymbol) {
		return value;
	}
	if (value instanceof EdnList) {
		const result = new EdnList();
		for (const item of value) {
			result.push(ednSafe(item, seen));
		}
		return result;
	}
	if (Array.isArray(value)) {
		return value.map((item) => ednSafe(item, seen));
	}
	if (value instanceof Set) {
		const result = new Set();
		for (const item of value) {
			result.add(ednSafe(item, seen));
		}
		return result;
	}
	if (value instanceof Map) {
		let result = new Map();
		for (const [key, entry] of value) {
			const normalizedKey = typeof key === "string" ? (ednKey(key) ?? key) : ednSafe(key, seen);
			result = mapAssocEdn(result, normalizedKey, ednSafe(entry, seen));
		}
		return result;
	}
	if (isPlainObject(value)) {
		if (seen.has(value)) {
			return null;
		}
		seen.add(value);
		const result = new Map();
		for (const [key, entry] of Object.entries(value)) {
			result.set(ednKey(key) ?? key, ednSafe(entry, seen));
		}
		seen.delete(value);
		return result;
	}
	if (value instanceof RegExp) {
		return String(value);
	}
	return null;
}

function mapAssocEdn(map, key, value) {
	const next = new Map(map);
	for (const candidate of next.keys()) {
		if (candidate instanceof EdnKeyword && key instanceof EdnKeyword && candidate.name === key.name) {
			next.delete(candidate);
		}
	}
	next.set(key, value);
	return next;
}

function isSafeKeywordName(name) {
	return /^[A-Za-z0-9*+!_?<>=.-]+(?:\/[A-Za-z0-9*+!_?<>=.-]+)?$/.test(name) && !name.endsWith("/");
}

function runtimeKey(key) {
	if (typeof key !== "string") {
		return null;
	}
	const name = key.startsWith(":") ? key.slice(1) : key;
	return isSafeKeywordName(name) ? V(name) : null;
}

function ednKey(key) {
	if (typeof key !== "string") {
		return null;
	}
	const name = key.startsWith(":") ? key.slice(1) : key;
	return isSafeKeywordName(name) ? EDN_K(name) : null;
}

function normalizeResult(value, seen = new WeakSet()) {
	if (value === undefined) {
		return null;
	}
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return value;
	}
	if (typeof value === "bigint") {
		return value;
	}
	if (DATA?.isKeyword(value)) {
		return value;
	}
	if (DATA?.isSymbol(value)) {
		return value;
	}
	if (DATA?.isVector(value)) {
		return DATA.vectorFromArray(seqToArray(value).map((item) => normalizeResult(item, seen)));
	}
	if (DATA?.isList(value)) {
		return DATA.listFromArray(seqToArray(value).map((item) => normalizeResult(item, seen)));
	}
	if (DATA?.isMap(value)) {
		return DATA.mapFromEntries(
			DATA.mapEntries(value).map(([key, entry]) => [normalizeResult(key, seen), normalizeResult(entry, seen)]),
		);
	}
	if (DATA?.isSet(value)) {
		return DATA.setFromArray(seqToArray(value).map((item) => normalizeResult(item, seen)));
	}
	if (DATA?.isColl(value)) {
		return DATA.vectorFromArray(seqToArray(value).map((item) => normalizeResult(item, seen)));
	}
	if (value instanceof EdnKeyword) {
		return V(value.name);
	}
	if (value instanceof EdnSymbol) {
		return data().symbol(value.name);
	}
	if (value instanceof EdnList) {
		return DATA.listFromArray(value.map((item) => normalizeResult(item, seen)));
	}
	if (Array.isArray(value)) {
		return DATA.vectorFromArray(value.map((item) => normalizeResult(item, seen)));
	}
	if (value instanceof Set) {
		return DATA.setFromArray([...value].map((item) => normalizeResult(item, seen)));
	}
	if (value instanceof Map) {
		return DATA.mapFromEntries(
			[...value.entries()].map(([key, entry]) => [
				typeof key === "string" ? (runtimeKey(key) ?? key) : normalizeResult(key, seen),
				normalizeResult(entry, seen),
			]),
		);
	}
	if (isPlainObject(value)) {
		if (seen.has(value)) {
			fail("CAPABILITY_DENIED", "Capability returned a cyclic object", { reason: "non-edn-result" });
		}
		seen.add(value);
		const result = DATA.mapFromEntries(
			Object.entries(value).map(([key, entry]) => [runtimeKey(key) ?? key, normalizeResult(entry, seen)]),
		);
		seen.delete(value);
		return result;
	}
	fail("CAPABILITY_DENIED", "Capability returned a non-EDN value", { reason: "non-edn-result" });
}

const FAILURE_STATUSES = new Set(["rejected", "uncertain", "cancelled"]);

function statusName(value) {
	if (DATA?.isKeyword(value)) {
		return DATA.name(value);
	}
	if (value instanceof EdnKeyword) {
		return value.name;
	}
	if (typeof value === "string") {
		return value.startsWith(":") ? value.slice(1) : value;
	}
	return null;
}

function isFailureEnvelope(value) {
	if (DATA?.isMap(value)) {
		return mapGet(value, V("ok")) === false || FAILURE_STATUSES.has(statusName(mapGet(value, V("status"), null)));
	}
	return isPlainObject(value) && (value.ok === false || FAILURE_STATUSES.has(statusName(value.status)));
}

function failureData(value) {
	if (DATA?.isMap(value)) {
		const error = mapGet(value, V("error"), value);
		const status = statusName(mapGet(value, V("status"), null));
		const fallbackCode =
			status === "uncertain" ? "BOARD_CONFLICT" : status === "cancelled" ? "STALE_CONTROL" : "PREPARE_REJECTED";
		return {
			code: normalizeCode(mapGet(error, V("code"), mapGet(value, V("code"), fallbackCode))),
			message: stringify(mapGet(error, V("message"), mapGet(value, V("message"), "capability failed"))),
			data: mapGet(
				error,
				V("data"),
				mapGet(value, V("data"), {
					status,
					conflicts: mapGet(value, V("conflicts"), []),
				}),
			),
		};
	}
	const error = value?.error;
	const status = statusName(value?.status);
	const fallbackCode =
		status === "uncertain" ? "BOARD_CONFLICT" : status === "cancelled" ? "STALE_CONTROL" : "PREPARE_REJECTED";
	return {
		code: normalizeCode(error?.code ?? value?.code ?? fallbackCode),
		message: stringify(error?.message ?? value?.message ?? "capability failed"),
		data: error?.data ?? value?.data ?? { status, conflicts: value?.conflicts ?? [] },
	};
}

function checkFailureEnvelope(value) {
	if (isFailureEnvelope(value)) {
		const failure = failureData(value);
		fail(failure.code, failure.message, failure.data);
	}
}

/** Persistent lexical environment. */
class Environment {
	constructor(parent) {
		this.parent = parent;
		this.bindings = new Map();
	}
}

function envGet(environment, name) {
	for (let current = environment; current !== null; current = current.parent) {
		if (current.bindings.has(name)) {
			return current.bindings.get(name);
		}
	}
	return MISSING;
}

function extendEnvironment(parent, entries) {
	const environment = new Environment(parent);
	for (const [name, value] of entries) {
		environment.bindings.set(name, value);
	}
	return environment;
}

function patternHasDefaults(pattern) {
	if (pattern instanceof EdnSymbol) {
		return false;
	}
	if (isAstVector(pattern)) {
		for (let index = 0; index < pattern.length; index += 1) {
			const item = pattern[index];
			if (item instanceof EdnKeyword && item.name === "as") {
				index += 1;
				if (patternHasDefaults(pattern[index])) {
					return true;
				}
				continue;
			}
			if (item instanceof EdnSymbol && item.name === "&") {
				index += 1;
				if (patternHasDefaults(pattern[index])) {
					return true;
				}
				continue;
			}
			if (patternHasDefaults(item)) {
				return true;
			}
		}
		return false;
	}
	if (pattern instanceof Map) {
		for (const [entryKey, entryValue] of pattern) {
			if (entryKey instanceof EdnKeyword) {
				if (entryKey.name === "or") {
					return true;
				}
				if (entryKey.name === "keys" || entryKey.name === "strs" || entryKey.name === "syms") {
					continue;
				}
				if (entryKey.name === "as") {
					if (patternHasDefaults(entryValue)) {
						return true;
					}
				}
				continue;
			}
			if (patternHasDefaults(entryKey)) {
				return true;
			}
		}
		return false;
	}
	return false;
}

function bindPattern(pattern, value, environment) {
	if (pattern instanceof EdnSymbol) {
		return extendEnvironment(environment, [[pattern.name, value]]);
	}
	if (isAstVector(pattern)) {
		const items = value === null || value === undefined ? [] : seqToArray(value);
		let environmentWithBindings = environment;
		let cursor = 0;
		for (let index = 0; index < pattern.length; index += 1) {
			const subPattern = pattern[index];
			if (subPattern instanceof EdnKeyword && subPattern.name === "as") {
				index += 1;
				environmentWithBindings = bindPattern(pattern[index], value, environmentWithBindings);
				continue;
			}
			if (subPattern instanceof EdnSymbol && subPattern.name === "&") {
				index += 1;
				environmentWithBindings = bindPattern(
					pattern[index],
					data().listFromArray(items.slice(cursor)),
					environmentWithBindings,
				);
				cursor = items.length;
				continue;
			}
			environmentWithBindings = bindPattern(
				subPattern,
				cursor < items.length ? items[cursor] : null,
				environmentWithBindings,
			);
			cursor += 1;
		}
		return environmentWithBindings;
	}
	if (pattern instanceof Map) {
		let environmentWithBindings = environment;
		for (const [entryKey, entryValue] of pattern) {
			if (entryKey instanceof EdnKeyword) {
				if (entryKey.name === "or") {
					continue;
				}
				if (entryKey.name === "keys" || entryKey.name === "strs" || entryKey.name === "syms") {
					for (const symbol of seqToArray(entryValue)) {
						if (!(symbol instanceof EdnSymbol)) {
							fail("INVALID_ARGUMENT", "Destructuring names must be symbols", { key: entryKey.name });
						}
						const lookup =
							entryKey.name === "keys"
								? V(symbol.name)
								: entryKey.name === "strs"
									? symbol.name
									: data().symbol(symbol.name);
						environmentWithBindings = bindPattern(symbol, mapGet(value, lookup, null), environmentWithBindings);
					}
					continue;
				}
				if (entryKey.name === "as") {
					environmentWithBindings = bindPattern(entryValue, value, environmentWithBindings);
					continue;
				}
				fail("INVALID_ARGUMENT", "Unsupported map destructuring key", { key: safePrStr(entryKey) });
			}
			environmentWithBindings = bindPattern(
				entryKey,
				mapGet(value, astToValue(entryValue), null),
				environmentWithBindings,
			);
		}
		return environmentWithBindings;
	}
	fail("INVALID_ARGUMENT", "Unsupported binding pattern", { pattern: safePrStr(pattern) });
}

/**
 * Bind a pattern with support for asynchronous :or defaults. Default forms are
 * evaluated with the existing CEK only when the key is absent, in binding
 * order, in the environment that already contains earlier bindings.
 */
function bindPatternAsync(pattern, value, environment, state, resume) {
	if (!patternHasDefaults(pattern)) {
		resume(bindPattern(pattern, value, environment), state);
		return;
	}
	if (pattern instanceof EdnSymbol) {
		resume(extendEnvironment(environment, [[pattern.name, value]]), state);
		return;
	}
	if (isAstVector(pattern)) {
		const items = value === null || value === undefined ? [] : seqToArray(value);
		const steps = [];
		let cursor = 0;
		for (let index = 0; index < pattern.length; index += 1) {
			const item = pattern[index];
			if (item instanceof EdnKeyword && item.name === "as") {
				index += 1;
				steps.push({ target: pattern[index], value });
				continue;
			}
			if (item instanceof EdnSymbol && item.name === "&") {
				index += 1;
				steps.push({ target: pattern[index], value: data().listFromArray(items.slice(cursor)) });
				cursor = items.length;
				continue;
			}
			steps.push({ target: item, value: cursor < items.length ? items[cursor] : null });
			cursor += 1;
		}
		let current = environment;
		let index = 0;
		const next = (currentState) => {
			while (index < steps.length) {
				const step = steps[index];
				index += 1;
				bindPatternAsync(step.target, step.value, current, currentState, (nextEnvironment, nextState) => {
					current = nextEnvironment;
					next(nextState);
				});
				return;
			}
			resume(current, currentState);
		};
		next(state);
		return;
	}
	if (pattern instanceof Map) {
		bindMapPatternAsync(pattern, value, environment, state, resume);
		return;
	}
	fail("INVALID_ARGUMENT", "Unsupported binding pattern", { pattern: safePrStr(pattern) });
}

function bindMapPatternAsync(pattern, value, environment, state, resume) {
	const defaults = new Map();
	for (const [entryKey, entryValue] of pattern) {
		if (entryKey instanceof EdnKeyword && entryKey.name === "or") {
			for (const [symbol, form] of entryValue) {
				if (!(symbol instanceof EdnSymbol)) {
					fail("INVALID_ARGUMENT", "Destructuring :or keys must be symbols", { key: safePrStr(symbol) });
				}
				defaults.set(symbol.name, form);
			}
		}
	}
	const steps = [];
	for (const [entryKey, entryValue] of pattern) {
		if (entryKey instanceof EdnKeyword) {
			if (entryKey.name === "or") {
				continue;
			}
			if (entryKey.name === "keys" || entryKey.name === "strs" || entryKey.name === "syms") {
				for (const symbol of seqToArray(entryValue)) {
					if (!(symbol instanceof EdnSymbol)) {
						fail("INVALID_ARGUMENT", "Destructuring names must be symbols", { key: entryKey.name });
					}
					const lookup =
						entryKey.name === "keys"
							? V(symbol.name)
							: entryKey.name === "strs"
								? symbol.name
								: data().symbol(symbol.name);
					steps.push({ target: symbol, lookup });
				}
				continue;
			}
			if (entryKey.name === "as") {
				steps.push({ target: entryValue, whole: true });
				continue;
			}
			fail("INVALID_ARGUMENT", "Unsupported map destructuring key", { key: safePrStr(entryKey) });
		}
		steps.push({ target: entryKey, lookup: astToValue(entryValue) });
	}
	let current = environment;
	let index = 0;
	const next = (currentState) => {
		while (index < steps.length) {
			const step = steps[index];
			index += 1;
			if (step.whole) {
				bindPatternAsync(step.target, value, current, currentState, (nextEnvironment, nextState) => {
					current = nextEnvironment;
					next(nextState);
				});
				return;
			}
			const found = mapGet(value, step.lookup, MISSING);
			const name = step.target instanceof EdnSymbol ? step.target.name : null;
			if (found !== MISSING) {
				bindPatternAsync(step.target, found, current, currentState, (nextEnvironment, nextState) => {
					current = nextEnvironment;
					next(nextState);
				});
				return;
			}
			if (name !== null && defaults.has(name)) {
				currentState.kont.push({
					type: "lazyCapture",
					resume: (resolved, nextState) => {
						bindPatternAsync(step.target, resolved, current, nextState, (nextEnvironment, finalState) => {
							current = nextEnvironment;
							next(finalState);
						});
					},
				});
				evalForm(currentState, defaults.get(name), current);
				return;
			}
			bindPatternAsync(step.target, null, current, currentState, (nextEnvironment, nextState) => {
				current = nextEnvironment;
				next(nextState);
			});
			return;
		}
		resume(current, currentState);
	};
	next(state);
}

function bindAllAsync(patterns, values, environment, state, resume) {
	if (patterns.length !== values.length) {
		fail("INVALID_ARGUMENT", "Binding arity does not match", {
			expected: patterns.length,
			got: values.length,
		});
	}
	let current = environment;
	let index = 0;
	const next = (currentState) => {
		while (index < patterns.length) {
			const pattern = patterns[index];
			const value = values[index];
			index += 1;
			bindPatternAsync(pattern, value, current, currentState, (nextEnvironment, nextState) => {
				current = nextEnvironment;
				next(nextState);
			});
			return;
		}
		resume(current, currentState);
	};
	next(state);
}

function bindParamsAsync(params, args, environment, state, resume) {
	let fixed = params;
	let rest = null;
	const ampersand = params.findIndex((param) => param instanceof EdnSymbol && param.name === "&");
	if (ampersand !== -1) {
		fixed = params.slice(0, ampersand);
		if (ampersand + 1 >= params.length) {
			fail("INVALID_ARGUMENT", "& must be followed by a binding pattern");
		}
		rest = params[ampersand + 1];
	}
	if (rest === null && args.length !== fixed.length) {
		fail("INVALID_ARGUMENT", "Function arity does not match", {
			expected: fixed.length,
			got: args.length,
		});
	}
	if (rest !== null && args.length < fixed.length) {
		fail("INVALID_ARGUMENT", "Function arity does not match", {
			expected: `at least ${fixed.length}`,
			got: args.length,
		});
	}
	const patterns = fixed.slice();
	const values = args.slice(0, fixed.length);
	if (rest !== null) {
		patterns.push(rest);
		values.push(data().listFromArray(args.slice(fixed.length)));
	}
	bindAllAsync(patterns, values, environment, state, resume);
}

function acceptsParams(params, count) {
	const ampersand = params.findIndex((param) => param instanceof EdnSymbol && param.name === "&");
	if (ampersand === -1) {
		return count === params.length;
	}
	return count >= ampersand;
}

function collectPatternSymbols(pattern, into) {
	if (pattern instanceof EdnSymbol) {
		into.add(pattern.name);
		return;
	}
	if (isAstVector(pattern)) {
		for (let index = 0; index < pattern.length; index += 1) {
			const item = pattern[index];
			if (item instanceof EdnSymbol && item.name === "&") {
				index += 1;
				collectPatternSymbols(pattern[index], into);
				continue;
			}
			if (item instanceof EdnKeyword && item.name === "as") {
				index += 1;
				collectPatternSymbols(pattern[index], into);
				continue;
			}
			collectPatternSymbols(item, into);
		}
		return;
	}
	if (pattern instanceof Map) {
		for (const [key, target] of pattern) {
			if (key instanceof EdnKeyword) {
				if (key.name === "or") {
					continue;
				}
				if (key.name === "keys" || key.name === "strs" || key.name === "syms") {
					for (const symbol of seqToArray(target)) {
						collectPatternSymbols(symbol, into);
					}
					continue;
				}
				if (key.name === "as") {
					collectPatternSymbols(target, into);
				}
				continue;
			}
			collectPatternSymbols(key, into);
		}
		return;
	}
	fail("INVALID_ARGUMENT", "Unsupported binding pattern", { pattern: safePrStr(pattern) });
}

function expandThread(form, last) {
	if (form.length < 2) {
		fail("INVALID_ARGUMENT", "Threading macro needs an initial value");
	}
	let accumulated = form[1];
	for (let index = 2; index < form.length; index += 1) {
		const step = form[index];
		const next = new EdnList();
		if (step instanceof EdnList) {
			if (step.length === 0) {
				fail("INVALID_ARGUMENT", "Threading macro step cannot be an empty list");
			}
			next.push(step[0]);
			if (last) {
				next.push(...step.slice(1), accumulated);
			} else {
				next.push(accumulated, ...step.slice(1));
			}
		} else if (last) {
			next.push(step, accumulated);
		} else {
			next.push(step, accumulated);
		}
		accumulated = next;
	}
	return accumulated;
}

function listForm(...items) {
	const form = new EdnList();
	form.push(...items);
	return form;
}

function symbolForm(name) {
	return new EdnSymbol(name);
}

function keywordForm(name) {
	return new EdnKeyword(name);
}

let macroSymbolCounter = 0;

function freshSymbol(prefix) {
	macroSymbolCounter += 1;
	return symbolForm(`${prefix}__${macroSymbolCounter}__auto__`);
}

function expandDefn(form, isPrivate) {
	if (!(form[1] instanceof EdnSymbol)) {
		fail("INVALID_ARGUMENT", "defn needs a symbol name");
	}
	let index = 2;
	let doc = null;
	if (typeof form[index] === "string") {
		doc = form[index];
		index += 1;
	}
	let attr = form[index] instanceof Map ? form[index++] : null;
	if (index >= form.length) {
		fail("INVALID_ARGUMENT", "defn needs at least one arity");
	}
	const fnForm = new EdnList();
	fnForm.push(new EdnSymbol("fn"), form[1]);
	if (isAstVector(form[index])) {
		for (; index < form.length; index += 1) {
			fnForm.push(form[index]);
		}
	} else {
		let end = form.length;
		if (attr === null && form[end - 1] instanceof Map) {
			attr = form[end - 1];
			end -= 1;
		}
		for (; index < end; index += 1) {
			const arity = form[index];
			if (!(arity instanceof EdnList) || arity.length === 0) {
				fail("INVALID_ARGUMENT", "defn arities must be lists");
			}
			fnForm.push(arity);
		}
	}
	const metadata = new Map();
	if (doc !== null) {
		metadata.set(keywordForm("doc"), doc);
	}
	if (attr !== null) {
		for (const [key, value] of attr) {
			metadata.set(key, value);
		}
	}
	if (isPrivate) {
		metadata.set(keywordForm("private"), true);
	}
	const valueForm =
		metadata.size === 0 ? fnForm : listForm(symbolForm("with-meta"), fnForm, listForm(symbolForm("quote"), metadata));
	return listForm(symbolForm("def"), form[1], valueForm);
}

function expandWhenNot(form) {
	if (form.length < 2) {
		fail("INVALID_ARGUMENT", "when-not needs a test");
	}
	return listForm(symbolForm("if"), form[1], null, listForm(symbolForm("do"), ...form.slice(2)));
}

function expandIfNot(form) {
	if (form.length < 3 || form.length > 4) {
		fail("INVALID_ARGUMENT", "if-not expects a test, a then branch, and an optional else branch", {
			got: form.length - 1,
		});
	}
	return form.length === 3
		? listForm(symbolForm("if"), form[1], null, form[2])
		: listForm(symbolForm("if"), form[1], form[3], form[2]);
}

function expandSomeBinding(form, name, hasElse) {
	const binding = form[1];
	if (!isAstVector(binding) || binding.length !== 2) {
		fail("INVALID_ARGUMENT", `${name} needs a two-element binding vector`);
	}
	if (form.length < 3) {
		fail("INVALID_ARGUMENT", `${name} needs a body`);
	}
	if (hasElse && form.length > 4) {
		fail("INVALID_ARGUMENT", "if-some accepts one then branch and one else branch");
	}
	const temporary = freshSymbol("some");
	const thenForm = hasElse ? form[2] : listForm(symbolForm("do"), ...form.slice(2));
	const elseForm = hasElse && form.length === 4 ? form[3] : null;
	return listForm(
		symbolForm("let"),
		[temporary, binding[1]],
		listForm(
			symbolForm("if"),
			listForm(symbolForm("nil?"), temporary),
			elseForm,
			listForm(symbolForm("let"), [binding[0], temporary], thenForm),
		),
	);
}

function expandCondArrow(form) {
	if (form.length < 2) {
		fail("INVALID_ARGUMENT", "cond-> needs an initial value");
	}
	if ((form.length - 2) % 2 !== 0) {
		fail("INVALID_ARGUMENT", "cond-> needs test/form pairs");
	}
	const temporary = freshSymbol("cond");
	const bindings = [temporary, form[1]];
	for (let index = 2; index < form.length; index += 2) {
		bindings.push(
			temporary,
			listForm(symbolForm("if"), form[index], listForm(symbolForm("->"), temporary, form[index + 1]), temporary),
		);
	}
	return listForm(symbolForm("let"), bindings, temporary);
}

function expandSomeArrow(form) {
	if (form.length < 2) {
		fail("INVALID_ARGUMENT", "some-> needs an initial value");
	}
	const temporary = freshSymbol("some");
	const bindings = [temporary, form[1]];
	for (let index = 2; index < form.length; index += 1) {
		bindings.push(
			temporary,
			listForm(
				symbolForm("if"),
				listForm(symbolForm("nil?"), temporary),
				temporary,
				listForm(symbolForm("->"), temporary, form[index]),
			),
		);
	}
	return listForm(symbolForm("let"), bindings, temporary);
}

function expandAsArrow(form) {
	if (form.length < 3) {
		fail("INVALID_ARGUMENT", "as-> needs an expression and a binding name");
	}
	if (!(form[2] instanceof EdnSymbol)) {
		fail("INVALID_ARGUMENT", "as-> binding must be a symbol");
	}
	const name = form[2];
	const bindings = [name, form[1]];
	for (let index = 3; index < form.length; index += 1) {
		bindings.push(name, form[index]);
	}
	return listForm(symbolForm("let"), bindings, name);
}

function expandWhenFirst(form) {
	const binding = form[1];
	if (!isAstVector(binding) || binding.length !== 2) {
		fail("INVALID_ARGUMENT", "when-first needs a two-element binding vector");
	}
	return listForm(
		symbolForm("when"),
		listForm(symbolForm("seq"), binding[1]),
		listForm(symbolForm("let"), [binding[0], listForm(symbolForm("first"), binding[1])], ...form.slice(2)),
	);
}

function expandCase(form) {
	if (form.length < 2) {
		fail("INVALID_ARGUMENT", "case needs a test expression");
	}
	const temporary = freshSymbol("case");
	const hasDefault = (form.length - 2) % 2 === 1;
	const end = hasDefault ? form.length - 1 : form.length;
	const clauses = [];
	for (let index = 2; index < end; index += 2) {
		const constant = form[index];
		const result = form[index + 1];
		const constants = constant instanceof EdnList ? [...constant] : [constant];
		for (const value of constants) {
			clauses.push(listForm(listForm(symbolForm("="), temporary, listForm(symbolForm("quote"), value)), result));
		}
	}
	const otherwise = hasDefault
		? form[form.length - 1]
		: listForm(symbolForm("throw"), listForm(symbolForm("str"), "No matching clause: ", temporary));
	return listForm(
		symbolForm("let"),
		[temporary, form[1]],
		listForm(symbolForm("cond"), ...clauses, listForm(keywordForm("else"), otherwise)),
	);
}

function expandCondp(form) {
	if (form.length < 3) {
		fail("INVALID_ARGUMENT", "condp needs a predicate, an expression, and clauses");
	}
	const predicateSymbol = freshSymbol("pred");
	const expressionSymbol = freshSymbol("expr");
	const clauses = [];
	let index = 3;
	while (index < form.length) {
		if (form.length - index === 1) {
			clauses.push({ defaultValue: form[index] });
			index += 1;
			continue;
		}
		const test = form[index];
		const maybeArrow = form[index + 1];
		if (maybeArrow instanceof EdnKeyword && maybeArrow.name === ">>") {
			if (index + 2 >= form.length) {
				fail("INVALID_ARGUMENT", "condp :>> needs a result function");
			}
			clauses.push({ test, arrow: form[index + 2] });
			index += 3;
			continue;
		}
		clauses.push({ test, result: maybeArrow });
		index += 2;
	}
	let otherwise = listForm(symbolForm("throw"), listForm(symbolForm("str"), "No matching clause: ", expressionSymbol));
	for (let clauseIndex = clauses.length - 1; clauseIndex >= 0; clauseIndex -= 1) {
		const clause = clauses[clauseIndex];
		if (clause.defaultValue !== undefined) {
			otherwise = clause.defaultValue;
			continue;
		}
		const quotedTest = listForm(symbolForm("quote"), clause.test);
		if (clause.arrow !== undefined) {
			const temporary = freshSymbol("condp");
			otherwise = listForm(
				symbolForm("let"),
				[temporary, listForm(predicateSymbol, quotedTest, expressionSymbol)],
				listForm(symbolForm("if"), temporary, listForm(clause.arrow, temporary), otherwise),
			);
			continue;
		}
		otherwise = listForm(
			symbolForm("if"),
			listForm(predicateSymbol, quotedTest, expressionSymbol),
			clause.result,
			otherwise,
		);
	}
	return listForm(symbolForm("let"), [predicateSymbol, form[1], expressionSymbol, form[2]], otherwise);
}

/**
 * `doto` threads one value through side-effecting steps and returns it. A list
 * step inserts the value after the callee; any other step calls the value's
 * expression as `(step target)`.
 */
function expandDoto(form) {
	if (form.length < 2) {
		fail("INVALID_ARGUMENT", "doto needs an initial value");
	}
	const target = freshSymbol("doto");
	const steps = [];
	for (let index = 2; index < form.length; index += 1) {
		const step = form[index];
		if (step instanceof EdnList && step.length === 0) {
			fail("INVALID_ARGUMENT", "doto step cannot be an empty list");
		}
		if (step instanceof EdnList) {
			steps.push(listForm(step[0], target, ...step.slice(1)));
		} else {
			steps.push(listForm(step, target));
		}
	}
	return listForm(symbolForm("let"), [target, form[1]], ...steps, target);
}

const EXPANDED_MACROS = new Set([
	"when-not",
	"if-not",
	"when-some",
	"if-some",
	"cond->",
	"some->",
	"as->",
	"when-first",
	"case",
	"condp",
	"doto",
]);

function expandPureMacro(name, form) {
	switch (name) {
		case "when-not":
			return expandWhenNot(form);
		case "if-not":
			return expandIfNot(form);
		case "when-some":
			return expandSomeBinding(form, "when-some", false);
		case "if-some":
			return expandSomeBinding(form, "if-some", true);
		case "cond->":
			return expandCondArrow(form);
		case "some->":
			return expandSomeArrow(form);
		case "as->":
			return expandAsArrow(form);
		case "when-first":
			return expandWhenFirst(form);
		case "case":
			return expandCase(form);
		case "condp":
			return expandCondp(form);
		case "doto":
			return expandDoto(form);
		default:
			return null;
	}
}

function parseForLevels(bindings) {
	if (!isAstVector(bindings) || bindings.length < 2 || bindings.length % 2 !== 0) {
		fail("INVALID_ARGUMENT", "for needs an even binding vector");
	}
	const levels = [];
	let level = null;
	for (let index = 0; index < bindings.length; index += 2) {
		const key = bindings[index];
		const value = bindings[index + 1];
		if (key instanceof EdnKeyword) {
			if (level === null) {
				fail("INVALID_ARGUMENT", "for modifiers must follow a binding");
			}
			if (key.name === "let") {
				if (!isAstVector(value) || value.length % 2 !== 0) {
					fail("INVALID_ARGUMENT", "for :let needs an even binding vector");
				}
				level.modifiers.push({ kind: "let", bindings: value });
				continue;
			}
			if (key.name === "when" || key.name === "while") {
				level.modifiers.push({ kind: key.name, test: value });
				continue;
			}
			fail("INVALID_ARGUMENT", `Unsupported for modifier :${key.name}`, { modifier: key.name });
		}
		level = { pattern: key, expr: value, modifiers: [] };
		levels.push(level);
	}
	if (levels.length === 0) {
		fail("INVALID_ARGUMENT", "for needs at least one binding");
	}
	return levels;
}

function looksLikeCatchClass(symbol) {
	return /^[A-Z]/.test(symbol.name) || symbol.name.includes("/") || symbol.name.includes("Error");
}

function catchParts(clause) {
	let symbolIndex = 1;
	let match = null;
	if (clause[1] instanceof EdnKeyword) {
		match = clause[1];
		symbolIndex = 2;
	} else if (clause[1] instanceof EdnSymbol && looksLikeCatchClass(clause[1])) {
		match = clause[1];
		symbolIndex = 2;
		if (!(clause[2] instanceof EdnSymbol)) {
			fail("INVALID_ARGUMENT", "catch needs a symbol binding after its class", { class: clause[1].name });
		}
	}
	return { match, symbol: clause[symbolIndex], body: clause.slice(symbolIndex + 1) };
}

function catchTypeName(match) {
	if (match === null) {
		return null;
	}
	if (match instanceof EdnKeyword) {
		return match.name;
	}
	return match.name ?? null;
}

function exceptionTypeName(value) {
	if (data().isMap(value)) {
		for (const key of ["type", "class", "code"]) {
			const field = mapGet(value, V(key), MISSING);
			if (field === MISSING || field === null) {
				continue;
			}
			if (data().isKeyword(field)) {
				return data().name(field);
			}
			if (field instanceof EdnSymbol) {
				return field.name;
			}
			if (typeof field === "string") {
				return field;
			}
		}
	}
	if (value instanceof Error && typeof value.name === "string") {
		return value.name;
	}
	return null;
}

/**
 * `:default` and a catch without a class match every thrown value. A keyword
 * class matches the thrown map's `:code`; a symbol class matches its `:type` or
 * `:class`, a thrown host error's `name`, or the original host error class
 * (`Error`, `HerdError`). `js/Error` and other namespaced classes compare by
 * their bare name.
 */
function catchMatches(match, value, error) {
	const name = catchTypeName(match);
	if (name === null || name === "default") {
		return true;
	}
	const bare = name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
	if (match instanceof EdnKeyword) {
		const actual = exceptionTypeName(value);
		return actual !== null && actual === bare;
	}
	const declared = exceptionTypeName(value);
	if (
		declared !== null &&
		(declared === bare || (declared.includes("/") && declared.slice(declared.indexOf("/") + 1) === bare))
	) {
		return true;
	}
	if (!(error instanceof ProgramThrow)) {
		if (error instanceof Error) {
			return bare === "Error" || error.name === bare;
		}
		return false;
	}
	if (value instanceof Error) {
		return bare === "Error" || value.name === bare;
	}
	return false;
}

function analyzeSymbol(symbol, scope, session) {
	const name = symbol.name;
	if (scope.has(name)) {
		return;
	}
	if (DENIED_SYMBOLS.has(name) || name.startsWith(".") || (!name.includes("/") && name.includes("."))) {
		fail("CAPABILITY_DENIED", `Symbol ${name} is not available in the sandbox`, {
			symbol: name,
			reason: "denied-symbol",
		});
	}
	if (name.includes("/")) {
		const namespace = name.slice(0, name.indexOf("/"));
		if (DENIED_NAMESPACES.has(namespace) || (!isBuiltinName(name) && !isHofName(name))) {
			fail("CAPABILITY_DENIED", `Namespace ${namespace} is not available in the sandbox`, {
				symbol: name,
				reason: "denied-namespace",
			});
		}
	}
	if (SPECIAL_FORMS.has(name)) {
		fail("CAPABILITY_DENIED", `Special form ${name} is only valid in operator position`, {
			symbol: name,
			reason: "special-form-value",
		});
	}
	if (isBuiltinName(name) || isHofName(name)) {
		return;
	}
	if (session.allowedCapabilities.has(name)) {
		return;
	}
	fail("CAPABILITY_DENIED", `Unbound symbol ${name}`, { symbol: name, reason: "unbound" });
}

function isBuiltinName(name) {
	return BUILTINS.has(name);
}

function isHofName(name) {
	return HOF_NAMES.has(name);
}

function analyzeSpecial(name, form, scope, loopDepth, session) {
	switch (name) {
		case "defprogram":
			fail("INVALID_ARGUMENT", "defprogram can only appear at the top level");
			break;
		case "quote":
			return;
		case "if": {
			if (form.length < 3 || form.length > 4) {
				fail("INVALID_ARGUMENT", "if expects a test and one or two branches", { got: form.length - 1 });
			}
			for (let index = 1; index < form.length; index += 1) {
				analyze(form[index], scope, loopDepth, session);
			}
			return;
		}
		case "do":
			for (let index = 1; index < form.length; index += 1) {
				analyze(form[index], scope, loopDepth, session);
			}
			return;
		case "let":
		case "loop": {
			const bindings = form[1];
			if (!isAstVector(bindings) || bindings.length % 2 !== 0) {
				fail("INVALID_ARGUMENT", `${name} needs an even binding vector`);
			}
			const innerScope = new Set(scope);
			for (let index = 0; index < bindings.length; index += 2) {
				analyze(bindings[index + 1], innerScope, loopDepth, session);
				collectPatternSymbols(bindings[index], innerScope);
			}
			for (let index = 2; index < form.length; index += 1) {
				analyze(form[index], innerScope, name === "loop" ? loopDepth + 1 : loopDepth, session);
			}
			return;
		}
		case "recur": {
			if (loopDepth === 0) {
				fail("INVALID_ARGUMENT", "recur is only valid inside loop");
			}
			for (let index = 1; index < form.length; index += 1) {
				analyze(form[index], scope, loopDepth, session);
			}
			return;
		}
		case "fn": {
			let index = 1;
			let fnName = null;
			if (form[1] instanceof EdnSymbol) {
				fnName = form[1].name;
				index = 2;
			}
			const arities = [];
			if (isAstVector(form[index])) {
				arities.push({ params: form[index], body: form.slice(index + 1) });
			} else {
				for (; index < form.length; index += 1) {
					const arity = form[index];
					if (!(arity instanceof EdnList) || arity.length === 0 || !isAstVector(arity[0])) {
						fail("INVALID_ARGUMENT", "fn arities must be non-empty lists starting with a parameter vector");
					}
					arities.push({ params: arity[0], body: arity.slice(1) });
				}
			}
			if (arities.length === 0) {
				fail("INVALID_ARGUMENT", "fn needs at least one arity");
			}
			for (const arity of arities) {
				const innerScope = new Set(scope);
				if (fnName !== null) {
					innerScope.add(fnName);
				}
				for (const param of arity.params) {
					collectPatternSymbols(param, innerScope);
				}
				for (const bodyForm of arity.body) {
					analyze(bodyForm, innerScope, 0, session);
				}
			}
			return;
		}
		case "def": {
			if (!(form[1] instanceof EdnSymbol)) {
				fail("INVALID_ARGUMENT", "def needs a symbol name");
			}
			if (form.length > 2) {
				analyze(form[2], scope, loopDepth, session);
			}
			scope.add(form[1].name);
			return;
		}
		case "when":
			if (form.length < 2) {
				fail("INVALID_ARGUMENT", "when needs a test");
			}
			analyze(form[1], scope, loopDepth, session);
			for (let index = 2; index < form.length; index += 1) {
				analyze(form[index], scope, loopDepth, session);
			}
			return;
		case "cond": {
			for (let index = 1; index < form.length; index += 1) {
				const clause = form[index];
				if (!(clause instanceof EdnList) || clause.length === 0) {
					fail("INVALID_ARGUMENT", "cond clauses must be non-empty lists");
				}
				for (const item of clause) {
					analyze(item, scope, loopDepth, session);
				}
			}
			return;
		}
		case "and":
		case "or":
			for (let index = 1; index < form.length; index += 1) {
				analyze(form[index], scope, loopDepth, session);
			}
			return;
		case "doseq": {
			const binding = form[1];
			if (!isAstVector(binding) || binding.length < 2 || binding.length % 2 !== 0) {
				fail("INVALID_ARGUMENT", "doseq needs an even binding vector");
			}
			if (form.length < 3) {
				fail("INVALID_ARGUMENT", "doseq needs a body");
			}
			const innerScope = new Set(scope);
			for (let index = 0; index < binding.length; index += 2) {
				analyze(binding[index + 1], innerScope, loopDepth, session);
				collectPatternSymbols(binding[index], innerScope);
			}
			for (let index = 2; index < form.length; index += 1) {
				analyze(form[index], innerScope, 0, session);
			}
			return;
		}
		case "when-let":
		case "if-let": {
			const binding = form[1];
			if (!isAstVector(binding) || binding.length !== 2) {
				fail("INVALID_ARGUMENT", `${name} needs a two-element binding vector`);
			}
			if (form.length < 3) {
				fail("INVALID_ARGUMENT", `${name} needs a body`);
			}
			if (name === "if-let" && form.length > 4) {
				fail("INVALID_ARGUMENT", "if-let accepts one then branch and one else branch");
			}
			analyze(binding[1], scope, loopDepth, session);
			const innerScope = new Set(scope);
			collectPatternSymbols(binding[0], innerScope);
			for (let index = 2; index < form.length; index += 1) {
				analyze(form[index], innerScope, loopDepth, session);
			}
			return;
		}
		case "letfn": {
			const bindings = form[1];
			if (!isAstVector(bindings)) {
				fail("INVALID_ARGUMENT", "letfn needs a vector of function definitions");
			}
			const innerScope = new Set(scope);
			for (const spec of bindings) {
				if (!(spec instanceof EdnList) || spec.length < 2 || !(spec[0] instanceof EdnSymbol)) {
					fail("INVALID_ARGUMENT", "letfn definitions must be lists starting with a symbol");
				}
				innerScope.add(spec[0].name);
			}
			for (const spec of bindings) {
				analyze(listForm(symbolForm("fn"), spec[0], ...spec.slice(1)), innerScope, loopDepth, session);
			}
			for (let index = 2; index < form.length; index += 1) {
				analyze(form[index], innerScope, loopDepth, session);
			}
			return;
		}
		case "for": {
			if (form.length !== 3) {
				fail("INVALID_ARGUMENT", "for needs a binding vector and one body expression");
			}
			const levels = parseForLevels(form[1]);
			const innerScope = new Set(scope);
			for (const level of levels) {
				analyze(level.expr, innerScope, 0, session);
				collectPatternSymbols(level.pattern, innerScope);
				for (const modifier of level.modifiers) {
					if (modifier.kind === "let") {
						for (let index = 0; index < modifier.bindings.length; index += 2) {
							analyze(modifier.bindings[index + 1], innerScope, 0, session);
							collectPatternSymbols(modifier.bindings[index], innerScope);
						}
					} else {
						analyze(modifier.test, innerScope, 0, session);
					}
				}
			}
			analyze(form[2], innerScope, 0, session);
			return;
		}
		case "throw":
			if (form.length !== 2) {
				fail("INVALID_ARGUMENT", "throw takes exactly one value");
			}
			analyze(form[1], scope, loopDepth, session);
			return;
		case "try": {
			const body = [];
			const catchClauses = [];
			let finallyClause = null;
			for (let index = 1; index < form.length; index += 1) {
				const item = form[index];
				if (item instanceof EdnList && item[0] instanceof EdnSymbol && item[0].name === "catch") {
					if (finallyClause !== null) {
						fail("INVALID_ARGUMENT", "finally must be the last clause in try");
					}
					const parts = catchParts(item);
					if (!(parts.symbol instanceof EdnSymbol)) {
						fail("INVALID_ARGUMENT", "catch needs a symbol binding");
					}
					catchClauses.push(parts);
					continue;
				}
				if (item instanceof EdnList && item[0] instanceof EdnSymbol && item[0].name === "finally") {
					if (finallyClause !== null) {
						fail("INVALID_ARGUMENT", "try supports one finally clause");
					}
					finallyClause = item.slice(1);
					continue;
				}
				body.push(item);
			}
			if (body.length === 0) {
				fail("INVALID_ARGUMENT", "try needs a body");
			}
			for (const bodyForm of body) {
				analyze(bodyForm, scope, loopDepth, session);
			}
			for (const catchClause of catchClauses) {
				const catchScope = new Set(scope);
				catchScope.add(catchClause.symbol.name);
				for (const catchForm of catchClause.body) {
					analyze(catchForm, catchScope, loopDepth, session);
				}
			}
			if (finallyClause !== null) {
				for (const finallyForm of finallyClause) {
					analyze(finallyForm, scope, loopDepth, session);
				}
			}
			return;
		}
		case "comment":
			return;
		default:
			fail("CAPABILITY_DENIED", `Special form ${name} is not available`, { symbol: name });
	}
}

function analyze(form, scope, loopDepth, session) {
	if (form instanceof EdnSymbol) {
		analyzeSymbol(form, scope, session);
		return;
	}
	if (form instanceof EdnList) {
		if (form.length === 0) {
			return;
		}
		const head = form[0];
		if (head instanceof EdnSymbol) {
			const name = head.name;
			if (
				DENIED_SYMBOLS.has(name) ||
				name.startsWith(".") ||
				(!name.includes("/") && name.includes(".")) ||
				DENIED_NAMESPACES.has(name.split("/")[0])
			) {
				fail("CAPABILITY_DENIED", `Symbol ${name} is not available in the sandbox`, {
					symbol: name,
					reason: "denied-symbol",
				});
			}
			if (name === "->" || name === "->>") {
				analyze(expandThread(form, name === "->>"), scope, loopDepth, session);
				return;
			}
			if (name === "defn" || name === "defn-") {
				analyze(expandDefn(form, name === "defn-"), scope, loopDepth, session);
				return;
			}
			if (EXPANDED_MACROS.has(name)) {
				analyze(expandPureMacro(name, form), scope, loopDepth, session);
				return;
			}
			if (SPECIAL_FORMS.has(name)) {
				analyzeSpecial(name, form, scope, loopDepth, session);
				return;
			}
		}
		for (const item of form) {
			analyze(item, scope, loopDepth, session);
		}
		return;
	}
	if (isAstVector(form)) {
		for (const item of form) {
			analyze(item, scope, loopDepth, session);
		}
		return;
	}
	if (form instanceof Map) {
		for (const [key, value] of form) {
			analyze(key, scope, loopDepth, session);
			analyze(value, scope, loopDepth, session);
		}
		return;
	}
	if (form instanceof Set) {
		for (const item of form) {
			analyze(item, scope, loopDepth, session);
		}
		return;
	}
	if (
		form === null ||
		form === undefined ||
		typeof form === "boolean" ||
		typeof form === "number" ||
		typeof form === "bigint" ||
		typeof form === "string" ||
		form instanceof EdnKeyword
	) {
		return;
	}
	fail("INVALID_ARGUMENT", "Unsupported source form", { form: safePrStr(form) });
}

function checkTail(form, tail, loopDepth) {
	if (form instanceof EdnSymbol) {
		return;
	}
	if (form instanceof EdnList) {
		if (form.length === 0) {
			return;
		}
		const head = form[0];
		if (!(head instanceof EdnSymbol)) {
			for (const item of form) {
				checkTail(item, false, loopDepth);
			}
			return;
		}
		const name = head.name;
		if (name === "quote" || name === "comment") {
			return;
		}
		if (name === "recur") {
			if (loopDepth === 0 || !tail) {
				fail("INVALID_ARGUMENT", "recur is only valid in tail position of a loop", {
					form: "recur",
				});
			}
			for (let index = 1; index < form.length; index += 1) {
				checkTail(form[index], false, loopDepth);
			}
			return;
		}
		if (name === "loop") {
			const bindings = form[1];
			if (isAstVector(bindings)) {
				for (let index = 1; index < bindings.length; index += 2) {
					checkTail(bindings[index], false, loopDepth);
				}
			}
			for (let index = 2; index < form.length; index += 1) {
				checkTail(form[index], index === form.length - 1, loopDepth + 1);
			}
			return;
		}
		if (name === "fn") {
			let index = 1;
			if (form[1] instanceof EdnSymbol) {
				index = 2;
			}
			if (isAstVector(form[index])) {
				for (let bodyIndex = index + 1; bodyIndex < form.length; bodyIndex += 1) {
					checkTail(form[bodyIndex], bodyIndex === form.length - 1, 0);
				}
			} else {
				for (; index < form.length; index += 1) {
					const arity = form[index];
					if (arity instanceof EdnList) {
						for (let bodyIndex = 1; bodyIndex < arity.length; bodyIndex += 1) {
							checkTail(arity[bodyIndex], bodyIndex === arity.length - 1, 0);
						}
					}
				}
			}
			return;
		}
		if (name === "if") {
			checkTail(form[1], false, loopDepth);
			checkTail(form[2], tail, loopDepth);
			if (form.length > 3) {
				checkTail(form[3], tail, loopDepth);
			}
			return;
		}
		if (name === "do" || name === "let" || name === "and" || name === "or") {
			const start = name === "let" ? 2 : 1;
			if (name === "let") {
				const bindings = form[1];
				if (isAstVector(bindings)) {
					for (let index = 1; index < bindings.length; index += 2) {
						checkTail(bindings[index], false, loopDepth);
					}
				}
			}
			for (let index = start; index < form.length; index += 1) {
				const last = index === form.length - 1;
				checkTail(form[index], last ? tail : false, loopDepth);
			}
			return;
		}
		if (name === "when") {
			checkTail(form[1], false, loopDepth);
			for (let index = 2; index < form.length; index += 1) {
				checkTail(form[index], index === form.length - 1 ? tail : false, loopDepth);
			}
			return;
		}
		if (name === "cond") {
			for (let index = 1; index < form.length; index += 1) {
				const clause = form[index];
				if (clause instanceof EdnList && clause.length > 0) {
					checkTail(clause[0], false, loopDepth);
					for (let bodyIndex = 1; bodyIndex < clause.length; bodyIndex += 1) {
						checkTail(clause[bodyIndex], bodyIndex === clause.length - 1 ? tail : false, loopDepth);
					}
				}
			}
			return;
		}
		if (name === "when-let") {
			const binding = form[1];
			if (isAstVector(binding) && binding.length === 2) {
				checkTail(binding[1], false, loopDepth);
			}
			for (let index = 2; index < form.length; index += 1) {
				checkTail(form[index], index === form.length - 1 ? tail : false, loopDepth);
			}
			return;
		}
		if (name === "if-let") {
			const binding = form[1];
			if (isAstVector(binding) && binding.length === 2) {
				checkTail(binding[1], false, loopDepth);
			}
			checkTail(form[2], tail, loopDepth);
			if (form.length > 3) {
				checkTail(form[3], tail, loopDepth);
			}
			return;
		}
		if (name === "doseq") {
			const binding = form[1];
			if (isAstVector(binding)) {
				for (let index = 1; index < binding.length; index += 2) {
					checkTail(binding[index], false, loopDepth);
				}
			}
			for (let index = 2; index < form.length; index += 1) {
				checkTail(form[index], false, 0);
			}
			return;
		}
		if (name === "try") {
			for (let index = 1; index < form.length; index += 1) {
				const item = form[index];
				if (
					item instanceof EdnList &&
					item[0] instanceof EdnSymbol &&
					(item[0].name === "catch" || item[0].name === "finally")
				) {
					for (let bodyIndex = 1; bodyIndex < item.length; bodyIndex += 1) {
						checkTail(item[bodyIndex], false, 0);
					}
				} else {
					checkTail(item, false, 0);
				}
			}
			return;
		}
		if (name === "def") {
			if (form.length > 2) {
				checkTail(form[2], false, loopDepth);
			}
			return;
		}
		if (name === "throw") {
			if (form.length > 1) {
				checkTail(form[1], false, loopDepth);
			}
			return;
		}
		for (const item of form) {
			checkTail(item, false, loopDepth);
		}
		return;
	}
	if (isAstVector(form)) {
		for (const item of form) {
			checkTail(item, false, loopDepth);
		}
		return;
	}
	if (form instanceof Map) {
		for (const [key, value] of form) {
			checkTail(key, false, loopDepth);
			checkTail(value, false, loopDepth);
		}
		return;
	}
	if (form instanceof Set) {
		for (const item of form) {
			checkTail(item, false, loopDepth);
		}
	}
}

function parseProgram(code, expectedName) {
	let form;
	try {
		form = readUfss(code);
	} catch (error) {
		fail(error.code ?? "INVALID_ARGUMENT", error.message, error.data ?? {}, error);
	}
	if (!(form instanceof EdnList) || form.length < 3) {
		fail("INVALID_ARGUMENT", "code must be one (defprogram <name> [] ...) form");
	}
	const head = form[0];
	if (!(head instanceof EdnSymbol) || head.name !== "defprogram") {
		fail("INVALID_ARGUMENT", "code must start with defprogram");
	}
	const name = form[1];
	if (!(name instanceof EdnSymbol)) {
		fail("INVALID_ARGUMENT", "defprogram needs a symbol name");
	}
	if (name.name !== expectedName) {
		fail("INVALID_ARGUMENT", "defprogram name does not match program_name", {
			expected: expectedName,
			got: name.name,
		});
	}
	const params = form[2];
	if (!isAstVector(params) || params.length !== 0) {
		fail("INVALID_ARGUMENT", "defprogram parameters must be an empty vector");
	}
	return { name: name.name, params, body: form.slice(3) };
}

function formatSource(code) {
	return code
		.split("\n")
		.map((line, index) => `${String(index + 1).padStart(4, " ")} | ${line}`)
		.join("\n");
}

function astToValue(form) {
	if (form instanceof EdnKeyword) {
		return V(form.name);
	}
	if (form instanceof EdnSymbol) {
		return data().symbol(form.name);
	}
	if (form instanceof EdnList) {
		return data().listFromArray([...form].map((item) => astToValue(item)));
	}
	if (isAstVector(form)) {
		return data().vectorFromArray(form.map((item) => astToValue(item)));
	}
	if (form instanceof Map) {
		return data().mapFromEntries([...form].map(([key, value]) => [astToValue(key), astToValue(value)]));
	}
	if (form instanceof Set) {
		return data().setFromArray([...form].map((item) => astToValue(item)));
	}
	return form;
}

class ParkSignal {
	constructor(reason, payload) {
		this.reason = reason;
		this.payload = payload;
	}
}

class RecurSignal {
	constructor(values) {
		this.values = values;
	}
}

class ProgramThrow extends Error {
	constructor(value) {
		super("Program threw");
		this.name = "ProgramThrow";
		this.value = value;
	}
}

class SessionAbort {
	constructor(reason = "operator") {
		this.reason = reason;
	}
}

class WaitSignal {
	constructor(kind, reason = null) {
		this.kind = kind;
		this.reason = reason;
	}
}

function createControl(program, session) {
	let settled = false;
	let timer;
	let resolveControl;
	const promise = new Promise((resolve) => {
		resolveControl = resolve;
	});
	const control = {
		promise,
		fire(signal) {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolveControl(signal);
		},
		dispose() {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
		},
	};
	program.control = control;
	const delay = Math.max(1, Math.min(2_147_483_647, program.deadlineAt - session.now()));
	timer = setTimeout(() => control.fire(new WaitSignal("deadline")), delay);
	return control;
}

function disposeControl(program) {
	if (program.control !== null) {
		program.control.dispose();
		program.control = null;
	}
}

async function awaitAsync(value, finish, state, program, meta = null) {
	const pending = {
		promise: value,
		finish,
		settled: false,
		result: undefined,
		error: null,
		capability: meta?.capability ?? null,
		argument: meta?.argument ?? null,
		abandoned: false,
	};
	value.then(
		(result) => {
			pending.settled = true;
			pending.result = result;
		},
		(error) => {
			pending.settled = true;
			pending.error = error;
		},
	);
	return waitPending(pending, state, program);
}

async function waitPending(pending, state, program) {
	if (pending.settled) {
		program.pending = null;
		if (pending.error !== null) {
			throw pending.error;
		}
		return pending.finish(pending.result);
	}
	const control = program.control;
	if (control === null) {
		const result = await pending.promise;
		return pending.finish(result);
	}
	const signal = await Promise.race([pending.promise, control.promise]);
	if (signal instanceof WaitSignal) {
		if (signal.kind === "deadline") {
			program.pending = pending;
			state.kont.push({ type: "pendingCall", pending });
			throw new ParkSignal("deadline", null);
		}
		const settled = await settleWithin(pending.promise, 100);
		if (settled?.ok) {
			return pending.finish(settled.value);
		}
		if (pending.capability !== null) {
			pending.abandoned = true;
			pending.outcome = "outcome-unknown";
			pending.finish = null;
			program.abandonedCapabilities.push(pending);
			if (program.session.abandoned === undefined) {
				program.session.abandoned = new Map();
			}
			const abandoned = program.session.abandoned;
			const ledger = abandoned.get(program.name);
			if (ledger === undefined) {
				abandoned.set(program.name, [pending]);
			} else {
				ledger.push(pending);
			}
		}
		throw new SessionAbort(signal.reason);
	}
	return pending.finish(signal);
}

function settleWithin(value, milliseconds) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), milliseconds);
		value.then(
			(result) => {
				clearTimeout(timer);
				resolve({ ok: true, value: result });
			},
			(error) => {
				clearTimeout(timer);
				resolve({ ok: false, error });
			},
		);
	});
}

function resolveSymbol(state, program, session, name) {
	const bound = envGet(state.env, name);
	if (bound !== MISSING) {
		return bound;
	}
	if (DENIED_SYMBOLS.has(name)) {
		fail("CAPABILITY_DENIED", `Symbol ${name} is denied`, { symbol: name });
	}
	// `cat` is both a capability name and a core transducer. A granted
	// capability wins; without it the builtin transducer remains available.
	if (
		name === "cat" &&
		session.allowedCapabilities.has(name) &&
		(INTERNAL_CAPABILITIES.has(name) || program.capabilities.has(name))
	) {
		return { kind: "capability", name };
	}
	if (isBuiltinName(name)) {
		return { kind: "builtin", name };
	}
	if (isHofName(name)) {
		return { kind: "hof", name };
	}
	if (session.allowedCapabilities.has(name)) {
		if (INTERNAL_CAPABILITIES.has(name) || program.capabilities.has(name)) {
			return { kind: "capability", name };
		}
	}
	fail("CAPABILITY_DENIED", `Unbound symbol ${name}`, { symbol: name, reason: "unbound" });
}

function ret(state, value) {
	state.mode = "return";
	state.value = value;
}

function evalForm(state, form, environment) {
	state.mode = "eval";
	state.control = form;
	state.env = environment;
}

function startBody(state, forms, environment) {
	if (forms.length === 0) {
		ret(state, null);
		return;
	}
	state.kont.push({ type: "do", forms, index: 0, env: environment });
	evalForm(state, forms[0], environment);
}

function advanceDoseqAsync(frame, state) {
	const [pattern] = frame.bindings[frame.bindingIndex];
	bindPatternAsync(pattern, frame.items[frame.index], frame.env, state, (environment, nextState) => {
		if (frame.bindingIndex + 1 < frame.bindings.length) {
			nextState.kont.push({
				type: "doseqColl",
				bindings: frame.bindings,
				bindingIndex: frame.bindingIndex + 1,
				body: frame.body,
				env: environment,
			});
			evalForm(nextState, frame.bindings[frame.bindingIndex + 1][1], environment);
			return;
		}
		startBody(nextState, frame.body, environment);
	});
}

async function evalStep(session, program, state) {
	const form = state.control;

	if (form instanceof EdnSymbol) {
		ret(state, resolveSymbol(state, program, session, form.name));
		return;
	}
	if (form instanceof EdnKeyword) {
		ret(state, V(form.name));
		return;
	}
	if (form instanceof EdnList) {
		if (form.length === 0) {
			ret(state, new EdnList());
			return;
		}
		const head = form[0];
		if (head instanceof EdnSymbol) {
			const name = head.name;
			if (name === "->" || name === "->>") {
				state.control = expandThread(form, name === "->>");
				return;
			}
			if (name === "defn" || name === "defn-") {
				state.control = expandDefn(form, name === "defn-");
				return;
			}
			if (EXPANDED_MACROS.has(name)) {
				state.control = expandPureMacro(name, form);
				return;
			}
			if (SPECIAL_FORMS.has(name)) {
				evalSpecial(name, form, state);
				return;
			}
		}
		const frame = {
			type: "app",
			forms: form.slice(1),
			index: 0,
			values: [],
			env: state.env,
			hasFunction: false,
			fn: null,
		};
		state.kont.push(frame);
		evalForm(state, head, state.env);
		return;
	}
	if (isAstVector(form)) {
		if (form.length === 0) {
			ret(state, data().vectorFromArray([]));
			return;
		}
		state.kont.push({ type: "vector", items: form.slice(), index: 0, values: [], env: state.env });
		evalForm(state, form[0], state.env);
		return;
	}
	if (form instanceof Map) {
		const entries = [...form.entries()];
		if (entries.length === 0) {
			ret(state, data().emptyMap());
			return;
		}
		state.kont.push({
			type: "map",
			entries,
			index: 0,
			phase: "key",
			pendingKey: null,
			values: data().emptyMap(),
			env: state.env,
		});
		evalForm(state, entries[0][0], state.env);
		return;
	}
	if (form instanceof Set) {
		const items = [...form];
		if (items.length === 0) {
			ret(state, data().emptySet());
			return;
		}
		state.kont.push({ type: "set", items, index: 0, values: [], env: state.env });
		evalForm(state, items[0], state.env);
		return;
	}
	ret(state, form);
}

function evalSpecial(name, form, state) {
	switch (name) {
		case "defprogram":
			fail("INVALID_ARGUMENT", "defprogram can only appear at the top level");
			break;
		case "quote":
			ret(state, form.length > 1 ? astToValue(form[1]) : null);
			return;
		case "if":
			state.kont.push({
				type: "if",
				consequent: form[2],
				otherwise: form.length > 3 ? form[3] : null,
				env: state.env,
			});
			evalForm(state, form[1], state.env);
			return;
		case "do":
			startBody(state, form.slice(1), state.env);
			return;
		case "let": {
			const bindings = form[1];
			const pairs = [];
			for (let index = 0; index < bindings.length; index += 2) {
				pairs.push([bindings[index], bindings[index + 1]]);
			}
			if (pairs.length === 0) {
				startBody(state, form.slice(2), state.env);
				return;
			}
			state.kont.push({ type: "let", pairs, index: 0, env: state.env, body: form.slice(2) });
			evalForm(state, pairs[0][1], state.env);
			return;
		}
		case "loop": {
			const bindings = form[1];
			const patterns = [];
			const inits = [];
			for (let index = 0; index < bindings.length; index += 2) {
				patterns.push(bindings[index]);
				inits.push(bindings[index + 1]);
			}
			if (inits.length === 0) {
				const bodyFrame = {
					type: "loopBody",
					patterns,
					body: form.slice(2),
					baseEnv: state.env,
					env: state.env,
				};
				state.kont.push(bodyFrame);
				startBody(state, form.slice(2), state.env);
				return;
			}
			state.kont.push({
				type: "loopInit",
				patterns,
				inits,
				index: 0,
				values: [],
				env: state.env,
				body: form.slice(2),
			});
			evalForm(state, inits[0], state.env);
			return;
		}
		case "recur": {
			const args = form.slice(1);
			if (args.length === 0) {
				ret(state, new RecurSignal([]));
				return;
			}
			state.kont.push({ type: "recurArgs", forms: args, index: 0, values: [], env: state.env });
			evalForm(state, args[0], state.env);
			return;
		}
		case "fn": {
			let index = 1;
			let nameSymbol = null;
			if (form[1] instanceof EdnSymbol) {
				nameSymbol = form[1];
				index = 2;
			}
			const arities = [];
			if (isAstVector(form[index])) {
				arities.push({ params: form[index], body: form.slice(index + 1) });
			} else {
				for (; index < form.length; index += 1) {
					const arity = form[index];
					if (!(arity instanceof EdnList) || arity.length === 0 || !isAstVector(arity[0])) {
						fail("INVALID_ARGUMENT", "fn arities must be lists starting with a parameter vector");
					}
					arities.push({ params: arity[0], body: arity.slice(1) });
				}
			}
			if (arities.length === 0) {
				fail("INVALID_ARGUMENT", "fn needs at least one arity");
			}
			const fn = { kind: "fn", name: nameSymbol?.name ?? null, arities, env: state.env };
			if (nameSymbol !== null) {
				fn.env = extendEnvironment(state.env, [[nameSymbol.name, fn]]);
			}
			ret(state, fn);
			return;
		}
		case "def": {
			if (!(form[1] instanceof EdnSymbol)) {
				fail("INVALID_ARGUMENT", "def needs a symbol name");
			}
			state.kont.push({ type: "def", name: form[1].name });
			if (form.length > 2) {
				evalForm(state, form[2], state.env);
			} else {
				ret(state, null);
			}
			return;
		}
		case "when":
			state.kont.push({ type: "when", body: form.slice(2), env: state.env });
			evalForm(state, form[1], state.env);
			return;
		case "cond": {
			const clauses = [];
			for (let index = 1; index < form.length; index += 1) {
				const clause = form[index];
				if (!(clause instanceof EdnList)) {
					fail("INVALID_ARGUMENT", "cond clauses must be lists");
				}
				clauses.push(clause);
			}
			if (clauses.length === 0) {
				ret(state, null);
				return;
			}
			state.kont.push({ type: "cond", clauses, index: 0, env: state.env });
			evalForm(state, clauses[0][0], state.env);
			return;
		}
		case "and": {
			const forms = form.slice(1);
			if (forms.length === 0) {
				ret(state, true);
				return;
			}
			state.kont.push({ type: "and", forms, index: 0, env: state.env });
			evalForm(state, forms[0], state.env);
			return;
		}
		case "or": {
			const forms = form.slice(1);
			if (forms.length === 0) {
				ret(state, null);
				return;
			}
			state.kont.push({ type: "or", forms, index: 0, env: state.env });
			evalForm(state, forms[0], state.env);
			return;
		}
		case "doseq": {
			const binding = form[1];
			const bindings = [];
			for (let index = 0; index < binding.length; index += 2) {
				bindings.push([binding[index], binding[index + 1]]);
			}
			state.kont.push({
				type: "doseqColl",
				bindings,
				bindingIndex: 0,
				body: form.slice(2),
				env: state.env,
			});
			evalForm(state, bindings[0][1], state.env);
			return;
		}
		case "when-let": {
			const binding = form[1];
			state.kont.push({
				type: "whenLet",
				pattern: binding[0],
				body: form.slice(2),
				env: state.env,
			});
			evalForm(state, binding[1], state.env);
			return;
		}
		case "if-let": {
			const binding = form[1];
			state.kont.push({
				type: "ifLet",
				pattern: binding[0],
				consequent: form[2] ?? null,
				otherwise: form[3] ?? null,
				env: state.env,
			});
			evalForm(state, binding[1], state.env);
			return;
		}
		case "letfn": {
			const environment = new Environment(state.env);
			const names = [];
			const forms = [];
			for (const spec of form[1]) {
				names.push(spec[0].name);
				environment.bindings.set(spec[0].name, null);
				forms.push(listForm(symbolForm("fn"), spec[0], ...spec.slice(1)));
			}
			if (forms.length === 0) {
				startBody(state, form.slice(2), environment);
				return;
			}
			state.kont.push({ type: "letfn", forms, names, index: 0, env: environment, body: form.slice(2) });
			evalForm(state, forms[0], environment);
			return;
		}
		case "for":
			ret(state, new LazyStream(forLazy(parseForLevels(form[1]), form[2], state.env)));
			return;
		case "throw":
			state.kont.push({ type: "throw" });
			evalForm(state, form[1], state.env);
			return;
		case "try": {
			const body = [];
			const catches = [];
			let finallyBody = [];
			for (let index = 1; index < form.length; index += 1) {
				const item = form[index];
				if (item instanceof EdnList && item[0] instanceof EdnSymbol && item[0].name === "catch") {
					catches.push(catchParts(item));
					continue;
				}
				if (item instanceof EdnList && item[0] instanceof EdnSymbol && item[0].name === "finally") {
					finallyBody = item.slice(1);
					continue;
				}
				body.push(item);
			}
			state.kont.push({
				type: "try",
				catches,
				finallyBody,
				env: state.env,
			});
			startBody(state, body, state.env);
			return;
		}
		case "comment":
			ret(state, null);
			return;
		default:
			fail("CAPABILITY_DENIED", `Special form ${name} is not available`, { symbol: name });
	}
}

async function returnStep(session, program, state) {
	const value = state.value;
	const frame = state.kont.pop();
	if (frame === undefined) {
		state.done = true;
		return;
	}

	if (value instanceof RecurSignal && frame.type !== "loopBody") {
		ret(state, value);
		return;
	}

	switch (frame.type) {
		case "app": {
			if (!frame.hasFunction) {
				frame.fn = value;
				frame.hasFunction = true;
			} else {
				frame.values.push(value);
			}
			if (frame.index < frame.forms.length) {
				const form = frame.forms[frame.index];
				frame.index += 1;
				state.kont.push(frame);
				evalForm(state, form, frame.env);
				return;
			}
			await applyCallable(state, frame.fn, frame.values, session, program);
			return;
		}
		case "vector": {
			frame.values.push(value);
			frame.index += 1;
			if (frame.index < frame.items.length) {
				state.kont.push(frame);
				evalForm(state, frame.items[frame.index], frame.env);
				return;
			}
			ret(state, data().vectorFromArray(frame.values));
			return;
		}
		case "map": {
			if (frame.phase === "key") {
				frame.pendingKey = value;
				frame.phase = "value";
				state.kont.push(frame);
				evalForm(state, frame.entries[frame.index][1], frame.env);
				return;
			}
			frame.values = mapAssoc(frame.values, frame.pendingKey, value);
			frame.phase = "key";
			frame.index += 1;
			if (frame.index < frame.entries.length) {
				state.kont.push(frame);
				evalForm(state, frame.entries[frame.index][0], frame.env);
				return;
			}
			ret(state, frame.values);
			return;
		}
		case "set": {
			if (!frame.values.some((existing) => cljEquals(existing, value))) {
				frame.values.push(value);
			}
			frame.index += 1;
			if (frame.index < frame.items.length) {
				state.kont.push(frame);
				evalForm(state, frame.items[frame.index], frame.env);
				return;
			}
			ret(state, data().setFromArray(frame.values));
			return;
		}
		case "if":
			if (truthy(value)) {
				evalForm(state, frame.consequent, frame.env);
			} else if (frame.otherwise === null) {
				ret(state, null);
			} else {
				evalForm(state, frame.otherwise, frame.env);
			}
			return;
		case "do": {
			frame.index += 1;
			if (frame.index < frame.forms.length) {
				state.kont.push(frame);
				evalForm(state, frame.forms[frame.index], frame.env);
				return;
			}
			ret(state, value);
			return;
		}
		case "let": {
			bindPatternAsync(frame.pairs[frame.index][0], value, frame.env, state, (environment, nextState) => {
				frame.env = environment;
				frame.index += 1;
				if (frame.index < frame.pairs.length) {
					nextState.kont.push(frame);
					evalForm(nextState, frame.pairs[frame.index][1], frame.env);
					return;
				}
				startBody(nextState, frame.body, frame.env);
			});
			return;
		}
		case "letfn": {
			frame.env.bindings.set(frame.names[frame.index], value);
			frame.index += 1;
			if (frame.index < frame.forms.length) {
				state.kont.push(frame);
				evalForm(state, frame.forms[frame.index], frame.env);
				return;
			}
			startBody(state, frame.body, frame.env);
			return;
		}
		case "loopInit": {
			frame.values.push(value);
			frame.index += 1;
			if (frame.index < frame.inits.length) {
				state.kont.push(frame);
				evalForm(state, frame.inits[frame.index], frame.env);
				return;
			}
			bindAllAsync(frame.patterns, frame.values, frame.env, state, (loopEnv, nextState) => {
				nextState.kont.push({
					type: "loopBody",
					patterns: frame.patterns,
					body: frame.body,
					baseEnv: frame.env,
					env: loopEnv,
				});
				startBody(nextState, frame.body, loopEnv);
			});
			return;
		}
		case "loopBody": {
			if (value instanceof RecurSignal) {
				if (value.values.length !== frame.patterns.length) {
					fail("INVALID_ARGUMENT", "recur arity does not match loop bindings", {
						expected: frame.patterns.length,
						got: value.values.length,
					});
				}
				bindAllAsync(frame.patterns, value.values, frame.baseEnv, state, (loopEnv, nextState) => {
					nextState.kont.push({ ...frame, env: loopEnv });
					startBody(nextState, frame.body, loopEnv);
				});
				return;
			}
			ret(state, value);
			return;
		}
		case "recurArgs": {
			frame.values.push(value);
			frame.index += 1;
			if (frame.index < frame.forms.length) {
				state.kont.push(frame);
				evalForm(state, frame.forms[frame.index], frame.env);
				return;
			}
			ret(state, new RecurSignal(frame.values));
			return;
		}
		case "when":
			if (truthy(value)) {
				startBody(state, frame.body, frame.env);
			} else {
				ret(state, null);
			}
			return;
		case "cond": {
			if (truthy(value)) {
				startBody(state, frame.clauses[frame.index].slice(1), frame.env);
				return;
			}
			frame.index += 1;
			if (frame.index < frame.clauses.length) {
				state.kont.push(frame);
				evalForm(state, frame.clauses[frame.index][0], frame.env);
				return;
			}
			ret(state, null);
			return;
		}
		case "and": {
			if (!truthy(value)) {
				ret(state, value);
				return;
			}
			frame.index += 1;
			if (frame.index < frame.forms.length) {
				state.kont.push(frame);
				evalForm(state, frame.forms[frame.index], frame.env);
				return;
			}
			ret(state, value);
			return;
		}
		case "or": {
			if (truthy(value)) {
				ret(state, value);
				return;
			}
			frame.index += 1;
			if (frame.index < frame.forms.length) {
				state.kont.push(frame);
				evalForm(state, frame.forms[frame.index], frame.env);
				return;
			}
			ret(state, null);
			return;
		}
		case "def":
			program.rootEnv.bindings.set(frame.name, value);
			ret(state, value);
			return;
		case "throw":
			throw new ProgramThrow(value);
		case "whenLet": {
			if (truthy(value)) {
				bindPatternAsync(frame.pattern, value, frame.env, state, (environment, nextState) => {
					startBody(nextState, frame.body, environment);
				});
			} else {
				ret(state, null);
			}
			return;
		}
		case "ifLet": {
			if (truthy(value)) {
				bindPatternAsync(frame.pattern, value, frame.env, state, (environment, nextState) => {
					evalForm(nextState, frame.consequent, environment);
				});
			} else if (frame.otherwise === null) {
				ret(state, null);
			} else {
				evalForm(state, frame.otherwise, frame.env);
			}
			return;
		}
		case "doseqColl": {
			const items = seqToArray(value);
			if (items.length === 0) {
				ret(state, null);
				return;
			}
			const doseqFrame = {
				type: "doseq",
				bindings: frame.bindings,
				bindingIndex: frame.bindingIndex,
				body: frame.body,
				items,
				index: 0,
				env: frame.env,
			};
			state.kont.push(doseqFrame);
			advanceDoseqAsync(doseqFrame, state);
			return;
		}
		case "doseq": {
			frame.index += 1;
			if (frame.index < frame.items.length) {
				state.kont.push(frame);
				advanceDoseqAsync(frame, state);
				return;
			}
			ret(state, null);
			return;
		}
		case "hof":
			await handleHofResult(frame, value, state, session, program);
			return;
		case "transduceReduceInit": {
			frame.run.acc = value;
			await advanceTransduceReduce(frame.run, state, session, program);
			return;
		}
		case "transduceReduceStep": {
			if (isReducedValue(value)) {
				frame.run.acc = unreduceValue(value);
				state.kont.push({ type: "transduceReduceFinish", run: frame.run });
				await applyCallable(state, frame.run.reducer, [frame.run.acc], session, program);
				return;
			}
			frame.run.acc = value;
			await advanceTransduceReduce(frame.run, state, session, program);
			return;
		}
		case "transduceReduceHalt": {
			frame.run.acc = value;
			state.kont.push({ type: "transduceReduceFinish", run: frame.run });
			await applyCallable(state, frame.run.reducer, [frame.run.acc], session, program);
			return;
		}
		case "transduceReduceFinish":
			ret(state, isReducedValue(value) ? unreduceValue(value) : value);
			return;
		case "walk":
			await walkResume(frame, value, state, session, program);
			return;
		case "walkLevel":
			await walkLevelResume(frame, value, state, session, program);
			return;
		case "stringReplace":
			await stringReplaceResume(frame, value, state, session, program);
			return;
		case "pendingCall": {
			const result = await waitPending(frame.pending, state, program);
			ret(state, result);
			return;
		}
		case "regexCall":
			await regexAttempt(frame, state, session, program);
			return;
		case "lazyRealize": {
			if (frame.awaiting) {
				frame.awaiting = false;
				lazySource(frame.stream).resume = value;
			}
			await lazyRealizeNext(frame, state, session, program);
			return;
		}
		case "lazyPull":
			if (value !== LAZY_DONE) {
				frame.cursor.index += 1;
			}
			lazySource(frame.owner.stream).resume = value;
			await lazyRealizeNext(frame.owner, state, session, program);
			return;
		case "lazyCapture":
			await frame.resume(value, state, session, program);
			return;
		case "lazyPrepareCapture":
			frame.owner.resolved.push(value);
			frame.owner.index += 1;
			await lazyPrepareNext(frame.owner, state, session, program);
			return;
		case "complement":
			ret(state, !truthy(value));
			return;
		case "memoizeCapture":
			frame.callable.cache.push({ args: frame.args, value });
			ret(state, value);
			return;
		case "comp":
			if (frame.index === 0) {
				ret(state, value);
				return;
			}
			frame.index -= 1;
			state.kont.push(frame);
			await applyCallable(state, frame.fns[frame.index], [value], session, program);
			return;
		case "juxt": {
			frame.results.push(value);
			frame.index += 1;
			if (frame.index < frame.fns.length) {
				state.kont.push(frame);
				await applyCallable(state, frame.fns[frame.index], frame.args, session, program);
				return;
			}
			ret(state, data().vectorFromArray(frame.results));
			return;
		}
		case "predCombinator": {
			if (frame.mode === "every-pred" && !truthy(value)) {
				ret(state, false);
				return;
			}
			if (frame.mode === "some-fn" && truthy(value)) {
				ret(state, true);
				return;
			}
			frame.argIndex += 1;
			if (frame.argIndex < frame.args.length) {
				state.kont.push(frame);
				await applyCallable(state, frame.fns[frame.predIndex], [frame.args[frame.argIndex]], session, program);
				return;
			}
			frame.predIndex += 1;
			frame.argIndex = 0;
			if (frame.predIndex >= frame.fns.length) {
				ret(state, frame.mode === "every-pred");
				return;
			}
			state.kont.push(frame);
			await applyCallable(state, frame.fns[frame.predIndex], [frame.args[0]], session, program);
			return;
		}
		case "trampoline":
			if (value !== null && typeof value === "object" && typeof value.kind === "string") {
				state.kont.push(frame);
				await applyCallable(state, value, [], session, program);
				return;
			}
			ret(state, value);
			return;
		case "try": {
			if (frame.finallyBody.length === 0) {
				ret(state, value);
				return;
			}
			state.kont.push({
				type: "finally",
				body: frame.finallyBody,
				env: frame.env,
				value,
				rethrow: null,
			});
			startBody(state, frame.finallyBody, frame.env);
			return;
		}
		case "finally":
			if (frame.rethrow !== null) {
				throw frame.rethrow;
			}
			ret(state, frame.value);
			return;
		default:
			fail("INVALID_ARGUMENT", "Corrupt continuation frame", { type: frame.type });
	}
}

async function applyCallable(state, callable, args, session, program) {
	if (data().isKeyword(callable)) {
		arity(`:${data().name(callable)}`, args, 1, 2);
		const container = args[0];
		const notFound = args.length === 2 ? args[1] : null;
		ret(state, mapGet(container, callable, notFound));
		return;
	}
	if (data().isVector(callable)) {
		arity("vector", args, 1, 2);
		const notFound = args.length === 2 ? args[1] : MISSING;
		ret(state, nthOf(callable, args[0], notFound));
		return;
	}
	if (data().isMap(callable)) {
		arity("map", args, 1, 2);
		ret(state, mapGet(callable, args[0], args.length === 2 ? args[1] : null));
		return;
	}
	if (data().isSet(callable)) {
		arity("set", args, 1);
		ret(state, data().core.contains_QMARK_(callable, args[0]) ? args[0] : null);
		return;
	}
	if (callable === null || typeof callable !== "object") {
		fail("INVALID_ARGUMENT", "Value is not callable", { value: safePrStr(callable) });
	}
	if (callable.kind === "native") {
		ret(state, callable.fn(...args));
		return;
	}
	if (callable.kind === "transducer") {
		if (args.length === 1 && !isCallableValue(args[0]) && callable.steps.length === 0) {
			ret(state, args[0]);
			return;
		}
		if (callable.xform === null) {
			fail("CAPABILITY_DENIED", "transducer must be driven by transduce, into, sequence, or eduction", {
				reason: "async-transducer-call",
			});
		}
		if (args.length === 1 && isCallableValue(args[0])) {
			ret(state, { kind: "native", fn: callable.xform(toJsReducer(args[0], "transducer")) });
			return;
		}
		fail("CAPABILITY_DENIED", "transducers must be driven by transduce, into, sequence, or eduction", {
			reason: "transducer-call",
		});
	}
	if (callable.kind === "partial") {
		await applyCallable(state, callable.fn, [...callable.bound, ...args], session, program);
		return;
	}
	if (callable.kind === "memoize") {
		const cached = callable.cache.find((entry) => sameArguments(entry.args, args));
		if (cached !== undefined) {
			ret(state, cached.value);
			return;
		}
		state.kont.push({ type: "memoizeCapture", callable, args: args.slice() });
		await applyCallable(state, callable.fn, args, session, program);
		return;
	}
	if (callable.kind === "completing") {
		if (args.length === 1) {
			if (callable.cf === null) {
				ret(state, args[0]);
				return;
			}
			await applyCallable(state, callable.cf, args, session, program);
			return;
		}
		await applyCallable(state, callable.f, args, session, program);
		return;
	}
	if (callable.kind === "fnil") {
		const length = Math.max(args.length, callable.defaults.length);
		const replaced = [];
		for (let index = 0; index < length; index += 1) {
			const value = index < args.length ? args[index] : undefined;
			replaced.push(value === null || value === undefined ? (callable.defaults[index] ?? null) : value);
		}
		await applyCallable(state, callable.fn, replaced, session, program);
		return;
	}
	if (callable.kind === "complement") {
		state.kont.push({ type: "complement" });
		await applyCallable(state, callable.fn, args, session, program);
		return;
	}
	if (callable.kind === "comp") {
		if (callable.fns.length === 0) {
			ret(state, args[0] ?? null);
			return;
		}
		state.kont.push({ type: "comp", fns: callable.fns, index: callable.fns.length - 1 });
		await applyCallable(state, callable.fns[callable.fns.length - 1], args, session, program);
		return;
	}
	if (callable.kind === "juxt") {
		if (callable.fns.length === 0) {
			ret(state, data().vectorFromArray([]));
			return;
		}
		state.kont.push({ type: "juxt", fns: callable.fns, index: 0, args, results: [] });
		await applyCallable(state, callable.fns[0], args, session, program);
		return;
	}
	if (callable.kind === "every-pred" || callable.kind === "some-fn") {
		if (callable.fns.length === 0 || args.length === 0) {
			ret(state, callable.kind === "every-pred");
			return;
		}
		state.kont.push({
			type: "predCombinator",
			mode: callable.kind,
			fns: callable.fns,
			args,
			predIndex: 0,
			argIndex: 0,
		});
		await applyCallable(state, callable.fns[0], [args[0]], session, program);
		return;
	}
	if (callable.kind === "fn") {
		if (callable.constant !== undefined) {
			ret(state, callable.constant);
			return;
		}
		const arity = callable.arities.find((candidate) => acceptsParams(candidate.params, args.length));
		if (arity === undefined) {
			fail("INVALID_ARGUMENT", "Function arity does not match", {
				function: callable.name ?? "fn",
				got: args.length,
			});
		}
		bindParamsAsync(arity.params, args, callable.env, state, (environment, nextState) => {
			startBody(nextState, arity.body, environment);
		});
		return;
	}
	if (callable.kind === "builtin") {
		const regexOp = REGEX_BUILTIN_OPS.get(callable.name);
		if (regexOp !== undefined) {
			await startRegexBuiltin(regexOp, args, state, session, program);
			return;
		}
		if (
			(callable.name === "meta" || callable.name === "with-meta") &&
			args[0] !== null &&
			typeof args[0] === "object" &&
			args[0].kind === "fn"
		) {
			if (callable.name === "meta") {
				arity("meta", args, 1);
				ret(state, args[0].meta ?? null);
				return;
			}
			arity("with-meta", args, 2);
			ret(state, { ...args[0], meta: args[1] });
			return;
		}
		if (callable.name === "sort" && args.length === 2) {
			await startSortWithComparator(args[0], args[1], state, session, program);
			return;
		}
		if (STREAM_EQUALITY_NAMES.has(callable.name) && args.length === 1 && containsLazyStream(args[0])) {
			ret(state, !(callable.name === "not=" || callable.name === "cljs.core/not="));
			return;
		}
		if (STREAM_EQUALITY_NAMES.has(callable.name) && args.length >= 2 && args.some(isLazyStream)) {
			await startLazyEquality(callable.name, args, state, session, program);
			return;
		}
		if (
			LAZY_ARG_BUILTINS.has(callable.name) &&
			!(callable.name === "sort" && args.length !== 1) &&
			args.some((argument) => containsLazyStream(argument))
		) {
			await resolveLazyBuiltinArgs(callable, args, state, session, program);
			return;
		}
		if (LAZY_CONSUMERS.has(callable.name) && (await startLazyConsumer(callable.name, args, state, session, program))) {
			return;
		}
		const builtin = BUILTINS.get(callable.name);
		if (builtin === undefined) {
			fail("CAPABILITY_DENIED", `Unbound function ${callable.name}`, { symbol: callable.name });
		}
		const value = builtin.fn(args);
		if (isThenable(value)) {
			state.awaited = true;
			ret(state, await awaitAsync(value, (raw) => normalizeResult(raw), state, program));
		} else {
			ret(state, value);
		}
		return;
	}
	if (callable.kind === "hof") {
		await applyHof(callable.name, args, state, session, program);
		return;
	}
	if (callable.kind === "capability") {
		const value = await invokeCapability(callable.name, args, state, session, program);
		ret(state, value);
		return;
	}
	fail("INVALID_ARGUMENT", "Value is not callable", { value: safePrStr(callable) });
}

function isCallableValue(value) {
	if (value === null || typeof value !== "object") {
		return false;
	}
	if (DATA?.isKeyword(value) || DATA?.isVector(value)) {
		return true;
	}
	if (DATA?.isMap(value) || DATA?.isSet(value)) {
		return true;
	}
	return (
		value.kind === "fn" ||
		value.kind === "builtin" ||
		value.kind === "hof" ||
		value.kind === "capability" ||
		value.kind === "native" ||
		value.kind === "transducer" ||
		value.kind === "completing" ||
		value.kind === "partial" ||
		value.kind === "memoize" ||
		value.kind === "comp" ||
		value.kind === "juxt" ||
		value.kind === "complement" ||
		value.kind === "fnil" ||
		value.kind === "every-pred" ||
		value.kind === "some-fn"
	);
}

function canSyncCallable(value) {
	if (value === null || typeof value !== "object") {
		return false;
	}
	if (DATA?.isKeyword(value) || DATA?.isVector(value) || DATA?.isMap(value) || DATA?.isSet(value)) {
		return true;
	}
	if (value.kind === "fn") {
		return value.constant !== undefined;
	}
	if (value.kind === "builtin" || value.kind === "constantly") {
		return true;
	}
	if (value.kind === "native") {
		return true;
	}
	if (value.kind === "memoize") {
		return canSyncCallable(value.fn);
	}
	if (value.kind === "completing") {
		return canSyncCallable(value.f) && (value.cf === null || canSyncCallable(value.cf));
	}
	if (value.kind === "partial" || value.kind === "fnil" || value.kind === "complement") {
		return canSyncCallable(value.fn);
	}
	if (value.kind === "comp" || value.kind === "juxt" || value.kind === "every-pred" || value.kind === "some-fn") {
		return value.fns.every((fn) => canSyncCallable(fn));
	}
	return false;
}

function isTransducer(value) {
	return value !== null && typeof value === "object" && value.kind === "transducer";
}

function isEduction(value) {
	return value !== null && typeof value === "object" && value.kind === "eduction";
}

function makeTransducer(steps, xform = null) {
	return { kind: "transducer", steps, xform };
}

function makeEduction(steps, source) {
	return { kind: "eduction", steps, source };
}

/**
 * Bare zero-arity transducer factories (`cat`, `distinct`, `dedupe`) resolve to
 * builtin callables when referenced as values. Convert them to a transducer
 * before use, and leave every other value untouched.
 */
function resolveTransducerValue(value) {
	if (isTransducer(value)) {
		return value;
	}
	if (value !== null && typeof value === "object" && value.kind === "builtin") {
		const builtin = BUILTINS.get(value.name);
		if (builtin !== undefined) {
			const result = builtin.fn([]);
			if (isTransducer(result)) {
				return result;
			}
		}
	}
	return value;
}

function toJsTransducerCallback(callable) {
	return (...args) => syncCallable(callable, args);
}

function toJsReducer(reducer, context = "transduce") {
	if (reducer !== null && typeof reducer === "object" && reducer.kind === "native") {
		return reducer.fn;
	}
	if (!canSyncCallable(reducer)) {
		fail("CAPABILITY_DENIED", `${context} needs a synchronous reducer`, {
			reason: "async-transducer-reducer",
		});
	}
	return (...args) => syncCallable(reducer, args);
}

function composeTransducers(xforms, name) {
	for (const xform of xforms) {
		if (!isTransducer(xform)) {
			fail("INVALID_ARGUMENT", `${name} expects transducers`, { value: safePrStr(xform) });
		}
	}
	const steps = xforms.flatMap((xform) => xform.steps);
	const cherry = xforms.every((xform) => xform.xform !== null)
		? data().core.comp(...xforms.map((xform) => xform.xform))
		: null;
	return makeTransducer(steps, cherry);
}

const TRANSDUCER_HALT = Symbol("transducer-halt");

class TransducerHalt {
	constructor(value, retf) {
		this.value = value;
		this.retf = retf;
	}
}

function createTransducerRuntime(steps) {
	return steps.map((step) => {
		switch (step.op) {
			case "take":
			case "drop":
				return { remaining: step.count };
			case "dedupe":
				return { previous: MISSING };
			case "distinct":
				return { seen: [] };
			case "interpose":
				return { emitted: false };
			case "partition-all":
				return { buffer: [] };
			case "partition-by":
				return { current: [], key: MISSING };
			case "drop-while":
				return { dropping: true };
			case "map-indexed":
			case "keep-indexed":
				return { index: 0 };
			default:
				return {};
		}
	});
}

/**
 * Lazy transducer driver. Every callback goes through LazyStream's `call`
 * descriptor, so interpreter functions, capability calls, and other async
 * callables run on the machine continuation instead of a synchronous Cherry
 * reduce loop.
 */
function* transducerLazy(steps, source, context = null) {
	const states = createTransducerRuntime(steps);
	const cursor = makeCursor(source);
	try {
		for (;;) {
			const item = yield { type: "pull", cursor };
			if (item === LAZY_DONE) {
				break;
			}
			yield* transducerItemLazy(steps, states, 0, item);
		}
		yield* flushTransducer(steps, states, 0);
	} catch (error) {
		if (error instanceof TransducerHalt) {
			if (context !== null) {
				context.haltValue = error.value;
				context.haltRetf = error.retf;
			}
		} else if (error !== TRANSDUCER_HALT) {
			throw error;
		}
		try {
			yield* flushTransducer(steps, states, 0);
		} catch (flushError) {
			if (flushError instanceof TransducerHalt) {
				if (context !== null) {
					context.haltValue = flushError.value;
					context.haltRetf = flushError.retf;
				}
			} else if (flushError !== TRANSDUCER_HALT) {
				throw flushError;
			}
		}
	}
}

function* transducerItemLazy(steps, states, index, value) {
	if (index >= steps.length) {
		yield { type: "value", value };
		return;
	}
	const step = steps[index];
	const state = states[index];
	const next = (nextValue) => transducerItemLazy(steps, states, index + 1, nextValue);
	switch (step.op) {
		case "map": {
			const out = yield { type: "call", fn: step.fn, args: [value] };
			yield* next(out);
			return;
		}
		case "filter": {
			const keep = yield { type: "call", fn: step.fn, args: [value] };
			if (truthy(keep) !== Boolean(step.negate)) {
				yield* next(value);
			}
			return;
		}
		case "keep": {
			const out = yield { type: "call", fn: step.fn, args: [value] };
			if (out !== null && out !== undefined) {
				yield* next(out);
			}
			return;
		}
		case "map-indexed": {
			const out = yield { type: "call", fn: step.fn, args: [state.index, value] };
			state.index += 1;
			yield* next(out);
			return;
		}
		case "keep-indexed": {
			const out = yield { type: "call", fn: step.fn, args: [state.index, value] };
			state.index += 1;
			if (out !== null && out !== undefined) {
				yield* next(out);
			}
			return;
		}
		case "mapcat": {
			const out = yield { type: "call", fn: step.fn, args: [value] };
			const inner = makeCursor(out);
			for (;;) {
				const item = yield { type: "pull", cursor: inner };
				if (item === LAZY_DONE) {
					break;
				}
				yield* next(item);
			}
			return;
		}
		case "cat": {
			const inner = makeCursor(value);
			for (;;) {
				const item = yield { type: "pull", cursor: inner };
				if (item === LAZY_DONE) {
					break;
				}
				yield* next(item);
			}
			return;
		}
		case "take": {
			if (state.remaining <= 0) {
				throw TRANSDUCER_HALT;
			}
			state.remaining -= 1;
			yield* next(value);
			if (state.remaining <= 0) {
				throw TRANSDUCER_HALT;
			}
			return;
		}
		case "drop": {
			if (state.remaining > 0) {
				state.remaining -= 1;
				return;
			}
			yield* next(value);
			return;
		}
		case "take-while": {
			const keep = yield { type: "call", fn: step.fn, args: [value] };
			if (!truthy(keep)) {
				throw TRANSDUCER_HALT;
			}
			yield* next(value);
			return;
		}
		case "drop-while": {
			if (state.dropping) {
				const keep = yield { type: "call", fn: step.fn, args: [value] };
				if (truthy(keep)) {
					return;
				}
				state.dropping = false;
			}
			yield* next(value);
			return;
		}
		case "dedupe": {
			if (state.previous !== MISSING && cljEquals(state.previous, value)) {
				return;
			}
			state.previous = value;
			yield* next(value);
			return;
		}
		case "distinct": {
			if (state.seen.some((item) => cljEquals(item, value))) {
				return;
			}
			state.seen.push(value);
			yield* next(value);
			return;
		}
		case "interpose": {
			if (state.emitted) {
				yield* next(step.sep);
			}
			state.emitted = true;
			yield* next(value);
			return;
		}
		case "partition-all": {
			state.buffer.push(value);
			if (state.buffer.length < step.count) {
				return;
			}
			const chunk = data().vectorFromArray(state.buffer);
			state.buffer = [];
			yield* next(chunk);
			return;
		}
		case "partition-by": {
			const key = yield { type: "call", fn: step.fn, args: [value] };
			if (state.key !== MISSING && !cljEquals(state.key, key) && state.current.length > 0) {
				const chunk = data().vectorFromArray(state.current);
				state.current = [];
				yield* next(chunk);
			}
			state.key = key;
			state.current.push(value);
			return;
		}
		case "halt-when": {
			const halt = yield { type: "call", fn: step.fn, args: [value] };
			if (truthy(halt)) {
				throw new TransducerHalt(value, step.retf ?? null);
			}
			yield* next(value);
			return;
		}
		default:
			fail("CAPABILITY_DENIED", `Transducer step ${step.op} is not supported on this path`, {
				reason: "unsupported-transducer-step",
				step: step.op,
			});
	}
}

function* flushTransducer(steps, states, index) {
	for (let cursor = index; cursor < steps.length; cursor += 1) {
		const step = steps[cursor];
		const state = states[cursor];
		if (step.op === "partition-all" && state.buffer.length > 0) {
			const chunk = data().vectorFromArray(state.buffer);
			state.buffer = [];
			yield* transducerItemLazy(steps, states, cursor + 1, chunk);
		}
		if (step.op === "partition-by" && state.current.length > 0) {
			const chunk = data().vectorFromArray(state.current);
			state.current = [];
			state.key = MISSING;
			yield* transducerItemLazy(steps, states, cursor + 1, chunk);
		}
	}
}

function eductionToStream(eduction) {
	return makeTransducerStream(eduction.steps, eduction.source);
}

function makeTransducerStream(steps, source) {
	const context = { haltValue: MISSING, haltRetf: null };
	const stream = new LazyStream(transducerLazy(steps, source, context));
	stream.transducerContext = context;
	return stream;
}

function mergeEductionInput(source, xform) {
	let steps = xform === null ? [] : xform.steps.slice();
	let input = source;
	let cherry = xform === null ? null : xform.xform;
	let guard = 0;
	while (isEduction(input)) {
		guard += 1;
		if (guard > 100) {
			fail("INVALID_ARGUMENT", "eduction nesting is too deep", { limit: 100 });
		}
		steps = [...steps, ...input.steps];
		cherry = null;
		input = input.source;
	}
	return { source: input, steps, xform: cherry === null ? null : xform };
}

class LazyStream {
	constructor(generator) {
		this.kind = "lazyStream";
		this.generator = generator;
		this.cache = [];
		this.done = false;
		this.waiting = false;
		this.resume = undefined;
	}
}

const LAZY_DONE = Symbol("lazy-done");

function isLazyStream(value) {
	return (
		value !== null && typeof value === "object" && (value.kind === "lazyStream" || value.kind === "lazyStreamView")
	);
}

function lazyView(value, offset) {
	if (value.kind === "lazyStreamView") {
		return { kind: "lazyStreamView", source: value.source, offset: value.offset + offset };
	}
	return { kind: "lazyStreamView", source: value, offset };
}

function lazySource(value) {
	return value.kind === "lazyStreamView" ? value.source : value;
}

function lazyOffset(value) {
	return value.kind === "lazyStreamView" ? value.offset : 0;
}

function makeCursor(source) {
	if (isLazyStream(source)) {
		return { stream: source, index: 0 };
	}
	if (isUnboundedRange(source) || isLazySeqValue(source)) {
		return { seq: data().core.seq(source) };
	}
	return { items: seqToArray(source), index: 0 };
}

function lazySeqFromArray(values) {
	let index = 0;
	return data().core.repeatedly(values.length, () => values[index++]);
}

function advanceLazy(stream) {
	if (stream.done) {
		return { type: "done" };
	}
	const step = stream.waiting ? stream.generator.next(stream.resume) : stream.generator.next();
	stream.waiting = false;
	stream.resume = undefined;
	if (step.done) {
		stream.done = true;
		return { type: "done" };
	}
	const descriptor = step.value;
	if (
		descriptor.type === "call" ||
		descriptor.type === "pull" ||
		descriptor.type === "eval" ||
		descriptor.type === "bind" ||
		descriptor.type === "regexStep"
	) {
		stream.waiting = true;
	}
	return descriptor;
}

function* iterateLazy(fn, seed) {
	let value = seed;
	yield { type: "value", value };
	for (;;) {
		const next = yield { type: "call", fn, args: [value] };
		value = next;
		yield { type: "value", value };
	}
}

function* repeatedlyLazy(fn, count = Number.POSITIVE_INFINITY) {
	for (let index = 0; index < count; index += 1) {
		const value = yield { type: "call", fn, args: [] };
		yield { type: "value", value };
	}
}

function* reductionsLazy(fn, collection, hasInitial, initial) {
	const cursor = makeCursor(collection);
	const first = yield { type: "pull", cursor };
	if (hasInitial) {
		yield { type: "value", value: initial };
		if (first === LAZY_DONE) {
			return;
		}
		let accumulator = yield { type: "call", fn, args: [initial, first] };
		yield { type: "value", value: accumulator };
		for (;;) {
			const item = yield { type: "pull", cursor };
			if (item === LAZY_DONE) {
				return;
			}
			accumulator = yield { type: "call", fn, args: [accumulator, item] };
			yield { type: "value", value: accumulator };
		}
	}
	if (first === LAZY_DONE) {
		return;
	}
	let accumulator = first;
	yield { type: "value", value: accumulator };
	for (;;) {
		const item = yield { type: "pull", cursor };
		if (item === LAZY_DONE) {
			return;
		}
		accumulator = yield { type: "call", fn, args: [accumulator, item] };
		yield { type: "value", value: accumulator };
	}
}

function* partitionByLazy(fn, collection) {
	const cursor = makeCursor(collection);
	const first = yield { type: "pull", cursor };
	if (first === LAZY_DONE) {
		return;
	}
	let current = [first];
	let key = yield { type: "call", fn, args: [first] };
	for (;;) {
		const item = yield { type: "pull", cursor };
		if (item === LAZY_DONE) {
			break;
		}
		const nextKey = yield { type: "call", fn, args: [item] };
		if (cljEquals(key, nextKey)) {
			current.push(item);
		} else {
			yield { type: "value", value: data().vectorFromArray(current) };
			current = [item];
			key = nextKey;
		}
	}
	yield { type: "value", value: data().vectorFromArray(current) };
}

function* takeWhileLazy(predicate, collection) {
	const cursor = makeCursor(collection);
	for (;;) {
		const item = yield { type: "pull", cursor };
		if (item === LAZY_DONE) {
			return;
		}
		const keep = yield { type: "call", fn: predicate, args: [item] };
		if (!truthy(keep)) {
			return;
		}
		yield { type: "value", value: item };
	}
}

function* dropWhileLazy(predicate, collection) {
	const cursor = makeCursor(collection);
	let dropping = true;
	for (;;) {
		const item = yield { type: "pull", cursor };
		if (item === LAZY_DONE) {
			return;
		}
		if (dropping) {
			const keepDropping = yield { type: "call", fn: predicate, args: [item] };
			if (truthy(keepDropping)) {
				continue;
			}
			dropping = false;
		}
		yield { type: "value", value: item };
	}
}

function* treeSeqLazy(branchFn, childrenFn, root) {
	const stack = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		yield { type: "value", value: node };
		const branch = yield { type: "call", fn: branchFn, args: [node] };
		if (truthy(branch)) {
			const children = yield { type: "call", fn: childrenFn, args: [node] };
			const cursor = makeCursor(children);
			const items = [];
			for (;;) {
				const item = yield { type: "pull", cursor };
				if (item === LAZY_DONE) {
					break;
				}
				if (items.length >= MAX_MATERIALIZED_ITEMS) {
					fail("LIMIT_EXCEEDED", "tree-seq children exceed the materialization limit", {
						limit: MAX_MATERIALIZED_ITEMS,
						reason: "lazy-or-infinite-sequence",
					});
				}
				items.push(item);
			}
			for (let index = items.length - 1; index >= 0; index -= 1) {
				stack.push(items[index]);
			}
		}
	}
}

function* mapStreamLazy(fn, sources) {
	const cursors = sources.map((source) => makeCursor(source));
	for (;;) {
		const args = [];
		for (const cursor of cursors) {
			const item = yield { type: "pull", cursor };
			if (item === LAZY_DONE) {
				return;
			}
			args.push(item);
		}
		const value = yield { type: "call", fn, args };
		yield { type: "value", value };
	}
}

function* filterStreamLazy(fn, source, remove) {
	const cursor = makeCursor(source);
	for (;;) {
		const item = yield { type: "pull", cursor };
		if (item === LAZY_DONE) {
			return;
		}
		const keep = yield { type: "call", fn, args: [item] };
		if ((remove && !truthy(keep)) || (!remove && truthy(keep))) {
			yield { type: "value", value: item };
		}
	}
}

function* keepStreamLazy(fn, source) {
	const cursor = makeCursor(source);
	for (;;) {
		const item = yield { type: "pull", cursor };
		if (item === LAZY_DONE) {
			return;
		}
		const value = yield { type: "call", fn, args: [item] };
		if (value !== null) {
			yield { type: "value", value };
		}
	}
}

function* mapIndexedStreamLazy(fn, source, keepOnly) {
	const cursor = makeCursor(source);
	for (let index = 0; ; index += 1) {
		const item = yield { type: "pull", cursor };
		if (item === LAZY_DONE) {
			return;
		}
		const value = yield { type: "call", fn, args: [index, item] };
		if (!keepOnly || value !== null) {
			yield { type: "value", value };
		}
	}
}

function* takeWhileStreamLazy(predicate, source) {
	const cursor = makeCursor(source);
	for (;;) {
		const item = yield { type: "pull", cursor };
		if (item === LAZY_DONE) {
			return;
		}
		const keep = yield { type: "call", fn: predicate, args: [item] };
		if (!truthy(keep)) {
			return;
		}
		yield { type: "value", value: item };
	}
}

function* dropWhileStreamLazy(predicate, source) {
	const cursor = makeCursor(source);
	let dropping = true;
	for (;;) {
		const item = yield { type: "pull", cursor };
		if (item === LAZY_DONE) {
			return;
		}
		if (dropping) {
			const keepDropping = yield { type: "call", fn: predicate, args: [item] };
			if (truthy(keepDropping)) {
				continue;
			}
			dropping = false;
		}
		yield { type: "value", value: item };
	}
}

function* mapcatStreamLazy(fn, sources) {
	const cursors = sources.map((source) => makeCursor(source));
	for (;;) {
		const args = [];
		for (const cursor of cursors) {
			const sourceItem = yield { type: "pull", cursor };
			if (sourceItem === LAZY_DONE) {
				return;
			}
			args.push(sourceItem);
		}
		const result = yield { type: "call", fn, args };
		const resultCursor = makeCursor(result);
		for (;;) {
			const item = yield { type: "pull", cursor: resultCursor };
			if (item === LAZY_DONE) {
				break;
			}
			yield { type: "value", value: item };
		}
	}
}

function* forModifiers(modifiers, environment) {
	let current = environment;
	for (const modifier of modifiers) {
		if (modifier.kind === "let") {
			for (let index = 0; index < modifier.bindings.length; index += 2) {
				const value = yield { type: "eval", form: modifier.bindings[index + 1], env: current };
				current = yield { type: "bind", pattern: modifier.bindings[index], value, env: current };
			}
			continue;
		}
		const keep = yield { type: "eval", form: modifier.test, env: current };
		if (!truthy(keep)) {
			return { environment: current, skip: true, stop: modifier.kind === "while" };
		}
	}
	return { environment: current, skip: false, stop: false };
}

function* forLazy(levels, body, environment) {
	yield* forLevel(levels, 0, environment, body);
}

function* forLevel(levels, depth, environment, body) {
	if (depth >= levels.length) {
		const value = yield { type: "eval", form: body, env: environment };
		yield { type: "value", value };
		return;
	}
	const level = levels[depth];
	const collection = yield { type: "eval", form: level.expr, env: environment };
	const cursor = makeCursor(collection);
	for (;;) {
		const item = yield { type: "pull", cursor };
		if (item === LAZY_DONE) {
			return;
		}
		const bound = yield { type: "bind", pattern: level.pattern, value: item, env: environment };
		const outcome = yield* forModifiers(level.modifiers, bound);
		if (outcome.stop) {
			return;
		}
		if (outcome.skip) {
			continue;
		}
		yield* forLevel(levels, depth + 1, outcome.environment, body);
	}
}

const LAZY_CONSUMERS = new Set([
	"take",
	"first",
	"count",
	"vec",
	"last",
	"nth",
	"doall",
	"dorun",
	"seq",
	"rest",
	"next",
]);

async function lazyRealizeNext(frame, state, session, program) {
	for (;;) {
		const source = lazySource(frame.stream);
		const offset = lazyOffset(frame.stream);
		const effectiveIndex = frame.sourceIndex + offset;
		if (frame.values.length >= frame.target) {
			frame.exhausted = source.done && effectiveIndex >= source.cache.length;
			lazyRealizeFinish(frame, state);
			return;
		}
		if (source.done && effectiveIndex >= source.cache.length) {
			frame.exhausted = true;
			lazyRealizeFinish(frame, state);
			return;
		}
		if (effectiveIndex < source.cache.length) {
			const value = source.cache[effectiveIndex];
			frame.sourceIndex += 1;
			frame.values.push(value);
			continue;
		}
		const descriptor = advanceLazy(source);
		if (descriptor.type === "done") {
			frame.exhausted = true;
			lazyRealizeFinish(frame, state);
			return;
		}
		if (descriptor.type === "value") {
			source.cache.push(descriptor.value);
			continue;
		}
		if (descriptor.type === "call") {
			frame.awaiting = true;
			state.kont.push(frame);
			await applyCallable(state, descriptor.fn, descriptor.args, session, program);
			return;
		}
		if (descriptor.type === "eval") {
			frame.awaiting = true;
			state.kont.push(frame);
			evalForm(state, descriptor.form, descriptor.env);
			return;
		}
		if (descriptor.type === "bind") {
			frame.awaiting = true;
			state.kont.push(frame);
			bindPatternAsync(descriptor.pattern, descriptor.value, descriptor.env, state, (environment, nextState) => {
				ret(nextState, environment);
			});
			return;
		}
		if (descriptor.type === "regexStep") {
			frame.awaiting = true;
			state.kont.push(frame);
			await regexAttempt(
				{
					type: "regexCall",
					run: descriptor.run,
					finish: (value, nextState) => {
						ret(nextState, value);
					},
				},
				state,
				session,
				program,
			);
			return;
		}
		if (descriptor.type === "pull") {
			const cursor = descriptor.cursor;
			if (cursor.items) {
				const value = cursor.index < cursor.items.length ? cursor.items[cursor.index++] : LAZY_DONE;
				lazySource(frame.stream).resume = value;
				continue;
			}
			if (cursor.seq !== undefined) {
				const seq = cursor.seq;
				cursor.seq = seq === null ? null : data().core.next(seq);
				lazySource(frame.stream).resume = seq === null ? LAZY_DONE : data().core.first(seq);
				continue;
			}
			const pullFrame = {
				type: "lazyRealize",
				stream: cursor.stream,
				mode: "pull",
				target: 1,
				values: [],
				sourceIndex: cursor.index,
				awaiting: false,
			};
			state.kont.push({ type: "lazyPull", owner: frame, cursor });
			await lazyRealizeNext(pullFrame, state, session, program);
			return;
		}
		fail("INVALID_ARGUMENT", "Corrupt lazy producer descriptor", { type: descriptor.type });
	}
}

function lazyRealizeFinish(frame, state) {
	const done = frame.exhausted === true;
	switch (frame.mode) {
		case "take":
			ret(state, lazySeqFromArray(frame.values));
			return;
		case "first":
			ret(state, frame.values.length === 0 ? null : frame.values[0]);
			return;
		case "seq":
			ret(state, frame.values.length === 0 ? null : frame.stream);
			return;
		case "rest":
			ret(state, lazyView(frame.stream, 1));
			return;
		case "next":
			ret(state, frame.values.length > 1 ? lazyView(frame.stream, 1) : null);
			return;
		case "pull":
			ret(state, frame.values.length === 0 ? LAZY_DONE : frame.values[0]);
			return;
		case "count":
			if (!done && frame.values.length >= MAX_MATERIALIZED_ITEMS) {
				fail("LIMIT_EXCEEDED", "lazy sequence exceeds the materialization limit", {
					limit: MAX_MATERIALIZED_ITEMS,
					reason: "lazy-or-infinite-sequence",
				});
			}
			ret(state, frame.values.length);
			return;
		case "vec":
			if (!done && frame.values.length >= MAX_MATERIALIZED_ITEMS) {
				fail("LIMIT_EXCEEDED", "lazy sequence exceeds the materialization limit", {
					limit: MAX_MATERIALIZED_ITEMS,
					reason: "lazy-or-infinite-sequence",
				});
			}
			ret(state, data().vectorFromArray(frame.values));
			return;
		case "last":
			if (!done && frame.values.length >= MAX_MATERIALIZED_ITEMS) {
				fail("LIMIT_EXCEEDED", "lazy sequence exceeds the materialization limit", {
					limit: MAX_MATERIALIZED_ITEMS,
					reason: "lazy-or-infinite-sequence",
				});
			}
			ret(state, frame.values.length === 0 ? null : frame.values[frame.values.length - 1]);
			return;
		case "nth":
			if (frame.values.length > frame.index) {
				ret(state, frame.values[frame.index]);
				return;
			}
			if (done) {
				if (frame.defaultValue !== MISSING) {
					ret(state, frame.defaultValue);
					return;
				}
				fail("INVALID_ARGUMENT", "nth index is out of bounds", { index: frame.index });
			}
			fail("LIMIT_EXCEEDED", "lazy sequence exceeds the materialization limit", {
				limit: MAX_MATERIALIZED_ITEMS,
				reason: "lazy-or-infinite-sequence",
			});
			return;
		case "doall":
			if (!done && frame.values.length >= MAX_MATERIALIZED_ITEMS) {
				fail("LIMIT_EXCEEDED", "lazy sequence exceeds the materialization limit", {
					limit: MAX_MATERIALIZED_ITEMS,
					reason: "lazy-or-infinite-sequence",
				});
			}
			ret(state, lazySeqFromArray(frame.values));
			return;
		case "deep":
			if (!done && frame.values.length >= MAX_MATERIALIZED_ITEMS) {
				fail("LIMIT_EXCEEDED", "lazy sequence exceeds the materialization limit", {
					limit: MAX_MATERIALIZED_ITEMS,
					reason: "lazy-or-infinite-sequence",
				});
			}
			ret(state, lazySeqFromArray(frame.values));
			return;
		case "array":
			if (!done && frame.values.length >= MAX_MATERIALIZED_ITEMS) {
				fail("LIMIT_EXCEEDED", "lazy sequence exceeds the materialization limit", {
					limit: MAX_MATERIALIZED_ITEMS,
					reason: "lazy-or-infinite-sequence",
				});
			}
			ret(state, data().vectorFromArray(frame.values));
			return;
		case "dorun":
			if (!done && frame.values.length >= MAX_MATERIALIZED_ITEMS) {
				fail("LIMIT_EXCEEDED", "lazy sequence exceeds the materialization limit", {
					limit: MAX_MATERIALIZED_ITEMS,
					reason: "lazy-or-infinite-sequence",
				});
			}
			ret(state, null);
			return;
		case "root":
			if (!done && frame.values.length >= MAX_MATERIALIZED_ITEMS) {
				fail("LIMIT_EXCEEDED", "lazy sequence exceeds the materialization limit", {
					limit: MAX_MATERIALIZED_ITEMS,
					reason: "lazy-or-infinite-sequence",
				});
			}
			ret(state, lazySeqFromArray(frame.values));
			return;
		default:
			fail("INVALID_ARGUMENT", "Unknown lazy consumer mode", { mode: frame.mode });
	}
}

function hasLazyStream(value, seen = new WeakSet()) {
	if (isLazyStream(value)) {
		return true;
	}
	if (data().isMap(value)) {
		if (seen.has(value)) {
			return false;
		}
		seen.add(value);
		return data()
			.mapEntries(value)
			.some(([key, entry]) => hasLazyStream(key, seen) || hasLazyStream(entry, seen));
	}
	if (data().isSet(value)) {
		if (seen.has(value)) {
			return false;
		}
		seen.add(value);
		return data()
			.seqToArray(value)
			.some((item) => hasLazyStream(item, seen));
	}
	if (isUnboundedRange(value) || !data().isColl(value) || seen.has(value)) {
		return false;
	}
	seen.add(value);
	for (const item of seqToArray(value)) {
		if (hasLazyStream(item, seen)) {
			return true;
		}
	}
	return false;
}

async function realizeLazyInto(state, stream, resume, session, program) {
	state.kont.push({ type: "lazyCapture", resume });
	const frame = {
		type: "lazyRealize",
		stream,
		mode: "deep",
		target: MAX_MATERIALIZED_ITEMS,
		values: [],
		sourceIndex: 0,
		awaiting: false,
	};
	await lazyRealizeNext(frame, state, session, program);
}

/**
 * Resolve every LazyStream reachable from `value`, including streams nested
 * inside vectors, lists, sequences, maps, and sets at any depth. A materialized
 * stream becomes a vector, and its elements are resolved in turn.
 */
function containsLazyStream(value) {
	return isLazyStream(value) || hasLazyStream(value);
}

async function deepResolveValue(value, resume, state, session, program) {
	if (isLazyStream(value)) {
		await realizeLazyInto(
			state,
			value,
			async (resolved, nextState) => {
				await deepResolveItems(
					seqToArray(resolved),
					0,
					[],
					async (items, finalState) => {
						await resume(lazySeqFromArray(items), finalState);
					},
					nextState,
					session,
					program,
				);
			},
			session,
			program,
		);
		return;
	}
	if (data().isMap(value) && hasLazyStream(value)) {
		await deepResolveEntries(
			data().mapEntries(value),
			0,
			[],
			async (entries, finalState) => {
				await resume(data().mapFromEntries(entries), finalState);
			},
			state,
			session,
			program,
		);
		return;
	}
	if (data().isVector(value) && hasLazyStream(value)) {
		await deepResolveItems(
			seqToArray(value),
			0,
			[],
			async (items, finalState) => {
				await resume(data().vectorFromArray(items), finalState);
			},
			state,
			session,
			program,
		);
		return;
	}
	if (data().isSet(value) && hasLazyStream(value)) {
		await deepResolveItems(
			seqToArray(value),
			0,
			[],
			async (items, finalState) => {
				await resume(data().setFromArray(items), finalState);
			},
			state,
			session,
			program,
		);
		return;
	}
	if (data().isList(value) && hasLazyStream(value)) {
		await deepResolveItems(
			seqToArray(value),
			0,
			[],
			async (items, finalState) => {
				await resume(data().listFromArray(items), finalState);
			},
			state,
			session,
			program,
		);
		return;
	}
	if (data().isColl(value) && !isUnboundedRange(value) && hasLazyStream(value)) {
		await deepResolveItems(
			seqToArray(value),
			0,
			[],
			async (items, finalState) => {
				await resume(lazySeqFromArray(items), finalState);
			},
			state,
			session,
			program,
		);
		return;
	}
	await resume(value, state);
}

async function deepResolveItems(items, index, results, done, state, session, program) {
	while (index < items.length) {
		const item = items[index];
		if (!containsLazyStream(item)) {
			results.push(item);
			index += 1;
			continue;
		}
		await deepResolveValue(
			item,
			async (resolved, nextState) => {
				results.push(resolved);
				await deepResolveItems(items, index + 1, results, done, nextState, session, program);
			},
			state,
			session,
			program,
		);
		return;
	}
	await done(results, state);
}

async function deepResolveEntries(entries, index, results, done, state, session, program) {
	while (index < entries.length) {
		const [key, value] = entries[index];
		if (!containsLazyStream(key) && !containsLazyStream(value)) {
			results.push([key, value]);
			index += 1;
			continue;
		}
		await deepResolveValue(
			key,
			async (resolvedKey, keyState) => {
				await deepResolveValue(
					value,
					async (resolvedValue, valueState) => {
						results.push([resolvedKey, resolvedValue]);
						await deepResolveEntries(entries, index + 1, results, done, valueState, session, program);
					},
					keyState,
					session,
					program,
				);
			},
			state,
			session,
			program,
		);
		return;
	}
	await done(results, state);
}

async function lazyPrepareNext(frame, state, session, program) {
	while (frame.index < frame.args.length) {
		const argument = frame.args[frame.index];
		if (isLazyStream(argument)) {
			state.kont.push({ type: "lazyPrepareCapture", owner: frame });
			const lazyFrame = {
				type: "lazyRealize",
				stream: argument,
				mode: "array",
				target: MAX_MATERIALIZED_ITEMS,
				values: [],
				sourceIndex: 0,
				awaiting: false,
			};
			await lazyRealizeNext(lazyFrame, state, session, program);
			return;
		}
		frame.resolved.push(argument);
		frame.index += 1;
	}
	await applyHof(frame.name, frame.resolved, state, session, program);
}

async function startLazyConsumer(name, args, state, session, program) {
	let stream = null;
	const mode = name;
	let target = MAX_MATERIALIZED_ITEMS;
	const extra = {};
	if (name === "take") {
		stream = args[1];
		target = Number(numeric(args[0]));
		if (target > MAX_MATERIALIZED_ITEMS) {
			fail("LIMIT_EXCEEDED", "take exceeds the materialization limit", {
				limit: MAX_MATERIALIZED_ITEMS,
			});
		}
	} else if (name === "first") {
		stream = args[0];
		target = 1;
	} else if (name === "seq" || name === "rest") {
		stream = args[0];
		target = 1;
	} else if (name === "next") {
		stream = args[0];
		target = 2;
	} else if (name === "count" || name === "vec" || name === "last") {
		stream = args[0];
	} else if (name === "doall" || name === "dorun") {
		stream = args[args.length - 1];
	} else if (name === "nth") {
		stream = args[0];
		const index = Number(numeric(args[1]));
		if (index >= MAX_MATERIALIZED_ITEMS) {
			fail("LIMIT_EXCEEDED", "nth exceeds the materialization limit", {
				limit: MAX_MATERIALIZED_ITEMS,
			});
		}
		target = index + 1;
		extra.index = index;
		extra.defaultValue = args.length === 3 ? args[2] : MISSING;
	}
	if (isEduction(stream)) {
		stream = eductionToStream(stream);
	}
	if (!isLazyStream(stream)) {
		return false;
	}
	const frame = {
		type: "lazyRealize",
		stream,
		mode,
		target,
		values: [],
		sourceIndex: 0,
		awaiting: false,
		...extra,
	};
	await lazyRealizeNext(frame, state, session, program);
	return true;
}

function makePullCursor(source) {
	return isLazyStream(source) ? { stream: source, sourceIndex: 0 } : { seq: data().core.seq(source) };
}

async function pullLazyCursor(cursor, resume, state, session, program) {
	if (cursor.seq !== undefined) {
		const seq = cursor.seq;
		cursor.seq = seq === null ? null : data().core.next(seq);
		await resume(seq === null ? LAZY_DONE : data().core.first(seq), cursor, state, session, program);
		return;
	}
	const pullFrame = {
		type: "lazyRealize",
		stream: cursor.stream,
		mode: "pull",
		target: 1,
		values: [],
		sourceIndex: cursor.sourceIndex,
		awaiting: false,
	};
	state.kont.push({
		type: "lazyCapture",
		resume: async (value, nextState) => {
			cursor.sourceIndex = pullFrame.sourceIndex;
			await resume(value, cursor, nextState, session, program);
		},
	});
	await lazyRealizeNext(pullFrame, state, session, program);
}

const LAZY_PREDICATES = new Set(["some", "every?", "not-any?", "not-every?"]);

/**
 * `some`/`every?` pull one item at a time, from a LazyStream or an unbounded
 * Cherry range, so an infinite source can still answer.
 */
async function startLazyPredicate(name, predicate, source, state, session, program) {
	const frame = { type: "lazyPredicate", name, predicate, cursor: makePullCursor(source) };
	await lazyPredicateNext(frame, state, session, program);
}

async function lazyPredicateNext(frame, state, session, program) {
	await pullLazyCursor(
		frame.cursor,
		async (value, _cursor, nextState) => {
			if (value === LAZY_DONE) {
				ret(nextState, frame.name === "some" ? null : frame.name !== "not-every?");
				return;
			}
			nextState.kont.push({
				type: "lazyCapture",
				resume: async (result, resultState) => {
					const positive = truthy(result);
					const stop =
						(frame.name === "some" && positive) ||
						(frame.name === "every?" && !positive) ||
						(frame.name === "not-any?" && positive) ||
						(frame.name === "not-every?" && !positive);
					if (stop) {
						ret(resultState, frame.name === "some" ? result : frame.name === "not-every?");
						return;
					}
					await lazyPredicateNext(frame, resultState, session, program);
				},
			});
			await applyCallable(nextState, frame.predicate, [value], session, program);
		},
		state,
		session,
		program,
	);
}

async function startLazyRunBang(fn, stream, state, session, program) {
	const frame = { type: "lazyRunBang", fn, cursor: makePullCursor(stream) };
	await lazyRunBangNext(frame, state, session, program);
}

async function lazyRunBangNext(frame, state, session, program) {
	await pullLazyCursor(
		frame.cursor,
		async (value, _cursor, nextState) => {
			if (value === LAZY_DONE) {
				ret(nextState, null);
				return;
			}
			nextState.kont.push({
				type: "lazyCapture",
				resume: async (_result, resultState) => {
					await lazyRunBangNext(frame, resultState, session, program);
				},
			});
			await applyCallable(nextState, frame.fn, [value], session, program);
		},
		state,
		session,
		program,
	);
}

const STREAM_EQUALITY_NAMES = new Set(["=", "cljs.core/=", "not=", "cljs.core/not="]);

/**
 * `=`/`not=` compare sequential values one item at a time when a LazyStream is
 * involved, so a mismatch in an infinite prefix returns immediately instead of
 * forcing both sequences.
 */
async function startLazyEquality(name, args, state, session, program) {
	const negated = name === "not=" || name === "cljs.core/not=";
	await lazyEqualityPair({ type: "lazyEquality", negated, args, index: 0, compared: 0 }, state, session, program);
}

function isComparableSequence(value) {
	return isLazyStream(value) || isSequentialCollValue(value);
}

async function lazyEqualityPair(frame, state, session, program) {
	const left = frame.args[frame.index];
	const right = frame.args[frame.index + 1];
	if (left === right) {
		await lazyEqualityAdvance(frame, true, state, session, program);
		return;
	}
	if (!isComparableSequence(left) || !isComparableSequence(right)) {
		await lazyEqualityAdvance(frame, false, state, session, program);
		return;
	}
	if (!isLazyStream(left) && !isLazyStream(right)) {
		await compareLazyElements(
			left,
			right,
			async (equal, nextState) => {
				await lazyEqualityAdvance(frame, equal, nextState, session, program);
			},
			state,
			session,
			program,
		);
		return;
	}
	await lazyEqualityPull(frame, makePullCursor(left), makePullCursor(right), state, session, program);
}

async function lazyEqualityPull(frame, leftCursor, rightCursor, state, session, program) {
	await pullLazyCursor(
		leftCursor,
		async (leftValue, _leftCursor, leftState) => {
			await pullLazyCursor(
				rightCursor,
				async (rightValue, _rightCursor, rightState) => {
					if (leftValue === LAZY_DONE || rightValue === LAZY_DONE) {
						await lazyEqualityAdvance(
							frame,
							leftValue === LAZY_DONE && rightValue === LAZY_DONE,
							rightState,
							session,
							program,
						);
						return;
					}
					frame.compared += 1;
					if (frame.compared >= MAX_MATERIALIZED_ITEMS) {
						fail("LIMIT_EXCEEDED", "lazy sequence exceeds the materialization limit", {
							limit: MAX_MATERIALIZED_ITEMS,
							reason: "lazy-or-infinite-sequence",
						});
					}
					await compareLazyElements(
						leftValue,
						rightValue,
						async (equal, nextState) => {
							if (!equal) {
								await lazyEqualityAdvance(frame, false, nextState, session, program);
								return;
							}
							await lazyEqualityPull(frame, leftCursor, rightCursor, nextState, session, program);
						},
						rightState,
						session,
						program,
					);
				},
				leftState,
				session,
				program,
			);
		},
		state,
		session,
		program,
	);
}

async function compareLazyElements(left, right, resume, state, session, program) {
	if (!containsLazyStream(left) && !containsLazyStream(right)) {
		await resume(cljEquals(left, right), state);
		return;
	}
	await deepResolveValue(
		left,
		async (resolvedLeft, leftState) => {
			await deepResolveValue(
				right,
				async (resolvedRight, rightState) => {
					await resume(cljEquals(resolvedLeft, resolvedRight), rightState);
				},
				leftState,
				session,
				program,
			);
		},
		state,
		session,
		program,
	);
}

async function lazyEqualityAdvance(frame, equal, state, session, program) {
	if (!equal) {
		ret(state, frame.negated);
		return;
	}
	frame.index += 1;
	if (frame.index + 1 >= frame.args.length) {
		ret(state, !frame.negated);
		return;
	}
	await lazyEqualityPair(frame, state, session, program);
}

const LAZY_ARG_BUILTINS = new Set([
	"=",
	"cljs.core/=",
	"not=",
	"cljs.core/not=",
	"hash",
	"cljs.core/hash",
	"sort",
	"str",
	"cljs.core/str",
	"pr-str",
	"cljs.core/pr-str",
	"print-str",
	"cljs.core/print-str",
	"prn-str",
	"cljs.core/prn-str",
	"println-str",
	"cljs.core/println-str",
	"clojure.string/join",
]);

/**
 * Structural consumers are synchronous builtins. Resolve their LazyStream
 * arguments first, then call the builtin again with ordinary Cherry values.
 */
async function resolveLazyBuiltinArgs(callable, args, state, session, program) {
	const resolved = new Array(args.length);
	await resolveLazyBuiltinArgAt(callable, args, resolved, 0, state, session, program);
}

async function resolveLazyBuiltinArgAt(callable, args, resolved, index, state, session, program) {
	if (index >= args.length) {
		await applyCallable(state, callable, resolved, session, program);
		return;
	}
	if (!containsLazyStream(args[index])) {
		resolved[index] = args[index];
		await resolveLazyBuiltinArgAt(callable, args, resolved, index + 1, state, session, program);
		return;
	}
	await deepResolveValue(
		args[index],
		async (value, nextState) => {
			resolved[index] = value;
			await resolveLazyBuiltinArgAt(callable, args, resolved, index + 1, nextState, session, program);
		},
		state,
		session,
		program,
	);
}

function walkKind(value) {
	if (data().isMap(value)) {
		return "map";
	}
	if (data().isVector(value)) {
		return "vector";
	}
	if (data().isList(value)) {
		return "list";
	}
	if (data().isSet(value)) {
		return "set";
	}
	if (data().isColl(value)) {
		return "seq";
	}
	return null;
}

function walkChildren(value, kind) {
	if (kind === "map") {
		return data()
			.mapEntries(value)
			.map(([key, entry]) => data().vectorFromArray([key, entry]));
	}
	return seqToArray(value);
}

function walkBuild(kind, children) {
	if (kind === "map") {
		return data().mapFromEntries(children.map((entry) => seqToArray(entry)));
	}
	if (kind === "vector") {
		return data().vectorFromArray(children);
	}
	if (kind === "list") {
		return data().listFromArray(children);
	}
	if (kind === "set") {
		return data().setFromArray(children);
	}
	return data().listFromArray(children);
}

function scheduleWalkChildren(frame, value, kind, applyAfter) {
	const children = walkChildren(value, kind);
	frame.queue.push({ op: "build", kind, count: children.length, applyAfter });
	for (let index = children.length - 1; index >= 0; index -= 1) {
		frame.queue.push({ op: "visit", value: children[index] });
	}
}

async function walkNext(state, frame, session, program) {
	for (;;) {
		if (frame.queue.length === 0) {
			ret(state, frame.results.pop());
			return;
		}
		const task = frame.queue.pop();
		if (task.op === "visit") {
			const kind = walkKind(task.value);
			if (kind === null) {
				frame.pending = { op: "leaf" };
				state.kont.push(frame);
				await applyCallable(state, frame.fn, [task.value], session, program);
				return;
			}
			if (frame.mode === "pre") {
				frame.pending = { op: "pre" };
				state.kont.push(frame);
				await applyCallable(state, frame.fn, [task.value], session, program);
				return;
			}
			scheduleWalkChildren(frame, task.value, kind, true);
			continue;
		}
		if (task.op === "build") {
			const children = frame.results.splice(frame.results.length - task.count, task.count);
			const built = walkBuild(task.kind, children);
			if (task.applyAfter) {
				frame.pending = { op: "post" };
				state.kont.push(frame);
				await applyCallable(state, frame.fn, [built], session, program);
				return;
			}
			frame.results.push(built);
			continue;
		}
		fail("INVALID_ARGUMENT", "Corrupt walk task", { op: task.op });
	}
}

async function walkResume(frame, value, state, session, program) {
	const pending = frame.pending;
	frame.pending = null;
	if (pending === null || pending === undefined) {
		fail("INVALID_ARGUMENT", "Corrupt walk continuation");
	}
	if (pending.op === "leaf" || pending.op === "post") {
		frame.results.push(value);
	} else if (pending.op === "pre") {
		const kind = walkKind(value);
		if (kind === null) {
			frame.results.push(value);
		} else {
			scheduleWalkChildren(frame, value, kind, false);
		}
	} else {
		fail("INVALID_ARGUMENT", "Corrupt walk phase", { op: pending.op });
	}
	await walkNext(state, frame, session, program);
}

async function walkLevelNext(state, frame, session, program) {
	for (;;) {
		if (frame.kind === null) {
			frame.pending = "outer";
			state.kont.push(frame);
			await applyCallable(state, frame.outer, [frame.value], session, program);
			return;
		}
		if (frame.phase === "inner") {
			if (frame.index < frame.children.length) {
				const child = frame.children[frame.index];
				frame.pending = "inner";
				state.kont.push(frame);
				await applyCallable(state, frame.inner, [child], session, program);
				return;
			}
			frame.built = walkBuild(frame.kind, frame.results);
			frame.phase = "outer";
			continue;
		}
		frame.pending = "outer";
		state.kont.push(frame);
		await applyCallable(state, frame.outer, [frame.built], session, program);
		return;
	}
}

async function walkLevelResume(frame, value, state, session, program) {
	if (frame.pending === "inner") {
		frame.results.push(value);
		frame.index += 1;
	} else if (frame.pending === "outer") {
		ret(state, value);
		return;
	} else {
		fail("INVALID_ARGUMENT", "Corrupt walk-level phase", { phase: frame.pending });
	}
	await walkLevelNext(state, frame, session, program);
}

const REGEX_BUILTIN_OPS = new Map([
	["re-find", "find"],
	["cljs.core/re-find", "find"],
	["re-matches", "matches"],
	["cljs.core/re-matches", "matches"],
	["re-seq", "seq"],
	["cljs.core/re-seq", "seq"],
]);

const NEVER = new Promise(() => {});

function isRegexPattern(value) {
	return value instanceof RegExp || (value !== null && typeof value === "object" && typeof value.source === "string");
}

function regexAbortReason(error) {
	const reason = error?.data?.reason ?? error?.reason;
	return reason === "deadline" || reason === "abort" ? reason : null;
}

function clojureRegexValue(value) {
	return Array.isArray(value) ? data().vectorFromArray(value.map((group) => group ?? null)) : value;
}

/**
 * Run one regex task and keep the CEK continuation. A deadline parks the
 * program with a retry frame; unpark starts a fresh worker with the new
 * deadline. The retried work is pure matching, so callbacks are never replayed.
 */
async function regexAttempt(frame, state, session, program) {
	const controller = new AbortController();
	const attempt = Promise.resolve().then(() => frame.run(program, controller.signal));
	const control = program.control;
	const outcome = await Promise.race([
		attempt.then(
			(value) => ({ type: "value", value }),
			(error) => ({ type: "error", error }),
		),
		control === null ? NEVER : control.promise.then((signal) => ({ type: "signal", signal })),
	]);
	if (outcome.type === "value") {
		await frame.finish(outcome.value, state, session, program);
		return;
	}
	if (outcome.type === "error") {
		const reason = regexAbortReason(outcome.error);
		if (reason === "deadline") {
			controller.abort("deadline");
			state.kont.push(frame);
			throw new ParkSignal("deadline", null);
		}
		if (reason === "abort") {
			controller.abort("abort");
			throw new SessionAbort(outcome.error?.data?.reason ?? "operator");
		}
		throw outcome.error;
	}
	if (outcome.signal.kind === "deadline") {
		controller.abort("deadline");
		state.kont.push(frame);
		throw new ParkSignal("deadline", null);
	}
	controller.abort("abort");
	throw new SessionAbort(outcome.signal.reason ?? "operator");
}

function* reSeqLazy(pattern, text) {
	let state = { offset: 0, rest: text, lastIndex: 0 };
	for (;;) {
		const step = yield {
			type: "regexStep",
			run: (program, signal) =>
				regexWorkerSeqStep(
					pattern,
					state.rest,
					{ offset: state.offset, lastIndex: state.lastIndex },
					{ deadlineAt: program.deadlineAt, signal },
				),
		};
		if (step.match !== null) {
			yield { type: "value", value: clojureRegexValue(step.match.value) };
		}
		if (step.done || step.next === null) {
			return;
		}
		state = step.next;
	}
}

async function startRegexBuiltin(op, args, state, session, program) {
	const name = op === "find" ? "re-find" : op === "matches" ? "re-matches" : "re-seq";
	arity(name, args, 2);
	const pattern = args[0];
	if (!isRegexPattern(pattern)) {
		fail("INVALID_ARGUMENT", `${name} expects a regular expression`, { value: safePrStr(pattern) });
	}
	if (typeof args[1] !== "string") {
		fail("INVALID_ARGUMENT", `${name} expects a string`, { value: safePrStr(args[1]) });
	}
	const text = args[1];
	if (op === "seq") {
		ret(state, new LazyStream(reSeqLazy(pattern, text)));
		return;
	}
	const run = (currentProgram, signal) => {
		const options = { deadlineAt: currentProgram.deadlineAt, signal };
		return op === "find" ? regexWorkerFind(pattern, text, options) : regexWorkerMatches(pattern, text, options);
	};
	const finish = async (value, nextState) => {
		ret(nextState, clojureRegexValue(value));
	};
	await regexAttempt({ type: "regexCall", run, finish }, state, session, program);
}

async function advanceStringReplace(frame, state, session, program) {
	if (frame.index >= frame.matches.length) {
		frame.parts.push(frame.source.slice(frame.cursor));
		ret(state, frame.parts.join(""));
		return;
	}
	const match = frame.matches[frame.index];
	frame.parts.push(frame.source.slice(frame.cursor, match.index));
	state.kont.push(frame);
	await applyCallable(state, frame.fn, [match.arg], session, program);
}

async function startStringReplace(name, args, state, session, program) {
	if (typeof args[0] !== "string") {
		fail("INVALID_ARGUMENT", `${name} expects a string`, { value: safePrStr(args[0]) });
	}
	const source = args[0];
	const pattern = args[1];
	const replacement = args[2];
	if (typeof pattern !== "string" && !isRegexPattern(pattern)) {
		fail("INVALID_ARGUMENT", "replace expects a string or regular expression pattern", {
			value: safePrStr(pattern),
		});
	}
	const callable = isCallableValue(replacement);
	if (!callable && typeof replacement !== "string") {
		fail("INVALID_ARGUMENT", `${name} expects a string or callable replacement`, {
			value: safePrStr(replacement),
		});
	}
	const firstOnly = name === "clojure.string/replace-first";
	const run = (currentProgram, signal) => {
		const options = { deadlineAt: currentProgram.deadlineAt, signal };
		if (callable) {
			return regexWorkerReplaceMatches(source, pattern, firstOnly, options);
		}
		return regexWorkerStringReplace(source, pattern, replacement, firstOnly, options);
	};
	const finish = async (value, nextState, nextSession, nextProgram) => {
		if (!callable) {
			ret(nextState, value);
			return;
		}
		if (value.length === 0) {
			ret(nextState, source);
			return;
		}
		const frame = {
			type: "stringReplace",
			fn: replacement,
			source,
			matches: value.map((match) => ({
				index: match.index,
				end: match.end,
				arg: clojureRegexValue(match.value),
			})),
			index: 0,
			cursor: 0,
			parts: [],
		};
		await advanceStringReplace(frame, nextState, nextSession, nextProgram);
	};
	await regexAttempt({ type: "regexCall", run, finish }, state, session, program);
}

async function stringReplaceResume(frame, value, state, session, program) {
	frame.parts.push(stringify(value));
	frame.cursor = frame.matches[frame.index].end;
	frame.index += 1;
	await advanceStringReplace(frame, state, session, program);
}

function syncCompareValues(comparator, left, right) {
	const result = syncCallable(comparator, [left, right]);
	if (typeof result === "number") {
		return result < 0 ? -1 : result > 0 ? 1 : 0;
	}
	if (truthy(result)) {
		return -1;
	}
	return truthy(syncCallable(comparator, [right, left])) ? 1 : 0;
}

function syncSortByCompare(keyFn, comparator, left, right) {
	const leftKey = syncCallable(keyFn, [left]);
	const rightKey = syncCallable(keyFn, [right]);
	const result =
		comparator === null ? data().core.compare(leftKey, rightKey) : syncCallable(comparator, [leftKey, rightKey]);
	if (typeof result === "number") {
		return result < 0 ? -1 : result > 0 ? 1 : 0;
	}
	if (truthy(result)) {
		return -1;
	}
	const reverseLeftKey = syncCallable(keyFn, [right]);
	const reverseRightKey = syncCallable(keyFn, [left]);
	const reversed =
		comparator === null
			? data().core.compare(reverseLeftKey, reverseRightKey)
			: syncCallable(comparator, [reverseLeftKey, reverseRightKey]);
	return truthy(reversed) ? 1 : 0;
}

async function applyCallableValue(callable, args, resume, state, session, program) {
	state.kont.push({ type: "lazyCapture", resume });
	await applyCallable(state, callable, args, session, program);
}

/**
 * Mirrors Clojure's `fn->comparator`: numbers compare by sign, booleans ask the
 * reverse direction. `compareXY` performs one raw comparison, so a user key
 * function runs for each compared item before the comparison call itself.
 */
async function compareCallables(compareXY, left, right, resume, state, session, program) {
	await compareXY(
		left,
		right,
		async (result, resultState) => {
			if (typeof result === "number") {
				await resume(result < 0 ? -1 : result > 0 ? 1 : 0, resultState);
				return;
			}
			if (truthy(result)) {
				await resume(-1, resultState);
				return;
			}
			await compareXY(
				right,
				left,
				async (reverse, reverseState) => {
					await resume(truthy(reverse) ? 1 : 0, reverseState);
				},
				resultState,
				session,
				program,
			);
		},
		state,
		session,
		program,
	);
}

function callableCompareXY(comparator) {
	return (left, right, resume, state, session, program) =>
		applyCallableValue(comparator, [left, right], resume, state, session, program);
}

function sortByCompareXY(keyFn, comparator) {
	return async (left, right, resume, state, session, program) => {
		await applyCallableValue(
			keyFn,
			[left],
			async (leftKey, leftState) => {
				await applyCallableValue(
					keyFn,
					[right],
					async (rightKey, rightState) => {
						if (comparator === null) {
							const compared = data().core.compare(leftKey, rightKey);
							await resume(compared < 0 ? -1 : compared > 0 ? 1 : 0, rightState);
							return;
						}
						await applyCallableValue(comparator, [leftKey, rightKey], resume, rightState, session, program);
					},
					leftState,
					session,
					program,
				);
			},
			state,
			session,
			program,
		);
	};
}

async function resolveSortItems(collection, resume, state, session, program) {
	if (isLazyStream(collection)) {
		await realizeLazyInto(
			state,
			collection,
			async (resolved, nextState) => {
				await resume(seqToArray(resolved), nextState);
			},
			session,
			program,
		);
		return;
	}
	await resume(seqToArray(collection), state);
}

async function startSortWithComparator(comparator, collection, state, session, program) {
	if (!isCallableValue(comparator)) {
		fail("INVALID_ARGUMENT", "sort expects a callable comparator", { value: safePrStr(comparator) });
	}
	await resolveSortItems(
		collection,
		async (items, nextState) => {
			if (canSyncCallable(comparator)) {
				const sorted = items.slice().sort((left, right) => syncCompareValues(comparator, left, right));
				ret(nextState, data().vectorFromArray(sorted));
				return;
			}
			await asyncSortValues(
				items,
				callableCompareXY(comparator),
				async (ordered, finalState) => {
					ret(finalState, data().vectorFromArray(ordered));
				},
				nextState,
				session,
				program,
			);
		},
		state,
		session,
		program,
	);
}

async function startSortBy(keyFn, comparator, items, state, session, program) {
	if (canSyncCallable(keyFn) && (comparator === null || canSyncCallable(comparator))) {
		const entries = items.map((item, index) => ({ item, index }));
		entries.sort((left, right) => {
			const compared = syncSortByCompare(keyFn, comparator, left.item, right.item);
			return compared === 0 ? left.index - right.index : compared;
		});
		ret(state, data().vectorFromArray(entries.map((entry) => entry.item)));
		return;
	}
	await asyncSortValues(
		items,
		sortByCompareXY(keyFn, comparator),
		async (ordered, finalState) => {
			ret(finalState, data().vectorFromArray(ordered));
		},
		state,
		session,
		program,
	);
}

async function asyncSortValues(items, compareXY, resume, state, session, program) {
	if (items.length <= 1) {
		await resume(items.slice(), state);
		return;
	}
	const runs = items.map((item) => [{ item }]);
	await mergeSortLayer(
		runs,
		compareXY,
		async (sorted, finalState) => {
			await resume(
				sorted.map((entry) => entry.item),
				finalState,
			);
		},
		state,
		session,
		program,
	);
}

async function mergeSortLayer(runs, compareXY, finish, state, session, program) {
	const next = [];
	let index = 0;
	const advance = async (currentState) => {
		while (index + 1 < runs.length) {
			const left = runs[index];
			const right = runs[index + 1];
			index += 2;
			await mergeSortRun(
				left,
				right,
				compareXY,
				async (merged, mergeState) => {
					next.push(merged);
					await advance(mergeState);
				},
				currentState,
				session,
				program,
			);
			return;
		}
		if (index < runs.length) {
			next.push(runs[index]);
			index += 1;
		}
		if (next.length <= 1) {
			await finish(next[0] ?? [], currentState);
			return;
		}
		await mergeSortLayer(next, compareXY, finish, currentState, session, program);
	};
	await advance(state);
}

async function mergeSortRun(left, right, compareXY, finish, state, session, program) {
	const merged = [];
	let leftIndex = 0;
	let rightIndex = 0;
	const step = async (currentState) => {
		if (leftIndex >= left.length) {
			for (; rightIndex < right.length; rightIndex += 1) {
				merged.push(right[rightIndex]);
			}
			await finish(merged, currentState);
			return;
		}
		if (rightIndex >= right.length) {
			for (; leftIndex < left.length; leftIndex += 1) {
				merged.push(left[leftIndex]);
			}
			await finish(merged, currentState);
			return;
		}
		await compareCallables(
			compareXY,
			left[leftIndex].item,
			right[rightIndex].item,
			async (sign, nextState) => {
				if (sign <= 0) {
					merged.push(left[leftIndex]);
					leftIndex += 1;
				} else {
					merged.push(right[rightIndex]);
					rightIndex += 1;
				}
				await step(nextState);
			},
			currentState,
			session,
			program,
		);
	};
	await step(state);
}

function isReducedValue(value) {
	return data().core.reduced_QMARK_(value);
}

function unreduceValue(value) {
	return data().core.unreduced(value);
}

/**
 * Async reducer driver for `transduce` when the xform or reducer cannot run
 * inside Cherry's synchronous reduce loop. Each step uses the machine
 * continuation, so interpreter functions and capability calls stay parked
 * correctly.
 */
async function startTransduceReduce(items, reducer, hasInitial, initial, state, session, program, haltContext = null) {
	const frame = {
		type: "transduceReduce",
		items,
		reducer,
		acc: hasInitial ? initial : MISSING,
		index: 0,
		haltContext,
	};
	if (!hasInitial) {
		if (items.length === 0) {
			state.kont.push({ type: "transduceReduceInit", run: frame });
			await applyCallable(state, reducer, [], session, program);
			return;
		}
		frame.acc = items[0];
		frame.index = 1;
	}
	await advanceTransduceReduce(frame, state, session, program);
}

async function advanceTransduceReduce(frame, state, session, program) {
	while (frame.index < frame.items.length) {
		const item = frame.items[frame.index];
		frame.index += 1;
		state.kont.push({ type: "transduceReduceStep", run: frame });
		await applyCallable(state, frame.reducer, [frame.acc, item], session, program);
		return;
	}
	await finishTransduceReduce(frame, state, session, program);
}

async function finishTransduceReduce(frame, state, session, program) {
	const context = frame.haltContext;
	if (context !== null && context.haltValue !== MISSING) {
		if (context.haltRetf !== null) {
			state.kont.push({ type: "transduceReduceHalt", run: frame });
			await applyCallable(state, context.haltRetf, [frame.acc, context.haltValue], session, program);
			return;
		}
		frame.acc = context.haltValue;
	}
	state.kont.push({ type: "transduceReduceFinish", run: frame });
	await applyCallable(state, frame.reducer, [frame.acc], session, program);
}

async function applyHof(name, args, state, session, program) {
	if (args.length === 1) {
		const callback = args[0];
		const cherry = (builder) => (canSyncCallable(callback) ? builder(toJsTransducerCallback(callback)) : null);
		switch (name) {
			case "map":
				ret(
					state,
					makeTransducer(
						[{ op: "map", fn: callback }],
						cherry((fn) => data().core.map(fn)),
					),
				);
				return;
			case "mapcat":
				ret(
					state,
					makeTransducer(
						[{ op: "mapcat", fn: callback }],
						cherry((fn) => data().core.mapcat(fn)),
					),
				);
				return;
			case "filter":
				ret(
					state,
					makeTransducer(
						[{ op: "filter", fn: callback, negate: false }],
						cherry((fn) => data().core.filter(fn)),
					),
				);
				return;
			case "remove":
				ret(
					state,
					makeTransducer(
						[{ op: "filter", fn: callback, negate: true }],
						cherry((fn) => data().core.remove(fn)),
					),
				);
				return;
			case "keep":
				ret(
					state,
					makeTransducer(
						[{ op: "keep", fn: callback }],
						cherry((fn) => data().core.keep(fn)),
					),
				);
				return;
			case "map-indexed":
				ret(
					state,
					makeTransducer(
						[{ op: "map-indexed", fn: callback }],
						cherry((fn) => data().core.map_indexed(fn)),
					),
				);
				return;
			case "keep-indexed":
				ret(
					state,
					makeTransducer(
						[{ op: "keep-indexed", fn: callback }],
						cherry((fn) => data().core.keep_indexed(fn)),
					),
				);
				return;
			case "take-while":
				ret(
					state,
					makeTransducer(
						[{ op: "take-while", fn: callback }],
						cherry((fn) => data().core.take_while(fn)),
					),
				);
				return;
			case "drop-while":
				ret(
					state,
					makeTransducer(
						[{ op: "drop-while", fn: callback }],
						cherry((fn) => data().core.drop_while(fn)),
					),
				);
				return;
			case "partition-by":
				ret(
					state,
					makeTransducer(
						[{ op: "partition-by", fn: callback }],
						cherry((fn) => data().core.partition_by(fn)),
					),
				);
				return;
			default:
				break;
		}
	}
	if (name !== "transduce" && name !== "sequence" && name !== "eduction" && name !== "into") {
		for (let index = 0; index < args.length; index += 1) {
			if (isEduction(args[index])) {
				args[index] = eductionToStream(args[index]);
			}
		}
	}
	if (name === "transduce") {
		arity("transduce", args, 3, 4);
		const resolved = resolveTransducerValue(args[0]);
		if (!isTransducer(resolved)) {
			fail("INVALID_ARGUMENT", "transduce expects a transducer", { value: safePrStr(resolved) });
		}
		const reducer = args[1];
		const hasInitial = args.length === 4;
		const initial = hasInitial ? args[2] : undefined;
		const merged = mergeEductionInput(args[args.length - 1], resolved);
		const cherry = merged.xform === null ? null : merged.xform.xform;
		const finiteSource =
			!containsLazyStream(merged.source) && !isLazySeqValue(merged.source) && !isUnboundedRange(merged.source);
		if (cherry !== null && canSyncCallable(reducer) && finiteSource) {
			ret(
				state,
				hasInitial
					? data().core.transduce(cherry, toJsReducer(reducer), initial, merged.source)
					: data().core.transduce(cherry, toJsReducer(reducer), merged.source),
			);
			return;
		}
		const stream = makeTransducerStream(merged.steps, merged.source);
		await realizeLazyInto(
			state,
			stream,
			async (values, nextState) => {
				await startTransduceReduce(
					seqToArray(values),
					reducer,
					hasInitial,
					initial,
					nextState,
					session,
					program,
					stream.transducerContext,
				);
			},
			state,
			session,
			program,
		);
		return;
	}
	if (name === "sequence") {
		arity(name, args, 1, Number.POSITIVE_INFINITY);
		const xform = composeTransducers(args.slice(0, -1).map(resolveTransducerValue), name);
		const merged = mergeEductionInput(args[args.length - 1], xform);
		ret(state, makeTransducerStream(merged.steps, merged.source));
		return;
	}
	if (name === "eduction") {
		arity(name, args, 2, Number.POSITIVE_INFINITY);
		const xform = composeTransducers(args.slice(0, -1).map(resolveTransducerValue), name);
		const merged = mergeEductionInput(args[args.length - 1], xform);
		ret(state, makeEduction(merged.steps, merged.source));
		return;
	}
	if (name === "into") {
		arity("into", args, 2, 3);
		const target = args[0];
		const xform = args.length === 3 ? resolveTransducerValue(args[1]) : null;
		if (xform !== null && !isTransducer(xform)) {
			fail("INVALID_ARGUMENT", "into expects a transducer as its second argument", { value: safePrStr(xform) });
		}
		const merged = mergeEductionInput(args[args.length - 1], xform);
		const cherry = merged.xform === null ? null : merged.xform.xform;
		if (merged.steps.length === 0) {
			if (isLazyStream(merged.source) || containsLazyStream(merged.source)) {
				await realizeLazyInto(
					state,
					merged.source,
					async (values, nextState) => {
						ret(nextState, data().core.into(target, values));
					},
					state,
					session,
					program,
				);
				return;
			}
			ret(state, data().core.into(target, seqToArray(merged.source)));
			return;
		}
		if (
			cherry !== null &&
			!containsLazyStream(merged.source) &&
			!isLazySeqValue(merged.source) &&
			!isUnboundedRange(merged.source)
		) {
			ret(state, data().core.into(target, cherry, merged.source));
			return;
		}
		const stream = makeTransducerStream(merged.steps, merged.source);
		await realizeLazyInto(
			state,
			stream,
			async (values, nextState) => {
				await startTransduceReduce(
					seqToArray(values),
					{ kind: "builtin", name: "conj" },
					true,
					target,
					nextState,
					session,
					program,
					stream.transducerContext,
				);
			},
			state,
			session,
			program,
		);
		return;
	}
	if (name === "clojure.string/replace" || name === "clojure.string/replace-first") {
		arity(name, args, 3);
		await startStringReplace(name, args, state, session, program);
		return;
	}
	if (name === "map" || name === "mapcat") {
		const sources = args.slice(1);
		if (sources.some((source) => isLazyStream(source))) {
			arity(name, args, 2, Number.POSITIVE_INFINITY);
			ret(state, new LazyStream(name === "map" ? mapStreamLazy(args[0], sources) : mapcatStreamLazy(args[0], sources)));
			return;
		}
	}
	if ((name === "filter" || name === "remove") && isLazyStream(args[1])) {
		arity(name, args, 2);
		ret(state, new LazyStream(filterStreamLazy(args[0], args[1], name === "remove")));
		return;
	}
	if (name === "keep" && isLazyStream(args[1])) {
		arity(name, args, 2);
		ret(state, new LazyStream(keepStreamLazy(args[0], args[1])));
		return;
	}
	if ((name === "map-indexed" || name === "keep-indexed") && isLazyStream(args[1])) {
		arity(name, args, 2);
		ret(state, new LazyStream(mapIndexedStreamLazy(args[0], args[1], name === "keep-indexed")));
		return;
	}
	if ((name === "take-while" || name === "drop-while") && isLazyStream(args[1])) {
		arity(name, args, 2);
		ret(
			state,
			new LazyStream(
				name === "take-while" ? takeWhileStreamLazy(args[0], args[1]) : dropWhileStreamLazy(args[0], args[1]),
			),
		);
		return;
	}
	if (LAZY_PREDICATES.has(name) && args.length === 2 && (isLazyStream(args[1]) || isUnboundedRange(args[1]))) {
		arity(name, args, 2);
		await startLazyPredicate(name, args[0], args[1], state, session, program);
		return;
	}
	if (
		["reduce", "apply", "some", "every?", "mapv", "filterv", "group-by", "sort-by", "reduce-kv"].includes(name) &&
		args.some((argument) => isLazyStream(argument))
	) {
		const frame = { type: "lazyPrepare", name, args, index: 0, resolved: [] };
		await lazyPrepareNext(frame, state, session, program);
		return;
	}
	if (name === "reduce-kv") {
		arity(name, args, 3);
		const collection = args[2];
		let entries;
		if (data().isMap(collection)) {
			entries = data().mapEntries(collection);
		} else if (data().isVector(collection)) {
			entries = seqToArray(collection).map((value, index) => [index, value]);
		} else {
			fail("INVALID_ARGUMENT", "reduce-kv expects a map or vector", { value: safePrStr(collection) });
		}
		const frame = {
			type: "hof",
			kind: "reduce-kv",
			fn: args[0],
			entries,
			index: 0,
			acc: args[1],
		};
		if (entries.length === 0) {
			ret(state, frame.acc);
			return;
		}
		state.kont.push(frame);
		await applyCallable(state, frame.fn, [frame.acc, entries[0][0], entries[0][1]], session, program);
		return;
	}
	if (name === "reductions") {
		arity(name, args, 2, 3);
		const fn = args[0];
		if (canSyncCallable(fn) && !isLazyStream(args[args.length - 1])) {
			const adapter = (accumulator, item) => syncCallable(fn, [accumulator, item]);
			const rest = args.slice(1);
			ret(
				state,
				rest.length === 1
					? data().core.reductions(adapter, rest[0])
					: data().core.reductions(adapter, rest[0], rest[1]),
			);
			return;
		}
		const rest = args.slice(1);
		const hasInitial = rest.length === 2;
		ret(state, new LazyStream(reductionsLazy(fn, rest[rest.length - 1], hasInitial, hasInitial ? rest[0] : undefined)));
		return;
	}
	if (name === "partition-by" || name === "split-with" || name === "run!") {
		arity(name, args, 2);
		if (name === "partition-by" && canSyncCallable(args[0]) && !isLazyStream(args[1])) {
			ret(
				state,
				data().core.partition_by((item) => syncCallable(args[0], [item]), args[1]),
			);
			return;
		}
		if (name === "split-with" && canSyncCallable(args[0]) && !isLazyStream(args[1])) {
			ret(
				state,
				data().core.split_with((item) => syncCallable(args[0], [item]), args[1]),
			);
			return;
		}
		if (name === "partition-by") {
			ret(state, new LazyStream(partitionByLazy(args[0], args[1])));
			return;
		}
		if (name === "split-with") {
			ret(
				state,
				data().vectorFromArray([
					new LazyStream(takeWhileLazy(args[0], args[1])),
					new LazyStream(dropWhileLazy(args[0], args[1])),
				]),
			);
			return;
		}
		if (name === "run!" && (isLazyStream(args[1]) || isUnboundedRange(args[1]))) {
			await startLazyRunBang(args[0], args[1], state, session, program);
			return;
		}
		const items = seqToArray(args[1]);
		if (items.length === 0) {
			ret(
				state,
				name === "run!"
					? null
					: name === "split-with"
						? data().vectorFromArray([data().vectorFromArray([]), data().vectorFromArray([])])
						: data().vectorFromArray([]),
			);
			return;
		}
		const frame = {
			type: "hof",
			kind: name,
			fn: args[0],
			items,
			index: 0,
			pendingItem: items[0],
			groups: [],
			current: [],
			currentKey: MISSING,
			taken: [],
		};
		state.kont.push(frame);
		await applyCallable(state, frame.fn, [items[0]], session, program);
		return;
	}
	if (name === "tree-seq") {
		arity(name, args, 3);
		if (canSyncCallable(args[0]) && canSyncCallable(args[1])) {
			ret(
				state,
				data().core.tree_seq(
					(node) => syncCallable(args[0], [node]),
					(node) => syncCallable(args[1], [node]),
					args[2],
				),
			);
			return;
		}
		ret(state, new LazyStream(treeSeqLazy(args[0], args[1], args[2])));
		return;
	}
	if (name === "trampoline") {
		arity(name, args, 1, Number.POSITIVE_INFINITY);
		state.kont.push({ type: "trampoline" });
		await applyCallable(state, args[0], args.slice(1), session, program);
		return;
	}
	if (name === "update") {
		arity(name, args, 3, Number.POSITIVE_INFINITY);
		const frame = {
			type: "hof",
			kind: "update",
			fn: args[2],
			map: args[0],
			key: args[1],
			args: args.slice(3),
			items: [],
			index: 0,
			acc: null,
			pendingItem: null,
		};
		state.kont.push(frame);
		await applyCallable(state, frame.fn, [mapGet(frame.map, frame.key, null), ...frame.args], session, program);
		return;
	}
	if (name === "sort-by") {
		arity(name, args, 2, 3);
		const keyFn = args[0];
		const comparator = args.length === 3 ? args[1] : null;
		if (!isCallableValue(keyFn)) {
			fail("INVALID_ARGUMENT", "sort-by expects a callable key function", { value: safePrStr(keyFn) });
		}
		if (comparator !== null && !isCallableValue(comparator)) {
			fail("INVALID_ARGUMENT", "sort-by expects a callable comparator", { value: safePrStr(comparator) });
		}
		const items = seqToArray(args[args.length - 1]);
		await startSortBy(keyFn, comparator, items, state, session, program);
		return;
	}
	if (
		name === "map-indexed" ||
		name === "keep-indexed" ||
		name === "group-by" ||
		name === "take-while" ||
		name === "drop-while" ||
		name === "clojure.set/select"
	) {
		arity(name, args, 2);
		const items = seqToArray(args[1]);
		const frame = {
			type: "hof",
			kind: name,
			fn: args[0],
			items,
			index: 0,
			acc: name === "group-by" ? data().emptyMap() : [],
			pendingItem: null,
			dropping: name === "drop-while",
		};
		if (items.length === 0) {
			ret(state, name === "group-by" ? frame.acc : data().vectorFromArray([]));
			return;
		}
		frame.pendingItem = items[0];
		state.kont.push(frame);
		await applyCallable(
			state,
			frame.fn,
			name === "map-indexed" || name === "keep-indexed" ? [0, items[0]] : [items[0]],
			session,
			program,
		);
		return;
	}
	if (name === "clojure.walk/walk" || name === "clojure.set/walk") {
		arity(name, args, 3);
		const kind = walkKind(args[2]);
		const frame = {
			type: "walkLevel",
			inner: args[0],
			outer: args[1],
			value: args[2],
			kind,
			children: kind === null ? [] : walkChildren(args[2], kind),
			index: 0,
			results: [],
			phase: "inner",
			built: null,
			pending: null,
		};
		await walkLevelNext(state, frame, session, program);
		return;
	}
	if (name === "clojure.walk/postwalk" || name === "clojure.walk/prewalk") {
		arity(name, args, 2);
		const frame = {
			type: "walk",
			mode: name === "clojure.walk/prewalk" ? "pre" : "post",
			fn: args[0],
			queue: [{ op: "visit", value: args[1] }],
			results: [],
			pending: null,
		};
		await walkNext(state, frame, session, program);
		return;
	}
	if (name === "apply") {
		arity("apply", args, 2, Number.POSITIVE_INFINITY);
		const target = args[0];
		const middle = args.slice(1, -1);
		const tail = seqToArray(args[args.length - 1]);
		await applyCallable(state, target, [...middle, ...tail], session, program);
		return;
	}
	if (name === "reduce") {
		arity("reduce", args, 2, 3);
		const fn = args[0];
		const items = seqToArray(args[args.length - 1]);
		const hasInitial = args.length === 3;
		if (items.length === 0 && !hasInitial) {
			await applyCallable(state, fn, [], session, program);
			return;
		}
		const frame = {
			type: "hof",
			kind: "reduce",
			fn,
			items,
			index: hasInitial ? 0 : 1,
			acc: hasInitial ? args[1] : items[0],
			result: null,
			pendingItem: null,
		};
		if (items.length === 0) {
			ret(state, frame.acc);
			return;
		}
		frame.pendingItem = items[frame.index];
		state.kont.push(frame);
		await applyCallable(state, fn, [frame.acc, frame.pendingItem], session, program);
		return;
	}

	const multiple = name === "map" || name === "mapv" || name === "mapcat";
	arity(name, args, 2, multiple ? Number.POSITIVE_INFINITY : 2);
	const fn = args[0];
	const collections = args.slice(1).map((collection) => seqToArray(collection));
	const count = Math.min(...collections.map((collection) => collection.length));
	const frame = {
		type: "hof",
		kind: name,
		fn,
		collections,
		items: collections[0],
		index: 0,
		acc: [],
		result: null,
		pendingItem: null,
		pendingArgs: null,
	};
	if (count === 0) {
		ret(state, name === "every?" ? true : name === "some" ? null : data().vectorFromArray([]));
		return;
	}
	frame.pendingArgs = collections.map((collection) => collection[0]);
	frame.pendingItem = frame.pendingArgs[0];
	state.kont.push(frame);
	await applyCallable(state, fn, multiple ? frame.pendingArgs : [frame.pendingItem], session, program);
}

async function handleHofResult(frame, value, state, session, program) {
	if (frame.kind === "update") {
		ret(state, data().assoc(frame.map, frame.key, value));
		return;
	}
	if (frame.kind === "reduce-kv") {
		frame.acc = value;
		frame.index += 1;
		if (frame.index < frame.entries.length) {
			state.kont.push(frame);
			const entry = frame.entries[frame.index];
			await applyCallable(state, frame.fn, [frame.acc, entry[0], entry[1]], session, program);
			return;
		}
		ret(state, frame.acc);
		return;
	}
	if (frame.kind === "reductions") {
		frame.results.push(value);
		frame.acc = value;
		frame.index += 1;
		if (frame.index < frame.items.length) {
			state.kont.push(frame);
			await applyCallable(state, frame.fn, [frame.acc, frame.items[frame.index]], session, program);
			return;
		}
		ret(state, data().vectorFromArray(frame.results));
		return;
	}
	if (frame.kind === "partition-by") {
		const item = frame.pendingItem;
		if (frame.currentKey === MISSING || cljEquals(frame.currentKey, value)) {
			frame.current.push(item);
			frame.currentKey = value;
		} else {
			frame.groups.push(data().vectorFromArray(frame.current));
			frame.current = [item];
			frame.currentKey = value;
		}
		frame.index += 1;
		if (frame.index < frame.items.length) {
			frame.pendingItem = frame.items[frame.index];
			state.kont.push(frame);
			await applyCallable(state, frame.fn, [frame.pendingItem], session, program);
			return;
		}
		frame.groups.push(data().vectorFromArray(frame.current));
		ret(state, data().vectorFromArray(frame.groups));
		return;
	}
	if (frame.kind === "split-with") {
		if (truthy(value)) {
			frame.taken.push(frame.pendingItem);
			frame.index += 1;
			if (frame.index < frame.items.length) {
				frame.pendingItem = frame.items[frame.index];
				state.kont.push(frame);
				await applyCallable(state, frame.fn, [frame.pendingItem], session, program);
				return;
			}
			ret(state, data().vectorFromArray([data().vectorFromArray(frame.taken), data().vectorFromArray([])]));
			return;
		}
		ret(
			state,
			data().vectorFromArray([
				data().vectorFromArray(frame.taken),
				data().vectorFromArray(frame.items.slice(frame.index)),
			]),
		);
		return;
	}
	if (frame.kind === "run!") {
		frame.index += 1;
		if (frame.index < frame.items.length) {
			state.kont.push(frame);
			await applyCallable(state, frame.fn, [frame.items[frame.index]], session, program);
			return;
		}
		ret(state, null);
		return;
	}
	switch (frame.kind) {
		case "map":
		case "mapv":
			frame.acc.push(value);
			break;
		case "mapcat":
			for (const item of seqToArray(value)) {
				frame.acc.push(item);
			}
			break;
		case "keep":
			if (value !== null) {
				frame.acc.push(value);
			}
			break;
		case "filter":
		case "filterv":
			if (truthy(value)) {
				frame.acc.push(frame.pendingItem);
			}
			break;
		case "remove":
			if (!truthy(value)) {
				frame.acc.push(frame.pendingItem);
			}
			break;
		case "reduce":
			frame.acc = value;
			break;
		case "some":
			if (truthy(value)) {
				ret(state, value);
				return;
			}
			break;
		case "every?":
			if (!truthy(value)) {
				ret(state, false);
				return;
			}
			break;
		case "not-any?":
			if (truthy(value)) {
				ret(state, false);
				return;
			}
			break;
		case "not-every?":
			if (!truthy(value)) {
				ret(state, true);
				return;
			}
			break;
		case "map-indexed":
			frame.acc.push(value);
			break;
		case "keep-indexed":
			if (value !== null) {
				frame.acc.push(value);
			}
			break;
		case "group-by": {
			const existing = mapGet(frame.acc, value, data().vectorFromArray([]));
			frame.acc = data().assoc(frame.acc, value, data().conj(existing, frame.pendingItem));
			break;
		}
		case "take-while":
			if (!truthy(value)) {
				ret(state, data().vectorFromArray(frame.acc));
				return;
			}
			frame.acc.push(frame.pendingItem);
			break;
		case "drop-while":
			if (frame.dropping) {
				if (truthy(value)) {
					break;
				}
				frame.dropping = false;
				frame.acc.push(frame.pendingItem);
			} else {
				frame.acc.push(frame.pendingItem);
				frame.acc.push(...frame.items.slice(frame.index + 1));
				ret(state, data().vectorFromArray(frame.acc));
				return;
			}
			break;
		case "clojure.set/select":
			if (truthy(value)) {
				frame.acc.push(frame.pendingItem);
			}
			break;
		default:
			fail("INVALID_ARGUMENT", "Unknown higher-order function", { function: frame.kind });
	}

	frame.index += 1;
	const count = frame.collections
		? Math.min(...frame.collections.map((collection) => collection.length))
		: frame.items.length;
	if (frame.index >= count) {
		if (frame.kind === "some") {
			ret(state, null);
		} else if (frame.kind === "every?") {
			ret(state, true);
		} else if (frame.kind === "not-any?") {
			ret(state, true);
		} else if (frame.kind === "not-every?") {
			ret(state, false);
		} else if (frame.kind === "reduce") {
			ret(state, frame.acc);
		} else if (frame.kind === "group-by") {
			ret(state, frame.acc);
		} else if (frame.kind === "clojure.set/select") {
			ret(state, data().setFromArray(frame.acc));
		} else {
			ret(state, data().vectorFromArray(frame.acc));
		}
		return;
	}

	frame.pendingArgs = frame.collections
		? frame.collections.map((collection) => collection[frame.index])
		: [frame.items[frame.index]];
	frame.pendingItem = frame.pendingArgs[0];
	state.kont.push(frame);
	if (frame.kind === "reduce") {
		await applyCallable(state, frame.fn, [frame.acc, frame.pendingItem], session, program);
	} else if (frame.kind === "map-indexed" || frame.kind === "keep-indexed") {
		await applyCallable(state, frame.fn, [frame.index, frame.pendingItem], session, program);
	} else if (frame.kind === "map" || frame.kind === "mapv" || frame.kind === "mapcat") {
		await applyCallable(state, frame.fn, frame.pendingArgs, session, program);
	} else {
		await applyCallable(state, frame.fn, [frame.pendingItem], session, program);
	}
}

function capabilityArgument(name, args) {
	if (args.length !== 1) {
		fail("INVALID_ARGUMENT", `${name} takes exactly one EDN map argument`, { got: args.length });
	}
	if (!data().isMap(args[0])) {
		fail("INVALID_ARGUMENT", `${name} expects an EDN map argument`, { got: safePrStr(args[0]) });
	}
	return args[0];
}

function capabilityObject(argument) {
	const object = Object.create(null);
	for (const [key, value] of data().mapEntries(argument)) {
		if (data().isKeyword(key)) {
			const namespace = data().namespace(key);
			const name = data().name(key);
			object[namespace === null || namespace === undefined ? name : `${namespace}/${name}`] = value;
		} else if (data().isSymbol(key)) {
			const namespace = data().namespace(key);
			const name = data().name(key);
			object[namespace === null || namespace === undefined ? name : `${namespace}/${name}`] = value;
		} else if (typeof key === "string") {
			object[key] = value;
		} else {
			fail("INVALID_ARGUMENT", "Capability map keys must be keywords or strings", {
				key: safePrStr(key),
			});
		}
	}
	return object;
}

function wherePayload(needle, result) {
	const entries = [
		[V("kind"), V(result.kind)],
		[V("needle"), needle],
	];
	if (result.kind === "ambiguous") {
		const candidates = result.candidates.map((candidate) =>
			data().mapFromEntries([
				[V("span"), data().vectorFromArray(candidate.span)],
				[V("context"), candidate.context],
			]),
		);
		entries.push([V("candidates"), data().vectorFromArray(candidates)]);
		if (result.truncated) {
			entries.push([V("truncated"), true]);
		}
	} else {
		let nearest = null;
		if (result.nearest !== null) {
			const nearestEntries = [
				[V("span"), data().vectorFromArray(result.nearest.span)],
				[V("text"), result.nearest.text],
				[V("distance"), result.nearest.distance],
			];
			if (result.nearest.truncated) {
				nearestEntries.push([V("truncated"), true]);
			}
			nearest = data().mapFromEntries(nearestEntries);
		}
		entries.push([V("nearest"), nearest]);
		entries.push([V("budget-exhausted"), result.budgetExhausted]);
	}
	return data().mapFromEntries(entries);
}

const STAMP_ALIASES = [
	["mtimeSec", "mtime-sec"],
	["mtimeNsec", "mtime-nsec"],
];

function withAliases(map, aliases) {
	let result = map;
	for (const [from, to] of aliases) {
		const value = mapGet(result, V(from), MISSING);
		if (value !== MISSING && mapGet(result, V(to), MISSING) === MISSING) {
			result = mapAssoc(result, V(to), value);
		}
	}
	return result;
}

function normalizeStat(map) {
	return withAliases(map, [...STAMP_ALIASES, ["isDir", "is-dir"], ["isFile", "is-file"], ["isSymlink", "is-symlink"]]);
}

function normalizeLs(map) {
	const entries = mapGet(map, V("entries"), MISSING);
	if (entries === MISSING || !data().isVector(entries)) {
		return map;
	}
	const normalizedEntries = seqToArray(entries).map((entry) =>
		data().isMap(entry)
			? withAliases(entry, [
					["isDir", "is-dir"],
					["isFile", "is-file"],
					["isSymlink", "is-symlink"],
				])
			: entry,
	);
	return mapAssoc(map, V("entries"), data().vectorFromArray(normalizedEntries));
}

function recordRead(program, argument, result) {
	const path = mapGet(argument, V("path"), null);
	if (typeof path !== "string") {
		return;
	}
	const exists = data().isMap(result) ? mapGet(result, V("exists"), true) : true;
	if (exists === false) {
		program.readSet.push({ path, stamp: null, exists: false });
		return;
	}
	let stamp = data().isMap(result) ? mapGet(result, V("stamp"), MISSING) : MISSING;
	if (stamp === MISSING && data().isMap(result)) {
		const mtimeSec = mapGet(result, V("mtime-sec"), MISSING);
		const mtimeNsec = mapGet(result, V("mtime-nsec"), MISSING);
		const size = mapGet(result, V("size"), MISSING);
		if (mtimeSec !== MISSING && mtimeNsec !== MISSING && size !== MISSING) {
			stamp = data().mapFromEntries([
				[V("mtime-sec"), mtimeSec],
				[V("mtime-nsec"), mtimeNsec],
				[V("size"), size],
			]);
		}
	}
	if (stamp === MISSING || stamp === null) {
		return;
	}
	if (data().isMap(stamp)) {
		stamp = withAliases(stamp, STAMP_ALIASES);
	}
	program.readSet.push({ path, stamp: ednSafe(stamp) });
}

const PORT_GRACE_MS = 100;

function trackPortPromise(value) {
	const pending = { promise: null, settled: false, result: undefined, error: null };
	if (!isThenable(value)) {
		pending.settled = true;
		pending.result = value;
		return pending;
	}
	pending.promise = value;
	value.then(
		(result) => {
			pending.settled = true;
			pending.result = result;
		},
		(error) => {
			pending.settled = true;
			pending.error = error;
		},
	);
	return pending;
}

function invokePort(fn, args) {
	try {
		return trackPortPromise(fn(args));
	} catch (error) {
		return { promise: null, settled: true, result: undefined, error };
	}
}

/**
 * Race a port promise against the program deadline/abort. The promise is never
 * cancelled: a commit that reached `:applying` keeps running in the port.
 */
async function settleTrackedPort(pending, program) {
	if (pending.settled) {
		return pending.error !== null
			? { status: "rejected", error: pending.error }
			: { status: "settled", result: pending.result };
	}
	const control = program.control;
	if (control === null) {
		try {
			const result = await pending.promise;
			return { status: "settled", result };
		} catch (error) {
			return { status: "rejected", error };
		}
	}
	let signal;
	try {
		signal = await Promise.race([pending.promise, control.promise]);
	} catch (error) {
		return { status: "rejected", error };
	}
	if (signal instanceof WaitSignal) {
		if (signal.kind === "deadline") {
			return { status: "deadline" };
		}
		const settled = await settleWithin(pending.promise, PORT_GRACE_MS);
		if (settled === null) {
			return { status: "abandoned", reason: signal.reason };
		}
		return settled.ok ? { status: "settled", result: settled.value } : { status: "rejected", error: settled.error };
	}
	return { status: "settled", result: signal };
}

async function commitProgram(session, program, value) {
	if (program.pendingCommit === null && !program.dirty && program.readSet.length === 0) {
		return null;
	}
	if (program.pendingCommit === null) {
		if (typeof session.ports.commit !== "function") {
			fail("HOST_API_MISMATCH", "Pending VFS changes need a commit port", {
				missing: "commit",
				program: program.name,
			});
		}
		program.commitAttempted = true;
		program.commitValue = value;
		program.pendingCommit = invokePort(session.ports.commit, {
			session,
			program,
			name: program.name,
			value: ednSafe(value),
			readSet: program.readSet.slice(),
			capabilities: [...program.allowedNames],
			writeSetEmpty: !program.dirty,
		});
	}
	const outcome = await settleTrackedPort(program.pendingCommit, program);
	if (outcome.status === "deadline") {
		throw new ParkSignal("deadline", null);
	}
	if (outcome.status === "abandoned") {
		throw new SessionAbort(outcome.reason ?? "operator");
	}
	program.pendingCommit = null;
	if (outcome.status === "rejected") {
		program.commitValue = undefined;
		throw outcome.error;
	}
	const normalized = normalizeResult(outcome.result);
	checkFailureEnvelope(normalized);
	program.dirty = false;
	program.readSet = [];
	program.commitAttempted = false;
	program.commitValue = undefined;
	return normalized === null ? null : ednSafe(normalized);
}

async function discardProgram(session, program) {
	if (typeof session.ports.discard !== "function") {
		program.dirty = false;
		program.readSet = [];
		return true;
	}
	program.pendingDiscard = invokePort(session.ports.discard, { session, program });
	const outcome = await settleTrackedPort(program.pendingDiscard, program);
	if (outcome.status === "rejected") {
		program.pendingDiscard = null;
		program.discardUncertain = true;
		return false;
	}
	if (outcome.status !== "settled") {
		program.discardUncertain = true;
		return false;
	}
	program.pendingDiscard = null;
	program.discardUncertain = false;
	program.dirty = false;
	program.readSet = [];
	return true;
}

async function invokeCapability(name, args, state, session, program) {
	const argument = capabilityArgument(name, args);

	if (name === "park") {
		const payload = mapGet(argument, V("payload"), argument);
		throw new ParkSignal("explicit", normalizeResult(payload));
	}
	if (name === "where") {
		const content = mapGet(argument, V("content"), MISSING);
		const needle = mapGet(argument, V("needle"), MISSING);
		if (typeof content !== "string" || typeof needle !== "string") {
			fail("INVALID_ARGUMENT", "where needs string :content and :needle", { function: "where" });
		}
		const result = findUnique(content, needle);
		if (result.kind === "unique") {
			return data().vectorFromArray(result.span);
		}
		throw new ParkSignal("where-ambiguous", wherePayload(needle, result));
	}
	if (name === "whereAll") {
		const content = mapGet(argument, V("content"), MISSING);
		const needle = mapGet(argument, V("needle"), MISSING);
		if (typeof content !== "string" || typeof needle !== "string") {
			fail("INVALID_ARGUMENT", "whereAll needs string :content and :needle", { function: "whereAll" });
		}
		return data().vectorFromArray(findAll(content, needle).map((span) => data().vectorFromArray(span)));
	}
	if (name === "unpark") {
		const target = mapGet(argument, V("name"), MISSING);
		if (typeof target !== "string") {
			fail("INVALID_ARGUMENT", "unpark needs a string :name", { function: "unpark" });
		}
		const value = mapGet(argument, V("value"), null);
		state.awaited = true;
		const receipt = await unparkProgram(session, {
			name: target,
			value,
			callerName: program.name,
			intentInfo: program.intentInfo,
		});
		return normalizeResult(receipt);
	}
	const capability = program.capabilities.get(name);
	if (typeof capability !== "function") {
		fail("CAPABILITY_DENIED", `Capability ${name} is not available`, { capability: name });
	}
	state.awaited = true;
	const raw = capability(capabilityObject(argument), { session, program, map: argument });
	const finish = (result) => {
		let normalized = normalizeResult(result);
		checkFailureEnvelope(normalized);
		if (name === "stat" && data().isMap(normalized)) {
			normalized = normalizeStat(normalized);
		}
		if (name === "ls" && data().isMap(normalized)) {
			normalized = normalizeLs(normalized);
		}
		if (READ_CAPABILITIES.has(name)) {
			recordRead(program, argument, normalized);
			if (name === "cat" && data().isMap(normalized)) {
				const content = mapGet(normalized, V("content"), MISSING);
				if (content !== MISSING) {
					return content;
				}
			}
		}
		if (WRITE_CAPABILITIES.has(name)) {
			program.dirty = true;
		}
		return normalized;
	};
	return isThenable(raw) ? awaitAsync(raw, finish, state, program, { capability: name, argument }) : finish(raw);
}

function buildReceipt(entries) {
	const receipt = new Map();
	for (const [key, value] of entries) {
		receipt.set(EDN_K(key), value);
	}
	return receipt;
}

function completedReceipt(program, value, commit) {
	const entries = [
		["name", program.name],
		["state", EDN_K(COMPLETED)],
		["value", ednSafe(value)],
	];
	if (commit !== null && commit !== undefined) {
		entries.push(["commit", commit]);
	}
	return buildReceipt(entries);
}

function safeEdnValue(value) {
	try {
		return ednSafe(value);
	} catch {
		return null;
	}
}

function abandonedCapabilityValue(pending) {
	return buildReceipt([
		["capability", pending.capability],
		["argument", safeEdnValue(pending.argument)],
		["status", EDN_K("outcome-unknown")],
		["settled", pending.settled === true],
		["outcome", pending.settled === true ? EDN_K(pending.error !== null ? "rejected" : "completed") : null],
		["result", pending.settled === true && pending.error === null ? safeEdnValue(pending.result) : null],
		[
			"error",
			pending.settled === true && pending.error !== null
				? safeEdnValue({
						code: pending.error?.code ?? null,
						message: pending.error?.message ?? String(pending.error),
					})
				: null,
		],
	]);
}

function failureExtras(program) {
	const extras = [];
	if (program.abandonedCapabilities.length > 0) {
		extras.push(["interrupted-capabilities", program.abandonedCapabilities.map(abandonedCapabilityValue)]);
	}
	if (program.pendingCommit !== null) {
		extras.push([
			"commit",
			buildReceipt([
				["status", EDN_K("uncertain")],
				["pending", true],
			]),
		]);
	}
	if (program.discardUncertain) {
		extras.push([
			"discard",
			buildReceipt([
				["status", EDN_K("uncertain")],
				["pending", program.pendingDiscard !== null],
			]),
		]);
	}
	return extras;
}

function failedReceipt(program, error, extras = []) {
	if (error instanceof SessionAbort) {
		return buildReceipt([
			["name", program.name],
			["state", EDN_K(FAILED)],
			["reason", EDN_K("aborted")],
			["source", program.source],
			...extras,
		]);
	}
	const code = normalizeCode(error?.code ?? "INVALID_ARGUMENT");
	const message = typeof error?.message === "string" ? error.message : "program failed";
	const data = error instanceof ProgramThrow ? { value: ednSafe(error.value) } : ednSafe(error?.data ?? {});
	return buildReceipt([
		["name", program.name],
		["state", EDN_K(FAILED)],
		[
			"error",
			buildReceipt([
				["code", EDN_K(code)],
				["message", message],
				["data", data],
			]),
		],
		["source", program.source],
		...extras,
	]);
}

function parkedReceipt(program, signal, session) {
	const remaining = Math.max(0, program.deadlineAt - session.now());
	const entries = [
		["name", program.name],
		["state", EDN_K(PARKED)],
		["reason", EDN_K(signal.reason)],
		["payload", ednSafe(signal.payload)],
		["source", program.source],
		["remaining-wait-ms", remaining],
	];
	if (program.pendingCommit !== null) {
		entries.push([
			"commit",
			buildReceipt([
				["status", EDN_K("pending")],
				["pending", true],
			]),
		]);
	}
	if (signal.reason === "ask") {
		entries.push(["interrupt", true]);
	}
	return buildReceipt(entries);
}

function caughtValue(error) {
	if (error instanceof ProgramThrow) {
		return error.value;
	}
	const code = normalizeCode(error?.code ?? "INVALID_ARGUMENT");
	const message = typeof error?.message === "string" ? error.message : String(error);
	return data().mapFromEntries([
		[V("code"), data().keyword(code)],
		[V("message"), message],
		[V("data"), normalizeResult(ednSafe(error?.data ?? {}))],
	]);
}

async function resumeTry(state, error) {
	let searchFrom = state.kont.length - 1;
	for (;;) {
		let index = -1;
		for (let cursor = searchFrom; cursor >= 0; cursor -= 1) {
			if (state.kont[cursor]?.type === "try") {
				index = cursor;
				break;
			}
		}
		if (index === -1) {
			return false;
		}
		const frame = state.kont[index];
		state.kont.length = index;
		const value = caughtValue(error);
		for (const clause of frame.catches ?? []) {
			if (!catchMatches(clause.match, value, error)) {
				continue;
			}
			state.kont.push({
				type: "try",
				catches: [],
				finallyBody: frame.finallyBody,
				env: frame.env,
			});
			bindPatternAsync(clause.symbol, value, frame.env, state, (environment, nextState) => {
				startBody(nextState, clause.body, environment);
			});
			return true;
		}
		if (frame.finallyBody.length > 0) {
			state.kont.push({
				type: "finally",
				body: frame.finallyBody,
				env: frame.env,
				value: null,
				rethrow: error,
			});
			startBody(state, frame.finallyBody, frame.env);
			return true;
		}
		searchFrom = index - 1;
	}
}

async function executeProgram(session, program, initialState) {
	if (DATA === null) {
		await ensureDataRuntime(session);
	}
	if (program.control === null) {
		createControl(program, session);
	}
	let state = initialState;
	const interval = Math.max(1, Math.floor(session.limits.deadlineCheckInterval ?? 1024));
	let steps = 0;
	let rootContinuation = null;

	try {
		for (;;) {
			while (!state.done) {
				if (program.aborted !== null) {
					throw new SessionAbort(program.aborted.reason);
				}
				if (state.awaited || steps % interval === 0) {
					state.awaited = false;
					if (session.now() >= program.deadlineAt) {
						const signal = new ParkSignal("deadline", null);
						signal.checkpoint = {
							mode: state.mode,
							control: state.control,
							env: state.env,
							value: state.value,
							awaited: state.awaited,
						};
						throw signal;
					}
				}
				steps += 1;
				try {
					await step(session, program, state);
				} catch (error) {
					if (!(error instanceof ParkSignal) && !(error instanceof SessionAbort) && (await resumeTry(state, error))) {
						continue;
					}
					throw error;
				}
			}
			if (isLazyStream(state.value)) {
				const rootState = {
					mode: "return",
					control: null,
					env: null,
					value: null,
					kont: [],
					done: false,
					awaited: false,
				};
				const frame = {
					type: "lazyRealize",
					stream: state.value,
					mode: "root",
					target: MAX_MATERIALIZED_ITEMS,
					values: [],
					sourceIndex: 0,
					awaiting: false,
				};
				rootContinuation = rootState;
				await lazyRealizeNext(frame, rootState, session, program);
				rootContinuation = null;
				state = rootState;
				continue;
			}
			if (hasLazyStream(state.value)) {
				const rootState = {
					mode: "return",
					control: null,
					env: null,
					value: null,
					kont: [],
					done: false,
					awaited: false,
				};
				rootContinuation = rootState;
				await deepResolveValue(
					state.value,
					async (resolved, finalState) => {
						ret(finalState, resolved);
					},
					rootState,
					session,
					program,
				);
				rootContinuation = null;
				state = rootState;
				continue;
			}
			break;
		}

		if (state.value instanceof RecurSignal) {
			fail("INVALID_ARGUMENT", "recur has no enclosing loop");
		}
		const finalValue = program.commitValue !== undefined ? program.commitValue : state.value;
		const commit = await commitProgram(session, program, finalValue);
		disposeControl(program);
		program.pending = null;
		program.pendingDiscard = null;
		program.discardUncertain = false;
		program.state = COMPLETED;
		program.kont = null;
		return completedReceipt(program, finalValue, commit);
	} catch (error) {
		if (error instanceof ParkSignal) {
			disposeControl(program);
			program.state = PARKED;
			program.parkReason = error.reason;
			program.parkCheckpoint = error.checkpoint ?? null;
			program.kont = (rootContinuation !== null ? rootContinuation.kont : state.kont).slice();
			return parkedReceipt(program, error, session);
		}
		if (error instanceof SessionAbort) {
			const commitPending = program.pendingCommit !== null;
			program.pending = null;
			if (!commitPending) {
				await discardProgram(session, program);
			}
			disposeControl(program);
			program.state = FAILED;
			program.kont = null;
			return failedReceipt(program, error, failureExtras(program));
		}
		if (!program.commitAttempted) {
			await discardProgram(session, program);
		}
		disposeControl(program);
		program.pending = null;
		program.state = FAILED;
		program.kont = null;
		return failedReceipt(program, error, failureExtras(program));
	}
}

async function step(session, program, state) {
	if (state.mode === "eval") {
		await evalStep(session, program, state);
	} else {
		await returnStep(session, program, state);
	}
}

function makeSession(options = {}) {
	const allowedCapabilities = new Set();
	let capabilityTable = null;

	if (Array.isArray(options.allowedCapabilities)) {
		for (const name of options.allowedCapabilities) {
			if (typeof name === "string") {
				allowedCapabilities.add(name);
			}
		}
	} else if (options.allowedCapabilities instanceof Set) {
		for (const name of options.allowedCapabilities) {
			allowedCapabilities.add(name);
		}
	}

	if (options.capabilities instanceof Map) {
		capabilityTable = options.capabilities;
		for (const name of capabilityTable.keys()) {
			allowedCapabilities.add(name);
		}
	} else if (isPlainObject(options.capabilities)) {
		capabilityTable = new Map(Object.entries(options.capabilities));
		for (const name of capabilityTable.keys()) {
			allowedCapabilities.add(name);
		}
	} else if (Array.isArray(options.capabilities)) {
		for (const name of options.capabilities) {
			allowedCapabilities.add(name);
		}
	}

	return {
		agentId: typeof options.agentId === "string" ? options.agentId : "sandbox",
		role: typeof options.role === "string" ? options.role : null,
		roots: options.roots ?? null,
		allowedCapabilities,
		capabilities: capabilityTable,
		createCapabilities:
			typeof options.createCapabilities === "function"
				? options.createCapabilities
				: typeof options.capabilities === "function"
					? options.capabilities
					: null,
		ports: options.ports ?? {},
		limits: options.limits ?? {},
		now: typeof options.limits?.now === "function" ? options.limits.now : Date.now,
		programs: new Map(),
		receipts: new Map(),
		abandoned: new Map(),
	};
}

function requireSession(session) {
	if (session === null || typeof session !== "object" || !(session.programs instanceof Map)) {
		fail("INVALID_ARGUMENT", "createSandboxSession is required");
	}
}

function sessionNow(session) {
	return typeof session.now === "function" ? session.now() : Date.now();
}

function deadlineFor(session, intentInfo) {
	const callMeta = intentInfo?.callMeta;
	if (callMeta !== null && typeof callMeta === "object") {
		if (Number.isFinite(callMeta.deadlineAt)) {
			return Number(callMeta.deadlineAt);
		}
		if (Number.isFinite(callMeta.intentBytes)) {
			return sessionNow(session) + Number(callMeta.intentBytes) * 50;
		}
	}
	const intent = intentInfo?.intent;
	if (typeof intent !== "string" || intent.length === 0) {
		fail("INTENT_REQUIRED", "Sandbox calls need a non-empty intent");
	}
	return sessionNow(session) + TEXT_ENCODER.encode(intent).length * 50;
}

function buildCapabilityMap(session, program) {
	const source =
		session.createCapabilities !== null
			? session.createCapabilities({
					session,
					program,
					programName: program.name,
					code: program.code,
					intent: program.intentInfo?.intent ?? null,
				})
			: session.capabilities;
	if (source === undefined || source === null) {
		return new Map();
	}
	const capabilities = new Map();
	if (source instanceof Map) {
		for (const [name, fn] of source) {
			capabilities.set(name, fn);
		}
	} else if (isPlainObject(source)) {
		for (const [name, fn] of Object.entries(source)) {
			capabilities.set(name, fn);
		}
	} else if (Array.isArray(source)) {
		for (const name of source) {
			capabilities.set(name, true);
		}
	} else {
		fail("INVALID_ARGUMENT", "createCapabilities must return an object, Map, or array");
	}

	for (const [name, fn] of capabilities) {
		if (!session.allowedCapabilities.has(name)) {
			fail("CAPABILITY_DENIED", `Capability ${name} exceeds the session capability set`, {
				capability: name,
			});
		}
		if (!INTERNAL_CAPABILITIES.has(name) && typeof fn !== "function") {
			fail("INVALID_ARGUMENT", `Capability ${name} must be a function`);
		}
	}
	return capabilities;
}

function createProgram(session, request, definition, deadlineAt) {
	const program = {
		session,
		name: definition.name,
		code: request.code,
		source: formatSource(request.code),
		state: RUNNING,
		intentInfo: { intent: request.intent ?? null, callMeta: request.callMeta ?? null },
		deadlineAt,
		allowedNames: new Set(session.allowedCapabilities),
		readSet: [],
		dirty: false,
		commitAttempted: false,
		commitValue: undefined,
		pendingCommit: null,
		pendingDiscard: null,
		discardUncertain: false,
		parkReason: null,
		parkCheckpoint: null,
		abandonedCapabilities: [],
		aborted: null,
		control: null,
		pending: null,
		rootEnv: new Environment(null),
		kont: null,
	};
	program.capabilities = buildCapabilityMap(session, program);
	return program;
}

async function runProgramWork(session, request) {
	if (DATA === null) {
		await ensureDataRuntime(session);
	}
	const name = request.name;
	const code = request.code;
	if (typeof name !== "string" || name.length === 0) {
		fail("INVALID_ARGUMENT", "program_name must be a non-empty string");
	}
	if (typeof code !== "string" || code.length === 0) {
		fail("INVALID_ARGUMENT", "code must be a non-empty string");
	}
	const deadlineAt = deadlineFor(session, request);
	const definition = parseProgram(code, name);
	analyze(definition.body, new Set(), 0, session);
	for (const bodyForm of definition.body) {
		checkTail(bodyForm, true, 0);
	}
	const existing = session.programs.get(name);
	if (existing !== undefined && ACTIVE_STATES.has(existing.state)) {
		fail("NAME_TAKEN", `Program ${name} is still active`, { program: name, state: existing.state });
	}
	const program = createProgram(session, request, definition, deadlineAt);
	session.programs.set(name, program);

	const state = {
		mode: "eval",
		control: null,
		env: program.rootEnv,
		value: null,
		kont: [],
		done: false,
		awaited: false,
	};
	startBody(state, definition.body, program.rootEnv);
	return executeProgram(session, program, state);
}

function replayKeyRun(request) {
	return JSON.stringify({
		operation: "run",
		name: request.name,
		code: request.code,
		intent: request.intent ?? null,
		deadlineAt: request.callMeta?.deadlineAt ?? null,
		intentBytes: request.callMeta?.intentBytes ?? null,
	});
}

async function replayLookup(session, callId, payloadKey) {
	if (typeof callId !== "string" || callId.length === 0) {
		return null;
	}
	const entry = session.receipts.get(callId);
	if (entry === undefined) {
		return null;
	}
	if (entry.payloadKey !== payloadKey) {
		fail("CALL_REPLAY_MISMATCH", "call-id was reused with a different payload", {
			callId,
		});
	}
	if (entry.receipt !== undefined) {
		return entry.receipt;
	}
	if (entry.error !== undefined) {
		throw entry.error;
	}
	return entry.promise;
}

async function withReplay(session, callId, payloadKey, work) {
	if (typeof callId !== "string" || callId.length === 0) {
		return work();
	}
	const entry = { payloadKey, receipt: undefined, error: undefined, promise: null };
	session.receipts.set(callId, entry);
	const promise = (async () => work())();
	entry.promise = promise;
	try {
		const receipt = await promise;
		entry.receipt = receipt;
		return receipt;
	} catch (error) {
		entry.error = error;
		throw error;
	}
}

/** Create one agent-private sandbox session. */
export function createSandboxSession(options = {}) {
	return makeSession(options);
}

/** Run one `(defprogram ...)` form. */
export async function runProgram(session, request = {}) {
	requireSession(session);
	const payloadKey = replayKeyRun(request);
	if (typeof request.callId === "string" && request.callId.length > 0) {
		const replayed = await replayLookup(session, request.callId, payloadKey);
		if (replayed !== null) {
			return replayed;
		}
	}
	return withReplay(session, request.callId, payloadKey, () => runProgramWork(session, request));
}

/** Resume one parked program and inject `value` as the parked expression's result. */
export async function unpark(session, request = {}) {
	requireSession(session);
	if (typeof request.name !== "string" || request.name.length === 0) {
		fail("INVALID_ARGUMENT", "unpark needs a non-empty program name");
	}
	let valueKey = "null";
	try {
		valueKey = printUfss(ednSafe(request.value ?? null));
	} catch {
		valueKey = "#<value>";
	}
	const payloadKey = JSON.stringify({
		operation: "unpark",
		name: request.name,
		value: valueKey,
		intent: request.intent ?? null,
		deadlineAt: request.callMeta?.deadlineAt ?? null,
		intentBytes: request.callMeta?.intentBytes ?? null,
	});
	if (typeof request.callId === "string" && request.callId.length > 0) {
		const replayed = await replayLookup(session, request.callId, payloadKey);
		if (replayed !== null) {
			return replayed;
		}
	}
	return withReplay(session, request.callId, payloadKey, () =>
		unparkProgram(session, {
			name: request.name,
			value: request.value ?? null,
			callerName: null,
			intentInfo: { intent: request.intent ?? null, callMeta: request.callMeta ?? null },
		}),
	);
}

async function unparkProgram(session, { name, value, callerName, intentInfo }) {
	const program = session.programs.get(name);
	if (program === undefined) {
		fail("PROGRAM_UNKNOWN", `Program ${name} does not exist`, { program: name });
	}
	if (callerName !== null && callerName === name) {
		fail("INVALID_ARGUMENT", "A program cannot unpark itself", { program: name });
	}
	if (program.state !== PARKED) {
		fail("STALE_CONTROL", `Program ${name} is not parked`, { program: name, state: program.state });
	}
	for (const capability of program.allowedNames) {
		if (!session.allowedCapabilities.has(capability)) {
			fail("CAPABILITY_DENIED", `Current session cannot resume ${name}`, {
				program: name,
				capability,
			});
		}
	}
	if (DATA === null) {
		await ensureDataRuntime(session);
	}
	const deadlineAt = deadlineFor(session, intentInfo);
	const checkpoint = program.parkReason === "deadline" ? program.parkCheckpoint : null;
	program.parkReason = null;
	program.parkCheckpoint = null;
	program.state = RUNNING;
	program.deadlineAt = deadlineAt;
	if (checkpoint !== null) {
		const state = {
			mode: checkpoint.mode,
			control: checkpoint.control,
			env: checkpoint.env,
			value: checkpoint.value,
			kont: program.kont.slice(),
			done: false,
			awaited: checkpoint.awaited === true,
		};
		program.kont = null;
		return executeProgram(session, program, state);
	}
	const injected = normalizeResult(value);
	const state = {
		mode: "return",
		control: null,
		env: null,
		value: injected,
		kont: program.kont.slice(),
		done: false,
		awaited: false,
	};
	program.kont = null;
	return executeProgram(session, program, state);
}

/**
 * Read the live abandoned-capability records for a program name. Records are
 * session-scoped, survive reuse of the same name, and settle in place; a late
 * result is diagnostic and is never replayed as the program result.
 */
export function abandonedCapabilities(session, name) {
	requireSession(session);
	return (session.abandoned?.get(name) ?? []).map(abandonedCapabilityValue);
}

/** Names of programs currently parked, sorted for deterministic receipts. */
export function parkedNames(session) {
	requireSession(session);
	const names = [];
	for (const program of session.programs.values()) {
		if (program.state === PARKED) {
			names.push(program.name);
		}
	}
	return names.sort();
}

/**
 * Abort one program. Cancellation belongs to the current tool invocation, not
 * to the session: a later `runProgram` starts with a fresh program.
 */
export function abortProgram(session, name, reason = "operator") {
	requireSession(session);
	const program = session.programs.get(name);
	if (program === undefined) {
		return { ok: false, code: "PROGRAM_UNKNOWN", name };
	}
	if (program.state === PARKED) {
		return { ok: false, code: "STALE_CONTROL", name, state: PARKED };
	}
	if (program.state !== RUNNING && program.state !== WAITING) {
		return { ok: false, code: "STALE_CONTROL", name, state: program.state };
	}
	program.aborted = { reason, at: sessionNow(session) };
	program.control?.fire(new WaitSignal("abort", reason));
	return { ok: true, name, state: program.state };
}

/**
 * Abort every currently running/waiting program. Parked continuations survive,
 * and the session itself remains usable for later calls.
 */
export function abortSession(session, reason = "operator") {
	requireSession(session);
	const at = sessionNow(session);
	const aborted = [];
	for (const program of session.programs.values()) {
		if (program.state === RUNNING || program.state === WAITING) {
			program.aborted = { reason, at };
			program.control?.fire(new WaitSignal("abort", reason));
			aborted.push(program.name);
		}
	}
	return { aborted: aborted.sort(), parked: parkedNames(session) };
}

/**
 * Builtin function table. These are pure data functions; no capability and no
 * host object is reachable from here.
 *
 * The Cherry-native section at the end of the file redefines collection,
 * string, set, regex, and walk entries; the last definition wins. Earlier
 * declarations remain for arithmetic and predicate primitives.
 */
const BUILTINS = new Map();

function defineBuiltin(names, fn) {
	for (const name of names) {
		BUILTINS.set(name, { fn });
	}
}

function numeric(value) {
	if (typeof value === "number") {
		return value;
	}
	if (typeof value === "bigint") {
		return value;
	}
	fail("INVALID_ARGUMENT", "Expected a number", { value: safePrStr(value) });
}

const FORCING_CORE = new Set(["merge", "replace"]);

function guardForcing(name, args) {
	if (FORCING_CORE.has(name) && args.some(isUnboundedRange)) {
		fail("LIMIT_EXCEEDED", "operation cannot force an unbounded range", {
			function: name,
			limit: MAX_MATERIALIZED_ITEMS,
			reason: "unbounded-range",
		});
	}
}

function bindCore(clojureName, exportName = clojureName) {
	defineBuiltin([clojureName, `cljs.core/${clojureName}`], (args) => {
		guardForcing(clojureName, args);
		const fn = data().core[exportName];
		if (typeof fn !== "function") {
			fail("HOST_API_MISMATCH", `cherry-cljs core lacks ${exportName}`, { export: exportName });
		}
		return fn(...args);
	});
}

const CORE_BINDINGS = {
	"+": "_PLUS_",
	"-": "_",
	"/": "_SLASH_",
	"<": "_LT_",
	">": "_GT_",
	"<=": "_LT__EQ_",
	inc: "inc",
	dec: "dec",
	max: "max",
	min: "min",
	mod: "mod",
	quot: "quot",
	rem: "rem",
	not: "not",
	identity: "identity",
	"nil?": "nil_QMARK_",
	"some?": "some_QMARK_",
	"true?": "true_QMARK_",
	"false?": "false_QMARK_",
	"number?": "number_QMARK_",
	"string?": "string_QMARK_",
	"integer?": "integer_QMARK_",
	"float?": "float_QMARK_",
	"zero?": "zero_QMARK_",
	"pos?": "pos_QMARK_",
	"neg?": "neg_QMARK_",
	"even?": "even_QMARK_",
	"odd?": "odd_QMARK_",
	"keyword?": "keyword_QMARK_",
	"symbol?": "symbol_QMARK_",
	"vector?": "vector_QMARK_",
	"map?": "map_QMARK_",
	"set?": "set_QMARK_",
	"list?": "list_QMARK_",
	"seq?": "seq_QMARK_",
	"coll?": "coll_QMARK_",
	"sequential?": "sequential_QMARK_",
	"associative?": "associative_QMARK_",
	"counted?": "counted_QMARK_",
	"reversible?": "reversible_QMARK_",
	"sorted?": "sorted_QMARK_",
	"map-entry?": "map_entry_QMARK_",
	"distinct?": "distinct_QMARK_",
	"uuid?": "uuid_QMARK_",
	"inst?": "inst_QMARK_",
	"regexp?": "regexp_QMARK_",
	"object?": "object_QMARK_",
	"identical?": "identical_QMARK_",
	"seqable?": "seqable_QMARK_",
	"indexed?": "indexed_QMARK_",
	"realized?": "realized_QMARK_",
	"char?": "char_QMARK_",
	"int?": "int_QMARK_",
	"nat-int?": "nat_int_QMARK_",
	"neg-int?": "neg_int_QMARK_",
	"pos-int?": "pos_int_QMARK_",
	"double?": "double_QMARK_",
	"simple-symbol?": "simple_symbol_QMARK_",
	"qualified-symbol?": "qualified_symbol_QMARK_",
	"simple-keyword?": "simple_keyword_QMARK_",
	"qualified-keyword?": "qualified_keyword_QMARK_",
	"ident?": "ident_QMARK_",
	"simple-ident?": "simple_ident_QMARK_",
	"qualified-ident?": "qualified_ident_QMARK_",
	"boolean?": "boolean_QMARK_",
	"array?": "array_QMARK_",
	"any?": "any_QMARK_",
	"unchecked-add": "unchecked_add",
	"unchecked-subtract": "unchecked_subtract",
	"unchecked-multiply": "unchecked_multiply",
	"unchecked-inc": "unchecked_inc",
	"unchecked-dec": "unchecked_dec",
	"unchecked-negate": "unchecked_negate",
	"unchecked-int": "unchecked_int",
	"unchecked-long": "unchecked_long",
	"unchecked-double": "unchecked_double",
	"unchecked-float": "unchecked_float",
	"unchecked-byte": "unchecked_byte",
	"unchecked-short": "unchecked_short",
	"unchecked-char": "unchecked_char",
	subs: "subs",
	keyword: "keyword",
	symbol: "symbol",
	name: "name",
	namespace: "namespace",
	second: "second",
	"hash-combine": "hash_combine",
	compare: "compare",
	get: "get",
	"get-in": "get_in",
	assoc: "assoc",
	"assoc-in": "assoc_in",
	dissoc: "dissoc",
	conj: "conj",
	disj: "disj",
	"contains?": "contains_QMARK_",
	empty: "empty",
	"empty?": "empty_QMARK_",
	"not-empty": "not_empty",
	first: "first",
	rest: "rest",
	next: "next",
	seq: "seq",
	nth: "nth",
	nthnext: "nthnext",
	nthrest: "nthrest",
	find: "find",
	key: "key",
	val: "val",
	ffirst: "ffirst",
	nfirst: "nfirst",
	fnext: "fnext",
	nnext: "nnext",
	keys: "keys",
	vals: "vals",
	peek: "peek",
	pop: "pop",
	subvec: "subvec",
	vector: "vector",
	list: "list",
	"list*": "list_STAR_",
	"hash-map": "hash_map",
	"array-map": "array_map",
	"hash-set": "hash_set",
	"sorted-map": "sorted_map",
	"sorted-set": "sorted_set",
	merge: "merge",
	"select-keys": "select_keys",
	cons: "cons",
	concat: "concat",
	distinct: "distinct",
	flatten: "flatten",
	interpose: "interpose",
	interleave: "interleave",
	partition: "partition",
	"partition-all": "partition_all",
	take: "take",
	drop: "drop",
	range: "range",
	"take-nth": "take_nth",
	"split-at": "split_at",
	dedupe: "dedupe",
	subseq: "subseq",
	rsubseq: "rsubseq",
	meta: "meta",
	"with-meta": "with_meta",
	replace: "replace",
	"parse-long": "parse_long",
	"parse-double": "parse_double",
	"parse-boolean": "parse_boolean",
	"parse-uuid": "parse_uuid",
	abs: "abs",
	"NaN?": "NaN_QMARK_",
	"infinite?": "infinite_QMARK_",
	"bit-and": "bit_and",
	"bit-or": "bit_or",
	"bit-xor": "bit_xor",
	"bit-not": "bit_not",
	"bit-shift-left": "bit_shift_left",
	"bit-shift-right": "bit_shift_right",
	"unsigned-bit-shift-right": "unsigned_bit_shift_right",
	"bit-test": "bit_test",
	"bit-set": "bit_set",
	"bit-clear": "bit_clear",
	"bit-flip": "bit_flip",
	"bit-count": "bit_count",
};
for (const [name, exportName] of Object.entries(CORE_BINDINGS)) {
	bindCore(name, exportName);
}

defineBuiltin(["take", "cljs.core/take"], (args) => {
	arity("take", args, 1, 2);
	const count = Number(numeric(args[0]));
	return args.length === 1
		? makeTransducer([{ op: "take", count }], data().core.take(count))
		: data().core.take(count, args[1]);
});
defineBuiltin(["drop", "cljs.core/drop"], (args) => {
	arity("drop", args, 1, 2);
	const count = Number(numeric(args[0]));
	return args.length === 1
		? makeTransducer([{ op: "drop", count }], data().core.drop(count))
		: data().core.drop(count, args[1]);
});
defineBuiltin(["dedupe", "cljs.core/dedupe"], (args) => {
	arity("dedupe", args, 0, 1);
	return args.length === 0 ? makeTransducer([{ op: "dedupe" }], data().core.dedupe()) : data().core.dedupe(args[0]);
});
defineBuiltin(["distinct", "cljs.core/distinct"], (args) => {
	arity("distinct", args, 0, 1);
	return args.length === 0
		? makeTransducer([{ op: "distinct" }], data().core.distinct())
		: data().core.distinct(args[0]);
});
defineBuiltin(["interpose", "cljs.core/interpose"], (args) => {
	arity("interpose", args, 1, 2);
	return args.length === 1
		? makeTransducer([{ op: "interpose", sep: args[0] }], data().core.interpose(args[0]))
		: data().core.interpose(args[0], args[1]);
});
defineBuiltin(["partition-all", "cljs.core/partition-all"], (args) => {
	arity("partition-all", args, 1, 3);
	const count = Number(numeric(args[0]));
	if (!Number.isInteger(count) || count < 1) {
		fail("INVALID_ARGUMENT", "partition-all needs a positive integer count", { count });
	}
	if (args.length === 1) {
		return makeTransducer([{ op: "partition-all", count }], data().core.partition_all(count));
	}
	if (args.length === 2) {
		return data().core.partition_all(count, args[1]);
	}
	return data().core.partition_all(count, Number(numeric(args[1])), args[2]);
});
defineBuiltin(["cat", "cljs.core/cat"], (args) => {
	arity("cat", args, 0);
	return makeTransducer([{ op: "cat" }], data().core.cat);
});
defineBuiltin(["halt-when"], (args) => {
	arity("halt-when", args, 1, 2);
	const retf = args.length === 2 ? args[1] : null;
	const cherry =
		canSyncCallable(args[0]) && (retf === null || canSyncCallable(retf))
			? data().core.halt_when(toJsTransducerCallback(args[0]), retf === null ? undefined : toJsTransducerCallback(retf))
			: null;
	return makeTransducer([{ op: "halt-when", fn: args[0], retf }], cherry);
});
defineBuiltin(["completing"], (args) => {
	arity("completing", args, 1, 2);
	return { kind: "completing", f: args[0], cf: args.length === 2 ? args[1] : null };
});
defineBuiltin(["reduced"], (args) => {
	arity("reduced", args, 1);
	return data().core.reduced(args[0]);
});
defineBuiltin(["reduced?"], (args) => {
	arity("reduced?", args, 1);
	return data().core.reduced_QMARK_(args[0]);
});
defineBuiltin(["unreduced"], (args) => {
	arity("unreduced", args, 1);
	return data().core.unreduced(args[0]);
});

defineBuiltin(["count", "cljs.core/count"], (args) => {
	arity("count", args, 1);
	const counted = data().core.bounded_count(MAX_MATERIALIZED_ITEMS + 1, args[0]);
	if (counted > MAX_MATERIALIZED_ITEMS) {
		fail("LIMIT_EXCEEDED", "count exceeds the materialization limit", {
			limit: MAX_MATERIALIZED_ITEMS,
			reason: "lazy-or-infinite-sequence",
		});
	}
	return counted;
});

defineBuiltin(["*", "cljs.core/*"], (args) => {
	let result = 1;
	for (const arg of args) {
		const value = numeric(arg);
		result = typeof result === "bigint" || typeof value === "bigint" ? BigInt(result) * BigInt(value) : result * value;
	}
	return result;
});
defineBuiltin([">=", "cljs.core/>="], (args) => {
	arity(">=", args, 1, Number.POSITIVE_INFINITY);
	for (let index = 1; index < args.length; index += 1) {
		if (!(numeric(args[index - 1]) >= numeric(args[index]))) {
			return false;
		}
	}
	return true;
});
defineBuiltin(["constantly"], (args) => {
	arity("constantly", args, 1);
	return { kind: "fn", name: null, arities: [], env: null, constant: args[0] };
});
defineBuiltin(["fn?"], (args) => {
	arity("fn?", args, 1);
	return args[0] !== null && typeof args[0] === "object" && typeof args[0].kind === "string";
});
defineBuiltin(["ifn?"], (args) => {
	arity("ifn?", args, 1);
	return isCallableValue(args[0]);
});
defineBuiltin(["ex-message"], (args) => {
	arity("ex-message", args, 1);
	const value = args[0];
	if (data().isMap(value)) {
		const message = mapGet(value, V("message"), MISSING);
		if (message !== MISSING) {
			return message;
		}
	}
	return value instanceof Error ? value.message : null;
});
defineBuiltin(["boolean"], (args) => {
	arity("boolean", args, 1);
	return truthy(args[0]);
});
defineBuiltin(["partial"], (args) => {
	arity("partial", args, 1, Number.POSITIVE_INFINITY);
	return { kind: "partial", fn: args[0], bound: args.slice(1) };
});
defineBuiltin(["memoize", "cljs.core/memoize"], (args) => {
	arity("memoize", args, 1);
	return { kind: "memoize", fn: args[0], cache: [] };
});
defineBuiltin(["comp"], (args) => {
	if (args.length === 0) {
		return makeTransducer([], data().core.comp());
	}
	const resolved = args.map(resolveTransducerValue);
	if (resolved.length > 0 && resolved.every(isTransducer)) {
		return composeTransducers(resolved, "comp");
	}
	return { kind: "comp", fns: args };
});
defineBuiltin(["juxt"], (args) => ({ kind: "juxt", fns: args }));
defineBuiltin(["complement"], (args) => {
	arity("complement", args, 1);
	return { kind: "complement", fn: args[0] };
});
defineBuiltin(["fnil"], (args) => {
	arity("fnil", args, 2, 4);
	return { kind: "fnil", fn: args[0], defaults: args.slice(1) };
});
defineBuiltin(["every-pred"], (args) => ({ kind: "every-pred", fns: args }));
defineBuiltin(["some-fn"], (args) => ({ kind: "some-fn", fns: args }));

function syncCallable(value, args) {
	if (value === null || typeof value !== "object") {
		fail("INVALID_ARGUMENT", "Value is not callable", { value: safePrStr(value) });
	}
	if (DATA?.isKeyword(value)) {
		return mapGet(args[0], value, args.length > 1 ? args[1] : null);
	}
	if (DATA?.isVector(value)) {
		return nthOf(value, args[0], args.length > 1 ? args[1] : MISSING);
	}
	if (DATA?.isMap(value)) {
		return mapGet(value, args[0], args.length > 1 ? args[1] : null);
	}
	if (DATA?.isSet(value)) {
		return DATA.core.contains_QMARK_(value, args[0]) ? args[0] : null;
	}
	if (value.kind === "fn") {
		if (value.constant !== undefined) {
			return value.constant;
		}
		fail("CAPABILITY_DENIED", "lazy sequence producers must be synchronous", {
			reason: "lazy-producer-must-be-synchronous",
		});
	}
	if (value.kind === "builtin") {
		const builtin = BUILTINS.get(value.name);
		if (builtin === undefined) {
			fail("CAPABILITY_DENIED", `Unbound function ${value.name}`, { symbol: value.name });
		}
		const result = builtin.fn(args);
		if (isThenable(result)) {
			fail("CAPABILITY_DENIED", "lazy sequence producers must be synchronous", {
				reason: "lazy-producer-must-be-synchronous",
			});
		}
		return result;
	}
	if (value.kind === "native") {
		return value.fn(...args);
	}
	if (value.kind === "memoize") {
		const cached = value.cache.find((entry) => sameArguments(entry.args, args));
		if (cached !== undefined) {
			return cached.value;
		}
		const result = syncCallable(value.fn, args);
		value.cache.push({ args: args.slice(), value: result });
		return result;
	}
	if (value.kind === "completing") {
		if (args.length === 1) {
			return value.cf === null ? args[0] : syncCallable(value.cf, args);
		}
		return syncCallable(value.f, args);
	}
	if (value.kind === "partial") {
		return syncCallable(value.fn, [...value.bound, ...args]);
	}
	if (value.kind === "fnil") {
		const length = Math.max(args.length, value.defaults.length);
		const replaced = [];
		for (let index = 0; index < length; index += 1) {
			const argument = index < args.length ? args[index] : undefined;
			replaced.push(argument === null || argument === undefined ? (value.defaults[index] ?? null) : argument);
		}
		return syncCallable(value.fn, replaced);
	}
	if (value.kind === "complement") {
		return !truthy(syncCallable(value.fn, args));
	}
	if (value.kind === "comp") {
		if (value.fns.length === 0) {
			return args[0] ?? null;
		}
		let result = args;
		for (let index = value.fns.length - 1; index >= 0; index -= 1) {
			result = [syncCallable(value.fns[index], result)];
		}
		return result[0];
	}
	if (value.kind === "juxt") {
		return data().vectorFromArray(value.fns.map((fn) => syncCallable(fn, args)));
	}
	if (value.kind === "every-pred" || value.kind === "some-fn") {
		for (const fn of value.fns) {
			for (const argument of args) {
				const predicate = syncCallable(fn, [argument]);
				if (value.kind === "every-pred" && !truthy(predicate)) {
					return false;
				}
				if (value.kind === "some-fn" && truthy(predicate)) {
					return true;
				}
			}
		}
		return value.kind === "every-pred";
	}
	fail("CAPABILITY_DENIED", "lazy sequence producers must be synchronous", {
		reason: "lazy-producer-must-be-synchronous",
	});
}

defineBuiltin(["iterate"], (args) => {
	arity("iterate", args, 2);
	if (canSyncCallable(args[0])) {
		return data().core.iterate((value) => syncCallable(args[0], [value]), args[1]);
	}
	return new LazyStream(iterateLazy(args[0], args[1]));
});
defineBuiltin(["repeatedly"], (args) => {
	arity("repeatedly", args, 1, 2);
	const fn = args[args.length - 1];
	const count = args.length === 2 ? Number(numeric(args[0])) : Number.POSITIVE_INFINITY;
	if (canSyncCallable(fn)) {
		return args.length === 1
			? data().core.repeatedly(() => syncCallable(fn, []))
			: data().core.repeatedly(count, () => syncCallable(fn, []));
	}
	return new LazyStream(repeatedlyLazy(fn, count));
});

defineBuiltin(["sort"], (args) => {
	arity("sort", args, 1);
	const items = seqToArray(args[0]);
	items.sort((left, right) => data().core.compare(left, right));
	return data().vectorFromArray(items);
});

function bindLibrary(prefix, getLibrary, mappings) {
	for (const [clojureName, exportName] of Object.entries(mappings)) {
		defineBuiltin([`${prefix}/${clojureName}`], (args) => {
			if (args.some(isUnboundedRange)) {
				fail("LIMIT_EXCEEDED", `${prefix} cannot force an unbounded range`, {
					function: `${prefix}/${clojureName}`,
					reason: "unbounded-range",
				});
			}
			const library = getLibrary();
			if (library === null || typeof library?.[exportName] !== "function") {
				fail("HOST_API_MISMATCH", `${prefix} library lacks ${exportName}`, { export: exportName });
			}
			return library[exportName](...args);
		});
	}
}

bindLibrary("clojure.string", () => data().string, {
	"blank?": "blank_QMARK_",
	capitalize: "capitalize",
	"ends-with?": "ends_with_QMARK_",
	escape: "escape",
	"includes?": "includes_QMARK_",
	"index-of": "index_of",
	"last-index-of": "last_index_of",
	"lower-case": "lower_case",
	reverse: "reverse",
	split: "split",
	"split-lines": "split_lines",
	"starts-with?": "starts_with_QMARK_",
	trim: "trim",
	"trim-newline": "trim_newline",
	triml: "triml",
	trimr: "trimr",
	"upper-case": "upper_case",
});

bindLibrary("clojure.set", () => data().set, {
	difference: "difference",
	index: "index",
	intersection: "intersection",
	join: "join",
	"map-invert": "map_invert",
	project: "project",
	rename: "rename",
	"rename-keys": "rename_keys",
	"subset?": "subset_QMARK_",
	"superset?": "superset_QMARK_",
	union: "union",
});

bindLibrary("clojure.walk", () => data().walk, {
	"keywordize-keys": "keywordize_keys",
	"stringify-keys": "stringify_keys",
});

function replaceWalk(value, replacements, pre) {
	let result = value;
	if (pre) {
		const replacement = mapGet(replacements, result, MISSING);
		if (replacement !== MISSING) {
			result = replacement;
		}
	}
	const kind = walkKind(result);
	if (kind !== null) {
		const children = walkChildren(result, kind).map((child) => replaceWalk(child, replacements, pre));
		result = walkBuild(kind, children);
	}
	if (!pre) {
		const replacement = mapGet(replacements, result, MISSING);
		if (replacement !== MISSING) {
			result = replacement;
		}
	}
	return result;
}

defineBuiltin(["clojure.walk/postwalk-replace"], (args) => {
	arity("clojure.walk/postwalk-replace", args, 2);
	return replaceWalk(args[1], args[0], false);
});
defineBuiltin(["clojure.walk/prewalk-replace"], (args) => {
	arity("clojure.walk/prewalk-replace", args, 2);
	return replaceWalk(args[1], args[0], true);
});

bindCore("re-pattern", "re_pattern");
bindCore("re-find", "re_find");
bindCore("re-matches", "re_matches");
bindCore("re-seq", "re_seq");

/* Forcing operations that must not consume an unbounded lazy sequence. */
defineBuiltin(["str", "cljs.core/str"], (args) =>
	args.some((value) => containsLazySeq(value)) ? args.map(stringify).join("") : data().core.str(...args),
);
defineBuiltin(["pr-str", "cljs.core/pr-str"], (args) =>
	args.some((value) => containsLazySeq(value))
		? args.map((value) => printUfss(ednSafe(value))).join(" ")
		: data().core.pr_str(...args),
);
defineBuiltin(["print-str", "cljs.core/print-str"], (args) =>
	args.some((value) => containsLazySeq(value)) ? args.map(stringify).join(" ") : data().core.print_str(...args),
);
defineBuiltin(["prn-str", "cljs.core/prn-str"], (args) =>
	args.some((value) => containsLazySeq(value))
		? `${args.map((value) => printUfss(ednSafe(value))).join(" ")}\n`
		: data().core.prn_str(...args),
);
defineBuiltin(["println-str", "cljs.core/println-str"], (args) =>
	args.some((value) => containsLazySeq(value))
		? `${args.map(stringify).join(" ")}\n`
		: data().core.println_str(...args),
);
defineBuiltin(["last", "cljs.core/last"], (args) => {
	arity("last", args, 1);
	const items = seqToArray(args[0]);
	return items.length === 0 ? null : items[items.length - 1];
});
defineBuiltin(["butlast", "cljs.core/butlast"], (args) => {
	arity("butlast", args, 1);
	const items = seqToArray(args[0]);
	return data().vectorFromArray(items.slice(0, Math.max(0, items.length - 1)));
});
defineBuiltin(["take-last", "cljs.core/take-last"], (args) => {
	arity("take-last", args, 2);
	const items = seqToArray(args[1]);
	return data().vectorFromArray(items.slice(Math.max(0, items.length - Number(numeric(args[0])))));
});
defineBuiltin(["drop-last", "cljs.core/drop-last"], (args) => {
	arity("drop-last", args, 1, 2);
	const count = args.length === 2 ? Number(numeric(args[0])) : 1;
	const items = seqToArray(args[args.length - 1]);
	return data().vectorFromArray(items.slice(0, Math.max(0, items.length - count)));
});
defineBuiltin(["doall", "cljs.core/doall"], (args) => {
	arity("doall", args, 1, 2);
	seqToArray(args[args.length - 1]);
	return args[args.length - 1];
});
defineBuiltin(["dorun", "cljs.core/dorun"], (args) => {
	arity("dorun", args, 1, 2);
	seqToArray(args[args.length - 1]);
	return null;
});
defineBuiltin(["set", "cljs.core/set"], (args) => {
	arity("set", args, 1);
	return data().setFromArray(seqToArray(args[0]));
});
defineBuiltin(["vec", "cljs.core/vec"], (args) => {
	arity("vec", args, 1);
	return data().vectorFromArray(seqToArray(args[0]));
});
defineBuiltin(["frequencies", "cljs.core/frequencies"], (args) => {
	arity("frequencies", args, 1);
	let result = data().emptyMap();
	for (const item of seqToArray(args[0])) {
		result = data().assoc(result, item, (mapGet(result, item, 0) ?? 0) + 1);
	}
	return result;
});
defineBuiltin(["zipmap", "cljs.core/zipmap"], (args) => {
	arity("zipmap", args, 2);
	const keys = seqToArray(args[0]);
	const values = seqToArray(args[1]);
	const entries = [];
	for (let index = 0; index < Math.min(keys.length, values.length); index += 1) {
		entries.push([keys[index], values[index]]);
	}
	return data().mapFromEntries(entries);
});
defineBuiltin(["hash", "cljs.core/hash"], (args) => {
	arity("hash", args, 1);
	const value = args[0];
	return data().core.hash(isLazySeqValue(value) ? data().vectorFromArray(seqToArray(value)) : value);
});
defineBuiltin(["=", "cljs.core/="], (args) => {
	for (let index = 1; index < args.length; index += 1) {
		if (!cljEquals(args[index - 1], args[index])) {
			return false;
		}
	}
	return true;
});
defineBuiltin(["not=", "cljs.core/not="], (args) => {
	arity("not=", args, 1, Number.POSITIVE_INFINITY);
	if (args.length === 1) {
		return false;
	}
	for (let index = 1; index < args.length; index += 1) {
		if (!cljEquals(args[index - 1], args[index])) {
			return true;
		}
	}
	return false;
});
defineBuiltin(["clojure.string/join"], (args) => {
	arity("clojure.string/join", args, 1, 2);
	const separator = args.length === 2 ? stringify(args[0]) : "";
	return seqToArray(args.length === 2 ? args[1] : args[0])
		.map(stringify)
		.join(separator);
});
