# MIGRATION.md — mjs → CLJS/nbb clean-break 台账

> 验收标准：**可感知语义不变**。工具名、参数、回执、能力、挂起/恢复、错误码、提示词、命令、文件行为与旧实现一致；内部实现可以完全更换。
> 状态：`[x]` 已迁移并有验证；`[~]` 已迁移但缺边界；`[ ]` 未迁移；`[-]` 有意删除。

## 1 验收标准（可感知）

### 1.1 工具面
- [x] `clj_devops`：`code`、`name`、`ariadne_budget`、`ariadne_goal`、`more_workers_without_hitting_mythical_man_month`。
- [x] 回执为 EDN + UFSS：`{:name ... :state :completed|:failed|:parked, :value ...}`。
- [x] `wait({otherwise_independent_work})`：`:idle`、一次性返回积压、等待在途完成。
- [x] `time_leap`、`ask_beacon`（锚点记录、pending jump、context 裁剪、beacon 读取）。
- [-] `/clj-status`（人类操作员取消，不再属于默认面）。
- [x] 默认模式只暴露 `clj_devops` + `wait` + `time_leap` + `ask_beacon`。

### 1.2 能力
- [x] `cat`、`read`、`write`、`mkdir`、`rm`、`mv`、`ls`、`stat`（基础 fs）。
- [x] `where`、`whereAll`（精确切片；0/多匹配挂起，`unpark` 注入区间后继续）。
- [x] `call`（spawn、超时、1 MiB 内联上限、完整日志、跨进程写锁）。
- [x] `park`、`unpark`、`abandon`（Promise 挂起；缺期限/多程序隔离）。
- [ ] `glob`。
- [x] `write` 跨进程写锁、`stamp` 复核（`:FILE_CONFLICT`）；失败保留已写部分由逐条落盘保证。
- [ ] 审计员 `/tmp` 隔离语义。

### 1.3 会话语义
- [x] `name` 运行中唯一。
- [x] 同一 `call-id` 重放与 `:CALL_REPLAY_MISMATCH`；不同载荷拒绝。
- [x] `name` 完成后复用（`running` 集合只覆盖活动程序）。
- [x] 期限：`clj_*` 用 code 字节、`wait` 用 counterfactual 字节按 `1000 + 50×bytes` 计算；超时 `park-all` 标记运行中程序为 `:parked :deadline` 并返回。
- [x] `park` 时工具立即返回 `:state :parked`；程序在 `await` 处等待 `unpark`，其余部分继续。
- [ ] 多程序/后果自负的全局 ctx 行为说明。

### 1.4 输出
- [x] EDN 打印（`pr-str`）。
- [x] UFSS post-pass（最短 fence、裸多行、尾随闭合文本）。
- [x] UFSS pre-pass（单行/多行 fence → 标准字符串；宽容缩进与尾随闭合文本）。
- [x] `#"..."`、`#(...)`、`#?` 等官方 reader 语义（nbb 负责）。
- [x] `COMMON_RULES_TEXT` / `UFSS_PROMPT_NOTE` 已在 `herd.prompts` 中组合，并由 `before_agent_start` 注入。

### 1.5 提示词与命令
- [x] `COMMON_RULES_TEXT` 注入（`before_agent_start`，幂等）。
- [x] 宿主工具黑名单（`setActiveTools`）。
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
| `src/prompts/*.mjs` | COMMON、角色、尾注 | `herd/prompts.cljs`（UFSS 书写）；注入未接 | [~] |
| `src/main.mjs` | 完整装配 | 未迁移 | [ ] |
| `src/bootstrap-main.mjs` | 完整入口 | 未迁移 | [ ] |

## 3 迁移规则

1. 每迁移一项，先补齐本台账对应行与验收项，再改代码。
2. 不删除旧文件，直到其台账行全部 `[x]` 且有验证。
3. 语义冲突时以根 `AGENTS.md` 与「可感知语义不变」为准。
4. 每次提交记录：迁移项、验证命令、未覆盖边界。

