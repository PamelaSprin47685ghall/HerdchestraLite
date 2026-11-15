(ns cljs.handoff-test
  (:require
   [herd.test :as t]
   [promesa.core :as p]))

(defn- make-pi []
  (let [tools (js/Map.)
        hooks (js/Map.)
        pi #js {}]
    (aset pi "tools" tools)
    (aset pi "hooks" hooks)
    (aset pi "active" #js [])
    (aset pi "registerTool" (fn [definition]
                                (.set tools (.-name definition) definition)))
    (aset pi "on" (fn [name handler] (.set hooks name handler)))
    (aset pi "getActiveTools" (fn [] (js/Array.from (aget pi "active"))))
    (aset pi "setActiveTools" (fn [next] (aset pi "active" (js/Array.from next))))
    pi))

(defn- load-string [source]
  (.loadString (.-__herdNbb js/globalThis) source))

(t/describe "handoff bridge"
  (fn []
    (t/it "hands the document to host compaction and does not rewrite history"
      (fn []
        (let [pi (make-pi)
              tools (aget pi "tools")
              hooks (aget pi "hooks")]
          (set! (.-__pi js/globalThis) pi)
          (p/let [_ ((.-__herdEnsureActivated js/globalThis))
                  hack-context (load-string "bridge.hack-context/hack-context")
                  handler (load-string "herd.main/context-handler")]
            (hack-context pi (fn [event ctx] (handler event ctx)))
            (let [appended (atom [])
                  ctx #js {:agent #js {:id "handoff-bridge"}
                           :sessionManager
                           #js {:getEntries (fn [] #js [#js {:id "entry-1"}])
                                :appendCompaction
                                (fn [& args]
                                  (swap! appended conj (vec args))
                                  "compaction-1")}}]
              (p/let [receipt (.execute (.get tools "handoff")
                                        "call-h1"
                                        #js {:markdown "handoff body"}
                                        nil
                                        nil
                                        ctx)]
                (let [text (aget (aget (aget receipt "content") 0) "text")]
                  (t/to-contain text ":status :handoff-requested")
                  (t/to-contain text ":committed true"))
                (t/to-be (count @appended) 1)
                (t/to-contain (str (first (first @appended))) "handoff body")
                (p/let [result ((aget hooks "context")
                                #js {:messages #js [#js {:role "user"
                                                         :content "u0"}]}
                                ctx)]
                  (t/to-be (.-length (.-messages result)) 2)
                  (t/to-be (nil? (.-handoffReplacement result)) true))))))))))
