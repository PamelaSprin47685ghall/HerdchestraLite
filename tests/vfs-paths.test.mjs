import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { commit, createBatch, list, prepare, readText, stat, write } from "../src/clj-sandbox/vfs.mjs";

const roots = [];

afterEach(() => {
	while (roots.length > 0) {
		rmSync(roots.pop(), { recursive: true, force: true });
	}
});

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), "herd-vfs-paths-"));
	roots.push(root);
	return root;
}

function makeBatch(writeRoot, options = {}) {
	const readRoots = options.readRoots ?? [writeRoot];
	const limits = options.limits;
	return createBatch({
		writeRoot,
		readRoots,
		...(limits === undefined ? {} : { limits }),
	});
}

const writeGate = {
	async runExclusive(fn) {
		return fn();
	},
};

const control = {
	markApplying() {
		return { ok: true };
	},
	publishResult() {
		return { ok: true };
	},
	markUncertain() {
		return { ok: true };
	},
};
const identity = { agent_id: "agent-test", term_id: "term-test", status: "alive" };
const claim = { claim_id: "claim-test", status: "active" };

async function apply(batch) {
	const prepared = prepare(batch);
	expect(prepared.ok).toBe(true);
	return commit({ batch, plan: prepared.plan, writeGate, control, identity, claim });
}

function captureSync(fn) {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}

function _captureAsync(fn) {
	return fn().then(
		() => undefined,
		(error) => error,
	);
}

function expectSyncCode(fn, code) {
	const error = captureSync(fn);
	expect(error).toBeInstanceOf(Error);
	expect(error.code).toBe(code);
	return error;
}

function attemptWrite(batch, path, content) {
	write(batch, path, content);
	prepare(batch);
}

function treeSnapshot(root) {
	const entries = new Map();
	const walk = (dir, prefix) => {
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			const relative = prefix === "" ? name : `${prefix}/${name}`;
			const info = lstatSync(full, { bigint: true });
			if (info.isSymbolicLink()) {
				entries.set(relative, `link:${readlinkSync(full)}`);
			} else if (info.isDirectory()) {
				entries.set(`${relative}/`, "dir");
				walk(full, relative);
			} else {
				entries.set(relative, `file:${info.size}:${readFileSync(full).toString("hex")}`);
			}
		}
	};
	walk(root, "");
	return entries;
}

