# Clean-Break 全项目开发协调手册（S3）

> 状态：S3 唯一产物，待人类确认。本文件只定义协调方式、切片、接口、合并与验收映射；不修改产品代码、根 `AGENTS.md`、已批准的 `requirements.md` 与 `development-guide.md`，也不创建 `plans/`、证据目录或其他文件。
>
> 写作期间只做了文档读取与仓库清单，没有执行任何 CASE、`bun test`、`biome`、构建、`omp` 命令或故障注入；没有产生分数、哈希或证据。文中所有“完成条件”都是待执行判据，不是已观察结果。S1/S2 陈述的现状（public 副本、未跟踪根规格、共享 gitdir、旧验收插件、宿主版本等）未被本文件独立复核，只作为待证明的输入。
>
> 2026-11-11 复核补充：已读取 `agent://devops` 的只读预检，并逐项核对其对 S1/S2 的接口、切片与验收冲突。本文件新增 C-21–C-28，并在 §5.1、§5.2、§6.2、§11、§13、§14、§15 标明 `intent` 侧通道、批准/返工唯一所有者、B1/B2/T3 端口环、子代理父链宿主差异、独立开发验收工具的执行能力与 Spike 的执行期先决。未修改 S1/S2/根规格。

## 1. 目标、边界与权威

### 1.1 目标

把仓库从旧的 `pi-goal-x` / `pi-context` / 编辑器主题垫片实现，整体切换为根 `AGENTS.md` 描述的 Lite 运行时：两个清单入口、仅 `cherry-cljs` 运行时依赖、五阶段门禁、渐进披露、ClojureScript 沙箱与受保护提交、看板/令牌/任期、多 Worktree、K 路并发手工审计、Scope/UFSS/TUI/恢复。旧路径、旧依赖、猴子补丁、旧工具名与兼容 shim 必须删除，不保留“先走旧路”的隐藏分支。

### 1.2 本文件的边界

- 本文件是**开发协调手册**，不是产品运行时的 `plans/<slug>/s4-coordination.md`，也不是 S4 手工验收报告。
- 本文件的 Slice 是**实现本仓库 clean-break 的工作切片**，不是产品运行时某个使命的 Slice。
- 本文件不重新定义 S1 的 39 个 CASE、阈值、评分细则；这些以 `requirements.md` 为准。
- 本文件不重新定义 S2 的模块契约；这些以 `development-guide.md` 为准。若两者与根规格冲突，按 §3 记录，不擅自修改任何已批准文档。

### 1.3 权威顺序

1. 根 `AGENTS.md`（人类唯一可改的 SSOT）。
2. 已批准的 `requirements.md`（S1）与 `development-guide.md`（S2）。
3. 本文件；只在协调、切片、合并与执行顺序上生效。
4. `HACK.md` / `DEBT.md`（执行时创建）与源码注释。

根规格、S1、S2 之间出现冲突时，本文件只登记、隔离影响、给出默认处置；最终由人类裁决。AI 不得用“实现方便”重写规格，也不得用本文件覆盖已批准文档。

### 1.4 不声称的事项

本文件没有声称：任何 CASE 已执行或通过；任何模块已实现；`cherry-cljs` 已加载；`omp` 已加载本工作区；旧资产已迁移；任何分数、哈希或证据已产生；目标 `advance_s4` 已接受本文件。

## 2. 命名与阶段映射（先消除歧义）

本地开发验收流水线与产品运行时使用不同的阶段编号和路径。两者不能互相冒充：

| 本地开发验收（本仓库当前） | 产物 | 对应的产品运行时阶段 | 关系 |
|---|---|---|---|
| S1 手工验收需求 | `docs/manual-acceptance/clean-break/requirements.md` | 产品 S1（需求决策）+ 产品 S2（手工测试方法） | 本地 S1 把可验收行为和 39 个 CASE 写在一起；产品 S1/S2 是两份独立产物，不能直接等同 |
| S2 开发指南 | `docs/manual-acceptance/clean-break/development-guide.md` | 产品 S3（目标开发指南） | 内容对应，路径与门禁不同 |
| S3 协调手册 | `docs/manual-acceptance/clean-break/coordination.md` | 产品 S4（开发者协调手册） | 本文件；主题对应，但不是产品 `plans/<slug>/s4-coordination.md` |
| S4 手工验收报告 | `docs/manual-acceptance/clean-break/report.md` | 产品 S5（蜂群自治与并发审计） | 主题对应；本地 S4 由可见审计员执行，产品 S5 由运行时 K 路审计执行 |

**关键结论**：

- 本文件的 39 个 CASE 来自本地 S1，不是产品的 `s2-manual-tests.md`。若要把本文件晋升为产品 S4，必须先在产品 S1/S2/S3 流程中重新生成对应文档与 CASE 契约；不能把 `requirements.md` 直接改名为 `s2-manual-tests.md`。
- 本地 S3 的提交工具只要求 Markdown 非空且含 `##` 章节；产品 `advance_s4` 还会校验 Slice 唯一性、DAG 无环、CASE 全覆盖、字段非空和 Markdown 含伪代码/Safety/Liveness/合并顺序。本文件按更严格的目标 schema 编写，但**没有**声称已通过目标门禁。
- 产品运行时只允许 S1 人工批准；本地 S1/S2/S3 的人类确认是开发流程门禁，不是产品使命状态，不得写进 `mission.edn`，也不得让产品运行时多出人工审批。

## 3. 与根规格的矛盾登记

下表只记录，不修改。每项都给出影响与默认处置；“待人类”表示不能由 AI 自行解决。

| ID | 冲突 | 证据 | 影响 | 处置 | 状态 |
|---|---|---|---|---|---|
| C-01 | 本地 S1–S4 与产品 S1–S5 的编号、路径、门禁不同；本文件是本地 S3，主题对应产品 S4 | 根 §2.3、§9.7、§10.4；S1 标题与 §9；S2 标题与 §13 | 不能把本文件直接交给 `advance_s4`；不能把 `docs/manual-acceptance/` 当产品交付物；四哈希契约不适用 | 严格分离两套路径；本文件只协调开发；若晋升，重写为 `plans/<slug>/s4-coordination.md` 并过目标门禁 | 范围已区分，命名碰撞保留；晋升待人类 |
| C-02 | 根规格文件名写作 `AGENTS-LITE.md`，实际文件是 `AGENTS.md` | 根 §8.2 COMMON、§9.1 目录树；S1 §8 #1；S2 §11 Q1 | 提示词引用不存在的文件；复制/哈希脚本可能漏文件 | 保留 `AGENTS.md` 为 SSOT，不改名；在 `HACK.md`/`DEBT.md` 记录引用不一致；由人类决定是否修文 | 待人类 |
| C-03 | 当前 `omp` 可能加载 `/home/kunweiz/public/HerdchestraLite`，而目标工作区是本仓库 | S1 §8 #11、CASE-01/39；S2 §2.6.1、§7.7 | 加载的不是本副本时，所有真实宿主 CASE 无效；worktree 的 base 也可能错 | 本工作区作为候选规范副本；验收前禁用/卸载 public 链接或用隔离 `HOME`；CASE-39 证明 `realpath` 与唯一标记 | 待人类确认唯一规范路径 |
| C-04 | 根 `AGENTS.md` 可能未被 Git 跟踪；工作区可能共享 gitdir；`git worktree`/`archive` 不带未跟踪文件 | S1 §8 #12；S2 §7.7；根 §9.1 | Slice worktree 读不到根规格、S1/S2、`plans/`；`git archive` 副本缺契约 | 不擅自 `git add`；测试副本显式复制并核对 `sha256`；Slice worktree 默认通过 C3 只读根白名单读取契约，不复制；记录 `rev-parse --show-toplevel --git-dir --git-common-dir` | 待人类决定是否纳入 Git |
| C-05 | 旧验收插件 `src/manual-acceptance/` 是 clean-break 的替换对象，但当前 S1–S4 提交仍依赖它 | S1 §8 #2；S2 §7.6；根 §9.1 目标树、§9.6 步骤 3、§9.7 | 直接删会破坏当前开发验收；保留在产品入口会重复注册并进入 `/herd` 工具面 | 建 `tools/dev-acceptance/` 独立子包；旧路径保留到 DA 冒烟通过；根 `omp.extensions` 只留两个产品入口 | 待人类决定 DA 去留与切换时点 |
| C-06 | 根规格钉住 `omp` 18.12.x；S1 记录本机 18.16.0；S2 实测候选还有 17.3.5/18.12.4/16.1.22，且本地无 18.16.0 JS/types | 根 §1.2；S1 §2；S2 §2.6.3、§10 D8 | 钩子形状、`{input}`、`reason`、TUI、子代理字段可能不同；固定写死会造假契约 | 运行时 `realpath` + `package.json` + 能力探测；`HACK.md` 记录三元组；CASE-33 以行为为准 | 待人类确认参考基线 |
| C-07 | 根 §1.2 写 `before_agent_start` 返回 `{systemPrompt}`；S2 实测 18.16/18.12 类型是 `systemPrompt: string[]`，18.16 另有 `reason` | 根 §1.2；S2 §2.6.3 | 返回字符串可能丢失提示或触发类型错误 | M0 返回 `string[]`；`reason` 缺失按 `"prompt"`；Spike 验证后写 `HACK.md` | 待 Spike |
| C-08 | 根 §1.2/§4.1 说 `cherry-cljs` 提供 EDN Reader、异步序列与 `defprogram`；S2 实测 0.6.38 无公开 EDN reader、不自动 await、`defprogram` 是普通函数、`mapv`+`js-await` 非法 | 根 §1.2、§4.1；S2 §2.6.3、§10 D1 | 直接把 Cherry 当完整求值器会卡住挂起/恢复/async HOF | 自建 C0 reader 与 C2 Promise-CPS；Cherry 只作数据/纯函数运行时；`HACK.md`/`DEBT.md` 记录；不回退 JS 全局 | 架构单向门；待人类确认 Q3 |
| C-09 | 根 §6.1 说优先 `setWidget`/`setHookWidget`；S2 实测 `setHookWidget` 不在公开 `ExtensionUIContext` | 根 §6.1；S2 §2.6.3、§10 D27 | 调用内部方法会失败或依赖宿主内部 | 只用 `ctx.ui.setWidget`；字符串数组最多 10 行作降级；CASE-27/33 验证 | 待 Spike |
| C-10 | 根 §1.2 把 `sessionFile` 当父会话链接；S2 实测 `artifactsDir` 存在时它被忽略 | 根 §1.2；S2 §2.6.3、§10 D24；S1 CASE-23 | 父链/`history://` 证据可能不存在；CASE-23 的预期会落空 | 用 `artifactsDir/<id>.jsonl` + `eventBus`；回执明示父链不可用；CASE-23 按实际行为记录 | 待人类确认父链要求 |
| C-11 | 根 §7.3.1 用 PID 判活；S2 实测所有子代理共享同一 OS PID，死子代理看似存活 | 根 §7.3.1；S2 §2.6.3、§10 D11 | 陈旧锁误判、恢复误删/误等 | U2 锁记录 `lock_id`/`agent_id`/`term_id`；先查 runner 状态，PID 只作跨进程辅助；CASE-28 验证 | 待 Spike |
| C-12 | 根 §2.5 假设 Slice worktree 能读冻结契约；S2 实测 worktree 不带未跟踪 `AGENTS.md`/`plans/`/`docs/`，也不带 `node_modules` | 根 §2.5；S2 §2.6.3、§7.7、§10 D25 | Slice 读不到契约或无法跑测试，可能误判“契约缺失” | C3 只读根白名单（默认，不复制）；B1 显式 `git -C`/`--show-toplevel`；测试副本才显式复制并核对哈希；依赖走祖先 `node_modules` 或显式安装 | 待人类确认复制/挂载方式 |
| C-13 | 根 §9.1 目录树只列 `host/imports.mjs`、`host/subprocess.mjs`，没有 `host/health.mjs`；S2 模块表新增 H2 | 根 §9.1；S2 §2.3 | 文件所有权与模块 DAG 和根树不完全一致 | 以已批准 S2 的模块表为准；H2 纳入 SL-03；在 `DEBT.md` 记录与根树的差异 | 记录，不改根 |
| C-14 | 根 §10.4 把 `docs/manual-acceptance/` 四文件列为被拒的**产品规划**方案；根 §9.7 又把同一路径定为**开发本产品**的验收路径 | 根 §10.4、§9.7；S1、S2 全文 | 容易把开发验收产物当产品交付物，或反之 | 产品运行时的规划/证据只用 `plans/`；开发验收只用 `docs/manual-acceptance/`；证据中标注路径归属 | 范围区分，不修改规格 |
| C-15 | 本地 `submit_coordination` 只校验非空与 `##`；目标 `advance_s4` 还校验 Slice 唯一/无环/CASE 全覆盖/字段非空/Markdown 结构 | 本地 `src/manual-acceptance/constants.mjs`、`tools.mjs`；根 §2.3 | 本地接受不等于目标接受；不能虚报目标门禁通过 | 本文件按目标 schema 自检；若晋升，实际调用 `advance_s4`；未调用前只写“未验证” | 未执行目标门禁 |
| C-16 | S2 §2.6.4 要求 Host/Sandbox/Lock/Git Spike 在 S3 冻结前通过；本 S3 正在冻结，Spike 未执行 | S2 §2.6.4；本文件写作状态 | 架构假设未证实；但把 Spike 当“编码前硬闸门”会让纯接口与无关 Slice 无谓等待 | **不假定 Spike 必须在真实编码前全部完成**；SL-00 与纯接口并行，真实接口验证安排为执行期先决；每个下游 Slice 的 `done_when` 必须包含其实际接口探测；未验证项写入 `DEBT.md`/`HACK.md`，不声称通过 | 执行期先决；待 Spike 结果或人类豁免 |
| C-17 | 根规格只允许 S1 人工批准；本地手工验收协议要求 S1/S2/S3 文档都经人类确认 | 根 §2.3；本地 S1/S2/S3 流程 | 把开发确认写进产品状态会制造额外人工门禁 | 开发确认只记录在开发证据；产品 `mission.edn` 仍只记录 S1 批准；两套状态不互写 | 范围区分 |
| C-18 | S1 CASE-01 要求 `plans/` 目录存在；当前仓库清单未显示 `plans/` | S1 CASE-01；S2 §7.4、§7.7；当前工作区清单 | CASE-01 可能在“目录不存在”上失败，但这不是产品缺陷 | CASE 测试副本中按产品运行时创建 `plans/`；不在仓库提交空占位；若产品要求首次 `/herd` 创建，记录实际行为 | 待人类确认测试夹具 |
| C-19 | 根规格要求 `cherry-cljs` 精确版本写入 `package.json`；S2 目标清单仍用 `<exact-version-verified-in-HACK.md>` 占位 | 根 §7.5；S2 §7.5；S1 §8 #3 | 依赖清单无法最终冻结；范围版本会破坏可复现 | SL-00 安装/探测后确定精确版本；SL-14 写入；禁止范围版本 | 待 Spike |
| C-20 | S1 CASE-23 期望父会话 `sessionFile` 作为父链接；S2 实测被 `artifactsDir` 覆盖，且不同宿主版本可能根本不提供父链 | S1 CASE-23；S2 §2.6.3、§2.6.5 | 证据可能缺失；审计员父链不可用；把 `sessionFile` 写成 H1 承诺会制造不可兑现契约 | H1 只承诺记录实际值和 `artifactsDir/<id>.jsonl`；父链是探测结果，不是承诺；CASE-23 由人类裁决“记录实际行为”还是“必须父链”；不伪造 | 待人类确认 |
| C-21 | G1 在 `tool_call` 执行前剥离 `intent`，但 C2/C4 需要 `intent` 计算沙箱期限；S1 CASE-14/36 依赖该期限 | S2 §3.3 G1 第 5 步；S2 §3.2 C2 `runProgram(...,{intent})`；C4 参数 `{program_name,code,intent}`；根 §4.4 期限 = intent UTF-8 字节 × 50ms | 底层工具收不到 `intent`，期限无法计算；直接不剥离又与“底层工具收不到门禁字段”冲突 | 冻结 `CallMeta` 侧通道：G1 校验 `intent` 后写 `{tool_call_id, intent_bytes, deadline_at}` 到跨入口 rendezvous；C4/C2 通过端口读取；执行输入仍不含 `intent`；缺失则 `:INTENT_REQUIRED` fail-closed。若宿主无法支持侧通道，才显式选择“对 `clj_*` 不剥离 `intent`”并记录偏差 | 本手册已冻结默认（CallMeta）；待人类/Coordinator 确认；否决则重写本节 |
| C-22 | T2 与 T4 都声明 `issueApproval`/一次性批准，批准凭证没有唯一所有者 | S2 §3.4 T2 `issueApproval/verifyApproval`；T4 `issueApproval`；S1 CASE-24 | 两套 token 生成逻辑会产生两个真相；批准可被错误重用 | 冻结 T2 为唯一签发/校验者；T4 只调用 T2，不导出/不写 `issueApproval`；`mission.edn :approval` 只由 T2 写；B3 不得写批准 | 本手册已冻结默认（T2 唯一）；待人类确认 |
| C-23 | T4 与 B3 都做提交校验/返工派生；B2/B1 也参与返工，所有权重叠 | S2 §3.4 T4 `aggregate` 拒绝七类并“派生修复任务”；§3.5 B3 `validateSubmissions` + `deriveRepairSlices`；S1 CASE-24/25 | 两套校验的错误码/证据路径判断可能不同；返工可能重复派生或漏掉失败 CASE | 冻结：B3 只做单提交结构/证据/快照校验并返回规范化失败；T4 只做跨提交聚合、阈值、报告、调用 T2 批准；T4 产出 `RepairSpec`；B2/B1 只消费 `RepairSpec` 执行；`deriveRepairSlices` 只能有一个实现 | 本手册已冻结默认（B3 单提交、T4 聚合）；待人类确认 |
| C-24 | B1 `forkSlices` “启动 B2”，B2 依赖 B1；B1 又缺 B0 依赖；T3 注册 `submit_review` 却未声明 B2/P1/P2 依赖 | S2 §2.3 B1/B2/T3 依赖表；§3.5 B1/B2；§3.4 T3 | ESM 导入环或运行时找不到 `submit_review`；B1 初始化 board 缺 B0；B1/B2 无法拆成独立 Slice | 冻结端口：B1 增加 B0 依赖；`forkSlices` 只创建 worktree/board/locks 并返回 `SliceHandle[]`，**不 import B2、不启动 B2**；T3/M0 通过 `runnerPort.startSlice(handle)` 启动 B2；T3 通过 `reviewSink` 端口提交 findings，**不 import B2**；B2 补 U2/P1/P2 依赖 | 本手册已冻结端口默认；待人类确认 |
| C-25 | P1 只列 4 个角色提示词，缺 Plan/Coordinator/Holder；M0 写成“内容为”而非追加 `event.systemPrompt`；S1 又不能 import P1 | S2 §3.6 P1、§2.4 角色表、§3.7 M0 | S1 首回合缺 Plan 提示词；M0 可能替换宿主系统提示词；S1 加载 S5 角色文本会破坏渐进披露 | P1 拆 `P1a`（S1/Plan/Coordinator）与 `P1b`（Reviewer/Worker/Holder/Auditor/Oracle）；S1 只加载 `P1a`；M0 明确 `systemPrompt: [...event.systemPrompt, ...COMMON, ...briefing, ...role, ...pairHint]`；Holder 复用 Worker + 增量或单独补 | 本手册已冻结默认；待人类确认 |
| C-26 | C3 允许 Auditor 写 `plans/<slug>/evidence/`，下一句又说写 `plans/` 一律 `:PATH_ESCAPE`；B3 全量快照会把审计员写证据当主工作区篡改 | S2 §3.2 C3 根策略；§3.5 B3 `snapshotWorkspace`；T4 `snapshotBefore/After`；S1 CASE-11/23/24 | 按字面实现，Auditor 无法写证据；K 个审计员第一次写证据就触发 `:AUDIT_WORKSPACE_MUTATED` | 冻结 C3 路径例外：Auditor 只可写 `plans/<slug>/evidence/<case_id>/` 与专属 `/tmp/herd-audit-*`；其他 `plans/` 仍拒绝。B3 快照定义“保护集/允许写入集”：产品源码/测试/配置/文档/根规格/`.herd` 控制态受保护；证据、`.herd/artifacts/**`、`.herd/audit/**`、`.herd-worktrees/**` 为预期写入，不计篡改 | 本手册已冻结路径例外/保护集；待人类确认 |
| C-27 | 独立开发验收工具 DA 只有 `submit_manual_*`/`submit_manual_report`，没有审计执行器、K 路调度、分数汇总、隔离/超时；且嵌套 `package.json` 不随根链接自动加载 | S2 §3.8 DA；S2 §7.6 第 3 条；S1 的 39 CASE 与“可见审计员”；DevOps 预检 | 39 个 CASE 没有执行主体；单审计员串行约 39 小时；把 DA 当执行器会误报 | DA 只定位为“提交工具”，不是审计执行器；SL-15 只验证独立链接与提交；S4 必须另设可见审计执行流程（K 名审计员各自 evidence，或人工流程），并明确 `report.md` 单写者；不把 `submit_manual_report` 当执行证据 | 执行能力未验证；待人类决定 S4 执行方式 |
| C-28 | Spike 未执行；若把 S2 §2.6.4 当“编码前必须全部通过”，会阻塞纯接口与无关 Slice；若忽略，又会冻结未验证的真实接口 | S2 §2.6.4、§12.1；DevOps 预检 | 架构假设未证实；下游接口可能是 provisional | 不假定 Spike 必须在真实编码前完成；SL-00 与纯接口并行；每个 Slice 在自己的 `done_when` 中验证实际用到的宿主/Cherry/git 接口；未通过项记录 `DEBT.md`/`HACK.md`，相关接口标 provisional；不静默修改 S1/S2 | 执行期先决；待 Spike 结果或人类豁免 |

