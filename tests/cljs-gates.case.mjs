import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nbb from "nbb";
import { ensureModules } from "./helpers/nbb-boot.mjs";

const MODULES = [
	"util/atomic_write",
	"stages/parsers",
	"stages/tenure",
	"stages/disclosures",
	"stages/paths",
	"stages/mission",
	"stages/store",
	"stages/attach",
	"stages/review",
	"stages/gates",
];
const NOW = "2026-11-14T00:00:00.000Z";
let _moduleRoot;

beforeAll(async () => {
	await ensureModules(MODULES);
});

const S1_MARKDOWN = [
	"# 一句话目标与用户可见结果",
	"让 dogfood 使命跑到 S2。",
	"# 决策框架",
	"先验证最小闭环。",
	"# 现状事实与根因",
	"默认面只暴露 clj_devops。",
	"# 单向门/双向门",
	"attach 是单向门。",
	"# 事前验尸",
	"失败原因会是未验证磁盘文档。",
	"# Non-Goals",
	"不做多 worktree。",
	"# 成功标准",
	"stage 变为 s2。",
	"# 未决问题",
	"无。",
].join("\n");

const S2_CASES = `[{:case_id "CASE-1" :path "正常" :threshold 80 :steps ["step"] :expected "expected" :rubric "rubric"}
 {:case_id "CASE-2" :path "错误" :threshold 80 :steps ["step"] :expected "expected" :rubric "rubric"}
 {:case_id "CASE-3" :path "边界" :threshold 80 :steps ["step"] :expected "expected" :rubric "rubric"}
 {:case_id "CASE-4" :path "并发" :threshold 80 :steps ["step"] :expected "expected" :rubric "rubric"}
 {:case_id "CASE-5" :path "恢复" :threshold 80 :steps ["step"] :expected "expected" :rubric "rubric"}]`;

let missionCounter = 0;
function freshRoot() {
	missionCounter += 1;
	return mkdtempSync(join(tmpdir(), `cljs-gates-m-${missionCounter}-`));
}

async function scenario(body) {
	const text = await nbb.loadString(`
(require '[clojure.string :as str]
         '[herd.stages.gates :as gates]
         '[herd.stages.store :as store])
${body}
(scenario)`);
	return JSON.parse(text);
}

const literal = (value) => JSON.stringify(value);
const normalized = (value) => String(value ?? "").replace(/^:/, "");

const createMission = (root) =>
	`(await (store/create-mission! ${literal(root)} {:slug "demo" :mission-id "M1" :now ${literal(NOW)}}))`;

