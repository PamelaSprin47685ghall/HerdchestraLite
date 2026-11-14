import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);
const STRIPPED_ENV = ["BUN_OPTIONS", "NODE_OPTIONS", "BASH_ENV", "ENV", "PROMPT_COMMAND"];
const DEFAULT_IDLE_MS = 30000;
const SPAWN_READY_TIMEOUT_MS = 3000;
const inflightSpawns = new Map();

/**
 * Derive a cross-platform IPC endpoint for `lockRoot`:
 * - Windows: named pipe (`\\.\pipe\herd-lock-<hash>`)
 * - Linux: abstract Unix domain socket (`\0herd-lock-<hash>`, zero disk files)
 * - macOS / other POSIX: short socket path under `os.tmpdir()`
 *
 * @param {string} lockRoot
 * @returns {string}
 */
export function lockEndpointFor(lockRoot) {
	const resolved = resolve(lockRoot || process.cwd());
	const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 16);
	if (process.platform === "win32") return `\\\\.\\pipe\\herd-lock-${hash}`;
	if (process.platform === "linux") return `\0herd-lock-${hash}`;
	return join(tmpdir(), `herd-lock-${hash}.sock`);
}

function isFileSocket(endpoint) {
	return process.platform !== "win32" && !endpoint.startsWith("\0");
}

function cleanDaemonEnv() {
	const env = { ...process.env };
	for (const key of STRIPPED_ENV) {
		delete env[key];
	}
	return env;
}

function resolveRuntimeCandidates() {
	const exe = basename(process.execPath || "");
	if (/^(bun|node)(\.exe)?$/i.test(exe)) {
		return [process.execPath];
	}
	const candidates = [];
	const bunWhich = typeof globalThis.Bun?.which === "function" ? globalThis.Bun.which("bun") : null;
	if (bunWhich) candidates.push(bunWhich);
	candidates.push("bun", "node");
	return [...new Set(candidates)];
}

function writeLine(socket, payload) {
	if (!socket || socket.destroyed || !socket.writable) return false;
	try {
		socket.write(`${JSON.stringify(payload)}\n`);
		return true;
	} catch {
		return false;
	}
}

function probeSocketAlive(endpoint) {
	return new Promise((resolveProbe) => {
		const sock = net.connect(endpoint);
		const done = (alive) => {
			sock.removeAllListeners();
			sock.destroy();
			resolveProbe(alive);
		};
		sock.once("connect", () => done(true));
		sock.once("error", () => done(false));
		sock.setTimeout(250, () => done(false));
	});
}

/**
 * Run the lightweight single-instance IPC lock server on `endpoint`.
 *
 * Connection == lock ownership: if a holder crashes or receives SIGKILL, the OS
 * closes its socket fd immediately and the server hands the lock to the next
 * queued waiter without polling or stale-lock heuristics.
 *
 * @param {{ endpoint: string, idleMs?: number, onReady?: (status: "READY" | "BUSY") => void }} options
 */
