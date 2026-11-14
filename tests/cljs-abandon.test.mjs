import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";

const SRC = fileURLToPath(new URL("../src/herd/", import.meta.url));
const MODULES = ["ufss", "sandbox", "repl"];
let moduleRoot;
let originalCwd;

beforeAll(async () => {
	originalCwd = process.cwd();
	nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
	moduleRoot = mkdtempSync(join(tmpdir(), "cljs-abandon-src-"));
	for (const name of MODULES) {
		const source = readFileSync(join(SRC, `${name}.cljs`), "utf8");
		const unwrapped = await nbb.loadString(
			`(require '[herd.ufss :as u]) (u/unwrap ${JSON.stringify(source)})`,
		);
		const target = join(moduleRoot, "herd", `${name}.cljs`);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, unwrapped);
	}
	nbb.addClassPath(moduleRoot);
	for (const name of MODULES) {
		await nbb.loadFile(join(moduleRoot, "herd", `${name}.cljs`));
	}
	process.chdir(moduleRoot);
	await nbb.loadString(`
(require '[herd.sandbox :as sandbox] '[herd.repl :as repl])
(reset! sandbox/token-state {:paths #{} :path-waiters {} :global false :global-waiters []})
(reset! sandbox/active-calls {})
(reset! sandbox/parked {})
(reset! repl/programs {})
(reset! repl/running #{})
(reset! repl/abandoned #{})`);
});

afterAll(() => {
	if (originalCwd) process.chdir(originalCwd);
	if (moduleRoot) rmSync(moduleRoot, { recursive: true, force: true });
});

async function scenario(body) {
	const text = await nbb.loadString(`
(require '[clojure.string :as str]
         '[herd.sandbox :as sandbox]
         '[herd.repl :as repl])
${body}
(scenario)`);
	return JSON.parse(text);
}

describe("abandon kills the process group and clears runtime parks", () => {
	it("SIGKILLs the child process group and rejects the call", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [outcome (atom nil)
        call (sandbox/call {:name "group-kill"
                            :argv ["sh" "-c" "sleep 60 & echo $!; wait"]}
                           0)
        _ (-> call
              (.then (fn [value] (reset! outcome {:ok value})))
              (.catch (fn [error] (reset! outcome {:message (or (ex-message error) (str error))}))))
        _ (await (sandbox/await-call-start "group-kill"))
        _ (await (sandbox/await-call-output "group-kill" "\n"))
        snapshot (sandbox/call-snapshot "group-kill")
        pid (js/parseInt (str/trim (first (str/split (:stdout snapshot) #"\n"))) 10)
        receipt (sandbox/abandon {:name "group-kill"})
        _ (await (-> call (.then (fn [_] nil)) (.catch (fn [_] nil))))
        grandchild-alive? (try (js/process.kill pid 0) true (catch :default _ false))]
    (js/JSON.stringify
      (clj->js {:pid (number? pid)
                :receipt (:state receipt)
                :cleared (:cleared receipt)
                :abandon-message (get-in @outcome [:message])
                :grandchild-alive? grandchild-alive?
                :outcome (pr-str @outcome)}))))`);

		expect(out.pid).toBe(true);
		expect(out.receipt).toBe("abandoned");
		expect(out.cleared).toBe(true);
		expect(out["abandon-message"]).toBe("call abandoned");
		expect(out["grandchild-alive?"]).toBe(false);
	});

	it("clears a runtime-parked program with no active call", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (swap! repl/programs assoc "deadline-only"
         {:state :parked :recoverable false :reason :deadline})
  (let [result (repl/abandon {:name "deadline-only"})]
    (js/JSON.stringify
      (clj->js {:state (:state result)
                :reason (:reason result)
                :cleared (:cleared result)
                :still-present? (contains? @repl/programs "deadline-only")
                :abandoned? (contains? @repl/abandoned "deadline-only")}))))`);

		expect(out.state).toBe("cleared");
		expect(out.reason).toBe("deadline");
		expect(out.cleared).toBe(true);
		expect(out["still-present?"]).toBe(false);
		expect(out["abandoned?"]).toBe(true);
	});

	it("abandons a tracked program without resurrecting its entry", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [_ (repl/run "tracked" "(call {:argv [\\"sleep\\" \\"30\\"]})" 30000)
        _ (await (sandbox/await-call-start "tracked"))
        registered? (contains? @sandbox/active-calls "tracked")
        receipt (repl/abandon {:name "tracked"})]
    (js/JSON.stringify
      (clj->js {:state (:state receipt)
                :cleared (:cleared receipt)
                :present? (contains? @repl/programs "tracked")
                :abandoned? (contains? @repl/abandoned "tracked")
                :registered? registered?}))))`);

		expect(out.state).toBe("abandoned");
		expect(out.cleared).toBe(true);
		expect(out["present?"]).toBe(false);
		expect(out["abandoned?"]).toBe(true);
	});
});