# S3 开发指南

## 目标

把 S1 的身份契约落成可实施的结构：一个 session 至多一个任务，身份只来自宿主 session id；控制事实只进会话日志；产物只进 `herd/{sessionId}/`；服务台同步改状态，工单异步落盘。S3 只写指南，不改根规格；S5 一开始先改 `AGENTS.md` 与局部规格，再动代码。

## 模块边界

- `src/herd/`：插件主体。拥有任务、看板、门禁、审计、角色工具与业务状态。
- `src/bridge/`：抹平层。只做宿主适配：hackContext、原生工具（含 task）、斜杠命令、注册桥、UI、语言识别。它不认识任务、slug、看板或阶段。
- `herd/{sessionId}/`：用户可见产物目录。只由插件写，不靠目录存在性推导任务。
- 会话日志：控制事实唯一权威。`type:"custom"` entry 持久化，不参与 LLM 上下文。

依赖方向固定为：`host/util → bridge → herd → clj-main`。`bridge` 不 import `herd`；`herd` 只通过注入的接口调用 `bridge`，不直接碰宿主类。任何反向依赖或循环依赖视为设计缺陷。

## 身份与状态

- session id 从宿主 `sessionManager.getSessionId()` 取；空、非字符串、非路径安全即 fail-closed，不回退 `cwd`、`main`、agent 名或时间戳。
- 任务存在以会话日志的 `herd.task` 为准。日志有任务、目录缺失：任务仍在，产物报缺失；日志无任务、目录存在：孤儿产物，不认领。
- custom entry schema v1：`herd.task`、`herd.mode`、`herd.seed`、`herd.barrier`、`herd.pending`、`herd.approval`。同类型最后一条赢；未知版本 fail-closed；未知字段忽略。
- 阶段：无 barrier 即 S1；最后一条 `herd.barrier` 的 `to` 为当前阶段；tenure 等于 barrier 条数加一。不持久化可单独改写的 `:stage`、`:tenure-seq`、`:control-version`、`:mission-id`、`:slug`。
- 模式：`herd.mode` 最后一条为 `herd` 或 `devops`。退出只切模式，不删任务；再次进入恢复同一任务与阶段。

## 服务台与工单

服务台是同步的状态机：

- 所有方法同步返回新状态或直接修改内存，不出现 `async`/`await`。
- 先改完状态，再在尾位置开单；开单函数本身由参数注入，服务台不知道 Promise 实现。
- 工单是唯一允许 `await` 的地方。工单负责异步落盘、外部调用与等待；写完再 resolve。
- 未落盘的内存变更视为未提交；崩溃后以文件为准。
- 工单可以 0 到 N 个并发存在；服务台不维护协调者、总线、邮箱或事件溯源。
- 每个工单带 `epoch` 与 `aborted` 自检；取消信号通过参数传入，不建取消树。

看板事务：服务台内完成校验与状态计算；工单串行写 `board.edn`（同目录临时文件 + fsync + rename）；写完追加事件并更新检查点。看板写在单进程内由共享服务台串行化，不需要跨进程 IPC 锁。

## 工具面

- `Plan`：`clj_plan`、`devops`、`ask_user`（仅 S1）、`review`、`attach_*`。无 `write`、无 `call`。
- `Plan DevOps`：`clj_devops` + `submit_devops_report`。有 `write`、`call`、续体；无看板。
- `Reviewer`：`clj_review` + `review` + 初任空账的 `ask_user`。无写、无 `call`。
- `Swarm Worker`：`clj_worker`（无 `call`）+ `board_*`。
- `Swarm Holder`：同 Worker，另加 `call`。
- `Manual Auditor`：`clj_auditor` + `attach_case_audit`。只读主工作区，`call` 只用于 tmux 与 `/tmp` 副本。
- 所有工具 schema 不声明 `slug`；携带即拒绝，且不产生任何绑定或副作用。
- 工具回执只返回模型不知道的结果：状态迁移、错误、下一步；不返回模型已提供的参数、内部路径或完整台账。

## handoff

`handoff` 工具只做两件事：把自包含交接文档排队，返回占位回执。它包装外部 `/handoff`：追加 compaction entry，不调用 `rewriteSession`，不整文件重写历史。换任通过 `branch(parentId) + append(briefing)` 建立新上下文屏障；前任对话不可见。

## 审计

- `s2-cases.edn` 是 CASE 唯一权威；`s2-manual-tests.md` 只写方法论。
- K 个 CASE 同时启动 K 名审计员；每名只收到自己的 CASE 记录，不读整份数据集。
- 审计结果只在内存汇总，不写 `audit/`。最终 `s5-report.md` 顶部 YAML frontmatter 存 `cases[]` 与 `approval`；正文存报告全文。
- `approval.token` 绑定 `sessionId + revision + report_sha256`；摘要计算排除 `approval` 自身。全 PASS 才签发，任一 FAIL 转 board 返工。

## 迁移顺序（S5）

1. 先改 `AGENTS.md` 与局部规格：`herd/{sessionId}/`、custom entry、服务台/工单、无 `boards/`、无 `audit/`、无 `plans/<slug>/`、无 `focus.edn`。
2. 删除 `slug` schema 与 `resolve-slug` 参数优先；`/herd` 改为开关；删 `unique-slug!`、命令补全列 slug、`parse-auditor-context` 抽 slug。
3. 删除 `focus.edn`、`mission.edn`、`plans/<slug>`、`boards/`、`audit/` 的读写路径；旧数据保留原地，不认领。
4. 新建 `src/bridge/`，迁移 `hack-context`、`native-runner`、命令分发；加单向依赖检查。
5. `handoff` 包装外部 `/handoff`；删 `rewriteSession` 调用。
6. 精简工具回执；接入新的服务台/工单与看板落盘。
7. 跑 `env -u BUN_OPTIONS bun test tests --parallel`，按 CASE 做 S5 审计。

## CASE 映射

- CASE-01/02/04/11：`src/herd/system.cljs` 的身份、模式、重启与 fail-closed。
- CASE-03：`src/herd/stages/gates.cljs` 的 schema 与 `resolve-slug`。
- CASE-05/07：`src/host/hack-context.mjs` 与 `handoff` 包装。
- CASE-06：`src/bridge/command-host.mjs` 的跨后端结果。
- CASE-08/09：`src/herd/swarm/store.cljs` 与服务台/工单。
- CASE-10：`src/herd/stages/audit.cljs` 与 `s5-report.md`。
- CASE-12：`src/herd/sandbox.cljs` 的取消、上限与四分类。

## 验证

- 单元与交错测试保护内部不变量，但不构成 S5 验收证据。
- S5 按 `s2-cases.edn` 逐 CASE 在真实界面、真实日志、真实 `/tmp` 副本上执行。
- 每次改动后只跑能证明该改动的窄测试；收尾跑全量 `bun test tests --parallel`。

## S5 实施检查表

每次改服务台/工单/看板/取消，先对照 S4 Promela：服务台同步不重入、看板写串行、board_version 单调、过期 epoch 不 applied、aborted 不 applied、每个工单最终进终态、取消不重放。