export async function startLockDaemon({ endpoint, idleMs = DEFAULT_IDLE_MS, onReady } = {}) {
	if (typeof endpoint !== "string" || endpoint.length === 0) {
		throw new TypeError("startLockDaemon requires a non-empty endpoint");
	}
	const locks = new Map();
	const activeSockets = new Set();
	let idleTimer = null;
	let closing = false;
	let server;

	const entryFor = (key) => {
		let entry = locks.get(key);
		if (!entry) {
			entry = { holder: null, queue: [] };
			locks.set(key, entry);
		}
		return entry;
	};

	const clearIdleTimer = () => {
		if (idleTimer !== null) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
	};

	const shutdownServer = async () => {
		if (closing) return;
		closing = true;
		clearIdleTimer();
		for (const sock of activeSockets) {
			sock.destroy();
		}
		activeSockets.clear();
		await new Promise((resolveClose) => {
			if (!server) {
				resolveClose();
				return;
			}
			server.close(() => resolveClose());
		});
		if (isFileSocket(endpoint)) {
			await unlink(endpoint).catch(() => {});
		}
	};

	const scheduleIdleShutdown = () => {
		if (closing || idleMs <= 0) return;
		if (activeSockets.size > 0 || locks.size > 0) return;
		clearIdleTimer();
		idleTimer = setTimeout(() => {
			if (activeSockets.size === 0 && locks.size === 0) {
				void shutdownServer();
			}
		}, idleMs);
		if (typeof idleTimer.unref === "function") idleTimer.unref();
	};

	const releaseKey = (key, socket) => {
		const entry = locks.get(key);
		if (!entry || entry.holder !== socket) return false;
		entry.holder = null;
		while (entry.queue.length > 0) {
			const next = entry.queue.shift();
			if (next && !next.destroyed && next.writable) {
				entry.holder = next;
				next.__heldKeys.add(key);
				next.__waitKeys.delete(key);
				if (writeLine(next, { ok: true, key })) {
					return true;
				}
				entry.holder = null;
				next.__heldKeys.delete(key);
			}
		}
		if (entry.holder === null && entry.queue.length === 0) {
			locks.delete(key);
		}
		scheduleIdleShutdown();
		return true;
	};

	const handleSocketCleanup = (socket) => {
		activeSockets.delete(socket);
		for (const key of [...socket.__waitKeys]) {
			const entry = locks.get(key);
			if (entry) {
				entry.queue = entry.queue.filter((candidate) => candidate !== socket);
				if (entry.holder === null && entry.queue.length === 0) {
					locks.delete(key);
				}
			}
		}
		socket.__waitKeys.clear();
		for (const key of [...socket.__heldKeys]) {
			socket.__heldKeys.delete(key);
			releaseKey(key, socket);
		}
		scheduleIdleShutdown();
	};

	const handleMessage = (socket, msg) => {
		if (closing || !msg || typeof msg !== "object") return;
		if (msg.op === "shutdown") {
			writeLine(socket, { bye: true });
			void shutdownServer();
			return;
		}
		const key = typeof msg.key === "string" && msg.key.length > 0 ? msg.key : "default";
		if (msg.op === "acquire") {
			const entry = entryFor(key);
			if (entry.holder === null) {
				entry.holder = socket;
				socket.__heldKeys.add(key);
				writeLine(socket, { ok: true, key });
			} else if (entry.holder === socket) {
				writeLine(socket, { ok: true, key });
			} else {
				socket.__waitKeys.add(key);
				entry.queue.push(socket);
			}
			return;
		}
		if (msg.op === "release") {
			socket.__heldKeys.delete(key);
			releaseKey(key, socket);
			writeLine(socket, { released: true, key });
		}
	};

	const createBoundServer = () =>
		new Promise((resolveListen, rejectListen) => {
			const srv = net.createServer((socket) => {
				if (closing) {
					socket.destroy();
					return;
				}
				clearIdleTimer();
				socket.__heldKeys = new Set();
				socket.__waitKeys = new Set();
				activeSockets.add(socket);
				let buffer = "";
				socket.on("data", (chunk) => {
					buffer += chunk.toString("utf8");
					for (;;) {
						const nl = buffer.indexOf("\n");
						if (nl < 0) break;
						const raw = buffer.slice(0, nl).trim();
						buffer = buffer.slice(nl + 1);
						if (raw.length === 0) continue;
						try {
							handleMessage(socket, JSON.parse(raw));
						} catch {
							writeLine(socket, { ok: false, error: "INVALID_JSON" });
						}
					}
				});
				socket.on("close", () => handleSocketCleanup(socket));
				socket.on("error", () => handleSocketCleanup(socket));
			});
			srv.once("error", (err) => rejectListen(err));
			srv.listen(endpoint, () => resolveListen(srv));
		});

	try {
		server = await createBoundServer();
		onReady?.("READY");
		scheduleIdleShutdown();
		return { endpoint, shutdown: shutdownServer };
	} catch (error) {
		if (error?.code === "EADDRINUSE") {
			if (isFileSocket(endpoint)) {
				const alive = await probeSocketAlive(endpoint);
				if (!alive) {
					await unlink(endpoint).catch(() => {});
					try {
						server = await createBoundServer();
						onReady?.("READY");
						scheduleIdleShutdown();
						return { endpoint, shutdown: shutdownServer };
					} catch (retryError) {
						if (retryError?.code === "EADDRINUSE") {
							onReady?.("BUSY");
							return null;
						}
						throw retryError;
					}
				}
			}
			onReady?.("BUSY");
			return null;
		}
		throw error;
	}
}

