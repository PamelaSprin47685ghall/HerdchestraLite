/**
 * Minimal dogfood surface: asynchronous Worker-hosted ClojureScript sandbox +
 * unified join.
 *
 * All Cherry/CEK evaluation, `where` diagnostics, and VFS operations run inside
 * a dedicated `node:worker_threads` Worker (`src/clj-sandbox/sandbox-worker.mjs`)
 * so heavy sandbox CPU work never blocks the `omp` main thread. Programs that
 * finish without hitting `call` or a held `$W$` lock return synchronously;
 * hitting `call` or waiting on `$W$` immediately backgrounds the call (`:state
 * :forked`) for collection via unified `join`.
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { cherryStatus } from "./clj-sandbox/cherry.mjs";
import { describeSandboxTool } from "./clj-sandbox/tools.mjs";
import { hackContext } from "./host/hack-context.mjs";
import { recordHealth } from "./host/health.mjs";
import { appendOutboundContextTail } from "./prompts/runtime-wires.mjs";
import {
	ARIADNE_GOAL_FIELD,
	ARIADNE_THREAD_FIELD,
	applyVerseJumpToMessages,
	createAriadneStore,
} from "./scope/ariadne.mjs";
import { herdError } from "./util/errors.mjs";

const VERSION = "1";
const ENTRY = "clj.core";
const TOOL_ROLES = Object.freeze(["plan", "devops", "review", "worker"]);
const TOOL_NAMES = Object.freeze({
	plan: "clj_plan",
	devops: "clj_devops",
	review: "clj_review",
	worker: "clj_worker",
});
const ROLE_LABELS = Object.freeze({
	plan: "Plan / read-only",
	devops: "Plan DevOps / read-only + call",
	review: "Reviewer / read-only",
	worker: "Worker / read-write",
});
const DEFAULT_FORK_DEADLINE_MS = 3_600_000;
const SHARED_WORKER_SYMBOL = Symbol.for("herdchestra.sandboxWorker.v1");

function getSharedWorkerHost() {
	let shared = globalThis[SHARED_WORKER_SYMBOL];
	if (!shared) {
		shared = {
			worker: null,
			cherry: null,
			owners: new Set(),
			listeners: new Set(),
			failListeners: new Set(),
		};
		globalThis[SHARED_WORKER_SYMBOL] = shared;
	}
	return shared;
}
const WORKERS_FIELD = "more_workers_without_hitting_mythical_man_month";
const WORKERS_FIELD_DESCRIPTION =
	"自检：按 Brooks《人月神话》推导此刻还能增派多少工人。只数与既有契约互不相交、跨切片通信成本 O(1) 且现在已就绪的切片；无法证明互不相交的一律计 0。";
const FORK_ALLOWED_FIELDS = new Set(["name", "code", "i", WORKERS_FIELD, ARIADNE_THREAD_FIELD, ARIADNE_GOAL_FIELD]);
const VERSE_JUMP_ALLOWED_FIELDS = new Set([
	"target",
	"experience",
	"beacon",
	ARIADNE_THREAD_FIELD,
	ARIADNE_GOAL_FIELD,
	"i",
]);
const JOIN_ALLOWED_FIELDS = new Set(["otherwise_independent_work", "i", WORKERS_FIELD]);

/**
 * Join wait budget: 50ms per UTF-8 byte (the free 1s grace is spent at fork time).
 */
export function waitMsFor(text, baseMs = 1_000) {
	const bytes = Buffer.byteLength(typeof text === "string" ? text : "", "utf8");
	return baseMs + bytes * 50;
}

export function deadlineFor(text, now = Date.now(), baseMs = 1_000) {
	return now + waitMsFor(text, baseMs);
}

const SANDBOX_PARAMETERS = Object.freeze({
	type: "object",
	additionalProperties: false,
	required: ["code"],
	properties: {
		name: {
			type: "string",
			minLength: 1,
			description: "Optional REPL name for park/unpark; auto-generated when omitted.",
		},
		code: {
			type: "string",
			minLength: 1,
			description: "Bare ClojureScript REPL input; runs in a Worker thread.",
		},
		[WORKERS_FIELD]: {
			type: "integer",
			minimum: 0,
			description: WORKERS_FIELD_DESCRIPTION,
		},
		[ARIADNE_THREAD_FIELD]: {
			type: "integer",
			minimum: 1,
			description:
				"Ariadne's Thread — unspool a golden thread into the labyrinth before stepping deeper: how many turns (1 turn = 1 point) may you wander from this checkpoint before your past self taps you on the shoulder? Multiple active threads compose automatically by taking the tightest deadline (never a hard block—just an unmistakable conscience nudge if you drift past 0). Optional: omit to walk free or ride your current thread.",
		},
		[ARIADNE_GOAL_FIELD]: {
			type: "string",
			minLength: 1,
			description:
				"Ariadne's Goal — name the exact dragon you are slaying or proof you are hunting within this thread (required whenever ariadne_thread is set; becomes your north star if you later Verse-Jump back here).",
		},
	},
});

