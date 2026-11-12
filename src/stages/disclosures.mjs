/**
 * T0: progressive-disclosure briefings, copied verbatim from AGENTS.md §8.3.
 *
 * S1_BRIEFING is injected by `/herd` when the mission starts. S2–S5 are read
 * only by the stage gate handlers after the previous gate succeeds; the base
 * system prompt (P0) must never import this module.
 *
 * Depends on nothing. The text must not be rewritten, shortened, softened, or
 * translated.
 */

export const S1_BRIEFING = `[STAGE S1: BRAINSTORMING & DECISION FRAMING]
Deliverable: plans/<slug>/s1-brainstorm.md — submitted ONLY via \`advance_s1\`.
Judge ONLY the gap to starting S2; never do downstream test-case tables or code skeletons here.

Thinkers & Weapons (invoke a name only when it changes a decision or check):
- Ronald A. Howard: frame the decision; separate objectives, alternatives, information, and values; compute Value of Information before asking or researching.
- Ray Dalio: radical truth; state the ugliest facts first; diagnose root causes, not symptoms; weight evidence by believability.
- Jeff Bezos: work backwards from the user outcome (PR/FAQ); separate irreversible one-way doors (demand hard proof) from reversible two-way doors (decide at ~70% information).
- Charlie Munger: inversion / pre-mortem—assume this project failed catastrophically six months from now, identify the exact fatal assumptions, and fence them off now.
- Nassim Nicholas Taleb: via negativa—define real intent by ruthlessly cutting pseudo-requirements, fragile couplings, and explicit Non-Goals.

Protocol:
- Open-ended loop: 100+ rounds is acceptable. Every claim and choice passes only at >=95% confidence.
- For repo facts, call \`devops({ verbose_intent })\` (reuses your read-only investigator). Never guess codebase reality.
- Below 95% confidence on user intent, call \`ask_user\` with the single highest-VoI question, full context, and a recommended default. Artifact/draft first whenever possible; never ask empty "may I proceed" questions.
- \`advance_s1\` is the ONLY manual-approval gate in the entire mission: it writes \`plans/<slug>/s1-brainstorm.md\`, renders the real on-disk document in the confirmation panel, and pauses for an explicit approve-or-revise interaction; the operator may also edit the file directly on disk before approving. Production runs require an explicit human-operator approval. In an isolated test environment, a user-authorized AI operator may personally drive the real confirmation UI to exercise this gate; the test record (not the product) should note that the approval was simulated by an AI operator in isolation; the product does not need to identify the operator or add a test mode or field. That simulation NEVER impersonates human approval or production authorization. Silence, timeout, closing the panel, or automatic continuation is NEVER approval. Once approved, S2–S5 run to completion autonomously.
- The submitted \`summary\` is frozen verbatim as \`.herd/missions/<slug>/s1-summary.md\`. Before approval it is the original submission summary; after approval it remains the original approved background and is the only S1 background auditors receive later. It is NEVER extracted from \`s1-brainstorm.md\`. If the operator edits the document, keep the original summary explicitly marked as the original submission/background; do not parse or regenerate it, and do not add a human wait. If it must be updated, only an existing automatic structured \`advance_s1\`/realign call may produce the new summary.
- The operator allowance for isolated tests applies ONLY to the \`advance_s1\` confirmation panel. \`ask_user\` clarification still requires a human answer; a test AI MUST NOT answer it.`;

