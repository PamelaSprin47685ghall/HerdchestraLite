import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
	"stages/paths",
	"stages/parsers",
	"stages/audit",
	"stages/scores",
	"stages/report",
	"stages/approval",
	"swarm/auditors",
];
let _moduleRoot;
let workspace;

beforeAll(async () => {
	await ensureModules(MODULES);
});

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "cljs-auditors-ws-"));
	for (const name of [
		"s1-brainstorm.md",
		"s2-manual-tests.md",
		"s3-dev-guide.md",
		"s4-coordination.md",
		"s4-coordination.pml",
	]) {
		mkdirSync(join(workspace, "plans", "demo"), { recursive: true });
		writeFileSync(join(workspace, "plans", "demo", name), `document ${name}`);
	}
	mkdirSync(join(workspace, ".herd", "missions", "demo"), { recursive: true });
	writeFileSync(join(workspace, ".herd", "missions", "demo", "s2-cases.edn"), "[]");
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

const JSON_OUT = (expr) => `(js/JSON.stringify (clj->js ${expr}))`;

async function scenario(body) {
	const text = await nbb.loadString(`
(require '[herd.swarm.auditors :as auditors]
         '[clojure.string :as str]
         '[herd.swarm.store :as store]
         '[herd.swarm.apply :as apply]
         '[herd.swarm.model :as model]
         '[herd.stages.audit :as audit]
         '[herd.util.atomic-write :as atomic])
(def root ${JSON.stringify(workspace)})
${PRELUDE}
${body}
(scenario)`);
	return JSON.parse(text);
}

const PRELUDE = `
(def valid-cases
  [{:case_id "CASE-A" :path "正常" :threshold 80
    :steps ["执行正常路径"] :expected "正常结果" :rubric "0..100"}
   {:case_id "CASE-B" :path "错误" :threshold 80
    :steps ["执行错误路径"] :expected "错误结果" :rubric "0..100"}
   {:case_id "CASE-C" :path "边界" :threshold 80
    :steps ["执行边界路径"] :expected "边界结果" :rubric "0..100"}
   {:case_id "CASE-D" :path "并发" :threshold 80
    :steps ["执行并发路径"] :expected "并发结果" :rubric "0..100"}
   {:case_id "CASE-E" :path "恢复" :threshold 80
    :steps ["执行恢复路径"] :expected "恢复结果" :rubric "0..100"}])

(def mission {:mission-id "M1" :revision 0 :slug "demo"})

(defn make-deps [extra]
  (merge {:root root :slug "demo" :mission mission :dataset valid-cases
          :prepare-isolation! (fn [request]
                                {:ok true
                                 :cwd (str "/tmp/herd-audit-demo-" (:case-id request) "-batch")
                                 :artifacts-dir (str "/tmp/herd-audit-demo-" (:case-id request) "/artifacts")
                                 :session-name (str "herd-demo-" (:case-id request))
                                 :excluded ["node_modules"]})
          :timeout-ms 1000
          :set-timeout (fn [_f _ms] 1)
          :clear-timeout (fn [_] nil)
          :uuid (fn [] "00000000-0000-4000-8000-000000000000")}
         extra))

(defn ^:async submit! [case-id user developer]
  (await (audit/write-submission-once!
           root "demo" case-id
           {:case_id case-id
            :user_score user
            :developer_score developer
            :report_markdown (str "report " case-id)} nil)))

(defn ^:async seed-board []
  (let [handle (store/open-board root "demo"
                                 {:store (store/create-memory-store)
                                  :durable false})]
    (await (apply/apply-board!
             {:board handle
              :command {:type "register_actor" :agentId "Coordinator" :slotId "C"}
              :request-id "seed-audit-board" :turn-id "boot"}))
    handle))

(defn ^:async record-auditor [state request]
  (let [case-id (:case-id request)]
    (swap! (:prompts state) assoc case-id (:prompt request))
    (swap! (:active state) inc)
    (swap! (:peak state) max @(:active state))
    (await (submit! case-id 90 85))
    (swap! (:active state) dec)
    {:ok true :result-markdown "done"}))

(defn ^:async full-pass-auditor [request]
  (let [case-id (:case-id request)]
    (await (submit! case-id 90 85))
    {:ok true}))

(defn ^:async fail-auditor [request]
  (let [case-id (:case-id request)
        user (if (= case-id "CASE-B") 70 90)]
    (await (submit! case-id user 90))
    {:ok true}))

(defn ^:async mutating-auditor [request]
  (let [case-id (:case-id request)]
    (await (submit! case-id 90 85))
    (await (atomic/write-file-atomic!
             (str root "/plans/demo")
             "s1-brainstorm.md"
             "mutated by an auditor"))
    {:ok true}))
`;

