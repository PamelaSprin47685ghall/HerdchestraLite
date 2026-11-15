(ns cljs.gates-test
  (:require
   ["node:fs" :as fs]
   ["node:os" :as os]
   ["node:path" :as path]
   [clojure.string :as str]
   [herd.stages.gates :as gates]
   [herd.stages.session-log :as session-log]
   [herd.stages.store :as store]
   [herd.test :as t]
   [promesa.core :as p]))

(def now "2026-11-14T00:00:00.000Z")

(def s1-markdown
  (str/join "\n"
            ["# 一句话目标与用户可见结果"
             "让 dogfood 使命跑到 S2。"
             "# 决策框架"
             "先验证最小闭环。"
             "# 现状事实与根因"
             "默认面只暴露 clj_devops。"
             "# 单向门/双向门"
             "attach 是单向门。"
             "# 事前验尸"
             "失败原因会是未验证磁盘文档。"
             "# Non-Goals"
             "不做多 worktree。"
             "# 成功标准"
             "stage 变为 s2。"
             "# 未决问题"
             "无。"]))

(def s2-cases
  [{:case_id "CASE-1" :path "正常" :threshold 80 :steps ["step"] :expected "expected" :rubric "rubric"}
   {:case_id "CASE-2" :path "错误" :threshold 80 :steps ["step"] :expected "expected" :rubric "rubric"}
   {:case_id "CASE-3" :path "边界" :threshold 80 :steps ["step"] :expected "expected" :rubric "rubric"}
   {:case_id "CASE-4" :path "并发" :threshold 80 :steps ["step"] :expected "expected" :rubric "rubric"}
   {:case_id "CASE-5" :path "恢复" :threshold 80 :steps ["step"] :expected "expected" :rubric "rubric"}])

(def root-counter (atom 0))

(defn- fresh-root []
  (swap! root-counter inc)
  (fs/mkdtempSync (path/join (os/tmpdir) (str "cljs-gates-m-" @root-counter "-"))))

(defn- journal-ctx [root id]
  (let [file (path/join root "sessions" (str id ".jsonl"))]
    #js {:cwd root
         :sessionManager
         #js {:getSessionId (fn [] id)
              :getSessionFile (fn [] file)
              :appendCustomEntry
              (fn [custom-type data]
                (fs/mkdirSync (path/dirname file) #js {:recursive true})
                (fs/appendFileSync
                 file
                 (str (js/JSON.stringify
                       #js {:type "custom"
                            :customType custom-type
                            :data data})
                      "\n")))}}))

(defn- create! [root]
  (store/create-mission! root {:slug "demo"
                               :mission-id "M1"
                               :now now
                               :ctx (journal-ctx root "demo")}))

(defn- service [root & [extra]]
  (gates/create-service
   (merge {:root root :slug "demo" :now (fn [] now)} extra)))

(defn- same [actual expected]
  (t/to-be (= actual expected) true))

(defn- approve-confirm [args]
  (let [target (:path (:pending args))]
    (fs/writeFileSync target (str s1-markdown "\n操作员批准前编辑。\n"))
    {:decision "approve"}))

