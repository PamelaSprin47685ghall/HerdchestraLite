/**
 * Call runner and the small/big lock bridge.
 *
 * VFS write batches are gone: every write reaches the host directly under the
 * path token, and `call` reaches the host under the global token. This file
 * only coordinates a black-box argv run, its board action, output caps, and
 * cancellation. It never writes repository files.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { writeFileAtomic } from "../util/atomic-write.mjs";
import { herdError, messageOf } from "../util/errors.mjs";

const DEFAULT_CALL_LIMITS = Object.freeze({
	inlineBytes: 1024 * 1024,
	logBytes: 64 * 1024 * 1024,
	logPath: null,
	logRoot: null,
});
const HOST_INJECTED_ENV = Object.freeze(["BUN_OPTIONS", "NODE_OPTIONS", "BASH_ENV", "ENV", "PROMPT_COMMAND"]);
const ACTIVE_CLAIM_STATES = new Set(["active", "claimed", "valid", "live"]);
const ALIVE_STATES = new Set(["alive", "active", "running", "live"]);

function invalidArgument(argument, expected, value, next) {
	return herdError(":INVALID_ARGUMENT", `call requires ${argument} to be ${expected}`, {
		argument,
		expected,
		actual: value,
		next: next ?? `pass ${expected} for ${argument}`,
	});
}

function normalizeState(value) {
	if (typeof value !== "string") return undefined;
	const text = value.trim().replace(/^:/, "").toLowerCase();
	return text.length > 0 ? text : undefined;
}

function normalizeCallLimits(limits) {
	const source = limits === undefined || limits === null ? {} : limits;
	if (typeof source !== "object" || Array.isArray(source)) {
		throw invalidArgument("limits", "a plain object", source);
	}
	const result = { ...DEFAULT_CALL_LIMITS };
	for (const key of ["inlineBytes", "logBytes"]) {
		const value = source[key];
		if (value === undefined) continue;
		if (!Number.isSafeInteger(value) || value < 0) {
			throw invalidArgument(`limits.${key}`, "a non-negative safe integer", value);
		}
		result[key] = value;
	}
	if (source.logPath !== undefined && source.logPath !== null) {
		if (typeof source.logPath !== "string" || source.logPath.length === 0) {
			throw invalidArgument("limits.logPath", "a non-empty path", source.logPath);
		}
		result.logPath = source.logPath;
	}
	if (source.actionId !== undefined && source.actionId !== null) {
		if (typeof source.actionId !== "string" || source.actionId.length === 0) {
			throw invalidArgument("limits.actionId", "a non-empty string", source.actionId);
		}
		result.actionId = source.actionId;
	}
	return result;
}

function requireProductionPorts({ control, identity, claim }) {
	if (control === null || typeof control !== "object") {
		throw invalidArgument("control", "a BoardControlPort object", control);
	}
	if (identity === null || typeof identity !== "object") {
		throw invalidArgument("identity", "an ActorIdentity object", identity);
	}
	if (claim === null || typeof claim !== "object") {
		throw invalidArgument("claim", "a ClaimRef object", claim);
	}
}

function requireCallPort(control) {
	if (typeof control?.markRunning !== "function") {
		throw invalidArgument("control.markRunning", "a function", control?.markRunning);
	}
}

function portIdentityFields(identity, claim) {
	return {
		identity,
		claim,
		actor: identity,
		agentId: identity?.agent_id ?? identity?.agentId,
		termId: identity?.term_id ?? identity?.termId,
		claimId: claim?.claim_id ?? claim?.claimId,
		taskId: claim?.task_id ?? claim?.taskId ?? identity?.task_id,
	};
}

async function verifyPorts({ control, identity, claim }) {
	if (identity !== undefined && identity !== null) {
		if (typeof identity.verify === "function") {
			let verdict;
			try {
				verdict = await identity.verify();
			} catch (error) {
				return { code: ":BOARD_CONFLICT", message: `identity verification failed: ${messageOf(error)}` };
			}
			if (verdict === false || (verdict && verdict.ok === false)) {
				return { code: verdict?.code ?? ":ACTOR_DEAD", message: verdict?.message ?? "actor is not alive" };
			}
		}
		const state = normalizeState(identity.life_state ?? identity.lifeState ?? identity.status);
		if (state !== undefined && !ALIVE_STATES.has(state)) {
			return { code: ":ACTOR_DEAD", message: `actor is not alive: ${state}` };
		}
	}
	if (claim !== undefined && claim !== null) {
		if (claim.valid === false || claim.revoked === true) {
			return { code: ":CLAIM_CHANGED", message: "claim is no longer valid" };
		}
		const state = normalizeState(claim.status);
		if (state !== undefined && !ACTIVE_CLAIM_STATES.has(state)) {
			return { code: ":CLAIM_CHANGED", message: `claim is not active: ${state}` };
		}
	}
	if (control && typeof control.verifyClaim === "function") {
		let verdict;
		try {
			verdict = await control.verifyClaim({ identity, claim });
		} catch (error) {
			return { code: ":BOARD_CONFLICT", message: `claim verification failed: ${messageOf(error)}` };
		}
		if (verdict === false || (verdict && verdict.ok === false)) {
			return { code: verdict?.code ?? ":CLAIM_CHANGED", message: verdict?.message ?? "claim rejected" };
		}
	}
	return null;
}

async function callControl(control, method, payload) {
	if (!control || typeof control[method] !== "function") return { ok: true, skipped: true };
	try {
		const result = await control[method](payload);
		if (result && result.ok === false) return { ok: false, result };
		return { ok: true, result };
	} catch (error) {
		return { ok: false, error };
	}
}

async function withWriteGate(writeGate, run) {
	if (typeof writeGate === "function") return await writeGate(run);
	if (writeGate && typeof writeGate.runExclusive === "function") {
		const executed = await writeGate.runExclusive(run);
		if (executed && typeof executed === "object" && executed.status === undefined) {
			if (executed.ok === false) {
				return {
					status: ":rejected",
					code: executed.error?.code ?? ":BOARD_CONFLICT",
					message: executed.error?.message ?? "write gate is busy",
					written: [],
				};
			}
			if ("value" in executed) return executed.value;
		}
		return executed;
	}
	if (writeGate && typeof writeGate.run === "function") return await writeGate.run(run);
	throw invalidArgument("writeGate", "a function or token gate", writeGate);
}

function truncateInline(text, limit) {
	if (typeof text !== "string") return { text: "", truncated: false };
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= limit) return { text, truncated: false };
	let cut = limit;
	while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut -= 1;
	return { text: bytes.subarray(0, cut).toString("utf8"), truncated: true };
}

function utf8Text(bytes) {
	return bytes.toString("utf8");
}

function resolveCallCwd(writeRoot, cwd) {
	if (cwd === undefined || cwd === null || cwd === "") return writeRoot;
	if (typeof cwd !== "string") throw invalidArgument("cwd", "a string", cwd);
	return isAbsolute(cwd) ? cwd : resolve(writeRoot, cwd);
}

function resolveCallLogPath(writeRoot, limits) {
	if (!limits.logPath) return null;
	return isAbsolute(limits.logPath) ? limits.logPath : resolve(writeRoot, limits.logPath);
}

export function callEnvironment(env = process.env) {
	const next = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (HOST_INJECTED_ENV.includes(key)) continue;
		next[key] = value;
	}
	return next;
}

export function defaultRunCommand(argv, { cwd, signal, maxBytes, onHandle } = {}) {
	return new Promise((settle) => {
		if (signal?.aborted) {
			settle({
				stdout: "",
				stderr: "",
				exitCode: null,
				signal: null,
				error: null,
				aborted: true,
				started: false,
				truncated: false,
				managedChildren: false,
				stdioClosed: true,
				externalBestEffort: true,
			});
			return;
		}
		if (
			!Array.isArray(argv) ||
			argv.length === 0 ||
			argv.some((arg) => typeof arg !== "string") ||
			argv[0].length === 0
		) {
			settle({
				stdout: "",
				stderr: "",
				exitCode: null,
				signal: null,
				error: herdError("INVALID_ARGUMENT", "argv must be a non-empty string array", { argv }),
				aborted: false,
				started: false,
				truncated: false,
				managedChildren: false,
				stdioClosed: true,
				externalBestEffort: true,
			});
			return;
		}
		let child;
		try {
			child = spawn(argv[0], argv.slice(1), {
				cwd,
				shell: false,
				env: callEnvironment(),
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			settle({
				stdout: "",
				stderr: "",
				exitCode: null,
				signal: null,
				error,
				aborted: signal?.aborted === true,
				started: false,
				truncated: false,
				managedChildren: false,
				stdioClosed: true,
				externalBestEffort: true,
			});
			return;
		}
		const pid = child.pid;
		const chunks = { stdout: [], stderr: [] };
		const cursors = { stdout: 0, stderr: 0 };
		let totalBytes = 0;
		let truncated = false;
		let aborted = signal?.aborted === true;
		let settled = false;
		let managedChildren = false;
		let exitInfo = null;
		let groupWaitDone = false;
		let closeSeen = false;
		let killTimer = null;
		let closeTimer = null;
		child.stdin?.on("error", () => {});
		const collect = (name) => (chunk) => {
			const room = maxBytes - totalBytes;
			if (room > 0) {
				const take = chunk.subarray(0, Math.min(room, chunk.length));
				chunks[name].push(take);
				totalBytes += take.length;
			}
			if (chunk.length > Math.max(0, room)) truncated = true;
		};
		child.stdout?.on("data", collect("stdout"));
		child.stderr?.on("data", collect("stderr"));
		onHandle?.({
			abort() {
				onAbort();
			},
			writeStdin(input) {
				if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return false;
				try {
					if (typeof input === "string") {
						child.stdin.write(input);
						return true;
					}
					if (input && typeof input === "object") {
						if (typeof input.stdin === "string") child.stdin.write(input.stdin);
						if (input.eof === true) child.stdin.end();
						return true;
					}
				} catch {
					return false;
				}
				return false;
			},
			drainDelta() {
				const fullOut = utf8Text(Buffer.concat(chunks.stdout));
				const fullErr = utf8Text(Buffer.concat(chunks.stderr));
				const stdout = fullOut.slice(cursors.stdout);
				const stderr = fullErr.slice(cursors.stderr);
				cursors.stdout = fullOut.length;
				cursors.stderr = fullErr.length;
				return { stdout, stderr };
			},
		});
		const signalGroup = (name) => {
			if (pid && process.platform !== "win32") {
				try {
					process.kill(-pid, name);
					return;
				} catch {
					// Fall through to the direct child.
				}
			}
			try {
				child.kill(name);
			} catch {
				// The child may have exited between the signal and the kill.
			}
		};
		const groupAlive = () => {
			if (!pid || process.platform === "win32") return false;
			try {
				process.kill(-pid, 0);
				return true;
			} catch (error) {
				return error?.code === "EPERM";
			}
		};
		const snapshot = (extra = {}) => {
			const fullOut = utf8Text(Buffer.concat(chunks.stdout));
			const fullErr = utf8Text(Buffer.concat(chunks.stderr));
			return {
				stdout: fullOut.slice(cursors.stdout),
				stderr: fullErr.slice(cursors.stderr),
				exitCode: exitInfo?.code ?? null,
				signal: exitInfo?.signal ?? null,
				error: null,
				aborted,
				started: true,
				truncated,
				managedChildren,
				stdioClosed: true,
				externalBestEffort: true,
				...extra,
			};
		};
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(killTimer);
			clearTimeout(closeTimer);
			signal?.removeEventListener?.("abort", onAbort);
			settle(value);
		};
		const startCloseGrace = () => {
			if (settled || closeTimer !== null) return;
			closeTimer = setTimeout(() => finish(snapshot({ stdioClosed: false })), 250);
		};
		const maybeFinish = () => {
			if (closeSeen && groupWaitDone) finish(snapshot());
		};
		const onAbort = () => {
			aborted = true;
			signalGroup("SIGTERM");
			killTimer = setTimeout(() => signalGroup("SIGKILL"), 2000);
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		child.on("error", (error) => finish({ ...snapshot({ stdioClosed: false }), error }));
		child.on("exit", (code, exitSignal) => {
			exitInfo = { code, signal: exitSignal };
			// Event-driven: `close` waits for inherited stdio to drain. If the
			// process group still has members at that point, record it as a
			// managed-child risk instead of polling the group in a loop.
			managedChildren = groupAlive();
			groupWaitDone = true;
			if (closeSeen) maybeFinish();
			else startCloseGrace();
		});
		child.on("close", (code, closeSignal) => {
			if (exitInfo === null) exitInfo = { code, signal: closeSignal };
			closeSeen = true;
			maybeFinish();
		});
	});
}

/**
 * Run one argv command under the global write gate. Writes already reached the
 * host one step at a time, so there is no overlay to drain.
 */
