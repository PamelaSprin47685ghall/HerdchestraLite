  # 已知缺口

## TicketStation clean-break

- **已落地**：`src/herd/station.cljs` 接线 S5 board；`swarm/apply.cljs` 删除；`swarm/board.cljs` 是同步门卫 + station 工单；`swarm/tools.cljs` 是同步门卫；`command_host.cljs` 同步返回 Promise；`station.cljs` 仅 `run-ticket` 为 `^:async`。
- **门卫已同步**：`system` 的 `gate-execute!`、`s5-review!`、`audit-execute!`、`invoke-service`、`before-agent-start!`、`session-start!`、`herd-command!` 均同步返回工单 Promise；`bridge/**` 无异步/await；`swarm/board` 与 `swarm/tools` 门卫同步。
- **剩余异步仅工单/端口/helper**：`station/run-ticket`；`stages/gates` 的 `review-ticket!`/`attach-ticket!` 等；`stages/{store,attach,review,report,audit}`；`swarm/{runner,auditors}`；`swarm/board` 的 `open-station-ticket!`；`system` 的 `*-ticket!`、端口、`ensure-*`、devops 辅助；`entry/main/bootstrap/lock_daemon/util` 的宿主/引导函数。它们承担 I/O，不再承担服务台/门卫职责。
- **静态验收**：`rg '\^:async' src/herd/station.cljs` 仅 `run-ticket`；`src/bridge` 无 async/await；旧 `apply-board!`/`execute-tool!`/`swarm.apply`/`Mission slug:` 无命中；`tests/cljs/architecture_test.cljs` 对上述规则、门卫同步、死代码 review 模块不存在与两个自举 mjs 做回归断言；`herd_mode_test.cljs` 与 `surface_test.cljs` 覆盖模式切换和角色表面。

## mjs→cljs

- **已落地**：生产 `.mjs` 只剩 `src/clj-main.mjs`（≤50 行，仅加载 cljs）；`tests/cljs-suite.test.mjs` 是唯一测试自举（11 行，≤50 行），激活与 fake clock 已迁到 `tests/cljs/harness.cljs`；已迁移 20+ 个 cljs 测试模块，当前 suite 231 pass / 0 fail；全量 `bun test tests --parallel` 231 pass / 0 fail / 1 file；`tests/cljs/architecture_test.cljs` 锁定 clean-break 静态不变量，`tests/cljs/herd_mode_test.cljs` 覆盖 `/herd` 切换后工具面回默认且任务保留，`tests/cljs/surface_test.cljs` 覆盖 Reviewer 面无 `ask_user` 且 `wait`/`handoff` 全局常驻，`tests/cljs/sandbox_limits_test.cljs` 覆盖 where/wait/streaming/limits；`tests/cljs/ticket_naming_test.cljs` 锁定门禁与开站工单的显式命名；`tests/cljs/gates_test.cljs` 覆盖 S1 pending 在服务重启后的同 call-id 恢复；`tests/cljs/subagent_entry_test.cljs` 覆盖宿主 `task` 工具、角色 token 与父 session 绑定；`tests/cljs/approval_test.cljs` 覆盖审批 token 的绑定与确定性；`tests/cljs/host_test.cljs` 覆盖宿主能力探测的 fail-closed 与布尔字段；`tests/cljs/bootstrap_contract_test.cljs` 覆盖入口 ≤50 行、默认 async 工厂、插件 nbb 与 bootstrap 加载 entry；`tests/cljs/session_log_test.cljs` 覆盖 `ensureOnDisk`/`flush` 生命周期。
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
- 运行时真实 S5 使命仍需在 `omp` 中按 `s2-cases.edn` 手工审计；`omp/18.20.2` 的扩展加载冒烟已通过（`Working... ok`，无加载错误），真实 tmux `/herd test` 已创建任务与 `herd/<sessionId>/board.edn`；完整 S1→S5 未重跑。`docs/manual-acceptance/clean-break/report.md` 是 clean-break 前历史记录，不能替代当前 TicketStation 实现的真实 S5 运行。
