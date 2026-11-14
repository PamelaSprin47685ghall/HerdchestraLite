import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
	"stages/approval",
	"stages/scores",
	"stages/audit",
	"stages/report",
	"stages/gates",
	"sandbox",
	"repl",
	"swarm/edn",
	"swarm/model",
	"swarm/ledger",
	"swarm/actors",
	"swarm/tasks",
	"swarm/commands",
	"swarm/token",
	"swarm/kernel",
	"swarm/store",
	"swarm/apply",
	"swarm/tools",
	"swarm/runner",
	"swarm/auditors",
	"system",
];
const BOARD_TOOLS = [
	"board_cancel",
	"board_claim",
	"board_comment",
	"board_finish",
	"board_park_slot",
	"board_release",
	"board_reopen",
	"board_replace",
	"board_split",
	"board_take_or_die",
	"board_update",
];
let moduleRoot;

beforeAll(async () => {
	nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
	moduleRoot = await mkdtemp(join(tmpdir(), "cljs-system-install-src-"));
	await nbb.loadFile(join(SRC, "ufss.cljs"));
	for (const name of MODULES) {
		const source = await readFile(join(SRC, `${name}.cljs`), "utf8");
		const unwrapped = await nbb.loadString(`(require '[herd.ufss :as u]) (u/unwrap ${JSON.stringify(source)})`);
		const target = join(moduleRoot, "herd", `${name}.cljs`);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, unwrapped);
	}
	nbb.addClassPath(moduleRoot);
	for (const name of MODULES) {
		await nbb.loadFile(join(moduleRoot, "herd", `${name}.cljs`));
	}
});

afterAll(async () => {
	if (moduleRoot) await rm(moduleRoot, { recursive: true, force: true });
});

const PRELUDE = `
(require '[herd.system :as system])

(defn make-counting-pi []
  (let [tools (atom [])
        commands (atom [])
        hooks (atom [])
        active (atom ["read" "bash"])
        fail-next (atom 0)]
    #js {:registerTool (fn [definition]
                         (if (pos? @fail-next)
                           (do (swap! fail-next dec)
                               (throw (js/Error. "registerTool failed")))
                           (swap! tools conj (.-name definition))))
         :registerCommand (fn [name _spec] (swap! commands conj name))
         :on (fn [name _handler] (swap! hooks conj name))
         :getActiveTools (fn [] (clj->js @active))
         :setActiveTools (fn [next]
                           (reset! active (vec (js->clj next)))
                           (js/Promise.resolve nil))
         :sendUserMessage (fn [_seed _options] nil)
         :__tools tools
         :__commands commands
         :__hooks hooks
         :__active active
         :__failNext fail-next}))

(defn main-ctx [root id]
  #js {:cwd root
       :hasUI false
       :mode "print"
       :sessionManager #js {:getSessionId (fn [] id)}})

`;

const literal = (value) => JSON.stringify(value);

async function scenario(body) {
	const text = await nbb.loadString(`
${PRELUDE}
${body}
(scenario)`);
	return JSON.parse(text);
}

let counter = 0;
async function freshRoot() {
	counter += 1;
	return mkdtemp(join(tmpdir(), `cljs-system-install-${counter}-`));
}

