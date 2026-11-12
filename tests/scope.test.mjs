import { describe, expect, it } from "bun:test";
import { admit, askPreviousScope, assume, ledgerFor, settle } from "../src/scope/ledger.mjs";
import { projectMessages, relocateCacheBreakpoints } from "../src/scope/projection.mjs";

let sequence = 0;

function freshLedger() {
	sequence += 1;
	return ledgerFor(`session-${sequence}`, `agent-${sequence}`);
}

function reset(ledger, { turnId = "t1", callId = "c1", goal = "goal", budget = 3 } = {}) {
	return admit(
		ledger,
		{ kind: "resetScope", new_scope_goal: goal, new_scope_retention_budget: budget },
		{ tool: "write", turnId, callId },
	);
}

function keep(ledger, turnId = "t2") {
	return admit(ledger, { kind: "keepLast" }, { tool: "read", turnId });
}

function meToo(ledger, turnId = "t2") {
	return admit(ledger, { kind: "meToo" }, { tool: "read", turnId });
}

function removeLast(ledger, { turnId = "t2", callId = "c2", replacement = "lesson" } = {}) {
	return admit(ledger, { kind: "removeLast", replacement }, { tool: "write", turnId, callId });
}

function textContent(text) {
	return [{ type: "text", text }];
}

function tail(projected, marker) {
	for (const message of projected) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (typeof block?.text === "string" && block.text.startsWith(marker)) return block;
		}
	}
	return undefined;
}

function isTailMessage(message) {
	return Array.isArray(message.content)
		? message.content.some((block) => typeof block?.text === "string" && block.text.startsWith("[HERD "))
		: false;
}

describe("Scope admission", () => {
	it("rejects the first non-exempt call unless it is resetScope", () => {
		const ledger = freshLedger();
		const result = keep(ledger, "t1");

		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":SCOPE_UNINITIALIZED");
		expect(result.error.data).toMatchObject({
			kind: "keepLast",
			tool: "read",
			required: ["new_scope_goal", "new_scope_retention_budget"],
		});
		expect(result.error.data.next).toContain("resetScope");
		expect(ledger.initialized).toBe(false);
		expect(ledger.retention).toBe(0);
	});

	it("rejects malformed resetScope shapes", () => {
		const ledger = freshLedger();

		expect(admit(ledger, { kind: "resetScope", new_scope_goal: "", new_scope_retention_budget: 2 })).toMatchObject({
			ok: false,
			error: { code: ":SCOPE_INVALID" },
		});
		const missingGoal = admit(ledger, { kind: "resetScope", new_scope_retention_budget: 2 });
		expect(missingGoal.error.data).toMatchObject({
			kind: "resetScope",
			field: "new_scope_goal",
			required: ["new_scope_goal", "new_scope_retention_budget"],
		});
		expect(missingGoal.error.data.next).toContain("resetScope");
		expect(admit(ledger, { kind: "resetScope", new_scope_goal: "g", new_scope_retention_budget: 1.5 })).toMatchObject({
			ok: false,
			error: { code: ":SCOPE_INVALID" },
		});
		expect(admit(ledger, { kind: "resetScope", new_scope_goal: "g", new_scope_retention_budget: 0 })).toMatchObject({
			ok: false,
			error: { code: ":SCOPE_BUDGET_SPENT" },
		});
		expect(ledger.initialized).toBe(false);
	});

	it("accepts a declared replacement alongside a complete resetScope", () => {
		const ledger = freshLedger();
		const result = admit(
			ledger,
			{
				kind: "resetScope",
				new_scope_goal: "goal",
				new_scope_retention_budget: 2,
				replacement: "legacy reset annotation",
			},
			{ tool: "write", turnId: "t1", callId: "c1" },
		);

		expect(result.ok).toBe(true);
		expect(result.kind).toBe("resetScope");
		expect(result.scope).toEqual({ goal: "goal", budget: 2 });
		expect(ledger.initialized).toBe(true);
	});

	it("accepts other declared scope fields on removeLast", () => {
		const ledger = freshLedger();
		reset(ledger, { budget: 2 });
		settle(ledger, { turnId: "t1" });

		const result = admit(
			ledger,
			{
				kind: "removeLast",
				replacement: "lesson",
				new_scope_goal: "not used by removeLast",
				new_scope_retention_budget: 2,
			},
			{ tool: "write", turnId: "t2", callId: "c-remove" },
		);

		expect(result.ok).toBe(true);
		expect(result.kind).toBe("removeLast");
	});

	it("rejects fields that do not belong to the chosen kind", () => {
		const ledger = freshLedger();
		reset(ledger, { budget: 2 });

		expect(
			admit(ledger, { kind: "keepLast", replacement: "not allowed" }, { tool: "read", turnId: "t2" }),
		).toMatchObject({ ok: false, error: { code: ":SCOPE_INVALID" } });
	});
});

