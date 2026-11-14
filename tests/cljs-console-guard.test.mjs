import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";
import { loadLanguageDetector } from "../src/host/language-detect.mjs";

let tool;
let waitTool;

class FakeText {
	constructor(text, x, y) {
		this.text = text;
		this.x = x;
		this.y = y;
	}
}

class FakeContainer {
	constructor() {
		this.children = [];
	}

	addChild(child) {
		this.children.push(child);
	}
}

beforeAll(async () => {
	globalThis.__herdLockRoot = fileURLToPath(new URL("../tmp/herd-console-guard-lock", import.meta.url));
	globalThis.__herdNative = {
		getRunner: () => ({
			hasNativeTool: (name) => name === "read" || name === "write",
			invokeNativeTool: async (name, params) => {
				if (name === "read") return { content: [{ type: "text", text: await readFile(params.path, "utf8") }] };
				await writeFile(params.path, params.content, "utf8");
				return { content: [] };
			},
		}),
	};
	globalThis.__pi = {
		tools: new Map(),
		hooks: new Map(),
		active: ["read", "bash", "board_finish", "clj_devops", "wait"],
		pi: { Text: FakeText, Container: FakeContainer },
		registerTool(definition) {
			this.tools.set(definition.name, definition);
		},
		on(name, handler) {
			if (!this.hooks.has(name)) this.hooks.set(name, handler);
		},
		getActiveTools() {
			return [...this.active];
		},
		setActiveTools(next) {
			this.active = [...next];
		},
	};
	globalThis.__herdTui = { highlightCode: (code) => code.split("\n") };
	globalThis.__herdDetectLanguage = loadLanguageDetector(createRequire(import.meta.url));
	nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
	await nbb.loadFile(fileURLToPath(new URL("../src/herd/bootstrap.cljs", import.meta.url)));
	await nbb.loadString("(herd.main/activate-session! js/globalThis.__pi)");
	const start = globalThis.__pi.hooks.get("session_start");
	if (start) start({}, {});
	tool = globalThis.__pi.tools.get("clj_devops");
	waitTool = globalThis.__pi.tools.get("wait");
});

afterAll(async () => {
	await rm(fileURLToPath(new URL("../tmp/cljs-console-guard", import.meta.url)), { recursive: true, force: true });
});

let counter = 0;

async function waitForName(name) {
	for (;;) {
		const waited = await waitTool.execute(null, { otherwise_independent_work: "x".repeat(1000) }, null);
		const text = waited.content[0].text;
		if (text.includes(`:name "${name}"`) || text.includes(":state :idle") || text.includes(":state :parked")) {
			return waited;
		}
	}
}

async function run(code) {
	counter += 1;
	const name = `guard-case-${counter}`;
	const first = await tool.execute(null, { name, code, agent_state: "Converging" }, null);
	if (!first.content[0].text.includes(":state :forked")) return first;
	return waitForName(name);
}

async function drain() {
	for (;;) {
		const waited = await waitTool.execute(null, { otherwise_independent_work: "none" }, null);
		if (waited.content[0].text.includes(":state :idle")) return;
	}
}

function captureHostWrites() {
	const writes = [];
	const out = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		writes.push(String(chunk));
		return true;
	});
	const err = spyOn(process.stderr, "write").mockImplementation((chunk) => {
		writes.push(String(chunk));
		return true;
	});
	return {
		writes,
		restore() {
			out.mockRestore();
			err.mockRestore();
		},
	};
}

