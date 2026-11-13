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

(defn- normalized-error [error]
  (let [data (ex-data error)
        message (str error)]
    (merge data
           {:code (or (:code data)
                      (when (str/includes? message "Could not resolve symbol")
                        :CAPABILITY_DENIED)
                      :INTERNAL)
            :message message})))

(defn- tool-error [error]
  {:isError true
   :content [(text-block (ufss/print (normalized-error error)))]})

(defn- byte-length [text]
  (js/Buffer.byteLength text "utf8"))

(defn- sandbox-deadline [code]
  (+ 1000 (* 50 (byte-length code))))

(defonce receipts (atom {}))

(defn- digest [params]
  (pr-str (js->clj params :keywordize-keys true)))

(defn- replay-mismatch []
  (ex-info "the same call id arrived with a different payload"
           {:code :CALL_REPLAY_MISMATCH}))

(defn- error-text [error]
  (ufss/print (normalized-error error)))

(defn- receipt-response [cached]
  (if (:error? cached)
    {:isError true
     :content [(text-block (:text cached))]}
    (tool-result (:text cached))))

(defn- execute [tool-call-id params _signal]
  (let [request-digest (digest params)]
    (if-let [cached (and tool-call-id (@receipts tool-call-id))]
      (if (= request-digest (:digest cached))
        (clj->js (receipt-response cached))
        (clj->js (tool-error (replay-mismatch))))
      (let [name (.-name params)
            code (.-code params)]
        (ariadne/record-anchor! name tool-call-id)
        (-> (repl/run name code (sandbox-deadline code))
            (.then (fn [result]
                     (let [text (ufss/print result)]
                       (when tool-call-id
                         (swap! receipts assoc tool-call-id
                                {:digest request-digest :text text :error? false}))
                       (clj->js (tool-result text)))))
            (.catch (fn [error]
                      (let [text (error-text error)]
                        (when tool-call-id
                          (swap! receipts assoc tool-call-id
                                 {:digest request-digest :text text :error? true}))
                        (clj->js {:isError true
                                  :content [(text-block text)]})))))))))
(defn- wait-execute
  [_tool-call-id params _signal]
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

(defn- ask-beacon-execute [_tool-call-id params _signal _on-update ctx]
  (let [request (js->clj params :keywordize-keys true)
        beacon (ariadne/ask-beacon request)
        prompt (str """
You are querying a read-only pruned branch (beacon).

"""
                    "Beacon: " (:target request) "\n"
                    """
Description:

""" (:description beacon) "\n\n"
                    """
Question:

""" (:question request) "\n\n"
                    "Answer only from the beacon description and general reasoning. "
                    "Never claim access to files, tools, or the old conversation.")]
    (if-let [turn (and ctx (.-runEphemeralTurn ctx))]
      (-> (.runEphemeralTurn ctx #js {:promptText prompt :tools false})
          (.then (fn [result]
                   (clj->js
                     (tool-result
                       (ufss/print (assoc beacon :answer (.-replyText result)))))))
          (.catch (fn [error]
                    (clj->js
                      (tool-result
                        (ufss/print (assoc beacon
                                           :answer nil
                                           :degraded (str error))))))))
      (clj->js
        (tool-result
          (ufss/print (assoc beacon
                             :answer nil
                             :degraded "runEphemeralTurn is unavailable in this host")))))))
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

(def ^:private herd-tools
  ["clj_devops" "wait" "time_leap" "ask_beacon"])

(defn- ignore-rejection [value]
  (when (and value (fn? (.-catch value)))
    (.catch value (fn [_] nil))))

(defn- apply-tool-surface! []
  (try
    (let [pi js/globalThis.__pi
          active (js->clj (.getActiveTools pi))
          kept (->> active
                    (remove host-tool-blacklist)
                    (concat herd-tools)
                    distinct
                    vec)]
      (ignore-rejection (.setActiveTools pi (clj->js kept))))
    (catch :default _ nil)))

(defn- prompt-with-rules [prompt]
  (if (str/includes? prompt "# Repo-aware Rules")
    prompt
    (str prompt "\n\n" prompts/common-rules-text)))

(defn- before-agent-start [event _ctx]
  (apply-tool-surface!)
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
  (.on js/globalThis.__pi "session_start"
       (fn [_event _ctx] (apply-tool-surface!)))
  (.on js/globalThis.__pi "context" context-handler))

(register-all!)
(install-hooks!)