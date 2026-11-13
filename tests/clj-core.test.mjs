/**
 * Dogfood tests for the async clj-only surface + unified wait.
 *
 * These exercise the real evaluator and VFS through the same tool objects the
 * host registers. They do not start a model, a subagent, or the mission layer.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInlineSandboxWorker } from "../src/clj-sandbox/inline-worker.mjs";
import activate, {
	applyCljToolSurface,
	deadlineFor,
	HOST_TOOL_BLACKLIST,
	registerCljTools,
	waitMsFor,
} from "../src/clj-main.mjs";
import { callEnvironment, defaultRunCommand } from "../src/clj-sandbox/vfs.mjs";

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

describe("clj-only async dogfood surface", () => {
	let root;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "clj-core-test-"));
	});

	afterEach(() => {
		while (activeHosts.length > 0) activeHosts.pop().state?.terminate?.();
		rmSync(root, { recursive: true, force: true });
	});

	it("reuses the same sandbox-worker across multiple activations in the same process", async () => {
		const h1 = fakeHost();
		const h2 = fakeHost();
		const s1 = await activate(h1.pi);
		const s2 = await activate(h2.pi);
		activeHosts.push({ state: s1 }, { state: s2 });
		expect(s1.worker).not.toBeNull();
		expect(s2.worker).toBe(s1.worker);
	});

		it("pre-warms sandbox-worker in background from activate() without blocking main thread", async () => {
		const { pi } = fakeHost();
		const warmed = await activate(pi);
		activeHosts.push({ state: warmed });
		expect(warmed.worker).not.toBeNull();
		const start = Date.now();
		while (warmed.workerCherry === null && Date.now() - start < 2_000) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(warmed.workerCherry?.loaded).toBe(true);
	});

		it("registers the default devops sandbox and unified wait", () => {
		const { tools } = fakeHost();
		expect([...tools.keys()].sort()).toEqual(["ask_beacon", "clj_devops", "time_leap", "wait"]);
	});

		it("removes replaced host tools and keeps the clj surface + wait active", async () => {
		const active = [...HOST_TOOL_BLACKLIST, "todo", "task", "web_search", "lsp", "my_custom_tool", "clj_plan"];
		const { pi } = fakeHost({ active: [...active] });
		const result = await applyCljToolSurface(pi);

		expect(result.ok).toBe(true);
		expect([...result.removed].sort()).toEqual([...HOST_TOOL_BLACKLIST, "clj_plan"].sort());
		for (const name of HOST_TOOL_BLACKLIST) expect(pi.active).not.toContain(name);
		expect(pi.active).toContain("todo");
		expect(pi.active).toContain("task");
		expect(pi.active).toContain("web_search");
		expect(pi.active).toContain("lsp");
		expect(pi.active).toContain("my_custom_tool");
		expect(pi.active).not.toContain("clj_plan");
		expect(pi.active).not.toContain("clj_worker");
		expect(pi.active).toContain("clj_devops");
		expect(pi.active).toContain("wait");
		expect(pi.active).not.toContain("unselected_tool");
	});

		it("installs session and turn hooks that enforce the surface", async () => {
		const active = ["read", "bash", "todo"];
		const { pi, hooks } = fakeHost({ active });
		expect(hooks.has("session_start")).toBe(true);
		expect(hooks.has("before_agent_start")).toBe(true);
		await hooks.get("session_start")[0]();
		expect(pi.active).not.toContain("read");
		expect(pi.active).not.toContain("bash");
		expect(pi.active).toContain("todo");
		expect(pi.active).toContain("wait");
	});

		it("strips host-injected interpreter and shell hooks from call", async () => {
		const previous = process.env.BUN_OPTIONS;
		process.env.BUN_OPTIONS = "--preload /tmp/host-hook.js";
		try {
			expect(callEnvironment({ BUN_OPTIONS: "x", PATH: "/bin", NODE_OPTIONS: "y" })).toEqual({
				PATH: "/bin",
			});
			const result = await defaultRunCommand(["sh", "-c", "printf '%s' \"$BUN_OPTIONS\""], {
				cwd: root,
				maxBytes: 1024,
			});
			expect(result.stdout).toBe("");
		} finally {
			if (previous === undefined) delete process.env.BUN_OPTIONS;
			else process.env.BUN_OPTIONS = previous;
		}
	});

		it("computes wait duration as 1000ms plus 50ms per UTF-8 byte", () => {
		const now = 1_000;
		expect(waitMsFor("x")).toBe(1_050);
		expect(deadlineFor("x", now) - now).toBe(1_050);
		expect(deadlineFor("x".repeat(1_000), now) - now).toBe(51_000);
	});

		it("rejects intent on fork and requires otherwise_independent_work on wait", async () => {
		const { tools } = fakeHost();
		const forkWithIntent = await forkTool(
			tools,
			"clj_devops",
			"bad-fork",
			{ code: "1", intent: "should be rejected" },
			root,
		);
		expect(forkWithIntent.isError).toBe(true);
		expect(forkWithIntent.content[0].text).toContain(":INVALID_ARGUMENT");

		const badJoin = await tools.get("wait").execute("bad-join", {}, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
		expect(badJoin.isError).toBe(true);
		expect(badJoin.content[0].text).toContain(":INVALID_ARGUMENT");
	});

		it("delegates to the native wait when no sandbox task is running", async () => {
		const { tools } = fakeHost();
		const res = await tools
			.get("wait")
			.execute("w-host", { otherwise_independent_work: "no sandbox task is running" }, undefined, undefined, {
				cwd: root,
				invokeTool: async () => ({ content: [{ type: "text", text: "host-ok" }], details: { op: "wait", jobs: [] } }),
			});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("host-ok");
	});

		it("applies barrier semantics when wait is called concurrently in the same batch as a call", async () => {
		const { tools } = fakeHost({ baseWaitMs: 0 });
		const [forked, joined] = await Promise.all([
			forkTool(
				tools,
				"clj_devops",
				"conc-1",
				{ name: "conc-job", code: `(call {:argv ["printf" "barrier-ok"]})` },
				root,
			),
			waitTool(tools, "conc-join", "等待同一并发批次中刚派发的 call 任务完成。", root),
		]);
		expect(forked.isError).not.toBe(true);
		expect(forked.content[0].text).toContain(":state :forked");
		expect(joined.isError).not.toBe(true);
		expect(joined.content[0].text).toContain("barrier-ok");
	});
		it("returns synchronously when no call is executed, even if call appears in an untaken branch", async () => {
		const { tools } = fakeHost();
		const plan = await forkTool(tools, "clj_devops", "sync-1", { name: "p-sync", code: "(+ 1 2)" }, root);
		expect(plan.isError).not.toBe(true);
		expect(plan.content[0].text).toContain(":state :completed");
		expect(plan.content[0].text).toContain(":value 3");
		expect(plan.content[0].text).not.toContain(":state :forked");

		const untaken = await forkTool(
			tools,
			"clj_devops",
			"sync-2",
			{ name: "d-untaken", code: `(if false (call {:argv ["printf" "no"]}) 42)` },
			root,
		);
		expect(untaken.isError).not.toBe(true);
		expect(untaken.content[0].text).toContain(":state :completed");
		expect(untaken.content[0].text).toContain(":value 42");
		expect(untaken.content[0].text).not.toContain(":state :forked");
	});

	it.skip("backgrounds a second devops program while a call holds the write gate", async () => {
		const { tools } = fakeHost({ baseWaitMs: 0 });
		const slow = await forkTool(
			tools,
			"clj_devops",
			"slow",
			{ name: "slow-job", code: `(call {:argv ["sh" "-c" "sleep 0.25 && printf slow-done"]})` },
			root,
		);
		expect(slow.content[0].text).toContain(":state :forked");

		writeFileSync(join(root, "fast.txt"), "fast-done");
		const fast = await forkTool(
			tools,
			"clj_devops",
			"fast",
			{ name: "fast-job", code: `(cat {:path "fast.txt"})` },
			root,
		);
		expect(fast.isError, fast.content?.[0]?.text).not.toBe(true);
		expect(fast.content[0].text).toContain(":state :forked");

		const joined = await waitTool(tools, "j-2", "收集持锁 call 与排队的 cat。", root);
		expect(joined.isError).not.toBe(true);
		const rest = await waitTool(tools, "j-3", "收集另一个后台任务。", root);
		expect(rest.isError).not.toBe(true);
		const combined = `${joined.content[0].text}\n${rest.content[0].text}`;
		expect(combined).toContain("slow-done");
		expect(combined).toContain("fast-done");
	});

	it.skip("pipes unpark :value into call stdin and delivers non-overlapping stdout/stderr deltas across parks", async () => {
		const { tools } = fakeHost({ baseWaitMs: 0 });
		const forked = await forkTool(
			tools,
			"clj_devops",
			"kbd-1",
			{
				name: "kbd-job",
				code: `(call {:argv ["sh" "-c" "printf 'p1\\n'; read line; printf 'p2:%s\\n' $line"]})`,
			},
			root,
		);
		expect(forked.content[0].text).toContain(":state :forked");

		// Wait long enough for p1 to flush, then park at 50ms while `read line` blocks on stdin.
		await new Promise((r) => setTimeout(r, 80));
		const p1 = await waitTool(tools, "j-p1", "x", root);
		expect(p1.isError).not.toBe(true);
		const p1Text = p1.content[0].text;
		expect(p1Text).toContain(":state :parked");
		expect(p1Text).toContain("p1");

		const resumed = await forkTool(
			tools,
			"clj_devops",
			"kbd-unpark",
			{ name: "kbd-resume", code: `(unpark {:name "kbd-job" :value "from-kbd\\n"})` },
			root,
		);
		const finalRes = resumed.content[0].text.includes(":state :forked")
			? await waitTool(tools, "j-p2", "wait for stdin echo", root)
			: resumed;
		expect(finalRes.isError).not.toBe(true);
		const finalText = finalRes.content[0].text;
		expect(finalText).toContain(":state :completed");
		expect(finalText).toContain("p2:from-kbd");
		expect(finalText.split(":stdout")[1]).not.toContain("p1");
	});

	it.skip("auto-backgrounds worker write when W is held by a slow call instead of hanging", async () => {
		const { tools } = fakeHost({ baseWaitMs: 0 });
		const callFork = await forkTool(
			tools,
			"clj_devops",
			"hold-w",
			{ name: "hold-w", code: `(call {:argv ["sh" "-c" "sleep 0.25 && printf held-done"]})` },
			root,
		);
		expect(callFork.content[0].text).toContain(":state :forked");

		const started = Date.now();
		const workerFork = await forkTool(
			tools,
			"clj_devops",
			"wait-w",
			{ name: "wait-w", code: `(write {:path "queued.txt" :content "queued-ok"})` },
			root,
		);
		expect(Date.now() - started).toBeLessThan(100);
		expect(workerFork.content[0].text).toContain(":state :forked");

		const j1 = await waitTool(tools, "j-w1", "等待持有 W 锁的 call 与排队的 worker write 完成。", root);
		console.error("J1_DEBUG", j1?.content?.[0]?.text);
		expect(j1.isError).not.toBe(true);
		const j2 = await waitTool(tools, "j-w2", "收集第二个完成的任务。", root);
		const combined = `${j1.content[0].text}\n${j2.content[0].text}`;
		expect(combined).toContain("held-done");
		expect(readFileSync(join(root, "queued.txt"), "utf8")).toBe("queued-ok");
	});
		it("requires an explicit unique program name", async () => {
		const { tools } = fakeHost();
		const missing = await callTool(
			tools,
			"clj_devops",
			"repl-missing",
			{
				code: `(write {:path "repl.txt" :content "ok"})`,
			},
			root,
		);
		expect(missing.isError).toBe(true);
		expect(missing.content[0].text).toContain("name is required");
		const result = await callTool(
			tools,
			"clj_devops",
			"repl",
			{
				name: "repl",
				code: `(write {:path "repl.txt" :content "ok"})`,
			},
			root,
		);
		expect(result.isError, result.content?.[0]?.text).not.toBe(true);
		expect(readFileSync(join(root, "repl.txt"), "utf8")).toBe("ok");
	});

		it("executes argv directly without shell interpretation", async () => {
		const { tools } = fakeHost();
		const result = await callTool(
			tools,
			"clj_devops",
			"argv",
			{
				name: "argv",
				code: `(call {:argv ["printf" "%s" "a|b"]})`,
			},
			root,
		);
		const text = result.content[0].text;
		expect(result.isError, result.content?.[0]?.text).not.toBe(true);
		expect(text).toContain(":argc 3");
		expect(text).toContain(':stdout "a|b"');
	});
});
