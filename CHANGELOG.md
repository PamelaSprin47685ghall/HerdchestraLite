# Changelog

本文件记录本包的用户可见变化。

## [Dogfood] — 2026-11-14 — 工作条事件驱动恢复官方覆盖

### Fixed

- omp 官方在流式输出期间重写工作条后，HerdchestraLite 的 usage/status 工作条不再停留在原版文本。`message_update`、`tool_execution_update`、`message_end` 等真实 hook 事件到达时，先读取宿主当前工作条（宿主提供 `getWorkingMessage` 时优先使用；否则包装 `setWorkingMessage` 记录官方最后写入的文本），只有当前文本不是目标文本才写回；文本相同不重发。没有 `setInterval`，也没有周期性 `setTimeout`。
- `ui-render` 的 `:last-working` 按 session 记录最后一次写出的工作条文本，替代全局 `:usage-last` 的重复写判断，保留“相同文本不重发”语义。
- 子代理（`subagent-ctx?`）绝不写主 UI：`apply-working-message!` 是唯一写入点并内置该检查；`message_end` 即使没有 usage payload 也触发覆盖检测。

### Verified（不是验收）

- `env -u BUN_OPTIONS bun test tests/cljs-working-message.test.mjs`：7 pass / 0 fail。
- `env -u BUN_OPTIONS bun test tests --parallel`：416 pass / 1 skip / 0 fail / 28 files。

## [Dogfood] — 2026-11-14 — 收口：per-pi 安装、vibe 工具面、500ms 锁与 431 测试

本条记录同日收口的最终事实；同日更早条目中的 2s 锁等待与 367/35 为中间快照，已在该条目就地更正或标注。

### Added

- 启动与安装单例：并发激活共享 `globalThis.__herdBootPromise`，失败清空可重试；`contextPis`、`activated-pis`、`installed-pis` 三组 per-pi `WeakSet` 保证同一进程多 pi 各自只安装一次，不重复注册工具、命令与 hooks。
- 测试：`tests/cljs-surface-vibe.test.mjs`、`tests/cljs-surface.test.mjs`、`tests/cljs-system-install.test.mjs`、`tests/clj-main-trace.test.mjs`、`tests/cljs-lock-contention.test.mjs`、`tests/hack-context-rewrite.test.mjs`。

### Changed

- vibe 工具面：没有 `/herd` 使命时，主会话与无收窄角色的普通子代理保留全部宿主工具，只追加 `clj_devops`、`wait`、`handoff`；删除旧宿主工具黑名单。只有使命内主会话按阶段、显式 herd 角色按角色收窄；收窄失败记 health degraded，不静默删工具。
- 写锁默认等待 500ms（`HERD_LOCK_WAIT_MS` 可调 50–5000ms），10ms 起指数退避、封顶 160ms，超时 `:LOCK_BUSY`。
- context 自动重写每会话分支最多一次（host leaf 变化后重置预算）；之后的 prefix miss 只记录 `prefix-miss-suppressed`，compaction/reset boundary 存在时一律不重写。
- 完整装配、S5 单工作区 runner、K 路审计、异步化与测试恢复仍以同日上一条目为准；本条只更新最终参数与工具面。

### Fixed

- 同进程重复 boot 与重复安装；锁竞争默认等待从 2s 降到 500ms，减少 UI 卡顿。
- 收窄面失败时不再连带删除宿主工具。

### Verified（不是验收）

- `env -u BUN_OPTIONS bun test tests --parallel`：431 pass / 1 skip / 0 fail / 2041 expect / 432 tests / 44 files，约 16.2s。
- 真实 tmux S1→S5、`plans/<slug>/s5-report.md` 与 clean-break 验收仍未完成；用户已暂停 dog food，以上数字不是验收。

## [Dogfood] — 2026-11-14 — 完整装配接回、S5 编排与性能收口

### Added

