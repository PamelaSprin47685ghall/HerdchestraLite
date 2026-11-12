/**
 * True for a plain data object: not `null`, not an array.
 *
 * Used to reject tool arguments and provider payloads that arrive as strings,
 * arrays, or `null`, before reading keys from them.
 */
export function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keys of `value` that are not in `allowed`, in insertion order.
 *
 * Inputs: a candidate object and the field names the caller accepts.
 * Output: the unexpected key list; empty for a non-object or a fully known set.
 * The caller decides whether unexpected keys are an error or are dropped.
 */
export function unknownFields(value, allowed) {
	if (!isObject(value)) return [];
	return Object.keys(value).filter((key) => !allowed.includes(key));
}
