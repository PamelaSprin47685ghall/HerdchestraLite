# DEBT.md — 相对根规格的未关闭缺口

> 本文件只记录根 `AGENTS.md` 要求但当前工作区尚未做到的事项。关闭即删除；源码存在或窄测试通过不等于完成。当前设计以根 `AGENTS.md` 的 2026-11-13 生命周期修订与 §2.2–§2.6 为准。

## D0 默认面仍只有 clj 执行器

- **缺口**：`package.json` 的 `omp.extensions` / `pi.extensions` 只声明 `./src/clj-main.mjs`，注册 `clj_devops`、`wait`、`time_leap`、`ask_beacon` 与 `/clj-status`。`/herd`、`review`、`attach_*`、`ask_user`、`devops` 子代理、S1 人工确认、看板、K 路审计、TUI 均未装配。
- **影响**：当前产品只能验证执行器，不能执行 S1–S5 使命。
- **下一步**：按 §2.3 落地 `review` + `attach_*`，再恢复完整入口。

## D1 review + attach 生命周期尚未实现

- **缺口**：`src/stages/gate-tools.mjs` 仍是 `advance_s1..s4`；`submit_review` 只允许 S5；`normalizeFindings` 拒绝 `nil`；`finishStage` 把晋级、工具面切换与简报注入绑在一起。`src/stages/contract.mjs` 仍有 `freezeDocument`、`verifyContractPrefix`、`realign`。
- **设计**：`review` 的 findings 与 board 合一；空账只置 attach-ready；`attach_brainstorm` / `attach_manual_tests` / `attach_dev_guide` / `attach_coordination` 才写交付物、退休 tenure、写 barrier、启动 successor 并注入下一阶段简报。S1 只提交一个 markdown；S2 落 `s2-cases.edn`；S3 无 modules；S4 只收 `markdown + promela`（pml 不校验）。
- **影响**：当前源码与 SSOT 不一致，不能按新设计做真实 dogfood。
- **下一步**：先改 `gate-tools`、`contract`、`main`、`board` 与提示词；删除 `advance_*`、`:frozen`、`contract-line`、`realign`。

## D2 S5 单工作区编排尚未落地

- **缺口**：源码仍以 `fork_slices` / `join_slice` / worktree 为主路径；dogfood 设计要求单工作区、一个 Reviewer、一个 Swarm 看板，非空 findings `wake-all`，空账 + quiescence 后审计。`fork_slices` / `join_slice` / `gc_worktrees` / `abandon_slice` 暂不进 dogfood 面。
- **影响**：当前 S5 工具面、提示词与测试仍指向多 worktree，不能按新设计运行。
- **下一步**：S5 surface 改为单工作区；保留 `src/swarm/worktree.mjs` 为休眠代码，不接线、不注册。

## D3 真实宿主加载与端到端手工验收未完成

- **缺口**：`HACK.md` 记录 `omp plugin list` 指向 `/home/kunweiz/public/HerdchestraLite`，本工作区尚未证明被真实 `omp` 加载；没有真实 tmux 中的 S1→S5 小型使命，没有 `plans/<slug>/s5-report.md`，没有 `docs/manual-acceptance/clean-break/report.md`。
- **已有观察**：18.16.0 隔离副本曾观察到 S1 面板批准、S2 CASE 冻结、S3/S4 成功与 S5 fork；这些只覆盖旧 `advance` 面，且不是验收。
- **下一步**：重新 link 本工作区；按新 `review`/`attach` 生命周期跑最小使命（S1 人工批准 → S2–S4 自动 → 单工作区 S5 → K=1 审计）。证据写入 `docs/manual-acceptance/clean-break/`，不得用 `bun test` 代替。

## D4 S1 人工批准与新 attach 的接线未验证

- **缺口**：新 `attach_brainstorm` 需要在写盘后打开真实确认面板，`approve` 后 barrier，`revise` 清 attach-ready。当前 `advance_s1` 的面板与 pending 逻辑不能直接复用为 attach 语义。
- **下一步**：在真实宿主验证 approve / revise / pending / resume；面板必须展示磁盘上的 `plans/<slug>/s1-brainstorm.md`，不能只展示内存提交。

## D5 角色身份与宿主兼容

- **缺口**：角色收窄依赖 `ctx.agent`；17.x/16.x 未实测；`sessionFile` 父链在 17.3.5 无效，18.16 可兑现。当前 dogfood 面没有角色 admission。
- **下一步**：逐版本探测 `ctx.agent`；缺失时 fail-closed 并标 health degraded；不恢复独立 role-auth 注册表。

## D6 evaluator 限制

- **缺口**：`sequence`/`eduction` 物化受 200000 上限；`memoize` 线性扫描无上限/分桶；取消后的迟到结算只能诊断，不能自动归责；`call` pre-drain 无独立 watchdog，evaluator 无 drain 端口。
- **下一步**：把支持子集写进运行时提示；未支持组合返回明确错误；补上限或明确列为不支持。

## D7 全量测试矩阵与零剧透测试缺席

- **缺口**：未运行全量 `bun test` 并逐项核对 V01–V08、T01–T13、F01–F15；没有捕获真实出站 payload 的零剧透测试，也没有提示词工具名与注册表的一致性测试。
- **下一步**：先以窄测试保护新 `review`/`attach` 与单工作区 S5；真实出站夹具可用后再补零剧透行为测试。测试不是验收。

## D8 审计隔离与 S5 审计闭环

- **缺口**：`startAuditBatch`、`aggregate`、`writeS5Report` 已接线，但真实 `clj_auditor`、bwrap/tmux 隔离、`submit_case_audit`、全 PASS 报告与批准尚未跑通；旧设计中的 frozen 哈希复核已删除，需改为审计员自行观察工作区与 CASE 数据。
- **下一步**：在真实宿主用 `s2-cases.edn` 跑 K=1，再扩到 K>1；验证审计前后主工作区只读、证据路径、FAIL 返工与批准。
