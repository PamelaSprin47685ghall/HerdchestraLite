/**
 * The visible manual acceptance auditor.
 *
 * Inputs: the goal core (unused, kept for the pi-goal-x hook signature) and the
 * auditor arguments goal-x supplies (`ctx`, `goal`, and an optional parent
 * signal).
 * Output: one `GoalAuditorResult`; the report file is written before approval
 * is returned.
 *
 * The audit is one visible subagent run. Only one run per goal may be active:
 * starting another aborts the previous one through its own controller. The
 * 60-minute timeout, the parent signal, and that controller are merged into a
 * single signal for the subagent. Documents are validated before the prompt is
 * built and revalidated after the subagent exits, because the yield describes
 * the documents that existed during the run.
 *
 * Every disapproved string and the visibility warning are copied verbatim from
 * the old `vibe-workers.ts` implementation. Do not reflow them.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { bundledAgents, settingsScope } from "../host/capabilities.mjs";
import { runAuditSubprocess } from "../host/subprocess.mjs";
import { buildManualAcceptancePrompt } from "../prompts/auditor.mjs";
import { errorCode, messageOf } from "../util/errors.mjs";
import { MANUAL_REPORT_SCHEMA } from "./constants.mjs";
import { manualAcceptanceContractLine, validateManualDocuments } from "./contract.mjs";
import { buildReport, writeManualReport } from "./report.mjs";
import { parseRequirementCases } from "./requirements.mjs";
import { verdictFromScores } from "./scores.mjs";

/**
 * One AbortController per active goal audit. The map is intentionally never
 * pruned: a completed audit keeps its controller until a newer audit for the
 * same goal replaces it, matching the old implementation's known limitation.
 *
 * @type {Map<string, AbortController>}
 */
const activeManualAcceptanceAudits = new Map();

/**
 * Format a system error code the way the old auditor did.
 *
 * @param {unknown} error
 * @returns {string}
 */
function manualAcceptanceErrorCode(error) {
	const code = errorCode(error);
	return code === undefined ? "" : ` (${code})`;
}

/**
 * Build the synthetic objective used by the document validator.
 *
 * goal-x strips the single contract line from `objective`, so the goal's
 * `verificationContract` is reattached for validation. An embedded line wins
 * over the extracted value; a blank extracted contract is not reattached.
 *
 * @param {{ objective?: string, verificationContract?: string }} goal
 * @returns {string}
 */
function syntheticObjective(goal) {
	const contractLine = goal.verificationContract?.trim();
	const objective = goal.objective?.trim() ?? "";
	const embeddedContract = manualAcceptanceContractLine(objective);
	if (embeddedContract) return objective;
	return contractLine ? `${objective}${objective ? "\n\n" : ""}Verification contract: ${contractLine}` : objective;
}

/**
 * Run one visible manual acceptance audit.
 *
 * @param {unknown} core Kept for the pi-goal-x completion-auditor signature.
 * @param {{ ctx: any, goal: any, signal?: AbortSignal }} args
 * @returns {Promise<{ approved: boolean, disapproved: boolean, output: string, model?: string, error?: string }>}
 */
