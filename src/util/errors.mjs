/**
 * Readable text for any thrown value.
 *
 * Inputs: whatever a `catch` block caught.
 * Output: `Error#message` for errors, `String(value)` otherwise.
 * Never throws, so callers can format an error while handling an error.
 */
export function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * `code` of a filesystem or system error.
 *
 * Inputs: whatever a `catch` block caught.
 * Output: the string `code` when the value carries one, `undefined` otherwise.
 * Only the raw code is returned; call sites format suffixes such as ` (EACCES)`
 * themselves so that user-visible text stays under their control.
 */
export function errorCode(error) {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
		return error.code;
	}
	return undefined;
}
