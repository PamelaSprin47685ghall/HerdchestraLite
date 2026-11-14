/**
 * Persistent `context` wrapper (`hack_context`).
 *
 * The wrapper is stateless. It reads the host's own session state
 * (`sessionManager.getLeafEntry()` / `getEntry()` / `getLeafId()`) and derives
 * the append point from the last persisted message. The host may deep-copy
 * messages before handing them to context hooks, so the wrapper accepts the
 * same message by identity or structural equality. If the persisted message is
 * still present, only the new tail is appended; otherwise the session is
 * rewritten once per session from the transformed messages. A per-manager
 * ledger suppresses later automatic rewrites on the same branch, so a host
 * that keeps deep-copying cannot rebuild the session on every request. The
 * ledger holds no message data and resets when the host leaf changes.
 *
 * The handler's output is the single request. The host's session manager holds
 * the memory and disk state; the wrapper only synchronizes it.
 */

import { appendFile, mkdir, stat } from "node:fs/promises";

const TRACE_LIMIT = 1024 * 1024;
let traceTail = Promise.resolve();

export function flushTrace() {
	return traceTail;
}
let traceTruncatedTarget = null;

function traceEnabled() {
	return process.env.HERD_TRACE === "1";
}

function traceTarget() {
	return process.env.HERD_TRACE_PATH || ".herd/perf-trace.jsonl";
}

function appendTrace(line) {
	const target = traceTarget();
	traceTail = traceTail
		.then(async () => {
			if (traceTruncatedTarget === target) return;
			const size = await stat(target)
				.then((value) => value.size)
				.catch(() => 0);
			const bytes = Buffer.byteLength(line, "utf8");
			if (size + bytes > TRACE_LIMIT) {
				traceTruncatedTarget = target;
				await mkdir(target.slice(0, target.lastIndexOf("/")) || ".", { recursive: true });
				await appendFile(
					target,
					`${JSON.stringify({ truncated: true, limit: TRACE_LIMIT, at: clockNow() })}\n`,
					"utf8",
				);
				return;
			}
			await mkdir(target.slice(0, target.lastIndexOf("/")) || ".", { recursive: true });
			await appendFile(target, line, "utf8");
		})
		.catch(() => {});
}

function recordTrace(entry) {
	if (!traceEnabled()) return;
	appendTrace(`${JSON.stringify(entry)}\n`);
}

function isPlainObject(value) {
	if (value === null || typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

export function deepEqual(a, b) {
	if (Object.is(a, b)) return true;
	if (a === null || b === null || typeof a !== typeof b) return false;
	if (typeof a !== "object") return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i += 1) {
			if (!deepEqual(a[i], b[i])) return false;
		}
		return true;
	}
	const keysA = Object.keys(a);
	const keysB = Object.keys(b);
	if (keysA.length !== keysB.length) return false;
	for (const key of keysA) {
		if (!Object.hasOwn(b, key) || !deepEqual(a[key], b[key])) return false;
	}
	return true;
}

function normalizeAppendMessage(message) {
	if (!isPlainObject(message)) return message;
	if (typeof message.timestamp === "number") return message;
	return { ...message, timestamp: clockNow() };
}

function logHandoff(data) {
	// Fire-and-forget: the context hot path must never await a diagnostic write.
	setImmediate(() => {
		appendFile(".herd/handoff-boundary.log", `${JSON.stringify(data)}${String.fromCharCode(10)}`).catch(() => {});
	});
}

function newEntryId() {
	return Math.floor(Math.random() * 0xffffffff)
		.toString(16)
		.padStart(8, "0");
}

function entryTimestamp(message) {
	if (message && typeof message.timestamp === "number") {
		return new Date(message.timestamp).toISOString();
	}
	if (message && typeof message.timestamp === "string") return message.timestamp;
	return new Date().toISOString();
}

function buildEntries(messages, state) {
	const runtime = state?.header?.runtime ??
		state?.entries?.find((entry) => entry?.runtime)?.runtime ?? { version: "unknown" };
	const entries = [];
	let parentId = null;
	for (const message of messages) {
		const id = newEntryId();
		entries.push({
			type: "message",
			id,
			parentId,
			timestamp: entryTimestamp(message),
			runtime,
			message,
		});
		parentId = id;
	}
	return entries;
}

/** True for an entry the host injected as a compression boundary. */
function isCompressionBoundary(entry) {
	return entry && (entry.type === "compaction" || entry.type === "reset_boundary");
}

