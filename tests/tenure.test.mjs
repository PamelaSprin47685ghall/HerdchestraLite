import { describe, expect, it } from "bun:test";
import {
	applyReview,
	archiveBoardPath,
	attachToolForStage,
	boardIsEmpty,
	buildBarrier,
	buildSuccessorMission,
	emptyBoard,
	evaluateAttach,
	successorTenureId,
} from "../src/stages/tenure.mjs";

function emptyWith(tasks = {}) {
	return { ...emptyBoard("T-1"), tasks };
}

describe("emptyBoard", () => {
	it("starts with no tasks, version zero, and attach closed", () => {
		expect(emptyBoard("T-1")).toEqual({
			"board-version": 0,
			"tenure-id": "T-1",
			"review-summary": null,
			tasks: {},
			"attach-ready": false,
		});
	});

	it("rejects a blank tenure id", () => {
		expect(() => emptyBoard("  ")).toThrow(TypeError);
	});
});

describe("boardIsEmpty", () => {
	it("is true only for a plain board with no task keys", () => {
		expect(boardIsEmpty(emptyBoard("T-1"))).toBe(true);
		expect(boardIsEmpty(emptyWith({ F1: { value: "open" } }))).toBe(false);
		expect(boardIsEmpty(null)).toBe(false);
		expect(boardIsEmpty({ tasks: [] })).toBe(false);
	});
});

describe("applyReview", () => {
	it("upserts a non-empty finding value", () => {
		const result = applyReview(emptyBoard("T-1"), {
			findings: [{ key: "F1", value: "the parser drops trailing commas" }],
		});
		expect(result.ok).toBe(true);
		expect(result.board.tasks.F1).toEqual({ value: "the parser drops trailing commas" });
		expect(result.board["board-version"]).toBe(1);
		expect(result.openTasks).toBe(1);
		expect(result.status).toBe("review-open");
		expect(result.attachReady).toBe(false);
	});

	it("deletes a key when the value is nil", () => {
		const board = emptyWith({ F1: { value: "open" }, F2: { value: "keep" } });
		const result = applyReview(board, { findings: [{ key: "F1", value: null }] });
		expect(result.ok).toBe(true);
		expect(result.board.tasks.F1).toBeUndefined();
		expect(result.board.tasks.F2).toEqual({ value: "keep" });
		expect(result.status).toBe("review-open");
	});

	it("leaves the board unchanged for an empty findings array", () => {
		const board = emptyWith({ F1: { value: "open" } });
		const result = applyReview(board, { findings: [] });
		expect(result.ok).toBe(true);
		expect(result.board.tasks).toEqual(board.tasks);
		expect(result.openTasks).toBe(1);
	});

	it("leaves one task unchanged when its value is an empty array", () => {
		const board = emptyWith({ F1: { value: "open" } });
		const result = applyReview(board, { findings: [{ key: "F1", value: [] }] });
		expect(result.ok).toBe(true);
		expect(result.board.tasks.F1).toEqual({ value: "open" });
	});

	it("quiesces an empty board and exposes the expected attach tool", () => {
		const result = applyReview(emptyBoard("T-1"), { stage: "s2", findings: [] });
		expect(result.ok).toBe(true);
		expect(result.status).toBe("review-quiescent");
		expect(result.attachReady).toBe(true);
		expect(result.openTasks).toBe(0);
		expect(result.expectedAttach).toBe("attach_manual_tests");
		expect(result.board["attach-ready"]).toBe(true);
	});

	it("writes and clears the review summary", () => {
		const written = applyReview(emptyBoard("T-1"), {
			summary_markdown: "counts, boundaries, and recovery were checked",
			findings: [],
		});
		expect(written.board["review-summary"]).toBe("counts, boundaries, and recovery were checked");
		const cleared = applyReview(written.board, { summary_markdown: null });
		expect(cleared.ok).toBe(true);
		expect(cleared.board["review-summary"]).toBeNull();
	});

	it("keeps structural task keys when a review updates the value", () => {
		const board = emptyWith({
			F1: {
				value: "old",
				"parent-key": "ROOT",
				"child-keys": ["F2"],
				"wait-for": ["F2"],
				waiting: true,
			},
		});
		const result = applyReview(board, { findings: [{ key: "F1", value: "new" }] });
		expect(result.board.tasks.F1).toEqual({
			value: "new",
			"parent-key": "ROOT",
			"child-keys": ["F2"],
			"wait-for": ["F2"],
			waiting: true,
		});
	});

	it("accepts an object finding value as the whole task", () => {
		const result = applyReview(emptyBoard("T-1"), {
			findings: [{ key: "F1", value: { value: "open", waiting: false } }],
		});
		expect(result.ok).toBe(true);
		expect(result.board.tasks.F1).toEqual({ value: "open", waiting: false });
	});

	it("rejects a blank key or value without touching the input board", () => {
		const board = emptyWith({ F1: { value: "open" } });
		const before = structuredClone(board);
		const blankKey = applyReview(board, { findings: [{ key: " ", value: "x" }] });
		expect(blankKey.ok).toBe(false);
		expect(blankKey.error.code).toBe(":INVALID_ARGUMENT");
		const blankValue = applyReview(board, { findings: [{ key: "F2", value: "  " }] });
		expect(blankValue.ok).toBe(false);
		expect(board).toEqual(before);
	});

	it("does not mutate the input board", () => {
		const board = emptyWith({ F1: { value: "open" } });
		const before = structuredClone(board);
		applyReview(board, { summary_markdown: "summary", findings: [{ key: "F2", value: "next" }] });
		expect(board).toEqual(before);
	});

	it("rejects a malformed board", () => {
		expect(applyReview(null, { findings: [] }).error.code).toBe(":INVALID_ARGUMENT");
		expect(applyReview({ tasks: [] }, { findings: [] }).error.code).toBe(":INVALID_ARGUMENT");
	});
});

