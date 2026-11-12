/**
 * Cross-entry health registry.
 *
 * Both manifest entries load in the same omp process but must not assume they
 * share one ESM instance. The registry therefore lives on `globalThis` under
 * the frozen key `herdchestra.health.v1`, as specified by the host contract.
 *
 * This module keeps no files: `/herd-status health` merges this in-memory
 * snapshot with its own on-disk checks later. Recording is best effort in the
 * sense that it never throws into the host loop, but it is not permissive: an
 * entry that claims `ok` while degraded or while a required capability is
 * missing is stored as `degraded`. Health may lose an item; it may not lie.
 */

const HEALTH_KEY = Symbol.for("herdchestra.health.v1");
const REGISTRY_VERSION = 1;
const STATUSES = new Set(["starting", "ok", "degraded", "failed", "stopped"]);
const ENTRY_PATTERN = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/;
const CONTROL_CHARACTER = /[\r\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** @param {unknown} value */
function isObjectLike(value) {
	return value !== null && (typeof value === "object" || typeof value === "function");
}

/** @param {unknown} value */
function isPlainObject(value) {
	if (!isObjectLike(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Error value returned by `recordHealth` on rejected input.
 *
 * @param {string} message
 * @param {Record<string, unknown>} data
 */
function invalid(message, data) {
	return Object.freeze({ code: ":INVALID_ARGUMENT", message, data: Object.freeze({ ...data }) });
}

/**
 * Return the process-wide registry, repairing a corrupted slot.
 *
 * A slot written by an older plugin build may have another shape. It is
 * replaced, not trusted, because a wrong health shape is worse than no entry.
 */
function registry() {
	const scope = globalThis;
	let state = scope[HEALTH_KEY];
	if (
		!isObjectLike(state) ||
		state.version !== REGISTRY_VERSION ||
		!(state.entries instanceof Map) ||
		!Number.isFinite(state.updatedAt)
	) {
		state = { version: REGISTRY_VERSION, entries: new Map(), updatedAt: 0 };
		Object.defineProperty(scope, HEALTH_KEY, {
			value: state,
			enumerable: false,
			configurable: true,
			writable: false,
		});
	}
	return state;
}

const UNSUPPORTED = Symbol("unsupported");
const MAX_CAPABILITY_DEPTH = 4;

/**
 * Copy a JSON-shaped value into a frozen value.
 *
 * Capability tables produced by `detectCapabilities` contain booleans,
 * strings, and the `unverified` string array. Those must survive verbatim;
 * functions, Maps, dates, and excessive nesting are rejected instead of being
 * coerced to a misleading `false`.
 *
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown}
 */
function freezeValue(value, depth) {
	if (value === null) return null;
	switch (typeof value) {
		case "string":
		case "boolean":
			return value;
		case "number":
			return Number.isFinite(value) ? value : UNSUPPORTED;
		case "object":
			break;
		default:
			return UNSUPPORTED;
	}
	if (depth >= MAX_CAPABILITY_DEPTH) return UNSUPPORTED;
	if (Array.isArray(value)) {
		const copy = [];
		for (const item of value) {
			const frozen = freezeValue(item, depth + 1);
			if (frozen === UNSUPPORTED) return UNSUPPORTED;
			copy.push(frozen);
		}
		return Object.freeze(copy);
	}
	if (!isPlainObject(value)) return UNSUPPORTED;
	const copy = {};
	for (const [key, item] of Object.entries(value)) {
		if (item === undefined) continue;
		const frozen = freezeValue(item, depth + 1);
		if (frozen === UNSUPPORTED) return UNSUPPORTED;
		copy[key] = frozen;
	}
	return Object.freeze(copy);
}

/**
 * Freeze a capability bag, or return `undefined` when its shape is unsupported.
 *
 * @param {unknown} capabilities
 */
function freezeCapabilities(capabilities) {
	if (!isPlainObject(capabilities)) return undefined;
	const frozen = freezeValue(capabilities, 0);
	return frozen === UNSUPPORTED ? undefined : frozen;
}

/**
 * Pick the message text from an error-like value.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function errorText(value) {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.message;
	if (isObjectLike(value) && typeof value.message === "string") return value.message;
	if (isObjectLike(value) && typeof value.code === "string") return value.code;
	return String(value);
}

/**
 * Whether a stored value still has the frozen entry shape.
 *
 * A registry can be shared with an older or newer plugin build. Values that do
 * not match are dropped from the snapshot instead of being rendered as health.
 *
 * @param {unknown} value
 */
function isStoredEntry(value) {
	return (
		isPlainObject(value) &&
		typeof value.entry === "string" &&
		typeof value.status === "string" &&
		STATUSES.has(value.status) &&
		(value.version === undefined || typeof value.version === "string") &&
		(value.capabilities === undefined || isPlainObject(value.capabilities)) &&
		typeof value.degraded === "boolean" &&
		(value.error === undefined || typeof value.error === "string")
	);
}

/**
 * Record or replace one entry in the in-memory health registry.
 *
 * Input:
 * - `entry`: stable name such as `main`, `tool-gate`, or `host`.
 * - `status`: `starting` | `ok` | `degraded` | `failed` | `stopped`.
 * - `version`: host or plugin version string.
 * - `capabilities`: flat capability bag.
 * - `degraded`: caller's explicit degradation flag.
 * - `error`: message text or an Error.
 * - `requiredCapabilities`: names that must be `true` in `capabilities`.
 *
 * Output: `{ ok: true, entry, updatedAt }` or `{ ok: false, error }`.
 *
 * `ok` plus `degraded`, a present `error`, or a missing required capability is
 * stored as `degraded`. A `failed` entry is always degraded. This method never
 * throws; an invalid record is rejected and the previous entry is kept.
 *
 * @param {{
 *   entry?: unknown,
 *   status?: unknown,
 *   version?: unknown,
 *   capabilities?: unknown,
 *   degraded?: unknown,
 *   error?: unknown,
 *   requiredCapabilities?: unknown,
 * }} record
 */
export function recordHealth(record) {
	try {
		if (!isPlainObject(record)) {
			return { ok: false, error: invalid("health record must be a plain object", { actual: typeof record }) };
		}
		const name = record.entry;
		if (typeof name !== "string" || !ENTRY_PATTERN.test(name) || CONTROL_CHARACTER.test(name)) {
			return {
				ok: false,
				error: invalid("health entry must be a short stable name", { actual: String(name) }),
			};
		}

		const requestedStatus = record.status;
		if (typeof requestedStatus !== "string" || !STATUSES.has(requestedStatus)) {
			return {
				ok: false,
				error: invalid("health status is missing or not recognised", {
					entry: name,
					actual: String(requestedStatus),
					expected: [...STATUSES],
				}),
			};
		}

		if (record.degraded !== undefined && typeof record.degraded !== "boolean") {
			return {
				ok: false,
				error: invalid("health degraded flag must be a boolean", {
					entry: name,
					actual: typeof record.degraded,
				}),
			};
		}

		const version = record.version;
		if (version !== undefined && (typeof version !== "string" || version.length === 0)) {
			return {
				ok: false,
				error: invalid("health version must be a non-empty string", { entry: name, actual: typeof version }),
			};
		}

		const capabilities = freezeCapabilities(record.capabilities);
		if (record.capabilities !== undefined && capabilities === undefined) {
			return {
				ok: false,
				error: invalid("health capabilities must be a flat plain object", { entry: name }),
			};
		}
		const required = record.requiredCapabilities;
		let missing = [];
		if (required !== undefined) {
			if (!Array.isArray(required) || required.some((key) => typeof key !== "string")) {
				return {
					ok: false,
					error: invalid("requiredCapabilities must be an array of strings", { entry: name }),
				};
			}
			missing = required.filter((key) => capabilities?.[key] !== true);
		}

		const errorTextValue = errorText(record.error);
		const degraded =
			record.degraded === true ||
			requestedStatus === "degraded" ||
			requestedStatus === "failed" ||
			errorTextValue !== undefined ||
			missing.length > 0;
		const status =
			degraded && (requestedStatus === "ok" || requestedStatus === "starting")
				? "degraded"
				: requestedStatus;
		const message =
			missing.length > 0
				? `${errorTextValue ?? "required host capability missing"}: ${missing.join(", ")}`
				: errorTextValue;

		const entry = Object.freeze({
			entry: name,
			status,
			version: version,
			capabilities,
			degraded,
			error: message,
		});

		const state = registry();
		state.entries.set(name, entry);
		state.updatedAt = Math.max(Date.now(), state.updatedAt + 1);
		return { ok: true, entry, updatedAt: state.updatedAt };
	} catch (cause) {
		return {
			ok: false,
			error: Object.freeze({
				code: ":INVALID_ARGUMENT",
				message: "health record could not be stored",
				data: Object.freeze({ cause: errorText(cause) }),
			}),
		};
	}
}

/**
 * Read a frozen snapshot of every recorded health entry.
 *
 * Output: `{ entries, updatedAt }`. Entries are sorted by name so two callers
 * with the same registry see the same order. The returned array and records
 * are frozen; mutating them cannot change the registry. This function never
 * throws.
 *
 * @returns {{ entries: ReadonlyArray<Readonly<Record<string, unknown>>>, updatedAt: number }}
 */
export function readHealth() {
	try {
		const state = registry();
		for (const [name, value] of state.entries) {
			if (!isStoredEntry(value)) state.entries.delete(name);
		}
		const entries = [...state.entries.values()].sort((left, right) => {
			if (left.entry < right.entry) return -1;
			if (left.entry > right.entry) return 1;
			return 0;
		});
		return Object.freeze({
			entries: Object.freeze(entries),
			updatedAt: state.updatedAt,
		});
	} catch {
		return Object.freeze({ entries: Object.freeze([]), updatedAt: 0 });
	}
}
