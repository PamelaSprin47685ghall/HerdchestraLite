(ns cljs.subagent-entry-test
  (:require
   [clojure.string :as str]
   [herd.entry :as entry]
   [herd.test :as t]
   [promesa.core :as p]))

(defn- reset-globals! []
  (set! (.-__herdTaskId js/globalThis) "session-1")
  (set! (.-__herdSubagentBindings js/globalThis) #js {}))

(defn- install-runner! []
  (let [calls (atom [])]
    (set! (.-__herdNativeTools js/globalThis)
          #js {:available (fn [_name _context] true)
               :invoke
               (fn [name params _options _context]
                 (swap! calls conj [name params])
                 (js/Promise.resolve #js {:agentId "child-1"
                                          :result "done"}))})
    calls))

(defn- ok [result] (aget result "ok"))
(defn- code [result] (aget result "code"))

(t/describe "subagent entry boundary"
  (fn []
    (t/it "calls the host task tool with a role token and binds the parent session"
      (fn []
        (reset-globals!)
        (let [calls (install-runner!)]
          (p/let [result (entry/run-subagent
                           #js {:role "Plan DevOps"
                                :prompt "inspect the parser"
                                :tools #js ["clj_devops"]})
                  [tool-name params] (first @calls)
                  prompt (aget params "prompt")
                  bindings (.-__herdSubagentBindings js/globalThis)
                  binding-key (aget (js/Object.keys bindings) 0)]
            (t/to-be (ok result) true)
            (t/to-be (aget result "role") "Plan DevOps")
            (t/to-be (aget result "agentId") "child-1")
            (t/to-be tool-name "task")
            (t/to-be (aget params "agent") "task")
            (t/to-be (str/includes? prompt "[HERD_ROLE: Plan DevOps nonce=") true)
            (t/to-be (str/includes? prompt "Mission slug:") false)
            (t/to-be (aget bindings binding-key) "session-1")))))
    (t/it "fails closed for unknown roles, missing task ids, and empty prompts"
      (fn []
        (reset-globals!)
        (install-runner!)
        (p/let [unknown (entry/run-subagent
                          #js {:role "Unknown" :prompt "x" :tools #js ["clj_devops"]})
                _ (set! (.-__herdTaskId js/globalThis) js/undefined)
                missing-task (entry/run-subagent
                               #js {:role "Plan DevOps" :prompt "x" :tools #js ["clj_devops"]})
                _ (set! (.-__herdTaskId js/globalThis) "session-1")
                empty (entry/run-subagent
                        #js {:role "Plan DevOps" :prompt "" :tools #js ["clj_devops"]})]
          (t/to-be (ok unknown) false)
          (t/to-be (code unknown) ":CAPABILITY_DENIED")
          (t/to-be (ok missing-task) false)
          (t/to-be (code missing-task) ":HOST_API_MISMATCH")
          (t/to-be (ok empty) false)
          (t/to-be (code empty) ":INVALID_ARGUMENT"))))
    (t/it "does not write a Mission slug or a second task identity"
      (fn []
        (reset-globals!)
        (let [calls (install-runner!)]
          (p/let [result (entry/run-subagent
                           #js {:role "Reviewer" :prompt "review" :tools #js ["review"]})
                  [tool-name params] (first @calls)]
            (t/to-be (ok result) true)
            (t/to-be tool-name "task")
            (t/to-be (str/includes? (aget params "prompt") "Mission slug:") false)
            (t/to-be (str/includes? (aget params "description") "Herdchestra") true)))))
    (t/it "propagates signal and returns ok false on subagent failure"
      (fn []
        (reset-globals!)
        (let [calls (atom [])
              abort-ctrl (js/AbortController.)]
          (set! (.-__herdNativeTools js/globalThis)
                #js {:available (fn [_name _context] true)
                     :invoke
                     (fn [name params options _context]
                       (swap! calls conj [name params options])
                       (js/Promise.resolve #js {:agentId "child-err"
                                                :details #js {:results #js [#js {:error "model_quota_exceeded"}]}}))})
          (p/let [result (entry/run-subagent
                           #js {:role "Plan DevOps"
                                :prompt "inspect"
                                :signal (.-signal abort-ctrl)
                                :tools #js ["clj_devops"]})
                  [_tool-name _params options] (first @calls)]
            (t/to-be (ok result) false)
            (t/to-be (aget result "error") "model_quota_exceeded")
            (t/to-be (identical? (aget options "signal") (.-signal abort-ctrl)) true)))))))