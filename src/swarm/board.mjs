/**
 * Swarm board kernel.
 *
 * The kernel owns only the public control state of one Slice:
 * tasks, actions, actors, the token slot, sleepers and the request ledger.
 * It never reads or writes the workspace, never calls a model and never waits.
 * Every mutation is a short transition from one immutable board value to the
 * next. Persistence, locking and event append belong to an injected store.
 *
 * Storage port (implemented by the storage owners):
 *
 *   read(): Promise<Board | null>
 *   transaction(fn): Promise<Response>
 *
 * `fn` receives the current board or null. It returns:
 *
 *   { board, events, response, commit }
 *
 * The store must run `fn` under the board lock, persist `board` atomically when
 * `commit` is not false, append `events` in order, update the checkpoint, then
 * return `response`.
 * A store that cannot run a transaction must reject; it must not silently lose
 * a board write.
 *
 * Board values use the EDN field names from AGENTS.md §3.2. Tool arguments use
 * camelCase or snake_case; the kernel normalizes both at this boundary.
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, posix } from "node:path";
import { EdnKeyword, EdnSymbol, printUfss, readUfss } from "../clj-sandbox/ufss.mjs";
import { writeEdnAtomic, writeFileAtomic } from "../util/atomic-write.mjs";
import { herdError } from "../util/errors.mjs";
import { withLock } from "../util/file-lock.mjs";

export const TAKE_OR_DIE_CONFIRMATION = "i-hereby-confirm-i-die-without-regret";

const CONDITION_WAIT_PREFIX = "condition:";

/**
 * Enum-valued fields that the EDN store must render as keywords.
 * In memory the values are bare strings (`"ready"`, `"alive"`, ...).
 */
export const BOARD_ENUM_FIELDS = Object.freeze({
	task: Object.freeze(["state"]),
	actor: Object.freeze(["role", "life-state"]),
	action: Object.freeze(["kind", "phase"]),
	"token-slot": Object.freeze(["state"]),
	tenure: Object.freeze(["phase"]),
	event: Object.freeze(["event-type"]),
	receipt: Object.freeze(["outcome", "code"]),
	"take-attempt": Object.freeze(["token-state", "outcome"]),
});

const ROLE_VALUES = new Set(["normal", "holder"]);
const TASK_STATES = new Set(["ready", "waiting", "done"]);
const LIFE_STATES = new Set(["alive", "dead", "terminated"]);
const ACTION_KINDS = new Set(["board", "edit", "shell"]);
const ACTION_PHASES = new Set(["claimed", "preparing", "waiting-gate", "applying", "running", "finished", "uncertain"]);
const ACTIVE_ACTION_PHASES = new Set(["applying", "running", "uncertain"]);

const ACTION_TRANSITIONS = new Map([
	["claimed", new Set(["preparing", "applying", "running", "waiting-gate", "finished", "uncertain"])],
	["preparing", new Set(["applying", "running", "waiting-gate", "finished", "uncertain"])],
	["waiting-gate", new Set(["applying", "running", "finished", "uncertain"])],
	["applying", new Set(["finished", "uncertain"])],
	["running", new Set(["finished", "uncertain"])],
	["uncertain", new Set(["finished"])],
	["finished", new Set()],
]);

const COMMAND_TYPES = new Map([
	["split", "split"],
	["claim", "claim"],
	["finish", "finish"],
	["cancel", "cancel"],
	["replace", "replace"],
	["release", "release"],
	["reopen", "reopen"],
	["comment", "comment"],
	["update", "update"],
	["park_slot", "parkSlot"],
	["parkSlot", "parkSlot"],
	["take_or_die", "takeOrDie"],
	["takeOrDie", "takeOrDie"],
	["accept_take", "acceptTake"],
	["acceptTake", "acceptTake"],
	["resolve_take", "resolveTake"],
	["resolveTake", "resolveTake"],
	["register_actor", "registerActor"],
	["registerActor", "registerActor"],
	["add_tasks", "addTasks"],
	["addTasks", "addTasks"],
	["start_action", "startAction"],
	["startAction", "startAction"],
	["set_action_phase", "setActionPhase"],
	["setActionPhase", "setActionPhase"],
	["resolve_condition", "resolveCondition"],
	["resolveCondition", "resolveCondition"],
	["record_input", "recordInput"],
	["recordInput", "recordInput"],
	["review", "review"],
]);

/**
 * Build a fresh board value.
 *
 * @param {{boardVersion?: number}} [options]
 */
export function initialBoard(options = {}) {
	const version = Number.isInteger(options.boardVersion) ? options.boardVersion : 0;
	const mode = options.mode === "plan" ? "plan" : "swarm";
	return {
		"board-version": version,
		mode,
		tasks: {},
		"attach-ready": mode === "plan",
		"review-summary": null,
		actions: {},
		actors: {},
		"token-slot": {
			"holder-id": null,
			"term-id": null,
			state: "free",
			"retired-terms": [],
		},
		tenure: { term: 0, phase: mode === "plan" ? "plan" : "swarm" },
		"next-ids": { task: 1, claim: 1, term: 1, action: 1, event: 1, input: 1 },
		requests: {},
		"take-attempts": {},
		sleepers: {},
		wake: { epoch: 0 },
		conditions: {},
		inputs: [],
	};
}

/**
 * Register one live actor. Seeding helper only; production uses the
 * `registerActor` command through `apply`, which records version and event.
 */
export function registerActor(board, spec) {
	const draft = clone(board);
	const actor = normalizeActorSpec(spec);
	if (draft.actors[actor["agent-id"]]) {
		throw new TypeError(`actor already registered: ${actor["agent-id"]}`);
	}
	draft.actors[actor["agent-id"]] = actor;
	return draft;
}

/**
 * Add root tasks. Seeding helper only; production uses the `addTasks` command.
 *
 * @returns {{board: object, taskIds: string[]}}
 */
export function addTasks(board, specs) {
	const draft = clone(board);
	if (!Array.isArray(specs)) throw new TypeError("tasks must be an array");
	const taskIds = [];
	for (let index = 0; index < specs.length; index += 1) {
		const normalized = normalizeTaskSpec(specs[index], `tasks[${index}]`);
		if (!normalized.ok) throw new TypeError(normalized.error.message);
		const task = appendTask(draft, normalized.value);
		taskIds.push(task["task-id"]);
	}
	return { board: draft, taskIds };
}

/**
 * Read the public task tree. Pure; used by receipts and dashboards.
 */
export function taskTree(board) {
	return Object.values(board.tasks ?? {}).map((task) => ({
		taskId: task["task-id"],
		parentId: task["parent-id"],
		state: task.state,
		ownerId: task["owner-id"],
		claimId: task["claim-id"],
		claimOwnerId: task["claim-owner-id"],
		needsToken: task["needs-token"],
		waitFor: clone(task["wait-for"] ?? []),
		goal: task.goal,
	}));
}

/**
 * Compute the live task objects that the given agent must still carry.
 *
 * The formula is AGENTS.md §3.2. Waiting tasks count. A Holder also carries
 * every open token task. In-flight actions count until they finish.
 *
 * @returns {Array<{kind: string, id: string, task?: object, action?: object}>}
 */
export function responsibilitySet(board, agentId) {
	const result = [];
	const holderId = board["token-slot"]?.["holder-id"] ?? null;
	for (const task of Object.values(board.tasks ?? {})) {
		if (task.state !== "ready" && task.state !== "waiting") continue;
		if (!task["needs-token"] && task["owner-id"] === agentId) {
			result.push({ kind: "task", id: task["task-id"], task });
		}
		if (task["needs-token"] && holderId === agentId) {
			result.push({ kind: "token-task", id: task["task-id"], task });
		}
	}
	for (const action of Object.values(board.actions ?? {})) {
		if (action["agent-id"] === agentId && ACTIVE_ACTION_PHASES.has(action.phase)) {
			result.push({ kind: "action", id: action["action-id"], action });
		}
	}
	return result;
}

/**
 * Compute the work that some individual could still advance.
 *
 * A ready task with no unfinished action is progressable. An action that is
 * claimed, preparing or uncertain is progressable. Applying, running and
 * waiting-gate actions are already in flight or blocked; they do not keep the
 * rest of the swarm awake. This is what lets everyone park while one call runs.
 */
export function progressableSet(board) {
	const result = [];
	const activeByTask = new Map();
	for (const action of Object.values(board.actions ?? {})) {
		if (action.phase === "finished") continue;
		activeByTask.set(action["task-id"], action);
	}
	for (const task of Object.values(board.tasks ?? {})) {
		if (task.state !== "ready") continue;
		if (activeByTask.has(task["task-id"])) continue;
		result.push({ kind: "task", id: task["task-id"], task });
	}
	for (const action of Object.values(board.actions ?? {})) {
		if (action.phase !== "claimed" && action.phase !== "preparing" && action.phase !== "uncertain") {
			continue;
		}
		result.push({ kind: "action", id: action["action-id"], action });
	}
	return result;
}

/**
 * Validate and de-duplicate `dependency_paths`.
 *
 * Board-side semantics only: each entry must be a workspace-relative path that
 * does not escape the workspace. Existence, file type, and `stamp` checks
 * belong to the write-gate/VFS layer. Task-id-shaped strings are valid paths;
 * a real file may legitimately use that name.
 *
 * @param {string[]} paths
 * @returns {string[] | null} validated original strings, or null
 */
export function validateDependencyPaths(paths) {
	if (!Array.isArray(paths)) return null;
	const result = [];
	for (const path of paths) {
		if (!isWorkspaceRelativePath(path)) return null;
		result.push(path);
	}
	return uniqueValues(result);
}

function isWorkspaceRelativePath(path) {
	if (!isText(path) || path.includes("\0") || isAbsolute(path)) return false;
	const normalized = posix.normalize(path);
	return normalized !== ".." && !normalized.startsWith("../");
}

/**
 * Pure wake-all value for tests and one-shot utilities.
 *
 * Production transitions already wake inside the board lock: `apply` computes
 * and commits the wake in the same transaction. Never call this after an
 * `apply` and write the returned board back in a second transaction; that
 * would overwrite concurrent state outside the board lock. Use `recordInput`
 * for user input, or rely on `reopen`/`release`/`cancel` auto-wake.
 *
 * @returns {{board: object, event: object, epoch: number}}
 */
export function wakeAll(board, reason = "manual") {
	const draft = clone(board);
	ensureBoardShape(draft);
	draft["board-version"] = (draft["board-version"] ?? 0) + 1;
	const epoch = bumpWake(draft);
	const event = makeEvent(draft, "wake-all", { cause: reason, epoch }, draft["board-version"], {
		requestId: null,
		actorId: null,
		turnId: null,
	});
	return { board: draft, event, epoch };
}

export function isAttachReady(board) {
	return Boolean(board && board["attach-ready"]);
}

/**
 * Read the plan ledger without mutating it. `empty` is the attach-ready
 * signal: the stage may attach only while no finding remains.
 */
export function reviewLedger(board) {
	const tasks = Object.values(board?.tasks ?? {});
	return {
		summary: board?.["review-summary"] ?? null,
		findings: tasks.map((task) => ({ key: task.key, value: task.value ?? null })),
		empty: tasks.length === 0,
		attachReady: isAttachReady(board),
	};
}

/**
 * Record one review round on the plan ledger.
 *
 * A string value upserts the task, nil deletes it, and an empty value array
 * leaves the tasks unchanged. Review never writes a deliverable and never
 * advances the tenure stage; it only mutates this board.
 */
