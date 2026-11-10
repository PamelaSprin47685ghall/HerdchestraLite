import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/util/atomic-write.mjs";

const roots = [];

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), "herd-atomic-"));
	roots.push(root);
	return root;
}

function leftoverTemps(dir) {
	return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		try {
			chmodSync(root, 0o755);
		} catch {
			// The sandbox may already be gone.
		}
		rmSync(root, { recursive: true, force: true });
	}
});

describe("writeFileAtomic", () => {
	it("creates missing directories and reports a new target", () => {
		const dir = join(sandbox(), "nested", "docs");

		expect(writeFileAtomic(dir, "report.md", "第一轮\n")).toEqual({ existed: false });

		expect(readFileSync(join(dir, "report.md"), "utf8")).toBe("第一轮\n");
		expect(leftoverTemps(dir)).toEqual([]);
	});

	it("replaces an existing target and reports it", () => {
		const root = sandbox();
		const target = join(root, "report.md");
		writeFileSync(target, "old\n", "utf8");

		expect(writeFileAtomic(root, "report.md", "new\n")).toEqual({ existed: true });

		expect(readFileSync(target, "utf8")).toBe("new\n");
		expect(leftoverTemps(root)).toEqual([]);
	});

	it("keeps the previous file and rethrows the original error", () => {
		const root = sandbox();
		const target = join(root, "report.md");
		writeFileSync(target, "old\n", "utf8");
		chmodSync(root, 0o555);

		let caught;
		try {
			writeFileAtomic(root, "report.md", "new\n");
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect(["EACCES", "EPERM"]).toContain(caught.code);
		chmodSync(root, 0o755);
		expect(readFileSync(target, "utf8")).toBe("old\n");
		expect(leftoverTemps(root)).toEqual([]);
	});

	it("removes the temporary file when the rename fails", () => {
		const root = sandbox();
		const target = join(root, "report.md");
		mkdirSync(target);
		writeFileSync(join(target, "keep.txt"), "keep\n", "utf8");

		let caught;
		try {
			writeFileAtomic(root, "report.md", "new\n");
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect(typeof caught.code).toBe("string");
		expect(existsSync(join(target, "keep.txt"))).toBe(true);
		expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep\n");
		expect(leftoverTemps(root)).toEqual([]);
	});
});
