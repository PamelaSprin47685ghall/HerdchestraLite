/**
 * Minimal dogfood surface: asynchronous ClojureScript sandbox + unified join.
 *
 * This entry registers `clj_plan`, `clj_devops`, `clj_review`, `clj_worker`,
 * and `join`, plus `/clj-status`. All `clj_*` calls fork asynchronously and
 * return immediately without requiring `intent`. `join` collects completed
 * results from the session pool: returning immediately when idle or when
 * backlogged results exist, otherwise waiting up to `1000ms + bytes * 50ms`
 * (determined by its `otherwise_independent_work` parameter) for the first running
 * sandbox to finish.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { cherryStatus, loadCherry } from "./clj-sandbox/cherry.mjs";
import { parkedNames, parkProgramOnDeadline } from "./clj-sandbox/evaluator.mjs";
import { buildSandboxTools, describeSandboxTool } from "./clj-sandbox/tools.mjs";
import { recordHealth } from "./host/health.mjs";
import { herdError } from "./util/errors.mjs";
import { withLock } from "./util/file-lock.mjs";

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
const FORK_ALLOWED_FIELDS = new Set(["name", "code", "i"]);
const JOIN_ALLOWED_FIELDS = new Set(["otherwise_independent_work", "i"]);

/**
 * One-second grace, then 50ms per UTF-8 byte. No role floors.
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
			description: "Bare ClojureScript REPL input; forks asynchronously and returns immediately.",
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
				"Counterfactually explain what independent work could otherwise be dispatched right now instead of calling join to wait idly. If you decide not to join after thinking about this, GREAT! Wait deadline = 1000ms + UTF-8 bytes * 50ms.",
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

const CLJ_TOOL_NAMES = Object.freeze([...TOOL_ROLES.map((role) => TOOL_NAMES[role]), "join"]);

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
			pendingRoles: new Map(),
			startingPromises: new Set(),
		};
		state.pools.set(sessionKey, pool);
	}
	return pool;
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
	return params.otherwise_independent_work;
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
 * A protected write gate backed by one lock file per workspace.
 *
 * VFS `commit` expects `runExclusive(fn)` to return `fn`'s value, not a lock
 * wrapper. Conflict reporting stays in VFS; this port only serializes.
 */
const WRITE_GATE_QUEUES = new Map();

function createWriteGate(root, ownerId, onWaitLock) {
	const lockPath = join(root, ".herd", "locks", "clj-core.write-w.lock");
	mkdirSync(join(root, ".herd", "locks"), { recursive: true });
	return {
		async runExclusive(run, signal) {
			const prev = WRITE_GATE_QUEUES.get(lockPath);
			if (prev !== undefined) {
				onWaitLock?.(true);
			}
			let releaseQueue;
			const next = new Promise((resolve) => {
				releaseQueue = resolve;
			});
			WRITE_GATE_QUEUES.set(lockPath, next);
			if (prev !== undefined) {
				await prev;
			}
			try {
				while (true) {
					if (signal?.aborted) {
						throw herdError("UPSTREAM_ABORTED", "write gate wait was cancelled", { lock: lockPath });
					}
					const acquired = await withLock(
						lockPath,
						{
							lock_id: "clj-core",
							purpose: "clj-core protected write",
							slice_id: "clj-core",
							owner_agent_id: ownerId,
							pid: process.pid,
						},
						run,
					);
					if (acquired?.ok) {
						return acquired.value;
					}
					if (acquired?.code !== ":BOARD_CONFLICT") {
						throw herdError(acquired?.code ?? ":BOARD_CONFLICT", acquired?.message ?? "write gate is held", {
							lock: lockPath,
							next: "wait for the current holder to finish, then retry the same program",
						});
					}
					onWaitLock?.(true);
					await new Promise((resolveWait) => setTimeout(resolveWait, 15));
				}
			} finally {
				onWaitLock?.(false);
				releaseQueue();
				if (WRITE_GATE_QUEUES.get(lockPath) === next) {
					WRITE_GATE_QUEUES.delete(lockPath);
				}
			}
		},
	};
}

function createControl() {
	return {
		async markApplying(payload = {}) {
			return { ok: true, actionId: payload.actionId ?? "clj-core" };
		},
		async publishResult() {
			return { ok: true };
		},
		async markUncertain() {
			return { ok: true };
		},
		async markRunning(payload = {}) {
			return { ok: true, actionId: payload.actionId ?? "clj-core" };
		},
		async verifyClaim() {
			return { ok: true };
		},
	};
}

