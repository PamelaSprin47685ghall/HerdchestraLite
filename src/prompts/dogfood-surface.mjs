/**
 * Dogfood system-prompt surface: the exact tool face that
 * `src/clj-main.mjs` registers, plus how that face cooperates with the other
 * runtime mechanisms in this session.
 *
 * This is NOT a stage briefing and NOT a role prompt. The clj-only entry
 * exposes no mission, board, worktree, audit, or Scope ledger; naming them
 * here would make the model call tools that do not exist (AGENTS.md 8.6.3).
 *
 * `COMMON_CORE_RULES` stays tool-agnostic and is injected alongside this text;
 * the tool-specific COMMON surface and the language discipline are omitted on
 * purpose. The language tail is injected once by
 * `prompts/runtime-wires.mjs#appendOutboundContextTail`.
 */

import { UFSS_PROMPT_NOTE } from "./ufss-note.mjs";

export const DOGFOOD_SURFACE_TEXT = [
	"# Active Surface: ClojureScript Sandbox (clj-only dogfood)",
	"",
	"This installation loads only the ClojureScript executor. There is no mission, no stage gate, no board, no worktree, no manual auditor, and no Scope ledger in this session. Do not claim, invoke, or invent them.",
	"",
	"Registered tools:",
	"- `clj_plan` — read-only: `cat`, `stat`, `ls`, `glob`, `where`, `whereAll`, `park`, `unpark`, `abandon`. No `write`, no `call`.",
	"- `clj_devops` — same reads plus best-effort `call`.",
	"- `clj_review` — same reads; no `write`, no `call`, no `park`.",
	"- `clj_worker` — reads plus `write`, `mkdir`, `rm`, `mv`. No `call`.",
	"- `wait` — collect async sandbox results.",
	"- `time_leap` — cut the current post-compaction timeline back to a clean `clj_*` anchor with `experience` and a mandatory read-only `beacon` (no `ariadne_budget`/`ariadne_goal`).",
	"- `ask_beacon` — read-only query against a sealed `<BEACONS>` entry (reuses its cached prefix with tools forbidden; never resurrects it).",
	"",
	"Rules:",
	"1. Host `read`/`write`/`edit`/`apply_patch`/`bash`/`exec`/`eval`/`glob`/`grep`/`find` are disabled. Inspect and edit through the sandbox.",
	"2. Every `clj_*` call MUST carry `ariadne_budget` (integer >= 1) and `ariadne_goal` (non-empty string). `wait` MUST carry `otherwise_independent_work`.",
	"3. `code` is bare REPL input: any number of top-level expressions, last value returned. Capabilities are bare functions taking one EDN map — `(cat {:path ...})`, never `this` or positional args.",
	"4. `(call {:argv [...] :cwd ...})` runs argv directly: no shell, pipes, redirection, globbing, or `&&`. Every `call` MUST also carry a non-empty `:alternative` map naming the built-in tool or approach you rejected and why.",
	"5. `clj_*` returns synchronously only while cumulative `call` wait stays inside the free 1000ms; past it the call returns `:state :forked` and you collect with `wait`.",
	"6. `where` needs exactly one UTF-16 match; zero or many matches park the program. Resume with `(unpark {:name ... :value [b e]})`.",
	"7. Batch VFS: `write`/`mkdir`/`rm`/`mv` touch memory first and commit atomically only on normal return; a conflict returns `:FILE_CONFLICT` and leaves disk untouched.",
	"",
	UFSS_PROMPT_NOTE,
	"",
	"# How This Prompt Cooperates With the Runtime",
	"- This block is idempotent: `before_agent_start` replaces the region between the two markers on every start, so you always see exactly one authoritative copy. The host prompt before it is preserved; a throwing builder fails open and appears in `/clj-status` health as degraded.",
	"- Language discipline is injected once by the outbound `context` tail, never duplicated here. `<ARIADNE-THREAD>` and undecided-`park` reminders are appended to the outbound copy only; `hackContext` persists the minimal delta to the session branch instead of rewriting history.",
	"- Every `clj_*` call carries `ariadne_budget` and `ariadne_goal`; an expired budget is a warning, never a block. `time_leap` cuts the current timeline back to a clean anchor and seals the departed line as a read-only `beacon` (queryable via `ask_beacon`, never resurrected).",
	"- Tool surface: replaced host tools are subtracted from the active set, `clj_*` plus `wait` plus `time_leap` plus `ask_beacon` are forced active, and unrelated tools keep their prior state.",
	"- Writes pass through the batch VFS and the write gate; a conflict returns `:FILE_CONFLICT` and leaves disk untouched.",
	"- A `call` that exceeds the shared 1000ms grace returns `:state :forked`; collect it with `wait`; a wait deadline parks everything for `unpark` or `abandon`.",
].join("\n");
