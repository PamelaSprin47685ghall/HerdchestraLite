# Herdchestra Lite

Herdchestra Lite 是面向 `omp` 终端宿主的轻量多智能体研发插件。完整规格（S1–S5、门禁、看板、K 路审计）在仓库根 `AGENTS.md` 中；当前实现已把完整装配接到唯一清单入口，默认启用。

> **当前状态：完整装配默认启用，真实端到端验收未完成。** 清单入口 `src/clj-main.mjs` 通过 `src/herd/bootstrap.cljs` 加载 `src/herd/main.cljs` 与 `src/herd/system.cljs`，注册 `clj_devops`、`wait`、`handoff`、八个门禁工具、11 个 `board_*` 与 `attach_case_audit`；`/herd <seed>` 创建使命并进入 S1。S1 是唯一手工批准门禁，S2–S4 由 `attach_*` 自动晋级，S5 走单工作区 Reviewer ⇄ Swarm 与 K 路审计。
>
> **TUI 看板面板已按用户 2026-11-14 指令整体移除，不再挂载。** `src/tui/*` 只是保留代码；`src/main.mjs` 仍引用它，但清单入口不加载 `src/main.mjs`。`tests/cljs-dashboard-wiring.test.mjs` 明确断言 `install!`、`session-start!` 与 `/herd` 都不挂载看板。
>
> 真实 tmux 中的 S1→S5 手工验收尚未完成（`DEBT.md` D3）；没有 `plans/<slug>/s5-report.md`，没有 `docs/manual-acceptance/clean-break/report.md`。不得把测试或冒烟写成验收。
>
> 唯一规格仍是根 `AGENTS.md`；未关闭缺口在 `DEBT.md`；宿主与依赖实测在 `HACK.md`；架构装配笔记在 `src/AGENTS.md`。本 README 只描述当前可核对的事实。

## 当前启用面

- **清单入口**：`package.json` 的 `omp.extensions` / `pi.extensions` 都只声明 `./src/clj-main.mjs`。该入口启动 nbb，加载 `src/herd/bootstrap.cljs`，再由后者加载 `src/herd/main.cljs` 与 `src/herd/system.cljs`。并发激活共享 `globalThis.__herdBootPromise`，启动失败会清空该 promise 以便重试；`contextPis`、`activated-pis` 与 system 的 `installed-pis` 都是 per-pi `WeakSet`，同一进程里的多个 pi 各自只安装一次。
- **运行时依赖**：`nbb@1.6.215`、`@chrisoakman/standard-clojure-style@0.29.0`、`highlight.js@11.12.0`（仅内容语言识别；高亮仍由宿主 native 高亮器完成）。
- **工具面（插件共注册 23 个）**：
  - 沙箱与上下文：`clj_devops`、`wait`、`handoff`。
  - 门禁：`review`、`attach_brainstorm`、`attach_manual_tests`、`attach_dev_guide`、`attach_coordination`、`ask_user`、`devops`、`submit_devops_report`。
  - 看板：`board_split`、`board_claim`、`board_finish`、`board_cancel`、`board_replace`、`board_release`、`board_reopen`、`board_comment`、`board_update`、`board_park_slot`、`board_take_or_die`（11 个）。
  - 审计：`attach_case_audit`。
