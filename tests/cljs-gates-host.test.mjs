import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";

const SRC = fileURLToPath(new URL("../src/herd/", import.meta.url));
const MODULES = [
	"util/atomic_write",
	"stages/parsers",
	"stages/tenure",
	"stages/disclosures",
	"stages/paths",
	"stages/mission",
	"stages/store",
	"stages/attach",
	"stages/review",
	"stages/gates",
	"gates_host",
];
const NOW = "2026-11-14T00:00:00.000Z";
let moduleRoot;

beforeAll(async () => {
	nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
	moduleRoot = mkdtempSync(join(tmpdir(), "cljs-gates-host-src-"));
	await nbb.loadFile(join(SRC, "ufss.cljs"));
	for (const name of MODULES) {
		const source = readFileSync(join(SRC, `${name}.cljs`), "utf8");
		const unwrapped = await nbb.loadString(`(require '[herd.ufss :as u]) (u/unwrap ${JSON.stringify(source)})`);
		const target = join(moduleRoot, "herd", `${name}.cljs`);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, unwrapped);
	}
	nbb.addClassPath(moduleRoot);
	for (const name of MODULES) {
		await nbb.loadFile(join(moduleRoot, "herd", `${name}.cljs`));
	}
});

afterAll(() => {
	if (moduleRoot) rmSync(moduleRoot, { recursive: true, force: true });
});

async function scenario() {
	const root = mkdtempSync(join(tmpdir(), "cljs-gates-host-"));
	const text = await nbb.loadString(`
(require '[herd.gates-host :as gates-host]
         '[herd.stages.store :as store])
(defn ^:async scenario []
  (let [created (await (store/create-mission! ${JSON.stringify(root)}
                           {:slug "demo" :mission-id "M1" :now ${JSON.stringify(NOW)}}))
        defs (atom [])
        pi #js {:registerTool (fn [definition] (swap! defs conj definition))}
        service (gates-host/register! pi {:root ${JSON.stringify(root)}
                                          :slug "demo"
                                          :now (fn [] ${JSON.stringify(NOW)})})
        names (mapv (fn [definition] (.-name definition)) @defs)
        review (some (fn [definition] (when (= "review" (.-name definition)) definition)) @defs)
        result (await ((.-execute review) "call-1" #js {} nil nil #js {:cwd ${JSON.stringify(root)}}))
        block (aget (.-content result) 0)]
    (js/JSON.stringify
      (clj->js {:names names
                :parameters-type (.-type (.-parameters review))
                :execute? (instance? js/Function (.-execute review))
                :is-error (.-isError result)
                :text (.-text block)
                :service? (some? service)}))))
(scenario)`);
	rmSync(root, { recursive: true, force: true });
	return JSON.parse(text);
}

describe("CLJS gate host adapter", () => {
	it("registers JS-shaped tools and executes review through them", async () => {
		const out = await scenario();
		expect(out.names).toEqual([
			"review",
			"attach_brainstorm",
			"attach_manual_tests",
			"attach_dev_guide",
			"attach_coordination",
			"ask_user",
			"devops",
			"submit_devops_report",
		]);
		expect(out["parameters-type"]).toBe("object");
		expect(out["execute?"]).toBe(true);
		expect(out["is-error"] == null).toBe(true);
		expect(out.text).toContain(":status :review-quiescent");
		expect(out["service?"]).toBe(true);
	});
});
