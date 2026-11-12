/**
 * Slice worktree lifecycle: fork, FIFO join, rebase, fast-forward, abandon,
 * retention and garbage collection.
 *
 * One mission owns one state file under the main workspace:
 *
 *   .herd/missions/<slug>/worktrees.edn
 *
 * The state file records the FIFO queue, every Slice handle and the retention
 * deadline. It never lives inside a Slice worktree. The board, lock, token and
 * event files stay under `.herd/` in the main workspace.
 *
 * Dependency direction:
 *
 *   worktree.mjs -> util/errors, util/atomic-write, util/file-lock, swarm/board
 *
 * The module never imports `runner.mjs`. `forkSlices` only creates worktrees
 * and returns handles; the caller starts each Slice through its runner port.
 * `abandonSlice` may call an optional runner port to retire the Slice agents.
 *
 * Lock order is enforced by construction:
 *
 *   master-integration -> slice writeW -> board
 *
 * The board lock is not taken here; an injected board port owns that short
 * transaction. A board update in this module runs after the write lock is
 * released, never before it.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { EdnKeyword, printUfss, readUfss } from "../clj-sandbox/ufss.mjs";
import { writeFileAtomic } from "../util/atomic-write.mjs";
import { herdError } from "../util/errors.mjs";
import { acquireLock, releaseLock } from "../util/file-lock.mjs";
import { initialBoard } from "./board.mjs";

const execFileAsync = promisify(execFile);

const SLICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const DEFAULT_RETAIN_DAYS = 7;
const DEFAULT_POLL_MS = 50;
const DEFAULT_MAX_REBASE_ROUNDS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const HEX_SHA = /^[0-9a-f]{7,64}$/i;
const RETRY_JOIN = Symbol("retry-join");
const TERMINAL_FAILURES = new Set(["abandoned", "failed", "cancelled"]);
const ACTIVE_STATUSES = new Set(["creating", "running", "reviewing", "swarming", "joining"]);
const QUEUE_STATUSES = new Set(["queued"]);

/**
 * Absolute paths for one Slice.
 *
 * Inputs: repository root, mission slug and Slice id.
 * Output: absolute workspace, branch, control paths and lock paths.
 *
 * The workspace is `.herd-worktrees/<slug>/<slice_id>`, as AGENTS.md §2.5
 * requires. No control file is placed inside it.
 */
export function worktreePaths(root, slug, sliceId) {
	assertRoot(root);
	assertSlug(slug);
	assertSliceId(sliceId);

	const mission = missionPaths(root, slug);
	const absoluteRoot = mission.root;
	const missionDir = mission.missionDir;
	const sliceDir = join(missionDir, "slices", sliceId);
	return {
		root: absoluteRoot,
		slug,
		workspace: join(absoluteRoot, ".herd-worktrees", slug, sliceId),
		branch: `herd/${slug}/${sliceId}`,
		missionDir,
		sliceDir,
		boardPath: join(sliceDir, "board.edn"),
		eventsPath: join(sliceDir, "events.jsonl"),
		missionEventsPath: mission.eventsPath,
		statePath: mission.statePath,
		lockPaths: {
			integration: join(absoluteRoot, ".herd", "locks", "master-integration.lock"),
			writeW: join(absoluteRoot, ".herd", "locks", `${sliceId}.write-w.lock`),
			board: join(absoluteRoot, ".herd", "locks", `${sliceId}.board.lock`),
		},
	};
}

/**
 * Public read-only view of the mission worktree state.
 *
 * Main recovery and the board read this instead of opening `worktrees.edn`
 * themselves. The file remains the only authority; this function returns a
 * normalized copy and never writes or creates a second state.
 *
 * Output:
 * `{exists, slug, path, base, queue, slices, created_at, updated_at}`.
 * `queue` is ordered by its stored FIFO sequence and carries `position`.
 * `slices` is keyed by Slice id and keeps the persisted lifecycle fields with
 * `status` normalized to a bare lowercase string.
 */
export function readWorktreeState({ root, slug }) {
	assertRoot(root);
	assertSlug(slug);
	const paths = missionPaths(root, slug);
	const state = readState(paths.statePath);
	if (state === null) {
		return {
			exists: false,
			slug,
			path: paths.statePath,
			base: null,
			queue: [],
			slices: {},
			created_at: null,
			updated_at: null,
		};
	}
	const queue = [...state.queue]
		.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
		.map((entry, index) => ({ ...entry, position: index + 1 }));
	const slices = {};
	for (const [sliceId, slice] of Object.entries(state.slices)) {
		slices[sliceId] = {
			...slice,
			status: normalizeStatus(slice.status) ?? "unknown",
		};
	}
	return {
		exists: true,
		slug,
		path: paths.statePath,
		base: state.base,
		queue,
		slices,
		created_at: state.created_at,
		updated_at: state.updated_at,
	};
}

function missionPaths(root, slug) {
	const absoluteRoot = resolve(root);
	const missionDir = join(absoluteRoot, ".herd", "missions", slug);
	return {
		root: absoluteRoot,
		slug,
		missionDir,
		eventsPath: join(missionDir, "events.jsonl"),
		statePath: join(missionDir, "worktrees.edn"),
		lockPaths: {
			integration: join(absoluteRoot, ".herd", "locks", "master-integration.lock"),
		},
	};
}

/**
 * Fork every ready Slice into an isolated git worktree.
 *
 * Inputs:
 * - `root`: main workspace.
 * - `slug`: mission slug.
 * - `slices`: SliceSpec array. Each item may carry `slice_id`, `depends_on`,
 *   `status`, `goal`, `done_when` and `mapped_cases`. `owner_paths` is owned
 *   by the S4 design and the join conflict policy; this module never enforces
 *   path ownership.
 * - `base`: commit or branch that new worktrees start from.
 * - `deps`: optional ports (see the port surface below).
 *
 * Output: `SliceHandle[]` for the Slices created by this call. A Slice whose
 * dependencies are not `joined` is not returned. The caller starts each handle
 * through its runner port; this function does not import or start the runner.
 *
 * Safety:
 * - One Slice id maps to exactly one workspace and one branch.
 * - An existing workspace or branch is a conflict, never a reuse.
 * - Resource failure throws `:INSUFFICIENT_WORKTREES` with the number created
 *   and a suggested smaller count. The function never silently reduces `N`.
 */
