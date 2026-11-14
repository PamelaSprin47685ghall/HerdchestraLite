import { beforeAll, describe, expect, it } from "bun:test";
import * as nbb from "nbb";
import { ensureModules } from "./helpers/nbb-boot.mjs";

const MODULES = [
	"util/atomic_write",
	"swarm/edn",
	"swarm/model",
	"swarm/ledger",
	"swarm/actors",
	"swarm/tasks",
	"swarm/commands",
	"swarm/token",
	"swarm/kernel",
	"swarm/store",
	"swarm/apply",
];
let _moduleRoot;

beforeAll(async () => {
	await ensureModules(MODULES);
});

const JSON_OUT = (expr) => `(js/JSON.stringify (clj->js ${expr}))`;
const parse = (text) => JSON.parse(text);

async function scenario(body) {
	const text = await nbb.loadString(`
(require '[herd.swarm.kernel :as k]
         '[herd.swarm.model :as m]
         '[herd.swarm.store :as store]
         '[herd.swarm.apply :as apply]
         '[herd.swarm.token :as token])
${body}
(scenario)`);
	return parse(text);
}

const PRELUDE = `
(defn step [board command request actor turn]
  (k/apply-command board {:command command :actor actor
                          :turn-id (or turn "turn")
                          :request-id request}))

(defn reg [board id slot request]
  (step board {:type "register_actor" :agentId id :slotId slot} request nil "boot"))

(defn add-task [board actor request spec]
  (step board {:type "add_tasks" :tasks [spec]} request actor "add"))

(defn claim [board actor request task-id reason]
  (step board {:type "claim" :taskId task-id :atomicityReason (or reason "atomic")}
        request actor "claim"))

(defn finish [board actor request task-id claim-id paths]
  (step board {:type "finish" :taskId task-id :claimId claim-id
               :resultSummary "finished" :dependency_paths (or paths ["src/a.cljs"])}
        request actor "finish"))
`;

