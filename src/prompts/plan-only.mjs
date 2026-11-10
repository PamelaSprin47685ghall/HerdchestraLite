/**
 * P5: append the Plan-only override to pi-goal-x's guided goal draft prompt.
 *
 * Depends on nothing; pi-goal/facade.mjs calls it for every guided draft. A
 * guided goal draft is the planning part of goal mode; pi-goal-x calls it a
 * lightweight conversation and lets a concrete topic skip
 * to the proposal, while the Plan-only protocol needs S1, S2, and S3 first.
 * Old location: vibe-workers.ts adaptGoalDraftPrompt, VW 2225-2252.
 * No fallback: non-goal-draft content returns unchanged, byte for byte.
 */

/**
 * Append the override only when the draft carries the goal confirmation block.
 * @param {string} content
 * @returns {string}
 */
export function adaptGoalDraftPrompt(content) {
	if (!content.includes("[GOAL CONFIRMATION")) return content;
	return [
		content,
		"",
		"[PLAN-ONLY PROTOCOL]",
		"This guided goal draft is the planning part of goal mode. Apply the Plan-only protocol from the system prompt. It overrides the lightweight-conversation and proceed-directly instructions above.",
		"Work in four stages, artifact first, confirmation second. Each stage is an open-ended clarification loop; 100 or more rounds is acceptable. Keep clarifying and revising until no further question or change remains. Do not shorten a stage because it feels long or looks good enough. Never ask whether to continue before the stage artifact exists; if information is missing, write a complete draft, put open questions at the end, then ask.",
		"S1: the only deliverable is a manual test requirements sheet at docs/manual-acceptance/<slug>/requirements.md. Write it, then ask the user to approve it.",
		"S1 must write a scoring rubric for every CASE. The rubric may use score bands or a continuous formula, but it must map observable evidence to the full 0–100 range, explicitly define the CASE's PASS threshold and the score just below it, name hard-fail conditions and deductions for missing non-happy paths, state rounding/granularity and the minimum evidence required, and be reproducible: two auditors with the same evidence should score within ±5. Dimension weights, adjectives, or a copied template are not a rubric. The S1 AI authors these rubrics.",
		"The S1 requirements sheet is invalid if any CASE has no scoring rubric.",
		"Each CASE's scoring rubric must state how the S4 auditor scores the CASE twice from its own subjective willingness to pay, using the rubric and observed manual evidence: `user_score` for the external effect a software user would pay for, and `developer_score` for the internal quality a tool developer would pay for. Neither score requires real user or developer testimony. The CASE's final score is min(user_score, developer_score), compared with the original threshold; Wow is folded into these two scores and is not a separate pass threshold.",
		"These are the auditor's subjective willingness-to-pay estimates, not actual market probabilities or fabricated user testimony. A single number cannot replace real behavioral evidence; both scores must still rest on observed behavior.",
		"S2: the only deliverable is a development guide at docs/manual-acceptance/<slug>/development-guide.md. Write it, then ask the user to approve it.",
		"S3: the only deliverable is a coordination book at docs/manual-acceptance/<slug>/coordination.md. Write it, then ask the user to approve it.",
		"S4: the deliverable is a manual test report at docs/manual-acceptance/<slug>/report.md, written by the visible auditor after execution; then ask for final confirmation.",
		"Each stage passes only when the user explicitly approves its artifact. Do not enter the next stage on silence or an implied yes.",
		"Call propose_goal_draft only after the user explicitly approves the S3 coordination book. Never call it earlier and never bypass the S3 approval.",
		"The objective must contain exactly this single line, on one line, with the real goal slug substituted for <slug>:",
		"Verification contract: MANUAL ACCEPTANCE — requirements: docs/manual-acceptance/<slug>/requirements.md; development-guide: docs/manual-acceptance/<slug>/development-guide.md; coordination: docs/manual-acceptance/<slug>/coordination.md; automated tests are NOT acceptance evidence.",
		"Every task's verification_contract must describe the manual steps and observations that prove the task, not a test suite or command.",
	].join("\n");
}
