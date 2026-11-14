/**
 * One auditor's sandbox lifecycle.
 *
 * The factory creates the private temp directories and the short tmux socket
 * path. `start()` launches exactly one bwrap process whose command is
 * `tmux -D` (foreground server, no fork) with `--as-pid-1`; bwrap stays alive
 * as the sandbox shell and `--die-with-parent` ties the tree to omp.
 *
 * The session host runs in a private network namespace with only loopback
 * up. A UNIX-socket relay in the host process connects to one fixed model
 * provider; a small relay inside the sandbox listens on the provider's
 * loopback host:port and bridges to it. No host interface is present, so every
 * host TCP service is unreachable. The nested omp reaches only the relay; the
 * host relay terminates TLS/HTTP to the pinned provider.
 *
 * The session worker keeps the network/IPC Landlock layer, then starts bwrap
 * directly; bwrap's own `--unshare-net` provides the private namespace and
 * loopback. Inside the mount namespace a launcher applies file-reparent and
 * pathname-UNIX rules before the bootstrap starts the relay and execs tmux.
 * Credentials come from the public host `ModelRegistry` API. API-key and
 * header/OAuth modes use the host HTTP relay, so the real credential never
 * enters the sandbox. Env-only providers cannot be proxied as fixed headers;
 * the auditor session refuses them instead of exposing their environment to
 * the nested session. Credentials are never written to plans, evidence, host
 * logs, or process arguments.
 *
 * The per-call clients are still network-isolated (`--unshare-net`). They share
 * the private socket directory with the session host, so they can reach the
 * private tmux socket and the framework's fixed-provider relay, but no host
 * TCP service or host Unix socket. There is no keeper and no supervisor.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { herdError } from "../util/errors.mjs";
import {
	buildBwrapArgs,
	createSandboxedRunCommand,
	findOmp,
	runSandboxedSetup,
	sandboxCapability,
	sandboxMountedPath,
	sandboxPath,
	shellQuote,
} from "./bwrap.mjs";
import { resolveConfiguredEgressTarget } from "./egress-relay.mjs";
import { createHostHttpRelay } from "./http-relay.mjs";
import {
	modelProxyHeaders,
	prepareModelSeed,
	resolveCurrentModel,
	resolveEgressTarget,
	resolveModelAuth,
	selectAuditTransport,
} from "./model-seed.mjs";

const SOCKET_DIR_PATTERN = /^h-[0-9a-f]{8}$/;
const START_TIMEOUT_MS = 10000;
const WORKER_TIMEOUT_MS = 10000;
const STOP_GRACE_MS = 2000;

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (error?.code !== "EPERM") return false;
	}
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
		return state !== "Z" && state !== "X";
	} catch {
		return true;
	}
}

async function waitForPidGone(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await pidAlive(pid))) return true;
		await sleep(25);
	}
	return !(await pidAlive(pid));
}

async function killPid(pid, signal) {
	if (!(await pidAlive(pid))) return;
	try {
		process.kill(pid, signal);
	} catch {
		// Already exited.
	}
}

function startModelWorker(workerData) {
	return new Promise((resolveWorker, rejectWorker) => {
		const worker = new Worker(new URL("./model-worker.mjs", import.meta.url), { workerData });
		worker.unref?.();
		let settled = false;
		const finish = (kind, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (kind === "resolve") {
				// The worker is long-lived; a late error must not crash the host.
				// The child is still reaped by stop() or by the host exit.
				value.worker.on("error", () => {});
				resolveWorker(value);
				return;
			}
			void worker.terminate().catch(() => {});
			rejectWorker(value);
		};
		const timer = setTimeout(
			() => finish("reject", herdError("CAPABILITY_DENIED", "model sandbox worker timed out", {})),
			WORKER_TIMEOUT_MS,
		);
		timer.unref?.();
		worker.once("message", (message) => {
			if (message?.error) {
				finish("reject", herdError("CAPABILITY_DENIED", String(message.error), {}));
				return;
			}
			if (Number.isInteger(message?.pid) && message.pid > 0) {
				// The worker owns the bwrap process. It must stay alive for the
				// sandbox lifetime: bwrap's --die-with-parent binds to the
				// creating thread, so terminating the worker would kill the
				// sandbox. stop() terminates it after the child is gone.
				finish("resolve", { pid: message.pid, worker });
				return;
			}
			finish("reject", herdError("CAPABILITY_DENIED", "model sandbox worker returned no pid", {}));
		});
		worker.once("error", (error) => finish("reject", error));
		worker.once("exit", (code) => {
			if (!settled) {
				finish("reject", herdError("CAPABILITY_DENIED", `model sandbox worker exited ${code}`, {}));
			}
		});
	});
}

function safeSessionName(slug, caseId) {
	// The root contract fixes the exact session name. The 80-char limit belongs
	// to agent-definition names, not tmux session names; truncating here would
	// merge distinct CASEs. Slug and CASE id are validated before this point.
	return `herd-${slug}-${caseId}`;
}

/**
 * Create the paths and the run-command port for one auditor. This does not
 * start any process. If bwrap, tmux, bun, omp, or Landlock ABI 2 is missing,
 * `available` is false and both `start()` and `runCommand()` fail with
 * :CAPABILITY_DENIED.
 * Landlock ABI 2 is required for file-reparent control; newer ABI layers add
 * network and pathname-UNIX restrictions and are reported separately.
 */
