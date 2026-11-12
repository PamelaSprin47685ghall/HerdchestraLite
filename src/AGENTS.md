# src/AGENTS.md — 全局架构装配笔记

> 本文件不是规格。仓库根 `AGENTS.md` 是唯一 SSOT；两者冲突时以根规格为准。本文件只记录当前 `src/` 的模块边界、单向依赖、装配现状与迁移遗留；未关闭的规格偏差写在 `DEBT.md`。

## 0 组织原则

文件按功能组织，不按层或类型机械拆分：一个能力的实现、模型面向说明与契约放在同一模块；不为一常量或一段提示新建中转文件，也不保留只做 re-export 的薄层。调用方直接引用实现处；删除中间层时同步删除引用与文档条目。

## 1 入口与装配

当前清单（`package.json` 的 `omp.extensions` / `pi.extensions`）只有一个入口：

1. `src/clj-main.mjs`：最小 dogfood 面。只注册 `clj_devops`、`wait`、`time_leap`、`ask_beacon` 与 `/clj-status`，并通过黑名单移除宿主 `read`/`write`/`edit`/`bash` 等工具；不加载阶段、看板、worktree、审计或 TUI。它依赖 `clj-sandbox/*`、`scope/*`、`host/*`、`prompts/*`、`util/*`，因此不需要 omp 宿主包即可在本地测试。

以下入口与模块保留给后续扩张，当前清单不加载：

- `src/bootstrap-main.mjs`：惰性 `import("./main.mjs")`，调用默认工厂，并把成功/失败写入 `host/health.mjs`。
- `src/main.mjs`：完整装配的保留主装配器。它注册命令、工具与 hook，连接 stage gate、board、runner、sandbox、TUI 与 subagent 适配器；不实现看板、门禁或沙箱的内部语义。

`src/clj-main.mjs` 没有角色 admission：主会话可以使用 `clj_devops`。该边界只适用于当前 dogfood 面，阶段层接回时必须恢复角色收窄。

`src/clj-main.mjs` 的系统提示词由 `host/hack-system-prompt.mjs` 托管注入：`before_agent_start` 在宿主提示词后追加 `COMMON_CORE_RULES`（repo-aware 规则，tool-agnostic）与 `clj-sandbox/ufss.mjs` 导出的 `UFSS_PROMPT_NOTE`。托管区段有固定 marker，重复触发原位替换；handler 抛错时 fail-open 并记 health。S1–S5 简报、旧 Scope 字段与角色提示词都不注入，因为本面没有对应工具与阶段。

omp 在进程内缓存已加载的 ESM 模块，系统提示词在会话启动时组装；修改 `src/prompts/*` 后必须重启 omp 或新开进程，当前进程不会热更新。

`src/clj-main.mjs` 同时维护 `HOST_TOOL_BLACKLIST`（`read`/`write`/`edit`/`apply_patch`/`ast_edit`/`ast_grep`/`bash`/`exec`/`eval`/`glob`/`grep`/`find`）。`applyCljToolSurface` 在 `session_start` 与 `before_agent_start` 从 `getActiveTools()` 的当前集合中减法移除这些名字，再确保 `clj_devops` 与 `wait`/`time_leap`/`ask_beacon` 激活；它不重建允许列表，未列出的工具保持原有激活状态。禁用 `read`/`write` 会切断宿主 `xd://` 传输设备，这是当前 dogfood 的有意代价。

`src/clj-sandbox/cherry.mjs` 是 Cherry 加载的唯一实现；`host/imports.mjs` 重导出它，`clj-sandbox/evaluator.mjs` 直接依赖它。这样本地面无需导入 `@oh-my-pi/pi-coding-agent` 或 `typebox`。

`main.mjs` 当前不 import 旧的 `pi-goal/`、`pi-context/`、`editor-theme/` 或 `manual-acceptance/` 运行时。旧实现目录、旧提示词模块、`src/util/objects.mjs` 与旧 manual-acceptance 测试均已从工作树删除；不要恢复或重新引用。

## 2 当前单向依赖图

按实际 `import` 关系整理（箭头表示“依赖”）：

