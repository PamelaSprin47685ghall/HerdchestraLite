import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createSandboxSession } from "../src/clj-sandbox/evaluator.mjs";
import { buildSandboxTools, CAPABILITY_MATRIX, describeSandboxTool } from "../src/clj-sandbox/tools.mjs";
import { EdnKeyword, readUfss } from "../src/clj-sandbox/ufss.mjs";
import { defaultRunCommand } from "../src/clj-sandbox/vfs.mjs";
import { writeFileAtomic } from "../src/util/atomic-write.mjs";

function testSandboxIo() {
	return {
		lstat(path) {
			try {
				return lstatSync(path, { bigint: true });
			} catch (error) {
				if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
				throw error;
			}
		},
		readFile: readFileSync,
		readdir: readdirSync,
		realpath: realpathSync,
		mkdir: mkdirSync,
		rmdir: rmdirSync,
		unlink: unlinkSync,
		writeFileAtomic,
		runCommand: defaultRunCommand,
	};
}

const roots = [];
const HAS_SETSID = spawnSync("sh", ["-c", "command -v setsid"], { encoding: "utf8" }).status === 0;

function sandbox(prefix = "herd-tools-") {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function file(root, name, content = "") {
	const target = join(root, name);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content, "utf8");
	return target;
}

function caught(run) {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw");
}

function field(map, name) {
	if (!(map instanceof Map)) {
		return undefined;
	}
	for (const [key, value] of map) {
		if (key instanceof EdnKeyword && key.name === name) {
			return value;
		}
	}
	return undefined;
}

function keywordName(value) {
	return value instanceof EdnKeyword ? value.name : undefined;
}

function parseResult(result) {
	return readUfss(result.content[0].text);
}

function meta(intentBytes = 256, deadlineAt = Date.now() + 120_000) {
	return { intentBytes, deadlineAt };
}

function makePorts(options = {}) {
	const events = options.events ?? [];
	return {
		events,
		termId: "term-1",
		writeGate: {
			async runExclusive(run) {
				events.push("gate:acquire");
				try {
					return await run();
				} finally {
					events.push("gate:release");
				}
			},
		},
		control: {
			markApplying() {
				events.push("control:applying");
				return { ok: true };
			},
			markRunning() {
				events.push("control:running");
				return { ok: true };
			},
			publishResult() {
				events.push("control:publish");
				return { ok: true };
			},
			markUncertain() {
				events.push("control:uncertain");
				return { ok: true };
			},
		},
		identity: { agent_id: "agent-1", life_state: "alive" },
		claim: { claim_id: "claim-1", status: "active" },
		callMeta: {
			read() {
				return options.meta ?? meta();
			},
		},
	};
}

async function runTool(bundle, params, options = {}) {
	const result = await bundle.tool.execute(options.callId ?? randomCallId(), params, options.signal, undefined, {});
	return { result, receipt: parseResult(result) };
}

let callSequence = 0;
function randomCallId() {
	callSequence += 1;
	return `call-${callSequence}`;
}

afterEach(() => {
	while (roots.length > 0) {
		rmSync(roots.pop(), { recursive: true, force: true });
	}
});

