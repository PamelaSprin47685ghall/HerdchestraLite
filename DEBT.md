# DEBT.md — 相对根规格的未关闭缺口

> 本文件只记录根 `AGENTS.md` 要求但当前工作区尚未做到的事项，或已经确认的实现/宿主偏差。关闭即删除；不记录已完成项，不把源码存在或测试存在写成完成。
>
> 条款位置以根 `AGENTS.md` 为准；证据以当前文件与 `HACK.md` 为准。任何条目关闭前都必须有真实行为证据，不以自动化测试代替手工验收。

## D0 当前清单只装配 clj 执行器；`/herd` 与编排层未加载

- **条款**：§0.3、§1.3、§2.1–§2.7、§8.1–§8.5、§9.7。
- **缺口**：用户明确要求按 Gall 定律先收敛最小可 dogfood 核心，当前 `package.json` 的 `omp.extensions` / `pi.extensions` 只有 `./src/clj-main.mjs`。它只注册 `clj_plan`、`clj_devops`、`clj_review`、`clj_worker` 与 `/clj-status`；`/herd`、`advance_s1..s4`、`ask_user`、`devops` 子代理、S1 手工批准、`realign_frozen`、`tool-gate`（Scope/intent 注入与剥离）、角色收窄、看板、worktree、K 路审计、TUI 看板均未装配。`src/main.mjs`、`bootstrap-main.mjs`、`tool-gate/index.mjs` 与相关模块仍在仓库中，是保留代码，不是当前可用功能。
- **影响**：当前产品不能执行根规格的五阶段使命；模型在主会话中直接选择四个 `clj_*` 工具，没有角色 admission，也没有 Scope 预算与出站裁剪。`clj_worker` 可直接读写当前工作区，且 VFS 不再限制路径、盲写或 `AGENTS.md`；`clj_devops` 的 `call` 是黑盒 best-effort。宿主 `read`/`write`/`edit`/`apply_patch`/`ast_edit`/`ast_grep`/`bash`/`exec`/`eval`/`glob`/`grep`/`find` 已按黑名单禁用；这不是白名单，其他工具保持原有激活状态。禁用 `read`/`write` 也切断了宿主 `xd://` 传输设备，属于当前有意代价。此状态只适合验证执行器，不适合声称规格已实现或可交付使命。
- **建议处理**：按 README 的扩张顺序逐层接回，每层先真实 dogfood 通过再进入下一层：1) tool-gate Scope/intent 注入、准入、剥离；2) `advance_s1..s4`、`ask_user`、`devops` 与 S1 手工批准；3) 单 Slice 看板与 Reviewer/Worker 角色面；4) 多 worktree、K 路审计与批准。接回时恢复 `package.json` 的原入口集合，并保留 clj-main 作为最小故障隔离面。
- **证据**：`package.json` 的入口；`src/clj-main.mjs`；`HACK.md` §9 的 2026-11-12 clj-only 冒烟记录；`tests/clj-core.test.mjs`（15 pass/0 fail，内部测试，不是验收）；根规格 §9.7 的完整放行标准仍无证据。

## D1 S5 审计闭环的触发与真实收尾未验收

- **条款**：§2.6、§9.5、§9.7 放行标准。
- **缺口**：`main.mjs#runMissionAudit` 已连接 `startAuditBatch`、`aggregate`、`writeS5Report`、`deriveRepairSlices` 与批准路径；触发覆盖 `join_slice` 队列耗尽、`session_start`/`agent_end` 的 `auditReady` 检查，并有 `scheduleAuditRetry` 退避与冻结文件编辑导致的批次作废。`tests/s5-wiring.test.mjs` 包含 join → 真实 B3/T4 提交 → FAIL/修复 → PASS/报告/批准 的自动化集成用例；本轮未运行该用例，且它不是手工验收。真实宿主中的全 Slice、重启恢复、审计批次全 PASS、报告写入与一次性批准尚未实际跑通。
- **影响**：S5 的源码闭环与自动化集成路径已经存在，但不能据此声称“已交付”；若 `join_slice`/`auditReady` 未触发、重启后状态异常或批准 authority 不可用，使命仍可能停在审计前或报告后。`submit_case_audit` 的提交仍无真实宿主证据。
- **建议处理**：用户允许每批已知实操 bug 修完后进行一轮 tmux；发现新一批 bug 就停修，不连续跑第二轮。下一轮 tmux 再跑多 Slice 使命，覆盖最后一个 Slice join、重启后继续、审计异常、全 PASS 与 FAIL 返工；检查 `s5-report.md` 与 `(missionId, revision)` 批准。用 fake runtime 作为辅助，不替代真实宿主。
- **证据**：`src/main.mjs#runMissionAudit`、`scheduleAuditRetry`、`auditReady`；`src/swarm/auditors.mjs#startAuditBatch`；`src/stages/scores.mjs#aggregate/writeS5Report`；`tests/s5-wiring.test.mjs`（自动化集成，不是手工验收）；无真实 `plans/<slug>/s5-report.md`。

## D2 角色身份依赖宿主 `ctx.agent`；缺失时 fail-closed，无独立 role-auth 回退

- **条款**：§8.5.3、§2.1、§9.5。
- **缺口**：`tool-gate/schema.mjs` 不再注册 `role-auth`/nonce 凭据，也没有独立 `tool-gate/role-auth.mjs`；角色收窄由 `tool-gate/index.mjs` 读取宿主报告的子会话身份 `ctx.agent`（`kind`/`depth`）后，再查询 M0 发布的 role surfaces。首行 `[HERD_ROLE: ... nonce=...]` token 仍作为父进程写入的声明被解析和核对，但它不是独立凭据注册表。agent://schema t15 起，`onBeforeAgentStart` 先检测 tokenLike：若 `isSubagent(ctx)` 为 false 且首行是 `[HERD_ROLE:`，直接 `denyRole("host cannot identify a subagent context")`，G1 在 `tool_call` 对所有工具 fail-closed，health 标 degraded；无 token 的正常主会话保持原工具面。`H1.planSpawn` 的能力门要求 `capabilities.hasCtxAgent === true`。
- **影响**：`ctx.agent` 的形状与可用性随宿主版本变化；`HACK.md` 已记录 CLI 18.16.0 有 `ctx.agent`，17.3.5 源码没有，真实 17.x/16.x 未运行。缺失 `ctx.agent` 时带角色 token 的会话现在失败关闭而不是被当作主会话，但该版本上的子会话也无法取得角色面，属保守降级；`ctx.agent.kind` 语义差异仍只能靠真实宿主探测。
- **建议处理**：在真实 17.x/16.x 逐版本探测 `ctx.agent`；缺失时保持 fail-closed 并让 health degraded 可见，不默认角色。独立 host-validation 复测需显式授权。保留首行 role token 的解析测试，但不要恢复独立 role-auth 注册表；所有真实子代理必须验证工具面收敛与 `setActiveTools` 效果。
- **证据**：`agent://schema` t15 结果（2026-11-12）；`src/tool-gate/index.mjs#onBeforeAgentStart`、`isSubagent`、`parseRoleToken`、`roleSurfaceFor`；`src/main.mjs#isSubagentContext`、`publishRoleSurfaces`；`tests/tool-gate.test.mjs`、`tests/tool-gate-schema.test.mjs`、`tests/host.test.mjs`（t15 报告 168 pass / 0 fail、1091 expect；因 `/tmp` 满使用 `/home` 下 TMPDIR 复跑；窄自动化，不是验收）；`HACK.md` §2.3、§2.6.1、§7。未跑 tmux/omp。

