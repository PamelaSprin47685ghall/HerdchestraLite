# Changelog

本文件记录本包的用户可见变化。

## [Unreleased]

### Added

- 三个独立入口：`src/main.mjs`、`src/tool-gate/index.mjs`、`src/editor-theme/index.mjs`；`package.json` 的 `omp.extensions` 与 `pi.extensions` 各列一次，单个入口失败不影响另外两个。
- 37 个单职责 `.mjs` 模块：入口与 `context/`、`prompts/`、`host/`、`pi-context/`、`pi-goal/`、`manual-acceptance/`、`tool-gate/`、`editor-theme/`、`util/` 九个子目录。
- 三个手动验收提交工具：`submit_manual_requirements`、`submit_development_guide`、`submit_coordination`，分别写 `requirements.md`、`development-guide.md`、`coordination.md`。
- 手动验收守卫：`propose_goal_draft` 的创建守卫与 `update_goal` 的完成守卫；gated 工具在审计器不可用时 fail-closed。
- 可见审计员：按 GoalCore 安装，校验文档后运行审计子进程，按 CASE 收集双分数并写 `report.md`。
- 工具门：向每个对象型工具 schema 注入两个必填参数，并在执行前剥离。
- 主题垫片：给宿主 TUI 原型补 editor-theme 面，初次失败后每次 `session_start` 重试；仍不可用时发 warning。
- `tests/` 五个开发者测试：`atomic-write`、`requirements`、`contract`、`scores`、`tool-gate`。

### Changed

- 从旧扩展目录的三个顶层 `.ts`（native 目录扫描加载）迁移为 `herdchestra-lite` 包：`.mjs` 入口经 `omp plugin link`、`package.json` 清单或 `config.yml#extensions` 加载。
- `src/main.mjs` 只负责装配；提示词、上下文投影、宿主适配、pi-context、pi-goal、手动验收分目录实现。
- 扩展内的 `/goal` 改名为 `/goal-x`，宿主内置 `/goal` 保持不变。
- 提示词、用户可见文案、错误消息、工具 label/description 保持旧实现原文，逐字迁移。

### Removed

- `vibeActive`：没有调用者，不产生行为。
- `verdictFromScores` 的重复标题分支：解析器在更早阶段已抛错，分支不可达。
- `rows.length === requirements.length` 检查：由前面的 missing/unknown 检查保证，冗余。
- `ROOT_DIR` 与 `DOCUMENT_ROOT` 的重复定义，以及三个文件名常量与无后缀常量的重复定义：合并为单一常量。
- 旧三个顶层 `.ts` 尚未归档：它们仍在旧扩展目录；归档步骤会把它们移到 `archive/`，本次未执行。

### Fixed

- 审计器安装改为按 GoalCore 跟踪：每次工厂重绑定或子会话拿到新的 GoalCore 时，用 `WeakSet` 记录已安装的 `runCompletionAuditor`，避免后绑定的 core 覆盖先前安装。
- `session_start` 的重试改用模块级“任一 core 已安装”标记，子会话 rebind 不再覆盖安装状态或静默漏装。
- gated 工具在审计器不可用时先重试当前 core 的安装，仍失败则抛出错误并拒绝执行，不会放行。
