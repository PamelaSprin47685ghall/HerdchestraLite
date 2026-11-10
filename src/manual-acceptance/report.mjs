/**
 * Build the human-readable manual acceptance report and write it atomically.
 *
 * Inputs: the goal, the auditor's yield payload, the computed verdict, the
 * resolved model, and the working directory.
 * Output: the report markdown, or the relative path of the written report.
 *
 * The template, table order, problem list, and PASS/FAIL summary are copied
 * verbatim from the old implementation. An empty report or a goal without a
 * frozen contract is refused instead of writing a misleading file.
 */

import { MANUAL_ACCEPTANCE_REPORT_FILE } from "./constants.mjs";
import {
	manualAcceptanceContractLine,
	manualAcceptanceEffectiveContract,
	parseManualContract,
} from "./contract.mjs";
import {
	manualAcceptanceDir,
	manualAcceptanceRelativePath,
	manualAcceptanceWriteErrorText,
} from "./documents.mjs";
import { writeFileAtomic } from "../util/atomic-write.mjs";

export function buildReport(goal, payload, verdict, model) {
	const tableRows = verdict.rows.map((row) => ({
		...row,
		userScoreText: Number.isFinite(row.userScore) ? String(row.userScore) : "invalid",
		developerScoreText: Number.isFinite(row.developerScore)
			? String(row.developerScore)
			: "invalid",
		scoreText: Number.isFinite(row.score) ? String(row.score) : "invalid",
	}));
	const problems = [];
	if (verdict.missing.length > 0) {
		problems.push(`Missing CASE scores: ${verdict.missing.join(", ")}`);
	}
	if (verdict.unknown.length > 0) {
		problems.push(`Unknown CASE scores: ${verdict.unknown.join(", ")}`);
	}
	if (verdict.duplicates && verdict.duplicates.length > 0) {
		problems.push(`Duplicate CASE scores: ${verdict.duplicates.join(", ")}`);
	}
	if (verdict.invalid && verdict.invalid.length > 0) {
		problems.push(...verdict.invalid.map((problem) => `Invalid: ${problem}`));
	}
	for (const row of tableRows) {
		if (row.passed) continue;
		if (!Number.isFinite(row.score) || row.score < 0 || row.score > 100) continue;
		if (!Number.isFinite(row.threshold) || row.threshold < 0 || row.threshold > 100) continue;
		if (row.score >= row.threshold) continue;
		problems.push(`${row.caseId}: score ${row.scoreText} is below threshold ${row.threshold}`);
	}

	return [
		"# 手工测试报告",
		"",
		`- Goal: ${goal.id}`,
		`- Auditor: ${payload.auditorId ?? "unknown"}`,
		`- Model: ${model ?? "unknown"}`,
		`- Generated: ${new Date().toISOString()}`,
		"",
		payload.report_markdown.trim(),
		"",
		"## 分数与阈值",
		"",
		"| CASE | User | Developer | Final | Threshold | Result |",
		"| --- | ---: | ---: | ---: | ---: | --- |",
		...tableRows.map(
			(row) =>
				`| ${row.caseId} | ${row.userScoreText} | ${row.developerScoreText} | ${row.scoreText} | ${row.threshold} | ${row.passed ? "PASS" : "FAIL"} |`,
		),
		...(problems.length > 0 ? ["", "## 问题", "", ...problems.map((problem) => `- ${problem}`)] : []),
		"",
		`## 总判定: ${verdict.passed ? "PASS" : "FAIL"}`,
		"",
	].join("\n");
}

export function writeManualReport(cwd, goal, report) {
	if (!report.trim()) throw new Error("manual acceptance report is empty");
	const embeddedContract = manualAcceptanceContractLine(goal.objective ?? "");
	const contract = parseManualContract(
		embeddedContract
			? goal.objective
			: (manualAcceptanceEffectiveContract(goal) ?? goal.objective),
	);
	if (!contract) {
		throw new Error("manual acceptance report: the goal has no valid manual acceptance contract");
	}
	const dir = manualAcceptanceDir(cwd, contract.slug);
	const relativePath = manualAcceptanceRelativePath(contract.slug, MANUAL_ACCEPTANCE_REPORT_FILE);
	try {
		writeFileAtomic(dir, MANUAL_ACCEPTANCE_REPORT_FILE, report);
	} catch (error) {
		throw new Error(manualAcceptanceWriteErrorText(relativePath, error));
	}
	return relativePath;
}