## D3 真实宿主加载、端到端使命与手工验收均未完成

- **条款**：§1.2、§9.7、CASE-01/CASE-39 与开发验收 S1–S4。
- **缺口**：`HACK.md` 记录当前 `omp plugin list` 指向 `/home/kunweiz/public/HerdchestraLite`，不是本工作区；本工作区尚未证明被真实 `omp` 加载。没有真实 `tmux` 中的完整 S1→S5 小型使命，没有 `plans/<slug>/` 产品交付物，也没有 `docs/manual-acceptance/clean-break/report.md`。2026-11-12 的真实 18.16.0 隔离副本已观察到 S1 门禁：AI 模拟操作员（非人类、非生产）在真实面板看到 49 行全文、默认 reject，Right 选中批准后 Enter，`advance_s1` 成功进入 S2 并披露；随后 `advance_s2` 因无 CASE 被正确拒绝并停止。该观察只覆盖 S1 门禁单点与一次校验拒绝，不是端到端使命或验收。
- **影响**：所有用户可见行为、门禁批准、worktree join、K 路审计、TUI、Esc 取消与恢复路径都没有验收资格；README 不能声称可发布或已支持。
- **建议处理**：用户允许每批已知实操 bug 修完后进行一轮 tmux；发现新一批 bug 就停修。下一轮 tmux 按 `HACK.md` §6 的隔离 `HOME`/`realpath`/唯一标记流程证明本副本被加载；先跑最小使命（S1 唯一手工批准门禁、S2–S4 自动、单 Slice、K=1 审计），再扩大到多 Slice。S1 手工批准在真实产品运行中只能由人类操作员完成；在独立工作区、非生产数据与非生产凭证且用户明确授权的隔离测试中，AI 操作员可操作真实确认面板模拟批准或修改，并在实测记录中注明是测试模拟，不冒充人类批准或生产授权；产品不因此新增模式或身份字段。S1 面板已有一次隔离观察，但仍需完整使命、S2–S5 与真实产品人类批准证据；把证据写入 `docs/manual-acceptance/clean-break/evidence/`，由可见审计员写 `report.md`。不得用 `bun test` 代替。
- **证据**：`HACK.md` §2.2、§2.6.7、§7；`docs/manual-acceptance/clean-break/` 仅有 requirements/development-guide/coordination，无 `report.md`；根目录无 `plans/`；S1 隔离观察见 `/home/kunweiz/.cache/herd-real-s1-3-20261112-081517/logs/AI-OPERATOR-APPROVAL.json` 与 `watchdog.jsonl`（测试模拟操作，不是验收）。

## D4 全量属性/交错矩阵未形成放行证据

- **条款**：§9.2.6、§9.3.3、§9.7。
- **缺口**：新测试覆盖了 UFSS、where、VFS、board、runner、audit 汇总、contract、gate-tools、scope、TUI 等模块，但尚未运行全量 `bun test` 并逐项核对。根规格要求的完整 V01–V08、T01–T13、F01–F15 交错矩阵与所有属性测试，没有证据表明已全部覆盖。测试不是验收证据。
- **影响**：不能声称“内部属性/交错测试全绿”；未覆盖的确定性交错仍可能隐藏缺口。
- **建议处理**：运行全量开发者测试只作诊断；为未覆盖的确定性交错补测试；最终放行仍按 §9.7 的手工验收执行。
- **证据**：`tests/` 实际清单；未提供全量测试输出；根规格 §9.3.3、§9.4 的矩阵尚未逐项核对。

## D5 `sessionFile` 父链在 18.16 可兑现；17.3.5 与旧实测不同

- **条款**：§2.1 Agent Hub 与 `runSubprocess` 产物说明。
- **缺口（版本差异）**：17.3.5 的 `runSubprocess` 忽略 `sessionFile`（HACK §2.4 的旧探针）；18.16 的 `src/task/executor.ts:4666-4669` 在打开 `<artifactsDir>/<id>.jsonl` 时把它作为 `SessionHeader.parentSession` 传入。旧 D5 的“18 忽略/不能兑现”结论已过时。H1 在 18.16 上必须传真实父路径，不能伪造。
- **当前处理**：H1 接受 `sessionFile` 并直接透传调用方/宿主提供的值，不做存在性/绝对路径预检（宿主处理失败）；提供值但无 `artifactsDir` 时仍按内存态运行，`visibilityNote` 明示仅内存可见，`parentSessionNote` 记录值已透传或未提供；不声称 17.x 一定建链，也不另设链接成功/确认状态。`parentAgentId`/`parentToolCallId` 仍分别用于 AgentRegistry 与 Agent Hub 级父链；`artifactsDir`/`eventBus` 仍负责 transcript 与可见性。
- **影响**：18.16 上 `history://` 是否重放父链取决于宿主对 `SessionHeader.parentSession` 的读取，不能从 H1 单方面承诺；17.3.5 上该参数仍无效。CASE-23 应按实际运行版本记录。
- **建议处理**：M0 为非审计子代理传 `ctx.sessionManager.getSessionFile()`（存在时）；审计路径已由 B3 的 `parentSessionFile` 传入。保留 `parentAgentId`/`parentToolCallId`。不要预建/改名会话文件或手造 header。
- **证据**：18.16 `/tmp/host-probe` `src/task/executor.ts:4303-4306, 4666-4669`；17.3.5 `HACK.md` §2.4 探针；`src/sdk.ts:3030-3033` 的 `parentId`；`src/host/subprocess.mjs` 的 `parentSessionFile`/`parentSessionNote`/`agentLineage`。

## D6 真实出站零剧透与工具名一致性测试缺席

- **条款**：§8.6.2、§8.6.3、§9.3.3。
- **缺口**：当前没有捕获真实 `before_provider_request`/`context` 出站 payload 的零剧透测试，也没有把提示词中出现的工具名与 `tool-gate` 注册表交叉核对的测试。按最新测试纪律，静态比较提示词常量、导出存在或结构接线的测试已被移除；在真实投影夹具可用前不添加模拟代用品。
- **影响**：S1 出站是否泄露 S2–S5 方法论、晋级后旧简报是否退役、提示词工具名是否都在注册表中，目前只能靠代码审查与手工验收，不能由开发者测试自动发现漂移。
- **建议处理**：在集成 Slice 提供真实出站 payload 捕获后，添加“S1 出站不含 S2–S5 关键词”“`advance_s1` 后 S2 简报出现”“`advance_s2` 后 S2 退役、S3 出现”与“提示词工具名 ∈ 注册表”的行为测试；断言对象是捕获的 payload 与真实工具列表，不是提示词字面拷贝。
- **证据**：`tests/` 当前无 `before_provider_request` 出站捕获夹具；`src/prompts/runtime-wires.mjs` 与 `src/tool-gate/schema.mjs` 各自维护 gate 字段，未做跨模块一致性断言。

## D7 Evaluator 的纯 core 高阶、惰性语义与宏/特殊形式限制

