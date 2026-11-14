/**
 * Subagent execution boundary.
 *
 * This module owns exactly one job: turn a Herdchestra role request into a
 * complete host `AgentDefinition` plus `runSubprocess` options, execute it, and
 * classify the result without hiding failures.
 *
 * It builds the agent definition itself instead of asking the host for a
 * bundled agent by name. It never edits host prototypes, never reads private
 * fields, and never falls back to another model, engine, or tool surface.
 *
 * Missing capability is an error, not a warning:
 * - no live `Settings`        -> `:SETTINGS_UNAVAILABLE`
 * - no model registry         -> `:HOST_API_MISMATCH`
 * - no required artifacts     -> `:HOST_API_MISMATCH`
 * - no required EventBus      -> `:HOST_API_MISMATCH`
 * - no `hasCtxAgent`           -> `:CAPABILITY_DENIED`
 * - no `hasSetActiveTools`    -> `:CAPABILITY_DENIED`
 * - no preloaded extension paths or explicit discovery opt-in -> `:CAPABILITY_DENIED`
 * - unauthorized model fallback -> `:MODEL_FALLBACK`
 *
 * Installed host source (17.3.5) conflict, verified in `sdk.ts` and
 * `task/executor.ts`: setting
 * `restrictToolNames: true` makes the child load **no extensions at all**
 * (`loadExtensions([], ...)`). A Manual Auditor would therefore lose
 * `clj_auditor`. This module must keep `restrictToolNames: false` so the parent
 * extension can be preloaded, and it reports `toolNarrowingRequired: true`.
 * The child session's `before_agent_start` role guard must call
 * `setActiveTools` with the role's exact list to remove the host-added `hub`
 * tool and any other extension tools. `agent.tools` still filters built-ins.
 *
 * Parent-session linkage: 18.16 `runSubprocess` forwards `sessionFile` as the
 * child `SessionHeader.parentSession` when `artifactsDir` is present (17.3.5
 * ignored it). H1 passes a caller-supplied value through unchanged and does not
 * pre-validate it (the host owns failure handling). Without `artifactsDir` the
 * child is memory-only: it still runs and the visibilityNote says so; the
 * parentSessionNote records that no header is written.
 * The child transcript is `<artifactsDir>/<id>.jsonl` and the output is
 * `<artifactsDir>/<id>.md`.
 */

import { randomUUID } from "node:crypto";
import { access, mkdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { herdError, isHerdError, messageOf } from "../util/errors.mjs";
import { host } from "./imports.mjs";

/**
 * Model attribution and tool restriction per role.
 *
 * `main` roles pin the parent model explicitly. `task` roles use the user's
 * `@task` configuration. Herdchestra has no role that may spawn another
 * subagent, so `spawns` stays undefined everywhere.
 */
export const ROLE_MODEL_POLICY = Object.freeze({
	Coordinator: Object.freeze({ modelSource: "main", spawnable: false }),
	Plan: Object.freeze({ modelSource: "main", spawnable: false }),
	"Plan DevOps": Object.freeze({ modelSource: "task", spawnable: true }),
	Reviewer: Object.freeze({ modelSource: "main", spawnable: true }),
	"Swarm Worker": Object.freeze({ modelSource: "task", spawnable: true }),
	"Swarm Holder": Object.freeze({ modelSource: "task", spawnable: true }),
	"Manual Auditor": Object.freeze({ modelSource: "main", spawnable: true }),
});

/**
 * Host tools a sandboxed subagent must never receive.
 *
 * Sandbox roles act through `clj_*` tools. Giving them a host filesystem or
 * execution tool would bypass the VFS, the write lock, and the role matrix.
 * This list is the local hard boundary: the host filters built-ins through
 * `agent.tools`, and the child role guard narrows extension tools later.
 */
export const FORBIDDEN_HOST_TOOLS = Object.freeze([
	"ask_user",
	"bash",
	"edit",
	"eval",
	"exec",
	"glob",
	"goal",
	"grep",
	"hub",
	"python",
	"read",
	"task",
	"write",
]);

const ROLE_NAMES = Object.freeze(Object.keys(ROLE_MODEL_POLICY));
const ROLE_TOKEN = /^\[HERD_ROLE: ([A-Za-z][A-Za-z0-9 _-]*) nonce=([A-Za-z0-9_-]{8,128})\]$/;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,79}$/;
const TOOL_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: identifiers must not carry terminal control bytes.
const CONTROL_CHARACTER = /[\r\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const EMPTY_ARTIFACTS = Object.freeze({
	dir: undefined,
	sessionFile: undefined,
	outputPath: undefined,
	persisted: false,
});

const AGENT_SOURCES = new Set(["bundled", "user", "project"]);

/**
 * One classified subagent outcome.
 *
 * `ok: false` is not an exception: the error is a Herdchestra error with a
 * registered code. `result` is always the host's raw result when the executor
 * returned one, so a caller can inspect a rejected fallback or a truncated run
 * without losing evidence.
 *
 * @typedef {object} SpawnOutcome
 * @property {boolean} ok
 * @property {string | null} agentId
 * @property {string | null} role
 * @property {string | null} roleNonce
 * @property {string[]} modelPatterns
 * @property {string | undefined} parentActiveModelPattern
 * @property {unknown} result
 * @property {object | null} handle
 * @property {object | null} agentDefinition
 * @property {(reason?: unknown) => { aborted: boolean, agentIds: string[] }} abort
 * @property {boolean} memoryOnly
 * @property {"hub" | "transcript" | "memory"} visibility
 * @property {string | undefined} visibilityNote
 * @property {{ dir?: string, sessionFile?: string, outputPath?: string, persisted: boolean }} artifacts
 * @property {string | null} parentAgentId
 * @property {string | null} parentToolCallId
 * @property {"registry" | "hub" | "none"} agentLineage
 * @property {"options" | "instance" | "instance-fallback"} settingsSource
 * @property {string | null} parentSessionFile
 * @property {string} parentSessionNote
 * @property {boolean} eventBus
 * @property {boolean} toolNarrowingRequired
 * @property {boolean} hubAutoAdded
 * @property {"preloaded" | "discovery" | "none"} extensionSource
 * @property {boolean} truncated
 * @property {string | undefined} resolvedModel
 * @property {boolean} resolvedModelIsFallback
 * @property {Error | undefined} error
 */

/** @param {unknown} value */
function isObjectLike(value) {
	return value !== null && (typeof value === "object" || typeof value === "function");
}

/** @param {unknown} value */
function isPlainObject(value) {
	if (!isObjectLike(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Fail closed with a registered Herdchestra error code.
 *
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} data
 */
function fail(code, message, data) {
	return herdError(code, message, data);
}

/**
 * Build the first-line role token read by the parent-side role guard.
 *
 * Inputs: a role from `ROLE_MODEL_POLICY` and a parent-generated nonce.
 * Output: `[HERD_ROLE: <role> nonce=<nonce>]`.
 * Invalid roles or nonces throw `:INVALID_ARGUMENT`; there is no default role.
 *
 * @param {string} role
 * @param {string} nonce
 */
export function roleToken(role, nonce) {
	if (typeof role !== "string" || !Object.hasOwn(ROLE_MODEL_POLICY, role)) {
		throw fail(":CAPABILITY_DENIED", "unknown Herdchestra role", {
			role: String(role),
			expected: ROLE_NAMES,
		});
	}
	if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) {
		throw fail(":INVALID_ARGUMENT", "role nonce must be 8-128 URL-safe characters", {
			actual: typeof nonce === "string" ? `${nonce.length} characters` : typeof nonce,
			expected: "8-128 characters from A-Z, a-z, 0-9, _ and -",
		});
	}
	return `[HERD_ROLE: ${role} nonce=${nonce}]`;
}

/**
 * Read a role token from the first line of a subagent prompt.
 *
 * Inputs: any text, usually the task or assignment.
 * Output: `{ role, nonce, token }`, or `undefined` when the first line is not a
 * token naming a known role. The parser does not trim indentation; a token must
 * start at column zero.
 *
 * @param {unknown} text
 * @returns {{ role: string, nonce: string, token: string } | undefined}
 */
export function readRoleToken(text) {
	if (typeof text !== "string") return undefined;
	const firstLine = text.split(/\r?\n/, 1)[0];
	const match = ROLE_TOKEN.exec(firstLine);
	if (match === null) return undefined;
	const [, role, nonce] = match;
	if (!Object.hasOwn(ROLE_MODEL_POLICY, role)) return undefined;
	return Object.freeze({ role, nonce, token: firstLine });
}

/** @param {string} value */
function optionalText(value, field, { allowEmpty = false } = {}) {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw fail(":INVALID_ARGUMENT", `${field} must be a string`, { field, actual: typeof value });
	}
	if (!allowEmpty && value.length === 0) {
		throw fail(":INVALID_ARGUMENT", `${field} must not be empty`, { field });
	}
	if (CONTROL_CHARACTER.test(value)) {
		throw fail(":INVALID_ARGUMENT", `${field} must not contain control characters`, { field });
	}
	return value;
}

/** @param {unknown} value */
function normalizeModelList(value) {
	let candidate = value;
	if (isObjectLike(candidate) && typeof candidate.provider === "string" && typeof candidate.id === "string") {
		candidate = `${candidate.provider}/${candidate.id}`;
	}
	const list = typeof candidate === "string" ? [candidate] : candidate;
	if (!Array.isArray(list) || list.length === 0) {
		throw fail(":INVALID_ARGUMENT", "model must be a non-empty string or string array", {
			actual: typeof value,
		});
	}
	const seen = new Set();
	for (const pattern of list) {
		if (typeof pattern !== "string" || pattern.length === 0) {
			throw fail(":INVALID_ARGUMENT", "model patterns must be non-empty strings", {
				actual: String(pattern),
			});
		}
		if (pattern.trim() !== pattern || CONTROL_CHARACTER.test(pattern)) {
			throw fail(":INVALID_ARGUMENT", "model patterns must be exact and free of control characters", {
				actual: pattern,
			});
		}
		if (seen.has(pattern)) {
			throw fail(":INVALID_ARGUMENT", "model patterns must be unique", { actual: pattern });
		}
		seen.add(pattern);
	}
	return [...list];
}

/** @param {string} pattern */
function isTaskAlias(pattern) {
	return pattern === "@task" || pattern.startsWith("@task:");
}

/** @param {unknown} value */
function normalizeTools(value) {
	if (!Array.isArray(value) || value.length === 0) {
		throw fail(":INVALID_ARGUMENT", "tools must be a non-empty array of host tool names", {
			actual: typeof value,
		});
	}
	const tools = [];
	const seen = new Set();
	for (const tool of value) {
		if (typeof tool !== "string" || !TOOL_PATTERN.test(tool) || CONTROL_CHARACTER.test(tool)) {
			throw fail(":INVALID_ARGUMENT", "tool names must be host identifiers", { actual: String(tool) });
		}
		if (FORBIDDEN_HOST_TOOLS.includes(tool)) {
			throw fail(":CAPABILITY_DENIED", "sandboxed subagent may not receive a host filesystem or execution tool", {
				tool,
				next: "use the role's clj_* sandbox tool instead",
			});
		}
		if (tool.startsWith("mcp__") || tool.startsWith("mcp:") || tool.startsWith("lsp_") || tool.startsWith("irc_")) {
			throw fail(":CAPABILITY_DENIED", "sandboxed subagent may not receive a discovered host capability", {
				tool,
				next: "MCP, LSP, and IRC are disabled for subagents",
			});
		}
		if (seen.has(tool)) {
			throw fail(":INVALID_ARGUMENT", "tool names must be unique", { tool });
		}
		seen.add(tool);
		tools.push(tool);
	}
	// `yield` is the host's structured-completion channel. Every subagent needs
	// it even when the caller built its tool list from a role matrix.
	if (!seen.has("yield")) tools.push("yield");
	return tools;
}

/** @param {unknown} value @param {string} field */
function nonNegativeInteger(value, field) {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value < 0) {
		throw fail(":INVALID_ARGUMENT", `${field} must be a non-negative integer`, {
			field,
			actual: value,
		});
	}
	return value;
}

