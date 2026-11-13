(ns herd.repl
  (:require
   [herd.sandbox :as sandbox]
   [herd.ufss :as ufss]
   [nbb.core :as nbb]))

(defonce running (atom #{}))
(defonce programs (atom {}))

(def ^:private prelude
  (str """
(require '[herd.sandbox :refer [cat read stat ls write mkdir rm mv whereAll call]])
(require '[herd.macros :refer-macros [park unpark abandon where]])
"""
       "\n"))

(defn- timeout-error []
  (ex-info "program timed out" {:code :STALLED}))

(defn- with-deadline [promise ms]
  (js/Promise.
    (fn [resolve reject]
      (let [timer (js/setTimeout #(reject (timeout-error)) ms)]
        (.then promise
               (fn [value]
                 (js/clearTimeout timer)
                 (resolve value))
               (fn [error]
                 (js/clearTimeout timer)
                 (reject error)))))))

(defn- notifier []
  (js/Promise.
    (fn [resolve]
      (reset! sandbox/current-notifier resolve))))

(defn- source [code]
  (str prelude
       "(defn ^:async __run []"
       "\n"
       (ufss/unwrap code)
       """
)
(__run)
"""
       "\n"))

(defn- evaluate [code]
  (nbb/load-string (source code)))

(defn- parked? [value]
  (and (map? value) (= :parked (:state value))))

(defn- remember! [name entry]
  (swap! programs assoc name entry))

(defn- mark-completed! [name value]
  (remember! name {:state :completed :value value}))

(defn- mark-failed! [name error]
  (remember! name {:state :failed :error {:message (str error)}}))

(defn- mark-parked! [name value]
  (remember! name (merge value {:state :parked})))

(defn- completed-receipt [name value]
  {:name name :state :completed :value value})

(defn- parked-receipt [name value]
  (merge {:name name} value))

(defn- failed-receipt [name error]
  (mark-failed! name error)
  {:name name :state :failed :error {:message (str error)}})

(defn- receipt [name value]
  (if (parked? value)
    (do (mark-parked! name value)
        (parked-receipt name value))
    (completed-receipt name value)))

(defn- already-running! [name]
  (when (@running name)
    (throw (ex-info "program name is already running" {:code :NAME_TAKEN :name name}))))

(defn- track! [name promise]
  (remember! name {:state :running :promise promise})
  (.then promise
         #(mark-completed! name %)
         #(mark-failed! name %)))

(defn run [name code deadline-ms]
  (already-running! name)
  (swap! running conj name)
  (reset! sandbox/current-name name)
  (let [n (notifier)
        p (evaluate code)]
    (track! name p)
    (-> (with-deadline (js/Promise.race #js [p n]) (or deadline-ms 30000))
        (.then (fn [value] (receipt name value)))
        (.catch (fn [error] (failed-receipt name error)))
        (.finally (fn [] (swap! running disj name))))))

(defn- completed-entries []
  (->> @programs
       (filter (fn [[_ entry]] (= :completed (:state entry))))
       (sort-by first)))

(defn- take-completed! []
  (let [entries (completed-entries)]
    (when (seq entries)
      (swap! programs #(apply dissoc % (map first entries)))
      entries)))

(defn- running-promises []
  (->> @programs
       (keep (fn [[_ entry]] (when (= :running (:state entry)) (:promise entry))))
       vec))

(defn- idle-receipt []
  {:state :idle
   :in-flight (count (running-promises))
   :backlog 0
   :message "No sandbox tasks are running or queued."})

(defn- receipt-of [[name entry]]
  (completed-receipt name (:value entry)))

(defn- results-receipt [entries]
  (if (= 1 (count entries))
    (receipt-of (first entries))
    {:state :joined :results (mapv receipt-of entries)}))

(defn- collect-or-wait []
  (if-let [entries (take-completed!)]
    (results-receipt entries)
    (if-let [promises (seq (running-promises))]
      (-> (js/Promise.race (clj->js promises))
          (.then (fn [_] (collect-or-wait)))
          (.catch (fn [_] (collect-or-wait))))
      (idle-receipt))))

(defn wait-for-result
  ([] (wait-for-result 30000))
  ([deadline-ms]
   (with-deadline (js/Promise.resolve (collect-or-wait)) (or deadline-ms 30000))))