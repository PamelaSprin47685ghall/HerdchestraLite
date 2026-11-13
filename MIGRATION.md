# MIGRATION.md — mjs → CLJS/nbb clean-break 台账

> 验收标准：**可感知语义不变**。工具名、参数、回执、能力、挂起/恢复、错误码、提示词、命令、文件行为与旧实现一致；内部实现可以完全更换。
> 状态：`[x]` 已迁移并有验证；`[~]` 已迁移但缺边界；`[ ]` 未迁移；`[-]` 有意删除。

## 1 验收标准（可感知）

### 1.1 工具面
- [x] `clj_devops`：`code`、`name`、`ariadne_budget`、`ariadne_goal`、`more_workers_without_hitting_mythical_man_month`。
- [x] 回执为 EDN + UFSS：`{:name ... :state :completed|:failed|:parked, :value ...}`。
- [x] `wait({otherwise_independent_work})`：`:idle`、一次性返回积压、等待在途完成。
- [ ] `time_leap`、`ask_beacon`。
- [ ] `/clj-status`。
- [ ] 默认模式只暴露 `clj_devops` + `wait` + `time_leap` + `ask_beacon` + `/clj-status`。

### 1.2 能力
- [x] `cat`、`read`、`write`、`mkdir`、`rm`、`mv`、`ls`、`stat`（基础 fs）。
- [x] `where`、`whereAll`（精确切片；0/多匹配挂起，`unpark` 注入区间后继续）。
- [~] `call`（spawn + 超时；缺输出上限、日志、写锁）。
- [x] `park`、`unpark`、`abandon`（Promise 挂起；缺期限/多程序隔离）。
- [ ] `glob`。
- [ ] `write` 的 `stamp` 复核、写锁、失败保留已写部分语义。
- [ ] 审计员 `/tmp` 隔离语义。

### 1.3 会话语义
- [x] `name` 运行中唯一。
- [ ] 同一 `call-id` 重放与 `:CALL_REPLAY_MISMATCH`。
- [ ] `name` 完成后复用。
- [~] 期限：当前统一 30s 超时，未按字节数计算。
- [ ] `park` 时工具立即返回 `:state :parked`（当前等待到超时）。
- [ ] 多程序/后果自负的全局 ctx 行为说明。

### 1.4 输出
- [x] EDN 打印（`pr-str`）。
- [x] UFSS post-pass（最短 fence、裸多行、尾随闭合文本）。
- [x] UFSS pre-pass（单行/多行 fence → 标准字符串；宽容缩进与尾随闭合文本）。
- [x] `#"..."`、`#(...)`、`#?` 等官方 reader 语义（nbb 负责）。
- [ ] 语言尾注与 `UFSS_PROMPT_NOTE` 注入。

### 1.5 提示词与命令
- [ ] `COMMON_RULES_TEXT` 注入（`before_agent_start`）。
- [ ] `/clj-status`、`/herd-*`（完整装配）。
- [ ] Nudge、语言尾注。

### 1.6 完整装配
- [ ] `review` / `attach_*` / 看板 / S5 runner / K 路审计 / TUI。
- [ ] Ariadne 线程、Time Leap、Beacon。
- [ ] 写锁、stamp、events、checkpoint、恢复。

## 2 旧 mjs 语义去向

