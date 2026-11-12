/**
 * Cooperative file locks for one worktree.
 *
 * `openSync(path, "wx")` makes acquisition atomic: two processes cannot both
 * create the file. The JSON body records `{pid, startedAt, host}` plus the
 * owner and release token. A live owner is never displaced; an owner confirmed
 * dead for at least 30 seconds is reported stale, but even then the lock is
 * left for `/herd-recovery repair` or an operator. Release checks the token so
 * a late caller cannot delete a successor's lock.
 *
 * Lock hierarchy: integration < writeW < board. Call sites take locks in that
 * order; `LOCK_RANKS` is the single source for the rank values.
 */

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { herdError } from "./errors.mjs";

export const LOCK_RANKS = Object.freeze({
	integration: 0,
	writeW: 1,
	board: 2,
});

const STALE_AFTER_MS = 30_000;
const LOCK_MODE = 0o600;

function invalidArgument(message, data) {
	return herdError(":INVALID_ARGUMENT", message, data);
}

function normalizePath(path, argument = "path") {
	if (typeof path !== "string" || path.length === 0) {
		throw invalidArgument(`${argument} must be a non-empty string`, {
			argument,
			expected: "a non-empty string",
			actual: path,
			next: `pass a non-empty string for ${argument}`,
		});
	}
	return resolve(path);
}

function requireMeta(meta) {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
		throw invalidArgument("lock metadata must be an object", {
			argument: "meta",
			expected: "a plain object",
			actual: meta,
			next: "pass the lock owner fields as an object",
		});
	}
}

function optionalString(meta, key) {
	const value = meta[key];
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw invalidArgument(`lock metadata ${key} must be a string`, {
			argument: key,
			expected: "a string or null",
			actual: value,
			next: `pass a string for ${key}, or omit it`,
		});
	}
	return value;
}

function requiredString(value, key, fallback) {
	if (value === undefined || value === null) return fallback();
	if (typeof value !== "string" || value.length === 0) {
		throw invalidArgument(`lock metadata ${key} must be a non-empty string`, {
			argument: key,
			expected: "a non-empty string",
			actual: value,
			next: `pass a non-empty string for ${key}, or omit it`,
		});
	}
	return value;
}

function normalizePid(value) {
	if (value === undefined || value === null) return process.pid;
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw invalidArgument("lock metadata pid must be a positive integer", {
			argument: "pid",
			expected: "a positive integer",
			actual: value,
			next: "pass process.pid or another positive integer",
		});
	}
	return value;
}

/**
 * Normalize the lock birth time to one canonical ISO-8601 string.
 *
 * New callers pass `startedAt`; `started_at` stays accepted because existing
 * gate, board and worktree call sites still send the snake_case field. Only
 * `startedAt` is stored.
 */
function normalizeStartedAt(meta) {
	const value = meta.startedAt ?? meta.started_at;
	if (value === undefined) return new Date().toISOString();
	const ms = typeof value === "string" && value.trim().length > 0 ? Date.parse(value) : Number.NaN;
	if (!Number.isFinite(ms)) {
		throw invalidArgument("lock metadata startedAt must be an ISO-8601 string", {
			argument: "startedAt",
			expected: "an ISO-8601 string",
			actual: value,
			next: "pass new Date().toISOString(), or omit the field",
		});
	}
	return new Date(ms).toISOString();
}

/**
 * Build the exact JSON content stored in the lock file.
 *
 * `meta.agentState` is a runtime-only diagnostic input and is never stored.
 */
function buildLockContent(meta, token) {
	return {
		lock_id: requiredString(meta.lock_id, "lock_id", randomUUID),
		purpose: optionalString(meta, "purpose"),
		slice_id: optionalString(meta, "slice_id"),
		owner_agent_id: optionalString(meta, "owner_agent_id"),
		owner_term_id: optionalString(meta, "owner_term_id"),
		pid: normalizePid(meta.pid),
		startedAt: normalizeStartedAt(meta),
		host: optionalString(meta, "host") ?? hostname(),
		token,
	};
}

function serializeLock(content) {
	return `${JSON.stringify(content)}\n`;
}

function writeAll(fd, text) {
	const bytes = Buffer.from(text, "utf8");
	let offset = 0;
	while (offset < bytes.length) {
		const written = writeSync(fd, bytes, offset, bytes.length - offset);
		if (written <= 0) {
			throw new Error("lock write made no progress");
		}
		offset += written;
	}
}

