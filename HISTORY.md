# HISTORY.md — 历史取舍与被拒方案

> 本文件只记录历史决定、被拒方案、演进叙事与保全记录；当前规格不依赖本文件。根 `AGENTS.md` 仍是唯一 SSOT。删除旧规则时，丢失的历史信息应补到这里。

## 2026-11-11 clean-break 方向

**决定**：把仓库从旧的 `pi-goal-x` / `pi-context` / 编辑器主题垫片 / 旧手动验收实现，切换为根 `AGENTS.md` 描述的 Herdchestra Lite：

- 两个清单入口：`bootstrap-main.mjs` 与 `tool-gate/index.mjs`；
- 运行时依赖只保留 `cherry-cljs`；
- 五阶段 S1–S5、`advance_s1..s4` 门禁与渐进披露；
- ClojureScript 沙箱、EDN + UFSS、批内 VFS、`where`/`park`/`unpark`；
- 看板、唯一持令、多 Worktree、Reviewer ⇄ Swarm 任期；
- K 路并发手工审计、`min(user_score, developer_score)` 汇总；
- Scope、出站投影、TUI 双态看板与恢复。

**未完成的部分不写入历史为“已交付”**：S5 审计的真实收尾、宿主子会话身份的版本兼容、真实宿主加载与手工验收仍是 `DEBT.md` 中的未关闭项；旧目录已删除。

## 保全的用户历史资料

clean-break 不删除、不改写以下既有资料：

- `docs/旧的方法论.md`
- `docs/旧的架构.md`
- `docs/旧的设计.html`
- `docs/讨论纪要.md`
- `docs/兄弟项目参考.md`
- `docs/manual-acceptance/clean-break/requirements.md`、`development-guide.md`、`coordination.md`

`docs/manual-acceptance/clean-break/` 是“开发本产品”的验收文档，不是产品运行时的 `plans/<slug>/`。两套路径不混用。

## 被拒或已收敛的方案

1. **FullRef 标准版的运行底座**：不采用 Clojure/JVM、Datalevin、Fulcro、Steward/Standing Sphinx、跨机器执行；Lite 只做 `omp` 进程内 `.mjs`。
2. **继续依赖旧 `pi-goal-x` / `pi-context` 的深路径与猴子补丁**：不再作为产品运行时。`pi-goal/`、`pi-context/`、`editor-theme/`、`context/`、旧提示词模块、`src/util/objects.mjs` 与旧 manual-acceptance 测试均已从工作树删除，不是新行为路径。
3. **把 `sessionFile` 当父会话链接**：宿主实测在 `artifactsDir` 下忽略它；不得向用户宣称 `history://` 可重放父链。详见 `src/AGENTS.md` 与 `DEBT.md` D5。
4. **把 Cherry 编译作为沙箱主路径**：实测 `cherry-cljs@0.6.38` 不提供 EDN reader、不识别 `defprogram`、不自动 await；采用自建 Promise-CPS 解释器，Cherry 只作数据/纯函数运行时。
5. **单一审计员串行跑完全部 CASE**：按根规格改为 K 个 CASE 同时启动 K 名独立可见 Manual Auditor；框架确定性汇总。
6. **把自动化测试、CI、构建或覆盖率当作验收证据**：明确拒绝；`bun test`/`biome` 只作开发者诊断。
7. **旧模块/三入口/旧命令的安装说明**：已从 README 移除，不再作为当前安装指导；旧 CHANGELOG 原文保留在 `CHANGELOG.md` 的 `[0.1.0]` 历史节。

## 2026-11-11 测试纪律收敛

**决定**：删除只比较源码/提示词字面拷贝、导出存在或结构接线的测试（本次删除了 `tests/prompts.test.mjs`）。保留的测试只应针对真实出站零剧透、真实阶段转换或其它用户可观察行为；如果当前没有真实投影/门禁夹具，不新增模拟代用品。

**原因**：逐字节比较提示词常量会把“实现措辞”固化成测试目标，模型改一个字就失败，却不证明用户可见行为；导出形状测试也不能发现真实装配缺口。真实出站 payload 与门禁回执才是行为边界。

**后果**：提示词文本一致性暂时依赖代码审查与根规格变更纪律；零剧透/阶段转换的自动化覆盖记录在 `DEBT.md` D6，等真实投影夹具可用后再补。

## 2026-11-11 角色身份改为宿主子会话

`tool-gate/schema.mjs` 删除了 role-auth/nonce 注册；独立 `tool-gate/role-auth.mjs` 不再存在。角色收窄改为：

1. `tool-gate/index.mjs` 读取宿主报告的子会话身份 `ctx.agent`（`kind`/`depth`）；
2. 只有宿主确认是子会话时才解析首行 `[HERD_ROLE: ... nonce=...]` 声明；
3. 角色面来自 M0 发布的 role surfaces，而不是独立凭据注册表。

首行 role token 仍保留，作为父进程写入的声明被解析和核对；不要把它误写成独立密码学凭据。风险是 `ctx.agent` 的形状随宿主版本变化，17.x/16.x 的真实行为尚未验证；记录在 `DEBT.md` D2。

## 2026-11-11 legacy 删除