**不是矛盾但必须防误读**：根 §10.4 拒绝的是“把 `docs/manual-acceptance/` 四文件当作产品运行时规划文档”；根 §9.7 允许的是“开发本产品时的验收路径”。两者同时成立，前提是路径与产物不混用。

### 3.1 DevOps 预检的其余 P0 项（只登记，不扩写）

| ID | 事项 | 影响 | 本手册的冻结/归属 | 状态 |
|---|---|---|---|---|
| D-01 | C3/B0 的 `control`/`writeGate`/`identity`/`claim` 端口没有类型；C3 依赖表不含 B0 | C3 与 B0 并行时，`commit` 的 `:applying`、claim 校验、事件记录对不上 | 冻结四个纯数据契约：`WriteGateHandle`、`BoardControlPort`（`markApplying`/`publishResult`/`markUncertain`）、`ActorIdentity`、`ClaimRef`；B0 实现，C3 只依赖端口；C3 不 import B0 内部 | 待接口冻结 |
| D-02 | M0 的 `submit_*` 名称不精确，可能把 DA 的 `submit_manual_*` 注册进产品 | CASE-01/39 的工具面出现重复/旧工具，硬失败 | 产品只注册 `submit_review`、`submit_devops_report`、`submit_oracle_advice`、`submit_case_audit`；`submit_manual_*` 只属于 DA；SL-14 验证 | 已标明；待验证 |
| D-03 | `advance_s4` 的“冻结后 fork”半提交未定义；fork 可能返回 `:INSUFFICIENT_WORKTREES` | mission 已是 S5 但没有 Slice；或 worktree 指向旧契约 | 先原子提交 S1–S4 哈希/契约行/`:stage :s5`，再调用 B1；fork 失败不回滚，作为可恢复状态由 Coordinator 降数重试；SL-11/SL-10 的状态机必须覆盖 | 待接口冻结 |
| D-04 | C2/B0/T3/T4/B2/B3 单模块过大，违背“一模块一变化秘密” | 关键路径上的 Slice 过大，测试/审查/并行困难 | 不改变公开接口，但内部至少拆成：C2 `analyzer`/`cek`/`continuations`；B0 `board-store`/`transitions`/`token`；T3 `stage-gates`/`devops-review`；T4 `aggregate`/`report`/`approval`；B2 `tenure`/`nudge`/`recovery`；B3 `isolation`/`snapshot`/`submissions` | 设计风险；执行时按需拆 |
| D-05 | S4 的“S1 人工批准”需要人类，但可见审计员是子代理；`report.md` 所有权与 K 路审计调度未定义 | CASE-37 的“真实人工门禁”无法证明；39 CASE 单审计员串行不可行 | 明确 S4 由真人执行 S1 批准/取消确认；审计员只观察记录；若 K 名审计员并行，各自只写 `evidence/<CASE>/report.md`，由可见主审计员汇总写最终 `report.md`；DA 只提交，不执行审计 | 待人类决定执行方式 |

**DevOps 六类结论的落点**：

1. `intent`：G1 剥离前写 `CallMeta`，C4/C2 通过端口读取；缺失 `:INTENT_REQUIRED`，不默认期限（C-21、§5.1、§7.5）。
2. 批准/返工：T2 唯一签发/校验批准；B3 单提交校验、T4 唯一聚合与 `RepairSpec`；B2/B1 只执行（C-22、C-23、§5.1、§7.7）。
3. 依赖环：B1 加 B0 依赖、返回 `SliceHandle[]` 不启动 B2；T3 经 `runnerPort`/`reviewSink`，B1/B2/T3 无 import 环（C-24、§5.2.1）。
4. 父链：H1 只记录实际 `sessionFile`/`artifactsDir`/`eventBus` 行为；CASE-23 由人类裁决，不伪造（C-10、C-20、§13.3）。
5. DA：只做提交工具，不是审计执行器；独立 `HOME` 链接需冒烟；S4 执行主体另定（C-27、§6.2、§14.3）。
6. Spike：不假定编码前全部通过；SL-00 与纯接口并行，真实接口在对应 Slice 的 `done_when` 中验证（C-16、C-28、§6.5、§14.1）。

### 3.2 执行前提（尚无法证明，不得写成通过）

| 前提 | 当前状态 | 验证时点 | 失败处置 |
|---|---|---|---|
| 真实宿主加载的是本工作区，而不是 public 副本 | S1/S2 陈述，未独立复核 | CASE-01/39；SL-14 | 隔离 `HOME`/卸载 public；不能证明则相关 CASE 无效，不降阈值 |
| 宿主版本与 `before_agent_start`/`tool_call`/`setWidget`/`runSubprocess` 实际形状 | 版本候选冲突；S2 有实测但未在本文件复核 | SL-00、SL-03、SL-14；CASE-33/34 | 能力探测 + `HACK.md`；缺失降级，不伪造 18.16 类型 |
| `cherry-cljs` 精确版本、EDN/async/`defprogram` 边界 | S2 实测 0.6.38 受限；本文件未加载 | SL-00、SL-05；CASE-12–14 | 自建 C0/C2；失败记 `DEBT.md`/`HACK.md`，不回退 JS 全局 |
| 同 PID 子代理的锁判活/恢复 | S2 指出 PID 不足；未运行 Lock Spike | SL-00、SL-02；CASE-28 | U2 用 `agent_id`/`term_id` + runner 状态；PID 仅辅助 |
| Slice worktree 的契约可读性与 `node_modules` | S2 指 worktree 不带未跟踪文件/依赖；未在真实 gitdir 验证 | SL-00、SL-10、SL-14；CASE-21/39 | C3 只读根白名单；显式安装/祖先解析；不复制控制面 |
| `sessionFile` 父链 | 宿主差异；S2 实测被 `artifactsDir` 覆盖 | SL-03；CASE-23 | 只记录实际行为；人类裁决是否要求父链；不伪造 |
| DA 独立链接与提交能力 | 目录尚未实现；嵌套 package 不自动加载 | SL-15；CASE-39 | 独立 `HOME` 冒烟；失败保留旧工具并记录；DA 不是审计执行器 |
| S1 人工批准可由真人执行 | 本地 S3 已由人类确认，但产品运行时操作员未指定 | CASE-02/37；S4 | 真人操作或人类明确授权；审计员不冒充 |
| `intent` 侧通道可跨入口传递 | 设计冻结，未在真实宿主验证 | SL-07/SL-06；CASE-14/34/36 | 失败则显式选择 `clj_*` 不剥离并记录偏差；不得默认期限 |
| B1/B2/T3 端口装配可运行 | 设计冻结，未集成 | SL-10/SL-11；CASE-21/22 | 缺失即 `:AGENT_SPAWN_FAILED`/拒绝提交；不得隐式 import |
| 审计证据路径与快照保护集 | 设计冻结，未在真实宿主验证 | SL-12；CASE-11/23/24 | 失败则修正路径/快照；不得把证据写入当产品篡改 |

## 4. 协调模型

### 4.1 角色

| 角色 | 职责 | 写权限 |
|---|---|---|
| 人类操作员 | 唯一可改根 `AGENTS.md`；批准本地 S1/S2/S3；裁决 §3 待决项 | 根规格、已批准文档 |
| Coordinator（主代理） | 维护 Slice DAG、就绪集、FIFO 队列、合并、冲突裁决、共享文档单写 | 本文件、`HACK.md`/`DEBT.md`/`HISTORY.md`（执行时） |
| Slice Owner | 一个 Slice 的实现与自检；只写自己的 `owner_paths` | 本 Slice 文件与测试 |
| Reviewer | 只读复核 Slice 的 `done_when`、接口、失败路径；不写产品代码 | 只读；提交复核意见 |
| DevOps | 只读调查宿主、依赖、git、故障注入；不写产品路径 | 只读；报告事实 |
| Integrator | 执行 FIFO join、rebase 复核、`--ff-only` 合并、记录证据 | 集成分支与 worktree 元数据 |
| Auditor | 本地 S4 阶段按 CASE 独立验收；不写产品代码 | 只写自己的证据目录 |
| DA Maintainer | 维护 `tools/dev-acceptance/`；不进入产品入口 | DA 子包 |

同一人可以承担多个角色，但**同一文件同一时刻只能有一个写者**；Reviewer/Auditor 不得与 Owner 同时写同一路径。

### 4.2 控制状态

开发协调器维护一个不进入产品运行时的 `DevRun` 状态；执行时可放在 `/tmp/herd-clean-break-coord/` 或证据目录，不提交：

```text
DevRun := {
  run_id, base_commit, integration_branch,
  slices: Map<SliceId, SliceSpec>,
  ready: Set<SliceId>, active: Set<SliceId>,
  queue: FIFO<SliceId>,
  owners: Map<Path, SliceId>,
  protected: Map<Path, SHA256>,
  events: append-only log
}
```

`SliceSpec` 与 `DevRun` 的字段在 §7.1 冻结。协调器只在内存中做调度；需要跨进程恢复时，用原子写保存 `state.edn` 并把副本放入证据目录。它不是产品的 `mission.edn`，不得混用。

