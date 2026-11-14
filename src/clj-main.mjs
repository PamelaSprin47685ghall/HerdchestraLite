import { randomUUID } from "node:crypto";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hackContext } from "./host/hack-context.mjs";
import { detectCapabilities, host as hostModule } from "./host/imports.mjs";
import { getNativeRunner, installRunnerCapture } from "./host/native-runner.mjs";
import { spawnAgent } from "./host/subprocess.mjs";

const BOARD_TOOLS = Object.freeze([
	"board_split",
	"board_claim",
	"board_finish",
	"board_cancel",
	"board_replace",
	"board_release",
	"board_reopen",
	"board_comment",
	"board_update",
	"board_park_slot",
	"board_take_or_die",
]);

const ROLE_TOOLS = Object.freeze({
	"Plan DevOps": Object.freeze(["clj_devops", "submit_devops_report"]),
	Reviewer: Object.freeze(["review"]),
	"Swarm Worker": BOARD_TOOLS,
	"Swarm Holder": BOARD_TOOLS,
	"Manual Auditor": Object.freeze(["attach_case_audit"]),
});

const ROLE_SYSTEM_PROMPTS = Object.freeze({
	"Plan DevOps":
		"You are the Plan DevOps subagent for Herdchestra Lite. Inspect the real workspace read-only with clj_devops and finish exactly once through submit_devops_report.",
	Reviewer:
		"You are the Herdchestra Lite S5 Reviewer. Inspect the frozen contract documents and the real single workspace, then finish with exactly one review call.",
	"Swarm Worker":
		"You are a Herdchestra Lite Swarm Worker. Coordinate only through the shared board tools and the write gate; never wait for a human.",
	"Swarm Holder":
		"You are a Herdchestra Lite Swarm Holder. Coordinate only through the shared board tools and the write gate; never wait for a human.",
	"Manual Auditor":
		"You are a Herdchestra Lite Manual Auditor. Audit exactly one CASE in the isolated copy and finish exactly once through attach_case_audit.",
});

const ROLE_LINE = /^\[HERD_ROLE:[^\]]*]\r?\n?/;

let latestCtx;
let pluginEntryPath;

/** @param {Record<string, unknown> | undefined} request */
function optionOf(request, camel, kebab) {
	if (request === undefined || request === null) return undefined;
	const value = request[camel];
	if (value !== undefined) return value;
	return request[kebab];
}

