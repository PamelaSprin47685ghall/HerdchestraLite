/**
 * Install the visible manual acceptance auditor on the current GoalCore.
 *
 * Inputs: the goal facade result (for the install entry point) or one GoalCore
 * (for the retry inside the tool gate).
 * Output: void for the facade entry point; whether the current core ends up
 * with our auditor for the per-core helper.
 * Old location: vibe-workers.ts installManualAcceptanceAuditorOnCore and
 * installManualAcceptanceAuditor, VW 1291-1327.
 *
 * omp evaluates this module once per process but rebinds the factory to every
 * session, including subagents. Each binding gets its own GoalCore, so the
 * installed auditor is tracked per function object in a WeakSet, not in one
 * slot that the newest binding would overwrite. The module-level boolean only
 * answers "has any core installed the visible auditor yet", which is what
 * `main.mjs` needs for its session_start retry.
 */

import { confirmAuditorReplacement, requireDependencies, requireGoalCore } from "../host/capabilities.mjs";
import { runVisibleManualAcceptanceAuditor } from "../manual-acceptance/auditor.mjs";

const installedManualAcceptanceAuditors = new WeakSet();
let manualAcceptanceAuditorInstalled = false;

/**
 * Install the auditor on one GoalCore. Safe to call again for the same core.
 * @param {object} core
 * @returns {boolean} true when this core now runs the visible auditor
 */
export function installManualAcceptanceAuditorOnCore(core) {
	const dependencies = core?.dependencies;
	if (dependencies === null || typeof dependencies !== "object") return false;
	const current = dependencies.runCompletionAuditor;
	if (typeof current === "function" && installedManualAcceptanceAuditors.has(current)) return true;
	// Replace only this dependency. The rest of goal-x's completion flow stays.
	const auditor = (auditArgs) => runVisibleManualAcceptanceAuditor(core, auditArgs);
	dependencies.runCompletionAuditor = auditor;
	if (dependencies.runCompletionAuditor !== auditor) return false;
	installedManualAcceptanceAuditors.add(auditor);
	manualAcceptanceAuditorInstalled = true;
	return true;
}

/**
 * @param {{ api: object }} goal
 * @returns {void}
 */
export function installManualAcceptanceAuditor(goal) {
	const core = requireGoalCore(goal.api);
	if (core === undefined) return;
	if (requireDependencies(core) === undefined) return;
	if (!confirmAuditorReplacement(installManualAcceptanceAuditorOnCore(core))) return;
	manualAcceptanceAuditorInstalled = true;
}

/** @returns {boolean} whether any GoalCore has installed the visible auditor */
export function isManualAcceptanceAuditorInstalled() {
	return manualAcceptanceAuditorInstalled;
}
