import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	applyReview,
	initialBoard,
	isAttachReady,
	openBoard,
	reviewLedger,
	wakeAll,
} from "../src/swarm/board.mjs";
const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function newRoot() {
	const root = mkdtempSync(join(tmpdir(), "herd-runner-s5-"));
	roots.push(root);
	return root;
}
function emptyPlan() {
	return initialBoard({ mode: "plan" });
}
describe("runner: S5 single main workspace", () => {
	it("opens one plan board per tenure with no slice directory or mission lock", () => {
		const root = newRoot();
		const handle = openBoard(root, "mission-a");
		expect(handle.mode).toBe("plan");
		expect(handle.sliceId).toBeNull();
		expect(handle.lockPath).toBeNull();
		expect(handle.boardPath).toBe(join(root, ".herd", "missions", "mission-a", "board.edn"));
		expect(relative(root, handle.boardPath)).not.toContain("slices");
		expect(existsSync(join(root, ".herd", "missions", "mission-a", "slices"))).toBe(false);
	});
	it("starts empty, attach-ready, and free of frozen hashes", () => {
		const board = emptyPlan();
		expect(board.tasks).toEqual({});
		expect(isAttachReady(board)).toBe(true);
		expect(reviewLedger(board)).toEqual({ summary: null, findings: [], empty: true, attachReady: true });
		expect(Object.keys(board).filter((key) => /frozen|contract-line|realign/i.test(key))).toEqual([]);
	});
	it("turns non-empty findings into flat ready ledger keys", () => {
		const result = applyReview(emptyPlan(), {
			findings: [
				{ key: "F1", value: "Close the parser boundary" },
				{ key: "F2", value: "Produce the evidence index" },
			],
		});
		expect(result.ok).toBe(true);
		expect(result.changed).toBe(true);
		expect(result.receipt.outcome).toBe("review-recorded");
		expect(result.receipt["task-keys"]).toEqual(["F1", "F2"]);
		expect(result.receipt["attach-ready"]).toBe(false);
		const tasks = result.board.tasks;
		expect(Object.keys(tasks)).toEqual(["F1", "F2"]);
		expect(tasks.F1.value).toBe("Close the parser boundary");
		expect(tasks.F1["parent-key"]).toBeNull();
		expect(tasks.F1["child-keys"]).toEqual([]);
		expect(tasks.F1["wait-for"]).toEqual([]);
		expect(result.events.map((event) => event["event-type"])).toEqual(["review"]);
	});
	it("upserts a key, deletes on nil, and leaves the board unchanged for an empty list", () => {
		const first = applyReview(emptyPlan(), {
			summaryMarkdown: "round one",
			findings: [{ key: "F1", value: "old" }],
		});
		const updated = applyReview(first.board, { findings: [{ key: "F1", value: "new" }] });
		expect(updated.board.tasks.F1.value).toBe("new");
		expect(updated.board["review-summary"]).toBe("round one");
		expect(updated.changed).toBe(true);
		const unchanged = applyReview(updated.board, { findings: [] });
		expect(unchanged.changed).toBe(false);
		expect(unchanged.board).toBe(updated.board);
		expect(unchanged.events).toEqual([]);
		const deleted = applyReview(updated.board, { findings: [{ key: "F1", value: null }] });
		expect(deleted.board.tasks).toEqual({});
		expect(deleted.receipt["attach-ready"]).toBe(true);
	});
	it("keeps parent links and wait-for on the flat task map", () => {
		const parent = applyReview(emptyPlan(), { findings: [{ key: "F1", value: "parent" }] });
		const child = applyReview(parent.board, {
			findings: [{ key: "F2", value: "child", parentKey: "F1", waitFor: ["F1"] }],
		});
		expect(child.board.tasks.F1["child-keys"]).toEqual(["F2"]);
		expect(child.board.tasks.F2["parent-key"]).toBe("F1");
		expect(child.board.tasks.F2["wait-for"]).toEqual(["F1"]);
	});
	it("sets attach-ready only while the ledger is empty", () => {
		const busy = applyReview(emptyPlan(), { findings: [{ key: "F1", value: "work" }] });
		expect(isAttachReady(busy.board)).toBe(false);
		const cleared = applyReview(busy.board, { findings: [{ key: "F1", value: null }] });
		expect(isAttachReady(cleared.board)).toBe(true);
	});
	it("wakes every slot with one wake-all event", () => {
		const woke = wakeAll(emptyPlan(), "review-findings-opened");
		expect(woke.epoch).toBe(1);
		expect(woke.board.wake.epoch).toBe(1);
		expect(woke.event["event-type"]).toBe("wake-all");
		expect(woke.event.cause).toBe("review-findings-opened");
	});
	it("rejects a review against a swarm slice board", () => {
		const result = applyReview(initialBoard({ mode: "swarm" }), {
			findings: [{ key: "F1", value: "x" }],
		});
		expect(result.ok).toBe(false);
		expect(String(result.error.code)).toContain("INVALID_ARGUMENT");
	});
	it("runner keeps one tenure surface and no fork, join, worktree, rebase or ff", async () => {
		const runner = await import("../src/swarm/runner.mjs");
		expect(typeof runner.runTenure).toBe("function");
		expect(Object.keys(runner)).not.toContain("startSlice");
		const legacy = Object.keys(runner).filter((name) => /fork|join|worktree|rebase|ff/i.test(name));
		expect(legacy).toEqual([]);
	});
});
