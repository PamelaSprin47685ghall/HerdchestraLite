/**
 * Schema side of the tool gate: every tool schema in a provider request body
 * gains two required arguments, so the model sees them as part of the tool
 * contract.
 */

export const WORKERS_PARAMETER = "how-many-more-workers-are-allowed-without-hitting-mythical-man-month";
export const THINK_PARAMETER = "must-think-in";

const REQUIRED_PROPERTIES = {
	[WORKERS_PARAMETER]: {
		type: "integer",
		description:
			"You must maintain the worker count (target total workload in turns / 100). Never skimp on dispatching work.",
	},
	[THINK_PARAMETER]: {
		type: "string",
		enum: ["zh-cn"],
		description: "Language used to reason about this call. The only accepted value is zh-cn.",
	},
};

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Add the gate arguments to one object schema. Returns true when the schema
 * changed. A schema that is neither an object nor has properties is left alone.
 *
 * @param {Record<string, unknown>} schema
 * @returns {boolean}
 */
function injectObjectSchema(schema) {
	const properties = isObject(schema.properties) ? schema.properties : undefined;
	if (schema.type !== "object" && properties === undefined) return false;

	let changed = false;
	const target = properties ?? (schema.properties = {});
	for (const [name, definition] of Object.entries(REQUIRED_PROPERTIES)) {
		if (!(name in target)) {
			target[name] = definition;
			changed = true;
		}
	}

	const required = Array.isArray(schema.required) ? schema.required : (schema.required = []);
	for (const name of Object.keys(REQUIRED_PROPERTIES)) {
		if (!required.includes(name)) {
			required.push(name);
			changed = true;
		}
	}
	return changed;
}

/**
 * Walk a JSON Schema and inject the gate arguments into every object branch.
 * Composition branches are visited so a union-rooted tool schema still gets the
 * arguments. `$ref` roots are skipped: a ref carries no local object to extend.
 *
 * @param {unknown} schema
 * @param {Set<unknown>} seen
 * @returns {boolean}
 */
function injectSchema(schema, seen) {
	if (!isObject(schema) || seen.has(schema)) return false;
	seen.add(schema);

	let changed = false;
	for (const keyword of ["allOf", "anyOf", "oneOf"]) {
		const branches = schema[keyword];
		if (!Array.isArray(branches)) continue;
		for (const branch of branches) {
			if (injectSchema(branch, seen)) changed = true;
		}
	}
	if (injectObjectSchema(schema)) changed = true;
	return changed;
}

/**
 * @param {unknown} tool
 * @param {Set<unknown>} seen
 * @returns {boolean}
 */
function injectTool(tool, seen) {
	if (!isObject(tool)) return false;
	let changed = false;

	if (isObject(tool.function) && injectSchema(tool.function.parameters, seen)) changed = true;
	if (injectSchema(tool.input_schema, seen)) changed = true;
	if (injectSchema(tool.parameters, seen)) changed = true;

	if (Array.isArray(tool.functionDeclarations)) {
		for (const declaration of tool.functionDeclarations) {
			if (isObject(declaration) && injectSchema(declaration.parameters, seen)) changed = true;
		}
	}

	if (isObject(tool.toolSpec) && isObject(tool.toolSpec.inputSchema)) {
		if (injectSchema(tool.toolSpec.inputSchema.json, seen)) changed = true;
	}
	return changed;
}

/**
 * Inject the gate arguments into every tool schema in a provider request body.
 * Handles the tool shapes used by OpenAI-compatible, Anthropic, Google, and
 * Bedrock transports. Returns true when at least one schema changed.
 *
 * @param {unknown} payload
 * @returns {boolean}
 */
export function injectToolSchemas(payload) {
	if (!isObject(payload)) return false;
	const seen = new Set();
	let changed = false;

	if (Array.isArray(payload.tools)) {
		for (const tool of payload.tools) {
			if (injectTool(tool, seen)) changed = true;
		}
	}

	if (isObject(payload.toolConfig) && Array.isArray(payload.toolConfig.tools)) {
		for (const tool of payload.toolConfig.tools) {
			if (injectTool(tool, seen)) changed = true;
		}
	}
	return changed;
}
