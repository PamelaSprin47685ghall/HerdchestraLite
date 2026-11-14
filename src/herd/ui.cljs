(ns herd.ui
  (:require
   [clojure.string :as str]
   [herd.highlight :as highlight]
   [herd.ufss :as ufss]))

(def ^:private canonical-highlight-limit 8192)

(def agent-state-labels
  {"Orienting" "探索定向"
   "Converging" "稳定收敛"
   "Consolidating" "固结沉淀"
   "Stagnant" "局部停滞"
   "Drifting" "目标漂移"
   "Densifying" "细节致密"
   "Reorienting" "回溯重整"
   "Settled" "完全收敛"})

(defn- pi-root []
  (some-> js/globalThis.__pi .-pi))

(defn- tui-root []
  js/globalThis.__herdTui)

(defn- tui-class [class-name]
  (or (when-let [root (pi-root)] (aget root class-name))
      (when-let [tui (tui-root)] (aget tui class-name))))

(defn raw-text [text]
  (let [text (str (or text ""))
        Text (tui-class "Text")]
    (if (fn? Text)
      (new Text text 0 0)
      #js {:text text
           :render (fn [_width] (into-array (str/split text #"\n" -1)))
           :invalidate (fn [] nil)})))

(defn make-container []
  (let [Container (tui-class "Container")]
    (if (fn? Container)
      (new Container)
      (let [children (array)]
        #js {:children children
             :addChild (fn [child] (.push children child))
             :render (fn [width]
                       (let [out (array)]
                         (doseq [child (array-seq children)]
                           (when (and child (fn? (.-render child)))
                             (doseq [line (array-seq (.render child width))]
                               (.push out line))))
                         out))
             :invalidate (fn []
                           (doseq [child (array-seq children)]
                             (when (and child (fn? (.-invalidate child)))
                               (.invalidate child))))}))))

(defn fg [theme role text]
  (let [s (str (or text ""))]
    (try
      (if (and theme (fn? (.-fg theme)))
        (.fg theme role s)
        s)
      (catch :default _ s))))

(defn dim-text [theme text]
  (fg theme "dim" text))

(defn hrule [theme]
  (let [render (fn [width]
                 (let [w (if (and (number? width) (pos? width)) (js/Math.floor width) 1)
                       line (apply str (repeat (max 1 w) "─"))]
                   #js [(dim-text theme line)]))]
    #js {:render render
         :invalidate (fn [] nil)}))

(defn humanize-name [text]
  (->> (str/split (str (or text "")) #"[-_]")
       (map (fn [part]
              (if (pos? (count part))
                (str (str/upper-case (subs part 0 1)) (subs part 1))
                part)))
       (str/join " ")))

(defn result-text [result]
  (try
    (let [blocks (when result (.-content result))
          block (when (and blocks (pos? (.-length blocks)))
                  (aget blocks 0))]
      (or (when block (.-text block)) ""))
    (catch :default _ "")))

(defn- safe-canonical-string [text theme expanded?]
  (let [highlighter (try (highlight/make-highlighter theme) (catch :default _ nil))
        options {:collapse-strings? true
                 :placeholder (fn [s] (dim-text theme s))}]
    (try
      (cond
        expanded?
        (ufss/canonical text highlighter)

        (> (count text) canonical-highlight-limit)
        (ufss/canonical text nil options)

        :else
        (ufss/canonical text highlighter options))
      (catch :default _ text))))

(defn canonical-view [value theme expanded?]
  (if (string? value)
    (safe-canonical-string value theme expanded?)
    (let [plain (try
                  (ufss/canonical value nil nil)
                  (catch :default _ (pr-str value)))
          highlighter (try (highlight/make-highlighter theme) (catch :default _ nil))
          options {:collapse-strings? true
                   :placeholder (fn [s] (dim-text theme s))}]
      (try
        (cond
          expanded?
          (ufss/canonical value highlighter)

          (> (count plain) canonical-highlight-limit)
          (ufss/canonical value nil options)

          :else
          (ufss/canonical value highlighter options))
        (catch :default _ plain)))))

(defn- safe-args [args]
  (try
    (cond
      (nil? args) {}
      (map? args) args
      (object? args) (let [converted (js->clj args :keywordize-keys true)]
                       (if (map? converted) converted {}))
      :else {})
    (catch :default _ {})))

(defn- safe-read-edn [text]
  (when (and (string? text) (pos? (count (str/trim text))))
    (try
      (ufss/read text)
      (catch :default _ nil))))

(defn- one-line [text max-len]
  (when (string? text)
    (let [clean (-> text
                    (str/replace #"\s+" " ")
                    str/trim)]
      (when (pos? (count clean))
        (if (> (count clean) max-len)
          (str (subs clean 0 (max 1 (dec max-len))) "…")
          clean)))))

(defn- title-line [theme title tag]
  (let [head (fg theme "accent" title)]
    (if (and (string? tag) (not (str/blank? tag)))
      (str head " " (dim-text theme (str "--- [" tag "]")))
      head)))

(defn- status-summary-line [theme tone icon label detail]
  (let [icon-text (fg theme tone icon)
        label-color (case tone
                      "error" "error"
                      "warning" "warning"
                      "dim" "dim"
                      "accent")
        label-text (fg theme label-color label)]
    (if (and (string? detail) (not (str/blank? detail)))
      (str icon-text " " label-text " " (dim-text theme (str "--- [" detail "]")))
      (str icon-text " " label-text))))

(defn- build-call-card [theme title tag body-value expanded?]
  (let [c (make-container)]
    (.addChild c (raw-text (title-line theme title tag)))
    (.addChild c (hrule theme))
    (.addChild c (raw-text (canonical-view body-value theme expanded?)))
    c))

(defn- error-summary [data raw-error?]
  (let [err (when (map? data) (:error data))
        code (cond
               (map? err) (:code err)
               (and (map? data) (:code data)) (:code data)
               (and (map? data) (= :failed (:state data))) :FAILED
               :else nil)
        msg (cond
              (map? err) (:message err)
              (and (map? data) (:message data)) (:message data)
              :else nil)]
    (when (or raw-error? (and (map? data) (false? (:ok data))) (map? err) (= :failed (:state data)))
      ["error" "✗" (if code (str code) "执行失败") (one-line msg 72)])))

(defn- build-result-card [theme raw expanded? summary]
  (let [c (make-container)]
    (.addChild c (hrule theme))
    (when-let [[tone icon label detail] summary]
      (.addChild c (raw-text (status-summary-line theme tone icon label detail))))
    (when (and (string? raw) (pos? (count raw)))
      (.addChild c (raw-text (canonical-view raw theme expanded?))))
    c))

(defn clj-render-call [args options theme]
  (let [name (or (when args (.-name args)) "<unnamed>")
        state (when args (.-agent_state args))
        state-label (get agent-state-labels state)
        state-tag (when (and state (not (str/blank? (str state))))
                    (str "[" (or state-label state) "]"))
        code (or (when args (.-code args)) "")
        suffix (if state-tag (str "--- " state-tag) "")
        title (if (str/blank? suffix)
                (fg theme "accent" (humanize-name name))
                (str (fg theme "accent" (humanize-name name))
                     " "
                     (dim-text theme suffix)))
        canonical (canonical-view code theme (boolean (some-> options .-expanded)))
        c (make-container)]
    (.addChild c (raw-text title))
    (.addChild c (hrule theme))
    (.addChild c (raw-text canonical))
    c))

(defn clj-render-result [result options theme]
  (let [raw (result-text result)
        text (canonical-view raw theme (boolean (some-> options .-expanded)))
        c (make-container)]
    (.addChild c (hrule theme))
    (.addChild c (raw-text text))
    c))

(defn wait-render-call [args options theme]
  (let [m (safe-args args)
        work (:otherwise_independent_work m)
        tag (if-let [preview (one-line work 36)]
              (str "等待沙箱 · " preview)
              "等待沙箱")]
    (build-call-card theme "Wait" tag m (boolean (some-> options .-expanded)))))

(defn wait-render-result [result options theme]
  (let [raw (result-text result)
        data (safe-read-edn raw)
        err? (boolean (some-> result .-isError))
        summary (or (error-summary data err?)
                    (when (map? data)
                      (case (:state data)
                        :idle ["dim" "·" "空闲" "无运行中沙箱"]
                        :completed ["success" "✓" "完成" (some-> (:name data) str)]
                        :joined ["success" "✓" "汇合完成" (let [n (count (or (:results data) []))]
                                                        (str n " 个程序"))]
                        :parked ["warning" "◷" "超期停靠" (let [n (count (or (:programs data) []))]
                                                        (str n " 个程序"))]
                        :host-wait ["success" "✓" "宿主等待完成" nil]
                        :waiting ["warning" "◷" "等待中" (some-> (:reason data) name)]
                        nil)))]
    (build-result-card theme raw (boolean (some-> options .-expanded)) summary)))

(defn handoff-render-call [args options theme]
  (let [m (safe-args args)
        md (:markdown m)
        tag (if (string? md)
              (str (count md) " chars")
              "上下文交接")]
    (build-call-card theme "Handoff" tag m (boolean (some-> options .-expanded)))))

(defn handoff-render-result [result options theme]
  (let [raw (result-text result)
        data (safe-read-edn raw)
        err? (boolean (some-> result .-isError))
        summary (or (error-summary data err?)
                    (when (and (map? data) (= :handoff-queued (:state data)))
                      ["success" "✓" "已排队交接"
                       (str (or (:markdown-chars data) 0) " chars"
                            (when-let [b (:build data)] (str " · " b)))]))]
    (build-result-card theme raw (boolean (some-> options .-expanded)) summary)))

(defn- review-call-tag [m]
  (let [findings (:findings m)
        n (if (sequential? findings) (count findings) 0)
        base (if (pos? n) (str n " 条台账") "空账确认")]
    (if (string? (:summary_markdown m))
      (str base " · 含总结")
      base)))

(defn- review-render-call [args options theme]
  (let [m (safe-args args)
        body (if (contains? m :findings) m (assoc m :findings []))]
    (build-call-card theme "Submit Review" (review-call-tag m) body (boolean (some-> options .-expanded)))))

(defn- review-render-result [result options theme]
  (let [raw (result-text result)
        data (safe-read-edn raw)
        err? (boolean (some-> result .-isError))
        summary (or (error-summary data err?)
                    (when (map? data)
                      (case (:status data)
                        :review-quiescent ["success" "✓" "空账达标"
                                           (when-let [a (:expected-attach data)] (str "待调用 " (name a)))]
                        :review-open ["warning" "◷" "台账未结"
                                      (when (number? (:open-tasks data))
                                        (str (:open-tasks data) " 项待处理"))]
                        :completed ["dim" "·" "使命已完结" (some-> (:slug data) str)]
                        :audit-passed ["success" "✓" "审计全部通过" "已结案"]
                        :reviewer-started ["success" "✓" "Reviewer 已启动" nil]
                        :reviewer-running ["success" "✓" "Reviewer 运行中" nil]
                        (when (:ok data)
                          (let [findings (:findings data)]
                            (if (and (number? findings) (pos? findings))
                              ["success" "✓" "已立账并唤醒蜂群" (str findings " 条台账")]
                              ["success" "✓" "评审已提交" (some-> (:stage data) name)]))))))]
    (build-result-card theme raw (boolean (some-> options .-expanded)) summary)))

(defn- attach-call-tag [stage-transition m]
  (let [md (:markdown m)
        pml (:promela m)
        cases (:cases m)]
    (cond
      (sequential? cases) (str stage-transition " · " (count cases) " 个 CASE")
      (string? pml) (str stage-transition " · md " (count (or md "")) " / pml " (count pml) " chars")
      (string? md) (str stage-transition " · " (count md) " chars")
      :else stage-transition)))

(defn- attach-render-result [result options theme]
  (let [raw (result-text result)
        data (safe-read-edn raw)
        err? (boolean (some-> result .-isError))
        summary (or (error-summary data err?)
                    (when (map? data)
                      (case (:status data)
                        :attached ["success" "✓" "已提交晋级"
                                   (let [from (:stage data)
                                         to (:next-stage data)]
                                     (when (and from to)
                                       (str (name from) " → " (name to))))]
                        :revision-requested ["warning" "◷" "退回修改"
                                             (or (one-line (:feedback data) 48) "留在 S1")]
                        :denied ["error" "✗" "已拒绝批准"
                                 (or (one-line (:feedback data) 48) "等待人工说明")]
                        :awaiting-user ["warning" "◷" "等待手工批准" "S1 确认面板"]
                        nil)))]
    (build-result-card theme raw (boolean (some-> options .-expanded)) summary)))

(defn- ask-user-render-call [args options theme]
  (let [m (safe-args args)
        slug (:slug m)
        q (one-line (:question m) 36)
        tag (str/join " · " (remove str/blank? [slug q]))]
    (build-call-card theme "Ask User" tag m (boolean (some-> options .-expanded)))))

(defn- ask-user-render-result [result options theme]
  (let [raw (result-text result)
        data (safe-read-edn raw)
        err? (boolean (some-> result .-isError))
        summary (or (error-summary data err?)
                    (when (map? data)
                      (case (:status data)
                        :answered ["success" "✓" "用户已回答" (one-line (:answer data) 48)]
                        :awaiting-user ["warning" "◷" "等待用户回答" (some-> (:stage data) name)]
                        nil)))]
    (build-result-card theme raw (boolean (some-> options .-expanded)) summary)))

(defn- devops-render-call [args options theme]
  (let [m (safe-args args)
        slug (:slug m)
        intent (one-line (:verbose_intent m) 36)
        tag (str/join " · " (remove str/blank? [slug intent]))]
    (build-call-card theme "DevOps Investigation" tag m (boolean (some-> options .-expanded)))))

(defn- devops-render-result [result options theme]
  (let [raw (result-text result)
        data (safe-read-edn raw)
        err? (boolean (some-> result .-isError))
        paths (get-in data [:report :inspected_paths])
        n (if (sequential? paths) (count paths) 0)
        summary (or (error-summary data err?)
                    (when (map? data)
                      (case (:status data)
                        :devops-report ["success" "✓" "调查完成" (when (pos? n) (str n " 个路径"))]
                        :blocked ["warning" "◷" "调查受阻" (when (pos? n) (str n " 个路径"))]
                        (when (:ok data)
                          ["success" "✓" "调查完成" (when (pos? n) (str n " 个路径"))]))))]
    (build-result-card theme raw (boolean (some-> options .-expanded)) summary)))

(defn- submit-devops-render-call [args options theme]
  (let [m (safe-args args)
        status (:status m)
        paths (:inspected_paths m)
        tag (str/join " · " (remove str/blank?
                              [(when (string? status) status)
                               (when (sequential? paths) (str (count paths) " 路径"))]))]
    (build-call-card theme "Submit DevOps Report" tag m (boolean (some-> options .-expanded)))))

(defn- submit-devops-render-result [result options theme]
  (let [raw (result-text result)
        data (safe-read-edn raw)
        err? (boolean (some-> result .-isError))
        summary (or (error-summary data err?)
                    (when (and (map? data) (= :devops-report-submitted (:status data)))
                      ["success" "✓" "报告已提交" (some-> (:stage data) name)]))]
    (build-result-card theme raw (boolean (some-> options .-expanded)) summary)))

(defn gate-renderers [tool-name]
  (case (keyword tool-name)
    :review
    {:renderCall review-render-call
     :renderResult review-render-result}

    :attach_brainstorm
    {:renderCall (fn [args options theme]
                   (let [m (safe-args args)]
                     (build-call-card theme "Attach Brainstorm" (attach-call-tag "S1 → S2" m) m (boolean (some-> options .-expanded)))))
     :renderResult attach-render-result}

    :attach_manual_tests
    {:renderCall (fn [args options theme]
                   (let [m (safe-args args)]
                     (build-call-card theme "Attach Manual Tests" (attach-call-tag "S2 → S3" m) m (boolean (some-> options .-expanded)))))
     :renderResult attach-render-result}

    :attach_dev_guide
    {:renderCall (fn [args options theme]
                   (let [m (safe-args args)]
                     (build-call-card theme "Attach Dev Guide" (attach-call-tag "S3 → S4" m) m (boolean (some-> options .-expanded)))))
     :renderResult attach-render-result}

    :attach_coordination
    {:renderCall (fn [args options theme]
                   (let [m (safe-args args)]
                     (build-call-card theme "Attach Coordination" (attach-call-tag "S4 → S5" m) m (boolean (some-> options .-expanded)))))
     :renderResult attach-render-result}

    :ask_user
    {:renderCall ask-user-render-call
     :renderResult ask-user-render-result}

    :devops
    {:renderCall devops-render-call
     :renderResult devops-render-result}

    :submit_devops_report
    {:renderCall submit-devops-render-call
     :renderResult submit-devops-render-result}

    nil))

(defn- board-call-spec [tool m]
  (case tool
    :board_split
    ["Board Split"
     (str/join " · " (remove str/blank?
                       [(:parent_id m)
                        (when (sequential? (:children m)) (str (count (:children m)) " 子项"))
                        (when (number? (:expected_board_version m)) (str "v" (:expected_board_version m)))]))]

    :board_claim
    ["Board Claim" (:task_id m)]

    :board_finish
    ["Board Finish"
     (str/join " · " (remove str/blank?
                       [(:task_id m)
                        (when (:claim_id m) (str "claim " (:claim_id m)))
                        (when (and (sequential? (:dependency_paths m)) (pos? (count (:dependency_paths m))))
                          (str (count (:dependency_paths m)) " 依赖"))]))]

    :board_cancel
    ["Board Cancel" (:task_id m)]

    :board_replace
    ["Board Replace" (:task_id m)]

    :board_release
    ["Board Release"
     (str/join " · " (remove str/blank?
                       [(:task_id m)
                        (when (:claim_id m) (str "claim " (:claim_id m)))]))]

    :board_reopen
    ["Board Reopen" (:task_id m)]

    :board_comment
    ["Board Comment" (:task_id m)]

    :board_update
    ["Board Update"
     (str/join " · " (remove str/blank?
                       [(:task_id m)
                        (when (map? (:fields m))
                          (str/join "," (map name (keys (:fields m)))))]))]

    :board_park_slot
    ["Board Park Slot"
     (when (number? (:observed_board_version m))
       (str "v" (:observed_board_version m)))]

    :board_take_or_die
    ["Board Take Or Die" (:request_id m)]

    [(humanize-name (name tool)) nil]))

(defn- board-render-result [result options theme]
  (let [raw (result-text result)
        data (safe-read-edn raw)
        err? (boolean (some-> result .-isError))
        receipt (when (map? data) (:receipt data))
        ver (or (:board-version data) (:board-version receipt))
        epoch (or (:wake-epoch data) (:wake-epoch receipt))
        outcome (when (map? receipt) (:outcome receipt))
        revived (when (map? receipt) (:revived-parents receipt))
        meta (str/join " · " (remove str/blank?
                               [(when (number? ver) (str "v" ver))
                                (when (number? epoch) (str "epoch " epoch))
                                (when (and (sequential? revived) (pos? (count revived)))
                                  (str "唤醒父项 " (count revived)))]))
        summary (or (error-summary data err?)
                    (when (map? data)
                      (cond
                        (= :attempt-won outcome)
                        ["success" "✓" "抢令成功 (Holder)" meta]

                        (= :attempt-lost outcome)
                        ["warning" "◷" "抢令落败 (已移交退休)" meta]

                        (= :no-progressable-work outcome)
                        ["dim" "·" "无可执行工作" meta]

                        (:ok data)
                        ["success" "✓" "看板已提交" meta]

                        :else nil)))]
    (build-result-card theme raw (boolean (some-> options .-expanded)) summary)))

(defn board-renderers [tool-name]
  (let [tool (keyword tool-name)]
    {:renderCall (fn [args options theme]
                   (let [m (safe-args args)
                         [title tag] (board-call-spec tool m)]
                     (build-call-card theme title tag m (boolean (some-> options .-expanded)))))
     :renderResult board-render-result}))

(defn audit-render-call [args options theme]
  (let [m (safe-args args)
        cid (:case_id m)
        u (:user_score m)
        d (:developer_score m)
        scores (when (and (number? u) (js/Number.isFinite u)
                          (number? d) (js/Number.isFinite d))
                 (str "U:" u " D:" d " (min " (min u d) ")"))
        tag (str/join " · " (remove str/blank? [cid scores]))]
    (build-call-card theme "Attach Case Audit" tag m (boolean (some-> options .-expanded)))))

(defn audit-render-result [result options theme]
  (let [raw (result-text result)
        data (safe-read-edn raw)
        err? (boolean (some-> result .-isError))
        summary (or (error-summary data err?)
                    (when (and (map? data) (= :audit-submitted (:status data)))
                      ["success" "✓" "审计已提交" (some-> (:case-id data) str)]))]
    (build-result-card theme raw (boolean (some-> options .-expanded)) summary)))