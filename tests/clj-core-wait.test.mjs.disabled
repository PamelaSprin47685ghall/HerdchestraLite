import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInlineSandboxWorker } from "../src/clj-sandbox/inline-worker.mjs";
import activate, { registerCljTools } from "../src/clj-main.mjs";
import { callEnvironment } from "../src/clj-sandbox/vfs.mjs";

// Wait/call timing tests isolated from the main core file so Bun can run this
// file in parallel with the rest of the dogfood surface.
function fakeHost({ active, baseWaitMs } = {}) {
	const tools = new Map();
	const hooks = new Map();
	const surface = active ?? [];
	const pi = {
		active: surface,
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		on(name, handler) {
			const list = hooks.get(name) ?? [];
			list.push(handler);
			hooks.set(name, list);
		},
		getActiveTools() {
			return [...surface];
		},
		async setActiveTools(next) {
			surface.splice(0, surface.length, ...next);
		},
	};
	const state = registerCljTools(pi, {
		ownerId: "clj-test",
		workerFactory: createInlineSandboxWorker,
		ariadne: false,
		nativeRunner: (ctx) => fakeNativeRunner(ctx),
		...(baseWaitMs !== undefined ? { baseWaitMs } : {}),
	});
	const host = { tools, pi, hooks, state };
	activeHosts.push(host);
	return host;
}

const TEST_SESSION_MANAGER = Object.freeze({ getSessionId: () => "clj-core-test" });

function testContext(cwd) {
	return {
		cwd,
		sessionManager: TEST_SESSION_MANAGER,
		async invokeTool(params) {
			if (!params || typeof params.path !== "string") {
				return { content: [{ type: "text", text: "Nothing to wait for" }] };
			}
			const absolute = join(cwd, params.path);
			if (typeof params.content === "string") {
				writeFileSync(absolute, params.content);
				return { content: [{ type: "text", text: "ok" }] };
			}
			return { content: [{ type: "text", text: readFileSync(absolute, "utf8") }] };
		},
	};
}

/**
 * Stand-in for the host's captured ExtensionRunner. The real runner is only
 * observable inside omp; here read/write delegate to the same filesystem
 * effects so the sandbox contract stays exercised.
 */
function fakeNativeRunner(ctx) {
	return {
		hasNativeTool(name) {
			return name === "read" || name === "write";
		},
		async invokeNativeTool(name, params) {
			const cwd = ctx?.cwd ?? process.cwd();
			if (name === "read") {
				if (!params || typeof params.path !== "string") {
					return { content: [{ type: "text", text: "Nothing to wait for" }] };
				}
				return {
					content: [{ type: "text", text: readFileSync(join(cwd, params.path), "utf8") }],
				};
			}
			if (name === "write") {
				writeFileSync(join(cwd, params.path), params.content);
				return { content: [{ type: "text", text: "ok" }] };
			}
			throw new Error(`unexpected native tool: ${name}`);
		},
	};
}

function forkTool(tools, name, id, params, cwd) {
	return tools
		.get(name)
		.execute(id, { ariadne_budget: 5, ariadne_goal: "dogfood test", ...params }, undefined, undefined, testContext(cwd));
}

function waitTool(tools, id, nextIndependentWork, cwd) {
	return tools
		.get("wait")
		.execute(id, { otherwise_independent_work: nextIndependentWork }, undefined, undefined, testContext(cwd));
}

async function callTool(
	tools,
	name,
	id,
	params,
	cwd,
	nextIndependentWork = "继续派发其余无依赖的检查与读写任务，不死等当前沙箱。",
) {
	const res = await forkTool(tools, name, id, params, cwd);
	if (res.isError || !res.content[0].text.includes(":state :forked")) return res;
	return await waitTool(tools, `${id}-join`, nextIndependentWork, cwd);
}

const activeHosts = [];

