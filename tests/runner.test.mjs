import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, createMemoryBoardStore, initialBoard, openBoard } from "../src/swarm/board.mjs";
import {
	cancelTree,
	classifyUpstreamError,
	createNudgeScheduler,
	createOracleGate,
	createReviewSink,
	createRunnerPort,
	createUpstreamBackoff,
	finishTask,
	NUDGE_BACKOFF_MS,
	oracleCandidates,
	oracleFingerprint,
	recover,
	relay,
	replaceSlot,
	retireSlice,
	runOracle,
	runTenure,
	startSlice,
	syncLedger,
	UPSTREAM_BACKOFF_MS,
} from "../src/swarm/runner.mjs";
import { enqueueSlice, forkSlices, joinSlice } from "../src/swarm/worktree.mjs";

const roots = [];
let uuidCounter = 0;

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function newRoot() {
	const root = mkdtempSync(join(tmpdir(), "herd-runner-"));
	roots.push(root);
	return root;
}

function uuidFactory() {
	return () => {
		uuidCounter += 1;
		return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
	};
}

function git(cwd, args) {
	const result = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Herd Runner Test",
			GIT_AUTHOR_EMAIL: "runner@example.test",
			GIT_COMMITTER_NAME: "Herd Runner Test",
			GIT_COMMITTER_EMAIL: "runner@example.test",
		},
	});
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
	return result.stdout.trim();
}

function gitRepo() {
	const root = newRoot();
	git(root, ["init", "-q", "-b", "main"]);
	writeFileSync(join(root, "base.txt"), "base\n");
	git(root, ["add", "base.txt"]);
	git(root, ["commit", "-q", "-m", "base"]);
	return root;
}

function makeHarness(overrides = {}) {
	const root = overrides.root ?? newRoot();
	const slug = overrides.slug ?? "mission-a";
	const sliceId = overrides.sliceId ?? "slice-a";
	const board = openBoard(root, slug, sliceId, {
		store: createMemoryBoardStore({ initial: overrides.initial ?? initialBoard() }),
	});
	const requests = [];
	const aborts = [];
	const enqueues = [];
	const unmounts = [];
	const agents = {
		start(request) {
			requests.push(request);
			const controller = new AbortController();
			const handle = {
				agentId: request.id,
				controller,
				abort(reason) {
					aborts.push({ agentId: request.id, reason });
					controller.abort(reason);
				},
			};
			return { handle, done: new Promise(() => {}) };
		},
	};
	const deps = {
		agents,
		ff: { ready: () => true },
		writeLock: { held: () => false },
		worktree: {
			async enqueue(info) {
				enqueues.push(info);
				return { position: 1, seq: 1, queued_at: "2026-11-11T00:00:00.000Z" };
			},
		},
		reviewTool: {
			async unmount() {
				unmounts.push(true);
			},
		},
		randomUUID: uuidFactory(),
		now: () => Date.parse("2026-11-11T00:00:00.000Z"),
		seed: "seed text",
		contracts: [{ path: "plans/mission-a/s1.md", sha256: "a".repeat(64) }],
		...overrides.deps,
	};
	const slice = {
		slice_id: sliceId,
		slug,
		root,
		workspace: join(root, ".herd-worktrees", slug, sliceId),
		board,
		seed: "seed text",
		contracts: deps.contracts,
		milestone: { label: "milestone-1", weight: 7 },
		...overrides.slice,
	};
	return {
		root,
		slug,
		sliceId,
		board,
		store: board.store,
		slice,
		deps,
		requests,
		aborts,
		enqueues,
		unmounts,
	};
}

async function read(harness) {
	return harness.store.read();
}

async function editBoard(harness, fn) {
	return harness.store.transaction(async (current) => {
		const draft = structuredClone(current);
		fn(draft);
		return { board: draft, events: [], response: { ok: true }, commit: true };
	});
}

async function startWith(harness) {
	const started = await startSlice({ slice: harness.slice, deps: harness.deps });
	expect(started.ok).toBe(true);
	return started;
}

async function openFindings(harness) {
	await startWith(harness);
	const result = await runTenure({
		slice: harness.slice,
		deps: harness.deps,
		findings: [
			{ key: "F1", value: "Implement the parser boundary and verify the failure path" },
			{ key: "F2", value: "Add the manual evidence index for the slice" },
		],
	});
	expect(result.ok).toBe(true);
	return result;
}

function runningAction(actionId, taskId, actorId, phase = "running") {
	return {
		"action-id": actionId,
		"task-id": taskId,
		"agent-id": actorId,
		"claim-id": `C-${taskId}`,
		kind: "edit",
		phase,
		"request-id": `R-${taskId}`,
		"result-ref": null,
	};
}

describe("runner: Phase A review window", () => {
	it("opens a clean Reviewer with only review tools and a fixed slot pool", async () => {
		const harness = makeHarness();
		const started = await startWith(harness);
		const board = await read(harness);

		expect(started.term).toBe(1);
		expect(started.termId).toBe("T-1");
		expect(board.tenure.phase).toBe("review");
		expect(board.tenure.milestone).toEqual({ label: "milestone-1", weight: 7 });
		expect(board.actors[started.reviewer.agentId]["term-id"]).toBe("T-1");
		expect(board.actors[started.reviewer.agentId]["slot-id"]).toBe("reviewer");

		const reviewerRequest = harness.requests.find((request) => request.role === "Reviewer");
		expect(reviewerRequest.tools).toEqual(["clj_review", "submit_review"]);
		expect(reviewerRequest.prompt).toContain("plans/mission-a/s1.md");
		expect(reviewerRequest.prompt).toContain(harness.slice.workspace);
		expect(reviewerRequest.name).toBe("Reviewer-slice-a-T-1");
		expect(started.slots).toHaveLength(4);
		expect(started.slots.every((slot) => slot.status === "idle")).toBe(true);
	});

	it("preserves an uppercase Slice id in the board path and Reviewer name", async () => {
		const harness = makeHarness({ sliceId: "SLICE-01" });
		const started = await startWith(harness);
		const reviewerRequest = harness.requests.find((request) => request.role === "Reviewer");
		expect(started.sliceId).toBe("SLICE-01");
		expect(harness.board.boardPath).toContain("/SLICE-01/");
		expect(reviewerRequest.name).toBe("Reviewer-SLICE-01-T-1");
	});

	it("keeps the tenure actor and slot when the host cannot spawn", async () => {
		const harness = makeHarness({
			deps: {
				agents: {
					start() {
						throw new Error("host unavailable");
					},
				},
			},
		});
		const started = await startSlice({ slice: harness.slice, deps: harness.deps });
		expect(started.ok).toBe(false);
		expect(started.error.code).toBe(":AGENT_SPAWN_FAILED");
		expect(started.slotPreserved).toBe(true);
		const board = await read(harness);
		expect(board.tenure.term).toBe(1);
		const reviewer = Object.values(board.actors).find((actor) => actor["slot-id"] === "reviewer");
		expect(reviewer).toBeDefined();
		expect(reviewer["life-state"]).toBe("dead");
	});
});

