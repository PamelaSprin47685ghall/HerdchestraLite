import { describe, expect, it } from "bun:test";
import toolCallGate from "../src/tool-gate/index.mjs";
import { THINK_PARAMETER, WORKERS_PARAMETER, injectToolSchemas } from "../src/tool-gate/schema.mjs";
import { stripGateParameters } from "../src/tool-gate/strip.mjs";

const WORKERS = "how-many-more-workers-are-allowed-without-hitting-mythical-man-month";
const THINK = "must-think-in";

const WORKERS_DEFINITION = {
	type: "integer",
	description:
		"You must maintain the worker count (target total workload in turns / 100). Never skimp on dispatching work.",
};

const THINK_DEFINITION = {
	type: "string",
	enum: ["zh-cn"],
	description: "Language used to reason about this call. The only accepted value is zh-cn.",
};

function objectSchema() {
	return { type: "object", properties: { query: { type: "string" } } };
}

function expectGate(schema) {
	expect(schema.required).toContain(WORKERS);
	expect(schema.required).toContain(THINK);
	expect(schema.properties[WORKERS]).toEqual(WORKERS_DEFINITION);
	expect(schema.properties[THINK]).toEqual(THINK_DEFINITION);
}

describe("parameter names", () => {
	it("keeps both names byte-for-byte", () => {
		expect(WORKERS_PARAMETER).toBe(WORKERS);
		expect(THINK_PARAMETER).toBe(THINK);
	});
});

describe("injectToolSchemas", () => {
	it("injects into OpenAI function tools", () => {
		const parameters = objectSchema();
		const payload = { tools: [{ type: "function", function: { name: "search", parameters } }] };

		expect(injectToolSchemas(payload)).toBe(true);
		expectGate(parameters);
		expect(parameters.properties.query).toEqual({ type: "string" });
	});

	it("injects into Anthropic input_schema tools", () => {
		const input_schema = objectSchema();
		const payload = { tools: [{ name: "search", input_schema }] };

		expect(injectToolSchemas(payload)).toBe(true);
		expectGate(input_schema);
	});

	it("injects into Google functionDeclarations", () => {
		const parameters = objectSchema();
		const payload = {
			tools: [{ functionDeclarations: [{ name: "search", parameters }] }],
		};

		expect(injectToolSchemas(payload)).toBe(true);
		expectGate(parameters);
	});

	it("injects into Bedrock toolSpec.inputSchema.json", () => {
		const json = objectSchema();
		const payload = {
			tools: [{ toolSpec: { name: "search", inputSchema: { json } } }],
		};

		expect(injectToolSchemas(payload)).toBe(true);
		expectGate(json);
	});

	it("injects into compatible bare parameters tools", () => {
		const parameters = objectSchema();
		const payload = { tools: [{ name: "search", parameters }] };

		expect(injectToolSchemas(payload)).toBe(true);
		expectGate(parameters);
	});

	it("injects into toolConfig.tools", () => {
		const parameters = objectSchema();
		const payload = {
			toolConfig: { tools: [{ functionDeclarations: [{ name: "search", parameters }] }] },
		};

		expect(injectToolSchemas(payload)).toBe(true);
		expectGate(parameters);
	});

	it("walks allOf, anyOf, and oneOf branches", () => {
		const first = objectSchema();
		const second = objectSchema();
		const third = objectSchema();
		const parameters = {
			allOf: [first, { anyOf: [{ oneOf: [second, third] }] }],
		};

		expect(injectToolSchemas({ tools: [{ function: { parameters } }] })).toBe(true);
		expectGate(first);
		expectGate(second);
		expectGate(third);
		expect(parameters.properties).toBeUndefined();
		expect(parameters.required).toBeUndefined();
	});

	it("creates properties and required for a bare object schema", () => {
		const parameters = { type: "object" };
		const payload = { tools: [{ function: { parameters } }] };

		expect(injectToolSchemas(payload)).toBe(true);
		expectGate(parameters);
	});

	it("keeps an existing gate property definition", () => {
		const custom = { type: "integer", description: "custom" };
		const parameters = {
			type: "object",
			properties: { [WORKERS]: custom },
			required: [WORKERS],
		};

		expect(injectToolSchemas({ tools: [{ function: { parameters } }] })).toBe(true);
		expect(parameters.properties[WORKERS]).toBe(custom);
		expect(parameters.required.filter((name) => name === WORKERS)).toHaveLength(1);
		expect(parameters.required).toContain(THINK);
	});

	it("is idempotent", () => {
		const parameters = objectSchema();
		const payload = { tools: [{ function: { parameters } }] };

		expect(injectToolSchemas(payload)).toBe(true);
		const requiredAfterFirst = [...parameters.required];
		const propertyCount = Object.keys(parameters.properties).length;

		expect(injectToolSchemas(payload)).toBe(false);
		expect(parameters.required).toEqual(requiredAfterFirst);
		expect(Object.keys(parameters.properties)).toHaveLength(propertyCount);
	});

	it("does not recurse forever on a cyclic composition", () => {
		const parameters = { type: "object", properties: {} };
		parameters.allOf = [parameters];

		expect(injectToolSchemas({ tools: [{ function: { parameters } }] })).toBe(true);
		expect(parameters.required).toEqual([WORKERS, THINK]);
	});

	it("does not expand $ref roots", () => {
		const parameters = { $ref: "#/$defs/Search" };

		expect(injectToolSchemas({ tools: [{ function: { parameters } }] })).toBe(false);
		expect(parameters).toEqual({ $ref: "#/$defs/Search" });
	});

	it("leaves non-object schemas and tools untouched", () => {
		const parameters = { type: "string" };
		const payload = { tools: [null, 42, { function: { parameters } }, { name: "flag" }] };

		expect(injectToolSchemas(payload)).toBe(false);
		expect(parameters).toEqual({ type: "string" });
	});

	it("leaves non-object payloads alone", () => {
		for (const payload of [undefined, null, 42, "tools", [], true]) {
			expect(injectToolSchemas(payload)).toBe(false);
		}
	});
});

