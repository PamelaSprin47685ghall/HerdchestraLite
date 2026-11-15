import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as nbb from "nbb";
import { ensureModules } from "./helpers/nbb-boot.mjs";

const MODULES = ["station"];

beforeAll(async () => {
	await ensureModules(MODULES);
});

const PRELUDE = `
(defn apply-command [board command _context]
  (case (:type command)
    :append {:ok true
             :changed? true
             :board (update board :log (fnil conj []) (:value command))}
    :noop {:ok true :changed? false :board board}
    :reject {:ok false
             :error {:code "COMMAND_REJECTED" :message "command rejected"}}
    {:ok false
     :error {:code "UNKNOWN_COMMAND" :message "unknown command"}}))

(defn ^:async wait-until [pred]
  (loop [n 0]
    (if (or (pred) (> n 500))
      (boolean (pred))
      (do
        (await (js/Promise. (fn [resolve _] (js/setTimeout resolve 1))))
        (recur (inc n))))))

(defn memory-persist [file]
  (fn [_ticket board]
    (swap! file assoc :board board :writes (inc (:writes @file)))
    (js/Promise.resolve {:ok true})))
`;

async function scenario(body) {
	const text = await nbb.loadString(`
(require '[herd.station :as station])
${PRELUDE}
${body}
(scenario)`);
	return JSON.parse(text);
}