export async function runCall({
	io = {},
	writeRoot,
	argv,
	cwd,
	writeGate,
	control,
	identity,
	claim,
	limits,
	signal,
	onCallHandle,
} = {}) {
	requireProductionPorts({ control, identity, claim });
	requireCallPort(control);
	if (typeof writeRoot !== "string" || writeRoot.length === 0) {
		throw invalidArgument("writeRoot", "a non-empty path", writeRoot);
	}
	if (!Array.isArray(argv) || argv.length === 0 || argv.some((arg) => typeof arg !== "string") || argv[0].length === 0) {
		throw invalidArgument("argv", "a non-empty string array", argv);
	}
	const callLimits = normalizeCallLimits(limits);
	const workdir = resolveCallCwd(writeRoot, cwd);
	const resolvedLogPath = resolveCallLogPath(writeRoot, callLimits);
	const runCommand = typeof io.runCommand === "function" ? io.runCommand : defaultRunCommand;
	const writeLog = typeof io.writeFileAtomic === "function" ? io.writeFileAtomic : writeFileAtomic;
	const argc = argv.length;
	if (signal?.aborted) {
		return { status: ":cancelled", code: ":STALE_CONTROL", phase: ":before-call", actionId: null, argv, argc, cwd: workdir, written: [], drained: null };
	}
	return withWriteGate(writeGate, async () => {
		if (signal?.aborted) {
			return { status: ":cancelled", code: ":STALE_CONTROL", phase: ":before-call", actionId: null, argv, argc, cwd: workdir, written: [], drained: null };
		}
		const verdict = await verifyPorts({ control, identity, claim });
		if (verdict) {
			return { status: ":rejected", code: verdict.code, message: verdict.message, phase: ":identity", actionId: null, argv, argc, cwd: workdir, written: [], drained: null };
		}
		let actionId = callLimits.actionId ?? randomUUID();
		const fields = portIdentityFields(identity, claim);
		const marking = await callControl(control, "markRunning", { actionId, argv, argc, cwd: workdir, ...fields });
		if (!marking.ok) {
			return { status: ":rejected", code: marking.result?.code ?? ":BOARD_CONFLICT", message: marking.result?.message ?? `call registration failed: ${messageOf(marking.error)}`, phase: ":register", actionId, argv, argc, cwd: workdir, written: [], drained: null };
		}
		const allocated = marking.result?.receipt?.actionId ?? marking.result?.receipt?.["action-id"] ?? marking.result?.actionId;
		if (callLimits.actionId === undefined && typeof allocated === "string" && allocated.length > 0) actionId = allocated;
		let outcome;
		try {
			outcome = (await runCommand(argv, { cwd: workdir, signal, maxBytes: callLimits.logBytes, ...(onCallHandle ? { onHandle: onCallHandle } : {}) })) ?? {};
		} catch (error) {
			const result = { status: ":outcome-unknown", code: ":BOARD_CONFLICT", phase: ":call", actionId, argv, argc, cwd: workdir, exitCode: null, signal: null, stdout: "", stderr: "", truncated: false, inlineTruncated: false, logTruncated: false, logPath: null, logError: null, managedChildren: false, stdioClosed: true, externalBestEffort: true, written: [], drained: null, recorded: true, error: { code: error?.code ?? null, message: messageOf(error) } };
			const recorded = await callControl(control, "markUncertain", { ...result, ...fields });
			if (!recorded.ok) { result.recorded = false; result.recordError = recorded.error ? messageOf(recorded.error) : recorded.result; }
			return result;
		}
		if (outcome.aborted === true && outcome.started === false) {
			const result = { status: ":cancelled", code: ":STALE_CONTROL", phase: ":before-call", actionId, argv, argc, cwd: workdir, exitCode: null, signal: null, stdout: "", stderr: "", truncated: false, inlineTruncated: false, logTruncated: false, logPath: null, logError: null, managedChildren: false, stdioClosed: true, externalBestEffort: true, written: [], drained: null, recorded: true };
			const published = await callControl(control, "publishResult", { ...result, ...fields });
			if (!published.ok) { result.recorded = false; result.recordError = published.error ? messageOf(published.error) : published.result; }
			return result;
		}
		const stdout = truncateInline(outcome.stdout ?? "", callLimits.inlineBytes);
		const stdoutBytes = Buffer.byteLength(stdout.text, "utf8");
		const stderr = truncateInline(outcome.stderr ?? "", Math.max(0, callLimits.inlineBytes - stdoutBytes));
		const rawLog = `${outcome.stdout ?? ""}${outcome.stderr ?? ""}`;
		const log = truncateInline(rawLog, callLimits.logBytes);
		const logTruncated = Boolean(outcome.truncated || log.truncated);
		const inlineTruncated = stdout.truncated || stderr.truncated || logTruncated;
		const truncated = inlineTruncated || logTruncated;
		let logPath = resolvedLogPath;
		let logError = null;
		if (logPath) {
			try {
				await writeLog(dirname(logPath), basename(logPath), log.text);
			} catch (error) {
				logError = messageOf(error);
				logPath = null;
			}
		}
		const status = outcome.aborted === true ? ":outcome-unknown" : outcome.error ? ":failed" : outcome.exitCode === 0 ? ":completed" : ":failed";
		const result = { status, code: truncated ? ":OUTPUT_TRUNCATED" : null, phase: ":call", actionId, argv, argc, cwd: workdir, exitCode: outcome.exitCode ?? null, signal: outcome.signal ?? null, stdout: stdout.text, stderr: stderr.text, truncated, inlineTruncated, logTruncated, logPath, logError, managedChildren: outcome.managedChildren === true, stdioClosed: outcome.stdioClosed !== false, externalBestEffort: outcome.externalBestEffort !== false, written: [], drained: null, recorded: true };
		if (outcome.error) result.error = { code: outcome.error.code ?? null, message: messageOf(outcome.error) };
		const recorded = status === ":outcome-unknown" ? await callControl(control, "markUncertain", { ...result, ...fields }) : await callControl(control, "publishResult", { ...result, ...fields });
		if (!recorded.ok) { result.recorded = false; result.recordError = recorded.error ? messageOf(recorded.error) : recorded.result; }
		return result;
	});
}