开发验收包 `tools/dev-acceptance/` 完成旧 `src/manual-acceptance/` 的迁移后，确认 `src/main.mjs`、`src/bootstrap-main.mjs`、`src/tool-gate/index.mjs` 与 `tools/dev-acceptance/` 均不 import 以下路径，按具名清单删除：

- `src/prompts/manual-protocol.mjs`
- `src/prompts/method-discipline.mjs`
- `src/prompts/repo-aware-rules.mjs`
- `src/prompts/plan-only.mjs`
- `src/prompts/context-skill.mjs`
- `src/util/objects.mjs`

`tools/dev-acceptance/util/objects.mjs` 是独立子包自己的复制，不受影响。旧 manual-acceptance 测试随旧 `src/manual-acceptance/` 一起删除；用户文档未删除。

## 2026-11-11 文档同步

- README 改为描述当前工作区与未接通缺口，移除旧 18.18.6、三入口、`/goal-x`、`/acm`、旧手动验收工具的安装/使用说明。
- CHANGELOG 新增 clean-break 进行中节；旧实现记录保留为 `[0.1.0]` 历史，不再代表当前行为。
- 新增 `src/AGENTS.md`（架构装配与单向依赖）、`DEBT.md`（未关闭缺口）、本文件（历史取舍）。
- 未修改根 `AGENTS.md`，未修改 `docs/manual-acceptance/clean-break/` 中已批准的需求/指南/协调文档。

## 2026-11-14 UFSS 数据层改用 cljs.pprint

**决定**：`herd.ufss/print` 的数据层从 `wrap(format(pr-str(value)))` 改为 `wrap(format(pprint(value)))`；`pprint` 使用 nbb 自带 `cljs.pprint` 的默认宽度。`UFSS.md` §5、D4 与根 `AGENTS.md` 的 UFSS 打印裁决行同步改写。

**原因**：`pr-str` 不折行，大 map/vector 会变成单行；`pprint` 至少提供宽度感知的换行，且不需要新增 npm 依赖。

**代价**：nbb 的 SCI 版 `cljs.pprint` 不暴露 `*print-right-margin*`、`*print-miser-width*` 或 `write`，宽度固定（约 72），长集合可能退化为每元素一行；具体布局随 nbb 版本可能变化，测试不得逐字固化换行位置。若将来需要可控宽度，必须另行设计，不能靠调用方绑定 pprint 宽度。

**保留的旧行为**：数据层仍先生成文本，再经 `standard-clojure-style` 与 `wrap`；字符串 fence、最小深度、多行顶格与 A2/A4 双射不变。

## 2026-11-14 Ariadne 字段改名：turn_horizon / kpi_aim

**决定**：`ariadne_budget` → `turn_horizon`，`ariadne_goal` → `kpi_aim`。`turn_horizon` 是相对回合视野，软到期；`kpi_aim` 是写给 `turn_horizon` 到期时自己的意图陈述，不是可验证指标。工具 Schema 的英文描述放在 `src/herd/main.cljs` 的 `turn-horizon-schema` / `kpi-aim-schema`。

**原因**：`budget` 暗示可消耗资源与硬配额；`goal` 暗示最终目标，无法表达中间层。`turn_horizon` 明确是回合跨度；`kpi_aim` 用 `aim` 削弱 KPI 的可验证感，强调到期回看时的意图。

**代价**：这是一次破坏性改名；所有 `clj_*` 调用、完整装配的 Ariadne store、测试与文档同步更新，不保留别名。内部 receipt 键也改为 `aims` / `aim` / `updatedHorizon`。`time_leap` 的提醒删除了“恰好是当前 Ariadne 到期前还能进行的回合数”这一显然尾句。

## 2026-11-14 宿主 nbb 解析与 cwd 修复

**问题**：宿主的 bare/bundled `nbb` 不提供 `cljs.pprint/pprint`；`bootstrap.cljs` 用 `process.cwd()` 找源码，从 `~/tmp` 启动时找不到 `src/herd/ufss.cljs`。

**决定**：`clj-main.mjs` 从插件真实路径加载 pinned `nbb` 1.6.215，并用 `nbb.registerModule(formatter, "@chrisoakman/standard-clojure-style")` 注册 formatter；`bootstrap.cljs` 从 `nbb.classpath/get-classpath` 与 `globalThis.__herdPluginSrc` 解析源码根。`herd.ufss` 继续使用 `cljs.pprint/pprint`，不新增依赖。

**验证**：从 `~/tmp` 运行 `omp -p` 不再报 extension load error；`env -u BUN_OPTIONS bun test tests --parallel` 为 235 pass / 1 skip / 0 fail。
## 2026-11-14 kpi_aim → todo_horizon

**决定**：`kpi_aim` → `todo_horizon`。`turn_horizon` 是时间窗口，`todo_horizon` 是这个窗口里要完成的事情；工具 Schema 的英文描述、Ariadne store、测试与当前文档同步改名。

**原因**：`todo_horizon` 与 `turn_horizon` 成对：一个说多久，一个说做什么；比 KPI/aim 更直接，也避免 KPI 的指标感。

**代价**：破坏性改名；所有 `clj_*` 调用、Ariadne store、测试与文档同步更新，不保留别名。`time_leap` 的 `Aim:` 标签也改为 `Todo:`。

## 2026-11-14 参数改为嵌套 scope

