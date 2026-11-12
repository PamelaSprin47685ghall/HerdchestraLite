import { describe, expect, it } from "bun:test";
import { Type } from "typebox";
import {
	GATE_DEFINITIONS,
	GATE_KEYS,
	gatedObject,
	gatedPlainSchema,
	gateTypeProperties,
	injectGateFields,
	stripGateFields,
} from "../src/tool-gate/schema.mjs";

const WORKERS = "more_workers_without_hitting_mythical_man_month";
const INTENT = "intent";
const SCOPE = "scope";

const LEGACY_WORKERS = "more-workers-without-hitting-mythical-man-month";

function objectSchema() {
	return { type: "object", properties: { query: { type: "string" } } };
}

function snapshot(value) {
	return JSON.parse(JSON.stringify(value));
}

function expectGate(schema) {
	expect(Array.isArray(schema.required)).toBe(true);
	expect(typeof schema.properties).toBe("object");
	for (const key of GATE_KEYS) {
		expect(schema.required).toContain(key);
		expect(schema.properties[key]).toEqual(GATE_DEFINITIONS[key]);
	}
}

function injectOne(tool, options) {
	const payload = { tools: [tool] };
	const changed = injectGateFields(payload, options);
	return { payload, tool, changed };
}

describe("wire contract", () => {
	it("exports the three snake_case keys in wire order", () => {
		expect(GATE_KEYS).toEqual([WORKERS, INTENT, SCOPE]);
		expect(Object.isFrozen(GATE_KEYS)).toBe(true);
		expect(GATE_KEYS.some((key) => key.includes("-"))).toBe(false);
	});

	it("exports frozen definitions for every key", () => {
		expect(Object.keys(GATE_DEFINITIONS)).toEqual([...GATE_KEYS]);
		expect(Object.isFrozen(GATE_DEFINITIONS)).toBe(true);
		expect(Object.isFrozen(GATE_DEFINITIONS[SCOPE])).toBe(true);
		expect(Object.isFrozen(GATE_DEFINITIONS[SCOPE].properties)).toBe(true);

		expect(GATE_DEFINITIONS[INTENT].type).toBe("string");
		expect(GATE_DEFINITIONS[INTENT].minLength).toBe(1);
		expect(GATE_DEFINITIONS[WORKERS].type).toBe("integer");
		expect(GATE_DEFINITIONS[SCOPE].additionalProperties).toBe(false);
		expect(GATE_DEFINITIONS[SCOPE].required).toEqual(["kind"]);
		expect(GATE_DEFINITIONS[SCOPE].properties.kind.enum).toEqual(["resetScope", "keepLast", "removeLast", "meToo"]);
		expect(GATE_DEFINITIONS[SCOPE].properties.new_scope_goal.minLength).toBe(1);
		expect(GATE_DEFINITIONS[SCOPE].properties.new_scope_retention_budget.minimum).toBe(1);
		expect(GATE_DEFINITIONS[SCOPE].properties.replacement.minLength).toBe(1);
	});
});

describe("transport shapes", () => {
	it("injects into OpenAI function tools and leaves other payload fields alone", () => {
		const parameters = objectSchema();
		const payload = {
			model: "test-model",
			messages: [{ role: "user", content: "hi" }],
			tools: [{ type: "function", function: { name: "search", parameters } }],
		};

		expect(injectGateFields(payload)).toBe(true);
		expectGate(parameters);
		expect(parameters.properties.query).toEqual({ type: "string" });
		expect(payload.model).toBe("test-model");
		expect(payload.messages).toEqual([{ role: "user", content: "hi" }]);
	});

	it("injects into Anthropic input_schema tools", () => {
		const input_schema = objectSchema();
		const { changed } = injectOne({ name: "search", input_schema });

		expect(changed).toBe(true);
		expectGate(input_schema);
	});

	it("injects into bare parameters tools", () => {
		const parameters = objectSchema();
		const { changed } = injectOne({ type: "function", name: "search", parameters });

		expect(changed).toBe(true);
		expectGate(parameters);
	});

	it("injects into Google functionDeclarations parameters", () => {
		const parameters = objectSchema();
		const { changed } = injectOne({
			functionDeclarations: [{ name: "search", parameters }],
		});

		expect(changed).toBe(true);
		expectGate(parameters);
	});

	it("injects into Google config.tools parametersJsonSchema", () => {
		const parametersJsonSchema = objectSchema();
		const payload = {
			model: "gemini",
			contents: [],
			config: {
				tools: [{ functionDeclarations: [{ name: "search", parametersJsonSchema }] }],
			},
		};

		expect(injectGateFields(payload)).toBe(true);
		expectGate(parametersJsonSchema);
	});

	it("injects into Bedrock toolConfig.tools", () => {
		const json = objectSchema();
		const payload = {
			modelId: "bedrock-model",
			toolConfig: { tools: [{ toolSpec: { name: "search", inputSchema: { json } } }] },
		};

		expect(injectGateFields(payload)).toBe(true);
		expectGate(json);
	});

	it("injects into both payload.tools and config.tools", () => {
		const first = objectSchema();
		const second = objectSchema();
		const payload = {
			tools: [{ function: { name: "openai", parameters: first } }],
			config: { tools: [{ functionDeclarations: [{ name: "google", parametersJsonSchema: second }] }] },
		};

		expect(injectGateFields(payload)).toBe(true);
		expectGate(first);
		expectGate(second);
	});
});

