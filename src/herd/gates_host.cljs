(ns herd.gates-host
  (:require
   [herd.stages.gates :as gates]
   [herd.ufss :as ufss]))

(defn- tool-failure [error]
  {:isError true
   :content [{:type "text"
              :text (ufss/canonical {:ok false
                                     :error {:code :INTERNAL
                                             :message (or (ex-message error) (str error))}})}]})

(defn- bridge-execute [execute]
  (fn [tool-call-id params signal on-update ctx]
    (try
      (-> (js/Promise.resolve (execute tool-call-id params signal on-update ctx))
          (.then (fn [value] (clj->js value))))
      (catch :default error
        (clj->js (tool-failure error))))))

(defn- to-js-definition [definition]
  #js {:name (:name definition)
       :label (:label definition)
       :description (:description definition)
       :loadMode (:load-mode definition)
       :parameters (clj->js (:parameters definition))
       :execute (bridge-execute (:execute definition))})

(defn register! [pi deps]
  (when-not (and pi (instance? js/Function (.-registerTool pi)))
    (throw (ex-info "host extension API lacks registerTool"
                    {:code :HOST_API_MISMATCH})))
  (gates/register-all!
    (fn [definition]
      (.registerTool pi (to-js-definition definition)))
    deps))