```text
util/errors
  ├── util/atomic-write
  ├── util/file-lock
  ├── host/subprocess
  ├── clj-sandbox/*
  ├── scope/*
  ├── stages/*
  └── swarm/*

host/imports
  ├── host/subprocess
  └── clj-sandbox/evaluator

util/atomic-write ── clj-sandbox/vfs
clj-sandbox/ufss ── clj-sandbox/evaluator
clj-sandbox/where ── clj-sandbox/evaluator
clj-sandbox/evaluator ── clj-sandbox/tools
clj-sandbox/vfs      ── clj-sandbox/tools
clj-sandbox/ufss     ── clj-sandbox/tools

stages/disclosures ── stages/gate-tools
stages/parsers     ── stages/gate-tools
stages/contract    ── main（通过 port 注入 gate-tools）
stages/scores      ── 目前只被测试与后续装配使用

swarm/board ── swarm/worktree
     └─────── swarm/runner
swarm/auditors（只依赖 util/errors）

prompts/common、prompts/runtime-wires（不 import 其他产品模块）；prompts/roles ── clj-sandbox/ufss
tui/dashboard-widget ── tui/dashboard-model

clj-main ── clj-sandbox/tools、host/hack-context、host/hack-system-prompt、prompts/common、clj-sandbox/ufss、scope/ariadne、util/errors
main ── 以上全部（按需注入）
bootstrap-main ── host/health + main
scope/gate ───── scope/ledger、scope/schema
```

规则：

- 底层模块不得 import 上层；`main.mjs` 只装配。
- `prompts/common.mjs` 不得 import `stages/disclosures.mjs`；S2–S5 简报只由门禁 handler 读取下一阶段。
- `stages/gate-tools.mjs` 通过注入的 `contract`、`host`、`runner` 端口工作，不直接 import `swarm/*` 或 `stages/contract.mjs`。
- `swarm/runner.mjs` 通过 port 接收 board、worktree、ff、subagent、prompt、recovery；不 import `stages/*` 或 `prompts/*`。
- 任何循环依赖都视为装配缺陷。

## 3 模块职责与变化秘密

