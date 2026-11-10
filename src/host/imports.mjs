/**
 * Host and dependency imports for HerdchestraLite.
 *
 * Every external package import lives here. Domain modules import from this
 * module so that host version drift has one place to land.
 *
 * The deep paths (`@oh-my-pi/pi-coding-agent/task/...`, `pi-context/src`,
 * `pi-goal-x/extensions`) only resolve inside omp's extension loader, where
 * the host rewrites `@earendil-works/*`. Loading this file with plain Node or
 * Bun outside omp is expected to fail.
 */

/**
 * omp extension API passed to each entry factory.
 * @typedef {import("@oh-my-pi/pi-coding-agent").ExtensionAPI} ExtensionAPI
 */

/**
 * Context supplied to events, tools, and commands.
 * @typedef {import("@oh-my-pi/pi-coding-agent").ExtensionContext} ExtensionContext
 */

/**
 * Context supplied to slash commands.
 * @typedef {import("@oh-my-pi/pi-coding-agent").ExtensionCommandContext} ExtensionCommandContext
 */

/**
 * Payload of the `context` event.
 * @typedef {import("@oh-my-pi/pi-coding-agent").ContextEvent} ContextEvent
 */

/**
 * One persisted session entry.
 * @typedef {import("@oh-my-pi/pi-coding-agent/session/session-entries").SessionEntry} SessionEntry
 */

import { AgentSession, Settings } from "@oh-my-pi/pi-coding-agent";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import goalExtension from "pi-goal-x/extensions/goal.ts";
import { loadGoalSettingsFileConfig } from "pi-goal-x/extensions/goal-settings.ts";
import piContextExtension from "pi-context/src/index.ts";

/**
 * Resolve the bundled agent roster loader.
 *
 * The documented `loadBundledAgents` entry point wins. Hosts that predate it
 * only expose the legacy `BUNDLED_AGENTS` accessor on `task`, so fall back to
 * that accessor when the `task/agents` subpath or export is unavailable.
 *
 * @returns {Promise<(() => unknown[]) | undefined>}
 */
async function resolveBundledAgentsLoader() {
	try {
		const agents = await import("@oh-my-pi/pi-coding-agent/task/agents");
		if (typeof agents.loadBundledAgents === "function") {
			return agents.loadBundledAgents;
		}
	} catch {
		// Older hosts do not expose the `task/agents` subpath.
	}
	const task = await import("@oh-my-pi/pi-coding-agent/task");
	return task.BUNDLED_AGENTS;
}

/**
 * Load the bundled agent definitions.
 *
 * Resolves to the documented `loadBundledAgents` export, or to the legacy
 * `BUNDLED_AGENTS` accessor. `undefined` means the host exposes neither.
 *
 * @type {(() => unknown[]) | undefined}
 */
const loadBundledAgents = await resolveBundledAgentsLoader();

export {
	AgentSession,
	Settings,
	goalExtension,
	loadBundledAgents,
	loadGoalSettingsFileConfig,
	piContextExtension,
	runSubprocess,
};
