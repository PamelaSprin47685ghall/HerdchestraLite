import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	commit,
	createBatch,
	drain,
	list,
	mkdir,
	move,
	prepare,
	readText,
	remove,
	runCall,
	stat,
	write,
} from "../src/clj-sandbox/vfs.mjs";
import { writeFileAtomic as atomicWrite } from "../src/util/atomic-write.mjs";

const roots = [];

function sandbox(prefix = "herd-vfs-") {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function file(root, name, content = "") {
	const target = join(root, name);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content, "utf8");
	return target;
}

function caught(fn) {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw");
}

function fakeGate(events = []) {
	let held = false;
	return {
		get held() {
			return held;
		},
		async runExclusive(fn) {
			events.push("gate:acquire");
			held = true;
			try {
				return await fn();
			} finally {
				held = false;
				events.push("gate:release");
			}
		},
	};
}

function fakeControl(overrides = {}) {
	return {
		markApplying() {
			return { ok: true };
		},
		publishResult() {
			return { ok: true };
		},
		markUncertain() {
			return { ok: true };
		},
		markRunning() {
			return { ok: true };
		},
		...overrides,
	};
}

function fakePorts(overrides = {}) {
	return {
		control: fakeControl(),
		identity: { agent_id: "agent-test", term_id: "term-test", status: "alive" },
		claim: { claim_id: "claim-test", status: "active" },
		...overrides,
	};
}

function committed(batch, plan, gate, extra = {}) {
	return commit({ ...fakePorts(), batch, plan, writeGate: gate ?? fakeGate(), ...extra });
}

afterEach(() => {
	while (roots.length > 0) {
		rmSync(roots.pop(), { recursive: true, force: true });
	}
});

