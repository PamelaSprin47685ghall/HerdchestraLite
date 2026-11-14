import { describe, expect, test } from "bun:test";
import {
	hackSystemPrompt,
	injectSystemPromptBlock,
	SYSTEM_PROMPT_BLOCK_END,
	SYSTEM_PROMPT_BLOCK_START,
	stripSystemPromptBlock,
} from "../src/host/hack-system-prompt.mjs";
import { readHealth } from "../src/host/health.mjs";

const START = SYSTEM_PROMPT_BLOCK_START;
const END = SYSTEM_PROMPT_BLOCK_END;

function countMarkers(text) {
	return (text.match(/herdchestra:system-prompt v1/g) ?? []).length;
}

function fakePi() {
	const hooks = {};
	return {
		hooks,
		on(name, handler) {
			hooks[name] = handler;
		},
	};
}

describe("injectSystemPromptBlock", () => {
	test("appends one managed region to a host string", () => {
		const once = injectSystemPromptBlock("HOST PROMPT", "BODY");
		expect(once).toBe(`HOST PROMPT\n\n${START}\nBODY\n${END}`);
		expect(countMarkers(once)).toBe(1);
	});

	test("re-injection replaces the region instead of stacking", () => {
		const once = injectSystemPromptBlock("HOST", "BODY");
		const twice = injectSystemPromptBlock(once, "REPLACEMENT");
		expect(twice).toBe(injectSystemPromptBlock("HOST", "REPLACEMENT"));
		expect(twice).toContain("REPLACEMENT");
		expect(twice).not.toContain("BODY");
		expect(countMarkers(twice)).toBe(1);
	});

	test("handles an empty host prompt", () => {
		expect(injectSystemPromptBlock("", "BODY")).toBe(`${START}\nBODY\n${END}`);
	});

	test("appends a text block to a content-block array", () => {
		const base = [{ type: "text", text: "HOST" }];
		const once = injectSystemPromptBlock(base, "BODY");
		expect(once).toHaveLength(2);
		expect(once[1]).toEqual({ type: "text", text: `${START}\nBODY\n${END}` });
		expect(base).toHaveLength(1);
	});

	test("appends a string to a string[] host prompt without creating objects", () => {
		const base = ["HOST PROMPT"];
		const once = injectSystemPromptBlock(base, "BODY");
		expect(once).toHaveLength(2);
		expect(typeof once[0]).toBe("string");
		expect(typeof once[1]).toBe("string");
		expect(once[1]).toBe(`${START}\nBODY\n${END}`);
		expect(countMarkers(once[1])).toBe(1);

		const twice = injectSystemPromptBlock(once, "REPLACEMENT");
		expect(twice).toHaveLength(2);
		expect(typeof twice[1]).toBe("string");
		expect(twice[1]).toContain("REPLACEMENT");
	});

	test("replaces the region inside an array without growing it", () => {
		const once = injectSystemPromptBlock([{ type: "text", text: "HOST" }], "BODY");
		const twice = injectSystemPromptBlock(once, "REPLACEMENT");
		expect(twice).toHaveLength(2);
		expect(twice[1].text).toContain("REPLACEMENT");
		expect(twice[1].text).not.toContain("BODY");
		expect(countMarkers(twice[1].text)).toBe(1);
	});

	test("ignores an empty block", () => {
		expect(injectSystemPromptBlock("HOST", "  ")).toBe("HOST");
	});
});

describe("stripSystemPromptBlock", () => {
	test("restores a string host prompt", () => {
		const once = injectSystemPromptBlock("HOST", "BODY");
		expect(stripSystemPromptBlock(once)).toBe("HOST");
	});

	test("removes the managed text block from an array", () => {
		const once = injectSystemPromptBlock([{ type: "text", text: "HOST" }], "BODY");
		expect(stripSystemPromptBlock(once)).toEqual([{ type: "text", text: "HOST" }]);
	});

	test("removes the managed string block from a string[]", () => {
		const once = injectSystemPromptBlock(["HOST"], "BODY");
		expect(stripSystemPromptBlock(once)).toEqual(["HOST"]);
	});
});

describe("hackSystemPrompt", () => {
	test("injects the block while keeping handler side effects", async () => {
		const pi = fakePi();
		let calls = 0;
		const result = hackSystemPrompt(
			pi,
			async () => {
				calls += 1;
			},
			{ block: "BODY", entry: "test.systemPrompt" },
		);
		expect(result.ok).toBe(true);
		const out = await pi.hooks.before_agent_start({ systemPrompt: "HOST" }, {});
		expect(calls).toBe(1);
		expect(out.systemPrompt).toContain("HOST");
		expect(out.systemPrompt).toContain("BODY");
		expect(countMarkers(out.systemPrompt)).toBe(1);
	});

	test("stays idempotent across repeated starts", async () => {
		const pi = fakePi();
		hackSystemPrompt(pi, async () => {}, { block: "BODY", entry: "test.systemPrompt" });
		const first = await pi.hooks.before_agent_start({ systemPrompt: "HOST" }, {});
		const second = await pi.hooks.before_agent_start(first, {});
		expect(second.systemPrompt).toBe(first.systemPrompt);
		expect(countMarkers(second.systemPrompt)).toBe(1);
	});

	test("fails open with the original prompt when the handler throws", async () => {
		const pi = fakePi();
		hackSystemPrompt(
			pi,
			async () => {
				throw new Error("boom");
			},
			{ block: "BODY", entry: "test.systemPrompt.failopen" },
		);
		const out = await pi.hooks.before_agent_start({ systemPrompt: "HOST" }, {});
		expect(out).toEqual({ systemPrompt: "HOST" });
		const entry = readHealth().entries.find((item) => item.entry === "test.systemPrompt.failopen");
		expect(entry?.status).toBe("degraded");
	});

	test("reports a missing host hook without throwing", () => {
		const result = hackSystemPrompt({}, async () => {});
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":HOST_API_MISMATCH");
	});
});
