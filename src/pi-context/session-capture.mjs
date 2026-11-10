/**
 * Capture the live AgentSession instance behind a session id.
 *
 * pi-context is written against Pi's extension API. omp's legacy Pi shim covers
 * most of it; this adapter fills the gaps the shim cannot: command-context
 * acquisition and tree navigation from non-command hooks.
 *
 * Inputs: the host's AgentSession class and a session manager.
 * Output: a live-session lookup for tree navigation.
 * Old location: vibe-workers.ts installLiveSessionCapture, VW 110-129 and
 * liveAgentSession, VW 1951-1956.
 * No fallback: when the prototype lacks `getContextUsage`, nothing is patched;
 * a missing session simply returns undefined.
 */

const LIVE_AGENT_SESSIONS = new Map();
const CAPTURED_PROTOTYPES = new WeakSet();

/**
 * Patch `getContextUsage` once per prototype so it records the live instance.
 * The patch never changes host behavior: failures are swallowed.
 * @param {unknown} AgentSessionClass
 */
export function installLiveSessionCapture(AgentSessionClass) {
	const prototype = AgentSessionClass?.prototype;
	if (!prototype || CAPTURED_PROTOTYPES.has(prototype)) return;
	CAPTURED_PROTOTYPES.add(prototype);
	const original = prototype.getContextUsage;
	if (typeof original !== "function") return;
	prototype.getContextUsage = function (...args) {
		try {
			const id = this.sessionManager?.getSessionId?.();
			if (typeof id === "string") LIVE_AGENT_SESSIONS.set(id, new WeakRef(this));
		} catch {
			// Capability capture must never change host behavior.
		}
		return original.apply(this, args);
	};
}

/**
 * @param {{ getSessionId: () => string }} sessionManager
 * @returns {{ navigateTree?: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled?: boolean }> } | undefined}
 */
export function liveAgentSession(sessionManager) {
	const id = sessionManager.getSessionId();
	// Only AgentSession instances are stored in this map by the capture above.
	return LIVE_AGENT_SESSIONS.get(id)?.deref();
}