describe("attachToolForStage", () => {
	it("maps each Plan stage to its material-named tool", () => {
		expect(attachToolForStage("s1")).toBe("attach_brainstorm");
		expect(attachToolForStage("s2")).toBe("attach_manual_tests");
		expect(attachToolForStage("s3")).toBe("attach_dev_guide");
		expect(attachToolForStage("s4")).toBe("attach_coordination");
	});

	it("has no attach tool for S5 or an unknown stage", () => {
		expect(attachToolForStage("s5")).toBeNull();
		expect(attachToolForStage("s9")).toBeNull();
		expect(attachToolForStage(undefined)).toBeNull();
	});
});

describe("evaluateAttach", () => {
	const quiescent = applyReview(emptyBoard("T-1"), { stage: "s1", findings: [] });

	it("accepts a ready board with the matching tool", () => {
		const result = evaluateAttach({
			mission: { stage: "s1" },
			board: quiescent.board,
			tool: "attach_brainstorm",
			stage: "s1",
		});
		expect(result.ok).toBe(true);
		expect(result.tool).toBe("attach_brainstorm");
		expect(result.status).toBe("attach-ready");
		expect(result.summary).toBeNull();
	});

	it("refuses an open review ledger", () => {
		const open = applyReview(quiescent.board, { findings: [{ key: "F1", value: "fix" }] });
		const result = evaluateAttach({
			mission: { stage: "s1" },
			board: open.board,
			tool: "attach_brainstorm",
			stage: "s1",
		});
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":REVIEW_LEDGER_NOT_EMPTY");
	});

	it("refuses a board that has not quiesced", () => {
		const result = evaluateAttach({
			mission: { stage: "s2" },
			board: emptyBoard("T-1"),
			tool: "attach_manual_tests",
			stage: "s2",
		});
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":ATTACH_NOT_READY");
	});

	it("refuses a tool from another stage", () => {
		const result = evaluateAttach({
			mission: { stage: "s1" },
			board: quiescent.board,
			tool: "attach_manual_tests",
			stage: "s1",
		});
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":ATTACH_STAGE_MISMATCH");
		expect(result.error.expected).toBe("attach_brainstorm");
	});

	it("refuses a mission that is at another stage", () => {
		const result = evaluateAttach({
			mission: { stage: "s2" },
			board: quiescent.board,
			tool: "attach_brainstorm",
			stage: "s1",
		});
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":ATTACH_STAGE_MISMATCH");
	});

	it("refuses S5, which has no attach tool", () => {
		const result = evaluateAttach({
			mission: { stage: "s5" },
			board: quiescent.board,
			tool: "attach_coordination",
			stage: "s5",
		});
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe(":ATTACH_STAGE_MISMATCH");
	});
});