**决定**：`turn_horizon` + `todo_horizon` → `scope: { turnsRemaining, todosRemaining }`。`turn_horizon` 与 `todo_horizon` 不再作为顶层参数出现。

**原因**：时间窗口与这个窗口内要完成的事情是一个整体；嵌套 `scope` 让调用参数更清楚，也方便工具 renderer 直接取 `args.scope`。

**代价**：破坏性改名；所有 `clj_*` 调用、Ariadne store、测试、README/MIGRATION 与 AGENTS.md 同步更新，不保留别名。`time_leap` 拒收 `scope`。
## 2026-11-14 Clojure 工具 UI：canonical 源码 + 关键字 + 彩虹括号

**决定**：`clj_devops` 调用行显示 `ufss/canonical-source` 规范化后的源码；关键字高亮使用宿主 `@oh-my-pi/pi-tui` 的 `highlightCode("clojure")`，彩虹括号使用 `herd.ufss/delimiter-spans` 的深度信息叠加 ANSI。Neovim 的 `nvim-treesitter` + `rainbow-delimiters.nvim` 只作为美学参考。

**原因**：宿主已有 Clojure 关键字高亮；UFSS 已有 reader 层，复用同一个扫描器即可得到可靠的 delimiter 深度，不需要新增依赖或运行 Neovim。

**代价**：canonical 化失败或高亮模块不可用时回退原文；渲染性能与 formatter/highlighter 成本绑定，后续如需要可缓存。
## 2026-11-14 UFSS API 收敛为 canonical

**决定**：删除 `print` 与 `canonical-source`；`canonical(value-or-text, highlighter?)` 成为唯一输出入口。`canonical = ufssify(unufssify(text), highlighter?)`，EDN 值先由 `pprint` 变成 text。`ufssify` 本身也接受可选 highlighter：有则给 code、UFSS body、delimiter 加 ANSI，没有就是原 canonical。

**原因**：EDN 也是 source，数据层与代码层不再需要两条路径；`highlight?` 布尔也不需要，高亮器是否存在就是模式开关。

**代价**：调用点从 `print` / `canonical-source` 迁移到 `canonical`；字符串输入按 source 解释，EDN 字符串值需要先 `pprint`/`pr-str`。高亮器契约是 `(text, lang) -> ANSI`，`lang` 为 `"clojure"`、`nil`（自动 body）、`:dim`（fence）或 `[:rainbow depth]`（delimiter）。
## 2026-11-14 工具输出内容语言识别交给 highlight.js

**决定**：删除 `herd.highlight/detect-language` 中手写的 JSON/Clojure/JS/Bash/Markdown/HTML/YAML/SQL 规则；改由 `highlight.js` 的 `highlightAuto` 识别，`src/host/language-detect.mjs` 只做加载与宿主语言名映射，`src/clj-main.mjs` 暴露 `globalThis.__herdDetectLanguage`，CLJS 侧委托调用。

**原因**：无路径的 `cat` 结果无法使用宿主的 path-based `detectLanguageId`；手写规则对 `.mjs` 等真实文件漏判。`highlight.js` 只负责识别，渲染仍由宿主 native `highlightCode` 完成，符合“和 omp 自带配套”的边界。

**被拒方案**：先试 `prismjs@1.30.0`，其核心不导出 `highlightAuto`，因此放弃；不手写更多语言规则，也不引入 ML 模型或 Neovim。
## 2026-11-14 删除 `call` 的 `:alternative` 提示词要求

**决定**：从根 `AGENTS.md` §4.5、`src/clj-sandbox/tools.mjs` 的 `call` 描述与交接材料中删除 `:alternative` 要求。`call` 仍只接受 `argv`（可选 `cwd`），继续禁止 shell、管道、重定向、通配与 `&&`。

**原因**：该字段从未被框架校验或使用，只制造无回报的提示词负担；把它保留为“提示词要求”会让模型误以为存在第二套决策记录，实际没有任何消费者。

**代价**：失去一条“调用前考虑内置工具”的提示。该判断仍由 `COMMON` 的工具优先条款与角色提示词承担，不再要求每次 `call` 填表。

## 2026-11-14 mjs → CLJS/nbb 迁移归档与人类批准记录

`MIGRATION.md` 迁移台账已完成归档并从仓库移除；下述人类操作员批准记录（2026-11-13 至 2026-11-14）与迁移收口摘要永久保全于本节。

### 迁移收口摘要

- **唯一清单入口与运行时**：`src/clj-main.mjs` → `src/herd/bootstrap.cljs` → `src/herd/main.cljs` + `src/herd/system.cljs`（基于 `nbb@1.6.215`、`@chrisoakman/standard-clojure-style@0.29.0`、`highlight.js@11.12.0`）。
- **已删除旧路径**：`src/pi-goal/`、`src/pi-context/`、`src/editor-theme/`、`src/context/`、`src/manual-acceptance/`、`src/main.mjs`、`src/bootstrap-main.mjs`、`src/clj-sandbox/`、`src/stages/`、`src/swarm/`、`src/tui/`、`src/prompts/`、`src/sandbox/`、`src/scope/`、`src/host/{health,model-seed,hack-system-prompt,session-key}.mjs`、`src/util/{atomic-write,file-lock,broker}.mjs` 及对应旧 `.mjs` 冗余测试。
- **已接入核心业务能力**：CLJ 沙箱与 `where`/`park`/`unpark`/`abandon`/直通写锁/`call`（含环境变量清洗）、EDN + UFSS 规范化、`handoff` 双锚点换血、S1–S4 `review`/`attach_*`/`ask_user`/`devops` 门禁与渐进披露、11 个 `board_*` 工具、S5 单工作区 Reviewer ⇄ Swarm runner、K 路审计与 `s5-report.md`、`more_workers_without_hitting_mythical_man_month` 提醒、27 个工具统一 `herd/ui` 渲染、`src/` 零同步 fs。
- **仍保留在 `DEBT.md` 的真实宿主验证边界**：D3（真实 tmux S1→S5 端到端使命）、D4（真实宿主 S1 确认面板）、D5（16.x/17.x 兼容）、D7（剩余 F 矩阵故障注入与真实 tmux 交错）、D17–D20。