export async function runVisibleManualAcceptanceAuditor(core, args) {
	void core;
	/**
	 * @param {string} message
	 * @returns {{ approved: false, disapproved: true, output: string, error: string }}
	 */
	const disapproved = (message) => ({
		approved: false,
		disapproved: true,
		output: message,
		error: message,
	});

	const goal = args.goal;
	const previousAudit = activeManualAcceptanceAudits.get(goal.id);
	previousAudit?.abort("A newer manual acceptance audit replaced this run.");
	const auditController = new AbortController();
	activeManualAcceptanceAudits.set(goal.id, auditController);
	const timeoutSignal = AbortSignal.timeout(60 * 60 * 1000);
	const auditSignal = AbortSignal.any(
		[args.signal, timeoutSignal, auditController.signal].filter((signal) => signal !== undefined),
	);
	/**
	 * @returns {{ approved: false, disapproved: true, output: string, error: string }}
	 */
	const abortedResult = () =>
		timeoutSignal.aborted
			? disapproved("manual acceptance auditor timed out after 60 minutes")
			: disapproved("manual acceptance auditor was aborted before completion");

	if (auditSignal.aborted) return abortedResult();

	const objective = syntheticObjective(goal);
	/** @type {{ ok: true, docs: any } | { ok: false, error: string }} */
	let docsResult;
	try {
		docsResult = validateManualDocuments(args.ctx.cwd, objective);
	} catch (error) {
		return disapproved(`manual acceptance document validation failed: ${messageOf(error)}`);
	}
	if (!docsResult.ok) {
		return disapproved(`manual acceptance documents are invalid: ${docsResult.error}`);
	}
	const docs = docsResult.docs;
	const prompt = buildManualAcceptancePrompt(goal, docs);

	const taskAgent = bundledAgents()?.find((candidate) => candidate.name === "task");
	if (!taskAgent) {
		return disapproved("manual acceptance auditor could not start: the bundled task agent is unavailable");
	}
	// Clone the bundled agent so the audit is read-only apart from shell access.
	// Clear `spawns` too: the executor auto-adds `task` whenever spawns is set.
	const agent = {
		...taskAgent,
		// 18.18.6 derives the AgentRegistry display name from agent.name.
		name: "Manual acceptance auditor",
		tools: ["read", "search", "find", "bash"],
		spawns: undefined,
	};

	const sessionFile = args.ctx.sessionManager.getSessionFile();
	const artifactsDir =
		args.ctx.sessionManager.getArtifactsDir?.() ??
		(sessionFile?.endsWith(".jsonl") ? sessionFile.slice(0, -6) : undefined);
	// `artifactsDir` is the only executor switch that persists the subagent
	// transcript. Keep the run visible in Agent Hub either way, and surface the
	// in-memory limitation instead of failing the audit.
	const visibilityNote = artifactsDir
		? undefined
		: "Visibility warning: the parent session has no artifacts directory; the auditor transcript is in-memory only and may not be reachable through history://. Agent Hub registry visibility still applies.";

	if (artifactsDir) {
		try {
			mkdirSync(artifactsDir, { recursive: true });
		} catch (error) {
			return disapproved(
				`manual acceptance auditor artifacts directory could not be created${manualAcceptanceErrorCode(error)}`,
			);
		}
	}

	const safeGoalId = goal.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "goal";
	const auditorId = `ManualAcceptance-${safeGoalId}-${randomUUID()}`;
	const overrideModel = args.ctx.model ? `${args.ctx.model.provider}/${args.ctx.model.id}` : undefined;
	// The completion-auditor hook receives no ExtensionAPI, so probe the
	// context (in case the host exposes scoped settings on it) and otherwise
	// fall back to `Settings.instance`, exactly like the old try/catch.
	const settings = settingsScope(args.ctx);

	if (auditSignal.aborted) return abortedResult();
	const started = await (async () => {
		try {
			return {
				ok: true,
				result: await runAuditSubprocess({
					cwd: args.ctx.cwd,
					agent,
					task: prompt,
					assignment: prompt,
					description: "Manual acceptance audit",
					index: 0,
					id: auditorId,
					taskDepth: 0,
					outputSchema: MANUAL_REPORT_SCHEMA,
					modelOverride: overrideModel,
					parentActiveModelPattern: overrideModel,
					modelRegistry: args.ctx.modelRegistry,
					...(settings ? { settings } : {}),
					signal: auditSignal,
					sessionFile,
					artifactsDir,
					persistArtifacts: true,
				}),
			};
		} catch (error) {
			return { ok: false, error };
		}
	})();
	if (!started.ok) {
		return disapproved(`manual acceptance auditor failed to start: ${messageOf(started.error)}`);
	}
	const result = started.result;

	if (result.aborted || auditSignal.aborted) {
		if (timeoutSignal.aborted) {
			return disapproved("manual acceptance auditor timed out after 60 minutes");
		}
		const reason = result.abortReason ?? result.error ?? result.stderr ?? "cancelled";
		return disapproved(`manual acceptance auditor was aborted: ${reason}`);
	}
	if (result.exitCode !== 0 || result.error) {
		const detail = result.error ?? result.stderr ?? `exit code ${result.exitCode}`;
		return disapproved(`manual acceptance auditor failed: ${detail}`);
	}

	// Documents are the source of truth. If they changed or disappeared while
	// the auditor ran, the report and scores no longer describe this repo.
	/** @type {{ ok: true, docs: any } | { ok: false, error: string }} */
	let afterDocsResult;
	try {
		afterDocsResult = validateManualDocuments(args.ctx.cwd, objective);
	} catch (error) {
		return disapproved(`manual acceptance document revalidation failed: ${messageOf(error)}`);
	}
	if (!afterDocsResult.ok) {
		return disapproved(
			`manual acceptance documents changed or became invalid during the audit: ${afterDocsResult.error}`,
		);
	}

	// Prefer the structured yield payload: it is already parsed and validated.
	// Fall back to the full output artifact, then to a non-truncated preview.
	const extractedYield = result.extractedToolData?.yield;
	const yieldEntries = Array.isArray(extractedYield) ? extractedYield : undefined;
	const lastYield = yieldEntries?.[yieldEntries.length - 1];
	if (lastYield?.schemaOverridden === true) {
		return disapproved("manual acceptance auditor yield schema was overridden; refusing the result");
	}
	let parsed;
	if (lastYield?.status === "success" && lastYield.data != null) {
		parsed = lastYield.data;
	} else if (result.outputPath) {
		let outputText;
		try {
			outputText = readFileSync(result.outputPath, "utf8");
		} catch (error) {
			return disapproved(`manual acceptance auditor full output could not be read${manualAcceptanceErrorCode(error)}`);
		}
		try {
			parsed = JSON.parse(outputText);
		} catch {
			return disapproved("manual acceptance auditor full output could not be parsed");
		}
	} else if (!result.truncated) {
		try {
			parsed = JSON.parse(result.output);
		} catch {
			return disapproved("manual acceptance auditor returned non-JSON yield output");
		}
	} else {
		return disapproved("manual acceptance auditor output was truncated and no full output file exists");
	}

	/**
	 * @param {unknown} value
	 * @returns {{ ok: true, payload: { report_markdown: string, scores: unknown[] } } | { ok: false, error: string }}
	 */
	const checkPayload = (value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false, error: "yield output is not a JSON object" };
		}
		const record = value;
		if (typeof record.report_markdown !== "string" || !record.report_markdown.trim()) {
			return { ok: false, error: "yield output has no non-empty report_markdown" };
		}
		if (!Array.isArray(record.scores) || record.scores.length === 0) {
			return { ok: false, error: "yield output has no non-empty scores array" };
		}
		return {
			ok: true,
			payload: { report_markdown: record.report_markdown, scores: record.scores },
		};
	};
	const payloadCheck = checkPayload(parsed);
	if (!payloadCheck.ok) {
		return disapproved(`manual acceptance auditor returned an invalid report: ${payloadCheck.error}`);
	}
	const payload = payloadCheck.payload;

	let requirements;
	try {
		requirements = parseRequirementCases(docs.requirementsMarkdown);
	} catch (error) {
		return disapproved(`requirements.md could not be parsed: ${messageOf(error)}`);
	}
	if (requirements.length === 0) {
		return disapproved("requirements.md has no CASE headings with PASS thresholds");
	}

	const verdict = verdictFromScores(requirements, payload.scores);
	const model = result.resolvedModel ?? overrideModel;
	const tableRows = verdict.rows.map((row) => ({
		...row,
		userScoreText: Number.isFinite(row.userScore) ? String(row.userScore) : "invalid",
		developerScoreText: Number.isFinite(row.developerScore) ? String(row.developerScore) : "invalid",
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

	const report = buildReport(goal, { ...payload, auditorId: result.id }, verdict, model);

	if (auditSignal.aborted) return abortedResult();
	/** @type {string} */
	let reportPath;
	try {
		reportPath = writeManualReport(args.ctx.cwd, goal, report);
	} catch (error) {
		return disapproved(`manual acceptance report could not be written: ${messageOf(error)}`);
	}
	if (verdict.passed && auditSignal.aborted) return abortedResult();

	const summary = verdict.passed
		? `Manual acceptance PASSED: ${verdict.rows.length} CASE(s) met their thresholds. Report: ${reportPath}`
		: [`Manual acceptance FAILED. Report: ${reportPath}`, ...problems.map((problem) => `- ${problem}`)].join("\n");
	const output = [report, summary, visibilityNote].filter(Boolean).join("\n\n");

	return {
		approved: verdict.passed,
		disapproved: !verdict.passed,
		output,
		model,
		error: undefined,
	};
}
