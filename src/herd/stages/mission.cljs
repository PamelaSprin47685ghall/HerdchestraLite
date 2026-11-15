(ns herd.stages.mission
  (:require
   [clojure.string :as string]))

(def ^:private slug-pattern #"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

(defn valid-slug? [value]
  (and (string? value)
       (boolean (re-matches slug-pattern value))
       (not (string/includes? value ".."))))

(def ^:private mission-stages
  #{:s1 :s2 :s3 :s4 :s5 :completed})

(def ^:private barrier-stages
  #{"s1" "s2" "s3" "s4" "s5"})

(def entry-types
  "Custom entry types owned by the herd schema."
  #{"herd.task" "herd.mode" "herd.seed" "herd.barrier" "herd.pending" "herd.approval"})

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

(defn validate-entry
  """
Validate one herd custom entry against schema v1.

  Unknown versions fail closed; unknown fields are ignored. The data payload
  must be a JSON object (a Clojure map after js->clj).
"""
  [custom-type data]
  (cond
    (not (contains? entry-types custom-type))
    (failure :UNKNOWN_CUSTOM_ENTRY
             "unknown herd custom entry type"
             {:custom-type custom-type})

    (not (map? data))
    (failure :INVALID_SESSION_ENTRY
             "custom entry data must be a JSON object"
             {:custom-type custom-type :reason :data-not-object})

    (not= 1 (:v data))
    (failure :UNSUPPORTED_SESSION_SCHEMA
             "the custom entry schema version is not supported"
             {:custom-type custom-type :version (:v data) :supported 1})

    (= custom-type "herd.task")
    (if (text? (:sessionId data))
      {:ok true}
      (failure :INVALID_SESSION_ENTRY
               "herd.task needs a non-empty sessionId"
               {:custom-type custom-type :field :sessionId}))

    (= custom-type "herd.mode")
    (if (contains? #{"herd" "devops"} (:mode data))
      {:ok true}
      (failure :INVALID_SESSION_ENTRY
               "herd.mode needs mode herd or devops"
               {:custom-type custom-type :field :mode}))

    (= custom-type "herd.seed")
    (if (string? (:seed data))
      {:ok true}
      (failure :INVALID_SESSION_ENTRY
               "herd.seed needs a string seed"
               {:custom-type custom-type :field :seed}))

    (= custom-type "herd.barrier")
    (if (and (contains? barrier-stages (:from data))
             (contains? barrier-stages (:to data)))
      {:ok true}
      (failure :INVALID_SESSION_ENTRY
               "herd.barrier needs from and to stages"
               {:custom-type custom-type :field :to}))

    (= custom-type "herd.pending")
    (if (or (= "cleared" (:state data))
            (and (contains? barrier-stages (:stage data))
                 (text? (:tool data))))
      {:ok true}
      (failure :INVALID_SESSION_ENTRY
               "herd.pending needs a stage and tool, or a cleared state"
               {:custom-type custom-type :field :tool}))

    :else {:ok true}))

(defn validate-mission [mission]
  (cond
    (not (map? mission))
    (failure :INVALID_ARGUMENT "mission must be an EDN map" {})

    (not (text? (:mission-id mission)))
    (failure :INVALID_ARGUMENT "mission has no mission-id" {:field :mission-id})

    (not (and (string? (:slug mission))
              (valid-slug? (:slug mission))))
    (failure :INVALID_ARGUMENT "mission has an invalid slug" {:field :slug})

    (nil? (stage-of (:stage mission)))
    (failure :STAGE_MISMATCH "mission has an unknown stage" {:stage (:stage mission)})

    (not (and (integer? (:revision mission)) (>= (:revision mission) 0)))
    (failure :STAGE_MISMATCH "mission revision must be a non-negative integer"
             {:revision (:revision mission)})

    (not (and (text? (:created-at mission)) (text? (:updated-at mission))))
    (failure :INVALID_ARGUMENT "mission timestamps are missing" {})

    (and (some? (:tenure mission))
         (not (and (map? (:tenure mission))
                   (text? (get-in mission [:tenure :tenure-id])))))
    (failure :INVALID_ARGUMENT "mission tenure is malformed" {:field :tenure})

    (and (some? (:attach mission)) (not (map? (:attach mission))))
    (failure :INVALID_ARGUMENT "mission attach must be a map" {:field :attach})

    (and (some? (:barrier mission)) (not (map? (:barrier mission))))
    (failure :INVALID_ARGUMENT "mission barrier must be a map or null" {:field :barrier})

    (= :completed (stage-of (:stage mission)))
    (let [approval (:approval mission)]
      (cond
        (not (map? approval))
        (failure :APPROVAL_REQUIRED "completed mission has no verifiable approval record"
                 {:reason :completed-without-approval})

        (and (integer? (:revision mission))
             (integer? (:revision approval))
             (not= (:revision approval) (:revision mission)))
        (failure :APPROVAL_REQUIRED "approval revision does not match the mission revision"
                 {:reason :revision
                  :expected (:revision mission)
                  :actual (:revision approval)})

        :else {:ok true}))

    :else {:ok true}))