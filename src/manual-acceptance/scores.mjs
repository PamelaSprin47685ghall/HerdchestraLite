/**
 * Turn the auditor's submitted scores into one verdict per requirement CASE.
 *
 * Inputs: the parsed requirements (id and threshold) and the raw `scores`
 * array from the auditor's yield.
 * Output: `{ passed, rows, missing, unknown, duplicates, invalid }`.
 *
 * A CASE passes only when its user score and developer score are both finite
 * numbers from 0 to 100, its threshold is valid, and
 * `min(user_score, developer_score)` reaches that threshold. A total `score`
 * field is ignored; one perspective cannot mask a low score in the other.
 * Every malformed entry is reported instead of thrown, so the caller can put
 * all problems in the report.
 */

const describe = (value) => {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	return typeof value;
};

export function verdictFromScores(requirements, scores) {
	const rows = [];
	const missing = [];
	const unknown = [];
	const duplicates = [];
	const invalid = [];
	const invalidThresholds = new Set();

	const requiredIds = new Set();
	for (const requirement of requirements) {
		// parseRequirementCases already refuses duplicate headings. Keep the
		// lookup set without a second, unreachable rejection branch.
		requiredIds.add(requirement.id);
		if (!Number.isFinite(requirement.threshold) || requirement.threshold < 0 || requirement.threshold > 100) {
			invalid.push(`${requirement.id}: invalid threshold ${describe(requirement.threshold)} (must be 0..100)`);
			invalidThresholds.add(requirement.id);
		}
	}

	const byCase = new Map();
	for (const entry of scores) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			invalid.push(`score entry is not an object: ${describe(entry)}`);
			continue;
		}
		if (typeof entry.case_id !== "string" || !entry.case_id.trim()) {
			invalid.push(`score entry has an invalid case_id: ${describe(entry.case_id)}`);
			continue;
		}
		const caseId = entry.case_id.trim();
		const submitted = {
			userScore: entry.user_score,
			developerScore: entry.developer_score,
		};
		const values = byCase.get(caseId);
		if (values) values.push(submitted);
		else byCase.set(caseId, [submitted]);
	}

	for (const caseId of byCase.keys()) {
		if (!requiredIds.has(caseId)) {
			unknown.push(caseId);
		}
	}
	for (const [caseId, values] of byCase) {
		if (requiredIds.has(caseId) && values.length > 1 && !duplicates.includes(caseId)) {
			duplicates.push(caseId);
		}
	}

	const readScore = (caseId, label, value) => {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			invalid.push(`${caseId}: ${label} ${describe(value)} is not a finite number`);
			return { value: Number.NaN, valid: false };
		}
		if (value < 0 || value > 100) {
			invalid.push(`${caseId}: ${label} ${value} is outside 0..100`);
			return { value, valid: false };
		}
		return { value, valid: true };
	};

	for (const requirement of requirements) {
		const values = byCase.get(requirement.id);
		if (!values || values.length === 0) {
			missing.push(requirement.id);
			rows.push({
				caseId: requirement.id,
				userScore: Number.NaN,
				developerScore: Number.NaN,
				score: Number.NaN,
				threshold: requirement.threshold,
				passed: false,
			});
			continue;
		}
		if (values.length > 1) {
			rows.push({
				caseId: requirement.id,
				userScore: Number.NaN,
				developerScore: Number.NaN,
				score: Number.NaN,
				threshold: requirement.threshold,
				passed: false,
			});
			continue;
		}
		const submitted = values[0];
		const userScore = readScore(requirement.id, "user_score", submitted.userScore);
		const developerScore = readScore(requirement.id, "developer_score", submitted.developerScore);
		const scoresValid = userScore.valid && developerScore.valid;
		const finalScore = scoresValid ? Math.min(userScore.value, developerScore.value) : Number.NaN;
		rows.push({
			caseId: requirement.id,
			userScore: userScore.value,
			developerScore: developerScore.value,
			score: finalScore,
			threshold: requirement.threshold,
			passed: scoresValid && !invalidThresholds.has(requirement.id) && finalScore >= requirement.threshold,
		});
	}

	const passed =
		requirements.length > 0 &&
		missing.length === 0 &&
		unknown.length === 0 &&
		duplicates.length === 0 &&
		invalid.length === 0 &&
		rows.every((row) => row.passed);

	return { passed, rows, missing, unknown, duplicates, invalid };
}