describe("path resolution", () => {
	it("treats the empty path as the write root and lists without touching the read-set", () => {
		const root = sandbox();
		writeFileSync(join(root, "root-file.txt"), "hello");
		const batch = makeBatch(root);

		const info = stat(batch, "");
		expect(info.exists).toBe(true);
		expect(info.isDir).toBe(true);

		const before = batch.readSet.size;
		const listing = list(batch, "");
		const entries = Array.isArray(listing) ? listing : listing.entries;
		expect(Array.isArray(entries)).toBe(true);
		const names = entries.map((entry) => (typeof entry === "string" ? entry : entry.name));
		expect(names).toContain("root-file.txt");
		expect(batch.readSet.size).toBe(before);
	});

	it("resolves a relative path against the write root and commits it", async () => {
		const root = sandbox();
		const batch = makeBatch(root);

		write(batch, "relative.txt", "relative-content");
		const result = await apply(batch);

		expect(result.status).toBe(":applied");
		expect(readFileSync(join(root, "relative.txt"), "utf8")).toBe("relative-content");
	});

	it("accepts an absolute path inside the write root", async () => {
		const root = sandbox();
		const target = join(root, "absolute.txt");
		const batch = makeBatch(root);

		write(batch, target, "absolute-content");
		const result = await apply(batch);

		expect(result.status).toBe(":applied");
		expect(readFileSync(target, "utf8")).toBe("absolute-content");
	});

	it("reads an absolute path inside a read root and returns a BigInt stamp", () => {
		const writeRoot = sandbox();
		const readRoot = sandbox();
		const dependency = join(readRoot, "dependency.txt");
		writeFileSync(dependency, "dependency-content");

		const batch = makeBatch(writeRoot, { readRoots: [writeRoot, readRoot] });
		const read = readText(batch, dependency);

		expect(read.content).toBe("dependency-content");
		expect(typeof read.stamp.mtimeSec).toBe("bigint");
		expect(typeof read.stamp.mtimeNsec).toBe("bigint");
		expect(typeof read.stamp.size).toBe("bigint");
		expect(read.stamp.size).toBe(BigInt(Buffer.byteLength("dependency-content")));
		expect(batch.readSet.size).toBe(1);
	});

	it("rejects .. traversal outside the write root without touching disk", () => {
		const root = sandbox();
		const outside = sandbox();
		writeFileSync(join(outside, "secret.txt"), "outside-secret");
		const batch = makeBatch(root, { readRoots: [root] });

		const readError = captureSync(() => readText(batch, `../${basename(outside)}/secret.txt`));
		expect(readError).toBeInstanceOf(Error);
		expect(readError.code).toBe(":PATH_ESCAPE");

		const escaped = join(root, "..", `${basename(root)}-escaped.txt`);
		const writeError = captureSync(() => write(batch, `../${basename(root)}-escaped.txt`, "nope"));
		expect(writeError).toBeInstanceOf(Error);
		expect(writeError.code).toBe(":PATH_ESCAPE");
		expect(existsSync(escaped)).toBe(false);
		expect(readdirSync(root)).toEqual([]);
	});

	it("rejects an absolute path outside every root without touching disk", () => {
		const root = sandbox();
		const outside = sandbox();
		writeFileSync(join(outside, "secret.txt"), "outside-secret");
		const batch = makeBatch(root, { readRoots: [root] });

		const readError = captureSync(() => readText(batch, join(outside, "secret.txt")));
		expect(readError).toBeInstanceOf(Error);
		expect(readError.code).toBe(":PATH_ESCAPE");

		const target = join(outside, "written.txt");
		const writeError = captureSync(() => write(batch, target, "nope"));
		expect(writeError).toBeInstanceOf(Error);
		expect(writeError.code).toBe(":PATH_ESCAPE");
		expect(existsSync(target)).toBe(false);
		expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("outside-secret");
	});

	it("rejects a symlink that points outside every root", () => {
		const root = sandbox();
		const outside = sandbox();
		const secret = join(outside, "secret.txt");
		writeFileSync(secret, "outside-secret");
		symlinkSync(secret, join(root, "escape-link.txt"));

		const batch = makeBatch(root, { readRoots: [root] });

		const readError = captureSync(() => readText(batch, "escape-link.txt"));
		expect(readError).toBeInstanceOf(Error);
		expect(readError.code).toBe(":PATH_ESCAPE");

		const writeError = captureSync(() => write(batch, "escape-link.txt", "overwritten"));
		expect(writeError).toBeInstanceOf(Error);
		expect(writeError.code).toBe(":PATH_ESCAPE");
		expect(readFileSync(secret, "utf8")).toBe("outside-secret");
	});

	it("reads a symlink that points inside the write root", () => {
		const root = sandbox();
		writeFileSync(join(root, "real.txt"), "inside-content");
		symlinkSync(join(root, "real.txt"), join(root, "alias.txt"));

		const batch = makeBatch(root);
		const read = readText(batch, "alias.txt");

		expect(read.content).toBe("inside-content");
		expect(stat(batch, "alias.txt").isDir).toBe(false);
	});

	it("rejects a NUL byte in a path without touching disk", () => {
		const root = sandbox();
		const batch = makeBatch(root);

		const readError = captureSync(() => readText(batch, "bad\u0000name.txt"));
		expect(readError).toBeInstanceOf(Error);
		expect(readError.code).toBe(":INVALID_ARGUMENT");

		const writeError = captureSync(() => write(batch, "bad\u0000name.txt", "nope"));
		expect(writeError).toBeInstanceOf(Error);
		expect(writeError.code).toBe(":INVALID_ARGUMENT");
		expect(readdirSync(root)).toEqual([]);
	});
});

describe("protected write paths", () => {
	it("rejects .git, .herd, plans/, and AGENTS.md writes with PATH_ESCAPE and zero disk change", () => {
		const root = sandbox();
		mkdirSync(join(root, ".git"));
		mkdirSync(join(root, ".herd"));
		mkdirSync(join(root, "plans"));
		writeFileSync(join(root, "AGENTS.md"), "root-contract");
		const before = treeSnapshot(root);

		const relativeTargets = [".git/config", ".herd/state.edn", "plans/plan.md", "AGENTS.md"];
		for (const target of relativeTargets) {
			const batch = makeBatch(root);
			expectSyncCode(() => attemptWrite(batch, target, "nope"), ":PATH_ESCAPE");
		}

		const absoluteError = captureSync(() => attemptWrite(makeBatch(root), join(root, "plans", "absolute.md"), "nope"));
		expect(absoluteError).toBeInstanceOf(Error);
		expect(absoluteError.code).toBe(":PATH_ESCAPE");

		expect(treeSnapshot(root)).toEqual(before);
	});

	it("still allows reading AGENTS.md from the write root", () => {
		const root = sandbox();
		writeFileSync(join(root, "AGENTS.md"), "root-contract");

		const batch = makeBatch(root);
		expect(readText(batch, "AGENTS.md").content).toBe("root-contract");
	});
});

