import { describe, expect, it } from "bun:test";
import {
	compileClojurePattern,
	reFind,
	reMatches,
	replaceMatches,
	reSeq,
	reSeqStep,
	runRegexTask,
	stringReplace,
} from "../src/clj-sandbox/regex-worker.mjs";

async function rejection(promise) {
	let error;
	try {
		await promise;
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(Error);
	return error;
}

async function replaceWith(text, pattern, replacement, firstOnly = false) {
	const matches = await replaceMatches(text, pattern, firstOnly);
	const parts = [];
	let cursor = 0;
	for (const match of matches) {
		parts.push(text.slice(cursor, match.index), replacement(match.value));
		cursor = match.end;
	}
	parts.push(text.slice(cursor));
	return parts.join("");
}

const CATASTROPHIC = /(a+)+$/;
const CATASTROPHIC_TEXT = `${"a".repeat(30000)}!`;

describe("regex worker semantics shard 1", () => {
	it("returns Clojure re-find and re-matches values", async () => {
		expect(await reFind(/a+/, "caat")).toBe("aa");
		expect(await reFind(/z+/, "caat")).toBeNull();
		expect(await reFind(/(a+)(b+)?/, "caat")).toEqual(["aa", "aa", null]);
		expect(await reMatches(/(a+)(b+)/, "aaabbb")).toEqual(["aaabbb", "aaa", "bbb"]);
		expect(await reMatches(/a+/, "caat")).toBeNull();
		expect(await reMatches(/(a)?b/, "b")).toEqual(["b", null]);
	});

		it("returns regex replacement spans and Clojure replacement arguments", async () => {
		expect(await replaceMatches("a1b2", /[0-9]/)).toEqual([
			{ index: 1, end: 2, value: "1" },
			{ index: 3, end: 4, value: "2" },
		]);
		expect(await replaceMatches("a1b2", /([0-9])/)).toEqual([
			{ index: 1, end: 2, value: ["1", "1"] },
			{ index: 3, end: 4, value: ["2", "2"] },
		]);
		expect(await replaceMatches("a1b2", /[0-9]/, true)).toEqual([{ index: 1, end: 2, value: "1" }]);
		expect(await replaceMatches("a1b2", /[0-9]/g, true)).toEqual([{ index: 1, end: 2, value: "1" }]);
	});

		it("matches Cherry clojure.string replacement with a string", async () => {
		expect(await stringReplace("a1b2", /[0-9]/, "#")).toBe("a#b#");
		expect(await stringReplace("a1b2", /([0-9])/, "[$1]")).toBe("a[1]b[2]");
		expect(await stringReplace("a1b2", /[0-9]/, "$$")).toBe("a$b$");
		expect(await stringReplace("a1b2", /[0-9]/, "<$&>")).toBe("a<1>b<2>");
		expect(await stringReplace("a1b2", /[0-9]/, "#", true)).toBe("a#b2");
		expect(await stringReplace("a1b2", /[0-9]/g, "#", true)).toBe("a#b#");
		expect(await stringReplace("a\nb", /a.b/s, "#")).toBe("a\nb");
		expect(await stringReplace("a.b", ".", "#")).toBe("a#b");
		expect(await stringReplace("a\x08b", "\x08", "#")).toBe("a#b");
		expect(await stringReplace("a-b", "-", "+")).toBe("a+b");
		expect(await stringReplace("a-b", "-", "+", true)).toBe("a+b");
		expect(await stringReplace("", /(?:)/, "-")).toBe("-");
	});

		it("rejects invalid protocol requests without inventing a result", async () => {
		const error = await rejection(runRegexTask({ op: "find", pattern: { source: "a" }, text: 42 }));
		expect(error.code).toBe(":INVALID_ARGUMENT");
		expect(error.reason).toBe("invalid");
	});

		it("honours an absolute deadline and a pre-aborted signal", async () => {
		const expired = await rejection(reFind(/a/, "a", { deadlineAt: Date.now() - 1 }));
		expect(expired.reason).toBe("deadline");
		const controller = new AbortController();
		controller.abort();
		const aborted = await rejection(reFind(/a/, "a", { signal: controller.signal }));
		expect(aborted.reason).toBe("abort");
	});
});
