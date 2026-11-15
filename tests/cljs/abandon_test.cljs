(ns cljs.abandon-test
  (:require
   [clojure.string :as str]
   [herd.repl :as repl]
   [herd.sandbox :as sandbox]
   [herd.test :as t]
   [promesa.core :as p]))

(def fs ((.-__herdRequire js/globalThis) "node:fs"))
(def os ((.-__herdRequire js/globalThis) "node:os"))
(def path ((.-__herdRequire js/globalThis) "node:path"))
(def process (.-process js/globalThis))

(defn- reset-runtime! []
  (reset! sandbox/token-state {:paths #{} :path-waiters {} :global false :global-waiters []})
  (reset! sandbox/active-calls {})
  (reset! sandbox/parked {})
  (reset! repl/programs {})
  (reset! repl/running #{})
  (reset! repl/abandoned #{}))

(defn- with-temp-workspace [f]
  (let [original (.cwd process)
        root (.mkdtempSync fs (.join path (.tmpdir os) "cljs-abandon-ws-"))]
    (.chdir process root)
    (reset-runtime!)
    (try
      (f root)
      (finally
        (.chdir process original)
        (.rmSync fs root #js {:recursive true :force true})))))

(t/describe "abandon kills the process group and clears runtime parks"
  (fn []
    (t/it "SIGKILLs the child process group and rejects the call"
      (fn []
        (with-temp-workspace
         (fn [_]
           (let [outcome (atom nil)
                 call (sandbox/call {:name "group-kill"
                                     :argv ["sh" "-c" "sleep 60 & echo $!; wait"]}
                                    0)]
             (.then call (fn [value] (reset! outcome {:ok value})))
             (.catch call (fn [error]
                            (reset! outcome {:message (or (ex-message error) (str error))})))
             (p/let [_ (sandbox/await-call-start "group-kill")
                     _ (sandbox/await-call-output "group-kill" "\n")
                     snapshot (sandbox/call-snapshot "group-kill")
                     pid (js/parseInt (str/trim (first (str/split (:stdout snapshot) #"\n"))) 10)
                     receipt (sandbox/abandon {:name "group-kill"})
                     _ (-> call (.then (fn [_] nil)) (.catch (fn [_] nil)))
                     alive? (try (js/process.kill pid 0) true (catch :default _ false))]
               (t/to-be (number? pid) true)
               (t/to-be (name (:state receipt)) "abandoned")
               (t/to-be (:cleared receipt) true)
               (t/to-be (get-in @outcome [:message]) "call abandoned")
               (t/to-be alive? false)))))))
    (t/it "clears a runtime-parked program with no active call"
      (fn []
        (with-temp-workspace
         (fn [_]
           (swap! repl/programs assoc "deadline-only"
                  {:state :parked :recoverable false :reason :deadline})
           (let [result (repl/abandon {:name "deadline-only"})]
             (t/to-be (name (:state result)) "cleared")
             (t/to-be (name (:reason result)) "deadline")
             (t/to-be (:cleared result) true)
             (t/to-be (contains? @repl/programs "deadline-only") false)
             (t/to-be (contains? @repl/abandoned "deadline-only") true))))))
    (t/it "abandons a tracked program without resurrecting its entry"
      (fn []
        (with-temp-workspace
         (fn [_]
           (repl/run "tracked" "(call {:argv [\"sleep\" \"30\"]})" 30000)
           (p/let [_ (sandbox/await-call-start "tracked")
                   registered? (contains? @sandbox/active-calls "tracked")
                   receipt (repl/abandon {:name "tracked"})]
             (t/to-be (name (:state receipt)) "abandoned")
             (t/to-be (:cleared receipt) true)
             (t/to-be (contains? @repl/programs "tracked") false)
             (t/to-be (contains? @repl/abandoned "tracked") true)
             (t/to-be registered? true))))))))
