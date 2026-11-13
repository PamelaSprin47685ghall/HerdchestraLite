/**
 * T0: progressive-disclosure briefings, copied verbatim from AGENTS.md §8.3.
 *
 * `S1_BRIEFING` is injected by `/herd` when the mission starts. `S2_BRIEFING`–
 * `S5_BRIEFING` are disclosed only to the successor tenure that a successful
 * `attach_*` call creates; the stage gate handlers are the only readers. The base
 * system prompt (P0) must never import this module.
 *
 * Depends on nothing. The text must not be rewritten, shortened, softened, or
 * translated.
 */

export const S1_BRIEFING = `[STAGE S1: BRAINSTORMING & DECISION FRAMING]
Deliverable: plans/<slug>/s1-brainstorm.md — submitted ONLY via attach_brainstorm({ markdown }).
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
- \`attach_brainstorm\` is the ONLY manual-approval gate in the entire mission: it writes \`plans/<slug>/s1-brainstorm.md\`, renders the real on-disk document in the confirmation panel, and pauses for an explicit approve-or-revise interaction; the operator may also edit the file directly on disk before approving. Production runs require an explicit human-operator approval. In an isolated test environment, a user-authorized AI operator may personally drive the real confirmation UI to exercise this gate; the test record (not the product) should note that the approval was simulated by an AI operator in isolation; the product does not need to identify the operator or add a test mode or field. That simulation NEVER impersonates human approval or production authorization. Silence, timeout, closing the panel, or automatic continuation is NEVER approval. Once approved, the barrier opens S2 and S2–S5 run to completion autonomously.
- The submitted \`markdown\` is the only S1 artifact. There is no \`s1-summary.md\` and no separate \`summary\`/\`non_goals\` parameter; Non-Goals are a section inside the markdown. Do not parse or regenerate a summary, and do not add a human wait.
- The operator allowance for isolated tests applies ONLY to the \`attach_brainstorm\` confirmation panel. \`ask_user\` clarification still requires a human answer; a test AI MUST NOT answer it.`;

export const S2_BRIEFING = `[STAGE S1 ATTACHED -> ENTERING STAGE S2: MANUAL TEST METHODOLOGY]
S1 is frozen by convention; the S1 briefing is retired. Work from the frozen S1 contract. \`ask_user\` is closed for S2–S4; no further stage approval will be requested. S5 keeps only one initial-empty-ledger question, and otherwise runs autonomously.
Deliverables (submitted together by attach_manual_tests({ markdown, cases })):
- \`plans/<slug>/s2-manual-tests.md\` — methodology narrative only: Testing != Checking, falsification strategy, path coverage, evidence standards, and dual-WTP principles. It is NOT a CASE source; executable CASE definitions in it have no authority.
- \`.herd/missions/<slug>/s2-cases.edn\` — the authoritative CASE dataset, persisted from \`cases\`.
Judge ONLY the gap to starting S3.

Thinkers & Weapons:
- James Bach (Rapid Software Testing): Testing != Checking. Automated unit/integration/e2e tests, CI, linters, typechecks, builds, and coverage are mechanical checking—NEVER final acceptance evidence. Every CASE must be executed sapiently through real interfaces and artifacts.
- Glenford J. Myers (The Art of Software Testing): test with the ferocious intent of finding errors, never of proving the happy path works. Cover normal, invalid input, boundary, concurrency/race, security, permission/dependency failure (isolated \`/tmp\` broken-copy attacks), cancellation, crash recovery, and out-of-order paths; where UI/TUI exists, cover empty, loading, error, retry, narrow-screen, keyboard-only, overflow, and destructive-confirmation states.
- Gerald M. Weinberg (Quality is value to some person): author a bespoke, reproducible 0–100 rubric inside EVERY item of \`cases\` (two independent auditors on the same evidence must land within +-5; dimension weights, vague adjectives, or copied templates are rejected).

Mandatory CASE Dataset Schema (enforced by attach_manual_tests; the framework NEVER parses Markdown for CASEs):
1. \`cases\` is a non-empty array. Each item contains exactly: \`case_id\` (unique, matching \`CASE-*\`), \`path\`, \`threshold\` (finite number 0–100; integer recommended), \`steps[]\`, \`expected\`, and \`rubric\`. Unknown fields are rejected.
2. \`rubric\` is one complete, non-empty free-text scoring rule. It MUST cover: evidence mapping across the full 0–100 range; the exact just-PASS and just-below-PASS boundaries; hard-fail conditions; deductions for unexercised non-happy paths; rounding/granularity; minimum evidence; and dual subjective WTP (\`user_score\`, \`developer_score\`, \`final = min(...)\`). It is not decomposed into fixed subfields and is the sole scoring authority.
3. Cover normal, error, boundary, concurrency, and recovery paths with at least one CASE each; cover security, compatibility, cancellation, out-of-order, performance, and accessibility when applicable. Never happy-path-only. \`steps\` must be executable (preconditions at the start if needed; real keystrokes and pane captures for TUI; \`/tmp\` broken-copy steps for destructive branches).
4. Dual WTP is defined inside \`rubric\`; neither score requires real user testimony; Wow folds into both.
5. The Markdown is methodology only; the framework never extracts, compares, or scores CASEs from it. If it conflicts with \`.herd/missions/<slug>/s2-cases.edn\`, the dataset wins.

Use \`review\` to track the remaining gaps as board tasks. When the board is empty, the stage is attach-ready; call \`attach_manual_tests({ markdown, cases })\`. Do not call it before the board is empty. Iterate via \`devops\` and self-falsification until >=95% confidence and nothing remains to tighten.`;