describe("per-pi system installation", () => {
	it("registers the full tool, command, and hook surface for every pi", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        pi1 (make-counting-pi)
        pi2 (make-counting-pi)
        _ (system/reset-state!)
        first (system/install! pi1 {:root root})
        second (system/install! pi2 {:root root})
        tools1 (vec (sort @(.-__tools pi1)))
        tools2 (vec (sort @(.-__tools pi2)))]
    (js/JSON.stringify
      (clj->js {:first first
                :second second
                :tools1 tools1
                :tools2 tools2
                :commands1 (vec @(.-__commands pi1))
                :commands2 (vec @(.-__commands pi2))
                :hooks1 (vec @(.-__hooks pi1))
                :hooks2 (vec @(.-__hooks pi2))
                :installed-count (:installed-count @system/state)}))))`);
		expect(out.first).toBe(true);
		expect(out.second).toBe(true);
		expect(out.tools1).toHaveLength(20);
		expect(out.tools2).toEqual(out.tools1);
		expect(out.tools1).toContain("attach_case_audit");
		expect(out.tools1).toContain("review");
		for (const name of BOARD_TOOLS) expect(out.tools1).toContain(name);
		expect(out.tools1.filter((name) => name.startsWith("board_"))).toHaveLength(11);
		expect(out.commands1).toEqual(["herd"]);
		expect(out.commands2).toEqual(["herd"]);
		expect(out.hooks1.sort()).toEqual(["agent_end", "tool_execution_end"]);
		expect(out.hooks2.sort()).toEqual(["agent_end", "tool_execution_end"]);
		expect(out["installed-count"]).toBe(2);
	});

	it("returns false for the same pi without registering twice", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        pi (make-counting-pi)
        _ (system/reset-state!)
        first (system/install! pi {:root root})
        after-first {:tools (count @(.-__tools pi))
                     :commands (count @(.-__commands pi))
                     :hooks (count @(.-__hooks pi))}
        second (system/install! pi {:root root})]
    (js/JSON.stringify
      (clj->js {:first first
                :second second
                :after-first after-first
                :after-second {:tools (count @(.-__tools pi))
                               :commands (count @(.-__commands pi))
                               :hooks (count @(.-__hooks pi))}
                :installed-count (:installed-count @system/state)}))))`);
		expect(out.first).toBe(true);
		expect(out.second).toBe(false);
		expect(out["after-first"]).toEqual({ tools: 20, commands: 1, hooks: 2 });
		expect(out["after-second"]).toEqual(out["after-first"]);
		expect(out["installed-count"]).toBe(1);
	});

	it("does not mark a pi whose registration threw and retries the missing work", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        pi (make-counting-pi)
        _ (system/reset-state!)
        _ (reset! (.-__failNext pi) 1)
        first (system/install! pi {:root root})
        after-first {:tools (count @(.-__tools pi))
                     :commands (count @(.-__commands pi))
                     :hooks (count @(.-__hooks pi))}
        health (mapv :entry (:health @system/state))
        second (system/install! pi {:root root})
        after-second {:tools (count @(.-__tools pi))
                      :commands (count @(.-__commands pi))
                      :hooks (count @(.-__hooks pi))}
        third (system/install! pi {:root root})]
    (js/JSON.stringify
      (clj->js {:first first
                :second second
                :third third
                :after-first after-first
                :after-second after-second
                :health health
                :installed-count (:installed-count @system/state)}))))`);
		expect(out.first).toBe(false);
		expect(out.second).toBe(true);
		expect(out.third).toBe(false);
		expect(out["after-first"]).toEqual({ tools: 0, commands: 0, hooks: 0 });
		expect(out["after-second"]).toEqual({ tools: 20, commands: 1, hooks: 2 });
		expect(out.health).toContain("system.install");
		expect(out["installed-count"]).toBe(1);
	});

	it("keeps apply-mission-surface session state isolated by session key", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        pi (make-counting-pi)
        _ (system/reset-state!)
        _ (system/install! pi {:root root})
        ctx-a (main-ctx root "A")
        ctx-b (main-ctx root "B")
        _ (swap! system/state assoc-in [:sessions "session:A"]
                 {:role-token {:role "Reviewer"} :slug "alpha" :stage :s3})
        a-first (system/apply-mission-surface! pi ctx-a)
        b-unfocused (system/apply-mission-surface! pi ctx-b)
        _ (swap! system/state assoc-in [:sessions "session:B"]
                 {:role-token {:role "Plan DevOps"} :slug "beta" :stage :s2})
        b-focused (system/apply-mission-surface! pi ctx-b)
]
    (js/JSON.stringify
      (clj->js {:a-first a-first
                :b-unfocused b-unfocused
                :b-focused b-focused
                :a-role (get-in @system/state [:sessions "session:A" :role-token :role])
                :a-slug (get-in @system/state [:sessions "session:A" :slug])
                :b-role (get-in @system/state [:sessions "session:B" :role-token :role])
                :b-slug (get-in @system/state [:sessions "session:B" :slug])}))))`);
		expect(out["a-first"]).toBe(true);
		expect(out["b-unfocused"]).toBe(false);
		expect(out["b-focused"]).toBe(true);
		expect(out["a-role"]).toBe("Reviewer");
		expect(out["a-slug"]).toBe("alpha");
		expect(out["b-role"]).toBe("Plan DevOps");
		expect(out["b-slug"]).toBe("beta");
	});
});
