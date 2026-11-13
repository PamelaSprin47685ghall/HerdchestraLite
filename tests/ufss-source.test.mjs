import { describe, expect, it } from "bun:test";
import { mapRewrittenOffset, ufssToCljs } from "../src/clj-sandbox/ufss-source.mjs";

describe("ufssToCljs", () => {
	it("rewrites fences into standard strings", () => {
		expect(ufssToCljs('(count ##"abc"##)').source).toBe('(count "abc")');
		const block = ufssToCljs('##"""\nline "quoted"\n"""##').source;
		expect(block).toBe('"line \\"quoted\\""');
	});

	it("leaves every official dispatch byte for byte", () => {
		const source = '(#(+ % 1) #_2 #?(:cljs 7) #:ns{:a 1} #\'x #"re" #{1} ##Inf)';
		expect(ufssToCljs(source).source).toBe(source);
	});

	it("does not rewrite inside strings, comments, or character literals", () => {
		const source = '"##\\"keep\\"##" ; ##"comment"##\n\\#';
		expect(ufssToCljs(source).source).toBe(source);
	});

	it("maps rewritten offsets back to the original fence start", () => {
		const { source, segments } = ufssToCljs('##"abc"## x');
		expect(source).toBe('"abc" x');
		expect(segments).toHaveLength(1);
		expect(mapRewrittenOffset(segments, 0)).toBe(0);
		expect(mapRewrittenOffset(segments, 1)).toBe(0);
		expect(mapRewrittenOffset(segments, 5)).toBe(9);
		expect(mapRewrittenOffset(segments, 6)).toBe(10);
	});
});
