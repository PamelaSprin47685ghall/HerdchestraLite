/**
 * The three EDN identity types the sandbox needs.
 *
 * Keywords and symbols are values, not strings. Lists keep identity distinct
 * from vectors; vectors stay plain arrays so the sandbox can reuse native
 * iteration without a parallel type.
 */

/** An EDN keyword. */
export class EdnKeyword {
	constructor(name) {
		this.name = name;
		Object.freeze(this);
	}

	toString() {
		return `:${this.name}`;
	}
}

/** An EDN symbol. */
export class EdnSymbol {
	constructor(name) {
		this.name = name;
		Object.freeze(this);
	}

	toString() {
		return this.name;
	}
}

/** An EDN list. Vectors are plain arrays. */
export class EdnList extends Array {}

/**
 * Structural identity for duplicate-key and duplicate-set-entry checks.
 * The reader and writer stay independent: identity is a value concern, not a
 * printing concern.
 */
export function ednIdentity(value) {
	if (value === null) return "nil";
	if (value === true) return "true";
	if (value === false) return "false";
	if (typeof value === "string") return `s:${value.length}:${value}`;
	if (typeof value === "number") return `n:${Object.is(value, -0) ? "-0" : String(value)}`;
	if (typeof value === "bigint") return `b:${value}`;
	if (value instanceof EdnKeyword) return `k:${value.name}`;
	if (value instanceof EdnSymbol) return `y:${value.name}`;
	if (value instanceof EdnList) return `l:${value.length}:${value.map(ednIdentity).join("")}`;
	if (Array.isArray(value)) return `v:${value.length}:${value.map(ednIdentity).join("")}`;
	if (value instanceof Set) {
		return `t:${[...value].map(ednIdentity).sort().join("")}`;
	}
	if (value instanceof Map) {
		const entries = [...value].map(([key, entry]) => `${ednIdentity(key)}=${ednIdentity(entry)}`).sort();
		return `m:${entries.length}:${entries.join("")}`;
	}
	return `?:${String(value)}`;
}
