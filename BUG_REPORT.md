# BUG_REPORT — abandon 后停靠程序反复出现

> 状态：根因已修复；本文件记录现象、根因与验证。

## 现象

对同一程序名反复 `(abandon {:name ...})` 后，系统提醒、`time_leap` 拒绝回执或停靠列表仍再次列出该程序。本会话出现过的名字包括 `write-probe`、`bug7-*`、`bug-report*`、`state-verify`、`ufss-*` 等。

## 根因

`src/clj-sandbox/evaluator.mjs` 的 `abandonProgram` 在 `PARKED` 分支只调用 `discardProgram` 并把 `program.state` 置为 `FAILED`，但**没有从 `session.programs` 删除**。`parkedNames` 只返回 `state === PARKED`，程序表却继续保留该程序，导致停靠视图与程序表长期不一致；重复 `abandon` 依赖状态已为 `FAILED` 才走删除分支，于是残留反复出现。

## 修复

- `abandonProgram` 的 `PARKED` 分支在标记 `FAILED` 后显式执行 `session.programs.delete(name)`，使程序表与停靠视图同源。
- `COMPLETED` / `FAILED` 分支继续删除并返回 `:cleared true`，重复 `abandon` 幂等。

## 验证

- `node --check src/clj-sandbox/evaluator.mjs` 通过。
- `env -u BUN_OPTIONS bun test tests` 全量回归（日志 `/tmp/bug7-test.log`）。

## 后续

- 回归测试建议：`park → abandon → listParked 为空`、`completed → abandon → 列表不含`、重复 `abandon` 幂等。
- 若仍残留，检查 `sandbox-worker.mjs` 的 `collectParkedList` 是否只返回程序表中确为 `:parked` 的 name。
