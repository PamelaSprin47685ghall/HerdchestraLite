# Host load smoke — 2026-11-15

- Host: `omp/18.20.2`
- Plugin: `~/.omp/plugins/node_modules/herdchestra-lite`，realpath 指向 `/home/kunweiz/Desktop/vibe/HerdchestraLite`
- Command: `omp -p '只回复 ok'`
- Observed stdout: `Working...` then `ok`
- No `Failed to load extension` line.

Scope: this verifies the extension factory, plugin-local `nbb`/formatter load, bootstrap module set, and `herd.entry/boot-body` namespace loading. It does NOT verify S1→S5, `/herd`, board tools, or K-path audit. Full manual acceptance remains pending.

`omp -p` processes a prompt and does not execute slash commands, so this smoke does not validate `/herd` registration or tool registration.

## Interactive `/herd` smoke (tmux)
- Command: tmux session running `omp`; send `/herd test` and Enter.
- Observed: `任务 01a1ddfb-850b-7797-974e-64e9f7e15cef 已创建，进入 S1。`
- Created `herd/01a1ddfb-850b-7797-974e-64e9f7e15cef/board.edn` with `:board-version 0` and `:tenure-id T-1`.
- Scope: verifies slash command registration, session task binding, and board initialization; not S1→S5.