export function applyReview(board, input = {}) {
	if (!isBoardState(board)) {
		return failure("INVALID_ARGUMENT", "board must be a board value", {});
	}
	if ((board.mode ?? "swarm") !== "plan") {
		return failure("INVALID_ARGUMENT", "review requires a plan board", {
			mode: board.mode ?? "swarm",
		});
	}
	const findings = input.findings ?? [];
	if (!Array.isArray(findings)) {
		return failure("INVALID_ARGUMENT", "findings must be an array", { field: "findings" });
	}
	const summary = readField(input, "summaryMarkdown", "summary_markdown", "summary");
	if (summary !== undefined && summary !== null && typeof summary !== "string") {
		return failure("INVALID_ARGUMENT", "summary_markdown must be a string or nil", {
			field: "summary_markdown",
		});
	}
	const draft = clone(board);
	ensureBoardShape(draft);
	if (summary !== undefined) draft["review-summary"] = summary;
	for (let index = 0; index < findings.length; index += 1) {
		const finding = findings[index];
		if (!finding || typeof finding !== "object") {
			return failure("INVALID_ARGUMENT", `findings[${index}] must be an object`, {});
		}
		const key = readField(finding, "key");
		if (!isText(key)) {
			return failure("INVALID_ARGUMENT", `findings[${index}].key must be non-empty`, {});
		}
		const value = readField(finding, "value");
		if (Array.isArray(value)) continue;
		if (value === null || value === undefined) {
			deletePlanTask(draft, key);
			continue;
		}
		if (typeof value !== "string") {
			return failure("INVALID_ARGUMENT", `findings[${index}].value must be a string or nil`, {});
		}
		const parentKey = readField(finding, "parentKey", "parent_key");
		const waitFor = readField(finding, "waitFor", "wait_for");
		const waiting = readField(finding, "waiting");
		if (parentKey !== undefined && parentKey !== null) {
			if (!isText(parentKey) || parentKey === key || !draft.tasks[parentKey]) {
				return failure("INVALID_ARGUMENT", `findings[${index}].parent_key must name another task`, {
					parentKey,
				});
			}
		}
		if (waitFor !== undefined) {
			if (!Array.isArray(waitFor) || !waitFor.every((entry) => isText(entry) && Boolean(draft.tasks[entry]))) {
				return failure("INVALID_ARGUMENT", `findings[${index}].wait_for must name existing tasks`, {});
			}
		}
		if (waiting !== undefined && typeof waiting !== "boolean") {
			return failure("INVALID_ARGUMENT", `findings[${index}].waiting must be boolean`, {});
		}
		upsertPlanTask(draft, key, value, { parentKey, waitFor, waiting });
	}
	draft["attach-ready"] = Object.keys(draft.tasks).length === 0;
	const unchanged =
		stableStringify({
			tasks: board.tasks,
			summary: board["review-summary"] ?? null,
			attachReady: Boolean(board["attach-ready"]),
		}) ===
		stableStringify({
			tasks: draft.tasks,
			summary: draft["review-summary"] ?? null,
			attachReady: draft["attach-ready"],
		});
	if (unchanged) {
		return {
			ok: true,
			board,
			changed: false,
			receipt: {
				outcome: "review-unchanged",
				"board-version": board["board-version"],
				"task-keys": Object.keys(board.tasks ?? {}),
				"attach-ready": isAttachReady(board),
			},
			events: [],
		};
	}
	const nextVersion = (draft["board-version"] ?? 0) + 1;
	draft["board-version"] = nextVersion;
	const event = makeEvent(
		draft,
		"review",
		{
			summary: draft["review-summary"] ?? null,
			findings: findings.map((entry) => ({
				key: readField(entry, "key") ?? null,
				value: readField(entry, "value") ?? null,
			})),
			"attach-ready": draft["attach-ready"],
		},
		nextVersion,
		{ requestId: null, actorId: null, turnId: null },
	);
	return {
		ok: true,
		board: draft,
		changed: true,
		receipt: {
			outcome: "review-recorded",
			"board-version": nextVersion,
			"task-keys": Object.keys(draft.tasks),
			"attach-ready": draft["attach-ready"],
		},
		events: [event],
	};
}

/**
 * Pure transition. The input board is never mutated.
 *
 * @param {object} board
 * @param {object} rawArgs {command, actor, turnId, requestId, expectedBoardVersion}
 */
export function applyCommand(board, rawArgs = {}) {
	if (!isBoardState(board)) {
		return failure("INVALID_ARGUMENT", "board must be a board value", {});
	}
	const args = normalizeApplyArgs(rawArgs);
	const command = args.command;
	const reject = (result) => ({ ...result, board, events: [] });
	const type = commandType(command);
	if (!type) {
		return reject(failure("INVALID_ARGUMENT", "unknown board command", { command }));
	}
	if (type === "review") {
		const reviewed = applyReview(board, command);
		if (!reviewed.ok) return { ...reviewed, board, events: [] };
		return { ...reviewed, replayed: false };
	}
	if (!isText(args.requestId)) {
		return reject(failure("INVALID_ARGUMENT", "request_id is required", { field: "request_id" }));
	}
	if (!isText(args.turnId) && type !== "recordInput") {
		return reject(failure("INVALID_ARGUMENT", "turn_id is required", { field: "turn_id" }));
	}

	const expected = firstDefined(
		args.expectedBoardVersion,
		readField(command, "expectedBoardVersion", "expected_board_version"),
		readField(command, "observedBoardVersion", "observed_board_version"),
	);
	const digest = stableStringify({
		type,
		command,
		actor: actorIdOf(args.actor),
		expectedBoardVersion: expected ?? null,
	});
	const existing = board.requests?.[args.requestId];
	if (existing) {
		if (existing.digest !== digest) {
			return reject(
				failure("CALL_REPLAY_MISMATCH", "request_id was used with a different payload", {
					requestId: args.requestId,
					expectedDigest: existing.digest,
					actualDigest: digest,
				}),
			);
		}
		return {
			ok: true,
			board,
			replayed: true,
			changed: false,
			receipt: clone(existing.receipt),
			events: [],
		};
	}

	if (type === "split" || type === "parkSlot") {
		if (!Number.isInteger(expected)) {
			return reject(
				failure("INVALID_ARGUMENT", "expected board version is required", {
					field: type === "parkSlot" ? "observed_board_version" : "expected_board_version",
					boardVersion: board["board-version"],
				}),
			);
		}
	}
	if (expected !== undefined) {
		if (!Number.isInteger(expected)) {
			return reject(
				failure("INVALID_ARGUMENT", "expected board version must be an integer", {
					field: "expected_board_version",
					current: board["board-version"],
				}),
			);
		}
		if (expected !== board["board-version"]) {
			return reject(
				failure("BOARD_CONFLICT", "board version changed", {
					expected,
					current: board["board-version"],
					summary: progressableSummary(board),
				}),
			);
		}
	}

	let actorId = null;
	if (type !== "registerActor" && type !== "recordInput") {
		const resolved = resolveActor(board, args.actor, { allowDead: type === "resolveTake" });
		if (!resolved.ok) return reject(resolved);
		actorId = resolved.agentId;
	}
	if (actorId && type !== "resolveTake") {
		const pending = pendingTakeAttempt(board, actorId);
		if (pending) {
			return reject(
				failure("INVALID_ARGUMENT", "actor has a pending take attempt", {
					agentId: actorId,
					requestId: pending["request-id"],
					next: "resolve the accepted attempt before other board work",
				}),
			);
		}
	}

	const draft = clone(board);
	ensureBoardShape(draft);
	const context = {
		board: draft,
		command,
		actorId,
		turnId: args.turnId ?? "user",
		requestId: args.requestId,
	};
	const hadSleepers = Object.keys(board.sleepers ?? {}).length > 0;
	const handler = HANDLERS[type](draft, context);
	if (!handler.ok) {
		return { ok: false, board, error: handler.error, events: [] };
	}
	if (handler.skipCommit) {
		return {
			ok: true,
			board,
			changed: false,
			replayed: false,
			receipt: {
				...handler.receipt,
				"request-id": context.requestId,
				"board-version": draft["board-version"],
			},
			events: [],
		};
	}

	draft["board-version"] = (draft["board-version"] ?? 0) + 1;
	const version = draft["board-version"];
	const events = [];
	events.push(makeEvent(draft, handler.eventType, handler.eventData ?? {}, version, context));

	const retirement = settleHolder(draft);
	if (retirement) {
		events.push(makeEvent(draft, "holder-retired", retirement, version, context));
	}

	// Wake, epoch and the triggering mutation are one board value. The store
	// commits them in the same board-lock transaction; never wake outside it.
	const shouldWake = handler.forceWake === true || (hadSleepers && progressableSet(draft).length > 0);
	if (shouldWake) {
		const epoch = bumpWake(draft);
		events.push(
			makeEvent(draft, "wake-all", { cause: handler.wakeCause ?? handler.eventType, epoch }, version, context),
		);
	}

	const receipt = {
		...handler.receipt,
		"request-id": context.requestId,
		"board-version": version,
		"wake-epoch": draft.wake.epoch,
	};
	if (retirement) receipt["holder-retired"] = retirement;
	draft.requests[context.requestId] = {
		digest,
		receipt: clone(receipt),
		"board-version": version,
	};

	return { ok: true, board: draft, changed: true, receipt, events };
}

/**
 * Board-aware apply. A plain board runs the pure transition and returns the
 * next value. An openBoard handle runs the transition inside the injected
 * store transaction, so lock, atomic write and event append stay outside the
 * kernel.
 *
 * @returns {Promise<object>}
 */
export async function apply(rawArgs = {}) {
	const boardArg = rawArgs.board;
	const args = { ...rawArgs };
	delete args.board;

	if (isBoardHandle(boardArg)) {
		const handle = boardArg;
		if (commandType(args.command) === "takeOrDie") {
			return applyTakeTwoPhase(handle, args);
		}
		return boardTransaction(handle, args);
	}

	if (isBoardState(boardArg)) {
		return applyCommand(boardArg, args);
	}

	return failure("INVALID_ARGUMENT", "board must be a board value or an openBoard handle", {});
}

async function boardTransaction(handle, args) {
	return handle.store.transaction(async (current) => {
		const plan = handle.mode === "plan";
		if (!current && handle.durable !== false && !plan) {
			const missing = failure("STALE_CONTROL", "slice board is missing or unreadable", {
				boardPath: handle.boardPath,
				next: "seed the tenure board; do not rebuild a missing ledger",
			});
			return {
				board: null,
				events: [],
				response: { ...missing, board: null },
				commit: false,
			};
		}
		const base = current ?? initialBoard({ mode: plan ? "plan" : "swarm" });
		const result = applyCommand(base, args);
		return {
			board: result.board,
			events: result.events ?? [],
			response: result,
			commit: Boolean(result.ok && result.changed),
		};
	});
}

/**
 * Two-phase `take_or_die` for the production handle path. The acceptance is
 * committed before resolution, so a cancellation between the two transactions
 * cannot turn an accepted attempt into "no work". The one-shot kernel command
 * remains for pure tests and direct callers.
 */
async function applyTakeTwoPhase(handle, args) {
	const requestId = firstDefined(args.requestId, args.request_id);
	if (!isText(requestId)) {
		return failure("INVALID_ARGUMENT", "request_id is required", { field: "request_id" });
	}
	const acceptRequestId = `${requestId}:accept`;
	const acceptCommand = {
		...args.command,
		type: "acceptTake",
		originalRequestId: requestId,
	};
	delete acceptCommand.expectedBoardVersion;
	delete acceptCommand.expected_board_version;
	delete acceptCommand.observedBoardVersion;
	delete acceptCommand.observed_board_version;
	const acceptArgs = {
		...args,
		requestId: acceptRequestId,
		command: acceptCommand,
	};
	delete acceptArgs.expectedBoardVersion;
	delete acceptArgs.expected_board_version;
	const accepted = await boardTransaction(handle, acceptArgs);
	if (!accepted.ok) return accepted;
	if (accepted.receipt?.outcome === "no-progressable-work") {
		return {
			...accepted,
			receipt: { ...accepted.receipt, "request-id": requestId },
		};
	}

	const resolveArgs = {
		...args,
		requestId,
		command: {
			type: "resolveTake",
			attemptId: acceptRequestId,
			takeDigest: stableStringify(args.command),
		},
	};
	delete resolveArgs.expectedBoardVersion;
	delete resolveArgs.expected_board_version;
	const resolved = await boardTransaction(handle, resolveArgs);
	if (resolved.ok) {
		resolved.receipt = {
			...resolved.receipt,
			"accepted-version": accepted.receipt["board-version"],
			"token-tasks": clone(resolved.receipt.tokenTasks ?? accepted.receipt.tokenTasks ?? []),
		};
	}
	return resolved;
}

/**
 * Open one Slice board.
 *
 * The production default is a durable file store: board lock, atomic EDN board
 * write, JSONL event append and checkpoint. A caller may inject `store` for
 * tests or a custom backend; `durable:false` must be explicit. Missing or
 * corrupt boards are never replaced with an empty board.
 *
 * The only signature is `(root, slug, sliceId, options)`.
 */
export function openBoard(root, slug, sliceIdOrOptions, maybeOptions = {}) {
	const sliceId = isText(sliceIdOrOptions) ? sliceIdOrOptions : null;
	const options = isText(sliceIdOrOptions) ? maybeOptions : (sliceIdOrOptions ?? {});
	if (!isText(root) || !isText(slug)) {
		throw new TypeError("openBoard needs root and slug");
	}
	const plan = options.mode === "plan" || sliceId === null;
	const directory = plan
		? join(root, ".herd", "missions", slug)
		: join(root, ".herd", "missions", slug, "slices", sliceId);
	const boardPath = options.boardPath ?? join(directory, "board.edn");
	const eventsPath = options.eventsPath ?? join(directory, "events.jsonl");
	const checkpointPath = options.checkpointPath ?? join(directory, "checkpoint.edn");
	const lockPath = plan
		? null
		: (options.lockPath ?? join(root, ".herd", "locks", `${sliceId}.board.lock`));

	let store = options.store;
	let durable;
	if (!store) {
		store = createFileBoardStore({
			boardPath,
			eventsPath,
			checkpointPath,
			lockPath,
			lock: !plan,
			mode: plan ? "plan" : "swarm",
			sliceId,
			lockTimeoutMs: options.lockTimeoutMs,
			agentState: options.agentState,
		});
		durable = true;
	} else {
		durable = options.durable ?? store.durable !== false;
	}

	const handle = {
		root,
		slug,
		sliceId,
		mode: plan ? "plan" : "swarm",
		boardPath,
		eventsPath,
		checkpointPath,
		approvalsPath: join(directory, "approvals.edn"),
		lockPath,
		store,
		durable,
	};
	return handle;
}