### 4.3 工作树、分支与控制状态

- 开发集成目标：`herd/clean-break/integration`，从记录的 `base_commit` 创建。
- 每个 Slice：`.herd-worktrees/clean-break/<slice_id>`，分支 `herd/clean-break/<slice_id>`。
- 所有 worktree 从同一 `base_commit` 出发；主分支/集成分支只接受 `--ff-only` 前进。
- 不把两个 Slice 放同一 worktree；不为同一 Slice 建两个 worktree。
- **控制状态全部在主工作区 `.herd/`**：每个 Slice 的 board/lock/token/checkpoint 位于主工作区 `.herd/missions/.../slices/<slice_id>/`；worktree 只承载数据面写入，不在 worktree 内另建 `.herd/`。S1 CASE-21 的“每个 Slice 独立看板/锁”指主工作区下的独立文件，不是 worktree 内复制一套控制面。
- worktree 不带未跟踪契约；默认通过 C3 只读根白名单读取根 `AGENTS.md`、S1/S2、冻结契约，**不复制**。只有测试副本（`/tmp`）为隔离需要才显式复制，并记录逐文件 `sha256`；两条路径不能混用。
- `node_modules` 不复制；依赖从仓库祖先目录解析，或在 worktree 内执行 `bun install --frozen-lockfile`。不得假设 worktree 天然有依赖。
- `.git` 只读；沙箱不得把 `.git` 当业务文件。

### 4.4 共享文档单写者

以下文件不由任何 Slice 直接编辑，避免并行写冲突：

| 文件 | 单写者 | 说明 |
|---|---|---|
| 根 `AGENTS.md` | 人类 | AI 只读；哈希基线 |
| `requirements.md`、`development-guide.md` | 人类/已批准流程 | 本文件不修改 |
| `coordination.md` | Coordinator，人类确认 | 本文件 |
| `HACK.md` | SL-14（汇总 SL-00/03/05 的事实） | 宿主、Cherry、git、故障注入 |
| `DEBT.md` | SL-14 | 只列未完成缺口；关闭即删 |
| `HISTORY.md` | SL-14 | 删除/迁移时记录来源、去向、原因、日期 |
| `src/AGENTS.md` | SL-14 | 模块 DAG、装配边界、DA 隔离 |
| `README.md`、`CHANGELOG.md`、`.gitignore`、`package.json`、`bun.lock` | SL-14 | cutover 统一改 |
| `plans/**`、`docs/**` 既有产物 | 人类/用户 | Slice 只读，不删不改 |

Slice 发现规格偏差时，向 Coordinator 提交事实与证据；由 Coordinator 写入 `HACK.md`/`DEBT.md`，不得各自改共享文档。

## 5. 冻结接口与文件所有权

### 5.1 跨 Slice 共享契约

这些形状在施工前冻结；任何变化都算接口变更，必须停线、更新本表、通知所有消费者，并重跑受影响 Slice 的诊断测试。

| 契约 | 冻结内容 | 生产/消费 |
|---|---|---|
| 错误 | `{:code :message :data}`；`data` 至少含路径、期望值、当前值、下一步中的相关项；`renderError` 用 EDN + UFSS | U0 → 全部 |
| 原子写 | 同目录 `.tmp-<uuid>` + 完整字节 + `fsync` + `rename`；不得跨目录；不得先截断目标 | U1 → T2/B0/B1/B3 |
| 锁 | `wx` 创建；内容含 `lock_id`、`purpose`、`slice_id`、`owner_agent_id`、`owner_term_id`、`pid`、`started_at`、`host`、`token`；锁序 integration=0 → writeW=1 → board=2 | U2 → C3/B0/B1/B2 |
| 健康 | `{entry, status, version, capabilities, degraded, error}`；跨入口全局 rendezvous；不写磁盘 | H2 → M0/M1/G1/V1 |
| UFSS | `readUfss`/`printUfss`/`renderReceipt` 双射；围栏阶数、缩进、控制字符、错误行列 | C0 → C2/C3/C4/T1 |
| where | `unique / ambiguous / none`；span 为 UTF-16 码元 `[begin,end]`；不 trim、不正则 | C1 → C2/C3 |
| 沙箱会话 | `createSandboxSession`/`runProgram`/`unpark`/`parkedNames`/`abortSession`；程序状态 `:running / :waiting / :parked / :completed / :failed` | C2 → C4/B3 |
| VFS 提交 | `prepare` → `{ok,plan} 或 error`；`commit` → `:rejected / :applied / :uncertain`，带 `written`、`conflicts`、`stamp`；拒绝零触盘 | C3 → C4/B0/B2 |
| 能力矩阵 | 角色 × 能力；Worker 无 `call`；Auditor 只读；拒绝 `:CAPABILITY_DENIED`/`:TOKEN_REQUIRED` | C4 → B3/M0 |
| 门字段 | `scope`、`intent`、中文锚点；五类传输注入；执行前剥离；底层工具不得收到门禁字段 | G0/G1 → M0 |
| `CallMeta` 侧通道 | G1 在剥离前把 `{tool_call_id, intent_bytes, deadline_at, scope_digest}` 写入跨入口 rendezvous；C4/C2 按 `tool_call_id` 读取；执行输入不含 `intent`；缺失返回 `:INTENT_REQUIRED`，不得默认期限 | G1 → C4/C2 |
| Scope | 四型 `keepLast`/`removeLast`/`resetScope`/`meToo`；预算、归档、`ask_previous_scope`/`assume` | Q0 → Q1/M0 |
| 批准凭证 | T2 是唯一签发/校验者：`issueApproval`/`verifyApproval`；T4 只调用 T2，不导出/不写 token；`mission.edn :approval` 只由 T2 写；B3 不得写批准 | T2 → T4；T4 ⇢ T2 |
| 返工 | B3 只做单提交结构/证据/快照校验并返回规范化失败；T4 做跨提交聚合、阈值、报告并产出 `RepairSpec`；B2/B1 只消费 `RepairSpec`；不改冻结 S4 | B3 → T4 → B2/B1 |
| 阶段契约 | `mission.edn` 至少含 `:mission-id :slug :seed :created-at :updated-at :stage :revision :contract-line :frozen :approval :limits :settings`；四哈希；一次性批准只由 T2 签发 | T2 → T3/T4/B1/B3 |
| 看板 | `:board-version :tasks :actions :actors :token-slot :tenure :next-ids`；短事务；事件追加 | B0 → B2/B3 |
| Worktree | B1 增加 B0 依赖；`forkSlices` 只创建 worktree/board/locks 并返回 `SliceHandle[]`，**不 import B2、不启动 B2**；T3/M0 通过 `runnerPort.startSlice(handle)` 启动 B2；`joinSlice` FIFO；`abandonSlice` 需 reason；ff-only | B1 → T3/B3；B2 由端口启动 |
| 任期 | Phase A ⇄ Phase B ⇄ Relay；Quiescence 六项；旧任期 `:TENURE_RETIRED`；继任者无前任对话；B2 通过 `reviewSink` 端口接收 findings，**不 import T3** | B2 → B3；T3 ⇢ B2 端口 |
| 审计 | 提交含 `case_id`、`user_score`、`developer_score`、`report_markdown`、`evidence_paths`；`final=min(user,developer)`；B3 单提交校验，T4 聚合，一次性 `(mission-id, revision)` 批准由 T2 签发 | B3 → T4 → T2 |
| 证据路径 | C3 对 Auditor 开放 `plans/<slug>/evidence/<case_id>/` 与 `/tmp/herd-audit-*` 写；其他 `plans/`、产品源码/测试/文档、`.herd/` 控制态、`.git/` 仍 `:PATH_ESCAPE`；B3 快照只比较保护集，忽略证据/artifacts/audit/worktree 的预期写入 | C3/B3 → S4 |
| 系统提示词 | P1 拆 `P1a`（S1/Plan/Coordinator）与 `P1b`（Reviewer/Worker/Holder/Auditor/Oracle）；S1 只加载 `P1a`；M0 用 `systemPrompt: [...event.systemPrompt, ...COMMON, ...briefing, ...role, ...pairHint]` 追加，不替换宿主提示词 | P1/M0 → S1/S5 |
| 产品工具名 | 产品只注册 `submit_review`、`submit_devops_report`、`submit_oracle_advice`、`submit_case_audit`；`submit_manual_*` 只在 DA；根 `omp.extensions` 只有两个产品入口 | M0/G1 → CASE-01/39 |
| Slice | `{slice_id,goal,inputs,depends_on,done_when,mapped_cases}`；`slice_id` 小写、唯一、无空格/`..`/大写；`depends_on` 只引用已声明 Slice | 本文件 → T1/T3/B1 |

### 5.2 模块公开接口

签名以 S2 §3 为准；本表冻结“跨 Slice 必须保持一致”的最小面，详细参数不在本表重复。

| 模块 | 冻结导出 | 消费 Slice |
|---|---|---|
| U0 `src/util/errors.mjs` | `herdError`、`isHerdError`、`renderError` | 全部 |
| U1 `src/util/atomic-write.mjs` | `writeFileAtomic`、`writeEdnAtomic` | 02、08、09、10、12、14 |
| U2 `src/util/file-lock.mjs` | `acquireLock`、`inspectLock`、`releaseLock`、`withLock`、`assertLockOrder` | 02、05、09、10 |
| H0 `src/host/imports.mjs` | `host`、`loadCherry`、`detectCapabilities` | 03、05、07、13 |
| H1 `src/host/subprocess.mjs` | `spawnAgent`、`abortTree`；父链只记录实际 `sessionFile`/`artifactsDir`/`eventBus` 行为，不承诺父链 | 03、07、10、11、12 |
| H2 `src/host/health.mjs` | `recordHealth`、`readHealth` | 03、07、10、13、14 |
| C0 `src/clj-sandbox/ufss.mjs` | `readUfss`、`printUfss`、`renderReceipt` | 04、05、06、08 |
| C1 `src/clj-sandbox/where.mjs` | `findUnique`、`findAll` | 04、05、06 |
| C2 `src/clj-sandbox/evaluator.mjs` | `createSandboxSession`、`runProgram`、`unpark`、`parkedNames`、`abortSession` | 05、06、12 |
| C3 `src/clj-sandbox/vfs.mjs` | `createBatch`、`readText`、`stat`、`list`、`write`、`mkdir`、`remove`、`move`、`prepare`、`commit`、`drain`、`runCall` | 05、06、09、10 |
| C4 `src/clj-sandbox/tools.mjs` | `CAPABILITY_MATRIX`、`buildSandboxTools`；从 `CallMeta` 读取期限，不依赖执行输入里的 `intent` | 06、11、12 |
| G0 `src/tool-gate/schema.mjs` | `GATE_KEYS`、`injectGateFields`、`stripGateFields`；`intent` 是门字段，剥离前交给 `CallMeta` | 07、11 |
| G1 `src/tool-gate/index.mjs` | `activate(pi)`；`writeCallMeta(toolCallId,{intentBytes,deadlineAt})`、`readCallMeta(toolCallId)` | 07、14 |
| Q0 `src/scope/ledger.mjs` | `ledgerFor`、`admit`、`settle`、`askPreviousScope`、`assume` | 07、08、13 |
| Q1 `src/scope/projection.mjs` | `projectMessages`、`relocateCacheBreakpoints` | 07、13 |
| T0 `src/stages/disclosures.mjs` | `BRIEFINGS`、`currentBriefing` | 08、11、13 |
| T1 `src/stages/parsers.mjs` | `validateS1`、`parseS2Cases`、`validateS3`、`validateS4` | 08、11、12 |
| T2 `src/stages/contract.mjs` | mission/freeze/realign；**唯一** `issueApproval`/`verifyApproval`；`mission.edn :approval` 单写者 | 08、10、11、12 |
| T3 `src/stages/gate-tools.mjs` | `registerGateTools`、`currentBriefing`、`resumePendingApproval`；通过 `reviewSink` 提交 findings、通过 `runnerPort` 启动 B2，不 import B2 | 11、14 |
| T4 `src/stages/scores.mjs` | `aggregate`、`writeS5Report`；调用 T2 的批准，不导出/不写 `issueApproval`；产出 `RepairSpec` | 08、12 |
| B0 `src/swarm/board.mjs` | `openBoard`、`readBoard`、`apply`、`responsibilitySet`、`progressableSet`、`createWriteGateControl`；实现 `BoardControlPort` | 09、10、11、12 |
| B1 `src/swarm/worktree.mjs` | 依赖 B0；`forkSlices -> SliceHandle[]`（不启动 B2）、`joinSlice`、`abandonSlice`、`gcWorktrees`、`worktreePaths` | 10、11、14 |
| B2 `src/swarm/runner.mjs` | `startSlice`、`runTenure`、`relay`、`cancelTree`、`recover`、`oracleFingerprint`；接收 `reviewSink`/`runnerPort`，不 import T3 | 10、11、14 |
| B3 `src/swarm/auditors.mjs` | `snapshotWorkspace`、`startAuditBatch`、`validateSubmissions`（单提交/证据/快照）；返回规范化失败，不派生/不写批准 | 12、14 |
| P0/P1/P2 | `COMMON_RULES`、`ROLE_PROMPTS`（拆 `P1a` S1/Plan/Coordinator 与 `P1b` 后期角色）、`buildCaseAuditorPrompt`、`VIBE_CONTEXT_SUFFIX`、`buildUnattendedNudge` | 13、14 |
| V0/V1 | `deriveDashboard`、`mountDashboard`、`applyStableHeightBound` | 13、14 |
| M0/M1 | `activate(pi)`；M0 用 `systemPrompt: [...event.systemPrompt, ...]` 追加；M1 惰性加载并记录 H2 | 14 |

#### 5.2.1 跨层端口（冻结，不允许隐式 import）

| 端口 | 提供者 | 消费者 | 契约 | 缺失行为 |
|---|---|---|---|---|
| `CallMetaPort` | G1 | C4/C2 | `read(toolCallId) -> {intentBytes,deadlineAt}`；写入发生在剥离前 | `:INTENT_REQUIRED` fail-closed；不得默认期限 |
| `RunnerPort` | B2/M0 | T3 | `startSlice(handle) -> {ok,agentId,abort}` | `:AGENT_SPAWN_FAILED`；保留槽位/责任 |
| `ReviewSink` | B2 | T3 | `submit(tenure, findings) -> {ok,roots}` | 拒绝空实现；不得让 T3 import B2 |
| `ApprovalPort` | T2 | T4 | `issue(missionId,revision,reportSha256)`；`verify(...)` | T4 不生成 token；`:APPROVAL_REQUIRED` |
| `BoardControlPort` | B0 | C3/B2 | `markApplying`、`publishResult`、`markUncertain`；claim/actor 校验 | `:STALE_CONTROL`；拒绝触盘 |
| `EvidencePort` | C3/B3 | S4 | Auditor 只写 `plans/<slug>/evidence/<case_id>/` 与专属 `/tmp`；快照忽略预期写入 | `:PATH_ESCAPE`；`:AUDIT_WORKSPACE_MUTATED` 只对保护集 |

**导入方向**：ESM 只允许 `T3 → B1`、`B1 → B0/T2`、`B2 → B0/B1/T2`；禁止 `B1 → B2`、`B2 → T3`、`T3 → B2`。`forkSlices` 返回 `SliceHandle[]` 后，由 T3/M0 通过 `runnerPort` 启动 B2；`submit_review` 由 T3 接收，经 `reviewSink` 交给 B2。这样 B1/B2 与 T3/B1 不会形成 import 环；运行时回调也不允许隐式全局单例。