### 人类批准记录（迁移期间对根规格的放宽与指令）

1. 运行时由 `cherry-cljs` / `squint` 改为 `nbb`（Node 上的 SCI）；`.mjs` 入口缩到宿主引导。
2. §4.1 的 Air-Gapped 符号表放宽为**基本防呆**：`nbb` 默认暴露 `js/` 与 `globalThis`，不承诺逃逸不可能；不主动注入 `process`/`require`/`fs`。剩余风险记入 `DEBT.md` D18。
3. UFSS 读取宽容化：闭合围栏允许尾随文本；body 短缩进不再报错。
4. UFSS 输出策略：数据与代码统一 `wrap(format(...))`；多行 body 顶格，`""",` 与后续 entry 同行。
5. `wait` 的期限经中途过渡后最终统一按 `2000ms + UTF-8 字节数 × 200ms` 实现并接入 `park-all`；旧 evaluator/repl 测试已由 CLJS 测试替代。
6. `/clj-status` 取消，不再实现或注入。
7. 业务 CLJS 源码字符串字面量按 UFSS 规范书写；`ufss.cljs` 与 `bootstrap.cljs` 作为自举内核保持标准字符串。
8. 旧 `time_leap` 上下文裁剪曾放在 `context` 钩子内完成（后由条目 11 删除并由 `handoff` 取代）。
9. 入口从命名导出 `activate` 改为 omp 18.x 要求的 default factory；`setActiveTools` 从模块顶层移至 `session_start` 与 `before_agent_start`。
10. 2026-11-14：`$$$` 折叠加入“单行且不超过 40 字符正常渲染”例外。
11. 2026-11-14：删除 Ariadne/Time Leap/Beacon 机制，由 `handoff` 取代；同步根规格。
12. 2026-11-14：批准同步根规格 §0.2/§0.4/§1.3/§4.2/§4.7/§5/§6.1/§8/§9.1 等欠账。
13. 2026-11-14：用户指令整体移除 TUI 看板（覆盖根规格 §6.1）；批准 `console`/`js/process.stdout|stderr` 等直接访问的沙箱防呆（`guard-source!` 返回 `:CAPABILITY_DENIED`）；批准性能边界（锁等待默认 500ms、`HERD_LOCK_WAIT_MS` 可调 50–5000ms；`glob` 20k/2s、`where` 1M/150ms、`cat`/`write` 2 MiB、`HERD_TRACE`/`HERD_CACHE_PROBE` 默认关闭）。
14. 2026-11-14：用户指令将旧口径 `1s + 50ms` 统一为新口径 `2000ms + 200ms × UTF-8 字节数`，同步更新根规格 §7.5 与 `src/herd/main.cljs`。

## 演进里程碑归档（原 `CHANGELOG.md` 合并）

> 本仓库不再维护 `CHANGELOG.md`（理由见 `AGENTS.md` §9.2），过往里程碑节点整理归档如下；测试计数均为当时历史快照，不代表验收通过。

- **`[0.1.0]` 旧实现基线**：3 个清单入口（`bootstrap-main.mjs`、`tool-gate/index.mjs`、`bootstrap-editor-theme.mjs`）、40 个单职责 `.mjs` 模块、`submit_manual_*` 验收提交工具、`/goal-x`、对 `AgentSession.prototype`/`TUI.prototype`/`_goalCore` 的猴子补丁与 `pi-goal-x`/`pi-context` 依赖。
- **2026-11-12 `clj` 执行器最小面**：收敛清单为 `./src/clj-main.mjs`，`call` 改为 argv-only（移除管道/重定向/通配与 `BUN_OPTIONS` 等宿主预加载环境变量），放开普通路径权限与 `AGENTS.md` 特殊写保护。
- **2026-11-13 native `read`/`write` 委托**：删除同名 shadow 工具与 `node:fs` 绕过，新增 `src/host/native-runner.mjs` 捕获 live `ExtensionRunner` 并通过 `invokeNativeTool` 委托执行，锁内复核 `__expectedStamp`；缺失 Runner 时以 `HOST_API_MISMATCH` fail-closed。
- **2026-11-14 门禁、完整装配接回与性能收口**：
  - `src/herd/stages/gates.cljs` 与 `gates_host.cljs` 完成 S1–S4 `review`/`attach_*`/`ask_user`/`devops`/`submit_devops_report` 迁移，删去旧 `frozen` 哈希与 `contract-line` 校验。
  - `src/herd/system.cljs`、`swarm/runner.cljs`、`swarm/auditors.cljs` 接回唯一清单入口；整体移除 TUI 看板；修复同步 fs / 锁等待 / 无界扫描 / 默认探针引起的 5s UI 卡顿，并加入 `guard-source!` 的 `console`/stdio 防呆。
  - 引入 per-pi `WeakSet` 与 `__herdBootPromise` 安装单例，修复 `usage` 工作条被宿主官方流式输出覆盖的问题（事件驱动恢复，无轮询定时器）。
  - 2026-11-14 最终决定废止并删除 `CHANGELOG.md`，所有历史演进、设计取舍与人类批准裁决统一由本文件承载。

