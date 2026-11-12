/**
 * Batch-local VFS, nanosecond stamps, and protected commits.
 *
 * The batch is a private memory overlay. `write`, `mkdir`, `remove`, and
 * `move` change only that overlay. `prepare` maps the ordered operation log to
 * a plan;
 * `commit` takes the injected write gate, rechecks the complete read set and
 * structure baseline, marks the action `:applying`, then applies each file
 * atomically. A hard failure never rolls back and never replays: the result
 * reports applied, pending, and uncertain paths.
 *
 * Ports are injected so this module does not import the board, the runner, or
 * any lock implementation:
 * - `writeGate`: `{runExclusive(fn)}`, `{run(fn)}`, `{acquire(),release(handle)}`,
 *   or a function that accepts `fn`.
 * - `control`: `{markApplying, publishResult, markUncertain, markRunning?}`
 *   plus optional `verifyClaim`. Required for every commit, drain, and call.
 * - `identity`: `{agent_id, term_id, status}` or `{verify()}`.
 * - `claim`: `{claim_id, status}`; invalid when `valid === false` or
 *   `revoked === true`. Identity and claim are also required; there is no
 *   empty-port bypass for production writes.
 *
 * Real files, symbolic links, and directories (including non-empty
 * directories) move by an atomic rename. Until commit, reads and writes below
 * a moved directory resolve through its source path. Chains, round trips,
 * nested targets, child moves, and recreation of moved sources by mkdir,
 * write, or another move follow program order and are supported.
 *
 * The optional `io` argument exists for host adaptation and failure-injection
 * tests. Production callers omit it and receive the Node implementation.
 *
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	unlinkSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { writeFileAtomic } from "../util/atomic-write.mjs";
import { ERROR_CODES, herdError, isHerdError, messageOf } from "../util/errors.mjs";

const NS_PER_SECOND = 1_000_000_000n;
const DEFAULT_LIMITS = Object.freeze({
	fileBytes: 2 * 1024 * 1024,
	batchBytes: 16 * 1024 * 1024,
	operations: 256,
});
const DEFAULT_CALL_LIMITS = Object.freeze({
	inlineBytes: 1024 * 1024,
	logBytes: 64 * 1024 * 1024,
	logPath: null,
	logRoot: null,
});
const ACTIVE_CLAIM_STATES = new Set(["active", "claimed", "valid", "live"]);
const ALIVE_STATES = new Set(["alive", "active", "running", "live"]);

function invalidArgument(argument, expected, value, next) {
	return herdError(":INVALID_ARGUMENT", `vfs requires ${argument} to be ${expected}`, {
		argument,
		expected,
		actual: value,
		next: next ?? `pass ${expected} for ${argument}`,
	});
}

function prepareRejected(path, reason, operationIndex, extra = {}) {
	return herdError(":PREPARE_REJECTED", `batch preparation rejected: ${reason}`, {
		path,
		reason,
		operationIndex,
		...extra,
	});
}

function structureConflict(path, reason, operationIndex, extra = {}) {
	return herdError(":STRUCTURE_CONFLICT", `structure conflict at ${path}: ${reason}`, {
		path,
		reason,
		operationIndex,
		...extra,
	});
}

function limitExceeded(limit, actual, path, operationIndex) {
	return herdError(":LIMIT_EXCEEDED", `batch limit exceeded: ${limit}`, {
		limit,
		actual,
		path,
		operationIndex,
	});
}

function fileConflict(path, reason, expected, current, operationIndex) {
	return herdError(":FILE_CONFLICT", `file conflict at ${path}: ${reason}`, {
		path,
		reason,
		expected,
		current,
		operationIndex,
	});
}

function changedDuringRead(path, before, after) {
	return herdError(":changed-during-read", `file changed while it was read: ${path}`, {
		path,
		before,
		after,
	});
}

function notUtf8(path) {
	return herdError(":NOT_UTF8", `file is not valid UTF-8: ${path}`, {
		path,
		next: "read it as binary or restore valid UTF-8 text",
	});
}

function assertBatch(batch) {
	if (batch === null || typeof batch !== "object" || batch.__vfsBatch !== true) {
		throw invalidArgument("batch", "a batch created by createBatch", batch);
	}
}

function assertPathText(value, argument = "path") {
	if (typeof value !== "string") {
		throw invalidArgument(argument, "a string", value);
	}
	if (value.includes("\0")) {
		throw invalidArgument(argument, "a path without NUL", value, "remove the NUL byte from the path");
	}
	assertWellFormedText(value, argument);
}

function assertWellFormedText(value, argument = "text") {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				throw herdError(":NOT_UTF8", `text contains an unpaired high surrogate: ${argument}`, {
					argument,
					codeUnit: index,
					next: "pass well-formed UTF-16 text; an unpaired surrogate cannot be encoded as UTF-8",
				});
			}
			index += 1;
			continue;
		}
		if (code >= 0xdc00 && code <= 0xdfff) {
			throw herdError(":NOT_UTF8", `text contains an unpaired low surrogate: ${argument}`, {
				argument,
				codeUnit: index,
				next: "pass well-formed UTF-16 text; an unpaired surrogate cannot be encoded as UTF-8",
			});
		}
	}
}

function normalizeLimits(limits) {
	const source = limits === undefined || limits === null ? {} : limits;
	if (typeof source !== "object" || Array.isArray(source)) {
		throw invalidArgument("limits", "a plain object", source);
	}
	const result = {
		fileBytes: DEFAULT_LIMITS.fileBytes,
		batchBytes: DEFAULT_LIMITS.batchBytes,
		operations: DEFAULT_LIMITS.operations,
	};
	for (const key of ["fileBytes", "batchBytes", "operations"]) {
		const value = source[key];
		if (value === undefined) continue;
		if (!Number.isSafeInteger(value) || value < 0) {
			throw invalidArgument(`limits.${key}`, "a non-negative safe integer", value);
		}
		result[key] = value;
	}
	return result;
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
		assertPathText(source.logPath, "limits.logPath");
		result.logPath = source.logPath;
	}
	if (source.logRoot !== undefined && source.logRoot !== null) {
		assertPathText(source.logRoot, "limits.logRoot");
		result.logRoot = source.logRoot;
	}
	if (source.actionId !== undefined && source.actionId !== null) {
		if (typeof source.actionId !== "string" || source.actionId.length === 0) {
			throw invalidArgument("limits.actionId", "a non-empty string", source.actionId);
		}
		result.actionId = source.actionId;
	}
	return result;
}

function isDirectoryStats(stats) {
	return Boolean(stats?.isDirectory());
}

function kindOf(stats) {
	if (!stats) return "missing";
	if (stats.isDirectory()) return "dir";
	if (stats.isFile()) return "file";
	if (stats.isSymbolicLink()) return "symlink";
	return "other";
}

function modeOf(stats) {
	return typeof stats?.mode === "bigint" ? stats.mode & 0o777n : null;
}

function stampOf(stats) {
	const mtimeNs = stats?.mtimeNs;
	const size = stats?.size;
	if (typeof mtimeNs !== "bigint" || typeof size !== "bigint") {
		throw invalidArgument("io.lstat stats", "bigint mtimeNs and size", stats);
	}
	const mtimeSec = mtimeNs >= 0n ? mtimeNs / NS_PER_SECOND : (mtimeNs - (NS_PER_SECOND - 1n)) / NS_PER_SECOND;
	const mtimeNsec = mtimeNs - mtimeSec * NS_PER_SECOND;
	return { mtimeSec, mtimeNsec, size };
}

function sameStamp(left, right) {
	return (
		left !== null &&
		right !== null &&
		left.mtimeSec === right.mtimeSec &&
		left.mtimeNsec === right.mtimeNsec &&
		left.size === right.size
	);
}

function statsSnapshot(stats) {
	if (!stats) return null;
	return { kind: kindOf(stats), ...stampOf(stats) };
}

function pathEqualOrUnder(path, prefix) {
	return path === prefix || path.startsWith(`${prefix}${sep}`);
}

function compareText(left, right) {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function resolveAgainstRoot(root, value) {
	if (value === "") return root;
	return isAbsolute(value) ? resolve(value) : resolve(root, value);
}

function touchBase(batch, path) {
	const existing = batch.base.get(path);
	if (existing) return existing;
	const stats = batch.io.lstat(path);
	const entry = stats
		? { exists: true, kind: kindOf(stats), stamp: stampOf(stats) }
		: { exists: false, kind: "missing", stamp: null };
	batch.base.set(path, entry);
	return entry;
}

function touchAncestors(batch, path) {
	let cursor = dirname(path);
	while (true) {
		touchBase(batch, cursor);
		if (cursor === batch.writeRoot) return;
		const parent = dirname(cursor);
		if (parent === cursor) return;
		cursor = parent;
	}
}

function resolveReadPath(batch, value) {
	assertPathText(value, "path");
	return resolveAgainstRoot(batch.writeRoot, value);
}

function resolveWritePath(batch, value) {
	assertPathText(value, "path");
	return resolveAgainstRoot(batch.writeRoot, value);
}

function resolveOperationPath(batch, value) {
	try {
		return resolveWritePath(batch, value);
	} catch (error) {
		if (error?.code === ":PATH_ESCAPE" && error.data !== null && typeof error.data === "object") {
			if (error.data.operationIndex === undefined) {
				error.data.operationIndex = batch.operations.length + 1;
			}
		}
		throw error;
	}
}

function physicalPath(batch, logical) {
	let best = null;
	for (const [target, source] of batch.aliases) {
		if (logical !== target && !logical.startsWith(`${target}${sep}`)) continue;
		if (best === null || target.length > best.target.length) best = { target, source };
	}
	return best === null ? logical : `${best.source}${logical.slice(best.target.length)}`;
}

function isUnderMovedSource(batch, path) {
	if (isUnderPostMoveDir(batch, path) || isUnderPostMoveFile(batch, path)) return false;
	for (const target of batch.movedTargets) {
		if (pathEqualOrUnder(path, target)) return false;
	}
	for (const source of batch.movedSources) {
		if (pathEqualOrUnder(path, source)) return true;
	}
	return false;
}

function isUnderPostMoveDir(batch, path) {
	for (const dir of batch.postMoveDirs) {
		if (pathEqualOrUnder(path, dir)) return true;
	}
	return false;
}

function isUnderPostMoveFile(batch, path) {
	for (const file of batch.postMoveFiles) {
		if (pathEqualOrUnder(path, file)) return true;
	}
	return false;
}

function isPostMoveShadow(batch, path) {
	for (const dir of batch.postMoveDirs) {
		if (path !== dir && path.startsWith(`${dir}${sep}`)) return true;
	}
	for (const file of batch.postMoveFiles) {
		if (path !== file && path.startsWith(`${file}${sep}`)) return true;
	}
	return false;
}

function clearPostMoveMarks(batch, path) {
	for (const set of [batch.postMoveDirs, batch.postMoveFiles]) {
		for (const key of [...set]) {
			if (key === path || key.startsWith(`${path}${sep}`)) set.delete(key);
		}
	}
}

function viewEntry(batch, path) {
	const overlay = batch.overlay.get(path);
	if (overlay) return overlay;
	if (isPostMoveShadow(batch, path)) return { type: "missing" };
	if (isUnderMovedSource(batch, path)) return { type: "deleted" };
	const physical = physicalPath(batch, path);
	if (physical !== path) {
		const physicalEntry = batch.overlay.get(physical);
		if (physicalEntry) return physicalEntry;
	}
	const stats = batch.io.lstat(physical);
	if (!stats) return { type: "missing" };
	return { type: kindOf(stats), stamp: stampOf(stats), mode: modeOf(stats), real: true, physical };
}

function recordMissingRead(batch, path) {
	const prior = batch.readSet.get(path);
	if (prior) {
		if (prior.exists) {
			throw structureConflict(path, "path disappeared after an earlier read", undefined, {
				expected: prior.kind,
				current: "missing",
			});
		}
		observeEntry(batch, prior);
		return;
	}
	const entry = {
		path,
		exists: false,
		kind: "missing",
		stamp: null,
		size: null,
	};
	batch.readSet.set(path, entry);
	batch.prepared = null;
	observeEntry(batch, entry);
}

function recordRead(batch, path, stats) {
	const stamp = stampOf(stats);
	const kind = kindOf(stats);
	const prior = batch.readSet.get(path);
	if (prior) {
		if (!prior.exists) {
			throw structureConflict(path, "path appeared after an earlier missing read", undefined, {
				expected: "missing",
				current: kind,
			});
		}
		if (prior.kind !== kind) {
			throw structureConflict(path, "path type changed between reads", undefined, {
				expected: prior.kind,
				current: kind,
			});
		}
		if (!sameStamp(prior.stamp, stamp)) {
			throw fileConflict(path, "stamp changed between reads", prior.stamp, stamp, undefined);
		}
		observeEntry(batch, prior);
		return;
	}
	const entry = { path, exists: true, kind, stamp, size: stamp.size };
	batch.readSet.set(path, entry);
	batch.prepared = null;
	observeEntry(batch, entry);
}

function observeEntry(batch, entry) {
	if (batch.observations !== null) batch.observations.observe(batch.observationScope, entry);
}

function readRealText(batch, path) {
	const before = batch.io.lstat(path);
	if (!before) {
		throw structureConflict(path, "file does not exist", undefined);
	}
	const kind = kindOf(before);
	if (kind === "dir") {
		throw structureConflict(path, "path is a directory", undefined);
	}
	if (kind !== "file" && kind !== "symlink") {
		throw structureConflict(path, "path is not a regular file", undefined);
	}
	const stampBefore = stampOf(before);
	let targetReal = null;
	let targetBefore = null;
	let sizeForLimit = stampBefore.size;
	if (kind === "symlink") {
		try {
			targetReal = batch.io.realpath(path);
		} catch (error) {
			throw structureConflict(path, "symbolic link target cannot be resolved", undefined, {
				cause: messageOf(error),
			});
		}
		targetBefore = batch.io.lstat(targetReal);
		if (!targetBefore) {
			throw structureConflict(path, "symbolic link target does not exist", undefined);
		}
		if (targetBefore.isDirectory()) {
			throw structureConflict(path, "symbolic link points to a directory", undefined);
		}
		if (!targetBefore.isFile()) {
			throw structureConflict(path, "symbolic link target is not a regular file", undefined);
		}
		sizeForLimit = targetBefore.size;
	}
	if (sizeForLimit > BigInt(batch.limits.fileBytes)) {
		throw limitExceeded("fileBytes", sizeForLimit.toString(), path, undefined);
	}
	const bytes = batch.io.readFile(path);
	const after = batch.io.lstat(path);
	if (!after || kindOf(after) !== kind || !sameStamp(stampBefore, stampOf(after))) {
		throw changedDuringRead(path, stampBefore, after ? stampOf(after) : null);
	}
	if (targetBefore) {
		const targetAfter = batch.io.lstat(targetReal);
		if (!targetAfter?.isFile() || !sameStamp(stampOf(targetBefore), stampOf(targetAfter))) {
			throw changedDuringRead(path, stampOf(targetBefore), targetAfter ? stampOf(targetAfter) : null);
		}
	}
	if (BigInt(bytes.length) > BigInt(batch.limits.fileBytes)) {
		throw limitExceeded("fileBytes", String(bytes.length), path, undefined);
	}
	let content;
	try {
		content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw notUtf8(path);
	}
	if (targetBefore) {
		recordRead(batch, targetReal, targetBefore);
	}
	recordRead(batch, path, before);
	return { content, stamp: stampBefore, virtual: false };
}

function directoryChildren(batch, path, real) {
	const names = new Set();
	const physical = physicalPath(batch, path);
	if (real) {
		let entries;
		try {
			entries = batch.io.readdir(physical);
		} catch (error) {
			if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return names;
			throw error;
		}
		for (const name of entries) names.add(name);
	}
	for (const [child, entry] of batch.overlay) {
		const parent = dirname(child);
		if (parent !== path && parent !== physical) continue;
		const name = basename(child);
		if (entry.type === "deleted") names.delete(name);
		else names.add(name);
	}
	return names;
}

function moveOverlaySubtree(batch, source, target) {
	const moves = [];
	for (const [key, value] of batch.overlay) {
		if (key === source || key.startsWith(`${source}${sep}`)) {
			moves.push([key, value]);
		}
	}
	for (const [key] of moves) batch.overlay.delete(key);
	for (const [key, value] of moves) {
		batch.overlay.set(`${target}${key.slice(source.length)}`, value);
	}
}

function setOverlay(batch, path, entry) {
	batch.overlay.set(path, entry);
}

function operationSlot(batch, _op, path) {
	const index = batch.operations.length + 1;
	if (batch.operations.length >= batch.limits.operations) {
		throw limitExceeded("operations", String(index), path, index);
	}
	return index;
}

function pushOperation(batch, index, op, path, extra = {}) {
	batch.operations.push({ index, op, path, ...extra });
	// Any overlay change after prepare invalidates the prepared plan. The
	// commit path never applies a plan that no longer matches the batch.
	batch.prepared = null;
}

function textBytes(text) {
	return BigInt(Buffer.byteLength(text, "utf8"));
}

function _makeOnDiskLstat(io) {
	return (path) => {
		const stats = io.lstat(path);
		if (!stats) {
			throw structureConflict(path, "path does not exist", undefined);
		}
		return stats;
	};
}

/**
 * Create one private batch over a write root.
 *
 * `writeRoot` must exist and be a directory. Relative paths resolve against
 * it; absolute paths and `..` are unrestricted. The `io` argument is optional;
 * it supplies filesystem and command ports for host adaptation or
 * failure-injection tests.
 */