- `src/herd/system.cljs`：完整装配的宿主接线。注册 `review`/`attach_brainstorm`/`attach_manual_tests`/`attach_dev_guide`/`attach_coordination`/`ask_user`/`devops`/`submit_devops_report` 八门禁工具、11 个 `board_*` 与 `attach_case_audit`；提供 `/herd <seed>` 命令、mission 与 `.herd/focus.edn` 创建、角色探测、阶段工具面收窄、Nudge（空转 + 上游断流退避）与 health 记录。
- `src/herd/swarm/runner.cljs`：单工作区 S5 Reviewer ⇄ Swarm 接力、quiescence 屏障、槽位唤醒与恢复。
- `src/herd/swarm/auditors.cljs`：K 路审计、独立 `/tmp/herd-audit-*` 隔离路径、单 CASE 注入、`.herd/missions/<slug>/audit/batch.edn` 幂等批次与 FAIL repair 根任务。
- 测试：`tests/cljs-runner.test.mjs`、`tests/cljs-auditors.test.mjs`、`tests/cljs-system.test.mjs`、`tests/cljs-console-guard.test.mjs`、`tests/cljs-usage.test.mjs`、`tests/cljs-dashboard-wiring.test.mjs`、`tests/perf-hot-path.test.mjs`。

### Changed

- 唯一清单入口 `src/clj-main.mjs` 现在经 `src/herd/bootstrap.cljs` 加载 `src/herd/main.cljs` 与 `src/herd/system.cljs`；默认面不再只是 clj 执行器。
- 异步化：`src/host/*.mjs`、`src/sandbox/*`、`src/stages/*`、`src/swarm/*`、`src/tui/*`、`src/main.mjs`、`src/bootstrap-main.mjs`、`src/clj-sandbox/*` 改用 `node:fs/promises`；唯一例外是 `src/sandbox/landlock.mjs` 对裸 fd 的 `closeSync`。
- 测试恢复：删除 `.disabled` 与旧 Cherry/CEK 测试，以 CLJS 测试替代；删除 `tests/fixtures/s5-wiring-scenario.mjs`。
- usage 面板：delta 显示最近活动子代理的最后一次请求，sum 合并所有 agent key。
- TUI 看板：按用户明确指令整体移除；`src/tui/*` 保留但无 import/挂载，`tests/cljs-dashboard-wiring.test.mjs` 只断言从不挂载。根规格 §6.1 看板要求被该指令覆盖。

### Fixed

- 5s UI 卡顿：根因是同步 fs、5s 锁等待、无界 `glob`/`where`/`cat` 扫描与默认开启的 `before_provider_request` probe。现在锁等待默认 500ms（`HERD_LOCK_WAIT_MS` 可调 50–5000ms；10ms 起指数退避、封顶 160ms，`:LOCK_BUSY`）；`glob` 跳过 `node_modules`/`.git`/`.herd`，20k 条目/2s 预算（`:LIMIT_EXCEEDED`）；`where` 最近行 DP 1M cells + 150ms；`cat`/`write` 2 MiB；handoff 扫描 512/32；usage/status 100ms 节流；probe 默认关闭（`HERD_CACHE_PROBE=1`）；新增 `HERD_TRACE=1` 热路径计时（`.herd/perf-trace.jsonl`，1 MiB 上限）。
- 沙盒 console/stdio 防呆：`guard-source!` 拒绝 `console`、`js/console`、`globalThis.console`、`js/process.stdout`/`stderr` 等直接访问，返回 `:CAPABILITY_DENIED`；字符串、注释与 UFSS fence 中的同名词不误杀；`call` 仍用 pipe 捕获日志。

### Verified（不是验收）

- `env -u BUN_OPTIONS bun test tests --parallel`：该条目记录当时快照 367 pass / 1 skip / 0 fail / 35 files；最终测试面为 431 pass / 1 skip / 0 fail / 44 files，见同日收口条目。
- `timeout 120 omp -p '只回复 ok'`：exit 0，wall 5.1s。
- 性能实测：5MB payload probe off 0.02ms；1000 条 context 2.3ms；1000 次 message_update 2.4ms；`where` 1MB 0 匹配约 12ms；`glob` 20k 约 14ms；锁竞争约 0.5s 返回 `:LOCK_BUSY`；100 次 `write` 约 25ms；真实 `omp -p` trace 无 sync-ms > 200ms 条目。
- 真实 S1→S5 tmux 验收、`plans/<slug>/s5-report.md` 与 `docs/manual-acceptance/clean-break/report.md` 仍未完成；用户已暂停 dog food，以上数字不是验收。

## [Dogfood] — 2026-11-14 — 删除 `call` 的 `:alternative` 提示词要求

### Changed

- 根 `AGENTS.md` §4.5、`src/clj-sandbox/tools.mjs` 的 `call` 描述与 `HANDOFF.md` 删除 `:alternative` 参数要求；`call` 仍只接受 `argv`（可选 `cwd`）。
- `HISTORY.md` 记录删除理由与代价。

### Verified（不是验收）

