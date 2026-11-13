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
import { readCljs, readUfss } from "../src/clj-sandbox/ufss.mjs";

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

describe("clj-only async dogfood surface (parallel shard)", () => {
	let root;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "clj-core-shard-"));
	});

	afterEach(() => {
		while (activeHosts.length > 0) activeHosts.pop().state?.terminate?.();
		rmSync(root, { recursive: true, force: true });
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
		expect(result.isError, result.content?.[0]?.text).not.toBe(true);
		expect(result.content[0].text).toContain(":state :completed");
		expect(result.content[0].text).toContain(":value \"{}\"");
	});

		it("delegates read to the captured native runner", async () => {
		writeFileSync(join(root, "native.txt"), "native-text");
		const { tools } = fakeHost();
		const result = await callTool(
			tools,
			"clj_devops",
			"native-read",
			{ name: "native-read", code: `(read {:path "native.txt"})` },
			root,
		);
		expect(result.isError, result.content?.[0]?.text).not.toBe(true);
		expect(result.content[0].text).toContain(":state :completed");
		expect(result.content[0].text).toContain(':content "native-text"');
		expect(result.content[0].text).toContain(":host true");
	});

		it("fails closed when no native runner was captured", async () => {
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
		const state = registerCljTools(pi, { ownerId: "clj-no-runner", ariadne: false });
		activeHosts.push({ state });
		const result = await callTool(
			tools,
			"clj_devops",
			"no-runner",
			{ name: "no-runner", code: `(read {:path "package.json"})` },
			root,
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("HOST_API_MISMATCH");
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
		expect(result.isError, result.content?.[0]?.text).not.toBe(true);
		expect(text).toContain(":state :completed");
		expect(readFileSync(join(root, "output.txt"), "utf8")).toBe("hello\n!");
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
			expect(result.isError, result.content?.[0]?.text).not.toBe(true);
			expect(text).toContain(":state :completed");
			expect(text).not.toContain("host-hook");
		} finally {
			if (previous === undefined) delete process.env.BUN_OPTIONS;
			else process.env.BUN_OPTIONS = previous;
		}
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

	it("clears a settled program on abandon instead of failing STALE_CONTROL", async () => {
		const { tools } = fakeHost();
		const completed = await callTool(
			tools,
			"clj_devops",
			"settled-1",
			{ name: "settled", code: "(+ 1 2)" },
			root,
		);
		expect(completed.isError).not.toBe(true);
		const cleared = await callTool(
			tools,
			"clj_devops",
			"settled-2",
			{ name: "cleanup", code: `(abandon {:name "settled"})` },
			root,
		);
		expect(cleared.isError).not.toBe(true);
		expect(cleared.content[0].text).toContain(":cleared true");
		expect(cleared.content[0].text).toContain(":state :completed");
	});

	it("retires a parked program from the live table on abandon", async () => {
		writeFileSync(join(root, "multi.txt"), "x\nx\n");
		const { tools, hooks } = fakeHost();
		const parked = await callTool(
			tools,
			"clj_devops",
			"park-abandon-1",
			{
				name: "doomed",
				code: `(let [src (cat {:path "multi.txt"})
     [b e] (where {:content src :needle "x"})]
 (write {:path "never.txt" :content src}))`,
			},
			root,
		);
		expect(parked.content[0].text).toContain(":state :parked");

		const cleared = await callTool(
			tools,
			"clj_devops",
			"park-abandon-2",
			{ name: "cleanup", code: `(abandon {:name "doomed"})` },
			root,
		);
		expect(cleared.isError).not.toBe(true);
		expect(cleared.content[0].text).toContain(":cleared true");
		expect(cleared.content[0].text).toContain(":state :failed");

		const unknown = await callTool(
			tools,
			"clj_devops",
			"park-abandon-3",
			{ name: "cleanup-2", code: `(unpark {:name "doomed" :value [0 1]})` },
			root,
		);
		expect(unknown.isError).toBe(true);
		expect(unknown.content[0].text).toContain("PROGRAM_UNKNOWN");

		const contextHandler = hooks.get("context")[0];
		const out = await contextHandler(
			{ messages: [{ role: "user", content: "hi" }] },
			{ cwd: root, sessionManager: TEST_SESSION_MANAGER },
		);
		expect(out.messages.at(-1).content.at(-1).text).not.toContain("doomed");
	});

	it("reads UFSS fences in program code and rejects Clojure reader macros in both shims", async () => {
		expect(() => readUfss("#(+ % 1)")).toThrow("Unknown # dispatch");
		expect(() => readCljs("#(+ % 1)")).toThrow("Unknown # dispatch");
		const { tools } = fakeHost();
		const result = await callTool(
			tools,
			"clj_devops",
			"cljs-hash",
			{
				name: "cljs-hash",
				code: `[(count ##"abc"##)
   (+ 1 #_2 3)]`,
			},
			root,
		);
		expect(result.isError).not.toBe(true);
		expect(result.content[0].text).toContain("[3 4]");
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
		expect(tailText).not.toContain("停靠程序未裁决");
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
		const res = await tools.get("clj_devops").execute("a-required", { name: "a-required", code: "1" }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
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
