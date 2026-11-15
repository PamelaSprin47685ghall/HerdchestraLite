(ns cljs.system-assembly-test
  (:require ["node:fs" :as fs]
            ["node:os" :as os]
            ["node:path" :as path]
            [herd.system :as system]
            [herd.stages.store :as store]
            [herd.swarm.model :as model]
            [herd.swarm.store :as board-store]
            [herd.ufss :as ufss]
            [herd.test :as t]
            [promesa.core :as p]))

(defn- root [] (fs/mkdtempSync (path/join (os/tmpdir) "system-assembly-")))
(defn- host []
  (let [tools (atom {}) commands (atom {}) hooks (atom {}) active (atom ["read" "bash" "board_finish" "clj_devops" "wait"])]
    #js {:registerTool (fn [d] (swap! tools assoc (.-name d) d))
         :registerCommand (fn [n d] (swap! commands assoc n d))
         :on (fn [n f] (swap! hooks assoc n f))
         :getActiveTools (fn [] (clj->js @active))
         :setActiveTools (fn [v] (reset! active (vec (js->clj v))) (js/Promise.resolve nil))
         :sendUserMessage (fn [& _]) :tools tools :commands commands :hooks hooks :active active}))
(defn- ctx [root id]
  (let [file (path/join root ".sessions" (str id ".jsonl"))]
    #js {:cwd root :hasUI false :mode "print"
         :sessionManager #js {:getSessionId (fn [] id) :getSessionFile (fn [] file)
                              :appendCustomEntry (fn [kind data]
                                (fs/mkdirSync (path/dirname file) #js {:recursive true})
                                (fs/appendFileSync file (str (js/JSON.stringify #js {:type "custom" :customType kind :data data}) "\n")))}}))
(defn- sub [root id]
  #js {:cwd root :agent #js {:id id :kind "sub"} :sessionManager (.-sessionManager (ctx root (str "sub-" id)))})
(defn- install [root opts]
  (let [pi (host)] (system/reset-state!) (system/install! pi (assoc opts :root root)) pi))
(defn- start [pi root seed]
  ((.-handler (get @(.-commands pi) "herd")) seed (ctx root "session-1")))
(defn- execute [pi name call args context]
  ((.-execute (get @(.-tools pi) name)) call (clj->js args) nil nil context))
(defn- error? [result]
  (boolean (:isError (if (map? result) result (js->clj result :keywordize-keys true)))))
(defn- s5! [root term]
  (p/let [_ (store/create-mission! root {:slug "session-1" :seed "S5" :ctx (ctx root "session-1")
                                          :now "2026-11-14T00:00:00.000Z"
                                          :tenure {:tenure-id "T-1" :index 1 :started-at "2026-11-14T00:00:00.000Z" :ended-at nil}})
          _ (store/update-mission! root "session-1" {:barrier {:from :s4 :to :s5 :retired-tenure "T-1" :successor-tenure "T-2" :at "2026-11-14T00:00:00.000Z"}})
          board (store/write-board! root "session-1" (assoc (model/initial-board {:mode :swarm}) :tenure-id "T-1" :tenure {:term term :phase :swarm} :attach-ready false))]
    board))

(t/describe "full system assembly"
  (fn []
    (t/it "restores only the session-bound mission after restart"
      (fn []
        (p/let [r (root) pi (install r {}) _ (start pi r "Build parser")
                mission (store/read-mission r "session-1") board (store/read-board r "session-1")
                pi2 (install r {}) restored (system/ensure-focus! (ctx r "session-1") r)
                other (system/ensure-focus! (ctx r "other") r)
                denied (execute pi2 "review" "call" {} (ctx r "other"))]
          (t/to-be (:ok mission) true) (t/to-be (get-in mission [:mission :stage]) :s1)
          (t/to-be (empty? (:tasks board)) true)
          (t/to-be (fs/existsSync (str r "/.herd/focus.edn")) false)
          (t/to-be restored "session-1") (t/to-be other nil) (t/to-be (error? denied) true))))
    (t/it "schedules the nudge ladder and resets it on progress"
      (fn []
        (p/let [r (root) scheduled (atom []) delivered (atom 0)
                pi (install r {:deliver-nudge (fn [_] (swap! delivered inc))
                               :set-timeout (fn [f ms] (swap! scheduled conj ms) (f) 1) :clear-timeout (fn [_])})
                c (ctx r "session-1") _ (start pi r "Nudge")
                end (get @(.-hooks pi) "agent_end") tool (get @(.-hooks pi) "tool_execution_end")
                _ (system/before-agent-start! #js {:prompt ""} c) _ (end #js {:messages #js []} c)
                _ (system/before-agent-start! #js {:prompt ""} c) _ (end #js {:messages #js []} c)
                _ (system/before-agent-start! #js {:prompt ""} c) _ (end #js {:messages #js []} c)
                _ (tool #js {:toolName "board_comment" :isError false} c)
                _ (system/before-agent-start! #js {:prompt ""} c) _ (end #js {:messages #js []} c)]
          (t/to-equal (mapv #(system/next-nudge-delay % false) (range 7)) [0 30000 60000 120000 240000 300000 300000])
          (t/to-be (system/next-nudge-delay 5 true) 0)
          (t/to-equal @scheduled [0 30000 60000 0]) (t/to-be @delivered 4))))
    (t/it "queues a nudge without a channel and suppresses it after ask_user"
      (fn []
        (p/let [r (root) pi (install r {:set-timeout (fn [f _] (f) 1) :clear-timeout (fn [_])})
                _ (js-delete pi "sendUserMessage") c (ctx r "session-1") _ (start pi r "Queue")
                end (get @(.-hooks pi) "agent_end") tool (get @(.-hooks pi) "tool_execution_end")
                _ (end #js {:messages #js []} c) first (system/consume-nudge!) second (system/consume-nudge!)
                _ (system/before-agent-start! #js {:prompt ""} c) _ (tool #js {:toolName "ask_user" :isError false} c)
                _ (end #js {:messages #js []} c) suppressed (system/consume-nudge!)]
          (t/to-be (some? first) true) (t/to-be second nil) (t/to-be suppressed nil))))
    (t/it "backs off disconnects and stalls on quota"
      (fn []
        (p/let [r (root) scheduled (atom []) pi (install r {:set-timeout (fn [_ ms] (swap! scheduled conj ms) 1) :clear-timeout (fn [_]) :deliver-retry (fn [_])})
                c (ctx r "session-1") _ (system/before-agent-start! #js {:prompt ""} c)
                end (get @(.-hooks pi) "agent_end") event #js {:messages #js [#js {:role "assistant" :stopReason "aborted"}]}
                _ (end event c) _ (end event c) _ (end event c) delays (vec @scheduled)
                _ (end #js {:userAborted true :messages #js [#js {:role "assistant" :stopReason "aborted"}]} c)
                cancelled (get-in @system/state [:upstream :attempts])
                _ (end event c) _ (end #js {:error "insufficient_quota" :messages #js [#js {:role "assistant" :stopReason "error"}]} c)]
          (t/to-equal delays [5000 10000 20000]) (t/to-be cancelled 0)
          (t/to-be (get-in @system/state [:upstream :stalled]) true))))
    (t/it "does not nudge after mission completion"
      (fn []
        (p/let [r (root) scheduled (atom [])
                pi (install r {:deliver-nudge (fn [_]) :set-timeout (fn [_ ms] (swap! scheduled conj ms) 1) :clear-timeout (fn [_])})
                c (ctx r "session-1") _ (start pi r "Complete")
                sha (apply str (repeat 64 "a")) dir (str r "/herd/session-1")
                _ (fs/writeFileSync (str dir "/s5-report.md") (str "---\nreport_sha256: " sha "\n---\n"))
                _ (store/update-mission! r "session-1" {:barrier {:from :s4 :to :s5 :retired-tenure "T-1" :successor-tenure "T-2" :at "2026-11-14T00:00:00.000Z"}
                                                        :approval {:revision 0 :report-sha256 sha :token "t"}})
                _ (system/ensure-focus! c r) _ (system/before-agent-start! #js {:prompt ""} c)
                _ ((get @(.-hooks pi) "agent_end") #js {:messages #js []} c)]
          (t/to-be (count @scheduled) 0))))
    (t/it "creates S5 finding tasks and asks the initial empty-ledger question"
      (fn []
        (p/let [r (root) calls (atom []) pi (install r {:subagent (fn [req] (swap! calls conj req) {:ok true :agent-id "A"})})
                _ (s5! r 0) _ (aset js/globalThis "__herdSubagentBindings" #js {:session1x "session-1"})
                c (sub r "R1") _ (system/before-agent-start! #js {:prompt "[HERD_ROLE: Reviewer nonce=session1x]\nreview"} c)
                result (execute pi "review" "call" {:summary_markdown "review" :findings [{:key "P1" :value "repair"}]} c)
                board (board-store/read-board (board-store/open-board r "session-1"))
                r2 (root) asked (atom 0) pi2 (install r2 {:ask-user (fn [_] (swap! asked inc) {:ok true :answer "yes"})})
                _ (s5! r2 0) c2 (sub r2 "R2")
                _ (system/before-agent-start! #js {:prompt "[HERD_ROLE: Reviewer nonce=session1x]\nreview"} c2)
                result2 (execute pi2 "review" "call" {} c2) board2 (board-store/read-board (board-store/open-board r2 "session-1"))]
          (t/to-be (error? result) false) (t/to-be (pos? (count (:tasks board))) true)
          (t/to-be (pos? (count @calls)) true) (t/to-be (error? result2) false)
          (t/to-be @asked 1) (t/to-be (get-in board2 [:tenure :initial-question-asked?]) true))))
    (t/it "uses the DevOps subagent port and fails closed when absent"
      (fn []
        (p/let [r (root) requests (atom [])
                pi (install r {:subagent (fn [request]
                                           (swap! requests conj request)
                                           (let [id (second (re-find #"HERD_DEVOPS_CALL: ([A-Za-z0-9_-]+)" (:prompt request)))
                                                 dir (str (:artifacts-dir request) "/devops-reports")]
                                             (fs/mkdirSync dir #js {:recursive true})
                                             (fs/writeFileSync (str dir "/" id ".edn") (ufss/canonical {:status "devops-report" :report-markdown "report" :inspected-paths ["src/herd/system.cljs"]}))
                                             {:ok true :session-file (str dir "/child.jsonl")}))})
                _ (start pi r "DevOps") result (execute pi "devops" "call" {:verbose_intent "inspect"} (ctx r "session-1"))
                r2 (root) _ (js-delete js/globalThis "__herdHost") _ (js-delete js/globalThis "__herdRunDevops")
                pi2 (install r2 {}) _ (start pi2 r2 "DevOps missing")
                failed (execute pi2 "devops" "call" {:verbose_intent "inspect"} (ctx r2 "session-1"))]
          (t/to-be (error? result) false) (t/to-be (:role (first @requests)) "Plan DevOps")
          (t/to-be (:cwd (first @requests)) r) (t/to-be (error? failed) true)
          (t/to-be (.-status (.-__herdHealth js/globalThis)) "degraded"))))))