export async function readBoard(handleOrRoot, slug, sliceIdOrOptions, options = {}) {
	const handle = isBoardHandle(handleOrRoot)
		? handleOrRoot
		: openBoard(handleOrRoot, slug, sliceIdOrOptions, options);
	const state = await handle.store.read();
	return state ?? null;
}

/**
 * In-memory store for tests and early integration. One transaction at a time,
 * like the real board lock.
 *
 * @param {{initial?: object} | object} [options]
 */
export function createMemoryBoardStore(options = {}) {
	const initial = isBoardState(options) ? options : (options.initial ?? null);
	let state = initial ? clone(initial) : null;
	const events = [];
	let tail = Promise.resolve();

	return {
		durable: false,
		async read() {
			return state ? clone(state) : null;
		},
		transaction(fn) {
			const run = tail.then(async () => {
				const current = state ? clone(state) : null;
				const outcome = await fn(current);
				if (!outcome || outcome.commit === false) {
					return outcome?.response;
				}
				if (outcome.board) state = clone(outcome.board);
				if (Array.isArray(outcome.events)) events.push(...clone(outcome.events));
				return outcome.response;
			});
			tail = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		},
		snapshot() {
			return state ? clone(state) : null;
		},
		events() {
			return clone(events);
		},
	};
}

/**
 * Durable board store: board lock, atomic EDN board write, JSONL event append,
 * and checkpoint. This is the production default; memory is explicit only.
 *
 * The transaction callback contract matches `apply` and the runner:
 *
 *   fn(currentBoard|null) -> { board, events, response, commit }
 *
 * Seeding happens only through `initialize`. A corrupt file is never
 * overwritten; the callback receives null.
 *
 * Checkpoint: `offset` is the committed events.jsonl byte offset; `digest` is
 * sha256(board.edn), not an event-prefix digest.
 */
export function createFileBoardStore(options = {}) {
	if (!options || typeof options !== "object") {
		throw new TypeError("createFileBoardStore needs an options object");
	}
	const boardPath = options.boardPath;
	if (!isText(boardPath)) {
		throw new TypeError("createFileBoardStore needs boardPath");
	}
	const eventsPath = options.eventsPath ?? join(dirname(boardPath), "events.jsonl");
	const checkpointPath = options.checkpointPath ?? join(dirname(boardPath), "checkpoint.edn");
	const lockPath = options.lockPath ?? join(dirname(boardPath), "board.lock");
	const lock = options.lock !== false && Boolean(lockPath);
	const mode = options.mode === "plan" ? "plan" : "swarm";
	const sliceId = options.sliceId ?? null;
	const lockTimeoutMs =
		Number.isInteger(options.lockTimeoutMs) && options.lockTimeoutMs >= 0 ? options.lockTimeoutMs : 5000;
	const agentState = options.agentState;

	async function read() {
		return readBoardFile(boardPath).state;
	}

	async function withBoardLock(fn) {
		if (!lock) return fn();
		const deadline = Date.now() + lockTimeoutMs;
		while (true) {
			const meta = {
				lock_id: `board-${randomUUID()}`,
				purpose: "board",
				slice_id: sliceId,
				owner_agent_id: null,
				owner_term_id: null,
				pid: process.pid,
				started_at: new Date().toISOString(),
				host: hostname(),
				token: randomUUID(),
				agentState,
			};
			const locked = await withLock(lockPath, meta, fn);
			if (locked.ok) return locked.value;
			if (locked.stale) throw locked.error;
			if (Date.now() >= deadline) {
				throw herdError("BOARD_CONFLICT", "board lock is busy", {
					lockPath,
					timeoutMs: lockTimeoutMs,
				});
			}
			await sleep(2);
		}
	}

	async function transaction(fn) {
		if (typeof fn !== "function") {
			throw herdError("INVALID_ARGUMENT", "board transaction needs a function", {
				field: "fn",
			});
		}
		return withBoardLock(async () => {
			const current = readBoardFile(boardPath).state;
			const outcome = await fn(current);
			if (!outcome || outcome.commit === false) {
				return outcome?.response;
			}
			const nextBoard = outcome.board ?? current;
			if (!nextBoard) {
				throw herdError("STALE_CONTROL", "board store has no board to commit", {
					boardPath,
				});
			}
			await writeBoardFile(boardPath, nextBoard);
			appendEvents(eventsPath, outcome.events ?? []);
			await writeEdnAtomic(checkpointPath, {
				offset: fileSize(eventsPath),
				digest: sha256File(boardPath),
				"board-version": nextBoard["board-version"],
				"updated-at": new Date().toISOString(),
			});
			return outcome.response;
		});
	}

	async function initialize(board = initialBoard({ mode })) {
		if (!isValidBoardState(board)) {
			throw herdError("INVALID_ARGUMENT", "initialize needs a complete board value", {});
		}
		return withBoardLock(async () => {
			const detail = readBoardFile(boardPath);
			if (detail.state) return detail.state;
			if (detail.corrupt) {
				throw herdError("STALE_CONTROL", "board file is corrupt", { boardPath });
			}
			if (hasCommittedLedger(eventsPath, checkpointPath)) {
				throw herdError("STALE_CONTROL", "board is missing while event or checkpoint state exists", {
					boardPath,
					eventsPath,
					checkpointPath,
					next: "restore the board from backup; do not rebuild an empty control state",
				});
			}
			await writeBoardFile(boardPath, board);
			ensureFile(eventsPath);
			await writeEdnAtomic(checkpointPath, {
				offset: fileSize(eventsPath),
				digest: sha256File(boardPath),
				"board-version": board["board-version"],
				"updated-at": new Date().toISOString(),
			});
			return board;
		});
	}

	return {
		durable: true,
		boardPath,
		eventsPath,
		checkpointPath,
		lockPath,
		read,
		transaction,
		initialize,
	};
}

/**
 * Read one board file. Missing and corrupt are distinct so `initialize` cannot
 * overwrite a damaged board.
 */
function readBoardFile(path) {
	if (!existsSync(path)) return { state: null, missing: true, corrupt: false };
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { state: null, missing: false, corrupt: true };
	}
	try {
		const value = fromEdnValue(readUfss(text));
		if (!isValidBoardState(value)) return { state: null, missing: false, corrupt: true };
		return { state: value, missing: false, corrupt: false };
	} catch {
		return { state: null, missing: false, corrupt: true };
	}
}

/**
 * Convert the EDN reader's Map/Keyword values into the board's plain JS shape.
 */
function fromEdnValue(value) {
	if (value instanceof Map) {
		const object = {};
		for (const [key, entry] of value) {
			const name = key instanceof EdnKeyword || key instanceof EdnSymbol ? key.name : String(key);
			object[name] = fromEdnValue(entry);
		}
		return object;
	}
	if (Array.isArray(value)) return value.map(fromEdnValue);
	if (value instanceof Set) return [...value].map(fromEdnValue);
	if (value instanceof EdnKeyword || value instanceof EdnSymbol) return value.name;
	return value;
}

/**
 * Render enum-valued board fields as EDN keywords. The in-memory board keeps
 * bare strings; the file uses the keyword forms required by AGENTS.md §3.
 */
function boardToEdn(board) {
	const output = clone(board);
	keywordizeCollection(output.tasks, BOARD_ENUM_FIELDS.task);
	keywordizeCollection(output.actors, BOARD_ENUM_FIELDS.actor);
	keywordizeCollection(output.actions, BOARD_ENUM_FIELDS.action);
	keywordizeCollection({ "token-slot": output["token-slot"] }, BOARD_ENUM_FIELDS["token-slot"]);
	keywordizeCollection({ tenure: output.tenure }, BOARD_ENUM_FIELDS.tenure);
	keywordizeCollection(output["take-attempts"], BOARD_ENUM_FIELDS["take-attempt"]);
	for (const entry of Object.values(output.requests ?? {})) {
		if (entry?.receipt) {
			keywordizeCollection({ receipt: entry.receipt }, BOARD_ENUM_FIELDS.receipt);
		}
	}
	if (output.tenure) delete output.tenure.retired;
	return toEdnValue(output);
}

function keywordizeCollection(collection, fields) {
	if (!collection || typeof collection !== "object" || !Array.isArray(fields)) return;
	for (const value of Object.values(collection)) {
		if (!value || typeof value !== "object") continue;
		for (const field of fields) {
			if (typeof value[field] === "string") {
				value[field] = new EdnKeyword(value[field].replace(/^:/, ""));
			}
		}
	}
}

function toEdnValue(value) {
	if (value instanceof EdnKeyword || value instanceof EdnSymbol) return value;
	if (Array.isArray(value)) return value.map(toEdnValue);
	if (value && typeof value === "object") {
		const map = new Map();
		for (const [key, entry] of Object.entries(value)) {
			if (entry === undefined) continue;
			map.set(ednKey(key), toEdnValue(entry));
		}
		return map;
	}
	return value === undefined ? null : value;
}

const KEYWORD_PART = /^[\p{L}_*+!?$%&=<>.-][\p{L}\p{N}_*+!?$%&=<>.-]*$/u;

function ednKey(key) {
	const parts = key.split("/");
	const valid =
		(parts.length === 1 && KEYWORD_PART.test(parts[0])) ||
		(parts.length === 2 &&
			parts[0].length > 0 &&
			parts[1].length > 0 &&
			KEYWORD_PART.test(parts[0]) &&
			KEYWORD_PART.test(parts[1]));
	return valid ? new EdnKeyword(key) : key;
}

async function writeBoardFile(path, board) {
	await writeFileAtomic(dirname(path), basename(path), `${printUfss(boardToEdn(board))}\n`);
}

