/**
 * Dedicated Worker thread host for the ClojureScript sandbox.
 *
 * Keeps all Cherry/CEK evaluation, `where` diagnostics, and VFS operations off
 * the `omp` main thread so heavy CPU work cannot block UI rendering or input.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

let postFromWorker = parentPort ? (message) => postFromWorker?.(message) : null;
import { herdError } from "../util/errors.mjs";
import { withLockWhenFree } from "../util/file-lock.mjs";
import { cherryStatus, loadCherry } from "./cherry.mjs";
import { parkedNames, parkProgramOnDeadline } from "./evaluator.mjs";
import { buildSandboxTools } from "./tools.mjs";

const TOOL_NAMES = Object.freeze({
	plan: "clj_plan",
	devops: "clj_devops",
	review: "clj_review",
	worker: "clj_worker",
});

const state = {
	bundles: new Map(),
	callMeta: new Map(),
	activeSignals: new Map(),
	writeGateQueues: new Map(),
	pendingHostTools: new Map(),
	pendingTokens: new Map(),
	hostSeq: 0,
};

function errorText(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function toolFailure(error) {
	const code = error?.code ?? ":INVALID_ARGUMENT";
	return {
		content: [{ type: "text", text: `${code}: ${errorText(error)}` }],
		details: { code },
		isError: true,
	};
}

function requestToken(sessionKey, kind, paths) {
	const id = `token-${++state.hostSeq}`;
	return new Promise((resolve, reject) => {
		state.pendingTokens.set(id, { resolve, reject });
		postFromWorker?.({ type: "tokenAcquire", id, sessionKey, kind, paths });
	});
}

function releaseToken(sessionKey, token) {
	if (!token || !Array.isArray(token.ids)) return;
	postFromWorker?.({ type: "tokenRelease", sessionKey, ownerId: token.owner, ids: token.ids });
}

function createGlobalGate(root, ownerId, sessionKey, onWaitLock) {
	const lockDir = join(root, ".herd", "locks");
	const lockPath = join(lockDir, "clj-core.cross-process.lock");
	return {
		async runExclusive(run, signal) {
			onWaitLock?.(true);
			try {
				await mkdir(lockDir, { recursive: true });
				const token = await requestToken(sessionKey, "global", []);
				try {
					const acquired = await withLockWhenFree(
						lockPath,
						{
							lock_id: "clj-core",
							purpose: "clj-core global write",
							slice_id: "clj-core",
							owner_agent_id: ownerId,
							pid: process.pid,
						},
						run,
						{ signal },
					);
					if (acquired?.ok) return acquired.value;
					throw herdError(acquired?.code ?? ":BOARD_CONFLICT", acquired?.message ?? "cross-process lock is held", {
						lock: lockPath,
					});
				} finally {
					releaseToken(sessionKey, token);
				}
			} finally {
				onWaitLock?.(false);
			}
		},
	};
}

function createPathGate(sessionKey, onWaitLock) {
	return {
		async runExclusive(paths, run) {
			onWaitLock?.(true);
			try {
				const token = await requestToken(sessionKey, "path", paths);
				try {
					return await run();
				} finally {
					releaseToken(sessionKey, token);
				}
			} finally {
				onWaitLock?.(false);
			}
		},
	};
}

function createWriteGate(root, ownerId, onWaitLock, lockWaitMs = 10_000) {
	const lockPath = join(root, ".herd", "locks", "clj-core.write-w.lock");
	return {
		async runExclusive(run, signal) {
			await mkdir(dirname(lockPath), { recursive: true });
			const prev = state.writeGateQueues.get(lockPath);
			if (prev !== undefined) {
				onWaitLock?.(true);
			}
			let releaseQueue;
			const next = new Promise((resolve) => {
				releaseQueue = resolve;
			});
			state.writeGateQueues.set(lockPath, next);
			if (prev !== undefined) {
				await prev;
			}
			try {
				const acquired = await withLockWhenFree(
					lockPath,
					{
						lock_id: "clj-core",
						purpose: "clj-core protected write",
						slice_id: "clj-core",
						owner_agent_id: ownerId,
						pid: process.pid,
					},
					run,
					{ timeoutMs: lockWaitMs, signal },
				);
				if (acquired?.ok) return acquired.value;
				throw herdError(acquired?.code ?? ":BOARD_CONFLICT", acquired?.message ?? "write gate is held", {
					lock: lockPath,
					next: "wait for the current holder to finish, then retry the same program",
				});
			} finally {
				onWaitLock?.(false);
				releaseQueue();
				if (state.writeGateQueues.get(lockPath) === next) {
					state.writeGateQueues.delete(lockPath);
				}
			}
		},
	};
}

function createControl() {
	return {
		async markApplying(payload = {}) {
			return { ok: true, actionId: payload.actionId ?? "clj-core" };
		},
		async publishResult() {
			return { ok: true };
		},
		async markUncertain() {
			return { ok: true };
		},
		async markRunning(payload = {}) {
			return { ok: true, actionId: payload.actionId ?? "clj-core" };
		},
		async verifyClaim() {
			return { ok: true };
		},
	};
}

function createPorts(root, ownerId, withWriteGate, onCallActivity, onWaitLock, sessionKey, hostTools = {}) {
	return {
		...(withWriteGate ? { writeGate: createWriteGate(root, ownerId, onWaitLock) } : {}),
		pathGate: createPathGate(sessionKey, onWaitLock),
		globalGate: createGlobalGate(root, ownerId, sessionKey, onWaitLock),
		control: createControl(),
		identity: { agent_id: ownerId, status: "alive", term_id: "clj-core" },
		claim: { claim_id: "clj-core", status: "active", term_id: "clj-core" },
		...(hostTools.read === true ? { hostRead: (args) => callHostTool(sessionKey, "read", args) } : {}),
		...(hostTools.write === true ? { hostWrite: (args) => callHostTool(sessionKey, "write", args) } : {}),
		callMeta: (toolCallId) => state.callMeta.get(toolCallId),
		agentId: ownerId,
		sessionKey: ownerId,
		...(onCallActivity ? { onCallActivity } : {}),
	};
}

function callHostTool(sessionKey, name, params) {
	const id = `host-${++state.hostSeq}`;
	return new Promise((resolve, reject) => {
		if (postFromWorker === null) {
			reject(herdError("HOST_API_MISMATCH", "host tool bridge is unavailable outside the sandbox worker"));
			return;
		}
		state.pendingHostTools.set(id, { resolve, reject });
		postFromWorker?.({ type: "hostTool", id, sessionKey, name, params });
	});
}

async function buildBundle(role, root, ownerId, onCallActivity, onWaitLock, sessionKey, hostTools = {}) {
	const callLogDir = role === "devops" ? join(root, ".herd", "artifacts", "clj-core") : undefined;
	if (callLogDir !== undefined) await mkdir(callLogDir, { recursive: true });
	return buildSandboxTools({
		role,
		roots: {
			writeRoot: root,
			...(callLogDir !== undefined ? { callLogDir } : {}),
		},
		ports: createPorts(root, ownerId, role === "worker" || role === "devops", onCallActivity, onWaitLock, sessionKey, hostTools),
	});
}

function collectParkedList(sessionKey) {
	const prefix = `${sessionKey}\u0000`;
	const list = [];
	for (const [bundleKey, built] of state.bundles.entries()) {
		if (!bundleKey.startsWith(prefix)) continue;
		const role = bundleKey.slice(prefix.length);
		const toolName = TOOL_NAMES[role] ?? role;
		for (const name of parkedNames(built.session)) {
			list.push({ toolName, name });
		}
	}
	return list;
}

function emitParkedList(sessionKey) {
	postFromWorker?.({ type: "parkedList", sessionKey, list: collectParkedList(sessionKey) });
}

export function createSandboxRuntime(postMessage) {
		postFromWorker = typeof postMessage === "function" ? postMessage : postFromWorker;
		return async (msg) => {

		if (!msg || typeof msg !== "object") return;

		if (msg.type === "tokenGranted" || msg.type === "tokenFailed") {
			const pending = state.pendingTokens.get(msg.id);
			if (pending !== undefined) {
				state.pendingTokens.delete(msg.id);
				if (msg.type === "tokenFailed") {
					pending.reject(herdError(":BOARD_CONFLICT", msg.error ?? "token request failed"));
				} else {
					pending.resolve(msg);
				}
			}
			return;
		}

		if (msg.type === "hostToolDone") {
			const pending = state.pendingHostTools.get(msg.id);
			if (pending !== undefined) {
				state.pendingHostTools.delete(msg.id);
				if (msg.error) pending.reject(herdError(msg.code ?? "HOST_API_MISMATCH", msg.error));
				else pending.resolve(msg.result);
			}
			return;
		}

		if (msg.type === "init") {
			await loadCherry();
			postFromWorker?.({ type: "initDone", id: msg.id, cherry: cherryStatus() });
			return;
		}

		if (msg.type === "disposeSession") {
			const keys = Array.isArray(msg.sessionKeys) ? msg.sessionKeys : [];
			for (const sk of keys) {
				const prefix = `${sk}\u0000`;
				for (const bundleKey of state.bundles.keys()) {
					if (bundleKey.startsWith(prefix)) state.bundles.delete(bundleKey);
				}
			}
			return;
		}

		if (msg.type === "abort") {
			state.activeSignals.get(msg.callId)?.abort();
			return;
		}

		if (msg.type === "parkOnDeadline") {
			const bundleKey = `${msg.sessionKey}\u0000${msg.role}`;
			const built = state.bundles.get(bundleKey);
			const result = built
				? parkProgramOnDeadline(built.session, msg.programName)
				: { ok: false, code: "PROGRAM_UNKNOWN", name: msg.programName };
			emitParkedList(msg.sessionKey);
			postFromWorker?.({ type: "parkResult", id: msg.id, result });
			return;
		}

		if (msg.type === "listParked") {
			postFromWorker?.({ type: "parkedResult", id: msg.id, list: collectParkedList(msg.sessionKey) });
			return;
		}

		if (msg.type === "exec") {
			const { id, sessionKey, role, root, ownerId, callId, programName, code, deadlineAt, hostTools } = msg;
			const bundleKey = `${sessionKey}\u0000${role}`;
			let built = state.bundles.get(bundleKey);
			try {
				if (built === undefined) {
					const onCallActivity = ({ active, program }) => {
						postFromWorker?.({ type: "callActivity", id, sessionKey, role, active, program });
					};
					const onWaitLock = (waiting = true) => {
						postFromWorker?.({ type: "waitLock", id, sessionKey, role, waiting });
					};
					built = await buildBundle(role, root, `${ownerId}:${role}`, onCallActivity, onWaitLock, sessionKey, hostTools);
					state.bundles.set(bundleKey, built);
				}
			} catch (error) {
				postFromWorker?.({ type: "execDone", id, result: toolFailure(error) });
				return;
			}

			state.callMeta.set(callId, { deadlineAt });
			const controller = new AbortController();
			state.activeSignals.set(callId, controller);
			let result;
			try {
				result = await built.tool.execute(callId, { name: programName, code }, controller.signal);
			} catch (error) {
				result = toolFailure(error);
			} finally {
				state.callMeta.delete(callId);
				state.activeSignals.delete(callId);
				emitParkedList(sessionKey);
			}
			postFromWorker?.({ type: "execDone", id, result });
		}
		};
	}

if (parentPort !== null) {
	const handle = createSandboxRuntime((message) => parentPort.postMessage(message));
	parentPort.on("message", (msg) => { void handle(msg); });
}
