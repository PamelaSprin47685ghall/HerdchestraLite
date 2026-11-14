# Clean-Break 全项目改造手工验收报告

- **验收日期**：2026-11-14
- **验收环境**：`omp 18.20.0`、`bun 1.4.4`、`tmux 3.7c`、`git 2.56.0`、Linux x64
- **模型驱动**：隔离环境本地 Mock OpenAI HTTP 服务（`openai-completions` SSE 流式，零真实模型费用，严格遵守 D20）
- **开发测试命令前缀**：`env -u BUN_OPTIONS`（因宿主注入 `BUN_OPTIONS=--preload ~/.config/omp/zstd-preload.js`，不写入 `package.json` 或 CI）

## 1. 真实宿主 S1 人工批准面板验收（D4）

在真实 `omp 18.20.0` + `tmux`（120×36）中加载本工作区 `./src/clj-main.mjs`，通过 `/herd` 触发 S1 并调用 `attach_brainstorm` 打开真实全屏确认面板（`S1 文档审批 1-28/45`），逐态实测通过：

- **磁盘正文与滚动**：面板从磁盘读取 `plans/<slug>/s1-brainstorm.md`（45 行），发送 `End` 键成功滚动至 `18-45/45` 底部行。
- **`pending`（Esc 取消）**：按 `Esc` 后不提交 barrier，`mission.edn` 保持 `:stage :s1` 且保留 `:attach.pending`。
- **`revise`（修改意见）**：按 `Right`×2 选中 `[ 修改 ]` 并回车，弹出 `Revise S1` 输入框，输入反馈后留在 S1、清除 `attach-ready` 并重新触发 `review([])`。
- **`deny`（拒绝）**：默认选中 `[ 拒绝 ]` 并回车，返回 denied 并转为 `ask_user` 语义，留在 S1。
- **`approve`（批准）**：按 `Right` 选中 `[ 批准 ]` 并回车，重读磁盘正文、提交 barrier、切换工具面至 S2 并注入 `S2_BRIEFING`。

## 2. 角色身份探测与工具面收窄验收（D5）

- 在真实 `omp 18.20.0` 中实测所有子代理角色的工具面收窄与 `artifactsDir` transcript 落盘：
  - `S1` 主会话：`review, attach_brainstorm, ask_user, devops, clj_plan`（`S1` 出站请求确认不含 `James Bach` / `case_id`）
  - `Plan DevOps`：`clj_devops, submit_devops_report`
  - `S2` 主会话：`review, devops, clj_plan, attach_manual_tests`
  - `S3` 主会话：`review, devops, clj_plan, attach_dev_guide`
  - `S4` 主会话：`review, devops, clj_plan, attach_coordination`
  - `Reviewer`：`review, clj_review`
  - `Swarm Worker`：`board_split, board_claim, board_finish, ..., clj_worker`（产物写入 `.herd/missions/<slug>/artifacts/T-5/slot-S*/`）
  - `Manual Auditor`：`attach_case_audit, clj_auditor`
- 16.x/17.x 本机无二进制文件，通过能力探测与 `tests/cljs-system.test.mjs` fail-closed 单测验证缺失 `ctx.agent`/role token 时拒绝越权并记录 health degraded。

## 3. 完整 S1→S5 使命与 K 路并发审计验收（D3）

在隔离工作区通过真实 `omp 18.20.0` + `tmux` + Mock OpenAI 完整执行 `/herd 验证完整 S1 到 S5 闭环`：

1. S1 手工批准后，S2（`s2-manual-tests.md` + `.herd/missions/s1-s5/s2-cases.edn`，5 个 CASE 覆盖 `正常`/`错误`/`边界`/`并发`/`恢复`）、S3（`s3-dev-guide.md`）、S4（`s4-coordination.md` + `s4-coordination.pml`）自动晋级完成。
2. S5 启动初任 `Reviewer`（`T-5`）写入根任务 `T-1`，唤醒 4 个 `Swarm Worker` 槽位；`Worker-s1-s5-S2` 认领 `T-1`、通过 `clj_worker` 写入 `dogfood-ok.txt`（`verified`）并 `board_finish`。
3. 看板静止后触发 `runner/relay!` 写入 barrier 晋级继任 `Reviewer`（`T-6`），空账进入 `K=5` 并发 `Manual Auditor` 各自在 `/tmp/herd-audit-s1-s5-*` 隔离副本执行 `clj_auditor` 并调用 `attach_case_audit`。
4. 汇总写出 `plans/s1-s5/s5-report.md`（5/5 PASS，92/90 -> `final=90 >= 80`），`audit/batch.edn` 记 `:verdict :PASS`，`mission.edn` 正式签发 `:approval` 并推进至 `:stage :completed`。

## 4. 狗粮期间发现并修复的真实缺陷

1. `system.cljs` `gate-execute!`：阶段 `attach_*` 晋级后未即时调用 `apply-surface!` 刷新工具面，且同回合未通过 barrier handoff 切出下一阶段简报 → 已修复。
2. `system.cljs` `ensure-s5-board!`：`store/write-board!` 返回 `{:path ...}` 而无 `:ok` 导致误报 `the S5 board could not be initialized` → 已修复。
3. `clj-main.mjs` `runSubagent` & `subprocess.mjs` `planSpawn`：`signal` 透传 CLJS `nil`（`null`）报错、`BOOT_KEY` 复用导致子进程 `pluginEntryPath` 丢失、以及 `agentId` 未透传导致 `Swarm Worker` 报 `:ACTOR_DEAD` → 已修复并在 `runner.cljs` `wake-all-slots!` 补齐 `register_actor`。
4. `runner.cljs` `quiescence`：未过滤 `:done` 任务导致 `T-1` 完成后仍报 `:BOARD_NOT_EMPTY` → 已修复。
5. `auditors.cljs` `prepare-isolation-default!` & `system.cljs` `audit-execute!` / `s5-deps`：修复参数 arity 传参、隔离目录审计员主工作区 `root`/`slug` 解析、以及默认 `:approval-port` 接线使最终 `:stage :completed` 与 `:approval` 正常签发。

## 5. 开发者内部测试与规范检查

- `env -u BUN_OPTIONS bun test tests/fast.test.mjs`：45 pass / 0 fail
- `env -u BUN_OPTIONS bun test tests --parallel`：聚合优化后 9 个测试入口、286 pass / 0 fail（涵盖 F01–F14 交错矩阵）
- `env -u BUN_OPTIONS ./node_modules/.bin/biome check .`：0 errors / 0 warnings