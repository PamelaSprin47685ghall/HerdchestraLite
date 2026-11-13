/**
 * Slice tenure runner.
 *
 * One Slice alternates between a centred review window (one clean Reviewer)
 * and a decentralised swarm phase (a fixed pool of Workers around the board).
 * The runner owns no workspace files and no host API directly: the board,
 * the worktree lifecycle and the subagent executor arrive as ports. That keeps
 * the state machine testable without a real host and keeps the import graph
 * acyclic (runner -> board, never runner -> tool gate or worktree internals).
 *
 * Ports (all injected through `deps`):
 *
 *   board        openBoard handle, or `openBoard(root, slug, sliceId)`.
 *   agents.start request -> {handle, done} | Promise<outcome>. Optional
 *                `agents.abortTree(target, reason)`.
 *   worktree     { enqueue({root, slug, sliceId, report, holder}) }.
 *   writeLock    { held(): boolean }.
 *   ff           { ready(): boolean | {ok, reason} } -- git merge --ff-only
 *                dry-run for the current worktree.
 *   reviewer     optional `run(context) -> {findings}` shortcut for tests.
 *   askUser      one-shot question for the first empty review.
 *   buildNudge / sendNudge / buildReviewerPrompt / buildWorkerPrompt /
 *   buildOraclePrompt / buildSliceReport -- text ports.
 *   lock.inspect(path) / backup(path) / confirm(info) / repairBoard(...) --
 *   recovery ports.
 *
 * Board values use the EDN field names from AGENTS.md §3.2. Public argument
 * names accept snake_case and camelCase, like the board kernel.
 */

import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { herdError, isHerdError, messageOf } from "../util/errors.mjs";
import { inspectLock } from "../util/file-lock.mjs";
import {
	addTasks,
	applyCommand,
	initialBoard,
	openBoard,
	progressableSet,
	responsibilitySet,
	taskTree,
} from "./board.mjs";

export const DEFAULT_SLOTS = 4;
export const NUDGE_BACKOFF_MS = Object.freeze([0, 30_000, 60_000, 120_000, 240_000, 300_000]);
export const UPSTREAM_BACKOFF_MS = Object.freeze([5_000, 10_000, 20_000, 40_000, 80_000]);

const REVIEW_TOOLS = Object.freeze(["clj_review", "submit_review"]);
const WORKER_TOOLS = Object.freeze([
	"clj_worker",
	"board_split",
	"board_claim",
	"board_finish",
	"board_cancel",
	"board_replace",
	"board_release",
	"board_reopen",
	"board_comment",
	"board_update",
	"board_park_slot",
	"board_take_or_die",
]);
const ORACLE_TOOLS = Object.freeze(["clj_review", "submit_oracle_advice"]);
const ACTIVE_PHASES = new Set(["applying", "running", "uncertain"]);
const CANCELLED_PHASES = new Set(["claimed", "preparing", "waiting-gate"]);
const DETERMINISTIC_AGENT_ERRORS = new Set([":STALLED", ":MODEL_FALLBACK", ":SETTINGS_UNAVAILABLE"]);

const runtimes = new Map();

// ---------------------------------------------------------------------------
// Public API (frozen by the coordination book, plus the two explicit ports)
// ---------------------------------------------------------------------------

/**
 * Open a Slice and start its first clean Reviewer.
 *
 * Returns `{ok, sliceId, term, termId, reviewer, slots}`. A spawn failure keeps
 * the board actor, the tenure and the slot, and reports `:AGENT_SPAWN_FAILED`;
 * it never drops the responsibility silently.
 */
export async function startSlice(args = {}) {
	return attempt(async () => {
		const runtime = ensureRuntime(args.slice ?? args, args.deps ?? {});
		if (runtime.cancelled) return cancelledTree(runtime);
		const opened = await openInitialTenure(runtime);
		if (!opened.ok) return opened;
		if (opened.replayed) {
			const board = await readBoardState(runtime);
			if (!board) return missingBoard(runtime);
			if (board.tenure?.phase === "swarm") {
				runtime.phase = "swarm";
				const workers = await wakeSlots(runtime);
				return {
					ok: workers.ok !== false,
					error: workers.error,
					replayed: true,
					sliceId: runtime.sliceId,
					term: opened.term,
					termId: opened.termId,
					phase: "swarm",
					agentId: null,
					abort: () => ({ aborted: false, agentIds: [] }),
					workers,
					slots: [...runtime.slots.values()].map(publicSlot),
				};
			}
		}
		const reviewer =
			runtime.reviewer?.status === "running" && runtime.reviewer.termId === opened.termId
				? { ok: true, reviewer: runtime.reviewer }
				: await spawnReviewer(runtime, {
						termId: opened.termId,
						successor: false,
						agentId: opened.agentId ?? undefined,
					});
		if (!reviewer.ok) return reviewer;
		return {
			ok: true,
			sliceId: runtime.sliceId,
			term: opened.term,
			termId: opened.termId,
			reviewer: reviewer.reviewer,
			agentId: reviewer.reviewer.agentId,
			abort: (reason) => abortAgent(runtime, reviewer.reviewer, reason),
			slots: [...runtime.slots.values()].map(publicSlot),
		};
	});
}

/**
 * Run one review window.
 *
 * With `findings` the call is the `submit_review` path. With a `deps.reviewer`
 * function the runner invokes it and submits the returned findings. Otherwise
 * the runner only ensures that a clean Reviewer is running and returns
 * `:reviewing`; the real submission then arrives through `reviewSink`.
 */
export async function runTenure(args = {}) {
	return attempt(async () => {
		const runtime = ensureRuntime(args.slice ?? args, args.deps ?? {});
		if (runtime.cancelled) return cancelledTree(runtime);
		const existing = await readBoardState(runtime);
		if (existing && !(existing.tenure?.term >= 1)) {
			const opened = await openInitialTenure(runtime);
			if (!opened.ok) return opened;
		}
		if (args.findings !== undefined) {
			return submitReview(runtime, {
				findings: args.findings,
				termId: args.termId ?? args.term_id,
				agentId: args.agentId ?? args.agent_id,
			});
		}

		const reviewerPort = runtime.deps.reviewer;
		const run = typeof reviewerPort === "function" ? reviewerPort : reviewerPort?.run;
		if (typeof run === "function") {
			const output = await run(reviewContext(runtime));
			if (output && Array.isArray(output.findings)) {
				return submitReview(runtime, { findings: output.findings });
			}
			if (output && output.ok === false && output.error) return output;
			return { ok: true, status: "reviewing", termId: runtime.termId };
		}

		const opened = await ensureReviewer(runtime);
		if (!opened.ok) return opened;
		const outcome = await waitForReview(runtime);
		if (outcome && outcome.findings !== undefined) {
			return submitReview(runtime, { findings: outcome.findings });
		}
		return { ok: true, status: "reviewing", termId: runtime.termId, reviewer: opened.reviewer };
	});
}

/**
 * Atomically retire the current tenure and open a successor Reviewer.
 *
 * The old actions, sleepers and slot visibility are cleared, task results and
 * the event ledger stay. The milestone is copied byte-for-byte. The supplied
 * `deps.abortTree`/`slice.abort` is intentionally not called: retirement is a
 * successor boundary, not an operator cancel (CASE-29).
 */
export async function relay(args = {}) {
	return attempt(async () => {
		const runtime = ensureRuntime(args.slice ?? args, args.deps ?? {});
		if (runtime.cancelled) return cancelledTree(runtime);
		const board = await readBoardState(runtime);
		if (!board) return missingBoard(runtime);
		const quiescence = await checkQuiescence(runtime, board, { ff: true });
		if (!quiescence.ok) {
			scheduleRelayRetryOnFailure(runtime, quiescence);
			return quiescence;
		}
		const ready = relayReadiness(board);
		if (!ready.ok) {
			scheduleRelayRetryOnFailure(runtime, ready);
			return ready;
		}

		const successorAgentId = nextAgentId(runtime, "reviewer");
		const successorTerm = (board.tenure?.term ?? 1) + 1;
		const successorTermId = termIdFor(successorTerm);
		const barrier = {
			term: board.tenure?.term ?? 1,
			"successor-term": successorTerm,
			"written-at": nowIso(runtime),
			"slice-id": runtime.sliceId,
			milestone: clone(board.tenure?.milestone ?? null),
		};

		const committed = await runtime.board.store.transaction(async (current) => {
			if (!current) {
				return {
					board: null,
					events: [],
					response: missingBoard(runtime),
					commit: false,
				};
			}
			const draft = clone(current);
			ensureTenureShape(draft);
			const holderRetired = settleHolderIfEmpty(draft);
			const check = relayReadiness(draft);
			if (!check.ok) {
				return { board: current, events: [], response: check, commit: false };
			}
			const retired = retireTenure(draft, {
				barrier,
				phase: "review",
				successorTerm,
				successorAgentId,
				successorTermId,
			});
			retired.events.push(
				...(holderRetired
					? [
							event(draft, "holder-retired", holderRetired, draft["board-version"], {
								turnId: "runner:relay",
								actorId: holderRetired["agent-id"],
							}),
						]
					: []),
				event(draft, "tenure-retired", { term: barrier.term }, draft["board-version"], {
					turnId: "runner:relay",
					actorId: null,
				}),
				event(draft, "context-barrier-written", { barrier }, draft["board-version"], {
					turnId: "runner:relay",
					actorId: null,
				}),
				event(
					draft,
					"tenure-successor-opened",
					{ term: successorTerm, agentId: successorAgentId },
					draft["board-version"],
					{ turnId: "runner:relay", actorId: successorAgentId },
				),
			);
			return {
				board: draft,
				events: retired.events,
				response: {
					ok: true,
					term: successorTerm,
					termId: successorTermId,
					barrier,
					...(holderRetired ? { holderRetired } : {}),
				},
				commit: true,
			};
		});
		if (!committed?.ok) return committed;

		runtime.term = successorTerm;
		runtime.termId = successorTermId;
		runtime.phase = "review";
		runtime.reviewer = null;
		clearRelayRetry(runtime);
		for (const slot of runtime.slots.values()) clearSlotRetry(runtime, slot);
		runtime.nudge?.noteBoardChange();
		runtime.nudge?.noteProgress();

		const reviewer = await spawnReviewer(runtime, {
			termId: successorTermId,
			successor: true,
			agentId: successorAgentId,
		});
		if (!reviewer.ok) return reviewer;
		return { ...committed, reviewer: reviewer.reviewer };
	});
}

/**
 * Finish one board task and keep the Phase B completion transition atomic.
 *
 * The board kernel's `applyCommand` remains the only owner of finish semantics.
 * When the finishing task is the last open root finding and external
 * Quiescence/ff already holds, the same store transaction also clears the
 * ledger keys, settles the Holder, retires the tenure, writes the context
 * barrier and opens the successor. A deferred barrier leaves the finish
 * committed and schedules a bounded retry; task completion is never rolled
 * back or split into a second ledger transaction.
 */
export async function finishTask(args = {}) {
	return attempt(async () => {
		const runtime = ensureRuntime(
			args.slice ?? { root: args.root, slug: args.slug, sliceId: args.sliceId ?? args.slice_id },
			args.deps ?? {},
		);
		if (runtime.cancelled) return cancelledTree(runtime);
		const command = { ...(args.command ?? {}), type: "finish" };
		const taskId = command.taskId ?? command.task_id;
		if (typeof taskId !== "string" || taskId.length === 0) {
			throw herdError("INVALID_ARGUMENT", "finishTask needs command.taskId", { field: "taskId" });
		}
		const turnId = args.turnId ?? args.turn_id;
		const requestId = args.requestId ?? args.request_id;
		const expectedBoardVersion = args.expectedBoardVersion ?? args.expected_board_version;
		const pre = await readBoardState(runtime);
		if (!pre) return missingBoard(runtime);
		const finishing = pre.tasks?.[taskId];
		const otherOpen = Object.values(pre.tasks ?? {}).filter(
			(task) => task["task-id"] !== taskId && task.state !== "done",
		).length;
		const callerHoldsW = args.writeLockHeld === true || args.write_lock_held === true;
		const potentialRelay = Boolean(finishing?.["ledger-key"]) && otherOpen === 0 && pre.tenure?.phase === "swarm";
		const quiescence =
			potentialRelay && !callerHoldsW
				? await checkQuiescence(runtime, pre, { ff: true })
				: {
						ok: false,
						error: herdError("RESOURCES_NOT_QUIESCENT", "caller holds the write lock", {
							reason: "write-lock-held-by-caller",
						}),
					};
		let successorAgentId = null;
		let successorTerm = null;
		let successorTermId = null;
		let barrier = null;
		if (potentialRelay && quiescence.ok) {
			successorAgentId = nextAgentId(runtime, "reviewer");
			successorTerm = (pre.tenure?.term ?? 1) + 1;
			successorTermId = termIdFor(successorTerm);
			barrier = {
				term: pre.tenure?.term ?? 1,
				"successor-term": successorTerm,
				"written-at": nowIso(runtime),
				"slice-id": runtime.sliceId,
				milestone: clone(pre.tenure?.milestone ?? null),
			};
		}

		let barrierApplied = false;
		let deferred = null;
		const result = await runtime.board.store.transaction(async (current) => {
			if (!current) return { board: null, events: [], response: missingBoard(runtime), commit: false };
			const applied = applyCommand(current, {
				command,
				actor: args.actor,
				turnId,
				requestId,
				expectedBoardVersion,
			});
			if (!applied.ok) {
				return { board: current, events: [], response: applied, commit: false };
			}
			if (!applied.changed) {
				const relayed = applied.receipt?.relayed === true;
				return {
					board: current,
					events: [],
					response: {
						...applied,
						relayed,
						...(relayed
							? { term: applied.receipt.term, termId: applied.receipt.termId, barrier: applied.receipt.barrier }
							: {}),
					},
					commit: false,
				};
			}
			const draft = clone(applied.board);
			ensureTenureShape(draft);
			const events = [...(applied.events ?? [])];
			const cleared = clearDoneLedgerKeys(draft);
			const holderRetired = settleHolderIfEmpty(draft);
			const version = draft["board-version"];
			if (cleared.length > 0) {
				events.push(
					event(draft, "ledger-keys-cleared", { keys: cleared }, version, {
						turnId: "runner:finish",
						actorId: null,
					}),
				);
			}
			if (holderRetired) {
				events.push(
					event(draft, "holder-retired", holderRetired, version, {
						turnId: "runner:finish",
						actorId: holderRetired["agent-id"],
					}),
				);
			}
			const response = {
				...applied.receipt,
				"board-version": version,
				relayReady: false,
			};
			if (potentialRelay) {
				if (callerHoldsW) {
					deferred = {
						code: ":RESOURCES_NOT_QUIESCENT",
						message: "the caller holds $W and will relay after release",
						reason: "write-lock-held-by-caller",
					};
				} else if (!quiescence.ok) {
					deferred = {
						code: quiescence.error?.code ?? ":RESOURCES_NOT_QUIESCENT",
						message: quiescence.error?.message ?? "quiescence is not satisfied",
					};
				} else {
					let writeLockHeld = true;
					try {
						writeLockHeld =
							typeof runtime.deps.writeLock?.held === "function" ? (await runtime.deps.writeLock.held()) === true : true;
					} catch {
						writeLockHeld = true;
					}
					const ready = relayReadiness(draft);
					if (writeLockHeld || runtime.writeLockHeld === true) {
						deferred = {
							code: ":RESOURCES_NOT_QUIESCENT",
							message: "the slice write lock is still held",
						};
					} else if (!ready.ok) {
						deferred = {
							code: ready.error?.code ?? ":RESOURCES_NOT_QUIESCENT",
							message: ready.error?.message ?? "relay is not ready",
						};
					} else {
						barrier = {
							...(barrier ?? {}),
							milestone: clone(draft.tenure?.milestone ?? null),
						};
						retireTenure(draft, {
							barrier,
							phase: "review",
							successorTerm,
							successorAgentId,
							successorTermId,
							bumpVersion: false,
						});
						barrierApplied = true;
						events.push(
							event(draft, "tenure-retired", { term: barrier.term }, version, {
								turnId: "runner:finish",
								actorId: null,
							}),
							event(draft, "context-barrier-written", { barrier }, version, {
								turnId: "runner:finish",
								actorId: null,
							}),
							event(draft, "tenure-successor-opened", { term: successorTerm, agentId: successorAgentId }, version, {
								turnId: "runner:finish",
								actorId: successorAgentId,
							}),
						);
						response.relayed = true;
						response.relayReady = true;
						response.term = successorTerm;
						response.termId = successorTermId;
						response.barrier = barrier;
					}
				}
			}
			if (deferred) response.relayDeferred = deferred;
			response.relayPending = Boolean(callerHoldsW && potentialRelay);
			if (draft.requests?.[requestId]) draft.requests[requestId].receipt = clone(response);
			return {
				board: draft,
				events,
				response: {
					...applied,
					board: draft,
					receipt: response,
					boardVersion: draft["board-version"],
					relayed: barrierApplied,
					relayReady: Boolean(response.relayReady),
					relayPending: response.relayPending === true,
					...(deferred ? { relayDeferred: deferred } : {}),
				},
				commit: true,
			};
		});
		if (!result?.ok) return result;

		if (barrierApplied) {
			runtime.term = successorTerm;
			runtime.termId = successorTermId;
			runtime.phase = "review";
			runtime.reviewer = null;
			clearRelayRetry(runtime);
			for (const slot of runtime.slots.values()) clearSlotRetry(runtime, slot);
			runtime.nudge?.noteBoardChange();
			runtime.nudge?.noteProgress();
			const reviewer = await spawnReviewer(runtime, {
				termId: successorTermId,
				successor: true,
				agentId: successorAgentId,
			});
			if (!reviewer.ok) {
				return {
					...result,
					ok: false,
					committed: true,
					error: reviewer.error,
					barrier,
				};
			}
			return { ...result, reviewer: reviewer.reviewer };
		}
		if (deferred && potentialRelay && !callerHoldsW) scheduleRelayRetry(runtime);
		return result;
	});
}

