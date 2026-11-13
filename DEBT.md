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

## D22 `wait` 超时的 runtime-parked 无法 `unpark`

- **现状**：`park-all!` 标 `:parked :deadline :recoverable false`；`repl/unpark` 对这类程序返回 `{:state :unrecoverable :reason :deadline}`，不再抛 `:PROGRAM_UNKNOWN`。
- **缺口**：它不是表达式级挂起；程序仍在后台运行，无法真正暂停/恢复，只能等完成或 `abandon`。
- **影响**：回执已明示不可恢复；`park-all` 仍不是真正的表达式级挂起。
- **下一步**：为超时程序注入可暂停的 await 点，或明确文档化为“只降级为后台完成”。


## D33 scores 核心已迁移，审计证据链未收口

- **现状**：`stages/scores.cljs` 已实现 CASE/提交/阈值/min(U,D)/PASS-FAIL-INCOMPLETE 与 canonical 覆盖。
- **缺口**：`writeS5Report`、批准签发与 `attach_case_audit` 接线仍未迁移。
- **下一步**：接 `writeS5Report` 与批准签发，再与 `attach_case_audit` 对接。
