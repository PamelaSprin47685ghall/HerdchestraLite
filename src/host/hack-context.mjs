/**
 * Minimal-delta persistent `context` wrapper (`hack_context`).
 *
 * Wraps `pi.on("context", handler)` so any outbound `messages` transformation
 * returned by `handler` is diffed against `event.messages` (longest common
 * prefix) and persisted in O(1) via `sessionManager.branch(parentId)` +
 * `sessionManager.appendMessage(...)` without rewriting `.jsonl`.
 *
 * Falls back gracefully to standard outbound-only `context` behavior when
 * `ctx.sessionManager` is absent or lacks branch/append methods.
 */

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

const MESSAGE_ENTRY_TYPES = new Set(["message", "custom_message", "branch_summary", "compaction"]);

/**
 * Compute the longest common prefix between `before` and `after`.
 *
 * @param {unknown[]} before
 * @param {unknown[]} after
 * @returns {{ prefixLen: number, removedCount: number, appendedCount: number, changed: boolean }}
 */
export function computeMessagesDelta(before, after) {
	const limit = Math.min(before.length, after.length);
	let prefixLen = 0;
	while (prefixLen < limit && deepEqual(before[prefixLen], after[prefixLen])) {
		prefixLen += 1;
	}
	const removedCount = before.length - prefixLen;
	const appendedCount = after.length - prefixLen;
	return {
		prefixLen,
		removedCount,
		appendedCount,
		changed: removedCount > 0 || appendedCount > 0,
	};
}

function normalizeAppendMessage(message) {
	if (!isPlainObject(message)) return message;
	if (typeof message.timestamp === "number") return message;
	return { ...message, timestamp: Date.now() };
}

/**
 * Persist the minimal delta `[prefixLen .. after.length - 1]` to `sessionManager`
 * via `branch(parentId)` + `appendMessage(...)`.
 *
 * @param {any} sessionManager
 * @param {unknown[]} before
 * @param {unknown[]} after
 * @param {number} prefixLen
 * @returns {{ persisted: boolean, branched: boolean, appended: number }}
 */
export function syncSessionDelta(sessionManager, before, after, prefixLen) {
	if (
		!sessionManager ||
		typeof sessionManager.getBranch !== "function" ||
		typeof sessionManager.branch !== "function" ||
		typeof sessionManager.appendMessage !== "function"
	) {
		return { persisted: false, branched: false, appended: 0 };
	}

	if (prefixLen === before.length && prefixLen === after.length) {
		return { persisted: false, branched: false, appended: 0 };
	}

	let branched = false;
	if (prefixLen < before.length) {
		const branchEntries = sessionManager.getBranch();
		const messageEntries = Array.isArray(branchEntries)
			? branchEntries.filter((entry) => entry && MESSAGE_ENTRY_TYPES.has(entry.type))
			: [];
		const targetEntry = messageEntries[prefixLen];
		if (!targetEntry) {
			return { persisted: false, branched: false, appended: 0 };
		}
		if (targetEntry.parentId == null) {
			if (typeof sessionManager.resetLeaf !== "function") {
				return { persisted: false, branched: false, appended: 0 };
			}
			sessionManager.resetLeaf();
		} else {
			sessionManager.branch(targetEntry.parentId);
		}
		branched = true;
	}

	let appended = 0;
	for (let i = prefixLen; i < after.length; i += 1) {
		sessionManager.appendMessage(normalizeAppendMessage(after[i]));
		appended += 1;
	}
	return { persisted: true, branched, appended };
}

/**
 * Register a `context` hook whose returned `{ messages }` diff is persisted
 * incrementally via `branch(parentId)` + `appendMessage(...)`.
 *
 * @param {any} pi
 * @param {(event: any, ctx: any) => any} handler
 */
export function hackContext(pi, handler) {
	if (!pi || typeof pi.on !== "function") {
		throw new TypeError("hackContext: pi.on is required");
	}
	if (typeof handler !== "function") {
		throw new TypeError("hackContext: handler function is required");
	}
	pi.on("context", async (event, ctx) => {
		const before = Array.isArray(event?.messages) ? event.messages : [];
		const result = await handler(event, ctx);
		if (!result || !Array.isArray(result.messages)) {
			return result;
		}
		const after = result.messages;
		const base = Array.isArray(result.branchBaseMessages) ? result.branchBaseMessages : before;
		const delta = computeMessagesDelta(base, after);
		if (delta.changed) {
			syncSessionDelta(ctx?.sessionManager, base, after, delta.prefixLen);
		}
		return { messages: after };
	});
}
