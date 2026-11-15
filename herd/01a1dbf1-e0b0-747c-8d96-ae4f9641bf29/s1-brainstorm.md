# S1 头脑风暴：Session 即任务

## 第一性原理

抹平层这个类是一个柜台，插件这个类也是一个柜台，各自一次只服务一个人。台之间互不认识，没有公共依赖，各自持有状态。工单是函数；工单函数本身就是开单能力，调用方把它传进来就能用，不传就不能用。所有工单并发飞，到柜台前排队。没有协调者，也没有开单模块。与这句话有张力的设计一律废除。

## 0 结论先行

任务身份就是宿主 session 的 id。一个 session 当前 0 或 1 个任务；任务不能独立于它的 session 存在。不同 session 各自 0 或 1 个任务，互不认领；一个工作区可以同时有多个 session，但同一个 session 不会出现第二个任务。所有产物放在项目根的 `herd/<sessionId>/`。模型在任何工具、任何阶段都不填写 `slug`，也不选择、不切换任务。

默认启动不绑定任务，停在 devops 面。空 `/herd` 在 devops 与 herd 之间切换；`/herd <...>` 先切换，再把 `<...>` 当作切换后的用户输入。退出不销毁任务；再次进入恢复同一任务与阶段；进程重启按 session id 恢复这 0 或 1 个任务以及退出前的模式。

## 1 为什么现在要改

证据来自本机：

- 会话持久化文件是 `~/.omp/agent/sessions/<cwd>/<创建时间>_<uuid>.jsonl`，首行是 `{\"type\":\"session\",\"id\":\"<uuid>\"}`。本次重启后复用了同一个文件与同一个 id，说明 session id 跨进程稳定。
- 现有 `session-key` 先取 `ctx.agent.id`；主会话取到的是 `Main`，于是所有会话共用 `.herd/focus.edn` 的同一条记录，旧使命被静默认领。这是本次事故的直接原因。
- 现有 `mission.edn` 把 `slug`、`mission-id`、`:stage`、`tenure-seq`、`control-version` 写成可独立改写的第二套身份，和 session 分叉。
- 当前实现已停止顶层自动 focus：新会话不再因为使命目录存在而自动绑定；重启恢复尚未按 session id 重建，仍是本次设计要完成的部分。

结论：不再维护第二套身份与状态机，先把身份收敛到 session，再谈存储。

## 2 身份契约

1. 任务 id 等于宿主 `sessionManager.getSessionId()` 返回的 id（即会话文件首行的 uuid）。
2. 取不到 id、id 不是字符串、或 id 不是路径安全的（建议 `^[A-Za-z0-9._-]{1,128}$`）时，没有任务：停在 devops，拒绝进入 herd。不得回退到 `cwd`、`main`、agent 名或时间戳。
3. session id 只由插件读取，从不进入工具参数，也不要求模型回显。
4. 子代理 session 不拥有任务。父进程把自己的 session id 注入子会话；子会话的工具只按注入绑定解析，禁止从提示词正则抽取、禁止用子会话自己的 id。
5. 同一 session 永远只有一个任务。没有任务选择器，没有跨 session 认领，没有“补全选中”。

## 3 根布局

项目根只有一棵任务树：

```text
herd/<sessionId>/
  board.edn
  s2-cases.edn
  s1-brainstorm.md
  s2-manual-tests.md
  s3-dev-guide.md
  s4-coordination.md
  s4-coordination.pml
  s5-report.md
```

- 任务是否存在以会话日志的 `herd.task` custom entry 为准；`herd/<sessionId>/` 只是产物目录。日志有任务、目录缺失：任务仍在，产物报缺失；日志无任务、目录存在：孤儿产物，不认领。
- `.herd/`、`.herd/missions/<slug>/`、`.herd/focus.edn`、`plans/<slug>/` 全部退役。
- 控制事实（mode、seed、barrier、pending、approval）写进会话日志的 `type:"custom"` entry，不写 sidecar 文件：`appendCustomEntry` 追加、随会话文件持久化、不参与 LLM 上下文。
- 产物（看板、CASE、交付物）仍是文件；看板是可变的公共账，不能靠回放 tool result 重算。
- 服务台只做内存状态跃迁与 Promise 组合；`board.edn` 的异步落盘由工单负责，工单写完再 `resolve`。未落盘的内存变更视为未提交；宿主崩溃时以文件为准。
- 换任即丢弃旧看板：只保留当前 `board.edn`，不归档 `boards/`。
- 审计结果只在内存汇总；不写审计回执，不建 `audit/` 目录。最终 `s5-report.md` 顶部用 YAML frontmatter 保存结构化结果（每个 CASE 的 `case_id`、`user_score`、`developer_score`、`final`、`threshold`、`pass`）；正文保存报告全文。
- 子代理与主会话在同一个 `omp` 进程内：看板写由共享服务台的同步方法串行化，不需要跨进程 IPC 锁；文件原子写只用于崩溃保护。
- 交付物是用户要读的文件，默认应可提交；`board.edn` 属于运行账本，默认忽略。这是可逆决定，S2 可推翻。

