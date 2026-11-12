import { afterEach, describe, expect, it } from "bun:test";
import { readHealth } from "../src/host/health.mjs";
import { ledgerFor } from "../src/scope/ledger.mjs";
import activate, {
	configureToolGate,
	MISSION_PORT_SYMBOL,
	ROLE_SURFACE_SYMBOL,
	readCallMeta,
	writeCallMeta,
} from "../src/tool-gate/index.mjs";

const THINK = "must_think_in";
const WORKERS = "how_many_more_workers_are_allowed_without_hitting_mythical_man_month";
const INTENT = "intent";
const SCOPE = "scope";

const ORIGINAL_OMP_VERSION = process.env.OMP_VERSION;
const ORIGINAL_TOOL_CALL_INPUT = process.env.HERD_TOOL_CALL_INPUT;

function fakePi() {
	const handlers = new Map();
	const activeTools = [];
	const allTools = [
		"abandon_slice",
		"ask-previous-scope",
		"askPreviousScope",
		"ask_previous_scope",
		"ask_user",
		"assume",
		"bash",
		"board_cancel",
		"board_claim",
		"board_comment",
		"board_finish",
		"board_park_slot",
		"board_release",
		"board_reopen",
		"board_replace",
		"board_split",
		"board_take_or_die",
		"board_update",
		"clj_auditor",
		"clj_devops",
		"clj_review",
		"clj_worker",
		"custom_tool",
		"edit",
		"hub",
		"lsp_x",
		"mcp__x",
		"read",
		"submit_case_audit",
		"submit_devops_report",
		"submit_oracle_advice",
		"submit_review",
		"task",
		"write",
		"yield",
	];
	return {
		handlers,
		activeTools,
		pi: {
			on(name, handler) {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
			getActiveTools() {
				return allTools;
			},
			async setActiveTools(names) {
				activeTools.push([...names]);
			},
		},
	};
}

function emit(handlers, name, event, ctx) {
	let result;
	for (const handler of handlers.get(name) ?? []) {
		const next = handler(event, ctx);
		if (next !== undefined) result = next;
	}
	return result;
}

function ctxFor(sessionId, agentId = "agent-1", kind = "main") {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => `/tmp/${sessionId}.jsonl`,
		},
		agent: { kind, id: agentId, name: agentId, depth: kind === "sub" ? 1 : 0 },
	};
}

function resetInput(goal = "goal", budget = 5) {
	return {
		[THINK]: "zh-cn",
		[INTENT]: "推进",
		[SCOPE]: {
			kind: "resetScope",
			new_scope_goal: goal,
			new_scope_retention_budget: budget,
		},
		query: "x",
	};
}

function keepLastInput() {
	return {
		[THINK]: "zh-cn",
		[INTENT]: "继续",
		[SCOPE]: { kind: "keepLast" },
	};
}

function meTooInput() {
	return {
		[THINK]: "zh-cn",
		[INTENT]: "并行",
		[SCOPE]: { kind: "meToo" },
	};
}

function callTool(handlers, ctx, toolName, toolCallId, input) {
	return emit(handlers, "tool_call", { toolName, toolCallId, input }, ctx);
}

let roleNonceSequence = 0;

function nextNonce() {
	roleNonceSequence += 1;
	return `nonce-${roleNonceSequence}-12345678`;
}

function roleToken(role, nonce = nextNonce()) {
	return `[HERD_ROLE: ${role} nonce=${nonce}]`;
}

const BOARD_TOOLS = [
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
];

const TEST_ROLE_SURFACES = Object.freeze({
	"Plan DevOps": Object.freeze(["clj_devops", "submit_devops_report"]),
	Reviewer: Object.freeze(["clj_review", "submit_review", "ask_user"]),
	"Swarm Worker": Object.freeze(["clj_worker", ...BOARD_TOOLS]),
	"Swarm Holder": Object.freeze(["clj_worker", ...BOARD_TOOLS, "abandon_slice"]),
	"Manual Auditor": Object.freeze(["clj_auditor", "submit_case_audit"]),
	"Blocker Oracle": Object.freeze(["clj_review", "submit_oracle_advice"]),
});

function publishRoleSurfaces() {
	if (globalThis[ROLE_SURFACE_SYMBOL] === undefined) {
		globalThis[ROLE_SURFACE_SYMBOL] = TEST_ROLE_SURFACES;
	}
}

function startRole(handlers, ctx, role, nonce = nextNonce()) {
	if (ctx.agent) ctx.agent.kind = "sub";
	publishRoleSurfaces();
	return emit(handlers, "before_agent_start", { reason: "prompt", prompt: `${roleToken(role, nonce)}\nTask` }, ctx);
}