/**
 * Cancel one Slice subtree or every runner tree of a mission.
 *
 * External actions are classified, not replayed:
 *   claimed/preparing/waiting-gate -> finished with outcome "cancelled";
 *   applying                        -> left in flight (minimal commit continues);
 *   running/uncertain               -> uncertain with outcome "outcome-unknown".
 * Evidence and files are never removed.
 */
export async function cancelTree(args = {}) {
	return attempt(async () => {
		const reason = textOr(args.reason, "cancelled by the operator");
		const selected = selectRuntimes(args);
		if (selected.length === 0) {
			return { ok: true, aborted: [], cancelled: [], outcomeUnknown: [], applying: [], retained: true };
		}
		const summary = { ok: true, aborted: [], cancelled: [], outcomeUnknown: [], applying: [], retained: true };
		for (const runtime of selected) {
			runtime.cancelled = true;
			clearRelayRetry(runtime);
			try {
				runtime.controller.abort(herdError("UPSTREAM_ABORTED", reason, { reason }));
			} catch {
				// An already aborted controller is not a failure.
			}
			for (const entry of liveAgentEntries(runtime)) {
				const ids = abortAgent(runtime, entry, reason);
				summary.aborted.push(...ids);
				entry.status = "aborted";
			}
			for (const slot of runtime.slots.values()) clearSlotRetry(runtime, slot);
			const classified = await classifyActionsForCancel(runtime);
			summary.cancelled.push(...classified.cancelled);
			summary.outcomeUnknown.push(...classified.outcomeUnknown);
			summary.applying.push(...classified.applying);
		}
		return summary;
	});
}

/**
 * Scan the six recovery windows in order.
 *
 * `repair` backs up first, then asks `deps.confirm`. Stale locks are removed
 * only with a positive operator confirmation; `.tmp` files, evidence and
 * live locks are retained. A missing `.herd` mission reports control-state
 * loss and is never silently recreated. The ledger is read from the checkpoint
 * offset only; no event replay.
 */
export async function recover(args = {}) {
	return attempt(async () => {
		const deps = args.deps ?? {};
		const root = args.slice?.root ?? args.root ?? deps.root;
		const slug = args.slice?.slug ?? args.slug ?? deps.slug;
		if (!root || !slug) {
			throw herdError("INVALID_ARGUMENT", "recover needs root and slug", {
				root: root ?? null,
				slug: slug ?? null,
			});
		}
		const hasSlice =
			args.slice !== undefined ||
			args.sliceId !== undefined ||
			args.slice_id !== undefined ||
			deps.sliceId !== undefined ||
			deps.slice_id !== undefined;
		const runtime = hasSlice
			? ensureRuntime(args.slice ?? { ...deps, root, slug }, deps)
			: missionRecoveryRuntime(root, slug, deps);
		const missionLevel = !hasSlice;
		const missionDir = join(runtime.root, ".herd", "missions", runtime.slug);
		if (!existsSync(missionDir)) {
			return {
				ok: false,
				error: herdError("STALE_CONTROL", "mission control state is missing", {
					root: runtime.root,
					slug: runtime.slug,
					lost: true,
					next: "do not rebuild an empty mission; inspect .herd or restore a backup",
				}),
			};
		}

		const scanned = {};
		const order = ["mission", "board", "locks", "tmp", "ledger", "worktree"];
		scanned.mission = scanMission(runtime, missionDir);
		scanned.board = missionLevel ? await scanMissionBoards(runtime) : await scanBoard(runtime);
		const boardState = missionLevel
			? await readMissionActors(runtime)
			: await readBoardState(runtime).catch(() => null);
		scanned.locks = await scanLocks(runtime, boardState);
		scanned.tmp = scanTmp(runtime, missionDir);
		scanned.ledger = scanLedger(runtime);
		scanned.worktree = missionLevel ? scanMissionWorktrees(runtime) : scanWorktree(runtime);

		const repairRequested = args.repair === true;
		const result = {
			ok: true,
			order,
			scanned,
			replayed: false,
			retained: {
				tmp: scanned.tmp.files,
				worktree: Boolean(scanned.worktree.exists ?? scanned.worktree.status !== "none"),
				evidence: true,
			},
			backups: [],
			repaired: { locks: [], board: false, mission: false },
			requiresOperator: collectOperatorActions(scanned),
		};
		if (!repairRequested) return result;

		const corruptBoardPaths = [
			scanned.board.corruptFile,
			...(scanned.board.slices ?? []).filter((entry) => entry.status === "corrupt").map((entry) => entry.path),
		].filter((path) => typeof path === "string");
		const backups = [
			...(await backupPaths(runtime, scanned.locks.staleFiles)),
			...(await backupPaths(runtime, [...new Set(corruptBoardPaths)])),
			...(await backupPaths(runtime, scanned.mission.corruptFile ? [scanned.mission.corruptFile] : [])),
		];
		result.backups = backups;

		const confirm = runtime.deps.confirm;
		if (typeof confirm !== "function") {
			return {
				...result,
				ok: false,
				error: herdError("CONFIRMATION_REQUIRED", "recovery repair needs explicit confirmation", {
					backups,
					next: "pass deps.confirm or run /herd-recovery repair interactively",
				}),
			};
		}
		let confirmed = false;
		try {
			confirmed = (await confirm({ action: "recovery-repair", scanned, backups })) === true;
		} catch {
			confirmed = false;
		}
		if (!confirmed) {
			return {
				...result,
				ok: false,
				error: herdError("CONFIRMATION_REQUIRED", "recovery repair was not confirmed", {
					backups,
					changed: false,
				}),
			};
		}

		for (const path of scanned.locks.staleFiles) {
			try {
				rmSync(path, { force: true });
				result.repaired.locks.push(path);
			} catch (error) {
				result.requiresOperator.push({
					window: "locks",
					path,
					reason: messageOf(error),
				});
			}
		}
		// A corrupt board may be restored only through an explicit repair port.
		// Without one the backup stays as evidence and the runner stops.
		if (scanned.board.status === "corrupt" && typeof runtime.deps.repairBoard === "function") {
			try {
				const restored = await runtime.deps.repairBoard({
					root: runtime.root,
					slug: runtime.slug,
					sliceId: runtime.sliceId,
					corruptPath: scanned.board.corruptFile,
					backups: result.backups,
				});
				if (restored) {
					if (typeof runtime.deps.writeBoard === "function") {
						await runtime.deps.writeBoard(restored);
						result.repaired.board = true;
					} else {
						result.repaired.board = true;
						result.requiresOperator.push({
							window: "board",
							action: "persist the repaired board through deps.writeBoard",
						});
					}
				}
			} catch (error) {
				result.requiresOperator.push({
					window: "board",
					action: `repairBoard failed: ${messageOf(error)}`,
				});
			}
		}
		if ((scanned.board.corruptFile && !result.repaired.board) || scanned.mission.corruptFile) {
			result.requiresOperator.push({
				window: scanned.board.corruptFile ? "board" : "mission",
				reason: "corrupt control file backed up; restore needs an operator decision",
				next: "inspect checkpoint.edn and a known-good backup; do not rebuild empty state",
			});
		}
		return result;
	});
}

/**
 * A stable blocker fingerprint:
 * sha256(normalize(goal) + "\n" + normalize(done_when) + "\n" + normalize(reason)).
 *
 * Timestamps, agent ids, temporary paths and pure emotion are dropped so the
 * same dead end triggers one consultation, not one per retry.
 */
export function oracleFingerprint(args = {}) {
	const goal = normalizeFingerprintText(args.goal);
	const doneWhen = normalizeFingerprintText(args.doneWhen ?? args.done_when);
	const reason = normalizeFingerprintText(args.reason);
	return createHash("sha256").update(`${goal}\n${doneWhen}\n${reason}`, "utf8").digest("hex");
}

/** Fixed-slot pool: a dead identity never returns; the slot keeps its number. */
export async function replaceSlot(args = {}) {
	return attempt(async () => {
		const runtime = ensureRuntime(args.slice ?? args, args.deps ?? {});
		const slotId = textOr(args.slotId ?? args.slot_id, null);
		if (!slotId) throw herdError("INVALID_ARGUMENT", "replaceSlot needs a slot_id", { slotId });
		const slot = runtime.slots.get(slotId);
		if (!slot) throw herdError("INVALID_ARGUMENT", "unknown slot", { slotId });
		const oldAgentId = slot.agentId;
		const newAgentId = nextAgentId(runtime, "worker");
		const board = await readBoardState(runtime);
		if (!board) return missingBoard(runtime);
		const termId = runtime.termId ?? currentTermId(board);
		if (slot.status === "running" || slot.status === "starting") {
			abortAgent(runtime, slot, args.reason ?? "slot replacement");
		}
		const receipt = await runtime.board.store.transaction(async (current) => {
			if (!current) return { board: null, events: [], response: missingBoard(runtime), commit: false };
			const draft = clone(current);
			ensureTenureShape(draft);
			if (currentTermId(draft) !== termId || terminated(draft, termId)) {
				return {
					board: current,
					events: [],
					response: {
						ok: false,
						error: herdError("TENURE_RETIRED", "cannot replace a slot in a retired tenure", {
							expected: termId,
							actual: currentTermId(draft),
						}),
					},
					commit: false,
				};
			}
			if (oldAgentId && draft.actors?.[oldAgentId]) {
				draft.actors[oldAgentId]["life-state"] = "dead";
				draft.actors[oldAgentId]["active-action-id"] = null;
			}
			registerActor(draft, newAgentId, slotId, termId);
			draft["board-version"] = (draft["board-version"] ?? 0) + 1;
			const ev = event(draft, "slot-replaced", { slotId, oldAgentId, agentId: newAgentId }, draft["board-version"], {
				turnId: "runner:slot",
				actorId: newAgentId,
			});
			return {
				board: draft,
				events: [ev],
				response: { ok: true, slotId, oldAgentId, agentId: newAgentId },
				commit: true,
			};
		});
		if (!receipt?.ok) return receipt;
		slot.agentId = newAgentId;
		slot.status = "starting";
		slot.handle = null;
		slot.generation = (slot.generation ?? 1) + 1;
		const spawned = await spawnWorker(runtime, slot);
		if (!spawned.ok) {
			slot.status = "pending";
			await markActorDead(runtime, newAgentId, "slot-spawn-failed");
			return spawned;
		}
		return { ok: true, slotId, oldAgentId, agentId: newAgentId, generation: slot.generation };
	});
}

/** Worktree port alias: abandon/retire one Slice without aborting the mission. */
export async function retireSlice(args = {}) {
	return attempt(async () => {
		const runtime = ensureRuntime(args.slice ?? args, args.deps ?? {});
		const reason = textOr(args.reason, "slice retired");
		runtime.cancelled = true;
		clearRelayRetry(runtime);
		for (const entry of liveAgentEntries(runtime)) {
			abortAgent(runtime, entry, reason);
			entry.status = "retired";
		}
		for (const slot of runtime.slots.values()) clearSlotRetry(runtime, slot);
		const receipt = await runtime.board.store.transaction(async (current) => {
			if (!current) return { board: null, events: [], response: missingBoard(runtime), commit: false };
			const draft = clone(current);
			ensureTenureShape(draft);
			const term = draft.tenure?.term ?? 0;
			const termId = currentTermId({ tenure: draft.tenure });
			retireActors(draft, null);
			if (termId && !draft["token-slot"]["retired-terms"].includes(termId)) {
				draft["token-slot"]["retired-terms"].push(termId);
			}
			draft.tenure.phase = "retired";
			draft.actions = {};
			draft.sleepers = {};
			draft["token-slot"]["holder-id"] = null;
			draft["token-slot"]["term-id"] = null;
			draft["token-slot"].state = "free";
			draft["board-version"] = (draft["board-version"] ?? 0) + 1;
			const ev = event(draft, "slice-retired", { term, reason }, draft["board-version"], {
				turnId: "runner:retire",
				actorId: null,
			});
			return { board: draft, events: [ev], response: { ok: true, term, reason }, commit: true };
		});
		if (!receipt?.ok) return receipt;
		return { ok: true, sliceId: runtime.sliceId, reason };
	});
}

/**
 * Clear ledger keys whose root tasks are already done and report whether the
 * Phase B -> Phase A relay barrier is ready. Called by the board tool layer
 * after `board_finish`; relay itself re-checks everything.
 */
export async function syncLedger(args = {}) {
	return attempt(async () => {
		const runtime = ensureRuntime(args.slice ?? args, args.deps ?? {});
		const cleared = [];
		const receipt = await runtime.board.store.transaction(async (current) => {
			if (!current) return { board: null, events: [], response: missingBoard(runtime), commit: false };
			const draft = clone(current);
			ensureTenureShape(draft);
			const ledger = draft.tenure?.ledger ?? {};
			const events = [];
			for (const [key, taskId] of Object.entries(ledger)) {
				if (draft.tasks?.[taskId]?.state !== "done") continue;
				delete ledger[key];
				cleared.push(key);
			}
			const holderRetired = settleHolderIfEmpty(draft);
			if (cleared.length === 0 && !holderRetired) {
				return {
					board: current,
					events: [],
					response: { ok: true, cleared, relayReady: relayReadiness(current).ok },
					commit: false,
				};
			}
			draft["board-version"] = (draft["board-version"] ?? 0) + 1;
			if (cleared.length > 0) {
				events.push(
					event(draft, "ledger-keys-cleared", { keys: cleared }, draft["board-version"], {
						turnId: args.turnId ?? args.turn_id ?? "runner:ledger",
						actorId: null,
					}),
				);
			}
			if (holderRetired) {
				events.push(
					event(draft, "holder-retired", holderRetired, draft["board-version"], {
						turnId: args.turnId ?? args.turn_id ?? "runner:ledger",
						actorId: holderRetired["agent-id"],
					}),
				);
			}
			return {
				board: draft,
				events,
				response: {
					ok: true,
					cleared,
					...(holderRetired ? { holderRetired } : {}),
					relayReady: relayReadiness(draft).ok,
				},
				commit: true,
			};
		});
		return receipt;
	});
}

