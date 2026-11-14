# Handoff — 2026-11-12

> 2026-11-14 修订：`call` 的 `:alternative` 要求已删除；下文相关描述仅记录历史。

## 当前状态

- 分支 `master`，最近提交 `eb80bfe fix(clj): remove legacy wrapper and use argv-only call`；本文件与 `:alternative` 文档回补随后一起提交。
- 清单只有 `./src/clj-main.mjs` 一个入口；启用 `clj_plan`、`clj_devops`、`clj_review`、`clj_worker` 与 `/clj-status`。
- 当前是 clj-only dogfood 面：`/herd`、五阶段门禁、tool-gate/Scope、看板、worktree、K 路审计、TUI 看板均未装配；完整模块保留在源码中。

## 已确认行为

- 工具接受裸 REPL：`code` 是任意顶层表达式，最后一个值返回；`program_name` 可选，省略自动生成 `repl-<id>`；旧 `(defprogram ...)` 输入被明确拒绝。
- `call` 是 argv-only：`(call {:argv ["prog" "arg"] :cwd ...})`；直接 spawn，无 shell、管道、重定向、通配或 `&&`；回执含 `:argv`/`:argc`，旧 `:command` 被拒。
- 旧版提示词曾要求每次 `call` 提供非空 `:alternative` map；该要求已于 2026-11-14 删除，框架从未校验它。
- VFS 普通路径权限已删除：允许 `..`、绝对路径、越界符号链接、盲写与覆盖 `AGENTS.md`；写锁 `$W$`、批内 VFS 与已读文件的 `stamp` 冲突检查保留。
- 期限固定为 `1000ms + intent UTF-8 字节数 × 50ms`，无角色下限。
- 宿主工具黑名单：`read`/`write`/`edit`/`apply_patch`/`ast_edit`/`ast_grep`/`bash`/`exec`/`eval`/`glob`/`grep`/`find` 在 `session_start` 与 `before_agent_start` 从 active 集合移除；其他工具保持原状态。

## 验证证据

- `tests/clj-core.test.mjs`：17 pass / 0 fail。
- 相关套件（clj-core、vfs、vfs-paths、sandbox-tools、main-consumer、util-errors）：214 pass / 0 fail；Biome clean；`git diff --check` clean。
- 嵌套真实 `omp` 加载最终源码：裸 REPL、无 `program_name`、`(call {:argv ["printf" "%s" "a|b"]})` 返回 `:argc 3`、`:stdout "a|b"`、`:state :completed`，证明无 shell 解释。
- 全量 `bun test` 仍有与本次改动无关的既有/环境失败：bwrap 隔离、缺失 `@opentelemetry/api`、host 旧信号用例等；未作为本次通过证据。

## 交班后第一件事

重启 `omp`。插件只在启动时加载；当前会话之后的提示词/工具描述修改不会热更新。

## 下一步扩张顺序

1. 恢复 tool-gate 的 Scope/intent 注入、准入与剥离，先在真实宿主验证出站 schema 与执行前剥离。
2. 接回 `advance_s1..s4`、`ask_user`、`devops` 子代理与 S1 手工批准，先跑 S1–S4 规划闭环。
3. 接回单 Slice 看板与 Reviewer/Worker 角色面。
4. 接回多 worktree、K 路审计、报告与一次性批准。

## 注意

- 未跟踪 `package-lock.json` 是环境生成文件，仓库使用 `bun.lock`；未纳入提交。
- 根 `AGENTS.md` §4.5 曾记录 `:alternative`；该要求已于 2026-11-14 删除。
- `:alternative` 已从规格、工具描述与提示词中删除；不要重新引入。