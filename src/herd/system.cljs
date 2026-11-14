(ns herd.system
  (:require
   ["node:crypto" :as crypto]
   ["node:fs/promises" :as fs]
   ["node:path" :as path]
   [clojure.string :as str]
   [herd.repl :as repl]
   [herd.stages.audit :as audit]
   [herd.stages.disclosures :as disclosures]
   [herd.stages.gates :as gates]
   [herd.stages.paths :as stage-paths]
   [herd.stages.store :as store]
   [herd.stages.tenure :as tenure]
   [herd.swarm.auditors :as auditors]
   [herd.swarm.model :as swarm-model]
   [herd.swarm.runner :as runner]
   [herd.swarm.store :as swarm-store]
   [herd.swarm.tools :as swarm-tools]
   [herd.ufss :as ufss]
   [herd.ui :as ui]
   [herd.util.atomic-write :as atomic]))

(def ^:private newline-char (js/String.fromCharCode 10))

(def ^:private slug-pattern #"^[a-z0-9][a-z0-9-]{0,63}$")

(def ^:private role-token-pattern
  #"^\[HERD_ROLE: ([A-Za-z][A-Za-z0-9 _-]*?)(?: nonce=[A-Za-z0-9_-]{8,128})?\]$")

(def ^:private role-names
  #{"Plan" "Coordinator" "Plan DevOps" "Reviewer" "Swarm Worker" "Swarm Holder"
    "Manual Auditor"})

(def ^:private board-tool-names
  ["board_split" "board_claim" "board_finish" "board_cancel" "board_replace"
   "board_release" "board_reopen" "board_comment" "board_update"
   "board_park_slot" "board_take_or_die"])

(def ^:private progress-tool-names
  (set (concat board-tool-names
               ["review" "ask_user" "attach_brainstorm" "attach_manual_tests"
                "attach_dev_guide" "attach_coordination" "attach_case_audit"])))

(def ^:private nudge-delays [0 30000 60000 120000 240000 300000])

(def ^:private upstream-backoff-ms [5000 10000 20000 40000 80000])

(def ^:private upstream-quota-pattern
  #"(?i)insufficient_quota|quota exceeded|exceeded your current quota|billing|credit balance|payment required|402")

(def ^:private upstream-status-pattern
  #"(?i)(^|[^0-9])(429|502|503|504|529)([^0-9]|$)")

(def ^:private upstream-network-pattern
  #"(?i)network_error|econnreset|etimedout|socket hang up|fetch failed|upstream_aborted")

(def ^:private devops-call-pattern #"^HERD_DEVOPS_CALL: ([A-Za-z0-9_-]{8,64})$")

(declare devops-call-id-of)
(declare s5-review! ensure-reviewer! write-devops-receipt!)

(defonce state
  (atom {:sessions {}
         :last-ctx nil
         :nudge {:attempts 0 :timer nil :pending nil}
         :upstream {:attempts 0 :timer nil :stalled false :events []}
         :audit-inflight {}
         :reviewers {}
         :installed false
         :installed-count 0
         :missions-cache []
         :health []}))

(defonce installed-pis (js/WeakSet.))
(defonce registered-tool-pis (js/WeakSet.))
(defonce registered-command-pis (js/WeakSet.))
(defonce registered-hook-pis (js/WeakSet.))
(defonce registered-tool-names (js/WeakMap.))

(defonce focus-tail (atom (js/Promise.resolve nil)))

(defn- text? [value]
  (and (string? value) (pos? (count (str/trim value)))))

(defn- now-iso []
  (.toISOString (js/Date.)))

(defn- new-turn-id []
  (str "turn-" (js/Date.now) "-" (.randomUUID crypto)))

(defn reset-state! []
  (let [clear (:clear-timeout (:options @state) js/clearTimeout)]
    (when-let [timer (get-in @state [:nudge :timer])]
      (try (clear timer) (catch :default _ nil))))
  (reset! state {:sessions {}
                 :last-ctx nil
                 :nudge {:attempts 0 :timer nil :pending nil}
                 :upstream {:attempts 0 :timer nil :stalled false :events []}
                 :audit-inflight {}
                 :reviewers {}
                 :installed false
                 :installed-count 0
                 :missions-cache []
                 :health []})
  nil)

(defonce health-tail (atom (js/Promise.resolve nil)))
(defonce health-truncated (atom nil))
(def ^:private health-file-limit (* 1024 1024))

(defn- health-target []
  (path/join (or (:root (:options @state)) (js/process.cwd))
             ".herd" "health.jsonl"))

(defn- append-health! [line]
  (swap! health-tail
         (fn [previous]
           (-> previous
               (.then
                 (fn [_]
                   (let [target (health-target)]
                     (when-not (= target @health-truncated)
                       (-> (.stat fs target)
                           (.then (fn [stats] (.-size stats)))
                           (.catch (fn [_] 0))
                           (.then
                             (fn [size]
                               (let [bytes (js/Buffer.byteLength line "utf8")]
                                 (if (> (+ size bytes) health-file-limit)
                                   (do
                                     (reset! health-truncated target)
                                     (-> (.mkdir fs (path/dirname target) #js {:recursive true})
                                         (.then
                                           (fn [_]
                                             (.appendFile fs target
                                                          (str (js/JSON.stringify
                                                                 #js {:truncated true
                                                                      :limit health-file-limit
                                                                      :at (now-iso)})
                                                               newline-char)
                                                          "utf8")))
                                         (.catch (fn [_] nil))))
                                   (-> (.mkdir fs (path/dirname target) #js {:recursive true})
                                       (.then (fn [_] (.appendFile fs target line "utf8")))
                                       (.catch (fn [_] nil))))))))))))
               (.catch (fn [_] nil))))))

(defn record-health! [entry]
  (let [record (assoc entry :at (now-iso))]
    (swap! state update :health (fnil conj []) record)
    (try
      (js/Reflect.set js/globalThis "__herdHealth" (clj->js record))
      (catch :default _ nil))
    (append-health! (str (js/JSON.stringify (clj->js record)) newline-char))
    record))

(defn- ignore-rejection [value]
  (when (and value (fn? (.-catch value)))
    (.catch value (fn [_] nil))))

(defn- enqueue! [tail-atom f]
  (let [run (-> @tail-atom
                (.then (fn [_] true) (fn [_] true))
                (.then (fn [_] (f))))]
    (reset! tail-atom (-> run (.then (fn [_] nil) (fn [_] nil))))
    run))

(defn- agent-of [ctx]
  (when ctx (.-agent ctx)))

(defn- session-manager [ctx]
  (when ctx (.-sessionManager ctx)))

(defn- agent-id [ctx]
  (let [agent (agent-of ctx)]
    (when agent (.-id agent))))

(defn- subagent? [ctx]
  (let [agent (agent-of ctx)]
    (and agent
         (or (= "sub" (.-kind agent))
             (= "subagent" (.-kind agent))
             (let [depth (.-depth agent)]
               (and (number? depth) (pos? depth)))))))

(defn- persistent-session? [ctx]
  (some? (session-manager ctx)))

(defn session-key [ctx]
  (or (agent-id ctx)
      (try
        (let [manager (session-manager ctx)
              id (when (and manager (fn? (.-getSessionId manager)))
                   (.getSessionId manager))]
          (when (and (string? id) (pos? (count id))) (str "session:" id)))
        (catch :default _ nil))
      (let [cwd (when ctx (.-cwd ctx))]
        (if (and (string? cwd) (pos? (count cwd)))
          (str "cwd:" (path/resolve cwd))
          "main"))))

(defn role-of-ctx [ctx]
  (get-in @state [:sessions (session-key ctx) :role-token :role]))

(defn workspace-root [cwd]
  (path/resolve (if (and (string? cwd) (pos? (count cwd))) cwd (js/process.cwd))))

(defn- resolve-root [ctx]
  (or (get-in @state [:sessions (session-key ctx) :root])
      (:root (:options @state))
      (workspace-root (when ctx (.-cwd ctx)))))

(defn- content-text [content]
  (cond
    (string? content) content
    (array? content)
    (str/join newline-char
              (keep (fn [block]
                      (when (and block (= "text" (.-type block)))
                        (.-text block)))
                    (array-seq content)))
    :else ""))

(defn- event-prompt [event]
  (cond
    (and event (string? (.-prompt event))) (.-prompt event)
    (and event (= "custom" (.-messageType event)))
    (content-text (.-content (.-message event)))
    :else ""))

(defn- role-token* [prompt]
  (let [line (str/trim (or (first (str/split (or prompt "") #"\r?\n")) ""))
        match (re-matches role-token-pattern line)]
    (cond
      (nil? match) nil
      (contains? role-names (nth match 1)) {:role (nth match 1) :raw line}
      :else {:role nil :raw line})))

(defn- ctx-for-slug [slug]
  (or (->> (:sessions @state)
           (keep (fn [[_ session]]
                   (when (= slug (:slug session)) (:ctx session))))
           first)
      (:last-ctx @state)))

(defn- main-ctx-for-slug [slug]
  (or (->> (:sessions @state)
           (keep (fn [[_ session]]
                   (let [ctx (:ctx session)]
                     (when (and (= slug (:slug session)) (not (subagent? ctx)))
                       ctx))))
           first)
      (:last-ctx @state)))

(defn- focus-path [root]
  (path/join root ".herd" "focus.edn"))

(defn- mission-directory [root]
  (path/join root ".herd" "missions"))

(defn- ^:async read-focus [root]
  (try
    (let [text (await (.readFile fs (focus-path root) "utf8"))
          value (ufss/read text)]
      (if (map? value) value {}))
    (catch :default error
      (when-not (= "ENOENT" (.-code error))
        (record-health! {:entry "system.focus"
                         :status "degraded"
                         :reason "focus.edn is unreadable"
                         :error (str error)}))
      {})))

(defn- ^:async update-focus-step! [root f]
  (let [current (await (read-focus root))
        next (f current)]
    (await (atomic/write-edn-atomic! (focus-path root) next))
    next))

(defn- ^:async update-focus! [root f]
  (await (enqueue! focus-tail (fn [] (update-focus-step! root f)))))

(defn- ^:async remember-focus! [root key slug tenure-id]
  (try
    (await (update-focus! root (fn [current] (assoc current key {:slug slug :tenure-id tenure-id}))))
    (catch :default error
      (record-health! {:entry "system.focus"
                       :status "degraded"
                       :reason "focus write failed"
                       :error (str error)}))))

(defn- ^:async list-mission-slugs [root]
  (try
    (let [entries (await (.readdir fs (mission-directory root) #js {:withFileTypes true}))]
      (->> (array-seq entries)
           (keep (fn [entry] (when (.isDirectory entry) (.-name entry))))
           (filter (fn [slug] (and (string? slug) (re-matches slug-pattern slug))))
           (sort)
           vec))
    (catch :default _ [])))

(defn- ^:async refresh-missions-cache! [root]
  (let [slugs (await (list-mission-slugs root))]
    (swap! state assoc :missions-cache slugs)
    slugs))

(defn- ^:async refresh-mission! [ctx root slug]
  (let [read (await (store/read-mission root slug))]
    (if (:ok read)
      (let [mission (:mission read)
            stage (tenure/normalize-stage (:stage mission))]
        (swap! state update-in [:sessions (session-key ctx)]
               assoc :mission mission :stage stage :root root)
        mission)
      (do
        (record-health! {:entry "system.mission"
                         :status "degraded"
                         :reason "mission is unreadable"
                         :slug slug
                         :error (get-in read [:error :message])})
        nil))))

(defn- ^:async focus-from-disk! [ctx root key]
  (let [focus (await (read-focus root))
        direct (get-in focus [key :slug])
        slugs (vec (distinct (keep (fn [[_ entry]] (when (map? entry) (:slug entry)))
                                   focus)))
        candidate (cond
                    (text? direct) direct
                    (and (subagent? ctx) (= 1 (count slugs))) (first slugs)
                    :else nil)]
    (when (and (string? candidate) (pos? (count candidate)))
      (let [read (await (store/read-mission root candidate))]
        (if (:ok read)
          candidate
          (do
            (record-health! {:entry "system.focus"
                             :status "degraded"
                             :reason "focus points at a missing mission"
                             :slug candidate})
            (await (update-focus! root dissoc key))
            nil))))))

(defn- ^:async auto-focus-single! [ctx root key]
  (let [slugs (await (list-mission-slugs root))]
    (if (= 1 (count slugs))
      (let [slug (first slugs)
            read (await (store/read-mission root slug))]
        (when (:ok read)
          (when-not (subagent? ctx)
            (await (remember-focus! root key slug
                                    (get-in read [:mission :tenure :tenure-id]))))
          slug))
      nil)))

(defn ^:async ensure-focus! [ctx root]
  (let [key (session-key ctx)
        memory (get-in @state [:sessions key :slug])
        slug (or (when (text? memory) memory)
                 (await (focus-from-disk! ctx root key))
                 (await (auto-focus-single! ctx root key)))]
    (when (and (string? slug) (pos? (count slug)))
      (let [mission (await (refresh-mission! ctx root slug))]
        (if mission
          (do
            (swap! state assoc-in [:sessions key :slug] slug)
            slug)
          (do
            (swap! state update-in [:sessions key] dissoc :slug)
            nil))))))

(defn ^:async role-of [ctx root slug]
  (let [key (session-key ctx)
        cached (get-in @state [:sessions key :role-token :role])]
    (if (subagent? ctx)
      cached
      (let [mission (or (get-in @state [:sessions key :mission])
                        (when (text? slug)
                          (:mission (await (store/read-mission root slug)))))]
        (if (= :s5 (tenure/normalize-stage (:stage mission)))
          "Coordinator"
          "Plan")))))

(def ^:private mission-stage-set #{:s1 :s2 :s3 :s4 :s5})

(def ^:private narrowing-role-names
  "Explicit herd roles that own a narrowed subagent tool surface."
  (disj role-names "Plan" "Coordinator"))

(defn surface-for
  "Resolve the tool surface: explicit herd roles win, main sessions narrow only at S1-S5, everything else keeps the default surface."
  [{:keys [mission? subagent? stage role]}]
  (let [role (when (contains? narrowing-role-names role) role)]
    (cond
      (= role "Plan DevOps") ["clj_devops" "submit_devops_report"]
      (= role "Reviewer") ["clj_review" "review"]
      (= role "Swarm Worker") (conj board-tool-names "clj_worker")
      (= role "Swarm Holder") (conj board-tool-names "clj_worker")
      (= role "Manual Auditor") ["clj_auditor" "attach_case_audit"]
      subagent? nil

      (and mission? (contains? mission-stage-set stage))
      (case stage
        :s1 ["clj_plan" "review" "attach_brainstorm" "ask_user" "devops"]
        :s2 ["clj_plan" "review" "attach_manual_tests" "devops"]
        :s3 ["clj_plan" "review" "attach_dev_guide" "devops"]
        :s4 ["clj_plan" "review" "attach_coordination" "devops"]
        :s5 ["review" "ask_user"]))))

(defn- ^:async apply-surface! [pi ctx]
  (let [key (session-key ctx)
        slug (get-in @state [:sessions key :slug])
        allowed (surface-for {:mission? (some? slug)
                              :subagent? (subagent? ctx)
                              :stage (get-in @state [:sessions key :stage])
                              :role (get-in @state [:sessions key :role-token :role])})]
    (if (nil? allowed)
      false
      (do
        (try
          (let [active (vec (array-seq (or (.getActiveTools pi) #js [])))
                allowed-set (set allowed)
                kept (vec (distinct (filter allowed-set active)))
                missing (vec (remove (set kept) allowed))
                next (vec (concat kept missing))]
            (when-not (= (set active) (set next))
              (await (.setActiveTools pi (clj->js next))))
            true)
          (catch :default error
            (record-health! {:entry "system.surface"
                             :status "degraded"
                             :reason "setActiveTools failed; keeping the current tool surface"
                             :error (str error)})
            false))))))

(defn apply-mission-surface! [pi ctx]
  (let [key (session-key ctx)
        session (get-in @state [:sessions key])
        role (get-in session [:role-token :role])
        stage (:stage session)]
    (cond
      (subagent? ctx)
      (if (contains? narrowing-role-names role)
        (do (ignore-rejection (apply-surface! pi ctx))
            true)
        false)

      (and (some? (:slug session)) (contains? mission-stage-set stage))
      (do (ignore-rejection (apply-surface! pi ctx))
          true)

      :else false)))

(defn briefing-for [ctx]
  (if (subagent? ctx)
    nil
    (let [key (session-key ctx)
          mission (get-in @state [:sessions key :mission])
          stage (tenure/normalize-stage (:stage mission))]
      (when stage (disclosures/current-briefing stage)))))

(defn- open-items-of [board]
  (if-not (map? board)
    []
    (let [tasks (:tasks board)]
      (if-not (map? tasks)
        []
        (if (:mode board)
          (->> tasks
               (remove (fn [[_ task]] (= :done (:state task))))
               (map (fn [[id task]] (str id " " (or (:goal task) ""))))
               vec)
          (->> tasks
               (map (fn [[key task]]
                      (str key (when (and (map? task) (:value task))
                                 (str ": " (:value task))))))
               vec))))))

(defn ^:async before-agent-start! [event ctx]
  (let [key (session-key ctx)
        root (resolve-root ctx)]
    (swap! state assoc :last-ctx ctx)
    (swap! state update-in [:sessions key]
           (fn [session]
             (-> session
                 (assoc :ctx ctx :root root :turn-tools #{} :successful-tools #{}
                        :turn-id (new-turn-id))
                 (dissoc :gate-cache))))
    (if (subagent? ctx)
      (do
        (let [token (role-token* (event-prompt event))]
          (cond
            (and token (:role token))
            (swap! state assoc-in [:sessions key :role-token] {:role (:role token)})

            (nil? (get-in @state [:sessions key :role-token]))
            (record-health! {:entry "system.role"
                             :status "degraded"
                             :reason (if token "unknown role token" "subagent has no role token")
                             :raw (:raw token)
                             :session key})))
        (let [call-id (devops-call-id-of (event-prompt event))]
          (when call-id
            (swap! state assoc-in [:sessions key :devops-call-id] call-id))))
      (do
        (swap! state assoc-in [:sessions key :role-token] nil)
        (when (persistent-session? ctx)
          (let [slug (await (ensure-focus! ctx root))]
            (when slug
              (let [board (await (store/read-board root slug))]
                (swap! state assoc-in [:sessions key :open-items] (open-items-of board))))
            (when (and slug (:pi @state))
              (await (apply-surface! (:pi @state) ctx)))))))
    nil))

(defn ^:async session-start! [ctx]
  (let [key (session-key ctx)
        root (resolve-root ctx)]
    (swap! state assoc :last-ctx ctx)
    (swap! state update-in [:sessions key] assoc :ctx ctx :root root)
    (when-not (subagent? ctx)
      (when (and (persistent-session? ctx) (:pi @state))
        (let [slug (await (ensure-focus! ctx root))]
          (when slug
            (await (apply-surface! (:pi @state) ctx)))))
      (await (refresh-missions-cache! root)))
    nil))

(defn- clear-nudge-timer! []
  (let [timer (get-in @state [:nudge :timer])
        clear (or (get-in @state [:options :clear-timeout]) js/clearTimeout)]
    (when timer
      (try (clear timer) (catch :default _ nil)))
    (swap! state assoc-in [:nudge :timer] nil)))

(defn- reset-nudge! []
  (clear-nudge-timer!)
  (swap! state assoc :nudge {:attempts 0 :timer nil :pending nil}))

(declare reset-upstream!)

(defn note-human-input! [event]
  (try
    (let [message (when event (.-message event))]
      (when (and message (= "user" (.-role message)))
        (reset-nudge!)
        (reset-upstream!)))
    (catch :default _ nil))
  nil)

(defn next-nudge-delay [attempt progress?]
  (if progress?
    0
    (nth nudge-delays (min (max attempt 0) (dec (count nudge-delays))))))

(defn unattended-nudge [plan]
  (let [stage (str/upper-case (str (:stage plan)))
        expected (str (:expected-tool plan))
        open-items (vec (:open-items plan))
        parked (vec (:parked plan))
        lines (cond-> [(str "[UNATTENDED NUDGE — STAGE " stage "]")
                       "思考过程与全部对外输出，一律用简体中文。"
                       (str "当前阶段尚未到达合法出口，严禁以纯聊天正文自然停止！所有结构化推进与长文档保存必须调用专用工具（当前应调用：`" expected "`）。")
                       "系统处于常授权无人值守模式（仅 S1 的 `attach_brainstorm` 手工批准、`ask_user` 澄清与 S5 初任空账的一次性询问例外）：禁止等待用户决策或授权，禁止半途而废，禁止退回舒适区！"]
                (seq open-items)
                (conj (str "未结义务台账（立刻逐项销账）：" newline-char
                           (str/join newline-char (map (fn [item] (str "- " item)) open-items))))
                (seq parked)
                (conj (str "当前仍有挂起未恢复的沙箱程序句柄："
                           (str/join ", " parked)
                           "（请明确调用 `unpark` 恢复或推进新决策，系统不会代你自动恢复）。")))]
    (str/join newline-char lines)))

(defn- abort-end? [event]
  (or (true? (.-willContinue event))
      (true? (.-userAborted event))
      (= "user" (.-abortReason event))
      (some (fn [message]
              (and (= "assistant" (.-role message))
                   (= "aborted" (.-stopReason message))))
            (array-seq (or (.-messages event) #js [])))))

(defn- subagent-nudge-plan [role stage successful]
  (let [exit (case role
               "Plan DevOps" "submit_devops_report"
               "Reviewer" "review"
               "Swarm Worker" "board_finish"
               "Swarm Holder" "board_finish"
               "Manual Auditor" "attach_case_audit"
               nil)
        parked (vec (repl/parked-names))]
    (cond
      (nil? exit) nil
      (contains? successful "ask_user") nil
      (contains? successful exit) nil
      (and (= role "Swarm Holder") (contains? successful "board_take_or_die")) nil
      (and (= role "Swarm Worker") (contains? successful "board_park_slot")) nil
      :else {:stage (if stage (name stage) "s5")
             :expected-tool exit
             :open-items []
             :parked parked})))

(defn- mission-nudge-plan [key mission stage successful]
  (cond
    (contains? successful "ask_user") nil
    (and (= stage :s1) (map? (get-in mission [:attach :pending]))) nil
    :else
    (let [ready? (true? (get-in mission [:attach :ready]))
          expected (cond
                     (contains? #{:s1 :s2 :s3 :s4} stage)
                     (if ready?
                       (name (tenure/attach-tool-for-stage stage))
                       "review")
                     (= stage :s5) "review"
                     :else nil)]
      (when (and expected (not (contains? successful expected)))
        {:stage (if stage (name stage) "s1")
         :expected-tool expected
         :open-items (vec (get-in @state [:sessions key :open-items] []))
         :parked (vec (repl/parked-names))}))))

(defn nudge-plan [ctx event]
  (let [key (session-key ctx)
        role (get-in @state [:sessions key :role-token :role])
        slug (get-in @state [:sessions key :slug])
        mission (get-in @state [:sessions key :mission])
        stage (tenure/normalize-stage (:stage mission))
        successful (get-in @state [:sessions key :successful-tools] #{})]
    (cond
      (abort-end? event) nil
      (and (nil? role) (nil? slug)) nil
      (and (subagent? ctx) (nil? role)) nil
      (= stage :completed) nil
      role (subagent-nudge-plan role stage successful)
      :else (when (text? slug)
              (mission-nudge-plan key mission stage successful)))))

(defn- deliver-nudge! [pi text]
  (let [deliver (get-in @state [:options :deliver-nudge])]
    (cond
      (fn? deliver)
      (try
        (let [value (deliver text)]
          (when (and value (fn? (.-catch value)))
            (.catch value (fn [_] (swap! state assoc-in [:nudge :pending] text)))))
        (catch :default _ (swap! state assoc-in [:nudge :pending] text)))

      (and pi (fn? (.-sendMessage pi)))
      (try
        (.sendMessage pi
                      #js {:customType "herd-nudge" :content text :display false}
                      #js {:triggerTurn true})
        (catch :default _ (swap! state assoc-in [:nudge :pending] text)))

      :else
      (swap! state assoc-in [:nudge :pending] text))))

(defn- schedule-nudge! [pi text delay]
  (clear-nudge-timer!)
  (let [set-timer (or (get-in @state [:options :set-timeout])
                      (fn [f ms] (js/setTimeout f ms)))
        timer (set-timer (fn [] (deliver-nudge! pi text)) delay)]
    (swap! state assoc-in [:nudge :timer] timer)
    (try
      (when (and timer (fn? (.-unref timer))) (.unref timer))
      (catch :default _ nil))
    timer))

(defn- safe-json-text [value]
  (when (some? value)
    (try
      (let [text (js/JSON.stringify value)]
        (if (string? text) text (str value)))
      (catch :default _ (str value)))))

(defn- last-assistant-message [event]
  (let [messages (.-messages event)]
    (if-not (array? messages)
      nil
      (loop [index (dec (.-length messages))]
        (if (neg? index)
          nil
          (let [message (aget messages index)]
            (if (= "assistant" (.-role message))
              message
              (recur (dec index)))))))))

(defn- last-assistant-stop [event]
  (when-let [message (last-assistant-message event)]
    (.-stopReason message)))

(defn- event-blob [event]
  (when event
    (let [assistant (last-assistant-message event)
          stop (when assistant (.-stopReason assistant))
          assistant-err? (contains? #{"error" "aborted"} stop)]
      (str/join newline-char
                (remove nil?
                        [(safe-json-text (.-error event))
                         (safe-json-text (.-errorMessage event))
                         (safe-json-text (.-reason event))
                         (safe-json-text (.-stderr event))
                         (when (true? (.-isError event))
                           (safe-json-text (.-result event)))
                         (when assistant-err?
                           (safe-json-text (.-error assistant)))
                         (when assistant-err?
                           (safe-json-text (.-errorMessage assistant)))])))))

(defn- user-cancelled? [event]
  (or (true? (.-userAborted event))
      (= "user" (.-abortReason event))
      (let [signal (.-signal event)]
        (and (some? signal)
             (true? (.-aborted signal))
             (let [reason (.-reason signal)]
               (or (= "user" reason)
                   (and (string? reason)
                        (str/includes? (str/lower-case reason) "user"))))))))

(defn- upstream-failure-kind [event]
  (let [blob (or (event-blob event) "")
        stop (last-assistant-stop event)]
    (cond
      (re-find upstream-quota-pattern blob) :quota
      (re-find upstream-status-pattern blob) :retryable
      (re-find upstream-network-pattern blob) :retryable
      (and (= "aborted" stop) (not (user-cancelled? event))) :retryable
      :else nil)))

(defn- clear-upstream-timer! []
  (let [timer (get-in @state [:upstream :timer])
        clear (or (get-in @state [:options :clear-timeout]) js/clearTimeout)]
    (when timer
      (try (clear timer) (catch :default _ nil)))
    (swap! state assoc-in [:upstream :timer] nil)))

(defn- reset-upstream! []
  (clear-upstream-timer!)
  (swap! state assoc :upstream
         {:attempts 0
          :timer nil
          :stalled false
          :events (get-in @state [:upstream :events] [])}))

(defn- note-upstream! [entry]
  (let [record (assoc entry :at (now-iso))]
    (swap! state update-in [:upstream :events] (fnil conj []) record)
    (record-health! (merge {:entry "system.upstream" :status "degraded"} record))
    record))

(defn- deliver-upstream-retry! [pi text]
  (let [deliver (get-in @state [:options :deliver-retry])]
    (cond
      (fn? deliver)
      (try
        (let [value (deliver text)]
          (when (and value (fn? (.-catch value)))
            (.catch value (fn [_] nil))))
        (catch :default _ nil))

      (and pi (fn? (.-sendMessage pi)))
      (try
        (.sendMessage pi
                      #js {:customType "herd-upstream-retry" :content text :display false}
                      #js {:triggerTurn true})
        (catch :default _ nil))

      :else nil)))

(defn- schedule-upstream-retry! [pi delay attempt remaining]
  (let [set-timer (or (get-in @state [:options :set-timeout])
                      (fn [f ms] (js/setTimeout f ms)))
        timer (set-timer
                (fn []
                  (deliver-upstream-retry!
                    pi
                    (str "[UPSTREAM RETRY " attempt "/" (count upstream-backoff-ms) "] "
                         "上游连接中断（无用户取消信号）。请从最近一次成功的工具结果继续，"
                         "不要重放已完成的写操作；剩余重试预算 " remaining " 次。")))
                delay)]
    (swap! state assoc-in [:upstream :timer] timer)
    (try
      (when (and timer (fn? (.-unref timer))) (.unref timer))
      (catch :default _ nil))
    timer))

(defn- guard-upstream! [pi event]
  (try
    (let [kind (upstream-failure-kind event)]
      (cond
        (user-cancelled? event)
        (do (reset-upstream!) nil)

        (= :quota kind)
        (do
          (clear-upstream-timer!)
          (swap! state assoc-in [:upstream :stalled] true)
          (note-upstream! {:status "stalled"
                           :reason :insufficient-quota
                           :stop (last-assistant-stop event)})
          nil)

        (= :retryable kind)
        (let [attempt (get-in @state [:upstream :attempts] 0)
              index (min attempt (dec (count upstream-backoff-ms)))
              delay (nth upstream-backoff-ms index)
              next-attempt (inc attempt)
              remaining (max 0 (- (count upstream-backoff-ms) next-attempt))]
          (clear-upstream-timer!)
          (swap! state assoc-in [:upstream :attempts] next-attempt)
          (swap! state assoc-in [:upstream :stalled] false)
          (note-upstream! {:status "retry-scheduled"
                           :reason :upstream-disconnect
                           :attempt next-attempt
                           :delay-ms delay
                           :remaining remaining
                           :stop (last-assistant-stop event)})
          (schedule-upstream-retry! pi delay next-attempt remaining)
          nil)

        :else
        (do
          (when-not (get-in @state [:upstream :stalled])
            (reset-upstream!))
          nil)))
    (catch :default error
      (record-health! {:entry "system.upstream"
                       :status "degraded"
                       :reason "the upstream guard failed"
                       :error (str error)})
      nil)))

(defn- on-agent-end! [pi event ctx]
  (guard-upstream! pi event)
  (try
    (let [plan (nudge-plan ctx event)]
      (if (nil? plan)
        (clear-nudge-timer!)
        (let [key (session-key ctx)
              progress? (pos? (count (get-in @state [:sessions key :successful-tools] #{})))
              attempts (get-in @state [:nudge :attempts] 0)
              delay (next-nudge-delay attempts progress?)]
          (swap! state assoc-in [:nudge :attempts]
                 (if progress? 0 (inc attempts)))
          (schedule-nudge! pi (unattended-nudge plan) delay))))
    (catch :default error
      (record-health! {:entry "system.nudge"
                       :status "degraded"
                       :reason "nudge scheduling failed"
                       :error (str error)})))
  nil)

(defn- note-tool-end! [pi event ctx]
  (when (true? (.-isError event))
    (guard-upstream! pi event))
  (try
    (let [key (session-key ctx)
          name (.-toolName event)
          ok? (not (.-isError event))]
      (when (string? name)
        (swap! state update-in [:sessions key :turn-tools] (fnil conj #{}) name)
        (when ok?
          (swap! state update-in [:sessions key :successful-tools] (fnil conj #{}) name)
          (when (contains? progress-tool-names name)
            (reset-nudge!)))))
    (catch :default _ nil))
  nil)

(defn consume-nudge! []
  (let [text (get-in @state [:nudge :pending])]
    (when (text? text)
      (swap! state assoc-in [:nudge :pending] nil)
      (str newline-char "<system-reminder>" newline-char text newline-char "</system-reminder>"))))

(defn- tool-result [value]
  {:content [{:type "text" :text (ufss/canonical value)}]})

(defn- tool-error [value]
  {:isError true
   :content [{:type "text" :text (ufss/canonical value)}]})

(defn- gate-failure [code message data]
  {:ok false :error (merge {:code code :message message} data)})

(defn- result->tool [value]
  (if (and (map? value) (false? (:ok value)))
    (tool-error value)
    (tool-result value)))

(defn- bridge-execute [f]
  (fn [call-id params signal on-update ctx]
    (try
      (-> (f call-id params signal on-update ctx)
          (.then (fn [value] (clj->js value)))
          (.catch (fn [error]
                    (clj->js (tool-error (gate-failure :INTERNAL
                                                       (or (ex-message error) (str error))
                                                       {}))))))
      (catch :default error
        (clj->js (tool-error (gate-failure :INTERNAL
                                           (or (ex-message error) (str error))
                                           {})))))))

(defn- bridge-execute-tool [f]
  (bridge-execute
    (fn [call-id params signal on-update ctx]
      (let [value (f call-id params signal on-update ctx)]
        (if (and value (fn? (.-then value)))
          (.then value (fn [result] (result->tool result)))
          (result->tool value))))))

(defn- tool-names-for [pi]
  (or (.get registered-tool-names pi)
      (let [names (atom #{})]
        (.set registered-tool-names pi names)
        names)))

(defn- register-tool! [pi definition]
  (let [name (:name definition)
        names (tool-names-for pi)]
    (cond
      (contains? @names name)
      true

      (fn? (.-registerTool pi))
      (do
        (.registerTool pi
                       (clj->js
                         (cond-> {:name name
                                  :label (:label definition)
                                  :description (:description definition)
                                  :loadMode (:load-mode definition)
                                  :parameters (:parameters definition)
                                  :execute (:execute definition)}
                           (:renderCall definition) (assoc :renderCall (:renderCall definition))
                           (:renderResult definition) (assoc :renderResult (:renderResult definition)))))
        (swap! names conj name)
        true)

      :else
      (do
        (record-health! {:entry "system.tools"
                         :status "degraded"
                         :reason "host extension API lacks registerTool"
                         :tool name})
        false))))

(defn- ^:async invoke-service [service tool request options]
  (cond
    (= tool :review) ((:review! service) request options)
    (contains? #{:attach_manual_tests :attach_dev_guide :attach_coordination} tool)
    ((:attach! service) tool request options)
    (= tool :ask_user) ((:ask-user! service) request options)
    (= tool :devops) ((:devops! service) request options)
    (= tool :submit_devops_report) ((:submit-devops-report! service) request options)
    :else (gate-failure :INVALID_ARGUMENT "unknown gate tool" {:tool tool})))

(defn- ^:async pending-attach-of [root slug]
  (let [read (await (store/read-mission root slug))]
    (when (:ok read) (get-in read [:mission :attach :pending]))))

(defn- awaiting-receipt [slug reason]
  {:ok true
   :status :awaiting-user
   :stage :s1
   :slug slug
   :reason reason
   :suppress-nudge true})

(defn- normalize-decision [decision]
  (case (:decision decision)
    "approve" {:decision "approve"}
    "revise" {:decision "revise" :feedback (or (:feedback decision) "")}
    "deny" {:decision "deny" :feedback (or (:feedback decision) "")}
    nil))

(defn- attach-denied-result [result]
  (if (= :denied (:status result))
    (assoc result
           :ask-user {:question (or (text? (:feedback result))
                                    (text? (:question result)))
                      :context "attach_brainstorm 的确认面板返回 deny；未提交 barrier，仍留在 S1。"})
    result))

(defn- ^:async attach-brainstorm! [service deps request options ctx]
  (let [root (:root options)
        slug (:slug options)
        pending (when (and (text? root) (text? slug))
                  (await (pending-attach-of root slug)))]
    (if (map? pending)
      (let [args {:root root
                  :slug slug
                  :stage :s1
                  :tool :attach_brainstorm
                  :pending pending
                  :path (:path pending)
                  :sha256 (:sha256 pending)
                  :markdown nil
                  :ctx ctx}
            decision (try
                       [:ok (await ((:confirm deps) args))]
                       (catch :default error [:error error]))]
        (if (= :error (first decision))
          (do
            (record-health! {:entry "system.attach"
                             :status "degraded"
                             :reason "S1 confirmation host failed"
                             :error (str (second decision))})
            (awaiting-receipt slug :host-confirm-error))
          (let [normalized (normalize-decision (second decision))]
            (if normalized
              (let [result (await ((:resume-approval! service) root slug normalized))]
                (attach-denied-result result))
              (awaiting-receipt slug (or (:reason (second decision)) :host-pending))))))
      (await ((:attach! service) :attach_brainstorm request options)))))

(defn- ^:async gate-execute! [service deps tool params ctx call-id]
  (let [key (session-key ctx)
        turn-id (get-in @state [:sessions key :turn-id])
        cached (get-in @state [:sessions key :gate-cache])
        cache-hit? (and cached (= turn-id (:turn-id cached)))
        request (js->clj (or params #js {}) :keywordize-keys true)
        root (resolve-root ctx)
        slug (if cache-hit? (:slug cached) (await (ensure-focus! ctx root)))
        role (if cache-hit? (:role cached) (await (role-of ctx root slug)))
        options {:root root :slug slug :role role :call-id call-id}
        mission (if cache-hit?
                  (:mission cached)
                  (when (text? slug)
                    (let [read (await (store/read-mission root slug))]
                      (when (:ok read) (:mission read)))))
        stage (tenure/normalize-stage (:stage mission))
        completed? (or (= :completed (:stage mission))
                       (= "completed" (:stage mission)))
        result0 (cond
                  (and (subagent? ctx) (nil? role))
                  (do
                    (record-health! {:entry "system.role"
                                     :status "degraded"
                                     :reason "a subagent without a valid role token cannot call gate tools"
                                     :tool (name tool)})
                    (gate-failure :CAPABILITY_DENIED
                                  "the subagent has no valid role token; refusing the gate tool"
                                  {:reason :role-token-missing}))

                  (and (= tool :submit_devops_report) (not (subagent? ctx)))
                  (do
                    (record-health! {:entry "system.role"
                                     :status "degraded"
                                     :reason "submit_devops_report needs a subagent identity"
                                     :tool "submit_devops_report"})
                    (gate-failure :CAPABILITY_DENIED
                                  "submit_devops_report is available only to the Plan DevOps subagent"
                                  {:reason :agent-identity-missing}))

                  (= tool :attach_brainstorm)
                  (await (attach-brainstorm! service deps request options ctx))

                  (and (= tool :review) completed?)
                  {:ok true
                   :status :completed
                   :stage :completed
                   :slug slug
                   :approval (:approval mission)
                   :message "the mission is already completed; review is a terminal no-op"}

                  (and (= tool :review) (= stage :s5) (= role "Reviewer"))
                  (await (s5-review! root slug mission request))

                  (and (= tool :review) (= stage :s5) (not (subagent? ctx)))
                  (await (ensure-reviewer! root slug mission))

                  :else
                  (await (invoke-service service tool request options)))
        result1 (if (and (= tool :submit_devops_report)
                         (map? result0)
                         (true? (:ok result0)))
                  (do
                    (await (write-devops-receipt! ctx (:report result0)))
                    result0)
                  result0)
        result (if (and (= tool :attach_coordination)
                        (map? result1)
                        (true? (:ok result1)))
                 (let [read (await (store/read-mission root slug))
                       next-mission (when (:ok read) (:mission read))
                       next-stage (tenure/normalize-stage (:stage next-mission))]
                   (if (= :s5 next-stage)
                     (let [reviewer (await (ensure-reviewer! root slug next-mission))]
                       (if (:ok reviewer)
                         (assoc result1 :reviewer (:reviewer reviewer))
                         (assoc result1
                                :ok false
                                :stage :s5
                                :retryable true
                                :reviewer-start reviewer)))
                     result1))
                 result1)]
    (if (and (text? slug) (not (and (map? result) (false? (:ok result)))))
      (do
        (await (refresh-mission! ctx root slug))
        (let [board (await (store/read-board root slug))
              refreshed (get-in @state [:sessions key :mission])
              open-items (open-items-of board)]
          (swap! state assoc-in [:sessions key :open-items] open-items)
          (swap! state assoc-in [:sessions key :gate-cache]
                 {:turn-id turn-id
                  :slug slug
                  :role role
                  :mission refreshed
                  :open-items open-items})))
      (swap! state update-in [:sessions key] dissoc :gate-cache))
    result))

(defn- ^:async read-document [root slug args]
  (let [pending (:pending args)
        stored (:path pending)
        relative (str "plans/" slug "/s1-brainstorm.md")
        target (cond
                 (and (string? stored) (path/isAbsolute stored)) stored
                 (string? stored) (path/join root stored)
                 :else (path/join root relative))]
    (await (.readFile fs target "utf8"))))

(defn- decision-field [value key]
  (cond
    (map? value) (get value key)
    (some? value) (aget value (name key))
    :else nil))

(defn- match-key? [keybindings data name]
  (try
    (and keybindings
         (fn? (.-matches keybindings))
         (boolean (.matches keybindings data name)))
    (catch :default _ false)))

(defn- wrap-plain-line [line width]
  (let [width (max 1 width)
        length (count line)]
    (if (<= length width)
      [line]
      (loop [start 0
             lines []]
        (if (>= start length)
          lines
          (recur (+ start width) (conj lines (subs line start (min length (+ start width))))))))))

(defn- truncate-plain [text width]
  (if (<= (count text) width)
    text
    (subs text 0 (max 1 (dec width)))))

(defn- approval-component [options]
  (let [markdown (or (:markdown options) "")
        title (or (:title options) "S1 文档审批")
        rows (or (:rows options) 24)
        keybindings (:keybindings options)
        request-render (or (:request-render options) (fn [] nil))
        done (:done options)
        local (atom {:choice "deny" :offset 0 :lines nil :width nil :settled false})
        body-height (fn [] (max 3 (- rows 4)))
        choices ["deny" "approve" "revise"]
        finish! (fn [decision]
                  (when-not (:settled @local)
                    (swap! local assoc :settled true)
                    (done {:decision decision})))]
    #js {:render
         (fn [width]
           (let [actual (max 4 (js/Math.floor width))
                 current @local]
             (when (or (nil? (:lines current)) (not= (:width current) actual))
               (let [lines (->> (str/split (str/replace markdown #"\r\n?" "\n") #"\n")
                                (mapcat (fn [line] (wrap-plain-line line (- actual 2))))
                                vec)
                     offset (max 0 (min (:offset current)
                                        (max 0 (- (count lines) (body-height)))))]
                 (swap! local assoc :lines lines :width actual :offset offset)))
             (let [current @local
                   lines (:lines current)
                   height (body-height)
                   max-offset (max 0 (- (count lines) height))
                   offset (min (:offset current) max-offset)
                   visible (subvec lines offset (min (count lines) (+ offset height)))
                   total (count lines)
                   position (if (zero? total)
                              "0/0"
                              (str (min total (inc offset)) "-"
                                   (min total (+ offset (count visible)))
                                   "/" total))
                   header (truncate-plain (str title "  " position) actual)
                   label (fn [name]
                           (let [text (case name "approve" "批准" "revise" "修改" "拒绝")]
                             (if (= (:choice current) name)
                               (str "[ " text " ]")
                               (str "  " text "  "))))
                   actions (truncate-plain
                             (str (label "deny") " " (label "approve") " " (label "revise"))
                             actual)
                   hint (truncate-plain
                          "↑/↓ PgUp/PgDn Home/End 滚动 · ←/→/Tab 选择 · Enter 确认 · Esc 取消"
                          actual)]
               (clj->js (vec (concat [header]
                                     (map (fn [line] (truncate-plain line actual)) visible)
                                     [actions hint]))))))
         :handleInput
         (fn [data]
           (let [height (body-height)
                 current @local
                 max-offset (max 0 (- (count (or (:lines current) [])) height))]
             (cond
               (or (match-key? keybindings data "tui.select.cancel")
                   (= data (js/String.fromCharCode 27)))
               (finish! "pending")

               (or (match-key? keybindings data "tui.select.confirm")
                   (= data (js/String.fromCharCode 13))
                   (= data (js/String.fromCharCode 10)))
               (finish! (:choice current))

               (or (match-key? keybindings data "tui.editor.cursorLeft")
                   (= data (str (js/String.fromCharCode 27) "[D")))
               (do
                 (swap! local update :choice
                        (fn [choice]
                          (nth choices (mod (dec (.indexOf choices choice)) (count choices)))))
                 (request-render))

               (or (match-key? keybindings data "tui.editor.cursorRight")
                   (match-key? keybindings data "tui.input.tab")
                   (= data (str (js/String.fromCharCode 27) "[C"))
                   (= data (js/String.fromCharCode 9)))
               (do
                 (swap! local update :choice
                        (fn [choice]
                          (nth choices (mod (inc (.indexOf choices choice)) (count choices)))))
                 (request-render))

               (or (match-key? keybindings data "tui.select.pageUp")
                   (match-key? keybindings data "tui.altScreen.pageUp"))
               (do (swap! local update :offset #(max 0 (- % height))) (request-render))

               (or (match-key? keybindings data "tui.select.pageDown")
                   (match-key? keybindings data "tui.altScreen.pageDown"))
               (do (swap! local update :offset #(min max-offset (+ % height))) (request-render))

               (match-key? keybindings data "tui.select.up")
               (do (swap! local update :offset #(max 0 (dec %))) (request-render))

               (match-key? keybindings data "tui.select.down")
               (do (swap! local update :offset #(min max-offset (inc %))) (request-render))

               (or (match-key? keybindings data "tui.altScreen.top")
                   (match-key? keybindings data "tui.editor.cursorLineStart"))
               (do (swap! local assoc :offset 0) (request-render))

               (or (match-key? keybindings data "tui.altScreen.bottom")
                   (match-key? keybindings data "tui.editor.cursorLineEnd"))
               (do (swap! local assoc :offset max-offset) (request-render))

               :else nil)))
         :invalidate (fn [] (swap! local assoc :lines nil :width nil))}))

(defn- ^:async ui-confirm [args ctx]
  (let [ui (when ctx (.-ui ctx))
        custom (when ui (.-custom ui))]
    (if-not (and ui (not (false? (.-hasUI ctx))) (fn? custom))
      {:decision "pending" :reason "custom-ui-unavailable"}
      (let [root (:root args)
            slug (:slug args)
            document (try
                       [:ok (await (read-document root slug args))]
                       (catch :default error [:error error]))]
        (if (= :error (first document))
          (do
            (record-health! {:entry "system.attach"
                             :status "degraded"
                             :reason "the disk S1 document is unreadable"
                             :error (str (second document))})
            {:decision "error"
             :error {:code :STALE_CONTROL
                     :message "the disk S1 document is not readable; refusing to approve memory text"}})
          (try
            (let [result (await (.custom ui
                                         (fn [tui _theme keybindings done]
                                           (approval-component
                                             {:markdown (second document)
                                              :title "S1 文档审批"
                                              :rows (or (.-rows (.-terminal tui))
                                                        (.-height tui)
                                                        24)
                                              :keybindings keybindings
                                              :request-render (fn [] (.requestRender tui))
                                              :done done}))
                                         (clj->js {:overlay true
                                                   :overlayOptions {:fullscreen true
                                                                    :width "100%"
                                                                    :maxHeight "100%"
                                                                    :anchor "top-left"
                                                                    :margin 0}
                                                   :blocked {:kind "permission"
                                                             :message "S1 manual approval"}})))
                  decision (or (decision-field result :decision)
                               (when (string? result) result))]
              (cond
                (= decision "approve") {:decision "approve"}
                (= decision "revise")
                (let [input (fn? (.-input ui))]
                  (if input
                    (let [feedback (try
                                     [:ok (await (.input ui "Revise S1" "What should change?"))]
                                     (catch :default _ [:error nil]))]
                      {:decision "revise"
                       :feedback (if (and (= :ok (first feedback))
                                          (string? (second feedback)))
                                   (second feedback)
                                   "")})
                    {:decision "revise" :feedback ""}))
                (= decision "deny") {:decision "deny"}
                :else {:decision "pending" :reason "operator-not-approved"}))
            (catch :default error
              (record-health! {:entry "system.attach"
                               :status "degraded"
                               :reason "S1 confirmation panel failed"
                               :error (str error)})
              {:decision "pending" :reason "custom-ui-error"})))))))

(defn- ^:async confirm-port [args]
  (let [injected (get-in @state [:options :confirm])]
    (if (fn? injected)
      (injected args)
      (let [ctx (or (:ctx args) (ctx-for-slug (:slug args)))]
        (ui-confirm args ctx)))))

(defn- ^:async ask-user-port [args]
  (let [injected (get-in @state [:options :ask-user])]
    (if (fn? injected)
      (injected args)
      (let [ctx (or (main-ctx-for-slug (:slug args)) (:last-ctx @state))
            ui (when ctx (.-ui ctx))
            input (when ui (.-input ui))]
        (if (fn? input)
          (let [answer (try
                         [:ok (await (.input ui (str (:question args))
                                             (str (or (:recommended-default args) ""))))]
                         (catch :default _ [:error nil]))]
            (if (and (= :ok (first answer))
                     (string? (second answer))
                     (pos? (count (str/trim (second answer)))))
              {:ok true :answer (second answer)}
              {:ok true :pending true}))
          {:ok true :pending true})))))

(defn- s5-subagent-port []
  (let [injected (or (get-in @state [:options :subagent])
                     (get-in @state [:options :run-subagent]))
        host (.-__herdHost js/globalThis)]
    (cond
      (fn? injected) injected
      (and (some? host) (fn? (.-runSubagent host)))
      (fn [request]
        (-> (.runSubagent host (clj->js request))
            (.then (fn [value] (js->clj value :keywordize-keys true)))))
      :else nil)))

(defn- s5-board-handle [root slug]
  (when (and (text? root) (text? slug))
    (try
      (swarm-store/open-board root slug)
      (catch :default _ nil))))

(defn- ^:async ensure-coordinator! [handle board]
  (if (contains? (:actors board) "Coordinator")
    {:ok true :board board}
    (let [registered (await (runner/register-actor!
                              {:board handle}
                              {:agent-id "Coordinator"
                               :slot-id "coordinator"
                               :request-id (str "s5-coordinator-" (.now js/Date))}))]
      (if-not (:ok registered)
        registered
        (let [refreshed (await (swarm-store/read-board handle))]
          {:ok true
           :board (if (swarm-model/board-state? refreshed) refreshed board)})))))

(defn- ^:async ensure-s5-board! [root slug mission]
  (let [handle (s5-board-handle root slug)]
    (if-not handle
      (gate-failure :HOST_API_MISMATCH
                    "the S5 board handle cannot be opened"
                    {:field :board :slug slug})
      (let [current (await (swarm-store/read-board handle))
            swarm? (swarm-model/board-state? current)
            board (if swarm?
                    current
                    (let [tenure-id (or (:tenure-id mission)
                                        (get-in mission [:tenure :tenure-id])
                                        "T-1")]
                      (-> (swarm-model/initial-board {:mode :swarm})
                          (assoc :tenure-id tenure-id
                                 :tenure {:term 0 :phase :swarm}
                                 :attach-ready false))))
            written (if swarm?
                      {:ok true}
                      (await (store/write-board! root slug board)))]
        (if-not (:ok written)
          (gate-failure :STALE_CONTROL
                        "the S5 board could not be initialized"
                        {:field :board :slug slug})
          (let [coordinator (await (ensure-coordinator! handle board))]
            (if (:ok coordinator)
              {:ok true :board (:board coordinator) :handle handle}
              coordinator)))))))

(defn- s5-deps [root slug mission handle]
  (let [subagent (s5-subagent-port)
        audit-deps (or (get-in @state [:options :audit-deps]) {})]
    (cond-> (merge audit-deps
                   {:root root
                    :slug slug
                    :mission mission
                    :actor "Coordinator"
                    :ask-user (fn [args] (ask-user-port (assoc args :slug slug)))})
      (some? handle) (assoc :board handle)
      (fn? subagent) (assoc :subagent subagent)
      (fn? subagent)
      (assoc :wake-slot!
             (fn [request]
               (-> (js/Promise.resolve (subagent request))
                   (.then (fn [result]
                            (if (map? result)
                              result
                              {:ok true :result result})))))))))

(defn- ^:async ensure-reviewer! [root slug mission]
  (let [existing (get-in @state [:reviewers slug])]
    (if existing
      {:ok true :status :reviewer-running :reviewer existing}
      (let [prepared (await (ensure-s5-board! root slug mission))]
        (if-not (:ok prepared)
          prepared
          (let [started (await (runner/start-reviewer!
                                 (s5-deps root slug mission (:handle prepared))
                                 {:board-state (:board prepared) :mission mission}))]
            (if-not (:ok started)
              (do
                (record-health! {:entry "system.reviewer"
                                 :status "degraded"
                                 :reason "the S5 Reviewer failed to start"
                                 :slug slug
                                 :error (get-in started [:error :message])})
                started)
              (do
                (swap! state assoc-in [:reviewers slug] (:reviewer started))
                (assoc started :status :reviewer-started)))))))))

(defn- audit-batch-port [deps board]
  (let [injected (or (get-in @state [:options :run-audit-batch])
                     (get-in @state [:options :audit-batch]))]
    (if (fn? injected)
      (injected deps {:board board})
      (auditors/run-audit-batch! deps {:board board}))))

(defn- ^:async s5-audit-finalize! [root slug value]
  (cond
    (and (map? value) (true? (:ok value)) (= :PASS (:verdict value)))
    (let [read (await (store/read-mission root slug))
          mission (when (:ok read) (:mission read))
          approval (or (:approval value) (:approval mission))
          patch (cond-> {:stage :completed}
                  (map? approval) (assoc :approval approval))
          updated (await (store/update-mission! root slug patch))]
      (if (:ok updated)
        (merge value {:status :audit-passed :stage :completed})
        (merge value {:status :audit-passed :stage :completed :mission-write updated})))

    (map? value)
    (assoc value :stage :s5)

    :else
    (gate-failure :INTERNAL "the audit batch returned no result" {:slug slug})))

(defn- ^:async s5-audit! [root slug mission board deps]
  (if-let [in-flight (get-in @state [:audit-inflight slug])]
    (await in-flight)
    (let [started (try
                    [:ok (js/Promise.resolve (audit-batch-port deps board))]
                    (catch :default error [:error error]))
          promise (if (= :ok (first started))
                    (second started)
                    (js/Promise.reject (second started)))
          tracked (-> promise
                      (.then (fn [result] (s5-audit-finalize! root slug result)))
                      (.then (fn [result]
                               (swap! state update :audit-inflight dissoc slug)
                               result))
                      (.catch (fn [error]
                                (swap! state update :audit-inflight dissoc slug)
                                (throw error))))]
      (swap! state assoc-in [:audit-inflight slug] tracked)
      (try
        (await tracked)
        (catch :default error
          (record-health! {:entry "system.audit"
                           :status "degraded"
                           :reason "the S5 audit batch failed"
                           :slug slug
                           :error (str error)})
          (gate-failure :INTERNAL
                        (or (ex-message error) (str error))
                        {:slug slug}))))))

(defn- ^:async s5-review! [root slug mission request]
  (let [prepared (await (ensure-s5-board! root slug mission))]
    (if-not (:ok prepared)
      prepared
      (let [board (:board prepared)
            deps (s5-deps root slug mission (:handle prepared))
            findings (or (:findings request) [])
            checked (runner/quiescence board {})
            term (let [value (get-in board [:tenure :term])]
                   (if (integer? value) value 0))]
        (if (or (and (sequential? findings) (seq findings))
                (not (:ok checked))
                (zero? term))
          (await (runner/reviewer-findings! deps findings
                                            {:board-state board :mission mission}))
          (await (s5-audit! root slug mission board deps)))))))

(defn- devops-call-id []
  (str "devops-" (subs (.randomUUID crypto) 0 8)))

(defn- devops-call-line [call-id]
  (str "HERD_DEVOPS_CALL: " call-id))

(defn- devops-call-id-of [prompt]
  (some (fn [line]
          (let [match (re-matches devops-call-pattern (str/trim line))]
            (when match (nth match 1))))
        (str/split (or prompt "") #"\r?\n")))

(defn- build-devops-prompt [args call-id]
  (str/join newline-char
            ["[HERD_ROLE: Plan DevOps]"
             (str "Mission slug: " (:slug args))
             (devops-call-line call-id)
             (str "Workspace: " (:root args))
             (str "Stage: " (name (or (:stage args) :s1)))
             "Inspect the real workspace with `clj_devops` (read-only)."
             "Finish exactly once by calling `submit_devops_report({status, report_markdown, inspected_paths})` with exact file paths, line spans, and empirical findings."
             "Do not edit files, do not ask a human, and do not stop before the structured report."
             ""
             "User intent:"
             (str (or (:verbose-intent args) (:intent args) ""))]))

(defn- ^:async read-devops-receipt [directory call-id]
  (try
    (let [target (path/join directory "devops-reports" (str call-id ".edn"))
          value (ufss/read (await (.readFile fs target "utf8")))]
      (when (map? value)
        {:status (some-> (or (get value :status) (get value "status")) str)
         :report-markdown (or (get value :report-markdown) (get value "report-markdown"))
         :inspected-paths (vec (or (get value :inspected-paths)
                                   (get value "inspected-paths")
                                   []))}))
    (catch :default _ nil)))

(defn- ^:async write-devops-receipt! [ctx report]
  (try
    (let [key (session-key ctx)
          call-id (get-in @state [:sessions key :devops-call-id])
          manager (session-manager ctx)
          session-file (when (and manager (fn? (.-getSessionFile manager)))
                         (.getSessionFile manager))]
      (when (and (text? call-id) (text? session-file))
        (let [directory (path/join (path/dirname session-file) "devops-reports")
              target (path/join directory (str call-id ".edn"))]
          (await (.mkdir fs directory #js {:recursive true}))
          (await (atomic/write-edn-atomic!
                   target
                   {:status (:status report)
                    :report-markdown (:report_markdown report)
                    :inspected-paths (vec (:inspected_paths report))}))
          target)))
    (catch :default error
      (record-health! {:entry "system.devops"
                       :status "degraded"
                       :reason "the devops receipt could not be persisted"
                       :error (str error)})
      nil)))

(defn- devops-timeout-ms []
  (let [value (get-in @state [:options :devops-timeout-ms])]
    (if (and (number? value) (pos? value))
      value
      (* 20 60 1000))))

(defn- ^:async run-devops-port [args]
  (let [injected (get-in @state [:options :run-devops])
        global (.-__herdRunDevops js/globalThis)
        subagent (s5-subagent-port)]
    (cond
      (fn? injected) (injected args)
      (and (nil? subagent) (fn? global)) (global args)
      (nil? subagent)
      (do
        (record-health! {:entry "system.devops"
                         :status "degraded"
                         :reason "host.runSubagent is not available"})
        {:ok false
         :error {:code :HOST_API_MISMATCH
                 :message "host.runSubagent is not available"
                 :reason :port-missing}})
      :else
      (let [root (:root args)
            slug (:slug args)
            call-id (devops-call-id)
            short-id (subs call-id 7)
            artifacts-dir (path/join root ".herd" "artifacts" slug (str "PlanDevOps-" short-id))
            request {:role "Plan DevOps"
                     :name (str "PlanDevOps-" slug "-" short-id)
                     :prompt (build-devops-prompt args call-id)
                     :cwd root
                     :artifacts-dir artifacts-dir
                     :signal (:signal args)}
            started (try
                      [:ok (js/Promise.resolve (subagent request))]
                      (catch :default error [:error error]))]
        (if (= :error (first started))
          (do
            (record-health! {:entry "system.devops"
                             :status "degraded"
                             :reason "the Plan DevOps subagent failed to start"
                             :slug slug
                             :error (str (second started))})
            (gate-failure :AGENT_SPAWN_FAILED
                          (str "the Plan DevOps subagent failed to start: " (second started))
                          {:slug slug :call-id call-id}))
          (let [timeout (devops-timeout-ms)
                timer (atom nil)
                timeout-promise (js/Promise.
                                  (fn [resolve]
                                    (reset! timer
                                            (js/setTimeout (fn [] (resolve {:devops-timeout true}))
                                                           timeout))))
                raced (try
                        [:ok (await (js/Promise.race
                                      (into-array [(second started) timeout-promise])))]
                        (catch :default error [:error error]))
                _ (when @timer (js/clearTimeout @timer))
                outcome (second raced)]
            (cond
              (= :error (first raced))
              (do
                (record-health! {:entry "system.devops"
                                 :status "degraded"
                                 :reason "the Plan DevOps subagent failed"
                                 :slug slug
                                 :error (str outcome)})
                (gate-failure :AGENT_SPAWN_FAILED
                              (str "the Plan DevOps subagent failed: " outcome)
                              {:slug slug :call-id call-id}))

              (and (map? outcome) (:devops-timeout outcome))
              (do
                (record-health! {:entry "system.devops"
                                 :status "degraded"
                                 :reason "the Plan DevOps subagent timed out"
                                 :slug slug
                                 :call-id call-id})
                (gate-failure :UPSTREAM_ABORTED
                              (str "the Plan DevOps subagent timed out after " timeout "ms")
                              {:slug slug :call-id call-id :timeout-ms timeout}))

              :else
              (let [session-file (or (:sessionFile outcome) (:session-file outcome))
                    directories (vec (distinct (remove nil?
                                                       [(when (text? session-file)
                                                          (path/dirname session-file))
                                                        artifacts-dir])))
                    receipt (loop [remaining directories result nil]
                              (if (or result (empty? remaining))
                                result
                                (recur (rest remaining)
                                       (await (read-devops-receipt (first remaining)
                                                                   call-id)))))]
                (if receipt
                  {:ok true
                   :status (if (= "blocked" (:status receipt)) :blocked :devops-report)
                   :report {:status (:status receipt)
                            :report_markdown (:report-markdown receipt)
                            :inspected_paths (:inspected-paths receipt)}
                   :agent-id (:agent-id outcome)
                   :call-id call-id}
                  (do
                    (record-health! {:entry "system.devops"
                                     :status "degraded"
                                     :reason "the Plan DevOps subagent ended without a submit_devops_report receipt"
                                     :slug slug
                                     :call-id call-id
                                     :agent-error (:error outcome)})
                    {:ok false
                     :error {:code :AGENT_SPAWN_FAILED
                             :message "the Plan DevOps subagent finished without a submit_devops_report receipt"
                             :slug slug
                             :call-id call-id
                             :agent-error (:error outcome)}}))))))))))

(defn- gate-deps []
  {:confirm (fn [args] (confirm-port args))
   :ask-user (fn [args] (ask-user-port args))
   :run-devops (fn [args] (run-devops-port args))
   :now (fn [] (now-iso))})

(defn- register-gate-tools! [pi]
  (let [deps (gate-deps)
        service (or (:gate-service @state)
                    (let [created (gates/create-service deps)]
                      (swap! state assoc :gate-service created)
                      created))]
    (doseq [definition (gates/tool-definitions service deps)]
      (let [tool (keyword (:name definition))
            wrapped (assoc definition
                           :execute (bridge-execute-tool
                                      (fn [call-id params _signal _on-update ctx]
                                        (gate-execute! service deps tool params ctx call-id))))]
        (register-tool! pi wrapped)))
    service))

(defn- ^:async board-execute! [tool params ctx call-id]
  (let [root (resolve-root ctx)
        slug (await (ensure-focus! ctx root))
        role (get-in @state [:sessions (session-key ctx) :role-token :role])
        actor-id (agent-id ctx)]
    (cond
      (not (subagent? ctx))
      (do
        (record-health! {:entry "system.role"
                         :status "degraded"
                         :reason "board tools need a subagent identity"
                         :tool (name tool)})
        (gate-failure :CAPABILITY_DENIED
                      "board tools are available only to swarm subagents"
                      {:tool (name tool) :reason :agent-identity-missing}))

      (not (contains? #{"Swarm Worker" "Swarm Holder"} role))
      (gate-failure :CAPABILITY_DENIED
                    "the current role may not call board tools"
                    {:role role :allowed ["Swarm Worker" "Swarm Holder"]})

      (nil? slug)
      (gate-failure :STAGE_MISMATCH
                    "the session mission focus is not bound"
                    {:field :slug :reason :session-slug-missing})

      :else
      (let [actor {:agent-id actor-id :role :normal}
            deps {:root-of (fn [_] root)
                  :slug-of (fn [_] slug)
                  :actor-of (fn [_] actor)
                  :turn-of (fn [_] (get-in @state [:sessions (session-key ctx) :turn-id]))}
            request (js->clj (or params #js {}) :keywordize-keys true)]
        (await (swarm-tools/execute-tool! deps tool request ctx call-id))))))

(defn- register-board-tools! [pi]
  (doseq [definition (swarm-tools/tool-definitions {})]
    (let [tool (keyword (:name definition))
          wrapped (assoc definition
                         :execute (bridge-execute
                                    (fn [call-id params _signal _on-update ctx]
                                      (board-execute! tool params ctx call-id))))]
      (register-tool! pi wrapped))))

(defn- audit-parameters []
  {:type "object"
   :additionalProperties false
   :required ["case_id" "user_score" "developer_score" "report_markdown"]
   :properties {:case_id {:type "string" :minLength 1}
                :user_score {:type "number" :minimum 0 :maximum 100}
                :developer_score {:type "number" :minimum 0 :maximum 100}
                :report_markdown {:type "string" :minLength 1}}})

(defn- ^:async audit-execute! [params ctx _call-id]
  (let [request (js->clj (or params #js {}) :keywordize-keys true)
        root (resolve-root ctx)
        slug (await (ensure-focus! ctx root))
        role (await (role-of ctx root slug))]
    (cond
      (not (subagent? ctx))
      (do
        (record-health! {:entry "system.role"
                         :status "degraded"
                         :reason "attach_case_audit needs a Manual Auditor subagent"
                         :tool "attach_case_audit"})
        (gate-failure :CAPABILITY_DENIED
                      "attach_case_audit is available only to the Manual Auditor subagent"
                      {:reason :agent-identity-missing}))

      (not= role "Manual Auditor")
      (gate-failure :CAPABILITY_DENIED
                    "the current role may not submit an audit"
                    {:role role :allowed ["Manual Auditor"]})

      (nil? slug)
      (gate-failure :STAGE_MISMATCH
                    "the session mission focus is not bound"
                    {:field :slug :reason :session-slug-missing})

      :else
      (let [written (await (audit/write-submission-once! root slug
                                                         (:case_id request)
                                                         request))]
        (if (:ok written)
          {:ok true
           :status :audit-submitted
           :case-id (:case_id request)
           :path (:path written)}
          written)))))

(defn- register-audit-tool! [pi]
  (register-tool! pi
                  {:name "attach_case_audit"
                   :label "Attach Case Audit"
                   :description "Submit one Manual Auditor CASE verdict with dual willingness-to-pay scores and a complete report."
                   :load-mode "essential"
                   :parameters (audit-parameters)
                   :renderCall ui/audit-render-call
                   :renderResult ui/audit-render-result
                   :execute (bridge-execute-tool
                              (fn [call-id params _signal _on-update ctx]
                                (audit-execute! params ctx call-id)))}))

(defn- register-tools! [pi]
  (cond
    (.has registered-tool-pis pi)
    true

    (fn? (.-registerTool pi))
    (do
      (register-gate-tools! pi)
      (register-board-tools! pi)
      (register-audit-tool! pi)
      (.add registered-tool-pis pi)
      true)

    :else
    (do
      (record-health! {:entry "system.tools"
                       :status "degraded"
                       :reason "host extension API lacks registerTool"})
      false)))

(defn- timestamp-slug []
  (let [date (js/Date.)
        pad (fn [value] (if (< value 10) (str "0" value) (str value)))]
    (str "mission-"
         (.getFullYear date)
         (pad (inc (.getMonth date)))
         (pad (.getDate date))
         "-"
         (pad (.getHours date))
         (pad (.getMinutes date))
         (pad (.getSeconds date)))))

(defn- slug-for [seed]
  (let [words (re-seq #"[A-Za-z0-9]+" (str seed))
        base (-> (str/join "-" (map str/lower-case words))
                 (str/replace #"^-+" "")
                 (str/replace #"-+$" ""))
        trimmed (if (> (count base) 40) (subs base 0 40) base)]
    (if (pos? (count trimmed)) trimmed (timestamp-slug))))

(defn- ^:async unique-slug! [root base]
  (loop [candidate base counter 2]
    (let [read (await (store/read-mission root candidate))]
      (if-not (:ok read)
        candidate
        (if (> counter 20)
          (str base "-" (js/Date.now))
          (recur (str base "-" counter) (inc counter)))))))

(defn- notify! [ctx text]
  (try
    (let [ui (when ctx (.-ui ctx))]
      (when (and ui (fn? (.-notify ui)))
        (.notify ui text "info")))
    (catch :default _ nil))
  text)

(defn- ^:async herd-command! [pi args ctx]
  (try
    (let [seed (str/trim (if (string? args) args (str (or args ""))))
          root (resolve-root ctx)]
      (if (empty? seed)
        (notify! ctx "用法：/herd <seed>")
        (let [slug (await (unique-slug! root (slug-for seed)))
              now (now-iso)
              created (await (store/create-mission!
                               root
                               {:slug slug
                                :seed seed
                                :now now
                                :tenure {:tenure-id "T-1"
                                         :index 1
                                         :started-at now
                                         :ended-at nil}}))]
          (if-not (:ok created)
            (notify! ctx (str "创建使命失败：" (or (get-in created [:error :message]) "unknown")))
            (let [tenure-id (get-in created [:mission :tenure :tenure-id])
                  _ (await (store/update-mission! root slug {:control-version 1}))
                  _ (await (store/write-board! root slug (tenure/empty-board tenure-id)))
                  key (session-key ctx)
                  read (await (store/read-mission root slug))
                  mission (if (:ok read) (:mission read) (:mission created))
                  _ (swap! state update-in [:sessions key]
                           assoc :root root :slug slug :mission mission
                           :stage (tenure/normalize-stage (:stage mission))
                           :turn-tools #{} :successful-tools #{})
                  _ (await (remember-focus! root key slug tenure-id))
                  _ (await (refresh-missions-cache! root))
                  _ (await (apply-surface! pi ctx))]
              (when (fn? (.-sendUserMessage pi))
                (try
                  (.sendUserMessage pi seed #js {:expandPromptTemplates false})
                  (catch :default error
                    (record-health! {:entry "system.herd"
                                     :status "degraded"
                                     :reason "sendUserMessage failed"
                                     :error (str error)}))))
              (notify! ctx (str "使命 " slug " 已创建并聚焦，进入 S1。")))))))
    (catch :default error
      (record-health! {:entry "system.herd"
                       :status "degraded"
                       :reason "the /herd command failed"
                       :error (str error)})
      (notify! ctx (str "创建使命失败：" (or (ex-message error) (str error)))))))

(defn- completion-entries [prefix]
  (let [p (if (string? prefix) prefix "")]
    (->> (get @state :missions-cache [])
         (filter (fn [slug] (str/starts-with? slug p)))
         (mapv (fn [slug]
                 #js {:value slug :label slug :description "已知使命"})))))

(defn- register-command! [pi]
  (cond
    (.has registered-command-pis pi)
    true

    (fn? (.-registerCommand pi))
    (do
      (.registerCommand pi "herd"
                        #js {:description "Start and focus a Herdchestra Lite mission from a seed."
                             :handler (fn [args ctx] (herd-command! pi args ctx))
                             :getArgumentCompletions (fn [prefix]
                                                       (clj->js (completion-entries prefix)))})
      (.add registered-command-pis pi)
      true)

    :else
    (do
      (record-health! {:entry "system.command"
                       :status "degraded"
                       :reason "host extension API lacks registerCommand"})
      false)))

(defn- register-hooks! [pi]
  (cond
    (.has registered-hook-pis pi)
    true

    (fn? (.-on pi))
    (do
      ;; Mark before mounting: a partially mounted hook set must not be mounted twice.
      (.add registered-hook-pis pi)
      (.on pi "agent_end"
           (fn [event ctx]
             (js/Promise.resolve (on-agent-end! pi event ctx))))
      (.on pi "tool_execution_end"
           (fn [event ctx]
             (note-tool-end! pi event ctx)
             nil))
      true)

    :else
    (do
      (record-health! {:entry "system.hooks"
                       :status "degraded"
                       :reason "host extension API lacks on"})
      false)))

(defn install! [pi options]
  (if (or (nil? pi) (.has installed-pis pi))
    false
    (let [options (or options {})]
      (try
        (swap! state assoc :pi pi :options options)
        (if (and (register-tools! pi)
                 (register-command! pi)
                 (register-hooks! pi))
          (do
            (.add installed-pis pi)
            (swap! state update :installed-count (fnil inc 0))
            (swap! state assoc :installed true)
            (ignore-rejection (refresh-missions-cache!
                                (or (:root options) (path/resolve (js/process.cwd)))))
            true)
          false)
        (catch :default error
          (record-health! {:entry "system.install"
                           :status "degraded"
                           :reason "system installation failed"
                           :error (str error)})
          false)))))