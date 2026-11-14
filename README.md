# Herdchestra Lite

Herdchestra Lite 是面向 `omp` 终端宿主的轻量多智能体研发插件。完整规格（S1–S5、门禁、看板、K 路审计）在仓库根 `AGENTS.md` 中；当前实现已把完整装配接到唯一清单入口，默认启用。

> **当前状态：完整装配默认启用，真实端到端验收未完成。** 清单入口 `src/clj-main.mjs` 通过 `src/herd/bootstrap.cljs` 加载 `src/herd/main.cljs` 与 `src/herd/system.cljs`，注册 `clj_devops`、`wait`、`handoff`、八个门禁工具、11 个 `board_*` 与 `attach_case_audit`；`/herd <seed>` 创建使命并进入 S1。S1 是唯一手工批准门禁，S2–S4 由 `attach_*` 自动晋级，S5 走单工作区 Reviewer ⇄ Swarm 与 K 路审计。
>
> **TUI 看板面板已按用户 2026-11-14 指令整体移除。** `src/tui/*` 与旧 `src/main.mjs` 已从源码树删除；`tests/cljs-dashboard-wiring.test.mjs` 明确断言 `install!`、`session-start!` 与 `/herd` 都不挂载看板。
>
> 真实 tmux 中的 S1→S5 手工验收尚未完成（`DEBT.md` D3）；没有 `plans/<slug>/s5-report.md`，没有 `docs/manual-acceptance/clean-break/report.md`。不得把测试或冒烟写成验收。
>
> 唯一规格仍是根 `AGENTS.md`；未关闭缺口在 `DEBT.md`；架构装配与宿主/依赖实测在 `src/AGENTS.md`。本 README 只描述当前可核对的事实。

## 当前启用面

- **清单入口**：`package.json` 的 `omp.extensions` / `pi.extensions` 都只声明 `./src/clj-main.mjs`。该入口启动 nbb，加载 `src/herd/bootstrap.cljs`，再由后者加载 `src/herd/main.cljs` 与 `src/herd/system.cljs`。并发激活共享 `globalThis.__herdBootPromise`，启动失败会清空该 promise 以便重试；`contextPis`、`activated-pis` 与 system 的 `installed-pis` 都是 per-pi `WeakSet`，同一进程里的多个 pi 各自只安装一次。
- **运行时依赖**：`nbb@1.6.215`、`@chrisoakman/standard-clojure-style@0.29.0`、`highlight.js@11.12.0`（仅内容语言识别；高亮仍由宿主 native 高亮器完成）。
- **工具面（插件共注册 23 个）**：
  - 沙箱与上下文：`clj_devops`、`wait`、`handoff`。
  - 门禁：`review`、`attach_brainstorm`、`attach_manual_tests`、`attach_dev_guide`、`attach_coordination`、`ask_user`、`devops`、`submit_devops_report`。
  - 看板：`board_split`、`board_claim`、`board_finish`、`board_cancel`、`board_replace`、`board_release`、`board_reopen`、`board_comment`、`board_update`、`board_park_slot`、`board_take_or_die`（11 个）。
  - 审计：`attach_case_audit`。