const JOIN_PARAMETERS = Object.freeze({
	type: "object",
	additionalProperties: false,
	required: ["otherwise_independent_work"],
	properties: {
		otherwise_independent_work: {
			type: "string",
			minLength: 1,
			description:
				"Counterfactually explain what independent work could otherwise be dispatched right now instead of calling join to wait idly. If you decide not to join after thinking about this, GREAT! You MUST also derive `more_workers_without_hitting_mythical_man_month` from Brooks' Mythical Man-Month here and prove it: each extra worker needs a slice with a disjoint contract and O(1) cross-slice communication; count only slices ready right now, and any slice you cannot prove disjoint counts as 0. Wait deadline = 1000ms + UTF-8 bytes * 50ms (plus 1000ms free grace at clj_* fork time).",
		},
		[WORKERS_FIELD]: {
			type: "integer",
			minimum: 0,
			description: WORKERS_FIELD_DESCRIPTION,
		},
	},
});

/**
 * Blacklist, not allowlist: these host tools have a clj replacement and are
 * removed from the current active set. Every other tool keeps whatever
 * activation state the user or host already chose; this module never builds a
 * "the only allowed tools" list from scratch.
 */
export const HOST_TOOL_BLACKLIST = Object.freeze([
	"read",
	"write",
	"edit",
	"apply_patch",
	"ast_edit",
	"ast_grep",
	"bash",
	"exec",
	"eval",
	"glob",
	"grep",
	"find",
]);

const VERSE_JUMP_PARAMETERS = Object.freeze({
	type: "object",
	additionalProperties: false,
	required: ["target", "experience"],
	properties: {
		target: {
			type: "string",
			minLength: 1,
			description:
				'The :name of the parallel universe to jump to (e.g. "alpha", an activated verse from <OTHER-VERSES>, or any historical clj_* program name to fork a new universe). Your leaving universe freezes cleanly on its branch in the same .jsonl so you can jump back later.',
		},
		experience: {
			type: "string",
			minLength: 1,
			description:
				"Your full subjective lived experience to pour into the target self (write generously—this is full Verse-Jumping, NOT a cramped 36-byte D-Mail!): bring every hard-won intuition, exact file path, line/symbol, falsified dead end, and the decisive next move so your alternate self wakes up already battle-hardened.",
		},
		beacon: {
			type: "string",
			minLength: 1,
			description:
				"Leave a luminous Beacon on the universe you are departing from: tell future alternate selves what specialty, partial state, or impasse makes THIS universe worth jumping back to (overwrites any previous beacon on the leaving universe; omit to keep its existing beacon).",
		},
		[ARIADNE_THREAD_FIELD]: {
			type: "integer",
			minimum: 1,
			description: "Optional Ariadne's Thread turn budget to unspool upon arriving in the target universe.",
		},
		[ARIADNE_GOAL_FIELD]: {
			type: "string",
			minLength: 1,
			description: "Optional Ariadne's Goal for the target universe (required when ariadne_thread is set).",
		},
	},
});

const CLJ_TOOL_NAMES = Object.freeze([...TOOL_ROLES.map((role) => TOOL_NAMES[role]), "join", "verse_jump"]);

