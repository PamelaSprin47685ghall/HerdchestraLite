# DEBT.md — 相对根规格的未关闭缺口

> 本文件只记录根 `AGENTS.md` 要求但当前工作区尚未做到的事项。关闭即删除；源码存在、窄测试通过或 `bun test` 全绿都不等于完成/验收。当前设计以根 `AGENTS.md` 的 2026-11-13 生命周期修订与 §2.2–§2.6 为准。
>
> 文末「已裁决的有意限制」记录人类明确批准或指令的偏离，它们不是待办。

## D3 真实端到端使命验收未完成（用户暂停 dogfood）

- **缺口**：没有真实 tmux 中的 S1→S5 小型使命，没有 `plans/<slug>/s5-report.md`，没有 `docs/manual-acceptance/clean-break/report.md`。
- **已完成的代码闭环**：唯一清单入口 `src/clj-main.mjs` 已加载 `src/herd/bootstrap.cljs` → `src/herd/main.cljs` + `src/herd/system.cljs`；`/herd` 创建使命与 `.herd/focus.edn`；八门禁工具、11 个 `board_*`、`attach_case_audit` 已注册；S1 面板四态、角色探测、Nudge、单工作区 S5 runner、K 路审计与 FAIL 返工根任务已接线。`tests/` 无 `.disabled`，旧 Cherry/CEK 测试已删除并由 CLJS 测试替代。
- **已有冒烟**：`timeout 120 omp -p '只回复 ok'` 在 `omp 18.20.0` 下 exit 0、wall 5.1s；真实 `-p` 的 `HERD_TRACE` 记录没有 sync-ms > 200ms 的条目。`env -u BUN_OPTIONS bun test tests --parallel` 为 431 pass / 1 skip / 0 fail（44 files）。
- **暂停原因**：用户明确暂停 dog food，准备修复后重启；未完成的真实验收不得写成已完成。
- **下一步**：用户恢复 dogfood 后，重新 link 本工作区，按 S1 人工批准 → S2–S4 自动 → 单工作区 S5 → K=1 审计跑最小使命；证据写入 `docs/manual-acceptance/clean-break/`，不得用 `bun test` 代替。

## D4 S1 人工批准面板未在真实宿主验证

- **缺口**：S1 确认端口与四态（approve / revise / deny / pending）已实现并有窄测；真实宿主/tmux 中的面板渲染、磁盘文档滚动、Esc 取消与 resume 仍未验证。
- **已实现**：`attach_brainstorm` 写盘后阻塞打开确认面板；面板从磁盘读取 `plans/<slug>/s1-brainstorm.md` 完整字节；默认选中拒绝，approve / revise / deny 显式选择，Esc 返回 pending；`deny` 转 `ask_user` 语义；文件不可读或无自定义 UI 时 pending/拒绝批准，不使用内存提交副本。
- **下一步**：在真实宿主逐态验证，并确认 tmux 下的宽度/滚动/键盘行为；结果记录到 `docs/manual-acceptance/`。

## D5 角色身份与宿主版本兼容

- **缺口**：角色收窄依赖宿主报告的 `ctx.agent` 与首行 `[HERD_ROLE: ...]` token；16.x/17.x 未实测，`sessionFile` 父链在 17.3.5 无效，18.16 可兑现。18.20 只做了 `omp -p` 冒烟，不是角色验收。
- **下一步**：逐版本探测 `ctx.agent` 与子会话文件路径；缺失时 fail-closed 并标 health degraded，不恢复独立 role-auth 注册表。真实 16.x/17.x 结果记入 `HACK.md` 与验收证据。

## D7 全量 V/T/F 交错矩阵未运行

