(ns herd.swarm.runner
  (:require
   [clojure.string :as string]
   [herd.stages.disclosures :as disclosures]
   [herd.stages.store :as stages-store]
   [herd.stages.tenure :as tenure]
   [herd.swarm.apply :as apply]
   [herd.swarm.edn :as edn]
   [herd.swarm.model :as model]
   [herd.swarm.store :as store]))

;; Single-workspace S5 runner: Reviewer ⇄ Swarm.
;;
;; This namespace is pure orchestration around the board kernel. It never picks
;; a task for an individual, never mutates an actor's private context, and never
;; invents a second board. All persistence goes through the existing swarm
;; store; all subagent launches go through an injectable port:
;;
;;   deps.subagent
;;     (fn [{:role :name :prompt :cwd :artifacts-dir :signal :output-schema}])
;;       -> Promise<{:ok bool :result-markdown? :error? :artifacts-dir? :session-file?}>
;;
;; Tests inject deterministic stubs. Production wires
;; `globalThis.__herdHost.runSubagent` (see README report for the exact JS
;; contract) and converts JS objects at the boundary.

(def default-slot-count 4)
(def max-slot-count 16)
(def ^:private initial-question
  "主工作区已满足契约，看板为空且没有可推进工作。接下来要做什么？请给出新的需求或明确结束。")

(def ^:private reviewer-prompt-text """
[ROLE: CENTRALIZED REVIEWER — PHASE A CLEAN-BREAK JUDGE]
You start on a clean Context Barrier with zero loyalty to your predecessor's sunk cost.
- Inspect the frozen-by-convention `plans/<slug>/s1..s4-*.md` deliverables, the injected CASE records from `.herd/missions/<slug>/s2-cases.edn`, and the real single main workspace using read-only `clj_review`. There is no worktree. Paperwork, task counts, and passing unit tests prove nothing.
- Call `review({ summary_markdown, findings })`:
  - Non-empty `findings: [{ key, value }]`: suspends Reviewer, materializes each item as a root task on the single board, and wakes all `@task` workers (Phase B).
  - Empty `findings: []`: confirms this tenure genuinely satisfies its S1–S4 requirements and single-workspace quiescence; the system then enters K-path audit.
""")

(def ^:private worker-prompt-text """
[ROLE: SWARM AUTONOMOUS WORKER / HOLDER]
No central manager will pick tasks for you. Coordinate solely through the shared board and direct writes under the write gate:
1. Split before claim: if a candidate task still hides independent pieces or separates protected edits from shell checks, call `board_split` first. Parents MUST keep substantive `remaining_work`; children all becoming `done` ONLY restores the parent from `waiting` to `ready` — it NEVER auto-completes the parent.
2. Direct writes apply step by step directly to the real filesystem; a failure keeps everything already written. There is no batch preview and no rollback.
3. Normal workers are forbidden from `call` (`:TOKEN_REQUIRED`). Only when valuable protected work is exhausted, `:needs-token` tasks exist, and the token is free, record `handoff_markdown` and call `board_take_or_die`.
4. Global no-sleep: never call `board_park_slot` while any non-blocking progressable work exists anywhere on the board.
5. The board snapshot below is context, not an assignment. Choose and split your own work.
""")

(defn- text? [value]
  (and (string? value) (pos? (count (string/trim value)))))

(defn- failure [code message data]
  {:ok false :code code :message message :error (merge {:code code :message message} data)})

(defn- now-iso [deps]
  (let [clock (:now deps)]
    (cond
      (fn? clock) (let [value (clock)]
                    (if (string? value) value (.toISOString (js/Date. value))))
      (number? clock) (.toISOString (js/Date. clock))
      :else (.toISOString (js/Date.)))))

(defn- new-uuid [deps]
  (if (fn? (:uuid deps))
    ((:uuid deps))
    (.randomUUID (js/require "node:crypto"))))

(defn- short-token [deps]
  (subs (str (new-uuid deps)) 0 8))

(defn- mission-context
  "Return the mission map injected by deps. Production callers read
   `mission.edn` through `herd.stages.store/read-mission`; tests inject a map."
  [deps]
  (:mission deps))

(defn- board-handle [deps]
  (:board deps))

(defn ^:async read-board-state [deps]
  (let [handle (board-handle deps)]
    (cond
      (and handle (map? handle) (:store handle))
      (await (store/read-board handle))
      (model/board-state? handle) handle
      (and (text? (:root deps)) (text? (:slug deps)))
      (await (store/read-board (:root deps) (:slug deps)))
      :else nil)))

(defn- current-tenure-id [mission board]
  (or (:tenure-id board)
      (get-in mission [:tenure :tenure-id])
      (:tenure-id mission)
      "T-1"))

(defn- current-term [mission board]
  (let [term (get-in board [:tenure :term])]
    (cond
      (integer? term) term
      (integer? (:tenure-seq mission)) (max 0 (dec (:tenure-seq mission)))
      :else 0)))

(defn- mission-slug [deps mission]
  (or (:slug mission) (:slug deps)))

