import { beforeAll, describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";
import { loadLanguageDetector } from "../src/host/language-detect.mjs";

const ALL_TOOLS = [
	"clj_devops",
	"clj_plan",
	"clj_review",
	"clj_worker",
	"clj_auditor",
	"wait",
	"handoff",
	"review",
	"attach_brainstorm",
	"attach_manual_tests",
	"attach_dev_guide",
	"attach_coordination",
	"ask_user",
	"devops",
	"submit_devops_report",
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
	"attach_case_audit",
];

class FakeText {
	constructor(text, x, y) {
		this.text = text;
		this.x = x;
		this.y = y;
	}
	render() {
		return this.text.split("\n");
	}
}

class FakeContainer {
	constructor() {
		this.children = [];
	}
	addChild(child) {
		this.children.push(child);
	}
	render(width) {
		const out = [];
		for (const child of this.children) {
			if (typeof child.render === "function") out.push(...child.render(width));
		}
		return out;
	}
}

const theme = {
	fg: (role, text) => `${role}:${text}`,
};

beforeAll(async () => {
	globalThis.__pi = {
		tools: new Map(),
		commands: new Map(),
		hooks: new Map(),
		active: ["read", "clj_devops", "wait"],
		pi: { Text: FakeText, Container: FakeContainer },
		registerTool(definition) {
			this.tools.set(definition.name, definition);
		},
		registerCommand(name, spec) {
			this.commands.set(name, spec);
		},
		on(name, handler) {
			if (!this.hooks.has(name)) this.hooks.set(name, handler);
		},
		getActiveTools() {
			return [...this.active];
		},
		setActiveTools(next) {
			this.active = [...next];
		},
	};
	globalThis.__herdTui = { highlightCode: (code) => code.split("\n") };
	globalThis.__herdDetectLanguage = loadLanguageDetector(createRequire(import.meta.url));
	nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
	await nbb.loadFile(fileURLToPath(new URL("../src/herd/bootstrap.cljs", import.meta.url)));
});

describe("CLJS tool UI renderers", () => {
	it("registers renderCall and renderResult on every Herdchestra tool", () => {
		for (const name of ALL_TOOLS) {
			const def = globalThis.__pi.tools.get(name);
			expect(def, name).toBeDefined();
			expect(typeof def.renderCall, `${name}.renderCall`).toBe("function");
			expect(typeof def.renderResult, `${name}.renderResult`).toBe("function");
		}
	});

	it("renders wait and handoff with clj_devops visual language", () => {
		const waitDef = globalThis.__pi.tools.get("wait");
		const waitCall = waitDef.renderCall({ otherwise_independent_work: "a".repeat(60) }, { expanded: false }, theme);
		expect(waitCall.children[0].text).toContain("accent:Wait");
		expect(waitCall.children[0].text).toContain("dim:--- [等待沙箱");
		expect(waitCall.children[1].render(12)).toEqual([`dim:${"─".repeat(12)}`]);
		expect(waitCall.children[2].text).toContain("dim:$$$");

		const waitRes = waitDef.renderResult(
			{ content: [{ type: "text", text: '{:state :completed, :name "job-1", :value 1}' }] },
			{ expanded: false },
			theme,
		);
		expect(waitRes.children[0].render(8)).toEqual([`dim:${"─".repeat(8)}`]);
		expect(waitRes.children[1].text).toContain("success:✓");
		expect(waitRes.children[1].text).toContain("dim:--- [job-1]");

		const handoffDef = globalThis.__pi.tools.get("handoff");
		const handoffCall = handoffDef.renderCall(
			{ markdown: `# Title\n${"line\n".repeat(10)}` },
			{ expanded: false },
			theme,
		);
		expect(handoffCall.children[0].text).toContain("accent:Handoff");
		expect(handoffCall.children[0].text).toContain("chars]");
		expect(handoffCall.children[2].text).toContain("dim:$$$");

		const handoffExpanded = handoffDef.renderCall({ markdown: "hello handoff" }, { expanded: true }, theme);
		expect(handoffExpanded.children[2].text).toContain("hello handoff");
	});

	it("renders stage gate and devops tools cleanly across collapsed, expanded, and error states", () => {
		const reviewDef = globalThis.__pi.tools.get("review");
		const emptyReview = reviewDef.renderCall({ findings: [] }, { expanded: false }, theme);
		expect(emptyReview.children[0].text).toContain("accent:Submit Review");
		expect(emptyReview.children[0].text).toContain("空账确认");

		const openReview = reviewDef.renderCall(
			{
				summary_markdown: "needs work",
				findings: [{ key: "gap-1", value: "missing edge cases in parser" }],
			},
			{ expanded: false },
			theme,
		);
		expect(openReview.children[0].text).toContain("1 条台账 · 含总结");
		expect(openReview.children[2].text).toContain("gap-1");

		const reviewQuiescent = reviewDef.renderResult(
			{
				content: [
					{
						type: "text",
						text: "{:ok true :status :review-quiescent :expected-attach :attach_brainstorm :open-tasks 0}",
					},
				],
			},
			{ expanded: false },
			theme,
		);
		expect(reviewQuiescent.children[1].text).toContain("success:✓");
		expect(reviewQuiescent.children[1].text).toContain("待调用 attach_brainstorm");

		const manualTestsDef = globalThis.__pi.tools.get("attach_manual_tests");
		const mtCall = manualTestsDef.renderCall(
			{
				markdown: `# Methodology\n${"detail\n".repeat(10)}`,
				cases: [
					{
						case_id: "CASE-01",
						path: "normal/flow",
						threshold: 80,
						steps: ["step 1", "step 2"],
						expected: "long expected output ".repeat(5),
						rubric: "detailed rubric ".repeat(5),
					},
				],
			},
			{ expanded: false },
			theme,
		);
		expect(mtCall.children[0].text).toContain("accent:Attach Manual Tests");
		expect(mtCall.children[0].text).toContain("S2 → S3 · 1 个 CASE");
		expect(mtCall.children[2].text).toContain("CASE-01");
		expect(mtCall.children[2].text).toContain("dim:$$$");

		const attachBrainstorm = globalThis.__pi.tools.get("attach_brainstorm");
		const attachRes = attachBrainstorm.renderResult(
			{ content: [{ type: "text", text: "{:ok true :status :attached :stage :s1 :next-stage :s2}" }] },
			{ expanded: false },
			theme,
		);
		expect(attachRes.children[1].text).toContain("s1 → s2");

		const devopsDef = globalThis.__pi.tools.get("devops");
		const devopsRes = devopsDef.renderResult(
			{
				content: [
					{
						type: "text",
						text: '{:ok true :status :devops-report :report {:inspected_paths ["a.cljs" "b.cljs"]}}',
					},
				],
			},
			{ expanded: false },
			theme,
		);
		expect(devopsRes.children[1].text).toContain("2 个路径");
	});

	it("renders all 11 board_* tools and attach_case_audit with accurate tags and error status", () => {
		const splitDef = globalThis.__pi.tools.get("board_split");
		const splitCall = splitDef.renderCall(
			{
				parent_id: "T-1",
				expected_board_version: 3,
				remaining_work: "integrate both modules cleanly end-to-end",
				children: [
					{ goal: "g1", remaining_work: "w1", done_when: "d1" },
					{ goal: "g2", remaining_work: "w2", done_when: "d2" },
				],
			},
			{ expanded: false },
			theme,
		);
		expect(splitCall.children[0].text).toContain("accent:Board Split");
		expect(splitCall.children[0].text).toContain("T-1 · 2 子项 · v3");

		const conflictRes = splitDef.renderResult(
			{
				isError: true,
				content: [
					{
						type: "text",
						text: '{:ok false :error {:code :BOARD_CONFLICT :message "board version changed"}}',
					},
				],
			},
			{ expanded: false },
			theme,
		);
		expect(conflictRes.children[1].text).toContain("error:✗");
		expect(conflictRes.children[1].text).toContain("error::BOARD_CONFLICT");
		expect(conflictRes.children[1].text).toContain("board version changed");

		const takeDef = globalThis.__pi.tools.get("board_take_or_die");
		const wonRes = takeDef.renderResult(
			{
				content: [
					{
						type: "text",
						text: "{:ok true :board-version 9 :wake-epoch 4 :receipt {:outcome :attempt-won}}",
					},
				],
			},
			{ expanded: false },
			theme,
		);
		expect(wonRes.children[1].text).toContain("抢令成功 (Holder)");
		expect(wonRes.children[1].text).toContain("v9 · epoch 4");

		const auditDef = globalThis.__pi.tools.get("attach_case_audit");
		const auditCall = auditDef.renderCall(
			{
				case_id: "CASE-07",
				user_score: 88,
				developer_score: 94,
				report_markdown: `# Audit\n${"evidence ".repeat(12)}`,
			},
			{ expanded: false },
			theme,
		);
		expect(auditCall.children[0].text).toContain("accent:Attach Case Audit");
		expect(auditCall.children[0].text).toContain("CASE-07 · U:88 D:94 (min 88)");
		expect(auditCall.children[2].text).toContain("dim:$$$");

		const auditRes = auditDef.renderResult(
			{
				content: [
					{
						type: "text",
						text: '{:ok true :status :audit-submitted :case-id "CASE-07"}',
					},
				],
			},
			{ expanded: false },
			theme,
		);
		expect(auditRes.children[1].text).toContain("审计已提交");
		expect(auditRes.children[1].text).toContain("CASE-07");
	});

	it("handles partial streaming args, empty results, and missing theme helpers gracefully", () => {
		const bareTheme = {};
		const cljTools = new Set(["clj_devops", "clj_plan", "clj_review", "clj_worker", "clj_auditor"]);
		for (const name of ALL_TOOLS) {
			const def = globalThis.__pi.tools.get(name);
			const c1 = def.renderCall(undefined, { expanded: false, isPartial: true }, bareTheme);
			const c2 = def.renderCall({}, { expanded: true, isPartial: true }, theme);
			const r1 = def.renderResult({ content: [] }, { expanded: false, isPartial: true }, bareTheme);
			const r2 = def.renderResult(
				{ isError: true, content: [{ type: "text", text: "raw failure line" }] },
				{ expanded: false },
				theme,
			);
			expect(Array.isArray(c1.render(50))).toBe(true);
			expect(Array.isArray(c2.render(50))).toBe(true);
			expect(Array.isArray(r1.render(50))).toBe(true);
			expect(Array.isArray(r2.render(50))).toBe(true);
			if (!cljTools.has(name)) {
				expect(r2.render(50).join("\n")).toContain("error:✗");
			}
		}
	});
});
