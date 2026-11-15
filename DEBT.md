  # 已知缺口

## TicketStation clean-break

- **已落地**：`src/herd/station.cljs` 接线 S5 board；`swarm/apply.cljs` 删除；`swarm/board.cljs` 是同步门卫 + station 工单；`swarm/tools.cljs` 是同步门卫；`command_host.cljs` 同步返回 Promise；`station.cljs` 仅 `run-ticket` 为 `^:async`。
- **门卫已同步**：`system` 的 `gate-execute!`、`s5-review!`、`audit-execute!`、`invoke-service`、`before-agent-start!`、`session-start!`、`herd-command!` 均同步返回工单 Promise；`bridge/**` 无异步/await；`swarm/board` 与 `swarm/tools` 门卫同步。
- **剩余异步仅工单/端口/helper**：`station/run-ticket`；`stages/gates` 的 `review!*`/`attach!*` 等；`stages/{store,attach,review,report,audit}`；`swarm/{runner,auditors}`；`system` 的 `*-ticket!`、端口、`ensure-*`、devops 辅助；`entry/main/bootstrap/lock_daemon/util` 的宿主/引导函数。它们承担 I/O，不再承担服务台/门卫职责。
- **静态验收**：`rg '\^:async' src/herd/station.cljs` 仅 `run-ticket`；`src/bridge` 无 async/await；旧 `apply-board!`/`execute-tool!`/`swarm.apply`/`Mission slug:` 无命中；`tests/cljs/architecture_test.cljs` 对上述规则、门卫同步与两个自举 mjs 做回归断言；`herd_mode_test.cljs` 与 `surface_test.cljs` 覆盖模式切换和角色表面。

## mjs→cljs

- **已落地**：生产 `.mjs` 只剩 `src/clj-main.mjs`（≤50 行，仅加载 cljs）；`tests/cljs-suite.test.mjs` 是唯一测试自举（11 行，≤50 行），激活与 fake clock 已迁到 `tests/cljs/harness.cljs`；已迁移 20+ 个 cljs 测试模块，当前 suite 219 pass / 0 fail；全量 `bun test tests --parallel` 219 pass / 0 fail / 1 file；`tests/cljs/architecture_test.cljs` 锁定 clean-break 静态不变量，`tests/cljs/herd_mode_test.cljs` 覆盖 `/herd` 切换后工具面回默认且任务保留，`tests/cljs/surface_test.cljs` 覆盖 Reviewer 面无 `ask_user` 且 `wait`/`handoff` 全局常驻，`tests/cljs/sandbox_limits_test.cljs` 覆盖 where/wait/streaming/limits。
- **已清空**：`tests/` 只剩 `tests/cljs-suite.test.mjs`；`tests/fake-clock.mjs` 与 `tests/helpers/nbb-boot.mjs` 已删除；fake clock 与激活逻辑在 `tests/cljs/harness.cljs`。
- **验收**：生产与测试均只剩一个自举 `.mjs`，且均 ≤50 行。

## 测试自举行数约束（2026-11-15）

- `tests/cljs-suite.test.mjs` 当前 11 行，满足 ≤50 行。
- `tests/helpers/nbb-boot.mjs` 与 `tests/fake-clock.mjs` 已删除；suite 只做全局注入并加载 `tests/cljs/harness.cljs`。
- **验收**：两个自举均 ≤50 行，测试 mjs 已清空。

## 实现说明

- `src/herd/station.cljs` 已接线 S5 board 工具；`swarm/board.cljs` 经 station 工单持久化，`swarm/apply.cljs` 已删除。
- `/herd` 经 `src/bridge/command_host.cljs` 的 `handleTui`；`system.cljs` 保留无全局工厂时的直连回退。
- `handoff` 工具经 `src/bridge/command_host.cljs` 转交宿主 compaction；`hack_context` 只做机械追加，不再解码或替换历史。
- `herd/01a1dbf1-e0b0-747c-8d96-ae4f9641bf29/s5-report.md` 是开发自审记录，不是人类 Auditor 的生产运行记录。
- 运行时真实 S5 使命仍需在 `omp` 中按 `s2-cases.edn` 手工审计；该运行不在本次实现范围内。