describe("runner: findings open Phase B", () => {
	it("creates root tasks, clears the wake barrier, unmounts review and starts all slots", async () => {
		const harness = makeHarness();
		const opened = await openFindings(harness);
		const board = await read(harness);
		const events = harness.store.events();

		expect(opened.phase).toBe("swarm");
		expect(opened.roots).toHaveLength(2);
		expect(board.tenure.phase).toBe("swarm");
		expect(board.tenure.ledger).toEqual({ F1: opened.roots[0], F2: opened.roots[1] });
		expect(board.wake.epoch).toBeGreaterThan(0);
		expect(board.sleepers).toEqual({});
		expect(harness.unmounts).toHaveLength(1);
		expect(harness.requests.filter((request) => request.role === "Swarm Worker")).toHaveLength(4);
		expect(events.some((entry) => entry["event-type"] === "review-findings-opened")).toBe(true);
		expect(events.some((entry) => entry["event-type"] === "wake-all")).toBe(true);
		expect(harness.aborts.some((entry) => entry.agentId.includes("reviewer"))).toBe(true);
	});

	it("is idempotent for the same findings and never duplicates root tasks", async () => {
		const harness = makeHarness();
		const opened = await openFindings(harness);
		const replay = await runTenure({
			slice: harness.slice,
			deps: harness.deps,
			findings: [
				{ key: "F1", value: "Implement the parser boundary and verify the failure path" },
				{ key: "F2", value: "Add the manual evidence index for the slice" },
			],
		});
		const board = await read(harness);

		expect(replay.ok).toBe(true);
		expect(replay.replayed).toBe(true);
		expect(replay.roots).toEqual(opened.roots);
		expect(Object.keys(board.tasks)).toHaveLength(2);
	});

	it("resumes a slice in Phase B without opening a second Reviewer", async () => {
		const harness = makeHarness();
		await openFindings(harness);
		const reviewerRequests = harness.requests.filter((request) => request.role === "Reviewer").length;
		const workerRequests = harness.requests.filter((request) => request.role === "Swarm Worker").length;
		const resumed = await startSlice({ slice: harness.slice, deps: harness.deps });
		expect(resumed.ok).toBe(true);
		expect(resumed.replayed).toBe(true);
		expect(resumed.phase).toBe("swarm");
		expect(harness.requests.filter((request) => request.role === "Reviewer")).toHaveLength(reviewerRequests);
		expect(harness.requests.filter((request) => request.role === "Swarm Worker")).toHaveLength(workerRequests);
	});

	it("keeps the root tasks and reports AGENT_SPAWN_FAILED when a slot cannot start", async () => {
		const harness = makeHarness();
		await startWith(harness);
		const original = harness.deps.agents.start;
		let failWorkers = true;
		harness.deps.agents.start = (request) => {
			if (failWorkers && request.role === "Swarm Worker") throw new Error("slot host unavailable");
			return original(request);
		};
		const result = await runTenure({
			slice: harness.slice,
			deps: harness.deps,
			findings: [{ key: "F1", value: "Close the finding" }],
		});
		failWorkers = false;
		const board = await read(harness);
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":AGENT_SPAWN_FAILED");
		expect(result.committed).toBe(true);
		expect(Object.keys(board.tasks)).toHaveLength(1);
		expect(board.tenure.phase).toBe("swarm");
		expect(Object.values(board.actors).some((actor) => actor["slot-id"] === "slot-1")).toBe(true);
	});

	it("starts all promise-only slots without waiting for any session to end", async () => {
		const starts = [];
		const harness = makeHarness({
			deps: {
				agents: {
					start(request) {
						starts.push(request);
						return new Promise(() => {});
					},
				},
			},
		});
		const started = await startSlice({ slice: harness.slice, deps: harness.deps });
		expect(started.ok).toBe(true);
		const opened = await runTenure({
			slice: harness.slice,
			deps: harness.deps,
			findings: [{ key: "F1", value: "close a promise-only slot finding" }],
		});
		expect(opened.ok).toBe(true);
		expect(starts.filter((request) => request.role === "Swarm Worker")).toHaveLength(4);
	});
});

describe("runner: atomic finish and relay", () => {
	async function claim(harness, taskId, agentId, suffix) {
		const result = await apply({
			board: harness.board,
			command: { type: "claim", taskId, atomicityReason: "single result boundary" },
			actor: { agentId },
			turnId: `claim-${suffix}`,
			requestId: `claim-${suffix}`,
		});
		expect(result.ok).toBe(true);
		return result.receipt.claimId ?? result.receipt["claim-id"];
	}

	it("commits the last root finish, ledger clear, Holder settle and relay barrier in one store transaction", async () => {
		const harness = makeHarness();
		const opened = await openFindings(harness);
		const board = await read(harness);
		const actor = Object.values(board.actors).find((entry) => entry["slot-id"] === "slot-1");
		const agentId = actor["agent-id"];

		const firstClaim = await claim(harness, opened.roots[0], agentId, "one");
		const first = await finishTask({
			slice: harness.slice,
			deps: harness.deps,
			command: {
				type: "finish",
				taskId: opened.roots[0],
				claimId: firstClaim,
				resultSummary: "first root finished",
				dependencyPaths: ["src/example.mjs"],
			},
			actor: { agentId },
			turnId: "finish-one",
			requestId: "finish-one",
		});
		expect(first.ok).toBe(true);
		expect(first.relayed).toBe(false);
		const afterFirst = await read(harness);
		expect(afterFirst.tenure.ledger.F1).toBeUndefined();
		expect(afterFirst.tenure.ledger.F2).toBe(opened.roots[1]);

		const secondClaim = await claim(harness, opened.roots[1], agentId, "two");
		const originalTransaction = harness.store.transaction.bind(harness.store);
		let transactions = 0;
		harness.store.transaction = (fn) => {
			transactions += 1;
			return originalTransaction(fn);
		};
		const second = await finishTask({
			slice: harness.slice,
			deps: harness.deps,
			command: {
				type: "finish",
				taskId: opened.roots[1],
				claimId: secondClaim,
				resultSummary: "last root finished",
				dependencyPaths: ["src/example.mjs"],
			},
			actor: { agentId },
			turnId: "finish-two",
			requestId: "finish-two",
		});
		harness.store.transaction = originalTransaction;
		const finalBoard = await read(harness);
		expect(second.ok).toBe(true);
		expect(second.relayed).toBe(true);
		expect(transactions).toBe(1);
		expect(finalBoard.tenure.term).toBe(2);
		expect(finalBoard.tenure.phase).toBe("review");
		expect(finalBoard.tenure.ledger).toEqual({});
		expect(finalBoard.tenure.barrier.term).toBe(1);
		expect(Object.values(finalBoard.tasks).every((task) => task.state === "done")).toBe(true);
		const events = harness.store.events();
		expect(events.some((entry) => entry["event-type"] === "ledger-keys-cleared")).toBe(true);
		expect(events.some((entry) => entry["event-type"] === "tenure-retired")).toBe(true);
		expect(harness.requests.filter((request) => request.role === "Reviewer")).toHaveLength(2);

		const replay = await finishTask({
			slice: harness.slice,
			deps: harness.deps,
			command: {
				type: "finish",
				taskId: opened.roots[1],
				claimId: secondClaim,
				resultSummary: "last root finished",
				dependencyPaths: ["src/example.mjs"],
			},
			actor: { agentId },
			turnId: "finish-two-replay",
			requestId: "finish-two",
		});
		expect(replay.ok).toBe(true);
		expect(replay.replayed).toBe(true);
		expect((await read(harness)).tenure.term).toBe(2);
	});

	it("commits the finish when ff is not ready, then retries the relay from a scheduled wake", async () => {
		const timers = [];
		const harness = makeHarness({
			deps: {
				ff: { ready: () => false },
				relayRetryDelayMs: 40,
				setTimeout(fn, ms) {
					const timer = { fn, ms, cancelled: false, unref() {} };
					timers.push(timer);
					return timer;
				},
				clearTimeout(timer) {
					if (timer) timer.cancelled = true;
				},
			},
		});
		const opened = await openFindings(harness);
		const board = await read(harness);
		const agentId = Object.values(board.actors).find((entry) => entry["slot-id"] === "slot-1")["agent-id"];
		for (const [index, taskId] of opened.roots.entries()) {
			const claimId = await claim(harness, taskId, agentId, `ff-${index}`);
			const result = await finishTask({
				slice: harness.slice,
				deps: harness.deps,
				command: {
					type: "finish",
					taskId,
					claimId,
					resultSummary: `finish ${index}`,
					dependencyPaths: ["src/example.mjs"],
				},
				actor: { agentId },
				turnId: `ff-finish-${index}`,
				requestId: `ff-finish-${index}`,
			});
			expect(result.ok).toBe(true);
			if (index === opened.roots.length - 1) {
				expect(result.relayed).toBe(false);
				expect(result.relayDeferred.code).toBe(":FF_NOT_READY");
			}
		}
		const deferredBoard = await read(harness);
		expect(deferredBoard.tenure.term).toBe(1);
		expect(deferredBoard.tenure.phase).toBe("swarm");
		const relayTimer = timers.find((timer) => timer.ms === 40);
		expect(relayTimer).toBeDefined();

		harness.deps.ff.ready = () => true;
		relayTimer.fn();
		await new Promise((resolve) => setTimeout(resolve, 10));
		const relayedBoard = await read(harness);
		expect(relayedBoard.tenure.term).toBe(2);
		expect(relayedBoard.tenure.phase).toBe("review");
	});
});

