/**
 * UFSS public surface.
 *
 * UFSS owns exactly one extension to a reader: a raw string fence. Everything
 * else is EDN, and `readUfss` is the EDN shim over `readEdn`. `readCljs` is the
 * ClojureScript shim; until an official CLJS reader is wired in, it shares the
 * same EDN tokenizer and rejects official reader macros instead of imitating
 * them here.
 *
 * Adding a dialect means wrapping the same `readUfssLiteral` hook, never
 * copying tokenization or the fence grammar.
 */

import { readEdn } from "./edn-reader.mjs";

export { EdnKeyword, EdnList, EdnSymbol } from "./edn-value.mjs";
export { printUfss, renderReceipt } from "./edn-writer.mjs";
export { readUfssLiteral } from "./ufss-literal.mjs";

/** Read EDN + UFSS data. Official Clojure reader macros are rejected. */
export function readUfss(text) {
	return readEdn(text);
}

/**
 * Read a ClojureScript source form. The fence hook is shared with `readUfss`;
 * official `#` reader macros belong to the CLJS reader, not to this shim.
 */
export function readCljs(text) {
	return readEdn(text);
}

export const UFSS_PROMPT_NOTE = [
	"# Universal Fence-Scaled String (UFSS): Arbitrary-Depth Raw Fences",
	"UFSS is the raw string notation used in every EDN receipt. It avoids escaping quotes, backslashes, and newlines by choosing a fence deeper than any closing sequence in the body. Use `##` by default for ordinary text; use `###` when developing HerdchestraLite itself, because its source, docs, and prompts contain many quotes, backslashes, and fence-like sequences. Fence depth is arbitrary: zero hashes (bare multi-line), one, or more all work; the printer picks the smallest, but you're free. Raise the fence instead of escaping.",
	"",
	"Every receipt you get is EDN, and every string in it is printed as UFSS (Universal Fence-Scaled String). You are not restricted to one escaping style; you are expected to pick the strongest one.",
	"",
	"Three string forms, all accepted by the same reader:",
	'1. Standard escaped string — only for short text with no quote, no backslash, no newline. This is the fallback, not the default.',
	'2. Single-line raw fence: `##"..."##` for ordinary text, or `###"..."###` when developing HerdchestraLite. The body is taken verbatim: quotes, backslashes, and hash characters inside stay literal.',
	'3. Multi-line raw block: `##"""..."""##` for ordinary text, or `###"""..."""###` when developing HerdchestraLite. The closing indent is stripped from every non-empty body line; a trailing newline is preserved exactly.',
	"",
	'Scaling is the point. With two hashes the forms are `##"..."##` and `##"""..."""##`; with three hashes, `###"..."###` and `###"""..."""###`. If the body already contains a quote, a backslash, or a line beginning with three quotes, raise the fence by one hash; continue without a ceiling. The printer chooses the smallest n whose closing sequence does not appear in the body, so a raw fence always exists. The reader and printer are a bijection: round-tripping any string returns it byte for byte.',
	"",
	"Examples (all obey the default depth):",
	'- Ordinary text: `##"He said "hello"."##`',
	"- Herd source: `###\"const marker = '\"\"\"';\"###`",
	"- Ordinary block:",
	'##"""',
	'ordinary body with "quotes"',
	'"""##',
	"- Herd block:",
	'###"""',
	`const marker = '"""';`,
	'"""###',
	"",
	"",
	"Concrete repair example (Herd source, so `###`):",
	"LLM classic: models often say `strawberry` has two r's. The wrong text is `2 r's`; the repair must hit that exact occurrence and leave the rest untouched.",
	"Before: `###\"export const STRAWBERRY_FACT = \"strawberry has 2 r's\";\"###`",
	"Program:",
	'(let [path "src/llm-meme.mjs"',
	"      src  (cat {:path path})",
	"      [b e] (where {:content src",
	"                    :needle ###\"export const STRAWBERRY_FACT = \"strawberry has 2 r's\";\"###})]",
	"  (write {:path path",
	"          :content (str (subs src 0 b)",
	"                        ###\"export const STRAWBERRY_FACT = \"strawberry has 3 r's\";\"###",
	"                        (subs src e))}))",
	"",
	"Why this beats `python/replace` or `apply_patch`:",
	"- `cat` is byte-exact; `read` may reformat and is not a patch basis.",
	"- `where` returns one exact UTF-16 span; 0 or multiple matches park with candidates instead of guessing.",
	"- UFSS `###` keeps inner quotes literal; the needle and replacement need no escaping.",
	"- `write` replaces only `[b e]`; surrounding text is never retyped.",
	"- Python `str.replace` defaults to all occurrences and silently no-ops when the target drifts; regex adds escaping noise.",
	"- `apply_patch` depends on diff context and line drift; the model must reproduce surrounding lines. This path uses the real file text and exact spans.",
	"",
	"WARNING — the mistakes that actually break a fence:",
	'- A raw fence is not a regex. `##"..."##` is a raw string; write regexes as `(re-pattern ##"..."##)`.',
	"- Never hand-build backslash escapes for quotes, backslashes, or newlines in code, paths, diffs, or multi-line prose. If the body needs those escapes, raise the fence depth instead.",
	"- The closing fence must stand alone on its own line, at the same indent as the opening line. Any trailing parenthesis or text makes it a parse error, not a closing fence.",
	"- Every non-empty body line must carry at least the closing fence indent. A short line is `:UFSS_INDENT_VIOLATION`, never silently swallowed.",
	"- If the body contains three consecutive quotes, a closing-fence sequence, or a line of hashes, raise the fence by one hash until the closing sequence does not occur in the body.",
	"- Control characters other than newline and tab cannot live in a raw fence; use a standard escaped string for those.",
	"- JSON, standard EDN, and UFSS are all accepted on input and normalized. On output the framework never sends escaped JSON noise for text a fence can carry; do not pre-escape it yourself.",
].join("\n");