function healthEntry() {
	return readHealth().entries.find((entry) => entry.entry === "tool-gate");
}

afterEach(() => {
	configureToolGate({ includeWorkers: true });
	delete globalThis[MISSION_PORT_SYMBOL];
	delete globalThis[ROLE_SURFACE_SYMBOL];
	if (ORIGINAL_OMP_VERSION === undefined) delete process.env.OMP_VERSION;
	else process.env.OMP_VERSION = ORIGINAL_OMP_VERSION;
	if (ORIGINAL_TOOL_CALL_INPUT === undefined) delete process.env.HERD_TOOL_CALL_INPUT;
	else process.env.HERD_TOOL_CALL_INPUT = ORIGINAL_TOOL_CALL_INPUT;
});

describe("activation", () => {
	it("registers the gate hooks and records healthy capabilities", () => {
		const { pi, handlers } = fakePi();

		activate(pi);

		for (const name of [
			"before_provider_request",
			"tool_call",
			"before_agent_start",
			"turn_start",
			"turn_end",
			"agent_end",
			"tool_execution_end",
		]) {
			expect(handlers.has(name)).toBe(true);
		}
		const entry = healthEntry();
		expect(entry.status).toBe("ok");
		expect(entry.capabilities.hasToolCallInput).toBe(true);
		expect(entry.capabilities.toolCallGate).toBe(true);
		expect(entry.capabilities.scopeLedger).toBe(true);
		expect(entry.capabilities.agentEndReady).toBe(true);
	});

	it("records a failed entry for a host without on()", () => {
		expect(() => activate(null)).not.toThrow();

		const entry = healthEntry();
		expect(entry.status).toBe("failed");
		expect(entry.degraded).toBe(true);
		expect(entry.error).toContain("on");
	});

	it("does not register twice on the same api object", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		activate(pi);

		expect(handlers.get("tool_call")).toHaveLength(1);
	});
});

describe("provider schema injection", () => {
	it("injects the four fields and returns the payload only when changed", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const parameters = { type: "object", properties: { query: { type: "string" } } };
		const payload = { tools: [{ type: "function", function: { name: "search", parameters } }] };

		expect(emit(handlers, "before_provider_request", { payload })).toBe(payload);
		for (const key of [THINK, WORKERS, INTENT, SCOPE]) {
			expect(parameters.required).toContain(key);
		}
		expect(emit(handlers, "before_provider_request", { payload })).toBeUndefined();
	});

	it("honours the configured worker-field switch", () => {
		configureToolGate({ includeWorkers: false });
		const { pi, handlers } = fakePi();
		activate(pi);
		const parameters = { type: "object", properties: { query: { type: "string" } } };
		const payload = { tools: [{ function: { name: "search", parameters } }] };

		expect(emit(handlers, "before_provider_request", { payload })).toBe(payload);
		expect(parameters.properties[WORKERS]).toBeUndefined();
		expect(parameters.required).toEqual([THINK, INTENT, SCOPE]);
		expect(healthEntry().capabilities.workersInjection).toBe(false);
	});

	it("leaves the payload alone and degrades after an injector failure", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const payload = new Proxy(
			{},
			{
				get() {
					throw new Error("payload exploded");
				},
			},
		);

		expect(emit(handlers, "before_provider_request", { payload })).toBeUndefined();
		expect(healthEntry().status).toBe("degraded");
	});

	it("does not inject when the tool_call hook cannot be registered", () => {
		const handlers = new Map();
		const pi = {
			on(name, handler) {
				if (name === "tool_call") throw new Error("tool_call is unavailable");
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
			async setActiveTools() {},
		};
		activate(pi);
		const parameters = { type: "object", properties: { query: { type: "string" } } };
		const payload = { tools: [{ function: { name: "search", parameters } }] };

		expect(emit(handlers, "before_provider_request", { payload })).toBeUndefined();
		expect(parameters.required).toBeUndefined();
		expect(healthEntry().status).toBe("failed");
	});
});