describe("stamp and read set", () => {
	it("collects bigint nanosecond stamps and records missing paths", () => {
		const root = sandbox();
		const target = file(root, "a.txt", "hello");
		const batch = createBatch({ writeRoot: root });

		const snapshot = stat(batch, "a.txt");
		expect(snapshot.exists).toBe(true);
		expect(snapshot.size).toBe(5n);
		expect(typeof snapshot.mtimeSec).toBe("bigint");
		expect(typeof snapshot.mtimeNsec).toBe("bigint");
		const real = lstatSync(target, { bigint: true });
		expect(snapshot.mtimeSec * 1_000_000_000n + snapshot.mtimeNsec).toBe(real.mtimeNs);

		const missing = stat(batch, "missing.txt");
		expect(missing.exists).toBe(false);
		expect(batch.readSet.get(join(root, "missing.txt"))).toMatchObject({ exists: false, kind: "missing" });

		const read = readText(batch, "a.txt");
		expect(read.content).toBe("hello");
		expect(read.stamp.size).toBe(5n);
		expect(batch.readSet.get(target).kind).toBe("file");
	});

	it("keeps the read set unchanged for virtual files", () => {
		const root = sandbox();
		const batch = createBatch({ writeRoot: root });
		write(batch, "made.txt", "虚拟");
		const snapshot = stat(batch, "made.txt");
		expect(snapshot.virtual).toBe(true);
		expect(snapshot.size).toBe(BigInt(Buffer.byteLength("虚拟", "utf8")));
		expect(readText(batch, "made.txt").content).toBe("虚拟");
		expect(batch.readSet.size).toBe(0);
		expect(list(batch, "").entries.map((entry) => entry.name)).toEqual(["made.txt"]);
	});

	it("refuses a read whose stamp changes during the read", () => {
		const root = sandbox();
		const target = file(root, "a.txt", "old");
		const io = {
			readFile(path) {
				const bytes = readFileSync(path);
				writeFileSync(target, "changed", "utf8");
				return bytes;
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		expect(caught(() => readText(batch, "a.txt")).code).toBe(":changed-during-read");
		expect(batch.readSet.size).toBe(0);
	});

	it("refuses a repeated read after the file changes", () => {
		const root = sandbox();
		const target = file(root, "a.txt", "one");
		const batch = createBatch({ writeRoot: root });
		readText(batch, "a.txt");
		writeFileSync(target, "two", "utf8");
		expect(caught(() => readText(batch, "a.txt")).code).toBe(":FILE_CONFLICT");
		expect(caught(() => stat(batch, "a.txt")).code).toBe(":FILE_CONFLICT");
	});

	it("excludes atime from the recheck", async () => {
		const root = sandbox();
		const target = file(root, "a.txt", "stable");
		let atimeTick = 0;
		const io = {
			lstat(path) {
				let stats;
				try {
					stats = lstatSync(path, { bigint: true });
				} catch (error) {
					if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
					throw error;
				}
				return new Proxy(stats, {
					get(object, property) {
						// Every lstat observes a different atime. A reader that
						// compared atime would fail the read or the commit recheck.
						if (property === "atimeNs") {
							atimeTick += 1;
							return object.atimeNs + BigInt(atimeTick);
						}
						const value = object[property];
						return typeof value === "function" ? value.bind(object) : value;
					},
				});
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		readText(batch, "a.txt");
		write(batch, "b.txt", "new");
		const gate = fakeGate();
		const result = await committed(batch, prepare(batch).plan, gate);
		expect(result.status).toBe(":applied");
		expect(readFileSync(target, "utf8")).toBe("stable");
		expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("new");
	});

	it("rechecks the target stamp of a read symbolic link", async () => {
		const root = sandbox();
		const real = file(root, "real.txt", "one");
		symlinkSync(real, join(root, "alias.txt"));
		const batch = createBatch({ writeRoot: root });
		readText(batch, "alias.txt");
		write(batch, "out.txt", "x");
		writeFileSync(real, "two", "utf8");
		const result = await committed(batch, prepare(batch).plan);
		expect(result.status).toBe(":rejected");
		expect(result.code).toBe(":FILE_CONFLICT");
		expect(result.conflicts.some((entry) => entry.path === real)).toBe(true);
		expect(existsSync(join(root, "out.txt"))).toBe(false);
	});

	it("rechecks read-only dependency roots", async () => {
		const root = sandbox();
		const main = sandbox("herd-vfs-main-");
		const agents = file(main, "AGENTS.md", "frozen");
		const batch = createBatch({ writeRoot: root, readRoots: [root, agents] });
		readText(batch, agents);
		write(batch, "out.txt", "x");
		writeFileSync(agents, "changed", "utf8");
		const result = await committed(batch, prepare(batch).plan);
		expect(result.status).toBe(":rejected");
		expect(result.code).toBe(":FILE_CONFLICT");
		expect(result.written).toEqual([]);
		expect(existsSync(join(root, "out.txt"))).toBe(false);
	});
});

describe("sequential batch overlay", () => {
	it("moves, rewrites, and commits the final bytes", async () => {
		const root = sandbox();
		const source = file(root, "a.txt", "A");
		const batch = createBatch({ writeRoot: root });
		readText(batch, "a.txt");
		move(batch, "a.txt", "b.txt");
		expect(readText(batch, "b.txt").content).toBe("A");
		write(batch, "b.txt", "B");
		expect(readText(batch, "b.txt").content).toBe("B");
		expect(stat(batch, "a.txt").exists).toBe(false);

		const result = await committed(batch, prepare(batch).plan);
		expect(result.status).toBe(":applied");
		expect(existsSync(source)).toBe(false);
		expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("B");
	});

	it("moves a directory with its virtual children", async () => {
		const root = sandbox();
		const batch = createBatch({ writeRoot: root });
		mkdir(batch, "d");
		write(batch, "d/a.txt", "one");
		move(batch, "d", "e");
		write(batch, "e/a.txt", "two");
		write(batch, "e/b.txt", "three");
		expect(readText(batch, "e/a.txt").content).toBe("two");
		const result = await committed(batch, prepare(batch).plan);
		expect(result.status).toBe(":applied");
		expect(existsSync(join(root, "d"))).toBe(false);
		expect(readFileSync(join(root, "e/a.txt"), "utf8")).toBe("two");
		expect(readFileSync(join(root, "e/b.txt"), "utf8")).toBe("three");
	});

	it("refuses reads and writes after removal but lets mkdir recreate a directory", async () => {
		const root = sandbox();
		const batch = createBatch({ writeRoot: root });
		mkdir(batch, "d");
		write(batch, "d/f.txt", "x");
		remove(batch, "d/f.txt");
		expect(caught(() => readText(batch, "d/f.txt")).code).toBe(":STRUCTURE_CONFLICT");
		expect(caught(() => write(batch, "d/f.txt", "y")).code).toBe(":STRUCTURE_CONFLICT");
		remove(batch, "d");
		expect(caught(() => readText(batch, "d")).code).toBe(":STRUCTURE_CONFLICT");
		mkdir(batch, "d");
		write(batch, "d/g.txt", "z");
		const result = await committed(batch, prepare(batch).plan);
		expect(result.status).toBe(":applied");
		expect(readFileSync(join(root, "d/g.txt"), "utf8")).toBe("z");
	});

	it("overwrites an unread real file", async () => {
		const root = sandbox();
		const target = file(root, "a.txt", "old");
		const batch = createBatch({ writeRoot: root });
		write(batch, "a.txt", "new");
		const result = await committed(batch, prepare(batch).plan);
		expect(result.status).toBe(":applied");
		expect(readFileSync(target, "utf8")).toBe("new");
	});

	it("allows a read real file to be replaced and reports its bytes", () => {
		const root = sandbox();
		file(root, "a.txt", "old");
		const batch = createBatch({ writeRoot: root });
		readText(batch, "a.txt");
		const result = write(batch, "a.txt", "new");
		expect(result.replaced).toBe(true);
		expect(result.bytes).toBe(3n);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("old");
	});

	it("rejects five structural mistakes in memory", () => {
		const root = sandbox();
		file(root, "real.txt", "x");
		const batch = createBatch({ writeRoot: root });
		mkdir(batch, "d");
		expect(caught(() => mkdir(batch, "d")).code).toBe(":PREPARE_REJECTED");
		expect(caught(() => write(batch, "d", "x")).code).toBe(":STRUCTURE_CONFLICT");
		expect(caught(() => mkdir(batch, "real.txt")).code).toBe(":PREPARE_REJECTED");
		expect(caught(() => readText(batch, "d")).code).toBe(":STRUCTURE_CONFLICT");
		expect(caught(() => list(batch, "real.txt")).code).toBe(":STRUCTURE_CONFLICT");
		expect(caught(() => move(batch, "d", "d/sub")).code).toBe(":PREPARE_REJECTED");
	});

	it("refuses a non-empty directory removal and allows an empty stat'ed one", async () => {
		const root = sandbox();
		mkdirSync(join(root, "empty"));
		mkdirSync(join(root, "full"));
		file(root, "full/a.txt", "x");
		const batch = createBatch({ writeRoot: root });
		expect(caught(() => remove(batch, "full")).code).toBe(":STRUCTURE_CONFLICT");
		remove(batch, "empty");
		const result = await committed(batch, prepare(batch).plan);
		expect(result.status).toBe(":applied");
		expect(existsSync(join(root, "empty"))).toBe(false);
		expect(existsSync(join(root, "full/a.txt"))).toBe(true);
	});

	it("never touches disk before commit", () => {
		const root = sandbox();
		const old = file(root, "old.txt", "old");
		const batch = createBatch({ writeRoot: root });
		readText(batch, "old.txt");
		write(batch, "new.txt", "new");
		mkdir(batch, "dir");
		remove(batch, "old.txt");
		expect(readFileSync(old, "utf8")).toBe("old");
		expect(existsSync(join(root, "new.txt"))).toBe(false);
		expect(existsSync(join(root, "dir"))).toBe(false);
		expect(batch.committed).toBe(0);
	});

	it("moves a non-empty real directory and applies later child operations", async () => {
		const root = sandbox();
		mkdirSync(join(root, "D", "sub"), { recursive: true });
		file(root, "D/a.txt", "A");
		file(root, "D/sub/b.txt", "B");
		const batch = createBatch({ writeRoot: root });
		move(batch, "D", "E");
		expect(readText(batch, "E/a.txt").content).toBe("A");
		expect(list(batch, "E").entries.map((entry) => entry.name)).toEqual(["a.txt", "sub"]);
		write(batch, "E/a.txt", "A2");
		write(batch, "E/new.txt", "N");
		readText(batch, "E/sub/b.txt");
		remove(batch, "E/sub/b.txt");
		const result = await committed(batch, prepare(batch).plan);
		expect(result.status).toBe(":applied");
		expect(existsSync(join(root, "D"))).toBe(false);
		expect(readFileSync(join(root, "E/a.txt"), "utf8")).toBe("A2");
		expect(readFileSync(join(root, "E/new.txt"), "utf8")).toBe("N");
		expect(existsSync(join(root, "E/sub/b.txt"))).toBe(false);
		expect(lstatSync(join(root, "E/sub")).isDirectory()).toBe(true);
		expect(readText(batch, "E/a.txt").content).toBe("A2");
		expect(stat(batch, "E").isDir).toBe(true);
		expect(list(batch, "E").entries.map((entry) => entry.name)).toEqual(["a.txt", "new.txt", "sub"]);
	});

	it("hides the old source subtree after a directory move", () => {
		const root = sandbox();
		mkdirSync(join(root, "D"));
		file(root, "D/child.txt", "C");
		const batch = createBatch({ writeRoot: root });
		move(batch, "D", "E");
		expect(caught(() => readText(batch, "D/child.txt")).code).toBe(":STRUCTURE_CONFLICT");
		expect(stat(batch, "D/child.txt").exists).toBe(false);
		expect(list(batch, "D").exists).toBe(false);
		expect(readText(batch, "E/child.txt").content).toBe("C");
	});

	it("moves a symbolic link inside the roots", async () => {
		const root = sandbox();
		const real = file(root, "real.txt", "target");
		symlinkSync(real, join(root, "link"));
		const batch = createBatch({ writeRoot: root });
		move(batch, "link", "alias");
		expect(stat(batch, "alias").isSymlink).toBe(true);
		expect(readText(batch, "alias").content).toBe("target");
		const result = await committed(batch, prepare(batch).plan);
		expect(result.status).toBe(":applied");
		expect(existsSync(join(root, "link"))).toBe(false);
		expect(lstatSync(join(root, "alias")).isSymbolicLink()).toBe(true);
		expect(readFileSync(real, "utf8")).toBe("target");
	});

	it("moves a file larger than the text limit without reading it", async () => {
		const root = sandbox();
		file(root, "large.bin", "1234567890");
		const batch = createBatch({ writeRoot: root, limits: { fileBytes: 4 } });
		move(batch, "large.bin", "moved.bin");
		const result = await committed(batch, prepare(batch).plan);
		expect(result.status).toBe(":applied");
		expect(readFileSync(join(root, "moved.bin"), "utf8")).toBe("1234567890");
		expect(existsSync(join(root, "large.bin"))).toBe(false);
	});

	it("renames over a read target file and an empty target directory", async () => {
		const root = sandbox();
		file(root, "a.txt", "A");
		file(root, "b.txt", "B");
		const batch = createBatch({ writeRoot: root });
		readText(batch, "b.txt");
		move(batch, "a.txt", "b.txt", { overwrite: true });
		expect((await committed(batch, prepare(batch).plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("A");
		expect(existsSync(join(root, "a.txt"))).toBe(false);

		mkdirSync(join(root, "D"));
		file(root, "D/child.txt", "C");
		mkdirSync(join(root, "empty"));
		const second = createBatch({ writeRoot: root });
		stat(second, "empty");
		move(second, "D", "empty", { overwrite: true });
		expect((await committed(second, prepare(second).plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "empty/child.txt"), "utf8")).toBe("C");
		expect(existsSync(join(root, "D"))).toBe(false);
	});

	it("creates a missing move target parent before the rename", async () => {
		const root = sandbox();
		file(root, "a.txt", "A");
		const batch = createBatch({ writeRoot: root });
		mkdir(batch, "out");
		move(batch, "a.txt", "out/b.txt");
		const plan = prepare(batch).plan;
		expect(plan.operations.map((step) => step.kind)).toEqual(["mkdir", "move"]);
		expect((await committed(batch, plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "out/b.txt"), "utf8")).toBe("A");
	});

	it("replaces a file target parent before the rename", async () => {
		const root = sandbox();
		file(root, "P", "old-parent");
		file(root, "X", "x");
		const batch = createBatch({ writeRoot: root });
		stat(batch, "P");
		remove(batch, "P");
		mkdir(batch, "P");
		readText(batch, "X");
		move(batch, "X", "P/x.txt");
		const plan = prepare(batch).plan;
		expect(plan.operations.map((step) => step.kind)).toEqual(["remove-file", "mkdir", "move"]);
		expect((await committed(batch, plan)).status).toBe(":applied");
		expect(lstatSync(join(root, "P")).isDirectory()).toBe(true);
		expect(readFileSync(join(root, "P/x.txt"), "utf8")).toBe("x");
		expect(existsSync(join(root, "X"))).toBe(false);
	});

	it("unlinks a symlink target parent before the rename", async () => {
		const root = sandbox();
		mkdirSync(join(root, "target"));
		symlinkSync(join(root, "target"), join(root, "P"));
		file(root, "X", "x");
		const batch = createBatch({ writeRoot: root });
		stat(batch, "P");
		remove(batch, "P");
		mkdir(batch, "P");
		readText(batch, "X");
		move(batch, "X", "P/x.txt");
		expect((await committed(batch, prepare(batch).plan)).status).toBe(":applied");
		expect(lstatSync(join(root, "P")).isDirectory()).toBe(true);
		expect(readFileSync(join(root, "P/x.txt"), "utf8")).toBe("x");
		expect(existsSync(join(root, "target/x.txt"))).toBe(false);
	});

	it("creates a missing parent for a directory move", async () => {
		const root = sandbox();
		mkdirSync(join(root, "D"));
		file(root, "D/child.txt", "C");
		const batch = createBatch({ writeRoot: root });
		mkdir(batch, "out");
		move(batch, "D", "out/E");
		const plan = prepare(batch).plan;
		expect(plan.operations.map((step) => step.kind)).toEqual(["mkdir", "move"]);
		expect((await committed(batch, plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "out/E/child.txt"), "utf8")).toBe("C");
		expect(existsSync(join(root, "D"))).toBe(false);
	});

	it("moves a child out before moving its parent directory", async () => {
		const root = sandbox();
		mkdirSync(join(root, "D"));
		file(root, "D/keep.txt", "K");
		file(root, "D/sub.txt", "S");
		const batch = createBatch({ writeRoot: root });
		move(batch, "D/sub.txt", "F");
		move(batch, "D", "E");
		const plan = prepare(batch).plan;
		expect(plan.operations.map((step) => step.kind)).toEqual(["move", "move"]);
		expect((await committed(batch, plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "F"), "utf8")).toBe("S");
		expect(readFileSync(join(root, "E/keep.txt"), "utf8")).toBe("K");
		expect(existsSync(join(root, "E/sub.txt"))).toBe(false);
		expect(existsSync(join(root, "D"))).toBe(false);
	});

	it("moves a file within the same directory and reads it before commit", async () => {
		const root = sandbox();
		mkdirSync(join(root, "D"));
		file(root, "D/sub.txt", "S");
		const batch = createBatch({ writeRoot: root });
		move(batch, "D/sub.txt", "D/other.txt");
		expect(readText(batch, "D/other.txt").content).toBe("S");
		expect(stat(batch, "D/other.txt").size).toBe(1n);
		write(batch, "D/other.txt", "N");
		expect((await committed(batch, prepare(batch).plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "D/other.txt"), "utf8")).toBe("N");
		expect(existsSync(join(root, "D/sub.txt"))).toBe(false);
	});

	it("moves a child out after moving its parent directory", async () => {
		const root = sandbox();
		mkdirSync(join(root, "D"));
		file(root, "D/a.txt", "A");
		file(root, "D/b.txt", "B");
		const batch = createBatch({ writeRoot: root });
		move(batch, "D", "E");
		move(batch, "E/b.txt", "F");
		const result = await committed(batch, prepare(batch).plan);
		expect(result.status).toBe(":applied");
		expect(readFileSync(join(root, "F"), "utf8")).toBe("B");
		expect(readFileSync(join(root, "E/a.txt"), "utf8")).toBe("A");
		expect(existsSync(join(root, "E/b.txt"))).toBe(false);
		expect(existsSync(join(root, "D"))).toBe(false);
	});

	it("moves a directory that contains an earlier move target", async () => {
		const root = sandbox();
		mkdirSync(join(root, "D"));
		file(root, "D/sub.txt", "S");
		const batch = createBatch({ writeRoot: root });
		move(batch, "D/sub.txt", "D/other.txt");
		move(batch, "D", "E");
		expect((await committed(batch, prepare(batch).plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "E/other.txt"), "utf8")).toBe("S");
		expect(existsSync(join(root, "E/sub.txt"))).toBe(false);
		expect(existsSync(join(root, "D"))).toBe(false);
	});

	it("chains file and directory moves", async () => {
		const root = sandbox();
		file(root, "a.txt", "A");
		mkdirSync(join(root, "D"));
		file(root, "D/child.txt", "C");
		const batch = createBatch({ writeRoot: root });
		move(batch, "a.txt", "b.txt");
		move(batch, "b.txt", "c.txt");
		move(batch, "D", "E");
		move(batch, "E", "F");
		const plan = prepare(batch).plan;
		expect(plan.operations.map((step) => step.kind)).toEqual(["move", "move", "move", "move"]);
		expect((await committed(batch, plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "c.txt"), "utf8")).toBe("A");
		expect(readFileSync(join(root, "F/child.txt"), "utf8")).toBe("C");
		expect(existsSync(join(root, "a.txt"))).toBe(false);
		expect(existsSync(join(root, "b.txt"))).toBe(false);
		expect(existsSync(join(root, "D"))).toBe(false);
		expect(existsSync(join(root, "E"))).toBe(false);
	});

	it("round-trips a file and recreates a moved source by another move", async () => {
		const root = sandbox();
		file(root, "a.txt", "A");
		file(root, "c.txt", "C");
		const batch = createBatch({ writeRoot: root });
		move(batch, "a.txt", "b.txt");
		move(batch, "b.txt", "a.txt");
		move(batch, "c.txt", "a.txt", { overwrite: true });
		const plan = prepare(batch).plan;
		expect((await committed(batch, plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("C");
		expect(existsSync(join(root, "b.txt"))).toBe(false);
		expect(existsSync(join(root, "c.txt"))).toBe(false);
	});

	it("moves a target under a moved directory", async () => {
		const root = sandbox();
		mkdirSync(join(root, "D"));
		file(root, "D/keep.txt", "K");
		file(root, "x.txt", "X");
		const batch = createBatch({ writeRoot: root });
		move(batch, "D", "E");
		move(batch, "x.txt", "E/x.txt");
		const plan = prepare(batch).plan;
		expect(plan.operations.map((step) => step.kind)).toEqual(["move", "move"]);
		expect((await committed(batch, plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "E/keep.txt"), "utf8")).toBe("K");
		expect(readFileSync(join(root, "E/x.txt"), "utf8")).toBe("X");
		expect(existsSync(join(root, "D"))).toBe(false);
	});

	it("moves a child out after a chained parent move", async () => {
		const root = sandbox();
		mkdirSync(join(root, "D"));
		file(root, "D/a.txt", "A");
		file(root, "D/b.txt", "B");
		const batch = createBatch({ writeRoot: root });
		move(batch, "D", "E");
		move(batch, "E", "F");
		move(batch, "F/b.txt", "G");
		expect((await committed(batch, prepare(batch).plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "F/a.txt"), "utf8")).toBe("A");
		expect(readFileSync(join(root, "G"), "utf8")).toBe("B");
		expect(existsSync(join(root, "F/b.txt"))).toBe(false);
		expect(existsSync(join(root, "D"))).toBe(false);
		expect(existsSync(join(root, "E"))).toBe(false);
	});

	it("recreates a moved source as a directory or file", async () => {
		const root = sandbox();
		mkdirSync(join(root, "D"));
		file(root, "D/old.txt", "OLD");
		file(root, "x.txt", "X");
		const batch = createBatch({ writeRoot: root });
		move(batch, "D", "E");
		mkdir(batch, "D");
		write(batch, "D/new.txt", "NEW");
		move(batch, "x.txt", "D/x.txt");
		expect(readText(batch, "D/new.txt").content).toBe("NEW");
		expect(stat(batch, "D/old.txt").exists).toBe(false);
		expect(
			list(batch, "D")
				.entries.map((entry) => entry.name)
				.sort(),
		).toEqual(["new.txt", "x.txt"]);
		const plan = prepare(batch).plan;
		expect(plan.operations.map((step) => step.kind)).toEqual(["move", "mkdir", "write", "move"]);
		expect((await committed(batch, plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "D/new.txt"), "utf8")).toBe("NEW");
		expect(readFileSync(join(root, "D/x.txt"), "utf8")).toBe("X");
		expect(existsSync(join(root, "D/old.txt"))).toBe(false);
		expect(readFileSync(join(root, "E/old.txt"), "utf8")).toBe("OLD");
		expect(existsSync(join(root, "E/new.txt"))).toBe(false);

		file(root, "single.txt", "S");
		const second = createBatch({ writeRoot: root });
		move(second, "single.txt", "moved.txt");
		write(second, "single.txt", "recreated");
		expect((await committed(second, prepare(second).plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "single.txt"), "utf8")).toBe("recreated");
		expect(readFileSync(join(root, "moved.txt"), "utf8")).toBe("S");
	});

	it("recreates a virtual source after moving it", async () => {
		const root = sandbox();
		const batch = createBatch({ writeRoot: root });
		write(batch, "a.txt", "A");
		move(batch, "a.txt", "b.txt");
		write(batch, "a.txt", "B");
		expect((await committed(batch, prepare(batch).plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("B");
		expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("A");
	});

	it("replaces a directory after one of its children moved out", async () => {
		const root = sandbox();
		mkdirSync(join(root, "A"));
		file(root, "A/x.txt", "X");
		mkdirSync(join(root, "C"));
		file(root, "C/keep.txt", "K");
		const batch = createBatch({ writeRoot: root });
		move(batch, "A/x.txt", "B");
		stat(batch, "A");
		move(batch, "C", "A", { overwrite: true });
		expect((await committed(batch, prepare(batch).plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "B"), "utf8")).toBe("X");
		expect(readFileSync(join(root, "A/keep.txt"), "utf8")).toBe("K");
		expect(existsSync(join(root, "A/x.txt"))).toBe(false);
		expect(existsSync(join(root, "C"))).toBe(false);
	});

	it("moves a target under a moved directory after removing the old child", async () => {
		const root = sandbox();
		mkdirSync(join(root, "D"));
		file(root, "D/y.txt", "Y");
		file(root, "D/keep.txt", "K");
		file(root, "x.txt", "X");
		const batch = createBatch({ writeRoot: root });
		move(batch, "D", "E");
		readText(batch, "E/y.txt");
		remove(batch, "E/y.txt");
		move(batch, "x.txt", "E/y.txt");
		expect((await committed(batch, prepare(batch).plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "E/y.txt"), "utf8")).toBe("X");
		expect(readFileSync(join(root, "E/keep.txt"), "utf8")).toBe("K");
		expect(existsSync(join(root, "D"))).toBe(false);
	});

	it("moves onto a recreated file or directory", async () => {
		const root = sandbox();
		file(root, "a.txt", "A");
		file(root, "x.txt", "X");
		const batch = createBatch({ writeRoot: root });
		move(batch, "a.txt", "b.txt");
		write(batch, "a.txt", "recreated");
		move(batch, "x.txt", "a.txt", { overwrite: true });
		expect(readText(batch, "a.txt").content).toBe("X");
		expect((await committed(batch, prepare(batch).plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("X");
		expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("A");
		expect(existsSync(join(root, "x.txt"))).toBe(false);

		mkdirSync(join(root, "A"));
		file(root, "A/old.txt", "OLD");
		mkdirSync(join(root, "C"));
		file(root, "C/keep.txt", "K");
		const second = createBatch({ writeRoot: root });
		move(second, "A", "B");
		mkdir(second, "A");
		write(second, "A/virtual.txt", "V");
		remove(second, "A/virtual.txt");
		move(second, "C", "A", { overwrite: true });
		expect(readText(second, "A/keep.txt").content).toBe("K");
		expect(stat(second, "A/virtual.txt").exists).toBe(false);
		expect((await committed(second, prepare(second).plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "A/keep.txt"), "utf8")).toBe("K");
		expect(existsSync(join(root, "A/virtual.txt"))).toBe(false);
		expect(readFileSync(join(root, "B/old.txt"), "utf8")).toBe("OLD");
		expect(existsSync(join(root, "C"))).toBe(false);
	});

	it("recreates a removed move target and removes a recreated target", async () => {
		const root = sandbox();
		mkdirSync(join(root, "A"));
		const batch = createBatch({ writeRoot: root });
		move(batch, "A", "B");
		remove(batch, "B");
		mkdir(batch, "B");
		write(batch, "B/new.txt", "N");
		expect((await committed(batch, prepare(batch).plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "B/new.txt"), "utf8")).toBe("N");
		expect(existsSync(join(root, "A"))).toBe(false);

		file(root, "c.txt", "C");
		file(root, "d.txt", "D");
		const second = createBatch({ writeRoot: root });
		move(second, "c.txt", "e.txt");
		move(second, "d.txt", "c.txt", { overwrite: true });
		remove(second, "c.txt");
		expect((await committed(second, prepare(second).plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "e.txt"), "utf8")).toBe("C");
		expect(existsSync(join(root, "c.txt"))).toBe(false);
		expect(existsSync(join(root, "d.txt"))).toBe(false);
	});
});

describe("limits", () => {
	it("enforces file, batch, and operation limits with operation indexes", () => {
		const root = sandbox();
		const batch = createBatch({
			writeRoot: root,
			limits: { fileBytes: 4, batchBytes: 5, operations: 2 },
		});
		const tooBig = caught(() => write(batch, "a.txt", "12345"));
		expect(tooBig.code).toBe(":LIMIT_EXCEEDED");
		expect(tooBig.data.limit).toBe("fileBytes");
		expect(tooBig.data.operationIndex).toBe(1);

		write(batch, "a.txt", "1234");
		const batchTooBig = caught(() => write(batch, "b.txt", "56"));
		expect(batchTooBig.code).toBe(":LIMIT_EXCEEDED");
		expect(batchTooBig.data.limit).toBe("batchBytes");

		write(batch, "c.txt", "");
		const tooMany = caught(() => write(batch, "d.txt", ""));
		expect(tooMany.code).toBe(":LIMIT_EXCEEDED");
		expect(tooMany.data.limit).toBe("operations");
		expect(tooMany.data.operationIndex).toBe(3);
	});

	it("limits text reads but not stat", () => {
		const root = sandbox();
		file(root, "a.txt", "12345");
		const batch = createBatch({ writeRoot: root, limits: { fileBytes: 4 } });
		expect(stat(batch, "a.txt").size).toBe(5n);
		expect(caught(() => readText(batch, "a.txt")).code).toBe(":LIMIT_EXCEEDED");
	});

	it("counts every write toward the batch byte limit even after removal", () => {
		const root = sandbox();
		const batch = createBatch({ writeRoot: root, limits: { fileBytes: 4, batchBytes: 5 } });
		write(batch, "a.txt", "1234");
		remove(batch, "a.txt");
		const error = caught(() => write(batch, "b.txt", "1234"));
		expect(error.code).toBe(":LIMIT_EXCEEDED");
		expect(error.data.limit).toBe("batchBytes");
	});

	it("refuses the filesystem root as a write root", () => {
		expect(caught(() => createBatch({ writeRoot: "/" })).code).toBe(":INVALID_ARGUMENT");
	});
});

describe("commit recheck and atomic apply", () => {
	it("rejects a stamp conflict before any write", async () => {
		const root = sandbox();
		const target = file(root, "a.txt", "old");
		const batch = createBatch({ writeRoot: root });
		readText(batch, "a.txt");
		write(batch, "b.txt", "new");
		writeFileSync(target, "other", "utf8");
		const gate = fakeGate();
		const result = await committed(batch, prepare(batch).plan, gate);
		expect(result.status).toBe(":rejected");
		expect(result.code).toBe(":FILE_CONFLICT");
		expect(result.written).toEqual([]);
		expect(result.conflicts[0].path).toBe(target);
		expect(result.conflicts[0].expected.size).toBe(3n);
		expect(existsSync(join(root, "b.txt"))).toBe(false);
		expect(gate.held).toBe(false);
	});

	it("rejects a type conflict even when sizes match", async () => {
		const root = sandbox();
		const target = file(root, "a.txt", "data");
		const batch = createBatch({ writeRoot: root });
		stat(batch, "a.txt");
		write(batch, "b.txt", "x");
		rmSync(target);
		mkdirSync(target);
		const result = await committed(batch, prepare(batch).plan);
		expect(result.status).toBe(":rejected");
		expect(result.code).toBe(":STRUCTURE_CONFLICT");
		expect(existsSync(join(root, "b.txt"))).toBe(false);
	});

	it("rechecks an empty write set for finish facts", async () => {
		const root = sandbox();
		const target = file(root, "a.txt", "fact");
		const batch = createBatch({ writeRoot: root });
		readText(batch, "a.txt");
		const plan = prepare(batch).plan;
		expect(plan.operations).toEqual([]);
		const clean = await committed(batch, plan);
		expect(clean.status).toBe(":applied");
		expect(clean.written).toEqual([]);
		expect(clean.skipped).not.toBe(true);

		writeFileSync(target, "changed", "utf8");
		const second = createBatch({ writeRoot: root });
		readText(second, "a.txt");
		writeFileSync(target, "changed-again", "utf8");
		const conflict = await committed(second, prepare(second).plan);
		expect(conflict.status).toBe(":rejected");
		expect(conflict.code).toBe(":FILE_CONFLICT");
	});

	it("marks applying after recheck and publishes after writes", async () => {
		const root = sandbox();
		const events = [];
		const io = {
			writeFileAtomic(dir, name, content) {
				events.push("write");
				return atomicWrite(dir, name, content);
			},
		};
		const owned = createBatch({ writeRoot: root, io });
		write(owned, "a.txt", "A");
		const gate = fakeGate(events);
		const control = {
			markApplying() {
				events.push("control:applying");
				return { ok: true };
			},
			publishResult() {
				events.push("control:publish");
				return { ok: true };
			},
		};
		const result = await commit({
			batch: owned,
			plan: prepare(owned).plan,
			writeGate: gate,
			...fakePorts({ control: fakeControl(control) }),
		});
		expect(result.status).toBe(":applied");
		expect(result.recorded).toBe(true);
		expect(events).toEqual(["gate:acquire", "control:applying", "write", "control:publish", "gate:release"]);
		expect(existsSync(join(root, "a.txt"))).toBe(true);
	});

	it("uses a sibling temporary file and never exposes a partial target", async () => {
		const root = sandbox();
		const _target = file(root, "a.txt", "old");
		const seen = [];
		const io = {
			writeFileAtomic(dir, name, content) {
				if (existsSync(join(dir, name))) seen.push(readFileSync(join(dir, name), "utf8"));
				const result = atomicWrite(dir, name, content);
				seen.push(readFileSync(join(dir, name), "utf8"));
				return result;
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		readText(batch, "a.txt");
		write(batch, "a.txt", "new");
		const result = await committed(batch, prepare(batch).plan);
		expect(result.status).toBe(":applied");
		expect(seen).toEqual(["old", "new"]);
		expect(readdirSync(root).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
	});

	it("preserves the executable mode on overwrite and move", async () => {
		const root = sandbox();
		const script = file(root, "run.sh", "#!/bin/sh\n");
		chmodSync(script, 0o755);
		const batch = createBatch({ writeRoot: root });
		readText(batch, "run.sh");
		write(batch, "run.sh", "#!/bin/sh\necho hi\n");
		expect((await committed(batch, prepare(batch).plan)).status).toBe(":applied");
		expect(Number(lstatSync(script, { bigint: true }).mode & 0o777n)).toBe(0o755);

		const mover = file(root, "mv.sh", "#!/bin/sh\n");
		chmodSync(mover, 0o755);
		const second = createBatch({ writeRoot: root });
		readText(second, "mv.sh");
		move(second, "mv.sh", "bin.sh");
		expect((await committed(second, prepare(second).plan)).status).toBe(":applied");
		expect(existsSync(mover)).toBe(false);
		expect(Number(lstatSync(join(root, "bin.sh"), { bigint: true }).mode & 0o777n)).toBe(0o755);
	});

	it("reports applied, uncertain, and pending paths on a hard failure", async () => {
		const root = sandbox();
		const _batch = createBatch({ writeRoot: root });
		let writes = 0;
		const io = {
			writeFileAtomic(dir, name, content) {
				writes += 1;
				if (writes === 2) {
					const error = new Error("simulated disk failure");
					error.code = "EIO";
					error.stage = "rename";
					throw error;
				}
				return atomicWrite(dir, name, content);
			},
		};
		const owned = createBatch({ writeRoot: root, io });
		write(owned, "a.txt", "A");
		write(owned, "b.txt", "B");
		write(owned, "c.txt", "C");
		const uncertain = [];
		const control = {
			markApplying() {
				return { ok: true };
			},
			markUncertain(payload) {
				uncertain.push(payload);
				return { ok: true };
			},
			publishResult() {
				throw new Error("publish must not run");
			},
		};
		const result = await commit({
			batch: owned,
			plan: prepare(owned).plan,
			writeGate: fakeGate(),
			...fakePorts({ control: fakeControl(control) }),
		});
		expect(result.status).toBe(":uncertain");
		expect(result.written).toEqual([join(root, "a.txt")]);
		expect(result.uncertain[0].path).toBe(join(root, "b.txt"));
		expect(result.pending).toEqual([join(root, "c.txt")]);
		expect(existsSync(join(root, "a.txt"))).toBe(true);
		expect(existsSync(join(root, "b.txt"))).toBe(false);
		expect(existsSync(join(root, "c.txt"))).toBe(false);
		expect(uncertain).toHaveLength(1);
		const again = await commit({
			batch: owned,
			plan: prepare(owned).plan,
			writeGate: fakeGate(),
			...fakePorts(),
		});
		expect(again.status).toBe(":rejected");
		expect(writes).toBe(2);
	});

	it("does not replay writes when result publication fails", async () => {
		const root = sandbox();
		let writes = 0;
		const io = {
			writeFileAtomic(dir, name, content) {
				writes += 1;
				return atomicWrite(dir, name, content);
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		write(batch, "a.txt", "A");
		const plan = prepare(batch).plan;
		const control = {
			markApplying() {
				return { ok: true };
			},
			publishResult() {
				throw new Error("board lock is gone");
			},
		};
		const result = await commit({
			batch,
			plan,
			writeGate: fakeGate(),
			...fakePorts({ control: fakeControl(control) }),
		});
		expect(result.status).toBe(":applied");
		expect(result.recorded).toBe(false);
		expect(writes).toBe(1);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("A");
		const replay = await commit({
			batch,
			plan,
			writeGate: fakeGate(),
			...fakePorts({ control: fakeControl(control) }),
		});
		expect(replay.status).toBe(":rejected");
		expect(writes).toBe(1);
	});

	it("returns stale plans and dead identities without touching disk", async () => {
		const root = sandbox();
		const batch = createBatch({ writeRoot: root });
		write(batch, "a.txt", "A");
		const plan = prepare(batch).plan;
		write(batch, "b.txt", "B");
		const stale = await committed(batch, plan);
		expect(stale.status).toBe(":rejected");
		expect(stale.code).toBe(":PREPARE_REJECTED");
		expect(existsSync(join(root, "a.txt"))).toBe(false);

		const fresh = createBatch({ writeRoot: root });
		write(fresh, "c.txt", "C");
		const dead = await commit({
			batch: fresh,
			plan: prepare(fresh).plan,
			writeGate: fakeGate(),
			...fakePorts({ identity: { agent_id: "a", term_id: "t", status: "dead" } }),
		});
		expect(dead.status).toBe(":rejected");
		expect(dead.code).toBe(":ACTOR_DEAD");
		expect(existsSync(join(root, "c.txt"))).toBe(false);
	});

	it("returns stale control refusals without touching disk", async () => {
		const root = sandbox();
		const batch = createBatch({ writeRoot: root });
		write(batch, "a.txt", "A");
		const control = {
			markApplying() {
				return { ok: false, code: ":STALE_CONTROL", message: "claim moved" };
			},
		};
		const gate = fakeGate();
		const result = await commit({
			batch,
			plan: prepare(batch).plan,
			writeGate: gate,
			...fakePorts({ control: fakeControl(control) }),
		});
		expect(result.status).toBe(":rejected");
		expect(result.code).toBe(":STALE_CONTROL");
		expect(existsSync(join(root, "a.txt"))).toBe(false);
		expect(gate.held).toBe(false);
	});

	it("clears the overlay after a successful commit", async () => {
		const root = sandbox();
		const batch = createBatch({ writeRoot: root });
		write(batch, "a.txt", "A");
		const plan = prepare(batch).plan;
		const first = await committed(batch, plan);
		expect(first.status).toBe(":applied");
		expect(batch.overlay.size).toBe(0);
		expect(batch.operations).toEqual([]);
		const second = await committed(batch, plan);
		expect(second.status).toBe(":rejected");
		expect(second.code).toBe(":PREPARE_REJECTED");
	});

	it("clears a batch whose virtual operations cancel out", async () => {
		const root = sandbox();
		const batch = createBatch({ writeRoot: root });
		mkdir(batch, "d");
		remove(batch, "d");
		const plan = prepare(batch).plan;
		expect(plan.operations.map((step) => step.kind)).toEqual(["mkdir", "remove-dir"]);
		const result = await committed(batch, plan);
		expect(result.status).toBe(":applied");
		expect(batch.overlay.size).toBe(0);
		expect(batch.prepared).toBeNull();
		expect(existsSync(join(root, "d"))).toBe(false);
	});

	it("lets the program re-read a path after its own commit", async () => {
		const root = sandbox();
		const target = file(root, "a.txt", "old");
		const batch = createBatch({ writeRoot: root });
		readText(batch, "a.txt");
		stat(batch, ".");
		write(batch, "a.txt", "new");
		const result = await committed(batch, prepare(batch).plan);
		expect(result.status).toBe(":applied");
		expect(readText(batch, "a.txt").content).toBe("new");
		expect(stat(batch, "a.txt").size).toBe(3n);
		expect(stat(batch, ".").exists).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("new");
	});

	it("rejects a plan prepared before a later read dependency", async () => {
		const root = sandbox();
		file(root, "a.txt", "a");
		file(root, "b.txt", "b");
		const batch = createBatch({ writeRoot: root });
		readText(batch, "a.txt");
		write(batch, "c.txt", "c");
		const plan = prepare(batch).plan;
		readText(batch, "b.txt");
		const result = await committed(batch, plan);
		expect(result.status).toBe(":rejected");
		expect(result.code).toBe(":PREPARE_REJECTED");
		expect(existsSync(join(root, "c.txt"))).toBe(false);
	});

	it("renames a move source atomically and preserves it on failure", async () => {
		const root = sandbox();
		const source = file(root, "a.txt", "A");
		const io = {
			rename() {
				const error = new Error("simulated disk full");
				error.code = "ENOSPC";
				error.stage = "rename";
				throw error;
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		readText(batch, "a.txt");
		move(batch, "a.txt", "b.txt");
		const plan = prepare(batch).plan;
		expect(plan.operations.map((step) => step.kind)).toEqual(["move"]);
		const result = await commit({ batch, plan, writeGate: fakeGate(), ...fakePorts() });
		expect(result.status).toBe(":uncertain");
		expect(result.uncertain[0].path).toBe(join(root, "b.txt"));
		expect(result.pending).toEqual([]);
		expect(readFileSync(source, "utf8")).toBe("A");
		expect(existsSync(join(root, "b.txt"))).toBe(false);
	});

	it("removes a moved file after replacing a directory target", async () => {
		const root = sandbox();
		mkdirSync(join(root, "T"));
		file(root, "A", "a");
		const batch = createBatch({ writeRoot: root });
		stat(batch, "T");
		remove(batch, "T");
		move(batch, "A", "T");
		remove(batch, "T");
		const plan = prepare(batch).plan;
		expect(plan.operations.map((step) => step.kind)).toEqual(["remove-dir", "move", "remove-file"]);
		expect((await committed(batch, plan)).status).toBe(":applied");
		expect(existsSync(join(root, "T"))).toBe(false);
		expect(existsSync(join(root, "A"))).toBe(false);
	});

	it("removes old target children before a directory rename replaces them", async () => {
		const root = sandbox();
		mkdirSync(join(root, "T"));
		file(root, "T/child.txt", "C");
		mkdirSync(join(root, "D"));
		file(root, "D/keep.txt", "K");
		const batch = createBatch({ writeRoot: root });
		readText(batch, "T/child.txt");
		remove(batch, "T/child.txt");
		stat(batch, "T");
		move(batch, "D", "T", { overwrite: true });
		const plan = prepare(batch).plan;
		expect(plan.operations.map((step) => step.kind)).toEqual(["remove-file", "move"]);
		expect((await committed(batch, plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "T/keep.txt"), "utf8")).toBe("K");
		expect(existsSync(join(root, "T/child.txt"))).toBe(false);
		expect(existsSync(join(root, "D"))).toBe(false);
	});

	it("requires removing virtual children before replacing a directory", async () => {
		const root = sandbox();
		mkdirSync(join(root, "T"));
		mkdirSync(join(root, "D"));
		file(root, "D/keep.txt", "K");
		const batch = createBatch({ writeRoot: root });
		write(batch, "T/old.txt", "virtual");
		stat(batch, "T");
		expect(caught(() => move(batch, "D", "T", { overwrite: true })).code).toBe(":STRUCTURE_CONFLICT");
		remove(batch, "T/old.txt");
		move(batch, "D", "T", { overwrite: true });
		const plan = prepare(batch).plan;
		expect(plan.operations.map((step) => step.kind)).toEqual(["write", "remove-file", "move"]);
		expect((await committed(batch, plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "T/keep.txt"), "utf8")).toBe("K");
		expect(existsSync(join(root, "T/old.txt"))).toBe(false);
		expect(existsSync(join(root, "D"))).toBe(false);
	});

	it("writes a moved target after a symlink overwrite without deleting it first", async () => {
		const root = sandbox();
		const real = file(root, "real.txt", "real");
		symlinkSync(real, join(root, "B"));
		file(root, "A", "A");
		const batch = createBatch({ writeRoot: root });
		readText(batch, "B");
		move(batch, "A", "B", { overwrite: true });
		write(batch, "B", "new");
		const plan = prepare(batch).plan;
		expect(plan.operations.map((step) => step.kind)).toEqual(["move", "write"]);
		expect((await committed(batch, plan)).status).toBe(":applied");
		expect(lstatSync(join(root, "B")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(root, "B"), "utf8")).toBe("new");
		expect(readFileSync(real, "utf8")).toBe("real");
		expect(existsSync(join(root, "A"))).toBe(false);
	});

	it("promotes child removals before replacing a directory with a file", async () => {
		const root = sandbox();
		mkdirSync(join(root, "D"));
		file(root, "D/C", "c");
		file(root, "F", "f");
		const batch = createBatch({ writeRoot: root });
		readText(batch, "D/C");
		remove(batch, "D/C");
		stat(batch, "D");
		remove(batch, "D");
		readText(batch, "F");
		move(batch, "F", "D");
		const plan = prepare(batch).plan;
		expect(plan.operations.map((step) => step.kind)).toEqual(["remove-file", "remove-dir", "move"]);
		const result = await commit({ batch, plan, writeGate: fakeGate(), ...fakePorts() });
		expect(result.status).toBe(":applied");
		expect(lstatSync(join(root, "D")).isFile()).toBe(true);
		expect(readFileSync(join(root, "D"), "utf8")).toBe("f");
		expect(existsSync(join(root, "D/C"))).toBe(false);
		expect(existsSync(join(root, "F"))).toBe(false);
	});

	it("replaces a directory after its child moved out", async () => {
		const root = sandbox();
		mkdirSync(join(root, "D"));
		file(root, "D/C", "c");
		file(root, "F", "f");
		const batch = createBatch({ writeRoot: root });
		readText(batch, "D/C");
		move(batch, "D/C", "X");
		stat(batch, "D");
		remove(batch, "D");
		readText(batch, "F");
		move(batch, "F", "D");
		expect((await committed(batch, prepare(batch).plan)).status).toBe(":applied");
		expect(readFileSync(join(root, "X"), "utf8")).toBe("c");
		expect(readFileSync(join(root, "D"), "utf8")).toBe("f");
		expect(existsSync(join(root, "D/C"))).toBe(false);
		expect(existsSync(join(root, "F"))).toBe(false);
	});

	it("removes a directory after its moved-out child", async () => {
		const root = sandbox();
		mkdirSync(join(root, "X"));
		file(root, "X/C", "c");
		const batch = createBatch({ writeRoot: root });
		readText(batch, "X/C");
		move(batch, "X/C", "T");
		stat(batch, "X");
		remove(batch, "X");
		const plan = prepare(batch).plan;
		expect(plan.operations.map((step) => step.kind)).toEqual(["move", "remove-dir"]);
		const result = await commit({ batch, plan, writeGate: fakeGate(), ...fakePorts() });
		expect(result.status).toBe(":applied");
		expect(readFileSync(join(root, "T"), "utf8")).toBe("c");
		expect(existsSync(join(root, "X"))).toBe(false);
	});

	it("unlinks a symlink before mkdir replaces it", async () => {
		const root = sandbox();
		const real = file(root, "real.txt", "r");
		symlinkSync(real, join(root, "link"));
		const batch = createBatch({ writeRoot: root });
		stat(batch, "link");
		remove(batch, "link");
		mkdir(batch, "link");
		write(batch, "link/x.txt", "x");
		const plan = prepare(batch).plan;
		expect(plan.operations.map((step) => step.kind)).toEqual(["remove-file", "mkdir", "write"]);
		const result = await commit({ batch, plan, writeGate: fakeGate(), ...fakePorts() });
		expect(result.status).toBe(":applied");
		expect(lstatSync(join(root, "link")).isDirectory()).toBe(true);
		expect(readFileSync(join(root, "link/x.txt"), "utf8")).toBe("x");
		expect(readFileSync(real, "utf8")).toBe("r");
	});

	it("accepts an acquire/release gate port", async () => {
		const root = sandbox();
		const batch = createBatch({ writeRoot: root });
		write(batch, "a.txt", "A");
		const events = [];
		const gate = {
			acquire() {
				events.push("acquire");
				return { ok: true, handle: { token: "t" } };
			},
			release(handle) {
				events.push(`release:${handle.token}`);
			},
		};
		const result = await commit({ batch, plan: prepare(batch).plan, writeGate: gate, ...fakePorts() });
		expect(result.status).toBe(":applied");
		expect(events).toEqual(["acquire", "release:t"]);
	});

	it("unwraps a withLock-style write gate receipt", async () => {
		const root = sandbox();
		const batch = createBatch({ writeRoot: root });
		write(batch, "a.txt", "A");
		const gate = {
			async runExclusive(fn) {
				return { ok: true, value: await fn(), released: true };
			},
		};
		const result = await commit({
			batch,
			plan: prepare(batch).plan,
			writeGate: gate,
			...fakePorts(),
		});
		expect(result.status).toBe(":applied");
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("A");
	});

	it("maps a busy write gate receipt to a rejected result", async () => {
		const root = sandbox();
		const batch = createBatch({ writeRoot: root });
		write(batch, "a.txt", "A");
		const gate = {
			async runExclusive() {
				return { ok: false, busy: true };
			},
		};
		const result = await commit({
			batch,
			plan: prepare(batch).plan,
			writeGate: gate,
			...fakePorts(),
		});
		expect(result.status).toBe(":rejected");
		expect(result.code).toBe(":BOARD_CONFLICT");
		expect(existsSync(join(root, "a.txt"))).toBe(false);
	});

	it("normalizes an unknown control code instead of throwing", async () => {
		const root = sandbox();
		const batch = createBatch({ writeRoot: root });
		write(batch, "a.txt", "A");
		const control = {
			markApplying() {
				return { ok: false, code: "EACCES", message: "raw system code" };
			},
		};
		const result = await commit({
			batch,
			plan: prepare(batch).plan,
			writeGate: fakeGate(),
			...fakePorts({ control: fakeControl(control) }),
		});
		expect(result.status).toBe(":rejected");
		expect(result.code).toBe(":BOARD_CONFLICT");
		expect(result.reportedCode).toBe("EACCES");
		expect(existsSync(join(root, "a.txt"))).toBe(false);
	});

	it("turns an identity verification error into a rejected result", async () => {
		const root = sandbox();
		const batch = createBatch({ writeRoot: root });
		write(batch, "a.txt", "A");
		const result = await commit({
			batch,
			plan: prepare(batch).plan,
			writeGate: fakeGate(),
			...fakePorts({
				identity: {
					verify() {
						throw new Error("board read failed");
					},
				},
			}),
		});
		expect(result.status).toBe(":rejected");
		expect(result.code).toBe(":BOARD_CONFLICT");
		expect(existsSync(join(root, "a.txt"))).toBe(false);
	});

	it("adopts the board action id created by markApplying", async () => {
		const root = sandbox();
		const batch = createBatch({ writeRoot: root });
		write(batch, "a.txt", "A");
		const published = [];
		const control = fakeControl({
			markApplying(payload) {
				expect(payload.actionId).toBeUndefined();
				return { ok: true, receipt: { actionId: "board-action" } };
			},
			publishResult(payload) {
				published.push(payload);
				return { ok: true };
			},
		});
		const result = await commit({
			batch,
			plan: prepare(batch).plan,
			writeGate: fakeGate(),
			...fakePorts({ control }),
		});
		expect(result.status).toBe(":applied");
		expect(result.actionId).toBe("board-action");
		expect(published[0].actionId).toBe("board-action");
	});

	it("ignores mutations of the returned plan", async () => {
		const root = sandbox();
		const outside = sandbox("herd-vfs-outside-");
		const batch = createBatch({ writeRoot: root });
		write(batch, "a.txt", "A");
		const plan = prepare(batch).plan;
		plan.operations.push({ kind: "write", path: join(outside, "evil.txt"), content: "E" });
		const result = await committed(batch, plan);
		expect(result.status).toBe(":applied");
		expect(result.written).toEqual([join(root, "a.txt")]);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("A");
		expect(existsSync(join(outside, "evil.txt"))).toBe(false);
	});
});

describe("protected paths", () => {
	it("refuses reading a symlink to a directory", () => {
		const root = sandbox();
		mkdirSync(join(root, "dir"));
		symlinkSync(join(root, "dir"), join(root, "dirlink"), "dir");
		const batch = createBatch({ writeRoot: root });
		expect(caught(() => readText(batch, "dirlink")).code).toBe(":STRUCTURE_CONFLICT");
	});

	it("lists moved symlinks as links and refuses them as directories", () => {
		const root = sandbox();
		const real = file(root, "real.txt", "target");
		symlinkSync(real, join(root, "link1"));
		symlinkSync(real, join(root, "link2"));
		const batch = createBatch({ writeRoot: root });
		move(batch, "link1", "alias");
		mkdir(batch, "out");
		move(batch, "link2", "out/link2");
		expect(caught(() => list(batch, "alias")).code).toBe(":STRUCTURE_CONFLICT");
		const entry = list(batch, "out").entries.find((item) => item.name === "link2");
		expect(entry.isSymlink).toBe(true);
		expect(entry.isDir).toBe(false);
		expect(entry.isFile).toBe(false);
	});
});

describe("mandatory production ports", () => {
	it("refuses a commit without control, identity, or claim", async () => {
		const root = sandbox();
		const batch = createBatch({ writeRoot: root });
		write(batch, "a.txt", "A");
		const plan = prepare(batch).plan;
		await expect(commit({ batch, plan, writeGate: fakeGate() })).rejects.toMatchObject({
			code: ":INVALID_ARGUMENT",
		});
		expect(existsSync(join(root, "a.txt"))).toBe(false);
	});

	it("refuses a drain or call without the production ports", async () => {
		const root = sandbox();
		const batch = createBatch({ writeRoot: root });
		write(batch, "a.txt", "A");
		await expect(drain(batch, { writeGate: fakeGate() })).rejects.toMatchObject({
			code: ":INVALID_ARGUMENT",
		});
		await expect(runCall({ batch, argv: ["true"], writeGate: fakeGate() })).rejects.toMatchObject({
			code: ":INVALID_ARGUMENT",
		});
		expect(existsSync(join(root, "a.txt"))).toBe(false);
	});

	it("verifies identity and claim even for an empty batch", async () => {
		const root = sandbox();
		const empty = createBatch({ writeRoot: root });
		const dead = await commit({
			batch: empty,
			plan: prepare(empty).plan,
			writeGate: fakeGate(),
			...fakePorts({ identity: { agent_id: "dead", status: "dead" } }),
		});
		expect(dead.status).toBe(":rejected");
		expect(dead.code).toBe(":ACTOR_DEAD");

		const second = createBatch({ writeRoot: root });
		const revoked = await drain(second, {
			writeGate: fakeGate(),
			...fakePorts({ claim: { claim_id: "revoked", status: "revoked" } }),
		});
		expect(revoked.status).toBe(":rejected");
		expect(revoked.code).toBe(":CLAIM_CHANGED");
	});
});

describe("drain and runCall", () => {
	it("drains pending writes before running and holds the gate", async () => {
		const root = sandbox();
		const events = [];
		const gate = fakeGate(events);
		const control = {
			markRunning(_payload) {
				events.push("control:running");
				return { ok: true };
			},
			publishResult(_payload) {
				events.push("control:result");
				return { ok: true };
			},
		};
		const io = {
			async runCommand(_command, options) {
				events.push("command");
				expect(options.cwd).toBe(root);
				expect(gate.held).toBe(true);
				expect(readFileSync(join(root, "pre.txt"), "utf8")).toBe("ready");
				return { stdout: "ok\n", stderr: "", exitCode: 0, signal: null, aborted: false, truncated: false };
			},
		};
		const owned = createBatch({ writeRoot: root, io });
		write(owned, "pre.txt", "ready");
		const result = await runCall({
			batch: owned,
			argv: ["true"],
			writeGate: gate,
			...fakePorts({ control: fakeControl(control) }),
			limits: { inlineBytes: 100, logBytes: 1000 },
		});
		expect(result.status).toBe(":completed");
		expect(result.stdout).toBe("ok\n");
		expect(result.written).toContain(join(root, "pre.txt"));
		expect(events).toEqual([
			"gate:acquire",
			"control:result",
			"gate:release",
			"gate:acquire",
			"control:running",
			"command",
			"control:result",
			"gate:release",
		]);
	});

	it("reports a nonzero exit as failed", async () => {
		const root = sandbox();
		const io = {
			async runCommand() {
				return { stdout: "bad\n", stderr: "err\n", exitCode: 2, signal: null, aborted: false, truncated: false };
			},
		};
		const owned = createBatch({ writeRoot: root, io });
		const result = await runCall({
			batch: owned,
			argv: ["false"],
			writeGate: fakeGate(),
			...fakePorts(),
		});
		expect(result.status).toBe(":failed");
		expect(result.exitCode).toBe(2);
	});

	it("cancels before drain without touching disk", async () => {
		const root = sandbox();
		const controller = new AbortController();
		controller.abort();
		let ran = false;
		const io = {
			async runCommand() {
				ran = true;
			},
		};
		const owned = createBatch({ writeRoot: root, io });
		write(owned, "a.txt", "A");
		const result = await runCall({
			batch: owned,
			argv: ["true"],
			writeGate: fakeGate(),
			signal: controller.signal,
			...fakePorts(),
		});
		expect(result.status).toBe(":cancelled");
		expect(ran).toBe(false);
		expect(existsSync(join(root, "a.txt"))).toBe(false);
	});

	it("marks an interrupted running command as outcome-unknown", async () => {
		const root = sandbox();
		const controller = new AbortController();
		const io = {
			runCommand(_command, { signal }) {
				return new Promise((resolvePromise) => {
					signal.addEventListener(
						"abort",
						() => {
							resolvePromise({
								stdout: "",
								stderr: "",
								exitCode: null,
								signal: "SIGTERM",
								aborted: true,
								truncated: false,
							});
						},
						{ once: true },
					);
				});
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		const uncertain = [];
		const control = {
			markRunning() {
				return { ok: true };
			},
			markUncertain(payload) {
				uncertain.push(payload);
				return { ok: true };
			},
		};
		const promise = runCall({
			batch,
			argv: ["sleep"],
			writeGate: fakeGate(),
			signal: controller.signal,
			...fakePorts({ control: fakeControl(control) }),
		});
		await Bun.sleep(5);
		controller.abort();
		const result = await promise;
		expect(result.status).toBe(":outcome-unknown");
		expect(uncertain).toHaveLength(1);
		expect(uncertain[0].status).toBe(":outcome-unknown");
	});

	it("reports drained writes when cancellation lands after the drain", async () => {
		const root = sandbox();
		const controller = new AbortController();
		let aborted = false;
		let ran = false;
		const io = {
			writeFileAtomic(dir, name, content) {
				if (!aborted) {
					aborted = true;
					controller.abort();
				}
				return atomicWrite(dir, name, content);
			},
			async runCommand() {
				ran = true;
				return { stdout: "", stderr: "", exitCode: 0, signal: null, aborted: false, truncated: false };
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		write(batch, "a.txt", "A");
		const result = await runCall({
			batch,
			argv: ["true"],
			writeGate: fakeGate(),
			signal: controller.signal,
			...fakePorts(),
		});
		expect(result.status).toBe(":cancelled");
		expect(result.written).toEqual([join(root, "a.txt")]);
		expect(result.drained.status).toBe(":applied");
		expect(ran).toBe(false);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("A");
	});

	it("bounds the call log even when the command port returns too much", async () => {
		const root = sandbox();
		const logPath = join(root, "cap.log");
		const io = {
			async runCommand() {
				return {
					stdout: "x".repeat(100),
					stderr: "",
					exitCode: 0,
					signal: null,
					aborted: false,
					truncated: false,
				};
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		const result = await runCall({
			batch,
			argv: ["verbose"],
			writeGate: fakeGate(),
			limits: { inlineBytes: 10, logBytes: 20, logPath },
			...fakePorts(),
		});
		expect(result.status).toBe(":completed");
		expect(result.truncated).toBe(true);
		expect(result.code).toBe(":OUTPUT_TRUNCATED");
		expect(result.stdout.length).toBe(10);
		expect(readFileSync(logPath, "utf8").length).toBe(20);
	});

	it("treats a throwing command port as outcome-unknown", async () => {
		const root = sandbox();
		const uncertain = [];
		const io = {
			async runCommand() {
				throw new Error("host command port failed");
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		const result = await runCall({
			batch,
			argv: ["true"],
			writeGate: fakeGate(),
			...fakePorts({
				control: fakeControl({
					markUncertain(payload) {
						uncertain.push(payload);
						return { ok: true };
					},
				}),
			}),
		});
		expect(result.status).toBe(":outcome-unknown");
		expect(result.error.message).toContain("host command port failed");
		expect(uncertain).toHaveLength(1);
		expect(result.recorded).toBe(true);
	});

	it("cancels between registration and command start", async () => {
		const root = sandbox();
		const controller = new AbortController();
		let ran = false;
		const io = {
			async runCommand() {
				ran = true;
				return { stdout: "", stderr: "", exitCode: 0, signal: null, aborted: false, truncated: false };
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		const control = fakeControl({
			markRunning() {
				controller.abort();
				return { ok: true };
			},
		});
		const result = await runCall({
			batch,
			argv: ["true"],
			writeGate: fakeGate(),
			control,
			signal: controller.signal,
			...fakePorts({ control }),
		});
		expect(result.status).toBe(":cancelled");
		expect(result.code).toBe(":STALE_CONTROL");
		expect(result.phase).toBe(":before-call");
		expect(result.recorded).toBe(true);
		expect(ran).toBe(false);
	});

	it("adopts the board action id created by markRunning", async () => {
		const root = sandbox();
		const io = {
			async runCommand() {
				return { stdout: "", stderr: "", exitCode: 0, signal: null, aborted: false, truncated: false };
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		const published = [];
		const control = fakeControl({
			markRunning() {
				return { ok: true, receipt: { actionId: "run-action" } };
			},
			publishResult(payload) {
				published.push(payload);
				return { ok: true };
			},
		});
		const result = await runCall({
			batch,
			argv: ["true"],
			writeGate: fakeGate(),
			...fakePorts({ control }),
		});
		expect(result.status).toBe(":completed");
		expect(result.actionId).toBe("run-action");
		expect(published[0].actionId).toBe("run-action");
	});

	it("uses a caller-supplied call action id", async () => {
		const root = sandbox();
		let markingPayload = null;
		const io = {
			async runCommand() {
				return { stdout: "", stderr: "", exitCode: 0, signal: null, aborted: false, truncated: false };
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		const control = fakeControl({
			markRunning(payload) {
				markingPayload = payload;
				return { ok: true, receipt: { actionId: "ignored-action" } };
			},
		});
		const result = await runCall({
			batch,
			argv: ["true"],
			writeGate: fakeGate(),
			limits: { actionId: "chosen-action" },
			...fakePorts({ control }),
		});
		expect(markingPayload.actionId).toBe("chosen-action");
		expect(result.actionId).toBe("chosen-action");
	});

	it("keeps the call open until managed background children end", async () => {
		const root = sandbox();
		const started = Date.now();
		const batch = createBatch({ writeRoot: root });
		const result = await runCall({
			batch,
			argv: ["sh", "-c", "(sleep 0.15; printf late > child.txt) & printf parent"],
			writeGate: fakeGate(),
			limits: { inlineBytes: 100, logBytes: 1000 },
			...fakePorts(),
		});
		expect(result.status).toBe(":completed");
		expect(result.stdout).toBe("parent");
		expect(result.managedChildren).toBe(true);
		expect(result.externalBestEffort).toBe(true);
		expect(Date.now() - started).toBeGreaterThanOrEqual(100);
		expect(readFileSync(join(root, "child.txt"), "utf8")).toBe("late");
	});

	it("marks detached call activity as external best-effort", async () => {
		const root = sandbox();
		const io = {
			async runCommand() {
				return {
					stdout: "",
					stderr: "",
					exitCode: 0,
					signal: null,
					aborted: false,
					truncated: false,
					managedChildren: false,
					stdioClosed: false,
					externalBestEffort: true,
				};
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		const result = await runCall({ batch, argv: ["true"], writeGate: fakeGate(), ...fakePorts() });
		expect(result.status).toBe(":completed");
		expect(result.managedChildren).toBe(false);
		expect(result.stdioClosed).toBe(false);
		expect(result.externalBestEffort).toBe(true);
	});

	it("does not split UTF-8 at the default log cap", async () => {
		const root = sandbox();
		const logPath = join(root, "utf8.log");
		const batch = createBatch({ writeRoot: root });
		const result = await runCall({
			batch,
			argv: ["printf", "AAAAAAA😀"],
			writeGate: fakeGate(),
			limits: { inlineBytes: 100, logBytes: 10, logPath },
			...fakePorts(),
		});
		expect(result.status).toBe(":completed");
		expect(result.stdout).toBe("AAAAAAA");
		expect(result.stdout).not.toContain("\uFFFD");
		expect(result.truncated).toBe(true);
		expect(result.inlineTruncated).toBe(true);
		expect(result.logTruncated).toBe(true);
		expect(readFileSync(logPath, "utf8")).toBe("AAAAAAA");
	});

	it("uses the injected log writer and clears logPath on failure", async () => {
		const root = sandbox();
		const logPath = join(root, "port.log");
		const io = {
			writeFileAtomic() {
				throw new Error("PORT-SENTINEL-WRITE");
			},
			async runCommand() {
				return { stdout: "ok", stderr: "", exitCode: 0, signal: null, aborted: false, truncated: false };
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		const result = await runCall({
			batch,
			argv: ["true"],
			writeGate: fakeGate(),
			limits: { logPath },
			...fakePorts(),
		});
		expect(result.status).toBe(":completed");
		expect(result.logPath).toBeNull();
		expect(result.logError).toContain("PORT-SENTINEL-WRITE");
	});

	it("cancels a drain before applying when the signal aborts during verification", async () => {
		const root = sandbox();
		const controller = new AbortController();
		const control = fakeControl({
			verifyClaim() {
				controller.abort();
				return { ok: true };
			},
		});
		const batch = createBatch({ writeRoot: root });
		write(batch, "a.txt", "A");
		const result = await runCall({
			batch,
			argv: ["true"],
			writeGate: fakeGate(),
			control,
			signal: controller.signal,
			...fakePorts({ control }),
		});
		expect(result.status).toBe(":cancelled");
		expect(result.phase).toBe(":drain");
		expect(existsSync(join(root, "a.txt"))).toBe(false);
	});

	it("truncates inline output and writes the complete log", async () => {
		const root = sandbox();
		const logPath = join(root, "call.log");
		const payload = "x".repeat(200);
		const io = {
			async runCommand() {
				return { stdout: payload, stderr: "", exitCode: 0, signal: null, aborted: false, truncated: false };
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		const result = await runCall({
			batch,
			argv: ["verbose"],
			writeGate: fakeGate(),
			limits: { inlineBytes: 10, logBytes: 1000, logPath },
			...fakePorts(),
		});
		expect(result.status).toBe(":completed");
		expect(result.truncated).toBe(true);
		expect(result.code).toBe(":OUTPUT_TRUNCATED");
		expect(result.stdout.length).toBe(10);
		expect(readFileSync(logPath, "utf8")).toBe(payload);
	});

	it("writes a call log under an explicit log root", async () => {
		const root = sandbox();
		const artifacts = sandbox("herd-vfs-artifacts-");
		const logPath = join(artifacts, "call.log");
		const io = {
			async runCommand() {
				return { stdout: "out", stderr: "", exitCode: 0, signal: null, aborted: false, truncated: false };
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		const result = await runCall({
			batch,
			argv: ["true"],
			writeGate: fakeGate(),
			limits: { inlineBytes: 10, logBytes: 100, logPath, logRoot: artifacts },
			...fakePorts(),
		});
		expect(result.status).toBe(":completed");
		expect(result.logPath).toBe(logPath);
		expect(readFileSync(logPath, "utf8")).toBe("out");
	});

	it("allows a call log under .herd/artifacts without an explicit log root", async () => {
		const root = sandbox();
		const control = sandbox("herd-vfs-control-");
		const artifacts = join(control, ".herd", "artifacts");
		mkdirSync(artifacts, { recursive: true });
		const logPath = join(artifacts, "call.log");
		const io = {
			async runCommand() {
				return { stdout: "logged", stderr: "", exitCode: 0, signal: null, aborted: false, truncated: false };
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		const result = await runCall({
			batch,
			argv: ["true"],
			writeGate: fakeGate(),
			limits: { logPath, inlineBytes: 10, logBytes: 100 },
			...fakePorts(),
		});
		expect(result.status).toBe(":completed");
		expect(readFileSync(logPath, "utf8")).toBe("logged");
	});

	it("uses a directory created in the same batch as cwd", async () => {
		const root = sandbox();
		const io = {
			async runCommand(_command, { cwd }) {
				expect(cwd).toBe(join(root, "out"));
				expect(lstatSync(cwd).isDirectory()).toBe(true);
				return { stdout: "", stderr: "", exitCode: 0, signal: null, aborted: false, truncated: false };
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		mkdir(batch, "out");
		const result = await runCall({
			batch,
			argv: ["true"],
			cwd: "out",
			writeGate: fakeGate(),
			...fakePorts(),
		});
		expect(result.status).toBe(":completed");
		expect(lstatSync(join(root, "out")).isDirectory()).toBe(true);
	});

	it("drains a directory move before running in the moved cwd", async () => {
		const root = sandbox();
		mkdirSync(join(root, "D"));
		file(root, "D/a.txt", "A");
		const io = {
			async runCommand(_command, { cwd }) {
				expect(cwd).toBe(join(root, "E"));
				expect(lstatSync(cwd).isDirectory()).toBe(true);
				expect(existsSync(join(root, "D"))).toBe(false);
				return { stdout: "", stderr: "", exitCode: 0, signal: null, aborted: false, truncated: false };
			},
		};
		const batch = createBatch({ writeRoot: root, io });
		move(batch, "D", "E");
		const result = await runCall({
			batch,
			argv: ["true"],
			cwd: "E",
			writeGate: fakeGate(),
			...fakePorts(),
		});
		expect(result.status).toBe(":completed");
		expect(readFileSync(join(root, "E/a.txt"), "utf8")).toBe("A");
	});
});