## 从 `AGENTS.md` 移出的历史对照与设计裁决（2026-11-14 瘦身归档）

> 以下内容原载于根 `AGENTS.md` §9.6、§10.2、§10.4 与 §10.7，属于历史迁移步骤、旧版对照与演进裁决，按 §9.2「当前规格 vs 历史判据」移至本文件长期维护。

### 旧实现 clean-break 迁移步骤（已执行完成）

1. 删除 `pi-goal-x` 与 `pi-context` 依赖；删除 `src/pi-goal/`、`src/pi-context/`、`src/editor-theme/`、`bootstrap-editor-theme.mjs` 及其入口。
2. 删除旧实现的所有猴子补丁：`AgentSession.prototype.getContextUsage`、`TUI.prototype` 主题 getter、`_goalCore` 私有属性、`xd://context_compact` 历史改写、`goalService.apply` 替换、Proxy UI 垫片；唯一保留的受控捕获是 `src/host/native-runner.mjs` 对 `ExtensionRunner.prototype.createContext` 的包装。
3. 删除旧 CASE Markdown 解析路径（`parseS2Cases`、`extractCaseBlocks` 等）；CASE 权威统一为 `.herd/missions/<slug>/s2-cases.edn`，`s2-manual-tests.md` 只写方法论。
4. 将旧 `docs/manual-acceptance/<slug>/requirements.md` 流程与产品运行期 `plans/<slug>/s1..s5` 分离，旧产物保留只读。
5. `package.json` 收敛运行时依赖为 `nbb`、`@chrisoakman/standard-clojure-style`、`highlight.js`，唯一入口 `./src/clj-main.mjs`。
6. 删除全部旧 `.mjs` 业务实现（`main.mjs`、`bootstrap-main.mjs`、`clj-sandbox/`、`stages/`、`swarm/`、`tui/`、`prompts/`、`sandbox/`、`scope/`）、旧路径别名与兼容 shim。
### 与旧版参考实现的差异

本目录的旧实现是历史参考，不是规格。新实现必须 clean-break：

| 旧实现 | 新 Lite 规格 |
|---|---|
| `dependencies: { pi-context, pi-goal-x }` | 运行时保留 `nbb`、`@chrisoakman/standard-clojure-style` 与 `highlight.js`（仅内容语言识别）；删除两个旧依赖。 |
| 三个清单入口，含 `bootstrap-editor-theme` | 单一主入口（Handoff 归属 `src/host/hack-context.mjs` 与 `src/herd/handoff.cljs`）；主题垫片与 `tool-gate` 删除。 |
| `installLiveSessionCapture` 改写 `AgentSession.prototype.getContextUsage` | 禁止该猴子补丁；上下文用量只读宿主公开 API。除 §1.1 的受控 `ExtensionRunner.createContext` 捕获外，不允许其他原型改动。 |
| `TUI.prototype` 主题 getter、`goalUi` Proxy | 删除；TUI 只使用公开组件接口。 |
| `_goalCore` 私有属性、`goalService.apply` 替换 | 删除；完成闸门由 Lite 自己的审计/批准状态机实现。 |
| `xd://context_compact` 分支改写、`PENDING_XDEV_COMPACTS` | 删除；只做 `context` 出站投影，不改写历史。 |
| `docs/manual-acceptance/<slug>/` 四文件 | `plans/<slug>/s1..s5` 五阶段文件；旧产物保留只读。 |
| 从 `s2-manual-tests.md` 解析 `### CASE-*`、阈值与 `rubric_summary`，再与结构化数组逐项对账 | CASE 作为严格 Schema 的 `cases` 参数提交，独立持久化为 `.herd/missions/<slug>/s2-cases.edn`；Markdown 只写方法论；不解析、不双写、不对照。 |
| 单一 auditor 串行跑全部 CASE，60 分钟 | K 名 auditor 并发，一 CASE 一名，30 分钟；框架汇总。 |
| 无 Nudge 实现 | Nudge + 空转退避 + 上游退避是核心协议。 |
| `tool-gate` 只注入两个字段，无 Scope/intent | 删除 tool-gate 与旧 Scope 注解；语言约束由 `context` 尾注承担，Handoff 归属 `src/host/hack-context.mjs`。 |
| 无多 Worktree 编排 | 当前 dogfood 单工作区；`fork_slices`/`join_slice` 保留为后续完整装配。 |
| 无 ClojureScript 沙箱 | `nbb`/SCI 沙箱、宿主写、call runner、`where`/`park`/`unpark`。 |
| 同目录多子代理无写锁 | `path` 令牌 + `global` 令牌 + 跨进程粗锁 + 宿主写 + `stamp` 复核；无批内 VFS。 |
| 验收失败只写 FAIL 报告 | 未达标 CASE 自动转修复 Slice/根任务，循环到全 PASS。 |