/** @param {unknown} value @param {string} field */
function absolutePath(value, field) {
	if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
		throw fail(":INVALID_ARGUMENT", `${field} must be an absolute path`, {
			field,
			actual: String(value),
		});
	}
	if (CONTROL_CHARACTER.test(value)) {
		throw fail(":INVALID_ARGUMENT", `${field} must not contain control characters`, { field });
	}
	return value;
}

/**
 * Validate an optional list of absolute source paths.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {string[] | undefined}
 */
async function pathList(value, field) {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0) {
		throw fail(":INVALID_ARGUMENT", `${field} must be a non-empty array of absolute paths`, {
			field,
			actual: typeof value,
		});
	}
	const seen = new Set();
	for (const item of value) {
		const path = absolutePath(item, field);
		if (seen.has(path)) {
			throw fail(":INVALID_ARGUMENT", `${field} entries must be unique`, { field, path });
		}
		let usable = false;
		let cause;
		try {
			await access(path);
			usable = (await stat(path)).isFile();
		} catch (error) {
			cause = error;
		}
		if (!usable) {
			throw fail(":INVALID_ARGUMENT", `${field} entry must be an existing file`, {
				field,
				path,
				cause: cause === undefined ? undefined : messageOf(cause),
			});
		}
		seen.add(path);
	}
	return [...value];
}

/** @param {unknown} value */
function isAbortSignal(value) {
	return isObjectLike(value) && typeof value.aborted === "boolean" && typeof value.addEventListener === "function";
}

/** @param {unknown} value */
function isEventBus(value) {
	return isObjectLike(value) && typeof value.emit === "function" && typeof value.on === "function";
}

/** @param {unknown} value */
function isLiveSettings(value) {
	try {
		return isObjectLike(value) && typeof value.getStorage === "function" && typeof value.getModelRoles === "function";
	} catch {
		return false;
	}
}

/**
 * Name the parts of the Settings shape that are missing.
 *
 * `pi.getSettings` is not part of the public ExtensionAPI; callers must pass
 * the live `pi.pi.settings` proxy or omit `settings` so this module can use
 * `Settings.instance`. In 18.x the Settings read surface is descriptor-based
 * (`setting.get(settings)`); `Settings` itself no longer exposes `.get(path)`.
 * The diagnostic makes a wrong source obvious.
 *
 * @param {unknown} value
 */
function missingSettingsMethods(value) {
	if (!isObjectLike(value)) return ["getStorage", "getModelRoles"];
	return ["getStorage", "getModelRoles"].filter((name) => {
		try {
			return typeof value[name] !== "function";
		} catch {
			return true;
		}
	});
}

/** @param {unknown} value */
function isModelRegistry(value) {
	return (
		isObjectLike(value) &&
		isObjectLike(value.authStorage) &&
		typeof value.hasConfiguredAuth === "function" &&
		typeof value.getApiKey === "function"
	);
}

