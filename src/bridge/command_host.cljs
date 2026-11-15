(ns bridge.command-host
  (:require
   [clojure.string :as str]
   [promesa.core :as p]))

(def ^:private backends #{"tui" "print" "rpc" "acp" "subagent"})

(defn- field [outcome key]
  (cond
    (nil? outcome) nil
    (map? outcome) (get outcome key)
    :else (aget outcome (name key))))

(defn normalize-command-result [command backend outcome]
  (let [normalized-backend (if (contains? backends backend) backend "print")
        consumed (field outcome :consumed)]
    #js {:command command
         :backend normalized-backend
         :mode (field outcome :mode)
         :status (or (field outcome :status) "ok")
         :consumed (not (false? consumed))
         :prompt (field outcome :prompt)
         :output (field outcome :output)
         :ui (if (= normalized-backend "tui")
               (or (field outcome :ui) "present")
               (or (field outcome :ui) "none"))
         :missing_deps (or (field outcome :missing_deps)
                           (field outcome :missingDeps)
                           #js [])
         :error (field outcome :error)}))

(defn- run [dispatch command backend input runtime]
  (if-not (fn? dispatch)
    (normalize-command-result command backend
                              #js {:status "error" :error "no-dispatch"})
    (-> (try
          (js/Promise.resolve
           (dispatch #js {:command command
                          :backend backend
                          :input input
                          :runtime runtime}))
          (catch :default error
            (js/Promise.reject error)))
        (.then (fn [outcome]
                 (normalize-command-result command backend outcome)))
        (.catch (fn [error]
                  (normalize-command-result command backend
                                            #js {:status "error"
                                                 :error (str error)}))))))

(defn create-command-host [options]
  (let [dispatch (when options (.-dispatch options))]
    #js {:handle (fn [command input runtime]
                   (run dispatch command "print" input runtime))
         :handleTui (fn [command input ctx]
                      (run dispatch command "tui" input ctx))
         :handleBackend (fn [command backend input runtime]
                          (run dispatch command backend input runtime))}))

(defn handoff! [ctx markdown]
  (let [manager (when ctx (.-sessionManager ctx))
        entries (when (and manager (fn? (.-getEntries manager)))
                  (array-seq (.getEntries manager)))
        last-entry (last entries)
        first-kept (or (when last-entry (.-id last-entry)) "")
        text (str markdown)
        short (first (str/split-lines text))
        committed (boolean
                    (when (and manager (fn? (.-appendCompaction manager)))
                      (.appendCompaction manager text short first-kept 0 #js {:fromExtension true})))]
    #js {:ok true :status "handoff-requested" :committed committed}))