/**
 * True when the current branch contains a host compression boundary. The
 * boundary entry itself must survive; rewriting the session from scratch would
 * drop it and let pre-compaction history leak back into the next request.
 *
 * Walk up from the leaf first, bounded to 256 parent links: a message leaf
 * resolves in O(1) and the usual custom trailing entries in O(trailing). Only
 * a walk that hits the cap while the branch continues falls back to a full
 * branch scan, so the ordinary request never rebuilds or scans the branch.
 */
export function hasCompressionBoundary(sessionManager) {
	if (!sessionManager) return false;
	if (typeof sessionManager.getLeafEntry !== "function") {
		return branchHasCompressionBoundary(sessionManager);
	}
	let entry = sessionManager.getLeafEntry();
	let guard = 0;
	while (entry && guard < 256) {
		if (isCompressionBoundary(entry)) return true;
		if (entry.parentId == null) return false;
		if (typeof sessionManager.getEntry !== "function") return false;
		entry = sessionManager.getEntry(entry.parentId);
		guard += 1;
	}
	return guard >= 256 && entry ? branchHasCompressionBoundary(sessionManager) : false;
}

function branchHasCompressionBoundary(sessionManager) {
	if (typeof sessionManager.getBranch !== "function") return false;
	try {
		const branch = sessionManager.getBranch();
		return Array.isArray(branch) && branch.some(isCompressionBoundary);
	} catch {
		return false;
	}
}
/**
 * The last persisted message entry on the current branch. The leaf itself may
 * be a custom entry injected by the host, so walk up a bounded number of
 * parent links. This is O(1) for the normal message leaf and O(trailing
 * customs) otherwise; it never rebuilds the whole context.
 *
 * @param {any} sessionManager
 * @returns {any | undefined}
 */
function lastPersistedMessageEntry(sessionManager) {
	if (typeof sessionManager.getLeafEntry !== "function") return undefined;
	let entry = sessionManager.getLeafEntry();
	let guard = 0;
	while (entry && guard < 64) {
		if (isCompressionBoundary(entry)) return undefined;
		if (entry.type === "message" && entry.message) return entry;
		if (entry.parentId == null || typeof sessionManager.getEntry !== "function") {
			return undefined;
		}
		entry = sessionManager.getEntry(entry.parentId);
		guard += 1;
	}
	return undefined;
}

/**
 * Rewrite the session entries from the transformed messages. This removes old
 * history from the host's memory and file. Called once for the initial cut, a
 * replacement, or when the append point is no longer present.
 *
 * @param {any} sessionManager
 * @param {unknown[]} messages
 * @returns {Record<string, unknown>}
 */
export async function rewriteSession(sessionManager, messages, reason = "unknown") {
	if (
		!sessionManager ||
		typeof sessionManager.captureState !== "function" ||
		typeof sessionManager.restoreState !== "function" ||
		typeof sessionManager.rewriteEntries !== "function"
	) {
		return { persisted: false, rewritten: false, reason: "no-rewrite-api" };
	}
	if (!Array.isArray(messages) || messages.length === 0) {
		return { persisted: false, rewritten: false, reason: "empty-messages" };
	}
	const started = traceEnabled() ? clockNow() : 0;
	try {
		const state = sessionManager.captureState();
		const entries = buildEntries(messages, state);
		sessionManager.restoreState({ ...state, entries });
		if (typeof sessionManager.branch === "function") {
			sessionManager.branch(entries[entries.length - 1].id);
		}
		// The host owns persistence; never await its Promise on the context path.
		const written = sessionManager.rewriteEntries();
		if (written && typeof written.catch === "function") written.catch(() => {});
		logHandoff({
			event: "rewrite",
			reason,
			entries: entries.length,
			leaf: entries[entries.length - 1].id,
		});
		if (started) {
			let bytes = -1;
			try {
				bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
			} catch {
				bytes = -1;
			}
			recordTrace({
				at: clockNow(),
				event: "context-rewrite",
				reason,
				entries: entries.length,
				ms: Number((clockNow() - started).toFixed(1)),
				messagesBytes: bytes,
			});
		}
		return {
			persisted: true,
			rewritten: true,
			appended: 0,
			entries: entries.length,
			lastId: entries[entries.length - 1].id,
		};
	} catch (error) {
		logHandoff({ event: "rewrite-failed", reason, error: String(error) });
		return { persisted: false, rewritten: false, reason: "rewrite-failed" };
	}
}

/**
 * Append only the messages after the persisted point. The message objects are
 * passed through unchanged so the next request can find the same identity.
 *
 * @param {any} sessionManager
 * @param {unknown[]} after
 * @param {number} prefixLen
 * @returns {Record<string, unknown>}
 */
