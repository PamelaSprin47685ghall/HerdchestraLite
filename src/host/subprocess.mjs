/**
 * Manual acceptance audit execution.
 *
 * This module owns exactly one job: call the host subagent executor with the
 * old `runSubprocess` argument set and return its result unchanged. Agent
 * selection, agent cloning, prompt building, settings probing, document
 * validation, and yield parsing all stay with the auditor caller.
 */

import { runSubprocess } from "./imports.mjs";

/**
 * Options for one manual acceptance audit run.
 *
 * Names match the `runSubprocess` call in VW 1455-1478 and S2 §9.5.6 item 7.
 *
 * @typedef {object} AuditSubprocessOptions
 * @property {string} cwd
 * @property {unknown} agent
 * @property {string} task
 * @property {string} [assignment]
 * @property {string} [description]
 * @property {number} [index]
 * @property {string} id
 * @property {number} [taskDepth]
 * @property {unknown} [outputSchema]
 * @property {string | string[]} [modelOverride]
 * @property {string} [parentActiveModelPattern]
 * @property {unknown} [modelRegistry]
 * @property {unknown} [settings]
 * @property {AbortSignal} [signal]
 * @property {string | null} [sessionFile]
 * @property {string} [artifactsDir]
 * @property {boolean} [persistArtifacts]
 */

/**
 * The executor fields the auditor reads. The wrapper does not reshape them.
 *
 * @typedef {object} AuditSubprocessResult
 * @property {boolean} [aborted]
 * @property {string} [abortReason]
 * @property {number} [exitCode]
 * @property {string} [error]
 * @property {string} [stderr]
 * @property {Record<string, unknown[]>} [extractedToolData]
 * @property {string} [outputPath]
 * @property {string} [output]
 * @property {boolean} [truncated]
 * @property {string} [resolvedModel]
 * @property {string} [id]
 */

/**
 * Run the manual acceptance auditor through the host subagent executor.
 *
 * Only undefined fields are defaulted; explicit caller values always win.
 * `settings` is forwarded only when truthy, matching the old call.
 *
 * @param {AuditSubprocessOptions} options
 * @returns {Promise<AuditSubprocessResult>}
 */
export function runAuditSubprocess(options) {
	return runSubprocess({
		cwd: options.cwd,
		agent: options.agent,
		task: options.task,
		assignment: options.assignment ?? options.task,
		description: options.description ?? "Manual acceptance audit",
		index: options.index ?? 0,
		id: options.id,
		taskDepth: options.taskDepth ?? 0,
		outputSchema: options.outputSchema,
		modelOverride: options.modelOverride,
		parentActiveModelPattern: options.parentActiveModelPattern ?? options.modelOverride,
		modelRegistry: options.modelRegistry,
		...(options.settings ? { settings: options.settings } : {}),
		signal: options.signal,
		sessionFile: options.sessionFile,
		artifactsDir: options.artifactsDir,
		persistArtifacts: options.persistArtifacts ?? true,
	});
}
