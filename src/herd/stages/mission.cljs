(ns herd.stages.mission
  (:require
   [clojure.string :as string]))

(def ^:private slug-pattern #"^[a-z0-9][a-z0-9-]{0,63}$")

(def ^:private mission-stages
  #{:s1 :s2 :s3 :s4 :s5 :completed})

(defn- text? [value]
  (and (string? value) (pos? (count (string/trim value)))))

(defn- stage-of [value]
  (let [text (cond
               (keyword? value) (string/lower-case (name value))
               (string? value) (string/lower-case (string/trim value))
               :else nil)
        stage (when text (keyword text))]
    (when (contains? mission-stages stage) stage)))

(defn- failure [code message data]
  {:ok false :error (merge {:code code :message message} data)})

(defn validate-mission [mission]
  (cond
    (not (map? mission))
    (failure :INVALID_ARGUMENT "mission must be an EDN map" {})

    (not (text? (:mission-id mission)))
    (failure :INVALID_ARGUMENT "mission.edn has no mission-id" {:field :mission-id})

    (not (and (string? (:slug mission))
              (re-matches slug-pattern (:slug mission))))
    (failure :INVALID_ARGUMENT "mission.edn has an invalid slug" {:field :slug})

    (nil? (stage-of (:stage mission)))
    (failure :STAGE_MISMATCH "mission.edn has an unknown stage" {:stage (:stage mission)})

    (not (and (integer? (:revision mission)) (>= (:revision mission) 0)))
    (failure :STAGE_MISMATCH "mission.edn revision must be a non-negative integer"
             {:revision (:revision mission)})

    (not (and (text? (:created-at mission)) (text? (:updated-at mission))))
    (failure :INVALID_ARGUMENT "mission.edn timestamps are missing" {})

    (and (some? (:tenure mission))
         (not (and (map? (:tenure mission))
                   (text? (get-in mission [:tenure :tenure-id])))))
    (failure :INVALID_ARGUMENT "mission.edn tenure is malformed" {:field :tenure})

    (and (some? (:attach mission)) (not (map? (:attach mission))))
    (failure :INVALID_ARGUMENT "mission.edn attach must be a map" {:field :attach})

    (and (some? (:barrier mission)) (not (map? (:barrier mission))))
    (failure :INVALID_ARGUMENT "mission.edn barrier must be a map or null" {:field :barrier})

    (= :completed (stage-of (:stage mission)))
    (let [approval (:approval mission)]
      (cond
        (not (map? approval))
        (failure :APPROVAL_REQUIRED "completed mission has no verifiable approval record"
                 {:reason :completed-without-approval})

        (not= (:revision approval) (:revision mission))
        (failure :APPROVAL_REQUIRED "approval revision does not match the mission revision"
                 {:reason :revision
                  :expected (:revision mission)
                  :actual (:revision approval)})

        :else {:ok true}))

    (some? (:approval mission))
    (failure :APPROVAL_REQUIRED "mission holds an approval before completion"
             {:reason :approval-before-completion})

    :else {:ok true}))