## 4 模式开关

- 新 session：没有 `herd/<id>/`，工具面是 devops：`clj_devops`、`wait`；宿主编辑与 shell 工具被黑名单移除。人工压缩用宿主 `/handoff`，它不是模型工具。
- 第一次空 `/herd`：创建 `herd/<id>/` 并绑定这一 session 的唯一任务，进入 S1。
- 已绑定时空 `/herd`：追加 `herd.mode = devops` custom entry，离开 herd；目录、阶段、看板、交付物保留。
- 再次进入：读回同一任务，不新建目录，不重新 seed。
- `/herd <...>`：先完成上述切换，再把 `<...>` 作为切换后的用户输入投递。它不按文本另造任务，也不把文本当 slug。
- 进程重启：扫会话日志的 custom entries 恢复模式与任务；扫不到 herd 记录就没有任务，停在 devops。
- 退出 herd 不删除任务、不退休 tenure、不把任务交还成可被其他 session 认领的公共使命。

## 5 推导状态（不写第二套状态机）

- 当前阶段：没有 barrier 是 S1；最后一条 `herd.barrier` custom entry 的 `:to` 是当前阶段；`herd.approval` 与 `s5-report.md` 的摘要匹配则是已交付。
- 当前 tenure：barrier 条数加一。
- 不持久化可单独改写的 `:stage`、`:tenure-seq`、`:control-version`、`:mission-id`、`:slug`。
- 看板、CASE 数据集、交付物仍要落盘：它们是公共账与产物，不能从聊天或文件存在性重放。看板由工单负责异步落盘，服务台只改内存。结案凭证在会话日志 custom entry；审计回执不落盘，结构化结果写入 `s5-report.md` 的 YAML frontmatter，正文写报告全文。
- 模式位、seed、pending、barrier 必须写进会话日志的 custom entry：handoff 会切掉历史，正文推不回来；custom entry 不参与 LLM 上下文，但随会话文件持久化。

### 5.1 custom entry schema（v1）

- `herd.task`：`{v:1, sessionId, createdAt}`
- `herd.mode`：`{v:1, mode:"herd"|"devops", at}`
- `herd.seed`：`{v:1, seed, at}`
- `herd.barrier`：`{v:1, from, to, tenure, at}`
- `herd.pending`：`{v:1, stage, tool, callId, digest, path, at}`
- `herd.approval`：`{v:1, revision, reportSha256, token, at}`

同类型最后一条赢；未知版本 fail-closed；未知字段忽略。`data` 是 JSON 对象；不使用 EDN keyword/set。

### 5.2 s5-report.md frontmatter 与 approval

frontmatter 只放两组：

```yaml
cases:
  - case_id: CASE-1
    user_score: 90
    developer_score: 85
    final: 85
    threshold: 80
    pass: true
approval:
  revision: 3
  report_sha256: "..."
  token: "..."
```

正文放报告全文。`token` 绑定 `sessionId + revision + report_sha256`；摘要计算排除 `approval` 自身，避免自指。

## 6 工具面

- 任何工具都不声明 `slug` 字段。调用仍携带 `slug` 时，拒绝 `:INVALID_ARGUMENT`（`:slug-forbidden`），且不得拿它做绑定、覆盖或回退。
- `ask_user`、`devops`、`submit_devops_report`、`attach_*`、`review`、`board_*`、`attach_case_audit` 都从会话绑定解析任务；模型不传任务标识。
- `/herd` 不提供使命补全，不列出 slug。
- 子代理的提示词不写任务 id，也不用 `Mission slug:` 之类字段；父进程直接注入绑定。
- 工具回执只保留模型不知道且需要行动的信息：结果状态、必要错误、下一步。模型已提供的参数、已知的 session/任务信息、内部路径与台账一律不返回。

## 6.1 服务台与工单（host bridge）

两层服务台：抹平层、插件主体。服务台之间互不认识，没有公共依赖，各自持有状态。工单是 async 协程；工单函数本身就是开单能力，调用方把它作为参数传进来就能用，不传就不能用。没有协调者，也没有开单模块。

