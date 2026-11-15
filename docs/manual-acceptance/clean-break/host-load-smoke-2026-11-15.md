# Host load smoke — 2026-11-15

- Host: `omp/18.20.2`
- Plugin: `~/.omp/plugins/node_modules/herdchestra-lite`，realpath 指向 `/home/kunweiz/Desktop/vibe/HerdchestraLite`
- Command: `omp -p '只回复 ok'`
- Observed stdout: `Working...` then `ok`
- No `Failed to load extension` line.

Scope: this verifies the extension factory, plugin-local `nbb`/formatter load, bootstrap module set, and `herd.entry/boot-body` namespace loading. It does NOT verify S1→S5, `/herd`, board tools, or K-path audit. Full manual acceptance remains pending.

`omp -p` processes a prompt and does not execute slash commands, so this smoke does not validate `/herd` registration or tool registration.
