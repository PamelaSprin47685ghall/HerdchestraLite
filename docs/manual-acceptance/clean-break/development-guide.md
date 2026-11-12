# Clean-Break 全项目开发指南（S2）

> 状态：S2 草案，唯一产物。本文只写实现架构、模块契约、迁移顺序与验证路径；**没有执行任何 CASE，没有运行 `bun test`/`biome`/构建，没有产生审计分数，没有修改产品代码、根 `AGENTS.md` 或其他文档**。文中所有“验证”段落都是待执行步骤，不是已观察结果。
>
> 依据：`docs/manual-acceptance/clean-break/requirements.md`（S1 已批准）与仓库根 `AGENTS.md`（SSOT，AI 不得改写）。本文是“开发本产品”的 S2 开发指南，不是产品运行时的 `plans/<slug>/s3-dev-guide.md`，也不是 S4 报告。
>
> 写作边界：只新增本文件；不创建 `plans/`、证据目录、测试夹具或产品源码；不把任何设计目标说成已实现事实。DevOps 只读调查的实测事实与规格偏差见 §2.6，未验证项集中列在 §2.6.5。

## 0. 结论摘要

一句话目标：把当前仓库从旧的 `pi-goal-x` / `pi-context` / 编辑器主题垫片实现，整体切换为 `AGENTS.md` 描述的 Lite 运行时；旧依赖、旧入口、旧工具名、猴子补丁与兼容 shim 全部删除，不保留“先走旧路”的隐藏分支。

本指南的六个决定性选择：

1. **入口只留两个**：`src/bootstrap-main.mjs` 与 `src/tool-gate/index.mjs`。主入口只装配，不实现业务；tool-gate 独立注入/准入/剥离，任一个损坏都不阻断另一个。
2. **运行时依赖只留 `cherry-cljs`**。沙箱采用“显式 CEK 状态机 + 白名单符号表 + cherry-cljs 纯函数库”，不暴露 JS 全局，不依赖引擎异步帧来保存续体。
3. **所有控制状态集中在主工作区的 `.herd/`，所有数据面写入集中在 Slice worktree**。Slice worktree 不创建自己的 `.herd/`；冻结契约通过只读根白名单访问，不复制、不漂移。
4. **写入只有一条路径**：`clj_worker` 批内 VFS 预演 → 写锁 `$W$` 内复核 `stamp` 与结构条件 → 同目录临时文件 + `fsync` + `rename`。普通写与 `call` 共用 `$W$`；读取不取锁。
5. **看板与任期是显式状态机**：任务只有 `:ready`/`:waiting`/`:done`；动作、个体、令牌、任期各自有独立生命周期；父项只回 `:ready`；令牌竞争不可逆；死亡身份不能提交。
6. **终局验收是 K 路并发手工审计**：一 CASE 一审计员，主工作区只读，框架汇总 `min(user_score, developer_score)`；全 PASS 才签发绑定 `(mission-id, revision)` 的一次性批准。

旧资产策略：旧代码路径删除；旧用户产物、旧文档、旧验收报告保留只读；根 `AGENTS.md` 的字节内容与 `sha256` 不得由 AI 改动；删除任何共享路径必须单次、具名、可核对。

## 1. 目标、非目标与现状基线

### 1.1 目标

完成后，仓库必须以 `AGENTS.md` 为唯一规格，提供：

- S1 人工批准、S2–S4 自动门禁、S5 蜂群自治与 K 路审计；
- `(defprogram ...)` 沙箱、EDN + UFSS、批内 VFS、`where`/`park`/`unpark`；
- 单 Worktree 看板、拆分优先、父项保留实质、`board_take_or_die` 唯一持令；
- 多 Worktree `fork_slices`/`join_slice`、FIFO、rebase、`--ff-only`、7 天保留；
- Scope 四型、出站投影、阶段简报钉住、缓存断点前移；
- TUI 双态看板、`/herd*` 命令、Esc 递归取消、六窗口重启恢复；
- 失败隔离与显式降级，不静默换模型、不假装能力可用。

### 1.2 非目标

- 不实现独立标准版的 Steward/Standing Sphinx、JVM/Datalevin/Fulcro、跨机器执行。
- 不重写 `docs/` 历史文档的文学内容；不把旧产物迁进产品运行时。
- 不为旧工具名保留别名；不保留旧路径的兼容 shim；不提供 `/herd-pair`。
- 不把自动化测试、CI、构建、覆盖率写成验收证据。
- 不在本阶段实现 S4 协调手册或 S5 报告；本文件只给 S3/S4 可执行的架构与迁移输入。

### 1.3 术语

沿用 `AGENTS.md` §0.2。本文额外区分：

- **产品模块**：`src/` 下由两个清单入口加载的模块。
- **开发验收工具**：只服务 `docs/manual-acceptance/**` 的提交/报告工具，不是产品运行时，不进入 `/herd` 工具面。
- **主工作区**：执行 `/herd` 的仓库根，保存 `plans/<slug>/`、`.herd/`、`.herd-worktrees/`。
- **Slice worktree**：`.herd-worktrees/<slug>/<slice_id>`，只承载该 Slice 的数据面写入；控制状态仍在主工作区。
- **只读契约根**：主工作区的 `plans/<slug>/s1..s4` 与根 `AGENTS.md`；Slice 会话可读，不可写。

### 1.4 现状基线（观察，不是验收）

以下是写作时对工作区的只读观察，用于迁移起点；CASE-39 必须重新证明真实宿主加载路径，不能把本节当作已通过证据。

| 观察 | 证据 | 对迁移的含义 |
|---|---|---|
| `package.json` 仍声明三个入口：`bootstrap-main`、`tool-gate/index`、`bootstrap-editor-theme` | `package.json` 的 `omp.extensions`/`pi.extensions` | 必须删掉主题入口，精确收敛为两个 |
| 运行时依赖仍是 `pi-context@2.3.0`、`pi-goal-x@0.34.1` | `package.json` `dependencies` | 必须删除，只保留 `cherry-cljs` |
| `src/` 仍有 `pi-goal/`、`pi-context/`、`editor-theme/`、`context/`、`manual-acceptance/`、旧 `prompts/` | `src/` 清单 | 产品模块重写；开发验收工具单独迁移 |
| `.gitignore` 目前只有 `.herd-worktrees/`，缺 `.herd/` | `.gitignore` | 必须补 `.herd/`；不得忽略 `plans/` |
| 根 `AGENTS.md` 未被 Git 跟踪 | `git status --porcelain` 显示 `?? AGENTS.md` | 副本/打包必须显式包含；AI 不得改写 |
| 工作区 `.git` 指向外部 gitdir；`git worktree list` 显示 `/home/kunweiz/.cache/herdchestra-lite/gitdir` | `git rev-parse --git-dir --git-common-dir`、`git worktree list` | 不能假设 `/tmp` 副本是独立仓库；worktree 共享 gitdir 必须按真实拓扑处理 |
| `docs/architecture.md`、`docs/design.html`、`docs/methodology.md` 在工作树中已删除；`docs/旧的方法论.md` 等中文文档未跟踪 | `git status --porcelain` | 这些是用户既有改动；不得静默恢复或再次删除；迁移时先问保留策略并记入 `HISTORY.md` |
| 用户只读调查指出宿主当前可能加载 `/home/kunweiz/public/HerdchestraLite` | 用户输入，未由本文件复核 | CASE-01/39 必须先证明加载的是本副本；不能假设 |

根规格的 `sha256` 在迁移开始与结束时各记录一次；除人类操作员明确修改并留证外，任何差异都按阻断缺陷处理。

## 2. 架构总览

### 2.1 设计原则

- **Mise en place**：底层支持库互不依赖，由组合层显式装配；入口只装配，不写业务。
- **信息隐藏**：按“可能独立变化的设计秘密”拆模块，不按执行流程图拆文件。每个模块只隐藏一个变化点。
- **不可变值 + 显式状态**：看板转换、Scope 记账、UFSS 读写、评分汇总、契约解析都是纯函数；“读当前态 → 返回新态”的边界在 I/O 层。
- **消息导向的 Actor 语义**：个体、槽位、任期、令牌、动作是不同身份；跨身份只通过看板与受保护文件提交通信。
- **Poka-yoke**：非法状态在结构上不可表示；冲突在触盘前拒绝；正常路径不设回滚分支。
- **Chesterton's Fence**：旧代码可以删，但旧用户产物、旧文档、旧证据先保留；删除共享路径必须具名、单次、可核对。
- **反懦夫**：迁移失败时向前修复，不用回滚、削范围或退回最近绿色状态代替解决问题。

### 2.2 依赖 DAG

箭头表示“依赖/import”。同一层内不允许反向依赖；`main` 是唯一装配点。

```text
外部：node:fs / node:path / node:crypto / node:child_process
      @oh-my-pi/pi-coding-agent（宿主）
      cherry-cljs（唯一运行时第三方依赖）

H0 host/imports        H2 host/health        U0 util/errors
      │                     │                     │
      ├──────────┬──────────┘                     │
      ▼          ▼                                ▼
H1 host/subprocess   U1 util/atomic-write   U2 util/file-lock
      │                     │                     │
      │                     └──────────┬──────────┘
      │                                ▼
      │                         C3 clj-sandbox/vfs
      │                                │
      ▼                                ▼
C0 ufss     C1 where     C2 evaluator ── C4 clj-sandbox/tools
      ▲          ▲              ▲               ▲
      └──────────┴──────────────┴───────────────┘

Q0 scope/ledger ── Q1 scope/projection
G0 tool-gate/schema ── G1 tool-gate/index

T0 stages/disclosures   T1 stages/parsers   T2 stages/contract
        │                     │                   │
        └──────────┬──────────┴──────────┬────────┘
                   ▼                     ▼
             T3 stages/gate-tools    T4 stages/scores
                   │                     │
                   ▼                     │
B1 swarm/worktree ── B0 swarm/board ◄────┘
                   │        │
                   ▼        ▼
             B2 swarm/runner   B3 swarm/auditors

P0 prompts/common   P1 prompts/roles   P2 prompts/runtime-wires
V0 tui/dashboard-model ── V1 tui/dashboard-widget

M0 main  ── imports everything above（P1 按角色懒加载）
M1 bootstrap-main ── lazy import M0
G1 tool-gate/index ── 独立入口，imports G0/Q0/H2
DA tools/dev-acceptance/* ── 开发验收工具，独立清单，不被 M0/M1/G1 import
```

### 2.3 模块清单

`secret_owned` 写该模块隐藏的变化秘密；`depends_on` 只列直接依赖。该表可直接映射到 S3 协调手册的模块数组。

| ID | 路径 | secret_owned | depends_on |
|---|---|---|---|
| H0 | `src/host/imports.mjs` | 宿主与 `cherry-cljs` 的唯一导入点、版本探测、能力表 | — |
| H1 | `src/host/subprocess.mjs` | 子代理完整 `AgentDefinition`、abort 树、`artifactsDir` 语义 | H0, H2, U0 |
| H2 | `src/host/health.mjs` | 跨入口健康登记与读取 | — |
| U0 | `src/util/errors.mjs` | 错误码、EDN 诊断形状、因果链 | — |
| U1 | `src/util/atomic-write.mjs` | 同目录 `.tmp` + `fsync` + `rename` | U0 |
| U2 | `src/util/file-lock.mjs` | `wx` 排他锁、`agent_id`/`term_id` 判活、PID 辅助、陈旧锁、锁序断言 | U0, U1 |
| C0 | `src/clj-sandbox/ufss.mjs` | 自建 EDN + UFSS 读取器与确定性打印器 | U0 |
| C1 | `src/clj-sandbox/where.mjs` | UTF-16 精确切片、候选上限、Ukkonen 最近行 | U0 |
| C2 | `src/clj-sandbox/evaluator.mjs` | 自建 Promise-CPS 解释器、白名单符号表、异步 CEK、续体、期限；Cherry 仅数据运行时 | C0, C1, H0, U0 |
| C3 | `src/clj-sandbox/vfs.mjs` | 批内 VFS、纳秒 `stamp`、`$W$` 提交流水线 | U0, U1, U2 |
| C4 | `src/clj-sandbox/tools.mjs` | 角色能力矩阵、`clj_*` 工具面、`call` 边界 | C2, C3, C1, C0 |
| G0 | `src/tool-gate/schema.mjs` | 五类传输 Schema 注入、幂等、`$ref` 跳过 | U0 |
| G1 | `src/tool-gate/index.mjs` | 注入/准入/剥离入口、裸工具封禁 | G0, Q0, H2, U0 |
| Q0 | `src/scope/ledger.mjs` | Scope 四型、预算、归档、`ask_previous_scope`/`assume` | U0 |
| Q1 | `src/scope/projection.mjs` | 出站裁剪、简报钉住/退役、双块锚点、缓存断点 | Q0, U0 |
| T0 | `src/stages/disclosures.mjs` | S1–S5 简报文本 | — |
| T1 | `src/stages/parsers.mjs` | S1–S4 结构校验、CASE 解析、模块/Slice DAG | U0 |
| T2 | `src/stages/contract.mjs` | `mission.edn`、四哈希冻结/重对齐、批准凭证 | U0, U1, U2 |
| T3 | `src/stages/gate-tools.mjs` | `advance_s1..s4` 事务、`ask_user`、`devops`、`submit_review` | T0, T1, T2, H1, H2, B1, U0 |
| T4 | `src/stages/scores.mjs` | 审计汇总、`s5-report.md`、一次性批准 | T1, T2, U1, U0 |
| B0 | `src/swarm/board.mjs` | 看板短事务、任务/动作/个体/令牌、责任集合 | U0, U1, U2 |
| B1 | `src/swarm/worktree.mjs` | worktree 生命周期、FIFO join、rebase/`--ff-only`、GC | U0, U2, T2 |
| B2 | `src/swarm/runner.mjs` | 任期双相、槽位转世、Quiescence、Nudge、Oracle、恢复 | B0, B1, T2, H1, H2, U0 |
| B3 | `src/swarm/auditors.mjs` | K 路审计隔离、主工作区快照、返工派生 | B0, T1, T2, T4, H1, H2, C4, U0 |
| P0 | `src/prompts/common.mjs` | `COMMON_RULES` 规范文本（无 S2–S5 剧透） | — |
| P1 | `src/prompts/roles.mjs` | 角色提示词、`buildCaseAuditorPrompt` | — |
| P2 | `src/prompts/runtime-wires.mjs` | 语言后缀、Nudge、tool-gate 字段定义 | — |
| V0 | `src/tui/dashboard-model.mjs` | 纯数据看板/审计矩阵模型 | U0 |
| V1 | `src/tui/dashboard-widget.mjs` | 双态渲染、稳定高度、文本降级 | V0, H0, H2, U0 |
| M0 | `src/main.mjs` | 装配、命令适配、阶段生命周期、模型选择 | 全部产品模块 |
| M1 | `src/bootstrap-main.mjs` | 入口 1 的惰性加载与失败隔离 | M0, H2 |
| DA | `tools/dev-acceptance/*` | 开发验收三份文档 + 报告的提交与原子写 | U1（只读复用） |

### 2.4 角色、工具面与模型

| 角色 | 宿主形态 | 工具面（硬边界） | 模型 |
|---|---|---|---|
| `Coordinator` | 主会话 | 命令、看板 TUI、`fork_slices`/`join_slice`、审计调度、`ask_user`（仅 S5 初任空账例外）；不直接改业务源码 | 主模型 |
| `Plan` | 主会话（S1–S4） | `clj_plan`（只读契约/附件、`where`/`whereAll`/`park`/`unpark`）、`devops`、`ask_user`（仅 S1）、`advance_s1..s4`、Scope 辅助；无 `write`/`edit`/`bash`/`call` | 主模型 |
| `Plan DevOps` | `runSubprocess` | `clj_devops`（`cat`/`stat`/`ls`/`where`/`whereAll`/`park`/`unpark`/只读 `call`）、`submit_devops_report`；无看板、无写方法 | `@task` |
| `Reviewer` | `runSubprocess` | `clj_review`（`cat`/`stat`/`ls`/`where`/`whereAll`/`unpark`）、`submit_review`、Scope 辅助；无写、无 `call`、无 `park` | 主模型 |
| `Swarm Worker` | `runSubprocess` 固定槽位 | `clj_worker`（无 `call`）、`board_*`、Scope 辅助 | `@task` |
| `Swarm Holder` | `runSubprocess`（每 worktree 至多 1） | 同 Worker，另加 `clj_worker` 的 `call` 与 `abandon_slice` | `@task` |
| `Manual Auditor` | `runSubprocess`，独立可见 | `clj_auditor`（只读主工作区、`tmux` 抓屏、`/tmp` 隔离、证据写入）、`submit_case_audit`；禁止 spawn | 主模型 |
| `Blocker Oracle` | `runSubprocess` 只读 | `clj_review` 只读子集、`submit_oracle_advice` | 主模型 |

模型归属是硬边界：主模型负责判断与验收；`@task` 模型负责施工与调查。模型不可用时明确失败，不静默降级。

### 2.5 跨入口共享状态

两个清单入口在同一宿主进程内加载，但不能假设 ESM 模块实例一定共享。以下三个只读/半只读 rendezvous 统一放在 `globalThis[Symbol.for(...)]`，键名固定、只由产品代码访问，沙箱符号表不可见：

| 键 | 写入者 | 读取者 | 用途 |
|---|---|---|---|
| `herdchestra.health.v1` | H2 | M0、G1、V1、`/herd-status health` | 入口状态、能力探测、降级原因 |
| `herdchestra.scope.v1` | Q0（G1/M0 均可调用） | Q0、Q1、G1 | 每 `sessionId`/`agentId` 的 Scope 账本 |
| `herdchestra.mission.v1` | M0（`session_start`、阶段切换） | G1、M0 | 当前使命 `{active, slug, stage, worktree, role}`；磁盘 `mission.edn` 仍是权威 |

规则：这些注册表只是缓存；磁盘状态优先。入口加载顺序不确定时，G1 在使命未激活前 fail-open（允许宿主正常工具），使命激活后 fail-closed（裸工具与未注解调用拒绝）。M0 必须在第一个模型回合前写入 mission 注册表。

### 2.6 DevOps 实测事实、规格偏差与 Spike 门槛

本节来自 DevOps 第二轮只读调查（`agent://devops`），是当前机器的实测事实与条件性结论，不是本指南执行验收的结果，也不替代 CASE-01/33/39 的重新证明。事实会随宿主/依赖版本变化；S3 冻结前必须用同一组 Spike 复核。

#### 2.6.1 宿主事实

| 事实 | 实测内容 | 对架构的影响 |
|---|---|---|
| 宿主版本 | **存在多个候选，不能用一个版本号当跨版本契约**：DevOps 读到的运行时路径是 `@oh-my-pi/pi-coding-agent@17.3.5`（CLI `omp 18.16.0`）；HostApiScout 找到全局包 `16.1.22`、Bun 缓存 `18.12.4`、npm 固定包 `18.16.0`，但没有本地 18.16.0 `dist/types`；磁盘自动更新日志到 `18.18.8`；README 写 18.18.6；工作区 `node_modules/@earendil-works/pi-coding-agent@1.5.2` 不是 omp 运行时 | H0 先 `realpath` + 读实际包 `package.json`，记录 CLI/运行时包/类型包三元组；所有能力逐项探测；CASE-33 以行为而非版本号判定 |
| `before_agent_start` | 18.16.0：event `{reason: "prompt" \| "revive", prompt, images?, systemPrompt: string[]}`；handler 返回 `{systemPrompt?: string[]}`，多 handler 链式追加。18.12.4 类型没有 `reason` | M0 必须返回 `string[]`；读取 `event.reason` 时缺失按 `"prompt"` 处理，不写成跨版本事实 |
| `tool_call` | 18.12/18.16 支持 `{block, reason, input}`；16.1.22 只有 `{block, reason}`。返回的 `input` 是工具实际执行的原始参数，不是 `event.input` 的规范化视图；多 handler last-wins，且每个 handler 看到原始 `event.input` | G1 构造剥离后的新对象返回，不得原样回传 `event.input`；消费者按“已剥离”语义工作；旧 `rawToolArguments` 假设必须重测；16.x 只注入不剥离 |
| `tool_execution_end` | `{toolCallId, toolName, result, isError}` | M0 用它记账/分类，不依赖 `tool_result` |
| `agent_end` / `turn_end` | `agent_end` 带 `messages`、`willContinue?`、`awaitingAsyncWork?`；`turn_end` 带 `turnIndex`、`message`；两者谁适合 Nudge 未定 | B2 先做 Spike，不凭直觉二选一；Nudge 用 `sendMessage({triggerTurn:true})`，不用 `sendUserMessage` 伪装用户输入 |
| `ctx.agent` / `before_subagent_spawn` | 实际 17.3.5 运行时没有 `ctx.agent`；18.16.0 的 52 个事件名包含 `before_subagent_spawn`，但 17.3.5 是否支持未证实 | 不能按 `ctx.agent.kind` 识别角色，也不能把 `before_subagent_spawn` 当跨版本事实；统一用父进程 role token + `AgentDefinition.tools` + `setActiveTools` |
| `setActiveTools` | 返回 `Promise<void>`；只选择“启用工具名集合”，忽略未注册名字；不注册/注销工具；`defaultInactive` 工具需注册方显式激活 | M0/G1 必须 `await`；`registerTool` 先完成，再 `setActiveTools`；不得用 `setActiveTools` 代替注册 |
| `ctx.signal` | **不确定**：DevOps 报告称源码有 `signal: AbortSignal \| undefined`；HostApiScout 在 18.16.0 `ExtensionContext` 未找到 | 不作为跨版本事实；取消以工具 `execute` 第 3 参数、父级 `runSubprocess.signal`、`AbortController` 树为主 |
| `sessionManager` | `getSessionFile()`、`getArtifactsDir()`、`getBranch()`、`getEntries()`、`getSessionId()` 是公开只读 API | H1 不猜 artifacts 路径；`getContextUsage()` 公开，删除原型补丁 |
| `runSubprocess` | 必填 `cwd`、完整 `AgentDefinition`、`task`、`index`、`id`；可选 `assignment`、`signal`、`outputSchema`、`outputSchemaMode`、`artifactsDir`、`eventBus`、`settings`、`modelRegistry`、`modelOverride`、`parentActiveModelPattern`、`restrictToolNames`、`maxRuntimeMs`、`enableMCP/Lsp/Irc`。从 `/task/executor` 或包根导入，不从 `/task` 导入 | H1 只暴露稳定面；新增字段按实际源码逐个探测；缺 `index`/`id` 不得启动 |
| `runSubprocess.sessionFile` | `artifactsDir` 存在时，子会话文件固定为 `artifactsDir/<id>.jsonl`；`sessionFile` 不参与该路径，只用于 follow-up | 不得把 `sessionFile` 宣传为父链接；Agent Hub 可见性靠 `eventBus`；无 `artifactsDir` 明示“仅内存可见” |
| `runSubprocess.settings` | `options.settings ?? Settings.isolated()`；`Settings.instance` 未初始化会 throw | 必须传 live `Settings`；不能静默使用 isolated；缺 settings 明确失败 |
| `runSubprocess.model` | `modelOverride`/`agent.model`/`modelRegistry`；结果有 `resolvedModelIsFallback` | 主角色 pin `ctx.model`；Worker/Holder 用 `@task`；检测 fallback，未授权 fallback fail-closed |
| `AgentDefinition` | 必填 `name`、`description`、`systemPrompt`、`source`（`"bundled" \| "user" \| "project"`）；`tools`/`spawns`/`model`/`output` 可选；`model` 是 `string[]`，不是单个字符串 | H1 自建完整定义，不按名字依赖 bundled `task`；`source` 取值在 S3 固定 |
| 子代理并发 | `runSubprocess` 是进程内执行，所有子代理共享同一个 OS PID | 仅靠 PID 判活无法识别已死子代理；U2/B2 必须按 `agent_id`/`term_id`/runner 内存状态对账 |
| 子代理产物 | `artifactsDir` 被 DevOps 报告为 transcript 落盘唯一开关；子会话文件为 `artifactsDir/<id>.jsonl`；HostApiScout 未在类型声明中核实“唯一开关” | B3/H1 必传 `artifactsDir`；CASE-23 实测；`sessionFile` 父链预期按实际行为改测 |
| 角色工具面 | 无 `ctx.agent`；可用 `AgentDefinition.tools`、`restrictToolNames`、`setActiveTools`、`enableMCP/Lsp/Irc` | H1/B2 用父进程 role token + 显式工具列表；审计员/V2 禁 MCP/LSP/IRC |
| 宿主 TUI | 公开 `ctx.ui.setWidget(key, content, {placement?})` 支持 `string[]` 或组件工厂 `(tui, theme) => Component`；字符串数组最多 10 行；默认 `aboveEditor`；`registerShortcut`、`onTerminalInput` 可用。`setHookWidget` 只在宿主内部，不在 `ExtensionUIContext` | V1 只用 `setWidget`，**不得调用 `setHookWidget`**；Esc/IME 用 `onTerminalInput`；不猴补丁 TUI 原型 |