describe("runner: completion boundary", () => {
	it("rejects an empty review while an action is in flight", async () => {
		const harness = makeHarness();
		const opened = await openFindings(harness);
		await editBoard(harness, (board) => {
			board.actions.A1 = runningAction(
				"A1",
				opened.roots[0],
				board.actors ? Object.keys(board.actors)[0] : "x",
				"running",
			);
		});
		const result = await runTenure({ slice: harness.slice, deps: harness.deps, findings: [] });
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":RESOURCES_NOT_QUIESCENT");
		expect(harness.enqueues).toHaveLength(0);
	});

	it("rejects an empty review when the ff dry-run fails", async () => {
		const harness = makeHarness({ deps: { ff: { ready: () => false } } });
		await openFindings(harness);
		await editBoard(harness, (board) => {
			for (const task of Object.values(board.tasks)) task.state = "done";
		});
		const result = await runTenure({ slice: harness.slice, deps: harness.deps, findings: [] });
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":FF_NOT_READY");
		expect(harness.enqueues).toHaveLength(0);
	});

	it("queues the slice, retires the tenure and writes a barrier atomically", async () => {
		const harness = makeHarness();
		const opened = await openFindings(harness);
		await editBoard(harness, (board) => {
			for (const task of Object.values(board.tasks)) task.state = "done";
		});
		const result = await runTenure({ slice: harness.slice, deps: harness.deps, findings: [] });
		const board = await read(harness);
		const events = harness.store.events();

		expect(result.ok).toBe(true);
		expect(result.outcome).toBe("queued");
		expect(harness.enqueues).toHaveLength(1);
		expect(harness.enqueues[0].report).toContain("Slice slice-a report");
		expect(board.tenure.phase).toBe("queued");
		expect(board.tenure.retired ?? []).not.toContain("T-1");
		expect(board["token-slot"]["retired-terms"]).toContain("T-1");
		expect(board.tenure.barrier.term).toBe(1);
		expect(board.tenure.barrier.milestone).toEqual({ label: "milestone-1", weight: 7 });
		expect(events.some((entry) => entry["event-type"] === "tenure-retired")).toBe(true);
		expect(events.some((entry) => entry["event-type"] === "context-barrier-written")).toBe(true);

		const late = await runTenure({
			slice: harness.slice,
			deps: harness.deps,
			findings: [{ key: "LATE", value: "late finding" }],
			termId: "T-1",
		});
		expect(late.ok).toBe(false);
		expect(late.error.code).toBe(":TENURE_RETIRED");
		expect(opened.roots).toHaveLength(2);
	});

	it("settles a responsibility-free Holder before enqueue and leaves no stale holder in the queue", async () => {
		const harness = makeHarness();
		await openFindings(harness);
		let holderId;
		await editBoard(harness, (board) => {
			for (const task of Object.values(board.tasks)) task.state = "done";
			const actor = Object.values(board.actors).find((entry) => entry["slot-id"] === "slot-3");
			holderId = actor["agent-id"];
			actor.role = "holder";
			actor["term-id"] = "TERM-11";
			board["token-slot"] = {
				"holder-id": holderId,
				"term-id": "TERM-11",
				state: "held",
				"retired-terms": [],
			};
		});
		const result = await runTenure({ slice: harness.slice, deps: harness.deps, findings: [] });
		const board = await read(harness);
		expect(result.ok).toBe(true);
		expect(result.holderRetired["agent-id"]).toBe(holderId);
		expect(harness.enqueues).toHaveLength(1);
		expect(harness.enqueues[0].holder).toBeNull();
		expect(board["token-slot"]["holder-id"]).toBeNull();
		expect(board.actors[holderId]["life-state"]).toBe("dead");
	});

	it("asks exactly once for the first empty review and queues afterwards", async () => {
		const questions = [];
		const harness = makeHarness({
			slice: { initialEmptyReview: true },
			deps: {
				askUser: async ({ question }) => {
					questions.push(question);
					return "new requirement";
				},
			},
		});
		await startWith(harness);
		const reviewerRequest = harness.requests.find((request) => request.role === "Reviewer");
		expect(reviewerRequest.tools).toContain("ask_user");
		const first = await runTenure({ slice: harness.slice, deps: harness.deps, findings: [] });
		expect(first.ok).toBe(true);
		expect(first.outcome).toBe("ask-user");
		expect(questions).toHaveLength(1);
		const board = await read(harness);
		expect(board.tenure["initial-ask-used"]).toBe(true);
		expect(board.tenure.phase).toBe("review");

		const second = await runTenure({ slice: harness.slice, deps: harness.deps, findings: [] });
		expect(second.ok).toBe(true);
		expect(second.outcome).toBe("queued");
		expect(questions).toHaveLength(1);
	});
});

describe("runner: relay barrier", () => {
	it("retires the swarm, copies the milestone and opens a clean successor", async () => {
		const harness = makeHarness();
		const opened = await openFindings(harness);
		await editBoard(harness, (board) => {
			for (const task of Object.values(board.tasks)) task.state = "done";
			board.actions = {};
			board.sleepers = { old: { "agent-id": "old" } };
		});
		const before = await read(harness);
		const oldReviewer = Object.values(before.actors).find((actor) => actor["slot-id"] === "reviewer");
		const abortsBefore = harness.aborts.length;

		const result = await relay({ slice: harness.slice, deps: harness.deps });
		const board = await read(harness);
		const successorRequest = harness.requests.filter((request) => request.role === "Reviewer").at(-1);

		expect(result.ok).toBe(true);
		expect(result.term).toBe(2);
		expect(board.tenure.term).toBe(2);
		expect(board.tenure.phase).toBe("review");
		expect(board.tenure.milestone).toEqual({ label: "milestone-1", weight: 7 });
		expect(board.tenure.barrier.term).toBe(1);
		expect(board.actions).toEqual({});
		expect(board.sleepers).toEqual({});
		expect(board.actors[oldReviewer["agent-id"]]["life-state"]).toBe("dead");
		expect(successorRequest.name).toBe("Reviewer-slice-a-T-2");
		expect(successorRequest.prompt).toContain("milestone-1");
		expect(harness.aborts.length).toBe(abortsBefore);

		const late = await apply({
			board: harness.board,
			command: {
				type: "comment",
				taskId: opened.roots[0],
				text: "late request",
			},
			actor: { agentId: oldReviewer["agent-id"], termId: "T-1" },
			turnId: "late-turn",
			requestId: "late-request",
		});
		expect(late.ok).toBe(false);
		expect(late.error.code).toBe(":TENURE_RETIRED");
	});

	it("refuses to relay while a task is open", async () => {
		const harness = makeHarness();
		await openFindings(harness);
		const result = await relay({ slice: harness.slice, deps: harness.deps });
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":RESOURCES_NOT_QUIESCENT");
		const board = await read(harness);
		expect(board.tenure.term).toBe(1);
		expect(board.tenure.phase).toBe("swarm");
	});

	it("refuses to relay when the ff dry-run fails", async () => {
		const harness = makeHarness({ deps: { ff: { ready: () => false } } });
		await openFindings(harness);
		await editBoard(harness, (board) => {
			for (const task of Object.values(board.tasks)) task.state = "done";
		});
		const result = await relay({ slice: harness.slice, deps: harness.deps });
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":FF_NOT_READY");
		const board = await read(harness);
		expect(board.tenure.term).toBe(1);
		expect(board.tenure.phase).toBe("swarm");
	});

	it("hands a successor only a sanitized barrier context, never the runtime transcript", async () => {
		const seen = [];
		const harness = makeHarness({
			deps: {
				buildReviewerPrompt(context) {
					seen.push(context);
					return "sanitized reviewer prompt";
				},
			},
		});
		await openFindings(harness);
		await editBoard(harness, (board) => {
			for (const task of Object.values(board.tasks)) task.state = "done";
		});
		await relay({ slice: harness.slice, deps: harness.deps });
		expect(seen).toHaveLength(2);
		expect(Object.hasOwn(seen[1], "runtime")).toBe(false);
		expect(seen[1].successor).toBe(true);
		expect(seen[1].barrier.term).toBe(1);
		expect(seen[1].board.tenure.milestone).toEqual({ label: "milestone-1", weight: 7 });
	});

	it("retires a Holder with an empty responsibility set inside the relay transaction", async () => {
		const harness = makeHarness();
		await openFindings(harness);
		let holderId;
		await editBoard(harness, (board) => {
			for (const task of Object.values(board.tasks)) task.state = "done";
			const actor = Object.values(board.actors).find((entry) => entry["slot-id"] === "slot-1");
			holderId = actor["agent-id"];
			actor.role = "holder";
			actor["term-id"] = "TERM-9";
			board["token-slot"] = {
				"holder-id": holderId,
				"term-id": "TERM-9",
				state: "held",
				"retired-terms": [],
			};
		});
		const result = await relay({ slice: harness.slice, deps: harness.deps });
		const board = await read(harness);
		expect(result.ok).toBe(true);
		expect(result.holderRetired["agent-id"]).toBe(holderId);
		expect(board.actors[holderId]["life-state"]).toBe("dead");
		expect(board["token-slot"]["holder-id"]).toBeNull();
		expect(board["token-slot"].state).toBe("free");
		expect(board["token-slot"]["retired-terms"]).toContain("TERM-9");
	});

	it("retires a Holder whose only action is claimed, matching the board responsibility rule", async () => {
		const harness = makeHarness();
		const opened = await openFindings(harness);
		let holderId;
		await editBoard(harness, (board) => {
			for (const task of Object.values(board.tasks)) task.state = "done";
			const actor = Object.values(board.actors).find((entry) => entry["slot-id"] === "slot-2");
			holderId = actor["agent-id"];
			actor.role = "holder";
			actor["term-id"] = "TERM-12";
			board["token-slot"] = {
				"holder-id": holderId,
				"term-id": "TERM-12",
				state: "held",
				"retired-terms": [],
			};
			board.actions.A1 = runningAction("A1", opened.roots[0], holderId, "claimed");
		});
		const result = await relay({ slice: harness.slice, deps: harness.deps });
		const board = await read(harness);
		expect(result.ok).toBe(true);
		expect(result.holderRetired["agent-id"]).toBe(holderId);
		expect(board.actors[holderId]["life-state"]).toBe("dead");
		expect(board["token-slot"]["holder-id"]).toBeNull();
	});

	it("clears ledger keys only after their root task is done", async () => {
		const harness = makeHarness();
		const opened = await openFindings(harness);
		await editBoard(harness, (board) => {
			board.tasks[opened.roots[0]].state = "done";
		});
		const result = await syncLedger({ slice: harness.slice, deps: harness.deps });
		const board = await read(harness);
		expect(result.ok).toBe(true);
		expect(result.cleared).toEqual(["F1"]);
		expect(board.tenure.ledger.F1).toBeUndefined();
		expect(board.tenure.ledger.F2).toBe(opened.roots[1]);
		expect(result.relayReady).toBe(false);
	});

	it("settles the Holder in the same syncLedger transaction that clears the last finding", async () => {
		const harness = makeHarness();
		const opened = await openFindings(harness);
		let holderId;
		await editBoard(harness, (board) => {
			board.tasks[opened.roots[0]].state = "done";
			board.tasks[opened.roots[1]].state = "done";
			const actor = Object.values(board.actors).find((entry) => entry["slot-id"] === "slot-2");
			holderId = actor["agent-id"];
			actor.role = "holder";
			actor["term-id"] = "TERM-10";
			board["token-slot"] = {
				"holder-id": holderId,
				"term-id": "TERM-10",
				state: "held",
				"retired-terms": [],
			};
		});
		const result = await syncLedger({ slice: harness.slice, deps: harness.deps });
		const board = await read(harness);
		expect(result.ok).toBe(true);
		expect(result.cleared.sort()).toEqual(["F1", "F2"]);
		expect(result.holderRetired["agent-id"]).toBe(holderId);
		expect(board.actors[holderId]["life-state"]).toBe("dead");
		expect(board["token-slot"]["holder-id"]).toBeNull();
		expect(result.relayReady).toBe(true);
	});
});

