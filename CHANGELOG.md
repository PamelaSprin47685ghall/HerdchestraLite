# Changelog

本文件记录本包的用户可见变化。

## [Unreleased]

### Added

- 三个清单入口：`src/bootstrap-main.mjs`、`src/tool-gate/index.mjs`、`src/bootstrap-editor-theme.mjs`；`package.json` 的 `omp.extensions` 与 `pi.extensions` 各列一次，单个入口失败不影响另外两个。
- `bootstrap-*` 入口采用惰性加载：只在默认工厂被调用时动态 `import()` 真实模块，因此 Node 可以直接 `import` 清单入口；真实实现仍在 omp 加载器内运行。
- 40 个单职责 `.mjs` 模块：入口与 `context/`、`prompts/`、`host/`、`pi-context/`、`pi-goal/`、`manual-acceptance/`、`tool-gate/`、`editor-theme/`、`util/` 九个子目录。
- 三个手动验收提交工具：`submit_manual_requirements`、`submit_development_guide`、`submit_coordination`，分别写 `requirements.md`、`development-guide.md`、`coordination.md`。
- 手动验收守卫：`propose_goal_draft` 的创建守卫与 `update_goal` 的完成守卫；gated 工具在审计器不可用时 fail-closed。
- 可见审计员：校验文档后运行审计子进程，按 CASE 收集双分数并写 `report.md`。
- 审计器按 GoalCore 跟踪安装：用 `WeakSet` 记录已安装的 `runCompletionAuditor`，工厂重绑定或子会话拿到新的 core 时不会覆盖或漏装。
- `goalService.apply` 审计闸门：在 `complete` 写入前检查本次审计批准（goal id + revision）；跳过审计、设置绕过与 Escape 强制完成都走同一闸门，`archive` 路径放行。
- 设置缺失判定：`pi-goal-x-settings.json` 不存在时视为未禁用；文件不可读、JSON 非法或 `disabled` 类型不符视为未知并 fail-closed。
- 审计员验收规则：TUI 观察必须用 tmux 发送真实按键并保存 pane capture；缺失依赖与无效入口分支必须在 `/tmp` 隔离副本中复现，不得改动产品或依赖。
- 工具门：向每个对象型工具 schema 注入两个必填参数，并在执行前剥离。
- 主题垫片：给宿主 TUI 原型补 editor-theme 面，初次失败后每次 `session_start` 重试；仍不可用时发 warning。
- `tests/` 六个开发者测试：`atomic-write`、`contract`、`goal-settings`、`requirements`、`scores`、`tool-gate`。

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
- 旧三个顶层 `.ts` 已从旧扩展目录顶层移入 `archive/`，不再被 native 目录扫描加载。

### Fixed

- 审计绕过：`update_goal({status: "complete"})` 直接经 `goalService.apply` 写入时，没有本次审计批准的完成会被拒绝；工具包装层在每次完成尝试前清除旧批准。
- 设置文件缺失误拒：设置文件不存在不再被当成读取失败；只有显式 `disabled: true` 才禁用审计器。
- Node 入口 import：清单入口不再静态加载 `main.mjs` 与 `editor-theme/index.mjs`，普通 Node `import` 三个入口返回 function，不再触发 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`。