/**
 * Validate a complete AgentDefinition for a follow-up turn.
 *
 * The same definition used by the first run is required; a name or a partial
 * patch is not enough because the host uses it for progress labels and
 * finalization.
 *
 * @param {unknown} value
 */
function validateAgentDefinition(value) {
	if (!isPlainObject(value)) {
		throw fail(":INVALID_ARGUMENT", "continueAgent requires a complete AgentDefinition", {
			actual: typeof value,
		});
	}
	if (typeof value.name !== "string" || !NAME_PATTERN.test(value.name)) {
		throw fail(":INVALID_ARGUMENT", "AgentDefinition.name is invalid", { actual: String(value.name) });
	}
	if (typeof value.description !== "string" || value.description.length === 0) {
		throw fail(":INVALID_ARGUMENT", "AgentDefinition.description is required", { field: "description" });
	}
	if (typeof value.systemPrompt !== "string" || value.systemPrompt.length === 0) {
		throw fail(":INVALID_ARGUMENT", "AgentDefinition.systemPrompt is required", { field: "systemPrompt" });
	}
	if (typeof value.source !== "string" || !AGENT_SOURCES.has(value.source)) {
		throw fail(":INVALID_ARGUMENT", "AgentDefinition.source must be bundled, user, or project", {
			actual: String(value.source),
		});
	}
	if (value.tools !== undefined) {
		if (!Array.isArray(value.tools) || value.tools.some((tool) => typeof tool !== "string")) {
			throw fail(":INVALID_ARGUMENT", "AgentDefinition.tools must be a string array", {});
		}
	}
	if (value.model !== undefined) {
		if (!Array.isArray(value.model) || value.model.some((pattern) => typeof pattern !== "string")) {
			throw fail(":INVALID_ARGUMENT", "AgentDefinition.model must be a string array", {});
		}
	}
}

/** @param {unknown} value */
function asHandle(value) {
	const candidate = isObjectLike(value) && isObjectLike(value.handle) ? value.handle : value;
	if (!isObjectLike(candidate)) return undefined;
	if (!(candidate.controller instanceof AbortController)) return undefined;
	if (!(candidate.children instanceof Set)) return undefined;
	if (typeof candidate.agentId !== "string") return undefined;
	return candidate;
}

/** @param {unknown} reason */
function reasonText(reason) {
	if (reason === undefined || reason === null) return "aborted";
	if (typeof reason === "string") return reason;
	if (reason instanceof Error) return reason.message;
	try {
		const json = JSON.stringify(reason);
		return typeof json === "string" ? json : String(reason);
	} catch {
		return String(reason);
	}
}

/**
 * Decide whether a role may use a model, and which patterns to pass.
 *
 * Main roles must pin a concrete model (or a non-`@task` role alias). Task
 * roles use `@task` and may not inherit the parent model as an auth fallback.
 *
 * @param {string} role
 * @param {unknown} requestedModel
 */
function resolveModelSelection(role, requestedModel) {
	const policy = ROLE_MODEL_POLICY[role];
	const patterns =
		requestedModel === undefined
			? policy.modelSource === "task"
				? ["@task"]
				: undefined
			: normalizeModelList(requestedModel);

	if (patterns === undefined) {
		throw fail(":CAPABILITY_DENIED", "main roles must pin the parent model explicitly", {
			role,
			expected: "a concrete provider/model pattern or a non-@task role alias",
			next: "pass model from the parent ctx.model and modelRegistry",
		});
	}

	if (policy.modelSource === "main" && patterns.some(isTaskAlias)) {
		throw fail(":CAPABILITY_DENIED", "a main-model role may not run on the @task model", {
			role,
			model: patterns,
			next: "pin the model used by the main session",
		});
	}
	if (policy.modelSource === "task" && !patterns.some(isTaskAlias)) {
		throw fail(":CAPABILITY_DENIED", "a @task role must resolve through the @task model", {
			role,
			model: patterns,
			next: "use the configured @task model; do not silently run construction on the main model",
		});
	}
	return patterns;
}

/**
 * Plan one subagent spawn without executing it.
 *
 * Inputs: the role request and ports `{ agentId?, Settings?, now? }`.
 * Output: `{ ok: true, request, meta }` or `{ ok: false, error, meta }`.
 *
 * This function builds the complete `AgentDefinition`, prepends the role token,
 * validates model attribution, resolves the live settings instance, prepares
 * the artifacts directory, and fixes every capability boundary. It performs no
 * model call and starts no process. Its only side effect is creating
 * `artifactsDir` when one is requested.
 *
 * @param {Record<string, unknown>} options
 * @param {{ agentId?: string, Settings?: unknown, now?: () => number }} [ports]
 */
