# HerdchestraLite 当前架构

> 快照：2026-11-10（S13 审计后核对），取自工作树而非某个提交。目录以磁盘与 `git ls-files` 为准。

旧设计说明全文在 `docs/design.html`：由原 `README.html` 逐字节复制，原文未改（121466 字节，sha256 `972f28733c05e5713c770fb82d6b634527d17fa4b156296200061227c23977fb`）。本文件只记录当前实现，不转述、不压缩、不替代它的任何内容。

## 加载契约

`package.json` 的 `omp.extensions` 与 `pi.extensions` 按同一顺序列出三个入口：

1. `./src/bootstrap-main.mjs`
2. `./src/tool-gate/index.mjs`
3. `./src/bootstrap-editor-theme.mjs`

`.mjs` 只能经 `omp plugin link` 或 `config.yml#extensions` 加载，目录自动扫描不认它。`bootstrap-*` 的默认导出是异步函数，调用时才动态加载真实模块；tool-gate 入口直接导出同步工厂。工厂只注册事件、工具和命令；真实模块求值期的副作用只有 P1 读取 `SKILL.md` 与 editor-theme 安装 TUI 原型面。

## 目录（当前）

```text
src/
├── bootstrap-main.mjs           # 清单入口：惰性 import ./main.mjs
├── bootstrap-editor-theme.mjs   # 清单入口：惰性 import ./editor-theme/index.mjs
├── main.mjs                     # 真实主模块：组合五个域
├── context/
│   ├── vibe-suffix.mjs          # 后缀常量与消息投影
│   └── vibe-context-rewrite.mjs # 两段文案替换
├── prompts/
│   ├── repo-aware-rules.mjs     # P2 规则文本
│   ├── manual-protocol.mjs      # P3 手动验收协议
│   ├── context-skill.mjs        # P1 读取 pi-context 的 SKILL.md
│   ├── plan-only.mjs            # P5 goal 草稿改写
│   └── auditor.mjs              # P6 审计员提示词
├── host/
│   ├── imports.mjs              # 宿主与依赖的深路径导入
│   ├── capabilities.mjs         # 能力探测与不可用错误
│   ├── goal-settings.mjs        # goal 设置文件读取
│   └── subprocess.mjs           # runSubprocess 审计适配
├── pi-context/
│   ├── facade.mjs               # PiFacade 与 /acm 适配
│   ├── command-context.mjs      # 命令上下文与 session manager 视图
│   ├── session-capture.mjs      # AgentSession.getContextUsage 捕获
│   └── xdev-compact.mjs         # PENDING_XDEV_COMPACTS 与 branch 改写
├── pi-goal/
│   ├── facade.mjs               # GoalPiFacade、/goal→/goal-x、延迟 flush
│   ├── tool-wrap.mjs            # 工具包装与 gated fail-closed
│   ├── install-auditor.mjs      # 按 GoalCore 安装审计器
│   └── ui.mjs                   # goalUi proxy 与 sleep
├── manual-acceptance/
│   ├── constants.mjs            # 路径、正则、报告 schema、允许字段
│   ├── requirements.mjs         # CASE 解析
│   ├── contract.mjs             # 契约解析、冻结、文档校验
│   ├── documents.mjs            # 文档读写（底层 util/atomic-write）
│   ├── tools.mjs                # 三个 submit_* 工具
│   ├── guards.mjs               # propose / update 守卫
│   ├── auditor.mjs              # 可见审计员运行
│   ├── scores.mjs               # verdictFromScores
│   └── report.mjs               # 报告构建与写入
├── tool-gate/
│   ├── index.mjs                # 入口：注入与剥离两个门参数
│   ├── schema.mjs               # 门参数定义与 schema 注入
│   └── strip.mjs                # 执行前剥离门参数
├── editor-theme/
│   ├── index.mjs                # 入口：初次失败时重试
│   └── surface.mjs              # TUI 原型面与 readTheme
└── util/
    ├── atomic-write.mjs         # 同目录临时文件 + rename
    ├── errors.mjs               # messageOf / errorCode
    └── objects.mjs              # isObject / unknownFields
```

`src/` 共 40 个 `.mjs`。`docs/` 有 `architecture.md` 与 `design.html`；`tests/` 有六个测试文件，只测纯函数与文件工具。

## 入口现状

| 入口 | 当前注册内容 | 状态 |
| --- | --- | --- |
| `src/bootstrap-main.mjs` | 惰性调用 `src/main.mjs` 的默认工厂；真实注册内容：`before_agent_start` 拼 P2+P1+P3；`context` 改写 `vibe-mode-context` 与用户/工具结果后缀；`installLiveSessionCapture`；pi-context facade 与 `/acm`；goal facade 与 `/goal-x`；三个 `submit_*`；审计器安装与 `session_start` 重试 | 已接线 |
| `src/tool-gate/index.mjs` | `before_provider_request` 注入两个必填参数；`tool_call` 剥离它们 | 已接线 |
| `src/bootstrap-editor-theme.mjs` | 惰性调用 `src/editor-theme/index.mjs` 的默认工厂；真实模块求值时装 TUI 原型面；只有初次安装结果为 `unavailable` 时，才在每次 `session_start` 重试并向 `ctx.ui.notify` 报一次警告 | 已接线 |

