# 已知缺口

当前无阻断 S1–S5 实现的缺口。

## 实现说明

- `src/herd/station.cljs` 是独立的不变量内核，已有 12 个测试；生产 board 适配仍由 `swarm/apply` 的两阶段事务承担。
- `/herd` 已优先经 `src/bridge/command-host.mjs` 的 `handleTui`；`system.cljs` 保留无全局工厂时的直连回退。
- `herd/01a1dbf1-e0b0-747c-8d96-ae4f9641bf29/s5-report.md` 是本仓库开发自审记录，不是人类 Auditor 的生产运行记录。
- 运行时真实 S5 使命仍需在 `omp` 中按 `s2-cases.edn` 手工审计；该运行不在本次实现范围内。