- **条款**：§4.1.3（`cljs.core`/纯函数库与异步高阶序列）、§4.1.4（异步顺序求值）、§4.1.5（纯函数与正则）、§4.4.2（续体与 `:ask`）。
- **缺口**：以下来自 `agent://remaining-evaluator` t3 最新交付，只记录仍未闭合/受限项；已实现项不在此列，窄测试不等于验收。
  - `sequence`/`eduction` 已改为惰性/可重复消费描述，但需要物化的消费者仍受 200000 `:LIMIT_EXCEEDED` 资源上限；这是明确上限，不是静默截断。
  - `memoize` 缓存为线性扫描，无上限/哈希分桶；callable 对象经 `ednSafe` 序列化进 receipt 是既有问题。
- **影响**：超过 200000 项的 `sequence`/`eduction` 物化或大规模 `memoize` 的程序仍会受限；不能把当前求值器宣传为完整 ClojureScript/Cherry 语义。
- **建议处理**：把支持子集写进运行时提示或工具说明；对未实现组合返回明确的 `:CAPABILITY_DENIED`/`LIMIT_EXCEEDED`，不用静默空值伪装；继续补 memoize 上限/分桶，或明确列为不支持；复测前保持 DEBT 打开。
- **证据**：`agent://remaining-evaluator` t3 结果（2026-11-12）；`src/clj-sandbox/evaluator.mjs`；`tests/evaluator.test.mjs`（窄自动化，不是验收证据）。`halt-when` 异步谓词/retf 与最终值向 `into`/`transduce` 的传递已由 t3 修复并有窄行为验证（t3 报告 159 pass / 0 fail），不列为 DEBT 缺口；t3 未跑 tmux/omp，窄测试不等于验收。

## D8 Evaluator 取消、宿主 Promise 与迟到结算限制

- **条款**：§4.1.4（异步求值）、§4.4.2（期限/续体）、§4.5.5（取消与崩溃）、§6.3（递归取消语义）。
- **缺口**：t14 已把 abort 时未在 100ms grace 内结算的 capability 记入 `program.abandonedCapabilities`（status=`:outcome-unknown`，保留迟到 `settled`/`result`/`error` 更新，finish 置空防重放）；aborted receipt 新增 `:interrupted-capabilities` 数组（capability、argument、status、settled、outcome、result、error）。t15 进一步新增 `session.abandoned` 会话级账本：`waitPending` abort 时同时写 program 快照与 session 账本，同名新程序启动只替换 `session.programs`、不覆盖账本；`abandonedCapabilities(session,name)` 改读 session 账本，未知 name 返回 `[]`，迟到 settle 后再次调用可见；`tools.mjs#runExecution` 在每次 receipt 返回前附加同名程序非空的 `abandoned-capabilities`，模型可在后续同名程序回执看到迟到结果，successor 代码也可直接调用导出。程序仍 failed/aborted，迟到值只作诊断、不自动重试，capability 只调用一次。t17 曾新增固定 5s 端口 watchdog，t18 已删除：按根 §2.5.1/§7.3，W/锁等待不设自动超时转交；`commit`/`discard` 只 race port promise 与 program control，intent deadline 到期进入 parked 并保留 `pendingCommit`/`pendingDiscard`，unpark 继续等同一 promise，取消仍走 100ms grace → `:outcome-unknown`/`:uncertain`，不重放。仍存限制：generic capability 没有 board `actionId`，evaluator 不能也不应代替 runner/board `markUncertain`，归责仍须 C4/上层依据 receipt/ledger 核对；账本为 session 生命周期，随 session 丢弃/进程退出清理，同名复用不覆盖，未做 TTL/逐条 dismiss（避免静默丢证），长期会话硬上限需单独设计；同名工具回执会同时出现 `interrupted-capabilities` 快照与 `abandoned-capabilities` 活记录，两者语义不同且未去重；`call` 的内部 pre-drain 没有独立 watchdog，evaluator 无 drain 端口（`tools.mjs` 显式删除），D8 的 drain 端口仍明确未支持。端口 Promise reject 已归入 `rejected`，`commit` 清理 `pendingCommit`、`discard` 清理 `pendingDiscard` 并标 `:uncertain`，deadline/abort 竞争已修。
- **影响**：递归取消/期限到期时，迟到结算现在可在后续同名工具回执与会话账本中观察，但被放弃 generic capability 的外部副作用仍不能在 board 内自动归责，只能靠 receipt/ledger 人工核对；非协作端口仍可能留下未归属副作用；长期会话的账本仅靠生命周期清理，无 TTL 上限。与 §6.3 的递归取消和 §4.4.2 的期限挂起仍不完全一致。
- **建议处理**：由 C4/上层消费 receipt 的 `interrupted-capabilities`/`abandoned-capabilities` 与 `session.abandoned` 账本，把被放弃 capability 的外部副作用标为 `:outcome-unknown` 并要求后继者核对；若长期会话需要硬上限，单独设计 TTL/dismiss 且不静默丢证；新宿主 Promise 端口接入时套用同一 deadline/park 与 abandoned 记录，不用未证明的额外 timeout 代替根要求的 park；补 drain 端口或明确列为不支持。不再把正则回溯列为未解决。
- **证据**：`agent://lazy-fix` t14/t15/t17/t18 结果（2026-11-12）；`src/clj-sandbox/evaluator.mjs`、`src/clj-sandbox/tools.mjs`；`tests/evaluator.test.mjs`、`tests/sandbox-tools.test.mjs`（t18 报告 evaluator 105 pass / 728 expect；evaluator+regex-worker+sandbox-tools 178 pass / 0 fail / 1095 expect；Biome clean；窄自动化，不是验收证据）；未跑 tmux/omp。

## D9 真实宿主工具门 F1 尚在修复中；F2/F3 仅旧快照通过

- **条款**：§1.2（宿主能力假设）、§5.2（Wire Schema 协议门）、§8.5.3（gate 字段定义）、§9.7（放行标准）。
- **缺口**：真实宿主工具门 F1 仍在修复中。F2/F3 已在旧快照上观测通过，但这不是当前源码、当前工作区的真实宿主证据；旧快照记录不能升级为当前通过。缺失 gate 字段必须区分两种原因：模型根本没有提交字段，与旧版宿主在 G1 之前已把字段预剥；两者不能混为“剥离成功”或“模型漏传”。
- **影响**：§5.2 的 schema 注入、准入/记账与执行前剥离在真实宿主上仍不能判为完成；若把旧快照 F2/F3 或旧版宿主的预剥行为当成当前证据，会误判 F1 已修复。依赖真实 `before_provider_request`/`tool_call {input}` 的 CASE 不能放行。
- **建议处理**：完成 F1 修复后，按批次允许的下一轮 tmux，用当前源码在真实宿主重新捕获 provider payload 与工具执行参数，分别证明注入字段可见、模型确实提交、G1 在执行前剥离；对“模型漏传”和“宿主预剥”分别留证。F2/F3 复用旧快照时只能标“旧快照曾通过”，不能标当前通过。
- **证据**：历史快照记录（`HACK.md` §2.6.2）；当前任务输入；当前工作区未提供 F1/F2/F3 的新真实宿主证据。

## D10 多项真实宿主 bug 的源码修复尚未真实复测

