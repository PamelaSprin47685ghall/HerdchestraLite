/**
 * Minimal dogfood surface: asynchronous Worker-hosted ClojureScript sandbox +
 * unified wait.
 *
 * All Cherry/CEK evaluation, `where` diagnostics, and VFS operations run inside
 * a dedicated `node:worker_threads` Worker (`src/clj-sandbox/sandbox-worker.mjs`)
 * so heavy sandbox CPU work never blocks the `omp` main thread. Programs that
 * finish without hitting `call` or a held `$W$` lock return synchronously;
 * hitting `call` or waiting on `$W$` immediately backgrounds the call (`:state
 * :forked`) for collection via unified `wait`.
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { cherryStatus } from "./clj-sandbox/cherry.mjs";
import { describeSandboxTool } from "./clj-sandbox/tools.mjs";
import { hackContext } from "./host/hack-context.mjs";
import { hackSystemPrompt } from "./host/hack-system-prompt.mjs";
import { recordHealth } from "./host/health.mjs";
import { hostSessionKey } from "./host/session-key.mjs";
import { COMMON_RULES_TEXT } from "./prompts/common.mjs";

import { appendOutboundContextTail } from "./prompts/runtime-wires.mjs";
import {
	ARIADNE_BUDGET_FIELD,
	ARIADNE_GOAL_FIELD,
	applyTimeLeapToMessages,
	createAriadneStore,
} from "./scope/ariadne.mjs";
import { queryBeacon } from "./scope/beacon-query.mjs";
import { herdError } from "./util/errors.mjs";

const VERSION = "1";
const ENTRY = "clj.core";
const TOOL_ROLES = Object.freeze(["devops"]);
const TOOL_NAMES = Object.freeze({
	plan: "clj_plan",
	devops: "clj_devops",
	review: "clj_review",
	worker: "clj_worker",
});
const ROLE_LABELS = Object.freeze({
	plan: "Plan / read-only",
	devops: "DevOps / privileged worker",
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
const FORK_ALLOWED_FIELDS = new Set(["name", "code", "i", WORKERS_FIELD, ARIADNE_BUDGET_FIELD, ARIADNE_GOAL_FIELD]);
const TIME_LEAP_ALLOWED_FIELDS = new Set(["target", "experience", "beacon", "i"]);
const ASK_BEACON_ALLOWED_FIELDS = new Set(["target", "question", "i"]);
const WAIT_ALLOWED_FIELDS = new Set(["otherwise_independent_work", "i", WORKERS_FIELD]);

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
	required: ["code", ARIADNE_BUDGET_FIELD, ARIADNE_GOAL_FIELD],
	properties: {
		name: {
			type: "string",
			minLength: 1,
			description: "Optional REPL name for park/unpark and for a later time_leap target; auto-generated when omitted.",
		},
		code: {
			type: "string",
			minLength: 1,
			description: "Bare ClojureScript REPL input (any number of top-level expressions; the last value is the receipt). Every capability takes one EDN map. Tool-First: a string parameter accepts a full long document, not just a one-line value; free-form prose is valid whenever the tool does not parse it. Data the system must parse goes through its dedicated parameter. Human-facing prose is fine.",
		},
		[WORKERS_FIELD]: {
			type: "integer",
			minimum: 0,
			description: WORKERS_FIELD_DESCRIPTION,
		},
		[ARIADNE_BUDGET_FIELD]: {
			type: "integer",
			minimum: 1,
			description:
				"Ariadne's Thread — required turn budget (integer >= 1). Size it for the whole investigation, implementation, and focused verification. Active anchors compose by arithmetic mean: remaining = mean(anchor deadlines) - current turn. This is a soft conscience nudge, never a hard block. When a hypothesis is falsified or the thread is overdue, use time_leap instead of patching a polluted context.",
		},
		[ARIADNE_GOAL_FIELD]: {
			type: "string",
			minLength: 1,
			description:
				"Ariadne's Goal — required non-empty string paired with ariadne_budget: name the exact dragon you are slaying or proof you are hunting within this thread; it becomes your north star if you later time_leap back here.",
		},
	},
});

const WAIT_PARAMETERS = Object.freeze({
	type: "object",
	additionalProperties: false,
	required: ["otherwise_independent_work"],
	properties: {
		otherwise_independent_work: {
			type: "string",
			minLength: 1,
			description:
				"Counterfactually explain what independent work could otherwise be dispatched right now instead of calling wait while idle. If you decide not to wait after thinking about this, GREAT! You MUST also derive `more_workers_without_hitting_mythical_man_month` from Brooks' Mythical Man-Month here and prove it: each extra worker needs a slice with a disjoint contract and O(1) cross-slice communication; count only slices ready right now, and any slice you cannot prove disjoint counts as 0. Wait deadline = 1000ms + UTF-8 bytes * 50ms (plus 1000ms free grace at clj_* fork time).",
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
export const DEFAULT_HIDDEN_TOOLS = Object.freeze(["clj_plan", "clj_review", "clj_worker", "clj_auditor"]);

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

const TIME_LEAP_PARAMETERS = Object.freeze({
	type: "object",
	additionalProperties: false,
	required: ["target", "experience", "beacon"],
	properties: {
		target: {
			type: "string",
			minLength: 1,
			description:
				"The :name of a clj_* program anchor on the CURRENT timeline AFTER the latest compaction. Pre-compaction or other-branch anchors are unknown, so only post-compaction clj_* names are valid leap targets. Before choosing, inspect the anchor list in <ARIADNE-THREAD>: each anchor states its updated budget (the Ariadne remaining you would get after jumping back). Prefer an anchor with little irrelevant context and an updated budget that covers your remaining work and is materially larger than the current line; do not leap merely because it is the most recent, cleanest, most relevant, or has the largest updated budget. If recent anchors are unsuitable, actively consider distant anchors with cleaner context and sufficient updated budget. In experience, still pass the normal experience (proven facts, falsified paths, exact files/symbols, remaining plan, and next move), and additionally enumerate completed, partially completed, and not-started user requirements in exhaustive detail. Carry missing facts in `experience`.",
		},
		experience: {
			type: "string",
			minLength: 1,
			description:
				"Your full subjective lived experience to pour into the rewritten timeline: proven facts, falsified paths, exact files/symbols, remaining plan, and the single next move — especially facts that were unknown at the target anchor's time. Do not replace this normal experience with the requirement list. In addition to it, the experience MUST enumerate, in exhaustive detail, every user requirement that is already completed (with exact files/symbols and verification), which are partially done, and which are not started, so the future self never redoes finished work. This string may carry a long, structured prose report; do not compress it into a one-liner.",
		},
		beacon: {
			type: "string",
			minLength: 1,
			description:
				"Mandatory read-only Beacon summarizing the sealed branch you are departing from; future turns query it with ask_beacon. This string may carry a long summary, so write enough for ask_beacon to answer precisely. Sealed branches are never resurrected or jumped back to.",
		},
	},
});

const ASK_BEACON_PARAMETERS = Object.freeze({
	type: "object",
	additionalProperties: false,
	required: ["target", "question"],
	properties: {
		target: {
			type: "string",
			minLength: 1,
			description: "The Beacon :name from <BEACONS> to query. Beacons are read-only sealed branches and are never resurrected or switched to.",
		},
		question: {
			type: "string",
			minLength: 1,
			description: "Specific question for the sealed Beacon. It answers directly from its cached prefix with tools strictly forbidden and returns only text.",
		},
	},
});

const CLJ_TOOL_NAMES = Object.freeze([
	...TOOL_ROLES.map((role) => TOOL_NAMES[role]),
	"wait",
	"time_leap",
	"ask_beacon",
]);

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

function recoverAriadneHistory(ariadne, sessionKey, ctx, currentCallId = null) {
	const manager = ctx?.sessionManager;
	if (!manager) return;
	const all = typeof manager.getEntries === "function" ? manager.getEntries() : manager.getBranch?.();
	const active = manager.getBranch?.() ?? all;
	if (Array.isArray(all) && Array.isArray(active))
		ariadne.recoverHistory(sessionKey, all, active, (id) => manager.getBranch(id), currentCallId);
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
	if (!Number.isInteger(params[ARIADNE_BUDGET_FIELD]) || params[ARIADNE_BUDGET_FIELD] < 1) {
		throw herdError("INVALID_ARGUMENT", `${ARIADNE_BUDGET_FIELD} must be an integer >= 1`, {
			field: ARIADNE_BUDGET_FIELD,
			received: params[ARIADNE_BUDGET_FIELD],
		});
	}
	if (typeof params[ARIADNE_GOAL_FIELD] !== "string" || params[ARIADNE_GOAL_FIELD].trim().length === 0) {
		throw herdError("INVALID_ARGUMENT", `${ARIADNE_GOAL_FIELD} must be a non-empty string`, {
			field: ARIADNE_GOAL_FIELD,
		});
	}
	return {
		programName: params.name ?? `repl-${randomUUID().slice(0, 12)}`,
		code: params.code,
		workers: parseWorkerCount(params),
	};
}

function validateWaitParams(params) {
	if (!isPlainObject(params)) {
		throw herdError("INVALID_ARGUMENT", "wait parameters must be an object", {
			received: typeof params,
		});
	}
	for (const key of Object.keys(params)) {
		if (!WAIT_ALLOWED_FIELDS.has(key)) {
			throw herdError("INVALID_ARGUMENT", `unknown wait field: ${key}`, { field: key });
		}
	}
	if (typeof params.otherwise_independent_work !== "string" || params.otherwise_independent_work.trim().length === 0) {
		throw herdError("INVALID_ARGUMENT", "wait requires a non-empty otherwise_independent_work string", {
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
		details: { op: "wait", source: "sandbox", state: "idle", inFlight: 0, backlog: 0 },
		useless: true,
	};
}

function formatWaitingDeadlineReceipt(waitMs, pool) {
	const running = [...pool.inFlight.values()].map((entry) => JSON.stringify(entry.programName)).join(" ");
	const text = `{:state :waiting :reason :deadline :wait-ms ${waitMs} :in-flight ${pool.inFlight.size} :backlog ${pool.backlog.length} :running [${running}] :message "Wait deadline elapsed before any running sandbox finished; tasks continue in background. Dispatch more independent work or call wait again."}`;
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
			op: "wait",
			source: "sandbox",
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
			op: "wait",
			source: "sandbox",
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
 * tools and `wait` are then ensured active because `registerTool` alone does
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
	const hidden = (name) => HOST_TOOL_BLACKLIST.includes(name) || DEFAULT_HIDDEN_TOOLS.includes(name);
	const removed = active.filter(hidden);
	const next = active.filter((name) => !hidden(name));
	// Default mode subtracts hidden role tools, then forces clj_devops plus wait/time_leap/ask_beacon.
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
 * Register the default devops sandbox and unified `wait`. Kept as an
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
					const sessionKey = hostSessionKey(ctx);
					const pool = getPool(state, sessionKey);
					if (ariadne) {
						try {
							recoverAriadneHistory(ariadne, sessionKey, ctx, callId);
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
					const result = await Promise.race([runPromise, bgPromise]);
					return withWorkerNudge(
						{ ...result, details: { ...result.details, programName: validated.programName } },
						validated.workers,
					);
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
			name: "wait",
			label: "Wait",
			description:
				"Wait for the first result from your async clj_* sandbox programs or from background subagents/jobs you started. Returns immediately with all backlogged sandbox results; otherwise blocks until the earliest clj program or host job settles. The required otherwise_independent_work string sizes the sandbox wait as 1000ms + UTF-8 bytes * 50ms. On timeout all running sandbox tasks park and return :parked receipts; resume one with (unpark {:name ... :value ...}) or discard it with (abandon {:name ...}). Call wait again to collect remaining results.",
			parameters: WAIT_PARAMETERS,
			async execute(_toolCallId, params = {}, signal, onUpdate, ctx) {
				let plan;
				try {
					plan = validateWaitParams(params);
				} catch (error) {
					return toolFailure(error);
				}
				const finish = (result) => withWorkerNudge(result, plan.workers);
								const sessionKey = hostSessionKey(ctx);
				ariadne?.markTurnActive(sessionKey);
				const pool = getPool(state, sessionKey);
				while (pool.startingPromises.size > 0) {
					await Promise.all([...pool.startingPromises]);
				}
				if (pool.backlog.length > 0) {
					const items = pool.backlog.splice(0, pool.backlog.length);
					return finish(formatJoinedResults(items, pool));
				}
				const invokeNative = typeof ctx?.invokeTool === "function" ? ctx.invokeTool.bind(ctx) : null;
				if (pool.inFlight.size === 0) {
					if (invokeNative === null) return finish(formatIdleReceipt());
					try {
						return finish(await invokeNative({}, { signal, onUpdate }));
					} catch (error) {
						if (signal?.aborted === true) {
							return finish(toolFailure(herdError("UPSTREAM_ABORTED", "wait was cancelled while waiting")));
						}
						return finish(toolFailure(error));
					}
				}
				if (signal?.aborted === true) {
					return finish(toolFailure(herdError("UPSTREAM_ABORTED", "wait was cancelled before waiting")));
				}

				const waitMs = waitMsFor(plan.counterfactual, baseWaitMs);
				const joined = await new Promise((resolvePromise) => {
					let hostAbort = null;
					let hostPromise = null;
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
						hostAbort?.abort();
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

					const isIdleWaitResult = (result) =>
						result?.details?.useless === true ||
						(result?.content ?? []).some(
							(block) => typeof block?.text === "string" && block.text.startsWith("Nothing to wait for"),
						);

					const waiter = {
						deliver(item) {
							if (settled) return;
							hostAbort?.abort();
							settled = true;
							cleanup();
							resolvePromise(formatJoinedResult(item, pool));
						},
						deliverIdle() {
							if (settled) return;
							if (hostPromise !== null) {
								hostPromise.then(({ result, error }) => {
									if (settled) return;
									settled = true;
									cleanup();
									if (error && signal?.aborted !== true) resolvePromise(toolFailure(error));
									else resolvePromise(result ?? formatIdleReceipt());
								});
								return;
							}
							settled = true;
							cleanup();
							resolvePromise(formatIdleReceipt());
						},
					};

					pool.waiters.push(waiter);
					pool.callListeners.add(syncTimer);
					if (invokeNative !== null) {
						hostAbort = new AbortController();
						hostPromise = invokeNative({}, { signal: hostAbort.signal, onUpdate })
							.then((result) => ({ result }))
							.catch((error) => ({ error }));
						hostPromise.then(({ result, error }) => {
							if (settled) return;
							if (error) {
								if (signal?.aborted === true) {
									settled = true;
									cleanup();
									resolvePromise(toolFailure(herdError("UPSTREAM_ABORTED", "wait was cancelled while waiting")));
								}
								return;
							}
							if (isIdleWaitResult(result) && pool.inFlight.size > 0) return;
							settled = true;
							cleanup();
							resolvePromise(result);
						});
					}
					syncTimer();

					if (signal && typeof signal.addEventListener === "function") {
						abortListener = () => {
							if (settled) return;
							hostAbort?.abort();
							settled = true;
							cleanup();
							resolvePromise(toolFailure(herdError("UPSTREAM_ABORTED", "wait was cancelled while waiting")));
						};
						signal.addEventListener("abort", abortListener, { once: true });
					}
				});
				return finish(joined);
			},
		});
	} catch (error) {
		failures.push("wait");
		recordHealth({
			entry: ENTRY,
			status: "failed",
			version: VERSION,
			capabilities: { tool: "wait" },
			requiredCapabilities: ["tool"],
			degraded: true,
			error: errorText(error),
		});
	}

	try {
		pi.registerTool({
			name: "time_leap",
			label: "Time Leap++",
			description:
				"Time Leap++: cut the CURRENT post-compaction timeline back to a past clj_* anchor, carrying your full `experience` and leaving a mandatory read-only `beacon` on the departed branch. Resolve parked clj_* programs first with unpark or abandon, because a leap that predates them is refused. Never accepts `ariadne_budget`/`ariadne_goal` (re-anchor on your next `clj_*` call) and never resurrects old universes.",
			parameters: TIME_LEAP_PARAMETERS,
			async execute(toolCallId, params = {}, _signal, _onUpdate, ctx) {
				if (!isPlainObject(params)) {
					return toolFailure(herdError("INVALID_ARGUMENT", "time_leap parameters must be an object"));
				}
				for (const key of Object.keys(params)) {
					if (!TIME_LEAP_ALLOWED_FIELDS.has(key)) {
						return toolFailure(herdError("INVALID_ARGUMENT", `unknown time_leap field: ${key}`, { field: key }));
					}
				}
				if (!ariadne) {
					return toolFailure(herdError("HOST_API_MISMATCH", "Time Leap++ is disabled in this session"));
				}
								const sessionKey = hostSessionKey(ctx);
				const pool = getPool(state, sessionKey);
				while (pool.startingPromises.size > 0) {
					await Promise.all([...pool.startingPromises]);
				}
				try {
					const jumpCallId =
						typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : `tl-${randomUUID().slice(0, 12)}`;
					const leafId = ctx?.sessionManager?.getLeafId?.() ?? null;
					const parkedNames = (pool.parkedList ?? []).map((item) => item.name);
					recoverAriadneHistory(ariadne, sessionKey, ctx);
					const res = ariadne.timeLeap(sessionKey, params, { jumpCallId, leafId, parkedNames });
					const text = `{:state :time-leaped :target ${JSON.stringify(res.target)} :beacon ${JSON.stringify(res.beaconName)} :updated-budget ${res.updatedBudget === null ? "nil" : res.updatedBudget}}`;
					return { content: [{ type: "text", text }], details: res };
				} catch (error) {
					return toolFailure(error);
				}
			},
		});
	} catch (error) {
		failures.push("time_leap");
		recordHealth({
			entry: ENTRY,
			status: "failed",
			version: VERSION,
			capabilities: { tool: "time_leap" },
			requiredCapabilities: ["tool"],
			degraded: true,
			error: errorText(error),
		});
	}

	try {
		pi.registerTool({
			name: "ask_beacon",
			label: "Ask Beacon (Read-Only)",
			description:
				"Query a sealed read-only Beacon from <BEACONS>. Runs directly on that Verse's cached prefix with tools strictly forbidden and returns only the text answer—never resurrects or switches to the old branch.",
			parameters: ASK_BEACON_PARAMETERS,
			async execute(_toolCallId, params = {}, signal, _onUpdate, ctx) {
				if (!isPlainObject(params)) {
					return toolFailure(herdError("INVALID_ARGUMENT", "ask_beacon parameters must be an object"));
				}
				for (const key of Object.keys(params)) {
					if (!ASK_BEACON_ALLOWED_FIELDS.has(key)) {
						return toolFailure(herdError("INVALID_ARGUMENT", `unknown ask_beacon field: ${key}`, { field: key }));
					}
				}
				if (!ariadne) {
					return toolFailure(herdError("HOST_API_MISMATCH", "Beacons are disabled in this session"));
				}
								const sessionKey = hostSessionKey(ctx);
				const beacon = ariadne.getBeacon(sessionKey, params.target);
				if (!beacon) {
					return toolFailure(
						herdError("PROGRAM_UNKNOWN", `Unknown Beacon: ${params.target}`, {
							target: params.target,
							beacons: ariadne.listBeacons(sessionKey).map((b) => b.name),
						}),
					);
				}
				try {
					let complete = deps.completeSimple;
					if (typeof complete !== "function") {
						const piAi = await import("@oh-my-pi/pi-ai");
						complete = piAi?.completeSimple;
					}
					const model = ctx?.model;
					const sessionId = ctx?.sessionManager?.getSessionId?.();
					let apiKey;
					if (model && ctx?.modelRegistry) {
						if (typeof ctx.modelRegistry.getApiKey === "function") {
							apiKey = await ctx.modelRegistry.getApiKey(model);
						} else if (typeof ctx.modelRegistry.resolver === "function") {
							apiKey = ctx.modelRegistry.resolver(model, sessionId);
						}
					}
					const systemPrompt =
						typeof ctx?.getSystemPrompt === "function"
							? ctx.getSystemPrompt()
							: `${COMMON_RULES_TEXT}`;
					const res = await queryBeacon({
						beacon,
						question: params.question,
						model,
						apiKey,
						systemPrompt,
						complete,
						signal,
					});
					return {
						content: [{ type: "text", text: res.answer }],
						details: { target: res.target, retried: res.retried },
					};
				} catch (error) {
					return toolFailure(error);
				}
			},
		});
	} catch (error) {
		failures.push("ask_beacon");
		recordHealth({
			entry: ENTRY,
			status: "failed",
			version: VERSION,
			capabilities: { tool: "ask_beacon" },
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
				"surface: default mode exposes clj_devops only; /herd, board, worktrees, and audit are not enabled",
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
		hackSystemPrompt(pi, async () => resurface(), {
			block: COMMON_RULES_TEXT,
			entry: `${ENTRY}.systemPrompt`,
		});
		if (ariadne) {
			const settle = (_event, ctx) => {
								ariadne.settleTurn(hostSessionKey(ctx));
			};
			pi.on("turn_end", settle);
			pi.on("agent_end", settle);
		}
		pi.on("session_shutdown", (_event, ctx) => {
			if (ariadne) ariadne.retireSession(hostSessionKey(ctx));
			state.terminate();
		});
		hackContext(pi, (event, ctx) => {
			const sessionKey = hostSessionKey(ctx);
			const pool = state.pools.get(sessionKey);
			const parkedPrograms = pool?.parkedList ?? [];
			const leap = ariadne ? ariadne.consumePendingLeap(sessionKey) : null;
			let baseMessages = event?.messages;
			if (leap) {
				ariadne.attachBeaconSnapshot(
					sessionKey,
					leap.leavingBeaconName,
					event?.messages,
					ctx?.sessionManager?.getLeafId?.(),
				);
				const applied = applyTimeLeapToMessages(event?.messages, leap);
				baseMessages = applied.messages;
			}
			const ariadneBlock = ariadne ? ariadne.formatAriadneBlock(sessionKey) : null;
			const messages = appendOutboundContextTail(baseMessages, { parkedPrograms, ariadneBlock });
			return { messages };
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

