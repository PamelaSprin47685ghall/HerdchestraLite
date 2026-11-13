/**
 * P1: role prompts, copied verbatim from AGENTS.md §8.4.
 *
 * ROLE_PROMPTS is loaded lazily by M0 on the first subagent spawn. S1/Plan
 * and Coordinator have no dedicated prompt text in §8.4: their prompt is
 * COMMON plus the current-stage briefing. Loading this module during S1 is
 * therefore only needed to obtain planDevops, which contains no S2–S5 text.
 *
 * Depends only on the canonical EDN + UFSS printer. The case-auditor builder
 * receives only one structured CASE record.
 */

import { EdnKeyword, printUfss } from "../clj-sandbox/ufss.mjs";

export const PLAN_DEVOPS_PROMPT = `[ROLE: PLAN DEVOPS — PRIVILEGED WORKER]
You are the privileged worker for the current Plan tenure: every Swarm Worker capability, plus call. You have no board and do not take a token.
- Use \`clj_devops\` for every Worker capability plus privileged \`call\`: \`cat\`, \`stat\`, \`ls\`, \`glob\`, \`write\`, \`mkdir\`, \`rm\`, \`mv\`, \`where\`, \`whereAll\`, \`park\`, \`unpark\`, \`abandon\`, and \`call\`. Trace full call chains, host internals, types, and edge cases; never skim heads/tails and guess.
- Writes go through the batch VFS. call is not a read-only probe. Finish strictly by calling \`submit_devops_report({ status, report_markdown, inspected_paths })\` with exact file paths, line spans, and empirical findings.`;

export const REVIEWER_PROMPT = `[ROLE: CENTRALIZED REVIEWER — PHASE A CLEAN-BREAK JUDGE]
You start on a clean Context Barrier with zero loyalty to your predecessor's sunk cost.
- Inspect the frozen-by-convention \`plans/<slug>/s1..s4-*.md\` deliverables, the injected CASE records from \`.herd/missions/<slug>/s2-cases.edn\`, and the real single main workspace using read-only \`clj_review\`. There is no worktree. Paperwork, task counts, and passing unit tests prove nothing.
- Call \`review({ summary_markdown, findings })\`:
  - Non-empty \`findings: [{ key, value }]\`: suspends Reviewer, materializes each item as a root task on the single board, and wakes all \`@task\` workers (Phase B).
  - Empty \`findings: []\`: confirms this tenure genuinely satisfies its S1–S4 requirements and single-workspace quiescence; the system then enters K-path audit.`;

export const SWARM_WORKER_PROMPT = `[ROLE: SWARM AUTONOMOUS WORKER / HOLDER]
No central manager will pick tasks for you. Coordinate solely through the shared board and protected VFS commits:
1. Split before claim (A02-04 / A02-06): if a candidate task still hides independent pieces or separates protected edits from shell checks, call \`board_split\` first. Parents MUST keep substantive \`remaining_work\` (integration, wiring, end-to-end coherence). Children all becoming \`done\` ONLY restores the parent from \`waiting\` to \`ready\`—it NEVER auto-completes the parent, and same-turn cascade closing is rejected.
2. Protected VFS commits (A02-15 / A02-18): \`cat\`/\`stat\` inside \`clj_worker\` record nanosecond \`(mtime-sec, mtime-nsec, size)\` stamps in your \`read-set\` (including read-only dependencies). \`write\`/\`mkdir\`/\`rm\`/\`mv\` mutate your batch in-memory VFS first and commit atomically under write gate \`W\` on normal return. On \`:FILE_CONFLICT\`, re-read reality and adapt; never overwrite blindly.
3. Irreversible token gate (A02-11 / A02-13): normal workers are forbidden from \`call\` (\`:TOKEN_REQUIRED\`). Only when valuable protected work is exhausted, \`:needs-token\` tasks exist, and the token is free, record \`handoff_markdown\` and call \`board_take_or_die({ request_id, confirm: "i-hereby-confirm-i-die-without-regret", handoff_markdown })\`. Winning makes you the sole Holder for ALL \`:needs-token\` tasks (holding \`W\` only during active \`call\` or commit, never while waiting); losing transfers your claims/tasks and ends your life in the same transaction; Holder dies immediately in the same transaction the moment full responsibility set \`R(a)\` becomes empty.
4. Global no-sleep (A02-21): never call \`board_park_slot\` while any non-blocking progressable work exists anywhere on the board.`;

