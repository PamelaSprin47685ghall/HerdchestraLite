import { beforeAll, describe, expect, it } from "bun:test";
import * as nbb from "nbb";
import { hackContext } from "../src/host/hack-context.mjs";
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

	it("queues v9 and cuts to the document", async () => {
		const ctx = { agent: { id: "handoff-s1" } };
		const receipt = queue("[u0⯮u0]", "call-h1", ctx);
		expect(receipt.content[0].text).toContain("handoff-boundary-v9");
		const messages = [
			{ role: "user", content: "u0" },
			{ role: "assistant", toolCallId: "call-h1", content: "x" },
			{ role: "toolResult", toolCallId: "call-h1", toolName: "handoff", content: [{ type: "text", text: "queued" }] },
		];
		const result = await handler()({ messages }, ctx);
		expect(result.messages).toHaveLength(2);
		const text = result.messages[0].content[0].text;
		expect(text.startsWith("You are the successor of the previous AI.")).toBe(true);
		expect(text).toContain("u0");
		const again = await handler()({ messages }, ctx);
		expect(JSON.stringify(again.messages[0])).toBe(JSON.stringify(result.messages[0]));
	});

	it("excludes the handoff call and its result from the dictionary", async () => {
		const ctx = { agent: { id: "handoff-s2" } };
		queue("[handing off⯮handing off]", "call-h2", ctx);
		const messages = [
			{ role: "user", content: "u0" },
			{ role: "assistant", toolCallId: "call-h2", content: "x" },
			{ role: "toolResult", toolCallId: "call-h2", toolName: "handoff", content: [{ type: "text", text: "queued" }] },
		];
		const result = await handler()({ messages }, ctx);
		expect(result.messages[0].content[0].text).toContain("[handing off⯮handing off]");
	});

	it("excludes OpenAI-style tool_calls and their result", async () => {
		const ctx = { agent: { id: "handoff-s4" } };
		queue("[u0⯮u0]", "call-h4", ctx);
		const messages = [
			{ role: "user", content: "u0" },
			{
				role: "assistant",
				content: "call-text",
				tool_calls: [{ id: "call-h4", type: "function", function: { name: "handoff", arguments: "{}" } }],
			},
			{ role: "tool", tool_call_id: "call-h4", name: "handoff", content: "RESULT" },
		];
		const result = await handler()({ messages }, ctx);
		const text = result.messages[0].content[0].text;
		expect(text).toContain("u0");
		expect(text).not.toContain("call-text");
	});

	it("includes prior tool_call arguments in the dictionary", async () => {
		const ctx = { agent: { id: "handoff-s5" } };
		queue("[PRIOR⯮PRIOR]", "call-h5", ctx);
		const messages = [
			{
				role: "assistant",
				content: "",
				tool_calls: [{ id: "old", type: "function", function: { name: "clj_devops", arguments: '{"k":"PRIOR"}' } }],
			},
			{
				role: "assistant",
				content: "x",
				tool_calls: [{ id: "call-h5", type: "function", function: { name: "handoff", arguments: "{}" } }],
			},
		];
		const result = await handler()({ messages }, ctx);
		const text = result.messages[0].content[0].text;
		expect(text).toContain("PRIOR");
		expect(text).not.toContain("[PRIOR⯮PRIOR]");
	});

	it("keeps the cut sticky and preserves messages after the handoff", async () => {
		const ctx = { agent: { id: "handoff-s9" } };
		queue("[u0⯮u0]", "call-h9", ctx);
		const messages = [
			{ role: "user", content: "u0" },
			{ role: "assistant", toolCallId: "call-h9", content: "x" },
			{ role: "toolResult", toolCallId: "call-h9", toolName: "handoff", content: [{ type: "text", text: "queued" }] },
		];
		await handler()({ messages }, ctx);
		const next = messages.concat([
			{ role: "assistant", content: [{ type: "text", text: "after" }] },
			{ role: "user", content: "new" },
		]);
		const second = await handler()({ messages: next }, ctx);
		expect(second.messages).toHaveLength(4);
		expect(second.messages[1].content[0].text).toBe("after");
		expect(second.messages[2].content).toBe("new");
	});

	it("cuts from the persisted document after a restart", async () => {
		const source = { agent: { id: "handoff-s10a" } };
		queue("persisted", "call-h10a", source);
		const sourceMessages = [
			{ role: "user", content: "old" },
			{ role: "assistant", toolCallId: "call-h10a", content: "x" },
			{ role: "toolResult", toolCallId: "call-h10a", toolName: "handoff", content: [{ type: "text", text: "queued" }] },
		];
		const first = await handler()({ messages: sourceMessages }, source);
		const doc = first.messages[0];
		const restarted = { agent: { id: "handoff-s10b" } };
		const after = await handler()(
			{
				messages: [
					{ role: "user", content: "old" },
					doc,
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			},
			restarted,
		);
		expect(after.messages).toHaveLength(3);
		expect(after.messages[1].content[0].text).toBe("ok");
	});
});