describe("runner: slot lifecycle", () => {
	it("replaces a dead slot with a fresh agent id and never revives the old identity", async () => {
		const harness = makeHarness();
		await openFindings(harness);
		const slotOne = [...harness.requests].find((request) => request.name === "Worker-slice-a-slot-1");
		const oldAgentId = slotOne.id;

		const replaced = await replaceSlot({ slice: harness.slice, deps: harness.deps, slotId: "slot-1" });
		const after = await read(harness);
		expect(replaced.ok).toBe(true);
		expect(replaced.slotId).toBe("slot-1");
		expect(replaced.agentId).not.toBe(oldAgentId);
		expect(after.actors[oldAgentId]["life-state"]).toBe("dead");
		expect(after.actors[replaced.agentId]["life-state"]).toBe("alive");
		expect(after.actors[replaced.agentId]["slot-id"]).toBe("slot-1");

		const oldComment = await apply({
			board: harness.board,
			command: { type: "comment", taskId: Object.keys(after.tasks)[0], text: "old identity" },
			actor: { agentId: oldAgentId, termId: "T-1" },
			turnId: "old-turn",
			requestId: "old-request",
		});
		expect(oldComment.ok).toBe(false);
		expect(oldComment.error.code).toBe(":ACTOR_DEAD");

		const second = await replaceSlot({ slice: harness.slice, deps: harness.deps, slotId: "slot-1" });
		expect(second.agentId).not.toBe(replaced.agentId);
		expect(second.agentId).not.toBe(oldAgentId);
	});
});

describe("runner: cancellation", () => {
	it("aborts every live agent and classifies claim, apply and call outcomes", async () => {
		const harness = makeHarness();
		const opened = await openFindings(harness);
		const evidence = join(harness.root, "evidence.txt");
		writeFileSync(evidence, "keep me");
		await editBoard(harness, (board) => {
			const actors = Object.values(board.actors).filter((actor) => actor["slot-id"] !== "reviewer");
			board.actions = {
				A1: runningAction("A1", opened.roots[0], actors[0]["agent-id"], "claimed"),
				A2: runningAction("A2", opened.roots[1], actors[0]["agent-id"], "preparing"),
				A3: runningAction("A3", opened.roots[0], actors[1]["agent-id"], "running"),
				A4: runningAction("A4", opened.roots[1], actors[1]["agent-id"], "applying"),
				A5: {
					...runningAction("A5", opened.roots[0], actors[2]["agent-id"], "uncertain"),
					outcome: "outcome-unknown",
				},
			};
		});

		const result = await cancelTree({
			root: harness.root,
			slug: harness.slug,
			reason: "operator Esc",
		});
		const board = await read(harness);

		expect(result.ok).toBe(true);
		expect(result.aborted.length).toBeGreaterThanOrEqual(4);
		expect(result.cancelled.sort()).toEqual(["A1", "A2"]);
		expect(result.outcomeUnknown.sort()).toEqual(["A3", "A5"]);
		expect(result.applying).toEqual(["A4"]);
		expect(board.actions.A1.phase).toBe("finished");
		expect(board.actions.A1.outcome).toBe("cancelled");
		expect(board.actions.A2.phase).toBe("finished");
		expect(board.actions.A3.phase).toBe("uncertain");
		expect(board.actions.A3.outcome).toBe("outcome-unknown");
		expect(board.actions.A4.phase).toBe("applying");
		expect(existsSync(evidence)).toBe(true);
	});

	it("does not abort the tree when a tenure is retired by relay", async () => {
		const harness = makeHarness();
		const opened = await openFindings(harness);
		await editBoard(harness, (board) => {
			for (const task of Object.values(board.tasks)) task.state = "done";
		});
		const abortsBefore = harness.aborts.length;
		const result = await relay({ slice: harness.slice, deps: harness.deps });
		expect(result.ok).toBe(true);
		expect(harness.aborts.length).toBe(abortsBefore);
		expect(opened.roots).toHaveLength(2);
	});

	it("makes every runner entry point refuse a cancelled tree", async () => {
		const harness = makeHarness();
		await openFindings(harness);
		await cancelTree({ slice: harness.slice, deps: harness.deps, reason: "operator" });
		const again = await startSlice({ slice: harness.slice, deps: harness.deps });
		expect(again.ok).toBe(false);
		expect(again.error.code).toBe(":UPSTREAM_ABORTED");
		const tenure = await runTenure({ slice: harness.slice, deps: harness.deps, findings: [] });
		expect(tenure.ok).toBe(false);
		expect(tenure.error.code).toBe(":UPSTREAM_ABORTED");
		const relayed = await relay({ slice: harness.slice, deps: harness.deps });
		expect(relayed.ok).toBe(false);
		expect(relayed.error.code).toBe(":UPSTREAM_ABORTED");
	});
});