- `rg ":alternative"` 只剩 `HISTORY.md`/`HANDOFF.md` 的历史说明；规格、源码与工具描述无残留。
- `env -u BUN_OPTIONS bun test tests --parallel`：268 pass / 1 skip / 0 fail，26 files。


## [Dogfood] — 2026-11-14 — 完整装配删除 frozen 哈希与 contract-line 残留

### Changed

- `src/main.mjs` 的 `caseSpecsFor` 只读取 `.herd/missions/<slug>/s2-cases.edn`，不再调用不存在的 `readS1Summary`，不再比对 `mission.frozen` 哈希，也不再返回 `caseEdn`/`s1Summary` 字节镜像。
- `runMissionAudit` 的 `contract` 只含 `{ missionId, revision }`；审计提示只接收这两个字段与单条 CASE 记录。
- `aggregate` 调用重新注入 `contract`，修复完整装配审计因缺少 contract 而永远无法 PASS 的断链。
- `recheckMission` 只校验报告写入后的工作区快照与报告 SHA-256，不再返回 `contractLine`。
- 删除 `CONTRACT_HASH_MISMATCH`、`S1_SUMMARY_HASH_MISMATCH`、`CONTRACT_LINE_STALE`、`S3_MODULES_HASH_MISMATCH`、`CASE_HASH_MISMATCH`、`MAPPING_REALIGN_REQUIRED` 六个已废弃错误码；`tests/util-errors.test.mjs` 同步删除断言。
- `DEBT.md` 关闭 D27；`src/AGENTS.md` 更新完整装配的审计接线说明。

### Verified（不是验收）

- `node --check src/main.mjs`：通过。
- `env -u BUN_OPTIONS bun test tests --parallel`：268 pass / 1 skip / 0 fail，26 files。


## [Dogfood] — 2026-11-14 — S1–S4 gate 服务迁移到 CLJS

### Added

- `src/herd/stages/gates.cljs`：`review`、四个 `attach_*` 与 `ask_user`/`devops`/`submit_devops_report` 的 CLJS 服务。包含角色门禁、call-id 重放、S1 确认端口（approve / revise / deny / pending）、批准时读回磁盘文档、barrier 与下一阶段简报，以及八个宿主工具定义与 `register-all!`；`ask_user` 的 S1 问答与 S5 例外检查、`devops`/`submit_devops_report` 的宿主端口。
- `src/herd/gates_host.cljs`：把 gate 工具定义转换为宿主 JS 形状并注册，`execute` 结果转回 JS。
- `tests/cljs-gates.test.mjs`：review 开账/空账、attach 未就绪拒绝、S1 四态、磁盘编辑后的批准、S2 晋级、重放冲突、角色拒绝、八工具注册，以及 `ask_user` 与 `devops` 端口。
- `tests/cljs-gates-host.test.mjs`：宿主适配器的 JS 形状、八个工具注册与 review 执行。

### Changed

- `src/herd/stages/tenure.cljs`：board 归档路径改为 `.herd/missions/<slug>/boards/<tenure-id>.edn`，与 `store.cljs` 和根规格 §7.1 一致。
- `src/herd/bootstrap.cljs`：加载 `stages/gates` 与 `gates_host`；UFSS canonical 检查覆盖这两个文件。

### Verified（不是验收）

- `env -u BUN_OPTIONS bun test tests`：216 pass / 1 skip / 0 fail，24 files。


### Added

- `src/herd/stages/audit.cljs`：`attach_case_audit` 的耐久提交（`wx` 一次写入、`EEXIST` → `:AUDIT_DUPLICATE_CASE`、fsync、失败清理）与读取，兼容 kebab 与下划线 EDN 键。
- `tests/cljs-report.test.mjs`：报告写入、批准端口、recheck 拒绝、非 PASS 拒绝，以及审计写入/读取/重复/错配，并与 mjs `auditors.mjs` 双向互读。

### Changed

- `src/herd/stages/report.cljs`：`write-report!` 接入 `:approval-port`（`issue`）与 `:recheck-port`，保持 mjs `writeS5Report` 的 `:APPROVAL_REQUIRED`、报告先写后批准、失败不回滚语义。
- `src/herd/bootstrap.cljs`：加载 `stages/scores`、`stages/audit`、`stages/report`；UFSS 源码检查覆盖这三个文件。

### Verified（不是验收）

- `env -u BUN_OPTIONS bun test tests`：201 pass / 1 skip / 0 fail，22 files。
## [Dogfood] — 2026-11-13 — native read/write 委托

