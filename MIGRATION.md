# MIGRATION.md — mjs → CLJS/nbb clean-break 台账

> 验收标准：**可感知语义不变**。工具名、参数、回执、能力、挂起/恢复、错误码、提示词、命令、文件行为与旧实现一致；内部实现可以完全更换。
> 状态：`[x]` 已迁移并有验证；`[~]` 已迁移但缺边界；`[ ]` 未迁移；`[-]` 有意删除。

## 1 验收标准（可感知）

### 1.1 工具面
- [x] `clj_devops`：`code`、`name`、`agent_state`、`more_workers_without_hitting_mythical_man_month`；`scope`/`turnsRemaining`/`todosRemaining` 已删除。
- [x] 回执为 EDN + UFSS：`{:name ... :state :completed|:failed|:parked, :value ...}`。
- [x] `wait({otherwise_independent_work})`：`:idle`、一次性返回积压、等待在途完成。
- [-] `time_leap`、`ask_beacon`：已删除，由 `handoff` 取代上下文换血。
- [-] `/clj-status`（人类操作员取消，不再属于默认面）。
- [x] 默认模式保留宿主工具并追加 `clj_devops` + `wait` + `handoff`（devops 面）；`/vibe` 主代理不干预；只有 `/herd` 使命与显式 herd 角色收窄。

### 1.2 能力
- [x] `cat`、`read`、`write`、`mkdir`、`rm`、`mv`、`ls`、`stat`（基础 fs）。
- [x] `where`、`whereAll`（精确切片；0/多匹配挂起，`unpark` 注入区间后继续）。
- [x] `call`（spawn、超时、1 MiB 内联上限、完整日志、跨进程写锁）。
- [x] `park`、`unpark`、`abandon`（Promise 挂起；期限由 `clj_*`/`wait` 控制）。
- [x] `glob`：受控 BFS，跳过 `node_modules`/`.git`/`.herd`，默认 20 000 条目 / 2 000ms 预算，超限返回 `:LIMIT_EXCEEDED`，不静默截断。
- [x] `write` 跨进程写锁、`stamp` 复核（`:FILE_CONFLICT`）；失败保留已写部分由逐条落盘保证。
- [x] 审计员只做防呆：`src/herd/swarm/auditors.cljs` 使用独立 `/tmp` 路径与不暴露 `write` 的角色面；`call` 可自由使用，是信任边界；不要求 bwrap。

### 1.3 会话语义
- [x] `name` 运行中唯一。
- [x] 同一 `call-id` 重放与 `:CALL_REPLAY_MISMATCH`；不同载荷拒绝。
- [x] `name` 完成后复用（`running` 集合只覆盖活动程序）。
- [x] 期限：`clj_*` 用 code 字节、`wait` 用 counterfactual 字节按 `2000 + 200×bytes` 计算；超时 `park-all` 标记运行中程序为 `:parked :deadline` 并返回。
- [x] `park` 时工具立即返回 `:state :parked`；程序在 `await` 处等待 `unpark`，其余部分继续。
- [x] 多程序/后果自负的全局 ctx 行为说明：同一 agent 同回合的 `clj_*` 调用按 tool bundle 串行排队，每个程序仍有独立上下文；未建立同身并行写通道。

### 1.4 输出
- [x] EDN 打印（`pr-str`）。
- [x] UFSS post-pass（最短 fence、裸多行、尾随闭合文本）。
- [x] UFSS pre-pass（单行/多行 fence → 标准字符串；宽容缩进与尾随闭合文本）。
- [x] `#"..."`、`#(...)`、`#?` 等官方 reader 语义（nbb 负责）。
- [x] `COMMON_RULES_TEXT` / `UFSS_PROMPT_NOTE` 已在 `herd.prompts` 中组合，并由 `before_agent_start` 注入。

