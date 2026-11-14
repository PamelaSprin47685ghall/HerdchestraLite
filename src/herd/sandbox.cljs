(ns herd.sandbox
  (:require
   ["node:child_process" :as cp]
   ["node:path" :as path]
   [clojure.string :as string]
   [herd.clock :as clock]))

(def ^:private fs-promises (js/require "node:fs/promises"))

(defn- resolve-path [p]
  (when-not (or (nil? p) (string? p))
    (throw (ex-info "path must be a string"
                    {:code :INVALID_ARGUMENT :field :path})))
  (path/resolve (or p ".")))

(def ^:private lock-file-name "clj-core.cross-process.lock")
(def ^:private default-lock-wait-ms 500)
(def ^:private min-lock-wait-ms 50)
(def ^:private max-lock-wait-ms 5000)
(defn- lock-wait-ms []
  (let [raw (aget (.-env js/process) "HERD_LOCK_WAIT_MS")
        value (js/Number raw)]
    (if (and raw (js/Number.isFinite value) (pos? value))
      (max min-lock-wait-ms (min (js/Math.floor value) max-lock-wait-ms))
      default-lock-wait-ms)))

(defn- lock-root []
  (let [root (.-__herdLockRoot js/globalThis)]
    (path/resolve (if (string? root) root (js/process.cwd)))))

(defn- lock-path []
  (path/join (lock-root) ".herd" "locks" lock-file-name))

(def ^:private trace-file-limit (* 1024 1024))
(defonce trace-tail (atom (js/Promise.resolve nil)))
(defonce trace-truncated (atom nil))

(defn- trace-enabled? []
  (= "1" (aget (.-env js/process) "HERD_TRACE")))

(defn- trace-target []
  (or (aget (.-env js/process) "HERD_TRACE_PATH") ".herd/perf-trace.jsonl"))

(defn- trace-dir [target]
  (let [i (.lastIndexOf target "/")]
    (if (pos? i) (.substring target 0 i) ".")))

