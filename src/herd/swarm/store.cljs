(ns herd.swarm.store
  (:require
   ["node:crypto" :as crypto]
   ["node:fs/promises" :as fs]
   ["node:path" :as path]
   [clojure.string :as string]
   [herd.swarm.edn :as edn]
   [herd.swarm.model :as model]
   [herd.ufss :as ufss]
   [herd.util.atomic-write :as atomic]
   [nbb.classpath :as cp-path]))

(defn- ^:async file-exists? [target]
  (-> (.access fs target)
      (.then (fn [_] true))
      (.catch (fn [_] false))))

(defn- ^:async file-size [target]
  (-> (.stat fs target)
      (.then (fn [stats] (.-size stats)))
      (.catch (fn [_] 0))))

(defn- ^:async sha256-file [target]
  (let [bytes (await (.readFile fs target))
        hash (.createHash crypto "sha256")]
    (.update hash bytes)
    (.digest hash "hex")))

(defn- ^:async read-board-file [board-path]
  (if-not (await (file-exists? board-path))
    {:state nil :missing true :corrupt false}
    (try
      (let [text (await (.readFile fs board-path "utf8"))
            value (ufss/read text)]
        (if (model/valid-board? value)
          {:state value :missing false :corrupt false}
          {:state nil :missing false :corrupt true}))
      (catch :default _
        {:state nil :missing false :corrupt true}))))

(defn- ^:async write-board-file! [board-path board]
  (let [text (str (ufss/canonical board) "\n")]
    (await (atomic/write-file-atomic! (path/dirname board-path)
                                      (path/basename board-path)
                                      text))))