### 1.5 提示词与命令
- [x] `COMMON_RULES_TEXT` 注入（`before_agent_start`，幂等）。
- [x] 工具面收窄（`setActiveTools`）：无使命不干预，使命/显式角色才收窄；旧宿主工具黑名单已删除。
- [x] `/herd`（完整装配）：创建 mission 与 `.herd/focus.edn`，把 seed 作为 user message 发送，进入 S1；`/clj-status` 与其他 `/herd-*` 已取消。
- [x] 语言尾注已接；Nudge 已接（空转提醒 + 上游断流退避）。

### 1.6 完整装配
- [x] `review` / `attach_*`：CLJS gate 服务（`review`/`attach_*`/`ask_user`/`devops`/`submit_devops_report`）、S1 四态确认端口、call-id replay、八工具注册定义与 `gates_host` JS 适配器已实现并有测试；`src/herd/system.cljs` 已注册八工具并注入 mission focus / S1 面板端口。真实宿主面板与 tmux 未验证（`DEBT.md` D4）。
- [x] 看板：`herd/swarm/{edn,model,ledger,actors,tasks,commands,token,kernel,store,apply}.cljs` 积木化实现；纯内核、令牌生命周期、文件锁、EDN 板、JSONL 事件、checkpoint 与两阶段 `take_or_die` 已由 `tests/cljs-board.test.mjs`（6）与 `tests/cljs-board-store.test.mjs`（5）覆盖。
- [x] `board_*` host 工具定义与注册：`herd/swarm/tools.cljs` 暴露 11 个 snake_case 工具，回执只投影 receipt；`tests/cljs-board-tools.test.mjs` 覆盖定义、claim/finish、split 版本守卫、take 重放。
- [x] S5 单工作区 runner 与 K 路审计：`herd/swarm/runner.cljs` 的 Reviewer ⇄ Swarm 接力、quiescence 屏障与 Nudge 已接线；`herd/swarm/auditors.cljs` 的 K 路审计、`.herd/missions/<slug>/audit/batch.edn` 幂等批次、FAIL 返工根任务与 `s5-report.md` 已接线并有测试。审计员隔离是防呆与信任边界，不要求 bwrap。
- [-] TUI 看板：按用户 2026-11-14 指令移除，覆盖根规格 §6.1；`src/tui/*` 保留但无 import/挂载，`tests/cljs-dashboard-wiring.test.mjs` 只断言从不挂载。
- [x] `stages/scores`、`stages/report`（`write-report!` 含 recheck 与批准端口）、`stages/audit`（`attach_case_audit` 持久化）已在 CLJS 层实现并有测试；`src/herd/system.cljs` 已注册 `attach_case_audit` 并注入批准端口。
- [-] Ariadne 线程、Time Leap、Beacon：已删除，由 `handoff` 取代。
- [x] 写锁、stamp、events、checkpoint、恢复：`herd/sandbox.cljs` 跨进程写锁与 `stamp`、`herd/swarm/store.cljs` 的 JSONL 事件/checkpoint、`herd/swarm/runner.cljs` 的恢复路径已实现并有窄测；真实重启恢复仍属 D3。

## 2 旧 mjs 语义去向

