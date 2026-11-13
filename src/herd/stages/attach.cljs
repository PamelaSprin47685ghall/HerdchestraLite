(ns herd.stages.attach
  (:require
   ["node:path" :as path]
   [herd.stages.parsers :as parsers]
   [herd.stages.paths :as paths]
   [herd.stages.store :as store]
   [herd.stages.tenure :as tenure]
   [herd.util.atomic-write :as atomic]))

(defn- stage-for-tool [tool]
  (case tool
    :attach_manual_tests :s2
    :attach_dev_guide :s3
    :attach_coordination :s4
    nil))

(defn- validate-document [stage request]
  (case stage
    :s2 (parsers/validate-s2 (:markdown request) (:cases request))
    :s3 (parsers/validate-s3 (:markdown request))
    :s4 (parsers/validate-s4 (:markdown request) (:promela request))
    {:ok false
     :errors [{:code :INVALID_ARGUMENT :message "unsupported attach stage"}]}))

(defn- ^:async write-document! [root slug stage validated request]
  (let [plans-dir (path/join root "plans" slug)]
    (case stage
      :s2
      (do
        (await (atomic/write-file-atomic! plans-dir "s2-manual-tests.md" (:markdown request)))
        (await (atomic/write-edn-atomic! (path/join root (paths/s2-cases-path slug))
                                         (:cases validated)))
        {:markdown (str "plans/" slug "/s2-manual-tests.md")
         :cases (paths/s2-cases-path slug)})

      :s3
      (do
        (await (atomic/write-file-atomic! plans-dir "s3-dev-guide.md" (:markdown request)))
        {:markdown (str "plans/" slug "/s3-dev-guide.md")})

      :s4
      (do
        (await (atomic/write-file-atomic! plans-dir "s4-coordination.md" (:markdown request)))
        (await (atomic/write-file-atomic! plans-dir "s4-coordination.pml" (:promela request)))
        {:markdown (str "plans/" slug "/s4-coordination.md")
         :promela (str "plans/" slug "/s4-coordination.pml")}))))
(defn ^:async commit-attach! [root slug tool request]
  (when-not (stage-for-tool tool)
    (throw (ex-info "S1 attach requires the confirmation panel"
                    {:code :APPROVAL_REQUIRED :tool tool})))
  (let [current (await (store/read-mission root slug))]
    (if-not (:ok current)
      current
      (let [mission (:mission current)
            stage (stage-for-tool tool)
            board (or (await (store/read-board root slug))
                      (tenure/empty-board (:tenure-id mission)))
            gate (tenure/evaluate-attach {:mission mission
                                          :board board
                                          :tool tool
                                          :stage stage})]
        (if-not (:ok gate)
          gate
          (let [validated (validate-document stage request)]
            (if-not (:ok validated)
              validated
              (let [documents (await (write-document! root slug stage validated request))
                    barrier (tenure/build-barrier {:mission mission
                                                   :board board
                                                   :tool tool
                                                   :stage stage
                                                   :now (:now request)})
                    successor (tenure/build-successor-mission {:mission mission
                                                               :tool tool
                                                               :stage stage
                                                               :now (:now request)})]
                (await (store/archive-board! root slug (:tenure-id mission) board))
                (await (store/write-board! root slug (:board successor)))
                (let [patch {:stage (:stage successor)
                             :tenure (:tenure successor)
                             :tenure-id (:tenure-id successor)
                             :tenure-seq (:tenure-seq successor)
                             :created-at (:created-at successor)
                             :updated-at (:updated-at successor)
                             :barrier barrier
                             :attach-ready (:attach-ready successor)
                             :attach-tool (:attach-tool successor)
                             :attached-tool (:attached-tool successor)}
                      updated (await (store/update-mission! root slug patch))]
                  (if-not (:ok updated)
                    updated
                    {:ok true
                     :documents documents
                     :barrier barrier
                     :successor (:mission updated)}))))))))))