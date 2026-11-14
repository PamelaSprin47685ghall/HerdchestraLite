# src/herd/swarm — 看板积木

根规格是仓库根 `AGENTS.md` §3。本目录只实现单工作区看板的 CLJS 积木；`board_*` 宿主工具、S5 runner 与审计仍是后续接线。

## 依赖 DAG（只向下）

```text
edn
 └─ model
     ├─ ledger
     ├─ actors
     ├─ tasks
     │   └─ commands
     ├─ token
     └─ kernel ── store ── apply
                          └─ tools
```

- `edn.cljs`：纯值工具（`text?`、`read-field`、`canonical`、`digest-of`、snake_case→kebab-case）。
- `model.cljs`：板形状、枚举、`initial-board`、`valid-board?`、`ensure-board-shape`、`next-id`、`make-event`、责任集/可推进集、`wake-all`。
- `ledger.cljs`：Plan tenure 的 review 台账（findings upsert/delete、attach-ready）。
- `actors.cljs`：身份解析与退役 term 拒绝。
- `tasks.cljs`：任务规格、追加、`wait-for`/`condition:`、父子解除、动作辅助。
- `commands.cljs`：split/claim/finish/cancel/replace/release/reopen/comment/update/park-slot/register-actor/record-input/add-tasks/resolve-condition/start-action/set-action-phase。
- `token.cljs`：`take_or_die` 接受/裁决、持令者无责退休、失败移交。
- `kernel.cljs`：`apply-command` 编排（request 重放、版本守卫、事件、wake、退休、receipt）。
- `store.cljs`：`wx` 板锁、原子 `board.edn`、追加 `events.jsonl`、`checkpoint.edn`、内存/文件 store、`open-board`、`read-board`。
- `apply.cljs`：对 handle 的事务式 `apply-board!` 与两阶段 `take_or_die`。
- `tools.cljs`：11 个 `board_*` 工具定义、snake_case 参数、receipt 投影与 host 注册。

## 不变量

1. 内核纯函数；I/O 只在 `store`/`apply`。
2. 父项因子项完成只回 `:ready`；同回合关闭返回 `:PARENT_NOT_READY`。
3. 令牌竞争不可逆：赢或逻辑死亡；持令者责任集为空时同事务退休。
4. `request_id` 重放原样返回；不同载荷 `:CALL_REPLAY_MISMATCH`。
5. 缺失/损坏板不重建；有 ledger 时缺失返回 `:STALE_CONTROL`。
6. 两阶段取令在持久 store 上先接受、后裁决，版本因此多一次提交。

## 测试

```text
env -u BUN_OPTIONS bun test tests/cljs-board.test.mjs tests/cljs-board-store.test.mjs tests/cljs-board-tools.test.mjs
```

15 个用例覆盖 T01–T13 的核心交错、存储边界与工具面；测试不是验收。