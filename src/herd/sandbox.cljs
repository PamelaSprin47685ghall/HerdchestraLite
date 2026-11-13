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

(defn read [{:keys [path]}]
  (.readFile fs-promises (resolve-path path) "utf8"))

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

(defn ls [{:keys [path]}]
  (-> (.readdir fs-promises (resolve-path path))
      (.then (fn [entries] {:exists true :entries (vec entries)}))
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
                    results (js/Promise.all
                              (into-array (map (fn [rel] (call-fn (str prefix rel))) relative)))]
                (-> results
                    (.then (fn [values]
                             {:exists true
                              :entries relative
                              :results (vec (array-seq values))}))))))))))

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
(defonce current-name (atom nil))
(defonce parked (atom {}))

(defn- remember-park! [name resolve payload]
  (swap! parked assoc name {:resolve resolve :payload payload}))

(defn- notify-park! [payload]
  (when-let [notify @current-notifier]
    (notify {:state :parked :payload payload})))

(defn park [payload]
  (js/Promise.
    (fn [resolve]
      (remember-park! @current-name resolve payload)
      (notify-park! payload))))

(defn- line-spans [content]
  (loop [from 0 acc []]
    (let [nl (string/index-of content "\n" from)]
      (if (nil? nl)
        (conj acc [from (count content)])
        (recur (inc nl) (conj acc [from nl]))))))

(defn- bounded-edit-distance [a b k]
  (let [n (count a)
        m (count b)]
    (if (> (js/Math.abs (- n m)) k)
      nil
      (loop [i 1 prev (vec (range (inc m)))]
        (if (> i n)
          (peek prev)
          (let [row (loop [j 0 curr [i]]
                      (if (> j m)
                        curr
                        (let [cost (if (= (nth a (dec i)) (nth b (dec j))) 0 1)
                              value (min (inc (nth curr j))
                                         (inc (nth prev (inc j)))
                                         (+ (nth prev j) cost))]
                          (recur (inc j) (conj curr value)))))]
            (if (> (peek row) k)
              nil
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
           :distance best-distance})
        (let [[start end] (first spans)
              line (subs content start end)
              cells (* (inc (count line)) (inc (count needle)))]
          (swap! budget - cells)
          (let [distance (when (pos? @budget)
                           (bounded-edit-distance line needle k))]
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
  (forget-park! name)
  nil)

(def ^:private max-inline-bytes (* 1024 1024))

(defn- call-log-path []
  (let [dir (path/join (js/process.cwd) ".herd" "artifacts" "call")]
    (.mkdirSync fs-native dir #js {:recursive true})
    (path/join dir (str "call-" (js/Date.now) ".log"))))

(defn- append-capped [state key chunk log-path]
  (.appendFileSync fs-native log-path chunk)
  (let [current (get @state key)
        remaining (- max-inline-bytes (count current))]
    (when (pos? remaining)
      (swap! state assoc key (str current (subs chunk 0 (min (count chunk) remaining)))))
    (when (> (count chunk) remaining)
      (swap! state assoc :truncated true))))

(defn call
  [{:keys [argv cwd] :or {cwd "."}} timeout-ms]
  (with-lock
    (fn []
      (js/Promise.
        (fn [resolve reject]
          (let [argv (vec argv)
                _ (when (zero? (count argv))
                    (throw (ex-info "argv must not be empty" {:code :INVALID_ARGUMENT})))
                log-path (call-log-path)
                child (cp/spawn (first argv) (clj->js (rest argv))
                                #js {:cwd cwd :stdio #js ["ignore" "pipe" "pipe"]})
                state (atom {:out "" :err "" :truncated false})
                timer (js/setTimeout
                        (fn []
                          (.kill child "SIGKILL")
                          (reject (ex-info "call timed out" {:code :STALLED})))
                        (or timeout-ms 30000))]
            (.on (.-stdout child) "data" #(append-capped state :out (str %) log-path))
            (.on (.-stderr child) "data" #(append-capped state :err (str %) log-path))
            (.on child "error" (fn [e]
                                 (js/clearTimeout timer)
                                 (reject e)))
            (.on child "close"
                 (fn [code]
                   (js/clearTimeout timer)
                   (resolve {:exit code
                             :stdout (:out @state)
                             :stderr (:err @state)
                             :output-truncated (:truncated @state)
                             :log log-path})))))))))