- **抹平层（服务台）**：有状态。持有捕获的 Runner、AgentSession、InteractiveModeContext、当前上下文快照、命令 runtime。方法必须是纯同步普通函数，禁止 `async`/`await`；依靠 JS 的 Run-to-Completion 天然互斥，不做异步排队，也不返回排队 Promise。只做状态跃迁与 Promise 组合或转交。
- **插件主体（服务台）**：有状态。方法同样必须是纯同步普通函数。调用方传入工单函数，它就能开单；没有传入就不能。它不知道抹平层的存在。
- **工单**：async 协程，唯一允许 `await` 的地方；局部状态在函数帧内，结束即消失；工单之间并发，不共享局部变量。
- **工单能力**：工单函数本身，通过参数注入。单跳可见性：上层工单只接收直接子工单能力；孙工单由接线层在子工单处绑定，不层层透传。

控制流：外部事件 → 抹平层门卫（同步翻译）→ 工单（async 协程，可并发）→ 服务台方法（同步、天然互斥）→ 工单 → 门卫 → 外部调用方。

依赖流：抹平层和插件不 import 任何公共工单模块；只按普通函数签名调用传入的工单函数。入口与接线创建服务台、注入外部能力与工单函数；接线只做机械动作，不做业务判断；否则成为影子前台。

服务台规则：

- 服务台方法必须是纯同步普通函数，禁止 `async`/`await`。
- 先完成全部自身状态变更，再在函数尾部调用工单函数（尾位置开单），防止工单的同步前缀看到半更新状态。
- 服务台只做状态跃迁与 Promise Manipulation（创建、组合、转交）；不 `await` 工单，不持有工单表、请求台账、事件队列或事件溯源。
- JS 单线程的 Run-to-Completion 提供天然互斥；不需要 CAS、锁、版本号或异步排队包装器。
- 工单是唯一允许 `await` 的位置：I/O、外部 API、`task`、shell、网络都在工单里等。
- 有返回值的事件：门卫同步完成状态更新后，返回工单 Promise 或组合 Promise（如 `Promise.all`）；外部调用方 `await`。
- 无返回值的事件：所有工单 fire-and-forget，必须挂 catch-all，错误在工单边界内记录，不逃逸为未捕获异常。
- 一个门卫可以开 0-N 张工单；开单数量与合并策略由门卫决定，接线不参与。
- 取消：工单自检服务台的 `epoch`/`aborted` 状态；需要打断慢 I/O 时，服务台持有领域级 `AbortController`，把 `signal` 传入工单；不建取消树，也没有“排队中的方法可取消”。
- 外部错误保持 string，插件错误用 `:error-name`，工单呈现，不混。

启动顺序：

1. 入口与接线创建抹平层与插件主体；两者互不认识。
2. 接线把外部能力注入服务台，把工单函数注入事件入口；按单跳依赖组装工单函数，并为无返回值工单挂 catch-all。
3. 调用抹平层的 `start()`；`start()` 向外部注册 hooks、工具、命令，门卫方法就位。
4. 外部事件进来，门卫同步翻译并开单；工单调服务台方法时同步调用，跨异步间隙用 `epoch`/`aborted` 自检。
5. 没有协调者、总线、邮箱、开单模块；工单函数就是能力。

门卫规则：

- 每种外部事件一个门卫方法，参数与返回形状按外部约定；不用一个巨大的 `handle(event)` 加 `kind` 分支。
- 门卫方法之间不互相调用；只同步翻译请求并调用工单函数。
- 门卫可以开 0-N 张工单：0 张表示吸收或无需处理；1 张是常见路径；N 张表示一个外部事件触发多个独立工单。有返回值时返回组合 Promise；无返回值时全部 fire-and-forget 并挂 catch-all。
- 门卫不判断业务路由；业务判断在服务台或工单里；接线不参与。

抹平层包含：

1. **上下文**：hackContext 的机械同步、出站消息追加、分支与增量；vibe mode 文案改写。
2. **原生工具**：直接调用外部工具（`read`、`write`、`task` 等）。不预检能力，盲调用；失败露出来。
3. **斜杠命令**：解析、查找、执行外部内置命令；给工单一个显式代理对象，代理怎么干活由工单与插件决定。
4. **注册桥**：把插件定义的工具与命令形状翻译成外部 `registerTool` / `registerCommand` 参数；注册动作在 `start()` 里完成。
5. **UI**：usage、状态行、working message、TUI 组件挂载等显示适配。
6. **内容语言识别**：highlight.js 语言检测。

抹平层不做：子代理启动器（工单直接调 `task`）、外部能力探测、取消树、外部错误映射、独立信号总线、邮箱或事件队列、事件溯源日志。

目录：`src/bridge/`、`src/herd/`；入口 `src/clj-main.mjs` 只装配。依赖检查：`src/bridge` 不 import `src/herd`；`src/herd` 不 import `src/bridge`；两边都不 import 公共工单模块（不存在）。

