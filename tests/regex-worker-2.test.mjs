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

describe("regex worker semantics shard 2", () => {
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

		it("uses UTF-16 offsets and supports flags", async () => {
		expect(await reFind(/😀/u, "a😀b")).toBe("😀");
		expect(await replaceMatches("a😀b", /😀/u)).toEqual([{ index: 1, end: 3, value: "😀" }]);
		expect(await reFind(/^b/im, "a\nb")).toBe("b");
		expect(await reMatches(/a.b/s, "a\nb")).toBe("a\nb");
		expect(await reFind(/a/i, "A")).toBe("A");
		expect(await reFind(/(\w)\1/, "abba")).toEqual(["bb", "b"]);
		expect(await reFind(/(?<=a)b/, "ab")).toBe("b");
	});

		it("terminates a catastrophic regex at its deadline", async () => {
		const started = Date.now();
		const error = await rejection(reFind(CATASTROPHIC, CATASTROPHIC_TEXT, { timeoutMs: 50 }));
		expect(error.code).toBe(":UPSTREAM_ABORTED");
		expect(error.reason).toBe("deadline");
		expect(Date.now() - started).toBeLessThan(3000);
		expect(await reFind(/ok/, "ok")).toBe("ok");
	});
});