## 模块导出

| 文件 | 主要导出 | 职责 |
| --- | --- | --- |
| `bootstrap-main.mjs` | 默认异步工厂 | 只动态 `import("./main.mjs")`，把 `pi` 传给其默认导出 |
| `bootstrap-editor-theme.mjs` | 默认异步工厂 | 只动态 `import("./editor-theme/index.mjs")`，把 `pi` 传给其默认导出 |
| `main.mjs` | 默认工厂 | 按固定顺序装配五个域；不承载解析、审计或计分业务 |
| `context/vibe-suffix.mjs` | `VIBE_CONTEXT_SUFFIX`、`projectVibeSuffix` | 只处理 `user` 与 `toolResult`；字符串内容拆成 `[text, suffix]`，数组内容追加 text 元素；始终构造新对象 |
| `context/vibe-context-rewrite.mjs` | `rewriteVibeModeContext` | 按固定顺序做两段 `replace`；两段都未命中时返回原字符串 |
| `prompts/repo-aware-rules.mjs` | `REPO_AWARE_RULES` | 冻结的规则文本数组 |
| `prompts/manual-protocol.mjs` | `MANUAL_ACCEPTANCE_PROTOCOL` | 手动验收协议文本 |
| `prompts/context-skill.mjs` | `loadContextManagementSkill` | 先按 `import.meta.resolve` 找，再回退相对路径；失败时 `console.error` 并返回空串 |
| `prompts/plan-only.mjs` | `adaptGoalDraftPrompt` | 只在内容含 `[GOAL CONFIRMATION` 时追加 Plan-only 段落 |
| `prompts/auditor.mjs` | `buildManualAcceptancePrompt` | 组装审计员提示词；XML 转义在本地，报告 schema 来自 `manual-acceptance/constants.mjs` |
| `host/imports.mjs` | `AgentSession`、`Settings`、`goalExtension`、`goalSettingsPath`、`loadBundledAgents`、`loadGoalSettingsFileConfig`、`piContextExtension`、`runSubprocess` | 全部宿主与依赖导入集中在此 |
| `host/capabilities.mjs` | `requireGoalCore`、`requireDependencies`、`confirmAuditorReplacement`、`settingsScope`、`bundledAgents`、三个错误文本 | 内部 API 能力探测；不可用时明确报错 |
| `host/goal-settings.mjs` | `isGoalAuditorDisabled`、`GOAL_AUDITOR_DISABLED_MESSAGE` | 读取项目 goal 设置；文件缺失返回 `false`，不可读、非法 JSON 或类型不符返回 `undefined` |
| `host/subprocess.mjs` | `runAuditSubprocess` | 用旧参数集调用 `runSubprocess`，原样返回结果 |
| `pi-context/facade.mjs` | `createPiFacade` | 补 PiFacade：`/acm`、自动激活、xdev 改写、entry label |
| `pi-context/command-context.mjs` | `createPiContext`、`createCommandContext` | 构造命令上下文；`getBranch` 在 xdev pending 时返回改写副本 |
| `pi-context/session-capture.mjs` | `installLiveSessionCapture`、`liveAgentSession` | 用 `WeakSet` 防止重复补丁；`WeakRef` 保存会话 |
| `pi-context/xdev-compact.mjs` | `PENDING_XDEV_COMPACTS`、`beginXdevCompact`、`clearXdevCompact`、`pendingXdevCompact`、`isXdevCompactCall`、`rewriteXdevCompactBranch` | 记录并改写 `write xd://context_compact` 调用；30 秒定时器 |
| `pi-goal/facade.mjs` | `createGoalFacade` | 五组 pending 容器在 `session_start` 前排队，之后一次性 flush；`/goal` 改名为 `/goal-x` |
| `pi-goal/tool-wrap.mjs` | `wrapGoalTool`、`runGoalToolGuards` | gated 工具先重试安装审计器，再跑守卫；失败即抛错 |
| `pi-goal/install-auditor.mjs` | `installManualAcceptanceAuditor`、`installManualAcceptanceAuditorOnCore`、`isManualAcceptanceAuditorInstalled`、`clearManualAcceptanceApproval` | 用 `WeakSet` 按 GoalCore 跟踪已安装的审计器；包装 `goalService.apply`，拒绝没有本次批准（goal id + revision）的 `complete` 写入，`archive` 路径放行 |
| `pi-goal/ui.mjs` | `goalUi`、`sleep` | 缺 `setWorkingVisible` 时用 Proxy 补空实现；`sleep` 用 `setTimeout` |
| `manual-acceptance/constants.mjs` | 根目录与四个文件名、slug/CASE/阈值/路径/rubric 正则、`MANUAL_REPORT_SCHEMA`、允许字段、自动化验收模式、契约正则 | 常量集中处，不依赖其他域模块 |
| `manual-acceptance/requirements.mjs` | `parseRequirementCases` | 解析 `### CASE-*` 标题、阈值、路径、rubric；失败时抛错 |
| `manual-acceptance/contract.mjs` | `manualAcceptanceContractLine`、`parseManualContractParts`、`parseManualContract`、`manualAcceptanceDirectory`、`manualAcceptanceFrozenLine`、`freezeManualAcceptanceObjective`、`manualProposeGateRejection`、`validateManualDocuments`、`manualAcceptanceEffectiveContract` | 契约行取最后一条；hash 键归一化；冻结写回最后一行；逐文档校验存在与哈希 |
| `manual-acceptance/documents.mjs` | `manualAcceptanceDocumentSlots`、`manualAcceptanceDir`、`manualAcceptanceRelativePath`、`readManualAcceptanceDocuments`、`manualAcceptanceWriteDocument`、`manualAcceptanceWriteErrorText`、`manualAcceptanceDocumentError` | slug 校验失败时抛错；写入返回“是否已存在”，底层是 `writeFileAtomic` |
| `manual-acceptance/tools.mjs` | `registerManualAcceptanceTools` | 注册三个 `submit_*`；原始参数与 CASE 校验是模块内私有函数 |
| `manual-acceptance/guards.mjs` | `proposeManualAcceptanceGuard`、`updateManualAcceptanceGuard`、`goalToolGuards`、`runGoalToolGuards` | 创建时校验契约与文档；完成时校验 CASE 与文档；第一条拒绝文本生效 |
| `manual-acceptance/auditor.mjs` | `runVisibleManualAcceptanceAuditor` | 单实例、60 分钟超时、子进程审计、yield 解析、报告与判定 |
| `manual-acceptance/scores.mjs` | `verdictFromScores` | 每个 CASE 取 `min(user_score, developer_score)`，汇总缺失、重复、未知、越界 |
| `manual-acceptance/report.mjs` | `buildReport`、`writeManualReport` | 构建 Markdown 报告；用原子写落到 `report.md` |
| `tool-gate/schema.mjs` | `WORKERS_PARAMETER`、`THINK_PARAMETER`、`injectToolSchemas` | 两个参数名逐字固定；只改对象型 schema |
| `tool-gate/strip.mjs` | `stripGateParameters` | 输入不含两个参数时返回 `undefined`，其余情况返回去掉两键的副本 |
| `editor-theme/surface.mjs` | `installEditorThemeSurface`、`readTheme`、`initialOutcome` | 给 TUI 原型补编辑主题方法；模块求值时执行一次 |
| `util/atomic-write.mjs` | `writeFileAtomic` | `mkdir -p`；临时文件 `.<fileName>.<pid>.<uuid>.tmp` 与目标同目录；写完 rename；失败清理临时文件并抛原错；返回 `{ existed }` |
| `util/errors.mjs` | `messageOf`、`errorCode` | 前者取 `Error.message` 或 `String(value)`；后者只返回原始 `code` |
| `util/objects.mjs` | `isObject`、`unknownFields` | 排除 `null` 与数组；未知字段按插入序返回 |

## 现状与已知限制

- 40 个模块均已落盘，`src/main.mjs` 与三个清单入口已接线；`tests/` 六个测试只覆盖纯函数与文件工具，通过与否不代表验收结论。
- omp 18.18.6 是开发基线；PATH 默认的 18.16.0 未验证。
- `pi-context` 与 `pi-goal-x` 的深路径导入依赖 omp 对 `@earendil-works/*` 的重写；脱离 omp 加载器时不保证可解析。
- 审计器替换依赖 pi-goal-x 的 `_goalCore` 与 `core.dependencies.runCompletionAuditor`；审计子进程依赖 `runSubprocess`。这些是内部 API，omp 升级后需重新冒烟。
- `manual-acceptance/auditor.mjs` 的 `activeManualAcceptanceAudits` 按 goal id 保存 `AbortController`，运行结束不删除；进程生命周期内条目数随不同 goal 数增长，这是保留的旧行为。
- `.mjs` 入口只能经清单、`omp plugin link` 或 `config.yml#extensions` 加载；目录自动扫描不认它。
- editor-theme 在宿主 TUI 原型缺 editor-theme 面时打补丁；宿主结构变化时每次 `session_start` 仍不可用就发 warning，对话框渲染不保证。
