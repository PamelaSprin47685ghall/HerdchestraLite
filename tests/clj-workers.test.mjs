import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCljTools } from "../src/clj-main.mjs";

const WORKERS = "more_workers_without_hitting_mythical_man_month";
const nudgeFor = (count) => `<system-reminder>\n<skill version="1.0">你刚刚在工具参数中说还可以增派 ${String(count)} 个工人，现在请你立刻兑现。</skill>\n</system-reminder>`;

describe("Mythical Man-Month worker self-check", () => {
	const activeHosts = [];
	let root;

	function fakeHost() {
		const tools = new Map();
		const pi = {
			registerTool(tool) {
				tools.set(tool.name, tool);
			},
			registerCommand() {},
			on() {},
			getActiveTools() {
				return [];
			},
			async setActiveTools() {},
		};
		const state = registerCljTools(pi, { ownerId: "clj-workers-test", ariadne: false });
		activeHosts.push(state);
		return tools;
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "clj-workers-test-"));
	});

	afterEach(() => {
		while (activeHosts.length > 0) activeHosts.pop().terminate?.();
		rmSync(root, { recursive: true, force: true });
	});

	it("declares the worker field on all clj tools and requires proof in wait counterfactual description", () => {
		const tools = fakeHost();
		for (const name of ["clj_devops", "wait"]) {
			const definition = tools.get(name).parameters.properties[WORKERS];
			expect(definition.type).toBe("integer");
			expect(definition.minimum).toBe(0);
		}
		const joinDesc = tools.get("wait").parameters.properties.otherwise_independent_work.description;
		expect(joinDesc).toContain(WORKERS);
		expect(joinDesc).toContain("Mythical Man-Month");
	});

	it("appends the delivery nudge only when the declared count is positive", async () => {
		const tools = fakeHost();
		const cljDevops = tools.get("clj_devops");

		const withThree = await cljDevops.execute("w-3", { code: "1", ariadne_budget: 5, ariadne_goal: "test", [WORKERS]: 3 }, undefined, undefined, { cwd: root });
		expect(withThree.content.at(-1).text).toBe(nudgeFor(3));

		const zero = await cljDevops.execute("w-0", { code: "1", ariadne_budget: 5, ariadne_goal: "test", [WORKERS]: 0 }, undefined, undefined, { cwd: root });
		expect(zero.content.some((block) => typeof block.text === "string" && block.text.includes("立刻兑现"))).toBe(false);

		const absent = await cljDevops.execute("w-none", { code: "1", ariadne_budget: 5, ariadne_goal: "test" }, undefined, undefined, { cwd: root });
		expect(absent.content.some((block) => typeof block.text === "string" && block.text.includes("立刻兑现"))).toBe(
			false,
		);
	});

	it("rejects negative, fractional, or non-integer worker counts", async () => {
		const tools = fakeHost();
		const cljDevops = tools.get("clj_devops");
		for (const [index, value] of [-1, 1.5, "3"].entries()) {
			const result = await cljDevops.execute(
				`w-bad-${String(index)}`,
				{ code: "1", ariadne_budget: 5, ariadne_goal: "test", [WORKERS]: value },
				undefined,
				undefined,
				{ cwd: root },
			);
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain(":INVALID_ARGUMENT");
		}
	});

	it("appends the nudge from wait when positive and omits it when zero", async () => {
		const tools = fakeHost();
		const waitTool = tools.get("wait");

		const nudged = await waitTool.execute(
			"j-w",
			{ otherwise_independent_work: "可并行派发两个互不相交的切片。", [WORKERS]: 2 },
			undefined,
			undefined,
			{ cwd: root },
		);
		expect(nudged.content.at(-1).text).toBe(nudgeFor(2));

		const zero = await waitTool.execute(
			"j-0",
			{ otherwise_independent_work: "无更多可证互不相交的切片。", [WORKERS]: 0 },
			undefined,
			undefined,
			{ cwd: root },
		);
		expect(zero.content.some((block) => typeof block.text === "string" && block.text.includes("立刻兑现"))).toBe(false);
	});
});