describe("capability matrix", () => {
	it("matches AGENTS.md §4.2 for all six roles", () => {
		expect(Object.keys(CAPABILITY_MATRIX)).toEqual(["plan", "devops", "review", "worker", "holder", "auditor"]);
		expect([...CAPABILITY_MATRIX.plan]).toEqual(["cat", "where", "whereAll", "park", "unpark", "abandon"]);
		expect([...CAPABILITY_MATRIX.devops]).toEqual([...CAPABILITY_MATRIX.worker, "call"]);
		expect([...CAPABILITY_MATRIX.review]).toEqual([
			"cat",
			"stat",
			"ls",
			"glob",
			"where",
			"whereAll",
			"unpark",
			"abandon",
		]);
		expect([...CAPABILITY_MATRIX.worker]).toEqual([
			"cat",
			"stat",
			"ls",
			"glob",
			"write",
			"mkdir",
			"rm",
			"mv",
			"where",
			"whereAll",
			"park",
			"unpark",
			"abandon",
		]);
		expect(CAPABILITY_MATRIX.worker).not.toContain("call");
		expect([...CAPABILITY_MATRIX.holder]).toEqual([...CAPABILITY_MATRIX.worker, "call"]);
		expect([...CAPABILITY_MATRIX.auditor]).toEqual([...CAPABILITY_MATRIX.worker, "call"]);
		expect(Object.isFrozen(CAPABILITY_MATRIX)).toBe(true);
		expect(Object.isFrozen(CAPABILITY_MATRIX.worker)).toBe(true);
	});

	it("rejects an unknown role at assembly", () => {
		const root = sandbox();
		const error = caught(() => buildSandboxTools({ role: "coordinator", roots: { writeRoot: root } }));
		expect(error.code).toBe(":INVALID_ARGUMENT");
	});

	it("normalizes the host display names", () => {
		const root = sandbox();
		expect(buildSandboxTools({ role: "Swarm Worker", roots: { writeRoot: root }, ports: makePorts() }).toolName).toBe(
			"clj_worker",
		);
		expect(buildSandboxTools({ role: "Reviewer", roots: { writeRoot: root }, ports: makePorts() }).toolName).toBe(
			"clj_review",
		);
		expect(buildSandboxTools({ role: "Plan DevOps", roots: { writeRoot: root }, ports: makePorts() }).toolName).toBe(
			"clj_devops",
		);
	});

	it("rejects an auditor without evidence and tmp roots at assembly", () => {
		const root = sandbox();
		const error = caught(() =>
			buildSandboxTools({
				role: "auditor",
				roots: { writeRoot: root },
				ports: makePorts(),
			}),
		);
		expect(error.code).toBe(":INVALID_ARGUMENT");
	});

	it("exposes the host tool shape for each role", () => {
		const root = sandbox();
		const expected = {
			plan: "clj_plan",
			devops: "clj_devops",
			review: "clj_review",
			worker: "clj_worker",
			holder: "clj_worker",
			auditor: "clj_auditor",
		};
		for (const [role, toolName] of Object.entries(expected)) {
			const options = {
				role,
				roots: { writeRoot: root },
				ports: makePorts(),
			};
			if (role === "auditor") {
				options.roots = {
					writeRoot: root,
					evidenceRoot: join(root, "evidence"),
					auditTmp: join(root, "audit-tmp"),
					callLogDir: join(root, "logs"),
				};
				mkdirSync(options.roots.evidenceRoot, { recursive: true });
				mkdirSync(options.roots.auditTmp, { recursive: true });
			}
			const bundle = buildSandboxTools(options);
			expect(bundle.tool.name).toBe(toolName);
			expect(bundle.toolName).toBe(toolName);
			expect(bundle.tools).toEqual([bundle.tool]);
			expect(typeof bundle.execute).toBe("function");
			expect(bundle.tool.parameters.required).toEqual(["code", "intent"]);
			expect(Object.keys(bundle.tool.parameters.properties)).toEqual(["name", "code", "intent"]);
		}
	});

	it("configures an injected fresh session and refuses to reuse it", async () => {
		const root = sandbox();
		const session = createSandboxSession();
		const bundle = buildSandboxTools({
			role: "worker",
			session,
			roots: { writeRoot: root },
			ports: makePorts(),
		});
		expect(bundle.session).toBe(session);
		const { receipt } = await runTool(bundle, {
			name: "p",
			code: "1",
		});
		expect(keywordName(field(receipt, "state"))).toBe("completed");
		const error = caught(() =>
			buildSandboxTools({
				role: "worker",
				session,
				roots: { writeRoot: root },
				ports: makePorts(),
			}),
		);
		expect(error.code).toBe(":INVALID_ARGUMENT");
	});

	it("surfaces live abandoned capabilities for the same program name", async () => {
		const root = sandbox();
		const session = createSandboxSession();
		session.abandoned.set("p", [
			{
				capability: "slow",
				argument: { path: "x" },
				settled: true,
				result: "late-result",
				error: null,
				abandoned: true,
				outcome: "outcome-unknown",
			},
		]);
		const bundle = buildSandboxTools({
			role: "worker",
			session,
			roots: { writeRoot: root },
			ports: makePorts(),
		});
		const { receipt } = await runTool(bundle, {
			name: "p",
			code: "1",
		});
		expect(keywordName(field(receipt, "state"))).toBe("completed");
		const abandoned = field(receipt, "abandoned-capabilities");
		const entries = Array.isArray(abandoned) ? abandoned : [...abandoned];
		expect(entries.length).toBe(1);
		expect(field(entries[0], "capability")).toBe("slow");
		expect(field(entries[0], "settled")).toBe(true);
		expect(field(entries[0], "result")).toBe("late-result");
		expect(keywordName(field(entries[0], "status"))).toBe("outcome-unknown");
	});

	it("publishes per-tool descriptions that name the denied capabilities", () => {
		const plan = describeSandboxTool("clj_plan");
		expect(plan).toContain("Bound capabilities: cat, where, whereAll, park, unpark");
		expect(plan).toContain("No stat, ls, write, mkdir, rm, mv, or call");

		const review = describeSandboxTool("clj_review");
		expect(review).toContain("No write, mkdir, rm, mv, call, or park");

		const devops = describeSandboxTool("clj_devops");
		expect(devops).toContain("Privileged worker");
		expect(devops).toContain("No token required");
		expect(devops).not.toContain("best-effort read-only");

		const worker = describeSandboxTool("clj_worker");
		expect(worker).toContain(":TOKEN_REQUIRED");
		expect(worker).toContain("Swarm Holder session grants call");

		const auditor = describeSandboxTool("clj_auditor");
		expect(auditor).toContain("plans/<slug>/evidence/<case_id>/");
		expect(auditor).toContain("dedicated /tmp audit root");

		expect(() => describeSandboxTool("clj_nope")).toThrow();
	});
});