- **工具面归属**：进入使命前与非收窄子代理使用 devops 面（移除宿主编辑/shell 黑名单，保留其余宿主工具并追加 `clj_devops`/`wait`/`handoff`）。进入 `/herd` 使命后，主会话按阶段收窄：S1 为 `clj_plan`/`review`/`attach_brainstorm`/`ask_user`/`devops`；S2 为 `clj_plan`/`review`/`attach_manual_tests`/`devops`；S3 为 `clj_plan`/`review`/`attach_dev_guide`/`devops`；S4 为 `clj_plan`/`review`/`attach_coordination`/`devops`；S5 为 `review`/`ask_user`；结案后恢复默认。
- **子代理角色面**：`Plan DevOps` 得到 `clj_devops` + `submit_devops_report`；`Reviewer` 得到 `clj_review` + `review`；`Swarm Worker`/`Swarm Holder` 得到 `clj_worker` + 11 个 `board_*`；`Manual Auditor` 得到 `clj_auditor` + `attach_case_audit`。角色由宿主 `ctx.agent` 与首行 `[HERD_ROLE: ...]` token 共同判定；缺失时 fail-closed 并记 health degraded。
- **命令 `/herd <seed>`**：创建 `.herd/missions/<slug>/mission.edn` 与看板，写 `.herd/focus.edn`，把 seed 作为 user message 发送，并进入 S1。slug 由 seed 归一化且在同工作区内唯一。
- **S1 手工批准**：`attach_brainstorm` 先写 `plans/<slug>/s1-brainstorm.md`，再阻塞打开确认面板；面板从磁盘读取完整字节，支持滚动，默认选中拒绝，左右/Tab 显式选择批准/修改/拒绝，Enter 确认，Esc 取消。approve / revise / deny / pending 四态都有回执；`deny` 转 `ask_user` 语义，文件不可读或无自定义 UI 时 pending/拒绝批准。
- **S2–S4 自动晋级**：`attach_manual_tests` 写入 `s2-manual-tests.md` 与 `s2-cases.edn` 并退休 S2 tenure；`attach_dev_guide` 写入 `s3-dev-guide.md`；`attach_coordination` 写入 `s4-coordination.md` 与未勾选的 Promela 模型；每次晋级读取下一阶段简报。
- **S5 单工作区**：`src/herd/swarm/runner.cljs` 启动 Reviewer，经共享看板与 Reviewer ⇄ Swarm 接力推进；不接 worktree，不 fork 多工作区。quiescence 屏障、Nudge 与恢复路径已接线。
- **K 路审计**：`src/herd/swarm/auditors.cljs` 为每个 CASE 建独立 `/tmp/herd-audit-<slug>-<case>-<batch>` 隔离路径，汇总后写 `s5-report.md`；批次状态在 `.herd/missions/<slug>/audit/batch.edn` 幂等（`:running`/`:pass` 直接复用，`:repair` 开新批次，`:pending` 复用 durable 提交），FAIL 会写 repair 根任务。审计员防呆依赖独立路径与不暴露 `write` 的角色面（信任边界，不要求 bwrap）。
- **TUI 看板**：已按用户指令移除，不挂载、不创建 `herdchestra-dashboard` widget，`system/state` 无 dashboard 键。
- **不用 `/herd` 就是 devops 面**：没有使命且无收窄角色时，移除宿主编辑/shell 黑名单（`read`/`write`/`edit`/`apply_patch`/`ast_edit`/`ast_grep`/`bash`/`exec`/`eval`/`glob`/`grep`/`find`），保留其余宿主工具并追加 `clj_devops`、`wait`、`handoff`。只有使命内的主会话按阶段收窄，显式 herd 角色按角色收窄；收窄失败只记 health degraded，不静默删工具。
- **沙盒 console/stdio 防呆**：`src/herd/repl.cljs` 的 `guard-source!` 在用户代码执行前拒绝 `console`、`js/console`、`globalThis.console`、`js/process.stdout`、`js/process.stderr`、`process.stdout`、`process.stderr` 与 `(.-stdout js/process)` 等直接访问，返回 `:CAPABILITY_DENIED`（`:reason :console-or-stdio-forbidden`）。字符串、字符字面量、注释与 UFSS fence 中的同名词不误杀；`call` 仍用 pipe 捕获 stdout/stderr，按 1 MiB 上限内联返回，不写落盘日志。这只是防呆，不是安全隔离。
- **性能边界（有意限制，不是未完成）**：写锁默认等待 500ms（`HERD_LOCK_WAIT_MS` 可调 50–5000ms；10ms 起指数退避、封顶 160ms），超时 `:LOCK_BUSY`（`:retryable true`）；`glob` 跳过 `node_modules`/`.git`/`.herd`，默认 20 000 条目 / 2 000ms 预算，超限 `:LIMIT_EXCEEDED`；`where` 最近行 DP 1 000 000 cells + 150ms deadline；`cat`/`write` 单文件 2 MiB；handoff 扫描只回看最近 512 条消息、文档窗口 32 条；usage/status UI 100ms 合并。
- **context 自动重写**：同一会话分支最多自动全量重写一次（host leaf 变化后重置预算）；其后的 prefix miss 只记录 `prefix-miss-suppressed`，不再次重写；compaction/reset boundary 存在时一律不重写。
- **诊断开关**：`HERD_TRACE=1` 启用热路径计时并写 `.herd/perf-trace.jsonl`（1 MiB 上限；`HERD_TRACE_PATH` 可改路径）；`HERD_CACHE_PROBE=1` 才启用 `before_provider_request` probe 并写 `.herd/cache-probe.jsonl`（`HERD_CACHE_PROBE_PATH` 可改路径）。两者默认关闭。
- **usage 统计**：delta 显示最近活动子代理的最后一次请求；sum 合并所有 agent key，主会话后续请求不会把 delta 抢回主会话。
- **环境清洗**：`call` 移除 `BUN_OPTIONS`、`NODE_OPTIONS`、`BASH_ENV`、`ENV`、`PROMPT_COMMAND`，避免宿主预加载钩子改变普通命令。沙箱程序与 `wait` 调用的期限均按 `2000ms + UTF-8 字节数 × 200ms` 计算；`clj_*` fork 时固定赠送 2 秒 `call` 等待额度。
- **直通写入与跨平台事件驱动锁**：普通路径不做根目录限制；`..`、绝对路径、越界符号链接与覆盖 `AGENTS.md` 都允许。无批内 VFS 预演：`write`/`mkdir`/`rm`/`mv` 在进程内 `path` 令牌 + 进程内 FIFO 排队 + 按需单例 IPC 跨进程锁守护进程（`src/host/lock-daemon.mjs`，连接即持锁、`SIGKILL` 瞬间释锁、零轮询）下按序直接落盘（`read`/`write` 委托宿主 native 工具，`write` 支持 `expected-stamp` 复核并返回 `:FILE_CONFLICT`）；失败保留此前已写部分，不做回滚。

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

