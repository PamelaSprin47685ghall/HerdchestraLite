# DEBT.md — 相对根规格的未关闭缺口

> 本文件只记录根 `AGENTS.md` 要求但当前工作区尚未做到的事项。关闭即删除；源码存在或窄测试通过不等于完成。当前设计以根 `AGENTS.md` 的 2026-11-13 生命周期修订与 §2.2–§2.6 为准。

## D0 默认面仍只有 clj 执行器

- **缺口**：`package.json` 的 `omp.extensions` / `pi.extensions` 只声明 `./src/clj-main.mjs`，注册 `clj_devops`、`wait`、`time_leap`、`ask_beacon`。`/herd`、`review`、`attach_*`、`ask_user`、`devops` 子代理、S1 人工确认、看板、K 路审计、TUI 均未装配。
- **影响**：当前产品只能验证执行器，不能执行 S1–S5 使命。
- **下一步**：按 §2.3 落地 `review` + `attach_*`，再恢复完整入口。

## D2 S5 单工作区编排尚未落地

- **缺口**：`main.mjs` 已移除 `fork_slices` 调用并写入 review/attach 的 `STAGE_SURFACES`，ff-only 已改为 `wantsFf` 显式 opt-in；但单工作区 S5 的 runner 接力、board 工具面与 quiescence 屏障尚未接线验证；`src/swarm/worktree.mjs` 仍是休眠代码。
- **影响**：S5 工具面与提示词按新设计存在，但不能端到端运行。
- **下一步**：接 `swarm/runner.mjs` 的单工作区 Reviewer ⇄ Swarm 路径；不接线 worktree。

## D3 真实宿主加载与端到端手工验收未完成

- **缺口**：没有真实 tmux 中的 S1→S5 小型使命，没有 `plans/<slug>/s5-report.md`，没有 `docs/manual-acceptance/clean-break/report.md`。
- **已有观察**：本工作区已被真实 `omp 18.20.0` 加载（`omp plugin list` 指向本目录；`omp -p` 两次成功调用 `clj_devops` 并得到 EDN 回执）。18.16.0 隔离副本曾观察到 S1 面板批准、S2 CASE 冻结、S3/S4 成功与 S5 fork；这些只覆盖旧 `advance` 面，且不是验收。
- **下一步**：重新 link 本工作区；按新 `review`/`attach` 生命周期跑最小使命（S1 人工批准 → S2–S4 自动 → 单工作区 S5 → K=1 审计）。证据写入 `docs/manual-acceptance/clean-break/`，不得用 `bun test` 代替。

## D4 S1 人工批准与新 attach 的接线未验证

- **缺口**：新 `attach_brainstorm` 需要在写盘后阻塞打开真实确认面板，支持 approve / revise / deny / pending 四态；`deny` 必须转为 `ask_user` 语义。
- **下一步**：在真实宿主验证四态；面板必须展示磁盘上的 `plans/<slug>/s1-brainstorm.md`，不能只展示内存提交。

## D5 角色身份与宿主兼容

- **缺口**：角色收窄依赖 `ctx.agent`；17.x/16.x 未实测；`sessionFile` 父链在 17.3.5 无效，18.16 可兑现。当前 dogfood 面没有角色 admission。
- **下一步**：逐版本探测 `ctx.agent`；缺失时 fail-closed 并标 health degraded；不恢复独立 role-auth 注册表。

## D7 全量交错矩阵未运行

- **缺口**：未运行全量 `bun test` 并逐项核对 V01–V08、T01–T13、F01–F15；多数完整装配测试仍为 `.disabled`。
- **下一步**：先以窄测试保护新 `review`/`attach` 与单工作区 S5；全量矩阵在完整装配接回后恢复。测试不是验收。

## D8 审计隔离与 S5 审计闭环

- **缺口**：`startAuditBatch`、`aggregate`、`writeS5Report` 已接线，但真实 `clj_auditor`、bwrap/tmux 隔离、`attach_case_audit`、全 PASS 报告与批准尚未跑通；审计员自行观察工作区与 CASE 数据，不做 frozen 哈希复核，也不写 evidence 目录。
- **下一步**：在真实宿主用 `s2-cases.edn` 跑 K=1，再扩到 K>1；验证审计前后主工作区只读、`attach_case_audit` 回执、FAIL 返工与批准。

## D13 未开启装配的同步 fs 与异步调用点

- **缺口**：`src/host/subprocess.mjs`、`src/sandbox/*`、`src/stages/*`、`src/swarm/*`、`src/main.mjs` 仍使用同步 fs；`file-lock`/`atomic-write` 已异步，完整装配的调用点需全部 await（`writeDevopsReport` 的测试调用点尚未 await）。
- **影响**：完整装配接回时仍会阻塞主线程；部分 `main-bootstrap` 测试因历史实现差异失败。
- **下一步**：按默认面同一规则异步化，并在接回时重写完整装配测试。

## D15 非 dogfood 测试已禁用

- **现状**：`attach-lifecycle`、`audit`、`board`、`dashboard`、`evaluator`、`host`、`main-bootstrap`、`main-consumer`、`runner`、`s5-wiring`、`stages-parsers`、`stages-scores`、`tenure`、`worktree` 共 14 个文件为 `*.test.mjs.disabled`；`bun test tests` 只跑 dogfood 面启用的测试文件。
- **影响**：完整装配与审计路径暂时没有自动化回归；接回时必须按单工作区语义重写，不得直接恢复旧断言。

## D18 nbb 运行时：Air-Gapped 已获批准放宽为基本防呆