export function createBatch({ writeRoot, limits, io, observations, observationScope } = {}) {
	if (typeof writeRoot !== "string" || writeRoot.length === 0) {
		throw invalidArgument("writeRoot", "a non-empty path string", writeRoot);
	}
	const fsPort = io === undefined || io === null ? defaultIo() : normalizeIo(io);
	const writePath = resolve(writeRoot);
	if (dirname(writePath) === writePath) {
		throw invalidArgument("writeRoot", "a directory below the filesystem root", writeRoot);
	}
	const writeStats = fsPort.lstat(writePath);
	if (!isDirectoryStats(writeStats)) {
		throw invalidArgument("writeRoot", "an existing directory", writeRoot, "create the Slice worktree first");
	}
	const normalized = normalizeLimits(limits);
	if (observations !== undefined && observations !== null) {
		if (typeof observations.observe !== "function") {
			throw invalidArgument("observations", "an observation ledger", observations);
		}
		if (observationScope === undefined || observationScope === null || typeof observationScope !== "object") {
			throw invalidArgument("observationScope", "an actor/term scope", observationScope);
		}
		for (const key of ["sessionKey", "actorId", "termId"]) {
			if (typeof observationScope[key] !== "string" || observationScope[key].length === 0) {
				throw invalidArgument(`observationScope.${key}`, "a non-empty string", observationScope[key]);
			}
		}
	} else if (observationScope !== undefined && observationScope !== null) {
		throw invalidArgument("observations", "an observation ledger when observationScope is given", observations);
	}
	return {
		__vfsBatch: true,
		id: randomUUID(),
		writeRoot: writePath,
		limits: normalized,
		io: fsPort,
		overlay: new Map(),
		readSet: new Map(),
		base: new Map(),
		operations: [],
		batchBytes: 0,
		prepared: null,
		actionId: null,
		applying: false,
		uncertain: false,
		aliases: new Map(),
		movedSources: new Set(),
		movedTargets: new Set(),
		postMoveDirs: new Set(),
		postMoveFiles: new Set(),
		observations: observations ?? null,
		observationScope: observations === undefined || observations === null ? null : { ...observationScope },
		committed: 0,
	};
}

