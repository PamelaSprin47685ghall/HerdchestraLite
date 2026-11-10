/**
 * Goal settings probes used by the manual acceptance guards.
 *
 * The project settings file is `<cwd>/.pi/pi-goal-x-settings.json` by
 * default; `pi-goal-x` owns path resolution, including its environment
 * override.
 */

import { readFileSync } from "node:fs";
import { goalSettingsPath } from "./imports.mjs";

/**
 * Completion rejection text from VW 1266-1270, kept verbatim.
 */
export const GOAL_AUDITOR_DISABLED_MESSAGE =
	'The visible manual acceptance auditor is disabled in the goal settings file. Set "disabled": false in the project goal settings (.pi/pi-goal-x-settings.json), then retry completion.';

/**
 * Whether the project goal settings file disables the auditor.
 *
 * A missing file is not disabled: the old `.disabled === true` check also
 * passed when the file was absent. A present but unreadable file, invalid
 * JSON, or a non-object/ill-typed payload is unknown, so callers can fail
 * closed instead of guessing.
 *
 * @param {string} cwd
 * @returns {boolean | undefined}
 */
export function isGoalAuditorDisabled(cwd) {
	let text;
	try {
		text = readFileSync(goalSettingsPath(cwd), "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		return undefined;
	}

	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return undefined;
	}

	const disabled = parsed.disabled;
	if (disabled === true) return true;
	if (disabled === false) return false;
	if (disabled === undefined) return false;
	return undefined;
}