export async function forkSlices({ root, slug, slices, base, deps = {} }) {
	assertRoot(root);
	assertSlug(slug);
	assertBase(base);
	if (!Array.isArray(slices)) {
		throw invalidArgument("slices", "an array of SliceSpec objects", slices);
	}

	const git = ports(deps).git;
	const clock = ports(deps).clock;
	const now = nowIso(clock);
	const specs = normalizeSlices(slices);
	const specsById = new Map(specs.map((spec) => [spec.sliceId, spec]));
	const paths = missionPaths(root, slug);
	const statePath = paths.statePath;

	await withState(paths, deps, async (state) => {
		state.base = state.base ?? base;
		for (const spec of specs) {
			if (state.slices[spec.sliceId]) continue;
			state.slices[spec.sliceId] = {
				slice_id: spec.sliceId,
				status: spec.status,
				depends_on: [...spec.dependsOn],
				goal: spec.goal,
				created_at: now,
				updated_at: now,
			};
		}
	});

	const initial = readState(statePath);
	if (initial === null) {
		throw missingState(statePath);
	}
	const recoveredHandles = await recoverCreatingSlices({
		root,
		slug,
		paths,
		deps,
		specsById,
		git,
		now,
	});
	const afterRecovery = readState(statePath);
	const readySpecs = specs.filter((spec) => isReady(spec, afterRecovery, specsById));
	const requested = readySpecs.length;
	if (requested === 0) return recoveredHandles;
	const boards = new Map();
	for (const spec of readySpecs) {
		boards.set(spec.sliceId, resolveBoardPort(deps.board, { root, slug, sliceId: spec.sliceId }));
	}

	await checkCapacity(ports(deps), { root, requested });

	const handles = [...recoveredHandles];
	for (const spec of specs) {
		const latest = readState(statePath);
		if (!isReady(spec, latest, specsById)) continue;
		const board = boards.get(spec.sliceId);

		const slicePaths = worktreePaths(root, slug, spec.sliceId);
		const swarmId = `swarm-${randomUUID()}`;
		const reserved = await reserveSlice(paths, deps, spec, slicePaths, swarmId, base, now);
		if (!reserved) continue;

		let created = false;
		try {
			assertFreshTarget(slicePaths, spec.sliceId);
			await assertBranchFresh(git, root, slicePaths.branch, spec.sliceId);
			mkdirSync(dirname(slicePaths.workspace), { recursive: true });
			const add = await runGit(git, root, ["worktree", "add", "-b", slicePaths.branch, slicePaths.workspace, base]);
			if (!add.ok) {
				if (isResourceFailure(add)) {
					throw insufficientWorktrees(root, requested, handles, add);
				}
				throw gitFailure("git worktree add", add, {
					slice_id: spec.sliceId,
					workspace: slicePaths.workspace,
					branch: slicePaths.branch,
				});
			}
			created = true;

			const toplevel = await runGit(git, slicePaths.workspace, ["rev-parse", "--show-toplevel"]);
			if (!toplevel.ok) {
				throw gitFailure("git rev-parse --show-toplevel", toplevel, {
					slice_id: spec.sliceId,
					workspace: slicePaths.workspace,
				});
			}
			assertSamePath(toplevel.stdout.trim(), slicePaths.workspace, spec.sliceId);

			const head = await revParse(git, slicePaths.workspace, "HEAD", spec.sliceId);
			await board.ensureSlice({
				root: paths.root,
				slug,
				sliceId: spec.sliceId,
				spec,
				paths: slicePaths,
				base,
				swarmId,
				now,
			});

			const handle = {
				slice_id: spec.sliceId,
				swarm_id: swarmId,
				workspace: slicePaths.workspace,
				branch: slicePaths.branch,
				base_commit: head,
				board_path: slicePaths.boardPath,
				lock_paths: { ...slicePaths.lockPaths },
			};
			await markSlice(paths, deps, spec.sliceId, {
				status: "running",
				base_commit: head,
				head_commit: head,
				updated_at: nowIso(clock),
			});
			await board.updateStatus({
				root: paths.root,
				slug,
				sliceId: spec.sliceId,
				status: "running",
				swarm_id: swarmId,
				base_commit: head,
			});
			await appendEvent(slicePaths.eventsPath, "slice-forked", {
				slice_id: spec.sliceId,
				workspace: handle.workspace,
				branch: handle.branch,
				base_commit: handle.base_commit,
				swarm_id: swarmId,
				created_at: nowIso(clock),
			});
			handles.push(handle);
		} catch (error) {
			let cleanupOk = true;
			if (created || existsSync(slicePaths.workspace)) {
				cleanupOk = await cleanupFailedWorktree(git, paths.root, slicePaths);
			}
			try {
				await markForkFailure(paths, deps, spec.sliceId, error, cleanupOk);
			} catch {
				// Cleanup must not hide the fork failure that stopped this Slice.
			}
			try {
				if (error && typeof error === "object") {
					error.data = {
						...(error.data ?? {}),
						slice_id: spec.sliceId,
						created: handles.map((handle) => handle.slice_id),
						recoverable: true,
						cleanup_ok: cleanupOk,
					};
				}
			} catch {
				// A frozen error must still reach the caller unchanged.
			}
			throw error;
		}
	}

	return handles;
}

/**
 * Finish a fork that stopped after `git worktree add` but before its state was
 * marked running. A missing workspace is dropped and forked again; an existing
 * workspace is verified and adopted. An unknown shape fails closed.
 */
async function recoverCreatingSlices({ root, slug, paths, deps, git }) {
	const state = readState(paths.statePath);
	if (!state) return [];
	const handles = [];
	for (const slice of Object.values(state.slices)) {
		if (normalizeStatus(slice.status) !== "creating") continue;
		const slicePaths = worktreePaths(root, slug, slice.slice_id);
		if (!existsSync(slicePaths.workspace)) {
			const at = nowIso(ports(deps).clock);
			await markSlice(paths, deps, slice.slice_id, {
				status: "pending",
				last_fork_error: {
					code: ":STALE_CONTROL",
					message: "creating state had no worktree; safe to retry",
					at,
				},
				updated_at: at,
			});
			continue;
		}
		const toplevel = await runGit(git, slicePaths.workspace, ["rev-parse", "--show-toplevel"]);
		if (!toplevel.ok) {
			throw herdError(":STALE_CONTROL", "interrupted worktree is not a git worktree", {
				slice_id: slice.slice_id,
				workspace: slicePaths.workspace,
				next: "inspect the worktree and remove it before retrying fork",
			});
		}
		assertSamePath(toplevel.stdout.trim(), slicePaths.workspace, slice.slice_id);
		const branch = await runGit(git, root, ["show-ref", "--verify", "--quiet", `refs/heads/${slicePaths.branch}`]);
		if (branch.status !== 0) {
			throw herdError(":STALE_CONTROL", "interrupted worktree has no Slice branch", {
				slice_id: slice.slice_id,
				branch: slicePaths.branch,
				next: "inspect the worktree before retrying fork",
			});
		}
		const head = await revParse(git, slicePaths.workspace, "HEAD", slice.slice_id);
		const swarmId = slice.swarm_id ?? `swarm-${randomUUID()}`;
		const board = resolveBoardPort(deps.board, { root, slug, sliceId: slice.slice_id });
		await board.ensureSlice({
			root: paths.root,
			slug,
			sliceId: slice.slice_id,
			spec: slice,
			paths: slicePaths,
			base: state.base,
			swarmId,
			now: nowIso(ports(deps).clock),
		});
		await board.updateStatus({
			root: paths.root,
			slug,
			sliceId: slice.slice_id,
			status: "running",
			swarm_id: swarmId,
			base_commit: head,
		});
		await markSlice(paths, deps, slice.slice_id, {
			status: "running",
			swarm_id: swarmId,
			workspace: slicePaths.workspace,
			branch: slicePaths.branch,
			board_path: slicePaths.boardPath,
			base_commit: head,
			head_commit: head,
			updated_at: nowIso(ports(deps).clock),
		});
		await appendEvent(slicePaths.eventsPath, "slice-fork-recovered", {
			slice_id: slice.slice_id,
			workspace: slicePaths.workspace,
			branch: slicePaths.branch,
			base_commit: head,
			swarm_id: swarmId,
		});
		handles.push({
			slice_id: slice.slice_id,
			swarm_id: swarmId,
			workspace: slicePaths.workspace,
			branch: slicePaths.branch,
			base_commit: head,
			board_path: slicePaths.boardPath,
			lock_paths: { ...slicePaths.lockPaths },
		});
	}
	return handles;
}

/**
 * Put one completed Slice at the tail of the FIFO queue.
 *
 * This is the only supported way for the tenure runner to say "this Slice is
 * ready to join". The call is idempotent for the same report. `report` is the
 * complete Slice report and is stored without truncation.
 *
 * Output: `{ slice_id, position, seq, queued_at }`.
 */
