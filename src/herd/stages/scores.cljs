(ns herd.stages.scores
  (:require
   [clojure.string :as string]))

(def ^:private case-id-pattern #"^CASE-[A-Za-z0-9_-]+$")

(def ^:private case-spec-fields
  #{:case_id :path :threshold :steps :expected :rubric})

(defn- text? [value]
  (and (string? value) (pos? (count (string/trim value)))))

(defn- rejection [code message data]
  (merge {:code code :message message} data))

(defn- invalid! [invalid data]
  (swap! invalid conj data))

(defn- validate-case-specs [case-specs invalid]
  (if-not (sequential? case-specs)
    (do
      (invalid! invalid (rejection :INVALID_ARGUMENT
                                   "case-specs must be an array"
                                   {:field :case-specs}))
      nil)
    (let [specs (atom [])
          seen (atom #{})]
      (doseq [raw case-specs]
        (cond
          (not (map? raw))
          (invalid! invalid (rejection :INVALID_ARGUMENT
                                       "each case spec must be an object"
                                       {:field :case-specs}))

          (some (fn [key] (not (case-spec-fields key))) (keys raw))
          (invalid! invalid (rejection :INVALID_ARGUMENT
                                       "case spec has unknown fields"
                                       {:field :case-specs}))

          (not (and (string? (:case_id raw))
                    (re-matches case-id-pattern (:case_id raw))))
          (invalid! invalid (rejection :INVALID_ARGUMENT
                                       "case_id must match CASE-*"
                                       {:field :case-specs}))

          (contains? @seen (:case_id raw))
          (invalid! invalid (rejection :INVALID_ARGUMENT
                                       "duplicate CASE id"
                                       {:field :case-specs :case-id (:case_id raw)}))

          (not (and (number? (:threshold raw))
                    (js/Number.isFinite (:threshold raw))
                    (<= 0 (:threshold raw) 100)))
          (invalid! invalid (rejection :INVALID_ARGUMENT
                                       "threshold must be a finite number in 0..100"
                                       {:field :case-specs}))

          (not (text? (:path raw)))
          (invalid! invalid (rejection :INVALID_ARGUMENT
                                       "path must be a non-empty string"
                                       {:field :case-specs}))

          :else
          (do
            (swap! seen conj (:case_id raw))
            (swap! specs conj {:case_id (:case_id raw)
                               :threshold (:threshold raw)
                               :path (string/trim (:path raw))}))))
      (when (empty? @specs)
        (invalid! invalid (rejection :INVALID_ARGUMENT
                                     "case-specs must contain at least one CASE"
                                     {:field :case-specs})))
      (when (empty? @invalid)
        @specs))))

(defn- read-score [case-id field value invalid]
  (cond
    (not (and (number? value) (js/Number.isFinite value)))
    (do
      (invalid! invalid (rejection :AUDIT_INVALID_SCORE
                                   (str case-id ": " (name field) " is not a finite number")
                                   {:case-id case-id :field field}))
      nil)

    (not (<= 0 value 100))
    (do
      (invalid! invalid (rejection :AUDIT_INVALID_SCORE
                                   (str case-id ": " (name field) " is outside 0..100")
                                   {:case-id case-id :field field}))
      nil)

    :else value))

(defn aggregate [request]
  (let [invalid (atom [])
        specs (validate-case-specs (:case-specs request) invalid)
        submissions (if (sequential? (:submissions request)) (:submissions request) [])
        rows (atom [])
        missing (atom [])
        unknown (atom [])]
    (when-not (sequential? (:submissions request))
      (invalid! invalid (rejection :INVALID_ARGUMENT
                                   "submissions must be an array"
                                   {:field :submissions})))
    (doseq [submission submissions]
      (cond
        (not (map? submission))
        (invalid! invalid (rejection :INVALID_ARGUMENT
                                     "submission must be an object"
                                     {:field :submissions}))

        (not (text? (:case_id submission)))
        (invalid! invalid (rejection :INVALID_ARGUMENT
                                     "submission.case_id must be a non-empty string"
                                     {:field :case_id}))

        (not (some (fn [spec] (= (:case_id spec) (:case_id submission))) specs))
        (do
          (swap! unknown conj (:case_id submission))
          (invalid! invalid (rejection :AUDIT_UNKNOWN_CASE
                                       (str (:case_id submission) ": no such CASE in the S2 dataset")
                                       {:case-id (:case_id submission)})))

        :else nil))
    (doseq [spec specs]
      (let [entries (filter (fn [submission] (= (:case_id submission) (:case_id spec))) submissions)]
        (if (not= 1 (count entries))
          (do
            (swap! missing conj (:case_id spec))
            (invalid! invalid (rejection :AUDIT_MISSING
                                         (str (:case_id spec) ": exactly one submission is required")
                                         {:case-id (:case_id spec)}))
            (swap! rows conj {:case-id (:case_id spec)
                              :path (:path spec)
                              :threshold (:threshold spec)
                              :user-score nil
                              :developer-score nil
                              :score nil
                              :valid false
                              :passed false
                              :report-markdown nil}))
          (let [entry (first entries)
                user-score (read-score (:case_id spec) :user_score (:user_score entry) invalid)
                developer-score (read-score (:case_id spec) :developer_score (:developer_score entry) invalid)
                report (if (string? (:report_markdown entry)) (:report_markdown entry) "")
                valid? (and (some? user-score)
                            (some? developer-score)
                            (text? report))
                score (when (and (some? user-score) (some? developer-score))
                        (min user-score developer-score))]
            (when-not (text? report)
              (invalid! invalid (rejection :AUDIT_MISSING
                                           (str (:case_id spec) ": report_markdown must be a non-empty string")
                                           {:case-id (:case_id spec) :field :report_markdown})))
            (swap! rows conj {:case-id (:case_id spec)
                              :path (:path spec)
                              :threshold (:threshold spec)
                              :user-score user-score
                              :developer-score developer-score
                              :score score
                              :valid valid?
                              :passed (and valid? (>= score (:threshold spec)))
                              :report-markdown (when (text? report) report)})))))
    (let [rejected? (or (seq @invalid) (seq @missing) (seq @unknown))
          all-passed? (and (seq @rows) (every? :passed @rows))
          verdict (cond rejected? :INCOMPLETE all-passed? :PASS :else :FAIL)]
      {:ok (= verdict :PASS)
       :verdict verdict
       :rows @rows
       :case-ids (mapv :case-id @rows)
       :missing @missing
       :unknown @unknown
       :invalid @invalid
       :rejected rejected?
       :retry-required rejected?})))