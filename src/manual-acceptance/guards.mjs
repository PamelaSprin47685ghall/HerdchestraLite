/**
 * Manual-acceptance guards for the goal tools.
 *
 * Inputs: one `GoalToolGuardInput` — the tool name, its params, the goal core,
 * and the extension context.
 * Output: `undefined` to allow the call, or the exact rejection text to return.
 *
 * The create guard freezes document hashes into the objective before the goal
 * exists. The completion guard refuses `status: "complete"` until the frozen
 * contract still matches the files on disk. Every rejection string is copied
 * verbatim from the old implementation; the guards never modify documents.
 */

import { createHash } from "node:crypto";
import { GOAL_AUDITOR_DISABLED_MESSAGE, isGoalAuditorDisabled } from "../host/goal-settings.mjs";
import {
	AUTOMATED_ACCEPTANCE_PATTERNS,
	MANUAL_ACCEPTANCE_CONTRACT_MISSING,
	MANUAL_ACCEPTANCE_DOCUMENTS,
	MANUAL_ACCEPTANCE_HASH_REQUIREMENT,
	MANUAL_ACCEPTANCE_WORD_RE,
} from "./constants.mjs";
import {
	freezeManualAcceptanceObjective,
	manualAcceptanceContractLine,
	manualAcceptanceDirectory,
	manualAcceptanceFrozenLine,
	manualProposeGateRejection,
	parseManualContractParts,
	validateManualDocuments,
} from "./contract.mjs";
import { manualAcceptanceDocumentSlots, readManualAcceptanceDocuments } from "./documents.mjs";

const GOAL_SETTINGS_UNREADABLE_MESSAGE =
	'The project goal settings file (.pi/pi-goal-x-settings.json) could not be read, so the visible manual acceptance auditor state is unknown. Fix or remove the file, set "disabled": false, then retry completion.';

export function proposeManualAcceptanceGuard(input) {
	if (input.toolName !== "propose_goal_draft") return undefined;
	if (typeof input.params !== "object" || input.params === null) {
		return manualProposeGateRejection("an objective with the manual acceptance contract");
	}
	const params = input.params;
	// The objective still carries the contract line at propose time; goal.verificationContract does not exist yet.
	const objective = params.objective;
	if (typeof objective !== "string" || !objective.trim()) {
		return manualProposeGateRejection("a non-empty string objective");
	}
	// A hashless proposal is normal: parse the shape now and freeze it below.
	const parsed = parseManualContractParts(objective);
	if (!parsed.ok) {
		return manualProposeGateRejection(
			parsed.reason === "hash" ? MANUAL_ACCEPTANCE_HASH_REQUIREMENT : MANUAL_ACCEPTANCE_CONTRACT_MISSING,
		);
	}
	if (parsed.hashes.size !== 0 && parsed.hashes.size !== MANUAL_ACCEPTANCE_DOCUMENTS.size) {
		return manualProposeGateRejection(MANUAL_ACCEPTANCE_HASH_REQUIREMENT);
	}
	const located = manualAcceptanceDirectory(input.ctx.cwd, parsed.contract.slug);
	if (!located.ok) return manualProposeGateRejection(located.error);
	const read = readManualAcceptanceDocuments(located.directory, parsed.contract);
	if (!read.ok) return manualProposeGateRejection(read.error);
	const hashes = new Map();
	for (const slot of manualAcceptanceDocumentSlots(parsed.contract)) {
		const actual = createHash("sha256").update(read.markdown.get(slot.name), "utf8").digest("hex");
		hashes.set(slot.name, actual);
		const claimed = parsed.hashes.get(slot.name);
		// A claim that no longer matches the files is rejected, never silently refreshed.
		if (claimed !== undefined && claimed !== actual) {
			return manualProposeGateRejection(`${slot.path} hash mismatch (the file changed after the contract was frozen)`);
		}
	}
	const frozenObjective = freezeManualAcceptanceObjective(
		objective,
		manualAcceptanceFrozenLine(parsed.contract, hashes),
	);
	if (frozenObjective === undefined) return manualProposeGateRejection(MANUAL_ACCEPTANCE_CONTRACT_MISSING);
	try {
		params.objective = frozenObjective;
	} catch {
		return manualProposeGateRejection(
			"a writable objective (the contract line could not be frozen with document hashes)",
		);
	}
	const validation = validateManualDocuments(input.ctx.cwd, frozenObjective);
	if (!validation.ok) return manualProposeGateRejection(validation.error);
	return manualTaskContractRejection(params.tasks);
}

