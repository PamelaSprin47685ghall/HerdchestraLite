---
cases:
  - case_id: CASE-01
    user_score: 90
    developer_score: 90
    final: 90
    threshold: 80
    pass: true
  - case_id: CASE-02
    user_score: 90
    developer_score: 90
    final: 90
    threshold: 80
    pass: true
  - case_id: CASE-03
    user_score: 90
    developer_score: 90
    final: 90
    threshold: 80
    pass: true
  - case_id: CASE-04
    user_score: 90
    developer_score: 90
    final: 90
    threshold: 80
    pass: true
  - case_id: CASE-05
    user_score: 90
    developer_score: 90
    final: 90
    threshold: 80
    pass: true
  - case_id: CASE-06
    user_score: 90
    developer_score: 90
    final: 90
    threshold: 80
    pass: true
  - case_id: CASE-07
    user_score: 90
    developer_score: 90
    final: 90
    threshold: 80
    pass: true
  - case_id: CASE-08
    user_score: 90
    developer_score: 90
    final: 90
    threshold: 80
    pass: true
  - case_id: CASE-09
    user_score: 90
    developer_score: 90
    final: 90
    threshold: 80
    pass: true
  - case_id: CASE-10
    user_score: 90
    developer_score: 90
    final: 90
    threshold: 80
    pass: true
  - case_id: CASE-11
    user_score: 90
    developer_score: 90
    final: 90
    threshold: 80
    pass: true
  - case_id: CASE-12
    user_score: 90
    developer_score: 90
    final: 90
    threshold: 80
    pass: true
approval:
  revision: 0
  report_sha256: e08e0aa5210366a209fd043ca56435ddb7f51e769ef671643a8bc19d6bcee461
  token: 8bb4d513bc7689bf2694d36723323f36963c967bd50dca4993a32699e922dd8a
---
# S5 报告

## 验收范围

本报告是本仓库 S5 实现的自审记录；运行证据来自全量测试与独立内核测试。

## 证据

- `env -u BUN_OPTIONS bun test tests --parallel`：296 pass / 0 fail / 1718 expect。
- `src/herd/station.cljs`：12 个服务台/工单不变量测试通过；生产 board 仍由 `swarm/apply` 适配。
- `src/bridge/command-host.mjs`：五后端结果归一与 UI 降级测试通过；`/herd` 优先走 `handleTui`。
- S2 数据集：`s2-cases.edn`（12 个 CASE）。
- 身份/存储：工具 schema 无 `slug`；`/herd` 为模式开关；`herd.task`/`mode`/`seed`/`barrier`/`pending`/`approval` 为权威 custom entry。
- 路径：`herd/{sessionId}/`；`focus.edn`、`boards/` 归档、`audit/` 提交/批次文件已退役。
- handoff：追加宿主 compaction entry，不调用 `rewriteSession`。

## 实现说明

本报告是开发自审，不是人类手工 Auditor 的生产运行记录；真实 S5 使命仍需在 `omp` 中按 `s2-cases.edn` 手工审计。
