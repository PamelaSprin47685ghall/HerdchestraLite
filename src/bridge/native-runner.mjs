/**
 * Controlled capture of the host's live `ExtensionRunner`.
 *
 * This is the one deliberate host prototype patch in HerdchestraLite. The
 * extension API exposes neither the runner nor the native built-in tools, yet
 * the sandbox's `read` / `write` capabilities must execute the host's official
 * tools instead of bypassing them with `node:fs`. The runner's public
 * `invokeNativeTool` is the supported delegation target once the runner is
 * reachable; wrapping `ExtensionRunner.prototype.createContext` is the only
 * observed way to reach it.
 *
 * Why this file imports the runner lazily instead of `host/imports.mjs`:
 * `imports.mjs` eagerly imports the host package root, whose source graph is
 * not loadable outside a running omp (tests of the sandbox must not pull it).
 * The literal dynamic specifier is rewritten by the omp extension loader to
 * the host's bundled module registry, so the patched class is the same object
 * the host itself uses (verified against omp 18.20.0). Outside the host the
 * import fails, capture reports `unavailable`, and the sandbox fails closed.
 *
 * Observed host layout (2026-11-13, omp 18.20.0):
 * - `@oh-my-pi/pi-coding-agent/extensibility/extensions/runner` exports
 *   `ExtensionRunner`; `createContext` is on its prototype.
 * - `ExtensionToolWrapper.execute` calls `runner.createContext(...)` before
 *   every extension tool execution.
 * - `runner.hasNativeTool(name)` and `runner.invokeNativeTool(name, params,
 *   options)` execute the native built-in.
 * - The compiled binary serves the specifier through
 *   `omp-legacy-pi-bundled:` (single module registry).
 *
 * Rollback: remove the `installRunnerCapture()` call and this module; the
 * sandbox returns to fail-closed `HOST_API_MISMATCH` and never falls back to
 * direct filesystem access.
 */

const RUNNER_CAPTURE_KEY = Symbol.for("herdchestra.runnerCapture.v1");

/**
 * Shared capture state.
 *
 * Stored on `globalThis` so repeated extension loads (the host re-imports with
 * an `?mtime=` cache key) share one patched prototype instead of chaining
 * wrappers. `byContext` keys the exact `ExtensionContext` object the wrapper
 * hands to each tool execution, so concurrent sessions never borrow each
 * other's runner.
 */
function runnerCaptureState() {
	let state = globalThis[RUNNER_CAPTURE_KEY];
	if (state === undefined) {
		state = {
			status: "idle",
			error: null,
			runner: null,
			prototype: null,
			original: null,
			byContext: new WeakMap(),
		};
		Object.defineProperty(globalThis, RUNNER_CAPTURE_KEY, {
			value: state,
			enumerable: false,
			configurable: true,
			writable: false,
		});
	}
	return state;
}

let installPromise = null;

/**
 * Patch `ExtensionRunner.prototype.createContext` once and remember the live
 * runner. Returns a restore function.
 *
 * @returns {Promise<() => void>}
 */
export async function installRunnerCapture() {
	const state = runnerCaptureState();
	if (state.status === "installed") return () => restoreRunnerCapture();
	if (state.status === "unavailable") {
		throw new Error(state.error ?? "native tool runner capture is unavailable");
	}
	if (installPromise !== null) return installPromise;
	installPromise = (async () => {
		try {
			const module = await import("@oh-my-pi/pi-coding-agent/extensibility/extensions/runner");
			const prototype = module?.ExtensionRunner?.prototype;
			if (prototype === undefined || typeof prototype.createContext !== "function") {
				throw new Error("ExtensionRunner.createContext is unavailable");
			}
			if (state.status !== "installed") {
				const original = prototype.createContext;
				prototype.createContext = function patchedCreateContext(...args) {
					const ctx = original.apply(this, args);
					state.runner = this;
					if (ctx !== null && (typeof ctx === "object" || typeof ctx === "function")) {
						state.byContext.set(ctx, this);
					}
					return ctx;
				};
				state.prototype = prototype;
				state.original = original;
				state.status = "installed";
				state.error = null;
			}
			return () => restoreRunnerCapture();
		} catch (error) {
			state.status = "unavailable";
			state.error = error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			installPromise = null;
		}
	})();
	return installPromise;
}

/**
 * Remove the capture patch. Used by tests and by a future host adapter that
 * supplies a public runner handle; production keeps the patch installed.
 */
export function restoreRunnerCapture() {
	const state = runnerCaptureState();
	if (state.status === "installed" && state.prototype !== null && state.original !== null) {
		state.prototype.createContext = state.original;
	}
	state.status = "idle";
	state.error = null;
	state.runner = null;
	state.prototype = null;
	state.original = null;
	state.byContext = new WeakMap();
}

/** The most recently observed live runner, for diagnostics and last resort. */
export function getNativeRunner() {
	return runnerCaptureState().runner;
}

/**
 * The runner whose `createContext` produced this exact context object.
 *
 * @param {unknown} context
 */
export function runnerForContext(context) {
	const state = runnerCaptureState();
	if (context !== null && (typeof context === "object" || typeof context === "function")) {
		const runner = state.byContext.get(context);
		if (runner !== undefined) return runner;
	}
	return state.runner;
}

/** Observable capture facts for `/clj-status` and health records. */
export function runnerCaptureStatus() {
	const state = runnerCaptureState();
	return Object.freeze({
		status: state.status,
		error: state.error,
		captured: state.runner !== null,
	});
}