describe("admission and stripping", () => {
	it("uses the session id as the shared agent id", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("session-shared", "different-agent-id");

		expect(callTool(handlers, ctx, "search", "shared-1", resetInput()).block).toBeUndefined();

		expect(ledgerFor("session-shared", "session-shared").initialized).toBe(true);
		expect(ledgerFor("session-shared", "different-agent-id").initialized).toBe(false);
	});

	it("admits the first resetScope call, writes CallMeta, and strips the input", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("session-valid");
		const input = resetInput();
		const event = { toolName: "search", toolCallId: "valid-1", input };
		const originalInput = input;

		const result = emit(handlers, "tool_call", event, ctx);

		expect(result.block).toBeUndefined();
		expect(result.input).toEqual({ query: "x" });
		expect(result.input).not.toBe(originalInput);
		expect(event.input).toBe(originalInput);
		expect(input).toEqual({
			[THINK]: "zh-cn",
			[INTENT]: "推进",
			[SCOPE]: { kind: "resetScope", new_scope_goal: "goal", new_scope_retention_budget: 5 },
			query: "x",
		});

		const meta = readCallMeta("valid-1");
		expect(meta).toBeDefined();
		expect(meta.intentBytes).toBe(6);
		expect(meta.deadlineAt).toBeGreaterThan(Date.now() - 1000);
		expect(meta.scopeDigest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("reports a missing must_think_in", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const input = resetInput();
		delete input[THINK];
		const result = callTool(handlers, ctxFor("session-think-fill"), "search", "think-fill-1", input);

		expect(result.block).toBe(true);
		expect(result.reason).toContain("missing gate fields");
		expect(result.reason).toContain(THINK);
		expect(readCallMeta("think-fill-1")).toBeUndefined();
	});

	it("blocks a non-zh-cn must_think_in", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const result = callTool(handlers, ctxFor("session-think-wrong"), "search", "think-wrong-1", {
			[THINK]: "en",
			[INTENT]: "推进",
			[SCOPE]: { kind: "keepLast" },
		});

		expect(result.block).toBe(true);
		expect(result.reason).toContain(":SCOPE_INVALID");
		expect(result.reason).toContain("must_think_in");
	});

	it("blocks a missing or blank intent", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("session-intent");

		for (const [index, input] of [
			{ [THINK]: "zh-cn", [SCOPE]: { kind: "keepLast" } },
			{ [THINK]: "zh-cn", [INTENT]: "", [SCOPE]: { kind: "keepLast" } },
			{ [THINK]: "zh-cn", [INTENT]: "   ", [SCOPE]: { kind: "keepLast" } },
		].entries()) {
			const result = callTool(handlers, ctx, "search", `intent-${index}`, input);
			expect(result.block).toBe(true);
			expect(result.reason).toContain(":INTENT_REQUIRED");
			expect(readCallMeta(`intent-${index}`)).toBeUndefined();
		}
	});

	it("does not substitute verbose_intent for the gate intent", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const input = {
			[THINK]: "zh-cn",
			[SCOPE]: { kind: "resetScope", new_scope_goal: "probe", new_scope_retention_budget: 2 },
			slug: "probe",
			verbose_intent: "probe request",
		};

		const result = callTool(handlers, ctxFor("session-verbose-intent"), "devops", "verbose-intent-1", input);

		expect(result.block).toBe(true);
		expect(result.reason).toContain(":INTENT_REQUIRED");
		expect(readCallMeta("verbose-intent-1")).toBeUndefined();
	});

	it("reports all missing gate fields at once", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const result = callTool(handlers, ctxFor("session-missing-all"), "devops", "missing-all-1", {
			slug: "probe",
		});

		expect(result.block).toBe(true);
		expect(result.reason).toContain("missing gate fields");
		expect(result.reason).toContain(THINK);
		expect(result.reason).toContain(INTENT);
		expect(result.reason).toContain(SCOPE);
	});

	it("rejects a non-resetScope cold start with SCOPE_UNINITIALIZED", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const result = callTool(handlers, ctxFor("session-cold"), "search", "cold-1", keepLastInput());

		expect(result.block).toBe(true);
		expect(result.reason).toContain(":SCOPE_UNINITIALIZED");
	});

	it("rejects keepLast after the budget reaches zero", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("session-budget");
		const key = { sessionId: "session-budget", agentId: "session-budget" };

		emit(handlers, "turn_start", { turnIndex: 0 }, ctx);
		expect(callTool(handlers, ctx, "search", "budget-1", resetInput("goal", 1)).block).toBeUndefined();
		emit(handlers, "turn_end", { turnIndex: 0 }, ctx);
		expect(ledgerFor(key.sessionId, key.agentId).retention).toBe(1);

		emit(handlers, "turn_start", { turnIndex: 1 }, ctx);
		expect(callTool(handlers, ctx, "search", "budget-2", keepLastInput()).block).toBeUndefined();
		emit(handlers, "turn_end", { turnIndex: 1 }, ctx);
		expect(ledgerFor(key.sessionId, key.agentId).retention).toBe(0);

		const rejected = callTool(handlers, ctx, "search", "budget-3", keepLastInput());
		expect(rejected.block).toBe(true);
		expect(rejected.reason).toContain(":SCOPE_BUDGET_SPENT");
		expect(readCallMeta("budget-3")).toBeUndefined();
	});

	it("settles a turn with several meToo calls once", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("session-metoo");

		emit(handlers, "turn_start", { turnIndex: 0 }, ctx);
		callTool(handlers, ctx, "search", "metoo-reset", resetInput("goal", 3));
		emit(handlers, "turn_end", { turnIndex: 0 }, ctx);

		emit(handlers, "turn_start", { turnIndex: 1 }, ctx);
		expect(callTool(handlers, ctx, "search", "metoo-1", meTooInput()).block).toBeUndefined();
		expect(callTool(handlers, ctx, "grep", "metoo-2", meTooInput()).block).toBeUndefined();
		emit(handlers, "turn_end", { turnIndex: 1 }, ctx);

		expect(ledgerFor("session-metoo", "session-metoo").retention).toBe(2);
	});

	it("shares one turn id across all tool calls in a turn", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("session-one-turn");

		emit(handlers, "turn_start", { turnIndex: 0 }, ctx);
		callTool(handlers, ctx, "search", "one-turn-reset", resetInput("goal", 3));
		emit(handlers, "turn_end", { turnIndex: 0 }, ctx);

		emit(handlers, "turn_start", { turnIndex: 1 }, ctx);
		expect(callTool(handlers, ctx, "search", "one-turn-1", keepLastInput()).block).toBeUndefined();
		expect(callTool(handlers, ctx, "search", "one-turn-2", keepLastInput()).block).toBeUndefined();
		emit(handlers, "turn_end", { turnIndex: 1 }, ctx);

		expect(ledgerFor("session-one-turn", "session-one-turn").retention).toBe(2);
	});

	it("settles the last turn on agent_end when turn events are absent", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("session-agent-end");

		emit(handlers, "turn_start", { turnIndex: 0 }, ctx);
		expect(callTool(handlers, ctx, "search", "agent-end-reset", resetInput("goal", 2)).block).toBeUndefined();
		emit(handlers, "turn_end", { turnIndex: 0 }, ctx);
		expect(ledgerFor("session-agent-end", "session-agent-end").retention).toBe(2);

		// No turn_start for the next model turn. All calls share one pending turn.
		expect(callTool(handlers, ctx, "search", "agent-end-keep", keepLastInput()).block).toBeUndefined();

		emit(handlers, "agent_end", { type: "agent_end" }, ctx);

		expect(ledgerFor("session-agent-end", "session-agent-end").retention).toBe(1);
	});

	it("keeps the active turn intact across a rejected call", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("session-reject-keeps-turn");

		emit(handlers, "turn_start", { turnIndex: 0 }, ctx);
		expect(callTool(handlers, ctx, "search", "reject-reset", resetInput("goal", 3)).block).toBeUndefined();
		emit(handlers, "turn_end", { turnIndex: 0 }, ctx);

		emit(handlers, "turn_start", { turnIndex: 1 }, ctx);
		expect(callTool(handlers, ctx, "search", "reject-keep", keepLastInput()).block).toBeUndefined();
		const rejected = callTool(handlers, ctx, "search", "reject-bad", {
			[THINK]: "zh-cn",
			[SCOPE]: { kind: "keepLast" },
		});
		expect(rejected.block).toBe(true);

		emit(handlers, "turn_end", { turnIndex: 1 }, ctx);
		expect(ledgerFor("session-reject-keeps-turn", "session-reject-keeps-turn").retention).toBe(2);
	});

	it("lets nested calls pass without a model annotation", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("session-nested");

		callTool(handlers, ctx, "search", "nested-reset", resetInput("goal", 3));
		const nested = emit(
			handlers,
			"tool_call",
			{ toolName: "search", toolCallId: "nested-1", parentToolCallId: "parent-1", input: { query: "x" } },
			ctx,
		);

		expect(nested).toBeUndefined();
		expect(readCallMeta("nested-1")).toBeUndefined();
	});

	it("leaves a non-object parameter input untouched", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const result = callTool(handlers, ctxFor("session-primitive"), "search", "primitive-1", "plain");

		expect(result).toBeUndefined();
		expect(readCallMeta("primitive-1")).toBeUndefined();
	});

	it("admits existing calls again without charging twice", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("session-replay");

		emit(handlers, "turn_start", { turnIndex: 0 }, ctx);
		expect(callTool(handlers, ctx, "search", "replay-1", resetInput("goal", 2)).block).toBeUndefined();
		expect(callTool(handlers, ctx, "search", "replay-1", resetInput("goal", 2)).block).toBeUndefined();
		emit(handlers, "turn_end", { turnIndex: 0 }, ctx);

		expect(ledgerFor("session-replay", "session-replay").retention).toBe(2);
	});

	it("delegates scope shape validation to the ledger", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const result = callTool(handlers, ctxFor("session-scope-invalid"), "search", "scope-invalid-1", {
			[THINK]: "zh-cn",
			[INTENT]: "推进",
			[SCOPE]: { kind: "not-a-kind" },
		});

		expect(result.block).toBe(true);
		expect(result.reason).toContain(":SCOPE_INVALID");
		expect(readCallMeta("scope-invalid-1")).toBeUndefined();
	});

	it("rejects removeLast before any previous beat", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("session-remove-invalid");

		emit(handlers, "turn_start", { turnIndex: 0 }, ctx);
		expect(callTool(handlers, ctx, "search", "remove-reset", resetInput()).block).toBeUndefined();
		const result = callTool(handlers, ctx, "search", "remove-invalid", {
			[THINK]: "zh-cn",
			[INTENT]: "修正",
			[SCOPE]: { kind: "removeLast", replacement: "lesson" },
		});

		expect(result.block).toBe(true);
		expect(result.reason).toContain(":INVALID_ARGUMENT");
	});
});

