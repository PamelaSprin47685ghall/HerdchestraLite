(ns herd.main
  (:require
   [clojure.string :as str]
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

(defn- execute [_tool-call-id params _signal]
  (let [name (.-name params)
        code (.-code params)]
    (-> (repl/run name code)
        (.then (fn [result] (clj->js (tool-result (ufss/print result)))))
        (.catch (fn [error] (clj->js (tool-error error)))))))

(defn- wait-execute [_tool-call-id _params _signal]
  (-> (js/Promise.resolve (repl/wait-for-result))
      (.then (fn [result] (clj->js (tool-result (ufss/print result)))))))

(defn- code-schema [] {:type "string"})
(defn- name-schema [] {:type "string"})
(defn- budget-schema [] {:type "integer" :minimum 1})
(defn- goal-schema [] {:type "string" :minLength 1})
(defn- workers-schema [] {:type "integer" :minimum 0})
(defn- work-schema [] {:type "string" :minLength 1})

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
              :execute wait-execute}))

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

(defn install-hooks! []
  (.on js/globalThis.__pi "before_agent_start" before-agent-start))

(register-all!)
(install-hooks!)
(apply-tool-surface!)