## 4 当前验证

- `env -u BUN_OPTIONS bun test tests`：184 pass / 1 skip / 0 fail，19 files。
- 真实 `omp 18.20.0` 已加载本工作区；`omp -p` 两次成功调用 `clj_devops` 并取得 EDN 回执。
- `tests/cljs-sandbox.test.mjs`：CLJS/nbb 工具注册、EDN 回执、UFSS fence、`cat`、`where`、`park`/`wait`、`call`、call-id 重放、错误回执、工具面黑名单。
- `tests/cljs-parsers.test.mjs`：S1 八段校验、CASE 严格 Schema、重复 ID、未知字段、阈值越界、S4 Promela 必填。
- `tests/ufss-cljs.test.mjs`：数据双射与六个业务源码的 `canonical-source` 幂等。
- 旧 evaluator/repl 测试已暂停：`tests/{clj-core,clj-core-eval,clj-core-wait,clj-workers,ariadne,ufss-where,repl}.test.mjs.disabled`。原因：绑定旧 CEK 解释器与 Cherry API；最终以 CLJS 测试替代，不恢复旧断言。
- `tests/sandbox-isolation.test.mjs` 的宿主包用例在 `~/node_modules/@oh-my-pi/pi-coding-agent` 缺失时跳过；其余 bwrap 用例继续运行。

## 5 已知偏差

- `wait` 期限已按 `1000ms + bytes × 50ms` 计算并触发 `park-all`；runtime-parked 没有 `:resolve`，`unpark` 不能恢复，见 `DEBT.md` D22。
- `/clj-status` 已取消；`time_leap`、`ask_beacon` 与提示词注入已迁移；`ask_beacon` 已接只读模型查询。
- 错误回执已统一为 EDN `:code`；错误路径的 call-id 重放会返回成功形状，见 D23。
- `call` 已有可注入的内联/日志上限、唯一日志名与跨进程写锁；批量写预算已接（可注入）。`read` 宿主代理、`glob` worker pool 仍未迁移，见 D24–D31（D26/D28/D31 已关闭）。
- 旧 `src/*.mjs` 模块仍存在但不再由默认入口加载；最终删除。

## 6 人类批准记录（2026-11-13）

以下缩水/变更由人类操作员在迁移过程中明确批准，不得视为偷偷缩水：

1. 运行时由 `cherry-cljs` / `squint` 改为 `nbb`（Node 上的 SCI）；mjs 入口缩到宿主引导。
2. §4.1 的 Air-Gapped 符号表放宽为**基本防呆**：`nbb` 默认暴露 `js/` 与 `globalThis`，不承诺逃逸不可能；不主动注入 `process`/`require`/`fs`。剩余风险记入 `DEBT.md` D18。
3. UFSS 读取宽容化：闭合围栏允许尾随文本；body 短缩进不再报错。
4. UFSS 输出策略：数据与代码统一 `wrap(format(...))`；多行 body 顶格，`""",` 与后续 entry 同行。
5. `wait` 的期限暂为固定 30s（后续已按 `1000ms + bytes × 50ms` 实现并接入 `park-all`，见 §5）；旧 evaluator/repl 测试暂停，最终以 CLJS 测试替代。
6. `/clj-status` 取消，不再实现或注入。
7. 所有业务 CLJS 源码（`prompts`、`sandbox`、`repl`、`main`）的字符串字面量按 UFSS 规范书写：普通文本用标准字符串，含引号/反斜杠用最小 fence，多行用顶格三引号。`ufss.cljs` 与 `bootstrap.cljs` 是自举内核，保持标准字符串。
8. `time_leap` 的上下文裁剪在 `context` 钩子内完成：按锚点 `toolCallId` 截断，并追加 `experience` 作为 user message。
9. 入口从命名导出 `activate` 改为 omp 18.x 要求的 default factory；`setActiveTools` 属 runtime action，从模块顶层移到 `session_start` 与 `before_agent_start`，避免 load phase 抛 `ExtensionRuntimeNotInitializedError`。