export async function planSpawn(options, ports = {}) {
	const port = isObjectLike(ports) ? ports : {};
	const now = typeof port.now === "function" ? port.now : Date.now;
	/** @type {Record<string, unknown>} */
	const meta = {
		agentId: undefined,
		role: typeof options?.role === "string" ? options.role : undefined,
		roleNonce: undefined,
		modelPatterns: [],
		parentActiveModelPattern: undefined,
		memoryOnly: true,
		visibility: "memory",
		artifacts: EMPTY_ARTIFACTS,
		startedAt: undefined,
	};
	try {
		const agentId = port.agentId ?? randomUUID();
		meta.agentId = agentId;
		meta.startedAt = now();
		if (!isPlainObject(options)) {
			throw fail(":INVALID_ARGUMENT", "spawnAgent options must be a plain object", {
				actual: typeof options,
			});
		}
		if (typeof agentId !== "string" || !ID_PATTERN.test(agentId)) {
			throw fail(":INVALID_ARGUMENT", "agentId must be a URL-safe identifier", { actual: String(agentId) });
		}

		const role = options.role;
		if (typeof role !== "string" || !Object.hasOwn(ROLE_MODEL_POLICY, role)) {
			throw fail(":CAPABILITY_DENIED", "unknown Herdchestra role", {
				role: String(role),
				expected: ROLE_NAMES,
			});
		}
		const policy = ROLE_MODEL_POLICY[role];
		if (policy.spawnable === false) {
			throw fail(":CAPABILITY_DENIED", "this role runs in the main session and is not a subagent", {
				role,
				next: "spawn a role whose policy is spawnable",
			});
		}

		const name = options.name;
		if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
			throw fail(":INVALID_ARGUMENT", "agent name must be 1-80 URL-safe characters", {
				actual: String(name),
				expected: "a letter followed by letters, digits, dot, underscore or dash",
			});
		}
		meta.name = name;

		const systemPrompt = options.systemPrompt;
		if (typeof systemPrompt !== "string" || systemPrompt.length === 0) {
			throw fail(":INVALID_ARGUMENT", "systemPrompt must be a non-empty string", { field: "systemPrompt" });
		}

		const taskCandidate = options.task ?? options.prompt;
		if (options.task !== undefined && options.prompt !== undefined && options.task !== options.prompt) {
			throw fail(":INVALID_ARGUMENT", "task and prompt disagree; pass exactly one", { field: "task" });
		}
		const task = optionalText(taskCandidate, "task");
		if (task === undefined) {
			throw fail(":INVALID_ARGUMENT", "task is required", { field: "task" });
		}
		const assignment = optionalText(options.assignment, "assignment") ?? task;
		const description = optionalText(options.description, "description") ?? `${role}: ${name}`;

		const cwd = absolutePath(options.cwd, "cwd");

		const tools = normalizeTools(options.tools);

		const modelPatterns = resolveModelSelection(role, options.model);
		meta.modelPatterns = modelPatterns;

		let parentActiveModelPattern;
		if (policy.modelSource === "main") {
			if (options.parentActiveModelPattern === undefined) {
				parentActiveModelPattern = modelPatterns[0];
			} else {
				const parentPattern = optionalText(options.parentActiveModelPattern, "parentActiveModelPattern");
				if (parentPattern === undefined || parentPattern.trim() !== parentPattern) {
					throw fail(":INVALID_ARGUMENT", "parentActiveModelPattern must be one exact model pattern", {
						actual: String(options.parentActiveModelPattern),
					});
				}
				parentActiveModelPattern = parentPattern;
			}
			if (isTaskAlias(parentActiveModelPattern)) {
				throw fail(":CAPABILITY_DENIED", "parentActiveModelPattern may not be @task for a main-model role", {
					role,
					actual: parentActiveModelPattern,
				});
			}
		} else if (options.parentActiveModelPattern !== undefined) {
			throw fail(":CAPABILITY_DENIED", "@task roles may not fall back to the parent model", {
				role,
				actual: options.parentActiveModelPattern,
				next: "omit parentActiveModelPattern for construction roles",
			});
		}
		meta.parentActiveModelPattern = parentActiveModelPattern;

		const allowModelFallback = options.allowModelFallback;
		if (allowModelFallback !== undefined && typeof allowModelFallback !== "boolean") {
			throw fail(":INVALID_ARGUMENT", "allowModelFallback must be a boolean", {
				actual: typeof allowModelFallback,
			});
		}
		const keepAlive = options.keepAlive ?? true;
		if (typeof keepAlive !== "boolean") {
			throw fail(":INVALID_ARGUMENT", "keepAlive must be a boolean", {
				actual: typeof options.keepAlive,
			});
		}

		const Settings = Object.hasOwn(port, "Settings") ? port.Settings : host.Settings;
		if (typeof Settings !== "function" && !isObjectLike(Settings)) {
			throw fail(":HOST_API_MISMATCH", "host Settings is unavailable", {
				capability: "Settings",
				next: "load the plugin inside omp; do not substitute an isolated settings object",
			});
		}
		let settings = options.settings;
		let settingsSource = "options";
		if (settings === undefined) {
			try {
				settings = Settings.instance;
				settingsSource = "instance";
			} catch (cause) {
				throw fail(":SETTINGS_UNAVAILABLE", "host Settings is not initialized", {
					capability: "Settings.instance",
					cause: messageOf(cause),
					next: "start the plugin after the host has initialized Settings",
				});
			}
		} else if (!isLiveSettings(settings)) {
			// `pi.getSettings()` is not part of the public ExtensionAPI and may
			// return a plain facade. A facade is unusable by runSubprocess, so try
			// the live host singleton before failing. An isolated Settings still
			// has the full shape and is never silently replaced.
			let fallback;
			try {
				fallback = Settings.instance;
			} catch {
				fallback = undefined;
			}
			if (isLiveSettings(fallback)) {
				settings = fallback;
				settingsSource = "instance-fallback";
			}
		}
		if (!isLiveSettings(settings)) {
			throw fail(":SETTINGS_UNAVAILABLE", "a live Settings instance is required", {
				actual: typeof options.settings,
				missing: missingSettingsMethods(options.settings),
				settingsSource,
				next: "pass pi.pi.settings (the live host Settings proxy) or omit settings so H1 uses Settings.instance; Settings.isolated() loses @task configuration",
			});
		}
		meta.settingsSource = settingsSource;
		try {
			// A shape check can pass while the instance is already disposed.
			settings.getStorage();
			settings.getModelRoles();
		} catch (cause) {
			throw fail(":SETTINGS_UNAVAILABLE", "host Settings instance is not usable", {
				cause: messageOf(cause),
			});
		}

		if (!isModelRegistry(options.modelRegistry)) {
			throw fail(":HOST_API_MISMATCH", "parent ModelRegistry is required", {
				capability: "modelRegistry",
				next: "pass ctx.modelRegistry so @task roles and auth fallback resolve against the parent session",
			});
		}

		const capabilities = options.capabilities;
		if (!isPlainObject(capabilities)) {
			throw fail(":INVALID_ARGUMENT", "detectCapabilities() output is required", {
				capability: "capabilities",
				next: "pass detectCapabilities(pi, ctx) so the role guard can verify setActiveTools",
			});
		}
		if (capabilities.hasSetActiveTools !== true) {
			throw fail(":CAPABILITY_DENIED", "child tool narrowing requires setActiveTools", {
				role,
				capability: "hasSetActiveTools",
				actual: capabilities.hasSetActiveTools,
				next: "do not spawn a subagent on a host that cannot narrow extension tools",
			});
		}
		if (capabilities.hasCtxAgent !== true) {
			throw fail(":CAPABILITY_DENIED", "the host cannot identify a subagent context", {
				role,
				capability: "hasCtxAgent",
				actual: capabilities.hasCtxAgent,
				next: "G1 needs ctx.agent in the child; do not spawn on a host that cannot identify sub-sessions",
			});
		}

		const preloadedExtensionPaths = await pathList(options.preloadedExtensionPaths, "preloadedExtensionPaths");
		const preloadedCustomToolPaths = await pathList(options.preloadedCustomToolPaths, "preloadedCustomToolPaths");
		const allowExtensionDiscovery = options.allowExtensionDiscovery;
		if (allowExtensionDiscovery !== undefined && typeof allowExtensionDiscovery !== "boolean") {
			throw fail(":INVALID_ARGUMENT", "allowExtensionDiscovery must be a boolean", {
				actual: typeof allowExtensionDiscovery,
			});
		}
		if (preloadedExtensionPaths === undefined && allowExtensionDiscovery !== true) {
			throw fail(":CAPABILITY_DENIED", "subagents require the parent extension paths", {
				role,
				tools,
				next: "pass preloadedExtensionPaths from the parent session so the child re-binds the plugin, or set allowExtensionDiscovery explicitly",
			});
		}
		if (options.restrictToolNames === true) {
			throw fail(":CAPABILITY_DENIED", "restrictToolNames would drop the sandbox extension", {
				role,
				next: "leave restrictToolNames false; narrow the child tool surface with setActiveTools instead",
			});
		}
		for (const flag of ["enableMCP", "enableLsp", "enableIrc"]) {
			if (options[flag] === true) {
				throw fail(":CAPABILITY_DENIED", "sandboxed subagents may not enable host discovery or network surfaces", {
					role,
					capability: flag,
				});
			}
		}
		if (options.spawns !== undefined) {
			throw fail(":CAPABILITY_DENIED", "Herdchestra subagents may not spawn further subagents", {
				role,
				actual: options.spawns,
			});
		}

		const roleNonce = options.roleNonce;
		if (typeof roleNonce !== "string" || !NONCE_PATTERN.test(roleNonce)) {
			throw fail(":INVALID_ARGUMENT", "roleNonce is required and must be 8-128 URL-safe characters", {
				actual: typeof roleNonce === "string" ? `${roleNonce.length} characters` : typeof roleNonce,
				next: "generate a unique nonce in the parent",
			});
		}
		meta.roleNonce = roleNonce;
		const token = roleToken(role, roleNonce);
		const existing = readRoleToken(task);
		if (existing !== undefined && (existing.role !== role || existing.nonce !== roleNonce)) {
			throw fail(":INVALID_ARGUMENT", "task already carries a different role token", {
				expected: token,
				actual: existing.token,
			});
		}
		const promptTask = existing === undefined ? `${token}\n${task}` : task;
		const existingAssignment = readRoleToken(assignment);
		if (
			existingAssignment !== undefined &&
			(existingAssignment.role !== role || existingAssignment.nonce !== roleNonce)
		) {
			throw fail(":INVALID_ARGUMENT", "assignment already carries a different role token", {
				expected: token,
				actual: existingAssignment.token,
			});
		}
		const promptAssignment =
			assignment === task ? promptTask : `${existingAssignment === undefined ? `${token}\n` : ""}${assignment}`;

		const outputSchemaMode = options.outputSchemaMode;
		if (outputSchemaMode !== undefined && outputSchemaMode !== "strict" && outputSchemaMode !== "permissive") {
			throw fail(":INVALID_ARGUMENT", "outputSchemaMode must be strict or permissive", {
				actual: String(outputSchemaMode),
			});
		}
		if (outputSchemaMode === "strict" && options.outputSchema === undefined) {
			throw fail(":INVALID_ARGUMENT", "strict outputSchemaMode requires an outputSchema", {
				field: "outputSchema",
			});
		}
		const effectiveSchemaMode =
			outputSchemaMode ?? (role === "Manual Auditor" && options.outputSchema !== undefined ? "strict" : undefined);

		const index = nonNegativeInteger(options.index, "index") ?? 0;
		const taskDepth = nonNegativeInteger(options.taskDepth, "taskDepth") ?? 0;
		const timeoutMs = nonNegativeInteger(options.timeoutMs, "timeoutMs") ?? 0;
		const maxRuntimeMs = nonNegativeInteger(options.maxRuntimeMs, "maxRuntimeMs");

		const signal = options.signal;
		if (signal !== undefined && !isAbortSignal(signal)) {
			throw fail(":INVALID_ARGUMENT", "signal must be an AbortSignal", { actual: typeof signal });
		}

		const eventBus = options.eventBus;
		if (eventBus !== undefined && !isEventBus(eventBus)) {
			throw fail(":INVALID_ARGUMENT", "eventBus must expose emit and on", { actual: typeof eventBus });
		}

		// The parent's AgentRegistry id (18.16: ctx.agent.id), not an arbitrary
		// session id. The host records it as the child's `parentId`.
		const parentAgentId = optionalText(options.parentAgentId, "parentAgentId");
		const parentToolCallId = optionalText(options.parentToolCallId, "parentToolCallId");

		const visible = options.visible ?? role === "Manual Auditor";
		if (typeof visible !== "boolean") {
			throw fail(":INVALID_ARGUMENT", "visible must be a boolean", { actual: typeof visible });
		}
		const requireArtifacts = options.requireArtifacts ?? role === "Manual Auditor";
		if (typeof requireArtifacts !== "boolean") {
			throw fail(":INVALID_ARGUMENT", "requireArtifacts must be a boolean", {
				actual: typeof requireArtifacts,
			});
		}

		const artifactsDirOption = options.artifactsDir;
		let artifactsDir;
		if (artifactsDirOption !== undefined) {
			artifactsDir = absolutePath(artifactsDirOption, "artifactsDir");
		}
		if (requireArtifacts && artifactsDir === undefined) {
			throw fail(":HOST_API_MISMATCH", "this role requires a persistent artifacts directory", {
				capability: "artifactsDir",
				next: "pass a writable directory so the subagent transcript and result survive the run",
			});
		}
		if (artifactsDir !== undefined && options.prepareArtifacts !== false) {
			try {
				await mkdir(artifactsDir, { recursive: true });
				if (!(await stat(artifactsDir)).isDirectory()) {
					throw new Error("path is not a directory");
				}
			} catch (cause) {
				throw fail(":HOST_API_MISMATCH", "artifactsDir is not usable", {
					path: artifactsDir,
					cause: messageOf(cause),
					next: "pass a writable directory for subagent transcripts",
				});
			}
		}

		if (visible && eventBus === undefined) {
			throw fail(":HOST_API_MISMATCH", "a visible subagent requires the parent EventBus", {
				capability: "eventBus",
				next: "pass the parent session EventBus so Agent Hub can show this subagent",
			});
		}

		const artifacts =
			artifactsDir === undefined
				? EMPTY_ARTIFACTS
				: Object.freeze({
						dir: artifactsDir,
						sessionFile: join(artifactsDir, `${agentId}.jsonl`),
						outputPath: join(artifactsDir, `${agentId}.md`),
						persisted: true,
					});
		const parentSessionFile =
			options.sessionFile === undefined || options.sessionFile === null
				? undefined
				: optionalText(options.sessionFile, "sessionFile");
		meta.memoryOnly = artifactsDir === undefined;
		meta.visibility = eventBus !== undefined ? "hub" : artifactsDir !== undefined ? "transcript" : "memory";
		meta.visibilityNote =
			eventBus !== undefined
				? undefined
				: artifactsDir !== undefined
					? "no EventBus: Agent Hub cannot show this subagent; only its transcript persists"
					: "no artifactsDir: this subagent is visible only in memory";
		meta.artifacts = artifacts;
		meta.parentSessionFile = parentSessionFile ?? null;
		meta.parentSessionNote =
			parentSessionFile === undefined
				? artifacts.persisted
					? "no parent sessionFile supplied"
					: "no parent sessionFile supplied; child is memory-only"
				: artifacts.persisted
					? "sessionFile forwarded to the host; parentSession header behavior depends on host version"
					: "sessionFile supplied but no artifactsDir; child is memory-only and no transcript/header is written";
		meta.parentAgentId = parentAgentId ?? null;
		meta.parentToolCallId = parentToolCallId ?? null;
		meta.agentLineage = parentAgentId !== undefined ? "registry" : parentToolCallId !== undefined ? "hub" : "none";
		meta.eventBus = eventBus !== undefined;
		meta.toolNarrowingRequired = true;
		meta.hubAutoAdded = true;
		meta.extensionSource = preloadedExtensionPaths === undefined ? "discovery" : "preloaded";
		meta.allowModelFallback = allowModelFallback === true;
		meta.limits = Object.freeze({ timeoutMs, maxRuntimeMs });

		const agent = {
			name,
			description,
			systemPrompt,
			tools,
			spawns: undefined,
			model: [...modelPatterns],
			source: "project",
		};

		const request = {
			cwd,
			agent,
			task: promptTask,
			assignment: promptAssignment,
			description,
			index,
			id: agentId,
			taskDepth,
			outputSchema: options.outputSchema,
			outputSchemaMode: effectiveSchemaMode,
			modelOverride: [...modelPatterns],
			parentActiveModelPattern,
			modelRegistry: options.modelRegistry,
			settings,
			signal,
			persistArtifacts: artifactsDir !== undefined,
			...(artifactsDir === undefined ? {} : { artifactsDir }),
			...(parentSessionFile === undefined ? {} : { sessionFile: parentSessionFile }),
			...(eventBus === undefined ? {} : { eventBus }),
			...(parentAgentId === undefined ? {} : { parentAgentId }),
			...(parentToolCallId === undefined ? {} : { parentToolCallId }),
			...(preloadedExtensionPaths === undefined ? {} : { preloadedExtensionPaths }),
			...(preloadedCustomToolPaths === undefined ? {} : { preloadedCustomToolPaths }),
			...(maxRuntimeMs === undefined ? {} : { maxRuntimeMs }),
			restrictToolNames: false,
			keepAlive,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
		};

		return {
			ok: true,
			request,
			meta: Object.freeze(meta),
		};
	} catch (error) {
		return {
			ok: false,
			error: isHerdError(error)
				? error
				: fail(":INVALID_ARGUMENT", "subagent plan failed", {
						cause: messageOf(error),
					}),
			meta: Object.freeze(meta),
		};
	}
}