describe("CallMeta and parameters", () => {
	it("fails closed when CallMeta is missing", async () => {
		const root = sandbox();
		const bundle = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports: { callMeta: { read: () => undefined } },
		});
		const { result, receipt } = await runTool(bundle, {
			name: "p",
			code: "1",
		});

		expect(result.isError).toBe(true);
		expect(keywordName(field(field(receipt, "error"), "code"))).toBe("INTENT_REQUIRED");
	});

	it("accepts a CallMeta reader function, as main supplies", async () => {
		const root = sandbox();
		const bundle = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports: { callMeta: () => meta() },
		});
		const { receipt } = await runTool(bundle, {
			name: "p",
			code: "7",
		});

		expect(keywordName(field(receipt, "state"))).toBe("completed");
		expect(field(receipt, "value")).toBe(7);
	});

	it("serializes concurrent same-agent tool calls instead of rejecting one", async () => {
		const root = sandbox();
		const bundle = buildSandboxTools({
			role: "devops",
			roots: { writeRoot: root },
			ports: makePorts(),
		});
		const [first, second] = await Promise.all([
			runTool(bundle, { name: "p1", code: "1" }),
			runTool(bundle, { name: "p2", code: "2" }),
		]);
		expect(first.result.isError).not.toBe(true);
		expect(second.result.isError).not.toBe(true);
		expect(keywordName(field(first.receipt, "state"))).toBe("completed");
		expect(keywordName(field(second.receipt, "state"))).toBe("completed");
		expect(field(first.receipt, "value")).toBe(1);
		expect(field(second.receipt, "value")).toBe(2);
		for (const entry of [first, second]) {
			expect(entry.result.content[0].text).not.toContain("concurrent sandbox tool execution");
		}
	});

	it("continues the queued same-agent call after an earlier program failure", async () => {
		const root = sandbox();
		const bundle = buildSandboxTools({
			role: "devops",
			roots: { writeRoot: root },
			ports: makePorts(),
		});
		const [bad, good] = await Promise.all([
			runTool(bundle, { name: "bad", code: "(where)" }),
			runTool(bundle, { name: "good", code: "2" }),
		]);
		expect(keywordName(field(bad.receipt, "state"))).toBe("failed");
		expect(bad.result.isError).toBe(true);
		expect(keywordName(field(good.receipt, "state"))).toBe("completed");
		expect(field(good.receipt, "value")).toBe(2);
	});

	it("marks a failed program receipt as a tool error", async () => {
		const root = sandbox();
		const bundle = buildSandboxTools({
			role: "devops",
			roots: { writeRoot: root },
			ports: makePorts(),
		});
		const { result, receipt } = await runTool(bundle, {
			name: "p",
			code: "(where)",
		});

		expect(keywordName(field(receipt, "state"))).toBe("failed");
		expect(keywordName(field(field(receipt, "error"), "code"))).toBe("INVALID_ARGUMENT");
		expect(result.isError).toBe(true);
		expect(result.details.code).toBe(":INVALID_ARGUMENT");
		// The rendered receipt is unchanged; only the host tool status changes.
		expect(parseResult(result)).toEqual(receipt);
	});

	it("rejects a gate field that was not stripped", async () => {
		const root = sandbox();
		const bundle = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports: makePorts(),
		});
		const { result, receipt } = await runTool(bundle, {
			name: "p",
			code: "1",
			intent: "leaked",
		});

		expect(result.isError).toBe(true);
		expect(keywordName(field(field(receipt, "error"), "code"))).toBe("INVALID_ARGUMENT");
	});

	it("rejects unknown fields and missing program data", async () => {
		const root = sandbox();
		const bundle = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports: makePorts(),
		});
		for (const params of [null, { name: "p" }, { name: "p", code: "1", extra: true }, { name: "", code: "1" }]) {
			const { result } = await runTool(bundle, params);
			expect(result.isError).toBe(true);
		}
	});

	it("parks at the CallMeta deadline before touching disk", async () => {
		const root = sandbox();
		const target = file(root, "a.txt", "old");
		const bundle = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports: makePorts({ meta: { deadlineAt: Date.now() - 1 } }),
		});
		const { receipt } = await runTool(bundle, {
			name: "p",
			code: '(write {:path "a.txt" :content "new"})',
		});

		expect(keywordName(field(receipt, "state"))).toBe("parked");
		expect(keywordName(field(receipt, "reason"))).toBe("deadline");
		expect(readFileSync(target, "utf8")).toBe("old");
	});
});

describe("role capability boundaries", () => {
	it("Plan reads the contract root and cannot write, stat, ls, or call", async () => {
		const root = sandbox();
		file(root, "s1.md", "contract");
		const bundle = buildSandboxTools({
			role: "plan",
			roots: { writeRoot: root },
			ports: makePorts(),
		});

		const cat = await runTool(bundle, {
			name: "catp",
			code: '(cat {:path "s1.md"})',
		});
		expect(keywordName(field(cat.receipt, "state"))).toBe("completed");
		expect(field(cat.receipt, "value")).toBe("contract");

		for (const [name, code] of [
			["w", '(write {:path "x" :content "y"})'],
			["s", '(stat {:path "s1.md"})'],
			["l", '(ls {:path "."})'],
			["c", '(call {:argv ["true"]})'],
		]) {
			const { receipt } = await runTool(bundle, { name: name, code });
			expect(keywordName(field(field(receipt, "error"), "code"))).toBe("CAPABILITY_DENIED");
		}
	});

	it("Plan read-only completion needs no write gate", async () => {
		const root = sandbox();
		file(root, "s1.md", "contract");
		const bundle = buildSandboxTools({
			role: "plan",
			roots: { writeRoot: root },
			ports: { callMeta: { read: () => meta() } },
		});
		const { receipt } = await runTool(bundle, {
			name: "p",
			code: '(cat {:path "s1.md"})',
		});

		expect(keywordName(field(receipt, "state"))).toBe("completed");
		expect(field(receipt, "value")).toBe("contract");
	});

	it("Plan reads the frozen CASE dataset path", async () => {
		const root = sandbox();
		const planRoot = join(root, "plans", "demo");
		mkdirSync(planRoot, { recursive: true });
		file(root, ".herd/missions/demo/cases.edn", '[{:case_id "CASE-1"}]');
		const bundle = buildSandboxTools({
			role: "plan",
			roots: { writeRoot: planRoot },
			ports: makePorts(),
		});
		const { receipt } = await runTool(bundle, {
			name: "cases",
			code: '(cat {:path ".herd/missions/demo/cases.edn"})',
		});
		expect(keywordName(field(receipt, "state"))).toBe("completed");
		expect(field(receipt, "value")).toBe('[{:case_id "CASE-1"}]');
	});

	it("Reviewer is read-only and cannot park", async () => {
		const root = sandbox();
		file(root, "a.txt", "alpha");
		const bundle = buildSandboxTools({
			role: "review",
			roots: { writeRoot: root },
			ports: makePorts(),
		});

		const stat = await runTool(bundle, {
			name: "s",
			code: '(stat {:path "a.txt"})',
		});
		expect(keywordName(field(stat.receipt, "state"))).toBe("completed");
		expect(field(field(stat.receipt, "value"), "exists")).toBe(true);
		expect(field(field(stat.receipt, "value"), "is-dir")).toBe(false);

		for (const [name, code, capability] of [
			["w", '(write {:path "a.txt" :content "x"})', "write"],
			["c", '(call {:argv ["true"]})', "call"],
			["p", "(park {:payload 1})", "park"],
		]) {
			const { receipt } = await runTool(bundle, { name: name, code });
			expect(keywordName(field(field(receipt, "error"), "code"))).toBe("CAPABILITY_DENIED");
			expect(field(field(receipt, "error"), "message")).toContain(capability);
		}
	});

	it("Worker refuses call with :TOKEN_REQUIRED and never runs the shell", async () => {
		const root = sandbox();
		const marker = join(root, "marker.txt");
		const bundle = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports: makePorts(),
		});
		const { receipt } = await runTool(bundle, {
			name: "p",
			code: `(call {:argv ["touch" ${JSON.stringify(marker)}]})`,
		});

		expect(keywordName(field(receipt, "state"))).toBe("failed");
		expect(keywordName(field(field(receipt, "error"), "code"))).toBe("TOKEN_REQUIRED");
		expect(existsSync(marker)).toBe(false);
	});

	it("DevOps can inspect, call, and write", async () => {
		const root = sandbox();
		const logs = join(root, "logs");
		file(root, "a.txt", "alpha");
		const bundle = buildSandboxTools({
			role: "devops",
			roots: { writeRoot: root, callLogDir: logs },
			ports: makePorts(),
		});

		const cat = await runTool(bundle, {
			name: "c",
			code: '(cat {:path "a.txt"})',
		});
		expect(field(cat.receipt, "value")).toBe("alpha");

		const ls = await runTool(bundle, {
			name: "l",
			code: '(ls {:path "."})',
		});
		expect(field(field(ls.receipt, "value"), "exists")).toBe(true);

		const call = await runTool(bundle, {
			name: "x",
			code: '(call {:argv ["printf", "devops"]})',
		});
		expect(field(field(call.receipt, "value"), "stdout")).toBe("devops");

		const write = await runTool(bundle, {
			name: "w",
			code: '(write {:path "a.txt" :content "x"})',
		});
		expect(write.isError).not.toBe(true);
		expect(keywordName(field(write.receipt, "state"))).toBe("completed");
	});

	it("fails closed when call has no write gate", async () => {
		const root = sandbox();
		const bundle = buildSandboxTools({
			role: "devops",
			roots: { writeRoot: root, callLogDir: join(root, "logs") },
			ports: {
				callMeta: { read: () => meta() },
				identity: { agent_id: "agent-1", status: "alive" },
				claim: { claim_id: "claim-1", status: "active" },
				control: {
					markApplying: () => ({ ok: true }),
					markRunning: () => ({ ok: true }),
					publishResult: () => ({ ok: true }),
					markUncertain: () => ({ ok: true }),
				},
			},
		});
		const { receipt } = await runTool(bundle, {
			name: "p",
			code: '(call {:argv ["true"]})',
		});

		expect(keywordName(field(receipt, "state"))).toBe("failed");
		expect(keywordName(field(field(receipt, "error"), "code"))).toBe("INVALID_ARGUMENT");
		expect(field(field(receipt, "error"), "message")).toContain("writeGate");
	});
});

