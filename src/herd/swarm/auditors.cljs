(ns herd.swarm.auditors
  (:require
   ["node:crypto" :as crypto]
   ["node:fs/promises" :as fs]
   ["node:path" :as path]
   [clojure.string :as string]
   [herd.stages.audit :as audit]
   [herd.stages.parsers :as parsers]
   [herd.stages.paths :as paths]
   [herd.stages.report :as report]
   [herd.stages.scores :as scores]
   [herd.swarm.apply :as apply]
   [herd.swarm.edn :as edn]
   [herd.swarm.model :as model]
   [herd.swarm.store :as store]
   [herd.ufss :as ufss]
   [herd.ui :as ui]
   [herd.util.atomic-write :as atomic]))

;; K-path S5 audit scheduling.
;;
;; The CASE dataset is `.herd/missions/<slug>/s2-cases.edn`; the S2 parsers
;; own the schema. Every auditor receives exactly one CASE record. Audit
;; isolation uses a per-CASE `/tmp` copy and a deterministic tmux session name.
;; Auditor isolation is a guardrail, not a security boundary: the tool surface
;; omits write/mkdir/rm/mv; call is trusted and may touch the real workspace.
;;
;; Injectable ports (all optional except `:subagent`):
;;   :subagent             { role, name, prompt, cwd, artifactsDir, signal?, outputSchema? }
;;                         -> Promise<{ ok, resultMarkdown?, error?, artifactsDir?, sessionFile? }>
;;   :prepare-isolation!   request -> Promise<{ ok, cwd, tmpDir?, sessionName?, excluded?, cleanup? }>
;;   :snapshot-workspace!  { root, paths } -> Promise<{ ok, files }>
;;   :clock                () -> epoch-ms
;;   :uuid                 () -> string
;;   :approval-port        report approval port ({ issue(request) })
;;   :recheck-port         report recheck port
;;   :board                open board handle for FAIL repair tasks
;;   :actor                board actor used for repair tasks (default Coordinator)