- **工具面归属**：进入使命前的默认面见上方 vibe 说明。进入 `/herd` 使命后，主会话按阶段收窄：S1 为 `review`/`attach_brainstorm`/`ask_user`/`devops`；S2 为 `review`/`attach_manual_tests`/`devops`；S3 为 `review`/`attach_dev_guide`/`devops`；S4 为 `review`/`attach_coordination`/`devops`；S5 为 `review`/`ask_user`；结案后为空。
- **子代理角色面**：`Plan DevOps` 得到 `clj_devops` + `submit_devops_report`；`Reviewer` 得到 `review`；`Swarm Worker`/`Swarm Holder` 得到 11 个 `board_*`；`Manual Auditor` 得到 `attach_case_audit`；`Blocker Oracle` 只有 `yield`。角色由宿主 `ctx.agent` 与首行 `[HERD_ROLE: ...]` token 共同判定；缺失时 fail-closed 并记 health degraded。
- **命令 `/herd <seed>`**：创建 `.herd/missions/<slug>/mission.edn` 与看板，写 `.herd/focus.edn`，把 seed 作为 user message 发送，并进入 S1。slug 由 seed 归一化且在同工作区内唯一。
- **S1 手工批准**：`attach_brainstorm` 先写 `plans/<slug>/s1-brainstorm.md`，再阻塞打开确认面板；面板从磁盘读取完整字节，支持滚动，默认选中拒绝，左右/Tab 显式选择批准/修改/拒绝，Enter 确认，Esc 取消。approve / revise / deny / pending 四态都有回执；`deny` 转 `ask_user` 语义，文件不可读或无自定义 UI 时 pending/拒绝批准。
- **S2–S4 自动晋级**：`attach_manual_tests` 写入 `s2-manual-tests.md` 与 `s2-cases.edn` 并退休 S2 tenure；`attach_dev_guide` 写入 `s3-dev-guide.md`；`attach_coordination` 写入 `s4-coordination.md` 与未勾选的 Promela 模型；每次晋级读取下一阶段简报。
- **S5 单工作区**：`src/herd/swarm/runner.cljs` 启动 Reviewer，经共享看板与 Reviewer ⇄ Swarm 接力推进；不接 worktree，不 fork 多工作区。quiescence 屏障、Nudge 与恢复路径已接线。
- **K 路审计**：`src/herd/swarm/auditors.cljs` 为每个 CASE 建独立 `/tmp/herd-audit-<slug>-<case>-<batch>` 隔离路径，汇总后写 `s5-report.md`；批次状态在 `.herd/missions/<slug>/audit/batch.edn` 幂等（`:running`/`:pass` 直接复用，`:repair` 开新批次，`:pending` 复用 durable 提交），FAIL 会写 repair 根任务。真实 bwrap/tmux 隔离未验证（D8）。
- **TUI 看板**：已按用户指令移除，不挂载、不创建 `herdchestra-dashboard` widget，`system/state` 无 dashboard 键。
- **不用 `/herd` 就是 devops 面**：没有使命时，主会话与普通子代理保留全部宿主工具，并追加 `clj_devops`、`wait`、`handoff`；不删除任何宿主工具。**`/vibe` 主代理除外：完全不调用 `setActiveTools`，宿主原生 vibe 工具面原样保留。** 只有使命内的主会话按阶段收窄，显式 herd 角色按角色收窄；收窄失败只记 health degraded，不静默删工具。
- **沙盒 console/stdio 防呆**：`src/herd/repl.cljs` 的 `guard-source!` 在用户代码执行前拒绝 `console`、`js/console`、`globalThis.console`、`js/process.stdout`、`js/process.stderr`、`process.stdout`、`process.stderr` 与 `(.-stdout js/process)` 等直接访问，返回 `:CAPABILITY_DENIED`（`:reason :console-or-stdio-forbidden`）。字符串、字符字面量、注释与 UFSS fence 中的同名词不误杀；`call` 仍用 pipe 捕获 stdout/stderr，日志写 `.herd/artifacts/call/`。这只是防呆，不是安全隔离。
- **性能边界（有意限制，不是未完成）**：写锁默认等待 500ms（`HERD_LOCK_WAIT_MS` 可调 50–5000ms；10ms 起指数退避、封顶 160ms），超时 `:LOCK_BUSY`（`:retryable true`）；`glob` 跳过 `node_modules`/`.git`/`.herd`，默认 20 000 条目 / 2 000ms 预算，超限 `:LIMIT_EXCEEDED`；`where` 最近行 DP 1 000 000 cells + 150ms deadline；`cat`/`write` 单文件 2 MiB；handoff 扫描只回看最近 512 条消息、文档窗口 32 条；usage/status UI 100ms 合并。
- **context 自动重写**：同一会话分支最多自动全量重写一次（host leaf 变化后重置预算）；其后的 prefix miss 只记录 `prefix-miss-suppressed`，不再次重写；compaction/reset boundary 存在时一律不重写。
- **诊断开关**：`HERD_TRACE=1` 启用热路径计时并写 `.herd/perf-trace.jsonl`（1 MiB 上限；`HERD_TRACE_PATH` 可改路径）；`HERD_CACHE_PROBE=1` 才启用 `before_provider_request` probe 并写 `.herd/cache-probe.jsonl`（`HERD_CACHE_PROBE_PATH` 可改路径）。两者默认关闭。
- **usage 统计**：delta 显示最近活动子代理的最后一次请求；sum 合并所有 agent key，主会话后续请求不会把 delta 抢回主会话。
- **环境清洗**：`call` 移除 `BUN_OPTIONS`、`NODE_OPTIONS`、`BASH_ENV`、`ENV`、`PROMPT_COMMAND`，避免宿主预加载钩子改变普通命令。`wait` 的期限是 `2000ms + otherwise_independent_work 的 UTF-8 字节数 × 200ms`；`clj_*` fork 时固定白送 2 秒 `call` 宽限。
- **VFS 边界**：普通路径不做根目录限制；`..`、绝对路径、越界符号链接与覆盖 `AGENTS.md` 都允许。写锁 `$W$`、批内 VFS 与已读文件的 `stamp` 冲突检查保留；冲突返回 `:FILE_CONFLICT`，磁盘保持外部修改。

## 启用

```bash
omp plugin link /absolute/path/to/HerdchestraLite
omp plugin list --json
```

之后启动 `omp`。当前已在 `omp 18.20.0` 做过加载冒烟：`timeout 120 omp -p '只回复 ok'` exit 0、wall 5.1s。16.x/17.x 未实测（D5）。

## 使用

启动使命：

```text
/herd 实现一个最小可验证功能
```

使命创建后进入 S1。按面板提示批准、修改或拒绝 `s1-brainstorm.md`；批准后 S2–S4 由 attach 工具自动推进，S5 由 Reviewer 与 Swarm 在单工作区完成，K 路审计汇总后写 `plans/<slug>/s5-report.md`。

