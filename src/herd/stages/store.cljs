(ns herd.stages.store
  (:require
   ["node:crypto" :as crypto]
   ["node:fs/promises" :as fs]
   ["node:path" :as path]
   [clojure.string :as string]
   [herd.stages.mission :as mission]
   [herd.stages.session-log :as session-log]
   [herd.stages.tenure :as tenure]
   [herd.ufss :as ufss]
   [herd.util.atomic-write :as atomic]))

(def ^:private slug-pattern #"^[a-z0-9][a-z0-9-]{0,63}$")

(defonce ^:private session-source (atom nil))
(defonce ^:private known-journals (atom {}))

(defn configure-session-log!
  """
Install the host resolver from a task id (the host session id) to the host
  context that owns that session log.
"""
  [source]
  (reset! session-source source)
  true)

(defn reset-journals!
  "Test seam: forget remembered session contexts."
  []
  (reset! known-journals {})
  nil)

(defn- text? [value]
  (and (string? value) (pos? (count (string/trim value)))))

(defn- root-of [root]
  (or root "."))

(defn- failure [code message data]
  {:ok false :error (merge {:code code :message message} data)})

(defn- now-iso []
  (.toISOString (js/Date.)))

(defn- journal-key [root slug]
  [(root-of root) slug])

(defn- source-ctx [slug]
  (let [source @session-source
        lookup (:ctx-of source)]
    (when (fn? lookup) (lookup slug))))

(defn- journal-candidates [root slug ctx]
  (distinct (remove nil? [(get @known-journals (journal-key root slug))
                          (source-ctx slug)
                          ctx])))

(defn- write-ctx [root slug ctx]
  (or (get @known-journals (journal-key root slug))
      (source-ctx slug)
      ctx))

(defn- ^:async read-journal [root slug ctx]
  (let [candidates (journal-candidates root slug ctx)]
    (if (empty? candidates)
      (failure :SESSION_LOG_UNAVAILABLE
               "no session log is bound to this task"
               {:slug slug})
      (loop [remaining candidates
             first-ok nil
             first-error nil]
        (if (empty? remaining)
          (or first-ok first-error
              (failure :SESSION_LOG_UNAVAILABLE
                       "no session log is bound to this task"
                       {:slug slug}))
          (let [candidate (first remaining)
                result (await (session-log/read-entries candidate))]
            (cond
              (and (:ok result)
                   (= slug (session-log/task-id (:entries result))))
              result

              (:ok result)
              (recur (rest remaining) (or first-ok result) first-error)

              :else
              (recur (rest remaining) first-ok (or first-error result)))))))))

(defn- board-path [root slug]
  (path/join (root-of root) "herd" slug "board.edn"))

(defn ^:async read-board [root slug]
  (let [target (board-path root slug)]
    (try
      (ufss/read (await (.readFile fs target "utf8")))
      (catch :default error
        (if (= "ENOENT" (.-code error))
          nil
          (throw error))))))

(defn ^:async write-board! [root slug board]
  (let [written (await (atomic/write-edn-atomic!
                         (board-path root slug)
                         board))]
    {:path (:path written) :existed (:existed written)}))

(defn- stage-name [value]
  (cond
    (keyword? value) (name value)
    (string? value) value
    (nil? value) nil
    :else (str value)))

(defn- approval-sha [approval]
  (or (:reportSha256 approval) (:report-sha256 approval)))

(defn- sha256-text [text]
  (.digest (.update (.createHash crypto "sha256") text "utf8") "hex"))

(defn- ^:async report-matches? [root slug approval]
  (let [sha (approval-sha approval)
        target (path/join (root-of root) "herd" slug "s5-report.md")]
    (if-not (and (string? sha) (= 64 (count sha)))
      false
      (try
        (let [text (await (.readFile fs target "utf8"))
              recorded (or (some-> (re-find
                                     #"(?m)^\s*report_sha256:\s*[\"']?([A-Fa-f0-9]{64})[\"']?\s*$"
                                     text)
                             second)
                           (sha256-text text))]
          (= (string/lower-case sha)
             (string/lower-case recorded)))
        (catch :default _ false)))))

(defn- ^:async derive-mission [root slug entries board]
  (let [task (session-log/task-of entries)
        barrier-list (session-log/barriers entries)
        last-barrier (last barrier-list)
        barrier-count (count barrier-list)
        base-stage (or (session-log/stage-of entries) :s1)
        approval (session-log/approval-of entries)
        completed? (and (= :s5 base-stage)
                        (map? approval)
                        (await (report-matches? root slug approval)))
        stage (if completed? :completed base-stage)
        tenure-id (or (:successorTenure last-barrier)
                      (:tenure-id board)
                      (str "T-" (inc barrier-count)))
        created-at (or (:createdAt task) (:at task) "")
        revision (if (integer? (:revision approval))
                   (:revision approval)
                   barrier-count)]
    {:mission-id (:sessionId task)
     :slug (:sessionId task)
     :seed (session-log/seed-of entries)
     :created-at created-at
     :updated-at (or (some-> (last entries) :data :at) created-at)
     :stage stage
     :revision revision
     :tenure {:tenure-id tenure-id
              :index (inc barrier-count)
              :started-at (or (:at last-barrier) created-at)
              :ended-at nil}
     :tenure-id tenure-id
     :tenure-seq (inc barrier-count)
     :attach {:ready (true? (:attach-ready board))
              :expected-attach (tenure/attach-tool-for-stage stage)
              :pending (session-log/pending-of entries)}
     :barrier last-barrier
     :approval approval
     :mode (session-log/mode-of entries)
     :limits {}
     :settings {}}))

(defn ^:async read-mission
  """
Derive the mission projection from the session log plus the current board.

  The session log is the only authority. If it cannot be read, this fails
  closed; it never falls back to mission.edn or to a directory scan.
"""
  ([root slug]
   (read-mission root slug nil))
  ([root slug ctx]
   (let [slug (if (string? slug) (string/trim slug) slug)]
     (if-not (and (string? slug) (re-matches slug-pattern slug))
       (failure :INVALID_ARGUMENT
                "mission slug must be a host session id"
                {:field :slug :slug slug})
       (let [journal (await (read-journal root slug ctx))]
         (if-not (:ok journal)
           (merge {:ok false :error (:error journal)} {:slug slug})
           (let [entries (:entries journal)
                 task (session-log/task-of entries)]
             (cond
               (nil? task)
               (failure :TASK_NOT_FOUND
                        "the session log has no herd.task"
                        {:slug slug})

               (not= slug (:sessionId task))
               (failure :TASK_MISMATCH
                        "the session log task does not match the requested session"
                        {:slug slug :task (:sessionId task)})

               :else
               (let [board (await (read-board root slug))]
                 {:ok true
                  :mission (await (derive-mission root slug entries board))
                  :path nil})))))))))

(defn initial-mission [slug options]
  (let [timestamp (or (:now options) (now-iso))
        tenure-id (or (get-in options [:tenure :tenure-id]) "T-1")
        index (or (get-in options [:tenure :index]) 1)]
    {:mission-id (or (:mission-id options) slug)
     :slug slug
     :seed (or (:seed options) nil)
     :created-at timestamp
     :updated-at timestamp
     :stage :s1
     :revision 0
     :tenure {:tenure-id tenure-id
              :index index
              :started-at timestamp
              :ended-at nil}
     :attach {}
     :barrier nil
     :approval nil
     :limits (or (:limits options) {})
     :settings (or (:settings options) {})}))

(defn ^:async create-mission!
  """
Create this session's task by appending task/seed/mode entries.

  With a ctx the entries are written before success; the returned mission is
  read back from the log. Without a ctx this only builds the initial shape and
  binds nothing.
"""
  [root options]
  (let [slug (:slug options)]
    (if-not (and (string? slug) (re-matches slug-pattern slug))
      (failure :INVALID_ARGUMENT
               "slug must be a host session id"
               {:field :slug :slug slug})
      (let [ctx (:ctx options)
            _ (when ctx
                (swap! known-journals assoc (journal-key root slug) ctx))
            existing (when ctx (await (read-mission root slug ctx)))]
        (if (and existing (:ok existing))
          {:ok true :mission (:mission existing) :path nil :existed true}
          (let [mission (initial-mission slug options)
                valid (mission/validate-mission mission)]
            (if-not (:ok valid)
              valid
              (if-not ctx
                {:ok true :mission mission :path nil :existed false}
                (let [timestamp (:created-at mission)
                      task (session-log/append!
                             ctx "herd.task"
                             {:sessionId slug :createdAt timestamp})]
                  (if-not (:ok task)
                    task
                    (let [seed (session-log/append!
                                 ctx "herd.seed"
                                 {:seed (or (:seed options) "") :at timestamp})]
                      (if-not (:ok seed)
                        seed
                        (let [mode (session-log/append!
                                     ctx "herd.mode"
                                     {:mode "herd" :at timestamp})]
                          (if-not (:ok mode)
                            mode
                            (let [read (await (read-mission root slug ctx))]
                              (if (:ok read)
                                (assoc read :existed false)
                                read))))))))))))))))

(defn- barrier-data [barrier]
  (let [from (stage-name (or (:from barrier) (:stage barrier)))
        to (stage-name (:to barrier))]
    (cond-> {:from from
             :to to
             :tenure (or (:retired-tenure barrier) (:tenure barrier))
             :at (or (:at barrier) (now-iso))}
      (some? (:successor-tenure barrier))
      (assoc :successorTenure (:successor-tenure barrier))

      (some? (:review-summary barrier))
      (assoc :reviewSummary (:review-summary barrier))

      (some? (:attach-tool barrier))
      (assoc :attachTool (stage-name (:attach-tool barrier))))))

(defn- pending-data [attach]
  (if-let [pending (:pending attach)]
    (cond-> {:stage (stage-name (:stage pending))
             :tool (stage-name (:tool pending))
             :at (or (:at pending) (now-iso))}
      (some? (:call-id pending)) (assoc :callId (:call-id pending))
      (some? (:digest pending)) (assoc :digest (:digest pending))
      (some? (:path pending)) (assoc :path (:path pending))
      (some? (:sha256 pending)) (assoc :sha256 (:sha256 pending)))
    {:state "cleared" :at (now-iso)}))

(defn- approval-data [approval]
  (cond-> (dissoc approval :report-sha256)
    (some? (:report-sha256 approval))
    (assoc :reportSha256 (:report-sha256 approval))

    (some? (:kind approval))
    (assoc :kind (stage-name (:kind approval)))

    (some? (:stage approval))
    (assoc :stage (stage-name (:stage approval)))

    (some? (:decision approval))
    (assoc :decision (stage-name (:decision approval)))))

(defn- patch-writes [patch]
  (cond-> []
    (map? (:barrier patch))
    (conj ["herd.barrier" (barrier-data (:barrier patch))])

    (contains? patch :attach)
    (conj ["herd.pending" (pending-data (:attach patch))])

    (contains? patch :approval)
    (conj ["herd.approval" (approval-data (:approval patch))])

    (contains? patch :mode)
    (conj ["herd.mode" {:mode (stage-name (:mode patch)) :at (now-iso)}])

    (contains? patch :seed)
    (conj ["herd.seed" {:seed (or (:seed patch) "") :at (now-iso)}])))

(defn ^:async update-mission!
  """
Translate a control patch into append-only custom entries.

  stage, tenure and revision are derived and cannot be written separately.
  mission.edn is never touched.
"""
  ([root slug patch]
   (update-mission! root slug patch nil))
  ([root slug patch ctx]
   (let [journal (await (read-journal root slug ctx))]
     (if-not (:ok journal)
       (merge {:ok false :error (:error journal)})
       (let [entries (:entries journal)
             task (session-log/task-of entries)
             target (write-ctx root slug ctx)]
         (cond
           (nil? task)
           (failure :TASK_NOT_FOUND
                    "the session log has no herd.task"
                    {:slug slug})

           (not= slug (:sessionId task))
           (failure :TASK_MISMATCH
                    "the session log task does not match the requested session"
                    {:slug slug :task (:sessionId task)})

           (nil? target)
           (failure :SESSION_LOG_UNAVAILABLE
                    "no writable session log is bound to this task"
                    {:slug slug})

           :else
           (let [writes (patch-writes patch)
                 error (loop [remaining writes]
                         (if (empty? remaining)
                           nil
                           (let [[custom-type data] (first remaining)
                                 result (session-log/append! target custom-type data)]
                             (if (:ok result)
                               (recur (rest remaining))
                               (:error result)))))]
             (if error
               {:ok false :error error}
               (await (read-mission root slug target))))))))))