describe("exemptions", () => {
	it("leaves exempt tools untouched in every named shape", () => {
		const tools = [
			{ type: "function", function: { name: "ask_previous_scope", parameters: objectSchema() } },
			{ name: "assume", input_schema: objectSchema() },
			{ name: "ask-previous-scope", parameters: objectSchema() },
			{ functionDeclarations: [{ name: "assume", parameters: objectSchema() }] },
			{ toolSpec: { name: "ask_previous_scope", inputSchema: { json: objectSchema() } } },
		];

		for (const tool of tools) {
			const before = snapshot(tool);
			expect(injectGateFields({ tools: [tool] })).toBe(false);
			expect(tool).toEqual(before);
		}
	});

	it("injects a normal sibling and leaves the exempt tool untouched", () => {
		const exemptParameters = objectSchema();
		const normalParameters = objectSchema();
		const payload = {
			tools: [
				{ type: "function", function: { name: "assume", parameters: exemptParameters } },
				{ type: "function", function: { name: "search", parameters: normalParameters } },
			],
		};

		expect(injectGateFields(payload)).toBe(true);
		expect(exemptParameters.required).toBeUndefined();
		expectGate(normalParameters);
	});

	it("matches exempt names exactly", () => {
		const parameters = objectSchema();
		expect(injectGateFields({ tools: [{ function: { name: "Assume", parameters } }] })).toBe(true);
		expectGate(parameters);
	});
});

describe("idempotency and preservation", () => {
	it("is idempotent", () => {
		const parameters = objectSchema();
		const payload = { tools: [{ function: { name: "search", parameters } }] };

		expect(injectGateFields(payload)).toBe(true);
		const afterFirst = snapshot(parameters);

		expect(injectGateFields(payload)).toBe(false);
		expect(parameters).toEqual(afterFirst);
	});

	it("keeps definitions that a tool already declares", () => {
		const customIntent = { type: "string", description: "business intent" };
		const customScope = { type: "object", description: "business scope" };
		const parameters = {
			type: "object",
			properties: { [INTENT]: customIntent, [SCOPE]: customScope },
			required: [INTENT],
		};

		expect(injectGateFields({ tools: [{ function: { name: "search", parameters } }] })).toBe(true);
		expect(parameters.properties[INTENT]).toBe(customIntent);
		expect(parameters.properties[SCOPE]).toBe(customScope);
		expect(parameters.required.filter((key) => key === INTENT)).toHaveLength(1);
		expect(parameters.required).toContain(WORKERS);
	});

	it("visits a schema shared by several transport slots once", () => {
		const parameters = objectSchema();
		const tool = {
			function: { name: "search", parameters },
			input_schema: parameters,
			parameters,
		};

		expect(injectGateFields({ tools: [tool] })).toBe(true);
		expect(parameters.required).toEqual([...GATE_KEYS]);
		expect(injectGateFields({ tools: [tool] })).toBe(false);
	});

	it("clones definitions per tool", () => {
		const first = objectSchema();
		const second = objectSchema();
		const payload = {
			tools: [{ function: { name: "first", parameters: first } }, { function: { name: "second", parameters: second } }],
		};

		expect(injectGateFields(payload)).toBe(true);
		expect(first.properties[SCOPE]).not.toBe(second.properties[SCOPE]);
		expect(first.properties[SCOPE]).not.toBe(GATE_DEFINITIONS[SCOPE]);
		expect(first.properties[SCOPE]).toEqual(second.properties[SCOPE]);
	});

	it("does not change unrelated schema keywords", () => {
		const parameters = {
			type: "object",
			description: "search arguments",
			additionalProperties: false,
			properties: { query: { type: "string" } },
		};

		expect(injectGateFields({ tools: [{ function: { name: "search", parameters } }] })).toBe(true);
		expect(parameters.description).toBe("search arguments");
		expect(parameters.additionalProperties).toBe(false);
	});
});