| 路径 | 隐藏的变化秘密 | 直接依赖 |
|---|---|---|
| `host/imports.mjs` | 宿主与 `cherry-cljs` 的唯一导入点、版本/能力探测 | — |
| `host/subprocess.mjs` | 完整 `AgentDefinition`、`runSubprocess`、取消树、artifacts 语义 | `imports`、`util/errors` |
| `host/health.mjs` | 跨入口 health 注册表 | — |
| `util/atomic-write.mjs` | 同目录 `.tmp` + `fsync` + `rename` | `errors` |
| `util/file-lock.mjs` | `wx` 锁、判活、陈旧锁、锁序 | `errors` |
| `util/errors.mjs` | 错误码、EDN 诊断、渲染 | — |
| `clj-sandbox/ufss.mjs` | EDN + UFSS 读取与确定性打印 | `errors` |
| `clj-sandbox/where.mjs` | UTF-16 精确切片、候选、最近行 | `errors` |
| `clj-sandbox/evaluator.mjs` | Promise-CPS 解释器、符号表、续体、期限 | `imports`、`errors`、`ufss`、`where` |
| `clj-sandbox/vfs.mjs` | 批内 VFS、stamp、结构冲突、W 提交 | `atomic-write`、`errors` |
| `clj-sandbox/tools.mjs` | 角色能力矩阵与 `clj_*` 工具面；Plan 可读冻结 `cases.edn`，Auditor 拒绝读取并只消费注入 CASE | `errors`、`evaluator`、`ufss`、`vfs` |
| `scope/ariadne.mjs` | Ariadne 锚点、Time Leap、Beacon 封存 | `errors` |
| `scope/beacon-query.mjs` | 只读 Beacon 查询 | `ariadne` |
| `scope/projection.mjs` | 出站裁剪、简报钉住、双块锚点、缓存断点 | `errors` |
| `stages/disclosures.mjs` | S1–S5 简报文本 | — |
| `stages/parsers.mjs` | S1/S2 方法论与 S3/S4 文档结构校验；CASE 严格 Schema、modules/slices 覆盖校验；不解析 Markdown CASE | — |
| `stages/contract.mjs` | `mission.edn`、七项 `:frozen`、S1 summary、`cases.edn`/`:s3-modules`/`:s4-slices`、冻结/重对齐、批准 | `atomic-write`、`errors`、`file-lock` |
| `stages/gate-tools.mjs` | `advance_s1..s4` 事务、S1 摘要/S2 `cases.edn`/S3 modules/S4 slices 落盘、S1 手工批准面板、`realign_frozen`、`ask_user`、`devops`、`submit_review` | `errors`、`disclosures`、`parsers` |
| `stages/scores.mjs` | K 路审计汇总、`s5-report.md`、批准请求 | `atomic-write`、`errors` |
| `swarm/board.mjs` | 看板短事务、任务/动作/个体/令牌、同事务 wake、`dependency_paths` 相对路径与 `wait_for`/`condition:` 语义 | `ufss`、`atomic-write`、`errors`、`file-lock` |
| `swarm/worktree.mjs` | `worktrees.edn` 当前态、worktree 生命周期、FIFO、rebase/ff-only、GC | `ufss`、`atomic-write`、`errors`、`file-lock`、`board` |
| `swarm/runner.mjs` | Reviewer ⇄ Swarm、槽位、接力屏障、Nudge、Oracle、恢复 | `errors`、`board` |
| `swarm/auditors.mjs` | K 路审计隔离、冻结 `cases.edn`/`s1-summary` 字节与活哈希绑定、单 CASE 注入、单提交校验、返工派生 | `errors` |
| `prompts/common.mjs` | COMMON 规范文本（无 S2–S5 剧透） | — |
| `clj-sandbox/ufss.mjs` | EDN + UFSS 读写实现，并导出模型面向的 `UFSS_PROMPT_NOTE` | — |
| `prompts/roles.mjs` | 固定角色提示词、`buildCaseAuditorPrompt`、CASE 记录 EDN+UFSS 呈现 | `ufss` |
| `prompts/runtime-wires.mjs` | 语言后缀、gate 字段、Nudge | — |
| `tui/dashboard-model.mjs` | 纯数据双态/审计矩阵 | — |
| `tui/dashboard-widget.mjs` | aboveEditor 组件、稳定高度、文本降级 | `dashboard-model` |
| `main.mjs` | 装配、命令、hook、runner 端口 | 以上全部 |

## 4 当前装配状态