/**
 * Read one UTF-8 text file through the batch overlay.
 *
 * Output: `{content, stamp, virtual}`. `stamp` carries BigInt fields for real
 * files and is `null` for a file created in this batch. The read records the
 * real path and stamp in the batch read set. A stamp that changes during the
 * read throws `:changed-during-read`; a stale repeated read throws
 * `:FILE_CONFLICT` or `:STRUCTURE_CONFLICT`.
 */
export function readText(batch, path) {
	assertBatch(batch);
	const target = resolveReadPath(batch, path);
	const overlay = batch.overlay.get(target);
	if (overlay) {
		if (overlay.type === "file") {
			if (overlay.content !== null && overlay.content !== undefined) {
				return { content: overlay.content, stamp: null, virtual: true };
			}
			return readRealText(batch, overlay.physicalSource ?? physicalPath(batch, target));
		}
		if (overlay.type === "symlink") {
			return readRealText(batch, overlay.physicalSource ?? physicalPath(batch, target));
		}
		if (overlay.type === "deleted") {
			throw structureConflict(target, "path was removed in this batch", undefined);
		}
		throw structureConflict(target, "path is a directory", undefined);
	}
	const physical = physicalPath(batch, target);
	if (isPostMoveShadow(batch, target)) {
		throw structureConflict(target, "path does not exist in the recreated directory", undefined);
	}
	if (isUnderMovedSource(batch, target)) {
		throw structureConflict(target, "path was moved away in this batch", undefined);
	}
	if (physical !== target) {
		const physicalOverlay = batch.overlay.get(physical);
		if (physicalOverlay) {
			if (physicalOverlay.type === "deleted") {
				throw structureConflict(target, "path was moved out of this batch", undefined);
			}
			if (physicalOverlay.type === "file") {
				if (physicalOverlay.content !== null && physicalOverlay.content !== undefined) {
					return { content: physicalOverlay.content, stamp: null, virtual: true };
				}
				return readRealText(batch, physicalOverlay.physicalSource ?? physical);
			}
			if (physicalOverlay.type === "symlink") {
				return readRealText(batch, physicalOverlay.physicalSource ?? physical);
			}
			throw structureConflict(target, "path is a directory", undefined);
		}
	}
	return readRealText(batch, physical);
}

/**
 * Report one path through the batch overlay.
 *
 * Real paths are lstat'ed and enter the read set. Missing paths return
 * `{exists:false}` and record that absence as a structural fact. Virtual paths
 * report the in-memory size and never enter the read set.
 */
export function stat(batch, path) {
	assertBatch(batch);
	const target = resolveReadPath(batch, path);
	const overlay = batch.overlay.get(target);
	if (overlay) {
		if (overlay.type === "deleted") {
			return emptyStat(true);
		}
		if (overlay.type === "file" && (overlay.content === null || overlay.content === undefined)) {
			return realStat(batch, overlay.physicalSource ?? physicalPath(batch, target));
		}
		if (overlay.type === "symlink") {
			return realStat(batch, overlay.physicalSource ?? physicalPath(batch, target));
		}
		if (overlay.type === "dir") {
			if (overlay.moved === true) {
				return realStat(batch, overlay.physicalSource ?? physicalPath(batch, target));
			}
			return {
				exists: true,
				size: 0n,
				mtimeSec: null,
				mtimeNsec: null,
				isFile: false,
				isDir: true,
				isSymlink: false,
				virtual: true,
			};
		}
		const size = textBytes(overlay.content);
		return {
			exists: true,
			size,
			mtimeSec: null,
			mtimeNsec: null,
			isFile: true,
			isDir: false,
			isSymlink: false,
			virtual: true,
		};
	}
	const physical = physicalPath(batch, target);
	if (isPostMoveShadow(batch, target)) return emptyStat(true);
	if (isUnderMovedSource(batch, target)) return emptyStat(true);
	if (physical !== target) {
		const physicalOverlay = batch.overlay.get(physical);
		if (physicalOverlay) {
			if (physicalOverlay.type === "deleted") return emptyStat(true);
			if (
				physicalOverlay.type === "file" &&
				physicalOverlay.content !== null &&
				physicalOverlay.content !== undefined
			) {
				const size = textBytes(physicalOverlay.content);
				return {
					exists: true,
					size,
					mtimeSec: null,
					mtimeNsec: null,
					isFile: true,
					isDir: false,
					isSymlink: false,
					virtual: true,
				};
			}
			if (physicalOverlay.type === "symlink" || physicalOverlay.type === "file") {
				return realStat(batch, physicalOverlay.physicalSource ?? physical);
			}
			if (physicalOverlay.type === "dir" && physicalOverlay.moved === true) {
				return realStat(batch, physicalOverlay.physicalSource ?? physical);
			}
			return {
				exists: true,
				size: 0n,
				mtimeSec: null,
				mtimeNsec: null,
				isFile: false,
				isDir: true,
				isSymlink: false,
				virtual: true,
			};
		}
	}
	return realStat(batch, physical);
}

function realStat(batch, physical) {
	const stats = batch.io.lstat(physical);
	if (!stats) {
		recordMissingRead(batch, physical);
		return emptyStat(false);
	}
	const stamp = stampOf(stats);
	recordRead(batch, physical, stats);
	return {
		exists: true,
		size: stamp.size,
		mtimeSec: stamp.mtimeSec,
		mtimeNsec: stamp.mtimeNsec,
		isDir: stats.isDirectory(),
		isFile: stats.isFile(),
		isSymlink: stats.isSymbolicLink(),
		virtual: false,
	};
}

function emptyStat(virtual) {
	return {
		exists: false,
		size: null,
		mtimeSec: null,
		mtimeNsec: null,
		isDir: false,
		virtual,
	};
}

/**
 * List one directory without entering the read set.
 *
 * The result merges real entries with overlay additions and removals. A
 * virtual file or a real non-directory throws `:STRUCTURE_CONFLICT`.
 */
function globToRegExp(pattern) {
	let regex = "^";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				if (pattern[i + 2] === "/") {
					regex += "(?:.*/)?";
					i += 3;
					continue;
				}
				regex += ".*";
				i += 2;
				continue;
			}
			regex += "[^/]*";
		} else if (ch === "?") {
			regex += "[^/]";
		} else if ("\\^$.|+()[]{}".includes(ch)) {
			regex += `\\${ch}`;
		} else {
			regex += ch;
		}
		i += 1;
	}
	regex += "$";
	return new RegExp(regex);
}

/**
 * Pure async glob probe using `Bun.Glob` when available (falling back to
 * `node:fs/promises` recursive readdir). Does not acquire $W$ and does not
 * join `readSet`.
 */
export async function glob(batch, pattern, path = "", options = {}) {
	assertBatch(batch);
	if (typeof pattern !== "string" || pattern.length === 0) {
		throw invalidArgument("pattern", "a non-empty glob string", pattern);
	}
	const target = resolveReadPath(batch, path);
	const dot = options.dot === true;
	const onlyFiles = options.onlyFiles !== false;
	const snapshot = batch.io.lstat(target);
	if (!snapshot) {
		return { exists: false, entries: [] };
	}
	if (!snapshot.isDirectory()) {
		throw structureConflict(target, "path is not a directory", undefined);
	}
	const entries = [];
	if (typeof Bun !== "undefined" && typeof Bun.Glob === "function") {
		const globber = new Bun.Glob(pattern);
		for await (const entry of globber.scan({ cwd: target, onlyFiles, dot })) {
			entries.push(entry.replace(/\\/g, "/"));
		}
	} else {
		const matcher = globToRegExp(pattern.replace(/\\/g, "/"));
		const items = await readdir(target, { withFileTypes: true, recursive: true });
		for (const item of items) {
			if (onlyFiles && !item.isFile()) continue;
			const parent = item.parentPath ?? item.path ?? target;
			const relParent = parent === target ? "" : parent.slice(target.length + 1).replace(/\\/g, "/");
			const rel = relParent.length > 0 ? `${relParent}/${item.name}` : item.name;
			if (!dot && rel.split("/").some((seg) => seg.startsWith("."))) continue;
			if (matcher.test(rel)) {
				entries.push(rel);
			}
		}
	}
	entries.sort();
	return { exists: true, entries };
}

