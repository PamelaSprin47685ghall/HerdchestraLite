/**
 * Wrap every pi-goal-x tool so the manual acceptance gate runs before the
 * tool's own execute. The gate fails closed: a gated tool cannot run until the
 * visible auditor is installed on the current GoalCore.
 *
 * Inputs: the host extension API (kept for the facade contract), a getter for
 * the current GoalCore, and one pi-goal-x tool definition.
 * Output: a tool definition with the same fields and a guarded execute.
 * Old location: vibe-workers.ts runGoalToolGuards and the tool wrapper inside
 * createGoalFacade, VW 1906-1912 and 2309-2366.
 * No fallback: an unavailable auditor throws; it never lets a gated tool pass.
 */

import { runGoalToolGuards } from "../manual-acceptance/guards.mjs";
import { clearManualAcceptanceApproval, installManualAcceptanceAuditorOnCore } from "./install-auditor.mjs";

export { runGoalToolGuards };

/**
 * @param {object} pi
 * @param {() => unknown} getCore
 * @param {object} tool
 * @returns {object}
 */
export function wrapGoalTool(pi, getCore, tool) {
	void pi;
	return {
		...tool,
		async execute(id, params, signal, onUpdate, ctx) {
			const core = getCore();
			// Until the visible auditor is installed, the gated tools fail
			// closed. Other tools keep their previous behavior.
			const gated =
				tool.name === "propose_goal_draft" ||
				(tool.name === "update_goal" &&
					typeof params === "object" &&
					params !== null &&
					"status" in params &&
					params.status === "complete");
			if (gated) {
				// A later session binding may have replaced this core's auditor
				// slot; retry once for this core before failing closed.
				const installed = typeof core === "object" && core !== null && installManualAcceptanceAuditorOnCore(core);
				if (!installed) {
					throw new Error(
						`manual acceptance gate unavailable: the visible auditor is not installed; refusing gated tool ${tool.name}.`,
					);
				}
				// A completion attempt needs a fresh approval from the audit that
				// runs inside this execute, not one left by an earlier attempt.
				if (tool.name === "update_goal") clearManualAcceptanceApproval(core);
			}
			// Guards run before the original execute. A rejection is thrown so
			// the guarded tool cannot continue past the gate.
			if (typeof core === "object" && core !== null) {
				const rejection = runGoalToolGuards({
					toolName: tool.name,
					params,
					ctx,
					core,
				});
				if (rejection !== undefined) throw new Error(rejection);
			}
			return tool.execute(id, params, signal, onUpdate, ctx);
		},
	};
}