describe("nudge scheduler", () => {
	function harness() {
		const timers = [];
		const sends = [];
		const scheduler = createNudgeScheduler({
			schedule: NUDGE_BACKOFF_MS,
			send: (text, options) => sends.push({ text, options }),
			setTimeout: (fn, ms) => {
				const timer = { fn, ms, cancelled: false, unref() {} };
				timers.push(timer);
				return timer;
			},
			clearTimeout: (timer) => {
				if (timer) timer.cancelled = true;
			},
		});
		return { scheduler, timers, sends };
	}

	const context = {
		stage: "S2",
		role: "Plan",
		expectedTool: "advance_s2",
		openItems: ["write s2-manual-tests.md"],
		parkedPrograms: ["scope-check"],
	};

	it("fires immediately, then backs off 30/60/120/240/300 seconds", () => {
		const { scheduler, sends } = harness();
		const delays = [];
		delays.push(scheduler.turnEnd(context).delayMs);
		for (let index = 0; index < 6; index += 1) {
			delays.push(scheduler.turnEnd(context).delayMs);
		}
		expect(delays).toEqual([0, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
		expect(sends).toHaveLength(1);
		expect(sends[0].text).toContain("advance_s2");
		expect(sends[0].text).toContain("write s2-manual-tests.md");
		expect(sends[0].text).toContain("scope-check");
		expect(sends[0].text).toContain("无人值守");
		expect(sends[0].options).toEqual({ triggerTurn: true });
	});

	it("resets to immediate on progress and after board, human, gate or audit resets", () => {
		const { scheduler } = harness();
		scheduler.turnEnd(context);
		const backingOff = scheduler.turnEnd(context);
		expect(backingOff.delayMs).toBe(30_000);
		const progressed = scheduler.turnEnd({ ...context, progress: true });
		expect(progressed.delayMs).toBe(0);
		scheduler.turnEnd(context);
		scheduler.turnEnd(context);
		scheduler.noteBoardChange();
		expect(scheduler.idle).toBe(0);
		expect(scheduler.turnEnd(context).delayMs).toBe(0);
		scheduler.noteHumanInput();
		expect(scheduler.turnEnd(context).delayMs).toBe(0);
		scheduler.noteGateSuccess();
		expect(scheduler.turnEnd(context).delayMs).toBe(0);
		scheduler.noteAuditResult();
		expect(scheduler.turnEnd(context).delayMs).toBe(0);
	});

	it("suppresses the Nudge during legal waits and clears a pending timer", () => {
		const { scheduler, timers, sends } = harness();
		scheduler.turnEnd(context);
		const pending = scheduler.turnEnd(context);
		expect(pending.delayMs).toBe(30_000);
		const waiting = scheduler.turnEnd({ ...context, waitingForHuman: true });
		expect(waiting.suppressed).toBe(true);
		expect(timers.at(-1).cancelled).toBe(true);
		const legal = scheduler.turnEnd({ ...context, legalExit: true });
		expect(legal.suppressed).toBe(true);
		expect(sends).toHaveLength(1);
	});
});

describe("upstream backoff", () => {
	it("retries transient failures 5/10/20/40/80 and stops retrying deterministic errors", () => {
		const backoff = createUpstreamBackoff({ schedule: UPSTREAM_BACKOFF_MS });
		const delays = [];
		for (let index = 0; index < 6; index += 1) {
			delays.push(backoff.failure({ status: 503, message: "service unavailable" }).delayMs);
		}
		expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 80_000]);

		const stalled = backoff.failure({ code: "insufficient_quota", message: "insufficient_quota" });
		expect(stalled.action).toBe("stalled");
		expect(stalled.retry).toBe(false);
		expect(classifyUpstreamError({ status: 429 }).action).toBe("retry");
		expect(classifyUpstreamError({ status: 529 }).action).toBe("retry");
		expect(classifyUpstreamError({ code: "network_error" }).action).toBe("retry");
		expect(classifyUpstreamError({ aborted: true }).action).toBe("retry");
		expect(classifyUpstreamError({ message: "invalid api key" }).action).toBe("stalled");
		expect(classifyUpstreamError({ message: "model not found" }).action).toBe("stalled");
		expect(classifyUpstreamError(new Error("aborted"), { signal: { aborted: true } }).action).toBe("cancelled");
		expect(classifyUpstreamError({ parse: true, message: "invalid json" }).action).toBe("fix");
	});
});

describe("blocker oracle", () => {
	it("normalizes timestamps, agent ids and temp paths out of the fingerprint", () => {
		const base = {
			goal: "Fix the parser boundary",
			doneWhen: "the parser test passes",
			reason: "the same two tests fail",
		};
		const noisy = {
			goal: "Fix the parser boundary 2026-11-11T10:00:00Z",
			doneWhen: "the parser test passes agent-123e4567-e89b-12d3-a456-426614174000",
			reason: "the same two tests fail at /tmp/run-abc/out.log, please retry",
		};
		expect(oracleFingerprint(base)).toBe(oracleFingerprint(noisy));
		expect(oracleFingerprint({ ...base, goal: "Fix another boundary" })).not.toBe(oracleFingerprint(base));
	});

	it("triggers once per fingerprint and respects the mission budget", () => {
		const gate = createOracleGate({ threshold: 2, maxConsultations: 1 });
		const input = {
			taskId: "T-1",
			goal: "Fix parser",
			doneWhen: "test passes",
			reason: "same failure",
		};
		expect(gate.observe(input).trigger).toBe(false);
		const triggered = gate.observe(input);
		expect(triggered.trigger).toBe(true);
		expect(gate.observe(input).reason).toBe("already-consulted");
		const secondInput = {
			taskId: "T-2",
			goal: "Fix writer",
			doneWhen: "writer test passes",
			reason: "different failure",
		};
		gate.observe(secondInput);
		const second = gate.observe(secondInput);
		expect(second.trigger).toBe(false);
		expect(second.reason).toBe("budget-exhausted");
	});

	it("accepts only specific advice, appends a comment and leaves ownership untouched", async () => {
		const harness = makeHarness();
		const opened = await openFindings(harness);
		const before = await read(harness);
		const taskId = opened.roots[0];
		const ownerBefore = before.tasks[taskId]["owner-id"];
		const stateBefore = before.tasks[taskId].state;
		const requestsBefore = harness.requests.length;

		const result = await runOracle({
			slice: harness.slice,
			deps: {
				...harness.deps,
				agents: {
					start(request) {
						harness.requests.push(request);
						return {
							ok: true,
							agentId: request.id,
							result: {
								advice_markdown:
									"Change the src/parser.mjs interface first, then verify with bun test and split the failing case.",
							},
						};
					},
				},
			},
			taskId,
			reason: "same two tests keep failing",
			trigger: { trigger: true, fingerprint: oracleFingerprint({ goal: "g", doneWhen: "d", reason: "r" }) },
		});
		const after = await read(harness);
		const oracleRequest = harness.requests.at(-1);
		const events = harness.store.events();

		expect(result.ok).toBe(true);
		expect(harness.requests.length).toBe(requestsBefore + 1);
		expect(oracleRequest.role).toBe("Blocker Oracle");
		expect(oracleRequest.tools).toEqual(["clj_review", "submit_oracle_advice"]);
		expect(oracleRequest.prompt).toContain("read-only");
		expect(after.tasks[taskId]["owner-id"]).toBe(ownerBefore);
		expect(after.tasks[taskId].state).toBe(stateBefore);
		expect(after.tasks[taskId].comments.at(-1).text).toContain("src/parser.mjs");
		expect(after.conditions[`oracle:${result.fingerprint}`]).toBe(true);
		expect(events.some((entry) => entry["event-type"] === "oracle-consulted")).toBe(true);
	});

	it("records generic advice as no-new-path and keeps the task open", async () => {
		const harness = makeHarness();
		const opened = await openFindings(harness);
		const taskId = opened.roots[0];
		const before = await read(harness);
		const result = await runOracle({
			slice: harness.slice,
			deps: {
				...harness.deps,
				agents: {
					start(request) {
						return {
							ok: true,
							agentId: request.id,
							result: { advice_markdown: "再试试" },
						};
					},
				},
			},
			taskId,
			reason: "stuck",
			trigger: { trigger: true, fingerprint: "f".repeat(64) },
		});
		const after = await read(harness);
		expect(result.ok).toBe(true);
		expect(result.outcome).toBe("no-new-path");
		expect(after.tasks[taskId].comments.at(-1).text).toContain("已会诊、无新路径");
		expect(after.tasks[taskId].state).toBe(before.tasks[taskId].state);
		expect(after.tasks[taskId]["owner-id"]).toBe(before.tasks[taskId]["owner-id"]);
		expect(after["board-version"]).toBeGreaterThan(before["board-version"]);
	});

	it("revives a condition-waiting parent when Oracle advice resolves its key", async () => {
		const harness = makeHarness();
		const opened = await openFindings(harness);
		const taskId = opened.roots[0];
		const fingerprint = "a".repeat(64);
		await editBoard(harness, (board) => {
			board.tasks[taskId].state = "waiting";
			board.tasks[taskId]["wait-for"] = [`condition:oracle:${fingerprint}`];
		});
		const result = await runOracle({
			slice: harness.slice,
			deps: {
				...harness.deps,
				agents: {
					start(request) {
						return {
							ok: true,
							agentId: request.id,
							result: {
								advice_markdown: "Change the src/parser.mjs interface and verify with bun test.",
							},
						};
					},
				},
			},
			taskId,
			reason: "blocked",
			trigger: { trigger: true, fingerprint },
		});
		const board = await read(harness);
		expect(result.ok).toBe(true);
		expect(board.tasks[taskId].state).toBe("ready");
		expect(board.tasks[taskId]["wait-for"]).toEqual([]);
		expect(board.tasks[taskId]["revived-turn-id"]).toBe("runner:oracle");
		expect(harness.store.events().some((entry) => entry["event-type"] === "condition-resolved")).toBe(true);
	});

	it("derives candidates from repeated board events instead of a chat body", async () => {
		const harness = makeHarness();
		const opened = await openFindings(harness);
		const board = await read(harness);
		const events = [
			{ "event-type": "task-reopened", taskId: opened.roots[0], reason: "same test fails" },
			{ "event-type": "task-reopened", taskId: opened.roots[0], reason: "same test fails" },
		];
		expect(oracleCandidates({ board, events })).toHaveLength(1);
		expect(oracleCandidates({ board, events })[0].taskId).toBe(opened.roots[0]);
		expect(oracleCandidates({ board, events: events.slice(0, 1) })).toEqual([]);
	});
});

