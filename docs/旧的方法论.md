# 方法论映射

S1、S2、S3 是已冻结的验收合同：旧扩展仓库的 `docs/manual-acceptance/herdchestra-lite/requirements.md`（17 个 CASE）、`development-guide.md`、`coordination.md`。它们定义目标、实现边界与验收门；修改任何一份都会改变验收基线，本文件只读引用，不复制、不改写。下面把旧版 S1/S2/S3 使用过的决策与问题求解方法，落到新插件的设计、切片、门禁与验收上；每条都指向可检查的机制、文件、门禁或 CASE。

## 1. S1 · Howard 决策分析

- Frame：把“是否迁移、如何迁移”当作决策，而不是单纯任务；决策对象是加载契约与仓库形态，不是“把文件搬过去”。
- Objectives：正规插件形态、零功能损失、零宿主侵入。三者同时成立才算迁移成功。
- Alternatives：原地拆分、独立包、重写。选独立包，因为 `package.json#omp.extensions` 与 `omp plugin link` 是 omp 的正规加载面，旧仓库仍可回退；重写会丢掉 `text-baseline.json` 里的旧文案与错误消息证据。
- Information：17 个 CASE 是信息采集；加载契约（CASE-02/04）、提示词（CASE-05）、审计器与手动验收门（CASE-09/10）是信息价值最高的项，阈值最高为 95/90。
- Values：`user_score` / `developer_score` 双视角，`F = min(U, D)`，防止单边高估；见 `requirements.md` §5.2。
- 落点：`requirements.md` 的 CASE-02（95）、CASE-04（95）、CASE-08（95）、CASE-09（95）与 §5.2 双评分。

## 2. S1 · Dalio 原则

- Radical truth：现状是三个顶层 `.ts`、没有 `omp.extensions` / `pi.extensions` 清单、靠 native 目录扫描加载；`text-baseline.json` 的 `source_files` 记录了这三个文件与旧 README 的 sha256。
- Root cause：不是文件大，而是职责耦合 + 加载契约缺失。拆文件若不换加载面，问题仍在。
- Believability：以宿主源码与 `oh-my-pi/docs/extension-loading.md` 为准；本地对照 `omp-shims/` 与 `foreman/omp-foreman/` 的清单与目录组织，不以猜测为准。
- Pain + reflection：auditor 被子会话 rebind 覆盖是一次真实事故；修复改为 per-GoalCore `WeakSet`，写入 `src/pi-goal/install-auditor.mjs`，并在 CHANGELOG 的 Fixed 记录。
- 落点：CASE-15 信息零损失、CASE-17 版本漂移、`src/pi-goal/install-auditor.mjs`。

## 3. S1 · Bezos

- Work backwards：从 17 个 CASE 与用户使用场景倒推 37 个模块；模块清单落在 `development-guide.md` §5，目录落在 §3。
- Press release / FAQ first：S2 先定目标形态、目录与接口，再写实现；`development-guide.md` §3–§7 是这份“发布稿”。
- One-way / two-way doors：迁移到新包、接口与验收合同冻结是 one-way；切片合并、README/CHANGELOG 修订是 two-way。one-way 门前要求更高证据（G0、G3、G4）。
- 70% 信息：S1/S2/S3 在证据足够时冻结；剩余不确定性交给手工 CASE，不用自动化测试补洞。
- 落点：S1 的 17 个 CASE 与 `development-guide.md` §3–§4 的目标形态；one-way 判断在 S3 的 `coordination.md` §10 G0/G3/G4 执行。

## 4. S2 · Polya

