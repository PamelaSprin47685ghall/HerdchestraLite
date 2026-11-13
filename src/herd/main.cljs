(ns herd.main
  (:require [nbb.core :as nbb]
            [herd.repl :as repl]
            [herd.ufss :as ufss]))

(defn- tool-result [text]
  #js {:content #js [#js {:type "text" :text text}]})

(defn- tool-error [error]
  #js {:isError true
       :content #js [#js {:type "text" :text (str error)}]})

(defn- execute [_tool-call-id params _signal]
  (let [name (.-name params)
        code (.-code params)]
    (try
      (-> (repl/run name code)
          (.then (fn [result] (tool-result (ufss/print result))))
          (.catch tool-error))
      (catch :default error
        (tool-error error)))))

(defn register! []
  (.registerTool js/globalThis.__pi
                 #js {:name "clj_devops"
                      :label "Clojure Sandbox (Plan DevOps)"
                      :description "Evaluate ClojureScript in the current workspace."
                      :parameters #js {:type "object"
                                       :additionalProperties false
                                       :required #js ["code" "name" "ariadne_budget" "ariadne_goal"]
                                       :properties #js {:code #js {:type "string"}
                                                        :name #js {:type "string"}
                                                        :ariadne_budget #js {:type "integer" :minimum 1}
                                                        :ariadne_goal #js {:type "string" :minLength 1}
                                                        :more_workers_without_hitting_mythical_man_month #js {:type "integer" :minimum 0}}}
                      :execute execute}))

(register!)