### Changed

- `clj_devops` 的 `(read ...)` / `(write ...)` 不再注册同名 shadow 工具，也不再通过 `ctx.invokeTool` 或反射查找宿主工具；改为捕获 live `ExtensionRunner` 并调用其公开 `invokeNativeTool`。`write` 仍在跨进程锁内复核 `__expectedStamp` 后执行宿主官方 `write`。
- 新增 `src/host/native-runner.mjs`：懒加载宿主 Runner 模块，包装 `ExtensionRunner.prototype.createContext` 保存 runner；`host/imports.mjs` 重新导出。该文件是本项目唯一的宿主原型补丁，已记入 `HACK.md` 与根 `AGENTS.md` §1.1。

### Fixed

- 宿主不暴露 Runner 时，`read`/`write` 以 `HOST_API_MISMATCH` fail-closed，不再存在 `node:fs` 回退或“看起来可用”的 shadow 工具。
- 同时修复 `createAriadneStore()` 未返回 `resolvePendingLeap`、回放历史时 goal-only 锚点被拒、以及 time_leap 目标/预算恢复的窄测试覆盖。

### Verified（不是验收）

- 真实 `omp 18.20.0`：`(read {:path "package.json"})` 与 `(write {:path ".herd/tmp-probe" :content "ok"})` 回执均含 `:host true`，探针落盘且锁目录在完成后为空。
- `env -u BUN_OPTIONS bun test tests/clj-core.test.mjs tests/sandbox-tools.test.mjs tests/clj-workers.test.mjs tests/ariadne.test.mjs`：82 pass / 0 fail。

## [Dogfood] — 2026-11-12 — clj 执行器最小面

> 当前清单只启用 ClojureScript 沙箱执行器。本节记录这一刀的真实变化；下方 `[Unreleased]` 的完整编排实现仍在源码中，但未装配，不能当作可用功能。

### Added

- `src/clj-main.mjs`：只注册 `clj_plan`、`clj_devops`、`clj_review`、`clj_worker` 的最小宿主入口，附 `/clj-status`。
- `src/clj-sandbox/cherry.mjs`：把 Cherry 加载从 `host/imports.mjs` 拆出，使沙箱工具不再依赖 omp 宿主包即可加载与测试。
- `tests/clj-core.test.mjs`：覆盖四个工具注册、受保护写入、`where` 挂起/恢复、只读拒绝与 `stamp` 冲突。

### Changed

- `package.json` 的清单入口改为单一 `./src/clj-main.mjs`；`tool-gate`、`bootstrap-main`、`main.mjs` 保留为后续扩张代码，当前不加载。
- `clj-main` 在 `session_start` 与 `before_agent_start` 按黑名单移除被 clj 取代的宿主工具：`read`/`write`/`edit`/`apply_patch`/`ast_edit`/`ast_grep`/`bash`/`exec`/`eval`/`glob`/`grep`/`find`。其他工具不重建白名单，保持原有激活状态；四个 `clj_*` 由注册方显式激活。
- evaluator 从 `clj-sandbox/cherry.mjs` 加载 Cherry；`host/imports.mjs` 重导出同一加载器，保持完整装配的导入边界。
- 工具参数改为 REPL：`code` 直接接受任意顶层表达式，最后一个值返回；`program_name` 可选，省略时生成 `repl-<id>`；只接受裸 REPL 输入。
- `call` 改为 argv-only：`{:argv [...] :cwd ...}`，直接 spawn，无 shell/管道/重定向/通配/`&&`；回执包含 `:argv`/`:argc`，旧 `:command` 字段被拒绝。
- 普通 VFS 路径完全放开：不再拒绝 `..`、绝对路径、越界符号链接；盲写不再要求先读；`AGENTS.md` 不再受特殊保护。
- 删除 `readRoots`、`allowWritePaths`、控制路径、plans/AGENTS 保护与 call cwd/log 白名单等权限代码。
- README 改为描述当前 clj-only 面、启用步骤、真实冒烟与扩张顺序。

### Fixed

