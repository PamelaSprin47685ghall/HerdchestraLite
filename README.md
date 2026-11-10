# HerdchestraLite

一个 omp 插件包：把原 `vibe-workers.ts` 的提示词、上下文投影、pi-context、pi-goal 与手动验收拆成 37 个单职责 `.mjs` 模块。没有构建步骤，运行即源码；三个入口各自独立加载，单个入口失败不影响另外两个。

## 安装

前置条件：

- omp 18.18.6 是本包的开发基线。PATH 中默认的 18.16.0 未验证，不要把它当作受支持版本。
- Bun 1.4.4 或更高。
- `@oh-my-pi/pi-coding-agent` 与 `@oh-my-pi/pi-tui` 由 omp 宿主提供，本包不声明它们。

```bash
cd /home/kunweiz/Desktop/vibe/HerdchestraLite
bun install
/home/kunweiz/.local/bin/omp plugin link /home/kunweiz/Desktop/vibe/HerdchestraLite
/home/kunweiz/.local/bin/omp plugin list
```

把 `plugin link` 的路径换成你的实际仓库路径。必须通过 `omp plugin link` 或 `config.yml#extensions` 挂载；omp 的原生目录扫描只认 `.ts`/`.js`，不会加载 `.mjs`。

## 目录结构

```text
HerdchestraLite/
├── package.json                  # omp.extensions / pi.extensions 列出三个入口
├── README.md
├── CHANGELOG.md
├── LICENSE
├── .gitignore
├── biome.json                    # 格式与 lint
├── bun.lock
├── docs/
│   ├── architecture.md           # 当前运行时摘要
│   └── design.html               # 旧 README.html 逐字节副本
├── tests/
│   ├── atomic-write.test.mjs
│   ├── contract.test.mjs
│   ├── requirements.test.mjs
│   ├── scores.test.mjs
│   └── tool-gate.test.mjs
└── src/
    ├── main.mjs                  # 入口：组合 prompts、context、pi-context、pi-goal、手动验收
    ├── context/
    │   ├── vibe-suffix.mjs       # P4：后缀常量与消息投影
    │   └── vibe-context-rewrite.mjs # vibe-mode-context 两段文案替换
    ├── prompts/
    │   ├── repo-aware-rules.mjs  # P2：11 条 repo-aware 规则
    │   ├── manual-protocol.mjs   # P3：12 条 MANUAL ACCEPTANCE 协议
    │   ├── context-skill.mjs     # P1：读取 pi-context 的 SKILL.md
    │   ├── plan-only.mjs         # P5：goal 草稿的 Plan-only 覆盖
    │   └── auditor.mjs           # P6：可见审计员提示词
    ├── host/
    │   ├── imports.mjs           # 宿主与依赖的深路径导入集中处
    │   ├── capabilities.mjs      # 能力探测与不可用错误文本
    │   ├── goal-settings.mjs     # goal 设置文件读取
    │   └── subprocess.mjs        # runSubprocess 审计适配
    ├── pi-context/
    │   ├── facade.mjs            # PiFacade 与 /acm 命令适配
    │   ├── command-context.mjs   # createCommandContext / createPiContext
    │   ├── session-capture.mjs   # AgentSession.getContextUsage 捕获
    │   └── xdev-compact.mjs      # PENDING_XDEV_COMPACTS 与 branch 改写
    ├── pi-goal/
    │   ├── facade.mjs            # GoalPiFacade、/goal→/goal-x、延迟 flush
    │   ├── tool-wrap.mjs         # 工具包装与 gated fail-closed
    │   ├── install-auditor.mjs   # 按 GoalCore 安装可见审计员
    │   └── ui.mjs                # goalUi proxy 与 sleep
    ├── manual-acceptance/
    │   ├── constants.mjs         # 路径、正则、报告 schema、允许字段
    │   ├── requirements.mjs      # CASE 解析
    │   ├── contract.mjs          # 契约解析、冻结与文档校验
    │   ├── documents.mjs         # 文档读写（底层 util/atomic-write）
    │   ├── tools.mjs             # 三个 submit_* 工具
    │   ├── guards.mjs            # propose / update 守卫
    │   ├── auditor.mjs           # 可见审计员运行
    │   ├── scores.mjs            # verdictFromScores
    │   └── report.mjs            # 报告构建与写入
    ├── tool-gate/
    │   ├── index.mjs             # 入口：注入与剥离两个门参数
    │   ├── schema.mjs            # 门参数定义与 schema 注入
    │   └── strip.mjs             # 执行前剥离门参数
    ├── editor-theme/
    │   ├── index.mjs             # 入口：初次失败时重试
    │   └── surface.mjs           # TUI 原型面与 readTheme
    └── util/
        ├── atomic-write.mjs      # 同目录临时文件 + rename
        ├── errors.mjs            # messageOf / errorCode
        └── objects.mjs           # isObject / unknownFields
```

`src/` 下共 37 个 `.mjs`。三个入口是：

1. `src/main.mjs`
2. `src/tool-gate/index.mjs`
3. `src/editor-theme/index.mjs`

`package.json` 的 `omp.extensions` 与 `pi.extensions` 按同一顺序列出它们。

## 使用

三个工厂只注册事件、工具和命令，不在加载期发送消息或切换活动工具。加载期的副作用只有两处：`prompts/context-skill.mjs` 读取 pi-context 的 `SKILL.md`，`editor-theme/surface.mjs` 安装 TUI 原型面。

### 命令

