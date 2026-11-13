(ns herd.sandbox
  (:require
   ["node:child_process" :as cp]
   ["node:path" :as path]
   [clojure.string :as string]))

(def ^:private fs-native (js/require "node:fs"))
(def ^:private fs-promises (js/require "node:fs/promises"))

(defn- resolve-path [p]
  (path/resolve (or p ".")))

(def ^:private lock-path
  (path/join (js/process.cwd) ".herd" "locks" "clj-core.cross-process.lock"))

(defn- stale-lock? []
  (try
    (let [pid (js/parseInt (.readFileSync fs-native lock-path "utf8") 10)]
      (or (js/Number.isNaN pid)
          (not (try
                 (js/process.kill pid 0)
                 true
                 (catch :default _
                   false)))))
    (catch :default _
      false)))

(defn- try-acquire []
  (.mkdirSync fs-native (path/dirname lock-path) #js {:recursive true})
  (let [open (fn []
               (try
                 (.writeFileSync fs-native lock-path (str (.-pid js/process)) #js {:flag "wx"})
                 {}
                 (catch :default _
                   nil)))]
    (or (open)
        (when (stale-lock?)
          (try (.unlinkSync fs-native lock-path) (catch :default _ nil))
          (open)))))

(defn- acquire-lock [attempt]
  (if-let [lock (try-acquire)]
    (js/Promise.resolve lock)
    (if (>= attempt 500)
      (js/Promise.reject (ex-info "write lock busy" {:code :BOARD_CONFLICT}))
      (js/Promise.
        (fn [resolve reject]
          (js/setTimeout
            (fn []
              (-> (acquire-lock (inc attempt))
                  (.then resolve)
                  (.catch reject)))
            10))))))

(defn- release-lock [fd]
  (when fd
    (try (.closeSync fs-native fd) (catch :default _ nil)))
  (try (.unlinkSync fs-native lock-path) (catch :default _ nil)))

(defn- chain [value on-value on-error]
  (if (and value (fn? (.-then value)))
    (.then value on-value on-error)
    (try (on-value value) (catch :default error (on-error error)))))

(defn- with-lock [f]
  (-> (acquire-lock 0)
      (.then
        (fn [{:keys [fd]}]
          (chain (f)
                 (fn [value]
                   (release-lock fd)
                   value)
                 (fn [error]
                   (release-lock fd)
                   (throw error)))))))

(defn cat [{:keys [path]}]
  (.readFile fs-promises (resolve-path path) "utf8"))

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
  (let [{:keys [used-bytes used-ops max-bytes max-ops]}
        (get @budgets name {:used-bytes 0 :used-ops 0
                            :max-bytes (* 16 1024 1024) :max-ops 256})
        next-bytes (+ used-bytes bytes)
        next-ops (+ used-ops ops)]
    (when (> next-bytes max-bytes)
      (throw (ex-info "batch byte budget exceeded"
                      {:code :LIMIT_EXCEEDED :bytes next-bytes :limit max-bytes})))
    (when (> next-ops max-ops)
      (throw (ex-info "batch operation budget exceeded"
                      {:code :LIMIT_EXCEEDED :ops next-ops :limit max-ops})))
    (swap! budgets assoc name {:used-bytes next-bytes :used-ops next-ops
                               :max-bytes max-bytes :max-ops max-ops})))

(defn- stamp-of [stats]
  {:mtimeSec (Math/floor (/ (.-mtimeMs stats) 1000))
   :mtimeNsec (Math/floor (* (mod (.-mtimeMs stats) 1000) 1000000))
   :size (.-size stats)})

(defn- check-stamp! [path expected]
  (when expected
    (let [stats (try (.statSync fs-native path) (catch :default _ nil))
          actual (when stats (stamp-of stats))]
      (when (or (nil? actual)
                (not= (:mtimeSec actual) (:mtimeSec expected))
                (not= (:mtimeNsec actual) (:mtimeNsec expected))
                (not= (:size actual) (:size expected)))
        (throw (ex-info "file changed since read"
                        {:code :FILE_CONFLICT :path path}))))))

(def ^:private max-write-bytes (* 2 1024 1024))

(defn write [{:keys [path content] :as request}]
  (let [bytes (js/Buffer.byteLength content "utf8")]
    (when (> bytes max-write-bytes)
      (throw (ex-info "write exceeds the 2 MiB limit"
                      {:code :LIMIT_EXCEEDED :path path :bytes bytes
                       :limit max-write-bytes})))
    (with-lock
      (fn []
        (let [absolute (resolve-path path)]
          (check-stamp! absolute (:__expectedStamp request))
          (.writeFile fs-promises absolute content "utf8"))))))

(defn mkdir [{:keys [path]}]
  (with-lock (fn [] (.mkdir fs-promises (resolve-path path) #js {:recursive true}))))

(defn rm [{:keys [path]}]
  (with-lock (fn [] (.rm fs-promises (resolve-path path) #js {:recursive true :force true}))))

(defn mv [{:keys [source target]}]
  (with-lock (fn [] (.rename fs-promises (resolve-path source) (resolve-path target)))))

(defn write-with-name [name request]
  (charge! name (js/Buffer.byteLength (:content request) "utf8") 1)
  (write request))

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

(defn- walk-entries [root]
  (let [walk (fn walk [dir]
               (-> (.readdir fs-promises dir #js {:withFileTypes true})
                   (.then
                     (fn [entries]
                       (-> (js/Promise.all
                             (into-array
                               (map
                                 (fn [entry]
                                   (let [name (.-name entry)
                                         full (path/join dir name)]
                                     (if (.isDirectory entry)
                                       (walk full)
                                       (js/Promise.resolve [[full (.isFile entry)]]))))
                                 (array-seq entries))))
                           (.then (fn [groups] (reduce (fn [acc group] (into acc group)) [] (array-seq groups)))))))))]
    (walk root)))

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

(defn glob [{:keys [pattern path dot onlyFiles only-files exec] :as request}]
  (when-not (and (string? pattern) (pos? (count pattern)))
    (throw (ex-info "pattern must be a non-empty string"
                    {:code :INVALID_ARGUMENT :field :pattern})))
  (let [call-fn (or exec (:fn request))]
    (when-not (fn? call-fn)
      (throw (ex-info "glob requires a callable :exec (or :fn) function"
                      {:code :INVALID_ARGUMENT :function :glob})))
    (let [root (resolve-path (or path "."))
          matcher (glob->regex pattern)
          files-only? (not (false? (or onlyFiles only-files)))]
      (-> (walk-entries root)
          (.then
            (fn [entries]
              (let [relative (->> entries
                                  (filter (fn [[full is-file]]
                                            (and (or (not files-only?) is-file)
                                                 (or dot
                                                     (not (string/starts-with?
                                                            (path/basename full) "."))))))
                                  (map (fn [[full _]]
                                         (-> full
                                             (subs (inc (count root)))
                                             (string/replace #"\"# "/"))))
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
                              :results (vec values)}))))))))))

(defn stat [{:keys [path]}]
  (-> (.stat fs-promises (resolve-path path))
      (.then (fn [s] {:exists true
                      :size (.-size s)
                      :is-dir (.isDirectory s)
                      :mtime-ms (.-mtimeMs s)}))
      (.catch (fn [_] {:exists false}))))

(defn spans [content needle]
  (loop [from 0
         acc []]
    (let [at (string/index-of content needle from)]
      (if (nil? at)
        acc
        (recur (inc at)
               (conj acc [at (+ at (count needle))]))))))

(defonce current-notifier (atom nil))
(defonce notifiers (atom {}))
(defonce current-name (atom nil))
(defonce parked (atom {}))
(defonce active-calls (atom {}))

(defn- register-call! [name entry]
  (swap! active-calls assoc name entry))

(defn- unregister-call! [name]
  (swap! active-calls dissoc name))

(defn- remember-park! [name resolve reject payload]
  (swap! parked assoc name {:resolve resolve :reject reject :payload payload}))

(defn- notify-park! [name payload]
  (when-let [notify (or (get @notifiers name) @current-notifier)]
    (notify {:state :parked :payload payload})))

(defn park [payload]
  (let [name (or (:name payload) @current-name)]
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
        budget (atom 10000000)]
    (loop [spans (seq (line-spans content))
           best nil
           best-distance nil]
      (if (or (nil? spans) (<= @budget 0))
        (when best
          {:span best
           :text (subs content (first best) (second best))
           :distance best-distance
           :budget-exhausted (<= @budget 0)})
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
              :else (recur (next spans) best best-distance))))))))
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
  (when (or (not (string? needle)) (zero? (count needle)))
    (throw (ex-info "needle must be a non-empty string"
                    {:code :INVALID_ARGUMENT :field :needle :value needle})))
  (let [matches (spans content needle)]
    (if (= 1 (count matches))
      (first matches)
      (park-where request matches))))

(defn whereAll [{:keys [content needle]}]
  (when (or (not (string? needle)) (zero? (count needle)))
    (throw (ex-info "needle must be a non-empty string"
                    {:code :INVALID_ARGUMENT :field :needle :value needle})))
  (spans content needle))

(defn where-with-name [name request]
  (where (assoc request :name name)))

(defn- forget-park! [name]
  (swap! parked dissoc name))

(defn unpark [{:keys [name value]}]
  (let [entry (@parked name)]
    (when-not entry
      (throw (ex-info "unknown parked program"
                      {:code :PROGRAM_UNKNOWN :name name})))
    ((:resolve entry) value)
    (forget-park! name)
    value))

(defn abandon [{:keys [name]}]
  (let [call-entry (@active-calls name)
        parked-entry (@parked name)]
    (when call-entry
      (when-let [timer (:timer call-entry)]
        (js/clearTimeout timer))
      (.kill (:child call-entry) "SIGKILL")
      ((:reject call-entry) (ex-info "call abandoned" {:code :ABANDONED :name name}))
      (unregister-call! name))
    (when parked-entry
      ((:reject parked-entry) (ex-info "program abandoned" {:code :ABANDONED :name name}))
      (forget-park! name))
    (if (or call-entry parked-entry)
      {:name name :state :abandoned :cleared true}
      {:name name :state :unknown :cleared false})))

(def ^:private default-max-inline-bytes (* 1024 1024))
(def ^:private default-max-log-bytes (* 64 1024 1024))
(defonce log-bytes (atom 0))

(defn- call-log-path []
  (let [dir (path/join (js/process.cwd) ".herd" "artifacts" "call")]
    (.mkdirSync fs-native dir #js {:recursive true})
    (path/join dir (str "call-" (js/Date.now) "-" (.-pid js/process) "-" (js/Math.floor (* 1000000 (js/Math.random))) ".log"))))

(defn- append-capped [state key chunk log-path max-inline max-log]
  (let [size (count chunk)]
    (if (<= (+ @log-bytes size) max-log)
      (do
        (.appendFileSync fs-native log-path chunk)
        (swap! log-bytes + size))
      (swap! state assoc :log-truncated true)))
  (let [current (get @state key)
        remaining (- max-inline (count current))]
    (when (pos? remaining)
      (swap! state assoc key (str current (subs chunk 0 (min (count chunk) remaining)))))
    (when (> (count chunk) remaining)
      (swap! state assoc :truncated true))))

(defn call
  [{:keys [argv cwd name max-inline-bytes max-log-bytes] :or {cwd "."}} timeout-ms]
  (let [program-name (or name @current-name)]
    (with-lock
      (fn []
        (js/Promise.
          (fn [resolve reject]
            (let [argv (vec argv)
                  inline-limit (or max-inline-bytes default-max-inline-bytes)
                  log-limit (or max-log-bytes default-max-log-bytes)
                  _ (when (zero? (count argv))
                      (throw (ex-info "argv must not be empty" {:code :INVALID_ARGUMENT})))
                  log-path (call-log-path)
                  child (cp/spawn (first argv) (clj->js (rest argv))
                                  #js {:cwd cwd :stdio #js ["ignore" "pipe" "pipe"]})
                  state (atom {:out "" :err "" :truncated false :log-truncated false})
                  timer (js/setTimeout
                          (fn []
                            (.kill child "SIGKILL")
                            (unregister-call! program-name)
                            (reject (ex-info "call timed out" {:code :STALLED})))
                          (or timeout-ms 30000))]
              (register-call! program-name {:child child :reject reject :timer timer})
              (.on (.-stdout child) "data" #(append-capped state :out (str %) log-path inline-limit log-limit))
              (.on (.-stderr child) "data" #(append-capped state :err (str %) log-path inline-limit log-limit))
              (.on child "error"
                   (fn [e]
                     (js/clearTimeout timer)
                     (unregister-call! program-name)
                     (reject e)))
              (.on child "close"
                   (fn [code]
                     (js/clearTimeout timer)
                     (unregister-call! program-name)
                     (resolve {:exit code
                               :stdout (:out @state)
                               :stderr (:err @state)
                               :output-truncated (:truncated @state)
                               :log-truncated (:log-truncated @state)
                               :log log-path}))))))))))

(defn call-with-name [name request timeout-ms]
  (call (assoc request :name name) timeout-ms))