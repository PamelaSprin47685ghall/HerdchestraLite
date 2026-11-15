(ns herd.lock-daemon
  (:require [clojure.string :as str]
            [promesa.core :as p]))

(def ^:private stripped-env ["BUN_OPTIONS" "NODE_OPTIONS" "BASH_ENV" "ENV" "PROMPT_COMMAND"])
(def ^:private default-idle-ms 30000)
(def ^:private spawn-ready-timeout-ms 3000)
(defonce ^:private inflight-spawns (atom {}))

(defn- node-require [name]
  (if-let [require-fn (.-__herdRequire js/globalThis)]
    (require-fn name)
    (js/require name)))
(defn- process [] (.-process js/globalThis))
(defn- platform [] (.-platform (process)))

(defn lock-endpoint-for [lock-root]
  (let [path (node-require "node:path")
        os (node-require "node:os")
        crypto (node-require "node:crypto")
        resolved (.resolve path (or lock-root (.cwd (process))))
        hash (subs (.digest (.update (.createHash crypto "sha256") resolved) "hex") 0 16)]
    (cond
      (= "win32" (platform)) (str "\\\\.\\pipe\\herd-lock-" hash)
      (= "linux" (platform)) (str (char 0) "herd-lock-" hash)
      :else (.join path (.tmpdir os) (str "herd-lock-" hash ".sock")))))

(defn- file-socket? [endpoint]
  (and (not= "win32" (platform)) (not (str/starts-with? endpoint (str (char 0))))))