- **缺口**：`env -u BUN_OPTIONS bun test tests --parallel` 已恢复为 431 pass / 1 skip / 0 fail（44 files），但尚未逐项核对根规格 §9.4 V01–V08、§3.5 T01–T13、F01–F15 的全量交错矩阵，也没有真实的跨进程/tmux 交错重放。
- **已有材料**：`tmp/d7-matrix.md` 是 2026-11-14 的早期临时映射，记录 239 pass / 1 skip / 4 fail；该数字与当前测试面不一致，只能作为缺口清单参考，不能当成本轮验证。矩阵中 T05、T06、T11 仍无直接用例，V02、V04、V05、T03、T04、T07–T10、T12、T13 仅部分覆盖。
- **下一步**：以当前 431 pass 为基线重新生成映射，补齐或明确接受 T05/T06/T11 等缺口；真实交错与重启恢复仍需 D3 的宿主验收，测试不是验收。

## 已裁决：审计员只做防呆（不是缺口）

- `clj_auditor` 不暴露 `write`/`mkdir`/`rm`/`mv`；`call` 可自由使用，可能修改主工作区，这是明确接受的信任边界，不是隔离缺口。审计员不再要求 bwrap。

## D17 本机 `bun test` 需先清除 `BUN_OPTIONS`

- **现状**：宿主设置 `BUN_OPTIONS=--preload /home/kunweiz/.config/omp/zstd-preload.js`；Bun 1.4.4 在该变量存在时把 `bun test` 误解析为脚本名，输出 `Script not found "test"`。`env -u BUN_OPTIONS bun test tests --parallel` 已实测 431 pass / 1 skip / 0 fail（44 files）。
- **影响**：放行命令必须带 `env -u BUN_OPTIONS`；该变量属于宿主环境，不得写入 `package.json` 或 CI。
- **下一步**：无需改仓库；验收记录写明该前缀即可。

## D18 nbb 运行时：Air-Gapped 已获批准放宽为基本防呆

- **现状**：`nbb` 默认暴露 `js/` 与 `globalThis`，无法兑现 §4.1 的 Air-Gapped 符号表；当前只保证不主动注入 `process`/`require`/`fs`，不承诺逃逸不可能。该放宽由人类操作员于 2026-11-13 明确批准，记录于 `MIGRATION.md`。
- **已加的防呆**：`src/herd/repl.cljs` 的 `guard-source!` 在用户代码执行前拒绝 `console`、`js/console`、`globalThis.console`、`js/process.stdout`、`js/process.stderr`、`process.stdout`、`process.stderr` 与 `(.-stdout js/process)` 等直接访问，返回 `:CAPABILITY_DENIED`（`:reason :console-or-stdio-forbidden`）；字符串、UFSS fence、字符字面量与注释中的同名词不误杀。`call` 仍用 pipe 捕获 stdout/stderr，但不落盘日志；输出只保留在程序回执中。
- **影响**：沙盒不是安全边界；LLM 程序仍可经 `js/` 触碰宿主全局。这个防呆只避免误写宿主终端/日志流，不能宣传为隔离。
- **下一步**：若需强隔离，改用自建 SCI ctx 或子进程 worker；在此之前不得把基本防呆宣传为安全隔离。

## 已裁决的有意限制（不是缺口，不进入待办）

### 性能边界（2026-11-14，用户报告 5s UI 卡顿后确定）

这些上限是有意保留的行为，不是未完成项；触发时以明确错误码拒绝，不静默截断。