describe("exempt tools", () => {
	it("admits ask_previous_scope and assume without gate fields", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("session-exempt");

		expect(callTool(handlers, ctx, "ask_previous_scope", "exempt-1", { questions: "why?" })).toBeUndefined();
		expect(callTool(handlers, ctx, "assume", "exempt-2", { lemma: "keep this" })).toBeUndefined();
		expect(ledgerFor("session-exempt", "session-exempt").initialized).toBe(false);
	});

	it("does not require a reset before an exempt call", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const result = callTool(handlers, ctxFor("session-exempt-cold"), "ask_previous_scope", "exempt-3", {});

		expect(result).toBeUndefined();
	});
});

describe("bare host tools", () => {
	it("stays available when no mission is active", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const result = callTool(handlers, ctxFor("session-bare-idle"), "read", "bare-1", resetInput());

		expect(result.block).toBeUndefined();
		expect(result.input).toEqual({ query: "x" });
	});

	it("blocks the default bare tools while a mission snapshot is active", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		globalThis[MISSION_PORT_SYMBOL] = { active: true, slug: "demo" };
		const ctx = ctxFor("session-bare-active");

		for (const [index, tool] of ["read", "write", "edit", "bash", "grep", "glob", "ls"].entries()) {
			const result = callTool(handlers, ctx, tool, `bare-active-${index}`, {});
			expect(result.block).toBe(true);
			expect(result.reason).toContain(":CAPABILITY_DENIED");
			expect(result.reason).toContain(tool);
			expect(readCallMeta(`bare-active-${index}`)).toBeUndefined();
		}
	});

	it("accepts a function mission port and custom blockedTools", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		globalThis[MISSION_PORT_SYMBOL] = () => ({ active: true, blockedTools: ["write"] });
		const ctx = ctxFor("session-bare-custom");

		expect(callTool(handlers, ctx, "write", "bare-custom-1", {}).block).toBe(true);
		expect(callTool(handlers, ctx, "read", "bare-custom-2", resetInput()).block).toBeUndefined();
	});
});

