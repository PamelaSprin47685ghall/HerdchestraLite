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
