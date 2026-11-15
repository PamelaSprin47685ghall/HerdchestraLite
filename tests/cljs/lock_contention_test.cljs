(ns cljs.lock-contention-test
  (:require
   ["node:child_process" :as child]
   ["node:fs" :as fs]
   ["node:fs/promises" :as fsp]
   ["node:os" :as os]
   ["node:path" :as path]
   [clojure.string :as str]
   [herd.lock-daemon :as lock]
   [herd.sandbox :as sandbox]
   [herd.test :as t]
   [promesa.core :as p]))

(def process (.-process js/globalThis))
(def env (.-env process))
(def clock (.-__herdClock js/globalThis))

(defn- make-root []
  (fs/mkdtempSync (path/join (os/tmpdir) "herd-lock-")))

(defn- native-read [params]
  (-> (fsp/readFile (aget params "path") "utf8")
      (.then (fn [text]
               #js {:content #js [#js {:type "text" :text text}]}))))

(defn- native-write [params delay-ms]
  (js/Promise.
   (fn [resolve reject]
     (js/setTimeout
      (fn []
        (-> (fsp/writeFile (aget params "path") (aget params "content") "utf8")
            (.then (fn [_] (resolve #js {:content #js []})))
            (.catch reject)))
      delay-ms))))

(defn- native-tools [delay-ms]
  #js {:available (fn [_name _context] true)
       :invoke (fn [name params _options _context]
                 (if (= name "read")
                   (native-read params)
                   (native-write params delay-ms)))})

(defn- set-native! [delay-ms]
  (set! (.-__herdNativeTools js/globalThis) (native-tools delay-ms)))

(defn- write-result [file content]
  (-> (sandbox/write {:path file :content content})
      (.then (fn [_] {:ok true}))
      (.catch (fn [error]
                {:ok false
                 :code (or (:code (ex-data error)) (.-code error))
                 :message (.-message error)
                 :waited-ms (:waited-ms (ex-data error))
                 :retryable (:retryable (ex-data error))}))))

(defn- settle-clock [promise timers]
  (let [settled (atom false)
        mark (fn [& _] (reset! settled true))]
    (.then promise mark mark)
    (p/loop [i 0]
      (if (or @settled (>= i timers))
        promise
        (p/let [_ (js/Promise.race
                   #js [(.waitForTimer clock)
                        (.then promise (fn [_] true) (fn [_] true))])]
          (when-not @settled (.advance clock 10))
          (p/recur (inc i)))))))

(defn- wait-for-held [child-process]
  (js/Promise.
   (fn [resolve]
     (.on (.-stdout child-process) "data"
          (fn [chunk]
            (when (str/includes? (str chunk) "HELD")
              (resolve true)))))))

(t/describe "lock contention (event-driven IPC)"
  (fn []
    (t/it "serializes two concurrent writes to one file"
      (fn []
        (p/let [root (make-root)
                _ (set! (.-__herdLockRoot js/globalThis) root)
                _ (set-native! 0)
                file (path/join root "same-file.txt")
                results (p/all [(write-result file "alpha")
                                (write-result file "beta")])
                text (fsp/readFile file "utf8")]
          (t/to-be (every? :ok results) true)
          (t/to-be (contains? #{"alpha" "beta"} text) true))))
    (t/it "serializes many concurrent same-process writes across distinct files without self-inflicted LOCK_BUSY"
      (fn []
        (p/let [root (make-root)
                _ (set! (.-__herdLockRoot js/globalThis) root)
                _ (set-native! 15)
                files (mapv #(path/join root (str "many-" % ".txt")) (range 6))
                results (p/all (mapv (fn [file] (write-result file (str "val-" file))) files))
                texts (p/all (mapv #(fsp/readFile % "utf8") files))]
          (t/to-be (every? :ok results) true)
          (t/to-be (= (count texts) 6) true))))
    (t/it "returns LOCK_BUSY after the injected wait while an external connection holds the lock"
      (fn []
        (p/let [root (make-root)
                _ (set! (.-__herdLockRoot js/globalThis) root)
                _ (set-native! 0)
                endpoint (lock/lock-endpoint-for root)
                key (sandbox/lock-key)
                previous (.-HERD_LOCK_WAIT_MS env)
                _ (aset env "HERD_LOCK_WAIT_MS" "50")
                holder (lock/acquire-ipc-lock #js {:endpoint endpoint :key key :waitMs 500})]
          (p/finally
            (p/let [results (settle-clock
                              (p/all [(write-result (path/join root "busy-a.txt") "blocked-a")
                                      (write-result (path/join root "busy-b.txt") "blocked-b")])
                              20)]
              (doseq [info results]
                (t/to-be (:ok info) false)
                (t/to-be (:code info) "LOCK_BUSY")
                (t/to-be (:retryable info) true)
                (t/to-be (>= (:waited-ms info) 40) true)))
            (fn []
              (.release holder)
              (if (undefined? previous)
                (js-delete env "HERD_LOCK_WAIT_MS")
                (aset env "HERD_LOCK_WAIT_MS" previous)))))))
    (t/it "releases immediately without polling when the holding child process is SIGKILLed"
      (fn []
        (p/let [root (make-root)
                _ (set! (.-__herdLockRoot js/globalThis) root)
                _ (set-native! 0)
                endpoint (lock/lock-endpoint-for root)
                key (sandbox/lock-key)
                prev-wait (.-HERD_LOCK_WAIT_MS env)
                saved-clock (.-__herdClock js/globalThis)
                _ (js-delete js/globalThis "__herdClock")
                _ (aset env "HERD_LOCK_WAIT_MS" "1000")
                src-root (path/join (.cwd process) "src")
                lock-path (path/join src-root "herd/lock_daemon.cljs")
                script (str "import * as nbb from \"nbb\";\n"
                            "nbb.addClassPath(" (js/JSON.stringify src-root) ");\n"
                            "await nbb.loadFile(" (js/JSON.stringify lock-path) ");\n"
                            "const acquire = await nbb.loadString(\"herd.lock-daemon/acquire-ipc-lock\");\n"
                            "await acquire({endpoint:" (js/JSON.stringify endpoint)
                            ",key:" (js/JSON.stringify key) ",waitMs:1000});\n"
                            "console.log(\"HELD\");\n"
                            "setInterval(() => {}, 1000);\n")
                child-process (child/spawn "bun" #js ["-e" script]
                                           #js {:stdio #js ["ignore" "pipe" "inherit"]})]
          (try
            (p/let [_ (wait-for-held child-process)
                    file (path/join root "after-sigkill.txt")
                    started (js/Date.now)
                    pending (write-result file "instant-handoff")
                    _ (js/setTimeout (fn [] (.kill child-process "SIGKILL")) 25)
                    result pending
                    elapsed (- (js/Date.now) started)
                    text (fsp/readFile file "utf8")]
              (t/to-be (:ok result) true)
              (t/to-be (< elapsed 500) true)
              (t/to-be text "instant-handoff"))
            (finally
              (try (.kill child-process "SIGKILL") (catch :default _ nil))
              (set! (.-__herdClock js/globalThis) saved-clock)
              (if (undefined? prev-wait)
                (js-delete env "HERD_LOCK_WAIT_MS")
                (aset env "HERD_LOCK_WAIT_MS" prev-wait))))))
    (t/it "derives different lock endpoints and keys for different working directories"
      (fn []
        (let [original (.cwd process)
              previous (.-__herdLockRoot js/globalThis)]
          (try
            (set! (.-__herdLockRoot js/globalThis) js/undefined)
            (p/let [root (make-root)
                    first (path/join root "cwd-a")
                    second (path/join root "cwd-b")
                    _ (fs/mkdirSync first #js {:recursive true})
                    _ (fs/mkdirSync second #js {:recursive true})]
              (.chdir process first)
              (p/let [path-a (sandbox/lock-path)
                      key-a (sandbox/lock-key)]
                (.chdir process second)
                (p/let [path-b (sandbox/lock-path)
                        key-b (sandbox/lock-key)]
                  (t/to-be (not= path-a path-b) true)
                  (t/to-be (not= key-a key-b) true)
                  (t/to-contain key-a first)
                  (t/to-contain key-b second))))
            (finally
              (.chdir process original)
              (set! (.-__herdLockRoot js/globalThis) previous))))))
    (t/it "traces lock-wait with result when HERD_TRACE is enabled"
      (fn []
        (p/let [root (make-root)
                _ (set! (.-__herdLockRoot js/globalThis) root)
                _ (set-native! 0)
                trace-file (path/join root "trace" "perf-trace.jsonl")
                prev-trace (.-HERD_TRACE env)
                prev-path (.-HERD_TRACE_PATH env)
                _ (aset env "HERD_TRACE" "1")
                _ (aset env "HERD_TRACE_PATH" trace-file)
                endpoint (lock/lock-endpoint-for root)
                key (sandbox/lock-key)
                holder (lock/acquire-ipc-lock #js {:endpoint endpoint :key key :waitMs 500})]
          (p/finally
            (p/let [result (settle-clock
                            (write-result (path/join root "trace-busy.txt") "blocked")
                            20)
                    _ @sandbox/trace-tail
                    text (fsp/readFile trace-file "utf8")
                    events (->> (str/split-lines text)
                                (remove str/blank?)
                                (mapv #(js/JSON.parse %))
                                (filterv #(= "lock-wait" (aget % "event"))))
                    timeout (last events)]
              (t/to-be (:ok result) false)
              (t/to-be (> (count events) 0) true)
              (t/to-be (aget timeout "result") "timeout")
              (t/to-be (number? (aget timeout "ms")) true)
              (t/to-be (aget timeout "path") endpoint))
            (fn []
              (.release holder)
              (if (undefined? prev-trace)
                (js-delete env "HERD_TRACE")
                (aset env "HERD_TRACE" prev-trace))
              (if (undefined? prev-path)
                (js-delete env "HERD_TRACE_PATH")
                (aset env "HERD_TRACE_PATH" prev-path)))))))))

)