/** ReviewSink port handed to the gate-tool layer. Never imports the tool gate. */
export function createReviewSink(sliceOrArgs = {}) {
	const runtime = ensureRuntime(sliceOrArgs.slice ?? sliceOrArgs, sliceOrArgs.deps ?? {});
	return Object.freeze({
		submit: (tenure, findings) =>
			attempt(() => {
				const termId = tenure && typeof tenure === "object" ? (tenure.termId ?? tenure.term_id ?? tenure) : tenure;
				const agentId = tenure && typeof tenure === "object" ? (tenure.agentId ?? tenure.agent_id) : undefined;
				if (typeof termId !== "string" || termId.trim().length === 0) {
					return {
						ok: false,
						error: herdError("INVALID_ARGUMENT", "submit_review needs the tenure id", {
							next: "pass the tenure from the Reviewer prompt; a late sink must not act on the current tenure",
						}),
					};
				}
				return submitReview(runtime, { findings, termId, agentId });
			}),
	});
}

/** RunnerPort service consumed by the stage gate tools. */
export function createRunnerPort(sliceOrArgs = {}) {
	const runtime = ensureRuntime(sliceOrArgs.slice ?? sliceOrArgs, sliceOrArgs.deps ?? {});
	return Object.freeze({
		startSlice: (handle) => startSlice({ slice: handle ?? runtime.slice, deps: runtime.deps }),
		runTenure: (args = {}) => runTenure({ slice: runtime.slice, deps: runtime.deps, ...args }),
		finishTask: (args = {}) => finishTask({ slice: runtime.slice, deps: runtime.deps, ...args }),
		relay: () => relay({ slice: runtime.slice, deps: runtime.deps }),
		cancelTree: (reason) => cancelTree({ slice: runtime.slice, deps: runtime.deps, reason }),
		retireSlice: async (info = {}) => {
			const result = await retireSlice({
				slice: runtime.slice,
				deps: runtime.deps,
				reason: typeof info === "string" ? info : (info.reason ?? info),
			});
			// worktree.mjs treats any non-false return as "retired"; keep the
			// boolean contract at this port and leave the detailed receipt on the
			// named export.
			return result?.ok === true;
		},
		syncLedger: () => syncLedger({ slice: runtime.slice, deps: runtime.deps }),
		wake: () => attempt(() => wakeSlots(runtime, { allowStalled: true })),
		replaceSlot: (slotId) => replaceSlot({ slice: runtime.slice, deps: runtime.deps, slotId }),
		reviewSink: createReviewSink({ slice: runtime.slice, deps: runtime.deps }),
		nudge: runtime.nudge,
		get slots() {
			return [...runtime.slots.values()].map(publicSlot);
		},
		get termId() {
			return runtime.termId;
		},
	});
}

// ---------------------------------------------------------------------------
// Tenure transitions
// ---------------------------------------------------------------------------

async function openInitialTenure(runtime) {
	const reviewerAgentId = nextAgentId(runtime, "reviewer");
	const term = 1;
	const termId = termIdFor(term);
	const receipt = await runtime.board.store.transaction(async (current) => {
		if (!current && runtime.board.durable === true) {
			return {
				board: null,
				events: [],
				response: {
					ok: false,
					error: herdError("STALE_CONTROL", "durable Slice board is missing", {
						root: runtime.root,
						slug: runtime.slug,
						sliceId: runtime.sliceId,
						boardPath: runtime.board.boardPath ?? null,
						next: "worktree fork must call store.initialize(initialBoard()); the runner never seeds a durable board",
					}),
				},
				commit: false,
			};
		}
		const draft = current ? clone(current) : clone(initialBoard());
		ensureTenureShape(draft);
		if (draft.tenure.term >= 1) {
			const existing = currentTermId(draft);
			if (draft.tenure.phase === "review" || draft.tenure.phase === "swarm") {
				const reviewerActor = Object.values(draft.actors ?? {}).find(
					(actor) => actor["slot-id"] === "reviewer" && actor["term-id"] === existing,
				);
				return {
					board: current,
					events: [],
					response: {
						ok: true,
						replayed: true,
						term: draft.tenure.term,
						termId: existing,
						agentId: reviewerActor?.["life-state"] === "alive" ? (reviewerActor?.["agent-id"] ?? null) : null,
					},
					commit: false,
				};
			}
			return {
				board: current,
				events: [],
				response: {
					ok: false,
					error: herdError("STALE_CONTROL", "Slice tenure is already terminal", {
						sliceId: runtime.sliceId,
						phase: draft.tenure.phase,
					}),
				},
				commit: false,
			};
		}
		draft.tenure.term = term;
		draft.tenure.phase = "review";
		draft.tenure["term-id"] = termId;
		draft.tenure.milestone = clone(runtime.slice.milestone ?? runtime.deps.milestone ?? null);
		draft["next-ids"].term = term + 1;
		registerActor(draft, reviewerAgentId, "reviewer", termId);
		draft["board-version"] = (draft["board-version"] ?? 0) + 1;
		const ev = event(
			draft,
			"tenure-opened",
			{ term, agentId: reviewerAgentId, milestone: draft.tenure.milestone },
			draft["board-version"],
			{ turnId: "runner:start", actorId: reviewerAgentId },
		);
		return {
			board: draft,
			events: [ev],
			response: { ok: true, term, termId, agentId: reviewerAgentId, replayed: false },
			commit: true,
		};
	});
	if (!receipt?.ok) return receipt;
	runtime.term = receipt.term;
	runtime.termId = receipt.termId;
	runtime.phase = "review";
	runtime.reviewerAgentId = receipt.agentId ?? reviewerAgentId;
	return receipt;
}

async function ensureReviewer(runtime) {
	const board = await readBoardState(runtime);
	if (!board) return missingBoard(runtime);
	const termId = currentTermId(board);
	if (!termId) {
		return { ok: false, error: herdError("STALE_CONTROL", "Slice has no open tenure", { sliceId: runtime.sliceId }) };
	}
	if (terminated(board, termId)) {
		return { ok: false, error: herdError("TENURE_RETIRED", "tenure is retired", { termId }) };
	}
	runtime.term = board.tenure.term;
	runtime.termId = termId;
	if (runtime.reviewer?.status === "running" && runtime.reviewer.termId === termId) {
		return { ok: true, reviewer: runtime.reviewer };
	}
	return spawnReviewer(runtime, { termId, successor: Boolean(board.tenure.barrier) });
}

async function spawnReviewer(runtime, { termId, successor, agentId }) {
	const id = agentId ?? nextAgentId(runtime, "reviewer");
	const name = `Reviewer-${runtime.sliceId}-${termId}`;
	const board = await readBoardState(runtime);
	if (!board) return missingBoard(runtime);
	if (terminated(board, termId)) {
		return { ok: false, error: herdError("TENURE_RETIRED", "tenure is retired", { termId }) };
	}
	if (!board.actors?.[id]) {
		const registered = await runtime.board.store.transaction(async (current) => {
			if (!current) return { board: null, events: [], response: missingBoard(runtime), commit: false };
			const draft = clone(current);
			ensureTenureShape(draft);
			if (terminated(draft, termId)) {
				return {
					board: current,
					events: [],
					response: {
						ok: false,
						error: herdError("TENURE_RETIRED", "tenure retired before the reviewer started", { termId }),
					},
					commit: false,
				};
			}
			if (!draft.actors?.[id]) {
				registerActor(draft, id, "reviewer", termId);
				draft["board-version"] = (draft["board-version"] ?? 0) + 1;
				const ev = event(draft, "tenure-reviewer-opened", { termId, agentId: id }, draft["board-version"], {
					turnId: "runner:review",
					actorId: id,
				});
				return { board: draft, events: [ev], response: { ok: true }, commit: true };
			}
			return { board: current, events: [], response: { ok: true }, commit: false };
		});
		if (!registered?.ok) return registered;
	}
	const prompt =
		typeof runtime.deps.buildReviewerPrompt === "function"
			? runtime.deps.buildReviewerPrompt({
					role: "Reviewer",
					sliceId: runtime.sliceId,
					goal: runtime.slice.goal ?? null,
					doneWhen: runtime.slice.done_when ?? runtime.slice.doneWhen ?? null,
					termId,
					workspace: runtime.slice.workspace ?? null,
					seed: runtime.deps.seed ?? runtime.slice.seed ?? "",
					contracts: runtime.deps.contracts ?? runtime.slice.contracts ?? [],
					mappedCases: runtime.slice.mapped_cases ?? runtime.slice.mappedCases ?? runtime.deps.mappedCases ?? [],
					board: clone(board),
					successor,
					barrier: board.tenure?.barrier ?? null,
				})
			: buildReviewerPrompt(runtime, { successor, termId, board });
	const allowInitialAsk =
		!successor &&
		termId === termIdFor(1) &&
		!board.tenure?.barrier &&
		(runtime.deps.initialEmptyReview === true || runtime.slice.initialEmptyReview === true);
	const spawned = await spawnAgent(runtime, {
		agentId: id,
		role: "Reviewer",
		name,
		prompt,
		tools: allowInitialAsk ? [...REVIEW_TOOLS, "ask_user"] : REVIEW_TOOLS,
		index: 0,
	});
	if (!spawned.ok) {
		await markActorDead(runtime, id, "reviewer-spawn-failed");
		return spawned;
	}
	runtime.reviewer = {
		agentId: id,
		termId,
		name,
		status: "running",
		handle: spawned.handle ?? null,
		done: spawned.done ?? null,
		started: spawned.started ?? null,
		abort: spawned.abort,
	};
	if (spawned.done) {
		spawned.done.then(
			(outcome) => {
				if (runtime.reviewer?.agentId !== id) return;
				runtime.reviewer.status = "ended";
				if (outcome?.ok === false || runtime.phase === "review") {
					void markActorDead(runtime, id, "reviewer-ended-without-submit");
				}
			},
			() => {
				if (runtime.reviewer?.agentId === id) runtime.reviewer.status = "ended";
				void markActorDead(runtime, id, "reviewer-ended-without-submit");
			},
		);
	}
	runtime.reviewerAgentId = id;
	return { ok: true, reviewer: runtime.reviewer };
}

async function submitReview(runtime, { findings, termId, agentId }) {
	const board = await readBoardState(runtime);
	if (!board) return missingBoard(runtime);
	const liveTermId = currentTermId(board);
	if (!liveTermId) {
		return { ok: false, error: herdError("STALE_CONTROL", "Slice has no open tenure", { sliceId: runtime.sliceId }) };
	}
	if (termId && termId !== liveTermId) {
		return {
			ok: false,
			error: herdError("TENURE_RETIRED", "review belongs to a retired tenure", {
				expected: liveTermId,
				actual: termId,
			}),
		};
	}
	if (terminated(board, liveTermId)) {
		return { ok: false, error: herdError("TENURE_RETIRED", "tenure is retired", { termId: liveTermId }) };
	}
	if (agentId) {
		const actor = board.actors?.[agentId];
		if (!actor) return { ok: false, error: herdError("ACTOR_DEAD", "reviewer is not registered", { agentId }) };
		if (actor["life-state"] !== "alive") {
			return { ok: false, error: herdError("TENURE_RETIRED", "reviewer is no longer alive", { agentId }) };
		}
	}
	const normalized = normalizeFindings(findings);
	if (!normalized.ok) return normalized;

	if (normalized.findings.length === 0) {
		return completeTenure(runtime, liveTermId);
	}
	return openFindings(runtime, liveTermId, normalized.findings);
}

async function openFindings(runtime, termId, findings) {
	const specs = findings.map((finding) => ({
		goal: finding.value,
		remainingWork: `resolve review finding ${finding.key} and record the verification`,
		doneWhen: finding.value,
		needsToken: false,
		ledgerKey: finding.key,
	}));
	const receipt = await runtime.board.store.transaction(async (current) => {
		if (!current) return { board: null, events: [], response: missingBoard(runtime), commit: false };
		const draft = clone(current);
		ensureTenureShape(draft);
		const liveTermId = currentTermId(draft);
		if (liveTermId !== termId || terminated(draft, termId)) {
			return {
				board: current,
				events: [],
				response: {
					ok: false,
					error: herdError("TENURE_RETIRED", "review belongs to a retired tenure", {
						expected: liveTermId,
						actual: termId,
					}),
				},
				commit: false,
			};
		}
		const ledger = draft.tenure.ledger ?? {};
		const alreadyOpen = findings.every((finding) => ledger[finding.key] && draft.tasks?.[ledger[finding.key]]);
		if (draft.tenure.phase === "swarm" && alreadyOpen) {
			return {
				board: current,
				events: [],
				response: {
					ok: true,
					replayed: true,
					phase: "swarm",
					roots: findings.map((finding) => ledger[finding.key]),
				},
				commit: false,
			};
		}
		if (draft.tenure.phase !== "review") {
			return {
				board: current,
				events: [],
				response: {
					ok: false,
					error: herdError("STALE_CONTROL", "review window is already closed", {
						phase: draft.tenure.phase,
					}),
				},
				commit: false,
			};
		}
		const added = addTasks(draft, specs);
		const next = added.board;
		ensureTenureShape(next);
		next.tenure.phase = "swarm";
		next.tenure.ledger ??= {};
		for (let index = 0; index < findings.length; index += 1) {
			next.tenure.ledger[findings[index].key] = added.taskIds[index];
		}
		next.tenure["root-tasks"] = [...(next.tenure["root-tasks"] ?? []), ...added.taskIds];
		next["board-version"] = (next["board-version"] ?? 0) + 1;
		next.wake = next.wake ?? { epoch: 0 };
		next.wake.epoch = (next.wake.epoch ?? 0) + 1;
		next.sleepers = {};
		const holderRetired = settleHolderIfEmpty(next);
		const events = [
			...(holderRetired
				? [
						event(next, "holder-retired", holderRetired, next["board-version"], {
							turnId: "runner:review",
							actorId: holderRetired["agent-id"],
						}),
					]
				: []),
			event(
				next,
				"review-findings-opened",
				{
					termId,
					keys: findings.map((finding) => finding.key),
					roots: added.taskIds,
				},
				next["board-version"],
				{ turnId: "runner:review", actorId: null },
			),
			event(next, "wake-all", { cause: "review-findings-opened", epoch: next.wake.epoch }, next["board-version"], {
				turnId: "runner:review",
				actorId: null,
			}),
		];
		return {
			board: next,
			events,
			response: {
				ok: true,
				replayed: false,
				phase: "swarm",
				roots: added.taskIds,
				ledger: clone(next.tenure.ledger),
				...(holderRetired ? { holderRetired } : {}),
			},
			commit: true,
		};
	});
	if (!receipt?.ok) return receipt;

	runtime.phase = "swarm";
	runtime.nudge?.noteProgress();
	await unmountReviewTool(runtime);
	await stopReviewer(runtime, "review-findings-opened");
	runtime.reviewer = null;
	const workers = await wakeSlots(runtime);
	if (workers && workers.ok === false) {
		return {
			ok: false,
			error: workers.error,
			committed: true,
			phase: "swarm",
			roots: receipt.roots,
			workers,
		};
	}
	return {
		...receipt,
		reviewToolUnmounted: runtime.reviewToolUnmounted === true,
		workers,
	};
}

