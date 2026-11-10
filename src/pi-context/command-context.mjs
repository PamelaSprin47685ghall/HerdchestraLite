/**
 * Build the extension contexts pi-context expects.
 *
 * pi-context is written against Pi's extension API. omp's legacy Pi shim covers
 * most of it; this adapter fills the gaps the shim cannot: command-context
 * acquisition and tree navigation from non-command hooks.
 *
 * Inputs: a live extension context, plus a callback that drops the pending
 * xdev compact.
 * Output: an ExtensionContext whose session manager rewrites the branch while
 * an xdev compact is pending, and an ExtensionCommandContext with the
 * command-only methods.
 * Old location: vibe-workers.ts createSessionManagerView, createPiContext,
 * createCommandContext, VW 2002-2074.
 * No fallback: placeholder command methods report cancellation; navigation
 * falls back to the session manager's branch mutation.
 */

import { liveAgentSession } from "./session-capture.mjs";
import { pendingXdevCompact, rewriteXdevCompactBranch } from "./xdev-compact.mjs";

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * @param {any} sessionManager
 */
function createSessionManagerView(sessionManager) {
	return new Proxy(sessionManager, {
		get(target, property) {
			if (property === "getBranch") {
				return () => {
					const branch = target.getBranch();
					const pending = pendingXdevCompact(target.getSessionId());
					return pending ? rewriteXdevCompactBranch(branch, pending) : branch;
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * @param {any} base
 */
export function createPiContext(base) {
	const ctx = Object.create(base);
	ctx.sessionManager = createSessionManagerView(base.sessionManager);
	return ctx;
}

/**
 * @param {any} base
 * @param {() => void} clearXdevCompact
 */
export function createCommandContext(base, clearXdevCompact) {
	// Trigger the capture before the synthesized context escapes this call.
	try {
		base.getContextUsage();
	} catch {
		// Navigation has a leaf-only fallback.
	}
	// Inherit the live handler context (ui, sessionManager, cwd, ...) and add
	// the command-only methods pi-context reaches for.
	const ctx = Object.create(base);
	ctx.getContextUsage = () => base.getContextUsage();
	ctx.waitForIdle = async () => {
		while (!base.isIdle()) await sleep(25);
	};
	ctx.navigateTree = async (targetId, options) => {
		const session = liveAgentSession(base.sessionManager);
		if (session && typeof session.navigateTree === "function") {
			const result = await session.navigateTree(targetId, { summarize: options?.summarize });
			clearXdevCompact();
			return { cancelled: result?.cancelled === true };
		}
		// The runtime manager exposes mutation methods the readonly type omits.
		const sessionManager = base.sessionManager;
		if (typeof sessionManager.branch === "function") sessionManager.branch(targetId);
		clearXdevCompact();
		return { cancelled: false };
	};
	// pi-context only needs the methods above; these keep the command context
	// shape honest if a future version reaches for one.
	ctx.newSession = async () => ({ cancelled: true });
	ctx.branch = async () => ({ cancelled: true });
	ctx.switchSession = async () => ({ cancelled: true });
	ctx.reload = async () => {};
	ctx.compact = async () => {};
	return ctx;
}