describe("runner ports", () => {
	it("exposes a ReviewSink that rejects a retired tenure and a bounded RunnerPort", async () => {
		const harness = makeHarness();
		await startWith(harness);
		const sink = createReviewSink({ slice: harness.slice, deps: harness.deps });
		const accepted = await sink.submit({ termId: "T-1" }, [
			{ key: "F1", value: "Close the first finding with evidence" },
		]);
		expect(accepted.ok).toBe(true);

		const port = createRunnerPort({ slice: harness.slice, deps: harness.deps });
		expect(typeof port.startSlice).toBe("function");
		expect(typeof port.runTenure).toBe("function");
		expect(typeof port.relay).toBe("function");
		expect(typeof port.reviewSink.submit).toBe("function");

		await editBoard(harness, (board) => {
			for (const task of Object.values(board.tasks)) task.state = "done";
		});
		const queued = await port.runTenure({ findings: [] });
		expect(queued.ok).toBe(true);
		const late = await sink.submit({ termId: "T-1" }, [{ key: "LATE", value: "late" }]);
		expect(late.ok).toBe(false);
		expect(late.error.code).toBe(":TENURE_RETIRED");
	});

	it("retires a Slice on the worktree abandon path without deleting tasks", async () => {
		const harness = makeHarness();
		const opened = await openFindings(harness);
		const before = await read(harness);
		const result = await retireSlice({ slice: harness.slice, deps: harness.deps, reason: "direction rejected" });
		const after = await read(harness);
		expect(result.ok).toBe(true);
		expect(after.tenure.phase).toBe("retired");
		expect(after.tenure.retired ?? []).not.toContain("T-1");
		expect(after["token-slot"]["retired-terms"]).toContain("T-1");
		expect(Object.keys(after.tasks)).toEqual(Object.keys(before.tasks));
		expect(opened.roots).toHaveLength(2);
	});

	it("fails closed when the ff port or the write-lock port reports a busy Slice", async () => {
		const noFf = makeHarness({ deps: { ff: undefined } });
		await openFindings(noFf);
		await editBoard(noFf, (board) => {
			for (const task of Object.values(board.tasks)) task.state = "done";
		});
		const ffMissing = await runTenure({ slice: noFf.slice, deps: noFf.deps, findings: [] });
		expect(ffMissing.ok).toBe(false);
		expect(ffMissing.error.code).toBe(":FF_NOT_READY");

		const locked = makeHarness({ deps: { writeLock: { held: () => true } } });
		await openFindings(locked);
		await editBoard(locked, (board) => {
			for (const task of Object.values(board.tasks)) task.state = "done";
		});
		const wHeld = await runTenure({ slice: locked.slice, deps: locked.deps, findings: [] });
		expect(wHeld.ok).toBe(false);
		expect(wHeld.error.code).toBe(":RESOURCES_NOT_QUIESCENT");

		const noPort = makeHarness({ deps: { writeLock: undefined } });
		await openFindings(noPort);
		await editBoard(noPort, (board) => {
			for (const task of Object.values(board.tasks)) task.state = "done";
		});
		const wUnknown = await runTenure({ slice: noPort.slice, deps: noPort.deps, findings: [] });
		expect(wUnknown.ok).toBe(false);
		expect(wUnknown.error.code).toBe(":RESOURCES_NOT_QUIESCENT");
		expect(wUnknown.error.message).toContain("write-lock port");
		const relayUnknown = await relay({ slice: noPort.slice, deps: noPort.deps });
		expect(relayUnknown.ok).toBe(false);
		expect(relayUnknown.error.code).toBe(":RESOURCES_NOT_QUIESCENT");
	});

	it("retries a failed slot with bounded backoff instead of dropping its ready tasks", async () => {
		const timers = [];
		const starts = [];
		let failWorkers = true;
		const harness = makeHarness({
			deps: {
				retryDelayMs: 25,
				maxSlotRetries: 2,
				setTimeout(fn, ms) {
					const timer = { fn, ms, cancelled: false, unref() {} };
					timers.push(timer);
					return timer;
				},
				clearTimeout(timer) {
					if (timer) timer.cancelled = true;
				},
				agents: {
					start(request) {
						starts.push(request);
						if (failWorkers && request.role === "Swarm Worker") {
							throw new Error("worker host unavailable");
						}
						return new Promise(() => {});
					},
				},
			},
		});
		await startWith(harness);
		const opened = await runTenure({
			slice: harness.slice,
			deps: harness.deps,
			findings: [{ key: "F1", value: "retry this ready task" }],
		});
		expect(opened.ok).toBe(false);
		expect(opened.error.code).toBe(":AGENT_SPAWN_FAILED");
		expect(timers).toHaveLength(4);
		expect(timers.every((timer) => timer.ms === 25)).toBe(true);

		failWorkers = false;
		const before = starts.filter((request) => request.role === "Swarm Worker").length;
		timers[0].fn();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(starts.filter((request) => request.role === "Swarm Worker").length).toBe(before + 1);
		const board = await read(harness);
		expect(
			[...Object.values(board.actors)].some((actor) => actor.role === "normal" && actor["life-state"] === "alive"),
		).toBe(true);
	});

	it("moves an exhausted retry burst to a cooldown and still replaces the slot later", async () => {
		const timers = [];
		let failWorkers = true;
		const harness = makeHarness({
			deps: {
				retryDelayMs: 5,
				stalledRetryDelayMs: 50,
				maxSlotRetries: 1,
				setTimeout(fn, ms) {
					const timer = { fn, ms, cancelled: false, unref() {} };
					timers.push(timer);
					return timer;
				},
				clearTimeout(timer) {
					if (timer) timer.cancelled = true;
				},
				agents: {
					start(request) {
						if (failWorkers && request.role === "Swarm Worker") {
							throw new Error("worker host unavailable");
						}
						return new Promise(() => {});
					},
				},
			},
		});
		await startWith(harness);
		const opened = await runTenure({
			slice: harness.slice,
			deps: harness.deps,
			findings: [{ key: "F1", value: "keep the ready task" }],
		});
		expect(opened.ok).toBe(false);
		const firstBurst = timers.filter((timer) => timer.ms === 5);
		expect(firstBurst).toHaveLength(4);
		firstBurst[0].fn();
		await new Promise((resolve) => setTimeout(resolve, 5));
		const cooldown = timers.find((timer) => timer.ms === 50);
		expect(cooldown).toBeDefined();

		failWorkers = false;
		cooldown.fn();
		await new Promise((resolve) => setTimeout(resolve, 10));
		const board = await read(harness);
		expect(Object.values(board.tasks)[0].state).toBe("ready");
		expect([...Object.values(board.actors)].some((actor) => actor["life-state"] === "alive")).toBe(true);
	});

	it("marks a deterministic model error stalled without burning retries, yet wake() can replace it", async () => {
		const timers = [];
		const starts = [];
		let stalled = true;
		const harness = makeHarness({
			deps: {
				maxSlotRetries: 3,
				setTimeout(fn, ms) {
					const timer = { fn, ms, cancelled: false, unref() {} };
					timers.push(timer);
					return timer;
				},
				clearTimeout(timer) {
					if (timer) timer.cancelled = true;
				},
				agents: {
					start(request) {
						starts.push(request);
						if (stalled && request.role === "Swarm Worker") {
							return { ok: false, error: { code: ":STALLED", message: "insufficient_quota" } };
						}
						return new Promise(() => {});
					},
				},
			},
		});
		await startWith(harness);
		const opened = await runTenure({
			slice: harness.slice,
			deps: harness.deps,
			findings: [{ key: "F1", value: "deterministic model failure" }],
		});
		expect(opened.ok).toBe(false);
		expect(timers).toHaveLength(0);
		const board = await read(harness);
		expect(Object.values(board.tasks)[0].state).toBe("ready");
		const port = createRunnerPort({ slice: harness.slice, deps: harness.deps });
		expect(port.slots.filter((slot) => slot.status === "stalled")).toHaveLength(4);
		expect(port.slots.every((slot) => slot.stalledReason === ":STALLED")).toBe(true);

		stalled = false;
		const before = starts.filter((request) => request.role === "Swarm Worker").length;
		const woken = await port.wake();
		expect(woken.ok).toBe(true);
		expect(starts.filter((request) => request.role === "Swarm Worker")).toHaveLength(before + 4);
	});

	it("exposes wake() so the host can reopen ready work after idle slots", async () => {
		const harness = makeHarness();
		await startWith(harness);
		await editBoard(harness, (board) => {
			board.tenure.phase = "swarm";
			board.tasks["T-1"] = {
				"task-id": "T-1",
				"ledger-key": null,
				goal: "reopened work",
				"remaining-work": "do it",
				"done-when": "done",
				state: "ready",
				"wait-for": [],
				"needs-token": false,
				"owner-id": null,
				"claim-id": null,
				"parent-id": null,
				"child-ids": [],
				"result-refs": [],
				"result-summary": null,
				"dependency-paths": [],
				"handoff-note": null,
				comments: [],
				"revived-turn-id": null,
			};
		});
		const port = createRunnerPort({ slice: harness.slice, deps: harness.deps });
		const before = harness.requests.filter((request) => request.role === "Swarm Worker").length;
		const woken = await port.wake();
		expect(woken.ok).toBe(true);
		expect(harness.requests.filter((request) => request.role === "Swarm Worker")).toHaveLength(before + 4);
	});
});