- **当前激活面是 clj-only（见 §1）**；本节其余内容是完整装配的保留状态，不代表清单会加载它们。`/herd`、门禁、看板、worktree、审计与 TUI 当前不可用；`DEBT.md` D0 记录该缺口与扩张顺序。
- 两个清单入口、`main.mjs` 的工具/命令注册、阶段门禁、看板、worktree、沙箱、Ariadne、TUI 与 runner 端口在当前源码中有注册/装配代码；这不等于行为验收完成。
- S1 是唯一手工批准门禁：`advance_s1` 展示磁盘上的真实 `plans/<slug>/s1-brainstorm.md` 并等待明确批准或修改；真实产品运行只能由人类操作员批准。获用户授权的隔离测试中，AI 操作员可以操作真实确认界面模拟批准或修改，但必须在实测记录中注明该次操作是测试模拟，不冒充人类批准或生产授权。产品不识别操作者身份，不新增测试模式或身份字段；无法证明隔离时不得使用该例外。
- `advance_s4` 通过 `runner.forkSlices` 创建 Slice 并启动 runner；`join_slice` 在 FIFO 队列耗尽时调用 `runMissionAudit`，另有 `session_start`/`agent_end` 的 `auditReady` 触发、`scheduleAuditRetry` 退避与冻结文件编辑导致的批次作废。`tests/s5-wiring.test.mjs` 是自动化集成，不是手工验收；真实宿主、重启和全 Slice 触发尚未验收。
- `prompts/runtime-wires.mjs#rewriteVibeModeContext` 已接入 `context` 出站副本的 `vibe-mode-context` 消息；`buildCaseAuditorPrompt` 已由 `runMissionAudit` 的 `buildPrompt` 使用，`startAgent` 使用调用方 `systemPrompt` 并透传请求选项。
- 角色收窄不再依赖独立 `role-auth` 模块：G1 用宿主报告的子会话身份 `ctx.agent` 判断是否咨询角色声明，M0 发布 role surfaces；首行 `[HERD_ROLE: ...]` token 仍作为声明被解析和核对。`ctx.agent` 缺失时，带首行角色 token 的会话按 fail-closed 拒绝并 health degraded，不再退回主会话工具面；无 token 的主会话仍按主会话处理。H1 spawn 前也要求 `hasCtxAgent`。真实 17.x/16.x 未验证。
- Esc 层级取消已接到 `onTerminalInput`；真实按键与宿主 API 缺失时的降级仍需 tmux 验证。
- `clj_*` 的顶层程序回执若为 `:state :failed`，工具结果现在显式带 `isError: true` 与错误码；回执文本本身不改。覆盖测试在 `tests/sandbox-tools.test.mjs`，不替代真实宿主取消验证。
- 同一 agent 在同一回合并发提交多个 `clj_*` 调用时，按 tool bundle 串行排队执行，不再把后到者拒绝为 `concurrent sandbox tool execution`；每个程序仍有独立 VFS/上下文，未建立同身并行写通道。
- H1 `spawnAgent` 的持久目录实际位于 `outcome.artifacts.{dir,persisted}`（不是顶层 `artifactsDir`）；`main` 两者都接受，只持久化 `persisted:true` 的目录，并用同一目录作为本次报告与后续 `continueAgent` 的 artifactsDir。
- 子会话的 `sessionManager.getArtifactsDir()` 可能是 `<parent-artifacts>/<agent-id>/`，但父端只持有 `<parent-artifacts>`；`submit_devops_report` 因此以 `getSessionFile()` 的父目录（`<parent-artifacts>`）为回执根，父端读同一路径。没有子会话文件路径时显式 `:HOST_API_MISMATCH`，不回退到 per-agent 目录写一个父端看不到的回执。同一 call-id 重复提交返回结构化 `:INVALID_ARGUMENT`；缺字段由 gate/service 拒绝且不写回执。包装器直接返回 `toolFail`，不得调用未定义的 `toolResult`。call-id 仍只来自父注入 prompt，经 `before_agent_start` 绑定；同任期 follow-up 重新注入，若宿主未触发该 hook，则只接受当前末条 parent prompt 中尚未消费的 call-id。成功提交后该 call-id 即为合法出口，`agent_end` 不再发 idle nudge；新的 call-id 才会重新武装。若子代理在写完回执后因后续 `yield`/退出错误失败，父端仍消费该次已落盘回执并记录 childError，不丢弃；没有回执才报错。
- `devops` 工具执行参数里的 `AbortSignal` 已传到 `Plan DevOps` 的首次 spawn 和后续 `continueAgent`；不再依赖可能缺失的 `state.lastContext.signal`。预取消窄测试在 `tests/main-bootstrap.test.mjs`，真实 Esc 仍需 tmux 验证。
- `writeLock.held` 只要锁文件仍存在就按持有处理；stale 只表示 owner 已死且超过 30 秒，必须由 recovery/用户确认清理后才可视为无 $W$；`board_finish` 建 runner port 前先从当前 board 刷新 actor 生死。`board_release`/`board_reopen` 提交成功后会调用 runner 的 `wake()`。`/herd-recovery repair` 现在把 `repair` 放在顶层传给 `recover`，并先把 `Error` 渲染成可序列化错误再输出。
- S1 手批确认面板使用公开 `ctx.ui.custom(... overlay/fullscreen ...)` 组件，正文从磁盘 `plans/<slug>/s1-brainstorm.md` 读取完整字节并支持 ↑/↓、PgUp/PgDn、Home/End 滚动；默认选中“拒绝”，←/→/Tab 显式选择批准/修改/拒绝，Enter 确认，Esc 取消。不截断、不用内存提交副本、resume 也重读；文件不可读或无自定义 UI 即 pending/拒绝批准。操作员确认后 gate 仍重读磁盘冻结，关闭/无批准不晋级。
- `contract.mjs` 的权威控制态是 `:frozen` 七项（`s1`、`s1-summary`、`s2`、`s2-cases`、`s3`、`s3-modules`、`s4`）；`contract-line` 只从七项纯派生。S1 摘要与 CASE 分别走 `saveS1Summary`/`saveS2Cases` 与 `readS1Summary`/`readS2Cases`（返回同一份 UTF-8 bytes + sha256）；S4 slices 是 `mission["s4-slices"]` inline，不进七项。`verifyFrozenPrefix` 支持阶段前缀校验，`realign` 支持 summary/cases/modules/slices 目标并返回 frozen/contractLine/caseIds；映射失效时必须同次传完整 modules/slices，否则 `:MAPPING_REALIGN_REQUIRED`，不等待人工。`structure.cases` 只接受 `case_id`（工具）或 `case-id`（EDN），旧 `{id}` 不再兼容；slices/modules 同理使用 `slice_id`/`slice-id`、`path`。S2 的权威提交入口是 `commitS2(root, slug, {manual_tests_markdown, cases}, {callId,structure})`：同一 mission lock 内写/复用 cases.edn 与文档、回读校验、再提交 mission；外部改动/旧回执均 fail closed，不能拆成 save+save+freeze 三段。
- D13 阶段控制态已按新根规范落源码并有各组件窄测报告：`advance_s1` 写/冻结 `s1-summary.md`；`advance_s2` 接收结构化 `cases` 并由 `commitS2` 原子写 `cases.edn` 与冻结 `s2-cases`；`advance_s3` 持久化完整 `:s3-modules`（inline 哈希）；`advance_s4` 从冻结 `cases.edn` 校验覆盖并写 `:s4-slices`；`main.caseSpecsFor` 从 `cases.edn`/`s1-summary.md` 单次读取并重读 mission 核对哈希，`startAuditBatch` 再与活哈希绑定；`board_finish` 校验工作区相对 `dependency_paths`，`wait_for` 支持 `condition:`；`clj_plan`/`clj_auditor` 的 `cases.edn` 读取边界已接入。这些是源码与窄测状态，不是验收；真实审计 end-to-end、统一全量复测与真实宿主版本仍未完成。详见 `DEBT.md` D13。
- S1 未冻结时，`advance_s1` 的新 call-id 可以原子替换 summary（`saveS1Summary` allowReplace）；同一 call-id 不同载荷仍 `:CALL_REPLAY_MISMATCH`，S1 已冻结后 `:FILE_CONFLICT`。文档与 summary 的提交顺序是先文档、后 summary；中间崩溃无 pending、不构成批准，重试同/新 call-id 重新对齐后再开面板。
- 多工人修复已有源码与窄自动化测试：`worktrees.edn` 当前态、看板同事务 wake、主装配 durable board + `$W$` + Holder `call` 窄场景（`tests/main-consumer.test.mjs`）、`call` 取消/日志、冻结文件 human-edit realign、Ariadne 锚点与出站投影。它们都没有真实宿主复测，不能写成已验收。
- Evaluator lazy-fix 当前交付：pull/lazyPull、LazyStream HOF、seq/rest/next、run!/sort/sort-by/update、hash/=/str/pr-str、some/every? 短路、tree-seq root/children、reductions/partition-by/split-with 输入、map/set 深物化、for/case/condp/letfn/when-* 宏、map :or、defn metadata 已有源码/测试覆盖；`memoize`（含 `cljs.core/memoize`）、`doto`、`try` 多重 catch（有序匹配、未命中回落外层、`Error`/类名与 `:code` 匹配、finally 必须最后、class 后缺绑定显式拒绝）与 transducer 族（`map`/`filter`/`remove`/`keep`/`mapcat`/`map-indexed`/`keep-indexed`/`take-while`/`drop-while`/`partition-by` 的一元 transducer arity，`take`/`drop`/`dedupe`/`distinct`/`interpose`/`partition-all`/`cat`/`halt-when`，`transduce`/`sequence`/`eduction`、三参数 `into`、`comp`/`completing`/`reduced` 族）已接入。解释器 fn 与异步 capability 走 LazyStream `call` 描述符，可参与 transducer 回调与 reducer；`sequence` 返回惰性 LazyStream，`eduction` 返回可重复消费的惰性描述，`into`/`transduce`/`vec`/`count`/`first`/`reduce` 等消费者按需展开。限制：`halt-when` 的最终值已贯通 `into`/`transduce` 的同步与异步路径（`sequence`/`eduction` 只停止输出）；`sequence`/`eduction` 在需要物化的消费者上仍受 200000 上限；deadline checkpoint 内存引用/忽略 unpark 值、pendingCall/regexCall 帧等待仍受限。D8 的 commit/discard 端口已与 control 竞争，端口 Promise reject 现在归入 rejected 而非穿出，rejected discard 标 `:uncertain`/`pending false`；被 abort 放弃的 capability 外部副作用归属仍需 C4。上述只有窄自动化，不是手工验收。
- Auditor per-auditor sandbox：`src/sandbox/` 已提供 bwrap + 两阶段 Landlock + 私有 tmux session，`ensureIsolationPaths` 在 §8.4 模板后追加实际路径；设计上宿主 TCP/Unix socket 不可达，框架 fixed provider relay socket 按设计可达且只转发 pinned provider。网络层只有窄测试；凭据/平台（`~/.omp/agent`/profiles、平台路径）只有提示/静态检查，credentials host-side 仅 proxy mode，env-only provider 由 `selectAuditTransport` 拒绝；真实 tmux/omp 隔离与资源回收未验证。
- 用户允许每批已知实操 bug 修完后进行一轮 tmux；发现新一批 bug 就停修。主真实 tmux 轮次正在开始，本文更新时尚未产生结果；不得把组件窄测当成验收。

