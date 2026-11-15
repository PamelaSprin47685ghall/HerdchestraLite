import { beforeAll, describe, expect, it } from "bun:test";
import * as nbb from "nbb";
import { hackContext } from "../src/bridge/hack-context.mjs";
import { ensureActivated } from "./helpers/nbb-boot.mjs";

let localPi;

beforeAll(async () => {
	localPi = {
		tools: new Map(),
		hooks: new Map(),
		active: [],
		registerTool(definition) {
			this.tools.set(definition.name, definition);
		},
		on(name, handler) {
			this.hooks.set(name, handler);
		},
		getActiveTools() {
			return [...this.active];
		},
		setActiveTools(next) {
			this.active = [...next];
		},
	};
	globalThis.__pi = localPi;
	await ensureActivated();
	const handler = await nbb.loadString("herd.main/context-handler");
	hackContext(localPi, (event, ctx) => handler(event, ctx));
});

const clj = (form) => nbb.loadString(form);

describe("two-anchor decoder", async () => {
	it("selects the first AAA to the last BBB", async () => {
		await clj("(require '[herd.handoff :as h])");
		expect(await clj('(h/decode "[a⯮b]" "Q a 1 b Z")')).toBe("a 1 b");
	});

	it("keeps malformed and unresolved refs literal", async () => {
		expect(await clj('(h/decode "[nope⯮zzz]" "Q a b Z")')).toBe("[nope⯮zzz]");
		expect(await clj('(h/decode "[a⯮b" "Q a b Z")')).toBe("[a⯮b");
		expect(await clj('(h/decode "[⯮b]" "Q a b Z")')).toBe("[⯮b]");
	});

	it("keeps non-unique anchors literal", async () => {
		expect(await clj('(h/decode "[a⯮b]" "a 1 a 2 b 3 b")')).toBe("[a⯮b]");
	});

	it("emits each dictionary range once", async () => {
		expect(await clj('(h/decode "[A⯮B][B⯮C]" "A B C")')).toBe("A B C");
		expect(await clj('(h/decode "[A⯮C][A⯮C]" "A B C")')).toBe("A B C");
	});

	it("degrades to literal when the arrow is not a ref", async () => {
		expect(await clj('(h/decode "plain ⯮ text" "A B C")')).toBe("plain ⯮ text");
	});
});

describe("handoff tool", async () => {
	const handler = () => localPi.hooks.get("context");
	const queue = (markdown, toolCallId, ctx) =>
		localPi.tools.get("handoff").execute(toolCallId, { markdown }, null, null, ctx);
	const makeCtx = () => {
		const appended = [];
		const ctx = {
			agent: { id: "handoff-v10" },
			sessionManager: {
				getEntries: () => [{ id: "entry-1" }],
				appendCompaction: (...args) => {
					appended.push(args);
					return "compaction-1";
				},
			},
		};
		return { ctx, appended };
	};

	it("appends a compaction entry and does not rewrite history", async () => {
		const { ctx, appended } = makeCtx();
		const receipt = queue("[u0⯮u0]", "call-h1", ctx);
		const text = receipt.content[0].text;
		expect(text).toContain("handoff-boundary-v10");
		expect(text).toContain(":committed true");
		expect(appended).toHaveLength(1);
		expect(String(appended[0][0])).toContain("u0");
		const messages = [
			{ role: "user", content: "u0" },
			{ role: "assistant", toolCallId: "call-h1", content: "x" },
		];
		const result = await handler()({ messages }, { agent: { id: "handoff-v10" } });
		expect(result.messages).toHaveLength(messages.length + 1);
		expect(result.messages[0].content).toBe("u0");
		expect(result.handoffReplacement).toBeUndefined();
	});

	it("does not cut from a persisted document after restart", async () => {
		const { ctx } = makeCtx();
		queue("persisted", "call-h2", ctx);
		const messages = [
			{ role: "user", content: "old" },
			{ role: "assistant", content: "ok" },
		];
		const result = await handler()({ messages }, { agent: { id: "handoff-v10b" } });
		expect(result.messages).toHaveLength(messages.length + 1);
		expect(result.messages[0].content).toBe("old");
		expect(result.messages[1].content).toBe("ok");
	});
});