- **写锁**：默认等待 500ms（`HERD_LOCK_WAIT_MS` 可调 50–5000ms），10ms 起指数退避并封顶 160ms，超时返回 `:LOCK_BUSY`（`:retryable true`）。
- **`glob`**：跳过 `node_modules`、`.git`、`.herd`；默认 20 000 条目 / 2 000ms 预算；超限返回 `:LIMIT_EXCEEDED`，不截断结果。
- **`where`**：最近行 DP 预算 1 000 000 cells + 150ms deadline；超限返回 `:budget-exhausted`。
- **`cat` / `write`**：单文件 2 MiB 上限，超限 `:LIMIT_EXCEEDED`；`write` 全异步。
- **handoff 扫描**：只回看最近 512 条消息找 tool-call，文档窗口 32 条，不再每轮全量扫描。
- **usage / status UI**：100ms 合并刷新；流式 tick 用轻量 delta，不重建全量。
- **`before_provider_request` probe**：默认关闭，仅 `HERD_CACHE_PROBE=1` 时写 `.herd/cache-probe.jsonl`（可用 `HERD_CACHE_PROBE_PATH` 改路径），单文件 1 MiB。
- **`HERD_TRACE=1`**：启用热路径计时，写 `.herd/perf-trace.jsonl`（可用 `HERD_TRACE_PATH` 改路径），单文件 1 MiB；默认关闭。记录含 `sync-ms`，用于确认同步阻塞已回到亚 200ms。
- **实测（2026-11-14）**：5MB payload probe off 0.02ms；1000 条 context 2.3ms；1000 次 message_update 2.4ms；`where` 1MB 0 匹配约 12ms；`glob` 20k 约 14ms；锁竞争约 0.5s 返回 `:LOCK_BUSY`；100 次 `write` 约 25ms；真实 `omp -p` trace 无 sync-ms > 200ms 条目。

### vibe 模式工具面不干预（2026-11-14）

- 没有 `/herd` 使命时，主会话与普通子代理（无 `[HERD_ROLE]` 收窄角色）保留全部宿主工具，并追加 `clj_devops`、`wait`、`handoff`（devops 面）；`/vibe` 主代理除外，不调用 `setActiveTools`。
- 只有使命内主会话按阶段、显式 herd 角色按角色收窄；收窄失败记 health degraded，不静默删工具。
- 旧宿主工具黑名单已删除。`tests/cljs-surface-vibe.test.mjs` 断言 vibe 模式不删宿主工具；`tests/cljs-surface.test.mjs` 断言使命/角色收窄。

### TUI 看板按用户指令移除（2026-11-14）

- 用户明确指令移除 TUI 看板，覆盖根规格 §6.1 的看板要求；这是已裁决的偏离，不是迁移遗漏。
- `src/tui/dashboard-model.mjs`、`src/tui/dashboard-widget.mjs` 保留在源码树中，但没有任何入口 import 或挂载；`src/main.mjs` 仍引用它们，但 `main.mjs` 不由清单加载。
- `tests/cljs-dashboard-wiring.test.mjs` 明确断言 `install!`、`session-start!` 与 `/herd` 都不挂载 `herdchestra-dashboard`。不得以“根规格要求”为由恢复看板，除非人类操作员撤销该指令。

## D19 完整测试套件的 nbb bootstrap 成本

- 条款：§9.3 属性测试、§9.7 放行标准。
- 缺口：完整 400 tests 在 27 个独立 Bun 进程中各自加载 33 个 CLJS 模块，实测 USER 62.6s + SYS 4.8s；16 核完美满载下界约 4.2s，无法达到 1s。
- 现状：默认 `bun run test` 只跑 `tests/fast.test.mjs`（约 0.5s，182 tests）；`bun run test:full` 跑完整套件（约 5.6s）；小数据量 + 近零开销断言已覆盖 cat 2 MiB、glob 跳过/上限、where 零匹配、probe off。
- 建议：合并同 domain 的 CLJS 测试文件共享一次 bootstrap，或把 `herd.system`/`stages`/`swarm` 改为延迟加载；完成后重新测墙钟与 CPU。

## D20 e2e 真实模型审批

- 条款：§2.7 常授权无人值守、§9.5 K 路审计、§9.7 放行标准。
- 约束：任何 e2e 不得自动使用真实模型烧钱；真实模型 e2e 必须先获得用户明确批准。
- 默认：单测/集成测试使用 fake clock、显式事件与 mock 子代理；真实 omp + 真实模型的使命验收由用户批准后手动启动。
