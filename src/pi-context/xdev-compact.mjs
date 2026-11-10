/**
 * Present `write xd://context_compact` as a direct `context_compact` call while
 * history still records the outer write call id and name.
 *
 * Inputs: a session id and the outer write tool call id.
 * Output: the pending compact record, a branch predicate, and a rewritten copy
 * of the active branch.
 * Old location: vibe-workers.ts PENDING_XDEV_COMPACTS, isXdevCompactCall,
 * rewriteXdevCompactBranch, VW 119-142 and 1962-2005.
 * No fallback: a pending compact expires after 30 seconds; without a pending
 * record the branch is returned unchanged.
 */

/** @type {Map<string, { toolCallId: string }>} */
export const PENDING_XDEV_COMPACTS = new Map();

/**
 * Record the outer write call and start its 30 second expiry timer.
 * @param {string} sessionId
 * @param {string} toolCallId
 */
export function beginXdevCompact(sessionId, toolCallId) {
	PENDING_XDEV_COMPACTS.set(sessionId, { toolCallId });
	const timer = setTimeout(() => {
		const pending = PENDING_XDEV_COMPACTS.get(sessionId);
		if (pending?.toolCallId === toolCallId) PENDING_XDEV_COMPACTS.delete(sessionId);
	}, 30_000);
	// Bun's timer carries unref; the shared timer type does not.
	const unrefTimer = /** @type {{ unref?: () => void }} */ (timer);
	unrefTimer.unref?.();
}

/**
 * Drop the session's pending compact, if any.
 * @param {string} sessionId
 */
export function clearXdevCompact(sessionId) {
	PENDING_XDEV_COMPACTS.delete(sessionId);
}

/**
 * @param {string} sessionId
 * @returns {{ toolCallId: string } | undefined}
 */
export function pendingXdevCompact(sessionId) {
	return PENDING_XDEV_COMPACTS.get(sessionId);
}

/**
 * `write xd://context_compact` keeps the outer write call id and name in history.
 * @param {{ sessionManager: { getBranch: () => any[] } }} ctx
 * @param {string} toolCallId
 */
export function isXdevCompactCall(ctx, toolCallId) {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall" || block.id !== toolCallId || block.name !== "write") continue;
			const args = block.arguments;
			if (args && typeof args === "object" && "path" in args && args.path === "xd://context_compact") return true;
		}
	}
	return false;
}

/**
 * Present the xdev write call as the direct context_compact call pi-context expects.
 * @param {any[]} branch
 * @param {{ toolCallId: string }} pending
 */
export function rewriteXdevCompactBranch(branch, pending) {
	return branch.map((entry) => {
		if (entry.type !== "message") return entry;
		const message = entry.message;
		if (message.role === "assistant") {
			// omp persists an aborted turn as one empty text block; pi-context's
			// advance check ignores only a truly empty aborted assistant.
			if (
				message.stopReason === "aborted" &&
				!message.content.some((block) => block.type !== "text" || block.text !== "")
			) {
				return { ...entry, message: { ...message, content: [] } };
			}
			let changed = false;
			const content = message.content.map((block) => {
				if (block.type !== "toolCall" || block.id !== pending.toolCallId || block.name !== "write") return block;
				changed = true;
				return { ...block, name: "context_compact" };
			});
			return changed ? { ...entry, message: { ...message, content } } : entry;
		}
		if (message.role === "toolResult" && message.toolCallId === pending.toolCallId && message.toolName === "write") {
			return { ...entry, message: { ...message, toolName: "context_compact" } };
		}
		return entry;
	});
}
