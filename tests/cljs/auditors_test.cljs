(ns cljs.auditors-test
  (:require
   ["node:fs" :as fs]
   ["node:os" :as os]
   ["node:path" :as path]
   [clojure.string :as str]
   [herd.stages.audit :as audit]
   [herd.swarm.auditors :as auditors]
   [herd.swarm.board :as apply]
   [herd.swarm.store :as store]
   [herd.test :as t]
   [herd.util.atomic-write :as atomic]
   [promesa.core :as p]))

(def valid-cases
  [{:case_id "CASE-A" :path "正常" :threshold 80
    :steps ["执行正常路径"] :expected "正常结果" :rubric "0..100"}
   {:case_id "CASE-B" :path "错误" :threshold 80
    :steps ["执行错误路径"] :expected "错误结果" :rubric "0..100"}
   {:case_id "CASE-C" :path "边界" :threshold 80
    :steps ["执行边界路径"] :expected "边界结果" :rubric "0..100"}
   {:case_id "CASE-D" :path "并发" :threshold 80
    :steps ["执行并发路径"] :expected "并发结果" :rubric "0..100"}
   {:case_id "CASE-E" :path "恢复" :threshold 80
    :steps ["执行恢复路径"] :expected "恢复结果" :rubric "0..100"}])

(def mission {:mission-id "M1" :revision 0 :slug "demo"})