受控捕获记录到 `src/AGENTS.md`；§1.1 改为“受控例外集合”。
## 6.2 handoff 与换任屏障

- 保留一个 `handoff` 工具，但实现为包装外部 `/handoff`（抹平层能力）：工具只把交接说明或焦点交给命令代理，由外部 `/handoff` 执行；删除 `hack-context` 的 rewrite 分支。人工也可以直接执行 `/handoff`。
- `handoff` 工具的参数只保留必要字段；回执只返回 `:ok true :status :handoff-requested`，不返回内部路径、会话状态或模型已知信息。
- 宿主 `/handoff` 追加一条 `CompactionEntry`，同一 session、同一 transcript、同一缓存键；不物理删除历史，但保留最近消息，不是 tenure 屏障。
- 阶段/tenure 换任使用 `branch(parentId) + append(briefing)`：只切当前分支，旧 entry 留在文件里，不重写、不抹除。
- 禁止再用 `rewriteSession` 做换血；需要彻底压缩时由操作员执行宿主 `/handoff`。

## 7 致命假设与围栏

- A1：`getSessionId()` 跨重启稳定且每个会话唯一。已有会话文件与本次恢复作证据；S2 必须用两个并发会话与一次重启实测证伪。
- A2：session id 路径安全。取不到或格式不符就 fail-closed，不编码成 slug。
- A3：会话日志可被宿主 compaction 追加、被 shake/prune 改写 message，但 `type:"custom"` entry 不在 prune 候选里；控制事实只依赖 custom entry，不依赖 message 正文。
- A4：没有任何常驻进程依赖 `focus.edn`；删掉后默认启动不失败。
- A5：退出 herd 不是删除数据；追加 `herd.mode = devops` 即可，目录与产物保留。
- A6：宿主维护会主动重写历史。`session-maintenance.ts` 的 shake（images/thinking/tool results）与 #pruneStaleToolResults 都经 `rewriteEntries` 整文件替换；`rewriteEntries` 落到 `writeLinesAtomic(sessionFile, body.lines)`。因此转录不是权威状态来源；O(n) 回放只用于修复校验。
- 事前验尸：六个月后这套设计失败，最可能是“session id 在某个宿主版本变了”或“有人又加了第二个任务目录”。围栏分别是 A1 的实测与“目录不存在即无任务”的单点判据。

## 8 非目标

- 不做多任务工作区选择器；不做任务 slug；不做跨 session 认领或恢复。
- 不迁移旧 `.herd/missions` 数据，不静默认领旧使命；旧数据保留原地，由操作员决定去留。
- 不设计 worktree / slice 编排；S5 仍是单工作区。
- 本次不实现代码；只把决定与边界写进规格与债务。

## 9 进入 S2 的判据

S2 只需要证伪以下问题，不需要先写用例表：

1. 同一工作区两个并发 session 是否各自有独立的 `herd.task` 与产物目录，互不认领。
2. 一次进程重启是否按会话日志恢复任务、模式与阶段。
3. 任何工具携带 `slug` 是否被拒绝，且绑定不受影响。
4. 没有 `herd.task` 时，是否严格停在 devops 面。
5. 宿主 `/handoff`、compaction、shake/prune 之后，`herd.*` custom entry 是否仍在。
6. 同一条斜杠命令在 TUI、print、RPC、ACP、子代理五种后端下是否返回同一结构的结果；`handle` 命令是否完整执行，`handleTui` 命令是否只降级 UI。
7. `handoff` 工具是否包装外部 `/handoff`，且不再调用 `rewriteSession`。
8. 看板落盘是否由工单完成，服务台方法全程没有 `await`。
9. 同进程子代理是否共享服务台，看板写是否串行。
10. 审计结果是否只在内存汇总，`s5-report.md` frontmatter 与 approval token 是否绑定 `sessionId + revision + report_sha256`。

以上任何一条不成立，S1 的“session 即任务”就不成立，必须先改设计。

## 10 实施顺序与批准

用户已批准：S1/S2 不先改根规格；S5 先改 `AGENTS.md` 与相关局部规格，再做实施。

1. S2 按本文件实测；
2. S5 开始时先更新 `AGENTS.md` 与局部规格；
3. 删除旧控制态与布局（`.herd/missions`、`focus.edn`、`mission.edn`、`plans/<slug>`、`boards/`、`audit/`）；
4. 引入会话日志 custom entry、`herd/{sessionId}/` 产物、服务台/工单；
5. 迁移测试并收尾；S5 每次改服务台/工单/看板/取消，必须逐条对照 S4 Promela 的 safety/liveness 断言，不能只把模型当存档。