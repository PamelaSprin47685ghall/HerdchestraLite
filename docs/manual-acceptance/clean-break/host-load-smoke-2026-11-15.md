undefined
## Interactive `/herd` smoke (tmux)
- Command: tmux session running `omp`; send `/herd test` and Enter.
- Observed: `任务 01a1ddfb-850b-7797-974e-64e9f7e15cef 已创建，进入 S1。`
- Created `herd/01a1ddfb-850b-7797-974e-64e9f7e15cef/board.edn` with `:board-version 0` and `:tenure-id T-1`.
- Scope: verifies slash command registration, session task binding, and board initialization; not S1→S5.
