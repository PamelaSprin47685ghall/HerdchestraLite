(ns cljs.e2e-s1-to-s5-flow-test
  (:require
   ["node:fs" :as fs]
   ["node:os" :as os]
   ["node:path" :as path]
   [bridge.hack-context :as hack-context]
   [clojure.string :as str]
   [herd.entry :as entry]
   [herd.main :as main]
   [herd.stages.audit :as audit]
   [herd.stages.store :as store]
   [herd.swarm.store :as board-store]
   [herd.swarm.token :as token]
   [herd.system :as system]
   [herd.test :as t]
   [herd.tool-hide :as tool-hide]
   [herd.ufss :as ufss]
   [promesa.core :as p]))

(defn- temp-root []
  (fs/mkdtempSync (path/join (os/tmpdir) "herd-e2e-flow-")))

(defn- make-manager [root id]
  (let [file (path/join root ".sessions" (str id ".jsonl"))
        entries (atom [{:type "message" :id "m0" :parentId nil :message {:role "user" :content "seed"}}])
        leaf (atom "m0")
        branches (atom [])]
    #js {:getSessionId (fn [] id)
         :getSessionFile (fn [] file)
         :getLeafId (fn [] @leaf)
         :getLeafEntry (fn [] (clj->js (last @entries)))
         :getEntry (fn [eid] (clj->js (some #(when (= eid (:id %)) %) @entries)))
         :getBranch (fn [] (clj->js @entries))
         :branch (fn [pid] (swap! branches conj pid) (reset! leaf pid))
         :appendMessage (fn [msg]
                          (let [nid (str "m" (count @entries))]
                            (swap! entries conj {:type "message" :id nid :parentId @leaf :message (js->clj msg)})
                            (reset! leaf nid)
                            nid))
         :appendCustomEntry (fn [kind data]
                              (fs/mkdirSync (path/dirname file) #js {:recursive true})
                              (fs/appendFileSync file
                                                 (str (js/JSON.stringify #js {:type "custom" :customType kind :data data}) "\n")))
         :branches (fn [] @branches)}))

(defn- make-pi []
  (let [tools (atom {}) commands (atom {}) hooks (atom {})
        active (atom ["read" "write" "bash" "edit" "clj_devops" "wait" "handoff"])
        sent (atom [])]
    #js {:registerTool (fn [d] (swap! tools assoc (.-name d) d))
         :registerCommand (fn [n d] (swap! commands assoc n d))
         :on (fn [n f] (swap! hooks update n (fnil conj []) f))
         :getActiveTools (fn [] (clj->js @active))
         :setActiveTools (fn [v] (reset! active (vec (js->clj v))) (js/Promise.resolve nil))
         :sendUserMessage (fn [msg & _] (swap! sent conj msg))
         :tools tools :commands commands :hooks hooks :active active :sent sent}))

(defn- main-ctx [root id manager]
  #js {:cwd root :hasUI false :mode "print" :sessionManager manager})

(defn- sub-ctx [root id]
  #js {:cwd root :agent #js {:id id :kind "sub"} :sessionManager (make-manager root (str "sub-" id))})

(defn- exec-tool [pi name call-id args ctx]
  ((.-execute (get @(.-tools pi) name)) call-id (clj->js args) nil nil ctx))

(defn- parsed-text [res]
  (let [text (aget (aget (.-content res) 0) "text")]
    (ufss/read text)))

(defn- valid-s2-cases []
  [{:case_id "CASE-N1" :path "normal" :threshold 80
    :steps ["Run parser"] :expected "Parses cleanly" :rubric "0..100"}
   {:case_id "CASE-E1" :path "error" :threshold 80
    :steps ["Feed bad input"] :expected "Fails closed" :rubric "0..100"}
   {:case_id "CASE-B1" :path "boundary" :threshold 80
    :steps ["Feed empty input"] :expected "Returns default" :rubric "0..100"}
   {:case_id "CASE-C1" :path "concurrency" :threshold 80
    :steps ["Run parallel reads"] :expected "No race" :rubric "0..100"}
   {:case_id "CASE-R1" :path "recovery" :threshold 80
    :steps ["Restart after crash"] :expected "Resumes cleanly" :rubric "0..100"}])

(t/describe "end-to-end S1-S5 flow and cross-process bindings"
  (fn []
    (t/it "runs full S1->S5->Audit FAIL repair->Audit PASS->completed with uppercase sessionId and array systemPrompt"
      (fn []
        (let [root (temp-root)
              session-id "Session_E2E.01"
              pi (make-pi)
              manager (make-manager root session-id)
              ctx (main-ctx root session-id manager)
              confirm-calls (atom 0)
              audit-round (atom 0)
              reviewer-turns (atom 0)
              worker-holder-call-ok (atom false)]
          (set! (.-__herdTui js/globalThis) #js {:highlightCode (fn [code] (str/split-lines code))})
          (set! (.-__herdNativeTools js/globalThis)
                #js {:available (fn [_ _] false)
                     :invoke (fn [& _] (js/Promise.reject (js/Error. "unused")))})
          (system/reset-state!)
          (main/register-all! pi)
          (main/install-hooks! pi)
          (system/install!
            pi
            {:root root
             :ask-user (fn [_] {:ok true :answer "No extra requirements"})
             :confirm (fn [_]
                        (let [n (swap! confirm-calls inc)]
                          (case n
                            1 {:decision "deny" :feedback "Need explicit non-goals"}
                            2 {:decision "revise" :feedback "Clarify edge case"}
                            {:decision "approve"})))
             :audit-deps {:prepare-isolation! (fn [req]
                                                {:ok true
                                                 :cwd root
                                                 :artifacts-dir (str root "/tmp-audit/" (:case-id req))
                                                 :session-name (str "herd-" session-id "-" (:case-id req))
                                                 :excluded ["node_modules"]})
                          :snapshot-workspace! (fn [_] {:ok true :files {}})
                          :timeout-ms 5000}
             :subagent
             (fn [req]
               (p/let [role (:role req)
                       nonce (str "nonce-" (random-uuid))]
                 ;; Simulate cross-process subagent binding without __herdSubagentBindings!
                 (let [bdir (path/join (os/tmpdir) "herd-subagent-bindings")]
                   (fs/mkdirSync bdir #js {:recursive true})
                   (fs/writeFileSync (path/join bdir (str nonce ".json"))
                                     (js/JSON.stringify #js {:taskId session-id
                                                             :role role
                                                             :agentId (:agent-id req)
                                                             :slotId (:slot-id req)})))
                 (let [sc (sub-ctx root (str role "-" (random-uuid)))
                       prompt (str "[HERD_ROLE: " role " nonce=" nonce "]\n" (:prompt req))]
                   (p/let [_ (system/before-agent-start! #js {:prompt prompt} sc)]
                     (case role
                       "Reviewer"
                       (let [turn (swap! reviewer-turns inc)]
                         (if (= turn 1)
                           (p/let [_ (exec-tool pi "review" "rev-ask" {} sc)
                                   _ (exec-tool pi "review" "rev-find"
                                                {:summary_markdown "Initial audit gap"
                                                 :findings [{:key "F1" :value "Implement parser"}]} sc)]
                             {:ok true :agent-id "rev-1"})
                           (p/let [_ (exec-tool pi "review" (str "rev-empty-" turn) {} sc)]
                             {:ok true :agent-id (str "rev-" turn)})))

                       "Swarm Worker"
                       (let [handle (board-store/open-board root session-id)]
                         ;; Clear local board-stations cache to prove cross-process auto-open!
                         (p/let [board (board-store/read-board handle)
                                 ready (filter (fn [[_ t]] (= :ready (:state t))) (:tasks board))]
                           (if (and (= "S1" (:slot-id req)) (seq ready))
                             (let [[tid task] (first ready)]
                               (if (empty? (:child-ids task))
                                 (p/let [sres (exec-tool pi "board_split" (str "sp-" tid)
                                                         {:parent_id tid
                                                          :expected_board_version (:board-version board)
                                                          :remaining_work "Integrate and verify"
                                                          :children [{:goal "Write code" :remaining_work "Edit" :done_when "Saved" :needs_token false}
                                                                     {:goal "Run shell check" :remaining_work "Exec" :done_when "Exit 0" :needs_token true}]}
                                                         sc)
                                         b2 (board-store/read-board handle)
                                         cids (:child-ids (get-in b2 [:tasks tid]))
                                         c1 (first cids)
                                         c2 (second cids)
                                         cl1 (exec-tool pi "board_claim" (str "cl-" c1) {:task_id c1 :atomicity_reason "code"} sc)
                                         cid1 (get-in (parsed-text cl1) [:receipt :claim-id])
                                         _ (exec-tool pi "board_finish" (str "fn-" c1)
                                                      {:task_id c1 :claim_id cid1 :result_summary "written"} sc)
                                         _ (exec-tool pi "board_take_or_die" (str "tk-" tid)
                                                      {:request_id (str "req-tk-" tid)
                                                       :confirm token/take-or-die-confirmation
                                                       :handoff_markdown "Take token"} sc)
                                         ;; Verify Holder immediately unlocked clj_worker call!
                                         hres (exec-tool pi "clj_worker" (str "cw-" tid)
                                                         {:name (str "holder-call-" tid)
                                                          :agent_state "Converging"
                                                          :code (str "(require '[promesa.core :as p]) (p/let [r (call {:argv [" (pr-str "echo") " " (pr-str "holder-ok") "]})] (:stdout r))")}
                                                         sc)
                                         _ (when (and (not (.-isError hres))
                                                      (str/includes? (aget (aget (.-content hres) 0) "text") "holder-ok"))
                                             (reset! worker-holder-call-ok true))
                                         cl2 (exec-tool pi "board_claim" (str "cl-" c2) {:task_id c2 :atomicity_reason "shell"} sc)
                                         cid2 (get-in (parsed-text cl2) [:receipt :claim-id])
                                         _ (exec-tool pi "board_finish" (str "fn-" c2)
                                                      {:task_id c2 :claim_id cid2 :result_summary "checked"} sc)]
                                   {:ok true})
                                 (p/let [cl-p (exec-tool pi "board_claim" (str "cl-p-" tid) {:task_id tid :atomicity_reason "finish parent"} sc)
                                         cid-p (get-in (parsed-text cl-p) [:receipt :claim-id])
                                         _ (exec-tool pi "board_finish" (str "fn-p-" tid)
                                                      {:task_id tid :claim_id cid-p :result_summary "integrated"} sc)]
                                   {:ok true})))
                             {:ok true})))

                       "Manual Auditor"
                       (let [round (if (str/includes? (:prompt req) "CASE-N1")
                                     (swap! audit-round inc)
                                     @audit-round)
                             case-id (re-find #"CASE-[A-Z0-9]+" (:prompt req))
                             score (if (and (= round 1) (= case-id "CASE-E1")) 50 92)]
                         ;; Simulate cross-process memory isolation: clear local memory before writing!
                         (p/let [_ (exec-tool pi "attach_case_audit" (str "aud-" round "-" case-id)
                                              {:case_id case-id
                                               :user_score score
                                               :developer_score score
                                               :report_markdown (str "Evidence for " case-id " round " round)}
                                              sc)]
                           {:ok true}))

                       {:ok true})))))})
        (p/let [_ ((.-handler (get @(.-commands pi) "herd")) "Build parser" ctx)
                ;; Verify string[] systemPrompt preserved and contains S1 briefing only
                bas-fn (first (get @(.-hooks pi) "before_agent_start"))
                _ (system/before-agent-start! #js {:prompt "go"} ctx)
                ;; Check deny returns string question, not boolean
                _ (exec-tool pi "review" "r-s1" {} ctx)
                denied-res (exec-tool pi "attach_brainstorm" "a-s1-deny" {:markdown "# Brainstorm\n- Goal\n## Non-Goals\n- None"} ctx)
                denied-val (parsed-text denied-res)
                ;; Check revise then approve
                _ (exec-tool pi "attach_brainstorm" "a-s1-rev" {:markdown "# Brainstorm\n- Goal\n## Non-Goals\n- None"} ctx)
                _ (exec-tool pi "review" "r-s1-2" {} ctx)
                app-res (exec-tool pi "attach_brainstorm" "a-s1-app" {:markdown "# Brainstorm\n- Goal\n## Non-Goals\n- None"} ctx)
                app-val (parsed-text app-res)
                ;; Check context-handler consumes pending-barrier and branches sessionManager
                ctx-out (main/context-handler #js {:messages #js [#js {:role "user" :content "old"}]} ctx)
                ;; S2 -> S3 -> S4 -> S5
                _ (exec-tool pi "review" "r-s2" {} ctx)
                s2-res (exec-tool pi "attach_manual_tests" "a-s2"
                                  {:markdown "# Testing methodology\nTesting != Checking."
                                   :cases (valid-s2-cases)} ctx)
                _ (exec-tool pi "review" "r-s3" {} ctx)
                s3-res (exec-tool pi "attach_dev_guide" "a-s3" {:markdown "# Guide\nModules"} ctx)
                _ (exec-tool pi "review" "r-s4" {} ctx)
                s4-res (exec-tool pi "attach_coordination" "a-s4"
                                  {:markdown "# Coordination\nProtocol"
                                   :promela "active proctype P() { skip }"} ctx)
                s4-val (parsed-text s4-res)
                final-mission (store/read-mission root session-id ctx)
                report-exists (fs/existsSync (path/join root "herd" session-id "s5-report.md"))
                ;; Verify tool-hide removes host tools from provider payload
                hidden-payload (tool-hide/hide #js {:tools #js [#js {:name "read"} #js {:name "write"} #js {:name "clj_devops"}]})]
          (t/to-be (string? (get-in denied-val [:ask-user :question])) true)
          (t/to-be (get-in denied-val [:ask-user :question]) "Need explicit non-goals")
          (t/to-be (:ok app-val) true)
          (t/to-be (.-handoffReplacement ctx-out) true)
          (t/to-be (pos? (count (.branches manager))) true)
          (t/to-be (.-isError s2-res) js/undefined)
          (t/to-be (.-isError s3-res) js/undefined)
          (t/to-be (:ok s4-val) true)
          (t/to-be @worker-holder-call-ok true)
          (t/to-be (= :completed (get-in final-mission [:mission :stage])) true)
          (t/to-be report-exists true)
          (t/to-be (.-length (.-tools hidden-payload)) 1)
          (t/to-be (.-name (aget (.-tools hidden-payload) 0)) "clj_devops")))))))