describe("CLJS K-path audit scheduling", () => {
	it("starts K=2 auditors concurrently and injects exactly one CASE per prompt", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [active (atom 0)
        peak (atom 0)
        prompts (atom {})
        state {:active active :peak peak :prompts prompts}
        deps (make-deps
               {:subagent (partial record-auditor state)})
        result (await (auditors/start-auditors! deps (take 2 valid-cases) {}))]
    ${JSON_OUT`{:ok (:ok result)
                 :statuses (mapv :status (:results result))
                 :order (mapv :case_id (:submissions result))
                 :peak @peak
                 :prompt-a (get @prompts "CASE-A")
                 :prompt-b (get @prompts "CASE-B")
                 :a-leaks-b (str/includes? (get @prompts "CASE-A") "CASE-B")
                 :b-leaks-a (str/includes? (get @prompts "CASE-B") "CASE-A")
                 :timeouts (:timeouts result)}`}))`);

		expect(out.ok).toBe(true);
		expect(out.statuses).toEqual(["submitted", "submitted"]);
		expect(out.order).toEqual(["CASE-A", "CASE-B"]);
		expect(out.peak).toBe(2);
		expect(out["prompt-a"]).toContain("CASE-A");
		expect(out["prompt-b"]).toContain("CASE-B");
		expect(out["a-leaks-b"]).toBe(false);
		expect(out["b-leaks-a"]).toBe(false);
		expect(out.timeouts).toEqual([]);
	});

	it("composes s5-report.md in dataset order and issues one approval on full PASS", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [requests (atom [])
        deps (make-deps
               {:subagent full-pass-auditor
                :approval-port {:issue (fn [request]
                                         (swap! requests conj request)
                                         {:ok true
                                          :approval {:revision (:revision request)
                                                     :report-sha256 (:report-sha256 request)
                                                     :token "tok"}})}})
        result (await (auditors/run-audit-batch! deps {}))]
    ${JSON_OUT`{:ok (:ok result)
                 :verdict (:verdict result)
                 :case-ids (:case-ids result)
                 :row-order (mapv :case-id (get-in result [:aggregate :rows]))
                 :report-ok (get-in result [:report :ok])
                 :report-path (get-in result [:report :path])
                 :approval (get-in result [:report :approval])
                 :request-count (count @requests)
                 :request-case-count (get-in (first @requests) [:case-count])}`}))`);

		expect(out.ok).toBe(true);
		expect(out.verdict).toBe("PASS");
		expect(out["case-ids"]).toEqual(["CASE-A", "CASE-B", "CASE-C", "CASE-D", "CASE-E"]);
		expect(out["row-order"]).toEqual(["CASE-A", "CASE-B", "CASE-C", "CASE-D", "CASE-E"]);
		expect(out["report-ok"]).toBe(true);
		expect(out["report-path"]).toBe(join(workspace, "plans", "demo", "s5-report.md"));
		expect(out.approval.token).toBe("tok");
		expect(out["request-count"]).toBe(1);
		expect(out["request-case-count"]).toBe(5);

		const markdown = readFileSync(out["report-path"], "utf8");
		const order = ["CASE-A", "CASE-B", "CASE-C", "CASE-D", "CASE-E"].map((id) => markdown.indexOf(id));
		expect(order.every((index) => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(markdown).toContain("| CASE-A | 正常 | 90 | 85 | 85 | 80 | PASS |");
	});

	it("turns failing CASEs into board root tasks and never writes a report", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [handle (await (seed-board))
        deps (make-deps
               {:board handle
                :actor "Coordinator"
                :subagent fail-auditor})
        result (await (auditors/run-audit-batch! deps {}))
        board (await (store/read-board handle))
        repair-task (first (filter (fn [[_ task]] (= "CASE-B" (:ledger-key task)))
                                  (:tasks board)))]
    ${JSON_OUT`{:ok (:ok result)
                 :verdict (:verdict result)
                 :repaired (get-in result [:repair :repaired])
                 :repair-task-ids (get-in result [:repair :task-ids])
                 :repair-count (count (get-in result [:repair :specs]))
                 :task-id (first repair-task)
                 :task-goal (:goal (second repair-task))
                 :task-parent (:parent-id (second repair-task))
                 :task-count (count (:tasks board))
                 :wake-epoch (get-in board [:wake :epoch])
                 :report (get-in result [:report])
                 :case-ids (:case-ids result)}`}))`);

		expect(out.ok).toBe(false);
		expect(out.verdict).toBe("FAIL");
		expect(out.repaired).toBe(true);
		expect(out["repair-task-ids"]).toHaveLength(1);
		expect(out["repair-count"]).toBe(1);
		expect(out["task-id"]).toBeTruthy();
		expect(out["task-goal"]).toContain("CASE-B");
		expect(out["task-parent"]).toBeNull();
		expect(out["task-count"]).toBe(1);
		expect(out["wake-epoch"]).toBeGreaterThan(0);
		expect(out.report).toBeNull();
		expect(existsSync(join(workspace, "plans", "demo", "s5-report.md"))).toBe(false);
	});

	it("rejects duplicate, unknown, out-of-range and missing submissions", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [deps {:root root :slug "demo" :case-ids #{"CASE-A"}}
        first (await (auditors/execute-attach-case-audit!
                       deps {:case_id "CASE-A" :user_score 90 :developer_score 85
                             :report_markdown "report"} nil "call-1"))
        duplicate (await (auditors/execute-attach-case-audit!
                           deps {:case_id "CASE-A" :user_score 90 :developer_score 85
                                 :report_markdown "report"} nil "call-2"))
        unknown (await (auditors/execute-attach-case-audit!
                         deps {:case_id "CASE-Z" :user_score 90 :developer_score 85
                               :report_markdown "report"} nil "call-3"))
        out-of-range (await (auditors/execute-attach-case-audit!
                              deps {:case_id "CASE-A" :user_score 101 :developer_score 85
                                    :report_markdown "report"} nil "call-4"))
        missing (await (auditors/execute-attach-case-audit!
                         deps {:case_id "CASE-A" :user_score 90 :developer_score 85
                               :report_markdown ""} nil "call-5"))]
    ${JSON_OUT`{:first-ok (:ok first)
                 :first-path (:path first)
                 :duplicate-code (:code duplicate)
                 :unknown-code (:code unknown)
                 :range-code (:code out-of-range)
                 :missing-code (:code missing)}`}))`);

		expect(out["first-ok"]).toBe(true);
		expect(out["first-path"]).toBe(join(workspace, ".herd", "missions", "demo", "audit", "CASE-A.submit.edn"));
		expect(out["duplicate-code"]).toBe("AUDIT_DUPLICATE_CASE");
		expect(out["unknown-code"]).toBe("AUDIT_UNKNOWN_CASE");
		expect(out["range-code"]).toBe("AUDIT_INVALID_SCORE");
		expect(out["missing-code"]).toBe("AUDIT_MISSING");
	});

	it("returns AUDIT_TIMEOUT when an auditor exceeds its deadline", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [deps (make-deps
               {:timeout-ms 1
                :set-timeout (fn [f _ms] (js/queueMicrotask f) 1)
                :clear-timeout (fn [_] nil)
                :subagent (fn [_request]
                            (js/Promise. (fn [_resolve _reject] nil)))})
        result (await (auditors/start-auditors! deps [(first valid-cases)] {}))]
    ${JSON_OUT`{:ok (:ok result)
                 :status (get-in result [:results 0 :status])
                 :code (get-in result [:results 0 :error :code])
                 :timeouts (:timeouts result)}`}))`);

		expect(out.ok).toBe(false);
		expect(out.status).toBe("timeout");
		expect(out.code).toBe("AUDIT_TIMEOUT");
		expect(out.timeouts).toEqual(["CASE-A"]);
	});

	it("validates the CASE dataset strictly before starting any auditor", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [duplicate (await (auditors/read-case-dataset
                           root "demo"
                           {:dataset [(first valid-cases) (first valid-cases)]}))
        threshold (await (auditors/read-case-dataset
                           root "demo"
                           {:dataset [(assoc (first valid-cases) :threshold 101)]}))
        missing-path (await (auditors/read-case-dataset
                              root "demo"
                              {:dataset (take 2 valid-cases)}))]
    ${JSON_OUT`{:duplicate-ok (:ok duplicate)
                 :duplicate-codes (mapv :code (:errors duplicate))
                 :threshold-ok (:ok threshold)
                 :threshold-codes (mapv :code (:errors threshold))
                 :missing-path-ok (:ok missing-path)
                 :missing-path-codes (mapv :code (:errors missing-path))}`}))`);

		expect(out["duplicate-ok"]).toBe(false);
		expect(out["duplicate-codes"]).toContain("CASE_DUPLICATE_ID");
		expect(out["threshold-ok"]).toBe(false);
		expect(out["threshold-codes"]).toContain("CASE_THRESHOLD_INVALID");
		expect(out["missing-path-ok"]).toBe(false);
		expect(out["missing-path-codes"]).toContain("CASE_REQUIRED_PATH_MISSING");
	});

	it("refuses a PASS report when the main workspace changed during the audit", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [deps (make-deps
               {:subagent mutating-auditor})
        result (await (auditors/run-audit-batch! deps {}))]
    ${JSON_OUT`{:ok (:ok result)
                 :state (:state result)
                 :code (:code result)
                 :workspace-mutated (get-in result [:aggregate :workspace-mutated])
                 :report (get-in result [:report])}`}))`);

		expect(out.ok).toBe(false);
		expect(out.state).toBe("workspace-mutated");
		expect(out.code).toBe("AUDIT_WORKSPACE_MUTATED");
		expect(out["workspace-mutated"]).toBeNull();
		expect(out.report).toBeNull();
		expect(existsSync(join(workspace, "plans", "demo", "s5-report.md"))).toBe(false);
	});

	it("registers attach_case_audit with the snake_case schema", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [recorded (atom nil)
        pi (js-obj "registerTool" (fn [definition] (reset! recorded definition)))
        result (auditors/register-audit-tools! pi {:root root :slug "demo"
                                                   :case-ids #{"CASE-A"}})]
    ${JSON_OUT`{:registered (:registered result)
                 :name (.-name @recorded)
                 :required (vec (array-seq (.-required (.-parameters @recorded))))
                 :load-mode (.-loadMode @recorded)
                 :has-execute (fn? (.-execute @recorded))}`}))`);

		expect(out.registered).toBe(true);
		expect(out.name).toBe("attach_case_audit");
		expect(out.required).toEqual(["case_id", "user_score", "developer_score", "report_markdown"]);
		expect(out["load-mode"]).toBe("essential");
		expect(out["has-execute"]).toBe(true);
	});

	it("returns the recorded PASS batch without starting auditors again", async () => {
		const out = await scenario(`
(defn ^:async pass-auditor [starts request]
  (swap! starts inc)
  (let [_submitted (await (submit! (:case-id request) 90 85))]
    {:ok true}))

(defn ^:async scenario []
  (let [starts (atom 0)
        deps (make-deps
               {:subagent (partial pass-auditor starts)
                :approval-port {:issue (fn [request]
                                         {:ok true
                                          :approval {:revision (:revision request)
                                                     :report-sha256 (:report-sha256 request)
                                                     :token "tok"}})}})
        first (await (auditors/run-audit-batch! deps {}))
        starts-after-first @starts
        second (await (auditors/run-audit-batch! deps {}))
        persisted (await (auditors/read-batch-state! root "demo"))]
    ${JSON_OUT`{:first-ok (:ok first)
                 :first-verdict (:verdict first)
                 :starts-after-first starts-after-first
                 :second-ok (:ok second)
                 :second-state (:state second)
                 :second-verdict (:verdict second)
                 :reused (:reused second)
                 :same-batch (= (:batch-id first) (:batch-id second))
                 :starts-total @starts
                 :persisted-state (get-in persisted [:record :state])
}`}))`);

		expect(out["first-ok"]).toBe(true);
		expect(out["first-verdict"]).toBe("PASS");
		expect(out["starts-after-first"]).toBe(5);
		expect(out["second-ok"]).toBe(true);
		expect(out["second-state"]).toBe("pass");
		expect(out["second-verdict"]).toBe("PASS");
		expect(out.reused).toBe(true);
		expect(out["same-batch"]).toBe(true);
		expect(out["starts-total"]).toBe(5);
		expect(out["persisted-state"]).toBe("pass");
	});

	it("returns the recorded running batch without launching auditors", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [starts (atom 0)
        _ (await (auditors/write-batch-state!
                   root "demo"
                   {:batch-id "audit-demo-running"
                    :started-at 1000
                    :case-ids ["CASE-A" "CASE-B"]
                    :state :running
                    :verdict nil
                    :history []}))
        deps (make-deps
               {:subagent (fn [_request] (swap! starts inc) {:ok true})})
        result (await (auditors/run-audit-batch! deps {}))]
    ${JSON_OUT`{:ok (:ok result)
                 :state (:state result)
                 :code (:code result)
                 :reused (:reused result)
                 :batch-id (:batch-id result)
                 :starts @starts}`}))`);

		expect(out.ok).toBe(false);
		expect(out.state).toBe("running");
		expect(out.code).toBe("AUDIT_IN_PROGRESS");
		expect(out.reused).toBe(true);
		expect(out["batch-id"]).toBe("audit-demo-running");
		expect(out.starts).toBe(0);
	});

	it("opens a new batch after REPAIR, archives the old state and re-submits", async () => {
		const out = await scenario(`
