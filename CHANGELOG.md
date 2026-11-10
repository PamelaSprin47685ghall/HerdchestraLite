# Changelog

本文件记录本包的用户可见变化。

## [Unreleased]

### Added

- 建立 `herdchestra-lite` 包清单：`omp.extensions` 与 `pi.extensions` 各列三个入口，依赖固定为 `pi-context` 2.3.0 与 `pi-goal-x` 0.34.1。
- 三个空入口工厂：`main`、`tool-gate`、`editor-theme`，各自可独立加载。
- `src/util/atomic-write.mjs`：同目录临时文件写入后 `rename`，失败清理临时文件并抛出原错，返回 `{ existed }`。
- `src/util/errors.mjs` 与 `src/util/objects.mjs`：错误文本、错误码、对象判定与未知字段。
- `tests/atomic-write.test.mjs`：成功、目标已存在、失败保留旧文件、临时文件清理。

### Changed

- 无。骨架阶段不改变任何既有行为。

### Removed

- 无。旧实现仍留在原扩展目录，按域迁移后再移除。
