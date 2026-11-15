# S4 开发者协调手册

## 并发模型

只有一个 omp 进程。主会话、子代理、审计员共享同一服务台与同一份看板内存。服务台方法同步、短小、无阻塞；工单异步落盘、调用外部能力、等待结果。服务台与工单之间没有总线、邮箱、事件队列或协调者：服务台在尾位置直接开工单，工单拿着参数自己跑。

## 工单状态

每个工单有 0 到 N 个并发实例，状态为 `pending`、`running`、`applied`、`failed`、`cancelled`、`unknown`。工单带 `epoch`；服务台每次状态跃迁递增 `epoch`。工单在写盘、`call`、等待外部结果前后自检 `epoch` 与 `aborted`；不匹配就停止，不把过期结果写回。

## 服务台规则

1. 先改完内存状态，再在尾位置开工单。
2. 服务台方法不允许 `async`/`await`；工单是唯一允许 `await` 的地方。
3. 看板写由工单串行化；同进程内不需要 IPC 锁。
4. 未落盘的内存变更视为未提交；崩溃后以 `board.edn` 为准。
5. 取消信号随参数传入；工单自检 `aborted`，已启动的外部副作用标 `cancelled` 或 `unknown`。
6. 错误分层：外部错误保持 string；插件错误用 `:error-name`；不混。

## 看板与落盘

看板是单工作区的公共账。`board_split`、`board_claim`、`board_finish` 等先在服务台内完成校验与状态计算，再由工单写 `board.edn`。写盘顺序：临时文件、fsync、rename；成功后追加事件并更新检查点。写失败保留旧文件；工单 resolve 失败，服务台保留内存状态供重试，但不声称已提交。

## 取消与崩溃

- 取消沿 `AbortSignal` 传播到参数、工单与外部调用；不建取消树。
- 取消发生在写盘前：标 `cancelled`，不写。
- 取消发生在写盘后：磁盘已变，标 `applied`，不假装没发生。
- 崩溃：`board.edn` 是权威；未落盘内存状态丢弃；恢复先读文件，不重放非幂等外部命令。

## 接线边界

- `src/bridge/` 只转发宿主事件：hackContext、原生工具、斜杠命令、注册桥、UI、语言识别。
- `src/herd/` 只通过注入接口调用 bridge；不直接 import 宿主类。
- 斜杠命令由 CommandHost 投影：`handle` 走 `SlashCommandRuntime`，`handleTui` 走 `InteractiveModeContext`；交互由插件决定，headless 用参数、默认值或 `:interaction-required`。
- `handoff` 只排队文档并返回占位；下一次 context 追加 compaction entry 或建立上下文屏障，不调用 `rewriteSession`。

## 安全不变量

- 同一时刻只有一个服务台事务在修改看板内存。
- 同一时刻只有一个工单在写 `board.edn`。
- 过期 epoch 的工单不能提交结果。
- 未落盘的内存变更不能作为完成证据。
- 取消后不自动重放非幂等写入。
- 审计员只读主工作区，只收到自己的 CASE 记录。

## Liveness

- 每个被受理的请求最终进入 `applied`、`failed`、`cancelled` 或 `unknown`。
- 每个工单最终 resolve 或 reject；不无限悬挂。
- 看板版本单调递增；每次已提交变更都让等待者可见。
- 取消或崩溃后，恢复路径不阻塞新请求。

## CASE 映射

- CASE-08：服务台无 await、工单落盘、崩溃以文件为准。
- CASE-09：同进程子代理共享服务台、看板写串行、无 IPC 锁。
- CASE-10：K 路审计只在内存汇总，frontmatter 与 approval token 绑定。
- CASE-12：取消传播、epoch 自检、写入上限与四分类。

## Promela 说明

`s4-coordination.pml` 把服务台、工单、看板与取消建模为有限状态；不运行 Spin、不做机器模型检查，但 S5 实施必须逐条遵守。模型省去文件 I/O 细节，保留同步服务台、异步工单、epoch 与看板版本的顺序关系。

## S5 实施纪律

Promela 不是存档。每次改服务台、工单、看板或取消路径，必须对照模型检查：

- `station_busy` 至多 1：服务台方法同步且不重入，看板写串行。
- `board_version` 单调递增；每次已提交变更对等待者可见。
- 过期 `epoch` 的工单只能进入 `failed`，不能 `applied`。
- `aborted` 后不产生 `applied`；取消后不重放非幂等写入。
- 每个被受理的工单最终进入 `applied`、`failed`、`cancelled` 或 `unknown`。

代码审查与 CASE-08/09/12 必须给出这些断言的逐条证据；不能只说“模型已保存”。
