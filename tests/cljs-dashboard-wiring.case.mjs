import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";
import { ensureModules } from "./helpers/nbb-boot.mjs";

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

let moduleRoot;

beforeAll(async () => {
	await ensureModules(MODULES);
});

const PRELUDE = String.raw`
(require '[herd.system :as system])

(defn make-pi []
  (let [tools (atom {})
        commands (atom {})
        hooks (atom {})
        active (atom ["read" "bash"])]
    #js {:registerTool (fn [definition] (swap! tools assoc (.-name definition) definition))
         :registerCommand (fn [name spec] (swap! commands assoc name spec))
         :on (fn [name handler] (swap! hooks assoc name handler))
         :getActiveTools (fn [] (clj->js @active))
         :setActiveTools (fn [next]
                           (reset! active (vec (js->clj next)))
                           (js/Promise.resolve nil))
         :sendUserMessage (fn [_seed _options] nil)
         :__tools tools
         :__commands commands
         :__hooks hooks
         :__active active}))

(defn ui-ctx [root id]
  (let [widgets (atom [])
        ui #js {:setWidget (fn [key _content _options]
                             (swap! widgets conj key)
                             nil)
                :onTerminalInput (fn [_handler] (fn [] nil))
                :__widgets widgets}
        ctx #js {:cwd root
                 :hasUI true
                 :mode "tui"
                 :sessionManager #js {:getSessionId (fn [] id)}}]
    (set! (.-ui ctx) ui)
    ctx))

(defn ^:async run-herd! [pi seed ctx]
  (let [handler (.-handler (get @(.-__commands pi) "herd"))]
    (await (handler seed ctx))))
`;

const literal = (value) => JSON.stringify(value);

async function scenario(root, body) {
	const text = await nbb.loadString(PRELUDE + body.replaceAll("__ROOT__", literal(root)) + " (scenario)");
	return JSON.parse(text);
}

describe("CLJS dashboard removal", () => {
	it("never mounts a dashboard widget through install!, session-start!, or /herd", async () => {
		const root = await mkdtemp(join(tmpdir(), "cljs-dashboard-removed-run-"));
		const out = await scenario(
			root,
			String.raw`
(defn ^:async scenario []
  (let [pi (make-pi)
        _ (system/reset-state!)
        _ (system/install! pi {:root __ROOT__})
        ctx (ui-ctx __ROOT__ "session-1")
        _ (await (system/session-start! ctx))
        _ (await (run-herd! pi "Removed dashboard" ctx))
        widgets @(.-__widgets (.-ui ctx))]
    (js/JSON.stringify
      (clj->js {:widgets (vec widgets)
                :dashboard? (boolean (some (fn [key] (= "herdchestra-dashboard" key)) widgets))
                :dashboard-state? (contains? @system/state :dashboard)}))))
`,
		);
		expect(out.widgets).toEqual([]);
		expect(out["dashboard?"]).toBe(false);
		expect(out["dashboard-state?"]).toBe(false);
	});
});
