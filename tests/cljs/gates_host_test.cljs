(ns cljs.gates-host-test
  (:require
   [clojure.string :as str]
   [herd.gates-host :as gates-host]
   [herd.stages.store :as store]
   [herd.test :as t]
   [promesa.core :as p]))

(def now "2026-11-14T00:00:00.000Z")
(def fs ((.-__herdRequire js/globalThis) "node:fs"))
(def path ((.-__herdRequire js/globalThis) "node:path"))
(def os ((.-__herdRequire js/globalThis) "node:os"))

(defn- journal-ctx [root id]
  (let [file (.join path root "sessions" (str id ".jsonl"))]
    #js {:cwd root
         :sessionManager
         #js {:getSessionId (fn [] id)
              :getSessionFile (fn [] file)
              :appendCustomEntry
              (fn [custom-type data]
                (.mkdirSync fs (.dirname path file) #js {:recursive true})
                (.appendFileSync fs file
                                 (str (js/JSON.stringify
                                       #js {:type "custom"
                                            :customType custom-type
                                            :data data})
                                      "\n")))}}))

(t/describe "CLJS gate host adapter"
  (fn []
    (t/it "registers JS-shaped tools and executes review through them"
      (fn []
        (let [root (.mkdtempSync fs (.join path (.tmpdir os) "cljs-gates-host-"))]
          (p/let [_ (store/create-mission! root
                                           {:slug "demo"
                                            :mission-id "M1"
                                            :now now
                                            :ctx (journal-ctx root "demo")})
                  defs (atom [])
                  pi #js {:registerTool (fn [definition]
                                          (swap! defs conj definition))}
                  service (gates-host/register! pi #js {:root root
                                                        :slug "demo"
                                                        :now (fn [] now)})
                  names (mapv (fn [definition] (.-name definition)) @defs)
                  review (some (fn [definition]
                                 (when (= "review" (.-name definition)) definition))
                               @defs)
                  result ((.-execute review) "call-1" #js {} nil nil #js {:cwd root})
                  block (aget (.-content result) 0)]
            (try
              (t/to-equal names
                          ["review" "attach_brainstorm" "attach_manual_tests"
                           "attach_dev_guide" "attach_coordination" "ask_user"
                           "devops" "submit_devops_report"])
              (t/to-be (.-type (.-parameters review)) "object")
              (t/to-be (instance? js/Function (.-execute review)) true)
              (t/to-be (nil? (.-isError result)) true)
              (t/to-contain (aget block "text") ":status :review-quiescent")
              (t/to-be (some? service) true)
              (finally
                (.rmSync fs root #js {:recursive true :force true})))))))))