- `call` 不再继承宿主的 `BUN_OPTIONS`/`NODE_OPTIONS`/`BASH_ENV`/`ENV`/`PROMPT_COMMAND`；`bun test` 不会再因 omp 的 zstd 预加载而重复命令行或触发 E2BIG。
- 期限改为 `1000ms + intent UTF-8 字节数 × 50ms`，固定白送 1 秒，不按角色加码。
- 虚拟文件 `stat` 现在报告 `is-file true`，虚拟目录报告 `is-file false`/`is-dir true`，不再同时显示为既非文件也非目录。
- commit 回执的 `written` 按路径去重；同一路径的多次中间操作不再重复列出。
- 工具注册失败、Cherry 缺失或 hooks 不可用时，health 汇总降级而不是被最后一条 `ok` 覆盖；`/clj-status` 合并为一次通知。
- 只读的 `clj_plan`/`clj_review` 不再创建 `.herd/artifacts` 或写锁目录。

### Verified（不是验收）

- 真实 `omp 18.19.0` 在 `omp plugin link` 后自动加载插件；模型调用 `clj_worker` 成功写入探针文件。
- 真实宿主中 `clj_plan` 写文件被 `:CAPABILITY_DENIED` 拒绝且未落盘；`clj_devops` 的 `call` 返回 `:completed`。
- 真实宿主中同一会话先 `where` 多匹配挂起，再 `unpark` 恢复并落盘。
- 真实宿主 `getActiveTools()` 捕获到 `task`/`wait`/`todo`/`web_search`/`debug` 与四个 `clj_*`；黑名单中的本地文件与命令工具均不存在。
- 本地 `bun test tests/clj-core.test.mjs`：17 pass / 0 fail。

## [Unreleased] — clean-break（进行中，未验收）

> 本节只记录当前工作区的结构变化，不表示功能已交付或验收通过。根 `AGENTS.md` 仍是唯一规格；未关闭缺口见 `DEBT.md`。

### Added

- 新的产品模块骨架：`host/`、`util/`、`clj-sandbox/`、`tool-gate/`、`scope/`、`stages/`、`swarm/`、`prompts/`、`tui/`。
- 阶段控制态改为七项 `:frozen`（`s1`、`s1-summary`、`s2`、`s2-cases`、`s3`、`s3-modules`、`s4`）；新增 `.herd/missions/<slug>/s1-summary.md`、`.herd/missions/<slug>/cases.edn`、`mission.edn :s3-modules` 与 `:s4-slices`；新增 `realign_frozen`。
- 新的开发者测试：`host`、`util`、`clj-sandbox`、`tool-gate`、`scope`、`stages`、`swarm`、`tui` 等模块的 `bun test` 用例。测试只保护内部不变量，不是手工验收证据。
- 独立开发验收包 `tools/dev-acceptance/`：只负责开发验收文档的提交与报告写入，不作为产品运行时入口，也不是 K 路审计执行器。
- `src/AGENTS.md`、`DEBT.md`、`HISTORY.md`：分别记录架构装配、未关闭缺口与历史取舍。

### Changed