describe("durable board and worktree integration", () => {
	it("refuses to seed a missing durable Slice board", async () => {
		const root = newRoot();
		const slug = "mission-a";
		const sliceId = "slice-a";
		const board = openBoard(root, slug, sliceId);
		const harness = makeHarness({
			root,
			slug,
			sliceId,
			slice: {
				board,
				workspace: join(root, ".herd-worktrees", slug, sliceId),
			},
			deps: {},
		});
		const result = await startSlice({ slice: harness.slice, deps: harness.deps });
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":STALE_CONTROL");
		expect(existsSync(board.boardPath)).toBe(false);
	});

	it("runs forkSlices -> durable runner tenure -> enqueueSlice -> joinSlice on real git", async () => {
		const root = gitRepo();
		const slug = "mission-a";
		const sliceId = "slice-a";
		const board = openBoard(root, slug, sliceId);
		expect(board.durable).toBe(true);

		const handles = await forkSlices({
			root,
			slug,
			base: "main",
			slices: [
				{
					slice_id: sliceId,
					depends_on: [],
					goal: "wire the durable runner",
					done_when: "the slice is queued and joined",
					mapped_cases: ["CASE-22"],
				},
			],
			deps: { board },
		});
		expect(handles).toHaveLength(1);
		const handle = handles[0];
		expect(handle.workspace).toBe(join(root, ".herd-worktrees", slug, sliceId));
		expect(existsSync(board.boardPath)).toBe(true);
		const seeded = await board.store.read();
		expect(Number.isInteger(seeded["board-version"])).toBe(true);
		expect(seeded["token-slot"].state).toBe("free");
		expect(seeded.slice.status).toBe("running");

		const harness = makeHarness({
			root,
			slug,
			sliceId,
			slice: {
				board,
				workspace: handle.workspace,
				goal: "wire the durable runner",
				done_when: "the slice is queued and joined",
				mapped_cases: ["CASE-22"],
			},
			deps: {
				worktree: {
					enqueue: (info) => enqueueSlice({ ...info, deps: { board } }),
				},
			},
		});
		const started = await startSlice({ slice: harness.slice, deps: harness.deps });
		expect(started.ok).toBe(true);
		const afterStart = await board.store.read();
		expect(afterStart.slice.status).toBe("running");
		const opened = await runTenure({
			slice: harness.slice,
			deps: harness.deps,
			findings: [{ key: "F1", value: "close the durable board finding" }],
		});
		expect(opened.ok).toBe(true);

		await board.store.transaction(async (current) => {
			const draft = structuredClone(current);
			for (const task of Object.values(draft.tasks)) task.state = "done";
			return { board: draft, events: [], response: { ok: true }, commit: true };
		});
		const queued = await runTenure({ slice: harness.slice, deps: harness.deps, findings: [] });
		expect(queued.ok).toBe(true);
		expect(queued.outcome).toBe("queued");

		const statePath = join(root, ".herd", "missions", slug, "worktrees.edn");
		const queueText = readFileSync(statePath, "utf8");
		expect(queueText).toContain(sliceId);
		expect(queueText).toContain(":queued");
		expect(queueText).toContain("Slice slice-a report");
		const durableBoard = await board.store.read();
		expect(durableBoard.tenure.phase).toBe("queued");
		expect(durableBoard.tenure.queue.position).toBe(1);
		expect(durableBoard.slice.status).toBe("queued");

		const joined = await joinSlice({ root, slug, deps: { board } });
		expect(joined.slice_id).toBe(sliceId);
		expect(joined.workspace).toBe(handle.workspace);
		expect(joined.report).toContain("Slice slice-a report");
		expect(joined.ff_commit).toMatch(/^[0-9a-f]{40}$/);
		const joinedBoard = await board.store.read();
		expect(joinedBoard.slice.status).toBe("joined");
		const joinedText = readFileSync(statePath, "utf8");
		expect(joinedText).toContain(":joined");
		expect(joinedText).toContain(sliceId);
	});
});