export function list(batch, path) {
	assertBatch(batch);
	const target = resolveReadPath(batch, path);
	const overlay = batch.overlay.get(target);
	let basePath = target;
	let baseNames = [];
	if (overlay) {
		if (overlay.type === "deleted") return { exists: false, entries: [] };
		if (overlay.type === "file" || overlay.type === "symlink") {
			throw structureConflict(target, "path is not a directory", undefined);
		}
		if (overlay.moved === true) {
			basePath = physicalPath(batch, target);
			baseNames = batch.io.readdir(basePath);
		}
	} else {
		const physical = physicalPath(batch, target);
		if (isPostMoveShadow(batch, target)) return { exists: false, entries: [] };
		if (isUnderMovedSource(batch, target)) return { exists: false, entries: [] };
		const physicalOverlay = batch.overlay.get(physical);
		if (physicalOverlay) {
			if (physicalOverlay.type === "deleted") return { exists: false, entries: [] };
			if (physicalOverlay.type === "file" || physicalOverlay.type === "symlink") {
				throw structureConflict(target, "path is not a directory", undefined);
			}
			if (physicalOverlay.type === "dir") {
				if (physicalOverlay.moved === true) {
					basePath = physical;
					baseNames = batch.io.readdir(basePath);
				}
			}
		} else {
			const stats = batch.io.lstat(physical);
			if (!stats) return { exists: false, entries: [] };
			if (!stats.isDirectory()) {
				throw structureConflict(target, "path is not a directory", undefined);
			}
			basePath = physical;
			baseNames = batch.io.readdir(basePath);
		}
	}
	const entries = new Map();
	for (const name of baseNames) {
		const logicalChild = join(target, name);
		const physicalChild = join(basePath, name);
		if (batch.overlay.has(logicalChild)) continue;
		const stats = batch.io.lstat(physicalChild);
		entries.set(name, {
			name,
			isDir: Boolean(stats?.isDirectory()),
			isFile: Boolean(stats?.isFile()),
			isSymlink: Boolean(stats?.isSymbolicLink()),
			virtual: false,
		});
	}
	for (const [child, entry] of batch.overlay) {
		const parent = dirname(child);
		if (parent !== target && parent !== basePath) continue;
		const name = basename(child);
		if (entry.type === "deleted") {
			entries.delete(name);
			continue;
		}
		entries.set(name, {
			name,
			isDir: entry.type === "dir",
			isFile: entry.type === "file",
			isSymlink: entry.type === "symlink",
			virtual: true,
		});
	}
	return {
		exists: true,
		entries: [...entries.values()].sort((left, right) => compareText(left.name, right.name)),
	};
}

/**
 * Write final UTF-8 text into the batch overlay.
 *
 * Existing real files require a prior `readText` or `stat`; existing virtual
 * files may be overwritten by a later write. The final content must be valid
 * UTF-16 without unpaired surrogates, and its UTF-8 size must stay under the
 * single-file and batch limits. No real file is touched.
 */
export function write(batch, path, content, options = {}) {
	assertBatch(batch);
	if (typeof content !== "string") {
		throw invalidArgument("content", "a string", content);
	}
	assertWellFormedText(content, "content");
	const bytes = textBytes(content);
	const target = resolveOperationPath(batch, path);
	const index = operationSlot(batch, "write", target);
	if (bytes > BigInt(batch.limits.fileBytes)) {
		throw limitExceeded("fileBytes", bytes.toString(), target, index);
	}
	if (target === batch.writeRoot) {
		throw structureConflict(target, "cannot write the batch root", index);
	}
	const parent = viewEntry(batch, dirname(target));
	if (parent.type !== "dir") {
		throw structureConflict(
			target,
			parent.type === "missing" ? "parent directory does not exist" : "parent is not a directory",
			index,
			{
				parent: dirname(target),
			},
		);
	}
	const current = viewEntry(batch, target);
	const postMove =
		isUnderPostMoveDir(batch, target) ||
		isUnderPostMoveFile(batch, target) ||
		(isUnderMovedSource(batch, target) && !batch.movedTargets.has(target)) ||
		(batch.movedTargets.has(target) && current.type === "deleted");
	if (current.type === "deleted") {
		if (!postMove) {
			throw structureConflict(target, "write after remove without recreation", index);
		}
	}
	if (current.type === "dir") {
		throw structureConflict(target, "target is a directory", index);
	}
	if (current.type === "symlink") {
		throw structureConflict(target, "writing through a symbolic link is refused", index);
	}
	const physical = postMove ? target : (current.physicalSource ?? current.physical ?? physicalPath(batch, target));
	const base = postMove ? { exists: false, kind: "missing", stamp: null } : touchBase(batch, physical);
	let replaced = false;
	if (current.type === "file") {
		replaced = true;
		if (!postMove && base.exists) {
			if (base.kind !== "file") {
				throw prepareRejected(target, "target base is not a regular file", index, {
					baseKind: base.kind,
				});
			}
			const read = batch.readSet.get(physical);
			if (read?.exists && read.kind === "file" && !sameStamp(read.stamp, base.stamp)) {
				throw fileConflict(target, "file changed since it was read", read.stamp, base.stamp, index);
			}
		}
	}
	if (options.createOnly === true && replaced) {
		throw prepareRejected(target, "createOnly refused an existing file", index);
	}
	if (!postMove) touchAncestors(batch, physical);
	const claimed = BigInt(batch.batchBytes) + bytes;
	if (claimed > BigInt(batch.limits.batchBytes)) {
		throw limitExceeded("batchBytes", claimed.toString(), target, index);
	}
	batch.batchBytes = Number(claimed);
	const writtenEntry = {
		type: "file",
		content,
		mode: current.mode ?? null,
	};
	if (current.moved === true) {
		writtenEntry.moved = true;
		writtenEntry.physicalSource = current.physicalSource;
	}
	setOverlay(batch, target, writtenEntry);
	if (postMove) {
		batch.postMoveDirs.delete(target);
		batch.postMoveFiles.add(target);
	}
	pushOperation(batch, index, "write", target, {
		bytes,
		content,
		mode: writtenEntry.mode,
	});
	return { path: target, bytes, replaced };
}

/**
 * Create one directory in the batch overlay.
 *
 * The target must not exist. A directory removed earlier in the batch may be
 * recreated. The parent must already exist as a directory.
 */
export function mkdir(batch, path) {
	assertBatch(batch);
	const target = resolveOperationPath(batch, path);
	const index = operationSlot(batch, "mkdir", target);
	if (target === batch.writeRoot) {
		throw prepareRejected(target, "batch root already exists", index);
	}
	const parent = viewEntry(batch, dirname(target));
	if (parent.type !== "dir") {
		throw structureConflict(
			target,
			parent.type === "missing" ? "parent directory does not exist" : "parent is not a directory",
			index,
		);
	}
	const current = viewEntry(batch, target);
	if (current.type !== "missing" && current.type !== "deleted") {
		throw prepareRejected(target, "mkdir target already exists", index, { current: current.type });
	}
	const postMove =
		isUnderMovedSource(batch, target) ||
		isUnderPostMoveDir(batch, target) ||
		(batch.movedTargets.has(target) && current.type === "deleted");
	const physical = postMove ? target : physicalPath(batch, target);
	const directoryEntry = { type: "dir", mode: current.mode ?? null };
	if (postMove) {
		batch.postMoveFiles.delete(target);
		batch.postMoveDirs.add(target);
	} else {
		touchBase(batch, physical);
		touchAncestors(batch, physical);
	}
	setOverlay(batch, target, directoryEntry);
	pushOperation(batch, index, "mkdir", target, { mode: directoryEntry.mode });
	return { path: target };
}

/**
 * Remove one file, symbolic link, or empty directory from the batch overlay.
 *
 * A real file or empty directory requires an earlier `readText` or `stat`.
 * Removal of a non-empty directory is refused. A removed path stays removed
 * until this batch ends; `write` or `readText` on it is refused.
 */
export function remove(batch, path) {
	assertBatch(batch);
	const target = resolveOperationPath(batch, path);
	const index = operationSlot(batch, "remove", target);
	if (target === batch.writeRoot) {
		throw prepareRejected(target, "cannot remove the batch root", index);
	}
	const current = viewEntry(batch, target);
	const postMove = isUnderPostMoveDir(batch, target) || isUnderPostMoveFile(batch, target);
	if (current.type === "missing" || current.type === "deleted") {
		throw structureConflict(target, "remove target does not exist", index);
	}
	if (current.type === "dir") {
		const children = directoryChildren(batch, target, Boolean(current.real || current.moved));
		if (children.size > 0) {
			throw structureConflict(target, "directory is not empty", index, { children: [...children].sort() });
		}
	}
	const physical = postMove ? target : (current.physicalSource ?? current.physical ?? physicalPath(batch, target));
	if (!postMove) {
		const base = touchBase(batch, physical);
		if (base.exists || current.moved === true) {
			const read = batch.readSet.get(physical);
			if (read?.exists && read.kind !== current.type) {
				throw structureConflict(target, "path type changed since it was read", index, {
					expected: read.kind,
					current: current.type,
				});
			}
			if (read?.exists && base.exists && !sameStamp(read.stamp, base.stamp)) {
				throw fileConflict(target, "file changed since it was read", read.stamp, base.stamp, index);
			}
		}
		touchAncestors(batch, physical);
	}
	setOverlay(batch, target, { type: "deleted" });
	pushOperation(batch, index, "remove", target, { targetType: current.type });
	return { path: target };
}