describe("turn settlement", () => {
	it("spends one point per keepLast turn and ignores a replay", () => {
		const ledger = freshLedger();
		const opened = reset(ledger, { budget: 3 });
		expect(opened.ok).toBe(true);
		expect(opened.retentionAfterSettlement).toBe(3);

		expect(keep(ledger, "t2").ok).toBe(true);
		const settled = settle(ledger, { turnId: "t2" });
		expect(settled).toMatchObject({ ok: true, deducted: 1, retention: 2 });

		const replay = settle(ledger, { turnId: "t2" });
		expect(replay).toMatchObject({ ok: true, alreadySettled: true, deducted: 0, retention: 2 });
	});

	it("settles an all-meToo turn as keepLast exactly once", () => {
		const ledger = freshLedger();
		reset(ledger, { budget: 2 });

		expect(meToo(ledger, "t2").ok).toBe(true);
		expect(meToo(ledger, "t2").ok).toBe(true);
		expect(settle(ledger, { turnId: "t2" })).toMatchObject({ ok: true, deducted: 1, retention: 1 });
	});

	it("settles a mixed keepLast/meToo turn once", () => {
		const ledger = freshLedger();
		reset(ledger, { budget: 3 });

		keep(ledger, "t2");
		meToo(ledger, "t2");
		expect(settle(ledger, { turnId: "t2" })).toMatchObject({ ok: true, deducted: 1, retention: 2 });
	});

	it("does not spend for removeLast and rejects it without a previous beat", () => {
		const ledger = freshLedger();
		reset(ledger, { budget: 3 });

		// The reset turn is still active, so it is the current beat, not a previous one.
		const noBeat = removeLast(ledger, { turnId: "t1", callId: "c2" });
		expect(noBeat).toMatchObject({ ok: false, error: { code: ":INVALID_ARGUMENT" } });

		settle(ledger, { turnId: "t1" });
		expect(removeLast(ledger, { turnId: "t2", callId: "c2" }).ok).toBe(true);
		expect(settle(ledger, { turnId: "t2" })).toMatchObject({ ok: true, deducted: 0, retention: 3 });
	});

	it("uses the caller's message-level previous-beat check when supplied", () => {
		const ledger = freshLedger();
		reset(ledger, { turnId: "t1", callId: "c1", budget: 2 });
		settle(ledger, { turnId: "t1" });

		expect(
			admit(
				ledger,
				{ kind: "removeLast", replacement: "no beat" },
				{ tool: "write", turnId: "t2", callId: "c2", hasPreviousBeat: false },
			),
		).toMatchObject({ ok: false, error: { code: ":INVALID_ARGUMENT" } });

		expect(
			admit(
				ledger,
				{ kind: "removeLast", replacement: "caller says yes" },
				{ tool: "write", turnId: "t3", callId: "c3", hasPreviousBeat: true },
			).ok,
		).toBe(true);
	});

	it("blocks non-reset calls at retention 0 but still admits reset and exempt tools", () => {
		const ledger = freshLedger();
		reset(ledger, { budget: 1 });
		settle(ledger, { turnId: "t1" });
		keep(ledger, "t2");
		settle(ledger, { turnId: "t2" });
		expect(ledger.retention).toBe(0);

		expect(keep(ledger, "t3")).toMatchObject({ ok: false, error: { code: ":SCOPE_BUDGET_SPENT" } });
		expect(meToo(ledger, "t4")).toMatchObject({ ok: false, error: { code: ":SCOPE_BUDGET_SPENT" } });
		expect(removeLast(ledger, { turnId: "t5" })).toMatchObject({
			ok: false,
			error: { code: ":SCOPE_BUDGET_SPENT" },
		});
		expect(askPreviousScope(ledger).ok).toBe(true);
		expect(assume(ledger, "still allowed").ok).toBe(true);
		expect(reset(ledger, { turnId: "t6", callId: "c6", budget: 2 })).toMatchObject({
			ok: true,
			retention: 2,
		});
	});

	it("returns a replay receipt without spending twice for the same call id", () => {
		const ledger = freshLedger();
		reset(ledger, { budget: 2, callId: "reset-call" });
		settle(ledger, { turnId: "t1" });

		const first = admit(ledger, { kind: "keepLast" }, { tool: "read", turnId: "t2", callId: "same-call" });
		expect(first.ok).toBe(true);
		settle(ledger, { turnId: "t2" });
		expect(ledger.retention).toBe(1);

		const replay = admit(ledger, { kind: "keepLast" }, { tool: "read", turnId: "t3", callId: "same-call" });
		expect(replay).toMatchObject({ ok: true, replay: true, retention: 1 });
		expect(settle(ledger, { turnId: "t3" })).toMatchObject({
			ok: false,
			error: { code: ":INVALID_ARGUMENT" },
		});
		expect(ledger.retention).toBe(1);
	});

	it("treats an exempt-only turn as a no-op settlement", () => {
		const ledger = freshLedger();
		reset(ledger, { budget: 2 });
		settle(ledger, { turnId: "t1" });
		expect(admit(ledger, undefined, { tool: "ask_previous_scope", turnId: "t2" }).ok).toBe(true);
		expect(settle(ledger, { turnId: "t2" })).toMatchObject({
			ok: true,
			noAnnotations: true,
			deducted: 0,
			retention: 2,
		});
		expect(settle(ledger, { turnId: "t2" })).toMatchObject({
			ok: false,
			error: { code: ":INVALID_ARGUMENT" },
		});

		// A later non-exempt call in the same turn must still settle once.
		expect(keep(ledger, "t2").ok).toBe(true);
		expect(settle(ledger, { turnId: "t2" })).toMatchObject({ ok: true, deducted: 1, retention: 1 });
	});

	it("gives a late call a fresh turn after its named turn settled", () => {
		const ledger = freshLedger();
		reset(ledger, { budget: 3 });
		settle(ledger, { turnId: "t1" });
		keep(ledger, "t2");
		settle(ledger, { turnId: "t2" });
		expect(ledger.retention).toBe(2);

		const late = admit(ledger, { kind: "keepLast" }, { tool: "read", turnId: "t2" });
		expect(late.ok).toBe(true);
		expect(late.turnId).not.toBe("t2");
		expect(settle(ledger, { turnId: late.turnId })).toMatchObject({
			ok: true,
			deducted: 1,
			retention: 1,
		});
	});
});

