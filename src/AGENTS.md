# src/AGENTS.md — 全局架构装配笔记

> 本文件不是规格。仓库根 `AGENTS.md` 是唯一 SSOT；两者冲突时以根规格为准。本文件只记录当前 `src/` 的模块边界、单向依赖、装配现状与迁移遗留；未关闭的规格偏差写在 `DEBT.md`。

## 0 组织原则

文件按功能组织，不按层或类型机械拆分：一个能力的实现、模型面向说明与契约放在同一模块；不为一常量或一段提示新建中转文件，也不保留只做 re-export 的薄层。调用方直接引用实现处；删除中间层时同步删除引用与文档条目。

## 1 入口与装配

当前清单（`package.json` 的 `omp.extensions` / `pi.extensions`）只有一个入口：

1. `src/clj-main.mjs`：唯一清单入口与宿主适配层。启动 nbb 与 formatter，尝试加载 `@oh-my-pi/pi-tui` 与 `host/language-detect.mjs`，设置 `globalThis.__herdHost.runSubagent`、`globalThis.__herdNative` 与 `globalThis.__herdPluginSrc`，加载 `src/herd/bootstrap.cljs`，最后用 `hackContext` 安装 `herd.main/context-handler`。它只提供宿主能力，不实现阶段、看板或审计语义。
2. `src/herd/bootstrap.cljs`：从 classpath 与 `globalThis.__herdPluginSrc` 定位 `src/herd/*.cljs`，加载 `herd/main.cljs`。
3. `src/herd/main.cljs`：CLJ 工具面（`clj_devops`、`wait`、`handoff`）、系统提示词注入、handoff 消费、usage/status、`HERD_TRACE` 热路径计时与 hooks；加载时调用 `system/install!`。
4. `src/herd/system.cljs`：完整装配接线。注册八个门禁工具（`review`、`attach_brainstorm`、`attach_manual_tests`、`attach_dev_guide`、`attach_coordination`、`ask_user`、`devops`、`submit_devops_report`）、11 个 `board_*` 与 `attach_case_audit`；提供 `/herd <seed>` 命令、mission 与 `.herd/focus.edn`、阶段/角色工具面、Nudge、S1 面板端口、S5 runner/审计端口与 health 记录。
5. `src/herd/swarm/runner.cljs`、`src/herd/swarm/auditors.cljs`：单工作区 S5 Reviewer ⇄ Swarm 接力与 K 路审计，已由 `system.cljs` 接线。

保留但不由清单加载：

- `src/main.mjs`、`src/bootstrap-main.mjs`：旧完整装配入口，仍引用旧模块与 `src/tui/*`。
- `src/tui/*`：看板已按用户 2026-11-14 指令整体移除；源码保留，但没有任何被清单加载的入口 import 或挂载。`tests/cljs-dashboard-wiring.test.mjs` 只断言从不挂载。
- `src/clj-sandbox/*`、`src/stages/*`、`src/swarm/*`：旧 mjs 实现，保留未加载，待删除。
- `src/host/*.mjs` 是宿主适配层：`hack-context`、`imports`、`native-runner`、`subprocess`、`language-detect` 由 `src/clj-main.mjs` 直接 import；`health` 被旧 `main.mjs`、`bootstrap-main.mjs` 与 `tui/dashboard-widget.mjs` 使用；清单入口不加载这些模块。

`src/herd/main.cljs` 的 `before-agent-start` 负责系统提示词注入：`herd.prompts/common-rules-text` 包含 `# Repo-aware Rules`、11 段 `COMMON_CORE_RULES` 与 `UFSS_PROMPT_NOTE`；用 `<!-- herdchestra:system-prompt v1 -->` 受管区替换旧块，支持 string 与 string[] prompt，检测到标题已存在则替换（幂等），异常时 fail-open 返回宿主原提示词。`herd.system/briefing-for` 在使命会话中追加当前阶段的 S1–S5 简报；子代理不注入。语言纪律仍由出站 `context` 尾注注入。

omp 在进程内缓存已加载的 ESM 模块，系统提示词在会话启动时组装；修改 `src/herd/prompts.cljs` 后必须重启 omp 或新开进程，当前进程不会热更新。