/**
 * Move one file, symbolic link, directory, or virtual overlay path.
 *
 * A real source is renamed atomically: its content is not read, so large files
 * and non-empty directories move without the text limit. Its lstat stamp and,
 * for a symlink, its in-root target enter the read set. Until commit, reads,
 * writes, lists, and removes below a moved directory resolve through the
 * source path; pending overlay changes move with it. The target must not exist
 * unless `options.overwrite` is true; an overwritten real target must also
 * have been read. Moving a directory into itself or a descendant is refused.
 * Move steps keep program order, so chains, round trips, nested targets, and
 * recreation of a moved source by another move work.
 */
export function move(batch, source, target, options = {}) {
	assertBatch(batch);
	const sourcePath = resolveOperationPath(batch, source);
	const targetPath = resolveOperationPath(batch, target);
	const index = operationSlot(batch, "move", targetPath);
	if (sourcePath === targetPath) {
		throw prepareRejected(targetPath, "move source equals target", index);
	}
	const current = viewEntry(batch, sourcePath);
	if (current.type === "missing" || current.type === "deleted") {
		throw structureConflict(sourcePath, "move source does not exist", index);
	}
	if (current.type === "dir" && (targetPath === sourcePath || targetPath.startsWith(`${sourcePath}${sep}`))) {
		throw prepareRejected(targetPath, "move would form a cycle", index, { source: sourcePath });
	}
	const targetParent = viewEntry(batch, dirname(targetPath));
	if (targetParent.type !== "dir") {
		throw structureConflict(
			targetPath,
			targetParent.type === "missing" ? "target parent does not exist" : "target parent is not a directory",
			index,
		);
	}
	const targetView = viewEntry(batch, targetPath);
	const targetExists = targetView.type !== "missing" && targetView.type !== "deleted";
	if (targetExists && options.overwrite !== true) {
		throw prepareRejected(targetPath, "move target already exists", index, { current: targetView.type });
	}
	if (targetExists) {
		if (targetView.real) {
			const targetRead = batch.readSet.get(targetView.physical);
			if (targetRead?.exists && !sameStamp(targetRead.stamp, targetView.stamp)) {
				throw fileConflict(targetPath, "target changed since it was read", targetRead.stamp, targetView.stamp, index);
			}
		}
		const sourceKind = current.type === "dir" ? "dir" : "file";
		const targetKind = targetView.type === "dir" ? "dir" : targetView.type === "symlink" ? "file" : "file";
		const compatible = sourceKind === targetKind;
		if (!compatible) {
			throw structureConflict(targetPath, "source and target types are incompatible", index, {
				source: current.type,
				target: targetView.type,
			});
		}
		if (targetView.type === "dir") {
			const children = directoryChildren(batch, targetPath, Boolean(targetView.real || targetView.moved));
			if (children.size > 0) {
				throw structureConflict(targetPath, "overwrite target directory is not empty", index);
			}
		}
	}
	const freedByMove = batch.movedSources.has(targetPath);
	const targetPhysical = targetView.real ? targetView.physical : targetPath;
	if (targetView.real) {
		touchBase(batch, targetPhysical);
		touchAncestors(batch, targetPhysical);
	} else if (targetView.type === "missing" && !freedByMove) {
		touchBase(batch, targetPath);
		touchAncestors(batch, targetPath);
	}
	clearPostMoveMarks(batch, targetPath);
	if (current.real || current.moved === true) {
		let physicalSource;
		let kind;
		let mode;
		let content = null;
		if (current.moved === true) {
			physicalSource = current.physicalSource ?? physicalPath(batch, sourcePath);
			kind = current.type;
			mode = current.mode ?? null;
			content = current.type === "file" ? current.content : null;
		} else {
			physicalSource = current.physical ?? physicalPath(batch, sourcePath);
			const stats = batch.io.lstat(physicalSource);
			if (!stats) {
				throw structureConflict(sourcePath, "move source disappeared", index);
			}
			kind = kindOf(stats);
			mode = modeOf(stats);
			recordRead(batch, physicalSource, stats);
			const sourceOverlay = batch.overlay.get(sourcePath);
			content =
				sourceOverlay?.type === "file" && sourceOverlay.content !== null && sourceOverlay.content !== undefined
					? sourceOverlay.content
					: null;
			touchBase(batch, physicalSource);
			touchAncestors(batch, physicalSource);
		}
		if (kind === "dir") {
			moveOverlaySubtree(batch, sourcePath, targetPath);
		}
		setOverlay(batch, sourcePath, {
			type: "deleted",
		});
		if (kind === "dir") {
			setOverlay(batch, targetPath, {
				type: "dir",
				moved: true,
				physicalSource,
				mode,
			});
		} else if (kind === "symlink") {
			setOverlay(batch, targetPath, {
				type: "symlink",
				moved: true,
				physicalSource,
				mode,
			});
		} else {
			setOverlay(batch, targetPath, {
				type: "file",
				content,
				moved: true,
				physicalSource,
				mode,
			});
		}
		batch.aliases.delete(sourcePath);
		if (targetPath !== physicalSource) batch.aliases.set(targetPath, physicalSource);
		batch.movedTargets.delete(sourcePath);
		batch.movedTargets.add(targetPath);
		batch.movedSources.add(sourcePath);
		batch.movedSources.add(physicalSource);
		pushOperation(batch, index, "move", targetPath, { source: sourcePath });
		return { source: sourcePath, target: targetPath };
	}

	const content = current.type === "file" ? current.content : null;
	const physicalSource = physicalPath(batch, sourcePath);
	touchBase(batch, physicalSource);
	touchAncestors(batch, physicalSource);
	if (current.type === "dir") {
		moveOverlaySubtree(batch, sourcePath, targetPath);
	}
	setOverlay(batch, sourcePath, {
		type: "deleted",
	});
	batch.movedSources.add(sourcePath);
	if (current.type === "dir") {
		setOverlay(batch, targetPath, { type: "dir", mode: current.mode ?? null });
	} else {
		setOverlay(batch, targetPath, {
			type: "file",
			content,
			mode: current.mode ?? null,
		});
	}
	pushOperation(batch, index, "move", targetPath, { source: sourcePath });
	return { source: sourcePath, target: targetPath };
}

/**
 * Build the ordered apply plan from the current overlay.
 *
 * Output: `{ok:true, plan}`. The plan holds the action id, the ordered
 * operations, the complete read set, and the structure baseline. Applying the
 * plan later uses the internal copy, not the caller's copy, so a stale or
 * edited plan cannot authorize a write. Preparation touches no real file.
 */
export function prepare(batch) {
	assertBatch(batch);
	const operations = [];
	for (const op of batch.operations) {
		if (op.op === "write") {
			operations.push({ kind: "write", path: op.path, content: op.content, mode: op.mode ?? null });
		} else if (op.op === "mkdir") {
			operations.push({ kind: "mkdir", path: op.path, mode: op.mode ?? null });
		} else if (op.op === "remove") {
			operations.push({ kind: op.targetType === "dir" ? "remove-dir" : "remove-file", path: op.path });
		} else if (op.op === "move") {
			operations.push({ kind: "move", source: op.source, target: op.path });
		}
	}
	const actionId = batch.actionId ?? randomUUID();
	batch.actionId = actionId;
	const plan = {
		batchId: batch.id,
		actionId,
		token: `${batch.id}:${randomUUID()}`,
		writeRoot: batch.writeRoot,
		operations,
		readSet: [...batch.readSet.values()].map((entry) => ({ ...entry })),
		base: [...batch.base.entries()].map(([path, entry]) => ({ path, ...entry })),
		createdAt: new Date().toISOString(),
	};
	batch.prepared = {
		...plan,
		operations: plan.operations.map((step) => ({ ...step })),
		readSet: plan.readSet.map((entry) => ({
			...entry,
			stamp: entry.stamp === null ? null : { ...entry.stamp },
		})),
		base: plan.base.map((entry) => ({
			...entry,
			stamp: entry.stamp === null ? null : { ...entry.stamp },
		})),
	};
	return { ok: true, plan };
}

function conflictKey(conflict) {
	return `${conflict.code}\0${conflict.path}\0${conflict.reason}`;
}

