import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCljTools } from "../src/clj-main.mjs";
import { ALPHA_VERSE, applyVerseJumpToMessages, createAriadneStore } from "../src/scope/ariadne.mjs";

describe("Everything Everywhere Verse-Jumping + Ariadne's Thread", () => {
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
		const state = registerCljTools(pi, { ownerId: "verse-test" });
		activeHosts.push(state);
		return { tools, hooks, state };
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "verse-test-"));
	});

	afterEach(() => {
		while (activeHosts.length > 0) activeHosts.pop().terminate?.();
		rmSync(root, { recursive: true, force: true });
	});

	it("tracks only activated parallel verses hidden from current history, computes LCA distance, and shares ariadne_thread/ariadne_goal DRYly", () => {
		const store = createAriadneStore();
		const sk = "s1";

		// Ordinary unactivated programs in alpha
		store.validateAndApplyFork(sk, {}, "p0", "c0", "clj_plan");
		store.settleTurn(sk);

		store.validateAndApplyFork(sk, { ariadne_thread: 5, ariadne_goal: "goal-1" }, "p1", "c1", "clj_plan");
		store.settleTurn(sk);
		store.markTurnActive(sk);
		store.settleTurn(sk); // currentTurn = 2

		store.validateAndApplyFork(sk, {}, "p2-ordinary", "c2", "clj_plan");
		store.settleTurn(sk);
		store.validateAndApplyFork(sk, { ariadne_thread: 2, ariadne_goal: "goal-3" }, "p3", "c3", "clj_plan");
		store.settleTurn(sk);

		expect(store.status(sk).verseName).toBe(ALPHA_VERSE);
		expect(store.status(sk).otherVerses).toEqual([]);

		// Jump to p2-ordinary with a fresh ariadne_thread+ariadne_goal: alpha is frozen as activated; p0 is NOT surfaced!
		const j1 = store.verseJump(
			sk,
			{
				target: "p2-ordinary",
				experience: "try B with full subjective experience",
				ariadne_thread: 4,
				ariadne_goal: "approach-B",
			},
			{ jumpCallId: "vj-1", leafId: "leaf-alpha" },
		);
		expect(j1.kind).toBe("fork-history");
		expect(j1.lcaDistance).toBe(2); // [p2-ordinary, p3]
		expect(j1.otherVerses.map((v) => v.verseName)).toEqual(["alpha"]);
		const block = store.formatAriadneBlock(sk);
		expect(block).toContain("<OTHER-VERSES>");
		expect(block).toContain("alpha");
		expect(block).not.toContain("p0");

		// Jump back into alpha: uses alpha's saved cutCallId ("vj-1") DRYly!
		const j2 = store.verseJump(
			sk,
			{ target: "alpha", experience: "B failed, resume alpha" },
			{ jumpCallId: "vj-2", leafId: "leaf-p2" },
		);
		expect(j2.kind).toBe("resume-verse");
		expect(j2.otherVerses.map((v) => v.verseName)).toEqual(["p2-ordinary"]);
	});

	it("acts as a soft gate at remaining <= 0 without blocking tools", async () => {
		const { tools, hooks } = fakeHost();
		const cljPlan = tools.get("clj_plan");
		const ctx = { cwd: root };

		await cljPlan.execute(
			"c1",
			{ name: "start", code: "1", ariadne_thread: 1, ariadne_goal: "finish quickly" },
			undefined,
			undefined,
			ctx,
		);
		await hooks.get("turn_end")[0]({}, ctx);
		await cljPlan.execute("c2", { name: "step2", code: "2" }, undefined, undefined, ctx);
		await hooks.get("turn_end")[0]({}, ctx);
		const r3 = await cljPlan.execute("c3", { name: "step3", code: "3" }, undefined, undefined, ctx);
		expect(r3.isError).not.toBe(true);
		await hooks.get("turn_end")[0]({}, ctx);

		const ctxRes = await hooks.get("context")[0]({ messages: [{ role: "user", content: "hi" }] }, ctx);
		const blocks = ctxRes.messages[1].content;
		expect(blocks[0].text).toContain('<skill version="1.0">');
		expect(blocks[1].text).toContain("<ARIADNE-THREAD>");
		expect(blocks[1].text).toContain("出门太久忘本了");
	});

	it("uses the exact same cutFromToolCall path for fork-history and resume-verse", () => {
		const alphaMessages = [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-p1", name: "clj_plan", arguments: { name: "p1", code: "1" } }],
			},
			{ role: "toolResult", toolCallId: "call-p1", toolName: "clj_plan", content: [{ type: "text", text: "old-p1" }] },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "vj-1", name: "verse_jump", arguments: { target: "p1", experience: "fork" } },
				],
			},
			{ role: "toolResult", toolCallId: "vj-1", toolName: "verse_jump", content: [{ type: "text", text: "jumped" }] },
		];

		// Fork-history cuts at call-p1
		const forked = applyVerseJumpToMessages(alphaMessages, {
			kind: "fork-history",
			targetProgram: "p1",
			cutCallId: "call-p1",
			targetGoal: "fix login",
			experience: "use approach B",
			otherVerses: [{ verseName: "alpha", goal: "try A" }],
		});
		expect(forked.messages).toHaveLength(2);
		expect(forked.messages[1].role).toBe("user");
		expect(forked.messages[1].content[0].text).toContain("Goal: fix login");
		expect(forked.messages[1].content[0].text).toContain("use approach B");

		// Resume-verse cuts at alpha's verse_jump call ("vj-1"), leaving p1 + its result intact!
		const resumed = applyVerseJumpToMessages(forked.messages, {
			kind: "resume-verse",
			targetProgram: "alpha",
			cutCallId: "vj-1",
			fallbackMessages: alphaMessages,
			targetGoal: "try A",
			experience: "B failed, back to alpha",
			otherVerses: [{ verseName: "p1", goal: "fix login" }],
		});
		expect(resumed.messages).toHaveLength(4);
		expect(resumed.messages[2].role).toBe("toolResult");
		expect(resumed.messages[3].role).toBe("user");
		expect(resumed.messages[3].content[0].text).toContain("B failed, back to alpha");
	});

	it("requires cleaning up parked programs missing from target universe, while allowing parked programs present in target history", () => {
		const store = createAriadneStore();
		const sk = "s-parked";

		store.validateAndApplyFork(sk, {}, "shared-parked", "c0", "clj_worker");
		store.settleTurn(sk);
		store.validateAndApplyFork(sk, {}, "branch-point", "c1", "clj_plan");
		store.settleTurn(sk);
		store.validateAndApplyFork(sk, {}, "later-parked", "c2", "clj_worker");
		store.settleTurn(sk);

		// Jumping to branch-point with later-parked still parked must fail
		expect(() =>
			store.verseJump(
				sk,
				{ target: "branch-point", experience: "go back" },
				{ jumpCallId: "vj-err", parkedNames: ["shared-parked", "later-parked"] },
			),
		).toThrow(/later-parked/);

		// Once later-parked is cleaned up, shared-parked IS in branch-point's history so jump succeeds!
		const ok = store.verseJump(
			sk,
			{ target: "branch-point", experience: "shared-parked still lives in past" },
			{ jumpCallId: "vj-ok", parkedNames: ["shared-parked"] },
		);
		expect(ok.kind).toBe("fork-history");
	});

	it("renders and overwrites per-universe beacon ads in <OTHER-VERSES>", () => {
		const store = createAriadneStore();
		const sk = "s-beacon";

		store.validateAndApplyFork(sk, { ariadne_thread: 5, ariadne_goal: "alpha-goal" }, "p1", "c1", "clj_plan");
		store.settleTurn(sk);

		// Leave alpha with a beacon
		store.verseJump(
			sk,
			{ target: "p1", experience: "fork p1", beacon: "Call me back if Redis lock fails" },
			{ jumpCallId: "vj-1", leafId: "leaf-alpha" },
		);
		expect(store.formatAriadneBlock(sk)).toContain("Beacon: Call me back if Redis lock fails");

		// Jump back to alpha without overwriting p1's beacon, then leave alpha again with an updated beacon
		store.verseJump(
			sk,
			{ target: "alpha", experience: "back to alpha", beacon: "p1 specialty" },
			{ jumpCallId: "vj-2" },
		);
		store.verseJump(
			sk,
			{ target: "p1", experience: "try p1 again", beacon: "Updated alpha beacon" },
			{ jumpCallId: "vj-3" },
		);
		const block = store.formatAriadneBlock(sk);
		expect(block).toContain("Beacon: Updated alpha beacon");
		expect(block).not.toContain("Call me back if Redis lock fails");
	});

	it("uses buildSessionContext() on resume-verse so pre-compaction messages are never resurrected", () => {
		let branchedTo = null;
		const fakeSm = {
			branch(id) {
				branchedTo = id;
			},
			getBranch() {
				// Simulates raw full-history entries before compaction
				return [
					{ type: "message", message: { role: "user", content: "pre-compaction-giant-1" } },
					{ type: "message", message: { role: "user", content: "pre-compaction-giant-2" } },
					{ type: "message", message: { role: "user", content: "post-compaction" } },
				];
			},
			buildSessionContext() {
				// Resolved context respects compaction boundary
				return {
					messages: [
						{ role: "user", content: "compaction-summary" },
						{ role: "user", content: "post-compaction" },
					],
				};
			},
		};

		const res = applyVerseJumpToMessages(
			[],
			{
				kind: "resume-verse",
				targetProgram: "alpha",
				targetLeafId: "leaf-alpha",
				cutCallId: "vj-missing",
				experience: "back with findings",
			},
			fakeSm,
		);

		expect(branchedTo).toBe("leaf-alpha");
		expect(res.branchSwitched).toBe(true);
		expect(res.messages).toHaveLength(3);
		expect(res.messages[0].content).toBe("compaction-summary");
		expect(res.messages.some((m) => m.content === "pre-compaction-giant-1")).toBe(false);
	});

	it("keeps aging older anchors even when newer clj_* calls set their own ariadne_thread", () => {
		const store = createAriadneStore();
		const sk = "s-age";

		store.validateAndApplyFork(sk, { ariadne_thread: 3, ariadne_goal: "root-goal" }, "p1", "c1", "clj_plan");
		store.settleTurn(sk);
		expect(store.status(sk).remaining).toBe(3);

		// Subsequent turn ALSO sets ariadne_thread: 5 -> p1 must still age from 3 -> 2!
		store.validateAndApplyFork(sk, { ariadne_thread: 5, ariadne_goal: "sub-goal" }, "p2", "c2", "clj_plan");
		store.settleTurn(sk);
		expect(store.status(sk).remaining).toBe(2);
		expect(store.status(sk).tightest.map((t) => t.programName)).toEqual(["p1"]);

		// Another turn setting ariadne_thread: 5 -> p1 ages from 2 -> 1!
		store.validateAndApplyFork(sk, { ariadne_thread: 5, ariadne_goal: "sub-goal-2" }, "p3", "c3", "clj_plan");
		store.settleTurn(sk);
		expect(store.status(sk).remaining).toBe(1);
	});
});