function isPlainObject(value) {
	if (value === null || typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function errorText(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function toolFailure(error) {
	const code = error?.code ?? ":INVALID_ARGUMENT";
	return {
		content: [{ type: "text", text: `${code}: ${errorText(error)}` }],
		details: { code },
		isError: true,
	};
}

function rootFor(ctx) {
	return resolve(ctx?.cwd ?? process.cwd());
}

function hostSessionKey(ctx, root) {
	const identity =
		ctx?.sessionManager?.getSessionFile?.() ??
		ctx?.sessionManager?.getSessionId?.() ??
		ctx?.agent?.id ??
		ctx?.id ??
		`pid-${process.pid}`;
	return `${identity}\u0000${root}`;
}

function getPool(state, sessionKey) {
	let pool = state.pools.get(sessionKey);
	if (pool === undefined) {
		pool = {
			inFlight: new Map(),
			backlog: [],
			waiters: [],
			activeCalls: new Set(),
			waitingLocks: new Set(),
			callListeners: new Set(),
			pendingForeground: new Map(),
			pendingByExecId: new Map(),
			pendingRoles: new Map(),
			startingPromises: new Set(),
			parkedList: [],
		};
		state.pools.set(sessionKey, pool);
	}
	return pool;
}

function parseWorkerCount(params) {
	const value = params[WORKERS_FIELD];
	if (value === undefined) return 0;
	if (!Number.isInteger(value) || value < 0) {
		throw herdError("INVALID_ARGUMENT", `${WORKERS_FIELD} must be a non-negative integer`, {
			field: WORKERS_FIELD,
			received: value,
		});
	}
	return value;
}

function withWorkerNudge(result, workers) {
	if (!Number.isInteger(workers) || workers <= 0) return result;
	if (result === null || typeof result !== "object" || result.isError === true) return result;
	const content = Array.isArray(result.content) ? result.content : [];
	const nudge = `你刚刚在工具参数中说还可以增派 ${workers} 个工人，现在请你立刻兑现。`;
	return { ...result, content: [...content, { type: "text", text: nudge }] };
}

function validateForkParams(params) {
	if (!isPlainObject(params)) {
		throw herdError("INVALID_ARGUMENT", "sandbox tool parameters must be an object", {
			received: typeof params,
		});
	}
	for (const key of Object.keys(params)) {
		if (!FORK_ALLOWED_FIELDS.has(key)) {
			throw herdError("INVALID_ARGUMENT", `unknown sandbox tool field: ${key}`, { field: key });
		}
	}
	if (params.name !== undefined && (typeof params.name !== "string" || params.name.length === 0)) {
		throw herdError("INVALID_ARGUMENT", "name must be a non-empty string when provided", {
			field: "name",
		});
	}
	if (typeof params.code !== "string" || params.code.trim().length === 0) {
		throw herdError("INVALID_ARGUMENT", "code must be a non-empty string", { field: "code" });
	}
	if (params.code.trimStart().startsWith("(defprogram")) {
		throw herdError("INVALID_ARGUMENT", "code must be bare REPL input; the defprogram wrapper is no longer accepted", {
			field: "code",
		});
	}
	return {
		programName: params.name ?? `repl-${randomUUID().slice(0, 12)}`,
		code: params.code,
		workers: parseWorkerCount(params),
	};
}

function validateJoinParams(params) {
	if (!isPlainObject(params)) {
		throw herdError("INVALID_ARGUMENT", "join parameters must be an object", {
			received: typeof params,
		});
	}
	for (const key of Object.keys(params)) {
		if (!JOIN_ALLOWED_FIELDS.has(key)) {
			throw herdError("INVALID_ARGUMENT", `unknown join field: ${key}`, { field: key });
		}
	}
	if (typeof params.otherwise_independent_work !== "string" || params.otherwise_independent_work.trim().length === 0) {
		throw herdError("INVALID_ARGUMENT", "join requires a non-empty otherwise_independent_work string", {
			field: "otherwise_independent_work",
		});
	}
	return {
		counterfactual: params.otherwise_independent_work,
		workers: parseWorkerCount(params),
	};
}

function formatForkReceipt({ toolName, programName, inFlight, backlog }) {
	const text = `{:state :forked :tool ${JSON.stringify(toolName)} :program-name ${JSON.stringify(programName)} :in-flight ${inFlight} :backlog ${backlog}}`;
	return {
		content: [{ type: "text", text }],
		details: { state: "forked", tool: toolName, programName, inFlight, backlog },
	};
}

function formatIdleReceipt() {
	const text = `{:state :idle :in-flight 0 :backlog 0 :message "No sandbox tasks are running or queued."}`;
	return {
		content: [{ type: "text", text }],
		details: { state: "idle", inFlight: 0, backlog: 0 },
	};
}

function formatWaitingDeadlineReceipt(waitMs, pool) {
	const running = [...pool.inFlight.values()].map((entry) => JSON.stringify(entry.programName)).join(" ");
	const text = `{:state :waiting :reason :deadline :wait-ms ${waitMs} :in-flight ${pool.inFlight.size} :backlog ${pool.backlog.length} :running [${running}] :message "Wait deadline elapsed before any running sandbox finished; tasks continue in background. Dispatch more independent work or call join again."}`;
	return {
		content: [{ type: "text", text }],
		details: {
			state: "waiting",
			reason: "deadline",
			waitMs,
			inFlight: pool.inFlight.size,
			backlog: pool.backlog.length,
		},
	};
}

function formatJoinedResult(item, pool) {
	const result = item.result ?? {};
	const blocks = Array.isArray(result.content) ? result.content : [];
	const header = `; joined: ${item.toolName} ${item.programName} (in-flight: ${pool.inFlight.size}, backlog: ${pool.backlog.length})`;
	const firstText = typeof blocks[0]?.text === "string" ? `${header}\n${blocks[0].text}` : header;
	const content = [{ type: "text", text: firstText }, ...blocks.slice(1)];
	return {
		...result,
		content,
		details: {
			...(result.details ?? {}),
			joinedTool: item.toolName,
			programName: item.programName,
			inFlight: pool.inFlight.size,
			backlog: pool.backlog.length,
		},
	};
}

function formatJoinedResults(items, pool) {
	if (items.length === 1) {
		return formatJoinedResult(items[0], pool);
	}
	const parts = [];
	for (const item of items) {
		const result = item.result ?? {};
		const blocks = Array.isArray(result.content) ? result.content : [];
		const textBlocks = blocks
			.map((block) => (typeof block?.text === "string" ? block.text : ""))
			.filter((text) => text.length > 0)
			.join("\n");
		const header = `; joined: ${item.toolName} ${item.programName} (in-flight: ${pool.inFlight.size}, backlog: ${pool.backlog.length})`;
		parts.push(textBlocks.length > 0 ? `${header}\n${textBlocks}` : header);
	}
	return {
		content: [{ type: "text", text: parts.join("\n\n") }],
		details: {
			joinedCount: items.length,
			joined: items.map((item) => ({
				tool: item.toolName,
				programName: item.programName,
				isError: item.result?.isError === true,
			})),
			inFlight: pool.inFlight.size,
			backlog: pool.backlog.length,
		},
		...(items.some((item) => item.result?.isError === true) ? { isError: true } : {}),
	};
}

/**
 * Apply the replaced-host-tool blacklist to the current active set.
 *
 * The operation is subtractive: `getActiveTools()` is filtered and passed
 * back, so unrelated tools keep their prior activation state. The four clj
 * tools and `join` are then ensured active because `registerTool` alone does
 * not activate an extension tool; that is self-registration, not a blanket
 * allowlist.
 *
 * Idempotent; safe to call on every session start and every turn.
 */
export async function applyCljToolSurface(pi) {
	if (!pi || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
		return {
			ok: false,
			error: {
				code: ":HOST_API_MISMATCH",
				message: "getActiveTools/setActiveTools are unavailable; host tools cannot be disabled",
			},
		};
	}
	let active;
	try {
		active = pi.getActiveTools();
	} catch (error) {
		return { ok: false, error: { code: ":HOST_API_MISMATCH", message: errorText(error) } };
	}
	if (!Array.isArray(active)) {
		return { ok: false, error: { code: ":HOST_API_MISMATCH", message: "getActiveTools did not return an array" } };
	}
	const removed = active.filter((name) => HOST_TOOL_BLACKLIST.includes(name));
	const next = active.filter((name) => !HOST_TOOL_BLACKLIST.includes(name));
	// Own-tool activation only; no other tool is added or removed here.
	for (const name of CLJ_TOOL_NAMES) {
		if (!next.includes(name)) next.push(name);
	}
	if (removed.length === 0 && next.length === active.length) {
		return { ok: true, unchanged: true, active: next, removed: [] };
	}
	try {
		await pi.setActiveTools(next);
	} catch (error) {
		return { ok: false, error: { code: ":HOST_API_MISMATCH", message: errorText(error) } };
	}
	recordHealth({
		entry: ENTRY,
		status: "ok",
		version: VERSION,
		capabilities: { removed: removed.length, active: next.length },
		degraded: false,
	});
	return { ok: true, unchanged: false, active: next, removed };
}

/**
 * Register the four Worker-hosted sandbox tools and unified `join`. Kept as an
 * exported function so a test or a future assembly can compose the same surface
 * without the omp default entry.
 */
export function registerCljTools(pi, deps = {}) {
	if (!pi || typeof pi.registerTool !== "function") {
		throw new TypeError("clj-core: pi.registerTool is required");
	}
	const state = {
		pools: new Map(),
		pendingExecs: new Map(),
		pendingParks: new Map(),
		worker: null,
		workerCherry: null,
		seq: 0,
	};
	const ownerId = deps.ownerId ?? `clj-core-${process.pid}`;
	const forkDeadlineMs = Number.isFinite(deps.forkDeadlineMs) ? deps.forkDeadlineMs : DEFAULT_FORK_DEADLINE_MS;
	const baseWaitMs = Number.isFinite(deps.baseWaitMs) && deps.baseWaitMs >= 0 ? deps.baseWaitMs : 1_000;
	const ariadne = deps.ariadne !== false ? createAriadneStore() : null;
	const failures = [];

	const shared = getSharedWorkerHost();
	shared.owners.add(state);
	const failPending = (reason) => {
		for (const [id, resolveExec] of state.pendingExecs.entries()) {
			state.pendingExecs.delete(id);
			resolveExec(toolFailure(herdError("HOST_API_MISMATCH", reason)));
		}
		for (const [id, resolvePark] of state.pendingParks.entries()) {
			state.pendingParks.delete(id);
			resolvePark({ ok: false, code: "HOST_API_MISMATCH" });
		}
	};
	const handleWorkerMessage = (msg) => {
		if (!msg || typeof msg !== "object") return;
		if (msg.type === "initDone") {
			shared.cherry = msg.cherry ?? { loaded: true };
			state.workerCherry = shared.cherry;
			publishHealth();
			return;
		}
		if (msg.type === "execDone") {
			const resolveExec = state.pendingExecs.get(msg.id);
			if (resolveExec) {
				state.pendingExecs.delete(msg.id);
				resolveExec(msg.result);
			}
			return;
		}
		if (msg.type === "parkResult") {
			const resolvePark = state.pendingParks.get(msg.id);
			if (resolvePark) {
				state.pendingParks.delete(msg.id);
				resolvePark(msg.result);
			}
			return;
		}
		const pool = getPool(state, msg.sessionKey);
		if (msg.type === "callActivity") {
			const { id, active, program } = msg;
			if (typeof program !== "string" || program.length === 0) return;
			const fg = pool.pendingByExecId.get(id) ?? pool.pendingForeground.get(program);
			if (active) {
				pool.activeCalls.add(program);
				if (fg) {
					fg.setActive(true);
				} else {
					for (const entryFg of pool.pendingForeground.values()) {
						entryFg.setActive(true);
					}
				}
			} else {
				pool.activeCalls.delete(program);
				fg?.setActive(false);
			}
			for (const item of pool.inFlight.values()) {
				if (item.programName === program) {
					item.inCall = active;
				}
			}
			for (const listener of pool.callListeners) {
				listener();
			}
			return;
		}
		if (msg.type === "waitLock") {
			const { waiting, role } = msg;
			if (waiting) {
				pool.waitingLocks.add(role);
				for (const [progName, entryFg] of pool.pendingForeground.entries()) {
					if (pool.pendingRoles.get(progName) === role) {
						entryFg.setActive(true);
					}
				}
			} else {
				pool.waitingLocks.delete(role);
				for (const [progName, entryFg] of pool.pendingForeground.entries()) {
					if (pool.pendingRoles.get(progName) === role) {
						entryFg.setActive(false);
					}
				}
			}
			for (const listener of pool.callListeners) {
				listener();
			}
			return;
		}
		if (msg.type === "parkedList") {
			pool.parkedList = Array.isArray(msg.list) ? msg.list : [];
		}
	};
	shared.listeners.add(handleWorkerMessage);
	shared.failListeners.add(failPending);
	function ensureWorker() {
		shared.owners.add(state);
		shared.listeners.add(handleWorkerMessage);
		shared.failListeners.add(failPending);
		if (shared.worker !== null) {
			state.worker = shared.worker;
			if (shared.cherry !== null && state.workerCherry === null) {
				state.workerCherry = shared.cherry;
			}
			return shared.worker;
		}
		const worker = new Worker(new URL("./clj-sandbox/sandbox-worker.mjs", import.meta.url), {
			workerData: { __sandboxWorker: true },
		});
		worker.unref?.();
		worker.on("message", (msg) => {
			for (const listener of shared.listeners) {
				listener(msg);
			}
		});
		const onWorkerDrop = (reason) => {
			if (shared.worker !== worker) return;
			shared.worker = null;
			shared.cherry = null;
			for (const owner of shared.owners) {
				if (owner.worker === worker) owner.worker = null;
			}
			for (const onFail of shared.failListeners) {
				onFail(reason);
			}
		};
		worker.on("error", (error) => {
			onWorkerDrop(`sandbox worker failed: ${errorText(error)}`);
		});
		worker.on("exit", (code) => {
			onWorkerDrop(`sandbox worker exited unexpectedly with code ${code}`);
		});
		shared.worker = worker;
		state.worker = worker;
		return worker;
	}

	function parkInWorker(sessionKey, role, programName) {
		const worker = state.worker;
		if (!worker) {
			return Promise.resolve({ ok: false, code: "PROGRAM_UNKNOWN", name: programName });
		}
		const id = `park-${++state.seq}`;
		return new Promise((resolvePark) => {
			state.pendingParks.set(id, resolvePark);
			worker.postMessage({ type: "parkOnDeadline", id, sessionKey, role, programName });
		});
	}

	for (const role of TOOL_ROLES) {
		const toolName = TOOL_NAMES[role];
		try {
			pi.registerTool({
				name: toolName,
				label: `Clojure Sandbox (${ROLE_LABELS[role]})`,
				description: describeSandboxTool(toolName),
				parameters: SANDBOX_PARAMETERS,
				async execute(toolCallId, params = {}, signal, _onUpdate, ctx) {
					let validated;
					try {
						validated = validateForkParams(params);
					} catch (error) {
						return toolFailure(error);
					}
					const callId =
						typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : `fork-${randomUUID().slice(0, 12)}`;
					const root = rootFor(ctx);
					const sessionKey = hostSessionKey(ctx, root);
					const pool = getPool(state, sessionKey);
					if (ariadne) {
						try {
							ariadne.validateAndApplyFork(sessionKey, params, validated.programName, callId, toolName);
						} catch (error) {
							return toolFailure(error);
						}
					}
					const execId = `exec-${++state.seq}`;
					const entry = {
						callId,
						toolName,
						role,
						sessionKey,
						programName: validated.programName,
						inCall: false,
						claimed: false,
						startedAt: Date.now(),
						donePromise: null,
					};

					let backgrounded = false;
					let settledNormally = false;
					let resolveStarting = null;
					const startingPromise = new Promise((resolve) => {
						resolveStarting = resolve;
					});
					pool.startingPromises.add(startingPromise);
					const finishStarting = () => {
						if (pool.startingPromises.delete(startingPromise)) {
							resolveStarting();
						}
					};
					let resolveBackground = null;
					const bgPromise = new Promise((resolve) => {
						resolveBackground = resolve;
					});
					let remainingGraceMs = baseWaitMs;
					let graceTickingSince = null;
					let graceTimer = null;
					let activeGraceCount = 0;

					const clearGraceTimer = () => {
						if (graceTimer !== null) {
							clearTimeout(graceTimer);
							graceTimer = null;
						}
						if (graceTickingSince !== null) {
							remainingGraceMs = Math.max(0, remainingGraceMs - (Date.now() - graceTickingSince));
							graceTickingSince = null;
						}
					};

					const triggerBackground = () => {
						if (settledNormally || backgrounded) return;
						backgrounded = true;
						clearGraceTimer();
						pool.pendingForeground.delete(validated.programName);
						pool.pendingByExecId.delete(execId);
						pool.pendingRoles.delete(validated.programName);
						pool.inFlight.set(callId, entry);
						finishStarting();
						resolveBackground(
							formatForkReceipt({
								toolName,
								programName: validated.programName,
								inFlight: pool.inFlight.size,
								backlog: pool.backlog.length,
							}),
						);
					};

					const fgHandle = {
						setActive(isActive) {
							if (settledNormally || backgrounded) return;
							if (isActive) {
								activeGraceCount += 1;
								if (remainingGraceMs <= 0) {
									triggerBackground();
									return;
								}
								if (graceTimer === null) {
									graceTickingSince = Date.now();
									graceTimer = setTimeout(() => {
										graceTimer = null;
										graceTickingSince = null;
										remainingGraceMs = 0;
										triggerBackground();
									}, remainingGraceMs);
								}
							} else {
								activeGraceCount = Math.max(0, activeGraceCount - 1);
								if (activeGraceCount === 0) {
									clearGraceTimer();
								}
							}
						},
					};

					pool.pendingRoles.set(validated.programName, role);
					pool.pendingForeground.set(validated.programName, fgHandle);
					pool.pendingByExecId.set(execId, fgHandle);

					let worker;
					try {
						worker = ensureWorker();
					} catch (error) {
						pool.pendingForeground.delete(validated.programName);
						pool.pendingRoles.delete(validated.programName);
						finishStarting();
						return toolFailure(error);
					}

					let abortListener = null;
					const cleanupAbort = () => {
						if (abortListener !== null && typeof signal?.removeEventListener === "function") {
							signal.removeEventListener("abort", abortListener);
							abortListener = null;
						}
					};
					if (signal) {
						if (signal.aborted) {
							worker.postMessage({ type: "abort", callId });
						} else if (typeof signal.addEventListener === "function") {
							abortListener = () => {
								worker.postMessage({ type: "abort", callId });
							};
							signal.addEventListener("abort", abortListener, { once: true });
						}
					}

					const runPromise = new Promise((resolveExec) => {
						state.pendingExecs.set(execId, resolveExec);
						worker.postMessage({
							type: "exec",
							id: execId,
							sessionKey,
							role,
							toolName,
							root,
							ownerId,
							callId,
							programName: validated.programName,
							code: validated.code,
							deadlineAt: Date.now() + forkDeadlineMs,
						});
					})
						.catch((error) => toolFailure(error))
						.then((result) => {
							cleanupAbort();
							clearGraceTimer();
							pool.pendingForeground.delete(validated.programName);
							pool.pendingByExecId.delete(execId);
							pool.pendingRoles.delete(validated.programName);
							if (!backgrounded) {
								settledNormally = true;
								finishStarting();
								return result;
							}
							pool.inFlight.delete(callId);
							const settled = {
								callId,
								toolName,
								role,
								programName: validated.programName,
								result,
							};
							if (entry.claimed) {
								return settled;
							}
							if (pool.waiters.length > 0) {
								entry.claimed = true;
								const waiter = pool.waiters.shift();
								waiter.deliver(settled);
								if (pool.inFlight.size === 0 && pool.backlog.length === 0) {
									while (pool.waiters.length > 0) {
										pool.waiters.shift().deliverIdle();
									}
								}
							} else {
								pool.backlog.push(settled);
							}
							return settled;
						});

					entry.donePromise = runPromise;
					return withWorkerNudge(await Promise.race([runPromise, bgPromise]), validated.workers);
				},
			});
		} catch (error) {
			failures.push(toolName);
			recordHealth({
				entry: ENTRY,
				status: "failed",
				version: VERSION,
				capabilities: { tool: toolName },
				requiredCapabilities: ["tool"],
				degraded: true,
				error: errorText(error),
			});
		}
	}

	try {
		pi.registerTool({
			name: "join",
			label: "Join Async Sandbox",
			description:
				"Collect async clj_* sandbox results. Returns immediately with all backlogged results if any exist, or with :idle if no tasks are running; otherwise blocks until the first running task finishes (up to 1000ms + UTF-8 bytes(otherwise_independent_work) * 50ms, cannot target a specific task) and returns that single result. Call join again to collect remaining tasks.",
			parameters: JOIN_PARAMETERS,
			async execute(_toolCallId, params = {}, signal, _onUpdate, ctx) {
				let plan;
				try {
					plan = validateJoinParams(params);
				} catch (error) {
					return toolFailure(error);
				}
				const finish = (result) => withWorkerNudge(result, plan.workers);
				const root = rootFor(ctx);
				const sessionKey = hostSessionKey(ctx, root);
				ariadne?.markTurnActive(sessionKey);
				const pool = getPool(state, sessionKey);
				while (pool.startingPromises.size > 0) {
					await Promise.all([...pool.startingPromises]);
				}
				if (pool.backlog.length > 0) {
					const items = pool.backlog.splice(0, pool.backlog.length);
					return finish(formatJoinedResults(items, pool));
				}
				if (pool.inFlight.size === 0) {
					return finish(formatIdleReceipt());
				}
				if (signal?.aborted === true) {
					return finish(toolFailure(herdError("UPSTREAM_ABORTED", "join was cancelled before waiting")));
				}

				const waitMs = waitMsFor(plan.counterfactual, baseWaitMs);
				const joined = await new Promise((resolvePromise) => {
					let settled = false;
					let remainingMs = waitMs;
					let tickingSince = null;
					let timer = null;
					let abortListener = null;

					const pauseTimer = () => {
						if (timer !== null) {
							clearTimeout(timer);
							timer = null;
						}
						if (tickingSince !== null) {
							remainingMs = Math.max(0, remainingMs - (Date.now() - tickingSince));
							tickingSince = null;
						}
					};

					const cleanup = () => {
						pauseTimer();
						pool.callListeners.delete(syncTimer);
						if (abortListener !== null && typeof signal?.removeEventListener === "function") {
							signal.removeEventListener("abort", abortListener);
							abortListener = null;
						}
						const index = pool.waiters.indexOf(waiter);
						if (index !== -1) {
							pool.waiters.splice(index, 1);
						}
					};

					const onDeadline = async () => {
						if (settled) return;
						settled = true;
						cleanup();
						const targets = [...pool.inFlight.values()].filter((item) => !item.claimed);
						if (targets.length === 0) {
							resolvePromise(formatWaitingDeadlineReceipt(waitMs, pool));
							return;
						}
						const results = await Promise.all(
							targets.map((item) => parkInWorker(item.sessionKey, item.role, item.programName)),
						);
						const parkedTargets = [];
						for (let i = 0; i < targets.length; i += 1) {
							if (results[i]?.ok) {
								targets[i].claimed = true;
								parkedTargets.push(targets[i]);
							}
						}
						if (parkedTargets.length === 0) {
							resolvePromise(formatWaitingDeadlineReceipt(waitMs, pool));
							return;
						}
						const settledItems = await Promise.all(parkedTargets.map((item) => item.donePromise));
						resolvePromise(formatJoinedResults(settledItems, pool));
					};

					const syncTimer = () => {
						if (settled) return;
						if (pool.activeCalls.size > 0 || pool.waitingLocks.size > 0) {
							if (timer === null) {
								tickingSince = Date.now();
								timer = setTimeout(
									() => {
										void onDeadline();
									},
									Math.max(1, remainingMs),
								);
							}
						} else {
							pauseTimer();
						}
					};

					const waiter = {
						deliver(item) {
							if (settled) return;
							settled = true;
							cleanup();
							resolvePromise(formatJoinedResult(item, pool));
						},
						deliverIdle() {
							if (settled) return;
							settled = true;
							cleanup();
							resolvePromise(formatIdleReceipt());
						},
					};

					pool.waiters.push(waiter);
					pool.callListeners.add(syncTimer);
					syncTimer();

					if (signal && typeof signal.addEventListener === "function") {
						abortListener = () => {
							if (settled) return;
							settled = true;
							cleanup();
							resolvePromise(toolFailure(herdError("UPSTREAM_ABORTED", "join was cancelled while waiting")));
						};
						signal.addEventListener("abort", abortListener, { once: true });
					}
				});
				return finish(joined);
			},
		});
	} catch (error) {
		failures.push("join");
		recordHealth({
			entry: ENTRY,
			status: "failed",
			version: VERSION,
			capabilities: { tool: "join" },
			requiredCapabilities: ["tool"],
			degraded: true,
			error: errorText(error),
		});
	}

	try {
		pi.registerTool({
			name: "verse_jump",
			label: "Verse Jump (Everything Everywhere)",
			description:
				'Verse-Jumping (Everything Everywhere All at Once · barrier-synchronized): freeze your current universe cleanly on its branch in the same .jsonl and transfer the "who I am" spotlight token + your full subjective lived experience to another universe—either an activated parallel verse from <OTHER-VERSES> (such as "alpha") to resume where it left off, or any historical clj_* program :name to fork a brand-new worldline. Nothing is lost; you can always jump back.',
			parameters: VERSE_JUMP_PARAMETERS,
			async execute(toolCallId, params = {}, _signal, _onUpdate, ctx) {
				if (!isPlainObject(params)) {
					return toolFailure(herdError("INVALID_ARGUMENT", "verse_jump parameters must be an object"));
				}
				for (const key of Object.keys(params)) {
					if (!VERSE_JUMP_ALLOWED_FIELDS.has(key)) {
						return toolFailure(herdError("INVALID_ARGUMENT", `unknown verse_jump field: ${key}`, { field: key }));
					}
				}
				if (!ariadne) {
					return toolFailure(herdError("HOST_API_MISMATCH", "Verse-Jumping is disabled in this session"));
				}
				const root = rootFor(ctx);
				const sessionKey = hostSessionKey(ctx, root);
				const pool = getPool(state, sessionKey);
				while (pool.startingPromises.size > 0) {
					await Promise.all([...pool.startingPromises]);
				}
				try {
					const jumpCallId =
						typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : `vj-${randomUUID().slice(0, 12)}`;
					const leafId = ctx?.sessionManager?.getLeafId?.() ?? null;
					const parkedNames = (pool.parkedList ?? []).map((item) => item.name);
					const res = ariadne.verseJump(sessionKey, params, { jumpCallId, leafId, parkedNames });
					const text = `{:state :verse-jumped :kind ${JSON.stringify(res.kind)} :target ${JSON.stringify(res.target)} :lca-distance ${res.lcaDistance} :remaining-turns ${res.remaining === null ? "nil" : res.remaining} :refunded-turns ${res.refunded}}`;
					return { content: [{ type: "text", text }], details: res };
				} catch (error) {
					return toolFailure(error);
				}
			},
		});
	} catch (error) {
		failures.push("verse_jump");
		recordHealth({
			entry: ENTRY,
			status: "failed",
			version: VERSION,
			capabilities: { tool: "verse_jump" },
			requiredCapabilities: ["tool"],
			degraded: true,
			error: errorText(error),
		});
	}

	pi.registerCommand?.("clj-status", {
		description: "Show the ClojureScript sandbox health.",
		async handler(_args, ctx) {
			const cherry = state.workerCherry ?? cherryStatus();
			const lines = [
				`clj-core: ${cherry.loaded ? "ready" : "not-loaded"}${cherry.version ? ` (cherry-cljs ${cherry.version})` : ""}`,
				`tools: ${CLJ_TOOL_NAMES.join(", ")}`,
				`host tool blacklist: ${HOST_TOOL_BLACKLIST.join(", ")}`,
				"surface: Worker-hosted clj_* + unified join; /herd, board, worktrees, and audit are not enabled",
			];
			ctx?.ui?.notify?.(lines.join("\n"), cherry.loaded ? "info" : "warning");
		},
	});

	if (typeof pi.on === "function") {
		const resurface = async () => {
			const result = await applyCljToolSurface(pi);
			if (result.ok !== true) {
				recordHealth({
					entry: ENTRY,
					status: "degraded",
					version: VERSION,
					capabilities: { toolSurface: false },
					degraded: true,
					error: result.error.message,
				});
			}
			return undefined;
		};
		pi.on("session_start", resurface);
		pi.on("before_agent_start", resurface);
		if (ariadne) {
			const settle = (_event, ctx) => {
				const root = rootFor(ctx);
				ariadne.settleTurn(hostSessionKey(ctx, root));
			};
			pi.on("turn_end", settle);
			pi.on("agent_end", settle);
		}
		pi.on("session_shutdown", () => {
			state.terminate();
		});
		hackContext(pi, (event, ctx) => {
			const root = rootFor(ctx);
			const sessionKey = hostSessionKey(ctx, root);
			const pool = state.pools.get(sessionKey);
			const parkedPrograms = pool?.parkedList ?? [];
			const jump = ariadne ? ariadne.consumePendingJump(sessionKey) : null;
			let baseMessages = event?.messages;
			let branchBaseMessages;
			if (jump) {
				ariadne.attachLeavingSnapshot(
					sessionKey,
					jump.leavingName,
					event?.messages,
					ctx?.sessionManager?.getLeafId?.(),
				);
				const applied = applyVerseJumpToMessages(event?.messages, jump, ctx?.sessionManager);
				baseMessages = applied.messages;
				if (applied.branchSwitched && ctx?.sessionManager) {
					if (typeof ctx.sessionManager.buildSessionContext === "function") {
						const built = ctx.sessionManager.buildSessionContext();
						if (Array.isArray(built?.messages)) branchBaseMessages = built.messages;
					} else if (typeof ctx.sessionManager.getBranch === "function") {
						branchBaseMessages = ctx.sessionManager
							.getBranch()
							.filter((e) => e && e.type === "message" && e.message)
							.map((e) => e.message);
					}
				}
			}
			const ariadneBlock = ariadne ? ariadne.formatAriadneBlock(sessionKey) : null;
			const messages = appendOutboundContextTail(baseMessages, { parkedPrograms, ariadneBlock });
			return branchBaseMessages !== undefined ? { messages, branchBaseMessages } : { messages };
		});
	}

	const hooksReady = typeof pi.on === "function";
	const publishHealth = () => {
		const cherry = state.workerCherry;
		const cherryUnavailable = cherry !== null && cherry.loaded !== true;
		const degraded = failures.length > 0 || cherryUnavailable || !hooksReady;
		recordHealth({
			entry: ENTRY,
			status: degraded ? "degraded" : "ok",
			version: VERSION,
			capabilities: {
				tools: [...CLJ_TOOL_NAMES],
				hostToolBlacklist: HOST_TOOL_BLACKLIST.length,
				cherry: cherry === null ? "warming" : cherry.loaded,
				hooksReady,
				failedTools: failures,
			},
			requiredCapabilities: degraded ? ["tools", "cherry", "hooks"] : [],
			degraded,
			...(degraded
				? {
						error:
							failures.length > 0
								? `tool registration failed: ${failures.join(", ")}`
								: cherryUnavailable
									? "cherry-cljs unavailable"
									: "pi.on is unavailable; the host tool blacklist cannot be enforced",
					}
				: {}),
		});
	};
	publishHealth();
	state.warmup = () => {
		try {
			const worker = ensureWorker();
			worker.postMessage({ type: "init", id: "warmup" });
		} catch {
			// Warmup is best-effort; tool execution reports worker errors explicitly.
		}
	};
	state.terminate = () => {
		shared.listeners.delete(handleWorkerMessage);
		shared.failListeners.delete(failPending);
		shared.owners.delete(state);
		failPending("sandbox session terminated");
		if (shared.worker !== null && state.pools.size > 0) {
			shared.worker.postMessage({ type: "disposeSession", sessionKeys: [...state.pools.keys()] });
		}
		state.worker = null;
		if (shared.owners.size === 0 && shared.worker !== null) {
			const w = shared.worker;
			shared.worker = null;
			shared.cherry = null;
			w.terminate?.();
		}
	};
	return state;
}

export default async function activate(pi) {
	// Register tools immediately without blocking the host main thread on
	// cherry-cljs loading; pre-warm the sandbox Worker in the background.
	const state = registerCljTools(pi);
	state.warmup();
	return state;
}
