(ns herd.ariadne
  (:require
   [clojure.string :as string]))

(defonce state (atom {:anchors {} :beacons {} :pending {}}))

(defn record-anchor! [session name tool-call-id]
  (swap! state update-in [session :anchors] assoc name tool-call-id))

(defn beacon! [session name description experience]
  (swap! state update-in [session :beacons] assoc name
         {:description description :experience experience}))

(defn tool-call-id [session name]
  (get-in @state [session :anchors name]))

(defn time-leap! [session {:keys [target experience beacon_name beacon_description]}]
  (when-not (and (string? target) (pos? (count (string/trim target))))
    (throw (ex-info "target must be a non-empty string"
                    {:code :INVALID_ARGUMENT :field :target})))
  (when (and (some? beacon_name)
             (not (and (string? beacon_name) (pos? (count (string/trim beacon_name))))))
    (throw (ex-info "beacon_name must be a non-empty string"
                    {:code :INVALID_ARGUMENT :field :beacon_name})))
  (when-not (contains? (get-in @state [session :anchors]) target)
    (throw (ex-info "unknown ariadne target" {:code :STALE_CONTROL :target target})))
  (when (and beacon_name (contains? (get-in @state [session :beacons]) beacon_name))
    (throw (ex-info "beacon name is already taken" {:code :NAME_TAKEN :name beacon_name})))
  (when beacon_name
    (beacon! session beacon_name beacon_description experience))
  (swap! state assoc-in [session :pending] {:target target :experience experience})
  {:state :leaped :target target :experience experience :beacon beacon_name})

(defn ask-beacon [session {:keys [target question]}]
  (when-not (and (string? target) (pos? (count (string/trim target))))
    (throw (ex-info "target must be a non-empty string"
                    {:code :INVALID_ARGUMENT :field :target})))
  (let [beacon (get-in @state [session :beacons target])]
    (if beacon
      {:state :beacon
       :target target
       :question question
       :description (:description beacon)
       :experience (:experience beacon)}
      (throw (ex-info "unknown beacon" {:code :INVALID_ARGUMENT :target target})))))

(defn consume-jump! [session]
  (let [jump (get-in @state [session :pending])]
    (swap! state assoc-in [session :pending] nil)
    jump))