(defn- contract-paths [slug]
  [(str "plans/" slug "/s1-brainstorm.md")
   (str "plans/" slug "/s2-manual-tests.md")
   (str "plans/" slug "/s3-dev-guide.md")
   (str "plans/" slug "/s4-coordination.md")
   (str "plans/" slug "/s4-coordination.pml")
   (str ".herd/missions/" slug "/s2-cases.edn")])

(defn- board-snapshot [board]
  {:board-version (:board-version board)
   :tenure-id (:tenure-id board)
   :review-summary (:review-summary board)
   :holder-id (get-in board [:token-slot :holder-id])
   :tasks (model/task-tree board)
   :progressable (model/progressable-summary board)})

(defn build-reviewer-prompt [context]
  (str reviewer-prompt-text
       "\n\n" (disclosures/current-briefing :s5)
       "\n\nSelf-contained tenure context:\n"
       "- Mission: " (:mission-id context) " (slug: " (:slug context) ")\n"
       "- Seed: " (or (:seed context) "(none recorded)") "\n"
       "- Tenure: " (:tenure-id context) " (term " (:term context) ", initial: "
       (boolean (:initial? context)) ")\n"
       "- Contract paths (frozen by convention; read-only):\n"
       (string/join "\n" (map #(str "  - " %) (:contract-paths context)))
       "\n- Canonical CASE dataset: " (str ".herd/missions/" (:slug context) "/s2-cases.edn")
       "\n- Workspace: " (or (:cwd context) "(cwd unavailable)") "\n"
       "- Board snapshot (context, not an assignment):\n"
       (edn/canonical (or (:board-snapshot context) {}))
       "\n\nFinish by calling `review` exactly once with either non-empty findings "
       "or an empty findings array."))

(defn build-worker-prompt [context]
  (str worker-prompt-text
       "\n\nSelf-contained slot context:\n"
       "- Mission: " (:mission-id context) " (slug: " (:slug context) ")\n"
       "- Tenure: " (:tenure-id context) " (term " (:term context) ")\n"
       "- Slot: " (:slot-id context) " (agent: " (:agent-id context) ")\n"
       "- Workspace: " (or (:cwd context) "(cwd unavailable)") "\n"
       "- Contract paths (read-only):\n"
       (string/join "\n" (map #(str "  - " %) (:contract-paths context)))
       "\n- Board snapshot (context, not an assignment):\n"
       (edn/canonical (or (:board-snapshot context) {}))
       "\n\nWork only through the board tools and the write gate; never stop for a human."))

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

(defn- artifacts-directory [deps slug tenure-id name]
  (let [root (or (:root deps) ".")]
    (str root "/.herd/missions/" slug "/artifacts/" tenure-id "/" name)))

(defn reviewer-request [deps mission board options]
  (let [slug (mission-slug deps mission)
        tenure-id (current-tenure-id mission board)
        term (current-term mission board)
        context {:mission-id (or (:mission-id mission) (:mission-id deps) "unknown")
                 :slug slug
                 :seed (or (:seed mission) (:seed deps))
                 :tenure-id tenure-id
                 :term term
                 :initial? (zero? term)
                 :cwd (or (:root deps) (:cwd deps))
                 :contract-paths (contract-paths slug)
                 :board-snapshot (board-snapshot board)}]
    {:role "Reviewer"
     :name (str "Reviewer-" slug "-" tenure-id)
     :prompt (build-reviewer-prompt context)
     :cwd (or (:root deps) (:cwd deps))
     :artifacts-dir (or (:reviewer-artifacts-dir deps)
                        (artifacts-directory deps slug tenure-id "reviewer"))
     :signal (:signal deps)
     :tenure-id tenure-id
     :term term
     :board-version (:board-version board)}))

(defn ^:async start-reviewer!
  ([deps] (start-reviewer! deps {}))
  ([deps options]
   (let [subagent (subagent-port deps)]
     (if-not subagent
       (failure :HOST_API_MISMATCH
                "the host exposes no runSubagent port; the Reviewer cannot start"
                {:port :subagent})
       (let [board (or (:board-state options) (await (read-board-state deps)))]
         (if-not (model/board-state? board)
           (failure :STALE_CONTROL
                    "the S5 board is missing; seed the tenure board instead of rebuilding it"
                    {:root (:root deps) :slug (:slug deps)})
           (let [mission (or (:mission options) (mission-context deps) {})
                 request (reviewer-request deps mission board options)
                 started (try
                           [:ok (await (subagent request))]
                           (catch :default error
                             [:error error]))]
             (if (= :error (first started))
               (failure :AGENT_SPAWN_FAILED
                        (str "the Reviewer subagent failed to start: " (str (second started)))
                        {:role "Reviewer"
                         :tenure-id (:tenure-id request)
                         :retained true
                         :cause (str (second started))})
               (let [response (second started)]
                 (if (and (map? response) (false? (:ok response)))
                   (failure :AGENT_SPAWN_FAILED
                            (or (:error response) "the Reviewer subagent declined to start")
                            {:role "Reviewer"
                             :tenure-id (:tenure-id request)
                             :retained true
                             :response response})
                   {:ok true
                    :reviewer {:agent-id (or (:agent-id response) (:name request))
                               :name (:name request)
                               :role "Reviewer"
                               :tenure-id (:tenure-id request)
                               :term (:term request)}
                    :request request
                    :response response
                    :board-version (:board-version board)}))))))))))

(defn- write-lock-held? [deps]
  (let [value (:write-lock-held? deps false)]
    (if (fn? value)
      (boolean (value))
      (boolean value))))

(defn quiescence
  "Pure quiescence check for the single-workspace S5 tenure."
  [board options]
  (if-not (model/board-state? board)
    {:ok false
     :reasons [{:code :STALE_CONTROL :message "board is missing"}]
     :board-version nil}
    (let [reasons (atom [])
          tasks (:tasks board)
          actions (:actions board)
          active-actions (->> actions
                              (filter (fn [[_ action]]
                                        (contains? model/active-action-phases (:phase action))))
                              (mapv (fn [[action-id action]] [action-id action])))
          holder-id (get-in board [:token-slot :holder-id])
          holder-responsibility (when holder-id
                                  (model/responsibility-set board holder-id))
          holder-alive? (and holder-id
                             (= :alive (get-in board [:actors holder-id :life-state])))]
      (when (seq tasks)
        (swap! reasons conj {:code :BOARD_NOT_EMPTY
                             :message "the board still holds unfinished tasks"
                             :open-tasks (count tasks)}))
      (when (seq active-actions)
        (swap! reasons conj {:code :RESOURCES_NOT_QUIESCENT
                             :message "an action is in flight or unresolved"
                             :actions (mapv (fn [[id action]]
                                              {:action-id id
                                               :phase (:phase action)
                                               :agent-id (:agent-id action)})
                                            active-actions)}))
      (when (and holder-alive? (seq holder-responsibility))
        (swap! reasons conj {:code :HOLDER_HAS_RESPONSIBILITY
                             :message "the Holder still owes work"
                             :holder-id holder-id
                             :responsibilities (mapv (fn [item] {:kind (:kind item) :id (:id item)})
                                                     holder-responsibility)}))
      (when (true? (:write-lock-held? options))
        (swap! reasons conj {:code :WRITE_LOCK_HELD
                             :message "the workspace write lock is still held"}))
      {:ok (empty? @reasons)
       :reasons @reasons
       :board-version (:board-version board)
       :holder-id holder-id
       :holder-alive? (boolean holder-alive?)})))

(defn- ^:async update-board! [deps f fallback-code]
  (let [handle (board-handle deps)]
    (cond
      (and handle (map? handle) (:store handle))
      (await ((:transaction (:store handle))
              (fn [current]
                (if (nil? current)
                  {:board nil
                   :events []
                   :commit false
                   :response (failure :STALE_CONTROL
                                      "the S5 board disappeared during the transition"
                                      {:path (:board-path handle)})}
                  (let [outcome (f current)]
                    (if-not (:ok outcome)
                      {:board current
                       :events []
                       :commit false
                       :response outcome}
                      {:board (:board outcome)
                       :events (or (:events outcome) [])
                       :commit (not (false? (:commit outcome)))
                       :response (dissoc outcome :board :events :commit)}))))))

      (model/board-state? handle)
      (let [outcome (f handle)]
        (if (:ok outcome)
          (dissoc outcome :board :events :commit)
          outcome))

      :else
      (failure fallback-code
               "no board handle was injected"
               {:field :board}))))

(defn- event [board type data context]
  (model/make-event board type data (:board-version board) context))

(defn ^:async wake-board! [deps reason]
  (update-board!
    deps
    (fn [current]
      (let [woken (model/wake-all current reason)
            next-board (:board woken)
            epoch (get-in next-board [:wake :epoch])]
        {:ok true
         :commit true
         :board next-board
         :wake-epoch epoch
         :events [(:event woken)]}))
    :STALE_CONTROL))

(defn ^:async add-root-tasks! [deps task-specs options]
  (let [specs (vec task-specs)]
    (if (empty? specs)
      (failure :INVALID_ARGUMENT "at least one root task spec is required" {:field :task-specs})
      (let [request-id (or (:request-id options) (str "runner-tasks-" (short-token deps)))
            handle (board-handle deps)
            command {:type "add_tasks"
                     :tasks (mapv (fn [spec]
                                    (assoc spec
                                           :ledger-key (:ledger-key spec)
                                           :needs-token (boolean (:needs-token spec))))
                                  specs)}]
        (if-not (and handle (:store handle))
          (failure :INVALID_ARGUMENT "add-root-tasks! needs an open board handle"
                   {:field :board})
          (let [result (await (apply/apply-board!
                                {:board handle
                                 :command command
                                 :actor (or (:actor options) "Coordinator")
                                 :request-id request-id
                                 :turn-id (or (:turn-id options) "runner:findings")}))]
            result))))))

(defn- findings->specs [findings]
  (let [errors (atom [])
        seen (atom #{})
        specs (atom [])]
    (doseq [[index finding] (map-indexed vector findings)]
      (cond
        (not (map? finding))
        (swap! errors conj {:code :INVALID_ARGUMENT
                            :message (str "findings[" index "] must be an object")
                            :index index})

        (not (text? (:key finding)))
        (swap! errors conj {:code :INVALID_ARGUMENT
                            :message (str "findings[" index "].key must be a non-empty string")
                            :index index})

        (not (text? (:value finding)))
        (swap! errors conj {:code :INVALID_ARGUMENT
                            :message (str "findings[" index "].value must be a non-empty string in S5")
                            :index index})

        (contains? @seen (string/trim (:key finding)))
        (swap! errors conj {:code :INVALID_ARGUMENT
                            :message (str "findings[" index "].key is duplicated")
                            :index index
                            :key (:key finding)})

        :else
        (do
          (swap! seen conj (string/trim (:key finding)))
          (swap! specs conj {:ledger-key (string/trim (:key finding))
                             :goal (string/trim (:value finding))
                             :remaining-work (str "完成评审项「" (string/trim (:key finding))
                                                  "」并保留可复验证据："
                                                  (string/trim (:value finding)))
                             :done-when "该评审项在真实工作区完成，相关 CASE 仍达到阈值，并留下可复验结果"
                             :needs-token false}))))
    (if (seq @errors)
      {:ok false :errors @errors :code (:code (first @errors))}
      {:ok true :specs @specs})))

(defn- root-task-by-ledger-key [board ledger-key]
  (first (for [[task-id task] (:tasks board)
               :when (and (nil? (:parent-id task))
                          (= ledger-key (:ledger-key task)))]
           [task-id task])))

(defn ^:async instantiate-findings! [deps findings options]
  (let [validated (findings->specs findings)]
    (if-not (:ok validated)
      validated
      (let [handle (board-handle deps)
            board (await (read-board-state deps))
            request-id-base (or (:request-id options) (str "runner-findings-" (short-token deps)))]
        (if-not (and handle (:store handle) (model/board-state? board))
          (failure :INVALID_ARGUMENT "instantiate-findings! needs an open board handle"
                   {:field :board})
          (let [new-specs (atom [])
                task-ids (atom [])
                errors (atom [])]
            (doseq [[index spec] (map-indexed vector (:specs validated))]
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
                                                         :reason "a new Reviewer finding reopens this ledger entry"
                                                         :evidence [(:goal spec)]}
                                               :actor (or (:actor options) "Coordinator")
                                               :request-id (str request-id-base "-reopen-" index)
                                               :turn-id (or (:turn-id options) "runner:findings")}))]
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
                                              :actor (or (:actor options) "Coordinator")
                                              :request-id (str request-id-base "-update-" index)
                                              :turn-id (or (:turn-id options) "runner:findings")}))]
                        (when-not (:ok updated)
                          (swap! errors conj (or (:error updated) updated)))))))))
            (if (seq @errors)
              {:ok false :code (:code (first @errors)) :errors @errors}
              (let [added (when (seq @new-specs)
                            (await (add-root-tasks! deps @new-specs
                                    {:request-id (str request-id-base "-add")
                                     :turn-id (or (:turn-id options) "runner:findings")
                                     :actor (or (:actor options) "Coordinator")})))]
                (if (and added (not (:ok added)))
                  added
                  (let [all-task-ids (into (vec @task-ids)
                                           (or (get-in added [:receipt :task-ids]) []))]
                    {:ok true
                     :task-ids all-task-ids
                     :new-task-ids (vec (or (get-in added [:receipt :task-ids]) []))
                     :updated-task-ids (vec @task-ids)
                     :errors []}))))))))))

