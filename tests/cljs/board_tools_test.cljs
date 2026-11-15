(ns cljs.board-tools-test
  (:require
   [clojure.string :as str]
   [herd.swarm.board :as apply]
   [herd.swarm.store :as store]
   [herd.swarm.tools :as tools]
   [herd.test :as t]
   [promesa.core :as p]))

(defn- seed [root]
  (let [handle (store/open-board root "demo"
                                 {:store (store/create-memory-store)
                                  :durable false})
        deps {:handle handle
              :root-of (fn [_] root)
              :slug-of (fn [_] "demo")
              :actor-of (fn [_] {:agent-id "A"})
              :turn-of (fn [_ ctx] ctx)}
        register (fn [id slot request]
                   (apply/submit-board-command! {:board handle
                                        :command {:type "register_actor"
                                                  :agentId id :slotId slot}
                                        :request-id request :turn-id "boot"}))]
    (p/let [_ (register "A" "S1" "reg-a")
            _ (register "B" "S2" "reg-b")]
      [handle deps])))

(t/describe "CLJS board tool surface"
  (fn []
    (t/it "exports eleven board tools with required snake_case parameters"
      (fn []
        (let [defs (tools/tool-definitions {:root "/tmp" :slug "demo" :actor "A"})]
          (t/to-equal (mapv :name defs)
                      ["board_split" "board_claim" "board_finish" "board_cancel"
                       "board_replace" "board_release" "board_reopen" "board_comment"
                       "board_update" "board_park_slot" "board_take_or_die"])
          (t/to-equal (vec (:required (:parameters (first defs))))
                      ["parent_id" "expected_board_version" "children" "remaining_work"])
          (t/to-equal (vec (:required (:parameters (second defs))))
                      ["task_id" "atomicity_reason"])
          (t/to-equal (vec (:required (:parameters (nth defs 2))))
                      ["task_id" "claim_id" "result_summary"])
          (t/to-be (every? (fn [definition] (fn? (:execute definition))) defs) true))))
    (t/it "claims and finishes a task through the tool receipts"
      (fn []
        (p/let [[handle deps] (seed "/tmp")
                _ (apply/submit-board-command! {:board handle
                                       :command {:type "add_tasks"
                                                 :tasks [{:goal "job"
                                                          :remaining-work "work"
                                                          :done-when "done"}]}
                                       :actor "A" :request-id "add-1" :turn-id "add"})
                board (store/read-board handle)
                task-id (first (keys (:tasks board)))
                claimed (tools/execute-board-tool! deps :board_claim
                                             {:task_id task-id :atomicity_reason "atomic"}
                                             nil "call-1")
                after-claim (store/read-board handle)
                claim-id (get-in after-claim [:tasks task-id :claim-id])
                finished (tools/execute-board-tool! deps :board_finish
                                              {:task_id task-id
                                               :claim_id claim-id
                                               :result_summary "done"
                                               :dependency_paths ["src/a.cljs"]}
                                              nil "call-2")
                final-board (store/read-board handle)]
          (t/to-be (:isError claimed) false)
          (t/to-contain (get-in claimed [:content 0 :text]) ":outcome :claimed")
          (t/to-be (:isError finished) false)
          (t/to-be (name (get-in final-board [:tasks task-id :state])) "done")
          (t/to-be (:board-version final-board) 5))))
    (t/it "splits with the observed version and rejects a stale one"
      (fn []
        (p/let [[handle deps] (seed "/tmp")
                _ (apply/submit-board-command! {:board handle
                                       :command {:type "add_tasks"
                                                 :tasks [{:goal "root"
                                                          :remaining-work "integrate"
                                                          :done-when "green"}]}
                                       :actor "A" :request-id "add-1" :turn-id "add"})
                board (store/read-board handle)
                parent (first (keys (:tasks board)))
                version (:board-version board)
                split (tools/execute-board-tool! deps :board_split
                                           {:parent_id parent
                                            :expected_board_version version
                                            :remaining_work "integrate"
                                            :children [{:goal "one"
                                                        :remaining_work "w1"
                                                        :done_when "d1"}
                                                       {:goal "two"
                                                        :remaining_work "w2"
                                                        :done_when "d2"}]}
                                           nil "call-split")
                stale (tools/execute-board-tool! deps :board_split
                                           {:parent_id parent
                                            :expected_board_version version
                                            :remaining_work "integrate again"
                                            :children [{:goal "three"
                                                        :remaining_work "w3"
                                                        :done_when "d3"}]}
                                           nil "call-stale")
                after (store/read-board handle)]
          (t/to-be (:isError split) false)
          (t/to-be (name (get-in after [:tasks parent :state])) "waiting")
          (t/to-be (count (get-in after [:tasks parent :child-ids])) 2)
          (t/to-be (:isError stale) true)
          (t/to-contain (get-in stale [:content 0 :text]) ":code :BOARD_CONFLICT"))))
    (t/it "replays one take-or-die call id without a second term"
      (fn []
        (p/let [[handle deps] (seed "/tmp")
                _ (apply/submit-board-command! {:board handle
                                       :command {:type "add_tasks"
                                                 :tasks [{:goal "token"
                                                          :remaining-work "run"
                                                          :done-when "green"
                                                          :needs-token true}]}
                                       :actor "A" :request-id "add-1" :turn-id "add"})
                params {:request_id "take-1"
                        :confirm "i-hereby-confirm-i-die-without-regret"
                        :handoff_markdown "handoff"}
                first (tools/execute-board-tool! deps :board_take_or_die params nil "call-take")
                second (tools/execute-board-tool! deps :board_take_or_die params nil "call-take")
                changed (tools/execute-board-tool! deps :board_take_or_die
                                             (assoc params :handoff_markdown "different")
                                             nil "call-take")
                board (store/read-board handle)]
          (t/to-be (:isError first) false)
          (t/to-contain (get-in first [:content 0 :text]) ":outcome :attempt-won")
          (t/to-be (= (get-in first [:content 0 :text])
                      (get-in second [:content 0 :text]))
                   true)
          (t/to-contain (get-in changed [:content 0 :text]) ":code :CALL_REPLAY_MISMATCH")
          (t/to-be (get-in board [:token-slot :holder-id]) "A")
          (t/to-be (count (get-in board [:token-slot :retired-terms])) 0))))))
