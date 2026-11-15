(ns cljs.parsers-test
  (:require
   [clojure.string :as str]
   [herd.stages.parsers :as parsers]
   [herd.test :as t]))

(defn- case-spec [id path & [overrides]]
  (merge {:case_id id
          :path path
          :threshold 80
          :steps ["step"]
          :expected "expected"
          :rubric "rubric"}
         overrides))

(def all-paths ["正常" "错误" "边界" "并发" "恢复"])

(t/describe "CLJS stage parsers"
  (fn []
    (t/it "accepts a case dataset covering every required path"
      (fn []
        (let [cases (mapv (fn [index path]
                            (case-spec (str "CASE-" index) path))
                          (range (count all-paths))
                          all-paths)
              result (parsers/normalize-case-specs cases)]
          (t/to-be (:ok result) true)
          (t/to-be (count (:cases result)) 5))))
    (t/it "rejects a missing path category"
      (fn []
        (let [result (parsers/normalize-case-specs [(case-spec "CASE-1" "正常")])]
          (t/to-be (:ok result) false)
          (t/to-be (boolean (some #(= "CASE_REQUIRED_PATH_MISSING" (name (:code %)))
                                  (:errors result)))
                   true))))
    (t/it "rejects duplicate ids, unknown fields, and out-of-range thresholds"
      (fn []
        (let [cases [(case-spec "CASE-1" "错误" {:surprise true :threshold 101})
                     (case-spec "CASE-1" "错误")]
              result (parsers/normalize-case-specs cases)]
          (t/to-be (:ok result) false)
          (t/to-be (boolean (some #(= "CASE_DUPLICATE_ID" (name (:code %))) (:errors result))) true)
          (t/to-be (boolean (some #(str/includes? (str (:message %)) "not an allowed CASE field")
                                  (:errors result)))
                   true)
          (t/to-be (boolean (some #(= "CASE_THRESHOLD_INVALID" (name (:code %))) (:errors result)))
                   true))))
    (t/it "validates S1 sections and S4 promela"
      (fn []
        (let [markdown (str/join "\n"
                                 ["# 一句话目标与用户可见结果"
                                  "# 决策框架"
                                  "# 现状事实与根因"
                                  "# 单向门/双向门"
                                  "# 事前验尸"
                                  "# Non-Goals"
                                  "# 成功标准"
                                  "# 未决问题"])
              s1 (parsers/validate-s1 markdown)
              s4 (parsers/validate-s4 "md" "")]
          (t/to-be (:ok s1) true)
          (t/to-be (:ok s4) false)
          (t/to-be (name (:code (first (:errors s4)))) "INVALID_ARGUMENT"))))))
