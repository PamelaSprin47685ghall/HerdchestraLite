import { describe, expect, it } from "bun:test";
import { normalizeCaseSpecs, validateS1, validateS2, validateS3, validateS4 } from "../src/stages/parsers.mjs";

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
	"## 目标与边界",
	"先交付只读健康检查，再交付可写入口。",
	"## 架构",
	"每个模块只隐藏一个变化点；依赖保持单向。",
	"## 实现步骤",
	"先落解析器，再接门禁，最后接命令行。",
	"## 失败隔离",
	"校验失败不保存，也不推进阶段。",
].join("\n\n");

const PROMELA = [
	"/* 协调模型：至多一个 Holder。 */",
	"byte holder = 0;",
	"active proctype Coordinator() {",
	"  holder = 1;",
	"}",
].join("\n");

function clone(value) {
	return structuredClone(value);
}

describe("validateS1", () => {
	it("accepts the eight topics from markdown alone", () => {
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

	it("rejects empty and non-string markdown without reading summary fields", () => {
		for (const value of ["", "   ", null, undefined, 42]) {
			const result = validateS1(value);
			expect(result.ok).toBe(false);
			expect(result.errors[0]).toMatchObject({ field: "markdown", code: "INVALID_ARGUMENT" });
		}
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
		expect(Object.keys(result).sort()).toEqual(["cases", "errors", "ok"]);
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
		expect(result.errors[0]).toMatchObject({ field: "markdown", code: "CASE_SCHEMA_INVALID" });
	});

	it("mentions neither freezing nor hashes in a successful or failed result", () => {
		const okResult = validateS2("# S2 方法论", clone(CASES));
		const failedResult = validateS2("# S2 方法论", []);
		for (const result of [okResult, failedResult]) {
			expect(JSON.stringify(result)).not.toMatch(/frozen|freeze|sha256|hash/i);
		}
	});

	it("still rejects an invalid CASE dataset", () => {
		const incomplete = clone(CASES).slice(0, 1);
		const result = validateS2("# S2 方法论", incomplete);
		expect(result.ok).toBe(false);
		expect(result.errors.at(-1)).toMatchObject({ code: "CASE_REQUIRED_PATH_MISSING" });
	});
});

describe("validateS3", () => {
	it("accepts a prose guide without modules or mapped cases", () => {
		const result = validateS3(S3_DOC);
		expect(result.ok).toBe(true);
		expect(Object.keys(result).sort()).toEqual(["errors", "ok"]);
	});

	it("does not require headings or a modules array", () => {
		expect(validateS3("自由组织的开发指南正文。").ok).toBe(true);
	});

	it("rejects empty and non-string markdown", () => {
		for (const value of ["", "   ", null, undefined]) {
			const result = validateS3(value);
			expect(result.ok).toBe(false);
			expect(result.errors[0]).toMatchObject({ field: "markdown", code: "INVALID_ARGUMENT" });
		}
	});
});

describe("validateS4", () => {
	it("accepts non-empty markdown and non-empty promela", () => {
		const result = validateS4("# S4 协调手册", PROMELA);
		expect(result.ok).toBe(true);
		expect(Object.keys(result).sort()).toEqual(["errors", "ok"]);
	});

	it("does not parse promela content", () => {
		expect(validateS4("# S4 协调手册", "not a promela model at all").ok).toBe(true);
	});

	it("requires a non-empty promela string", () => {
		for (const value of ["", "   ", null, undefined, 42]) {
			const result = validateS4("# S4 协调手册", value);
			expect(result.ok).toBe(false);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]).toMatchObject({ field: "promela", code: "INVALID_ARGUMENT" });
		}
	});

	it("requires non-empty markdown", () => {
		const result = validateS4(" ", PROMELA);
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatchObject({ field: "markdown", code: "INVALID_ARGUMENT" });
	});
});