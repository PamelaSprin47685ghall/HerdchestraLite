# Herdchestra Lite

Herdchestra Lite 是面向 `omp` 终端宿主的轻量多智能体研发插件。它把一次使命组织为 S1 头脑风暴、S2 手工测试方法论、S3 开发指南、S4 协调手册与 S5 蜂群自治开发，并用文件门禁、看板、ClojureScript 沙箱、Scope 投影与并发手工审计约束过程。

> **当前状态：clean-break 改造进行中，未完成实现验收。**
> 本文件只描述当前工作区里可核对的结构与缺口，不声称功能已经交付，也不把任何测试结果当作验收证据。唯一规格是仓库根 `AGENTS.md`；宿主与依赖的实测事实在 `HACK.md`；未关闭的规格偏差在 `DEBT.md`；架构装配笔记在 `src/AGENTS.md`。
>
> 核对时间：2026-11-11。并发 cutover 仍在进行，文件可能继续变化；以工作区当前内容和 `DEBT.md` 为准。

## 当前可核对的事实

- `package.json` 的 `omp.extensions` 与 `pi.extensions` 都只声明两个入口：`./src/bootstrap-main.mjs` 与 `./src/tool-gate/index.mjs`。
- 运行时依赖只声明 `cherry-cljs@0.6.38`；`engines.bun` 为 `>=1.4.4`。
- `src/main.mjs` 当前装配新模块：`host/`、`util/`、`clj-sandbox/`、`tool-gate/`、`scope/`、`stages/`、`swarm/`、`prompts/`、`tui/`。它不导入旧的 `pi-goal`、`pi-context`、`editor-theme` 或 `manual-acceptance` 运行时；这不等于行为验收完成。
- `tests/` 下有新模块的开发者测试；这些测试只保护内部不变量，不是手工验收证据。
- 旧实现目录 `src/pi-goal/`、`src/pi-context/`、`src/editor-theme/`、`src/context/`、`src/manual-acceptance/`、旧提示词模块、`src/util/objects.mjs` 与旧 manual-acceptance 测试已从工作树删除；当前 `src/` 只保留新模块，且不再引用这些旧路径。
- 真实宿主当前加载的插件路径、宿主版本三元组、`cherry-cljs` 实测与未验证项以 `HACK.md` 为准。`HACK.md` 记录到当前 `omp plugin list` 仍指向 `/home/kunweiz/public/HerdchestraLite`，不是本工作区；因此“本工作区被真实宿主加载”尚未证明。
- `docs/manual-acceptance/clean-break/` 是开发本产品的验收文档；它没有 `report.md`，没有完成手工验收。产品运行时自己的交付路径是 `plans/<slug>/`，当前也没有端到端使命产物。

## 模块与装配

新模块按单向依赖组织，入口只装配。实际导入关系见 `src/AGENTS.md`；当前主干如下：

```text
src/
├── bootstrap-main.mjs              # 入口 1：惰性加载 main.mjs，记录 health
├── main.mjs                        # 主装配：命令、工具、hook、TUI、runner 端口
├── tool-gate/
│   ├── index.mjs                   # 入口 2：注入/准入/剥离 gate 字段
│   └── schema.mjs                  # 多传输 schema 注入与 strip
├── host/
│   ├── imports.mjs                 # 宿主与 cherry-cljs 的唯一导入集中处
│   ├── subprocess.mjs              # AgentDefinition、runSubprocess、取消树
│   └── health.mjs                  # 跨入口 health 注册表
├── util/
│   ├── atomic-write.mjs            # 同目录 .tmp + fsync + rename
│   ├── file-lock.mjs               # wx 锁、判活、陈旧锁
│   └── errors.mjs                  # 错误码与 EDN 诊断
├── clj-sandbox/
│   ├── ufss.mjs                    # EDN + UFSS 读取/打印
│   ├── where.mjs                   # UTF-16 精确匹配与最近行诊断
│   ├── evaluator.mjs               # Promise-CPS 解释器与续体
│   ├── vfs.mjs                     # 批内 VFS、stamp、W 提交
│   └── tools.mjs                   # clj_plan/devops/review/worker/auditor
├── scope/
│   ├── ledger.mjs                  # Scope 四型、预算、assume
│   └── projection.mjs              # 出站裁剪、简报钉住、缓存断点
├── stages/
│   ├── disclosures.mjs             # S1–S5 简报
│   ├── parsers.mjs                 # S1–S4 结构校验
│   ├── contract.mjs                # mission.edn、冻结、重对齐、批准
│   ├── gate-tools.mjs              # advance_s1..s4、ask_user、devops、submit_review
│   └── scores.mjs                  # K 路审计汇总与 s5-report
├── swarm/
│   ├── board.mjs                   # 看板短事务与 board_* 内核
│   ├── worktree.mjs                # fork/join/abandon/GC
│   ├── runner.mjs                  # Reviewer ⇄ Swarm、槽位、Nudge、Oracle
│   └── auditors.mjs                # K 路 Manual Auditor 批次
├── prompts/
│   ├── common.mjs                  # COMMON（无 S2–S5 剧透）
│   ├── roles.mjs                   # 固定角色提示词与审计员模板
│   └── runtime-wires.mjs           # 语言后缀、gate 字段、Nudge
└── tui/
    ├── dashboard-model.mjs         # 纯数据双态/审计矩阵
    └── dashboard-widget.mjs        # aboveEditor 组件与文本降级
```