export async function enqueueSlice({ root, slug, sliceId, report, holder, deps = {} }) {
	assertRoot(root);
	assertSlug(slug);
	assertSliceId(sliceId);
	if (typeof report !== "string" || report.length === 0) {
		throw invalidArgument("report", "the complete non-empty Slice report", report);
	}
	const board = resolveBoardPort(ports(deps).board, { root, slug, sliceId });
	const paths = worktreePaths(root, slug, sliceId);
	if (readState(paths.statePath) === null) {
		throw missingState(paths.statePath);
	}
	return withState(
		paths,
		deps,
		async (state) => {
			const slice = state.slices[sliceId];
			if (!slice) {
				throw invalidArgument("sliceId", "a Slice created by forkSlices", sliceId);
			}
			if (slice.status === "joined" || slice.status === "abandoned") {
				throw herdError(":STALE_CONTROL", "Slice is already terminal", {
					slice_id: sliceId,
					current: slice.status,
					next: "start a new Slice instead of re-queueing this one",
				});
			}
			if (slice.status === "creating") {
				throw herdError(":STALE_CONTROL", "Slice fork has not finished", {
					slice_id: sliceId,
					current: slice.status,
					next: "wait for forkSlices to return the handle before queueing the result",
				});
			}
			const status = normalizeStatus(slice.status);
			if (!["running", "reviewing", "swarming", "queued"].includes(status)) {
				throw herdError(":STALE_CONTROL", "Slice is not active", {
					slice_id: sliceId,
					current: slice.status,
					next: "fork the Slice before queueing its completion report",
				});
			}
			const existing = state.queue.find((entry) => entry.slice_id === sliceId);
			if (existing) {
				if (existing.report !== report) {
					throw herdError(":STALE_CONTROL", "Slice was queued with another report", {
						slice_id: sliceId,
						queued_at: existing.queued_at,
						next: "join the queued report or fork a new Slice",
					});
				}
				return {
					slice_id: sliceId,
					position: state.queue.indexOf(existing) + 1,
					seq: existing.seq,
					queued_at: existing.queued_at,
				};
			}

			const seq = state.next_seq;
			state.next_seq += 1;
			const entry = {
				slice_id: sliceId,
				seq,
				queued_at: nowIso(ports(deps).clock),
				report,
				holder: normalizeHolder(holder),
			};
			state.queue.push(entry);
			slice.status = "queued";
			slice.queued_at = entry.queued_at;
			slice.holder = entry.holder;
			slice.updated_at = entry.queued_at;
			await board.updateStatus({
				root: paths.root,
				slug,
				sliceId,
				status: "queued",
				queue_seq: seq,
				queued_at: entry.queued_at,
			});
			await appendEvent(paths.eventsPath, "slice-queued", {
				slice_id: sliceId,
				queue_position: state.queue.length,
				seq,
				queued_at: entry.queued_at,
			});
			return { slice_id: sliceId, position: state.queue.length, seq, queued_at: entry.queued_at };
		},
		{ create: false },
	);
}

/**
 * Join the FIFO queue head into the main branch.
 *
 * The call blocks while the queue is empty but a Slice is still active. It
 * returns `{status:"none"}` when the queue is empty and no Slice is active.
 * It throws `:NO_RESULTS` when every Slice ended in failure and nothing joined.
 *
 * The join holds `.herd/locks/master-integration.lock` while it rebases and
 * fast-forwards. The worktree is never merged through another path.
 *
 * Output on success:
 * `{ slice_id, workspace, report, ff_commit, rebase_rounds, queue_position }`.
 */
export async function joinSlice({ root, slug, signal, deps = {} }) {
	assertRoot(root);
	assertSlug(slug);
	if (!deps.board) {
		throw boardMismatch(["ensureSlice", "updateStatus", "assertHolder"]);
	}
	const portsValue = ports(deps);
	const paths = missionPaths(root, slug);
	const pollMs = pollInterval(deps);

	for (;;) {
		throwIfAborted(signal);
		const current = readState(paths.statePath);
		if (current === null) return noneResult();

		if (current.queue.length > 0) {
			return joinHead({ root: paths.root, slug, signal, deps, paths });
		}

		const interrupted = Object.values(current.slices).filter((slice) => {
			const status = normalizeStatus(slice.status);
			return status === "creating" || status === "joining";
		});
		if (interrupted.length > 0) {
			throw herdError(":STALE_CONTROL", "interrupted Slice lifecycle needs recovery", {
				slices: interrupted.map((slice) => ({
					slice_id: slice.slice_id,
					status: slice.status,
				})),
				next: "call forkSlices for a creating Slice; inspect the worktree/rebase state for a joining Slice",
			});
		}
		const missing = Object.values(current.slices).filter((slice) => {
			const status = normalizeStatus(slice.status);
			return (status === "running" || status === "reviewing" || status === "swarming") && !existsSync(slice.workspace);
		});
		if (missing.length > 0) {
			throw herdError(":STALE_CONTROL", "active Slice worktree is missing", {
				slices: missing.map((slice) => ({
					slice_id: slice.slice_id,
					workspace: slice.workspace,
				})),
				next: "run /herd-recovery; do not treat a missing worktree as a completed Slice",
			});
		}

		const statuses = effectiveStatuses(current);
		if (hasActive(statuses)) {
			const stranded = statuses.filter((entry) => entry.status === "queued");
			if (stranded.length > 0) {
				throw herdError(":STALE_CONTROL", "queued Slice is missing from the FIFO queue", {
					slices: stranded,
					next: "inspect the worktree state and the completion report before continuing",
				});
			}
			await portsValue.waitForChange({ root: paths.root, slug, signal, pollMs });
			continue;
		}
		if (allFailed(statuses)) {
			throw herdError(":NO_RESULTS", "all Slices ended without a result", {
				slug,
				slices: statuses.map((entry) => ({ slice_id: entry.slice_id, status: entry.status })),
				next: "Coordinator must choose re-fork, re-plan or stop and report lessons",
			});
		}
		return noneResult();
	}
}

/**
 * Abandon one Slice and keep its worktree for the retention window.
 *
 * Only the Slice Holder may call this. The caller passes `actor` and either a
 * board port with `assertHolder` or an explicit `authorizeAbandon` port.
 * Without a verifier the call fails closed with `:CAPABILITY_DENIED`.
 *
 * Output: `{ slice_id, status:"abandoned", reason, workspace, retain_until }`.
 */
export async function abandonSlice({ root, slug, sliceId, reason, actor, deps = {} }) {
	assertRoot(root);
	assertSlug(slug);
	assertSliceId(sliceId);
	if (typeof reason !== "string" || reason.trim().length === 0) {
		throw invalidArgument("reason", "a non-empty, checkable reason", reason);
	}

	const paths = worktreePaths(root, slug, sliceId);
	const board = resolveBoardPort(deps.board, { root, slug, sliceId });
	const portsValue = { ...ports(deps), board };
	if (readState(paths.statePath) === null) {
		throw missingState(paths.statePath);
	}
	const integration = await acquireWithWait(
		portsValue.lock,
		paths.lockPaths.integration,
		lockMeta("integration", sliceId, actor, "abandon"),
		deps,
		undefined,
	);
	try {
		await authorizeAbandon(portsValue, {
			root: paths.root,
			slug,
			sliceId,
			reason,
			actor,
			deps,
		});
		return await withState(
			paths,
			deps,
			async (state) => {
				const slice = state.slices[sliceId];
				if (!slice) throw invalidArgument("sliceId", "a Slice created by forkSlices", sliceId);
				if (slice.status === "pending" || slice.status === "creating") {
					throw herdError(":STALE_CONTROL", "Slice has no active worktree to abandon", {
						slice_id: sliceId,
						current: slice.status,
						next: "fork the Slice before abandoning it, or remove it from the mission plan",
					});
				}
				if (slice.status === "joined") {
					throw herdError(":STALE_CONTROL", "Slice already joined; it cannot be abandoned", {
						slice_id: sliceId,
						current: slice.status,
						next: "use a new repair Slice",
					});
				}
				if (slice.status === "abandoned") {
					state.queue = state.queue.filter((entry) => entry.slice_id !== sliceId);
					return {
						slice_id: sliceId,
						status: "abandoned",
						reason: slice.abandon_reason ?? reason,
						workspace: slice.workspace,
						retain_until: slice.retain_until ?? null,
						already: true,
					};
				}

				const now = nowIso(portsValue.clock);
				const retainUntil = retentionDeadline(now, DEFAULT_RETAIN_DAYS);
				state.queue = state.queue.filter((entry) => entry.slice_id !== sliceId);
				slice.status = "abandoned";
				slice.abandon_reason = reason;
				slice.abandoned_at = now;
				slice.retain_until = retainUntil;
				slice.updated_at = now;
				slice.agent_retired = await retireRunner(portsValue, {
					root: paths.root,
					slug,
					sliceId,
					reason,
					actor,
				});
				await portsValue.board.updateStatus({
					root: paths.root,
					slug,
					sliceId,
					status: "abandoned",
					reason,
					abandoned_at: now,
					retain_until: retainUntil,
				});
				await appendEvent(paths.eventsPath, "slice-abandoned", {
					slice_id: sliceId,
					reason,
					workspace: slice.workspace,
					retain_until: retainUntil,
					actor: normalizeHolder(actor),
				});
				return {
					slice_id: sliceId,
					status: "abandoned",
					reason,
					workspace: slice.workspace,
					retain_until: retainUntil,
				};
			},
			{ create: false, commitOnError: true },
		);
	} finally {
		release(portsValue.lock, integration);
	}
}