- `package.json` 的清单入口收敛为两个：`src/bootstrap-main.mjs` 与 `src/tool-gate/index.mjs`。
- 运行时依赖收敛为 `cherry-cljs@0.6.38`；移除 `pi-context`、`pi-goal-x` 与主题入口依赖。
- `src/main.mjs` 改为装配新模块；不再 import 旧的 `pi-goal`、`pi-context`、`editor-theme`、`manual-acceptance` 运行时。
- `main.mjs` 连接 S5 审计来源：`join_slice` 队列耗尽后调用 `runMissionAudit`，再走 `startAuditBatch`、`aggregate`、`writeS5Report` 与修复切片；真实宿主闭环仍未验收。
- `advance_s1` 把提交的 `summary` 原样写入并冻结 `s1-summary.md`；`advance_s2` 接收结构化 `cases`（`case_id`/`path`/`threshold`/`steps`/`expected`/`rubric`），经 `commitS2` 原子写 `cases.edn`、保存方法论并冻结 `s2-cases`；`advance_s3` 持久化完整 `:s3-modules`（含 `mapped_cases`）并用 inline 哈希冻结；`advance_s4` 从冻结 `cases.edn` 校验覆盖并写 `:s4-slices`。
- S5 审计从冻结 `cases.edn` 与 `s1-summary.md` 单次读取，重读 mission 核对哈希，并在 `startAuditBatch` 启动前与活 frozen 哈希再绑定；审计员只消费注入的单条 CASE 记录，不读 Markdown。
- `board_finish` 的 `dependency_paths` 限定为工作区相对路径，`wait_for` 支持既有子任务 ID 或 `condition:<key>` 前缀；`clj_plan` 可读冻结 `cases.edn`，`clj_auditor` 拒绝读取它。
- `slice_id`/worktree 接受 uppercase 与下划线，并在 workspace 路径、branch、writeW/board 锁路径、`worktrees.edn` 键与 SliceHandle 中逐字保留大小写；`depends_on` 仍精确大小写匹配。
- Evaluator 撤回固定 5s 端口 watchdog，恢复 intent deadline park：`commit`/`discard` 只 race port promise 与 program control，pending 保留，unpark 等同一 promise；t14/t15 的 abandoned capability 回执/账本保留。未证明的额外 timeout 不再代替根要求的 park。
- S5 工具面：`STAGE_SURFACES.s5` 不含 `clj_plan`，`publishMission` 在 S5 将 `clj_plan` 追加到 `blockedTools`；`main-bootstrap` 窄测 48 pass/0 fail，但 r23 真实宿主仍暴露 `clj_plan`，修复效果尚未重测。
- `rewriteVibeModeContext` 接入 `context` 出站副本的 `vibe-mode-context` 消息；`buildCaseAuditorPrompt` 由 `runMissionAudit` 的 `buildPrompt` 使用；`startAgent` 使用调用方 `systemPrompt` 并透传请求选项。
- S1–S5 简报与 Manual Auditor 模板同步根 §8.3/§8.4：简报要求 S1 `summary` 作为独立冻结背景、S2 使用结构化 CASE 数据集、S3 模块用 `mapped_cases` 覆盖冻结 CASE、S5 审计只注入单条冻结 CASE 记录；auditor 模板使用 `case_id` 与确定性 EDN+UFSS 呈现。
- Esc 层级取消接入 `onTerminalInput`；宿主缺失时记录降级并提示 `/herd-cancel`。
- 角色收窄改用宿主报告的子会话身份 `ctx.agent` 与 M0 发布的 role surfaces；首行 `[HERD_ROLE: ...]` token 仍作为声明被解析和核对，不再依赖独立 role-auth 注册表。
- README 与 CHANGELOG 改为描述当前工作区；旧实现的 CHANGELOG 原文保留在文末，不再作为当前行为说明。

### Removed

- `package.json` 中的旧运行时依赖、第三个清单入口与 `editor-theme` 导出。
- 旧 README 的三入口、18.18.6 基线、`/goal-x`、`/acm`、旧手动验收工具等安装与使用说明，不再作为当前指导。
- 开发验收包完成迁移后删除旧 `src/manual-acceptance/` 与对应旧测试。
- 确认无运行时消费者后删除 `src/prompts/auditor.mjs`、`manual-protocol.mjs`、`method-discipline.mjs`、`repo-aware-rules.mjs`、`plan-only.mjs`、`context-skill.mjs` 与 `src/util/objects.mjs`；`tools/dev-acceptance/util/objects.mjs` 是独立子包自己的复制，保留。
- 删除 `tool-gate/role-auth.mjs` 与 schema 侧 role-auth/nonce 注册；角色身份改由宿主 `ctx.agent` 判定。
- 删除 S2 Markdown CASE 解析与旧 `{id, threshold, path, rubric_summary}` CASE 结构；`s2-manual-tests.md` 只保留方法论。contract-line 改为七项纯渲染、陈旧仅告警，四段解析/重建不再是权威路径；S3/S4 覆盖不再以 `structure.ids` 快照为唯一依据。

### Fixed

- S3 门禁误要求 `s2-manual-tests.md` 出现 `CASE 对应表` 标题，且依赖图关键词不识别 `## 模块 DAG`；已改为只要求模块边界与依赖图，接受 `模块 DAG`/`dag`，CASE 映射只由结构化 `modules[].mapped_cases` 校验。真实 rS3 的 S2 已冻结 5 CASE；rS4 恢复原 session 后 S3 已成功晋级 S4。
- S2 校验回执在 parser 错误码未注册时只返回 `data.code`，丢失 `stage`/`errors`/`required`/`missing`/`received`/`next`；已固定 outer `:INVALID_ARGUMENT` 并在 `data` 保留结构化 errors，`CASE_REQUIRED_PATH_MISSING` 现在列出五类 required、实际 missing、received 与纠正建议，并明确 `path` 是 category label 而非文件系统路径。真实 s1-7 的模型仍重复提交文件路径，S2 复测未完成。
- S4 校验误拒合法文档：`合并拓扑`/`合入顺序`/`merge topology` 不被识别为 merge-order，uppercase `SLICE-01` 被自加的 lowercase 规则拒绝，并级联出 `depends_on undeclared`；已接受这些合法形式，`slice_id` 仍拒绝空格/斜杠/点，`depends_on` 保持精确大小写匹配。真实 s1-9 已重测 S4 成功。
- `fork_slices` 失败清理曾删除首个失败 Slice 的 pending 行，留下其余 Slice 的孤立 DAG（slice-04 依赖不存在的 slice-01）；现改为保留完整拓扑：清理成功恢复 `:pending` 并写 `:last-fork-error`，清理失败标 `:failed` + `:failure-reason`，已成功 Slice 保持 `:running`，容量/中途失败保留拓扑并标可恢复，不伪造 handle。确定性故障注入 34 pass/230 expect。
- `SCOPE_UNINITIALIZED` 冷启回执原先只列 kind/tool；现在带 `required: ["new_scope_goal","new_scope_retention_budget"]` 与可执行的 resetScope `next` 示例，窄测覆盖。
- `SCOPE_INVALID` 曾把 `resetScope.replacement` 误判为不允许，尽管出站 flat scope schema 声明了该字段；准入现接受 declared 字段（resetScope/removeLast），各 kind 必需字段仍强制，`keepLast`/`meToo` 仍拒绝额外字段；r14 原始 scope 离线通过，111 项窄测通过。