async function completeTenure(runtime, termId) {
	let board = await readBoardState(runtime);
	if (!board) return missingBoard(runtime);
	const quiescence = await checkQuiescence(runtime, board, { ff: true });
	if (!quiescence.ok) return quiescence;

	const isInitialEmpty =
		(runtime.deps.initialEmptyReview === true || runtime.slice.initialEmptyReview === true) &&
		runtime.initialAskUsed !== true;
	if (isInitialEmpty) {
		const marked = await runtime.board.store.transaction(async (current) => {
			if (!current) return { board: null, events: [], response: missingBoard(runtime), commit: false };
			const draft = clone(current);
			if (draft.tenure?.["initial-ask-used"] === true)
				return { board: current, events: [], response: null, commit: false };
			draft.tenure["initial-ask-used"] = true;
			draft["board-version"] = (draft["board-version"] ?? 0) + 1;
			const ev = event(draft, "initial-empty-review", { termId }, draft["board-version"], {
				turnId: "runner:review",
				actorId: null,
			});
			return { board: draft, events: [ev], response: { ok: true }, commit: true };
		});
		if (marked === null) {
			// Another process already used the one-shot question. Fall through to
			// ordinary completion instead of asking a second time.
			runtime.initialAskUsed = true;
		} else if (!marked?.ok) {
			return marked;
		} else {
			runtime.initialAskUsed = true;
		}
		if (runtime.initialAskUsed && marked === null) {
			// Continue below with the normal queued completion.
		} else {
			const question = runtime.deps.initialQuestion ?? "契约已满足，接下来做什么？";
			const ask = runtime.deps.askUser;
			if (typeof ask !== "function") {
				return {
					ok: false,
					error: herdError("ASK_FORBIDDEN_OUTSIDE_S1", "first empty review needs ask_user once", {
						sliceId: runtime.sliceId,
						question,
					}),
				};
			}
			const answer = await ask({ question });
			return { ok: true, outcome: "ask-user", question, answer };
		}
	}

	const settled = await settleHolderStandalone(runtime);
	if (!settled.ok) return settled;
	const preSettledHolder = settled.holderRetired ?? null;
	board = await readBoardState(runtime);
	if (!board) return missingBoard(runtime);

	const report =
		typeof runtime.deps.buildSliceReport === "function"
			? runtime.deps.buildSliceReport({ runtime, board })
			: buildSliceReport(runtime, board);
	const enqueue = runtime.deps.worktree?.enqueue;
	if (typeof enqueue !== "function") {
		return {
			ok: false,
			error: herdError("INVALID_ARGUMENT", "worktree enqueue port is unavailable", {
				sliceId: runtime.sliceId,
				next: "inject deps.worktree.enqueue; an empty review must enter the FIFO queue",
			}),
		};
	}
	const queue = await enqueue({
		root: runtime.root,
		slug: runtime.slug,
		sliceId: runtime.sliceId,
		report,
		holder: holderDescriptor(board),
	});

	const barrier = {
		term: board.tenure?.term ?? 1,
		"successor-term": null,
		"written-at": nowIso(runtime),
		"slice-id": runtime.sliceId,
		milestone: clone(board.tenure?.milestone ?? null),
	};
	const committed = await runtime.board.store.transaction(async (current) => {
		if (!current) return { board: null, events: [], response: missingBoard(runtime), commit: false };
		const draft = clone(current);
		ensureTenureShape(draft);
		const liveTermId = currentTermId(draft);
		if (liveTermId !== termId || terminated(draft, termId)) {
			return {
				board: current,
				events: [],
				response: {
					ok: false,
					error: herdError("TENURE_RETIRED", "review belongs to a retired tenure", {
						expected: liveTermId,
						actual: termId,
					}),
				},
				commit: false,
			};
		}
		const holderRetired = settleHolderIfEmpty(draft);
		const friendly = completionReadiness(draft);
		if (!friendly.ok) {
			return { board: current, events: [], response: friendly, commit: false };
		}
		const retired = retireTenure(draft, {
			barrier,
			phase: "queued",
			successorTerm: null,
			successorAgentId: null,
			successorTermId: null,
		});
		draft.tenure.queued = true;
		draft.tenure.queue = queue ? clone(queue) : null;
		retired.events.push(
			...(holderRetired
				? [
						event(draft, "holder-retired", holderRetired, draft["board-version"], {
							turnId: "runner:complete",
							actorId: holderRetired["agent-id"],
						}),
					]
				: []),
			event(draft, "tenure-retired", { term: barrier.term }, draft["board-version"], {
				turnId: "runner:complete",
				actorId: null,
			}),
			event(draft, "context-barrier-written", { barrier }, draft["board-version"], {
				turnId: "runner:complete",
				actorId: null,
			}),
			event(draft, "slice-queued", { report, queue: clone(queue) }, draft["board-version"], {
				turnId: "runner:complete",
				actorId: null,
			}),
		);
		return {
			board: draft,
			events: retired.events,
			response: {
				ok: true,
				outcome: "queued",
				term: barrier.term,
				barrier,
				queue,
				report,
				...((holderRetired ?? preSettledHolder) ? { holderRetired: holderRetired ?? preSettledHolder } : {}),
			},
			commit: true,
		};
	});
	if (!committed?.ok) return committed;

	runtime.phase = "queued";
	runtime.reviewer = null;
	runtime.nudge?.noteProgress();
	runtime.nudge?.noteBoardChange();
	return committed;
}

function retireTenure(board, { barrier, phase, successorTerm, successorAgentId, successorTermId, bumpVersion = true }) {
	ensureTenureShape(board);
	const oldTerm = board.tenure.term ?? 0;
	const oldTermId = currentTermId(board) ?? termIdFor(oldTerm);
	if (oldTermId) {
		if (!board["token-slot"]["retired-terms"].includes(oldTermId)) {
			board["token-slot"]["retired-terms"].push(oldTermId);
		}
	}
	// Every old tenure identity is invalid after the barrier. The Reviewer, the
	// fixed-slot Workers and a Holder may carry different term labels internally;
	// one barrier retires all of them.
	retireActors(board, null);
	board.actions = {};
	board.sleepers = {};
	board["token-slot"]["holder-id"] = null;
	board["token-slot"]["term-id"] = null;
	board["token-slot"].state = "free";
	board.tenure.barrier = clone(barrier);
	if (successorTerm !== null && successorTerm !== undefined) {
		board.tenure.term = successorTerm;
		board.tenure.phase = phase;
		board.tenure["term-id"] = successorTermId;
		board.tenure.ledger = {};
		board.tenure["root-tasks"] = [];
		board["next-ids"].term = Math.max(board["next-ids"].term ?? 1, successorTerm + 1);
		if (successorAgentId) registerActor(board, successorAgentId, "reviewer", successorTermId);
	} else {
		board.tenure.phase = phase;
	}
	if (bumpVersion) board["board-version"] = (board["board-version"] ?? 0) + 1;
	return {
		events: [],
		oldTerm,
		oldTermId,
	};
}

function relayReadiness(board) {
	ensureTenureShape(board);
	if (board.tenure?.phase !== "swarm") {
		return {
			ok: false,
			error: herdError("RESOURCES_NOT_QUIESCENT", "tenure is not in the swarm phase", {
				phase: board.tenure?.phase ?? null,
				next: "relay only after a review opened root tasks",
			}),
		};
	}
	const open = Object.values(board.tasks ?? {}).filter((task) => task.state !== "done");
	if (open.length > 0) {
		return {
			ok: false,
			error: herdError("RESOURCES_NOT_QUIESCENT", "unfinished board tasks remain", {
				openTaskIds: open.map((task) => task["task-id"]),
				next: "finish or cancel the remaining tasks first",
			}),
		};
	}
	for (const [key, taskId] of Object.entries(board.tenure.ledger ?? {})) {
		if (board.tasks?.[taskId]?.state !== "done") {
			return {
				ok: false,
				error: herdError("RESOURCES_NOT_QUIESCENT", "review finding is still open", {
					ledgerKey: key,
					taskId,
				}),
			};
		}
	}
	return checkBoardQuiescence(board);
}

function completionReadiness(board) {
	ensureTenureShape(board);
	if (!board.tenure || board.tenure.phase === "queued" || board.tenure.phase === "retired") {
		return {
			ok: false,
			error: herdError("STALE_CONTROL", "tenure is already terminal", {
				phase: board.tenure?.phase ?? null,
			}),
		};
	}
	const open = Object.values(board.tasks ?? {}).filter((task) => task.state !== "done");
	if (open.length > 0) {
		return {
			ok: false,
			error: herdError("RESOURCES_NOT_QUIESCENT", "unfinished board tasks remain", {
				openTaskIds: open.map((task) => task["task-id"]),
			}),
		};
	}
	for (const [key, taskId] of Object.entries(board.tenure.ledger ?? {})) {
		if (board.tasks?.[taskId]?.state !== "done") {
			return {
				ok: false,
				error: herdError("RESOURCES_NOT_QUIESCENT", "review finding is still open", {
					ledgerKey: key,
					taskId,
				}),
			};
		}
	}
	return checkBoardQuiescence(board);
}

/**
 * Retire the Holder in the current draft when the complete responsibility set
 * is empty. This mirrors the board kernel's settleHolder, but the runner needs
 * it inside its own ledger/relay transactions, where the board kernel is not
 * executing a command. The transition is same-object, same-transaction.
 *
 * Board actions that are not `finished` still keep the Holder alive, matching
 * the kernel's stricter hasActiveActionForActor check.
 */
function settleHolderIfEmpty(board) {
	const token = board["token-slot"];
	const holderId = token?.["holder-id"] ?? null;
	if (!holderId) return null;
	const actor = board.actors?.[holderId];
	if (actor?.["life-state"] !== "alive") return retireHolderDraft(board, holderId, "holder-missing");
	// A02-13: only applying/running/uncertain actions count toward R(a).
	// responsibilitySet already owns that rule; claimed/preparing/waiting-gate
	// alone must not keep a Holder alive.
	if (responsibilitySet(board, holderId).length > 0) return null;
	return retireHolderDraft(board, holderId, "no-responsibility");
}

function retireHolderDraft(board, holderId, reason) {
	const token = board["token-slot"];
	const termId = token["term-id"];
	token["retired-terms"] ??= [];
	if (termId && !token["retired-terms"].includes(termId)) token["retired-terms"].push(termId);
	token["holder-id"] = null;
	token["term-id"] = null;
	token.state = "free";
	const actor = board.actors?.[holderId];
	if (actor) {
		actor["life-state"] = "dead";
		actor["active-action-id"] = null;
	}
	delete board.sleepers?.[holderId];
	return { "agent-id": holderId, "term-id": termId, reason };
}

function holderDescriptor(board) {
	const token = board["token-slot"] ?? {};
	const holderId = token["holder-id"] ?? null;
	if (!holderId) return null;
	const actor = board.actors?.[holderId];
	return {
		agent_id: holderId,
		term_id: actor?.["term-id"] ?? token["term-id"] ?? null,
		role: actor?.role ?? "holder",
	};
}

async function settleHolderStandalone(runtime) {
	const receipt = await runtime.board.store.transaction(async (current) => {
		if (!current) return { board: null, events: [], response: missingBoard(runtime), commit: false };
		const draft = clone(current);
		ensureTenureShape(draft);
		const holderRetired = settleHolderIfEmpty(draft);
		if (!holderRetired) {
			return { board: current, events: [], response: { ok: true, holderRetired: null }, commit: false };
		}
		draft["board-version"] = (draft["board-version"] ?? 0) + 1;
		const ev = event(draft, "holder-retired", holderRetired, draft["board-version"], {
			turnId: "runner:complete",
			actorId: holderRetired["agent-id"],
		});
		return {
			board: draft,
			events: [ev],
			response: { ok: true, holderRetired },
			commit: true,
		};
	});
	return receipt ?? missingBoard(runtime);
}

function checkBoardQuiescence(board) {
	for (const action of Object.values(board.actions ?? {})) {
		if (ACTIVE_PHASES.has(action.phase)) {
			return {
				ok: false,
				error: herdError("RESOURCES_NOT_QUIESCENT", "an action is still in flight", {
					actionId: action["action-id"],
					phase: action.phase,
				}),
			};
		}
	}
	for (const task of Object.values(board.tasks ?? {})) {
		if (task.state !== "done" && task["needs-token"]) {
			return {
				ok: false,
				error: herdError("RESOURCES_NOT_QUIESCENT", "a token task is still open", {
					taskId: task["task-id"],
				}),
			};
		}
	}
	const holderId = board["token-slot"]?.["holder-id"] ?? null;
	if (holderId) {
		const actor = board.actors?.[holderId];
		if (actor && actor["life-state"] === "alive" && responsibilitySet(board, holderId).length > 0) {
			return {
				ok: false,
				error: herdError("RESOURCES_NOT_QUIESCENT", "the Holder still carries responsibility", {
					holderId,
				}),
			};
		}
	}
	if (board.conditions?.["pending-rebase"] === true) {
		return {
			ok: false,
			error: herdError("RESOURCES_NOT_QUIESCENT", "a rebase task is still pending", {
				condition: "pending-rebase",
			}),
		};
	}
	return { ok: true };
}