`src/clj-main.mjs` 不再维护宿主工具黑名单。`herd.main/apply-tool-surface!` 调 `system/apply-mission-surface!`：只有使命内主会话（S1–S5）或显式 herd 角色才收窄；没有使命的主会话与无收窄角色的普通子代理保留全部宿主工具，并追加 `clj_devops`、`wait`、`handoff`（devops 面）。`/vibe` 主代理除外：不追加、不调用 `setActiveTools`。收窄失败记 health degraded 并保留当前面，不静默删工具。启动侧有单例：并发激活共享 `globalThis.__herdBootPromise`，失败清空以便重试；`contextPis`、`activated-pis` 与 `system/installed-pis` 是 per-pi `WeakSet`，同一进程多 pi 各自安装一次。

默认运行时是 `nbb`：`src/clj-main.mjs` 通过 `createRequire` 加载插件自带的 nbb，并注册 formatter；CLJS 侧通过 `src/herd/bootstrap.cljs` 加载。旧 `src/clj-sandbox/*`（Cherry/CEK/VFS）不在当前加载链上。

## 2 当前单向依赖图

按当前被清单加载的 `import` / `require` 关系整理（箭头表示“依赖”）：

```text
clj-main
  ├── host/{hack-context,imports,native-runner,subprocess,language-detect}
  └── herd/bootstrap ── herd/main
                          ├── herd/{handoff,highlight,prompts,repl,system,ufss}
                          └── herd/system
                                ├── herd/{repl,ufss,util/atomic-write}
                                ├── herd/stages/{audit,disclosures,gates,paths,store,tenure}
                                └── herd/swarm/{auditors,model,runner,store,tools}

herd/repl ── herd/{sandbox,ufss}
herd/system ── herd/{repl,ufss,util/atomic-write}
herd/stages/gates ── herd/stages/{attach,disclosures,parsers,store,tenure}、herd/ufss、herd/util/atomic-write
herd/stages/attach ── herd/stages/{parsers,paths,store,tenure}、herd/util/atomic-write
herd/stages/store ── herd/stages/{mission,paths}、herd/ufss、herd/util/atomic-write
herd/stages/report ── herd/util/atomic-write
herd/swarm/runner ── herd/stages/{disclosures,store,tenure}、herd/swarm/{apply,edn,model,store}
herd/swarm/auditors ── herd/stages/{audit,parsers,paths,report,scores}、herd/swarm/{apply,edn,model,store}、herd/ufss、herd/util/atomic-write
herd/swarm/kernel ── herd/swarm/{actors,commands,edn,ledger,model,token}
herd/swarm/tools ── herd/swarm/{apply,edn,store}、herd/ufss
herd/swarm/store ── herd/swarm/{edn,model}
```

规则：

- 底层模块不得 import 上层；`src/clj-main.mjs` 与 `herd/main.cljs` 只装配。
- `herd/prompts.cljs` 不 import 阶段模块；S1–S5 简报由 `herd/stages/disclosures.cljs` 提供，`herd/system.cljs` 读取当前阶段简报。
- `herd/stages/gates.cljs` 通过注入端口工作，不直接 import `herd/system.cljs`。
- `herd/swarm/runner.cljs` 通过 port 接收 board、subagent、prompt、recovery；不 import `herd/system.cljs`。
- 任何循环依赖都视为装配缺陷。

## 3 模块职责与变化秘密

| 路径 | 隐藏的变化秘密 | 直接依赖 |
|---|---|---|
| `src/clj-main.mjs` | 唯一清单入口、nbb 引导、宿主 subagent port、Runner 捕获 | `host/*`、`herd/bootstrap` |
| `src/herd/bootstrap.cljs` | CLJS 源码定位与加载顺序 | `herd/ufss` |
| `src/herd/main.cljs` | CLJ 工具面、系统提示词受管区、handoff 消费、usage/status、trace | `herd/{handoff,highlight,prompts,repl,system,ufss}` |
| `src/herd/system.cljs` | 完整装配、`/herd`、mission/focus、阶段/角色面、Nudge、S1 面板、S5 端口 | `herd/stages/*`、`herd/swarm/*` |
| `src/herd/repl.cljs` | nbb 程序生命周期、park/unpark/abandon、`guard-source!` | `herd/{sandbox,ufss}` |
| `src/herd/sandbox.cljs` | 异步 fs、跨进程写锁、`glob`/`where`/`call` 边界 | — |
| `src/herd/handoff.cljs` | 双锚点解码、覆盖去重、解不了即字面 | — |
| `src/herd/ufss.cljs` | EDN reader/writer、UFSS fence、canonical | — |
| `src/herd/prompts.cljs` | COMMON 规范、角色提示词、UFSS 注记 | — |
| `src/herd/stages/*.cljs` | 门禁解析、tenure、mission/store、review/attach、报告、审计提交 | `herd/ufss`、`herd/util/atomic-write` |
| `src/herd/swarm/*.cljs` | 看板内核/存储/工具、单工作区 runner、K 路审计 | `herd/stages/*`、`herd/ufss` |
| `src/herd/util/atomic_write.cljs` | 同目录临时文件 + fsync + rename | — |
| `src/host/*.mjs` | 宿主 imports、native runner、subprocess、hack context、health | 宿主包 |
| `src/tui/*.mjs` | 旧看板组件；保留未加载 | — |
| `src/clj-sandbox/*`、`src/stages/*`、`src/swarm/*` | 旧 mjs 实现；保留未加载，待删除 | — |