describe("role token guard", () => {
	it("captures a role token and narrows the active tool surface", () => {
		const { pi, handlers, activeTools } = fakePi();
		activate(pi);
		const ctx = ctxFor("role-surface");

		startRole(handlers, ctx, "Swarm Worker");

		const surface = activeTools.at(-1);
		for (const tool of ["clj_worker", "board_split", "yield", "ask_previous_scope"]) {
			expect(surface).toContain(tool);
		}
		for (const tool of ["hub", "read", "write", "bash", "task", "mcp__search"]) {
			expect(surface).not.toContain(tool);
		}
		expect(healthEntry().capabilities.roleGuard).toBe(true);
	});

	it("denies hub and bare host tools for a subagent role", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("role-forbidden");
		startRole(handlers, ctx, "Swarm Worker");

		for (const [index, tool] of [
			"hub",
			"read",
			"write",
			"edit",
			"bash",
			"task",
			"mcp__x",
			"lsp_x",
			"irc_x",
		].entries()) {
			const id = `role-forbidden-${index}`;
			const result = callTool(handlers, ctx, tool, id, resetInput());
			expect(result.block).toBe(true);
			expect(result.reason).toContain(":CAPABILITY_DENIED");
			expect(result.reason).toContain(tool);
			expect(readCallMeta(id)).toBeUndefined();
		}
	});

	it("allows the role's sandbox and board tools", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("role-worker");
		startRole(handlers, ctx, "Swarm Worker");

		expect(callTool(handlers, ctx, "clj_worker", "role-worker-1", resetInput()).block).toBeUndefined();
		expect(callTool(handlers, ctx, "board_split", "role-worker-2", keepLastInput()).block).toBeUndefined();
	});

	it("denies tools that belong to another role", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("role-other");
		startRole(handlers, ctx, "Swarm Worker");

		for (const [index, tool] of [
			"clj_review",
			"submit_review",
			"clj_auditor",
			"submit_case_audit",
			"abandon_slice",
		].entries()) {
			const result = callTool(handlers, ctx, tool, `role-other-${index}`, resetInput());
			expect(result.block).toBe(true);
			expect(result.reason).toContain(":CAPABILITY_DENIED");
		}
	});

	it("allows Reviewer ask_user and submit_review", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("role-reviewer");
		startRole(handlers, ctx, "Reviewer");

		expect(callTool(handlers, ctx, "clj_review", "role-reviewer-1", resetInput()).block).toBeUndefined();
		expect(callTool(handlers, ctx, "ask_user", "role-reviewer-2", keepLastInput()).block).toBeUndefined();
		expect(callTool(handlers, ctx, "submit_review", "role-reviewer-3", keepLastInput()).block).toBeUndefined();
	});

	it("allows Holder abandon_slice", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("role-holder");
		startRole(handlers, ctx, "Swarm Holder");

		expect(callTool(handlers, ctx, "abandon_slice", "role-holder-1", resetInput()).block).toBeUndefined();
	});

	it("maps each subagent role to its declared tools", () => {
		const cases = [
			["Plan DevOps", "clj_devops", "submit_devops_report", "clj_worker"],
			["Manual Auditor", "clj_auditor", "submit_case_audit", "board_split"],
			["Blocker Oracle", "clj_review", "submit_oracle_advice", "board_split"],
		];

		for (const [role, first, second, denied] of cases) {
			const { pi, handlers } = fakePi();
			activate(pi);
			const ctx = ctxFor(`role-${role.replaceAll(" ", "-")}`);
			startRole(handlers, ctx, role);

			expect(callTool(handlers, ctx, first, `${role}-1`, resetInput()).block).toBeUndefined();
			expect(callTool(handlers, ctx, second, `${role}-2`, keepLastInput()).block).toBeUndefined();
			expect(callTool(handlers, ctx, denied, `${role}-3`, keepLastInput()).block).toBe(true);
		}
	});

	it("rejects a second token for a different role", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("role-change");
		startRole(handlers, ctx, "Swarm Worker");
		startRole(handlers, ctx, "Manual Auditor");

		const result = callTool(handlers, ctx, "clj_worker", "role-change-1", resetInput());
		expect(result.block).toBe(true);
		expect(result.reason).toContain("role token changed");
		expect(healthEntry().status).toBe("degraded");
	});

	it("fails closed for a malformed role token", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("role-malformed", "agent-1", "sub");

		emit(
			handlers,
			"before_agent_start",
			{ reason: "prompt", prompt: "[HERD_ROLE: Swarm Worker nonce=short]\nTask" },
			ctx,
		);

		const result = callTool(handlers, ctx, "read", "role-malformed-1", resetInput());
		expect(result.block).toBe(true);
		expect(result.reason).toContain("malformed or unknown role token");
	});

	it("fails closed when the role surface is not published", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("role-surface-missing", "agent-1", "sub");
		publishRoleSurfaces();

		emit(handlers, "before_agent_start", { reason: "prompt", prompt: `${roleToken("Coordinator")}\nTask` }, ctx);

		const result = callTool(handlers, ctx, "clj_worker", "role-surface-missing-1", resetInput());
		expect(result.block).toBe(true);
		expect(result.reason).toContain("role surface is not published");
	});

	it("fails closed for a token-like first line with leading whitespace", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("role-leading-space", "agent-1", "sub");

		emit(handlers, "before_agent_start", { reason: "prompt", prompt: `  ${roleToken("Swarm Worker")}\nTask` }, ctx);

		const result = callTool(handlers, ctx, "read", "role-leading-space-1", resetInput());
		expect(result.block).toBe(true);
		expect(result.reason).toContain("malformed or unknown role token");
	});

	it("fails closed when a subagent has no role token", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = {
			...ctxFor("role-no-token"),
			agent: { kind: "sub", id: "agent-1", name: "agent-1", depth: 1 },
		};

		for (const [index, tool] of ["hub", "read", "assume", "yield"].entries()) {
			const result = callTool(handlers, ctx, tool, `role-no-token-${index}`, resetInput());
			expect(result.block).toBe(true);
			expect(result.reason).toContain("subagent has no verified role token");
		}
		expect(healthEntry().status).toBe("degraded");
	});

	it("ignores a role token that is not the first line", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("role-not-first", "agent-1", "sub");

		emit(
			handlers,
			"before_agent_start",
			{
				reason: "prompt",
				prompt: `Task body\n${roleToken("Swarm Worker")}`,
			},
			ctx,
		);

		const result = callTool(handlers, ctx, "read", "role-not-first-1", resetInput());
		expect(result.block).toBe(true);
		expect(result.reason).toContain("subagent has no verified role token");
	});

	it("captures a role token from a custom message", () => {
		const { pi, handlers, activeTools } = fakePi();
		activate(pi);
		const ctx = ctxFor("role-custom", "agent-1", "sub");
		const nonce = nextNonce();
		publishRoleSurfaces();

		emit(
			handlers,
			"before_agent_start",
			{
				reason: "custom",
				messageType: "custom",
				message: { content: [{ type: "text", text: `${roleToken("Swarm Worker", nonce)}\nTask` }] },
			},
			ctx,
		);

		expect(activeTools).toHaveLength(1);
		expect(callTool(handlers, ctx, "hub", "role-custom-1", {}).block).toBe(true);
		expect(callTool(handlers, ctx, "clj_worker", "role-custom-2", resetInput()).block).toBeUndefined();
	});

	it("honours a role-surface override", () => {
		globalThis[ROLE_SURFACE_SYMBOL] = { "Swarm Worker": ["clj_worker", "custom_tool"] };
		const { pi, handlers, activeTools } = fakePi();
		activate(pi);
		const ctx = ctxFor("role-override");
		startRole(handlers, ctx, "Swarm Worker");

		expect(callTool(handlers, ctx, "custom_tool", "role-override-1", resetInput()).block).toBeUndefined();
		expect(callTool(handlers, ctx, "board_split", "role-override-2", keepLastInput()).block).toBe(true);
		expect(callTool(handlers, ctx, "board_take_or_die", "role-override-3", keepLastInput()).block).toBe(true);
		expect(callTool(handlers, ctx, "yield", "role-override-4", keepLastInput()).block).toBeUndefined();
		const surface = activeTools.at(-1);
		expect(surface).toContain("custom_tool");
		expect(surface).toContain("yield");
		expect(surface).not.toContain("board_split");
		expect(surface).not.toContain("board_take_or_die");
	});

	it("allows Scope helpers for every subagent role", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = ctxFor("role-exempt");
		startRole(handlers, ctx, "Swarm Worker");

		expect(callTool(handlers, ctx, "ask_previous_scope", "role-exempt-1", { questions: "?" })).toBeUndefined();
		expect(callTool(handlers, ctx, "assume", "role-exempt-2", { lemma: "x" })).toBeUndefined();
	});

	it("still denies tools when setActiveTools fails", () => {
		const handlers = new Map();
		const pi = {
			on(name, handler) {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
			setActiveTools() {
				throw new Error("setActiveTools unavailable");
			},
		};
		activate(pi);
		const ctx = ctxFor("role-narrowing-failed");
		startRole(handlers, ctx, "Swarm Worker");

		expect(healthEntry().status).toBe("degraded");
		expect(callTool(handlers, ctx, "hub", "role-narrowing-1", {}).block).toBe(true);
	});

	it("fails closed when a role token appears without ctx.agent", () => {
		const { pi, handlers, activeTools } = fakePi();
		activate(pi);
		const ctx = {
			sessionManager: {
				getSessionId: () => "main-role-token",
				getSessionFile: () => "/tmp/main-role-token.jsonl",
			},
		};

		emit(handlers, "before_agent_start", { reason: "prompt", prompt: `${roleToken("Swarm Worker")}\nTask` }, ctx);

		expect(activeTools).toHaveLength(0);
		const result = callTool(handlers, ctx, "read", "main-role-token-1", resetInput());
		expect(result.block).toBe(true);
		expect(result.reason).toContain("host cannot identify a subagent context");
		expect(healthEntry().status).toBe("degraded");
	});

	it("keeps a normal main session without ctx.agent", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const ctx = {
			sessionManager: {
				getSessionId: () => "main-no-agent",
				getSessionFile: () => "/tmp/main-no-agent.jsonl",
			},
		};

		emit(handlers, "before_agent_start", { reason: "prompt", prompt: "ordinary task" }, ctx);

		expect(callTool(handlers, ctx, "read", "main-no-agent-1", resetInput()).block).toBeUndefined();
	});

	it("does not add subagent-only tools to a main session", () => {
		const { pi, handlers, activeTools } = fakePi();
		activate(pi);
		const ctx = ctxFor("main-surface");

		emit(handlers, "before_agent_start", { reason: "prompt", prompt: "ordinary task" }, ctx);

		expect(activeTools).toHaveLength(0);
		expect(healthEntry().status).toBe("ok");
		const yielded = callTool(handlers, ctx, "yield", "main-surface-1", resetInput());
		expect(yielded.block).toBe(true);
		expect(yielded.reason).toContain(":CAPABILITY_DENIED");
	});
});