describe("clj wait and call timing", () => {
	let root;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "clj-core-wait-"));
	});

	afterEach(() => {
		while (activeHosts.length > 0) activeHosts.pop().state?.terminate?.();
		rmSync(root, { recursive: true, force: true });
	});

	it("grants 1s total call grace at fork time across sequential calls before backgrounding", async () => {
		const { tools } = fakeHost({ baseWaitMs: 80 });
		const fast = await forkTool(
			tools,
			"clj_devops",
			"grace-ok",
			{
				name: "grace-ok",
				code: `[(call {:argv ["sh" "-c" "sleep 0.02 && printf a"]}) (call {:argv ["sh" "-c" "sleep 0.02 && printf b"]})]`,
			},
			root,
		);
		expect(fast.isError, fast.content?.[0]?.text).not.toBe(true);
		expect(fast.content[0].text).toContain(":state :completed");
		expect(fast.content[0].text).not.toContain(":state :forked");

		const slow = await forkTool(
			tools,
			"clj_devops",
			"grace-exceeded",
			{
				name: "grace-exceeded",
				code: `[(call {:argv ["sh" "-c" "sleep 0.05 && printf c"]}) (call {:argv ["sh" "-c" "sleep 0.05 && printf d"]})]`,
			},
			root,
		);
		expect(slow.isError).not.toBe(true);
		expect(slow.content[0].text).toContain(":state :forked");

		const joined = await waitTool(tools, "j-grace", "collect backgrounded sequential calls", root);
		expect(joined.isError).not.toBe(true);
		expect(joined.content[0].text).toContain(":state :completed");
	});

	it("ignores an idle native wait and still joins the sandbox result", async () => {
		const { tools } = fakeHost({ baseWaitMs: 50 });
		await forkTool(
			tools,
			"clj_devops",
			"idle-host",
			{ name: "idle-host", code: `(call {:argv ["sh" "-c" "sleep 0.08; printf sandbox-ok"]})` },
			root,
		);
		const res = await tools
			.get("wait")
			.execute(
				"w-idle-host",
				{ otherwise_independent_work: "host has nothing; keep waiting for the sandbox" },
				undefined,
				undefined,
				{
					cwd: root,
					sessionManager: TEST_SESSION_MANAGER,
					invokeTool: async () => ({
						content: [{ type: "text", text: "Nothing to wait for: no background job." }],
						details: { op: "wait", jobs: [] },
						useless: true,
					}),
				},
			);
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("sandbox-ok");
		expect(res.details.source).toBe("sandbox");
	});

	it("parks all running tasks on wait call-timeout and supports named unpark", async () => {
		const { tools } = fakeHost({ baseWaitMs: 0 });
		await forkTool(
			tools,
			"clj_devops",
			"long-bg-1",
			{ name: "bg-1", code: `(let [r (call {:argv ["sh" "-c" "sleep 0.06 && printf one"]})] {:got r})` },
			root,
		);
		const parked = await waitTool(tools, "j-short", "x", root);
		expect(parked.isError).not.toBe(true);
		const text = parked.content[0].text;
		expect(text).toContain(":state :parked");
		expect(text).toContain(':name "bg-1"');
		expect(text).toContain(":reason :deadline");

		const resumed = await callTool(
			tools,
			"clj_devops",
			"unpark-bg-1",
			{ name: "resume-1", code: `(unpark {:name "bg-1" :value {:stdout "manual-one"}})` },
			root,
		);
		expect(resumed.isError).not.toBe(true);
		expect(resumed.content[0].text).toContain(':stdout "one"');
	});

	it("does not count sandbox engine evaluation time toward wait call timeout", async () => {
		const { tools } = fakeHost({ baseWaitMs: 0 });
		const forked = await forkTool(
			tools,
			"clj_devops",
			"cpu-then-call",
			{
				name: "cpu-call-job",
				code: `(let [_ (loop [i 0 acc 0] (if (< i 3000) (recur (inc i) (+ acc i)) acc))] (call {:argv ["sh" "-c" "sleep 0.02 && printf ok"]}))`,
			},
			root,
		);
		expect(forked.content[0].text).toContain(":state :forked");

		const res = await waitTool(tools, "j-cpu", "x", root);
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain(":state :completed");
		expect(res.content[0].text).toContain("ok");
	});
});
