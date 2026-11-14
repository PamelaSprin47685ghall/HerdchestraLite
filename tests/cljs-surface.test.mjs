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
let moduleRoot;

beforeAll(async () => {
	nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
	moduleRoot = await mkdtemp(join(tmpdir(), "cljs-surface-src-"));
	await nbb.loadFile(join(SRC, "ufss.cljs"));
	for (const name of MODULES) {
		const source = await readFile(join(SRC, `${name}.cljs`), "utf8");
		const unwrapped = await nbb.loadString(
			`(require (quote [herd.ufss :as u])) (u/unwrap ${JSON.stringify(source)})`,
		);
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
(require (quote herd.system))

(defn make-pi []
  (let [tools (atom {})
        commands (atom {})
        hooks (atom {})
        active (atom ["read" "bash" "board_finish" "clj_devops" "wait"])]
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

(defn main-ctx [root id]
  #js {:cwd root
       :hasUI false
       :mode "print"
       :sessionManager #js {:getSessionId (fn [] id)}})

(defn sub-ctx [root id]
  #js {:cwd root
       :agent #js {:id id :kind "sub"}
       :sessionManager #js {:getSessionId (fn [] (str "sub-" id))}})

(defn ^:async settle []
  (await (js/Promise. (fn [resolve] (js/setImmediate resolve)))))
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
	return mkdtemp(join(tmpdir(), `cljs-surface-${counter}-`));
}

describe("CLJS mission and subagent tool surfaces", () => {
	it("keeps the default surface for a subagent without a role token", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        pi (make-pi)
        calls (atom 0)
        _ (herd.system/reset-state!)
        _ (herd.system/install! pi {:root root})
        _ (js/Reflect.set pi "setActiveTools"
             (fn [next]
               (swap! calls inc)
               (reset! (.-__active pi) (vec (js->clj next)))
               (js/Promise.resolve nil)))
        sub (sub-ctx root "S1")
        _ (swap! herd.system/state update-in [:sessions "S1"] merge {:slug "vibe" :stage :s4})
        result (herd.system/apply-mission-surface! pi sub)
        surface (herd.system/surface-for {:mission? true :subagent? true :stage :s4 :role nil})]
    (js/JSON.stringify (clj->js {:result result
                                 :calls @calls
                                 :surface surface
                                 :active (vec @(.-__active pi))}))))`);
		expect(out.result).toBe(false);
		expect(out.calls).toBe(0);
		expect(out.surface).toBeNull();
		expect(out.active).toEqual(["read", "bash", "board_finish", "clj_devops", "wait"]);
	});

	it("does not narrow a main session that has a slug but no stage", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        pi (make-pi)
        calls (atom 0)
        _ (herd.system/reset-state!)
        _ (herd.system/install! pi {:root root})
        _ (js/Reflect.set pi "setActiveTools"
             (fn [next]
               (swap! calls inc)
               (reset! (.-__active pi) (vec (js->clj next)))
               (js/Promise.resolve nil)))
        ctx (main-ctx root "session-1")
        _ (swap! herd.system/state update-in [:sessions "session:session-1"] merge {:slug "vibe"})
        result (herd.system/apply-mission-surface! pi ctx)]
    (js/JSON.stringify (clj->js {:result result :calls @calls}))))`);
		expect(out.result).toBe(false);
		expect(out.calls).toBe(0);
	});

	it("narrows a main session to the S1 surface and fills in missing tools", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        pi (make-pi)
        calls (atom 0)
        _ (herd.system/reset-state!)
        _ (herd.system/install! pi {:root root})
        _ (reset! (.-__active pi) ["review" "bash" "ask_user"])
        _ (js/Reflect.set pi "setActiveTools"
             (fn [next]
               (swap! calls inc)
               (reset! (.-__active pi) (vec (js->clj next)))
               (js/Promise.resolve nil)))
        ctx (main-ctx root "session-1")
        _ (swap! herd.system/state update-in [:sessions "session:session-1"] merge {:slug "vibe" :stage :s1})
        result (herd.system/apply-mission-surface! pi ctx)
        _ (await (settle))
        active (vec (sort @(.-__active pi)))]
    (js/JSON.stringify (clj->js {:result result
                                 :calls @calls
                                 :active active}))))`);
		expect(out.result).toBe(true);
		expect(out.calls).toBe(1);
		expect(out.active).toEqual(["ask_user", "attach_brainstorm", "clj_plan", "devops", "review"]);
	});

	it("keeps the default surface when the mission is completed", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        pi (make-pi)
        calls (atom 0)
        _ (herd.system/reset-state!)
        _ (herd.system/install! pi {:root root})
        _ (js/Reflect.set pi "setActiveTools"
             (fn [next]
               (swap! calls inc)
               (reset! (.-__active pi) (vec (js->clj next)))
               (js/Promise.resolve nil)))
        ctx (main-ctx root "session-1")
        _ (swap! herd.system/state update-in [:sessions "session:session-1"] merge {:slug "vibe" :stage :completed})
        result (herd.system/apply-mission-surface! pi ctx)
        surface (herd.system/surface-for {:mission? true :stage :completed})]
    (js/JSON.stringify (clj->js {:result result
                                 :calls @calls
                                 :surface surface
                                 :active (vec @(.-__active pi))}))))`);
		expect(out.result).toBe(false);
		expect(out.calls).toBe(0);
		expect(out.surface).toBeNull();
		expect(out.active).toEqual(["read", "bash", "board_finish", "clj_devops", "wait"]);
	});

	it("narrows a Plan DevOps subagent to its explicit surface", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        pi (make-pi)
        calls (atom 0)
        _ (herd.system/reset-state!)
        _ (herd.system/install! pi {:root root})
        _ (js/Reflect.set pi "setActiveTools"
             (fn [next]
               (swap! calls inc)
               (reset! (.-__active pi) (vec (js->clj next)))
               (js/Promise.resolve nil)))
        sub (sub-ctx root "D1")
        _ (await (herd.system/before-agent-start! #js {:prompt "[HERD_ROLE: Plan DevOps]\\ninvestigate"} sub))
        _ (swap! herd.system/state update-in [:sessions "D1"] merge {:slug "vibe" :stage :s2})
        result (herd.system/apply-mission-surface! pi sub)
        _ (await (settle))
        active (vec (sort @(.-__active pi)))]
    (js/JSON.stringify (clj->js {:result result
                                 :calls @calls
                                 :active active}))))`);
		expect(out.result).toBe(true);
		expect(out.active).toEqual(["clj_devops", "submit_devops_report"]);
	});

	it("narrows a Swarm Worker subagent to the board tools", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        pi (make-pi)
        _ (herd.system/reset-state!)
        _ (herd.system/install! pi {:root root})
        sub (sub-ctx root "W1")
        _ (await (herd.system/before-agent-start! #js {:prompt "[HERD_ROLE: Swarm Worker]\\nwork"} sub))
        _ (swap! herd.system/state update-in [:sessions "W1"] merge {:slug "vibe" :stage :s3})
        result (herd.system/apply-mission-surface! pi sub)
        _ (await (settle))
        active (vec (sort @(.-__active pi)))
        has-take (boolean (some (fn [tool] (= tool "board_take_or_die")) active))]
    (js/JSON.stringify (clj->js {:result result
                                 :count (count active)
                                 :has-take has-take}))))`);
		expect(out.result).toBe(true);
		expect(out.count).toBe(12);
		expect(out["has-take"]).toBe(true);
	});

	it("keeps the current tool surface when setActiveTools fails", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        pi (make-pi)
        calls (atom 0)
        _ (herd.system/reset-state!)
        _ (js/Reflect.set pi "setActiveTools"
             (fn [_next]
               (swap! calls inc)
               (throw (js/Error. "surface unavailable"))))
        _ (herd.system/install! pi {:root root})
        ctx (main-ctx root "session-1")
        _ (swap! herd.system/state update-in [:sessions "session:session-1"] merge {:slug "vibe" :stage :s1})
        result (herd.system/apply-mission-surface! pi ctx)
        _ (await (settle))
        active (vec @(.-__active pi))
        health (.-__herdHealth js/globalThis)]
    (js/JSON.stringify (clj->js {:result result
                                 :calls @calls
                                 :active active
                                 :health-status (.-status health)}))))`);
		expect(out.result).toBe(true);
		expect(out.calls).toBe(1);
		expect(out.active).toEqual(["read", "bash", "board_finish", "clj_devops", "wait"]);
		expect(out["health-status"]).toBe("degraded");
	});
});