export function appendSessionDelta(sessionManager, after, prefixLen) {
	const started = traceEnabled() ? clockNow() : 0;
	if (
		!sessionManager ||
		typeof sessionManager.branch !== "function" ||
		typeof sessionManager.appendMessage !== "function"
	) {
		return { persisted: false, branched: false, appended: 0, reason: "no-branch-api" };
	}
	const leafId = typeof sessionManager.getLeafId === "function" ? sessionManager.getLeafId() : null;
	let branched = false;
	if (leafId != null) {
		try {
			sessionManager.branch(leafId);
			branched = true;
		} catch {
			return { persisted: false, branched: false, appended: 0, reason: "leaf-missing" };
		}
	}
	let appended = 0;
	let lastId = leafId;
	for (let i = prefixLen; i < after.length; i += 1) {
		lastId = sessionManager.appendMessage(after[i]);
		appended += 1;
	}
	if (started && appended > 0) {
		recordTrace({
			at: clockNow(),
			event: "context-append",
			appended,
			ms: Number((clockNow() - started).toFixed(1)),
		});
	}
	return { persisted: true, branched, appended, lastId };
}

export function applyHistoryBarrier(sessionManager, options = {}) {
	if (
		!sessionManager ||
		typeof sessionManager.branch !== "function" ||
		typeof sessionManager.appendMessage !== "function"
	) {
		return { persisted: false, branched: false, appended: 0 };
	}
	const parentId = options.parentId ?? null;
	if (parentId === null) {
		return { persisted: false, branched: false, appended: 0, reason: "root-parent" };
	}
	sessionManager.branch(parentId);
	let appended = 0;
	if (options.briefing != null) {
		sessionManager.appendMessage(
			normalizeAppendMessage({
				role: "user",
				content: [{ type: "text", text: String(options.briefing) }],
			}),
		);
		appended = 1;
	}
	return { persisted: true, branched: true, appended, via: "branch" };
}

const PREFIX_SCAN_LIMIT = 32;
const PREFIX_DEEP_LIMIT = 8;
const automaticRewriteLedgers = new WeakMap();

/** Current host leaf id, falling back to the leaf entry id. */
function currentLeafId(manager) {
	if (!manager) return null;
	if (typeof manager.getLeafId === "function") {
		try {
			return manager.getLeafId() ?? null;
		} catch {
			return null;
		}
	}
	const entry = typeof manager.getLeafEntry === "function" ? manager.getLeafEntry() : null;
	return entry?.id ?? null;
}

/**
 * One automatic rewrite per session. The ledger resets when the host leaf
 * changes, so a fresh session gets a fresh budget. Boundary misses do not spend
 * the budget because they never rewrite.
 */
function automaticRewriteLedger(manager) {
	const leafId = currentLeafId(manager);
	let ledger = automaticRewriteLedgers.get(manager);
	if (!ledger) {
		ledger = { leafId, rewrites: 0, misses: 0 };
		automaticRewriteLedgers.set(manager, ledger);
	} else if (ledger.leafId !== leafId) {
		ledger.leafId = leafId;
		ledger.rewrites = 0;
		ledger.misses = 0;
	}
	return ledger;
}

/** Keep the ledger aligned after the wrapper advances the leaf. */
function syncAutomaticRewriteLeaf(manager) {
	const ledger = automaticRewriteLedgers.get(manager);
	if (ledger) ledger.leafId = currentLeafId(manager);
}


function contentChars(value) {
	if (typeof value === "string") return value.length;
	if (Array.isArray(value)) {
		let total = 0;
		for (const block of value) {
			if (typeof block === "string") total += block.length;
			else if (block && typeof block === "object" && typeof block.text === "string") {
				total += block.text.length;
			}
		}
		return total;
	}
	return -1;
}

/**
 * Cheap pre-filter: identity, same role, and same total content length. Only a
 * candidate that passes this check pays for a structural comparison.
 */
function cheapSameShape(a, b) {
	if (Object.is(a, b)) return true;
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
	if (a.role !== b.role) return false;
	return contentChars(a.content) === contentChars(b.content);
}

/**
 * Number of leading messages in `after` that the session manager already
 * persisted. The host may deep-copy messages before handing them to context
 * hooks, so identity alone is not enough; the last eight positions also get a
 * structural comparison behind a cheap shape check. A miss beyond that window
 * returns -1 and the caller performs one full rewrite, so correctness does not
 * depend on scanning every message on every request.
 *
 * @param {unknown[]} after
 * @param {unknown} last
 * @returns {number}
 */
function timestampShape(a, b) {
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
	if (a.role !== b.role) return false;
	if (a.timestamp == null || b.timestamp == null || a.timestamp !== b.timestamp) return false;
	return contentChars(a.content) === contentChars(b.content);
}

