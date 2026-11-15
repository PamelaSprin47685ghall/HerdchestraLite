(ns cljs.surface-vibe-test
  (:require
   [herd.main]
   [herd.system :as system]
   [herd.test :as t]
   [promesa.core :as p]))

(defn- apply-surface! [ctx]
  ((var-get (resolve 'herd.main/apply-tool-surface!)) ctx))

(defn- make-pi [active]
  (let [calls (atom [])
        active* (atom (vec active))
        tools (js/Map.)
        pi #js {}]
    (aset pi "tools" tools)
    (aset pi "registerTool" (fn [definition]
                                (.set tools (.-name definition) definition)))
    (aset pi "registerCommand" (fn [& _] nil))
    (aset pi "on" (fn [& _] nil))
    (aset pi "getActiveTools" (fn [] (clj->js @active*)))
    (aset pi "setActiveTools"
          (fn [next]
            (let [value (vec (js->clj next))]
              (swap! calls conj value)
              (reset! active* value)
              (js/Promise.resolve nil))))
    [pi calls active*]))

(defn- ctx-for [id]
  #js {:agent #js {:id id} :hasUI false})

(t/describe "vibe tool surface"
  (fn []
    (t/it "drops host edit/shell tools and keeps the devops tools"
      (fn []
        (let [[pi calls active*] (make-pi ["bash" "read" "write" "debug"])]
          (set! (.-__pi js/globalThis) pi)
          (p/let [_ (apply-surface! (ctx-for "vibe-append"))]
            (t/to-be (count @calls) 1)
            (t/to-equal (set @active*) #{"debug" "clj_devops" "wait" "handoff"})
            (t/to-be (some #{"bash" "read" "write"} @active*) nil)))))
    (t/it "drops host tools even when herd tools are missing"
      (fn []
        (let [[pi calls active*] (make-pi ["bash" "read"])]
          (set! (.-__pi js/globalThis) pi)
          (p/let [_ (apply-surface! (ctx-for "vibe-idempotent"))]
            (t/to-be (count @calls) 1)
            (t/to-equal (set @active*) #{"clj_devops" "wait" "handoff"})))))
    (t/it "never touches the /vibe main agent surface"
      (fn []
        (let [[pi calls active*] (make-pi ["bash" "read" "write" "debug" "vibe_spawn"])]
          (set! (.-__pi js/globalThis) pi)
          (p/let [_ (apply-surface! #js {:agent #js {:id "vibe-main"}
                                         :hasUI true
                                         :mode "vibe"})]
            (t/to-be (count @calls) 1)
            (t/to-equal (set @active*) #{"debug" "vibe_spawn" "clj_devops" "wait" "handoff"})
            (t/to-be (some #{"bash" "read" "write"} @active*) nil)))))
    (t/it "lets the mission surface take over without appending"
      (fn []
        (let [[pi calls active*] (make-pi ["bash" "read" "write" "debug" "clj_devops" "wait"])
              id "vibe-mission"]
          (swap! system/state update-in [:sessions id] assoc
                 :slug "surface-probe"
                 :stage :s1)
          (set! (.-__pi js/globalThis) pi)
          (p/let [_ (apply-surface! (ctx-for id))]
            (t/to-be (> (count @calls) 0) true)
            (t/to-equal @active*
                        ["wait" "handoff" "clj_plan" "review" "attach_brainstorm"
                         "ask_user" "devops"])
            (t/to-be (some #{"bash" "clj_devops"} @active*) nil)))))))
