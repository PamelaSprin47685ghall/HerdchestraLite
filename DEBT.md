  # 已知缺口

## TicketStation clean-break

- **已落地**：`src/herd/station.cljs` 接线 S5 board；`swarm/apply.cljs` 删除；`swarm/board.cljs` 是同步门卫 + station 工单；`swarm/tools.cljs` 是同步门卫；`command_host.cljs` 同步返回 Promise；`station.cljs` 仅 `run-ticket` 为 `^:async`。
- **剩余**：`src/herd/**` 仍有工单级 `^:async`/`await` 函数（`stages/gates.cljs`、`swarm/runner.cljs`、`swarm/auditors.cljs` 等），需要按 TicketStation 边界逐模块收口。
- **影响**：静态规则尚未全仓满足；`station.cljs` 自身已满足。

## mjs→cljs

- **已落地**：生产 `.mjs` 只剩 `src/clj-main.mjs`（≤50 行，仅加载 cljs）；`tests/cljs-suite.test.mjs` 是唯一测试自举（11 行，≤50 行），激活与 fake clock 已迁到 `tests/cljs/harness.cljs`；已迁移 20+ 个 cljs 测试模块，当前 suite 207 pass / 0 fail；全量 `bun test tests --parallel` 207 pass / 0 fail / 1 file。
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
