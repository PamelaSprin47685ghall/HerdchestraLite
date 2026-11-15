(ns cljs.surface-test
  (:require
   ["node:fs/promises" :as fs]
   ["node:os" :as os]
   ["node:path" :as path]
   [clojure.string :as str]
   [herd.system :as system]
   [herd.test :as t]
   [promesa.core :as p]))

(def counter (atom 0))

(defn- fresh-root []
  (swap! counter inc)
  (fs/mkdtemp (path/join (os/tmpdir) (str "cljs-surface-" @counter "-"))))

(defn- make-pi []
  (let [tools (atom {})
        commands (atom {})
        hooks (atom {})
        active (atom ["read" "bash" "board_finish" "clj_devops" "wait"])
        pi #js {}]
    (aset pi "registerTool" (fn [definition]
                                (swap! tools assoc (.-name definition) definition)))
    (aset pi "registerCommand" (fn [name spec] (swap! commands assoc name spec)))
    (aset pi "on" (fn [name handler] (swap! hooks assoc name handler)))
    (aset pi "getActiveTools" (fn [] (clj->js @active)))
    (aset pi "setActiveTools"
          (fn [next]
            (reset! active (vec (js->clj next)))
            (js/Promise.resolve nil)))
    (aset pi "sendUserMessage" (fn [& _] nil))
    {:pi pi :tools tools :commands commands :hooks hooks :active active}))

(defn- main-ctx [root id]
  #js {:cwd root
       :hasUI false
       :mode "print"
       :sessionManager #js {:getSessionId (fn [] id)}})

(defn- sub-ctx [root id]
  #js {:cwd root
       :agent #js {:id id :kind "sub"}
       :sessionManager #js {:getSessionId (fn [] (str "sub-" id))}})

(defn- settle []
  (js/Promise. (fn [resolve] (js/setImmediate resolve))))

(defn- same [actual expected]
  (t/to-be (= actual expected) true))

(defn- setup [root]
  (let [{:keys [pi active] :as fake} (make-pi)
        calls (atom 0)]
    (system/reset-state!)
    (system/install! pi {:root root})
    (aset pi "setActiveTools"
          (fn [next]
            (swap! calls inc)
            (reset! active (vec (js->clj next)))
            (js/Promise.resolve nil)))
    (assoc fake :calls calls)))

(t/describe "CLJS mission and subagent tool surfaces"
  (fn []
    (t/it "keeps the default surface for a subagent without a role token"
      (fn []
        (p/let [root (fresh-root)
                fake (setup root)
                sub (sub-ctx root "S1")
                _ (swap! system/state update-in [:sessions "S1"] merge {:slug "vibe" :stage :s4})
                result (system/apply-mission-surface! (:pi fake) sub)
                surface (system/surface-for {:mission? true :subagent? true :stage :s4 :role nil})]
          (t/to-be result false)
          (t/to-be @(:calls fake) 0)
          (t/to-be surface nil)
          (same (vec @(:active fake)) ["read" "bash" "board_finish" "clj_devops" "wait"]))))
    (t/it "does not narrow a main session that has a slug but no stage"
      (fn []
        (p/let [root (fresh-root)
                fake (setup root)
                ctx (main-ctx root "session-1")
                _ (swap! system/state update-in [:sessions "session:session-1"] merge {:slug "vibe"})
                result (system/apply-mission-surface! (:pi fake) ctx)]
          (t/to-be result false)
          (t/to-be @(:calls fake) 0))))
    (t/it "narrows a main session to the S1 surface and fills in missing tools"
      (fn []
        (p/let [root (fresh-root)
                fake (setup root)
                _ (reset! (:active fake) ["review" "bash" "ask_user"])
                ctx (main-ctx root "session-1")
                _ (swap! system/state update-in [:sessions "session:session-1"] merge {:slug "vibe" :stage :s1})
                result (system/apply-mission-surface! (:pi fake) ctx)
                _ (settle)
                active (vec (sort @(:active fake)))]
          (t/to-be result true)
          (t/to-be @(:calls fake) 1)
          (same active ["ask_user" "attach_brainstorm" "clj_plan" "devops" "handoff" "review" "wait"]))))
    (t/it "keeps the default surface when the mission is completed"
      (fn []
        (p/let [root (fresh-root)
                fake (setup root)
                ctx (main-ctx root "session-1")
                _ (swap! system/state update-in [:sessions "session:session-1"] merge {:slug "vibe" :stage :completed})
                result (system/apply-mission-surface! (:pi fake) ctx)
                surface (system/surface-for {:mission? true :stage :completed})]
          (t/to-be result false)
          (t/to-be @(:calls fake) 0)
          (t/to-be surface nil)
          (same (vec @(:active fake)) ["read" "bash" "board_finish" "clj_devops" "wait"]))))
    (t/it "narrows a Plan DevOps subagent to its explicit surface"
      (fn []
        (p/let [root (fresh-root)
                fake (setup root)
                sub (sub-ctx root "D1")
                _ (system/before-agent-start!
                   #js {:prompt "[HERD_ROLE: Plan DevOps]\ninvestigate"} sub)
                _ (swap! system/state update-in [:sessions "D1"] merge {:slug "vibe" :stage :s2})
                result (system/apply-mission-surface! (:pi fake) sub)
                _ (settle)
                active (vec (sort @(:active fake)))]
          (t/to-be result true)
          (same active ["clj_devops" "handoff" "submit_devops_report" "wait"]))))
    (t/it "narrows a Swarm Worker subagent to the board tools"
      (fn []
        (p/let [root (fresh-root)
                fake (setup root)
                sub (sub-ctx root "W1")
                _ (system/before-agent-start!
                   #js {:prompt "[HERD_ROLE: Swarm Worker]\nwork"} sub)
                _ (swap! system/state update-in [:sessions "W1"] merge {:slug "vibe" :stage :s3})
                result (system/apply-mission-surface! (:pi fake) sub)
                _ (settle)
                active (vec (sort @(:active fake)))
                has-take (boolean (some (fn [tool] (= tool "board_take_or_die")) active))]
          (t/to-be result true)
          (t/to-be (count active) 14)
          (t/to-be has-take true))))
    (t/it "keeps Reviewer read-only with global wait/handoff"
      (fn []
        (p/let [root (fresh-root)
                fake (setup root)
                sub (sub-ctx root "R1")
                _ (system/before-agent-start!
                   #js {:prompt "[HERD_ROLE: Reviewer]\nreview"} sub)
                _ (swap! system/state update-in [:sessions "R1"] merge {:slug "vibe" :stage :s5})
                result (system/apply-mission-surface! (:pi fake) sub)
                _ (settle)
                active (vec (sort @(:active fake)))]
          (t/to-be result true)
          (same active ["clj_review" "handoff" "review" "wait"])
          (t/to-be (some #{"ask_user"} active) nil)
          (t/to-be (some #{"write" "edit" "bash"} active) nil))))
    (t/it "keeps the current tool surface when setActiveTools fails"
      (fn []
        (p/let [root (fresh-root)
                {:keys [pi active] :as fake} (make-pi)
                calls (atom 0)
                _ (system/reset-state!)
                _ (aset pi "setActiveTools"
                        (fn [_next]
                          (swap! calls inc)
                          (throw (js/Error. "surface unavailable"))))
                _ (system/install! pi {:root root})
                ctx (main-ctx root "session-1")
                _ (swap! system/state update-in [:sessions "session:session-1"] merge {:slug "vibe" :stage :s1})
                result (system/apply-mission-surface! pi ctx)
                _ (settle)
                active-value (vec @active)
                health (.-__herdHealth js/globalThis)]
          (t/to-be result true)
          (t/to-be @calls 1)
          (same active-value ["read" "bash" "board_finish" "clj_devops" "wait"])
          (t/to-be (.-status health) "degraded"))))))