(t/describe "CLJS gate service"
  (fn []
    (t/it "opens the review on findings and quiesces it on deletion"
      (fn []
        (p/let [root (fresh-root)
                _ (create! root)
                ctx (journal-ctx root "demo")
                _ (session-log/append! ctx "herd.task" {:sessionId "demo" :createdAt now})
                file (str root "/sessions/demo.jsonl")
                file-exists (fs/existsSync file)
                svc (service root)
                open ((:review! svc) {:findings [{:key "K1" :value "V1"}]} {})
                closed ((:review! svc) {:findings [{:key "K1" :value nil}]} {})]
          (t/to-be file-exists true)
          (t/to-be (= (:status open) :review-open) true)
          (t/to-be (:open-tasks open) 1)
          (t/to-be (:attach-ready open) false)
          (t/to-be (= (:status closed) :review-quiescent) true)
          (t/to-be (:open-tasks closed) 0)
          (t/to-be (:attach-ready closed) true))))
    (t/it "refuses attach before an empty review quiesces the board"
      (fn []
        (p/let [root (fresh-root)
                _ (create! root)
                svc (service root {:confirm (fn [_] {:decision "approve"})})
                _ ((:review! svc) {} {})
                _ ((:attach! svc) :attach_brainstorm {:markdown s1-markdown} {})
                attached ((:attach! svc) :attach_manual_tests
                          {:markdown "S2 方法论。" :cases s2-cases} {})]
          (t/to-be (:ok attached) false)
          (t/to-be (get-in attached [:error :code]) :ATTACH_NOT_READY))))
    (t/it "approves S1 with the on-disk document and opens S2"
      (fn []
        (p/let [root (fresh-root)
                _ (create! root)
                svc (service root {:confirm approve-confirm})
                reviewed ((:review! svc) {} {})
                attached ((:attach! svc) :attach_brainstorm {:markdown s1-markdown} {})
                mission (store/read-mission root "demo")
                disk (fs/readFileSync (str root "/herd/demo/s1-brainstorm.md") "utf8")]
          (t/to-be (= (:status reviewed) :review-quiescent) true)
          (t/to-be (= (:status attached) :attached) true)
          (t/to-be (= (:next-stage attached) :s2) true)
          (t/to-be (str/includes? (:briefing attached) "STAGE S1 ATTACHED") true)
          (t/to-be (= (:stage (:mission mission)) :s2) true)
          (t/to-be (= (get-in mission [:mission :tenure :tenure-id]) "T-2") true)
          (t/to-be (get-in mission [:mission :attach :pending]) nil)
          (t/to-be (fs/existsSync (str root "/herd/demo/boards/T-1.edn")) false)
          (t/to-be (str/includes? disk "操作员批准前编辑。") true))))
    (t/it "keeps S1 open on revise and re-arms on a new empty review"
      (fn []
        (p/let [root (fresh-root)
                _ (create! root)
                svc (service root {:confirm (fn [_] {:decision "revise" :feedback "补充用户证据"})})
                _ ((:review! svc) {} {})
                revised ((:attach! svc) :attach_brainstorm {:markdown s1-markdown} {})
                after (store/read-mission root "demo")
                rearmed ((:review! svc) {} {})]
          (t/to-be (= (:status revised) :revision-requested) true)
          (t/to-be (:feedback revised) "补充用户证据")
          (t/to-be (= (:stage (:mission after)) :s1) true)
          (t/to-be (get-in after [:mission :attach :ready]) false)
          (t/to-be (:attach-ready rearmed) true))))
    (t/it "records an S1 pending approval and refuses a second attach"
      (fn []
        (p/let [root (fresh-root)
                _ (create! root)
                svc (service root)
                _ ((:review! svc) {} {})
                first ((:attach! svc) :attach_brainstorm {:markdown s1-markdown} {})
                mission (store/read-mission root "demo")
                again ((:attach! svc) :attach_brainstorm {:markdown s1-markdown} {})]
          (t/to-be (= (:status first) :awaiting-user) true)
          (t/to-be (= (:reason first) :host-confirm-unavailable) true)
          (t/to-be (boolean (get-in mission [:mission :attach :pending])) true)
          (t/to-be (:ok again) false)
          (t/to-be (get-in again [:error :code]) :ATTACH_ALREADY_PENDING))))
    (t/it "recovers a pending S1 attach after a service restart with the same call id"
      (fn []
        (p/let [root (fresh-root)
                _ (create! root)
                svc (service root)
                _ ((:review! svc) {} {})
                pending ((:attach! svc) :attach_brainstorm
                         {:markdown s1-markdown} {:call-id "crash-1"})
                pending-mission (store/read-mission root "demo")
                restarted (service root)
                recovered ((:attach! restarted) :attach_brainstorm
                           {:markdown s1-markdown} {:call-id "crash-1"})
                mission (store/read-mission root "demo")]
          (t/to-be (= (:status pending) :awaiting-user) true)
          (t/to-be (boolean (get-in pending-mission [:mission :attach :pending])) true)
          (t/to-be (= (:status recovered) :attached) true)
          (t/to-be (= (:next-stage recovered) :s2) true)
          (t/to-be (= (get-in mission [:mission :stage]) :s2) true)
          (t/to-be (get-in mission [:mission :attach :pending]) nil))))
    (t/it "returns denied feedback and clears the pending attach"
      (fn []
        (p/let [root (fresh-root)
                _ (create! root)
                svc (service root {:confirm (fn [_] {:decision "deny" :feedback "目标不清楚"})})
                _ ((:review! svc) {} {})
                denied ((:attach! svc) :attach_brainstorm {:markdown s1-markdown} {})
                mission (store/read-mission root "demo")]
          (t/to-be (= (:status denied) :denied) true)
          (t/to-be (:feedback denied) "目标不清楚")
          (t/to-be (= (:stage (:mission mission)) :s1) true)
          (t/to-be (get-in mission [:mission :attach :pending]) nil))))
    (t/it "writes S2 deliverables and advances to S3"
      (fn []
        (p/let [root (fresh-root)
                _ (create! root)
                svc (service root {:confirm (fn [_] {:decision "approve"})})
                _ ((:review! svc) {} {})
                _ ((:attach! svc) :attach_brainstorm {:markdown s1-markdown} {})
                _ ((:review! svc) {} {})
                attached ((:attach! svc) :attach_manual_tests
                          {:markdown "S2 方法论。" :cases s2-cases} {})
                mission (store/read-mission root "demo")]
          (t/to-be (= (:status attached) :attached) true)
          (t/to-be (= (:next-stage attached) :s3) true)
          (t/to-be (str/includes? (:briefing attached) "STAGE S2 ATTACHED") true)
          (t/to-be (= (:stage (:mission mission)) :s3) true)
          (t/to-be (= (get-in mission [:mission :tenure :tenure-id]) "T-3") true)
          (t/to-be (str/includes? (fs/readFileSync (str root "/herd/demo/s2-manual-tests.md") "utf8") "S2 方法论") true)
          (t/to-be (str/includes? (fs/readFileSync (str root "/herd/demo/s2-cases.edn") "utf8") "CASE-5") true))))
    (t/it "replays one call id and rejects a changed payload"
      (fn []
        (p/let [root (fresh-root)
                _ (create! root)
                svc (service root {:confirm (fn [_] {:decision "approve"})})
                _ ((:review! svc) {} {})
                first ((:attach! svc) :attach_brainstorm {:markdown s1-markdown} {:call-id "c1"})
                second ((:attach! svc) :attach_brainstorm {:markdown s1-markdown} {:call-id "c1"})
                mission (store/read-mission root "demo")
                mismatch ((:attach! svc) :attach_brainstorm {:markdown "另一份完全不同的文档"} {:call-id "c1"})]
          (t/to-be (= (:status first) :attached) true)
          (t/to-be (= (:status second) :attached) true)
          (t/to-be (= (get-in mission [:mission :tenure :tenure-id]) "T-2") true)
          (t/to-be (:ok mismatch) false)
          (t/to-be (get-in mismatch [:error :code]) :CALL_REPLAY_MISMATCH))))
    (t/it "denies a role outside the gate surface"
      (fn []
        (p/let [root (fresh-root)
                _ (create! root)
                svc (service root {:role "Manual Auditor"})
                reviewed ((:review! svc) {} {})]
          (t/to-be (:ok reviewed) false)
          (t/to-be (get-in reviewed [:error :code]) :CAPABILITY_DENIED))))
    (t/it "asks one S1 question through the injected host"
      (fn []
        (p/let [root (fresh-root)
                _ (create! root)
                svc (service root {:ask-user (fn [args]
                                               {:ok true
                                                :answer (str "回答：" (:question args))})})
                asked ((:ask-user! svc) {:question "哪个用户价值最高？"
                                         :context "需要排序"
                                         :recommended_default "先做 A"} {})]
          (t/to-be (= (:status asked) :answered) true)
          (t/to-be (str/includes? (:answer asked) "哪个用户价值最高？") true))))
    (t/it "forbids ask_user outside S1 and the S5 exception"
      (fn []
        (p/let [root (fresh-root)
                _ (create! root)
                _ (store/update-mission! root "demo"
                                         {:barrier {:from :s2 :to :s3
                                                    :retired-tenure "T-1"
                                                    :successor-tenure "T-2"
                                                    :at now}})
                svc (service root)
                asked ((:ask-user! svc) {:question "问题？"
                                         :context "上下文"
                                         :recommended_default "默认"} {})]
          (t/to-be (:ok asked) false)
          (t/to-be (get-in asked [:error :code]) :ASK_FORBIDDEN_OUTSIDE_S1))))
    (t/it "runs devops through its port and accepts the report"
      (fn []
        (p/let [root (fresh-root)
                _ (create! root)
                svc (service root {:run-devops (fn [_] {:ok true
                                                        :status "devops-report"
                                                        :agent-id "A1"
                                                        :report {:summary "ok"}})
                                   :accept-devops-report (fn [_] {:ok true})})
                devops ((:devops! svc) {:verbose_intent "查清调用链"} {})
                report ((:submit-devops-report! svc)
                        {:status "ok"
                         :report_markdown "报告正文"
                         :inspected_paths ["src/herd/main.cljs"]} {})]
          (t/to-be (:ok devops) true)
          (t/to-be (:status devops) "devops-report")
          (t/to-be (:agent-id devops) "A1")
          (t/to-be (:ok report) true)
          (t/to-be (= (:status report) :devops-report-submitted) true))))
    (t/it "executes a registered tool through the host bridge"
      (fn []
        (p/let [root (fresh-root)
                _ (create! root)
                defs (atom [])
                _ (gates/register-all! (fn [definition] (swap! defs conj definition))
                                       {:root root :slug "demo"})
                review (some (fn [definition]
                               (when (= "review" (:name definition)) definition))
                             @defs)
                result ((:execute review) "call-1" #js {} nil nil #js {:cwd root})
                text (get-in result [:content 0 :text])]
          (t/to-be (nil? (:isError result)) true)
          (t/to-be (str/includes? text ":status :review-quiescent") true))))
    (t/it "exports the eight gate tool definitions"
      (fn []
        (p/let [root (fresh-root)
                defs (atom [])
                service (gates/register-all! (fn [definition] (swap! defs conj definition))
                                             {:root root :slug "demo"})]
          (t/to-be (= (mapv :name @defs)
                      ["review" "attach_brainstorm" "attach_manual_tests"
                       "attach_dev_guide" "attach_coordination" "ask_user"
                       "devops" "submit_devops_report"]) true)
          (t/to-be (= (mapv (fn [definition]
                              (vec (:required (:parameters definition))))
                            @defs)
                      [[] ["markdown"] ["markdown" "cases"] ["markdown"]
                       ["markdown" "promela"] ["question"] ["verbose_intent"]
                       ["status" "report_markdown" "inspected_paths"]]) true)
          (t/to-be (every? (fn [definition] (fn? (:execute definition))) @defs) true)
          (t/to-be (some? service) true))))))