| 旧文件 | 关键语义 | 新位置 | 状态 |
|---|---|---|---|
| `src/clj-main.mjs` | 扩展入口、宿主适配、nbb 引导 | `src/clj-main.mjs`（唯一清单入口）+ `src/herd/bootstrap.cljs` | [x] |
| 同上 | `registerCljTools`、工具注册 | `src/herd/main.cljs` + `src/herd/system.cljs` | [x] |
| 同上 | worker 池、消息协议、park 查询 | `src/herd/repl.cljs` + `src/herd/sandbox.cljs` | [x] |
| 同上 | `time_leap`、`ask_beacon`、`/clj-status` | 删除；上下文由 `handoff` 承担 | [-] |
| 同上 | 提示词注入 | `herd/prompts.cljs` + `before_agent_start` | [x] |
| 同上 | 语言尾注/Nudge | `herd/prompts.cljs` + `herd/system.cljs` | [x] |
| 同上 | native `read`/`write` 委托、跨进程写锁 | `herd/sandbox.cljs`（异步 fs + 跨进程锁） | [x] |
| `src/clj-sandbox/evaluator.mjs` | CEK 解释器、`where`/`park` 续体 | 由 nbb reader/eval + Promise 替代 | [x] |
| 同上 | 程序状态、`name` 唯一、期限 | `herd/repl.cljs` | [x] |
| 同上 | 错误码 `:CAPABILITY_DENIED`、`:STALE_CONTROL` 等 | nbb 异常 + 局部 `ex-info`；回执统一 EDN `:code` | [x] |
| `src/clj-sandbox/tools.mjs` | 角色能力矩阵 | `herd/sandbox.cljs` + `herd/repl.cljs` prelude + `herd/system.cljs` 角色面 | [x] |
| 同上 | 工具 schema、回执渲染 | `herd/main.cljs` | [x] |
| `src/clj-sandbox/vfs.mjs` | `call` argv、输出上限、日志、取消 | `herd/sandbox.cljs`（异步 spawn、pipe 捕获、无落盘日志） | [x] |
| `src/clj-sandbox/where.mjs` | 精确匹配、候选、最近行 | `herd/sandbox.cljs`（1M cells / 150ms 最近行预算） | [x] |
| `src/clj-sandbox/glob-pool.mjs` | glob 并发 | `herd/sandbox.cljs`（受控 BFS；不保留并发池语义） | [x] |
| `src/clj-sandbox/sandbox-worker.mjs` | Worker 宿主、停靠列表 | nbb 共享 ctx；每程序独立上下文，不再保留 worker 停靠列表 | [x]（设计替代） |
| `src/clj-sandbox/ufss.mjs` | EDN reader/writer | `herd/ufss.cljs`（官方 reader + `pr-str` writer + fence） | [x] |
| `src/clj-sandbox/{string-literal,walk-source,unwrap-fences,wrap-strings,await-suspends}.mjs` | UFSS 中间实现 | `herd/ufss.cljs` + `herd/macros.cljc` | [x] |
| `src/scope/ariadne.mjs` | Ariadne、Time Leap、Beacon | 删除，由 handoff 取代 | [-] |
| `src/scope/beacon-query.mjs` | `ask_beacon` | 删除，由 handoff 取代 | [-] |
| `src/stages/*.mjs` | review/attach/barrier/CASE/scores | `herd/stages/{parsers,tenure,review,attach,gates,scores,report,audit,approval,mission,store,paths}.cljs` | [x]（真实宿主验收仍属 D3） |
| `src/swarm/board.mjs` | 看板短事务、令牌 | `herd/swarm/{edn,model,ledger,actors,tasks,commands,token,kernel,store,apply}.cljs` | [x]（内核/存储/两阶段取令/host 工具/runner 均已接） |
| `src/swarm/runner.mjs` | Reviewer ⇄ Swarm、接力 | `herd/swarm/runner.cljs`（单工作区；worktree 不接线） | [x] |
| `src/swarm/auditors.mjs` | K 路审计、提交落盘 | `herd/swarm/auditors.cljs`（隔离路径、批次幂等、FAIL 返工） | [x] |
| `src/tui/*.mjs` | 双态看板 | 保留未加载；用户指令移除看板 | [-]（指令移除） |
| `src/host/*.mjs` | imports、native runner、hack context、health | 保留为宿主适配层；`src/clj-main.mjs` 直接 import（`health` 仅旧 `bootstrap-main` 使用） | [x]（有意保留 JS） |
| `src/prompts/*.mjs` | COMMON、角色、尾注 | `herd/prompts.cljs`；系统提示词已由 `before_agent_start` 注入 | [x] |
| `src/main.mjs` | 完整装配 | `herd/main.cljs` + `herd/system.cljs`；旧文件保留未加载 | [x]（语义已接，旧文件待删） |
| `src/bootstrap-main.mjs` | 完整入口 | `src/clj-main.mjs` + `herd/bootstrap.cljs`；旧文件保留未加载 | [x]（语义已接，旧文件待删） |

