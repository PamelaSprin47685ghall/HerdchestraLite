/**
 * The only place where HerdchestraLite touches the omp host package.
 *
 * Every external package import lives here. Domain modules import `host`,
 * `detectCapabilities`, or `hostDiagnostics` from this module, so
 * a host version drift has exactly one landing place.
 *
 * One deliberate exception patches a host prototype: `native-runner.mjs`
 * wraps `ExtensionRunner.prototype.createContext` so the extension can keep a
 * reference to the live runner and delegate to its public `invokeNativeTool`.
 * The host exposes no other supported route to the native built-ins. The
 * capture is lazy because the runner module's source graph is not importable
 * outside the host; a failed import is reported and the sandbox fails closed.
 * The implementation lives in its own narrow module so sandbox-only tests do
 * not pull the host package root; this file re-exports it. Everything else
 * here reads only public fields and never invents a capability. The exception,
 * its observed host version, and its rollback live in HACK.md.
 *
 * The omp extension loader rewrites host specifiers. Loading this module with
 * plain Node or Bun outside omp resolves the installed host package if one is
 * reachable; when it is not, the import fails before any plugin code runs.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as codingAgent from "@oh-my-pi/pi-coding-agent";

const HOST_PACKAGE = "@oh-my-pi/pi-coding-agent";

/* ------------------------------------------------------------------ */
/* Native tool runner capture                                          */
/* ------------------------------------------------------------------ */

// Implementation lives in `native-runner.mjs`; re-exported here as the single
// host-boundary surface.
export {
	getNativeRunner,
	installRunnerCapture,
	restoreRunnerCapture,
	runnerCaptureStatus,
	runnerForContext,
} from "./native-runner.mjs";

const { AgentSession, Container, Markdown, Settings, Spacer, Text, VERSION, runSubprocess, runSubagentFollowUpTurn } =
	codingAgent;

/**
 * Resolve a public host specifier to the file the host will actually load.
 *
 * Returns `undefined` when the runtime cannot resolve the specifier; this is a
 * report, not a failure, because a compiled host may embed its modules.
 *
 * @param {string} specifier
 * @returns {string | undefined}
 */
function resolvePath(specifier) {
	try {
		const resolved = import.meta.resolve(specifier);
		if (typeof resolved !== "string") return undefined;
		if (resolved.startsWith("file:")) return fileURLToPath(resolved);
		return resolved;
	} catch {
		return undefined;
	}
}

/**
 * Read the `package.json` that owns a resolved module path.
 *
 * Inputs: a file path inside an installed package.
 * Output: `{ path, version }`, or `undefined` when no readable package metadata
 * is found before the filesystem root.
 *
 * @param {string | undefined} modulePath
 * @returns {Promise<{ path: string, version: string } | undefined>}
 */