(defn- make-workspace []
  (let [root (fs/mkdtempSync (path/join (os/tmpdir) "cljs-auditors-ws-"))]
    (doseq [name ["s1-brainstorm.md" "s2-manual-tests.md" "s3-dev-guide.md"
                  "s4-coordination.md" "s4-coordination.pml"]]
      (fs/mkdirSync (path/join root "herd" "demo") #js {:recursive true})
      (fs/writeFileSync (path/join root "herd" "demo" name) (str "document " name)))
    (fs/mkdirSync (path/join root "herd" "demo") #js {:recursive true})
    (fs/writeFileSync (path/join root "herd" "demo" "s2-cases.edn") "[]")
    root))

(defn- make-deps [root extra]
  (merge {:root root :slug "demo" :mission mission :dataset valid-cases
          :prepare-isolation! (fn [request]
                                {:ok true
                                 :cwd (str "/tmp/herd-audit-demo-" (:case-id request) "-batch")
                                 :artifacts-dir (str "/tmp/herd-audit-demo-" (:case-id request) "/artifacts")
                                 :session-name (str "herd-demo-" (:case-id request))
                                 :excluded ["node_modules"]})
          :timeout-ms 1000
          :set-timeout (fn [_ _] 1)
          :clear-timeout (fn [_] nil)
          :uuid (fn [] "00000000-0000-4000-8000-000000000000")}
         extra))

(defn- submit! [root case-id user developer]
  (audit/write-submission-once!
   root "demo" case-id
   {:case_id case-id
    :user_score user
    :developer_score developer
    :report_markdown (str "report " case-id)} nil))

(defn- seed-board [root]
  (p/let [handle (store/open-board root "demo"
                                   {:store (store/create-memory-store)
                                    :durable false})
          _ (apply/submit-board-command!
             {:board handle
              :command {:type "register_actor" :agentId "Coordinator" :slotId "C"}
              :request-id "seed-audit-board" :turn-id "boot"})]
    handle))

(defn- record-auditor [state request]
  (let [case-id (:case-id request)]
    (swap! (:prompts state) assoc case-id (:prompt request))
    (swap! (:active state) inc)
    (swap! (:peak state) max @(:active state))
    (p/let [_ (submit! (:root state) case-id 90 85)]
      (swap! (:active state) dec)
      {:ok true :result-markdown "done"})))

(defn- full-pass-auditor [root request]
  (let [case-id (:case-id request)]
    (p/let [_ (submit! root case-id 90 85)]
      {:ok true})))

(defn- fail-auditor [root request]
  (let [case-id (:case-id request)
        user (if (= case-id "CASE-B") 70 90)]
    (p/let [_ (submit! root case-id user 90)]
      {:ok true})))

(defn- mutating-auditor [root request]
  (let [case-id (:case-id request)]
    (p/let [_ (submit! root case-id 90 85)
            _ (atomic/write-file-atomic!
               (str root "/herd/demo") "s1-brainstorm.md" "mutated by an auditor")]
      {:ok true})))

(defn- timeout-auditor [root request]
  (if (= (:case-id request) "CASE-A")
    (js/Promise. (fn [_resolve _reject] nil))
    (p/let [_ (submit! root (:case-id request) 90 85)]
      {:ok true})))

(defn- name-of [value]
  (cond
    (nil? value) nil
    (keyword? value) (name value)
    (string? value) value
    :else (str value)))

(defn- same [actual expected]
  (t/to-be (= actual expected) true))

(t/describe "CLJS K-path audit scheduling"
  (fn []
    (t/it "starts K=2 auditors concurrently and injects exactly one CASE per prompt"
      (fn []
        (p/let [root (make-workspace)
                active (atom 0)
                peak (atom 0)
                prompts (atom {})
                state {:active active :peak peak :prompts prompts :root root}
                deps (make-deps root {:subagent (fn [request] (record-auditor state request))})
                result (auditors/start-auditors! deps (take 2 valid-cases) {})
                prompt-a (get @prompts "CASE-A")
                prompt-b (get @prompts "CASE-B")]
          (t/to-be (:ok result) true)
          (same (mapv #(name-of (:status %)) (:results result)) ["submitted" "submitted"])
          (same (mapv :case_id (:submissions result)) ["CASE-A" "CASE-B"])
          (t/to-be @peak 2)
          (t/to-be (str/includes? prompt-a "CASE-A") true)
          (t/to-be (str/includes? prompt-b "CASE-B") true)
          (t/to-be (str/includes? prompt-a "CASE-B") false)
          (t/to-be (str/includes? prompt-b "CASE-A") false)
          (same (:timeouts result) []))))
    (t/it "composes s5-report.md in dataset order and issues one approval on full PASS"
      (fn []
        (p/let [root (make-workspace)
                requests (atom [])
                deps (make-deps root
                                {:subagent (fn [request] (full-pass-auditor root request))
                                 :approval-port {:issue (fn [request]
                                                          (swap! requests conj request)
                                                          {:ok true
                                                           :approval {:revision (:revision request)
                                                                      :report-sha256 (:report-sha256 request)
                                                                      :token "tok"}})}})
                result (auditors/run-audit-batch! deps {})
                report-path (path/join root "herd/demo/s5-report.md")
                markdown (fs/readFileSync report-path "utf8")
                ids ["CASE-A" "CASE-B" "CASE-C" "CASE-D" "CASE-E"]
                order (mapv #(str/index-of markdown %) ids)]
          (t/to-be (:ok result) true)
          (t/to-be (name-of (:verdict result)) "PASS")
          (same (:case-ids result) ids)
          (same (mapv :case-id (get-in result [:aggregate :rows])) ids)
          (t/to-be (get-in result [:report :ok]) true)
          (t/to-be (get-in result [:report :path]) report-path)
          (t/to-be (get-in result [:report :approval :token]) "tok")
          (t/to-be (count @requests) 1)
          (t/to-be (get-in (first @requests) [:case-count]) 5)
          (t/to-be (every? #(>= % 0) order) true)
          (same order (vec (sort order)))
          (t/to-be (str/includes? markdown
                                  "| CASE-A | 正常 | 90 | 85 | 85 | 80 | PASS |") true))))
    (t/it "turns failing CASEs into board root tasks and never writes a report"
      (fn []
        (p/let [root (make-workspace)
                handle (seed-board root)
                deps (make-deps root
                                {:board handle
                                 :actor "Coordinator"
                                 :subagent (fn [request] (fail-auditor root request))})
                result (auditors/run-audit-batch! deps {})
                board (store/read-board handle)
                repair-task (first (filter (fn [[_ task]] (= "CASE-B" (:ledger-key task)))
                                           (:tasks board)))
                task-id (first repair-task)
                task (second repair-task)]
          (t/to-be (:ok result) false)
          (t/to-be (name-of (:verdict result)) "FAIL")
          (t/to-be (get-in result [:repair :repaired]) true)
          (t/to-be (count (get-in result [:repair :task-ids])) 1)
          (t/to-be (count (get-in result [:repair :specs])) 1)
          (t/to-be (some? task-id) true)
          (t/to-be (str/includes? (:goal task) "CASE-B") true)
          (t/to-be (:parent-id task) nil)
          (t/to-be (count (:tasks board)) 1)
          (t/to-be (> (get-in board [:wake :epoch]) 0) true)
          (t/to-be (get-in result [:report]) nil)
          (t/to-be (fs/existsSync (path/join root "herd/demo/s5-report.md")) false))))
    (t/it "rejects duplicate, unknown, out-of-range and missing submissions"
      (fn []
        (p/let [root (make-workspace)
                deps {:root root :slug "demo" :case-ids #{"CASE-A"}}
                first (auditors/execute-attach-case-audit!
                       deps {:case_id "CASE-A" :user_score 90 :developer_score 85
                             :report_markdown "report"} nil "call-1")
                duplicate (auditors/execute-attach-case-audit!
                           deps {:case_id "CASE-A" :user_score 90 :developer_score 85
                                 :report_markdown "report"} nil "call-2")
                unknown (auditors/execute-attach-case-audit!
                         deps {:case_id "CASE-Z" :user_score 90 :developer_score 85
                               :report_markdown "report"} nil "call-3")
                out-of-range (auditors/execute-attach-case-audit!
                              deps {:case_id "CASE-A" :user_score 101 :developer_score 85
                                    :report_markdown "report"} nil "call-4")
                missing (auditors/execute-attach-case-audit!
                         deps {:case_id "CASE-A" :user_score 90 :developer_score 85
                               :report_markdown ""} nil "call-5")]
          (t/to-be (:ok first) true)
          (t/to-be (:memory first) true)
          (t/to-be (name-of (:code duplicate)) "AUDIT_DUPLICATE_CASE")
          (t/to-be (name-of (:code unknown)) "AUDIT_UNKNOWN_CASE")
          (t/to-be (name-of (:code out-of-range)) "AUDIT_INVALID_SCORE")
          (t/to-be (name-of (:code missing)) "AUDIT_MISSING"))))
    (t/it "returns AUDIT_TIMEOUT when an auditor exceeds its deadline"
      (fn []
        (p/let [root (make-workspace)
                deps (make-deps root
                                {:timeout-ms 1
                                 :set-timeout (fn [f _ms] (js/queueMicrotask f) 1)
                                 :subagent (fn [_request]
                                             (js/Promise. (fn [_resolve _reject] nil)))})
                result (auditors/start-auditors! deps [(first valid-cases)] {})]
          (t/to-be (:ok result) false)
          (t/to-be (name-of (get-in result [:results 0 :status])) "timeout")
          (t/to-be (name-of (get-in result [:results 0 :error :code])) "AUDIT_TIMEOUT")
          (same (:timeouts result) ["CASE-A"]))))
    (t/it "validates the CASE dataset strictly before starting any auditor"
      (fn []
        (p/let [root (make-workspace)
                duplicate (auditors/read-case-dataset
                           root "demo"
                           {:dataset [(first valid-cases) (first valid-cases)]})
                threshold (auditors/read-case-dataset
                           root "demo"
                           {:dataset [(assoc (first valid-cases) :threshold 101)]})
                missing-path (auditors/read-case-dataset
                              root "demo"
                              {:dataset (vec (take 2 valid-cases))})]
          (t/to-be (:ok duplicate) false)
          (t/to-be (some #{"CASE_DUPLICATE_ID"}
                         (mapv #(name-of (:code %)) (:errors duplicate))) "CASE_DUPLICATE_ID")
          (t/to-be (:ok threshold) false)
          (t/to-be (some #{"CASE_THRESHOLD_INVALID"}
                         (mapv #(name-of (:code %)) (:errors threshold))) "CASE_THRESHOLD_INVALID")
          (t/to-be (:ok missing-path) false)
          (t/to-be (some #{"CASE_REQUIRED_PATH_MISSING"}
                         (mapv #(name-of (:code %)) (:errors missing-path))) "CASE_REQUIRED_PATH_MISSING"))))
    (t/it "refuses a PASS report when the main workspace changed during the audit"
      (fn []
        (p/let [root (make-workspace)
                deps (make-deps root {:subagent (fn [request] (mutating-auditor root request))})
                result (auditors/run-audit-batch! deps {})]
          (t/to-be (:ok result) false)
          (t/to-be (name-of (:state result)) "workspace-mutated")
          (t/to-be (name-of (:code result)) "AUDIT_WORKSPACE_MUTATED")
          (t/to-be (get-in result [:aggregate :workspace-mutated]) nil)
          (t/to-be (get-in result [:report]) nil)
          (t/to-be (fs/existsSync (path/join root "herd/demo/s5-report.md")) false))))
    (t/it "registers attach_case_audit with the snake_case schema"
      (fn []
        (let [root (make-workspace)
              recorded (atom nil)
              pi (js-obj "registerTool" (fn [definition] (reset! recorded definition)))
              result (auditors/register-audit-tools! pi {:root root :slug "demo"
                                                         :case-ids #{"CASE-A"}})]
          (t/to-be (:registered result) true)
          (t/to-be (.-name @recorded) "attach_case_audit")
          (same (vec (array-seq (.-required (.-parameters @recorded))))
                ["case_id" "user_score" "developer_score" "report_markdown"])
          (t/to-be (.-loadMode @recorded) "essential")
          (t/to-be (fn? (.-execute @recorded)) true))))
    (t/it "returns the recorded PASS batch without starting auditors again"
      (fn []
        (p/let [root (make-workspace)
                starts (atom 0)
                deps (make-deps root
                                {:subagent (fn [request]
                                             (swap! starts inc)
                                             (full-pass-auditor root request))
                                 :approval-port {:issue (fn [request]
                                                          {:ok true
                                                           :approval {:revision (:revision request)
                                                                      :report-sha256 (:report-sha256 request)
                                                                      :token "tok"}})}})
                first (auditors/run-audit-batch! deps {})
                starts-after-first @starts
                second (auditors/run-audit-batch! deps {})
                persisted (auditors/read-batch-state! root "demo")]
          (t/to-be (:ok first) true)
          (t/to-be (name-of (:verdict first)) "PASS")
          (t/to-be starts-after-first 5)
          (t/to-be (:ok second) true)
          (t/to-be (name-of (:state second)) "pass")
          (t/to-be (name-of (:verdict second)) "PASS")
          (t/to-be (:reused second) true)
          (t/to-be (= (:batch-id first) (:batch-id second)) true)
          (t/to-be @starts 5)
          (t/to-be (name-of (get-in persisted [:record :state])) "pass"))))
    (t/it "returns the recorded running batch without launching auditors"
      (fn []
        (p/let [root (make-workspace)
                starts (atom 0)
                _ (auditors/write-batch-state!
                   root "demo"
                   {:batch-id "audit-demo-running"
                    :started-at 1000
                    :case-ids ["CASE-A" "CASE-B"]
                    :state :running
                    :verdict nil
                    :history []})
                deps (make-deps root
                                {:subagent (fn [_request] (swap! starts inc) {:ok true})})
                result (auditors/run-audit-batch! deps {})]
          (t/to-be (:ok result) false)
          (t/to-be (name-of (:state result)) "running")
          (t/to-be (name-of (:code result)) "AUDIT_IN_PROGRESS")
          (t/to-be (:reused result) true)
          (t/to-be (:batch-id result) "audit-demo-running")
          (t/to-be @starts 0))))
    (t/it "opens a new batch after REPAIR, archives the old state and re-submits"
      (fn []
        (p/let [root (make-workspace)
                handle (seed-board root)
                round (atom 1)
                starts (atom 0)
                uuids (atom 0)
                deps (make-deps root
                                {:board handle
                                 :actor "Coordinator"
                                 :uuid (fn []
                                         (swap! uuids inc)
                                         (str "000000" @uuids "-0000-4000-8000-000000000000"))
                                 :subagent (fn [request]
                                             (swap! starts inc)
                                             (let [case-id (:case-id request)
                                                   user (if (and (= case-id "CASE-B") (= 1 @round)) 70 90)]
                                               (p/let [_ (submit! root case-id user 90)]
                                                 {:ok true})))
                                 :approval-port {:issue (fn [request]
                                                          {:ok true
                                                           :approval {:revision (:revision request)
                                                                      :report-sha256 (:report-sha256 request)
                                                                      :token "tok"}})}})
                first (auditors/run-audit-batch! deps {})
                first-persisted (auditors/read-batch-state! root "demo")
                _ (swap! round inc)
                second (auditors/run-audit-batch! deps {})
                second-persisted (auditors/read-batch-state! root "demo")
                history (get-in second-persisted [:record :history])]
          (t/to-be (:ok first) false)
          (t/to-be (name-of (:verdict first)) "FAIL")
          (t/to-be (name-of (get-in first-persisted [:record :state])) "repair")
          (t/to-be (:ok second) true)
          (t/to-be (name-of (:verdict second)) "PASS")
          (t/to-be (name-of (get-in second-persisted [:record :state])) "pass")
          (t/to-be (not= (:batch-id first) (:batch-id second)) true)
          (t/to-be (count history) 1)
          (t/to-be (name-of (get-in history [0 :state])) "repair")
          (t/to-be (get-in history [0 :batch-id]) (:batch-id first))
          (t/to-be @starts 10))))
    (t/it "fails closed on corrupt in-memory batch state and writes no file"
      (fn []
        (p/let [root (make-workspace)
                starts (atom 0)
                _ (auditors/write-batch-state! root "demo" {:batch-id 42})
                deps (make-deps root
                                {:subagent (fn [_request] (swap! starts inc) {:ok true})})
                result (auditors/run-audit-batch! deps {})]
          (t/to-be (:ok result) false)
          (t/to-be (name-of (:state result)) "corrupt")
          (t/to-be (name-of (:code result)) "AUDIT_BATCH_STATE_CORRUPT")
          (t/to-be @starts 0)
          (t/to-be (fs/existsSync (path/join root "herd/demo/audit/batch.edn")) false))))
    (t/it "records a timed-out CASE as pending without blocking the batch"
      (fn []
        (p/let [root (make-workspace)
                deps (make-deps root
                                {:timeout-ms 1
                                 :set-timeout (fn [f _ms case-id]
                                                (when (= case-id "CASE-A")
                                                  (js/queueMicrotask f))
                                                1)
                                 :subagent (fn [request] (timeout-auditor root request))})
                result (auditors/run-audit-batch! deps {})
                persisted (auditors/read-batch-state! root "demo")
                rows (get-in persisted [:record :case-results])
                timeout-row (first (filter #(= "CASE-A" (:case-id %)) rows))]
          (t/to-be (:ok result) false)
          (t/to-be (name-of (:verdict result)) "INCOMPLETE")
          (same (:timeouts result) ["CASE-A"])
          (t/to-be (name-of (get-in persisted [:record :state])) "pending")
          (t/to-be (name-of (get-in persisted [:record :verdict])) "INCOMPLETE")
          (same (get-in persisted [:record :timeouts]) ["CASE-A"])
          (t/to-be (name-of (:status timeout-row)) "timeout"))))
    (t/it "maps auditor refusal and thrown errors to AUDIT_ABORTED"
      (fn []
        (p/let [root (make-workspace)
                declining (make-deps root
                                     {:subagent (fn [_request] {:ok false :error "declined"})})
                throwing (make-deps root
                                    {:subagent (fn [_request] (throw (js/Error. "boom")))})
                declined (auditors/start-auditors! declining [(first valid-cases)] {})
                thrown (auditors/start-auditors! throwing [(first valid-cases)] {})]
          (t/to-be (name-of (get-in declined [:results 0 :status])) "aborted")
          (t/to-be (name-of (get-in declined [:results 0 :error :code])) "AUDIT_ABORTED")
          (t/to-be (name-of (get-in thrown [:results 0 :status])) "aborted")
          (t/to-be (name-of (get-in thrown [:results 0 :error :code])) "AUDIT_ABORTED"))))
    (t/it "treats same-size, same-mtime files as unchanged per the A02-15 fast judgement"
      (fn []
        (let [stamp {:mtime-ms 111 :size 10}
              before {:ok true
                      :files [{:path "herd/demo/s1-brainstorm.md"
                               :sha256 "aaa" :stamp stamp :missing false}]}
              after {:ok true
                     :files [{:path "herd/demo/s1-brainstorm.md"
                              :sha256 "bbb" :stamp stamp :missing false}]}
              resized {:ok true
                       :files [{:path "herd/demo/s1-brainstorm.md"
                                :sha256 "bbb" :stamp (assoc stamp :size 11) :missing false}]}]
          (t/to-be (auditors/snapshot-equal? before after) true)
          (t/to-be (auditors/snapshot-equal? before resized) false))))
    (t/it "installs the audit batch port without registering a tool"
      (fn []
        (let [root (make-workspace)
              installed (auditors/install! {:root root :slug "demo" :dataset valid-cases})
              definition ((:submitToolDefinition installed))]
          (t/to-be (fn? (:runBatch installed)) true)
          (t/to-be (fn? (:submitToolDefinition installed)) true)
          (t/to-be (:name definition) "attach_case_audit")
          (t/to-be (contains? definition :registered) false))))
    (t/it "keeps at most five archived batches in history"
      (fn []
        (p/let [root (make-workspace)
                old-history (mapv (fn [index]
                                    {:batch-id (str "old-" index)
                                     :started-at index
                                     :case-ids ["CASE-A"]
                                     :state :repair
                                     :verdict :FAIL})
                                  (range 5))
                _ (auditors/write-batch-state!
                   root "demo"
                   {:batch-id "audit-demo-old"
                    :started-at 1
                    :case-ids ["CASE-A"]
                    :state :repair
                    :verdict :FAIL
                    :history old-history})
                deps (make-deps root {:subagent (fn [_request] {:ok true})})
                result (auditors/run-audit-batch! deps {})
                persisted (auditors/read-batch-state! root "demo")
                history (get-in persisted [:record :history])]
          (t/to-be (name-of (:state result)) "incomplete")
          (t/to-be (count history) 5)
          (t/to-be (get-in history [0 :batch-id]) "old-1")
          (t/to-be (get-in history [4 :batch-id]) "audit-demo-old"))))))