describe("CLJS console and stdio guard", () => {
	it("denies direct console and stdio access before running any code", async () => {
		const dir = await mkdtemp(join(tmpdir(), "herd-console-guard-"));
		const previous = process.cwd();
		const capture = captureHostWrites();
		const receipts = [];
		try {
			process.chdir(dir);
			for (const [code, symbol] of [
				['(js/console.log "x")', "js/console"],
				['(globalThis.console.log "x")', "globalThis.console"],
				['(console.log "x")', "console"],
				['(js/process.stdout.write "x")', "js/process.stdout"],
				['(js/process.stderr.write "x")', "js/process.stderr"],
				['(process.stdout.write "x")', "process.stdout"],
				['(process.stderr.write "x")', "process.stderr"],
				["(.-stdout js/process)", "(.-stdout js/process)"],
				["(.-stderr js/process)", "(.-stderr js/process)"],
				['(println "x")', "println"],
				['(prn "x")', "prn"],
				['(print "x")', "print"],
				['(printf "x")', "printf"],
				["(binding [*print-fn* (fn [_])] nil)", "*print-fn*"],
				["(binding [*print-err-fn* (fn [_])] nil)", "*print-err-fn*"],
				["(binding [*out* *out*] *out*)", "*out*"],
				["(binding [*err* *err*] *err*)", "*err*"],
			]) {
				receipts.push([symbol, await run(code)]);
			}
		} finally {
			capture.restore();
			process.chdir(previous);
		}
		for (const [symbol, receipt] of receipts) {
			const text = receipt.content[0].text;
			expect(text).toContain(":state :failed");
			expect(text).toContain("CAPABILITY_DENIED");
			expect(text).toContain(":reason :console-or-stdio-forbidden");
			expect(text).toContain(`:symbol "${symbol}"`);
		}
		expect(capture.writes).toEqual([]);
		expect(await readdir(dir)).toEqual([]);
		await rm(dir, { recursive: true, force: true });
	});

	it("does not reject console text inside strings, comments, or fences", async () => {
		const literal = await run('(str "println console" "-safe")');
		expect(literal.content[0].text).toContain(":state :completed");
		expect(literal.content[0].text).toContain("println console-safe");

		const comment = await run('; console.log("x")\n; (println "x") prn print printf *print-fn* *out* *err*\n(+ 1 2)');
		expect(comment.content[0].text).toContain(":state :completed");
		expect(comment.content[0].text).toContain(":value 3");

		const fence = await run('(count ##"println console"##)');
		expect(fence.content[0].text).toContain(":state :completed");
		expect(fence.content[0].text).toContain(":value 15");
	});

	it("captures call output without writing to the host streams", async () => {
		await drain();
		const capture = captureHostWrites();
		let result;
		try {
			result = await run('(call {:argv ["sh" "-c" "printf out; printf err >&2"]})');
		} finally {
			capture.restore();
		}
		const text = result.content[0].text;
		expect(text).toContain(":exit 0");
		expect(text).toContain(':stdout "out"');
		expect(text).toContain(':stderr "err"');
		expect(text).toContain(":output-truncated false");
		expect(text).not.toContain(":log");
		expect(capture.writes).toEqual([]);
	});

	it("keeps normal write and cat programs working", async () => {
		const mkdir = await run('(mkdir {:path "tmp/cljs-console-guard"})');
		expect(mkdir.content[0].text).toContain(":state :completed");
		const write = await run('(write {:path "tmp/cljs-console-guard/ok.txt" :content "guard-ok"})');
		expect(write.content[0].text).toContain(":state :completed");
		const cat = await run('(cat {:path "tmp/cljs-console-guard/ok.txt"})');
		expect(cat.content[0].text).toContain("guard-ok");
		const removed = await run('(rm {:path "tmp/cljs-console-guard"})');
		expect(removed.content[0].text).toContain(":state :completed");
	});

	it("writes record-health! to the internal file without host output", async () => {
		const dir = await mkdtemp(join(tmpdir(), "herd-health-"));
		const capture = captureHostWrites();
		let record;
		try {
			await nbb.loadString(`(require '[herd.system :as system])
				(swap! system/state assoc-in [:options :root] ${JSON.stringify(dir)})`);
			const json = await nbb.loadString(`(require '[herd.system :as system])
				(js/JSON.stringify (clj->js (system/record-health! {:entry "test.health" :status "degraded"})))`);
			record = JSON.parse(json);
			await nbb.loadString(`(require '[herd.system :as system]) @system/health-tail`);
		} finally {
			capture.restore();
		}
		expect(capture.writes).toEqual([]);
		expect(record.entry).toBe("test.health");
		expect(record.status).toBe("degraded");
		const text = await readFile(join(dir, ".herd", "health.jsonl"), "utf8");
		expect(text).toContain('"entry":"test.health"');
		expect(text).toContain('"status":"degraded"');
		await rm(dir, { recursive: true, force: true });
	});
});