/**
 * Remove worktrees whose retention window ended.
 *
 * Inputs: `retainDays` (default 7), an optional clock and git port.
 * Output: `{ removed, retained, skipped }`.
 *
 * A queued, joining or running Slice is never removed. An event is appended
 * before the first deletion. A worktree already missing from disk is recorded
 * as removed only after its git registration is pruned.
 */
export async function gcWorktrees({ root, slug, retainDays = DEFAULT_RETAIN_DAYS, deps = {} }) {
	assertRoot(root);
	assertSlug(slug);
	assertRetainDays(retainDays);
	const portsValue = ports(deps);
	const paths = missionPaths(root, slug);
	if (readState(paths.statePath) === null) {
		return { removed: [], retained: [], skipped: [] };
	}
	const integration = await acquireWithWait(
		portsValue.lock,
		paths.lockPaths.integration,
		lockMeta("integration", "gc", { agent_id: "worktree-gc" }, "gc"),
		deps,
		undefined,
	);
	try {
		return await withState(
			paths,
			deps,
			async (state) => {
				const now = nowIso(portsValue.clock);
				const removed = [];
				const retained = [];
				const skipped = [];

				for (const slice of Object.values(state.slices)) {
					if (slice.status !== "joined" && slice.status !== "abandoned" && slice.status !== "failed") {
						continue;
					}
					if (slice.worktree_removed_at) {
						skipped.push({ slice_id: slice.slice_id, reason: "already-collected" });
						continue;
					}
					const endedAt = slice.joined_at ?? slice.abandoned_at ?? slice.failed_at;
					if (!endedAt) {
						skipped.push({ slice_id: slice.slice_id, reason: "missing-end-time" });
						continue;
					}
					const deadline = retentionDeadline(endedAt, retainDays);
					if (Date.parse(now) < Date.parse(deadline)) {
						retained.push({
							slice_id: slice.slice_id,
							status: slice.status,
							retain_until: deadline,
						});
						continue;
					}

					await appendEvent(
						paths.eventsPath,
						"worktree-gc-started",
						{
							slice_id: slice.slice_id,
							workspace: slice.workspace,
							status: slice.status,
							retain_until: deadline,
						},
						{ required: true },
					);
					const removedResult = await runGit(portsValue.git, paths.root, [
						"worktree",
						"remove",
						"--force",
						slice.workspace,
					]);
					const stillExists = existsSync(slice.workspace);
					if (!removedResult.ok && stillExists) {
						skipped.push({
							slice_id: slice.slice_id,
							reason: "git-worktree-remove-failed",
							stderr: removedResult.stderr.trim(),
						});
						continue;
					}
					await runGit(portsValue.git, paths.root, ["worktree", "prune"]);
					slice.worktree_removed_at = now;
					slice.updated_at = now;
					await appendEvent(paths.eventsPath, "worktree-gc-done", {
						slice_id: slice.slice_id,
						workspace: slice.workspace,
						removed_at: now,
					});
					removed.push({ slice_id: slice.slice_id, workspace: slice.workspace });
				}

				return { removed, retained, skipped };
			},
			{ create: false },
		);
	} finally {
		release(portsValue.lock, integration);
	}
}

// ---------------------------------------------------------------------------
// Join internals
// ---------------------------------------------------------------------------

async function joinHead({ root, slug, signal, deps, paths }) {
	const portsValue = ports(deps);
	const integration = await acquireWithWait(
		portsValue.lock,
		paths.lockPaths.integration,
		lockMeta("integration", "join", { agent_id: deps.agentId ?? "coordinator" }, "join"),
		deps,
		signal,
	);
	try {
		if (readState(paths.statePath) === null) {
			throw missingState(paths.statePath);
		}
		for (;;) {
			const outcome = await withState(
				paths,
				deps,
				async (state) => {
					const entry = state.queue[0];
					if (!entry) return noneResult();
					const slice = state.slices[entry.slice_id];
					if (!slice) {
						throw herdError(":STALE_CONTROL", "queue names an unknown Slice", {
							slice_id: entry.slice_id,
							next: "inspect .herd/missions state before joining",
						});
					}
					if (slice.status === "joined" || slice.status === "abandoned") {
						state.queue.shift();
						return RETRY_JOIN;
					}
					const board = resolveBoardPort(deps.board, {
						root,
						slug,
						sliceId: slice.slice_id,
					});
					if (typeof entry.report !== "string" || entry.report.length === 0) {
						throw invalidArgument("report", "a complete non-empty report before joining", entry.report);
					}

					const queuePosition = 1;
					slice.status = "joining";
					slice.updated_at = nowIso(portsValue.clock);
					await board.updateStatus({
						root: paths.root,
						slug,
						sliceId: slice.slice_id,
						status: "joining",
						queue_position: queuePosition,
					});

					try {
						await assertMergeTarget(portsValue.git, root, state.base, slice.slice_id);
						const alignment = await alignBase({
							state,
							root,
							slice,
							entry,
							deps,
							portsValue,
							board,
							signal,
							slug,
						});
						if (alignment.abandoned) {
							return {
								slice_id: slice.slice_id,
								status: "abandoned",
								reason: slice.abandon_reason,
								workspace: slice.workspace,
								retain_until: slice.retain_until,
							};
						}
						const rebaseRounds = alignment.rounds;

						const head = await revParse(portsValue.git, slice.workspace, "HEAD", slice.slice_id);
						const base = await revParse(portsValue.git, root, `${state.base}^{commit}`, slice.slice_id);
						if (!(await isAncestor(portsValue.git, root, base, head))) {
							throw herdError(":FF_NOT_READY", "Slice is not aligned with the base", {
								slice_id: slice.slice_id,
								base,
								head,
								rebase_rounds: rebaseRounds,
								next: "rebase the Slice worktree onto the latest base and retry join",
							});
						}
						await assertMergeTarget(portsValue.git, root, state.base, slice.slice_id);
						const changed = await runGit(portsValue.git, root, ["diff", "--name-only", base, head]);
						const changedFiles = changed.ok
							? changed.stdout
									.split("\n")
									.map((line) => line.trim())
									.filter(Boolean)
							: [];
						const diffStat = await runGit(portsValue.git, root, ["diff", "--stat", base, head]);
						const merge = await runGit(portsValue.git, root, ["merge", "--ff-only", head], signal);
						if (!merge.ok) {
							throw gitFailure("git merge --ff-only", merge, {
								slice_id: slice.slice_id,
								base,
								head,
								rebase_rounds: rebaseRounds,
								next: "advance the base with a fast-forward only; never force a merge",
							});
						}
						const ffCommit = await revParse(portsValue.git, root, "HEAD", slice.slice_id);
						const finishedAt = nowIso(portsValue.clock);
						state.queue.shift();
						slice.status = "joined";
						slice.head_commit = head;
						slice.base_commit = base;
						slice.ff_commit = ffCommit;
						slice.rebase_rounds = rebaseRounds;
						slice.rebase_in_progress = false;
						delete slice.last_conflict_paths;
						slice.joined_at = finishedAt;
						slice.retain_until = retentionDeadline(finishedAt, DEFAULT_RETAIN_DAYS);
						slice.updated_at = finishedAt;
						await board.updateStatus({
							root: paths.root,
							slug,
							sliceId: slice.slice_id,
							status: "joined",
							ff_commit: ffCommit,
							rebase_rounds: rebaseRounds,
							joined_at: finishedAt,
							retain_until: slice.retain_until,
						});
						await appendEvent(worktreePaths(root, slug, slice.slice_id).eventsPath, "slice-joined", {
							slice_id: slice.slice_id,
							base_commit: base,
							head_commit: head,
							ff_commit: ffCommit,
							rebase_rounds: rebaseRounds,
							queue_position: queuePosition,
							joined_at: finishedAt,
							changed_files: changedFiles,
							diff_stat: diffStat.ok ? diffStat.stdout.trim() : "",
						});
						return {
							slice_id: slice.slice_id,
							workspace: slice.workspace,
							report: entry.report,
							ff_commit: ffCommit,
							rebase_rounds: rebaseRounds,
							queue_position: queuePosition,
						};
					} catch (error) {
						if (slice.status === "joining") {
							slice.status = "queued";
							slice.updated_at = nowIso(portsValue.clock);
						}
						throw error;
					}
				},
				{ create: false, commitOnError: true },
			);
			if (outcome !== RETRY_JOIN) return outcome;
		}
	} finally {
		release(portsValue.lock, integration);
	}
}