describe("VFS and protected commit assembly", () => {
	it("commits staged writes under the gate and reports the VFS result", async () => {
		const root = sandbox();
		const events = [];
		const target = join(root, "a.txt");
		const bundle = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports: makePorts({ events }),
		});
		const { receipt } = await runTool(bundle, {
			name: "p",
			code: '(write {:path "a.txt" :content "hello"})',
		});

		expect(keywordName(field(receipt, "state"))).toBe("completed");
		const commit = field(receipt, "commit");
		expect(keywordName(field(commit, "status"))).toBe("applied");
		expect(field(commit, "written")).toContain(target);
		expect(readFileSync(target, "utf8")).toBe("hello");
		expect(events).toEqual(["gate:acquire", "control:applying", "control:publish", "gate:release"]);
	});

	it("fails closed when a write has no write gate", async () => {
		const root = sandbox();
		const target = join(root, "a.txt");
		const bundle = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports: {
				callMeta: { read: () => meta() },
			},
		});
		const { receipt } = await runTool(bundle, {
			name: "p",
			code: '(write {:path "a.txt" :content "hello"})',
		});

		expect(keywordName(field(receipt, "state"))).toBe("failed");
		expect(keywordName(field(field(receipt, "error"), "code"))).toBe("INVALID_ARGUMENT");
		expect(field(field(receipt, "error"), "message")).toContain("writeGate");
		expect(existsSync(target)).toBe(false);
	});

	it("rechecks a pure read under the write gate before completion", async () => {
		const root = sandbox();
		const target = file(root, "a.txt", "original");
		const ports = makePorts();
		const baseGate = ports.writeGate;
		let first = true;
		ports.writeGate = {
			async runExclusive(run) {
				if (first) {
					first = false;
					writeFileSync(target, "changed", "utf8");
				}
				return baseGate.runExclusive(run);
			},
		};
		const bundle = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports,
		});
		const { receipt } = await runTool(bundle, {
			name: "readonly",
			code: '(cat {:path "a.txt"})',
		});

		expect(keywordName(field(receipt, "state"))).toBe("failed");
		expect(keywordName(field(field(receipt, "error"), "code"))).toBe("FILE_CONFLICT");
		expect(readFileSync(target, "utf8")).toBe("changed");
	});

	it("cancels a commit that has not reached applying without writing", async () => {
		const root = sandbox();
		const target = join(root, "a.txt");
		const controller = new AbortController();
		const ports = makePorts();
		ports.writeGate = {
			async runExclusive(run) {
				controller.abort();
				return run();
			},
		};
		const bundle = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports,
		});
		const { receipt } = await runTool(
			bundle,
			{
				name: "p",
				code: '(write {:path "a.txt" :content "x"})',
			},
			{ signal: controller.signal },
		);

		expect(keywordName(field(receipt, "state"))).toBe("failed");
		expect(keywordName(field(field(receipt, "error"), "code"))).toBe("UPSTREAM_ABORTED");
		expect(existsSync(target)).toBe(false);
	});

	it("parks with a pending VFS and commits only after unpark", async () => {
		const root = sandbox();
		const target = join(root, "pending.txt");
		const bundle = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports: makePorts(),
		});
		const first = await runTool(bundle, {
			name: "patch",
			code: `(do (write {:path "pending.txt" :content "later"})
			            (where {:content "aa" :needle "a"}))`,
		});

		expect(keywordName(field(first.receipt, "state"))).toBe("parked");
		expect(existsSync(target)).toBe(false);

		const second = await runTool(bundle, {
			name: "resume",
			code: '(unpark {:name "patch" :value [0 1]})',
		});
		const resumed = field(second.receipt, "value");
		expect(keywordName(field(resumed, "state"))).toBe("completed");
		expect(readFileSync(target, "utf8")).toBe("later");
	});

	it("rejects a commit when a read dependency changed during the park", async () => {
		const root = sandbox();
		const target = file(root, "a.txt", "original");
		const bundle = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports: makePorts(),
		});
		const first = await runTool(bundle, {
			name: "patch",
			code: `(let [src (cat {:path "a.txt"})]
			          (do (write {:path "a.txt" :content (str src "-staged")})
			              (where {:content "aa" :needle "a"})))`,
		});
		expect(keywordName(field(first.receipt, "state"))).toBe("parked");

		writeFileSync(target, "external!", "utf8");
		const second = await runTool(bundle, {
			name: "resume",
			code: '(unpark {:name "patch" :value [0 1]})',
		});
		const resumed = field(second.receipt, "value");
		expect(keywordName(field(resumed, "state"))).toBe("failed");
		expect(keywordName(field(field(resumed, "error"), "code"))).toBe("FILE_CONFLICT");
		expect(readFileSync(target, "utf8")).toBe("external!");
	});
});