function appendEvents(path, events) {
	if (!Array.isArray(events) || events.length === 0) return;
	const text = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
	const bytes = Buffer.from(text, "utf8");
	const fd = openSync(path, "a", 0o600);
	try {
		let offset = 0;
		while (offset < bytes.length) {
			const written = writeSync(fd, bytes, offset, bytes.length - offset);
			if (written <= 0) throw new Error("event append made no progress");
			offset += written;
		}
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function ensureFile(path) {
	if (existsSync(path)) return;
	const fd = openSync(path, "a", 0o600);
	closeSync(fd);
}

function fileSize(path) {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

function hasCommittedLedger(eventsPath, checkpointPath) {
	return fileSize(eventsPath) > 0 || existsSync(checkpointPath);
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * BoardControlPort for the protected-write pipeline.
 *
 * The caller supplies the openBoard handle (preferred) or a compatible store.
 * Claim or actor failures become `STALE_CONTROL` so a commit cannot touch the
 * disk after its qualification changed.
 */
export function createWriteGateControl(boardOrPath, options = {}) {
	const handle = resolveControlHandle(boardOrPath, options);
	const boardPath = handle?.boardPath ?? (typeof boardOrPath === "string" ? boardOrPath : null);

	function fieldsOf(call) {
		const actor = call.actor ?? call.identity ?? {};
		const claim = call.claim ?? {};
		return {
			agentId: call.agentId ?? call.agent_id ?? actor.agent_id ?? actor.agentId,
			termId: call.termId ?? call.term_id ?? actor.term_id ?? actor.termId,
			claimId: call.claimId ?? call.claim_id ?? claim.claim_id ?? claim.claimId,
			taskId: call.taskId ?? call.task_id ?? claim.task_id ?? claim.taskId ?? actor.task_id,
		};
	}

	async function run(command, call, expectedBoardVersion) {
		if (!handle) {
			return failure("INVALID_ARGUMENT", "write gate needs an openBoard handle or a store", {
				boardPath,
			});
		}
		const actor = call.actor ??
			call.identity ?? {
				agentId: call.agentId ?? call.agent_id,
				termId: call.termId ?? call.term_id,
			};
		return staleControl(
			await apply({
				board: handle,
				command,
				actor,
				turnId: call.turnId ?? call.turn_id ?? "write-gate",
				requestId: call.requestId ?? call.request_id,
				expectedBoardVersion,
			}),
		);
	}

	async function withActionId(pending) {
		const result = await pending;
		if (result?.ok) {
			const actionId = result.receipt?.actionId ?? result.receipt?.["action-id"] ?? result.actionId;
			if (typeof actionId === "string") result.actionId = actionId;
		}
		return result;
	}

	return {
		boardPath,
		/**
		 * Enter `:applying` before the real disk write. With `actionId`, move
		 * that action. Without it, create a new action for the claimed task.
		 */
		async markApplying(call = {}) {
			const fields = fieldsOf(call);
			const actionId = call.actionId ?? call.action_id;
			const command = actionId
				? {
						type: "setActionPhase",
						actionId,
						phase: "applying",
						claimId: fields.claimId,
					}
				: {
						type: "startAction",
						taskId: fields.taskId,
						claimId: fields.claimId,
						kind: normalizeControlKind(call.kind, "edit"),
						phase: "applying",
					};
			const requestId =
				call.requestId ??
				call.request_id ??
				`write-gate:apply:${call.batchId ?? call.batch_id ?? actionId ?? `${fields.taskId}:${fields.claimId}`}`;
			const expected = call.expectedBoardVersion ?? call.expected_board_version;
			return withActionId(run(command, { ...call, requestId }, expected));
		},
		/** Register a running shell action before a `call` starts. */
		async markRunning(call = {}) {
			const fields = fieldsOf(call);
			const actionId = call.actionId ?? call.action_id;
			const requestId =
				call.requestId ?? call.request_id ?? `write-gate:run:${actionId ?? `${fields.taskId}:${fields.claimId}`}`;
			const command = {
				type: "startAction",
				actionId,
				taskId: fields.taskId,
				claimId: fields.claimId,
				kind: normalizeControlKind(call.kind, "shell"),
				phase: "running",
			};
			const expected = call.expectedBoardVersion ?? call.expected_board_version;
			return withActionId(run(command, { ...call, requestId }, expected));
		},
		/** Mark the action finished after the write result is known. */
		async publishResult(call = {}) {
			const fields = fieldsOf(call);
			const actionId = call.actionId ?? call.action_id;
			const status = normalizeControlStatus(call.status);
			const phase = status === "uncertain" || status === "outcome-unknown" ? "uncertain" : "finished";
			const requestId = call.requestId ?? call.request_id ?? `write-gate:publish:${actionId}:${status}`;
			return withActionId(
				run(
					{
						type: "setActionPhase",
						actionId,
						phase,
						resultRef: call.resultRef ?? call.result_ref ?? null,
						claimId: fields.claimId,
					},
					{ ...call, requestId },
					call.expectedBoardVersion ?? call.expected_board_version,
				),
			);
		},
		/** Keep the action live but mark the outcome unknown. */
		async markUncertain(call = {}) {
			const fields = fieldsOf(call);
			const actionId = call.actionId ?? call.action_id;
			const requestId = call.requestId ?? call.request_id ?? `write-gate:uncertain:${actionId}`;
			return withActionId(
				run(
					{
						type: "setActionPhase",
						actionId,
						phase: "uncertain",
						resultRef: call.resultRef ?? call.result_ref ?? null,
						claimId: fields.claimId,
					},
					{ ...call, requestId },
					call.expectedBoardVersion ?? call.expected_board_version,
				),
			);
		},
	};
}

// ---------------------------------------------------------------------------
// Command handlers. Each handler mutates the cloned draft and returns a plain
// event description. The finalizer owns version, event ids, retirement, wake
// and idempotency recording.
// ---------------------------------------------------------------------------

const HANDLERS = {
	split(draft, context) {
		const command = context.command;
		const parentId = readField(command, "parentId", "parent_id");
		const remainingWork = readField(command, "remainingWork", "remaining_work");
		const children = command.children;
		const parent = draft.tasks[parentId];
		if (!parent) {
			return failure("INVALID_ARGUMENT", "parent task does not exist", { taskId: parentId });
		}
		if (parent.state === "done") {
			return failure("TASK_NOT_READY", "cannot split a done task", {
				taskId: parentId,
				current: parent.state,
			});
		}
		const active = activeActionForTask(draft, parentId);
		if (active && (active.phase === "applying" || active.phase === "running" || active.phase === "uncertain")) {
			return failure("TASK_NOT_READY", "cannot split while an action is executing", {
				taskId: parentId,
				actionId: active["action-id"],
				phase: active.phase,
			});
		}
		if (!isText(remainingWork)) {
			return failure("INVALID_ARGUMENT", "split needs a non-empty remaining_work", {
				taskId: parentId,
				field: "remaining_work",
			});
		}
		if (!Array.isArray(children) || children.length === 0) {
			return failure("INVALID_ARGUMENT", "split needs at least one child", { taskId: parentId });
		}

		const specs = [];
		for (let index = 0; index < children.length; index += 1) {
			const normalized = normalizeTaskSpec(children[index], `children[${index}]`);
			if (!normalized.ok) return normalized;
			specs.push(normalized.value);
		}

		const childIds = [];
		for (const spec of specs) {
			const child = appendTask(draft, {
				...spec,
				ownerId: null,
				ledgerKey: null,
				parentId,
			});
			childIds.push(child["task-id"]);
		}

		const rawWait = readField(command, "waitFor", "wait_for");
		const waitFor = normalizeWaitEntries(rawWait, childIds, draft, parentId);
		if (!waitFor) {
			return failure("INVALID_ARGUMENT", "wait_for is malformed or empty", {
				taskId: parentId,
				field: "wait_for",
			});
		}

		const releasedClaimId = parent["claim-id"];
		removeOrphanActionsForTask(draft, parentId);
		parent["claim-id"] = null;
		parent["claim-owner-id"] = null;
		parent["child-ids"] = uniqueValues([...parent["child-ids"], ...childIds]);
		parent["wait-for"] = uniqueValues([...(parent["wait-for"] ?? []), ...waitFor]);
		parent["remaining-work"] = remainingWork;
		parent.state = "waiting";
		parent["revived-turn-id"] = null;
		// wait_for may be a subset of the new children or a condition key.
		// If that declared wait set is already satisfied, the parent has no
		// current wait and must stay progressable as :ready.
		const revived = parent["wait-for"].length > 0 &&
			parent["wait-for"].every((entry) => isWaitSatisfied(draft, entry));
		if (revived) {
			parent.state = "ready";
			parent["wait-for"] = [];
			parent["revived-turn-id"] = context.turnId;
		}

		return {
			ok: true,
			receipt: {
				outcome: "split",
				parentId,
				childIds: clone(childIds),
				waitFor: clone(parent["wait-for"]),
				revivedParentIds: revived ? [parentId] : [],
				releasedClaimId,
			},
			eventType: "task-split",
			eventData: {
				parentId,
				childIds: clone(childIds),
				waitFor: clone(parent["wait-for"]),
				revivedParentIds: revived ? [parentId] : [],
				releasedClaimId,
			},
			wakeCause: "task-split",
		};
	},

	claim(draft, context) {
		const taskId = readField(context.command, "taskId", "task_id");
		const atomicityReason = readField(context.command, "atomicityReason", "atomicity_reason");
		const task = draft.tasks[taskId];
		if (!task) {
			return failure("INVALID_ARGUMENT", "task does not exist", { taskId });
		}
		if (task.state !== "ready") {
			return failure("TASK_NOT_READY", "task is not ready", {
				taskId,
				current: task.state,
			});
		}
		if (!isText(atomicityReason)) {
			return failure("INVALID_ARGUMENT", "claim needs a non-empty atomicity_reason", {
				taskId,
				field: "atomicity_reason",
			});
		}
		if (task["needs-token"] && !isHolder(draft, context.actorId)) {
			return failure("TOKEN_REQUIRED", "token task can be claimed by the Holder only", {
				taskId,
				holderId: draft["token-slot"]["holder-id"],
			});
		}
		const activeAction = activeActionForTask(draft, taskId);
		if (activeAction) {
			return failure("CLAIM_CONFLICT", "task already has an active action", {
				taskId,
				actionId: activeAction["action-id"],
				phase: activeAction.phase,
			});
		}
		if (!task["needs-token"] && task["owner-id"] && task["owner-id"] !== context.actorId) {
			return failure("CLAIM_CONFLICT", "task belongs to another actor", {
				taskId,
				ownerId: task["owner-id"],
				claimId: task["claim-id"],
			});
		}
		if (task["claim-id"]) {
			return failure("CLAIM_CONFLICT", "task is already claimed", {
				taskId,
				ownerId: task["owner-id"],
				claimId: task["claim-id"],
			});
		}

		const claimId = nextId(draft, "claim", "C");
		task["claim-id"] = claimId;
		task["claim-owner-id"] = context.actorId;
		if (!task["needs-token"] && !task["owner-id"]) {
			task["owner-id"] = context.actorId;
		}
		return {
			ok: true,
			receipt: {
				outcome: "claimed",
				taskId,
				claimId,
				ownerId: task["owner-id"],
				claimOwnerId: context.actorId,
			},
			eventType: "task-claimed",
			eventData: {
				taskId,
				claimId,
				"owner-id": task["owner-id"],
				"claim-owner-id": context.actorId,
			},
		};
	},

	finish(draft, context) {
		const taskId = readField(context.command, "taskId", "task_id");
		const claimId = readField(context.command, "claimId", "claim_id");
		const resultSummary = readField(context.command, "resultSummary", "result_summary");
		const dependencyPaths = readField(context.command, "dependencyPaths", "dependency_paths") ?? [];
		const task = draft.tasks[taskId];
		if (!task) {
			return failure("INVALID_ARGUMENT", "task does not exist", { taskId });
		}
		if (task["revived-turn-id"] === context.turnId) {
			return failure("PARENT_NOT_READY", "parent was revived in this turn", {
				taskId,
				turnId: context.turnId,
				next: "finish the parent in a new turn with integration evidence",
			});
		}
		if (task.state !== "ready") {
			return failure("TASK_NOT_READY", "task is not ready", {
				taskId,
				current: task.state,
			});
		}
		const activeAction = activeActionForTask(draft, taskId);
		if (activeAction) {
			return failure("TASK_NOT_READY", "task has an unfinished action", {
				taskId,
				actionId: activeAction["action-id"],
				phase: activeAction.phase,
			});
		}
		if (task["claim-id"] !== claimId || task["claim-owner-id"] !== context.actorId) {
			return failure("CLAIM_CHANGED", "claim or owner changed", {
				taskId,
				expectedClaimId: claimId,
				currentClaimId: task["claim-id"],
				expectedClaimOwnerId: context.actorId,
				currentClaimOwnerId: task["claim-owner-id"],
			});
		}
		if (!isText(resultSummary)) {
			return failure("INVALID_ARGUMENT", "finish needs a non-empty result_summary", {
				taskId,
				field: "result_summary",
			});
		}
		const normalizedDependencyPaths = validateDependencyPaths(dependencyPaths);
		if (normalizedDependencyPaths === null) {
			return failure("INVALID_ARGUMENT", "dependency_paths must be workspace-relative paths", {
				taskId,
				field: "dependency_paths",
			});
		}

		task.state = "done";
		task["claim-id"] = null;
		task["claim-owner-id"] = null;
		task["result-summary"] = resultSummary;
		task["dependency-paths"] = clone(normalizedDependencyPaths);
		task["revived-turn-id"] = null;

		const revivedParentIds = [];
		const waitingParents = new Set();
		if (task["parent-id"]) waitingParents.add(task["parent-id"]);
		for (const candidate of Object.values(draft.tasks)) {
			if (candidate.state !== "waiting") continue;
			if ((candidate["wait-for"] ?? []).some((entry) => waitEntryTaskId(entry) === taskId)) {
				waitingParents.add(candidate["task-id"]);
			}
		}
		for (const parentId of waitingParents) {
			const candidate = draft.tasks[parentId];
			if (candidate?.state !== "waiting") continue;
			const waits = candidate["wait-for"] ?? [];
			if (waits.length === 0) continue;
			if (!waits.every((entry) => isWaitSatisfied(draft, entry))) continue;
			candidate.state = "ready";
			candidate["wait-for"] = [];
			candidate["revived-turn-id"] = context.turnId;
			revivedParentIds.push(candidate["task-id"]);
		}

		return {
			ok: true,
			receipt: {
				outcome: "finished",
				taskId,
				revivedParentIds: clone(revivedParentIds),
			},
			eventType: "task-finished",
			eventData: { taskId, revivedParentIds: clone(revivedParentIds) },
			wakeCause: "parent-revived",
		};
	},

	cancel(draft, context) {
		const taskId = readField(context.command, "taskId", "task_id");
		const reason = readField(context.command, "reason");
		const task = draft.tasks[taskId];
		if (!task) {
			return failure("INVALID_ARGUMENT", "task does not exist", { taskId });
		}
		if (task.state === "done") {
			return failure("TASK_NOT_READY", "cannot cancel a done task", {
				taskId,
				current: task.state,
			});
		}
		if (hasOpenChildren(draft, task)) {
			return failure("TASK_HAS_CHILDREN", "cancel needs a leaf with no unfinished children", {
				taskId,
				children: task["child-ids"],
			});
		}
		if (!isText(reason)) {
			return failure("INVALID_ARGUMENT", "cancel needs a non-empty reason", {
				taskId,
				field: "reason",
			});
		}

		const revivedParentId = detachChildFromParent(draft, task, null, context.turnId);
		removeOrphanActionsForTask(draft, taskId);
		delete draft.tasks[taskId];
		return {
			ok: true,
			receipt: { outcome: "cancelled", taskId, revivedParentId },
			eventType: "task-cancelled",
			eventData: { taskId, reason, revivedParentId },
			wakeCause: "task-cancelled",
		};
	},

	replace(draft, context) {
		const taskId = readField(context.command, "taskId", "task_id");
		const reason = readField(context.command, "reason");
		const replacement = context.command.replacement;
		const task = draft.tasks[taskId];
		if (!task) {
			return failure("INVALID_ARGUMENT", "task does not exist", { taskId });
		}
		if (task.state === "done") {
			return failure("TASK_NOT_READY", "cannot replace a done task", {
				taskId,
				current: task.state,
			});
		}
		if (hasOpenChildren(draft, task)) {
			return failure("TASK_HAS_CHILDREN", "replace needs a leaf with no unfinished children", {
				taskId,
				children: task["child-ids"],
			});
		}
		if (!isText(reason)) {
			return failure("INVALID_ARGUMENT", "replace needs a non-empty reason", {
				taskId,
				field: "reason",
			});
		}
		const replacementNeedsToken = readField(replacement, "needsToken", "needs_token");
		const normalized = normalizeTaskSpec(replacement, "replacement");
		if (!normalized.ok) return normalized;
		const spec = normalized.value;
		if (replacementNeedsToken === undefined) spec.needsToken = task["needs-token"];

		const newTask = appendTask(draft, {
			...spec,
			ownerId: null,
			parentId: task["parent-id"],
			ledgerKey: task["ledger-key"],
		});
		detachChildFromParent(draft, task, newTask["task-id"], context.turnId);
		removeOrphanActionsForTask(draft, taskId);
		delete draft.tasks[taskId];
		return {
			ok: true,
			receipt: {
				outcome: "replaced",
				taskId,
				replacementId: newTask["task-id"],
			},
			eventType: "task-replaced",
			eventData: { taskId, replacementId: newTask["task-id"], reason },
			wakeCause: "task-replaced",
		};
	},

	release(draft, context) {
		const taskId = readField(context.command, "taskId", "task_id");
		const claimId = readField(context.command, "claimId", "claim_id");
		const task = draft.tasks[taskId];
		if (!task) {
			return failure("INVALID_ARGUMENT", "task does not exist", { taskId });
		}
		if (task.state !== "ready") {
			return failure("TASK_NOT_READY", "task is not ready", { taskId, current: task.state });
		}
		const activeAction = activeActionForTask(draft, taskId);
		if (activeAction && !["claimed", "preparing", "waiting-gate"].includes(activeAction.phase)) {
			return failure("CLAIM_CHANGED", "cannot release after applying", {
				taskId,
				actionId: activeAction["action-id"],
				phase: activeAction.phase,
			});
		}
		if (task["claim-id"] !== claimId || task["claim-owner-id"] !== context.actorId) {
			return failure("CLAIM_CHANGED", "claim or owner changed", {
				taskId,
				expectedClaimId: claimId,
				currentClaimId: task["claim-id"],
				expectedClaimOwnerId: context.actorId,
				currentClaimOwnerId: task["claim-owner-id"],
			});
		}
		removeOrphanActionsForTask(draft, taskId);
		task["claim-id"] = null;
		task["claim-owner-id"] = null;
		if (!task["needs-token"]) task["owner-id"] = null;
		return {
			ok: true,
			receipt: { outcome: "released", taskId },
			eventType: "task-released",
			eventData: { taskId },
			wakeCause: "task-released",
		};
	},

	reopen(draft, context) {
		const taskId = readField(context.command, "taskId", "task_id");
		const reason = readField(context.command, "reason");
		const evidence = readField(context.command, "evidence");
		const task = draft.tasks[taskId];
		if (!task) {
			return failure("INVALID_ARGUMENT", "task does not exist", { taskId });
		}
		if (task.state !== "done") {
			return failure("TASK_NOT_READY", "only a done task can be reopened", {
				taskId,
				current: task.state,
			});
		}
		if (!isText(reason)) {
			return failure("INVALID_ARGUMENT", "reopen needs a non-empty reason", {
				taskId,
				field: "reason",
			});
		}
		if (!hasEvidence(evidence)) {
			return failure("INVALID_ARGUMENT", "reopen needs evidence", { taskId, field: "evidence" });
		}
		task.state = "ready";
		task["claim-id"] = null;
		task["claim-owner-id"] = null;
		task["revived-turn-id"] = null;
		const owner = draft.actors[task["owner-id"]];
		if (owner?.["life-state"] !== "alive") task["owner-id"] = null;
		return {
			ok: true,
			receipt: { outcome: "reopened", taskId },
			eventType: "task-reopened",
			eventData: { taskId, reason, evidence: clone(evidence) },
			forceWake: true,
			wakeCause: "task-reopened",
		};
	},

	comment(draft, context) {
		const taskId = readField(context.command, "taskId", "task_id");
		const text = readField(context.command, "text");
		const task = draft.tasks[taskId];
		if (!task) {
			return failure("INVALID_ARGUMENT", "task does not exist", { taskId });
		}
		if (!isText(text)) {
			return failure("INVALID_ARGUMENT", "comment needs non-empty text", {
				taskId,
				field: "text",
			});
		}
		const comment = {
			"agent-id": context.actorId,
			"turn-id": context.turnId,
			"board-version": draft["board-version"] + 1,
			text,
		};
		task.comments = [...(task.comments ?? []), comment];
		return {
			ok: true,
			receipt: { outcome: "commented", taskId },
			eventType: "task-commented",
			eventData: { taskId, text },
		};
	},

	update(draft, context) {
		const taskId = readField(context.command, "taskId", "task_id");
		const fields = context.command.fields;
		const task = draft.tasks[taskId];
		if (!task) {
			return failure("INVALID_ARGUMENT", "task does not exist", { taskId });
		}
		if (task.state === "done") {
			return failure("TASK_NOT_READY", "cannot update a done task", {
				taskId,
				current: task.state,
			});
		}
		if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
			return failure("INVALID_ARGUMENT", "update needs a fields object", { taskId });
		}
		const changes = {};
		for (const [key, value] of Object.entries(fields)) {
			if (key === "goal") {
				if (!isText(value)) return failure("INVALID_ARGUMENT", "goal must be non-empty", { taskId });
				task.goal = value;
				changes.goal = value;
			} else if (key === "remainingWork" || key === "remaining_work") {
				if (!isText(value)) {
					return failure("INVALID_ARGUMENT", "remaining_work must be non-empty", { taskId });
				}
				task["remaining-work"] = value;
				changes["remaining-work"] = value;
			} else if (key === "doneWhen" || key === "done_when") {
				if (!isText(value)) {
					return failure("INVALID_ARGUMENT", "done_when must be non-empty", { taskId });
				}
				task["done-when"] = value;
				changes["done-when"] = value;
			} else if (key === "needsToken" || key === "needs_token") {
				if (typeof value !== "boolean") {
					return failure("INVALID_ARGUMENT", "needs_token must be boolean", { taskId });
				}
				if (value !== task["needs-token"] && task["claim-id"]) {
					return failure("CLAIM_CONFLICT", "cannot change needs_token while claimed", {
						taskId,
						claimId: task["claim-id"],
					});
				}
				task["needs-token"] = value;
				changes["needs-token"] = value;
			} else {
				return failure("INVALID_ARGUMENT", "update field is not allowed", {
					taskId,
					field: key,
				});
			}
		}
		if (Object.keys(changes).length === 0) {
			return failure("INVALID_ARGUMENT", "update needs at least one field", { taskId });
		}
		return {
			ok: true,
			receipt: { outcome: "updated", taskId, fields: changes },
			eventType: "task-updated",
			eventData: { taskId, fields: changes },
			wakeCause: "task-updated",
		};
	},

	parkSlot(draft, context) {
		const observed = firstDefined(
			readField(context.command, "observedBoardVersion", "observed_board_version"),
			readField(context.command, "expectedBoardVersion", "expected_board_version"),
		);
		if (!Number.isInteger(observed)) {
			return failure("INVALID_ARGUMENT", "park needs observed_board_version", {
				field: "observed_board_version",
			});
		}
		if (observed !== draft["board-version"]) {
			return failure("BOARD_CONFLICT", "board version changed", {
				expected: observed,
				current: draft["board-version"],
				summary: progressableSummary(draft),
			});
		}
		const progressable = progressableSet(draft);
		if (progressable.length > 0) {
			return failure("BOARD_CONFLICT", "board still has progressable work", {
				current: draft["board-version"],
				summary: progressableSummary(draft),
			});
		}
		draft.sleepers[context.actorId] = {
			"agent-id": context.actorId,
			"slot-id": draft.actors[context.actorId]?.["slot-id"] ?? null,
			"since-version": draft["board-version"],
			"wake-epoch": draft.wake.epoch,
		};
		return {
			ok: true,
			receipt: {
				outcome: "parked",
				agentId: context.actorId,
				"wake-epoch": draft.wake.epoch,
			},
			eventType: "slot-parked",
			eventData: { "agent-id": context.actorId },
		};
	},

	takeOrDie(draft, context) {
		const accepted = acceptAttempt(draft, context);
		if (!accepted.ok) return accepted;
		if (accepted.skipCommit) return accepted;
		const resolved = resolveAttempt(draft, accepted.attempt);
		if (!resolved.ok) return resolved;
		resolved.receipt["accepted-version"] = accepted.attempt["observed-version"];
		resolved.receipt["token-tasks"] = clone(accepted.attempt["token-tasks"]);
		resolved.eventData["accepted-version"] = accepted.attempt["observed-version"];
		resolved.eventData["token-tasks"] = clone(accepted.attempt["token-tasks"]);
		return resolved;
	},

	acceptTake(draft, context) {
		const accepted = acceptAttempt(draft, context);
		if (!accepted.ok) return accepted;
		if (accepted.skipCommit) return accepted;
		const attempt = accepted.attempt;
		return {
			ok: true,
			receipt: {
				outcome: "attempt-accepted",
				attemptId: attempt["request-id"],
				agentId: attempt["agent-id"],
				tokenState: attempt["token-state"],
				tokenTasks: clone(attempt["token-tasks"]),
			},
			eventType: "token-attempt-accepted",
			eventData: {
				"attempt-id": attempt["request-id"],
				"agent-id": attempt["agent-id"],
				"token-state": attempt["token-state"],
				"token-tasks": clone(attempt["token-tasks"]),
			},
			wakeCause: "token-attempt-accepted",
		};
	},

	resolveTake(draft, context) {
		const attemptId =
			readField(context.command, "attemptId", "attempt_id") ??
			readField(context.command, "acceptRequestId", "accept_request_id");
		if (!isText(attemptId)) {
			return failure("INVALID_ARGUMENT", "resolve_take needs attempt_id", {
				field: "attempt_id",
			});
		}
		const attempt = draft["take-attempts"]?.[attemptId];
		if (!attempt) {
			return failure("INVALID_ARGUMENT", "accepted take attempt does not exist", {
				attemptId,
			});
		}
		if (attempt["agent-id"] !== context.actorId) {
			return failure("ACTOR_DEAD", "accepted attempt belongs to another actor", {
				attemptId,
				agentId: context.actorId,
				ownerId: attempt["agent-id"],
			});
		}
		return resolveAttempt(draft, attempt);
	},

	registerActor(draft, context) {
		const raw = context.command.agent ??
			readField(context.command, "actor") ?? {
				agentId: readField(context.command, "agentId", "agent_id"),
				slotId: readField(context.command, "slotId", "slot_id"),
				role: context.command.role,
			};
		let actor;
		try {
			actor = normalizeActorSpec(raw);
		} catch (error) {
			return failure("INVALID_ARGUMENT", error.message, {});
		}
		if (draft.actors[actor["agent-id"]]) {
			return failure("NAME_TAKEN", "agent_id already exists", {
				agentId: actor["agent-id"],
			});
		}
		draft.actors[actor["agent-id"]] = actor;
		return {
			ok: true,
			receipt: { outcome: "actor-registered", agentId: actor["agent-id"], slotId: actor["slot-id"] },
			eventType: "actor-registered",
			eventData: { "agent-id": actor["agent-id"], "slot-id": actor["slot-id"], role: actor.role },
			wakeCause: "actor-registered",
		};
	},

	recordInput(draft, context) {
		const text = readField(context.command, "text", "input");
		if (!isText(text)) {
			return failure("INVALID_ARGUMENT", "record_input needs the original text", {
				field: "text",
			});
		}
		const inputId = nextId(draft, "input", "I");
		draft.inputs.push({
			"input-id": inputId,
			text,
			"board-version": draft["board-version"] + 1,
			"turn-id": context.turnId,
		});
		return {
			ok: true,
			receipt: { outcome: "input-recorded", inputId, text },
			eventType: "user-input",
			eventData: { inputId, text },
			forceWake: true,
			wakeCause: "user-input",
		};
	},

	addTasks(draft, context) {
		const specs = context.command.tasks;
		if (!Array.isArray(specs) || specs.length === 0) {
			return failure("INVALID_ARGUMENT", "add_tasks needs at least one task", {});
		}
		const taskIds = [];
		for (let index = 0; index < specs.length; index += 1) {
			const normalized = normalizeTaskSpec(specs[index], `tasks[${index}]`);
			if (!normalized.ok) return normalized;
			const task = appendTask(draft, normalized.value);
			taskIds.push(task["task-id"]);
		}
		return {
			ok: true,
			receipt: { outcome: "tasks-added", taskIds: clone(taskIds) },
			eventType: "tasks-added",
			eventData: { taskIds: clone(taskIds) },
			wakeCause: "tasks-added",
		};
	},

	resolveCondition(draft, context) {
		const key = readField(context.command, "key", "condition");
		const rawValue = readField(context.command, "value");
		const value = rawValue === undefined ? true : rawValue;
		if (!isText(key)) {
			return failure("INVALID_ARGUMENT", "resolve_condition needs a condition key", {
				field: "key",
			});
		}
		if (typeof value !== "boolean") {
			return failure("INVALID_ARGUMENT", "condition value must be boolean", {
				field: "value",
			});
		}
		draft.conditions[key] = value;
		const revivedTaskIds = [];
		if (value) {
			for (const task of Object.values(draft.tasks)) {
				if (task.state !== "waiting") continue;
				const waits = task["wait-for"] ?? [];
				if (waits.length === 0) continue;
				const usesCondition = waits.some((entry) => conditionWaitKey(entry) === key);
				if (!usesCondition) continue;
				if (!waits.every((entry) => isWaitSatisfied(draft, entry))) continue;
				task.state = "ready";
				task["wait-for"] = [];
				task["revived-turn-id"] = context.turnId;
				revivedTaskIds.push(task["task-id"]);
			}
		}
		return {
			ok: true,
			receipt: { outcome: "condition-resolved", key, value, revivedTaskIds },
			eventType: "condition-resolved",
			eventData: { key, value, revivedTaskIds: clone(revivedTaskIds) },
			wakeCause: "condition-resolved",
		};
	},

	startAction(draft, context) {
		const taskId = readField(context.command, "taskId", "task_id");
		const claimId = readField(context.command, "claimId", "claim_id");
		const kind = readField(context.command, "kind") ?? "edit";
		const phase = readField(context.command, "phase") ?? "preparing";
		const actionIdArg = readField(context.command, "actionId", "action_id");
		const task = draft.tasks[taskId];
		if (!task) {
			return failure("INVALID_ARGUMENT", "task does not exist", { taskId });
		}
		if (task.state !== "ready") {
			return failure("TASK_NOT_READY", "task is not ready", { taskId, current: task.state });
		}
		if (task["claim-id"] !== claimId || task["claim-owner-id"] !== context.actorId) {
			return failure("CLAIM_CHANGED", "claim or owner changed", {
				taskId,
				expectedClaimId: claimId,
				currentClaimId: task["claim-id"],
				expectedClaimOwnerId: context.actorId,
				currentClaimOwnerId: task["claim-owner-id"],
			});
		}
		if (!ACTION_KINDS.has(kind)) {
			return failure("INVALID_ARGUMENT", "unknown action kind", { kind });
		}
		if (!ACTION_PHASES.has(phase)) {
			return failure("INVALID_ARGUMENT", "unknown action phase", { phase });
		}
		if (phase === "finished") {
			return failure("INVALID_ARGUMENT", "an action cannot start finished", { phase });
		}
		if (kind === "shell" && !isHolder(draft, context.actorId)) {
			return failure("TOKEN_REQUIRED", "shell action needs the Holder", {
				taskId,
				holderId: draft["token-slot"]["holder-id"],
			});
		}
		const active = activeActionForActor(draft, context.actorId);
		if (active) {
			return failure("INVALID_ARGUMENT", "actor already has an active action", {
				agentId: context.actorId,
				actionId: active?.["action-id"] ?? null,
				phase: active?.phase ?? null,
			});
		}
		if (hasActiveActionForTask(draft, taskId)) {
			const active = activeActionForTask(draft, taskId);
			return failure("INVALID_ARGUMENT", "task already has an active action", {
				taskId,
				actionId: active?.["action-id"] ?? null,
				phase: active?.phase ?? null,
			});
		}
		const actionId = actionIdArg ?? nextId(draft, "action", "A");
		if (draft.actions[actionId]) {
			return failure("NAME_TAKEN", "action_id already exists", { actionId });
		}
		const action = {
			"action-id": actionId,
			"task-id": taskId,
			"agent-id": context.actorId,
			"claim-id": claimId,
			kind,
			phase,
			"request-id": context.requestId,
			"result-ref": null,
		};
		draft.actions[actionId] = action;
		const actor = draft.actors[context.actorId];
		actor["active-action-id"] = phase === "finished" || phase === "uncertain" ? null : actionId;
		return {
			ok: true,
			receipt: { outcome: "action-started", actionId, taskId, phase },
			eventType: "action-started",
			eventData: { actionId, taskId, phase, kind },
			wakeCause: "action-started",
		};
	},

	setActionPhase(draft, context) {
		const actionId = readField(context.command, "actionId", "action_id");
		const phase = readField(context.command, "phase");
		const resultRef = readField(context.command, "resultRef", "result_ref") ?? null;
		const claimId = readField(context.command, "claimId", "claim_id");
		const action = draft.actions[actionId];
		if (!action) {
			return failure("INVALID_ARGUMENT", "action does not exist", { actionId });
		}
		if (action["agent-id"] !== context.actorId) {
			return failure("ACTOR_DEAD", "action belongs to another actor", {
				actionId,
				agentId: context.actorId,
				current: action["agent-id"],
			});
		}
		if (claimId !== undefined && claimId !== action["claim-id"]) {
			return failure("CLAIM_CHANGED", "action claim changed", {
				actionId,
				expectedClaimId: claimId,
				currentClaimId: action["claim-id"],
			});
		}
		if (!ACTION_PHASES.has(phase)) {
			return failure("INVALID_ARGUMENT", "unknown action phase", { phase });
		}
		const allowed = ACTION_TRANSITIONS.get(action.phase);
		if (!allowed?.has(phase)) {
			return failure("INVALID_ARGUMENT", "action phase transition is not allowed", {
				actionId,
				from: action.phase,
				to: phase,
			});
		}
		if (action.kind === "shell" && phase !== "finished" && phase !== "uncertain") {
			if (!isHolder(draft, context.actorId)) {
				return failure("TOKEN_REQUIRED", "shell action needs the Holder", {
					actionId,
					holderId: draft["token-slot"]["holder-id"],
				});
			}
		}
		action.phase = phase;
		if (resultRef !== null) action["result-ref"] = resultRef;
		const actor = draft.actors[context.actorId];
		if (phase === "finished" || phase === "uncertain") {
			actor["active-action-id"] = null;
		} else {
			actor["active-action-id"] = actionId;
		}
		return {
			ok: true,
			receipt: { outcome: "action-phase", actionId, phase },
			eventType: "action-phase",
			eventData: { actionId, phase, resultRef },
			wakeCause: "action-phase",
		};
	},
};

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

function openTokenTaskIds(board) {
	return Object.values(board.tasks ?? {})
		.filter((task) => task["needs-token"] && (task.state === "ready" || task.state === "waiting"))
		.map((task) => task["task-id"]);
}

function pendingTakeAttempt(board, agentId) {
	return (
		Object.values(board["take-attempts"] ?? {}).find(
			(attempt) => attempt["agent-id"] === agentId && attempt.resolved !== true,
		) ?? null
	);
}

/**
 * Acceptance boundary of `take_or_die`. An accepted attempt is public and
 * durable; later cancellation of the last token task cannot revoke it.
 */
function acceptAttempt(draft, context) {
	const originalRequestId = readField(context.command, "originalRequestId", "original_request_id");
	if (isText(originalRequestId)) {
		const existing = draft.requests?.[originalRequestId];
		if (existing) {
			return failure("CALL_REPLAY_MISMATCH", "request_id was used with a different payload", {
				requestId: originalRequestId,
				existing: clone(existing.receipt ?? null),
			});
		}
	}
	const confirm = readField(context.command, "confirm");
	const handoffMarkdown = readField(context.command, "handoffMarkdown", "handoff_markdown");
	if (confirm !== TAKE_OR_DIE_CONFIRMATION) {
		return failure("CONFIRMATION_REQUIRED", "exact confirmation string is required", {
			expected: TAKE_OR_DIE_CONFIRMATION,
			actual: confirm ?? null,
		});
	}
	if (!isText(handoffMarkdown)) {
		return failure("INVALID_ARGUMENT", "take_or_die needs non-empty handoff_markdown", {
			field: "handoff_markdown",
		});
	}
	const actor = draft.actors[context.actorId];
	if (!actor) {
		return failure("ACTOR_DEAD", "actor is not registered", {
			agentId: context.actorId,
		});
	}
	const token = draft["token-slot"];
	if (token["holder-id"] === context.actorId) {
		return failure("INVALID_ARGUMENT", "actor already holds the token", {
			agentId: context.actorId,
			termId: token["term-id"],
		});
	}
	const pending = pendingTakeAttempt(draft, context.actorId);
	if (pending) {
		return failure("INVALID_ARGUMENT", "actor already has a pending take attempt", {
			agentId: context.actorId,
			requestId: pending["request-id"],
		});
	}
	for (const action of Object.values(draft.actions)) {
		if (action["agent-id"] !== context.actorId) continue;
		if (action.phase === "applying" || action.phase === "running" || action.phase === "uncertain") {
			return failure("INVALID_ARGUMENT", "actor has an in-flight or unresolved action", {
				agentId: context.actorId,
				actionId: action["action-id"],
				phase: action.phase,
			});
		}
	}

	const tokenTasks = openTokenTaskIds(draft);
	const tokenHeld = token["holder-id"] !== null;
	if (!tokenHeld && tokenTasks.length === 0) {
		return {
			ok: true,
			changed: false,
			receipt: {
				outcome: "no-progressable-work",
				code: "NO_PROGRESSABLE_WORK",
				agentId: context.actorId,
				"board-version": draft["board-version"],
				"wake-epoch": draft.wake.epoch,
				tokenTasks: [],
			},
			eventType: "token-attempt-skipped",
			eventData: { "agent-id": context.actorId, reason: "no-token-work" },
			skipCommit: true,
		};
	}

	const attempt = {
		"request-id": context.requestId,
		"agent-id": context.actorId,
		"term-id": actor["term-id"] ?? null,
		"observed-version": draft["board-version"],
		"token-state": tokenHeld ? "held" : "free",
		"token-tasks": tokenTasks,
		"handoff-markdown": handoffMarkdown,
		resolved: false,
		outcome: null,
		"resolved-version": null,
	};
	draft["take-attempts"][attempt["request-id"]] = attempt;
	actor["take-attempt-id"] = attempt["request-id"];
	return { ok: true, attempt };
}

/**
 * Resolve one accepted attempt. The token slot decides win or loss; the
 * accepted record is never discarded, even if every token task was cancelled.
 */
function resolveAttempt(draft, attempt) {
	if (attempt.resolved === true) {
		return {
			ok: true,
			changed: false,
			skipCommit: true,
			receipt: {
				outcome: attempt.outcome ?? "attempt-resolved",
				attemptId: attempt["request-id"],
				agentId: attempt["agent-id"],
				reason: attempt.reason ?? null,
				"board-version": draft["board-version"],
				"wake-epoch": draft.wake.epoch,
			},
			eventType: "token-attempt-replayed",
			eventData: { "attempt-id": attempt["request-id"] },
		};
	}

	const token = draft["token-slot"];
	const actor = draft.actors[attempt["agent-id"]];
	const holderId = token["holder-id"];
	const handoffMarkdown = attempt["handoff-markdown"];

	if (!actor) {
		markAttemptResolved(attempt, "attempt-lost", draft["board-version"], "actor-dead");
		return {
			ok: true,
			receipt: {
				outcome: "attempt-lost",
				agentId: attempt["agent-id"],
				handedOffTaskIds: [],
				attemptId: attempt["request-id"],
				reason: "actor-dead",
				lostAttempts: [],
			},
			eventType: "token-lost",
			eventData: {
				"agent-id": attempt["agent-id"],
				"attempt-id": attempt["request-id"],
				reason: "actor-dead",
				lostAttempts: [],
			},
			wakeCause: "token-lost",
		};
	}
	if (actor["life-state"] !== "alive") {
		const loss = loseTokenAttempt(draft, { actorId: attempt["agent-id"] }, handoffMarkdown);
		markAttemptResolved(attempt, "attempt-lost", draft["board-version"], "actor-dead");
		clearActorTakeAttempt(draft, attempt["agent-id"]);
		const lostAttempts =
			holderId !== null ? resolveOtherPendingAttemptsAsLost(draft, attempt["request-id"], "token-held") : [];
		return {
			ok: true,
			receipt: {
				...loss.receipt,
				attemptId: attempt["request-id"],
				reason: "actor-dead",
				lostAttempts,
			},
			eventType: "token-lost",
			eventData: {
				...loss.eventData,
				"attempt-id": attempt["request-id"],
				reason: "actor-dead",
				lostAttempts,
			},
			wakeCause: "token-lost",
		};
	}

	if (holderId !== null && holderId !== attempt["agent-id"]) {
		const loss = loseTokenAttempt(draft, { actorId: attempt["agent-id"] }, handoffMarkdown);
		markAttemptResolved(attempt, "attempt-lost", draft["board-version"], "token-held");
		clearActorTakeAttempt(draft, attempt["agent-id"]);
		const lostAttempts = resolveOtherPendingAttemptsAsLost(draft, attempt["request-id"], "token-held");
		return {
			ok: true,
			receipt: { ...loss.receipt, attemptId: attempt["request-id"], lostAttempts },
			eventType: "token-lost",
			eventData: {
				...loss.eventData,
				"attempt-id": attempt["request-id"],
				lostAttempts,
			},
			wakeCause: "token-lost",
		};
	}

	let termId = token["term-id"];
	if (holderId === null) {
		termId = nextId(draft, "term", "TERM");
		token["holder-id"] = attempt["agent-id"];
		token["term-id"] = termId;
		token.state = "held";
		actor.role = "holder";
		actor["term-id"] = termId;
		actor["life-state"] = "alive";
	}
	markAttemptResolved(attempt, "attempt-won", draft["board-version"], null);
	clearActorTakeAttempt(draft, attempt["agent-id"]);
	const lostAttempts = resolveOtherPendingAttemptsAsLost(draft, attempt["request-id"], "token-won-by-other");
	const tokenTasks = openTokenTaskIds(draft);
	return {
		ok: true,
		receipt: {
			outcome: "attempt-won",
			agentId: attempt["agent-id"],
			termId,
			tokenTasks: clone(tokenTasks),
			lostAttempts,
		},
		eventType: "token-won",
		eventData: {
			"agent-id": attempt["agent-id"],
			termId,
			"attempt-id": attempt["request-id"],
			tokenTasks: clone(tokenTasks),
			lostAttempts,
		},
		wakeCause: "token-won",
	};
}

function markAttemptResolved(attempt, outcome, version, reason) {
	attempt.resolved = true;
	attempt.outcome = outcome;
	attempt["resolved-version"] = version;
	if (reason) attempt.reason = reason;
}

function clearActorTakeAttempt(draft, agentId) {
	const actor = draft.actors[agentId];
	if (actor) actor["take-attempt-id"] = null;
}

function resolveOtherPendingAttemptsAsLost(draft, keepAttemptId, reason) {
	const lost = [];
	for (const other of Object.values(draft["take-attempts"])) {
		if (other["request-id"] === keepAttemptId || other.resolved === true) continue;
		const agentId = other["agent-id"];
		const actor = draft.actors[agentId];
		if (!actor) {
			markAttemptResolved(other, "attempt-lost", draft["board-version"], reason);
			continue;
		}
		const loss = loseTokenAttempt(draft, { actorId: agentId }, other["handoff-markdown"]);
		markAttemptResolved(other, "attempt-lost", draft["board-version"], reason);
		clearActorTakeAttempt(draft, agentId);
		lost.push({
			attemptId: other["request-id"],
			agentId,
			handedOffTaskIds: loss.receipt.handedOffTaskIds,
		});
	}
	return lost;
}

function loseTokenAttempt(draft, context, handoffMarkdown) {
	const handedOffTaskIds = [];
	for (const task of Object.values(draft.tasks)) {
		if (task.state === "done") continue;
		const owned = task["owner-id"] === context.actorId;
		const claimed = task["claim-owner-id"] === context.actorId;
		if (!owned && !claimed) continue;
		if (owned && !task["needs-token"]) task["owner-id"] = null;
		if (claimed) {
			task["claim-id"] = null;
			task["claim-owner-id"] = null;
		}
		task["handoff-note"] = handoffMarkdown;
		handedOffTaskIds.push(task["task-id"]);
	}
	for (const [actionId, action] of Object.entries(draft.actions)) {
		if (action["agent-id"] !== context.actorId) continue;
		if (action.phase === "claimed" || action.phase === "preparing" || action.phase === "waiting-gate") {
			delete draft.actions[actionId];
		}
	}
	const actor = draft.actors[context.actorId];
	actor["life-state"] = "dead";
	actor["active-action-id"] = null;
	delete draft.sleepers[context.actorId];
	return {
		ok: true,
		receipt: {
			outcome: "attempt-lost",
			agentId: context.actorId,
			handedOffTaskIds,
		},
		eventType: "token-lost",
		eventData: {
			"agent-id": context.actorId,
			handedOffTaskIds,
			handoff: handoffMarkdown,
		},
		wakeCause: "token-lost",
	};
}

/**
 * Retire a Holder with no responsibility. The token, the actor life state and
 * the retired term all change in the same transition.
 */
function settleHolder(board) {
	const token = board["token-slot"];
	const holderId = token["holder-id"];
	if (!holderId) return null;
	const actor = board.actors[holderId];
	if (actor?.["life-state"] !== "alive") {
		return retireHolder(board, holderId, "holder-missing");
	}
	if (responsibilitySet(board, holderId).length > 0) return null;
	return retireHolder(board, holderId, "no-responsibility");
}

function retireHolder(board, holderId, reason) {
	const token = board["token-slot"];
	const termId = token["term-id"];
	if (termId && !token["retired-terms"].includes(termId)) {
		token["retired-terms"].push(termId);
	}
	token["holder-id"] = null;
	token["term-id"] = null;
	token.state = "free";
	const actor = board.actors[holderId];
	if (actor) {
		actor["life-state"] = "dead";
		actor["active-action-id"] = null;
	}
	delete board.sleepers[holderId];
	return { "agent-id": holderId, "term-id": termId, reason };
}

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

/**
 * Fill fields that an older or partial board value may miss. The kernel never
 * trusts a persisted shape blindly, but it also never invents work.
 */
function ensureBoardShape(board) {
	board["board-version"] = Number.isInteger(board["board-version"]) ? board["board-version"] : 0;
	board.mode ??= "swarm";
	board["attach-ready"] ??= false;
	board["review-summary"] ??= null;
	board.tasks ??= {};
	if (board.mode === "plan") ensurePlanTasks(board);
	board.actions ??= {};
	board.actors ??= {};
	board["token-slot"] ??= {};
	board["token-slot"]["holder-id"] ??= null;
	board["token-slot"]["term-id"] ??= null;
	board["token-slot"].state ??= "free";
	board["token-slot"]["retired-terms"] ??= [];
	board.tenure ??= { term: 0, phase: board.mode === "plan" ? "plan" : "swarm" };
	delete board.tenure.retired;
	board["next-ids"] ??= {};
	for (const [key, start] of [
		["task", 1],
		["claim", 1],
		["term", 1],
		["action", 1],
		["event", 1],
		["input", 1],
	]) {
		if (!Number.isInteger(board["next-ids"][key])) board["next-ids"][key] = start;
	}
	board.requests ??= {};
	board["take-attempts"] ??= {};
	board.sleepers ??= {};
	board.wake ??= { epoch: 0 };
	board.wake.epoch ??= 0;
	board.conditions ??= {};
	board.inputs ??= [];
}

function ensurePlanTasks(board) {
	for (const [key, task] of Object.entries(board.tasks ?? {})) {
		if (!task || typeof task !== "object") continue;
		task.key ??= key;
		if (task.value === undefined) task.value = null;
		task["parent-key"] ??= null;
		task["child-keys"] ??= [];
		task["wait-for"] ??= [];
		task.waiting ??= false;
	}
}

function setPlanParent(board, task, parentKey) {
	const previous = task["parent-key"] ?? null;
	if (previous === parentKey) return;
	if (previous && board.tasks[previous]) {
		board.tasks[previous]["child-keys"] = (board.tasks[previous]["child-keys"] ?? []).filter(
			(child) => child !== task.key,
		);
	}
	task["parent-key"] = parentKey ?? null;
	if (parentKey && board.tasks[parentKey]) {
		const children = board.tasks[parentKey]["child-keys"] ?? [];
		if (!children.includes(task.key)) children.push(task.key);
		board.tasks[parentKey]["child-keys"] = children;
	}
}

function upsertPlanTask(board, key, value, relation = {}) {
	const task = board.tasks[key] ?? {
		key,
		value: null,
		"parent-key": null,
		"child-keys": [],
		"wait-for": [],
		waiting: false,
	};
	task.key = key;
	task.value = value;
	if (relation.parentKey !== undefined) setPlanParent(board, task, relation.parentKey);
	if (relation.waitFor !== undefined) task["wait-for"] = uniqueValues(relation.waitFor);
	if (relation.waiting !== undefined) task.waiting = relation.waiting;
	board.tasks[key] = task;
}

function deletePlanTask(board, key) {
	const task = board.tasks[key];
	if (!task) return;
	const parentKey = task["parent-key"] ?? null;
	if (parentKey && board.tasks[parentKey]) {
		board.tasks[parentKey]["child-keys"] = (board.tasks[parentKey]["child-keys"] ?? []).filter(
			(child) => child !== key,
		);
	}
	for (const other of Object.values(board.tasks)) {
		if (other === task) continue;
		if (other["parent-key"] === key) other["parent-key"] = null;
		other["child-keys"] = (other["child-keys"] ?? []).filter((child) => child !== key);
		other["wait-for"] = (other["wait-for"] ?? []).filter((entry) => entry !== key);
	}
	delete board.tasks[key];
}

function isValidPlanBoard(value) {
	if (!value.actions || typeof value.actions !== "object") return false;
	for (const [key, task] of Object.entries(value.tasks)) {
		if (!task || typeof task !== "object") return false;
		if (task.key !== undefined && task.key !== key) return false;
		if (task.value !== null && task.value !== undefined && typeof task.value !== "string") return false;
		const parentKey = task["parent-key"];
		if (parentKey !== null && parentKey !== undefined) {
			if (typeof parentKey !== "string" || !value.tasks[parentKey]) return false;
		}
		if (!Array.isArray(task["child-keys"]) || !Array.isArray(task["wait-for"])) return false;
		if (task.waiting !== undefined && typeof task.waiting !== "boolean") return false;
		for (const entry of task["wait-for"]) {
			if (typeof entry !== "string" || !value.tasks[entry]) return false;
		}
	}
	return true;
}

function normalizeApplyArgs(raw) {
	const command = raw.command ?? (raw.type ? raw : {});
	return {
		command,
		actor: raw.actor,
		turnId: firstDefined(raw.turnId, raw.turn_id),
		requestId: firstDefined(raw.requestId, raw.request_id),
		expectedBoardVersion: firstDefined(raw.expectedBoardVersion, raw.expected_board_version),
	};
}

function commandType(command) {
	const raw = typeof command === "string" ? command : readField(command, "type", "command", "name");
	if (typeof raw !== "string") return null;
	return COMMAND_TYPES.get(raw) ?? null;
}

function normalizeActorSpec(spec) {
	const agentId = readField(spec, "agentId", "agent_id");
	const slotId = readField(spec, "slotId", "slot_id") ?? agentId;
	const role = readField(spec, "role") ?? "normal";
	if (!isText(agentId)) throw new TypeError("actor needs agent_id");
	if (!isText(slotId)) throw new TypeError("actor needs slot_id");
	if (!ROLE_VALUES.has(role)) throw new TypeError(`unknown actor role: ${role}`);
	return {
		"agent-id": agentId,
		"slot-id": slotId,
		role,
		"life-state": "alive",
		"active-action-id": null,
		"term-id": null,
		"take-attempt-id": null,
	};
}

function normalizeTaskSpec(spec, label = "task") {
	if (!spec || typeof spec !== "object") {
		return failure("INVALID_ARGUMENT", `${label} must be an object`, {});
	}
	const goal = readField(spec, "goal");
	const remainingWork = readField(spec, "remainingWork", "remaining_work");
	const doneWhen = readField(spec, "doneWhen", "done_when");
	const needsToken = readField(spec, "needsToken", "needs_token");
	if (!isText(goal)) {
		return failure("INVALID_ARGUMENT", `${label}.goal must be non-empty`, {});
	}
	if (!isText(remainingWork)) {
		return failure("INVALID_ARGUMENT", `${label}.remaining_work must be non-empty`, {});
	}
	if (!isText(doneWhen)) {
		return failure("INVALID_ARGUMENT", `${label}.done_when must be non-empty`, {});
	}
	if (needsToken !== undefined && typeof needsToken !== "boolean") {
		return failure("INVALID_ARGUMENT", `${label}.needs_token must be boolean`, {});
	}
	return {
		ok: true,
		value: {
			goal,
			remainingWork,
			doneWhen,
			needsToken: needsToken ?? false,
			ownerId: readField(spec, "ownerId", "owner_id") ?? null,
			ledgerKey: readField(spec, "ledgerKey", "ledger_key") ?? null,
		},
	};
}

function appendTask(board, spec) {
	const taskId = nextId(board, "task", "T");
	const task = {
		"task-id": taskId,
		"ledger-key": spec.ledgerKey ?? null,
		goal: spec.goal,
		"remaining-work": spec.remainingWork,
		"done-when": spec.doneWhen,
		state: "ready",
		"wait-for": [],
		"needs-token": spec.needsToken,
		"owner-id": spec.ownerId ?? null,
		"claim-id": null,
		"claim-owner-id": null,
		"parent-id": spec.parentId ?? null,
		"child-ids": [],
		"result-refs": [],
		"result-summary": null,
		"dependency-paths": [],
		"handoff-note": null,
		comments: [],
		"revived-turn-id": null,
	};
	board.tasks[taskId] = task;
	return task;
}

function resolveActor(board, actorArg, options = {}) {
	const allowDead = options.allowDead === true;
	const agentId = actorIdOf(actorArg);
	if (!isText(agentId)) {
		return failure("ACTOR_DEAD", "actor identity is required", {});
	}
	const actor = board.actors[agentId];
	if (!actor) {
		return failure("ACTOR_DEAD", "actor is not registered", { agentId });
	}
	const termId = actorTermOf(actorArg);
	const retired = board["token-slot"]?.["retired-terms"] ?? [];
	if (termId && retired.includes(termId) && !allowDead) {
		return failure("TENURE_RETIRED", "term has retired", { agentId, termId });
	}
	if (actor["life-state"] !== "alive" && !allowDead) {
		return failure("ACTOR_DEAD", "actor is not alive", {
			agentId,
			lifeState: actor["life-state"],
		});
	}
	if (termId && actor["term-id"] && actor["term-id"] !== termId && !allowDead) {
		return failure("TENURE_RETIRED", "term does not match the live Holder term", {
			agentId,
			expected: actor["term-id"],
			actual: termId,
		});
	}
	return { ok: true, agentId, actor };
}

function isHolder(board, agentId) {
	const token = board["token-slot"];
	return Boolean(token && token.state === "held" && token["holder-id"] === agentId);
}

function activeActionForActor(board, agentId) {
	return Object.values(board.actions ?? {}).find(
		(action) => action["agent-id"] === agentId && action.phase !== "finished",
	);
}

function hasActiveActionForTask(board, taskId) {
	return Boolean(activeActionForTask(board, taskId));
}

function activeActionForTask(board, taskId) {
	return Object.values(board.actions ?? {}).find(
		(action) => action["task-id"] === taskId && action.phase !== "finished",
	);
}

function removeOrphanActionsForTask(board, taskId) {
	for (const [actionId, action] of Object.entries(board.actions ?? {})) {
		if (action["task-id"] !== taskId) continue;
		if (action.phase !== "claimed" && action.phase !== "preparing" && action.phase !== "waiting-gate") {
			continue;
		}
		delete board.actions[actionId];
		const actor = board.actors?.[action["agent-id"]];
		if (actor?.["active-action-id"] === actionId) actor["active-action-id"] = null;
	}
}

function hasOpenChildren(board, task) {
	return (task["child-ids"] ?? []).some((childId) => {
		const child = board.tasks[childId];
		return child && child.state !== "done";
	});
}

function detachChildFromParent(board, task, replacementId, turnId) {
	const parentId = task["parent-id"];
	if (!parentId) return null;
	const parent = board.tasks[parentId];
	if (!parent) return null;

	parent["child-ids"] = (parent["child-ids"] ?? []).filter((id) => id !== task["task-id"]);
	if (replacementId) parent["child-ids"] = uniqueValues([...parent["child-ids"], replacementId]);

	const nextWait = [];
	for (const entry of parent["wait-for"] ?? []) {
		if (waitEntryTaskId(entry) === task["task-id"]) {
			if (replacementId) nextWait.push(replacementId);
		} else {
			nextWait.push(entry);
		}
	}
	parent["wait-for"] = nextWait;

	if (parent.state === "waiting" && parent["wait-for"].every((entry) => isWaitSatisfied(board, entry))) {
		parent.state = "ready";
		parent["wait-for"] = [];
		parent["revived-turn-id"] = turnId;
		return parent["task-id"];
	}
	return null;
}

/*
 * wait_for is string[]: each entry is an existing direct child task id or a
 * `condition:<key>` entry. New child ids are not addressable by an explicit
 * wait_for; omit it to wait on all newly created children.
 */
function normalizeWaitEntries(raw, childIds, board, parentId) {
	if (raw === undefined) return clone(childIds);
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const parent = board.tasks[parentId];
	const allowed = new Set(parent?.["child-ids"] ?? []);
	const result = [];
	for (const entry of raw) {
		if (typeof entry !== "string" || !isText(entry)) return null;
		if (entry.startsWith(CONDITION_WAIT_PREFIX)) {
			if (conditionWaitKey(entry) === null) return null;
			result.push(entry);
			continue;
		}
		if (!allowed.has(entry) || !board.tasks[entry]) return null;
		result.push(entry);
	}
	return uniqueValues(result);
}

function waitEntryTaskId(entry) {
	return typeof entry === "string" && !entry.startsWith(CONDITION_WAIT_PREFIX) ? entry : null;
}

function conditionWaitKey(entry) {
	if (typeof entry !== "string" || !entry.startsWith(CONDITION_WAIT_PREFIX)) return null;
	const key = entry.slice(CONDITION_WAIT_PREFIX.length);
	return isText(key) ? key : null;
}

function isWaitSatisfied(board, entry) {
	if (typeof entry !== "string") return false;
	if (entry.startsWith(CONDITION_WAIT_PREFIX)) {
		const key = conditionWaitKey(entry);
		return key !== null && board.conditions?.[key] === true;
	}
	const task = board.tasks[entry];
	return !task || task.state === "done";
}

function nextId(board, kind, prefix) {
	const current = board["next-ids"][kind] ?? 1;
	board["next-ids"][kind] = current + 1;
	return `${prefix}-${current}`;
}

function bumpWake(board) {
	board.wake.epoch = (board.wake.epoch ?? 0) + 1;
	for (const agentId of Object.keys(board.sleepers ?? {})) {
		delete board.sleepers[agentId];
	}
	return board.wake.epoch;
}

function makeEvent(board, type, data, version, context) {
	const eventId = nextId(board, "event", "E");
	return {
		"event-id": eventId,
		"event-type": type,
		"board-version": version,
		"request-id": context.requestId ?? null,
		"actor-id": context.actorId ?? null,
		"turn-id": context.turnId ?? null,
		...clone(data),
	};
}

function progressableSummary(board) {
	return {
		"board-version": board["board-version"],
		"holder-id": board["token-slot"]?.["holder-id"] ?? null,
		progressable: progressableSet(board).map((item) => ({
			kind: item.kind,
			id: item.id,
			taskId: item.action?.["task-id"] ?? item.task?.["task-id"] ?? null,
			state: item.task?.state ?? item.action?.phase ?? null,
			ownerId: item.task?.["owner-id"] ?? item.action?.["agent-id"] ?? null,
		})),
		tasks: taskTree(board),
		sleepers: Object.keys(board.sleepers ?? {}),
	};
}

function failure(code, message, data = {}) {
	return { ok: false, error: herdError(code, message, data) };
}

function staleControl(result) {
	if (result.ok) return result;
	const errorCode = typeof result.error?.code === "string" ? result.error.code.replace(/^:/, "") : "";
	const staleCodes = new Set([
		"ACTOR_DEAD",
		"BOARD_CONFLICT",
		"CLAIM_CHANGED",
		"CLAIM_CONFLICT",
		"TASK_NOT_READY",
		"TENURE_RETIRED",
	]);
	const activeActionConflict = Boolean(result.error?.data?.actionId);
	if (!staleCodes.has(errorCode) && !activeActionConflict) return result;
	return {
		...result,
		error: herdError(
			"STALE_CONTROL",
			result.error.message,
			{ ...result.error.data, cause: result.error.code },
			result.error,
		),
	};
}

function normalizeControlKind(value, fallback) {
	if (typeof value === "string") {
		const kind = value.replace(/^:/, "");
		if (ACTION_KINDS.has(kind)) return kind;
	}
	return fallback;
}

function normalizeControlStatus(value) {
	return typeof value === "string" && value.length > 0 ? value.replace(/^:/, "") : "applied";
}

function resolveControlHandle(boardOrPath, options) {
	if (isBoardHandle(boardOrPath)) return boardOrPath;
	if (isBoardHandle(options.handle)) return options.handle;
	if (isText(boardOrPath) && options.store) {
		return {
			root: null,
			slug: null,
			sliceId: null,
			boardPath: boardOrPath,
			store: options.store,
			durable: options.durable ?? options.store?.durable !== false,
		};
	}
	return null;
}

function isBoardState(value) {
	return Boolean(value && typeof value === "object" && "board-version" in value && value.tasks && value.actors);
}

function isValidBoardState(value) {
	if (!isBoardState(value) || !Number.isInteger(value["board-version"])) return false;
	if (value.mode === "plan") return isValidPlanBoard(value);
	if (!value.actions || typeof value.actions !== "object") return false;
	if (!value["next-ids"] || typeof value["next-ids"] !== "object") return false;
	const token = value["token-slot"];
	if (!token || typeof token !== "object" || !["free", "held"].includes(token.state)) return false;
	for (const task of Object.values(value.tasks)) {
		if (!task || typeof task !== "object") return false;
		if (typeof task["task-id"] !== "string" || !TASK_STATES.has(task.state)) return false;
		const waits = task["wait-for"];
		if (!Array.isArray(waits)) return false;
		for (const entry of waits) {
			if (typeof entry !== "string") return false;
			if (entry.startsWith(CONDITION_WAIT_PREFIX)) {
				if (conditionWaitKey(entry) === null) return false;
			} else if (!value.tasks[entry]) {
				return false;
			}
		}
	}
	for (const actor of Object.values(value.actors)) {
		if (!actor || typeof actor !== "object") return false;
		if (typeof actor["agent-id"] !== "string" || !LIFE_STATES.has(actor["life-state"])) return false;
	}
	for (const action of Object.values(value.actions)) {
		if (!action || typeof action !== "object") return false;
		if (typeof action["action-id"] !== "string" || !ACTION_PHASES.has(action.phase)) {
			return false;
		}
	}
	for (const attempt of Object.values(value["take-attempts"] ?? {})) {
		if (!attempt || typeof attempt !== "object") return false;
		if (typeof attempt["request-id"] !== "string" || typeof attempt["agent-id"] !== "string") {
			return false;
		}
		if (typeof attempt.resolved !== "boolean") return false;
		if (!["free", "held"].includes(attempt["token-state"])) return false;
		if (
			attempt.outcome !== null &&
			attempt.outcome !== undefined &&
			attempt.outcome !== "attempt-won" &&
			attempt.outcome !== "attempt-lost"
		) {
			return false;
		}
	}
	return true;
}

function isBoardHandle(value) {
	return Boolean(value && typeof value === "object" && value.store && value.boardPath);
}

function actorIdOf(actor) {
	if (typeof actor === "string") return actor;
	if (!actor || typeof actor !== "object") return null;
	return readField(actor, "agentId", "agent-id", "agent_id", "id") ?? null;
}

function actorTermOf(actor) {
	if (!actor || typeof actor !== "object") return null;
	return readField(actor, "termId", "term-id", "term_id") ?? null;
}

function readField(object, ...names) {
	if (!object || typeof object !== "object") return undefined;
	for (const name of names) {
		if (Object.hasOwn(object, name) && object[name] !== undefined) {
			return object[name];
		}
	}
	return undefined;
}

function firstDefined(...values) {
	for (const value of values) {
		if (value !== undefined) return value;
	}
	return undefined;
}

function isText(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function hasEvidence(evidence) {
	if (isText(evidence)) return true;
	return Array.isArray(evidence) && evidence.length > 0 && evidence.every((item) => isText(item));
}

function uniqueValues(values) {
	return [...new Set(values)];
}

function clone(value) {
	return structuredClone(value);
}

function stableStringify(value) {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	const keys = Object.keys(value).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