function recheck(batch, plan) {
	const conflicts = [];
	const seen = new Set();
	const add = (conflict) => {
		const key = conflictKey(conflict);
		if (seen.has(key)) return;
		seen.add(key);
		conflicts.push(conflict);
	};
	for (const entry of plan.readSet) {
		const stats = batch.io.lstat(entry.path);
		if (!entry.exists) {
			if (stats) {
				add({
					code: ":STRUCTURE_CONFLICT",
					path: entry.path,
					reason: "path-appeared-after-missing-read",
					expected: null,
					current: statsSnapshot(stats),
				});
			}
			continue;
		}
		if (!stats) {
			add({
				code: ":FILE_CONFLICT",
				path: entry.path,
				reason: "path-missing-after-read",
				expected: { kind: entry.kind, stamp: entry.stamp },
				current: null,
			});
			continue;
		}
		if (kindOf(stats) !== entry.kind) {
			add({
				code: ":STRUCTURE_CONFLICT",
				path: entry.path,
				reason: "type-changed-after-read",
				expected: { kind: entry.kind, stamp: entry.stamp },
				current: statsSnapshot(stats),
			});
			continue;
		}
		const current = stampOf(stats);
		if (!sameStamp(entry.stamp, current)) {
			add({
				code: ":FILE_CONFLICT",
				path: entry.path,
				reason: "stamp-mismatch",
				expected: entry.stamp,
				current,
			});
		}
	}
	for (const entry of plan.base) {
		const stats = batch.io.lstat(entry.path);
		if (!entry.exists) {
			if (stats) {
				add({
					code: ":STRUCTURE_CONFLICT",
					path: entry.path,
					reason: "structure-appeared",
					expected: null,
					current: statsSnapshot(stats),
				});
			}
			continue;
		}
		if (!stats) {
			add({
				code: ":STRUCTURE_CONFLICT",
				path: entry.path,
				reason: "structure-missing",
				expected: { kind: entry.kind },
				current: null,
			});
			continue;
		}
		if (kindOf(stats) !== entry.kind) {
			add({
				code: ":STRUCTURE_CONFLICT",
				path: entry.path,
				reason: "structure-type-changed",
				expected: { kind: entry.kind },
				current: statsSnapshot(stats),
			});
		}
	}
	return conflicts;
}

function registeredCode(value) {
	if (typeof value !== "string") return { code: ":BOARD_CONFLICT", reported: null };
	const name = value.startsWith(":") ? value.slice(1) : value;
	if (Object.hasOwn(ERROR_CODES, name)) return { code: `:${name}`, reported: null };
	return { code: ":BOARD_CONFLICT", reported: value };
}

function rejectedResult(code, message, conflicts, actionId, error) {
	const registered = registeredCode(code);
	const data = {
		conflicts,
		actionId,
		...(registered.reported === null ? {} : { reportedCode: registered.reported }),
	};
	const herd = isHerdError(error) ? error : herdError(registered.code, message, data, error);
	return {
		status: ":rejected",
		code: registered.code,
		...(registered.reported === null ? {} : { reportedCode: registered.reported }),
		message: herd.message,
		error: herd,
		actionId,
		conflicts,
		written: [],
		pending: [],
		uncertain: [],
		stamp: [],
	};
}

function cancelledResult(actionId) {
	return {
		status: ":cancelled",
		code: ":STALE_CONTROL",
		actionId,
		written: [],
		pending: [],
		uncertain: [],
		conflicts: [],
		stamp: [],
	};
}

function normalizeState(value) {
	if (typeof value !== "string") return undefined;
	const text = value.trim().replace(/^:/, "").toLowerCase();
	return text.length > 0 ? text : undefined;
}

function requireProductionPorts({ control, identity, claim }) {
	if (control === null || typeof control !== "object") {
		throw invalidArgument(
			"control",
			"a BoardControlPort object",
			control,
			"production writes require the board control port",
		);
	}
	for (const method of ["markApplying", "publishResult", "markUncertain"]) {
		if (typeof control[method] !== "function") {
			throw invalidArgument(
				`control.${method}`,
				"a function",
				control[method],
				"the BoardControlPort must implement markApplying, publishResult, and markUncertain",
			);
		}
	}
	if (identity === null || typeof identity !== "object") {
		throw invalidArgument(
			"identity",
			"an ActorIdentity object",
			identity,
			"production writes require a live actor identity",
		);
	}
	const identityState =
		typeof identity.verify === "function" ||
		identity.status !== undefined ||
		identity.life_state !== undefined ||
		identity.lifeState !== undefined;
	if (!identityState) {
		throw invalidArgument(
			"identity",
			"an ActorIdentity with status or verify()",
			identity,
			"provide the actor life state so the commit can verify it",
		);
	}
	if (claim === null || typeof claim !== "object") {
		throw invalidArgument("claim", "a ClaimRef object", claim, "production writes require the current claim reference");
	}
	if (claim.claim_id === undefined && claim.status === undefined && claim.valid === undefined) {
		throw invalidArgument(
			"claim",
			"a ClaimRef with claim_id, status, or valid",
			claim,
			"provide the claim identity so the commit can verify it",
		);
	}
}

function requireCallPort(control) {
	if (typeof control?.markRunning !== "function") {
		throw invalidArgument(
			"control.markRunning",
			"a function",
			control?.markRunning,
			"call requires the board control port to register a running action",
		);
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
				return {
					code: verdict?.code ?? ":ACTOR_DEAD",
					message: verdict?.message ?? "actor is not alive",
				};
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
			return {
				code: verdict?.code ?? ":CLAIM_CHANGED",
				message: verdict?.message ?? "claim verification rejected the commit",
			};
		}
	}
	return null;
}

async function callControl(control, method, payload) {
	if (!control || typeof control[method] !== "function") return { ok: true, skipped: true };
	try {
		const result = await control[method](payload);
		if (result && result.ok === false) {
			return { ok: false, result };
		}
		return { ok: true, result };
	} catch (error) {
		return { ok: false, error };
	}
}

function appliedStamp(batch, path) {
	const stats = batch.io.lstat(path);
	return stats ? { path, ...stampOf(stats) } : null;
}

function applyStep(batch, step) {
	if (step.kind === "move") {
		batch.io.rename(step.source, step.target);
		return;
	}
	if (step.kind === "mkdir") {
		batch.io.mkdir(step.path);
		if (step.mode !== null && step.mode !== undefined) {
			batch.io.chmod(step.path, Number(step.mode));
		}
		return;
	}
	if (step.kind === "remove-file") {
		batch.io.unlink(step.path);
		return;
	}
	if (step.kind === "remove-dir") {
		batch.io.rmdir(step.path);
		return;
	}
	if (step.kind === "write") {
		const parent = dirname(step.path);
		const stats = batch.io.lstat(parent);
		if (!isDirectoryStats(stats)) {
			const error = new Error(`parent directory disappeared before write: ${parent}`);
			error.code = "ENOENT";
			error.stage = "precheck";
			throw error;
		}
		batch.io.writeFileAtomic(parent, basename(step.path), step.content);
		if (step.mode !== null && step.mode !== undefined) {
			batch.io.chmod(step.path, Number(step.mode));
		}
		return;
	}
	throw new Error(`unknown plan step: ${step.kind}`);
}

function clearCommitted(batch, operations) {
	// The program's own commit supersedes its earlier reads of every touched
	// path and of the ancestor directories whose stamps changed. Dropping those
	// entries lets a later read in the same program observe the new reality
	// without a false repeat-read conflict. Unrelated read-only dependencies
	// stay in the read set for a later finish recheck.
	const dropAncestors = (path) => {
		let cursor = dirname(path);
		while (true) {
			batch.readSet.delete(cursor);
			if (cursor === batch.writeRoot) break;
			const parent = dirname(cursor);
			if (parent === cursor) break;
			cursor = parent;
		}
	};
	for (const step of operations) {
		if (step.kind === "move") {
			for (const root of [step.source, step.target, step.physicalSource]) {
				if (typeof root !== "string") continue;
				for (const key of [...batch.readSet.keys()]) {
					if (key === root || key.startsWith(`${root}${sep}`)) batch.readSet.delete(key);
				}
				dropAncestors(root);
			}
			continue;
		}
		batch.readSet.delete(step.path);
		dropAncestors(step.path);
	}
	batch.overlay.clear();
	batch.base.clear();
	batch.aliases.clear();
	batch.movedSources.clear();
	batch.movedTargets.clear();
	batch.postMoveDirs.clear();
	batch.postMoveFiles.clear();
	batch.operations.length = 0;
	batch.batchBytes = 0;
	batch.prepared = null;
	batch.actionId = null;
	batch.applying = false;
	batch.committed += 1;
}

async function withWriteGate(writeGate, run) {
	if (typeof writeGate === "function") {
		return await writeGate(run);
	}
	if (writeGate && typeof writeGate.runExclusive === "function") {
		const executed = await writeGate.runExclusive(run);
		if (executed && typeof executed === "object" && executed.status === undefined) {
			if (executed.ok === false) {
				return rejectedResult(
					executed.error?.code ?? ":BOARD_CONFLICT",
					executed.error?.message ?? "write gate is busy",
					[],
					null,
					executed.error,
				);
			}
			if ("value" in executed) return executed.value;
		}
		return executed;
	}
	if (writeGate && typeof writeGate.run === "function") {
		return await writeGate.run(run);
	}
	if (writeGate && typeof writeGate.acquire === "function") {
		const acquired = await writeGate.acquire();
		if (acquired && acquired.ok === false) {
			return rejectedResult(
				acquired.error?.code ?? ":BOARD_CONFLICT",
				acquired.error?.message ?? "write gate is busy",
				[],
				null,
				acquired.error,
			);
		}
		const handle = acquired?.handle ?? acquired;
		try {
			return await run(handle);
		} finally {
			if (typeof writeGate.release === "function") {
				await writeGate.release(handle);
			}
		}
	}
	throw invalidArgument(
		"writeGate",
		"a runExclusive/run/acquire port",
		writeGate,
		"pass the Slice write-gate port; VFS never writes without it",
	);
}