describe("call: drain, output, and cancellation", () => {
	it("drains pending VFS before the command and reports the drain", async () => {
		const root = sandbox();
		const logs = join(root, "logs");
		const target = file(root, "a.txt", "old");
		const events = [];
		const bundle = buildSandboxTools({
			role: "holder",
			roots: { writeRoot: root, callLogDir: logs },
			ports: makePorts({ events }),
		});
		const { receipt } = await runTool(bundle, {
			name: "p",
			code: `(let [old (cat {:path "a.txt"})]
			          (do (write {:path "a.txt" :content "new"})
			              (call {:argv ["cat", "a.txt"]})))`,
		});

		const call = field(receipt, "value");
		expect(field(call, "stdout")).toBe("new");
		expect(keywordName(field(field(call, "drained"), "status"))).toBe("applied");
		expect(field(field(call, "drained"), "written")).toContain(target);
		expect(field(call, "written")).toContain(target);
		expect(readFileSync(target, "utf8")).toBe("new");
		const logPath = field(call, "log-path");
		expect(logPath).toContain("logs");
		expect(readFileSync(logPath, "utf8")).toContain("new");
		expect(events).toContain("control:running");
	});

	it("caps inline output, flags truncation, and keeps the full log", async () => {
		const root = sandbox();
		const logs = join(root, "logs");
		const bundle = buildSandboxTools({
			role: "holder",
			roots: {
				writeRoot: root,
				callLogDir: logs,
				callLimits: { inlineBytes: 4, logBytes: 1024 },
			},
			ports: makePorts(),
		});
		const { receipt } = await runTool(bundle, {
			name: "p",
			code: '(call {:argv ["printf", "123456789"]})',
		});
		const call = field(receipt, "value");

		expect(field(call, "stdout")).toBe("1234");
		expect(field(call, "truncated")).toBe(true);
		expect(keywordName(field(call, "code"))).toBe("OUTPUT_TRUNCATED");
		const logPath = field(call, "log-path");
		const actionId = field(call, "action-id");
		expect(basename(logPath)).toBe(`${actionId}.log`);
		expect(readFileSync(logPath, "utf8")).toBe("123456789");
		expect(readdirSync(logs)).toHaveLength(1);
	});

	it.skipIf(!HAS_SETSID)("marks a started call uncertain when its exit is unconfirmed", async () => {
		const root = sandbox();
		const logs = join(root, "logs");
		const events = [];
		const bundle = buildSandboxTools({
			role: "holder",
			roots: { writeRoot: root, callLogDir: logs },
			ports: makePorts({ events }),
		});
		const { receipt } = await runTool(bundle, {
			name: "p",
			code: '(call {:argv ["sh", "-c", "setsid sleep 0.5 &"]})',
		});
		const call = field(receipt, "value");

		expect(keywordName(field(call, "status"))).toBe("outcome-unknown");
		expect(field(call, "unconfirmed-exit")).toBe(true);
		expect(keywordName(field(call, "reported-status"))).toBe("completed");
		expect(field(call, "stdio-closed")).toBe(false);
		expect(events).toContain("control:running");
		expect(events).toContain("control:uncertain");
		expect(events.filter((event) => event === "control:running")).toHaveLength(1);
		expect(events).not.toContain("control:publish");
		expect(keywordName(field(field(receipt, "interrupted-call"), "status"))).toBe("outcome-unknown");

		await new Promise((resolve) => setTimeout(resolve, 600));
	});

	it("refuses call without a log destination", async () => {
		const root = sandbox();
		const bundle = buildSandboxTools({
			role: "holder",
			roots: { writeRoot: root },
			ports: makePorts(),
		});
		const { receipt } = await runTool(bundle, {
			name: "p",
			code: '(call {:argv ["true"]})',
		});
		expect(keywordName(field(field(receipt, "error"), "code"))).toBe("INVALID_ARGUMENT");
	});

	it("does not commit staged writes when call validation fails", async () => {
		const root = sandbox();
		const pending = join(root, "pending.txt");
		const bundle = buildSandboxTools({
			role: "holder",
			roots: { writeRoot: root },
			ports: makePorts(),
		});
		const { receipt } = await runTool(bundle, {
			name: "p",
			code: `(do (write {:path "pending.txt" :content "later"})
			            (call {:argv ["true"]}))`,
		});

		expect(keywordName(field(receipt, "state"))).toBe("failed");
		expect(existsSync(pending)).toBe(false);
	});

	it("authorizes an explicit .herd log root", async () => {
		const root = sandbox();
		const logs = join(root, ".herd", "logs");
		const bundle = buildSandboxTools({
			role: "holder",
			roots: { writeRoot: root, callLogDir: logs },
			ports: makePorts(),
		});
		const { receipt } = await runTool(bundle, {
			name: "p",
			code: '(call {:argv ["printf", "prod"]})',
		});
		const call = field(receipt, "value");
		expect(field(call, "stdout")).toBe("prod");
		expect(existsSync(field(call, "log-path"))).toBe(true);
	});

	it("resolves relative call cwd and log path against writeRoot", async () => {
		const root = sandbox();
		mkdirSync(join(root, "sub"), { recursive: true });
		const bundle = buildSandboxTools({
			role: "holder",
			roots: {
				writeRoot: root,
				callCwd: "sub",
				callLimits: { logPath: "logs/a.log" },
			},
			ports: makePorts(),
		});
		const { receipt } = await runTool(bundle, {
			name: "p",
			code: '(call {:argv ["pwd"]})',
		});
		const call = field(receipt, "value");
		expect(field(call, "cwd")).toBe(join(root, "sub"));
		expect(field(call, "stdout").trim()).toBe(join(root, "sub"));
		expect(field(call, "log-path")).toBe(join(root, "logs", "a.log"));
		expect(readFileSync(join(root, "logs", "a.log"), "utf8")).toContain(root);
	});

	it("returns UPSTREAM_ABORTED before starting an already-cancelled call", async () => {
		const root = sandbox();
		const controller = new AbortController();
		controller.abort();
		const bundle = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports: makePorts(),
		});
		const { result, receipt } = await runTool(
			bundle,
			{
				name: "p",
				code: '(write {:path "never.txt" :content "x"})',
			},
			{ signal: controller.signal },
		);

		expect(result.isError).toBe(true);
		expect(keywordName(field(field(receipt, "error"), "code"))).toBe("UPSTREAM_ABORTED");
		expect(existsSync(join(root, "never.txt"))).toBe(false);
	});

	it("cancels a running shell call without pretending success", async () => {
		const root = sandbox();
		const logs = join(root, "logs");
		const controller = new AbortController();
		const bundle = buildSandboxTools({
			role: "holder",
			roots: { writeRoot: root, callLogDir: logs },
			ports: makePorts(),
		});
		setTimeout(() => controller.abort(), 150);
		const { receipt } = await runTool(
			bundle,
			{
				name: "p",
				code: '(call {:argv ["sleep", "5"]})',
			},
			{ signal: controller.signal },
		);

		expect(keywordName(field(receipt, "state"))).toBe("failed");
		expect(keywordName(field(receipt, "reason"))).toBe("aborted");
		const interrupted = field(receipt, "interrupted-call");
		expect(["outcome-unknown", "cancelled"]).toContain(keywordName(field(interrupted, "status")));
	});

	it("retains drained file facts when a call is cancelled after drain", async () => {
		const root = sandbox();
		const logs = join(root, "logs");
		const target = file(root, "a.txt", "old");
		const controller = new AbortController();
		const bundle = buildSandboxTools({
			role: "holder",
			roots: { writeRoot: root, callLogDir: logs },
			ports: makePorts(),
		});
		setTimeout(() => controller.abort(), 200);
		const { receipt } = await runTool(
			bundle,
			{
				name: "p",
				code: `(let [src (cat {:path "a.txt"})]
				          (do (write {:path "a.txt" :content "new"})
				              (call {:argv ["sleep", "5"]})))`,
			},
			{ signal: controller.signal },
		);

		const interrupted = field(receipt, "interrupted-call");
		expect(field(interrupted, "written")).toContain(target);
		expect(keywordName(field(field(interrupted, "drained"), "status"))).toBe("applied");
		expect(readFileSync(target, "utf8")).toBe("new");
	});

	it("keeps the sandbox usable after a cancelled call", async () => {
		const root = sandbox();
		const logs = join(root, "logs");
		const controller = new AbortController();
		const bundle = buildSandboxTools({
			role: "holder",
			roots: { writeRoot: root, callLogDir: logs },
			ports: makePorts(),
		});
		setTimeout(() => controller.abort(), 150);
		await runTool(
			bundle,
			{
				name: "cancelled",
				code: '(call {:argv ["sleep", "5"]})',
			},
			{ signal: controller.signal },
		);

		const next = await runTool(bundle, {
			name: "next",
			code: "42",
		});
		expect(keywordName(field(next.receipt, "state"))).toBe("completed");
		expect(field(next.receipt, "value")).toBe(42);
	});
});

