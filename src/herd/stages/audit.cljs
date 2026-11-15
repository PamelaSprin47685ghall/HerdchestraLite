(ns herd.stages.audit
  (:require
   ["node:crypto" :as crypto]
   ["node:fs/promises" :as fs]
   ["node:os" :as os]
   ["node:path" :as path]
   [clojure.string :as string]
   [herd.stages.mission :as mission]
   [herd.ufss :as ufss]
   [herd.util.atomic-write :as atomic]))

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

(defn- submission-dir [root slug]
  (let [resolved (path/resolve (or root "."))
        key (.digest (.update (.createHash crypto "sha256") (str resolved "|" (or slug ""))) "hex")]
    (path/join (.tmpdir os) "herd-audit-submissions" (subs key 0 24))))

(defn- submission-path [root slug case-id]
  (path/join (submission-dir root slug) (str case-id ".edn")))

(defn- ^:async read-disk-submission [root slug case-id]
  (try
    (let [text (await (.readFile fs (submission-path root slug case-id) "utf8"))
          parsed (ufss/read text)]
      (when (complete-submission? parsed)
        (select-keys parsed [:case_id :user_score :developer_score :report_markdown])))
    (catch :default _ nil)))

(defn ^:async clear-submissions! [root slug]
  (swap! submissions
         (fn [current]
           (into {}
                 (remove (fn [[[r s _] _]]
                           (and (= r (or root "")) (= s (or slug "")))))
                 current)))
  (when (and (text? root) (mission/valid-slug? slug))
    (try
      (await (.rm fs (submission-dir root slug) #js {:recursive true :force true}))
      (catch :default _ nil)))
  true)

(defn reset-submissions! [root slug]
  (swap! submissions
         (fn [current]
           (into {}
                 (remove (fn [[[r s _] _]]
                           (and (= r (or root "")) (= s (or slug "")))))
                 current)))
  (when (and (text? root) (mission/valid-slug? slug))
    (-> (.rm fs (submission-dir root slug) #js {:recursive true :force true})
        (.catch (fn [_] nil))))
  nil)

(defn ^:async write-submission-once! [root slug case-id submission _options]
  (cond
    (not (and (text? root) (mission/valid-slug? slug)))
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
    (let [key (entry-key root slug case-id)
          existing-disk (await (read-disk-submission root slug case-id))]
      (if (or (contains? @submissions key) (some? existing-disk))
        {:ok false
         :code :AUDIT_DUPLICATE_CASE
         :message (str case-id ": a submission already exists in this audit batch")}
        (let [record (select-keys submission [:case_id :user_score :developer_score :report_markdown])]
          (swap! submissions assoc key record)
          (try
            (await (atomic/write-edn-atomic! (submission-path root slug case-id) record))
            (catch :default _ nil))
          {:ok true :memory true})))))

(defn ^:async read-submission [root slug case-id _options]
  (cond
    (not (and (text? root) (mission/valid-slug? slug)))
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
    (let [stored (or (get @submissions (entry-key root slug case-id))
                     (await (read-disk-submission root slug case-id)))]
      (if stored
        (if (complete-submission? stored)
          {:ok true :submission stored :memory true}
          {:ok false
           :error {:code :AUDIT_MISSING
                   :message (str case-id ": in-memory submission is incomplete")
                   :case-id case-id}})
        {:ok false
         :error {:code :AUDIT_MISSING
                 :message (str case-id ": no in-memory submission in this batch")
                 :case-id case-id}}))))