- **条款**：§1.2（宿主能力）、§2.1（角色/工具面）、§2.3（阶段切换）、§2.5（Slice/board 编排）、§2.7（S5 空账与无人值守）、§4.4.2（`ask`/续体）、§5.2（工具门）、§8.4（角色提示词/描述）、§9.7（放行标准）。
- **缺口**：以下各项已做源码修复与窄自动化验证，但尚未在真实宿主复测，不能写成已修复或已验收：
  1. `systemPrompt` 透传与 NUL 拒绝；
  2. `roleOf` 硬编码；
  3. `onStageChange`（阶段切换）；
  4. S5 空账问；
  5. 角色描述；
  6. `ex-message`；
  7. gate fail-open（此前的门禁静默放行）；
  8. `main` 缺 board 端口。
- **影响**：这些问题在旧真实宿主观察中曾经出现；当前源码的修复没有真实宿主证据，旧快照也不能证明修复后行为。窄自动化测试只覆盖内部路径，不构成验收。
- **建议处理**：用户允许每批已知实操 bug 修完后进行一轮 tmux；发现新一批 bug 就停修。本轮未运行 tmux/omp。下一轮 tmux 逐项验证：`systemPrompt` 透传与 NUL 拒绝、`roleOf` 角色面、`onStageChange` 的工具面/简报切换、S5 空账问只问一次且等待期抑制 Nudge、角色描述、`ex-message`、gate fail-open 非法输入拒绝、`main` board 端口接线；复测前保持 DEBT 打开。
- **证据**：当前任务输入；源码修复与窄自动化验证记录（本轮未运行 tmux/omp，未新增真实宿主证据）。

## D11 多工人修复的源码/窄测试状态未真实宿主验证

- **条款**：§2.5（Slice/worktree 编排）、§3.2（看板与唤醒）、§4.3（受保护提交）、§4.4（`call` 与取消）、§5.2/§5.3（工具门与 Scope）、§9.7（放行标准）。
- **缺口**：以下修复已落源码并配有窄自动化测试，但本轮没有 tmux/omp 实测，不能写成已验收：
  1. `worktrees.edn` 作为真实 worktree 控制状态（EDN，不再依赖旧的 JSON 形态）；
  2. 看板 `wake-all` 与触发变更在同一 board-lock 事务内提交，避免事后二写覆盖并发状态；
  3. 主装配的 durable board + $W$ + Holder `call` 窄场景：`writeGatePort`、`createWriteGateControl` 与 sandbox 的 identity/claim 端口接通；`tests/main-consumer.test.mjs` 覆盖 claim → protected write → Holder call；
  4. `call` 的取消与日志路径：`callLogDir`、取消后的 `:cancelled`/`:UPSTREAM_ABORTED` 与不假装成功；
  5. 冻结文件的人类编辑 realign：`realignEditedFrozen` 重读磁盘、更新哈希/revision、发送对齐提示，不覆盖用户字节；
  6. Scope 的准入、回合结算、归档与出站投影路径。
- **影响**：这些是源码与窄测试层面的修复；真实宿主的 worktree、看板并发、Holder `call`、取消传播、冻结文件重对齐与 Scope 投影仍未复测。`s5-wiring` 等自动化集成不能替代手工验收。
- **建议处理**：用户允许每批已知实操 bug 修完后进行一轮 tmux；发现新一批 bug 就停修。下一轮 tmux 按模块逐项复测，保留旧快照与当前源码的区别。重点验证两个并发个体下的原子 wake、真实 worktree 上的 `worktrees.edn`、Holder 的 `call`/claim 消费、审计重试与重启恢复、冻结文件 realign 后 Scope 投影。复测前保持 DEBT 打开。
- **证据**：`src/swarm/worktree.mjs`、`src/swarm/board.mjs`、`src/main.mjs#writeGatePort`、`src/clj-sandbox/tools.mjs`、`src/clj-sandbox/vfs.mjs`、`src/stages/contract.mjs#realign`、`src/scope/*`；`tests/worktree.test.mjs`、`tests/board.test.mjs`、`tests/main-consumer.test.mjs`、`tests/sandbox-tools.test.mjs`、`tests/stages-gate-tools.test.mjs`、`tests/scope.test.mjs`（窄自动化，不是验收）。

## D12 Auditor per-auditor 执行器已接线；真实 bwrap/tmux 生命周期与嵌套 omp 仅 smoke，未验收

