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

JS 边界层（`src/` 下仅保留以下活跃 `.mjs` 文件，旧 `main.mjs`、`bootstrap-main.mjs`、`tui/`、`prompts/`、`stages/`、`swarm/`、`clj-sandbox/`、`sandbox/` 及旧 `util/{atomic-write,file-lock,broker}.mjs`、`host/{health,model-seed,hack-system-prompt,session-key}.mjs` 均已删除）：

- `src/host/*.mjs` 是宿主适配层：`hack-context`、`imports`、`lock-daemon`、`native-runner`、`subprocess`、`language-detect` 由 `src/clj-main.mjs` 直接使用。
- `src/util/errors.mjs` 为宿主子代理边界提供错误码与 EDN 错误渲染（由 `src/host/subprocess.mjs` 使用）。

`src/herd/main.cljs` 的 `before-agent-start` 负责系统提示词注入：`herd.prompts/common-rules-text` 包含 `# Repo-aware Rules`、11 段 `COMMON_CORE_RULES`、`SANDBOX_PROMISE_NOTE` 与 `UFSS_PROMPT_NOTE`；用 `<!-- herdchestra:system-prompt v1 -->` 受管区替换旧块，支持 string 与 string[] prompt，检测到标题已存在则替换（幂等），异常时 fail-open 返回宿主原提示词。`herd.system/briefing-for` 在使命会话中追加当前阶段的 S1–S5 简报；子代理不注入。语言纪律仍由出站 `context` 尾注注入。

omp 在进程内缓存已加载的 ESM 模块，系统提示词在会话启动时组装；修改 `src/herd/prompts.cljs` 后必须重启 omp 或新开进程，当前进程不会热更新。

`src/clj-main.mjs` 不再维护宿主工具黑名单。`herd.main/apply-tool-surface!` 调 `system/apply-mission-surface!`：只有使命内主会话（S1–S5）或显式 herd 角色才收窄；没有使命或无收窄角色的会话由 `herd.main` 以黑名单移除宿主编辑/shell 工具（`read`/`write`/`edit`/`apply_patch`/`ast_edit`/`ast_grep`/`bash`/`exec`/`eval`/`glob`/`grep`/`find`），保留其余宿主工具并追加 `clj_devops`、`wait`、`handoff`（devops 面，与根规格 §0.4 一致）。收窄失败记 health degraded 并保留当前面，不静默删工具。启动侧有单例：并发激活共享 `globalThis.__herdBootPromise`，失败清空以便重试；`contextPis`、`activated-pis` 与 `system/installed-pis` 是 per-pi `WeakSet`，同一进程多 pi 各自安装一次。

默认运行时是 `nbb`：`src/clj-main.mjs` 通过 `createRequire` 加载插件自带的 nbb，并注册 formatter；CLJS 侧通过 `src/herd/bootstrap.cljs` 加载。

## 2 当前单向依赖图

按当前被清单加载的 `import` / `require` 关系整理（箭头表示“依赖”）：