/**
 * Rebase one Slice until the base is an ancestor of its HEAD.
 *
 * Returns `{rounds, abandoned}`. `rounds` counts rebase attempts; `abandoned`
 * is true when the conflict policy chose abandonment. The caller holds the
 * integration lock and must not take it again.
 */
async function alignBase({ state, root, slice, entry, deps, portsValue, board, signal, slug }) {
	let rounds = 0;
	const maxRounds = positiveInteger(deps.maxRebaseRounds, DEFAULT_MAX_REBASE_ROUNDS);

	for (;;) {
		throwIfAborted(signal);
		const base = await revParse(portsValue.git, root, `${state.base}^{commit}`, slug);
		const head = await revParse(portsValue.git, slice.workspace, "HEAD", slug);
		if (await isAncestor(portsValue.git, root, base, head)) {
			return { rounds, abandoned: false };
		}
		if (rounds >= maxRounds) {
			throw herdError(":FF_NOT_READY", "rebase did not converge", {
				slice_id: slice.slice_id,
				base,
				head,
				rebase_rounds: rounds,
				max_rebase_rounds: maxRounds,
				next: "inspect the Slice branch or abandon it with evidence",
			});
		}

		const writePath = worktreePaths(root, slug, slice.slice_id).lockPaths.writeW;
		const write = await acquireWithWait(
			portsValue.lock,
			writePath,
			lockMeta("writeW", slice.slice_id, entry.holder ?? { agent_id: "join" }, "rebase"),
			deps,
			signal,
		);
		let rebase;
		let conflictedPaths = [];
		let rebaseInProgress = false;
		try {
			rebase = await runGit(portsValue.git, slice.workspace, ["rebase", base], signal);
			if (!rebase.ok) {
				const conflicts = await runGit(
					portsValue.git,
					slice.workspace,
					["diff", "--name-only", "--diff-filter=U"],
					signal,
				);
				conflictedPaths = conflicts.ok
					? conflicts.stdout
							.split("\n")
							.map((line) => line.trim())
							.filter(Boolean)
					: [];
				rebaseInProgress = await isRebaseInProgress(portsValue.git, slice.workspace);
			}
		} finally {
			release(portsValue.lock, write);
		}
		rounds += 1;
		if (rebase.ok) continue;
		const scenePreserved = rebaseInProgress || conflictedPaths.length > 0;
		if (!scenePreserved) {
			throw herdError(":FF_NOT_READY", "git rebase failed without a conflict scene", {
				slice_id: slice.slice_id,
				base,
				head,
				rebase_rounds: rounds,
				stderr: rebase.stderr.trim(),
				next: "inspect the worktree; no rebase conflict was preserved to resolve",
			});
		}

		const policy = await decideConflict(portsValue, {
			root,
			slug,
			slice,
			entry,
			round: rounds,
			conflictedPaths,
			rebaseInProgress,
			stderr: rebase.stderr,
		});
		if (policy.action === "abandon") {
			const reason = policy.reason
				? `${policy.reason} (rebase conflict: ${conflictedPaths.join(", ") || "unknown"})`
				: `rebase conflict cannot be resolved: ${conflictedPaths.join(", ") || "unknown"}`;
			const now = nowIso(portsValue.clock);
			const retainUntil = retentionDeadline(now, DEFAULT_RETAIN_DAYS);
			state.queue = state.queue.filter((item) => item.slice_id !== slice.slice_id);
			const stored = state.slices[slice.slice_id];
			stored.status = "abandoned";
			stored.abandon_reason = reason;
			stored.abandoned_at = now;
			stored.rebase_rounds = rounds;
			stored.rebase_in_progress = scenePreserved;
			stored.retain_until = retainUntil;
			stored.updated_at = now;
			stored.agent_retired = await retireRunner(portsValue, {
				root,
				slug,
				sliceId: slice.slice_id,
				reason,
				actor: entry.holder,
			});
			await board.updateStatus({
				root,
				slug,
				sliceId: slice.slice_id,
				status: "abandoned",
				reason,
				abandoned_at: now,
				retain_until: retainUntil,
			});
			await appendEvent(worktreePaths(root, slug, slice.slice_id).eventsPath, "slice-abandoned", {
				slice_id: slice.slice_id,
				reason,
				rebase_conflicts: conflictedPaths,
				rebase_in_progress: scenePreserved,
				retain_until: retainUntil,
			});
			slice.abandon_reason = reason;
			slice.abandoned_at = now;
			slice.retain_until = retainUntil;
			return { rounds, abandoned: true };
		}

		slice.last_conflict_paths = conflictedPaths;
		slice.rebase_rounds = rounds;
		slice.rebase_in_progress = scenePreserved;
		throw herdError(":FF_NOT_READY", "rebase conflict stops the join", {
			slice_id: slice.slice_id,
			base,
			head,
			conflicted_paths: conflictedPaths,
			rebase_rounds: rounds,
			rebase_in_progress: scenePreserved,
			next: "Holder resolves the preserved scene inside the Slice worktree or calls abandonSlice with evidence",
		});
	}
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * Port surface.
 *
 * - `git.run({cwd,args}) -> {ok,status,stdout,stderr}`
 * - `board.ensureSlice(info)`
 * - `board.updateStatus(info)`
 * - `board.assertHolder(info) -> boolean`
 * - `lock.acquire(path,meta) -> {ok,handle,busy}` / `lock.release(handle)`
 * - `runner.retireSlice({root,slug,sliceId,reason,actor})`
 * - `conflictPolicy(info) -> {action:"report"|"abandon", reason?}`
 * - `waitForChange({root,slug,signal,pollMs})`
 * - `capacity({root,requested}) -> {ok,available?}`
 * - `clock.now() -> Date|number`
 *
 * The board port is required for every lifecycle operation. It is the
 * persistent control store, not a best-effort status mirror. A caller that
 * cannot supply all four board methods fails closed instead of silently
 * dropping lifecycle state.
 */
function ports(deps) {
	return {
		git: deps.git ?? { run: defaultGitPort },
		board: deps.board ?? null,
		lock: deps.lock ?? { acquire: acquireLock, release: releaseLock },
		runner: deps.runner ?? null,
		conflictPolicy: deps.conflictPolicy ?? (() => ({ action: "report" })),
		waitForChange: deps.waitForChange ?? defaultWaitForChange,
		capacity: deps.capacity ?? null,
		clock: deps.clock ?? { now: () => new Date() },
	};
}

function resolveBoardPort(board, info = {}) {
	if (typeof board === "function") {
		return resolveBoardPort(board(info), info);
	}
	if (board && typeof board === "object") {
		if (typeof board.ensureSlice === "function") {
			const missing = ["updateStatus", "assertHolder"].filter((name) => typeof board[name] !== "function");
			if (missing.length === 0) return board;
			throw boardMismatch(missing);
		}
		for (const method of ["forSlice", "openSlice", "open"]) {
			if (typeof board[method] === "function") {
				return resolveBoardPort(board[method](info.sliceId), info);
			}
		}
		if (
			board.store &&
			typeof board.store.read === "function" &&
			typeof board.store.initialize === "function" &&
			typeof board.store.transaction === "function"
		) {
			assertHandleSlice(board, info.sliceId);
			return adaptOpenBoardHandle(board);
		}
	}
	throw boardMismatch(["ensureSlice", "updateStatus", "assertHolder"]);
}

function boardMismatch(missing) {
	return herdError(":HOST_API_MISMATCH", "a durable board port is required", {
		port: "board",
		missing,
		expected: "ensureSlice, updateStatus and assertHolder, or an openBoard handle with a durable store",
		next: "inject src/swarm/board.mjs openBoard(...) or an equivalent durable board port; never use an empty status sink",
	});
}

/**
 * Adapt a swarm/board.mjs openBoard handle. The board store is the durable
 * control store. Slice lifecycle fields live under the board's `:slice` map so
 * they are written by the same lock/atomic/checkpoint path as tasks and tokens.
 */
function adaptOpenBoardHandle(handle) {
	return {
		board_path: handle.boardPath,
		slice_id: handle.sliceId,
		async ensureSlice(info) {
			assertHandleSlice(handle, info.sliceId);
			const current = await handle.store.read();
			if (current === null) {
				// `initialize` refuses a corrupt board and never overwrites it.
				await handle.store.initialize(initialBoard());
			}
			return handle;
		},
		async updateStatus(info) {
			assertHandleSlice(handle, info.sliceId);
			const receipt = await handle.store.transaction(async (current) => {
				if (!current) {
					throw herdError(":STALE_CONTROL", "Slice board is missing", {
						boardPath: handle.boardPath,
						next: "forkSlices must seed the board before status updates",
					});
				}
				const slice = {
					...(current.slice ?? {}),
					"slice-id": info.sliceId,
					status: info.status,
				};
				for (const [key, value] of Object.entries(info)) {
					if (value === undefined) continue;
					if (key === "root" || key === "slug" || key === "sliceId") continue;
					slice[snakeToKebab(key)] = value;
				}
				const next = {
					...current,
					slice,
					"board-version": (current["board-version"] ?? 0) + 1,
				};
				return { board: next, events: [], response: { ok: true }, commit: true };
			});
			if (receipt?.ok === false) {
				throw herdError(":STALE_CONTROL", "board status update was rejected", {
					boardPath: handle.boardPath,
					receipt,
				});
			}
		},
		async assertHolder({ sliceId, actor }) {
			assertHandleSlice(handle, sliceId);
			if (!actor || (actor.role && actor.role !== "holder")) return false;
			const agentId = actor.agent_id ?? actor.agentId;
			const termId = actor.term_id ?? actor.termId;
			const current = await handle.store.read();
			if (!current) return false;
			const token = current["token-slot"] ?? {};
			if (token["holder-id"] !== agentId || token.state !== "held") return false;
			if (termId && token["term-id"] && token["term-id"] !== termId) return false;
			const boardActor = current.actors?.[agentId];
			return boardActor ? boardActor["life-state"] === "alive" : true;
		},
	};
}

function assertHandleSlice(handle, sliceId) {
	if (sliceId && String(sliceId) !== handle.sliceId) {
		throw herdError(":HOST_API_MISMATCH", "board handle belongs to another Slice", {
			expected: handle.sliceId,
			actual: sliceId,
			next: "inject a mission-level board port or one openBoard handle per Slice",
		});
	}
}

async function defaultWaitForChange({ signal, pollMs }) {
	await sleep(pollMs, signal);
}

async function checkCapacity(portsValue, info) {
	if (!portsValue.capacity) return;
	const result = await portsValue.capacity(info);
	if (result && result.ok === false) {
		const available = Number.isInteger(result.available) ? result.available : 0;
		throw herdError(":INSUFFICIENT_WORKTREES", "not enough worktree capacity", {
			requested: info.requested,
			available,
			suggested: Math.max(0, Math.min(info.requested, available)),
			recoverable: true,
			next: "retry forkSlices with at most the suggested number of Slices",
		});
	}
}

async function decideConflict(portsValue, info) {
	const decision = await portsValue.conflictPolicy(info);
	if (decision?.action !== "abandon") return { action: "report" };
	return {
		action: "abandon",
		reason: typeof decision.reason === "string" ? decision.reason : "",
	};
}

async function retireRunner(portsValue, info) {
	if (!portsValue.runner) return false;
	const retire = portsValue.runner.retireSlice ?? portsValue.runner.abandon ?? portsValue.runner.cancelSlice;
	if (typeof retire !== "function") return false;
	const result = await retire(info);
	return result !== false;
}

async function authorizeAbandon(portsValue, info) {
	if (!info.actor || (!info.actor.agent_id && !info.actor.agentId)) {
		throw capabilityDenied(info);
	}
	if (info.actor?.role && info.actor.role !== "holder") {
		throw capabilityDenied(info);
	}
	if (typeof info.deps.authorizeAbandon === "function") {
		const allowed = await info.deps.authorizeAbandon(info);
		if (allowed !== true) throw capabilityDenied(info);
		return;
	}
	if (typeof portsValue.board.assertHolder === "function") {
		const allowed = await portsValue.board.assertHolder(info);
		if (allowed === true) return;
	}
	throw capabilityDenied(info);
}

function capabilityDenied({ slug, sliceId, actor }) {
	return herdError(":CAPABILITY_DENIED", "only the Slice Holder may abandon it", {
		slug,
		slice_id: sliceId,
		actor: normalizeHolder(actor),
		next: "call abandonSlice as the current Holder or inject a board.assertHolder port",
	});
}

// ---------------------------------------------------------------------------
// Default git port
// ---------------------------------------------------------------------------

async function defaultGitPort({ cwd, args, signal }) {
	try {
		const result = await execFileAsync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
			timeout: 120_000,
			env: process.env,
			signal,
		});
		return {
			ok: true,
			status: 0,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			args,
			cwd,
		};
	} catch (error) {
		if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
			throw herdError(":UPSTREAM_ABORTED", "git command was aborted", {
				cwd,
				args,
				next: "stop the join and keep the worktree for recovery",
			});
		}
		if (error?.code === "ENOENT") {
			throw herdError(":INVALID_ARGUMENT", "git failed to start", {
				cwd,
				args,
				system_code: error.code ?? null,
				message: error.message,
				next: "verify that git is installed and the workspace exists",
			});
		}
		return {
			ok: false,
			status: typeof error?.code === "number" ? error.code : null,
			stdout: error?.stdout ?? "",
			stderr: error?.stderr ?? String(error?.message ?? error),
			args,
			cwd,
		};
	}
}