(defn- append-trace! [event]
  (when (trace-enabled?)
    (let [line (str (js/JSON.stringify (clj->js event)) "\n")]
      (swap! trace-tail
             (fn [previous]
               (-> previous
                   (.then
                     (fn [_]
                       (let [target (trace-target)]
                         (when-not (= target @trace-truncated)
                           (-> (.stat fs-promises target)
                               (.then (fn [stats] (.-size stats)))
                               (.catch (fn [_] 0))
                               (.then
                                 (fn [size]
                                   (let [bytes (js/Buffer.byteLength line "utf8")]
                                     (if (> (+ size bytes) trace-file-limit)
                                       (do
                                         (reset! trace-truncated target)
                                         (-> (.mkdir fs-promises (trace-dir target) #js {:recursive true})
                                             (.then
                                               (fn [_]
                                                 (.appendFile fs-promises target
                                                              (str (js/JSON.stringify
                                                                     (clj->js {:truncated true
                                                                               :limit trace-file-limit}))
                                                                   "\n"))))
                                             (.catch (fn [_] nil))))
                                       (-> (.mkdir fs-promises (trace-dir target) #js {:recursive true})
                                           (.then (fn [_] (.appendFile fs-promises target line)))
                                           (.catch (fn [_] nil))))))))))))
                   (.catch (fn [_] nil))))))))

(def ^:private os (js/require "node:os"))
(def ^:private crypto (js/require "node:crypto"))

(defn- new-lock-record []
  {:pid (.-pid js/process)
   :startedAt (.toISOString (js/Date.))
   :host (.hostname os)
   :cwd (js/process.cwd)
   :root (lock-root)
   :token (.randomUUID crypto)})

(defn- parse-lock [text]
  (try
    (let [value (js/JSON.parse text)]
      (if (and (some? value) (object? value) (not (array? value)))
        (js->clj value :keywordize-keys true)
        {:corrupt true}))
    (catch :default _
      (let [pid (js/parseInt text 10)]
        (if (js/Number.isNaN pid)
          {:corrupt true}
          {:pid pid :legacy true})))))

(defn- read-lock []
  (-> (.readFile fs-promises (lock-path) "utf8")
      (.then (fn [text] (parse-lock text)))
      (.catch (fn [_] nil))))

(defn- pid-alive? [pid]
  (if (and (number? pid) (pos? pid))
    (try
      (js/process.kill pid 0)
      true
      (catch :default error
        (= "EPERM" (.-code error))))
    false))

(defn- record-root [record]
  (let [root (or (:root record) (:cwd record))]
    (when (string? root) (path/resolve root))))

(defn- same-workspace? [record]
  (let [root (record-root record)]
    (or (:legacy record)
        (and root (= root (lock-root))))))

(defn- stale-lock? [record]
  (and (map? record)
       (not (:corrupt record))
       (same-workspace? record)
       (not (pid-alive? (:pid record)))))

(defn- remove-file [target]
  (-> (.unlink fs-promises target)
      (.catch (fn [_] nil))))

(defn- try-acquire []
  (let [record (new-lock-record)
        target (lock-path)]
    (-> (.mkdir fs-promises (path/dirname target) #js {:recursive true})
        (.then
          (fn []
            (.writeFile fs-promises target
                        (js/JSON.stringify (clj->js record))
                        #js {:flag "wx"})))
        (.then (fn [] {:ok record}))
        (.catch
          (fn [error]
            (if (= "EEXIST" (.-code error))
              (-> (read-lock)
                  (.then
                    (fn [holder]
                      (if (stale-lock? holder)
                        (-> (read-lock)
                            (.then
                              (fn [again]
                                (if (and (stale-lock? again)
                                         (= (:token again) (:token holder)))
                                  (-> (remove-file target)
                                      (.then (fn [_] (try-acquire))))
                                  {:busy again}))))
                        {:busy holder}))))
              (js/Promise.reject error)))))))

(defn- lock-delay-ms [attempt]
  (min 160 (* 10 (bit-shift-left 1 (min attempt 4)))))

(defn- busy-error [holder waited]
  (ex-info
    (str "write lock is busy"
         (when-let [pid (:pid holder)] (str " (pid " pid ")"))
         "; it may be held by a running call; retry this operation shortly")
    {:code :LOCK_BUSY
     :retryable true
     :waited-ms waited
     :path (lock-path)
     :holder holder
     :hint "the write lock is held by a running call or another writer; retry shortly"}))

(defn- acquire-lock
  ([attempt] (acquire-lock attempt (clock/now) nil))
  ([attempt started last-holder]
   (-> (try-acquire)
       (.then
         (fn [outcome]
           (if-let [record (:ok outcome)]
             (do
               (let [waited (- (clock/now) started)]
                 (when (pos? waited)
                   (append-trace! {:event "lock-wait"
                                   :ms waited
                                   :path (lock-path)
                                   :holder last-holder :result "acquired"})))
               record)
             (let [holder (or (:busy outcome) last-holder)
                   waited (- (clock/now) started)
                   same-process? (= (:pid holder) (.-pid js/process))
                   delay (min (if (and same-process? (< attempt 2))
                                0
                                (lock-delay-ms attempt))
                              (max 0 (- (lock-wait-ms) waited 1)))]
               (if (>= waited (lock-wait-ms))
                 (-> (read-lock)
                     (.then
                       (fn [current]
                         (let [holder (or current holder)]
                           (append-trace! {:event "lock-wait"
                                           :ms waited
                                           :path (lock-path)
                                           :holder holder :result "timeout"})
                           (js/Promise.reject (busy-error holder waited))))))
                 (js/Promise.
                   (fn [resolve reject]
                     (clock/set-timeout
                       #(-> (acquire-lock (inc attempt) started holder)
                            (.then resolve)
                            (.catch reject))
                       delay)))))))))))

(defn- release-lock [record]
  (-> (read-lock)
      (.then
        (fn [current]
          (when (and (map? current)
                     (= (:token current) (:token record)))
            (remove-file (lock-path)))))
      (.catch (fn [_] nil))))

(defn- chain [value on-value on-error]
  (if (and value (fn? (.-then value)))
    (.then value on-value on-error)
    (try (on-value value) (catch :default error (on-error error)))))

(defn- with-lock [f]
  (-> (acquire-lock 0)
      (.then
        (fn [record]
          (let [done (fn [value]
                       (-> (release-lock record)
                           (.then (fn [] value))))
                fail (fn [error]
                       (-> (release-lock record)
                           (.then (fn [] (js/Promise.reject error)))))]
            (try
              (chain (f) done fail)
              (catch :default error
                (fail error))))))))
(defonce token-state
  (atom {:paths #{} :path-waiters {} :global false :global-waiters []}))

(defn- token-path
  [p]
  (let [absolute (resolve-path p)]
    (-> (.realpath fs-promises absolute)
        (.catch (fn [_]
                  (-> (.realpath fs-promises (path/dirname absolute))
                      (.catch (fn [_] absolute))))))))

(defn- paths-free? [paths]
  (let [state @token-state]
    (and (not (:global state))
         (every? (fn [p] (not (contains? (:paths state) p))) paths))))

(defn- grant-path-waiters! []
  (when-not (:global @token-state)
    (doseq [[id entry] (:path-waiters @token-state)]
      (let [paths (:paths entry)]
        (when (and (seq paths) (paths-free? paths))
          (swap! token-state update :path-waiters dissoc id)
          (swap! token-state update :paths into paths)
          ((:resolve entry) paths))))))

(defn- token-busy-error [kind holder waited]
  (ex-info
    (str "in-process " kind " token is busy"
         (when (= kind "global") " (a running call holds it)")
         "; retry this operation shortly")
    {:code :LOCK_BUSY
     :retryable true
     :waited-ms waited
     :holder holder
     :hint "a running call may hold the write token; retry shortly"}))

(defn- acquire-paths! [paths]
  (js/Promise.
    (fn [resolve reject]
      (if (paths-free? paths)
        (do
          (swap! token-state update :paths into paths)
          (resolve paths))
        (let [id (str "wait-" (clock/now) "-" (js/Math.random))
              started (clock/now)
              timer (clock/set-timeout
                      (fn []
                        (when (contains? (:path-waiters @token-state) id)
                          (swap! token-state update :path-waiters dissoc id)
                          (let [waited (- (clock/now) started)
                                holder {:paths (vec (:paths @token-state))
                                        :global (:global @token-state)}]
                            (append-trace! {:event "token-timeout"
                                            :kind "path"
                                            :ms waited
                                            :holder holder :result "timeout"})
                            (reject (token-busy-error "path" holder waited)))))
                      (lock-wait-ms))]
          (swap! token-state assoc-in [:path-waiters id]
                 {:paths (set paths)
                  :resolve (fn [granted]
                             (clock/clear-timeout timer)
                             (resolve granted))
                  :reject (fn [error]
                            (clock/clear-timeout timer)
                            (reject error))}))))))

(defn- release-paths! [paths]
  (swap! token-state update :paths #(reduce disj % paths))
  (grant-path-waiters!))

(defn- acquire-global! []
  (js/Promise.
    (fn [resolve reject]
      (let [state @token-state]
        (if (and (not (:global state)) (empty? (:paths state)))
          (do
            (swap! token-state assoc :global true)
            (resolve true))
          (let [id (str "global-" (clock/now) "-" (js/Math.random))
                started (clock/now)
                timer (clock/set-timeout
                        (fn []
                          (when (some #(= id (:id %)) (:global-waiters @token-state))
                            (swap! token-state update :global-waiters
                                   (fn [waiters]
                                     (vec (remove #(= id (:id %)) waiters))))
                            (let [waited (- (clock/now) started)
                                  holder {:global true
                                          :paths (vec (:paths @token-state))}]
                              (append-trace! {:event "token-timeout"
                                              :kind "global"
                                              :ms waited
                                              :holder holder :result "timeout"})
                              (reject (token-busy-error "global" holder waited)))))
                        (lock-wait-ms))]
            (swap! token-state update :global-waiters conj
                   {:id id
                    :resolve (fn [value]
                               (clock/clear-timeout timer)
                               (resolve value))
                    :reject (fn [error]
                              (clock/clear-timeout timer)
                              (reject error))})))))))

(defn- grant-global! []
  (when (and (not (:global @token-state)) (empty? (:paths @token-state)))
    (when-let [waiters (seq (:global-waiters @token-state))]
      (let [entry (first waiters)]
        (swap! token-state update :global-waiters #(vec (rest %)))
        (swap! token-state assoc :global true)
        ((:resolve entry) true)))))

(defn- release-global! []
  (swap! token-state assoc :global false)
  (if (seq (:global-waiters @token-state))
    (grant-global!)
    (grant-path-waiters!)))

(defn- with-path-token [paths f]
  (-> (js/Promise.all (clj->js (map token-path paths)))
      (.then
        (fn [resolved]
          (let [paths (vec (sort (distinct (array-seq resolved))))]
            (-> (acquire-paths! paths)
                (.then
                  (fn [_]
                    (chain (f)
                           (fn [value]
                             (release-paths! paths)
                             value)
                           (fn [error]
                             (release-paths! paths)
                             (js/Promise.reject error)))))))))))

(defn- with-global-token [f]
  (-> (acquire-global!)
      (.then
        (fn [_]
          (chain (f)
                 (fn [value]
                   (release-global!)
                   value)
                 (fn [error]
                   (release-global!)
                   (js/Promise.reject error)))))))
(def ^:private max-read-bytes (* 2 1024 1024))

(defn cat [{:keys [path]}]
  (let [absolute (resolve-path path)]
    (-> (.stat fs-promises absolute #js {:bigint true})
        (.then
          (fn [stats]
            (let [size (js/Number (.-size stats))]
              (if (> size max-read-bytes)
                ;; Explicit rejection keeps ex-data under nbb.
                (js/Promise.reject
                  (ex-info "read exceeds the 2 MiB limit"
                           {:code :LIMIT_EXCEEDED :path path :bytes size
                            :limit max-read-bytes}))
                (.readFile fs-promises absolute "utf8"))))))))

(defn- native-text [result]
  (cond
    (string? result) result
    (and result (.-content result))
    (->> (array-seq (.-content result))
         (keep (fn [block] (when (= "text" (.-type block)) (.-text block))))
         (string/join ""))
    :else (str result)))

(defn read [{:keys [path]}]
  (let [native (.-__herdNative js/globalThis)
        runner (when native ((.-getRunner native)))]
    (when-not (and runner (.hasNativeTool runner "read"))
      (throw (ex-info "host native read is unavailable"
                      {:code :HOST_API_MISMATCH :path path})))
    (-> (.invokeNativeTool runner "read" #js {:path path} #js {})
        (.then native-text))))

(defonce budgets (atom {}))

(defn reset-budget!
  ([name] (reset-budget! name {}))
  ([name {:keys [max-bytes max-ops]
          :or {max-bytes (* 16 1024 1024) max-ops 256}}]
   (swap! budgets assoc name {:used-bytes 0 :used-ops 0
                              :max-bytes max-bytes :max-ops max-ops})
   nil))

(defn- charge! [name bytes ops]
  (let [error (atom nil)]
    (swap! budgets
           (fn [m]
             (let [{:keys [used-bytes used-ops max-bytes max-ops]}
                   (get m name {:used-bytes 0 :used-ops 0
                                :max-bytes (* 16 1024 1024) :max-ops 256})
                   next-bytes (+ used-bytes bytes)
                   next-ops (+ used-ops ops)]
               (cond
                 (> next-bytes max-bytes)
                 (do (reset! error {:code :LIMIT_EXCEEDED :bytes next-bytes :limit max-bytes}) m)
                 (> next-ops max-ops)
                 (do (reset! error {:code :LIMIT_EXCEEDED :ops next-ops :limit max-ops}) m)
                 :else
                 (assoc m name {:used-bytes next-bytes :used-ops next-ops
                                :max-bytes max-bytes :max-ops max-ops})))))
    (when-let [data @error]
      (throw (ex-info "batch budget exceeded" data)))))

(defn- bigint-parts [value]
  (let [text (str value)
        width (max 10 (count text))
        padded (str (apply str (repeat (- width (count text)) "0")) text)]
    [(js/parseInt (subs padded 0 (- width 9)) 10)
     (js/parseInt (subs padded (- width 9)) 10)]))

(defn- stamp-of [stats]
  (let [[secs nsecs] (bigint-parts (.-mtimeNs stats))]
    {:mtime-sec secs
     :mtime-nsec nsecs
     :size (js/parseInt (str (.-size stats)) 10)}))

(defn- stamp-field [stamp kebab camel]
  (if (contains? stamp kebab) (get stamp kebab) (get stamp camel)))

(defn- check-stamp!
  """
Reject when the file no longer matches the stamp captured by a read. Async
  so the write path never blocks the host's event loop.
"""
  [path expected]
  (if-not expected
    (js/Promise.resolve nil)
    (-> (.stat fs-promises path #js {:bigint true})
        (.catch (fn [_] nil))
        (.then
          (fn [stats]
            (let [actual (when stats (stamp-of stats))]
              (if (or (nil? actual)
                      (not= (:mtime-sec actual) (stamp-field expected :mtime-sec :mtimeSec))
                      (not= (:mtime-nsec actual) (stamp-field expected :mtime-nsec :mtimeNsec))
                      (not= (:size actual) (:size expected)))
                ;; Reject explicitly: nbb re-wraps a throw inside `.then` and
                ;; drops ex-data, so the host would lose the FILE_CONFLICT code.
                (let [error (ex-info "file changed since read"
                                     {:code :FILE_CONFLICT :path path})]
                  (set! (.-code error) "FILE_CONFLICT")
                  (js/Promise.reject error))
                nil)))))))

(def ^:private max-write-bytes (* 2 1024 1024))

(defn write [{:keys [path content] :as request}]
  (when-not (string? content)
    (throw (ex-info "content must be a string"
                    {:code :INVALID_ARGUMENT :field :content})))
  (let [bytes (js/Buffer.byteLength content "utf8")]
    (when (> bytes max-write-bytes)
      (throw (ex-info "write exceeds the 2 MiB limit"
                      {:code :LIMIT_EXCEEDED :path path :bytes bytes
                       :limit max-write-bytes})))
    (with-path-token
      [path]
      (fn []
        (with-lock
          (fn []
            (let [absolute (resolve-path path)
                  native (.-__herdNative js/globalThis)
                  runner (when native ((.-getRunner native)))]
              (when-not (and runner (.hasNativeTool runner "write"))
                (throw (ex-info "host native write is unavailable"
                                {:code :HOST_API_MISMATCH :path path})))
              (-> (check-stamp! absolute (or (:expected-stamp request) (:__expectedStamp request)))
                  (.then
                    (fn [_]
                      ;; Do not create missing parents here: a write into a
                      ;; directory removed earlier must stay blocked instead of
                      ;; resurrecting the path.
                      (.invokeNativeTool runner "write"
                                         #js {:path absolute :content content}
                                         #js {})))
                  (.then (fn [_] nil))))))))))

(defn mkdir [{:keys [path]}]
  (with-path-token
    [path]
    (fn [] (with-lock (fn [] (.mkdir fs-promises (resolve-path path) #js {:recursive true}))))))

(defn- reject-root! [p]
  (when (= (resolve-path p) (path/resolve "."))
    (throw (ex-info "refusing to remove or move the session root"
                    {:code :INVALID_ARGUMENT :path p}))))

(defn rm [{:keys [path]}]
  (reject-root! path)
  (with-path-token
    [path]
    (fn [] (with-lock (fn [] (.rm fs-promises (resolve-path path) #js {:recursive true :force true}))))))

(defn mv [{:keys [source target]}]
  (reject-root! source)
  (reject-root! target)
  (with-path-token
    [source target]
    (fn [] (with-lock (fn [] (.rename fs-promises (resolve-path source) (resolve-path target)))))))

(defn write-with-name [name request]
  (let [content (:content request)]
    (when-not (string? content)
      (throw (ex-info "content must be a string"
                      {:code :INVALID_ARGUMENT :field :content})))
    (charge! name (js/Buffer.byteLength content "utf8") 1)
    (write request)))

(defn mkdir-with-name [name request]
  (charge! name 0 1)
  (mkdir request))

(defn rm-with-name [name request]
  (charge! name 0 1)
  (rm request))

(defn mv-with-name [name request]
  (charge! name 0 1)
  (mv request))

(defn ls [{:keys [path]}]
  (-> (.readdir fs-promises (resolve-path path) #js {:withFileTypes true})
      (.then (fn [entries]
               {:exists true
                :entries (vec
                           (map (fn [entry]
                                  {:name (.-name entry)
                                   :is-dir (.isDirectory entry)
                                   :is-file (.isFile entry)
                                   :is-symlink (.isSymbolicLink entry)})
                                (array-seq entries)))}))
      (.catch (fn [_] {:exists false :entries []}))))
(defn- glob->regex [pattern]
  (-> pattern
      (string/replace #"[.+^${}()|\\]" #"\$&"#)
      (string/replace "**" "")
      (string/replace "*" "[^/]*")
      (string/replace "?" "[^/]")
      (string/replace "" ".*")
      re-pattern))

(def ^:private glob-default-limit 20000)
(def ^:private glob-default-budget-ms 2000)
;; Dependency and VCS trees are never part of a workspace search. `.herd` is
;; runtime state: probe logs and eval caches only add noise and latency.
(def ^:private glob-skip-dirs #{"node_modules" ".git" ".herd"})

(defn- glob-limit-error [reason stats]
  (ex-info "glob stopped before traversing the whole tree"
           (merge {:code :LIMIT_EXCEEDED :reason reason} stats)))

(defn- walk-entries
  """
Breadth-first walk bounded by an entry cap and a wall-clock budget. Both
  limits reject with :LIMIT_EXCEEDED instead of silently truncating, so the
  caller can narrow the pattern or raise the limit.
"""
  [root {:keys [limit budget-ms dot deps only-files?]}]
  (let [deadline (+ (clock/now) budget-ms)
        entries (atom [])
        seen (atom 0)
        limit-error (fn [reason]
                      (glob-limit-error reason
                                        {:entries (count @entries)
                                         :seen @seen
                                         :limit limit
                                         :budget-ms budget-ms}))]
    (letfn [(walk [queue]
              (if (empty? queue)
                (js/Promise.resolve @entries)
                (let [dir (peek queue)
                      queue (pop queue)]
                  (if (>= (clock/now) deadline)
                    (js/Promise.reject (limit-error :time-budget))
                    (-> (.readdir fs-promises dir #js {:withFileTypes true})
                        (.catch (fn [error]
                                  (if (and (= "ENOENT" (.-code error))
                                           (not= dir root))
                                    #js []
                                    (js/Promise.reject error))))
                        (.then
                          (fn [dirents]
                            (let [next-queue
                                  (loop [i 0 q queue]
                                    (if (>= i (.-length dirents))
                                      q
                                      (let [entry (aget dirents i)
                                            name (.-name entry)
                                            hidden? (string/starts-with? name ".")
                                            skip? (or (and (not dot) hidden?)
                                                      (and (not deps)
                                                           (contains? glob-skip-dirs name)))]
                                        (if skip?
                                          (recur (inc i) q)
                                          (let [full (path/join dir name)
                                                dir? (.isDirectory entry)
                                                file? (.isFile entry)]
                                            (swap! seen inc)
                                            (when (or (not only-files?) file?)
                                              (swap! entries conj [full file?]))
                                            (let [q (if dir? (conj q full) q)]
                                              (if (> @seen limit)
                                                ;; Stop reading the rest of this directory.
                                                (recur (.-length dirents) q)
                                                (recur (inc i) q))))))))]
                              (if (> @seen limit)
                                ;; Explicit rejection keeps ex-data under nbb.
                                (js/Promise.reject (limit-error :entries))
                                (walk next-queue))))))))))]
      (walk [root]))))

(defn- run-bounded [f items limit]
  (let [items (vec items)
        n (count items)
        results (atom (vec (repeat n nil)))
        cursor (atom 0)
        worker (fn worker []
                 (let [i (dec (second (swap-vals! cursor inc)))]
                   (if (>= i n)
                     (js/Promise.resolve nil)
                     (-> (js/Promise.resolve (f (nth items i)))
                         (.then (fn [value]
                                  (swap! results assoc i value)
                                  (worker)))))))]
    (-> (js/Promise.all
          (into-array (map (fn [_] (worker))
                           (range (min (max 1 n) (max 1 limit))))))
        (.then (fn [_] @results)))))

(defn glob [{:keys [pattern path dot onlyFiles only-files exec limit budget-ms deps
                    include-dependencies] :as request}]
  (when-not (and (string? pattern) (pos? (count pattern)))
    (throw (ex-info "pattern must be a non-empty string"
                    {:code :INVALID_ARGUMENT :field :pattern})))
  (let [call-fn (or exec (:fn request))]
    (when-not (fn? call-fn)
      (throw (ex-info "glob requires a callable :exec (or :fn) function"
                      {:code :INVALID_ARGUMENT :function :glob})))
    (let [root (resolve-path (or path "."))
          matcher (glob->regex pattern)
          files-only? (not (false? (or onlyFiles only-files)))
          entries-limit (if (and (number? limit) (pos? limit)) limit glob-default-limit)
          time-budget (if (and (number? budget-ms) (pos? budget-ms))
                        budget-ms
                        glob-default-budget-ms)]
      (-> (walk-entries root {:limit entries-limit
                              :budget-ms time-budget
                              :dot (boolean dot)
                              :deps (boolean (or deps include-dependencies))
                              :only-files? files-only?})
          (.then
            (fn [entries]
              (let [relative (->> entries
                                  (filter (fn [[full is-file]]
                                            (or (not files-only?) is-file)))
                                  (map (fn [[full _]]
                                         (-> full
                                             (subs (inc (count root)))
                                             (string/replace #"\\" "/"))))
                                  (filter #(re-matches matcher %))
                                  sort
                                  vec)
                    prefix (if (and path (pos? (count path)))
                             (str (string/replace path #"/+$" "") "/")
                             "")
                    results (run-bounded
                              (fn [rel] (call-fn (str prefix rel)))
                              relative
                              8)]
                (-> results
                    (.then (fn [values]
                             {:exists true
                              :entries relative
                              :results (vec values)}))))))
          (.catch (fn [error]
                    (if (= "ENOENT" (.-code error))
                      {:exists false :entries [] :results []}
                      (js/Promise.reject error))))))))
(defn stat [{:keys [path]}]
  (-> (.stat fs-promises (resolve-path path) #js {:bigint true})
      (.then (fn [s] (assoc (stamp-of s)
                            :exists true
                            :is-dir (.isDirectory s)
                            :mtime-ms (js/Number (.-mtimeMs s)))))
      (.catch (fn [_] {:exists false}))))

(defn spans [content needle]
  (loop [from 0
         acc []]
    (let [at (string/index-of content needle from)]
      (if (nil? at)
        acc
        (recur (inc at)
               (conj acc [at (+ at (count needle))]))))))

(def ^:private async-hooks (js/require "node:async_hooks"))
(defonce program-storage (new (.-AsyncLocalStorage async-hooks)))

(defonce current-notifier (atom nil))
(defonce notifiers (atom {}))
(defonce current-name (atom nil))

(defn active-name []
  (or (.getStore program-storage) @current-name))

(defn with-program-name [name f]
  (.run program-storage name f))

(defonce program-runtimes (atom {}))

(defn begin-program! [name]
  (swap! program-runtimes assoc name {:in-flight 0 :abandoned? false})
  nil)

(defn end-program! [name]
  (swap! program-runtimes dissoc name)
  nil)

(defn abandon-program! [name]
  (swap! program-runtimes update name
         (fn [state]
           (assoc (or state {:in-flight 0}) :abandoned? true)))
  nil)

(defn program-state [name]
  (get @program-runtimes name))

(defn- begin-call! [name]
  (let [state (get @program-runtimes name)]
    (cond
      (nil? state) nil
      (:abandoned? state)
      (throw (ex-info "program was abandoned" {:code :ABANDONED}))
      :else
      (do
        (swap! program-runtimes update-in [name :in-flight] (fnil inc 0))
        nil))))

(defn- settle-call! [name]
  (when name
    (swap! program-runtimes
           (fn [runtimes]
             (if-let [state (get runtimes name)]
               (assoc runtimes name (update state :in-flight (fnil dec 1)))
               runtimes))))
  nil)

(defn- quiet-rejection [promise]
  (.catch promise (fn [_] nil))
  promise)

(defn guarded-for [program-name _label thunk]
  (let [name (or program-name (active-name))]
    (try
      (begin-call! name)
      (let [promise (try
                      (js/Promise.resolve (thunk))
                      (catch :default error
                        (js/Promise.reject error)))
            safe (-> promise
                     (.then (fn [value]
                              (settle-call! name)
                              value)
                            (fn [error]
                              (settle-call! name)
                              (js/Promise.reject error))))]
        (quiet-rejection safe))
      (catch :default error
        (quiet-rejection (js/Promise.reject error))))))

(defn guarded [label thunk]
  (guarded-for (active-name) label thunk))

(defonce parked (atom {}))
(defonce active-calls (atom {}))

(defn- register-call! [name entry]
  (swap! active-calls assoc name entry))

(defn- unregister-call! [name]
  (swap! active-calls dissoc name))

(defn await-call-start
  "Resolve on the explicit event that the named call has registered, without timers."
  [name]
  (js/Promise.
    (fn [resolve]
      (if (@active-calls name)
        (resolve true)
        (let [key (js/Symbol "call-start")
              watch (fn [_ _ _ _]
                      (when (@active-calls name)
                        (remove-watch active-calls key)
                        (resolve true)))]
          (add-watch active-calls key watch))))))

(defn- remember-park! [name resolve reject payload]
  (swap! parked assoc name {:resolve resolve :reject reject :payload payload}))

(defn- notify-park! [name payload]
  (if-let [notify (get @notifiers name)]
    (do (swap! notifiers dissoc name)
        (notify {:state :parked :payload payload}))
    (when-let [notify @current-notifier]
      (notify {:state :parked :payload payload}))))

(declare call-snapshot)

(defn park [payload]
  (let [name (or (:name payload) (active-name))
        snapshot (call-snapshot name)
        base (if (map? payload) payload {:payload payload})
        payload (merge snapshot base)
        payload (if snapshot (assoc payload :call-active true) payload)]
    (js/Promise.
      (fn [resolve reject]
        (remember-park! name resolve reject payload)
        (notify-park! name payload)))))

(defn park-with-name [name payload]
  (park (if (map? payload)
          (assoc payload :name name)
          {:payload payload :name name})))

(defn- line-spans [content]
  (loop [from 0 acc []]
    (let [nl (string/index-of content "\n" from)]
      (if (nil? nl)
        (conj acc [from (count content)])
        (recur (inc nl) (conj acc [from nl]))))))

(defn- trim-common [a b]
  (let [n (count a)
        m (count b)
        prefix (loop [i 0]
                 (if (and (< i n) (< i m) (= (nth a i) (nth b i)))
                   (recur (inc i))
                   i))
        suffix (loop [i 0]
                 (if (and (< i (- n prefix))
                          (< i (- m prefix))
                          (= (nth a (- n 1 i)) (nth b (- m 1 i))))
                   (recur (inc i))
                   i))]
    [(subs a prefix (- n suffix))
     (subs b prefix (- m suffix))]))

(defn- bounded-edit-distance [a b k]
  (let [n (count a)
        m (count b)]
    (if (> (js/Math.abs (- n m)) k)
      nil
      (let [inf (inc k)]
        (loop [i 1 prev (assoc (vec (repeat (inc m) inf)) 0 0)]
          (if (> i n)
            (let [result (nth prev m)]
              (when (<= result k) result))
            (let [lo (max 0 (- i k))
                  hi (min m (+ i k))
                  row (loop [j 0 curr (vec (repeat (inc m) inf))]
                        (if (> j m)
                          curr
                          (if (or (< j lo) (> j hi))
                            (recur (inc j) curr)
                            (let [value (if (zero? j)
                                          i
                                          (let [cost (if (= (nth a (dec i)) (nth b (dec j))) 0 1)]
                                            (min (inc (nth curr (dec j)))
                                                 (inc (nth prev j))
                                                 (+ (nth prev (dec j)) cost))))]
                              (recur (inc j) (assoc curr j value))))))]
              (recur (inc i) row))))))))

(defn- nearest-line [content needle]
  (let [k 64
        ;; One million DP cells is enough to explain a typo in a nearby line;
        ;; beyond that the caller learns the query was ambiguous instead of
        ;; freezing the UI while the edit distance grinds through the file.
        budget (atom 1000000)
        deadline (+ (clock/now) 150)]
    (loop [spans (seq (line-spans content))
           best nil
           best-distance nil]
      (let [exhausted? (or (<= @budget 0) (>= (clock/now) deadline))]
        (if (or (nil? spans) exhausted?)
          (cond
            best {:span best
                  :text (subs content (first best) (second best))
                  :distance best-distance
                  :budget-exhausted exhausted?}
            exhausted? {:budget-exhausted true}
            :else nil)
          (let [[start end] (first spans)
                line (subs content start end)
                [a b] (trim-common line needle)
                cells (* (inc (count a)) (inc (count b)))]
            (swap! budget - cells)
            (let [distance (when (pos? @budget)
                             (bounded-edit-distance a b k))]
              (cond
                (nil? distance) (recur (next spans) best best-distance)
                (or (nil? best-distance) (< distance best-distance))
                (recur (next spans) [start end] distance)
                :else (recur (next spans) best best-distance)))))))))
(defn- span-context [content [start end]]
  (subs content
        (max 0 (- start 80))
        (min (count content) (+ end 80))))

(defn- park-where [request matches]
  (park (assoc request
               :kind :where
               :candidates (vec
                             (take 8
                                   (map (fn [span]
                                          {:span span
                                           :context (span-context (:content request) span)})
                                        matches)))
               :nearest (when (empty? matches)
                          (nearest-line (:content request) (:needle request))))))

(defn where [{:keys [content needle] :as request}]
  (when-not (string? content)
    (throw (ex-info "content must be a string"
                    {:code :INVALID_ARGUMENT :field :content})))
  (when (or (not (string? needle)) (zero? (count needle)))
    (throw (ex-info "needle must be a non-empty string"
                    {:code :INVALID_ARGUMENT :field :needle :value needle})))
  (let [matches (spans content needle)]
    (if (= 1 (count matches))
      (first matches)
      (park-where request matches))))

(defn whereAll [{:keys [content needle]}]
  (when-not (string? content)
    (throw (ex-info "content must be a string"
                    {:code :INVALID_ARGUMENT :field :content})))
  (when (or (not (string? needle)) (zero? (count needle)))
    (throw (ex-info "needle must be a non-empty string"
                    {:code :INVALID_ARGUMENT :field :needle :value needle})))
  (spans content needle))

(defn where-with-name [name request]
  (where (assoc request :name name)))

(defn- forget-park! [name]
  (swap! parked dissoc name))

(defn call-snapshot [name]
  (when-let [entry (@active-calls name)]
    (let [state @(:state entry)
          out (:out state)
          err (:err state)
          shown-out @(:shown-out entry)
          shown-err @(:shown-err entry)
          dout (subs out (min shown-out (count out)))
          derr (subs err (min shown-err (count err)))]
      (reset! (:shown-out entry) (count out))
      (reset! (:shown-err entry) (count err))
      {:stdout dout
       :stderr derr
       :output-truncated (:truncated state)
       :log-truncated (:log-truncated state)})))

(defn await-call-output
  "Resolve on the explicit event that the named call's stdout contains needle."
  [name needle]
  (js/Promise.
    (fn [resolve]
      (let [entry (@active-calls name)
            state (:state entry)
            key (js/Symbol "call-output")
            check (fn [_ _ _ _]
                    (when (and state (.includes (str (:out @state)) needle))
                      (remove-watch state key)
                      (resolve true)))]
        (if (and state (.includes (str (:out @state)) needle))
          (resolve true)
          (when state
            (add-watch state key check)))))))

(defn unpark [{:keys [name value]}]
  (if-let [call-entry (@active-calls name)]
    (let [stdin (.-stdin (:child call-entry))
          input (cond
                  (string? value) value
                  (map? value) (:stdin value)
                  :else (throw (ex-info "unpark value must be a string or {:stdin ... :eof ...}"
                                        {:code :INVALID_ARGUMENT :field :value})))
          eof? (and (map? value) (true? (:eof value)))]
      (when-not stdin
        (throw (ex-info "active call has no stdin pipe"
                        {:code :STRUCTURE_CONFLICT :name name})))
      (when (and (some? input) (not (string? input)))
        (throw (ex-info "stdin must be a string"
                        {:code :INVALID_ARGUMENT :field :stdin})))
      (when (some? input) (.write stdin input))
      (when eof? (.end stdin))
      (when-let [parked-entry (@parked name)]
        (with-program-name name (fn [] ((:resolve parked-entry) value)))
        (forget-park! name))
      {:name name :state :running :call true :stdin (some? input) :eof (boolean eof?)})
    (let [entry (@parked name)]
      (when-not entry
        (throw (ex-info "unknown parked program"
                        {:code :PROGRAM_UNKNOWN :name name})))
      (with-program-name name (fn [] ((:resolve entry) value)))
      (forget-park! name)
      value)))
(defn- kill-process-group!
  [child]
  (let [pid (.-pid child)]
    (if (number? pid)
      (try
        (js/process.kill (- pid) "SIGKILL")
        true
        (catch :default _
          (try (.kill child "SIGKILL") true (catch :default _ false))))
      (try (.kill child "SIGKILL") true (catch :default _ false)))))

(defn abandon [{:keys [name]}]
  (let [call-entry (@active-calls name)
        parked-entry (@parked name)]
    (swap! notifiers dissoc name)
    (when call-entry
      (when-let [timer (:timer call-entry)]
        (clock/clear-timeout timer))
      (kill-process-group! (:child call-entry))
      ((:reject call-entry) (ex-info "call abandoned" {:code :ABANDONED :name name}))
      (unregister-call! name))
    (when parked-entry
      ((:reject parked-entry) (ex-info "program abandoned" {:code :ABANDONED :name name}))
      (forget-park! name))
    (if (or call-entry parked-entry)
      {:name name :state :abandoned :cleared true}
      {:name name :state :unknown :cleared false})))

(def ^:private default-max-inline-bytes (* 1024 1024))

(defn- append-inline [state key chunk max-inline]
  (let [current (get @state key)
        remaining (- max-inline (count current))]
    (when (pos? remaining)
      (swap! state assoc key (str current (subs chunk 0 (min (count chunk) remaining)))))
    (when (> (count chunk) remaining)
      (swap! state assoc :truncated true))))

(defn call
  [{:keys [argv cwd name max-inline-bytes] :or {cwd "."}} timeout-ms]
  (let [program-name (or name (active-name))]
    (with-global-token
      (fn []
        (with-lock
          (fn []
            (when (or (zero? (count (vec argv)))
                      (not-every? string? (vec argv)))
              (throw (ex-info "argv must be a non-empty array of strings"
                              {:code :INVALID_ARGUMENT :field :argv})))
            (js/Promise.
              (fn [resolve reject]
                (let [argv (vec argv)
                      inline-limit (or max-inline-bytes default-max-inline-bytes)
                      child (cp/spawn (first argv) (clj->js (rest argv))
                                      #js {:cwd cwd :stdio #js ["pipe" "pipe" "pipe"] :detached true})
                      state (atom {:out "" :err "" :truncated false})
                      shown-out (atom 0)
                      shown-err (atom 0)
                      capture (fn [key chunk]
                                (append-inline state key chunk inline-limit))]
                  (register-call! program-name {:child child :reject reject :state state :shown-out shown-out :shown-err shown-err})
                  (.on (.-stdout child) "data" #(capture :out (str %)))
                  (.on (.-stderr child) "data" #(capture :err (str %)))
                  (.on child "error"
                       (fn [e]
                         (unregister-call! program-name)
                         (reject e)))
                  (.on child "close"
                       (fn [code]
                         (unregister-call! program-name)
                         (resolve {:exit code
                                   :stdout (subs (:out @state) (min @shown-out (count (:out @state))))
                                   :stderr (subs (:err @state) (min @shown-err (count (:err @state))))
                                   :output-truncated (:truncated @state)}))))))))))))

(defn call-with-name [name request timeout-ms]
  (call (if (:name request) request (assoc request :name name)) timeout-ms))