(ns cljs.working-message-test
  (:require
   [clojure.string :as str]
   [herd.main :as main]
   [herd.test :as t]
   [promesa.core :as p]))

(def fs ((.-__herdRequire js/globalThis) "node:fs"))

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

(defn- reset-state! []
  (reset! main/usage-totals {})
  (reset! main/last-usage {})
  (reset! main/last-usage-line {})
  (reset! main/last-prefix {})
  (reset! main/active-usage-key nil)
  (reset! main/ui-render {:usage-last nil :last-working {}})
  (reset! main/last-host-working-text nil)
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

(defn- main-ctx [ui]
  #js {:hasUI true :ui ui :agent #js {:id "main-session"}})

(defn- sub-ctx [id ui]
  #js {:hasUI true :ui ui :agent #js {:id id :kind "sub"}})

(defn- hook [name]
  (.get (aget pi "hooks") name))

(defn- last-line [lines]
  (peek @lines))

(t/describe "working message host-overwrite recovery"
  (fn []
    (t/it "registers the update hooks used to detect a host overwrite"
      (fn []
        (p/let [_ (ensure!)
                _ (reset-state!)]
          (t/to-be (fn? (hook "message_update")) true)
          (t/to-be (fn? (hook "tool_execution_update")) true))))
    (t/it "restores our text after the host writes its own working line"
      (fn []
        (p/let [_ (ensure!)
                _ (reset-state!)
                _ ((hook "message_end") (usage-event 100 10) (main-ctx (:ui (make-ui))))]
          (let [{:keys [ui lines]} (make-ui)
                ctx (main-ctx ui)
                _ (reset-state!)
                _ ((hook "message_end") (usage-event 100 10) ctx)
                target (last-line lines)]
            (t/to-contain target "Δ:")
            (t/to-contain target "Σ:")
            (.setWorkingMessage ui "原版工作条")
            (t/to-be (last-line lines) "原版工作条")
            (let [before (count @lines)]
              (p/let [_ ((hook "message_update") #js {} ctx)]
                ((.-advance (.-__herdClock js/globalThis)) 100)
                (t/to-be (count @lines) (inc before))
                (t/to-be (last-line lines) target)
                (let [settled (count @lines)]
                  (p/let [_ ((hook "message_update") #js {} ctx)]
                    ((.-advance (.-__herdClock js/globalThis)) 100)
                    (t/to-be (count @lines) settled)
                    (t/to-be (last-line lines) target)))))))))
    (t/it "never writes the main UI from a subagent context"
      (fn []
        (p/let [_ (ensure!)
                _ (reset-state!)]
          (let [{:keys [ui lines]} (make-ui)]
            (p/let [_ ((hook "message_end") (usage-event 100 10) (main-ctx ui))]
              (let [baseline (count @lines)
                    sub (sub-ctx "sub-a" ui)]
                (p/let [_ ((hook "message_update") #js {} sub)
                        _ ((hook "tool_execution_update") #js {} sub)
                        _ ((hook "message_end") (usage-event 200 20) sub)
                        _ ((hook "message_update") #js {} sub)]
                  (t/to-be (count @lines) baseline))))))))
    (t/it "uses events, never a polling timer, on the working-message path"
      (fn []
        (p/let [_ (ensure!)
                _ (reset-state!)]
          (let [source (.readFileSync fs "src/herd/main.cljs" "utf8")
                start (str/index-of source "(defonce ui-render")
                end (str/index-of source "(defonce registered-clj-pis")
                working (subs source start end)]
            (t/to-be (str/includes? working "setInterval") false)
            (t/to-be (str/includes? working "setTimeout") false)
            (let [{:keys [ui]} (make-ui)
                  ctx (main-ctx ui)
                  real-interval (.-setInterval js/globalThis)
                  real-timeout (.-setTimeout js/globalThis)
                  timer-calls (atom 0)]
              (p/let [_ ((hook "message_end") (usage-event 100 10) ctx)]
                (set! (.-setInterval js/globalThis)
                      (fn [& args] (swap! timer-calls inc) (apply real-interval args)))
                (set! (.-setTimeout js/globalThis)
                      (fn [& args] (swap! timer-calls inc) (apply real-timeout args)))
                (try
                  ((hook "message_update") #js {} ctx)
                  ((hook "message_update") #js {} ctx)
                  (finally
                    (set! (.-setInterval js/globalThis) real-interval)
                    (set! (.-setTimeout js/globalThis) real-timeout)))
                (t/to-be @timer-calls 0))))))))
)