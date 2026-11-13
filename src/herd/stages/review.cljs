(ns herd.stages.review
  (:require
   [herd.stages.store :as store]
   [herd.stages.tenure :as tenure]))

(defn ^:async review! [root slug request]
  (let [current (await (store/read-mission root slug))]
    (if-not (:ok current)
      current
      (let [mission (:mission current)
            board (or (await (store/read-board root slug))
                      (tenure/empty-board (get-in mission [:tenure :tenure-id])))
            result (tenure/apply-review board request)]
        (if-not (:ok result)
          result
          (do
            (await (store/write-board! root slug (:board result)))
            (await (store/update-mission! root slug
                                          {:attach {:ready (:attach-ready result)
                                                    :expected-attach (:expected-attach result)}}))
            result))))))