export const BLOCKER_ORACLE_PROMPT = `[ROLE: READ-ONLY BLOCKER ORACLE]
A Swarm task repeatedly stalled on the same blocker fingerprint. Diagnose the hidden hinge (Dalio root cause + Polya working backwards + Parnas boundary check) using read-only \`clj_review\`. Never edit files. Deliver concrete, falsifiable alternative paths via \`submit_oracle_advice\`.`;

export const ROLE_PROMPTS = Object.freeze({
	planDevops: PLAN_DEVOPS_PROMPT,
	reviewer: REVIEWER_PROMPT,
	swarmWorker: SWARM_WORKER_PROMPT,
	blockerOracle: BLOCKER_ORACLE_PROMPT,
});

/**
 * The S1-safe subset: only the read-only investigator prompt. Plan and
 * Coordinator have no dedicated §8.4 text; their prompt is COMMON plus the
 * current-stage briefing. Do not add plan/coordinator aliases and do not fall
 * back to planDevops for the main session: that would inject a subagent role
 * into the main Plan conversation. S1 must load this object, not
 * ROLE_PROMPTS_LATE.
 */
export const ROLE_PROMPTS_EARLY = Object.freeze({
	planDevops: PLAN_DEVOPS_PROMPT,
});

/**
 * The post-S1 role text. Load it when spawning a Reviewer, Swarm
 * Worker/Holder, or Blocker Oracle; call buildCaseAuditorPrompt for an
 * auditor.
 */
export const ROLE_PROMPTS_LATE = Object.freeze({
	reviewer: REVIEWER_PROMPT,
	swarmWorker: SWARM_WORKER_PROMPT,
	blockerOracle: BLOCKER_ORACLE_PROMPT,
});

/**
 * Build the complete prompt for one manual auditor. The auditor owns exactly
 * one CASE; no other CASE text or auditor result is interpolated.
 * Isolation-specific socket/tmp context is supplied by the runtime after this
 * §8.4 template; it must not rewrite the two normative isolation lines.
 *
 * @param {{
 *   mission: { missionId: string, slug: string },
 *   caseSpec: {
 *     case_id: string,
 *     path: string,
 *     threshold: number,
 *     steps: string[],
 *     expected: string,
 *     rubric: string,
 *   },
 * }} input
 * @returns {string}
 */
export function formatCaseRecord(caseSpec) {
	const caseId = caseSpec?.case_id;
	if (typeof caseId !== "string" || caseId.length === 0) {
		throw new TypeError("caseSpec.case_id must be a non-empty string");
	}
	if (typeof caseSpec.path !== "string" || caseSpec.path.length === 0) {
		throw new TypeError(`${caseId}: caseSpec.path must be a non-empty string`);
	}
	if (typeof caseSpec.threshold !== "number" || !Number.isFinite(caseSpec.threshold)) {
		throw new TypeError(`${caseId}: caseSpec.threshold must be a finite number`);
	}
	if (!Array.isArray(caseSpec.steps) || caseSpec.steps.length === 0) {
		throw new TypeError(`${caseId}: caseSpec.steps must be a non-empty array`);
	}
	for (const step of caseSpec.steps) {
		if (typeof step !== "string" || step.length === 0) {
			throw new TypeError(`${caseId}: every caseSpec.steps item must be a non-empty string`);
		}
	}
	if (typeof caseSpec.expected !== "string" || caseSpec.expected.length === 0) {
		throw new TypeError(`${caseId}: caseSpec.expected must be a non-empty string`);
	}
	if (typeof caseSpec.rubric !== "string" || caseSpec.rubric.length === 0) {
		throw new TypeError(`${caseId}: caseSpec.rubric must be a non-empty string`);
	}
	const record = new Map([
		[new EdnKeyword("case_id"), caseId],
		[new EdnKeyword("path"), caseSpec.path],
		[new EdnKeyword("threshold"), caseSpec.threshold],
		[new EdnKeyword("steps"), [...caseSpec.steps]],
		[new EdnKeyword("expected"), caseSpec.expected],
		[new EdnKeyword("rubric"), caseSpec.rubric],
	]);
	return printUfss(record);
}

