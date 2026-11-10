/**
 * Goal settings probes used by the manual acceptance guards.
 *
 * The project settings file is `<cwd>/.pi/pi-goal-x-settings.json`; the
 * dependency owns path resolution, caching, and tolerant parsing.
 */

import { loadGoalSettingsFileConfig } from "./imports.mjs";

/**
 * Completion rejection text from VW 1266-1270, kept verbatim.
 */
export const GOAL_AUDITOR_DISABLED_MESSAGE =
	'The visible manual acceptance auditor is disabled in the goal settings file. Set "disabled": false in the project goal settings (.pi/pi-goal-x-settings.json), then retry completion.';

/**
 * Whether the project goal settings file disables the auditor.
 *
 * A missing or unreadable file is unknown, not disabled, so callers can
 * fail closed instead of guessing. Only an explicit boolean is returned.
 *
 * @param {string} cwd
 * @returns {boolean | undefined}
 */
export function isGoalAuditorDisabled(cwd) {
	try {
		const disabled = loadGoalSettingsFileConfig(cwd)?.disabled;
		if (typeof disabled === "boolean") return disabled;
		return undefined;
	} catch {
		return undefined;
	}
}
