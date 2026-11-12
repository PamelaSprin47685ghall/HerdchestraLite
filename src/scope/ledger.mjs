/**
 * Q0: the Scope ledger.
 *
 * Every non-exempt tool call carries a flat `scope` annotation. This module
 * owns admission (cold start, shape, budget), per-turn settlement, scope
 * archiving, and the two cross-reset pins: `ask_previous_scope` and `assume`.
 *
 * The ledger is mutable in-memory control state, keyed by session and agent in
 * the cross-entry `herdchestra.scope.v1` registry. Admission never changes
 * state on rejection. Settlement happens once per model turn, even when a turn
 * carries several tool calls; a replay of the same turn never spends twice.
 *
 * This module is pure JavaScript by design: no host import, no I/O, no clock.
 */

import * as utilErrors from "../util/errors.mjs";

const REGISTRY_KEY = "herdchestra.scope.v1";
const KIND_RESET = "resetScope";
const KIND_KEEP = "keepLast";
const KIND_REMOVE = "removeLast";
const KIND_METOO = "meToo";

const KINDS = new Set([KIND_RESET, KIND_KEEP, KIND_REMOVE, KIND_METOO]);
const EXEMPT_TOOLS = new Set(["ask_previous_scope", "askPreviousScope", "ask-previous-scope", "assume"]);
const RESET_REQUIRED_FIELDS = Object.freeze(["new_scope_goal", "new_scope_retention_budget"]);
const RESET_NEXT =
	"resend with scope={kind:'resetScope', new_scope_goal:'<non-empty goal>', new_scope_retention_budget:<positive integer>}";
const DECLARED_SCOPE_FIELDS = Object.freeze(["kind", "new_scope_goal", "new_scope_retention_budget", "replacement"]);
// The provider schema is one flat object. resetScope and removeLast may carry
// any declared field; only their required fields carry meaning. keepLast and
// meToo reject extras because COMMON says they take no additional fields.
const ALLOWED_FIELDS = {
	[KIND_RESET]: DECLARED_SCOPE_FIELDS,
	[KIND_KEEP]: ["kind"],
	[KIND_REMOVE]: DECLARED_SCOPE_FIELDS,
	[KIND_METOO]: ["kind"],
};
const SETTLED_TURN_LIMIT = 256;
const ADMITTED_CALL_LIMIT = 512;
const ASSUME_RECEIPT = "已笃定，不再因为没有信息增量的犹豫反复改判。";

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {Error & { code: string, data: Record<string, unknown> }}
 */
function scopeError(code, message, details = {}) {
	return utilErrors.herdError(code, message, details);
}

/**
 * @param {unknown} error
 */
