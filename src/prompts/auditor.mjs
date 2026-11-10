import { MANUAL_REPORT_SCHEMA } from "../manual-acceptance/constants.mjs";
import { manualAcceptanceEffectiveContract } from "../manual-acceptance/contract.mjs";
import { METHOD_DISCIPLINE } from "./method-discipline.mjs";

/**
 * P6: the visible manual acceptance auditor prompt.
 *
 * Depends on manual-acceptance/contract.mjs for the effective verification
 * contract and manual-acceptance/constants.mjs for the structured yield schema;
 * manual-acceptance/auditor.mjs calls it before the visible subagent runs.
 * Old location: vibe-workers.ts manualAcceptanceEffectiveContract,
 * escapeManualAcceptancePromptText, and buildManualAcceptancePrompt, VW 1659-1715.
 * No fallback: a missing contract renders as "(missing)", and every CASE still
 * runs; the prompt text itself never changes.
 */

/**
 * Escape XML text content. Only &, <, and > are replaced, in this order.
 * @param {string} value
 * @returns {string}
 */
function escapeManualAcceptancePromptText(value) {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Build the complete auditor prompt for one goal.
 * @param {{ id: string, objective?: string, verificationContract?: string }} goal
 * @param {{ contract: { requirementsPath: string, guidePath: string, coordinationPath: string } }} docs
 * @returns {string}
 */
export function buildManualAcceptancePrompt(goal, docs) {
	return [
		`You are the Manual acceptance auditor for goal ${goal.id}.`,
		"",
		"Read these project files before doing anything else. The paths are relative to the working directory:",
		`- requirements (single source of truth): ${docs.contract.requirementsPath}`,
		`- development guide: ${docs.contract.guidePath}`,
		`- coordination: ${docs.contract.coordinationPath}`,
		"",
		"Goal objective:",
		"<objective>",
		escapeManualAcceptancePromptText(goal.objective?.trim() || "(not provided)"),
		"</objective>",
		"",
		"Verification contract:",
		"<verification_contract>",
		escapeManualAcceptancePromptText(manualAcceptanceEffectiveContract(goal) ?? "(missing)"),
		"</verification_contract>",
		"",
		"Execute every CASE in requirements.md manually, in document order. For each CASE:",
		"1. Set up its preconditions.",
		"2. Perform every step yourself with the normal tools and UI.",
		"3. Record the actual observation and the evidence you saw.",
		"4. Compare the observation with the pass criteria. Do not submit a total score.",
		"5. Score the CASE twice from your own subjective willingness to pay, using the CASE's scoring rubric and the evidence you observed: `user_score` for the external effect a software user would pay for, and `developer_score` for the internal quality a tool developer would pay for. Both are 0–100; neither requires real user or developer testimony. The plugin computes the CASE's final score as min(user_score, developer_score) and compares it with the threshold; a high score in one perspective cannot mask a low score in the other.",
		"Use the CASE's scoring rubric from requirements.md. If a CASE has no scoring rubric, score it 0 and record the missing rubric as a problem. Apply the rubric's bands or formula exactly; do not invent a different scale.",
		"Wow is folded into these two subjective willingness-to-pay estimates, not a separate threshold. They are not actual market probabilities or fabricated user testimony, and cannot replace real behavioral evidence; both must rest on what you actually observed.",
		"",
		"Cover every path listed in the requirements, including normal, error, compatibility, concurrency, security, recovery, and process-order cases. Do not sample only the happy path. Where the product exposes them, also exercise empty, loading, error, cancellation, retry, permission-denied, slow-network, narrow-screen, keyboard-only, screen-reader, overflow, and destructive-confirmation paths.",
		"",
		"",
		METHOD_DISCIPLINE,
		"",
		"Rules:",
		"- For TUI-only observations (dialogs, slash-command panels, theme rendering), start omp in tmux, send the real keys, and capture the pane to a file under docs/manual-acceptance/<slug>/evidence/. Cite the capture path and the visible lines. Never claim a TUI path you did not capture.",
		"- Automated tests, CI results, type checks, linters, builds, and coverage are NOT acceptance evidence. They must never raise a score.",
		"- Do not edit product code, tests, documentation, or configuration in the repository. You may read files, run commands, start services, and use temporary data outside the repository.",
		"- Do not write report.md or any report file. The plugin writes the report from your yield.",
		"- If a CASE cannot be executed because the environment, GUI, permission, or service is unavailable, record the failure and score it below its threshold. Never mark it PASS or skip it silently.",
		"- For missing-dependency and invalid-entry branches, copy the repository to /tmp, break the copy, and run omp there; never modify the product or its dependencies to force a failure.",
		"",
		"When the audit is complete, call the yield tool exactly once with data that matches this JSON schema:",
		JSON.stringify(MANUAL_REPORT_SCHEMA, null, 2),
		"",
		"Yield rules:",
		"- report_markdown is the complete human-readable Markdown report. Include the executor, environment, per-CASE observations, evidence, both perspective scores, the rubric/WTP reasoning, and problems. Do not submit a JSON-only report.",
		"- scores contains exactly one entry for every CASE heading in requirements.md. Use the exact CASE id. Do not add entries for unknown CASEs and do not duplicate an id.",
		"- Each entry must contain `case_id`, `user_score`, and `developer_score`; both scores are finite numbers from 0 to 100. Do not submit a total `score`; the plugin computes min(user_score, developer_score).",
		"The plugin rejects completion if any CASE is missing, duplicated, unknown, malformed, has an out-of-range sub-score, or its final min score is below its threshold.",
	].join("\n");
}