(defn ^:async repair-auditor [round starts request]
  (swap! starts inc)
  (let [case-id (:case-id request)
        user (if (and (= case-id "CASE-B") (= 1 @round)) 70 90)]
    (await (submit! case-id user 90))
    {:ok true}))

(defn ^:async scenario []
  (let [handle (await (seed-board))
        round (atom 1)
        starts (atom 0)
        uuids (atom 0)
        deps (make-deps
               {:board handle
                :actor "Coordinator"
                :uuid (fn []
                        (swap! uuids inc)
                        (str "0000000" @uuids "-0000-4000-8000-000000000000"))
                :subagent (partial repair-auditor round starts)
                :approval-port {:issue (fn [request]
                                         {:ok true
                                          :approval {:revision (:revision request)
                                                     :report-sha256 (:report-sha256 request)
                                                     :token "tok"}})}})
        first (await (auditors/run-audit-batch! deps {}))
        first-persisted (await (auditors/read-batch-state! root "demo"))
        _ (swap! round inc)
        second (await (auditors/run-audit-batch! deps {}))
        second-persisted (await (auditors/read-batch-state! root "demo"))
        history (get-in second-persisted [:record :history])]
    ${JSON_OUT`{:first-ok (:ok first)
                 :first-verdict (:verdict first)
                 :first-state (get-in first-persisted [:record :state])
                 :first-batch (:batch-id first)
                 :second-ok (:ok second)
                 :second-verdict (:verdict second)
                 :second-state (get-in second-persisted [:record :state])
                 :second-batch (:batch-id second)
                 :different-batch (not= (:batch-id first) (:batch-id second))
                 :history-count (count history)
                 :history-state (get-in history [0 :state])
                 :history-batch (get-in history [0 :batch-id])
                 :starts @starts}`}))`);

		expect(out["first-ok"]).toBe(false);
		expect(out["first-verdict"]).toBe("FAIL");
		expect(out["first-state"]).toBe("repair");
		expect(out["second-ok"]).toBe(true);
		expect(out["second-verdict"]).toBe("PASS");
		expect(out["second-state"]).toBe("pass");
		expect(out["different-batch"]).toBe(true);
		expect(out["history-count"]).toBe(1);
		expect(out["history-state"]).toBe("repair");
		expect(out["history-batch"]).toBe(out["first-batch"]);
		expect(out.starts).toBe(10);
	});

	it("fails closed on corrupt batch state and leaves the file untouched", async () => {
		const target = join(workspace, ".herd", "missions", "demo", "audit", "batch.edn");
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, "{:batch-id 42}");
		const out = await scenario(`