describe("scope archiving and pinned queries", () => {
	it("archives the previous scope and warns on an unqueried second reset", () => {
		const ledger = freshLedger();
		reset(ledger, { turnId: "t1", callId: "c1", goal: "first", budget: 2 });
		settle(ledger, { turnId: "t1" });
		keep(ledger, "t2");
		settle(ledger, { turnId: "t2" });

		const second = reset(ledger, { turnId: "t3", callId: "c3", goal: "second", budget: 5 });
		expect(second.notice?.code).toBe("SCOPE_PREVIOUS_NOT_QUERIED");
		expect(ledger.archived.at(-1)).toMatchObject({ goal: "first", budget: 2, spent: 1 });

		const query = askPreviousScope(ledger, { questions: "what did first learn?" });
		expect(query).toMatchObject({
			ok: true,
			accepted: true,
			target: { kind: "archived", goal: "first", budget: 2, spent: 1 },
		});
		expect(ledger.retention).toBe(5);
		expect(ledger.pendingSteer.at(-1)).toMatchObject({
			kind: "previous-scope-answer",
			goal: "first",
			questions: "what did first learn?",
		});

		const third = reset(ledger, { turnId: "t4", callId: "c4", goal: "third", budget: 4 });
		expect(third.notice?.code).toBe("SCOPE_PREVIOUS_NOT_QUERIED");

		// Recover the missed scope, then query the current scope before resetting.
		expect(askPreviousScope(ledger).target.kind).toBe("archived");
		expect(askPreviousScope(ledger).target.kind).toBe("current");
		const fourth = reset(ledger, { turnId: "t5", callId: "c5", goal: "fourth", budget: 4 });
		expect(fourth.notice).toBeUndefined();
	});

	it("returns a soft receipt when there is no previous scope", () => {
		const ledger = freshLedger();
		expect(askPreviousScope(ledger)).toMatchObject({
			ok: true,
			accepted: false,
			reason: "NO_PREVIOUS_SCOPE",
		});
	});

	it("accepts a query against the current scope before the next reset", () => {
		const ledger = freshLedger();
		reset(ledger, { turnId: "t1", callId: "c1", goal: "current goal", budget: 2 });
		settle(ledger, { turnId: "t1" });

		const query = askPreviousScope(ledger, { questions: "before reset" });
		expect(query).toMatchObject({
			ok: true,
			accepted: true,
			target: { kind: "current", goal: "current goal", budget: 2 },
		});
		expect(ledger.retention).toBe(2);

		const second = reset(ledger, { turnId: "t2", callId: "c2", goal: "next", budget: 3 });
		expect(second.notice).toBeUndefined();
	});

	it("makes ask_previous_scope replay idempotent", () => {
		const ledger = freshLedger();
		reset(ledger, { turnId: "t1", callId: "c1", budget: 2 });
		settle(ledger, { turnId: "t1" });
		const first = askPreviousScope(ledger, { questions: "q", callId: "ask-1" });
		expect(first.accepted).toBe(true);
		expect(ledger.pendingSteer.length).toBe(1);
		expect(ledger.pendingSteer[0]).toMatchObject({
			delivered: false,
			questions: "q",
			answer: { target: { kind: "current", goal: "goal", budget: 2 }, questions: "q" },
		});

		const replay = askPreviousScope(ledger, { questions: "different", callId: "ask-1" });
		expect(replay).toMatchObject({ accepted: true, replay: true });
		expect(ledger.pendingSteer.length).toBe(1);
	});

	it("delivers the previous-scope answer asynchronously and includes pinned assumptions", async () => {
		const ledger = freshLedger();
		reset(ledger, { turnId: "t1", callId: "c1", budget: 3 });
		settle(ledger, { turnId: "t1" });
		assume(ledger, "pinned for the next scope", { callId: "a1" });
		let delivered;
		const query = askPreviousScope(ledger, {
			questions: "what should carry over?",
			deliver: (steer) => {
				delivered = steer;
			},
		});
		expect(query.accepted).toBe(true);
		expect(delivered).toBeUndefined();

		await Promise.resolve();
		expect(delivered).toBe(ledger.pendingSteer.at(-1));
		expect(delivered.delivered).toBe(true);
		expect(delivered.answer.assumptions).toEqual(["pinned for the next scope"]);
		expect(delivered.answer_edn).toContain(":assumptions");
	});

	it("keeps the ask-before-each-reset workflow warning-free", () => {
		const ledger = freshLedger();
		reset(ledger, { turnId: "t1", callId: "c1", goal: "one", budget: 2 });
		settle(ledger, { turnId: "t1" });
		expect(askPreviousScope(ledger).target.kind).toBe("current");

		const second = reset(ledger, { turnId: "t2", callId: "c2", goal: "two", budget: 3 });
		expect(second.notice).toBeUndefined();
		expect(askPreviousScope(ledger).target.kind).toBe("current");

		const third = reset(ledger, { turnId: "t3", callId: "c3", goal: "three", budget: 3 });
		expect(third.notice).toBeUndefined();
	});
});

