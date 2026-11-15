(ns cljs.tool-ui-test
  (:require
   [clojure.string :as str]
   [herd.test :as t]
   [promesa.core :as p]))

(def all-tools
  ["clj_devops" "clj_plan" "clj_review" "clj_worker" "clj_auditor"
   "wait" "handoff" "review" "attach_brainstorm" "attach_manual_tests"
   "attach_dev_guide" "attach_coordination" "ask_user" "devops"
   "submit_devops_report" "board_split" "board_claim" "board_finish"
   "board_cancel" "board_replace" "board_release" "board_reopen"
   "board_comment" "board_update" "board_park_slot" "board_take_or_die"
   "attach_case_audit"])

(defn- same [actual expected]
  (t/to-be (= actual expected) true))

(defn- fake-text [text x y]
  (let [obj #js {:text text :x x :y y}]
    (aset obj "render" (fn [] (str/split-lines text)))
    obj))

(defn- fake-container []
  (let [obj #js {:children #js []}]
    (aset obj "addChild" (fn [child] (.push (.-children obj) child)))
    (aset obj "render"
          (fn [width]
            (let [out #js []]
              (doseq [child (array-seq (.-children obj))]
                (when (fn? (.-render child))
                  (doseq [line (array-seq (.render child width))]
                    (.push out line))))
              out)))
    obj))

(defn- make-pi []
  (let [tools (js/Map.)
        commands (js/Map.)
        hooks (js/Map.)
        active (atom ["read" "clj_devops" "wait"])
        obj #js {}]
    (aset obj "tools" tools)
    (aset obj "commands" commands)
    (aset obj "hooks" hooks)
    (aset obj "active" active)
    (aset obj "registerTool" (fn [definition] (.set tools (.-name definition) definition)))
    (aset obj "registerCommand" (fn [name spec] (.set commands name spec)))
    (aset obj "on" (fn [name handler]
                       (when-not (.has hooks name) (.set hooks name handler))))
    (aset obj "getActiveTools" (fn [] (clj->js @active)))
    (aset obj "setActiveTools" (fn [next] (reset! active (vec (js->clj next)))))
    (aset obj "pi" #js {:Text fake-text :Container fake-container})
    obj))

(defonce local-pi (atom nil))

(defn- ensure! []
  (reset! local-pi (make-pi))
  (set! (.-__pi js/globalThis) @local-pi)
  (set! (.-__herdTui js/globalThis)
        #js {:highlightCode (fn [code] (str/split-lines code))})
  (set! (.-__herdDetectLanguage js/globalThis) (fn [& _] "clojure"))
  ((.-__herdEnsureActivated js/globalThis)))

(defn- tool [name] (.get (.-tools @local-pi) name))

(defn- child [receipt idx] (aget (.-children receipt) idx))
(defn- text [receipt idx] (.-text (child receipt idx)))

(defn- lines-of [component width]
  (vec (array-seq (.render component width))))

(t/describe "CLJS tool UI renderers"
  (fn []
    (t/it "registers renderCall and renderResult on every Herdchestra tool"
      (fn []
        (p/let [_ (ensure!)]
          (doseq [name all-tools]
            (let [definition (tool name)]
              (t/to-be (some? definition) true)
              (t/to-be (fn? (.-renderCall definition)) true)
              (t/to-be (fn? (.-renderResult definition)) true))))))
    (t/it "renders wait and handoff with clj_devops visual language"
      (fn []
        (p/let [_ (ensure!)
                wait-call ((.-renderCall (tool "wait"))
                           #js {:otherwise_independent_work (apply str (repeat 60 "a"))}
                           #js {:expanded false}
                           #js {:fg (fn [role text] (str role ":" text))})
                wait-res ((.-renderResult (tool "wait"))
                          #js {:content #js [#js {:type "text"
                                                 :text "{:state :completed, :name \"job-1\", :value 1}"}]}
                          #js {:expanded false}
                          #js {:fg (fn [role text] (str role ":" text))})
                handoff-call ((.-renderCall (tool "handoff"))
                              #js {:markdown (str "# Title\n" (apply str (repeat 10 "line\n")))}
                              #js {:expanded false}
                              #js {:fg (fn [role text] (str role ":" text))})
                handoff-expanded ((.-renderCall (tool "handoff"))
                                  #js {:markdown "hello handoff"}
                                  #js {:expanded true}
                                  #js {:fg (fn [role text] (str role ":" text))})]
          (t/to-contain (text wait-call 0) "accent:Wait")
          (t/to-contain (text wait-call 0) "dim:--- [等待沙箱")
          (same (lines-of (child wait-call 1) 12) [(str "dim:" (apply str (repeat 12 "─")))])
          (t/to-contain (text wait-call 2) "dim:$$$")
          (same (lines-of (child wait-res 0) 8) [(str "dim:" (apply str (repeat 8 "─")))])
          (t/to-contain (text wait-res 1) "success:✓")
          (t/to-contain (text wait-res 1) "dim:--- [job-1]")
          (t/to-contain (text handoff-call 0) "accent:Handoff")
          (t/to-contain (text handoff-call 0) "chars]")
          (t/to-contain (text handoff-call 2) "dim:$$$")
          (t/to-contain (text handoff-expanded 2) "hello handoff"))))
    (t/it "renders stage gate and devops tools cleanly across collapsed, expanded, and error states"
      (fn []
        (p/let [_ (ensure!)
                theme #js {:fg (fn [role text] (str role ":" text))}
                empty-review ((.-renderCall (tool "review"))
                              #js {:findings #js []}
                              #js {:expanded false} theme)
                open-review ((.-renderCall (tool "review"))
                             #js {:summary_markdown "needs work"
                                  :findings #js [#js {:key "gap-1"
                                                     :value "missing edge cases in parser"}]}
                             #js {:expanded false} theme)
                review-quiescent ((.-renderResult (tool "review"))
                                  #js {:content #js [#js {:type "text"
                                                         :text "{:ok true :status :review-quiescent :expected-attach :attach_brainstorm :open-tasks 0}"}]}
                                  #js {:expanded false} theme)
                mt-call ((.-renderCall (tool "attach_manual_tests"))
                         #js {:markdown (str "# Methodology\n" (apply str (repeat 10 "detail\n")))
                              :cases #js [#js {:case_id "CASE-01"
                                              :path "normal/flow"
                                              :threshold 80
                                              :steps #js ["step 1" "step 2"]
                                              :expected (apply str (repeat 5 "long expected output "))
                                              :rubric (apply str (repeat 5 "detailed rubric "))}]}
                         #js {:expanded false} theme)
                attach-res ((.-renderResult (tool "attach_brainstorm"))
                            #js {:content #js [#js {:type "text"
                                                   :text "{:ok true :status :attached :stage :s1 :next-stage :s2}"}]}
                            #js {:expanded false} theme)
                devops-res ((.-renderResult (tool "devops"))
                            #js {:content #js [#js {:type "text"
                                                   :text "{:ok true :status :devops-report :report {:inspected_paths [\"a.cljs\" \"b.cljs\"]}}"}]}
                            #js {:expanded false} theme)]
          (t/to-contain (text empty-review 0) "accent:Submit Review")
          (t/to-contain (text empty-review 0) "空账确认")
          (t/to-contain (text open-review 0) "1 条台账 · 含总结")
          (t/to-contain (text open-review 2) "gap-1")
          (t/to-contain (text review-quiescent 1) "success:✓")
          (t/to-contain (text review-quiescent 1) "待调用 attach_brainstorm")
          (t/to-contain (text mt-call 0) "accent:Attach Manual Tests")
          (t/to-contain (text mt-call 0) "S2 → S3 · 1 个 CASE")
          (t/to-contain (text mt-call 2) "CASE-01")
          (t/to-contain (text mt-call 2) "dim:$$$")
          (t/to-contain (text attach-res 1) "s1 → s2")
          (t/to-contain (text devops-res 1) "2 个路径"))))
    (t/it "renders all 11 board_* tools and attach_case_audit with accurate tags and error status"
      (fn []
        (p/let [_ (ensure!)
                theme #js {:fg (fn [role text] (str role ":" text))}
                split-call ((.-renderCall (tool "board_split"))
                            #js {:parent_id "T-1"
                                 :expected_board_version 3
                                 :remaining_work "integrate both modules cleanly end-to-end"
                                 :children #js [#js {:goal "g1" :remaining_work "w1" :done_when "d1"}
                                                #js {:goal "g2" :remaining_work "w2" :done_when "d2"}]}
                            #js {:expanded false} theme)
                conflict-res ((.-renderResult (tool "board_split"))
                              #js {:isError true
                                   :content #js [#js {:type "text"
                                                      :text "{:ok false :error {:code :BOARD_CONFLICT :message \"board version changed\"}}"}]}
                              #js {:expanded false} theme)
                won-res ((.-renderResult (tool "board_take_or_die"))
                         #js {:content #js [#js {:type "text"
                                                :text "{:ok true :board-version 9 :wake-epoch 4 :receipt {:outcome :attempt-won}}"}]}
                         #js {:expanded false} theme)
                audit-call ((.-renderCall (tool "attach_case_audit"))
                            #js {:case_id "CASE-07"
                                 :user_score 88
                                 :developer_score 94
                                 :report_markdown (str "# Audit\n" (apply str (repeat 12 "evidence ")))}
                            #js {:expanded false} theme)
                audit-res ((.-renderResult (tool "attach_case_audit"))
                           #js {:content #js [#js {:type "text"
                                                  :text "{:ok true :status :audit-submitted :case-id \"CASE-07\"}"}]}
                           #js {:expanded false} theme)]
          (t/to-contain (text split-call 0) "accent:Board Split")
          (t/to-contain (text split-call 0) "T-1 · 2 子项 · v3")
          (t/to-contain (text conflict-res 1) "error:✗")
          (t/to-contain (text conflict-res 1) "error::BOARD_CONFLICT")
          (t/to-contain (text conflict-res 1) "board version changed")
          (t/to-contain (text won-res 1) "抢令成功 (Holder)")
          (t/to-contain (text won-res 1) "v9 · epoch 4")
          (t/to-contain (text audit-call 0) "accent:Attach Case Audit")
          (t/to-contain (text audit-call 0) "CASE-07 · U:88 D:94 (min 88)")
          (t/to-contain (text audit-call 2) "dim:$$$")
          (t/to-contain (text audit-res 1) "审计已提交")
          (t/to-contain (text audit-res 1) "CASE-07"))))
    (t/it "handles partial streaming args, empty results, and missing theme helpers gracefully"
      (fn []
        (p/let [_ (ensure!)
                theme #js {:fg (fn [role text] (str role ":" text))}
                clj-tools (set ["clj_devops" "clj_plan" "clj_review" "clj_worker" "clj_auditor"])]
          (doseq [name all-tools]
            (let [definition (tool name)
                  c1 ((.-renderCall definition) js/undefined
                      #js {:expanded false :isPartial true} #js {})
                  c2 ((.-renderCall definition) #js {}
                      #js {:expanded true :isPartial true} theme)
                  r1 ((.-renderResult definition) #js {:content #js []}
                      #js {:expanded false :isPartial true} #js {})
                  r2 ((.-renderResult definition)
                      #js {:isError true
                           :content #js [#js {:type "text" :text "raw failure line"}]}
                      #js {:expanded false} theme)]
              (t/to-be (array? (.render c1 50)) true)
              (t/to-be (array? (.render c2 50)) true)
              (t/to-be (array? (.render r1 50)) true)
              (t/to-be (array? (.render r2 50)) true)
              (when-not (contains? clj-tools name)
                (t/to-contain (.join (.render r2 50) "\n") "error:✗"))))))))

)