/**
 * Apply one prepared plan under the write gate.
 *
 * Order: gate -> identity/claim -> full stamp and structure recheck ->
 * `control.markApplying` -> ordered atomic renames and file replacement ->
 * result publication -> gate release. Control, identity, and claim are
 * mandatory; a recheck failure returns `:rejected` with
 * `written: []` and touches no file. A hard apply failure returns `:uncertain`
 * with applied, pending, and uncertain paths; the batch then refuses further
 * commits until the caller inspects reality and creates a new batch. A signal
 * that aborts before `markApplying` returns `:cancelled` with zero disk
 * changes; an abort after that point does not stop the fixed batch.
 */
export async function commit({ batch, plan, writeGate, control, identity, claim, signal } = {}) {
	assertBatch(batch);
	requireProductionPorts({ control, identity, claim });
	if (signal?.aborted) return cancelledResult(null);
	if (batch.uncertain) {
		return rejectedResult(
			":PREPARE_REJECTED",
			"the batch ended in :uncertain; inspect reality and create a new batch",
			[],
			null,
		);
	}
	let activePlan = plan;
	if (!activePlan) {
		const prepared = prepare(batch);
		activePlan = prepared.plan;
	}
	const internal = batch.prepared;
	if (!internal || activePlan.batchId !== batch.id || activePlan.token !== internal.token) {
		return rejectedResult(":PREPARE_REJECTED", "plan is stale or does not belong to this batch", [], null);
	}
	let actionId = internal.actionId;
	const claimedActionId = claim?.action_id ?? claim?.actionId;
	if (typeof claimedActionId === "string" && claimedActionId.length > 0) actionId = claimedActionId;
	if (!internal.operations.length && !internal.readSet.length) {
		if (signal?.aborted) return cancelledResult(actionId);
		const verdict = await verifyPorts({ control, identity, claim });
		if (verdict) {
			return rejectedResult(verdict.code, verdict.message, [], actionId);
		}
		if (signal?.aborted) return cancelledResult(actionId);
		clearCommitted(batch, []);
		return {
			status: ":applied",
			code: null,
			actionId,
			written: [],
			pending: [],
			uncertain: [],
			conflicts: [],
			stamp: [],
			skipped: true,
		};
	}
	return withWriteGate(writeGate, async () => {
		if (signal?.aborted) return cancelledResult(actionId);
		const verdict = await verifyPorts({ control, identity, claim });
		if (verdict) {
			return rejectedResult(verdict.code, verdict.message, [], actionId);
		}
		const conflicts = recheck(batch, internal);
		if (conflicts.length > 0) {
			const primary = conflicts[0];
			return rejectedResult(
				primary.code,
				"read-set or structure recheck failed",
				conflicts,
				actionId,
				herdError(primary.code, "read-set or structure recheck failed", {
					path: primary.path,
					reason: primary.reason,
					expected: primary.expected,
					current: primary.current,
					conflicts,
				}),
			);
		}
		if (signal?.aborted) return cancelledResult(actionId);
		const markingPayload = {
			batchId: batch.id,
			writeRoot: batch.writeRoot,
			operations: internal.operations.map((step) => ({ kind: step.kind, path: step.path })),
			kind: "edit",
			...portIdentityFields(identity, claim),
		};
		if (typeof claimedActionId === "string" && claimedActionId.length > 0) {
			markingPayload.actionId = claimedActionId;
		}
		const marking = await callControl(control, "markApplying", markingPayload);
		if (!marking.ok) {
			if (marking.result) {
				return rejectedResult(
					marking.result.code ?? ":STALE_CONTROL",
					marking.result.message ?? "batch control refused the applying mark",
					[],
					actionId,
					marking.result.error,
				);
			}
			return rejectedResult(
				":BOARD_CONFLICT",
				`applying mark failed: ${messageOf(marking.error)}`,
				[],
				actionId,
				herdError(":BOARD_CONFLICT", `applying mark failed: ${messageOf(marking.error)}`, {
					actionId,
					cause: messageOf(marking.error),
				}),
			);
		}
		const allocatedActionId =
			marking.result?.receipt?.actionId ?? marking.result?.receipt?.["action-id"] ?? marking.result?.actionId;
		if (typeof allocatedActionId === "string" && allocatedActionId.length > 0) {
			actionId = allocatedActionId;
			internal.actionId = allocatedActionId;
			batch.actionId = allocatedActionId;
		}
		batch.applying = true;
		const written = [];
		const stamps = [];
		try {
			for (let index = 0; index < internal.operations.length; index += 1) {
				const step = internal.operations[index];
				try {
					applyStep(batch, step);
				} catch (error) {
					const uncertain = {
						path: step.path ?? step.target ?? null,
						kind: step.kind,
						stage: typeof error?.stage === "string" ? error.stage : null,
						code: typeof error?.code === "string" ? error.code : null,
						message: messageOf(error),
					};
					const pending = internal.operations.slice(index + 1).map((next) => next.path ?? next.target ?? null);
					const result = {
						status: ":uncertain",
						code: ":BOARD_CONFLICT",
						actionId,
						batchId: batch.id,
						written,
						pending,
						uncertain: [uncertain],
						conflicts: [],
						stamp: stamps,
						error: uncertain,
						recorded: true,
					};
					batch.uncertain = true;
					const recorded = await callControl(control, "markUncertain", {
						...result,
						...portIdentityFields(identity, claim),
					});
					if (!recorded.ok) {
						result.recorded = false;
						result.recordError = recorded.error ? messageOf(recorded.error) : recorded.result;
					}
					return result;
				}
				const writtenPath = step.path ?? step.target ?? null;
				if (!written.includes(writtenPath)) written.push(writtenPath);
				if (step.kind === "write") {
					const snapshot = appliedStamp(batch, step.path);
					if (snapshot) stamps.push(snapshot);
				}
			}
			const result = {
				status: ":applied",
				code: null,
				actionId,
				batchId: batch.id,
				written,
				pending: [],
				uncertain: [],
				conflicts: [],
				stamp: stamps,
				recorded: true,
			};
			clearCommitted(batch, internal.operations);
			const published = await callControl(control, "publishResult", {
				...result,
				...portIdentityFields(identity, claim),
			});
			if (!published.ok) {
				result.recorded = false;
				result.recordError = published.error ? messageOf(published.error) : published.result;
			}
			return result;
		} finally {
			batch.applying = false;
		}
	});
}

/**
 * Commit every pending overlay change before a shell call.
 *
 * Output: the commit result, `{status:":noop"}` when the overlay is empty, or
 * `{status:":cancelled"}` when the signal aborts before applying.
 * `ports` is forwarded to `commit`.
 */
export async function drain(batch, ports = {}) {
	assertBatch(batch);
	requireProductionPorts(ports);
	const verdict = await verifyPorts(ports);
	if (verdict) {
		return rejectedResult(verdict.code, verdict.message, [], null);
	}
	if (ports.signal?.aborted) return cancelledResult(null);
	if (batch.uncertain) {
		return {
			status: ":rejected",
			code: ":PREPARE_REJECTED",
			message: "the batch ended in :uncertain; inspect reality and create a new batch",
			written: [],
			pending: [],
			uncertain: [],
			conflicts: [],
			stamp: [],
		};
	}
	if (batch.overlay.size === 0) {
		return { status: ":noop", written: [], pending: [], uncertain: [], conflicts: [], stamp: [] };
	}
	const { plan } = prepare(batch);
	return commit({ ...ports, batch, plan });
}

function resolveCallCwd(batch, cwd) {
	if (cwd === undefined || cwd === null || cwd === "") return batch.writeRoot;
	assertPathText(cwd, "cwd");
	const target = resolveAgainstRoot(batch.writeRoot, cwd);
	if (viewEntry(batch, target).type !== "dir") {
		throw structureConflict(target, "call cwd is not a directory", undefined);
	}
	return target;
}

function resolveCallLogPath(batch, limits) {
	if (!limits.logPath) return null;
	return resolveAgainstRoot(batch.writeRoot, limits.logPath);
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
	let end = bytes.length;
	if (end === 0) return "";
	for (let back = 1; back <= 4 && end - back >= 0; back += 1) {
		const byte = bytes[end - back];
		if ((byte & 0xc0) === 0x80) continue;
		const needed = byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		if (back < needed) end -= back;
		break;
	}
	return bytes.subarray(0, end).toString("utf8");
}

const HOST_INJECTED_ENV = Object.freeze(["BUN_OPTIONS", "NODE_OPTIONS", "BASH_ENV", "ENV", "PROMPT_COMMAND"]);

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
		const waitGroup = async () => {
			while (groupAlive()) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
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
			void (async () => {
				try {
					if (groupAlive()) {
						managedChildren = true;
						await waitGroup();
					}
					groupWaitDone = true;
					if (closeSeen) maybeFinish();
					else startCloseGrace();
				} catch (error) {
					finish({ ...snapshot({ stdioClosed: false }), error });
				}
			})();
		});
		child.on("close", (code, closeSignal) => {
			if (exitInfo === null) exitInfo = { code, signal: closeSignal };
			closeSeen = true;
			maybeFinish();
		});
	});
}

