(ns herd.stages.session-log
  (:require
   ["node:fs/promises" :as fs]
   [clojure.string :as string]
   [herd.stages.mission :as mission]))

(def schema-version 1)

(defn- text? [value]
  (and (string? value) (pos? (count (string/trim value)))))

(defn- manager [ctx]
  (when ctx (.-sessionManager ctx)))

(defn- failure [code message data]
  {:ok false :error (merge {:code code :message message} data)})

(defn append!
  "Append one herd custom entry. Returns {:ok true} or a fail-closed error."
  [ctx custom-type data]
  (let [m (manager ctx)
        payload (if (contains? data :v) data (assoc data :v schema-version))
        valid (mission/validate-entry custom-type payload)]
    (cond
      (not (:ok valid)) valid

      (not (and m (fn? (.-appendCustomEntry m))))
      (failure :SESSION_LOG_UNAVAILABLE
               "the host session manager cannot append custom entries"
               {:custom-type custom-type})

      :else
      (try
        (.appendCustomEntry m custom-type (clj->js payload))
        {:ok true}
        (catch :default error
          (failure :SESSION_LOG_UNAVAILABLE
                   "the host session manager rejected a custom entry"
                   {:custom-type custom-type :error (str error)}))))))

(defn- parse-line [line index]
  (if-not (text? line)
    {:ok true :skip true}
    (try
      (let [obj (js/JSON.parse line)]
        (if-not (= "custom" (.-type obj))
          {:ok true :skip true}
          (let [custom-type (.-customType obj)]
            (if-not (and (string? custom-type)
                         (string/starts-with? custom-type "herd."))
              {:ok true :skip true}
              (if-not (contains? mission/entry-types custom-type)
                {:ok true :skip true}
                (let [data (js->clj (.-data obj) :keywordize-keys true)
                      valid (mission/validate-entry custom-type data)]
                  (if (:ok valid)
                    {:ok true :entry {:type custom-type :data data}}
                    {:ok false
                     :error (assoc (:error valid)
                                   :line (inc index)
                                   :custom-type custom-type)})))))))
      (catch :default error
        {:ok false
         :error {:code :SESSION_LOG_CORRUPT
                 :message "the session log contains an unreadable line"
                 :line (inc index)
                 :error (str error)}}))))

(defn ^:async read-entries
  "Read the authoritative herd control entries from this session. Failure is fail-closed: an unreadable file, a malformed line, an unknown schema version, or a malformed entry returns {:ok false :error ...}."
  [ctx]
  (let [m (manager ctx)
        file (when (and m (fn? (.-getSessionFile m)))
               (.getSessionFile m))]
    (if-not (text? file)
      (failure :SESSION_LOG_UNAVAILABLE
               "the host session file is unavailable"
               {:reason :session-file-missing})
      (try
        (let [text (await (.readFile fs file "utf8"))
              lines (string/split-lines text)]
          (loop [remaining lines
                 index 0
                 entries []]
            (if (empty? remaining)
              {:ok true :entries entries}
              (let [parsed (parse-line (first remaining) index)]
                (cond
                  (not (:ok parsed)) parsed
                  (:skip parsed) (recur (rest remaining) (inc index) entries)
                  :else (recur (rest remaining) (inc index)
                               (conj entries (:entry parsed))))))))
        (catch :default error
          (failure :SESSION_LOG_UNAVAILABLE
                   "the session log could not be read"
                   {:reason (or (.-code error) :read-failed)
                    :error (str error)}))))))

(defn ^:async ensure-journal! [ctx]
  (let [m (manager ctx)]
    (if (and m (fn? (.-ensureOnDisk m)))
      (try
        (await (.ensureOnDisk m))
        {:ok true}
        (catch :default error
          (failure :SESSION_LOG_UNAVAILABLE
                   "the session log could not be prepared"
                   {:error (str error)})))
      {:ok true})))

(defn ^:async flush-journal! [ctx]
  (let [m (manager ctx)]
    (if (and m (fn? (.-flush m)))
      (try
        (await (.flush m))
        {:ok true}
        (catch :default error
          (failure :SESSION_LOG_UNAVAILABLE
                   "the session log could not be flushed"
                   {:error (str error)})))
      {:ok true})))

(defn last-of [entries custom-type]
  (last (filter (fn [entry] (= custom-type (:type entry))) entries)))

(defn task-of [entries]
  (some-> (last-of entries "herd.task") :data))

(defn task-id [entries]
  (:sessionId (task-of entries)))

(defn mode-of [entries]
  (some-> (last-of entries "herd.mode") :data :mode keyword))

(defn seed-of [entries]
  (some-> (last-of entries "herd.seed") :data :seed))

(defn barriers [entries]
  (->> entries
       (filter (fn [entry] (= "herd.barrier" (:type entry))))
       (mapv :data)))

(defn stage-of [entries]
  (let [to (:to (last (barriers entries)))]
    (when (string? to) (keyword to))))

(defn- last-index-of [entries custom-type]
  (last (keep-indexed (fn [index entry]
                        (when (= custom-type (:type entry)) index))
                      entries)))

(defn approval-of [entries]
  (some-> (last-of entries "herd.approval") :data))

(defn pending-of [entries]
  (let [pending-index (last-index-of entries "herd.pending")
        approval-index (last-index-of entries "herd.approval")]
    (when (and pending-index
               (or (nil? approval-index) (> pending-index approval-index)))
      (let [data (:data (nth entries pending-index))]
        (when-not (= "cleared" (:state data)) data)))))