/** @param {unknown} value */
function messageOf(value) {
	if (value instanceof Error) return value.message;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** @param {Record<string, unknown>} request */
function requestPrompt(request) {
	const raw = optionOf(request, "prompt", "task") ?? optionOf(request, "task", "prompt") ?? "";
	return String(raw).replace(ROLE_LINE, "");
}

/** @param {Record<string, unknown>} request */
function requestSystemPrompt(request) {
	const explicit = optionOf(request, "systemPrompt", "system-prompt");
	if (typeof explicit === "string" && explicit.trim().length > 0) return explicit;
	return ROLE_SYSTEM_PROMPTS[request.role];
}

/** @param {Record<string, unknown>} request */
function requestModel(request) {
	const explicit = optionOf(request, "model", "model");
	if (explicit !== undefined) return explicit;
	const role = request.role;
	if (role === "Plan DevOps" || role === "Swarm Worker" || role === "Swarm Holder") return undefined;
	const model = latestCtx?.model;
	if (model && typeof model.provider === "string" && typeof model.id === "string") {
		return `${model.provider}/${model.id}`;
	}
	if (typeof model === "string" && model.length > 0) return model;
	return undefined;
}

/** @param {Record<string, unknown>} request */
function requestTools(request) {
	const explicit = optionOf(request, "tools", "tools");
	if (Array.isArray(explicit) && explicit.length > 0) return explicit;
	const surface = ROLE_TOOLS[request.role];
	return surface === undefined ? undefined : [...surface];
}

/** @param {Record<string, unknown>} request */
function requestArtifactsDir(request) {
	const value = optionOf(request, "artifactsDir", "artifacts-dir");
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** @param {Record<string, unknown>} request */
function requestSessionFile(request) {
	const value = optionOf(request, "sessionFile", "session-file");
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** @param {unknown} outcome @param {string} role */
function outcomePayload(outcome, role) {
	const result = outcome && typeof outcome === "object" ? outcome.result : undefined;
	let resultMarkdown = "";
	if (typeof result === "string") resultMarkdown = result;
	else if (result && typeof result.result === "string") resultMarkdown = result.result;
	else if (result && typeof result.text === "string") resultMarkdown = result.text;
	else if (result && typeof result.message === "string") resultMarkdown = result.message;
	else if (result && typeof result.output === "string") resultMarkdown = result.output;
	const ok = outcome?.ok === true;
	return {
		ok,
		role,
		agentId: outcome?.agentId ?? null,
		resultMarkdown,
		artifactsDir: outcome?.artifacts?.dir,
		sessionFile: outcome?.artifacts?.sessionFile,
		error: ok ? undefined : messageOf(outcome?.error ?? "subagent failed"),
		code: ok ? undefined : (outcome?.error?.code ?? ":AGENT_SPAWN_FAILED"),
		resolvedModel: outcome?.resolvedModel,
	};
}

/**
 * Stable subagent port consumed by `herd.swarm.runner` and
 * `herd.swarm.auditors`.
 *
 * The CLJS side sends a keyword map; `clj->js` keeps kebab-case keys, so both
 * `artifactsDir` and `artifacts-dir` are accepted. The wrapper only fills host
 * capabilities (Settings, ModelRegistry, capabilities, extension path) and
 * never substitutes a model or a tool surface.
 *
 * @param {Record<string, unknown>} request
 */
async function runSubagent(request) {
	try {
		if (request === undefined || request === null || typeof request !== "object") {
			return { ok: false, code: ":INVALID_ARGUMENT", error: "runSubagent requires a request object" };
		}
		const role = request.role;
		const tools = requestTools(request);
		if (typeof role !== "string" || ROLE_TOOLS[role] === undefined) {
			return {
				ok: false,
				code: ":CAPABILITY_DENIED",
				error: `unsupported Herdchestra subagent role: ${String(role)}`,
			};
		}
		if (tools === undefined) {
			return { ok: false, code: ":CAPABILITY_DENIED", error: `no tool surface for role: ${role}` };
		}
		const ctx = latestCtx;
		if (ctx === undefined) {
			return {
				ok: false,
				code: ":HOST_API_MISMATCH",
				error: "the parent session context is unavailable; runSubagent cannot resolve Settings or ModelRegistry",
			};
		}
		const modelRegistry = ctx.modelRegistry;
		if (modelRegistry === undefined || modelRegistry === null) {
			return {
				ok: false,
				code: ":HOST_API_MISMATCH",
				error: "the parent ModelRegistry is unavailable",
			};
		}
		const model = requestModel(request);
		if (model === undefined && !["Plan DevOps", "Swarm Worker", "Swarm Holder"].includes(role)) {
			return {
				ok: false,
				code: ":CAPABILITY_DENIED",
				error: `main-model role ${role} has no parent model to pin`,
			};
		}
		let settings = pi?.pi?.settings;
		if (settings === undefined) {
			try {
				settings = hostModule.Settings?.instance;
			} catch {
				settings = undefined;
			}
		}
		if (settings === undefined) settings = ctx.settings ?? undefined;
		const eventBus = ctx.eventBus ?? (pi?.events && typeof pi.events.emit === "function" ? pi.events : undefined);
		const capabilities = detectCapabilities(pi, ctx);
		const prompt = requestPrompt(request);
		if (prompt.length === 0) {
			return { ok: false, code: ":INVALID_ARGUMENT", error: "runSubagent requires a non-empty prompt" };
		}
		const options = {
			role,
			name: optionOf(request, "name", "name") ?? `${role.replaceAll(" ", "")}-${randomUUID().slice(0, 8)}`,
			systemPrompt: requestSystemPrompt(request),
			task: prompt,
			cwd: optionOf(request, "cwd", "cwd") ?? ctx.cwd ?? process.cwd(),
			tools,
			model,
			modelRegistry,
			settings,
			capabilities,
			roleNonce: randomUUID().replaceAll("-", ""),
			preloadedExtensionPaths: [pluginEntryPath],
			artifactsDir: requestArtifactsDir(request),
			sessionFile: requestSessionFile(request),
			signal: request.signal,
			keepAlive: false,
			visible: request.visible ?? eventBus !== undefined,
			requireArtifacts: request.requireArtifacts ?? role === "Manual Auditor",
			outputSchema: optionOf(request, "outputSchema", "output-schema"),
			outputSchemaMode: optionOf(request, "outputSchemaMode", "output-schema-mode"),
			timeoutMs: optionOf(request, "timeoutMs", "timeout-ms") ?? 0,
			maxRuntimeMs: optionOf(request, "maxRuntimeMs", "max-runtime-ms"),
			eventBus,
			parentAgentId: ctx.agent?.id,
			parentToolCallId: optionOf(request, "parentToolCallId", "parent-tool-call-id"),
			allowModelFallback: false,
		};
		const outcome = await spawnAgent(options);
		return outcomePayload(outcome, role);
	} catch (error) {
		return {
			ok: false,
			code: error?.code ?? ":AGENT_SPAWN_FAILED",
			error: messageOf(error),
		};
	}
}

let pi;
const BOOT_KEY = Symbol.for("herdchestra.boot.v1");
const RUNNER_CAPTURE_KEY = Symbol.for("herdchestra.runner-capture.v1");

export const TRACE_LIMIT = 1024 * 1024;
const TRACE_DEFAULT_PATH = ".herd/perf-trace.jsonl";
const NEWLINE = String.fromCharCode(10);

let traceTail = Promise.resolve();

/** Trace is opt-in; without HERD_TRACE=1 no clock or filesystem work happens. */
export function traceEnabled(env = process.env) {
	return env.HERD_TRACE === "1";
}

export function traceTarget(env = process.env) {
	return env.HERD_TRACE_PATH || TRACE_DEFAULT_PATH;
}

export function bootTraceRecord(event, fields = {}, at = Date.now()) {
	return { at, event, ...fields };
}

export async function traceBootEvent(event, fields = {}) {
	if (!traceEnabled()) return false;
	const target = traceTarget();
	let line;
	try {
		line = `${JSON.stringify(bootTraceRecord(event, fields))}${NEWLINE}`;
	} catch {
		return false;
	}
	const bytes = Buffer.byteLength(line, "utf8");
	const run = traceTail.then(async () => {
		const size = await stat(target)
			.then((value) => value.size)
			.catch(() => 0);
		if (size + bytes > TRACE_LIMIT) return false;
		await mkdir(dirname(target), { recursive: true });
		await appendFile(target, line, "utf8");
		return true;
	});
	traceTail = run.then(
		() => undefined,
		() => undefined,
	);
	return run.catch(() => false);
}

function traceOn() {
	return traceEnabled() ? true : null;
}

function msSince(started) {
	return Math.round((performance.now() - started) * 1000) / 1000;
}

function traced(trace, phase, fn) {
	if (trace === null) return fn();
	const started = performance.now();
	const settle = () => {
		void traceBootEvent("boot-phase", { phase, ms: msSince(started) });
	};
	let result;
	try {
		result = fn();
	} catch (error) {
		settle();
		throw error;
	}
	return Promise.resolve(result).then(
		(value) => {
			settle();
			return value;
		},
		(error) => {
			settle();
			throw error;
		},
	);
}

function bootState() {
	let state = globalThis[BOOT_KEY];
	if (state === undefined) {
		state = {
			promise: null,
			handler: null,
			activateSession: null,
			contextPis: new WeakSet(),
			boots: 0,
			contextRegistrations: 0,
		};
		Object.defineProperty(globalThis, BOOT_KEY, { value: state, enumerable: false, configurable: true });
	}
	return state;
}

async function boot(extensionApi) {
	const trace = traceOn();
	const bootStarted = trace === null ? 0 : performance.now();
	const state = bootState();
	if (state.promise === null) {
		const cached = globalThis.__herdBootPromise;
		if (cached !== undefined && cached !== null && typeof cached.then === "function") {
			state.promise = cached;
			if (trace !== null) {
				void traceBootEvent("boot-reuse", { pid: process.pid, boots: state.boots, hitGlobal: true });
			}
		} else {
			state.boots += 1;
			state.promise = (async () => {
				const entry = realpathSync(fileURLToPath(import.meta.url));
				pluginEntryPath = entry;
				const pluginSrc = dirname(entry);
				const pluginRoot = dirname(pluginSrc);
				if (trace !== null) {
					void traceBootEvent("boot-start", { pid: process.pid, cwd: process.cwd(), pluginSrc });
				}
				const require = createRequire(entry);
				const resolveFile = (name, relative) => {
					const candidates = [
						join(pluginRoot, "node_modules", name, relative),
						join(pluginRoot, "..", "node_modules", name, relative),
					];
					const found = candidates.find((candidate) => existsSync(candidate));
					return found ?? require.resolve(name);
				};
				const nbb = await traced(trace, "nbb-import", () =>
					import(pathToFileURL(resolveFile("nbb", "index.mjs")).href),
				);
				const formatter = await traced(trace, "formatter-import", () =>
					import(
						pathToFileURL(resolveFile("@chrisoakman/standard-clojure-style", "dist/standard-clojure-style.js"))
							.href
					),
				);
				nbb.registerModule(formatter, "@chrisoakman/standard-clojure-style");
				let tui = {};
				try {
					tui = await import("@oh-my-pi/pi-tui");
				} catch {}
				globalThis.__herdTui = tui;
				let languageDetector = null;
				try {
					const { loadLanguageDetector } = await import("./host/language-detect.mjs");
					languageDetector = loadLanguageDetector(require);
				} catch {}
				globalThis.__herdDetectLanguage = languageDetector;
				globalThis.__herdPluginSrc = pluginSrc;
				nbb.addClassPath(pluginSrc);
				await traced(trace, "bootstrap-load", () => nbb.loadFile(join(pluginSrc, "herd", "bootstrap.cljs")));
				await traced(trace, "handler-load", async () => {
					state.handler = await nbb.loadString("herd.main/context-handler");
					state.activateSession = await nbb.loadString("herd.main/activate-session!");
				});
				if (trace !== null) {
					void traceBootEvent("boot-end", { total: msSince(bootStarted), boots: state.boots, hitGlobal: false });
				}
				return state;
			})().catch((error) => {
				state.promise = null;
				globalThis.__herdBootPromise = undefined;
				if (trace !== null) {
					void traceBootEvent("boot-error", { total: msSince(bootStarted), error: messageOf(error) });
				}
				throw error;
			});
			globalThis.__herdBootPromise = state.promise;
		}
	}
	return state.promise;
}

export default async function (extensionApi) {
	const trace = traceOn();
	const activateStarted = trace === null ? 0 : performance.now();
	let reusedBoot = false;
	pi = extensionApi;
	globalThis.__pi = pi;
	globalThis.__herdHost = { runSubagent };
	if (trace !== null) {
		const preview = bootState();
		reusedBoot =
			preview.promise !== null ||
			(globalThis.__herdBootPromise !== undefined && globalThis.__herdBootPromise !== null);
		void traceBootEvent("activate-start", {
			pid: process.pid,
			registered: preview.contextPis.has(extensionApi),
			reusedBoot,
			boots: preview.boots,
			runnerCaptured: globalThis[RUNNER_CAPTURE_KEY] === true,
		});
	}
	if (!globalThis[RUNNER_CAPTURE_KEY]) {
		globalThis[RUNNER_CAPTURE_KEY] = true;
		try {
			await installRunnerCapture();
			globalThis.__herdNative = { getRunner: getNativeRunner };
		} catch {
			globalThis.__herdNative = null;
		}
	}
	const state = await boot(extensionApi);
	if (typeof state.activateSession === "function") await state.activateSession(pi);
	if (!state.contextPis.has(pi)) {
		state.contextPis.add(pi);
		state.contextRegistrations += 1;
		hackContext(pi, (event, ctx) => {
			if (ctx !== undefined && ctx !== null) latestCtx = ctx;
			return state.handler(event, ctx);
		});
	}
	if (trace !== null) {
		void traceBootEvent("activate-end", {
			pid: process.pid,
			ms: msSince(activateStarted),
			registered: state.contextPis.has(pi),
			reusedBoot,
			boots: state.boots,
			contextRegistrations: state.contextRegistrations,
		});
	}
}