### Still open

- 真实隔离 rS3 已通过结构化 S2（5 CASE `cases.edn` 冻结）；s1-7 在 S2 因模型反复使用文件路径而停止，回执缺陷已由 t17 修复；rS4 恢复原 session 后 S3 成功并进 S4，S4 被旧校验器误拒（t18 修复）；rS5 真实 `advance_s4` 成功进 S5，`fork_slices` 失败清理删除 pending Slice 的问题由 t5 修复；s1-13 成功 fork 3 个 worktree（slice-04 pending），但 Reviewer 同回合并行调用被旧监控误判 repeat；s1-14 的 turn-aware harness 离线验证通过，父 `fork_slices` 的 `resetScope.replacement` 又被旧准入误拒，t19 修复；r22 暴露 S5 activeTools 误含并执行 `clj_plan`，r23 的 activeTools 仍含 `clj_plan`；当前源码虽移除 `STAGE_SURFACES.s5` 的 clj_plan 并在 `publishMission.blockedTools` 追加，但 r23 真实宿主仍暴露，runner 因中断取消，修复效果未重测。r23 fork 成功并启动 3 个子代理，首个 `clj_review` 因 `ls expects an EDN map argument` 停止。S5 审计、`runMissionAudit → startAuditBatch`、审计提交、`s5-report.md` 与一次性批准均未完成；不能声称已交付、S5 可用或审计通过。
- D13 阶段控制态迁移仍开放：统一全量套件未收口，`realign_frozen` 的 S2–S4 表面与审计失效/观察者退休断言、真实 18.16.0/17.x/16.x 版本验证未完成。
- 角色身份依赖宿主 `ctx.agent`；真实 17.x/16.x 形状未验证，且没有独立 role-auth 回退。
- 真实宿主加载、真实 TUI/tmux 交互、S1→S5 端到端使命与开发验收 `report.md` 均未完成。
- 全量测试/交错矩阵、`sessionFile` 父链偏差与真实出站零剧透测试仍未闭合。

## [0.1.0] 旧实现（历史，原文保留）

### Added

- 三个清单入口：`src/bootstrap-main.mjs`、`src/tool-gate/index.mjs`、`src/bootstrap-editor-theme.mjs`；`package.json` 的 `omp.extensions` 与 `pi.extensions` 各列一次，单个入口失败不影响另外两个。
- `bootstrap-*` 入口采用惰性加载：只在默认工厂被调用时动态 `import()` 真实模块，因此 Node 可以直接 `import` 清单入口；真实实现仍在 omp 加载器内运行。
- 40 个单职责 `.mjs` 模块：入口与 `context/`、`prompts/`、`host/`、`pi-context/`、`pi-goal/`、`manual-acceptance/`、`tool-gate/`、`editor-theme/`、`util/` 九个子目录。
- 三个手动验收提交工具：`submit_manual_requirements`、`submit_development_guide`、`submit_coordination`，分别写 `requirements.md`、`development-guide.md`、`coordination.md`。
- 手动验收守卫：`propose_goal_draft` 的创建守卫与 `update_goal` 的完成守卫；gated 工具在审计器不可用时 fail-closed。
- 可见审计员：校验文档后运行审计子进程，按 CASE 收集双分数并写 `report.md`。
- 审计器按 GoalCore 跟踪安装：用 `WeakSet` 记录已安装的 `runCompletionAuditor`，工厂重绑定或子会话拿到新的 core 时不会覆盖或漏装。
- `goalService.apply` 审计闸门：在 `complete` 写入前检查本次审计批准（goal id + revision）；跳过审计、设置绕过与 Escape 强制完成都走同一闸门，`archive` 路径放行。
- 设置缺失判定：`pi-goal-x-settings.json` 不存在时视为未禁用；文件不可读、JSON 非法或 `disabled` 类型不符视为未知并 fail-closed。
- 审计员验收规则：TUI 观察必须用 tmux 发送真实按键并保存 pane capture；缺失依赖与无效入口分支必须在 `/tmp` 隔离副本中复现，不得改动产品或依赖。
- 工具门：向每个对象型工具 schema 注入两个必填参数，并在执行前剥离。
- 主题垫片：给宿主 TUI 原型补 editor-theme 面，初次失败后每次 `session_start` 重试；仍不可用时发 warning。
- `tests/` 六个开发者测试：`atomic-write`、`contract`、`goal-settings`、`requirements`、`scores`、`tool-gate`。