## 3 迁移规则

1. 每迁移一项，先补齐本台账对应行与验收项，再改代码。
2. 不删除旧文件，直到其台账行全部 `[x]` 且有验证。
3. 语义冲突时以根 `AGENTS.md` 与「可感知语义不变」为准。
4. 每次提交记录：迁移项、验证命令、未覆盖边界。

## 4 当前验证

- `env -u BUN_OPTIONS bun test tests --parallel`：431 pass / 1 skip / 0 fail / 2041 expect / 432 tests / 44 files，约 16.2s。`tests/` 下没有 `.disabled` 文件；旧 Cherry/CEK 测试已删除并以 CLJS 测试替代；`tests/fixtures/s5-wiring-scenario.mjs` 已删除。
- 真实 `omp 18.20.0` 已加载本工作区；`timeout 120 omp -p '只回复 ok'` exit 0、wall 5.1s。该冒烟只证明扩展可加载与模型可调用，不是 S1–S5 验收。
- `HERD_TRACE=1` 的真实 `omp -p` 记录中没有 sync-ms > 200ms 的条目；性能窄测见 `tests/perf-hot-path.test.mjs`。
- `tests/cljs-sandbox.test.mjs`：CLJS/nbb 工具注册、EDN 回执、UFSS fence、`cat`、`where`、`park`/`wait`、`call`、call-id 重放、错误回执、工具面收窄。
- `tests/cljs-parsers.test.mjs`：S1 八段校验、CASE 严格 Schema、重复 ID、未知字段、阈值越界、S4 Promela 必填。
- `tests/cljs-report.test.mjs`：`write-report!` 的 PASS 写入、批准端口、recheck 拒绝与非 PASS 拒绝；`attach_case_audit` 的耐久提交、重复拒绝、CASE 错配，以及与 mjs `auditors.mjs` 的双向互读。
- `tests/cljs-gates.test.mjs`：review 开账/空账、attach 未就绪拒绝、S1 approve/revise/deny/pending、磁盘编辑后的批准、S2 晋级、call-id 重放、角色拒绝、八工具注册，以及 `ask_user` 的 S1 问答与禁止面、`devops` 端口报告。
- `tests/cljs-gates-host.test.mjs`：`gates_host/register!` 向宿主注册 JS 形状的八个工具，并通过真实 `execute` 执行 review。
- `tests/ufss-cljs.test.mjs`：数据双射与六个业务源码的 `canonical` 幂等。
- `tests/cljs-board.test.mjs` + `tests/cljs-board-store.test.mjs` + `tests/cljs-board-tools.test.mjs`：15 pass；覆盖 split/父项恢复与同回合守卫、claim/release、令牌竞争与无责退休、park/wake、条件等待、request_id 重放、文件板/事件/检查点、缺板拒重建、损坏板不覆盖、两阶段取令，以及 11 个 `board_*` 工具定义与 receipt。
- `tests/cljs-runner.test.mjs`：单工作区 Reviewer ⇄ Swarm 接力、槽位唤醒、写锁期间不轮转、恢复证据与空账处理。
- `tests/cljs-auditors.test.mjs`：K 路审计隔离路径、批次幂等（`.herd/missions/<slug>/audit/batch.edn`）、durable 提交复用、FAIL 返工根任务与汇总。
- `tests/cljs-system.test.mjs`：`/herd` 创建 mission/focus、S1 四态确认、角色面、Nudge、S5 runner/审计接线与 health 降级。
- `tests/cljs-handoff.test.mjs`：双锚点解码、先替换后追加、扫描窗口与 compaction 边界。
- `tests/cljs-usage.test.mjs`：delta 跟随最近活动子代理、sum 合并所有 agent key、100ms UI 合并。
- `tests/cljs-console-guard.test.mjs`：`console`/`js/console`/`globalThis.console`/`js/process.stdout`/`stderr` 拒绝、字符串与注释不误杀、`call` pipe 捕获不写宿主流。
- `tests/cljs-dashboard-wiring.test.mjs`：`install!`、`session-start!` 与 `/herd` 均不挂载看板，`system/state` 无 dashboard 键。
- `tests/perf-hot-path.test.mjs`：5MB probe off、1000 条 context、1000 次 message_update、1MB `where`、20k `glob`、500ms 锁超时、2 MiB `cat`、100 次 `write`。
- 旧 `tests/sandbox-isolation.test.mjs` 的 bwrap 用例保留为历史代码，不是当前规格或验收要求。

