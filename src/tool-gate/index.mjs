/**
 * G1: the tool-gate entry.
 *
 * This entry injects the gate arguments into provider tool schemas, validates
 * and accounts for them on every tool call, writes the intent deadline to the
 * cross-entry CallMeta port, and strips the arguments before execution.
 *
 * A trusted first-line role token narrows a subagent's active tools and is
 * re-checked on every tool call. The `tool_call` guard is the hard boundary,
 * so a host that auto-adds `hub` or an extension tool cannot bypass it.
 * Only a host-reported subagent consults a token; a main-session prompt
 * cannot grant a role.
 *
 * Failure isolation: the entry never throws into the host loop. A missing
 * provider hook, a missing `{input}` rewrite, or a broken tool schema degrades
 * the gate and leaves the host usable. Bare host tools are blocked only while
 * a mission snapshot says a mission is active.
 */

import { createHash } from "node:crypto";
import { recordHealth } from "../host/health.mjs";
import { admit, ledgerFor, settle } from "../scope/ledger.mjs";
import { herdError, messageOf, renderError } from "../util/errors.mjs";
import { GATE_KEYS, injectGateFields, stripGateFields } from "./schema.mjs";

const ENTRY = "tool-gate";
const ENTRY_VERSION = "1";
const CALL_META_KEY = Symbol.for("herdchestra.callMeta.v1");
const ADMISSION_RECEIPT_KEY = Symbol.for("herdchestra.toolGate.receipts.v1");
const MISSION_PORT_KEY = Symbol.for("herdchestra.mission.v1");
/** M0 publishes the authoritative role surface keyed by role name. */
export const ROLE_SURFACE_SYMBOL = Symbol.for("herdchestra.roleSurfaces.v1");
const CALL_META_LIMIT = 2048;
const ANONYMOUS_CALL_LIMIT = 100000;
const [THINK_KEY, , INTENT_KEY, SCOPE_KEY] = GATE_KEYS;

/**
 * Cross-entry mission snapshot. M0 publishes a frozen object under
 * `MISSION_PORT_SYMBOL`:
 *
 *   { active: boolean, slug?: string, role?: string,
 *     blockedTools?: string[], blocked_tools?: string[] }
 *
 * A function returning the same object is also accepted. Absence means no
 * mission is active, so bare host tools stay available.
 */
export const MISSION_PORT_SYMBOL = MISSION_PORT_KEY;

const GATE_EXEMPT_TOOLS = new Set(["ask_previous_scope", "askPreviousScope", "ask-previous-scope", "assume"]);

const DEFAULT_BARE_TOOLS = Object.freeze(["read", "write", "edit", "bash", "powershell", "grep", "glob", "find", "ls"]);
const BARE_TOOL_SET = new Set(DEFAULT_BARE_TOOLS);

const COMMON_SUBAGENT_TOOLS = Object.freeze([
	"ask_previous_scope",
	"askPreviousScope",
	"ask-previous-scope",
	"assume",
	"yield",
]);

/**
 * Host surfaces a sandboxed subagent must never reach. This mirrors H1's
 * local hard boundary and adds the host aliases that can bypass the VFS.
 */
const FORBIDDEN_SUBAGENT_TOOLS = new Set([
	"apply_patch",
	"bash",
	"edit",
	"eval",
	"exec",
	"find",
	"glob",
	"grep",
	"hub",
	"ls",
	"powershell",
	"python",
	"read",
	"task",
	"write",
]);

const ROLE_TOKEN_PATTERN = /^\[HERD_ROLE: ([A-Za-z][A-Za-z0-9 _-]*) nonce=([A-Za-z0-9_-]{8,128})\]$/;

const activeTurns = new Map();
const lastTurns = new Map();
const turnSequences = new Map();
const roleTokens = new Map();
const roleFailures = new Map();
const activated = new WeakSet();
let anonymousCalls = 0;
let gateOptions = Object.freeze({ includeWorkers: true });

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function isObjectLike(value) {
	return value !== null && (typeof value === "object" || typeof value === "function");
}

/**
 * Change provider-side injection options. M0's `/herd-settings` calls this;
 * the default injects the scheduling self-check field.
 *
 * @param {{ includeWorkers?: boolean }} [options]
 * @returns {{ includeWorkers: boolean }}
 */
export function configureToolGate(options = {}) {
	if (isObject(options) && typeof options.includeWorkers === "boolean") {
		gateOptions = Object.freeze({ ...gateOptions, includeWorkers: options.includeWorkers });
	}
	return { ...gateOptions };
}