**保留的旧实现优点**：工具门的中文锚点与并发自检、manual acceptance 的双视角 WTP 与 `min` 裁决、审计员只读/隔离/`/tmp` 破坏实验、Agent Hub 可见性、CASE 数据集 Schema 校验的 `cases[i].<field>` 精确报错与独立哈希、批准只能由审计结果签发的 fail-closed 思路。这些在新规格中被继承并强化。

### 设计裁决索引

本表记录“为什么当前规格是这样”，尤其是设计讨论中曾经出现、后来被收敛的方案。它不构成新义务；当前行为以正文为准。

| 裁决 | 决定 | 理由 | 被替换/拒绝的方案 |
|---|---|---|---|
| 阶段生命周期 | `review` 空账只置 attach-ready；必须显式调用按材料命名的 `attach_*`，才写交付物、退休 tenure、写 barrier、启动 successor 并注入下一阶段简报 | 把“判断达标”和“物理提交+换任”分开；避免门禁工具一次动作过重 | `advance_s1..s4` 一次完成校验/保存/冻结/晋级/披露 |
| 工具命名 | `attach_brainstorm` / `attach_manual_tests` / `attach_dev_guide` / `attach_coordination` | 工具名表达提交材料，不表达阶段编号 | `attach_s1..s4`；按目标阶段命名 |
| S1 材料 | 只提交 `brainstorm_markdown` 一个 md；无 `summary`、`non_goals` 参数 | S1 交付物就是需求文档；Non-Goals 写在文档内 | `s1-summary.md` 冻结副本；独立 `non_goals` 数组 |
| 规划手工门禁 | S1 `attach_brainstorm` 手工批准（生产由人类操作员明确批准；隔离测试可由获授权 AI 操作员模拟）；S5 初任空账允许一次询问 | 人类信息价值最高点在 S1 意图与边界；S5 初任空账需要人类决定后续 | 每阶段人工点头；独立 Plan Reviewer 互审 |
| S2–S5 基本自动 | S2–S4 attach 校验通过即自动晋级；S5 除初任空账外自动 | 长程无人值守；避免把审批当成验收 | 每阶段弹确认框；等待用户“继续” |
| 方法论披露 | 下一阶段大师只在 attach successor 初始化中出现 | 防止模型在 S1 就写测试表、在 S2 就切任务；保护缓存前缀 | 一次性把 S1–S5 全部塞进系统提示词 |
| review 与 board | 每个 tenure 只有一张 `board.edn`，review findings 就是 board 任务；扁平 map，允许 `:waiting`/父子引用 | 消除两套台账；编辑与 diff 友好 | 独立 review ledger + board 双写 |
| 终局审计 | K 个 CASE 并发，一 CASE 一审计员；`s2-cases.edn` 是唯一 CASE 权威 | 消除单审计员注意力衰减；墙钟压到最慢 CASE | 单审计员串行跑完全部 CASE |
| 结构化交付 | 一切结构化数据/长文走工具参数 | 杜绝正则抠正文、`<approved/>` 伪标记 | 从聊天正文正则抠取结构化数据或伪标记 |
| CASE 数据集 | `attach_manual_tests.cases` 是唯一来源；严格 Schema 校验后持久化为 `s2-cases.edn`；不冻结哈希 | 单一权威、可按 ID 分发；避免 Markdown 解析与双源漂移 | 从 `s2-manual-tests.md` 解析 CASE；哈希冻结；`rubric_summary` 对账 |
| S3 开发指南 | `attach_dev_guide` 只收 `markdown`；模块组织由文档内容自行决定 | 避免把说明性结构变成机器门禁 | `modules` 数组、`:s3-modules`、模块覆盖校验、inline 哈希 |
| S4 协调手册 | `attach_coordination` 收 `markdown + promela`；无 `slices`/Slice DAG；`.pml` 必填但只保存观察，不解析/不跑 Spin | 形式模型作为唯一形式真理，但系统不承担模型检查工具链 | `slices` 参数、Slice DAG、CASE-to-Slice 覆盖校验、Spin 门禁 |
| S5 编排 | 单工作区、一个 Reviewer、一个 Swarm board；非空 findings `wake-all`；空账 + quiescence 后审计 | 先把单工作区闭环跑通；多 worktree 是后续完整装配 | `fork_slices`/`join_slice`/worktree/rebase/ff 进入 dogfood 面 |
| frozen | `frozen` 只是提示词约定；无 `:frozen` 哈希、无 `contract-line`、无 `realign`、无哈希不匹配错误 | 减少控制态复杂度，信任模型与审计员观察 | SHA-256 冻结、contract-line、realign、哈希门禁 |
| 锁 | S1–S4 单写者不加 mission 锁；S5 只保留一个 `board.lock`；原子写防损坏 | 轻量、信任；只防文件损坏，不做重型互斥 | mission.lock、master-integration.lock、worktree 锁、到处加锁 |
| 模型归属 | 主模型判断/验收；`@task` 施工/调查 | 成本与能力匹配；审计需要最强证伪 | 全体主模型；全体 `@task` |
| 审计隔离 | 独立 tmux/`/tmp`/证据目录；主工作区只读；单 CASE 记录注入 | 防止串扰与审计员改代码自证；防止读取其他 CASE | 共用主工作区；审计员可写产品代码；把整份 CASE 数据集交给审计员 |
| 审计证据 | 审计员观察主工作区与 CASE 数据；不依赖 frozen 哈希 | 与去 frozen 的设计一致；报告基于现场 | 启动前后哈希快照；哈希不符即整批作废 |
| 结案 | 全 PASS 才签发 `(mission-id, revision)` 批准 | 防止绕过审计直接完成 | 允许手工标完成；允许 skipAuditor |
| native read/write 委托 | 受控包装 `ExtensionRunner.prototype.createContext` 取得 live runner，调用公开 `invokeNativeTool`；`host/native-runner.mjs` 懒加载、单文件、fail-closed | 宿主扩展 API 不暴露 Runner；`node:fs` 绕过违反 L07，同名 shadow 工具只解决注册冲突不解决真实委托 | 同名 `read`/`write` shadow 工具 + `ctx.invokeTool`；`ctx.session.getToolByName` 反射；直接 `node:fs` 读写 |
| 停不停 | 无协议暂停态；Esc 递归取消 | 与标准版一致；避免半暂停状态 | `paused` 状态、逐阶段 resume |
| 父项 | 子项全完只回 `:ready` | 防止把父项当分组标题顺手勾掉 | 子项计数等于总数即自动完成 |
| 看板原语 | 独立 `board_*` 工具，不塞进 REPL | 结构化数据走工具；沙箱只做工作区/续体 | 沙箱内 `(split ...)` 与工具双入口 |
| 审计员写权限 | 只写 `evidence/<case_id>/` 与专属 `/tmp` | 既保留证据，又不污染主工作区 | 完全只读导致无法抓屏；开放全仓写 |
| S2 评分 | 每个 CASE 内置专属 `rubric` + 双视角 WTP `min`；`rubric` 存于 `s2-cases.edn` | 防止通用权重与单视角掩盖；不做 Markdown 摘要对账 | 统一权重模板；只打一个总分；把 rubric 写在 Markdown 再解析 |
| 与标准版关系 | 同构语义，不同物理实现 | 共享验收语料与术语，降低双线维护 | 把 Lite 做成标准版的裁剪；把标准版机制硬塞进 Lite |
| attach 接力 | 逻辑接力：attach 提交后切换 tenure，用 hackContext 切分支使旧对话不可见，不新开会话 | 主会话保持 Coordinator，避免每次 attach 重建上下文 | 每次 attach 启动新的 Plan 子会话 |
| 单工作区静止 | 单工作区 S5 的 quiescence 不含 `--ff-only`；ff 仅多 worktree 装配适用 | 当前 dogfood 没有 worktree，保留 ff 会制造不存在的条件 | 在单工作区要求 ff dry-run |
| 审计返回 | 新增 `attach_case_audit` 提交分数与报告；不要求 evidence 目录 | 能用流程解决的不用证据目录；避免与审计员路径边界冲突 | 强制 `plans/<slug>/evidence/<case_id>/` |
| attach 面板 | 工具执行内阻塞：approve 解除并继续，revise 留下重做，deny 转 `ask_user`，面板不可用才 pending | 阻塞符合旧面板行为；deny 交回人类说明 | 全部走 pending 异步 |
| 运行时 | `nbb`（Node 上的 SCI）+ 薄 `.mjs` 引导 + `src/herd/*.cljs` | 官方 reader、CLJS 持久值、`promesa.core`；沙箱不暴露 `await`/`^:async`；mjs 只做宿主注入 | `cherry-cljs` + 自建 CEK；scittle 浏览器发行版 |
| 沙箱编排 | 原生 Promise + `promesa.core`；能力返回 `js/Promise`；顶层用户代码自行 `require`；写操作并发由 `path` 令牌 + 跨进程写锁串行化 | 借力 LLM 对 `promesa` 的肌肉记忆，避免用户级宏、`await` 与逐项 HOF 特例；写锁保证互斥 | 用户级 `await`/`^:async` 宏；逐项 `mapv`/`doseq` 覆盖；同步 fs |
| UFSS 打印 | 完整标准见 `UFSS.md`；摘要：数据层 `wrap(format(pprint(value)))`，pprint 先排版，最小 fence，多行顶格，`""",` 同行 | nbb 1.6.215 的 `cljs.pprint` 默认宽度约 72 列且不可由调用方配置；`canonical` 用 `with-out-str` + `pprint`，wrap 只负责字符串 fence，formatter 修正缩进，数据层双射 | `pr-str` 单行布局；pprint 在 wrap 之后；闭合围栏独占一行；缩进不足报错；固定 `##` |


