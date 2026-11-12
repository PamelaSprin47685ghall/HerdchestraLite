import { describe, expect, it } from "bun:test";
import {
	normalizeCaseSpecs,
	validateModuleCoverage,
	validateS1,
	validateS2,
	validateS3,
	validateS4,
} from "../src/stages/parsers.mjs";

const S1_DOC = [
	"# S1",
	"## 一句话目标与用户可见结果",
	"一个只读的健康子命令。",
	"## 决策框架",
	"目标、备选、信息、价值与 VoI。",
	"## 现状事实与根因",
	"旧入口仍在清单中。",
	"## 单向门 / 双向门",
	"删除旧入口是单向门。",
	"## 事前验尸",
	"若失败，则旧入口继续被加载。",
	"## Non-Goals",
	"不实现独立标准版。",
	"## 成功标准",
	"用户能看到真实版本。",
	"## 未决问题",
	"无。",
].join("\n\n");

const CASES = [
	{
		case_id: "CASE-01",
		path: "正常",
		threshold: 90,
		steps: ["运行 omp", "检查输出"],
		expected: "输出包含版本号",
		rubric: "按证据映射 0-100；恰好及格 90，差一档 85。",
	},
	{
		case_id: "CASE-02",
		path: "错误",
		threshold: 90,
		steps: ["输入非法参数"],
		expected: "返回明确错误",
		rubric: "错误分支必须可复现；硬失败为 0。",
	},
	{
		case_id: "CASE-03",
		path: "边界",
		threshold: 90,
		steps: ["输入边界值"],
		expected: "边界值被接受",
		rubric: "边界值必须可观察；无证据为 0。",
	},
	{
		case_id: "CASE-04",
		path: "并发",
		threshold: 90,
		steps: ["并发启动两个会话"],
		expected: "两者互不覆盖",
		rubric: "并发证据必须独立；丢失证据为 0。",
	},
	{
		case_id: "CASE-05",
		path: "恢复",
		threshold: 90,
		steps: ["在提交后中断", "重启并恢复"],
		expected: "不出现半提交",
		rubric: "恢复后状态一致；半提交为 0。",
	},
];
const CASE_IDS = CASES.map((entry) => entry.case_id);

const S3_DOC = [
	"# S3 开发指南",
	"## 模块边界",
	"每个模块只隐藏一个变化点。",
	"## 依赖图",
	"`src/b.mjs` 依赖 `src/a.mjs`。",
	"## 失败隔离",
	"校验失败不保存。",
	"## CASE 对应表",
	"每个 CASE 有模块映射。",
].join("\n\n");

const S3_PAYLOAD_DOC = [
	"# S3 开发指南",
	"## 模块契约",
	"每个模块守住一个变化秘密。",
	"## 模块 DAG",
	"模块依赖单向，无环。",
	"## 用例到模块的映射",
	"结构性映射由 modules[].mapped_cases 承载。",
].join("\n\n");

const MODULES = [
	{
		path: "src/a.mjs",
		secret_owned: "变化点 A",
		depends_on: [],
		mapped_cases: ["CASE-01", "CASE-02", "CASE-03"],
	},
	{
		path: "src/b.mjs",
		secret_owned: "变化点 B",
		depends_on: ["src/a.mjs"],
		mapped_cases: ["CASE-04", "CASE-05"],
	},
];

const S4_DOC = [
	"# S4 协调手册",
	"## 文学化伪代码",
	"```text",
	"board_take_or_die(actor):",
	"  if token is free: actor becomes holder",
	"```",
	"## Safety",
	"至多一个 Holder。",
	"## Liveness",
	"无死锁，无睡死。",
	"## 拓扑合并顺序",
	"先 alpha 后 beta。",
].join("\n\n");

const S4_UPPER_DOC = S4_DOC.replace("## 拓扑合并顺序", "## 合并拓扑");

const SLICES = [
	{
		slice_id: "alpha",
		goal: "解析层",
		inputs: ["S1-S4 文档"],
		depends_on: [],
		done_when: "全部校验有回执",
		mapped_cases: ["CASE-01", "CASE-02", "CASE-03"],
	},
	{
		slice_id: "beta",
		goal: "集成层",
		inputs: "alpha 的接口",
		depends_on: ["alpha"],
		done_when: "端到端门禁可运行",
		mapped_cases: ["CASE-04", "CASE-05"],
	},
];

const UPPER_SLICES = SLICES.map((slice) => ({
	...slice,
	slice_id: slice.slice_id.toUpperCase(),
	depends_on: slice.depends_on.map((dependency) => dependency.toUpperCase()),
}));