```text
clj-main
  ├── host/{hack-context,imports,lock-daemon,native-runner,subprocess,language-detect}
  └── herd/bootstrap ── herd/main
                          ├── herd/{handoff,prompts,repl,system,ufss,ui}
                          └── herd/system
                                ├── herd/{repl,ufss,ui,util/atomic-write}
                                ├── herd/stages/{audit,disclosures,gates,paths,store,tenure}
                                └── herd/swarm/{auditors,model,runner,store,tools}

herd/ui ── herd/{highlight,ufss}
herd/sandbox ── herd/clock
herd/repl ── herd/{clock,sandbox,ufss}
herd/system ── herd/{repl,ufss,ui,util/atomic-write}
herd/stages/gates ── herd/stages/{attach,disclosures,parsers,store,tenure}、herd/ufss、herd/ui、herd/util/atomic-write
herd/gates_host ── herd/stages/gates、herd/ufss
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
| `src/herd/main.cljs` | CLJ 工具面、系统提示词受管区、handoff 消费、usage/status、trace | `herd/{handoff,prompts,repl,system,ufss,ui}` |
| `src/herd/ui.cljs` | 所有 CLJ/门禁/看板/审计工具的统一视觉渲染（Title --- [Tag] + hrule + EDN+UFSS） | `herd/{highlight,ufss}` |
| `src/herd/system.cljs` | 完整装配、`/herd`、mission/focus、阶段/角色面、Nudge、S1 面板、S5 端口 | `herd/stages/*`、`herd/swarm/*` |
| `src/herd/repl.cljs` | nbb 程序生命周期、park/unpark/abandon、`guard-source!` | `herd/{sandbox,ufss}` |
| `src/herd/sandbox.cljs` | 异步 fs、跨进程写锁、`glob`/`where`/`call` 边界 | — |
| `src/herd/handoff.cljs` | 双锚点解码、覆盖去重、解不了即字面 | — |
| `src/herd/ufss.cljs` | EDN reader/writer、UFSS fence、canonical | — |
| `src/herd/prompts.cljs` | COMMON 规范、角色提示词、UFSS 注记 | — |
| `src/herd/stages/*.cljs` | 门禁解析、tenure、mission/store、review/attach、报告、审计提交 | `herd/ufss`、`herd/ui`、`herd/util/atomic-write` |
| `src/herd/swarm/*.cljs` | 看板内核/存储/工具、单工作区 runner、K 路审计 | `herd/stages/*`、`herd/ufss`、`herd/ui` |
| `src/herd/util/atomic_write.cljs` | 同目录临时文件 + fsync + rename | — |
| `src/host/*.mjs` | 宿主 imports、IPC 锁守护进程、native runner、subprocess、hack context、language-detect | 宿主包、`util/errors` |
| `src/util/errors.mjs` | 宿主边界错误码与 EDN 错误渲染 | — |

## 4 当前装配与运行契约

- **默认启用全装配**：`src/clj-main.mjs` → `herd/bootstrap.cljs` → `herd/main.cljs` + `herd/system.cljs`，`/herd`、8 门禁、11 个 `board_*`、`attach_case_audit`、S5 单工作区 runner 与 K 路审计均已接线，全工具接入 `herd/ui` 渲染；TUI 看板及旧 `src/*.mjs` 实现已删除，禁止恢复别名或 shim。
- **默认/使命工具面**：无使命且无收窄角色时，`herd.main/apply-tool-surface!` 用黑名单移除宿主编辑/shell 工具并追加 `clj_devops`/`wait`/`handoff`；只有使命内主会话按阶段、显式 herd 角色（经宿主 `ctx.agent` + 首行 `[HERD_ROLE: ...]` token 判定，缺失 fail-closed）按角色收窄。
- **沙盒调用与自检**：`clj_devops` 强制提供唯一 `name` 与 `agent_state` 枚举（状态切换时在 EDN 前置 `;` 注释）；`more_workers_without_hitting_mythical_man_month` 为正时在回执末尾追加 `<system-reminder>`，`ui.cljs` 剥离尾注保留正文高亮。同回合多 `clj_*` 按 tool bundle 串行排队。
- **同步回执不入 `wait` 队列**：`repl/run-role` 通过 `:returned-directly` 守卫与 `finish-directly!` 保证 2000ms 内同步完成/失败的调用立刻从 `@programs` 清除，仅 `:forked` 与 `:parked` 程序保留供 `wait`/`unpark` 收集。
- **park / unpark / abandon**：`park` 不中止后台 `call` 并带增量 `:stdout`/`:stderr` 与 `:call-active true`；`unpark` 先向活跃 `call` 灌入 `:stdin`/`:eof` 并 resolve 续体、通过 `await-resumed` 等待结果；`abandon` 负责强制击杀进程组并清理状态。
- **handoff 与工作条**：`handoff` 双锚点解码（`src/herd/handoff.cljs`）+ `hackContext` 每会话分支至多全量重写一次，其后 append-only（含 `compaction`/`reset_boundary` 时仅边界后追加；扫描窗口 512/32）。`context-handler` 每次请求末尾无条件追加的仅含 `<system-reminder><skill version="1.0">…</skill></system-reminder>` 的 `user` 尾注是有意设计的 feature（非重复注入/空消息 bug，见根 `AGENTS.md` §5.3）。`usage` 由真实 hook 事件驱动恢复被宿主覆盖的工作条（100ms 合并、无轮询定时器，子代理不写主 UI）。
- **门禁、看板与审计隔离**：`submit_devops_report` 以 `getSessionFile()` 父目录为回执根；`devops` 透传 `AbortSignal`；`board_finish` 校验相对 `dependency_paths`，`wait_for` 支持任务 ID 与 `condition:` 键；Auditor 仅作防呆（独立 `/tmp/herd-audit-<slug>-<case>-<batch>`，无写工具，`call` 属信任边界，无 bwrap）。
- **跨进程事件驱动锁**：写门 `$W$` 与 S5 看板事务统一走 `src/host/lock-daemon.mjs`（`node:net` 按需单例守护进程，连接即持锁、`SIGKILL` 秒级释锁、零轮询、无陈旧锁），同进程写操作先经 FIFO 队列接力防自踩。写门等待默认 500ms（`HERD_LOCK_WAIT_MS` 50–5000ms，`:LOCK_BUSY`）；`glob` 跳过 `node_modules`/`.git`/`.herd`（20k/2s）；`where` 最近行 1M cells/150ms；`cat`/`write` 单文件 2 MiB；`guard-source!` 拒绝 `console`/stdio 直接访问（`:CAPABILITY_DENIED`）；`HERD_TRACE=1` / `HERD_CACHE_PROBE=1` 默认关闭（1 MiB 上限）。
- **当前验证与未验收边界**：开发者测试为 275 pass / 0 fail / 25 files（`tests/fast.test.mjs` 45 pass，`tools/dev-acceptance/test` 23 pass），`biome check .` 为 0 errors / 0 warnings；真实 `omp` + `tmux` S1→S5、S1 面板与 16.x/17.x 兼容仍属 `DEBT.md`（D3–D5、D7、D20），测试不等于验收。

## 5 宿主边界、平台实测与受控绕行（原 HACK.md）

### 5.1 环境快照与 `BUN_OPTIONS`

- 宿主实测基线：`omp/18.20.0`（编译 ELF `/home/kunweiz/.local/bin/omp`），仓库源码副本 `@oh-my-pi/pi-coding-agent@18.15.0`（`17.3.5` 仅历史参照）；`bun 1.4.4`、`git 2.56.0`、`tmux 3.7c`。
- 宿主在 shell 注入 `BUN_OPTIONS=--preload /home/kunweiz/.config/omp/zstd-preload.js`，导致 Bun 1.4.4 把 `bun test` 误解析为脚本名。开发者测试须带 `env -u BUN_OPTIONS`；沙箱 `call`（`src/herd/sandbox.cljs`）已自动剥离 `BUN_OPTIONS`/`NODE_OPTIONS`/`BASH_ENV`/`ENV`/`PROMPT_COMMAND`。
- 不指定 `--model` 时本机默认模型可能触发 `model_not_available_for_integrator`，真实验收须显式指定可用主模型与 `@task` 模型。

### 5.2 唯一受控宿主补丁：`src/host/native-runner.mjs`

- **目的与实现**：宿主公开 `ExtensionAPI`/`ExtensionContext` 不暴露 Runner，唯独 `ExtensionRunner.prototype.invokeNativeTool` 可执行官方 `read`/`write`。`native-runner.mjs`（由 `host/imports.mjs` 重导出）懒加载 `@oh-my-pi/pi-coding-agent/extensibility/extensions/runner` 并包装 `ExtensionRunner.prototype.createContext`，记入 `WeakMap<ctx, runner>` 与最近 runner；编译宿主将扩展内字面量动态 import 重写为 `omp-legacy-pi-bundled:` 单例注册表，因此补丁准确命中宿主自身 `ExtensionRunner`。
- **失败与限制**：捕获失败或 `--no-tools` 禁用内置工具时返回 `:HOST_API_MISMATCH`（禁止回退 `node:fs`）；`callerContext` 不可得导致 `write` 的 LSP 批量刷新元数据不完整；worker 桥未把 `AbortSignal` 传入 `invokeNativeTool`。
- **回滚**：移除 `src/clj-main.mjs` 的 `installRunnerCapture()` 调用与 `src/host/native-runner.mjs`，沙箱将自然 fail-closed。

### 5.3 `omp` Hooks、`sessionManager` 与 `runSubprocess`

- `before_agent_start`：`event.systemPrompt` 在真实宿主为 `string[]`（须同时兼容 `string`）；`ctx.signal` 为 `undefined`（取消信号取 `execute` 第 3 参数、`runSubprocess` signal 与 `AbortController` 树）；`ctx.agent` 在 18.x 存在（`{kind, id, name, depth}`），17.x/16.x 未保证。
- `context` 钩子与深拷贝：`context` 事件的 `ctx.sessionManager` 可能缺失，持久化状态在 `session_start` 捕获。真实宿主在调 `context` 前会深拷贝消息对象（`!==`），因此 `src/host/hack-context.mjs` 先按引用再按末尾 `deepEqual` 定位持久化前缀；`appendCompaction` / `appendResetBoundary` 写下的边界后只能追加、不可 `rewriteSession`。
- `runSubprocess`：`agent` 须传完整 `AgentDefinition`；`artifactsDir` 是子会话 transcript 落盘唯一开关；`sessionFile` 在 18.16+ 写入 `SessionHeader.parentSession`（17.3.5 忽略）；`parentAgentId` 与 `parentToolCallId` 随选项透传。

### 5.4 `nbb`、`pi-tui` 与 `highlight.js`

- `nbb@1.6.215`：宿主 bare/bundled `nbb` 不含 `cljs.pprint`，`src/clj-main.mjs` 须从插件真实路径 `createRequire` 解析自带 `nbb`，并按 `(module, name)` 顺序调用 `nbb.registerModule(formatter, "@chrisoakman/standard-clojure-style")`；`bootstrap.cljs` 从 `nbb.classpath` 与 `globalThis.__herdPluginSrc` 解析源码根，不依赖 `process.cwd()`。
- SCI 版 `cljs.pprint` 默认宽度约 72 列，且不导出 `*print-right-margin*`/`*print-miser-width*`/`write`，测试不得逐字固化 EDN 换行位置。
- `@oh-my-pi/pi-tui` 提供 `highlightCode(code, lang, theme)`；内容语言识别由 `highlight.js@11.12.0`（`src/host/language-detect.mjs`）委托完成，`xml` 映射到 `html`。

### 5.5 常用复检命令

- 全量测试：`env -u BUN_OPTIONS bun test tests --parallel`
- 规范检查：`env -u BUN_OPTIONS ./node_modules/.bin/biome check .`
- UFSS data layout 复检：`./node_modules/.bin/nbb --classpath src -e "(require '[herd.ufss :as u]) (u/canonical (vec (range 40)))"`

## 6 文档与变更纪律

- 根 `AGENTS.md` 须经人类操作员明确批准后方可修改；局部文档、源码与 `DEBT.md` 由 AI 直接同步追齐根规格；已批准的人工验收文档不得擅改。
- 宿主实测边界、限制与回滚统一维护在本文件 §5，不再单设 `HACK.md`；历史取舍与被拒方案维护在 `HISTORY.md`。
- 不得把“源码存在”或“窄测通过”写成“已交付/已验收”；不删除用户既有历史资料（`docs/旧的方法论.md`、`docs/旧的架构.md`、`docs/旧的设计.html`、`docs/讨论纪要.md`、`docs/兄弟项目参考.md`）。