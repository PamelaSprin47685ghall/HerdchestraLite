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
		ariadne: false,
		...(baseWaitMs !== undefined ? { baseWaitMs } : {}),
	});
	const host = { tools, pi, hooks, state };
	activeHosts.push(host);
	return host;
}

const TEST_SESSION_MANAGER = Object.freeze({ getSessionId: () => "clj-core-test" });

function forkTool(tools, name, id, params, cwd) {
	return tools
		.get(name)
		.execute(id, { ariadne_budget: 5, ariadne_goal: "dogfood test", ...params }, undefined, undefined, { cwd, sessionManager: TEST_SESSION_MANAGER });
}

function waitTool(tools, id, nextIndependentWork, cwd) {
	return tools
		.get("wait")
		.execute(id, { otherwise_independent_work: nextIndependentWork }, undefined, undefined, { cwd, sessionManager: TEST_SESSION_MANAGER });
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
		expect([...tools.keys()].sort()).toEqual([
			"ask_beacon",
			"clj_devops",
			"time_leap",
			"wait",
		]);
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

	it("grants 1s total call grace at fork time across sequential calls before backgrounding", async () => {
		const { tools } = fakeHost({ baseWaitMs: 220 });
		const fast = await forkTool(
			tools,
			"clj_devops",
			"grace-ok",
			{
				name: "grace-ok",
				code: `[(call {:argv ["sh" "-c" "sleep 0.04 && printf a"]}) (call {:argv ["sh" "-c" "sleep 0.04 && printf b"]})]`,
			},
			root,
		);
		expect(fast.isError).not.toBe(true);
		expect(fast.content[0].text).toContain(":state :completed");
		expect(fast.content[0].text).not.toContain(":state :forked");

		const slow = await forkTool(
			tools,
			"clj_devops",
			"grace-exceeded",
			{
				name: "grace-exceeded",
				code: `[(call {:argv ["sh" "-c" "sleep 0.14 && printf c"]}) (call {:argv ["sh" "-c" "sleep 0.14 && printf d"]})]`,
			},
			root,
		);
		expect(slow.isError).not.toBe(true);
		expect(slow.content[0].text).toContain(":state :forked");

		const joined = await waitTool(tools, "j-grace", "collect backgrounded sequential calls", root);
		expect(joined.isError).not.toBe(true);
		expect(joined.content[0].text).toContain(":state :completed");
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

	it("ignores an idle native wait and still joins the sandbox result", async () => {
		const { tools } = fakeHost();
		await forkTool(
			tools,
			"clj_devops",
			"idle-host",
			{ name: "idle-host", code: `(call {:argv ["sh" "-c" "sleep 1.1; printf sandbox-ok"]})` },
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
	it("returns :idle immediately from wait when no tasks exist", async () => {
		const { tools } = fakeHost();
		const started = Date.now();
		const res = await waitTool(tools, "idle-1", "无事可做时立即返回。", root);
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain(":state :idle");
		expect(Date.now() - started).toBeLessThan(200);
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

	it("returns all backlogged call results at once without blocking", async () => {
		const { tools } = fakeHost({ baseWaitMs: 0 });
		const f1 = await forkTool(tools, "clj_devops", "b1", { name: "p1", code: `(call {:argv ["printf" "one"]})` }, root);
		const f2 = await forkTool(tools, "clj_devops", "b2", { name: "p2", code: `(call {:argv ["printf" "two"]})` }, root);
		expect(f1.content[0].text).toContain(":state :forked");
		expect(f2.content[0].text).toContain(":state :forked");

		// Allow both background calls to settle into backlog.
		await new Promise((r) => setTimeout(r, 120));

		const joined = await waitTool(tools, "j-backlog", "先收集积压结果，再决定下一批独立派发。", root);
		expect(joined.isError).not.toBe(true);
		const text = joined.content[0].text;
		expect(text).toContain("; joined: clj_devops p1");
		expect(text).toContain("; joined: clj_devops p2");
		expect(text).toContain("one");
		expect(text).toContain("two");

		const next = await waitTool(tools, "j-empty", "确认积压已清空。", root);
		expect(next.content[0].text).toContain(":state :idle");
	});

	it("backgrounds a second devops program while a call holds the write gate", async () => {
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
		expect(fast.isError).not.toBe(true);
		expect(fast.content[0].text).toContain(":state :forked");

		const joined = await waitTool(tools, "j-2", "收集持锁 call 与排队的 cat。", root);
		expect(joined.isError).not.toBe(true);
		const rest = await waitTool(tools, "j-3", "收集另一个后台任务。", root);
		expect(rest.isError).not.toBe(true);
		const combined = `${joined.content[0].text}\n${rest.content[0].text}`;
		expect(combined).toContain("slow-done");
		expect(combined).toContain("fast-done");
	});

	it("pipes unpark :value into call stdin and delivers non-overlapping stdout/stderr deltas across parks", async () => {
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

	it("auto-backgrounds worker write when W is held by a slow call instead of hanging", async () => {
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
		expect(j1.isError).not.toBe(true);
		const j2 = await waitTool(tools, "j-w2", "收集第二个完成的任务。", root);
		const combined = `${j1.content[0].text}\n${j2.content[0].text}`;
		expect(combined).toContain("held-done");
		expect(readFileSync(join(root, "queued.txt"), "utf8")).toBe("queued-ok");
	});
	it("queues concurrent call and worker write on W instead of failing with BOARD_CONFLICT", async () => {
		const { tools } = fakeHost({ baseWaitMs: 0 });
		const [cRes, wRes] = await Promise.all([
			forkTool(
				tools,
				"clj_devops",
				"mix-call",
				{ name: "mix-c", code: `(call {:argv ["sh" "-c" "sleep 0.15 && printf mixed-ok"]})` },
				root,
			),
			forkTool(
				tools,
				"clj_devops",
				"mix-write",
				{ name: "mix-w", code: `(write {:path "mixed.txt" :content "w-ok"})` },
				root,
			),
		]);
		expect(cRes.isError).not.toBe(true);
		expect(wRes.isError).not.toBe(true);
		const parts = [];
		if (!wRes.content[0].text.includes(":state :forked")) {
			parts.push(wRes.content[0].text);
		}
		if (!cRes.content[0].text.includes(":state :forked")) {
			parts.push(cRes.content[0].text);
		}
		while (true) {
			const j = await waitTool(tools, `j-mix-${parts.length}`, "collect queued mixed results", root);
			expect(j.isError).not.toBe(true);
			if (j.content[0].text.includes(":state :idle")) break;
			parts.push(j.content[0].text);
		}
		const combined = parts.join("\n");
		expect(combined).toContain("mixed-ok");
		expect(readFileSync(join(root, "mixed.txt"), "utf8")).toBe("w-ok");
	});
	it("parks all running tasks on wait call-timeout and supports named unpark", async () => {
		const { tools } = fakeHost({ baseWaitMs: 0 });
		await forkTool(
			tools,
			"clj_devops",
			"long-bg-1",
			{ name: "bg-1", code: `(let [r (call {:argv ["sh" "-c" "sleep 0.25 && printf one"]})] {:got r})` },
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
				code: `(let [_ (loop [i 0 acc 0] (if (< i 30000) (recur (inc i) (+ acc i)) acc))] (call {:argv ["sh" "-c" "sleep 0.02 && printf ok"]}))`,
			},
			root,
		);
		expect(forked.content[0].text).toContain(":state :forked");

		const res = await waitTool(tools, "j-cpu", "x", root);
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain(":state :completed");
		expect(res.content[0].text).toContain("ok");
	});

	it("runs bare REPL input without name", async () => {
		const { tools } = fakeHost();
		const result = await callTool(
			tools,
			"clj_devops",
			"repl",
			{
				code: `(write {:path "repl.txt" :content "ok"})`,
			},
			root,
		);
		expect(result.isError).not.toBe(true);
		expect(readFileSync(join(root, "repl.txt"), "utf8")).toBe("ok");
	});

	it("allows outside-root, blind, and AGENTS.md writes", async () => {
		const { tools } = fakeHost();
		const outside = join(root, "..", `clj-outside-${Date.now()}.txt`);
		const outsideCode = `(write {:path ${JSON.stringify(outside)} :content "outside"})`;
		const outsideResult = await callTool(tools, "clj_devops", "outside", { code: outsideCode }, root);
		expect(outsideResult.isError).not.toBe(true);
		expect(readFileSync(outside, "utf8")).toBe("outside");
		rmSync(outside, { force: true });

		writeFileSync(join(root, "blind.txt"), "old");
		writeFileSync(join(root, "AGENTS.md"), "old");
		const blind = await callTool(
			tools,
			"clj_devops",
			"blind",
			{
				code: `(write {:path "blind.txt" :content "new"})\n(write {:path "AGENTS.md" :content "new"})`,
			},
			root,
		);
		expect(blind.isError).not.toBe(true);
		expect(readFileSync(join(root, "blind.txt"), "utf8")).toBe("new");
		expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("new");
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
		expect(result.isError).not.toBe(true);
		expect(text).toContain(":argc 3");
		expect(text).toContain(':stdout "a|b"');
	});

	it("rejects the removed command string API", async () => {
		const { tools } = fakeHost();
		const result = await callTool(
			tools,
			"clj_devops",
			"command",
			{
				name: "command",
				code: `(call {:command "printf hi"})`,
			},
			root,
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(":INVALID_ARGUMENT");
		expect(result.content[0].text).toContain("argv");
	});

	it("reads a file through the default devops tool", async () => {
		writeFileSync(join(root, "package.json"), "{}");
		const { tools } = fakeHost();
		const result = await callTool(
			tools,
			"clj_devops",
			"readonly",
			{
				name: "readonly",
				code: `(cat {:path "package.json"})`,
			},
			root,
		);
		expect(result.isError).not.toBe(true);
		expect(result.content[0].text).toContain(":state :completed");
		expect(result.content[0].text).toContain(":value \"{}\"");
	});

	it("worker reads, writes, and commits through the protected VFS", async () => {
		writeFileSync(join(root, "input.txt"), "hello\n");
		const { tools } = fakeHost();
		const result = await callTool(
			tools,
			"clj_devops",
			"write-1",
			{
				name: "write-probe",
				code: `(let [src (cat {:path "input.txt"})]
     (write {:path "output.txt" :content (str src "!")}))`,
			},
			root,
		);

		const text = result.content[0].text;
		expect(result.isError).not.toBe(true);
		expect(text).toContain(":state :completed");
		expect(text).toContain(":status :applied");
		expect(readFileSync(join(root, "output.txt"), "utf8")).toBe("hello\n!");
	});

	it("reports virtual file and directory types in stat", async () => {
		const { tools } = fakeHost();
		const file = await callTool(
			tools,
			"clj_devops",
			"stat-file",
			{
				name: "stat-file",
				code: `(let [_ (mkdir {:path "d"})
         _ (write {:path "d/f" :content "hi"})
         s (stat {:path "d/f"})
         _ (rm {:path "d/f"})
         _ (rm {:path "d"})]
     s)`,
			},
			root,
		);
		expect(file.content[0].text).toContain(":is-file true");
		expect(file.content[0].text).toContain(":is-dir false");

		const dir = await callTool(
			tools,
			"clj_devops",
			"stat-dir",
			{
				name: "stat-dir",
				code: `(let [_ (mkdir {:path "d"})
         s (stat {:path "d"})
         _ (rm {:path "d"})]
     s)`,
			},
			root,
		);
		expect(dir.content[0].text).toContain(":is-dir true");
		expect(dir.content[0].text).toContain(":is-file false");
	});

	it("runs a devops call with the sanitized environment", async () => {
		const previous = process.env.BUN_OPTIONS;
		process.env.BUN_OPTIONS = "--preload /tmp/host-hook.js";
		try {
			const { tools } = fakeHost();
			const result = await callTool(
				tools,
				"clj_devops",
				"short-call",
				{
					name: "short-call",
					code: `(call {:argv ["env"]})`,
				},
				root,
			);
			const text = result.content[0].text;
			expect(result.isError).not.toBe(true);
			expect(text).toContain(":state :completed");
			expect(text).not.toContain("host-hook");
		} finally {
			if (previous === undefined) delete process.env.BUN_OPTIONS;
			else process.env.BUN_OPTIONS = previous;
		}
	});

	it("dedupes written paths in the commit receipt", async () => {
		const { tools } = fakeHost();
		const result = await callTool(
			tools,
			"clj_devops",
			"dedupe",
			{
				name: "dedupe",
				code: `(let [_ (mkdir {:path "d"})
         _ (write {:path "d/f" :content "one"})
         _ (cat {:path "d/f"})
         _ (write {:path "d/f" :content "two"})
         _ (stat {:path "d"})
         _ (cat {:path "d/f"})
         _ (rm {:path "d/f"})
         _ (stat {:path "d"})
         _ (rm {:path "d"})]
     {:ok true})`,
			},
			root,
		);
		const text = result.content[0].text;
		const written = text.match(/:written \[([\s\S]*?)\]/)?.[1] ?? "";
		expect((written.match(/\/f"/g) ?? []).length).toBe(1);
	});

	it("parks ambiguous where and resumes the whole continuation", async () => {
		writeFileSync(join(root, "multi.txt"), "x\nx\n");
		const { tools } = fakeHost();

		const parked = await callTool(
			tools,
			"clj_devops",
			"park-1",
			{
				name: "slice",
				code: `(let [src (cat {:path "multi.txt"})
         [b e] (where {:content src :needle "x"})]
     (write {:path "sliced.txt" :content (str (subs src 0 b) "X" (subs src e))}))`,
			},
			root,
		);
		expect(parked.content[0].text).toContain(":state :parked");
		expect(parked.content[0].text).toContain(":where-ambiguous");

		const resumed = await callTool(
			tools,
			"clj_devops",
			"park-2",
			{
				name: "resume",
				code: `(unpark {:name "slice" :value [0 1]})`,
			},
			root,
		);
		expect(resumed.isError).not.toBe(true);
		expect(readFileSync(join(root, "sliced.txt"), "utf8")).toBe("X\nx\n");
	});

	it("always injects language requirement in context tail even when nothing is parked", async () => {
		const { hooks } = fakeHost();
		const ctxHandler = hooks.get("context")[0];
		const out = await ctxHandler({ messages: [{ role: "user", content: "hi" }] }, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
		expect(out.messages).toHaveLength(2);
		expect(out.messages[1].role).toBe("user");
		const tailText = out.messages[1].content[0].text;
		expect(tailText).toContain('<skill version="1.0">');
		expect(tailText).toContain("简体中文");
		expect(tailText).not.toContain("<UNDECIDED-PARKED-PROGRAMS>");
	});
	it("abandons parked programs cleanly and reminds LLM of undecided parked programs in context hook", async () => {
		const { tools, hooks } = fakeHost();
		const parked = await callTool(
			tools,
			"clj_devops",
			"ab-1",
			{
				name: "abandoned-job",
				code: `(let [_ (write {:path "should-not-exist.txt" :content "nope"})] (park {:payload "waiting"}))`,
			},
			root,
		);
		expect(parked.content[0].text).toContain(":state :parked");

		const ctxHandler = hooks.get("context")[0];
		const withParked = await ctxHandler({ messages: [{ role: "user", content: "hi" }] }, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
		expect(withParked?.messages?.length).toBe(2);
		expect(withParked.messages[1].role).toBe("user");
		const blocks = withParked.messages[1].content;
		expect(blocks[0].text).toContain('<skill version="1.0">');
		expect(blocks[1].text).toContain("<UNDECIDED-PARKED-PROGRAMS>");
		expect(blocks[1].text).toContain("clj_devops: abandoned-job");

		const abandoned = await callTool(
			tools,
			"clj_devops",
			"ab-2",
			{ name: "abandon-caller", code: `(abandon {:name "abandoned-job"})` },
			root,
		);
		expect(abandoned.isError).not.toBe(true);
		expect(abandoned.content[0].text).toContain(":abandoned true");
		expect(abandoned.content[0].text).toContain(":state :failed");
		expect(() => readFileSync(join(root, "should-not-exist.txt"), "utf8")).toThrow();

		const afterAbandon = await ctxHandler({ messages: [{ role: "user", content: "hi" }] }, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
		expect(afterAbandon.messages).toHaveLength(2);
		expect(afterAbandon.messages).toHaveLength(2);
		expect(afterAbandon.messages[1].content[0].text).toContain('<skill version="1.0">');
		expect(afterAbandon.messages[1].content).toHaveLength(1);
	});
	it("requires :exec/:fn on glob and runs it across the multi-core Worker pool", async () => {
		mkdirSync(join(root, "sub"), { recursive: true });
		writeFileSync(join(root, "sub", "a.mjs"), "alpha");
		writeFileSync(join(root, "sub", "b.mjs"), "beta");
		writeFileSync(join(root, "sub", "c.txt"), "gamma");
		const { tools } = fakeHost();

		const missingExec = await callTool(
			tools,
			"clj_devops",
			"glob-missing-exec",
			{ name: "glob-err", code: `(glob {:pattern "**/*.mjs" :path "sub"})` },
			root,
		);
		expect(missingExec.isError).toBe(true);
		expect(missingExec.content[0].text).toContain(":INVALID_ARGUMENT");

		const namesOnly = await callTool(
			tools,
			"clj_devops",
			"glob-names",
			{ name: "glob-id", code: `(glob {:pattern "**/*.mjs" :path "sub" :exec identity})` },
			root,
		);
		expect(namesOnly.isError).not.toBe(true);
		expect(namesOnly.content[0].text).toContain('"sub/a.mjs"');
		expect(namesOnly.content[0].text).toContain('"sub/b.mjs"');

		const res = await callTool(
			tools,
			"clj_devops",
			"glob-1",
			{
				name: "glob-cat",
				code: `(glob {:pattern "**/*.mjs" :path "sub" :exec (fn [p] [p (cat {:path p})])})`,
			},
			root,
		);
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain('["sub/a.mjs" "alpha"]');
		expect(res.content[0].text).toContain('["sub/b.mjs" "beta"]');
		expect(res.content[0].text).not.toContain("c.txt");
	});
	it("requires Ariadne budget and goal on every clj call", async () => {
		const { tools } = fakeHost();
		const res = await tools.get("clj_devops").execute("a-required", { code: "1" }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("ariadne_budget");
	});

	it("does not register plan, review, or worker on the default surface", () => {
		const { tools } = fakeHost();
		expect(tools.has("clj_plan")).toBe(false);
		expect(tools.has("clj_review")).toBe(false);
		expect(tools.has("clj_worker")).toBe(false);
		expect(tools.has("clj_devops")).toBe(true);
	});

	it("rejects a stale read-set instead of overwriting external changes", async () => {
		writeFileSync(join(root, "conflict.txt"), "x\nx\n");
		const { tools } = fakeHost();

		const parked = await callTool(
			tools,
			"clj_devops",
			"conflict-1",
			{
				name: "conflict",
				code: `(let [src (cat {:path "conflict.txt"})
         [b e] (where {:content src :needle "x"})]
     (write {:path "conflict.txt" :content (str (subs src 0 b) "X" (subs src e))}))`,
			},
			root,
		);
		expect(parked.content[0].text).toContain(":state :parked");

		writeFileSync(join(root, "conflict.txt"), "x\nx\nEXTRA\n");
		const resumed = await callTool(
			tools,
			"clj_devops",
			"conflict-2",
			{
				name: "conflict-resume",
				code: `(unpark {:name "conflict" :value [0 1]})`,
			},
			root,
		);
		expect(resumed.content[0].text).toContain(":FILE_CONFLICT");
		expect(readFileSync(join(root, "conflict.txt"), "utf8")).toBe("x\nx\nEXTRA\n");
	});
});
