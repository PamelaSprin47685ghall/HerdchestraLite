(ns herd.ariadne)

(defonce anchors (atom {}))
(defonce beacons (atom {}))
(defonce pending-jump (atom nil))

(defn record-anchor! [name tool-call-id]
  (swap! anchors assoc name tool-call-id))

(defn beacon! [name description]
  (swap! beacons assoc name description))

(defn tool-call-id [name]
  (get @anchors name))

(defn time-leap! [{:keys [target experience beacon_name beacon_description]}]
  (when-not (contains? @anchors target)
    (throw (ex-info "unknown ariadne target"
                    {:code :STALE_CONTROL :target target})))
  (when (contains? @beacons beacon_name)
    (throw (ex-info "beacon name is already taken"
                    {:code :NAME_TAKEN :name beacon_name})))
  (when beacon_name
    (beacon! beacon_name beacon_description))
  (reset! pending-jump {:target target :experience experience})
  {:state :leaped
   :target target
   :experience experience
   :beacon beacon_name})

(defn ask-beacon [{:keys [target question]}]
  (let [description (get @beacons target)]
    (if description
      {:state :beacon :target target :question question :description description}
      (throw (ex-info "unknown beacon" {:code :INVALID_ARGUMENT :target target})))))

(defn consume-jump! []
  (let [jump @pending-jump]
    (reset! pending-jump nil)
    jump))