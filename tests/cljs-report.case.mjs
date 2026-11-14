import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";

import { ensureModules } from "./helpers/nbb-boot.mjs";

beforeAll(async () => {
	await ensureModules([
		"util/atomic_write",
		"stages/paths",
		"stages/parsers",
		"stages/scores",
		"stages/report",
		"stages/audit",
	]);
});

let root;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cljs-report-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const submission = `[{:case_id "CASE-A" :user_score 90 :developer_score 85
                    :report_markdown "在真实界面观察到的结果。"}]`;

function aggregateExpr({ threshold = 80, submissions = submission } = {}) {
	return `(scores/aggregate
	  {:case-specs [{:case_id "CASE-A" :path "docs/a.md" :threshold ${threshold}
	                 :steps ["step"] :expected "expected" :rubric "rubric"}]
	   :submissions ${submissions}
	   :contract {:mission-id "M1" :revision 0}
	   :snapshot-before {:files [{:path "docs/a.md" :sha256 "abc" :stamp {}}] :digest "d"}
	   :snapshot-after {:files [{:path "docs/a.md" :sha256 "abc" :stamp {}}] :digest "d"}
	   :audit {:environment "tmux"}})`;
}

async function run(scenario, options = {}) {
	const body = scenario.replaceAll("__ROOT__", JSON.stringify(root)).replaceAll("__AGG__", aggregateExpr(options));
	const text = await nbb.loadString(`
(require '[herd.stages.scores :as scores])
(defn ^:async scenario [] ${body})
(scenario)`);
	return JSON.parse(text);
}

const normalized = (value) => String(value ?? "").replace(/^:/, "");

describe("CLJS s5 report", () => {
	it("writes the PASS report and requests one approval", async () => {
		const outcome = await run(`
		  (let [requests (atom [])
		        port {:issue (fn [request]
		                       (swap! requests conj request)
		                       {:ok true
		                        :approval {:revision (:revision request)
		                                   :report-sha256 (:report-sha256 request)
		                                   :token "test-token"}})}
		        result __AGG__
		        written (await (herd.stages.report/write-report! __ROOT__ "demo" result {:approval-port port}))]
		    (js/JSON.stringify
		      (clj->js {:outcome (dissoc written :markdown)
		                :requests @requests
		                :verdict (:verdict result)})))`);

		expect(outcome.verdict).toBe("PASS");
		expect(outcome.outcome.ok).toBe(true);
		expect(outcome.outcome.completed).toBe(false);
		expect(outcome.outcome.path).toBe(join(root, "plans", "demo", "s5-report.md"));
		const markdown = readFileSync(outcome.outcome.path, "utf8");
		expect(markdown).toContain("| CASE-A | docs/a.md | 90 | 85 | 85 | 80 | PASS |");
		expect(outcome.outcome.sha256).toBe(createHash("sha256").update(markdown, "utf8").digest("hex"));
		expect(outcome.requests).toHaveLength(1);
		expect(outcome.requests[0]["mission-id"]).toBe("M1");
		expect(outcome.requests[0].revision).toBe(0);
		expect(outcome.requests[0].verdict).toBe("PASS");
		expect(outcome.requests[0]["case-count"]).toBe(1);
		expect(outcome.requests[0]["report-sha256"]).toBe(outcome.outcome.sha256);
		expect(outcome.requests[0].recheck).toBeNull();
		expect(outcome.outcome.approval.token).toBe("test-token");
	});

	it("returns APPROVAL_REQUIRED when no approval port is injected", async () => {
		const outcome = await run(`
		  (let [result __AGG__
		        written (await (herd.stages.report/write-report! __ROOT__ "demo" result {}))]
		    (js/JSON.stringify (clj->js (dissoc written :markdown))))`);

		expect(outcome.ok).toBe(false);
		expect(normalized(outcome.code)).toBe("APPROVAL_REQUIRED");
		expect(existsSync(join(root, "plans", "demo", "s5-report.md"))).toBe(true);
	});

	it("blocks approval when the recheck throws", async () => {
		const outcome = await run(`
		  (let [requests (atom [])
		        port {:issue (fn [request]
		                       (swap! requests conj request)
		                       {:ok true
		                        :approval {:revision 0 :report-sha256 "x" :token "t"}})}
		        result __AGG__
		        written (await (herd.stages.report/write-report! __ROOT__ "demo" result
		                         {:approval-port port
		                          :recheck-port (fn [_] (throw (ex-info "workspace changed" {})))}))]
		    (js/JSON.stringify
		      (clj->js {:outcome (dissoc written :markdown)
		                :requests @requests})))`);

		expect(outcome.outcome.ok).toBe(false);
		expect(normalized(outcome.outcome.code)).toBe("APPROVAL_REQUIRED");
		expect(outcome.outcome.recheck.ok).toBe(false);
		expect(outcome.requests).toHaveLength(0);
	});

	it("passes a successful recheck through to approval", async () => {
		const outcome = await run(`
		  (let [seen (atom nil)
		        port {:issue (fn [request] {:ok true
		                                    :approval {:revision 0 :report-sha256 "x" :token "t"}})}
		        result __AGG__
		        written (await (herd.stages.report/write-report! __ROOT__ "demo" result
		                         {:approval-port port
		                          :recheck-port (fn [check] (reset! seen (:report-sha256 check))
		                                          {:ok true})}))]
		    (js/JSON.stringify
		      (clj->js {:ok (:ok written)
		                :recheck (:recheck written)
		                :seen @seen})))`);

		expect(outcome.ok).toBe(true);
		expect(outcome.recheck.ok).toBe(true);
		expect(outcome.recheck["mission-id"]).toBe("M1");
		expect(outcome.seen).toBe(outcome.recheck["report-sha256"]);
	});

	it("refuses to write a report for a non-PASS aggregate", async () => {
		const outcome = await run(
			`(let [port {:issue (fn [_] {:ok true :approval {:token "t" :revision 0 :report-sha256 "x"}})}
			      result __AGG__
			      written (await (herd.stages.report/write-report! __ROOT__ "demo" result {:approval-port port}))]
			  (js/JSON.stringify (clj->js (dissoc written :markdown))))`,
			{ threshold: 95 },
		);

		expect(outcome.ok).toBe(false);
		expect(normalized(outcome.code)).toBe("APPROVAL_REQUIRED");
		expect(existsSync(join(root, "plans", "demo", "s5-report.md"))).toBe(false);
	});

	it("rejects an invalid slug before writing", async () => {
		const outcome = await run(`
		  (let [result __AGG__
		        port {:issue (fn [_] {:ok true :approval {:token "t" :revision 0 :report-sha256 "x"}})}
		        written (await (herd.stages.report/write-report! __ROOT__ "../escape" result {:approval-port port}))]
		    (js/JSON.stringify (clj->js (dissoc written :markdown))))`);

		expect(outcome.ok).toBe(false);
		expect(normalized(outcome.errors[0].code)).toBe("INVALID_ARGUMENT");
	});
});

