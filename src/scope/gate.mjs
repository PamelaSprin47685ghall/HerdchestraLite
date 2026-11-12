/**
 * Scope gate (points 1–3 only: wire schema injection, Scope admission/settlement,
 * and pre-execution stripping). No bare-tool blocking or role-token guard.
 */

import { admit, ledgerFor, settle } from "./ledger.mjs";
import { injectGateFields, stripGateFields } from "./schema.mjs";

const GATE_EXEMPT_TOOLS = new Set(["ask_previous_scope", "askPreviousScope", "ask-previous-scope", "assume"]);
const SCOPE_KEY = "scope";

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionIdentity(ctx) {
	const manager = isObject(ctx) ? ctx.sessionManager : undefined;
	const sessionId =
		(typeof manager?.getSessionId === "function" ? manager.getSessionId() : undefined) ??
		(typeof ctx?.sessionId === "string" ? ctx.sessionId : undefined) ??
		"default-session";
	const agentId =
		(typeof ctx?.agent?.id === "string" && ctx.agent.id.length > 0 ? ctx.agent.id : undefined) ??
		(typeof ctx?.agentId === "string" && ctx.agentId.length > 0 ? ctx.agentId : undefined) ??
		sessionId;
	return { sessionId: String(sessionId), agentId: String(agentId) };
}

function ledgerKey(identity) {
	return `${identity.sessionId}\u0000${identity.agentId}`;
}

function applyStrippedInput(event, stripped) {
	if (stripped === undefined) return undefined;
	if (isObject(event) && isObject(event.input)) {
		return { input: stripped };
	}
	return undefined;
}

function blockReason(code, message, data = {}) {
	return {
		block: true,
		reason: JSON.stringify({ code, message, ...data }),
	};
}

/**
 * Register Scope wire-schema injection, `tool_call` admission/stripping, and
 * turn/agent-end settlement on `pi`.
 *
 * @param {any} pi
 * @param {{ includeWorkers?: boolean, includeIntent?: boolean }} [options]
 */
export function registerScopeGate(pi, options = {}) {
	if (!pi || typeof pi.on !== "function") {
		throw new TypeError("registerScopeGate: pi.on is required");
	}
	const includeWorkers = options.includeWorkers === true;
	const includeIntent = options.includeIntent === true;
	const activeTurns = new Map();
	const turnSeq = new Map();

	const ensureTurnId = (key) => {
		let turnId = activeTurns.get(key);
		if (turnId === undefined) {
			const next = (turnSeq.get(key) ?? 0) + 1;
			turnSeq.set(key, next);
			turnId = `turn-${next}`;
			activeTurns.set(key, turnId);
		}
		return turnId;
	};

	const settleTurn = (identity, key, turnId) => {
		const ledger = ledgerFor(identity.sessionId, identity.agentId);
		settle(ledger, { turnId });
		if (activeTurns.get(key) === turnId) {
			activeTurns.delete(key);
		}
	};

	pi.on("before_provider_request", (event) => {
		if (!isObject(event) || !isObject(event.payload)) return undefined;
		const changed = injectGateFields(event.payload, { includeWorkers, includeIntent });
		return changed ? { payload: event.payload } : undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		if (!isObject(event) || typeof event.toolName !== "string") return undefined;
		const input = isObject(event.input) ? event.input : undefined;
		if (GATE_EXEMPT_TOOLS.has(event.toolName)) {
			return applyStrippedInput(event, isObject(input) ? stripGateFields(input) : undefined);
		}
		if (typeof event.parentToolCallId === "string" && event.parentToolCallId.length > 0) {
			return applyStrippedInput(event, isObject(input) ? stripGateFields(input) : undefined);
		}
		if (!isObject(input)) return undefined;

		const scope = Object.hasOwn(input, SCOPE_KEY) ? input[SCOPE_KEY] : undefined;
		if (scope === undefined) {
			return blockReason(":SCOPE_INVALID", "missing required scope annotation", {
				tool: event.toolName,
				missing: [SCOPE_KEY],
				next: "resend the tool call with scope={kind:'keepLast'} or a resetScope object",
			});
		}

		const identity = sessionIdentity(ctx);
		const key = ledgerKey(identity);
		const turnId = ensureTurnId(key);
		const ledger = ledgerFor(identity.sessionId, identity.agentId);
		const toolCallId =
			typeof event.toolCallId === "string" && event.toolCallId.length > 0 ? event.toolCallId : `call-${Date.now()}`;
		const admitted = admit(ledger, scope, { tool: event.toolName, turnId, callId: toolCallId });
		if (admitted?.ok !== true) {
			const err = admitted?.error;
			return blockReason(err?.code ?? ":SCOPE_INVALID", err?.message ?? "Scope admission failed", err?.data ?? {});
		}
		return applyStrippedInput(event, stripGateFields(input));
	});

	pi.on("turn_start", (event, ctx) => {
		const identity = sessionIdentity(ctx);
		const key = ledgerKey(identity);
		const next = Number.isInteger(event?.turnIndex) ? event.turnIndex + 1 : (turnSeq.get(key) ?? 0) + 1;
		turnSeq.set(key, next);
		activeTurns.set(key, `turn-${next}`);
	});

	pi.on("turn_end", (event, ctx) => {
		const identity = sessionIdentity(ctx);
		const key = ledgerKey(identity);
		const turnId =
			activeTurns.get(key) ?? (Number.isInteger(event?.turnIndex) ? `turn-${event.turnIndex + 1}` : undefined);
		if (turnId !== undefined) settleTurn(identity, key, turnId);
	});

	pi.on("agent_end", (_event, ctx) => {
		const identity = sessionIdentity(ctx);
		const key = ledgerKey(identity);
		const turnId = activeTurns.get(key);
		if (turnId !== undefined) settleTurn(identity, key, turnId);
	});
}
