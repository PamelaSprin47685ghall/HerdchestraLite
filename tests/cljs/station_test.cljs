(ns cljs.station-test
  (:require
   ["node:fs" :as fs]
   ["node:path" :as path]
   [clojure.string :as str]
   [herd.station :as station]
   [herd.test :as t]
   [promesa.core :as p]))

(defn- apply-command [board command _context]
  (case (:type command)
    :append {:ok true
             :changed? true
             :board (update board :log (fnil conj []) (:value command))}
    :noop {:ok true :changed? false :board board}
    :reject {:ok false
             :error {:code "COMMAND_REJECTED" :message "command rejected"}}
    {:ok false
     :error {:code "UNKNOWN_COMMAND" :message "unknown command"}}))

(defn- wait-until [pred]
  (p/loop [n 0]
    (if (or (pred) (> n 500))
      (boolean (pred))
      (p/let [_ (js/Promise. (fn [resolve] (js/setTimeout resolve 1)))]
        (p/recur (inc n))))))

(defn- memory-persist [file]
  (fn [_ticket board]
    (swap! file assoc :board board :writes (inc (:writes @file)))
    (js/Promise.resolve {:ok true})))

(defn- name-of [value]
  (cond
    (nil? value) nil
    (keyword? value) (name value)
    (string? value) value
    :else (str value)))

(defn- same [actual expected]
  (t/to-be (= actual expected) true))