describe("assume", () => {
	it("pins the lemma across resets and spends its turn once", () => {
		const ledger = freshLedger();
		reset(ledger, { budget: 3 });
		settle(ledger, { turnId: "t1" });

		const first = assume(ledger, "the cache key is stable", { turnId: "t2", callId: "a1" });
		expect(first).toMatchObject({ ok: true, pinned: true, receipt: "已笃定，不再因为没有信息增量的犹豫反复改判。" });
		expect(settle(ledger, { turnId: "t2" })).toMatchObject({ ok: true, deducted: 1, retention: 2 });

		reset(ledger, { turnId: "t3", callId: "c3", budget: 4 });
		expect(ledger.assumptions.map((entry) => entry.lemma)).toEqual(["the cache key is stable"]);
	});

	it("does not double-spend when assume shares a turn with keepLast", () => {
		const ledger = freshLedger();
		reset(ledger, { budget: 3 });
		settle(ledger, { turnId: "t1" });

		keep(ledger, "t2");
		assume(ledger, "shared turn lemma", { turnId: "t2" });
		expect(settle(ledger, { turnId: "t2" })).toMatchObject({ ok: true, deducted: 1, retention: 2 });
	});

	it("settles a previous turn when assume names a new turn", () => {
		const ledger = freshLedger();
		reset(ledger, { budget: 3 });
		settle(ledger, { turnId: "t1" });
		keep(ledger, "t2");
		expect(ledger.retention).toBe(3);

		expect(assume(ledger, "next turn lemma", { turnId: "t3" }).ok).toBe(true);
		expect(ledger.retention).toBe(2);
		expect(settle(ledger, { turnId: "t3" })).toMatchObject({ ok: true, deducted: 1, retention: 1 });
	});

	it("settles an explicitly named assume turn on the next admit", () => {
		const ledger = freshLedger();
		reset(ledger, { budget: 3 });
		settle(ledger, { turnId: "t1" });

		expect(assume(ledger, "explicit turn", { turnId: "t2" })).toMatchObject({ ok: true, settled: false });
		expect(keep(ledger, "t3").ok).toBe(true);
		expect(ledger.retention).toBe(2);
		expect(settle(ledger, { turnId: "t3" })).toMatchObject({ ok: true, deducted: 1, retention: 1 });
	});

	it("spends a late assume even when its named turn already settled", () => {
		const ledger = freshLedger();
		reset(ledger, { budget: 3 });
		settle(ledger, { turnId: "t1" });
		keep(ledger, "t2");
		settle(ledger, { turnId: "t2" });
		expect(ledger.retention).toBe(2);

		const late = assume(ledger, "late lemma", { turnId: "t2" });
		expect(late).toMatchObject({ ok: true, settled: true, retention: 1 });
	});

	it("does not spend twice when the same assume call id is replayed", () => {
		const ledger = freshLedger();
		reset(ledger, { budget: 2 });
		settle(ledger, { turnId: "t1" });
		assume(ledger, "replayed lemma", { turnId: "t2", callId: "assume-call" });
		settle(ledger, { turnId: "t2" });
		expect(ledger.retention).toBe(1);

		const replay = assume(ledger, "replayed lemma", { turnId: "t3", callId: "assume-call" });
		expect(replay).toMatchObject({ ok: true, replay: true, retention: 1 });
	});

	it("settles a standalone assume immediately and clamps at zero", () => {
		const ledger = freshLedger();
		reset(ledger, { budget: 1 });
		settle(ledger, { turnId: "t1" });

		const first = assume(ledger, "one");
		expect(first).toMatchObject({ ok: true, settled: true, retention: 0 });

		const second = assume(ledger, "two");
		expect(second).toMatchObject({ ok: true, settled: true, retention: 0 });
		expect(ledger.current.spent).toBe(2);
	});

	it("spends from the new scope when assume shares a reset turn", () => {
		const ledger = freshLedger();
		reset(ledger, { turnId: "t1", budget: 3 });
		expect(assume(ledger, "reset turn lemma", { turnId: "t1" }).ok).toBe(true);
		expect(settle(ledger, { turnId: "t1" })).toMatchObject({
			ok: true,
			deducted: 1,
			retention: 2,
			spent: 1,
			budget: 3,
		});
	});

	it("rejects an empty lemma without touching the ledger", () => {
		const ledger = freshLedger();
		reset(ledger);
		const before = ledger.retention;
		expect(assume(ledger, "  ")).toMatchObject({ ok: false, error: { code: ":INVALID_ARGUMENT" } });
		expect(ledger.retention).toBe(before);
	});
});

describe("ledger registry", () => {
	it("returns the same ledger for the same session and agent", () => {
		expect(ledgerFor("registry-session", "registry-agent")).toBe(ledgerFor("registry-session", "registry-agent"));
		expect(ledgerFor("registry-session", "other-agent")).not.toBe(ledgerFor("registry-session", "registry-agent"));
	});
});

describe("input guards", () => {
	it("treats null options as empty without throwing", () => {
		const ledger = freshLedger();
		expect(admit(ledger, { kind: "resetScope", new_scope_goal: "guard", new_scope_retention_budget: 2 }, null).ok).toBe(
			true,
		);
		expect(settle(ledger, null)).toMatchObject({ ok: true, deducted: 0 });
		expect(settle(ledger, null)).toMatchObject({ ok: false, error: { code: ":INVALID_ARGUMENT" } });
		expect(askPreviousScope(ledger, null).ok).toBe(true);
		expect(assume(ledger, "null options", null).ok).toBe(true);
		expect(projectMessages()).toEqual([]);
	});
});