**版本不确定性**：上述候选版本中，没有任何一个本地 `dist/types` 可以单独作为全部契约。实现必须：

1. 启动时解析实际入口 `import.meta.url` 与运行时包 `package.json`，把 `cliVersion`、`runtimePackageVersion`、`typesPackageVersion` 写入 H2/`HACK.md`。
2. 逐项能力探测，不按版本号分支；同一能力在不同版本可能形状不同（`before_agent_start.reason`、`tool_call.input`、`ctx.signal`、`before_subagent_spawn`）。
3. 以 18.12.x 为规格目标，但 18.16.0 实测优先；16.1.x 只做降级桩，不承诺 18.x 独有字段。
4. `@earendil-works/pi-coding-agent@1.5.2` 的类型不得作为宿主契约；它只是旧插件的 peer 依赖。

#### 2.6.2 cherry-cljs 事实

| 事实 | 实测内容 | 对架构的影响 |
|---|---|---|
| 版本与导出 | `cherry-cljs@0.6.38`；入口只导出 `compileString`/`compileStringEx`；`cljs.core.js` 导出 Keyword、PersistentVector/HashMap/HashSet、map/mapv/filter/reduce/str/subs/pr_str 等约 500 个运行时符号 | 不能用 Cherry 的 EDN reader；C0 自建 EDN+UFSS reader |
| 无 EDN reader | 没有公开 `read-string`/`read`/EDN reader API；`clojure.string/set/walk` 在 `lib/` 可用 | C0 自己实现 EDN 读取；C2 只把 Cherry 当数据/纯函数运行时 |
| `defprogram` | 不是 Cherry 特殊形式；`compileString('(defprogram p [] ...)')` 把 `defprogram` 当普通函数调用 | C2 自建 `defprogram` 特殊形式；不能把 Cherry 编译作为主路径 |
| 无自动 await | 能力调用编译成普通 `cat.call(...)`；只有显式 `(js-await ...)` 生成 `await`；`mapv` 回调里的 `js-await` 生成非法 JS | C2 自建 Promise-CPS 解释器；异步高阶函数由解释器逐个顺序 await，不依赖 Cherry 编译 |
| `park`/`unpark` | 普通函数调用，无挂起语义 | C2 自建续体；不能把 Cherry 的 `park` 当能力 |
| 稳定性 | README 明确写 experimental、not recommended for production、many bugs/breaking changes | `HACK.md` 记录；S3 冻结前用 Spike 证明；失败时沙箱不可用但不回退 JS 全局 |

**决定**：C2 采用“自建 Promise-CPS 的 ClojureScript 子集解释器 + Cherry 仅作不可变数据/纯函数运行时”。不把 Cherry 编译路径写入主路径；只有 §2.6.4 的编译 Spike 全部通过，才允许在 S3 作为可选快路径评估，且必须保留解释器为默认。

#### 2.6.3 与根规格/已批准 S1 的偏差

以下偏差必须准确记录，**不得修改根 `AGENTS.md`，不得修改已批准的 `requirements.md`，不得声称已解决**。处理方式写入 `HACK.md`/`DEBT.md`，由人类决定是否修订规格。

| 偏差 | 根规格/ S1 的说法 | 实测 | 当前处理 |
|---|---|---|---|
| Cherry EDN reader | `AGENTS.md` §1.2 预期 `cherry-cljs` 提供 EDN Reader | 0.6.38 无公开 EDN reader | C0 自建 reader；`HACK.md` 记录；规格修订待人类决定 |
| Cherry 异步序列 | `AGENTS.md` §4.1 要求高阶序列函数支持异步顺序求值 | Cherry 不自动 await；`mapv` + `js-await` 非法 | C2 解释器提供 async-aware HOF；不走 Cherry 编译 |
| `defprogram` | 规格把它当沙箱程序形式 | Cherry 当普通函数 | C2 自建特殊形式；Spike 验证 |
| 宿主版本 | `AGENTS.md` §1.2 目标 18.12.x；S1 记录本机 `omp 18.16.0` | 运行时可能是 17.3.5（DevOps 路径）；全局 16.1.22、Bun 缓存 18.12.4、自动更新 18.18.8；本地无 18.16.0 JS/types；仓库 `@earendil-works` 1.5.2 不是运行时 | 运行时 `realpath` + `package.json` + 能力探测；CASE-33 记录；基线待人类确认 |
| `before_agent_start` 形状 | `AGENTS.md` §1.2 写返回 `{systemPrompt}` | 18.16/18.12 类型是 `systemPrompt: string[]`；18.16 另有 `reason` | M0 返回 `string[]`；`reason` 缺失按 `"prompt"`；`HACK.md` 记录 |
| TUI 挂载 | `AGENTS.md` §6.1 写优先 `setWidget` / `setHookWidget` | `setHookWidget` 不在 `ExtensionUIContext`；只用 `setWidget` | V1 只调 `setWidget`；`HACK.md` 记录 |
| 工具常驻/入口加载 | `AGENTS.md` 未写 `loadMode` | 18.x `loadMode:"essential"` 可能让根入口工具常驻；开发验收入口不能进根 `omp.extensions` | DA 单独链接/独立 HOME；CASE-39 验证 |
| `ctx.agent` | 规格把 18.x 的 `ctx.agent` 列为可选 | 实际 17.3.5 没有 | role token + 显式 `AgentDefinition.tools` |
| `sessionFile` | 规格把它当父会话链接 | `artifactsDir` 存在时被忽略 | 用 `artifactsDir/<id>.jsonl` + `eventBus`；不宣传父链 |
| 锁判活 | 规格用 PID 存活检测陈旧锁 | 子代理同 PID，PID 判活无法发现死子代理 | 锁记录 `agent_id`/`term_id` + runner 状态对账；PID 只作跨进程辅助 |
| 工作树依赖 | 规格要求 Slice worktree 可读契约 | worktree 不带未跟踪 `AGENTS.md`/`plans/`，也不带 `node_modules` | C3 只读根白名单；B1 显式 `git -C`/`--show-toplevel`；`call` 不得假设 node_modules 存在 |
| S1 版本问题 | `requirements.md` §8 #3 写“cherry 精确版本/导出未验证” | 已实测 0.6.38；导出受限 | 记录事实；S1 保持已批准原文，不回写；S3/S4 按实测执行 |
| S1 `sessionFile` 预期 | `requirements.md` CASE-23 要求父会话 `sessionFile` 作为父链接 | 实际被 `artifactsDir` 覆盖 | CASE-23 的证据按实际行为记录；若产品无法满足父链，按缺陷记录，不伪造 |

#### 2.6.4 Spike 门槛（S3 冻结前）

以下 Spike 不是验收 CASE；它们是 S3 模块设计的前置事实检查。任一失败，先修复设计或记录 `DEBT.md` 并取得人类确认；不得把未通过的 Spike 写成通过。

**Host Spike**

1. 两个入口在真实 `omp` 中加载；`/herd-status health` 报出实际包版本/CLI 版本/能力。
2. `before_agent_start` 返回 `string[]` 后系统提示词正确追加。
3. `tool_call` 返回 `{input}` 后，底层 `execute` 收到剥离字段，持久化/显示参数符合预期；同步验证旧 `rawToolArguments` 路径；16.1.22 无 `{input}` 时只注入不剥离。
4. `setActiveTools` 被 `await` 后，角色工具面在下一次模型请求生效。
5. role token + `AgentDefinition.tools` + `restrictToolNames` 能阻止子代理越权；无 token 的子会话 fail-closed。
6. `runSubprocess` 传 live `Settings`、`artifactsDir`、`eventBus`、`maxRuntimeMs`；无 `artifactsDir` 时回执明示内存可见；`resolvedModelIsFallback` 可见；`sessionFile` 在 `artifactsDir` 下被忽略的行为已记录。
7. `agent_end` 与 `turn_end` 二选一完成 Nudge 触发 Spike；不叠加宿主 auto-retry。
8. `ui.setWidget` 组件工厂、`onTerminalInput`、`registerShortcut` 在 tmux 中可用；`setHookWidget` 不调用；缺失时文本降级。
9. `loadBundledAgents` 从 `/task/agents` 导入；`runSubprocess` 从 `/task/executor` 或包根导入；不从 `/task` 导入。

**Sandbox Spike**

1. `defprogram` 定义/调用/返回值。
2. `let`/`loop`/`recur` 内能力调用按顺序 await。
3. `map`/`mapv`/`filter`/`reduce`/`doseq` 对 async 能力逐个顺序求值。
4. `where` 0/多匹配挂起，`unpark` 后局部变量与 VFS 完整恢复。
5. 异常/park 时真实磁盘零修改。
6. `js/*`、`globalThis`、`process`、`Bun`、`require`、`import`、`eval`、`read-string`、`load-string` 全部 `:CAPABILITY_DENIED`。
7. 生成/执行的代码不能访问宿主文件系统或网络。
8. 100 KiB 文本与 256 路径操作的性能/内存可接受。

**Lock Spike**

1. 同一 PID 下两个子代理，一个 abort/死亡后，另一个仍持有锁；U2 能按 `agent_id` 识别死者锁并拒绝/清理。
2. runner 在死亡/退休/abort/槽位终止的同一 `finally` 中释放锁；事件账本记录 acquire/release。
3. 跨进程（两个宿主）时，PID 判活仍能识别真实进程死亡；两种判据不互相冒充。

**Git Spike**

1. 从共享 gitdir 创建 `.herd-worktrees/<slug>/<slice_id>`，`git -C` 与 `--show-toplevel` 校验通过。
2. worktree 内无未跟踪 `AGENTS.md`/`plans/`/`node_modules`；C3 只读根白名单仍能读到主工作区契约。
3. `join` 的 rebase + `--ff-only` 在共享 gitdir 下成功；失败路径可 abandon。

#### 2.6.5 待验证清单

以下内容在本文中仍属“待验证”，不得当成已实现或已验收事实：

| 项 | 已知 | 待验证方式 |
|---|---|---|
| 实际运行宿主版本 | 候选 17.3.5/18.16.0/18.12.4/16.1.22；本地无 18.16.0 JS/types | CASE-33/39 运行时 `realpath` + `package.json` + 能力探测 |
| `tool_call {input}` 持久化 | 18.x 支持，16.1.22 不支持；返回 input 会进入持久化/显示/执行 | CASE-34/39 捕获底层参数、branch、显示与审批输入 |
| `agent_end` vs `turn_end` | 两者都可能触发；`agent_end` 有 `willContinue`/`awaitingAsyncWork` | CASE-30 Nudge Spike |
| `settings`/`artifactsDir`/`sessionFile` | DevOps 报告 settings 默认 isolated、artifactsDir 决定 transcript、sessionFile 被忽略；类型未完全核实 | CASE-23/33 运行证据 |
| `resolvedModelIsFallback` | 结果字段存在 | CASE-33 模型不可用/fallback 分支 |
| Cherry 0.6.38 行为 | DevOps 实测无 EDN reader、无自动 await、`defprogram` 普通函数、`mapv` 异步非法 | §2.6.4 Sandbox Spike + CASE-11–14 |
| 同 PID 子代理锁 | 所有子代理共享 OS PID | §2.6.4 Lock Spike + CASE-28 |
| worktree 无 node_modules | 实测 worktree 不带未跟踪文件/依赖 | CASE-21/37/39 |
| `loadMode:"essential"`/DA 自动加载 | 18.x 可能常驻；嵌套 package 不随根链接加载 | CASE-01/39 隔离 HOME |
| `before_agent_start.reason` | 18.16 有，18.12 无 | CASE-02/33 出站/能力探测 |
| `ctx.signal` | DevOps 与 HostApiScout 结论不一致 | CASE-29/33 取消传播 |
| `setHookWidget` | 公开类型没有，只在宿主内部 | CASE-27/33 只用 setWidget |
| 根规格/S1 与实测偏差 | 见 §2.6.3 | 人类裁决；不修改已批准 S1 |

## 3. 模块契约

本节给出每个模块的公开接口、状态、不变量与失败语义。接口名是设计契约；实现可以在不改变语义的前提下调整参数打包方式，但不得改变错误码、状态词与所有权边界。

### 3.1 宿主与工具层

#### H0 `src/host/imports.mjs`

公开：

```js
export const host = Object.freeze({ AgentSession, Settings, runSubprocess, loadBundledAgents, piTui });
export async function loadCherry();          // -> {ok, cherry, version, error?}
export function detectCapabilities(pi);      // -> 能力表，见 §2.6.1
```

- 所有外部包 import 只在此文件出现；其他模块不得直接 import `@oh-my-pi/*` 或 `cherry-cljs`。
- **版本事实**：当前机器 CLI 是 `omp 18.16.0`，实际运行时包是 `@oh-my-pi/pi-coding-agent@17.3.5`；仓库 `node_modules/@earendil-works/pi-coding-agent@1.5.2` 不是运行时契约。H0 以实际包源码/类型为准，版本三元组写入 H2 与 `HACK.md`。
- `detectCapabilities(pi)` 至少返回：`hostPackageVersion`、`cliVersion`、`hasToolCallInput`、`hasCtxAgent`、`hasBeforeSubagentSpawn`、`hasTurnEnd`、`hasSetWidget`、`hasHookWidget`、`hasOnTerminalInput`、`hasRegisterShortcut`、`hasSetActiveTools`、`hasEventBus`、`hasArtifactsDir`、`hasModelRegistry`、`hasSessionFile`、`hasSettingsInstance`、`hasRestrictToolNames`、`cherryLoaded`、`cherryHasEdnReader`。
- `runSubprocess` 只依赖实测稳定面：`cwd`、完整 `AgentDefinition`、`task`、`assignment`、`index`、`id`、`signal`、`outputSchema`、`outputSchemaMode`、`artifactsDir`、`eventBus`、`settings`、`modelRegistry`、`modelOverride`、`parentActiveModelPattern`、`restrictToolNames`、`maxRuntimeMs`、`enableMCP`/`enableLsp`/`enableIrc`。`sessionFile` 只作 follow-up 链接，不是子会话路径。
- `loadBundledAgents` 优先 `@oh-my-pi/pi-coding-agent/task/agents` 的命名导出；缺失时回退 `task.BUNDLED_AGENTS`；两者都缺失时返回 `undefined`，不得按名字假设内置 agent 存在。
- `loadCherry()` 惰性加载并缓存；失败返回 `{ok:false, error}`，不抛到宿主主循环。加载成功后必须标注 `cherryHasEdnReader: false`（0.6.38 无公开 EDN reader），调用方不得假设有。
- 能力探测只读，不修改宿主对象；不得读取 `_goalCore`、不得猴补丁原型。
- 失败：导入失败由入口 catch 并写 H2；模块本身不静默换实现。

#### H1 `src/host/subprocess.mjs`

公开：

```js
export async function spawnAgent({
  name, role, roleNonce, prompt, cwd, tools, outputSchema, outputSchemaMode,
  signal, artifactsDir, sessionFile, eventBus,
  model, settings, timeoutMs, maxRuntimeMs, spawns,
  restrictToolNames, enableMCP, enableLsp, enableIrc
});
// -> {ok, agentId, result, abort, memoryOnly, resolvedModel, resolvedModelIsFallback, error?}
export function abortTree(handle, reason);
```

- `agent` 必须是完整 `AgentDefinition`，至少含 `name`、`description`、`systemPrompt`、`source`（`"bundled"`/`"user"`/`"project"` 之一，S3 固定）、`tools`、`spawns: undefined`、`model`；不得只传 agent 名字。
- 角色识别用父进程生成的 `roleNonce` 与 `[HERD_ROLE: <role> nonce=<nonce>]` 首行；子会话 `before_agent_start` 只接受父进程登记过的 nonce；无有效 nonce 时 fail-closed，不默认成 Plan。实际宿主没有 `ctx.agent`/`before_subagent_spawn`。
- `spawns` 默认 `undefined`；审计员/Reviewer/DevOps 不自动获得 `task` 工具。
- `restrictToolNames: true` 与 `enableMCP: false`/`enableLsp: false`/`enableIrc: false` 用于审计员/只读角色，防止工具面外的 MCP/网络/LSP 绕过；具体默认按角色矩阵。
- 父级 `signal` + 超时 controller + 本会话 controller 合并为一个 `AbortSignal`；取消递归传播。`ctx.signal` 在 18.16 类型中未找到，不能作为跨版本事实，只作辅助。
- `artifactsDir` 被 DevOps 报告为 transcript 落盘的唯一开关（类型声明未核实）；存在时子会话文件固定为 `artifactsDir/<id>.jsonl`，`sessionFile` 被忽略；缺失时回执必须带 `memoryOnly: true` 与“仅内存可见”文本，不得假装 `history://` 可重放，也不得把 `sessionFile` 宣传成父链。
- `settings` 必须传 live `Settings`；不传会落到 `Settings.isolated()` 并丢 `@task` 模型/用户配置。`Settings.instance` 未初始化时明确失败，不静默降级。
- 模型：主角色 pin 当前 `ctx.model`；Worker/Holder 用 `@task` 角色；检查返回的 `resolvedModelIsFallback`，未授权 fallback fail-closed。
- `outputSchemaMode` 对审计提交用 strict；`yield` 必须存在：审计员先 `submit_case_audit` 再 `yield` 最小确认，或把审计字段作为 yield schema；S3 固定一种并测试。
- 子代理是进程内执行，所有子代理共享同一个 OS PID；`agent_id` 必须每次新生 UUID，绝不复用 slot/agent 作为会话 id，避免 `AgentLifecycleManager` 复活旧会话。
- 启动失败返回 `:AGENT_SPAWN_FAILED`，并保留槽位与责任；不得把任务静默丢失。
- 名字约定：`PlanDevOps-<slug>-<tenure>`、`Reviewer-<slice>-<tenure>`、`Worker-<slice>-<slot>`、`Holder-<slice>-<term>`、`Auditor-<slug>-<case_id>`、`Oracle-<slice>-<fingerprint8>`。

#### H2 `src/host/health.mjs`

公开：

```js
export function recordHealth(entry);   // {entry, status, version, capabilities, degraded, error}
export function readHealth();          // -> {entries: [...], updatedAt}
```

- 使用 §2.5 的全局键；不写磁盘；`/herd-status health` 再把内存快照与 `.herd/` 一致性检查合并。
- 任何记录失败都不得抛到宿主；健康报告宁可缺项，不可阻断使命。

#### U0 `src/util/errors.mjs`

公开：

```js
export function herdError(code, message, data = {}, cause);
export function isHerdError(value);
export function renderError(error);    // EDN + UFSS 文本
```

- 错误必须有 `:code`、`:message`、`:data`；`data` 至少包含路径/期望值/当前值/下一步中的相关项。
- 错误码大小写与 `AGENTS.md` §10.3 一致；新增码必须在 `src/AGENTS.md` 与 `DEBT.md` 登记。
- 禁止把原始异常字符串直接投给模型；必须归一化为 EDN。

#### U1 `src/util/atomic-write.mjs`

公开：

```js
export function writeFileAtomic(dir, name, data);   // -> {path, existed}
export function writeEdnAtomic(path, value);
```

