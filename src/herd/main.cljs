(ns herd.main
  (:require
   [clojure.string :as str]
   [herd.ariadne :as ariadne]
   [herd.prompts :as prompts]
   [herd.repl :as repl]
   [herd.ufss :as ufss]))

(defn- text-block [text]
  {:type "text" :text text})

(defn- tool-result [text]
  {:content [(text-block text)]})

(defn- tool-error [error]
  {:isError true
   :content [(text-block (str error))]})

(defn- byte-length [text]
  (js/Buffer.byteLength text "utf8"))

(defn- sandbox-deadline [code]
  (+ 1000 (* 50 (byte-length code))))

(defn- execute [tool-call-id params _signal]
  (let [name (.-name params)
        code (.-code params)]
    (ariadne/record-anchor! name tool-call-id)
    (-> (repl/run name code (sandbox-deadline code))
        (.then (fn [result] (clj->js (tool-result (ufss/print result)))))
        (.catch (fn [error] (clj->js (tool-error error)))))))

(defn- wait-execute [_tool-call-id params _signal]
  (let [work (.-otherwise_independent_work params)]
    (-> (repl/wait-for-result (sandbox-deadline work))
        (.then (fn [result] (clj->js (tool-result (ufss/print result)))))
        (.catch (fn [error]
                  (clj->js
                    (tool-result
                      (ufss/print {:state :waiting
                                   :reason :deadline
                                   :message (str error)}))))))))

(defn- time-leap-execute [_tool-call-id params _signal]
  (clj->js
    (tool-result
      (ufss/print (ariadne/time-leap! (js->clj params :keywordize-keys true))))))

(defn- ask-beacon-execute [_tool-call-id params _signal]
  (clj->js
    (tool-result
      (ufss/print (ariadne/ask-beacon (js->clj params :keywordize-keys true))))))

(defn- code-schema [] {:type "string"})
(defn- name-schema [] {:type "string"})
(defn- budget-schema [] {:type "integer" :minimum 1})
(defn- goal-schema [] {:type "string" :minLength 1})
(defn- workers-schema [] {:type "integer" :minimum 0})
(defn- work-schema [] {:type "string" :minLength 1})
(defn- target-schema [] {:type "string" :minLength 1})
(defn- experience-schema [] {:type "string" :minLength 1})
(defn- beacon-name-schema [] {:type "string" :minLength 1})
(defn- beacon-description-schema [] {:type "string" :minLength 1})
(defn- question-schema [] {:type "string" :minLength 1})

(defn- devops-parameters []
  {:type "object"
   :additionalProperties false
   :required ["code" "name" "ariadne_budget" "ariadne_goal"]
   :properties {:code (code-schema)
                :name (name-schema)
                :ariadne_budget (budget-schema)
                :ariadne_goal (goal-schema)
                :more_workers_without_hitting_mythical_man_month (workers-schema)}})

(defn- wait-parameters []
  {:type "object"
   :additionalProperties false
   :required ["otherwise_independent_work"]
   :properties {:otherwise_independent_work (work-schema)}})

(defn- time-leap-parameters []
  {:type "object"
   :additionalProperties false
   :required ["target" "experience" "beacon_name" "beacon_description"]
   :properties {:target (target-schema)
                :experience (experience-schema)
                :beacon_name (beacon-name-schema)
                :beacon_description (beacon-description-schema)}})

(defn- ask-beacon-parameters []
  {:type "object"
   :additionalProperties false
   :required ["target" "question"]
   :properties {:target (target-schema)
                :question (question-schema)}})

(defn- register! [definition]
  (.registerTool js/globalThis.__pi (clj->js definition)))

(defn register-all! []
  (register! {:name "clj_devops"
              :label "Clojure Sandbox (Plan DevOps)"
              :description "Evaluate ClojureScript in the current workspace."
              :parameters (devops-parameters)
              :execute execute})
  (register! {:name "wait"
              :label "Wait"
              :description "Collect the next completed sandbox program."
              :parameters (wait-parameters)
              :execute wait-execute})
  (register! {:name "time_leap"
              :label "Time Leap"
              :description "Cut back to a clean sandbox anchor."
              :parameters (time-leap-parameters)
              :execute time-leap-execute})
  (register! {:name "ask_beacon"
              :label "Ask Beacon"
              :description "Query a read-only pruned branch."
              :parameters (ask-beacon-parameters)
              :execute ask-beacon-execute}))

(def host-tool-blacklist
  #{"read" "write" "edit" "apply_patch" "ast_edit" "ast_grep"
    "bash" "exec" "eval" "glob" "grep" "find"})

(defn- apply-tool-surface! []
  (let [pi js/globalThis.__pi
        active (js->clj (.getActiveTools pi))
        kept (remove host-tool-blacklist active)]
    (.setActiveTools pi (clj->js kept))))

(defn- prompt-with-rules [prompt]
  (if (str/includes? prompt "# Repo-aware Rules")
    prompt
    (str prompt "\n\n" prompts/common-rules-text)))

(defn- before-agent-start [event _ctx]
  (try
    #js {:systemPrompt (prompt-with-rules (.-systemPrompt event))}
    (catch :default _
      #js {:systemPrompt (.-systemPrompt event)})))

(defn- message-anchor [message]
  (or (.-toolCallId message) (.-tool_call_id message)))

(defn- anchor-index [messages target]
  (let [n (.-length messages)]
    (loop [i 0]
      (if (>= i n)
        -1
        (if (= target (message-anchor (aget messages i)))
          i
          (recur (inc i)))))))

(defn- experience-message [experience]
  #js {:role "user"
       :content (str """
Time leap experience:

""" experience)})

(defn- context-handler [event _ctx]
  (let [messages (.-messages event)]
    (if-let [jump (ariadne/consume-jump!)]
      (let [target (ariadne/tool-call-id (:target jump))
            idx (anchor-index messages target)]
        (if (>= idx 0)
          #js {:messages (.concat (.slice messages (inc idx))
                                  #js [(experience-message (:experience jump))])}
          #js {:messages messages}))
      #js {:messages messages})))

(defn install-hooks! []
  (.on js/globalThis.__pi "before_agent_start" before-agent-start)
  (.on js/globalThis.__pi "context" context-handler))

(register-all!)
(install-hooks!)
(apply-tool-surface!)