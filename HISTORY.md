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
3. **把 `sessionFile` 当父会话链接**：宿主实测在 `artifactsDir` 下忽略它；不得向用户宣称 `history://` 可重放父链。详见 `HACK.md` 与 `DEBT.md` D5。
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
