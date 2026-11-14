import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
];
let moduleRoot;

beforeAll(async () => {
	nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
	moduleRoot = mkdtempSync(join(tmpdir(), "cljs-board-store-src-"));
	await nbb.loadFile(join(SRC, "ufss.cljs"));
	for (const name of MODULES) {
		const source = readFileSync(join(SRC, `${name}.cljs`), "utf8");
		const unwrapped = await nbb.loadString(
			`(require '[herd.ufss :as u]) (u/unwrap ${JSON.stringify(source)})`,
		);
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
         '[herd.swarm.kernel :as k]
         '[herd.swarm.model :as model]
         '[herd.swarm.store :as store]
         '[herd.swarm.apply :as apply]
         '[herd.swarm.token :as token])
${body}
(scenario)`);
	return JSON.parse(text);
}

const ROOT = () => mkdtempSync(join(tmpdir(), "cljs-board-store-m-"));

describe("CLJS board store and two-phase apply", () => {
	it("persists board, events and checkpoint through the file store", async () => {
		const root = ROOT();
		const out = await scenario(`
(defn ^:async scenario []
  (let [handle (store/open-board ${JSON.stringify(root)} "demo")
        _ (await (store/initialize-board! handle))
        r1 (await (apply/apply-board!
                    {:board handle
                     :command {:type "register_actor" :agentId "A" :slotId "S1"}
                     :request-id "r1" :turn-id "boot"}))
        r2 (await (apply/apply-board!
                    {:board handle
                     :command {:type "add_tasks"
                               :tasks [{:goal "job" :remaining-work "work" :done-when "done"}]}
                     :actor "A" :request-id "r2" :turn-id "add"}))
        board (await (store/read-board handle))
        fs (js/require "node:fs")
        base (str ${JSON.stringify(root)} "/.herd/missions/demo/")
        events-text (.readFileSync fs (str base "events.jsonl") "utf8")
        checkpoint-text (.readFileSync fs (str base "checkpoint.edn") "utf8")]
    (js/JSON.stringify
      (clj->js {:r1 (:ok r1) :r2 (:ok r2)
                :version (:board-version board)
                :task-count (count (:tasks board))
                :actor (get-in board [:actors "A" :agent-id])
                :event-lines (count (remove empty? (str/split-lines events-text)))
                :checkpoint? (str/includes? checkpoint-text "board-version")}))))`);

		expect(out.r1).toBe(true);
		expect(out.r2).toBe(true);
		expect(out.version).toBe(2);
		expect(out["task-count"]).toBe(1);
		expect(out.actor).toBe("A");
		expect(out["event-lines"]).toBeGreaterThanOrEqual(2);
		expect(out["checkpoint?"]).toBe(true);
	});

	it("replays a completed request without a second version or event", async () => {
		const root = ROOT();
		const out = await scenario(`
(defn ^:async scenario []
  (let [handle (store/open-board ${JSON.stringify(root)} "demo")
        _ (await (store/initialize-board! handle))
        command {:type "register_actor" :agentId "A" :slotId "S1"}
        r1 (await (apply/apply-board! {:board handle :command command
                                        :request-id "same" :turn-id "boot"}))
        r2 (await (apply/apply-board! {:board handle :command command
                                        :request-id "same" :turn-id "boot"}))
        board (await (store/read-board handle))
        fs (js/require "node:fs")
        events-text (.readFileSync fs ${JSON.stringify(join(root, ".herd/missions/demo/events.jsonl"))} "utf8")]
    (js/JSON.stringify
      (clj->js {:first (:ok r1) :replayed (:replayed r2)
                :version (:board-version board)
                :same-receipt (= (:receipt r1) (:receipt r2))
                :event-lines (count (remove empty? (str/split-lines events-text)))}))))`);

		expect(out.first).toBe(true);
		expect(out.replayed).toBe(true);
		expect(out.version).toBe(1);
		expect(out["same-receipt"]).toBe(true);
		expect(out["event-lines"]).toBe(1);
	});

	it("refuses to rebuild a missing board while the ledger still exists", async () => {
		const root = ROOT();
		const out = await scenario(`
(defn ^:async scenario []
  (let [handle (store/open-board ${JSON.stringify(root)} "demo")
        _ (await (store/initialize-board! handle))
        _ (await (apply/apply-board!
                   {:board handle
                    :command {:type "register_actor" :agentId "A" :slotId "S1"}
                    :request-id "r1" :turn-id "boot"}))
        fs (js/require "node:fs")
        base (str ${JSON.stringify(root)} "/.herd/missions/demo/")
        _ (.unlinkSync fs (str base "board.edn"))
        r2 (await (apply/apply-board!
                    {:board handle
                     :command {:type "record_input" :text "new"}
                     :request-id "r2" :turn-id "user"}))]
    (js/JSON.stringify (clj->js {:ok (:ok r2) :code (get-in r2 [:error :code])}))))`);

		expect(out.ok).toBe(false);
		expect(out.code).toBe("STALE_CONTROL");
	});

	it("never overwrites a corrupt board during initialize", async () => {
		const root = ROOT();
		const corruptPath = join(root, ".herd/missions/demo/board.edn");
		mkdirSync(dirname(corruptPath), { recursive: true });
		writeFileSync(corruptPath, "{:board-version 1 :tasks oops");
		const before = readFileSync(corruptPath, "utf8");
		const out = await scenario(`
(defn ^:async scenario []
  (let [handle (store/open-board ${JSON.stringify(root)} "demo")]
    (try
      (await (store/initialize-board! handle))
      (js/JSON.stringify (clj->js {:ok true}))
      (catch :default error
        (js/JSON.stringify (clj->js {:ok false :code (:code (ex-data error))}))))))`);

		expect(out.ok).toBe(false);
		expect(out.code).toBe("STALE_CONTROL");
		expect(readFileSync(corruptPath, "utf8")).toBe(before);
	});

	it("serializes two irreversible take attempts into one win and one loss", async () => {
		const root = ROOT();
		const out = await scenario(`
(defn ^:async scenario []
  (let [handle (store/open-board ${JSON.stringify(root)} "demo")
        _ (await (store/initialize-board! handle))
        _ (await (apply/apply-board!
                   {:board handle
                    :command {:type "register_actor" :agentId "A" :slotId "S1"}
                    :request-id "r1" :turn-id "boot"}))
        _ (await (apply/apply-board!
                   {:board handle
                    :command {:type "register_actor" :agentId "B" :slotId "S2"}
                    :request-id "r2" :turn-id "boot"}))
        _ (await (apply/apply-board!
                   {:board handle
                    :command {:type "add_tasks"
                              :tasks [{:goal "token" :remaining-work "run" :done-when "green"
                                       :needs-token true}]}
                    :actor "A" :request-id "r3" :turn-id "add"}))
        take-a (await (apply/apply-board!
                        {:board handle
                         :command {:type "take_or_die"
                                   :confirm token/take-or-die-confirmation
                                   :handoff-markdown "A handoff"}
                         :actor "A" :request-id "take-a" :turn-id "take"}))
        take-b (await (apply/apply-board!
                        {:board handle
                         :command {:type "take_or_die"
                                   :confirm token/take-or-die-confirmation
                                   :handoff-markdown "B handoff"}
                         :actor "B" :request-id "take-b" :turn-id "take"}))
        board (await (store/read-board handle))]
    (js/JSON.stringify
      (clj->js {:a (:ok take-a) :a-outcome (get-in take-a [:receipt :outcome])
                :b (:ok take-b) :b-outcome (get-in take-b [:receipt :outcome])
                :holder (get-in board [:token-slot :holder-id])
                :b-life (get-in board [:actors "B" :life-state])
                :version (:board-version board)}))))`);

		expect(out.a).toBe(true);
		expect(out["a-outcome"]).toBe("attempt-won");
		expect(out.b).toBe(true);
		expect(out["b-outcome"]).toBe("attempt-lost");
		expect(out.holder).toBe("A");
		expect(out["b-life"]).toBe("dead");
		expect(out.version).toBe(7);
	});
});