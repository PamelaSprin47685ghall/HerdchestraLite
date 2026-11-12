/**
 * Dogfood tests for the clj-only surface.
 *
 * These exercise the real evaluator and VFS through the same tool objects the
 * host registers. They do not start a model, a subagent, or the mission layer.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCljToolSurface, deadlineFor, HOST_TOOL_BLACKLIST, registerCljTools } from "../src/clj-main.mjs";
import { callEnvironment, defaultRunCommand } from "../src/clj-sandbox/vfs.mjs";

function fakeHost({ active } = {}) {
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
	registerCljTools(pi, { ownerId: "clj-test" });
	return { tools, pi, hooks };
}

function callTool(tools, name, id, params, cwd) {
	return tools.get(name).execute(id, params, undefined, undefined, { cwd });
}

describe("clj-only dogfood surface", () => {
	let root;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "clj-core-test-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("registers exactly the four sandbox tools", () => {
		const { tools } = fakeHost();
		expect([...tools.keys()].sort()).toEqual(["clj_devops", "clj_plan", "clj_review", "clj_worker"]);
	});

	it("removes replaced host tools and keeps the clj surface active", async () => {
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
	});

	it("strips host-injected interpreter and shell hooks from call", async () => {
		const previous = process.env.BUN_OPTIONS;
		process.env.BUN_OPTIONS = "--preload /tmp/host-hook.js";
		try {
			expect(callEnvironment({ BUN_OPTIONS: "x", PATH: "/bin", NODE_OPTIONS: "y" })).toEqual({
				PATH: "/bin",
			});
			const result = await defaultRunCommand("printf '%s' \"$BUN_OPTIONS\"", { cwd: root, maxBytes: 1024 });
			expect(result.stdout).toBe("");
		} finally {
			if (previous === undefined) delete process.env.BUN_OPTIONS;
			else process.env.BUN_OPTIONS = previous;
		}
	});

	it("adds one second plus 50ms per intent byte", () => {
		const now = 1_000;
		expect(deadlineFor("x", now) - now).toBe(1_050);
		expect(deadlineFor("x".repeat(1_000), now) - now).toBe(51_000);
	});

	it("runs bare REPL input without program_name", async () => {
		const { tools } = fakeHost();
		const result = await callTool(
			tools,
			"clj_worker",
			"repl",
			{
				intent: "裸 REPL 输入",
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
		const outsideResult = await callTool(
			tools,
			"clj_worker",
			"outside",
			{ intent: "根目录外写入", code: outsideCode },
			root,
		);
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
				intent: "盲写并覆盖 AGENTS",
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
				program_name: "argv",
				intent: "argv 直执行",
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
				program_name: "command",
				intent: "旧 command 拒绝",
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
				program_name: "readonly",
				intent: "读取包清单",
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
				program_name: "write-probe",
				intent: "读取并写入探针文件",
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
				program_name: "stat-file",
				intent: "验证虚拟文件 stat 类型",
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
				program_name: "stat-dir",
				intent: "验证虚拟目录 stat 类型",
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

	it("runs a short-intent devops call with the sanitized environment", async () => {
		const previous = process.env.BUN_OPTIONS;
		process.env.BUN_OPTIONS = "--preload /tmp/host-hook.js";
		try {
			const { tools } = fakeHost();
			const result = await callTool(
				tools,
				"clj_devops",
				"short-call",
				{
					program_name: "short-call",
					intent: "短",
					code: `(call {:argv ["env"]})`,
				},
				root,
			);
			const text = result.content[0].text;
			expect(result.isError).not.toBe(true);
			expect(text).toContain(":state :completed");
			expect(text).toContain(':stdout ""');
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
				program_name: "dedupe",
				intent: "验证 written 去重",
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
				program_name: "slice",
				intent: "多匹配挂起探针",
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
				program_name: "resume",
				intent: "恢复挂起程序",
				code: `(unpark {:name "slice" :value [0 1]})`,
			},
			root,
		);
		expect(resumed.isError).not.toBe(true);
		expect(readFileSync(join(root, "sliced.txt"), "utf8")).toBe("X\nx\n");
	});

	it("rejects a write capability in the plan role", async () => {
		const { tools } = fakeHost();
		const result = await callTool(
			tools,
			"clj_plan",
			"deny-1",
			{
				program_name: "deny-probe",
				intent: "验证只读角色拒绝写入",
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
				program_name: "conflict",
				intent: "构造挂起以测试冲突",
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
				program_name: "conflict-resume",
				intent: "恢复并触发冲突",
				code: `(unpark {:name "conflict" :value [0 1]})`,
			},
			root,
		);
		expect(resumed.content[0].text).toContain(":FILE_CONFLICT");
		expect(readFileSync(join(root, "conflict.txt"), "utf8")).toBe("x\nx\nEXTRA\n");
	});
});
