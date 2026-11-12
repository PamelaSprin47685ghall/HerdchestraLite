import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { writeEdnAtomic, writeFileAtomic } from "../src/util/atomic-write.mjs";
import { isHerdError } from "../src/util/errors.mjs";

const roots = [];

// root ignores the 0o555 directory bit (CAP_DAC_OVERRIDE), so the write would
// succeed and the permission case would assert nothing real.
const isRoot = process.getuid?.() === 0;

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), "herd-atomic-"));
	roots.push(root);
	return root;
}

function leftoverTemps(dir) {
	return readdirSync(dir).filter((name) => name.startsWith(".tmp-"));
}

function capture(fn) {
	try {
		return { value: fn() };
	} catch (error) {
		return { error };
	}
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
		const target = join(dir, "report.md");

		expect(writeFileAtomic(dir, "report.md", "第一轮\n")).toEqual({ path: target, existed: false });

		expect(readFileSync(target, "utf8")).toBe("第一轮\n");
		expect(leftoverTemps(dir)).toEqual([]);
	});

	it("creates missing parents for a nested file name without crossing directories", () => {
		const root = sandbox();
		const target = join(root, "plans", "mission.edn");

		expect(writeFileAtomic(root, "plans/mission.edn", "{}\n")).toEqual({ path: target, existed: false });

		expect(readFileSync(target, "utf8")).toBe("{}\n");
		expect(leftoverTemps(join(root, "plans"))).toEqual([]);
	});

	it("replaces an existing target and reports it", () => {
		const root = sandbox();
		const target = join(root, "report.md");
		writeFileSync(target, "old\n", "utf8");

		expect(writeFileAtomic(root, "report.md", "new\n")).toEqual({ path: target, existed: true });

		expect(readFileSync(target, "utf8")).toBe("new\n");
		expect(leftoverTemps(root)).toEqual([]);
	});

	it("keeps the permission bits of a replaced file", () => {
		const root = sandbox();
		const target = join(root, "deploy.sh");
		writeFileSync(target, "#!/bin/sh\n", { encoding: "utf8", mode: 0o600 });
		chmodSync(target, 0o751);

		writeFileAtomic(root, "deploy.sh", "#!/bin/sh\necho ok\n");

		expect(statSync(target).mode & 0o777).toBe(0o751);
		expect(leftoverTemps(root)).toEqual([]);
	});

	it("creates new files with owner-only permissions", () => {
		const root = sandbox();
		const target = join(root, "fresh.txt");

		writeFileAtomic(root, "fresh.txt", "new\n");

		expect(statSync(target).mode & 0o777).toBe(0o600);
		expect(leftoverTemps(root)).toEqual([]);
	});

	it("writes a complete Uint8Array byte for byte", () => {
		const root = sandbox();
		const target = join(root, "blob.bin");
		const bytes = new Uint8Array(2 * 1024 * 1024 + 17);
		for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;

		const result = writeFileAtomic(root, "blob.bin", bytes);

		expect(result.existed).toBe(false);
		expect(readFileSync(target).equals(Buffer.from(bytes))).toBe(true);
		expect(leftoverTemps(root)).toEqual([]);
	});

	it("writes an empty buffer and an empty string", () => {
		const root = sandbox();

		expect(writeFileAtomic(root, "empty.txt", "")).toEqual({ path: join(root, "empty.txt"), existed: false });
		expect(writeFileAtomic(root, "empty.bin", new Uint8Array(0)).existed).toBe(false);

		expect(readFileSync(join(root, "empty.txt"), "utf8")).toBe("");
		expect(readFileSync(join(root, "empty.bin")).length).toBe(0);
		expect(leftoverTemps(root)).toEqual([]);
	});

	it.skipIf(isRoot)("keeps the previous file and reports the write stage", () => {
		const root = sandbox();
		const target = join(root, "report.md");
		writeFileSync(target, "old\n", "utf8");
		chmodSync(root, 0o555);

		const { error } = capture(() => writeFileAtomic(root, "report.md", "new\n"));
		chmodSync(root, 0o755);

		expect(error).toBeInstanceOf(Error);
		expect(["EACCES", "EPERM"]).toContain(error.code);
		expect(error.stage).toBe("write");
		expect(error.path).toBe(target);
		expect(dirname(error.temp)).toBe(root);
		expect(basename(error.temp).startsWith(".tmp-")).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("old\n");
		expect(leftoverTemps(root)).toEqual([]);
	});

	it("removes the temporary file when the rename fails", () => {
		const root = sandbox();
		const target = join(root, "report.md");
		mkdirSync(target);
		writeFileSync(join(target, "keep.txt"), "keep\n", "utf8");

		const { error } = capture(() => writeFileAtomic(root, "report.md", "new\n"));

		expect(error).toBeInstanceOf(Error);
		expect(typeof error.code).toBe("string");
		expect(error.stage).toBe("rename");
		expect(error.path).toBe(target);
		expect(dirname(error.temp)).toBe(root);
		expect(basename(error.temp).startsWith(".tmp-")).toBe(true);
		expect(existsSync(target)).toBe(true);
		expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep\n");
		expect(leftoverTemps(root)).toEqual([]);
	});

	it("rejects invalid arguments with a herd error before touching files", () => {
		const root = sandbox();
		const cases = [
			() => writeFileAtomic(42, "x.txt", "x"),
			() => writeFileAtomic(root, "", "x"),
			() => writeFileAtomic(root, "x.txt", 7),
			() => writeEdnAtomic("", {}),
		];

		for (const run of cases) {
			const { error } = capture(run);
			expect(isHerdError(error)).toBe(true);
			expect(error.code).toBe(":INVALID_ARGUMENT");
			expect(error.data.argument).toBeDefined();
		}
		expect(leftoverTemps(root)).toEqual([]);
	});
});

describe("writeEdnAtomic", () => {
	it("creates the file with deterministic EDN and one trailing newline", () => {
		const root = sandbox();
		const target = join(root, "nested", "mission.edn");

		const result = writeEdnAtomic(target, {
			":board-version": 2,
			":tasks": [":ready", ":waiting"],
		});

		expect(result).toEqual({ path: target, existed: false });
		const text = readFileSync(target, "utf8");
		expect(text.endsWith("\n")).toBe(true);
		expect(text.endsWith("\n\n")).toBe(false);
		expect(text).toContain(":board-version 2");
		expect(text).toContain(":tasks [:ready :waiting]");
		expect(leftoverTemps(join(root, "nested"))).toEqual([]);
	});

	it("replaces an existing target and reports it", () => {
		const root = sandbox();
		const target = join(root, "mission.edn");
		writeFileSync(target, "old\n", "utf8");

		expect(writeEdnAtomic(target, { ":stage": ":s3" }).existed).toBe(true);

		const text = readFileSync(target, "utf8");
		expect(text).toContain(":stage :s3");
		expect(text.endsWith("\n")).toBe(true);
		expect(leftoverTemps(root)).toEqual([]);
	});
});