/**
 * Merge the caller signal, the runtime controller, and a timeout.
 *
 * @param {AbortSignal[]} signals
 */
function combineSignals(signals) {
	const active = signals.filter((signal) => signal !== undefined);
	if (active.length === 0) return { signal: undefined, cleanup() {} };
	if (active.length === 1) return { signal: active[0], cleanup() {} };
	if (typeof AbortSignal.any === "function") {
		return { signal: AbortSignal.any(active), cleanup() {} };
	}
	const controller = new AbortController();
	const listeners = [];
	for (const signal of active) {
		const listener = () => controller.abort(signal.reason);
		if (signal.aborted) controller.abort(signal.reason);
		else {
			signal.addEventListener("abort", listener, { once: true });
			listeners.push([signal, listener]);
		}
	}
	return {
		signal: controller.signal,
		cleanup() {
			for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
		},
	};
}

/**
 * Cancel a subagent and every child it owns.
 *
 * Inputs: a handle (or an outcome carrying `handle`) and an optional reason.
 * Output: `{ aborted, agentIds }`, parent-first. The operation is idempotent
 * and never throws; a handle that was already aborted still propagates to any
 * children that are still running. A finished handle is not marked aborted,
 * but its children are still visited.
 *
 * @param {unknown} target
 * @param {unknown} [reason]
 */