// ---------------------------------------------------------------------------
// CallMeta port
// ---------------------------------------------------------------------------

/**
 * Return a process-wide map stored under one global symbol, or undefined when
 * the slot cannot hold it. Every entry module sees the same map.
 *
 * @param {symbol} key
 * @returns {Map<string, Readonly<Record<string, unknown>>> | undefined}
 */
function globalMap(key) {
	try {
		const scope = globalThis;
		let registry = scope[key];
		if (!(registry instanceof Map)) {
			registry = new Map();
			Object.defineProperty(scope, key, {
				value: registry,
				configurable: true,
				enumerable: false,
				writable: false,
			});
		}
		return registry;
	} catch {
		return undefined;
	}
}

/** @returns {Map<string, Readonly<Record<string, unknown>>> | undefined} */
function callMetaRegistry() {
	return globalMap(CALL_META_KEY);
}

/** @returns {Map<string, Readonly<Record<string, unknown>>> | undefined} */
function receiptRegistry() {
	return globalMap(ADMISSION_RECEIPT_KEY);
}

/**
 * Write the intent deadline for one tool call. The function runs before the
 * gate fields are stripped, so C4/C2 can read the deadline by `toolCallId`.
 *
 * @param {unknown} toolCallId
 * @param {unknown} meta
 * @returns {boolean}
 */