async function spawnWithRuntime(runtime, endpoint) {
	return new Promise((resolveSpawn, rejectSpawn) => {
		const child = spawn(runtime, [SELF_PATH, "--daemon-b64", Buffer.from(endpoint, "utf8").toString("base64")], {
			detached: true,
			env: cleanDaemonEnv(),
			stdio: ["ignore", "pipe", "ignore"],
		});
		let settled = false;
		let stdoutBuffer = "";
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (child.stdout) {
				child.stdout.removeAllListeners();
				child.stdout.destroy();
			}
			child.removeAllListeners("error");
			child.removeAllListeners("exit");
			child.unref();
			fn(value);
		};
		const timer = setTimeout(() => {
			finish(rejectSpawn, new Error(`lock daemon startup timed out for ${endpoint}`));
		}, SPAWN_READY_TIMEOUT_MS);
		if (typeof timer.unref === "function") timer.unref();

		child.once("error", (err) => finish(rejectSpawn, err));
		child.once("exit", (code) => {
			finish(rejectSpawn, new Error(`lock daemon exited early (${code ?? "unknown"})`));
		});
		child.stdout?.on("data", (chunk) => {
			stdoutBuffer += chunk.toString("utf8");
			const nl = stdoutBuffer.indexOf("\n");
			if (nl >= 0) {
				const line = stdoutBuffer.slice(0, nl).trim();
				if (line === "READY" || line === "BUSY") {
					finish(resolveSpawn, line);
				}
			}
		});
	});
}