describe("call-id replay", () => {
	it("returns the cached receipt when CallMeta was already collected", async () => {
		const root = sandbox();
		const ports = makePorts();
		const bundle = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports,
		});
		const params = { name: "p", code: "1" };
		const first = await runTool(bundle, params, { callId: "replay-1" });
		expect(keywordName(field(first.receipt, "state"))).toBe("completed");

		ports.callMeta.read = () => undefined;
		const second = await runTool(bundle, params, { callId: "replay-1" });
		expect(second.result.content[0].text).toBe(first.result.content[0].text);
	});

	it("rejects a different payload for the same call-id", async () => {
		const root = sandbox();
		const bundle = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports: makePorts(),
		});
		await runTool(bundle, { name: "p", code: "1" }, { callId: "replay-2" });
		const second = await runTool(bundle, { name: "p", code: "2" }, { callId: "replay-2" });

		expect(second.result.isError).toBe(true);
		expect(keywordName(field(field(second.receipt, "error"), "code"))).toBe("CALL_REPLAY_MISMATCH");
	});

	it("joins a concurrent duplicate instead of rejecting it", async () => {
		const root = sandbox();
		const logs = join(root, "logs");
		const events = [];
		const bundle = buildSandboxTools({
			role: "holder",
			roots: { writeRoot: root, callLogDir: logs },
			ports: makePorts({ events }),
		});
		const params = {
			name: "p",
			code: '(call {:argv ["sleep", "0.3"]})',
		};
		const [first, second] = await Promise.all([bundle.execute("replay-3", params), bundle.execute("replay-3", params)]);
		const firstReceipt = readUfss(first.content[0].text);

		expect(keywordName(field(firstReceipt, "state"))).toBe("completed");
		expect(second.content[0].text).toBe(first.content[0].text);
		expect(events.filter((event) => event === "control:running")).toHaveLength(1);
	});
});

