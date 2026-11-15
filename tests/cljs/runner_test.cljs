(ns cljs.runner-test
  (:require
   [clojure.string :as str]
   [herd.swarm.board :as apply]
   [herd.swarm.runner :as runner]
   [herd.swarm.store :as store]
   [herd.test :as t]
   [promesa.core :as p]))

(def mission
  {:mission-id "M1" :slug "demo" :revision 0 :stage :s5 :seed "seed"
   :tenure {:tenure-id "T-1" :index 1} :tenure-seq 1})

(defn- seed-board []
  (p/let [handle (store/open-board "/tmp" "demo"
                                   {:store (store/create-memory-store)
                                    :durable false})
          _ (apply/apply-board!
             {:board handle
              :command {:type "register_actor" :agentId "Coordinator" :slotId "C"}
              :request-id "seed-coordinator" :turn-id "boot"})]
    handle))

(defn- board-of [handle]
  (store/read-board handle))

(defn- add-task [handle spec request]
  (apply/apply-board!
   {:board handle
    :command {:type "add_tasks" :tasks [spec]}
    :actor "Coordinator" :request-id request :turn-id "add"}))

(defn- base-deps [handle extra]
  (merge {:board handle :root "/tmp" :slug "demo" :mission mission
          :actor "Coordinator"
          :uuid (fn [] "00000000-0000-4000-8000-000000000000")}
         extra))

(defn- same [actual expected]
  (t/to-be (= actual expected) true))