- `/goal-x`：pi-goal-x 的引导式 goal 流程。本包把它的 `/goal` 改名为 `/goal-x`，宿主内置的 `/goal` 保持不变。
- `/acm`：启用 pi-context 的 agentic context management；启用后可使用上下文工具。
- `/context`：显示上下文用量可视化（来自 pi-context）。

### 工具

- 手动验收：`submit_manual_requirements`、`submit_development_guide`、`submit_coordination`。它们分别写 `docs/manual-acceptance/<goal_slug>/requirements.md`、`development-guide.md`、`coordination.md`。requirements 的每个结构化 CASE 必须对应 markdown 里的一个 `### CASE-*` 标题、PASS threshold 与路径行。
- goal：`get_goal`、`create_goal`、`update_goal`、`set_goal_tasks`、`update_goal_task`、`goal_question`、`goal_questionnaire`、`propose_goal_draft`。这些由 pi-goal-x 注册；本包在 `propose_goal_draft` 与 `update_goal` 的完成路径上运行手动验收守卫。
- 上下文：`context_checkpoint`、`context_timeline`、`context_compact`。由 pi-context 注册，`/acm` 启用后可用。
- 工具门：`tool-gate` 给每个对象型工具 schema 注入两个必填参数 `how-many-more-workers-are-allowed-without-hitting-mythical-man-month` 与 `must-think-in`，并在执行前剥离。模型能看到它们，工具实现收不到。

### 手动验收流程

1. 用 `/goal-x` 启动 goal 草稿；objective 必须带单行 `Verification contract: MANUAL ACCEPTANCE ...`，列出三份文档与各自的 `sha256`。
2. 用三个 `submit_*` 工具写三份文档。
3. `propose_goal_draft` 由守卫校验契约、slug、文档存在性与哈希；不合规会被拒绝。
4. `update_goal` 标记完成时再次校验；可见审计员运行，按 CASE 记录证据并写 `report.md`。CASE 的最终分是 `min(user_score, developer_score)`，再与该 CASE 的阈值比较。

## 兼容性

- omp 18.18.6 是开发基线；PATH 默认的 18.16.0 未验证。
- `pi-context` 2.3.0 与 `pi-goal-x` 0.34.1 固定。它们的深路径导入依赖 omp 对 `@earendil-works/*` 的重写，只在 omp 扩展加载器内成立；在普通 Node 进程里直接 import 入口不保证可用。
- 内部 API 风险：审计子进程使用 `@oh-my-pi/pi-coding-agent/task/executor` 的 `runSubprocess`；审计器替换依赖 pi-goal-x 的 `_goalCore` 与 `core.dependencies.runCompletionAuditor`；设置读取优先 `pi.pi.settings`，回退 `Settings.instance`。omp 升级可能改变这些接口。失败时审计器返回 disapproved，gated 工具 fail-closed，不会静默放行。
- 两套清单 `omp.extensions` 与 `pi.extensions` 指向同一组三个入口，便于 omp 与 Pi 兼容加载。

## 已知限制

- `src/manual-acceptance/auditor.mjs` 的 `activeManualAcceptanceAudits` 是模块级 `Map`，按 goal id 保存 `AbortController`，审计结束不删除。进程生命周期内的条目数会随不同 goal 数增长；这是保留的旧行为。
- `pi-context` 与 `pi-goal-x` 的深路径导入依赖 omp 的重写；脱离 omp 加载器时可能无法解析。
- `.mjs` 入口只能经 `package.json` 清单、`omp plugin link` 或 `config.yml#extensions` 加载；把目录放进原生扩展目录不会被扫描。
- editor-theme 只在宿主 TUI 原型缺 editor-theme 面时打补丁；初次失败后每次 `session_start` 重试一次，仍不可用时发 warning，对话框渲染不保证。
- 审计子进程依赖宿主内部接口；契约哈希与报告写入是本地逻辑。升级 omp 后应先用一个小 goal 做冒烟。

## 文案政策

- 旧设计说明 `README.html` 已逐字节复制为 `docs/design.html`：121466 字节，sha256 `972f28733c05e5713c770fb82d6b634527d17fa4b156296200061227c23977fb`。`docs/design.html` 不转述、不压缩、不改写。
- 本 README 与 CHANGELOG 只描述当前包；它们不替代 `docs/design.html`，也不把旧结论改写成新说法。
- 提示词、用户可见文案、错误消息、工具 label/description 以旧实现原文为准；迁移时逐字复制，不做“顺手润色”。

## 方法论

方法论是运行时提示词规则，不只是文档：`src/prompts/method-discipline.mjs` 的 `METHOD_DISCIPLINE` 按 S1/S2/S3 分阶段进入主系统提示与审计员提示，模型必须按它决策和检查。模块按变化原因拆，而不是按行数拆：提示词、宿主适配、手动验收、工具门、主题各归一处，入口只组合。切片与合并不靠口头约定，而靠 S3 的 G0–G4 门禁、所有权矩阵与 FREEZE WINDOW。文案逐字保留，因为 CASE-15 用 grep 与文本哈希验收，任何改写都会让旧行为失去证据。完整映射见 [`docs/methodology.md`](docs/methodology.md)。

## 开发检查

```bash
bun test          # 纯函数与文件工具测试，仅作开发者质量参考
bun run check     # Biome 格式与 lint
```

`bun test` 与 `bun run check` 不是验收证据；手动验收按 `docs/manual-acceptance/` 下的 CASE 执行。
