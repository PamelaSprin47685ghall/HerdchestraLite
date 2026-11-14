import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";
import { acquireIpcLock, lockEndpointFor, shutdownIpcDaemon } from "../src/host/lock-daemon.mjs";
import { installFakeClock, uninstallFakeClock } from "./fake-clock.mjs";

const LOCK_DAEMON_PATH = fileURLToPath(new URL("../src/host/lock-daemon.mjs", import.meta.url));
let root;
let evalClj;
let previousLockWait;
let clock;

async function settleClock(promise, timers = 20) {
	let settled = false;
	promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	for (let i = 0; i < timers && !settled; i += 1) {
		await Promise.race([
			clock.waitForTimer(),
			promise.then(
				() => true,
				() => true,
			),
		]);
		if (settled) break;
		clock.advance(10);
	}
	return await promise;
}

function writeClj(file, content) {
	return evalClj(
		`(-> (herd.sandbox/write {:path ${JSON.stringify(file)} :content ${JSON.stringify(content)}})
		     (.then (fn [_] "ok"))
		     (.catch (fn [e] (js/JSON.stringify (clj->js {:code (or (:code (ex-data e)) (.-code e))
		                                                  :message (.-message e)
		                                                  :waited-ms (:waited-ms (ex-data e))
		                                                  :retryable (:retryable (ex-data e))})))))`,
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

afterEach(() => {
	clock.reset();
});

afterAll(async () => {
	uninstallFakeClock();
	await shutdownIpcDaemon(lockEndpointFor(root));
	if (previousLockWait === undefined) delete process.env.HERD_LOCK_WAIT_MS;
	else process.env.HERD_LOCK_WAIT_MS = previousLockWait;
	globalThis.__herdLockRoot = undefined;
	await rm(root, { recursive: true, force: true });
});

describe("lock contention (event-driven IPC)", () => {
	it("serializes two concurrent writes to one file", async () => {
		const file = join(root, "same-file.txt");
		const results = await Promise.all([writeClj(file, "alpha"), writeClj(file, "beta")]);
		expect(results).toEqual(["ok", "ok"]);
		const text = await readFile(file, "utf8");
		expect(["alpha", "beta"]).toContain(text);
	});

	it("serializes many concurrent same-process writes across distinct files without self-inflicted LOCK_BUSY", async () => {
		const prevNative = globalThis.__herdNative;
		globalThis.__herdNative = {
			getRunner: () => ({
				hasNativeTool: (name) => name === "read" || name === "write",
				invokeNativeTool: async (name, params) => {
					if (name === "read") {
						return { content: [{ type: "text", text: await readFile(params.path, "utf8") }] };
					}
					await new Promise((resolve) => setTimeout(resolve, 15));
					await writeFile(params.path, params.content, "utf8");
					return { content: [] };
				},
			}),
		};
		try {
			const writes = Array.from({ length: 6 }, (_, i) => writeClj(join(root, `many-${i}.txt`), `val-${i}`));
			const results = await Promise.all(writes);
			expect(results).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
		} finally {
			globalThis.__herdNative = prevNative;
		}
	});

	it("returns LOCK_BUSY after the injected wait while an external connection holds the lock", async () => {
		const endpoint = lockEndpointFor(root);
		const key = await evalClj("(herd.sandbox/lock-key)");
		const holder = await acquireIpcLock({ endpoint, key, waitMs: 500 });
		try {
			const results = await settleClock(
				Promise.all([writeClj(join(root, "busy-a.txt"), "blocked-a"), writeClj(join(root, "busy-b.txt"), "blocked-b")]),
			);
			const infos = results.map(parseError);
			for (const info of infos) {
				expect(info.code).toBe("LOCK_BUSY");
				expect(info.retryable).toBe(true);
				expect(info["waited-ms"]).toBeGreaterThanOrEqual(40);
			}
		} finally {
			await holder.release();
		}
	});

	it("releases immediately without polling when the holding child process is SIGKILLed", async () => {
		const endpoint = lockEndpointFor(root);
		const key = await evalClj("(herd.sandbox/lock-key)");
		const prevWait = process.env.HERD_LOCK_WAIT_MS;
		const savedClock = globalThis.__herdClock;
		delete globalThis.__herdClock;
		process.env.HERD_LOCK_WAIT_MS = "1000";
		const child = spawn(
			"bun",
			[
				"-e",
				`import { acquireIpcLock } from ${JSON.stringify(LOCK_DAEMON_PATH)};
				 const lease = await acquireIpcLock({ endpoint: ${JSON.stringify(endpoint)}, key: ${JSON.stringify(key)}, waitMs: 1000 });
				 console.log("HELD");
				 setInterval(() => {}, 1000);`,
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		try {
			await new Promise((resolve) => {
				child.stdout.on("data", (chunk) => {
					if (chunk.toString("utf8").includes("HELD")) resolve();
				});
			});
			const started = Date.now();
			const pendingWrite = writeClj(join(root, "after-sigkill.txt"), "instant-handoff");
			setTimeout(() => child.kill("SIGKILL"), 25);
			const result = await pendingWrite;
			const elapsed = Date.now() - started;
			expect(result).toBe("ok");
			expect(elapsed).toBeLessThan(500);
			expect(await readFile(join(root, "after-sigkill.txt"), "utf8")).toBe("instant-handoff");
		} finally {
			try {
				child.kill("SIGKILL");
			} catch {}
			globalThis.__herdClock = savedClock;
			if (prevWait === undefined) delete process.env.HERD_LOCK_WAIT_MS;
			else process.env.HERD_LOCK_WAIT_MS = prevWait;
		}
	});

	it("derives different lock endpoints and keys for different working directories", async () => {
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
			const keyA = await evalClj("(herd.sandbox/lock-key)");
			process.chdir(second);
			const pathB = await evalClj("(herd.sandbox/lock-path)");
			const keyB = await evalClj("(herd.sandbox/lock-key)");
			expect(pathA).not.toBe(pathB);
			expect(keyA).not.toBe(keyB);
			expect(keyA).toContain(first);
			expect(keyB).toContain(second);
		} finally {
			process.chdir(original);
			globalThis.__herdLockRoot = previousRoot;
		}
	});

	it("traces lock-wait with result when HERD_TRACE is enabled", async () => {
		const traceFile = join(root, "trace", "perf-trace.jsonl");
		process.env.HERD_TRACE = "1";
		process.env.HERD_TRACE_PATH = traceFile;
		const endpoint = lockEndpointFor(root);
		const key = await evalClj("(herd.sandbox/lock-key)");
		const holder = await acquireIpcLock({ endpoint, key, waitMs: 500 });
		try {
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
			expect(timeout.path).toBe(endpoint);
		} finally {
			await holder.release();
			delete process.env.HERD_TRACE;
			delete process.env.HERD_TRACE_PATH;
		}
	});
});
