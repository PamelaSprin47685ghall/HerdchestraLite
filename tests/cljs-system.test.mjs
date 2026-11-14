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

const S1_MARKDOWN = [
	"# 一句话目标与用户可见结果",
	"让 dogfood 使命跑到 S2。",
	"# 决策框架",
	"先验证最小闭环。",
	"# 现状事实与根因",
	"默认面只暴露 clj_devops。",
	"# 单向门/双向门",
	"attach 是单向门。",
	"# 事前验尸",
	"失败原因会是未验证磁盘文档。",
	"# Non-Goals",
	"不做多 worktree。",
	"# 成功标准",
	"stage 变为 s2。",
	"# 未决问题",
	"无。",
].join("\n");

const PRELUDE = `
(require '[clojure.string :as str]
         '[herd.stages.audit :as audit]
         '[herd.stages.store :as store]
         '[herd.stages.tenure :as tenure]
         '[herd.swarm.auditors :as auditors]
         '[herd.swarm.model :as swarm-model]
         '[herd.swarm.runner :as runner]
         '[herd.swarm.store :as swarm-store]
         '[herd.system :as system]
         '[herd.ufss :as ufss])

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

(defn tool-info [result]
  (let [value (if (map? result) result (js->clj result :keywordize-keys true))]
    {:is-error (boolean (:isError value))
     :text (or (get-in value [:content 0 :text]) "")}))

(defn ^:async create-mission! [root seed]
  (let [pi (make-pi)
        _ (system/reset-state!)
        _ (system/install! pi {:root root})
        handler (.-handler (get @(.-__commands pi) "herd"))
        ctx (main-ctx root "session-1")]
    (await (handler seed ctx))
    [pi ctx]))

(defn ^:async s5-fixture! [root term]
  (let [slug "s5-probe"
        _ (await (store/create-mission! root {:slug slug
                                              :seed "S5 probe"
                                              :now "2026-11-14T00:00:00.000Z"
                                              :tenure {:tenure-id "T-1"
                                                       :index 1
                                                       :started-at "2026-11-14T00:00:00.000Z"
                                                       :ended-at nil}}))
        _ (await (store/update-mission! root slug {:stage :s5}))
        board (-> (swarm-model/initial-board {:mode :swarm})
                  (assoc :tenure-id "T-1"
                         :tenure {:term term :phase :swarm}
                         :attach-ready false))
        _ (await (store/write-board! root slug board))]
    slug))
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
	return mkdtemp(join(tmpdir(), `cljs-system-${counter}-`));
}

describe("CLJS full assembly wiring", () => {
	it("registers the eight gate tools, eleven board tools, attach_case_audit, and /herd", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        pi (make-pi)
        _ (system/reset-state!)
        _ (system/install! pi {:root root})]
    (js/JSON.stringify
      (clj->js {:tools (vec (sort (keys @(.-__tools pi))))
                :commands (vec (keys @(.-__commands pi)))}))))`);
		expect(out.tools).toEqual([
			"ask_user",
			"attach_brainstorm",
			"attach_case_audit",
			"attach_coordination",
			"attach_dev_guide",
			"attach_manual_tests",
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
			"devops",
			"review",
			"submit_devops_report",
		]);
		expect(out.commands).toEqual(["herd"]);
	});

	it("creates a focused S1 mission and restores focus from disk", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        [pi ctx] (await (create-mission! root "Build the parser"))
        slug "build-the-parser"
        read (await (store/read-mission root slug))
        board (await (store/read-board root slug))
        fs (js/require "node:fs/promises")
        focus-text (await (.readFile fs (str root "/.herd/focus.edn") "utf8"))
        focus (ufss/read focus-text)
        entry (get focus "session:session-1")
        _ (system/reset-state!)
        pi2 (make-pi)
        _ (system/install! pi2 {:root root})
        restored (await (system/ensure-focus! (main-ctx root "session-1") root))]
    (js/JSON.stringify
      (clj->js {:ok (:ok read)
                :stage (:stage (:mission read))
                :seed (:seed (:mission read))
                :control-version (:control-version (:mission read))
                :tenure (get-in read [:mission :tenure :tenure-id])
                :board-empty (empty? (:tasks board))
                :focus-slug (:slug entry)
                :focus-tenure (:tenure-id entry)
                :restored restored}))))`);
		expect(out.ok).toBe(true);
		expect(out.stage).toBe("s1");
		expect(out.seed).toBe("Build the parser");
		expect(out["control-version"]).toBe(1);
		expect(out.tenure).toBe("T-1");
		expect(out["board-empty"]).toBe(true);
		expect(out["focus-slug"]).toBe("build-the-parser");
		expect(out["focus-tenure"]).toBe("T-1");
		expect(out.restored).toBe("build-the-parser");
	});

	it("refuses an unfocused session when several missions exist", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        [pi _ctx] (await (create-mission! root "First mission"))
        _ (await (store/create-mission! root {:slug "second" :mission-id "M2"
                                              :now "2026-11-14T00:00:00.000Z"}))
        _ (system/reset-state!)
        pi2 (make-pi)
        _ (system/install! pi2 {:root root})
        review (get @(.-__tools pi2) "review")
        result (await ((.-execute review) "call-1" #js {} nil nil
                       (main-ctx root "session-2")))
        text (:text (tool-info result))]
    (js/JSON.stringify
      (clj->js {:is-error (:is-error (tool-info result))
                :text text
                :focused (await (system/ensure-focus! (main-ctx root "session-2") root))
                :focused-first (await (system/ensure-focus! (main-ctx root "session-1") root))}))))`);
		expect(out["is-error"]).toBe(true);
		expect(out.text).toContain(":session-slug-missing");
		expect(out.focused).toBeNull();
		expect(out["focused-first"]).toBe("first-mission");
	});

	it("fails closed for subagents without a role token and accepts a role token", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        [pi _ctx] (await (create-mission! root "Role probe"))
        review (get @(.-__tools pi) "review")
        sub (sub-ctx root "A1")
        denied (await ((.-execute review) "call-1" #js {} nil nil sub))
        health (.-__herdHealth js/globalThis)
        _ (await (system/before-agent-start! #js {:prompt "[HERD_ROLE: Reviewer]\\nreview"} sub))
        accepted (await ((.-execute review) "call-2" #js {} nil nil sub))
        audit (get @(.-__tools pi) "attach_case_audit")
        main-denied (await ((.-execute audit) "call-3"
                            #js {:case_id "CASE-1" :user_score 90
                                 :developer_score 80 :report_markdown "证据"}
                            nil nil (main-ctx root "session-1")))
        worker (sub-ctx root "A2")
        _ (await (system/before-agent-start! #js {:prompt "[HERD_ROLE: Manual Auditor]\\naudit"} worker))
        submitted (await ((.-execute audit) "call-4"
                          #js {:case_id "CASE-1" :user_score 90
                               :developer_score 80 :report_markdown "证据"}
                          nil nil worker))
        fs (js/require "node:fs/promises")
        audit-file (str root "/.herd/missions/role-probe/audit/CASE-1.submit.edn")
        audit-exists (await (-> (.access fs audit-file)
                                   (.then (fn [_] true))
                                   (.catch (fn [_] false))))]
    (await (js/Promise.resolve nil))
    (js/JSON.stringify
      (clj->js {:denied-error (:is-error (tool-info denied))
                :denied-text (:text (tool-info denied))
                :health-status (.-status health)
                :accepted-error (:is-error (tool-info accepted))
                :accepted-text (:text (tool-info accepted))
                :main-denied-text (:text (tool-info main-denied))
                :submitted-error (:is-error (tool-info submitted))
                :submitted-text (:text (tool-info submitted))
                :audit-exists audit-exists}))))`);
		expect(out["denied-error"]).toBe(true);
		expect(out["denied-text"]).toContain(":CAPABILITY_DENIED");
		expect(out["health-status"]).toBe("degraded");
		expect(out["accepted-error"]).toBe(false);
		expect(out["accepted-text"]).toContain(":review-quiescent");
		expect(out["main-denied-text"]).toContain(":CAPABILITY_DENIED");
		expect(out["submitted-error"]).toBe(false);
		expect(out["submitted-text"]).toContain(":audit-submitted");
		expect(out["audit-exists"]).toBe(true);
	});

	it("opens the S1 panel with the on-disk path and approves into S2", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        decision (atom "approve")
        seen (atom nil)
        pi (make-pi)
        _ (system/reset-state!)
        _ (system/install! pi {:root root
                               :confirm (fn [args]
                                          (reset! seen (str (:path (:pending args))))
                                          {:decision @decision :feedback "补充证据"})})
        handler (.-handler (get @(.-__commands pi) "herd"))
        ctx (main-ctx root "session-1")
        _ (await (handler "Panel approve" ctx))
        review (get @(.-__tools pi) "review")
        attach (get @(.-__tools pi) "attach_brainstorm")
        _ (await ((.-execute review) "review-1" #js {} nil nil ctx))
        result (await ((.-execute attach) "attach-1"
                       #js {:markdown ${literal(S1_MARKDOWN)}} nil nil ctx))
        read (await (store/read-mission root "panel-approve"))]
    (js/JSON.stringify
      (clj->js {:is-error (:is-error (tool-info result))
                :text (:text (tool-info result))
                :seen (str @seen)
                :path-ok (str/ends-with? (str @seen) "s1-brainstorm.md")
                :stage (:stage (:mission read))
                :tenure (get-in read [:mission :tenure :tenure-id])
                :pending (get-in read [:mission :attach :pending])}))))`);
		expect(out["is-error"]).toBe(false);
		expect(out.text).toContain(":status :attached");
		expect(out["path-ok"]).toBe(true);
		expect(out.stage).toBe("s2");
		expect(out.tenure).toBe("T-2");
		expect(out.pending).toBeNull();
	});

	it("keeps S1 on revise, turns deny into ask_user semantics, and waits on pending", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        decision (atom "revise")
        pi (make-pi)
        _ (system/reset-state!)
        _ (system/install! pi {:root root
                               :confirm (fn [_] {:decision @decision :feedback "再想想"})})
        handler (.-handler (get @(.-__commands pi) "herd"))
        ctx (main-ctx root "session-1")
        _ (await (handler "Panel states" ctx))
        review (get @(.-__tools pi) "review")
        attach (get @(.-__tools pi) "attach_brainstorm")
        _ (await ((.-execute review) "review-1" #js {} nil nil ctx))
        revised (await ((.-execute attach) "attach-1"
                        #js {:markdown ${literal(S1_MARKDOWN)}} nil nil ctx))
        after-revise (await (store/read-mission root "panel-states"))
        _ (reset! decision "deny")
        denied (await ((.-execute attach) "attach-2"
                       #js {:markdown ${literal(S1_MARKDOWN)}} nil nil ctx))
        after-deny (await (store/read-mission root "panel-states"))
        _ (reset! decision "pending")
        pending (await ((.-execute attach) "attach-3"
                        #js {:markdown ${literal(S1_MARKDOWN)}} nil nil ctx))
        after-pending (await (store/read-mission root "panel-states"))
        _ (reset! decision "approve")
        resumed (await ((.-execute attach) "attach-4"
                        #js {:markdown ${literal(S1_MARKDOWN)}} nil nil ctx))
        after-resume (await (store/read-mission root "panel-states"))]
    (js/JSON.stringify
      (clj->js {:revise-text (:text (tool-info revised))
                :revise-stage (:stage (:mission after-revise))
                :revise-ready (get-in after-revise [:mission :attach :ready])
                :deny-text (:text (tool-info denied))
                :deny-stage (:stage (:mission after-deny))
                :deny-pending (get-in after-deny [:mission :attach :pending])
                :pending-text (:text (tool-info pending))
                :pending-exists (boolean (get-in after-pending [:mission :attach :pending]))
                :resume-text (:text (tool-info resumed))
                :resume-stage (:stage (:mission after-resume))}))))`);
		expect(out["revise-text"]).toContain(":status :revision-requested");
		expect(out["revise-stage"]).toBe("s1");
		expect(out["revise-ready"]).toBe(false);
		expect(out["deny-text"]).toContain(":status :denied");
		expect(out["deny-stage"]).toBe("s1");
		expect(out["deny-pending"]).toBeNull();
		expect(out["pending-text"]).toContain(":status :awaiting-user");
		expect(out["pending-exists"]).toBe(true);
		expect(out["resume-text"]).toContain(":status :attached");
		expect(out["resume-stage"]).toBe("s2");
	});

	it("uses the 0/30/60/120/240/300 s nudge ladder and resets on progress", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        scheduled (atom [])
        delivered (atom [])
        pi (make-pi)
        _ (system/reset-state!)
        _ (system/install! pi {:root root
                               :deliver-nudge (fn [text] (swap! delivered conj text))
                               :set-timeout (fn [f ms] (swap! scheduled conj ms) (f) 1)
                               :clear-timeout (fn [_] nil)})
        handler (.-handler (get @(.-__commands pi) "herd"))
        ctx (main-ctx root "session-1")
        _ (await (handler "Nudge ladder" ctx))
        agent-end (get @(.-__hooks pi) "agent_end")
        tool-end (get @(.-__hooks pi) "tool_execution_end")
        trace (atom [])]
    (await (system/before-agent-start! #js {:prompt ""} ctx))
    (await (agent-end #js {:messages #js []} ctx))
    (swap! trace conj {:last (get-in @system/state [:nudge :last])
                       :scheduled (count @scheduled)})
    (await (system/before-agent-start! #js {:prompt ""} ctx))
    (await (agent-end #js {:messages #js []} ctx))
    (swap! trace conj {:last (get-in @system/state [:nudge :last])
                       :scheduled (count @scheduled)})
    (await (system/before-agent-start! #js {:prompt ""} ctx))
    (await (agent-end #js {:messages #js []} ctx))
    (swap! trace conj {:last (get-in @system/state [:nudge :last])
                       :scheduled (count @scheduled)})
    (tool-end #js {:toolName "board_comment" :isError false} ctx)
    (await (system/before-agent-start! #js {:prompt ""} ctx))
    (await (agent-end #js {:messages #js []} ctx))
    (js/JSON.stringify
      (clj->js {:delays (mapv (fn [n] (system/next-nudge-delay n false)) (range 7))
                :progress-delay (system/next-nudge-delay 5 true)
                :scheduled @scheduled
                :trace @trace
                :delivered (count @delivered)}))))`);
		expect(out.delays).toEqual([0, 30000, 60000, 120000, 240000, 300000, 300000]);
		expect(out["progress-delay"]).toBe(0);
		expect(out.scheduled).toEqual([0, 30000, 60000, 0]);
		expect(out.delivered).toBe(4);
	});

	it("queues one pending nudge when no follow-up channel exists", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        pi (make-pi)
        _ (js-delete pi "sendUserMessage")
        _ (system/reset-state!)
        _ (system/install! pi {:root root
                               :set-timeout (fn [f _ms] (f) 1)
                               :clear-timeout (fn [_] nil)})
        handler (.-handler (get @(.-__commands pi) "herd"))
        ctx (main-ctx root "session-1")
        _ (await (handler "Nudge queue" ctx))
        agent-end (get @(.-__hooks pi) "agent_end")
        _ (await (agent-end #js {:messages #js []} ctx))
        first (system/consume-nudge!)
        second (system/consume-nudge!)]
    (js/JSON.stringify (clj->js {:first (str first) :second second}))))`);
		expect(out.first.length).toBeGreaterThan(20);
		expect(out.second).toBeNull();
	});

	it("suppresses the nudge on ask_user and on completion", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        scheduled (atom [])
        pi (make-pi)
        _ (system/reset-state!)
        _ (system/install! pi {:root root
                               :deliver-nudge (fn [_] nil)
                               :set-timeout (fn [_f ms] (swap! scheduled conj ms) 1)
                               :clear-timeout (fn [_] nil)})
        handler (.-handler (get @(.-__commands pi) "herd"))
        ctx (main-ctx root "session-1")
        _ (await (handler "Nudge exits" ctx))
        agent-end (get @(.-__hooks pi) "agent_end")
        tool-end (get @(.-__hooks pi) "tool_execution_end")
        _ (await (system/before-agent-start! #js {:prompt ""} ctx))
        _ (tool-end #js {:toolName "ask_user" :isError false} ctx)
        _ (await (agent-end #js {:messages #js []} ctx))
        after-ask (count @scheduled)
        read (await (store/read-mission root "nudge-exits"))
        mission (:mission read)
        _ (await (store/update-mission! root "nudge-exits"
                                        {:stage :completed
                                         :approval {:revision (:revision mission)
                                                    :report-sha256 "abc"
                                                    :token "t"}}))
        _ (await (system/before-agent-start! #js {:prompt ""} ctx))
        _ (await (agent-end #js {:messages #js []} ctx))]
    (js/JSON.stringify (clj->js {:after-ask after-ask :after-complete (count @scheduled)}))))`);
		expect(out["after-ask"]).toBe(0);
		expect(out["after-complete"]).toBe(0);
	});

	it("computes role surfaces and narrows the active tools fail-closed", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        pi (make-pi)
        _ (system/reset-state!)
        _ (system/install! pi {:root root})
        no-mission (system/apply-mission-surface! pi (main-ctx root "session-0"))
        handler (.-handler (get @(.-__commands pi) "herd"))
        ctx (main-ctx root "session-1")
        _ (await (handler "Surface probe" ctx))
        plan-active (vec (sort @(.-__active pi)))
        sub (sub-ctx root "W1")
        _ (await (system/before-agent-start! #js {:prompt "[HERD_ROLE: Swarm Worker]\\nwork"} sub))
        worker-active (vec (sort @(.-__active pi)))
        audit-sub (sub-ctx root "A1")
        _ (await (system/before-agent-start! #js {:prompt "[HERD_ROLE: Manual Auditor]\\naudit"} audit-sub))
        auditor-active (vec (sort @(.-__active pi)))]
    (js/JSON.stringify
      (clj->js {:no-mission no-mission
                :plan-active plan-active
                :worker-active worker-active
                :auditor-active auditor-active
                :role-token (get-in @system/state [:sessions "W1" :role-token])
                :sub-focus (await (system/ensure-focus! sub root))
                :s1 (vec (sort (system/surface-for {:mission? true :stage :s1})))
                :s3 (vec (sort (system/surface-for {:mission? true :stage :s3})))
                :s5 (vec (sort (system/surface-for {:mission? true :stage :s5})))
                :worker-surface (vec (sort (system/surface-for {:mission? true :role "Swarm Worker"})))
                :auditor-surface (vec (sort (system/surface-for {:mission? true :role "Manual Auditor"})))
                :none (system/surface-for {:mission? false})}))))`);
		expect(out["no-mission"]).toBe(false);
		expect(out["plan-active"]).toEqual(["ask_user", "attach_brainstorm", "clj_plan", "devops", "review"]);
		expect(out["worker-active"]).not.toContain("board_take_or_die");
		expect(out["worker-surface"].length).toBe(12);
		expect(out["worker-surface"]).toContain("board_take_or_die");
		expect(out["auditor-surface"]).toEqual(["attach_case_audit", "clj_auditor"]);
		expect(out["auditor-active"]).toEqual(out["plan-active"]);
		expect(out.s1).toEqual(["ask_user", "attach_brainstorm", "clj_plan", "devops", "review"]);
		expect(out.s3).toEqual(["attach_dev_guide", "clj_plan", "devops", "review"]);
		expect(out.s5).toEqual(["ask_user", "review"]);
		expect(out.none).toBeNull();
	});

	it("keeps the current surface and records degraded health when setActiveTools fails", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        pi (make-pi)
        calls (atom 0)
        _ (system/reset-state!)
        _ (js/Reflect.set pi "setActiveTools"
             (fn [_next]
               (swap! calls inc)
               (throw (js/Error. "surface unavailable"))))
        _ (system/install! pi {:root root})
        handler (.-handler (get @(.-__commands pi) "herd"))
        ctx (main-ctx root "session-1")
        _ (await (handler "Surface failure" ctx))
        active (vec @(.-__active pi))
        health (.-__herdHealth js/globalThis)]
    (js/JSON.stringify (clj->js {:active active
                                 :calls @calls
                                 :health-status (.-status health)}))))`);
		expect(out.active).toEqual(["read", "bash", "board_finish", "clj_devops", "wait"]);
		expect(out.calls).toBe(1);
		expect(out["health-status"]).toBe("degraded");
	});

	it("builds a timestamp slug for a seed without ASCII words and lists known missions", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        pi (make-pi)
        _ (system/reset-state!)
        _ (system/install! pi {:root root})
        cmd (get @(.-__commands pi) "herd")
        handler (.-handler cmd)
        completions-fn (.-getArgumentCompletions cmd)
        ctx (main-ctx root "session-1")
        _ (await (handler "让代码更好" ctx))
        fs (js/require "node:fs")
        missions (vec (.readdirSync fs (str root "/.herd/missions")))
        slug (first missions)
        completions (vec (js->clj (completions-fn "mission-") :keywordize-keys true))]
    (js/JSON.stringify (clj->js {:slug slug
                                 :shape (boolean (re-matches #"^mission-\\d{8}-\\d{6}$" slug))
                                 :completions completions
                                 :command-ok (fn? handler)}))))`);
		expect(out["command-ok"]).toBe(true);
		expect(out.shape).toBe(true);
		expect(out.completions.length).toBe(1);
		expect(out.completions[0].value).toBe(out.slug);
	});

	it("instantiates root tasks and wakes slots for non-empty S5 Reviewer findings", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        calls (atom [])
        pi (make-pi)
        _ (system/reset-state!)
        _ (system/install! pi {:root root
                               :subagent (fn [request]
                                           (swap! calls conj request)
                                           {:ok true :agent-id "agent-1"})})
        slug (await (s5-fixture! root 0))
        sub (sub-ctx root "R1")
        _ (await (system/before-agent-start! #js {:prompt "[HERD_ROLE: Reviewer]\\nreview"} sub))
        review (get @(.-__tools pi) "review")
        result (await ((.-execute review) "call-1"
                       #js {:summary_markdown "S5 审查完成"
                            :findings #js [#js {:key "P1" :value "修复 parser"}]}
                       nil nil sub))
        board (await (swarm-store/read-board (swarm-store/open-board root slug)))
        info (tool-info result)]
    (js/JSON.stringify
      (clj->js {:is-error (:is-error info)
                :text (:text info)
                :calls (count @calls)
                :roles (vec (distinct (map :role @calls)))
                :task-count (count (:tasks board))}))))`);
		expect(out["is-error"]).toBe(false);
		expect(out.text).toContain(":review-open");
		expect(out.calls).toBeGreaterThan(0);
		expect(out.roles).toContain("Swarm Worker");
		expect(out["task-count"]).toBeGreaterThan(0);
	});

	it("asks the one-shot initial S5 question exactly once at quiescence", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        asked (atom [])
        pi (make-pi)
        _ (system/reset-state!)
        _ (system/install! pi {:root root
                               :ask-user (fn [args]
                                           (swap! asked conj args)
                                           {:ok true :answer "继续"})})
        slug (await (s5-fixture! root 0))
        sub (sub-ctx root "R2")
        _ (await (system/before-agent-start! #js {:prompt "[HERD_ROLE: Reviewer]\\nreview"} sub))
        review (get @(.-__tools pi) "review")
        result (await ((.-execute review) "call-1" #js {} nil nil sub))
        board (await (swarm-store/read-board (swarm-store/open-board root slug)))
        info (tool-info result)]
    (js/JSON.stringify
      (clj->js {:is-error (:is-error info)
                :text (:text info)
                :asked (count @asked)
                :ask-used (get-in board [:tenure :initial-ask-used])}))))`);
		expect(out["is-error"]).toBe(false);
		expect(out.text).toContain(":ask-user");
		expect(out.asked).toBe(1);
		expect(out["ask-used"]).toBe(true);
	});

	it("starts the successor audit batch once and completes the mission on PASS", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        batches (atom [])
        pi (make-pi)
        _ (system/reset-state!)
        _ (system/install! pi {:root root
                               :run-audit-batch (fn [deps options]
                                                  (swap! batches conj
                                                         {:slug (:slug deps)
                                                          :has-board (some? (:board options))})
                                                  (js/Promise.resolve
                                                    {:ok true
                                                     :verdict :PASS
                                                     :state :closed
                                                     :approval {:revision 0
                                                                :token "audit"
                                                                :report-sha256 "sha"}}))})
        slug (await (s5-fixture! root 1))
        sub (sub-ctx root "R3")
        _ (await (system/before-agent-start! #js {:prompt "[HERD_ROLE: Reviewer]\\nreview"} sub))
        review (get @(.-__tools pi) "review")
        first-result (await ((.-execute review) "call-1" #js {} nil nil sub))
        second-result (await ((.-execute review) "call-2" #js {} nil nil sub))
        first-info (tool-info first-result)
        second-info (tool-info second-result)
        read (await (store/read-mission root slug))]
    (js/JSON.stringify
      (clj->js {:batches (count @batches)
                :batch-record (first @batches)
                :first-error (:is-error first-info)
                :first-text (:text first-info)
                :second-error (:is-error second-info)
                :second-text (:text second-info)
                :stage (:stage (:mission read))}))))`);
		expect(out.batches).toBe(1);
		expect(out["batch-record"]["has-board"]).toBe(true);
		expect(out["first-error"]).toBe(false);
		expect(out["first-text"]).toContain(":audit-passed");
		expect(out["second-error"]).toBe(false);
		expect(out["second-text"]).toContain(":completed");
		expect(out.stage).toBe("completed");
	});

	it("runs Plan DevOps through the subagent port and reads the submit receipt", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        requests (atom [])
        fs (js/require "node:fs/promises")
        pi (make-pi)
        _ (system/reset-state!)
        _ (system/install! pi {:root root
                               :subagent (fn [request]
                                           (swap! requests conj request)
                                           (let [dir (get request :artifacts-dir)
                                                 prompt (str (get request :prompt))
                                                 call-id (second (re-find #"HERD_DEVOPS_CALL: ([A-Za-z0-9_-]+)" prompt))
                                                 receipt-dir (str dir "/devops-reports")
                                                 target (str receipt-dir "/" call-id ".edn")
                                                 text (ufss/canonical
                                                        {:status "devops-report"
                                                         :report-markdown "已检查真实工作区"
                                                         :inspected-paths ["src/herd/system.cljs"]})]
                                             (-> (.mkdir fs receipt-dir #js {:recursive true})
                                                 (.then (fn [_] (.writeFile fs target text "utf8")))
                                                 (.then (fn [_] {:ok true
                                                                 :session-file (str dir "/child.jsonl")})))))})
        ctx (main-ctx root "session-1")
        _ (await ((.-handler (get @(.-__commands pi) "herd")) "DevOps 检查" ctx))
        devops (get @(.-__tools pi) "devops")
        result (await ((.-execute devops) "call-1"
                       #js {:verbose_intent "检查 parser 的错误路径"} nil nil ctx))
        first-request (first @requests)
        info (tool-info result)]
    (js/JSON.stringify
      (clj->js {:is-error (:is-error info)
                :text (:text info)
                :role (:role first-request)
                :prompt-first-line (first (str/split-lines (str (:prompt first-request))))
                :prompt-has-root (boolean (str/includes? (str (:prompt first-request)) root))
                :artifacts (boolean (str/includes? (str (:artifacts-dir first-request)) "PlanDevOps-"))
                :cwd (:cwd first-request)}))))`);
		expect(out["is-error"]).toBe(false);
		expect(out.text).toContain(":devops-report");
		expect(out.role).toBe("Plan DevOps");
		expect(out["prompt-first-line"]).toBe("[HERD_ROLE: Plan DevOps]");
		expect(out["prompt-has-root"]).toBe(true);
		expect(out.artifacts).toBe(true);
		expect(out.cwd).toBe(root);
	});

	it("fails closed with HOST_API_MISMATCH when the devops subagent port is missing", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        pi (make-pi)
        _ (system/reset-state!)
        _ (js-delete js/globalThis "__herdHost")
        _ (js-delete js/globalThis "__herdRunDevops")
        _ (system/install! pi {:root root})
        ctx (main-ctx root "session-1")
        _ (await ((.-handler (get @(.-__commands pi) "herd")) "DevOps 缺失" ctx))
        devops (get @(.-__tools pi) "devops")
        result (await ((.-execute devops) "call-1"
                       #js {:verbose_intent "检查"} nil nil ctx))
        health (.-__herdHealth js/globalThis)
        info (tool-info result)]
    (js/JSON.stringify
      (clj->js {:is-error (:is-error info)
                :text (:text info)
                :health-status (.-status health)}))))`);
		expect(out["is-error"]).toBe(true);
		expect(out.text).toContain(":HOST_API_MISMATCH");
		expect(out["health-status"]).toBe("degraded");
	});

	it("backs off 5/10/20 s on upstream disconnects and stalls on quota", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        scheduled (atom [])
        retries (atom [])
        pi (make-pi)
        _ (system/reset-state!)
        _ (system/install! pi {:root root
                               :set-timeout (fn [_f ms] (swap! scheduled conj ms) 1)
                               :clear-timeout (fn [_] nil)
                               :deliver-retry (fn [text] (swap! retries conj text))})
        ctx (main-ctx root "session-1")
        _ (await (system/before-agent-start! #js {:prompt ""} ctx))
        agent-end (get @(.-__hooks pi) "agent_end")
        retry-event (fn []
                      #js {:messages #js [#js {:role "assistant"
                                               :stopReason "aborted"}]})
        _ (await (agent-end (retry-event) ctx))
        _ (await (agent-end (retry-event) ctx))
        _ (await (agent-end (retry-event) ctx))
        after-retries (vec @scheduled)
        _ (await (agent-end #js {:userAborted true
                                 :messages #js [#js {:role "assistant"
                                                     :stopReason "aborted"}]} ctx))
        after-cancel (get-in @system/state [:upstream :attempts])
        _ (await (agent-end (retry-event) ctx))
        _ (await (agent-end #js {:error "insufficient_quota"
                                 :messages #js [#js {:role "assistant"
                                                     :stopReason "error"}]} ctx))
        events (get-in @system/state [:upstream :events])
        delays (vec (map :delay-ms (filter :delay-ms events)))]
    (js/JSON.stringify
      (clj->js {:scheduled after-retries
                :after-cancel after-cancel
                :stalled (get-in @system/state [:upstream :stalled])
                :delays delays
                :attempts (get-in @system/state [:upstream :attempts])
                :retries (count @retries)}))))`);
		expect(out.scheduled).toEqual([5000, 10000, 20000]);
		expect(out["after-cancel"]).toBe(0);
		expect(out.stalled).toBe(true);
		expect(out.delays).toEqual([5000, 10000, 20000, 5000]);
		expect(out.attempts).toBe(1);
		expect(out.retries).toBe(0);
	});

	it("ignores 402/429/insufficient_quota text inside normal message bodies and successful tool outputs", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        scheduled (atom [])
        pi (make-pi)
        _ (system/reset-state!)
        _ (system/install! pi {:root root
                               :set-timeout (fn [_f ms] (swap! scheduled conj ms) 1)
                               :clear-timeout (fn [_] nil)
                               :deliver-retry (fn [_] nil)})
        ctx (main-ctx root "session-1")
        _ (await (system/before-agent-start! #js {:prompt ""} ctx))
        tool-end (get @(.-__hooks pi) "tool_execution_end")
        agent-end (get @(.-__hooks pi) "agent_end")]
    (await (tool-end #js {:toolName "clj_devops"
                          :isError false
                          :result "HTTP 429 502 insufficient_quota network_error 402"} ctx))
    (await (agent-end #js {:messages #js [#js {:role "user"
                                               :content "docs mention 402 billing 429"}
                                          #js {:role "assistant"
                                               :stopReason "stop"
                                               :content "checked 402 and 503"}]} ctx))
    (js/JSON.stringify
      (clj->js {:scheduled (vec @scheduled)
                :stalled (get-in @system/state [:upstream :stalled])
                :events (count (get-in @system/state [:upstream :events]))}))))`);
		expect(out.scheduled).toEqual([]);
		expect(out.stalled).toBe(false);
		expect(out.events).toBe(0);
	});

	it("runs the real audit batch to PASS, writes s5-report.md, and reuses the completed state", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        fs (js/require "node:fs/promises")
        slug (await (s5-fixture! root 1))
        plans-dir (str root "/plans/" slug)
        _ (await (.mkdir fs plans-dir #js {:recursive true}))
        _ (doseq [name ["s1-brainstorm.md" "s2-manual-tests.md" "s3-dev-guide.md"
                        "s4-coordination.md" "s4-coordination.pml"]]
            (await (.writeFile fs (str plans-dir "/" name) (str "doc " name) "utf8")))
        dataset [{:case_id "CASE-A" :path "正常" :threshold 80
                  :steps ["执行正常路径"] :expected "正常结果" :rubric "0..100"}
                 {:case_id "CASE-B" :path "错误" :threshold 80
                  :steps ["执行错误路径"] :expected "错误结果" :rubric "0..100"}
                 {:case_id "CASE-C" :path "边界" :threshold 80
                  :steps ["执行边界路径"] :expected "边界结果" :rubric "0..100"}
                 {:case_id "CASE-D" :path "并发" :threshold 80
                  :steps ["执行并发路径"] :expected "并发结果" :rubric "0..100"}
                 {:case_id "CASE-E" :path "恢复" :threshold 80
                  :steps ["执行恢复路径"] :expected "恢复结果" :rubric "0..100"}]
        _ (await (.writeFile fs (str root "/.herd/missions/" slug "/s2-cases.edn")
                             (ufss/canonical dataset) "utf8"))
        calls (atom 0)
        pi (make-pi)
        _ (system/reset-state!)
        _ (system/install!
            pi
            {:root root
             :subagent (fn [request]
                         (swap! calls inc)
                         (let [case-id (:case-id request)]
                           (-> (audit/write-submission-once!
                                 root slug case-id
                                 {:case_id case-id
                                  :user_score 90
                                  :developer_score 85
                                  :report_markdown (str "report " case-id)}
                                 nil)
                               (.then (fn [_] {:ok true})))))
             :audit-deps
             {:bwrap-available? (fn [] true)
              :prepare-isolation! (fn [request]
                                    {:ok true
                                     :cwd (str "/tmp/herd-real-" (:case-id request))
                                     :artifacts-dir (str "/tmp/herd-real-" (:case-id request) "/artifacts")
                                     :session-name (str "herd-" (:case-id request))
                                     :excluded []})
              :snapshot-workspace! (fn [request]
                                     {:ok true
                                      :files (mapv (fn [p]
                                                     {:path p
                                                      :sha256 "x"
                                                      :stamp {:mtime-ms 1 :size 1}
                                                      :missing false})
                                                   (:paths request))
                                      :digest "snapshot"})
              :approval-port
              {:issue (fn [request]
                        {:ok true
                         :approval {:revision (:revision request)
                                    :report-sha256 (:report-sha256 request)
                                    :token "tok"}})}}})
        sub (sub-ctx root "R4")
        _ (await (system/before-agent-start! #js {:prompt "[HERD_ROLE: Reviewer]\\nreview"} sub))
        review (get @(.-__tools pi) "review")
        first (await ((.-execute review) "call-1" #js {} nil nil sub))
        first-calls @calls
        report-exists (await (-> (.access fs (str plans-dir "/s5-report.md"))
                                 (.then (fn [_] true))
                                 (.catch (fn [_] false))))
        read (await (store/read-mission root slug))
        batch-path (str root "/.herd/missions/" slug "/audit/batch.edn")
        batch-exists (await (-> (.access fs batch-path)
                                 (.then (fn [_] true))
                                 (.catch (fn [_] false))))
        batch (when batch-exists
                (ufss/read (await (.readFile fs batch-path "utf8"))))
        second (await ((.-execute review) "call-2" #js {} nil nil sub))
        reused (await (auditors/run-audit-batch! {:root root :slug slug
                                                  :mission (:mission read)}
                                                 {:board (swarm-store/open-board root slug)}))
        first-info (tool-info first)
        second-info (tool-info second)]
    (js/JSON.stringify
      (clj->js {:first-error (:is-error first-info)
                :first-text (:text first-info)
                :first-calls first-calls
                :report-exists report-exists
                :stage (:stage (:mission read))
                :approval (get-in read [:mission :approval :token])
                :batch-exists batch-exists
                :batch-state (or (:state batch) (get batch "state"))
                :second-error (:is-error second-info)
                :second-text (:text second-info)
                :second-calls @calls
                :reused (:reused reused)
                :calls-after-reuse @calls}))))`);
		expect(out["first-error"]).toBe(false);
		expect(out["first-text"]).toContain(":audit-passed");
		expect(out["first-calls"]).toBe(5);
		expect(out["report-exists"]).toBe(true);
		expect(out.stage).toBe("completed");
		expect(out.approval).toBe("tok");
		expect(out["batch-state"]).toBe("pass");
		expect(out["second-error"]).toBe(false);
		expect(out["second-text"]).toContain(":completed");
		expect(out["second-calls"]).toBe(5);
		expect(out.reused).toBe(true);
		expect(out["calls-after-reuse"]).toBe(5);
	});

	it("writes repair root tasks and keeps S5 on a real audit FAIL", async () => {
		const root = await freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [root ${literal(root)}
        fs (js/require "node:fs/promises")
        slug (await (s5-fixture! root 1))
        plans-dir (str root "/plans/" slug)
        _ (await (.mkdir fs plans-dir #js {:recursive true}))
        _ (doseq [name ["s1-brainstorm.md" "s2-manual-tests.md" "s3-dev-guide.md"
                        "s4-coordination.md" "s4-coordination.pml"]]
            (await (.writeFile fs (str plans-dir "/" name) (str "doc " name) "utf8")))
        dataset [{:case_id "CASE-A" :path "正常" :threshold 80
                  :steps ["执行正常路径"] :expected "正常结果" :rubric "0..100"}
                 {:case_id "CASE-B" :path "错误" :threshold 80
                  :steps ["执行错误路径"] :expected "错误结果" :rubric "0..100"}
                 {:case_id "CASE-C" :path "边界" :threshold 80
                  :steps ["执行边界路径"] :expected "边界结果" :rubric "0..100"}
                 {:case_id "CASE-D" :path "并发" :threshold 80
                  :steps ["执行并发路径"] :expected "并发结果" :rubric "0..100"}
                 {:case_id "CASE-E" :path "恢复" :threshold 80
                  :steps ["执行恢复路径"] :expected "恢复结果" :rubric "0..100"}]
        _ (await (.writeFile fs (str root "/.herd/missions/" slug "/s2-cases.edn")
                             (ufss/canonical dataset) "utf8"))
        pi (make-pi)
        _ (system/reset-state!)
        _ (system/install!
            pi
            {:root root
             :subagent (fn [request]
                         (let [case-id (:case-id request)
                               user (if (= case-id "CASE-B") 70 90)]
                           (-> (audit/write-submission-once!
                                 root slug case-id
                                 {:case_id case-id
                                  :user_score user
                                  :developer_score 90
                                  :report_markdown (str "report " case-id)}
                                 nil)
                               (.then (fn [_] {:ok true})))))
             :audit-deps
             {:bwrap-available? (fn [] true)
              :prepare-isolation! (fn [request]
                                    {:ok true
                                     :cwd (str "/tmp/herd-fail-" (:case-id request))
                                     :artifacts-dir (str "/tmp/herd-fail-" (:case-id request) "/artifacts")
                                     :session-name (str "herd-" (:case-id request))
                                     :excluded []})
              :snapshot-workspace! (fn [request]
                                     {:ok true
                                      :files (mapv (fn [p]
                                                     {:path p
                                                      :sha256 "x"
                                                      :stamp {:mtime-ms 1 :size 1}
                                                      :missing false})
                                                   (:paths request))
                                      :digest "snapshot"})}})
        sub (sub-ctx root "R5")
        _ (await (system/before-agent-start! #js {:prompt "[HERD_ROLE: Reviewer]\\nreview"} sub))
        review (get @(.-__tools pi) "review")
        result (await ((.-execute review) "call-1" #js {} nil nil sub))
        board (await (swarm-store/read-board (swarm-store/open-board root slug)))
        read (await (store/read-mission root slug))
        batch-path (str root "/.herd/missions/" slug "/audit/batch.edn")
        batch-exists (await (-> (.access fs batch-path)
                                 (.then (fn [_] true))
                                 (.catch (fn [_] false))))
        batch (when batch-exists
                (ufss/read (await (.readFile fs batch-path "utf8"))))
        info (tool-info result)]
    (js/JSON.stringify
      (clj->js {:is-error (:is-error info)
                :text (:text info)
                :stage (:stage (:mission read))
                :tasks (count (:tasks board))
                :wake (get-in board [:wake :epoch])
                :batch-exists batch-exists
                :batch-state (or (:state batch) (get batch "state"))}))))`);
		expect(out["is-error"]).toBe(true);
		expect(out.text).toContain(":AUDIT_FAIL");
		expect(out.stage).toBe("s5");
		expect(out.tasks).toBeGreaterThan(0);
		expect(out.wake).toBeGreaterThan(0);
		expect(out["batch-state"]).toBe("repair");
	});
});
