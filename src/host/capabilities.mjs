/**
 * Host capability probes for the manual acceptance auditor.
 *
 * Every message below is copied verbatim from `vibe-workers.ts`. Keep the
 * `vibe-workers:` prefix: existing logs and existing user-visible rejections
 * must not drift during the migration.
 */

import { loadBundledAgents, Settings } from "./imports.mjs";

/** @typedef {import("./imports.mjs").ExtensionAPI} ExtensionAPI */

/** VW 1309-1312. */
export const GOAL_CORE_UNAVAILABLE_MESSAGE =
	"vibe-workers: goal core unavailable; the visible manual acceptance auditor cannot install";

/** VW 1316-1319. */
export const GOAL_CORE_DEPENDENCIES_UNAVAILABLE_MESSAGE =
	"vibe-workers: goal core dependencies unavailable; the visible manual acceptance auditor cannot install";

/** VW 1322-1325. */
export const AUDITOR_REPLACEMENT_DID_NOT_STICK_MESSAGE =
	"vibe-workers: the visible manual acceptance auditor replacement did not stick";

/**
 * Return the goal core hanging off the extension API.
 *
 * Logs the legacy error and returns `undefined` when the core is missing, so
 * the caller can stop without installing a partial auditor.
 *
 * @param {ExtensionAPI & { _goalCore?: unknown }} api
 * @returns {object | undefined}
 */
export function requireGoalCore(api) {
	const core = api?._goalCore;
	if (core === null || typeof core !== "object") {
		console.error(GOAL_CORE_UNAVAILABLE_MESSAGE);
		return undefined;
	}
	return core;
}

/**
 * Return the dependency bag hanging off the goal core.
 *
 * Logs the legacy error and returns `undefined` when the bag is missing.
 *
 * @param {{ dependencies?: unknown } | undefined} core
 * @returns {object | undefined}
 */
export function requireDependencies(core) {
	const dependencies = core?.dependencies;
	if (dependencies === null || typeof dependencies !== "object") {
		console.error(GOAL_CORE_DEPENDENCIES_UNAVAILABLE_MESSAGE);
		return undefined;
	}
	return dependencies;
}

/**
 * Confirm that replacing `runCompletionAuditor` actually took effect.
 *
 * Logs the legacy error and returns `false` when the host rejected the
 * replacement, so the caller can report the same failure as before.
 *
 * @param {boolean} installed
 * @returns {boolean}
 */
export function confirmAuditorReplacement(installed) {
	if (!installed) {
		console.error(AUDITOR_REPLACEMENT_DID_NOT_STICK_MESSAGE);
		return false;
	}
	return true;
}

/**
 * Resolve the settings scope for the running host.
 *
 * Prefer the extension API's scoped settings, then the host singleton. Both
 * probes are best-effort: a host that exposes neither is handled by the
 * caller as "run without settings", which matches the old `try/catch`.
 *
 * @param {ExtensionAPI & { pi?: { settings?: unknown } }} pi
 * @returns {object | undefined}
 */
export function settingsScope(pi) {
	try {
		const scoped = pi?.pi?.settings;
		if (scoped !== undefined && scoped !== null) return scoped;
	} catch {
		// Fall through to the host singleton.
	}
	try {
		return Settings.instance;
	} catch {
		return undefined;
	}
}

/**
 * Load the bundled agent roster.
 *
 * `host/imports.mjs` already prefers `loadBundledAgents` and falls back to
 * `BUNDLED_AGENTS`; this probe only turns a load failure into `undefined`.
 *
 * @returns {unknown[] | undefined}
 */
export function bundledAgents() {
	if (typeof loadBundledAgents !== "function") return undefined;
	try {
		return loadBundledAgents();
	} catch {
		return undefined;
	}
}