describe("auditor roots", () => {
	function auditorBundle(options = {}) {
		const root = sandbox("herd-tools-auditor-");
		const evidenceRoot = join(root, "plans", "slug", "evidence", "CASE-1");
		const auditTmp = join(root, "audit-tmp");
		const logs = join(root, "logs");
		mkdirSync(evidenceRoot, { recursive: true });
		mkdirSync(auditTmp, { recursive: true });
		file(root, "product.mjs", "export const value = 1;\n");
		const ports = options.ports ?? makePorts();
		const io = testSandboxIo();
		const bundle = buildSandboxTools({
			role: "auditor",
			roots: {
				writeRoot: root,
				evidenceRoot,
				auditTmp,
				callLogDir: logs,
				io,
				sandbox: { available: true, runCommand: io.runCommand },
				...(options.roots ?? {}),
			},
			ports,
		});
		return { bundle, root, evidenceRoot, auditTmp, logs, ports };
	}

	it("reads the workspace and writes only evidence or the dedicated tmp root", async () => {
		const { bundle, root, evidenceRoot, auditTmp } = auditorBundle();
		const tmpTarget = join(auditTmp, "scratch.txt");
		const { receipt } = await runTool(bundle, {
			name: "audit",
			code: `(do (write {:path "plans/slug/evidence/CASE-1/note.md" :content "evidence"})
			            (write {:path ${JSON.stringify(tmpTarget)} :content "scratch"})
			            [(cat {:path "product.mjs"}) (cat {:path ${JSON.stringify(tmpTarget)}})])`,
		});

		expect(keywordName(field(receipt, "state"))).toBe("completed");
		expect(field(receipt, "value")[0]).toContain("export const value");
		expect(field(receipt, "value")[1]).toBe("scratch");
		expect(readFileSync(join(evidenceRoot, "note.md"), "utf8")).toBe("evidence");
		expect(readFileSync(tmpTarget, "utf8")).toBe("scratch");
		const commit = field(receipt, "commit");
		expect(keywordName(field(commit, "status"))).toBe("applied");
		expect(field(commit, "written")).toHaveLength(2);
		expect(field(receipt, "value")[0]).not.toContain("scratch");
		expect(readFileSync(join(root, "product.mjs"), "utf8")).toContain("value = 1");
	});

	it("accepts the production root shape with a /tmp audit root", async () => {
		const root = sandbox("herd-tools-prod-auditor-");
		const evidenceRoot = join(root, "plans", "slug", "evidence", "CASE-1");
		const auditTmp = mkdtempSync(join(tmpdir(), "herd-audit-slug-case-"));
		roots.push(auditTmp);
		const logs = join(root, ".herd", "artifacts", "slug", "auditor");
		mkdirSync(evidenceRoot, { recursive: true });
		file(root, "product.mjs", "export const value = 1;\n");
		const io = testSandboxIo();
		const bundle = buildSandboxTools({
			role: "auditor",
			roots: {
				writeRoot: root,
				evidenceRoot,
				auditTmp,
				readRoots: [],
				callLogDir: logs,
				io,
				sandbox: { available: true, runCommand: io.runCommand },
			},
			ports: makePorts(),
		});

		const tmpFile = join(auditTmp, "probe.txt");
		const { receipt } = await runTool(bundle, {
			name: "prod",
			code: `(do (write {:path "plans/slug/evidence/CASE-1/prod.md" :content "evidence"})
			            (write {:path ${JSON.stringify(tmpFile)} :content "tmp"})
			            (cat {:path "product.mjs"}))`,
		});

		expect(keywordName(field(receipt, "state"))).toBe("completed");
		expect(keywordName(field(field(receipt, "commit"), "status"))).toBe("applied");
		expect(readFileSync(join(evidenceRoot, "prod.md"), "utf8")).toBe("evidence");
		expect(readFileSync(tmpFile, "utf8")).toBe("tmp");
	});

	it("reports applied files from an uncertain batch", async () => {
		const { bundle, evidenceRoot, ports } = auditorBundle();
		const first = join(evidenceRoot, "a", "one.txt");
		const second = join(evidenceRoot, "b", "two.txt");
		mkdirSync(dirname(first), { recursive: true });
		mkdirSync(dirname(second), { recursive: true });
		ports.control.markApplying = () => {
			rmSync(dirname(second), { recursive: true, force: true });
			return { ok: true };
		};

		const { receipt } = await runTool(bundle, {
			name: "uncertain",
			code: `(do (write {:path "plans/slug/evidence/CASE-1/a/one.txt" :content "one"})
			            (write {:path "plans/slug/evidence/CASE-1/b/two.txt" :content "two"}))`,
		});
		const error = field(receipt, "error");
		const data = field(error, "data");

		expect(keywordName(field(receipt, "state"))).toBe("failed");
		expect(keywordName(field(error, "code"))).toBe("BOARD_CONFLICT");
		expect(field(data, "written")).toContain(first);
		expect(readFileSync(first, "utf8")).toBe("one");
		expect(existsSync(second)).toBe(false);
	});

	it("rechecks a read-only dependency even when its batch has no write", async () => {
		const { bundle, root, auditTmp, ports } = auditorBundle();
		const product = join(root, "product.mjs");
		const written = join(auditTmp, "written.txt");
		const baseGate = ports.writeGate;
		let first = true;
		ports.writeGate = {
			async runExclusive(run) {
				if (first) {
					first = false;
					writeFileSync(product, "changed", "utf8");
				}
				return baseGate.runExclusive(run);
			},
		};

		const { receipt } = await runTool(bundle, {
			name: "facts",
			code: `(let [src (cat {:path "product.mjs"})]
			          (write {:path ${JSON.stringify(written)} :content "t"}))`,
		});

		expect(keywordName(field(receipt, "state"))).toBe("failed");
		expect(keywordName(field(field(receipt, "error"), "code"))).toBe("FILE_CONFLICT");
		expect(existsSync(written)).toBe(false);
	});

	it("rejects call even when a passthrough port is injected", async () => {
		const { bundle, auditTmp } = auditorBundle({
			roots: { io: undefined, sandbox: undefined },
			ports: {
				...makePorts(),
				callSandbox: ({ command }) => ({ ok: true, command }),
			},
		});
		const marker = join(auditTmp, "auditor-shell-ran.txt");
		const { receipt } = await runTool(bundle, {
			name: "p",
			code: `(call {:argv ["printf" "shell-ran"]})`,
		});
		expect(keywordName(field(receipt, "state"))).toBe("failed");
		const error = field(receipt, "error");
		expect(keywordName(field(error, "code"))).toBe("CAPABILITY_DENIED");
		expect(field(error, "message")).toContain("active bwrap sandbox");
		expect(existsSync(marker)).toBe(false);
	});

	it("runs auditor call only through the injected sandbox runCommand", async () => {
		const seen = [];
		const runCommand = async (argv, options) => {
			seen.push({ argv, options });
			return {
				stdout: "sandboxed\n",
				stderr: "",
				exitCode: 0,
				signal: null,
				error: null,
				aborted: false,
				started: true,
				truncated: false,
				managedChildren: false,
				stdioClosed: true,
				externalBestEffort: true,
			};
		};
		const { bundle } = auditorBundle({
			roots: {
				io: { runCommand },
				sandbox: { available: true, runCommand },
			},
		});
		const { receipt } = await runTool(bundle, {
			name: "p",
			code: '(call {:argv ["printf", "hi"]})',
		});
		const call = field(receipt, "value");
		expect(field(call, "stdout")).toBe("sandboxed\n");
		expect(seen).toHaveLength(1);
		expect(seen[0].argv).toEqual(["printf", "hi"]);
	});
});

