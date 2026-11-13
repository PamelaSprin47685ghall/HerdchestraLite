/**
 * Multi-core Worker pool for `glob` `:exec` callbacks.
 *
 * Splits matched file paths across a persistent pool of `node:worker_threads`
 * Workers (`__globPoolWorker: true`). Results and `readSet` stamps round-trip
 * cleanly via UFSS/EDN and plain objects.
 */

import { availableParallelism } from "node:os";
import { parentPort, Worker, workerData } from "node:worker_threads";
import { createSandboxSession, runSerializedCallable } from "./evaluator.mjs";
import { EdnKeyword, printUfss, readUfss } from "./ufss.mjs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const POOL_SIZE = Math.min(8, Math.max(2, availableParallelism?.() ?? 4));
const pool = { workers: [], nextIdx: 0, seq: 0, pending: new Map() };

function ensurePool(requested = POOL_SIZE) {
	if (pool.workers.length > 0) return pool.workers;
	const count = Math.min(POOL_SIZE, Math.max(1, requested));
	for (let i = 0; i < count; i += 1) {
		const worker = new Worker(new URL("./glob-pool.mjs", import.meta.url), {
			workerData: { __globPoolWorker: true },
		});
		worker.unref?.();
		worker.on("message", (msg) => {
			if (!msg || typeof msg !== "object") return;
			const entry = pool.pending.get(msg.id);
			if (!entry) return;
			pool.pending.delete(msg.id);
			if (msg.ok) {
				entry.resolve(msg);
			} else {
				entry.reject(new Error(msg.error ?? "glob worker failed"));
			}
		});
		worker.on("error", (err) => {
			for (const [id, entry] of pool.pending.entries()) {
				if (entry.worker === worker) {
					pool.pending.delete(id);
					entry.reject(err);
				}
			}
		});
		pool.workers.push(worker);
	}
	return pool.workers;
}

/**
 * Run `fnDesc` across `paths` in parallel using the persistent Worker pool.
 * Returns `{ results: string[] (UFSS-encoded EDN), readEntries: Array }`.
 */
export async function runGlobInPool({ writeRoot, fnDesc, paths }) {
	const workers = ensurePool(paths.length);
	const chunkCount = Math.min(workers.length, paths.length);
	const chunks = Array.from({ length: chunkCount }, () => []);
	for (let i = 0; i < paths.length; i += 1) {
		chunks[i % chunkCount].push(paths[i]);
	}

	const chunkPromises = chunks.map((chunk, idx) => {
		const worker = workers[(pool.nextIdx + idx) % workers.length];
		const id = `gp-${++pool.seq}`;
		return new Promise((resolve, reject) => {
			pool.pending.set(id, { resolve, reject, worker });
			worker.postMessage({ id, writeRoot, fnDesc, paths: chunk });
		});
	});
	pool.nextIdx = (pool.nextIdx + chunkCount) % workers.length;

	const chunkResults = await Promise.all(chunkPromises);
	const ordered = new Array(paths.length);
	const readEntries = [];
	for (let c = 0; c < chunkResults.length; c += 1) {
		const res = chunkResults[c];
		for (let j = 0; j < res.results.length; j += 1) {
			const origIndex = c + j * chunkCount;
			ordered[origIndex] = readUfss(res.results[j]);
		}
		if (Array.isArray(res.readEntries)) {
			for (const r of res.readEntries) readEntries.push(r);
		}
	}
	return { results: ordered, readEntries };
}

if (parentPort !== null && workerData?.__globPoolWorker === true) {
	parentPort.on("message", async (msg) => {
		if (!msg || typeof msg !== "object") return;
		const { id, writeRoot, fnDesc, paths } = msg;
		try {
			const results = [];
			const readEntries = [];
			const absolute = (path) => (String(path).startsWith("/") ? String(path) : resolve(writeRoot, String(path)));
			const statValue = async (path) => {
				try {
					const stats = await lstat(absolute(path), { bigint: true });
					return new Map([
						[new EdnKeyword("exists"), true],
						[new EdnKeyword("size"), Number(stats.size)],
						[new EdnKeyword("is-dir"), stats.isDirectory()],
						[new EdnKeyword("is-file"), stats.isFile()],
					]);
				} catch {
					return new Map([[new EdnKeyword("exists"), false]]);
				}
			};
			const session = createSandboxSession({
				agentId: "glob-pool",
				role: "review",
				allowedCapabilities: ["cat", "stat", "ls", "whereAll"],
				createCapabilities: () => ({
					cat: async ({ path }) => {
						const target = absolute(path);
						const content = await readFile(target, "utf8");
						readEntries.push({ path: target });
						return new Map([
							[new EdnKeyword("content"), content],
							[new EdnKeyword("virtual"), false],
						]);
					},
					stat: async ({ path }) => {
						readEntries.push({ path: absolute(path) });
						return statValue(path);
					},
					ls: async ({ path }) => {
						const entries = await readdir(absolute(path));
						readEntries.push({ path: absolute(path) });
						return new Map([
							[new EdnKeyword("exists"), true],
							[new EdnKeyword("entries"), entries],
						]);
					},
				}),
			});
			for (const p of paths) {
				const val = await runSerializedCallable(session, fnDesc, [p]);
				results.push(printUfss(val));
			}
			parentPort.postMessage({ id, ok: true, results, readEntries });
		} catch (error) {
			parentPort.postMessage({ id, ok: false, error: error?.message ?? String(error) });
		}
	});
}