describe("projectMessages pruning", () => {
	function fixture() {
		const ledger = freshLedger();
		reset(ledger, { turnId: "t1", callId: "c-reset", budget: 2 });
		settle(ledger, { turnId: "t1" });
		const messages = [
			{ role: "user", content: "human seed" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "old dead end" },
					{ type: "toolCall", id: "c-old", name: "read", arguments: { path: "old" } },
				],
			},
			{ role: "toolResult", toolCallId: "c-old", toolName: "read", content: textContent("huge old output") },
			{ role: "assistant", content: textContent("conclusion A") },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "advance thought" },
					{ type: "toolCall", id: "c-advance", name: "advance_s1", arguments: {} },
				],
			},
			{
				role: "toolResult",
				toolCallId: "c-advance",
				toolName: "advance_s1",
				content: textContent("S1 APPROVED -> S2 BRIEFING"),
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "new thought" },
					{ type: "toolCall", id: "c-reset", name: "write", arguments: { path: "new" } },
				],
			},
			{ role: "toolResult", toolCallId: "c-reset", toolName: "write", content: textContent("applied") },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "after thought" },
					{ type: "toolCall", id: "c-after", name: "read", arguments: { path: "after" } },
				],
			},
			{ role: "toolResult", toolCallId: "c-after", toolName: "read", content: textContent("after output") },
		];
		return { ledger, messages };
	}

	it("keeps the reset boundary and later messages verbatim, pruning earlier noise", () => {
		const { ledger, messages } = fixture();
		const snapshot = JSON.stringify(messages);
		const projected = projectMessages({
			messages,
			ledger,
			currentBriefing: "S1 APPROVED -> S2 BRIEFING",
		});

		expect(JSON.stringify(messages)).toBe(snapshot);
		expect(projected[0]).toMatchObject({ role: "user", content: "human seed" });
		expect(projected.some((message) => message.toolCallId === "c-old")).toBe(false);
		expect(projected.some((message) => message.content?.[0]?.text === "huge old output")).toBe(false);
		expect(projected.some((message) => message.content?.[0]?.text === "conclusion A")).toBe(true);
		expect(projected.some((message) => message.toolCallId === "c-advance")).toBe(true);
		const advanceCall = projected.find((message) =>
			message.content?.some?.((block) => block.type === "toolCall" && block.id === "c-advance"),
		);
		expect(advanceCall).toBeDefined();
		expect(advanceCall.content.some((block) => block.type === "thinking")).toBe(false);
		expect(projected.some((message) => message.toolCallId === "c-reset")).toBe(true);
		expect(projected.some((message) => message.toolCallId === "c-after")).toBe(true);
	});

	it("pins the current briefing but lets an old briefing be pruned", () => {
		const { ledger, messages } = fixture();
		const current = projectMessages({ messages, ledger, currentBriefing: "S1 APPROVED -> S2 BRIEFING" });
		expect(current.some((message) => message.toolCallId === "c-advance")).toBe(true);

		const advanced = projectMessages({ messages, ledger, currentBriefing: "S3 BRIEFING" });
		expect(advanced.some((message) => message.toolCallId === "c-advance")).toBe(false);
	});

	it("keeps the paired call when the briefing appears in an assistant message", () => {
		const ledger = freshLedger();
		reset(ledger, { turnId: "t1", callId: "c-reset", budget: 2 });
		settle(ledger, { turnId: "t1" });
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "drop" },
					{ type: "text", text: "CURRENT BRIEF" },
					{ type: "toolCall", id: "c-brief", name: "read", arguments: {} },
				],
			},
			{ role: "toolResult", toolCallId: "c-brief", toolName: "read", content: textContent("paired") },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c-reset", name: "write", arguments: {} }],
			},
			{ role: "toolResult", toolCallId: "c-reset", toolName: "write", content: textContent("ok") },
		];

		const projected = projectMessages({ messages, ledger, currentBriefing: "CURRENT BRIEF" });
		const briefMessage = projected.find((message) =>
			message.content?.some?.((block) => block.type === "text" && block.text === "CURRENT BRIEF"),
		);
		expect(briefMessage.content.some((block) => block.type === "thinking")).toBe(false);
		expect(briefMessage.content.some((block) => block.id === "c-brief")).toBe(true);
		expect(projected.some((message) => message.toolCallId === "c-brief")).toBe(true);
	});

	it("preserves assume and ask_previous_scope calls and receipts", () => {
		const ledger = freshLedger();
		reset(ledger, { turnId: "t1", callId: "c-reset", budget: 2 });
		settle(ledger, { turnId: "t1" });
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "drop me" },
					{ type: "toolCall", id: "c-assume", name: "assume", arguments: { assumption: "pinned" } },
					{ type: "toolCall", id: "c-ask", name: "ask_previous_scope", arguments: {} },
				],
			},
			{ role: "toolResult", toolCallId: "c-assume", toolName: "assume", content: textContent("已笃定") },
			{ role: "toolResult", toolCallId: "c-ask", toolName: "ask_previous_scope", content: textContent("accepted") },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c-reset", name: "write", arguments: {} }],
			},
			{ role: "toolResult", toolCallId: "c-reset", toolName: "write", content: textContent("ok") },
		];

		const projected = projectMessages({ messages, ledger });
		const kept = projected.filter((message) => message.toolCallId?.startsWith("c-"));
		expect(kept.map((message) => message.toolCallId)).toEqual(["c-assume", "c-ask", "c-reset"]);
		const assistant = projected.find((message) => message.role === "assistant");
		expect(assistant.content.some((block) => block.type === "thinking")).toBe(false);
		expect(assistant.content.filter((block) => block.type === "toolCall").map((block) => block.id)).toEqual([
			"c-assume",
			"c-ask",
		]);
	});

	it("replaces the previous beat for removeLast without touching the source", () => {
		const ledger = freshLedger();
		reset(ledger, { turnId: "t1", callId: "c-reset", budget: 3 });
		settle(ledger, { turnId: "t1" });
		keep(ledger, "t2");
		settle(ledger, { turnId: "t2" });
		expect(
			admit(
				ledger,
				{ kind: "removeLast", replacement: "lesson: read before writing" },
				{ tool: "write", turnId: "t3", callId: "c-remove" },
			).ok,
		).toBe(true);
		settle(ledger, { turnId: "t3" });

		const messages = [
			{ role: "user", content: "start" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "dead end" },
					{ type: "toolCall", id: "c-prev", name: "read", arguments: {} },
				],
			},
			{ role: "toolResult", toolCallId: "c-prev", toolName: "read", content: textContent("old result") },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "current" },
					{ type: "toolCall", id: "c-remove", name: "write", arguments: {} },
				],
			},
			{ role: "toolResult", toolCallId: "c-remove", toolName: "write", content: textContent("written") },
			{ role: "assistant", content: textContent("done") },
		];
		const snapshot = JSON.stringify(messages);
		const projected = projectMessages({ messages, ledger });

		expect(JSON.stringify(messages)).toBe(snapshot);
		expect(projected.some((message) => message.toolCallId === "c-prev")).toBe(false);
		expect(projected.some((message) => message.content?.[0]?.text === "lesson: read before writing")).toBe(true);
		expect(projected.some((message) => message.toolCallId === "c-remove")).toBe(true);
	});

	it("applies a removeLast correction before its turn settles", () => {
		const ledger = freshLedger();
		reset(ledger, { turnId: "t1", callId: "c-reset", budget: 3 });
		settle(ledger, { turnId: "t1" });
		expect(
			admit(ledger, { kind: "removeLast", replacement: "not yet" }, { tool: "write", turnId: "t2", callId: "c-remove" })
				.ok,
		).toBe(true);
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c-prev", name: "read", arguments: {} }],
			},
			{ role: "toolResult", toolCallId: "c-prev", toolName: "read", content: textContent("old") },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c-remove", name: "write", arguments: {} }],
			},
			{ role: "toolResult", toolCallId: "c-remove", toolName: "write", content: textContent("written") },
		];

		const immediately = projectMessages({ messages, ledger });
		expect(immediately.some((message) => message.toolCallId === "c-prev")).toBe(false);
		expect(immediately.some((message) => message.content?.[0]?.text === "not yet")).toBe(true);
		settle(ledger, { turnId: "t2" });
		expect(projectMessages({ messages, ledger }).some((message) => message.toolCallId === "c-prev")).toBe(false);
	});

	it("does not let removeLast erase the pinned current briefing", () => {
		const ledger = freshLedger();
		reset(ledger, { turnId: "t1", callId: "c-reset", budget: 3 });
		settle(ledger, { turnId: "t1" });
		admit(
			ledger,
			{ kind: "removeLast", replacement: "should not erase the briefing" },
			{ tool: "write", turnId: "t2", callId: "c-remove" },
		);
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c-advance", name: "advance_s1", arguments: {} }],
			},
			{
				role: "toolResult",
				toolCallId: "c-advance",
				toolName: "advance_s1",
				content: textContent("CURRENT BRIEF"),
			},
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c-remove", name: "write", arguments: {} }],
			},
			{ role: "toolResult", toolCallId: "c-remove", toolName: "write", content: textContent("written") },
		];

		const projected = projectMessages({ messages, ledger, currentBriefing: "CURRENT BRIEF" });
		expect(projected.some((message) => message.toolCallId === "c-advance")).toBe(true);
		expect(projected.some((message) => message.content?.[0]?.text === "should not erase the briefing")).toBe(false);
		expect(projected.some((message) => message.toolCallId === "c-remove")).toBe(true);
	});

	it("does not let removeLast erase a pinned assume call", () => {
		const ledger = freshLedger();
		reset(ledger, { budget: 3 });
		settle(ledger, { turnId: "t1" });
		admit(
			ledger,
			{ kind: "removeLast", replacement: "must not erase assume" },
			{ tool: "write", turnId: "t2", callId: "c-remove" },
		);
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c-assume", name: "assume", arguments: { assumption: "keep" } }],
			},
			{ role: "toolResult", toolCallId: "c-assume", toolName: "assume", content: textContent("已笃定") },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c-remove", name: "write", arguments: {} }],
			},
			{ role: "toolResult", toolCallId: "c-remove", toolName: "write", content: textContent("written") },
		];

		const projected = projectMessages({ messages, ledger });
		expect(projected.some((message) => message.toolCallId === "c-assume")).toBe(true);
		expect(projected.some((message) => message.content?.[0]?.text === "must not erase assume")).toBe(false);
	});

	it("does not prune without a reset boundary", () => {
		const messages = [
			{ role: "assistant", content: textContent("before") },
			{ role: "toolResult", toolCallId: "c", content: textContent("result") },
		];
		expect(projectMessages({ messages, ledger: freshLedger() })).toEqual(messages);
	});

	it("preserves the host's wrapped-entry shape and wraps the tail the same way", () => {
		const entry = { type: "message", message: { role: "user", content: "wrapped" } };
		const projected = projectMessages({
			messages: [entry],
			ledger: freshLedger(),
			boardDelta: { stableText: "protocol", stableKey: "k1" },
		});
		expect(projected[0]).toBe(entry);
		expect(projected[1]).toMatchObject({ type: "message", message: { role: "user" } });
	});

	it("recognizes Anthropic-style tool_result blocks inside user messages", () => {
		const ledger = freshLedger();
		reset(ledger, { turnId: "t1", callId: "c-reset", budget: 2 });
		settle(ledger, { turnId: "t1" });
		const messages = [
			{ role: "user", content: "human" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "c-old", name: "read", input: {} }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "c-old", content: "old output" }],
			},
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "c-reset", name: "write", input: {} }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "c-reset", content: "applied" }],
			},
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "c-after", name: "read", input: {} }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "c-after", content: "after" }],
			},
		];

		const projected = projectMessages({ messages, ledger });
		expect(projected.some((message) => message.content?.[0]?.tool_use_id === "c-old")).toBe(false);
		expect(projected.some((message) => message.content?.[0]?.tool_use_id === "c-reset")).toBe(true);
		expect(projected.some((message) => message.content?.[0]?.tool_use_id === "c-after")).toBe(true);
	});

	it("filters sibling tool_result blocks in a shared user message", () => {
		const ledger = freshLedger();
		reset(ledger, { turnId: "t1", callId: "c-reset", budget: 2 });
		settle(ledger, { turnId: "t1" });
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "c-assume", name: "assume", input: { assumption: "keep" } },
					{ type: "tool_use", id: "c-read", name: "read", input: {} },
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "c-assume", content: "pinned" },
					{ type: "tool_result", tool_use_id: "c-read", content: "noise" },
				],
			},
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "c-reset", name: "write", input: {} }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "c-reset", content: "reset" }],
			},
		];

		const projected = projectMessages({ messages, ledger });
		const resultIds = projected.flatMap((message) =>
			Array.isArray(message.content)
				? message.content.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id)
				: [],
		);
		expect(resultIds).toEqual(["c-assume", "c-reset"]);
	});

	it("uses the latest settled reset boundary when a newer reset is still open", () => {
		const ledger = freshLedger();
		reset(ledger, { turnId: "t1", callId: "c-old", budget: 2 });
		settle(ledger, { turnId: "t1" });
		reset(ledger, { turnId: "t2", callId: "c-new", budget: 2 });
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c-before", name: "read", arguments: {} }],
			},
			{ role: "toolResult", toolCallId: "c-before", toolName: "read", content: textContent("before") },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c-old", name: "write", arguments: {} }],
			},
			{ role: "toolResult", toolCallId: "c-old", toolName: "write", content: textContent("old reset") },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c-between", name: "read", arguments: {} }],
			},
			{ role: "toolResult", toolCallId: "c-between", toolName: "read", content: textContent("between") },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c-new", name: "write", arguments: {} }],
			},
			{ role: "toolResult", toolCallId: "c-new", toolName: "write", content: textContent("new reset") },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c-after", name: "read", arguments: {} }],
			},
			{ role: "toolResult", toolCallId: "c-after", toolName: "read", content: textContent("after") },
		];

		const open = projectMessages({ messages, ledger });
		expect(open.some((message) => message.toolCallId === "c-before")).toBe(false);
		expect(open.some((message) => message.toolCallId === "c-between")).toBe(true);

		settle(ledger, { turnId: "t2" });
		const closed = projectMessages({ messages, ledger });
		expect(closed.some((message) => message.toolCallId === "c-between")).toBe(false);
		expect(closed.some((message) => message.toolCallId === "c-new")).toBe(true);
	});
});