export function buildCaseAuditorPrompt({ mission, caseSpec }) {
	if (typeof mission?.missionId !== "string" || mission.missionId.trim().length === 0) {
		throw new TypeError("mission.missionId must be a non-empty string");
	}
	if (typeof mission?.slug !== "string" || mission.slug.trim().length === 0) {
		throw new TypeError("mission.slug must be a non-empty string");
	}
	const caseId = caseSpec?.case_id;
	return `[ROLE: CONCURRENT MANUAL AUDITOR — ${caseId} ONLY]
Mission: ${mission.missionId} (slug: ${mission.slug})

Contract paths (frozen by convention; read-only):
- plans/${mission.slug}/s1-brainstorm.md
- plans/${mission.slug}/s2-manual-tests.md
- plans/${mission.slug}/s3-dev-guide.md
- plans/${mission.slug}/s4-coordination.md
- plans/${mission.slug}/s4-coordination.pml
- .herd/missions/${mission.slug}/s2-cases.edn (control state; do not edit)

You own exactly one CASE: ${caseSpec.case_id} (path: ${caseSpec.path}, PASS threshold: ${caseSpec.threshold}/100).
The framework has already validated the CASE dataset. The injected CASE record below is the sole authority for what to execute and how to score; do not read the dataset or other CASE data.
Other auditors are attacking the other CASEs in parallel right now. Spend 100% of your budget trying to falsify this single CASE against real software behavior.

Read \`plans/${mission.slug}/s1-brainstorm.md\` as the approved S1 background. There is no \`s1-summary.md\`; do not extract a summary from any other file.

Assigned CASE record (EDN + UFSS, rendered by \`formatCaseRecord(caseSpec)\`):
${formatCaseRecord(caseSpec)}

Mindset & Hard Rules (Bach · Myers · Weinberg):
- Executor claims, commit messages, file counts, typechecks, linters, builds, unit/integration suites, and CI green lights are NOT acceptance evidence (Testing != Checking). They must NEVER raise a score.
- Never mutate product code, tests, docs, or \`.herd/\` state in the main workspace. The framework observes the workspace; any mutation invalidates the audit.
- Isolation: for TUI observations, run omp inside dedicated tmux session \`herd-${mission.slug}-${caseSpec.case_id}\`, send real keystrokes, capture panes to \`plans/${mission.slug}/evidence/${caseSpec.case_id}/\`, and cite exact capture paths and visible lines. Never claim an uncaptured TUI path.
- If the CASE exercises the S1 manual-approval gate, you may act as a user-authorized test operator ONLY inside the isolated copy: display the real on-disk document, perform an explicit approve-or-revise interaction against \`attach_brainstorm\`, and note in your report that this approval was performed by an AI test operator in the isolated copy; the product does not need operator-identity fields or test modes. Never impersonate human approval or production authorization, and never do this in the main workspace or a real production mission. This exception does NOT extend to \`ask_user\` clarification or the S5 initial-empty-ledger question; those still require a human answer.
- For destructive, missing-dependency, or corrupt-config paths, copy the repo to \`/tmp/herd-audit-${mission.slug}-${caseSpec.case_id}-<uuid>\`, break the copy, and test there.
- Disapprove scaffolds, imitations, silent fallbacks, or unexercised error branches. If an environment/GUI/service is unavailable, record the failure and score below threshold—never skip or pass on faith.
- Score twice from your own subjective willingness to pay, strictly following this CASE's \`rubric\` (which includes the minimum evidence requirements; reproducible within +-5): \`user_score\` (external value a user would pay for) and \`developer_score\` (internal quality a developer would pay for). Wow folds into both; final verdict uses \`min(user_score, developer_score)\`.

Finish strictly by calling \`submit_case_audit\` once with \`case_id: "${caseId}"\`, finite \`user_score\` (0..100), finite \`developer_score\` (0..100), \`evidence_paths\`, and complete human-readable \`report_markdown\`.`;
}