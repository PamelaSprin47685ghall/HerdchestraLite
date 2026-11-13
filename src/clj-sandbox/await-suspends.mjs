/**
 * Syntax modifier: suspend forms become awaited sandbox calls.
 *
 * The model writes `(park ...)`, `(where ...)`, `(unpark ...)`, or
 * `(abandon ...)`; this modifier rewrites the complete form to
 * `(js/await (sandbox/<form> ...))`. Quoted data is left alone, and the body is
 * expanded recursively so nested suspend forms work.
 *
 * Name capture is intentionally out of scope: the model is trusted to treat
 * these four names as reserved, matching the sandbox contract.
 */

import { walkSource } from "./walk-source.mjs";

const SUSPEND_FORMS = new Set(["park", "where", "unpark", "abandon"]);

/**
 * @param {string} source ClojureScript source
 * @returns {{source:string, segments:Array<object>}}
 */
export function awaitSuspends(source) {
	return walkSource(source, {
		onForm(form) {
			if (form.quoted) {
				return form.raw;
			}
			const body = awaitSuspends(form.body).source;
			if (!SUSPEND_FORMS.has(form.head)) {
				return `(${form.head}${body})`;
			}
			return `(js/await (sandbox/${form.head}${body}))`;
		},
	});
}