describe("CallMeta", () => {
	it("validates its public input and returns a frozen record", () => {
		expect(writeCallMeta("", { intentBytes: 1, deadlineAt: 1 })).toBe(false);
		expect(writeCallMeta("meta-bad", {})).toBe(false);
		expect(writeCallMeta("meta-bad", { intentBytes: -1, deadlineAt: 1 })).toBe(false);
		expect(writeCallMeta("meta-bad", { intentBytes: 1, deadlineAt: Number.NaN })).toBe(false);

		expect(writeCallMeta("meta-good", { intentBytes: 3, deadlineAt: 1234, scopeDigest: "abc" })).toBe(true);
		const record = readCallMeta("meta-good");
		expect(record).toEqual({
			toolCallId: "meta-good",
			intentBytes: 3,
			deadlineAt: 1234,
			scopeDigest: "abc",
		});
		expect(Object.isFrozen(record)).toBe(true);
		expect(readCallMeta("meta-missing")).toBeUndefined();
	});

	it("is removed when tool execution ends", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		callTool(handlers, ctxFor("session-cleanup"), "search", "cleanup-1", resetInput());
		expect(readCallMeta("cleanup-1")).toBeDefined();

		emit(handlers, "tool_execution_end", { toolCallId: "cleanup-1" });
		expect(readCallMeta("cleanup-1")).toBeUndefined();
	});
});