async function packageMetadata(modulePath) {
	if (typeof modulePath !== "string" || modulePath.length === 0) return undefined;
	let directory = dirname(modulePath);
	for (let depth = 0; depth < 12; depth += 1) {
		const candidate = join(directory, "package.json");
		try {
			const parsed = JSON.parse(await readFile(candidate, "utf8"));
			if (typeof parsed.version === "string" && parsed.version.length > 0) {
				return { path: candidate, version: parsed.version };
			}
		} catch {
			// Keep walking; a missing package.json is normal for nested paths.
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return undefined;
}

const hostModulePath = resolvePath(HOST_PACKAGE);
const hostPackageMetadata = await packageMetadata(hostModulePath);
const hostVersion = typeof VERSION === "string" ? VERSION : undefined;
const cliVersion =
	typeof process.env.OMP_VERSION === "string" && process.env.OMP_VERSION.length > 0
		? process.env.OMP_VERSION
		: hostVersion;
const runtimePackageVersion = hostPackageMetadata?.version;

/**
 * Where `loadBundledAgents` came from.
 *
 * @type {"task/agents" | "task" | "none"}
 */
let bundledAgentsSource = "none";
/** @type {string | undefined} */
let bundledAgentsError;

/**
 * Resolve the bundled agent roster through public subpaths.
 *
 * `task/agents` wins. The older `task` namespace exposes the same function as
 * `BUNDLED_AGENTS`; that is the fallback. A host that exposes neither yields
 * `undefined` instead of inventing a roster. Resolution errors are recorded in
 * `hostDiagnostics` and never thrown from here.
 *
 * @returns {Promise<(() => unknown[]) | undefined>}
 */
async function resolveBundledAgentsLoader() {
	try {
		const agents = await import("@oh-my-pi/pi-coding-agent/task/agents");
		if (typeof agents.loadBundledAgents === "function") {
			bundledAgentsSource = "task/agents";
			return agents.loadBundledAgents;
		}
	} catch (error) {
		bundledAgentsError = error instanceof Error ? error.message : String(error);
	}
	try {
		const task = await import("@oh-my-pi/pi-coding-agent/task");
		if (typeof task.BUNDLED_AGENTS === "function") {
			bundledAgentsSource = "task";
			return task.BUNDLED_AGENTS;
		}
	} catch (error) {
		if (bundledAgentsError === undefined) {
			bundledAgentsError = error instanceof Error ? error.message : String(error);
		}
	}
	return undefined;
}

const loadBundledAgents = await resolveBundledAgentsLoader();

/**
 * Public TUI primitives the host re-exports. A single source keeps the plugin
 * from importing `@oh-my-pi/pi-tui` directly.
 */
const piTui = Object.freeze({ Container, Markdown, Spacer, Text });

/**
 * The host surface HerdchestraLite may use.
 *
 * `undefined` members mean the running host did not export them. They are not
 * replaced with local stand-ins; callers must fail closed.
 */
export const host = Object.freeze({
	AgentSession,
	Settings,
	runSubprocess,
	runSubagentFollowUpTurn,
	loadBundledAgents,
	piTui,
});

const missingHostExports = Object.freeze(
	[
		["AgentSession", AgentSession],
		["Settings", Settings],
		["runSubprocess", runSubprocess],
		["runSubagentFollowUpTurn", runSubagentFollowUpTurn],
		["loadBundledAgents", loadBundledAgents],
	]
		.filter(([, value]) => value === undefined)
		.map(([name]) => name),
);

/**
 * Facts about the host package that cannot be expressed as booleans.
 *
 * Inputs: none; captured once at module load.
 * Output: a frozen record. `runtimePackageVersion` and `typesPackageVersion`
 * are the installed package metadata; `hostVersion` is the `VERSION` constant
 * exported by the running code. They legitimately differ when the host runs a
 * compiled binary whose package directory still carries an older version.
 */
export const hostDiagnostics = Object.freeze({
	module: HOST_PACKAGE,
	resolvedPath: hostModulePath,
	packageJsonPath: hostPackageMetadata?.path,
	hostVersion,
	cliVersion,
	runtimePackageVersion,
	typesPackageVersion: runtimePackageVersion,
	bundledAgentsSource,
	bundledAgentsError,
	missingExports: missingHostExports,
});

/* ------------------------------------------------------------------ */
/* Capability probes                                                   */
/* ------------------------------------------------------------------ */

/** @param {unknown} value */
function isObjectLike(value) {
	return value !== null && (typeof value === "object" || typeof value === "function");
}

/**
 * Whether the host Settings singleton is initialized.
 *
 * Reading `Settings.instance` is the public probe; the getter throws before
 * initialization, so the throw is the answer.
 */
function settingsInstanceAvailable() {
	try {
		return isObjectLike(Settings.instance);
	} catch {
		return false;
	}
}

/**
 * Probe host capabilities from public extension surfaces.
 *
 * Inputs:
 * - `pi`: the `ExtensionAPI` object passed to an extension factory.
 * - `context`: an `ExtensionContext`, when one is available. Context-dependent
 *   probes are `false` without it.
 * - `observed`: facts already verified by a real Spike or host experiment.
 *   Only an explicit `true` turns a shape-dependent capability on. Supported
 *   keys: `hasToolCallInput`, `hasBeforeSubagentSpawn`, `hasTurnEnd`,
 *   `hasEventBus`, `hasRestrictToolNames`, `hasCtxAgent`.
 *
 * Output: a frozen capability table. Keys named `has*` are booleans, never
 * `undefined`. `unverified` names every capability this call could not observe.
 * No host object is modified and no private property is read.
 *
 * @param {unknown} pi
 * @param {unknown} [context]
 * @param {Record<string, unknown>} [observed]
 */
export function detectCapabilities(pi, context, observed = {}) {
	const api = isObjectLike(pi) ? pi : {};
	const ctx = isObjectLike(context) ? context : undefined;
	const facts = isObjectLike(observed) ? observed : {};
	/** @type {string[]} */
	const unverified = [];

	/**
	 * A fact is trusted only when it is exactly `true`. A defined non-boolean
	 * value is reported as unverified instead of being silently read as false.
	 *
	 * @param {string} name
	 */
	const fact = (name, markMissing = false) => {
		const value = facts[name];
		if (value === true) return true;
		if (value !== undefined) unverified.push(name);
		else if (markMissing) unverified.push(name);
		return false;
	};

	const observedCtxAgent = ctx !== undefined && ctx.agent !== undefined && ctx.agent !== null;
	const hasCtxAgent = fact("hasCtxAgent") || observedCtxAgent;
	if (facts.hasCtxAgent === undefined && ctx === undefined) unverified.push("hasCtxAgent");

	const hasSetWidget = typeof ctx?.ui?.setWidget === "function";
	const hasOnTerminalInput = typeof ctx?.ui?.onTerminalInput === "function";
	if (ctx === undefined) {
		unverified.push("hasSetWidget", "hasOnTerminalInput");
	}

	const hasArtifactsDir = typeof ctx?.sessionManager?.getArtifactsDir === "function";
	const hasSessionFile = typeof ctx?.sessionManager?.getSessionFile === "function";
	if (ctx === undefined) {
		unverified.push("hasArtifactsDir", "hasSessionFile");
	}

	const eventBus = facts.eventBus;
	const hasEventBus =
		fact("hasEventBus") ||
		(isObjectLike(eventBus) && typeof eventBus.emit === "function" && typeof eventBus.on === "function");
	if (facts.hasEventBus === undefined && !isObjectLike(eventBus)) unverified.push("hasEventBus");

	const table = {
		hostPackageVersion: hostVersion ?? runtimePackageVersion,
		cliVersion,
		runtimePackageVersion,
		typesPackageVersion: runtimePackageVersion,
		hasToolCallInput: fact("hasToolCallInput", true),
		hasCtxAgent,
		hasBeforeSubagentSpawn: fact("hasBeforeSubagentSpawn", true),
		hasTurnEnd: fact("hasTurnEnd", true),
		hasSetWidget,
		hasHookWidget: typeof ctx?.ui?.setHookWidget === "function",
		hasOnTerminalInput,
		hasRegisterShortcut: typeof api.registerShortcut === "function",
		hasSetActiveTools: typeof api.setActiveTools === "function",
		hasEventBus,
		hasArtifactsDir,
		hasModelRegistry: isObjectLike(ctx?.modelRegistry),
		hasSessionFile,
		hasSettingsInstance: settingsInstanceAvailable(),
		hasRestrictToolNames: fact("hasRestrictToolNames", true),
		hasRunSubagentFollowUpTurn: typeof runSubagentFollowUpTurn === "function",
		unverified: Object.freeze([...new Set(unverified)]),
	};
	return Object.freeze(table);
}

/**
 * Re-export the extension API types for local JSDoc only.
 *
 * @typedef {import("@oh-my-pi/pi-coding-agent").ExtensionAPI} ExtensionAPI
 * @typedef {import("@oh-my-pi/pi-coding-agent").ExtensionContext} ExtensionContext
 * @typedef {import("@oh-my-pi/pi-coding-agent").ExtensionCommandContext} ExtensionCommandContext
 */
