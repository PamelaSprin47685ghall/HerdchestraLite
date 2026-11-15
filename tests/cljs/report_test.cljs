(ns cljs.report-test
  (:require
   [clojure.string :as str]
   [herd.stages.audit :as audit]
   [herd.stages.report :as report]
   [herd.stages.scores :as scores]
   [herd.test :as t]
   [promesa.core :as p]))

(def fs ((.-__herdRequire js/globalThis) "node:fs"))
(def os ((.-__herdRequire js/globalThis) "node:os"))
(def path ((.-__herdRequire js/globalThis) "node:path"))
(def crypto ((.-__herdRequire js/globalThis) "node:crypto"))

(defn- temp-root []
  (.mkdtempSync fs (.join path (.tmpdir os) "cljs-report-")))

(defn- aggregate [threshold]
  (scores/aggregate
   {:case-specs [{:case_id "CASE-A"
                  :path "docs/a.md"
                  :threshold threshold
                  :steps ["step"]
                  :expected "expected"
                  :rubric "rubric"}]
    :submissions [{:case_id "CASE-A"
                   :user_score 90
                   :developer_score 85
                   :report_markdown "在真实界面观察到的结果。"}]
    :contract {:mission-id "M1" :revision 0}
    :snapshot-before {:files [{:path "docs/a.md" :sha256 "abc" :stamp {}}]
                      :digest "d"}
    :snapshot-after {:files [{:path "docs/a.md" :sha256 "abc" :stamp {}}]
                     :digest "d"}
    :audit {:environment "tmux"}}))

