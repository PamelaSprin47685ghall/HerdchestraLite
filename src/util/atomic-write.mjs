import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Replace one file inside `dir` without ever leaving a half-written target.
 *
 * Inputs: the target directory (created when missing), a file name relative to
 * it, and the complete text to store.
 *
 * Output: `{ existed }`, where `existed` reports whether the target was already
 * there before this call.
 *
 * The temporary file lives in the target directory, so `rename` stays atomic on
 * the same filesystem. When writing or renaming fails, the temporary file is
 * removed and the original error is rethrown unchanged; the previous target, if
 * any, is left as it was.
 */
export function writeFileAtomic(dir, fileName, content) {
	const target = resolve(dir, fileName);
	const existed = existsSync(target);
	const temp = resolve(dir, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(temp, content, { encoding: "utf8" });
		renameSync(temp, target);
	} catch (error) {
		try {
			rmSync(temp, { force: true });
		} catch {
			// Cleanup must not hide the write error.
		}
		throw error;
	}
	return { existed };
}