## 4 当前装配状态

- **完整装配已默认启用**（见 §1）：`src/clj-main.mjs` → `herd/bootstrap.cljs` → `herd/main.cljs` + `herd/system.cljs`。`/herd`、八门禁、11 个 `board_*`、`attach_case_audit`、S5 单工作区 runner 与 K 路审计都已接线。TUI 看板已按用户 2026-11-14 指令整体移除，不再挂载；`src/tui/*` 与旧 `src/main.mjs` 保留但不由清单加载。
- **park/unpark（2026-11-14）**：`park` 只挂起工具等待，不取消、不重启已启动的 `call`；后台 Promise 继续运行。`park` 回执自动带自上次展示以来的增量 `:stdout`/`:stderr` 与 `:call-active true`（有活跃 call 时）。`unpark` 先对活跃 call 灌入字符串或 `{:stdin ... :eof ...}`，同时 resolve 挂起表达式，然后等待原程序 Promise 完成并返回最终结果；再次 park 返回新的 parked 回执。`abandon` 仍是唯一强制清理入口。`tests/cljs-sandbox.test.mjs` 覆盖增量输出与 stdin 灌入。
- `clj_devops` 已删除必填 `scope`（`turnsRemaining`/`todosRemaining`），改为必填 `agent_state` 枚举（`Orienting`/`Converging`/`Consolidating`/`Stagnant`/`Drifting`/`Densifying`/`Reorienting`/`Settled`）；`clj_devops` 的渲染标题把英文枚举映射为中文标签（如 `--- [探索定向]`），仍用 dim 样式。该字段只用于 LLM 自报控制流状态，不改变能力、令牌或验收；工具结果 EDN 前只在状态切换时加一行 `;` 状态注释（连续同态不重复）。
- 默认不再调用 `ctx.ui.setToolsExpanded(true)`；展开态由宿主默认与用户切换决定。`clj_devops` 的 `renderCall`/`renderResult` 同时支持展开与非展开：非展开保留标题、横线与完整多行正文；多行字符串或长度超过 40 字符的字符串替换为 dim 色的 `$$$`，仅单行且不超过 40 字符的字符串正常渲染；展开显示完整字符串。
- **handoff**：`src/herd/handoff.cljs` 是双锚点解码器（首 AAA 到末 BBB、覆盖去重、解不了即字面）；`handoff` 工具排队并返回占位符（build `handoff-boundary-v9`）；`src/herd/main.cljs` 的 `consume-handoff!` 对首次替换返回 `handoffReplacement`；`src/host/hack-context.mjs` 检测 `compaction`/`reset_boundary`，边界存在时禁止 `rewriteSession`，只把替换追加到边界之后。`hackContext` 本身无状态：每次 `context` 请求从宿主 `sessionManager.getLeafEntry()` / `getEntry()` / `getLeafId()` 读最后一条持久化消息，找到追加点就只 `branch(leafId)` + `appendMessage`（O(delta)），找不到才全量重写一次。`last-handoffs` 保留 tool-call-id、timestamp，并缓存 `:text` 与 `:result-index` 各一次；重启后记录为空时 `last-doc-index` 从最后一份持久化文档裁剪。扫描窗口是最近 512 条消息，文档窗口 32 条。证人：`tests/cljs-handoff.test.mjs`、`tests/hack-context.test.mjs`。
- **S1 手工批准**：`herd/stages/gates.cljs` 写盘后通过 `system.cljs` 的确认端口阻塞打开面板；面板从磁盘 `plans/<slug>/s1-brainstorm.md` 读取完整字节并支持滚动；默认选中拒绝，左右/Tab 显式选择批准/修改/拒绝，Enter 确认，Esc 取消。approve / revise / deny / pending 四态都有回执；`deny` 转 `ask_user` 语义；文件不可读或无自定义 UI 时 pending/拒绝批准。真实宿主/tmux 验证仍属 D4。
- **角色收窄**：依赖宿主报告的 `ctx.agent` 与首行 `[HERD_ROLE: ...]` token；`ctx.agent` 缺失时 fail-closed 并 health degraded，不退回主会话工具面。`surface-for` 给出 `Plan DevOps`、`Reviewer`、`Swarm Worker`、`Swarm Holder`、`Manual Auditor` 的工具面。真实 17.x/16.x 未验证（D5）。
- Esc 层级取消已接到 `onTerminalInput`；真实按键与宿主 API 缺失时的降级仍需 tmux 验证。
- `clj_*` 的顶层程序回执若为 `:state :failed`，工具结果显式带 `isError: true` 与错误码；覆盖测试在 `tests/cljs-sandbox.test.mjs`。
- 同一 agent 在同一回合并发提交多个 `clj_*` 调用时，按 tool bundle 串行排队执行；每个程序仍有独立上下文，未建立同身并行写通道。
- `submit_devops_report` 以 `getSessionFile()` 的父目录（`<parent-artifacts>`）为回执根；没有子会话文件路径时显式 `:HOST_API_MISMATCH`，不回退到 per-agent 目录。同一 call-id 重复提交返回 `:INVALID_ARGUMENT`。
- `devops` 工具执行参数里的 `AbortSignal` 已传到 `Plan DevOps` 的首次 spawn 和后续 `continueAgent`；devops 端口有窄测；真实 Esc 仍需 tmux 验证。
- `board_finish` 校验工作区相对 `dependency_paths`；`wait_for` 支持任务 ID 与 `condition:` 键。启动恢复扫描把 `repair` 放在顶层传给 `recover`，并先把 `Error` 渲染成可序列化错误再输出。审计批次状态在 `.herd/missions/<slug>/audit/batch.edn` 幂等；FAIL 写 repair 根任务。
- Auditor 只做防呆：`herd/swarm/auditors.cljs` 使用 `/tmp/herd-audit-<slug>-<case>-<batch>`，角色面不暴露 `write`/`mkdir`/`rm`/`mv`；`call` 可自由使用，可能修改主工作区，这是明确信任边界，不是安全隔离；不再要求 bwrap。
- **性能边界（有意限制）**：写锁默认等待 500ms（`HERD_LOCK_WAIT_MS` 可调 50–5000ms；10ms 起指数退避、封顶 160ms），超时 `:LOCK_BUSY`（`:retryable true`）；`glob` 跳过 `node_modules`/`.git`/`.herd`，默认 20 000 条目 / 2 000ms（`:LIMIT_EXCEEDED`）；`where` 最近行 DP 1 000 000 cells + 150ms；`cat`/`write` 单文件 2 MiB；handoff 扫描 512/32；usage/status 只由真实 hook 事件写入（相同文本不重发，无轮询/定时器）。触发时明确拒绝，不静默截断。
- **vibe 工具面**：没有使命的主会话与无收窄角色的普通子代理保留全部宿主工具并追加 `clj_devops`、`wait`、`handoff`（devops 面）；`/vibe` 主代理不追加、不调用 `setActiveTools`；只有使命内主会话按阶段、显式 herd 角色按角色收窄。`tests/cljs-surface-vibe.test.mjs` 与 `tests/cljs-surface.test.mjs` 是证人。
- **启动与安装单例**：并发激活共享 `globalThis.__herdBootPromise`，失败清空以便重试；`contextPis`、`activated-pis`、`installed-pis` 三组 per-pi `WeakSet` 保证同一进程多 pi 各自只安装一次。`tests/cljs-system-install.test.mjs`、`tests/clj-main-trace.test.mjs` 覆盖。
- **context 自动重写**：每会话分支最多自动全量重写一次（host leaf 变化后重置预算）；之后 prefix miss 只记录 `prefix-miss-suppressed`，compaction/reset boundary 存在时一律不重写。`tests/hack-context-rewrite.test.mjs` 覆盖。
- **诊断开关**：`HERD_TRACE=1` 写 `.herd/perf-trace.jsonl`（1 MiB 上限，`HERD_TRACE_PATH` 可改）；`HERD_CACHE_PROBE=1` 才启用 `before_provider_request` probe，写 `.herd/cache-probe.jsonl`（`HERD_CACHE_PROBE_PATH` 可改）。两者默认关闭。
- **沙盒 console/stdio 防呆**：`herd/repl.cljs` 的 `guard-source!` 在用户代码执行前拒绝 `console`、`js/console`、`globalThis.console`、`js/process.stdout`/`stderr`、`process.stdout`/`stderr` 与 `(.-stdout js/process)` 等直接访问，返回 `:CAPABILITY_DENIED`（`:reason :console-or-stdio-forbidden`）。字符串、字符字面量、注释与 UFSS fence 中的同名词不误杀；`call` 仍用 pipe 捕获 stdout/stderr，但不落盘日志。这是基本防呆，不是安全边界。
- **usage**：delta 显示最近活动子代理的最后一次请求，sum 合并所有 agent key；主会话后续请求不会把 delta 抢回主会话。
  工作条由真实 hook 事件驱动：`session_start`、`before_agent_start`、`before_provider_request`、`message_start`、`message_end`、`message_update`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`。`message_update` 与 `tool_execution_update` 只用于检测官方覆盖：宿主提供 `getWorkingMessage` 时优先读取；否则包装 `setWorkingMessage` 记录官方最后写入的文本。只有当前文本不是目标文本时才写回，文本相同不重发；没有 `setInterval`，也没有周期性 `setTimeout`。`ui-render` 的 `:last-working` 按 session 记录最后一次写出的文本；`apply-working-message!` 是唯一写入点，并在 `subagent-ctx?` 为真时跳过，子代理绝不写主 UI。证人：`tests/cljs-working-message.test.mjs`、`tests/cljs-usage.test.mjs`。
- 旧 `src/*.mjs`（`main.mjs`、`bootstrap-main.mjs`、`clj-sandbox/*`、`stages/*`、`swarm/*`、`tui/*`）保留但不由清单加载；不要为旧工具名添加别名或兼容 shim。
- 真实宿主 S1→S5 端到端、tmux 交互、重启恢复与全量交错矩阵尚未验收；不得把组件窄测或 `omp -p` 冒烟当成验收（D3、D4、D5、D7）。

## 5 迁移完成状态

旧运行时路径 `src/pi-goal/`、`src/pi-context/`、`src/editor-theme/`、`src/context/`、`src/manual-acceptance/`、旧提示词模块、`src/util/objects.mjs`、旧入口与旧 manual-acceptance 测试均已删除。当前业务实现位于 `src/herd/*.cljs`；`src/clj-sandbox/*`、`src/stages/*`、`src/swarm/*`、`src/tui/*`、`src/main.mjs` 与 `src/bootstrap-main.mjs` 是保留的旧 mjs，不由清单加载，待按 `MIGRATION.md` 删除。启动单例、per-pi 安装、vibe 工具面与 500ms 锁等待已收口；`src/tui/*` 保留但不由清单加载。当前测试面为 431 pass / 1 skip / 0 fail / 44 files（约 16.2s），但它只保护组件与接线。真实端到端验收仍由 `DEBT.md` D3 记录，不能用迁移完成代替验收。独立开发验收包只位于 `tools/dev-acceptance/`。

不要恢复这些旧路径，也不要为旧工具名添加别名或兼容 shim。若发现新的 legacy 引用，按根规格 §9.6 先确认无消费者再删除，并同步本文件与 `DEBT.md`。

## 6 文档与变更纪律

- 根 `AGENTS.md` 须经人类操作员明确批准后，AI 方可修改；未经批准不得修改。S1 手工批准及其隔离测试例外不适用于修改根文件。批准后 AI 有义务直接更新根文件，并直接更新局部 `AGENTS.md`、源码与 `DEBT.md` 追上根规格。不修改已批准的人工验收文档。
- 修改提示词、阶段披露或工具名时，先由人类操作员批准并更新根规格，再更新实现、README/CHANGELOG、`DEBT.md`/`HISTORY.md` 与相应测试。
- 文档不得把“源码存在”“测试存在”写成“实现完成”或“验收通过”；真实宿主、tmux、手工 CASE 的结果以证据文件为准。
- 测试纪律：不保留只比较提示词字面拷贝、导出存在或结构接线的测试；真实出站零剧透与阶段转换测试应在捕获的真实 payload 上执行。当前没有该投影夹具时，不添加模拟代用品。
- 共享路径删除必须单次、具名、可核对；不删除用户既有历史资料（`docs/旧的方法论.md`、`docs/旧的架构.md`、`docs/旧的设计.html`、`docs/讨论纪要.md`、`docs/兄弟项目参考.md` 等）。
