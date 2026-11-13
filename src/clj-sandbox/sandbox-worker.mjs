/**
 * Dedicated Worker thread host for the ClojureScript sandbox.
 *
 * Keeps all Cherry/CEK evaluation, `where` diagnostics, and VFS operations off
 * the `omp` main thread so heavy CPU work cannot block UI rendering or input.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { herdError } from "../util/errors.mjs";
import { withLock } from "../util/file-lock.mjs";
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

function createWriteGate(root, ownerId, onWaitLock) {
	const lockPath = join(root, ".herd", "locks", "clj-core.write-w.lock");
	mkdirSync(join(root, ".herd", "locks"), { recursive: true });
	return {
		async runExclusive(run, signal) {
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
				while (true) {
					if (signal?.aborted) {
						throw herdError("UPSTREAM_ABORTED", "write gate wait was cancelled", { lock: lockPath });
					}
					const acquired = await withLock(
						lockPath,
						{
							lock_id: "clj-core",
							purpose: "clj-core protected write",
							slice_id: "clj-core",
							owner_agent_id: ownerId,
							pid: process.pid,
						},
						run,
					);
					if (acquired?.ok) {
						return acquired.value;
					}
					if (acquired?.code !== ":BOARD_CONFLICT") {
						throw herdError(acquired?.code ?? ":BOARD_CONFLICT", acquired?.message ?? "write gate is held", {
							lock: lockPath,
							next: "wait for the current holder to finish, then retry the same program",
						});
					}
					onWaitLock?.(true);
					await new Promise((resolveWait) => setTimeout(resolveWait, 15));
				}
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

function createPorts(root, ownerId, withWriteGate, onCallActivity, onWaitLock, sessionKey) {
	return {
		...(withWriteGate ? { writeGate: createWriteGate(root, ownerId, onWaitLock) } : {}),
		control: createControl(),
		identity: { agent_id: ownerId, status: "alive", term_id: "clj-core" },
		claim: { claim_id: "clj-core", status: "active", term_id: "clj-core" },
		hostRead: (args) => callHostTool(sessionKey, "read", args),
		hostWrite: (args) => callHostTool(sessionKey, "write", args),
		callMeta: (toolCallId) => state.callMeta.get(toolCallId),
		agentId: ownerId,
		sessionKey: ownerId,
		...(onCallActivity ? { onCallActivity } : {}),
	};
}

function callHostTool(sessionKey, name, params) {
	const id = `host-${++state.hostSeq}`;
	return new Promise((resolve, reject) => {
		if (!parentPort) {
			reject(herdError("HOST_API_MISMATCH", "host tool bridge is unavailable outside the sandbox worker"));
			return;
		}
		state.pendingHostTools.set(id, { resolve, reject });
		parentPort.postMessage({ type: "hostTool", id, sessionKey, name, params });
	});
}

function buildBundle(role, root, ownerId, onCallActivity, onWaitLock, sessionKey) {
	const callLogDir = role === "devops" ? join(root, ".herd", "artifacts", "clj-core") : undefined;
	if (callLogDir !== undefined) mkdirSync(callLogDir, { recursive: true });
	return buildSandboxTools({
		role,
		roots: {
			writeRoot: root,
			...(callLogDir !== undefined ? { callLogDir } : {}),
		},
		ports: createPorts(root, ownerId, role === "worker" || role === "devops", onCallActivity, onWaitLock, sessionKey),
	});
}

function emitParkedList(sessionKey) {
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
	parentPort?.postMessage({ type: "parkedList", sessionKey, list });
}

if (parentPort && workerData?.__sandboxWorker === true) {
	parentPort.on("message", async (msg) => {
		if (!msg || typeof msg !== "object") return;

		if (msg.type === "hostToolDone") {
			const pending = state.pendingHostTools.get(msg.id);
			if (pending !== undefined) {
				state.pendingHostTools.delete(msg.id);
				if (msg.error) pending.reject(herdError("HOST_API_MISMATCH", msg.error));
				else pending.resolve(msg.result);
			}
			return;
		}

		if (msg.type === "init") {
			await loadCherry();
			parentPort.postMessage({ type: "initDone", id: msg.id, cherry: cherryStatus() });
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
			parentPort.postMessage({ type: "parkResult", id: msg.id, result });
			return;
		}

		if (msg.type === "exec") {
			const { id, sessionKey, role, root, ownerId, callId, programName, code, deadlineAt } = msg;
			const bundleKey = `${sessionKey}\u0000${role}`;
			let built = state.bundles.get(bundleKey);
			try {
				if (built === undefined) {
					const onCallActivity = ({ active, program }) => {
						parentPort.postMessage({ type: "callActivity", id, sessionKey, role, active, program });
					};
					const onWaitLock = (waiting = true) => {
						parentPort.postMessage({ type: "waitLock", id, sessionKey, role, waiting });
					};
					built = buildBundle(role, root, `${ownerId}:${role}`, onCallActivity, onWaitLock, sessionKey);
					state.bundles.set(bundleKey, built);
				}
			} catch (error) {
				parentPort.postMessage({ type: "execDone", id, result: toolFailure(error) });
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
			parentPort.postMessage({ type: "execDone", id, result });
		}
	});
}
