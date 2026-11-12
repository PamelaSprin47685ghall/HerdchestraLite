/**
 * UFSS prompt note shared by every system-prompt assembly.
 *
 * Describes the reader/printer contract the sandbox actually implements
 * (`src/clj-sandbox/ufss.mjs`): escaped strings, single-line raw fences, and
 * indented multi-line blocks at any fence depth, with a bijective reader.
 *
 * Depends on nothing; `prompts/common.mjs` and `prompts/dogfood-surface.mjs`
 * both include it so the two assemblies cannot drift apart.
 */

export const UFSS_PROMPT_NOTE = [
	"# EDN + UFSS: Arbitrary-Depth Raw Fences",
	"",
	"Every receipt you get is EDN, and every string in it is printed as UFSS (Universal Fence-Scaled String). You are not restricted to one escaping style; you are expected to pick the strongest one.",
	"",
	"Three string forms, all accepted by the same reader:",
	"1. Standard escaped string — only for short text with no quote, no backslash, no newline. This is the fallback, not the default.",
	"2. Single-line raw fence: one or more hash characters, then a quoted body, then the same number of hash characters. The body is taken verbatim: quotes, backslashes, and hash characters inside stay literal.",
	"3. Multi-line raw block: hash, triple quote, newline, the body, then triple quote and hash alone on the last line. The closing indent is stripped from every non-empty body line; a trailing newline is preserved exactly.",
	"",
	'Scaling is the point. If the body already contains a quote, a backslash, or a line beginning with three quotes, raise the fence by one hash: two hashes, three hashes, and so on without a ceiling. With n hashes the forms are #^n"..."#^n and #^n"""..."""#^n. The printer chooses the smallest n whose closing sequence does not appear in the body, so a raw fence always exists. The reader and printer are a bijection: round-tripping any string returns it byte for byte.',
	"",
	"Rules:",
	"- Never hand-build quote, backslash, or newline escapes for source code, paths, regexes, diffs, or multi-line prose. Use a raw fence and let the depth grow.",
	'- Inside REPL literals prefer raw fences exactly as above; write regexes as (re-pattern #"..."#), because the hash-quoted form is a raw string, not a regex literal.',
	"- Indentation is structural: every non-empty line of a multi-line block must carry at least the closing fence indent. A short line is :UFSS_INDENT_VIOLATION, never silently swallowed.",
	"- Control characters other than newline and tab are the one case that falls back to a standard escaped string.",
	"- When you submit data to a tool, JSON, standard EDN, and UFSS are all accepted and normalized. When the framework answers you, it never sends escaped JSON noise for text a fence can carry.",
].join("\n");