(defn- ^:async append-events! [events-path events]
  (when (and (sequential? events) (seq events))
    (let [text (str (string/join "\n"
                                 (map (fn [event] (js/JSON.stringify (clj->js event))) events))
                    "\n")
          bytes (js/Buffer.from text "utf8")]
      (await (.mkdir fs (path/dirname events-path) #js {:recursive true}))
      (let [handle (await (.open fs events-path "a" 384))
            chain (-> (js/Promise.resolve nil)
                      (.then (fn [_] (.writeFile handle bytes)))
                      (.then (fn [_] (.sync handle)))
                      (.then (fn [_] (.close handle)))
                      (.catch (fn [error]
                                (-> (.close handle)
                                    (.catch (fn [_] nil))
                                    (.then (fn [_] (throw error)))))))]
        (await chain)))))

(defn- ^:async ensure-file! [target]
  (await (.mkdir fs (path/dirname target) #js {:recursive true}))
  (when-not (await (file-exists? target))
    (let [handle (await (.open fs target "a" 384))]
      (await (.close handle)))))

(defn- ^:async has-committed-ledger? [events-path checkpoint-path]
  (or (pos? (await (file-size events-path)))
      (await (file-exists? checkpoint-path))))

(defn- ^:async checkpoint! [checkpoint-path board-path events-path board]
  (await (atomic/write-edn-atomic!
           checkpoint-path
           {:offset (await (file-size events-path))
            :digest (await (sha256-file board-path))
            :board-version (:board-version board)
            :updated-at (.toISOString (js/Date.))})))

(def ^:private os (js/require "node:os"))

(defn- board-endpoint [lock-path]
  (or (let [override (.-__herdLockEndpoint js/globalThis)]
        (when (string? override) override))
      (let [resolved (path/resolve (path/dirname lock-path))
            hash (subs (.digest (.update (.createHash crypto "sha256") resolved) "hex") 0 16)
            platform (.-platform js/process)]
        (cond
          (= platform "win32") (str "\\\\.\\pipe\\herd-lock-" hash)
          (= platform "linux") (str (char 0) "herd-lock-" hash)
          :else (path/join (.tmpdir os) (str "herd-lock-" hash ".sock"))))))

(defn- daemon-candidates []
  (let [delim (.-delimiter path)
        cp-entries (->> (.split (or (cp-path/get-classpath) "") delim)
                        (remove (fn [entry] (or (string/blank? entry) (.includes entry ".herd")))))
        roots (distinct (remove nil?
                                (concat [(.-__herdPluginSrc js/globalThis)]
                                        cp-entries
                                        [(path/join (js/process.cwd) "src")])))]
    (mapv (fn [root] (path/join root "host" "lock-daemon.mjs")) roots)))

(defn- ^:async load-lock-daemon []
  (if-let [cached (.-__herdLockDaemon js/globalThis)]
    cached
    (let [candidates (daemon-candidates)]
      (loop [index 0]
        (if (>= index (count candidates))
          (throw (ex-info "lock daemon module not found" {:code :HOST_API_MISMATCH}))
          (let [candidate (nth candidates index)
                ok? (await (file-exists? candidate))]
            (if ok?
              (let [loaded (js/require candidate)]
                (aset js/globalThis "__herdLockDaemon" loaded)
                loaded)
              (recur (inc index)))))))))

(defonce ^:private board-lock-queues (atom {}))

(defn- ^:async run-ipc-board-lock [lock-path f]
  (let [daemon (await (load-lock-daemon))
        endpoint (board-endpoint lock-path)
        key (str "board:" (path/resolve lock-path))
        lease (try
                (await (.acquireIpcLock daemon #js {:endpoint endpoint :key key :waitMs 5000}))
                (catch :default error
                  (if (= "LOCK_BUSY" (.-code error))
                    (throw (ex-info "board lock is busy"
                                    {:code :BOARD_CONFLICT :lock-path lock-path :timeout-ms 5000}))
                    (throw error))))]
    (try
      (await (js/Promise.resolve (f)))
      (finally
        (await (.release lease))))))

(defn- ^:async with-board-lock* [lock-path f]
  (let [key (str "board:" (path/resolve lock-path))
        queued (atom nil)]
    (swap! board-lock-queues
           (fn [queues]
             (let [previous (get queues key (js/Promise.resolve nil))
                   next-run (-> previous
                                (.catch (fn [_] nil))
                                (.then (fn [_] (run-ipc-board-lock lock-path f))))]
               (reset! queued next-run)
               (assoc queues key (.catch next-run (fn [_] nil))))))
    (await @queued)))
(defn- ^:async with-board-lock [lock-path f]
  (if (nil? lock-path)
    (await (js/Promise.resolve (f)))
    (await (with-board-lock* lock-path f))))

(defn- ^:async memory-transaction! [state events f]
  (let [current @state
        outcome (await (js/Promise.resolve (f current)))]
    (when (and outcome (not (false? (:commit outcome))))
      (when (:board outcome) (reset! state (:board outcome)))
      (when (sequential? (:events outcome))
        (swap! events into (vec (:events outcome)))))
    (:response outcome)))

(defn create-memory-store
  ([] (create-memory-store {}))
  ([options]
   (let [initial (if (model/board-state? options) options (:initial options))
         state (atom (when initial (model/ensure-board-shape initial)))
         events (atom [])
         tail (atom (js/Promise.resolve nil))
         enqueue (fn [f]
                   (let [run (-> @tail
                                 (.then (fn [_] true) (fn [_] true))
                                 (.then (fn [_] (f))))]
                     (reset! tail (-> run (.then (fn [_] nil) (fn [_] nil))))
                     run))]
     {:durable false
      :read (fn [] (js/Promise.resolve @state))
      :transaction (fn [f] (enqueue (fn [] (memory-transaction! state events f))))
      :snapshot (fn [] @state)
      :events (fn [] @events)})))

(defn- ^:async file-transaction! [board-path events-path checkpoint-path lock-path f]
  (await (with-board-lock
           lock-path
           (fn []
             (-> (read-board-file board-path)
                 (.then
                   (fn [detail]
                     (-> (js/Promise.resolve (f (:state detail)))
                         (.then
                           (fn [outcome]
                             (cond
                               (or (nil? outcome) (false? (:commit outcome)))
                               (:response outcome)

                               :else
                               (let [next-board (or (:board outcome) (:state detail))]
                                 (cond
                                   (nil? next-board)
                                   (throw (ex-info "board store has no board to commit"
                                                   {:code :STALE_CONTROL :board-path board-path}))

                                   :else
                                   (-> (write-board-file! board-path next-board)
                                       (.then (fn [_]
                                                (append-events! events-path (:events outcome))))
                                       (.then (fn [_]
                                                (checkpoint! checkpoint-path board-path
                                                             events-path next-board)))
                                       (.then (fn [_] (:response outcome)))))))))))))))))

(defn- ^:async file-initialize! [board-path events-path checkpoint-path lock-path board]
  (when-not (model/valid-board? board)
    (throw (ex-info "initialize needs a complete board value" {:code :INVALID_ARGUMENT})))
  (await (with-board-lock
           lock-path
           (fn []
             (-> (read-board-file board-path)
                 (.then
                   (fn [detail]
                     (cond
                       (:state detail) (:state detail)
                       (:corrupt detail)
                       (throw (ex-info "board file is corrupt"
                                       {:code :STALE_CONTROL :board-path board-path}))
                       :else
                       (-> (has-committed-ledger? events-path checkpoint-path)
                           (.then
                             (fn [committed?]
                               (if committed?
                                 (throw (ex-info "board is missing while event or checkpoint state exists"
                                                 {:code :STALE_CONTROL :board-path board-path}))
                                 (-> (write-board-file! board-path board)
                                     (.then (fn [_] (ensure-file! events-path)))
                                     (.then (fn [_] (checkpoint! checkpoint-path board-path
                                                                  events-path board)))
                                     (.then (fn [_] board)))))))))))))))

(defn create-file-store [options]
  (when-not (map? options)
    (throw (ex-info "create-file-store needs an options object" {:code :INVALID_ARGUMENT})))
  (let [board-path (:board-path options)]
    (when-not (edn/text? board-path)
      (throw (ex-info "create-file-store needs board-path" {:code :INVALID_ARGUMENT})))
    (let [events-path (or (:events-path options)
                          (path/join (path/dirname board-path) "events.jsonl"))
          checkpoint-path (or (:checkpoint-path options)
                              (path/join (path/dirname board-path) "checkpoint.edn"))
          lock-path (or (:lock-path options)
                        (path/join (path/dirname board-path) "board.lock"))
          lock? (and (not (false? (:lock options))) (some? lock-path))
          effective-lock (when lock? lock-path)]
      {:durable true
       :board-path board-path
       :events-path events-path
       :checkpoint-path checkpoint-path
       :lock-path lock-path
       :read (fn []
               (-> (read-board-file board-path)
                   (.then (fn [detail] (:state detail)))))
       :transaction (fn [f]
                      (file-transaction! board-path events-path checkpoint-path effective-lock f))
       :initialize (fn [board]
                     (file-initialize! board-path events-path checkpoint-path effective-lock board))})))

(defn open-board
  ([root slug]
   (open-board root slug {}))
  ([root slug options]
   (when-not (and (edn/text? root) (edn/text? slug))
     (throw (ex-info "open-board needs root and slug" {:code :INVALID_ARGUMENT})))
   (let [mode (if (= :plan (:mode options)) :plan :swarm)
         directory (path/join root ".herd" "missions" slug)
         board-path (or (:board-path options) (path/join directory "board.edn"))
         events-path (or (:events-path options) (path/join directory "events.jsonl"))
         checkpoint-path (or (:checkpoint-path options) (path/join directory "checkpoint.edn"))
         lock-path (when (= mode :swarm)
                     (or (:lock-path options)
                         (path/join root ".herd" "locks" "s5-board.lock")))
         store (or (:store options)
                   (create-file-store {:board-path board-path
                                       :events-path events-path
                                       :checkpoint-path checkpoint-path
                                       :lock-path lock-path
                                       :lock (= mode :swarm)
                                       :slice-id slug}))
         durable (if (contains? options :durable)
                   (:durable options)
                   (not (false? (:durable store))))]
     {:root root
      :slug slug
      :mode mode
      :board-path board-path
      :events-path events-path
      :checkpoint-path checkpoint-path
      :lock-path lock-path
      :store store
      :durable durable})))

(defn board-handle? [value]
  (and (map? value) (some? (:store value)) (string? (:board-path value))))

(defn ^:async read-board
  ([handle-or-root]
   (if (and (map? handle-or-root) (:store handle-or-root) (:board-path handle-or-root))
     (await ((:read (:store handle-or-root))))
     (throw (ex-info "read-board needs a handle or root+slug" {:code :INVALID_ARGUMENT}))))
  ([handle-or-root slug]
   (read-board handle-or-root slug {}))
  ([handle-or-root slug options]
   (let [handle (if (board-handle? handle-or-root)
                  handle-or-root
                  (open-board handle-or-root slug options))]
     (await ((:read (:store handle)))))))

(defn ^:async initialize-board! [handle board]
  (let [store (:store handle)]
    (if-not (fn? (:initialize store))
      (throw (ex-info "board store cannot initialize" {:code :INVALID_ARGUMENT}))
      (await ((:initialize store) (or board (model/initial-board {:mode (:mode handle)})))))))
