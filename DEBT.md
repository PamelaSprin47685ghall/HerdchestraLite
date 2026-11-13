# DEBT.md — 相对根规格的未关闭缺口

> 本文件只记录根 `AGENTS.md` 要求但当前工作区尚未做到的事项。关闭即删除；源码存在或窄测试通过不等于完成。当前设计以根 `AGENTS.md` 的 2026-11-13 生命周期修订与 §2.2–§2.6 为准。

## D0 默认面仍只有 clj 执行器

- **缺口**：`package.json` 的 `omp.extensions` / `pi.extensions` 只声明 `./src/clj-main.mjs`，注册 `clj_devops`、`wait`、`time_leap`、`ask_beacon` 与 `/clj-status`。`/herd`、`review`、`attach_*`、`ask_user`、`devops` 子代理、S1 人工确认、看板、K 路审计、TUI 均未装配。
- **影响**：当前产品只能验证执行器，不能执行 S1–S5 使命。
- **下一步**：按 §2.3 落地 `review` + `attach_*`，再恢复完整入口。

## D1 review + attach 生命周期收尾

- **已完成**：`contract.mjs` 已提供 `readBoard` / `writeBoard` / `archiveBoard` / `advanceTenure`；`main.mjs` 的 `STAGE_SURFACES` 已改为 review/attach；`gate-tools.mjs` 的 `advance_s1..s4` digest 分支已删除；frozen 哈希、`realign` 与 `contract-line` 已移除。
- **剩余缺口**：`main.mjs` 仍保留临时 `verifyContract()` stub 与审计端口调用点；旧测试仍可能断言 `advance_*` / frozen；`attach_*` 的 barrier、S1 人工确认与 successor 注入尚未跑通完整窄测试。
- **下一步**：删除 `verifyContract` stub 与审计端口调用点；重写 `stages-gate-tools` / `stages-contract` / `main-bootstrap` 测试到 review/attach 合同；跑 `attach-lifecycle`、`tenure`、`stages-gate-tools`、`stages-contract`。

## D2 S5 单工作区编排尚未落地

- **缺口**：源码仍以 `fork_slices` / `join_slice` / worktree 为主路径；dogfood 设计要求单工作区、一个 Reviewer、一个 Swarm 看板，非空 findings `wake-all`，空账 + quiescence 后审计。`fork_slices` / `join_slice` / `gc_worktrees` / `abandon_slice` 暂不进 dogfood 面。
- **影响**：当前 S5 工具面、提示词与测试仍指向多 worktree，不能按新设计运行。
- **下一步**：S5 surface 改为单工作区；保留 `src/swarm/worktree.mjs` 为休眠代码，不接线、不注册。

## D3 真实宿主加载与端到端手工验收未完成

- **缺口**：`HACK.md` 记录 `omp plugin list` 指向 `/home/kunweiz/public/HerdchestraLite`，本工作区尚未证明被真实 `omp` 加载；没有真实 tmux 中的 S1→S5 小型使命，没有 `plans/<slug>/s5-report.md`，没有 `docs/manual-acceptance/clean-break/report.md`。
- **已有观察**：18.16.0 隔离副本曾观察到 S1 面板批准、S2 CASE 冻结、S3/S4 成功与 S5 fork；这些只覆盖旧 `advance` 面，且不是验收。
- **下一步**：重新 link 本工作区；按新 `review`/`attach` 生命周期跑最小使命（S1 人工批准 → S2–S4 自动 → 单工作区 S5 → K=1 审计）。证据写入 `docs/manual-acceptance/clean-break/`，不得用 `bun test` 代替。

## D4 S1 人工批准与新 attach 的接线未验证

- **缺口**：新 `attach_brainstorm` 需要在写盘后打开真实确认面板，`approve` 后 barrier，`revise` 清 attach-ready。当前 `advance_s1` 的面板与 pending 逻辑不能直接复用为 attach 语义。
- **下一步**：在真实宿主验证 approve / revise / pending / resume；面板必须展示磁盘上的 `plans/<slug>/s1-brainstorm.md`，不能只展示内存提交。

## D5 角色身份与宿主兼容

- **缺口**：角色收窄依赖 `ctx.agent`；17.x/16.x 未实测；`sessionFile` 父链在 17.3.5 无效，18.16 可兑现。当前 dogfood 面没有角色 admission。
- **下一步**：逐版本探测 `ctx.agent`；缺失时 fail-closed 并标 health degraded；不恢复独立 role-auth 注册表。

## D6 evaluator 限制

- **缺口**：`sequence`/`eduction` 物化受 200000 上限；`memoize` 线性扫描无上限/分桶；取消后的迟到结算只能诊断，不能自动归责；`call` pre-drain 无独立 watchdog，evaluator 无 drain 端口。
- **下一步**：把支持子集写进运行时提示；未支持组合返回明确错误；补上限或明确列为不支持。

## D7 全量测试矩阵与零剧透测试缺席

