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
