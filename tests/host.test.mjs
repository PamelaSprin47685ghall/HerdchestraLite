/**
 * Dedicated tests for the host boundary.
 *
 * Covers `host/imports.mjs` (central imports, capability probes, Cherry
 * fail-closed), `host/health.mjs` (cross-entry registry), and
 * `host/subprocess.mjs` (role/model attribution, visibility, cancellation,
 * artifacts, and failure classification).
 *
 * No test starts a real model or subagent. The runtime is composed with
 * explicit ports, which is the same composition the assembly layer uses.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHealth, recordHealth } from "../src/host/health.mjs";
import { detectCapabilities, host, hostDiagnostics, inspectCherryModule, loadCherry } from "../src/host/imports.mjs";
import {
	abortTree,
	continueAgent,
	createAgentRuntime,
	FORBIDDEN_HOST_TOOLS,
	liveAgents,
	planSpawn,
	ROLE_MODEL_POLICY,
	readRoleToken,
	roleToken,
	spawnAgent,
} from "../src/host/subprocess.mjs";
import { LANGUAGE_SKILL } from "../src/prompts/runtime-wires.mjs";
import { isHerdError } from "../src/util/errors.mjs";

const HEALTH_KEY = Symbol.for("herdchestra.health.v1");
const temporaryDirectories = [];
let extensionPath;

function uniqueNonce() {
	return `nonce-${randomUUID()}`;
}

function temporaryDirectory() {
	const directory = mkdtempSync(join(tmpdir(), "herd-host-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

beforeEach(() => {
	const directory = temporaryDirectory();
	extensionPath = join(directory, "bootstrap-main.mjs");
	writeFileSync(extensionPath, "export default function bootstrap() {}\n");
	Object.defineProperty(globalThis, HEALTH_KEY, {
		value: undefined,
		enumerable: false,
		configurable: true,
		writable: true,
	});
});

afterEach(() => {
	while (temporaryDirectories.length > 0) {
		rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
	}
	delete globalThis[HEALTH_KEY];
});

function fakeSettings() {
	return {
		getStorage() {
			return null;
		},
		getModelRoles() {
			return {};
		},
	};
}

function fakeRegistry() {
	return {
		authStorage: {},
		hasConfiguredAuth() {
			return true;
		},
		getApiKey() {
			return undefined;
		},
	};
}

function spawnOptions(overrides = {}) {
	return {
		role: "Swarm Worker",
		name: "Worker-1",
		systemPrompt: "You are a sandbox worker.",
		task: "do the work",
		cwd: "/tmp",
		tools: ["clj_worker"],
		preloadedExtensionPaths: [extensionPath],
		roleNonce: uniqueNonce(),
		capabilities: { hasSetActiveTools: true, hasCtxAgent: true },
		settings: fakeSettings(),
		modelRegistry: fakeRegistry(),
		...overrides,
	};
}

function followUpAgent(overrides = {}) {
	return {
		name: "PlanDevOps-followup",
		description: "Plan DevOps: followup",
		systemPrompt: "You are a read-only DevOps investigator.",
		tools: ["clj_devops", "yield"],
		spawns: undefined,
		model: ["@task"],
		source: "project",
		...overrides,
	};
}

function expectFailure(result, code) {
	expect(result.ok).toBe(false);
	expect(isHerdError(result.error)).toBe(true);
	expect(result.error.code).toBe(code);
}

describe("host imports", () => {
	it("exposes a frozen host surface and honest diagnostics", () => {
		expect(Object.isFrozen(host)).toBe(true);
		expect(typeof host.Settings).toBe("function");
		expect(typeof host.runSubprocess).toBe("function");
		expect(typeof host.runSubagentFollowUpTurn).toBe("function");
		expect(typeof host.loadBundledAgents).toBe("function");
		expect(Object.isFrozen(host.piTui)).toBe(true);
		expect(Array.isArray(hostDiagnostics.missingExports)).toBe(true);
		expect(typeof hostDiagnostics.hostVersion === "string" || hostDiagnostics.hostVersion === undefined).toBe(true);
	});

	it("probes only public extension fields", () => {
		const pi = new Proxy(
			{
				setActiveTools() {},
				registerShortcut() {},
			},
			{
				get(target, property) {
					if (typeof property === "string" && property.startsWith("_")) {
						throw new Error(`private host field read: ${property}`);
					}
					return target[property];
				},
			},
		);
		const context = new Proxy(
			{
				ui: {
					setWidget() {},
					onTerminalInput() {},
				},
				sessionManager: {
					getArtifactsDir() {
						return null;
					},
					getSessionFile() {
						return undefined;
					},
				},
				modelRegistry: {},
			},
			{
				get(target, property) {
					if (typeof property === "string" && property.startsWith("_")) {
						throw new Error(`private host field read: ${property}`);
					}
					return target[property];
				},
			},
		);

		const capabilities = detectCapabilities(pi, context);
		expect(capabilities.hasSetActiveTools).toBe(true);
		expect(capabilities.hasRunSubagentFollowUpTurn).toBe(true);
		expect(capabilities.hasRegisterShortcut).toBe(true);
		expect(capabilities.hasSetWidget).toBe(true);
		expect(capabilities.hasOnTerminalInput).toBe(true);
		expect(capabilities.hasArtifactsDir).toBe(true);
		expect(capabilities.hasSessionFile).toBe(true);
		expect(capabilities.hasModelRegistry).toBe(true);
		expect(capabilities.hasHookWidget).toBe(false);
		expect(capabilities.hasRestrictToolNames).toBe(false);
		expect(capabilities.unverified).toContain("hasRestrictToolNames");
		expect(capabilities.unverified).toContain("hasToolCallInput");
	});

	it("reports context-dependent probes as false and unverified without a context", () => {
		const capabilities = detectCapabilities({});
		expect(capabilities.hasSetWidget).toBe(false);
		expect(capabilities.hasArtifactsDir).toBe(false);
		expect(capabilities.hasModelRegistry).toBe(false);
		expect(capabilities.unverified).toContain("hasSetWidget");
		expect(capabilities.unverified).toContain("hasCtxAgent");
	});

	it("accepts only explicit Spike facts for shape-dependent capabilities", () => {
		const eventBus = { emit() {}, on() {} };
		const capabilities = detectCapabilities({}, undefined, {
			hasToolCallInput: true,
			hasBeforeSubagentSpawn: true,
			hasTurnEnd: true,
			hasRestrictToolNames: true,
			hasCtxAgent: true,
			hasEventBus: true,
			eventBus,
		});
		expect(capabilities.hasToolCallInput).toBe(true);
		expect(capabilities.hasBeforeSubagentSpawn).toBe(true);
		expect(capabilities.hasTurnEnd).toBe(true);
		expect(capabilities.hasRestrictToolNames).toBe(true);
		expect(capabilities.hasCtxAgent).toBe(true);
		expect(capabilities.hasEventBus).toBe(true);
		expect(capabilities.unverified).not.toContain("hasRestrictToolNames");
	});

	it("treats a non-boolean fact as unverified instead of silently false", () => {
		const capabilities = detectCapabilities({}, undefined, { hasToolCallInput: "yes" });
		expect(capabilities.hasToolCallInput).toBe(false);
		expect(capabilities.unverified).toContain("hasToolCallInput");
	});

	it("inspects a Cherry namespace without importing it", () => {
		expect(inspectCherryModule(null)).toEqual({ hasEdnReader: false, version: undefined });
		expect(inspectCherryModule({ compileString() {} }, { version: "0.6.38" })).toEqual({
			hasEdnReader: false,
			version: "0.6.38",
		});
		expect(inspectCherryModule({ readString() {} }).hasEdnReader).toBe(true);
		expect(inspectCherryModule({ read() {}, VERSION: "1.2.3" })).toEqual({
			hasEdnReader: true,
			version: "1.2.3",
		});
		expect(
			inspectCherryModule({
				core: { Keyword() {}, PersistentVector() {}, map() {} },
				string: {},
				set: {},
				walk: {},
			}),
		).toEqual({ hasEdnReader: false, version: undefined });
		expect(inspectCherryModule({ core: { readString() {} } }).hasEdnReader).toBe(true);
	});

	it("loads Cherry once and reports failure as a value", async () => {
		const first = loadCherry();
		expect(loadCherry()).toBe(first);
		const result = await first;
		expect(typeof result.ok).toBe("boolean");
		if (result.ok) {
			expect(result.error).toBeUndefined();
			expect(Object.keys(result.cherry).sort()).toEqual(["core", "set", "string", "walk"]);
		} else {
			expect(result.cherry).toBeUndefined();
			expect(result.error.code).toBe(":HOST_API_MISMATCH");
			expect(result.error.data.module).toBe("cherry-cljs");
		}
	});
});

describe("host health", () => {
	it("records an ok entry and reads a sorted frozen snapshot", () => {
		expect(recordHealth({ entry: "tool-gate", status: "ok", version: "1.0.0" }).ok).toBe(true);
		expect(recordHealth({ entry: "main", status: "ok", version: "1.0.0" }).ok).toBe(true);

		const snapshot = readHealth();
		expect(snapshot.entries.map((entry) => entry.entry)).toEqual(["main", "tool-gate"]);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.entries)).toBe(true);
		expect(() => snapshot.entries.push({})).toThrow();
	});

	it("turns ok plus degradation into degraded", () => {
		const recorded = recordHealth({
			entry: "main",
			status: "ok",
			degraded: true,
			error: "cherry missing",
			capabilities: { cherryLoaded: false },
		});
		expect(recorded.ok).toBe(true);
		expect(recorded.entry.status).toBe("degraded");
		expect(recorded.entry.degraded).toBe(true);
		expect(recorded.entry.error).toBe("cherry missing");
	});

	it("fails closed when a required capability is missing", () => {
		const recorded = recordHealth({
			entry: "main",
			status: "ok",
			capabilities: { hasSetWidget: true, hasArtifactsDir: false },
			requiredCapabilities: ["hasSetWidget", "hasArtifactsDir"],
		});
		expect(recorded.ok).toBe(true);
		expect(recorded.entry.status).toBe("degraded");
		expect(recorded.entry.degraded).toBe(true);
		expect(recorded.entry.error).toContain("hasArtifactsDir");
		expect(recorded.entry.capabilities).toEqual({ hasSetWidget: true, hasArtifactsDir: false });
	});

	it("preserves capability arrays such as unverified", () => {
		const recorded = recordHealth({
			entry: "main",
			status: "ok",
			capabilities: { hasSetWidget: true, unverified: ["hasTurnEnd", "hasToolCallInput"] },
		});
		expect(recorded.ok).toBe(true);
		expect(recorded.entry.capabilities.unverified).toEqual(["hasTurnEnd", "hasToolCallInput"]);
		expect(Object.isFrozen(recorded.entry.capabilities.unverified)).toBe(true);
	});

	it("rejects malformed records without throwing or erasing a previous entry", () => {
		recordHealth({ entry: "main", status: "ok", version: "1.0.0" });

		for (const bad of [
			null,
			{},
			{ entry: "main" },
			{ entry: "bad name", status: "ok" },
			{ entry: "main", status: "unknown" },
			{ entry: "main", status: "ok", degraded: "yes" },
			{ entry: "main", status: "ok", version: 3 },
			{ entry: "main", status: "ok", capabilities: ["not", "flat"] },
			{ entry: "main", status: "ok", requiredCapabilities: "hasSetWidget" },
			{ entry: "main", status: "ok", requiredCapabilities: [3] },
		]) {
			const result = recordHealth(bad);
			expect(result.ok).toBe(false);
			expect(result.error.code).toBe(":INVALID_ARGUMENT");
		}

		const snapshot = readHealth();
		expect(snapshot.entries).toHaveLength(1);
		expect(snapshot.entries[0].version).toBe("1.0.0");
	});

	it("turns a failing starting entry into degraded", () => {
		const recorded = recordHealth({
			entry: "main",
			status: "starting",
			error: "host not ready",
		});
		expect(recorded.ok).toBe(true);
		expect(recorded.entry.status).toBe("degraded");
	});

	it("replaces an entry and advances updatedAt monotonically", () => {
		const first = recordHealth({ entry: "main", status: "ok", version: "1.0.0" });
		const second = recordHealth({ entry: "main", status: "degraded", version: "1.0.1" });
		expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
		const snapshot = readHealth();
		expect(snapshot.entries).toHaveLength(1);
		expect(snapshot.entries[0].version).toBe("1.0.1");
		expect(snapshot.entries[0].status).toBe("degraded");
	});

	it("repairs a corrupted registry instead of trusting it", () => {
		Object.defineProperty(globalThis, HEALTH_KEY, {
			value: 42,
			configurable: true,
			writable: true,
		});
		expect(readHealth()).toEqual({ entries: [], updatedAt: 0 });
		expect(recordHealth({ entry: "main", status: "ok" }).ok).toBe(true);
		expect(readHealth().entries).toHaveLength(1);
	});

	it("never throws when a stored entry is corrupt", () => {
		Object.defineProperty(globalThis, HEALTH_KEY, {
			value: { version: 1, entries: new Map([["broken", null]]), updatedAt: 5 },
			configurable: true,
			writable: true,
		});
		expect(readHealth()).toEqual({ entries: [], updatedAt: 5 });
	});
});

describe("role tokens", () => {
	it("round-trips a role token", () => {
		const token = roleToken("Swarm Worker", "nonce-12345678");
		expect(token).toBe("[HERD_ROLE: Swarm Worker nonce=nonce-12345678]");
		expect(readRoleToken(`${token}\nwork`)).toEqual({
			role: "Swarm Worker",
			nonce: "nonce-12345678",
			token,
		});
	});

	it("rejects unknown roles and weak nonces", () => {
		expect(() => roleToken("Worker", "nonce-12345678")).toThrow();
		expect(() => roleToken("Swarm Worker", "short")).toThrow();
		expect(() => roleToken("Swarm Worker", "has space")).toThrow();
		expect(readRoleToken(" [HERD_ROLE: Swarm Worker nonce=nonce-12345678]\nwork")).toBeUndefined();
		expect(readRoleToken("[HERD_ROLE: Worker nonce=nonce-12345678]\nwork")).toBeUndefined();
	});
});

describe("subagent planning", () => {
	it("builds a complete AgentDefinition and pins @task for a task role", () => {
		const plan = planSpawn(spawnOptions(), { agentId: "11111111-1111-1111-1111-111111111111" });
		expect(plan.ok).toBe(true);
		expect(plan.request.agent).toEqual({
			name: "Worker-1",
			description: "Swarm Worker: Worker-1",
			systemPrompt: "You are a sandbox worker.",
			tools: ["clj_worker", "yield"],
			spawns: undefined,
			model: ["@task"],
			source: "project",
		});
		expect(plan.request.task.split("\n")[0]).toBe(`[HERD_ROLE: Swarm Worker nonce=${plan.meta.roleNonce}]`);
		expect(plan.request.modelOverride).toEqual(["@task"]);
		expect(plan.request.restrictToolNames).toBe(false);
		expect(plan.request.preloadedExtensionPaths).toEqual([extensionPath]);
		expect(plan.meta.toolNarrowingRequired).toBe(true);
		expect(plan.meta.hubAutoAdded).toBe(true);
		expect(plan.meta.extensionSource).toBe("preloaded");
		expect(plan.request.enableMCP).toBe(false);
		expect(plan.request.enableLsp).toBe(false);
		expect(plan.request.enableIrc).toBe(false);
		expect(plan.request.persistArtifacts).toBe(false);
		expect(plan.request.sessionFile).toBeUndefined();
		expect(plan.meta.memoryOnly).toBe(true);
		expect(plan.meta.visibility).toBe("memory");
		expect(plan.meta.visibilityNote).toContain("visible only in memory");
	});

	it("plans a visible Manual Auditor with artifacts and strict output", () => {
		const directory = temporaryDirectory();
		const eventBus = { emit() {}, on() {} };
		const plan = planSpawn(
			spawnOptions({
				role: "Manual Auditor",
				name: "Auditor-1",
				tools: ["clj_auditor"],
				model: "anthropic/claude-sonnet-4-5",
				artifactsDir: directory,
				eventBus,
				outputSchema: { type: "object" },
			}),
			{ agentId: "22222222-2222-2222-2222-222222222222" },
		);
		expect(plan.ok).toBe(true);
		expect(plan.request.agent.model).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(plan.request.artifactsDir).toBe(directory);
		expect(plan.request.persistArtifacts).toBe(true);
		expect(plan.request.outputSchemaMode).toBe("strict");
		expect(plan.request.eventBus).toBe(eventBus);
		expect(plan.meta.visibility).toBe("hub");
		expect(plan.meta.visibilityNote).toBeUndefined();
		expect(plan.meta.artifacts).toEqual({
			dir: directory,
			sessionFile: join(directory, "22222222-2222-2222-2222-222222222222.jsonl"),
			outputPath: join(directory, "22222222-2222-2222-2222-222222222222.md"),
			persisted: true,
		});
	});

	it("accepts a ctx.model object as the explicit main-model pin", () => {
		const directory = temporaryDirectory();
		const plan = planSpawn(
			spawnOptions({
				role: "Reviewer",
				name: "Reviewer-1",
				model: { provider: "openai", id: "gpt-5" },
				tools: ["clj_review"],
				artifactsDir: directory,
			}),
		);
		expect(plan.ok).toBe(true);
		expect(plan.request.modelOverride).toEqual(["openai/gpt-5"]);
		expect(plan.request.agent.model).toEqual(["openai/gpt-5"]);
	});

	it("forwards a real parent sessionFile to the child session header", () => {
		const directory = temporaryDirectory();
		const parent = join(directory, "parent.jsonl");
		writeFileSync(parent, '{"type":"session","id":"parent"}\n');
		const plan = planSpawn(
			spawnOptions({
				sessionFile: parent,
				artifactsDir: directory,
			}),
		);
		expect(plan.ok).toBe(true);
		expect(plan.request.sessionFile).toBe(parent);
		expect(plan.meta.parentSessionFile).toBe(parent);
		expect(plan.meta.parentSessionNote).toContain("forwarded to the host");
	});

	it("keeps a memory-only child running when sessionFile has no artifactsDir", () => {
		const plan = planSpawn(spawnOptions({ sessionFile: "relative/parent.jsonl" }));
		expect(plan.ok).toBe(true);
		expect(plan.request.sessionFile).toBe("relative/parent.jsonl");
		expect(plan.meta.memoryOnly).toBe(true);
		expect(plan.meta.visibilityNote).toContain("visible only in memory");
		expect(plan.meta.parentSessionFile).toBe("relative/parent.jsonl");
		expect(plan.meta.parentSessionNote).toContain("no artifactsDir");
		expect(plan.meta.parentSessionNote).toContain("memory-only");
	});

	it("passes a host-provided sessionFile through without pre-validating it", () => {
		const directory = temporaryDirectory();
		const missing = join(directory, "missing.jsonl");
		const plan = planSpawn(spawnOptions({ sessionFile: missing, artifactsDir: directory }));
		expect(plan.ok).toBe(true);
		expect(plan.request.sessionFile).toBe(missing);
		expect(plan.meta.parentSessionFile).toBe(missing);
	});

	it("forwards the host's real parent lineage options without claiming a session-file parent link", () => {
		const plan = planSpawn(
			spawnOptions({
				parentAgentId: "parent-agent",
				parentToolCallId: "parent-call",
			}),
		);
		expect(plan.ok).toBe(true);
		expect(plan.request.parentAgentId).toBe("parent-agent");
		expect(plan.request.parentToolCallId).toBe("parent-call");
		expect(plan.request.sessionFile).toBeUndefined();
		expect(plan.meta.parentSessionFile).toBeNull();
		expect(plan.meta.parentSessionNote).toContain("no parent sessionFile");
		expect(plan.meta.agentLineage).toBe("registry");
		expect(plan.meta.parentAgentId).toBe("parent-agent");
		expect(plan.meta.parentToolCallId).toBe("parent-call");
	});

	it("reports no agent lineage when the caller supplies none", () => {
		const plan = planSpawn(spawnOptions());
		expect(plan.ok).toBe(true);
		expect(plan.meta.agentLineage).toBe("none");
		expect(plan.meta.parentAgentId).toBeNull();
		expect(plan.meta.parentToolCallId).toBeNull();
		expect(plan.request.parentAgentId).toBeUndefined();
	});

	it("reports hub-only parent grouping without claiming registry lineage", () => {
		const plan = planSpawn(spawnOptions({ parentToolCallId: "parent-call" }));
		expect(plan.ok).toBe(true);
		expect(plan.meta.agentLineage).toBe("hub");
		expect(plan.meta.parentAgentId).toBeNull();
		expect(plan.request.parentToolCallId).toBe("parent-call");
	});

	it("refuses a clj_ tool without preloaded extension paths", () => {
		expectFailure(planSpawn(spawnOptions({ preloadedExtensionPaths: undefined })), ":CAPABILITY_DENIED");
		expectFailure(
			planSpawn({ ...spawnOptions(), preloadedExtensionPaths: ["/nonexistent/herd-extension.mjs"] }),
			":INVALID_ARGUMENT",
		);
	});

	it("allows explicit extension discovery when the caller owns the risk", () => {
		const plan = planSpawn(
			spawnOptions({
				preloadedExtensionPaths: undefined,
				allowExtensionDiscovery: true,
			}),
		);
		expect(plan.ok).toBe(true);
		expect(plan.meta.extensionSource).toBe("discovery");
		expect(plan.request.preloadedExtensionPaths).toBeUndefined();
	});

	it("forwards preloaded custom tool paths", () => {
		const plan = planSpawn(
			spawnOptions({
				preloadedCustomToolPaths: [extensionPath],
			}),
		);
		expect(plan.ok).toBe(true);
		expect(plan.request.preloadedCustomToolPaths).toEqual([extensionPath]);
	});

	it("does not duplicate an existing matching role token", () => {
		const nonce = uniqueNonce();
		const token = roleToken("Swarm Worker", nonce);
		const plan = planSpawn(spawnOptions({ roleNonce: nonce, task: `${token}\nwork` }));
		expect(plan.ok).toBe(true);
		expect(plan.request.task).toBe(`${token}\nwork`);
	});

	it("accepts prompt as the task alias", () => {
		const options = spawnOptions({ task: undefined, prompt: "aliased work" });
		const plan = planSpawn(options);
		expect(plan.ok).toBe(true);
		expect(plan.request.task.endsWith("\naliased work")).toBe(true);
	});

	it("rejects model attribution violations", () => {
		expectFailure(planSpawn(spawnOptions({ role: "Plan", model: "openai/gpt-5" })), ":CAPABILITY_DENIED");
		expectFailure(planSpawn(spawnOptions({ role: "Coordinator", model: "openai/gpt-5" })), ":CAPABILITY_DENIED");
		expectFailure(planSpawn(spawnOptions({ role: "Reviewer", tools: ["clj_review"] })), ":CAPABILITY_DENIED");
		expectFailure(
			planSpawn(spawnOptions({ role: "Reviewer", tools: ["clj_review"], model: "@task" })),
			":CAPABILITY_DENIED",
		);
		expectFailure(planSpawn(spawnOptions({ model: "anthropic/claude-sonnet-4-5" })), ":CAPABILITY_DENIED");
		expectFailure(
			planSpawn(spawnOptions({ parentActiveModelPattern: "anthropic/claude-sonnet-4-5" })),
			":CAPABILITY_DENIED",
		);
	});

	it("requires a live settings instance and a model registry", () => {
		const noSettings = { ...spawnOptions(), settings: undefined };
		const plan = planSpawn(noSettings, {
			Settings: {
				get instance() {
					throw new Error("Settings not initialized");
				},
			},
		});
		expectFailure(plan, ":SETTINGS_UNAVAILABLE");

		const emptySettings = planSpawn(spawnOptions({ settings: {} }));
		expectFailure(emptySettings, ":SETTINGS_UNAVAILABLE");
		expect(emptySettings.error.data.missing).toEqual(["getStorage", "getModelRoles"]);

		const facade = planSpawn(spawnOptions({ settings: { get() {} } }));
		expectFailure(facade, ":SETTINGS_UNAVAILABLE");
		expect(facade.error.data.missing).toEqual(["getStorage", "getModelRoles"]);

		const hostile = new Proxy(
			{},
			{
				get() {
					throw new Error("settings proxy refused");
				},
			},
		);
		const hostilePlan = planSpawn(spawnOptions({ settings: hostile }));
		expectFailure(hostilePlan, ":SETTINGS_UNAVAILABLE");
		expect(hostilePlan.error.data.missing).toEqual(["getStorage", "getModelRoles"]);

		const instance = fakeSettings();
		const fallback = planSpawn(spawnOptions({ settings: { get() {} } }), {
			Settings: { instance },
		});
		expect(fallback.ok).toBe(true);
		expect(fallback.meta.settingsSource).toBe("instance-fallback");
		expect(fallback.request.settings).toBe(instance);

		const fromInstance = planSpawn(
			{ ...spawnOptions(), settings: undefined },
			{
				Settings: { instance },
			},
		);
		expect(fromInstance.ok).toBe(true);
		expect(fromInstance.meta.settingsSource).toBe("instance");
		expect(fromInstance.request.settings).toBe(instance);

		expectFailure(
			planSpawn(
				spawnOptions({
					settings: {
						...fakeSettings(),
						getModelRoles() {
							throw new Error("disposed");
						},
					},
				}),
			),
			":SETTINGS_UNAVAILABLE",
		);
		expectFailure(planSpawn(spawnOptions({ modelRegistry: {} })), ":HOST_API_MISMATCH");
	});

	it("fails closed on forbidden tools and widened surfaces", () => {
		expectFailure(planSpawn(spawnOptions({ capabilities: undefined })), ":INVALID_ARGUMENT");
		expectFailure(planSpawn(spawnOptions({ capabilities: { hasSetActiveTools: false } })), ":CAPABILITY_DENIED");
		expectFailure(
			planSpawn(spawnOptions({ capabilities: { hasSetActiveTools: true, hasCtxAgent: false } })),
			":CAPABILITY_DENIED",
		);
		expectFailure(planSpawn(spawnOptions({ capabilities: { hasSetActiveTools: true } })), ":CAPABILITY_DENIED");
		expectFailure(planSpawn(spawnOptions({ tools: ["bash", "clj_worker"] })), ":CAPABILITY_DENIED");
		expectFailure(planSpawn(spawnOptions({ tools: ["mcp__server__tool", "clj_worker"] })), ":CAPABILITY_DENIED");
		expectFailure(planSpawn(spawnOptions({ spawns: "*" })), ":CAPABILITY_DENIED");
		expectFailure(planSpawn(spawnOptions({ enableMCP: true })), ":CAPABILITY_DENIED");
		expectFailure(planSpawn(spawnOptions({ enableLsp: true })), ":CAPABILITY_DENIED");
		expectFailure(planSpawn(spawnOptions({ enableIrc: true })), ":CAPABILITY_DENIED");
		expectFailure(planSpawn(spawnOptions({ restrictToolNames: true })), ":CAPABILITY_DENIED");
		expect(FORBIDDEN_HOST_TOOLS).toContain("write");
	});

	it("rejects malformed role, identity, paths, and prompts", () => {
		expectFailure(planSpawn(spawnOptions({ role: "Worker" })), ":CAPABILITY_DENIED");
		expectFailure(planSpawn(spawnOptions({ name: "bad name" })), ":INVALID_ARGUMENT");
		expectFailure(planSpawn(spawnOptions({ roleNonce: "short" })), ":INVALID_ARGUMENT");
		expectFailure(planSpawn(spawnOptions({ cwd: "relative/path" })), ":INVALID_ARGUMENT");
		expectFailure(planSpawn(spawnOptions({ systemPrompt: "" })), ":INVALID_ARGUMENT");
		expectFailure(planSpawn(spawnOptions({ task: undefined, prompt: "" })), ":INVALID_ARGUMENT");
		expectFailure(planSpawn(spawnOptions({ task: "one", prompt: "two" })), ":INVALID_ARGUMENT");
		expectFailure(planSpawn(spawnOptions({ tools: [] })), ":INVALID_ARGUMENT");
		expectFailure(planSpawn(spawnOptions({ tools: ["clj_worker", "clj_worker"] })), ":INVALID_ARGUMENT");
		expectFailure(planSpawn(spawnOptions({ parentAgentId: "" })), ":INVALID_ARGUMENT");
		expectFailure(planSpawn(spawnOptions({ parentToolCallId: "" })), ":INVALID_ARGUMENT");
		expectFailure(
			planSpawn(spawnOptions({ roleNonce: "other-nonce-1", task: roleToken("Swarm Worker", "nonce-12345678") })),
			":INVALID_ARGUMENT",
		);
		expectFailure(
			planSpawn(
				spawnOptions({
					assignment: `${roleToken("Swarm Worker", "other-nonce-1")}\nbackground`,
				}),
			),
			":INVALID_ARGUMENT",
		);
		expectFailure(planSpawn(spawnOptions({ tools: ["read", "clj_worker"] })), ":CAPABILITY_DENIED");
	});

	it("accepts the skill-shaped language suffix in a system prompt without altering it", () => {
		const prompt = `You are a sandbox worker.\n${LANGUAGE_SKILL}`;
		const plan = planSpawn(spawnOptions({ systemPrompt: prompt }));
		expect(plan.ok).toBe(true);
		expect(plan.request.agent.systemPrompt).toBe(prompt);
		expect(plan.request.agent.systemPrompt).toContain('<skill version="1.0">');
	});

	it("forwards an explicit zero runtime cap instead of dropping it", () => {
		const plan = planSpawn(spawnOptions({ maxRuntimeMs: 0 }));
		expect(plan.ok).toBe(true);
		expect(plan.request.maxRuntimeMs).toBe(0);
	});

	it("does not throw when ports are null", () => {
		expect(() => planSpawn(spawnOptions({ role: "Worker" }), null)).not.toThrow();
	});

	it("requires visibility and artifacts when the role depends on them", () => {
		expectFailure(
			planSpawn(
				spawnOptions({
					role: "Manual Auditor",
					name: "Auditor-1",
					model: "openai/gpt-5",
					tools: ["clj_auditor"],
				}),
			),
			":HOST_API_MISMATCH",
		);

		const directory = temporaryDirectory();
		expectFailure(
			planSpawn(
				spawnOptions({
					role: "Manual Auditor",
					name: "Auditor-1",
					model: "openai/gpt-5",
					tools: ["clj_auditor"],
					artifactsDir: directory,
					visible: true,
				}),
			),
			":HOST_API_MISMATCH",
		);

		const filePath = join(directory, "not-a-directory");
		writeFileSync(filePath, "x");
		expectFailure(
			planSpawn(
				spawnOptions({
					role: "Reviewer",
					name: "Reviewer-1",
					model: "openai/gpt-5",
					tools: ["clj_review"],
					artifactsDir: filePath,
				}),
			),
			":HOST_API_MISMATCH",
		);
	});

	it("rejects a strict schema mode without a schema", () => {
		expectFailure(planSpawn(spawnOptions({ outputSchemaMode: "strict" })), ":INVALID_ARGUMENT");
		expectFailure(planSpawn(spawnOptions({ outputSchemaMode: "loose" })), ":INVALID_ARGUMENT");
	});
});

describe("subagent runtime", () => {
	function runtimeWith(executor, extra = {}) {
		return createAgentRuntime({
			Settings: { instance: fakeSettings() },
			runSubprocess: executor,
			...extra,
		});
	}

	it("passes an exact host request and classifies success", async () => {
		const requests = [];
		const settings = fakeSettings();
		const registry = fakeRegistry();
		const eventBus = { emit() {}, on() {} };
		const directory = temporaryDirectory();
		const runtime = runtimeWith(async (request) => {
			requests.push(request);
			return {
				exitCode: 0,
				output: "done",
				stderr: "",
				resolvedModel: "anthropic/claude-sonnet-4-5",
			};
		});

		const outcome = await runtime.spawn(
			spawnOptions({
				role: "Manual Auditor",
				name: "Auditor-1",
				tools: ["clj_auditor"],
				model: "anthropic/claude-sonnet-4-5",
				settings,
				modelRegistry: registry,
				artifactsDir: directory,
				eventBus,
				outputSchema: { type: "object" },
				parentAgentId: "parent-agent",
				parentToolCallId: "parent-call",
			}),
		);

		expect(outcome.ok).toBe(true);
		expect(outcome.resolvedModel).toBe("anthropic/claude-sonnet-4-5");
		expect(outcome.resolvedModelIsFallback).toBe(false);
		expect(outcome.visibility).toBe("hub");
		expect(outcome.memoryOnly).toBe(false);
		expect(outcome.parentSessionFile).toBeNull();
		expect(outcome.parentSessionNote).toContain("no parent sessionFile");
		expect(outcome.parentAgentId).toBe("parent-agent");
		expect(outcome.parentToolCallId).toBe("parent-call");
		expect(outcome.agentLineage).toBe("registry");
		expect(outcome.eventBus).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0].settings).toBe(settings);
		expect(requests[0].modelRegistry).toBe(registry);
		expect(requests[0].eventBus).toBe(eventBus);
		expect(requests[0].artifactsDir).toBe(directory);
		expect(requests[0].sessionFile).toBeUndefined();
		expect(requests[0].parentAgentId).toBe("parent-agent");
		expect(requests[0].parentToolCallId).toBe("parent-call");
		expect(requests[0].persistArtifacts).toBe(true);
		expect(requests[0].outputSchemaMode).toBe("strict");
		expect(requests[0].restrictToolNames).toBe(false);
		expect(requests[0].preloadedExtensionPaths).toEqual([extensionPath]);
	});

	it("composes deterministic identity and time ports", async () => {
		const runtime = createAgentRuntime({
			Settings: { instance: fakeSettings() },
			runSubprocess: async () => ({
				exitCode: 0,
				output: "",
				stderr: "",
				resolvedModel: "model/x",
			}),
			randomUUID: () => "fixed-agent-id",
			now: () => 1234,
		});
		const started = runtime.start(spawnOptions());
		expect(started.handle.agentId).toBe("fixed-agent-id");
		expect(started.handle.startedAt).toBe(1234);
		expect((await started.done).agentId).toBe("fixed-agent-id");
	});

	it("fails closed on an unauthorized model fallback", async () => {
		const runtime = runtimeWith(async () => ({
			exitCode: 0,
			output: "",
			stderr: "",
			resolvedModel: "other/model",
			resolvedModelIsFallback: true,
		}));
		const options = spawnOptions();
		const outcome = await runtime.spawn(options);
		expectFailure(outcome, ":MODEL_FALLBACK");
		expect(outcome.resolvedModel).toBe("other/model");
	});

	it("honors an explicit fallback authorization", async () => {
		const runtime = runtimeWith(async () => ({
			exitCode: 0,
			output: "",
			stderr: "",
			resolvedModel: "other/model",
			resolvedModelIsFallback: true,
		}));
		const outcome = await runtime.spawn(spawnOptions({ allowModelFallback: true }));
		expect(outcome.ok).toBe(true);
		expect(outcome.resolvedModelIsFallback).toBe(true);
	});

	it("classifies executor failures without losing the slot identity", async () => {
		const runtime = runtimeWith(async () => ({
			exitCode: 2,
			output: "",
			stderr: "boom",
			resolvedModel: "model/x",
		}));
		const options = spawnOptions();
		const outcome = await runtime.spawn(options);
		expectFailure(outcome, ":AGENT_SPAWN_FAILED");
		expect(outcome.error.data.exitCode).toBe(2);
		expect(outcome.error.data.stderr).toBe("boom");
		expect(typeof outcome.agentId).toBe("string");
	});

	it("classifies a thrown executor as a spawn failure", async () => {
		const runtime = runtimeWith(async () => {
			throw new Error("executor exploded");
		});
		const options = spawnOptions();
		const outcome = await runtime.spawn(options);
		expectFailure(outcome, ":AGENT_SPAWN_FAILED");
		expect(outcome.error.data.cause).toContain("executor exploded");
	});

	it("refuses results without model attribution", async () => {
		const runtime = runtimeWith(async () => ({ exitCode: 0, output: "", stderr: "" }));
		const outcome = await runtime.spawn(spawnOptions());
		expectFailure(outcome, ":HOST_API_MISMATCH");
	});

	it("fails closed when the host executor is missing", async () => {
		const runtime = createAgentRuntime({
			Settings: { instance: fakeSettings() },
			runSubprocess: null,
		});
		const outcome = await runtime.spawn(spawnOptions());
		expectFailure(outcome, ":HOST_API_MISMATCH");
		expect(outcome.error.data.capability).toBe("runSubprocess");
	});

	it("fails closed when Settings.instance is not initialized", async () => {
		const runtime = createAgentRuntime({
			Settings: {
				get instance() {
					throw new Error("not initialized");
				},
			},
			runSubprocess: async () => ({ exitCode: 0, output: "", stderr: "", resolvedModel: "m" }),
		});
		const outcome = await runtime.spawn({ ...spawnOptions(), settings: undefined });
		expectFailure(outcome, ":SETTINGS_UNAVAILABLE");
	});

	it("cancels a live subagent and reports it as aborted", async () => {
		let observedSignal;
		const runtime = runtimeWith(
			(request) =>
				new Promise((resolve) => {
					observedSignal = request.signal;
					request.signal.addEventListener(
						"abort",
						() =>
							resolve({
								exitCode: 1,
								output: "",
								stderr: "cancelled",
								resolvedModel: "model/x",
								aborted: true,
								abortReason: "signal",
							}),
						{ once: true },
					);
				}),
		);

		const options = spawnOptions();
		const started = runtime.start(options);
		expect(runtime.liveAgents()).toHaveLength(1);
		const cancelled = abortTree(started.handle, "test cancellation");
		expect(cancelled.aborted).toBe(true);
		expect(cancelled.agentIds).toEqual([started.handle.agentId]);
		expect(observedSignal.aborted).toBe(true);

		const outcome = await started.done;
		expectFailure(outcome, ":UPSTREAM_ABORTED");
		expect(outcome.error.data.reason).toBe("test cancellation");
		expect(runtime.liveAgents()).toHaveLength(0);
		expect(abortTree(started.handle, "again").aborted).toBe(false);
	});

	it("cancels descendants parent-first", async () => {
		const runtime = runtimeWith(
			(request) =>
				new Promise((resolve) => {
					request.signal.addEventListener(
						"abort",
						() =>
							resolve({
								exitCode: 1,
								output: "",
								stderr: "",
								resolvedModel: "model/x",
								aborted: true,
								abortReason: "signal",
							}),
						{ once: true },
					);
				}),
		);

		const parent = runtime.start(spawnOptions({ name: "Worker-1" }));
		const child = runtime.start(spawnOptions({ role: "Swarm Holder", name: "Holder-1", parent: parent.handle }));
		expect(runtime.liveAgents()).toHaveLength(2);

		const cancelled = abortTree(parent.handle, "tree cancellation");
		expect(cancelled.aborted).toBe(true);
		expect(cancelled.agentIds).toHaveLength(2);
		expect(cancelled.agentIds[1]).toBe(child.handle.agentId);

		const [parentOutcome, childOutcome] = await Promise.all([parent.done, child.done]);
		expectFailure(parentOutcome, ":UPSTREAM_ABORTED");
		expectFailure(childOutcome, ":UPSTREAM_ABORTED");
		expect(runtime.liveAgents()).toHaveLength(0);
	});

	it("aborts a child when its parent finishes first", async () => {
		let parentEntered;
		const parentStarted = new Promise((resolve) => {
			parentEntered = resolve;
		});
		const runtime = runtimeWith(async (request) => {
			if (request.agent.name === "Worker-Parent") {
				parentEntered();
				await new Promise((resolve) => setTimeout(resolve, 0));
				return { exitCode: 0, output: "done", stderr: "", resolvedModel: "model/x" };
			}
			return new Promise((resolve) => {
				request.signal.addEventListener(
					"abort",
					() =>
						resolve({
							exitCode: 1,
							output: "",
							stderr: "",
							resolvedModel: "model/x",
							aborted: true,
							abortReason: "signal",
						}),
					{ once: true },
				);
			});
		});

		const parent = runtime.start(spawnOptions({ name: "Worker-Parent" }));
		await parentStarted;
		const child = runtime.start(spawnOptions({ role: "Swarm Holder", name: "Holder-Child", parent: parent.handle }));
		const parentOutcome = await parent.done;
		expect(parentOutcome.ok).toBe(true);
		const childOutcome = await child.done;
		expectFailure(childOutcome, ":UPSTREAM_ABORTED");
		expect(runtime.liveAgents()).toHaveLength(0);
	});

	it("rejects invalid and finished parents", async () => {
		const runtime = runtimeWith(async () => ({
			exitCode: 0,
			output: "",
			stderr: "",
			resolvedModel: "model/x",
		}));
		const invalid = await runtime.start(spawnOptions({ parent: {} })).done;
		expectFailure(invalid, ":INVALID_ARGUMENT");

		const parent = runtime.start(spawnOptions({ name: "Worker-Parent" }));
		await parent.done;
		const child = runtime.start(spawnOptions({ role: "Swarm Holder", name: "Holder-Child", parent: parent.handle }));
		const outcome = await child.done;
		expectFailure(outcome, ":INVALID_ARGUMENT");
		expect(outcome.error.data.parentAgentId).toBe(parent.handle.agentId);
	});

	it("aborts on timeout and names the limit", async () => {
		const runtime = runtimeWith(
			(request) =>
				new Promise((resolve) => {
					request.signal.addEventListener(
						"abort",
						() =>
							resolve({
								exitCode: 1,
								output: "",
								stderr: "",
								resolvedModel: "model/x",
								aborted: true,
								abortReason: "timeout",
							}),
						{ once: true },
					);
				}),
		);
		const outcome = await runtime.spawn(spawnOptions({ timeoutMs: 10 }));
		expectFailure(outcome, ":UPSTREAM_ABORTED");
		expect(outcome.error.data.reason).toContain("timeout");
		expect(outcome.error.data.timeoutMs).toBe(10);
	});

	it("returns the same classified failure from spawnAgent when planning fails", async () => {
		const outcome = await spawnAgent(spawnOptions({ role: "Worker" }));
		expectFailure(outcome, ":CAPABILITY_DENIED");
	});

	it("exports a live-agent snapshot reader", () => {
		expect(Array.isArray(liveAgents())).toBe(true);
	});
});

describe("follow-up turn", () => {
	it("rejects a parent path as the child id and fails closed without the host function", async () => {
		const options = {
			id: "/tmp/parent.jsonl",
			agent: followUpAgent(),
			message: "continue",
		};
		expectFailure(await continueAgent(options, { runSubagentFollowUpTurn: async () => ({}) }), ":INVALID_ARGUMENT");
		expectFailure(
			await continueAgent({ ...options, id: "PlanDevOps-abc" }, { runSubagentFollowUpTurn: null }),
			":CAPABILITY_DENIED",
		);
	});

	it("does not revive a session for a pre-aborted turn", async () => {
		const controller = new AbortController();
		controller.abort("already cancelled");
		let calls = 0;
		const outcome = await continueAgent(
			{
				id: "PlanDevOps-abc",
				agent: followUpAgent(),
				message: "continue",
				signal: controller.signal,
			},
			{
				runSubagentFollowUpTurn: async () => {
					calls++;
					return {};
				},
			},
		);
		expect(calls).toBe(0);
		expectFailure(outcome, ":UPSTREAM_ABORTED");
	});

	it("fails closed on unknown ids, missing model attribution, and unauthorized fallback", async () => {
		const unknown = await continueAgent(
			{ id: "PlanDevOps-gone", agent: followUpAgent(), message: "continue" },
			{
				runSubagentFollowUpTurn: async () => {
					throw new Error('Unknown agent "PlanDevOps-gone" — it was never registered or has been released.');
				},
			},
		);
		expectFailure(unknown, ":AGENT_SPAWN_FAILED");
		expect(unknown.error.data.reason).toBe("unknown-agent");

		const missingModel = await continueAgent(
			{ id: "PlanDevOps-abc", agent: followUpAgent(), message: "continue" },
			{ runSubagentFollowUpTurn: async () => ({ id: "PlanDevOps-abc", exitCode: 0, output: "" }) },
		);
		expectFailure(missingModel, ":HOST_API_MISMATCH");

		const fallback = await continueAgent(
			{ id: "PlanDevOps-abc", agent: followUpAgent(), message: "continue" },
			{
				runSubagentFollowUpTurn: async () => ({
					id: "PlanDevOps-abc",
					exitCode: 0,
					output: "",
					resolvedModel: "other/model",
					resolvedModelIsFallback: true,
				}),
			},
		);
		expectFailure(fallback, ":MODEL_FALLBACK");

		const allowed = await continueAgent(
			{ id: "PlanDevOps-abc", agent: followUpAgent(), message: "continue", allowModelFallback: true },
			{
				runSubagentFollowUpTurn: async () => ({
					id: "PlanDevOps-abc",
					exitCode: 0,
					output: "",
					resolvedModel: "other/model",
					resolvedModelIsFallback: true,
				}),
			},
		);
		expect(allowed.ok).toBe(true);
		expect(allowed.resolvedModelIsFallback).toBe(true);
	});
});

describe("role policy", () => {
	it("keeps main and task attribution explicit", () => {
		expect(ROLE_MODEL_POLICY.Plan.modelSource).toBe("main");
		expect(ROLE_MODEL_POLICY["Plan DevOps"].modelSource).toBe("task");
		expect(ROLE_MODEL_POLICY.Reviewer.modelSource).toBe("main");
		expect(ROLE_MODEL_POLICY["Swarm Worker"].modelSource).toBe("task");
		expect(ROLE_MODEL_POLICY["Swarm Holder"].modelSource).toBe("task");
		expect(ROLE_MODEL_POLICY["Manual Auditor"].modelSource).toBe("main");
		expect(ROLE_MODEL_POLICY["Blocker Oracle"].modelSource).toBe("main");
	});
});