(defn- normalized [value]
  (str/replace (str value) #"^:" ""))

(t/describe "CLJS s5 report"
  (fn []
    (t/it "writes the PASS report and requests one approval"
      (fn []
        (let [root (temp-root)
              requests (atom [])
              port {:issue (fn [request]
                             (swap! requests conj request)
                             {:ok true
                              :approval {:revision (:revision request)
                                         :report-sha256 (:report-sha256 request)
                                         :token "test-token"}})}
              result (aggregate 80)]
          (p/let [written (report/write-report! root "demo" result {:approval-port port})]
            (let [outcome (:outcome written)
                  markdown (.readFileSync fs (:path outcome) "utf8")]
              (t/to-be (:verdict result) "PASS")
              (t/to-be (:ok outcome) true)
              (t/to-be (:completed outcome) false)
              (t/to-be (:path outcome) (.join path root "herd" "demo" "s5-report.md"))
              (t/to-contain markdown "| CASE-A | docs/a.md | 90 | 85 | 85 | 80 | PASS |")
              (t/to-be (:sha256 outcome)
                       (.digest (.update (.createHash crypto "sha256") markdown "utf8") "hex"))
              (t/to-be (count @requests) 1)
              (let [request (first @requests)]
                (t/to-be (:mission-id request) "M1")
                (t/to-be (:revision request) 0)
                (t/to-be (:verdict request) "PASS")
                (t/to-be (:case-count request) 1)
                (t/to-be (:report-sha256 request) (:sha256 outcome))
                (t/to-be (:recheck request) nil)
                (t/to-be (get-in outcome [:approval :token]) "test-token")))))))
    (t/it "returns APPROVAL_REQUIRED when no approval port is injected"
      (fn []
        (let [root (temp-root)
              result (aggregate 80)]
          (p/let [written (report/write-report! root "demo" result {})]
            (t/to-be (:ok written) false)
            (t/to-be (normalized (:code written)) "APPROVAL_REQUIRED")
            (t/to-be (.existsSync fs (.join path root "herd" "demo" "s5-report.md")) true)))))
    (t/it "blocks approval when the recheck throws"
      (fn []
        (let [root (temp-root)
              requests (atom [])
              port {:issue (fn [request]
                             (swap! requests conj request)
                             {:ok true
                              :approval {:revision 0 :report-sha256 "x" :token "t"}})}
              result (aggregate 80)]
          (p/let [written (report/write-report! root "demo" result
                                                {:approval-port port
                                                 :recheck-port (fn [_]
                                                                 (throw (ex-info "workspace changed" {})))})]
            (t/to-be (:ok (:outcome written)) false)
            (t/to-be (normalized (:code (:outcome written))) "APPROVAL_REQUIRED")
            (t/to-be (:ok (:recheck (:outcome written))) false)
            (t/to-be (count @requests) 0)))))
    (t/it "passes a successful recheck through to approval"
      (fn []
        (let [root (temp-root)
              seen (atom nil)
              port {:issue (fn [_]
                             {:ok true
                              :approval {:revision 0 :report-sha256 "x" :token "t"}})}
              result (aggregate 80)]
          (p/let [written (report/write-report! root "demo" result
                                                {:approval-port port
                                                 :recheck-port (fn [check]
                                                                 (reset! seen (:report-sha256 check))
                                                                 {:ok true})})]
            (t/to-be (:ok written) true)
            (t/to-be (:ok (:recheck written)) true)
            (t/to-be (:mission-id (:recheck written)) "M1")
            (t/to-be @seen (:report-sha256 (:recheck written)))))))
    (t/it "refuses to write a report for a non-PASS aggregate"
      (fn []
        (let [root (temp-root)
              port {:issue (fn [_]
                             {:ok true
                              :approval {:token "t" :revision 0 :report-sha256 "x"}})}
              result (aggregate 95)]
          (p/let [written (report/write-report! root "demo" result {:approval-port port})]
            (t/to-be (:ok written) false)
            (t/to-be (normalized (:code written)) "APPROVAL_REQUIRED")
            (t/to-be (.existsSync fs (.join path root "herd" "demo" "s5-report.md")) false)))))
    (t/it "rejects an invalid slug before writing"
      (fn []
        (let [root (temp-root)
              port {:issue (fn [_]
                             {:ok true
                              :approval {:token "t" :revision 0 :report-sha256 "x"}})}
              result (aggregate 80)]
          (p/let [written (report/write-report! root "../escape" result {:approval-port port})]
            (t/to-be (:ok written) false)
            (t/to-be (normalized (get-in written [:errors 0 :code])) "INVALID_ARGUMENT")))))))

(defn- submission [case-id user developer]
  {:case_id case-id
   :user_score user
   :developer_score developer
   :report_markdown "在真实界面观察到的结果。"})

(t/describe "CLJS attach_case_audit persistence"
  (fn []
    (t/it "writes and reads back a durable EDN submission"
      (fn []
        (let [root (temp-root)
              case-id "CASE-R1"]
          (p/let [written (audit/write-submission-once! root "demo" case-id
                                                        (submission case-id 80 90) nil)
                  read-back (audit/read-submission root "demo" case-id nil)]
            (t/to-be (:ok written) true)
            (t/to-be (:memory written) true)
            (t/to-be (:ok read-back) true)
            (t/to-equal (:submission read-back) (submission case-id 80 90))))))
    (t/it "keeps the first submission byte-for-byte on a duplicate"
      (fn []
        (let [root (temp-root)
              case-id "CASE-R2"]
          (p/let [first (audit/write-submission-once! root "demo" case-id
                                                      (submission case-id 80 90) nil)
                  second (audit/write-submission-once! root "demo" case-id
                                                       (submission case-id 80 90) nil)]
            (t/to-be (:ok first) true)
            (t/to-be (:ok second) false)
            (t/to-be (normalized (:code second)) "AUDIT_DUPLICATE_CASE")
            (t/to-be (:memory first) true)))))
    (t/it "rejects a submission that names another CASE"
      (fn []
        (let [root (temp-root)]
          (p/let [outcome (audit/write-submission-once! root "demo" "CASE-R3"
                                                       (submission "CASE-OTHER" 80 90) nil)]
            (t/to-be (:ok outcome) false)
            (t/to-be (normalized (:code outcome)) "AUDIT_UNKNOWN_CASE")))))
    (t/it "rejects incomplete scores and reports a missing submission"
      (fn []
        (let [root (temp-root)]
          (p/let [invalid (audit/write-submission-once! root "demo" "CASE-R4"
                                                        (submission "CASE-R4" 101 90) nil)
                  missing (audit/read-submission root "demo" "CASE-MISSING" nil)]
            (t/to-be (:ok invalid) false)
            (t/to-be (normalized (:code invalid)) "INVALID_ARGUMENT")
            (t/to-be (:ok missing) false)
            (t/to-be (normalized (get-in missing [:error :code])) "AUDIT_MISSING")))))))