export function writeCallMeta(toolCallId, meta) {
	try {
		if (typeof toolCallId !== "string" || toolCallId.length === 0) return false;
		if (!isObject(meta)) return false;
		const intentBytes = meta.intentBytes;
		const deadlineAt = meta.deadlineAt;
		if (!Number.isInteger(intentBytes) || intentBytes < 0) return false;
		if (!Number.isFinite(deadlineAt) || deadlineAt < 0) return false;
		const registry = callMetaRegistry();
		if (registry === undefined) return false;
		const record = Object.freeze({
			toolCallId,
			intentBytes,
			deadlineAt,
			scopeDigest: typeof meta.scopeDigest === "string" ? meta.scopeDigest : "",
		});
		registry.delete(toolCallId);
		registry.set(toolCallId, record);
		while (registry.size > CALL_META_LIMIT) {
			const oldest = registry.keys().next().value;
			if (oldest === undefined) break;
			registry.delete(oldest);
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Read the intent deadline that G1 wrote before stripping.
 *
 * @param {unknown} toolCallId
 * @returns {Readonly<Record<string, unknown>> | undefined}
 */
export function readCallMeta(toolCallId) {
	try {
		if (typeof toolCallId !== "string" || toolCallId.length === 0) return undefined;
		const registry = callMetaRegistry();
		const record = registry?.get(toolCallId);
		if (!isObject(record)) return undefined;
		if (!Number.isInteger(record.intentBytes) || !Number.isFinite(record.deadlineAt)) return undefined;
		return record;
	} catch {
		return undefined;
	}
}

/**
 * Read the short Scope receipt that the tool wrapper should render. G1 keeps
 * it by `toolCallId`; the receipt has no goal text and no system rules.
 *
 * @param {unknown} toolCallId
 * @returns {Readonly<Record<string, unknown>> | undefined}
 */
export function readAdmissionReceipt(toolCallId) {
	try {
		if (typeof toolCallId !== "string" || toolCallId.length === 0) return undefined;
		const registry = receiptRegistry();
		const record = registry?.get(toolCallId);
		return isObject(record) ? record : undefined;
	} catch {
		return undefined;
	}
}

/**
 * @param {string} toolCallId
 * @param {Record<string, unknown>} admitted
 * @returns {boolean}
 */
function writeAdmissionReceipt(toolCallId, admitted) {
	try {
		const registry = receiptRegistry();
		if (registry === undefined) return false;
		const notice =
			isObject(admitted.notice) && typeof admitted.notice.code === "string"
				? Object.freeze({
						code: admitted.notice.code,
						message: typeof admitted.notice.message === "string" ? admitted.notice.message : "",
					})
				: undefined;
		const record = Object.freeze({
			toolCallId,
			turnId: typeof admitted.turnId === "string" ? admitted.turnId : null,
			exempt: admitted.exempt === true,
			kind: typeof admitted.kind === "string" ? admitted.kind : null,
			retention: Number.isFinite(admitted.retention) ? admitted.retention : 0,
			retentionAfterSettlement: Number.isFinite(admitted.retentionAfterSettlement)
				? admitted.retentionAfterSettlement
				: Number.isFinite(admitted.retention)
					? admitted.retention
					: 0,
			...(notice === undefined ? {} : { notice }),
		});
		registry.delete(toolCallId);
		registry.set(toolCallId, record);
		while (registry.size > CALL_META_LIMIT) {
			const oldest = registry.keys().next().value;
			if (oldest === undefined) break;
			registry.delete(oldest);
		}
		return true;
	} catch {
		return false;
	}
}

/** @param {unknown} toolCallId */
function deleteCallMeta(toolCallId) {
	try {
		if (typeof toolCallId === "string" && toolCallId.length > 0) {
			callMetaRegistry()?.delete(toolCallId);
			receiptRegistry()?.delete(toolCallId);
		}
	} catch {
		// Cleanup is best effort; the bounded registry still prevents a leak.
	}
}

/**
 * @param {unknown} scope
 * @returns {string}
 */
function scopeDigest(scope) {
	try {
		const digest = createHash("sha256").update(stableStringify(scope), "utf8").digest("hex");
		return digest;
	} catch {
		return "";
	}
}

/** @param {unknown} value @returns {string} */
function stableStringify(value) {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (isObject(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
	}
	const encoded = JSON.stringify(value);
	return encoded === undefined ? "null" : encoded;
}

// ---------------------------------------------------------------------------
// Mission port and host capabilities
// ---------------------------------------------------------------------------

/** @returns {Record<string, unknown> | undefined} */
function readMissionState() {
	try {
		const port = globalThis[MISSION_PORT_KEY];
		let value;
		if (typeof port === "function") value = port();
		else if (isObject(port) && typeof port.get === "function") value = port.get();
		else value = port;
		return isObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * @param {Record<string, unknown>} state
 * @returns {Set<string>}
 */
function bareToolsFor(state) {
	const custom = state.blockedTools ?? state.blocked_tools;
	if (Array.isArray(custom) && custom.every((tool) => typeof tool === "string")) {
		return new Set(custom);
	}
	return BARE_TOOL_SET;
}

/** @returns {string | undefined} */
function hostVersion() {
	const value = process.env.OMP_VERSION;
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The local HACK.md probe measured `tool_call` `{input}` on the running
 * 18.16.0 host. A 16.x host does not support it; an unknown version keeps the
 * measured default. `HERD_TOOL_CALL_INPUT=0|1` overrides the guess.
 *
 * @returns {boolean}
 */
function supportsToolCallInput() {
	const override = process.env.HERD_TOOL_CALL_INPUT;
	if (override === "0" || override === "false") return false;
	if (override === "1" || override === "true") return true;
	const version = hostVersion();
	const match = /^v?(\d+)/.exec(version ?? "");
	if (match === null) return true;
	return Number(match[1]) >= 18;
}

/**
 * @param {unknown} ctx
 * @returns {{ sessionId: string, agentId: string }}
 */
function sessionIdentity(ctx) {
	let sessionId = "main";
	try {
		const manager = isObject(ctx) ? ctx.sessionManager : undefined;
		if (isObject(manager) && typeof manager.getSessionId === "function") {
			const value = manager.getSessionId();
			if (typeof value === "string" && value.length > 0) sessionId = value;
		}
	} catch {
		// M0 uses "main" when the session manager cannot name the session.
	}
	// M0 keys the ledger, board, and sandbox with `(state.id, state.id)`.
	// Each session owns one agent, so the session id is the shared agent id.
	return { sessionId, agentId: sessionId };
}

/**
 * Whether the host marks this context as a subagent. The local 18.16.0 host
 * reports `kind: "sub"` and `depth > 0`; a main session reports `kind: "main"`.
 *
 * @param {unknown} ctx
 * @returns {boolean}
 */
function isSubagent(ctx) {
	try {
		const agent = isObject(ctx) ? ctx.agent : undefined;
		if (!isObject(agent)) return false;
		if (agent.kind === "sub" || agent.kind === "subagent") return true;
		return Number.isFinite(agent.depth) && agent.depth > 0;
	} catch {
		return false;
	}
}

/** @param {{ sessionId: string, agentId: string }} identity */
function ledgerKey(identity) {
	return `${identity.sessionId}\u0000${identity.agentId}`;
}

/** @param {unknown} toolCallId */
function callIdOf(toolCallId) {
	if (typeof toolCallId === "string" && toolCallId.length > 0) return toolCallId;
	anonymousCalls = (anonymousCalls + 1) % ANONYMOUS_CALL_LIMIT;
	return `anonymous-${anonymousCalls}`;
}

/**
 * Return the turn id that every tool call in one model turn must share.
 * `turn_start` owns the id when the host emits it. Without that event, the
 * first non-exempt call opens one pending turn until `turn_end` / `agent_end`.
 *
 * @param {string} key
 * @returns {string}
 */
function ensureTurnId(key) {
	const active = activeTurns.get(key);
	if (active !== undefined) return active;
	const last = lastTurns.get(key);
	if (last !== undefined) return last;
	const pending = `turn:pending-${callIdOf(undefined)}`;
	lastTurns.set(key, pending);
	return pending;
}

/**
 * A process-unique turn id. The host turn index alone may repeat after a
 * session compaction; the sequence keeps ledger settlement unambiguous.
 *
 * @param {string} key
 * @param {unknown} index
 * @returns {string}
 */
function nextTurnId(key, index) {
	const sequence = (turnSequences.get(key) ?? 0) + 1;
	turnSequences.set(key, sequence);
	const suffix = typeof index === "number" && Number.isFinite(index) ? index : "anonymous";
	return `turn:${sequence}:${suffix}`;
}

/** @param {string} toolName */
function isSandboxTool(toolName) {
	return toolName.startsWith("clj_");
}

/** @param {string} toolName */
function isDiscoveredTool(toolName) {
	return (
		toolName.startsWith("mcp__") ||
		toolName.startsWith("mcp:") ||
		toolName.startsWith("lsp_") ||
		toolName.startsWith("irc_")
	);
}

/**
 * Tool names allowed for one subagent role. M0 publishes the authoritative
 * surface; common Scope helpers and `yield` always stay. Forbidden host
 * surfaces are removed even when the published list adds them.
 *
 * @param {string} role
 * @returns {string[] | undefined}
 */
function roleSurfaceFor(role) {
	let overrides;
	try {
		const value = globalThis[ROLE_SURFACE_SYMBOL];
		overrides = isObject(value) ? value : undefined;
	} catch {
		overrides = undefined;
	}
	const declared = overrides !== undefined ? overrides[role] : undefined;
	if (!Array.isArray(declared)) return undefined;
	const surface = new Set(COMMON_SUBAGENT_TOOLS);
	for (const tool of declared) {
		if (typeof tool === "string" && tool.length > 0 && !isDiscoveredTool(tool)) surface.add(tool);
	}
	for (const tool of FORBIDDEN_SUBAGENT_TOOLS) surface.delete(tool);
	return [...surface];
}

/**
 * Parse H1's first-line role token. The token is a parent-written role
 * declaration; M0's published surface decides whether the role is usable.
 *
 * @param {string} prompt
 * @returns {Readonly<{ role: string, nonce: string }> | undefined}
 */
function parseRoleToken(prompt) {
	if (typeof prompt !== "string") return undefined;
	const firstLine = prompt.split(/\r?\n/, 1)[0];
	const match = ROLE_TOKEN_PATTERN.exec(firstLine);
	if (match === null) return undefined;
	const role = match[1];
	const nonce = match[2];
	return Object.freeze({ role, nonce });
}

/**
 * @param {unknown} event
 * @returns {string}
 */
function promptFromEvent(event) {
	if (!isObject(event)) return "";
	if (typeof event.prompt === "string") return event.prompt;
	if (event.messageType === "custom" && isObject(event.message)) {
		const content = event.message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((part) => isObject(part) && part.type === "text" && typeof part.text === "string")
				.map((part) => part.text)
				.join("\n");
		}
	}
	return "";
}

/**
 * @param {string} role
 * @param {string} toolName
 * @returns {boolean}
 */
function isRoleToolAllowed(role, toolName) {
	if (typeof toolName !== "string") return false;
	const surface = roleSurfaceFor(role);
	return surface?.includes(toolName) === true;
}

// ---------------------------------------------------------------------------
// Error and health presentation
// ---------------------------------------------------------------------------

/**
 * @param {unknown} error
 * @returns {string}
 */
function renderGateError(error) {
	try {
		if (isObject(error) && typeof error.code === "string") {
			const data = isObject(error.data) ? error.data : isObject(error.details) ? error.details : {};
			return renderError(herdError(error.code, messageOf(error), data));
		}
		return renderError(error);
	} catch {
		return renderError(herdError(":INVALID_ARGUMENT", "tool gate rejected the call", {}));
	}
}

/** @param {unknown} error */
function blockReason(error) {
	return { block: true, reason: renderGateError(error) };
}

/** @param {unknown} pi @param {string} name @param {(event: unknown, ctx?: unknown) => unknown} handler */
function safeOn(pi, name, handler) {
	try {
		if (!isObjectLike(pi) || typeof pi.on !== "function") return false;
		pi.on(name, handler);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * @param {import("@oh-my-pi/pi-coding-agent").ExtensionAPI} pi
 */
export default function activate(pi) {
	const hasToolCallInput = supportsToolCallInput();
	const registrationErrors = [];
	let hasSetActiveTools = false;
	try {
		hasSetActiveTools = isObjectLike(pi) && typeof pi.setActiveTools === "function";
	} catch {
		hasSetActiveTools = false;
	}
	const capability = {
		hostVersion: hostVersion() ?? "unknown",
		schemaInjector: true,
		scopeLedger: true,
		callMeta: true,
		receiptPort: true,
		roleGuard: true,
		roleSurfacePort: true,
		roleNarrowing: hasSetActiveTools,
		hasToolCallInput,
		toolCallInputOverride: process.env.HERD_TOOL_CALL_INPUT ?? "auto",
		hasSetActiveTools,
		workersInjection: gateOptions.includeWorkers,
	};

	let hasOn = false;
	try {
		hasOn = isObjectLike(pi) && typeof pi.on === "function";
	} catch {
		hasOn = false;
	}
	if (!hasOn) {
		try {
			recordHealth({
				entry: ENTRY,
				status: "failed",
				version: ENTRY_VERSION,
				capabilities: { ...capability, toolCallGate: false },
				requiredCapabilities: ["schemaInjector", "scopeLedger", "callMeta", "toolCallGate"],
				degraded: true,
				error: "ExtensionAPI.on is unavailable",
			});
		} catch {
			// Health is best effort.
		}
		return;
	}
	if (activated.has(pi)) return;

	let injectionReady = true;
	let toolCallReady = false;
	let beforeAgentStartReady = false;
	let turnReady = false;
	let agentEndReady = false;
	let cleanupReady = false;
	let healthStatus = "ok";
	let healthError;

	const reportHealth = () => {
		const capabilities = {
			...capability,
			injectionReady,
			toolCallReady,
			toolCallGate: toolCallReady,
			beforeAgentStartReady,
			turnReady,
			agentEndReady,
			cleanupReady,
			missionPort: readMissionState() !== undefined,
		};
		const degraded = healthStatus !== "ok";
		try {
			recordHealth({
				entry: ENTRY,
				status: healthStatus,
				version: ENTRY_VERSION,
				capabilities,
				requiredCapabilities: ["schemaInjector", "scopeLedger", "callMeta", "toolCallGate"],
				degraded,
				error: healthError,
			});
		} catch {
			// Health is best effort; a broken registry must not break the gate.
		}
	};

	const degrade = (error) => {
		healthStatus = "degraded";
		healthError = messageOf(error);
		reportHealth();
	};

	/**
	 * @param {string} key
	 * @param {string} reason
	 */
	const denyRole = (key, reason) => {
		roleFailures.set(key, reason);
		roleTokens.delete(key);
		degrade(new Error(`role token rejected: ${reason}`));
	};

	/**
	 * @param {{ role: string, nonce: string }} role
	 */
	const applyRoleSurface = async (role) => {
		try {
			if (typeof pi.setActiveTools !== "function") {
				degrade(new Error("setActiveTools is unavailable; role narrowing relies on the tool_call guard"));
				return;
			}
			const surface = roleSurfaceFor(role.role);
			if (surface === undefined) {
				degrade(new Error(`role surface is not published: ${role.role}`));
				return;
			}
			await pi.setActiveTools(surface);
		} catch (error) {
			degrade(error);
		}
	};

	const onBeforeAgentStart = async (event, ctx) => {
		try {
			const identity = sessionIdentity(ctx);
			const key = ledgerKey(identity);
			if (roleFailures.has(key)) return;
			if (!isObject(event)) return;
			if (event.reason !== undefined && event.reason !== "prompt" && event.reason !== "custom") return;
			const prompt = promptFromEvent(event);
			if (prompt.length === 0) return;
			const firstLine = prompt.split(/\r?\n/, 1)[0];
			const candidate = firstLine.replace(/^[\s\uFEFF]+/u, "");
			const tokenLike = candidate.startsWith("[HERD_ROLE:");
			if (!isSubagent(ctx)) {
				// A role token is only meaningful with a host-reported child
				// identity. Without ctx.agent the token cannot be trusted, so a
				// token-bearing session fails closed instead of falling back to
				// the main-session tool surface.
				if (tokenLike) denyRole(key, "host cannot identify a subagent context");
				return;
			}
			if (!tokenLike) return;
			const role = parseRoleToken(prompt);
			if (role === undefined) {
				denyRole(key, "malformed or unknown role token");
				return;
			}
			if (roleSurfaceFor(role.role) === undefined) {
				denyRole(key, "role surface is not published");
				return;
			}
			if (roleTokens.has(key)) {
				const existing = roleTokens.get(key);
				if (existing !== undefined) {
					if (existing.role !== role.role || existing.nonce !== role.nonce) {
						denyRole(key, "role token changed");
						return;
					}
					await applyRoleSurface(existing);
				}
				return;
			}
			roleTokens.set(key, role);
			await applyRoleSurface(role);
		} catch (error) {
			degrade(error);
		}
	};

	/**
	 * @param {{ sessionId: string, agentId: string }} identity
	 * @param {string} key
	 * @param {string} turnId
	 */
	const settleTurn = (identity, key, turnId) => {
		try {
			const ledger = ledgerFor(identity.sessionId, identity.agentId);
			const result = settle(ledger, { turnId });
			if (result?.ok !== true && result?.error?.code !== "SCOPE_TURN_MISSING") {
				degrade(result?.error ?? new Error("Scope settlement failed"));
			}
		} catch (error) {
			degrade(error);
		}
		activeTurns.delete(key);
		lastTurns.delete(key);
	};

	/**
	 * @param {{ input?: unknown }} event
	 * @param {Record<string, unknown> | undefined} stripped
	 */
	const applyStrippedInput = (event, stripped) => {
		if (stripped === undefined) return undefined;
		// 18.x supports returning a rewritten input. Do not mutate the
		// validated copy on that path; the host uses the returned object.
		if (hasToolCallInput) return { input: stripped };
		// 16.x ignores the returned input. The host validates a structuredClone
		// of the tool call arguments, so mutating this copy cannot rewrite the
		// assistant tool call in the transcript.
		try {
			const input = isObject(event.input) ? event.input : {};
			for (const key of Object.keys(input)) delete input[key];
			for (const key of Object.keys(stripped)) {
				Object.defineProperty(input, key, {
					value: stripped[key],
					writable: true,
					enumerable: true,
					configurable: true,
				});
			}
			if (event.input !== input) event.input = input;
			return undefined;
		} catch (error) {
			degrade(error);
			return blockReason(
				herdError(":HOST_API_MISMATCH", "the host cannot strip gate fields in place", {
					next: "use a host that supports tool_call input rewriting or in-place mutation",
				}),
			);
		}
	};

	const onBeforeProviderRequest = (event) => {
		try {
			if (!isObject(event)) return undefined;
			if (!toolCallReady) return undefined;
			const changed = injectGateFields(event.payload, { includeWorkers: gateOptions.includeWorkers });
			injectionReady = true;
			if (changed) return event.payload;
			return undefined;
		} catch (error) {
			injectionReady = false;
			degrade(error);
			return undefined;
		}
	};

	const onToolCall = (event, ctx) => {
		try {
			if (!isObject(event) || typeof event.toolName !== "string" || event.toolName.length === 0) {
				return blockReason(
					herdError(":INVALID_ARGUMENT", "tool_call event has no tool name", {
						expected: "toolName",
					}),
				);
			}

			const identity = sessionIdentity(ctx);
			const key = ledgerKey(identity);
			const toolCallId = callIdOf(event.toolCallId);

			const roleFailure = roleFailures.get(key);
			if (roleFailure !== undefined) {
				return blockReason(
					herdError(":CAPABILITY_DENIED", "role token verification failed", {
						reason: roleFailure,
						next: "stop; use a parent-written valid role token",
					}),
				);
			}

			const role = roleTokens.get(key);
			if (role === undefined && isSubagent(ctx)) {
				const reason = "subagent has no verified role token";
				degrade(new Error(reason));
				return blockReason(
					herdError(":CAPABILITY_DENIED", reason, {
						tool: event.toolName,
						next: "spawn the child with a parent-written role token",
					}),
				);
			}

			const mission = readMissionState();
			if (mission?.active === true && bareToolsFor(mission).has(event.toolName)) {
				return blockReason(
					herdError(":CAPABILITY_DENIED", "bare host tool is blocked during a Herdchestra mission", {
						tool: event.toolName,
						...(typeof mission.slug === "string" ? { mission: mission.slug } : {}),
						next: "use the role's clj_* sandbox tool",
					}),
				);
			}

			if (role !== undefined) {
				if (!isRoleToolAllowed(role.role, event.toolName)) {
					return blockReason(
						herdError(":CAPABILITY_DENIED", "tool is not authorized for this role", {
							tool: event.toolName,
							role: role.role,
							next: "use only the role's allowed tools",
						}),
					);
				}
			}

			if (role === undefined && event.toolName === "yield") {
				return blockReason(
					herdError(":CAPABILITY_DENIED", "yield is available only to subagents", {
						tool: "yield",
						next: "finish the task without yield in a main session",
					}),
				);
			}

			const input = event.input;
			let ledger;
			try {
				ledger = ledgerFor(identity.sessionId, identity.agentId);
			} catch (error) {
				degrade(error);
				return blockReason(herdError(":SCOPE_INVALID", "Scope ledger is unavailable", { tool: event.toolName }));
			}

			if (GATE_EXEMPT_TOOLS.has(event.toolName)) {
				const turnId = activeTurns.get(key) ?? lastTurns.get(key) ?? `exempt:${toolCallId}`;
				let exemptAdmission;
				try {
					exemptAdmission = admit(ledger, isObject(input) ? input.scope : undefined, {
						tool: event.toolName,
						turnId,
						callId: toolCallId,
					});
				} catch (error) {
					degrade(error);
				}
				if (exemptAdmission?.ok === true) writeAdmissionReceipt(toolCallId, exemptAdmission);
				return applyStrippedInput(event, isObject(input) ? stripGateFields(input) : undefined);
			}

			// A nested call is made by an already-admitted tool, not by the
			// model. It cannot carry a model-authored annotation; the parent
			// call owns the accounting.
			if (typeof event.parentToolCallId === "string" && event.parentToolCallId.length > 0) {
				return applyStrippedInput(event, isObject(input) ? stripGateFields(input) : undefined);
			}

			// A non-object parameter schema cannot carry the gate fields. The
			// host already validated the call, so leave it untouched.
			if (!isObject(input)) return undefined;

			const missing = [];
			const think = Object.hasOwn(input, THINK_KEY) ? input[THINK_KEY] : undefined;
			if (!Object.hasOwn(input, THINK_KEY)) {
				missing.push(THINK_KEY);
			} else if (think !== "zh-cn") {
				return blockReason(
					herdError(":SCOPE_INVALID", `${THINK_KEY} must be zh-cn`, {
						tool: event.toolName,
						field: THINK_KEY,
						expected: "zh-cn",
					}),
				);
			}

			const intent = Object.hasOwn(input, INTENT_KEY) ? input[INTENT_KEY] : undefined;
			if (typeof intent !== "string" || intent.trim().length === 0) {
				missing.push(INTENT_KEY);
			}

			const scope = Object.hasOwn(input, SCOPE_KEY) ? input[SCOPE_KEY] : undefined;
			if (!Object.hasOwn(input, SCOPE_KEY)) missing.push(SCOPE_KEY);
			if (missing.length > 0) {
				if (!injectionReady) {
					degrade(new Error("gate fields missing while provider injection is degraded"));
				}
				if (readMissionState()?.active === true) {
					degrade(new Error("mission tool call missing gate fields"));
				}
				if (missing.length === 1 && missing[0] === INTENT_KEY) {
					return blockReason(
						herdError(":INTENT_REQUIRED", `${INTENT_KEY} must be a non-empty string`, {
							tool: event.toolName,
							field: INTENT_KEY,
						}),
					);
				}
				return blockReason(
					herdError(":SCOPE_INVALID", "missing gate fields", {
						tool: event.toolName,
						missing,
						next: "resend the same tool call with all missing fields; must_think_in='zh-cn', scope={kind:'keepLast'} or a resetScope object",
					}),
				);
			}
			if (isSandboxTool(event.toolName) && callMetaRegistry() === undefined) {
				return blockReason(
					herdError(":INTENT_REQUIRED", "CallMeta port is unavailable", {
						tool: event.toolName,
						field: INTENT_KEY,
						reason: "call-meta-unavailable",
					}),
				);
			}

			const turnId = ensureTurnId(key);
			const intentBytes = new TextEncoder().encode(intent).length;
			const meta = {
				toolCallId,
				intentBytes,
				deadlineAt: Date.now() + intentBytes * 50,
				scopeDigest: scopeDigest(scope),
			};
			const metaWritten = writeCallMeta(toolCallId, meta);
			if (!metaWritten && isSandboxTool(event.toolName)) {
				return blockReason(
					herdError(":INTENT_REQUIRED", "CallMeta could not be stored", {
						tool: event.toolName,
						field: INTENT_KEY,
					}),
				);
			}
			if (!metaWritten) degrade(new Error("CallMeta is unavailable for this call"));

			let admitted;
			try {
				admitted = admit(ledger, scope, { tool: event.toolName, turnId, callId: toolCallId });
			} catch (error) {
				if (metaWritten) deleteCallMeta(toolCallId);
				throw error;
			}
			if (admitted?.ok !== true) {
				if (metaWritten) deleteCallMeta(toolCallId);
				return blockReason(admitted?.error ?? new Error("Scope admission failed"));
			}
			if (!writeAdmissionReceipt(toolCallId, admitted)) {
				degrade(new Error("admission receipt is unavailable"));
			}

			return applyStrippedInput(event, stripGateFields(input));
		} catch (error) {
			degrade(error);
			return blockReason(
				herdError(":INVALID_ARGUMENT", "tool gate failed closed", {
					tool: isObject(event) && typeof event.toolName === "string" ? event.toolName : undefined,
					cause: messageOf(error),
				}),
			);
		}
	};

	const onTurnStart = (event, ctx) => {
		try {
			const identity = sessionIdentity(ctx);
			const key = ledgerKey(identity);
			const previous = activeTurns.get(key) ?? lastTurns.get(key);
			if (previous !== undefined) settleTurn(identity, key, previous);
			const index = isObject(event) && Number.isFinite(event.turnIndex) ? event.turnIndex : undefined;
			const turnId = nextTurnId(key, index);
			activeTurns.set(key, turnId);
			lastTurns.delete(key);
		} catch (error) {
			degrade(error);
		}
	};

	const onTurnEnd = (_event, ctx) => {
		try {
			const identity = sessionIdentity(ctx);
			const key = ledgerKey(identity);
			const turnId = activeTurns.get(key) ?? lastTurns.get(key);
			if (turnId !== undefined) settleTurn(identity, key, turnId);
		} catch (error) {
			degrade(error);
		}
	};

	const onAgentEnd = (_event, ctx) => {
		try {
			const identity = sessionIdentity(ctx);
			const key = ledgerKey(identity);
			const turnId = activeTurns.get(key) ?? lastTurns.get(key);
			if (turnId !== undefined) settleTurn(identity, key, turnId);
		} catch (error) {
			degrade(error);
		}
	};

	const onToolExecutionEnd = (event) => {
		try {
			if (isObject(event)) deleteCallMeta(event.toolCallId);
		} catch (error) {
			degrade(error);
		}
	};

	injectionReady = safeOn(pi, "before_provider_request", onBeforeProviderRequest);
	if (!injectionReady) registrationErrors.push("before_provider_request is unavailable");
	toolCallReady = safeOn(pi, "tool_call", onToolCall);
	if (!toolCallReady) registrationErrors.push("tool_call is unavailable");
	beforeAgentStartReady = safeOn(pi, "before_agent_start", onBeforeAgentStart);
	if (!beforeAgentStartReady) registrationErrors.push("before_agent_start is unavailable");
	turnReady = safeOn(pi, "turn_start", onTurnStart) && safeOn(pi, "turn_end", onTurnEnd);
	if (!turnReady) registrationErrors.push("turn events are unavailable");
	agentEndReady = safeOn(pi, "agent_end", onAgentEnd);
	if (!agentEndReady) registrationErrors.push("agent_end is unavailable");
	cleanupReady = safeOn(pi, "tool_execution_end", onToolExecutionEnd);
	if (!cleanupReady) registrationErrors.push("tool_execution_end is unavailable");
	activated.add(pi);

	if (!injectionReady || !toolCallReady) {
		healthStatus = "failed";
	} else if (!hasToolCallInput || !beforeAgentStartReady || !turnReady || !cleanupReady) {
		healthStatus = "degraded";
	}
	const problems = [...registrationErrors];
	if (!hasToolCallInput) {
		problems.push("tool_call {input} is not verified on this host; stripping falls back to in-place mutation");
	}
	if (problems.length > 0) healthError = problems.join("; ");
	reportHealth();
}
