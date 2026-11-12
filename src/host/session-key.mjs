/**
 * Session identity for plugin-local state.
 *
 * Beacons, Ariadne timelines, and sandbox pools belong to one host session.
 * They must never key off the process, the cwd, or an agent template id:
 * those make independent sessions share state. The host exposes a stable
 * `sessionManager.getSessionId()`; the session file is only a fallback.
 * A context without any session identity gets its own WeakMap key, so the
 * failure mode is over-isolation, never cross-session bleed.
 */

const detachedKeys = new WeakMap();
let detachedSeq = 0;

export function sessionIdentity(ctx) {
	const manager = ctx?.sessionManager;
	const id = manager?.getSessionId?.();
	if (typeof id === "string" && id.length > 0) return id;
	const file = manager?.getSessionFile?.();
	if (typeof file === "string" && file.length > 0) return file;
	return null;
}

export function hostSessionKey(ctx) {
	const identity = sessionIdentity(ctx);
	if (identity !== null) return identity;
	if (ctx !== null && typeof ctx === "object") {
		let key = detachedKeys.get(ctx);
		if (key === undefined) {
			detachedSeq += 1;
			key = `detached-ctx-${detachedSeq}`;
			detachedKeys.set(ctx, key);
		}
		return key;
	}
	detachedSeq += 1;
	return `detached-ctx-${detachedSeq}`;
}
