import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyHistoryBarrier, flushTrace, hackContext } from "../src/host/hack-context.mjs";

let savedTrace;
let savedTracePath;
beforeEach(() => {
	savedTrace = process.env.HERD_TRACE;
	savedTracePath = process.env.HERD_TRACE_PATH;
	delete process.env.HERD_TRACE;
	delete process.env.HERD_TRACE_PATH;
});
afterEach(() => {
	if (savedTrace === undefined) delete process.env.HERD_TRACE;
	else process.env.HERD_TRACE = savedTrace;
	if (savedTracePath === undefined) delete process.env.HERD_TRACE_PATH;
	else process.env.HERD_TRACE_PATH = savedTracePath;
});

function hostManager(entries = []) {
	const state = {
		header: { runtime: { version: "test" }, cwd: "." },
		entries: entries.map((entry) => ({ ...entry })),
	};
	const calls = [];
	let rewriteCount = 0;
	const manager = {
		calls,
		state,
		get rewriteCount() {
			return rewriteCount;
		},
		captureState() {
			return { ...state, entries: [...state.entries] };
		},
		restoreState(next) {
			state.header = next.header;
			state.entries = next.entries;
			calls.push({ op: "restoreState", entries: next.entries });
		},
		rewriteEntries() {
			rewriteCount += 1;
			calls.push({ op: "rewriteEntries" });
			return Promise.resolve();
		},
		branch(id) {
			calls.push({ op: "branch", id });
		},
		appendMessage(message) {
			const id = `e${state.entries.length + 1}`;
			const parentId = state.entries.length ? state.entries[state.entries.length - 1].id : null;
			state.entries.push({ type: "message", id, parentId, message });
			calls.push({ op: "appendMessage", id, parentId, message });
			return id;
		},
		getLeafEntry() {
			return state.entries[state.entries.length - 1];
		},
		getEntry(id) {
			return state.entries.find((entry) => entry.id === id);
		},
		getLeafId() {
			return state.entries.length ? state.entries[state.entries.length - 1].id : null;
		},
		getBranch() {
			return state.entries;
		},
	};
	return manager;
}

function register(handler) {
	const handlers = new Map();
	hackContext({ on: (name, fn) => handlers.set(name, fn) }, handler);
	return handlers.get("context");
}

