import { describe, expect, it } from "bun:test";
import { verdictFromScores } from "../src/manual-acceptance/scores.mjs";

const requirements = [
	{ id: "CASE-01", threshold: 80, path: "正常" },
	{ id: "CASE-02", threshold: 70, path: "错误" },
];

function scoresFor(overrides = {}) {
	return [
		{ case_id: "CASE-01", user_score: 90, developer_score: 80, ...(overrides["CASE-01"] ?? {}) },
		{ case_id: "CASE-02", user_score: 70, developer_score: 95, ...(overrides["CASE-02"] ?? {}) },
	];
}

describe("verdictFromScores", () => {
	it("uses min(user_score, developer_score) for the final score", () => {
		const verdict = verdictFromScores(requirements, scoresFor());

		expect(verdict.passed).toBe(true);
		expect(verdict.rows).toEqual([
			{
				caseId: "CASE-01",
				userScore: 90,
				developerScore: 80,
				score: 80,
				threshold: 80,
				passed: true,
			},
			{
				caseId: "CASE-02",
				userScore: 70,
				developerScore: 95,
				score: 70,
				threshold: 70,
				passed: true,
			},
		]);
		expect(verdict.missing).toEqual([]);
		expect(verdict.unknown).toEqual([]);
		expect(verdict.duplicates).toEqual([]);
		expect(verdict.invalid).toEqual([]);
	});

	it("fails a CASE when either perspective is below the threshold", () => {
		const verdict = verdictFromScores(requirements, scoresFor({ "CASE-01": { user_score: 60, developer_score: 100 } }));

		expect(verdict.passed).toBe(false);
		expect(verdict.rows[0]).toMatchObject({ score: 60, threshold: 80, passed: false });
		expect(verdict.rows[1].passed).toBe(true);
	});

	it("ignores a total score field and scores from the two perspectives", () => {
		const verdict = verdictFromScores(
			requirements,
			scoresFor({ "CASE-01": { score: 100, user_score: 40, developer_score: 90 } }),
		);

		expect(verdict.passed).toBe(false);
		expect(verdict.rows[0].score).toBe(40);
		expect(verdict.rows[0].passed).toBe(false);
		expect(verdict.invalid).toEqual([]);
	});

	it("accepts the inclusive 0 and 100 boundaries", () => {
		const verdict = verdictFromScores(
			[{ id: "CASE-01", threshold: 0, path: "边界" }],
			[{ case_id: "CASE-01", user_score: 0, developer_score: 100 }],
		);

		expect(verdict.passed).toBe(true);
		expect(verdict.rows[0].score).toBe(0);
	});

	it("reports a missing CASE and fails the verdict", () => {
		const verdict = verdictFromScores(requirements, [scoresFor()[0]]);

		expect(verdict.passed).toBe(false);
		expect(verdict.missing).toEqual(["CASE-02"]);
		expect(verdict.rows[1]).toEqual({
			caseId: "CASE-02",
			userScore: Number.NaN,
			developerScore: Number.NaN,
			score: Number.NaN,
			threshold: 70,
			passed: false,
		});
	});

	it("reports an unknown CASE and fails the verdict", () => {
		const verdict = verdictFromScores(requirements, [
			...scoresFor(),
			{ case_id: "CASE-99", user_score: 100, developer_score: 100 },
		]);

		expect(verdict.passed).toBe(false);
		expect(verdict.unknown).toEqual(["CASE-99"]);
		expect(verdict.rows).toHaveLength(2);
	});

	it("reports a duplicated CASE once and emits a failed row", () => {
		const verdict = verdictFromScores(requirements, [
			...scoresFor(),
			{ case_id: "CASE-01", user_score: 100, developer_score: 100 },
		]);

		expect(verdict.passed).toBe(false);
		expect(verdict.duplicates).toEqual(["CASE-01"]);
		expect(verdict.rows[0].passed).toBe(false);
		expect(verdict.rows[0].score).toBe(Number.NaN);
	});

	it("rejects out-of-range sub-scores", () => {
		const verdict = verdictFromScores(requirements, [
			{ case_id: "CASE-01", user_score: 101, developer_score: -1 },
			scoresFor()[1],
		]);

		expect(verdict.passed).toBe(false);
		expect(verdict.invalid).toEqual([
			"CASE-01: user_score 101 is outside 0..100",
			"CASE-01: developer_score -1 is outside 0..100",
		]);
		expect(verdict.rows[0].passed).toBe(false);
		expect(verdict.rows[0].score).toBe(Number.NaN);
	});

	it("rejects non-finite and non-number sub-scores", () => {
		const verdict = verdictFromScores(
			[
				{ id: "CASE-01", threshold: 50, path: "正常" },
				{ id: "CASE-02", threshold: 50, path: "正常" },
				{ id: "CASE-03", threshold: 50, path: "正常" },
				{ id: "CASE-04", threshold: 50, path: "正常" },
			],
			[
				{ case_id: "CASE-01", user_score: Number.NaN, developer_score: 50 },
				{ case_id: "CASE-02", user_score: Number.POSITIVE_INFINITY, developer_score: 50 },
				{ case_id: "CASE-03", user_score: "90", developer_score: 50 },
				{ case_id: "CASE-04", user_score: 50, developer_score: null },
			],
		);

		expect(verdict.passed).toBe(false);
		expect(verdict.invalid).toEqual([
			"CASE-01: user_score NaN is not a finite number",
			"CASE-02: user_score Infinity is not a finite number",
			'CASE-03: user_score "90" is not a finite number',
			"CASE-04: developer_score null is not a finite number",
		]);
		expect(verdict.rows.every((row) => row.passed === false)).toBe(true);
	});

	it("rejects an invalid threshold even when both scores are high", () => {
		const verdict = verdictFromScores(
			[
				{ id: "CASE-01", threshold: 101, path: "正常" },
				{ id: "CASE-02", threshold: -1, path: "正常" },
				{ id: "CASE-03", threshold: Number.NaN, path: "正常" },
			],
			[
				{ case_id: "CASE-01", user_score: 100, developer_score: 100 },
				{ case_id: "CASE-02", user_score: 100, developer_score: 100 },
				{ case_id: "CASE-03", user_score: 100, developer_score: 100 },
			],
		);

		expect(verdict.passed).toBe(false);
		expect(verdict.invalid).toEqual([
			"CASE-01: invalid threshold 101 (must be 0..100)",
			"CASE-02: invalid threshold -1 (must be 0..100)",
			"CASE-03: invalid threshold NaN (must be 0..100)",
		]);
		expect(verdict.rows.map((row) => row.passed)).toEqual([false, false, false]);
	});

	it("rejects malformed score entries without throwing", () => {
		const verdict = verdictFromScores(requirements, [
			null,
			[],
			"score",
			{ case_id: "  ", user_score: 100, developer_score: 100 },
			{ case_id: 7, user_score: 100, developer_score: 100 },
			...scoresFor(),
		]);

		expect(verdict.passed).toBe(false);
		expect(verdict.invalid).toEqual([
			"score entry is not an object: null",
			"score entry is not an object: object",
			'score entry is not an object: "score"',
			'score entry has an invalid case_id: "  "',
			"score entry has an invalid case_id: 7",
		]);
	});

	it("fails an empty requirements list", () => {
		const verdict = verdictFromScores([], []);

		expect(verdict.passed).toBe(false);
		expect(verdict.rows).toEqual([]);
	});
});