### 方法论名人复盘（2026-11-13）

| 阶段 | 名人 | 原职责 | 新设计下的定位 | 结论 |
|---|---|---|---|---|
| S1 | Howard / Dalio / Bezos / Munger / Taleb | 决策框架、根因、逆向工作、事前验尸、否定法 | 全部保留；Non-Goals 必须写进唯一 markdown，不再有独立 `non_goals` 参数 | 保留 |
| S2 | Bach / Myers / Weinberg | Testing != Checking、证伪路径、质量与 WTP | 全部保留；CASE 权威改为 `s2-cases.edn`，不再冻结哈希 | 保留 |
| S3 | Polya / Schoenfeld | 理解、计划、执行、回看；资源与元认知 | 保留为写作与自检透镜 | 保留 |
| S3 | Parnas / Hickey / Ousterhout | 信息隐藏、de-complect、深模块 | 从“结构化 modules 门禁”降为 prose 设计透镜；系统不解析模块、不校验覆盖 | 重构定位 |
| S4 | Knuth | 文学化伪代码 | 提升为 S4 的主纪律：markdown + Promela 是唯一形式真理；Promela 表达力不足时，用注释嵌入 Knuth 风格伪代码 | 提升 |
| S4 | Lamport / Dijkstra | Safety / Liveness、守卫命令 | 提升为 Promela 模型的内容纪律；但系统不跑 Spin，模型只保存观察 | 提升 |
| S4 | Brooks | 人月神话、沟通成本 | 从 Worktree Slice 切分改为单 board 任务边界与 O(1) 沟通；不再用多 worktree 并行 | 重构定位 |
| S4 | Amdahl / Reinertsen | 关键路径、锁争用、批次流 | 只用于单 board 锁与审计批次；不存在 worktree/rebase/ff 拓扑 | 收窄适用域 |
| S5 | 无固定名人 | — | 补入 Lamport/Dijkstra 的 board 安全/活性、Brooks 的单 board 沟通、Weinberg/Myers/Bach 的审计证伪 | 补入透镜 |