describe("encoding boundaries", () => {
	it("preserves a BOM byte-for-byte through write, read, and overwrite", async () => {
		const root = sandbox();
		const content = "\uFEFFhéllo 😀";
		const batch = makeBatch(root);

		write(batch, "bom.txt", content);
		const applied = await apply(batch);
		expect(applied.status).toBe(":applied");

		const target = join(root, "bom.txt");
		const bytes = readFileSync(target);
		expect(bytes.equals(Buffer.from(content, "utf8"))).toBe(true);
		expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

		const reader = makeBatch(root);
		const read = readText(reader, "bom.txt");
		expect(read.content).toBe(content);
		expect(read.content.charCodeAt(0)).toBe(0xfeff);
		expect(read.stamp.size).toBe(BigInt(bytes.length));

		write(reader, "bom.txt", `${content}!`);
		const overwritten = await apply(reader);
		expect(overwritten.status).toBe(":applied");
		expect(readFileSync(target, "utf8")).toBe(`${content}!`);
	});

	it("rejects invalid UTF-8 reads with NOT_UTF8 and keeps the bytes intact", () => {
		const root = sandbox();
		const target = join(root, "binary.bin");
		const original = Buffer.from([0x66, 0x6f, 0x80, 0x6f]);
		writeFileSync(target, original);

		const batch = makeBatch(root);
		expect(stat(batch, "binary.bin").exists).toBe(true);

		const error = captureSync(() => readText(batch, "binary.bin"));
		expect(error).toBeInstanceOf(Error);
		expect(error.code).toBe(":NOT_UTF8");
		expect(readFileSync(target).equals(original)).toBe(true);
	});

	it("rejects a lone surrogate on write with NOT_UTF8 and writes nothing", () => {
		const root = sandbox();
		const batch = makeBatch(root);

		const error = captureSync(() => attemptWrite(batch, "lone.txt", "a\uD800b"));
		expect(error).toBeInstanceOf(Error);
		expect(error.code).toBe(":NOT_UTF8");
		expect(existsSync(join(root, "lone.txt"))).toBe(false);
		expect(readdirSync(root)).toEqual([]);
	});

	it("accepts a well-formed surrogate pair", async () => {
		const root = sandbox();
		const batch = makeBatch(root);

		write(batch, "pair.txt", "😀");
		const result = await apply(batch);

		expect(result.status).toBe(":applied");
		expect(readFileSync(join(root, "pair.txt"), "utf8")).toBe("😀");
	});
});

