(ns cljs.usage-test
  (:require
   [clojure.string :as str]
   [herd.main :as main]
   [herd.test :as t]
   [promesa.core :as p]))

(def fs ((.-__herdRequire js/globalThis) "node:fs"))
(def os ((.-__herdRequire js/globalThis) "node:os"))
(def path ((.-__herdRequire js/globalThis) "node:path"))
(def process (.-process js/globalThis))

(defn- make-pi []
  (let [tools (js/Map.)
        hooks (js/Map.)
        active (atom [])
        pi #js {}]
    (aset pi "tools" tools)
    (aset pi "hooks" hooks)
    (aset pi "active" active)
    (aset pi "registerTool" (fn [definition]
                                (.set tools (.-name definition) definition)))
    (aset pi "registerCommand" (fn [& _] nil))
    (aset pi "on" (fn [name handler] (.set hooks name handler)))
    (aset pi "getActiveTools" (fn [] (clj->js @active)))
    (aset pi "setActiveTools" (fn [next]
                                  (reset! active (vec (js->clj next)))
                                  (js/Promise.resolve nil)))
    (aset pi "pi" #js {:Text (fn [text] #js {:text text})
                         :Container (fn [] #js {:children #js []})})
    pi))

(def pi (make-pi))

(defn- ensure! []
  (set! (.-__pi js/globalThis) pi)
  (set! (.-__herdTui js/globalThis)
        #js {:highlightCode (fn [code] (str/split-lines code))})
  (set! (.-__herdNativeTools js/globalThis)
        #js {:available (fn [_name _context] false)
             :invoke (fn [& _]
                       (js/Promise.reject (js/Error. "native tools unavailable")))})
  ((.-__herdEnsureActivated js/globalThis)))

(defn- reset-usage! []
  (reset! main/usage-totals {})
  (reset! main/last-usage {})
  (reset! main/last-usage-line {})
  (reset! main/last-prefix {})
  (reset! main/active-usage-key nil)
  (reset! main/usage-timers {})
  (reset! main/usage-last-emit {}))

(defn- usage-event [input output]
  #js {:message #js {:role "assistant"
                     :usage #js {:input input
                                 :output output
                                 :cacheRead 0
                                 :cacheWrite 0
                                 :cost #js {:total 0}}}})

(defn- make-ui []
  (let [lines (atom [])]
    {:lines lines
     :ui #js {:setWorkingMessage (fn [text] (swap! lines conj text))
              :setStatus (fn [& _] nil)}}))

(defn- main-ctx
  ([ui] (main-ctx ui nil))
  ([ui session-manager]
   (if session-manager
     #js {:hasUI true :ui ui :agent #js {:id "main-session"}
          :sessionManager session-manager}
     #js {:hasUI true :ui ui :agent #js {:id "main-session"}})))

(defn- sub-ctx [id ui]
  #js {:hasUI true :ui ui :agent #js {:id id :kind "sub"}})

(defn- clock [] (.-__herdClock js/globalThis))
(defn- hook [name] (.get (aget pi "hooks") name))
(defn- last-line [lines] (peek @lines))

(defn- set-env! [key value]
  (if (nil? value)
    (js-delete (.-env process) key)
    (aset (.-env process) key value)))

(t/describe "working usage across subagents"
  (fn []
    (t/it "shows the main session's latest request when no subagent has reported"
      (fn []
        (p/let [_ (ensure!) _ (reset-usage!)]
          (let [{:keys [ui lines]} (make-ui)
                ctx (main-ctx ui)]
            (p/let [_ ((hook "message_end") (usage-event 100 10) ctx)
                    _ ((hook "message_end") (usage-event 300 30) ctx)]
              (t/to-contain (last-line lines) "Δ: 0.3k")
              (t/to-contain (last-line lines) "; Σ: 0.4k"))))))
    (t/it "keeps the latest subagent delta after a later main-session request"
      (fn []
        (p/let [_ (ensure!) _ (reset-usage!)]
          (let [{:keys [ui lines]} (make-ui)]
            (p/let [_ ((hook "message_end") (usage-event 100 10) (main-ctx ui))
                    _ ((hook "message_end") (usage-event 200 20) (sub-ctx "sub-a" ui))
                    _ ((hook "message_end") (usage-event 300 30) (main-ctx ui))]
              (t/to-contain (last-line lines) "Δ: 0.2k")
              (t/to-contain (last-line lines) "; Σ: 0.6k")
              (t/to-be @main/active-usage-key "sub-a"))))))
    (t/it "coalesces streaming usage ticks into one throttle window"
      (fn []
        (p/let [_ (ensure!) _ (reset-usage!)]
          (let [{:keys [ui lines]} (make-ui)
                ctx (main-ctx ui)]
            (p/let [_ ((hook "message_end") (usage-event 100 10) ctx)]
              (let [before-lines (count @lines)
                    before-timers ((.-pending (clock)))]
                (dotimes [_ 20] ((hook "message_update") #js {} ctx))
                (t/to-be (count @lines) before-lines)
                (t/to-be ((.-pending (clock))) (inc before-timers))
                ((.-advance (clock)) 99)
                (t/to-be ((.-pending (clock))) (inc before-timers))
                ((.-advance (clock)) 1)
                (t/to-be ((.-pending (clock))) before-timers)))))))
    (t/it "switches the delta to a second subagent and sums all four requests"
      (fn []
        (p/let [_ (ensure!) _ (reset-usage!)]
          (let [{:keys [ui lines]} (make-ui)]
            (p/let [_ ((hook "message_end") (usage-event 100 10) (main-ctx ui))
                    _ ((hook "message_end") (usage-event 200 20) (sub-ctx "sub-a" ui))
                    _ ((hook "message_end") (usage-event 300 30) (main-ctx ui))]
              (let [before-sub-b (count @lines)]
                (p/let [_ ((hook "message_end") (usage-event 400 40) (sub-ctx "sub-b" ui))]
                  (t/to-be (count @lines) before-sub-b)
                  (p/let [_ ((hook "message_start") #js {} (main-ctx ui))]
                    (t/to-contain (last-line lines) "Δ: 0.4k")
                    (t/to-contain (last-line lines) "; Σ: 1.0k")
                    (t/to-be @main/active-usage-key "sub-b")))))))))
    (t/it "resets only the starting session and keeps subagent totals and delta"
      (fn []
        (p/let [_ (ensure!) _ (reset-usage!)]
          (let [{:keys [ui lines]} (make-ui)]
            (p/let [_ ((hook "message_end") (usage-event 500 50) (main-ctx ui))
                    _ ((hook "message_end") (usage-event 200 20) (sub-ctx "sub-a" ui))
                    _ ((hook "session_start") #js {} (main-ctx ui))
                    _ ((hook "message_end") (usage-event 100 10) (main-ctx ui))]
              (t/to-contain (last-line lines) "Δ: 0.2k")
              (t/to-contain (last-line lines) "; Σ: 0.3k")
              (t/to-be (get-in @main/usage-totals ["sub-a" :input]) 200)
              (t/to-be (get-in @main/usage-totals ["main-session" :input]) 100))))))
    (t/it "updates totals without UI and tolerates a missing setWorkingMessage"
      (fn []
        (p/let [_ (ensure!) _ (reset-usage!)]
          ((hook "message_end") (usage-event 100 10)
                                 #js {:hasUI false :agent #js {:id "main-session"}})
          ((hook "message_end") (usage-event 50 5)
                                 #js {:hasUI true :ui #js {:setStatus (fn [& _] nil)}
                                      :agent #js {:id "main-session"}})
          (t/to-be (get-in @main/usage-totals ["main-session" :input]) 150)
          (t/to-be (get-in @main/usage-totals ["main-session" :output]) 15)
          (t/to-be @main/active-usage-key nil))))
    (t/it "records a cache probe only when enabled"
      (fn []
        (p/let [_ (ensure!) _ (reset-usage!)]
          (let [handler (hook "before_provider_request")
                payload #js {:system "s" :tools #js [] :messages #js [#js {:role "user" :content "x"}]}
                ctx (main-ctx nil)
                probe-path (.join path (.tmpdir os) "herd-usage-probe.jsonl")]
            (t/to-be (fn? handler) true)
            (set-env! "HERD_CACHE_PROBE" nil)
            (let [before ((.-now (clock)))]
              (t/to-be (handler #js {:payload payload} ctx) payload)
              (t/to-be ((.-now (clock))) before))
            (set-env! "HERD_CACHE_PROBE" "1")
            (set-env! "HERD_CACHE_PROBE_PATH" probe-path)
            (try
              (handler #js {:payload payload} ctx)
              (p/let [_ @main/probe-tail
                      text (p/let [value (.readFile fs probe-path "utf8")] value)]
                (t/to-contain text "messages")
                (t/to-contain text "count"))
              (finally
                (set-env! "HERD_CACHE_PROBE" nil)
                (set-env! "HERD_CACHE_PROBE_PATH" nil)
                (try (.rmSync fs probe-path) (catch :default _ nil))))))))
    (t/it "replays branch usage into the starting session's totals"
      (fn []
        (p/let [_ (ensure!) _ (reset-usage!)]
          (let [{:keys [ui lines]} (make-ui)
                manager #js {:getBranchView (fn []
                                             #js [#js {:type "model_usage"
                                                       :usage #js {:input 70 :output 7
                                                                   :cacheRead 3 :cacheWrite 0}}])}]
            (p/let [_ ((hook "session_start") #js {} (main-ctx ui manager))]
              (t/to-contain (last-line lines) "Δ: 0.0k")
              (t/to-contain (last-line lines) "; Σ: 0.1k")
              (t/to-be (get-in @main/usage-totals ["main-session" :input]) 70)
              (t/to-be (get-in @main/usage-totals ["main-session" :cache-read]) 3)))))))
)