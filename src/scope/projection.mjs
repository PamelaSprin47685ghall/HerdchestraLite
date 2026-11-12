/**
 * Q1: outbound Scope projection.
 *
 * The host owns `.jsonl` history; this module only builds a replacement array
 * for the request that is about to be sent. It never writes, deletes, or
 * reorders a persisted entry.
 *
 * Three transformations happen here:
 *  - pruning: keep the latest reset boundary and everything after it verbatim;
 *    before the boundary keep only human messages, reset/assume/ask calls and
 *    their receipts, assistant conclusions, and the current stage briefing;
 *  - removeLast: replace the previous beat with one assistant lesson message;
 *  - the two-block anchor: a byte-stable stable block plus a small delta block
 *    and a transient runtime block. A self-write, a stable-block change, or a
 *    delta over 32 entries / 4 KiB forces a clean break and a fresh snapshot.
 *
 * `relocateCacheBreakpoints` moves Anthropic/Bedrock explicit cache markers off
 * those transient tail blocks and onto the last real history block without
 * adding markers or changing their TTL.
 */

import { createHash } from "node:crypto";
import * as utilErrors from "../util/errors.mjs";

const KIND_RESET = "resetScope";
const KIND_REMOVE = "removeLast";
const PRESERVED_TOOL_NAMES = new Set(["assume", "ask_previous_scope", "askPreviousScope", "ask-previous-scope"]);
const DELTA_ENTRY_LIMIT = 32;
const DELTA_BYTE_LIMIT = 4096;
const TRANSIENT = new WeakSet();
const TRANSIENT_KEY = Symbol.for("herd.scope.transient");
const TAIL_MARKERS = ["[HERD STABLE]", "[HERD BOARD DELTA]", "[HERD RUNTIME]"];

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Branch entries wrap messages as `{type: "message", message}`; the context
 * hook usually hands over bare messages. Support both without caring which.
 *
 * @param {any} entry
 */
function innerMessage(entry) {
	return isRecord(entry) && entry.type === "message" && isRecord(entry.message) ? entry.message : entry;
}

/**
 * @param {any} entry
 * @param {any} message
 */
function withMessage(entry, message) {
	return isRecord(entry) && entry.type === "message" && isRecord(entry.message) ? { ...entry, message } : message;
}

/**
 * @param {any} message
 * @returns {any[]}
 */
function contentBlocks(message) {
	if (!isRecord(message)) return [];
	if (Array.isArray(message.content)) return message.content;
	if (typeof message.content === "string") return [{ type: "text", text: message.content }];
	return [];
}

/**
 * @param {any} block
 */
function isTextBlock(block) {
	return isRecord(block) && (block.type === "text" || block.type === "input_text" || block.type === "output_text");
}

/**
 * @param {any} block
 */
function isToolCallBlock(block) {
	return isRecord(block) && (block.type === "toolCall" || block.type === "tool_use" || block.type === "tool_call");
}

/**
 * @param {any} block
 */
function toolCallId(block) {
	return block?.id ?? block?.toolCallId ?? block?.tool_call_id ?? null;
}

/**
 * @param {any} block
 */
function toolCallName(block) {
	return block?.name ?? block?.toolName ?? block?.function?.name ?? null;
}

/**
 * @param {any} block
 */