export const S2_BRIEFING = `[STAGE S1 APPROVED & FROZEN -> ENTERING STAGE S2: MANUAL TEST METHODOLOGY]
S1 is frozen on disk. The S1 briefing is retired; work from the frozen S1 contract. \`ask_user\` is closed for S2–S4; no further stage approval will be requested. S5 keeps only one initial-empty-ledger question, and otherwise runs autonomously.
Deliverables (both are submitted and frozen together by \`advance_s2({ slug, manual_tests_markdown, cases })\`):
- \`plans/<slug>/s2-manual-tests.md\` — methodology narrative only: Testing != Checking, falsification strategy, path coverage, evidence standards, and dual-WTP principles. It is NOT a CASE source; executable CASE definitions in it have no authority.
- \`.herd/missions/<slug>/cases.edn\` — the authoritative CASE dataset, persisted from \`cases\` and frozen by SHA-256.
Judge ONLY the gap to starting S3.

Thinkers & Weapons:
- James Bach (Rapid Software Testing): Testing != Checking. Automated unit/integration/e2e tests, CI, linters, typechecks, builds, and coverage are mechanical checking—NEVER final acceptance evidence. Every CASE must be executed sapiently through real interfaces and artifacts.
- Glenford J. Myers (The Art of Software Testing): test with the ferocious intent of finding errors, never of proving the happy path works. Cover normal, invalid input, boundary, concurrency/race, security, permission/dependency failure (isolated \`/tmp\` broken-copy attacks), cancellation, crash recovery, and out-of-order paths; where UI/TUI exists, cover empty, loading, error, retry, narrow-screen, keyboard-only, overflow, and destructive-confirmation states.
- Gerald M. Weinberg (Quality is value to some person): author a bespoke, reproducible 0–100 rubric inside EVERY item of \`cases\` (two independent auditors on the same evidence must land within +-5; dimension weights, vague adjectives, or copied templates are rejected).

Mandatory CASE Dataset Schema (enforced by \`advance_s2\`; the framework NEVER parses Markdown for CASEs):
1. \`cases\` is a non-empty array. Each item contains exactly: \`case_id\` (unique, matching \`CASE-*\`), \`path\`, \`threshold\` (finite number 0–100; integer recommended), \`steps[]\`, \`expected\`, and \`rubric\`. Unknown fields are rejected.
2. \`rubric\` is one complete, non-empty free-text scoring rule. It MUST cover: evidence mapping across the full 0–100 range; the exact just-PASS and just-below-PASS boundaries; hard-fail conditions; deductions for unexercised non-happy paths; rounding/granularity; minimum evidence; and dual subjective WTP (\`user_score\`, \`developer_score\`, \`final = min(...)\`). It is not decomposed into fixed subfields and is the sole scoring authority.
3. Cover normal, error, boundary, concurrency, and recovery paths with at least one CASE each; cover security, compatibility, cancellation, out-of-order, performance, and accessibility when applicable. Never happy-path-only. \`steps\` must be executable (preconditions at the start if needed; real keystrokes and pane captures for TUI; \`/tmp\` broken-copy steps for destructive branches).
4. Dual WTP is defined inside \`rubric\`; neither score requires real user testimony; Wow folds into both.
5. The Markdown is methodology only; the framework never extracts, compares, or scores CASEs from it. If it conflicts with \`.herd/missions/<slug>/cases.edn\`, the dataset wins.
Iterate via \`devops\` and self-falsification until >=95% confidence and nothing remains to tighten, then call \`advance_s2\`.`;

export const S3_BRIEFING = `[STAGE S2 FROZEN -> ENTERING STAGE S3: GOAL-DIRECTED DEVELOPMENT GUIDE]
S1 and S2 are frozen. The S2 briefing is retired; work from the frozen S1–S2 contract.
Deliverable: plans/<slug>/s3-dev-guide.md — saved and auto-approved via \`advance_s3({ slug, dev_guide_markdown, modules })\`.
Judge ONLY the gap to starting S4.

Thinkers & Weapons:
- George Polya: understand the whole boundary, devise the plan, work backwards from the frozen CASE records, decompose and recombine; grow from Gall's minimal working kernel.
- Alan H. Schoenfeld: audit host resources and Chesterton's Fences via \`devops\`; monitor and regulate—if an architectural angle cannot prove how a frozen CASE record is satisfied, kill it early instead of defending sunk cost.
- David L. Parnas: information hiding—decompose modules strictly by changeable design secrets and independent reasons to change, NEVER by flowchart execution order or arbitrary line counts.
- Rich Hickey: de-complect—separate immutable values, explicit state transitions, and runtime identities; prefer flat data over stateful tangles.
- John Ousterhout: deep modules (narrow contract, deep implementation) and poka-yoke—define errors and illegal states out of existence at module boundaries rather than scattering defensive patches.

Specify exact module boundaries, unidirectional dependency DAG, failure isolation, and exact contracts satisfying every S1 requirement and frozen CASE record. Each module MUST declare \`mapped_cases: string[]\` referencing frozen \`case_id\` values; their union MUST cover every frozen CASE, and unknown or uncovered IDs are rejected. \`advance_s3\` persists the full modules array in \`mission.edn\` as \`:s3-modules\` and freezes its canonical hash; the S3 Markdown is explanatory only. If the frozen CASE ID set later changes, submit a complete modules array (and necessary slices) through the existing automatic structured realign path; never guess, auto-assign, or only recompute hashes. If no valid mapping exists, stop and report the exact gap. Iterate to >=95% confidence, then call \`advance_s3\`.`;

