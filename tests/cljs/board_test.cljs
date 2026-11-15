(ns cljs.board-test
  (:require
   [herd.swarm.kernel :as kernel]
   [herd.swarm.model :as model]
   [herd.swarm.token :as token]
   [herd.test :as t]))

(defn- same [actual expected]
  (t/to-be (= actual expected) true))

(defn- step [board command request actor turn]
  (kernel/apply-command board
                        {:command command
                         :actor actor
                         :turn-id (or turn "turn")
                         :request-id request}))

(defn- reg [board id slot request]
  (step board {:type "register_actor" :agentId id :slotId slot} request nil "boot"))

(defn- add-task [board actor request spec]
  (step board {:type "add_tasks" :tasks [spec]} request actor "add"))

(defn- claim [board actor request task-id reason]
  (step board {:type "claim" :taskId task-id :atomicityReason (or reason "atomic")}
        request actor "claim"))

(defn- finish [board actor request task-id claim-id paths]
  (step board {:type "finish" :taskId task-id :claimId claim-id
               :resultSummary "finished" :dependency_paths (or paths ["src/a.cljs"])}
        request actor "finish"))

(t/describe "CLJS board kernel"
  (fn []
    (t/it "splits, revives a parent to ready and rejects a same-turn finish"
      (fn []
        (let [s0 (model/initial-board {:mode :swarm})
              r1 (reg s0 "A" "S1" "r1")
              r2 (reg (:board r1) "B" "S2" "r2")
              r3 (add-task (:board r2) "A" "r3"
                           {:goal "root" :remaining_work "integrate" :done_when "green"})
              parent (first (get-in r3 [:receipt :task-ids]))
              r4 (step (:board r3)
                       {:type "split" :parentId parent
                        :remaining_work "wire and integrate"
                        :children [{:goal "part-1" :remaining_work "do-1" :done_when "done-1"}
                                   {:goal "part-2" :remaining_work "do-2" :done_when "done-2"}]
                        :expected_board_version (get-in r3 [:board :board-version])}
                       "r4" "A" "split")
              children (get-in r4 [:receipt :child-ids])
              c1 (first children) c2 (second children)
              a1 (claim (:board r4) "A" "r5" c1)
              f1 (finish (:board a1) "A" "r6" c1 (get-in a1 [:receipt :claim-id]))
              a2 (claim (:board f1) "B" "r7" c2)
              f2 (finish (:board a2) "B" "r8" c2 (get-in a2 [:receipt :claim-id]))
              parent-state (get-in f2 [:board :tasks parent :state])
              bad (finish (:board f2) "A" "r9" parent
                          (get-in f2 [:board :tasks parent :claim-id]) ["src/a.cljs"])]
          (t/to-be (:ok r4) true)
          (t/to-be (name (get-in r4 [:board :tasks parent :state])) "waiting")
          (same (get-in f2 [:receipt :revived-parent-ids]) [parent])
          (t/to-be (name parent-state) "ready")
          (t/to-be (name (get-in bad [:error :code])) "PARENT_NOT_READY"))))
    (t/it "keeps claim ownership and releases only before applying"
      (fn []
        (let [s0 (model/initial-board {:mode :swarm})
              r1 (reg s0 "A" "S1" "r1")
              r2 (reg (:board r1) "B" "S2" "r2")
              r3 (add-task (:board r2) "A" "r3"
                           {:goal "job" :remaining_work "work" :done_when "done"})
              task-id (first (get-in r3 [:receipt :task-ids]))
              a1 (claim (:board r3) "A" "r4" task-id)
              claim-id (get-in a1 [:receipt :claim-id])
              wrong (finish (:board a1) "B" "r5" task-id claim-id)
              rel (step (:board a1) {:type "release" :taskId task-id :claimId claim-id}
                        "r6" "A" "rel")
              claim-b (claim (:board rel) "B" "r7" task-id "atomic-b")
              start (step (:board claim-b)
                          {:type "start_action" :taskId task-id
                           :claimId (get-in claim-b [:receipt :claim-id])
                           :kind "edit" :phase "applying"}
                          "r8" "B" "act")
              late (step (:board start)
                         {:type "release" :taskId task-id
                          :claimId (get-in claim-b [:receipt :claim-id])}
                         "r9" "B" "rel2")]
          (t/to-be (name (get-in wrong [:error :code])) "CLAIM_CHANGED")
          (t/to-be (:ok rel) true)
          (t/to-be (get-in rel [:board :tasks task-id :owner-id]) nil)
          (t/to-be (:ok claim-b) true)
          (t/to-be (name (get-in late [:error :code])) "CLAIM_CHANGED"))))
    (t/it "runs one irreversible token race and retires a holder without responsibility"
      (fn []
        (let [s0 (model/initial-board {:mode :swarm})
              r1 (reg s0 "A" "S1" "r1")
              r2 (reg (:board r1) "B" "S2" "r2")
              r3 (add-task (:board r2) "A" "r3"
                           {:goal "token-job" :remaining_work "run-tests"
                            :done_when "green" :needs_token true})
              token-task (first (get-in r3 [:receipt :task-ids]))
              take-a (step (:board r3)
                           {:type "take_or_die"
                            :confirm token/take-or-die-confirmation
                            :handoff_markdown "A handoff"}
                           "r4" "A" "take-a")
              take-b (step (:board take-a)
                           {:type "take_or_die"
                            :confirm token/take-or-die-confirmation
                            :handoff_markdown "B handoff"}
                           "r5" "B" "take-b")
              a-claim (claim (:board take-b) "A" "r6" token-task "atomic")
              a-finish (finish (:board a-claim) "A" "r7" token-task
                               (get-in a-claim [:receipt :claim-id]))]
          (t/to-be (name (get-in take-a [:receipt :outcome])) "attempt-won")
          (t/to-be (name (get-in take-b [:receipt :outcome])) "attempt-lost")
          (t/to-be (get-in take-a [:board :token-slot :holder-id]) "A")
          (t/to-be (name (get-in take-b [:board :actors "B" :life-state])) "dead")
          (t/to-be (name (get-in a-finish [:board :token-slot :state])) "free")
          (t/to-be (get-in a-finish [:board :token-slot :holder-id]) nil)
          (t/to-be (name (get-in a-finish [:board :actors "A" :life-state])) "dead")
          (same (get-in a-finish [:board :token-slot :retired-terms]) ["TERM-1"])
          (same (vec (model/responsibility-set (:board a-finish) "A")) []))))
    (t/it "parks only on a truly empty board and wakes on user input"
      (fn []
        (let [s0 (model/initial-board {:mode :swarm})
              r1 (reg s0 "A" "S1" "r1")
              r2 (add-task (:board r1) "A" "r2"
                           {:goal "job" :remaining_work "work" :done_when "done"})
              task-id (first (get-in r2 [:receipt :task-ids]))
              rejected (step (:board r2)
                             {:type "park_slot"
                              :observed_board_version (get-in r2 [:board :board-version])}
                             "r3" "A" "park")
              a1 (claim (:board r2) "A" "r4" task-id)
              f1 (finish (:board a1) "A" "r5" task-id
                         (get-in a1 [:receipt :claim-id]))
              parked (step (:board f1)
                           {:type "park_slot"
                            :observed_board_version (get-in f1 [:board :board-version])}
                           "r6" "A" "park2")
              input (step (:board parked)
                          {:type "record_input" :text "new requirement"}
                          "r7" nil "user")]
          (t/to-be (name (get-in rejected [:error :code])) "BOARD_CONFLICT")
          (t/to-be (pos? (count (get-in rejected [:error :summary :progressable]))) true)
          (t/to-be (name (get-in parked [:receipt :outcome])) "parked")
          (t/to-be (count (get-in parked [:board :sleepers])) 1)
          (t/to-be (name (get-in input [:receipt :outcome])) "input-recorded")
          (same (vec (keys (get-in input [:board :sleepers]))) [])
          (t/to-be (get-in input [:board :wake :epoch]) 1))))
    (t/it "revives a condition-only parent when the condition resolves"
      (fn []
        (let [s0 (model/initial-board {:mode :swarm})
              r1 (reg s0 "A" "S1" "r1")
              r2 (add-task (:board r1) "A" "r2"
                           {:goal "root" :remaining_work "integrate" :done_when "green"})
              parent (first (get-in r2 [:receipt :task-ids]))
              r3 (step (:board r2)
                       {:type "split" :parentId parent
                        :remaining_work "integrate"
                        :expected_board_version (get-in r2 [:board :board-version])
                        :wait_for ["condition:api-ready"]
                        :children [{:goal "child" :remaining_work "work" :done_when "done"}]}
                       "r3" "A" "split")
              resolved (step (:board r3)
                             {:type "resolve_condition" :key "api-ready" :value true}
                             "r4" "A" "cond")]
          (t/to-be (name (get-in r3 [:board :tasks parent :state])) "waiting")
          (t/to-be (name (get-in resolved [:board :tasks parent :state])) "ready")
          (t/to-be (some #{parent} (get-in resolved [:receipt :revived-task-ids])) parent)
          (same (get-in resolved [:board :tasks parent :wait-for]) []))))
    (t/it "replays one request id and rejects changed payloads"
      (fn []
        (let [s0 (model/initial-board {:mode :swarm})
              r1 (reg s0 "A" "S1" "r1")
              r2 (add-task (:board r1) "A" "r2"
                           {:goal "job" :remaining_work "work" :done_when "done"})
              task-id (first (get-in r2 [:receipt :task-ids]))
              a1 (claim (:board r2) "A" "same" task-id)
              a2 (claim (:board a1) "A" "same" task-id)
              changed (step (:board a1)
                            {:type "claim" :taskId task-id
                             :atomicityReason "different reason"}
                            "same" "A" "claim")]
          (t/to-be (:ok a1) true)
          (t/to-be (:replayed a2) true)
          (t/to-be (= (get-in a1 [:receipt :claim-id]) (get-in a2 [:receipt :claim-id])) true)
          (t/to-be (name (get-in changed [:error :code])) "CALL_REPLAY_MISMATCH"))))
    (t/it "T05/T06 assigns new token tasks before retirement and keeps them free after"
      (fn []
        (let [s0 (model/initial-board {:mode :swarm})
              r1 (reg s0 "A" "S1" "r1")
              r2 (reg (:board r1) "B" "S2" "r2")
              r3 (add-task (:board r2) "A" "r3"
                           {:goal "x" :remaining_work "work-x" :done_when "done-x" :needs_token true})
              tx (first (get-in r3 [:receipt :task-ids]))
              take-a (step (:board r3)
                           {:type "take_or_die" :confirm token/take-or-die-confirmation
                            :handoff_markdown "A holds"}
                           "r4" "A" "take")
              r4 (add-task (:board take-a) "B" "r5"
                           {:goal "y" :remaining_work "work-y" :done_when "done-y" :needs_token true})
              ty (first (get-in r4 [:receipt :task-ids]))
              cx (claim (:board r4) "A" "r6" tx "atomic-x")
              fx (finish (:board cx) "A" "r7" tx (get-in cx [:receipt :claim-id]))
              cy (claim (:board fx) "A" "r8" ty "atomic-y")
              fy (finish (:board cy) "A" "r9" ty (get-in cy [:receipt :claim-id]))
              r5 (add-task (:board fy) "B" "r10"
                           {:goal "z" :remaining_work "work-z" :done_when "done-z" :needs_token true})]
          (t/to-be (name (get-in fx [:board :actors "A" :life-state])) "alive")
          (t/to-be (get-in fx [:board :token-slot :holder-id]) "A")
          (t/to-be (name (get-in fy [:board :actors "A" :life-state])) "dead")
          (t/to-be (name (get-in fy [:board :token-slot :state])) "free")
          (t/to-be (name (get-in r5 [:board :actors "A" :life-state])) "dead")
          (t/to-be (get-in r5 [:board :token-slot :holder-id]) nil))))
    (t/it "T11/V02 rejects late normal submissions from a dead actor"
      (fn []
        (let [s0 (model/initial-board {:mode :swarm})
              r1 (reg s0 "A" "S1" "r1")
              r2 (reg (:board r1) "B" "S2" "r2")
              r3 (add-task (:board r2) "B" "r3"
                           {:goal "p" :remaining_work "work-p" :done_when "done-p"})
              tp (first (get-in r3 [:receipt :task-ids]))
              cb (claim (:board r3) "B" "r4" tp "atomic-p")
              claim-b (get-in cb [:receipt :claim-id])
              r4 (add-task (:board cb) "A" "r5"
                           {:goal "tok" :remaining_work "tok" :done_when "tok" :needs_token true})
              ta (step (:board r4)
                       {:type "take_or_die" :confirm token/take-or-die-confirmation
                        :handoff_markdown "A"}
                       "r6" "A" "ta")
              tb (step (:board ta)
                       {:type "take_or_die" :confirm token/take-or-die-confirmation
                        :handoff_markdown "B"}
                       "r7" "B" "tb")
              late (finish (:board tb) "B" "r8" tp claim-b)]
          (t/to-be (:ok late) false)
          (t/to-be (name (get-in late [:error :code])) "ACTOR_DEAD")
          (t/to-be (name (get-in tb [:board :tasks tp :state])) "ready")
          (t/to-be (get-in tb [:board :tasks tp :owner-id]) nil))))))