- **条款**：§2.6.1（审计员隔离）、§2.6.2（真实 tmux 抓屏与 `/tmp` 破坏副本）、§4.2（`clj_auditor` 的 `call` 与只读主工作区）。
- **当前源码状态**：`src/sandbox/` 已提供 `bwrap`、两阶段 Landlock、`createAuditorSandbox` 与私有 tmux socket/session；`src/clj-sandbox/tools.mjs` 的 auditor 能力矩阵含 `call`，但没有 active bwrap sandbox 时 `auditorSandboxReady` 拒绝；`CALL_FORBIDDEN_ROLES` 为空，`main.mjs#AUDITOR_SANDBOX` 只在 sandbox 可用时注册 `clj_auditor`，不可用时 `runMissionAudit`/`submit_case_audit` 显式拒绝。`src/swarm/auditors.mjs#ensureIsolationPaths` 在 `buildCaseAuditorPrompt` 之后追加 `## Framework isolation paths`，实际 auditTmp/socket/session 由 runtime 提供，不改写 §8.4 规范原文。`src/sandbox/bwrap.mjs#validateSandboxPaths` 现在在 `realpath(tmpdir())` 位于 auditTmp 内时以 `:CAPABILITY_DENIED` 拒绝，错误为 “nested omp is the test subject, not the auditor”：host auditor subagent 在宿主运行，bwrap 只是它的 `clj_auditor.call`/TUI 工具面，nested omp 的 `TMPDIR=auditTmp/tmp` 不能冒充 auditor；host auditor 的正常 TMPDIR 不受影响。`session.mjs` 的 auditTmp 已按 §2.6.1 去掉 batch 段。
- **当前能力值**：本机 `sandboxCapability()` = `{available:true, bwrap:'/usr/bin/bwrap', tmux:'/usr/bin/tmux', bun:'/home/kunweiz/.bun/bin/bun', landlockAbi:11}`。因此本机 `AUDITOR_SANDBOX.available=true`，`clj_auditor` 会注册、`runMissionAudit`/`submit_case_audit` 会放行；能力缺失的宿主才 blocked/`:CAPABILITY_DENIED`。可用只证明宿主工具存在，不证明隔离正确。
- **已观察（t8/t11，2026-11-12）**：真实 `createAuditorSandbox` 启动 `available:true`、`landlockAbi:11` 的 bwrap 与私有 tmux session/socket；跨调用 `runCommand` 观察到进入同一沙箱；主工作区只读验证通过（marker 可读、写入返回 `Read-only file system`、宿主 probe 文件不存在）；关闭后 bwrap、auditTmp、socketDir 均消失且无嵌套进程残留。t11 在同一私有 tmux 中启动嵌套 omp 18.18.8（产品 main sha256 `3a05e48b1a0a4d7ac2c76de62f1762d19ff5aee70907c624b4ea1bfed50bea6f`），显式加载当前产品扩展，active tool surface 含 `advance_s1..s4`、`clj_plan/clj_devops/clj_review/clj_worker`、`devops`、`submit_devops_report`、`submit_case_audit`、`ask_user`、`ask_previous_scope`、`board_*`；固定 host-side 内存 canned responder 返回 `D12-NESTED-OK`（provider request 2 次、relay HTTP 4 次、toolCalls 0）。fake 8k context 触发 compaction warning，归因 smoke 模型上下文，不判产品 bug。
- **已撤回的阳性**：此前有一轮 plain host 运行一度报告产品扩展已加载；复查确认产品安装未实际生效，该阳性结论撤回，不作为 D12 证据。
- **仍未验证**：真实模型、角色审计、实际工具调用、审计提交/评分/批准均未执行；宿主 socket 不可达的破坏性证明、“fixed provider relay 可达且只转发 pinned provider”的完整语义、两阶段 Landlock 在完整审计生命周期内的强制、nested omp 的 prompt 追加顺序与真实模型 egress、`clj_auditor.call` 实际执行、K 路审计与 per-auditor 资源回收、真实 18.16.0 宿主基线（本 smoke 为 18.18.8）都未验证。`validateSandboxPaths` 的 nested-auditor TMPDIR 拒绝只有 `tests/sandbox-isolation.test.mjs` 窄测试；网络层只有 sandbox-network 窄测试；凭据/平台只有提示词/静态检查，且 credentials stay host-side 仅限 proxy mode，env-only provider 由 `selectAuditTransport` 拒绝。不能把“源码有 bwrap/Landlock”或 t8/t11 smoke 写成“隔离已验证”。
- **实现方解释**：用户未对 per-auditor 临时执行器作确认；实现方按任务生命周期把它解释为随审计创建、随审计回收的临时资源，而不是跨任务常驻服务。该解释需真实隔离验证；若验证发现与根 §1/§10.1 冲突，须由人类修改根规格，不由实现方自行裁决。
- **影响**：t8/t11 只证明沙箱可启动、主工作区只读、跨调用与关闭清理可观察，以及嵌套 omp 能加载产品扩展并经 canned responder 回复；真实隔离、真实模型与审计行为仍未证明，S5 的真实 tmux/TUI 证据尚未产生。能力缺失的宿主上审计被显式阻断。任何“per-auditor 执行器已验收”“宿主 socket 已被强制阻断”说法都不成立。
- **建议处理**：保持能力门与 `:CAPABILITY_DENIED`，不要把 t8/t11 smoke 当作隔离验收；下一轮需在真实模型与真实 `clj_auditor.call` 下验证宿主 tmux/D-Bus socket 不可达、`/proc` 无宿主别名、只有 evidence/audit-tmp 可写、跨调用 tmux 存活且仍在沙箱内、Landlock 失败即拒绝启动、prompt 追加顺序与审计结束后资源回收；提交/评分/批准仍需用户授权，canned responder 不能替代。
- **证据**：`agent://reuse-validation` t8/t10/t11 结果（2026-11-12）；现场 `/home/kunweiz/.cache/herd-nested-omp2-20261112-065827`（`logs/nested.jsonl`、`preserved/1794437946727-final`）；`src/sandbox/{bwrap,landlock,session,model-worker}.mjs`、`src/clj-sandbox/tools.mjs#CAPABILITY_MATRIX`/`auditorSandboxReady`、`src/main.mjs#AUDITOR_SANDBOX`/`runMissionAudit`、`src/swarm/auditors.mjs#ensureIsolationPaths`/`createAuditorSandbox`；本机 `sandboxCapability()`/`landlockCapability()` 输出；`tests/sandbox-isolation.test.mjs`、`tests/sandbox-network.test.mjs`、`tests/sandbox-tools.test.mjs`、`tests/audit.test.mjs`、`tests/main-bootstrap.test.mjs`、`tests/main-consumer.test.mjs` 窄测 125 pass / 0 fail，sandbox 两文件 35 pass / 0 fail；窄测试与 t8/t11 smoke 均非验收。

## D13 阶段控制态 clean-break 已落源码；真实 S5 审计 end-to-end 未完成

- **条款**：§2.2（S1 摘要冻结）、§2.3（`cases.edn`、`:s3-modules`、`:frozen` 为权威）、§2.5/§3.4（`board_finish.dependency_paths`、`wait_for`）、§2.6.1（审计 CASE 数据集装载）、§4.2（`clj_plan`/`clj_auditor` 的读取面）。
- **已实现（源码只读核对 + 各组件窄测报告；不是验收）**：
  1. **S1 摘要**：`advance_s1.summary` 经 `saveS1Summary` 原样写入 `.herd/missions/<slug>/s1-summary.md`；`freezeStage(s1)` 要求该文件存在，并把 `s1-summary` 作为七项 `:frozen` 之一冻结；`readS1Summary` 回读字节与哈希。
  2. **S2 CASE**：`parsers.validateS2` 只校验方法论 Markdown，CASE 由 `normalizeCaseSpecs` 按 `case_id`/`path`/`threshold`/`steps`/`expected`/`rubric` 严格校验；`advance_s2` 经 `contract.commitS2` 在同一使命事务内写/复用 `cases.edn`、保存 `s2-manual-tests.md`、回读校验并冻结 `s2-cases`。Markdown 的 `CASE-*` 文本不再是来源。stage-parsers t17 修掉回执包装缺陷：`validationFailure` 固定用已注册的 `:INVALID_ARGUMENT` 作 outer code，`data` 保留 `{stage, errors}`，不再因未注册 parser code 触发 `herdError` 回退而丢掉 `required`/`missing`/`received`/`next`。
  3. **S3 modules**：`advance_s3` 把完整 `modules`（含 `mapped_cases`）写入 `mission.edn` 的 `:s3-modules`，并按规范 inline EDN 字节计算 `s3-modules` 哈希；S3 文档哈希单独冻结。S4 校验读取冻结 `cases.edn` 与 `:s3-modules` 做覆盖检查。stage-parsers t16 修掉了 `validateS3` 对 Markdown `CASE 对应表` 标题的额外要求，并让依赖图识别 `模块 DAG`/`dag`；CASE 映射仍只由结构化 `mapped_cases` 校验。
  4. **S4 slices**：`advance_s4` 用冻结 CASE ID 校验 `slices[].mapped_cases` 覆盖，并把完整 `slices` 写入 `mission.edn` 的 `:s4-slices`；`realign` 支持 `s4-slices` 目标。stage-parsers t18 修掉 S4 文档/ID 误拒：merge-order 接受 `合并拓扑`/`合入顺序`/`merge topology`；`slice_id` 接受 uppercase（仍拒绝空格、斜杠、点等不适合 branch/worktree 后缀的字符）；`depends_on` 保持精确大小写匹配并新增 case-mismatch 拒绝测试。worktree 同步接受 uppercase/underscore，并在 workspace、branch、writeW/board 锁路径、`worktrees.edn` 键与 handle 中逐字保留大小写；窄测 30 pass/195 expect。
  5. **`:frozen` 与 contract-line**：`FROZEN_KEYS` 为 `s1`、`s1-summary`、`s2`、`s2-cases`、`s3`、`s3-modules`、`s4` 七项；`buildContractLine` 只从七项渲染，`parseContractLine` 只接受七项；`verifyContract` 重算七项，contract-line 陈旧只告警，`:frozen` 保持权威。
  6. **S5 审计装载**：`main.caseSpecsFor` 从冻结 `cases.edn` 与 `s1-summary.md` 读取，随后重读 mission 并核对两个哈希；`runMissionAudit` 把 `caseEdn`/`s1Summary` 字节与哈希传入 `startAuditBatch`；`auditors.startAuditBatch` 在启动任何审计员前，用 contract port 返回的活 `s2-cases`/`s1-summary` 哈希再绑定一次，防止 realign 造成的 TOCTOU。审计只消费单条 CASE 记录，不读 Markdown。
  7. **board 与沙箱**：`validateDependencyPaths` 要求 `dependency_paths` 为工作区相对路径并拒绝越界；`wait_for` 支持既有子任务 ID 或 `condition:<key>` 前缀；`main.finishBoardTask` 在 $W$ 内复核观测事实。`clj_plan` 可读冻结 `cases.edn`，`clj_auditor` 的 `cat`/`stat`/`ls` 明确拒绝该数据集并只使用注入记录。
  8. **worktree fork 失败拓扑**：`forkSlices` 先预写完整 Slice 拓扑；失败时不再删除已预写的 Slice。清理成功把该 Slice 恢复 `:pending` 并写 `:last-fork-error {code,message,at}`；清理失败标 `:failed` + `:failure-reason`，不伪造 handle。已成功的 Slice 保持 `:running` 与 worktree，后续失败只影响自身；容量/中途资源失败保留完整拓扑并标 `recoverable:true`；`recoverCreatingSlices` 对缺失 workspace 的 `creating` Slice 改为 `:pending` + error，不再删除。窄测 `tests/worktree.test.mjs` 34 pass/230 expect。
  9. **Scope 回执与声明字段**：`SCOPE_UNINITIALIZED` 的 data 现在带 `required: ["new_scope_goal","new_scope_retention_budget"]` 与可执行的 resetScope `next` 示例，不再只列 `kind`/`tool`（schema t18）。schema t19 进一步修正准入：出站 flat scope schema 声明的四个字段（`kind`、`new_scope_goal`、`new_scope_retention_budget`、`replacement`）对 `resetScope` 与 `removeLast` 均合法，`replacement` 不再被 per-kind 白名单误拒；各 kind 的必需字段仍强制，`keepLast`/`meToo` 仍按 COMMON 拒绝额外字段。没有修改 `tool-gate/schema.mjs` 或 `tool-gate/index.mjs`；r13 的两个 Reviewer 错误是并发兄弟调用与旧监控误判，r14 的 `resetScope.replacement` 拒绝是实证产品 bug，已修。