`tools/dev-acceptance/` 是独立的开发验收提交包，只服务 `docs/manual-acceptance/**`；它不是产品运行时入口，也不是 K 路审计执行器。

旧模块已删除，不要恢复或重新 import。`src/` 当前只保留新模块；独立开发验收包仍只位于 `tools/dev-acceptance/`。

角色收窄由宿主报告的子会话身份（`ctx.agent`）与 M0 发布的 role surfaces 决定；`tool-gate/schema.mjs` 不再注册 `role-auth`/nonce 凭据，也没有独立的 `tool-gate/role-auth.mjs`。首行 `[HERD_ROLE: ...]` token 仍作为父进程写入的角色声明被解析和核对。

## 命令与工具

以下名称来自当前源码注册表，尚未在真实宿主上完成用户可见验收：

- 命令：`/herd`、`/herd-status`、`/herd-list`、`/herd-focus`、`/herd-unfocus`、`/herd-cancel`、`/herd-recovery`、`/herd-settings`。
- 阶段门禁：`advance_s1`、`advance_s2`、`advance_s3`、`advance_s4`、`ask_user`、`devops`、`submit_devops_report`、`submit_review`。
- 看板与令牌：`board_split`、`board_claim`、`board_finish`、`board_cancel`、`board_replace`、`board_release`、`board_reopen`、`board_comment`、`board_update`、`board_park_slot`、`board_take_or_die` 等。
- Worktree：`fork_slices`、`join_slice`、`abandon_slice`、`gc_worktrees`。
- 沙箱：`clj_plan`、`clj_devops`、`clj_review`、`clj_worker`、`clj_auditor`。
- 审计与会诊：`submit_case_audit`、`submit_oracle_advice`。
- Scope：`ask_previous_scope`、`assume`。

工具参数与回执的规范形状以根 `AGENTS.md` §4、§5、§8 为准。`fork_slices` 会创建 worktree 并启动 Slice runner；`join_slice` 在 FIFO 队列耗尽时调用 `runMissionAudit`，源码路径已连接 `startAuditBatch`、`aggregate`、`writeS5Report` 与修复切片，但真实宿主、重启和全 Slice 场景尚未验收，见 `DEBT.md`。

## 本地开发检查（不是验收）

```bash
bun install
bun test
bun run check
```

这些命令只用于开发者自查，不构成手册验收证据，也不提高任何 CASE 的分数。真实宿主挂载尚未证明；在 `DEBT.md` 的“真实宿主加载与端到端使命”关闭前，不要把本仓库当作可发布安装包，也不要照旧版 README 的三入口/18.18.6/`pi-context`/`pi-goal-x` 说明操作。

## 仍未完成/未验证的主要缺口

完整队列见 `DEBT.md`；这里只列影响判断的前几项：

1. S5 审计源码已接入 `main.mjs`，但触发只依赖 `join_slice` 队列耗尽；真实宿主中的全 Slice、重启恢复、批准与报告尚未验收。
2. 角色收窄依赖宿主 `ctx.agent` 的子会话身份；`HACK.md` 记录的实际宿主/类型包版本不一致，真实 17.x/16.x 形状未验证。首行 role token 仍存在，但没有独立 role-auth 注册表可作为回退。
3. 真实宿主加载、真实 `tmux`/TUI 交互、完整 S1→S5 使命与手工验收报告均未完成。
4. 全量 `bun test` 与根规格 V01–V08/T01–T13/F01–F15 交错矩阵尚未逐项核对；测试不是验收证据。
5. `sessionFile` 父链在宿主 `artifactsDir` 下不可兑现；不要向用户宣称 `history://` 可重放父链，详见 `DEBT.md` 与 `HACK.md`。
6. 真实出站零剧透与提示词工具名一致性测试仍缺席；静态提示词拷贝测试不会替代它。

## 文档边界

| 文档 | 作用 |
|---|---|
| 根 `AGENTS.md` | 唯一规格（SSOT）；只有人类操作员可以修改 |
| `HACK.md` | 宿主、依赖、Git、验收环境的实测事实与复检步骤 |
| `DEBT.md` | 根规格要求但当前未做到的事项；关闭即删除 |
| `HISTORY.md` | 历史取舍、被拒方案、旧产物保全记录 |
| `src/AGENTS.md` | 全局架构装配笔记与单向依赖图 |
| `docs/manual-acceptance/clean-break/` | 开发本产品的 MANUAL ACCEPTANCE 文档；不是产品运行时 `plans/<slug>/` |
| `docs/旧的方法论.md`、`docs/旧的架构.md`、`docs/旧的设计.html`、`docs/讨论纪要.md`、`docs/兄弟项目参考.md` | 用户既有历史资料，保留只读，不因 clean-break 删除或改写 |

本 README 与 `CHANGELOG.md` 只描述当前工作区，不替代根规格，也不声称验收完成。
