import { describe, expect, it } from "bun:test";
import { awaitSuspends } from "../src/clj-sandbox/await-suspends.mjs";

const expand = (source) => awaitSuspends(source).source;

describe("expandAwaitMacros", () => {
	it("wraps suspend forms in js/await", () => {
		expect(expand("(park 1)")).toBe("(js/await (sandbox/park 1))");
		expect(expand("(where {:content x :needle y})")).toBe(
			"(js/await (sandbox/where {:content x :needle y}))",
		);
	});

	it("expands nested and surrounding forms", () => {
		expect(expand("(+ 1 (park 2))")).toBe("(+ 1 (js/await (sandbox/park 2)))");
	});

	it("does not touch strings, comments, or qualified names", () => {
		expect(expand('"(park 1)"')).toBe('"(park 1)"');
		expect(expand("; (park 1)\n(+ 1 1)")).toBe("; (park 1)\n(+ 1 1)");
		expect(expand("(sandbox/park 1)")).toBe("(sandbox/park 1)");
	});

	it("is idempotent for already-awaited forms", () => {
		const once = expand("(park 1)");
		expect(expand(once)).toBe(once);
	});
});