export function abortTree(target, reason) {
	const root = asHandle(target);
	if (root === undefined) return { aborted: false, agentIds: [] };
	const text = reasonText(reason);
	/** @type {string[]} */
	const agentIds = [];
	/** @param {ReturnType<typeof asHandle>} handle */
	const visit = (handle) => {
		if (handle === undefined) return;
		if (!handle.aborted && !handle.finished) {
			handle.aborted = true;
			handle.abortReason = text;
			try {
				handle.controller.abort(reason ?? new Error(text));
			} catch {
				// A controller that was already aborted is not a failure.
			}
			agentIds.push(handle.agentId);
		}
		for (const child of [...handle.children]) visit(child);
	};
	visit(root);
	return { aborted: agentIds.length > 0, agentIds };
}

/**
 * Create a subagent runtime bound to explicit ports.
 *
 * Ports:
 * - `runSubprocess`: the host executor (defaults to the imported host one).
 * - `Settings`: the host Settings class (defaults to the imported one).
 * - `randomUUID`, `now`: deterministic replacements for tests.
 *
 * The returned `start(options)` returns `{ handle, done }` immediately, so a
 * caller can cancel a live child before `done` settles. `spawn` is the
 * promise-only convenience. `liveAgents()` is a read-only recovery snapshot.
 *
 * @param {{ runSubprocess?: unknown, Settings?: unknown, randomUUID?: () => string, now?: () => number }} [ports]
 */
