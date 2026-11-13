(ns herd.sandbox
  (:require
   ["node:child_process" :as cp]
   ["node:fs" :as fs-sync]
   ["node:fs/promises" :as fs]
   ["node:path" :as path]
   [clojure.string :as str]))

(defn- resolve-path [p]
  (path/resolve (or p ".")))

(defn cat [{:keys [path]}]
  (fs/readFile (resolve-path path) "utf8"))

(defn read [{:keys [path]}]
  (fs/readFile (resolve-path path) "utf8"))

(defn write [{:keys [path content]}]
  (fs/writeFile (resolve-path path) content "utf8"))

(defn mkdir [{:keys [path]}]
  (fs/mkdir (resolve-path path) #js {:recursive true}))

(defn rm [{:keys [path]}]
  (fs/rm (resolve-path path) #js {:recursive true :force true}))

(defn mv [{:keys [source target]}]
  (fs/rename (resolve-path source) (resolve-path target)))

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
    (let [at (str/index-of content needle from)]
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
                         :log log-path})))))))