import { describe, expect, it } from "bun:test";
import { EdnKeyword, EdnList, EdnSymbol, printUfss, readUfss, renderReceipt } from "../src/clj-sandbox/ufss.mjs";
import { findAll, findUnique } from "../src/clj-sandbox/where.mjs";

function catchError(run) {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw");
}

function keywordValue(map, name) {
	for (const [key, value] of map) {
		if (key instanceof EdnKeyword && key.name === name) {
			return value;
		}
	}
	return undefined;
}

describe("readUfss", () => {
	it("reads the EDN subset and UFSS string forms", () => {
		const source = [
			"; a leading comment",
			'{:name "fix",',
			" :state :parked",
			" :numbers [1 -2 3.5 1e3 4N]",
			" :flags [true false nil]",
			" :tags #{:a :b}",
			' :form (cat {:path "x"})',
			" :sym foo/bar",
			' :path #"C:\\workspace\\x"#',
			' :block #"""',
			"   line one",
			"     indented",
			'   """#',
			' :after "ok"}',
		].join("\n");

		const value = readUfss(source);

		expect(value instanceof Map).toBe(true);
		expect(keywordValue(value, "name")).toBe("fix");
		expect(keywordValue(value, "numbers")).toEqual([1, -2, 3.5, 1000, 4n]);
		expect(keywordValue(value, "flags")).toEqual([true, false, null]);
		expect(keywordValue(value, "path")).toBe("C:\\workspace\\x");
		expect(keywordValue(value, "block")).toBe("line one\n  indented");
		expect(keywordValue(value, "after")).toBe("ok");

		const form = keywordValue(value, "form");
		expect(form instanceof EdnList).toBe(true);
		expect(form[0] instanceof EdnSymbol).toBe(true);
		expect(form[0].name).toBe("cat");
		expect(form[1] instanceof Map).toBe(true);
	});

	it("reads a bare triple-quote block and restores a trailing newline", () => {
		expect(readUfss('"""\nline\n\n"""')).toBe("line\n");
	});

	it("treats commas, comments, and discard forms as ignored syntax", () => {
		expect(readUfss("; c\n [1, #_ 2 3]")).toEqual([1, 3]);
		expect(readUfss("#_ 1 2")).toBe(2);
	});

	it("reports an unclosed raw string", () => {
		const error = catchError(() => readUfss('#"abc'));
		expect(error.code).toBe(":UFSS_UNCLOSED");
		expect(error.line).toBe(1);
		expect(error.column).toBe(1);
	});

	it("reports an unclosed raw block", () => {
		const error = catchError(() => readUfss('#"""\nabc\n'));
		expect(error.code).toBe(":UFSS_UNCLOSED");
	});

	it("reports an indent violation with its position", () => {
		const error = catchError(() => readUfss('#"""\n  ok\n bad\n  """#'));
		expect(error.code).toBe(":UFSS_INDENT_VIOLATION");
		expect(error.line).toBe(3);
		expect(error.data.expectedIndent).toBe(2);
		expect(error.data.actualIndent).toBe(1);
	});

	it("rejects raw control characters", () => {
		expect(catchError(() => readUfss('"a\u0000b"')).code).toBe(":INVALID_ARGUMENT");
		expect(catchError(() => readUfss('#"a\u0000b"#')).code).toBe(":INVALID_ARGUMENT");
		expect(catchError(() => readUfss('"""\na\u0000b\n"""')).code).toBe(":INVALID_ARGUMENT");
	});

	it("rejects trailing data and malformed maps", () => {
		expect(catchError(() => readUfss("1 2")).code).toBe(":INVALID_ARGUMENT");
		expect(catchError(() => readUfss("{:a}")).code).toBe(":INVALID_ARGUMENT");
	});
});

