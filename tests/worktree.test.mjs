import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EdnKeyword, readUfss } from "../src/clj-sandbox/ufss.mjs";
import { openBoard, readBoard } from "../src/swarm/board.mjs";
import {
	abandonSlice as abandonSliceRaw,
	enqueueSlice as enqueueSliceRaw,
	forkSlices as forkSlicesRaw,
	gcWorktrees,
	joinSlice as joinSliceRaw,
	readWorktreeState,
	worktreePaths,
} from "../src/swarm/worktree.mjs";
import { isHerdError } from "../src/util/errors.mjs";

const roots = [];
const DAY = 24 * 60 * 60 * 1000;

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), "herd-worktree-"));
	roots.push(root);
	return root;
}

function git(cwd, args, options = {}) {
	const result = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Herd Test",
			GIT_AUTHOR_EMAIL: "herd@example.test",
			GIT_COMMITTER_NAME: "Herd Test",
			GIT_COMMITTER_EMAIL: "herd@example.test",
		},
	});
	if (!options.allowFail && result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	}
	return result;
}

function realGitPort({ failAddFor = null } = {}) {
	return {
		run({ cwd, args }) {
			if (args[0] === "worktree" && args[1] === "add" && failAddFor) {
				const branch = args[3];
				const shouldFail = typeof failAddFor === "function" ? failAddFor(branch) : branch.includes(failAddFor);
				if (shouldFail) {
					return {
						ok: false,
						status: 128,
						stdout: "",
						stderr: "fatal: not a git repository (or any parent)",
						args,
						cwd,
					};
				}
			}
			const result = spawnSync("git", ["-C", cwd, ...args], {
				encoding: "utf8",
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "Herd Test",
					GIT_AUTHOR_EMAIL: "herd@example.test",
					GIT_COMMITTER_NAME: "Herd Test",
					GIT_COMMITTER_EMAIL: "herd@example.test",
				},
			});
			return {
				ok: result.status === 0,
				status: result.status,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				args,
				cwd,
			};
		},
	};
}

function initRepo() {
	const root = sandbox();
	git(root, ["init", "-q", "-b", "main"]);
	writeFileSync(join(root, "base.txt"), "base\n", "utf8");
	git(root, ["add", "base.txt"]);
	git(root, ["commit", "-q", "-m", "base"]);
	return root;
}

function commitFile(root, relativePath, content, message) {
	mkdirSync(dirname(join(root, relativePath)), { recursive: true });
	writeFileSync(join(root, relativePath), content, "utf8");
	git(root, ["add", relativePath]);
	git(root, ["commit", "-q", "-m", message]);
	return git(root, ["rev-parse", "HEAD"]).stdout.trim();
}

function fakeBoard({ holder = true, failStatus = false } = {}) {
	const calls = { ensure: [], status: [], assert: [] };
	const port = {
		calls,
		failStatus,
		ensureSlice(info) {
			calls.ensure.push(info);
			mkdirSync(dirname(info.paths.boardPath), { recursive: true });
			writeFileSync(info.paths.boardPath, "{:board-version 0}\n", "utf8");
		},
		updateStatus(info) {
			calls.status.push(info);
			if (port.failStatus) throw new Error("board status write failed");
		},
		assertHolder(info) {
			calls.assert.push(info);
			return holder && info.actor?.role === "holder";
		},
	};
	return port;
}

const defaultBoard = fakeBoard();

function withBoard(deps = {}) {
	return { ...deps, board: deps.board ?? defaultBoard };
}

function forkSlices(args) {
	return forkSlicesRaw({ ...args, deps: withBoard(args.deps) });
}

function joinSlice(args) {
	return joinSliceRaw({ ...args, deps: withBoard(args.deps) });
}

function enqueueSlice(args) {
	return enqueueSliceRaw({ ...args, deps: withBoard(args.deps) });
}

function abandonSlice(args) {
	return abandonSliceRaw({ ...args, deps: withBoard(args.deps) });
}

function slices(...ids) {
	return ids.map((sliceId) => ({
		slice_id: sliceId,
		depends_on: [],
		status: "pending",
		goal: `goal ${sliceId}`,
		done_when: "observable",
		mapped_cases: [],
	}));
}

function stateOf(root, slug = "mission") {
	const path = join(root, ".herd", "missions", slug, "worktrees.edn");
	const value = readUfss(readFileSync(path, "utf8"));
	const state = {};
	for (const [key, entry] of value) {
		const name = key instanceof EdnKeyword ? key.name : String(key);
		if (name === "slices") {
			state.slices = {};
			for (const [sliceKey, slice] of entry) {
				state.slices[String(sliceKey)] = ednToJs(slice);
			}
		} else {
			state[name.replaceAll("-", "_")] = ednToJs(entry);
		}
	}
	return state;
}

function ednToJs(value) {
	if (value instanceof Map) {
		const object = {};
		for (const [key, entry] of value) {
			const name = key instanceof EdnKeyword ? key.name : String(key);
			object[name.replaceAll("-", "_")] = ednToJs(entry);
		}
		return object;
	}
	if (Array.isArray(value)) return value.map(ednToJs);
	if (value instanceof EdnKeyword) return value.name;
	return value;
}