describe("observed read facts", () => {
	it("exposes cross-program facts and verifies them without a fresh stat", async () => {
		const root = sandbox();
		file(root, "product.mjs", "value = 1");
		file(root, "docs/readme.md", "hello");
		const bundle = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports: makePorts(),
		});
		const productPath = join(root, "product.mjs");
		const docsPath = join(root, "docs/readme.md");
		await runTool(bundle, {
			name: "read-product",
			code: `(cat {:path "product.mjs"})`,
		});
		await runTool(bundle, {
			name: "read-docs",
			code: `(cat {:path "docs/readme.md"})`,
		});
		const snapshot = bundle.readSetForActor();
		expect(snapshot.ok).toBe(true);
		const paths = snapshot.credential.entries.map((entry) => entry.path);
		expect(paths).toContain(productPath);
		expect(paths).toContain(docsPath);
		const verified = bundle.verifyObservedFacts(snapshot.credential, [productPath, docsPath]);
		expect(verified.ok).toBe(true);
		const unknown = bundle.verifyObservedFacts(snapshot.credential, [join(root, "missing.mjs")]);
		expect(unknown.ok).toBe(false);
		expect(unknown.code).toBe(":STALE_CONTROL");
		expect(unknown.reason).toBe("unobserved-dependency");
		file(root, "product.mjs", "value = 22");
		const conflict = bundle.verifyObservedFacts(snapshot.credential, [productPath]);
		expect(conflict.ok).toBe(false);
		expect(conflict.code).toBe(":FILE_CONFLICT");
	});

	it("shares the same ledger with another built tool and retires it", async () => {
		const root = sandbox();
		file(root, "a.mjs", "a");
		file(root, "b.mjs", "b");
		const first = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports: makePorts(),
		});
		await runTool(first, {
			name: "read-a",
			code: `(cat {:path "a.mjs"})`,
		});
		const second = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports: {
				...makePorts(),
				observations: first.observations,
				observationScope: first.observationScope,
			},
		});
		await runTool(second, {
			name: "read-b",
			code: `(cat {:path "b.mjs"})`,
		});
		const credential = second.readSetForActor();
		expect(credential.ok).toBe(true);
		const paths = credential.credential.entries.map((entry) => entry.path);
		expect(paths).toContain(join(root, "a.mjs"));
		expect(paths).toContain(join(root, "b.mjs"));
		expect(second.verifyObservedFacts(credential.credential, paths).ok).toBe(true);
		second.retireActor();
		expect(second.readSetForActor().ok).toBe(false);
		const stale = second.verifyObservedFacts(credential.credential, paths);
		expect(stale.ok).toBe(false);
		expect(stale.code).toBe(":STALE_CONTROL");
		second.retireSession();
	});

	it("fails closed when termId is missing", async () => {
		const root = sandbox();
		file(root, "a.mjs", "a");
		const ports = makePorts();
		ports.termId = undefined;
		ports.identity = { agent_id: "agent-1" };
		ports.claim = { claim_id: "claim-1" };
		const bundle = buildSandboxTools({
			role: "worker",
			roots: { writeRoot: root },
			ports,
		});
		await runTool(bundle, {
			name: "read-a",
			code: `(cat {:path "a.mjs"})`,
		});
		expect(bundle.observations).toBeNull();
		expect(bundle.observationScope).toBeNull();
		const snapshot = bundle.readSetForActor();
		expect(snapshot.ok).toBe(false);
		expect(snapshot.code).toBe(":STALE_CONTROL");
		expect(snapshot.reason).toBe("term-id-required");
		const verified = bundle.verifyObservedFacts({}, [join(root, "a.mjs")]);
		expect(verified.ok).toBe(false);
		expect(verified.reason).toBe("term-id-required");
		expect(bundle.retireActor().ok).toBe(false);
	});
});