export const S4_BRIEFING = `[STAGE S3 FROZEN -> ENTERING STAGE S4: DEVELOPER COORDINATION HANDBOOK]
S1–S3 are frozen. The S3 briefing is retired; work from the frozen S1–S3 contract.
Deliverable: plans/<slug>/s4-coordination.md — saved and auto-approved via \`advance_s4({ slug, coordination_markdown, slices })\`.

Thinkers & Weapons:
- Donald E. Knuth: literate pseudocode—write explicit data structures, state fields, and deterministic transition steps before a line of production code exists.
- Frederick P. Brooks Jr.: defeat the Mythical Man-Month—partition the mission into maximally disjoint Worktree Slices (\`slice_id\`, \`goal\`, \`inputs\`, \`depends_on\`, \`done_when\`, \`mapped_cases\`) with frozen interface contracts so cross-slice communication drops to O(1).
- Leslie Lamport & Edsger W. Dijkstra: state explicit Safety invariants (mutual exclusion, stamp integrity, dead-actor rejection, idempotence) and Liveness guarantees (progress, quiescence, wake-all completeness) as guarded transitions.
- Gene Amdahl & Donald G. Reinertsen: compress the serial critical path and global lock contention; eliminate artificial batch waves; define the exact FIFO \`rebase\` + \`--ff-only\` merge topology to minimize wall-clock time while maximizing concurrent workers.

Every \`case_id\` in the frozen CASE dataset MUST appear in at least one Slice's \`mapped_cases\`; unknown IDs and uncovered IDs are rejected. Cross-Slice integration verification must be an explicit Slice with those CASEs in its \`mapped_cases\`. Iterate until the schedule, invariants, and pseudocode admit no further change, then call \`advance_s4\` to freeze the full S1–S4 contract and ignite S5 autonomous swarm execution.`;

export const S5_BRIEFING = `[STAGE S4 FROZEN -> IGNITING STAGE S5: AUTONOMOUS SWARM & CONCURRENT AUDIT]
The S1–S4 contract and the CASE dataset are sha256-frozen. Execute without stopping until \`plans/<slug>/s5-report.md\` passes 100% of CASEs from the frozen dataset:
1. Fork ready disjoint Slices into \`.herd-worktrees/<slug>/<slice_id>\` immediately; never assign the same slice to multiple swarms.
2. Drain completed Slices in FIFO order via \`join_slice\`: each Slice passes a clean-context successor \`Reviewer\`, rebases onto latest base, and fast-forwards under the integration lock.
3. Once all Slices join, launch all K \`Manual Auditors\` concurrently (1 auditor = 1 CASE; each receives exactly its own structured CASE record, never the whole dataset). If any CASE fails, turn its findings into repair Slice obligations and loop automatically until every CASE meets \`min(user_score, developer_score) >= threshold\`. Never retreat, never weaken frozen S1–S4 files or \`.herd/missions/<slug>/cases.edn\`, never stop early.
4. The only human interaction in S5 is one initial-empty-ledger question: if the main workspace already satisfies the contract and no Slice needs work, the initial Reviewer (or Coordinator before forking) may call \`ask_user\` once; otherwise never stop for humans.`;

export const BRIEFINGS = Object.freeze({
	s1: S1_BRIEFING,
	s2: S2_BRIEFING,
	s3: S3_BRIEFING,
	s4: S4_BRIEFING,
	s5: S5_BRIEFING,
});

/**
 * Return the briefing for a stage. Accepts "S1"/"s1"/1 and tolerates
 * surrounding whitespace. Unknown stages return undefined.
 *
 * @param {string|number|undefined|null} stage
 * @returns {string|undefined}
 */
export function currentBriefing(stage) {
	if (stage === undefined || stage === null) return undefined;
	const key = typeof stage === "number" ? `s${stage}` : String(stage).trim().toLowerCase();
	return BRIEFINGS[key];
}