- **现状**：`nbb` 默认暴露 `js/` 与 `globalThis`，无法兑现 §4.1 的 Air-Gapped 符号表；当前只保证不主动注入 `process`/`require`/`fs`，不承诺逃逸不可能。该放宽由人类操作员于 2026-11-13 明确批准，记录于 `MIGRATION.md`。
- **影响**：沙盒不是安全边界；LLM 程序可经 `js/` 触碰宿主全局。
- **下一步**：若需强隔离，改用自建 SCI ctx 或子进程 worker；在此之前不得把基本防呆宣传为安全隔离。

## D19 完整装配迁移未收口

- **现状**：默认面已接通 `clj_devops`、`wait`、`time_leap`、`ask_beacon`、提示词注入与宿主工具黑名单。
- **缺口**：完整装配（`review`/`attach_*`、看板、S5 runner、K 路审计、TUI）仍未迁移到 CLJS；旧 `src/*.mjs` 模块仍存在但不由默认入口加载。
- **下一步**：按 `MIGRATION.md` 台账继续迁移完整装配，完成后删除旧模块。

## D20 多程序共享 SCI 全局 ctx

- **现状**：`park`/`where` 已用词法 `__herd-program-name` 与按名 `notifiers` 分区；并发 `prog-a`/`prog-b` 的 parked 回执与 `unpark` 已在新进程验证。
- **剩余缺口**：`nbb/load-string` 仍在同一 SCI ctx 定义同名 `__run`；已运行帧不受影响，但同一 tick 内两个 `evaluate` 的 `__run` 定义会互相覆盖。
- **影响**：默认面并发工具调用下，park/notifier 已隔离；`__run` 覆盖仍是理论风险。
- **下一步**：为每个程序生成唯一 `__run` 符号（如 `__run-<name>`）或在独立 SCI ctx 中求值；补并发 park/unpark 回归。

## D22 `wait` 超时的 runtime-parked 无法 `unpark`

- **缺口**：`wait` 超时的 `park-all!` 已把程序标为 `:parked :deadline :recoverable false`，但这些程序没有 `sandbox/parked` 的 `:resolve`；`unpark` 仍抛 `:PROGRAM_UNKNOWN`，程序继续运行，只能等它完成或 `abandon`。
- **影响**：回执已明示不可恢复；`park-all` 仍不是真正的表达式级挂起。
- **下一步**：为超时程序注入可暂停的 await 点，或明确文档化为“只降级为后台完成”。

## D24 `stamp` 的 nsec 由浮点 `mtimeMs` 推导

- **缺口**：`stamp-of` 用 `(mod mtimeMs 1000) * 1e6` 计算 `:mtimeNsec`，精度低于旧实现的 bigint `mtimeNs`；极端情况下同一 `(sec, nsec, size)` 可能碰撞。
- **影响**：`__expectedStamp` 的冲突检测弱于旧 mjs；默认面 LLM 不传该字段，影响面小。
- **下一步**：改用 `fs.statSync(path, #js {:bigint true})` 的 `mtimeNs`，按 bigint 拆分秒与纳秒。

## D25 `read` 未代理宿主 native 工具

- **缺口**：`sandbox/read` 与 `cat` 同为 `fs.readFile`；规格要求 `read` 代理宿主官方 native `read`，宿主入口不可用即 fail-closed。
- **影响**：`read` 的宿主解码/格式化语义与旧完整装配不同；两者都读真实文件，但 `read` 的“只保证可读”边界未兑现。
- **下一步**：通过受控 Runner 捕获调用 `invokeNativeTool("read", ...)`；不可用时返回 `:HOST_API_MISMATCH`，不回退 `node:fs`。

## D27 `where` 最近行诊断未做完整带宽优化

- **缺口**：`nearest-line` 已修掉 DP 越界并对每行做全行 Levenshtein（K=64、10M 单元预算），但未做公共前后缀裁剪，也未只计算 $2K+1$ 对角线带。
- **影响**：大文件或长行下会提前耗尽预算，最近行可能不完整。
- **下一步**：先裁剪公共前后缀，再只填带宽内的单元；补大文件预算测试。

## D29 `glob` 的并发与条目语义

- **缺口**：`:exec` 用 `Promise.all` 并发调用，没有旧实现的 worker pool；`onlyFiles` 为 false 时目录条目只返回路径，不带类型；`dot` 只过滤 basename。
- **影响**：大量匹配时占满单线程；目录/符号链接的 glob 结果弱于旧实现。
- **下一步**：评估 worker pool 或受控并发上限；把 `walk-entries` 的 `[full is-file]` 扩展为完整 entry 信息。

## D30 `before_agent_start` 的工具面更新未 await

- **缺口**：`apply-tool-surface!` 调 `setActiveTools` 后只挂 `.catch`，`before_agent_start` 不等待其完成。尝试把 handler 改成 `^:async` 后，SCI 在 nbb 中把 handler 注册成不可调用的对象，真实宿主会拿不到函数，因此已回退为同步 handler。
- **影响**：工具面变更可能在当前请求之后才生效；真实 `omp -p` smoke 通过。
- **下一步**：在保持 handler 可调用的前提下，用 `setActiveTools` 的同步副作用或宿主承诺的初始化顺序解决；不要在 nbb/SCI 中用 `^:async` 包装注册给宿主的 handler。

## D31 批量写预算未实现

- **缺口**：`write` 有单文件 2 MiB 上限；`call` 的内联与日志上限已可注入并默认 1 MiB/64 MiB。但 `mkdir`/`rm`/`mv` 的 256 路径操作与单次调用 16 MiB 总量仍未记账。
- **影响**：超出规格上限的批量写不会被 `:LIMIT_EXCEEDED` 拒绝，依赖宿主/OS 报错。
- **下一步**：在 `repl.run` 的每程序记账里累计路径操作与字节数，超限时拒绝后续步骤并保留已写部分。