describe("station kernel", () => {
	it("declares async only on the ticket and keeps the station half await-free", () => {
		const source = readFileSync(
			new URL("../src/herd/station.cljs", import.meta.url),
			"utf8",
		);
		const asyncDefs = [...source.matchAll(/\(defn\s+\^:async\s+([^\s)]+)/g)].map(
			(match) => match[1],
		);
		expect(asyncDefs).toEqual(["run-ticket"]);
		const ticketIndex = source.indexOf(";; ===== Ticket");
		expect(ticketIndex).toBeGreaterThan(0);
		const stationPart = source.slice(0, ticketIndex);
		expect(stationPart).not.toMatch(/\bawait\b/);
	});

	it("updates memory before opening a ticket and returns synchronously from gatekeepers", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [seen (atom [])
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
    (js/JSON.stringify
      (clj->js {:initialCount (:ticket-count initial)
                :ticketState (get-in observed [:ticket :state])
                :ticketEpoch (get-in observed [:ticket :epoch])
                :ticketCount (:ticket-count (:snapshot observed))
                :observedVersion (:committed-version (:snapshot observed))
                :observedBusy (:busy? (:snapshot observed))
                :cancelSync (map? cancel-result)
                :cancelledState (station/ticket-state st "t1")
                :afterCount (:ticket-count after)}))))`);

		expect(out.initialCount).toBe(0);
		expect(out.ticketState).toBe("pending");
		expect(out.ticketEpoch).toBe(0);
		expect(out.ticketCount).toBe(1);
		expect(out.observedVersion).toBe(4);
		expect(out.observedBusy).toBe(false);
		expect(out.cancelSync).toBe(true);
		expect(out.cancelledState).toBe("cancelled");
		expect(out.afterCount).toBe(1);
	});

	it("runs a synchronous re-entry from the open-ticket prefix as the next transaction", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [opened (atom [])
        st (atom nil)
        open (fn [station ticket]
               (swap! opened conj (:id ticket))
               (when (= 1 (count @opened))
                 (station/submit! station
                                  {:type :append :value "nested"}
                                  {:request-id "r2"}))
               (js/Promise.resolve nil))]
    (reset! st (station/create-station
                 {:initial-board {:board-version 0 :log []}
                  :apply-command apply-command
                  :open-ticket open}))
    (station/submit! @st {:type :append :value "outer"} {:request-id "r1"})
    (let [snap (station/snapshot @st)]
      (js/JSON.stringify
        (clj->js {:opened @opened
                  :count (:ticket-count snap)
                  :busy (:busy? snap)})))))`);

		expect(out.opened).toEqual(["t1", "t2"]);
		expect(out.count).toBe(2);
		expect(out.busy).toBe(false);
	});

	it("commits only after persist resolves and advances versions in order", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [file (atom {:board {:board-version 2 :log []} :writes 0})
        st (station/create-station
             {:initial-board (:board @file)
              :apply-command apply-command
              :open-ticket (station/make-ticket-runner (memory-persist file))})
        p1 (station/submit! st {:type :append :value "a"} {:request-id "r1"})
        before (station/snapshot st)
        r1 (await p1)
        mid (station/snapshot st)
        p2 (station/submit! st {:type :append :value "b"} {:request-id "r2"})
        r2 (await p2)
        final (station/snapshot st)]
    (js/JSON.stringify
      (clj->js {:beforeVersion (:board-version before)
                :beforeCount (:ticket-count before)
                :r1State (:state r1)
                :r1Version (:version r1)
                :r1Durable (:durable? r1)
                :midVersion (:board-version mid)
                :midLog (get-in mid [:board :log])
                :r2State (:state r2)
                :r2Version (:version r2)
                :finalVersion (:board-version final)
                :finalLog (get-in final [:board :log])
                :fileVersion (get-in @file [:board :board-version])
                :fileLog (get-in @file [:board :log])
                :writes (:writes @file)
                :states (:counts final)}))))`);

		expect(out.beforeVersion).toBe(2);
		expect(out.beforeCount).toBe(1);
		expect(out.r1State).toBe("applied");
		expect(out.r1Version).toBe(3);
		expect(out.r1Durable).toBe(true);
		expect(out.midVersion).toBe(3);
		expect(out.midLog).toEqual(["a"]);
		expect(out.r2State).toBe("applied");
		expect(out.r2Version).toBe(4);
		expect(out.finalVersion).toBe(4);
		expect(out.finalLog).toEqual(["a", "b"]);
		expect(out.fileVersion).toBe(4);
		expect(out.fileLog).toEqual(["a", "b"]);
		expect(out.writes).toBe(2);
		expect(out.states.applied).toBe(2);
	});

	it("serializes concurrent board writes and keeps ticket order", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [active (atom 0)
        peak (atom 0)
        order (atom [])
        persist (fn [_ticket board]
                  (swap! active inc)
                  (swap! peak max @active)
                  (swap! order conj (:board-version board))
                  (js/Promise.
                   (fn [resolve _]
                     (js/setTimeout
                      (fn []
                        (swap! active dec)
                        (resolve {:ok true}))
                      2))))
        st (station/create-station
             {:initial-board {:board-version 0 :log []}
              :apply-command apply-command
              :open-ticket (station/make-ticket-runner persist)})
        p1 (station/submit! st {:type :append :value "a"})
        p2 (station/submit! st {:type :append :value "b"})
        p3 (station/submit! st {:type :append :value "c"})
        results (await (js/Promise.all (clj->js [p1 p2 p3])))
        rows (array-seq results)
        snap (station/snapshot st)]
    (js/JSON.stringify
      (clj->js {:peak @peak
                :order @order
                :states (mapv :state rows)
                :versions (mapv :version rows)
                :finalVersion (:board-version snap)
                :finalLog (get-in snap [:board :log])
                :drains (:counts snap)}))))`);

		expect(out.peak).toBe(1);
		expect(out.order).toEqual([1, 2, 3]);
		expect(out.states).toEqual(["applied", "applied", "applied"]);
		expect(out.versions).toEqual([1, 2, 3]);
		expect(out.finalVersion).toBe(3);
		expect(out.finalLog).toEqual(["a", "b", "c"]);
		expect(out.drains.applied).toBe(3);
	});

	it("keeps the old board when a write fails and lets the next ticket proceed", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [file (atom {:board {:board-version 0 :log []} :writes 0})
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
        bad (await (station/submit! st {:type :append :value "bad"}))
        afterBad (station/snapshot st)
        good (await (station/submit! st {:type :append :value "good"}))
        final (station/snapshot st)]
    (js/JSON.stringify
      (clj->js {:badState (:state bad)
                :badError (:error bad)
                :badName (:error-name bad)
                :afterBadVersion (:board-version afterBad)
                :afterBadLog (get-in afterBad [:board :log])
                :goodState (:state good)
                :goodVersion (:version good)
                :finalVersion (:board-version final)
                :finalLog (get-in final [:board :log])
                :fileVersion (get-in @file [:board :board-version])
                :writes (:writes @file)}))))`);

		expect(out.badState).toBe("failed");
		expect(out.badError).toBe("disk full");
		expect(out.badName).toBe("WRITE_FAILED");
		expect(out.afterBadVersion).toBe(0);
		expect(out.afterBadLog).toEqual([]);
		expect(out.goodState).toBe("applied");
		expect(out.goodVersion).toBe(1);
		expect(out.finalVersion).toBe(1);
		expect(out.finalLog).toEqual(["good"]);
		expect(out.fileVersion).toBe(1);
		expect(out.writes).toBe(1);
	});

	it("cancels queued work without replaying the non-idempotent write", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [calls (atom [])
        gates (atom [])
        persist (fn [ticket board]
                  (swap! calls conj {:id (:id ticket)
                                     :version (:board-version board)})
                  (js/Promise.
                   (fn [resolve _]
                     (swap! gates conj (fn [] (resolve {:ok true}))))))
        st (station/create-station
             {:initial-board {:board-version 0 :log []}
              :apply-command apply-command
              :open-ticket (station/make-ticket-runner persist)})
        p1 (station/submit! st {:type :append :value "a"})
        p2 (station/submit! st {:type :append :value "b"})
        started (await (wait-until (fn [] (= 1 (count @calls)))))
        during (station/snapshot st)
        cancel-result (station/cancel! st :user-cancel)
        _ ((first @gates))
        r1 (await p1)
        r2 (await p2)
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
    (let [pre-result (await (station/run-ticket
                             pre-st @held
                             (fn [_ticket _board]
                               (swap! pre-calls inc)
                               (js/Promise.resolve {:ok true}))))]
      (js/JSON.stringify
        (clj->js {:started started
                  :duringStates (:ticket-states during)
                  :cancelEpoch (:epoch cancel-result)
                  :r1State (:state r1)
                  :r1Version (:version r1)
                  :r1Aborted (:aborted? r1)
                  :r2State (:state r2)
                  :r2Aborted (:aborted? r2)
                  :t2Aborted (:aborted? t2)
                  :writeCalls @calls
                  :finalVersion (:board-version final)
                  :finalLog (get-in final [:board :log])
                  :preState (:state pre-result)
                  :preAborted (:aborted? pre-result)
                  :preCalls @pre-calls
                  :states (:counts final)})))))`);

		expect(out.started).toBe(true);
		expect(out.duringStates.t1).toBe("running");
		expect(out.duringStates.t2).toBe("running");
		expect(out.cancelEpoch).toBe(1);
		expect(out.r1State).toBe("applied");
		expect(out.r1Version).toBe(1);
		expect(out.r1Aborted).toBe(true);
		expect(out.r2State).toBe("cancelled");
		expect(out.r2Aborted).toBe(true);
		expect(out.t2Aborted).toBe(true);
		expect(out.writeCalls.length).toBe(1);
		expect(out.writeCalls[0].id).toBe("t1");
		expect(out.finalVersion).toBe(1);
		expect(out.finalLog).toEqual(["a"]);
		expect(out.preState).toBe("cancelled");
		expect(out.preAborted).toBe(true);
		expect(out.preCalls).toBe(0);
	});

	it("refuses to apply a ticket after cancellation invalidated its epoch", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [held (atom nil)
        st (station/create-station
             {:initial-board {:board-version 0 :log []}
              :apply-command apply-command
              :open-ticket (fn [_station ticket]
                             (reset! held ticket)
                             (js/Promise.resolve nil))})]
    (station/submit! st {:type :append :value "a"})
    (station/cancel! st :test)
    (let [stale? (station/epoch-current? st 0)
          current? (station/ticket-current? st "t1")
          applied (station/apply-written! st "t1"
                                          {:board-version 1 :log ["a"]} 1)
          snap (station/snapshot st)]
      (js/JSON.stringify
        (clj->js {:staleEpoch stale?
                  :ticketCurrent current?
                  :appliedOk (:ok applied)
                  :appliedState (:state applied)
                  :appliedCode (get-in applied [:error :code])
                  :ticketState (station/ticket-state st "t1")
                  :boardVersion (:board-version snap)
                  :boardLog (get-in snap [:board :log])
                  :busy (:busy? snap)})))))`);

		expect(out.staleEpoch).toBe(false);
		expect(out.ticketCurrent).toBe(false);
		expect(out.appliedOk).toBe(false);
		expect(out.appliedState).toBe("cancelled");
		expect(out.appliedCode).toBe("ALREADY_SETTLED");
		expect(out.ticketState).toBe("cancelled");
		expect(out.boardVersion).toBe(0);
		expect(out.boardLog).toEqual([]);
		expect(out.busy).toBe(false);
	});

	it("marks an uncertain write unknown, blocks writes, then resyncs from file", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [file (atom {:board {:board-version 0 :log []} :writes 0})
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
        uncertain (await (station/submit! st {:type :append :value "uncertain"}))
        blocked (await (station/submit! st {:type :append :value "blocked"}))
        blockedSnap (station/snapshot st)
        resynced (station/resync! st (:board @file))
        good (await (station/submit! st {:type :append :value "good"}))
        final (station/snapshot st)]
    (js/JSON.stringify
      (clj->js {:uncertainState (:state uncertain)
                :uncertainName (:error-name uncertain)
                :blockedState (:state blocked)
                :blockedName (:error-name blocked)
                :blockedResync (:needs-resync? blockedSnap)
                :resyncOk (:ok resynced)
                :resyncAborted (:aborted? resynced)
                :goodState (:state good)
                :goodVersion (:version good)
                :finalVersion (:board-version final)
                :finalLog (get-in final [:board :log])
                :fileVersion (get-in @file [:board :board-version])
                :fileLog (get-in @file [:board :log])
                :calls @calls
                :states (:counts final)}))))`);

		expect(out.uncertainState).toBe("unknown");
		expect(out.uncertainName).toBe("WRITE_UNCERTAIN");
		expect(out.blockedState).toBe("failed");
		expect(out.blockedName).toBe("NEEDS_RESYNC");
		expect(out.blockedResync).toBe(true);
		expect(out.resyncOk).toBe(true);
		expect(out.goodState).toBe("applied");
		expect(out.goodVersion).toBe(1);
		expect(out.finalVersion).toBe(1);
		expect(out.finalLog).toEqual(["good"]);
		expect(out.fileVersion).toBe(1);
		expect(out.fileLog).toEqual(["good"]);
		expect(out.calls).toBe(2);
	});

	it("discards uncommitted memory on restart and reads the file as authority", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [file (atom {:board {:board-version 6 :log ["old"]} :writes 1})
        gates (atom [])
        persist (fn [_ticket board]
                  (js/Promise.
                   (fn [resolve _]
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
        started (await (wait-until (fn [] (= 1 (count @gates)))))
        before (station/snapshot st1)
        st2 (station/create-station
              {:initial-board (:board @file)
               :apply-command apply-command
               :open-ticket (fn [_station _ticket]
                              (js/Promise.resolve nil))})
        restarted (station/snapshot st2)
        file-before (get-in @file [:board :log])
        _ ((first @gates))
        result (await p)
        after (station/snapshot st1)
        restartAfter (station/snapshot st2)]
    (js/JSON.stringify
      (clj->js {:started started
                :beforeVersion (:board-version before)
                :beforeTicketState (get-in before [:ticket-states "t1"])
                :fileBefore file-before
                :restartVersion (:board-version restarted)
                :restartLog (get-in restarted [:board :log])
                :restartTickets (:ticket-count restarted)
                :resultState (:state result)
                :resultVersion (:version result)
                :afterVersion (:board-version after)
                :afterLog (get-in after [:board :log])
                :fileAfter (get-in @file [:board :log])
                :fileVersion (get-in @file [:board :board-version])
                :restartAfterVersion (:board-version restartAfter)
                :restartAfterLog (get-in restartAfter [:board :log])}))))`);

		expect(out.started).toBe(true);
		expect(out.beforeVersion).toBe(6);
		expect(out.beforeTicketState).toBe("running");
		expect(out.fileBefore).toEqual(["old"]);
		expect(out.restartVersion).toBe(6);
		expect(out.restartLog).toEqual(["old"]);
		expect(out.restartTickets).toBe(0);
		expect(out.resultState).toBe("applied");
		expect(out.resultVersion).toBe(7);
		expect(out.afterVersion).toBe(7);
		expect(out.afterLog).toEqual(["old", "new"]);
		expect(out.fileAfter).toEqual(["old", "new"]);
		expect(out.fileVersion).toBe(7);
		expect(out.restartAfterVersion).toBe(6);
		expect(out.restartAfterLog).toEqual(["old"]);
	});

	it("rejects station re-entry from inside a command calculation", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [st (atom nil)
        apply-fn (fn [board command _context]
                   (if (= :reenter (:type command))
                     (do
                       (station/submit! @st {:type :append :value "nested"})
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
    (reset! st station-value)
    (let [result (await (station/submit! station-value {:type :reenter}))
          snap (station/snapshot station-value)]
      (js/JSON.stringify
        (clj->js {:state (:state result)
                  :errorName (:error-name result)
                  :ticketCount (:ticket-count snap)
                  :busy (:busy? snap)
                  :version (:board-version snap)})))))`);

		expect(out.state).toBe("failed");
		expect(out.errorName).toBe("STATION-REENTRANT");
		expect(out.ticketCount).toBe(1);
		expect(out.busy).toBe(false);
		expect(out.version).toBe(0);
	});

	it("settles every accepted ticket into a terminal state", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [gates (atom [])
        persist (fn [ticket _board]
                  (let [value (get-in ticket [:command :value])]
                    (cond
                      (= "held" value)
                      (js/Promise.
                       (fn [resolve _]
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
        _started (await (wait-until (fn [] (= 1 (count @gates)))))
        _cancel (station/cancel! st :liveness)
        _release ((first @gates))
        _r1 (await p1)
        _r2 (await p2)
        p3 (station/submit! st {:type :append :value "reject"})
        _r3 (await p3)
        p4 (station/submit! st {:type :append :value "ok"})
        _r4 (await p4)
        p5 (station/submit! st {:type :append :value "uncertain"})
        _r5 (await p5)
        snap (station/snapshot st)
        terminal? (every? station/ticket-terminal?
                          (map :state (vals (station/tickets st))))]
    (js/JSON.stringify
      (clj->js {:terminal terminal?
                :states (:ticket-states snap)
                :counts (:counts snap)
                :needsResync (:needs-resync? snap)}))))`);

		expect(out.terminal).toBe(true);
		expect(out.states.t1).toBe("applied");
		expect(out.states.t2).toBe("cancelled");
		expect(out.states.t3).toBe("failed");
		expect(out.states.t4).toBe("applied");
		expect(out.states.t5).toBe("unknown");
		expect(out.counts.applied).toBe(2);
		expect(out.counts.failed).toBe(1);
		expect(out.counts.cancelled).toBe(1);
		expect(out.counts.unknown).toBe(1);
		expect(out.needsResync).toBe(true);
	});
});