**原则**：名人提供判断透镜，不提供机器门禁。任何“因为某名人所以必须存在 modules/slices/worktree”的推论都不再成立；反过来，删掉结构化门禁也不等于删掉这些人的问题意识。

## 2026-11-14 修复 dogfood 同步回执污染 wait 队列

- **根因**：`src/herd/repl.cljs` 的 `run-role` 在 2000ms 内同步完成或失败返回给调用方后，`track!` 仍将 `:completed`/`:failed` 留在 `@programs`；导致后续慢任务 `:forked` 后调用 `wait` 时，`take-finished!` 重复吐出历史同步程序结果。
- **修复**：新增 `:returned-directly` 守卫与 `finish-directly!`，同步返回（非 `:forked`、非 `:parked`）的程序立即从 `@programs` 清除；`tests/cljs-sandbox.test.mjs` 更新 `unpark` 同步队列预期并新增回归用例验证。

## 2026-11-14 精炼合并 `HACK.md` 至 `src/AGENTS.md`

- 裁剪 `HACK.md` 中的历史 `cherry-cljs`/bwrap/worktree/旧 dogfood 日记，将常青宿主实测（`ExtensionRunner.createContext` 受控补丁、hooks/`runSubprocess` 边界、`nbb` `cljs.pprint`、`BUN_OPTIONS`、`context` 深拷贝与压缩边界、复检命令）精炼合并至 `src/AGENTS.md` §5；同步更新 `AGENTS.md`、`UFSS.md`、`DEBT.md`、`README.md` 与 `src/host/imports.mjs` 引用并删除 `HACK.md`。

## 2026-11-14 修复同进程写锁自踩 LOCK_BUSY 与上游守卫正文误判

- **`LOCK_BUSY`（`src/herd/sandbox.cljs`）**：`with-lock` 原先让同进程并发多路径写入同时争抢单一跨进程文件锁且同刻起算 500ms 超时，导致 `p/all` 写多个文件自踩超时。现按 `(lock-path)` 维护进程内 FIFO 队列，仅获得轮次后才申请跨进程锁并计时；外部真实占锁仍按 `HERD_LOCK_WAIT_MS` 报错。
- **上游守卫误判（`src/herd/system.cljs`）**：`event-blob` 原先扫描全部 `event.messages` 与成功工具的 `event.result`，读到含 `402`/`429`/`insufficient_quota` 的文档/源码即误触发 `stalled` 或 5s 后强制插嘴重试。现仅检查错误载体字段与异常 `stopReason` 下的错误文本，`tool_execution_end` 仅在 `isError: true` 时检查。

## 2026-11-14 跨平台按需单例 IPC 事件驱动锁替代文件锁轮询

- **旧实现痛点**：`sandbox.cljs`（`.herd/locks/clj-core.cross-process.lock`）与 `swarm/store.cljs`（`s5-board.lock`）使用 `wx` 锁文件 + 指数退避/5ms 轮询 + `pid` 存活检测，存在 `stale-lock` 遗留漏洞、同进程并发自踩超时与高频磁盘轮询。
- **clean-break 方案**：新增 `src/host/lock-daemon.mjs`（`node:net` 跨平台流式 IPC：Linux 抽象 socket `\0herd-lock-*`、Windows Named Pipe `\\.\pipe\herd-lock-*`、macOS/其他 POSIX `tmpdir` 短路径 `.sock`；按需拉起、空闲 30s 自退、连接即持锁、`SIGKILL` 由内核关闭 fd 秒级唤醒下一位、零轮询、无 `stale-lock`）；同步移除 `sandbox.cljs` 与 `swarm/store.cljs` 全部 `wx` 文件锁/轮询/PID 判活逻辑，并重写 `tests/cljs-lock-contention.test.mjs` 与更新 `AGENTS.md`。