describe("printUfss", () => {
	it("uses standard escapes for invisible controls", () => {
		expect(printUfss("\r")).toBe('"\\r"');
		expect(printUfss("\u0000")).toBe('"\\u0000"');
	});

	it("promotes the fence until the single-line raw delimiter is absent", () => {
		expect(printUfss('a"b')).toBe('#"a"b"#');
		expect(printUfss('a"#b')).toBe('##"a"#b"##');
		expect(printUfss("a\\b")).toBe('#"a\\b"#');
	});

	it("uses bare blocks when the body cannot close them early", () => {
		expect(printUfss("a\nb")).toBe('"""\na\nb\n"""');
		expect(printUfss("a\n")).toBe('"""\na\n\n"""');
	});

	it("prefixes every non-empty block line with the current indent", () => {
		expect(printUfss("a\nb", { indent: 2 })).toBe('"""\n  a\n  b\n  """');
		expect(printUfss("a\n\nb", { indent: 1 })).toBe('"""\n a\n\n b\n """');
	});

	it("promotes the block fence for triple quotes and backslashes", () => {
		expect(printUfss('a\n"""\nb')).toBe('#"""\na\n"""\nb\n"""#');
		expect(printUfss("a\\b\nc")).toBe('#"""\na\\b\nc\n"""#');
		expect(printUfss('a\n"""#\nb')).toBe('##"""\na\n"""#\nb\n"""##');
	});

	it("prints collections deterministically and reads them back", () => {
		const value = new Map([
			[new EdnKeyword("name"), "fix"],
			[new EdnKeyword("items"), [1, 2, 3]],
			[new EdnKeyword("form"), readUfss('(cat {:path "x"})')],
			[new EdnKeyword("tags"), new Set([new EdnKeyword("a")])],
		]);

		const text = printUfss(value);
		expect(printUfss(readUfss(text))).toBe(text);
		expect(text).toContain(':name "fix"');
		expect(text).toContain(":items [1 2 3]");
	});

	it("keeps multiline string map keys valid", () => {
		const value = new Map([["a\nb", 1]]);
		const text = printUfss(value);

		expect(readUfss(text).get("a\nb")).toBe(1);
		expect(printUfss(readUfss(text))).toBe(text);
	});

	it("round-trips representative and adversarial strings", () => {
		const samples = [
			"",
			"abc",
			'a"b',
			"a\\b",
			'a"#b',
			'"""',
			'""',
			'"""#',
			"a\nb",
			"\n",
			"\n\n",
			"a\n",
			'a\n"""\nb',
			'a\n"""#\nb',
			"a\\b\nc",
			"\r",
			"\u0000",
			"\t",
			"中文😀",
			"  leading\n\ttab\n\n",
			"x".repeat(100 * 1024),
		];

		for (const sample of samples) {
			expect(readUfss(printUfss(sample))).toBe(sample);
		}
	});

	it("round-trips numbers outside the safe integer range", () => {
		expect(readUfss(printUfss(1e20))).toBe(1e20);
		expect(printUfss(1e20)).toBe("1e+20");
		expect(readUfss("9007199254740993")).toBe(9007199254740993n);
		expect(printUfss(9007199254740993n)).toBe("9007199254740993N");
	});

	it("round-trips randomized strings", () => {
		const alphabet = ["a", "b", " ", "\t", "\n", "\r", "\u0000", '"', "#", "\\", "中", "😀", ";"];
		let state = 0x2f6e2b1;
		const next = () => {
			state = (state * 1664525 + 1013904223) >>> 0;
			return state;
		};

		for (let iteration = 0; iteration < 300; iteration += 1) {
			const length = next() % 80;
			let sample = "";
			for (let index = 0; index < length; index += 1) {
				sample += alphabet[next() % alphabet.length];
			}
			expect(readUfss(printUfss(sample))).toBe(sample);
		}
	});
});

describe("renderReceipt", () => {
	it("ends with exactly one newline and parses back", () => {
		const value = new Map([[new EdnKeyword("ok"), true]]);
		const receipt = renderReceipt(value);

		expect(receipt.endsWith("\n")).toBe(true);
		expect(receipt.endsWith("\n\n")).toBe(false);
		expect(printUfss(readUfss(receipt))).toBe(receipt.slice(0, -1));
	});
});

