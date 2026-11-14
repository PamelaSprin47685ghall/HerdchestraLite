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
	"swarm/tools",
];
let moduleRoot;

beforeAll(async () => {
	nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
	moduleRoot = mkdtempSync(join(tmpdir(), "cljs-board-tools-src-"));
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

async function scenario(body) {
	const text = await nbb.loadString(`
(require '[clojure.string :as str]
         '[herd.swarm.model :as model]
         '[herd.swarm.store :as store]
         '[herd.swarm.apply :as apply]
         '[herd.swarm.tools :as tools])
${PRELUDE}
${body}
(scenario)`);
	return JSON.parse(text);
}

const PRELUDE = `
(defn ^:async seed [root]
  (let [handle (store/open-board root "demo"
                                 {:store (store/create-memory-store)
                                  :durable false})
        deps {:handle handle
              :root-of (fn [_] root)
              :slug-of (fn [_] "demo")
              :actor-of (fn [_] {:agent-id "A"})
              :turn-of (fn [_ ctx] ctx)}
        reg (fn [id slot request]
              (apply/apply-board! {:board handle
                                   :command {:type "register_actor" :agentId id :slotId slot}
                                   :request-id request :turn-id "boot"}))
        add (fn [spec request]
              (apply/apply-board! {:board handle
                                   :command {:type "add_tasks" :tasks [spec]}
                                   :actor "A" :request-id request :turn-id "add"}))]
    (await (reg "A" "S1" "reg-a"))
    (await (reg "B" "S2" "reg-b"))
    [handle deps]))
`;

describe("CLJS board tool surface", () => {
	it("exports eleven board tools with required snake_case parameters", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [defs (tools/tool-definitions {:root "/tmp" :slug "demo" :actor "A"})]
    (js/JSON.stringify
      (clj->js {:names (mapv :name defs)
                :required (mapv (fn [d] (vec (:required (:parameters d)))) defs)
                :all-execute (every? (fn [d] (fn? (:execute d))) defs)}))))`);

		expect(out.names).toEqual([
			"board_split",
			"board_claim",
			"board_finish",
			"board_cancel",
			"board_replace",
			"board_release",
			"board_reopen",
			"board_comment",
			"board_update",
			"board_park_slot",
			"board_take_or_die",
		]);
		expect(out.required[0]).toEqual(["parent_id", "expected_board_version", "children", "remaining_work"]);
		expect(out.required[1]).toEqual(["task_id", "atomicity_reason"]);
		expect(out.required[2]).toEqual(["task_id", "claim_id", "result_summary"]);
		expect(out["all-execute"]).toBe(true);
	});

	it("claims and finishes a task through the tool receipts", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [root "/tmp"
        [handle deps] (await (seed root))
        _ (await (apply/apply-board!
                   {:board handle
                    :command {:type "add_tasks"
                              :tasks [{:goal "job" :remaining-work "work" :done-when "done"}]}
                    :actor "A" :request-id "add-1" :turn-id "add"}))
        board (await (store/read-board handle))
        task-id (first (keys (:tasks board)))
        claimed (await (tools/execute-tool! deps :board_claim
                                            {:task_id task-id :atomicity_reason "atomic"}
                                            nil "call-1"))
        after-claim (await (store/read-board handle))
        claim-id (get-in after-claim [:tasks task-id :claim-id])
        finished (await (tools/execute-tool! deps :board_finish
                                            {:task_id task-id :claim_id claim-id
                                             :result_summary "done" :dependency_paths ["src/a.cljs"]}
                                            nil "call-2"))
        final-board (await (store/read-board handle))]
    (js/JSON.stringify
      (clj->js {:claim-error (:isError claimed)
                :claim-text (get-in claimed [:content 0 :text])
                :finish-error (:isError finished)
                :state (get-in final-board [:tasks task-id :state])
                :version (:board-version final-board)}))))`);

		expect(out["claim-error"]).toBe(false);
		expect(out["claim-text"]).toContain(":outcome :claimed");
		expect(out["finish-error"]).toBe(false);
		expect(out.state).toBe("done");
		expect(out.version).toBe(5);
	});

	it("splits with the observed version and rejects a stale one", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [root "/tmp"
        [handle deps] (await (seed root))
        _ (await (apply/apply-board!
                   {:board handle
                    :command {:type "add_tasks"
                              :tasks [{:goal "root" :remaining-work "integrate" :done-when "green"}]}
                    :actor "A" :request-id "add-1" :turn-id "add"}))
        board (await (store/read-board handle))
        parent (first (keys (:tasks board)))
        version (:board-version board)
        split (await (tools/execute-tool! deps :board_split
                                          {:parent_id parent
                                           :expected_board_version version
                                           :remaining_work "integrate"
                                           :children [{:goal "one" :remaining_work "w1" :done_when "d1"}
                                                      {:goal "two" :remaining_work "w2" :done_when "d2"}]}
                                          nil "call-split"))
        stale (await (tools/execute-tool! deps :board_split
                                          {:parent_id parent
                                           :expected_board_version version
                                           :remaining_work "integrate again"
                                           :children [{:goal "three" :remaining_work "w3" :done_when "d3"}]}
                                          nil "call-stale"))
        after (await (store/read-board handle))]
    (js/JSON.stringify
      (clj->js {:split-error (:isError split)
                :parent-state (get-in after [:tasks parent :state])
                :child-count (count (get-in after [:tasks parent :child-ids]))
                :stale-error (:isError stale)
                :stale-text (get-in stale [:content 0 :text])}))))`);

		expect(out["split-error"]).toBe(false);
		expect(out["parent-state"]).toBe("waiting");
		expect(out["child-count"]).toBe(2);
		expect(out["stale-error"]).toBe(true);
		expect(out["stale-text"]).toContain(":code :BOARD_CONFLICT");
	});

	it("replays one take-or-die call id without a second term", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [root "/tmp"
        [handle deps] (await (seed root))
        _ (await (apply/apply-board!
                   {:board handle
                    :command {:type "add_tasks"
                              :tasks [{:goal "token" :remaining-work "run" :done-when "green"
                                       :needs-token true}]}
                    :actor "A" :request-id "add-1" :turn-id "add"}))
        params {:request_id "take-1"
                :confirm "i-hereby-confirm-i-die-without-regret"
                :handoff_markdown "handoff"}
        first (await (tools/execute-tool! deps :board_take_or_die params nil "call-take"))
        second (await (tools/execute-tool! deps :board_take_or_die params nil "call-take"))
        changed (await (tools/execute-tool! deps :board_take_or_die
                                           (assoc params :handoff_markdown "different") nil "call-take"))
        board (await (store/read-board handle))]
    (js/JSON.stringify
      (clj->js {:first-error (:isError first)
                :first-text (get-in first [:content 0 :text])
                :second-text (get-in second [:content 0 :text])
                :same? (= (get-in first [:content 0 :text])
                          (get-in second [:content 0 :text]))
                :changed-text (get-in changed [:content 0 :text])
                :holder (get-in board [:token-slot :holder-id])
                :terms (count (get-in board [:token-slot :retired-terms]))}))))`);

		expect(out["first-error"]).toBe(false);
		expect(out["first-text"]).toContain(":outcome :attempt-won");
		expect(out["same?"]).toBe(true);
		expect(out["changed-text"]).toContain(":code :CALL_REPLAY_MISMATCH");
		expect(out.holder).toBe("A");
		expect(out.terms).toBe(0);
	});
});