describe("limits", () => {
	it("counts the single-file limit in UTF-8 bytes, not UTF-16 code units", () => {
		const root = sandbox();
		const batch = makeBatch(root);
		const content = "é".repeat(1024 * 1024 + 1);
		expect(Buffer.byteLength(content)).toBeGreaterThan(2 * 1024 * 1024);

		const error = captureSync(() => attemptWrite(batch, "big.txt", content));
		expect(error).toBeInstanceOf(Error);
		expect(error.code).toBe(":LIMIT_EXCEEDED");
		expect(readdirSync(root)).toEqual([]);
	});

	it("rejects a batch whose total exceeds 16 MiB before touching disk", () => {
		const root = sandbox();
		const batch = makeBatch(root);
		const chunk = "a".repeat(2 * 1024 * 1024);

		const error = captureSync(() => {
			for (let index = 0; index < 9; index += 1) {
				write(batch, `part-${index}.txt`, chunk);
			}
			prepare(batch);
		});
		expect(error).toBeInstanceOf(Error);
		expect(error.code).toBe(":LIMIT_EXCEEDED");
		expect(readdirSync(root)).toEqual([]);
	});

	it("rejects the 257th path operation before touching disk", () => {
		const root = sandbox();
		const batch = makeBatch(root);

		const error = captureSync(() => {
			for (let index = 0; index < 257; index += 1) {
				write(batch, `op-${index}.txt`, "x");
			}
			prepare(batch);
		});
		expect(error).toBeInstanceOf(Error);
		expect(error.code).toBe(":LIMIT_EXCEEDED");
		expect(readdirSync(root)).toEqual([]);
	});

	it("honors a configured limits.fileBytes", async () => {
		const root = sandbox();
		const rejecting = makeBatch(root, { limits: { fileBytes: 4 } });
		expectSyncCode(() => attemptWrite(rejecting, "too-big.txt", "12345"), ":LIMIT_EXCEEDED");
		expect(readdirSync(root)).toEqual([]);

		const accepting = makeBatch(root, { limits: { fileBytes: 4 } });
		write(accepting, "exact.txt", "1234");
		expect((await apply(accepting)).status).toBe(":applied");
		expect(readFileSync(join(root, "exact.txt"), "utf8")).toBe("1234");
	});

	it("honors a configured limits.batchBytes", () => {
		const root = sandbox();
		const batch = makeBatch(root, {
			limits: { fileBytes: 16, batchBytes: 8, operations: 16 },
		});

		const error = captureSync(() => {
			write(batch, "a.txt", "1234");
			write(batch, "b.txt", "1234");
			write(batch, "c.txt", "1");
			prepare(batch);
		});
		expect(error).toBeInstanceOf(Error);
		expect(error.code).toBe(":LIMIT_EXCEEDED");
		expect(readdirSync(root)).toEqual([]);
	});

	it("honors a configured limits.operations", () => {
		const root = sandbox();
		const batch = makeBatch(root, {
			limits: { fileBytes: 16, batchBytes: 64, operations: 2 },
		});

		const error = captureSync(() => {
			write(batch, "a.txt", "1");
			write(batch, "b.txt", "1");
			write(batch, "c.txt", "1");
			prepare(batch);
		});
		expect(error).toBeInstanceOf(Error);
		expect(error.code).toBe(":LIMIT_EXCEEDED");
		expect(readdirSync(root)).toEqual([]);
	});
});

describe("read-set conflicts", () => {
	it("rejects a commit when the written target changed after the read", async () => {
		const root = sandbox();
		const target = join(root, "target.txt");
		writeFileSync(target, "original");

		const batch = makeBatch(root);
		expect(readText(batch, "target.txt").content).toBe("original");
		write(batch, "target.txt", "from-batch");
		const prepared = prepare(batch);
		expect(prepared.ok).toBe(true);

		writeFileSync(target, "external-change");

		const result = await commit({ batch, plan: prepared.plan, writeGate, control, identity, claim });
		expect(result.status).toBe(":rejected");
		expect(result.code).toBe(":FILE_CONFLICT");
		expect(result.written).toEqual([]);
		expect(Array.isArray(result.conflicts)).toBe(true);
		expect(result.conflicts.length).toBeGreaterThan(0);
		expect(readFileSync(target, "utf8")).toBe("external-change");
	});

	it("rejects a commit when a read-only dependency changed after the read", async () => {
		const root = sandbox();
		const dependency = join(root, "dependency.txt");
		const output = join(root, "output.txt");
		writeFileSync(dependency, "v1");

		const batch = makeBatch(root);
		expect(readText(batch, "dependency.txt").content).toBe("v1");
		write(batch, "output.txt", "planned-output");
		const prepared = prepare(batch);
		expect(prepared.ok).toBe(true);

		writeFileSync(dependency, "v2-changed-externally");

		const result = await commit({ batch, plan: prepared.plan, writeGate, control, identity, claim });
		expect(result.status).toBe(":rejected");
		expect(result.code).toBe(":FILE_CONFLICT");
		expect(result.written).toEqual([]);
		expect(Array.isArray(result.conflicts)).toBe(true);
		expect(result.conflicts.length).toBeGreaterThan(0);
		expect(existsSync(output)).toBe(false);
		expect(readFileSync(dependency, "utf8")).toBe("v2-changed-externally");
	});

	it("applies a conflict-free batch exactly once", async () => {
		const root = sandbox();
		const batch = makeBatch(root);

		write(batch, "one.txt", "1");
		write(batch, "two.txt", "2");
		const result = await apply(batch);

		expect(result.status).toBe(":applied");
		expect(result.written.length).toBe(2);
		expect(readFileSync(join(root, "one.txt"), "utf8")).toBe("1");
		expect(readFileSync(join(root, "two.txt"), "utf8")).toBe("2");
	});
});