const cljsSubmission = `{:case_id "CASE-A" :user_score 80 :developer_score 90
                        :report_markdown "在真实界面观察到的结果。"}`;

describe("CLJS attach_case_audit persistence", () => {
	it("writes and reads back a durable EDN submission", async () => {
		const outcome = await run(`
		  (let [written (await (herd.stages.audit/write-submission-once!
		                         __ROOT__ "demo" "CASE-A" ${cljsSubmission} nil))
		        read-back (await (herd.stages.audit/read-submission
		                           __ROOT__ "demo" "CASE-A" nil))]
		    (js/JSON.stringify (clj->js {:written written :read read-back})))`);

		expect(outcome.written.ok).toBe(true);
		expect(outcome.written.path).toBe(join(root, ".herd", "missions", "demo", "audit", "CASE-A.submit.edn"));
		expect(outcome.read.ok).toBe(true);
		expect(outcome.read.submission).toEqual({
			case_id: "CASE-A",
			user_score: 80,
			developer_score: 90,
			report_markdown: "在真实界面观察到的结果。",
		});
	});

	it("keeps the first submission byte-for-byte on a duplicate", async () => {
		const first = await run(`
		  (js/JSON.stringify
		    (clj->js (await (herd.stages.audit/write-submission-once!
		                      __ROOT__ "demo" "CASE-A" ${cljsSubmission} nil))))`);
		expect(first.ok).toBe(true);
		const before = readFileSync(first.path, "utf8");

		const second = await run(`
		  (js/JSON.stringify
		    (clj->js (await (herd.stages.audit/write-submission-once!
		                      __ROOT__ "demo" "CASE-A" ${cljsSubmission} nil))))`);

		expect(second.ok).toBe(false);
		expect(normalized(second.code)).toBe("AUDIT_DUPLICATE_CASE");
		expect(readFileSync(first.path, "utf8")).toBe(before);
	});

	it("rejects a submission that names another CASE", async () => {
		const outcome = await run(`
		  (js/JSON.stringify
		    (clj->js (await (herd.stages.audit/write-submission-once!
		                      __ROOT__ "demo" "CASE-A" {:case_id "CASE-B" :user_score 80
		                                                :developer_score 90 :report_markdown "x"} nil))))`);

		expect(outcome.ok).toBe(false);
		expect(normalized(outcome.code)).toBe("AUDIT_UNKNOWN_CASE");
	});

	it("rejects incomplete scores and reports a missing submission", async () => {
		const invalid = await run(`
		  (js/JSON.stringify
		    (clj->js (await (herd.stages.audit/write-submission-once!
		                      __ROOT__ "demo" "CASE-A" {:case_id "CASE-A" :user_score 101
		                                                :developer_score 90 :report_markdown "x"} nil))))`);
		expect(invalid.ok).toBe(false);
		expect(normalized(invalid.code)).toBe("INVALID_ARGUMENT");

		const missing = await run(`
		  (js/JSON.stringify
		    (clj->js (await (herd.stages.audit/read-submission __ROOT__ "demo" "CASE-Z" nil))))`);
		expect(missing.ok).toBe(false);
		expect(normalized(missing.error.code)).toBe("AUDIT_MISSING");
	});
});
