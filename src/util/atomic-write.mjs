/**
 * Durable file replacement: write to a sibling temporary file, flush it, then
 * rename it over the target.
 *
 * Inputs: a directory, a file name inside it, and complete text or bytes.
 * Output: a Promise of `{ path, existed }`.
 *
 * Readers see either the complete old content or the complete new content.
 * A failure leaves the old target untouched and removes the temporary file.
 * Every filesystem call is asynchronous, so a large or slow filesystem never
 * blocks the host main thread or a shared sandbox worker.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { herdError, printEdn } from "./errors.mjs";

const TEMP_PREFIX = ".tmp-";

function actualOf(value) {
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (value === "") return "empty string";
	return typeof value;
}

function invalidArgument(argument, expected, value) {
	return herdError(":INVALID_ARGUMENT", `atomic write requires ${argument} to be ${expected}`, {
		argument,
		expected,
		actual: actualOf(value),
		next: `pass ${expected} for ${argument}`,
	});
}

function assertFileName(name) {
	if (typeof name !== "string" || name.length === 0) {
		throw invalidArgument("name", "a non-empty string", name);
	}
}

function assertWritableData(data) {
	if (typeof data === "string" || data instanceof Uint8Array) return;
	throw invalidArgument("data", "a string or a Uint8Array", data);
}

function toBytes(data) {
	if (typeof data === "string") return Buffer.from(data, "utf8");
	if (Buffer.isBuffer(data)) return data;
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

async function targetStat(path) {
	try {
		return await lstat(path);
	} catch {
		return undefined;
	}
}

/**
 * Attach the stage and both paths to the original system error.
 *
 * The raw error keeps `code` such as `EACCES` or `ENOSPC`, so callers can show
 * the operating-system diagnosis unchanged.
 */
function tagSystemError(error, stage, path, temp) {
	try {
		if (typeof error === "object" && error !== null) {
			error.stage = stage;
			error.path = path;
			error.temp = temp;
		}
	} catch {
		// A non-extensible thrown value must still reach the caller unchanged.
	}
	return error;
}

/**
 * Replace one file inside `dir` without exposing a half-written target.
 *
 * Inputs: the target directory (created when missing), a file name relative to
 * it, and the complete text or bytes to store.
 *
 * Output: a Promise of `{ path, existed }`, where `path` is absolute and
 * `existed` reports whether the target was already there before this call.
 *
 * The temporary file lives in the target directory, so `rename` stays atomic on
 * the same filesystem. A write, flush, or rename failure removes the temporary
 * file and rethrows the original system error with `stage`, `path`, and `temp`
 * attached. The previous target, if any, is left as it was.
 *
 * When the target is an existing regular file, its `rwx` permission bits move
 * to the replacement. Setuid and setgid bits are not copied.
 *
 * Invalid arguments throw `:INVALID_ARGUMENT` instead, because no file work has
 * started and no system error exists.
 */
export async function writeFileAtomic(dir, name, data) {
	if (typeof dir !== "string" || dir.length === 0) {
		throw invalidArgument("dir", "a non-empty string", dir);
	}
	assertFileName(name);
	assertWritableData(data);

	const target = resolve(dir, name);
	const targetDir = dirname(target);
	const temp = join(targetDir, `${TEMP_PREFIX}${randomUUID()}`);
	const previous = await targetStat(target);
	const existed = previous !== undefined;
	const bytes = toBytes(data);
	let handle = null;
	let created = false;
	let stage = "write";

	try {
		await mkdir(targetDir, { recursive: true });
		handle = await open(temp, "wx", 0o600);
		created = true;
		// Keep the old permission bits so overwriting a script does not drop its
		// executable bit. New files keep the owner-only mode above.
		if (previous?.isFile()) await handle.chmod(previous.mode & 0o777);
		await handle.writeFile(bytes);
		stage = "fsync";
		await handle.sync();
		await handle.close();
		handle = null;
		stage = "rename";
		await rename(temp, target);
	} catch (error) {
		if (handle !== null) {
			try {
				await handle.close();
			} catch {
				// Cleanup must not hide the failure that stopped the write.
			}
			handle = null;
		}
		if (created) {
			try {
				await rm(temp, { force: true });
			} catch {
				// Cleanup must not hide the failure that stopped the write.
			}
		}
		throw tagSystemError(error, stage, target, temp);
	}

	return { path: target, existed };
}

/**
 * Serialize one EDN value and replace `path` with it atomically.
 *
 * Inputs: an absolute or relative file path and any value `printEdn` accepts.
 * Output: a Promise of `{ path, existed }` from `writeFileAtomic`.
 *
 * The stored text is the deterministic EDN rendering plus one trailing newline.
 */
export async function writeEdnAtomic(path, value) {
	if (typeof path !== "string" || path.length === 0) {
		throw invalidArgument("path", "a non-empty string", path);
	}
	const target = resolve(path);
	const text = `${printEdn(value)}\n`;
	return writeFileAtomic(dirname(target), basename(target), text);
}