### 5.3 文件所有权矩阵

一个路径只属于一个 Slice。共享文档按 §4.4 由 Coordinator/SL-14 单写。

| Slice | 拥有路径 | 拥有的测试 | 不得触碰 |
|---|---|---|---|
| SL-00 | `tests/spikes/**` | 同左 | 产品源码、共享文档 |
| SL-01 | `src/util/errors.mjs` | `tests/util-errors.test.mjs` | U1/U2、宿主、阶段 |
| SL-02 | `src/util/atomic-write.mjs`、`src/util/file-lock.mjs` | `tests/atomic-lock.test.mjs` | U0、看板、阶段 |
| SL-03 | `src/host/imports.mjs`、`src/host/subprocess.mjs`、`src/host/health.mjs` | `tests/host.test.mjs` | 沙箱、阶段、入口 |
| SL-04 | `src/clj-sandbox/ufss.mjs`、`src/clj-sandbox/where.mjs` | `tests/ufss-where.test.mjs` | 求值器、VFS、工具 |
| SL-05 | `src/clj-sandbox/evaluator.mjs`、`src/clj-sandbox/vfs.mjs` | `tests/sandbox-runtime.test.mjs` | 工具矩阵、看板、阶段 |
| SL-06 | `src/clj-sandbox/tools.mjs` | `tests/sandbox-tools.test.mjs` | 求值器/VFS 内部、门禁 |
| SL-07 | `src/tool-gate/schema.mjs`、`src/tool-gate/index.mjs`、`src/scope/ledger.mjs`、`src/scope/projection.mjs` | `tests/gate-scope.test.mjs` | 阶段、看板、入口装配 |
| SL-08 | `src/stages/disclosures.mjs`、`src/stages/parsers.mjs`、`src/stages/contract.mjs`、`src/stages/scores.mjs` | `tests/stages-core.test.mjs` | `gate-tools.mjs`、看板、入口 |
| SL-09 | `src/swarm/board.mjs` | `tests/board.test.mjs` | worktree/runner、阶段 |
| SL-10 | `src/swarm/worktree.mjs`、`src/swarm/runner.mjs` | `tests/worktree-tenure.test.mjs` | 看板内部、审计、入口 |
| SL-11 | `src/stages/gate-tools.mjs` | `tests/gate-tools.test.mjs` | 解析/契约内部、看板内部、入口 |
| SL-12 | `src/swarm/auditors.mjs` | `tests/audit.test.mjs` | 看板/worktree 内部、阶段内部 |
| SL-13 | `src/prompts/common.mjs`、`src/prompts/roles.mjs`、`src/prompts/runtime-wires.mjs`、`src/tui/dashboard-model.mjs`、`src/tui/dashboard-widget.mjs` | `tests/prompts-tui.test.mjs` | 门禁/看板逻辑、入口装配 |
| SL-14 | `src/main.mjs`、`src/bootstrap-main.mjs`、`package.json`、`bun.lock`、`README.md`、`CHANGELOG.md`、`.gitignore`、`src/AGENTS.md`、`HACK.md`、`DEBT.md`、`HISTORY.md`；旧路径删除 | `tests/assembly-cutover.test.mjs` | 已批准文档、用户产物、其他 Slice 内部 |
| SL-15 | `tools/dev-acceptance/**` | `tools/dev-acceptance/test/smoke.test.mjs` | 根 `omp.extensions`、产品工具面、其他 Slice |

### 5.4 明确禁止

- 不在同一文件上并行写；不以“合并时再解决”为借口让两个 Slice 改同一路径。
- 不修改根 `AGENTS.md`、S1/S2、`docs/**` 既有历史文档、`plans/**` 用户产物。
- 不把开发验收工具注册进根 `omp.extensions`/`pi.extensions`，不让 `submit_manual_*` 进入 `/herd` 工具面。
- 不用 `git reset --hard`、强制推送、`git clean -fdx` 处理共享工作区或集成分支。
- 不静默删除 `.herd/`、`.herd-worktrees/`、证据、worktree 或旧产物。

## 6. 目标互不相交的 Slice DAG

### 6.1 切片原则

- 按“独立变化秘密”切，不按文件数量或执行流程图切；每个 Slice 的 `done_when` 可以独立为真。
- 每个 Slice 只有一个目标；跨 Slice 的共享形状在 §5 冻结，不靠共享可变状态协作。
- 支撑 Slice（SL-00/01/02/15）没有独立 CASE，但其产物被下游 CASE 间接验证；不得为了“每 Slice 都有 CASE”伪造映射。
- `depends_on` 只表达合并依赖；开工可以在依赖的导出契约冻结后立即开始，但不得在依赖未合并前把自己的分支合入集成分支。

**为什么这样切**：这里按“可能独立变化的设计秘密”切，而不是按文件数或调用链切。U0/U1/U2 隐藏错误、原子写、锁；H0/H1/H2 隐藏宿主差异；C0/C1 隐藏 EDN/UFSS 与切片；C2/C3 隐藏求值器/VFS；C4 隐藏角色能力；G/Q 隐藏 Wire Schema 与 Scope；T 层隐藏阶段契约；B 层隐藏看板/worktree/任期/审计；P/V/M 隐藏提示词/TUI/装配。每一层的公开接口在 §5 冻结，因此不同 Slice 可以并行，不需要共享可变状态。SL-00/01/02/15 是支撑件，不是“更小的功能”；它们没有独立 CASE，但被所有下游 CASE 间接使用。

**Slice → 模块**：

| Slice | 主要模块 |
|---|---|
| SL-01 | U0 |
| SL-02 | U1、U2 |
| SL-03 | H0、H1、H2 |
| SL-04 | C0、C1 |
| SL-05 | C2、C3 |
| SL-06 | C4 |
| SL-07 | G0、G1、Q0、Q1 |
| SL-08 | T0、T1、T2、T4 |
| SL-09 | B0 |
| SL-10 | B1、B2 |
| SL-11 | T3 |
| SL-12 | B3 |
| SL-13 | P0、P1、P2、V0、V1 |
| SL-14 | M0、M1、入口清单、旧路径删除、文档 |
| SL-15 | DA |
| SL-00 | Spike 夹具（不进入产品模块数组） |

### 6.2 Slice 表

| Slice | 目标 | 输入 | depends_on | done_when | mapped_cases |
|---|---|---|---|---|---|
| `slice-00-baseline` | 执行期先决验证：记录宿主、git、Cherry、锁、worktree 基线并跑 Spike；**不是编码前硬闸门** | 根规格、S1/S2、当前仓库 | 无 | Spike 矩阵逐项有命令/退出码/结论；未通过项与 provisional 接口显式列出；纯接口 Slice 可并行 | 无 |
| `slice-01-errors` | 冻结错误码、EDN 诊断形状、因果链 | S2 §3.1 U0 | 无 | `herdError`/`isHerdError`/`renderError` 通过；无宿主/文件依赖；测试独立 | 无 |
| `slice-02-atomic-lock` | 原子写与文件锁（含 `agent_id`/`term_id` 判活、锁序） | U0 | SL-01 | 原子写只留完整旧/新内容；锁 `wx`、陈旧锁、锁序断言通过 | CASE-10 |
| `slice-03-host` | 宿主导入、子代理、健康登记与能力探测 | U0、S2 §2.6、SL-00 结果（异步） | SL-01 | 唯一导入点；`spawnAgent` 传完整 `AgentDefinition`/abort/artifacts；`readHealth` 可读；缺能力明确降级；实际探测 `sessionFile`/父链行为并记录 | CASE-33 |
| `slice-04-ufss-where` | EDN + UFSS 双射与 UTF-16 精确切片 | U0 | SL-01 | 双射、围栏、缩进、控制字符、0/多匹配、Ukkonen 诊断通过 | CASE-13、CASE-14 |
| `slice-05-sandbox-runtime` | 自建 Promise-CPS 求值器与批内 VFS | SL-01/02/03/04 | SL-01、SL-02、SL-03、SL-04 | 符号表白名单、挂起/恢复、VFS 预演、零触盘、BigInt stamp 通过 | CASE-12、CASE-15、CASE-16 |
| `slice-06-sandbox-tools` | 角色能力矩阵、`clj_*` 工具面、`call` 边界与资源上限 | C2/C3/C0/C1、CallMeta 契约 | SL-05 | 六角色越权拒绝；Worker `call` `:TOKEN_REQUIRED`；期限从 `CallMeta` 读取，缺失 `:INTENT_REQUIRED`；VFS/`call`/intent 上限与截断标记通过 | CASE-11、CASE-17、CASE-36 |
| `slice-07-gate-scope` | Wire Schema 注入/剥离、Scope 四型、出站投影、`CallMeta` 侧通道 | U0、H2、CallMeta 契约 | SL-01、SL-03 | 五类传输、执行前剥离、`intent` 写入 `CallMeta` 后底层输入不含门字段、四型 Scope、简报钉住/退役、缓存断点通过 | CASE-34、CASE-35 |
| `slice-08-stages-core` | 阶段披露、S1–S4 解析、契约冻结/重对齐、汇总 | U0/U1/U2、C0/C1 | SL-01、SL-04 | 八类 S1 章节、S2 CASE 解析/对账、S3 模块 DAG、S4 Slice DAG、四哈希/批准通过 | CASE-31 |
| `slice-09-board` | 看板短事务、拆分、父项恢复、令牌、禁睡 | U0/U1/U2 | SL-01、SL-02 | T01–T13 关键转换、父项 `:waiting`→`:ready`、`take_or_die`、`park_slot` 通过 | CASE-18、CASE-19、CASE-20 |
| `slice-10-worktree-tenure` | worktree 生命周期、FIFO join、任期双相、恢复、取消、Nudge | B0/B1/B2、T2、H1/H2 | SL-03、SL-08、SL-09 | B1 依赖 B0、`forkSlices` 返回 `SliceHandle[]` 且不 import B2；B2 经 `runnerPort` 启动、经 `reviewSink` 收 findings；FIFO、rebase/ff-only、abandon、Quiescence、接力屏障、六窗口恢复、取消传播通过 | CASE-21、CASE-22、CASE-28、CASE-29、CASE-30 |
| `slice-11-gate-tools` | `advance_s1..s4` 事务、异步等待、幂等、披露、批准调用 | T0–T2、B1、H1/H2、ReviewSink/RunnerPort | SL-07、SL-08、SL-10 | S1 唯一人工批准；S2–S4 自动；`:awaiting-user`；同 `call-id` 重放；失败不保存/不晋级；批准只调用 T2；`submit_review` 走 `reviewSink` | CASE-02、CASE-03、CASE-04、CASE-05、CASE-06、CASE-07、CASE-08、CASE-09 |
| `slice-12-audit` | K 路审计、快照、单提交校验、汇总、报告/批准、返工 | B3/T4、B0、T1/T2、H1/H2、C4 | SL-03、SL-06、SL-08、SL-09 | K 审计同窗启动；单 CASE prompt；快照只比较保护集；B3 单提交校验、T4 聚合；七类拒绝；全 PASS 才由 T2 签发一次性批准；T4 产出 `RepairSpec`，B2/B1 执行 | CASE-23、CASE-24、CASE-25、CASE-32 |
| `slice-13-prompts-tui` | 提示词、命令面、TUI 双态/降级 | P0–P2、V0/V1、H0/H2 | SL-01、SL-03 | 零剧透；`P1a`/`P1b` 分离，S1 只加载 `P1a`；八条 `/herd*` 命令；aboveEditor 双态；窄屏/无颜色/挂载失败降级；无 `/herd-pair` | CASE-26、CASE-27 |
| `slice-14-assembly-cutover` | 装配、两个入口、依赖收敛、旧路径删除、文档同步、真实宿主加载 | 全部产品 Slice + SL-15 | 全部 | 两入口独立；M0 追加 `event.systemPrompt`；只注册四个产品 `submit_*`；只留 `cherry-cljs`；旧目录/旧字符串/旧工具名清除；真实宿主加载本副本；旧资产保全；DA 不执行审计 | CASE-01、CASE-37、CASE-38、CASE-39 |
| `slice-15-dev-acceptance` | 把开发验收工具迁到独立子包；验证提交工具可执行；**不是审计执行器** | U0/U1 | SL-01、SL-02 | `tools/dev-acceptance/` 独立 `package.json`；四提交工具可用；独立 `HOME` 单独链接；根清单不含 DA；旧路径未删前仍可用；明确没有 K 路审计/汇总能力 | 无 |

### 6.3 依赖分层与最大并发

按最长依赖路径分层（层号只用于合并顺序，不是开工闸门）：

| 层 | Slice | 可同时施工数 |
|---|---|---|
| L0 | SL-00、SL-01 | 2 |
| L1 | SL-02、SL-03、SL-04 | 3 |
| L2 | SL-05、SL-07、SL-08、SL-09、SL-13、SL-15 | 6 |
| L3 | SL-06、SL-10 | 2 |
| L4 | SL-11、SL-12 | 2 |
| L5 | SL-14 | 1 |

**最大并发**：在 L2 达到 6 个独立 Slice。不要人为分批；只要依赖已合并、worktree 可用、文件所有权不冲突，就立即开工。资源不足时返回 `:INSUFFICIENT_WORKTREES` 并降数重试，不得把多个 Slice 塞进同一 worktree，不得静默改小 N。

**每 Slice 槽位**：产品运行时默认 4 个槽位（S2 §7.5）；开发 Slice 默认 1 个 Owner + 1 个 Reviewer，可按独立性增加只读 Reviewer，但不得让两个写者共享同一 `owner_paths`。槽位是资源，不是任务分配器；补位只恢复可用性，不替个体挑任务。

**锁持有区间**：`master-integration` 只在 join/rebase/ff 期间持有；`writeW` 只在受保护提交或 `call` 运行期间持有；`board` 只在短事务内持有。持锁顺序固定为 integration → writeW → board；持 board 时不得等待 writeW，持 writeW 时不得等待模型推理或网络。

**worktree 创建/回收**：依赖合并后才创建；join/abandon 后保留 7 天（可配置）供复核；GC 前必须有报告/证据；不得在 `:queued` 前删除；不得复用同一 worktree 给另一个 Slice。

### 6.4 关键路径

最长链约为：

```text
SL-01 → SL-04 → SL-08 → SL-10 → SL-11 → SL-14
SL-03 → SL-05 → SL-06 → SL-12 → SL-14
```

`SL-01 → SL-04 → SL-08 → SL-10 → SL-11 → SL-14` 是最可能决定总工期的链；`SL-03 → SL-05 → SL-06 → SL-12 → SL-14` 是并行的第二长链。SL-00 是并行验证活动，不在关键路径上；不得因为它未完成而阻塞纯接口或无关 Slice。降低总工期的优先动作是压薄 SL-04/08/10 的串行交接，而不是增加 L2 的重复工人。

### 6.5 立即放行规则

1. 冻结 §5 的共享契约。
2. 当 `depends_on` 中每个 Slice 的状态为 `:joined`，且 `owner_paths` 与当前 active 集合不相交，Coordinator 立即创建 worktree 并开工；不等待同层其他 Slice，不等待“整波完成”。
3. 若依赖的导出契约已冻结但 Slice 尚未合并，允许开始编码；但该 Slice 的分支不得在依赖合并前进入集成队列。
4. 每个 Slice 必须在自己完成前验证它实际使用的宿主/Cherry/git 接口；SL-00 的 Spike 结果是输入，不是开工闸门。未验证的接口只能标 provisional，不得写成已通过。
5. 每个 Slice 完成时立即进入 FIFO 队列；不按优先级插队，不按层号排队。
6. 依赖合并后，唤醒所有因此变为 ready 的 Slice；唤醒是幂等的，重复唤醒不重复开工。

