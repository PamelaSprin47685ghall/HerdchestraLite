import { describe, expect, it } from "bun:test";
import { computeMessagesDelta, hackContext } from "../src/host/hack-context.mjs";
import { appendOutboundContextTail } from "../src/prompts/runtime-wires.mjs";

function fakeSessionManager(initialEntries = []) {
	const entries = initialEntries.map((e) => ({ ...e }));
	let leafId = entries.length > 0 ? entries[entries.length - 1].id : null;
	const calls = [];
	let seq = entries.length;

	const indexById = () => new Map(entries.map((e) => [e.id, e]));

	return {
		calls,
		entries,
		getLeafId: () => leafId,
		getBranch() {
			const map = indexById();
			const path = [];
			let cur = leafId;
			while (cur != null) {
				const entry = map.get(cur);
				if (!entry) break;
				path.push(entry);
				cur = entry.parentId ?? null;
			}
			return path.reverse();
		},
		branch(branchFromId) {
			calls.push({ op: "branch", branchFromId });
			leafId = branchFromId;
		},
		resetLeaf() {
			calls.push({ op: "resetLeaf" });
			leafId = null;
		},
		appendMessage(message) {
			seq += 1;
			const id = `e${seq}`;
			const entry = { type: "message", id, parentId: leafId, message };
			entries.push(entry);
			leafId = id;
			calls.push({ op: "appendMessage", id, parentId: entry.parentId, message });
			return id;
		},
	};
}

describe("hackContext", () => {
	it("computes longest common prefix delta accurately", () => {
		const m1 = { role: "user", content: "a" };
		const m2 = { role: "assistant", content: [{ type: "thinking", thinking: "t1" }] };
		const m2Edited = { role: "assistant", content: [{ type: "thinking", thinking: "t2" }] };

		expect(computeMessagesDelta([m1, m2], [m1, { ...m2 }])).toEqual({
			prefixLen: 2,
			removedCount: 0,
			appendedCount: 0,
			changed: false,
		});
		expect(computeMessagesDelta([m1], [m1, m2])).toEqual({
			prefixLen: 1,
			removedCount: 0,
			appendedCount: 1,
			changed: true,
		});
		expect(computeMessagesDelta([m1, m2], [m1, m2Edited])).toEqual({
			prefixLen: 1,
			removedCount: 1,
			appendedCount: 1,
			changed: true,
		});
	});

	it("persists language requirement once in O(1) and skips duplicate writes on subsequent turns", async () => {
		const handlers = new Map();
		const pi = {
			on(name, fn) {
				handlers.set(name, fn);
			},
		};
		hackContext(pi, (event) => ({
			messages: appendOutboundContextTail(event.messages, { parkedPrograms: [] }),
		}));

		const sm = fakeSessionManager([
			{ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hi" } },
		]);
		const ctx = { sessionManager: sm };

		// Turn 1: appends the skill block once without branching
		const res1 = await handlers.get("context")({ messages: sm.getBranch().map((e) => e.message) }, ctx);
		expect(res1.messages).toHaveLength(2);
		expect(sm.calls).toHaveLength(1);
		expect(sm.calls[0].op).toBe("appendMessage");
		expect(sm.calls[0].message.content[0].text).toContain('<skill version="1.0">');

		// Turn 2: already present -> zero disk writes, zero duplication
		sm.calls.length = 0;
		const res2 = await handlers.get("context")({ messages: sm.getBranch().map((e) => e.message) }, ctx);
		expect(res2.messages).toHaveLength(2);
		expect(sm.calls).toHaveLength(0);
	});

	it("rewrites only the modified tail via branch(parentId) + appendMessage", async () => {
		const handlers = new Map();
		const pi = { on: (name, fn) => handlers.set(name, fn) };

		const m1 = { role: "user", content: "q1" };
		const m2 = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "old" },
				{ type: "toolCall", id: "c1", name: "clj_plan", arguments: { code: "1" } },
			],
		};
		const sm = fakeSessionManager([
			{ type: "message", id: "e1", parentId: null, message: m1 },
			{ type: "thinking_level_change", id: "meta1", parentId: "e1", thinkingLevel: "high" },
			{ type: "message", id: "e2", parentId: "meta1", message: m2 },
		]);

		hackContext(pi, (event) => ({
			messages: [
				event.messages[0],
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "trimmed" },
						{ type: "toolCall", id: "c1", name: "clj_plan", arguments: { code: "2" } },
					],
				},
			],
		}));

		await handlers.get("context")({ messages: [m1, m2] }, { sessionManager: sm });

		expect(sm.calls).toHaveLength(2);
		expect(sm.calls[0]).toEqual({ op: "branch", branchFromId: "meta1" });
		expect(sm.calls[1].op).toBe("appendMessage");
		expect(sm.calls[1].parentId).toBe("meta1");
		expect(
			sm
				.getBranch()
				.map((e) => e.message)
				.filter(Boolean),
		).toHaveLength(2);
		expect(sm.getBranch().at(-1).message.content[0].thinking).toBe("trimmed");
	});

	it("resets leaf when index 0 is modified and degrades cleanly without sessionManager", async () => {
		const handlers = new Map();
		const pi = { on: (name, fn) => handlers.set(name, fn) };
		hackContext(pi, () => ({ messages: [{ role: "user", content: "replaced" }] }));

		const sm = fakeSessionManager([
			{ type: "message", id: "e1", parentId: null, message: { role: "user", content: "orig" } },
		]);
		await handlers.get("context")({ messages: [{ role: "user", content: "orig" }] }, { sessionManager: sm });
		expect(sm.calls[0]).toEqual({ op: "resetLeaf" });
		expect(sm.calls[1].op).toBe("appendMessage");

		// No sessionManager -> still returns outbound messages without throwing
		const noSm = await handlers.get("context")({ messages: [{ role: "user", content: "orig" }] }, {});
		expect(noSm.messages[0].content).toBe("replaced");
	});
});
