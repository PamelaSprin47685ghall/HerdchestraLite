import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import devAcceptance from "../index.mjs";
import { sha256Document } from "../report.mjs";
import { parseRequirementCases } from "../requirements.mjs";
import { registerManualAcceptanceTools } from "../tools.mjs";

const tempDirs = [];

function tempCwd() {
	const dir = mkdtempSync(join(tmpdir(), "herd-dev-acceptance-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakePi() {
	const tools = new Map();
	const Type = {
		String: (options = {}) => ({ type: "string", ...options }),
		Number: (options = {}) => ({ type: "number", ...options }),
		Array: (items, options = {}) => ({ type: "array", items, ...options }),
		Object: (properties, options = {}) => ({ type: "object", properties, ...options }),
		Optional: (schema) => schema,
	};
	return {
		pi: {
			typebox: { Type },
			registerTool: (definition) => {
				tools.set(definition.name, definition);
			},
		},
		tools,
	};
}

function context(cwd) {
	return {
		cwd,
		sessionManager: {
			getBranch: () => [],
		},
	};
}

async function call(tools, name, params, cwd) {
	const definition = tools.get(name);
	if (!definition) throw new Error(`tool ${name} was not registered`);
	return definition.execute("call-1", params, undefined, undefined, context(cwd));
}

function textOf(result) {
	return result.content.map((item) => item.text).join("\n");
}

const requirementsMarkdown = `# Requirements

## 1. Cases

### CASE-01
- PASS threshold: 90/100
- 路径：正常
- 评分细则：90 分，边界清晰。
`;

const guideMarkdown = `# Guide

## S2 实现

仅用于开发验收测试。
`;

const coordinationMarkdown = `# Coordination

## 切片

一个切片。

### 6.6 拓扑合并顺序

直接合并。
`;

describe("dev-acceptance submission tools", () => {
	test("the package entry registers the four tools", () => {
		const { pi, tools } = fakePi();
		devAcceptance(pi);
		expect([...tools.keys()].sort()).toEqual([
			"submit_coordination",
			"submit_development_guide",
			"submit_manual_report",
			"submit_manual_requirements",
		]);
	});

	test("the dev-acceptance package is not in the root plugin entry list", () => {
		const root = JSON.parse(readFileSync(join(import.meta.dir, "../../../package.json"), "utf8"));
		expect(root.omp.extensions).toEqual(["./src/bootstrap-main.mjs", "./src/tool-gate/index.mjs"]);
		expect(JSON.stringify(root)).not.toContain("tools/dev-acceptance");
	});

	test("registers the four tools, including the report writer", () => {
		const { pi, tools } = fakePi();
		registerManualAcceptanceTools(pi);
		expect([...tools.keys()].sort()).toEqual([
			"submit_coordination",
			"submit_development_guide",
			"submit_manual_report",
			"submit_manual_requirements",
		]);
	});

	test("parses CASE headings and ignores fenced code blocks", () => {
		const markdown = `${requirementsMarkdown}
\`\`\`markdown
### CASE-99
- PASS threshold: 1/100
- 路径：正常
- 评分细则：不应被解析。
\`\`\`
`;
		expect(parseRequirementCases(markdown)).toEqual([{ id: "CASE-01", threshold: 90, path: "正常" }]);
	});

	test("rejects a cases entry whose threshold does not match the markdown", async () => {
		const { pi, tools } = fakePi();
		registerManualAcceptanceTools(pi);
		const cwd = tempCwd();
		const result = await call(
			tools,
			"submit_manual_requirements",
			{
				goal_slug: "alpha",
				requirements_markdown: requirementsMarkdown,
				cases: [{ id: "CASE-01", threshold: 80, path: "正常" }],
			},
			cwd,
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("does not match");
		expect(existsSync(join(cwd, "docs/manual-acceptance/alpha/requirements.md"))).toBe(false);
	});

	test("writes all four documents only when the contract hashes match", async () => {
		const { pi, tools } = fakePi();
		registerManualAcceptanceTools(pi);
		const cwd = tempCwd();

		const requirements = await call(
			tools,
			"submit_manual_requirements",
			{
				goal_slug: "alpha",
				requirements_markdown: requirementsMarkdown,
				cases: [{ id: "CASE-01", threshold: 90, path: "正常" }],
			},
			cwd,
		);
		expect(requirements.isError).not.toBe(true);

		expect(
			(await call(tools, "submit_development_guide", { goal_slug: "alpha", guide_markdown: guideMarkdown }, cwd))
				.isError,
		).not.toBe(true);
		expect(
			(
				await call(
					tools,
					"submit_coordination",
					{ goal_slug: "alpha", coordination_markdown: coordinationMarkdown },
					cwd,
				)
			).isError,
		).not.toBe(true);

		const root = join(cwd, "docs/manual-acceptance/alpha");
		const requirementsPath = join(root, "requirements.md");
		const guidePath = join(root, "development-guide.md");
		const coordinationPath = join(root, "coordination.md");
		const contract = [
			"Verification contract: MANUAL ACCEPTANCE —",
			`requirements: docs/manual-acceptance/alpha/requirements.md sha256=${sha256Document(requirementsPath)};`,
			`development-guide: docs/manual-acceptance/alpha/development-guide.md sha256=${sha256Document(guidePath)};`,
			`coordination: docs/manual-acceptance/alpha/coordination.md sha256=${sha256Document(coordinationPath)};`,
			"execute every CASE and score it out of 100; automated tests are NOT acceptance evidence.",
		].join(" ");

		const reportMarkdown = `# Report\n\n## 判定\n\nPASS\n`;
		const report = await call(
			tools,
			"submit_manual_report",
			{ goal_slug: "alpha", report_markdown: reportMarkdown, contract_line: contract },
			cwd,
		);
		expect(report.isError).not.toBe(true);
		expect(textOf(report)).toContain("docs/manual-acceptance/alpha/report.md");
		expect(readFileSync(join(root, "report.md"), "utf8")).toBe(reportMarkdown);

		writeFileSync(requirementsPath, `${requirementsMarkdown}\nchanged\n`);
		const stale = await call(
			tools,
			"submit_manual_report",
			{ goal_slug: "alpha", report_markdown: reportMarkdown, contract_line: contract },
			cwd,
		);
		expect(stale.isError).toBe(true);
		expect(textOf(stale)).toContain(":CONTRACT_HASH_MISMATCH");
		expect(readFileSync(join(root, "report.md"), "utf8")).toBe(reportMarkdown);
	});

	test("rejects a report when no contract line exists", async () => {
		const { pi, tools } = fakePi();
		registerManualAcceptanceTools(pi);
		const cwd = tempCwd();
		await call(
			tools,
			"submit_manual_requirements",
			{
				goal_slug: "alpha",
				requirements_markdown: requirementsMarkdown,
				cases: [{ id: "CASE-01", threshold: 90, path: "正常" }],
			},
			cwd,
		);
		await call(tools, "submit_development_guide", { goal_slug: "alpha", guide_markdown: guideMarkdown }, cwd);
		await call(tools, "submit_coordination", { goal_slug: "alpha", coordination_markdown: coordinationMarkdown }, cwd);

		const report = await call(
			tools,
			"submit_manual_report",
			{ goal_slug: "alpha", report_markdown: "# Report\n\n## 判定\n\nPASS\n" },
			cwd,
		);
		expect(report.isError).toBe(true);
		expect(textOf(report)).toContain("contract_line is required");
		expect(existsSync(join(cwd, "docs/manual-acceptance/alpha/report.md"))).toBe(false);
	});
});