describe("recovery", () => {
	function recoveryHarness() {
		const root = newRoot();
		const slug = "mission-a";
		const sliceId = "slice-a";
		const board = openBoard(root, slug, sliceId, {
			store: createMemoryBoardStore({ initial: initialBoard() }),
		});
		const missionDir = join(root, ".herd", "missions", slug);
		const sliceDir = join(missionDir, "slices", sliceId);
		mkdirSync(sliceDir, { recursive: true });
		writeFileSync(join(missionDir, "mission.edn"), "{:stage :s5}\n");
		writeFileSync(join(sliceDir, "checkpoint.edn"), '{:offset 128 :digest "abc"}\n');
		writeFileSync(join(sliceDir, ".tmp-abc"), "partial");
		const staleLock = join(root, ".herd", "locks", "slice-a.write-w.lock");
		const aliveLock = join(root, ".herd", "locks", "master-integration.lock");
		mkdirSync(join(root, ".herd", "locks"), { recursive: true });
		writeFileSync(staleLock, '{"pid":999999}\n');
		writeFileSync(aliveLock, '{"pid":1}\n');
		return {
			root,
			slug,
			sliceId,
			board,
			missionDir,
			sliceDir,
			staleLock,
			aliveLock,
			slice: {
				slice_id: sliceId,
				slug,
				root,
				workspace: join(root, ".herd-worktrees", slug, sliceId),
				board,
				lock_paths: { writeW: staleLock, integration: aliveLock },
			},
		};
	}

	it("scans the six windows in order, keeps .tmp and never deletes a live lock", async () => {
		const harness = recoveryHarness();
		const result = await recover({
			slice: harness.slice,
			deps: {
				lock: {
					inspect(path) {
						return path === harness.staleLock ? { state: "stale" } : { state: "alive" };
					},
				},
			},
		});
		expect(result.ok).toBe(true);
		expect(result.order).toEqual(["mission", "board", "locks", "tmp", "ledger", "worktree"]);
		expect(result.scanned.ledger.offset).toBe(128);
		expect(result.scanned.ledger.replayed).toBe(false);
		expect(result.scanned.tmp.files).toHaveLength(1);
		expect(result.scanned.locks.staleFiles).toEqual([harness.staleLock]);
		expect(result.scanned.locks.aliveFiles).toEqual([harness.aliveLock]);
		expect(existsSync(harness.staleLock)).toBe(true);
		expect(existsSync(join(harness.sliceDir, ".tmp-abc"))).toBe(true);
	});

	it("supports the mission-level recover({root, slug}) signature without a Slice id", async () => {
		const harness = recoveryHarness();
		const result = await recover({
			root: harness.root,
			slug: harness.slug,
			deps: {
				lockPaths: { writeW: harness.staleLock, integration: harness.aliveLock },
				lock: { inspect: () => ({ state: "alive" }) },
			},
		});
		expect(result.ok).toBe(true);
		expect(result.scanned.board.status).toBe("missing");
		expect(result.scanned.board.slices[0].sliceId).toBe("slice-a");
		expect(result.scanned.worktree.status).toBe("none");
		expect(result.scanned.tmp.files).toHaveLength(1);
		expect(result.order).toEqual(["mission", "board", "locks", "tmp", "ledger", "worktree"]);
	});

	it("uses the shared inspectLock with the 30-second stale threshold and board actor state", async () => {
		const harness = recoveryHarness();
		await harness.board.store.transaction(async (current) => {
			const draft = structuredClone(current);
			draft.actors["agent-dead"] = {
				"agent-id": "agent-dead",
				"slot-id": "slot-1",
				role: "normal",
				"life-state": "dead",
				"active-action-id": null,
				"term-id": null,
			};
			return { board: draft, events: [], response: { ok: true }, commit: true };
		});
		const oldLock = join(harness.root, ".herd", "locks", "old-owner.lock");
		const recentLock = join(harness.root, ".herd", "locks", "recent-owner.lock");
		const now = Date.now();
		const lockBody = (startedAt) =>
			`${JSON.stringify({
				lock_id: "lock-x",
				purpose: "writeW",
				slice_id: harness.sliceId,
				owner_agent_id: "agent-dead",
				owner_term_id: "TERM-1",
				pid: process.pid,
				started_at: new Date(startedAt).toISOString(),
				host: "test",
				token: "token-x",
			})}\n`;
		writeFileSync(oldLock, lockBody(now - 60_000));
		writeFileSync(recentLock, lockBody(now - 1_000));
		const result = await recover({
			slice: {
				...harness.slice,
				lock_paths: { old: oldLock, recent: recentLock },
			},
			deps: {},
		});
		const entries = Object.fromEntries(result.scanned.locks.entries.map((entry) => [entry.path, entry]));
		expect(entries[oldLock].state).toBe("stale");
		expect(entries[oldLock].reason).toBe("owner-dead-stale");
		expect(entries[recentLock].state).toBe("unknown");
		expect(entries[recentLock].stale).toBe(false);
		expect(result.scanned.locks.staleFiles).toEqual([oldLock]);
	});

	it("discovers slice boards and lock files for the mission-level recovery used by session_start", async () => {
		const root = newRoot();
		const slug = "mission-recovery";
		const sliceId = "slice-a";
		const board = openBoard(root, slug, sliceId);
		await board.store.initialize(initialBoard());
		await board.store.transaction(async (current) => {
			const draft = structuredClone(current);
			draft.actors["agent-dead"] = {
				"agent-id": "agent-dead",
				"slot-id": "slot-1",
				role: "normal",
				"life-state": "dead",
				"active-action-id": null,
				"term-id": null,
			};
			return { board: draft, events: [], response: { ok: true }, commit: true };
		});
		mkdirSync(join(root, ".herd", "missions", slug), { recursive: true });
		writeFileSync(join(root, ".herd", "missions", slug, "mission.edn"), "{:stage :s5}\n");
		mkdirSync(join(root, ".herd", "locks"), { recursive: true });
		const lockPath = join(root, ".herd", "locks", "slice-a.write-w.lock");
		writeFileSync(
			lockPath,
			`${JSON.stringify({
				lock_id: "lock-recovery",
				purpose: "writeW",
				slice_id: sliceId,
				owner_agent_id: "agent-dead",
				owner_term_id: "TERM-1",
				pid: process.pid,
				started_at: new Date(Date.now() - 60_000).toISOString(),
				token: "token-recovery",
			})}\n`,
		);
		mkdirSync(join(root, ".herd-worktrees", slug, sliceId), { recursive: true });

		const result = await recover({ root, slug, deps: {} });
		expect(result.ok).toBe(true);
		expect(result.scanned.board.status).toBe("present");
		expect(result.scanned.board.slices[0].sliceId).toBe(sliceId);
		expect(result.scanned.locks.staleFiles).toContain(lockPath);
		expect(result.scanned.worktree.status).toBe("present");
		expect(result.scanned.worktree.entries[0].sliceId).toBe(sliceId);
		expect(result.retained.worktree).toBe(true);
	});

	it("reports lost control state and never rebuilds an empty mission", async () => {
		const root = newRoot();
		const slug = "missing-mission";
		const board = openBoard(root, slug, "slice-a", {
			store: createMemoryBoardStore({ initial: initialBoard() }),
		});
		const result = await recover({
			slice: {
				slice_id: "slice-a",
				slug,
				root,
				workspace: join(root, "missing"),
				board,
			},
			deps: {},
		});
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":STALE_CONTROL");
		expect(result.error.data.lost).toBe(true);
		expect(existsSync(join(root, ".herd", "missions", slug))).toBe(false);
	});

	it("backs up first, requires confirmation and removes only stale locks", async () => {
		const harness = recoveryHarness();
		const deps = {
			lock: {
				inspect(path) {
					return path === harness.staleLock ? { state: "stale" } : { state: "alive" };
				},
			},
			confirm: async () => false,
		};
		const refused = await recover({ slice: harness.slice, deps, repair: true });
		expect(refused.ok).toBe(false);
		expect(refused.error.code).toBe(":CONFIRMATION_REQUIRED");
		expect(refused.backups.length).toBeGreaterThan(0);
		expect(existsSync(harness.staleLock)).toBe(true);

		const depsConfirmed = { ...deps, confirm: async () => true };
		const repaired = await recover({ slice: harness.slice, deps: depsConfirmed, repair: true });
		expect(repaired.ok).toBe(true);
		expect(repaired.repaired.locks).toEqual([harness.staleLock]);
		expect(existsSync(harness.staleLock)).toBe(false);
		expect(existsSync(harness.aliveLock)).toBe(true);
		expect(existsSync(join(harness.sliceDir, ".tmp-abc"))).toBe(true);
		expect(readdirSync(harness.sliceDir).some((name) => name.startsWith(".tmp-abc.bak-"))).toBe(false);
	});

	it("reports a corrupt board and does not guess a replacement", async () => {
		const harness = recoveryHarness();
		const corruptBoard = {
			...harness.board,
			store: {
				async read() {
					throw new Error("EDN digest mismatch");
				},
				async transaction() {
					throw new Error("do not write");
				},
			},
		};
		const written = [];
		const result = await recover({
			slice: { ...harness.slice, board: corruptBoard },
			deps: {
				confirm: async () => true,
				repairBoard: async () => initialBoard(),
				writeBoard: async (state) => written.push(state),
			},
			repair: true,
		});
		expect(result.ok).toBe(true);
		expect(result.scanned.board.status).toBe("corrupt");
		expect(result.repaired.board).toBe(true);
		expect(written).toHaveLength(1);
		expect(result.requiresOperator.length).toBeGreaterThan(0);
	});
});
