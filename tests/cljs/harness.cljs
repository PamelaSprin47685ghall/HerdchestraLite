(ns cljs.harness
  (:require
   ["node:fs/promises" :as fsp]
   ["node:path" :as path]
   [clojure.string :as str]
   [promesa.core :as p]))

(def nbb (.-__herdNbb js/globalThis))
(def src-root (path/dirname (.-__herdEntryPath js/globalThis)))
(def tests-root (path/join src-root ".." "tests" "cljs"))

(defn- install-fake-clock []
  (let [now (atom 0)
        next-id (atom 0)
        timers (atom {})
        waiters (atom [])
        wake (fn []
               (let [pending @waiters]
                 (reset! waiters [])
                 (doseq [resolve pending] (resolve nil))))
        clock #js {}]
    (aset clock "now" (fn [] @now))
    (aset clock "performanceNow" (fn [] @now))
    (aset clock "setTimeout"
          (fn [f ms]
            (let [id (swap! next-id inc)]
              (swap! timers assoc id {:at (+ @now (max 0 (or ms 0))) :fn f})
              (wake)
              id)))
    (aset clock "clearTimeout" (fn [id] (swap! timers dissoc id)))
    (aset clock "waitForTimer"
          (fn []
            (js/Promise.
             (fn [resolve]
               (if (pos? (count @timers))
                 (resolve nil)
                 (swap! waiters conj resolve))))))
    (aset clock "advance"
          (fn [ms]
            (swap! now + ms)
            (loop []
              (let [due (filter (fn [[_ timer]] (<= (:at timer) @now)) @timers)]
                (when (seq due)
                  (doseq [[id timer] due]
                    (swap! timers dissoc id)
                    ((:fn timer)))
                  (recur))))))
    (aset clock "pending" (fn [] (count @timers)))
    (aset clock "reset"
          (fn []
            (reset! now 0)
            (reset! next-id 0)
            (reset! timers {})
            (reset! waiters [])))
    clock))

(set! (.-__herdCodingAgent js/globalThis)
      #js {:Container (fn []) :Markdown (fn []) :Spacer (fn []) :Text (fn []) :Settings (fn []) :VERSION "test"})
(set! (.-__herdHostExtras js/globalThis) #js {})
(set! (.-__herdHostVersions js/globalThis)
      #js {:hostVersion "test" :cliVersion "test" :runtimePackageVersion "test"})
(set! (.-__herdClock js/globalThis) (install-fake-clock))
(set! (.-__herdDetectLanguage js/globalThis) (fn [& _] "clojure"))
(set! (.-__herdEnsureActivated js/globalThis)
      (fn []
        (.loadString nbb "(herd.main/activate-session! js/globalThis.__pi)")))

(def test-files
  ["command_host_test.cljs" "parsers_test.cljs" "handoff_test.cljs"
   "entry_trace_test.cljs" "ufss_test.cljs" "surface_vibe_test.cljs"
   "gates_host_test.cljs" "hack_context_rewrite_test.cljs"
   "board_store_test.cljs" "board_tools_test.cljs" "abandon_test.cljs"
   "report_test.cljs" "system_install_test.cljs" "working_message_test.cljs"
   "usage_test.cljs" "console_guard_test.cljs" "board_test.cljs"
   "tool_ui_test.cljs" "gates_test.cljs" "surface_test.cljs"
   "util_errors_test.cljs" "file_matrix_test.cljs" "lock_contention_test.cljs"
   "runner_test.cljs" "auditors_test.cljs" "station_test.cljs"])

(p/let [names (fsp/readdir tests-root)
        discovered (->> (js->clj names)
                        (filter #(str/ends-with? % "_test.cljs"))
                        (remove (set test-files))
                        sort
                        vec)
        all-files (vec (concat test-files discovered))]
  (p/let [_ (.addClassPath nbb src-root)
          _ (.loadFile nbb (path/join src-root "herd/bootstrap.cljs"))
          _ (p/loop [remaining all-files]
              (if (empty? remaining)
                nil
                (p/let [_ (.loadFile nbb (path/join tests-root (first remaining)))]
                  (p/recur (rest remaining)))))]
    true))