- Understand：测绘旧代码、宿主、依赖；旧文件与哈希在 `text-baseline.json` 的 `source_files`，加载规则在 `oh-my-pi/docs/extension-loading.md`。
- Devise a plan：37 个单职责模块、单向依赖；清单见 `development-guide.md` §3、§5、§6。
- Carry out：S00–S10 切片；切片卡见 `coordination.md` §9。
- Look back：迁移映射（`development-guide.md` §12）、文本哈希（`text-baseline.json` 的 `prompts` 与 `throws`）、G1–G3 复核。
- Analogy：`omp-shims/` 的扁平 `.mjs` 工程结构、`foreman/omp-foreman/` 的插件清单与目录组织。
- Working backwards：从 `package.json#omp.extensions` 与 `development-guide.md` §9.0 的装配顺序倒推模块接口。
- Decomposition / recombination：按变化原因拆（§2.1），按 §9.0 组合；入口只组合，不承载业务。
- Generalization：三入口失败隔离（§2.3）可复用到其他 omp 插件。
- 落点：`development-guide.md` 第 3、5、12 节与 `coordination.md` §9 的 S00–S10 切片卡。

## 5. S2 · Schoenfeld

- Resources：宿主源码与 `oh-my-pi/docs/extension-loading.md`、旧实现、`omp-shims/`、DEV 的运行观测。
- Heuristics：单职责、依赖单向、原子写、文案逐字；见 `development-guide.md` §2 与 §9.1。
- Control：接口冻结、FREEZE WINDOW、G1–G3；见 `coordination.md` §11.3 与 §10。
- Beliefs：不手搓替代、不改宿主、不把自动化测试当验收；见 `development-guide.md` §1.3 与 `requirements.md` §4.4。
- Monitor / regulate：owner 自检、INT 复核、门禁失败回退、切片重排；见 `coordination.md` §7、§10、§11。
- 落点：S2 的 `development-guide.md` §2 与 §9.1 计划约束；在 S3 的 `coordination.md` §5、§8、§10、§11 执行。

## 6. S3 · Knuth

- Literate pseudocode：`coordination.md` §8.2 `Validate`、§8.3 `Schedule`、§8.4 `Merge`；先写过程、数据结构与不变量，再写实现。
- 数据结构与不变量：§8.1 的 `Slice` 记录先于调度；§5 的 INV-1/INV-2 等不变量先于合并。
- 落点：`coordination.md` 第 8 节。

## 7. All stages · 负向约束

- Goodhart：不以文件数、测试数、覆盖率替代 CASE 行为；自动化测试结果不得提高任何 `R`、`U` 或 `D`（`requirements.md` §4.4），CASE-15 只认逐字文案与行为证据。
- Chesterton's Fence：旧文案、旧错误消息、旧路径先保留再迁移；删除项必须在 `development-guide.md` §13 与 `CHANGELOG.md` 的 `### Removed` 有理由。
- 落点：CASE-15（信息零损失）；旧仓库的 `docs/manual-acceptance/herdchestra-lite/text-baseline.json`（P1–P8、throws、console errors、tool descriptions 的 sha256 基线，本包不复制、不改写）；`CHANGELOG.md` 的 `### Removed`。

## 8. 提示词执行

- 运行时事实：`src/prompts/method-discipline.mjs` 导出 `METHOD_DISCIPLINE`，内容是 `[METHOD DISCIPLINE]` 与按阶段分组的七条规则（S1: Howard/Dalio/Bezos；S2: Polya/Schoenfeld；S3: Knuth；All stages: Goodhart）；它不是设计说明，而是注入模型的提示词。
- 主系统提示：`src/main.mjs` 的 `before_agent_start` 在 `REPO_AWARE_RULES` 之后、context skill 之前加入 `METHOD_DISCIPLINE`。
- 审计员提示：`src/prompts/auditor.mjs` 在 `Rules:` 段落之前插入 `METHOD_DISCIPLINE`；旧提示词的其余文本一行不改，用前缀/后缀哈希复核。
- 约束：主会话模型与可见审计员模型都必须遵守；方法名只有改变决策或检查时才可引用，不得用来为已经决定的行为背书。
- 落点：`src/prompts/method-discipline.mjs`、`src/main.mjs` 的 `before_agent_start`、`src/prompts/auditor.mjs` 的 `Rules:` 前插入点。