export function createAgentRuntime(ports = {}) {
	const port = isObjectLike(ports) ? ports : {};
	const execute = Object.hasOwn(port, "runSubprocess") ? port.runSubprocess : host.runSubprocess;
	const Settings = Object.hasOwn(port, "Settings") ? port.Settings : host.Settings;
	const nextId = typeof port.randomUUID === "function" ? port.randomUUID : randomUUID;
	const now = typeof port.now === "function" ? port.now : Date.now;
	/** @type {Map<string, ReturnType<typeof asHandle>>} */
	const live = new Map();

	/**
	 * @param {ReturnType<typeof planSpawn>} plan
	 * @param {Record<string, unknown>} [base]
	 */
	function failedOutcome(plan, base = {}) {
		const meta = plan.meta ?? {};
		return Object.freeze({
			ok: false,
			agentId: meta.agentId ?? base.agentId ?? null,
			role: meta.role ?? base.role ?? null,
			roleNonce: meta.roleNonce ?? null,
			modelPatterns: meta.modelPatterns ?? [],
			parentActiveModelPattern: meta.parentActiveModelPattern,
			result: undefined,
			handle: base.handle ?? null,
			agentDefinition: null,
			abort:
				base.handle === undefined
					? () => ({ aborted: false, agentIds: [] })
					: (reason) => abortTree(base.handle, reason),
			memoryOnly: meta.memoryOnly ?? true,
			visibility: meta.visibility ?? "memory",
			visibilityNote: meta.visibilityNote,
			artifacts: meta.artifacts ?? EMPTY_ARTIFACTS,
			parentAgentId: meta.parentAgentId ?? null,
			parentToolCallId: meta.parentToolCallId ?? null,
			agentLineage: meta.agentLineage ?? "none",
			settingsSource: meta.settingsSource,
			parentSessionFile: meta.parentSessionFile ?? null,
			parentSessionNote: meta.parentSessionNote ?? "parent session not established; plan failed before validation",
			eventBus: meta.eventBus ?? false,
			toolNarrowingRequired: meta.toolNarrowingRequired ?? false,
			hubAutoAdded: meta.hubAutoAdded ?? false,
			extensionSource: meta.extensionSource ?? "none",
			truncated: false,
			resolvedModel: undefined,
			resolvedModelIsFallback: false,
			error: plan.ok ? fail(":INVALID_ARGUMENT", "spawn failed", {}) : plan.error,
		});
	}

	/**
	 * @param {Record<string, unknown>} options
	 */
	async function start(options) {
		const parent = options?.parent;
		const parentHandle = parent === undefined ? undefined : asHandle(parent);
		const rejected = (error) => ({
			handle: null,
			done: Promise.resolve(
				failedOutcome(
					{
						ok: false,
						error,
						meta: { role: typeof options?.role === "string" ? options.role : undefined },
					},
					{},
				),
			),
		});
		if (parent !== undefined && parentHandle === undefined) {
			return rejected(
				fail(":INVALID_ARGUMENT", "parent must be a live subagent handle", {
					actual: typeof parent,
					next: "pass the handle returned by runtime.start()",
				}),
			);
		}
		if (parentHandle?.finished === true) {
			return rejected(
				fail(":INVALID_ARGUMENT", "parent subagent has already finished", {
					parentAgentId: parentHandle.agentId,
					next: "start children while the parent is still running",
				}),
			);
		}

		let plannedId;
		try {
			plannedId = nextId();
		} catch (cause) {
			return rejected(
				fail(":HOST_API_MISMATCH", "subagent identity could not be generated", {
					cause: messageOf(cause),
				}),
			);
		}
		const plan = await planSpawn(options, { agentId: plannedId, Settings, now });
		if (!plan.ok) {
			return { handle: null, done: Promise.resolve(failedOutcome(plan)) };
		}

		const meta = plan.meta;
		const handle = {
			agentId: meta.agentId,
			role: meta.role,
			startedAt: meta.startedAt,
			controller: new AbortController(),
			children: new Set(),
			aborted: false,
			finished: false,
			abortReason: undefined,
		};
		if (parentHandle !== undefined) parentHandle.children.add(handle);
		live.set(handle.agentId, handle);

		const done = executeAgent({ execute, plan, handle }).finally(() => {
			handle.finished = true;
			live.delete(handle.agentId);
			parentHandle?.children.delete(handle);
			for (const child of [...handle.children]) {
				abortTree(child, "parent subagent finished");
			}
			handle.children.clear();
		});
		return { handle, done };
	}

	async function executeAgent({ execute: executor, plan, handle }) {
		const { request, meta } = plan;
		if (typeof executor !== "function") {
			return failedOutcome(
				{
					ok: false,
					error: fail(":HOST_API_MISMATCH", "host runSubprocess is unavailable", {
						capability: "runSubprocess",
						next: "load the plugin inside omp; do not import a subagent engine directly",
					}),
					meta,
				},
				{ handle },
			);
		}

		let timer;
		if (meta.limits.timeoutMs > 0) {
			timer = setTimeout(() => {
				abortTree(
					handle,
					fail(":UPSTREAM_ABORTED", `timeout after ${meta.limits.timeoutMs}ms`, {
						role: meta.role,
						timeoutMs: meta.limits.timeoutMs,
					}),
				);
			}, meta.limits.timeoutMs);
			timer.unref?.();
		}

		const merged = combineSignals([request.signal, handle.controller.signal]);
		try {
			if (merged.signal?.aborted) {
				return abortedOutcome(plan, handle, undefined, merged.signal.reason);
			}
			const result = await executor({ ...request, signal: merged.signal });
			if (result?.aborted === true) {
				return abortedOutcome(plan, handle, result);
			}
			if (handle.aborted || merged.signal?.aborted === true) {
				// Cancellation landed before the executor settled. Do not report a
				// partially observed run as success.
				return abortedOutcome(plan, handle, result);
			}
			return classifyResult(plan, handle, result);
		} catch (cause) {
			if (handle.aborted || merged.signal?.aborted === true) {
				return abortedOutcome(plan, handle, undefined, cause);
			}
			return failedOutcome(
				{
					ok: false,
					error: fail(":AGENT_SPAWN_FAILED", "host runSubprocess threw", {
						role: meta.role,
						agentId: meta.agentId,
						cause: messageOf(cause),
						next: "inspect the host session log; the subagent slot is preserved",
					}),
					meta,
				},
				{ handle },
			);
		} finally {
			clearTimeout(timer);
			merged.cleanup();
		}
	}

	/**
	 * @param {ReturnType<typeof planSpawn>} plan
	 * @param {ReturnType<typeof asHandle>} handle
	 * @param {Record<string, unknown> | undefined} result
	 * @param {unknown} [cause]
	 */
	function abortedOutcome(plan, handle, result, cause) {
		const reason = handle.abortReason ?? result?.abortReason ?? reasonText(cause);
		return Object.freeze({
			ok: false,
			agentId: plan.meta.agentId,
			role: plan.meta.role,
			roleNonce: plan.meta.roleNonce,
			modelPatterns: plan.meta.modelPatterns,
			parentActiveModelPattern: plan.meta.parentActiveModelPattern,
			result,
			handle,
			agentDefinition: plan.request.agent,
			abort: (nextReason) => abortTree(handle, nextReason),
			memoryOnly: plan.meta.memoryOnly,
			visibility: plan.meta.visibility,
			visibilityNote: plan.meta.visibilityNote,
			artifacts: plan.meta.artifacts,
			parentAgentId: plan.meta.parentAgentId,
			parentToolCallId: plan.meta.parentToolCallId,
			agentLineage: plan.meta.agentLineage,
			settingsSource: plan.meta.settingsSource,
			parentSessionFile: plan.meta.parentSessionFile,
			parentSessionNote: plan.meta.parentSessionNote,
			eventBus: plan.meta.eventBus,
			toolNarrowingRequired: plan.meta.toolNarrowingRequired,
			hubAutoAdded: plan.meta.hubAutoAdded,
			extensionSource: plan.meta.extensionSource,
			truncated: result?.truncated === true,
			resolvedModel: typeof result?.resolvedModel === "string" ? result.resolvedModel : undefined,
			resolvedModelIsFallback: result?.resolvedModelIsFallback === true,
			error: fail(":UPSTREAM_ABORTED", `subagent aborted: ${reason}`, {
				role: plan.meta.role,
				agentId: plan.meta.agentId,
				reason,
				timeoutMs: plan.meta.limits?.timeoutMs,
				cause: cause === undefined ? undefined : messageOf(cause),
			}),
		});
	}

	/**
	 * @param {ReturnType<typeof planSpawn>} plan
	 * @param {ReturnType<typeof asHandle>} handle
	 * @param {unknown} result
	 */
	function classifyResult(plan, handle, result) {
		const meta = plan.meta;
		if (!isObjectLike(result)) {
			return failedOutcome(
				{
					ok: false,
					error: fail(":HOST_API_MISMATCH", "host runSubprocess returned no result object", {
						role: meta.role,
						agentId: meta.agentId,
					}),
					meta,
				},
				{ handle },
			);
		}

		const resolvedModel = result.resolvedModel;
		const resolvedModelIsFallback = result.resolvedModelIsFallback === true;
		const base = Object.freeze({
			agentId: meta.agentId,
			role: meta.role,
			roleNonce: meta.roleNonce,
			modelPatterns: meta.modelPatterns,
			parentActiveModelPattern: meta.parentActiveModelPattern,
			result,
			handle,
			agentDefinition: plan.request.agent,
			abort: (reason) => abortTree(handle, reason),
			memoryOnly: meta.memoryOnly,
			visibility: meta.visibility,
			visibilityNote: meta.visibilityNote,
			artifacts: meta.artifacts,
			parentAgentId: meta.parentAgentId,
			parentToolCallId: meta.parentToolCallId,
			agentLineage: meta.agentLineage,
			settingsSource: meta.settingsSource,
			parentSessionFile: meta.parentSessionFile,
			parentSessionNote: meta.parentSessionNote,
			eventBus: meta.eventBus,
			toolNarrowingRequired: meta.toolNarrowingRequired,
			hubAutoAdded: meta.hubAutoAdded,
			extensionSource: meta.extensionSource,
			truncated: result.truncated === true,
			resolvedModel,
			resolvedModelIsFallback,
		});

		if (resolvedModelIsFallback && meta.allowModelFallback !== true) {
			return Object.freeze({
				...base,
				ok: false,
				error: fail(":MODEL_FALLBACK", "subagent resolved to an unauthorized fallback model", {
					role: meta.role,
					requested: meta.modelPatterns,
					resolvedModel,
					next: "retry with a working model or pass allowModelFallback explicitly",
				}),
			});
		}
		if (typeof resolvedModel !== "string" || resolvedModel.length === 0) {
			return Object.freeze({
				...base,
				ok: false,
				error: fail(":HOST_API_MISMATCH", "host did not report the resolved model", {
					role: meta.role,
					agentId: meta.agentId,
					next: "the host must expose resolvedModel; model attribution is not optional",
				}),
			});
		}
		if (result.exitCode !== 0 || result.error !== undefined) {
			const stderr = typeof result.stderr === "string" ? result.stderr.slice(0, 2000) : undefined;
			return Object.freeze({
				...base,
				ok: false,
				error: fail(":AGENT_SPAWN_FAILED", "subagent run failed", {
					role: meta.role,
					agentId: meta.agentId,
					exitCode: result.exitCode,
					error: result.error,
					stderr,
				}),
			});
		}
		return Object.freeze({ ...base, ok: true, error: undefined });
	}

	return Object.freeze({
		start,
		spawn: (options) => start(options).done,
		abortTree,
		liveAgents() {
			return Object.freeze(
				[...live.values()]
					.map((handle) =>
						Object.freeze({
							agentId: handle.agentId,
							role: handle.role,
							startedAt: handle.startedAt,
						}),
					)
					.sort((left, right) => left.agentId.localeCompare(right.agentId)),
			);
		},
	});
}

const defaultRuntime = createAgentRuntime();

