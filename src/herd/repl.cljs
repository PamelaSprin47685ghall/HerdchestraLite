(ns herd.repl
  (:require [nbb.core :as nbb]
            [herd.sandbox :as sandbox]
            [herd.ufss :as ufss]))

(defonce running (atom #{}))

(def ^:private prelude
  (str "(require '[herd.sandbox :refer [cat read stat ls write mkdir rm mv where whereAll call]])\n"
       "(require '[herd.macros :refer-macros [park unpark abandon]])\n"))

(defn- with-timeout [promise ms]
  (js/Promise.
   (fn [resolve reject]
     (let [timer (js/setTimeout
                  #(reject (ex-info "program timed out" {:code :STALLED}))
                  ms)]
       (.then promise
              (fn [value]
                (js/clearTimeout timer)
                (resolve value))
              (fn [error]
                (js/clearTimeout timer)
                (reject error)))))))

(defn run [name code]
  (when (@running name)
    (throw (ex-info "program name is already running" {:code :NAME_TAKEN :name name})))
  (swap! running conj name)
  (reset! sandbox/current-name name)
  (let [promise (nbb/load-string (str prelude (ufss/unwrap code)))]
    (-> (with-timeout promise 30000)
        (.then (fn [value] {:name name :state :completed :value value}))
        (.catch (fn [error] {:name name :state :failed :error {:message (str error)}}))
        (.finally (fn [] (swap! running disj name))))))
