(ns herd.stages.approval
  (:require
   ["node:crypto" :as crypto]
   [clojure.string :as string]))

(def ^:private hex-pattern #"^[0-9a-f]{64}$")

(defn- text? [value]
  (and (string? value) (pos? (count (string/trim value)))))

(defn normalize-approval [approval]
  (when (and (map? approval)
             (integer? (:revision approval))
             (>= (:revision approval) 0)
             (text? (:report-sha256 approval))
             (re-matches hex-pattern (:report-sha256 approval))
             (text? (:token approval)))
    {:revision (:revision approval)
     :report-sha256 (:report-sha256 approval)
     :token (:token approval)}))

(defn approval-token [mission report-sha256 key]
  (let [hmac (.createHmac crypto "sha256" key)]
    (.digest (.update hmac (str (:mission-id mission) ":" (:revision mission) ":" report-sha256)
                      "utf8")
             "hex")))

(defn verify-approval-token [mission approval key]
  (let [normalized (normalize-approval approval)]
    (and normalized
         (= (:revision normalized) (:revision mission))
         (= (:token normalized)
            (approval-token mission (:report-sha256 normalized) key)))))