async function runGit(git, cwd, args, signal) {
	return git.run({ cwd, args, signal });
}

async function revParse(git, cwd, ref, sliceId) {
	const result = await runGit(git, cwd, ["rev-parse", ref]);
	if (!result.ok) {
		throw gitFailure("git rev-parse", result, { slice_id: sliceId, ref });
	}
	const value = result.stdout.trim();
	if (!HEX_SHA.test(value)) {
		throw herdError(":INVALID_ARGUMENT", "git rev-parse returned an unexpected value", {
			slice_id: sliceId,
			ref,
			actual: value,
			next: "check the base ref and worktree HEAD",
		});
	}
	return value;
}

async function isAncestor(git, cwd, ancestor, descendant) {
	const result = await runGit(git, cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
	if (result.status === 0) return true;
	if (result.status === 1) return false;
	throw gitFailure("git merge-base --is-ancestor", result, { ancestor, descendant });
}

async function isRebaseInProgress(git, workspace) {
	for (const name of ["rebase-merge", "rebase-apply"]) {
		const result = await runGit(git, workspace, ["rev-parse", "--git-path", name]);
		if (!result.ok) continue;
		const path = result.stdout.trim();
		if (path && existsSync(resolve(workspace, path))) return true;
	}
	return false;
}

async function assertBranchFresh(git, root, branch, sliceId) {
	const result = await runGit(git, root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
	if (result.status === 0) {
		throw herdError(":NAME_TAKEN", "Slice branch already exists", {
			slice_id: sliceId,
			branch,
			next: "inspect the old branch; never reuse it for another Slice",
		});
	}
	if (result.status !== 1) {
		throw gitFailure("git show-ref --verify", result, { slice_id: sliceId, branch });
	}
}

async function assertMergeTarget(git, root, base, sliceId) {
	if (HEX_SHA.test(base)) return;
	const current = await runGit(git, root, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!current.ok) return;
	const branch = current.stdout.trim();
	const expected = base.startsWith("refs/heads/") ? base.slice("refs/heads/".length) : base;
	if (branch !== expected) {
		throw herdError(":FF_NOT_READY", "main workspace is not on the integration base", {
			slice_id: sliceId,
			expected,
			current: branch,
			next: "check out the integration branch before joining; never merge into another branch",
		});
	}
}

function gitFailure(command, result, data) {
	return herdError(":FF_NOT_READY", `${command} failed`, {
		...data,
		command,
		exit_code: result.status,
		stdout: result.stdout?.trim() ?? "",
		stderr: result.stderr?.trim() ?? "",
		next: "inspect the git state; never force a merge or rewrite a shared branch",
	});
}

function isResourceFailure(result) {
	const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	return /no space left|disk quota|too many open files|cannot allocate memory|enospc|emfile|enomem|unable to create|worktree.*could not be created/i.test(
		text,
	);
}

function insufficientWorktrees(root, requested, created, result) {
	return herdError(":INSUFFICIENT_WORKTREES", "not enough worktree capacity", {
		root,
		requested,
		created: created.map((handle) => handle.slice_id),
		suggested: created.length,
		recoverable: true,
		stdout: result.stdout?.trim() ?? "",
		stderr: result.stderr?.trim() ?? "",
		next: "retry with at most the suggested number of Slices; never reuse a worktree",
	});
}

async function cleanupFailedWorktree(git, root, paths) {
	if (!existsSync(paths.workspace)) return true;
	await runGit(git, root, ["worktree", "remove", "--force", paths.workspace]);
	const branch = await runGit(git, root, ["branch", "-D", paths.branch]);
	await runGit(git, root, ["worktree", "prune"]);
	if (existsSync(paths.workspace)) return false;
	return branch.ok || /not found/i.test(branch.stderr);
}

async function markForkFailure(paths, deps, sliceId, error, cleanupOk) {
	return withState(
		paths,
		deps,
		async (state) => {
			const slice = state.slices[sliceId];
			if (!slice) return;
			const at = nowIso(ports(deps).clock);
			slice.status = cleanupOk ? "pending" : "failed";
			slice.last_fork_error = {
				code: error?.code ?? null,
				message: error?.message ?? String(error),
				at,
			};
			slice.updated_at = at;
			if (!cleanupOk) {
				slice.failure_reason = "fork cleanup left a worktree or branch behind";
				slice.failed_at = at;
			}
		},
		{ create: false },
	);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const stateTails = new Map();

function createState(slug, base, now) {
	return {
		version: 1,
		slug,
		base,
		queue: [],
		next_seq: 1,
		slices: {},
		created_at: now,
		updated_at: now,
	};
}

function readState(path) {
	const legacy = path.endsWith(".edn") ? `${path.slice(0, -4)}.json` : null;
	if (legacy && !existsSync(path) && existsSync(legacy)) {
		throw herdError(":STALE_CONTROL", "legacy JSON worktree state exists", {
			path: legacy,
			expected: path,
			next: "migrate the legacy state to EDN; do not start a second empty state",
		});
	}
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw herdError(":STALE_CONTROL", "cannot read worktree state", {
			path,
			system_code: error?.code ?? null,
			next: "inspect permissions and the recovery window before continuing",
		});
	}
	try {
		const value = fromStateEdn(readUfss(text));
		if (
			!value ||
			typeof value !== "object" ||
			!Array.isArray(value.queue) ||
			!value.slices ||
			typeof value.slices !== "object" ||
			!Number.isInteger(value.next_seq)
		) {
			throw new Error("missing queue, slices or next_seq");
		}
		return value;
	} catch (error) {
		throw herdError(
			":STALE_CONTROL",
			"worktree state is not valid EDN",
			{
				path,
				message: error.message,
				line: error.line ?? null,
				column: error.column ?? null,
				next: "back up the state file and recover it; do not rebuild an empty mission",
			},
			error,
		);
	}
}

function missingState(path) {
	return herdError(":STALE_CONTROL", "worktree state is missing", {
		path,
		next: "inspect the mission; do not rebuild a deleted .herd as if nothing happened",
	});
}

function writeState(path, state) {
	state.updated_at = new Date().toISOString();
	writeFileAtomic(dirname(path), "worktrees.edn", `${printUfss(stateToEdn(state))}\n`);
}

function stateToEdn(state) {
	const slices = new Map();
	for (const [sliceId, slice] of Object.entries(state.slices)) {
		slices.set(sliceId, objectToEdn(slice));
	}
	return new Map([
		[new EdnKeyword("version"), state.version],
		[new EdnKeyword("slug"), state.slug],
		[new EdnKeyword("base"), state.base ?? null],
		[new EdnKeyword("queue"), state.queue.map(objectToEdn)],
		[new EdnKeyword("next-seq"), state.next_seq],
		[new EdnKeyword("slices"), slices],
		[new EdnKeyword("created-at"), state.created_at],
		[new EdnKeyword("updated-at"), state.updated_at],
	]);
}

function objectToEdn(value) {
	if (Array.isArray(value)) return value.map(objectToEdn);
	if (value && typeof value === "object") {
		const map = new Map();
		for (const [key, entry] of Object.entries(value)) {
			if (entry === undefined) continue;
			const kebab = snakeToKebab(key);
			const output =
				(kebab === "status" || kebab === "role") && typeof entry === "string"
					? new EdnKeyword(entry)
					: objectToEdn(entry);
			map.set(new EdnKeyword(kebab), output);
		}
		return map;
	}
	return value;
}

function fromStateEdn(value) {
	if (!(value instanceof Map)) {
		throw new Error("worktree state must be an EDN map");
	}
	const state = {};
	for (const [key, entry] of value) {
		const name = key instanceof EdnKeyword ? key.name : String(key);
		if (name === "slices") {
			if (!(entry instanceof Map)) throw new Error(":slices must be an EDN map");
			const slices = {};
			for (const [sliceKey, slice] of entry) {
				const sliceId = sliceKey instanceof EdnKeyword ? sliceKey.name : String(sliceKey);
				slices[sliceId] = fromEdnValue(slice);
			}
			state.slices = slices;
			continue;
		}
		state[kebabToSnake(name)] = fromEdnValue(entry);
	}
	return state;
}

function fromEdnValue(value) {
	if (value instanceof Map) {
		const object = {};
		for (const [key, entry] of value) {
			const name = key instanceof EdnKeyword ? key.name : String(key);
			object[kebabToSnake(name)] = fromEdnValue(entry);
		}
		return object;
	}
	if (Array.isArray(value)) return value.map(fromEdnValue);
	if (value instanceof Set) return [...value].map(fromEdnValue);
	if (value instanceof EdnKeyword) return value.name;
	return value;
}

function snakeToKebab(key) {
	return key.replaceAll("_", "-");
}

function kebabToSnake(key) {
	return key.replaceAll("-", "_");
}

async function withState(paths, deps, fn, options = {}) {
	const key = paths.statePath;
	const previous = stateTails.get(key) ?? Promise.resolve();
	const run = previous.then(async () => {
		const existing = readState(paths.statePath);
		if (existing === null && options.create === false) {
			throw missingState(paths.statePath);
		}
		const state = existing ?? createState(paths.slug ?? "", null, nowIso(ports(deps).clock));
		try {
			const result = await fn(state);
			writeState(paths.statePath, state);
			return result;
		} catch (error) {
			if (options.commitOnError === true) {
				try {
					writeState(paths.statePath, state);
				} catch {
					// Keep the original error; recovery still has the old state.
				}
			}
			throw error;
		}
	});
	const guard = run.then(
		() => undefined,
		() => undefined,
	);
	stateTails.set(key, guard);
	try {
		return await run;
	} finally {
		if (stateTails.get(key) === guard) stateTails.delete(key);
	}
}

async function reserveSlice(mission, deps, spec, paths, swarmId, base, now) {
	return withState(
		mission,
		deps,
		async (state) => {
			const existing = state.slices[spec.sliceId];
			if (existing && normalizeStatus(existing.status) !== "pending") return false;
			state.slices[spec.sliceId] = {
				...(existing ?? {}),
				slice_id: spec.sliceId,
				status: "creating",
				swarm_id: swarmId,
				workspace: paths.workspace,
				branch: paths.branch,
				base: base,
				board_path: paths.boardPath,
				depends_on: [...spec.dependsOn],
				goal: spec.goal,
				created_at: now,
				updated_at: now,
			};
			return true;
		},
		{ create: false },
	);
}

async function markSlice(mission, deps, sliceId, fields) {
	return withState(
		mission,
		deps,
		async (state) => {
			if (!state.slices[sliceId]) return;
			Object.assign(state.slices[sliceId], fields);
		},
		{ create: false },
	);
}

function retentionDeadline(startIso, retainDays) {
	const start = Date.parse(startIso);
	if (!Number.isFinite(start)) {
		throw herdError(":STALE_CONTROL", "retention timestamp is invalid", {
			value: startIso,
			next: "repair the worktree state before collecting evidence",
		});
	}
	return new Date(start + retainDays * DAY_MS).toISOString();
}

// ---------------------------------------------------------------------------
// Queue and readiness
// ---------------------------------------------------------------------------

function normalizeSlices(slices) {
	const seen = new Set();
	return slices.map((raw, index) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw invalidArgument(`slices[${index}]`, "a SliceSpec object", raw);
		}
		const sliceId = raw.slice_id ?? raw.sliceId;
		assertSliceId(sliceId);
		if (seen.has(sliceId)) {
			throw invalidArgument(`slices[${index}].slice_id`, "a unique Slice id", sliceId);
		}
		seen.add(sliceId);
		const rawDependsOn = raw.depends_on ?? raw.dependsOn ?? [];
		const dependsOn = Array.isArray(rawDependsOn)
			? rawDependsOn
			: rawDependsOn instanceof Set
				? [...rawDependsOn]
				: null;
		if (dependsOn === null) {
			throw invalidArgument(`slices[${index}].depends_on`, "an array or Set of Slice ids", rawDependsOn);
		}
		for (const dependency of dependsOn) assertSliceId(dependency);
		return {
			sliceId,
			dependsOn: [...new Set(dependsOn)],
			status: normalizeStatus(raw.status) ?? "pending",
			goal: raw.goal,
			doneWhen: raw.done_when ?? raw.doneWhen,
			mappedCases: raw.mapped_cases ?? raw.mappedCases,
		};
	});
}

