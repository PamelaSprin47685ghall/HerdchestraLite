(ns herd.stages.paths
  (:require
   [clojure.string :as string]))

(def stage-ids [:s1 :s2 :s3 :s4])

(def mission-stages [:s1 :s2 :s3 :s4 :s5 :completed])

(def stage-documents
  {:s1 "s1-brainstorm.md"
   :s2 "s2-manual-tests.md"
   :s3 "s3-dev-guide.md"
   :s4 "s4-coordination.md"
   :s4-promela "s4-coordination.pml"})

(defn normalize-stage [value]
  (let [text (cond
               (keyword? value) (string/lower-case (name value))
               (string? value) (string/lower-case (string/trim value))
               :else nil)]
    (when (some #(= text (name %)) stage-ids)
      (keyword text))))

(defn normalize-document-stage [value]
  (let [text (cond
               (keyword? value) (string/lower-case (name value))
               (string? value) (string/lower-case (string/trim value))
               :else nil)]
    (when (some #(= text (name %)) (keys stage-documents))
      (keyword text))))

(defn stage-document-path [slug stage]
  (let [id (normalize-document-stage stage)]
    (when-not id
      (throw (ex-info "unknown stage document"
                      {:code :INVALID_ARGUMENT :stage stage})))
    (str "plans/" slug "/" (get stage-documents id))))

(defn s2-cases-path [slug]
  (str ".herd/missions/" slug "/s2-cases.edn"))

(defn mission-path-of [slug]
  (str ".herd/missions/" slug "/mission.edn"))