剩余风险集中在真实宿主/E2E、全量测试矩阵、`sessionFile` 父链偏差、真实出站零剧透测试，以及 evaluator 的上述纯 core 高阶/惰性/宏/取消限制（`DEBT.md` D7/D8）；条款位置、影响与建议处理方式见 `DEBT.md`。

## 5 迁移完成状态

旧运行时路径 `src/pi-goal/`、`src/pi-context/`、`src/editor-theme/`、`src/context/`、`src/manual-acceptance/`、旧提示词模块、`src/util/objects.mjs`、旧入口与旧 manual-acceptance 测试均已删除；当前 `src/` 只保留新模块。独立开发验收包只位于 `tools/dev-acceptance/`。

不要恢复这些旧路径，也不要为旧工具名添加别名或兼容 shim。若发现新的 legacy 引用，按根规格 §9.6 先确认无消费者再删除，并同步本文件与 `DEBT.md`。

## 6 文档与变更纪律

- 根 `AGENTS.md` 须经人类操作员明确批准后，AI 方可修改；未经批准不得修改。S1 手工批准及其隔离测试例外不适用于修改根文件。批准后 AI 有义务直接更新根文件，并直接更新局部 `AGENTS.md`、源码与 `DEBT.md` 追上根规格。不修改已批准的人工验收文档。
- 修改提示词、阶段披露或工具名时，先由人类操作员批准并更新根规格，再更新实现、README/CHANGELOG、`DEBT.md`/`HISTORY.md` 与相应测试。
- 文档不得把“源码存在”“测试存在”写成“实现完成”或“验收通过”；真实宿主、tmux、手工 CASE 的结果以证据文件为准。
- 测试纪律：不保留只比较提示词字面拷贝、导出存在或结构接线的测试；真实出站零剧透与阶段转换测试应在捕获的真实 payload 上执行。当前没有该投影夹具时，不添加模拟代用品。
- 共享路径删除必须单次、具名、可核对；不删除用户既有历史资料（`docs/旧的方法论.md`、`docs/旧的架构.md`、`docs/旧的设计.html`、`docs/讨论纪要.md`、`docs/兄弟项目参考.md` 等）。