/**
 * Continue one existing Plan/subagent session with another turn.
 *
 * Inputs:
 * - `id` (or `agentId`): the AgentRegistry id returned as `SpawnOutcome.agentId`
 *   by the first spawn. A path or parent sessionFile is rejected.
 * - `agent`: the exact complete `AgentDefinition` used by the first spawn
 *   (`SpawnOutcome.agentDefinition`).
 * - `message`: the next real prompt.
 * - optional `eventBus`, `artifactsDir`, `parentToolCallId`, `signal`,
 *   `maxRuntimeMs`, `allowModelFallback`.
 *
 * Output: `{ok, id, agentId, result, resolvedModel, resolvedModelIsFallback,
 * error?}`. The host reuses the child session and its full history; this
 * wrapper never creates a replacement session and never treats a parent
 * sessionFile as the child id.
 *
 * @param {Record<string, unknown>} options
 * @param {{ runSubagentFollowUpTurn?: unknown }} [ports]
 */
export async function continueAgent(options, ports = {}) {
	const idCandidate = isObjectLike(options) ? (options.id ?? options.agentId) : undefined;
	if (
		isObjectLike(options) &&
		options.id !== undefined &&
		options.agentId !== undefined &&
		options.id !== options.agentId
	) {
		return followUpFailure(idCandidate, fail(":INVALID_ARGUMENT", "id and agentId disagree", {}));
	}
	if (typeof idCandidate !== "string" || !ID_PATTERN.test(idCandidate)) {
		return followUpFailure(
			undefined,
			fail(":INVALID_ARGUMENT", "continueAgent requires the child AgentRegistry id", {
				actual: String(idCandidate),
				next: "pass SpawnOutcome.agentId from the first spawn; never pass a parent sessionFile or path",
			}),
		);
	}
	const id = idCandidate;
	let signal;

	try {
		if (!isPlainObject(options)) {
			throw fail(":INVALID_ARGUMENT", "continueAgent options must be a plain object", {
				actual: typeof options,
			});
		}
		const agent = options.agent;
		validateAgentDefinition(agent);
		const message = optionalText(options.message, "message");
		if (message === undefined) {
			throw fail(":INVALID_ARGUMENT", "continueAgent requires a non-empty message", { field: "message" });
		}
		const eventBus = options.eventBus;
		if (eventBus !== undefined && !isEventBus(eventBus)) {
			throw fail(":INVALID_ARGUMENT", "eventBus must expose emit and on", { actual: typeof eventBus });
		}
		const artifactsDir = optionalText(options.artifactsDir, "artifactsDir");
		const parentToolCallId = optionalText(options.parentToolCallId, "parentToolCallId");
		signal = options.signal;
		if (signal !== undefined && !isAbortSignal(signal)) {
			throw fail(":INVALID_ARGUMENT", "signal must be an AbortSignal", { actual: typeof signal });
		}
		const maxRuntimeMs = nonNegativeInteger(options.maxRuntimeMs, "maxRuntimeMs");
		const allowModelFallback = options.allowModelFallback;
		if (allowModelFallback !== undefined && typeof allowModelFallback !== "boolean") {
			throw fail(":INVALID_ARGUMENT", "allowModelFallback must be a boolean", {
				actual: typeof allowModelFallback,
			});
		}

		const port = isObjectLike(ports) ? ports : {};
		const execute = Object.hasOwn(port, "runSubagentFollowUpTurn")
			? port.runSubagentFollowUpTurn
			: host.runSubagentFollowUpTurn;
		if (typeof execute !== "function") {
			throw fail(":CAPABILITY_DENIED", "host follow-up turns are unavailable", {
				capability: "hasRunSubagentFollowUpTurn",
				next: "do not replace the reused session with a new spawn on this host",
			});
		}
		if (signal?.aborted === true) {
			return followUpFailure(
				id,
				fail(":UPSTREAM_ABORTED", "follow-up turn aborted before start", {
					reason: reasonText(signal.reason),
				}),
			);
		}

		const result = await execute({
			id,
			agent,
			message,
			...(eventBus === undefined ? {} : { eventBus }),
			...(artifactsDir === undefined ? {} : { artifactsDir }),
			...(parentToolCallId === undefined ? {} : { parentToolCallId }),
			...(signal === undefined ? {} : { signal }),
			...(maxRuntimeMs === undefined ? {} : { maxRuntimeMs }),
		});
		if (result?.aborted === true) {
			return followUpFailure(
				id,
				fail(":UPSTREAM_ABORTED", "follow-up turn aborted", {
					reason: result.abortReason ?? "aborted",
				}),
				result,
			);
		}
		if (result?.exitCode !== 0 || result?.error !== undefined) {
			return followUpFailure(
				id,
				fail(":AGENT_SPAWN_FAILED", "follow-up turn failed", {
					agentId: id,
					exitCode: result?.exitCode,
					error: result?.error,
				}),
				result,
			);
		}
		if (typeof result?.resolvedModel !== "string" || result.resolvedModel.length === 0) {
			return followUpFailure(
				id,
				fail(":HOST_API_MISMATCH", "host did not report the resolved model for the follow-up turn", {
					agentId: id,
					next: "the host must expose resolvedModel on kept-alive follow-up results",
				}),
				result,
			);
		}
		if (result?.resolvedModelIsFallback === true && allowModelFallback !== true) {
			return followUpFailure(
				id,
				fail(":MODEL_FALLBACK", "follow-up turn resolved to an unauthorized fallback model", {
					agentId: id,
					resolvedModel: result.resolvedModel,
					next: "retry with a working model or pass allowModelFallback explicitly",
				}),
				result,
			);
		}
		return Object.freeze({
			ok: true,
			id,
			agentId: id,
			result,
			resolvedModel: result?.resolvedModel,
			resolvedModelIsFallback: result?.resolvedModelIsFallback === true,
			error: undefined,
		});
	} catch (error) {
		if (signal?.aborted === true) {
			return followUpFailure(
				id,
				fail(":UPSTREAM_ABORTED", "follow-up turn aborted", {
					reason: reasonText(signal.reason),
				}),
			);
		}
		const messageText = messageOf(error);
		const reason = /Unknown agent|never registered|has been released/i.test(messageText)
			? "unknown-agent"
			: /cannot be revived|cannot be resumed|no reviver/i.test(messageText)
				? "unavailable-transcript"
				: undefined;
		return followUpFailure(
			id,
			isHerdError(error)
				? error
				: fail(":AGENT_SPAWN_FAILED", "follow-up turn failed", {
						agentId: id,
						...(reason === undefined ? {} : { reason }),
						cause: messageText,
					}),
		);
	}
}

/**
 * @param {string | undefined} id
 * @param {Error} error
 * @param {unknown} [result]
 */
function followUpFailure(id, error, result) {
	return Object.freeze({
		ok: false,
		id: id ?? null,
		agentId: id ?? null,
		result,
		resolvedModel: typeof result?.resolvedModel === "string" ? result.resolvedModel : undefined,
		resolvedModelIsFallback: result?.resolvedModelIsFallback === true,
		error,
	});
}

/**
 * Spawn one subagent and resolve with its classified result.
 *
 * Equivalent to `createAgentRuntime().spawn(options)`. Prefer `start` when the
 * caller needs to cancel a running child.
 *
 * @param {Record<string, unknown>} options
 * @returns {Promise<SpawnOutcome>}
 */
export async function spawnAgent(options) {
	return (await defaultRuntime.start(options)).done;
}

/**
 * Read-only snapshot of the subagents this module instance is still running.
 */
export function liveAgents() {
	return defaultRuntime.liveAgents();
}
