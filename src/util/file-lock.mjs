/**
 * Cooperative file locks for one worktree.
 *
 * `open(path, "wx")` makes acquisition atomic without blocking the event loop:
 * two processes cannot both create the file. The JSON body records
 * `{pid, startedAt, host}` plus the owner and release token. A live owner is
 * never displaced; an owner confirmed dead for at least 30 seconds is reported
 * stale, but even then the lock is left for `/herd-recovery repair` or an
 * operator. Release checks the token so a late caller cannot delete a
 * successor's lock. Every function is asynchronous; no filesystem call may
 * block the host main thread or a shared sandbox worker.
 *
 * Lock hierarchy: integration < writeW < board. Call sites take locks in that
 * order; `LOCK_RANKS` is the single source for the rank values.
 */

import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, resolve } from "node:path";
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

/**
 * Create the lock file exclusively and write its complete body before return.
 *
 * `open(..., "wx")` fails with EEXIST when another process won the race, so the
 * create is atomic. The handle is always closed and a failed create is removed.
 */
async function createLockFile(path, text) {
	const handle = await open(path, "wx", LOCK_MODE);
	try {
		await handle.writeFile(text, "utf8");
		await handle.sync();
	} catch (error) {
		try {
			await handle.close();
		} catch {
			// Cleanup must not hide the write error.
		}
		try {
			await unlink(path);
		} catch {
			// Cleanup must not hide the write error.
		}
		throw error;
	}
	try {
		await handle.close();
	} catch (error) {
		try {
			await unlink(path);
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
 * never deleted. All reads are asynchronous.
 */
export async function inspectLock(path, options = {}) {
	const target = normalizePath(path);
	const agentState = typeof options?.agentState === "function" ? options.agentState : undefined;

	let stats;
	try {
		stats = await stat(target);
	} catch (error) {
		if (error?.code === "ENOENT") return missingLock();
		return { exists: true, content: null, alive: false, stale: false, reason: "unreadable" };
	}

	let raw;
	try {
		raw = await readFile(target, "utf8");
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
export async function acquireLock(path, meta) {
	const target = normalizePath(path);
	requireMeta(meta);

	const content = buildLockContent(meta, requiredString(meta.token, "token", randomUUID));
	const text = serializeLock(content);
	const agentState = meta.agentState;
	await mkdir(dirname(target), { recursive: true });

	try {
		await createLockFile(target, text);
		return { ok: true, handle: { path: target, token: content.token, content } };
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
	}

	let lock = await inspectLock(target, { agentState });
	// The owner may have released between our open and our read. One immediate
	// retry separates that race from a genuinely held lock.
	if (!lock.exists) {
		try {
			await createLockFile(target, text);
			return { ok: true, handle: { path: target, token: content.token, content } };
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
		}
		lock = await inspectLock(target, { agentState });
	}
	return blockedResult(target, lock);
}


/**
 * Wait until the lock file or its directory emits a rename event. Event-driven:
 * no periodic polling. The timeout is only a safety bound, not the normal path.
 */
function waitForLockChange(target, timeoutMs, signal) {
	return new Promise((resolveWait) => {
		let settled = false;
		let timer = null;
		let watcher = null;
		const done = () => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			try {
				watcher?.close();
			} catch {
				// The watcher may already be closed.
			}
			signal?.removeEventListener?.("abort", done);
			resolveWait();
		};
		timer = setTimeout(done, timeoutMs);
		timer.unref?.();
		try {
			watcher = watch(dirname(target), { persistent: false }, (_event, filename) => {
				if (filename === undefined || String(filename) === basename(target)) done();
			});
			watcher.on("error", done);
			// Close the lost-wakeup race: the lock may have been released
			// between the failed acquire and watcher installation.
			void stat(target).then(
				() => {},
				() => done(),
			);
		} catch {
			done();
		}
		if (signal?.aborted) done();
		else signal?.addEventListener?.("abort", done, { once: true });
	});
}

/**
 * Acquire a lock, waiting for release events instead of polling. A live owner
 * is never displaced; a stale owner is returned for the caller's existing
 * recovery decision. `timeoutMs` is injectable so tests do not depend on a
 * hard-coded sleep.
 */
export async function acquireLockWhenFree(path, meta, { timeoutMs = 10_000, signal } = {}) {
	const target = normalizePath(path);
	const deadline = Date.now() + Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 10_000);
	for (;;) {
		const acquired = await acquireLock(target, meta);
		if (acquired.ok || acquired.stale === true || acquired.busy !== true) return acquired;
		if (signal?.aborted) {
			return { ok: false, code: ":UPSTREAM_ABORTED", message: "lock wait was cancelled", lock: lockPathState(target) };
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) return acquired;
		await waitForLockChange(target, remaining, signal);
	}
}

function lockPathState(path) {
	return { path };
}

/**
 * Wait-aware variant of `withLock`. It acquires through `acquireLockWhenFree`
 * and releases in every outcome, preserving `withLock`'s result shape.
 */
export async function withLockWhenFree(path, meta, fn, options = {}) {
	if (typeof fn !== "function") {
		throw invalidArgument("withLockWhenFree requires a function", {
			argument: "fn",
			expected: "a function",
			actual: fn,
		});
	}
	const acquired = await acquireLockWhenFree(path, meta, options);
	if (!acquired.ok) return acquired;
	let value;
	try {
		value = await fn(acquired.handle);
	} catch (error) {
		attachRelease(error, await safeRelease(acquired.handle));
		throw error;
	}
	return { ok: true, value, release: await safeRelease(acquired.handle) };
}

/**
 * Release a lock only when the caller still holds its token.
 *
 * A missing file is an idempotent miss. A different token, corrupt content, or
 * a token-less file is never deleted.
 */
export async function releaseLock(handle) {
	if (handle === null || typeof handle !== "object" || typeof handle.path !== "string" || handle.path.length === 0) {
		return { released: false, reason: "invalid-handle" };
	}
	const target = normalizePath(handle.path);

	let raw;
	try {
		raw = await readFile(target, "utf8");
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
		await unlink(target);
	} catch (error) {
		if (error?.code === "ENOENT") return { released: false, reason: "missing" };
		return { released: false, reason: "unlink-failed" };
	}
	return { released: true };
}

async function safeRelease(handle) {
	try {
		return await releaseLock(handle);
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

	const acquired = await acquireLock(path, meta);
	if (!acquired.ok) return acquired;

	let value;
	try {
		value = await fn(acquired.handle);
	} catch (error) {
		attachRelease(error, await safeRelease(acquired.handle));
		throw error;
	}

	const release = await safeRelease(acquired.handle);
	return { ok: true, value, released: release.released, release };
}