describe("hackContext (stateless, host-owned state)", () => {
	it("rewrites once on the first cut, then appends only the new tail", async () => {
		const manager = hostManager([
			{ type: "message", id: "old", parentId: null, message: { role: "user", content: "old" } },
		]);
		const doc = { role: "user", content: [{ type: "text", text: "doc" }] };
		const context = register((event) => ({ messages: [doc, ...event.messages.slice(1)] }));
		const ctx = { sessionManager: manager };

		await context({ messages: [{ role: "user", content: "old" }] }, ctx);
		expect(manager.rewriteCount).toBe(1);
		expect(manager.state.entries.map((entry) => entry.message)).toEqual([doc]);

		const after = { role: "assistant", content: [{ type: "text", text: "after" }] };
		const next = await context({ messages: [{ role: "user", content: "old" }, after] }, ctx);
		expect(manager.rewriteCount).toBe(1);
		const appends = manager.calls.filter((call) => call.op === "appendMessage");
		expect(appends).toHaveLength(1);
		expect(appends[0].message).toBe(after);
		expect(next.messages[1]).toBe(after);
	});

	it("stays append-only when the leaf is a custom entry", async () => {
		const seed = { role: "user", content: "seed" };
		const manager = hostManager([
			{ type: "message", id: "e1", parentId: null, message: seed },
			{ type: "custom", id: "c1", parentId: "e1", data: {} },
		]);
		const skill = { role: "user", content: [{ type: "text", text: "tail" }] };
		const context = register((event) => ({ messages: [...event.messages, skill] }));
		await context({ messages: [seed] }, { sessionManager: manager });
		expect(manager.rewriteCount).toBe(0);
		const appends = manager.calls.filter((call) => call.op === "appendMessage");
		expect(appends).toHaveLength(1);
		expect(appends[0].message).toBe(skill);
	});

	it("rewrites on a replacement or when fullRewrite is requested", async () => {
		const manager = hostManager([
			{ type: "message", id: "e1", parentId: null, message: { role: "user", content: "old" } },
		]);
		const replacement = { role: "user", content: "replacement" };
		const context = register(() => ({ messages: [replacement] }));
		await context({ messages: [{ role: "user", content: "old" }] }, { sessionManager: manager });
		expect(manager.rewriteCount).toBe(1);
		expect(manager.state.entries.map((entry) => entry.message)).toEqual([replacement]);

		const forced = register(() => ({ messages: [replacement], fullRewrite: true }));
		await forced({ messages: [replacement] }, { sessionManager: manager });
		expect(manager.rewriteCount).toBe(2);
	});

	it("appends a handoff replacement after a compression boundary without rewriting", async () => {
		const old = { role: "user", content: "old" };
		const manager = hostManager([
			{ type: "message", id: "e1", parentId: null, message: old },
			{ type: "compaction", id: "c1", parentId: "e1" },
		]);
		const doc = { role: "user", content: [{ type: "text", text: "handoff" }] };
		const context = register(() => ({ messages: [doc], handoffReplacement: true }));
		await context({ messages: [old] }, { sessionManager: manager });
		expect(manager.rewriteCount).toBe(0);
		expect(manager.state.entries.some((entry) => entry.type === "compaction")).toBe(true);
		const appends = manager.calls.filter((call) => call.op === "appendMessage");
		expect(appends).toHaveLength(1);
		expect(appends[0].parentId).toBe("c1");
		expect(appends[0].message).toBe(doc);
	});

	it("appends ordinary tail after a compression boundary without rewriting", async () => {
		const kept = { role: "user", content: "kept" };
		const manager = hostManager([
			{ type: "message", id: "e1", parentId: null, message: { role: "user", content: "old" } },
			{ type: "compaction", id: "c1", parentId: "e1" },
			{ type: "message", id: "e2", parentId: "c1", message: kept },
		]);
		const tail = { role: "user", content: "tail" };
		const context = register((event) => ({ messages: [...event.messages, tail] }));
		await context({ messages: [kept] }, { sessionManager: manager });
		expect(manager.rewriteCount).toBe(0);
		const appends = manager.calls.filter((call) => call.op === "appendMessage");
		expect(appends).toHaveLength(1);
		expect(appends[0].parentId).toBe("e2");
	});

	it("returns the transformed messages without a manager", async () => {
		const context = register(() => ({ messages: [{ role: "user", content: "after" }] }));
		const result = await context({ messages: [{ role: "user", content: "before" }] }, {});
		expect(result.messages[0].content).toBe("after");
	});

	it("appends when the host deep-copies messages", async () => {
		const clone = (value) => JSON.parse(JSON.stringify(value));
		const seed = { role: "user", content: "seed" };
		const manager = hostManager([{ type: "message", id: "e1", parentId: null, message: seed }]);
		const doc = { role: "user", content: [{ type: "text", text: "doc" }] };
		let first = true;
		const context = register((event) => {
			if (first) {
				first = false;
				return { messages: [doc] };
			}
			return { messages: event.messages.map(clone) };
		});
		const ctx = { sessionManager: manager };

		await context({ messages: [clone(seed)] }, ctx);
		expect(manager.rewriteCount).toBe(1);

		const after = { role: "assistant", content: [{ type: "text", text: "after" }] };
		await context({ messages: [doc, clone(after)] }, ctx);
		expect(manager.rewriteCount).toBe(1);
		const appends = manager.calls.filter((call) => call.op === "appendMessage");
		expect(appends).toHaveLength(1);
		expect(appends[0].message).toEqual(after);

		await context({ messages: [doc, clone(after)] }, ctx);
		expect(manager.rewriteCount).toBe(1);
		expect(manager.calls.filter((call) => call.op === "appendMessage")).toHaveLength(1);
	});
});

describe("applyHistoryBarrier", () => {
	it("branches to a non-null parent and appends the briefing", () => {
		const manager = hostManager([
			{ type: "message", id: "e1", parentId: null, message: { role: "user", content: "seed" } },
		]);
		expect(applyHistoryBarrier(manager, { parentId: "e1", briefing: "S2" })).toEqual({
			persisted: true,
			branched: true,
			appended: 1,
			via: "branch",
		});
		expect(manager.calls[0]).toEqual({ op: "branch", id: "e1" });
		expect(manager.state.entries[1].message.content[0].text).toBe("S2");
	});

	it("rejects a null parent and missing APIs", () => {
		const manager = hostManager();
		expect(applyHistoryBarrier(manager, { parentId: null, briefing: "x" })).toEqual({
			persisted: false,
			branched: false,
			appended: 0,
			reason: "root-parent",
		});
		expect(applyHistoryBarrier(null, { briefing: "x" })).toEqual({
			persisted: false,
			branched: false,
			appended: 0,
		});
	});
});