- 同目录 `.tmp-<uuid>`；写完整字节；`fsync` 文件；`rename` 目标；不得跨目录 rename；不得先截断目标。
- 失败：抛出带 `stage` 的错误；目标保持完整旧内容；最多留下一个 `.tmp`。
- 正常路径不删除旧目标后再写；不提供“覆盖一半再补”的入口。

#### U2 `src/util/file-lock.mjs`

公开：

```js
export function acquireLock(path, meta);     // meta: {lock_id, purpose, slice_id, owner_agent_id, owner_term_id, pid, started_at, host, token}
export function inspectLock(path, {agentState}); // -> {exists, content, alive, stale, reason}
export function releaseLock(handle);
export function withLock(path, meta, fn);
export function assertLockOrder(ranks);      // integration=0, writeW=1, board=2
```

- `wx` 原子创建；锁内容原子写；不得“先删再建”。
- **同 PID 事实**：`runSubprocess` 子代理与主进程共享 OS PID，仅靠 `process.kill(pid, 0)` 无法识别“子代理已死但主进程仍活”。`inspectLock` 必须先查 runner 的 `agent_id -> life_state`（`:alive`/`:dead`/`:terminated`），再查 PID；任一判据显示 owner 已死即可标 `stale`。
- 锁记录至少含 `lock_id`、`purpose`、`slice_id`、`owner_agent_id`、`owner_term_id`、`pid`、`started_at`、`host`、`token`；跨进程时 PID 仍作辅助，但不得冒充 agent 级判据。
- 30 秒内未释放且 owner 已死才可标陈旧；清理只经 `/herd-recovery repair` 或用户确认，并先备份锁内容。
- `releaseLock` 必须在动作完成、agent 死亡、任期退休、abort、槽位终止的同一 `finally`/事务中调用；看板事件记录 acquire/release。
- `releaseLock` 校验 token，避免删除他人新锁。
- `assertLockOrder` 在每次多锁获取前断言；反向顺序立即抛实现缺陷，不得容错。

### 3.2 ClojureScript 沙箱

#### C0 `src/clj-sandbox/ufss.mjs`

公开：

```js
export function readUfss(text);                 // -> value，失败抛带 line/column 的错误
export function printUfss(value, {indent = 0}); // -> string
export function renderReceipt(value);           // -> EDN 文本 + "\n"
```

