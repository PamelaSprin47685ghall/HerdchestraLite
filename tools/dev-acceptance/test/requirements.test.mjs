import { describe, expect, it } from "bun:test";
import { parseRequirementCases } from "../requirements.mjs";

function sheet(...blocks) {
	return ["# 验收需求", "", ...blocks].join("\n");
}

function caseBlock(
	id,
	{ threshold = "- PASS threshold: 80 / 100", path = "- 路径：正常", rubric = "- 评分细则：满足。" } = {},
) {
	return [`### ${id}`, threshold, path, rubric].join("\n");
}

describe("parseRequirementCases", () => {
	it("returns id, threshold, and path in document order", () => {
		const markdown = sheet(
			caseBlock("CASE-01"),
			"",
			["### CASE-02", "- PASS threshold：100/100", "- 路径: 错误", "- 评分细则: 错误分支。"].join("\n"),
		);

		expect(parseRequirementCases(markdown)).toEqual([
			{ id: "CASE-01", threshold: 80, path: "正常" },
			{ id: "CASE-02", threshold: 100, path: "错误" },
		]);
	});

	it("accepts the 0 and 100 boundaries and trims the path", () => {
		const markdown = sheet(
			caseBlock("CASE-01", { threshold: "- PASS threshold: 0/100", path: "- 路径：  正常  " }),
			"",
			caseBlock("CASE-02", { threshold: "- PASS threshold：100 / 100" }),
		);

		expect(parseRequirementCases(markdown).map((item) => [item.threshold, item.path])).toEqual([
			[0, "正常"],
			[100, "正常"],
		]);
	});

	it("ignores CASE lines inside backtick and tilde fences", () => {
		const markdown = sheet(
			"```text",
			"### CASE-99",
			"- PASS threshold: 10 / 100",
			"- 路径：围栏",
			"- 评分细则：不应出现。",
			"```",
			"~~~",
			"### CASE-98",
			"~~~",
			caseBlock("CASE-01"),
		);

		expect(parseRequirementCases(markdown)).toEqual([{ id: "CASE-01", threshold: 80, path: "正常" }]);
	});

	it("closes the current CASE at the next level 1-3 heading", () => {
		const markdown = sheet(
			caseBlock("CASE-01"),
			"",
			"## 下一节",
			"### CASE-02",
			"- PASS threshold: 60 / 100",
			"- 路径：正常",
			"- 评分细则：满足。",
		);

		expect(parseRequirementCases(markdown).map((item) => item.id)).toEqual(["CASE-01", "CASE-02"]);
	});

	it("reports a missing PASS threshold with the CASE line", () => {
		const markdown = sheet(caseBlock("CASE-01", { threshold: "" }));

		expect(() => parseRequirementCases(markdown)).toThrow(
			'requirements markdown line 3: CASE-01 has no "- PASS threshold: N/100" line',
		);
	});

	it("reports a missing path with the CASE line", () => {
		const markdown = sheet(caseBlock("CASE-01", { path: "" }));

		expect(() => parseRequirementCases(markdown)).toThrow(
			'requirements markdown line 3: CASE-01 has no "- 路径：..." line',
		);
	});

	it("reports a missing or empty rubric with the CASE line", () => {
		const markdown = sheet(caseBlock("CASE-01", { rubric: "- 评分细则：" }));

		expect(() => parseRequirementCases(markdown)).toThrow(
			'requirements markdown line 3: CASE-01 has no non-empty "- 评分细则：..." line',
		);
	});

	it("rejects a duplicate CASE id", () => {
		const markdown = sheet(caseBlock("CASE-01"), "", caseBlock("CASE-01"));

		expect(() => parseRequirementCases(markdown)).toThrow("requirements markdown: duplicate CASE id CASE-01");
	});

	it("rejects a threshold outside 0..100 with the threshold line", () => {
		const markdown = sheet(caseBlock("CASE-01", { threshold: "- PASS threshold: 150 / 100" }));

		expect(() => parseRequirementCases(markdown)).toThrow(
			"requirements markdown line 4: CASE-01 threshold 150 is outside 0..100",
		);
	});

	it("rejects a second threshold line", () => {
		const markdown = sheet(
			[
				"### CASE-01",
				"- PASS threshold: 10 / 100",
				"- PASS threshold: 20 / 100",
				"- 路径：正常",
				"- 评分细则：满足。",
			].join("\n"),
		);

		expect(() => parseRequirementCases(markdown)).toThrow(
			"requirements markdown line 5: CASE-01 has more than one PASS threshold line",
		);
	});

	it("rejects a sheet without CASE headings", () => {
		expect(() => parseRequirementCases("# 只有标题\n\n正文")).toThrow(
			'requirements markdown has no "### CASE-*" headings',
		);
	});
});
