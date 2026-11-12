/**
 * G0: the wire-schema side of the tool gate.
 *
 * Every non-exempt tool schema in a provider request gains three required
 * arguments. The model sees the fields. The tools never receive them because
 * the execution side strips them.
 *
 * The injector covers the OpenAI, Anthropic, bare, Google, and Bedrock
 * transports. It walks `allOf` / `anyOf` / `oneOf` branches, skips `$ref`
 * nodes, and is idempotent. It never follows arbitrary payload paths and it
 * never overwrites a definition that a tool already declares.
 */

const WORKERS = "how_many_more_workers_are_allowed_without_hitting_mythical_man_month";
const INTENT = "intent";
const SCOPE = "scope";

/** Gate keys in wire order. The hyphenated spellings are aliases, not keys. */
export const GATE_KEYS = Object.freeze([WORKERS, INTENT, SCOPE]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Freeze a definition tree. The injector clones each definition before it
 * writes it into a schema, so a provider adapter can never mutate this source.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
	if (value === null || typeof value !== "object") return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

/** @template T @param {T} value @returns {T} */
function clone(value) {
	if (Array.isArray(value)) return /** @type {T} */ (value.map(clone));
	if (isObject(value)) {
		const copy = {};
		for (const [key, child] of Object.entries(value)) copy[key] = clone(child);
		return /** @type {T} */ (copy);
	}
	return value;
}

/**
 * JSON Schema fragments for the gate arguments.
 *
 * `scope` is closed: the four Scope kinds are the only accepted values, and
 * the runtime ledger validates the fields that each kind requires.
 */
export const GATE_DEFINITIONS = deepFreeze({
	[WORKERS]: {
		type: "integer",
		description:
			"Maintain aggressive causal parallelism (Brooks check: disjoint contracts/slices ready to run concurrently; target total workload in turns / 100). Never skimp on dispatching independent work.",
	},
	[INTENT]: {
		type: "string",
		minLength: 1,
		description:
			"Concise zh-cn action intent after passing the 3 introspection gates; allocates execution deadline (UTF-8 byteLength * 50ms).",
	},
	[SCOPE]: {
		type: "object",
		additionalProperties: false,
		required: ["kind"],
		properties: {
			kind: { type: "string", enum: ["resetScope", "keepLast", "removeLast", "meToo"] },
			new_scope_goal: { type: "string", minLength: 1 },
			new_scope_retention_budget: { type: "integer", minimum: 1 },
			replacement: { type: "string", minLength: 1 },
		},
		description: "Mandatory Scope annotation (`COMMON # Scope`). Stripped before tool execution.",
	},
});

/**
 * Strict JSON-schema sampling requires every object property to be listed in
 * `required` and optional values to use a null union. The host applies that
 * transform before this injector runs, so a strict tool needs this variant to
 * stay valid at the provider.
 */
const STRICT_SCOPE_DEFINITION = deepFreeze({
	type: "object",
	additionalProperties: false,
	required: ["kind", "new_scope_goal", "new_scope_retention_budget", "replacement"],
	properties: {
		kind: { type: "string", enum: ["resetScope", "keepLast", "removeLast", "meToo"] },
		new_scope_goal: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
		new_scope_retention_budget: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
		replacement: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
	},
	description: "Mandatory Scope annotation (`COMMON # Scope`). Stripped before tool execution.",
});

/** The same contract without the optional scheduling self-check. */
const GATE_DEFINITIONS_WITHOUT_WORKERS = deepFreeze({
	[INTENT]: GATE_DEFINITIONS[INTENT],
	[SCOPE]: GATE_DEFINITIONS[SCOPE],
});

/**
 * Tools that must not carry a Scope annotation. They are part of the Scope
 * mechanism itself. The aliases match the ledger's accepted spellings.
 */
const EXEMPT_TOOLS = new Set(["ask_previous_scope", "askPreviousScope", "ask-previous-scope", "assume"]);

const COMPOSITION_KEYWORDS = Object.freeze(["allOf", "anyOf", "oneOf"]);

/**
 * A strict root lists every property in `required` and closes the object.
 * The host's strict converter produces exactly this shape.
 *
 * @param {Record<string, unknown>} schema
 * @returns {boolean}
 */
function isStrictObjectSchema(schema) {
	if (schema.additionalProperties !== false) return false;
	if (!Array.isArray(schema.required)) return false;
	const properties = isObject(schema.properties) ? schema.properties : {};
	return Object.keys(properties).every((key) => schema.required.includes(key));
}

/**
 * @param {string} key
 * @param {Record<string, unknown>} definitions
 * @param {boolean} strict
 * @returns {unknown}
 */
function definitionFor(key, definitions, strict) {
	if (strict && key === SCOPE) return STRICT_SCOPE_DEFINITION;
	return definitions[key];
}

/**
 * Add the definitions to one root object schema. The function plans every
 * write before it applies any write, so a frozen or malformed schema stays
 * byte-for-byte unchanged.
 *
 * @param {Record<string, unknown>} schema
 * @param {Record<string, unknown>} definitions
 * @returns {boolean}
 */
function injectObjectSchema(schema, definitions) {
	if (Object.hasOwn(schema, "$ref")) return false;

	const properties = Object.hasOwn(schema, "properties") ? schema.properties : undefined;
	if (properties !== undefined && !isObject(properties)) return false;

	const required = Object.hasOwn(schema, "required") ? schema.required : undefined;
	if (required !== undefined && !Array.isArray(required)) return false;

	const objectType = schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object"));
	if (!objectType && properties === undefined) return false;

	const keys = Object.keys(definitions);
	const missingProperties = keys.filter((key) => properties === undefined || !Object.hasOwn(properties, key));
	const missingRequired = keys.filter((key) => required === undefined || !required.includes(key));
	if (missingProperties.length === 0 && missingRequired.length === 0) return false;

	const strict = isStrictObjectSchema(schema);
	let targetProperties = properties;
	if (missingProperties.length > 0) {
		if (properties === undefined) {
			if (!Object.isExtensible(schema)) return false;
			targetProperties = {};
		} else if (!Object.isExtensible(properties)) {
			if (!Object.isExtensible(schema)) return false;
			targetProperties = { ...properties };
		}
	}

	let targetRequired = required;
	if (missingRequired.length > 0) {
		if (required === undefined) {
			if (!Object.isExtensible(schema)) return false;
			targetRequired = [];
		} else if (!Object.isExtensible(required)) {
			if (!Object.isExtensible(schema)) return false;
			targetRequired = [...required];
		}
	}

	if (targetProperties !== properties) schema.properties = targetProperties;
	for (const key of missingProperties) targetProperties[key] = clone(definitionFor(key, definitions, strict));

	if (targetRequired !== required) schema.required = targetRequired;
	for (const key of missingRequired) targetRequired.push(key);

	return true;
}

/**
 * Walk one schema tree. Composition branches are visited so a union-rooted
 * tool schema still gets the arguments. A node is visited once, so cyclic
 * schemas terminate.
 *
 * @param {unknown} schema
 * @param {Record<string, unknown>} definitions
 * @param {Set<unknown>} seen
 * @returns {boolean}
 */
function injectSchema(schema, definitions, seen) {
	if (!isObject(schema) || seen.has(schema)) return false;
	seen.add(schema);

	// A `$ref` node has no local object to extend. Skipping it also avoids
	// injecting into a shared definition that other tools may not own.
	if (Object.hasOwn(schema, "$ref")) return false;

	let changed = false;
	for (const keyword of COMPOSITION_KEYWORDS) {
		const branches = schema[keyword];
		if (!Array.isArray(branches)) continue;
		for (const branch of branches) {
			if (injectSchema(branch, definitions, seen)) changed = true;
		}
	}
	if (injectObjectSchema(schema, definitions)) changed = true;
	return changed;
}

/** @param {unknown} name @param {Set<string>} exempt */
function isExempt(name, exempt) {
	return typeof name === "string" && exempt.has(name);
}

/**
 * Inject one tool in any of the five transport shapes. A tool name is
 * resolved per declaration, so an exempt tool stays untouched even when a
 * normal tool shares the same payload.
 *
 * @param {unknown} tool
 * @param {Record<string, unknown>} definitions
 * @param {Set<unknown>} seen
 * @param {Set<string>} exempt
 * @returns {boolean}
 */
function injectTool(tool, definitions, seen, exempt) {
	if (!isObject(tool)) return false;
	let changed = false;

	if (isObject(tool.function) && !isExempt(tool.function.name, exempt)) {
		if (injectSchema(tool.function.parameters, definitions, seen, true)) changed = true;
	}

	if (Array.isArray(tool.functionDeclarations)) {
		for (const declaration of tool.functionDeclarations) {
			if (!isObject(declaration) || isExempt(declaration.name, exempt)) continue;
			if (injectSchema(declaration.parameters, definitions, seen, true)) changed = true;
			if (injectSchema(declaration.parametersJsonSchema, definitions, seen, true)) changed = true;
		}
	}

	if (isObject(tool.toolSpec) && !isExempt(tool.toolSpec.name, exempt) && isObject(tool.toolSpec.inputSchema)) {
		if (injectSchema(tool.toolSpec.inputSchema.json, definitions, seen, true)) changed = true;
	}

	if (!isExempt(tool.name, exempt)) {
		if (injectSchema(tool.input_schema, definitions, seen, true)) changed = true;
		if (injectSchema(tool.parameters, definitions, seen, true)) changed = true;
	}

	return changed;
}

/**
 * Collect only the known tool arrays. The injector must never walk arbitrary
 * payload fields, because a request also carries messages and model options.
 *
 * @param {Record<string, unknown>} payload
 * @returns {unknown[][]}
 */
function toolArrays(payload) {
	const arrays = [];
	if (Array.isArray(payload.tools)) arrays.push(payload.tools);
	if (isObject(payload.toolConfig) && Array.isArray(payload.toolConfig.tools)) {
		arrays.push(payload.toolConfig.tools);
	}
	// Google GenAI wraps tools in `config.tools`.
	if (isObject(payload.config) && Array.isArray(payload.config.tools)) {
		arrays.push(payload.config.tools);
	}
	return arrays;
}

/**
 * @param {unknown} payload
 * @param {Record<string, unknown>} definitions
 * @param {Set<string>} exempt
 * @returns {boolean}
 */
function injectWithDefinitions(payload, definitions, exempt) {
	if (!isObject(payload)) return false;

	const seen = new Set();
	let changed = false;
	for (const tools of toolArrays(payload)) {
		for (const tool of tools) {
			if (injectTool(tool, definitions, seen, exempt)) changed = true;
		}
	}
	return changed;
}

/**
 * Inject the gate arguments into every non-exempt tool schema.
 *
 * @param {unknown} payload
 * @param {{ includeWorkers?: boolean }} [options] Set `includeWorkers: false`
 *   to leave out the scheduling self-check field.
 * @returns {boolean} true when at least one schema changed.
 */
export function injectGateFields(payload, options) {
	const includeWorkers = !isObject(options) || options.includeWorkers !== false;
	return injectWithDefinitions(
		payload,
		includeWorkers ? GATE_DEFINITIONS : GATE_DEFINITIONS_WITHOUT_WORKERS,
		EXEMPT_TOOLS,
	);
}

const gateTypeCache = new WeakMap();

/**
 * Convert one gate fragment into host `Type` primitives. The host's
 * `Type.Object` compiles at construction, so the fields must be part of the
 * original object call, not added by later object spread.
 *
 * @param {Record<string, unknown>} Type
 * @param {unknown} schema
 * @returns {unknown}
 */
function schemaToType(Type, schema) {
	if (!isObject(Type) || !isObject(schema)) throw new TypeError("gate schema conversion requires Type and schema");
	if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "string")) {
		return Type.String({
			enum: schema.enum,
			...(typeof schema.description === "string" ? { description: schema.description } : {}),
		});
	}
	if (schema.type === "string") {
		return Type.String({
			...(typeof schema.minLength === "number" ? { minLength: schema.minLength } : {}),
			...(typeof schema.description === "string" ? { description: schema.description } : {}),
		});
	}
	if (schema.type === "integer") {
		return Type.Integer({
			...(typeof schema.minimum === "number" ? { minimum: schema.minimum } : {}),
			...(typeof schema.description === "string" ? { description: schema.description } : {}),
		});
	}
	if (schema.type === "object") {
		const properties = {};
		const required = new Set(Array.isArray(schema.required) ? schema.required : []);
		for (const [key, child] of Object.entries(isObject(schema.properties) ? schema.properties : {})) {
			const converted = schemaToType(Type, child);
			properties[key] = required.has(key) ? converted : Type.Optional(converted);
		}
		return Type.Object(properties, {
			additionalProperties: schema.additionalProperties === true,
			...(typeof schema.description === "string" ? { description: schema.description } : {}),
		});
	}
	throw new TypeError(`unsupported gate schema type: ${String(schema.type)}`);
}