### 6.6 拓扑合并顺序

```text
SL-00 → SL-01 → SL-02 → SL-03 → SL-04 → SL-05 → SL-06
      → SL-07 → SL-08 → SL-09 → SL-10 → SL-11 → SL-12
      → SL-13 → SL-15 → SL-14
```

该顺序满足全部 `depends_on`；它只规定**合并**的合法次序，不规定开工次序。实际合并仍按完成 FIFO 队列取队首，若队首依赖未合并则等待，不能跳过它去合并后面的 Slice（防止非 ff 与历史重排）。

## 7. 文学化伪代码：结构、状态转换与守卫

以下伪代码是协调器的规范行为，不是产品源码。`require` 表示守卫；守卫失败必须返回具体原因并保持状态不变。

### 7.1 数据结构

```text
SliceId = /^[a-z0-9][a-z0-9-]*$/

SliceStatus = :pending | :running | :reviewing | :swarming
            | :queued | :joining | :joined | :abandoned | :failed | :cancelled

SliceSpec = {
  slice_id: SliceId,
  goal: Text,                       // 单一目标，不得是文件清单
  inputs: List<Text>,
  depends_on: Set<SliceId>,
  done_when: Text,                  // 可观察、可复核
  mapped_cases: Set<CaseId>,        // 主映射；并集必须等于 S1 的 39 个 CASE
  owner_paths: Set<Path>,           // 与其他 Slice 不相交
  status: SliceStatus
}

DevRun = {
  run_id, base_commit, integration_branch,
  slices: Map<SliceId, SliceSpec>,
  queue: FIFO<SliceId>,             // 完成顺序，不是优先级
  active: Map<SliceId, Worktree>,
  owners: Map<Path, SliceId>,
  protected: Map<Path, SHA256>,
  events: AppendOnlyLog
}

Worktree = {slice_id, path, branch, base_commit, head_commit, created_at}
SliceHandle = {slice_id, workspace, branch, base_commit, board_path, lock_paths}
Tenure   = {tenure_id, slice_id, phase: :review | :swarm, actor_ids, retired: Bool}
Task     = {task_id, parent_id, state: :ready | :waiting | :done, ledger_key, claim_id}
Actor    = {agent_id, term_id, alive: Bool, responsibility: Set<TaskId>}
CallMeta = {tool_call_id, intent_bytes, deadline_at, scope_digest}
RepairSpec = {repair_id, failed_cases, goal, inputs, done_when, mapped_cases}
```

### 7.2 协调主循环

```text
PROCEDURE coordinate(run):
  REQUIRE run.slices 的 slice_id 唯一、depends_on 无环、mapped_cases 并集 = 39 个 CASE
  REQUIRE 每个 Slice 的 owner_paths 与其他 Slice 不相交
  LOOP:
    ready := { s ∈ run.slices |
               s.status = :pending ∧
               ∀ d ∈ s.depends_on: run.slices[d].status = :joined ∧
               s.owner_paths ∩ active_owner_paths(run) = ∅ }
    FOR EACH s ∈ ready IN deterministic order:
      start_slice(run, s)            // 立即放行，不等待同层
    IF run.queue ≠ ∅:
      merge_head(run)                // FIFO，队首不跳过
    ELSE IF ∃ s: s.status ∈ {:running,:reviewing,:swarming,:joining}:
      wait_for_completion_or_cancel() // 不空转，不重复启动
    ELSE IF ∀ s: s.status = :joined:
      enter_audit(run)
      RETURN
    ELSE IF all_failed_or_abandoned(run):
      report_no_results(run)         // 必须给理由与教训，不静默结案
      RETURN
```

### 7.3 开工、完成与合并

```text
PROCEDURE start_slice(run, s):
  REQUIRE s.status = :pending
  REQUIRE all dependencies joined
  REQUIRE s.owner_paths ∩ active_owner_paths(run) = ∅
  REQUIRE worktree capacity available
  handle := B1.forkSlices(slice = s, base = run.base_commit)
  // B1 只创建 worktree/board/locks，返回 SliceHandle；不 import B2、不启动 B2
  REQUIRE handle.workspace = ".herd-worktrees/clean-break/" + s.slice_id
  mount_contract_readonly_via_c3(handle, [AGENTS.md, S1, S2, coordination.md])
  record_hashes(handle.contract)
  runnerPort.startSlice(handle)      // B2 由 T3/M0 注入的端口启动
  s.status := :running
  run.active[s.slice_id] := handle
  emit(:slice-started, s.slice_id, handle.branch, handle.base_commit)

PROCEDURE complete_slice(run, s, evidence):
  REQUIRE s.status = :running
  REQUIRE s.done_when 的每项都有证据
  REQUIRE s.owner_paths 之外无改动（git diff --name-only 对照 ownership）
  s.status := :queued
  run.queue.append(s.slice_id)       // 原子追加，完成顺序
  emit(:slice-queued, s.slice_id, queue_position)

PROCEDURE merge_head(run):
  ACQUIRE master-integration-lock
  s := run.queue.head()
  REQUIRE s.status = :queued
  wt := run.active[s.slice_id]
  s.status := :joining

  IF integration_head() ≠ wt.base_commit:
    // base 已前进；只允许在该 Slice 的 worktree 内 rebase
    rebase_in_slice_worktree(wt, integration_head())
    IF conflict:
      classification := classify_conflict(wt, s)
      IF classification = :mechanical:
        resolve_only_within_owned_paths(wt, s)
        rerun_slice_diagnostics(s)
      ELSE IF classification = :directional:
        abandon_slice(run, s, "rebase conflict: " + reason)
        RELEASE master-integration-lock
        RETURN
      ELSE:
        mark_failed(run, s, "conflict outside ownership or protected path")
        RELEASE master-integration-lock
        RETURN

  REQUIRE is_ancestor(integration_head(), wt.head_commit)
  // 唯一允许的主分支推进方式
  git_merge_ff_only(integration_branch, wt.head_commit)
  s.status := :joined
  run.queue.pop()
  run.active.delete(s.slice_id)
  emit(:slice-joined, s.slice_id, ff_commit, rebase_rounds)
  RELEASE master-integration-lock
  wake_dependents(run, s.slice_id)   // 幂等
```

### 7.4 任期与接力

```text
PROCEDURE run_tenure(slice):
  tenure := start_reviewer(slice, clean_context = true)
  LOOP:
    // T3 的 submit_review 只做 schema/幂等，调用 reviewSink；B2 不 import T3
    findings := reviewSink.submit(tenure)
    IF findings ≠ []:
      // 同一 board lock 事务：卸载 clj_review、立根任务、wake-all、记事件
      atomically:
        unmount(tenure, clj_review)
        FOR EACH f ∈ findings: create_root_task(f.key, f.value, :ready)
        wake_all(slice.slots)
        emit(:review-findings-opened, tenure.id, findings)
      run_swarm(slice)
      REQUIRE all_root_tasks_done(slice)
      REQUIRE quiescent(slice)
      REQUIRE ff_dry_run(slice)
      atomically:
        retire(tenure)
        write_context_barrier(slice)
        tenure := start_reviewer(slice, successor = true)
      CONTINUE
    ELSE:
      REQUIRE quiescent(slice)
      REQUIRE ff_dry_run(slice)
      atomically:
        slice.status := :queued
        run.queue.append(slice.id)
      RETURN
```

Quiescence 守卫（全部为真才允许空账/接力）：

```text
quiescent(slice) =
  no_action_in({:applying, :running, :uncertain}) ∧
  no_unfinished_needs_token_task ∧
  not_holding(writeW) ∧
  no_pending_rebase ∧
  ff_dry_run(slice) = true
```

### 7.5 看板、令牌与写锁

```text
PROCEDURE board_take_or_die(slice, actor, task, request_id):
  ACQUIRE board-lock
  REQUIRE actor.alive
  REQUIRE task.state = :ready
  REQUIRE task in progressable_set(board)
  IF token_slot.holder ≠ nil:
    loser := actor
    loser.alive := false
    handoff_to(winner, task, handoff_markdown)
    emit(:actor-died, loser.id, winner.id)
    RELEASE board-lock
    RETURN :lost
  token_slot.holder := actor
  task.claim_id := new_claim_id()
  emit(:token-acquired, actor.id, task.id)
  RELEASE board-lock
  RETURN :won

PROCEDURE protected_commit(batch, identity):
  read-set := collect_all_read_stamps(batch)   // 含只读依赖
  plan := prepare(batch)                        // 内存 VFS，按序预演
  IF plan.rejected: RETURN :rejected            // 零触盘
  ACQUIRE writeW
  RECHECK every path ∈ read-set: stamp_equal(current, captured)
  IF changed: RELEASE writeW; RETURN :FILE_CONFLICT
  applied := atomic_apply(plan)                 // 完整旧/新内容
  RELEASE writeW
  RETURN {:status :applied, :written applied.paths}

PROCEDURE gate_call(toolCallId, rawInput):
  // G1 在剥离前计算并保存期限；底层工具不再收到 intent/scope
  REQUIRE rawInput.intent 是非空字符串
  meta := {intent_bytes: utf8_len(rawInput.intent),
           deadline_at: now() + utf8_len(rawInput.intent) * 50ms,
           scope_digest: digest(rawInput.scope)}
  writeCallMeta(toolCallId, meta)    // 跨入口 rendezvous
  stripped := stripGateFields(rawInput)
  REQUIRE stripped.intent = nil ∧ stripped.scope = nil
  dispatch(stripped)                 // C4/C2 通过 readCallMeta(toolCallId) 读取期限
```

锁序守卫：

```text
REQUIRE lock_order = [master-integration, writeW, board]
// 任何反向获取立即 :LOCK_ORDER_VIOLATION；不得在持 board 时等待 writeW
```

### 7.6 取消、失败与恢复

```text
PROCEDURE cancel_slice(run, s, reason):
  REQUIRE reason ≠ ""
  s.status := :cancelling
  abort_subprocess_tree(s)            // 递归 AbortSignal，不杀无关 Slice
  outcome := drain_and_classify(s)    // :cancelled | :outcome-unknown
  s.status := (outcome = :cancelled ? :cancelled : :failed)
  keep_worktree_and_evidence(s)       // 不立即删除
  release_locks_owned_by(s)           // 只释放自己的锁
  emit(:slice-cancelled, s.slice_id, outcome, reason)
  // 不自动重放；由 Coordinator/人类决定重试、重规划或终止

PROCEDURE recover(run):
  // 六窗口扫描：mission/board/checkpoint/events/worktrees/locks
  state := read_last_committed_state()
  IF state.missing_or_corrupt:
    stop_and_report()                 // 不静默重建空状态
  reconcile_dead_locks_by_agent_and_term()
  reconcile_orphan_tmp_files()        // 保留并报告，不猜内容
  reconcile_outcome_unknown()         // 不当作成功
  reconcile_joined_or_abandoned_worktrees()
  resume_pending_gate_only()          // 不重放全量历史
```

### 7.7 审计与返工

```text
PROCEDURE enter_audit(run):
  REQUIRE all slices joined OR explicit termination decision
  snapshot_before := snapshot_workspace(protected_set = product_source_tests_docs_control,
                                        allowed_writes = evidence/artifacts/audit/worktrees)
  REQUIRE contract_hashes_match()     // 任何不符拒绝启动
  cases := parse_cases(S2_contract)   // 唯一权威，不采信审计员自报
  start_K_auditors(cases)             // K 个 CASE 同时启动；可排队但语义全启动
  submissions := B3.collect_and_validate()   // 只做单提交结构/证据/快照校验
  result := T4.aggregate(cases, submissions, snapshot_before, snapshot_after)
  IF any FAIL or missing:
    repair_specs := T4.derive_repair_specs(result) // T4 唯一派生；不改冻结 S4
    revision += 1
    B2/B1.enqueue(repair_specs)             // B2/B1 只消费，不重复校验/派生
    LOOP
  ELSE:
    write_s5_report(result)
    T2.issueApproval(mission_id, revision, report_sha256)  // T4 不签发 token
    mark_completed()
```

## 8. Safety / Liveness 不变量

Safety 是“坏事永不发生”；Liveness 是“好事终将发生”。每条都对应一个可检查的转换或守卫；未执行的检查只算待验证。

| ID | 类型 | 不变量 | 检查/守卫 | 关联 CASE |
|---|---|---|---|---|
| S-01 | Safety | 同一文件同一时刻只有一个写者 | `writeW` + owner_paths 不相交 + read-set 复核 | 15、17 |
| S-02 | Safety | 同一 Slice 同时只有一个有效 Holder | token 槽单值；输者死亡；`board_take_or_die` 原子 | 19 |
| S-03 | Safety | 死身份不能提交 | `ACTOR_DEAD`/`TENURE_RETIRED`；身份与任期校验 | 19、22、38 |
| S-04 | Safety | 提交前复核全部 read-set（含只读依赖），stamp 完整 | `prepare` 前采集；`commit` 内 BigInt 比较；`atime` 排除 | 15 |
| S-05 | Safety | 拒绝/异常/park 零触盘；成功只落完整旧/新内容 | 内存 VFS 预演 + 原子 rename | 15、16、17 |
| S-06 | Safety | 阶段/门禁不暴露半提交状态 | `call-id` 回执、`.tmp`+fsync+rename、mission 阶段与哈希一致 | 10 |
| S-07 | Safety | 审计覆盖率等于 CASE 集合，不缺失/未知/重复 | `parse_cases` 是唯一权威；aggregate 拒绝缺失/未知/重复 | 23、24 |
| S-08 | Safety | 审计期间主工作区只读 | 快照前后比对；审计员写尝试拒绝 | 23、24 |
| S-09 | Safety | 密钥/私人数据不进入交付物、证据、日志、报告 | 五处搜索；泄漏即停止；脱敏 | 32 |
| S-10 | Safety | 根规格、S1/S2、既有 `docs/**`、`plans/**`、旧证据不被静默删除 | 基线哈希；单写者；删除需具名 + `HISTORY.md` | 01、39 |
| S-11 | Safety | 集成分支只 `--ff-only` 前进；不强制推送、不非 ff 合并 | `is_ancestor` + `git merge --ff-only` | 21、37 |
| S-12 | Safety | 两个 Slice 不共享 worktree，不重复开工 | `active` 唯一；owner_paths 不相交；worktree 路径唯一 | 21 |
| S-13 | Safety | 旧路径、旧依赖、旧工具名不保留隐藏分支 | 删除清单 + 字符串/依赖扫描 + 工具列表 | 01、39 |
| S-14 | Safety | 产品运行时只允许 S1 人工批准；本地确认不写入 mission | 阶段工具只认门禁回执；mission 只记 S1 批准 | 02、37 |
| S-15 | Safety | 审计未全 PASS 不写“已交付”报告、不签发批准 | aggregate 拒绝 FAIL/异常；一次性批准绑定 revision | 24、25 |
| S-16 | Safety | 沙箱期限只来自真实 `intent`，不默认、不丢失 | G1 剥离前写 `CallMeta`；C4/C2 缺失即 `:INTENT_REQUIRED`；期限到期 park 不触盘 | 14、34、36 |
| S-17 | Safety | 批准凭证只有一个签发/校验者 | T2 独有 `issueApproval/verifyApproval`；T4 只调用；B3 不写 `:approval` | 24、25 |
| S-18 | Safety | 返工派生只有一个所有者，且不改冻结 S4 | B3 单提交校验；T4 唯一 `RepairSpec`；B2/B1 只执行；S4 哈希不变 | 24、25 |
| S-19 | Safety | 审计证据写入不被误判为主工作区篡改 | C3 只允许 Auditor 写 evidence/专属 tmp；B3 快照只比较保护集 | 11、23、24 |
| S-20 | Safety | B1/B2/T3 无隐式 import 环 | B1 不 import B2；T3 不 import B2；B2 不 import T3；只用 `runnerPort`/`reviewSink`/`ApprovalPort` | 21、22 |
| L-01 | Liveness | 每个 ready Slice 最终被启动 | 就绪集每轮重算；FIFO 队列不丢项 | 21、37 |
| L-02 | Liveness | 每个 running Slice 最终 join、abandon 或显式 failed | 完成/冲突/取消都有终态；无永久 running | 21、29 |
| L-03 | Liveness | 依赖合并后，下游 Slice 被唤醒 | `wake_dependents` 幂等；状态从 pending→ready | 21、22 |
| L-04 | Liveness | 无死锁：锁序固定，等待有可见责任链 | integration→W→board；持锁者存活则等待，不超时强夺 | 17、20 |
| L-05 | Liveness | 有可推进工作时不得睡死 | `park_slot` 同事务核对 progressable set；新工作 `wake-all` | 20 |
| L-06 | Liveness | 审计最终完成或显式失败，不无限空转 | K 审计有超时/崩溃分类；未完成不当通过 | 23、24 |
| L-07 | Liveness | 失败/取消后工作可继续或明确终止 | 每个失败有 next action；全失败给 `:no-results` 与理由 | 25、29 |
| L-08 | Liveness | worktree join/abandon 后按保留期回收，不泄漏 | 7 天保留 + GC 记录；证据先于删除 | 21、28 |
| L-09 | Liveness | SL-00 未完成不阻塞纯接口或无关 Slice；真实接口验证在执行期到达 | 就绪集不把 SL-00 作为全局闸门；每个 Slice 的 `done_when` 含自身接口探测 | 21、33、37 |

