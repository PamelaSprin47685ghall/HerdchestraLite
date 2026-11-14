import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";

beforeAll(async () => {
	globalThis.__pi = {
		tools: new Map(),
		hooks: new Map(),
		active: ["read", "clj_devops", "wait"],
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
	nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
	await nbb.loadFile(fileURLToPath(new URL("../src/herd/bootstrap.cljs", import.meta.url)));
});

async function evalClj(source) {
	return nbb.loadString(
		`(require '[herd.ufss :as u]) (require '[herd.prompts :as p]) (require '[clojure.string :as str]) ${source}`,
	);
}

describe("CLJS UFSS", () => {
	it("round-trips arbitrary strings", async () => {
		const result = await evalClj(`
			(every? (fn [s] (= s (u/read (u/canonical (pr-str s)))))
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
		const length = await evalClj("(count p/ufss-prompt-note)");
		const lenient = await evalClj('(str/includes? p/ufss-prompt-note "may share its line")');
		const strict = await evalClj('(str/includes? p/ufss-prompt-note "stand alone")');
		expect(length).toBeGreaterThan(3000);
		expect(lenient).toBe(true);
		expect(strict).toBe(false);
	});

	it("reads every source string through the official reader", async () => {
		for (const name of [
			"prompts.cljs",
			"sandbox.cljs",
			"repl.cljs",
			"main.cljs",
			"ufss.cljs",
			"ui.cljs",
			"stages/parsers.cljs",
			"stages/tenure.cljs",
			"stages/disclosures.cljs",
			"stages/scores.cljs",
			"stages/paths.cljs",
			"stages/mission.cljs",
			"stages/attach.cljs",
			"stages/approval.cljs",
			"stages/review.cljs",
			"stages/store.cljs",
			"stages/report.cljs",
			"stages/audit.cljs",
			"stages/gates.cljs",
			"gates_host.cljs",
			"util/atomic_write.cljs",
			"system.cljs",
		]) {
			const source = readFileSync(new URL(`../src/herd/${name}`, import.meta.url), "utf8");
			const roundtrip = await nbb.loadString(
				`(require '[herd.ufss :as u]) (every? (fn [s] (= s (u/read (u/canonical (pr-str s))))) (u/literals ${JSON.stringify(source)}))`,
			);
			expect(roundtrip, name).toBe(true);
		}
	});

	it("keeps every source canonical under the formatter pipeline", async () => {
		for (const name of [
			"prompts.cljs",
			"sandbox.cljs",
			"repl.cljs",
			"main.cljs",
			"ufss.cljs",
			"ui.cljs",
			"bootstrap.cljs",
			"stages/parsers.cljs",
			"stages/tenure.cljs",
			"stages/disclosures.cljs",
			"stages/scores.cljs",
			"stages/paths.cljs",
			"stages/mission.cljs",
			"stages/attach.cljs",
			"stages/approval.cljs",
			"stages/review.cljs",
			"stages/store.cljs",
			"stages/report.cljs",
			"stages/audit.cljs",
			"stages/gates.cljs",
			"gates_host.cljs",
			"util/atomic_write.cljs",
			"system.cljs",
		]) {
			const source = readFileSync(new URL(`../src/herd/${name}`, import.meta.url), "utf8");
			const canonical = await nbb.loadString(`(require '[herd.ufss :as u]) (u/canonical ${JSON.stringify(source)})`);
			expect(canonical, name).toBe(source);
		}
	});

	it("lays out data with cljs.pprint", async () => {
		const result = await evalClj(`
			(let [v (vec (range 40))
			      s (u/canonical v)]
			  (and (= v (u/read s))
			       (> (count (str/split-lines s)) 1)))`);
		expect(result).toBe(true);
	});
});