export const S3_BRIEFING = `[STAGE S2 ATTACHED -> ENTERING STAGE S3: GOAL-DIRECTED DEVELOPMENT GUIDE]
S1 and S2 are frozen by convention; the S2 briefing is retired. Work from the frozen S1–S2 contract.
Deliverable: plans/<slug>/s3-dev-guide.md — submitted via attach_dev_guide({ markdown }).
Judge ONLY the gap to starting S4.

Thinkers & Weapons:
- George Polya: understand the whole boundary, devise the plan, work backwards from the CASE records, decompose and recombine; grow from Gall's minimal working kernel.
- Alan H. Schoenfeld: audit host resources and Chesterton's Fences via \`devops\`; monitor and regulate—if an architectural angle cannot prove how a CASE is satisfied, kill it early instead of defending sunk cost.
- David L. Parnas: information hiding—decompose by changeable design secrets and independent reasons to change, NEVER by flowchart execution order or arbitrary line counts.
- Rich Hickey: de-complect—separate immutable values, explicit state transitions, and runtime identities; prefer flat data over stateful tangles.
- John Ousterhout: deep modules (narrow contract, deep implementation) and poka-yoke—define errors and illegal states out of existence at module boundaries rather than scattering defensive patches.

Write the development guide as prose. Parnas, Hickey, and Ousterhout are writing lenses, not machine gates: module boundaries, dependency DAG, CASE mapping, failure isolation, and contracts belong in the markdown; the system does not parse or persist a \`modules\` array, and there is no module-coverage gate. Use \`review\` to track open gaps; when the board is empty, call \`attach_dev_guide({ markdown })\`. Iterate to >=95% confidence.`;

export const S4_BRIEFING = `[STAGE S3 ATTACHED -> ENTERING STAGE S4: DEVELOPER COORDINATION HANDBOOK]
S1–S3 are frozen by convention; the S3 briefing is retired. Work from the frozen S1–S3 contract.
Deliverable: plans/<slug>/s4-coordination.md and plans/<slug>/s4-coordination.pml — submitted via attach_coordination({ markdown, promela }).
Judge ONLY the gap to starting S5.

Thinkers & Weapons:
- Donald E. Knuth: literate pseudocode—write explicit data structures, state fields, and deterministic transition steps before a line of production code exists.
- Frederick P. Brooks Jr.: defeat the Mythical Man-Month at the single-board level—make task boundaries explicit and keep cross-task communication O(1); do not add workers on shared mutable state.
- Leslie Lamport & Edsger W. Dijkstra: state explicit Safety invariants (mutual exclusion, stamp integrity, dead-actor rejection, idempotence) and Liveness guarantees (progress, quiescence, wake-all completeness) as guarded transitions.
- Gene Amdahl & Donald G. Reinertsen: compress the single-board critical path and board-lock contention; eliminate artificial audit batch waves. There is no worktree/rebase/ff topology to optimize.

Promela is the sole formal truth for the coordination protocol. It is required and non-empty, but the system does not parse it, run Spin, or model-check it; it is stored and observed only. When Promela's expressive power is insufficient, embed Knuth-style pseudocode in comments; those comments are part of the model. There is no \`slices\` parameter and no Slice DAG. Use \`review\` to track open gaps; when the board is empty, call \`attach_coordination({ markdown, promela })\`.`;

export const S5_BRIEFING = `[STAGE S4 ATTACHED -> IGNITING STAGE S5: SINGLE-WORKSPACE SWARM & CONCURRENT AUDIT]

Review lenses: Lamport/Dijkstra for board safety and liveness; Brooks for single-board communication cost; Weinberg/Myers/Bach for audit falsification. These are judgment lenses, not machine gates.
The S1–S4 deliverables are frozen by convention, and \`.herd/missions/<slug>/s2-cases.edn\` is the CASE authority. Execute without stopping until \`plans/<slug>/s5-report.md\` passes 100% of CASEs:
1. Run in the single main workspace. There are no worktrees, no fork_slices/join_slice, no rebase/ff cycle.
2. Start one clean-context Reviewer. Non-empty \`review\` findings become root tasks on the single board and wake all Swarm workers; the Swarm uses \`clj_worker\` and \`board_*\` under the existing write gate and token protocol.
3. When the board is empty, no action is in flight, and the Holder has no responsibility, atomically retire the tenure, write the context barrier, and start a successor Reviewer. A successor empty review with quiescence enters K-path audit.
4. Launch all K Manual Auditors concurrently (1 auditor = 1 CASE; each receives exactly its own CASE record, never the whole dataset). If any CASE fails, turn its findings into board repair tasks and loop automatically until every CASE meets \`min(user_score, developer_score) >= threshold\`. Never retreat, never weaken the S1–S4 deliverables or \`s2-cases.edn\`, never stop early.
5. The only human interaction in S5 is one initial-empty-ledger question: if the main workspace already satisfies the contract and no task needs work, the initial Reviewer (or Coordinator before starting the Reviewer) may call \`ask_user\` once; otherwise never stop for humans.`;

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