## 9. 合并、冲突与可复现性

### 9.1 FIFO 集成队列

- 完成顺序即队列顺序；`join_slice` 取队首，不按优先级、不按层号、不按 Slice ID 排序。
- 队首未就绪（依赖未合并、rebase 未完成）时等待；不得跳过队首去合并后面的 Slice。
- 队列空但仍有 `:running` 时阻塞等待；队列空且无 running 时返回 `:none`/`:no-results`。
- 每次 join 记录：`slice_id`、`base_commit`、`head_commit`、`ff_commit`、`rebase_rounds`、冲突文件、命令、退出码、时间。

### 9.2 rebase 与 ff-only

```text
1. ACQUIRE master-integration-lock
2. result := queue.head()
3. IF base advanced:
     holder rebase in slice worktree onto latest base
     IF conflict: classify and handle (§9.3)
4. REQUIRE is_ancestor(base, slice.head)
5. git merge --ff-only slice.head
6. release lock; mark joined; wake dependents
```

禁止：`git merge --no-ff`、`git push --force`、在共享分支 `git reset --hard`、用 `git clean -fdx` 清理冲突现场、把多个 Slice 的 diff 手工拼成一个提交。

### 9.3 冲突分类

| 类型 | 判据 | 处理 | 禁止 |
|---|---|---|---|
| 机械冲突 | 冲突文件都在 `owner_paths` 内，语义不交叉 | 在 Slice worktree 内 rebase 解决；重跑该 Slice 的诊断/映射 CASE 前置检查；重新入队队首 | 跳过测试直接合并；改别人的文件 |
| 方向性冲突 | 两边对同一契约/目标做了互斥选择，或 Slice 目标已被 base 演进证明无意义 | `abandon_slice({reason})`；保留 worktree/证据；由 Coordinator 重规划；其余 Slice 继续 | 用“选一边”掩盖设计冲突；强行 ff |
| 越界冲突 | 冲突触及 `owner_paths` 之外、受保护资产、根规格、共享文档 | 停止合并；标记 `:failed`；报告越界文件与责任人；人类/Coordinator 裁决 | 继续合并；静默覆盖；删除对方改动 |
| 保护资产冲突 | 根 `AGENTS.md`、S1/S2、`docs/**` 历史、`plans/**` 用户产物被改 | 硬停止；哈希前后比对；报告；不自动恢复 | 静默还原；删除证据 |

### 9.4 可复现记录

每次 fork/merge/abandon 至少记录：

```text
run_id, slice_id, base_commit, branch, worktree path,
start/end timestamps, owner, reviewer,
diff --stat, changed files vs owner_paths,
test commands + exit codes,
rebase rounds + conflict files + resolution category,
ff_commit, queue position, wake events,
protected asset hashes before/after
```

同一输入、同一 base、同一队列顺序应得到同一合并结果；若不能，先修确定性，不用“偶尔成功”作为证据。

## 10. 39 个 CASE 的全部映射

阈值与路径来自 S1 §5；本表不重复评分细则。`主 Slice` 是该 CASE 的第一责任切片；`支撑 Slice` 提供前置能力，不改变主映射。

| CASE | 路径/阈值 | 主 Slice | 支撑 Slice | 验收入口 |
|---|---|---|---|---|
| CASE-01 | 正常/90 | SL-14 | SL-00、SL-02、SL-03、SL-13 | 双入口、依赖收敛、旧路径清除、真实加载 |
| CASE-02 | 正常/90 | SL-11 | SL-08、SL-10、SL-13 | S1 启动、披露、`ask_user`、唯一人工批准 |
| CASE-03 | 错误/90 | SL-11 | SL-08、SL-10 | S1 非法输入、重放、异步、人类编辑重对齐 |
| CASE-04 | 正常/90 | SL-11 | SL-08 | S2 解析、对账、冻结、自动晋级 |
| CASE-05 | 错误/90 | SL-11 | SL-08 | S2 结构/对账拒绝、不半保存 |
| CASE-06 | 正常/90 | SL-11 | SL-08 | S3 模块 DAG 合法门禁 |
| CASE-07 | 错误/90 | SL-11 | SL-08 | S3 非法模块图拒绝 |
| CASE-08 | 正常/90 | SL-11 | SL-08、SL-10、SL-14 | S4 合法 Slice DAG、四哈希、启动 S5 |
| CASE-09 | 错误/90 | SL-11 | SL-08、SL-10 | S4 非法 Slice 图/未覆盖 CASE 拒绝 |
| CASE-10 | 恢复/90 | SL-02 | SL-01、SL-08、SL-11 | 门禁幂等、原子写、崩溃半提交边界 |
| CASE-11 | 安全/95 | SL-06 | SL-05、SL-07 | 六角色能力矩阵、越权拒绝 |
| CASE-12 | 安全/95 | SL-05 | SL-01、SL-06 | 符号逃逸、路径越界、非 UTF-8 |
| CASE-13 | 边界/90 | SL-04 | SL-01 | EDN/UFSS 双射、围栏、错误定位 |
| CASE-14 | 恢复/90 | SL-04 | SL-05、SL-07 | where/whereAll、park/unpark、stamp 复核；期限经 CallMeta |
| CASE-15 | 并发/95 | SL-05 | SL-01、SL-02、SL-09 | read-set/stamp/原子落盘/恰好一次 |
| CASE-16 | 边界/90 | SL-05 | SL-02、SL-06 | VFS 结构冲突、批量上限、失败零落盘 |
| CASE-17 | 并发/95 | SL-06 | SL-05、SL-09 | 写锁 W 互斥、锁序、`call` 交错 |
| CASE-18 | 正常/95 | SL-09 | SL-02、SL-10 | 看板拆分、父项恢复、认领/完成 |
| CASE-19 | 并发/95 | SL-09 | SL-02、SL-10 | `take_or_die` 不可逆生命周期 |
| CASE-20 | 并发/90 | SL-09 | SL-02、SL-10 | 禁睡、等待登记、唤醒 |
| CASE-21 | 正常/90 | SL-10 | SL-02、SL-09、SL-11 | 多 worktree fork/join、rebase/ff-only、abandon |
| CASE-22 | 并发/95 | SL-10 | SL-08、SL-09、SL-11 | Reviewer ⇄ Swarm 任期、接力屏障、Quiescence |
| CASE-23 | 并发/95 | SL-12 | SL-03、SL-10 | K 路审计隔离、并发启动、超时/取消 |
| CASE-24 | 错误/95 | SL-12 | SL-08、SL-10、SL-11 | 审计汇总拒绝、T2 一次性批准 |
| CASE-25 | 正常/90 | SL-12 | SL-10、SL-11 | 返工闭环、T4 RepairSpec、报告、三状态 |
| CASE-26 | 正常/85 | SL-13 | SL-14 | 命令面、状态查询、取消不删文件 |
| CASE-27 | 可访问性/85 | SL-13 | SL-03 | TUI 双态、稳定高度、降级 |
| CASE-28 | 恢复/90 | SL-10 | SL-02、SL-09 | 六窗口恢复、陈旧锁、`.tmp`、repair |
| CASE-29 | 取消/90 | SL-10 | SL-13 | Esc 层级、递归取消、证据保留 |
| CASE-30 | 错误/90 | SL-10 | SL-08 | Nudge 退避、上游断流、确定性错误 |
| CASE-31 | 安全/95 | SL-08 | SL-07、SL-13 | 提示注入、伪批准、只认门禁回执 |
| CASE-32 | 安全/95 | SL-12 | SL-06、SL-08 | 密钥/私人数据五处零命中 |
| CASE-33 | 兼容/85 | SL-03 | SL-13 | 宿主能力探测与降级 |
| CASE-34 | 错误/90 | SL-07 | SL-03、SL-06 | Scope 四型、tool-gate 注入/剥离、CallMeta |
| CASE-35 | 正常/90 | SL-07 | SL-08 | 出站裁剪、简报钉住、缓存断点 |
| CASE-36 | 性能/85 | SL-06 | SL-05、SL-07、SL-12 | 资源上限、CallMeta 期限、并发语义 |
| CASE-37 | 正常/95 | SL-14 | 全部 | 端到端小型使命 |
| CASE-38 | 逆序/90 | SL-14 | SL-02、SL-08、SL-09、SL-10、SL-12 | 乱序门禁、迟到结果、过期认领 |
| CASE-39 | 兼容/95 | SL-14 | SL-03、SL-15 | 真实宿主加载本副本、git 拓扑、旧验收切换、历史产物 |

**映射补充**：CASE-14/36 的期限断言依赖 G1 `CallMeta`；CASE-24 的批准断言依赖 T2 唯一签发；CASE-25 的返工断言依赖 T4 唯一 `RepairSpec`；CASE-11/23/24 的证据写入依赖 C3 路径例外与 B3 保护集；CASE-01/39 的工具面依赖 SL-14 只注册四个产品 `submit_*`。这些是支撑关系，不改变上表的主映射或 S1 阈值。

### 10.1 覆盖断言

- 39 个 CASE 全部出现且只出现一次主映射；没有遗漏、未知或重复的 CASE ID。
- 路径类别全部出现：正常、错误、边界、并发、安全、兼容、恢复、取消、逆序、性能、可访问性。
- S1 §7.4 的 15 类阻断缺陷均有 CASE 覆盖；本表不改变任何阈值或评分细则。
- 每个 CASE 的证据仍由本地 S4 审计员独立执行；本文件只规定由哪个 Slice 交付能力，不把内部测试当验收证据。

## 11. 失败、取消与恢复

| 失败 | 检测 | 隔离/状态 | 恢复 | 禁止 |
|---|---|---|---|---|
| Slice 诊断测试失败 | 退出码/断言 | 该 Slice `:failed`，不进入队列 | Owner 修复；重跑；重新入队 | 把失败藏进“稍后修”继续合并 |
| 机械冲突 | rebase 冲突文件 | `:joining`，队列保持队首 | worktree 内解决；重跑；重新 ff | 跳过测试；改别人文件 |
| 方向性冲突 | 目标/契约互斥 | `:abandoned`，结果不入队 | Coordinator 重规划；其余继续 | 强行选边；非 ff 合并 |
| worktree 不足 | `:INSUFFICIENT_WORKTREES` | 已启动 Slice 继续；未启动保持 pending | 降数重试；释放已完成 worktree 后重试 | 静默改小 N；多 Slice 同 worktree |
| 全部 Slice 失败 | 队列空且无 running | `:no-results` | Coordinator 决定 re-fork/re-plan/终止；给人理由与教训 | 静默结案；伪造通过 |
| 门禁保存后崩溃 | `.tmp`/mission 阶段 | 文件与阶段可能不一致 | 以 `mission.edn` 阶段与哈希为准；重校验；不重复保存/披露 | 猜状态；重放全量历史 |
| `board.edn` 损坏 | 解析失败/校验失败 | 控制状态不可信 | 先备份；从 checkpoint/events 尝试；不能恢复则停止 | 静默新建空看板；假装修复 |
| 取消 | 用户 Esc/取消请求 | `:cancelling` → `:cancelled` 或 `:failed(:outcome-unknown)` | 递归 abort；保留证据；释放自己的锁；不自动重放 | 只停主会话；删证据；把 unknown 当成功 |
| 审计失败/超时/崩溃 | 缺提交/超时/异常 | 该 CASE 未完成；使命不结案 | 重试该 CASE 或整批重跑；派生修复 Slice | 当通过；写“已交付”报告 |
| 主工作区审计期间被改 | 快照哈希/时间戳 | 整批审计无效 | 调查来源；重对齐/修复后重跑 | 混用旧现场结案 |
| 密钥泄漏 | 五处搜索命中 | 停止；标记影响范围 | 报告位置/影响；脱敏；人类决定 | 继续结案；导出密钥 |
| 越界写/所有权冲突 | `git diff --name-only` 对照 | 停止 Slice；保留现场 | 报告越界文件；Coordinator 裁决；重新切片 | 覆盖对方改动；静默还原 |
| `CallMeta` 缺失/过期 | C4/C2 读不到 `{intentBytes,deadlineAt}` | 拒绝执行 `:INTENT_REQUIRED`；不默认期限 | 重新发起带 `intent` 的调用；检查 G1 剥离顺序；记录事件 | 默认 0 期限/无限期限；让底层读 `intent` |
| 批准凭证双源 | T2/T4 都生成 token，或 `mission.edn` 出现两份 `:approval` | 停止结案；以 T2 为唯一真相 | 删除 T4 的 token 生成；重算 `(mission-id, revision, contract-line, report-sha256)`；旧批准作废 | 接受 T4 token；重用旧 revision 批准 |
| 返工所有权冲突 | B3/T4/B2 都派生修复，或修复改冻结 S4 | 停止返工；S4 哈希前后比对 | T4 唯一 `RepairSpec`；B2/B1 执行；S4 不改 | 重复派生；改冻结文档；跳过失败 CASE |
| 子代理父链缺失 | `sessionFile` 被忽略/宿主无父链 | 记录实际值；不把父链当成功条件 | 用 `artifactsDir/<id>.jsonl` + `eventBus`；CASE-23 由人类裁决 | 伪造父链；把 `history://` 当必然可用 |
| DA 无法独立加载/执行 | 独立 `HOME` 链接失败；嵌套 package 未加载；只有 submit 工具 | DA 不可用；不得当审计执行器 | 保留旧工具；单独链接冒烟；S4 用外部可见审计流程 | 把 DA 注册进根入口；把 `submit_manual_report` 当执行证据 |
| 审计证据被快照误判 | B3 `:AUDIT_WORKSPACE_MUTATED`，但变化只在 evidence/artifacts | 审计无效但非产品篡改 | 快照只比较保护集；C3 允许 evidence/专属 tmp；报告差异路径 | 把证据写入当产品篡改；为通过而关闭快照 |
| `advance_s4` 后 fork 失败 | 阶段已是 S5，B1 返回 `:INSUFFICIENT_WORKTREES` | S5 已启动但无 Slice | 不回滚已提交阶段；Coordinator 降数重试；记录可恢复状态 | 回滚已冻结契约；静默改小 N；伪造 Slice |
| B1/B2/T3 端口缺失 | B1 找不到 runnerPort，或 T3 找不到 reviewSink | Slice 无法启动/Reviewer 无法提交 | M0 显式装配端口；缺失即 `:AGENT_SPAWN_FAILED`/拒绝提交 | 让 B1 import B2；让 T3 import B2；隐式全局回调 |

