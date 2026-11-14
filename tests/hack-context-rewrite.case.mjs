import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushTrace, hackContext } from "../src/host/hack-context.mjs";

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
		header: { runtime: { version: "test" } },
		entries: entries.map((entry) => ({ ...entry })),
	};
	let rewrites = 0;
	return {
		state,
		get rewriteCount() {
			return rewrites;
		},
		captureState() {
			return { ...state, entries: [...state.entries] };
		},
		restoreState(next) {
			state.header = next.header;
			state.entries = next.entries;
		},
		rewriteEntries() {
			rewrites += 1;
			return Promise.resolve();
		},
		branch() {},
		appendMessage(message) {
			const parentId = state.entries.length ? state.entries[state.entries.length - 1].id : null;
			const id = `e${state.entries.length + 1}-${parentId ?? "root"}`;
			state.entries.push({ type: "message", id, parentId, message });
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
	};
}

function register(handler) {
	const handlers = new Map();
	hackContext({ on: (name, fn) => handlers.set(name, fn) }, handler);
	return handlers.get("context");
}

function entriesOf(messages) {
	return messages.map((message, index) => ({
		type: "message",
		id: `s${index}`,
		parentId: index === 0 ? null : `s${index - 1}`,
		message,
	}));
}

describe("context trace", () => {
	it("records suppressed misses with the miss count", async () => {
		const dir = await mkdtemp(join(tmpdir(), "herd-hack-suppressed-"));
		const tracePath = join(dir, "perf-trace.jsonl");
		process.env.HERD_TRACE = "1";
		process.env.HERD_TRACE_PATH = tracePath;
		try {
			const manager = hostManager(entriesOf([{ role: "user", content: "old" }]));
			let round = 0;
			const context = register(() => {
				round += 1;
				return { messages: [{ role: "user", content: `x-${round}` }] };
			});
			const ctx = { sessionManager: manager };
			await context({ messages: [] }, ctx);
			await context({ messages: [] }, ctx);
			await flushTrace();
			const lines = (await readFile(tracePath, "utf8"))
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line));
			const suppressed = lines.find((item) => item.event === "context-prefix-miss-suppressed");
			expect(suppressed).toBeTruthy();
			expect(suppressed.misses).toBe(2);
			expect(suppressed.messages).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("writes no trace when HERD_TRACE is off", async () => {
		const dir = await mkdtemp(join(tmpdir(), "herd-hack-off-"));
		const tracePath = join(dir, "perf-trace.jsonl");
		process.env.HERD_TRACE_PATH = tracePath;
		try {
			const manager = hostManager(entriesOf([{ role: "user", content: "old" }]));
			const context = register(() => ({ messages: [{ role: "user", content: "new" }] }));
			await context({ messages: [] }, { sessionManager: manager });
			await flushTrace();
			expect(await readFile(tracePath, "utf8").catch(() => null)).toBeNull();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