function normalizeIo(io) {
	if (typeof io !== "object" || io === null) {
		throw invalidArgument("io", "a plain object", io);
	}
	const base = defaultIo();
	const result = { ...base, ...io };
	for (const key of [
		"lstat",
		"readFile",
		"readdir",
		"realpath",
		"mkdir",
		"rmdir",
		"unlink",
		"rename",
		"writeFileAtomic",
		"chmod",
		"runCommand",
	]) {
		if (typeof result[key] !== "function") {
			throw invalidArgument(`io.${key}`, "a function", result[key]);
		}
	}
	return result;
}

function defaultIo() {
	return {
		lstat(path) {
			try {
				return lstatSync(path, { bigint: true });
			} catch (error) {
				if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
				throw error;
			}
		},
		readFile(path) {
			return readFileSync(path);
		},
		readdir(path) {
			return readdirSync(path);
		},
		realpath(path) {
			return realpathSync(path);
		},
		mkdir(path) {
			mkdirSync(path);
		},
		rmdir(path) {
			rmdirSync(path);
		},
		unlink(path) {
			unlinkSync(path);
		},
		rename(source, target) {
			renameSync(source, target);
		},
		chmod(path, mode) {
			chmodSync(path, mode);
		},
		writeFileAtomic,
		runCommand: defaultRunCommand,
	};
}

/**
 * Drain pending writes, then run one argv command while holding the gate.
 *
 * Output status:
 * - `:completed` for exit code 0;
 * - `:failed` for a nonzero exit or spawn error;
 * - `:cancelled` when the signal aborted before the command started;
 * - `:outcome-unknown` when an already started command was interrupted, so a
 *   successor must inspect external effects before retrying.
 *
 * Inline stdout/stderr are capped by `limits.inlineBytes` (default 1 MiB) and
 * the log is capped by `limits.logBytes` (default 64 MiB). When
 * `limits.logPath` is set, the complete collected log is written there with an
 * atomic replace. The log must stay inside an allowed root; to log into a
 * dedicated artifacts directory, pass that directory as `limits.logRoot`.
 * The result never pretends that a truncated stream is whole.
 */
export async function runCall({
	batch,
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
	assertBatch(batch);
	requireProductionPorts({ control, identity, claim });
	requireCallPort(control);
	if (
		!Array.isArray(argv) ||
		argv.length === 0 ||
		argv.some((arg) => typeof arg !== "string") ||
		argv[0].length === 0
	) {
		throw invalidArgument("argv", "a non-empty string array", argv);
	}
	const argc = argv.length;
	const callLimits = normalizeCallLimits(limits);
	const resolvedLogPath = resolveCallLogPath(batch, callLimits);
	const workdir = resolveCallCwd(batch, cwd);
	if (signal?.aborted) {
		return {
			status: ":cancelled",
			code: ":STALE_CONTROL",
			phase: ":before-drain",
			actionId: null,
			argv,
			argc,
			cwd: workdir,
			written: [],
			drained: null,
		};
	}
	const drained = await drain(batch, { writeGate, control, identity, claim, signal });
	if (drained.status === ":cancelled") {
		return {
			status: ":cancelled",
			code: ":STALE_CONTROL",
			phase: ":drain",
			actionId: drained.actionId ?? null,
			argv,
			argc,
			cwd: workdir,
			written: [],
			drained,
		};
	}
	if (drained.status === ":rejected" || drained.status === ":uncertain") {
		return {
			status: drained.status,
			code: drained.code,
			phase: ":drain",
			actionId: drained.actionId ?? null,
			argv,
			argc,
			cwd: workdir,
			written: drained.written ?? [],
			drained,
		};
	}
	if (signal?.aborted) {
		return {
			status: ":cancelled",
			code: ":STALE_CONTROL",
			phase: ":before-call",
			actionId: null,
			argv,
			argc,
			cwd: workdir,
			written: drained.written ?? [],
			drained,
		};
	}
	return withWriteGate(writeGate, async () => {
		if (signal?.aborted) {
			return {
				status: ":cancelled",
				code: ":STALE_CONTROL",
				phase: ":before-call",
				actionId: null,
				argv,
				argc,
				cwd: workdir,
				written: drained.written ?? [],
				drained,
			};
		}
		const verdict = await verifyPorts({ control, identity, claim });
		if (verdict) {
			return {
				status: ":rejected",
				code: verdict.code,
				message: verdict.message,
				phase: ":identity",
				actionId: null,
				argv,
				argc,
				cwd: workdir,
				written: drained.written ?? [],
				drained,
			};
		}
		let actionId = callLimits.actionId ?? randomUUID();
		const fields = portIdentityFields(identity, claim);
		const marking = await callControl(control, "markRunning", {
			actionId,
			argv,
			argc,
			cwd: workdir,
			...fields,
		});
		if (!marking.ok) {
			return {
				status: ":rejected",
				code: marking.result?.code ?? ":BOARD_CONFLICT",
				message: marking.result?.message ?? `call registration failed: ${messageOf(marking.error)}`,
				phase: ":register",
				actionId,
				argv,
				argc,
				cwd: workdir,
				written: drained.written ?? [],
				drained,
			};
		}
		const allocatedActionId =
			marking.result?.receipt?.actionId ?? marking.result?.receipt?.["action-id"] ?? marking.result?.actionId;
		if (callLimits.actionId === undefined && typeof allocatedActionId === "string" && allocatedActionId.length > 0) {
			actionId = allocatedActionId;
		}
		if (signal?.aborted) {
			const result = {
				status: ":cancelled",
				code: ":STALE_CONTROL",
				phase: ":before-call",
				actionId,
				argv,
				argc,
				cwd: workdir,
				written: drained.written ?? [],
				drained,
				recorded: true,
			};
			const published = await callControl(control, "publishResult", { ...result, ...fields });
			if (!published.ok) {
				result.recorded = false;
				result.recordError = published.error ? messageOf(published.error) : published.result;
			}
			return result;
		}
		let outcome;
		try {
			outcome =
				(await batch.io.runCommand(argv, {
					cwd: workdir,
					signal,
					maxBytes: callLimits.logBytes,
					...(onCallHandle ? { onHandle: onCallHandle } : {}),
				})) ?? {};
		} catch (error) {
			const result = {
				status: ":outcome-unknown",
				code: ":BOARD_CONFLICT",
				phase: ":call",
				actionId,
				argv,
				argc,
				cwd: workdir,
				exitCode: null,
				signal: null,
				stdout: "",
				stderr: "",
				truncated: false,
				inlineTruncated: false,
				logTruncated: false,
				logPath: null,
				logError: null,
				managedChildren: false,
				stdioClosed: true,
				externalBestEffort: true,
				written: drained.written ?? [],
				drained,
				recorded: true,
				error: { code: error?.code ?? null, message: messageOf(error) },
			};
			const recorded = await callControl(control, "markUncertain", { ...result, ...fields });
			if (!recorded.ok) {
				result.recorded = false;
				result.recordError = recorded.error ? messageOf(recorded.error) : recorded.result;
			}
			return result;
		}
		if (outcome.aborted === true && outcome.started === false) {
			const result = {
				status: ":cancelled",
				code: ":STALE_CONTROL",
				phase: ":before-call",
				actionId,
				argv,
				argc,
				cwd: workdir,
				exitCode: null,
				signal: null,
				stdout: "",
				stderr: "",
				truncated: false,
				inlineTruncated: false,
				logTruncated: false,
				logPath: null,
				logError: null,
				managedChildren: false,
				stdioClosed: true,
				externalBestEffort: true,
				written: drained.written ?? [],
				drained,
				recorded: true,
			};
			const published = await callControl(control, "publishResult", { ...result, ...fields });
			if (!published.ok) {
				result.recorded = false;
				result.recordError = published.error ? messageOf(published.error) : published.result;
			}
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
		const logText = log.text;
		let logPath = resolvedLogPath;
		let logError = null;
		if (logPath) {
			try {
				batch.io.writeFileAtomic(dirname(logPath), basename(logPath), logText);
			} catch (error) {
				logError = messageOf(error);
				logPath = null;
			}
		}
		let status;
		if (outcome.aborted === true) status = ":outcome-unknown";
		else if (outcome.error) status = ":failed";
		else if (outcome.exitCode === 0) status = ":completed";
		else status = ":failed";
		const result = {
			status,
			code: truncated ? ":OUTPUT_TRUNCATED" : null,
			phase: ":call",
			actionId,
			argv,
			argc,
			cwd: workdir,
			exitCode: outcome.exitCode ?? null,
			signal: outcome.signal ?? null,
			stdout: stdout.text,
			stderr: stderr.text,
			truncated,
			inlineTruncated,
			logTruncated,
			logPath,
			logError,
			managedChildren: outcome.managedChildren === true,
			stdioClosed: outcome.stdioClosed !== false,
			externalBestEffort: outcome.externalBestEffort !== false,
			written: drained.written ?? [],
			drained,
			recorded: true,
		};
		if (outcome.error) result.error = { code: outcome.error.code ?? null, message: messageOf(outcome.error) };
		const recorded =
			status === ":outcome-unknown"
				? await callControl(control, "markUncertain", { ...result, ...fields })
				: await callControl(control, "publishResult", { ...result, ...fields });
		if (!recorded.ok) {
			result.recorded = false;
			result.recordError = recorded.error ? messageOf(recorded.error) : recorded.result;
		}
		return result;
	});
}