export async function createAuditorSandbox({ root, slug, batchId, caseId, evidenceRoot, model, modelRegistry }) {
	if (typeof root !== "string" || root.length === 0) {
		throw herdError("INVALID_ARGUMENT", "createAuditorSandbox needs root", {});
	}
	if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
		throw herdError("INVALID_ARGUMENT", "createAuditorSandbox needs a valid slug", { slug });
	}
	if (typeof caseId !== "string" || !/^CASE-[A-Za-z0-9_-]+$/.test(caseId)) {
		throw herdError("INVALID_ARGUMENT", "createAuditorSandbox needs a valid CASE id", { caseId });
	}
	const capability = await sandboxCapability();
	const auditTmp = join(tmpdir(), `herd-audit-${slug}-${caseId}-${randomUUID()}`);
	const socketDir = join(tmpdir(), `h-${randomBytes(4).toString("hex")}`);
	const socketPath = join(socketDir, "s");
	const sessionName = safeSessionName(slug, caseId);
	const config = {
		root,
		evidenceRoot,
		auditTmp,
		socketDir,
		socketPath,
		sessionName,
		cwd: root,
	};
	let childPid = null;
	let started = false;
	let stopped = false;
	let stopPromise = null;
	let relay = null;
	let modelInfo = null;
	let modelWorker = null;

	await mkdir(auditTmp, { recursive: true, mode: 0o700 });
	await mkdir(socketDir, { recursive: false, mode: 0o700 });
	for (const directory of ["home", "tmp", "run", "cache", "state", "data", "config"]) {
		await mkdir(join(auditTmp, directory), { recursive: true, mode: 0o700 });
	}

	const runCommand = createSandboxedRunCommand(config);

	function info() {
		return {
			available: capability.available,
			reason: capability.reason,
			auditTmp,
			socketDir,
			socketPath,
			sessionName,
			bwrap: capability.bwrap,
			tmux: capability.tmux,
			landlockAbi: capability.landlockAbi,
			landlockNetwork: capability.landlockNetwork,
			landlockScopes: capability.landlockScopes,
			landlockPathnameUnix: capability.landlockPathnameUnix,
			batchId: typeof batchId === "string" && batchId.length > 0 ? batchId : null,
			model: modelInfo,
			bwrapPid: childPid,
			started,
			stopped,
		};
	}

	async function killChild() {
		if (childPid === null) return;
		await killPid(childPid, "SIGTERM");
	}

	async function stopModelWorker() {
		const worker = modelWorker;
		modelWorker = null;
		if (worker === null) return;
		await new Promise((resolveStop) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				void worker.terminate().catch(() => {});
				resolveStop();
			};
			const timer = setTimeout(finish, 3000);
			timer.unref?.();
			worker.once("message", (message) => {
				if (message?.stopped === true) finish();
			});
			worker.once("error", finish);
			try {
				worker.postMessage("shutdown");
			} catch {
				finish();
			}
		});
	}

	async function start() {
		if (!capability.available) {
			throw herdError("CAPABILITY_DENIED", "auditor sandbox is unavailable", {
				reason: capability.reason,
				next: "install bubblewrap, tmux, and bun, and provide Landlock ABI 2; do not run an unsandboxed auditor shell",
			});
		}
		if (started) return info();
		if (stopped) {
			throw herdError("CAPABILITY_DENIED", "auditor sandbox was already stopped", { auditTmp });
		}
		let seed = null;
		try {
			const current = resolveCurrentModel({ model, modelRegistry });
			let preliminaryTarget = null;
			let preliminaryResolved = null;
			try {
				preliminaryTarget = resolveEgressTarget({ model: current });
				preliminaryResolved = await resolveConfiguredEgressTarget({
					host: preliminaryTarget.host,
					port: preliminaryTarget.port,
				});
			} catch {
				// The host auth resolution may supply the base URL instead.
			}
			const auth = await resolveModelAuth({
				model: current,
				modelRegistry,
				allowNoAuth: preliminaryResolved?.private === true || preliminaryTarget?.explicitPrivate === true,
			});
			const target = resolveEgressTarget({ model: current, auth });
			const resolvedTarget =
				preliminaryResolved !== null && preliminaryTarget.host === target.host && preliminaryTarget.port === target.port
					? preliminaryResolved
					: await resolveConfiguredEgressTarget({ host: target.host, port: target.port });
			const privateTarget = target.explicitPrivate === true || resolvedTarget.private === true;
			const transport = selectAuditTransport({ auth, target, resolved: resolvedTarget, model: current });
			const realOmp = await findOmp();
			if (realOmp === null) {
				throw herdError("CAPABILITY_DENIED", "omp is not executable on PATH", {});
			}
			if (!sandboxMountedPath(realOmp)) {
				throw herdError("CAPABILITY_DENIED", "omp is outside the sandbox mount set", {});
			}
			const relaySocket = join(socketDir, "e");
			let headersForRelay = modelProxyHeaders({ auth, api: current.api });
			if (headersForRelay === null) {
				if (privateTarget) {
					headersForRelay = {};
				} else {
					throw herdError("CAPABILITY_DENIED", "model proxy needs a host credential", {
						provider: current.provider,
						model: current.id,
					});
				}
			}
			const listenPort = 18443;
			// Keep the configured hostname in the local base URL so the provider
			// compatibility resolver does not treat it as a local backend. The
			// sandbox hosts file maps it to 127.0.0.1; the host relay still pins
			// the real address and sends the original Host/SNI.
			const localHost = isIP(target.host) === 0 ? target.host : "127.0.0.1";
			const localBaseUrl = `http://${localHost}:${listenPort}${target.basePath ?? ""}`;
			seed = await prepareModelSeed({
				auditTmp,
				socketDir,
				model: current,
				auth,
				target,
				realOmp,
				proxy: { localBaseUrl },
			});
			relay = createHostHttpRelay({
				socketPath: relaySocket,
				host: target.host,
				port: target.port,
				address: resolvedTarget.address,
				protocol: target.protocol,
				headers: headersForRelay,
				apiKey: null,
				allowNonPublic: privateTarget,
				headersProvider: async () => {
					const fresh = await modelRegistry.getApiKeyAndHeaders(current);
					if (!fresh?.ok) {
						if (privateTarget) return {};
						throw new Error("model auth refresh failed");
					}
					const headersForRequest = modelProxyHeaders({ auth: fresh, api: current.api });
					if (headersForRequest !== null) return headersForRequest;
					if (privateTarget) return {};
					throw new Error("model auth refresh produced no headers");
				},
			});
			await relay.start();
			auth.apiKey = "";
			auth.env = {};
			auth.headers = {};
			const modelEgress = {
				host: "127.0.0.1",
				port: listenPort,
				listenPort,
				relaySocket,
			};
			const inner = buildBwrapArgs({
				...config,
				sessionHost: true,
				network: "model",
				modelSeed: seed,
				modelEgress,
			});
			const argv = inner;
			modelInfo = {
				provider: current.provider,
				id: current.id,
				host: target.host,
				port: target.port,
				transport,
			};
			const launched = await startModelWorker({
				argv,
				cwd: root,
				allowedTcpPorts: [listenPort],
				modelEnv: seed.secretEnv,
				wait: false,
			});
			childPid = launched.pid;
			modelWorker = launched.worker;
			if (stopped) {
				await killChild();
				await stopModelWorker();
				throw herdError("AUDIT_ABORTED", "auditor sandbox was stopped while starting", { auditTmp });
			}
		} catch (error) {
			await stop();
			throw error;
		} finally {
			if (seed !== null) seed.secretEnv = "";
		}
		const deadline = Date.now() + START_TIMEOUT_MS;
		while (!(await pathExists(socketPath))) {
			if (stopped) {
				await killChild();
				await stopModelWorker();
				throw herdError("AUDIT_ABORTED", "auditor sandbox was stopped while starting", { auditTmp });
			}
			if (!(await pidAlive(childPid))) {
				await stop();
				throw herdError("CAPABILITY_DENIED", "auditor sandbox tmux server exited before its socket appeared", {
					bwrapPid: childPid,
				});
			}
			if (Date.now() >= deadline) {
				await stop();
				throw herdError("AUDIT_TIMEOUT", "auditor sandbox tmux socket did not appear in time", {
					socketPath,
					timeoutMs: START_TIMEOUT_MS,
				});
			}
			await sleep(20);
		}
		if (stopped) {
			await killChild();
			await stopModelWorker();
			throw herdError("AUDIT_ABORTED", "auditor sandbox was stopped while starting", { auditTmp });
		}
		try {
			const realRoot = await realpath(root);
			const realAuditTmp = await realpath(auditTmp);
			const setupCommand = [
				"tmux",
				"-S",
				shellQuote(socketPath),
				"new-session",
				"-d",
				"-s",
				shellQuote(sessionName),
				"-c",
				shellQuote(realRoot),
				"-e",
				shellQuote(`PATH=${sandboxPath(realAuditTmp)}`),
			].join(" ");
			const setup = await runSandboxedSetup(config, setupCommand, {
				cwd: root,
				signal: AbortSignal.timeout(START_TIMEOUT_MS),
			});
			if (stopped) {
				await killChild();
				await stopModelWorker();
				throw herdError("AUDIT_ABORTED", "auditor sandbox was stopped while starting", { auditTmp });
			}
			if (setup.exitCode !== 0 && !/duplicate session/i.test(setup.stderr ?? "")) {
				throw herdError("CAPABILITY_DENIED", "auditor sandbox could not create its private tmux session", {
					exitCode: setup.exitCode,
					stderr: setup.stderr,
				});
			}
		} catch (error) {
			await stop();
			throw error;
		}
		started = true;
		return info();
	}

	async function removePrivateDirectory(path, pattern) {
		try {
			if (dirname(path) !== tmpdir() || !pattern.test(basename(path))) return;
			const stats = await lstat(path);
			if (!stats.isDirectory() || stats.isSymbolicLink()) return;
			await rm(path, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup of the sandbox's own directory.
		}
	}

	function stop() {
		if (stopPromise !== null) return stopPromise;
		stopped = true;
		stopPromise = (async () => {
			if (relay !== null) {
				await relay.stop().catch(() => {});
				relay = null;
			}
			// Never invoke a host tmux client against a path the sandbox can
			// replace with a symlink. `--die-with-parent` makes bwrap SIGKILL its
			// sandboxed process tree when bwrap itself dies, so killing the bwrap
			// process is sufficient (and cannot be redirected by sandbox files).
			if (childPid !== null) {
				await killPid(childPid, "SIGTERM");
			}
			// The worker thread owns the bwrap process. Terminating it before
			// the child is reaped would send SIGKILL through bwrap's
			// --die-with-parent, which is desired here; the explicit pid kill
			// above remains the fallback when no worker was recorded.
			await stopModelWorker();
			if (childPid !== null) {
				const gone = await waitForPidGone(childPid, STOP_GRACE_MS);
				if (!gone) await killPid(childPid, "SIGKILL");
			}
			await removePrivateDirectory(socketDir, SOCKET_DIR_PATTERN);
			await removePrivateDirectory(auditTmp, /^herd-audit-[A-Za-z0-9_-]+$/);
		})();
		return stopPromise;
	}

	return {
		...info(),
		config,
		runCommand,
		start,
		stop,
		info,
	};
}
