import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";

const SRC = fileURLToPath(new URL("../src/herd/", import.meta.url));
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
	"stages/paths",
	"stages/mission",
	"stages/tenure",
	"stages/disclosures",
	"stages/approval",
	"stages/store",
	"swarm/runner",
];
let moduleRoot;

beforeAll(async () => {
	nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
	moduleRoot = mkdtempSync(join(tmpdir(), "cljs-runner-src-"));
	await nbb.loadFile(join(SRC, "ufss.cljs"));
	for (const name of MODULES) {
		const source = readFileSync(join(SRC, `${name}.cljs`), "utf8");
		const unwrapped = await nbb.loadString(`(require '[herd.ufss :as u]) (u/unwrap ${JSON.stringify(source)})`);
		const target = join(moduleRoot, "herd", `${name}.cljs`);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, unwrapped);
	}
	nbb.addClassPath(moduleRoot);
	for (const name of MODULES) {
		await nbb.loadFile(join(moduleRoot, "herd", `${name}.cljs`));
	}
});

afterAll(() => {
	if (moduleRoot) rmSync(moduleRoot, { recursive: true, force: true });
});

const JSON_OUT = (expr) => `(js/JSON.stringify (clj->js ${expr}))`;

async function scenario(body) {
	const text = await nbb.loadString(`
(require '[herd.swarm.runner :as runner]
         '[herd.swarm.store :as store]
         '[herd.swarm.apply :as apply]
         '[herd.swarm.model :as model])
${PRELUDE}
${body}
(scenario)`);
	return JSON.parse(text);
}

const PRELUDE = `
(def mission
  {:mission-id "M1" :slug "demo" :revision 0 :stage :s5 :seed "seed"
   :tenure {:tenure-id "T-1" :index 1} :tenure-seq 1})

(defn ^:async seed-board []
  (let [handle (store/open-board "/tmp" "demo"
                                 {:store (store/create-memory-store)
                                  :durable false})]
    (await (apply/apply-board!
             {:board handle
              :command {:type "register_actor" :agentId "Coordinator" :slotId "C"}
              :request-id "seed-coordinator" :turn-id "boot"}))
    handle))

(defn ^:async board-of [handle]
  (await (store/read-board handle)))

(defn ^:async add-task [handle spec request]
  (await (apply/apply-board!
           {:board handle
            :command {:type "add_tasks" :tasks [spec]}
            :actor "Coordinator" :request-id request :turn-id "add"})))

(defn base-deps [handle extra]
  (merge {:board handle :root "/tmp" :slug "demo" :mission mission
          :actor "Coordinator"
          :uuid (fn [] "00000000-0000-4000-8000-000000000000")}
         extra))
`;