- **真实隔离 rS3 观察（2026-11-12，`herd-real-s1-5`，18.16.0；非验收）**：S1 面板在真实 overlay 中显示 `1-57/60`（Home）、PgDn 后 `4-60/60`，默认拒绝，Right 选中批准后 Enter；`advance_s1` 成功进入 S2。S2 首次调用即成功：`cases.edn` 冻结 5 个结构化 CASE（`CASE-01..05`，路径为正常/错误/边界/并发/恢复；`case-id`/`path`/`threshold`/`steps`/`expected`/`rubric` 齐全，sha256 `068c37971a56a40bc9078ddecf89b1e63a62f15fcbeec29191f071583fb965c1`），`s2-manual-tests.md` 是独立方法论文件。随后 `advance_s3` 第一次因模型漏传 gate 字段报 `SCOPE_INVALID`（允许一次已知准入），第二次被旧 `validateS3` 拒绝，错误为缺少 `依赖图` 与 `CASE 对应表`；真实 payload 的文档实际使用 `## 模块契约`、`## 模块 DAG`、`## 用例到模块的映射`，且 `modules[].mapped_cases` 已覆盖 5 个 CASE。watchdog 按未知错误停止，未保存/披露 S3。该轮当时归类为“模型内容错误、未确认产品 bug”；stage-parsers t16 用同一真实 payload 复现后判定为 `validateS3` 缺陷并修复；后续 rS4 已让该修复真实执行并成功晋级 S4（见下一条）。
- **真实隔离 s1-7 观察（2026-11-12，`herd-real-s1-7`，18.16.0；非验收）**：S1 面板 56 行全文可见、默认拒绝，Right 选中批准后 Enter，`advance_s1` 成功。S2 模型反复把 `cases[].path` 写成文件路径（如 `/home/.../README.md`），五类 category label 一个也未覆盖；第一次 `CASE_REQUIRED_PATH_MISSING` 被允许一次，随后一次 `SCOPE_INVALID`（缺 gate 字段）也被允许一次，第三次同类错误触发 watchdog 停止；S2 文档未保存、`cases.edn` 未创建、未披露 S3。该轮当场归类为模型内容错误重复；Schema 拒绝本身正确，但旧回执只返回 `data.code`，丢掉 `stage`/`errors`/`required`/`missing`/`received`/`next`，属于产品报告缺陷；stage-parsers t17 已修复并用窄测覆盖。该轮未到 S3；后续 rS4 已恢复原 session 并让 S3 真实成功（见下一条）。
- **真实隔离 rS4 观察（2026-11-12，`herd-real-s1-8`，18.16.0；非验收）**：在全新隔离副本中恢复原 session `01a1ce11-5838-71d1-a23d-4affe9335a6f`，只改 session header 的 cwd，其余字节一致；`omp --resume` 直接显示 mission `791e6f` 在 S3，未手工 `/herd-focus`。随后 `advance_s3` 首次成功（`isError=false`，S3 文档 5290 bytes，revision 3，missionStage=`s4`，披露 S4；t16 修复得到真实执行）。`advance_s4` 首次被旧 `validateS4` 拒绝，错误为缺少 `拓扑合并顺序`、`slice_id must be lowercase: SLICE-01..04`、`SLICE-04 depends_on undeclared SLICE-01/SLICE-02`。该轮当场归类为 S4 模型内容错误；stage-parsers t18 用同一真实 payload 确认文档的 `## 6. 合并拓扑` 与 uppercase `SLICE-01..04` 均合法，依赖报错是 ID 被误拒后的级联，属校验器误拒。t18 修复合集后，真实 payload 直接校验得到 `{ok:true,errors:[]}`；后续 s1-9 已真实重测 S4 成功（见下一条）。
- **真实隔离 rS5 观察（2026-11-12，`herd-real-s1-9`，18.16.0；非验收）**：在全新隔离副本恢复原 session（只改 header cwd，old s1-8 未动），UI 显示 mission `791e6f` 在 S4。`advance_s4` **真实成功**（`isError=false`，S4 文档 8264 bytes，missionStage=`s5`，s4FixVerified=true），t18 的 S4 修复得到真实执行。随后 `fork_slices` 返回 `FF_NOT_READY`（`git show-ref --verify failed`），因为该隔离副本没有 `.git`，无法创建 worktree/ref；watchdog 按首未知停止，未进入 S5、未自动重试。无 `.git` 时先返回 `FF_NOT_READY` 合理，但 worktree t5 只读复核 r9 现场发现实证产品 bug：`worktrees.edn` 先写完整 DAG（05:15:45.919Z），失败清理时删掉首个失败 Slice 的 pending 行（05:15:48.587Z），只剩 `slice-02/03/04` 均 `:pending`，`slice-04` 的 `depends-on` 引用不存在的 `slice-01`，队列为空且无 `.herd-worktrees`；这是半提交/孤立拓扑，不是单纯环境问题。t5 已修复为保留完整拓扑（细节见“已实现”第 8 项）并用确定性故障注入验证；后续 s1-13 已在 Git 副本上成功 fork 3 个 worktree，但 Reviewer 并行调用被旧监控误杀（见下一条）。
- **真实隔离 rS5 续测（2026-11-12，`herd-real-s1-13`，18.16.0；非验收）**：新 Git 副本 `herd-real-s1-13`（baseline `10bed1ee...`，main clean，S1–S4 契约字节一致）恢复原 session（仅 header cwd），UI 显示 mission `791e6f` 在 S5。出站 provider schema 探针记录到 8 个工具，`fork_slices` 与所选非豁免工具的四个 gate 字段均存在且 `required`，探针未 abort；r12 的缺字段错误是模型 `partialArgs` 侧漏传，不是出站 schema 缺字段。`fork_slices` **真实成功**：创建 `slice-01/02/03` 三个 worktree/分支（base `10bed1ee...`），`slice-04` 按依赖保持 pending；board 为 3 running/1 queued。t5 修复已加载，但其失败清理路径未在本轮触发。随后 `Reviewer-slice-03-T-1`（agent `3a7341ea...`）在同一 assistant 回合并行发出两个 `clj_review`（同一 `05:51:58.061Z`，均为 `scope {kind: keepLast}`），两次因 scope 未初始化被拒；第一次允许一次，旧探针把同一 actor 的第二个并发兄弟调用误当“重复重试”并 abort，整轮停止。两者不是先后重试，该停止是测试监控假阳性，不是 tool-gate/scope 产品 bug。原 `SCOPE_UNINITIALIZED` 回执只列 kind/tool，缺少 `new_scope_goal`/`new_scope_retention_budget` 与 resetScope 示例；schema t18 已补 `required` 与可执行的 `next`，并用窄测覆盖。新监控修复与下一轮均未观察，没有 Reviewer 纠正回执、审计、`s5-report.md` 或批准证据。
- **真实隔离 rS5 续测（2026-11-12，`herd-real-s1-14`，18.16.0；非验收）**：新 Git 副本 `herd-real-s1-14`（baseline `e25ad486...`，main clean，契约一致）恢复原 session（仅 header cwd），turn-aware harness 通过离线自检（同一回合兄弟调用不停止、后续回合同类停止、未知产品错误首停、全局上限 3 个 beat；r13 replay 已验证）。出站 `fork_slices` schema 四字段均存在且 required，探针未 abort。真实第一轮在父会话 `fork_slices` 的 `resetScope` 上被旧准入以 `SCOPE_INVALID` 拒绝：`scope.replacement is not allowed for resetScope`，data 的 allowed 只有 kind/new_scope_goal/new_scope_retention_budget。根 §5.3/§8.5.3 的 flat scope schema 声明了 `replacement` 且未禁止 resetScope 使用；错误在准入白名单，不是出站 schema。本轮没有任何 fork、worktree、子 worker 或兄弟回合实测；monitor 按首未知产品错误停止，现场保留。schema t19 修复后，r14 的原始 scope 离线通过，下一轮真实重测待测。
- **真实隔离 r22 观察（2026-11-12，`herd-real-s1-22`，18.16.0；非验收）**：真实 S5 主会话 `before_agent_start` 的 activeTools 为 `[ask_previous_scope, ask_user, assume, clj_plan, fork_slices, gc_worktrees, join_slice, realign_frozen]`；provider schema 为 `clj_plan` 提供完整 gate schema，随后宿主实际执行了 `clj_plan` 工具调用并返回 `CAPABILITY_DENIED`（`Symbol .getMessage is not available in the sandbox`），fork 未发生、无子 worker。该轮当时归类为“模型程序使用不可用 JS interop、尚未确认产品 bug”；runner t13 复核确认这是产品缺陷：S5 主会话/Coordinator 按根 §2.1/§4.2 不应拥有规划期 `clj_plan`，不是模型凭空输出或旧 surface 未切换。r22 仅删除了 `STAGE_SURFACES.s5` 的 `clj_plan` 常量并做了窄测（102 pass/763 expect），但 r23 证明该移除不足；根因修复仍在进行。
- **真实隔离 r23 观察（2026-11-12，`herd-real-s1-23`，18.16.0；非验收）**：新副本 `herd-real-s1-23`（baseline `9921420`，main sha `d04e2b2d...`，runner sha `5e0092d9...`）恢复原 session；S5 activeTools 仍为 `[ask_previous_scope, ask_user, assume, clj_plan, fork_slices, gc_worktrees, join_slice, realign_frozen]`，`clj_plan` 仍在，证明 r22 的常量移除不足以修复根因。`fork_slices` 在一次缺 gate 字段重试后成功，`slice-01/02/03` 有 handle，`slice-04` pending；启动 3 个子代理。首个错误是子代理 `clj_review` 的 `INVALID_ARGUMENT`（`ls expects an EDN map argument`，模型传了位置参数），该轮当时尚未确认是否为产品 bug，watchdog 按首错停止；没有 `join_slice`、S5 审计、`ask_user`、批准或验收。现场保留。当前源码可见两层改动：`STAGE_SURFACES.s5` 不含 `clj_plan`，且 `publishMission` 在 S5 把 `clj_plan` 追加到 `blockedTools`；Main 实际运行 `TMPDIR=... bun test tests/main-bootstrap.test.mjs` 为 48 pass/0 fail。但 r23 真实宿主仍暴露 `clj_plan`，这些改动是否真正解决尚未重测；runner 因中断取消，不能据此关闭本条。
- **仍未完成（保留，不关闭）**：
  1. **真实 S5 工具面风险与审计 end-to-end 未闭合**：r22/r23 均暴露 S5 activeTools 含 `clj_plan`；当前源码虽有 `STAGE_SURFACES.s5` 移除与 `publishMission.blockedTools` 追加两层改动、`main-bootstrap` 48 pass/0 fail，但 r23 真实宿主仍出现 `clj_plan`，真正根因与修复效果尚未重测。s1-13 成功 fork 3 个 worktree（slice-04 pending），但 Reviewer 并行兄弟调用被旧监控误判；turn-aware harness 已离线验证；r14 的 `resetScope.replacement` 与 r23 的首个 `clj_review`（`ls expects an EDN map argument`）都尚未完成真实闭环。没有真实 `runMissionAudit → startAuditBatch`、`Manual Auditor`、`submit_case_audit` 提交、汇总、`s5-report.md` 与一次性批准证据，手工验收未完成。
  2. **没有统一全量复测**：各组件报告为 stage-parsers/main-consumer 47 pass、stages-gate-tools/parsers/contract 67 pass、contract 38 pass、runner/main-bootstrap/s5-wiring 101 pass（r22 修复后 102 pass/763 expect）、Main 实跑 main-bootstrap 48 pass/0 fail、audit/scores 70 pass、sandbox-tools 60 pass（及组合 178 pass）；stage-parsers t16 另报告 stages-parsers+stages-gate-tools 32 pass/172 expect、main-bootstrap+main-consumer+stages-contract 89 pass/877 expect；t17 报告 stages-parsers+stages-gate-tools 34 pass/194 expect、main-bootstrap+main-consumer+stages-contract 89 pass/877 expect；stage-parsers t18 报告 stages-parsers+stages-gate-tools 37 pass/204 expect、连同 main-bootstrap/main-consumer/stages-contract 共 126 pass/1081 expect；schema t18 报告 scope 52 pass/190 expect、tool-gate 57 pass/282 expect；schema t19 报告 scope+tool-gate 111 pass/480 expect；lazy-fix t18 报告 evaluator 105 pass/728 expect、evaluator+regex-worker+sandbox-tools 178 pass/1095 expect；worktree t5 34 pass/230 expect；audit-isolation-review 的一次组合运行曾报告 2 个 `main-bootstrap` structured-realign `s3-modules mapped_cases` 断言失败，发生在并行的 main/contract 编辑期间，之后没有一份统一全量结果收口。
  3. **`realign_frozen` 表面未逐阶段断言**：已加入 `STAGE_SURFACES` 的 S2–S5，但窄测试只在 S5 场景实际调用；S2–S4 的 activeTools 集合没有独立断言。
  4. **重对齐/取消后的审计失效与观察者退休**：成功 realign 设置 `auditInvalidated`、Esc/接力后 `retireActor`/`retireSession` 已有源码路径，但没有独立断言。
  5. **真实宿主版本**：新控制态在真实 18.16.0 的 rS3 上已观察到 S1/S2 成功与 S3 缺陷，在 s1-7 上观察到 S2 模型内容错误与回执缺陷，在 rS4 上观察到 session 恢复、S3 成功与 S4 误拒，在 rS5 上观察到 S4 成功、S5 fork 半提交缺陷，在 s1-13 上观察到 3 worktree fork 成功与 Reviewer 并行调用被旧监控误杀，在 s1-14 上观察到 turn-aware harness 离线验证通过但 `resetScope.replacement` 被旧准入误拒，在 r22 上观察到 S5 activeTools 误含并执行 `clj_plan`，在 r23 上观察到该问题仍在且 fork 后首个 `clj_review` 因 `ls` 位置参数停止；S5 Reviewer 完成、审计、17.x/16.x 都未验证。