function clone(value) {
	return structuredClone(value);
}

describe("validateS1", () => {
	it("accepts the eight topics", () => {
		const result = validateS1(S1_DOC);
		expect(result.ok).toBe(true);
		expect(result.sections.map((section) => section.key)).toEqual([
			"goal",
			"decision-framework",
			"current-state",
			"doors",
			"pre-mortem",
			"non-goals",
			"success",
			"open-questions",
		]);
	});

	it("rejects a missing required section", () => {
		const result = validateS1(S1_DOC.replace("## 事前验尸", "## 风险"));
		expect(result.ok).toBe(false);
		expect(result.errors.map((error) => error.section)).toEqual(["pre-mortem"]);
	});
});

describe("normalizeCaseSpecs", () => {
	it("preserves the exact structured fields and steps arrays", () => {
		const result = normalizeCaseSpecs(clone(CASES));
		expect(result.ok).toBe(true);
		expect(result.cases).toEqual(CASES);
		expect(Array.isArray(result.cases[0].steps)).toBe(true);
	});

	it("rejects unknown fields, including the removed rubric_summary and id names", () => {
		const cases = clone(CASES);
		cases[0].rubric_summary = "summary";
		cases[1].id = "CASE-02";
		const result = normalizeCaseSpecs(cases);
		expect(result.ok).toBe(false);
		expect(result.errors.map((error) => [error.field, error.code])).toEqual([
			["cases[0].rubric_summary", "CASE_SCHEMA_INVALID"],
			["cases[1].id", "CASE_SCHEMA_INVALID"],
		]);
	});

	it("rejects duplicate, malformed, and out-of-range case ids and thresholds", () => {
		const duplicate = clone(CASES);
		duplicate[1].case_id = "CASE-01";
		expect(normalizeCaseSpecs(duplicate).errors[0]).toMatchObject({ code: "CASE_DUPLICATE_ID" });

		const malformed = clone(CASES);
		malformed[0].case_id = "case-01";
		expect(normalizeCaseSpecs(malformed).errors[0]).toMatchObject({ code: "CASE_SCHEMA_INVALID" });

		const high = clone(CASES);
		high[0].threshold = 101;
		expect(normalizeCaseSpecs(high).errors[0]).toMatchObject({ code: "CASE_THRESHOLD_INVALID" });

		const nan = clone(CASES);
		nan[0].threshold = Number.NaN;
		expect(normalizeCaseSpecs(nan).errors[0]).toMatchObject({ code: "CASE_THRESHOLD_INVALID" });
	});

	it("rejects empty steps, expected, rubric, and missing required path categories", () => {
		const empty = clone(CASES);
		empty[0].steps = [];
		empty[1].expected = " ";
		empty[2].rubric = "";
		const result = normalizeCaseSpecs(empty);
		expect(result.errors.map((error) => error.field)).toEqual([
			"cases[0].steps",
			"cases[1].expected",
			"cases[2].rubric",
			"cases[].path",
		]);
		expect(result.errors.at(-1)).toMatchObject({
			code: "CASE_REQUIRED_PATH_MISSING",
			missing: ["正常", "错误", "边界"],
		});
	});

	it("lists the exact required/missing/received path sets and the correction", () => {
		const filesystemPaths = CASES.map((entry) => ({ ...entry, path: "/repo/README.md" }));
		const result = normalizeCaseSpecs(filesystemPaths);
		expect(result.ok).toBe(false);
		const error = result.errors.find((entry) => entry.code === "CASE_REQUIRED_PATH_MISSING");
		expect(error).toMatchObject({
			field: "cases[].path",
			required: ["正常", "错误", "边界", "并发", "恢复"],
			missing: ["正常", "错误", "边界", "并发", "恢复"],
		});
		expect(error.received).toContain("/repo/README.md");
		expect(error.message).toContain("正常");
		expect(error.next).toContain("filesystem path");
	});

	it("requires a non-empty cases array", () => {
		expect(normalizeCaseSpecs([]).errors[0]).toMatchObject({ field: "cases", code: "CASE_SCHEMA_INVALID" });
	});
});

describe("validateS2", () => {
	it("validates only non-empty methodology markdown and the structured cases", () => {
		const result = validateS2("# S2 方法论\n\nTesting != Checking.", clone(CASES));
		expect(result.ok).toBe(true);
		expect(result.cases).toEqual(CASES);
	});

	it("ignores CASE text embedded in the markdown", () => {
		const markdown = [
			"# S2 方法论",
			"### CASE-99",
			"- PASS threshold: 1/100",
			"- 路径：正常",
			"- 评分细则：伪 CASE",
		].join("\n\n");
		const result = validateS2(markdown, clone(CASES));
		expect(result.ok).toBe(true);
		expect(result.cases.map((entry) => entry.case_id)).toEqual(CASE_IDS);
	});

	it("rejects empty markdown even when the cases are valid", () => {
		const result = validateS2(" ", clone(CASES));
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatchObject({ field: "manual_tests_markdown", code: "CASE_SCHEMA_INVALID" });
	});
});

