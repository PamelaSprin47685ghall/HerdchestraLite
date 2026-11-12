/**
 * Dogfood tests for the async clj-only surface + unified join.
 *
 * These exercise the real evaluator and VFS through the same tool objects the
 * host registers. They do not start a model, a subagent, or the mission layer.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
	registerCljTools(pi, {
		ownerId: "clj-test",
		...(baseWaitMs !== undefined ? { baseWaitMs } : {}),
	});
	return { tools, pi, hooks };
}

function forkTool(tools, name, id, params, cwd) {
	return tools.get(name).execute(id, params, undefined, undefined, { cwd });
}

function joinTool(tools, id, nextIndependentWork, cwd) {
	return tools
		.get("join")
		.execute(id, { otherwise_independent_work: nextIndependentWork }, undefined, undefined, { cwd });
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
	return await joinTool(tools, `${id}-join`, nextIndependentWork, cwd);
}

describe("clj-only async dogfood surface", () => {
	let root;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "clj-core-test-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("registers the four sandbox tools and unified join", () => {
		const { tools } = fakeHost();
		expect([...tools.keys()].sort()).toEqual(["clj_devops", "clj_plan", "clj_review", "clj_worker", "join"]);
	});

	it("removes replaced host tools and keeps the clj surface + join active", async () => {
		const active = [...HOST_TOOL_BLACKLIST, "todo", "task", "web_search", "lsp", "my_custom_tool", "clj_plan"];
		const { pi } = fakeHost({ active: [...active] });
		const result = await applyCljToolSurface(pi);

		expect(result.ok).toBe(true);
		expect([...result.removed].sort()).toEqual([...HOST_TOOL_BLACKLIST].sort());
		for (const name of HOST_TOOL_BLACKLIST) expect(pi.active).not.toContain(name);
		expect(pi.active).toContain("todo");
		expect(pi.active).toContain("task");
		expect(pi.active).toContain("web_search");
		expect(pi.active).toContain("lsp");
		expect(pi.active).toContain("my_custom_tool");
		expect(pi.active).toContain("clj_worker");
		expect(pi.active).toContain("join");
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
		expect(pi.active).toContain("join");
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

	it("computes join wait duration as 1000ms plus 50ms per UTF-8 byte", () => {
		const now = 1_000;
		expect(waitMsFor("x")).toBe(1_050);
		expect(deadlineFor("x", now) - now).toBe(1_050);
		expect(deadlineFor("x".repeat(1_000), now) - now).toBe(51_000);
	});

	it("rejects intent on fork and requires otherwise_independent_work on join", async () => {
		const { tools } = fakeHost();
		const forkWithIntent = await forkTool(
			tools,
			"clj_plan",
			"bad-fork",
			{ code: "1", intent: "should be rejected" },
			root,
		);
		expect(forkWithIntent.isError).toBe(true);
		expect(forkWithIntent.content[0].text).toContain(":INVALID_ARGUMENT");

		const badJoin = await tools.get("join").execute("bad-join", {}, undefined, undefined, { cwd: root });
		expect(badJoin.isError).toBe(true);
		expect(badJoin.content[0].text).toContain(":INVALID_ARGUMENT");
	});

	it("applies barrier semantics when join is called concurrently in the same batch as a call", async () => {
		const { tools } = fakeHost();
		const [forked, joined] = await Promise.all([
			forkTool(
				tools,
				"clj_devops",
				"conc-1",
				{ name: "conc-job", code: `(call {:argv ["printf" "barrier-ok"]})` },
				root,
			),
			joinTool(tools, "conc-join", "等待同一并发批次中刚派发的 call 任务完成。", root),
		]);
		expect(forked.isError).not.toBe(true);
		expect(forked.content[0].text).toContain(":state :forked");
		expect(joined.isError).not.toBe(true);
		expect(joined.content[0].text).toContain("barrier-ok");
	});
	it("returns :idle immediately from join when no tasks exist", async () => {
		const { tools } = fakeHost();
		const started = Date.now();
		const res = await joinTool(tools, "idle-1", "无事可做时立即返回。", root);
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain(":state :idle");
		expect(Date.now() - started).toBeLessThan(200);
	});

	it("returns synchronously when no call is executed, even if call appears in an untaken branch", async () => {
		const { tools } = fakeHost();
		const plan = await forkTool(tools, "clj_plan", "sync-1", { name: "p-sync", code: "(+ 1 2)" }, root);
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
		const { tools } = fakeHost();
		const f1 = await forkTool(tools, "clj_devops", "b1", { name: "p1", code: `(call {:argv ["printf" "one"]})` }, root);
		const f2 = await forkTool(tools, "clj_devops", "b2", { name: "p2", code: `(call {:argv ["printf" "two"]})` }, root);
		expect(f1.content[0].text).toContain(":state :forked");
		expect(f2.content[0].text).toContain(":state :forked");

		// Allow both background calls to settle into backlog.
		await new Promise((r) => setTimeout(r, 120));

		const joined = await joinTool(tools, "j-backlog", "先收集积压结果，再决定下一批独立派发。", root);
		expect(joined.isError).not.toBe(true);
		const text = joined.content[0].text;
		expect(text).toContain("; joined: clj_devops p1");
		expect(text).toContain("; joined: clj_devops p2");
		expect(text).toContain("one");
		expect(text).toContain("two");

		const next = await joinTool(tools, "j-empty", "确认积压已清空。", root);
		expect(next.content[0].text).toContain(":state :idle");
	});

	it("runs non-call tools synchronously while a call task runs in background, then joins the call", async () => {
		const { tools } = fakeHost();
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
			"clj_plan",
			"fast",
			{ name: "fast-job", code: `(cat {:path "fast.txt"})` },
			root,
		);
		expect(fast.isError).not.toBe(true);
		expect(fast.content[0].text).toContain(":state :completed");
		expect(fast.content[0].text).toContain("fast-done");

		const second = await joinTool(tools, "j-2", "收集仍在后台运行的慢任务结果。", root);
		expect(second.isError).not.toBe(true);
		expect(second.content[0].text).toContain("; joined: clj_devops slow-job");
		expect(second.content[0].text).toContain("slow-done");
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
		const p1 = await joinTool(tools, "j-p1", "x", root);
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
			? await joinTool(tools, "j-p2", "wait for stdin echo", root)
			: resumed;
		expect(finalRes.isError).not.toBe(true);
		const finalText = finalRes.content[0].text;
		expect(finalText).toContain(":state :completed");
		expect(finalText).toContain("p2:from-kbd");
		expect(finalText.split(":stdout")[1]).not.toContain("p1");
	});

	it("auto-backgrounds worker write when W is held by a slow call instead of hanging", async () => {
		const { tools } = fakeHost();
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
			"clj_worker",
			"wait-w",
			{ name: "wait-w", code: `(write {:path "queued.txt" :content "queued-ok"})` },
			root,
		);
		expect(Date.now() - started).toBeLessThan(100);
		expect(workerFork.content[0].text).toContain(":state :forked");

		const j1 = await joinTool(tools, "j-w1", "等待持有 W 锁的 call 与排队的 worker write 完成。", root);
		expect(j1.isError).not.toBe(true);
		const j2 = await joinTool(tools, "j-w2", "收集第二个完成的任务。", root);
		const combined = `${j1.content[0].text}\n${j2.content[0].text}`;
		expect(combined).toContain("held-done");
		expect(readFileSync(join(root, "queued.txt"), "utf8")).toBe("queued-ok");
	});
	it("queues concurrent call and worker write on W instead of failing with BOARD_CONFLICT", async () => {
		const { tools } = fakeHost();
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
				"clj_worker",
				"mix-write",
				{ name: "mix-w", code: `(write {:path "mixed.txt" :content "w-ok"})` },
				root,
			),
		]);
		expect(cRes.isError).not.toBe(true);
		expect(wRes.isError).not.toBe(true);
		const wFinal = wRes.content[0].text.includes(":state :forked")
			? await joinTool(tools, "j-w", "collect queued worker write", root)
			: wRes;
		expect(wFinal.isError).not.toBe(true);
		expect(readFileSync(join(root, "mixed.txt"), "utf8")).toBe("w-ok");

		const cFinal = cRes.content[0].text.includes(":state :forked")
			? await joinTool(tools, "j-c", "collect mixed call result", root)
			: cRes;
		expect(cFinal.isError).not.toBe(true);
		expect(cFinal.content[0].text).toContain("mixed-ok");
	});
	it("parks all running tasks on join call-timeout and supports named unpark", async () => {
		const { tools } = fakeHost({ baseWaitMs: 0 });
		await forkTool(
			tools,
			"clj_devops",
			"long-bg-1",
			{ name: "bg-1", code: `(let [r (call {:argv ["sh" "-c" "sleep 0.25 && printf one"]})] {:got r})` },
			root,
		);
		const parked = await joinTool(tools, "j-short", "x", root);
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

	it("does not count sandbox engine evaluation time toward join call timeout", async () => {
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

		const res = await joinTool(tools, "j-cpu", "x", root);
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain(":state :completed");
		expect(res.content[0].text).toContain("ok");
	});

	it("runs bare REPL input without name", async () => {
		const { tools } = fakeHost();
		const result = await callTool(
			tools,
			"clj_worker",
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
		const outsideResult = await callTool(tools, "clj_worker", "outside", { code: outsideCode }, root);
		expect(outsideResult.isError).not.toBe(true);
		expect(readFileSync(outside, "utf8")).toBe("outside");
		rmSync(outside, { force: true });

		writeFileSync(join(root, "blind.txt"), "old");
		writeFileSync(join(root, "AGENTS.md"), "old");
		const blind = await callTool(
			tools,
			"clj_worker",
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

	it("does not create control directories for read-only tools", async () => {
		writeFileSync(join(root, "package.json"), "{}");
		const { tools } = fakeHost();
		const result = await callTool(
			tools,
			"clj_plan",
			"readonly",
			{
				name: "readonly",
				code: `(cat {:path "package.json"})`,
			},
			root,
		);
		expect(result.isError).not.toBe(true);
		expect(existsSync(join(root, ".herd"))).toBe(false);
	});

	it("worker reads, writes, and commits through the protected VFS", async () => {
		writeFileSync(join(root, "input.txt"), "hello\n");
		const { tools } = fakeHost();
		const result = await callTool(
			tools,
			"clj_worker",
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
			"clj_worker",
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
			"clj_worker",
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
			"clj_worker",
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
			"clj_worker",
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
			"clj_worker",
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

	it("abandons parked programs cleanly and reminds LLM of undecided parked programs in context hook", async () => {
		const { tools, hooks } = fakeHost();
		const parked = await callTool(
			tools,
			"clj_worker",
			"ab-1",
			{
				name: "abandoned-job",
				code: `(let [_ (write {:path "should-not-exist.txt" :content "nope"})] (park {:payload "waiting"}))`,
			},
			root,
		);
		expect(parked.content[0].text).toContain(":state :parked");

		const ctxHandler = hooks.get("context")[0];
		const withParked = await ctxHandler({ messages: [{ role: "user", content: "hi" }] }, { cwd: root });
		expect(withParked?.messages?.length).toBe(2);
		const reminderText = withParked.messages[1].content[0].text;
		expect(withParked.messages[1].role).toBe("user");
		expect(reminderText).toContain("<UNDECIDED-PARKED-PROGRAMS>");
		expect(reminderText).toContain("clj_worker: abandoned-job");

		const abandoned = await callTool(
			tools,
			"clj_worker",
			"ab-2",
			{ name: "abandon-caller", code: `(abandon {:name "abandoned-job"})` },
			root,
		);
		expect(abandoned.isError).not.toBe(true);
		expect(abandoned.content[0].text).toContain(":abandoned true");
		expect(abandoned.content[0].text).toContain(":state :failed");
		expect(() => readFileSync(join(root, "should-not-exist.txt"), "utf8")).toThrow();

		const afterAbandon = await ctxHandler({ messages: [{ role: "user", content: "hi" }] }, { cwd: root });
		expect(afterAbandon).toBeUndefined();
	});
	it("rejects a write capability in the plan role", async () => {
		const { tools } = fakeHost();
		const result = await callTool(
			tools,
			"clj_plan",
			"deny-1",
			{
				name: "deny-probe",
				code: `(write {:path "forbidden.txt" :content "no"})`,
			},
			root,
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(":CAPABILITY_DENIED");
		expect(() => readFileSync(join(root, "forbidden.txt"), "utf8")).toThrow();
	});

	it("rejects a stale read-set instead of overwriting external changes", async () => {
		writeFileSync(join(root, "conflict.txt"), "x\nx\n");
		const { tools } = fakeHost();

		const parked = await callTool(
			tools,
			"clj_worker",
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
			"clj_worker",
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