## 5 已知偏差

- `wait` 期限已按 `2000ms + bytes × 200ms` 计算并触发 `park-all`；deadline park 保留后台程序 Promise，`unpark` 可通过 `await-resumed` 重新等待并取回结果；`:recoverable false` 只表示没有表达式级可编辑续体，不表示必须 `abandon`；setsid 逃逸后代不在范围内。
- `tests/cljs-abandon.test.mjs`：3 pass；覆盖进程组击杀（含孙进程）、runtime-parked 清理、tracked 程序不复活。
- `/clj-status` 已取消；`time_leap`、`ask_beacon` 已删除，由 `handoff` 承担上下文换血；提示词注入已迁移。
- 错误回执已统一为 EDN `:code`，失败路径的 call-id 重放原样返回。
- `call` 已有可注入的内联/日志上限、唯一日志名与跨进程写锁；批量写预算已接（可注入）。`read` 代理宿主 native；`write` 全异步；`glob` 用受控 BFS（跳过 `node_modules`/`.git`/`.herd`，20 000 条目 / 2 000ms 预算）；`where` 最近行 1M cells / 150ms；`cat` 与 `write` 单文件 2 MiB。这些是性能边界，不是未完成项。
- `console`、`js/console`、`globalThis.console`、`js/process.stdout`、`js/process.stderr` 等直接访问在 `guard-source!` 处返回 `:CAPABILITY_DENIED`；字符串、注释与 UFSS fence 中的同名词不误杀。`call` 用 pipe 捕获 stdout/stderr，但不落盘日志。
- 性能诊断开关默认关闭：`HERD_CACHE_PROBE=1` 才写 `.herd/cache-probe.jsonl`；`HERD_TRACE=1` 才写 `.herd/perf-trace.jsonl`（1 MiB 上限）。`HERD_TRACE`/`HERD_CACHE_PROBE` 的 `*_PATH` 可改路径。
- usage 面板的 delta 显示最近活动子代理的最后一次请求，sum 合并所有 agent key；主会话请求不会把 delta 抢回主会话。
- TUI 看板按用户 2026-11-14 指令整体移除：`src/tui/*` 保留但无 import/挂载；`tests/cljs-dashboard-wiring.test.mjs` 只断言从不挂载。根规格 §6.1 看板要求被该指令覆盖。
- vibe 工具面：无使命主会话与无收窄角色的普通子代理保留全部宿主工具并追加 `clj_devops`/`wait`/`handoff`（devops 面）；`/vibe` 主代理不干预；旧宿主工具黑名单已删除；只有使命内主会话按阶段、显式 herd 角色按角色收窄。
- 启动与安装单例：并发激活共享 `globalThis.__herdBootPromise`，失败清空可重试；`contextPis`、`activated-pis`、`installed-pis` 是 per-pi `WeakSet`，同进程多 pi 各自只安装一次。`tests/cljs-system-install.test.mjs`、`tests/clj-main-trace.test.mjs` 覆盖。
- context 自动重写：每会话分支最多一次（host leaf 变化后重置预算），之后 prefix miss 只记录 `prefix-miss-suppressed`，boundary 存在时不重写；`tests/hack-context-rewrite.test.mjs` 覆盖。
- 真实 S1→S5 手工验收未完成，用户已暂停 dog food；没有 `plans/<slug>/s5-report.md` 与 `docs/manual-acceptance/clean-break/report.md`，不得把 431 pass 或 `omp -p` 冒烟写成验收。
- 旧 `src/*.mjs` 模块仍存在但不再由默认入口加载；最终删除。
- Ariadne/Time Leap/Beacon 已删除；未进入使命时主会话与普通子代理保留全部宿主工具并追加 `clj_devops`/`wait`/`handoff`（devops 面），`/vibe` 主代理不干预；进入使命后按阶段收窄为 `review`/`attach_*`/`ask_user`/`devops`，子代理按角色收窄为 `clj_devops`+`submit_devops_report`、`review`、11 个 `board_*`、`attach_case_audit`。`handoff` 是唯一上下文换血入口。
- 语言尾注、系统提示词受管区与 Nudge（空转提醒 + 上游断流退避）已接；S1 四态确认面板在真实宿主的键盘/滚动行为仍属 D4。

