# 已知缺口

## 运行时真实 S5 验收

- **规格**：AGENTS §2.6、§9.5。
- **缺口**：TicketStation clean-break 后的完整 S1→S5 使命与 K 路实操审计尚未在真实 `omp`/`tmux` 中重跑。
- **已有证据**：`omp/18.20.2` 扩展加载冒烟通过（`Working... ok`，无加载错误）；真实 tmux `/herd test` 已创建任务并生成 `herd/<sessionId>/board.edn`。证据见 `docs/manual-acceptance/clean-break/host-load-smoke-2026-11-15.md`。
- **历史记录**：`docs/manual-acceptance/clean-break/report.md` 是 clean-break 前记录，不能作为当前实现验收证据。
- **影响**：当前实现不能标记为已交付/已验收。
- **建议**：由人类操作员在真实 `omp`/`tmux` 中完成 S1 手工批准，按 `s2-cases.edn` 跑 K 路 Manual Auditor，汇总 `s5-report.md`。

## 宿主版本兼容性

- **规格**：AGENTS §1.2、§9.7。
- **缺口**：仅实测 `omp/18.20.2`；16.x/17.x 本机无二进制。
- **影响**：跨版本行为依赖能力探测与 fail-closed，未做真实版本矩阵。
- **建议**：在可用旧版宿主上重复加载冒烟与 S1 门禁路径；不改变当前 18.20.2 的验收结论。
