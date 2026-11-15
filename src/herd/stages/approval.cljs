(ns herd.stages.approval
  (:require
   ["node:crypto" :as crypto]))

(defn approval-token [mission report-sha256 key]
  (let [hmac (.createHmac crypto "sha256" key)]
    (.digest (.update hmac (str (:mission-id mission) ":" (:revision mission) ":" report-sha256)
                      "utf8")
             "hex")))