- **影响**：旧 Markdown CASE 解析与四段 contract-line 作为重建权威的路径已从源码移除；S1/S2 在 rS3 真实成功，S3 在 rS4 真实成功，S4 在 rS5 真实成功；S5 fork 的半提交缺陷已由 t5 修复，s1-13 成功 fork 3 个 worktree，但 Reviewer 并行调用被旧监控误杀；turn-aware harness 已离线验证，r14 的 `resetScope.replacement` 被旧准入误拒；r22/r23 的 S5 activeTools 均含 `clj_plan`，当前源码的 `STAGE_SURFACES.s5` 移除与 `publishMission.blockedTools` 追加尚未在真实宿主重测，真实 S5 工具面风险保留。S5 审计端到端无真实证据，不能声称已交付、S5 可用或验收通过。VFS 观察账本、真实 `$W$`/writeGate/termId 等 P0 项属于各自条目，不因本条迁移完成而关闭。
- **建议处理**：等待主真实 tmux 轮次；若它产生真实 `runMissionAudit → startAuditBatch` 与审计提交证据，记录现场路径与限制；随后跑一次统一全量套件并逐项核对上述断言。全部完成前保持本条打开；不得恢复 Markdown CASE 解析或双读兼容。
- **证据**：`src/stages/contract.mjs#FROZEN_KEYS`、`controlPaths`、`freezeStage`、`commitS2`、`saveS1Summary`/`saveS2Cases`、`readS1Summary`/`readS2Cases`、`buildContractLine`、`parseContractLine`、`verifyContract`、`realign`；`src/stages/parsers.mjs#normalizeCaseSpecs`、`validateS2`、`validateS3`、`validateS4`、`validateModuleCoverage`；`src/stages/gate-tools.mjs#advanceS1`、`advanceS2`、`advanceS3`、`advanceS4`、`validationFailure`、`realign`；`src/main.mjs#caseSpecsFor`、`runMissionAudit`、`realignEditedFrozen`、`finishBoardTask`、`STAGE_SURFACES.s5`、`publishMission.blockedTools`；`src/swarm/auditors.mjs#startAuditBatch` 的 live-hash 绑定；`src/swarm/board.mjs#validateDependencyPaths`、`normalizeWaitEntries`；`src/swarm/worktree.mjs` 的 uppercase slice 路径/分支/锁/状态与 fork 失败拓扑保留；`src/scope/ledger.mjs#SCOPE_UNINITIALIZED` 的 required/next 与 declared-field 准入；`src/clj-sandbox/tools.mjs` 的 `cases.edn` 角色边界。真实 rS3 现场 `/home/kunweiz/.cache/herd-real-s1-5-20261112-124245`：`logs/AI-OPERATOR-S1-S2-S3-STOP.json`、`logs/WATCHDOG-STOP.txt`、`copy/.herd/missions/mission-slug-791e6f/cases.edn`、`copy/plans/mission-slug-791e6f/s2-manual-tests.md`。s1-7 现场 `/home/kunweiz/.cache/herd-real-s1-7-20261112-125600`：`logs/AI-OPERATOR-S1-S2-STOP.json`、`logs/WATCHDOG-STOP.txt`、`copy/plans/mission-slug-9a836c/s1-brainstorm.md`。rS4 现场 `/home/kunweiz/.cache/herd-real-s1-8-20261112-130500`：`logs/AI-OPERATOR-RESUME-S3-SUCCESS-S4-STOP.json`、`logs/WATCHDOG-STOP.txt`、`copy/plans/mission-slug-791e6f/s3-dev-guide.md`、恢复后的 session JSONL。rS5 现场 `/home/kunweiz/.cache/herd-real-s1-9-20261112-131400`：`logs/AI-OPERATOR-RESUME-S4-SUCCESS-S5-FORK-STOP.json`、`logs/WATCHDOG-STOP.txt`、`copy/plans/mission-slug-791e6f/s4-coordination.md`、`copy/.herd/missions/mission-slug-791e6f/worktrees.edn`（只读现场，t5 复核）。s1-13 现场 `/home/kunweiz/.cache/herd-real-s1-13-20261112-135000`：`logs/AI-OPERATOR-R13-S5-FORK-SUCCESS-SAME-AGENT-SCOPE-STOP.json`、`logs/probe.jsonl`、`copy/.herd/artifacts/mission-slug-791e6f/slice-03/3a7341ea-df62-44c2-a7f6-00391873a3a1.jsonl`。s1-14 现场 `/home/kunweiz/.cache/herd-real-s1-14-20261112-140500`：`logs/AI-OPERATOR-R14-S5-SCOPE-REPLACEMENT-PRODUCT-STOP.json`、`logs/probe.jsonl`、`logs/r13-turn-replay.json`。r22 现场 `/home/kunweiz/.cache/herd-real-s1-22-dZtaEc`：`logs/AI-OPERATOR-R22-S5-STOP.json`、`logs/probe.jsonl`。r23 现场 `/home/kunweiz/.cache/herd-real-s1-23-b6fGFi`：`logs/AI-OPERATOR-R23-S5-STOP.json`、`logs/probe.jsonl`、`copy/.herd/missions/mission-slug-791e6f/worktrees.edn`。s1-6 的失败恢复现场保留。窄测数字来自 `agent://stage-parsers` t15/t16/t17/t18、`agent://worktree` t5、`agent://schema` t18/t19、`agent://runner` t13、`agent://lazy-fix` t16/t17/t18、`agent://coordination` t57/t58、`agent://runner` t9/t10、`agent://audit-isolation-review` t7，以及 Main 实际运行的 `TMPDIR=/home/kunweiz/.cache/herd-test-tmp bun test tests/main-bootstrap.test.mjs`（48 pass/0 fail；窄自动化，不是验收）。
