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

describe("regex worker semantics", () => {
	it("returns Clojure re-find and re-matches values", async () => {
		expect(await reFind(/a+/, "caat")).toBe("aa");
		expect(await reFind(/z+/, "caat")).toBeNull();
		expect(await reFind(/(a+)(b+)?/, "caat")).toEqual(["aa", "aa", null]);
		expect(await reMatches(/(a+)(b+)/, "aaabbb")).toEqual(["aaabbb", "aaa", "bbb"]);
		expect(await reMatches(/a+/, "caat")).toBeNull();
		expect(await reMatches(/(a)?b/, "b")).toEqual(["b", null]);
	});

	it("matches Cherry re-seq for anchors, flags, and trailing empty matches", async () => {
		expect(await reSeq(/a/, "aaa")).toEqual(["a", "a", "a"]);
		expect(await reSeq(/a*/, "ba")).toEqual(["", "a", ""]);
		expect(await reSeq(/a*/g, "ba")).toEqual(["", "a"]);
		expect(await reSeq(/(?:)/, "ab")).toEqual(["", "", ""]);
		expect(await reSeq(/(?=a)/g, "aa")).toEqual(["", ""]);
		expect(await reSeq(/^a/, "aaa")).toEqual(["a", "a", "a"]);
		expect(await reSeq(/^a/g, "aaa")).toEqual(["a"]);
		expect(await reSeq(/a|/, "ab")).toEqual(["a", "", ""]);
		expect(await reSeq(/a|/g, "ab")).toEqual(["a", ""]);
		expect(await reSeq(/$/, "ab")).toEqual([""]);
		expect(await reSeq(/$/g, "ab")).toEqual([""]);
	});

	it("steps re-seq with the same lastIndex and empty-match behavior", async () => {
		const stepAll = async (pattern, text) => {
			let state = { offset: 0, rest: text, lastIndex: 0 };
			const values = [];
			for (;;) {
				const step = await reSeqStep(pattern, state.rest, state);
				if (step.match !== null) {
					values.push(step.match.value);
				}
				if (step.done) {
					break;
				}
				state = step.next;
			}
			return values;
		};
		for (const [pattern, text] of [
			[/a/, "aaa"],
			[/a/g, "aaa"],
			[/a*/, "ba"],
			[/a*/g, "ba"],
			[/(?:)/, "ab"],
			[/^a/, "aaa"],
			[/^a/g, "aaa"],
			[/a|/, "ab"],
			[/a|/g, "ab"],
			[/$/, "ab"],
		]) {
			expect(await stepAll(pattern, text)).toEqual(await reSeq(pattern, text));
		}
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

	it("returns literal replacement spans, including empty patterns", async () => {
		expect(await replaceMatches("a-b", "-")).toEqual([{ index: 1, end: 2, value: "-" }]);
		expect(await replaceMatches("abc", "", false)).toEqual([
			{ index: 0, end: 0, value: "" },
			{ index: 1, end: 1, value: "" },
			{ index: 2, end: 2, value: "" },
			{ index: 3, end: 3, value: "" },
		]);
		expect(await replaceMatches("abc", "", true)).toEqual([{ index: 0, end: 0, value: "" }]);
	});

	it("rebuilds the evaluator's replacement results from spans", async () => {
		const angle = (value) => `<${value}>`;
		expect(await replaceWith("a1b2", /[0-9]/, angle)).toBe("a<1>b<2>");
		expect(await replaceWith("a1b2", /[0-9]/, () => "#", true)).toBe("a#b2");
		expect(await replaceWith("a-b", "-", () => "+")).toBe("a+b");
		expect(await replaceWith("a1b2", /([0-9])/, (value) => `${value[1]}!`)).toBe("a1!b2!");
		expect(await replaceWith("abc", "", () => "-")).toBe("-a-b-c-");
		expect(await replaceWith("abc", "", () => "-", true)).toBe("-abc");
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

	it("uses UTF-16 offsets and supports flags", async () => {
		expect(await reFind(/😀/u, "a😀b")).toBe("😀");
		expect(await replaceMatches("a😀b", /😀/u)).toEqual([{ index: 1, end: 3, value: "😀" }]);
		expect(await reFind(/^b/im, "a\nb")).toBe("b");
		expect(await reMatches(/a.b/s, "a\nb")).toBe("a\nb");
		expect(await reFind(/a/i, "A")).toBe("A");
		expect(await reFind(/(\w)\1/, "abba")).toEqual(["bb", "b"]);
		expect(await reFind(/(?<=a)b/, "ab")).toBe("b");
	});

	it("compiles Clojure re-pattern strings with leading flags", async () => {
		const compiled = await runRegexTask({ op: "pattern", pattern: "(?im)^a+$" });
		expect(compiled).toEqual({ source: "^a+$", flags: "im" });
		expect(compileClojurePattern("(?i)a+").source).toBe("a+");
		expect(compileClojurePattern("(?i)a+").flags).toBe("i");
		const error = await rejection(runRegexTask({ op: "pattern", pattern: "(" }));
		expect(error.code).toBe(":INVALID_ARGUMENT");
		expect(error.reason).toBe("pattern");
	});

	it("rejects invalid protocol requests without inventing a result", async () => {
		const error = await rejection(runRegexTask({ op: "find", pattern: { source: "a" }, text: 42 }));
		expect(error.code).toBe(":INVALID_ARGUMENT");
		expect(error.reason).toBe("invalid");
	});

	it("terminates a catastrophic regex at its deadline", async () => {
		const started = Date.now();
		const error = await rejection(reFind(CATASTROPHIC, CATASTROPHIC_TEXT, { timeoutMs: 50 }));
		expect(error.code).toBe(":UPSTREAM_ABORTED");
		expect(error.reason).toBe("deadline");
		expect(Date.now() - started).toBeLessThan(3000);
		expect(await reFind(/ok/, "ok")).toBe("ok");
	});

	it("terminates a catastrophic regex when the signal aborts", async () => {
		const controller = new AbortController();
		const pending = reFind(CATASTROPHIC, CATASTROPHIC_TEXT, { signal: controller.signal });
		setTimeout(() => controller.abort("operator"), 25);
		const error = await rejection(pending);
		expect(error.code).toBe(":UPSTREAM_ABORTED");
		expect(error.reason).toBe("abort");
		expect(await reFind(/after/, "after")).toBe("after");
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