function createPorts(root, ownerId, callMetaByCall, withWriteGate, onCallActivity, onWaitLock) {
	return {
		...(withWriteGate ? { writeGate: createWriteGate(root, ownerId, onWaitLock) } : {}),
		control: createControl(),
		identity: { agent_id: ownerId, status: "alive", term_id: "clj-core" },
		claim: { claim_id: "clj-core", status: "active", term_id: "clj-core" },
		callMeta: (toolCallId) => callMetaByCall.get(toolCallId),
		agentId: ownerId,
		sessionKey: ownerId,
		...(onCallActivity ? { onCallActivity } : {}),
	};
}

function buildBundle(role, root, ownerId, callMetaByCall, onCallActivity, onWaitLock) {
	const callLogDir = role === "devops" ? join(root, ".herd", "artifacts", "clj-core") : undefined;
	if (callLogDir !== undefined) mkdirSync(callLogDir, { recursive: true });
	return buildSandboxTools({
		role,
		roots: {
			writeRoot: root,
			...(callLogDir !== undefined ? { callLogDir } : {}),
		},
		ports: createPorts(
			root,
			ownerId,
			callMetaByCall,
			role === "worker" || role === "devops",
			onCallActivity,
			onWaitLock,
		),
	});
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
 * Register the four async sandbox tools and unified `join`. Kept as an
 * exported function so a test or a future assembly can compose the same surface
 * without the omp default entry.
 */
export function registerCljTools(pi, deps = {}) {
	if (!pi || typeof pi.registerTool !== "function") {
		throw new TypeError("clj-core: pi.registerTool is required");
	}
	const state = {
		bundles: new Map(),
		callMeta: new Map(),
		pools: new Map(),
	};
	const ownerId = deps.ownerId ?? `clj-core-${process.pid}`;
	const forkDeadlineMs = Number.isFinite(deps.forkDeadlineMs) ? deps.forkDeadlineMs : DEFAULT_FORK_DEADLINE_MS;
	const baseWaitMs = Number.isFinite(deps.baseWaitMs) && deps.baseWaitMs >= 0 ? deps.baseWaitMs : 1_000;
	const failures = [];

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
					const root = rootFor(ctx);
					const sessionKey = hostSessionKey(ctx, root);
					const pool = getPool(state, sessionKey);
					const bundleKey = `${sessionKey}\u0000${role}`;
					let built = state.bundles.get(bundleKey);
					try {
						if (built === undefined) {
							const onCallActivity = ({ active, program }) => {
								if (typeof program !== "string" || program.length === 0) return;
								if (active) {
									pool.activeCalls.add(program);
									const direct = pool.pendingForeground.get(program);
									if (direct) {
										direct();
									} else {
										for (const trigger of pool.pendingForeground.values()) {
											trigger();
										}
									}
								} else {
									pool.activeCalls.delete(program);
								}
								for (const item of pool.inFlight.values()) {
									if (item.programName === program) {
										item.inCall = active;
									}
								}
								for (const listener of pool.callListeners) {
									listener();
								}
							};
							const onWaitLock = (waiting = true) => {
								if (waiting) {
									pool.waitingLocks.add(role);
									for (const [progName, trigger] of pool.pendingForeground.entries()) {
										if (pool.pendingRoles.get(progName) === role) {
											trigger();
										}
									}
								} else {
									pool.waitingLocks.delete(role);
								}
								for (const listener of pool.callListeners) {
									listener();
								}
							};
							built = buildBundle(role, root, `${ownerId}:${role}`, state.callMeta, onCallActivity, onWaitLock);
							state.bundles.set(bundleKey, built);
						}
					} catch (error) {
						return toolFailure(error);
					}

					const callId =
						typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : `fork-${randomUUID().slice(0, 12)}`;
					state.callMeta.set(callId, { deadlineAt: Date.now() + forkDeadlineMs });
					const entry = {
						callId,
						toolName,
						role,
						programName: validated.programName,
						session: built.session,
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
					const triggerBackground = () => {
						if (settledNormally || backgrounded) return;
						backgrounded = true;
						pool.pendingForeground.delete(validated.programName);
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

					pool.pendingRoles.set(validated.programName, role);
					pool.pendingForeground.set(validated.programName, triggerBackground);

					const runPromise = Promise.resolve()
						.then(() => built.tool.execute(callId, { name: validated.programName, code: validated.code }, signal))
						.catch((error) => toolFailure(error))
						.then((result) => {
							state.callMeta.delete(callId);
							pool.pendingForeground.delete(validated.programName);
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
					return await Promise.race([runPromise, bgPromise]);
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
				const root = rootFor(ctx);
				const pool = getPool(state, hostSessionKey(ctx, root));
				while (pool.startingPromises.size > 0) {
					await Promise.all([...pool.startingPromises]);
				}
				if (pool.backlog.length > 0) {
					const items = pool.backlog.splice(0, pool.backlog.length);
					return formatJoinedResults(items, pool);
				}
				if (pool.inFlight.size === 0) {
					return formatIdleReceipt();
				}
				if (signal?.aborted === true) {
					return toolFailure(herdError("UPSTREAM_ABORTED", "join was cancelled before waiting"));
				}

				const waitMs = waitMsFor(plan, baseWaitMs);
				return await new Promise((resolvePromise) => {
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

					const onDeadline = () => {
						if (settled) return;
						settled = true;
						cleanup();
						const targets = [...pool.inFlight.values()].filter((item) => !item.claimed);
						if (targets.length === 0) {
							resolvePromise(formatWaitingDeadlineReceipt(waitMs, pool));
							return;
						}
						const parkedTargets = [];
						for (const item of targets) {
							if (parkProgramOnDeadline(item.session, item.programName).ok) {
								item.claimed = true;
								parkedTargets.push(item);
							}
						}
						if (parkedTargets.length === 0) {
							resolvePromise(formatWaitingDeadlineReceipt(waitMs, pool));
							return;
						}
						void Promise.all(parkedTargets.map((item) => item.donePromise)).then((settledItems) => {
							resolvePromise(formatJoinedResults(settledItems, pool));
						});
					};

					const syncTimer = () => {
						if (settled) return;
						if (pool.activeCalls.size > 0 || pool.waitingLocks.size > 0) {
							if (timer === null) {
								tickingSince = Date.now();
								timer = setTimeout(onDeadline, Math.max(1, remainingMs));
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

	pi.registerCommand?.("clj-status", {
		description: "Show the ClojureScript sandbox health.",
		async handler(_args, ctx) {
			const cherry = cherryStatus();
			const lines = [
				`clj-core: ${cherry.loaded ? "ready" : "not-loaded"}${cherry.version ? ` (cherry-cljs ${cherry.version})` : ""}`,
				`tools: ${CLJ_TOOL_NAMES.join(", ")}`,
				`host tool blacklist: ${HOST_TOOL_BLACKLIST.join(", ")}`,
				"surface: async clj_* fork + unified join only; /herd, board, worktrees, and audit are not enabled",
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
		pi.on("context", (event, ctx) => {
			const root = rootFor(ctx);
			const prefix = `${hostSessionKey(ctx, root)}\u0000`;
			const undecided = [];
			for (const [bundleKey, built] of state.bundles.entries()) {
				if (!bundleKey.startsWith(prefix)) continue;
				const role = bundleKey.slice(prefix.length);
				const toolName = TOOL_NAMES[role] ?? role;
				for (const name of parkedNames(built.session)) {
					undecided.push(`- ${toolName}: ${name}`);
				}
			}
			if (undecided.length === 0) return undefined;
			const reminder = {
				role: "user",
				content: [
					{
						type: "text",
						text: [
							"<system-reminder>",
							"<UNDECIDED-PARKED-PROGRAMS>",
							"The following sandbox programs are still parked and undecided (holding continuations and memory).",
							'Resolve each one by calling `(unpark {:name "..." :value ...})` to resume or `(abandon {:name "..."})` to abort and discard it:',
							...undecided,
							"</UNDECIDED-PARKED-PROGRAMS>",
							"</system-reminder>",
						].join("\n"),
					},
				],
			};
			const messages = Array.isArray(event?.messages) ? [...event.messages, reminder] : [reminder];
			return { messages };
		});
	}

	const cherry = cherryStatus();
	const hooksReady = typeof pi.on === "function";
	const degraded = failures.length > 0 || !cherry.loaded || !hooksReady;
	recordHealth({
		entry: ENTRY,
		status: degraded ? "degraded" : "ok",
		version: VERSION,
		capabilities: {
			tools: [...CLJ_TOOL_NAMES],
			hostToolBlacklist: HOST_TOOL_BLACKLIST.length,
			cherry: cherry.loaded,
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
							: !cherry.loaded
								? "cherry-cljs unavailable"
								: "pi.on is unavailable; the host tool blacklist cannot be enforced",
				}
			: {}),
	});
	return state;
}

export default async function activate(pi) {
	// Load Cherry once up front so `/clj-status` tells the truth before the
	// first program. A load failure does not throw into the host: each tool
	// call returns a structured error when the runtime is missing.
	await loadCherry();
	return registerCljTools(pi);
}
