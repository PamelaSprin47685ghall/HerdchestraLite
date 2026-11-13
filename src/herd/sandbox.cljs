(ns herd.sandbox
  (:require ["node:fs/promises" :as fs]
            ["node:path" :as path]
            ["node:child_process" :as cp]
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

(defn where [{:keys [content needle]}]
  (let [spans (loop [from 0 acc []]
                (let [at (str/index-of content needle from)]
                  (if (nil? at)
                    acc
                    (recur (inc at) (conj acc [at (+ at (count needle))])))))]
    (case (count spans)
      0 (throw (ex-info "needle not found" {:code :WHERE-NOT-FOUND}))
      1 (first spans)
      (throw (ex-info "needle is ambiguous" {:code :WHERE-AMBIGUOUS :candidates (vec (take 8 spans))})))))

(defn whereAll [{:keys [content needle]}]
  (loop [from 0 acc []]
    (let [at (str/index-of content needle from)]
      (if (nil? at)
        acc
        (recur (inc at) (conj acc [at (+ at (count needle))]))))))

(defonce current-name (atom nil))
(defonce parked (atom {}))

(defn park [payload]
  (js/Promise.
   (fn [resolve]
     (swap! parked assoc @current-name {:resolve resolve :payload payload}))))

(defn unpark [{:keys [name value]}]
  (when-let [entry (@parked name)]
    ((:resolve entry) value)
    (swap! parked dissoc name)
    value))

(defn abandon [{:keys [name]}]
  (swap! parked dissoc name)
  nil)

(defn call
  [{:keys [argv cwd] :or {cwd "."}} timeout-ms]
  (js/Promise.
   (fn [resolve reject]
     (let [argv (vec argv)
           child (cp/spawn (first argv) (clj->js (rest argv))
                           #js {:cwd cwd :stdio #js ["ignore" "pipe" "pipe"]})
           out (atom "")
           err (atom "")
           timer (js/setTimeout
                  (fn []
                    (.kill child "SIGKILL")
                    (reject (ex-info "call timed out" {:code :STALLED})))
                  (or timeout-ms 30000))]
       (.on (.-stdout child) "data" #(swap! out str %))
       (.on (.-stderr child) "data" #(swap! err str %))
       (.on child "error" (fn [e]
                            (js/clearTimeout timer)
                            (reject e)))
       (.on child "close" (fn [code]
                            (js/clearTimeout timer)
                            (resolve {:exit code :stdout @out :stderr @err})))))))
