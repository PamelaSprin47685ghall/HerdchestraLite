import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { installFakeClock, uninstallFakeClock } from "./fake-clock.mjs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";
let root;
let evalClj;
let previousLockWait;
let clock;
const LOCK_NAME = "clj-core.cross-process.lock";

async function settleClock(promise, timers = 20) {
	let settled = false;
	promise.then(() => { settled = true; }, () => { settled = true; });
	for (let i = 0; i < timers && !settled; i += 1) {
		await Promise.race([
			clock.waitForTimer(),
			promise.then(() => true, () => true),
		]);
		if (settled) break;
		clock.advance(10);
	}
	return await promise;
}
function lockPath() {
	return join(root, ".herd", "locks", LOCK_NAME);
}
function writeClj(file, content) {
	return evalClj(
		`(-> (herd.sandbox/write {:path ${JSON.stringify(file)} :content ${JSON.stringify(content)}})
		     (.then (fn [_] "ok"))
		     (.catch (fn [e] (js/JSON.stringify (clj->js {:code (or (:code (ex-data e)) (.-code e))
		                                                  :message (.-message e)
		                                                  :waited-ms (:waited-ms (ex-data e))
		                                                  :holder (:holder (ex-data e))
		                                                  :retryable (:retryable (ex-data e))})))))`,
	);
}
async function holdLock(pid) {
	await mkdir(join(root, ".herd", "locks"), { recursive: true });
	await writeFile(
		lockPath(),
		JSON.stringify({
			pid,
			startedAt: new Date().toISOString(),
			host: "lock-test",
			cwd: root,
		}),
		"utf8",
	);
}
function parseError(result) {
	expect(result).not.toBe("ok");
	return JSON.parse(result);
}
beforeAll(async () => {
	clock = installFakeClock();
	previousLockWait = process.env.HERD_LOCK_WAIT_MS;
	process.env.HERD_LOCK_WAIT_MS = "50";
	root = await mkdtemp(join(tmpdir(), "herd-lock-"));
	globalThis.__herdLockRoot = root;
	globalThis.__herdNative = {
		getRunner: () => ({
			hasNativeTool: (name) => name === "read" || name === "write",
			invokeNativeTool: async (name, params) => {
				if (name === "read") {
					return { content: [{ type: "text", text: await readFile(params.path, "utf8") }] };
				}
				await writeFile(params.path, params.content, "utf8");
				return { content: [] };
			},
		}),
	};
	nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
	await nbb.loadFile(fileURLToPath(new URL("../src/herd/ufss.cljs", import.meta.url)));
	globalThis.__sandboxSource = await readFile(
		fileURLToPath(new URL("../src/herd/sandbox.cljs", import.meta.url)),
		"utf8",
	);
	const unwrapped = await nbb.loadString("(herd.ufss/unwrap (.-__sandboxSource js/globalThis))");
	const generated = join(root, "generated");
	await mkdir(join(generated, "herd"), { recursive: true });
	await writeFile(join(generated, "herd", "sandbox.cljs"), unwrapped, "utf8");
	nbb.addClassPath(generated);
	await nbb.loadFile(join(generated, "herd", "sandbox.cljs"));
	evalClj = (code) => nbb.loadString(code);
});
afterEach(async () => {
	clock.reset();
	await rm(lockPath(), { force: true });
});

afterAll(async () => {
	uninstallFakeClock();
	if (previousLockWait === undefined) delete process.env.HERD_LOCK_WAIT_MS;
	else process.env.HERD_LOCK_WAIT_MS = previousLockWait;
	globalThis.__herdLockRoot = undefined;
	await rm(root, { recursive: true, force: true });
});
describe("lock contention", () => {
	it("serializes two concurrent writes to one file", async () => {
		const file = join(root, "same-file.txt");
		const results = await Promise.all([writeClj(file, "alpha"), writeClj(file, "beta")]);
		expect(results).toEqual(["ok", "ok"]);
		const text = await readFile(file, "utf8");
		expect(["alpha", "beta"]).toContain(text);
	});
	it("returns LOCK_BUSY after the injected wait for concurrent writes while a live pid holds the lock", async () => {
		await holdLock(process.pid);
		const results = await settleClock(Promise.all([
			writeClj(join(root, "busy-a.txt"), "blocked-a"),
			writeClj(join(root, "busy-b.txt"), "blocked-b"),
		]));
		const infos = results.map(parseError);
		for (const info of infos) {
			expect(info.code).toBe("LOCK_BUSY");
			expect(info.retryable).toBe(true);
			expect(info["waited-ms"]).toBeGreaterThanOrEqual(40);
		}
		const held = JSON.parse(await readFile(lockPath(), "utf8"));
		expect(held.pid).toBe(process.pid);
	});
	it("reclaims a lock whose pid is dead", async () => {
		await holdLock(999999);
		const result = await settleClock(writeClj(join(root, "dead-pid.txt"), "after-dead"));
		expect(result).toBe("ok");
		expect(await readFile(join(root, "dead-pid.txt"), "utf8")).toBe("after-dead");
	});
	it("derives different lock paths for different working directories", async () => {
		const original = process.cwd();
		const previousRoot = globalThis.__herdLockRoot;
		try {
			globalThis.__herdLockRoot = undefined;
			const first = join(root, "cwd-a");
			const second = join(root, "cwd-b");
			await mkdir(first, { recursive: true });
			await mkdir(second, { recursive: true });
			process.chdir(first);
			const pathA = await evalClj("(herd.sandbox/lock-path)");
			process.chdir(second);
			const pathB = await evalClj("(herd.sandbox/lock-path)");
			expect(pathA).not.toBe(pathB);
			expect(pathA).toContain(first);
			expect(pathB).toContain(second);
		} finally {
			process.chdir(original);
			globalThis.__herdLockRoot = previousRoot;
		}
	});
	it("traces lock-wait with result when HERD_TRACE is enabled", async () => {
		const traceFile = join(root, "trace", "perf-trace.jsonl");
		process.env.HERD_TRACE = "1";
		process.env.HERD_TRACE_PATH = traceFile;
		try {
			await holdLock(process.pid);
			const result = await settleClock(writeClj(join(root, "trace-busy.txt"), "blocked"));
			parseError(result);
			await nbb.loadString("(-> (deref herd.sandbox/trace-tail) (.then (fn [_] true)))");
			const events = (await readFile(traceFile, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.filter((event) => event.event === "lock-wait");
			expect(events.length).toBeGreaterThan(0);
			const timeout = events[events.length - 1];
			expect(timeout.result).toBe("timeout");
			expect(typeof timeout.ms).toBe("number");
			expect(timeout.path).toContain(LOCK_NAME);
		} finally {
			delete process.env.HERD_TRACE;
			delete process.env.HERD_TRACE_PATH;
			await rm(lockPath(), { force: true });
		}
	});
});
