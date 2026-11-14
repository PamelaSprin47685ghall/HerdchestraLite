(ns herd.stages.report
  (:require
   [clojure.string :as string]
   [herd.util.atomic-write :as atomic]))

(def ^:private slug-pattern #"^[a-z0-9][a-z0-9-]{0,63}$")

(defn- text? [value]
  (and (string? value) (pos? (count (string/trim value)))))

(defn- cell [value]
  (-> (str value)
      (string/replace "|" #"\|"#)
      (string/replace #"\r?\n" " ")))

(defn- trim-block [value]
  (if (string? value) (string/replace value #"\s+$" "") ""))

(defn- header [result slug]
  (let [contract (:contract result)
        audit (:audit result)]
    (str "# S5 手工验收报告：" (:mission-id contract) "\n\n"
         "- 用例集：`.herd/missions/" slug """
/s2-cases.edn`

"""
         "- 使命：" (:mission-id contract) "\n"
         "- 修订：" (:revision contract) "\n"
         "- 审计环境：" (:environment audit) "\n"
         """
- 总判定：PASS


"""
         """
## 逐 CASE 得分


"""
         """
| CASE | 路径 | user_score | developer_score | final | threshold | 结果 |

"""
         """
|---|---|---|---|---|---|---|

""")))

(defn- table [rows]
  (string/join
    "\n"
    (mapv (fn [row]
            (str "| " (cell (:case-id row))
                 " | " (cell (:path row))
                 " | " (:user-score row)
                 " | " (:developer-score row)
                 " | " (:score row)
                 " | " (:threshold row)
                 " | " (if (:passed row) "PASS" "FAIL") " |"))
          rows)))

(defn- reports [rows]
  (string/join
    "\n"
    (mapv (fn [row]
            (str "### " (:case-id row) "\n\n"
                 (trim-block (:report-markdown row)) "\n"))
          rows)))

(defn- footer [result rows]
  (let [audit (:audit result)
        limitations (if (text? (:limitations audit)) (:limitations audit) "无记录")
        lessons (if (text? (:lessons audit)) (:lessons audit) "无记录")]
    (str """
## 总判定


"""
         "PASS：" (count rows) "/" (count rows)
         """
 个 CASE 的 min(user_score, developer_score) 达到或超过各自的 PASS threshold。


"""
         """
## 限制与教训


"""
         """
### 限制


""" limitations "\n\n"
         """
### 教训


""" lessons "\n")))

(defn compose-report [result slug]
  (let [rows (vec (:rows result))]
    (str (header result slug)
         (table rows)
         """


## 审计员报告


"""
         (reports rows)
         "\n"
         (footer result rows))))

(defn- pass-result? [result]
  (and (map? result)
       (true? (:ok result))
       (= :PASS (:verdict result))
       (nil? (:repair-spec result))
       (map? (:contract result))
       (sequential? (:case-ids result))
       (pos? (count (:case-ids result)))
       (sequential? (:rows result))
       (= (count (:rows result)) (count (:case-ids result)))))

(defn- sha256 [text]
  (let [crypto (js/require "node:crypto")]
    (.digest (.update (.createHash crypto "sha256") text "utf8") "hex")))

(defn- failure [code message data]
  (merge {:code code :message message} data))

(defn- refusal
  ([code message data]
   {:ok false
    :code code
    :errors [(failure code message data)]
    :completed false})
  ([code message data file sha markdown recheck]
   {:ok false
    :code code
    :path (when file (:path file))
    :sha256 sha
    :markdown markdown
    :approval nil
    :recheck recheck
    :errors [(failure code message data)]
    :completed false}))

(defn- port-call [port method]
  (cond
    (and (map? port) (fn? (get port method))) (get port method)
    (and (some? port) (fn? (aget port (name method)))) (aget port (name method))
    (fn? port) port
    :else nil))

(defn- approval-request [result report-sha256]
  {:mission-id (get-in result [:contract :mission-id])
   :revision (get-in result [:contract :revision])
   :report-sha256 report-sha256
   :verdict "PASS"
   :case-count (count (:case-ids result))})

(defn- approved? [issued]
  (and (map? issued)
       (true? (:ok issued))
       (map? (:approval issued))
       (text? (:token (:approval issued)))))

(defn ^:async request-approval! [approval-port request file sha markdown recheck]
  (let [issue-fn (port-call approval-port :issue)]
    (if-not issue-fn
      (refusal :APPROVAL_REQUIRED
               "no approval port was injected; the mission stays in progress"
               {} file sha markdown recheck)
      (let [issued (try
                     [:ok (await (issue-fn (assoc request :recheck recheck)))]
                     (catch :default error
                       [:error error]))]
        (if (= :error (first issued))
          (refusal :APPROVAL_REQUIRED
                   (str "the approval port failed: " (str (second issued)))
                   {} file sha markdown recheck)
          (let [response (second issued)]
            (if (approved? response)
              {:ok true
               :path (:path file)
               :existed (:existed file)
               :sha256 sha
               :markdown markdown
               :approval (:approval response)
               :recheck recheck
               :errors []
               :completed false}
              (refusal (or (:code response) :APPROVAL_REQUIRED)
                       (or (:message response)
                           "the approval port did not issue a one-time approval")
                       {} file sha markdown recheck))))))))

(defn ^:async write-report! [root slug result options]
  (let [errors (atom [])
        settings (or options {})]
    (when-not (text? root)
      (swap! errors conj (failure :INVALID_ARGUMENT "root must be a non-empty string" {:field :root})))
    (when-not (and (string? slug) (re-matches slug-pattern slug))
      (swap! errors conj (failure :INVALID_ARGUMENT "slug must match [a-z0-9][a-z0-9-]{0,63}" {:field :slug})))
    (when-not (map? result)
      (swap! errors conj (failure :INVALID_ARGUMENT "result must be an object" {:field :result})))
    (if (seq @errors)
      {:ok false :errors @errors :completed false}
      (if-not (pass-result? result)
        (refusal :APPROVAL_REQUIRED
                 "refusing to write s5-report.md: aggregate is not a clean PASS"
                 {})
        (let [markdown (compose-report result slug)
              written (try
                        [:ok (await (atomic/write-file-atomic! (str root "/plans/" slug)
                                                               "s5-report.md"
                                                               markdown))]
                        (catch :default error
                          [:error error]))]
          (if (= :error (first written))
            (let [error (second written)]
              {:ok false
               :code (or (:code (ex-data error)) :INVALID_ARGUMENT)
               :message (str error)
               :stage (:stage (ex-data error))
               :error error
               :completed false})
            (let [file (second written)
                  report-sha256 (sha256 markdown)
                  request (approval-request result report-sha256)
                  recheck-port (:recheck-port settings)
                  recheck-fn (port-call recheck-port :recheck)]
              (if-not recheck-fn
                (await (request-approval! (:approval-port settings) request file
                         report-sha256 markdown nil))
                (let [checked (try
                                [:ok (await (recheck-fn {:root root
                                                         :slug slug
                                                         :mission-id (:mission-id request)
                                                         :revision (:revision request)
                                                         :contract (:contract result)
                                                         :report-path (:path file)
                                                         :report-sha256 report-sha256
                                                         :snapshot-before (:snapshot-before result)}))]
                                (catch :default error
                                  [:error error]))]
                  (if (= :error (first checked))
                    (refusal :APPROVAL_REQUIRED
                             (str "post-report workspace recheck failed: "
                                  (str (second checked))
                                  "; approval was not issued")
                             {:field :recheck}
                             file report-sha256 markdown
                             {:ok false :message (str (second checked))})
                    (let [recheck (second checked)]
                      (if (true? (:ok recheck))
                        (await (request-approval! (:approval-port settings)
                                 request file report-sha256 markdown
                                 (assoc recheck
                                        :mission-id (:mission-id request)
                                        :revision (:revision request)
                                        :report-sha256 report-sha256)))
                        (refusal (or (:code recheck) :APPROVAL_REQUIRED)
                                 (or (:message recheck)
                                     "the post-report workspace recheck did not pass; approval was not issued")
                                 {:field :recheck :mismatches (:mismatches recheck)}
                                 file report-sha256 markdown recheck)))))))))))))