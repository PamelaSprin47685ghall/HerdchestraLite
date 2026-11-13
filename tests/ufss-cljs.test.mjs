import { beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";

beforeAll(() => {
	nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
});

async function evalClj(source) {
	return nbb.loadString(`(require '[herd.ufss :as u]) (require '[clojure.string :as str]) ${source}`);
}

describe("CLJS UFSS", () => {
	it("round-trips arbitrary strings", async () => {
		const result = await evalClj(`
			(every? (fn [s] (= s (u/read (u/print s))))
			        ["abc" "a\\"b" "line1\\nline2" "a\\"\\"\\"b" "back\\\\slash" "tab\\there"])`);
		expect(result).toBe(true);
	});

	it("accepts a closing fence with trailing syntax", async () => {
		const result = await evalClj(`(= "x" (get (u/read "{:a ##\\"\\"\\"\\nx\\n\\"\\"\\"##}") :a))`);
		expect(result).toBe(true);
	});

	it("accepts short-indented body lines without error", async () => {
		const result = await evalClj(`(u/unwrap "##\\"\\"\\"\\n  ok\\n bad\\n  \\"\\"\\"##")`);
		expect(result).toContain("ok");
		expect(result).toContain("bad");
	});

	it("keeps the lenient prompt note", async () => {
		const length = await evalClj("(count u/UFSS_PROMPT_NOTE)");
		const lenient = await evalClj('(str/includes? u/UFSS_PROMPT_NOTE "may share its line")');
		const strict = await evalClj('(str/includes? u/UFSS_PROMPT_NOTE "stand alone")');
		expect(length).toBeGreaterThan(4000);
		expect(lenient).toBe(true);
		expect(strict).toBe(false);
	});
});