`where` 零匹配或多匹配会挂起程序；用 `(unpark {:name "..." :value [b e]})` 恢复。需要基于读取复核并发修改时，可在 `write` 传入 `expected-stamp`，锁内复核不通过返回 `:FILE_CONFLICT`。

## 验收与本地检查（不是验收）

```bash
env -u BUN_OPTIONS bun test tests --parallel
```

当前结果：275 pass / 0 fail / 25 files（约 5.8s；`tests/fast.test.mjs` 45 pass / 0 fail，`tools/dev-acceptance/test` 23 pass / 0 fail）；`env -u BUN_OPTIONS ./node_modules/.bin/biome check .` exit 0（0 errors / 0 warnings）。`tests/` 下没有 `.disabled` 文件；旧 Cherry/CEK 测试与 `.mjs` 冗余夹具已删除。

关键测试覆盖：

- `tests/cljs-lock-contention.test.mjs`、`tests/cljs-file-matrix.test.mjs`：锁竞争/`:LOCK_BUSY`/死锁清理与 F01/F03/F04/F07/F09 `stamp` 及非阻塞读。
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
4. **D7 交错矩阵**：已补齐 T05/T06/T11/V02 与 F07 用例；F02/F05/F08/F10–F14 注入与真实 tmux 交错重放未覆盖。
5. **D18 沙盒边界**：nbb 仍是基本防呆，不是安全边界；不要宣传为隔离。
6. **D17 本机命令**：`bun test` 必须带 `env -u BUN_OPTIONS`，否则 Bun 1.4.4 会把 `test` 当脚本名。
7. **D19/D20**：完整套件 bootstrap 耗时约 5.8s；真实模型 e2e 需获得用户明确批准。

## 文档边界

| 文档 | 作用 |
|---|---|
| 根 `AGENTS.md` | 唯一规格（SSOT）；只有人类操作员可以修改 |
| `DEBT.md` | 根规格要求但当前未做到的事项；关闭即删除 |
| `HISTORY.md` | 历史取舍、被拒方案、演进里程碑、旧版对照、设计裁决索引与人类批准记录（不设 `CHANGELOG.md`） |
| `src/AGENTS.md` | 全局架构装配笔记、单向依赖图与宿主/平台实测边界（含原 `HACK.md`） |
| `docs/manual-acceptance/clean-break/` | 开发本产品的 MANUAL ACCEPTANCE 文档；不是产品运行时 `plans/<slug>/` |
| `docs/旧的方法论.md`、`docs/旧的架构.md`、`docs/旧的设计.html`、`docs/讨论纪要.md`、`docs/兄弟项目参考.md` | 用户既有历史资料，保留只读，不因 clean-break 删除或改写 |

旧模块 `src/pi-goal/`、`src/pi-context/`、`src/editor-theme/`、`src/context/`、`src/manual-acceptance/`、`src/main.mjs`、`src/bootstrap-main.mjs`、`src/clj-sandbox/*`、`src/stages/*`、`src/swarm/*`、`src/tui/*`、`src/prompts/*`、`src/sandbox/*` 等已全部从工作树删除；不要恢复或重新 import。