describe("degraded host support", () => {
	it("strips in place and reports degradation when {input} is not verified", () => {
		process.env.HERD_TOOL_CALL_INPUT = "0";
		const { pi, handlers } = fakePi();
		activate(pi);
		const entry = healthEntry();
		expect(entry.status).toBe("degraded");
		expect(entry.capabilities.hasToolCallInput).toBe(false);

		const ctx = ctxFor("session-fallback");
		const input = resetInput();
		const result = callTool(handlers, ctx, "search", "fallback-1", input);

		expect(result).toBeUndefined();
		expect(input).toEqual({ query: "x" });
		expect(readCallMeta("fallback-1")).toBeDefined();
	});

	it("treats a 16.x host version as without {input}", () => {
		process.env.OMP_VERSION = "16.1.22";
		const { pi } = fakePi();
		activate(pi);

		const entry = healthEntry();
		expect(entry.status).toBe("degraded");
		expect(entry.capabilities.hasToolCallInput).toBe(false);
	});
});

describe("failed injection stays usable", () => {
	it("does not block calls after the provider hook failed", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const payload = new Proxy(
			{},
			{
				get() {
					throw new Error("payload exploded");
				},
			},
		);
		emit(handlers, "before_provider_request", { payload });

		const input = resetInput();
		const result = callTool(handlers, ctxFor("session-fail-open"), "search", "fail-open-1", input);
		expect(result.block).toBeUndefined();
		expect(result.input).toEqual({ query: "x" });
	});

	it("blocks unannotated calls after the provider hook failed", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		const payload = new Proxy(
			{},
			{
				get() {
					throw new Error("payload exploded");
				},
			},
		);
		emit(handlers, "before_provider_request", { payload });

		const result = callTool(handlers, ctxFor("session-fail-open-2"), "search", "fail-open-2", { query: "x" });
		expect(result.block).toBe(true);
		expect(result.reason).toContain("missing gate fields");
		expect(ledgerFor("session-fail-open-2", "session-fail-open-2").initialized).toBe(false);
		expect(healthEntry().status).toBe("degraded");
	});

	it("blocks missing gate fields while a mission is active and records degradation", () => {
		const { pi, handlers } = fakePi();
		activate(pi);
		globalThis[MISSION_PORT_SYMBOL] = { active: true, slug: "probe" };

		const result = callTool(handlers, ctxFor("session-mission-missing"), "search", "mission-missing-1", {
			query: "x",
		});

		expect(result.block).toBe(true);
		expect(result.reason).toContain("missing gate fields");
		expect(healthEntry().status).toBe("degraded");
	});
});
