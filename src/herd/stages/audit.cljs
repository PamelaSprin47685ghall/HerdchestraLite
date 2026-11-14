(ns herd.stages.audit
  (:require
   ["node:fs/promises" :as fs]
   ["node:path" :as path]
   [clojure.string :as string]
   [herd.ufss :as ufss]))

(def ^:private slug-pattern #"^[a-z0-9][a-z0-9-]{0,63}$")
(def ^:private case-id-pattern #"^CASE-[A-Za-z0-9_-]+$")

(defn- text? [value]
  (and (string? value) (pos? (count (string/trim value)))))

(defn- finite-score? [value]
  (and (number? value)
       (js/Number.isFinite value)
       (<= 0 value 100)))

(defn- base-directory [root slug options]
  (let [directory (:directory options)]
    (cond
      (text? directory) (path/resolve directory)
      (and (text? root) (string? slug) (re-matches slug-pattern slug))
      (path/join (path/resolve root) ".herd" "missions" slug "audit")
      :else nil)))

(defn- complete-submission? [submission]
  (and (map? submission)
       (text? (:case_id submission))
       (finite-score? (:user_score submission))
       (finite-score? (:developer_score submission))
       (text? (:report_markdown submission))))

(defn ^:async write-submission-once! [root slug case-id submission options]
  (let [base (base-directory root slug options)]
    (cond
      (nil? base)
      {:ok false
       :code :INVALID_ARGUMENT
       :message "submission writer needs a valid root/slug or directory"}

      (not (and (string? case-id) (re-matches case-id-pattern case-id)))
      {:ok false
       :code :INVALID_ARGUMENT
       :message "submission writer needs a valid CASE id"}

      (not (complete-submission? submission))
      {:ok false
       :code :INVALID_ARGUMENT
       :message "submission writer needs the complete audit fields"}

      (not= (:case_id submission) case-id)
      {:ok false
       :code :AUDIT_UNKNOWN_CASE
       :message (str case-id ": submission names another CASE")}

      :else
      (let [target (path/join base (str case-id ".submit.edn"))
            text (str (ufss/canonical {:case-id case-id
                                       :user-score (:user_score submission)
                                       :developer-score (:developer_score submission)
                                       :report-markdown (:report_markdown submission)})
                      "\n")
            handle (atom nil)]
        (try
          (await (.mkdir fs (path/dirname target) #js {:recursive true}))
          (reset! handle (await (.open fs target "wx" 384)))
          (await (.writeFile @handle text "utf8"))
          (await (.sync @handle))
          (await (.close @handle))
          (reset! handle nil)
          {:ok true :path target}
          (catch :default error
            (when @handle
              (try (await (.close @handle)) (catch :default _ nil))
              (reset! handle nil))
            (if (= "EEXIST" (.-code error))
              {:ok false
               :code :AUDIT_DUPLICATE_CASE
               :path target
               :message (str case-id ": a submission already exists in this audit batch")}
              (do
                (try (await (.rm fs target #js {:force true})) (catch :default _ nil))
                {:ok false
                 :code :INTERNAL
                 :path target
                 :message (str error)}))))))))

(defn ^:async read-submission [root slug case-id options]
  (let [base (base-directory root slug options)]
    (cond
      (nil? base)
      {:ok false
       :error {:code :INVALID_ARGUMENT
               :message "submission reader needs a valid root/slug or directory"
               :field :root-slug}}

      (not (and (string? case-id) (re-matches case-id-pattern case-id)))
      {:ok false
       :error {:code :INVALID_ARGUMENT
               :message "submission reader needs a valid CASE id"
               :field :case_id}}

      :else
      (let [target (path/join base (str case-id ".submit.edn"))]
        (try
          (let [parsed (ufss/read (await (.readFile fs target "utf8")))
                stored-case (or (:case-id parsed) (:case_id parsed))]
            (cond
              (not (map? parsed))
              {:ok false
               :error {:code :AUDIT_MISSING
                       :message (str case-id ": durable submission is not an EDN map")
                       :case-id case-id
                       :path target}}

              (not= stored-case case-id)
              {:ok false
               :error {:code :AUDIT_UNKNOWN_CASE
                       :message (str case-id ": durable submission names another CASE")
                       :case-id case-id
                       :submitted-case-id stored-case
                       :path target}}

              :else
              (let [submission {:case_id stored-case
                                :user_score (or (:user-score parsed) (:user_score parsed))
                                :developer_score (or (:developer-score parsed) (:developer_score parsed))
                                :report_markdown (or (:report-markdown parsed) (:report_markdown parsed))}]
                (if (complete-submission? submission)
                  {:ok true :submission submission :path target}
                  {:ok false
                   :error {:code :AUDIT_MISSING
                           :message (str case-id ": durable submission is not a complete audit object")
                           :case-id case-id
                           :path target}}))))
          (catch :default error
            {:ok false
             :error {:code :AUDIT_MISSING
                     :message (str case-id ": durable submission cannot be read: " (str error))
                     :case-id case-id
                     :path target
                     :cause (str error)}}))))))