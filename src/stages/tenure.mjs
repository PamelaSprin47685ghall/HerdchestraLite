/**
 * Pure Plan-tenure state: review ledger, attach gating, barrier, and successor.
 *
 * Each Plan tenure owns one `board.edn`. That file is also the review ledger:
 * `tasks` is a flat map from a finding key to one task. A task may carry the
 * structural keys `parent-key`, `child-keys`, `wait-for`, and `waiting`; a
 * review only updates the task's `value`.
 *
 * `applyReview` never writes a stage document and never advances the stage.
 * Only an attach call does that: it archives the board, writes a barrier,
 * retires the tenure, and opens the successor.
 *
 * Every helper here is pure: no I/O and no clock. The caller supplies `now`,
 * so a replay produces the same bytes. `buildBarrier` and
 * `buildSuccessorMission` describe the archive and the successor; they persist
 * nothing.
 */

const STAGE_SEQUENCE = Object.freeze(["s1", "s2", "s3", "s4", "s5"]);

const ATTACH_TOOLS = Object.freeze({
	s1: "attach_brainstorm",
	s2: "attach_manual_tests",
	s3: "attach_dev_guide",
	s4: "attach_coordination",
});

const TENURE_SEQUENCE = /\d+$/;

function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isText(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function normalizeStage(value) {
	if (typeof value !== "string") return null;
	const text = value.trim().toLowerCase();
	return STAGE_SEQUENCE.includes(text) ? text : null;
}

function nextStageOf(stage) {
	const index = STAGE_SEQUENCE.indexOf(stage);
	if (index === -1 || index === STAGE_SEQUENCE.length - 1) return null;
	return STAGE_SEQUENCE[index + 1];
}

function invalid(message, data = {}) {
	return { ok: false, error: { code: ":INVALID_ARGUMENT", message, ...data } };
}

function failed(code, message, data = {}) {
	return { ok: false, error: { code, message, ...data } };
}

function tenureIdOf(mission, board) {
	const id = board?.["tenure-id"] ?? mission?.["tenure-id"];
	return isText(id) ? id.trim() : null;
}

function sequenceOf(mission, board) {
	const explicit = Number.isInteger(mission?.["tenure-seq"]) ? mission["tenure-seq"] : 0;
	const id = tenureIdOf(mission, board) ?? "";
	const match = TENURE_SEQUENCE.exec(id);
	const parsed = match === null ? 0 : Number(match[0]);
	return Math.max(explicit, parsed, 0);
}

function cloneTask(task) {
	if (Array.isArray(task)) return task.map((item) => (isPlainObject(item) ? { ...item } : item));
	if (isPlainObject(task)) return { ...task };
	return task;
}

/**
 * Build the empty board for one tenure.
 *
 * Inputs: a non-empty tenure id.
 * Output: `{tasks:{}, "board-version":0, "tenure-id":id, "review-summary":nil,
 * "attach-ready":false}`. The board starts closed to attach until a review
 * quiesces.
 */
export function emptyBoard(tenureId) {
	if (!isText(tenureId)) throw new TypeError("emptyBoard: tenureId must be a non-empty string");
	return {
		"board-version": 0,
		"tenure-id": tenureId.trim(),
		"review-summary": null,
		tasks: {},
		"attach-ready": false,
	};
}

/**
 * Report whether a board has no review obligations.
 *
 * Inputs: a board value.
 * Output: `true` only for a plain board with a plain `tasks` map that has no
 * keys. A malformed board is never empty.
 */
export function boardIsEmpty(board) {
	return isPlainObject(board) && isPlainObject(board.tasks) && Object.keys(board.tasks).length === 0;
}

/**
 * Map one Plan stage to its material-named attach tool.
 *
 * Inputs: a stage id such as `"s1"`.
 * Output: the tool name, or `null` for an unknown stage or for S5, which has no
 * attach tool.
 */
export function attachToolForStage(stage) {
	const id = normalizeStage(stage);
	if (id === null) return null;
	return Object.hasOwn(ATTACH_TOOLS, id) ? ATTACH_TOOLS[id] : null;
}

/**
 * Apply one review to the ledger.
 *
 * Inputs: `board`, plus `{summary_markdown, findings, stage}`. `findings` is a
 * list of `{key, value}`. A non-empty string value upserts the task's `value`
 * while keeping `parent-key`, `child-keys`, `wait-for`, and `waiting`; a plain
 * object value replaces the whole task; `nil` deletes the key; an empty array
 * leaves that task unchanged. An absent `findings` list changes no task.
 * `summary_markdown` replaces the board summary, and `nil` clears it; an absent
 * summary keeps the previous one.
 *
 * Output: `{ok, board, status, openTasks, attachReady, expectedAttach}`, or
 * `{ok:false, error}` for a malformed board or finding. `status` is
 * `"review-open"` while tasks remain and `"review-quiescent"` when the ledger
 * is empty. The input board is never mutated.
 */
export function applyReview(board, review = {}) {
	if (!isPlainObject(board) || !isPlainObject(board.tasks)) {
		return invalid("board must be a plain object with a tasks map", { field: "board" });
	}
	const input = isPlainObject(review) ? review : {};
	const findings = input.findings ?? [];
	if (!Array.isArray(findings)) return invalid("findings must be an array", { field: "findings" });

	const nextTasks = Object.fromEntries(
		Object.entries(board.tasks).map(([key, task]) => [key, cloneTask(task)]),
	);
	for (let index = 0; index < findings.length; index += 1) {
		const finding = findings[index];
		if (!isPlainObject(finding)) {
			return invalid(`findings[${index}] must be an object`, { field: "findings", index });
		}
		const key = isText(finding.key) ? finding.key.trim() : "";
		if (key === "") {
			return invalid(`findings[${index}].key must be a non-empty string`, { field: "findings", index });
		}
		const value = finding.value;
		if (value === null || value === undefined) {
			delete nextTasks[key];
			continue;
		}
		if (Array.isArray(value) && value.length === 0) continue;
		if (typeof value === "string") {
			if (!isText(value)) {
				return invalid(`findings[${index}].value must not be blank`, { field: "findings", index });
			}
			const previous = isPlainObject(nextTasks[key]) ? nextTasks[key] : {};
			nextTasks[key] = { ...previous, value: value.trim() };
			continue;
		}
		if (isPlainObject(value)) {
			nextTasks[key] = { ...value };
			continue;
		}
		return invalid(`findings[${index}].value must be a string, an object, nil, or []`, {
			field: "findings",
			index,
		});
	}

	let summary = typeof board["review-summary"] === "string" ? board["review-summary"] : null;
	if (Object.hasOwn(input, "summary_markdown")) {
		const value = input.summary_markdown;
		if (value === null) summary = null;
		else if (isText(value)) summary = value.trim();
		else return invalid("summary_markdown must be a non-empty string or nil", { field: "summary_markdown" });
	}

	const version = Number.isInteger(board["board-version"]) ? board["board-version"] : 0;
	const openTasks = Object.keys(nextTasks).length;
	const attachReady = openTasks === 0;
	const stage = normalizeStage(input.stage ?? board.stage);
	const nextBoard = {
		...board,
		"board-version": version + 1,
		"tenure-id": board["tenure-id"] ?? null,
		"review-summary": summary,
		tasks: nextTasks,
		"attach-ready": attachReady,
	};
	return {
		ok: true,
		board: nextBoard,
		status: attachReady ? "review-quiescent" : "review-open",
		openTasks,
		attachReady,
		expectedAttach: stage === null ? null : attachToolForStage(stage),
	};
}

/**
 * Gate one attach call against the stage and the review ledger.
 *
 * Inputs: `{mission, board, tool, stage}`.
 * Output: `{ok:true, tool, stage, status:"attach-ready", summary}` or
 * `{ok:false, error:{code}}` with `:ATTACH_STAGE_MISMATCH` for a wrong stage or
 * tool, `:REVIEW_LEDGER_NOT_EMPTY` for open tasks, and `:ATTACH_NOT_READY`
 * until an empty review has set the ready flag.
 */
export function evaluateAttach({ mission, board, tool, stage } = {}) {
	const id = normalizeStage(stage ?? mission?.stage);
	if (id === null || id === "s5") {
		return failed(":ATTACH_STAGE_MISMATCH", "attach needs one Plan stage: s1, s2, s3, or s4", {
			stage: stage ?? null,
		});
	}
	const expected = attachToolForStage(id);
	if (tool !== expected) {
		return failed(":ATTACH_STAGE_MISMATCH", `stage ${id} requires ${expected}`, {
			stage: id,
			expected,
			tool: tool ?? null,
		});
	}
	const missionStage = normalizeStage(mission?.stage);
	if (mission !== undefined && missionStage !== null && missionStage !== id) {
		return failed(":ATTACH_STAGE_MISMATCH", `mission is at ${missionStage}, not ${id}`, {
			stage: id,
			missionStage,
		});
	}
	if (!boardIsEmpty(board)) {
		return failed(":REVIEW_LEDGER_NOT_EMPTY", "review findings are still open", {
			openTasks: isPlainObject(board?.tasks) ? Object.keys(board.tasks).length : null,
		});
	}
	if (board?.["attach-ready"] !== true) {
		return failed(":ATTACH_NOT_READY", "an empty review must quiesce the board before attach", {
			stage: id,
		});
	}
	return {
		ok: true,
		tool: expected,
		stage: id,
		status: "attach-ready",
		summary: board["review-summary"] ?? null,
	};
}

/**
 * Archive path for a retired tenure's board.
 *
 * Inputs: a non-empty tenure id.
 * Output: `.herd/boards/<tenure-id>.edn`.
 */
export function archiveBoardPath(tenureId) {
	if (!isText(tenureId)) throw new TypeError("archiveBoardPath: tenureId must be a non-empty string");
	return `.herd/boards/${tenureId.trim()}.edn`;
}

/**
 * Monotonic id for the tenure that follows `mission`.
 *
 * Inputs: the current `mission` and optionally its `board`.
 * Output: `T-<n>`, where `n` is one more than the largest of the persisted
 * `tenure-seq`, the numeric suffix of the current tenure id, and zero.
 */
export function successorTenureId(mission, board) {
	return `T-${sequenceOf(mission, board) + 1}`;
}

/**
 * Describe the barrier written when a tenure retires.
 *
 * Inputs: `{mission, board, tool, stage, now}`.
 * Output: a plain map with `from`, `to`, `retired-tenure`, `successor-tenure`,
 * `board-archive`, `review-summary`, `attach-tool`, and `at`.
 */
export function buildBarrier({ mission, board, tool, stage, now } = {}) {
	const from = normalizeStage(stage ?? mission?.stage);
	if (from === null || from === "s5") {
		throw new TypeError("buildBarrier: stage must be s1, s2, s3, or s4");
	}
	const tenureId = tenureIdOf(mission, board);
	if (tenureId === null) throw new TypeError("buildBarrier: mission or board needs a tenure id");
	return {
		from,
		to: nextStageOf(from),
		"retired-tenure": tenureId,
		"successor-tenure": successorTenureId(mission, board),
		"board-archive": archiveBoardPath(tenureId),
		"review-summary": board?.["review-summary"] ?? null,
		"attach-tool": tool ?? attachToolForStage(from),
		at: now ?? null,
	};
}

/**
 * Describe the successor tenure after an attach.
 *
 * Inputs: `{mission, tool, stage, now}`.
 * Output: a copy of `mission` at the next stage with a new monotonic tenure id,
 * `tenure-seq` advanced, an empty board, `attach-ready:false`, the next attach
 * tool (or nil for S5), and `updated-at`/`created-at` set to `now`.
 */
export function buildSuccessorMission({ mission, tool, stage, now } = {}) {
	const from = normalizeStage(stage ?? mission?.stage);
	if (from === null || from === "s5") {
		throw new TypeError("buildSuccessorMission: stage must be s1, s2, s3, or s4");
	}
	const to = nextStageOf(from);
	const successorId = successorTenureId(mission, mission?.board);
	const timestamp = now ?? mission?.["updated-at"] ?? null;
	return {
		...mission,
		stage: to,
		"tenure-id": successorId,
		"tenure-seq": sequenceOf(mission, mission?.board) + 1,
		"created-at": timestamp,
		"updated-at": timestamp,
		board: { ...emptyBoard(successorId), "attach-ready": false },
		"attach-ready": false,
		"attach-tool": to === "s5" ? null : attachToolForStage(to),
		"attached-tool": tool ?? null,
	};
}