describe("archiveBoardPath", () => {
	it("names the archived board after the tenure", () => {
		expect(archiveBoardPath("T-3")).toBe(".herd/boards/T-3.edn");
	});

	it("rejects a blank tenure id", () => {
		expect(() => archiveBoardPath("")).toThrow(TypeError);
	});
});

describe("successorTenureId", () => {
	it("advances the numeric suffix", () => {
		expect(successorTenureId({ "tenure-id": "T-7" })).toBe("T-8");
		expect(successorTenureId({ "tenure-seq": 4, "tenure-id": "T-2" })).toBe("T-5");
	});

	it("starts at T-1 when no sequence is known", () => {
		expect(successorTenureId({})).toBe("T-1");
	});
});

describe("buildBarrier", () => {
	it("describes the retired tenure, archive, and successor", () => {
		const board = applyReview(emptyBoard("T-1"), {
			stage: "s1",
			summary_markdown: "approved by the operator",
			findings: [],
		}).board;
		const barrier = buildBarrier({
			mission: { stage: "s1", "tenure-id": "T-1" },
			board,
			tool: "attach_brainstorm",
			stage: "s1",
			now: "2026-01-01T00:00:00.000Z",
		});
		expect(barrier.from).toBe("s1");
		expect(barrier.to).toBe("s2");
		expect(barrier["retired-tenure"]).toBe("T-1");
		expect(barrier["successor-tenure"]).toBe("T-2");
		expect(barrier["board-archive"]).toBe(".herd/boards/T-1.edn");
		expect(barrier["review-summary"]).toBe("approved by the operator");
		expect(barrier["attach-tool"]).toBe("attach_brainstorm");
		expect(barrier.at).toBe("2026-01-01T00:00:00.000Z");
	});
});

describe("buildSuccessorMission", () => {
	it("opens the next stage with a fresh tenure and an empty board", () => {
		const mission = { slug: "demo", stage: "s1", "tenure-id": "T-1", "tenure-seq": 1 };
		const successor = buildSuccessorMission({
			mission,
			tool: "attach_brainstorm",
			stage: "s1",
			now: "2026-01-01T00:00:00.000Z",
		});
		expect(successor.stage).toBe("s2");
		expect(successor["tenure-id"]).toBe("T-2");
		expect(successor["tenure-seq"]).toBe(2);
		expect(successor.board).toEqual({ ...emptyBoard("T-2"), "attach-ready": false });
		expect(successor.board.tasks).toEqual({});
		expect(successor["attach-ready"]).toBe(false);
		expect(successor["attach-tool"]).toBe("attach_manual_tests");
		expect(successor["attached-tool"]).toBe("attach_brainstorm");
		expect(successor["updated-at"]).toBe("2026-01-01T00:00:00.000Z");
		expect(successor["created-at"]).toBe("2026-01-01T00:00:00.000Z");
		expect(mission.stage).toBe("s1");
	});

	it("gives S5 no attach tool", () => {
		const successor = buildSuccessorMission({
			mission: { stage: "s4", "tenure-id": "T-4" },
			tool: "attach_coordination",
			stage: "s4",
			now: "2026-01-01T00:00:00.000Z",
		});
		expect(successor.stage).toBe("s5");
		expect(successor["attach-tool"]).toBeNull();
		expect(successor["tenure-id"]).toBe("T-5");
	});

	it("refuses S5 as a source stage", () => {
		expect(() => buildSuccessorMission({ mission: { stage: "s5" } })).toThrow(TypeError);
	});
});