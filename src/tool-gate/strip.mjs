/**
 * Execution side of the tool gate: the gate arguments exist only in the tool
 * contract the model sees. They are removed before the arguments reach the
 * tool, which does not know them.
 */

import { THINK_PARAMETER, WORKERS_PARAMETER } from "./schema.mjs";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Remove the gate arguments from a tool call. Returns undefined when the input
 * carries neither argument, so the extension leaves unrelated calls untouched.
 *
 * @param {unknown} input
 * @returns {Record<string, unknown> | undefined}
 */
export function stripGateParameters(input) {
	if (!isObject(input)) return undefined;
	if (!(WORKERS_PARAMETER in input) && !(THINK_PARAMETER in input)) return undefined;

	const stripped = { ...input };
	delete stripped[WORKERS_PARAMETER];
	delete stripped[THINK_PARAMETER];
	return stripped;
}