(t/describe "CLJS S5 single-workspace runner"
  (fn []
    (t/it "instantiates non-empty findings as root tasks and wakes the whole slot pool"
      (fn []
        (p/let [handle (seed-board)
                woken (atom [])
                deps (base-deps handle
                                {:slot-count 4
                                 :wake-slot! (fn [request]
                                               (swap! woken conj (:slot-id request))
                                               {:ok true :slot-id (:slot-id request)})})
                result (runner/reviewer-findings!
                        deps
                        [{:key "K-1" :value "Fix the parser"}
                         {:key "K-2" :value "Add recovery evidence"}]
                        {})
                board (board-of handle)
                tasks (vals (:tasks board))]
          (t/to-be (:ok result) true)
          (t/to-be (:status result) :review-open)
          (t/to-be (count (:task-ids result)) 2)
          (t/to-be (count (:new-task-ids result)) 2)
          (same @woken ["S1" "S2" "S3" "S4"])
          (same (vec (sort (map :ledger-key tasks))) ["K-1" "K-2"])
          (same (vec (sort (map :goal tasks))) ["Add recovery evidence" "Fix the parser"])
          (t/to-be (> (get-in board [:wake :epoch]) 0) true)
          (t/to-be (every? nil? (map :parent-id tasks)) true))))
    (t/it "retires the tenure, writes a barrier and starts a successor Reviewer"
      (fn []
        (p/let [handle (seed-board)
                persisted (atom nil)
                reviewer (atom nil)
                deps (base-deps handle
                                {:persist-barrier! (fn [request]
                                                     (reset! persisted request)
                                                     {:ok true
                                                      :successor-board (:successor-board request)
                                                      :successor-mission (:successor-mission request)})
                                 :subagent (fn [request]
                                             (reset! reviewer request)
                                             {:ok true :result-markdown "reviewed"})})
                result (runner/reviewer-findings! deps [] {})
                barrier (:barrier result)
                successor (:successor result)]
          (t/to-be (:ok result) true)
          (t/to-be (:status result) :relayed)
          (t/to-be (:retired-tenure barrier) "T-1")
          (t/to-be (:successor-tenure barrier) "T-2")
          (t/to-be (:from barrier) :s5)
          (t/to-be (:to barrier) :s5)
          (t/to-be (:tenure-id successor) "T-2")
          (t/to-be (:role @reviewer) "Reviewer")
          (t/to-be (str/includes? (:name @reviewer) "T-2") true)
          (t/to-be (:successor-tenure (:barrier @persisted)) "T-2"))))
    (t/it "does not rotate while the board is not quiescent"
      (fn []
        (p/let [handle (seed-board)
                _ (add-task handle {:goal "open" :remaining_work "work" :done_when "done"} "add-1")
                reviewer (atom nil)
                deps (base-deps handle
                                {:subagent (fn [request] (reset! reviewer request) {:ok true})})
                result (runner/reviewer-findings! deps [] {})
                board (board-of handle)
                reasons (mapv :code (get-in result [:quiescence :reasons]))]
          (t/to-be (:ok result) true)
          (t/to-be (:status result) :stay)
          (t/to-be (some #{:BOARD_NOT_EMPTY} reasons) :BOARD_NOT_EMPTY)
          (t/to-be (some? @reviewer) false)
          (t/to-be (count (:tasks board)) 1))))
    (t/it "does not rotate while the workspace write lock is still held"
      (fn []
        (p/let [handle (seed-board)
                reviewer (atom nil)
                deps (base-deps handle
                                {:write-lock-held? (fn [] true)
                                 :subagent (fn [request] (reset! reviewer request) {:ok true})})
                result (runner/reviewer-findings! deps [] {})
                reasons (mapv :code (get-in result [:quiescence :reasons]))]
          (t/to-be (:ok result) true)
          (t/to-be (:status result) :stay)
          (t/to-be (some #{:WRITE_LOCK_HELD} reasons) :WRITE_LOCK_HELD)
          (t/to-be (some? @reviewer) false))))
    (t/it "asks the one-shot initial question exactly once, then rotates"
      (fn []
        (p/let [handle (seed-board)
                asked (atom 0)
                reviewer (atom 0)
                deps (base-deps handle
                                {:ask-user (fn [_request]
                                             (swap! asked inc)
                                             "keep going")
                                 :persist-barrier! (fn [request]
                                                     {:ok true
                                                      :successor-board (:successor-board request)
                                                      :successor-mission (:successor-mission request)})
                                 :subagent (fn [_request]
                                             (swap! reviewer inc)
                                             {:ok true})})
                first (runner/reviewer-findings! deps [] {})
                board-after-first (board-of handle)
                second (runner/reviewer-findings! deps [] {})]
          (t/to-be (:status first) :ask-user)
          (t/to-be (:answer first) "keep going")
          (t/to-be @asked 1)
          (t/to-be (get-in board-after-first [:tenure :initial-ask-used]) true)
          (t/to-be (:status second) :relayed)
          (t/to-be @reviewer 1))))
    (t/it "keeps a fixed four-slot pool and replaces a dead slot with a new agent id"
      (fn []
        (p/let [handle (seed-board)
                counter (atom 0)
                woken (atom [])
                deps (base-deps handle
                                {:uuid (fn []
                                         (swap! counter inc)
                                         (let [digits (str "00000000" @counter)]
                                           (str (subs digits (max 0 (- (count digits) 8)))
                                                "-0000-4000-8000-000000000000")))
                                 :slot-count 4
                                 :wake-slot! (fn [request]
                                               (swap! woken conj [(:slot-id request) (:agent-id request)])
                                               {:ok true})})
                pool (runner/init-slot-pool! deps {})
                before (board-of handle)
                replacement (runner/replace-slot! deps "S1" {:reason "agent died"})
                after (board-of handle)]
          (t/to-be (:ok pool) true)
          (same (mapv :slot-id (:slots pool)) ["S1" "S2" "S3" "S4"])
          (same (count (filter (fn [[_ actor]]
                                 (and (= :alive (:life-state actor))
                                      (= :normal (:role actor))
                                      (some? (re-matches #"S[0-9]+" (str (:slot-id actor))))))
                              (:actors before)))
                4)
          (t/to-be (not= (:old-agent-id replacement) (:agent-id replacement)) true)
          (t/to-be (get-in after [:actors (:old-agent-id replacement) :life-state]) :dead)
          (t/to-be (get-in after [:actors (:agent-id replacement) :life-state]) :alive)
          (t/to-be (>= (count @woken) 1) true))))
    (t/it "wakes a parked slot once the board epoch advances"
      (fn []
        (p/let [handle (seed-board)
                _ (apply/apply-board!
                   {:board handle
                    :command {:type "register_actor" :agentId "A" :slotId "S1"}
                    :request-id "seed-a" :turn-id "boot"})
                woken (atom [])
                deps (base-deps handle
                                {:wake-slot! (fn [request]
                                               (swap! woken conj (:slot-id request))
                                               {:ok true})})
                parked-result (runner/park-slot! deps "S1" {})
                _ (add-task handle {:goal "wake work" :remaining-work "work" :done-when "done"} "add-wake")
                woken-result (runner/wake-parked! deps (:parked parked-result))]
          (t/to-be (:ok parked-result) true)
          (t/to-be (:slot-id (:parked parked-result)) "S1")
          (t/to-be (:ok woken-result) true)
          (same @woken ["S1"])
          (same (:still-parked woken-result) [])
          (t/to-be (> (:wake-epoch woken-result) 0) true))))
    (t/it "installs the runner API for the entry point without model-facing tools"
      (fn []
        (p/let [result (runner/register-runner! nil {})]
          (t/to-be (:ok result) true)
          (same (:tools result) [])
          (t/to-be (fn? (.-startReviewer js/globalThis.__herdS5)) true)
          (t/to-be (fn? (.-reviewerFindings js/globalThis.__herdS5)) true)
          (t/to-be (fn? (.-relay js/globalThis.__herdS5)) true)
          (t/to-be (str/includes? (get-in result [:contract :subagent]) "artifactsDir") true))))
    (t/it "reuses the root task for a repeated ledger key instead of adding duplicates"
      (fn []
        (p/let [handle (seed-board)
                woken (atom [])
                deps (base-deps handle
                                {:slot-count 1
                                 :wake-slot! (fn [request]
                                               (swap! woken conj (:slot-id request))
                                               {:ok true})})
                first (runner/reviewer-findings! deps [{:key "K-1" :value "Fix it"}] {})
                after-first (board-of handle)
                second (runner/reviewer-findings! deps [{:key "K-1" :value "Fix it"}] {})
                after-second (board-of handle)
                third (runner/reviewer-findings! deps [{:key "K-1" :value "Fix it better"}] {})
                after-third (board-of handle)]
          (t/to-be (count (:new-task-ids first)) 1)
          (t/to-be (count (:tasks after-first)) 1)
          (t/to-be (count (:new-task-ids second)) 0)
          (t/to-be (count (:updated-task-ids second)) 1)
          (t/to-be (count (:tasks after-second)) 1)
          (t/to-be (count (:new-task-ids third)) 0)
          (t/to-be (count (:tasks after-third)) 1)
          (t/to-be (get-in after-third [:tasks "T-1" :goal]) "Fix it better"))))
    (t/it "installs the runner API from a dependency map"
      (fn []
        (let [api (runner/install! {:root "/tmp" :slug "demo" :mission mission})]
          (t/to-be (every? fn? (vals api)) true)
          (t/to-be (fn? (:askInitial api)) true)
          (same (sort (map name (keys api)))
                ["askInitial" "initSlotPool" "parkSlot" "quiescence" "relay"
                 "replaceSlot" "reviewerFindings" "startReviewer" "wakeParked"]))))))