## 12. 旧资产保护

### 12.1 保护对象

| 资产 | 策略 | 证据 |
|---|---|---|
| 根 `AGENTS.md` | 字节不变；AI 不改；迁移前后 `sha256` | 哈希清单；差异即阻断 |
| `requirements.md`、`development-guide.md`、本文件 | 只读；人类确认后不改 | 哈希 |
| `docs/旧的方法论.md`、`旧架构`、`旧设计.html`、`讨论纪要.md`、`兄弟项目参考.md` | 保留只读；不 import 到运行时；不重写 | 哈希 |
| 既有 `docs/manual-acceptance/**` 报告/证据 | 保留只读；不迁移成 `plans/`；不删除 | 哈希 |
| 既有 `plans/**` 用户产物 | 保留；不被测试覆盖；不静默删除 | 哈希 |
| `plans/<slug>/evidence/**`（被测使命） | 仅审计员按 CASE 追加写；不属于产品源码保护集；快照忽略该路径的预期写入；不删除旧证据 | 目录清单 + 每 CASE 报告哈希 |
| `.herd/artifacts/**`、`.herd/audit/**` | 运行时 transcript/审计中间态；预期写入；不当作产品篡改；保留到结案/复核 | 目录清单 |
| `.herd/**`、`.herd-worktrees/**`（若存在） | 内部状态；不删；不改写 | 哈希/目录清单 |
| `README.md`、`CHANGELOG.md` | 可改写/追加，但保留旧变更历史 | diff；旧条目仍在 |
| `LICENSE`、`biome.json` | 不因 clean-break 删除 | 哈希 |

### 12.2 删除清单（只在 SL-14 执行）

以下旧路径在 SL-14 且前置 Slice 全绿后才删除；删除是具名、可核对的一次动作：

```text
src/pi-goal/
src/pi-context/
src/editor-theme/
src/bootstrap-editor-theme.mjs
src/context/
src/tool-gate/strip.mjs
src/host/goal-settings.mjs
src/host/capabilities.mjs
src/prompts/auditor.mjs
src/prompts/manual-protocol.mjs
src/prompts/method-discipline.mjs
src/prompts/repo-aware-rules.mjs
src/prompts/plan-only.mjs
src/prompts/context-skill.mjs
src/manual-acceptance/            // 仅在 DA 冒烟通过且本地 S4 报告可提交后
tests/goal-settings.test.mjs
tests/tool-gate.test.mjs 旧断言
tests/contract.test.mjs 旧契约
tests/requirements.test.mjs 旧解析
package.json 的旧依赖/旧入口导出
```

运行时字符串清除：`AgentSession.prototype`、`TUI.prototype`、`_goalCore`、`goalService.apply`、`PENDING_XDEV_COMPACTS`、`xd://context_compact`、`pi-goal-x`、`pi-context`、`bootstrap-editor-theme`。

### 12.3 规则

- 不把 `rm -rf` 放进复合 shell 命令；一次删除一个具名路径，前后记录哈希/清单。
- 删除旧产物前，必须在 `HISTORY.md` 记录来源、去向、原因、日期；没有记录就不删。
- 不删除 `.herd/`、`.herd-worktrees/`、证据、worktree 来“清理现场”；保留 7 天供复核。
- 旧路径删除后，运行 `git diff --stat` 与字符串/依赖扫描；发现旧符号立即停止并报告。
- 根 `AGENTS.md` 若被人类修改，记录新哈希与新 `revision`；AI 不得用旧哈希结案。
- 审计员写证据是预期行为：C3 只放行 `plans/<slug>/evidence/<case_id>/` 与专属 `/tmp/herd-audit-*`；B3 快照只比较保护集（产品源码/测试/配置/文档/根规格/`.herd` 控制态），不把证据/artifacts/audit/worktree 的预期写入判成 `:AUDIT_WORKSPACE_MUTATED`。

## 13. 真实宿主验收

本节的步骤属于本地 S4 执行，不是本文件已完成的证明。每个测试副本必须独立，不复用 `/tmp`、tmux、`.herd/` 或证据目录。

### 13.1 加载证明

1. 记录 `git rev-parse HEAD`、`git status --porcelain`、`git worktree list`、`git rev-parse --show-toplevel --git-dir --git-common-dir`。
2. 在副本放入唯一标记文件 `.clean-break-marker-<uuid>`；启动 `omp`；记录 `omp plugin list` 与两个入口的 `realpath`，证明解析到本副本而非 `/home/kunweiz/public/HerdchestraLite`。
3. 若当前加载 public 副本，先卸载/禁用该链接，或用隔离 `HOME` 只链接本副本；记录操作前后。
4. 检查根 `AGENTS.md`、S1/S2、本文件、`plans/` 在副本/worktree 的可用性与哈希；未跟踪文件显式复制。
5. 检查工具列表：`clj_*`、`advance_s1`、`board_*` 等新名字存在；无 `/goal-x`；无重复 `submit_manual_*`；DA 不在 `/herd` 工具面。
6. 重命名 `src/tool-gate/index.mjs` 与 `src/bootstrap-main.mjs` 各一次，确认单入口损坏不阻断宿主与另一入口；health 如实报告降级；恢复文件。
7. 捕获一次 `clj_*` 调用的原始 payload 与底层执行参数：`intent` 在 G1 剥离前写入 `CallMeta`，底层参数不含 `intent`/`scope`；`CallMeta` 缺失时沙箱返回 `:INTENT_REQUIRED`，不默认期限。
8. 用隔离 `HOME` 单独链接 `tools/dev-acceptance/`，确认四个提交工具可用；同时确认根 `omp.extensions` 仍只有两个产品入口。DA 不可用时记录环境失败，不用旧工具冒充新 DA。

### 13.2 Slice worktree 契约

- 创建一个 Slice worktree，确认根规格、S1–S4 契约（若为产品使命）或 S1/S2/本文件（开发切片）可通过 C3 只读根白名单读取且哈希一致；不在 worktree 内复制 `.herd/` 控制面。
- 确认 `.git` 不被当业务文件读写；worktree 不因共享 gitdir 丢失契约；`--show-toplevel` 指向预期路径。
- 确认 `node_modules` 的解析路径或显式安装方式，不假设 worktree 天然有依赖。
- 确认该 Slice 的 board/lock/token/checkpoint 都在主工作区 `.herd/missions/.../slices/<slice_id>/`；worktree 只写数据面。

### 13.3 真实宿主边界

- 两个入口独立加载；一个失败不阻断另一个。
- `before_agent_start`、`tool_call`、`setActiveTools`、`setWidget`、`runSubprocess` 的实际形状以运行时探测为准；缺失能力按 S2 §9 降级，不崩溃、不静默换模型。
- 宿主版本三元组（包版本/CLI 版本/运行时能力）写入 `HACK.md`；不伪造 18.16 类型。
- `runSubprocess` 的父链行为逐次探测：记录 `sessionFile` 实际值、`artifactsDir` 下的 `transcript` 路径、`eventBus` 是否可见；若父链被忽略，CASE-23 只记录实际行为，不写成 H1 承诺。
- M0 的 `before_agent_start` 必须追加 `event.systemPrompt`，不替换宿主提示词；`P1a`/`P1b` 的加载边界按当前阶段验证。
- 产品工具面只出现 `submit_review`、`submit_devops_report`、`submit_oracle_advice`、`submit_case_audit`；`submit_manual_*` 只在 DA。
- 所有证据写入 `docs/manual-acceptance/clean-break/evidence/<CASE-ID>/`；产品使命证据仍在 `plans/<slug>/evidence/`，两者不混用。

## 14. 执行顺序与放行

### 14.1 阶段

| 阶段 | 动作 | 放行条件 |
|---|---|---|
| P0 | 冻结本文件；人类确认 S3；记录基线/保护资产哈希 | 人类确认；§3 阻塞项有默认或裁决 |
| P1 | SL-00/01 并行；SL-00 跑执行期先决验证；SL-01 冻结 U0；纯接口 Slice 可同时开工 | U0 测试通过；SL-00 结果可读，未通过项已标 provisional；不以 Spike 全通过作为所有编码的闸门 |
| P2 | SL-02/03/04；立即放行；SL-15 可并行 | 依赖合并；owner_paths 不冲突 |
| P3 | SL-05/07/08/09/13/15 | 依赖合并；契约未漂移 |
| P4 | SL-06/10；SL-12 可并行 | 依赖合并；FIFO/任期测试通过 |
| P5 | SL-11/12 | 依赖合并；阶段/审计测试通过 |
| P6 | SL-14 cutover；真实宿主冒烟 | 全部产品 Slice joined；旧资产哈希一致 |
| P7 | 本地 S4 手工验收（可见审计流程） | 39 CASE 全部执行；S1 批准由真人执行；每 CASE 有独立 evidence；最终 `report.md` 由可见主审计员单写；不把内部测试/DA 提交工具当证据 |

### 14.2 每个 Slice 的交付包

- 改动文件清单（必须与 `owner_paths` 一致）。
- 公开接口与错误码（必须与 §5 一致）。
- 诊断测试命令、退出码、覆盖的失败路径。
- 未决风险与需要 Coordinator 裁决的事项。
- 不得提交：对其他 Slice 文件的改动、共享文档改动、旧资产删除、验收分数。

### 14.3 本地 S4 交接

- 本文件不写 `report.md`；本地 S4 由可见审计流程按 39 CASE 独立执行并写报告。DA 只提供提交工具，不是审计执行器；不得把 `submit_manual_report` 当执行证据。
- S1 人工批准必须由真人执行或由人类明确授权的操作员执行；审计员只观察/记录，不冒充人类批准。K 名审计员并行时，每人只写自己的 `evidence/<CASE>/report.md`；最终 `report.md` 由可见主审计员汇总单写，避免报告所有权分裂。
- 39 个 CASE 不得假设单审计员串行完成；若采用 K 路并行，必须给每 CASE 独立副本、独立证据、独立评分，并记录启动时间/隔离；若只能串行，必须在报告中声明时间限制，不得跳过。
- 报告必须逐 CASE 附证据路径、`user_score`、`developer_score`、`min`、阈值、PASS/FAIL；没有证据的“通过”按硬失败。
- 产品运行时的 `plans/<slug>/s5-report.md` 是另一套产物；不得用本地报告替代，也不得把本地 CASE 直接当产品 S2。

## 15. 待决问题

| ID | 问题 | 推荐默认 | 是否阻塞 | 需要谁决定 |
|---|---|---|---|---|
| Q-01 | 唯一规范工作区是当前仓库还是 `/home/kunweiz/public/HerdchestraLite` | 当前仓库；验收前隔离 public | 阻塞 CASE-01/39 | 人类 |
| Q-02 | 根规格文件名 `AGENTS.md` vs `AGENTS-LITE.md` | 保留 `AGENTS.md`，记录引用不一致 | 非阻塞实现；阻塞提示词逐字一致 | 人类 |
| Q-03 | 根 `AGENTS.md` 是否纳入 Git；共享 gitdir 是否预期 | 不擅自 `git add`；副本显式复制+哈希 | 阻塞 worktree 契约 | 人类 |
| Q-04 | 手工验收参考宿主版本 | 以实际运行时 `realpath`/`package.json` 为准；18.12.x 为目标 | 阻塞 CASE-33 基线 | 人类 |
| Q-05 | 是否接受自建 Promise-CPS 解释器、Cherry 仅作数据运行时 | 接受；记录 `DEBT.md`/`HACK.md` | 阻塞 SL-05 架构 | 人类 |
| Q-06 | DA 最终位置与是否保留 | `tools/dev-acceptance/` 独立子包；不进根入口 | 阻塞 SL-14 删除旧路径 | 人类 |
| Q-07 | S2 §2.6.4 Spike 未执行，是否允许继续 | 不假定编码前必须全通过；SL-00 与纯接口并行；未通过项标 provisional，真实接口在对应 Slice 完成前验证；人类可明确豁免 | 执行期先决，不阻塞纯接口 | 人类 |
| Q-08 | 是否把本文件晋升为产品 S4 | 不直接晋升；在产品流程重写 `plans/<slug>/s4-coordination.md` | 阻塞“直接 promotion” | 人类 |
| Q-09 | 开发集成分支与 base | `herd/clean-break/integration`，从记录 `base_commit` 出发；最终 ff 到用户分支 | 非阻塞 | Coordinator + 人类 |
| Q-10 | 是否用 git worktree 并行开发 | 默认使用；不可用时按文件锁串行，不伪造并发 | 阻塞“最大并发” | 人类/环境 |
| Q-11 | 共享文档单写者 | Coordinator/SL-14；Slice 只报告 | 非阻塞 | Coordinator |
| Q-12 | 确定性故障注入 | 默认关闭、仅测试启用；写入 `HACK.md` | 阻塞 CASE-10/17/28/29 | 人类 |
| Q-13 | 单 CASE 时间预算 | 开发验收 60 分钟软时限；产品审计 30 分钟 | 阻塞 CASE-37 排期 | 人类 |
| Q-14 | 主模型与 `@task` 模型凭据 | 验收环境必须提供两套；不可用记环境失败 | 阻塞真实宿主 CASE | 人类 |
| Q-15 | CASE-01 的 `plans/` 目录 | 测试副本中创建；不提交空占位 | 非阻塞 | Coordinator |
| Q-16 | 本地 S4 报告用新 DA 还是旧工具 | DA 只作提交工具；新 DA 独立链接冒烟通过则用新；否则旧工具，但记录隔离；两者都不是审计执行器 | 阻塞 P7 工具链 | 人类 |
| Q-17 | `sessionFile` 父链是否必须 | 按实际行为记录；父链为探测项，不是 H1 承诺；CASE-23 人类裁决 | 阻塞 CASE-23 解释，不阻塞 H1 | 人类 |
| Q-18 | `setHookWidget` 是否彻底禁用 | 是；只用 `setWidget` | 非阻塞 | Coordinator |
| Q-19 | `plans/` 测试产物隔离 | 全部在 `/tmp` 副本；固定夹具放 `tests/fixtures/` | 非阻塞 | Coordinator |
| Q-20 | 是否给开发验收加独立 Wow 门槛 | 不加；Wow 折叠进双视角 | 非阻塞 | 人类 |
| Q-21 | `intent` 侧通道：`CallMeta` 还是对 `clj_*` 不剥离 | `CallMeta` 由 G1 写、C4/C2 读；缺失 `:INTENT_REQUIRED`；不默认期限 | 阻塞 CASE-14/34/36 | 人类/Coordinator |
| Q-22 | 批准凭证与返工派生的唯一所有者 | 批准：T2 唯一；T4 只调用。返工：B3 单提交校验、T4 唯一 `RepairSpec`、B2/B1 执行 | 阻塞 CASE-24/25 | 人类 |
| Q-23 | B1/B2/T3 的端口装配 | B1 依赖 B0、返回 `SliceHandle[]` 不启动 B2；T3 用 `runnerPort`/`reviewSink`，不 import B2；B2 不 import T3 | 阻塞 SL-10/11 | Coordinator |
| Q-24 | 父链/`sessionFile` 的验收解释 | 记录实际 `sessionFile`/`artifactsDir`/`eventBus`；人类决定 CASE-23 是否要求父链 | 阻塞 CASE-23 判定 | 人类 |
| Q-25 | S4 审计执行与 K 路调度 | DA 只提交；S4 由真人批准、可见审计员执行；K 路时各自 evidence，主审计员单写 report；不得串行跳过 | 阻塞 P7 | 人类 |
| Q-26 | P1 拆分与 M0 提示词追加 | P1a（S1/Plan/Coordinator）/P1b（后期角色）；M0 追加 `event.systemPrompt` | 阻塞 CASE-02/26/27 | 人类/Coordinator |
| Q-27 | C3 证据例外与 B3 快照保护集 | 允许 Auditor 写 evidence/专属 tmp；快照只比较产品源码/测试/文档/配置/控制态 | 阻塞 CASE-11/23/24 | 人类 |
| Q-28 | `advance_s4` 后 fork 失败的恢复 | 先原子提交 S5 再 fork；fork 失败不回滚，Coordinator 降数重试；可恢复状态记录 | 阻塞 CASE-08/10/21 | 人类 |
| Q-29 | C3/B0 端口类型与模块内部拆分 | 冻结 `WriteGateHandle`/`BoardControlPort`/`ActorIdentity`/`ClaimRef`；公开接口不变，内部按 D-04 拆 | 阻塞 SL-05/09 集成 | Coordinator |
| Q-30 | 产品 `submit_*` 工具名 | 只注册 `submit_review`/`submit_devops_report`/`submit_oracle_advice`/`submit_case_audit`；DA 工具不进产品 | 阻塞 CASE-01/39 | Coordinator |