- 读取器接受：标准 EDN 字符串、`#^n"..."#^n` 单行原始围栏、`"""..."""`、`#^n"""..."""#^n` 多行块；拒绝缩进不足与未闭合围栏。
- **自建 EDN 读取器**：`cherry-cljs@0.6.38` 不提供公开 EDN reader；C0 必须自己解析 EDN（keyword/symbol/vector/map/set/list/数字/布尔/nil/字符串/注释/逗号空白），再用 UFSS 扩展字符串词法。不得调用 Cherry 的 `read-string`（不存在），也不得把 EDN 解析交给 `eval`/`Function`。
- 打印器按 `AGENTS.md` §5.5.2 的确定性阶梯：控制字符回退标准转义；单行含 `"`/`\` 提升 `n`；多行含 `"""`/`\` 提升 `n`；每行按当前缩进前置。
- 双射不变量：`readUfss(printUfss(s)) === s`；尾随换行、`\r`、`\0`、Tab、中文、emoji、100 KiB 长文本都必须成立。
- 错误码：`:UFSS_INDENT_VIOLATION`、`:UFSS_UNCLOSED`；带精确位置，不静默吞字。
- 禁止把 JSON 转义噪音泄漏到工具回执正文。

#### C1 `src/clj-sandbox/where.mjs`

公开：

```js
export function findUnique(content, needle);
// -> {kind:"unique", span:[b,e]}
//  | {kind:"ambiguous", candidates:[{span, context}], truncated?}
//  | {kind:"none", nearest:{span,text,distance}|null, budgetExhausted:boolean}
export function findAll(content, needle);       // -> [[b,e], ...]
```

- 纯字符匹配，不 trim、不忽略缩进、不把 needle 当正则；偏移是 UTF-16 码元，可直接 `subs`。
- 多匹配最多 8 条候选，每条上下文前后各 80 个 UTF-16 码元；`where` 多匹配自动挂起。
- 零匹配：扫描前 2000 个非空行；`K=64`；先裁剪公共前后缀；DP 单元预算 10M；取最小编辑距离；`:text` 最多 200 字符并标 `:truncated`；无行在带宽内则 `nearest=null`。
- `whereAll` 返回全部区间；0 匹配返回 `[]`，不挂起。

#### C2 `src/clj-sandbox/evaluator.mjs`

公开：

```js
export function createSandboxSession({agentId, role, capabilities, roots, limits});
export async function runProgram(session, {name, code, intent, callId});
export async function unpark(session, {name, value, intent, callId});
export function parkedNames(session);
export function abortSession(session, reason);
```

状态：每个 `agentId` 一张 `Programs` 表，键为 `program_name`；程序状态只有 `:running`、`:waiting`、`:parked`、`:completed`、`:failed`。同名的 `:running`/`:waiting`/`:parked` 拒绝 `:NAME_TAKEN`；完成/失败后可复用。

实现选择：**自建 Promise-CPS 的 ClojureScript 子集解释器 + 显式 CEK 状态机**。逻辑上保存整个异步调用帧；实现把“剩余表达式栈 + 词法环境 + 未提交 VFS + read-set + 能力快照”作为续体，不依赖 JS 引擎帧布局。这样 `park`/`unpark` 可稳定恢复，局部变量与 VFS 不丢失。

**不走 Cherry 编译主路径**：`cherry-cljs@0.6.38` 只导出 `compileString`/`compileStringEx`，不识别 `defprogram` 特殊形式，不自动 await 能力调用，`mapv` 回调里的 `js-await` 会生成非法 JS，`park`/`unpark` 只是普通函数。C2 只通过 H0 加载 Cherry 的纯数据/函数运行时（Keyword、PersistentVector/HashMap/HashSet、`mapv`/`filter`/`reduce`/`str`/`subs` 等），由解释器绑定白名单。只有 §2.6.4 的 Cherry 编译 Spike 全部通过，才允许把编译作为可选快路径评估；默认与回退都是解释器。

- 符号表白名单：只绑定 `cljs.core`、`clojure.string`、`clojure.set`、`clojure.walk` 的纯函数、异步序列函数、当前角色能力函数与只读常量。遇到 `js/*`、`globalThis`、`process`、`Bun`、`require`、`import`、`eval`、`read-string`、`load-string`、`resolve`、`ns-*`、`set!`、`aget`/`aset`、`goog/*` 或任何未绑定符号，在分析期返回 `:CAPABILITY_DENIED`，不得回退 JS 全局。
- 异步序列：`map`/`mapv`/`keep`/`filter`/`reduce`/`doseq` 逐个顺序 `await`；不并发写同一批 VFS；`map` 返回 vector，避免惰性序列带来的求值时机不确定。
- 期限：`intent` 的 UTF-8 字节数 × 50ms；CEK 每 1024 步检查一次时钟；到期转入 `:parked(:reason :deadline)`，不杀会话、不丢 VFS。纯 `loop/recur` 也经过步检查，因此不会出现无法停下的同步循环。
- `park`：保存续体与 VFS，返回 `{state:"parked", reason, payload, source, remainingWaitMs}`；`source` 带行号。
- `unpark` 核验顺序：存在性 → 观察点仍有效 → 非自指 → 能力集；错误分别为 `:PROGRAM_UNKNOWN`、`:STALE_CONTROL`、`:INVALID_ARGUMENT`、`:CAPABILITY_DENIED`。注入值原样成为原挂起表达式的返回值；恢复后提交仍复核 `stamp`。
- 正常返回且 VFS 非空 → 调用 C3 提交；抛异常 → 丢弃批内 VFS，真实磁盘零修改；`call` 前排空 VFS。
- 同一 `call-id` 重放返回原回执；不同载荷 `:CALL_REPLAY_MISMATCH`。

#### C3 `src/clj-sandbox/vfs.mjs`

公开：

```js
export function createBatch({writeRoot, readRoots, limits});
export function readText(batch, path);      // -> {content, stamp}
export function stat(batch, path);          // -> {exists,size,mtimeSec,mtimeNsec,isDir}
export function list(batch, path);          // 纯探查；不进 read-set
export function write(batch, path, content);
export function mkdir(batch, path);
export function remove(batch, path);
export function move(batch, source, target);
export function prepare(batch);             // -> {ok, plan} | error
export async function commit({batch, plan, writeGate, control, identity, claim});
export async function drain(batch, ports);
export async function runCall({batch, command, cwd, writeGate, control, identity, claim, limits});
```

- `stamp = {mtimeSec: BigInt, mtimeNsec: BigInt, size: BigInt}`；用 `fs.lstatSync(path, {bigint:true})`；比较用 BigInt，严禁转毫秒浮点；`atime` 完全不参与。
- `readText`/`stat` 把路径与读取时 `stamp` 记入 `read-set`；只读依赖也记；`ls` 不进 `read-set`、不做结构检查。
- 单次读取前后 `stamp` 变化 → `:changed-during-read`；不得原地刷新后继续。
- 符号链接：读取前 `lstat`；指向允许根之外的符号链接 → `:PATH_ESCAPE`；不得先 `realpath` 再放行越界写。
- 非 UTF-8：用 `TextDecoder("utf-8", {fatal:true})`；失败返回 `:NOT_UTF8`；不得用替换字符重写。
- 批内可拒绝条件全部在内存中返回：同路径双创建、`mv` 成环、删后未重建即读写、覆盖未读过的既有文件、新建已存在文件且未声明替换、文件/目录类型冲突、路径越界。错误 `:PREPARE_REJECTED` 或 `:STRUCTURE_CONFLICT`，带路径与操作序号。
- 上限默认：单文件 2 MiB、单批 16 MiB、单批 256 个路径操作；超限 `:LIMIT_EXCEEDED`。
- `commit` 顺序：取 `$W$` → 复核身份/claim → 逐一比对 `read-set` 的全部 `stamp` → 复核结构条件 → 固定 `:applying` → 同目录临时文件 + `fsync` + `rename` → 记账 → 释放 `$W$`。任一 `stamp` 不符立即释放 `$W$`，真实磁盘零修改，返回 `:FILE_CONFLICT` 并列出路径、原/当前 `stamp`。
- 多文件提交不是组原子：按计划顺序逐文件原子替换；中途硬失败时记录 `appliedPaths`/`pendingPaths`/`uncertain`，后续由 `:uncertain` 动作核对，不自动回滚、不自动重放。
- 空写集但 `board_finish` 依赖文件事实：仍取 `$W$` 复核 `read-set`；纯结构拆分不需要 `$W$`。
- `call`：先 drain 未提交 VFS；取 `$W$`；看板登记 `:running`；释放看板锁后运行；运行期持 `$W$`；等待外部条件时 Holder 可释放 `$W$`，但令牌责任仍在；输出内联 1 MiB、日志 64 MiB、超出显式 `:OUTPUT_TRUNCATED`；取消分 `:cancelled` 与 `:outcome-unknown`，不自动重放。
- 取消时点：进入 `:applying` 前取消 → 终止并标 `:cancelled`；已进入 `:applying` → 当前最小提交继续完成并发布结果，取消在应用后生效；已启动且可能产生外部副作用的 `call` 中断 → 标 `:outcome-unknown`，要求后继者先核对磁盘/Git/外部服务，必要时人工处理；不得把 `:outcome-unknown` 当成功，不得自动重放非幂等命令。
- 根策略：
  - Worker/Holder：`writeRoot = worktree`；`readRoots = [worktree, main/plans/<slug>, main/AGENTS.md]`；
  - Reviewer：只读 `worktree + main/plans/<slug> + main/AGENTS.md`；
  - Plan：只读 `main/plans/<slug>`；
  - Plan DevOps：只读主仓库；
  - Auditor：只读主仓库；写 `plans/<slug>/evidence/<case_id>/` 与 `/tmp/herd-audit-<slug>-<case_id>-<uuid>/`。
  写 `plans/`、`AGENTS.md`、`.herd/`、`.git/` 一律 `:PATH_ESCAPE`。

#### C4 `src/clj-sandbox/tools.mjs`

公开：

```js
export const CAPABILITY_MATRIX;   // 角色 × 能力
export function buildSandboxTools({role, session, roots, ports});
```

- 每个 `clj_<role>` 工具参数：`{program_name, code, intent}`；`code` 必须是一段 `(defprogram <name> [] ...)`。
- 能力矩阵严格按 `AGENTS.md` §4.2；未知角色/能力在装配期拒绝，不运行时猜。
- `clj_worker` 普通 Worker 的 `call` 一律 `:TOKEN_REQUIRED`；Holder 才可 `call`；`clj_review` 无 `write`/`call`/`park`；`clj_plan` 无写；`clj_devops` 只读；`clj_auditor` 写入只限证据目录与专属 `/tmp`。
- 工具回执统一 `renderReceipt`；拒绝不得改变真实磁盘。
- `call` 只允许 Holder/DevOps/Auditor；命令字符串由模型构造，参数必须结构化；不得把未转义用户输入拼进 shell。
- 工具执行前由 G1 剥离 `scope`/`intent`/`must_think_in`；C4 只看到业务参数。

### 3.3 Tool-gate 与 Scope

#### G0 `src/tool-gate/schema.mjs`

公开：

```js
export const GATE_KEYS;
export function injectGateFields(payload);   // -> boolean changed
export function stripGateFields(input);      // -> new input | undefined
```

- 覆盖五种传输形状：OpenAI `tool.function.parameters`、Anthropic `tool.input_schema`、裸 `tool.parameters`、Google `tool.functionDeclarations[].parameters`、Bedrock `tool.toolSpec.inputSchema.json`。
- 递归 `allOf`/`anyOf`/`oneOf`；`$ref` 根没有本地对象可扩展，跳过；非对象 payload 原样放过。
- 注入幂等：第二次调用不重复添加；使用同一组 snake_case 键名，不注入连字符别名。
- 字段：`must_think_in`（唯一值 `zh-cn`）、`intent`（非空）、`scope`（四型对象）、并发自检字段（可配置关闭）。
- 剥离只删除上述字段，不改其他参数；不得修改宿主持久化历史。

#### G1 `src/tool-gate/index.mjs`

```js
export default function activate(pi);
```

- `before_provider_request`：调用 G0；失败记录 H2，保持 payload 原样。
- `tool_call`：
  1. 读字段；
  2. 校验 `must_think_in === "zh-cn"`、`intent` 非空、`scope.kind` 合法；
  3. Q0 准入（冷启、预算、形状）；
  4. 成功则记账；
  5. 构造**剥离后的新对象**，返回 `{input}`；不得原样回传 `event.input`。18.x 返回的 `input` 是实际执行/持久化/显示参数；16.1.22 不支持 `{input}`，只注入不剥离，执行器必须忽略未知字段；
  6. 失败返回 `{block:true, reason: renderError(...)}`，工具不执行，状态不变。
- 已生效后的重复注解不得说成“未执行”；准入拒收与结算拒收分开。
- 持久化语义：返回的 `{input}` 会进入宿主持久化/显示/审批输入；消费者（含 DA 的 `rawToolArguments`）不得假设 gate 字段仍在 branch 中；CASE-34/39 必须实测。
- 使命激活时，按 M0 的 mission 注册表封禁宿主裸 `read`/`write`/`edit`/`bash`；建议同时封禁 `grep`/`glob`/`ls` 的仓库读取路径，防止绕过 `read-set`。封禁返回 `:CAPABILITY_DENIED`，不得只靠提示词。
- 入口加载失败不得阻断宿主；记录 health，工具调用放行或由 M0 的工具适配器二次校验。

#### Q0 `src/scope/ledger.mjs`

```js
export function ledgerFor(sessionId, agentId);
export function admit(ledger, annotation, {tool, turnId});
export function settle(ledger, {turnId, annotations});
export function askPreviousScope(ledger);
export function assume(ledger, lemma);
```

状态：`{initialized, retention, current, archived[], assumptions[], lastTurnId, pendingSteer[]}`。

- 四型：
  - `resetScope`：必须有非空 `new_scope_goal` 与正整数 `new_scope_retention_budget`；归档当前 scope，重置预算；不扣。
  - `keepLast`：无额外字段；认可上一拍；按回合扣 1。
  - `removeLast`：必须有非空 `replacement`；不扣；投影时把上一拍替换为一条教训消息；上一拍不存在则 `:INVALID_ARGUMENT`。
  - `meToo`：同回合多工具附议；全 `meToo` 回合按 `keepLast` 扣 1；混合同回合只结算一次。
- 冷启后首个非豁免调用必须是 `resetScope`，否则 `:SCOPE_UNINITIALIZED`。
- `retention === 0` 时除 `resetScope` 与豁免工具外一律 `:SCOPE_BUDGET_SPENT`。
- 豁免工具：`ask_previous_scope`、`assume`（`assume` 当拍仍扣 1）。
- `ask_previous_scope` 不扣、跨 reset 保留；答案异步到达；第二次及以后 reset 未查询只提示，不强制阻断。
- `assume` 钉住引理，跨 reset 保留；不得把前任对话带过上下文屏障。
- 每回合只结算一次；同一工具重放不重复扣。

#### Q1 `src/scope/projection.mjs`

```js
export function projectMessages({messages, ledger, currentBriefing, boardDelta});
export function relocateCacheBreakpoints(payload);
```

- 只构造出站副本；绝不修改宿主 `.jsonl` 或 `sessionManager` 持久化条目。
- 最新已结算 `resetScope` 边界之后原样保留；之前只保留：人类消息、历次 `resetScope` 调用与回执、`assume`/`ask_previous_scope` 调用与回执、助手结论正文、当前阶段简报。
- 当前阶段简报即使位于边界之前也钉住；晋级后旧简报不再钉住并自然被裁。
- `removeLast` 只改出站副本：上一拍调用/思考/结果三条替换为一条 `replacement` 消息。
- 双块锚点：稳定块（阶段协议、冻结契约摘要、看板全量快照）+ 易变增量块（耗时、预算、看板 delta）。自己写看板触发个人视图 clean-break；他人改看板只追加 ≤32 条 / 4 KiB delta；超限或稳定块变化触发 clean-break。
- 连续请求前缀逐字节稳定；不在尾部瞬态计数块上做改变前缀的覆写。
- 缓存断点：Anthropic `cache_control` / Bedrock `cachePoint` 落在尾部瞬态块时，前移到最后一个真实持久历史块；不增加断点数、保留 TTL、不改业务消息；无法安全定位则原位并记录事件。

### 3.4 阶段层

#### T0 `src/stages/disclosures.mjs`

```js
export const BRIEFINGS;          // {s1, s2, s3, s4, s5}
export function currentBriefing(stage);
```

- 文本以 `AGENTS.md` §8.3 为准；不得改写、删减锐度、翻译。
- 只有 T3 可以读取“下一阶段”简报；M0 只能通过 T3 的 `currentBriefing(stage)` 读取当前阶段。
- `common.mjs`、`roles.mjs`、S1 简报不得出现 S2–S5 的大师名、`PASS threshold`、`mapped_cases`、`submit_case_audit` 等关键词。

#### T1 `src/stages/parsers.mjs`

```js
export function validateS1(markdown);
export function parseS2Cases(markdown);
export function validateS3(markdown, modules);
export function validateS4(markdown, slices, caseIds);
```

- S1 必须可识别八类章节：目标/用户可见结果、决策框架、现状与根因、单向门/双向门、事前验尸、Non-Goals、成功标准、未决问题。章节用标题关键词匹配，返回缺失项与行号。
- S2：忽略围栏代码块中的 `### CASE-*`；每个 CASE 恰好一条 `- PASS threshold: N/100`、一条 `- 路径：...`、一条 `- 评分细则：...`；ID 唯一；N 为 0..100 有限数；路径非空；细则非空。
- `cases` 对账：ID 集合相等、阈值逐项相等、路径逐项相等；`rubric_summary` 必须是正文细则归一化后的连续子串且长度 ≥16 字符，否则拒绝。该规则是确定性的，避免“摘要看起来像”的模糊判断。
- S3：模块路径唯一、非空、相对仓库根、不含 `..`、不是绝对路径；`depends_on` 只引用已声明模块；DAG 无环；`secret_owned` 非空；Markdown 含模块边界、依赖图、失败隔离、CASE 对应表。
- S4：`slice_id` 唯一且合法；`depends_on` 无环；`mapped_cases` 与 S2 CASE 集合相等，不允许漏、多、未知；`goal`/`inputs`/`done_when` 非空；Markdown 含文学化伪代码、Safety/Liveness、拓扑合并顺序。
- 所有拒绝返回具体行号、字段、ID、环路径；不保存、不晋级、不披露。

#### T2 `src/stages/contract.mjs`

```js
export function createMission(root, {slug, seed});
export function readMission(root, slug);
export function listMissions(root);
export function freezeStage(root, slug, stage, markdown, meta);
export function verifyContract(root, slug);
export function realign(root, slug, stage);
export function readPendingGate(root, slug);
export function writePendingGate(root, slug, pending);
export function issueApproval(root, slug, {reportSha256});
export function verifyApproval(root, slug);
```

- `mission.edn` 至少含 `:mission-id :slug :seed :created-at :updated-at :stage :revision :contract-line :frozen :approval :limits :settings`；额外实现文件：`pending-gate.edn`、`receipts/<call-id>.edn`。
- `:stage` 只由门禁/结案推进；`:revision` 在冻结、重对齐、返工时递增；批准绑定 `(mission-id, revision)`。
- 冻结：原子写阶段文件 → 计算磁盘 `sha256` → 原子更新 `mission.edn`；S1 批准时重读磁盘最新文件再计算，不得用内存副本。
- 四哈希 + `contract-line` 必须同时存在；缺一拒绝启动 S5/结案。
- 人类编辑已冻结文件：重读、重算、更新 `:frozen` 与 `:revision`、给当前角色注入对齐提示；旧哈希不得结案。
- 批准 token：`sha256(mission-id + ":" + revision + ":" + contractLine + ":" + reportSha256)`；`approval = {revision, token, reportSha256, issuedAt}`。校验时重算。它是完整性校验，不是对拥有文件系统写权限者的密码学防御。
- 错误码：`:SLUG_TAKEN`、`:STAGE_MISMATCH`、`:CALL_REPLAY_MISMATCH`、`:CONTRACT_HASH_MISMATCH`、`:APPROVAL_REQUIRED`。

#### T3 `src/stages/gate-tools.mjs`

```js
export function registerGateTools(pi, deps);
export function currentBriefing(stage);
export async function resumePendingApproval(root, slug, message);
```

- 工具：`advance_s1..s4`、`ask_user`（S1 与 S5 初任空账例外）、`devops`、`submit_devops_report`、`submit_review`。
- S1：校验 → 原子写 → 打开 TUI 确认面板 → 等待批准/修改。批准时重读磁盘、冻结哈希、卸载 `ask_user`/`advance_s1`、挂载 `advance_s2`、在本次工具结果注入 S2 简报。
- 宿主不能长等待：写 `pending-gate.edn`，返回 `:awaiting-user`，抑制 Nudge；下一条人类消息恢复同一门禁，不重开阶段、不重复保存/披露。
- S2–S4：校验 → 原子写 → 冻结 → 自动批准 → 下一阶段简报；S4 额外计算四哈希、写契约行、初始化 S5、调用 B1 `forkSlices`。
- `devops` 启动 Plan DevOps（`@task` 模型），只读；`submit_devops_report` 返回调查报告。
- `submit_review`：非空 findings 交给 B2 立账并唤醒；空 findings 必须通过 Quiescence 与 ff dry-run，否则 `:RESOURCES_NOT_QUIESCENT` / `:FF_NOT_READY`。
- 幂等：同一宿主 `call-id` 重放原回执；不同载荷 `:CALL_REPLAY_MISMATCH`。
- 失败：校验失败不保存、不晋级、不披露；返回具体行号/字段。

#### T4 `src/stages/scores.mjs`

```js
export function aggregate({caseSpecs, submissions, contract, snapshotBefore, snapshotAfter});
export function writeS5Report(root, slug, aggregateResult);
export function issueApproval(root, slug, reportSha256);
```

- 拒绝：缺失 CASE、未知 CASE、重复有效提交、非有限/越界分数、空报告、证据路径不存在或越界、审计期间主工作区被改。
- 计算 `final = min(user_score, developer_score)`；与 S2 阈值比较；不提交总分。
- 全 PASS：按 S2 顺序合成 `s5-report.md`；复核契约哈希与快照；签发一次性批准；使命 `:completed`。
- 任一 FAIL/异常：不写“已交付”报告；保留失败明细；派生修复任务；递增 `revision`；循环。
- 报告字段：契约行、审计环境、逐 CASE 得分表、证据路径、审计员报告全文、总判定、限制与教训。

### 3.5 蜂群层

#### B0 `src/swarm/board.mjs`

```js
export function openBoard(root, slug, sliceId);
export function readBoard(root, slug, sliceId);
export async function apply({board, command, actor, turnId, requestId, expectedBoardVersion});
export function responsibilitySet(board, agentId);
export function progressableSet(board);
export function createWriteGateControl(boardPath);
```

- `board.edn` 权威字段：`:board-version`、`:tasks`、`:actions`、`:actors`、`:token-slot`、`:tenure`、`:next-ids`；事件追加到 `events.jsonl`；`checkpoint.edn` 记录已提交偏移与摘要。
- 所有写操作在 board lock 内短事务：读 → 校验版本/前置条件 → 纯转换 → 原子写 `board.edn` → 追加事件 → 更新 checkpoint → 释放。事务体内不推理、不等 `call`、不访问网络、不写工作区文件；目标 <5ms。
- 命令：`split`、`claim`、`finish`、`cancel`、`replace`、`release`、`reopen`、`comment`、`update`、`park_slot`、`take_or_die`。参数与语义按 `AGENTS.md` §3.3–§3.5。
- 任务状态只有 `:ready`/`:waiting`/`:done`；取消/替代是事件与叶子移除，不是新状态。
- 父项：拆分时同事务创建子项、设 `wait_for`、父项 `:waiting`、更新 `remaining_work`；子项全 `:done` 只把父项切回 `:ready`，保留 owner/remaining。`board_finish` 若父项在本 `turnId` 刚被重新唤醒 → `:PARENT_NOT_READY`；必须换独立回合并带合龙/集成证据。
- 认领：`claim_id` 唯一；无有效 claim 完成 → `:CLAIM_CHANGED`；任务非 `:ready` → `:TASK_NOT_READY`；令牌任务仅 Holder 可认领。
- 令牌：`take_or_die` 前置校验 `confirm === "i-hereby-confirm-i-die-without-regret"`、存活、无 `:applying`/`:running`、令牌空闲、存在未结 `:needs-token` 任务；`confirm` 不符返回 `:CONFIRMATION_REQUIRED`；无未结令牌任务返回 `:NO_PROGRESSABLE_WORK`（正向无工作回执，不发起竞争）。同一 board lock 内：赢则升 Holder、签发新 `term_id`，若 R(a)=∅ 同事务退休；输则解除认领、普通任务 owner 置 nil、`life_state :dead`。无第三条路。
- R(a) 按 `AGENTS.md` §3.2 公式；等待任务与运行中动作都计入；Holder 额外承担全部未结令牌任务。
- `park_slot`：必须携带 `observed_board_version`；同一事务核对全局可推进集为空 + 版本未变；否则 `:BOARD_CONFLICT` 或返回可推进摘要。任何使可推进集非空的提交/用户输入立即 `wake-all`。
- 幂等：所有写工具携带 `request_id`；同 ID 同载荷返回原回执；同 ID 不同载荷 `:CALL_REPLAY_MISMATCH`。

#### B1 `src/swarm/worktree.mjs`

```js
export function forkSlices({root, slug, slices, base});
export function joinSlice({root, slug, signal});
export function abandonSlice({root, slug, sliceId, reason});
export function gcWorktrees({root, slug, retainDays});
export function worktreePaths(root, slug, sliceId);
```

- `forkSlices`：只对 `depends_on` 已满足的 Slice 创建 `.herd-worktrees/<slug>/<slice_id>`；分支 `herd/<slug>/<slice_id>`；初始化该 Slice 的 board/locks/token；启动 B2。返回 `{slice_id, swarm_id, workspace, branch}`；未就绪不返回。资源不足 `:INSUFFICIENT_WORKTREES` 并建议降数；不得静默改小 N、不得复用 worktree。
- 所有 git 操作显式 `git -C <path>` 并校验 `--show-toplevel`；worktree 不带未跟踪 `AGENTS.md`/`plans/`，也不带 `node_modules`；契约走 C3 只读根，`call` 不得假设依赖已安装。
- `joinSlice`：FIFO 完成队列；空队列但有 `:running` 则等待；空且无 running 返回 `:none`；全部 abandon 返回 `:no-results`。取队首后取 `.herd/locks/master-integration.lock`；base 前进则 Holder 在 worktree 内 rebase（持该 Slice `$W$`），复核冲突；不可解则 `abandon_slice`。对齐后主工作区 `git merge --ff-only`；释放集成锁；返回完整结项报告（不截断）。
- `abandonSlice`：仅 Holder；标 `:abandoned`、worktree 丢弃、agent 逻辑死亡；结果不入队；必须给理由与证据。
- 保留：join/abandon 后保留 7 天（可配置）；`gcWorktrees` 只在保留期到后清理，先记录事件；不得立即删除。
- 契约访问：worktree 不复制 `plans/`；C3 的 `readRoots` 指向主工作区契约路径。`worktreePaths` 返回绝对路径，禁止把 `.herd/` 写入 worktree。

#### B2 `src/swarm/runner.mjs`

```js
export function startSlice({root, slug, sliceId, deps});
export async function runTenure({slice, deps});
export async function relay({slice, deps});
export function cancelTree({root, slug, reason});
export async function recover({root, slug, repair});
export function oracleFingerprint({goal, doneWhen, reason});
```

- Phase A：启动干净 Reviewer；只读 `clj_review`；读冻结契约、worktree 现场、映射 CASE。非空 findings → 卸载 `clj_review`、同事务立根任务、`wake-all`、进入 Phase B；空 findings → Quiescence + ff dry-run，通过则 Slice 入 FIFO，不通过返回 `:RESOURCES_NOT_QUIESCENT`/`:FF_NOT_READY`。若这是主工作区首次启动、契约已满足且没有任何 Slice 可做，则该次空账不记为 review，转为一次 `ask_user`；同一初任只问一次，问完恢复无人值守。
- Phase B：槽位 Worker 自治；根任务逐条 `board_finish` 时台账键置 nil；全部根任务 done、U=∅、无在途动作、Holder 无责、`$W$` 空闲 → 原子接力屏障：退休旧任期、写上下文屏障、启动继任 Reviewer、清空旧动作/槽位可见状态、保留任务结果与事件。
- 继任者只看到：seed、冻结契约路径/哈希、worktree、看板任务树与结果引用、继任提示；不得看到前任对话/思考/失败尝试。迟到请求 `:TENURE_RETIRED`。
- 槽位：固定 `slot_id` 池；死亡后销毁旧会话，在同槽创建新 `agent_id` 与空上下文；旧 `agent_id` 永不复用。
- Nudge：在 `agent_end`/`turn_end` 的 Spike 选定点，若未到合法出口则注入；等待人类/批准/取消确认时抑制；空转退避 0→30→60→120→240→300s；上游断流 5→10→20→40→80s；配额/计费/无效 key/模型不存在 → `:STALLED`，不重试；用户取消不重试；模型输出损坏只返回解析错误。用 `sendMessage({triggerTurn:true})`，不用 `sendUserMessage` 伪装用户输入。
- 恢复：六窗口（使命、看板、锁、`.tmp`、账本、worktree/证据）；锁先按 `agent_id`/`term_id` 对账 Actor 表与 runner 状态，再查 PID；死 PID 锁不盲删；`.tmp` 保留；读 checkpoint 偏移不全量重放；损坏先备份再恢复，不能恢复则停止；删除 `.herd/` 后报告状态丢失，不重建空状态。
- Oracle：同一指纹连续失败达阈值启动只读会诊；只写 `submit_oracle_advice`；不改文件、不结项、不降阈值；每个指纹只自动会诊一次。

#### B3 `src/swarm/auditors.mjs`

```js
export function snapshotWorkspace(root);      // -> {files: [{path, sha256, stamp}], digest}
export async function startAuditBatch({root, slug, caseSpecs, contract, deps});
export function validateSubmissions({caseSpecs, submissions, snapshotBefore, snapshotAfter});
export function deriveRepairSlices({aggregateResult});
```

- K 个 CASE 同时启动 K 名 `Auditor-<slug>-<case_id>`；运行时不足可排队，但语义全部启动，不得串行跳过。
- 每名只收到：S1 摘要、冻结契约路径、自己那一个 CASE 原文/阈值/细则、隔离边界、提交 Schema；不收到其他 CASE 或其他审计员结果。
- 隔离：独立 tmux `herd-<slug>-<case_id>`；独立 `/tmp/herd-audit-<slug>-<case_id>-<uuid>/`；独立证据目录 `plans/<slug>/evidence/<case_id>/`；`artifactsDir` 与证据目录分开。
- 工具面：`clj_auditor` + `submit_case_audit` + Scope 辅助；禁止 spawn；主工作区产品/测试/配置/文档/`.herd` 只读；写只允许证据目录与专属 `/tmp`。
- 子代理参数：必传 live `Settings`、`artifactsDir`、`eventBus`、`maxRuntimeMs`；`restrictToolNames:true`、`enableMCP/Lsp/Irc:false`；`outputSchemaMode` 用 strict；`yield` 与 `submit_case_audit` 的先后在 S3 固定并测试；检查 `resolvedModelIsFallback`。
- 子代理同 PID：`agent_id` 每次新生 UUID，slot 只作资源；不得把 slot/session id 复用为 agent_id。
- 硬超时 30 分钟；父级 abort 递归传播；超时/崩溃视为该 CASE 未完成，不得通过。
- 快照：启动前/后采集主工作区 `sha256` + `stamp`；任何非预期修改使整批审计作废。
- 提交校验：已知 CASE、唯一、分数有限 0..100、报告非空、证据路径存在且不越界、审计员未改主工作区。
- 返工：未达标 CASE 转修复 Slice/根任务，`mapped_cases` 只含失败项；不修改冻结 S4；重新 join、重跑受影响审计；`revision` 递增。

### 3.6 提示词与 TUI

#### P0 `src/prompts/common.mjs`

- 导出 `COMMON_RULES`，文本以 `AGENTS.md` §8.2 为准；不得出现 S2–S5 大师名、CASE 字段、Slice 字段、审计流程。
- 内含 Tool-First、Sandbox、Scope 三段规范原文；不得精简成建议。
- 只由 M0 的 `before_agent_start` 注入；不得被 G1 或子代理重复整段注入。

#### P1 `src/prompts/roles.mjs`

```js
export const ROLE_PROMPTS;       // planDevops, reviewer, swarmWorker, blockerOracle
export function buildCaseAuditorPrompt({mission, caseSpec});
```

- 角色提示词只含该角色需要知道的内容；主会话不加载其他角色提示词。
- 审计员模板只接收一个 CASE；不得包含其他 CASE、其他审计员结果或完整 S2 文档。
- P1 由 M0 在首次 spawn 时懒加载，并通过端口注入 B2/H1；B2 不直接 import P1。S1 主会话不 import，避免任何剧透风险。

#### P2 `src/prompts/runtime-wires.mjs`

```js
export const VIBE_CONTEXT_SUFFIX;
export function rewriteVibeModeContext(content);
export const TOOL_GATE_DEFINITIONS;
export function buildUnattendedNudge({stage, expectedTool, openItems, parkedPrograms});
```

- 文本以 `AGENTS.md` §8.5 为准；保留 NUL + BOM 前缀。
- Nudge 必须点名当前出口工具、未结义务、未恢复 `park` 程序；不写成新用户需求。
- 工具字段定义与 G0 使用同一组 snake_case 键名。

#### V0 `src/tui/dashboard-model.mjs`

```js
export function deriveDashboard({mission, slices, boards, audit, focus, now});
```

- 纯函数；输入是控制状态快照，输出紧凑态/展开五层/审计面板的文本与计数。
- 所有状态词、计数、等待链、得分表只从这里来；Widget 不另写一套格式化逻辑。
- 用户侧只出现三种状态：进行中、已交付、未交付（附理由与教训）；不暴露等待/重试/应用中等细分状态。

#### V1 `src/tui/dashboard-widget.mjs`

```js
export function mountDashboard(ctx, model);
export function applyStableHeightBound(regime, render);
```

- 只用公开的 `ctx.ui.setWidget(key, content, {placement:"aboveEditor"})`；组件工厂形式返回固定行数；字符串数组最多 10 行只作降级。`setHookWidget` 是宿主内部方法，不在 `ExtensionUIContext` 上，禁止调用。
- 预留底部输入区与聊天视口，不撑满终端；自然高度微涨截断尾部、微缩补空行；只在终端尺寸、紧凑/展开、审计阶段切换时重锁。
- 流式输出不把上翻历史拉回底部；不显示私有思考/完整工具输出。
- 挂载失败：使命继续；`/herd-status` 输出同源文本；health 记录降级；PASS/FAIL 必须有文字，不依赖颜色。

### 3.7 装配与入口

#### M0 `src/main.mjs`

```js
export default async function activate(pi);
```

- 只装配，不实现看板/门禁逻辑。注册：
  - `before_agent_start`：返回 `{systemPrompt: string[]}`，内容为 `COMMON_RULES + 当前简报 + 角色提示 + Pair Hint`；读取 `event.reason` 时缺失按 `"prompt"` 处理；不注入 `manual-protocol.mjs`；
  - `context`：Q1 投影；
  - `before_provider_request`：Q1 缓存断点；
  - `tool_call`：阶段/角色/裸工具守卫（与 G1 幂等，先 block 生效）；
  - `tool_execution_end`：事件与 health；
  - `agent_end`：B2 Nudge；
  - `session_start`：六窗口恢复、聚焦、mission 注册表、TUI；
  - 工具注册：gate、board、clj_*、submit_*、fork/join/abandon；
  - 命令注册：`/herd`、`/herd-status`、`/herd-list`、`/herd-focus`、`/herd-unfocus`、`/herd-cancel`、`/herd-recovery`、`/herd-settings`；不注册 `/herd-pair`。
- `registerTool` 必填 `name`、`label`、`description`、`parameters`、`execute`；参数 Schema 用宿主注入的 `pi.typebox`/`pi.zod`/`pi.arktype`，不得 import `@sinclair/typebox`。`execute` 签名为 `(toolCallId, params, signal, onUpdate, ctx)`；取消优先用第 3 个参数。
- 命令 handler 只做参数解析与领域函数调用，不直接改 `board.edn`；补全只列已知使命与枚举值，不扫仓库。
- 模型：主模型用于 Plan/Reviewer/Auditor/Oracle/Coordinator；`@task` 用于 DevOps/Worker/Holder；不可用明确报错。
- 工具面收敛：先 `registerTool`，再 `await pi.setActiveTools([...])`；`setActiveTools` 只选择启用集合，不注册工具，未注册名字会被忽略。使命激活时只留当前角色工具 + Scope 辅助；封禁宿主裸 `read`/`write`/`edit`/`bash`（建议含 `grep`/`glob`/`ls` 的仓库读取）。无法收敛时 G1 二次拒绝。
- TUI：只用 `ctx.ui.setWidget`；`registerShortcut` 与 `ctx.ui.onTerminalInput` 处理展开/Esc/IME；不调用 `setHookWidget`。
- 可选能力惰性化：`cherry-cljs`、`@oh-my-pi/pi-tui`、DA 不得在 `main.mjs` 顶层静态加载；否则任一失败会让整个 main 入口被宿主丢弃（当前 bootstrap 没有 try/catch，宿主只做 per-entry 隔离）。
- 设置：`/herd-settings` 读写 mission/settings；默认值按 `AGENTS.md` §6.5。

#### M1 `src/bootstrap-main.mjs`

```js
export default async function activate(pi);
```

- 惰性 `import("./main.mjs")`；**必须自己 try/catch 并记录 H2**；当前旧 bootstrap 只有动态 import + 调默认工厂，没有 try/catch，失败隔离依赖宿主 per-entry 捕获，健康信息会丢。加载失败不得阻断宿主或 G1。
- 当前 `bootstrap-main` 是“全有或全无”：`main.mjs` 任一顶层 import/工厂步骤抛错，整个 main 入口被丢弃；新装配必须把可选能力（cherry/TUI/DA）惰性化，并让非核心失败只降级。
- 不注册业务工具；不写状态；不做版本判断以外的逻辑。

#### G1 入口

- 独立默认工厂；只 import G0/Q0/H2/U0；加载失败不阻断 M1；同样自己 try/catch 记录 H2。
- `tool_call` 的 `{input}` 只在 18.x 可用；16.1.22 只有 `{block, reason}`。G1 必须先探测，16.x 走 inject-only，不能把 `{input}` 当跨版本事实。
- 与 M1 共享 §2.5 注册表；两者不得互相 import。

### 3.8 开发验收工具（非产品）

#### DA `tools/dev-acceptance/`

- 独立子包，建议 `tools/dev-acceptance/package.json`：`{type:"module", omp:{extensions:["./index.mjs"]}}`；不写入根 `package.json` 的 `omp.extensions`/`pi.extensions`。嵌套 `package.json` 不会在根插件被链接时自动加载；DA 必须在独立 `HOME` 中单独链接。
- 工具：`submit_manual_requirements`、`submit_development_guide`、`submit_coordination`、`submit_manual_report`。前三个保留现有参数形状；第四个原子写 `docs/manual-acceptance/<slug>/report.md`，写前校验三份文档存在且与契约行 `sha256` 一致。
- 最小闭包：`tools.mjs`、`constants.mjs`、`documents.mjs`、`requirements.mjs`、`index.mjs`、`util/atomic-write.mjs`、`util/errors.mjs`、`util/objects.mjs`。`util/` 用本地副本；不 import 任何 `pi-goal-x`/`pi-context`/`src/pi-*`。
- 不注入系统提示词；不注册 `/herd` 工具；不在产品运行时工具面出现。
- 迁移来源：现有 `src/manual-acceptance/tools.mjs`、`documents.mjs`、`requirements.mjs`、`constants.mjs` 可迁移；`contract.mjs`/`report.mjs`/`scores.mjs` 是纯 Node 函数但属旧语义，可按需迁入 DA 作为纯函数；`auditor.mjs`/`guards.mjs` 依赖旧 `host/*`，不迁移。
- 旧 `main.mjs` 无条件注入 `manual-protocol.mjs`；新 `main.mjs` 不得注入。DA 也不得把 S2–S5 协议注入产品 `/herd` 会话。
- 若 DA 进根 `omp.extensions`，18.x `loadMode:"essential"` 会使 `submit_*` 常驻顶层，违反 CASE-39；因此 DA 只能独立链接。
- 若人类决定不保留开发验收工具：删除整个目录，S4 使用宿主现有开发验收插件；产品运行时不受影响。该选择是待决问题 11.2。

## 4. 核心状态机与数据契约

### 4.1 使命与门禁

```text
:empty --/herd--> :s1 --advance_s1+人类批准--> :s2 --advance_s2--> :s3
  --advance_s3--> :s4 --advance_s4--> :s5 --全 CASE PASS+批准--> :completed
  :s5 --任一 FAIL/异常--> 修复 Slice/根任务 --> :s5（revision+1）
  任意阶段 --人类取消--> 未交付（保留现场）
```

门禁事务：

```text
validate(payload)
  -> parse(markdown)
  -> reject on any structural error (no write, no stage change, no disclosure)
  -> write stage file atomically
  -> read back disk bytes / sha256
  -> update mission.edn atomically {stage, revision, frozen}
  -> mount/unmount tools
  -> return receipt + next briefing (except S1 before approval)
```

- S1 唯一人工批准：批准前阶段仍 `:s1`；批准时重读磁盘；批准后才 `:s2`。
- 保存后、晋级前崩溃：恢复时文件存在且哈希匹配，允许重新校验并晋级；不得重复写文件。
- 晋级后、文件缺失/哈希不符：拒绝继续，要求恢复。
- `pending-gate.edn` 只用于异步等待；批准语义与同步等待相同。

### 4.2 沙箱程序

```text
:running --normal return + VFS empty--> :completed
:running --normal return + VFS nonempty--> commit --> :completed
:running --park/where 0|多/deadline--> :parked
:parked --unpark(value)--> :running --> ...
:running --exception--> :failed (VFS discarded)
:running/:waiting/:parked --same name--> :NAME_TAKEN
:completed/:failed --same name--> allowed
```

续体保存：CEK 栈、词法环境、VFS 叠加层、read-set、能力快照、期限、源码。恢复时按新 `intent` 重新计时；提交仍复核 `stamp`。挂起是 agent 私有状态，不落盘、不进看板；进程重启丢失，真实磁盘未改。

### 4.3 受保护提交

```text
read/stat (no W) -> read-set {path, stamp}
write/mkdir/rm/mv -> in-memory VFS overlay (ordered)
normal return
  -> acquire W
  -> verify identity/claim
  -> verify every read-set stamp (BigInt)
  -> verify structural conditions
  -> mark action :applying (board short transaction)
  -> for each planned file: tmp + fsync + rename
  -> publish result (board short transaction; retry control only)
  -> release W
conflict -> release W; zero disk change; :FILE_CONFLICT
hard failure mid-apply -> :uncertain; record applied/pending; no rollback
```

多文件不是组原子；崩溃后可能看到前缀已应用。动作记录必须足以让后继者核对，不得把整批标完成。

### 4.4 看板、动作、个体、令牌

```text
Task:   :ready <-> :waiting -> :done; cancel/replace remove leaf + event
Action: :claimed -> :preparing -> :waiting-gate -> :applying/:running
        -> :finished | :uncertain
Actor:  :alive -> :dead | :terminated
Token:  :free <-> :held (new term_id per win)
```

- 任务状态不混入动作运行态；`:cancelled`/`:replaced` 不是任务状态。
- 同一身份同一时刻最多一个有副作用动作。
- 责任集合 R(a) 按规格公式；Holder 无责即死；普通任务归属不因他人持令改变。
- 令牌竞争不可逆；输者同事务移交并死亡；死身份不能提交新结果。

### 4.5 任期与 Slice

```text
Slice: :running -> :queued -> :joined
       :running -> :abandoned | :failed
Tenure: :active --非空 findings--> Phase B --根任务全 done + Quiescence--> :retired
        :active --空 findings + Quiescence--> Slice :queued
        :retired --迟到请求--> :TENURE_RETIRED
```

Quiescence 最小集：无 `:applying`/`:running`/`:uncertain` 动作；无未结 `:needs-token` 任务；不持有 `$W$`；无待办 rebase；ff dry-run 通过。actor 只需无责任，不要求槽位为空。

### 4.6 审计批次

```text
batch: :prepared -> :running (K auditors) -> :collecting
       -> all PASS -> report -> approval -> :completed
       -> any FAIL/timeout/crash -> repair tasks -> revision+1 -> :running
```

- 报告只在全 PASS 后写；失败明细保留，不写“已交付”。
- 批准一次性绑定 `(mission-id, revision)`；旧 revision 重放拒绝。
- 审计员异常不是通过理由；主工作区被改整批作废。

### 4.7 持久化与原子性

```text
主工作区/
  plans/<slug>/s1..s5-*.md, evidence/<case_id>/
  .herd/missions/<slug>/
    mission.edn
    pending-gate.edn
    receipts/<call-id>.edn
    slices/<slice_id>/{board.edn,events.jsonl,checkpoint.edn,approvals.edn}
    audit/<case_id>.submit.edn
  .herd/locks/{master-integration,<slice>.write-w,<slice>.board}.lock
  .herd/artifacts/<slug>/<slice>/<action>.log
  .herd-worktrees/<slug>/<slice_id>/
```

- `.herd/` 与 `.herd-worktrees/` 不进 Git；`plans/` 是用户可见交付物。
- Slice worktree 不创建 `.herd/`；控制面集中在主工作区。
- 所有阶段文档、`mission.edn`、`board.edn`、`checkpoint.edn`、报告、证据元数据走 U1 原子写。
- 事件是解释与 best-effort 接续辅助，不是当前态唯一来源；`board.edn`/`mission.edn` 权威。

## 5. 逐 CASE 映射

下表把 S1 的 39 个 CASE 映射到模块、架构钩子、手工验证入口与典型硬失败。阈值与路径以 `requirements.md` 为准；本表不重复评分细则全文。所有验证均为待执行路径，不是已观察结果。

| CASE | 路径/阈值 | 主模块 | 架构钩子 | 手工验证与最低证据 | 典型硬失败 |
|---|---|---|---|---|---|
| CASE-01 | 正常/90 | M1、G1、H0、H2、M0、`package.json`、`src/AGENTS.md` | 双入口惰性加载；依赖收敛；旧目录/旧字符串清除；单入口损坏隔离 | 读 `package.json`/`src/` 清单；grep 旧符号；`/tmp` 副本 `omp plugin link`；正常与单入口损坏两次 tmux；health；根规格 `sha256` | 加载 public 副本；仍声明旧依赖；三入口；宿主崩溃；`/herd` 不存在；旧实现目录/猴子补丁残留 |
| CASE-02 | 正常/90 | M0、T3、T0、Q1、V1 | S1 只注入 S1 简报；`ask_user` 可问；`advance_s1` 唯一人工批准；批准后 S2 自动 | S1 出站快照搜 S2–S5 关键词；`ask_user` 调用/回答；确认面板；批准前后 `mission.edn`；磁盘编辑后哈希；S2 简报回执 | S1 出站泄露 S2–S5；未批准进 S2；内存副本冻结；批准前推进 |
| CASE-03 | 错误/90 | T1、T2、T3、U1、B2 | 六类 S1 校验；`call-id` 幂等；`:awaiting-user`；冻结文件人类编辑重对齐；旧哈希 fail-closed | 六次非法调用回执；同 ID 重放/异载荷；异步恢复；编辑前后 `sha256`/`revision`；旧哈希拒绝 | 非法输入被保存/晋级；人类编辑被覆盖；旧哈希结案；重放重复保存 |
| CASE-04 | 正常/90 | T1、T2、T3、T0 | S2 CASE 解析、对账、原子写、冻结、自动批准、S3 简报、S2 退役 | S2 文档全文；`advance_s2` 回执；`mission.edn` S2 哈希；S3 抓屏；S2 关键词消失 | 缺阈值/路径/细则仍接受；未冻结晋级；S3 简报缺失；文件被改写 |
| CASE-05 | 错误/90 | T1、T2、T3、U1 | 围栏代码块忽略；12 类结构/对账拒绝；旧合法版本不被覆盖 | 12 类非法输入回执与行号；每次失败后文件 `sha256`；阶段抓屏；合法旧版本哈希 | 任一非法文档被接受；旧版本被覆盖；阶段推进；S3 泄露 |
| CASE-06 | 正常/90 | T1、T2、T3、T0 | 模块唯一/相对路径/依赖已声明/无环/secret 非空；冻结/自动批准/S4 披露 | 模块数组与文档；`advance_s3` 回执；S3 哈希；S4 抓屏；出站快照 | 接受环/未声明依赖/绝对路径；未冻结晋级；S4 简报缺失 |
| CASE-07 | 错误/90 | T1、T2、T3 | 8 类模块图拒绝；具体模块/环/字段；旧版本不覆盖 | 8 类回执；拒绝中的模块/环/字段；旧版本哈希；阶段抓屏 | 非法图被接受；旧版本被覆盖；阶段推进；S4 泄露 |
| CASE-08 | 正常/90 | T1、T2、T3、B1、T0 | Slice 唯一/无环/覆盖全 CASE/字段非空；四哈希+契约行+revision；自动启动 S5 | Slice 数组；`advance_s4` 回执；`mission.edn` 契约行与四哈希；S5 启动抓屏 | 未覆盖 CASE 仍接受；环；四哈希缺失；未冻结启动 S5；旁路批准 |
| CASE-09 | 错误/90 | T1、T2、T3 | 9 类 Slice 图拒绝；具体 Slice/环/未覆盖 CASE；S5 不启动 | 9 类回执；旧版本哈希；阶段与 S5 未启动抓屏 | 非法图被接受；旧版本被覆盖；S5 启动；阶段推进 |
| CASE-10 | 恢复/90 | T2、T3、U1、U2、B0 | `call-id` 回执重放；保存后/晋级前崩溃恢复；原子写；无重复事件 | 重放回执；两个崩溃点注入与恢复；目标哈希；`mission.edn`；`events.jsonl` 偏移；`.tmp-*` 清单 | 重复保存/披露；目标半截；阶段与文件不一致仍继续；异载荷重放被接受 |
| CASE-11 | 安全/95 | C4、C2、C3、H1、B3 | 六角色能力矩阵；越权 `:CAPABILITY_DENIED`；Worker `call` `:TOKEN_REQUIRED`；Auditor 写入白名单 | 六角色工具列表；每角色一次越权回执；主工作区哈希前后；Agent Hub；Worker/Holder `call` 对照 | Worker `call` 成功；Plan/Reviewer 能写；Auditor 能写产品代码/spawn；拒绝后文件被改 |
| CASE-12 | 安全/95 | C2、C3、C4 | 符号表白名单；路径/符号链接边界；非 UTF-8/二进制；`ls` 纯探查 | 每个符号族回执；四类路径越界；非 UTF-8/二进制回执；根内外哈希 | 任一逃逸成功；根外写入；二进制被替换字符重写；`ls` 进 read-set |
| CASE-13 | 边界/90 | C0、C4、C2 | UFSS 双射、最小围栏、缩进规则、控制字符回退、精确错误位置 | 字符串族原文/读回哈希；两种围栏阶数；两种非法输入；100 KiB；`where` needle | 读回不一致/丢字；JSON 转义噪音；非法围栏无位置；100 KiB 静默截断 |
| CASE-14 | 恢复/90 | C1、C2、C3 | UTF-16 精确 span；0/多匹配挂起；Ukkonen 诊断；`unpark` 局部变量/VFS；恢复后 `stamp` | 唯一/多/零回执；`subs` 重建；挂起时磁盘哈希；恢复后文件；冲突回执；四类 `unpark` 错误 | 挂起写盘；`unpark` 丢局部/VFS；span 错；冲突覆盖他人；重复恢复被接受 |
| CASE-15 | 并发/95 | C3、B0、U1、U2 | 全 read-set（含只读依赖）；BigInt 纳秒 `stamp`；`atime` 排除；W 内复核；原子 rename；恰好一次 | 只读依赖冲突；目标冲突；`atime` 通过/`mtime` 冲突；空写集 W；并发读者；`apply` 事件计数 | 冲突后覆盖；只读依赖漏检；`atime` 触发冲突；重复落盘；半截文件；跳过 W 复核 |
| CASE-16 | 边界/90 | C3、C2 | 顺序 VFS；六类结构冲突；三类上限；异常/park 零落盘；操作序号 | 正向顺序最终文件；反向拒绝与零修改；六类冲突；三类上限；异常/park 前后哈希 | 任一拒绝触盘；异常/park 落盘；上限被绕过；结构冲突被接受；半截文件 |
| CASE-17 | 并发/95 | C3、C4、U2、B0 | W 互斥；读不阻塞；锁序 integration→W→board；`call` drain/运行期持 W/等待释放 W；取消四分类 | 并发提交回执/最终文件；读者不被阻塞时序；反向锁序拒绝；drain 前后内容；取消/`:outcome-unknown`；锁文件 | 两个 W 持有者；读者被阻塞；反向锁序；非幂等自动重放；`:outcome-unknown` 当成功；取消半截 |
| CASE-18 | 正常/95 | B0、B2 | 拆分原子；父项 `:waiting`→`:ready`；同回合关闭 `:PARENT_NOT_READY`；claim/cancel/replace/reopen/version | 拆分前后 `board.edn`；父项恢复快照；拒绝回执；独立完成；claim/cancel/replace/reopen；版本冲突最新树 | 父项自动 done；同回合关闭被接受；父项丢 remaining；非叶子取消/替代；版本冲突覆盖 |
| CASE-19 | 并发/95 | B0、B2、H1 | T01–T13 不可逆令牌；动态责任；死亡移交；死身份禁写；父项移交 | 每个 T 场景 `board.edn`、令牌槽、事件、身份、回执 | 两个有效 Holder；输者继续；死身份提交成功；R(a) 非空死亡；父项自动完成；响应丢失第二条路 |
| CASE-20 | 并发/90 | B0、B2 | `park_slot` 同事务核对可推进集与版本；`wake-all`；Holder-only 工作拒绝 | 有工作拒绝；Holder-only 拒绝；版本冲突；真正空集休眠；新输入/`board_reopen` 唤醒；事件顺序 | 有可推进工作仍休眠；漏唤醒睡死；检查/登记分离；伪造任务 |
| CASE-21 | 正常/90 | B1、B0、U2、T2 | 因果 fork；独立 worktree/分支/看板/锁；FIFO join；集成锁；rebase/ff-only；abandon；7 天保留 | `git worktree list`；fork 返回；`:INSUFFICIENT_WORKTREES`；join 顺序/ff 提交；rebase；abandon；保留清单 | 同 Slice 多 worktree；非 ff；join 竞速/非 FIFO；abandon 无理由；立即删除；多 Slice 同 worktree |
| CASE-22 | 并发/95 | B2、B0、T3、H1、T0 | findings 立账/卸载/wake-all；Quiescence；ff dry-run；原子接力；上下文屏障；里程碑复制；迟到拒绝 | Reviewer prompt/findings；根任务；`:RESOURCES_NOT_QUIESCENT`；`:FF_NOT_READY`；空账入队；退休/继任；继任者 prompt；迟到拒绝 | 有在途动作仍接力；继任者看到前任；迟到请求被接受；空账未过 Quiescence；findings 丢失/重复 |
| CASE-23 | 并发/95 | B3、H1、C4、T4、V0 | K 审计员同窗启动；单 CASE prompt；四隔离；主工作区只读；禁止 spawn；30 分钟超时；abort 传播；live settings/artifacts/eventBus/yield | Agent Hub 启动时间；三份 prompt；`tmux ls`；`/tmp`/证据目录；主工作区快照；写入拒绝；超时/取消；settings/transcript 证据 | 串行启动；看到其他 CASE；写产品代码；spawn；超时当通过；篡改未发现；settings 丢 `@task` |
| CASE-24 | 错误/95 | T4、T2、B3、U1 | 七类提交拒绝；异常/超时不当通过；手动改 stage 拒绝；全 PASS 报告；一次性批准；旧 revision 拒绝 | 七类拒绝回执；超时/崩溃处理；`:APPROVAL_REQUIRED`；全 PASS 报告；批准重放 | 不合法输入被接受；报告含 FAIL 标已交付；手动改状态当批准；批准可重用；篡改仍结案 |
| CASE-25 | 正常/90 | T4、B2、B1、T2 | FAIL 明细；S4 不变；修复 Slice/根任务；rejoin/rerun；revision 递增；三状态；报告字段 | 失败明细；S4 前后哈希；修复任务；revision 序列；全 PASS 报告；三状态文本；未交付理由 | 修改冻结 S4；跳过失败 CASE；报告含 FAIL 标已交付；未交付无理由；缺双视角表 |
| CASE-26 | 正常/85 | M0、V0、B0、B2、T2 | 八条 `/herd*` 命令；同源模型；取消保留产物；恢复/设置；无 `/herd-pair`；补全有界 | 八条命令输出；补全列表；取消前后 `plans/` 哈希；settings；TUI 对照；无 `/herd-pair` | 提供 `/herd-pair`；命令直接改看板；状态不一致；取消删文件；AI 自主切换焦点 |
| CASE-27 | 可访问性/85 | V0、V1、H0、H2 | aboveEditor 双态；稳定高度；紧凑/展开五层；审计面板；窄屏/无颜色/挂载失败降级；不抢滚屏 | tmux 抓屏；五层；窄屏/无颜色；挂载失败；高度锁定；滚动历史 | TUI 失败阻断使命；高度增长清屏；PASS/FAIL 只靠颜色；Widget 与 status 两套逻辑 |
| CASE-28 | 恢复/90 | B2、U2、B0、T2、U1 | 六窗口扫描；死/活 PID 锁；`.tmp` 保留；checkpoint 偏移；损坏备份/停止；`:outcome-unknown`；删除 `.herd` 报告 | kill 前后进程/文件；六窗口输出；锁对照；`.tmp` 清单；偏移；恢复/停止；删除 `.herd` | 自动删存活锁；静默重建空 `.herd`；全量重放；非幂等重放；`:outcome-unknown` 当成功；损坏后猜 |
| CASE-29 | 取消/90 | M0、B2、H1、B0 | Esc 层级；IME 优先；递归 abort；`:cancelled`/`:outcome-unknown`；证据保留；不重放；park/退休不 abort | 三层抓屏；子代理终止；取消回执；证据目录；park/退休对照；最终状态 | 只中断主会话；删证据；自动重放；park/退休触发整树 abort；`:outcome-unknown` 当成功 |
| CASE-30 | 错误/90 | B2、P2、H1、T2 | Nudge 内容/抑制；0→30→60→120→240→300；5→10→20→40→80；`:STALLED`；取消不重试；解析错误不重跑 | Nudge 文本；抑制场景；退避序列；429/5xx；`:STALLED`；取消；解析错误 | 无 Nudge；合法等待被 Nudge；配额错误重试；取消重试；输出损坏自动重跑 |
| CASE-31 | 安全/95 | T3、T1、P0、G1 | 只由门禁回执推进；XML/伪指令当数据；无正文正则提取；Schema 边界 | S1 用户/工具结果注入后的阶段/哈希；伪 CASE 解析；真实门禁回执；源码搜索 | 注入推进/冻结/批准；正文解析业务数据；伪造工具结果被接受 |
| CASE-32 | 安全/95 | C4、B3、T4、V1 | 五处零命中；Auditor 不导出；泄漏停止；脱敏 | 假密钥注入；五处搜索；审计员拒绝；泄漏停止；脱敏回执 | 密钥进入 plans/evidence/日志/报告；审计员导出；泄漏后继续结案；无停止 |
| CASE-33 | 兼容/85 | H0、H2、M1、G1、C2、V1、H1 | 能力探测；`{input}` 缺失 inject-only；TUI 缺失文本；无 artifactsDir 内存回执；cherry 失败隔离；`:awaiting-user`；模型不可用；运行时版本三元组 | 实际版本健康表（17.3.5/18.16.0/18.12.4/16.1.22 候选）；五类缺失运行；异步恢复；16.1 或桩声明；模型错误 | 缺失能力宿主崩溃；静默换模型；假装沙箱/TUI/审计可用；`{input}` 缺失阻断所有工具；伪造 18.16 类型 |
| CASE-34 | 错误/90 | G0、G1、Q0 | 五类传输注入；递归/幂等；执行前剥离；四型 Scope；冷启/预算；豁免 | 原始 payload；注入前后 Schema；剥离后参数；幂等；非法 scope；`ask_previous_scope`/`assume` | 门禁字段到达底层；冷启/预算绕过；注入破坏 payload；核心传输未注入 |
| CASE-35 | 正常/90 | Q1、Q0、T0 | 只改出站副本；裁剪边界；简报钉住/退役；removeLast；双块锚点；缓存断点前移 | 宿主 `.jsonl` 前后哈希；裁剪消息；简报关键词；delta 上限；clean-break；缓存标记 | 修改宿主 `.jsonl`；旧简报泄漏/当前丢失；断点数量改变；删宿主历史 |
| CASE-36 | 性能/85 | C3、C4、C2、B3、B1 | VFS 2 MiB/16 MiB/256；call 1 MiB/64 MiB；intent 期限；审计排队但全启动；worktree 不足 | 三类上限回执；日志/截断；期限 park；审计启动时间；`:INSUFFICIENT_WORKTREES` | 静默截断；期限杀会话；审计串行；静默改小 N；虚假拆分 |
| CASE-37 | 正常/95 | M0、T3、T2、B1、B2、B3、T4、V1 | 端到端五阶段+两 Slice+两审计+报告+批准+已交付 | S1 批准抓屏；四份阶段文件/哈希；两个 worktree；join；两份审计；报告；批准；状态 | 额外人工审批；审计跳过；自动化当证据；报告缺失；未批准 completed；四哈希不一致 |
| CASE-38 | 逆序/90 | T3、B0、B2、C2、T4 | 阶段/看板/任期/审计/续体五类乱序稳定拒绝；状态不变 | 每类乱序回执；状态/哈希前后；事件顺序 | 乱序改变状态；旧批准复活；结案重开；旧身份提交成功 |
| CASE-39 | 兼容/95 | M1、G1、H0、H2、M0、B1、T2、DA、`package.json` | 真实加载本副本；共享 gitdir；未跟踪根规格/契约在 worktree 可用；旧验收切换；历史产物保全；DA 独立 HOME/link；根入口两项目录 | `omp plugin list`/入口 realpath；唯一标记；git 拓扑；规格/四阶段哈希；worktree 契约；工具列表；历史产物哈希；DA 不在 `/herd` 工具面 | 加载 public/其他副本；根规格/契约缺失；旧验收重复注册；历史产物静默删除；DA 进根 `omp.extensions` |

### 5.1 覆盖断言

- 39 个 CASE 全部映射到至少一个模块；CASE-37 覆盖端到端，其余 CASE 覆盖单路径/单边界。
- 路径类别全部出现：正常、错误、边界、并发、安全、兼容、恢复、取消、逆序、性能、可访问性。
- `AGENTS.md` §9.7 的 15 类阻断缺陷全部有对应 CASE；映射见 `requirements.md` §7.4。
- 所有 CASE 的执行入口都是真实 `omp` 宿主 + tmux + `/tmp` 副本；自动化测试只在诊断/前置条件中出现，不提高任何分数。
- 每个 CASE 的证据根为 `docs/manual-acceptance/clean-break/evidence/<CASE-ID>/`；产品运行时审计证据仍在被测使命的 `plans/<slug>/evidence/<case-id>/`，两者不混用。

## 6. S1 需求与铁律映射

### 6.1 十条铁律

| 铁律 | 主要模块 | 主要 CASE | 实现要点 |
|---|---|---|---|
| L01 结构化与长文走专用工具 | T3、T4、B0、P0、G1 | 02–09、24、31、38 | 门禁/看板/审计只接受工具参数；禁止正文正则提取 |
| L02 仅 S1 与 S5 初任空账可问人类 | T3、B2、M0 | 02、03、26、37 | `ask_user` 只在 S1/初任空账挂载；其余 Nudge 驱动 |
| L03 渐进披露 | T0、T3、Q1 | 02、04、06、08、35 | 下一阶段简报只由门禁回执注入；旧简报退役 |
| L04 K 路并发独立审计 | B3、T4 | 23、24、25 | 一 CASE 一审计员；框架汇总；全 PASS 才结案 |
| L05 Reviewer ⇄ Swarm 咬合 | B2、B0 | 22 | 非空 findings 立账；Quiescence 后原子接力 |
| L06 父项保留实质 | B0 | 18 | 子项全 done 只回 `:ready`；同回合关闭拒绝 |
| L07 VFS + stamp + W | C3、C4、B0 | 15、16、17 | 预演零触盘；W 内复核；原子 rename；四分类结局 |
| L08 take_or_die 不可逆 | B0、B2 | 19 | 一赢一输；输者移交并死亡；Holder 无责即死 |
| L09 规划期只读与模型归属 | C4、H1、T3、B2 | 11、22、33 | Plan/Reviewer/Auditor 只读；主模型判断；`@task` 施工 |
| L10 Scope/投影/EDN+UFSS | Q0、Q1、C0、G0、G1 | 13、34、35 | 出站投影只改副本；EDN+UFSS 无 JSON 噪音 |

### 6.2 规格章节

| `AGENTS.md` 范围 | 主要模块 | 主要 CASE |
|---|---|---|
| §0、§1.1、§1.2 | H0、H2、M1、G1、C2、V1 | 01、02、11、12、19、31、33、34、35、39 |
| §1.3 L01–L10 | 见 6.1 | 02–35 |
| §2.1 角色/模型 | C4、H1、B2、B3 | 11、22、23、33 |
| §2.2–§2.3 阶段/门禁 | T0、T1、T2、T3 | 02–10、38 |
| §2.4 渐进披露 | T0、T3、Q1 | 02、04、06、08、35 |
| §2.5 多 Worktree/任期 | B1、B2、B0 | 21、22 |
| §2.6 K 路审计 | B3、T4 | 23、24、25 |
| §2.7 无人值守 | B2、P2 | 30 |
| §2.8 人类交互 | M0、B2、V0、V1 | 26、27、29 |
| §3 看板/令牌/禁睡 | B0、B2 | 18、19、20 |
| §4 沙箱/VFS/续体 | C0–C4 | 11–17 |
| §5 Scope/UFSS/缓存 | Q0、Q1、C0、G0、G1 | 13、34、35 |
| §6 TUI/命令/恢复/降级 | V0、V1、M0、B2 | 26–30 |
| §7 存储/锁/安全/性能 | U1、U2、T2、B0、B1、B2 | 10、15、17、28、32、33、36 |
| §8 提示词/披露/Nudge | P0、P1、P2、T0、T3 | 02、30、31、35 |
| §9 工程/测试/放行 | 全部 | 01、15–25、36、37 |
| §10 差异/迁移 | M0、M1、G1、DA | 01、37、39 |

### 6.3 不满足映射时的处置

若某个 S1 要求或 CASE 找不到模块/接口，按以下顺序处理：

1. 回到 `requirements.md` 确认是否其实是 Non-Goal；
2. 若确为要求，在 S3 协调手册中增加模块或接口，并说明为什么现有秘密边界不够；
3. 不得用“提示词让模型自觉”替代模块/接口；
4. 不得用自动化测试替代手工 CASE；
5. 不得降低阈值或删 CASE 来消除缺口。

## 7. 迁移与旧资产保留

### 7.1 迁移原则

- **一次切换，不留双路**：新模块通过测试后删除旧模块与旧入口；不在运行时保留“旧依赖可用就走旧路”的分支。
- **先立后破**：先让新模块、新入口、新测试独立成立，再删除旧路径；删除是独立、具名、可核对的动作。
- **不静默删共享路径**：`.herd/`、`.herd-worktrees/`、`plans/`、`docs/`、根 `AGENTS.md` 的删除/移动必须单独确认并留证。
- **向前修复**：迁移中发现缺陷，诊断并修复；不回滚正确工作，不用“退回最近绿色状态”替代解决。
- **基线只用于诊断**：可以记录 clean-break 前的提交/哈希作为对照，但不得作为运行时回退路径。

### 7.2 迁移步骤

每一步都应有独立、可诊断的完成条件；这些条件是内部检查，不是手工验收证据。

| 步骤 | 动作 | 主要文件 | 可诊断完成条件 |
|---|---|---|---|
| 0 | 记录基线：根 `AGENTS.md`、`docs/**`、`plans/**`、当前提交、git 拓扑；确认 public 副本假设 | 只读命令 | 哈希清单存在；未改任何文件 |
| 1 | 建底层：错误、原子写、文件锁、健康登记、宿主导入 | U0–U2、H0、H2 | 锁/原子写/导入单测通过；无产品入口依赖 |
| 2 | 建沙箱基础：UFSS、where、evaluator、VFS | C0–C2 | UFSS 双射、where 诊断、CEK 挂起/恢复、VFS 预演测试通过 |
| 3 | 建沙箱工具与角色矩阵 | C3、C4 | 六角色能力矩阵、越权拒绝、`call` 门禁测试通过 |
| 4 | 建 tool-gate 与 Scope | G0、G1、Q0、Q1 | 五类 Schema 注入/剥离、四型 Scope、冷启/预算测试通过 |
| 5 | 建阶段层 | T0–T4 | S1–S4 校验/冻结/自动批准/披露/汇总测试通过 |
| 6 | 建蜂群层 | B0–B3 | 看板交错、令牌 T01–T13、F01–F15、任期/审计测试通过 |
| 7 | 建提示词、TUI、命令、装配 | P0–P2、V0、V1、M0、M1 | 零剧透、双态看板、命令、Nudge 测试通过；两个入口可独立加载 |
| 8 | 建开发验收工具 | DA | 三份提交工具 + 报告工具在独立入口可用；不进入产品工具面 |
| 9 | 切换清单与依赖：两个入口、只留 `cherry-cljs`、删除旧入口/旧导出 | `package.json`、`src/bootstrap-main.mjs`、`src/tool-gate/index.mjs` | 本插件只解析到本副本两个入口，且本副本不再出现旧入口；`/herd-status health` 无旧入口 |
| 10 | 删除旧代码路径与旧测试；更新文档与 `.gitignore` | 见 7.3/7.6/7.8 | `src/` 无旧目录/旧字符串；测试只覆盖新模块；文档同步 |
| 11 | 真实宿主小使命冒烟：S1→S2–S4→单/多 Slice→K 审计 | M0、B1–B3、T3、T4 | 只作为端到端调试；CASE-37 才是验收 |

步骤 1–7 中，底层模块可并行开发，但接口必须先冻结；S4 协调手册负责把并行工作切成互不相交的 Slice。本文不代替 S4 切片。

### 7.3 删除清单

以下路径属于旧产品运行时，clean-break 完成后不得存在：

| 路径 | 原因 |
|---|---|
| `src/pi-goal/` | 旧 goal 运行时、审计安装、UI 代理；被 T3/T4/B2 取代 |
| `src/pi-context/` | 旧上下文捕获、`xd://context_compact` 历史改写；被 Q1 取代 |
| `src/editor-theme/` | 主题垫片、TUI 原型补丁；新规格不包含 |
| `src/bootstrap-editor-theme.mjs` | 第三入口；必须删除 |
| `src/context/` | 旧 vibe 后缀/改写；被 P2 取代 |
| `src/tool-gate/strip.mjs` | 旧剥离实现；并入 G0/G1 |
| `src/host/goal-settings.mjs` | 旧 goal 设置；被 `/herd-settings` 与 mission settings 取代 |
| `src/host/capabilities.mjs` | 旧 bundled agent/settings 探测；并入 H0 |
| `src/prompts/auditor.mjs` | 旧审计员提示词；被 P1 `buildCaseAuditorPrompt` 取代 |
| `src/prompts/manual-protocol.mjs` | 旧开发验收协议注入；不属于产品运行时；如需保留，迁到 DA |
| `src/prompts/method-discipline.mjs`、`repo-aware-rules.mjs`、`plan-only.mjs`、`context-skill.mjs` | 旧开发期提示词注入；不属于产品运行时；如需保留，迁到 DA 或宿主 skill |
| `src/manual-acceptance/` | 旧开发验收实现；迁到 DA 或删除（见 7.6） |
| `tests/goal-settings.test.mjs`、`tests/tool-gate.test.mjs` 旧断言、`tests/contract.test.mjs` 旧契约、`tests/requirements.test.mjs` 旧解析 | 旧行为测试；按新模块重写，不保留旧断言 |
| `package.json` 的 `pi-context`、`pi-goal-x`、`bootstrap-editor-theme`/`editor-theme` 导出 | 旧依赖/入口；必须删除 |

以下运行时字符串在 clean-break 完成后不得出现在 `src/` 与 `package.json` 的运行路径：`AgentSession.prototype`、`TUI.prototype`、`_goalCore`、`goalService.apply`、`PENDING_XDEV_COMPACTS`、`xd://context_compact`、`pi-goal-x`、`pi-context`、`bootstrap-editor-theme`。测试文件可以断言它们不存在，但不得把它们作为运行时分支保留。

不得删除的共享路径：根 `AGENTS.md`、`docs/**` 现有历史文档、`docs/manual-acceptance/clean-break/**`、已有 `plans/**` 用户产物、`.herd/**`（若存在）、`.herd-worktrees/**`（若存在）。删除任何共享路径必须单独一次、具名、可核对；不得在复合 shell 命令中夹带 `rm -rf`。

### 7.4 旧资产保留与哈希

| 资产 | 策略 | 证据 |
|---|---|---|
| 根 `AGENTS.md` | 字节不变；AI 不得改写；迁移前后各记 `sha256` | 哈希清单；差异即阻断 |
| `docs/旧的方法论.md`、`旧架构`、`旧设计.html`、`讨论纪要.md`、`兄弟项目参考.md` | 保留只读；不 import 到运行时；不重写 | 迁移前后哈希 |
| `docs/architecture.md`、`design.html`、`methodology.md` 的既有工作树删除 | 保持用户现状；先问是否恢复；若 clean-break 提交包含删除，必须在 `HISTORY.md` 记录来源、原因、日期 | `git status` 基线；`HISTORY.md` |
| 既有 `docs/manual-acceptance/**` 报告/证据 | 保留只读；不迁移成 `plans/`；不删除 | 哈希清单 |
| 本次 `docs/manual-acceptance/clean-break/requirements.md`、`development-guide.md` | 保留；S4 追加 `report.md` | 哈希 |
| 既有 `plans/**` 用户产物 | 保留；不被测试覆盖；不静默删除 | 哈希 |
| `README.md`、`CHANGELOG.md` | 可以改写/追加，但保留旧变更历史；README 不再指导旧依赖 | diff；旧条目仍在 |
| `DEBT.md` | 新建，只列未完成缺口；关闭即删 | 内容审查 |
| `HACK.md` | 新建，记录宿主深路径、`cherry-cljs` 版本/导出、git 拓扑、故障注入 | 内容审查 |
| `HISTORY.md` | 删除旧规则/旧产物/迁移时创建；记录来源、去向、原因、日期 | 内容审查 |
| `src/AGENTS.md` | 新建，写模块 DAG、装配边界、开发验收工具隔离 | 内容审查 |

### 7.5 `package.json` 目标

```json
{
  "name": "herdchestra-lite",
  "version": "1.0.0",
  "description": "vibe-workers as a proper multi-file omp plugin",
  "type": "module",
  "license": "MIT",
  "private": false,
  "omp": {
    "extensions": [
      "./src/bootstrap-main.mjs",
      "./src/tool-gate/index.mjs"
    ]
  },
  "pi": {
    "extensions": [
      "./src/bootstrap-main.mjs",
      "./src/tool-gate/index.mjs"
    ]
  },
  "exports": {
    ".": "./src/main.mjs",
    "./bootstrap-main": "./src/bootstrap-main.mjs",
    "./tool-gate": "./src/tool-gate/index.mjs",
    "./package.json": "./package.json"
  },
  "files": [
    "src/",
    "README.md",
    "CHANGELOG.md",
    "LICENSE"
  ],
  "engines": {
    "bun": ">=1.4.4"
  },
  "dependencies": {
    "cherry-cljs": "<exact-version-verified-in-HACK.md>"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.15"
  },
  "scripts": {
    "test": "bun test",
    "check": "biome check .",
    "format": "biome format --write ."
  }
}
```

- `cherry-cljs` 的精确版本在安装 spike 后写入；不得写范围版本。
- 不保留 `editor-theme` 导出、不保留 `bootstrap-editor-theme`。
- 根清单不得声明 DA；DA 使用自己的 `tools/dev-acceptance/package.json`。

### 7.6 开发验收工具的迁移

现状：`src/manual-acceptance/` 是开发验收工具，不是产品运行时；它被旧的 `src/main.mjs` 注册，导致产品入口与开发验收耦合。迁移策略：

1. **默认方案（推荐）**：迁一个 7 文件闭包到 `tools/dev-acceptance/`：`tools.mjs`、`constants.mjs`、`documents.mjs`、`requirements.mjs`、`index.mjs`、`util/atomic-write.mjs`、`util/errors.mjs`、`util/objects.mjs`；新增 `submit_manual_report`。`util/` 用本地副本，避免 DA 隐式依赖产品重构；若选择复用 `src/util`，必须在 DA 包中固定版本并做独立冒烟。
2. `contract.mjs`、`report.mjs`、`scores.mjs` 是纯 Node 函数但属于旧 manual-acceptance 语义；可以迁入 DA 作为纯函数（尤其是契约哈希校验与报告模板），但不得带入旧 goal 集成。`guards.mjs`、`auditor.mjs` 依赖 `host/goal-settings`/`host/capabilities`，不迁移。
3. **嵌套 `package.json` 不会在根插件被链接时自动加载**。DA 必须在独立 `HOME` 中用宿主等价命令单独 `omp plugin link tools/dev-acceptance`；不能只靠根 `omp.extensions` 发现。若把 DA 写进根 `omp.extensions`，18.x 的 `loadMode:"essential"` 会让三个 `submit_*` 工具常驻顶层，违反 CASE-39。
4. 不把 DA 放进根 `package.json` 的 `omp.extensions`/`pi.extensions`；不把 DA 工具注册进 `/herd` 运行时工具面。DA 不 import `pi-goal-x`/`pi-context`/`src/pi-*`。
5. **旧 `main.mjs` 无条件注入 `manual-protocol.mjs`**（`main.mjs` 导入并在每次 `before_agent_start` 追加）。新 `main.mjs` 必须移除这段注入；开发协议只由 DA 或宿主 skill 在开发验收会话提供，不能进入产品 S1 出站。
6. DA 的三个提交工具读取 `ctx.sessionManager.getBranch()` 的原始工具参数；G1 返回剥离后的 `{input}` 可能改变持久化形状。DA 必须在 CASE-34/39 中实测：只要 `goal_slug`/`case` 等业务字段仍在，就不依赖 `i`/gate 字段；若宿主只持久化剥离后参数，DA 读取逻辑必须按剥离后形状工作。
7. 若人类决定不保留 DA：删除整个目录，S4 使用宿主现有开发验收插件；产品运行时同样不受影响。

选择 DA 的判据：CASE-39 的工具列表不得出现重复的旧验收工具；DA 必须只在一个明确入口、一个独立 `HOME` 中注册；`/herd` 运行时工具列表不得出现 `submit_manual_*`。若做不到，删掉 DA，不要用“兼容”掩盖重复注册。

### 7.7 Git 与 worktree 处理

- 工作区 `.git` 当前实测指向共享 gitdir（`git worktree list` 第一条是 `/home/kunweiz/.cache/herdchestra-lite/gitdir`）；不得假设 `/tmp` 副本是独立仓库。迁移前后记录 `git rev-parse --show-toplevel --git-dir --git-common-dir` 与 `git worktree list`。
- `AGENTS.md`、`docs/manual-acceptance/`、`plans/` 可能未被跟踪；`git archive`/`git clean`/`git worktree add` 不保证带上它们。每个测试副本必须显式复制并校验哈希；Slice worktree 通过 C3 只读根访问主工作区契约，不依赖 worktree 内存在 `plans/`。
- 建议人类把根 `AGENTS.md` 纳入版本控制（人类仍是唯一修改者）；未获确认前，不 `git add`，测试副本显式补。
- `.gitignore` 至少补 `.herd/`；保留 `.herd-worktrees/`；不忽略 `plans/`。
- `plans/` 运行期测试产物留在 `/tmp` 副本，不提交进仓库；固定夹具放 `tests/fixtures/`，并标明不是用户交付物。
- worktree 的 `.git` 文件指向外部 gitdir；沙箱不得把 `.git` 当业务文件读取/写入；C3 的根策略拒绝 `.git`.
- worktree 不带未跟踪 `AGENTS.md`/`plans/`，也不带 `node_modules`；B1 必须显式 `git -C` 并校验 `--show-toplevel`；`call` 不得假设依赖已安装。

### 7.8 文档同步

同一次 cutover 内完成：

- `README.md`：只写新安装、两个入口、`/herd` 使用、`plans/` 产物；不出现旧依赖/旧命令。
- `src/AGENTS.md`：模块 DAG、装配边界、DA 隔离、错误码所有权。
- `DEBT.md`：只列相对 `AGENTS.md` 的未完成缺口；每项带条款、影响、处理建议；关闭即删。
- `HACK.md`：宿主深路径、`cherry-cljs` 版本/导出、`omp` 版本差异、git 拓扑、故障注入、已知平台限制。
- `HISTORY.md`：删除旧规则/旧产物/迁移时记录来源、去向、原因、日期。
- `CHANGELOG.md`：追加 clean-break 条目；不删除旧条目。
- 根 `AGENTS.md`：不修改；若发现文件名/引用不一致（`AGENTS-LITE.md`），列为待决问题，不擅自改名。

## 8. 真实宿主绑定与验证路径

### 8.1 清单绑定

- 根 `package.json` 的 `omp.extensions` 与 `pi.extensions` 都恰好两项，顺序为 `./src/bootstrap-main.mjs`、`./src/tool-gate/index.mjs`。
- M1 与 G1 都是默认导出工厂；宿主加载失败只影响该入口。
- 不依赖 `package.json` 的 `main`/`exports` 自动发现；宿主只读清单。
- 不在 `omp.extensions` 里声明 DA、主题入口、测试入口或 `src/main.mjs`。
- 18.x 的 `loadMode:"essential"` 可能让根入口注册的工具常驻顶层；因此根入口只放产品工具，DA 必须在独立 `HOME` 单独链接，不能靠嵌套 `package.json` 自动发现。

### 8.2 入口生命周期

```text
宿主加载 M1
  -> M1 try { const {default: activate} = await import("./main.mjs"); activate(pi); }
     catch -> H2.recordHealth(main, failed); 返回，不抛
宿主加载 G1
  -> G1 try { register hooks; H2.recordHealth(tool-gate, ok); }
     catch -> H2.recordHealth(tool-gate, failed); 返回，不抛
session_start
  -> M0 六窗口恢复 -> mission 注册表 -> TUI 挂载 -> 当前阶段工具面
```

- M1 的 loader 失败不得阻断 G1；G1 的失败不得阻断 M1。当前旧 bootstrap 没有 try/catch，只靠宿主 per-entry 捕获；新 M1/G1 必须自己 catch 并写 H2。
- 当前 `bootstrap-main` 是“全有或全无”：`main.mjs` 任一顶层 import/工厂步骤抛错，整个 main 入口被丢弃；因此 cherry/TUI/DA 必须惰性加载，非核心失败只降级。
- `bootstrap-main` 不得在模块顶层执行业务 I/O；只做惰性 import 与 catch。
- `tool-gate` 不得 import `main.mjs`；只 import G0/Q0/H2/U0。

### 8.3 钩子注册顺序

在 `activate(pi)` 中按固定顺序注册，避免同一事件多个 handler 的语义漂移：

1. `session_start`：恢复、聚焦、mission 注册表、TUI；
2. `before_agent_start`：系统提示词；
3. `context`：Q1 投影；
4. `before_provider_request`：Q1 缓存断点；
5. `tool_call`：阶段/角色/裸工具守卫；
6. `tool_execution_end`：事件与 health；
7. `agent_end`：Nudge。

G1 另注册 `before_provider_request` 与 `tool_call`；两个入口的 handler 必须幂等，先 block 生效。不得在 `tool_call` 中做长 I/O、等待子代理或改工作区文件。

`before_agent_start` 的 `systemPrompt` 是 `string[]`；`reason` 只有 18.16 类型有，缺失按 `"prompt"`。`tool_call` 的 `{input}` 只有 18.x 有，16.1.22 只有 `{block, reason}`。`agent_end` 与 `turn_end` 的 Nudge 触发点未定，必须先 Spike；不得把任一写成跨版本事实。

### 8.4 宿主能力与降级

| 能力 | 正常使用 | 缺失/降级 | 可观察结果 |
|---|---|---|---|
| `tool_call {input}` | 剥离 `scope`/`intent`/`must_think_in` | 只注入、不剥离；执行器忽略未知字段 | health 标 `inject-only`；工具仍可调用 |
| `before_agent_start` | 返回 `{systemPrompt: string[]}`；`reason` 缺失按 `"prompt"` | 单字符串/无 `reason` 时按数组与默认值适配 | health 记录 host 形状 |
| `ctx.agent` / 角色识别 | 无 `ctx.agent`，用 role token + 显式工具列表 | 无有效 token → fail-closed，不默认 Plan | 子会话工具面受限；health 记录 |
| `ctx.ui.setWidget` | 挂载 `HerdDashboardWidget` | 不挂载；`/herd-status` 文本同源 | health 标 `tui-text-only`；使命继续 |
| `ctx.ui.setHookWidget` | 不使用（宿主内部） | 只用 `setWidget` | 禁止调用；`HACK.md` 记录 |
| `runSubprocess.artifactsDir` | transcript 落盘（DevOps 报告为唯一开关；类型未核实） | 回执 `memoryOnly:true`；Agent Hub 仍可见 | 明示“仅内存可见”；不假装可重放 |
| `runSubprocess.settings` | 传 live `Settings` | 缺失时明确失败；不得落 `Settings.isolated()` | 保持 `@task` 模型/用户配置 |
| `runSubprocess.sessionFile` | 只作 follow-up 链接 | `artifactsDir` 存在时被忽略 | 不宣传父链；transcript 在 `artifactsDir/<id>.jsonl` |
| `runSubprocess` 模型 | pin 主模型/`@task` 角色 | `resolvedModelIsFallback` 可见；未授权 fallback fail-closed | 不静默换模型 |
| `eventBus` | 实时 progress | 无实时进度；Agent Hub 仍有身份 | health 标 `no-event-bus` |
| `setActiveTools` | `await` 后收敛启用集合；不注册工具 | G1 二次拒绝裸工具 | 拒绝码 `:CAPABILITY_DENIED` |
| `loadBundledAgents` | 从 `/task/agents` 导入 | 缺失时返回 `undefined`，不按名字假设 `task` | health 记录 |
| `ctx.signal` | 不确定；优先工具 `execute` 第 3 参数 | 不作为跨版本事实 | 取消仍可递归传播 |
| `cherry-cljs` | 沙箱可用 | 沙箱工具不可用；宿主/TUI/命令可用 | health 标 `sandbox-unavailable` |
| 长等待 | `advance_s1` 同步等待 | `:awaiting-user` + `pending-gate.edn` | 不重开阶段、不重复保存 |
| 主模型/`@task` 模型 | 正常 | 明确报错 | 不静默换模型 |
| 16.1.x 宿主 | 逐项能力探测 | 不承诺 18.x 独有字段（`{input}`/`reason`） | `HACK.md` 记录；CASE-33 用桩/真二进制 |
| 版本基线 | 运行时 `realpath` + `package.json` + 能力探测 | 版本号不一致不阻断，只记录/降级 | CASE-33/39 以行为为准 |

降级必须显式、可观察、用户可见；不得“放行并警告”安全相关校验。

### 8.5 真实加载证明（CASE-01/39 的前置）

每个测试副本执行以下步骤；这是验证路径，不是已执行结果：

0. 先解析实际运行时：`realpath` 入口、宿主 CLI 版本、运行时包 `package.json` 版本、类型包路径。当前机器可能读到 17.3.5、18.12.4、16.1.22 或仅 native 的 18.16.0；不得用 `@earendil-works/pi-coding-agent@1.5.2` 的类型冒充宿主，也不得伪造 18.16.0 本地类型。
1. 在 `/tmp/herd-acceptance-<CASE>-<uuid>/` 复制仓库，显式包含未跟踪的根 `AGENTS.md`、`docs/manual-acceptance/**`、局部 `AGENTS.md`、`DEBT.md`、`HACK.md`、`plans/**`；核对哈希。
2. 在副本放唯一标记文件 `.clean-break-marker-<uuid>`。
3. 用隔离 `HOME=/tmp/herd-home-<uuid>`，执行宿主等价命令 `omp plugin list`、`omp plugin link <副本>`；若需要 DA，也在同一隔离 HOME 单独链接 `tools/dev-acceptance`，不得把它写进根 `omp.extensions`。记录操作前后列表。
4. 启动 tmux 会话；`omp` 从副本启动；`/herd-status health` 输出入口 `import.meta.url`、CLI/运行时包/类型包版本、能力表、标记文件命中。
5. 记录入口 `realpath`、进程 cwd、`git rev-parse` 拓扑；证明不是 `/home/kunweiz/public/HerdchestraLite`。
6. 重命名 `src/tool-gate/index.mjs`，重启：M1 仍加载、`/herd` 可用、health 报 G1 失败；恢复。
7. 重命名 `src/bootstrap-main.mjs`，重启：G1 独立加载、宿主会话可用、health 报 M1 失败；恢复。
8. 若本机只有 17.3.5/18.12.4/16.1.22 而没有 18.16.0 JS 包，按实际版本记录并在 `HACK.md` 说明；不得把“没有类型包”当成通过。
9. 以上任一步不能证明加载本副本，CASE 无效，不得给分。

### 8.6 工具面绑定

- 使命激活后，M0 先 `registerTool`，再 `await pi.setActiveTools([...])` 只留当前角色工具与 Scope 辅助；`setActiveTools` 只选择启用集合，不注册工具。G1 在 `tool_call` 再次拒绝裸 `read`/`write`/`edit`/`bash`。
- 子代理工具面由 H1 的完整 `AgentDefinition.tools` 显式传入；不依赖宿主默认。
- 子代理角色用父进程 role token + `restrictToolNames` + `enableMCP/Lsp/Irc:false`；无有效 token 时 fail-closed，不默认成 Plan。
- 建议同时拒绝 `grep`/`glob`/`ls` 的仓库读取，防止绕过 `read-set`；该建议列入待决问题 11.12。
- `submit_*`、`advance_*`、`board_*`、`clj_*` 都需要 `scope`/`intent`；豁免仅 `ask_previous_scope`、`assume`。
- 命令补全只列已知使命与枚举值，不扫仓库。

### 8.7 模型绑定

- 主模型：`Coordinator`、`Plan`、`Reviewer`、`Manual Auditor`、`Blocker Oracle`。
- `@task` 模型：`Plan DevOps`、`Swarm Worker`、`Swarm Holder`。
- 必须传 live `Settings`；不传会落 `Settings.isolated()` 并丢 `@task` 配置。通过 `settings`/`modelRegistry`/`modelOverride` 传入；检查 `resolvedModelIsFallback`；不可用或未授权 fallback 明确报错，不静默换模型。
- `/herd-settings` 可改 `@task` 模型、槽位数、Nudge、Oracle 配额、审计并发/超时、worktree 保留、输出上限、语言、并发自检字段。

### 8.8 TUI 绑定

- 优先 `ctx.ui.setWidget(key, content, {placement:"aboveEditor"})`；组件工厂形式由 `render(width)` 返回固定行数。
- 只用公开 `setWidget`；`setHookWidget` 是宿主内部方法，禁止调用。`registerShortcut`/`ctx.ui.onTerminalInput` 处理展开/Esc/IME。
- 字符串数组最多 10 行，只作降级；`/herd-status verbose` 提供完整层级。
- `applyStableHeightBound` 在首个显示体制锁定行数；终端尺寸、紧凑/展开、审计阶段切换时重锁；不撑满终端、不抢滚屏。
- 挂载失败、窄屏、无颜色都不得阻断使命；PASS/FAIL 必须有文字。

### 8.9 证据布局

```text
docs/manual-acceptance/clean-break/
├── requirements.md
├── development-guide.md
├── coordination.md          # S3 产物
├── report.md                # S4 可见审计员写
└── evidence/
    └── <CASE-ID>/
        ├── commands.txt
        ├── run.log
        ├── tmux-*.txt
        ├── hashes-before.txt
        ├── hashes-after.txt
        ├── plugin-list.txt
        └── report.md
```

- 产品运行时证据仍在被测使命的 `plans/<slug>/evidence/<case-id>/`；两套路径不得混用。
- 每个 CASE 使用独立 `/tmp` 副本、独立 tmux、独立证据目录；不复用其他 CASE 的 `.herd/`、进程或证据。
- 主工作区在审计期间只读；前后各采集一次 `stamp` 与哈希清单。

### 8.10 手工验收执行路径

每个 CASE 的通用骨架：

1. 从同一目标提交创建全新 `/tmp` 副本，显式补齐未跟踪规格；记录基线。
2. 在隔离 `HOME` 中只链接副本；启动 tmux；证明入口指向副本。
3. 按 `requirements.md` 的 CASE 步骤操作；记录命令、退出码、关键输出、tmux 抓屏、文件哈希。
4. 破坏性步骤只在副本做；主工作区前后快照比对。
5. 按 CASE 评分细则独立打 `user_score`/`developer_score`；`final=min`；与阈值比较。
6. 写 `evidence/<CASE-ID>/report.md`，包含环境、步骤、证据路径、双视角理由、缺陷与限制。
7. 任何自动化测试只作诊断，不提高分数；环境失败记低于阈值，不跳过、不凭信通过。

### 8.11 内部诊断测试（不构成验收）

以下测试只保护内部不变量；不得作为任何 CASE 的通过证据：

| 测试文件 | 覆盖 |
|---|---|
| `tests/ufss.test.mjs` | 双射、围栏阶数、缩进、控制字符、100 KiB |
| `tests/where.test.mjs` | 唯一/多/零匹配、K=64、预算、200 字符截断 |
| `tests/evaluator.test.mjs` | 符号表隔离、CEK 挂起/恢复、期限、name/replay |
| `tests/vfs.test.mjs` | 顺序 VFS、结构冲突、上限、异常/park 零落盘、stamp |
| `tests/file-lock.test.mjs` | `wx`、agent_id/term_id 判活、PID 辅助、陈旧锁、锁序 |
| `tests/stages.test.mjs` | S1–S4 校验、CASE 解析、四哈希、重对齐 |
| `tests/board.test.mjs` | 拆分/父项/claim/cancel/replace/reopen/version |
| `tests/take-or-die.test.mjs` | T01–T13 确定性交错 |
| `tests/file-gate.test.mjs` | F01–F15 确定性交错 |
| `tests/audit.test.mjs` | 缺失/未知/重复/越界/空报告/快照/批准 |
| `tests/scope.test.mjs` | 四型、冷启、预算、全 meToo、投影 |
| `tests/tool-gate.test.mjs` | 五类 Schema 注入、幂等、剥离 |
| `tests/dashboard.test.mjs` | 紧凑/展开/审计/窄屏/降级模型 |
| `tests/recovery.test.mjs` | 六窗口、死 PID、`.tmp`、checkpoint、损坏 |
| `tests/nudge.test.mjs` | 出口抑制、退避序列、取消/断流区分 |

`bun test`/`biome` 的结果只用于诊断；CASE-01 明确要求它们不得加减分。

## 9. 失败隔离与降级

| 失败 | 影响范围 | 必须的行为 | 禁止 |
|---|---|---|---|
| M1 加载失败 | 主装配不可用 | G1 独立加载；health 报 M1；宿主会话不崩 | 阻断 G1/宿主 |
| G1 加载失败 | 注入/剥离不可用 | M1 仍加载；工具适配器二次校验；health 报 G1 | 阻断 `/herd` |
| `tool_call {input}` 缺失（16.x） | 剥离不可用 | 只注入、不剥离；执行器忽略未知字段；health 标 `inject-only` | 因缺 `{input}` 阻断所有工具 |
| `cherry-cljs` 加载失败 | 沙箱工具不可用 | 宿主/TUI/命令可用；health 报沙箱不可用 | 回退 JS 全局；假装可用 |
| `setWidget` 缺失 | TUI 不挂载 | `/herd-status` 同源文本；使命继续 | 阻断使命；两套状态逻辑 |
| `runSubprocess` 无 `artifactsDir` | transcript 不落盘 | 回执 `memoryOnly:true`；Agent Hub 可见 | 假装 `history://` 可重放 |
| `runSubprocess.settings` 缺失 | `@task` 模型/配置丢失 | 明确失败或按显式降级；不静默 `Settings.isolated()` | 丢配置后假装正常 |
| `sessionFile` 被忽略 | 父链不可用 | 用 `artifactsDir/<id>.jsonl` + `eventBus`；明示父链不可用 | 宣传 `sessionFile` 是父链接 |
| 子代理已死但 PID 仍活 | 陈旧锁误判 | U2 先查 `agent_id` 状态，再查 PID；runner 同事务释放 | 只靠 PID 判活；强夺活锁 |
| 宿主版本/类型包缺失 | 适配不可确定 | 运行时 `realpath` + `package.json` + 能力探测；`HACK.md` 记录 | 用 `@earendil-works` 类型或伪造 18.16 类型 |
| `manual-protocol.mjs` 进入产品 | S1 出站泄露 S2–S5 | 新 M0 不注入；DA 只在开发验收 HOME 提供 | 把开发协议注入 `/herd` |
| `resolvedModelIsFallback` 为真 | 模型被替换 | 未授权 fallback fail-closed；记录事件 | 静默接受 |
| DA 写入根 `omp.extensions` | `loadMode:"essential"` 使工具常驻 | 独立 `HOME` 单独链接；根只两入口 | 让 `submit_manual_*` 进入 `/herd` 工具面 |
| 宿主不能长等待 | S1 批准阻塞 | `:awaiting-user` + pending；下条消息恢复 | 自动批准；重开阶段 |
| 模型不可用 | 相关角色无法启动 | 明确报错；`/herd-settings` 可改 | 静默换模型 |
| 磁盘满/权限/I/O | 提交失败 | 目标保持完整旧/新；动作 `:uncertain`；记录已应用/未应用 | 整批标完成；自动回滚 |
| 锁持有者存活但无输出 | 等待 | 等待链可见；继续持有；不转交 | 超时强夺；杀持令者 |
| 锁持有者死亡 | 陈旧锁 | U2 先按 `agent_id`/`term_id` 判死，PID 辅助；30s 后标陈旧；repair/确认后备份清理 | 盲目删除；只看 PID |
| `board.edn` 损坏 | 控制状态 | 先备份；从 checkpoint/events 尝试；不能恢复则停止 | 静默新建空看板 |
| 删除 `.herd/` | 控制状态丢失 | 报告已丢失；不重建空状态 | 假装没发生 |
| 审计超时/崩溃 | 单 CASE | 视为未完成；重试/整批重跑；不得结案 | 当通过 |
| 主工作区审计期间被改 | 整批审计 | 整批作废；调查来源；重对齐/修复后重跑 | 混用旧现场结案 |
| 上游 429/5xx/断流 | 回合 | 5→10→20→40→80s 退避；记录预算 | 与用户取消混淆 |
| 配额/计费/无效 key | 上游 | `:STALLED`；不重试；暴露原因 | 空跑重试 |
| 用户取消 | 整棵会话树 | 递归 abort；`:cancelled`/`:outcome-unknown`；保留证据 | 只停主会话；自动重放 |
| 提示注入/伪批准 | 阶段 | 当数据；只认门禁回执；拒绝推进 | 从正文正则提取；相信 `<approved/>` |
| 密钥泄漏 | 交付物 | 停止、报告位置/影响；脱敏 | 继续结案；导出密钥 |

## 10. 已知困难与风险

| ID | 困难 | 影响 | 缓解/检测 |
|---|---|---|---|
| D1 | `cherry-cljs@0.6.38` 是编译器不是解释器：只导出 `compileString`/`compileStringEx`；无公开 EDN reader；不自动 await；`defprogram` 是普通函数；`mapv` + `js-await` 生成非法 JS；README 标 experimental | 直接依赖 Cherry 编译会把 S5 卡在 `defprogram`/park/async HOF | 采用自建 Promise-CPS 解释器；Cherry 只作数据/纯函数运行时；编译路径必须通过 §2.6.4 Spike；失败时沙箱不可用但不回退 JS |
| D2 | 白名单解释器与 cherry 编译器的边界 | 可能误放行 JS 全局或误拒合法 CLJS | 分析期符号白名单 + 运行期参数遮蔽；CASE-12 逐符号族验证 |
| D3 | 显式 CEK 续体与“JS 异步帧”措辞的差异 | 实现者可能误以为必须保存 Promise 帧 | 以可观察语义为准：局部变量/VFS/read-set/期限完整恢复；在 `src/AGENTS.md` 说明 |
| D4 | 纯 `loop/recur` 的期限检查 | 无步检查会无法停下 | CEK 每 1024 步检查时钟；步预算兜底；CASE-36 验证 deadline park |
| D5 | 未跟踪的根规格/`plans/` 不在 git worktree 中 | Slice 看不到契约 | C3 只读根白名单指向主工作区；不复制、不漂移；CASE-39 验证 |
| D6 | 共享 gitdir/外部 `.git` | worktree 路径/GC/锁可能误判 | 记录真实拓扑；worktree 只写数据面；`.git` 不可读；CASE-21/39 |
| D7 | 两个入口的模块实例可能不共享 | Scope/health/mission 状态分裂 | §2.5 全局 rendezvous；CASE-01/34 验证；若仍分裂，G1 自持账本并合并 |
| D8 | 宿主版本候选冲突：运行时 17.3.5、CLI 18.16.0、全局 16.1.22、Bun 缓存 18.12.4、自动更新 18.18.8、README 18.18.6；18.16.0 JS/types 不在本地；`@earendil-works` 1.5.2 不是运行时 | 钩子/`{input}`/`reason`/TUI/子代理字段不同；用错类型会写出假契约 | H0 运行时 `realpath` + `package.json` + 能力探测；`HACK.md` 记录三元组；CASE-33 以行为为准；不伪造 18.16 类型 |
| D9 | 五类 provider Schema 形状 | 注入遗漏或重复 | G0 递归/幂等；CASE-34 捕获原始 payload |
| D10 | 双块锚点与缓存前缀稳定 | 动态看板破坏缓存 | 稳定块/增量块分离；32 条/4 KiB 上限；CASE-35 |
| D11 | 子代理是进程内执行，所有子代理共享同一个 OS PID；PID 判活无法识别已死子代理 | 陈旧锁被当有效；recovery 误判 | 锁记录 `agent_id`/`term_id`/slice；先查 runner 状态再查 PID；死亡/退休/abort/槽位终止同事务释放；CASE-28 |
| D12 | 多文件提交不是组原子 | 崩溃后前缀已应用 | 动作记录 applied/pending/uncertain；不自动回滚/重放；CASE-10/15/17 |
| D13 | `call` 取消与外部副作用 | `:outcome-unknown` 难核对 | 四分类；先核对磁盘/Git/外部服务；不自动重放；CASE-17/29 |
| D14 | K 审计全并发与资源上限 | 排队被误读为串行 | 语义全启动；记录启动时间；CASE-23/36 |
| D15 | 报告/批准原子性与一次性 | 半提交/旧批准复活 | 报告原子写；批准绑定 revision；重算 token；CASE-24 |
| D16 | DA 与产品入口隔离：嵌套 `package.json` 不会随根链接自动加载；进根入口会被 `loadMode:"essential"` 常驻；旧 `main.mjs` 无条件注入 `manual-protocol.mjs` | 旧验收工具重复注册/污染 S1 出站 | DA 独立 HOME 单独链接；不写入根 `omp.extensions`；新 M0 不注入 manual-protocol；CASE-01/02/39 |
| D17 | 既有 docs 删除与保留策略 | 误恢复/误删除用户改动 | 先问人类；`HISTORY.md` 记录；不静默动共享路径 |
| D18 | `board_park_slot` 无法证明“未发现的拆分机会”不存在 | 可能过早休眠 | 结构检查覆盖已知任务/动作；模型仍须看板；CASE-20 验证已知工作拒绝 |
| D19 | `(mtime,size)` 判据会漏掉同值变更 | 覆盖风险 | 规格明确 best-effort；不宣传内容哈希；CASE-15 验证声明边界 |
| D20 | 确定性交错测试需要可控暂停点 | 随机调度掩盖缺陷 | 事件驱动器逐条注入；F01–F15/T01–T13 固定顺序；不靠“偶尔不出错” |
| D21 | `tool_call` 返回的 `{input}` 会成为持久化/显示/执行参数；旧 `rawToolArguments` 依赖 branch 原参数 | DA/回执读取可能失效；gate 字段可能泄漏或丢失 | 返回剥离后的新对象；DA 按剥离后形状实测；CASE-34/39 |
| D22 | `agent_end` 与 `turn_end` 都可能触发 Nudge；`agent_end` 有 `willContinue`/`awaitingAsyncWork` | 选错钩子会与宿主 auto-retry 叠加或漏 Nudge | §2.6.4 Host Spike 二选一；用 `sendMessage({triggerTurn:true})`；CASE-30 |
| D23 | `runSubprocess.settings` 默认 `Settings.isolated()`；`Settings.instance` 可能 throw | `@task` 模型/用户配置静默丢失 | H1 必传 live Settings；缺失明确失败；CASE-23/33 |
| D24 | `runSubprocess.sessionFile` 在 `artifactsDir` 存在时被忽略 | 父链/`history://` 预期落空 | transcript 用 `artifactsDir/<id>.jsonl`；不宣传父链；CASE-23/39 |
| D25 | worktree 不带未跟踪 `AGENTS.md`/`plans/`，也不带 `node_modules` | Slice 读不到契约或无法跑依赖测试 | C3 只读根；B1 显式 `git -C`/`--show-toplevel`；`call` 不假设 node_modules；CASE-21/39 |
| D26 | 无 `ctx.agent`/稳定的 `before_subagent_spawn`；子代理同进程 | 角色识别/工具面可能失控 | 父进程 role token + `AgentDefinition.tools` + `restrictToolNames`；无 token fail-closed；CASE-11/22/23 |
| D27 | `setHookWidget` 不是公开 `ExtensionUIContext` 方法 | 调用会失败或依赖内部 | 只用 `ctx.ui.setWidget`；CASE-27/33 |

## 11. 待决问题

以下问题不阻碍本指南成立，但会影响 S3/S4 的具体实现或验收环境；每项给推荐默认，最终由人类确认。

| ID | 问题 | 推荐默认 | 需要人类决定的原因 |
|---|---|---|---|
| Q1 | 根规格文件名 `AGENTS.md` 与文中 `AGENTS-LITE.md` 不一致 | 保留 `AGENTS.md` 为 SSOT，修正文中引用，不改名 | 改名会破坏人类路径与已有引用 |
| Q2 | DA 的最终位置/是否保留 | 保留 `tools/dev-acceptance/` 独立子包；不进入产品入口 | 影响 S4 报告工具与旧验收切换 |
| Q3 | 沙箱执行模型：自建解释器 vs 先做 Cherry 编译 spike | 默认自建 Promise-CPS 解释器；Cherry 只作数据运行时；编译路径仅在 §2.6.4 全通过后评估 | 这是架构单向门，需人类确认接受“不走 Cherry 编译” |
| Q4 | 手工验收参考宿主版本 | 以实际运行时 `realpath`/`package.json` 为准；本机候选 17.3.5/18.16.0/18.12.4/16.1.22；18.12.x 为规格目标 | 本地无 18.16.0 JS/types，不能伪造基线 |
| Q5 | 确定性故障注入 | 提供默认关闭、仅测试启用的注入点；写 `HACK.md` | 崩溃/429/资源不足分支需要可复现 |
| Q6 | 开发验收单 CASE 软时限 | 60 分钟；产品运行时审计仍 30 分钟 | CASE-37/21 可能超过 30 分钟 |
| Q7 | 既有 `docs/` 删除文件的保留策略 | 先保持用户现状；若提交包含删除，写 `HISTORY.md`；不静默恢复 | 当前工作树已删除三份跟踪文档 |
| Q8 | `plans/` 测试产物隔离 | 全部在 `/tmp` 副本产生；固定夹具放 `tests/fixtures/` | 避免把测试使命提交进仓库 |
| Q9 | 模型凭据与可用性 | 验收环境必须提供主模型与 `@task`；不可用记环境失败 | 不能跳过或凭信通过 |
| Q10 | `min(user_score, developer_score)` 是否加 Wow 门槛 | 按规格不加；Wow 折叠进两分 | 影响评分阈值 |
| Q11 | 唯一规范工作区/public 副本 | 本工作区为唯一规范副本；验收前隔离 public 链接 | 双副本并行会使加载证明失效 |
| Q12 | 根 `AGENTS.md` 是否纳入 Git；共享 gitdir 是否预期 | 建议纳入（人类仍唯一修改者）；记录 git 拓扑 | 影响副本/worktree 契约访问 |
| Q13 | 是否封禁宿主 `grep`/`glob`/`ls` 仓库读取 | 建议封禁，防止绕过 `read-set` | 可能影响非仓库类工具使用 |
| Q14 | 批准 token 的威胁模型 | 接受“完整性校验，不防文件系统所有者伪造” | 若要求防篡改，需要外部密钥/签名 |
| Q15 | `board_park_slot` 的“未发现拆分机会” | 结构检查 + 模型判断；不承诺形式化证明 | 规格要求与可计算性之间的边界 |
| Q16 | `tool_call` 返回 `{input}` 后的持久化语义 | 返回剥离后的新对象；DA 按剥离后参数实测；16.x inject-only | 影响 DA 的 `rawToolArguments` 与审计证据读取 |
| Q17 | Nudge 触发点 `agent_end` vs `turn_end` | 先 Spike；`agent_end.willContinue/awaitingAsyncWork` 参与判断 | 选错会与宿主 auto-retry 叠加或漏 Nudge |
| Q18 | `runSubprocess` 的 `settings`/`artifactsDir` 默认行为 | 必传 live `Settings` 与 `artifactsDir`；缺失明确失败/内存可见 | 影响 `@task` 模型、transcript 与 CASE-23 父链 |
| Q19 | DA 的独立链接方式 | 独立 `HOME` 单独 `omp plugin link tools/dev-acceptance`；不写根入口 | 嵌套 package 不会随根链接自动加载 |
| Q20 | worktree 无 `node_modules` 时的 `call` 测试 | `call` 不假设依赖存在；需要时显式在 worktree 安装或使用主工作区命令 | 影响 CASE-21/37 的施工与测试路径 |

## 12. 实施顺序与最小完整件

### 12.1 最小完整件（Gall 定律）

每个最小件必须独立可运行、可诊断，再组合：

0. Host/Sandbox/Lock/Git Spike：按 §2.6.4 跑通；任一失败先修设计或记 `DEBT.md`，不得进入 S3 冻结。
1. `U0/U1/U2`：错误 + 原子写（含 `fsync`）+ 锁（含 `agent_id`/`term_id`）。完成条件：并发锁/原子写测试通过。
2. `C0/C1`：UFSS + where。完成条件：双射/诊断测试通过。
3. `C2/C3`：自建 Promise-CPS 解释器 + VFS。完成条件：挂起/恢复、零落盘、stamp、async HOF 测试通过。
4. `C4`：角色能力矩阵。完成条件：六角色越权测试通过。
5. `G0/G1 + Q0/Q1`：门禁注入/剥离 + Scope/投影。完成条件：五类 Schema、四型 Scope、投影测试通过。
6. `T0/T1/T2`：披露 + 解析 + 契约。完成条件：S1–S4 校验/冻结/重对齐测试通过。
7. `T3/T4`：门禁工具 + 汇总。完成条件：S1 批准/S2–S4 自动/报告测试通过。
8. `B0/B1`：看板 + worktree。完成条件：T01–T13/F01–F15/FIFO/ff 测试通过。
9. `B2/B3`：任期 + 审计。完成条件：findings/Quiescence/继任/K 审计测试通过。
10. `P0–P2/V0/V1/M0/M1/G1`：提示词/TUI/装配/入口。完成条件：零剧透、双入口、降级、`setActiveTools`/`setWidget`/`tool_call input` 冒烟通过。
11. `DA`：开发验收工具。完成条件：独立 HOME 单独链接后提交/报告可用，不进入产品工具面。

### 12.2 并行工作包（供 S4 切片参考）

以下不是 S4 的正式 Slice；S4 必须按“互不相交的目标”重新切：

| 工作包 | 可并行输入 | 输出 | 共享契约 |
|---|---|---|---|
| WP1 基础 | 无 | U0–U2、H2 | 错误码、原子写、锁内容 |
| WP2 UFSS/where | WP1 | C0、C1 | `readUfss`/`printUfss`、span 形状 |
| WP3 CEK/VFS | WP1、WP2 | C2、C3 | 程序状态、stamp、提交结果 |
| WP4 角色工具 | WP3 | C4 | 能力矩阵、工具参数 |
| WP5 门禁/Scope | WP1、WP2 | G0、G1、Q0、Q1 | 字段名、四型、投影规则 |
| WP6 阶段 | WP1、WP2、WP5 | T0–T4 | case/module/slice 形状、mission.edn |
| WP7 看板 | WP1、WP6 | B0 | board.edn、错误码、责任集合 |
| WP8 worktree/任期 | WP1、WP6、WP7 | B1、B2 | fork/join 返回、Quiescence |
| WP9 审计 | WP1、WP6、WP7、WP8 | B3、T4 | submission schema、报告 |
| WP10 界面/装配 | 全部 | P0–P2、V0、V1、M0、M1、G1 | 提示词、命令、TUI 模型 |
| WP11 DA | WP1 | DA | 三份文档 + 报告 |

并行约束：WP3 依赖 WP2 的 span 形状；WP6 依赖 WP5 的字段；WP8 依赖 WP7 的看板命令；WP9 依赖 WP8 的 join 与 WP6 的评估。其余可立即并行。

### 12.3 每步的验证边界

- 每步只跑该步的诊断测试；不跑全仓库大套件；后续改动会使早期结果失效。
- 手工 CASE 只在 S4 执行；内部测试不得写成验收证据。
- 每个工作包交付时附：改动的文件、接口、错误码、诊断测试、未决风险。

## 13. 完成定义与交接

### 13.1 本文完成定义

本文作为 S2 交付物完成，当且仅当：

- 39 个 CASE 全部有模块/接口/验证路径映射；
- 模块 DAG 无环，依赖方向与 `AGENTS.md` §9.1 一致；
- 每个模块声明 `secret_owned`、公开契约、状态与失败语义；
- 迁移步骤、删除/保留清单、`package.json` 目标、DA 隔离、git/worktree 处理可执行；
- 真实宿主加载证明、能力降级、证据布局、手工执行骨架可执行；
- 已知困难与待决问题显式列出；
- 全文没有把未执行的 CASE 写成已通过，没有修改根 `AGENTS.md`。

### 13.2 交给 S3 的输入

S3 协调手册应直接使用：

- §2.3 模块清单作为 `modules` 数组的来源；
- §5 逐 CASE 映射作为 `mapped_cases` 的来源；
- §7 迁移步骤作为 Slice 的 `inputs`/`done_when`；
- §8 宿主绑定与证据布局作为跨 Slice 共享契约；
- §10 已知困难作为风险登记；
- §11 待决问题作为人类确认项。

### 13.3 交给 S4 的边界

- S4 只执行手工验收，不把内部测试当证据；
- 每个 CASE 独立副本、独立证据、独立评分；
- 主工作区审计期间只读；
- 任何环境失败记低于阈值，不跳过；
- 报告写 `docs/manual-acceptance/clean-break/report.md`；
- 根 `AGENTS.md` 的哈希必须与基线一致，除非人类明确修改并留证。

### 13.4 不声称的事项

本文没有声称：

- 任何 CASE 已执行或通过；
- 任何模块已实现；
- `cherry-cljs` 已加载；
- `omp` 已加载本工作区；
- 旧资产已迁移；
- 任何分数已产生。

## 附录 A：模块清单（S3 `modules` 数组来源）

```text
src/host/imports.mjs            secret=宿主/cherry 唯一导入与能力探测      depends_on=-
src/host/subprocess.mjs         secret=子代理完整定义/abort/artifacts       depends_on=src/host/imports.mjs,src/host/health.mjs,src/util/errors.mjs
src/host/health.mjs             secret=跨入口健康登记                      depends_on=-
src/util/errors.mjs             secret=错误码/EDN 诊断                     depends_on=-
src/util/atomic-write.mjs       secret=同目录 tmp+fsync+rename             depends_on=src/util/errors.mjs
src/util/file-lock.mjs          secret=wx 锁/agent_id+term_id/PID辅助/锁序  depends_on=src/util/errors.mjs,src/util/atomic-write.mjs
src/clj-sandbox/ufss.mjs        secret=自建 EDN+UFSS 双射                    depends_on=src/util/errors.mjs
src/clj-sandbox/where.mjs       secret=UTF-16 切片/Ukkonen                 depends_on=src/util/errors.mjs
src/clj-sandbox/evaluator.mjs   secret=白名单/CEK/续体/期限                depends_on=src/clj-sandbox/ufss.mjs,src/clj-sandbox/where.mjs,src/host/imports.mjs,src/util/errors.mjs
src/clj-sandbox/vfs.mjs         secret=批内 VFS/stamp/提交                 depends_on=src/util/errors.mjs,src/util/atomic-write.mjs,src/util/file-lock.mjs
src/clj-sandbox/tools.mjs       secret=角色能力矩阵/clj_*                  depends_on=src/clj-sandbox/evaluator.mjs,src/clj-sandbox/vfs.mjs,src/clj-sandbox/where.mjs,src/clj-sandbox/ufss.mjs
src/tool-gate/schema.mjs        secret=五类 Schema 注入/剥离               depends_on=src/util/errors.mjs
src/tool-gate/index.mjs         secret=入口 2/准入/裸工具封禁              depends_on=src/tool-gate/schema.mjs,src/scope/ledger.mjs,src/host/health.mjs,src/util/errors.mjs
src/scope/ledger.mjs            secret=四型/预算/归档                      depends_on=src/util/errors.mjs
src/scope/projection.mjs        secret=出站裁剪/锚点/缓存断点              depends_on=src/scope/ledger.mjs,src/util/errors.mjs
src/stages/disclosures.mjs      secret=S1–S5 简报                          depends_on=-
src/stages/parsers.mjs          secret=S1–S4 校验/CASE/DAG                 depends_on=src/util/errors.mjs
src/stages/contract.mjs         secret=mission.edn/冻结/批准               depends_on=src/util/errors.mjs,src/util/atomic-write.mjs,src/util/file-lock.mjs
src/stages/gate-tools.mjs       secret=门禁事务/ask/devops/review          depends_on=src/stages/disclosures.mjs,src/stages/parsers.mjs,src/stages/contract.mjs,src/host/subprocess.mjs,src/host/health.mjs,src/swarm/worktree.mjs,src/util/errors.mjs
src/stages/scores.mjs           secret=审计汇总/report/批准                depends_on=src/stages/parsers.mjs,src/stages/contract.mjs,src/util/atomic-write.mjs,src/util/errors.mjs
src/swarm/board.mjs             secret=看板短事务/令牌/责任                depends_on=src/util/errors.mjs,src/util/atomic-write.mjs,src/util/file-lock.mjs
src/swarm/worktree.mjs          secret=worktree/FIFO/ff/GC                 depends_on=src/util/errors.mjs,src/util/file-lock.mjs,src/stages/contract.mjs
src/swarm/runner.mjs            secret=任期/槽位/Nudge/Oracle/恢复         depends_on=src/swarm/board.mjs,src/swarm/worktree.mjs,src/stages/contract.mjs,src/host/subprocess.mjs,src/host/health.mjs,src/util/errors.mjs
src/swarm/auditors.mjs          secret=K 审计/快照/返工                    depends_on=src/swarm/board.mjs,src/stages/parsers.mjs,src/stages/contract.mjs,src/stages/scores.mjs,src/host/subprocess.mjs,src/host/health.mjs,src/clj-sandbox/tools.mjs,src/util/errors.mjs
src/prompts/common.mjs          secret=COMMON 文本                         depends_on=-
src/prompts/roles.mjs           secret=角色提示词/审计员模板               depends_on=-
src/prompts/runtime-wires.mjs   secret=语言后缀/Nudge/门字段               depends_on=-
src/tui/dashboard-model.mjs     secret=纯看板/审计视图                     depends_on=src/util/errors.mjs
src/tui/dashboard-widget.mjs    secret=双态渲染/稳定高度/降级              depends_on=src/tui/dashboard-model.mjs,src/host/imports.mjs,src/host/health.mjs,src/util/errors.mjs
src/main.mjs                    secret=装配/命令/生命周期                  depends_on=src/host/imports.mjs,src/host/subprocess.mjs,src/host/health.mjs,src/util/errors.mjs,src/util/atomic-write.mjs,src/util/file-lock.mjs,src/clj-sandbox/ufss.mjs,src/clj-sandbox/where.mjs,src/clj-sandbox/evaluator.mjs,src/clj-sandbox/vfs.mjs,src/clj-sandbox/tools.mjs,src/tool-gate/schema.mjs,src/scope/ledger.mjs,src/scope/projection.mjs,src/stages/disclosures.mjs,src/stages/parsers.mjs,src/stages/contract.mjs,src/stages/gate-tools.mjs,src/stages/scores.mjs,src/swarm/board.mjs,src/swarm/worktree.mjs,src/swarm/runner.mjs,src/swarm/auditors.mjs,src/prompts/common.mjs,src/prompts/roles.mjs,src/prompts/runtime-wires.mjs,src/tui/dashboard-model.mjs,src/tui/dashboard-widget.mjs
src/bootstrap-main.mjs          secret=入口 1 惰性加载                     depends_on=src/main.mjs,src/host/health.mjs
```

`DA` 不属于产品 S3 `modules` 数组；它由开发流程单独维护。S3 门禁要求 `depends_on` 只引用已声明模块、无环；上表已使用完整仓库相对路径。

## 附录 B：目标目录树

```text
src/
├── bootstrap-main.mjs
├── main.mjs
├── AGENTS.md
├── host/
│   ├── imports.mjs
│   ├── health.mjs
│   └── subprocess.mjs
├── util/
│   ├── errors.mjs
│   ├── atomic-write.mjs
│   └── file-lock.mjs
├── clj-sandbox/
│   ├── ufss.mjs
│   ├── where.mjs
│   ├── evaluator.mjs
│   ├── vfs.mjs
│   └── tools.mjs
├── tool-gate/
│   ├── index.mjs
│   └── schema.mjs
├── scope/
│   ├── ledger.mjs
│   └── projection.mjs
├── stages/
│   ├── disclosures.mjs
│   ├── parsers.mjs
│   ├── contract.mjs
│   ├── gate-tools.mjs
│   └── scores.mjs
├── swarm/
│   ├── board.mjs
│   ├── worktree.mjs
│   ├── runner.mjs
│   └── auditors.mjs
├── prompts/
│   ├── common.mjs
│   ├── roles.mjs
│   └── runtime-wires.mjs
└── tui/
    ├── dashboard-model.mjs
    └── dashboard-widget.mjs

tools/
└── dev-acceptance/
    ├── package.json
    ├── index.mjs
    ├── tools.mjs
    ├── documents.mjs
    ├── requirements.mjs
    ├── constants.mjs
    ├── report-tool.mjs
    └── util/
        ├── atomic-write.mjs
        ├── errors.mjs
        └── objects.mjs
```

`tests/` 按 §8.11 命名；`docs/`、`plans/`、`.herd/`、`.herd-worktrees/` 不在产品包内。`tools/dev-acceptance/` 不进入产品包，不在根 `omp.extensions`。

## 附录 C：错误码所有权

| 错误码 | 生产模块 | 消费/恢复 |
|---|---|---|
| `:SLUG_TAKEN`、`:STAGE_MISMATCH` | T2/T3 | 门禁拒绝；状态不变 |
| `:CALL_REPLAY_MISMATCH` | T2/T3/B0/C2 | 返回原回执或拒绝 |
| `:CONTRACT_HASH_MISMATCH` | T2 | 拒绝 S5/结案；要求重对齐 |
| `:APPROVAL_REQUIRED` | T4 | 拒绝 `:completed` |
| `:INSUFFICIENT_WORKTREES` | B1 | Coordinator 降数重试 |
| `:RESOURCES_NOT_QUIESCENT`、`:FF_NOT_READY` | B2 | Reviewer 空账拒绝 |
| `:NO_RESULTS` | B1 | Coordinator 决定 re-fork/re-plan/终止 |
| `:BOARD_CONFLICT`、`:TASK_NOT_READY`、`:CLAIM_CHANGED`、`:PARENT_NOT_READY`、`:TASK_HAS_CHILDREN` | B0 | 看板拒绝；返回最新树/可推进摘要 |
| `:TOKEN_REQUIRED`、`:CONFIRMATION_REQUIRED`、`:TENURE_RETIRED`、`:ACTOR_DEAD` | B0/B2 | 拒绝越权/迟到/死身份 |
| `:FILE_CONFLICT`、`:STRUCTURE_CONFLICT`、`:PREPARE_REJECTED`、`:LIMIT_EXCEEDED`、`:changed-during-read`、`:PATH_ESCAPE`、`:NOT_UTF8` | C3 | 零触盘/阻断；重新读取或拆分 |
| `:OUTPUT_TRUNCATED` | C4 | 返回日志路径与截断标记 |
| `:CAPABILITY_DENIED` | C2/C4/G1 | 拒绝越权；不改变现场 |
| `:PROGRAM_UNKNOWN`、`:STALE_CONTROL`、`:INVALID_ARGUMENT`、`:NAME_TAKEN` | C2 | 续体拒绝 |
| `:UFSS_INDENT_VIOLATION`、`:UFSS_UNCLOSED` | C0 | 解析拒绝；精确位置 |
| `:SCOPE_UNINITIALIZED`、`:SCOPE_BUDGET_SPENT`、`:SCOPE_INVALID`、`:INTENT_REQUIRED` | Q0/G1 | 准入拒绝；工具不执行 |
| `:ASK_FORBIDDEN_OUTSIDE_S1` | T3 | 拒绝非 S1/非初任空账询问 |
| `:AUDIT_MISSING`、`:AUDIT_UNKNOWN_CASE`、`:AUDIT_DUPLICATE_CASE`、`:AUDIT_INVALID_SCORE`、`:AUDIT_EVIDENCE_MISSING`、`:AUDIT_WORKSPACE_MUTATED`、`:AUDIT_TIMEOUT`、`:AUDIT_ABORTED` | B3/T4 | 拒绝结案；返工/重跑 |
| `:STALLED`、`:UPSTREAM_ABORTED` | B2 | 停/退避；不重试确定性错误 |
| `:AGENT_SPAWN_FAILED` | H1 | 保留槽位/责任；重启补位 |
| `:NO_PROGRESSABLE_WORK` | B0 | `park_slot` 正向回执/拒收摘要 |
| `:HOST_API_MISMATCH` | H0/H2 | 记录实际版本/形状；相关能力降级或明确失败 |
| `:SETTINGS_UNAVAILABLE` | H1 | 不静默 `Settings.isolated()`；明确报错 |
| `:MODEL_FALLBACK` | H1 | 未授权 fallback fail-closed |
| `:LOCK_OWNER_DEAD` | U2 | 按 agent_id 判陈旧；repair 备份后清理 |

新增错误码必须在 `src/AGENTS.md` 与 `DEBT.md` 登记，并补对应 CASE 或说明为何不影响验收。

## 附录 D：证据与报告骨架

每个 CASE 的 `evidence/<CASE-ID>/report.md` 至少包含：

```text
# <CASE-ID> 手工验收证据
- 执行者/时间/环境/宿主版本/模型
- 加载证明：plugin list、入口 realpath、标记文件、cwd
- 基线：HEAD、git status、主工作区哈希/时间戳
- 逐步骤：命令、退出码、关键输出、tmux 抓屏路径与可见行
- 文件证据：路径、sha256、stamp
- 双视角评分理由：user_score、developer_score、final=min、threshold
- 缺陷/限制/未覆盖路径
- 结论：PASS/FAIL（仅按细则）
```

`docs/manual-acceptance/clean-break/report.md` 由 S4 可见审计员写；它汇总所有 CASE 的得分表、证据路径、审计员报告全文、总判定、限制与教训。产品运行时的 `plans/<slug>/s5-report.md` 是另一套产物，不得混用。