describe("strict sampling compatibility", () => {
	it("uses the null-union scope for a strict root", () => {
		const parameters = {
			type: "object",
			additionalProperties: false,
			properties: { query: { type: "string" } },
			required: ["query"],
		};

		expect(injectGateFields({ tools: [{ function: { name: "read", parameters } }] })).toBe(true);
		expect(parameters.required).toEqual(["query", ...GATE_KEYS]);
		expect(parameters.additionalProperties).toBe(false);

		const scope = parameters.properties[SCOPE];
		expect(scope.required).toEqual(["kind", "new_scope_goal", "new_scope_retention_budget", "replacement"]);
		expect(scope.additionalProperties).toBe(false);
		expect(scope.properties.kind.enum).toEqual(["resetScope", "keepLast", "removeLast", "meToo"]);
		expect(scope.properties.new_scope_goal.anyOf).toEqual([{ type: "string", minLength: 1 }, { type: "null" }]);
		expect(scope.properties.new_scope_retention_budget.anyOf).toEqual([
			{ type: "integer", minimum: 1 },
			{ type: "null" },
		]);
		expect(scope.properties.replacement.anyOf).toEqual([{ type: "string", minLength: 1 }, { type: "null" }]);

		for (const key of [WORKERS, INTENT]) {
			expect(parameters.properties[key]).toEqual(GATE_DEFINITIONS[key]);
		}
	});

	it("keeps the concise scope for a non-strict root", () => {
		const parameters = objectSchema();

		expect(injectGateFields({ tools: [{ function: { name: "search", parameters } }] })).toBe(true);
		expect(parameters.properties[SCOPE]).toEqual(GATE_DEFINITIONS[SCOPE]);
		expect(parameters.properties[SCOPE].required).toEqual(["kind"]);
	});

	it("stays idempotent on a strict root", () => {
		const parameters = {
			type: "object",
			additionalProperties: false,
			properties: { query: { type: "string" } },
			required: ["query"],
		};
		const payload = { tools: [{ function: { name: "read", parameters } }] };

		expect(injectGateFields(payload)).toBe(true);
		const afterFirst = snapshot(parameters);
		expect(injectGateFields(payload)).toBe(false);
		expect(parameters).toEqual(afterFirst);
	});

	it("keeps every property required after injection", () => {
		const parameters = {
			type: "object",
			additionalProperties: false,
			properties: { query: { type: "string" } },
			required: ["query"],
		};

		expect(injectGateFields({ tools: [{ function: { name: "read", parameters } }] })).toBe(true);
		for (const key of Object.keys(parameters.properties)) {
			expect(parameters.required).toContain(key);
		}
	});

	it("keeps a strict root valid without the worker field", () => {
		const parameters = {
			type: "object",
			additionalProperties: false,
			properties: { query: { type: "string" } },
			required: ["query"],
		};

		expect(injectGateFields({ tools: [{ function: { name: "read", parameters } }] }, { includeWorkers: false })).toBe(
			true,
		);
		expect(parameters.required).toEqual(["query", INTENT, SCOPE]);
		expect(parameters.properties[SCOPE].required).toHaveLength(4);
		expect(parameters.properties[WORKERS]).toBeUndefined();
	});
});