function eventsOf(root, slug = "mission") {
	const path = join(root, ".herd", "missions", slug, "events.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function allSliceEvents(root, slug = "mission") {
	const slicesDir = join(root, ".herd", "missions", slug, "slices");
	if (!existsSync(slicesDir)) return [];
	return readdirSync(slicesDir).flatMap((sliceId) => {
		const path = join(slicesDir, sliceId, "events.jsonl");
		if (!existsSync(path)) return [];
		return readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	});
}

afterEach(() => {
	while (roots.length > 0) {
		rmSync(roots.pop(), { recursive: true, force: true });
	}
});

describe("worktree paths", () => {
	it("returns absolute data-plane paths and keeps control files outside the worktree", () => {
		const root = initRepo();
		const paths = worktreePaths("relative-root", "mission", "slice-a");
		const absolute = worktreePaths(root, "mission", "slice-a");

		expect(paths.workspace.startsWith("/")).toBe(true);
		expect(absolute.workspace).toBe(join(root, ".herd-worktrees", "mission", "slice-a"));
		expect(absolute.branch).toBe("herd/mission/slice-a");
		expect(absolute.boardPath.startsWith(absolute.workspace)).toBe(false);
		expect(absolute.boardPath).toBe(join(root, ".herd", "missions", "mission", "slices", "slice-a", "board.edn"));
		expect(absolute.lockPaths.integration).toBe(join(root, ".herd", "locks", "master-integration.lock"));
		expect(absolute.lockPaths.writeW).toBe(join(root, ".herd", "locks", "slice-a.write-w.lock"));
	});
});

describe("forkSlices", () => {
	it("forks only causal-ready Slices and returns isolated handles", async () => {
		const root = initRepo();
		const board = fakeBoard();
		const runnerCalls = [];
		const specs = [
			...slices("slice-a", "slice-c"),
			{
				slice_id: "slice-b",
				depends_on: ["slice-a"],
				status: "pending",
				goal: "depends on a",
				done_when: "a joined",
				mapped_cases: [],
			},
		];

		const handles = await forkSlices({
			root,
			slug: "mission",
			slices: specs,
			base: "main",
			deps: {
				board,
				runner: {
					retireSlice() {
						runnerCalls.push("retire");
					},
				},
			},
		});

		expect(handles.map((handle) => handle.slice_id)).toEqual(["slice-a", "slice-c"]);
		for (const handle of handles) {
			expect(existsSync(handle.workspace)).toBe(true);
			expect(git(handle.workspace, ["rev-parse", "--show-toplevel"]).stdout.trim()).toBe(handle.workspace);
			expect(git(handle.workspace, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()).toBe(handle.branch);
			expect(handle.base_commit).toBe(git(root, ["rev-parse", "main"]).stdout.trim());
			expect(handle.board_path.startsWith(handle.workspace)).toBe(false);
		}
		expect(board.calls.ensure.map((call) => call.sliceId)).toEqual(["slice-a", "slice-c"]);
		expect(runnerCalls).toEqual([]);
		expect(git(root, ["worktree", "list", "--porcelain"]).stdout).toContain(
			join(root, ".herd-worktrees", "mission", "slice-a"),
		);
		const state = stateOf(root);
		expect(state.slices["slice-a"].status).toBe("running");
		expect(state.slices["slice-b"].status).toBe("pending");
		expect(state.slices["slice-b"].workspace).toBeUndefined();
		const rawState = readFileSync(join(root, ".herd", "missions", "mission", "worktrees.edn"), "utf8");
		expect(rawState).toContain(":next-seq");
		expect(rawState).toContain(":slice-id");
		expect(rawState).not.toContain("next_seq");
		expect(allSliceEvents(root).filter((event) => event.event === "slice-forked")).toHaveLength(2);
	});

	it("preserves uppercase and underscore Slice ids in every exact reference", async () => {
		const root = initRepo();
		const sliceId = "SLICE-01_A";
		const [handle] = await forkSlices({
			root,
			slug: "mission",
			slices: slices(sliceId),
			base: "main",
		});
		expect(handle.slice_id).toBe(sliceId);
		expect(handle.workspace).toBe(join(root, ".herd-worktrees", "mission", sliceId));
		expect(handle.branch).toBe(`herd/mission/${sliceId}`);
		expect(handle.lock_paths.writeW).toBe(join(root, ".herd", "locks", `${sliceId}.write-w.lock`));
		expect(handle.board_path).toBe(join(root, ".herd", "missions", "mission", "slices", sliceId, "board.edn"));
		expect(git(handle.workspace, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()).toBe(handle.branch);
		const state = readWorktreeState({ root, slug: "mission" });
		expect(Object.keys(state.slices)).toEqual([sliceId]);
		expect(state.slices[sliceId].workspace).toBe(handle.workspace);

		commitFile(handle.workspace, "upper.txt", "upper\n", "upper case work");
		await enqueueSlice({
			root,
			slug: "mission",
			sliceId,
			report: "uppercase report",
		});
		const joined = await joinSlice({ root, slug: "mission" });
		expect(joined.slice_id).toBe(sliceId);
		expect(joined.workspace).toBe(handle.workspace);
	});

	it("rejects unsafe or overlong Slice ids before creating a worktree", async () => {
		const root = initRepo();
		for (const bad of ["_leading", "-leading", "bad/thing", "bad thing", "bad.dot", "a".repeat(65)]) {
			let caught;
			try {
				await forkSlices({
					root,
					slug: "mission",
					slices: slices(bad),
					base: "main",
				});
			} catch (error) {
				caught = error;
			}
			expect(isHerdError(caught)).toBe(true);
			expect(caught.code).toBe(":INVALID_ARGUMENT");
			expect(existsSync(join(root, ".herd-worktrees", "mission", bad))).toBe(false);
		}
	});

	it("keeps the full DAG when the first fork fails before any worktree exists", async () => {
		const root = initRepo();
		const specs = [
			...slices("slice-01", "slice-02", "slice-03"),
			{
				slice_id: "slice-04",
				depends_on: ["slice-01", "slice-02", "slice-03"],
				status: "pending",
				goal: "integration",
				done_when: "all joined",
				mapped_cases: [],
			},
		];
		let caught;
		try {
			await forkSlicesRaw({
				root,
				slug: "mission",
				slices: specs,
				base: "main",
				deps: {
					board: defaultBoard,
					git: realGitPort({ failAddFor: "slice-01" }),
				},
			});
		} catch (error) {
			caught = error;
		}
		expect(isHerdError(caught)).toBe(true);
		expect(caught.code).toBe(":FF_NOT_READY");
		expect(caught.data.slice_id).toBe("slice-01");
		expect(caught.data.created).toEqual([]);
		expect(caught.data.recoverable).toBe(true);

		const failedState = readWorktreeState({ root, slug: "mission" });
		expect(Object.keys(failedState.slices).sort()).toEqual(["slice-01", "slice-02", "slice-03", "slice-04"]);
		expect(failedState.slices["slice-01"].status).toBe("pending");
		expect(failedState.slices["slice-01"].last_fork_error.code).toBe(":FF_NOT_READY");
		expect(failedState.slices["slice-04"].status).toBe("pending");
		expect(existsSync(join(root, ".herd-worktrees", "mission", "slice-01"))).toBe(false);

		const retried = await forkSlices({ root, slug: "mission", slices: specs, base: "main" });
		expect(retried.map((handle) => handle.slice_id)).toEqual(["slice-01", "slice-02", "slice-03"]);
		expect(readWorktreeState({ root, slug: "mission" }).slices["slice-04"].status).toBe("pending");
	});

	it("preserves the full topology when the root has no .git", async () => {
		const root = sandbox();
		const specs = [
			...slices("slice-01", "slice-02", "slice-03"),
			{
				slice_id: "slice-04",
				depends_on: ["slice-01", "slice-02", "slice-03"],
				status: "pending",
				goal: "integration",
				done_when: "all joined",
				mapped_cases: [],
			},
		];
		let caught;
		try {
			await forkSlicesRaw({
				root,
				slug: "mission",
				slices: specs,
				base: "main",
				deps: { board: defaultBoard },
			});
		} catch (error) {
			caught = error;
		}
		expect(isHerdError(caught)).toBe(true);
		expect(caught.code).toBe(":FF_NOT_READY");
		expect(caught.data.slice_id).toBe("slice-01");
		expect(caught.data.recoverable).toBe(true);
		const state = readWorktreeState({ root, slug: "mission" });
		expect(Object.keys(state.slices).sort()).toEqual(["slice-01", "slice-02", "slice-03", "slice-04"]);
		expect(Object.values(state.slices).every((slice) => slice.status === "pending")).toBe(true);
		expect(state.slices["slice-01"].last_fork_error.code).toBe(":FF_NOT_READY");
		expect(state.slices["slice-04"].depends_on).toEqual(["slice-01", "slice-02", "slice-03"]);
	});

	it("keeps successful forks and the failed Slice recoverable when a later Slice fails", async () => {
		const root = initRepo();
		const specs = [
			...slices("slice-01", "slice-02", "slice-03"),
			{
				slice_id: "slice-04",
				depends_on: ["slice-01", "slice-02", "slice-03"],
				status: "pending",
				goal: "integration",
				done_when: "all joined",
				mapped_cases: [],
			},
		];
		let caught;
		try {
			await forkSlicesRaw({
				root,
				slug: "mission",
				slices: specs,
				base: "main",
				deps: {
					board: defaultBoard,
					git: realGitPort({ failAddFor: "slice-02" }),
				},
			});
		} catch (error) {
			caught = error;
		}
		expect(caught.code).toBe(":FF_NOT_READY");
		expect(caught.data.created).toEqual(["slice-01"]);
		const failedState = readWorktreeState({ root, slug: "mission" });
		expect(failedState.slices["slice-01"].status).toBe("running");
		expect(failedState.slices["slice-02"].status).toBe("pending");
		expect(failedState.slices["slice-03"].status).toBe("pending");
		expect(failedState.slices["slice-04"].status).toBe("pending");
		expect(existsSync(join(root, ".herd-worktrees", "mission", "slice-01"))).toBe(true);
		expect(existsSync(join(root, ".herd-worktrees", "mission", "slice-02"))).toBe(false);

		const retried = await forkSlices({ root, slug: "mission", slices: specs, base: "main" });
		expect(retried.map((handle) => handle.slice_id)).toEqual(["slice-02", "slice-03"]);
		expect(readWorktreeState({ root, slug: "mission" }).slices["slice-01"].status).toBe("running");
	});

	it("keeps the full DAG after a resource-capacity refusal", async () => {
		const root = initRepo();
		const specs = [
			...slices("slice-01", "slice-02", "slice-03"),
			{
				slice_id: "slice-04",
				depends_on: ["slice-01", "slice-02", "slice-03"],
				status: "pending",
				goal: "integration",
				done_when: "all joined",
				mapped_cases: [],
			},
		];
		let caught;
		try {
			await forkSlicesRaw({
				root,
				slug: "mission",
				slices: specs,
				base: "main",
				deps: {
					board: defaultBoard,
					capacity: () => ({ ok: false, available: 1 }),
				},
			});
		} catch (error) {
			caught = error;
		}
		expect(caught.code).toBe(":INSUFFICIENT_WORKTREES");
		expect(caught.data.recoverable).toBe(true);
		const state = readWorktreeState({ root, slug: "mission" });
		expect(Object.keys(state.slices).sort()).toEqual(["slice-01", "slice-02", "slice-03", "slice-04"]);
		expect(Object.values(state.slices).every((slice) => slice.status === "pending")).toBe(true);
		expect(state.queue).toEqual([]);
	});

	it("never reuses a worktree for a running or existing Slice", async () => {
		const root = initRepo();
		const specs = slices("slice-a");

		const first = await forkSlices({ root, slug: "mission", slices: specs, base: "main" });
		expect(first).toHaveLength(1);

		const second = await forkSlices({ root, slug: "mission", slices: specs, base: "main" });
		expect(second).toEqual([]);
		expect(stateOf(root).slices["slice-a"].status).toBe("running");
	});

	it("returns INSUFFICIENT_WORKTREES without silently reducing the request", async () => {
		const root = initRepo();
		let caught;
		try {
			await forkSlices({
				root,
				slug: "mission",
				slices: slices("slice-a", "slice-b"),
				base: "main",
				deps: {
					capacity: () => ({ ok: false, available: 1 }),
				},
			});
		} catch (error) {
			caught = error;
		}
		expect(isHerdError(caught)).toBe(true);
		expect(caught.code).toBe(":INSUFFICIENT_WORKTREES");
		expect(caught.data.requested).toBe(2);
		expect(caught.data.suggested).toBe(1);
		expect(existsSync(join(root, ".herd-worktrees", "mission", "slice-a"))).toBe(false);
	});

	it("seeds the Slice board with a free token slot and keeps .herd out of the worktree", async () => {
		const root = initRepo();
		const boardHandle = openBoard(root, "mission", "slice-a");
		const [handle] = await forkSlicesRaw({
			root,
			slug: "mission",
			slices: slices("slice-a"),
			base: "main",
			deps: { board: boardHandle },
		});
		const board = readFileSync(handle.board_path, "utf8");
		expect(board).toContain(":token-slot");
		expect(board).toContain(":state :free");
		expect(board).toContain(":holder-id nil");
		expect(existsSync(join(handle.workspace, ".herd"))).toBe(false);
		expect(stateOf(root).slices["slice-a"].swarm_id).toStartWith("swarm-");
	});

	it("releases a dependent Slice only after its dependency joins", async () => {
		const root = initRepo();
		const specs = [
			...slices("slice-a"),
			{
				slice_id: "slice-b",
				depends_on: ["slice-a"],
				status: "pending",
				goal: "depends on a",
				done_when: "a joined",
				mapped_cases: [],
			},
		];
		const first = await forkSlices({ root, slug: "mission", slices: specs, base: "main" });
		expect(first.map((handle) => handle.slice_id)).toEqual(["slice-a"]);
		commitFile(first[0].workspace, "a.txt", "a\n", "a");
		await enqueueSlice({
			root,
			slug: "mission",
			sliceId: "slice-a",
			report: "A done",
		});
		await joinSlice({ root, slug: "mission" });

		const second = await forkSlices({ root, slug: "mission", slices: specs, base: "main" });
		expect(second.map((handle) => handle.slice_id)).toEqual(["slice-b"]);
		expect(second[0].base_commit).toBe(git(root, ["rev-parse", "main"]).stdout.trim());
	});
});

describe("FIFO join", () => {
	it("joins by completion order, fast-forwards, and returns the full report", async () => {
		const root = initRepo();
		const board = fakeBoard();
		await forkSlices({
			root,
			slug: "mission",
			slices: slices("slice-a", "slice-b"),
			base: "main",
			deps: { board },
		});
		const paths = {
			a: worktreePaths(root, "mission", "slice-a"),
			b: worktreePaths(root, "mission", "slice-b"),
		};
		commitFile(paths.a.workspace, "a.txt", "a\n", "slice a");
		const commitB = commitFile(paths.b.workspace, "b.txt", "b\n", "slice b");
		const reportA = "# Slice A report\n".repeat(30);
		const reportB = "complete report for B";

		const queuedB = await enqueueSlice({
			root,
			slug: "mission",
			sliceId: "slice-b",
			report: reportB,
			deps: { board },
		});
		const queuedA = await enqueueSlice({
			root,
			slug: "mission",
			sliceId: "slice-a",
			report: reportA,
			deps: { board },
		});
		expect([queuedB.position, queuedA.position]).toEqual([1, 2]);

		const first = await joinSlice({ root, slug: "mission", deps: { board } });
		expect(first.slice_id).toBe("slice-b");
		expect(first.report).toBe(reportB);
		expect(first.ff_commit).toBe(commitB);
		expect(first.rebase_rounds).toBe(0);
		expect(git(root, ["rev-parse", "HEAD"]).stdout.trim()).toBe(commitB);

		const second = await joinSlice({ root, slug: "mission", deps: { board } });
		expect(second.slice_id).toBe("slice-a");
		expect(second.report).toBe(reportA);
		expect(second.ff_commit).toBe(git(root, ["rev-parse", "herd/mission/slice-a"]).stdout.trim());
		expect(second.rebase_rounds).toBeGreaterThanOrEqual(1);
		expect(git(root, ["show", "HEAD:a.txt"]).stdout).toBe("a\n");
		expect(stateOf(root).queue).toEqual([]);
		expect(stateOf(root).slices["slice-a"].status).toBe("joined");
		expect(stateOf(root).slices["slice-b"].status).toBe("joined");

		const third = await joinSlice({ root, slug: "mission", deps: { board } });
		expect(third).toEqual({ slice_id: null, status: "none" });
	});

	it("keeps a durable openBoard handle in sync through fork and join", async () => {
		const root = initRepo();
		const handle = openBoard(root, "mission", "slice-a");
		const [slice] = await forkSlicesRaw({
			root,
			slug: "mission",
			slices: slices("slice-a"),
			base: "main",
			deps: { board: handle },
		});
		const commit = commitFile(slice.workspace, "durable.txt", "durable\n", "durable work");
		await enqueueSliceRaw({
			root,
			slug: "mission",
			sliceId: "slice-a",
			report: "durable report",
			deps: { board: handle },
		});
		const joined = await joinSliceRaw({
			root,
			slug: "mission",
			deps: { board: handle },
		});
		expect(joined.ff_commit).toBe(commit);
		const board = await readBoard(handle);
		expect(board.slice.status).toBe("joined");
		expect(board.slice["ff-commit"]).toBe(commit);
		expect(stateOf(root).slices["slice-a"].status).toBe("joined");
	});

	it("rebases onto an advanced base and still fast-forwards only", async () => {
		const root = initRepo();
		await forkSlices({ root, slug: "mission", slices: slices("slice-a"), base: "main" });
		const paths = worktreePaths(root, "mission", "slice-a");
		commitFile(paths.workspace, "slice.txt", "slice\n", "slice work");
		const advanced = commitFile(root, "base-advanced.txt", "advanced\n", "advance main");

		await enqueueSlice({
			root,
			slug: "mission",
			sliceId: "slice-a",
			report: "rebase report",
		});
		const joined = await joinSlice({ root, slug: "mission" });

		expect(joined.rebase_rounds).toBeGreaterThanOrEqual(1);
		expect(git(root, ["rev-parse", "HEAD"]).stdout.trim()).toBe(joined.ff_commit);
		expect(git(root, ["show", "HEAD:base-advanced.txt"]).stdout).toBe("advanced\n");
		expect(git(root, ["show", "HEAD:slice.txt"]).stdout).toBe("slice\n");
		const parents = git(root, ["rev-list", "--parents", "-n", "1", "HEAD"]).stdout.trim().split(/\s+/);
		expect(parents).toHaveLength(2);
		expect(git(root, ["merge-base", advanced, "HEAD"]).stdout.trim()).toBe(advanced);
	});

	it("blocks while the queue is empty and a Slice is active", async () => {
		const root = initRepo();
		await forkSlices({ root, slug: "mission", slices: slices("slice-a"), base: "main" });
		const paths = worktreePaths(root, "mission", "slice-a");
		const commit = commitFile(paths.workspace, "wait.txt", "wait\n", "slice wait");

		const pending = joinSlice({ root, slug: "mission", deps: { pollMs: 10 } });
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
		await enqueueSlice({
			root,
			slug: "mission",
			sliceId: "slice-a",
			report: "released by the queue",
		});
		const result = await pending;
		expect(result.slice_id).toBe("slice-a");
		expect(result.ff_commit).toBe(commit);
	});

	it("fails closed instead of using an empty board port", async () => {
		const root = initRepo();
		let caught;
		try {
			await forkSlicesRaw({
				root,
				slug: "mission",
				slices: slices("slice-a"),
				base: "main",
			});
		} catch (error) {
			caught = error;
		}
		expect(isHerdError(caught)).toBe(true);
		expect(caught.code).toBe(":HOST_API_MISMATCH");
		expect(existsSync(join(root, ".herd-worktrees", "mission", "slice-a"))).toBe(false);
	});

	it("does not silently drop a failed board status write", async () => {
		const root = initRepo();
		const board = fakeBoard();
		await forkSlices({
			root,
			slug: "mission",
			slices: slices("slice-a"),
			base: "main",
			deps: { board },
		});
		board.failStatus = true;

		let caught;
		try {
			await enqueueSlice({
				root,
				slug: "mission",
				sliceId: "slice-a",
				report: "ready",
				deps: { board },
			});
		} catch (error) {
			caught = error;
		}
		expect(caught?.message).toBe("board status write failed");
		expect(stateOf(root).queue).toEqual([]);
		expect(stateOf(root).slices["slice-a"].status).toBe("running");
	});

	it("exposes normalized read-only state without a second state file", async () => {
		const root = initRepo();
		await forkSlices({
			root,
			slug: "mission",
			slices: slices("slice-a"),
			base: "main",
		});
		await enqueueSlice({
			root,
			slug: "mission",
			sliceId: "slice-a",
			report: "read-only report",
		});
		const state = readWorktreeState({ root, slug: "mission" });
		expect(state.exists).toBe(true);
		expect(state.path.endsWith("worktrees.edn")).toBe(true);
		expect(state.queue).toHaveLength(1);
		expect(state.queue[0].slice_id).toBe("slice-a");
		expect(state.queue[0].position).toBe(1);
		expect(state.queue[0].report).toBe("read-only report");
		expect(state.slices["slice-a"].status).toBe("queued");
		expect(existsSync(join(root, ".herd", "missions", "mission", "worktrees.json"))).toBe(false);
	});

	it("seeds a durable openBoard handle and records lifecycle status in its store", async () => {
		const root = initRepo();
		const handle = openBoard(root, "mission", "slice-a");
		expect(await handle.store.read()).toBeNull();

		await forkSlicesRaw({
			root,
			slug: "mission",
			slices: slices("slice-a"),
			base: "main",
			deps: { board: handle },
		});
		expect(existsSync(handle.boardPath)).toBe(true);
		const board = await readBoard(handle);
		expect(board.slice["slice-id"]).toBe("slice-a");
		expect(board.slice.status).toBe("running");
	});

	it("rejects a per-Slice board handle when the fork spans multiple Slices", async () => {
		const root = initRepo();
		const handle = openBoard(root, "mission", "slice-a");
		let caught;
		try {
			await forkSlicesRaw({
				root,
				slug: "mission",
				slices: slices("slice-a", "slice-b"),
				base: "main",
				deps: { board: handle },
			});
		} catch (error) {
			caught = error;
		}
		expect(isHerdError(caught)).toBe(true);
		expect(caught.code).toBe(":HOST_API_MISMATCH");
		expect(existsSync(join(root, ".herd-worktrees", "mission", "slice-a"))).toBe(false);
		expect(existsSync(join(root, ".herd-worktrees", "mission", "slice-b"))).toBe(false);
	});

	it("never overwrites a corrupt durable board while seeding", async () => {
		const root = initRepo();
		const handle = openBoard(root, "mission", "slice-a");
		mkdirSync(dirname(handle.boardPath), { recursive: true });
		writeFileSync(handle.boardPath, "{not-edn", "utf8");
		let caught;
		try {
			await forkSlicesRaw({
				root,
				slug: "mission",
				slices: slices("slice-a"),
				base: "main",
				deps: { board: handle },
			});
		} catch (error) {
			caught = error;
		}
		expect(isHerdError(caught)).toBe(true);
		expect(caught.code).toBe(":STALE_CONTROL");
		expect(readFileSync(handle.boardPath, "utf8")).toBe("{not-edn");
		expect(existsSync(join(root, ".herd-worktrees", "mission", "slice-a"))).toBe(false);
	});

	it("recovers a crash between worktree creation and the running state", async () => {
		const root = initRepo();
		const first = await forkSlices({
			root,
			slug: "mission",
			slices: slices("slice-a"),
			base: "main",
		});
		const statePath = join(root, ".herd", "missions", "mission", "worktrees.edn");
		const before = readFileSync(statePath, "utf8");
		writeFileSync(statePath, before.replace(":status :running", ":status :creating"), "utf8");

		const recovered = await forkSlices({
			root,
			slug: "mission",
			slices: slices("slice-a"),
			base: "main",
		});
		expect(recovered.map((handle) => handle.slice_id)).toEqual(["slice-a"]);
		expect(recovered[0].workspace).toBe(first[0].workspace);
		expect(stateOf(root).slices["slice-a"].status).toBe("running");
		expect(allSliceEvents(root).some((event) => event.event === "slice-fork-recovered")).toBe(true);
	});

	it("opens one durable board per Slice through a board factory", async () => {
		const root = initRepo();
		const handles = new Map();
		const factory = ({ sliceId }) => {
			const handle = openBoard(root, "mission", sliceId);
			handles.set(sliceId, handle);
			return handle;
		};
		const forked = await forkSlicesRaw({
			root,
			slug: "mission",
			slices: slices("slice-a", "slice-b"),
			base: "main",
			deps: { board: factory },
		});
		expect(forked.map((handle) => handle.slice_id)).toEqual(["slice-a", "slice-b"]);
		commitFile(worktreePaths(root, "mission", "slice-a").workspace, "a.txt", "a\n", "a");
		commitFile(worktreePaths(root, "mission", "slice-b").workspace, "b.txt", "b\n", "b");
		for (const sliceId of ["slice-a", "slice-b"]) {
			await enqueueSliceRaw({
				root,
				slug: "mission",
				sliceId,
				report: `${sliceId} report`,
				deps: { board: factory },
			});
		}
		expect((await joinSliceRaw({ root, slug: "mission", deps: { board: factory } })).slice_id).toBe("slice-a");
		expect((await joinSliceRaw({ root, slug: "mission", deps: { board: factory } })).slice_id).toBe("slice-b");
		expect((await readBoard(handles.get("slice-a"))).slice.status).toBe("joined");
		expect((await readBoard(handles.get("slice-b"))).slice.status).toBe("joined");
	});

	it("returns none for an empty mission without creating control state", async () => {
		const root = initRepo();
		const result = await joinSlice({ root, slug: "mission" });
		expect(result).toEqual({ slice_id: null, status: "none" });
		expect(existsSync(join(root, ".herd", "missions", "mission", "worktrees.edn"))).toBe(false);
	});

	it("fails closed on corrupt control state instead of rebuilding it", async () => {
		const root = initRepo();
		const statePath = join(root, ".herd", "missions", "mission", "worktrees.edn");
		mkdirSync(dirname(statePath), { recursive: true });
		writeFileSync(statePath, "{not-edn", "utf8");

		let caught;
		try {
			await joinSlice({ root, slug: "mission" });
		} catch (error) {
			caught = error;
		}
		expect(isHerdError(caught)).toBe(true);
		expect(caught.code).toBe(":STALE_CONTROL");
		expect(readFileSync(statePath, "utf8")).toBe("{not-edn");
	});

	it("stops a waiting join when the parent signal is aborted", async () => {
		const root = initRepo();
		await forkSlices({ root, slug: "mission", slices: slices("slice-a"), base: "main" });
		const controller = new AbortController();
		controller.abort("parent cancelled");

		let caught;
		try {
			await joinSlice({ root, slug: "mission", signal: controller.signal });
		} catch (error) {
			caught = error;
		}
		expect(isHerdError(caught)).toBe(true);
		expect(caught.code).toBe(":UPSTREAM_ABORTED");
		expect(stateOf(root).slices["slice-a"].status).toBe("running");
	});

	it("fails closed when an active Slice worktree disappeared", async () => {
		const root = initRepo();
		const [handle] = await forkSlices({
			root,
			slug: "mission",
			slices: slices("slice-a"),
			base: "main",
		});
		rmSync(handle.workspace, { recursive: true, force: true });
		let caught;
		try {
			await joinSlice({ root, slug: "mission" });
		} catch (error) {
			caught = error;
		}
		expect(isHerdError(caught)).toBe(true);
		expect(caught.code).toBe(":STALE_CONTROL");
		expect(caught.data.slices[0].slice_id).toBe("slice-a");
	});

	it("reports a non-conflict rebase failure without inventing a conflict scene", async () => {
		const root = initRepo();
		const [handle] = await forkSlices({
			root,
			slug: "mission",
			slices: slices("slice-a"),
			base: "main",
		});
		commitFile(handle.workspace, "tracked.txt", "base\n", "tracked work");
		writeFileSync(join(handle.workspace, "tracked.txt"), "dirty\n", "utf8");
		commitFile(root, "advanced.txt", "advanced\n", "advance base");
		await enqueueSlice({
			root,
			slug: "mission",
			sliceId: "slice-a",
			report: "dirty worktree",
		});
		let caught;
		try {
			await joinSlice({ root, slug: "mission" });
		} catch (error) {
			caught = error;
		}
		expect(isHerdError(caught)).toBe(true);
		expect(caught.code).toBe(":FF_NOT_READY");
		expect(caught.message).toContain("without a conflict scene");
		expect(caught.data.rebase_in_progress).toBeUndefined();
		expect(caught.data.stderr.length).toBeGreaterThan(0);
		expect(stateOf(root).slices["slice-a"].status).toBe("queued");
		expect(stateOf(root).slices["slice-a"].rebase_in_progress).toBeUndefined();
	});
});

describe("abandon, rebase conflicts and retention", () => {
	it("abandons only after the injected Holder port confirms the actor", async () => {
		const root = initRepo();
		const board = fakeBoard();
		await forkSlices({
			root,
			slug: "mission",
			slices: slices("slice-a"),
			base: "main",
			deps: { board },
		});
		await enqueueSlice({
			root,
			slug: "mission",
			sliceId: "slice-a",
			report: "queued with a holder",
			holder: { agent_id: "holder-default", term_id: "term-1" },
			deps: { board },
		});
		const abandoned = await abandonSlice({
			root,
			slug: "mission",
			sliceId: "slice-a",
			reason: "goal is obsolete",
			actor: { agent_id: "holder-default", term_id: "term-1", role: "holder" },
			deps: { board },
		});
		expect(abandoned.status).toBe("abandoned");
		expect(board.calls.assert).toHaveLength(1);
		expect(stateOf(root).queue).toEqual([]);
	});

	it("does not enforce owner_paths; join conflict policy owns path decisions", async () => {
		const root = initRepo();
		const spec = {
			slice_id: "slice-a",
			depends_on: [],
			status: "pending",
			goal: "only allowed/",
			done_when: "no outside changes",
			mapped_cases: [],
			owner_paths: ["allowed/"],
		};
		const [handle] = await forkSlices({
			root,
			slug: "mission",
			slices: [spec],
			base: "main",
		});
		commitFile(handle.workspace, "outside.txt", "outside\n", "outside ownership");
		await enqueueSlice({
			root,
			slug: "mission",
			sliceId: "slice-a",
			report: "ready to join",
		});
		const joined = await joinSlice({ root, slug: "mission" });
		expect(joined.slice_id).toBe("slice-a");
		const state = stateOf(root);
		expect(state.queue).toEqual([]);
		expect(state.slices["slice-a"].status).toBe("joined");
		expect(git(root, ["show", "HEAD:outside.txt"]).stdout).toBe("outside\n");
		expect(existsSync(handle.workspace)).toBe(true);
	});

	it("reports a rebase conflict, then abandons with a reason and keeps the worktree", async () => {
		const root = initRepo();
		const board = fakeBoard();
		await forkSlices({
			root,
			slug: "mission",
			slices: slices("slice-a"),
			base: "main",
			deps: { board },
		});
		const paths = worktreePaths(root, "mission", "slice-a");
		commitFile(paths.workspace, "shared.txt", "slice\n", "slice changes shared");
		commitFile(root, "shared.txt", "main\n", "main changes shared");
		await enqueueSlice({
			root,
			slug: "mission",
			sliceId: "slice-a",
			report: "conflict report",
			deps: { board },
		});

		let caught;
		try {
			await joinSlice({
				root,
				slug: "mission",
				deps: { board, conflictPolicy: () => ({ action: "report" }) },
			});
		} catch (error) {
			caught = error;
		}
		expect(isHerdError(caught)).toBe(true);
		expect(caught.code).toBe(":FF_NOT_READY");
		expect(caught.data.conflicted_paths).toContain("shared.txt");
		expect(caught.data.rebase_in_progress).toBe(true);
		expect(git(paths.workspace, ["diff", "--name-only", "--diff-filter=U"]).stdout.trim()).toBe("shared.txt");
		expect(stateOf(root).queue).toHaveLength(1);
		expect(stateOf(root).slices["slice-a"].status).toBe("queued");
		expect(stateOf(root).slices["slice-a"].rebase_in_progress).toBe(true);

		let denied;
		try {
			await abandonSlice({
				root,
				slug: "mission",
				sliceId: "slice-a",
				reason: "directional conflict",
				actor: { agent_id: "normal-a", term_id: "term-1", role: "normal" },
				deps: { board },
			});
		} catch (error) {
			denied = error;
		}
		expect(denied.code).toBe(":CAPABILITY_DENIED");

		let badReason;
		try {
			await abandonSlice({
				root,
				slug: "mission",
				sliceId: "slice-a",
				reason: "   ",
				actor: { agent_id: "holder-a", term_id: "term-1", role: "holder" },
				deps: { board },
			});
		} catch (error) {
			badReason = error;
		}
		expect(badReason.code).toBe(":INVALID_ARGUMENT");

		const retired = [];
		const abandoned = await abandonSlice({
			root,
			slug: "mission",
			sliceId: "slice-a",
			reason: "directional conflict: base proved the goal obsolete",
			actor: { agent_id: "holder-a", term_id: "term-1", role: "holder" },
			deps: {
				board,
				runner: {
					retireSlice(info) {
						retired.push(info);
					},
				},
			},
		});
		expect(abandoned.status).toBe("abandoned");
		expect(abandoned.workspace).toBe(paths.workspace);
		expect(existsSync(paths.workspace)).toBe(true);
		expect(retired).toHaveLength(1);
		expect(stateOf(root).queue).toEqual([]);
		expect(stateOf(root).slices["slice-a"].status).toBe("abandoned");
		expect(stateOf(root).slices["slice-a"].rebase_in_progress).toBe(true);
		expect(stateOf(root).slices["slice-a"].agent_retired).toBe(true);
		expect(git(paths.workspace, ["diff", "--name-only", "--diff-filter=U"]).stdout.trim()).toBe("shared.txt");

		let none;
		try {
			await joinSlice({ root, slug: "mission", deps: { board } });
		} catch (error) {
			none = error;
		}
		expect(none.code).toBe(":NO_RESULTS");
	});

	it("auto-abandons through the conflict policy and continues with the next Slice", async () => {
		const root = initRepo();
		const board = fakeBoard();
		await forkSlices({
			root,
			slug: "mission",
			slices: slices("slice-a", "slice-b"),
			base: "main",
			deps: { board },
		});
		const pathsA = worktreePaths(root, "mission", "slice-a");
		const pathsB = worktreePaths(root, "mission", "slice-b");
		commitFile(pathsA.workspace, "shared.txt", "slice\n", "a changes shared");
		commitFile(pathsB.workspace, "b.txt", "b\n", "b work");
		commitFile(root, "shared.txt", "main\n", "main changes shared");
		await enqueueSlice({
			root,
			slug: "mission",
			sliceId: "slice-a",
			report: "A report",
			deps: { board },
		});
		await enqueueSlice({
			root,
			slug: "mission",
			sliceId: "slice-b",
			report: "B report",
			deps: { board },
		});

		const abandoned = await joinSlice({
			root,
			slug: "mission",
			deps: {
				board,
				conflictPolicy: () => ({ action: "abandon", reason: "directional" }),
			},
		});
		expect(abandoned.status).toBe("abandoned");
		expect(abandoned.slice_id).toBe("slice-a");
		expect(existsSync(pathsA.workspace)).toBe(true);
		expect(git(pathsA.workspace, ["diff", "--name-only", "--diff-filter=U"]).stdout.trim()).toBe("shared.txt");
		expect(stateOf(root).slices["slice-a"].rebase_in_progress).toBe(true);
		expect(stateOf(root).queue.map((entry) => entry.slice_id)).toEqual(["slice-b"]);

		const joined = await joinSlice({ root, slug: "mission", deps: { board } });
		expect(joined.slice_id).toBe("slice-b");
		expect(joined.ff_commit).toBe(git(root, ["rev-parse", "herd/mission/slice-b"]).stdout.trim());
		expect(git(root, ["show", "HEAD:b.txt"]).stdout).toBe("b\n");
	});

	it("retains joined and abandoned worktrees for seven days, then garbage-collects", async () => {
		const root = initRepo();
		const board = fakeBoard();
		await forkSlices({
			root,
			slug: "mission",
			slices: slices("slice-a", "slice-b"),
			base: "main",
			deps: { board },
		});
		const pathsA = worktreePaths(root, "mission", "slice-a");
		const pathsB = worktreePaths(root, "mission", "slice-b");
		await abandonSlice({
			root,
			slug: "mission",
			sliceId: "slice-a",
			reason: "not needed",
			actor: { agent_id: "holder-a", term_id: "term-1", role: "holder" },
			deps: { board },
		});

		const retained = await gcWorktrees({ root, slug: "mission", deps: { board } });
		expect(retained.retained.map((entry) => entry.slice_id)).toContain("slice-a");
		expect(existsSync(pathsA.workspace)).toBe(true);

		const later = {
			now: () => new Date(Date.now() + 8 * DAY),
		};
		const collected = await gcWorktrees({
			root,
			slug: "mission",
			deps: { board, clock: later },
		});
		expect(collected.removed.map((entry) => entry.slice_id)).toEqual(["slice-a"]);
		expect(existsSync(pathsA.workspace)).toBe(false);
		expect(existsSync(pathsB.workspace)).toBe(true);
		expect(eventsOf(root).some((event) => event.event === "worktree-gc-done")).toBe(true);
	});
});
