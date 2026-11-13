(ns herd.stages.tenure
  (:require
   [clojure.string :as string]))

(def ^:private attach-tools
  {:s1 :attach_brainstorm
   :s2 :attach_manual_tests
   :s3 :attach_dev_guide
   :s4 :attach_coordination})

(defn- text? [value]
  (and (string? value) (pos? (count (string/trim value)))))

(defn normalize-stage [value]
  (let [text (cond
               (keyword? value) (string/lower-case (name value))
               (string? value) (string/lower-case (string/trim value))
               :else nil)]
    (case text
      "s1" :s1
      "s2" :s2
      "s3" :s3
      "s4" :s4
      "s5" :s5
      nil)))

(defn next-stage [stage]
  (case stage
    :s1 :s2
    :s2 :s3
    :s3 :s4
    :s4 :s5
    nil))

(defn- invalid [message data]
  {:ok false
   :error (merge {:code :INVALID_ARGUMENT :message message} data)})

(defn- failed [code message data]
  {:ok false
   :error (merge {:code code :message message} data)})

(defn- tenure-id-of [mission board]
  (let [id (or (:tenure-id board) (:tenure-id mission))]
    (when (text? id) (string/trim id))))

(defn- sequence-of [mission board]
  (let [explicit (if (integer? (:tenure-seq mission)) (:tenure-seq mission) 0)
        id (or (tenure-id-of mission board) "")
        parsed (if-let [match (re-find #"\d+$" id)] (js/parseInt match 10) 0)]
    (max explicit parsed 0)))

(defn empty-board [tenure-id]
  (when-not (text? tenure-id)
    (throw (ex-info "empty-board: tenure-id must be a non-empty string"
                    {:code :INVALID_ARGUMENT})))
  {:board-version 0
   :tenure-id (string/trim tenure-id)
   :review-summary nil
   :tasks {}
   :attach-ready false})

(defn board-is-empty? [board]
  (and (map? board)
       (map? (:tasks board))
       (empty? (:tasks board))))

(defn attach-tool-for-stage [stage]
  (get attach-tools (normalize-stage stage)))

(defn- apply-finding [tasks index finding]
  (if-not (map? finding)
    {:ok false :error {:code :INVALID_ARGUMENT
                       :message (str "findings[" index "] must be an object")
                       :field :findings :index index}}
    (let [key (if (text? (:key finding)) (string/trim (:key finding)) "")]
      (if (= key "")
        {:ok false :error {:code :INVALID_ARGUMENT
                           :message (str "findings[" index "].key must be a non-empty string")
                           :field :findings :index index}}
        (let [value (:value finding)]
          (cond
            (nil? value)
            {:ok true :tasks (dissoc tasks key)}

            (and (sequential? value) (empty? value))
            {:ok true :tasks tasks}

            (string? value)
            (if-not (text? value)
              {:ok false :error {:code :INVALID_ARGUMENT
                                 :message (str "findings[" index "].value must not be blank")
                                 :field :findings :index index}}
              (let [previous (if (map? (get tasks key)) (get tasks key) {})]
                {:ok true :tasks (assoc tasks key (assoc previous :value (string/trim value)))}))

            (map? value)
            {:ok true :tasks (assoc tasks key value)}

            :else
            {:ok false :error {:code :INVALID_ARGUMENT
                               :message (str "findings[" index "].value must be a string, an object, nil, or []")
                               :field :findings :index index}}))))))

(defn apply-review [board review]
  (if-not (and (map? board) (map? (:tasks board)))
    (invalid "board must be a map with a tasks map" {:field :board})
    (let [findings (or (:findings review) [])]
      (if-not (sequential? findings)
        (invalid "findings must be an array" {:field :findings})
        (let [result (loop [index 0
                            tasks (:tasks board)]
                       (if (>= index (count findings))
                         {:ok true :tasks tasks}
                         (let [next (apply-finding tasks index (nth findings index))]
                           (if (:ok next)
                             (recur (inc index) (:tasks next))
                             next))))]
          (if-not (:ok result)
            result
            (let [tasks (:tasks result)
                  summary (if (contains? review :summary_markdown)
                            (let [value (:summary_markdown review)]
                              (cond
                                (nil? value) nil
                                (text? value) (string/trim value)
                                :else :invalid-summary))
                            (if (string? (:review-summary board)) (:review-summary board) nil))]
              (if (= summary :invalid-summary)
                (invalid "summary_markdown must be a non-empty string or nil"
                         {:field :summary_markdown})
                (let [open (count tasks)
                      ready? (zero? open)
                      stage (normalize-stage (or (:stage review) (:stage board)))]
                  {:ok true
                   :board (assoc board
                                 :board-version (inc (if (integer? (:board-version board))
                                                       (:board-version board)
                                                       0))
                                 :review-summary summary
                                 :tasks tasks
                                 :attach-ready ready?)
                   :status (if ready? :review-quiescent :review-open)
                   :open-tasks open
                   :attach-ready ready?
                   :expected-attach (when stage (attach-tool-for-stage stage))})))))))))

(defn evaluate-attach [request]
  (let [mission (:mission request)
        board (:board request)
        tool (:tool request)
        stage (normalize-stage (or (:stage request) (:stage mission)))]
    (cond
      (or (nil? stage) (= stage :s5))
      (failed :ATTACH_STAGE_MISMATCH
              "attach needs one Plan stage: s1, s2, s3, or s4"
              {:stage (:stage request)})

      (not= tool (attach-tool-for-stage stage))
      (failed :ATTACH_STAGE_MISMATCH
              (str "stage " (name stage) " requires " (name (attach-tool-for-stage stage)))
              {:stage stage
               :expected (attach-tool-for-stage stage)
               :tool tool})

      (and mission (some? (normalize-stage (:stage mission)))
           (not= (normalize-stage (:stage mission)) stage))
      (failed :ATTACH_STAGE_MISMATCH
              (str "mission is at " (name (normalize-stage (:stage mission))) ", not " (name stage))
              {:stage stage :mission-stage (normalize-stage (:stage mission))})

      (not (board-is-empty? board))
      (failed :REVIEW_LEDGER_NOT_EMPTY
              "review findings are still open"
              {:open-tasks (if (map? (:tasks board)) (count (:tasks board)) nil)})

      (not (true? (:attach-ready board)))
      (failed :ATTACH_NOT_READY
              "an empty review must quiesce the board before attach"
              {:stage stage})

      :else
      {:ok true
       :tool (attach-tool-for-stage stage)
       :stage stage
       :status :attach-ready
       :summary (:review-summary board)})))

(defn archive-board-path [tenure-id]
  (when-not (text? tenure-id)
    (throw (ex-info "archive-board-path: tenure-id must be a non-empty string"
                    {:code :INVALID_ARGUMENT})))
  (str ".herd/boards/" (string/trim tenure-id) ".edn"))

(defn successor-tenure-id [mission board]
  (str "T-" (inc (sequence-of mission board))))

(defn build-barrier [request]
  (let [mission (:mission request)
        board (:board request)
        tool (:tool request)
        from (normalize-stage (or (:stage request) (:stage mission)))]
    (when (or (nil? from) (= from :s5))
      (throw (ex-info "build-barrier: stage must be s1, s2, s3, or s4"
                      {:code :INVALID_ARGUMENT})))
    (let [tenure-id (tenure-id-of mission board)]
      (when (nil? tenure-id)
        (throw (ex-info "build-barrier: mission or board needs a tenure id"
                        {:code :INVALID_ARGUMENT})))
      {:from from
       :to (next-stage from)
       :retired-tenure tenure-id
       :successor-tenure (successor-tenure-id mission board)
       :board-archive (archive-board-path tenure-id)
       :review-summary (:review-summary board)
       :attach-tool (or tool (attach-tool-for-stage from))
       :at (:now request)})))

(defn build-successor-mission [request]
  (let [mission (:mission request)
        tool (:tool request)
        from (normalize-stage (or (:stage request) (:stage mission)))]
    (when (or (nil? from) (= from :s5))
      (throw (ex-info "build-successor-mission: stage must be s1, s2, s3, or s4"
                      {:code :INVALID_ARGUMENT})))
    (let [to (next-stage from)
          successor-id (successor-tenure-id mission (:board mission))
          timestamp (or (:now request) (:updated-at mission))]
      (assoc mission
             :stage to
             :tenure-id successor-id
             :tenure-seq (inc (sequence-of mission (:board mission)))
             :created-at timestamp
             :updated-at timestamp
             :board (assoc (empty-board successor-id) :attach-ready false)
             :attach-ready false
             :attach-tool (when-not (= to :s5) (attach-tool-for-stage to))
             :attached-tool tool))))