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
// A GoalService belongs to one GoalCore today, but track the owner so a
// rebound session can never reuse an old core's approval state.
const gatedGoalServices = new WeakMap();
const manualAcceptanceApprovals = new WeakMap();
let manualAcceptanceAuditorInstalled = false;

const COMPLETION_WITHOUT_AUDIT_MESSAGE =
	"manual acceptance gate: completion without an approved visible auditor is not allowed; the goal remains active and the audit must complete";

/**
 * A completion approval belongs to one goal id on one GoalCore. The revision
 * may advance between the audit and the write: `accountProgress` can move an
 * active goal to budget_limited (revision +1) inside commitCompletion, and
 * that transition must not invalidate an already approved audit.
 */
function hasManualAcceptanceApproval(core, goalId, revision) {
	const approval = manualAcceptanceApprovals.get(core);
	return (
		approval !== undefined &&
		approval.goalId === goalId &&
		typeof approval.revision === "number" &&
		typeof revision === "number" &&
		revision >= approval.revision
	);
}

/** Drop any approval from an earlier completion attempt. */
export function clearManualAcceptanceApproval(core) {
	manualAcceptanceApprovals.delete(core);
}

/**
 * Refuse a completion write that did not come from an approved audit.
 *
 * `update_goal({status: "complete"})` commits through
 * `core.goalService.apply` in every path: the normal auditor result, the
 * `skipAuditor`/settings bypass, and the Escape "Mark complete without audit"
 * choice. Wrapping the mutation keeps the rejection before any write, so the
 * goal file and memory both stay active. `archive: true` is left alone: that is
 * the user's clear/abort archive and the turn_end archive of a goal that was
 * already completed.
 */
function installGoalServiceGate(core) {
	const service = core?.goalService;
	if (!service || typeof service.apply !== "function") return;
	if (gatedGoalServices.has(service)) {
		gatedGoalServices.set(service, core);
		return;
	}
	gatedGoalServices.set(service, core);
	const apply = service.apply;
	service.apply = function applyGated(ctx, spec) {
		if (!spec || typeof spec.mutate !== "function" || spec.archive === true) {
			return apply.call(this, ctx, spec);
		}
		const mutate = spec.mutate;
		return apply.call(this, ctx, {
			...spec,
			mutate(current) {
				const next = mutate(current);
				const owner = gatedGoalServices.get(service);
				if (
					next?.status === "complete" &&
					(!owner || !hasManualAcceptanceApproval(owner, current?.id, current?.revision))
				) {
					throw new Error(COMPLETION_WITHOUT_AUDIT_MESSAGE);
				}
				// One approval authorizes one completion write. The next attempt
				// must run the auditor again.
				if (next?.status === "complete" && owner) manualAcceptanceApprovals.delete(owner);
				return next;
			},
		});
	};
}

/**
 * Install the auditor on one GoalCore. Safe to call again for the same core.
 * @param {object} core
 * @returns {boolean} true when this core now runs the visible auditor
 */
export function installManualAcceptanceAuditorOnCore(core) {
	installGoalServiceGate(core);
	const dependencies = core?.dependencies;
	if (dependencies === null || typeof dependencies !== "object") return false;
	const current = dependencies.runCompletionAuditor;
	if (typeof current === "function" && installedManualAcceptanceAuditors.has(current)) return true;
	// Replace only this dependency. The rest of goal-x's completion flow stays.
	const auditor = async (auditArgs) => {
		// A new attempt always needs a new approval, even if the caller bypasses
		// the tool wrapper.
		clearManualAcceptanceApproval(core);
		const result = await runVisibleManualAcceptanceAuditor(core, auditArgs);
		if (result?.approved === true) {
			const goalId = auditArgs?.goal?.id ?? core.state?.goal?.id;
			if (typeof goalId === "string") {
				manualAcceptanceApprovals.set(core, { goalId, revision: auditArgs?.goal?.revision });
			}
		}
		return result;
	};
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