describe("two-block anchors", () => {
	it("clean-breaks once, then appends a small delta while the stable prefix stays identical", () => {
		const ledger = freshLedger();
		const first = projectMessages({
			messages: [{ role: "user", content: "start" }],
			ledger,
			boardDelta: { stableText: "stage S2 protocol", snapshot: "board-v1", stableKey: "stable-1" },
		});
		const stableFirst = tail(first, "[HERD STABLE]");
		expect(stableFirst.text).toContain("board-v1");
		expect(tail(first, "[HERD BOARD DELTA]")).toBeUndefined();
		expect(tail(first, "[HERD RUNTIME]").text).toContain(":board-mode :full");

		const second = projectMessages({
			messages: [{ role: "user", content: "start" }],
			ledger,
			boardDelta: {
				stableText: "stage S2 protocol",
				snapshot: "board-v2",
				stableKey: "stable-1",
				events: ["worker A claimed T1", "worker B claimed T2"],
			},
		});
		const stableSecond = tail(second, "[HERD STABLE]");
		expect(stableSecond.text).toBe(stableFirst.text);
		expect(tail(second, "[HERD BOARD DELTA]").text).toContain("worker A claimed T1");
		expect(tail(second, "[HERD RUNTIME]").text).toContain(":board-mode :delta");
	});

	it("clean-breaks on self-write, stable-key change, and delta overflow", () => {
		const ledger = freshLedger();
		projectMessages({
			messages: [],
			ledger,
			boardDelta: { stableText: "protocol", snapshot: "board-v1", stableKey: "k1" },
		});

		const selfWrite = projectMessages({
			messages: [],
			ledger,
			boardDelta: {
				stableText: "protocol",
				snapshot: "board-v2",
				stableKey: "k1",
				selfWrote: true,
				events: ["own write"],
			},
		});
		expect(tail(selfWrite, "[HERD STABLE]").text).toContain("board-v2");
		expect(tail(selfWrite, "[HERD BOARD DELTA]")).toBeUndefined();
		expect(ledger.view.lastBreakReason).toBe("self-write");

		const stableChange = projectMessages({
			messages: [],
			ledger,
			boardDelta: { stableText: "protocol v2", snapshot: "board-v3", stableKey: "k2" },
		});
		expect(tail(stableChange, "[HERD STABLE]").text).toContain("board-v3");
		expect(ledger.view.lastBreakReason).toBe("stable-change");

		const overflow = projectMessages({
			messages: [],
			ledger,
			boardDelta: {
				stableText: "protocol v2",
				stableKey: "k2",
				events: Array.from({ length: 33 }, (_, index) => `event-${index}`),
			},
		});
		expect(tail(overflow, "[HERD BOARD DELTA]")).toBeUndefined();
		expect(tail(overflow, "[HERD RUNTIME]").text).toContain(":delta-dropped 33");
		expect(ledger.view.lastBreakReason).toBe("delta-overflow");
	});

	it("counts a delta by UTF-8 bytes as well as entries", () => {
		const ledger = freshLedger();
		projectMessages({
			messages: [],
			ledger,
			boardDelta: { stableText: "protocol", snapshot: "board", stableKey: "k1" },
		});
		const huge = projectMessages({
			messages: [],
			ledger,
			boardDelta: {
				stableText: "protocol",
				stableKey: "k1",
				events: ["万".repeat(1400)],
			},
		});
		expect(tail(huge, "[HERD BOARD DELTA]")).toBeUndefined();
		expect(ledger.view.lastBreakReason).toBe("delta-overflow");
	});

	it("clean-breaks on a new full snapshot when no delta is supplied", () => {
		const ledger = freshLedger();
		projectMessages({
			messages: [],
			ledger,
			boardDelta: { stableText: "protocol", snapshot: "board-v1", stableKey: "k1" },
		});
		const changed = projectMessages({
			messages: [],
			ledger,
			boardDelta: { stableText: "protocol", snapshot: "board-v2", stableKey: "k1" },
		});
		expect(tail(changed, "[HERD STABLE]").text).toContain("board-v2");
		expect(ledger.view.lastBreakReason).toBe("snapshot-change");
	});

	it("establishes the first full snapshot even when events accompany it", () => {
		const ledger = freshLedger();
		projectMessages({
			messages: [],
			ledger,
			boardDelta: { stableText: "protocol", stableKey: "k1", events: ["early event"] },
		});
		expect(ledger.view.stableSnapshot).toBe("");

		const anchored = projectMessages({
			messages: [],
			ledger,
			boardDelta: { stableText: "protocol", stableKey: "k1", snapshot: "board-v1", events: ["event"] },
		});
		expect(tail(anchored, "[HERD STABLE]").text).toContain("board-v1");
		expect(ledger.view.stableSnapshot).toBe("board-v1");
		expect(ledger.view.lastBreakReason).toBe("snapshot-change");

		const delta = projectMessages({
			messages: [],
			ledger,
			boardDelta: { stableText: "protocol", stableKey: "k1", snapshot: "board-v2", events: ["later event"] },
		});
		expect(tail(delta, "[HERD STABLE]").text).toContain("board-v1");
		expect(tail(delta, "[HERD BOARD DELTA]").text).toContain("later event");
	});

	it("treats a matching writerId as a self-write clean-break", () => {
		const ledger = freshLedger();
		projectMessages({
			messages: [],
			ledger,
			boardDelta: { stableText: "protocol", snapshot: "board-v1", stableKey: "k1" },
		});
		const self = projectMessages({
			messages: [],
			ledger,
			boardDelta: {
				stableText: "protocol",
				snapshot: "board-v2",
				stableKey: "k1",
				writerId: ledger.agentId,
				events: ["own write"],
			},
		});
		expect(tail(self, "[HERD STABLE]").text).toContain("board-v2");
		expect(tail(self, "[HERD BOARD DELTA]")).toBeUndefined();
		expect(ledger.view.lastBreakReason).toBe("self-write");
	});
});