describe("CLJS gate service", () => {
	it("opens the review on findings and quiesces it on deletion", async () => {
		const root = freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [created ${createMission(root)}
        svc (gates/create-service {:root ${literal(root)} :slug "demo" :now (fn [] ${literal(NOW)})})
        open (await ((:review! svc) {:findings [{:key "K1" :value "V1"}]} {}))
        closed (await ((:review! svc) {:findings [{:key "K1" :value nil}]} {}))]
    (js/JSON.stringify
      (clj->js {:open-status (:status open)
                :open-tasks (:open-tasks open)
                :open-ready (:attach-ready open)
                :closed-status (:status closed)
                :closed-tasks (:open-tasks closed)
                :closed-ready (:attach-ready closed)}))))`);

		expect(out["open-status"]).toBe("review-open");
		expect(out["open-tasks"]).toBe(1);
		expect(out["open-ready"]).toBe(false);
		expect(out["closed-status"]).toBe("review-quiescent");
		expect(out["closed-tasks"]).toBe(0);
		expect(out["closed-ready"]).toBe(true);
	});

	it("refuses attach before an empty review quiesces the board", async () => {
		const root = freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [created ${createMission(root)}
        svc (gates/create-service
              {:root ${literal(root)} :slug "demo" :now (fn [] ${literal(NOW)})
               :confirm (fn [_] {:decision "approve"})})
        _ (await ((:review! svc) {} {}))
        _ (await ((:attach! svc) :attach_brainstorm {:markdown ${literal(S1_MARKDOWN)}} {}))
        attached (await ((:attach! svc) :attach_manual_tests
                          {:markdown "S2 方法论。" :cases ${S2_CASES}} {}))]
    (js/JSON.stringify (clj->js {:ok (:ok attached)
                                 :code (get-in attached [:error :code])}))))`);

		expect(out.ok).toBe(false);
		expect(normalized(out.code)).toBe("ATTACH_NOT_READY");
	});
	it("approves S1 with the on-disk document and opens S2", async () => {
		const root = freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [created ${createMission(root)}
        svc (gates/create-service
              {:root ${literal(root)} :slug "demo" :now (fn [] ${literal(NOW)})
               :confirm (fn [args]
                          (let [fs (js/require "node:fs")
                                target (:path (:pending args))]
                            (.writeFileSync fs target (str ${literal(S1_MARKDOWN)} "\n操作员批准前编辑。\n"))
                            {:decision "approve"}))})
        reviewed (await ((:review! svc) {} {}))
        attached (await ((:attach! svc) :attach_brainstorm {:markdown ${literal(S1_MARKDOWN)}} {}))
        mission (await (store/read-mission ${literal(root)} "demo"))
        fs (js/require "node:fs")]
    (js/JSON.stringify
      (clj->js {:reviewed (:status reviewed)
                :attached (:status attached)
                :next-stage (:next-stage attached)
                :briefing-ok (boolean (and (:briefing attached)
                                           (str/includes? (:briefing attached) "STAGE S1 ATTACHED")))
                :stage (:stage (:mission mission))
                :tenure (get-in mission [:mission :tenure :tenure-id])
                :pending (get-in mission [:mission :attach :pending])
                :archive-exists (.existsSync fs (str ${literal(root)} "/.herd/missions/demo/boards/T-1.edn"))
                :disk-approved (str/includes?
                                 (.readFileSync fs (str ${literal(root)} "/plans/demo/s1-brainstorm.md") "utf8")
                                 "操作员批准前编辑。")}))))`);

		expect(out.reviewed).toBe("review-quiescent");
		expect(out.attached).toBe("attached");
		expect(out["next-stage"]).toBe("s2");
		expect(out["briefing-ok"]).toBe(true);
		expect(out.stage).toBe("s2");
		expect(out.tenure).toBe("T-2");
		expect(out.pending).toBeNull();
		expect(out["archive-exists"]).toBe(true);
		expect(out["disk-approved"]).toBe(true);
	});

	it("keeps S1 open on revise and re-arms on a new empty review", async () => {
		const root = freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [created ${createMission(root)}
        svc (gates/create-service
              {:root ${literal(root)} :slug "demo" :now (fn [] ${literal(NOW)})
               :confirm (fn [_] {:decision "revise" :feedback "补充用户证据"})})
        _ (await ((:review! svc) {} {}))
        revised (await ((:attach! svc) :attach_brainstorm {:markdown ${literal(S1_MARKDOWN)}} {}))
        after (await (store/read-mission ${literal(root)} "demo"))
        rearmed (await ((:review! svc) {} {}))]
    (js/JSON.stringify
      (clj->js {:status (:status revised)
                :feedback (:feedback revised)
                :stage (:stage (:mission after))
                :ready (get-in after [:mission :attach :ready])
                :rearmed (:attach-ready rearmed)}))))`);

		expect(out.status).toBe("revision-requested");
		expect(out.feedback).toBe("补充用户证据");
		expect(out.stage).toBe("s1");
		expect(out.ready).toBe(false);
		expect(out.rearmed).toBe(true);
	});

	it("records an S1 pending approval and refuses a second attach", async () => {
		const root = freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [created ${createMission(root)}
        svc (gates/create-service {:root ${literal(root)} :slug "demo" :now (fn [] ${literal(NOW)})})
        _ (await ((:review! svc) {} {}))
        first (await ((:attach! svc) :attach_brainstorm {:markdown ${literal(S1_MARKDOWN)}} {}))
        mission (await (store/read-mission ${literal(root)} "demo"))
        again (await ((:attach! svc) :attach_brainstorm {:markdown ${literal(S1_MARKDOWN)}} {}))]
    (js/JSON.stringify
      (clj->js {:status (:status first)
                :reason (:reason first)
                :pending (boolean (get-in mission [:mission :attach :pending]))
                :again-ok (:ok again)
                :again-code (get-in again [:error :code])}))))`);

		expect(out.status).toBe("awaiting-user");
		expect(out.reason).toBe("host-confirm-unavailable");
		expect(out.pending).toBe(true);
		expect(out["again-ok"]).toBe(false);
		expect(normalized(out["again-code"])).toBe("ATTACH_ALREADY_PENDING");
	});

	it("returns denied feedback and clears the pending attach", async () => {
		const root = freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [created ${createMission(root)}
        svc (gates/create-service
              {:root ${literal(root)} :slug "demo" :now (fn [] ${literal(NOW)})
               :confirm (fn [_] {:decision "deny" :feedback "目标不清楚"})})
        _ (await ((:review! svc) {} {}))
        denied (await ((:attach! svc) :attach_brainstorm {:markdown ${literal(S1_MARKDOWN)}} {}))
        mission (await (store/read-mission ${literal(root)} "demo"))]
    (js/JSON.stringify
      (clj->js {:status (:status denied)
                :feedback (:feedback denied)
                :stage (:stage (:mission mission))
                :pending (get-in mission [:mission :attach :pending])}))))`);

		expect(out.status).toBe("denied");
		expect(out.feedback).toBe("目标不清楚");
		expect(out.stage).toBe("s1");
		expect(out.pending).toBeNull();
	});

	it("writes S2 deliverables and advances to S3", async () => {
		const root = freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [created ${createMission(root)}
        svc (gates/create-service
              {:root ${literal(root)} :slug "demo" :now (fn [] ${literal(NOW)})
               :confirm (fn [_] {:decision "approve"})})
        _ (await ((:review! svc) {} {}))
        _ (await ((:attach! svc) :attach_brainstorm {:markdown ${literal(S1_MARKDOWN)}} {}))
        _ (await ((:review! svc) {} {}))
        attached (await ((:attach! svc) :attach_manual_tests
                          {:markdown "S2 方法论。" :cases ${S2_CASES}} {}))
        mission (await (store/read-mission ${literal(root)} "demo"))]
    (js/JSON.stringify
      (clj->js {:status (:status attached)
                :next-stage (:next-stage attached)
                :briefing-ok (boolean (and (:briefing attached)
                                           (str/includes? (:briefing attached) "STAGE S2 ATTACHED")))
                :stage (:stage (:mission mission))
                :tenure (get-in mission [:mission :tenure :tenure-id])}))))`);

		expect(out.status).toBe("attached");
		expect(out["next-stage"]).toBe("s3");
		expect(out["briefing-ok"]).toBe(true);
		expect(out.stage).toBe("s3");
		expect(out.tenure).toBe("T-3");
		expect(readFileSync(join(root, "plans", "demo", "s2-manual-tests.md"), "utf8")).toContain("S2 方法论");
		expect(readFileSync(join(root, ".herd", "missions", "demo", "s2-cases.edn"), "utf8")).toContain("CASE-5");
	});

	it("replays one call id and rejects a changed payload", async () => {
		const root = freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [created ${createMission(root)}
        svc (gates/create-service
              {:root ${literal(root)} :slug "demo" :now (fn [] ${literal(NOW)})
               :confirm (fn [_] {:decision "approve"})})
        _ (await ((:review! svc) {} {}))
        first (await ((:attach! svc) :attach_brainstorm {:markdown ${literal(S1_MARKDOWN)}} {:call-id "c1"}))
        second (await ((:attach! svc) :attach_brainstorm {:markdown ${literal(S1_MARKDOWN)}} {:call-id "c1"}))
        mission (await (store/read-mission ${literal(root)} "demo"))
        mismatch (await ((:attach! svc) :attach_brainstorm {:markdown "另一份完全不同的文档"} {:call-id "c1"}))]
    (js/JSON.stringify
      (clj->js {:first (:status first)
                :second (:status second)
                :tenure (get-in mission [:mission :tenure :tenure-id])
                :mismatch-ok (:ok mismatch)
                :mismatch-code (get-in mismatch [:error :code])}))))`);

		expect(out.first).toBe("attached");
		expect(out.second).toBe("attached");
		expect(out.tenure).toBe("T-2");
		expect(out["mismatch-ok"]).toBe(false);
		expect(normalized(out["mismatch-code"])).toBe("CALL_REPLAY_MISMATCH");
	});

	it("denies a role outside the gate surface", async () => {
		const root = freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [created ${createMission(root)}
        svc (gates/create-service {:root ${literal(root)} :slug "demo" :role "Manual Auditor"
                                   :now (fn [] ${literal(NOW)})})
        reviewed (await ((:review! svc) {} {}))]
    (js/JSON.stringify (clj->js {:ok (:ok reviewed) :code (get-in reviewed [:error :code])}))))`);

		expect(out.ok).toBe(false);
		expect(normalized(out.code)).toBe("CAPABILITY_DENIED");
	});

	it("asks one S1 question through the injected host", async () => {
		const root = freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [created ${createMission(root)}
        svc (gates/create-service
              {:root ${literal(root)} :slug "demo" :now (fn [] ${literal(NOW)})
               :ask-user (fn [args] {:ok true :answer (str "回答：" (:question args))})})
        asked (await ((:ask-user! svc) {:question "哪个用户价值最高？" :context "需要排序" :recommended_default "先做 A"} {}))]
    (js/JSON.stringify (clj->js {:status (:status asked) :answer (:answer asked)}))))`);

		expect(out.status).toBe("answered");
		expect(out.answer).toContain("哪个用户价值最高？");
	});

	it("forbids ask_user outside S1 and the S5 exception", async () => {
		const root = freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [created ${createMission(root)}
        _ (await (store/update-mission! ${literal(root)} "demo" {:stage :s3}))
        svc (gates/create-service {:root ${literal(root)} :slug "demo" :now (fn [] ${literal(NOW)})})
        asked (await ((:ask-user! svc) {:question "问题？" :context "上下文" :recommended_default "默认"} {}))]
    (js/JSON.stringify (clj->js {:ok (:ok asked) :code (get-in asked [:error :code])}))))`);

		expect(out.ok).toBe(false);
		expect(normalized(out.code)).toBe("ASK_FORBIDDEN_OUTSIDE_S1");
	});

	it("runs devops through its port and accepts the report", async () => {
		const root = freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [created ${createMission(root)}
        svc (gates/create-service
              {:root ${literal(root)} :slug "demo" :now (fn [] ${literal(NOW)})
               :run-devops (fn [_] {:ok true :status "devops-report" :agent-id "A1" :report {:summary "ok"}})
               :accept-devops-report (fn [_] {:ok true})})
        devops (await ((:devops! svc) {:verbose_intent "查清调用链"} {}))
        report (await ((:submit-devops-report! svc)
                        {:status "ok" :report_markdown "报告正文" :inspected_paths ["src/herd/main.cljs"]} {}))]
    (js/JSON.stringify
      (clj->js {:devops-ok (:ok devops)
                :devops-status (:status devops)
                :agent-id (:agent-id devops)
                :report-ok (:ok report)
                :report-status (:status report)}))))`);

		expect(out["devops-ok"]).toBe(true);
		expect(out["devops-status"]).toBe("devops-report");
		expect(out["agent-id"]).toBe("A1");
		expect(out["report-ok"]).toBe(true);
		expect(out["report-status"]).toBe("devops-report-submitted");
	});
	it("executes a registered tool through the host bridge", async () => {
		const root = freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [created ${createMission(root)}
        defs (atom [])
        _ (gates/register-all! (fn [definition] (swap! defs conj definition))
                               {:root ${literal(root)} :slug "demo"})
        review (some (fn [definition] (when (= "review" (:name definition)) definition)) @defs)
        result (await ((:execute review) "call-1" #js {} nil nil #js {:cwd ${literal(root)}}))]
    (js/JSON.stringify
      (clj->js {:is-error (:isError result)
                :text (get-in result [:content 0 :text])}))))`);

		expect(out["is-error"]).toBeNull();
		expect(out.text).toContain(":status :review-quiescent");
	});
	it("exports the eight gate tool definitions", async () => {
		const root = freshRoot();
		const out = await scenario(`
(defn ^:async scenario []
  (let [defs (atom [])
        service (gates/register-all! (fn [definition] (swap! defs conj definition))
                                     {:root ${literal(root)} :slug "demo"})]
    (js/JSON.stringify
      (clj->js {:names (mapv :name @defs)
                :required (mapv (fn [definition] (vec (:required (:parameters definition)))) @defs)
                :all-execute (every? (fn [definition] (fn? (:execute definition))) @defs)
                :has-service (some? service)}))))`);

		expect(out.names).toEqual([
			"review",
			"attach_brainstorm",
			"attach_manual_tests",
			"attach_dev_guide",
			"attach_coordination",
			"ask_user",
			"devops",
			"submit_devops_report",
		]);
		expect(out.required).toEqual([
			[],
			["markdown"],
			["markdown", "cases"],
			["markdown"],
			["markdown", "promela"],
			["slug", "question"],
			["slug", "verbose_intent"],
			["status", "report_markdown", "inspected_paths"],
		]);
		expect(out["all-execute"]).toBe(true);
		expect(out["has-service"]).toBe(true);
	});
});