describe("CLJS board kernel", () => {
	it("splits, revives a parent to ready and rejects a same-turn finish", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  ${PRELUDE}
  (let [s0 (m/initial-board {:mode :swarm})
        r1 (reg s0 "A" "S1" "r1")
        r2 (reg (:board r1) "B" "S2" "r2")
        r3 (add-task (:board r2) "A" "r3" {:goal "root" :remaining_work "integrate" :done_when "green"})
        parent (first (get-in r3 [:receipt :task-ids]))
        r4 (step (:board r3)
                 {:type "split" :parentId parent
                  :remaining_work "wire and integrate"
                  :children [{:goal "part-1" :remaining_work "do-1" :done_when "done-1"}
                             {:goal "part-2" :remaining_work "do-2" :done_when "done-2"}]
                  :expected_board_version (get-in r3 [:board :board-version])}
                 "r4" "A" "split")
        child-ids (get-in r4 [:receipt :child-ids])
        c1 (first child-ids)
        c2 (second child-ids)
        a1 (claim (:board r4) "A" "r5" c1)
        f1 (finish (:board a1) "A" "r6" c1 (get-in a1 [:receipt :claim-id]))
        a2 (claim (:board f1) "B" "r7" c2)
        f2 (finish (:board a2) "B" "r8" c2 (get-in a2 [:receipt :claim-id]))
        parent-state (get-in f2 [:board :tasks parent :state])
        bad (finish (:board f2) "A" "r9" parent (get-in f2 [:board :tasks parent :claim-id]) ["src/a.cljs"])]
    ${JSON_OUT`{:split-ok (:ok r4)
                 :parent-state-mid (get-in r4 [:board :tasks parent :state])
                 :revived-parent-ids (get-in f2 [:receipt :revived-parent-ids])
                 :parent-id parent
                 :parent-state parent-state
                 :same-turn-code (get-in bad [:error :code])}`}))`);

		expect(out["split-ok"]).toBe(true);
		expect(out["parent-state-mid"]).toBe("waiting");
		expect(out["revived-parent-ids"]).toEqual([out["parent-id"]]);
		expect(out["parent-state"]).toBe("ready");
		expect(out["same-turn-code"]).toBe("PARENT_NOT_READY");
	});

	it("keeps claim ownership and releases only before applying", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  ${PRELUDE}
  (let [s0 (m/initial-board {:mode :swarm})
        r1 (reg s0 "A" "S1" "r1")
        r2 (reg (:board r1) "B" "S2" "r2")
        r3 (add-task (:board r2) "A" "r3" {:goal "job" :remaining_work "work" :done_when "done"})
        task-id (first (get-in r3 [:receipt :task-ids]))
        a1 (claim (:board r3) "A" "r4" task-id)
        claim-id (get-in a1 [:receipt :claim-id])
        wrong (finish (:board a1) "B" "r5" task-id claim-id)
        rel (step (:board a1) {:type "release" :taskId task-id :claimId claim-id} "r6" "A" "rel")
        claim-b (claim (:board rel) "B" "r7" task-id "atomic-b")
        start (step (:board claim-b)
                    {:type "start_action" :taskId task-id
                     :claimId (get-in claim-b [:receipt :claim-id]) :kind "edit" :phase "applying"}
                    "r8" "B" "act")
        late (step (:board start)
                   {:type "release" :taskId task-id
                    :claimId (get-in claim-b [:receipt :claim-id])}
                   "r9" "B" "rel2")]
    ${JSON_OUT`{:wrong-code (get-in wrong [:error :code])
                 :release-ok (:ok rel)
                 :owner (get-in rel [:board :tasks task-id :owner-id])
                 :claim-ok (:ok claim-b)
                 :late-code (get-in late [:error :code])}`}))`);

		expect(out["wrong-code"]).toBe("CLAIM_CHANGED");
		expect(out["release-ok"]).toBe(true);
		expect(out.owner).toBeNull();
		expect(out["claim-ok"]).toBe(true);
		expect(out["late-code"]).toBe("CLAIM_CHANGED");
	});

	it("runs one irreversible token race and retires a holder without responsibility", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  ${PRELUDE}
  (let [s0 (m/initial-board {:mode :swarm})
        r1 (reg s0 "A" "S1" "r1")
        r2 (reg (:board r1) "B" "S2" "r2")
        r3 (add-task (:board r2) "A" "r3" {:goal "token-job" :remaining_work "run-tests" :done_when "green" :needs_token true})
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
        holder (get-in take-a [:board :token-slot :holder-id])
        b-dead (get-in take-b [:board :actors "B" :life-state])
        a-claim (claim (:board take-b) "A" "r6" token-task "atomic")
        a-finish (finish (:board a-claim) "A" "r7" token-task (get-in a-claim [:receipt :claim-id]))
        retired (m/responsibility-set (:board a-finish) "A")]
    ${JSON_OUT`{:a-code (get-in take-a [:receipt :outcome])
                 :b-code (get-in take-b [:receipt :outcome])
                 :holder holder
                 :b-dead b-dead
                 :token-state (get-in a-finish [:board :token-slot :state])
                 :holder-id (get-in a-finish [:board :token-slot :holder-id])
                 :a-life (get-in a-finish [:board :actors "A" :life-state])
                 :retired-terms (get-in a-finish [:board :token-slot :retired-terms])
                 :responsibilities retired}`}))`);

		expect(out["a-code"]).toBe("attempt-won");
		expect(out["b-code"]).toBe("attempt-lost");
		expect(out.holder).toBe("A");
		expect(out["b-dead"]).toBe("dead");
		expect(out["token-state"]).toBe("free");
		expect(out["holder-id"]).toBeNull();
		expect(out["a-life"]).toBe("dead");
		expect(out["retired-terms"]).toEqual(["TERM-1"]);
		expect(out.responsibilities).toEqual([]);
	});

	it("parks only on a truly empty board and wakes on user input", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  ${PRELUDE}
  (let [s0 (m/initial-board {:mode :swarm})
        r1 (reg s0 "A" "S1" "r1")
        r2 (add-task (:board r1) "A" "r2" {:goal "job" :remaining_work "work" :done_when "done"})
        task-id (first (get-in r2 [:receipt :task-ids]))
        rejected (step (:board r2)
                       {:type "park_slot"
                        :observed_board_version (get-in r2 [:board :board-version])}
                       "r3" "A" "park")
        a1 (claim (:board r2) "A" "r4" task-id)
        f1 (finish (:board a1) "A" "r5" task-id (get-in a1 [:receipt :claim-id]))
        parked (step (:board f1)
                     {:type "park_slot"
                      :observed_board_version (get-in f1 [:board :board-version])}
                     "r6" "A" "park2")
        input (step (:board parked) {:type "record_input" :text "new requirement"} "r7" nil "user")
        sleepers-after (keys (get-in input [:board :sleepers]))]
    ${JSON_OUT`{:reject-code (get-in rejected [:error :code])
                 :progressable (count (get-in rejected [:error :summary :progressable]))
                 :park-outcome (get-in parked [:receipt :outcome])
                 :sleepers (count (get-in parked [:board :sleepers]))
                 :input-outcome (get-in input [:receipt :outcome])
                 :sleepers-after (vec sleepers-after)
                 :wake-epoch (get-in input [:board :wake :epoch])}`}))`);

		expect(out["reject-code"]).toBe("BOARD_CONFLICT");
		expect(out.progressable).toBeGreaterThan(0);
		expect(out["park-outcome"]).toBe("parked");
		expect(out.sleepers).toBe(1);
		expect(out["input-outcome"]).toBe("input-recorded");
		expect(out["sleepers-after"]).toEqual([]);
		expect(out["wake-epoch"]).toBe(1);
	});

	it("revives a condition-only parent when the condition resolves", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  ${PRELUDE}
  (let [s0 (m/initial-board {:mode :swarm})
        r1 (reg s0 "A" "S1" "r1")
        r2 (add-task (:board r1) "A" "r2" {:goal "root" :remaining_work "integrate" :done_when "green"})
        parent (first (get-in r2 [:receipt :task-ids]))
        r3 (step (:board r2)
                 {:type "split" :parentId parent
                  :remaining_work "integrate"
                  :expected_board_version (get-in r2 [:board :board-version])
                  :wait_for ["condition:api-ready"]
                  :children [{:goal "child" :remaining_work "work" :done_when "done"}]}
                 "r3" "A" "split")
        waiting (get-in r3 [:board :tasks parent :state])
        resolved (step (:board r3) {:type "resolve_condition" :key "api-ready" :value true}
                       "r4" "A" "cond")
        revived (get-in resolved [:board :tasks parent :state])]
    ${JSON_OUT`{:waiting waiting :revived revived :parent-id parent
                 :revived-ids (get-in resolved [:receipt :revived-task-ids])
                 :wait-for (get-in resolved [:board :tasks parent :wait-for])}`}))`);

		expect(out.waiting).toBe("waiting");
		expect(out.revived).toBe("ready");
		expect(out["revived-ids"]).toContain(out["parent-id"]);
		expect(out["wait-for"]).toEqual([]);
	});

	it("replays one request id and rejects changed payloads", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  ${PRELUDE}
  (let [s0 (m/initial-board {:mode :swarm})
        r1 (reg s0 "A" "S1" "r1")
        r2 (add-task (:board r1) "A" "r2" {:goal "job" :remaining_work "work" :done_when "done"})
        task-id (first (get-in r2 [:receipt :task-ids]))
        a1 (claim (:board r2) "A" "same" task-id)
        a2 (claim (:board a1) "A" "same" task-id)
        changed (step (:board a1) {:type "claim" :taskId task-id
                                    :atomicityReason "different reason"}
                      "same" "A" "claim")]
    ${JSON_OUT`{:first (:ok a1) :second-replayed (:replayed a2)
                 :same-claim (= (get-in a1 [:receipt :claim-id])
                                (get-in a2 [:receipt :claim-id]))
                 :changed-code (get-in changed [:error :code])}`}))`);

		expect(out.first).toBe(true);
		expect(out["second-replayed"]).toBe(true);
		expect(out["same-claim"]).toBe(true);
		expect(out["changed-code"]).toBe("CALL_REPLAY_MISMATCH");
	});

	it("T05/T06: dynamically assigns new token tasks before retirement and keeps them free after retirement", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  ${PRELUDE}
  (let [s0 (m/initial-board {:mode :swarm})
        r1 (reg s0 "A" "S1" "r1")
        r2 (reg (:board r1) "B" "S2" "r2")
        r3 (add-task (:board r2) "A" "r3" {:goal "x" :remaining_work "work-x" :done_when "done-x" :needs_token true})
        tx (first (get-in r3 [:receipt :task-ids]))
        take-a (step (:board r3)
                     {:type "take_or_die"
                      :confirm token/take-or-die-confirmation
                      :handoff_markdown "A holds"}
                     "r4" "A" "take")
        r4 (add-task (:board take-a) "B" "r5" {:goal "y" :remaining_work "work-y" :done_when "done-y" :needs_token true})
        ty (first (get-in r4 [:receipt :task-ids]))
        cx (claim (:board r4) "A" "r6" tx "atomic-x")
        fx (finish (:board cx) "A" "r7" tx (get-in cx [:receipt :claim-id]))
        a-life-mid (get-in fx [:board :actors "A" :life-state])
        holder-mid (get-in fx [:board :token-slot :holder-id])
        cy (claim (:board fx) "A" "r8" ty "atomic-y")
        fy (finish (:board cy) "A" "r9" ty (get-in cy [:receipt :claim-id]))
        a-life-end (get-in fy [:board :actors "A" :life-state])
        token-end (get-in fy [:board :token-slot :state])
        r5 (add-task (:board fy) "B" "r10" {:goal "z" :remaining_work "work-z" :done_when "done-z" :needs_token true})
        a-life-after (get-in r5 [:board :actors "A" :life-state])
        holder-after (get-in r5 [:board :token-slot :holder-id])]
    ${JSON_OUT`{:a-life-mid a-life-mid
                 :holder-mid holder-mid
                 :a-life-end a-life-end
                 :token-end token-end
                 :a-life-after a-life-after
                 :holder-after holder-after}`}))`);

		expect(out["a-life-mid"]).toBe("alive");
		expect(out["holder-mid"]).toBe("A");
		expect(out["a-life-end"]).toBe("dead");
		expect(out["token-end"]).toBe("free");
		expect(out["a-life-after"]).toBe("dead");
		expect(out["holder-after"]).toBeNull();
	});

	it("T11/V02: rejects late normal submissions from a dead actor without mutating the task", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  ${PRELUDE}
  (let [s0 (m/initial-board {:mode :swarm})
        r1 (reg s0 "A" "S1" "r1")
        r2 (reg (:board r1) "B" "S2" "r2")
        r3 (add-task (:board r2) "B" "r3" {:goal "p" :remaining_work "work-p" :done_when "done-p"})
        tp (first (get-in r3 [:receipt :task-ids]))
        cb (claim (:board r3) "B" "r4" tp "atomic-p")
        claim-b (get-in cb [:receipt :claim-id])
        r4 (add-task (:board cb) "A" "r5" {:goal "tok" :remaining_work "tok" :done_when "tok" :needs_token true})
        ta (step (:board r4) {:type "take_or_die" :confirm token/take-or-die-confirmation :handoff_markdown "A"} "r6" "A" "ta")
        tb (step (:board ta) {:type "take_or_die" :confirm token/take-or-die-confirmation :handoff_markdown "B"} "r7" "B" "tb")
        late-finish (finish (:board tb) "B" "r8" tp claim-b)
        p-state (get-in tb [:board :tasks tp :state])
        p-owner (get-in tb [:board :tasks tp :owner-id])]
    ${JSON_OUT`{:late-ok (:ok late-finish)
                 :late-code (get-in late-finish [:error :code])
                 :p-state p-state
                 :p-owner p-owner}`}))`);

		expect(out["late-ok"]).toBe(false);
		expect(out["late-code"]).toBe("ACTOR_DEAD");
		expect(out["p-state"]).toBe("ready");
		expect(out["p-owner"]).toBeNull();
	});
});