describe("cache breakpoints", () => {
	function projectedWithTail(ledger) {
		return projectMessages({
			messages: [
				{ role: "user", content: "history" },
				{ role: "assistant", content: textContent("answer") },
			],
			ledger,
			boardDelta: { stableText: "protocol", snapshot: "board", stableKey: "k1" },
		});
	}

	it("moves an Anthropic marker from the transient tail to the last history block", () => {
		const ledger = freshLedger();
		const messages = projectedWithTail(ledger);
		const runtime = tail(messages, "[HERD RUNTIME]");
		runtime.cache_control = { type: "ephemeral", ttl: "5m" };
		const payload = { messages };

		const returned = relocateCacheBreakpoints(payload);
		const result = payload.__herdCacheRelocation;

		expect(returned).toBe(payload);
		expect(result.moved).toBe(1);
		expect(result.breakpointsBefore).toBe(result.breakpointsAfter);
		expect(runtime.cache_control).toBeUndefined();
		const historyAssistant = payload.messages.find((message) => message.role === "assistant");
		expect(historyAssistant.content.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
	});

	it("moves a Bedrock cachePoint without increasing the marker count", () => {
		const ledger = freshLedger();
		const messages = projectedWithTail(ledger);
		const delta = projectMessages({
			messages: [],
			ledger,
			boardDelta: { stableText: "protocol", stableKey: "k1", events: ["one"] },
		});
		const deltaMessage = delta.find((message) =>
			message.content?.some((block) => block.text?.startsWith("[HERD BOARD DELTA]")),
		);
		deltaMessage.content.push({ cachePoint: { type: "default" } });
		const combined = [...messages.filter((message) => !isTailMessage(message)), deltaMessage];
		const payload = { messages: combined };

		const returned = relocateCacheBreakpoints(payload);
		const result = payload.__herdCacheRelocation;

		expect(returned).toBe(payload);
		expect(result.moved).toBe(1);
		expect(result.breakpointsBefore).toBe(result.breakpointsAfter);
		expect(deltaMessage.content.some((block) => block.cachePoint !== undefined)).toBe(false);
		const historyAssistant = payload.messages.find((message) => message.role === "assistant");
		expect(historyAssistant.content.at(-1)).toEqual({ cachePoint: { type: "default" } });
	});

	it("keeps the marker in place when history has no safe target", () => {
		const ledger = freshLedger();
		const messages = projectMessages({
			messages: [],
			ledger,
			boardDelta: { stableText: "protocol", stableKey: "k1" },
		});
		const runtime = tail(messages, "[HERD RUNTIME]");
		runtime.cache_control = { type: "ephemeral" };
		const payload = { messages };

		relocateCacheBreakpoints(payload);
		const result = payload.__herdCacheRelocation;

		expect(result.moved).toBe(0);
		expect(result.kept).toBe(1);
		expect(runtime.cache_control).toEqual({ type: "ephemeral" });
	});

	it("leaves markers on persistent messages untouched", () => {
		const ledger = freshLedger();
		const messages = projectedWithTail(ledger);
		const history = messages.find((message) => message.role === "user");
		history.content = [{ type: "text", text: "history", cache_control: { type: "ephemeral" } }];
		const payload = { messages };

		relocateCacheBreakpoints(payload);
		const result = payload.__herdCacheRelocation;

		expect(result.changed).toBe(false);
		expect(history.content[0].cache_control).toEqual({ type: "ephemeral" });
	});
});