describe("context rewrite suppression and trace", () => {
	it("rewrites at most once when the host keeps missing the persisted prefix", async () => {
		const messages = Array.from({ length: 3 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "assistant",
			content: `m${index}`,
			timestamp: 1000 + index,
		}));
		const entries = messages.map((message, index) => ({
			type: "message",
			id: `e${index}`,
			parentId: index === 0 ? null : `e${index - 1}`,
			message,
		}));
		const manager = hostManager(entries);
		let marker = 0;
		const context = register((event) => {
			marker += 1;
			return {
				messages: event.messages.map((message) => ({
					...message,
					timestamp: message.timestamp + marker,
				})),
			};
		});
		const ctx = { sessionManager: manager };
		await context({ messages }, ctx);
		expect(manager.rewriteCount).toBe(1);
		for (let i = 0; i < 2; i += 1) await context({ messages }, ctx);
		expect(manager.rewriteCount).toBe(1);
	});

	it("still rewrites explicit handoff replacements", async () => {
		const manager = hostManager([
			{ type: "message", id: "e1", parentId: null, message: { role: "user", content: "old" } },
		]);
		const doc = { role: "user", content: [{ type: "text", text: "handoff" }] };
		const context = register(() => ({ messages: [doc], handoffReplacement: true }));
		await context({ messages: [{ role: "user", content: "old" }] }, { sessionManager: manager });
		expect(manager.rewriteCount).toBe(1);
		await context({ messages: [{ role: "user", content: "old" }] }, { sessionManager: manager });
		expect(manager.rewriteCount).toBe(2);
	});

	it("writes no trace file when HERD_TRACE is off", async () => {
		const dir = await mkdtemp(join(tmpdir(), "herd-hack-trace-off-"));
		const tracePath = join(dir, "perf-trace.jsonl");
		process.env.HERD_TRACE_PATH = tracePath;
		try {
			const manager = hostManager([
				{ type: "message", id: "e1", parentId: null, message: { role: "user", content: "old" } },
			]);
			const context = register(() => ({ messages: [{ role: "user", content: "new" }] }));
			await context({ messages: [{ role: "user", content: "old" }] }, { sessionManager: manager });
			expect(manager.rewriteCount).toBe(1);
			await flushTrace();
			expect(await stat(tracePath).catch(() => null)).toBeNull();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("records context-rewrite with reason, entries, ms and bytes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "herd-hack-trace-rewrite-"));
		const tracePath = join(dir, "perf-trace.jsonl");
		process.env.HERD_TRACE = "1";
		process.env.HERD_TRACE_PATH = tracePath;
		try {
			const manager = hostManager([
				{ type: "message", id: "e1", parentId: null, message: { role: "user", content: "old" } },
			]);
			const doc = { role: "user", content: [{ type: "text", text: "handoff" }] };
			const context = register(() => ({ messages: [doc], handoffReplacement: true }));
			await context({ messages: [{ role: "user", content: "old" }] }, { sessionManager: manager });
			await flushTrace();
			expect((await readFile(tracePath, "utf8").catch(() => "")).length).toBeGreaterThan(0);
			const lines = (await readFile(tracePath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
			const entry = lines.find((item) => item.event === "context-rewrite");
			expect(entry).toBeTruthy();
			expect(entry.reason).toBe("handoff-replacement");
			expect(entry.entries).toBe(1);
			expect(entry.ms).toBeGreaterThanOrEqual(0);
			expect(entry.messagesBytes).toBeGreaterThan(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("records context-append with appended count", async () => {
		const dir = await mkdtemp(join(tmpdir(), "herd-hack-trace-append-"));
		const tracePath = join(dir, "perf-trace.jsonl");
		process.env.HERD_TRACE = "1";
		process.env.HERD_TRACE_PATH = tracePath;
		try {
			const seed = { role: "user", content: "seed" };
			const manager = hostManager([{ type: "message", id: "e1", parentId: null, message: seed }]);
			const tail = { role: "assistant", content: "tail" };
			const context = register((event) => ({ messages: [...event.messages, tail] }));
			await context({ messages: [seed] }, { sessionManager: manager });
			await flushTrace();
			expect((await readFile(tracePath, "utf8").catch(() => "")).length).toBeGreaterThan(0);
			const lines = (await readFile(tracePath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
			const entry = lines.find((item) => item.event === "context-append");
			expect(entry).toBeTruthy();
			expect(entry.appended).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});