(defn- live-slot-actors [board]
  (->> (:actors board)
       (filter (fn [[_ actor]]
                 (and (= :alive (:life-state actor))
                      (= :normal (:role actor))
                      (some? (re-matches #"S[0-9]+" (str (:slot-id actor)))))))
       (map (fn [[agent-id actor]]
              {:slot-id (:slot-id actor)
               :agent-id agent-id}))
       (sort-by :slot-id)
       vec))

(defn slot-pool [deps board]
  (let [explicit (:slots deps)]
    (cond
      (and (sequential? explicit) (seq explicit)) (vec explicit)
      (seq (live-slot-actors board)) (live-slot-actors board)
      :else
      (let [count (let [value (:slot-count deps default-slot-count)]
                    (if (and (integer? value) (<= 1 value max-slot-count))
                      value
                      default-slot-count))
            slug (or (:slug deps) "mission")]
        (mapv (fn [index]
                (let [slot-id (str "S" (inc index))]
                  {:slot-id slot-id
                   :agent-id (str "Worker-" slug "-" slot-id "-" (short-token deps))}))
              (range count))))))

(defn worker-request [deps mission board slot options]
  (let [slug (mission-slug deps mission)
        tenure-id (current-tenure-id mission board)
        term (current-term mission board)
        context {:mission-id (or (:mission-id mission) (:mission-id deps) "unknown")
                 :slug slug
                 :tenure-id tenure-id
                 :term term
                 :slot-id (:slot-id slot)
                 :agent-id (:agent-id slot)
                 :cwd (or (:root deps) (:cwd deps))
                 :contract-paths (contract-paths slug)
                 :board-snapshot (board-snapshot board)}]
    {:role "Swarm Worker"
     :name (str "Worker-" slug "-" (:slot-id slot))
     :prompt (build-worker-prompt context)
     :cwd (or (:root deps) (:cwd deps))
     :artifacts-dir (or (:artifacts-dir deps)
                        (artifacts-directory deps slug tenure-id
                                             (str "slot-" (:slot-id slot))))
     :signal (:signal deps)
     :slot-id (:slot-id slot)
     :agent-id (:agent-id slot)
     :tenure-id tenure-id
     :board-version (:board-version board)}))

(defn ^:async wake-all-slots! [deps options]
  (let [board (or (:board-state options) (await (read-board-state deps)))
        mission (or (:mission options) (mission-context deps) {})
        slots (slot-pool deps board)
        wake-slot (:wake-slot! deps)
        subagent (subagent-port deps)
        start-one (fn [slot]
                    (let [request (worker-request deps mission board slot options)]
                      (cond
                        (fn? wake-slot) (wake-slot request)
                        subagent (subagent request)
                        :else {:ok false
                               :code :HOST_API_MISMATCH
                               :slot-id (:slot-id slot)
                               :message "no slot wake port is available"})))]
    (if (empty? slots)
      {:ok false :code :INVALID_ARGUMENT :message "the slot pool is empty" :slots []}
      (let [started (await (js/Promise.all (into-array (mapv start-one slots))))]
        {:ok (every? (fn [result] (not (and (map? result) (false? (:ok result))))) started)
         :slots slots
         :started (vec started)
         :wake-epoch (get-in board [:wake :epoch])}))))

(declare ask-initial! relay!)

(defn ^:async reviewer-findings!
  ([deps findings] (reviewer-findings! deps findings {}))
  ([deps findings options]
   (if-not (sequential? findings)
     (failure :INVALID_ARGUMENT "findings must be an array" {:field :findings})
     (let [board (or (:board-state options) (await (read-board-state deps)))
           mission (or (:mission options) (mission-context deps) {})]
       (if-not (model/board-state? board)
         (failure :STALE_CONTROL "the S5 board is missing" {})
         (if (seq findings)
           (let [instantiated (await (instantiate-findings! deps findings options))]
             (if-not (:ok instantiated)
               instantiated
               (let [woken (await (wake-board! deps :reviewer-findings))
                     refreshed (or (:board-state options) (await (read-board-state deps)))
                     slots (await (wake-all-slots! deps {:board-state refreshed
                                                         :mission mission
                                                         :reason :reviewer-findings}))]
                 (if-not (:ok woken)
                   woken
                   {:ok true
                    :status :review-open
                    :task-ids (:task-ids instantiated)
                    :new-task-ids (:new-task-ids instantiated)
                    :updated-task-ids (:updated-task-ids instantiated)
                    :wake-epoch (:wake-epoch woken)
                    :woken-slots (:slots slots)
                    :slot-results (:started slots)
                    :board-version (get-in refreshed [:board-version])}))))
           (let [checked (quiescence board {:write-lock-held? (write-lock-held? deps)})
                 initial? (zero? (current-term mission board))
                 ask-used? (boolean (get-in board [:tenure :initial-ask-used]))]
             (cond
               (not (:ok checked))
               {:ok true
                :status :stay
                :quiescence checked
                :board-version (:board-version board)
                :tenure-id (current-tenure-id mission board)}

               (and initial? (not ask-used?) (fn? (:ask-user deps)))
               (let [asked (await (ask-initial! deps {:board board
                                                      :mission mission
                                                      :question (or (:question options) initial-question)
                                                      :contract-satisfied? (:contract-satisfied? options true)}))]
                 asked)

               :else
               (await (relay! deps {:board board
                                     :mission mission
                                     :quiescence checked
                                     :now (:now options)}))))))))))

(defn ^:async mark-initial-ask! [deps]
  (update-board!
    deps
    (fn [current]
      (if (get-in current [:tenure :initial-ask-used])
        (failure :ASK_ALREADY_USED
                 "the initial empty-ledger question was already used"
                 {:tenure-id (:tenure-id current)})
        (let [next-board (-> current
                             (assoc-in [:tenure :initial-ask-used] true)
                             (update :board-version inc))
              timestamp (now-iso deps)]
          {:ok true
           :commit true
           :board next-board
           :initial-ask-used true
           :events [(event next-board :initial-ask-asked
                           {:tenure-id (:tenure-id next-board) :at timestamp}
                           {:request-id nil :actor-id nil :turn-id "runner:ask"})]})))
    :STALE_CONTROL))

(defn ^:async ask-initial! [deps options]
  (let [board (or (:board options) (await (read-board-state deps)))
        mission (or (:mission options) (mission-context deps) {})]
    (if-not (model/board-state? board)
      (failure :STALE_CONTROL "the S5 board is missing" {})
      (let [checked (quiescence board {:write-lock-held? (write-lock-held? deps)})]
        (cond
          (not (:ok checked))
          (failure :RESOURCES_NOT_QUIESCENT
                   "the initial question is allowed only at quiescence"
                   {:quiescence checked})

          (not (true? (:contract-satisfied? options true)))
          (failure :CONTRACT_NOT_SATISFIED
                   "the main workspace does not satisfy the contract"
                   {:field :contract-satisfied?})

          (not (zero? (current-term mission board)))
          (failure :NOT_INITIAL_TENURE
                   "only the initial Reviewer may ask the one-shot question"
                   {:tenure-id (current-tenure-id mission board)
                    :term (current-term mission board)})

          (get-in board [:tenure :initial-ask-used])
          (failure :ASK_ALREADY_USED
                   "the initial empty-ledger question was already used"
                   {:tenure-id (current-tenure-id mission board)})

          (not (fn? (:ask-user deps)))
          (failure :HOST_API_MISMATCH
                   "no ask_user port was injected"
                   {:port :ask-user})

          :else
          (let [marked (await (mark-initial-ask! deps))]
            (if-not (:ok marked)
              marked
              (let [answer (try
                             [:ok (await (js/Promise.resolve
                                           ((:ask-user deps)
                                            {:question (or (:question options) initial-question)
                                             :context {:mission-id (:mission-id mission)
                                                       :slug (mission-slug deps mission)
                                                       :tenure-id (current-tenure-id mission board)
                                                       :board-version (:board-version board)}})))]
                             (catch :default error
                               [:error error]))]
                {:ok true
                 :status :ask-user
                 :question (or (:question options) initial-question)
                 :answer (second answer)
                 :answer-error (when (= :error (first answer))
                                 (str (second answer)))
                 :initial-ask-used true
                 :board-version (or (:board-version marked) (:board-version board))}))))))))

(defn- successor-tenure [mission board options deps]
  (let [slug (mission-slug deps mission)
        retired (current-tenure-id mission board)
        next-id (or (:successor-tenure options)
                    (tenure/successor-tenure-id mission board))
        next-term (inc (current-term mission board))
        timestamp (or (:now options) (now-iso deps))]
    {:slug slug
     :retired retired
     :successor-id next-id
     :term next-term
     :now timestamp
     :barrier {:from :s5
               :to :s5
               :retired-tenure retired
               :successor-tenure next-id
               :board-archive (tenure/archive-board-path slug retired)
               :review-summary (:review-summary board)
               :written-at timestamp}
     :successor-board (-> (model/initial-board {:mode :swarm})
                          (assoc :tenure-id next-id
                                 :tenure {:term next-term :phase :swarm :initial false}
                                 :attach-ready false))}))

(defn- successor-mission [mission successor barrier timestamp]
  (-> mission
      (assoc :stage :s5
             :tenure-id (:successor-id successor)
             :tenure-seq (inc (or (:tenure-seq mission) 0))
             :tenure {:tenure-id (:successor-id successor)
                      :index (:term successor)
                      :started-at timestamp
                      :ended-at nil}
             :barrier barrier
             :attach-ready false
             :nudge-enabled true
             :updated-at timestamp)))

(defn ^:async replace-board! [deps board]
  (update-board!
    deps
    (fn [_current]
      {:ok true
       :commit true
       :board board
       :events [(event board :tenure-successor-opened
                       {:tenure-id (:tenure-id board)
                        :term (get-in board [:tenure :term])}
                       {:request-id nil :actor-id nil :turn-id "runner:relay"})]})
    :STALE_CONTROL))

(defn ^:async persist-barrier! [deps request]
  (if (fn? (:persist-barrier! deps))
    (await ((:persist-barrier! deps) request))
    (let [{:keys [root slug board barrier successor-board successor-mission]} request]
      (if-not (and (text? root) (text? slug))
        (failure :INVALID_ARGUMENT
                 "relay needs root and slug to archive the tenure"
                 {:field (if (text? root) :slug :root)})
        (let [archived (await (stages-store/archive-board! root slug (:retired-tenure barrier) board))
              patch {:stage :s5
                     :tenure (:tenure successor-mission)
                     :tenure-id (:tenure-id successor-mission)
                     :tenure-seq (:tenure-seq successor-mission)
                     :barrier barrier
                     :attach-ready false
                     :updated-at (:updated-at successor-mission)}
              updated (await (stages-store/update-mission! root slug patch))]
          (if-not (:ok updated)
            updated
            (let [replaced (await (replace-board! deps successor-board))]
              (if-not (:ok replaced)
                replaced
                {:ok true
                 :archived archived
                 :mission (:mission updated)
                 :successor-board successor-board}))))))))

(defn ^:async relay! [deps options]
  (let [board (or (:board options) (await (read-board-state deps)))
        mission (or (:mission options) (mission-context deps) {})]
    (if-not (model/board-state? board)
      (failure :STALE_CONTROL "the S5 board is missing" {})
      (let [checked (or (:quiescence options)
                        (quiescence board {:write-lock-held? (write-lock-held? deps)}))]
        (if-not (:ok checked)
          (failure :RESOURCES_NOT_QUIESCENT
                   "the tenure cannot rotate before quiescence"
                   {:quiescence checked})
          (let [successor (successor-tenure mission board options deps)
                timestamp (:now successor)
                barrier (:barrier successor)
                successor-board (:successor-board successor)
                successor-mission (successor-mission mission successor barrier timestamp)
                persisted (await (persist-barrier!
                                   deps
                                   {:root (:root deps)
                                    :slug (mission-slug deps mission)
                                    :mission mission
                                    :board board
                                    :barrier barrier
                                    :successor-board successor-board
                                    :successor-mission successor-mission
                                    :now timestamp}))]
            (if-not (:ok persisted)
              persisted
              (let [next-mission (or (:successor-mission persisted) successor-mission)
                    next-board (or (:successor-board persisted) successor-board)
                    reviewer (await (start-reviewer!
                                      (assoc deps :mission next-mission)
                                      {:board-state next-board
                                       :mission next-mission
                                       :tenure-id (:successor-id successor)
                                       :term (:term successor)}))]
                (if-not (:ok reviewer)
                  {:ok true
                   :status :barrier-committed
                   :barrier barrier
                   :successor {:tenure-id (:successor-id successor)
                               :term (:term successor)}
                   :reviewer-start reviewer
                   :next "the context barrier is committed; retry only the successor launch"}
                  {:ok true
                   :status :relayed
                   :barrier barrier
                   :successor {:tenure-id (:successor-id successor)
                               :term (:term successor)}
                   :reviewer (:reviewer reviewer)
                   :board-version (:board-version next-board)})))))))))

(defn ^:async register-actor! [deps request]
  (let [handle (board-handle deps)]
    (if-not (and handle (:store handle))
      (failure :INVALID_ARGUMENT "register-actor! needs an open board handle" {:field :board})
      (await (apply/apply-board!
               {:board handle
                :command {:type "register_actor"
                          :agentId (:agent-id request)
                          :slotId (:slot-id request)
                          :role :normal}
                :request-id (:request-id request)
                :turn-id (or (:turn-id request) "runner:slots")})))))

(defn ^:async init-slot-pool! [deps options]
  (let [board (await (read-board-state deps))
        existing (live-slot-actors board)
        by-slot (into {} (map (fn [slot] [(:slot-id slot) slot]) existing))
        wanted (slot-pool (assoc deps :slots (:slots options)) board)
        slug (or (:slug deps) "mission")
        registered (atom [])
        errors (atom [])]
    (doseq [[index slot] (map-indexed vector wanted)]
      (if (contains? by-slot (:slot-id slot))
        (swap! registered conj (get by-slot (:slot-id slot)))
        (let [agent-id (or (:agent-id slot)
                           (str "Worker-" slug "-" (:slot-id slot) "-" (short-token deps)))
              result (await (register-actor! deps {:agent-id agent-id
                                                   :slot-id (:slot-id slot)
                                                   :request-id (str "runner-slot-" index "-"
                                                                    (short-token deps))}))]
          (if (:ok result)
            (swap! registered conj {:slot-id (:slot-id slot) :agent-id agent-id})
            (swap! errors conj (or (:error result) result))))))
    (if (seq @errors)
      {:ok false :code (:code (first @errors)) :errors @errors :slots @registered}
      {:ok true :slots @registered})))

(defn ^:async mark-actor-dead! [deps agent-id reason]
  (update-board!
    deps
    (fn [current]
      (if-not (get-in current [:actors agent-id])
        (failure :ACTOR_DEAD "actor is not registered" {:agent-id agent-id})
        (let [next-board (-> current
                             (assoc-in [:actors agent-id :life-state] :dead)
                             (assoc-in [:actors agent-id :active-action-id] nil)
                             (update :sleepers dissoc agent-id)
                             (update :board-version inc))]
          {:ok true
           :commit true
           :board next-board
           :events [(event next-board :actor-terminated
                           {:agent-id agent-id :reason reason}
                           {:request-id nil :actor-id agent-id :turn-id "runner:slot"})]})))
    :STALE_CONTROL))

(defn ^:async replace-slot! [deps slot-id options]
  (let [board (await (read-board-state deps))
        slug (or (:slug deps) "mission")
        existing (first (filter (fn [slot] (= slot-id (:slot-id slot)))
                                (live-slot-actors board)))
        old-agent-id (:agent-id existing)
        new-agent-id (or (:agent-id options)
                         (str "Worker-" slug "-" slot-id "-" (short-token deps)))]
    (if-not (text? slot-id)
      (failure :INVALID_ARGUMENT "replace-slot! needs a slot_id" {:field :slot-id})
      (do
        (when old-agent-id
          (await (mark-actor-dead! deps old-agent-id (or (:reason options) "slot replacement"))))
        (let [registered (await (register-actor! deps {:agent-id new-agent-id
                                                       :slot-id slot-id
                                                       :request-id (or (:request-id options)
                                                                       (str "runner-replace-" (short-token deps)))}))]
          (if-not (:ok registered)
            registered
            (let [woken (if (fn? (:wake-slot! deps))
                          (await ((:wake-slot! deps)
                                  {:slot-id slot-id
                                   :agent-id new-agent-id
                                   :role "Swarm Worker"
                                   :reason :slot-replaced}))
                          {:ok true :slot-id slot-id})]
              {:ok true
               :slot-id slot-id
               :old-agent-id old-agent-id
               :agent-id new-agent-id
               :wake woken
               :note "a replacement slot starts with a brand-new agent_id and no predecessor context"})))))))

(defn ^:async park-slot! [deps slot-id options]
  (let [board (await (read-board-state deps))
        actor (first (filter (fn [slot] (= slot-id (:slot-id slot)))
                             (live-slot-actors board)))
        agent-id (or (:agent-id options) (:agent-id actor))
        observed (or (:observed-board-version options) (:board-version board))]
    (cond
      (not (model/board-state? board))
      (failure :STALE_CONTROL "the S5 board is missing" {})

      (not (text? agent-id))
      (failure :ACTOR_DEAD "park-slot! needs a live slot actor" {:slot-id slot-id})

      :else
      (let [result (await (apply/apply-board!
                            {:board (board-handle deps)
                             :command {:type "park_slot"
                                       :observed-board-version observed}
                             :actor agent-id
                             :request-id (or (:request-id options)
                                             (str "runner-park-" slot-id "-" (short-token deps)))
                             :turn-id (or (:turn-id options) "runner:park")}))]
        (if-not (:ok result)
          result
          {:ok true
           :parked {:slot-id slot-id
                    :agent-id agent-id
                    :wake-epoch (get-in board [:wake :epoch])
                    :board-version (:board-version board)}
           :receipt (:receipt result)})))))

(defn ^:async wake-parked! [deps parked]
  (let [entries (cond
                  (map? parked) [parked]
                  (sequential? parked) (vec parked)
                  :else [])
        board (await (read-board-state deps))
        epoch (get-in board [:wake :epoch] 0)
        ready (filter (fn [entry] (> epoch (or (:wake-epoch entry) -1))) entries)
        waiting (remove (fn [entry] (> epoch (or (:wake-epoch entry) -1))) entries)]
    (if (empty? ready)
      {:ok true :woken [] :still-parked (vec waiting) :wake-epoch epoch}
      (let [results (await (js/Promise.all
                            (into-array
                              (mapv (fn [entry]
                                      (let [request {:slot-id (:slot-id entry)
                                                     :agent-id (:agent-id entry)
                                                     :role "Swarm Worker"
                                                     :reason :board-wake}]
                                        (cond
                                          (fn? (:wake-slot! deps)) ((:wake-slot! deps) request)
                                          (subagent-port deps) ((subagent-port deps) request)
                                          :else {:ok false :code :HOST_API_MISMATCH})))
                                    ready))))]
        {:ok true
         :woken (mapv (fn [entry] (:slot-id entry)) ready)
         :started (vec results)
         :still-parked (vec waiting)
         :wake-epoch epoch}))))

(defn install!
  "Install the S5 orchestration contract for the entry point. The entry point
   wires these functions behind its own tools; this namespace registers no
   model-facing tool."
  [deps]
  {:startReviewer (fn [options] (start-reviewer! deps options))
   :reviewerFindings (fn [findings options]
                       (reviewer-findings! deps findings options))
   :relay (fn [options] (relay! deps options))
   :quiescence (fn [board options] (quiescence board options))
   :initSlotPool (fn [options] (init-slot-pool! deps options))
   :replaceSlot (fn [slot-id options] (replace-slot! deps slot-id options))
   :parkSlot (fn [slot-id options] (park-slot! deps slot-id options))
   :wakeParked (fn [parked] (wake-parked! deps parked))
   :askInitial (fn [options] (ask-initial! deps options))})

(defn register-runner!
  "Backward-compatible installer: expose the same API on `globalThis.__herdS5`."
  [pi deps]
  (let [api (install! deps)]
    (js/Reflect.set js/globalThis "__herdS5" (clj->js api))
    {:ok true
     :api api
     :tools []
     :contract {:subagent "{ role, name, prompt, cwd, artifactsDir, signal?, outputSchema? } -> Promise<{ ok, resultMarkdown?, error?, artifactsDir?, sessionFile? }>"
                :ask_user "(request) -> Promise<answer>"
                :wake_slot "(request) -> Promise<result>"
                :persist_barrier "(request) -> Promise<{ ok, successorBoard?, successorMission? }>"}
     :note "The runner exposes no model-facing tool of its own; the entry point wires these functions behind review/attach_coordination."}))