function toolCallArguments(block) {
	if (!isRecord(block)) return undefined;
	if (isRecord(block.arguments)) return block.arguments;
	if (isRecord(block.input)) return block.input;
	const raw = block.arguments;
	if (typeof raw === "string" && raw.length > 0) {
		try {
			const parsed = JSON.parse(raw);
			return isRecord(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * @param {any} message
 */
function openAiToolCalls(message) {
	if (!isRecord(message) || !Array.isArray(message.tool_calls)) return [];
	return message.tool_calls;
}

/**
 * @param {any} message
 * @returns {any[]}
 */
function allToolCalls(message) {
	const calls = contentBlocks(message).filter(isToolCallBlock);
	for (const call of openAiToolCalls(message)) {
		calls.push({
			type: "toolCall",
			id: call?.id ?? null,
			name: call?.function?.name ?? null,
			arguments: call?.function?.arguments ?? undefined,
		});
	}
	return calls;
}

/**
 * @param {any} block
 */
function blockText(block) {
	if (typeof block === "string") return block;
	if (!isRecord(block)) return "";
	if (typeof block.text === "string") return block.text;
	if (typeof block.content === "string") return block.content;
	if (Array.isArray(block.content)) return block.content.map(blockText).join("\n");
	return "";
}

/**
 * Visible text of a message, excluding thinking blocks. Used only to locate the
 * current briefing; the briefing must survive even before the reset boundary.
 *
 * @param {any} message
 */
function messageText(message) {
	if (!isRecord(message)) return "";
	if (typeof message.content === "string") return message.content;
	return contentBlocks(message)
		.filter((block) => !isRecord(block) || (block.type !== "thinking" && block.type !== "reasoning"))
		.map(blockText)
		.join("\n");
}

/**
 * @param {any} block
 */
function isToolResultBlock(block) {
	return isRecord(block) && (block.type === "tool_result" || block.type === "tool_result_block");
}

/**
 * @param {any} message
 */
function isToolResultMessage(message) {
	if (!isRecord(message)) return false;
	if (message.role === "toolResult" || message.role === "tool" || message.role === "tool_result") return true;
	if (message.role !== "user" || !Array.isArray(message.content) || message.content.length === 0) return false;
	return message.content.every(isToolResultBlock);
}

/**
 * @param {any} message
 */
function hasToolResultBlocks(message) {
	return isRecord(message) && Array.isArray(message.content) && message.content.some(isToolResultBlock);
}

/**
 * @param {any} message
 */
function toolResultIds(message) {
	if (!isRecord(message)) return [];
	const ids = [];
	const direct = message.toolCallId ?? message.tool_call_id;
	if (direct !== undefined && direct !== null) ids.push(direct);
	for (const block of contentBlocks(message)) {
		if (!isToolResultBlock(block)) continue;
		const id = block.tool_use_id ?? block.tool_call_id ?? block.id;
		if (id !== undefined && id !== null) ids.push(id);
	}
	return ids;
}

/**
 * @param {any} message
 */
function toolResultName(message) {
	if (!isRecord(message)) return null;
	return message.toolName ?? message.tool_name ?? message.name ?? null;
}

/**
 * @param {any} message
 * @param {string} callId
 */
function messageHasCall(message, callId) {
	if (callId === null || callId === undefined) return false;
	if (allToolCalls(message).some((call) => toolCallId(call) === callId)) return true;
	return toolResultIds(message).includes(callId);
}

/**
 * Latest reset call id this ledger knows about.
 *
 * @param {any} ledger
 */
function latestResetCallId(ledger) {
	if (!isRecord(ledger)) return null;
	const resets = Array.isArray(ledger.resets) ? ledger.resets : [];
	for (let index = resets.length - 1; index >= 0; index -= 1) {
		if (resets[index]?.settled === true && resets[index].callId) return resets[index].callId;
	}
	// A reset that executed but whose turn has not settled yet must still bound
	// the outbound view; otherwise one request would leak pre-reset noise.
	for (let index = resets.length - 1; index >= 0; index -= 1) {
		if (resets[index]?.callId) return resets[index].callId;
	}
	return ledger.current?.boundaryCallId ?? null;
}

/**
 * Find the first message of the region that must be kept verbatim. A missing
 * reset call means no pruning: losing the whole history is worse than keeping
 * one stale tool result.
 *
 * @param {any[]} messages
 * @param {any} ledger
 * @returns {number}
 */
function findBoundaryIndex(messages, ledger) {
	const callId = latestResetCallId(ledger);
	if (callId) {
		for (let index = 0; index < messages.length; index += 1) {
			if (messageHasCall(innerMessage(messages[index]), callId)) return index;
		}
	}
	for (let index = 0; index < messages.length; index += 1) {
		for (const call of allToolCalls(innerMessage(messages[index]))) {
			const args = toolCallArguments(call);
			if (args?.scope?.kind === KIND_RESET) return index;
		}
	}
	return -1;
}

/**
 * @param {any} ledger
 * @param {any[]} messages
 * @param {number} boundaryIndex
 */
function collectPreservedCallIds(ledger, messages, boundaryIndex) {
	const ids = new Set();
	if (isRecord(ledger)) {
		for (const reset of Array.isArray(ledger.resets) ? ledger.resets : []) {
			if (reset?.callId) ids.add(reset.callId);
		}
		for (const assumption of Array.isArray(ledger.assumptions) ? ledger.assumptions : []) {
			if (assumption?.callId) ids.add(assumption.callId);
		}
		for (const ask of Array.isArray(ledger.calls?.ask) ? ledger.calls.ask : []) {
			if (ask?.callId) ids.add(ask.callId);
		}
	}
	const limit = boundaryIndex < 0 ? messages.length : boundaryIndex;
	for (let index = 0; index < limit; index += 1) {
		for (const call of allToolCalls(innerMessage(messages[index]))) {
			const name = toolCallName(call);
			const args = toolCallArguments(call);
			if (PRESERVED_TOOL_NAMES.has(name) || args?.scope?.kind === KIND_RESET) {
				const id = toolCallId(call);
				if (id) ids.add(id);
			}
		}
	}
	return ids;
}

/**
 * Keep only the text and the preserved calls of one assistant message. The
 * thinking block and unrelated tool calls are dropped with their results.
 *
 * @param {any} message
 * @param {Set<string>} preservedCallIds
 */
function filterAssistant(message, preservedCallIds) {
	const rawContent = message.content;
	const keptBlocks = [];
	for (const block of contentBlocks(message)) {
		if (isTextBlock(block)) {
			keptBlocks.push(block);
			continue;
		}
		if (isToolCallBlock(block) && preservedCallIds.has(toolCallId(block))) {
			keptBlocks.push(block);
		}
	}
	const keptOpenAi = openAiToolCalls(message).filter((call) => preservedCallIds.has(call?.id ?? null));
	const hasStringContent = typeof rawContent === "string" && rawContent.length > 0;
	if (keptBlocks.length === 0 && keptOpenAi.length === 0 && !hasStringContent) return null;
	if (Array.isArray(rawContent) && keptBlocks.length === 0 && keptOpenAi.length === 0) return null;

	const next = { ...message };
	if (Array.isArray(rawContent)) next.content = keptBlocks;
	if (keptOpenAi.length > 0) next.tool_calls = keptOpenAi;
	else if (message.tool_calls !== undefined) delete next.tool_calls;
	return next;
}

/**
 * @param {any} message
 * @param {Set<string>} preservedCallIds
 * @param {string} briefing
 */
function filterToolResult(message, preservedCallIds, briefing) {
	if (hasToolResultBlocks(message)) {
		const kept = [];
		for (const block of message.content) {
			if (!isToolResultBlock(block)) {
				kept.push(block);
				continue;
			}
			const id = block.tool_use_id ?? block.tool_call_id ?? block.id;
			const carriesBriefing = briefing.length > 0 && blockText(block).includes(briefing);
			if ((id !== undefined && id !== null && preservedCallIds.has(id)) || carriesBriefing) kept.push(block);
		}
		if (kept.length === 0) return null;
		return { ...message, content: kept };
	}
	if (toolResultIds(message).some((id) => preservedCallIds.has(id))) return message;
	const name = toolResultName(message);
	if (name !== null && PRESERVED_TOOL_NAMES.has(name)) return message;
	if (briefing.length > 0 && messageText(message).includes(briefing)) return message;
	return null;
}

/**
 * Replace the previous beat of each removeLast correction with one assistant
 * lesson message. Only the outbound copy is touched.
 *
 * @param {any[]} messages
 * @param {any} ledger
 * @param {string | undefined} currentBriefing
 */
function applyRemoveLast(messages, ledger, currentBriefing) {
	const briefing = typeof currentBriefing === "string" ? currentBriefing : "";
	const corrections = isRecord(ledger) && Array.isArray(ledger.corrections) ? ledger.corrections : [];
	const resetCallIds = new Set(
		(isRecord(ledger) && Array.isArray(ledger.resets) ? ledger.resets : [])
			.map((reset) => reset?.callId)
			.filter((id) => id !== undefined && id !== null),
	);
	let result = messages;
	for (const correction of corrections) {
		if (!isRecord(correction)) continue;
		const replacement = correction.replacement;
		if (typeof replacement !== "string" || replacement.trim().length === 0) continue;
		const index = result.findIndex((entry) => {
			if (correction.callId) return messageHasCall(innerMessage(entry), correction.callId);
			for (const call of allToolCalls(innerMessage(entry))) {
				const args = toolCallArguments(call);
				if (args?.scope?.kind === KIND_REMOVE) return true;
			}
			return false;
		});
		if (index < 0) continue;

		let previous = -1;
		for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
			const message = innerMessage(result[cursor]);
			if (isToolResultMessage(message)) continue;
			if (message?.role === "assistant") {
				previous = cursor;
				break;
			}
			// Do not erase across a human turn or a system message.
			break;
		}
		if (previous < 0) continue;

		let end = previous + 1;
		while (end < result.length && isToolResultMessage(innerMessage(result[end]))) end += 1;
		const boundaryCallId = latestResetCallId(ledger);
		let touchesBoundary = false;
		if (boundaryCallId) {
			for (let cursor = previous; cursor < end; cursor += 1) {
				if (messageHasCall(innerMessage(result[cursor]), boundaryCallId)) touchesBoundary = true;
			}
		}
		let containsBriefing = false;
		let containsPinnedCall = false;
		let containsReset = false;
		if (briefing) {
			for (let cursor = previous; cursor < end; cursor += 1) {
				if (messageText(innerMessage(result[cursor])).includes(briefing)) containsBriefing = true;
			}
		}
		for (let cursor = previous; cursor < end; cursor += 1) {
			const message = innerMessage(result[cursor]);
			for (const call of allToolCalls(message)) {
				if (PRESERVED_TOOL_NAMES.has(toolCallName(call))) containsPinnedCall = true;
				if (toolCallArguments(call)?.scope?.kind === KIND_RESET) containsReset = true;
			}
			const resultName = toolResultName(message);
			if (resultName !== null && PRESERVED_TOOL_NAMES.has(resultName)) containsPinnedCall = true;
			for (const id of resetCallIds) if (messageHasCall(message, id)) containsReset = true;
		}
		if (touchesBoundary || containsBriefing || containsPinnedCall || containsReset) continue;

		const lesson = {
			role: "assistant",
			content: [{ type: "text", text: replacement }],
		};
		const previousEntry = result[previous];
		const lessonEntry =
			isRecord(previousEntry) && previousEntry.type === "message" ? { ...previousEntry, message: lesson } : lesson;
		result = [...result.slice(0, previous), lessonEntry, ...result.slice(end)];
	}
	return result;
}

/**
 * @param {any} ledger
 * @param {string | undefined} currentBriefing
 * @param {any[]} messages
 */
function projectHistory(ledger, currentBriefing, messages) {
	const corrected = applyRemoveLast(messages, ledger, currentBriefing);
	const boundary = findBoundaryIndex(corrected, ledger);
	if (boundary < 0) return corrected;

	const preservedCallIds = collectPreservedCallIds(ledger, corrected, boundary);
	const briefing = typeof currentBriefing === "string" ? currentBriefing : "";
	// A briefing-bearing result must keep its paired call too, or the provider
	// sees an orphan tool_result. The briefing often arrives in exactly such a
	// result.
	for (let index = 0; index < boundary; index += 1) {
		const message = innerMessage(corrected[index]);
		if (!briefing || !messageText(message).includes(briefing)) continue;
		const directId = isRecord(message) ? (message.toolCallId ?? message.tool_call_id) : null;
		if (directId !== undefined && directId !== null) preservedCallIds.add(directId);
		for (const block of contentBlocks(message)) {
			if (!isToolResultBlock(block) || !blockText(block).includes(briefing)) continue;
			const id = block.tool_use_id ?? block.tool_call_id ?? block.id;
			if (id !== undefined && id !== null) preservedCallIds.add(id);
		}
		for (const call of allToolCalls(message)) {
			const id = toolCallId(call);
			if (id) preservedCallIds.add(id);
		}
	}
	const output = [];
	for (let index = 0; index < corrected.length; index += 1) {
		const entry = corrected[index];
		const message = innerMessage(entry);
		if (index >= boundary) {
			output.push(entry);
			continue;
		}
		if (briefing && messageText(message).includes(briefing)) {
			if (message?.role === "assistant") {
				const filtered = filterAssistant(message, preservedCallIds);
				if (filtered !== null) output.push(withMessage(entry, filtered));
			} else if (isToolResultMessage(message) || hasToolResultBlocks(message)) {
				const filtered = filterToolResult(message, preservedCallIds, briefing);
				if (filtered !== null) output.push(withMessage(entry, filtered));
			} else {
				output.push(entry);
			}
			continue;
		}
		if (isToolResultMessage(message) || hasToolResultBlocks(message)) {
			const filtered = filterToolResult(message, preservedCallIds, briefing);
			if (filtered !== null) output.push(withMessage(entry, filtered));
			continue;
		}
		if (message?.role === "user") {
			output.push(entry);
			continue;
		}
		if (message?.role === "assistant") {
			const filtered = filterAssistant(message, preservedCallIds);
			if (filtered !== null) output.push(withMessage(entry, filtered));
		}
	}
	return output;
}

/**
 * @param {unknown} value
 * @param {number} indent
 * @returns {string}
 */
function fallbackEdn(value, indent = 0) {
	if (value === null || value === undefined) return "nil";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "nil";
	if (typeof value === "string") return value.replace(/\s*\n\s*/g, " ");
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		return `[${value.map((item) => fallbackEdn(item, indent)).join(" ")}]`;
	}
	if (isRecord(value)) {
		const entries = Object.entries(value).map(
			([key, item]) => `:${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} ${fallbackEdn(item, indent)}`,
		);
		return `{${entries.join(" ")}}`;
	}
	return String(value);
}

/**
 * Render a value as EDN. The shared printer handles UFSS strings; the local
 * fallback keeps the tail readable before U0 lands.
 *
 * @param {unknown} value
 */
function renderEdn(value) {
	if (typeof utilErrors.printEdn === "function") {
		try {
			return utilErrors.printEdn(value);
		} catch {
			// Fall through to the local renderer.
		}
	}
	return fallbackEdn(value);
}

/**
 * @param {string} text
 */
function utf8Bytes(text) {
	return new TextEncoder().encode(text).length;
}

/**
 * @param {string} text
 */
function fingerprint(text) {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * @param {Array<{ type: "text", text: string }>} blocks
 * @param {string} kind
 */
function transientMessage(blocks, kind) {
	const message = { role: "user", content: blocks };
	Object.defineProperty(message, TRANSIENT_KEY, { value: true, enumerable: false });
	Object.defineProperty(message, "__herdTransientKind", { value: kind, enumerable: false });
	TRANSIENT.add(message);
	return message;
}

/**
 * @param {any} message
 */
function isTransientMessage(message) {
	const inner = innerMessage(message);
	if (!isRecord(inner)) return false;
	if (TRANSIENT.has(inner) || inner[TRANSIENT_KEY] === true || inner.__herdTransient === true) return true;
	const text = messageText(inner);
	return TAIL_MARKERS.some((marker) => text.startsWith(marker));
}

/**
 * @param {string | undefined} text
 */
function cleanHint(text) {
	if (typeof text !== "string" || text.length === 0) return null;
	return text.replace(/\s*\n\s*/g, " ").trim();
}

/**
 * @returns {Record<string, unknown>}
 */
function emptyView() {
	return {
		stableKey: null,
		stableText: "",
		stableSnapshot: "",
		mode: null,
		requests: 0,
		cleanBreaks: 0,
		lastBreakReason: null,
		deltaEntries: 0,
		deltaBytes: 0,
	};
}

/**
 * Build the two-block tail. Returns no messages when the caller supplied no
 * board delta and no elapsed/hint payload.
 *
 * @param {any} ledger
 * @param {any} boardDelta
 */
function buildTail(ledger, boardDelta) {
	if (!isRecord(boardDelta)) return [];
	if (isRecord(ledger) && !isRecord(ledger.view)) {
		ledger.view = emptyView();
	}
	const view = isRecord(ledger?.view) ? ledger.view : emptyView();

	const providedStableText = typeof boardDelta.stableText === "string" ? boardDelta.stableText : undefined;
	const stableText = providedStableText ?? view.stableText ?? "";
	const snapshot = typeof boardDelta.snapshot === "string" ? boardDelta.snapshot : "";
	const stableKey =
		typeof boardDelta.stableKey === "string" && boardDelta.stableKey.length > 0
			? boardDelta.stableKey
			: fingerprint(stableText);
	const rawEvents = Array.isArray(boardDelta.events)
		? boardDelta.events
		: Array.isArray(boardDelta.delta)
			? boardDelta.delta
			: [];
	const deltaBlockText = `[HERD BOARD DELTA]\n${renderEdn(rawEvents)}`;
	const deltaBytes = utf8Bytes(deltaBlockText);
	const snapshotChanged = snapshot.length > 0 && snapshot !== view.stableSnapshot;
	const selfWrote =
		boardDelta.selfWrote === true ||
		(typeof boardDelta.writerId === "string" &&
			boardDelta.writerId.length > 0 &&
			boardDelta.writerId === ledger?.agentId);

	let breakReason = null;
	if (view.stableKey === null) breakReason = "initial";
	else if (selfWrote) breakReason = "self-write";
	else if (boardDelta.cleanBreak === true) breakReason = "requested";
	else if (stableKey !== view.stableKey) breakReason = "stable-change";
	else if (providedStableText !== undefined && providedStableText !== view.stableText) {
		breakReason = "stable-text-change";
	} else if (snapshotChanged && (rawEvents.length === 0 || view.stableSnapshot.length === 0)) {
		// Establish the first full anchor, or replace it when no delta explains
		// the change. With an existing anchor and a delta, the stable block stays
		// fixed and the delta carries the change.
		breakReason = "snapshot-change";
	} else if (rawEvents.length > DELTA_ENTRY_LIMIT || deltaBytes > DELTA_BYTE_LIMIT) {
		breakReason = "delta-overflow";
	}

	const cleanBreak = breakReason !== null;
	if (cleanBreak) {
		view.stableKey = stableKey;
		view.stableText = stableText;
		if (snapshot.length > 0) view.stableSnapshot = snapshot;
		view.mode = "full";
		view.requests += 1;
		view.cleanBreaks += 1;
		view.lastBreakReason = breakReason;
		view.deltaEntries = 0;
		view.deltaBytes = 0;
	} else {
		view.mode = "delta";
		view.requests += 1;
		view.deltaEntries = rawEvents.length;
		view.deltaBytes = deltaBytes;
	}

	const stableParts = [];
	if (view.stableText) stableParts.push(`[HERD STABLE CONTEXT]\n${view.stableText}`);
	if (view.stableSnapshot) stableParts.push(`[HERD BOARD SNAPSHOT]\n${view.stableSnapshot}`);
	const blocks = [];
	if (stableParts.length > 0) {
		blocks.push({ type: "text", text: `[HERD STABLE]\n${stableParts.join("\n\n")}` });
	}
	if (!cleanBreak && rawEvents.length > 0) {
		blocks.push({ type: "text", text: deltaBlockText });
	}

	const runtime = { "board-mode": cleanBreak ? ":full" : ":delta" };
	if (cleanBreak && rawEvents.length > 0 && snapshot.length === 0) {
		runtime["delta-dropped"] = rawEvents.length;
	}
	const retention = Number.isFinite(boardDelta.retention) ? boardDelta.retention : ledger?.retention;
	if (Number.isFinite(retention)) runtime.retention = retention;
	const goal = boardDelta.scopeGoal ?? ledger?.current?.goal;
	if (typeof goal === "string" && goal.length > 0) runtime["scope-goal"] = goal.replace(/\s*\n\s*/g, " ");
	if (Number.isFinite(boardDelta.elapsedMs)) runtime["elapsed-ms"] = Math.max(0, Math.round(boardDelta.elapsedMs));
	if (Array.isArray(boardDelta.pending) && boardDelta.pending.length > 0) {
		runtime.pending = boardDelta.pending;
	}
	const hint = cleanHint(boardDelta.hint) ?? cleanHint(boardDelta.pairHint);
	if (hint !== null) runtime.hint = hint;
	blocks.push({ type: "text", text: `[HERD RUNTIME]\n${renderEdn(runtime)}` });
	return [transientMessage(blocks, "tail")];
}

/**
 * Build the outbound message array for one provider request.
 *
 * `boardDelta` is supplied by the assembly layer:
 *   - `stableText`: stage protocol + frozen-contract summary;
 *   - `snapshot`: full board snapshot text, used on a clean break;
 *   - `stableKey`: changes only when the stable block changes, not for every
 *     board mutation;
 *   - `events` (or `delta`): events from other actors since the last request;
 *   - `selfWrote` (or `writerId === ledger.agentId`): this agent wrote the board
 *     since the last request;
 *   - `elapsedMs`, `retention`, `pending`, `hint`: volatile Pair Hint fields.
 *
 * @param {{
 *   messages: any[],
 *   ledger?: any,
 *   currentBriefing?: string,
 *   boardDelta?: any,
 * }} [input]
 * @returns {any[]} a new array; input messages are never mutated.
 */
export function projectMessages(input = {}) {
	const { messages, ledger, currentBriefing, boardDelta } = isRecord(input) ? input : {};
	const source = Array.isArray(messages) ? messages : [];
	const projected = projectHistory(ledger, currentBriefing, source);
	const tail = buildTail(ledger, boardDelta);
	const wrapped = source.some((entry) => isRecord(entry) && entry.type === "message" && isRecord(entry.message));
	return [...projected, ...(wrapped ? tail.map((message) => ({ type: "message", message })) : tail)];
}

/**
 * @param {any} block
 */
function isCachePoint(block) {
	return isRecord(block) && (block.type === "cachePoint" || isRecord(block.cachePoint));
}

/**
 * @param {any} payload
 */
function messageArrays(payload) {
	const arrays = [];
	if (!isRecord(payload)) return arrays;
	if (Array.isArray(payload.messages)) arrays.push(payload.messages);
	if (Array.isArray(payload.request?.messages)) arrays.push(payload.request.messages);
	if (Array.isArray(payload.body?.messages)) arrays.push(payload.body.messages);
	return arrays;
}

/**
 * @param {any} payload
 */
function systemArrays(payload) {
	const arrays = [];
	if (!isRecord(payload)) return arrays;
	if (Array.isArray(payload.system)) arrays.push(payload.system);
	if (Array.isArray(payload.request?.system)) arrays.push(payload.request.system);
	if (Array.isArray(payload.body?.system)) arrays.push(payload.body.system);
	return arrays;
}

/**
 * @param {any} content
 */
function markableBlocks(content) {
	if (!Array.isArray(content)) return [];
	return content.filter((block) => isRecord(block) && !isCachePoint(block));
}

/**
 * @param {any} blocks
 */
function blockMarkerCount(blocks) {
	let count = 0;
	for (const block of Array.isArray(blocks) ? blocks : []) {
		if (isRecord(block)?.cache_control !== undefined) count += 1;
		if (isCachePoint(block)) count += 1;
	}
	return count;
}

/**
 * @param {any} message
 */
function allCacheControlCount(message) {
	if (!isRecord(message)) return 0;
	return (isRecord(message.cache_control) ? 1 : 0) + blockMarkerCount(message.content);
}

/**
 * Move explicit cache markers off transient tail messages and onto the last
 * real history block. Markers are cloned so a TTL or provider-specific field
 * survives the move. No marker is added when the source cannot be detached or
 * no persistent block exists.
 *
 * @param {any} payload
 * @returns {any} the same payload, so a provider hook can return it directly.
 *   The relocation report is attached as non-enumerable `__herdCacheRelocation`.
 */
export function relocateCacheBreakpoints(payload) {
	const events = [];
	const report = (changed = false, moved = 0, kept = 0, before = 0, after = 0) => {
		const value = {
			changed,
			moved,
			kept,
			breakpointsBefore: before,
			breakpointsAfter: after,
			events,
		};
		if (isRecord(payload)) {
			try {
				Object.defineProperty(payload, "__herdCacheRelocation", {
					value,
					configurable: true,
					enumerable: false,
				});
			} catch {
				// A frozen payload is still returned unchanged apart from any
				// marker moves already performed.
			}
		}
		return payload;
	};
	if (!isRecord(payload)) {
		return payload;
	}
	const arrays = messageArrays(payload);
	const main = arrays.find((array) => array.length > 0) ?? null;
	if (main === null) {
		return report();
	}

	const transient = main.filter(isTransientMessage);
	const persistent = main.filter((message) => !isTransientMessage(message));
	if (transient.length === 0) {
		return report();
	}

	const beforeMarkers =
		main.reduce((total, message) => total + allCacheControlCount(innerMessage(message)), 0) +
		systemArrays(payload).reduce((total, array) => total + blockMarkerCount(array), 0);

	const targets = [];
	for (const message of [...persistent].reverse()) {
		const blocks = markableBlocks(innerMessage(message)?.content);
		for (const block of [...blocks].reverse()) {
			if (block.cache_control === undefined) targets.push({ block });
		}
	}
	for (const array of systemArrays(payload)) {
		for (const block of [...array].reverse()) {
			if (isRecord(block) && !isCachePoint(block) && block.cache_control === undefined) {
				targets.push({ block });
			}
		}
	}

	let moved = 0;
	let kept = 0;
	const takeTarget = () => {
		const target = targets.shift();
		return target?.block ?? null;
	};

	for (const entry of transient) {
		const message = innerMessage(entry);
		if (isRecord(message.cache_control)) {
			const target = takeTarget();
			if (target !== null) {
				target.cache_control = { ...message.cache_control };
				delete message.cache_control;
				moved += 1;
				events.push({ kind: "moved", marker: "cache_control", from: "tail-message", to: "history-block" });
			} else {
				kept += 1;
				events.push({ kind: "kept", marker: "cache_control", reason: "no-persistent-target" });
			}
		}
		const content = Array.isArray(message.content) ? message.content : [];
		for (let index = 0; index < content.length; index += 1) {
			const block = content[index];
			if (!isRecord(block)) continue;
			if (isRecord(block.cache_control)) {
				const target = takeTarget();
				if (target !== null) {
					target.cache_control = { ...block.cache_control };
					block.cache_control = undefined;
					delete block.cache_control;
					moved += 1;
					events.push({ kind: "moved", marker: "cache_control", from: "tail-block", to: "history-block" });
				} else {
					kept += 1;
					events.push({ kind: "kept", marker: "cache_control", reason: "no-persistent-target" });
				}
			}
			if (isCachePoint(block)) {
				// Bedrock keeps the whole cachePoint block. Move a clone to the last
				// persistent content array; never touch the source when no target
				// array exists.
				const targetMessage = [...persistent].reverse().find((candidate) => {
					const inner = innerMessage(candidate);
					return isRecord(inner) && Array.isArray(inner.content);
				});
				const targetContent = targetMessage === undefined ? null : innerMessage(targetMessage).content;
				if (Array.isArray(targetContent)) {
					const last = targetContent.at(-1);
					if (!isCachePoint(last)) {
						targetContent.push({ ...block });
						content.splice(index, 1);
						index -= 1;
						moved += 1;
						events.push({ kind: "moved", marker: "cachePoint", from: "tail-block", to: "history-block" });
					} else {
						kept += 1;
						events.push({ kind: "kept", marker: "cachePoint", reason: "target-already-marked" });
					}
				} else {
					kept += 1;
					events.push({ kind: "kept", marker: "cachePoint", reason: "no-persistent-target" });
				}
			}
		}
	}

	const afterMarkers =
		main.reduce((total, message) => total + allCacheControlCount(innerMessage(message)), 0) +
		systemArrays(payload).reduce((total, array) => total + blockMarkerCount(array), 0);
	if (afterMarkers > beforeMarkers) {
		events.push({ kind: "error", reason: "marker-count-increased" });
	}
	return report(moved > 0, moved, kept, beforeMarkers, afterMarkers);
}