function bareErrorCode(error) {
	return isRecord(error) && typeof error.code === "string" ? error.code.replace(/^:/, "") : "";
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {{ ok: false, error: Error & { code: string, data: Record<string, unknown> } }}
 */
function rejected(code, message, details) {
	return { ok: false, error: scopeError(code, message, details) };
}

/**
 * A value counts as "provided" only when it is neither absent nor empty. The
 * wire schema lists all four fields as optional properties, so models naturally
 * send `""` for fields that do not apply to the chosen kind.
 *
 * @param {unknown} value
 */
function isProvided(value) {
	return value !== undefined && value !== null && value !== "";
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Registry shared by tool-gate and the main entry. The map is attached to the
 * process global so two independent entry modules see the same ledgers.
 *
 * @returns {Map<string, ReturnType<typeof createLedger>>}
 */
function scopeRegistry() {
	const global = /** @type {Record<string, unknown>} */ (globalThis);
	let registry = global[REGISTRY_KEY];
	if (!(registry instanceof Map)) {
		registry = new Map();
		Object.defineProperty(global, REGISTRY_KEY, {
			value: registry,
			configurable: true,
			enumerable: false,
			writable: false,
		});
	}
	return /** @type {Map<string, ReturnType<typeof createLedger>>} */ (registry);
}

/**
 * @param {string | undefined} sessionId
 * @param {string | undefined} agentId
 */
function createLedger(sessionId, agentId) {
	return {
		sessionId: sessionId ?? null,
		agentId: agentId ?? null,
		initialized: false,
		retention: 0,
		current: null,
		archived: [],
		assumptions: [],
		lastTurnId: null,
		pendingSteer: [],
		// Turn settlement state.
		activeTurnId: null,
		beatCount: 0,
		pendingTurns: new Map(),
		settledTurns: [],
		admittedCalls: new Map(),
		assumedCalls: new Map(),
		askedCalls: new Map(),
		syntheticTurnCounter: 0,
		// Projection bookkeeping (Q1 owns the shape; Q0 only hosts it).
		resets: [],
		corrections: [],
		calls: { assume: [], ask: [] },
		view: {
			stableKey: null,
			stableText: "",
			stableSnapshot: "",
			mode: null,
			requests: 0,
			cleanBreaks: 0,
			lastBreakReason: null,
			deltaEntries: 0,
			deltaBytes: 0,
		},
	};
}

/**
 * Get or create the ledger for one `(sessionId, agentId)` pair.
 *
 * @param {string} sessionId
 * @param {string} agentId per-agent identity; two agents must never share a
 *   ledger, or one agent's reset boundary would prune the other's history.
 */
export function ledgerFor(sessionId, agentId) {
	const registry = scopeRegistry();
	const key = `${String(sessionId ?? "")}\u0000${String(agentId ?? "")}`;
	let ledger = registry.get(key);
	if (ledger === undefined) {
		ledger = createLedger(sessionId, agentId);
		registry.set(key, ledger);
	}
	return ledger;
}

/**
 * Validate one annotation without touching ledger state.
 *
 * @param {unknown} annotation
 * @returns {{ ok: true, annotation: Record<string, unknown> } | { ok: false, error: Error }}
 */
function validateAnnotation(annotation) {
	if (!isRecord(annotation)) {
		return rejected("SCOPE_INVALID", "scope must be an object", { field: "scope" });
	}
	const kind = annotation.kind;
	if (typeof kind !== "string" || !KINDS.has(kind)) {
		return rejected("SCOPE_INVALID", "scope.kind must be one of resetScope, keepLast, removeLast, meToo", {
			field: "scope.kind",
			value: kind,
		});
	}
	const allowed = ALLOWED_FIELDS[kind];
	for (const field of Object.keys(annotation)) {
		if (allowed.includes(field)) continue;
		if (!isProvided(annotation[field])) continue;
		return rejected("SCOPE_INVALID", `scope.${field} is not allowed for ${kind}`, {
			field,
			kind,
			allowed,
			next: `remove scope.${field}; ${kind} accepts: ${allowed.join(", ")}`,
		});
	}
	if (kind === KIND_RESET) {
		if (!isNonEmptyString(annotation.new_scope_goal)) {
			return rejected("SCOPE_INVALID", "resetScope requires a non-empty new_scope_goal", {
				kind: KIND_RESET,
				field: "new_scope_goal",
				required: RESET_REQUIRED_FIELDS,
				next: RESET_NEXT,
			});
		}
		const budget = annotation.new_scope_retention_budget;
		if (budget === 0) {
			return rejected("SCOPE_BUDGET_SPENT", "resetScope budget must be a positive integer", {
				kind: KIND_RESET,
				field: "new_scope_retention_budget",
				value: budget,
				required: RESET_REQUIRED_FIELDS,
				next: RESET_NEXT,
			});
		}
		if (typeof budget !== "number" || !Number.isInteger(budget) || budget < 0) {
			return rejected("SCOPE_INVALID", "resetScope requires a positive integer new_scope_retention_budget", {
				kind: KIND_RESET,
				field: "new_scope_retention_budget",
				value: budget,
				required: RESET_REQUIRED_FIELDS,
				next: RESET_NEXT,
			});
		}
	}
	if (kind === KIND_REMOVE && !isNonEmptyString(annotation.replacement)) {
		return rejected("SCOPE_INVALID", "removeLast requires a non-empty replacement", {
			kind: KIND_REMOVE,
			field: "replacement",
			required: ["replacement"],
			next: "resend with scope={kind:'removeLast', replacement:'<non-empty lesson>'}",
		});
	}
	return { ok: true, annotation: { ...annotation } };
}

/**
 * @param {ReturnType<typeof createLedger>} ledger
 * @returns {string}
 */
function nextSyntheticTurn(ledger) {
	ledger.syntheticTurnCounter += 1;
	return `__scope_turn_${ledger.syntheticTurnCounter}`;
}

/**
 * @param {ReturnType<typeof createLedger>} ledger
 * @param {string} turnId
 */
function pendingTurn(ledger, turnId) {
	let turn = ledger.pendingTurns.get(turnId);
	if (turn === undefined) {
		turn = { annotations: [], scopeIndex: ledger.current?.index ?? null };
		ledger.pendingTurns.set(turnId, turn);
	}
	return turn;
}

/**
 * @param {ReturnType<typeof createLedger>} ledger
 * @param {string} turnId
 * @param {Record<string, unknown>} annotation
 * @param {{ tool?: string, callId?: string | null, forceSpend?: boolean }} extra
 */
function stage(ledger, turnId, annotation, extra = {}) {
	const turn = pendingTurn(ledger, turnId);
	turn.annotations.push({
		...annotation,
		tool: extra.tool ?? null,
		callId: extra.callId ?? null,
		scopeIndex: ledger.current?.index ?? turn.scopeIndex ?? null,
		forceSpend: extra.forceSpend === true,
	});
}

/**
 * Archive the current scope and open a new one.
 *
 * @param {ReturnType<typeof createLedger>} ledger
 * @param {Record<string, unknown>} annotation
 * @param {{ callId?: string | null, turnId: string }} options
 */
function openScope(ledger, annotation, options) {
	const previous = ledger.current;
	if (previous !== null) {
		ledger.archived.push({
			index: previous.index,
			goal: previous.goal,
			budget: previous.budget,
			retention: ledger.retention,
			spent: previous.spent,
			openedAtTurnId: previous.openedAtTurnId,
			closedAtTurnId: options.turnId,
			boundaryCallId: previous.boundaryCallId,
			queried: previous.previousQueried === true,
		});
	}
	const index = ledger.resets.length;
	const record = {
		index,
		callId: options.callId ?? null,
		turnId: options.turnId,
		goal: annotation.new_scope_goal,
		budget: annotation.new_scope_retention_budget,
		settled: false,
	};
	ledger.resets.push(record);
	ledger.current = {
		index,
		goal: annotation.new_scope_goal,
		budget: annotation.new_scope_retention_budget,
		spent: 0,
		openedAtTurnId: options.turnId,
		boundaryCallId: record.callId,
		previousQueried: false,
	};
	ledger.initialized = true;
	ledger.retention = annotation.new_scope_retention_budget;
	return record;
}

/**
 * Charge one retention point to the scope that owned the turn. If that scope
 * has already been archived, charge the archive instead of the live budget.
 *
 * @param {ReturnType<typeof createLedger>} ledger
 * @param {number | null} scopeIndex
 */
function charge(ledger, scopeIndex) {
	if (ledger.current !== null && ledger.current.index === scopeIndex) {
		ledger.current.spent += 1;
		ledger.retention = Math.max(0, ledger.retention - 1);
		return ledger.current;
	}
	const archived = ledger.archived.find((entry) => entry.index === scopeIndex);
	if (archived !== undefined) {
		archived.spent += 1;
		archived.retention = Math.max(0, archived.retention - 1);
		return archived;
	}
	return null;
}

/**
 * Settle one model turn. Settlement is idempotent: replaying a settled turn
 * returns `alreadySettled` and spends nothing.
 *
 * @param {ReturnType<typeof createLedger>} ledger
 * @param {{ turnId?: string, annotations?: unknown[] }} [input]
 */
export function settle(ledger, input = {}) {
	input = isRecord(input) ? input : {};
	if (!isRecord(ledger)) {
		return rejected("INVALID_ARGUMENT", "ledger is missing");
	}
	const turnId = input.turnId ?? ledger.activeTurnId;
	if (turnId === undefined || turnId === null) {
		return rejected("INVALID_ARGUMENT", "settle requires a turnId or an active turn");
	}
	if (ledger.settledTurns.includes(turnId)) {
		return {
			ok: true,
			alreadySettled: true,
			deducted: 0,
			retention: ledger.retention,
			turnId,
		};
	}
	const turn = ledger.pendingTurns.get(turnId) ?? { annotations: [], scopeIndex: null };
	if (Array.isArray(input.annotations)) {
		for (const item of input.annotations) {
			const annotation = isRecord(item) && "annotation" in item ? item.annotation : item;
			if (!isRecord(annotation)) continue;
			if (typeof annotation.kind !== "string" || !KINDS.has(annotation.kind)) {
				return rejected("SCOPE_INVALID", "cannot settle an unknown Scope kind", {
					kind: annotation.kind,
					turnId,
				});
			}
			turn.annotations.push({
				...annotation,
				scopeIndex: turn.scopeIndex ?? ledger.current?.index ?? null,
				forceSpend: item?.forceSpend === true,
			});
		}
	}
	if (turn.annotations.length === 0) {
		if (turnId === ledger.activeTurnId) {
			// An exempt-only turn carries no Scope annotation. Settling it is a
			// no-op, not a failure; otherwise agent_end would report an error after
			// a legitimate ask_previous_scope/assume call.
			ledger.activeTurnId = null;
			return {
				ok: true,
				alreadySettled: false,
				noAnnotations: true,
				turnId,
				deducted: 0,
				retention: ledger.retention,
				spent: ledger.current?.spent ?? 0,
				budget: ledger.current?.budget ?? 0,
			};
		}
		return rejected("INVALID_ARGUMENT", "no Scope annotations were admitted for this turn", {
			turnId,
		});
	}

	const kinds = new Set(turn.annotations.map((entry) => entry.kind));
	const forceSpend = turn.annotations.some((entry) => entry.forceSpend === true);
	const spend = turn.annotations.find(
		(entry) => entry.kind === KIND_KEEP || entry.kind === KIND_METOO || entry.forceSpend === true,
	);
	const deduct =
		forceSpend ||
		(!kinds.has(KIND_RESET) && !kinds.has(KIND_REMOVE) && (kinds.has(KIND_KEEP) || kinds.has(KIND_METOO)));
	let effectiveKind = KIND_KEEP;
	if (forceSpend) effectiveKind = "assume";
	else if (kinds.has(KIND_RESET)) effectiveKind = KIND_RESET;
	else if (kinds.has(KIND_REMOVE)) effectiveKind = KIND_REMOVE;
	else if (!kinds.has(KIND_KEEP) && kinds.has(KIND_METOO)) effectiveKind = KIND_METOO;

	let charged = null;
	if (deduct) {
		let spendScope = spend?.scopeIndex ?? turn.scopeIndex ?? ledger.current?.index ?? null;
		if (forceSpend && kinds.has(KIND_RESET)) {
			const resetIndex = turn.annotations.find((entry) => entry.kind === KIND_RESET)?.scopeIndex;
			if (resetIndex !== undefined) spendScope = resetIndex;
		}
		charged = charge(ledger, spendScope);
	}
	if (kinds.has(KIND_RESET)) {
		for (const entry of turn.annotations) {
			if (entry.kind !== KIND_RESET) continue;
			const record = ledger.resets.find((candidate) => candidate.index === entry.scopeIndex);
			if (record !== undefined) record.settled = true;
		}
	}

	ledger.pendingTurns.delete(turnId);
	ledger.settledTurns.push(turnId);
	if (ledger.settledTurns.length > SETTLED_TURN_LIMIT) ledger.settledTurns.shift();
	ledger.beatCount += 1;
	if (ledger.activeTurnId === turnId) ledger.activeTurnId = null;

	return {
		ok: true,
		alreadySettled: false,
		turnId,
		effectiveKind,
		deducted: deduct ? 1 : 0,
		retention: ledger.retention,
		spent: charged?.spent ?? ledger.current?.spent ?? 0,
		budget: charged?.budget ?? ledger.current?.budget ?? 0,
	};
}

/**
 * Lazily settle the previous turn before a new turn starts. The new turn is
 * activated only after admission succeeds, so a rejected call leaves the
 * active-turn marker untouched.
 *
 * @param {ReturnType<typeof createLedger>} ledger
 * @param {string} turnId
 */
function settlePreviousTurn(ledger, turnId) {
	if (ledger.activeTurnId !== null && ledger.activeTurnId !== turnId) {
		const previous = ledger.activeTurnId;
		const result = settle(ledger, { turnId: previous });
		if (!result.ok && bareErrorCode(result.error) !== "INVALID_ARGUMENT") {
			return result;
		}
		if (result.ok) ledger.lastTurnId = previous;
	}
	return { ok: true };
}

/**
 * @param {ReturnType<typeof createLedger>} ledger
 * @param {string} turnId
 */
function hasPreviousBeat(ledger, turnId) {
	if (ledger.beatCount > 0) return true;
	if (ledger.activeTurnId === null || ledger.activeTurnId === turnId) return false;
	const pending = ledger.pendingTurns.get(ledger.activeTurnId);
	return (pending?.annotations.length ?? 0) > 0;
}

/**
 * Admit one tool call. A rejection leaves the ledger untouched.
 *
 * @param {ReturnType<typeof createLedger>} ledger
 * @param {unknown} annotation
 * @param {{ tool?: string, turnId?: string, callId?: string | null, hasPreviousBeat?: boolean }} [options]
 *   All calls from one model turn must share the same `turnId`; settlement
 *   happens once for that id.
 *   Pass the host tool-call id as `callId`: the gate strips the annotation
 *   before persistence, so projection can only find a reset boundary or a
 *   removeLast beat by that id.
 *   When the caller can inspect the real message history, pass
 *   `hasPreviousBeat` so removeLast is rejected when there is no previous
 *   assistant/tool beat, not merely no previous turn.
 */
export function admit(ledger, annotation, options = {}) {
	options = isRecord(options) ? options : {};
	if (!isRecord(ledger)) {
		return rejected("INVALID_ARGUMENT", "ledger is missing");
	}
	const tool = options.tool ?? "";
	let turnId = options.turnId ?? nextSyntheticTurn(ledger);
	if (ledger.settledTurns.includes(turnId)) {
		// A late call must not silently lose its spend by joining an already
		// settled turn. Give it a fresh turn; the next admit/agent_end closes it.
		turnId = nextSyntheticTurn(ledger);
	}
	const callId = options.callId ?? null;

	if (callId !== null && ledger.admittedCalls.has(callId)) {
		const prior = ledger.admittedCalls.get(callId);
		return {
			ok: true,
			replay: true,
			exempt: prior.exempt,
			kind: prior.kind,
			tool,
			turnId: prior.turnId,
			retention: ledger.retention,
			initialized: ledger.initialized,
		};
	}

	if (EXEMPT_TOOLS.has(tool)) {
		const switched = settlePreviousTurn(ledger, turnId);
		if (!switched.ok) return switched;
		ledger.activeTurnId = turnId;
		ledger.lastTurnId = turnId;
		if (callId !== null) ledger.admittedCalls.set(callId, { kind: null, turnId, exempt: true });
		return {
			ok: true,
			exempt: true,
			kind: null,
			tool,
			turnId,
			retention: ledger.retention,
			initialized: ledger.initialized,
		};
	}

	const validated = validateAnnotation(annotation);
	if (!validated.ok) return validated;
	const value = validated.annotation;

	const switched = settlePreviousTurn(ledger, turnId);
	if (!switched.ok) return switched;

	if (!ledger.initialized && value.kind !== KIND_RESET) {
		return rejected("SCOPE_UNINITIALIZED", "the first non-exempt call must use resetScope", {
			kind: value.kind,
			tool,
			required: RESET_REQUIRED_FIELDS,
			next: RESET_NEXT,
		});
	}
	if (ledger.initialized && value.kind !== KIND_RESET && ledger.retention === 0) {
		return rejected("SCOPE_BUDGET_SPENT", "retention is 0; only resetScope and exempt tools are admitted", {
			kind: value.kind,
			tool,
			retention: 0,
		});
	}
	const previousBeat = options.hasPreviousBeat ?? hasPreviousBeat(ledger, turnId);
	if (value.kind === KIND_REMOVE && previousBeat !== true) {
		return rejected("INVALID_ARGUMENT", "removeLast has no previous beat to replace", {
			kind: value.kind,
			tool,
		});
	}

	ledger.activeTurnId = turnId;
	ledger.lastTurnId = turnId;
	if (callId !== null) {
		ledger.admittedCalls.set(callId, { kind: value.kind, turnId, exempt: false });
		if (ledger.admittedCalls.size > ADMITTED_CALL_LIMIT) {
			ledger.admittedCalls.delete(ledger.admittedCalls.keys().next().value);
		}
	}

	let notice;
	let record;
	if (value.kind === KIND_RESET) {
		const shouldWarn = ledger.resets.length >= 1 && ledger.current !== null && ledger.current.previousQueried === false;
		record = openScope(ledger, value, { callId, turnId });
		if (shouldWarn) {
			notice = {
				code: "SCOPE_PREVIOUS_NOT_QUERIED",
				message: "resetScope closed a previous scope that was never queried via ask_previous_scope",
			};
		}
	}
	stage(ledger, turnId, value, { tool, callId });
	if (value.kind === KIND_REMOVE) {
		ledger.corrections.push({
			callId,
			turnId,
			replacement: value.replacement,
			scopeIndex: ledger.current?.index ?? null,
		});
	}
	if (value.kind === KIND_RESET) {
		const scoped = pendingTurn(ledger, turnId);
		const resetEntry = scoped.annotations.at(-1);
		if (resetEntry !== undefined) resetEntry.scopeIndex = record.index;
	}

	const turnAnnotations = ledger.pendingTurns.get(turnId)?.annotations ?? [];
	const turnKinds = new Set(turnAnnotations.map((entry) => entry.kind));
	const turnForceSpend = turnAnnotations.some((entry) => entry.forceSpend === true);
	const upcomingSpend =
		turnForceSpend ||
		(!turnKinds.has(KIND_RESET) &&
			!turnKinds.has(KIND_REMOVE) &&
			(turnKinds.has(KIND_KEEP) || turnKinds.has(KIND_METOO)));
	return {
		ok: true,
		exempt: false,
		kind: value.kind,
		tool,
		turnId,
		initialized: true,
		retention: ledger.retention,
		retentionAfterSettlement: Math.max(0, ledger.retention - (upcomingSpend ? 1 : 0)),
		scope: ledger.current === null ? null : { goal: ledger.current.goal, budget: ledger.current.budget },
		notice,
	};
}

/**
 * Read-only query against the immediately previous archived scope. The receipt
 * is synchronous; the answer arrives later as a `steer` message.
 *
 * @param {ReturnType<typeof createLedger>} ledger
 * @param {{
 *   questions?: string,
 *   callId?: string | null,
 *   turnId?: string,
 *   deliver?: (steer: Record<string, unknown>) => unknown,
 * }} [options]
 *   `deliver` is the optional steer port. It runs in a microtask after the
 *   synchronous receipt; without it the answer stays in `ledger.pendingSteer`
 *   for the assembly layer to drain.
 */
export function askPreviousScope(ledger, options = {}) {
	options = isRecord(options) ? options : {};
	if (!isRecord(ledger)) {
		return rejected("INVALID_ARGUMENT", "ledger is missing");
	}
	if (options.callId !== undefined && options.callId !== null && ledger.askedCalls.has(options.callId)) {
		return {
			...ledger.askedCalls.get(options.callId),
			replay: true,
			retention: ledger.retention,
		};
	}
	// Prefer an archived scope that has not been queried yet (recovery after a
	// reset that arrived before the model asked). Otherwise target the current
	// scope: it is the one that will become the previous scope at the next reset,
	// so querying it is the required ask-before-reset order.
	const archived = ledger.archived.at(-1);
	const target = archived !== undefined && archived.queried !== true ? archived : ledger.current;
	if (target === undefined || target === null) {
		const receipt = {
			ok: true,
			accepted: false,
			reason: "NO_PREVIOUS_SCOPE",
			retention: ledger.retention,
		};
		if (options.callId !== undefined && options.callId !== null) {
			ledger.askedCalls.set(options.callId, {
				ok: true,
				accepted: false,
				reason: "NO_PREVIOUS_SCOPE",
			});
		}
		return receipt;
	}
	const targetKind = target === ledger.current ? "current" : "archived";
	if (targetKind === "current") {
		ledger.current.previousQueried = true;
	} else {
		target.queried = true;
	}
	const questions = typeof options.questions === "string" ? options.questions : "";
	ledger.calls.ask.push({
		callId: options.callId ?? null,
		turnId: options.turnId ?? ledger.lastTurnId,
		archivedIndex: target.index,
		targetKind,
	});
	const answer = {
		target: {
			kind: targetKind,
			index: target.index,
			goal: target.goal,
			budget: target.budget,
			retention: target.retention ?? ledger.retention,
			spent: target.spent ?? 0,
		},
		questions,
		assumptions: ledger.assumptions
			.filter((entry) => entry.scopeIndex === target.index || entry.scopeIndex === null)
			.map((entry) => entry.lemma),
	};
	let answerEdn;
	if (typeof utilErrors.printEdn === "function") {
		try {
			answerEdn = utilErrors.printEdn(answer);
		} catch {
			// The structured answer remains available for the steer port.
		}
	}
	const steer = {
		kind: "previous-scope-answer",
		attribution: "agent",
		delivered: false,
		archivedIndex: target.index,
		targetKind,
		goal: target.goal,
		questions,
		requestedAtTurnId: options.turnId ?? ledger.lastTurnId,
		answer,
		...(typeof answerEdn === "string" ? { answer_edn: answerEdn } : {}),
	};
	ledger.pendingSteer.push(steer);
	if (typeof options.deliver === "function") {
		queueMicrotask(() => {
			try {
				const result = options.deliver(steer);
				if (result !== null && typeof result === "object" && typeof result.then === "function") {
					result.then(
						() => {
							steer.delivered = true;
						},
						() => {},
					);
				} else {
					steer.delivered = true;
				}
			} catch {
				// The answer stays pending; the assembly layer can retry.
			}
		});
	}
	const receipt = {
		ok: true,
		accepted: true,
		retention: ledger.retention,
		target: {
			kind: targetKind,
			goal: target.goal,
			budget: target.budget,
			spent: target.spent,
			closedAtTurnId: target.closedAtTurnId,
		},
		questions,
		note: "accepted; the answer will arrive as a steer message",
	};
	if (options.callId !== undefined && options.callId !== null) {
		ledger.askedCalls.set(options.callId, {
			ok: true,
			accepted: true,
			target: receipt.target,
			questions,
			note: receipt.note,
		});
	}
	return receipt;
}

/**
 * Pin one abstraction across resets. The lemma itself is not echoed back.
 *
 * `assume` is exempt from the spent-budget rejection, but the turn that carries
 * it still spends one retention point. If several calls share that turn, the
 * turn settles once.
 *
 * @param {ReturnType<typeof createLedger>} ledger
 * @param {string} lemma
 * @param {{ callId?: string | null, turnId?: string }} [options]
 */
export function assume(ledger, lemma, options = {}) {
	options = isRecord(options) ? options : {};
	if (!isRecord(ledger)) {
		return rejected("INVALID_ARGUMENT", "ledger is missing");
	}
	if (!isNonEmptyString(lemma)) {
		return rejected("INVALID_ARGUMENT", "assume requires a non-empty lemma", { field: "lemma" });
	}
	if (options.callId !== undefined && options.callId !== null && ledger.assumedCalls.has(options.callId)) {
		return {
			ok: true,
			replay: true,
			pinned: false,
			duplicate: true,
			receipt: ASSUME_RECEIPT,
			retention: ledger.retention,
		};
	}
	if (options.turnId !== undefined && ledger.activeTurnId !== null && ledger.activeTurnId !== options.turnId) {
		const settled = settlePreviousTurn(ledger, options.turnId);
		if (!settled.ok && bareErrorCode(settled.error) !== "INVALID_ARGUMENT") return settled;
	}
	const duplicate = ledger.assumptions.some((entry) => entry.lemma === lemma);
	if (!duplicate) {
		ledger.assumptions.push({
			lemma,
			callId: options.callId ?? null,
			turnId: options.turnId ?? ledger.lastTurnId,
			scopeIndex: ledger.current?.index ?? null,
		});
	}
	ledger.calls.assume.push({ callId: options.callId ?? null, turnId: options.turnId ?? ledger.lastTurnId });
	if (options.callId !== undefined && options.callId !== null) {
		ledger.assumedCalls.set(options.callId, { lemma, turnId: options.turnId ?? ledger.lastTurnId });
	}

	let turnId = options.turnId ?? ledger.activeTurnId ?? null;
	let autoSettle = options.turnId === undefined;
	if (turnId !== null && ledger.settledTurns.includes(turnId)) {
		// A late assume must not fold into a turn that already settled; give it a
		// fresh beat so its one-point spend still happens.
		turnId = null;
		autoSettle = true;
	}
	let settledHere = false;
	if (turnId === null) {
		turnId = nextSyntheticTurn(ledger);
		ledger.activeTurnId = turnId;
		ledger.lastTurnId = turnId;
	} else if (ledger.activeTurnId === null) {
		// The caller named the live turn. Make it active so the next admit or
		// settle closes the assume spend exactly once.
		ledger.activeTurnId = turnId;
		ledger.lastTurnId = turnId;
	}
	stage(ledger, turnId, { kind: KIND_KEEP }, { tool: "assume", callId: options.callId ?? null, forceSpend: true });
	if (autoSettle && ledger.settledTurns.includes(turnId) === false) {
		// A standalone assume has no later tool call to carry its turn. Settle it
		// now so the spend is visible immediately; within a live turn the caller's
		// settle (or the next admit) closes it once.
		const pending = ledger.pendingTurns.get(turnId);
		if (pending !== undefined && pending.annotations.length === 1) {
			const result = settle(ledger, { turnId });
			settledHere = result.ok;
		}
	}
	return {
		ok: true,
		pinned: !duplicate,
		duplicate,
		turnId,
		settled: settledHere,
		retention: ledger.retention,
		spent: ledger.current?.spent ?? 0,
		budget: ledger.current?.budget ?? 0,
		receipt: ASSUME_RECEIPT,
	};
}