(def default-audit-timeout-ms (* 30 60 1000))
(def ^:private audit-batch-prefix "herd-audit")
(def ^:private case-id-pattern #"^CASE-[A-Za-z0-9_-]+$")
(def ^:private slug-pattern #"^[a-z0-9][a-z0-9-]{0,63}$")

(defn- text? [value]
  (and (string? value) (pos? (count (string/trim value)))))

(defn- failure [code message data]
  {:ok false :code code :message message :error (merge {:code code :message message} data)})

(defn- finite-score? [value]
  (and (number? value)
       (js/Number.isFinite value)
       (<= 0 value 100)))

(defn- now-ms [deps]
  (if (fn? (:clock deps)) ((:clock deps)) (js/Date.now)))

(defn- new-uuid [deps]
  (if (fn? (:uuid deps)) ((:uuid deps)) (.randomUUID (js/require "node:crypto"))))

(defn- short-token [deps]
  (subs (str (new-uuid deps)) 0 8))

(defn dataset-path [root slug]
  (path/join (or root ".") (paths/s2-cases-path slug)))

(defn contract-paths [slug]
  [(str "plans/" slug "/s1-brainstorm.md")
   (str "plans/" slug "/s2-manual-tests.md")
   (str "plans/" slug "/s3-dev-guide.md")
   (str "plans/" slug "/s4-coordination.md")
   (str "plans/" slug "/s4-coordination.pml")
   (str ".herd/missions/" slug "/s2-cases.edn")])

(defn validate-dataset
  """
Strictly validate a parsed `s2-cases.edn` value. Accepts either the bare
   cases array or `{:cases [...]}`.
"""
  [value]
  (let [cases (cond
                (and (map? value) (contains? value :cases)) (:cases value)
                (sequential? value) value
                :else value)]
    (if-not (sequential? cases)
      (failure :CASE_SCHEMA_INVALID
               "s2-cases.edn must contain a non-empty cases array"
               {:field :cases})
      (let [normalized (parsers/normalize-case-specs cases)]
        (if (:ok normalized)
          {:ok true
           :cases (:cases normalized)
           :case-ids (mapv :case_id (:cases normalized))
           :errors []}
          {:ok false
           :code (or (:code (first (:errors normalized))) :CASE_SCHEMA_INVALID)
           :errors (:errors normalized)
           :message "s2-cases.edn failed strict CASE schema validation"})))))

(defn ^:async read-case-dataset
  """
Read and validate the CASE dataset. `options.dataset` short-circuits I/O and
   is intended for tests and offline migration tooling.
"""
  ([root slug] (read-case-dataset root slug {}))
  ([root slug options]
   (if (contains? options :dataset)
     (validate-dataset (:dataset options))
     (if-not (and (text? root) (text? slug) (re-matches slug-pattern slug))
       (failure :INVALID_ARGUMENT
                "reading s2-cases.edn needs a valid root and slug"
                {:field (if (text? root) :slug :root)})
       (let [target (dataset-path root slug)]
         (try
           (let [value (ufss/read (await (.readFile fs target "utf8")))
                 validated (validate-dataset value)]
             (cond-> validated
               (:ok validated) (assoc :path target)))
           (catch :default error
             (if (= "ENOENT" (.-code error))
               (failure :STALE_CONTROL
                        (str "the CASE dataset is missing: " target)
                        {:path target})
               (failure :CASE_SCHEMA_INVALID
                        (str "the CASE dataset cannot be parsed: " (or (ex-message error) (str error)))
                        {:path target :cause (str error)})))))))))

(defn isolation-path [slug case-id batch-id]
  (path/join "/tmp" (str audit-batch-prefix "-" slug "-" case-id "-" batch-id)))

(defn isolation-session-name [slug case-id]
  (str "herd-" slug "-" case-id))

(defn- excluded? [root source]
  (let [relative (-> (path/relative root source)
                     (string/replace #"\"# "/"))
        segments (string/split relative #"/")]
    (boolean (some #{"node_modules" ".git" ".herd"} segments))))

(defn ^:async copy-repository! [root target]
  (if-not (fn? (.-cp fs))
    (failure :HOST_API_MISMATCH
             "this runtime has no fs.promises.cp; refusing to build an audit copy without isolation"
             {:port :fs.cp})
    (do
      (await (.mkdir fs target #js {:recursive true}))
      (await (.cp fs root target
                  #js {:recursive true
                       :force true
                       :filter (fn [source _destination]
                                 (not (excluded? root source)))}))
      {:ok true
       :tmp-dir target
       :excluded ["node_modules" ".git" ".herd"]})))

(defn ^:async prepare-isolation-default! [deps request]
  (let [slug (:slug request)
        case-id (:case-id request)
        batch-id (:batch-id request)
        root (:root request)
        target (isolation-path slug case-id batch-id)
        artifacts (path/join target ".auditor-artifacts")
        copied (await (copy-repository! root target))]
    (if-not (:ok copied)
      copied
      (do
        (await (.mkdir fs artifacts #js {:recursive true}))
        {:ok true
         :tmp-dir target
         :cwd target
         :artifacts-dir artifacts
         :session-name (isolation-session-name slug case-id)
         :excluded (:excluded copied)
         :cleanup (fn []
                    (.rm fs target #js {:recursive true :force true}))}))))

(defn- hash-file [target]
  (-> (fs/readFile target)
      (.then (fn [buffer]
               (let [hash (.createHash crypto "sha256")]
                 (.update hash buffer)
                 (.digest hash "hex"))))))

(defn ^:async snapshot-file [root relative]
  (let [target (path/join root relative)]
    (try
      (let [stats (await (.stat fs target))
            digest (await (hash-file target))]
        {:path relative
         :sha256 digest
         :stamp {:mtime-ms (.-mtimeMs stats)
                 :size (.-size stats)}
         :missing false})
      (catch :default _
        {:path relative
         :sha256 "missing"
         :stamp nil
         :missing true}))))

(defn ^:async snapshot-workspace-default! [request]
  (let [root (:root request)
        paths (vec (:paths request))
        files (await (js/Promise.all
                       (into-array (mapv (fn [relative] (snapshot-file root relative)) paths))))]
    {:ok true
     :files (vec files)
     :digest (edn/digest-of (mapv (fn [file] [(:path file) (get-in file [:stamp])]) files))}))

(defn- snapshot-signature [snapshot]
  (when (and (map? snapshot) (sequential? (:files snapshot)))
    (edn/canonical
      (->> (:files snapshot)
           (map (fn [file] [(:path file) (boolean (:missing file)) (:stamp file)]))
           (sort-by first)
           vec))))

(defn snapshot-equal? [before after]
  ;; The comparison intentionally uses only the recorded `{mtime-ms, size}`
  ;; stamps. Two different contents with the same stamp are accepted as
  ;; unchanged: A02-15 defines this fast judgement and explicitly forbids
  ;; presenting it as a content hash.
  (and (some? before) (some? after)
       (= (snapshot-signature before) (snapshot-signature after))))

(defn render-case-record [case-spec]
  (edn/canonical case-spec))

(defn build-auditor-prompt [context]
  (let [mission (:mission context)
        case-spec (:case context)
        isolation (:isolation context)
        slug (:slug context)]
    (str "[ROLE: CONCURRENT MANUAL AUDITOR — " (:case_id case-spec) """
 ONLY]

"""
         "Mission: " (or (:mission-id mission) "unknown") " (slug: " slug """
)


"""
         """
Contract paths (frozen by convention; read-only):

"""
         (string/join "\n" (map #(str "- " %) (contract-paths slug))) "\n\n"
         "You own exactly one CASE: " (:case_id case-spec)
         " (path: " (:path case-spec) ", PASS threshold: " (:threshold case-spec) """
/100).

"""
         """
The framework has already validated the CASE dataset. The injected CASE record below is the sole authority for what to execute and how to score; do not read the dataset or other CASE data.


"""
         """
Injected CASE record:

""" (render-case-record case-spec) "\n\n"
         """
Other auditors are attacking the other CASEs in parallel right now. Spend 100% of your budget trying to falsify this single CASE against real software behavior.

"""
         """
Use `clj_auditor` (read-only inspection of the main workspace, tmux pane capture, destructive experiments only inside your isolated copy) and never spawn a subagent.

"""
         "Isolation: your working copy is " (:cwd isolation)
         "; your tmux session name is `" (:session-name isolation) """
`.

"""
         """
The main workspace is strictly read-only. Do not create an evidence directory; your only durable output is the `attach_case_audit` submission.

"""
         """
Automatic tests, CI, builds, coverage, and paperwork are not acceptance evidence.

"""
         "Finish strictly by calling `attach_case_audit` once with case_id: "
         (pr-str (:case_id case-spec)) """
, finite user_score (0..100), finite developer_score (0..100), and complete human-readable report_markdown.

""")))

(defn auditor-request [deps context]
  (let [mission (:mission context)
        case-spec (:case context)
        isolation (:isolation context)
        slug (:slug context)]
    {:role "Manual Auditor"
     :name (str "Auditor-" slug "-" (:case_id case-spec))
     :prompt (build-auditor-prompt context)
     :cwd (:cwd isolation)
     :artifacts-dir (or (:artifacts-dir isolation)
                        (:artifacts-dir deps)
                        (path/join (:root deps) ".herd" "missions" slug "audit" "artifacts"
                                   (:case_id case-spec)))
     :signal (:signal context)
     :tmux-session (:session-name isolation)
     :case-id (:case_id case-spec)
     :tenant "manual-auditor"}))

(defn- subagent-port [deps]
  (let [port (:subagent deps)]
    (cond
      (fn? port) port
      (and (some? port) (fn? (aget port "runSubagent"))) (aget port "runSubagent")
      (and (some? js/globalThis.__herdHost)
           (fn? (.-runSubagent js/globalThis.__herdHost)))
      (fn [request]
        (-> (.runSubagent js/globalThis.__herdHost (clj->js request))
            (.then (fn [value] (js->clj value :keywordize-keys true)))))
      :else nil)))

(defn- ^:async race-with-timeout [promise timeout-ms on-timeout deps case-id]
  ;; The timer is cleared in `finally` so a fast success, a timeout, and a
  ;; rejection all leave no pending handle behind.
  (let [timer (atom nil)
        timeout (js/Promise.
                  (fn [resolve]
                    (reset! timer
                            ((or (:set-timeout deps) js/setTimeout) (fn [] (resolve {:audit-timeout true}))
                             (max 1 timeout-ms)
                             case-id))))]
    (try
      (let [result (await (js/Promise.race (into-array [promise timeout])))]
        (when (and (map? result) (:audit-timeout result))
          (on-timeout))
        result)
      (catch :default error
        {:audit-error (or (ex-message error) (str error))})
      (finally
        (when @timer
          ((or (:clear-timeout deps) js/clearTimeout) @timer)
          (reset! timer nil))))))

(defn- timeout-ms-of [deps options]
  (let [value (or (:timeout-ms options) (:timeout-ms deps) default-audit-timeout-ms)]
    (if (and (number? value) (js/Number.isFinite value) (pos? value))
      (Math/trunc value)
      default-audit-timeout-ms)))

(defn ^:async start-one-auditor [deps context]
  (let [slug (:slug deps)
        case-id (:case_id (:case context))
        batch-id (:batch-id context)
        started-at (now-ms deps)
        prepare (or (:prepare-isolation! deps) prepare-isolation-default!)
        isolation-result (try
                           [:ok (await (prepare {:root (:root deps)
                                                 :slug slug
                                                 :case-id case-id
                                                 :case (:case context)
                                                 :batch-id batch-id
                                                 :mission (:mission context)}))]
                           (catch :default error
                             [:error error]))
        isolation (second isolation-result)]
    (if-not (and (map? isolation) (:ok isolation))
      {:case-id case-id
       :status :isolation-failed
       :started-at started-at
       :finished-at (now-ms deps)
       :error (or (:error isolation)
                  (failure :HOST_API_MISMATCH
                           (str case-id ": the isolated audit copy could not be prepared: "
                                (if (= :error (first isolation-result))
                                  (str (second isolation-result))
                                  "unknown isolation failure"))
                           {:case-id case-id
                            :cause (when (= :error (first isolation-result))
                                     (str (second isolation-result)))}))}
      (let [controller (js/AbortController.)
            request (auditor-request deps (assoc context :isolation isolation))
            subagent (subagent-port deps)
            outcome (if-not subagent
                      {:audit-error "no subagent port"}
                      (await (race-with-timeout
                               (try
                                 (js/Promise.resolve
                                   (subagent (assoc request
                                                    :signal (.-signal controller))))
                                 (catch :default error
                                   (js/Promise.reject error)))
                               (timeout-ms-of deps context)
                               (fn [] (.abort controller))
                               deps
                               case-id)))]
        (cond
          (and (map? outcome) (:audit-timeout outcome))
          {:case-id case-id
           :status :timeout
           :isolation isolation
           :started-at started-at
           :finished-at (now-ms deps)
           :error (failure :AUDIT_TIMEOUT
                           (str case-id ": audit timed out after "
                                (timeout-ms-of deps context) "ms")
                           {:case-id case-id
                            :timeout-ms (timeout-ms-of deps context)})}

          (and (map? outcome) (false? (:ok outcome)))
          {:case-id case-id
           :status :aborted
           :isolation isolation
           :started-at started-at
           :finished-at (now-ms deps)
           :error (failure :AUDIT_ABORTED
                           (str case-id ": auditor reported failure: "
                                (or (:error outcome) "aborted"))
                           {:case-id case-id :cause (:error outcome)})}

          (and (map? outcome) (:audit-error outcome))
          {:case-id case-id
           :status :aborted
           :isolation isolation
           :started-at started-at
           :finished-at (now-ms deps)
           :error (failure :AUDIT_ABORTED
                           (str case-id ": auditor failed: " (:audit-error outcome))
                           {:case-id case-id :cause (:audit-error outcome)})}

          :else
          (let [returned outcome
                submitted (await (audit/read-submission (:root deps) slug case-id nil))]
            (if (:ok submitted)
              {:case-id case-id
               :status :submitted
               :isolation isolation
               :submission (:submission submitted)
               :submission-path (:path submitted)
               :started-at started-at
               :finished-at (now-ms deps)
               :auditor-response returned}
              {:case-id case-id
               :status :missing
               :isolation isolation
               :started-at started-at
               :finished-at (now-ms deps)
               :auditor-response returned
               :error (:error submitted)})))))))

(defn ^:async start-auditors!
  """
Start all K auditors concurrently from already validated case specs.
   Every auditor gets exactly one CASE record; the function never serializes
   or skips a CASE.
"""
  [deps case-specs options]
  (let [specs (vec case-specs)
        batch-id (or (:batch-id options)
                     (str "audit-" (:slug deps) "-" (short-token deps)))]
    (if (empty? specs)
      (failure :CASE_SCHEMA_INVALID "the audit batch has no CASE records" {:field :case-specs})
      (let [contexts (mapv (fn [case-spec]
                             {:batch-id batch-id
                              :mission (:mission deps)
                              :case case-spec
                              :slug (:slug deps)
                              :root (:root deps)})
                           specs)
            promises (mapv (fn [context] (start-one-auditor deps context)) contexts)
            results (vec (await (js/Promise.all (into-array promises))))]
        {:ok (every? #(= :submitted (:status %)) results)
         :batch-id batch-id
         :case-specs specs
         :results results
         :submissions (vec (keep :submission results))
         :timeouts (vec (keep (fn [result]
                                (when (= :timeout (:status result))
                                  (:case-id result)))
                              results))
         :errors (vec (keep :error results))}))))

(defn- aggregate-input [deps case-specs submissions before after mission environment]
  {:case-specs case-specs
   :submissions submissions
   :snapshot-before before
   :snapshot-after after
   :contract {:mission-id (or (:mission-id mission) (:mission-id deps) "unknown")
              :revision (or (:revision mission) 0)}
   :audit {:environment environment
           :limitations (or (:limitations deps)
                            "isolated /tmp copies exclude node_modules, .git, and .herd; the auditor tool surface omits write")
           :lessons (or (:lessons deps) "")}})

(defn- repair-row? [row]
  (and (:valid row) (not (:passed row))))

(defn- repair-specs [rows]
  (mapv (fn [row]
          {:ledger-key (:case-id row)
           :goal (str "CASE " (:case-id row) " 未达标：final=" (or (:score row) "?")
                      " < threshold=" (:threshold row)
                      "。修复后重跑同一 CASE 的 K 路审计。")
           :remaining-work (str "修复 " (:case-id row) "（" (:path row)
                                "）未达标的实现或证据，保持 S1–S4 交付物与 s2-cases.edn 不变。")
           :done-when (str "重跑审计后 " (:case-id row)
                           " 的 min(user_score, developer_score) >= " (:threshold row)
                           " 且报告仍完整。")
           :needs-token false})
        (filter repair-row? rows)))

(defn- event [board type data context]
  (model/make-event board type data (:board-version board) context))

(defn ^:async bump-wake! [deps reason]
  (let [handle (:board deps)]
    (if-not (and handle (:store handle))
      (failure :INVALID_ARGUMENT "wake needs an open board handle" {:field :board})
      (await ((:transaction (:store handle))
              (fn [current]
                (if (nil? current)
                  {:board nil :events [] :commit false
                   :response (failure :STALE_CONTROL "the board disappeared" {})}
                  (let [woken (model/wake-all current reason)]
                    {:board (:board woken)
                     :events [(:event woken)]
                     :commit true
                     :response {:ok true
                                :wake-epoch (get-in (:board woken) [:wake :epoch])
                                :board-version (get-in (:board woken) [:board-version])}}))))))))

(defn- root-task-by-ledger-key [board ledger-key]
  (first (for [[task-id task] (:tasks board)
               :when (and (nil? (:parent-id task))
                          (= ledger-key (:ledger-key task)))]
           [task-id task])))

(defn ^:async add-repair-tasks! [deps specs]
  (let [handle (:board deps)
        board (when (and handle (:store handle)) (await (store/read-board handle)))]
    (if-not (and handle (:store handle) (model/board-state? board))
      (failure :INVALID_ARGUMENT "repair tasks need an open board handle" {:field :board})
      (let [request-base (str "audit-repair-" (short-token deps))
            new-specs (atom [])
            task-ids (atom [])
            errors (atom [])]
        (doseq [[index spec] (map-indexed vector specs)]
          (let [[task-id task] (root-task-by-ledger-key board (:ledger-key spec))]
            (if-not task
              (swap! new-specs conj spec)
              (do
                (swap! task-ids conj task-id)
                (when (= :done (:state task))
                  (let [reopened (await (apply/apply-board!
                                          {:board handle
                                           :command {:type "reopen"
                                                     :task-id task-id
                                                     :reason "audit FAIL reopens this CASE repair"
                                                     :evidence [(:goal spec)]}
                                           :actor (or (:actor deps) "Coordinator")
                                           :request-id (str request-base "-reopen-" index)
                                           :turn-id "audit:repair"}))]
                    (when-not (:ok reopened)
                      (swap! errors conj (or (:error reopened) reopened)))))
                (when (not= (:goal task) (:goal spec))
                  (let [updated (await (apply/apply-board!
                                         {:board handle
                                          :command {:type "update"
                                                    :task-id task-id
                                                    :fields {:goal (:goal spec)
                                                             :remaining-work (:remaining-work spec)
                                                             :done-when (:done-when spec)}}
                                          :actor (or (:actor deps) "Coordinator")
                                          :request-id (str request-base "-update-" index)
                                          :turn-id "audit:repair"}))]
                    (when-not (:ok updated)
                      (swap! errors conj (or (:error updated) updated)))))))))
        (if (seq @errors)
          (failure (:code (first @errors)) "repair task upsert failed" {:errors @errors})
          (let [added (when (seq @new-specs)
                        (await (apply/apply-board!
                                 {:board handle
                                  :command {:type "add_tasks" :tasks @new-specs}
                                  :actor (or (:actor deps) "Coordinator")
                                  :request-id (str request-base "-add")
                                  :turn-id "audit:repair"})))]
            (if (and added (not (:ok added)))
              added
              {:ok true
               :task-ids (into (vec @task-ids)
                               (or (get-in added [:receipt :task-ids]) []))
               :new-task-ids (vec (or (get-in added [:receipt :task-ids]) []))})))))))

(defn- ^:async run-audit-batch-core! [deps options]
  (let [root (or (:root deps) (:root options))
        slug (or (:slug deps) (:slug options))
        mission (:mission deps)
        subagent (subagent-port deps)
        batch-id (or (:batch-id options)
                     (str "audit-" slug "-" (short-token deps)))
        resume-submissions (vec (or (:resume-submissions options) []))
        resumed-ids (set (map :case_id resume-submissions))]
    (cond
      (not (and (text? root) (text? slug) (re-matches slug-pattern slug)))
      (failure :INVALID_ARGUMENT "the audit batch needs a valid root and slug"
               {:field (if (text? root) :slug :root)})

      (nil? subagent)
      (failure :HOST_API_MISMATCH
               "the host exposes no runSubagent port; auditors cannot start"
               {:port :subagent})

      (not (map? mission))
      (failure :INVALID_ARGUMENT
               "the audit batch needs the mission contract (mission-id, revision)"
               {:field :mission})

      :else
      (let [dataset (await (read-case-dataset root slug
                                              (cond-> {}
                                                (contains? deps :dataset) (assoc :dataset (:dataset deps)))))]
        (cond
          (not (:ok dataset))
          dataset

          :else
          (let [case-specs (:cases dataset)
                snapshot-paths (or (:snapshot-paths deps) (contract-paths slug))
                snapshot-port (or (:snapshot-workspace! deps)
                                  (fn [request] (snapshot-workspace-default! request)))
                before (await (snapshot-port {:root root :paths snapshot-paths :slug slug}))
                specs-to-start (vec (remove (fn [spec]
                                              (contains? resumed-ids (:case_id spec)))
                                            case-specs))
                started (if (:ok before)
                          (if (empty? specs-to-start)
                            {:ok true
                             :batch-id batch-id
                             :case-specs []
                             :results []
                             :submissions []
                             :timeouts []
                             :errors []}
                            (await (start-auditors! deps specs-to-start
                                                    (assoc options :batch-id batch-id))))
                          (failure :INVALID_ARGUMENT
                                   "the pre-audit workspace snapshot failed"
                                   {:snapshot before}))] (if-not (:ok before)
                                                           started
                                                           (let [after (await (snapshot-port {:root root :paths snapshot-paths :slug slug}))
                                                                 mutated? (not (snapshot-equal? before after))
                                                                 resumed-results (mapv (fn [submission]
                                                                                         {:case-id (:case_id submission)
                                                                                          :status :submitted
                                                                                          :submission submission})
                                                                                       resume-submissions)
                                                                 results (into resumed-results (:results started))
                                                                 submissions (into (vec resume-submissions) (:submissions started))
                                                                 timeout-errors (mapv :error (:timeouts started))
                                                                 all-errors (vec (concat (:errors started)
                                                                                         (keep :error (:results started))
                                                                                         timeout-errors))
                                                                 aggregate (if mutated?
                                                                             nil
                                                                             (scores/aggregate
                                                                               (aggregate-input deps case-specs submissions
                                                                                                before after mission
                                                                                                (str "single main workspace; isolated /tmp copies; "
                                                                                                     "tmux sessions " "herd-" slug "-<CASE>"))))
                                                                 base {:batch-id (:batch-id started)
                                                                       :slug slug
                                                                       :case-ids (:case-ids dataset)
                                                                       :case-specs case-specs
                                                                       :results results
                                                                       :submissions submissions
                                                                       :timeouts (:timeouts started)
                                                                       :errors all-errors
                                                                       :snapshot-before before
                                                                       :snapshot-after after
                                                                       :aggregate aggregate
                                                                       :mandatory "Automatic tests, CI, builds, and coverage are never acceptance evidence."}]
                                                             (cond
                                                               mutated?
                                                               (merge base
                                                                      {:ok false
                                                                       :state :workspace-mutated
                                                                       :verdict :INCOMPLETE
                                                                       :code :AUDIT_WORKSPACE_MUTATED
                                                                       :message "the main workspace changed while auditors were running"
                                                                       :errors (conj all-errors
                                                                                     (failure :AUDIT_WORKSPACE_MUTATED
                                                                                              "the main workspace changed while auditors were running"
                                                                                              {:field :snapshot-after}))})

                                                               (and (not (:ok aggregate))
                                                                    (not= :FAIL (:verdict aggregate)))
                                                               (let [first-error (or (first all-errors)
                                                                                     (first (:invalid aggregate))
                                                                                     (first (:errors aggregate)))]
                                                                 (merge base
                                                                        {:ok false
                                                                         :state :incomplete
                                                                         :verdict (or (:verdict aggregate) :INCOMPLETE)
                                                                         :code (or (:code first-error)
                                                                                   (when (seq (:timeouts started)) :AUDIT_TIMEOUT)
                                                                                   :AUDIT_MISSING)
                                                                         :stable-order (:case-ids dataset)}))

                                                               (= :PASS (:verdict aggregate))
                                                               (let [report-result (await (report/write-report!
                                                                                            root slug aggregate
                                                                                            {:approval-port (:approval-port deps)
                                                                                             :recheck-port (:recheck-port deps)}))]
                                                                 (merge base
                                                                        {:ok (boolean (:ok report-result))
                                                                         :state (if (:ok report-result) :closed :report-refused)
                                                                         :verdict :PASS
                                                                         :report report-result
                                                                         :approval (:approval report-result)
                                                                         :code (when-not (:ok report-result) (:code report-result))
                                                                         :errors (if (:ok report-result)
                                                                                   (:errors aggregate)
                                                                                   (or (:errors report-result)
                                                                                       [(failure (or (:code report-result) :APPROVAL_REQUIRED)
                                                                                                 (or (:message report-result)
                                                                                                     "the PASS report could not be issued") {})]))}))

                                                               :else
                                                               (let [specs (repair-specs (:rows aggregate))
                                                                     repair (if (and (seq specs) (some? (:board deps)))
                                                                              (await (add-repair-tasks! deps specs))
                                                                              {:ok false
                                                                               :error (failure :INVALID_ARGUMENT
                                                                                               "FAIL repair needs an open board handle"
                                                                                               {:field :board})})
                                                                     wake (if (and (:ok repair) (some? (:board deps)))
                                                                            (await (bump-wake! deps :audit-fail-repair))
                                                                            nil)]
                                                                 (merge base
                                                                        {:ok false
                                                                         :state :repair
                                                                         :verdict :FAIL
                                                                         :code :AUDIT_FAIL
                                                                         :repair {:specs specs
                                                                                  :task-ids (:task-ids repair)
                                                                                  :repaired (boolean (:ok repair))
                                                                                  :error (:error repair)}
                                                                         :wake wake
                                                                         :stable-order (:case-ids dataset)
                                                                         :message "one or more CASEs fell below threshold; repair tasks were written to the board"})))))))))))

;; ---------------------------------------------------------------------------
;; Audit batch state (S5 idempotency)
;;
;; `.herd/missions/<slug>/audit/batch.edn` records the current batch:
;;   {:batch-id "audit-demo-1a2b3c4d"
;;    :started-at <epoch-ms>
;;    :finished-at <epoch-ms>
;;    :case-ids ["CASE-A" ...]
;;    :state :running | :pass | :repair | :pending
;;    :verdict :PASS | :FAIL | :INCOMPLETE
;;    :timeouts [...]
;;    :case-results [{:case-id ... :status ...}]
;;    :error-codes [...]
;;    :history [<previous completed records, newest last, max 5>]}
;;
;; Entry rules:
;;   :running / :pass -> return the recorded result; start no auditor.
;;   :repair          -> open a new batch; the old record moves to :history.
;;   :pending         -> retry the same batch id and reuse durable submissions.
;;   corrupt state    -> fail closed; never rebuild or overwrite the file.

(def ^:private batch-states #{:running :pass :repair :pending})
(def ^:private batch-verdicts #{:PASS :FAIL :INCOMPLETE})
(def ^:private batch-history-limit 5)

(defn batch-state-path [root slug]
  (path/join root ".herd" "missions" slug "audit" "batch.edn"))

(defn- valid-batch-record? [value]
  (and (map? value)
       (text? (:batch-id value))
       (or (number? (:started-at value)) (string? (:started-at value)))
       (sequential? (:case-ids value))
       (every? string? (:case-ids value))
       (contains? batch-states (:state value))
       (or (nil? (:verdict value)) (contains? batch-verdicts (:verdict value)))
       (or (nil? (:history value)) (sequential? (:history value)))))

(defn ^:async read-batch-state!
  """
Read the current batch record. A missing file is a clean slate; an
   unreadable or invalid record is corrupt and MUST fail closed.
"""
  [root slug]
  (let [target (batch-state-path root slug)]
    (try
      (let [value (ufss/read (await (.readFile fs target "utf8")))]
        (if (valid-batch-record? value)
          {:ok true :record value :path target}
          {:ok false
           :code :AUDIT_BATCH_STATE_CORRUPT
           :state :corrupt
           :message (str "the audit batch state is not a valid record: " target)
           :path target}))
      (catch :default error
        (if (= "ENOENT" (.-code error))
          {:ok true :record nil :path target}
          {:ok false
           :code :AUDIT_BATCH_STATE_CORRUPT
           :state :corrupt
           :message (str "the audit batch state cannot be read: "
                         (or (ex-message error) (str error)))
           :path target
           :cause (str error)})))))

(defn ^:async write-batch-state! [root slug record]
  (let [target (batch-state-path root slug)]
    (try
      (await (atomic/write-edn-atomic! target record))
      {:ok true :path target}
      (catch :default error
        {:ok false
         :code :AUDIT_BATCH_STATE_WRITE_FAILED
         :message (str "the audit batch state cannot be written: " (str error))
         :path target
         :cause (str error)}))))

(defn- ^:async clear-case-submissions!
  """
Remove the named `<CASE>.submit.edn` files before a fresh batch. The
   submission files carry no batch marker, so a new batch (including a REPAIR
   retry) needs them gone before its auditors can submit. Each removal names
   exactly one file.
"""
  [root slug case-ids]
  (let [directory (path/join root ".herd" "missions" slug "audit")]
    (await (js/Promise.all
             (into-array
               (mapv (fn [case-id]
                       (-> (.rm fs (path/join directory (str case-id ".submit.edn"))
                                #js {:force true})
                           (.catch (fn [_] nil))))
                     case-ids))))))

(defn- ^:async collect-submissions! [root slug case-ids]
  (vec
    (remove nil?
            (await (js/Promise.all
                     (into-array
                       (mapv (fn [case-id]
                               (-> (audit/read-submission root slug case-id nil)
                                   (.then (fn [result]
                                            (when (:ok result) (:submission result))))))
                             case-ids)))))))

(defn- history-with [record]
  (vec (take-last batch-history-limit
                  (conj (vec (or (:history record) []))
                        (dissoc record :history)))))

(defn- batch-state-of [result]
  (cond
    (and (:ok result) (= :PASS (:verdict result))) :pass
    (= :FAIL (:verdict result)) :repair
    :else :pending))

(defn- recorded-result [record]
  (cond
    (= :pass (:state record))
    {:ok true
     :state :pass
     :verdict :PASS
     :batch-id (:batch-id record)
     :started-at (:started-at record)
     :finished-at (:finished-at record)
     :case-ids (:case-ids record)
     :timeouts (vec (:timeouts record))
     :case-results (vec (:case-results record))
     :reused true
     :message "the PASS audit batch is already recorded; no auditor was started"}

    (= :running (:state record))
    {:ok false
     :state :running
     :code :AUDIT_IN_PROGRESS
     :verdict (:verdict record)
     :batch-id (:batch-id record)
     :started-at (:started-at record)
     :case-ids (:case-ids record)
     :reused true
     :message "the audit batch is recorded as running; it was not restarted"}))

(defn- completed-record [deps batch-id started-at case-ids state history result]
  {:batch-id batch-id
   :started-at started-at
   :finished-at (now-ms deps)
   :case-ids case-ids
   :state state
   :verdict (or (:verdict result) :INCOMPLETE)
   :timeouts (vec (:timeouts result))
   :case-results (mapv (fn [entry]
                         {:case-id (:case-id entry)
                          :status (:status entry)})
                       (:results result))
   :error-codes (vec (distinct (keep :code (:errors result))))
   :history history})

(defn ^:async run-audit-batch!
  """
Run or resume the S5 K-path audit batch. Entry is idempotent through
   `.herd/missions/<slug>/audit/batch.edn`.
"""
  ([deps] (run-audit-batch! deps {}))
  ([deps options]
   (let [root (or (:root deps) (:root options))
         slug (or (:slug deps) (:slug options))]
     (if-not (and (text? root) (text? slug) (re-matches slug-pattern slug))
       (failure :INVALID_ARGUMENT "the audit batch needs a valid root and slug"
                {:field (if (text? root) :slug :root)})
       (let [current (await (read-batch-state! root slug))]
         (if-not (:ok current)
           current
           (let [record (:record current)
                 existing-state (:state record)]
             (cond
               (or (= :pass existing-state) (= :running existing-state))
               (recorded-result record)

               :else
               (let [dataset (await (read-case-dataset
                                      root slug
                                      (cond-> {}
                                        (contains? deps :dataset)
                                        (assoc :dataset (:dataset deps)))))]
                 (if-not (:ok dataset)
                   dataset
                   (let [case-ids (:case-ids dataset)
                         pending? (= :pending existing-state)
                         batch-id (if pending?
                                    (:batch-id record)
                                    (str "audit-" slug "-" (short-token deps)))
                         started-at (now-ms deps)
                         history (if pending?
                                   (vec (or (:history record) []))
                                   (if record (history-with record) []))
                         resumed (if pending?
                                   (await (collect-submissions!
                                            root slug (:case-ids record)))
                                   [])]
                     (when-not pending?
                       (await (clear-case-submissions! root slug case-ids)))
                     (let [running (await (write-batch-state!
                                            root slug
                                            {:batch-id batch-id
                                             :started-at started-at
                                             :case-ids case-ids
                                             :state :running
                                             :verdict nil
                                             :history history}))]
                       (if-not (:ok running)
                         running
                         (let [attempt (try
                                         [:ok (await (run-audit-batch-core!
                                                       deps
                                                       (assoc options
                                                              :batch-id batch-id
                                                              :resume-submissions resumed)))]
                                         (catch :default error
                                           [:error error]))
                               result (if (= :error (first attempt))
                                        (failure :AUDIT_BATCH_ABORTED
                                                 (str "the audit batch failed: "
                                                      (str (second attempt)))
                                                 {:cause (str (second attempt))})
                                        (second attempt))
                               state (batch-state-of result)
                               completed (await (write-batch-state!
                                                  root slug
                                                  (completed-record deps batch-id started-at
                                                                    case-ids state history result)))]
                           (if (:ok completed)
                             (assoc result :verdict (or (:verdict result) :INCOMPLETE) :batch-state {:ok true
                                                                                                     :state state
                                                                                                     :batch-id batch-id
                                                                                                     :path (:path completed)})
                             (assoc result :batch-state {:ok false
                                                         :state state
                                                         :batch-id batch-id
                                                         :error completed}))))))))))))))))
;; ---------------------------------------------------------------------------
;; attach_case_audit tool

(defn- validate-submission-params [params]
  (let [case-id (:case_id params)
        user (:user_score params)
        developer (:developer_score params)
        markdown (:report_markdown params)]
    (cond
      (not (and (string? case-id) (re-matches case-id-pattern case-id)))
      (failure :AUDIT_UNKNOWN_CASE
               "case_id must be an existing CASE id matching CASE-*"
               {:field :case_id :case-id case-id})

      (not (finite-score? user))
      (failure :AUDIT_INVALID_SCORE
               "user_score must be a finite number in 0..100"
               {:field :user_score :case-id case-id :value user})

      (not (finite-score? developer))
      (failure :AUDIT_INVALID_SCORE
               "developer_score must be a finite number in 0..100"
               {:field :developer_score :case-id case-id :value developer})

      (not (text? markdown))
      (failure :AUDIT_MISSING
               "report_markdown must be a non-empty string"
               {:field :report_markdown :case-id case-id})

      :else
      {:ok true
       :submission {:case_id case-id
                    :user_score user
                    :developer_score developer
                    :report_markdown markdown}})))

(defn ^:async known-case-ids [deps]
  (cond
    (some? (:case-ids deps))
    {:ok true :case-ids (set (:case-ids deps))}

    :else
    (let [dataset (await (read-case-dataset (:root deps) (:slug deps) {}))]
      (if (:ok dataset)
        {:ok true :case-ids (set (:case-ids dataset))}
        dataset))))

(defn ^:async execute-attach-case-audit! [deps params _ctx call-id]
  (let [validated (validate-submission-params params)]
    (if-not (:ok validated)
      validated
      (let [root (or (:root deps) (:root params))
            slug (or (:slug deps) (:slug params))
            known (await (known-case-ids deps))]
        (cond
          (not (:ok known))
          known

          (not (contains? (:case-ids known) (:case_id params)))
          (failure :AUDIT_UNKNOWN_CASE
                   (str (:case_id params) ": no such CASE in the S2 dataset")
                   {:case-id (:case_id params) :field :case_id})

          (not (and (text? root) (text? slug)))
          (failure :INVALID_ARGUMENT
                   "attach_case_audit needs the focused mission root and slug"
                   {:field (if (text? root) :slug :root)})

          :else
          (let [written (await (audit/write-submission-once!
                                 root slug (:case_id params) (:submission validated) nil))]
            (if (:ok written)
              {:ok true
               :case-id (:case_id params)
               :path (:path written)
               :call-id call-id
               :note "one durable submission per CASE per audit batch"}
              written)))))))

(defn tool-definition [deps]
  {:name "attach_case_audit"
   :label "Attach Case Audit"
   :description "Submit the single durable audit result for one CASE: finite dual WTP scores and a complete report."
   :load-mode "essential"
   :parameters {:type "object"
                :additionalProperties false
                :required ["case_id" "user_score" "developer_score" "report_markdown"]
                :properties {:case_id {:type "string" :minLength 1}
                             :user_score {:type "number" :minimum 0 :maximum 100}
                             :developer_score {:type "number" :minimum 0 :maximum 100}
                             :report_markdown {:type "string" :minLength 1}}}
   :renderCall ui/audit-render-call
   :renderResult ui/audit-render-result
   :execute (fn [call-id params _signal _on-update ctx]
              (execute-attach-case-audit!
                deps
                (js->clj (or params #js {}) :keywordize-keys true)
                ctx
                call-id))})

(defn- tool-result [result]
  {:isError (not (:ok result))
   :content [{:type "text" :text (ufss/canonical (if (:ok result)
                                                   result
                                                   (or (:error result) result)))}]})

(defn- bridge-execute [execute]
  (fn [call-id params signal on-update ctx]
    (try
      (-> (js/Promise.resolve (execute call-id params signal on-update ctx))
          (.then (fn [value] (clj->js (tool-result value))))
          (.catch (fn [error]
                    (clj->js (tool-result (failure :INTERNAL
                                                   (or (ex-message error) (str error))
                                                   {}))))))
      (catch :default error
        (clj->js (tool-result (failure :INTERNAL (or (ex-message error) (str error)) {})))))))

(defn register-audit-tools!
  """
Register `attach_case_audit` on the host extension API. Returns the
   registered definition for the entry-point contract.
"""
  [pi deps]
  (when-not (and pi (instance? js/Function (.-registerTool pi)))
    (throw (ex-info "host extension API lacks registerTool"
                    {:code :HOST_API_MISMATCH})))
  (let [definition (tool-definition deps)]
    (.registerTool pi
                   (clj->js
                     (cond-> {:name (:name definition)
                              :label (:label definition)
                              :description (:description definition)
                              :loadMode (:load-mode definition)
                              :parameters (:parameters definition)
                              :execute (bridge-execute (:execute definition))}
                       (:renderCall definition) (assoc :renderCall (:renderCall definition))
                       (:renderResult definition) (assoc :renderResult (:renderResult definition)))))
    (assoc definition :registered true)))

(defn install!
  """
Install the S5 audit batch port for the entry point. This contract does not
   register a model-facing tool: `system.cljs` owns `attach_case_audit`.
"""
  [deps]
  {:runBatch (fn [request]
               (let [request (or request {})
                     options (or (:options request) {})
                     runtime (merge deps (dissoc request :options))]
                 (run-audit-batch! runtime options)))
   :submitToolDefinition (fn [] (tool-definition deps))})