### Changed

- 从旧扩展目录的三个顶层 `.ts`（native 目录扫描加载）迁移为 `herdchestra-lite` 包：`.mjs` 入口经 `omp plugin link`、`package.json` 清单或 `config.yml#extensions` 加载。
- `src/main.mjs` 只负责装配；提示词、上下文投影、宿主适配、pi-context、pi-goal、手动验收分目录实现。
- 扩展内的 `/goal` 改名为 `/goal-x`，宿主内置 `/goal` 保持不变。
- 提示词、用户可见文案、错误消息、工具 label/description 保持旧实现原文，逐字迁移。

### Removed

- `vibeActive`：没有调用者，不产生行为。
- `verdictFromScores` 的重复标题分支：解析器在更早阶段已抛错，分支不可达。
- `rows.length === requirements.length` 检查：由前面的 missing/unknown 检查保证，冗余。
- `ROOT_DIR` 与 `DOCUMENT_ROOT` 的重复定义，以及三个文件名常量与无后缀常量的重复定义：合并为单一常量。
- 旧三个顶层 `.ts` 已从旧扩展目录顶层移入 `archive/`，不再被 native 目录扫描加载。

### Fixed

- 审计绕过：`update_goal({status: "complete"})` 直接经 `goalService.apply` 写入时，没有本次审计批准的完成会被拒绝；工具包装层在每次完成尝试前清除旧批准。
- 设置文件缺失误拒：设置文件不存在不再被当成读取失败；只有显式 `disabled: true` 才禁用审计器。
- Node 入口 import：清单入口不再静态加载 `main.mjs` 与 `editor-theme/index.mjs`，普通 Node `import` 三个入口返回 function，不再触发 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`。
## 2026-11-14 测试分层与压测移除

- `bun run test` 默认运行 `tests/fast.test.mjs` 的纯 JS 冒烟/单元测试，实测约 0.5s（182 tests，1 skip）。
- `bun run test:full` / `test:suite` 运行完整 406 tests（27 files），实测约 5.6s。
- 删除 `tests/perf-hot-path.test.mjs` 与 20 文件吞吐断言；context rewrite 的 1000 消息压力用例缩为 3 消息冒烟；cat 2 MiB 上限、glob 依赖跳过/条目上限、where 零匹配、probe off 等路径用小数据量触发并断言近零开销（等价于压测，但不做大数据量吞吐）。
- 完整套件实测 USER 62.6s + SYS 4.8s；16 核完美满载下界约 4.2s。1s 全量需要合并 CLJS 测试进程、减少重复 nbb bootstrap。

## 2026-11-14 测试时间源注入与事件驱动

- 新增 `src/herd/clock.cljs`，`sandbox`/`repl`/`auditors`/`regex-worker` 的时间读取与定时器可注入；测试使用 `tests/fake-clock.mjs`，不读真实墙钟。
- 测试改为显式事件：`await-call-start`、`await-call-output`、`flushTrace`、注入 `set-timeout`；删除 `sleep`、`waitFor` 轮询与固定 150/50/30ms 等待。
- 全量 400 tests / 27 files：399 pass / 1 skip / 0 fail（约 5.8s）；默认 `bun run test` 快速套件约 0.4s。
- e2e 真实模型烧钱必须用户批准；默认测试不启动真实 omp 使命。