function manualAcceptanceTaskLabel(task, index) {
	const id = typeof task.id === "string" ? task.id.trim() : "";
	return id ? `"${id.slice(0, 40)}"` : `#${index + 1}`;
}

/** A task contract may add manual evidence, but it may never name an automated gate. */
function manualTaskContractRejection(tasks) {
	if (!Array.isArray(tasks)) return undefined;
	for (let index = 0; index < tasks.length; index++) {
		const task = tasks[index];
		if (typeof task !== "object" || task === null) continue;
		const value = task.verification_contract;
		if (value === undefined || value === null) continue;
		const label = manualAcceptanceTaskLabel(task, index);
		if (typeof value !== "string") {
			return manualProposeGateRejection(`a string verification_contract for task ${label}`);
		}
		const contract = value.trim();
		if (!contract) continue;
		if (AUTOMATED_ACCEPTANCE_PATTERNS.some((pattern) => pattern.test(contract))) {
			return manualProposeGateRejection(
				`manual acceptance steps in the verification_contract of task ${label} (it describes an automated test, not manual steps)`,
			);
		}
		if (!MANUAL_ACCEPTANCE_WORD_RE.test(contract)) {
			return manualProposeGateRejection(
				`manual acceptance steps in the verification_contract of task ${label} (it must contain "manual" or "手工")`,
			);
		}
	}
	return undefined;
}

export function updateManualAcceptanceGuard(input) {
	if (input.toolName !== "update_goal") return undefined;
	const params = input.params;
	if (!params || typeof params !== "object") return undefined;
	if (!("status" in params) || params.status !== "complete") return undefined;
	const reject = (reason) => `update_goal REJECTED (manual acceptance gate).\n${reason}`;
	const goal = input.core.state?.goal;
	if (!goal) {
		return reject("The goal state is unavailable; reload the focused goal and retry completion.");
	}
	if (goal.skipAuditor === true) {
		return reject(
			"The visible manual acceptance auditor cannot be skipped. This goal has skipAuditor enabled. Remove skipAuditor, then retry completion.",
		);
	}
	const disabled = isGoalAuditorDisabled(input.ctx.cwd);
	if (disabled === true) {
		return reject(GOAL_AUDITOR_DISABLED_MESSAGE);
	}
	if (disabled === undefined) {
		return reject(GOAL_SETTINGS_UNREADABLE_MESSAGE);
	}
	// goal-x extracts the single "Verification contract:" line from the
	// objective into goal.verificationContract. If the line is still embedded
	// (disableContracts keeps it), it is the effective contract and must win:
	// appending the extracted value would duplicate or mask it. Otherwise
	// rebuild the line so validation sees the contract the goal was created
	// with.
	const embedded = manualAcceptanceContractLine(goal.objective ?? "");
	const objective = embedded
		? goal.objective
		: goal.verificationContract
			? `${goal.objective}\nVerification contract: ${goal.verificationContract}`
			: goal.objective;
	const validation = validateManualDocuments(input.ctx.cwd, objective);
	if (!validation.ok) {
		return reject(
			`${validation.error}\nRestore the S1/S2/S3 documents and the MANUAL ACCEPTANCE contract, then retry completion.`,
		);
	}
	return undefined;
}

/** Guards run before a tool's own execute; the first non-undefined string wins. */
export const goalToolGuards = [proposeManualAcceptanceGuard, updateManualAcceptanceGuard];

export function runGoalToolGuards(input) {
	for (const guard of goalToolGuards) {
		const rejection = guard(input);
		if (rejection !== undefined) return rejection;
	}
	return undefined;
}