describe("composition", () => {
	it("walks allOf, anyOf, and oneOf branches", () => {
		const first = objectSchema();
		const second = objectSchema();
		const third = objectSchema();
		const parameters = {
			allOf: [first, { anyOf: [{ oneOf: [second, third] }] }],
		};

		expect(injectGateFields({ tools: [{ function: { parameters } }] })).toBe(true);
		for (const branch of [first, second, third]) expectGate(branch);
		expect(parameters.properties).toBeUndefined();
		expect(parameters.required).toBeUndefined();
	});

	it("terminates on a cyclic composition", () => {
		const parameters = { type: "object", properties: {} };
		parameters.allOf = [parameters];
		const payload = { tools: [{ function: { parameters } }] };

		expect(injectGateFields(payload)).toBe(true);
		expect(parameters.required).toEqual([...GATE_KEYS]);
		expect(injectGateFields(payload)).toBe(false);
	});

	it("skips a $ref root", () => {
		const parameters = { $ref: "#/$defs/Search" };

		expect(injectGateFields({ tools: [{ function: { parameters } }] })).toBe(false);
		expect(parameters).toEqual({ $ref: "#/$defs/Search" });
	});

	it("skips a $ref branch but injects a local object branch", () => {
		const local = objectSchema();
		const parameters = { anyOf: [{ $ref: "#/$defs/Search" }, local] };

		expect(injectGateFields({ tools: [{ function: { parameters } }] })).toBe(true);
		expect(parameters.anyOf[0]).toEqual({ $ref: "#/$defs/Search" });
		expectGate(local);
	});

	it("does not inject into nested object properties", () => {
		const nested = { type: "object", properties: { query: { type: "string" } } };
		const parameters = { type: "object", properties: { filter: nested } };

		expect(injectGateFields({ tools: [{ function: { parameters } }] })).toBe(true);
		expectGate(parameters);
		expect(nested.required).toBeUndefined();
		expect(nested.properties[INTENT]).toBeUndefined();
	});
});

describe("object detection and malformed input", () => {
	it("injects into a nullable object root", () => {
		const parameters = { type: ["object", "null"], properties: { query: { type: "string" } } };

		expect(injectGateFields({ tools: [{ function: { parameters } }] })).toBe(true);
		expectGate(parameters);
	});

	it("injects into a schema that declares properties without a type", () => {
		const parameters = { properties: { query: { type: "string" } } };

		expect(injectGateFields({ tools: [{ function: { parameters } }] })).toBe(true);
		expectGate(parameters);
	});

	it("creates properties and required for a bare object", () => {
		const parameters = { type: "object" };

		expect(injectGateFields({ tools: [{ function: { parameters } }] })).toBe(true);
		expectGate(parameters);
	});

	it("leaves non-object schemas alone", () => {
		const schemas = [{ type: "string" }, { type: "array", items: { type: "string" } }, { enum: ["a", "b"] }];

		for (const parameters of schemas) {
			const before = snapshot(parameters);
			expect(injectGateFields({ tools: [{ function: { parameters } }] })).toBe(false);
			expect(parameters).toEqual(before);
		}
	});

	it("leaves malformed properties and required fields untouched", () => {
		const schemas = [
			{ type: "object", properties: [] },
			{ type: "object", properties: "query" },
			{ type: "object", properties: {}, required: "intent" },
			{ type: "object", properties: {}, required: { intent: true } },
		];

		for (const parameters of schemas) {
			const before = snapshot(parameters);
			expect(injectGateFields({ tools: [{ function: { parameters } }] })).toBe(false);
			expect(parameters).toEqual(before);
		}
	});

	it("does not throw on a frozen schema", () => {
		const parameters = Object.freeze({ type: "object" });

		expect(() => injectGateFields({ tools: [{ function: { parameters } }] })).not.toThrow();
		expect(parameters).toEqual({ type: "object" });
	});

	it("checks own properties when it looks for existing gate fields", () => {
		const properties = Object.create({ [INTENT]: { type: "string" } });
		const parameters = { type: "object", properties };

		expect(injectGateFields({ tools: [{ function: { parameters } }] })).toBe(true);
		expect(Object.hasOwn(properties, INTENT)).toBe(true);
		expect(GATE_KEYS.every((key) => Object.hasOwn(properties, key))).toBe(true);
	});
});

describe("scheduling self-check", () => {
	it("can leave out the worker field", () => {
		const parameters = objectSchema();

		expect(injectGateFields({ tools: [{ function: { parameters } }] }, { includeWorkers: false })).toBe(true);
		expect(parameters.required).toEqual([INTENT, SCOPE]);
		expect(parameters.properties[WORKERS]).toBeUndefined();
		for (const key of [INTENT, SCOPE]) {
			expect(parameters.properties[key]).toEqual(GATE_DEFINITIONS[key]);
		}
	});

	it("adds the worker field later and stays idempotent", () => {
		const parameters = objectSchema();
		const payload = { tools: [{ function: { parameters } }] };

		expect(injectGateFields(payload, { includeWorkers: false })).toBe(true);
		expect(injectGateFields(payload, { includeWorkers: false })).toBe(false);
		expect(injectGateFields(payload)).toBe(true);
		expect(parameters.required).toContain(WORKERS);
		expect(parameters.required).toHaveLength(3);
		expect(injectGateFields(payload)).toBe(false);
	});

	it("treats a missing options object as the default", () => {
		const parameters = objectSchema();

		expect(injectGateFields({ tools: [{ function: { parameters } }] }, null)).toBe(true);
		expect(parameters.required).toContain(WORKERS);
	});
});