function isReady(spec, state, specsById = new Map()) {
	const own = state?.slices?.[spec.sliceId];
	const ownStatus = own ? normalizeStatus(own.status) : spec.status;
	if (ownStatus !== "pending") return false;
	for (const dependency of spec.dependsOn) {
		if (dependency === spec.sliceId) return false;
		const stored = state?.slices?.[dependency];
		const status = normalizeStatus(stored?.status) ?? specsById.get(dependency)?.status;
		if (status !== "joined") return false;
	}
	return true;
}

function effectiveStatuses(state) {
	return Object.values(state.slices).map((slice) => ({
		slice_id: slice.slice_id,
		status: normalizeStatus(slice.status) ?? "pending",
	}));
}

function hasActive(statuses) {
	return statuses.some((entry) => ACTIVE_STATUSES.has(entry.status) || QUEUE_STATUSES.has(entry.status));
}

function allFailed(statuses) {
	return statuses.length > 0 && statuses.every((entry) => TERMINAL_FAILURES.has(entry.status));
}

function noneResult() {
	return { slice_id: null, status: "none" };
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

function lockMeta(purpose, sliceId, actor, action) {
	const holder = normalizeHolder(actor);
	return {
		lock_id: randomUUID(),
		purpose,
		slice_id: sliceId,
		owner_agent_id: holder?.agent_id ?? "coordinator",
		owner_term_id: holder?.term_id ?? "term-worktree",
		pid: process.pid,
		started_at: new Date().toISOString(),
		host: process.env.HOSTNAME ?? "local",
		token: randomUUID(),
		action,
	};
}

async function acquireWithWait(lockPort, path, meta, deps, signal) {
	const pollMs = pollInterval(deps);
	for (;;) {
		throwIfAborted(signal);
		const result = await lockPort.acquire(path, meta);
		if (result?.ok === true) return result.handle;
		if (result?.error?.code === ":LOCK_OWNER_DEAD" || result?.stale === true) {
			throw result.error ?? herdError(":LOCK_OWNER_DEAD", "lock owner is dead", { path });
		}
		await sleep(pollMs, signal);
	}
}

function release(lockPort, handle) {
	if (!handle) return;
	const result = typeof lockPort?.release === "function" ? lockPort.release(handle) : releaseLock(handle);
	if (result?.released === false && result.reason !== "missing") {
		throw herdError(":STALE_CONTROL", "cannot release lock", {
			path: handle.path,
			reason: result.reason,
			next: "inspect the lock before continuing; never delete a lock with a different token",
		});
	}
}

// ---------------------------------------------------------------------------
// Validation and small helpers
// ---------------------------------------------------------------------------

function assertRoot(root) {
	if (typeof root !== "string" || root.length === 0) {
		throw invalidArgument("root", "a non-empty repository path", root);
	}
}

function assertSlug(slug) {
	if (typeof slug !== "string" || !SLUG.test(slug) || slug.includes("..")) {
		throw invalidArgument("slug", "a lowercase slug of letters, digits and hyphens", slug);
	}
}

function assertSliceId(sliceId) {
	if (typeof sliceId !== "string" || !SLICE_ID.test(sliceId) || sliceId.includes("..")) {
		throw invalidArgument("sliceId", "an alphanumeric Slice id with optional _ or - (max 64, case preserved)", sliceId);
	}
}

function assertBase(base) {
	if (typeof base !== "string" || base.trim().length === 0 || base.startsWith("-")) {
		throw invalidArgument("base", "a commit or branch name", base);
	}
}

function assertRetainDays(retainDays) {
	if (!Number.isFinite(retainDays) || retainDays < 0) {
		throw invalidArgument("retainDays", "a non-negative number of days", retainDays);
	}
}

function invalidArgument(argument, expected, actual) {
	return herdError(":INVALID_ARGUMENT", `${argument} is invalid`, {
		argument,
		expected,
		actual: actualOf(actual),
		next: `pass ${expected} for ${argument}`,
	});
}

function actualOf(value) {
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	return typeof value;
}

function normalizeStatus(value) {
	if (typeof value !== "string") return null;
	const text = value.startsWith(":") ? value.slice(1) : value;
	return text.length > 0 ? text.toLowerCase() : null;
}

function normalizeHolder(holder) {
	if (!holder || typeof holder !== "object") return null;
	const agentId = holder.agent_id ?? holder.agentId;
	if (typeof agentId !== "string" || agentId.length === 0) return null;
	return {
		agent_id: agentId,
		term_id: holder.term_id ?? holder.termId ?? null,
		role: holder.role ?? "holder",
	};
}

function pollInterval(deps) {
	const value = deps.pollMs;
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_POLL_MS;
}

function positiveInteger(value, fallback) {
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nowIso(clock) {
	const value = clock?.now ? clock.now() : new Date();
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw herdError(":STALE_CONTROL", "clock returned an invalid time", {
			value: String(value),
			next: "inject a clock that returns a valid Date or timestamp",
		});
	}
	return date.toISOString();
}

function throwIfAborted(signal) {
	if (signal?.aborted) {
		throw herdError(":UPSTREAM_ABORTED", "the join wait was aborted", {
			reason: String(signal.reason ?? "aborted"),
			next: "inspect the parent cancellation before retrying join",
		});
	}
}

function sleep(ms, signal) {
	return new Promise((resolveSleep, rejectSleep) => {
		throwIfAborted(signal);
		const timer = setTimeout(() => {
			signal?.removeEventListener?.("abort", onAbort);
			resolveSleep();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			rejectSleep(
				herdError(":UPSTREAM_ABORTED", "the wait was aborted", {
					reason: String(signal.reason ?? "aborted"),
				}),
			);
		}
		signal?.addEventListener?.("abort", onAbort, { once: true });
	});
}

async function appendEvent(path, event, data, options = {}) {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const record = {
			at: new Date().toISOString(),
			event,
			...data,
		};
		appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
		return true;
	} catch (error) {
		if (options.required === true) throw error;
		return false;
	}
}

function assertFreshTarget(paths, sliceId) {
	if (existsSync(paths.workspace)) {
		throw herdError(":FILE_CONFLICT", "worktree path already exists", {
			path: paths.workspace,
			slice_id: sliceId,
			next: "inspect the leftover worktree; never reuse it for another Slice",
		});
	}
}

function assertSamePath(actual, expected, sliceId) {
	const left = safeRealpath(actual);
	const right = safeRealpath(expected);
	if (left !== right) {
		throw herdError(":PATH_ESCAPE", "git worktree resolves outside the expected path", {
			slice_id: sliceId,
			expected,
			actual,
			next: "remove the invalid worktree registration and create it again",
		});
	}
}

function safeRealpath(path) {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}