(t/describe "station kernel"
  (fn []
    (t/it "declares async only on the ticket and keeps the station half await-free"
      (fn []
        (let [source (fs/readFileSync (path/join (path/dirname (.-__herdEntryPath js/globalThis)) "herd/station.cljs") "utf8")
              async-defs (mapv second (re-seq #"\(defn\s+\^:async\s+([^\s)]+)" source))
              ticket-index (str/index-of source ";; ===== Ticket")
              station-part (subs source 0 ticket-index)]
          (same async-defs ["run-ticket"])
          (t/to-be (> ticket-index 0) true)
          (t/to-be (boolean (re-find #"\bawait\b" station-part)) false))))
    (t/it "updates memory before opening a ticket and returns synchronously from gatekeepers"
      (fn []
        (p/let [seen (atom [])
                st (station/create-station
                    {:initial-board {:board-version 4 :log []}
                     :apply-command apply-command
                     :open-ticket (fn [station ticket]
                                    (swap! seen conj
                                           {:ticket (station/ticket station (:id ticket))
                                            :snapshot (station/snapshot station)})
                                    (js/Promise.resolve nil))})
                initial (station/snapshot st)
                _promise (station/submit! st {:type :append :value "a"} {:request-id "r1"})
                observed (first @seen)
                cancel-result (station/cancel! st :test)
                after (station/snapshot st)]
          (t/to-be (:ticket-count initial) 0)
          (t/to-be (get-in observed [:ticket :state]) :pending)
          (t/to-be (get-in observed [:ticket :epoch]) 0)
          (t/to-be (get-in observed [:snapshot :ticket-count]) 1)
          (t/to-be (get-in observed [:snapshot :committed-version]) 4)
          (t/to-be (get-in observed [:snapshot :busy?]) false)
          (t/to-be (map? cancel-result) true)
          (t/to-be (station/ticket-state st "t1") :cancelled)
          (t/to-be (:ticket-count after) 1))))
    (t/it "runs a synchronous re-entry from the open-ticket prefix as the next transaction"
      (fn []
        (p/let [opened (atom [])
                holder (atom nil)
                open (fn [station ticket]
                       (swap! opened conj (:id ticket))
                       (when (= 1 (count @opened))
                         (station/submit! station
                                          {:type :append :value "nested"}
                                          {:request-id "r2"}))
                       (js/Promise.resolve nil))
                st (station/create-station
                    {:initial-board {:board-version 0 :log []}
                     :apply-command apply-command
                     :open-ticket open})
                _ (station/submit! st {:type :append :value "outer"} {:request-id "r1"})
                snap (station/snapshot st)]
          (same @opened ["t1" "t2"])
          (t/to-be (:ticket-count snap) 2)
          (t/to-be (:busy? snap) false))))
    (t/it "commits only after persist resolves and advances versions in order"
      (fn []
        (p/let [file (atom {:board {:board-version 2 :log []} :writes 0})
                st (station/create-station
                    {:initial-board (:board @file)
                     :apply-command apply-command
                     :open-ticket (station/make-ticket-runner (memory-persist file))})
                p1 (station/submit! st {:type :append :value "a"} {:request-id "r1"})
                before (station/snapshot st)
                r1 (p1)
                mid (station/snapshot st)
                p2 (station/submit! st {:type :append :value "b"} {:request-id "r2"})
                r2 (p2)
                final (station/snapshot st)]
          (t/to-be (:board-version before) 2)
          (t/to-be (:ticket-count before) 1)
          (t/to-be (:state r1) :applied)
          (t/to-be (:version r1) 3)
          (t/to-be (:durable? r1) true)
          (t/to-be (:board-version mid) 3)
          (same (get-in mid [:board :log]) ["a"])
          (t/to-be (:state r2) :applied)
          (t/to-be (:version r2) 4)
          (t/to-be (:board-version final) 4)
          (same (get-in final [:board :log]) ["a" "b"])
          (t/to-be (get-in @file [:board :board-version]) 4)
          (same (get-in @file [:board :log]) ["a" "b"])
          (t/to-be (:writes @file) 2)
          (t/to-be (get-in final [:counts "applied"]) 2))))
    (t/it "serializes concurrent board writes and keeps ticket order"
      (fn []
        (p/let [active (atom 0)
                peak (atom 0)
                order (atom [])
                persist (fn [_ticket board]
                          (swap! active inc)
                          (swap! peak max @active)
                          (swap! order conj (:board-version board))
                          (js/Promise.
                           (fn [resolve]
                             (js/setTimeout
                              (fn []
                                (swap! active dec)
                                (resolve {:ok true}))
                              2))))
                st (station/create-station
                    {:initial-board {:board-version 0 :log []}
                     :apply-command apply-command
                     :open-ticket (station/make-ticket-runner persist)})
                results (p/all [(station/submit! st {:type :append :value "a"})
                                (station/submit! st {:type :append :value "b"})
                                (station/submit! st {:type :append :value "c"})])
                snap (station/snapshot st)]
          (t/to-be @peak 1)
          (same @order [1 2 3])
          (same (mapv :state results) [:applied :applied :applied])
          (same (mapv :version results) [1 2 3])
          (t/to-be (:board-version snap) 3)
          (same (get-in snap [:board :log]) ["a" "b" "c"])
          (t/to-be (get-in snap [:counts "applied"]) 3))))
    (t/it "keeps the old board when a write fails and lets the next ticket proceed"
      (fn []
        (p/let [file (atom {:board {:board-version 0 :log []} :writes 0})
                persist (fn [ticket board]
                          (if (= "bad" (get-in ticket [:command :value]))
                            (js/Promise.resolve
                             {:ok false
                              :error {:code "WRITE_FAILED" :message "disk full"}})
                            (do
                              (swap! file assoc :board board
                                     :writes (inc (:writes @file)))
                              (js/Promise.resolve {:ok true}))))
                st (station/create-station
                    {:initial-board (:board @file)
                     :apply-command apply-command
                     :open-ticket (station/make-ticket-runner persist)})
                bad (p/let [r (station/submit! st {:type :append :value "bad"})] r)
                after-bad (station/snapshot st)
                good (p/let [r (station/submit! st {:type :append :value "good"})] r)
                final (station/snapshot st)]
          (t/to-be (:state bad) :failed)
          (t/to-be (:error bad) "disk full")
          (t/to-be (:error-name bad) "WRITE_FAILED")
          (t/to-be (:board-version after-bad) 0)
          (same (get-in after-bad [:board :log]) [])
          (t/to-be (:state good) :applied)
          (t/to-be (:version good) 1)
          (t/to-be (:board-version final) 1)
          (same (get-in final [:board :log]) ["good"])
          (t/to-be (get-in @file [:board :board-version]) 1)
          (t/to-be (:writes @file) 1))))
    (t/it "cancels queued work without replaying the non-idempotent write"
      (fn []
        (p/let [calls (atom [])
                gates (atom [])
                persist (fn [ticket board]
                          (swap! calls conj {:id (:id ticket)
                                             :version (:board-version board)})
                          (js/Promise.
                           (fn [resolve]
                             (swap! gates conj (fn [] (resolve {:ok true}))))))
                st (station/create-station
                    {:initial-board {:board-version 0 :log []}
                     :apply-command apply-command
                     :open-ticket (station/make-ticket-runner persist)})
                p1 (station/submit! st {:type :append :value "a"})
                p2 (station/submit! st {:type :append :value "b"})
                started (wait-until (fn [] (= 1 (count @calls))))
                during (station/snapshot st)
                cancel-result (station/cancel! st :user-cancel)
                _ ((first @gates))
                r1 (p1)
                r2 (p2)
                final (station/snapshot st)
                t2 (station/ticket st "t2")
                pre-calls (atom 0)
                held (atom nil)
                pre-st (station/create-station
                        {:initial-board {:board-version 0 :log []}
                         :apply-command apply-command
                         :open-ticket (fn [_station ticket]
                                        (reset! held ticket)
                                        (js/Promise.resolve nil))})]
          (station/submit! pre-st {:type :append :value "x"})
          (station/cancel! pre-st)
          (p/let [pre-result (station/run-ticket
                              pre-st @held
                              (fn [_ticket _board]
                                (swap! pre-calls inc)
                                (js/Promise.resolve {:ok true})))]
            (t/to-be started true)
            (t/to-be (get-in during [:ticket-states "t1"]) :running)
            (t/to-be (get-in during [:ticket-states "t2"]) :running)
            (t/to-be (:epoch cancel-result) 1)
            (t/to-be (:state r1) :applied)
            (t/to-be (:version r1) 1)
            (t/to-be (:aborted? r1) true)
            (t/to-be (:state r2) :cancelled)
            (t/to-be (:aborted? r2) true)
            (t/to-be (:aborted? t2) true)
            (t/to-be (count @calls) 1)
            (t/to-be (:id (first @calls)) "t1")
            (t/to-be (:board-version final) 1)
            (same (get-in final [:board :log]) ["a"])
            (t/to-be (:state pre-result) :cancelled)
            (t/to-be (:aborted? pre-result) true)
            (t/to-be @pre-calls 0)))))
    (t/it "refuses to apply a ticket after cancellation invalidated its epoch"
      (fn []
        (p/let [held (atom nil)
                st (station/create-station
                    {:initial-board {:board-version 0 :log []}
                     :apply-command apply-command
                     :open-ticket (fn [_station ticket]
                                    (reset! held ticket)
                                    (js/Promise.resolve nil))})]
          (station/submit! st {:type :append :value "a"})
          (station/cancel! st :test)
          (p/let [stale? (station/epoch-current? st 0)
                  current? (station/ticket-current? st "t1")
                  applied (station/apply-written! st "t1"
                                                  {:board-version 1 :log ["a"]} 1)
                  snap (station/snapshot st)]
            (t/to-be stale? false)
            (t/to-be current? false)
            (t/to-be (:ok applied) false)
            (t/to-be (:state applied) :cancelled)
            (t/to-be (get-in applied [:error :code]) "ALREADY_SETTLED")
            (t/to-be (station/ticket-state st "t1") :cancelled)
            (t/to-be (:board-version snap) 0)
            (same (get-in snap [:board :log]) [])
            (t/to-be (:busy? snap) false)))))
    (t/it "marks an uncertain write unknown, blocks writes, then resyncs from file"
      (fn []
        (p/let [file (atom {:board {:board-version 0 :log []} :writes 0})
                calls (atom 0)
                persist (fn [ticket board]
                          (swap! calls inc)
                          (if (= "uncertain" (get-in ticket [:command :value]))
                            (js/Promise.reject
                             (ex-info "io outcome uncertain"
                                      {:code :WRITE_UNCERTAIN :uncertain true}))
                            (do
                              (swap! file assoc :board board
                                     :writes (inc (:writes @file)))
                              (js/Promise.resolve {:ok true}))))
                st (station/create-station
                    {:initial-board (:board @file)
                     :apply-command apply-command
                     :open-ticket (station/make-ticket-runner persist)})
                uncertain (p/let [r (station/submit! st {:type :append :value "uncertain"})] r)
                blocked (p/let [r (station/submit! st {:type :append :value "blocked"})] r)
                blocked-snap (station/snapshot st)
                resynced (station/resync! st (:board @file))
                good (p/let [r (station/submit! st {:type :append :value "good"})] r)
                final (station/snapshot st)]
          (t/to-be (:state uncertain) :unknown)
          (t/to-be (:error-name uncertain) "WRITE_UNCERTAIN")
          (t/to-be (:state blocked) :failed)
          (t/to-be (:error-name blocked) "NEEDS_RESYNC")
          (t/to-be (:needs-resync? blocked-snap) true)
          (t/to-be (:ok resynced) true)
          (t/to-be (:aborted? resynced) true)
          (t/to-be (:state good) :applied)
          (t/to-be (:version good) 1)
          (t/to-be (:board-version final) 1)
          (same (get-in final [:board :log]) ["good"])
          (t/to-be (get-in @file [:board :board-version]) 1)
          (same (get-in @file [:board :log]) ["good"])
          (t/to-be @calls 2))))
    (t/it "discards uncommitted memory on restart and reads the file as authority"
      (fn []
        (p/let [file (atom {:board {:board-version 6 :log ["old"]} :writes 1})
                gates (atom [])
                persist (fn [_ticket board]
                          (js/Promise.
                           (fn [resolve]
                             (swap! gates conj
                                    (fn []
                                      (swap! file assoc :board board
                                             :writes (inc (:writes @file)))
                                      (resolve {:ok true}))))))
                st1 (station/create-station
                     {:initial-board (:board @file)
                      :apply-command apply-command
                      :open-ticket (station/make-ticket-runner persist)})
                p (station/submit! st1 {:type :append :value "new"})
                started (wait-until (fn [] (= 1 (count @gates))))
                before (station/snapshot st1)
                st2 (station/create-station
                     {:initial-board (:board @file)
                      :apply-command apply-command
                      :open-ticket (fn [_station _ticket]
                                     (js/Promise.resolve nil))})
                restarted (station/snapshot st2)
                file-before (get-in @file [:board :log])
                _ ((first @gates))
                result (p)
                after (station/snapshot st1)
                restart-after (station/snapshot st2)]
          (t/to-be started true)
          (t/to-be (:board-version before) 6)
          (t/to-be (get-in before [:ticket-states "t1"]) :running)
          (same file-before ["old"])
          (t/to-be (:board-version restarted) 6)
          (same (get-in restarted [:board :log]) ["old"])
          (t/to-be (:ticket-count restarted) 0)
          (t/to-be (:state result) :applied)
          (t/to-be (:version result) 7)
          (t/to-be (:board-version after) 7)
          (same (get-in after [:board :log]) ["old" "new"])
          (same (get-in @file [:board :log]) ["old" "new"])
          (t/to-be (get-in @file [:board :board-version]) 7)
          (t/to-be (:board-version restart-after) 6)
          (same (get-in restart-after [:board :log]) ["old"]))))
    (t/it "rejects station re-entry from inside a command calculation"
      (fn []
        (p/let [holder (atom nil)
                apply-fn (fn [board command _context]
                           (if (= :reenter (:type command))
                             (do
                               (station/submit! @holder {:type :append :value "nested"})
                               {:ok true :changed? false})
                             {:ok true
                              :changed? true
                              :board (update board :log (fnil conj []) (:value command))}))
                station-value (station/create-station
                               {:initial-board {:board-version 0 :log []}
                                :apply-command apply-fn
                                :open-ticket
                                (station/make-ticket-runner
                                 (fn [_ticket _board]
                                   (js/Promise.resolve {:ok true})))})]
          (reset! holder station-value)
          (p/let [result (station/submit! station-value {:type :reenter})
                  snap (station/snapshot station-value)]
            (t/to-be (:state result) :failed)
            (t/to-be (:error-name result) "STATION-REENTRANT")
            (t/to-be (:ticket-count snap) 1)
            (t/to-be (:busy? snap) false)
            (t/to-be (:board-version snap) 0)))))
    (t/it "settles every accepted ticket into a terminal state"
      (fn []
        (p/let [gates (atom [])
                persist (fn [ticket _board]
                          (let [value (get-in ticket [:command :value])]
                            (cond
                              (= "held" value)
                              (js/Promise.
                               (fn [resolve]
                                 (swap! gates conj (fn [] (resolve {:ok true})))))

                              (= "reject" value)
                              (js/Promise.resolve
                               {:ok false
                                :error {:code "WRITE_FAILED" :message "no space"}})

                              (= "uncertain" value)
                              (js/Promise.reject
                               (ex-info "uncertain" {:code :WRITE_UNCERTAIN
                                                       :uncertain true}))

                              :else
                              (js/Promise.resolve {:ok true}))))
                st (station/create-station
                    {:initial-board {:board-version 0 :log []}
                     :apply-command apply-command
                     :open-ticket (station/make-ticket-runner persist)})
                p1 (station/submit! st {:type :append :value "held"})
                p2 (station/submit! st {:type :append :value "cancel"})
                _started (wait-until (fn [] (= 1 (count @gates))))
                _cancel (station/cancel! st :liveness)
                _release ((first @gates))
                _r1 (p1)
                _r2 (p2)
                p3 (station/submit! st {:type :append :value "reject"})
                _r3 (p3)
                p4 (station/submit! st {:type :append :value "ok"})
                _r4 (p4)
                p5 (station/submit! st {:type :append :value "uncertain"})
                _r5 (p5)
                snap (station/snapshot st)
                terminal? (every? station/ticket-terminal?
                                  (map :state (vals (station/tickets st))))]
          (t/to-be terminal? true)
          (t/to-be (get-in snap [:ticket-states "t1"]) :applied)
          (t/to-be (get-in snap [:ticket-states "t2"]) :cancelled)
          (t/to-be (get-in snap [:ticket-states "t3"]) :failed)
          (t/to-be (get-in snap [:ticket-states "t4"]) :applied)
          (t/to-be (get-in snap [:ticket-states "t5"]) :unknown)
          (t/to-be (get-in snap [:counts "applied"]) 2)
          (t/to-be (get-in snap [:counts "failed"]) 1)
          (t/to-be (get-in snap [:counts "cancelled"]) 1)
          (t/to-be (get-in snap [:counts "unknown"]) 1)
          (t/to-be (:needs-resync? snap) true))))))