/** Create the lock file exclusively and write its complete body before return. */
function createLockFile(path, text) {
	const fd = openSync(path, "wx", LOCK_MODE);
	try {
		writeAll(fd, text);
		fsyncSync(fd);
	} catch (error) {
		try {
			closeSync(fd);
		} catch {
			// Cleanup must not hide the write error.
		}
		try {
			unlinkSync(path);
		} catch {
			// Cleanup must not hide the write error.
		}
		throw error;
	}
	try {
		closeSync(fd);
	} catch (error) {
		try {
			unlinkSync(path);
		} catch {
			// Cleanup must not hide the close error.
		}
		throw error;
	}
}

function parseLockContent(raw) {
	if (raw.trim().length === 0) return null;
	try {
		const value = JSON.parse(raw);
		if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
		return value;
	} catch {
		return null;
	}
}

function lifeState(value) {
	if (typeof value !== "string") return undefined;
	const text = value.trim().replace(/^:/, "").toLowerCase();
	if (text === "alive") return "alive";
	if (text === "dead" || text === "terminated") return "dead";
	return undefined;
}

/**
 * Look up one agent in the runner's live state table.
 *
 * `agentState` is a function `(agentId) => state`. A throwing lookup is
 * unknown, so a broken diagnostic source cannot mark a lock stale.
 */
function agentLifeState(agentState, agentId) {
	if (typeof agentState !== "function" || typeof agentId !== "string" || agentId.length === 0) return undefined;
	try {
		return lifeState(agentState(agentId));
	} catch {
		return undefined;
	}
}

function pidIsAlive(value) {
	if (!Number.isSafeInteger(value) || value <= 0) return undefined;
	try {
		process.kill(value, 0);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		if (error?.code === "EPERM") return true;
		return undefined;
	}
}

function lockAgeMs(content, mtimeMs) {
	const raw = content.startedAt ?? content.started_at;
	const startedAt = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
	const bornAt = Number.isFinite(startedAt) ? startedAt : mtimeMs;
	return Number.isFinite(bornAt) ? Math.max(0, Date.now() - bornAt) : 0;
}

function missingLock() {
	return { exists: false, content: null, alive: false, stale: false, reason: "missing" };
}

function unknownLock(content, reason) {
	return { exists: true, content, alive: false, stale: false, reason };
}

function deadOwnerLock(content, ageMs, reasonStale, reasonRecent) {
	if (ageMs >= STALE_AFTER_MS) {
		return { exists: true, content, alive: false, stale: true, reason: reasonStale };
	}
	return { exists: true, content, alive: false, stale: false, reason: reasonRecent };
}

/**
 * Inspect one lock file without changing it.
 *
 * `agentState` is a function `(agentId) => life_state`. It is checked before
 * the PID because subagents share the parent process PID: a dead agent can
 * still have `process.kill(pid, 0)` succeed.
 *
 * Output: `{exists, content, alive, stale, reason}`. A lock becomes stale only
 * when the owner is known dead and the lock is at least 30 seconds old. Empty,
 * corrupt, or token-less content is an unknown owner: not dead, not stale, and
 * never deleted.
 */
