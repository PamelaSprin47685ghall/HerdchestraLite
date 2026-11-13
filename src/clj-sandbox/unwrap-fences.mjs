/**
 * Input modifier: UFSS fences become standard ClojureScript strings.
 *
 * The walker owns code-state navigation; this modifier only decides the
 * replacement for each literal it is offered:
 *
 * - standard string -> unchanged
 * - fence or bare block -> standard escaped string with the same body
 */

import { escapeStandardString } from "./string-literal.mjs";
import { walkSource } from "./walk-source.mjs";

/**
 * @param {string} source ClojureScript source
 * @returns {{source:string, segments:Array<object>}}
 */
export function unwrapFences(source) {
	return walkSource(source, {
		onLiteral(literal) {
			return literal.kind === "standard" ? literal.raw : escapeStandardString(literal.body);
		},
	});
}