- **缺口**：未运行全量 `bun test` 并逐项核对 V01–V08、T01–T13、F01–F15；没有捕获真实出站 payload 的零剧透测试，也没有提示词工具名与注册表的一致性测试。
- **下一步**：先以窄测试保护新 `review`/`attach` 与单工作区 S5；真实出站夹具可用后再补零剧透行为测试。测试不是验收。

## D8 审计隔离与 S5 审计闭环

- **缺口**：`startAuditBatch`、`aggregate`、`writeS5Report` 已接线，但真实 `clj_auditor`、bwrap/tmux 隔离、`submit_case_audit`、全 PASS 报告与批准尚未跑通；旧设计中的 frozen 哈希复核已删除，需改为审计员自行观察工作区与 CASE 数据。
- **下一步**：在真实宿主用 `s2-cases.edn` 跑 K=1，再扩到 K>1；验证审计前后主工作区只读、证据路径、FAIL 返工与批准。

## D10 写入锁已改为令牌模型，代码仍用单一 $W$

- **已实现**：`src/util/broker.mjs`（模块级单例、`path`/`global` 队列、`realpath` 归一、字典序双令牌、`releaseOwner` 断线回收、`assertInvariant`）；`sandbox-worker.mjs` 的 `tokenAcquire`/`tokenRelease` 消息、`pathGate`、`globalGate`；`tools.mjs` 的 `write`/`mkdir`/`rm`/`mv` 走 `pathGate`，`call` 走 `globalGate`；`clj-main.mjs` 的 actor 消息处理、shadow `write` 在 `clj-core.cross-process.lock` 内落盘、worker 退出时 `releaseOwner`。
- **剩余**：`vfs.mjs` 的 `createWriteGate` 仍被 `runCall` 的 drain 使用；D12 清理后一并删除。
- **影响**：同一进程内不同路径的写入不能并行；同一路径的并发写没有进程内互斥；`call` 与 `mkdir`/`rm`/`mv` 之间只有跨进程粗锁可依赖。
- **下一步**：实现 `src/util/broker.mjs`（模块级单例、`path`/`global` 队列、`realpath` 归一、字典序双令牌、断线回收）；`sandbox-worker.mjs` 增加 `acquireToken`/`releaseToken` 消息；`tools.mjs` 的 `write`/`mkdir`/`rm`/`mv` 改为先申请令牌，落盘前取进程间粗锁；`call` 改持 `global` 令牌 + 粗锁；删除 `createWriteGate`。完成后删除本条。

## D11 read 与 cat/stat 的 stamp 表尚未统一

- **已实现**：沙箱 `context.stamps`；`cat`/`stat`/`read` 都写入该表；`read` 读前后各采一次 `lstat`，变化返回 `:changed-during-read`；`write` 把目标路径的期望 stamp 随 `hostWrite` 的 `__expectedStamp` 上传，`clj-main.mjs` 的 shadow `write` 在粗锁内比对，不匹配返回 `:FILE_CONFLICT`。
- **剩余**：`vfs.mjs` 的旧 `batch.readSet` 仍存在，D12 清理时删除。
- **影响**：写前无法发现目标文件在读取后已被他人修改；`read` 与 `cat` 的观察不一致。
- **下一步**：在沙箱会话内存建 `stamps: Map<absPath, {mtime-sec, mtime-nsec, size}>`；`cat`/`stat`/`read` 都写入 `stamps`；`write` 把目标路径的期望 stamp 随 `hostWrite` 上传，`clj-main.mjs` 的 shadow `write` 在令牌内比对，不匹配返回 `:FILE_CONFLICT`；`read` 读前后各采一次 stamp，变化返回 `:changed-during-read`。完成后删除本条。

## D12 VFS 旧实现仍在代码中

- **已完成**：`cat` 直接 `lstatSync + readFileSync + TextDecoder(fatal)` 并登记 observed fact；`stat`/`ls`/`glob` 已改纯 `fs`（`Bun.Glob`）；`classifyRead`/`classifyWrite`/`classifyMove` 已删除；未使用的 `vfsList`/`vfsStat`/`vfsRead`/`vfsWrite`/`vfsMkdir`/`vfsMove`/`vfsRemove` import 已清理；`tests/clj-core.test.mjs` 的旧 `:status :applied` 断言已删除。`bun test tests/sandbox-tools.test.mjs` 40 pass，`bun test tests/clj-core.test.mjs` 30 pass（classify 删除前的最近一次）。
- **剩余缺口**：`tools.mjs` 仍 import `createBatch`、`runCall`、`commit as vfsCommit`；`createContext` 仍构造 batch，`call` 路径仍把 `context.primary` 交给 `runCall` 并可能 drain overlay；`vfs.mjs` 中 `createBatch`/`commit`/`runCall` 与旧 `batch.readSet` 尚未删除。
- **影响**：旧 batch 壳仍在写入路径旁边，但 write/mkdir/rm/mv 已不经过 overlay，`hasOverlay` 实际为假。
- **下一步**：读 `runCall` 对 batch 的最小字段依赖，构造不含 overlay 的最小上下文；删除 `createBatch`/`vfsCommit` 与 `vfs.mjs` 对应实现；每步后跑 `tests/sandbox-tools.test.mjs` 与 `tests/clj-core.test.mjs`。
