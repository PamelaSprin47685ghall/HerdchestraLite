(ns cljs.system-install-test
  (:require
   [clojure.string :as str]
   [herd.system :as system]
   [herd.test :as t]
   [promesa.core :as p]))

(def fs ((.-__herdRequire js/globalThis) "node:fs/promises"))
(def os ((.-__herdRequire js/globalThis) "node:os"))
(def path ((.-__herdRequire js/globalThis) "node:path"))

(defn- make-counting-pi []
  (let [tools (atom [])
        commands (atom [])
        hooks (atom [])
        active (atom ["read" "bash"])
        fail-next (atom 0)
        pi #js {}]
    (aset pi "registerTool"
          (fn [definition]
            (if (pos? @fail-next)
              (do (swap! fail-next dec)
                  (throw (js/Error. "registerTool failed")))
              (swap! tools conj (.-name definition)))))
    (aset pi "registerCommand" (fn [name _spec] (swap! commands conj name)))
    (aset pi "on" (fn [name _handler] (swap! hooks conj name)))
    (aset pi "getActiveTools" (fn [] (clj->js @active)))
    (aset pi "setActiveTools"
          (fn [next]
            (reset! active (vec (js->clj next)))
            (js/Promise.resolve nil)))
    (aset pi "sendUserMessage" (fn [& _] nil))
    (aset pi "__tools" tools)
    (aset pi "__commands" commands)
    (aset pi "__hooks" hooks)
    (aset pi "__active" active)
    (aset pi "__failNext" fail-next)
    pi))

(defn- main-ctx [root id]
  #js {:cwd root
       :hasUI false
       :mode "print"
       :sessionManager #js {:getSessionId (fn [] id)}})

(defn- fresh-root []
  (.mkdtemp fs (.join path (.tmpdir os) "cljs-system-install-")))

(t/describe "per-pi system installation"
  (fn []
    (t/it "registers the full tool, command, and hook surface for every pi"
      (fn []
        (p/let [root (fresh-root)]
          (let [pi1 (make-counting-pi)
                pi2 (make-counting-pi)
                _ (system/reset-state!)
                first (system/install! pi1 {:root root})
                second (system/install! pi2 {:root root})
                tools1 (vec (sort @(aget pi1 "__tools")))
                tools2 (vec (sort @(aget pi2 "__tools")))]
            (t/to-be first true)
            (t/to-be second true)
            (t/to-be (count tools1) 20)
            (t/to-equal tools2 tools1)
            (t/to-be (some #{"attach_case_audit"} tools1) "attach_case_audit")
            (t/to-be (some #{"review"} tools1) "review")
            (doseq [name ["board_cancel" "board_claim" "board_comment" "board_finish"
                          "board_park_slot" "board_release" "board_reopen" "board_replace"
                          "board_split" "board_take_or_die" "board_update"]]
              (t/to-be (some #{name} tools1) name))
            (t/to-be (count (filter #(str/starts-with? % "board_") tools1)) 11)
            (t/to-equal @(aget pi1 "__commands") ["herd"])
            (t/to-equal @(aget pi2 "__commands") ["herd"])
            (t/to-equal (sort @(aget pi1 "__hooks")) ["agent_end" "tool_execution_end"])
            (t/to-equal (sort @(aget pi2 "__hooks")) ["agent_end" "tool_execution_end"])
            (t/to-be (:installed-count @system/state) 2)))))
    (t/it "returns false for the same pi without registering twice"
      (fn []
        (p/let [root (fresh-root)]
          (let [pi (make-counting-pi)
                _ (system/reset-state!)
                first (system/install! pi {:root root})
                after-first {:tools (count @(aget pi "__tools"))
                             :commands (count @(aget pi "__commands"))
                             :hooks (count @(aget pi "__hooks"))}
                second (system/install! pi {:root root})]
            (t/to-be first true)
            (t/to-be second false)
            (t/to-equal after-first {:tools 20 :commands 1 :hooks 2})
            (t/to-be (:installed-count @system/state) 1)))))
    (t/it "does not mark a pi whose registration threw and retries the missing work"
      (fn []
        (p/let [root (fresh-root)]
          (let [pi (make-counting-pi)
                _ (system/reset-state!)
                _ (reset! (aget pi "__failNext") 1)
                first (system/install! pi {:root root})
                after-first {:tools (count @(aget pi "__tools"))
                             :commands (count @(aget pi "__commands"))
                             :hooks (count @(aget pi "__hooks"))}
                health (mapv :entry (:health @system/state))
                second (system/install! pi {:root root})
                after-second {:tools (count @(aget pi "__tools"))
                              :commands (count @(aget pi "__commands"))
                              :hooks (count @(aget pi "__hooks"))}
                third (system/install! pi {:root root})]
            (t/to-be first false)
            (t/to-be second true)
            (t/to-be third false)
            (t/to-equal after-first {:tools 0 :commands 0 :hooks 0})
            (t/to-equal after-second {:tools 20 :commands 1 :hooks 2})
            (t/to-be (some #{"system.install"} health) "system.install")
            (t/to-be (:installed-count @system/state) 1)))))
    (t/it "keeps apply-mission-surface session state isolated by session key"
      (fn []
        (p/let [root (fresh-root)]
          (let [pi (make-counting-pi)
                _ (system/reset-state!)
                _ (system/install! pi {:root root})
                ctx-a (main-ctx root "A")
                ctx-b (main-ctx root "B")
                _ (swap! system/state assoc-in [:sessions "session:A"]
                         {:role-token {:role "Reviewer"} :slug "alpha" :stage :s3})
                a-first (system/apply-mission-surface! pi ctx-a)
                b-unfocused (system/apply-mission-surface! pi ctx-b)
                _ (swap! system/state assoc-in [:sessions "session:B"]
                         {:role-token {:role "Plan DevOps"} :slug "beta" :stage :s2})
                b-focused (system/apply-mission-surface! pi ctx-b)]
            (t/to-be a-first true)
            (t/to-be b-unfocused false)
            (t/to-be b-focused true)
            (t/to-be (get-in @system/state [:sessions "session:A" :role-token :role]) "Reviewer")
            (t/to-be (get-in @system/state [:sessions "session:A" :slug]) "alpha")
            (t/to-be (get-in @system/state [:sessions "session:B" :role-token :role]) "Plan DevOps")
            (t/to-be (get-in @system/state [:sessions "session:B" :slug]) "beta")))))))