function persistedPrefixLength(after, last) {
	if (last === undefined) return -1;
	const end = after.length - 1;
	if (end >= 0 && after[end] === last) return after.length;
	const floor = Math.max(0, after.length - PREFIX_SCAN_LIMIT);
	// The host may deep-copy messages and change their identity but keep the
	// timestamp. Locate that shape first over the last 32 positions.
	for (let i = end; i >= floor; i -= 1) {
		const candidate = after[i];
		if (candidate === last) return i + 1;
		if (timestampShape(candidate, last)) return i + 1;
	}
	// Without a timestamp, fall back to a bounded structural comparison.
	const deepFloor = Math.max(0, after.length - PREFIX_DEEP_LIMIT);
	for (let i = end; i >= deepFloor; i -= 1) {
		const candidate = after[i];
		if (cheapSameShape(candidate, last) && deepEqual(last, candidate)) return i + 1;
	}
	return -1;
}
export function hackContext(pi, handler) {
	if (!pi || typeof pi.on !== "function") {
		throw new TypeError("hackContext: pi.on is required");
	}
	if (typeof handler !== "function") {
		throw new TypeError("hackContext: handler function is required");
	}
	pi.on("context", async (event, ctx) => {
		const started = traceEnabled() ? clockNow() : 0;
		const result = await handler(event, ctx);
		const handlerMs = started ? clockNow() - started : 0;
		if (!result || !Array.isArray(result.messages)) {
			if (started) {
				const total = clockNow() - started;
				if (total >= 20) {
					recordTrace({
						at: clockNow(),
						hook: "context",
						handler: "hackContext",
						ms: Number(total.toFixed(1)),
						handlerMs: Number(handlerMs.toFixed(1)),
						bytes: -1,
						returned: false,
					});
				}
			}
			return result;
		}
		const after = result.messages;
		const manager = ctx?.sessionManager ?? globalThis.__herdSessionManager;
		let prefixLen = -1;
		let boundary = false;
		let synced = "none";
		if (manager && after.length > 0) {
			const entry = lastPersistedMessageEntry(manager);
			const last = entry?.message;
			prefixLen = result.fullRewrite === true ? -1 : persistedPrefixLength(after, last);
			if (result.handoffReplacement === true) {
				boundary = hasCompressionBoundary(manager);
				if (boundary) {
					appendSessionDelta(manager, after, 0);
					logHandoff({ event: "handoff-append-after-boundary", messages: after.length });
					synced = "append-after-boundary";
				} else {
					await rewriteSession(manager, after, "handoff-replacement");
					synced = "rewrite";
				}
			} else if (result.fullRewrite === true) {
				boundary = hasCompressionBoundary(manager);
				if (boundary) {
					appendSessionDelta(manager, after, 0);
					synced = "append";
				} else {
					await rewriteSession(manager, after, "full-rewrite");
					synced = "rewrite";
				}
			} else if (prefixLen < 0) {
				const ledger = automaticRewriteLedger(manager);
				ledger.misses += 1;
				if (ledger.rewrites > 0) {
					logHandoff({ event: "prefix-miss-suppressed", messages: after.length, misses: ledger.misses });
					if (started) {
						recordTrace({
							at: clockNow(),
							event: "context-prefix-miss-suppressed",
							messages: after.length,
							misses: ledger.misses,
						});
					}
					synced = "suppressed";
				} else {
					boundary = hasCompressionBoundary(manager);
					if (boundary) {
						logHandoff({ event: "boundary-prefix-miss", messages: after.length });
						synced = "boundary-miss";
					} else {
						const rewritten = await rewriteSession(manager, after, "prefix-miss");
						if (rewritten?.rewritten === true) ledger.rewrites += 1;
						synced = "rewrite";
					}
				}
			} else if (prefixLen < after.length) {
				appendSessionDelta(manager, after, prefixLen);
				synced = "append";
			}
			syncAutomaticRewriteLeaf(manager);
		}
		if (started) {
			const total = clockNow() - started;
			if (total >= 20) {
				let bytes = -1;
				try {
					bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
				} catch {
					bytes = -1;
				}
				recordTrace({
					at: clockNow(),
					hook: "context",
					handler: "hackContext",
					ms: Number(total.toFixed(1)),
					handlerMs: Number(handlerMs.toFixed(1)),
					bytes,
					messages: after.length,
					prefixLen,
					boundary,
					synced,
				});
			}
		}
		return { messages: after };
	});
}

function clockNow() {
	const clock = globalThis.__herdClock;
	return clock ? clock.performanceNow() : performance.now();
}