async function checkQuiescence(runtime, board, { ff }) {
	const boardCheck = checkBoardQuiescence(board);
	if (!boardCheck.ok) return boardCheck;
	const heldProbe = runtime.deps.writeLock?.held;
	if (typeof heldProbe !== "function") {
		return {
			ok: false,
			error: herdError("RESOURCES_NOT_QUIESCENT", "the slice write-lock port is unavailable", {
				sliceId: runtime.sliceId,
				next: "inject deps.writeLock.held; $W absence cannot be proven from an in-memory flag",
			}),
		};
	}
	let writeLockHeld;
	try {
		writeLockHeld = (await heldProbe()) === true;
	} catch (error) {
		return {
			ok: false,
			error: herdError("RESOURCES_NOT_QUIESCENT", "the slice write-lock probe failed", {
				sliceId: runtime.sliceId,
				cause: messageOf(error),
			}),
		};
	}
	if (writeLockHeld || runtime.writeLockHeld === true) {
		return {
			ok: false,
			error: herdError("RESOURCES_NOT_QUIESCENT", "the slice write lock is still held", {
				sliceId: runtime.sliceId,
				next: "release $W before an empty review",
			}),
		};
	}
	if (board.conditions?.["pending-rebase"] === true) {
		return {
			ok: false,
			error: herdError("RESOURCES_NOT_QUIESCENT", "a rebase task is still pending", {
				condition: "pending-rebase",
			}),
		};
	}
	if (!ff) return { ok: true };
	const port = runtime.deps.ff;
	if (typeof port?.ready !== "function") {
		return {
			ok: false,
			error: herdError("FF_NOT_READY", "ff dry-run port is unavailable", {
				sliceId: runtime.sliceId,
				next: "inject deps.ff.ready before accepting an empty review",
			}),
		};
	}
	let ready;
	try {
		ready = await port.ready({ workspace: runtime.slice.workspace, sliceId: runtime.sliceId });
	} catch (error) {
		ready = { ok: false, reason: messageOf(error) };
	}
	const ok = ready === true || ready?.ok === true;
	if (!ok) {
		return {
			ok: false,
			error: herdError("FF_NOT_READY", "git merge --ff-only dry-run failed", {
				sliceId: runtime.sliceId,
				reason: ready?.reason ?? ready?.message ?? "dry-run rejected",
				next: "Holder must rebase this Slice before the empty review",
			}),
		};
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Slot pool
// ---------------------------------------------------------------------------

async function wakeSlots(runtime, options = {}) {
	const board = await readBoardState(runtime);
	if (!board) return { ok: false, error: missingBoard(runtime).error };
	if (board.tenure?.phase !== "swarm") return { ok: true, started: [], failed: [] };

	const termId = currentTermId(board);
	const pending = [];
	for (const slot of runtime.slots.values()) {
		if (slot.status === "running" || slot.status === "starting") continue;
		if (slot.status === "stalled") {
			if (slot.deterministicStall === true && options.allowStalled !== true) continue;
			if (slot.retryTimer !== null && slot.retryTimer !== undefined && options.allowStalled !== true) continue;
			clearSlotRetry(runtime, slot);
			slot.retryAttempts = 0;
			slot.deterministicStall = false;
			slot.stalledReason = null;
			slot.status = "pending";
		}
		slot.agentId = nextAgentId(runtime, "worker");
		slot.status = "starting";
		slot.handle = null;
		slot.generation = (slot.generation ?? 0) + 1;
		pending.push(slot);
	}
	if (pending.length === 0) return { ok: true, started: [], failed: [] };

	const registration = await runtime.board.store.transaction(async (current) => {
		if (!current) return { board: null, events: [], response: missingBoard(runtime), commit: false };
		const draft = clone(current);
		ensureTenureShape(draft);
		if (currentTermId(draft) !== termId || terminated(draft, termId) || draft.tenure?.phase !== "swarm") {
			return {
				board: current,
				events: [],
				response: {
					ok: false,
					error: herdError("TENURE_RETIRED", "tenure changed before the slots could start", {
						expected: termId,
						actual: currentTermId(draft),
					}),
				},
				commit: false,
			};
		}
		draft["board-version"] = (draft["board-version"] ?? 0) + 1;
		const events = [];
		for (const slot of pending) {
			registerActor(draft, slot.agentId, slot.slotId, termId);
			events.push(
				event(draft, "slot-spawned", { slotId: slot.slotId, agentId: slot.agentId, termId }, draft["board-version"], {
					turnId: "runner:slot",
					actorId: slot.agentId,
				}),
			);
		}
		return { board: draft, events, response: { ok: true }, commit: true };
	});
	if (!registration?.ok) return registration;

	const started = [];
	const failed = [];
	for (const slot of pending) {
		const spawned = await spawnWorker(runtime, slot);
		if (spawned.ok) {
			started.push(publicSlot(slot));
		} else {
			slot.status = "pending";
			slot.lastError = spawned.error;
			failed.push({ slotId: slot.slotId, error: spawned.error });
			await markActorDead(runtime, slot.agentId, "worker-spawn-failed");
			scheduleSlotRetry(runtime, slot);
		}
	}
	if (failed.length > 0) {
		return {
			ok: false,
			error: herdError("AGENT_SPAWN_FAILED", "one or more worker slots could not start", {
				sliceId: runtime.sliceId,
				started: started.map((slot) => slot.slotId),
				failed: failed.map((entry) => entry.slotId),
				slotPreserved: true,
				next: "retry replaceSlot after the host is available; do not drop the root tasks",
			}),
			workers: { started, failed },
		};
	}
	runtime.nudge?.noteProgress();
	return { ok: true, started, failed };
}

async function spawnWorker(runtime, slot) {
	runtime.currentBoardSnapshot = await readBoardState(runtime);
	const prompt =
		typeof runtime.deps.buildWorkerPrompt === "function"
			? runtime.deps.buildWorkerPrompt({
					role: "Swarm Worker",
					sliceId: runtime.sliceId,
					workspace: runtime.slice.workspace ?? null,
					board: clone(runtime.currentBoardSnapshot),
					slot,
				})
			: buildWorkerPrompt(runtime, slot);
	const spawned = await spawnAgent(runtime, {
		agentId: slot.agentId,
		role: "Swarm Worker",
		name: `Worker-${runtime.sliceId}-${slot.slotId}`,
		prompt,
		tools: WORKER_TOOLS,
		index: Number.parseInt(slot.slotId.replace(/\D+/g, ""), 10) || 0,
	});
	if (!spawned.ok) return spawned;
	slot.status = "running";
	slot.retryAttempts = 0;
	slot.deterministicStall = false;
	slot.stalledReason = null;
	slot.handle = spawned.handle ?? null;
	if (spawned.done) {
		const spawnedAgentId = slot.agentId;
		const spawnedGeneration = slot.generation;
		spawned.done.then(
			(outcome) => onWorkerSettled(runtime, slot, outcome, spawnedAgentId, spawnedGeneration),
			(error) => onWorkerSettled(runtime, slot, { ok: false, error }, spawnedAgentId, spawnedGeneration),
		);
	}
	return { ok: true, agentId: slot.agentId };
}

async function stopReviewer(runtime, reason) {
	const reviewer = runtime.reviewer;
	if (!reviewer) return;
	const ids = abortAgent(runtime, reviewer, reason);
	reviewer.status = "stopped";
	runtime.reviewerAbort = { reason, agentIds: ids };
}

async function onWorkerSettled(runtime, slot, outcome, spawnedAgentId, spawnedGeneration) {
	// A late completion from an already replaced generation must not kill the
	// current identity in the same slot.
	if (slot.agentId !== spawnedAgentId || slot.generation !== spawnedGeneration) return;
	if (slot.agentId === null) return;
	slot.status = "dead";
	slot.lastError = outcome?.error;
	slot.lastOutcome = outcome?.ok === false ? "failed" : "finished";
	slot.consecutiveFailures = outcome?.ok === false ? (slot.consecutiveFailures ?? 0) + 1 : 0;
	if (runtime.cancelled) return;
	await markActorDead(runtime, slot.agentId, "worker-ended");
	if (runtime.deps.autoRespawn === false) return;
	const board = await readBoardState(runtime);
	if (board?.tenure?.phase !== "swarm") return;
	if (progressableSet(board).length === 0) return;
	const result = await replaceSlot({ slice: runtime.slice, deps: runtime.deps, slotId: slot.slotId });
	if (!result.ok && result.error?.code !== ":TENURE_RETIRED") {
		scheduleSlotRetry(runtime, slot);
	}
}

/**
 * Bounded retry for a slot whose spawn ended in failure or whose replacement
 * failed. The ready tasks stay on the board; the retry only replaces the
 * transport, never loses responsibility.
 */
function scheduleSlotRetry(runtime, slot) {
	if (runtime.cancelled || runtime.deps.autoRespawn === false) return null;
	if (slot.retryTimer !== null && slot.retryTimer !== undefined) return slot.retryTimer;
	if (slot.deterministicStall === true) return null;
	const deterministicCode = agentErrorCode(slot.lastError);
	if (DETERMINISTIC_AGENT_ERRORS.has(deterministicCode)) {
		slot.status = "stalled";
		slot.deterministicStall = true;
		slot.stalledReason = deterministicCode;
		runtime.nudge?.noteBoardChange();
		return null;
	}
	const attempt = (slot.retryAttempts ?? 0) + 1;
	const max = Number.isInteger(runtime.deps.maxSlotRetries) ? runtime.deps.maxSlotRetries : 3;
	const setTimer = runtime.deps.setTimeout ?? setTimeout;
	if (attempt > max) {
		// Do not drop the responsibility. A bounded burst is followed by a long
		// cooldown; an explicit wake() can retry immediately.
		slot.status = "stalled";
		slot.retryAttempts = 0;
		slot.stalledReason = "retry-cooldown";
		runtime.nudge?.noteBoardChange();
		const cooldown = Number.isFinite(runtime.deps.stalledRetryDelayMs) ? runtime.deps.stalledRetryDelayMs : 60_000;
		const timer = setTimer(() => {
			slot.retryTimer = null;
			slot.status = "pending";
			slot.retryAttempts = 0;
			void retrySlot(runtime, slot);
		}, cooldown);
		timer?.unref?.();
		slot.retryTimer = timer;
		return timer;
	}
	slot.retryAttempts = attempt;
	const delay = Number.isFinite(runtime.deps.retryDelayMs) ? runtime.deps.retryDelayMs : 5_000;
	const timer = setTimer(() => {
		slot.retryTimer = null;
		void retrySlot(runtime, slot);
	}, delay);
	timer?.unref?.();
	slot.retryTimer = timer;
	return timer;
}

function agentErrorCode(error) {
	if (!error || typeof error !== "object") return null;
	if (typeof error.data?.causeCode === "string") return error.data.causeCode;
	if (typeof error.code === "string") return error.code;
	return null;
}

async function retrySlot(runtime, slot) {
	if (runtime.cancelled || slot.status === "running" || slot.status === "starting") return;
	const board = await readBoardState(runtime).catch(() => null);
	if (board?.tenure?.phase !== "swarm") return;
	if (progressableSet(board).length === 0) return;
	const result = await replaceSlot({ slice: runtime.slice, deps: runtime.deps, slotId: slot.slotId });
	if (!result.ok && result.error?.code !== ":TENURE_RETIRED") scheduleSlotRetry(runtime, slot);
}

function clearSlotRetry(runtime, slot) {
	if (slot.retryTimer === null || slot.retryTimer === undefined) return;
	const clearTimer = runtime.deps.clearTimeout ?? clearTimeout;
	try {
		clearTimer(slot.retryTimer);
	} catch {
		// A timer that already fired is not a failure.
	}
	slot.retryTimer = null;
}

function clearDoneLedgerKeys(board) {
	const ledger = board.tenure?.ledger ?? {};
	const cleared = [];
	for (const [key, taskId] of Object.entries(ledger)) {
		if (board.tasks?.[taskId]?.state !== "done") continue;
		delete ledger[key];
		cleared.push(key);
	}
	return cleared;
}

function scheduleRelayRetry(runtime) {
	if (runtime.cancelled || (runtime.relayTimer !== null && runtime.relayTimer !== undefined)) return null;
	const setTimer = runtime.deps.setTimeout ?? setTimeout;
	const delay = Number.isFinite(runtime.deps.relayRetryDelayMs) ? runtime.deps.relayRetryDelayMs : 30_000;
	const timer = setTimer(() => {
		runtime.relayTimer = null;
		void retryRelay(runtime);
	}, delay);
	timer?.unref?.();
	runtime.relayTimer = timer;
	return timer;
}

function scheduleRelayRetryOnFailure(runtime, result) {
	const code = result?.error?.code;
	if (code === ":RESOURCES_NOT_QUIESCENT" || code === ":FF_NOT_READY") {
		scheduleRelayRetry(runtime);
	}
}

async function retryRelay(runtime) {
	if (runtime.cancelled) return;
	const board = await readBoardState(runtime).catch(() => null);
	if (board?.tenure?.phase !== "swarm") return;
	const result = await relay({ slice: runtime.slice, deps: runtime.deps });
	if (!result.ok && result.error?.code !== ":TENURE_RETIRED") scheduleRelayRetry(runtime);
}

function clearRelayRetry(runtime) {
	if (runtime.relayTimer === null || runtime.relayTimer === undefined) return;
	const clearTimer = runtime.deps.clearTimeout ?? clearTimeout;
	try {
		clearTimer(runtime.relayTimer);
	} catch {
		// A timer that already fired is not a failure.
	}
	runtime.relayTimer = null;
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

async function classifyActionsForCancel(runtime) {
	const cancelled = [];
	const outcomeUnknown = [];
	const applying = [];
	const receipt = await runtime.board.store.transaction(async (current) => {
		if (!current) return { board: null, events: [], response: missingBoard(runtime), commit: false };
		const draft = clone(current);
		ensureTenureShape(draft);
		const events = [];
		let changed = false;
		for (const action of Object.values(draft.actions ?? {})) {
			if (CANCELLED_PHASES.has(action.phase)) {
				action.phase = "finished";
				action.outcome = "cancelled";
				cancelled.push(action["action-id"]);
				changed = true;
				events.push(
					event(draft, "action-cancelled", { actionId: action["action-id"] }, (draft["board-version"] ?? 0) + 1, {
						turnId: "runner:cancel",
						actorId: action["agent-id"] ?? null,
					}),
				);
			} else if (action.phase === "applying") {
				applying.push(action["action-id"]);
				events.push(
					event(draft, "cancel-deferred-apply", { actionId: action["action-id"] }, (draft["board-version"] ?? 0) + 1, {
						turnId: "runner:cancel",
						actorId: action["agent-id"] ?? null,
					}),
				);
				changed = true;
			} else if (action.phase === "running") {
				action.phase = "uncertain";
				action.outcome = "outcome-unknown";
				outcomeUnknown.push(action["action-id"]);
				changed = true;
				events.push(
					event(draft, "action-outcome-unknown", { actionId: action["action-id"] }, (draft["board-version"] ?? 0) + 1, {
						turnId: "runner:cancel",
						actorId: action["agent-id"] ?? null,
					}),
				);
			} else if (action.phase === "uncertain") {
				action.outcome = "outcome-unknown";
				outcomeUnknown.push(action["action-id"]);
				changed = true;
			}
		}
		if (!changed) return { board: current, events: [], response: { ok: true }, commit: false };
		draft["board-version"] = (draft["board-version"] ?? 0) + 1;
		return { board: draft, events, response: { ok: true }, commit: true };
	});
	return {
		ok: receipt?.ok !== false,
		cancelled,
		outcomeUnknown,
		applying,
	};
}

// ---------------------------------------------------------------------------
// Nudge and upstream backoff
// ---------------------------------------------------------------------------

/**
 * Turn-end Nudge scheduler.
 *
 * `turnEnd({legalExit, waitingForHuman, progress, context})` returns the chosen
 * delay. First no-progress turn is immediate; then 30→60→120→240→300s. A
 * progress turn resets to 0. Waiting for a human, an approval panel or a cancel
 * confirmation suppresses the Nudge entirely. Board/human/gate/audit resets
 * clear the idle counter and make the next Nudge immediate.
 */
export function createNudgeScheduler(options = {}) {
	const schedule = Array.isArray(options.schedule) && options.schedule.length > 0 ? options.schedule : NUDGE_BACKOFF_MS;
	const send = options.send ?? options.sendNudge;
	const build = options.build ?? options.buildNudge ?? buildUnattendedNudge;
	const setTimer = options.setTimeout ?? setTimeout;
	const clearTimer = options.clearTimeout ?? clearTimeout;
	let idle = 0;
	let timer = null;
	let last = null;

	function cancelTimer() {
		if (timer !== null) {
			clearTimer(timer);
			timer = null;
		}
	}

	function reset() {
		idle = 0;
		cancelTimer();
	}

	function noteProgress() {
		reset();
		return { reset: true };
	}

	function noteBoardChange() {
		return noteProgress();
	}

	function noteHumanInput() {
		return noteProgress();
	}

	function noteGateSuccess() {
		return noteProgress();
	}

	function noteAuditResult() {
		return noteProgress();
	}

	function turnEnd(input = {}) {
		if (input.legalExit === true) {
			cancelTimer();
			return { suppressed: true, reason: "legal-exit" };
		}
		if (input.waitingForHuman === true) {
			cancelTimer();
			return { suppressed: true, reason: "waiting-for-human" };
		}
		if (input.progress === true) idle = 0;
		const delayMs = schedule[Math.min(idle, schedule.length - 1)];
		if (input.progress !== true) idle += 1;
		cancelTimer();
		const nudge = build({
			stage: input.stage,
			expectedTool: input.expectedTool,
			openItems: input.openItems ?? [],
			parkedPrograms: input.parkedPrograms ?? [],
			role: input.role,
		});
		const fire = () => {
			timer = null;
			if (typeof send === "function") {
				try {
					send(nudge, { triggerTurn: true });
				} catch {
					// A send failure is observed by the caller's health layer.
				}
			}
		};
		if (delayMs === 0) {
			fire();
		} else {
			timer = setTimer(fire, delayMs);
			timer?.unref?.();
		}
		last = { delayMs, nudge, at: options.now?.() ?? Date.now() };
		return { suppressed: false, delayMs, nudge, attempt: idle };
	}

	return Object.freeze({
		turnEnd,
		reset,
		noteProgress,
		noteBoardChange,
		noteHumanInput,
		noteGateSuccess,
		noteAuditResult,
		get idle() {
			return idle;
		},
		get last() {
			return last;
		},
		flush() {
			if (timer !== null) {
				clearTimer(timer);
				timer = null;
			}
			fireNow(nudgeLast(last));
		},
	});

	function nudgeLast(value) {
		return value?.nudge;
	}

	function fireNow(value) {
		if (typeof send === "function" && value !== undefined) send(value, { triggerTurn: true });
	}
}

/**
 * Classify an upstream failure. Transient outages retry on 5→10→20→40→80s;
 * deterministic quota/billing/key/model errors become `:STALLED`; a user abort
 * is never retried; malformed model output returns a parse error to the agent.
 */
export function classifyUpstreamError(error, options = {}) {
	const signal = options.signal;
	const message = `${error?.code ?? ""} ${error?.message ?? error?.error ?? ""}`.toLowerCase();
	const status = Number(error?.status ?? error?.statusCode);
	if (signal?.aborted === true || options.userAborted === true) {
		return { action: "cancelled", retry: false, code: "UPSTREAM_ABORTED", delayMs: null };
	}
	if (
		/insufficient_quota|insufficient quota|billing|payment|invalid.?api.?key|invalid key|model.?not.?found|does not exist/.test(
			message,
		) ||
		error?.deterministic === true
	) {
		return { action: "stalled", retry: false, code: "STALLED", delayMs: null };
	}
	if (status === 429 || status === 502 || status === 503 || status === 504 || status === 529) {
		return { action: "retry", retry: true, code: "UPSTREAM_ABORTED", status, delayMs: null };
	}
	if (/network_error|network error|econnreset|etimedout|socket hang up/.test(message)) {
		return { action: "retry", retry: true, code: "UPSTREAM_ABORTED", delayMs: null };
	}
	if (error?.aborted === true || /(^|\W)aborted(\W|$)/.test(message)) {
		return { action: "retry", retry: true, code: "UPSTREAM_ABORTED", delayMs: null };
	}
	if (error?.parse === true || /parse|malformed|invalid json|schema/.test(message)) {
		return { action: "fix", retry: false, code: "INVALID_ARGUMENT", delayMs: null };
	}
	return { action: "report", retry: false, code: error?.code ?? "UPSTREAM_ABORTED", delayMs: null };
}

export function createUpstreamBackoff(options = {}) {
	const schedule =
		Array.isArray(options.schedule) && options.schedule.length > 0 ? options.schedule : UPSTREAM_BACKOFF_MS;
	let attempt = 0;
	function failure(error, context = {}) {
		const verdict = classifyUpstreamError(error, context);
		if (!verdict.retry) {
			const result = { ...verdict, attempt: 0 };
			options.record?.(result, error, context);
			return result;
		}
		const delayMs = schedule[Math.min(attempt, schedule.length - 1)];
		const remaining = Math.max(0, schedule.length - attempt - 1);
		attempt += 1;
		const result = { ...verdict, delayMs, attempt, remaining };
		options.record?.(result, error, context);
		return result;
	}
	return Object.freeze({
		failure,
		reset() {
			attempt = 0;
		},
		get attempt() {
			return attempt;
		},
	});
}

// ---------------------------------------------------------------------------
// Blocker Oracle
// ---------------------------------------------------------------------------

export function createOracleGate(options = {}) {
	const threshold = Number.isInteger(options.threshold) ? options.threshold : 2;
	const maxConsultations = Number.isInteger(options.maxConsultations)
		? options.maxConsultations
		: Number.isInteger(options.max)
			? options.max
			: Number.POSITIVE_INFINITY;
	const now = options.now ?? Date.now;
	const counts = new Map();
	const attempted = new Map();

	function observe(input = {}) {
		const fingerprint = oracleFingerprint(input);
		if (attempted.has(fingerprint)) {
			return {
				trigger: false,
				fingerprint,
				reason: "already-consulted",
				count: counts.get(fingerprint) ?? 0,
			};
		}
		const previous = counts.get(fingerprint) ?? 0;
		const eventCount = Number.isInteger(input.eventCount) ? input.eventCount : 0;
		const count = Math.max(previous + 1, eventCount);
		counts.set(fingerprint, count);
		if (count < threshold) return { trigger: false, fingerprint, count, reason: "threshold-not-reached" };
		if (attempted.size >= maxConsultations) {
			return { trigger: false, fingerprint, count, reason: "budget-exhausted" };
		}
		attempted.set(fingerprint, { at: now(), taskId: input.taskId ?? null });
		return { trigger: true, fingerprint, count };
	}

	return Object.freeze({
		observe,
		hasConsulted(fingerprint) {
			return attempted.has(fingerprint);
		},
		countFor(fingerprint) {
			return counts.get(fingerprint) ?? 0;
		},
		get consultations() {
			return attempted.size;
		},
		snapshot() {
			return {
				threshold,
				maxConsultations,
				counts: Object.fromEntries(counts),
				attempted: [...attempted.keys()],
			};
		},
	});
}

/**
 * Turn board events into Oracle observations.
 *
 * A task reopened or released twice with the same effective reason produces
 * one fingerprint with count 2. `holder-failure` events are accepted the same
 * way. The caller passes the event ledger it read from the board store; the
 * runner never replays a file on its own.
 */
export function oracleCandidates({ board, events, threshold = 2 } = {}) {
	const counts = new Map();
	for (const entry of Array.isArray(events) ? events : []) {
		const type = entry?.["event-type"];
		if (!["task-reopened", "task-released", "task-cancelled", "holder-failure"].includes(type)) continue;
		const taskId = entry.taskId ?? entry["task-id"];
		const task = board?.tasks?.[taskId];
		if (!task) continue;
		const reason = entry.reason ?? type;
		const fingerprint = oracleFingerprint({
			goal: task.goal,
			doneWhen: task["done-when"],
			reason,
		});
		const current = counts.get(fingerprint) ?? {
			fingerprint,
			taskId,
			count: 0,
			reason,
			eventType: type,
		};
		current.count += 1;
		current.eventType = type;
		current.reason = reason;
		counts.set(fingerprint, current);
	}
	return [...counts.values()]
		.filter((candidate) => candidate.count >= threshold)
		.sort((left, right) => right.count - left.count || left.taskId.localeCompare(right.taskId));
}

/**
 * Start one read-only Oracle consultation.
 *
 * The advice is appended as a task comment; task state, owner, token slot and
 * acceptance thresholds are untouched. A generic "try again" answer is
 * recorded as "已会诊、无新路径" and the task continues. Each fingerprint
 * consumes its single automatic attempt even if the spawn fails; a failure
 * never fails the task.
 */
export async function runOracle(args = {}) {
	return attempt(async () => {
		const runtime = ensureRuntime(args.slice ?? args, args.deps ?? {});
		const taskId = textOr(args.taskId ?? args.task_id, null);
		if (!taskId) throw herdError("INVALID_ARGUMENT", "runOracle needs a task_id", { taskId });
		const board = await readBoardState(runtime);
		if (!board) return missingBoard(runtime);
		const task = board.tasks?.[taskId];
		if (!task) {
			return { ok: false, error: herdError("INVALID_ARGUMENT", "task does not exist", { taskId }) };
		}
		const reason = textOr(args.reason, "blocked");
		const gate = args.gate ?? runtime.oracleGate;
		let trigger = args.trigger;
		if (trigger === undefined && Array.isArray(args.events)) {
			const candidate = oracleCandidates({
				board,
				events: args.events,
				threshold: args.threshold ?? 2,
			}).find((entry) => entry.taskId === taskId);
			if (candidate) {
				trigger = gate?.observe({
					taskId,
					goal: task.goal,
					doneWhen: task["done-when"],
					reason,
					eventCount: candidate.count,
				});
			}
		}
		if (trigger === undefined)
			trigger = gate?.observe({ taskId, goal: task.goal, doneWhen: task["done-when"], reason });
		if (!trigger) return { ok: true, skipped: "not-triggered", fingerprint: null };
		if (trigger.trigger === false) {
			if (trigger.reason === "budget-exhausted") {
				await recordOracleSkip(runtime, {
					taskId,
					fingerprint: trigger.fingerprint,
					reason: trigger.reason,
				});
			}
			return {
				ok: true,
				skipped: trigger.reason ?? "not-triggered",
				fingerprint: trigger.fingerprint,
			};
		}
		const fingerprint = trigger.fingerprint;
		const prompt =
			typeof runtime.deps.buildOraclePrompt === "function"
				? runtime.deps.buildOraclePrompt({
						role: "Blocker Oracle",
						sliceId: runtime.sliceId,
						task: clone(task),
						reason,
						fingerprint,
					})
				: buildOraclePrompt(runtime, { task, reason, fingerprint });
		const spawned = await callAgentOnce(runtime, {
			agentId: nextAgentId(runtime, "oracle"),
			role: "Blocker Oracle",
			name: `Oracle-${runtime.sliceId}-${fingerprint.slice(0, 8)}`,
			prompt,
			tools: ORACLE_TOOLS,
			index: 0,
			maxRuntimeMs: runtime.deps.oracle?.timeoutMs,
		});
		if (!spawned.ok) return spawned;
		const advice = textOr(
			spawned.result?.advice_markdown ?? spawned.result?.adviceMarkdown ?? spawned.result?.advice,
			"",
		).trim();
		const specific = isSpecificAdvice(advice);
		const commentText = specific ? advice : `已会诊、无新路径：${advice || "Oracle returned no new path"}`;
		const receipt = await runtime.board.store.transaction(async (current) => {
			if (!current) return { board: null, events: [], response: missingBoard(runtime), commit: false };
			const draft = clone(current);
			ensureTenureShape(draft);
			const live = draft.tasks?.[taskId];
			if (!live) {
				return {
					board: current,
					events: [],
					response: { ok: false, error: herdError("INVALID_ARGUMENT", "task disappeared", { taskId }) },
					commit: false,
				};
			}
			live.comments = [
				...(live.comments ?? []),
				{
					"agent-id": spawned.agentId,
					"turn-id": "runner:oracle",
					"board-version": (draft["board-version"] ?? 0) + 1,
					text: commentText,
				},
			];
			const revivedTaskIds = resolveConditionDraft(draft, `oracle:${fingerprint}`, true, "runner:oracle");
			draft.tenure ??= { term: 0, phase: "swarm", retired: [] };
			draft.tenure.oracle = {
				...(draft.tenure.oracle ?? {}),
				[fingerprint]: {
					taskId,
					advice: commentText,
					outcome: specific ? "advice" : "no-new-path",
					at: nowIso(runtime),
				},
			};
			draft["board-version"] = (draft["board-version"] ?? 0) + 1;
			const ev = event(
				draft,
				specific ? "oracle-consulted" : "oracle-no-new-path",
				{ taskId, fingerprint, advice: commentText },
				draft["board-version"],
				{ turnId: "runner:oracle", actorId: spawned.agentId },
			);
			const events = [ev];
			if (revivedTaskIds.length > 0) {
				events.push(
					event(
						draft,
						"condition-resolved",
						{ key: `oracle:${fingerprint}`, value: true, revivedTaskIds },
						draft["board-version"],
						{ turnId: "runner:oracle", actorId: spawned.agentId },
					),
				);
			}
			return {
				board: draft,
				events,
				response: {
					ok: true,
					taskId,
					fingerprint,
					advice: commentText,
					outcome: specific ? "advice" : "no-new-path",
				},
				commit: true,
			};
		});
		if (receipt?.ok) {
			runtime.oracleGate = gate;
			runtime.nudge?.noteProgress();
		}
		return receipt;
	});
}

// ---------------------------------------------------------------------------
// Agent port plumbing
// ---------------------------------------------------------------------------

async function spawnAgent(runtime, spec, options = {}) {
	const agents = runtime.deps.agents;
	const start = agents?.start ?? agents?.startAgent ?? agents?.spawn;
	if (typeof start !== "function") {
		return {
			ok: false,
			error: herdError("AGENT_SPAWN_FAILED", "subagent port is not injected", {
				role: spec.role,
				agentId: spec.agentId,
				slotPreserved: true,
				next: "inject deps.agents.start; the runner never imports the host executor",
			}),
		};
	}
	const request = {
		role: spec.role,
		name: spec.name,
		cwd: runtime.slice.workspace ?? runtime.deps.workspace,
		task: spec.prompt,
		prompt: spec.prompt,
		index: spec.index ?? 0,
		id: spec.agentId,
		agentId: spec.agentId,
		signal: runtime.controller.signal,
		tools: [...spec.tools],
		artifactsDir: runtime.deps.artifactsDir,
		eventBus: runtime.deps.eventBus,
		settings: runtime.deps.settings,
		modelRegistry: runtime.deps.modelRegistry,
		...(spec.maxRuntimeMs === undefined ? {} : { maxRuntimeMs: spec.maxRuntimeMs }),
	};
	try {
		let started = start(request);
		if (started && typeof started.then === "function") {
			if (options.awaitCompletion !== true) {
				// The production host port (`spawnAgent`) is promise-only: the
				// promise settles when the whole subagent session ends. Treat it
				// as a long-lived slot and never block the caller that starts the
				// other slots.
				const done = started.then(
					(outcome) => outcome,
					(error) => ({ ok: false, error }),
				);
				return {
					ok: true,
					agentId: spec.agentId,
					handle: null,
					done,
					abort: null,
					started: null,
					pending: true,
				};
			}
			started = await started;
		}
		if (!started) {
			return spawnFailed(runtime, spec, "agent port returned no handle");
		}
		if (started.ok === false && !started.handle && !started.done) {
			return normalizeAgentFailure(runtime, spec, started);
		}
		return {
			ok: true,
			agentId: started.agentId ?? spec.agentId,
			handle: started.handle ?? null,
			done: started.done ?? null,
			abort: started.abort,
			started,
		};
	} catch (error) {
		return spawnFailed(runtime, spec, messageOf(error), error);
	}
}

async function callAgentOnce(runtime, spec) {
	const started = await spawnAgent(runtime, spec, { awaitCompletion: true });
	if (!started.ok) return started;
	let outcome = started.started;
	if (started.done) {
		try {
			outcome = await started.done;
		} catch (error) {
			return normalizeAgentFailure(runtime, spec, { ok: false, error });
		}
	}
	if (outcome && outcome.ok === false) return normalizeAgentFailure(runtime, spec, outcome);
	const result = outcome?.result ?? outcome;
	return { ok: true, agentId: started.agentId, result, outcome };
}

async function waitForReview(runtime, options = {}) {
	if (!runtime.reviewer?.done) {
		const completion = runtime.reviewer?.started?.done;
		if (!completion) return runtime.reviewer?.started?.result ?? null;
		runtime.reviewer.done = completion;
	}
	if (!runtime.reviewer?.done || options.awaitCompletion !== true) return null;
	try {
		const outcome = await runtime.reviewer.done;
		if (outcome?.ok === false) return null;
		return outcome?.result ?? null;
	} catch {
		return null;
	}
}

function normalizeAgentFailure(runtime, spec, outcome) {
	const error = outcome?.error;
	if (isHerdError(error)) {
		return {
			ok: false,
			error,
			agentId: outcome.agentId ?? spec.agentId,
			slotPreserved: true,
		};
	}
	return spawnFailed(runtime, spec, error === undefined ? "agent failed" : messageOf(error), error, outcome);
}

function spawnFailed(runtime, spec, message, cause, outcome) {
	return {
		ok: false,
		error: herdError(
			"AGENT_SPAWN_FAILED",
			`${spec.role} could not start: ${message}`,
			{
				sliceId: runtime.sliceId,
				role: spec.role,
				agentId: outcome?.agentId ?? spec.agentId,
				slotPreserved: true,
				causeCode: typeof cause?.code === "string" ? cause.code : undefined,
				next: "inspect the host session log and retry the slot; the responsibility stays on the board",
			},
			cause,
		),
		agentId: outcome?.agentId ?? spec.agentId,
		slotPreserved: true,
	};
}

async function markActorDead(runtime, agentId, reason) {
	if (!agentId) return;
	await runtime.board.store.transaction(async (current) => {
		if (!current) return { board: null, events: [], response: missingBoard(runtime), commit: false };
		const actor = current.actors?.[agentId];
		if (actor?.["life-state"] !== "alive") {
			return { board: current, events: [], response: { ok: true }, commit: false };
		}
		const draft = clone(current);
		ensureTenureShape(draft);
		draft.actors[agentId]["life-state"] = "dead";
		draft.actors[agentId]["active-action-id"] = null;
		delete draft.sleepers?.[agentId];
		const token = draft["token-slot"];
		let holderRetired = null;
		if (token && token["holder-id"] === agentId) {
			const termId = token["term-id"];
			token["retired-terms"] ??= [];
			if (termId && !token["retired-terms"].includes(termId)) token["retired-terms"].push(termId);
			holderRetired = { "agent-id": agentId, "term-id": termId, reason };
			token["holder-id"] = null;
			token["term-id"] = null;
			token.state = "free";
		}
		draft["board-version"] = (draft["board-version"] ?? 0) + 1;
		const ev = event(draft, "actor-died", { agentId, reason }, draft["board-version"], {
			turnId: "runner:actor",
			actorId: agentId,
		});
		const events = [ev];
		if (holderRetired) {
			events.push(
				event(draft, "holder-retired", holderRetired, draft["board-version"], {
					turnId: "runner:actor",
					actorId: agentId,
				}),
			);
		}
		return { board: draft, events, response: { ok: true }, commit: true };
	});
}

function abortAgent(runtime, entry, reason) {
	const ids = [];
	const handle = entry.handle ?? entry.outcome?.handle ?? entry;
	try {
		if (handle && typeof handle.abort === "function") {
			handle.abort(reason);
			ids.push(entry.agentId ?? handle.agentId ?? "unknown");
		} else if (handle?.controller && typeof handle.controller.abort === "function") {
			handle.controller.abort(reason);
			ids.push(entry.agentId ?? handle.agentId ?? "unknown");
		} else if (entry.abort && typeof entry.abort === "function") {
			entry.abort(reason);
			ids.push(entry.agentId ?? "unknown");
		} else if (runtime.deps.agents?.abortTree && handle) {
			const result = runtime.deps.agents.abortTree(handle, reason);
			if (Array.isArray(result?.agentIds) && result.agentIds.length > 0) ids.push(...result.agentIds);
			else ids.push(entry.agentId ?? "unknown");
		}
	} catch {
		// Idempotent cancellation: an already aborted handle is fine.
	}
	return ids;
}

function liveAgentEntries(runtime) {
	const entries = [];
	if (runtime.reviewer && runtime.reviewer.status === "running") entries.push(runtime.reviewer);
	for (const slot of runtime.slots.values()) {
		if (slot.status === "running" || slot.status === "starting") entries.push(slot);
	}
	return entries;
}

async function unmountReviewTool(runtime) {
	runtime.reviewToolUnmounted = true;
	const port = runtime.deps.reviewTool;
	try {
		if (typeof port?.unmount === "function") await port.unmount();
		if (typeof runtime.deps.setActiveTools === "function") await runtime.deps.setActiveTools([]);
	} catch (error) {
		runtime.reviewToolError = messageOf(error);
	}
}

// ---------------------------------------------------------------------------
// Runtime and board helpers
// ---------------------------------------------------------------------------

function ensureRuntime(sliceOrArgs = {}, deps = {}) {
	const slice = sliceOrArgs.slice ?? sliceOrArgs;
	const root = slice.root ?? deps.root;
	const slug = slice.slug ?? deps.slug;
	const sliceId = slice.slice_id ?? slice.sliceId ?? deps.sliceId ?? deps.slice_id;
	if (!root || !slug || !sliceId) {
		throw herdError("INVALID_ARGUMENT", "runner needs root, slug and slice_id", {
			root: root ?? null,
			slug: slug ?? null,
			sliceId: sliceId ?? null,
		});
	}
	const key = [root, slug, sliceId].join("\u0000");
	let runtime = runtimes.get(key);
	if (!runtime) {
		const board = resolveBoard(slice, deps, root, slug, sliceId);
		runtime = {
			key,
			root,
			slug,
			sliceId,
			slice: { ...slice, root, slug, slice_id: sliceId },
			deps: { ...deps },
			board,
			controller: new AbortController(),
			slots: new Map(),
			reviewer: null,
			reviewerAgentId: null,
			term: null,
			termId: null,
			phase: "review",
			cancelled: false,
			initialAskUsed: false,
			writeLockHeld: false,
			oracleGate: createOracleGate(deps.oracle ?? {}),
			nudge: createNudgeScheduler({
				...deps.nudge,
				build: deps.buildNudge ?? deps.nudge?.build,
				send: deps.sendNudge ?? deps.nudge?.send,
				now: deps.now ?? deps.nudge?.now,
			}),
		};
		const slotCount = Number.isInteger(deps.slots)
			? Math.max(1, deps.slots)
			: Number.isInteger(slice.slots)
				? Math.max(1, slice.slots)
				: DEFAULT_SLOTS;
		for (let index = 1; index <= slotCount; index += 1) {
			const slotId = `slot-${index}`;
			runtime.slots.set(slotId, {
				slotId,
				agentId: null,
				status: "idle",
				handle: null,
				generation: 0,
				lastOutcome: null,
			});
		}
		runtimes.set(key, runtime);
	} else {
		runtime.deps = { ...runtime.deps, ...deps };
		if (slice.board && !runtime.board) runtime.board = slice.board;
		if (deps.board && !runtime.board) runtime.board = deps.board;
	}
	return runtime;
}

function resolveBoard(slice, deps, root, slug, sliceId) {
	if (isBoardHandle(slice.board)) return slice.board;
	if (isBoardHandle(deps.board)) return deps.board;
	if (typeof deps.openBoard === "function") {
		const opened = deps.openBoard(root, slug, sliceId);
		if (isBoardHandle(opened)) return opened;
	}
	// Production fallback: board.mjs now defaults to the durable file store.
	// The handle stays lazy; a missing board is reported by the first read and
	// is never seeded by the runner.
	return openBoard(root, slug, sliceId, {
		...(typeof slice.board_path === "string" ? { boardPath: slice.board_path } : {}),
	});
}

function isBoardHandle(value) {
	return Boolean(value && typeof value === "object" && value.store && typeof value.store.read === "function");
}

async function readBoardState(runtime) {
	if (!runtime.board?.store || typeof runtime.board.store.read !== "function") return null;
	return runtime.board.store.read();
}

function missingBoard(runtime) {
	return {
		ok: false,
		error: herdError("STALE_CONTROL", "slice board is missing", {
			root: runtime.root,
			slug: runtime.slug,
			sliceId: runtime.sliceId,
			next: "forkSlices must seed the Slice board; do not rebuild an empty one",
		}),
	};
}

function cancelledTree(runtime) {
	return {
		ok: false,
		error: herdError("UPSTREAM_ABORTED", "the runner tree is cancelled", {
			sliceId: runtime.sliceId,
			next: "start a new run from the current workspace; do not resume a cancelled tree",
		}),
		cancelled: true,
		retained: true,
	};
}

function missionRecoveryRuntime(root, slug, deps) {
	const board = deps.board ?? deps.boardHandle ?? null;
	return {
		root,
		slug,
		sliceId: null,
		slice: { root, slug, lock_paths: deps.lockPaths ?? {} },
		deps,
		board,
		controller: new AbortController(),
		slots: new Map(),
		reviewer: null,
		term: null,
		termId: null,
		phase: "recovery",
		cancelled: true,
		oracleGate: createOracleGate(deps.oracle ?? {}),
		nudge: createNudgeScheduler({
			...deps.nudge,
			build: deps.buildNudge ?? deps.nudge?.build,
			send: deps.sendNudge ?? deps.nudge?.send,
			now: deps.now ?? deps.nudge?.now,
		}),
	};
}

function ensureTenureShape(board) {
	board.tenure ??= { term: 0, phase: "swarm" };
	board.tenure.ledger ??= {};
	board.tenure["root-tasks"] ??= [];
	board["token-slot"] ??= {};
	board["token-slot"]["retired-terms"] ??= [];
	board["token-slot"]["holder-id"] ??= null;
	board["token-slot"]["term-id"] ??= null;
	board["token-slot"].state ??= "free";
	board["next-ids"] ??= {};
	for (const [key, start] of [
		["task", 1],
		["claim", 1],
		["term", 1],
		["action", 1],
		["event", 1],
	]) {
		if (!Number.isInteger(board["next-ids"][key])) board["next-ids"][key] = start;
	}
	board.actions ??= {};
	board.actors ??= {};
	board.sleepers ??= {};
	board.conditions ??= {};
	board.wake ??= { epoch: 0 };
	board.wake.epoch ??= 0;
}

function registerActor(board, agentId, slotId, termId) {
	board.actors[agentId] = {
		"agent-id": agentId,
		"slot-id": slotId,
		role: "normal",
		"life-state": "alive",
		"active-action-id": null,
		"term-id": termId ?? null,
	};
}

function retireActors(board, termId) {
	for (const actor of Object.values(board.actors ?? {})) {
		if (actor["life-state"] !== "alive") continue;
		if (termId && actor["term-id"] && actor["term-id"] !== termId) continue;
		actor["life-state"] = "dead";
		actor["active-action-id"] = null;
	}
}

function currentTermId(board) {
	if (!board?.tenure) return null;
	return board.tenure["term-id"] ?? (board.tenure.term ? termIdFor(board.tenure.term) : null);
}

function termIdFor(term) {
	return `T-${term}`;
}

function terminated(board, termId) {
	if (!termId) return true;
	const tokenRetired = board["token-slot"]?.["retired-terms"] ?? [];
	return tokenRetired.includes(termId);
}

function resolveConditionDraft(board, key, value, turnId) {
	board.conditions ??= {};
	board.conditions[key] = value;
	const revived = [];
	if (value !== true) return revived;
	for (const task of Object.values(board.tasks ?? {})) {
		if (task.state !== "waiting") continue;
		const waits = Array.isArray(task["wait-for"]) ? task["wait-for"] : [];
		if (waits.length === 0) continue;
		const conditionWait = `condition:${key}`;
		if (!waits.includes(conditionWait)) continue;
		const satisfied = waits.every((entry) => {
			if (typeof entry !== "string") return false;
			if (entry.startsWith("condition:")) return board.conditions[entry.slice("condition:".length)] === true;
			const target = board.tasks?.[entry];
			return !target || target.state === "done";
		});
		if (!satisfied) continue;
		task.state = "ready";
		task["wait-for"] = [];
		task["revived-turn-id"] = turnId;
		revived.push(task["task-id"]);
	}
	return revived;
}

function event(board, type, data, version, context = {}) {
	const id = `E-${board["next-ids"].event}`;
	board["next-ids"].event += 1;
	return {
		"event-id": id,
		"event-type": type,
		"board-version": version,
		"request-id": context.requestId ?? null,
		"actor-id": context.actorId ?? null,
		"turn-id": context.turnId ?? null,
		...clone(data),
	};
}

function nextAgentId(runtime, prefix) {
	const uuid = typeof runtime.deps.randomUUID === "function" ? runtime.deps.randomUUID() : randomUUID();
	return `${prefix}-${uuid}`;
}

function publicSlot(slot) {
	return {
		slotId: slot.slotId,
		agentId: slot.agentId,
		status: slot.status,
		generation: slot.generation,
		...(slot.stalledReason === null || slot.stalledReason === undefined ? {} : { stalledReason: slot.stalledReason }),
	};
}

function normalizeFindings(findings) {
	if (!Array.isArray(findings)) {
		return {
			ok: false,
			error: herdError("INVALID_ARGUMENT", "findings must be an array", { actual: typeof findings }),
		};
	}
	const keys = new Set();
	const normalized = [];
	for (let index = 0; index < findings.length; index += 1) {
		const raw = findings[index];
		const key = textOr(raw?.key, null);
		const value = textOr(raw?.value, null);
		if (!key || !value) {
			return {
				ok: false,
				error: herdError("INVALID_ARGUMENT", `findings[${index}] needs non-empty key and value`, {
					index,
					key,
					value,
				}),
			};
		}
		if (keys.has(key)) {
			return {
				ok: false,
				error: herdError("INVALID_ARGUMENT", "finding keys must be unique", { key, index }),
			};
		}
		keys.add(key);
		normalized.push({ key, value });
	}
	return { ok: true, findings: normalized };
}

function selectRuntimes(args) {
	if (args.slice) return [ensureRuntime(args.slice, args.deps ?? {})];
	const root = args.root ?? args.deps?.root;
	const slug = args.slug ?? args.deps?.slug;
	return [...runtimes.values()].filter(
		(runtime) => (!root || runtime.root === root) && (!slug || runtime.slug === slug),
	);
}

// ---------------------------------------------------------------------------
// Prompt and receipt builders
// ---------------------------------------------------------------------------

function reviewContext(runtime) {
	return {
		role: "Reviewer",
		sliceId: runtime.sliceId,
		workspace: runtime.slice.workspace,
		contracts: runtime.deps.contracts ?? runtime.slice.contracts ?? [],
		seed: runtime.deps.seed ?? runtime.slice.seed ?? "",
		termId: runtime.termId,
	};
}

function buildReviewerPrompt(runtime, { successor, termId, board }) {
	const lines = [
		"Role: Reviewer. You own one Slice review window. You are read-only.",
		`Slice: ${runtime.sliceId}`,
		`Tenure: ${termId}`,
		`Slice goal: ${runtime.slice.goal ?? "(see the frozen S4 Slice row)"}`,
		`Workspace: ${runtime.slice.workspace ?? "(unset)"}`,
		`Mission seed: ${runtime.deps.seed ?? runtime.slice.seed ?? "(frozen contract is authoritative)"}`,
		"Frozen contracts:",
		...contractLines(runtime),
		"Mapped cases:",
		...caseLines(runtime),
		"Current board task tree:",
		...taskLines(board),
		...(successor && board?.tenure?.barrier
			? [
					"Successor barrier (no predecessor conversation):",
					`- retired term: ${board.tenure.barrier.term ?? "unknown"}`,
					`- milestone: ${JSON.stringify(board.tenure.barrier.milestone ?? null)}`,
				]
			: []),
		"Successor hint: read the frozen contracts, this worktree, the board task results and the events you can see; no predecessor conversation or private reasoning is available.",
		"Required exit: call submit_review with findings [{key, value}]. Empty findings require Quiescence and a passing ff dry-run; a non-empty set opens root tasks and wakes the swarm.",
	];
	return lines.join("\n");
}

function buildWorkerPrompt(runtime, slot) {
	const lines = [
		"Role: Swarm Worker. You work only through your slice board and the protected write tools.",
		`Slice: ${runtime.sliceId}`,
		`Slot: ${slot.slotId}`,
		`Workspace: ${runtime.slice.workspace ?? "(unset)"}`,
		"Board task tree:",
		...taskLines(runtime.currentBoardSnapshot),
		"Rules: split before claiming; never finish a parent in the same turn its last child finishes; use board_take_or_die only when no valuable protected work remains and a :needs-token task is open.",
		"Required exit: leave the board consistent and call a board tool with a concrete result, or a Nudge will drive the next turn.",
	];
	return lines.join("\n");
}

function buildOraclePrompt(runtime, { task, reason, fingerprint }) {
	return [
		"Role: Blocker Oracle. You are read-only and you do not own the board.",
		`Slice: ${runtime.sliceId}`,
		`Task: ${task["task-id"]}`,
		`Goal: ${task.goal}`,
		`Done when: ${task["done-when"]}`,
		`Blocking reason: ${reason}`,
		`Fingerprint: ${fingerprint}`,
		"Give one specific, falsifiable alternative: which interface to change, which hypothesis to verify first, which scope to cut, or which path to abandon. Do not edit files, finish tasks, change ownership, or lower acceptance thresholds.",
		"Submit through submit_oracle_advice({task_id, advice_markdown}).",
	].join("\n");
}

function buildSliceReport(runtime, board) {
	const lines = [
		`# Slice ${runtime.sliceId} report`,
		`- board-version: ${board["board-version"] ?? 0}`,
		`- tenure: ${board.tenure?.term ?? 0}`,
		`- queued-at: ${nowIso(runtime)}`,
		"",
		"## Tasks",
	];
	for (const task of Object.values(board.tasks ?? {})) {
		lines.push(
			`- ${task["task-id"]} [${task.state}] ${task.goal}`,
			`  done_when: ${task["done-when"]}`,
			`  result: ${task["result-summary"] ?? "(none)"}`,
		);
	}
	return lines.join("\n");
}

function buildUnattendedNudge({ stage, expectedTool, openItems, parkedPrograms, role }) {
	return [
		"[无人值守常授权模式]",
		`当前阶段：${stage ?? "S5"}；当前角色：${role ?? "Swarm"}`,
		`当前出口工具：${expectedTool ?? "board_finish"}`,
		`未结义务：${Array.isArray(openItems) && openItems.length > 0 ? openItems.join("; ") : "none recorded"}`,
		`未恢复的沙箱程序：${Array.isArray(parkedPrograms) && parkedPrograms.length > 0 ? parkedPrograms.join(", ") : "none"}`,
		"系统处于无人值守常授权模式：禁止等待用户决策或授权，禁止半途而废，禁止用纯聊天正文代替结构化工具调用。",
	].join("\n");
}

function contractLines(runtime) {
	const contracts = runtime.deps.contracts ?? runtime.slice.contracts ?? [];
	if (!Array.isArray(contracts) || contracts.length === 0) return ["- (no contract paths were injected)"];
	return contracts.map((entry) =>
		typeof entry === "string"
			? `- ${entry}`
			: `- ${entry.path ?? entry.name ?? "(unnamed)"} sha256=${entry.sha256 ?? entry.hash ?? "(unrecorded)"}`,
	);
}

function caseLines(runtime) {
	const cases = runtime.slice.mapped_cases ?? runtime.slice.mappedCases ?? runtime.deps.mappedCases ?? [];
	if (!Array.isArray(cases) || cases.length === 0) return ["- (no CASE is mapped to this Slice)"];
	return cases.map((entry) =>
		typeof entry === "string" ? `- ${entry}` : `- ${entry.case_id ?? entry["case-id"] ?? "(unnamed)"}`,
	);
}

function taskLines(board) {
	const tree = board ? taskTree(board) : [];
	if (tree.length === 0) return ["- (board is empty)"];
	return tree.map(
		(task) =>
			`- ${task.taskId} [${task.state}] owner=${task.ownerId ?? "nil"} token=${task.needsToken} goal=${task.goal}`,
	);
}

function nowIso(runtime) {
	const now = runtime.deps.now;
	const value = typeof now === "function" ? now() : Date.now();
	return new Date(value).toISOString();
}

// ---------------------------------------------------------------------------
// Recovery windows
// ---------------------------------------------------------------------------

function scanMission(_runtime, missionDir) {
	const path = join(missionDir, "mission.edn");
	if (!existsSync(path)) {
		return { window: "mission", status: "missing", path, corruptFile: null };
	}
	try {
		const text = readFileSync(path, "utf8");
		return {
			window: "mission",
			status: text.trim().length > 0 ? "present" : "empty",
			path,
			bytes: Buffer.byteLength(text, "utf8"),
			corruptFile: text.trim().length === 0 ? path : null,
		};
	} catch (error) {
		return { window: "mission", status: "unreadable", path, reason: messageOf(error), corruptFile: path };
	}
}

async function scanMissionBoards(runtime) {
	const missionDir = join(runtime.root, ".herd", "missions", runtime.slug);
	const directories = sliceDirectories(missionDir);
	if (directories.length === 0) {
		return { window: "board", status: "none", slices: [], outcomeUnknown: [] };
	}
	const slices = [];
	const outcomeUnknown = [];
	let status = "present";
	for (const directory of directories) {
		const sliceId = basename(directory);
		const handle = openBoard(runtime.root, runtime.slug, sliceId);
		try {
			const state = await handle.store.read();
			if (state === null) {
				status = status === "present" ? "missing" : status;
				slices.push({ sliceId, status: "missing", path: handle.boardPath });
				continue;
			}
			const unknown = Object.values(state.actions ?? {})
				.filter((action) => action.phase === "uncertain" || action.outcome === "outcome-unknown")
				.map((action) => action["action-id"]);
			outcomeUnknown.push(...unknown);
			const openLedger = Object.entries(state.tenure?.ledger ?? {}).filter(
				([, taskId]) => state.tasks?.[taskId]?.state !== "done",
			);
			const relayPending =
				state.tenure?.phase === "swarm" &&
				Object.values(state.tasks ?? {}).every((task) => task.state === "done") &&
				openLedger.length === 0;
			slices.push({
				sliceId,
				status: "present",
				path: handle.boardPath,
				boardVersion: state["board-version"] ?? null,
				tenure: state.tenure ?? null,
				outcomeUnknown: unknown,
				relayPending,
			});
		} catch (error) {
			status = "corrupt";
			slices.push({
				sliceId,
				status: "corrupt",
				path: handle.boardPath,
				reason: messageOf(error),
			});
		}
	}
	return { window: "board", status, slices, outcomeUnknown };
}

async function readMissionActors(runtime) {
	const missionDir = join(runtime.root, ".herd", "missions", runtime.slug);
	const actors = {};
	for (const directory of sliceDirectories(missionDir)) {
		const sliceId = basename(directory);
		const handle = openBoard(runtime.root, runtime.slug, sliceId);
		try {
			const state = await handle.store.read();
			Object.assign(actors, state?.actors ?? {});
		} catch {
			// A corrupt board is reported by scanMissionBoards; it cannot prove a lock dead.
		}
	}
	return { actors };
}

function scanMissionWorktrees(runtime) {
	const directory = join(runtime.root, ".herd-worktrees", runtime.slug);
	if (!existsSync(directory)) {
		return { window: "worktree", status: "none", entries: [], retained: true };
	}
	try {
		const entries = readdirSync(directory)
			.filter((name) => !name.startsWith("."))
			.map((name) => {
				const path = join(directory, name);
				const present = existsSync(path);
				return { sliceId: name, path, present, retained: true };
			});
		return {
			window: "worktree",
			status: entries.some((entry) => !entry.present) ? "missing" : entries.length > 0 ? "present" : "none",
			entries,
			retained: true,
		};
	} catch (error) {
		return {
			window: "worktree",
			status: "unreadable",
			entries: [],
			reason: messageOf(error),
			retained: true,
		};
	}
}

async function scanBoard(runtime) {
	if (!runtime.board) {
		return {
			window: "board",
			status: "not-injected",
			path: null,
			outcomeUnknown: [],
			next: "pass deps.board when a Slice board must be checked",
		};
	}
	const path = runtime.board.boardPath ?? null;
	try {
		const state = await runtime.board.store.read();
		if (!state) {
			return {
				window: "board",
				status: "missing",
				path,
				corruptFile: existsSync(path) ? path : null,
				next: "restore the last committed board; the runner does not recreate one",
			};
		}
		return {
			window: "board",
			status: "present",
			path,
			boardVersion: state["board-version"] ?? null,
			tenure: state.tenure ?? null,
			outcomeUnknown: Object.values(state.actions ?? {})
				.filter((action) => action.phase === "uncertain" || action.outcome === "outcome-unknown")
				.map((action) => action["action-id"]),
		};
	} catch (error) {
		return {
			window: "board",
			status: "corrupt",
			path,
			reason: messageOf(error),
			corruptFile: path,
		};
	}
}

async function scanLocks(runtime, boardState) {
	const paths = new Set();
	for (const path of Object.values(runtime.slice.lock_paths ?? {})) {
		if (typeof path === "string") paths.add(path);
	}
	for (const path of Object.values(runtime.deps.lockPaths ?? {})) {
		if (typeof path === "string") paths.add(path);
	}
	const lockDirectory = join(runtime.root, ".herd", "locks");
	if (existsSync(lockDirectory)) {
		try {
			for (const name of readdirSync(lockDirectory)) {
				if (name.endsWith(".lock")) paths.add(join(lockDirectory, name));
			}
		} catch {
			// The lock directory is reported by its individual entries below.
		}
	}
	const entries = [];
	const staleFiles = [];
	const agentState = (agentId) => boardState?.actors?.[agentId]?.["life-state"];
	for (const path of paths) {
		let result;
		try {
			result = normalizeLockInspection(
				typeof runtime.deps.lock?.inspect === "function"
					? await runtime.deps.lock.inspect(path)
					: await inspectLock(path, { agentState }),
			);
		} catch (error) {
			result = { state: "unknown", reason: messageOf(error) };
		}
		const entry = { path, ...(result ?? { state: "unknown" }) };
		entries.push(entry);
		if (entry.state === "stale") staleFiles.push(path);
	}
	return {
		window: "locks",
		entries,
		staleFiles,
		aliveFiles: entries.filter((entry) => entry.state === "alive").map((entry) => entry.path),
	};
}

function normalizeLockInspection(value) {
	if (!value || typeof value !== "object") {
		return { state: "unknown", reason: "lock inspector returned no object" };
	}
	if (typeof value.state === "string") return value;
	const state =
		value.stale === true ? "stale" : value.alive === true ? "alive" : value.exists === false ? "missing" : "unknown";
	return { ...value, state };
}

function scanTmp(_runtime, missionDir) {
	const files = [];
	for (const directory of [missionDir, ...sliceDirectories(missionDir)]) {
		if (!existsSync(directory)) continue;
		try {
			for (const name of readdirSync(directory)) {
				if (!name.startsWith(".tmp-")) continue;
				const path = join(directory, name);
				const stat = statSync(path);
				files.push({ path, bytes: stat.size });
			}
		} catch {
			// A directory that cannot be listed is reported by its absence.
		}
	}
	return { window: "tmp", files, retained: true };
}

function sliceDirectories(missionDir) {
	const slicesDir = join(missionDir, "slices");
	if (!existsSync(slicesDir)) return [];
	try {
		return readdirSync(slicesDir)
			.filter((name) => !name.startsWith("."))
			.map((name) => join(slicesDir, name));
	} catch {
		return [];
	}
}

function scanLedger(runtime) {
	const checkpointPath = runtime.board?.checkpointPath ?? null;
	const eventsPath = runtime.board?.eventsPath ?? join(runtime.root, ".herd", "missions", runtime.slug, "events.jsonl");
	let offset = null;
	let checkpointStatus = "missing";
	if (checkpointPath && existsSync(checkpointPath)) {
		checkpointStatus = "present";
		try {
			const text = readFileSync(checkpointPath, "utf8");
			const match = /(?::offset\s+|"offset"\s*:\s*)(\d+)/.exec(text);
			offset = match ? Number(match[1]) : null;
		} catch (error) {
			checkpointStatus = "unreadable";
			offset = null;
			return {
				window: "ledger",
				checkpointPath,
				eventsPath,
				checkpointStatus,
				offset,
				replayed: false,
				error: messageOf(error),
			};
		}
	}
	let eventsBytes = 0;
	if (eventsPath && existsSync(eventsPath)) {
		try {
			eventsBytes = statSync(eventsPath).size;
		} catch {
			eventsBytes = 0;
		}
	}
	return {
		window: "ledger",
		checkpointPath,
		eventsPath,
		checkpointStatus,
		offset,
		eventsBytes,
		replayed: false,
		next: offset === null ? "start from the last committed offset; never replay the whole events file" : undefined,
	};
}

function scanWorktree(runtime) {
	const path = runtime.slice.workspace ?? null;
	if (!path) return { window: "worktree", status: "not-selected", path: null, retained: true };
	return {
		window: "worktree",
		status: existsSync(path) ? "present" : "missing",
		path,
		retained: true,
	};
}

function collectOperatorActions(scanned) {
	const actions = [];
	if (scanned.board.status === "corrupt") {
		actions.push({ window: "board", action: "restore from checkpoint/backup; do not rebuild empty state" });
	}
	if (scanned.board.status === "missing") {
		actions.push({ window: "board", action: "restore the last committed board before dispatching work" });
	}
	if (scanned.mission.status !== "present") {
		actions.push({ window: "mission", action: "inspect mission.edn; do not create an empty mission" });
	}
	if (scanned.ledger.checkpointStatus !== "present") {
		actions.push({ window: "ledger", action: "read checkpoint.edn; do not replay the whole event ledger" });
	}
	if (scanned.worktree.status === "missing") {
		actions.push({ window: "worktree", action: "inspect the worktree and its retention record before retrying" });
	}
	for (const entry of scanned.worktree.entries ?? []) {
		if (entry.present) continue;
		actions.push({
			window: "worktree",
			action: "inspect the missing worktree and its retention record before retrying",
			sliceId: entry.sliceId,
		});
	}
	if (Array.isArray(scanned.board.outcomeUnknown) && scanned.board.outcomeUnknown.length > 0) {
		actions.push({
			window: "board",
			action: "reconcile :outcome-unknown actions against disk, Git and external services; never replay them",
			actionIds: scanned.board.outcomeUnknown,
		});
	}
	return actions;
}

async function backupPaths(runtime, paths) {
	const backups = [];
	if (typeof runtime.deps.backup === "function") {
		for (const path of paths) {
			try {
				backups.push(await runtime.deps.backup(path));
			} catch {
				// A failed backup is reported by the caller's repair result.
			}
		}
		return backups;
	}
	for (const path of paths) {
		if (!existsSync(path)) continue;
		const target = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
		try {
			copyFileSync(path, target);
			backups.push(target);
		} catch {
			// Leave the original in place; the repair result reports the gap.
		}
	}
	return backups;
}

// ---------------------------------------------------------------------------
// Oracle helpers
// ---------------------------------------------------------------------------

function normalizeFingerprintText(value) {
	return String(value ?? "")
		.normalize("NFKC")
		.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, " ")
		.replace(/\b(?:agent|worker|holder|reviewer|oracle)[-_][A-Za-z0-9-]+\b/gi, " ")
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " ")
		.replace(/(?:\/tmp|\/var\/tmp|\/private\/var\/folders)\/[^\s"'`]+/g, " ")
		.replace(/\b(?:please|again|retry|stuck|frustrated|angry|ugh|fuck|shit|damn)\b/gi, " ")
		.replace(/再试试|没用|烦|气死|重复失败|还是不行/g, " ")
		.replace(/[.,;:!?()[\]{}"'`]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()
		.replace(/\s*\bat\b$/i, "")
		.trim();
}

function isSpecificAdvice(advice) {
	if (typeof advice !== "string") return false;
	const text = advice.trim();
	if (text.length < 8) return false;
	if (/^(再试试|检查一下|retry|try again)[。.!！\s]*$/i.test(text)) return false;
	return (
		/[\w/-]+\.(?:mjs|js|ts|json|edn|md|test\.[a-z]+)\b/.test(text) ||
		/\b(?:interface|hypothesis|scope|abandon|verify|test|command|split|rebase)\b/i.test(text) ||
		/改|拆|先验证|缩小|放弃|接口|假设|命令|测试/.test(text)
	);
}

async function recordOracleSkip(runtime, { taskId, fingerprint, reason }) {
	await runtime.board.store.transaction(async (current) => {
		if (!current) return { board: null, events: [], response: missingBoard(runtime), commit: false };
		const draft = clone(current);
		ensureTenureShape(draft);
		const revivedTaskIds = resolveConditionDraft(
			draft,
			`oracle-budget-exhausted:${fingerprint}`,
			true,
			"runner:oracle",
		);
		draft["board-version"] = (draft["board-version"] ?? 0) + 1;
		const ev = event(draft, "oracle-budget-exhausted", { taskId, fingerprint, reason }, draft["board-version"], {
			turnId: "runner:oracle",
			actorId: null,
		});
		const events = [ev];
		if (revivedTaskIds.length > 0) {
			events.push(
				event(
					draft,
					"condition-resolved",
					{ key: `oracle-budget-exhausted:${fingerprint}`, value: true, revivedTaskIds },
					draft["board-version"],
					{ turnId: "runner:oracle", actorId: null },
				),
			);
		}
		return { board: draft, events, response: { ok: true }, commit: true };
	});
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function attempt(fn) {
	try {
		const result = fn();
		if (result && typeof result.then === "function") {
			return result.catch((error) => failureFrom(error));
		}
		return result;
	} catch (error) {
		return failureFrom(error);
	}
}

function failureFrom(error) {
	if (isHerdError(error)) return { ok: false, error };
	return {
		ok: false,
		error: herdError("INVALID_ARGUMENT", messageOf(error), {
			next: "inspect the runner arguments and the injected ports",
		}),
	};
}

function textOr(value, fallback) {
	return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function clone(value) {
	return value === undefined ? undefined : structuredClone(value);
}
