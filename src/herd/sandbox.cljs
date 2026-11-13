(ns herd.sandbox
  (:require
   ["node:child_process" :as cp]
   ["node:fs" :as fs-sync]
   ["node:fs/promises" :as fs]
   ["node:path" :as path]
   [clojure.string :as string]))

(defn- resolve-path [p]
  (path/resolve (or p ".")))

(def ^:private lock-path
  (path/join (js/process.cwd) ".herd" "locks" "clj-core.cross-process.lock"))

(defn- stale-lock? []
  (try
    (let [pid (js/parseInt (fs-sync/readFileSync lock-path "utf8") 10)]
      (or (js/Number.isNaN pid)
          (not (try
                 (js/process.kill pid 0)
                 true
                 (catch :default _
                   false)))))
    (catch :default _
      false)))

(defn- try-acquire []
  (fs-sync/mkdirSync (path/dirname lock-path) #js {:recursive true})
  (let [open (fn []
               (try
                 (fs-sync/writeFileSync lock-path (str (.-pid js/process)) #js {:flag "wx"})
                 {}
                 (catch :default _
                   nil)))]
    (or (open)
        (when (stale-lock?)
          (try (fs-sync/unlinkSync lock-path) (catch :default _ nil))
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
    (try (fs-sync/closeSync fd) (catch :default _ nil)))
  (try (fs-sync/unlinkSync lock-path) (catch :default _ nil)))

(defn- with-lock [f]
  (-> (acquire-lock 0)
      (.then
        (fn [{:keys [fd]}]
          (-> (f)
              (.then
                (fn [value]
                  (release-lock fd)
                  value)
                (fn [error]
                  (release-lock fd)
                  (throw error))))))))

(defn cat [{:keys [path]}]
  (fs/readFile (resolve-path path) "utf8"))

(defn read [{:keys [path]}]
  (fs/readFile (resolve-path path) "utf8"))

(defn write [{:keys [path content]}]
  (with-lock (fn [] (fs/writeFile (resolve-path path) content "utf8"))))

(defn mkdir [{:keys [path]}]
  (with-lock (fn [] (fs/mkdir (resolve-path path) #js {:recursive true}))))

(defn rm [{:keys [path]}]
  (with-lock (fn [] (fs/rm (resolve-path path) #js {:recursive true :force true}))))

(defn mv [{:keys [source target]}]
  (with-lock (fn [] (fs/rename (resolve-path source) (resolve-path target)))))

(defn ls [{:keys [path]}]
  (fs/readdir (resolve-path path)))

(defn stat [{:keys [path]}]
  (-> (fs/stat (resolve-path path))
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

(defn- park-where [request matches]
  (park (assoc request
               :kind :where
               :candidates (vec (take 8 matches)))))

(defn where [{:keys [content needle] :as request}]
  (let [matches (spans content needle)]
    (if (= 1 (count matches))
      (first matches)
      (park-where request matches))))

(defn whereAll [{:keys [content needle]}]
  (spans content needle))

(defn- forget-park! [name]
  (swap! parked dissoc name))

(defn unpark [{:keys [name value]}]
  (when-let [entry (@parked name)]
    ((:resolve entry) value)
    (forget-park! name)
    value))

(defn abandon [{:keys [name]}]
  (forget-park! name)
  nil)

(def ^:private max-inline-bytes (* 1024 1024))

(defn- call-log-path []
  (let [dir (path/join (js/process.cwd) ".herd" "artifacts" "call")]
    (fs-sync/mkdirSync dir #js {:recursive true})
    (path/join dir (str "call-" (js/Date.now) ".log"))))

(defn- append-capped [state key chunk log-path]
  (fs-sync/appendFileSync log-path chunk)
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