describe("payload safety", () => {
	it("leaves non-object payloads alone", () => {
		for (const payload of [undefined, null, 42, "tools", [], true]) {
			expect(injectGateFields(payload)).toBe(false);
		}
	});

	it("does not walk unknown containers", () => {
		const parameters = objectSchema();
		const payload = { request: { tools: [{ function: { name: "search", parameters } }] } };

		expect(injectGateFields(payload)).toBe(false);
		expect(parameters.required).toBeUndefined();
	});

	it("ignores non-array tool lists", () => {
		expect(injectGateFields({ tools: "nope", config: { tools: null } })).toBe(false);
	});
});

describe("stripGateFields", () => {
	it("returns undefined when no gate field is present", () => {
		for (const input of [undefined, null, 42, "x", [], true, {}, { query: "x" }]) {
			expect(stripGateFields(input)).toBeUndefined();
		}
	});

	it("removes all three fields without mutating the input", () => {
		const input = {
			query: "x",
			[WORKERS]: 4,
			[INTENT]: "查资料",
			[SCOPE]: { kind: "keepLast" },
		};

		const stripped = stripGateFields(input);
		expect(stripped).toEqual({ query: "x" });
		expect(stripped).not.toBe(input);
		expect(input).toEqual({
			query: "x",
			[WORKERS]: 4,
			[INTENT]: "查资料",
			[SCOPE]: { kind: "keepLast" },
		});
	});

	it("removes the hyphenated aliases too", () => {
		const input = { query: "x", [LEGACY_WORKERS]: 2 };

		expect(stripGateFields(input)).toEqual({ query: "x" });
	});

	it("returns an empty object when only gate fields are present", () => {
		const input = {
			[WORKERS]: 1,
			[INTENT]: "推进",
			[SCOPE]: { kind: "keepLast" },
		};

		expect(stripGateFields(input)).toEqual({});
	});

	it("ignores inherited fields", () => {
		const input = Object.create({ [INTENT]: "inherited" });
		input.query = "x";

		expect(stripGateFields(input)).toBeUndefined();
	});

	it("keeps business fields and nested values", () => {
		const input = {
			[INTENT]: "推进",
			name: "main",
			options: { deep: { value: 1 } },
		};

		expect(stripGateFields(input)).toEqual({
			name: "main",
			options: { deep: { value: 1 } },
		});
	});
});

describe("host Type builder", () => {
	it("declares all gate fields at object construction", () => {
		const parameters = gatedObject(Type, { slug: Type.String() }, { additionalProperties: false });
		expect(parameters.type).toBe("object");
		expect(parameters.properties.slug).toBeDefined();
		expect(parameters.additionalProperties).toBe(false);
		for (const key of GATE_KEYS) {
			expect(parameters.properties[key]).toBeDefined();
			expect(parameters.required).not.toContain(key);
		}
		expect(parameters.properties[SCOPE].required).toEqual(["kind"]);
	});

	it("leaves the gate fields for provider required injection", () => {
		const parameters = gatedObject(Type, { slug: Type.String() }, { additionalProperties: false });
		expect(injectGateFields({ tools: [{ function: { name: "devops", parameters } }] })).toBe(true);
		for (const key of GATE_KEYS) expect(parameters.required).toContain(key);
	});

	it("caches the gate type properties per host Type object", () => {
		expect(gateTypeProperties(Type)).toBe(gateTypeProperties(Type));
	});

	it("declares gate properties without required on a plain schema", () => {
		const schema = {
			type: "object",
			additionalProperties: false,
			properties: { slug: { type: "string" } },
			required: ["slug"],
		};
		const gated = gatedPlainSchema(schema);
		for (const key of GATE_KEYS) {
			expect(gated.properties[key]).toEqual(GATE_DEFINITIONS[key]);
			expect(gated.required).not.toContain(key);
		}
		expect(gated.required).toEqual(["slug"]);
	});
});