## 16. 完成定义与交付声明

本文件作为 S3 协调手册完成，当且仅当：

- 39 个 CASE 全部有主 Slice 映射，且没有改变 S1 的阈值/路径/评分细则；
- Slice DAG 的 `depends_on` 无环，Slice 目标互不相交，文件所有权无重叠；
- 冻结接口、合并顺序、FIFO/ff-only、冲突分类、失败/取消/恢复、旧资产保护、真实宿主验收、待决问题均可执行；
- S1/S2 与根规格的矛盾逐项登记，未修改任何已批准文档；
- DevOps 预检的 `intent`/`CallMeta`、批准唯一所有者、返工唯一所有者、B1/B2/T3 端口环、父链差异、DA 执行能力、证据路径/快照、Spike 执行期先决均已登记并分配归属；
- 全文没有把未执行的 CASE、未运行的 Spike、未发生的加载写成已通过；
- 本文件是唯一新增文件；没有修改产品代码、根 `AGENTS.md`、S1/S2 或其他文件。

**交付声明**：本文件没有执行任何 CASE，没有产生任何分数、哈希或证据；所有“完成/通过”均为待执行判据。真实宿主加载、旧资产迁移、Slice 合并、审计结果都必须由后续实际执行证明。

## 附录 A：目标 `advance_s4` 可用的 Slice 数组（若晋升）

以下 EDN 只作为本手册的结构化摘要；它尚未被目标门禁校验。`mapped_cases` 是主映射的并集，恰好覆盖 39 个 CASE。支撑 Slice 允许空数组；若目标实现额外要求每 Slice 非空，应把支撑 Slice 合并到其下游，而不是伪造 CASE。

```clojure
[{:slice_id "slice-00-baseline"
  :goal "执行期先决验证：记录宿主、git、Cherry、锁、worktree 基线并跑 Spike，不作为编码前硬闸门"
  :inputs ["AGENTS.md" "docs/manual-acceptance/clean-break/requirements.md" "docs/manual-acceptance/clean-break/development-guide.md"]
  :depends_on []
  :done_when "Spike 矩阵逐项有命令/退出码/结论；未通过项与 provisional 接口显式列出；纯接口 Slice 可并行；不声称已通过"
  :mapped_cases []}

 {:slice_id "slice-01-errors"
  :goal "冻结错误码、EDN 诊断形状与因果链"
  :inputs ["development-guide.md §3.1 U0"]
  :depends_on []
  :done_when "herdError/isHerdError/renderError 通过；无宿主/文件依赖；测试独立"
  :mapped_cases []}

 {:slice_id "slice-02-atomic-lock"
  :goal "实现原子写与文件锁，含 agent_id/term_id 判活与锁序"
  :inputs ["src/util/errors.mjs"]
  :depends_on ["slice-01-errors"]
  :done_when "原子写只留完整旧/新内容；锁 wx/陈旧锁/锁序断言通过"
  :mapped_cases ["CASE-10"]}

 {:slice_id "slice-03-host"
  :goal "实现宿主导入、子代理、健康登记与能力探测"
  :inputs ["src/util/errors.mjs" "S2 §2.6" "slice-00-baseline"]
  :depends_on ["slice-01-errors"]
  :done_when "唯一导入点；spawnAgent 传完整 AgentDefinition/abort/artifacts；health 可读；缺能力明确降级；实际探测 sessionFile/父链并记录"
  :mapped_cases ["CASE-33"]}

 {:slice_id "slice-04-ufss-where"
  :goal "实现 EDN+UFSS 双射与 UTF-16 精确切片"
  :inputs ["src/util/errors.mjs"]
  :depends_on ["slice-01-errors"]
  :done_when "双射/围栏/缩进/控制字符/0 或多匹配/Ukkonen 诊断通过"
  :mapped_cases ["CASE-13" "CASE-14"]}

 {:slice_id "slice-05-sandbox-runtime"
  :goal "实现自建 Promise-CPS 求值器与批内 VFS"
  :inputs ["src/util/errors.mjs" "src/util/atomic-write.mjs" "src/util/file-lock.mjs" "src/host/imports.mjs" "src/clj-sandbox/ufss.mjs" "src/clj-sandbox/where.mjs"]
  :depends_on ["slice-01-errors" "slice-02-atomic-lock" "slice-03-host" "slice-04-ufss-where"]
  :done_when "符号表白名单/挂起恢复/VFS 预演/零触盘/BigInt stamp 通过"
  :mapped_cases ["CASE-12" "CASE-15" "CASE-16"]}

 {:slice_id "slice-06-sandbox-tools"
  :goal "实现角色能力矩阵、clj_* 工具面、call 边界与资源上限"
  :inputs ["src/clj-sandbox/evaluator.mjs" "src/clj-sandbox/vfs.mjs" "CallMeta 契约"]
  :depends_on ["slice-05-sandbox-runtime"]
  :done_when "六角色越权拒绝；Worker call 需令牌；期限从 CallMeta 读取，缺失 :INTENT_REQUIRED；VFS/call/intent 上限与截断标记通过"
  :mapped_cases ["CASE-11" "CASE-17" "CASE-36"]}

 {:slice_id "slice-07-gate-scope"
  :goal "实现 Wire Schema 注入/剥离、Scope 四型、出站投影与 CallMeta 侧通道"
  :inputs ["src/util/errors.mjs" "src/host/health.mjs" "CallMeta 契约"]
  :depends_on ["slice-01-errors" "slice-03-host"]
  :done_when "五类传输/执行前剥离/intent 写入 CallMeta 且底层输入不含门字段/四型 Scope/简报钉住退役/缓存断点通过"
  :mapped_cases ["CASE-34" "CASE-35"]}

 {:slice_id "slice-08-stages-core"
  :goal "实现阶段披露、S1-S4 解析、契约冻结/重对齐与汇总"
  :inputs ["src/util/errors.mjs" "src/util/atomic-write.mjs" "src/util/file-lock.mjs" "src/clj-sandbox/ufss.mjs" "src/clj-sandbox/where.mjs"]
  :depends_on ["slice-01-errors" "slice-04-ufss-where"]
  :done_when "八类 S1 章节/S2 CASE 解析对账/S3 模块 DAG/S4 Slice DAG/四哈希与批准通过"
  :mapped_cases ["CASE-31"]}

 {:slice_id "slice-09-board"
  :goal "实现看板短事务、拆分、父项恢复、令牌与禁睡"
  :inputs ["src/util/errors.mjs" "src/util/atomic-write.mjs" "src/util/file-lock.mjs"]
  :depends_on ["slice-01-errors" "slice-02-atomic-lock"]
  :done_when "T01-T13 关键转换/父项恢复/take_or_die/park_slot 通过"
  :mapped_cases ["CASE-18" "CASE-19" "CASE-20"]}

 {:slice_id "slice-10-worktree-tenure"
  :goal "实现 worktree 生命周期、FIFO join、任期双相、恢复、取消与 Nudge"
  :inputs ["src/swarm/board.mjs" "src/swarm/worktree.mjs" "src/swarm/runner.mjs" "src/stages/contract.mjs" "src/host/subprocess.mjs" "src/host/health.mjs"]
  :depends_on ["slice-03-host" "slice-08-stages-core" "slice-09-board"]
  :done_when "B1 依赖 B0、fork 返回 SliceHandle[] 且不 import B2；B2 经 runnerPort 启动、reviewSink 收 findings；FIFO/rebase-ff-only/abandon/Quiescence/接力屏障/六窗口恢复/取消传播通过"
  :mapped_cases ["CASE-21" "CASE-22" "CASE-28" "CASE-29" "CASE-30"]}

 {:slice_id "slice-11-gate-tools"
  :goal "实现 advance_s1..s4 事务、异步等待、幂等与披露"
  :inputs ["src/stages/disclosures.mjs" "src/stages/parsers.mjs" "src/stages/contract.mjs" "src/swarm/worktree.mjs" "src/host/subprocess.mjs" "src/host/health.mjs"]
  :depends_on ["slice-07-gate-scope" "slice-08-stages-core" "slice-10-worktree-tenure"]
  :done_when "S1 唯一人工批准；S2-S4 自动；awaiting-user；同 call-id 重放；失败不保存/不晋级；批准只调用 T2；submit_review 走 reviewSink"
  :mapped_cases ["CASE-02" "CASE-03" "CASE-04" "CASE-05" "CASE-06" "CASE-07" "CASE-08" "CASE-09"]}

 {:slice_id "slice-12-audit"
  :goal "实现 K 路审计、快照、汇总拒绝、报告/批准与返工"
  :inputs ["src/swarm/auditors.mjs" "src/stages/scores.mjs" "src/swarm/board.mjs" "src/stages/parsers.mjs" "src/stages/contract.mjs" "src/host/subprocess.mjs" "src/host/health.mjs" "src/clj-sandbox/tools.mjs"]
  :depends_on ["slice-03-host" "slice-06-sandbox-tools" "slice-08-stages-core" "slice-09-board"]
  :done_when "K 审计同窗启动/单 CASE prompt/快照只比较保护集/B3 单提交校验/T4 聚合/七类拒绝/全 PASS 才由 T2 签发一次性批准/T4 产出 RepairSpec"
  :mapped_cases ["CASE-23" "CASE-24" "CASE-25" "CASE-32"]}

 {:slice_id "slice-13-prompts-tui"
  :goal "实现提示词、命令面、TUI 双态/降级"
  :inputs ["src/prompts/common.mjs" "src/prompts/roles.mjs" "src/prompts/runtime-wires.mjs" "src/tui/dashboard-model.mjs" "src/tui/dashboard-widget.mjs" "src/host/imports.mjs" "src/host/health.mjs"]
  :depends_on ["slice-01-errors" "slice-03-host"]
  :done_when "零剧透；八条 /herd* 命令；aboveEditor 双态；窄屏/无颜色/挂载失败降级；无 /herd-pair"
  :mapped_cases ["CASE-26" "CASE-27"]}

 {:slice_id "slice-14-assembly-cutover"
  :goal "装配两个入口、收敛依赖、删除旧路径、同步文档并证明真实宿主加载本副本"
  :inputs ["全部产品 Slice" "tools/dev-acceptance" "package.json" "根规格/S1/S2/coordination"]
  :depends_on ["slice-00-baseline" "slice-01-errors" "slice-02-atomic-lock" "slice-03-host" "slice-04-ufss-where" "slice-05-sandbox-runtime" "slice-06-sandbox-tools" "slice-07-gate-scope" "slice-08-stages-core" "slice-09-board" "slice-10-worktree-tenure" "slice-11-gate-tools" "slice-12-audit" "slice-13-prompts-tui" "slice-15-dev-acceptance"]
  :done_when "两入口独立；M0 追加 event.systemPrompt；只注册四个产品 submit_*；只留 cherry-cljs；旧目录/旧字符串/旧工具名清除；真实宿主加载本副本；旧资产保全；DA 不执行审计"
  :mapped_cases ["CASE-01" "CASE-37" "CASE-38" "CASE-39"]}

 {:slice_id "slice-15-dev-acceptance"
  :goal "把开发验收提交工具迁到独立子包，验证可执行，不进入产品入口；不是审计执行器"
  :inputs ["src/util/errors.mjs" "src/util/atomic-write.mjs"]
  :depends_on ["slice-01-errors" "slice-02-atomic-lock"]
  :done_when "tools/dev-acceptance 独立 package.json；四提交工具可用；独立 HOME 链接；根清单不含 DA；旧路径未删前仍可用；明确没有 K 路审计/汇总能力"
  :mapped_cases []}]
```

> 目标 `advance_s4` 的结构化字段只有 `slice_id`、`goal`、`inputs`、`depends_on`、`done_when`、`mapped_cases`；本手册的 `owner_paths`、端口、证据路径、槽位与保留期是协作元数据，不塞进 `advance_s4` 参数，避免未知字段被拒。若目标实现额外要求每 Slice 非空 `mapped_cases`，把支撑 Slice 合并到其下游，不得伪造 CASE。

## 附录 B：一页执行检查表

- [ ] 人类确认本 S3；§3 阻塞项有默认或裁决。
- [ ] 记录 `base_commit`、根规格/S1/S2/本文件哈希、保护资产清单。
- [ ] 冻结 `CallMeta`、批准 T2 唯一、返工 T4 唯一、B1/B2/T3 端口、证据路径/快照保护集。
- [ ] 冻结 §5 共享契约；确认无 Slice 的 `owner_paths` 重叠。
- [ ] SL-00 与纯接口并行；真实接口在对应 Slice 完成前验证；不把 Spike 当全局编码闸门。
- [ ] 按 §6.5 立即放行；按 §6.6 拓扑顺序合并；不按层号等待。
- [ ] 每个 Slice 交付文件清单、接口、测试、风险；越界改动即停。
- [ ] 每次合并记录 FIFO 位置、base/head/ff commit、rebase 轮次、冲突分类。
- [ ] 失败/取消按 §11 保留证据、释放自己的锁、不自动重放。
- [ ] cutover 前核对旧资产哈希；删除逐项具名并写 `HISTORY.md`。
- [ ] 真实宿主用隔离 `HOME`/唯一标记证明加载本副本；工具面无旧/重复项。
- [ ] 本地 S4 由真人执行 S1 批准、可见审计流程执行 39 CASE；DA 只提交，不执行审计；本文件不替代报告。