describe("validateS3 and module coverage", () => {
	it("accepts modules whose mapped_cases cover every frozen case", () => {
		expect(validateS3(S3_DOC, clone(MODULES), CASE_IDS).ok).toBe(true);
		expect(validateModuleCoverage(clone(MODULES), CASE_IDS).ok).toBe(true);
	});

	it("accepts module boundaries plus a 模块 DAG heading without a CASE mapping heading", () => {
		expect(validateS3(S3_PAYLOAD_DOC, clone(MODULES), CASE_IDS).ok).toBe(true);
	});

	it("still rejects a document with no dependency graph heading", () => {
		const markdown = ["# S3", "## 模块契约", "只有模块边界。"].join("\n\n");
		const result = validateS3(markdown, clone(MODULES), CASE_IDS);
		expect(result.ok).toBe(false);
		expect(result.errors.map((error) => error.section)).toEqual(["dependency-graph"]);
	});

	it("rejects unknown, missing, and duplicate mapped cases", () => {
		const unknown = clone(MODULES);
		unknown[0].mapped_cases.push("CASE-99");
		expect(validateS3(S3_DOC, unknown, CASE_IDS).errors[0]).toMatchObject({
			code: "MAPPED_CASE_UNKNOWN",
			case_id: "CASE-99",
		});

		const missing = clone(MODULES);
		missing[1].mapped_cases = ["CASE-04"];
		expect(validateS3(S3_DOC, missing, CASE_IDS).errors.at(-1)).toMatchObject({
			code: "MAPPED_CASE_MISSING",
			missing: ["CASE-05"],
		});

		const duplicate = clone(MODULES);
		duplicate[0].mapped_cases.push("CASE-01");
		expect(validateModuleCoverage(duplicate, CASE_IDS).errors[0]).toMatchObject({
			code: "CASE_SCHEMA_INVALID",
			case_id: "CASE-01",
		});
	});

	it("rejects an unknown module field and an empty case id list", () => {
		const modules = clone(MODULES);
		modules[0].owner = "someone";
		expect(validateS3(S3_DOC, modules, CASE_IDS).errors[0]).toMatchObject({ field: "modules.owner" });
		expect(validateS3(S3_DOC, clone(MODULES), []).errors[0]).toMatchObject({ field: "caseIds" });
	});
});

describe("validateS4", () => {
	it("accepts slices whose mapped_cases cover every frozen case", () => {
		expect(validateS4(S4_DOC, clone(SLICES), CASE_IDS).ok).toBe(true);
	});

	it("accepts uppercase slice ids and 合并拓扑 as the merge-order heading", () => {
		expect(validateS4(S4_UPPER_DOC, clone(UPPER_SLICES), CASE_IDS).ok).toBe(true);
	});

	it("keeps depends_on case-sensitive against the declared slice ids", () => {
		const slices = clone(UPPER_SLICES);
		slices[1].depends_on = ["slice-01"];
		const result = validateS4(S4_UPPER_DOC, slices, CASE_IDS);
		expect(result.ok).toBe(false);
		expect(result.errors.some((error) => error.field === "slices.depends_on" && error.dependency === "slice-01")).toBe(
			true,
		);
	});

	it("rejects unknown, missing, and duplicate mapped cases", () => {
		const unknown = clone(SLICES);
		unknown[0].mapped_cases.push("CASE-99");
		expect(validateS4(S4_DOC, unknown, CASE_IDS).errors[0]).toMatchObject({
			code: "MAPPED_CASE_UNKNOWN",
			case_id: "CASE-99",
		});

		const missing = clone(SLICES);
		missing[1].mapped_cases = ["CASE-04"];
		expect(validateS4(S4_DOC, missing, CASE_IDS).errors.at(-1)).toMatchObject({
			code: "MAPPED_CASE_MISSING",
			missing: ["CASE-05"],
		});

		const duplicate = clone(SLICES);
		duplicate[0].mapped_cases.push("CASE-01");
		expect(validateS4(S4_DOC, duplicate, CASE_IDS).errors[0]).toMatchObject({
			code: "CASE_SCHEMA_INVALID",
			case_id: "CASE-01",
		});
	});
});
