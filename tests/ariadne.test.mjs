import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCljTools } from "../src/clj-main.mjs";
import { applyTimeLeapToMessages, createAriadneStore } from "../src/scope/ariadne.mjs";

describe("Ariadne's Thread + Time Leap", () => {
	const activeHosts = [];
	let root;

	function fakeHost() {
		const tools = new Map();
		const hooks = new Map();
		const pi = {
			registerTool(tool) {
				tools.set(tool.name, tool);
			},
			registerCommand() {},
			on(name, fn) {
				const list = hooks.get(name) ?? [];
				list.push(fn);
				hooks.set(name, list);
			},
			getActiveTools() {
				return [];
			},
			async setActiveTools() {},
		};
		const state = registerCljTools(pi, { ownerId: "ariadne-test" });
		activeHosts.push(state);
		return { tools, hooks, state };
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "ariadne-test-"));
	});

	afterEach(() => {
		while (activeHosts.length > 0) activeHosts.pop().terminate?.();
		rmSync(root, { recursive: true, force: true });
	});

	it("tracks tightest deadline and ties in O(1) and restores earlier anchors on time_leap", () => {
		const store = createAriadneStore();
		const sk = "s1";

		// Unlimited before any ariadne_thread is set
		const unlim = store.validateAndApplyFork(sk, {}, "p0", "c0", "clj_plan");
		expect(unlim.remaining).toBeNull();
		expect(store.formatAriadneBlock(sk)).toBeNull();
		store.settleTurn(sk);

		// Turn 0: p1 sets deadline 0 + 5 = 5
		store.validateAndApplyFork(sk, { ariadne_thread: 5, ariadne_goal: "goal-1" }, "p1", "c1", "clj_plan");
		store.settleTurn(sk); // justAnchored: currentTurn stays 0

		// Walk 1 turn forward -> currentTurn = 1
		store.markTurnActive(sk);
		store.settleTurn(sk);
		expect(store.status(sk).remaining).toBe(4);

		// Turn 1: p2 sets ariadne_thread 4 -> deadline 1 + 4 = 5 (ties p1!)
		store.validateAndApplyFork(sk, { ariadne_thread: 4, ariadne_goal: "goal-2" }, "p2", "c2", "clj_plan");
		store.settleTurn(sk);
		const tied = store.status(sk);
		expect(tied.remaining).toBe(4);
		expect(tied.tightest.map((t) => t.programName)).toEqual(["p1", "p2"]);

		// Turn 1 -> p3 sets ariadne_thread 2 -> deadline 1 + 2 = 3 (tighter than 5!)
		store.validateAndApplyFork(sk, { ariadne_thread: 2, ariadne_goal: "goal-3" }, "p3", "c3", "clj_plan");
		store.settleTurn(sk);
		expect(store.status(sk).tightest.map((t) => t.programName)).toEqual(["p3"]);
		expect(store.status(sk).remaining).toBe(2);

		// p4 sets looser ariadne_thread 10 -> p3 still wins
		store.validateAndApplyFork(sk, { ariadne_thread: 10, ariadne_goal: "goal-4" }, "p4", "c4", "clj_plan");
		store.settleTurn(sk);
		expect(store.status(sk).tightest.map((t) => t.programName)).toEqual(["p3"]);

		// Time leap back to p2 pops p2 itself (plus p3, p4), restoring p1 so LLM can pick a new budget
		const leaped = store.timeLeap(sk, { target_program: "p2", hint: "skip p3/p4" });
		expect(leaped.remaining).toBe(4);
		expect(leaped.refunded).toBe(2);
		expect(store.status(sk).tightest.map((t) => t.programName)).toEqual(["p1"]);
	});

	it("acts as a soft gate at remaining <= 0 without blocking tools and injects guilt message", async () => {
		const { tools, hooks } = fakeHost();
		const cljPlan = tools.get("clj_plan");
		const ctx = { cwd: root };

		// Cold start with 1 turn
		const r1 = await cljPlan.execute(
			"c1",
			{ name: "start", code: "1", ariadne_thread: 1, ariadne_goal: "finish quickly" },
			undefined,
			undefined,
			ctx,
		);
		expect(r1.isError).not.toBe(true);
		await hooks.get("turn_end")[0]({}, ctx);

		// Walk 2 more turns past deadline (remaining becomes -1)
		const r2 = await cljPlan.execute("c2", { name: "step2", code: "2" }, undefined, undefined, ctx);
		expect(r2.isError).not.toBe(true);
		await hooks.get("turn_end")[0]({}, ctx);

		const r3 = await cljPlan.execute("c3", { name: "step3", code: "3" }, undefined, undefined, ctx);
		expect(r3.isError).not.toBe(true); // soft gate: NOT blocked!
		await hooks.get("turn_end")[0]({}, ctx);

		const ctxRes = await hooks.get("context")[0]({ messages: [{ role: "user", content: "hi" }] }, ctx);
		const blocks = ctxRes.messages[1].content;
		expect(blocks[0].text).toContain('<skill version="1.0">');
		expect(blocks[1].text).toContain("<ARIADNE-THREAD>");
		expect(blocks[1].text).toContain("出门太久忘本了");
		expect(blocks[1].text).toContain("start（目标：finish quickly）");
	});

	it("replaces target toolCall + toolResult with a single user message containing only Goal and hint", () => {
		const messages = [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "plan" },
					{ type: "toolCall", id: "call-p1", name: "clj_plan", arguments: { name: "p1", code: "1" } },
					{ type: "toolCall", id: "call-p2", name: "clj_devops", arguments: { name: "p2", code: "2" } },
				],
			},
			{ role: "toolResult", toolCallId: "call-p1", toolName: "clj_plan", content: [{ type: "text", text: "old-p1" }] },
			{
				role: "toolResult",
				toolCallId: "call-p2",
				toolName: "clj_devops",
				content: [{ type: "text", text: "old-p2" }],
			},
			{ role: "assistant", content: [{ type: "text", text: "wrong path" }] },
		];

		const next = applyTimeLeapToMessages(messages, {
			targetProgram: "p1",
			targetToolCallId: "call-p1",
			targetGoal: "fix login",
			hint: "don't touch p2, use approach B",
		});

		expect(next).toHaveLength(2);
		expect(next[1].role).toBe("user");
		expect(next[1].content[0].text).toBe("Goal: fix login\n\ndon't touch p2, use approach B");
	});
});
