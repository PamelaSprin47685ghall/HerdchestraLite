import { describe, expect, it } from "bun:test";
import { registerScopeGate } from "../src/scope/gate.mjs";

function fakePi() {
	const handlers = new Map();
	return {
		handlers,
		pi: {
			on(name, fn) {
				handlers.set(name, fn);
			},
		},
	};
}

describe("Scope gate (points 1-3, no tool-gate)", () => {
	it("injects scope into non-exempt provider schemas and leaves exempt tools untouched", () => {
		const { pi, handlers } = fakePi();
		registerScopeGate(pi, { includeWorkers: false, includeIntent: false });
		const payload = {
			tools: [
				{
					function: {
						name: "clj_plan",
						parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
					},
				},
				{
					function: {
						name: "ask_previous_scope",
						parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
					},
				},
			],
		};
		const res = handlers.get("before_provider_request")({ payload });
		expect(res.payload.tools[0].function.parameters.properties.scope).toBeDefined();
		expect(res.payload.tools[0].function.parameters.properties.intent).toBeUndefined();
		expect(res.payload.tools[1].function.parameters.properties.scope).toBeUndefined();
	});

	it("blocks cold-start non-resetScope, admits resetScope + keepLast, and strips scope before execution", () => {
		const { pi, handlers } = fakePi();
		registerScopeGate(pi, { includeWorkers: false, includeIntent: false });
		const ctx = { sessionId: "sg-s1" };
		const onToolCall = handlers.get("tool_call");

		const cold = onToolCall(
			{ toolName: "clj_plan", toolCallId: "c1", input: { code: "1", scope: { kind: "keepLast" } } },
			ctx,
		);
		expect(cold.block).toBe(true);
		expect(cold.reason).toContain(":SCOPE_UNINITIALIZED");

		const reset = onToolCall(
			{
				toolName: "clj_plan",
				toolCallId: "c2",
				input: {
					code: "1",
					scope: { kind: "resetScope", new_scope_goal: "test", new_scope_retention_budget: 2 },
				},
			},
			ctx,
		);
		expect(reset).toEqual({ input: { code: "1" } });

		const keep = onToolCall(
			{ toolName: "clj_plan", toolCallId: "c3", input: { code: "2", scope: { kind: "keepLast" } } },
			ctx,
		);
		expect(keep).toEqual({ input: { code: "2" } });

		// Exempt tools pass without scope
		expect(onToolCall({ toolName: "assume", toolCallId: "c4", input: { lemma: "ok" } }, ctx)).toBeUndefined();
	});

	it("settles turns on turn_end and enforces retention exhaustion", () => {
		const { pi, handlers } = fakePi();
		registerScopeGate(pi);
		const ctx = { sessionId: "sg-s2" };
		const onToolCall = handlers.get("tool_call");

		handlers.get("turn_start")({ turnIndex: 0 }, ctx);
		expect(
			onToolCall(
				{
					toolName: "clj_plan",
					toolCallId: "t1",
					input: { code: "1", scope: { kind: "resetScope", new_scope_goal: "g", new_scope_retention_budget: 1 } },
				},
				ctx,
			),
		).toEqual({ input: { code: "1" } });
		handlers.get("turn_end")({ turnIndex: 0 }, ctx);

		handlers.get("turn_start")({ turnIndex: 1 }, ctx);
		expect(
			onToolCall({ toolName: "clj_plan", toolCallId: "t2", input: { code: "2", scope: { kind: "keepLast" } } }, ctx),
		).toEqual({ input: { code: "2" } });
		handlers.get("turn_end")({ turnIndex: 1 }, ctx);

		handlers.get("turn_start")({ turnIndex: 2 }, ctx);
		const spent = onToolCall(
			{ toolName: "clj_plan", toolCallId: "t3", input: { code: "3", scope: { kind: "keepLast" } } },
			ctx,
		);
		expect(spent.block).toBe(true);
		expect(spent.reason).toContain(":SCOPE_BUDGET_SPENT");
	});
});
