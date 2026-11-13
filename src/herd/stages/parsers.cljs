(ns herd.stages.parsers
  (:require
   [clojure.string :as string]))

(def ^:private case-id-pattern #"^CASE-[A-Za-z0-9_-]+$")
(def ^:private required-s2-paths ["正常" "错误" "边界" "并发" "恢复"])
(def ^:private case-spec-fields
  #{:case_id :path :threshold :steps :expected :rubric})

(def ^:private s1-sections
  [{:key :goal
    :title "一句话目标与用户可见结果"
    :keywords ["一句话目标" "用户可见结果" "目标与用户" "目标"]
    :exclude ["非目标" "non-goal" "non goal" "不做"]}
   {:key :decision-framework
    :title "决策框架"
    :keywords ["决策框架"]}
   {:key :current-state
    :title "现状事实与根因"
    :keywords ["现状" "根因"]}
   {:key :doors
    :title "单向门/双向门"
    :keywords ["单向门" "双向门" "one-way" "two-way"]}
   {:key :pre-mortem
    :title "事前验尸"
    :keywords ["事前验尸" "pre-mortem" "premortem" "pre mortem"]}
   {:key :non-goals
    :title "Non-Goals"
    :keywords ["non-goals" "non goals" "非目标" "out of scope"]}
   {:key :success
    :title "成功标准"
    :keywords ["成功标准" "完成标准" "什么叫完成" "definition of done"]}
   {:key :open-questions
    :title "未决问题"
    :keywords ["未决问题" "开放问题" "open questions"]}])

(defn- invalid [message extra]
  (merge {:code :INVALID_ARGUMENT :message message} extra))

(defn- failure [errors extra]
  (merge {:ok false :errors errors} extra))

(defn- success [extra]
  (merge {:ok true :errors []} extra))

(defn- text? [value]
  (and (string? value) (pos? (count (string/trim value)))))

(defn- map-entry? [value]
  (map? value))

(defn- lower-all [keywords]
  (mapv string/lower-case keywords))

(defn- scan-markdown [markdown]
  (let [lines (string/split markdown #"\r?\n")
        headings (atom [])
        prose (atom [])
        fence (atom nil)]
    (doseq [[index raw] (map-indexed vector lines)]
      (if-let [current @fence]
        (when-let [closing (re-matches #" {0,3}(`{3,}|~{3,})[ \t]*" raw)]
          (let [marker (second closing)]
            (when (and (= (first marker) (first current))
                       (>= (count marker) (count current)))
              (reset! fence nil))))
        (if-let [opening (re-matches #" {0,3}(`{3,}|~{3,}).*" raw)]
          (reset! fence (second opening))
          (do
            (swap! prose conj {:text raw :line (inc index)})
            (when-let [heading (re-matches #" {0,3}(#{1,6})[ \t]+(.*)" raw)]
              (let [text (-> (nth heading 2)
                             string/trim
                             (string/replace #"[ \t]+#+[ \t]*$" ""))]
                (when (pos? (count text))
                  (swap! headings conj {:level (count (nth heading 1))
                                        :text text
                                        :line (inc index)}))))))))
    {:headings @headings :prose @prose}))

(defn- find-heading [scan keywords exclude]
  (let [lowered (lower-all keywords)
        blocked (lower-all exclude)]
    (some (fn [heading]
            (let [text (string/lower-case (:text heading))]
              (when (and (some #(string/includes? text %) lowered)
                         (not-any? #(string/includes? text %) blocked))
                heading)))
          (:headings scan))))

(defn validate-s1 [markdown]
  (if-not (text? markdown)
    (failure [(invalid "s1 markdown must be a non-empty string" {:field :markdown})] nil)
    (let [scan (scan-markdown markdown)
          sections (atom [])
          missing (atom [])
          errors (atom [])]
      (doseq [section s1-sections]
        (if-let [heading (find-heading scan (:keywords section) (:exclude section))]
          (swap! sections conj {:key (:key section)
                                :title (:title section)
                                :line (:line heading)})
          (do
            (swap! missing conj {:key (:key section)
                                 :title (:title section)
                                 :required true})
            (swap! errors conj
                   (invalid (str "s1 markdown: missing section " (:title section)
                                 " (a heading must contain one of: "
                                 (string/join ", " (:keywords section)) ")")
                            {:field :markdown :section (:key section)})))))
      (if (empty? @errors)
        (success {:sections @sections :missing @missing})
        (failure @errors {:sections @sections :missing @missing})))))

(defn- case-error [message extra]
  (invalid message (merge {:code :CASE_SCHEMA_INVALID} extra)))

(defn- normalize-one [entry index seen errors]
  (if-not (map-entry? entry)
    (do
      (swap! errors conj
             (case-error (str "cases[" index "] must be an object")
                         {:field (str "cases[" index "]") :index index}))
      nil)
    (do
      (doseq [key (keys entry)]
        (when-not (case-spec-fields key)
          (swap! errors conj
                 (case-error (str "cases[" index "]." (name key) " is not an allowed CASE field")
                             {:field (str "cases[" index "]." (name key)) :index index}))))
      (let [case-id (:case_id entry)
            valid (atom true)
            duplicate (atom false)]
        (cond
          (not (and (string? case-id) (re-matches case-id-pattern case-id)))
          (do (swap! errors conj
                     (case-error (str "cases[" index "].case_id must match " case-id-pattern)
                                 {:field (str "cases[" index "].case_id") :index index}))
              (reset! valid false))

          (contains? @seen case-id)
          (do (swap! errors conj
                     (case-error (str "cases[" index "].case_id " case-id " is duplicated")
                                 {:field (str "cases[" index "].case_id")
                                  :index index
                                  :case_id case-id
                                  :code :CASE_DUPLICATE_ID}))
              (reset! valid false))

          :else
          (swap! seen conj case-id))
        (when-not (text? (:path entry))
          (swap! errors conj
                 (case-error (str "cases[" index "].path must be a non-empty string")
                             {:field (str "cases[" index "].path") :index index}))
          (reset! valid false))
        (let [threshold (:threshold entry)]
          (when-not (and (number? threshold)
                         (js/Number.isFinite threshold)
                         (<= 0 threshold 100))
            (swap! errors conj
                   (case-error (str "cases[" index "].threshold must be a finite number in 0..100")
                               {:field (str "cases[" index "].threshold")
                                :index index
                                :code :CASE_THRESHOLD_INVALID}))
            (reset! valid false)))
        (let [steps (:steps entry)]
          (when-not (and (sequential? steps)
                         (pos? (count steps))
                         (every? text? steps))
            (swap! errors conj
                   (case-error (str "cases[" index "].steps must be a non-empty array of non-empty strings")
                               {:field (str "cases[" index "].steps") :index index}))
            (reset! valid false)))
        (when-not (text? (:expected entry))
          (swap! errors conj
                 (case-error (str "cases[" index "].expected must be a non-empty string")
                             {:field (str "cases[" index "].expected") :index index}))
          (reset! valid false))
        (when-not (text? (:rubric entry))
          (swap! errors conj
                 (case-error (str "cases[" index "].rubric must be a non-empty string")
                             {:field (str "cases[" index "].rubric") :index index}))
          (reset! valid false))
        (when @valid
          {:case_id case-id
           :path (string/trim (:path entry))
           :threshold (:threshold entry)
           :steps (vec (:steps entry))
           :expected (:expected entry)
           :rubric (:rubric entry)})))))

(defn normalize-case-specs [cases]
  (if-not (and (sequential? cases) (pos? (count cases)))
    (failure [(case-error "cases must be a non-empty array" {:field :cases})] nil)
    (let [errors (atom [])
          seen (atom #{})
          normalized (atom [])]
      (doseq [[index entry] (map-indexed vector cases)]
        (when-let [value (normalize-one entry index seen errors)]
          (swap! normalized conj value)))
      (when (pos? (count @normalized))
        (let [paths (set (map :path @normalized))
              missing (remove paths required-s2-paths)]
          (when (seq missing)
            (swap! errors conj
                   (case-error (str "cases[].path must cover the five category labels: "
                                     (string/join ", " required-s2-paths)
                                     "; missing: " (string/join ", " missing))
                               {:field "cases[].path"
                                :code :CASE_REQUIRED_PATH_MISSING
                                :required required-s2-paths
                                :missing (vec missing)
                                :received (vec paths)
                                :next (str "add at least one CASE with path exactly one of: "
                                           (string/join ", " missing)
                                           "; path is a category label, not a filesystem path")})))))
      (if (empty? @errors)
        (success {:cases @normalized})
        (failure @errors nil)))))

(defn validate-s2 [markdown cases]
  (let [errors (atom [])
        normalized (normalize-case-specs cases)]
    (when-not (text? markdown)
      (swap! errors conj
             (case-error "markdown must be a non-empty methodology narrative"
                         {:field :markdown})))
    (when-not (:ok normalized)
      (swap! errors into (:errors normalized)))
    (if (empty? @errors)
      (success {:cases (:cases normalized)})
      (failure @errors nil))))

(defn validate-s3 [markdown]
  (if-not (text? markdown)
    (failure [(invalid "s3 markdown must be a non-empty string" {:field :markdown})] nil)
    (success nil)))

(defn validate-s4 [markdown promela]
  (let [errors (atom [])]
    (when-not (text? markdown)
      (swap! errors conj (invalid "s4 markdown must be a non-empty string" {:field :markdown})))
    (when-not (text? promela)
      (swap! errors conj (invalid "s4 promela must be a non-empty string" {:field :promela})))
    (if (empty? @errors)
      (success nil)
      (failure @errors nil))))