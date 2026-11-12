/**
 * Minimal dogfood surface: the ClojureScript sandbox only.
 *
 * This entry registers `clj_plan`, `clj_devops`, `clj_review`, and
 * `clj_worker` and nothing else. It deliberately does not load the mission
 * protocol, stage gates, board, worktrees, auditors, TUI, or the tool gate.
 * The point is to prove the evaluator, EDN/UFSS, VFS, and park/unpark on a
 * real host before adding the orchestration layers back.
 *
 * There is no role admission here: the calling session chooses the tool. That
 * is acceptable while this surface is a developer dogfood surface. Stage and
 * board role narrowing must return with the mission layer.
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { cherryStatus, loadCherry } from "./clj-sandbox/cherry.mjs";
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
/**
 * One-second grace, then 50ms per intent byte. No role floors.
 */
export function deadlineFor(intent, now = Date.now()) {
	const bytes = Buffer.byteLength(typeof intent === "string" ? intent : "", "utf8");
	return now + 1_000 + bytes * 50;
}
const SANDBOX_PARAMETERS = Object.freeze({
	type: "object",
	additionalProperties: false,
	required: ["code", "intent"],
	properties: {
		program_name: {
			type: "string",
			minLength: 1,
			description: "Optional REPL name for park/unpark; auto-generated when omitted.",
		},
		code: {
			type: "string",
			minLength: 1,
			description: "Bare ClojureScript REPL input; the last value is returned.",
		},
		intent: {
			type: "string",
			minLength: 1,
			description: "Concrete action intent. Deadline = UTF-8 bytes * 50ms + 1000ms.",
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

const CLJ_TOOL_NAMES = Object.freeze(TOOL_ROLES.map((role) => TOOL_NAMES[role]));

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

/**
 * A protected write gate backed by one lock file per workspace.
 *
 * VFS `commit` expects `runExclusive(fn)` to return `fn`'s value, not a lock
 * wrapper. Conflict reporting stays in VFS; this port only serializes.
 */
function createWriteGate(root, ownerId) {
	const lockPath = join(root, ".herd", "locks", "clj-core.write-w.lock");
	mkdirSync(join(root, ".herd", "locks"), { recursive: true });
	return {
		async runExclusive(run) {
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
			if (!acquired?.ok) {
				throw herdError(acquired?.code ?? ":BOARD_CONFLICT", acquired?.message ?? "write gate is held", {
					lock: lockPath,
					next: "wait for the current holder to finish, then retry the same program",
				});
			}
			return acquired.value;
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

function createPorts(root, ownerId, callMetaByCall, withWriteGate) {
	return {
		...(withWriteGate ? { writeGate: createWriteGate(root, ownerId) } : {}),
		control: createControl(),
		identity: { agent_id: ownerId, status: "alive", term_id: "clj-core" },
		claim: { claim_id: "clj-core", status: "active", term_id: "clj-core" },
		callMeta: (toolCallId) => callMetaByCall.get(toolCallId),
		agentId: ownerId,
		sessionKey: ownerId,
	};
}

function buildBundle(role, root, ownerId, callMetaByCall) {
	const callLogDir = role === "devops" ? join(root, ".herd", "artifacts", "clj-core") : undefined;
	if (callLogDir !== undefined) mkdirSync(callLogDir, { recursive: true });
	return buildSandboxTools({
		role,
		roots: {
			writeRoot: root,
			...(callLogDir !== undefined ? { callLogDir } : {}),
		},
		ports: createPorts(root, ownerId, callMetaByCall, role === "worker" || role === "devops"),
	});
}

/**
 * Apply the replaced-host-tool blacklist to the current active set.
 *
 * The operation is subtractive: `getActiveTools()` is filtered and passed
 * back, so unrelated tools keep their prior activation state. The four clj
 * tools are then ensured active because `registerTool` alone does not activate
 * an extension tool; that is self-registration, not a blanket allowlist.
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
 * Register the four sandbox tools. Kept as an exported function so a test or
 * a future assembly can compose the same surface without the omp default
 * entry.
 */
export function registerCljTools(pi, deps = {}) {
	if (!pi || typeof pi.registerTool !== "function") {
		throw new TypeError("clj-core: pi.registerTool is required");
	}
	const state = {
		bundles: new Map(),
		callMeta: new Map(),
	};
	const ownerId = deps.ownerId ?? `clj-core-${process.pid}`;
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
					const root = rootFor(ctx);
					const key = `${hostSessionKey(ctx, root)}\u0000${role}`;
					let built = state.bundles.get(key);
					try {
						if (built === undefined) {
							built = buildBundle(role, root, `${ownerId}:${role}`, state.callMeta);
							state.bundles.set(key, built);
						}
						const intent = typeof params.intent === "string" ? params.intent : "clj-core";
						if (typeof toolCallId === "string" && toolCallId.length > 0) {
							state.callMeta.set(toolCallId, { deadlineAt: deadlineFor(intent) });
						}
						return await built.tool.execute(
							toolCallId,
							{ program_name: params.program_name, code: params.code },
							signal,
						);
					} catch (error) {
						return toolFailure(error);
					} finally {
						if (typeof toolCallId === "string" && toolCallId.length > 0) state.callMeta.delete(toolCallId);
					}
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

	pi.registerCommand?.("clj-status", {
		description: "Show the ClojureScript sandbox health.",
		async handler(_args, ctx) {
			const cherry = cherryStatus();
			const lines = [
				`clj-core: ${cherry.loaded ? "ready" : "not-loaded"}${cherry.version ? ` (cherry-cljs ${cherry.version})` : ""}`,
				`tools: ${TOOL_ROLES.map((role) => TOOL_NAMES[role]).join(", ")}`,
				`host tool blacklist: ${HOST_TOOL_BLACKLIST.join(", ")}`,
				"surface: clj tools only; /herd, board, worktrees, and audit are not enabled",
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
	}

	const cherry = cherryStatus();
	const hooksReady = typeof pi.on === "function";
	const degraded = failures.length > 0 || !cherry.loaded || !hooksReady;
	recordHealth({
		entry: ENTRY,
		status: degraded ? "degraded" : "ok",
		version: VERSION,
		capabilities: {
			tools: TOOL_ROLES.map((role) => TOOL_NAMES[role]),
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