未进入使命时可以直接用 `clj_devops` 执行 ClojureScript REPL（最后一个顶层值作为回执）：

```clojure
(let [src (cat {:path "README.md"})
      [b e] (where {:content src
                    :needle "Herdchestra Lite"})]
  [b e])
```

`where` 零匹配或多匹配会挂起程序；用 `(unpark {:name "..." :value [b e]})` 恢复。程序正常返回时，批内 VFS 在写锁内复核 `stamp` 后原子落盘；冲突返回 `:FILE_CONFLICT`。

## 验收与本地检查（不是验收）

```bash
env -u BUN_OPTIONS bun test tests --parallel
```

当前结果：431 pass / 1 skip / 0 fail / 2041 expect / 432 tests / 44 files，约 16.2s。`tests/` 下没有 `.disabled` 文件；旧 Cherry/CEK 测试已删除并由 CLJS 测试替代；`tests/fixtures/s5-wiring-scenario.mjs` 已删除。

关键测试覆盖：

- `tests/perf-hot-path.test.mjs`：5MB probe off、1000 条 context、1000 次 message_update、1MB `where`、20k `glob`、500ms 锁超时、2 MiB `cat`、100 次 `write`。
- `tests/cljs-console-guard.test.mjs`：console/stdio 拒绝、字符串与注释不误杀、`call` pipe 捕获。
- `tests/cljs-usage.test.mjs`：subagent delta/sum 与 100ms UI 合并。
- `tests/cljs-dashboard-wiring.test.mjs`：看板从不挂载。
- `tests/cljs-surface-vibe.test.mjs`：无使命保留宿主工具并追加 herd 三件套（devops 面），`/vibe` 主代理不干预；`tests/cljs-surface.test.mjs`：阶段/角色收窄。
- `tests/cljs-system-install.test.mjs`：同一进程多个 pi 的 per-pi 安装不重复；`tests/clj-main-trace.test.mjs`：启动/激活 trace 与单例复用。
- `tests/cljs-lock-contention.test.mjs`、`tests/hack-context-rewrite.test.mjs`：锁竞争回执与“每分支最多一次自动重写”。
- `tests/cljs-system.test.mjs`、`tests/cljs-runner.test.mjs`、`tests/cljs-auditors.test.mjs`、`tests/cljs-gates.test.mjs`：`/herd`、S1 四态、S5 runner、K 路审计与门禁接线。

这些测试只保护组件与接线，不是根规格的 CASE 验收。真实 S1→S5 tmux 使命尚未运行，`plans/<slug>/s5-report.md` 与 `docs/manual-acceptance/clean-break/report.md` 都不存在；用户已暂停 dog food，恢复后再补证据。

## 仍未完成/未验证

完整队列见 `DEBT.md`；当前主要是：

1. **D3 真实端到端**：没有真实 tmux S1→S5、没有 S5 报告与 clean-break 验收报告。测试全绿与 `omp -p` 冒烟都不能替代。
2. **D4 S1 面板**：四态端口与窄测已就绪；真实宿主/tmux 的键盘、滚动、resume 未验证。
3. **D5 版本兼容**：只做了 18.20 冒烟；16.x/17.x 的 `ctx.agent` 与 `sessionFile` 父链未实测。
4. **D7 交错矩阵**：全量 V/T/F 矩阵未逐项核对；`tmp/d7-matrix.md` 是旧快照，T05/T06/T11 等仍缺直接用例。
5. **D8 审计隔离**：真实 bwrap/tmux、主工作区只读、K>1 未跑通。
6. **D18 沙盒边界**：nbb 仍是基本防呆，不是安全边界；不要宣传为隔离。
7. **D17 本机命令**：`bun test` 必须带 `env -u BUN_OPTIONS`，否则 Bun 1.4.4 会把 `test` 当脚本名。

## 文档边界

| 文档 | 作用 |
|---|---|
| 根 `AGENTS.md` | 唯一规格（SSOT）；只有人类操作员可以修改 |
| `HACK.md` | 宿主、依赖、Git、验收环境的实测事实与复检步骤 |
| `DEBT.md` | 根规格要求但当前未做到的事项；关闭即删除 |
| `HISTORY.md` | 历史取舍、被拒方案、旧产物保全记录 |
| `src/AGENTS.md` | 全局架构装配笔记与单向依赖图 |
| `docs/manual-acceptance/clean-break/` | 开发本产品的 MANUAL ACCEPTANCE 文档；不是产品运行时 `plans/<slug>/` |
| `docs/旧的方法论.md`、`docs/旧的架构.md`、`docs/旧的设计.html`、`docs/讨论纪要.md`、`docs/兄弟项目参考.md` | 用户既有历史资料，保留只读，不因 clean-break 删除或改写 |

旧模块 `src/pi-goal/`、`src/pi-context/`、`src/editor-theme/`、`src/context/`、`src/manual-acceptance/` 已从工作树删除；不要恢复或重新 import。`src/main.mjs`、`src/bootstrap-main.mjs` 与 `src/clj-sandbox/*`、`src/stages/*`、`src/swarm/*` 是保留的旧实现，当前清单不加载；`src/tui/*` 同样保留但不再挂载。