| 旧文件 | 关键语义 | 新位置 | 状态 |
|---|---|---|---|
| `src/clj-main.mjs` | 扩展入口、`activate` | `src/clj-main.mjs`（8 行） | [x] |
| 同上 | `registerCljTools`、工具注册 | `src/herd/main.cljs` | [~] |
| 同上 | worker 池、消息协议、park 查询 | `src/herd/repl.cljs` + `src/herd/sandbox.cljs` | [~] |
| 同上 | `wait`、`time_leap`、`ask_beacon`、`/clj-status` | 未迁移 | [ ] |
| 同上 | 提示词注入、语言尾注 | 未迁移 | [ ] |
| 同上 | native `read`/`write` 委托、跨进程写锁 | `herd/sandbox.cljs` 直接用 fs；锁未迁移 | [~] |
| `src/clj-sandbox/evaluator.mjs` | CEK 解释器、`where`/`park` 续体 | 由 nbb reader/eval + Promise 替代 | [-]/[~] |
| 同上 | 程序状态、`name` 唯一、期限 | `herd/repl.cljs` | [~] |
| 同上 | 错误码 `:CAPABILITY_DENIED`、`:STALE_CONTROL` 等 | nbb 异常 + 局部 `ex-info` | [~] |
| `src/clj-sandbox/tools.mjs` | 角色能力矩阵 | `herd/sandbox.cljs` + `herd/repl.cljs` prelude | [~] |
| 同上 | 工具 schema、回执渲染 | `herd/main.cljs` | [~] |
| `src/clj-sandbox/vfs.mjs` | `call` argv、输出上限、日志、取消 | `herd/sandbox.cljs`（基础 spawn） | [~] |
| `src/clj-sandbox/where.mjs` | 精确匹配、候选、最近行 | `herd/sandbox.cljs`（简化） | [~] |
| `src/clj-sandbox/glob-pool.mjs` | glob 并发 | 未迁移 | [ ] |
| `src/clj-sandbox/sandbox-worker.mjs` | Worker 宿主、停靠列表 | nbb 共享 ctx；worker 方案未落 | [ ] |
| `src/clj-sandbox/ufss.mjs` | EDN reader/writer | `herd/ufss.cljs`（reader 未迁移，writer 用 `pr-str`） | [~] |
| `src/clj-sandbox/{string-literal,walk-source,unwrap-fences,wrap-strings,await-suspends}.mjs` | UFSS 中间实现 | `herd/ufss.cljs` + `herd/macros.cljc` | [~] |
| `src/scope/ariadne.mjs` | Ariadne、Time Leap、Beacon | 未迁移 | [ ] |
| `src/scope/beacon-query.mjs` | `ask_beacon` | 未迁移 | [ ] |
| `src/stages/*.mjs` | review/attach/barrier/CASE/scores | 未迁移 | [ ] |
| `src/swarm/board.mjs` | 看板短事务、令牌 | 未迁移 | [ ] |
| `src/swarm/runner.mjs` | Reviewer ⇄ Swarm、接力 | 未迁移 | [ ] |
| `src/swarm/auditors.mjs` | K 路审计、提交落盘 | 未迁移 | [ ] |
| `src/tui/*.mjs` | 双态看板 | 未迁移 | [ ] |
| `src/host/*.mjs` | imports、native runner、hack context、health | 未迁移；nbb 直接 require Node | [ ] |
| `src/prompts/*.mjs` | COMMON、角色、尾注 | 未迁移 | [ ] |
| `src/main.mjs` | 完整装配 | 未迁移 | [ ] |
| `src/bootstrap-main.mjs` | 完整入口 | 未迁移 | [ ] |

## 3 迁移规则

1. 每迁移一项，先补齐本台账对应行与验收项，再改代码。
2. 不删除旧文件，直到其台账行全部 `[x]` 且有验证。
3. 语义冲突时以根 `AGENTS.md` 与「可感知语义不变」为准。
4. 每次提交记录：迁移项、验证命令、未覆盖边界。

## 4 当前验证

- `env -u BUN_OPTIONS bun test tests`：166 pass / 1 skip / 0 fail。
- 新增 `tests/cljs-sandbox.test.mjs`：CLJS/nbb 工具注册、EDN 回执、UFSS fence、`cat`、`where`、错误回执。
- 旧 evaluator/repl 测试已暂停：`tests/{clj-core,clj-core-eval,clj-core-wait,clj-workers,ariadne,ufss-where,repl}.test.mjs.disabled`。原因：绑定旧 CEK 解释器与 Cherry API；最终以 CLJS 测试替代，不恢复旧断言。
- `tests/sandbox-isolation.test.mjs` 的宿主包用例在 `~/node_modules/@oh-my-pi/pi-coding-agent` 缺失时跳过；其余 bwrap 用例继续运行。

## 5 已知偏差

- `wait` 的期限仍是固定 30s，未按 `1000ms + bytes × 50ms` 计算；超时不 park-all。
- `time_leap`、`ask_beacon`、`/clj-status`、提示词注入未迁移。
- 标准化错误码未迁移；`call` 的输出上限、日志、写锁未迁移。
- 旧 `src/*.mjs` 模块仍存在但不再由默认入口加载；最终删除。

## 6 人类批准记录（2026-11-13）

以下缩水/变更由人类操作员在迁移过程中明确批准，不得视为偷偷缩水：

1. 运行时由 `cherry-cljs` / `squint` 改为 `nbb`（Node 上的 SCI）；mjs 入口缩到宿主引导。
2. §4.1 的 Air-Gapped 符号表放宽为**基本防呆**：`nbb` 默认暴露 `js/` 与 `globalThis`，不承诺逃逸不可能；不主动注入 `process`/`require`/`fs`。剩余风险记入 `DEBT.md` D18。
3. UFSS 读取宽容化：闭合围栏允许尾随文本；body 短缩进不再报错。
4. UFSS 输出策略：多行 body 顶格、先 UFSS 再 pprint、`""",` 与后续 entry 同行。
5. `wait` 的期限暂为固定 30s；旧 evaluator/repl 测试暂停，最终以 CLJS 测试替代。
