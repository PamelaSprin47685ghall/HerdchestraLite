(ns herd.stages.audit
  (:require
   [clojure.string :as string]))

(def ^:private case-id-pattern #"^CASE-[A-Za-z0-9_-]+$")
(defonce ^:private submissions (atom {}))

(defn- text? [value]
  (and (string? value) (pos? (count (string/trim value)))))

(defn- finite-score? [value]
  (and (number? value)
       (js/Number.isFinite value)
       (<= 0 value 100)))

(defn- complete-submission? [submission]
  (and (map? submission)
       (text? (:case_id submission))
       (finite-score? (:user_score submission))
       (finite-score? (:developer_score submission))
       (text? (:report_markdown submission))))

(defn- entry-key [root slug case-id]
  [(or root "") (or slug "") case-id])

(defn reset-submissions! [root slug]
  (swap! submissions
         (fn [current]
           (into {}
                 (remove (fn [[[r s _] _]]
                           (and (= r (or root "")) (= s (or slug ""))))
                         current)))))

(defn ^:async write-submission-once! [root slug case-id submission _options]
  (cond
    (not (and (text? root) (string? slug) (re-matches #"^[a-z0-9][a-z0-9-]{0,63}$" slug)))
    {:ok false
     :code :INVALID_ARGUMENT
     :message "submission writer needs a valid root and slug"}

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
    (let [key (entry-key root slug case-id)]
      (if (contains? @submissions key)
        {:ok false
         :code :AUDIT_DUPLICATE_CASE
         :message (str case-id ": a submission already exists in this audit batch")}
        (do
          (swap! submissions assoc key (select-keys submission [:case_id :user_score :developer_score :report_markdown]))
          {:ok true :memory true})))))

(defn ^:async read-submission [root slug case-id _options]
  (cond
    (not (and (text? root) (string? slug) (re-matches #"^[a-z0-9][a-z0-9-]{0,63}$" slug)))
    {:ok false
     :error {:code :INVALID_ARGUMENT
             :message "submission reader needs a valid root and slug"
             :field :root-slug}}

    (not (and (string? case-id) (re-matches case-id-pattern case-id)))
    {:ok false
     :error {:code :INVALID_ARGUMENT
             :message "submission reader needs a valid CASE id"
             :field :case_id}}

    :else
    (if-let [stored (get @submissions (entry-key root slug case-id))]
      (if (complete-submission? stored)
        {:ok true :submission stored :memory true}
        {:ok false
         :error {:code :AUDIT_MISSING
                 :message (str case-id ": in-memory submission is incomplete")
                 :case-id case-id}})
      {:ok false
       :error {:code :AUDIT_MISSING
               :message (str case-id ": no in-memory submission in this batch")
               :case-id case-id}})))