async function ensureDaemon(endpoint) {
	const inflight = inflightSpawns.get(endpoint);
	if (inflight) return inflight;
	const task = (async () => {
		if (isFileSocket(endpoint)) {
			const alive = await probeSocketAlive(endpoint);
			if (!alive) await unlink(endpoint).catch(() => {});
			else return "ALIVE";
		}
		let lastError;
		for (const runtime of resolveRuntimeCandidates()) {
			try {
				return await spawnWithRuntime(runtime, endpoint);
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError ?? new Error("failed to start lock daemon");
	})().finally(() => {
		inflightSpawns.delete(endpoint);
	});
	inflightSpawns.set(endpoint, task);
	return task;
}

function makeLockBusyError(endpoint, key, waitedMs) {
	const error = new Error("write lock is busy; it may be held by a running call; retry this operation shortly");
	error.code = "LOCK_BUSY";
	error.retryable = true;
	error.waitedMs = waitedMs;
	error.endpoint = endpoint;
	error.key = key;
	return error;
}

/**
 * Acquire an event-driven cross-process lock via the on-demand IPC daemon.
 *
 * The single deadline timer (via `clock`) only guards overall wait expiration;
 * there is zero polling. If the calling code is using `fake-clock`, the timer is
 * armed synchronously before opening the socket so `clock.advance(...)` fires
 * deterministically.
 */
export function acquireIpcLock({
	endpoint,
	key = "default",
	waitMs = 500,
	clock = {
		now: () => Date.now(),
		setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
		clearTimeout: (id) => globalThis.clearTimeout(id),
	},
} = {}) {
	const targetEndpoint = endpoint || lockEndpointFor(key);
	const started = clock.now();
	let settled = false;
	let timedOut = false;
	let activeSocket = null;
	let timerId = null;

	return new Promise((resolveAcquire, rejectAcquire) => {
		const cleanupTimer = () => {
			if (timerId !== null) {
				clock.clearTimeout(timerId);
				timerId = null;
			}
		};

		const fail = (error) => {
			if (settled) return;
			settled = true;
			cleanupTimer();
			if (activeSocket) {
				activeSocket.removeAllListeners();
				activeSocket.destroy();
				activeSocket = null;
			}
			rejectAcquire(error);
		};

		const onTimeout = () => {
			timedOut = true;
			const waitedMs = Math.max(0, clock.now() - started);
			fail(makeLockBusyError(targetEndpoint, key, waitedMs));
		};

		timerId = clock.setTimeout(onTimeout, waitMs);

		const attemptConnect = (allowSpawn) => {
			if (settled || timedOut) return;
			const sock = net.connect(targetEndpoint);
			activeSocket = sock;
			let buffer = "";

			sock.once("connect", () => {
				if (settled || timedOut) {
					sock.destroy();
					return;
				}
				writeLine(sock, { op: "acquire", key });
			});

			sock.on("data", (chunk) => {
				if (settled || timedOut) return;
				buffer += chunk.toString("utf8");
				for (;;) {
					const nl = buffer.indexOf("\n");
					if (nl < 0) break;
					const raw = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (raw.length === 0) continue;
					let msg;
					try {
						msg = JSON.parse(raw);
					} catch {
						continue;
					}
					if (msg && msg.ok === true) {
						settled = true;
						cleanupTimer();
						const waitedMs = Math.max(0, clock.now() - started);
						let released = false;
						const release = () =>
							new Promise((resolveRelease) => {
								if (released) {
									resolveRelease();
									return;
								}
								released = true;
								if (sock.destroyed) {
									resolveRelease();
									return;
								}
								let done = false;
								const finishRelease = () => {
									if (done) return;
									done = true;
									sock.removeAllListeners();
									if (!sock.destroyed) sock.destroy();
									resolveRelease();
								};
								sock.once("close", finishRelease);
								sock.once("error", finishRelease);
								const onReleaseAck = (ackChunk) => {
									if (ackChunk.toString("utf8").includes('"released":true')) {
										sock.off("data", onReleaseAck);
										sock.end();
									}
								};
								sock.on("data", onReleaseAck);
								if (!writeLine(sock, { op: "release", key })) {
									finishRelease();
								} else {
									const fallback = globalThis.setTimeout(finishRelease, 50);
									if (typeof fallback.unref === "function") fallback.unref();
								}
							});
						sock.removeAllListeners("error");
						sock.once("error", () => {});
						resolveAcquire({
							endpoint: targetEndpoint,
							key,
							waitedMs,
							release,
						});
						return;
					}
				}
			});

			sock.once("error", async (err) => {
				sock.removeAllListeners();
				if (settled || timedOut) return;
				if (activeSocket === sock) activeSocket = null;
				if (allowSpawn && (err?.code === "ENOENT" || err?.code === "ECONNREFUSED")) {
					try {
						await ensureDaemon(targetEndpoint);
						if (!settled && !timedOut) attemptConnect(false);
					} catch (spawnError) {
						fail(spawnError);
					}
					return;
				}
				fail(err);
			});

			sock.once("close", () => {
				if (activeSocket !== sock || settled || timedOut) return;
				fail(new Error("lock connection closed before acquiring lock"));
			});
		};

		attemptConnect(true);
	});
}

/**
 * Gracefully ask the daemon at `endpoint` to shut down (primarily for test cleanup).
 */
export function shutdownIpcDaemon(endpoint) {
	return new Promise((resolveShutdown) => {
		const sock = net.connect(endpoint);
		const finish = () => {
			sock.removeAllListeners();
			sock.destroy();
			resolveShutdown();
		};
		sock.once("connect", () => {
			writeLine(sock, { op: "shutdown" });
		});
		sock.once("data", finish);
		sock.once("close", finish);
		sock.once("error", finish);
		const t = globalThis.setTimeout(finish, 200);
		if (typeof t.unref === "function") t.unref();
	});
}

const daemonArgIndex = process.argv.indexOf("--daemon-b64");
if (daemonArgIndex >= 0 && process.argv[daemonArgIndex + 1]) {
	const endpoint = Buffer.from(process.argv[daemonArgIndex + 1], "base64").toString("utf8");
	startLockDaemon({
		endpoint,
		onReady: (status) => {
			process.stdout.write(`${status}\n`);
			if (status !== "READY") process.exit(0);
		},
	}).catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