(defn- clean-env []
  (let [env (js/Object.assign #js {} (.-env (process)))]
    (doseq [key stripped-env] (js-delete env key))
    env))

(defn- runtime-candidates []
  (let [path (node-require "node:path")
        exe (.basename path (or (.-execPath (process)) ""))]
    (if (re-matches #"^(bun|node)(\.exe)?$" (str/lower-case exe))
      [(.-execPath (process))]
      (let [bun (.-Bun js/globalThis)
            which (when (and bun (fn? (.-which bun))) (.which bun "bun"))]
        (vec (distinct (remove nil? [(when (string? which) which) "bun" "node"])))))))

(defn- write-line [socket payload]
  (when (and socket (not (.-destroyed socket)) (.-writable socket))
    (try
      (.write socket (str (js/JSON.stringify payload) "
"))
      true
      (catch :default _ false))))

(defn- probe-socket-alive [endpoint]
  (js/Promise.
   (fn [resolve _]
     (let [net (node-require "node:net")
           socket (.connect net endpoint)
           done (fn [alive]
                  (.removeAllListeners socket)
                  (.destroy socket)
                  (resolve alive))]
       (.once socket "connect" #(done true))
       (.once socket "error" #(done false))
       (.setTimeout socket 250 #(done false))))))

(defn ^:async start-lock-daemon [options]
  (let [endpoint (aget options "endpoint")
        idle-ms (or (aget options "idleMs") default-idle-ms)
        on-ready (aget options "onReady")
        net (node-require "node:net")
        fs (node-require "node:fs/promises")
        locks (atom {})
        active (atom #{})
        closing (atom false)
        idle-timer (atom nil)
        server-ref (atom nil)
        clear-idle! (fn [] (when-let [timer @idle-timer] (js/clearTimeout timer) (reset! idle-timer nil)))
        schedule-idle! (fn []
                         (when-not (or @closing (<= idle-ms 0) (seq @active) (seq @locks))
                           (clear-idle!)
                           (reset! idle-timer
                                   (js/setTimeout
                                    (fn []
                                      (when (and (empty? @active) (empty? @locks))
                                        (when-let [server @server-ref] (.close server))))
                                    idle-ms))))
        shutdown! (fn []
                    (when-not @closing
                      (reset! closing true)
                      (clear-idle!)
                      (doseq [socket @active] (.destroy socket))
                      (reset! active #{})
                      (when-let [server @server-ref]
                        (.close server))
                      (when (file-socket? endpoint)
                        (try
                          (-> (.unlink fs endpoint) (.catch (fn [_] nil)))
                          (catch :default _ nil)))))
        release-key! (fn [key socket]
                       (let [entry (get @locks key)]
                         (when (and entry (= (:holder entry) socket))
                           (loop [queue (:queue entry)]
                             (if-let [next (first queue)]
                               (let [remaining (subvec queue 1)]
                                 (swap! locks assoc-in [key :queue] remaining)
                                 (if (and next (not (.-destroyed next)) (.-writable next))
                                   (do
                                     (swap! locks assoc-in [key :holder] next)
                                     (aset next "__heldKeys" (js/Set.))
                                     (.add (aget next "__heldKeys") key)
                                     (when-not (write-line next #js {:ok true :key key})
                                       (swap! locks assoc-in [key :holder] nil)
                                       (recur remaining)))
                                   (recur remaining)))
                               (do
                                 (swap! locks dissoc key)
                                 (schedule-idle!)))))
                         true))
        cleanup! (fn [socket]
                   (swap! active disj socket)
                   (doseq [key (js/Array.from (or (aget socket "__waitKeys") #js []))]
                     (when-let [entry (get @locks key)]
                       (let [queue (filterv #(not (identical? % socket)) (:queue entry))]
                         (swap! locks assoc-in [key :queue] queue)
                         (when (and (nil? (:holder entry)) (empty? queue))
                           (swap! locks dissoc key)))))
                   (doseq [key (js/Array.from (or (aget socket "__heldKeys") #js []))]
                     (release-key! key socket))
                   (schedule-idle!))
        handle-message! (fn [socket message]
                          (when (and (not @closing) (map? message))
                            (if (= "shutdown" (get message :op))
                              (do (write-line socket #js {:bye true}) (shutdown!))
                              (let [key (let [k (get message :key)] (if (and (string? k) (pos? (count k))) k "default"))]
                                (case (get message :op)
                                  "acquire"
                                  (let [entry (or (get @locks key) {:holder nil :queue []})]
                                    (if (nil? (:holder entry))
                                      (do
                                        (swap! locks assoc key (assoc entry :holder socket))
                                        (aset socket "__heldKeys" (js/Set.))
                                        (.add (aget socket "__heldKeys") key)
                                        (write-line socket #js {:ok true :key key}))
                                      (if (identical? (:holder entry) socket)
                                        (write-line socket #js {:ok true :key key})
                                        (do
                                          (aset socket "__waitKeys" (js/Set.))
                                          (.add (aget socket "__waitKeys") key)
                                          (swap! locks assoc key (update entry :queue conj socket))))))
                                  "release"
                                  (do
                                    (when-let [held (aget socket "__heldKeys")] (.delete held key))
                                    (release-key! key socket)
                                    (write-line socket #js {:released true :key key}))
                                  nil)))))
        create-server (fn []
                        (js/Promise.
                         (fn [resolve reject]
                           (let [server (.createServer net
                                                       (fn [socket]
                                                         (if @closing
                                                           (.destroy socket)
                                                           (do (clear-idle!)
                                                               (aset socket "__heldKeys" (js/Set.))
                                                               (aset socket "__waitKeys" (js/Set.))
                                                               (swap! active conj socket)
                                                               (let [buffer (atom "")]
                                                                 (.on socket "data"
                                                                      (fn [chunk]
                                                                        (swap! buffer str (.toString chunk "utf8"))
                                                                        (loop []
                                                                          (let [text @buffer
                                                                                nl (.indexOf text "
")]
                                                                            (when (>= nl 0)
                                                                              (let [raw (str/trim (subs text 0 nl))]
                                                                                (reset! buffer (subs text (inc nl)))
                                                                                (when (pos? (count raw))
                                                                                  (try
                                                                                    (handle-message! socket (js->clj (js/JSON.parse raw) :keywordize-keys true))
                                                                                    (catch :default _
                                                                                      (write-line socket #js {:ok false :error "INVALID_JSON"}))))
                                                                                (recur)))))))
                                                               (.on socket "close" #(cleanup! socket))
                                                               (.on socket "error" #(cleanup! socket)))))))]
                             (.once server "error" reject)
                             (.listen server endpoint #(do (reset! server-ref server) (resolve server)))))))]
    (if-not (and (string? endpoint) (pos? (count endpoint)))
      (throw (js/TypeError. "startLockDaemon requires a non-empty endpoint"))
      (try
        (let [server (await (create-server))]
          (when (fn? on-ready) (on-ready "READY"))
          (schedule-idle!)
          #js {:endpoint endpoint :shutdown shutdown!})
        (catch :default error
          (if (= "EADDRINUSE" (.-code error))
            (do (when (file-socket? endpoint)
                  (when-not (await (probe-socket-alive endpoint))
                    (try (await (.unlink fs endpoint)) (catch :default _ nil))
                    (let [server (await (create-server))]
                      (when (fn? on-ready) (on-ready "READY"))
                      (schedule-idle!)
                      server)))
                (when (fn? on-ready) (on-ready "BUSY"))
                nil)
            (throw error)))))))

(defn- spawn-with-runtime [runtime endpoint]
  (js/Promise.
   (fn [resolve reject]
     (let [child-process (node-require "node:child_process")
           entry (or (.-__herdEntryPath js/globalThis)
                     (str (.cwd (process)) "/src/clj-main.mjs"))
           encoded (.toString (js/Buffer.from endpoint "utf8") "base64")
           child (.spawn child-process runtime #js [entry "--daemon-b64" encoded]
                         #js {:detached true :env (clean-env) :stdio #js ["ignore" "pipe" "pipe"]})
           settled (atom false)
           timer-ref (atom nil)
           buffer (atom "")
           stderr-text (atom "")
           finish (fn [fn value]
                    (when-not @settled
                      (reset! settled true)
                      (when-let [timer @timer-ref] (js/clearTimeout timer))
                      (when (.-stdout child) (.removeAllListeners (.-stdout child)) (.destroy (.-stdout child)))
                      (.removeAllListeners child "error")
                      (.removeAllListeners child "exit")
                      (.unref child)
                      (fn value)))
           timer (js/setTimeout #(finish reject (js/Error. (str "lock daemon startup timed out for " endpoint)))
                                spawn-ready-timeout-ms)]
       (reset! timer-ref timer)
       (.unref timer)
       (when (.-stderr child)
         (.on (.-stderr child) "data" (fn [chunk] (swap! stderr-text str (.toString chunk "utf8")))))
       (.once child "error" #(finish reject %))
       (.once child "exit" (fn [code] (finish reject (js/Error. (str "lock daemon exited early (" (or code "unknown") ") " @stderr-text)))))
       (when (.-stdout child)
         (.on (.-stdout child) "data"
              (fn [chunk]
                (swap! buffer str (.toString chunk "utf8"))
                (let [text @buffer nl (.indexOf text "
")]
                  (when (>= nl 0)
                    (let [line (str/trim (subs text 0 nl))]
                      (when (or (= line "READY") (= line "BUSY"))
                        (finish resolve line))))))))))))

(defn- ^:async ensure-daemon-body [endpoint]
  (when (file-socket? endpoint)
    (when-not (await (probe-socket-alive endpoint))
      (try
        (await (.unlink (node-require "node:fs/promises") endpoint))
        (catch :default _ nil))))
  (loop [candidates (runtime-candidates)
         last-error nil]
    (if-let [runtime (first candidates)]
      (try
        (await (spawn-with-runtime runtime endpoint))
        (catch :default error
          (recur (rest candidates) error)))
      (throw (or last-error (js/Error. "failed to start lock daemon"))))))

(defn- ^:async ensure-daemon [endpoint]
  (if-let [inflight (get @inflight-spawns endpoint)]
    (await inflight)
    (let [task (ensure-daemon-body endpoint)]
      (swap! inflight-spawns assoc endpoint task)
      (try (await task) (finally (swap! inflight-spawns dissoc endpoint))))))

(defn- make-lock-busy-error [endpoint key waited-ms]
  (let [error (js/Error. "write lock is busy; it may be held by a running call; retry this operation shortly")]
    (set! (.-code error) "LOCK_BUSY")
    (set! (.-retryable error) true)
    (set! (.-waitedMs error) waited-ms)
    (set! (.-endpoint error) endpoint)
    (set! (.-key error) key)
    error))

(defn acquire-ipc-lock [options]
  (let [options (or options #js {})
        endpoint (or (aget options "endpoint") (lock-endpoint-for (aget options "key")))
        key (or (aget options "key") "default")
        wait-ms (or (aget options "waitMs") 500)
        clock (or (aget options "clock")
                  #js {:now (fn [] (js/Date.now))
                       :setTimeout (fn [f ms] (js/setTimeout f ms))
                       :clearTimeout (fn [id] (js/clearTimeout id))})
        net (node-require "node:net")
        started (.now clock)
        settled (atom false)
        timed-out (atom false)
        active-socket (atom nil)
        timer-id (atom nil)]
    (js/Promise.
     (fn [resolve reject]
       (let [clear-timer! (fn []
                            (when-let [id @timer-id]
                              (.clearTimeout clock id)
                              (reset! timer-id nil)))
             fail! (fn [error]
                     (when-not @settled
                       (reset! settled true)
                       (clear-timer!)
                       (when-let [socket @active-socket]
                         (.removeAllListeners socket)
                         (.destroy socket)
                         (reset! active-socket nil))
                       (reject error)))
             on-timeout (fn []
                          (reset! timed-out true)
                          (fail! (make-lock-busy-error endpoint key (max 0 (- (.now clock) started)))))
             attempt (fn attempt [allow-spawn]
                       (when-not (or @settled @timed-out)
                         (let [socket (.connect net endpoint)
                               buffer (atom "")]
                           (reset! active-socket socket)
                           (.once socket "connect"
                                  (fn []
                                    (if (or @settled @timed-out)
                                      (.destroy socket)
                                      (write-line socket #js {:op "acquire" :key key}))))
                           (.on socket "data"
                                (fn [chunk]
                                  (when-not (or @settled @timed-out)
                                    (swap! buffer str (.toString chunk "utf8"))
                                    (loop []
                                      (let [text @buffer
                                            nl (.indexOf text "\n")]
                                        (when (>= nl 0)
                                          (let [raw (str/trim (subs text 0 nl))]
                                            (reset! buffer (subs text (inc nl)))
                                            (when (pos? (count raw))
                                              (try
                                                (let [message (js/JSON.parse raw)]
                                                  (when (true? (.-ok message))
                                                    (reset! settled true)
                                                    (clear-timer!)
                                                    (let [released (atom false)
                                                          release (fn []
                                                                    (if @released
                                                                      (js/Promise.resolve nil)
                                                                      (do
                                                                        (reset! released true)
                                                                        (if (.-destroyed socket)
                                                                          (js/Promise.resolve nil)
                                                                          (js/Promise.
                                                                           (fn [done]
                                                                             (let [finished (atom false)
                                                                                   timer (atom nil)
                                                                                   finish (fn []
                                                                                            (when-not @finished
                                                                                              (reset! finished true)
                                                                                              (when-let [t @timer] (js/clearTimeout t))
                                                                                              (.removeAllListeners socket)
                                                                                              (when-not (.-destroyed socket) (.destroy socket))
                                                                                              (done nil)))]
                                                                               (reset! timer (js/setTimeout finish 100))
                                                                               (.once socket "close" (fn [_] (finish)))
                                                                               (.once socket "error" (fn [_] (finish)))
                                                                               (.on socket "data" (fn [chunk]
                                                                                                      (when (str/includes? (.toString chunk "utf8") "\"released\":true")
                                                                                                        (finish))))
                                                                               (when-not (write-line socket #js {:op "release" :key key})
                                                                                 (finish)))))))))]
                                                      (.removeAllListeners socket "error")
                                                      (.once socket "error" (fn [_] nil))
                                                      (resolve #js {:endpoint endpoint
                                                                    :key key
                                                                    :waitedMs (max 0 (- (.now clock) started))
                                                                    :release release}))))
                                                (catch :default _ nil))
                                              (recur)))))))))
                           (.once socket "error"
                                  (fn [error]
                                    (.removeAllListeners socket)
                                    (when-not (or @settled @timed-out)
                                      (when (identical? @active-socket socket)
                                        (reset! active-socket nil))
                                      (if (and allow-spawn
                                               (or (= "ENOENT" (.-code error))
                                                   (= "ECONNREFUSED" (.-code error))))
                                        (-> (ensure-daemon endpoint)
                                            (.then (fn [_]
                                                     (when-not (or @settled @timed-out)
                                                       (attempt false))))
                                            (.catch fail!))
                                        (fail! error)))))
                           (.once socket "close"
                                  (fn []
                                    (when (and (identical? @active-socket socket)
                                               (not @settled)
                                               (not @timed-out))
                                      (fail! (js/Error. "lock connection closed before acquiring lock"))))))))]
         (reset! timer-id (.setTimeout clock on-timeout wait-ms))
         (attempt true))))))

(defn shutdown-ipc-daemon [endpoint]
  (js/Promise.
   (fn [resolve _]
     (let [net (node-require "node:net")
           socket (.connect net endpoint)
           finish (fn [] (.removeAllListeners socket) (.destroy socket) (resolve nil))]
       (.once socket "connect" #(write-line socket #js {:op "shutdown"}))
       (.once socket "data" finish)
       (.once socket "close" finish)
       (.once socket "error" finish)
       (let [timer (js/setTimeout finish 200)] (.unref timer))))))
