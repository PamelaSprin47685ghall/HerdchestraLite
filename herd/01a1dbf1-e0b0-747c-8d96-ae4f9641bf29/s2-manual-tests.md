# S2 手工测试方法论

## 目的

S2 不是写自动化测试，而是定义 S5 终局要亲手做哪些破坏性验证。Testing 不等于 Checking：单测、CI、构建、覆盖率只能说明代码能跑，不能证明用户拿到的行为对。

## 证据标准

每条 CASE 必须有可复现的真实证据：真实界面抓屏、会话日志行、磁盘快照、/tmp 破坏副本、错误回执。审计员的报告要能让另一个人照着重跑。

## 路径覆盖

至少覆盖正常、错误、边界、并发、恢复；适用时补安全、兼容、取消、乱序、性能、可访问性。禁止只有 happy path。

## 隔离

TUI 观察用专属 tmux 会话；破坏性、缺依赖、损坏配置的路径复制到 /tmp/herd-audit-<sessionId>-<case_id>-<uuid> 再破坏。主工作区只读。

## 双 WTP

每条 CASE 的 rubric 同时定义 user_score 与 developer_score，最终分取 min。Wow 折进两个分数；不需要真实用户证词。

## CASE 数据集

权威是 herd/{sessionId}/s2-cases.edn。s2-manual-tests.md 只写方法论，不定义可执行 CASE。CASE 字段严格为 case_id、path、threshold、steps、expected、rubric。

## 与 S1 十条判据的映射

CASE-01 并发 session 独立；CASE-02 重启恢复；CASE-03 slug 拒绝；CASE-04 无任务 devops；CASE-05 custom entry 幸存；CASE-06 跨后端命令同构；CASE-07 handoff 包装；CASE-08 看板工单落盘；CASE-09 同进程子代理共享服务台；CASE-10 审计 frontmatter 与 token；CASE-11 非法输入 fail-closed；CASE-12 取消与写入上限。