describe("CLJS S5 single-workspace runner", () => {
	it("instantiates non-empty findings as root tasks and wakes the whole slot pool", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [handle (await (seed-board))
        woken (atom [])
        deps (base-deps handle
                        {:slot-count 4
                         :wake-slot! (fn [request]
                                       (swap! woken conj (:slot-id request))
                                       {:ok true :slot-id (:slot-id request)})})
        result (await (runner/reviewer-findings!
                        deps
                        [{:key "K-1" :value "Fix the parser"}
                         {:key "K-2" :value "Add recovery evidence"}]
                        {}))
        board (await (board-of handle))
        tasks (vals (:tasks board))]
    ${JSON_OUT`{:status (:status result)
                 :ok (:ok result)
                 :task-count (count (:task-ids result))
                 :new-count (count (:new-task-ids result))
                 :woken @woken
                 :ledger-keys (sort (map :ledger-key tasks))
                 :goals (sort (map :goal tasks))
                 :wake-epoch (get-in board [:wake :epoch])
                 :root-parents (every? nil? (map :parent-id tasks))}`}))`);

		expect(out.ok).toBe(true);
		expect(out.status).toBe("review-open");
		expect(out["task-count"]).toBe(2);
		expect(out["new-count"]).toBe(2);
		expect(out.woken).toEqual(["S1", "S2", "S3", "S4"]);
		expect(out["ledger-keys"]).toEqual(["K-1", "K-2"]);
		expect(out.goals).toEqual(["Add recovery evidence", "Fix the parser"]);
		expect(out["wake-epoch"]).toBeGreaterThan(0);
		expect(out["root-parents"]).toBe(true);
	});

	it("retires the tenure, writes a barrier and starts a successor Reviewer", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [handle (await (seed-board))
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
        result (await (runner/reviewer-findings! deps [] {}))
        board (await (board-of handle))]
    ${JSON_OUT`{:status (:status result)
                 :ok (:ok result)
                 :barrier (:barrier result)
                 :successor (:successor result)
                 :reviewer-name (:name @reviewer)
                 :reviewer-role (:role @reviewer)
                 :persisted-barrier (:barrier (deref persisted))
                 :board-tenure (:tenure-id board)
                 :board-tasks (count (:tasks board))}`}))`);

		expect(out.ok).toBe(true);
		expect(out.status).toBe("relayed");
		expect(out.barrier["retired-tenure"]).toBe("T-1");
		expect(out.barrier["successor-tenure"]).toBe("T-2");
		expect(out.barrier.from).toBe("s5");
		expect(out.barrier.to).toBe("s5");
		expect(out.successor["tenure-id"]).toBe("T-2");
		expect(out["reviewer-role"]).toBe("Reviewer");
		expect(out["reviewer-name"]).toContain("T-2");
		expect(out["persisted-barrier"]["successor-tenure"]).toBe("T-2");
	});

	it("does not rotate while the board is not quiescent", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [handle (await (seed-board))
        _ (await (add-task handle {:goal "open" :remaining_work "work" :done_when "done"} "add-1"))
        reviewer (atom nil)
        deps (base-deps handle
                        {:subagent (fn [request] (reset! reviewer request) {:ok true})})
        result (await (runner/reviewer-findings! deps [] {}))
        board (await (board-of handle))]
    ${JSON_OUT`{:status (:status result)
                 :ok (:ok result)
                 :reasons (mapv :code (get-in result [:quiescence :reasons]))
                 :reviewer-called (some? @reviewer)
                 :board-tenure (:tenure-id board)
                 :task-count (count (:tasks board))}`}))`);

		expect(out.ok).toBe(true);
		expect(out.status).toBe("stay");
		expect(out.reasons).toContain("BOARD_NOT_EMPTY");
		expect(out["reviewer-called"]).toBe(false);
		expect(out["board-tenure"]).toBeNull();
		expect(out["task-count"]).toBe(1);
	});

	it("does not rotate while the workspace write lock is still held", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [handle (await (seed-board))
        reviewer (atom nil)
        deps (base-deps handle
                        {:write-lock-held? (fn [] true)
                         :subagent (fn [request] (reset! reviewer request) {:ok true})})
        result (await (runner/reviewer-findings! deps [] {}))]
    ${JSON_OUT`{:status (:status result)
                 :ok (:ok result)
                 :reasons (mapv :code (get-in result [:quiescence :reasons]))
                 :reviewer-called (some? @reviewer)}`}))`);

		expect(out.ok).toBe(true);
		expect(out.status).toBe("stay");
		expect(out.reasons).toContain("WRITE_LOCK_HELD");
		expect(out["reviewer-called"]).toBe(false);
	});

	it("asks the one-shot initial question exactly once, then rotates", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [handle (await (seed-board))
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
                         :subagent (fn [_request] (swap! reviewer inc) {:ok true})})
        first (await (runner/reviewer-findings! deps [] {}))
        board-after-first (await (board-of handle))
        second (await (runner/reviewer-findings! deps [] {}))]
    ${JSON_OUT`{:first-status (:status first)
                 :first-answer (:answer first)
                 :asked @asked
                 :ask-used (get-in board-after-first [:tenure :initial-ask-used])
                 :second-status (:status second)
                 :reviewer-starts @reviewer}`}))`);

		expect(out["first-status"]).toBe("ask-user");
		expect(out["first-answer"]).toBe("keep going");
		expect(out.asked).toBe(1);
		expect(out["ask-used"]).toBe(true);
		expect(out["second-status"]).toBe("relayed");
		expect(out["reviewer-starts"]).toBe(1);
	});

	it("keeps a fixed four-slot pool and replaces a dead slot with a new agent id", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [handle (await (seed-board))
        counter (atom 0)
        woken (atom [])
        deps (base-deps handle
                        {:uuid (fn [] (swap! counter inc)
                                 (let [digits (str "00000000" @counter)]
                                   (str (subs digits
                                              (max 0 (- (count digits) 8)))
                                      "-0000-4000-8000-000000000000")))
                         :slot-count 4
                         :wake-slot! (fn [request]
                                       (swap! woken conj [(:slot-id request) (:agent-id request)])
                                       {:ok true})})
        pool (await (runner/init-slot-pool! deps {}))
        before (await (board-of handle))
        replacement (await (runner/replace-slot! deps "S1" {:reason "agent died"}))
        after (await (board-of handle))]
    ${JSON_OUT`{:ok (:ok pool)
                 :slots (mapv :slot-id (:slots pool))
                 :actor-count (count (filter (fn [[_ actor]]
                                               (and (= :alive (:life-state actor))
                                                    (= :normal (:role actor))
                                                    (some? (re-matches #"S[0-9]+"
                                                                       (str (:slot-id actor))))))
                                             (:actors before)))
                 :old-agent (:old-agent-id replacement)
                 :new-agent (:agent-id replacement)
                 :old-life (get-in after [:actors (:old-agent-id replacement) :life-state])
                 :new-life (get-in after [:actors (:agent-id replacement) :life-state])
                 :woken @woken}`}))`);

		expect(out.ok).toBe(true);
		expect(out.slots).toEqual(["S1", "S2", "S3", "S4"]);
		expect(out["actor-count"]).toBe(4);
		expect(out["old-agent"]).not.toBe(out["new-agent"]);
		expect(out["old-life"]).toBe("dead");
		expect(out["new-life"]).toBe("alive");
	});

	it("wakes a parked slot once the board epoch advances", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [handle (await (seed-board))
        _ (await (apply/apply-board!
                   {:board handle
                    :command {:type "register_actor" :agentId "A" :slotId "S1"}
                    :request-id "seed-a" :turn-id "boot"}))
        woken (atom [])
        deps (base-deps handle
                        {:wake-slot! (fn [request]
                                       (swap! woken conj (:slot-id request))
                                       {:ok true})})
        parked-result (await (runner/park-slot! deps "S1" {}))
        _ (await (add-task handle {:goal "wake work" :remaining-work "work" :done-when "done"} "add-wake"))
        woken-result (await (runner/wake-parked! deps (:parked parked-result)))]
    ${JSON_OUT`{:park-ok (:ok parked-result)
                 :parked (:parked parked-result)
                 :wake-ok (:ok woken-result)
                 :woken (:woken woken-result)
                 :still (:still-parked woken-result)
                 :wake-epoch (:wake-epoch woken-result)}`}))`);

		expect(out["park-ok"]).toBe(true);
		expect(out.parked["slot-id"]).toBe("S1");
		expect(out["wake-ok"]).toBe(true);
		expect(out.woken).toEqual(["S1"]);
		expect(out.still).toEqual([]);
		expect(out["wake-epoch"]).toBeGreaterThan(0);
	});

	it("installs the runner API for the entry point without model-facing tools", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [result (runner/register-runner! nil {})]
    ${JSON_OUT`{:ok (:ok result)
                 :tools (:tools result)
                 :has-start (fn? (.-startReviewer js/globalThis.__herdS5))
                 :has-findings (fn? (.-reviewerFindings js/globalThis.__herdS5))
                 :has-relay (fn? (.-relay js/globalThis.__herdS5))
                 :contract-subagent (get-in result [:contract :subagent])}`}))`);

		expect(out.ok).toBe(true);
		expect(out.tools).toEqual([]);
		expect(out["has-start"]).toBe(true);
		expect(out["has-findings"]).toBe(true);
		expect(out["has-relay"]).toBe(true);
		expect(out["contract-subagent"]).toContain("artifactsDir");
	});
	it("reuses the root task for a repeated ledger key instead of adding duplicates", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [handle (await (seed-board))
        woken (atom [])
        deps (base-deps handle
                        {:slot-count 1
                         :wake-slot! (fn [request]
                                       (swap! woken conj (:slot-id request))
                                       {:ok true})})
        first (await (runner/reviewer-findings! deps [{:key "K-1" :value "Fix it"}] {}))
        after-first (await (board-of handle))
        second (await (runner/reviewer-findings! deps [{:key "K-1" :value "Fix it"}] {}))
        after-second (await (board-of handle))
        third (await (runner/reviewer-findings! deps [{:key "K-1" :value "Fix it better"}] {}))
        after-third (await (board-of handle))]
    ${JSON_OUT`{:first-new (count (:new-task-ids first))
                 :first-count (count (:tasks after-first))
                 :second-new (count (:new-task-ids second))
                 :second-updated (vec (:updated-task-ids second))
                 :second-count (count (:tasks after-second))
                 :third-new (count (:new-task-ids third))
                 :third-count (count (:tasks after-third))
                 :goal (get-in after-third [:tasks "T-1" :goal])}`}))`);

		expect(out["first-new"]).toBe(1);
		expect(out["first-count"]).toBe(1);
		expect(out["second-new"]).toBe(0);
		expect(out["second-updated"]).toHaveLength(1);
		expect(out["second-count"]).toBe(1);
		expect(out["third-new"]).toBe(0);
		expect(out["third-count"]).toBe(1);
		expect(out.goal).toBe("Fix it better");
	});

	it("installs the runner API from a dependency map", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [api (runner/install! {:root "/tmp" :slug "demo" :mission mission})]
    ${JSON_OUT`{:methods (sort (map name (keys api)))
                 :all-fn (every? fn? (vals api))
                 :has-ask (fn? (:askInitial api))}`}))`);

		expect(out["all-fn"]).toBe(true);
		expect(out["has-ask"]).toBe(true);
		expect(out.methods).toEqual([
			"askInitial",
			"initSlotPool",
			"parkSlot",
			"quiescence",
			"relay",
			"replaceSlot",
			"reviewerFindings",
			"startReviewer",
			"wakeParked",
		]);
	});
});