/**
 * Gate properties built with the host's own `Type` primitives. They are
 * optional on the registered schema: the host validates the rewritten,
 * stripped input again before execution, so required gate fields would fail.
 * Provider wire injection adds them to `required` for the model. A WeakMap
 * keeps one compiled type set per host Type object.
 *
 * @param {Record<string, unknown>} Type
 * @returns {Record<string, unknown>}
 */
export function gateTypeProperties(Type) {
	if (!isObject(Type)) throw new TypeError("gateTypeProperties requires the host Type object");
	const cached = gateTypeCache.get(Type);
	if (cached !== undefined) return cached;
	const properties = {};
	for (const key of GATE_KEYS) properties[key] = Type.Optional(schemaToType(Type, GATE_DEFINITIONS[key]));
	gateTypeCache.set(Type, properties);
	return properties;
}

/**
 * Build a tool parameter object with the gate fields declared at construction.
 * The fields are optional here and required only on the provider wire. Use this
 * for every non-exempt product tool instead of `Type.Object`.
 *
 * @param {Record<string, unknown>} Type
 * @param {Record<string, unknown>} properties
 * @param {Record<string, unknown>} [options]
 * @returns {unknown}
 */
export function gatedObject(Type, properties = {}, options = { additionalProperties: false }) {
	if (!isObject(Type) || !isObject(properties)) throw new TypeError("gatedObject requires Type and properties");
	return Type.Object({ ...properties, ...gateTypeProperties(Type) }, isObject(options) ? options : {});
}

/**
 * The plain-JSON equivalent for tools registered from a raw schema.
 *
 * @param {Record<string, unknown>} schema
 * @returns {Record<string, unknown>}
 */
export function gatedPlainSchema(schema) {
	if (!isObject(schema)) return schema;
	return {
		...schema,
		properties: { ...(isObject(schema.properties) ? schema.properties : {}), ...GATE_DEFINITIONS },
	};
}

/**
 * Remove the gate arguments before execution. The function returns undefined
 * when the input carries no gate field, so unrelated calls pass untouched.
 * It also removes the hyphenated aliases, so a model that learned the old
 * spelling cannot leak a gate field into a tool.
 *
 * @param {unknown} input
 * @returns {Record<string, unknown> | undefined}
 */
export function stripGateFields(input) {
	if (!isObject(input)) return undefined;

	const present = [];
	for (const key of GATE_KEYS) {
		if (Object.hasOwn(input, key)) present.push(key);
	}
	for (const key of ["how-many-more-workers-are-allowed-without-hitting-mythical-man-month"]) {
		if (Object.hasOwn(input, key) && !present.includes(key)) present.push(key);
	}
	if (present.length === 0) return undefined;

	const stripped = { ...input };
	for (const key of present) delete stripped[key];
	return stripped;
}