## 6 人类批准记录（2026-11-13）

以下缩水/变更由人类操作员在迁移过程中明确批准，不得视为偷偷缩水：

1. 运行时由 `cherry-cljs` / `squint` 改为 `nbb`（Node 上的 SCI）；mjs 入口缩到宿主引导。
2. §4.1 的 Air-Gapped 符号表放宽为**基本防呆**：`nbb` 默认暴露 `js/` 与 `globalThis`，不承诺逃逸不可能；不主动注入 `process`/`require`/`fs`。剩余风险记入 `DEBT.md` D18。
3. UFSS 读取宽容化：闭合围栏允许尾随文本；body 短缩进不再报错。
4. UFSS 输出策略：数据与代码统一 `wrap(format(...))`；多行 body 顶格，`""",` 与后续 entry 同行。
5. `wait` 的期限暂为固定 30s（后续已按 `2000ms + bytes × 200ms` 实现并接入 `park-all`，见 §5）；旧 evaluator/repl 测试暂停，最终以 CLJS 测试替代。
6. `/clj-status` 取消，不再实现或注入。
7. 所有业务 CLJS 源码（`prompts`、`sandbox`、`repl`、`main`）的字符串字面量按 UFSS 规范书写：普通文本用标准字符串，含引号/反斜杠用最小 fence，多行用顶格三引号。`ufss.cljs` 与 `bootstrap.cljs` 是自举内核，保持标准字符串。
8. `time_leap` 的上下文裁剪在 `context` 钩子内完成：按锚点 `toolCallId` 截断，并追加 `experience` 作为 user message。
9. 入口从命名导出 `activate` 改为 omp 18.x 要求的 default factory；`setActiveTools` 属 runtime action，从模块顶层移到 `session_start` 与 `before_agent_start`，避免 load phase 抛 `ExtensionRuntimeNotInitializedError`。

10. 2026-11-14：`$$$` 折叠加入“单行且不超过 40 字符正常渲染”例外。
11. 2026-11-14：删除 Ariadne/Time Leap/Beacon 机制，`handoff` 取代；根规格同步。
12. 2026-11-14：批准同步根规格 §0.2/§0.4/§1.3/§4.2/§4.7/§5/§6.1/§8/§9.1 等 6 组欠账。
13. 2026-11-14：用户指令整体移除 TUI 看板（覆盖根规格 §6.1）；批准 `console`/`js/process.stdout|stderr` 等直接访问的沙箱防呆（`guard-source!` 返回 `:CAPABILITY_DENIED`）；批准 5s UI 卡顿修复引入的性能边界（锁等待默认 500ms，`HERD_LOCK_WAIT_MS` 可调 50–5000ms；`glob` 20k/2s、`where` 1M/150ms、`cat`/`write` 2 MiB、`HERD_TRACE`/`HERD_CACHE_PROBE` 默认关闭）。真实验收仍暂停，未写入完成。