(defn ^:async scenario []
  (let [starts (atom 0)
        deps (make-deps
               {:subagent (fn [_request] (swap! starts inc) {:ok true})})
        result (await (auditors/run-audit-batch! deps {}))]
    ${JSON_OUT`{:ok (:ok result)
                 :state (:state result)
                 :code (:code result)
                 :starts @starts}`}))`);

		expect(out.ok).toBe(false);
		expect(out.state).toBe("corrupt");
		expect(out.code).toBe("AUDIT_BATCH_STATE_CORRUPT");
		expect(out.starts).toBe(0);
		expect(readFileSync(target, "utf8")).toBe("{:batch-id 42}");
	});

	it("records a timed-out CASE as pending without blocking the batch", async () => {
		const out = await scenario(`
(defn ^:async timeout-auditor [request]
  (if (= (:case-id request) "CASE-A")
    (js/Promise. (fn [_resolve _reject] nil))
    (do
      (await (submit! (:case-id request) 90 85))
      {:ok true})))

(defn ^:async scenario []
  (let [deps (make-deps
               {:timeout-ms 1
                :set-timeout (fn [f _ms case-id]
                               (when (= case-id "CASE-A")
                                 (js/queueMicrotask f))
                               1)
                :clear-timeout (fn [_] nil)
                :subagent timeout-auditor})
        result (await (auditors/run-audit-batch! deps {}))
        persisted (await (auditors/read-batch-state! root "demo"))]
    ${JSON_OUT`{:ok (:ok result)
                 :verdict (:verdict result)
                 :timeouts (:timeouts result)
                 :persisted-state (get-in persisted [:record :state])
                 :persisted-verdict (get-in persisted [:record :verdict])
                 :persisted-timeouts (get-in persisted [:record :timeouts])
                 :case-results (get-in persisted [:record :case-results])}`}))`);

		expect(out.ok).toBe(false);
		expect(out.verdict).toBe("INCOMPLETE");
		expect(out.timeouts).toEqual(["CASE-A"]);
		expect(out["persisted-state"]).toBe("pending");
		expect(out["persisted-verdict"]).toBe("INCOMPLETE");
		expect(out["persisted-timeouts"]).toEqual(["CASE-A"]);
		const timeoutRow = out["case-results"].find((row) => row["case-id"] === "CASE-A");
		expect(timeoutRow.status).toBe("timeout");
	});

	it("maps auditor refusal and thrown errors to AUDIT_ABORTED", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [declining (make-deps
                    {:subagent (fn [_request] {:ok false :error "declined"})})
        throwing (make-deps
                   {:subagent (fn [_request] (throw (js/Error. "boom")))})
        declined (await (auditors/start-auditors! declining [(first valid-cases)] {}))
        thrown (await (auditors/start-auditors! throwing [(first valid-cases)] {}))]
    ${JSON_OUT`{:declined-status (get-in declined [:results 0 :status])
                 :declined-code (get-in declined [:results 0 :error :code])
                 :thrown-status (get-in thrown [:results 0 :status])
                 :thrown-code (get-in thrown [:results 0 :error :code])}`}))`);

		expect(out["declined-status"]).toBe("aborted");
		expect(out["declined-code"]).toBe("AUDIT_ABORTED");
		expect(out["thrown-status"]).toBe("aborted");
		expect(out["thrown-code"]).toBe("AUDIT_ABORTED");
	});

	it("treats same-size, same-mtime files as unchanged per the A02-15 fast judgement", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [stamp {:mtime-ms 111 :size 10}
        before {:ok true
                :files [{:path "plans/demo/s1-brainstorm.md"
                         :sha256 "aaa" :stamp stamp :missing false}]}
        after {:ok true
               :files [{:path "plans/demo/s1-brainstorm.md"
                        :sha256 "bbb" :stamp stamp :missing false}]}
        resized {:ok true
                 :files [{:path "plans/demo/s1-brainstorm.md"
                          :sha256 "bbb" :stamp (assoc stamp :size 11) :missing false}]}]
    ${JSON_OUT`{:same-stamp (auditors/snapshot-equal? before after)
                 :resized (auditors/snapshot-equal? before resized)}`}))`);

		expect(out["same-stamp"]).toBe(true);
		expect(out.resized).toBe(false);
	});

	it("installs the audit batch port without registering a tool", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [installed (auditors/install! {:root root :slug "demo" :dataset valid-cases})
        definition ((:submitToolDefinition installed))]
    ${JSON_OUT`{:run-batch-fn (fn? (:runBatch installed))
                 :tool-fn (fn? (:submitToolDefinition installed))
                 :tool-name (:name definition)
                 :registered (contains? definition :registered)}`}))`);

		expect(out["run-batch-fn"]).toBe(true);
		expect(out["tool-fn"]).toBe(true);
		expect(out["tool-name"]).toBe("attach_case_audit");
		expect(out.registered).toBe(false);
	});
	it("keeps at most five archived batches in history", async () => {
		const out = await scenario(`
(defn ^:async scenario []
  (let [old-history (mapv (fn [index]
                            {:batch-id (str "old-" index)
                             :started-at index
                             :case-ids ["CASE-A"]
                             :state :repair
                             :verdict :FAIL})
                          (range 5))
        _ (await (auditors/write-batch-state!
                   root "demo"
                   {:batch-id "audit-demo-old"
                    :started-at 1
                    :case-ids ["CASE-A"]
                    :state :repair
                    :verdict :FAIL
                    :history old-history}))
        deps (make-deps {:subagent (fn [_request] {:ok true})})
        result (await (auditors/run-audit-batch! deps {}))
        persisted (await (auditors/read-batch-state! root "demo"))
        history (get-in persisted [:record :history])]
    ${JSON_OUT`{:state (:state result)
                 :history-count (count history)
                 :first-batch (get-in history [0 :batch-id])
                 :last-batch (get-in history [4 :batch-id])}`}))`);

		expect(out.state).toBe("incomplete");
		expect(out["history-count"]).toBe(5);
		expect(out["first-batch"]).toBe("old-1");
		expect(out["last-batch"]).toBe("audit-demo-old");
	});
});
