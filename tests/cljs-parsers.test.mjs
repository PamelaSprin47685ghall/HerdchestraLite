import { describe, expect, it, beforeAll } from "bun:test";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";

beforeAll(() => {
	nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
});

async function evaluate(form) {
	await nbb.loadString("(require '[herd.stages.parsers :as p])");
	const json = await nbb.loadString(`(js/JSON.stringify (clj->js ${form}))`);
	return JSON.parse(json);
}

const caseSpec = (id, path, overrides = {}) => ({
	case_id: id,
	path,
	threshold: 80,
	steps: ["step"],
	expected: "expected",
	rubric: "rubric",
	...overrides,
});

const cljsCase = (spec) =>
	`{:case_id "${spec.case_id}" :path "${spec.path}" :threshold ${spec.threshold}` +
	` :steps [${spec.steps.map((step) => `"${step}"`).join(" ")}]` +
	` :expected "${spec.expected}" :rubric "${spec.rubric}"` +
	(spec.surprise ? ` :surprise true` : "") +
	"}";

const cljsCases = (cases) => `[${cases.map(cljsCase).join(" ")}]`;

const allPaths = ["正常", "错误", "边界", "并发", "恢复"];

describe("CLJS stage parsers", () => {
	it("accepts a case dataset covering every required path", async () => {
		const cases = allPaths.map((path, index) => caseSpec(`CASE-${index}`, path));
		const result = await evaluate(
			`(p/normalize-case-specs ${cljsCases(cases)})`,
		);
		expect(result.ok).toBe(true);
		expect(result.cases).toHaveLength(5);
	});

	it("rejects a missing path category", async () => {
		const result = await evaluate(
			`(p/normalize-case-specs ${cljsCases([caseSpec("CASE-1", "正常")])})`,
		);
		expect(result.ok).toBe(false);
		expect(result.errors.some((error) => error.code === "CASE_REQUIRED_PATH_MISSING")).toBe(true);
	});

	it("rejects duplicate ids, unknown fields, and out-of-range thresholds", async () => {
		const cases = [
			caseSpec("CASE-1", "正常", { surprise: true, threshold: 101 }),
			caseSpec("CASE-1", "错误"),
		];
		const result = await evaluate(
			`(p/normalize-case-specs ${cljsCases(cases)})`,
		);
		expect(result.ok).toBe(false);
		expect(result.errors.some((error) => error.code === "CASE_DUPLICATE_ID")).toBe(true);
		expect(
			result.errors.some((error) =>
				String(error.message).includes("not an allowed CASE field"),
			),
		).toBe(true);
		expect(result.errors.some((error) => error.code === "CASE_THRESHOLD_INVALID")).toBe(true);
	});

	it("validates S1 sections and S4 promela", async () => {
		const markdown = [
			"# 一句话目标与用户可见结果",
			"# 决策框架",
			"# 现状事实与根因",
			"# 单向门/双向门",
			"# 事前验尸",
			"# Non-Goals",
			"# 成功标准",
			"# 未决问题",
		].join("\n");
		const s1 = await evaluate(
			`(p/validate-s1 ${JSON.stringify(markdown)})`,
		);
		expect(s1.ok).toBe(true);
		const s4 = await evaluate(`(p/validate-s4 "md" "")`);
		expect(s4.ok).toBe(false);
		expect(s4.errors[0].code).toBe("INVALID_ARGUMENT");
	});
});
