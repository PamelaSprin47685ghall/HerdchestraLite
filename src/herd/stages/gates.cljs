(ns herd.stages.gates
  (:require
   ["node:crypto" :as crypto]
   ["node:fs/promises" :as fs]
   ["node:path" :as path]
   [clojure.string :as string]
   [herd.stages.attach :as attach]
   [herd.stages.disclosures :as disclosures]
   [herd.stages.parsers :as parsers]
   [herd.stages.store :as store]
   [herd.stages.tenure :as tenure]
   [herd.ufss :as ufss]
   [herd.ui :as ui]
   [herd.util.atomic-write :as atomic]))

(def ^:private slug-pattern #"^[a-z0-9][a-z0-9-]{0,63}$")
(def ^:private specific-pattern #"[A-Za-z0-9\u4e00-\u9fff]")

(def ^:private attach-stages
  {:attach_brainstorm :s1
   :attach_manual_tests :s2
   :attach_dev_guide :s3
   :attach_coordination :s4})

(def ^:private review-roles #{"Reviewer" "Plan" "Coordinator"})
(def ^:private attach-roles #{"Plan" "Coordinator"})

(defn- text? [value]
  (and (string? value) (pos? (count (string/trim value)))))

(defn- specific? [value]
  (and (text? value) (boolean (re-find specific-pattern value))))

(defn- failure [code message data]
  {:ok false
   :error (merge {:code code :message message} data)})

(defn- role-name [role]
  (cond
    (keyword? role) (name role)
    (string? role) role
    (nil? role) nil
    :else (str role)))

(defn- role-denied [role allowed]
  (let [current (role-name role)]
    (when (and current (not (contains? allowed current)))
      (failure :CAPABILITY_DENIED
               "the current role may not call this tool"
               {:role current :allowed (vec (sort allowed))}))))

(defn- resolve-root [deps options]
  (let [value (or (:root options) (:root deps))]
    (when (text? value) (string/trim value))))

(defn- resolve-slug [deps options params]
  (let [value (or (:slug params) (:slug options) (:slug deps))]
    (when (and (string? value) (re-matches slug-pattern value)) value)))

(defn- now-of [deps]
  (if (fn? (:now deps))
    ((:now deps))
    (.toISOString (js/Date.))))

(defn- canonical [value]
  (cond
    (map? value)
    (str "{" (string/join ","
                           (map (fn [[k v]]
                                  (str (pr-str k) ":" (canonical v)))
                                (sort-by (fn [[k _]] (str k)) value)))
         "}")
    (sequential? value)
    (str "[" (string/join "," (map canonical value)) "]")
    :else (pr-str value)))

(defn- sha256 [text]
  (.digest (.update (.createHash crypto "sha256") text "utf8") "hex"))

(defn- digest-of [payload]
  (sha256 (canonical payload)))

(defn- replay-hit [replay key digest]
  (when (and key (contains? @replay key))
    (let [cached (get @replay key)]
      (if (= digest (:digest cached))
        {:ok true :result (:result cached)}
        {:ok false
         :error {:code :CALL_REPLAY_MISMATCH
                 :message "call-id was already used with a different payload"
                 :call-id key}}))))

(defn- remember! [replay key digest result]
  (when key
    (swap! replay assoc key {:digest digest :result result}))
  result)

(defn- normalize-findings [findings]
  (if-not (sequential? findings)
    (failure :INVALID_ARGUMENT "findings must be an array" {:field :findings})
    (loop [index 0
           normalized []]
      (if (>= index (count findings))
        {:ok true :findings normalized}
        (let [entry (nth findings index)]
          (cond
            (not (map? entry))
            (failure :INVALID_ARGUMENT
                     (str "findings[" index "] must be an object")
                     {:field :findings :index index})

            (not (specific? (:key entry)))
            (failure :INVALID_ARGUMENT
                     (str "findings[" index "].key must be a non-empty string")
                     {:field :findings :index index})

            (not (or (nil? (:value entry)) (specific? (:value entry))))
            (failure :INVALID_ARGUMENT
                     (str "findings[" index "].value must be a non-empty string or nil")
                     {:field :findings :index index})

            :else
            (recur (inc index)
                   (conj normalized {:key (string/trim (:key entry))
                                     :value (when (string? (:value entry))
                                              (string/trim (:value entry)))}))))))))

(defn- mission-error [read]
  (if (:ok read)
    read
    {:ok false :error (:error read)}))

(defn ^:async review!* [deps replay params options]
  (let [role (or (:role options) (:role deps))
        denied (role-denied role review-roles)
        root (resolve-root deps options)
        slug (resolve-slug deps options nil)
        call-id (:call-id options)
        summary (:summary_markdown params)]
    (cond
      denied denied

      (nil? root)
      (failure :INVALID_ARGUMENT "workspace root is unavailable" {:field :root})

      (nil? slug)
      (failure :STAGE_MISMATCH "the session mission focus is not bound"
               {:field :slug :reason :session-slug-missing})

      (and (some? summary) (not (specific? summary)))
      (failure :INVALID_ARGUMENT
               "summary_markdown must be a non-empty, specific string"
               {:field :summary_markdown})

      :else
      (let [findings (normalize-findings (or (:findings params) []))]
        (if-not (:ok findings)
          findings
          (let [digest (digest-of ["review" slug summary (:findings findings)])
                key (when call-id (str "review:" call-id))
                hit (replay-hit replay key digest)]
            (if hit
              (if (:ok hit) (:result hit) {:ok false :error (:error hit)})
              (let [read (mission-error (await (store/read-mission root slug)))]
                (if-not (:ok read)
                  read
                  (let [mission (:mission read)
                        stage (tenure/normalize-stage (:stage mission))]
                    (cond
                      (= stage :s5)
                      (failure :HOST_API_MISMATCH
                               "runner.submitReview is not available"
                               {:reason :port-missing})

                      (nil? (tenure/attach-tool-for-stage stage))
                      (failure :STAGE_MISMATCH
                               "review is available only during an active tenure"
                               {:stage (:stage mission)})

                      :else
                      (let [board (or (await (store/read-board root slug))
                                      (tenure/empty-board (or (get-in mission [:tenure :tenure-id])
                                                              (:tenure-id mission))))
                            applied (tenure/apply-review board {:summary_markdown summary
                                                                :findings (:findings findings)
                                                                :stage stage})]
                        (if-not (:ok applied)
                          {:ok false :error (:error applied)}
                          (let [written (await (store/write-board! root slug (:board applied)))
                                result {:ok true
                                        :status (:status applied)
                                        :stage stage
                                        :slug slug
                                        :board (:board applied)
                                        :path (:path written)
                                        :open-tasks (:open-tasks applied)
                                        :attach-ready (:attach-ready applied)
                                        :expected-attach (:expected-attach applied)
                                        :findings (count (:findings findings))
                                        :suppress-nudge true}]
                            (remember! replay key digest result)))))))))))))))

(defn- attach-payload [stage params]
  (case stage
    :s2
    (let [normalized (parsers/normalize-case-specs (:cases params))]
      (if (:ok normalized)
        {:ok true :cases (:cases normalized)}
        normalized))

    :s4
    (if (specific? (:promela params))
      {:ok true :promela (:promela params)}
      (failure :INVALID_ARGUMENT
               "promela must be a non-empty, specific string"
               {:field :promela}))

    {:ok true}))

(defn- pending-of [mission]
  (get-in mission [:attach :pending]))

(defn- pending-attach-failure [mission]
  (when-let [pending (pending-of mission)]
    (failure :ATTACH_ALREADY_PENDING
             "an attach is already waiting or in progress"
             {:stage (:stage pending)
              :tool (:tool pending)})))

(defn- successor-patch [successor barrier attached]
  {:stage (:stage successor)
   :tenure (:tenure successor)
   :tenure-id (:tenure-id successor)
   :tenure-seq (:tenure-seq successor)
   :created-at (:created-at successor)
   :updated-at (:updated-at successor)
   :barrier barrier
   :attach {:ready (:attach-ready successor)
            :expected-attach (:attach-tool successor)
            :pending nil}
   :attach-ready (:attach-ready successor)
   :attach-tool (:attach-tool successor)
   :attached-tool attached})

(defn- attached-result [slug tool stage barrier successor documents]
  (let [next-stage (tenure/normalize-stage (:stage successor))]
    {:ok true
     :status :attached
     :stage stage
     :slug slug
     :tool tool
     :documents documents
     :barrier barrier
     :archive (:board-archive barrier)
     :successor successor
     :next-stage next-stage
     :disclosed-stage next-stage
     :briefing (disclosures/current-briefing next-stage)
     :suppress-nudge false}))

(defn- ^:async read-approved-document [root pending fallback]
  (let [stored (:path pending)]
    (if (and (string? stored) (pos? (count stored)))
      (let [target (if (path/isAbsolute stored) stored (path/join root stored))]
        (try
          (let [text (await (.readFile fs target "utf8"))]
            (if (text? text) text fallback))
          (catch :default _ fallback)))
      fallback)))

(defn- decision-of [value]
  (cond
    (string? value)
    {:decision (keyword value)}

    (map? value)
    (if (false? (:ok value))
      {:decision :error :error (:error value)}
      {:decision (keyword (or (:decision value) "pending"))
       :feedback (:feedback value)
       :disk-diff (:disk-diff value)})

    :else
    {:decision :pending :reason :host-confirm-protocol}))

(defn- ^:async request-approval [deps args]
  (if (fn? (:confirm deps))
    (try
      [:ok (await ((:confirm deps) args))]
      (catch :default error
        [:error (or (ex-message error) (str error))]))
    [:missing nil]))

(defn- ^:async complete-s1-approval! [deps root slug mission board pending approved-markdown]
  (let [barrier (tenure/build-barrier {:mission mission
                                       :board board
                                       :tool :attach_brainstorm
                                       :stage :s1
                                       :now (now-of deps)})
        successor (tenure/build-successor-mission {:mission mission
                                                   :tool :attach_brainstorm
                                                   :stage :s1
                                                   :now (now-of deps)})
        archive (await (store/archive-board! root slug
                                             (or (get-in mission [:tenure :tenure-id])
                                                 (:tenure-id mission))
                                             board))
        board-written (await (store/write-board! root slug (:board successor)))
        updated (await (store/update-mission!
                         root slug
                         (successor-patch successor barrier :attach_brainstorm)))]
    (if-not (:ok updated)
      updated
      (attached-result slug :attach_brainstorm :s1 barrier
                       (:mission updated)
                       {:markdown (str "plans/" slug "/s1-brainstorm.md")
                        :archive (:path archive)
                        :board (:path board-written)
                        :approved-markdown approved-markdown}))))

(defn- ^:async attach-s1!* [deps replay root slug mission board params options digest call-id markdown]
  (let [validation (parsers/validate-s1 markdown)]
    (if-not (:ok validation)
      (failure :INVALID_ARGUMENT "s1 validation failed"
               {:stage :s1 :errors (:errors validation)})
      (let [written (await (atomic/write-file-atomic!
                             (str root "/plans/" slug)
                             "s1-brainstorm.md"
                             markdown))
            sha (sha256 markdown)
            pending {:tool "attach_brainstorm"
                     :stage :s1
                     :call-id call-id
                     :digest digest
                     :path (:path written)
                     :sha256 sha}
            saved (await (store/update-mission!
                           root slug
                           {:attach (assoc (or (:attach mission) {}) :pending pending)}))]
        (if-not (:ok saved)
          saved
          (let [[status decision] (await (request-approval deps {:root root
                                                                 :slug slug
                                                                 :stage :s1
                                                                 :tool :attach_brainstorm
                                                                 :pending pending
                                                                 :markdown markdown
                                                                 :sha256 sha}))]
            (if (= :error status)
              (failure :HOST_API_MISMATCH
                       (str "the confirmation host failed: " decision)
                       {:reason :host-confirm-error})
              (let [decision (if (= :missing status)
                               {:decision :pending :reason :host-confirm-unavailable}
                               (decision-of decision))]
                (case (:decision decision)
                  :approve
                  (let [approved (await (read-approved-document root pending markdown))
                        cleared (await (store/update-mission!
                                         root slug
                                         {:attach (assoc (or (:attach mission) {}) :pending nil)}))]
                    (if-not (:ok cleared)
                      cleared
                      (complete-s1-approval! deps root slug mission board pending approved)))

                  :revise
                  (let [updated (await (store/update-mission!
                                         root slug
                                         {:attach (assoc (or (:attach mission) {})
                                                         :ready false
                                                         :expected-attach :attach_brainstorm
                                                         :pending nil)}))]
                    (if-not (:ok updated)
                      updated
                      {:ok true
                       :status :revision-requested
                       :stage :s1
                       :slug slug
                       :sha256 sha
                       :feedback (or (:feedback decision) "")
                       :disk-diff (:disk-diff decision)
                       :suppress-nudge false}))

                  :deny
                  (let [updated (await (store/update-mission! root slug
                                                              {:attach (assoc (or (:attach mission) {})
                                                                              :pending nil)}))]
                    (if-not (:ok updated)
                      updated
                      {:ok true
                       :status :denied
                       :stage :s1
                       :slug slug
                       :sha256 sha
                       :feedback (or (:feedback decision) "")
                       :ask-user {:question (or (:feedback decision)
                                                "请在对话中说明需要如何调整 S1 头脑风暴文档。")
                                  :context "attach_brainstorm 的确认面板返回 deny；未提交 barrier，仍留在 S1。"}
                       :suppress-nudge true}))

                  :error
                  (failure :HOST_API_MISMATCH
                           "the confirmation host returned no usable decision"
                           {:reason (or (get-in decision [:error :code]) :host-confirm-protocol)})

                  {:ok true
                   :status :awaiting-user
                   :stage :s1
                   :slug slug
                   :path (:path written)
                   :sha256 sha
                   :reason (or (:reason decision) :host-pending)
                   :suppress-nudge true})))))))))

(defn- ^:async attach-complete!* [deps replay root slug tool stage payload options digest call-id markdown]
  (let [committed (await (attach/commit-attach! root slug tool
                           {:markdown markdown
                            :cases (:cases payload)
                            :promela (:promela payload)
                            :now (now-of deps)}))]
    (if-not (:ok committed)
      committed
      (let [successor (:successor committed)
            next-stage (tenure/normalize-stage (:stage successor))
            cleared (await (store/update-mission!
                             root slug
                             {:attach {:ready false
                                       :expected-attach (tenure/attach-tool-for-stage next-stage)
                                       :pending nil}}))]
        (if-not (:ok cleared)
          cleared
          (attached-result slug tool stage (:barrier committed)
                           (:mission cleared) (:documents committed)))))))

(defn ^:async attach!* [deps replay tool params options]
  (let [role (or (:role options) (:role deps))
        denied (role-denied role attach-roles)
        stage (get attach-stages tool)
        root (resolve-root deps options)
        slug (resolve-slug deps options params)
        markdown (:markdown params)]
    (cond
      denied denied

      (nil? stage)
      (failure :INVALID_ARGUMENT "unknown attach tool" {:tool tool})

      (nil? root)
      (failure :INVALID_ARGUMENT "workspace root is unavailable" {:field :root})

      (nil? slug)
      (failure :STAGE_MISMATCH "the session mission focus is not bound"
               {:field :slug :reason :session-slug-missing})

      (not (specific? markdown))
      (failure :INVALID_ARGUMENT
               "markdown must be a non-empty, specific string"
               {:field :markdown})

      :else
      (let [payload (attach-payload stage params)]
        (if-not (:ok payload)
          payload
          (let [digest (digest-of [tool slug stage markdown
                                   (:cases payload) (:promela payload)])
                key (when (:call-id options) (str tool ":" (:call-id options)))
                hit (replay-hit replay key digest)]
            (if hit
              (if (:ok hit) (:result hit) {:ok false :error (:error hit)})
              (let [read (mission-error (await (store/read-mission root slug)))]
                (if-not (:ok read)
                  read
                  (let [mission (:mission read)
                        pending-failure (pending-attach-failure mission)
                        board (await (store/read-board root slug))]
                    (cond
                      pending-failure pending-failure

                      (nil? board)
                      (failure :BOARD_CONFLICT "board.edn has no tasks map" {:slug slug})

                      :else
                      (let [gate (tenure/evaluate-attach {:mission mission
                                                          :board board
                                                          :tool tool
                                                          :stage stage})]
                        (if-not (:ok gate)
                          gate
                          (remember!
                            replay key digest
                            (if (= stage :s1)
                              (await (attach-s1!* deps replay root slug mission board params options
                                                  digest (:call-id options) markdown))
                              (await (attach-complete!* deps replay root slug tool stage payload options
                                       digest (:call-id options) markdown)))))))))))))))))

(def ^:private ask-roles #{"Plan" "Coordinator" "Reviewer"})
(def ^:private devops-roles #{"Plan" "Coordinator"})
(def ^:private devops-report-roles #{"Plan DevOps"})

(defn- ^:async ask-host [deps stage question context recommended root slug]
  (let [receipt {:ok true
                 :status :awaiting-user
                 :stage stage
                 :question question
                 :context (or context "")
                 :recommended-default recommended
                 :suppress-nudge true}]
    (if (fn? (:ask-user deps))
      (try
        (let [answer (await ((:ask-user deps) {:root root
                                               :slug slug
                                               :question question
                                               :context context
                                               :recommended-default recommended}))]
          (cond
            (and (map? answer) (true? (:ok answer)) (specific? (:answer answer)))
            {:ok true :status :answered :stage stage :question question :answer (:answer answer)}

            (and (map? answer) (false? (:ok answer)))
            (failure (or (get-in answer [:error :code]) :HOST_API_MISMATCH)
                     (or (get-in answer [:error :message]) "the ask-user host rejected the question")
                     {})

            :else receipt))
        (catch :default error
          (failure :HOST_API_MISMATCH (or (ex-message error) (str error)) {})))
      receipt)))

(defn ^:async ask-user!* [deps params options]
  (let [role (or (:role options) (:role deps))
        denied (role-denied role ask-roles)
        root (resolve-root deps options)
        slug (resolve-slug deps options params)
        question (:question params)]
    (cond
      denied denied

      (nil? root)
      (failure :INVALID_ARGUMENT "workspace root is unavailable" {:field :root})

      (nil? slug)
      (failure :STAGE_MISMATCH "the session mission focus is not bound"
               {:field :slug :reason :session-slug-missing})

      (not (specific? question))
      (failure :INVALID_ARGUMENT "question must be a non-empty, specific string" {:field :question})

      :else
      (let [read (mission-error (await (store/read-mission root slug)))]
        (if-not (:ok read)
          read
          (let [stage (tenure/normalize-stage (:stage (:mission read)))]
            (cond
              (= stage :s5)
              (if (fn? (:assert-initial-empty-ledger deps))
                (let [check (await ((:assert-initial-empty-ledger deps) {:root root :slug slug}))]
                  (if (and (map? check) (true? (:ok check)))
                    (ask-host deps :s5 question (:context params) (:recommended_default params) root slug)
                    (failure :ASK_FORBIDDEN_OUTSIDE_S1
                             "ask_user is allowed only in S1 or the one-time S5 empty-ledger exception"
                             {:stage stage :reason :ledger-check-failed})))
                (failure :ASK_FORBIDDEN_OUTSIDE_S1
                         "ask_user is allowed only in S1 or the one-time S5 empty-ledger exception"
                         {:stage stage :reason :port-missing}))

              (= stage :s1)
              (let [context (:context params)
                    recommended (:recommended_default params)]
                (if-not (and (specific? context) (specific? recommended))
                  (failure :INVALID_ARGUMENT
                           "context and recommended_default must be non-empty, specific strings"
                           {:field (if (specific? context) :recommended_default :context)})
                  (ask-host deps :s1 question context recommended root slug)))

              :else
              (failure :ASK_FORBIDDEN_OUTSIDE_S1
                       "ask_user is allowed only in S1 or the one-time S5 empty-ledger exception"
                       {:stage stage}))))))))

(defn ^:async devops!* [deps params options]
  (let [role (or (:role options) (:role deps))
        denied (role-denied role devops-roles)
        root (resolve-root deps options)
        slug (resolve-slug deps options params)
        intent (:verbose_intent params)]
    (cond
      denied denied

      (nil? root)
      (failure :INVALID_ARGUMENT "workspace root is unavailable" {:field :root})

      (nil? slug)
      (failure :STAGE_MISMATCH "the session mission focus is not bound"
               {:field :slug :reason :session-slug-missing})

      (not (specific? intent))
      (failure :INVALID_ARGUMENT "verbose_intent must be a non-empty, specific string"
               {:field :verbose_intent})

      :else
      (let [read (mission-error (await (store/read-mission root slug)))]
        (if-not (:ok read)
          read
          (let [stage (tenure/normalize-stage (:stage (:mission read)))]
            (cond
              (not (contains? #{:s1 :s2 :s3 :s4} stage))
              (failure :STAGE_MISMATCH "devops is available only in S1-S4" {:stage stage})

              (not (fn? (:run-devops deps)))
              (failure :HOST_API_MISMATCH "host.runDevops is not available" {:reason :port-missing})

              :else
              (try
                (let [result (await ((:run-devops deps) {:root root
                                                         :slug slug
                                                         :intent intent
                                                         :verbose-intent intent
                                                         :stage stage}))]
                  (if (and (map? result) (false? (:ok result)))
                    result
                    (if (map? result)
                      {:ok true
                       :status (or (:status result) :devops-report)
                       :stage stage
                       :agent-id (:agent-id result)
                       :report (:report result)}
                      (failure :HOST_API_MISMATCH "runDevops returned no result" {:reason :port-protocol}))))
                (catch :default error
                  (failure :HOST_API_MISMATCH (or (ex-message error) (str error)) {}))))))))))

(defn ^:async submit-devops-report!* [deps params options]
  (let [role (or (:role options) (:role deps))
        denied (role-denied role devops-report-roles)
        root (resolve-root deps options)
        slug (resolve-slug deps options params)
        status (:status params)
        report-markdown (:report_markdown params)
        inspected (:inspected_paths params)]
    (cond
      denied denied

      (nil? root)
      (failure :INVALID_ARGUMENT "workspace root is unavailable" {:field :root})

      (nil? slug)
      (failure :STAGE_MISMATCH "the session mission focus is not bound"
               {:field :slug :reason :session-slug-missing})

      (not (specific? status))
      (failure :INVALID_ARGUMENT "status must be a non-empty string" {:field :status})

      (not (specific? report-markdown))
      (failure :INVALID_ARGUMENT "report_markdown must be a non-empty, specific string"
               {:field :report_markdown})

      (not (and (sequential? inspected) (pos? (count inspected)) (every? text? inspected)))
      (failure :INVALID_ARGUMENT "inspected_paths must be a non-empty array of paths"
               {:field :inspected_paths})

      :else
      (let [read (mission-error (await (store/read-mission root slug)))]
        (if-not (:ok read)
          read
          (let [stage (tenure/normalize-stage (:stage (:mission read)))]
            (if-not (contains? #{:s1 :s2 :s3 :s4} stage)
              (failure :STAGE_MISMATCH "devops reports are accepted only in S1-S4" {:stage stage})
              (let [report {:status (string/trim status)
                            :report_markdown report-markdown
                            :inspected_paths (mapv string/trim inspected)}]
                (if (fn? (:accept-devops-report deps))
                  (try
                    (let [accepted (await ((:accept-devops-report deps) {:root root
                                                                         :slug slug
                                                                         :report report}))]
                      (if (and (map? accepted) (false? (:ok accepted)))
                        accepted
                        {:ok true
                         :status :devops-report-submitted
                         :slug slug
                         :stage stage
                         :report report}))
                    (catch :default error
                      (failure :HOST_API_MISMATCH (or (ex-message error) (str error)) {})))
                  {:ok true
                   :status :devops-report-submitted
                   :slug slug
                   :stage stage
                   :report report})))))))))

(declare resume-approval!*)

(defn create-service [deps]
  (let [replay (or (:replay deps) (atom {}))
        settings (assoc deps :replay replay)]
    {:review! (fn [params options] (review!* settings replay params options))
     :attach! (fn [tool params options] (attach!* settings replay tool params options))
     :ask-user! (fn [params options] (ask-user!* settings params options))
     :devops! (fn [params options] (devops!* settings params options))
     :submit-devops-report! (fn [params options] (submit-devops-report!* settings params options))
     :resume-approval! (fn [root slug decision] (resume-approval!* settings replay root slug decision))
     :replay replay}))

(defn ^:async resume-approval!* [deps replay root slug decision]
  (let [read (mission-error (await (store/read-mission root slug)))]
    (if-not (:ok read)
      read
      (let [mission (:mission read)
            pending (pending-of mission)]
        (if-not (map? pending)
          (failure :STAGE_MISMATCH "no S1 attach is waiting for approval"
                   {:slug slug :reason :no-pending-attach})
          (let [board (await (store/read-board root slug))
                normalized (decision-of decision)]
            (if (nil? board)
              (failure :BOARD_CONFLICT "board.edn has no tasks map" {:slug slug})
              (case (:decision normalized)
                :approve
                (let [approved (await (read-approved-document root pending (:markdown pending)))
                      cleared (await (store/update-mission! root slug
                                                            {:attach (assoc (or (:attach mission) {})
                                                                            :pending nil)}))]
                  (if-not (:ok cleared)
                    cleared
                    (complete-s1-approval! deps root slug mission board pending approved)))

                :revise
                (let [updated (await (store/update-mission!
                                       root slug
                                       {:attach (assoc (or (:attach mission) {})
                                                       :ready false
                                                       :expected-attach :attach_brainstorm
                                                       :pending nil)}))]
                  (if-not (:ok updated)
                    updated
                    {:ok true :status :revision-requested :stage :s1 :slug slug
                     :feedback (or (:feedback normalized) "") :suppress-nudge false}))

                :deny
                (let [updated (await (store/update-mission! root slug
                                                            {:attach (assoc (or (:attach mission) {})
                                                                            :pending nil)}))]
                  (if-not (:ok updated)
                    updated
                    {:ok true :status :denied :stage :s1 :slug slug
                     :feedback (or (:feedback normalized) "") :suppress-nudge true}))

                :error
                (failure :HOST_API_MISMATCH
                         "the confirmation host returned no usable decision"
                         {:reason :host-confirm-protocol})

                {:ok true :status :awaiting-user :stage :s1 :slug slug
                 :reason :host-pending :suppress-nudge true}))))))))

(defn- tool-result [result]
  {:content [{:type "text" :text (ufss/canonical result)}]})

(defn- tool-error [result]
  {:isError true
   :content [{:type "text" :text (ufss/canonical result)}]})

(defn- safe [handler]
  (fn [tool-call-id params signal on-update ctx]
    (try
      (handler tool-call-id params signal on-update ctx)
      (catch :default error
        (tool-error (failure :INTERNAL
                             (or (ex-message error) (str error))
                             {}))))))

(defn- invoke [service tool params options]
  (let [request (js->clj (or params #js {}) :keywordize-keys true)]
    (cond
      (= tool :review) ((:review! service) request options)
      (contains? #{:attach_brainstorm :attach_manual_tests :attach_dev_guide :attach_coordination} tool)
      ((:attach! service) tool request options)
      (= tool :ask_user) ((:ask-user! service) request options)
      (= tool :devops) ((:devops! service) request options)
      (= tool :submit_devops_report) ((:submit-devops-report! service) request options))))

(defn- tool-options [deps ctx call-id]
  {:root (if (fn? (:root-of deps)) ((:root-of deps) ctx) (:root deps))
   :slug (if (fn? (:slug-of deps)) ((:slug-of deps) ctx) (:slug deps))
   :role (if (fn? (:role-of deps)) ((:role-of deps) ctx) (:role deps))
   :call-id call-id})

(defn- tool-definition [service deps tool-name label description parameters tool]
  (merge
    {:name (clojure.core/name tool-name)
     :label label
     :description description
     :load-mode "essential"
     :parameters parameters
     :execute (safe (fn [call-id params signal on-update ctx]
                      (-> (invoke service tool params (tool-options deps ctx call-id))
                          (.then (fn [value]
                                   (if (:ok value)
                                     (tool-result value)
                                     (tool-error value))))
                          (.catch (fn [error]
                                    (tool-error
                                      (failure :INTERNAL
                                               (or (ex-message error) (str error))
                                               {})))))))}
    (ui/gate-renderers tool)))

(defn- review-parameters []
  {:type "object"
   :additionalProperties false
   :properties {:summary_markdown {:type "string" :minLength 1}
                :findings {:type "array"
                           :default []
                           :items {:type "object"
                                   :additionalProperties false
                                   :required ["key"]
                                   :properties {:key {:type "string" :minLength 1}
                                                :value {:anyOf [{:type "string" :minLength 1}
                                                                {:type "null"}]}}}}}})

(defn- markdown-parameters [extra]
  {:type "object"
   :additionalProperties false
   :required (vec (cons "markdown" (keys extra)))
   :properties (merge {:markdown {:type "string" :minLength 1}} extra)})

(defn- case-parameters []
  {:type "array"
   :minItems 1
   :items {:type "object"
           :additionalProperties false
           :required ["case_id" "path" "threshold" "steps" "expected" "rubric"]
           :properties {:case_id {:type "string" :minLength 1}
                        :path {:type "string" :minLength 1}
                        :threshold {:type "number" :minimum 0 :maximum 100}
                        :steps {:type "array" :minItems 1 :items {:type "string" :minLength 1}}
                        :expected {:type "string" :minLength 1}
                        :rubric {:type "string" :minLength 1}}}})

(defn- slug-schema []
  {:type "string" :minLength 1 :maxLength 64
   :pattern "^[a-z0-9][a-z0-9-]{0,63}$"})

(defn- ask-user-parameters []
  {:type "object"
   :additionalProperties false
   :required ["slug" "question"]
   :properties {:slug (slug-schema)
                :question {:type "string" :minLength 1}
                :context {:type "string" :minLength 1}
                :recommended_default {:type "string" :minLength 1}}})

(defn- devops-parameters []
  {:type "object"
   :additionalProperties false
   :required ["slug" "verbose_intent"]
   :properties {:slug (slug-schema)
                :verbose_intent {:type "string" :minLength 1}}})

(defn- devops-report-parameters []
  {:type "object"
   :additionalProperties false
   :required ["status" "report_markdown" "inspected_paths"]
   :properties {:status {:type "string" :minLength 1}
                :report_markdown {:type "string" :minLength 1}
                :inspected_paths {:type "array"
                                  :minItems 1
                                  :items {:type "string" :minLength 1}}}})

(defn tool-definitions [service deps]
  [(tool-definition service deps :review "Submit Review"
                    "Apply Reviewer findings to this tenure's review ledger. Non-empty findings open the review; an empty ledger becomes attach-ready."
                    (review-parameters) :review)
   (tool-definition service deps :attach_brainstorm "Attach Brainstorm"
                    "Write s1-brainstorm.md, request explicit human approval, then open S2."
                    (markdown-parameters {}) :attach_brainstorm)
   (tool-definition service deps :attach_manual_tests "Attach Manual Tests"
                    "Write s2-manual-tests.md and s2-cases.edn, retire the S2 tenure, and open S3."
                    (markdown-parameters {:cases (case-parameters)}) :attach_manual_tests)
   (tool-definition service deps :attach_dev_guide "Attach Dev Guide"
                    "Write s3-dev-guide.md, retire the S3 tenure, and open S4."
                    (markdown-parameters {}) :attach_dev_guide)
   (tool-definition service deps :attach_coordination "Attach Coordination"
                    "Write s4-coordination.md and the unchecked Promela model, retire the S4 tenure, and open S5."
                    (markdown-parameters {:promela {:type "string" :minLength 1}}) :attach_coordination)
   (tool-definition service deps :ask_user "Ask User"
                    "Ask one high-value S1 question, or the one-time S5 initial-empty-ledger question."
                    (ask-user-parameters) :ask_user)
   (tool-definition service deps :devops "DevOps Investigation"
                    "Start the read-only Plan DevOps investigator and return its structured report."
                    (devops-parameters) :devops)
   (tool-definition service deps :submit_devops_report "Submit DevOps Report"
                    "Finish a Plan DevOps investigation with a structured report and inspected paths."
                    (devops-report-parameters) :submit_devops_report)])
(defn register-all! [register deps]
  (let [service (create-service deps)]
    (doseq [definition (tool-definitions service deps)]
      (register definition))
    service))