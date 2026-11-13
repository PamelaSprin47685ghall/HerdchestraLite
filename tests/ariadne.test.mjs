import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCljTools } from "../src/clj-main.mjs";
import { applyTimeLeapToMessages, createAriadneStore } from "../src/scope/ariadne.mjs";
import { BEACON_TOOL_SCOLD, queryBeacon } from "../src/scope/beacon-query.mjs";

describe("Time Leap++ + Ariadne's Thread + Read-Only Beacons", () => {
	const activeHosts = [];
	let root;

	function fakeHost(extraDeps = {}) {
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
		const state = registerCljTools(pi, { ownerId: "time-leap-test", ...extraDeps });
		activeHosts.push(state);
		return { tools, hooks, state };
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "time-leap-test-"));
	});

	afterEach(() => {
		while (activeHosts.length > 0) activeHosts.pop().terminate?.();
		rmSync(root, { recursive: true, force: true });
	});

	it("requires beacon, forbids ariadne_budget/ariadne_goal, cuts current timeline, and seals read-only <BEACONS>", () => {
		const store = createAriadneStore();
		const sk = "s1";

		store.validateAndApplyFork(sk, { ariadne_budget: 5, ariadne_goal: "goal-1" }, "p1", "c1", "clj_plan");
		store.settleTurn(sk); // currentTurn = 1, deadline = 6 (remaining 5)
		store.validateAndApplyFork(sk, { ariadne_budget: 2, ariadne_goal: "goal-2" }, "p2", "c2", "clj_plan");
		store.settleTurn(sk); // currentTurn = 2, mean deadline = 5 (remaining 3)

				// Missing beacon -> rejected
		expect(() => store.timeLeap(sk, { target: "p2", experience: "go back" })).toThrow(/beacon/);

		// Passing ariadne_budget or ariadne_goal -> rejected
		expect(() =>
			store.timeLeap(sk, {
				target: "p2",
				experience: "go back",
				beacon_name: "b1",
				beacon_description: "left off at p2",
				ariadne_budget: 3,
			}),
		).toThrow(/ariadne_budget/);
		expect(() =>
			store.timeLeap(sk, {
				target: "p2",
				experience: "go back",
				beacon_name: "b1",
				beacon_description: "left off at p2",
				ariadne_goal: "new goal",
			}),
		).toThrow(/ariadne_goal/);

		// Valid time_leap back to p2: restores turn=1, pops p2 so p1 (remaining=5) is restored (updatedBudget=5)
		const res = store.timeLeap(
			sk,
			{ target: "p2", experience: "approach A failed; try B", beacon_name: "alpha", beacon_description: "Redis race details live here" },
			{ jumpCallId: "tl-1", leafId: "leaf-alpha" },
		);
		expect(res.target).toBe("p2");
		expect(res.beaconName).toBe("alpha");
		expect(res.remaining).toBe(5);
		expect(res.updatedBudget).toBe(5);

		

		// Cannot jump to or resurrect the sealed beacon "alpha"
		expect(() => store.timeLeap(sk, { target: "alpha", experience: "resurrect", beacon_name: "b2", beacon_description: "b2" })).toThrow(
			/Unknown target/,
		);

		const block = store.formatAriadneBlock(sk);
		expect(block).not.toContain("<BEACONS>");
		const beacons = store.listBeacons(sk);
		expect(beacons).toHaveLength(1);
		expect(beacons[0].name).toBe("alpha");
		expect(beacons[0].description).toBe("Redis race details live here");
	});

	it("treats compaction as a hard boundary and hides pre-compaction anchors", () => {
		const store = createAriadneStore();
		const sk = "s-compact";

		const preCall = {
			id: "e1",
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c-pre", name: "clj_plan", arguments: { name: "pre-anchor", code: "1" } }],
			},
		};
		const compactEntry = { id: "comp-1", type: "compaction", summary: "compacted" };
		const postCall = {
			id: "e2",
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c-post", name: "clj_plan", arguments: { name: "post-anchor", code: "2" } }],
			},
		};

		store.recoverHistory(sk, [preCall, compactEntry, postCall], [preCall, compactEntry, postCall]);

		// Pre-compaction anchor is treated as NOT FOUND
		expect(() => store.timeLeap(sk, { target: "pre-anchor", experience: "back", beacon_name: "b1", beacon_description: "b" })).toThrow(
			/Unknown target/,
		);

		// Post-compaction anchor IS reachable
		const res = store.timeLeap(sk, { target: "post-anchor", experience: "back", beacon_name: "b1", beacon_description: "b" });
		expect(res.target).toBe("post-anchor");
	});

	it("acts as a soft gate at remaining <= 0 without blocking tools", async () => {
		const { tools, hooks } = fakeHost();
		const cljDevops = tools.get("clj_devops");
		const ctx = { cwd: root };

		await cljDevops.execute(
			"c1",
			{ name: "start", code: "1", ariadne_budget: 1, ariadne_goal: "finish quickly" },
			undefined,
			undefined,
			ctx,
		);
		await hooks.get("turn_end")[0]({}, ctx);
		await cljDevops.execute(
			"c2",
			{ name: "step2", code: "2", ariadne_budget: 1, ariadne_goal: "finish quickly" },
			undefined,
			undefined,
			ctx,
		);
		await hooks.get("turn_end")[0]({}, ctx);
		const r3 = await cljDevops.execute(
			"c3",
			{ name: "step3", code: "3", ariadne_budget: 1, ariadne_goal: "finish quickly" },
			undefined,
			undefined,
			ctx,
		);
		expect(r3.isError).not.toBe(true);
		await hooks.get("turn_end")[0]({}, ctx);

		const ctxRes = await hooks.get("context")[0]({ messages: [{ role: "user", content: "hi" }] }, ctx);
		const blocks = ctxRes.messages[1].content;
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toContain('<skill version="1.0">');
		expect(blocks[0].text).toContain("出门太久忘本了");
	});

	it("rewrites messages forward-cleanly with applyTimeLeapToMessages without branch switching", () => {
		const messages = [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-p1", name: "clj_plan", arguments: { name: "p1", code: "1" } }],
			},
			{ role: "toolResult", toolCallId: "call-p1", toolName: "clj_plan", content: [{ type: "text", text: "old-p1" }] },
			{ role: "assistant", content: [{ type: "text", text: "dead end" }] },
		];

		const next = applyTimeLeapToMessages(messages, {
			targetProgram: "p1",
			cutCallId: "call-p1",
			targetGoal: "fix login",
			experience: "use approach B",
		});
		expect(next.messages).toHaveLength(2);
		expect(next.messages[1].role).toBe("user");
		expect(next.messages[1].content[0].text).toContain("Goal: fix login");
		expect(next.messages[1].content[0].text).toContain("use approach B");
	});

	it("ask_beacon reuses cached prefix, scolds on first tool call, and fails if the Beacon disobeys twice", async () => {
		const cachedMessages = [
			{ role: "user", content: [{ type: "text", text: "investigate bug" }] },
			{ role: "assistant", content: [{ type: "text", text: "found it at src/foo.mjs:42" }] },
		];
		const beacon = {
			name: "alpha",
			description: "has exact line number",
			messagesSnapshot: cachedMessages,
		};

		// Case 1: disobeys once with a toolCall -> scolded without running tool -> answers cleanly on retry
		const calls1 = [];
		const mockComplete1 = async (_model, context) => {
			calls1.push(context.messages);
			if (calls1.length === 1) {
				return {
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "bad-1", name: "clj_plan", arguments: { code: "1" } }],
				};
			}
			return {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "src/foo.mjs:42" }],
			};
		};
		const okRes = await queryBeacon({
			beacon,
			question: "which line?",
			model: { id: "mock" },
			systemPrompt: "sys",
			complete: mockComplete1,
		});
		expect(okRes.answer).toBe("src/foo.mjs:42");
		expect(okRes.retried).toBe(true);
		// Verify prefix cache alignment: first N messages are identical to cachedMessages
		expect(calls1[0].slice(0, 2)).toEqual(cachedMessages);
		// Verify scold toolResult was fed back without executing any tool
		const scoldResult = calls1[1].find((m) => m.role === "toolResult" && m.toolCallId === "bad-1");
		expect(scoldResult.isError).toBe(true);
		expect(scoldResult.content[0].text).toBe(BEACON_TOOL_SCOLD);

		// Case 2: disobeys twice -> returns failure (:CAPABILITY_DENIED)
		const mockComplete2 = async () => ({
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "bad-2", name: "clj_worker", arguments: { code: "2" } }],
		});
		await expect(
			queryBeacon({
				beacon,
				question: "which line?",
				model: { id: "mock" },
				systemPrompt: "sys",
				complete: mockComplete2,
			}),
		).rejects.toMatchObject({ code: ":CAPABILITY_DENIED" });
	});

	it("wires time_leap and ask_beacon end-to-end through clj-main", async () => {
		const seenPrompts = [];
		const { tools, hooks } = fakeHost({
			completeSimple: async (_model, context) => {
				seenPrompts.push(context);
				return {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "Line 42 in src/foo.mjs" }],
				};
			},
		});
		expect(tools.has("verse_jump")).toBe(false);
		expect(tools.has("time_leap")).toBe(true);
		expect(tools.has("ask_beacon")).toBe(true);

		const ctx = {
			cwd: root,
			model: { id: "mock-model" },
			modelRegistry: {
				async getApiKey() {
					return "k";
				},
			},
		};
		await tools
			.get("clj_devops")
			.execute("c1", { name: "p1", code: "1", ariadne_budget: 3, ariadne_goal: "solve" }, undefined, undefined, ctx);
		const leapRes = await tools
			.get("time_leap")
			.execute(
				"tl-1",
				{ target: "p1", experience: "retry clean", beacon_name: "alpha", beacon_description: "alpha knew line 42" },
				undefined,
				undefined,
				ctx,
			);
		expect(leapRes.isError).not.toBe(true);
		expect(leapRes.content[0].text).toContain(":time-leaped-from");
		expect(leapRes.content[0].text).toContain(":available-beacons [");
		expect(leapRes.content[0].text).toContain(":description");
		expect(leapRes.content[0].text).toContain(":name");

		// Trigger context hook so leaving beacon's messagesSnapshot is captured
		const beforeLeapMessages = [
			{ role: "user", content: [{ type: "text", text: "go" }] },
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "clj_plan", arguments: {} }] },
			{ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "1" }] },
		];
		await hooks.get("context")[0]({ messages: beforeLeapMessages }, ctx);

		const askRes = await tools
			.get("ask_beacon")
			.execute("ab-1", { target: "alpha", question: "what line was it?" }, undefined, undefined, ctx);
		expect(askRes.isError).not.toBe(true);
		expect(askRes.content[0].text).toBe("Line 42 in src/foo.mjs");
		expect(seenPrompts[0].messages.slice(0, 3)).toEqual(beforeLeapMessages);
	});
});