describe("findAll", () => {
	it("returns exact UTF-16 spans, including overlapping matches", () => {
		expect(findAll("abcabc", "abc")).toEqual([
			[0, 3],
			[3, 6],
		]);
		expect(findAll("aaa", "aa")).toEqual([
			[0, 2],
			[1, 3],
		]);
		expect(findAll("a😀b", "b")).toEqual([[3, 4]]);
		expect(findAll("abc", "z")).toEqual([]);
	});

	it("does not trim or treat the needle as a pattern", () => {
		expect(findAll("a.c abc", "a.c")).toEqual([[0, 3]]);
		expect(findAll("    needle", "needle")).toEqual([[4, 10]]);
	});

	it("rejects an empty needle", () => {
		expect(catchError(() => findAll("abc", "")).code).toBe(":INVALID_ARGUMENT");
	});
});

describe("findUnique", () => {
	it("preserves char-clean semantics without trim or Unicode normalize", () => {
		expect(findUnique("  abc  ", "abc").kind).toBe("unique");
		expect(findUnique("  abc  ", "  abc  ").span).toEqual([0, 7]);
		expect(findUnique("abc", " abc ").kind).toBe("none");
		expect(findUnique("\u00e9", "e\u0301").kind).toBe("none");
		expect(findAll("\u00e9", "e\u0301")).toEqual([]);
	});
	it("returns one exact span", () => {
		expect(findUnique("xx needle yy", "needle")).toEqual({
			kind: "unique",
			span: [3, 9],
		});
		expect(findUnique("  needle  ", "needle")).toEqual({
			kind: "unique",
			span: [2, 8],
		});
	});

	it("returns up to eight candidates with 80-unit context", () => {
		const content = `${"x".repeat(100)}needle${"y".repeat(100)} needle`;
		const result = findUnique(content, "needle");

		expect(result.kind).toBe("ambiguous");
		expect(result.candidates).toHaveLength(2);
		expect(result.truncated).toBeUndefined();
		expect(result.candidates[0].span).toEqual([100, 106]);
		expect(result.candidates[0].context).toBe(`${"x".repeat(80)}needle${"y".repeat(80)}`);
	});

	it("marks more than eight matches as truncated", () => {
		const result = findUnique("a".repeat(9), "a");
		expect(result.kind).toBe("ambiguous");
		expect(result.candidates).toHaveLength(8);
		expect(result.truncated).toBe(true);
	});

	it("diagnoses the nearest line when the needle is absent", () => {
		const content = "alpha\n(def timeout-ms 30000)\nomega";
		const result = findUnique(content, "(def timeout-ms 30001)");

		expect(result.kind).toBe("none");
		expect(result.budgetExhausted).toBe(false);
		expect(result.nearest.text).toBe("(def timeout-ms 30000)");
		expect(result.nearest.distance).toBe(1);
		expect(result.nearest.span).toEqual([6, 6 + result.nearest.text.length]);
	});

	it("returns the full long nearest line without truncation", () => {
		const line = `${"a".repeat(200)}c`;
		const result = findUnique(line, `${"a".repeat(200)}b`);

		expect(result.kind).toBe("none");
		expect(result.nearest.truncated).toBeUndefined();
		expect(result.nearest.text).toBe(line);
		expect(result.nearest.span).toEqual([0, line.length]);
	});

	it("returns no nearest line when every line exceeds the band", () => {
		const result = findUnique("short\nlines", "q".repeat(100));
		expect(result.kind).toBe("none");
		expect(result.nearest).toBeNull();
		expect(result.budgetExhausted).toBe(false);
	});

	it("scans past 2000 non-empty lines to find the nearest line", () => {
		const prefix = Array.from({ length: 2000 }, () => "zzzzz").join("\n");
		const content = `${prefix}\nz`;
		const result = findUnique(content, "q");

		expect(result.kind).toBe("none");
		expect(result.nearest.text).toBe("z");
		expect(result.nearest.span).toEqual([prefix.length + 1, content.length]);
	});

	it("stops at the DP cell budget", () => {
		const content = Array.from({ length: 20 }, () => "b".repeat(10000)).join("\n");
		const result = findUnique(content, "a".repeat(10000));

		expect(result.kind).toBe("none");
		expect(result.budgetExhausted).toBe(true);
	});
});
