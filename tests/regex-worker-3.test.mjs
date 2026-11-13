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

describe("regex worker semantics shard 3", () => {
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

		it("rebuilds the evaluator's replacement results from spans", async () => {
		const angle = (value) => `<${value}>`;
		expect(await replaceWith("a1b2", /[0-9]/, angle)).toBe("a<1>b<2>");
		expect(await replaceWith("a1b2", /[0-9]/, () => "#", true)).toBe("a#b2");
		expect(await replaceWith("a-b", "-", () => "+")).toBe("a+b");
		expect(await replaceWith("a1b2", /([0-9])/, (value) => `${value[1]}!`)).toBe("a1!b2!");
		expect(await replaceWith("abc", "", () => "-")).toBe("-a-b-c-");
		expect(await replaceWith("abc", "", () => "-", true)).toBe("-abc");
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

		it("terminates a catastrophic regex when the signal aborts", async () => {
		const controller = new AbortController();
		const pending = reFind(CATASTROPHIC, CATASTROPHIC_TEXT, { signal: controller.signal });
		setTimeout(() => controller.abort("operator"), 25);
		const error = await rejection(pending);
		expect(error.code).toBe(":UPSTREAM_ABORTED");
		expect(error.reason).toBe("abort");
		expect(await reFind(/after/, "after")).toBe("after");
	});
});