export function inspectLock(path, options = {}) {
	const target = normalizePath(path);
	const agentState = typeof options?.agentState === "function" ? options.agentState : undefined;

	let stats;
	try {
		stats = statSync(target);
	} catch (error) {
		if (error?.code === "ENOENT") return missingLock();
		return { exists: true, content: null, alive: false, stale: false, reason: "unreadable" };
	}

	let raw;
	try {
		raw = readFileSync(target, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return missingLock();
		return { exists: true, content: null, alive: false, stale: false, reason: "unreadable" };
	}

	const content = parseLockContent(raw);
	if (content === null) return unknownLock(null, "corrupt");
	if (typeof content.token !== "string" || content.token.length === 0) {
		return unknownLock(content, "missing-token");
	}

	const ageMs = lockAgeMs(content, stats.mtimeMs);
	const agentId = typeof content.owner_agent_id === "string" ? content.owner_agent_id : null;
	const ownerState = agentLifeState(agentState, agentId);

	if (ownerState === "alive") {
		return { exists: true, content, alive: true, stale: false, reason: "owner-alive" };
	}
	if (ownerState === "dead") {
		return deadOwnerLock(content, ageMs, "owner-dead-stale", "owner-dead-recent");
	}

	const pidAlive = pidIsAlive(content.pid);
	if (pidAlive === true) {
		return { exists: true, content, alive: true, stale: false, reason: "pid-alive" };
	}
	if (pidAlive === false) {
		return deadOwnerLock(content, ageMs, "pid-dead-stale", "pid-dead-recent");
	}
	return unknownLock(content, "unknown-owner");
}

function blockedResult(path, lock) {
	if (lock.stale) {
		const error = herdError(":LOCK_OWNER_DEAD", `lock owner is dead: ${path}`, { path, lock });
		return { ok: false, busy: false, stale: true, lock, error };
	}
	return { ok: false, busy: true, stale: false, lock };
}

/**
 * Try to create one lock file without waiting.
 *
 * A live owner yields a busy result; a dead owner yields a stale result with
 * `:LOCK_OWNER_DEAD`. Neither is ever taken over or deleted. The caller retries
 * a busy lock according to its own deadline.
 */
export function acquireLock(path, meta) {
	const target = normalizePath(path);
	requireMeta(meta);

	const content = buildLockContent(meta, requiredString(meta.token, "token", randomUUID));
	const text = serializeLock(content);
	const agentState = meta.agentState;
	mkdirSync(dirname(target), { recursive: true });

	try {
		createLockFile(target, text);
		return { ok: true, handle: { path: target, token: content.token, content } };
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
	}

	let lock = inspectLock(target, { agentState });
	// The owner may have released between our open and our read. One immediate
	// retry separates that race from a genuinely held lock.
	if (!lock.exists) {
		try {
			createLockFile(target, text);
			return { ok: true, handle: { path: target, token: content.token, content } };
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
		}
		lock = inspectLock(target, { agentState });
	}
	return blockedResult(target, lock);
}

/**
 * Release a lock only when the caller still holds its token.
 *
 * A missing file is an idempotent miss. A different token, corrupt content, or
 * a token-less file is never deleted.
 */
export function releaseLock(handle) {
	if (handle === null || typeof handle !== "object" || typeof handle.path !== "string" || handle.path.length === 0) {
		return { released: false, reason: "invalid-handle" };
	}
	const target = normalizePath(handle.path);

	let raw;
	try {
		raw = readFileSync(target, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return { released: false, reason: "missing" };
		return { released: false, reason: "unreadable" };
	}

	const content = parseLockContent(raw);
	if (content === null) return { released: false, reason: "corrupt" };
	if (typeof content.token !== "string" || content.token.length === 0) {
		return { released: false, reason: "missing-token" };
	}
	if (typeof handle.token !== "string" || handle.token.length === 0 || content.token !== handle.token) {
		return { released: false, reason: "token-mismatch" };
	}

	try {
		unlinkSync(target);
	} catch (error) {
		if (error?.code === "ENOENT") return { released: false, reason: "missing" };
		return { released: false, reason: "unlink-failed" };
	}
	return { released: true };
}

function safeRelease(handle) {
	try {
		return releaseLock(handle);
	} catch (error) {
		return { released: false, reason: "release-failed", error };
	}
}

function attachRelease(error, release) {
	if (typeof error !== "object" || error === null) return;
	try {
		error.release = release;
	} catch {
		// A frozen thrown value cannot carry the release result.
	}
}

/**
 * Run `fn` while holding one lock, then release it in every outcome.
 *
 * Busy and stale acquisitions are returned unchanged. On success the result is
 * `{ok:true, value, released, release}`. When `fn` throws, the original error
 * is rethrown with the release result attached.
 */
export async function withLock(path, meta, fn) {
	if (typeof fn !== "function") {
		throw invalidArgument("withLock requires a function", {
			argument: "fn",
			expected: "a function",
			actual: fn,
			next: "pass the writer function as the third argument",
		});
	}

	const acquired = acquireLock(path, meta);
	if (!acquired.ok) return acquired;

	let value;
	try {
		value = await fn(acquired.handle);
	} catch (error) {
		attachRelease(error, safeRelease(acquired.handle));
		throw error;
	}

	const release = safeRelease(acquired.handle);
	return { ok: true, value, released: release.released, release };
}