describe("stripGateParameters", () => {
	it("returns undefined when neither gate parameter is present", () => {
		expect(stripGateParameters({ query: "x" })).toBeUndefined();
		expect(stripGateParameters({})).toBeUndefined();
	});

	it("returns undefined for non-object inputs", () => {
		for (const input of [undefined, null, 42, "x", [], true]) {
			expect(stripGateParameters(input)).toBeUndefined();
		}
	});

	it("strips both parameters without mutating the input", () => {
		const input = { query: "x", [WORKERS]: 4, [THINK]: "zh-cn" };
		const stripped = stripGateParameters(input);

		expect(stripped).toEqual({ query: "x" });
		expect(input).toEqual({ query: "x", [WORKERS]: 4, [THINK]: "zh-cn" });
		expect(stripped).not.toBe(input);
	});

	it("strips a single gate parameter", () => {
		expect(stripGateParameters({ [WORKERS]: 1, query: "x" })).toEqual({ query: "x" });
		expect(stripGateParameters({ [THINK]: "zh-cn", query: "x" })).toEqual({ query: "x" });
	});

	it("returns an empty object when the gate parameters are the only keys", () => {
		expect(stripGateParameters({ [WORKERS]: 1, [THINK]: "zh-cn" })).toEqual({});
	});
});

describe("toolCallGate factory", () => {
	function fakePi() {
		const handlers = new Map();
		return {
			pi: {
				on(name, handler) {
					handlers.set(name, handler);
				},
			},
			handlers,
		};
	}

	it("registers before_provider_request and tool_call", () => {
		const { pi, handlers } = fakePi();

		toolCallGate(pi);

		expect([...handlers.keys()]).toEqual(["before_provider_request", "tool_call"]);
	});

	it("returns the payload only when a schema changed", () => {
		const { pi, handlers } = fakePi();
		toolCallGate(pi);
		const handler = handlers.get("before_provider_request");

		const payload = { tools: [{ function: { parameters: objectSchema() } }] };
		expect(handler({ payload })).toBe(payload);

		expect(handler({ payload: { tools: [{ function: { parameters: { type: "string" } } }] } })).toBeUndefined();
		expect(handler({ payload: null })).toBeUndefined();
	});

	it("returns stripped input only when a gate parameter was present", () => {
		const { pi, handlers } = fakePi();
		toolCallGate(pi);
		const handler = handlers.get("tool_call");

		const event = { input: { query: "x", [WORKERS]: 2, [THINK]: "zh-cn" } };
		expect(handler(event)).toEqual({ input: { query: "x" } });
		expect(event.input[WORKERS]).toBe(2);

		expect(handler({ input: { query: "x" } })).toBeUndefined();
		expect(handler({ input: null })).toBeUndefined();
	});
});
