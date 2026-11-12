# Herdchestra Lite

Herdchestra Lite 是面向 `omp` 终端宿主的轻量多智能体研发插件。完整规格（S1–S5、门禁、看板、worktree、K 路审计）在仓库根 `AGENTS.md` 中；当前安装面只启用 ClojureScript 沙箱执行器，先验证最小可 dogfood 核心，再按扩张顺序接回编排层。

> **当前状态：clj 执行器 dogfood。** 清单入口只有 `src/clj-main.mjs`，注册 `clj_plan`、`clj_devops`、`clj_review`、`clj_worker` 四个工具。`/herd`、五阶段门禁、Scope 工具门、看板、worktree、审计与 TUI 均未装配。它们是保留代码，不是当前可用功能。
>
> 唯一规格仍是根 `AGENTS.md`；未关闭缺口在 `DEBT.md`；宿主与依赖实测在 `HACK.md`；架构装配笔记在 `src/AGENTS.md`。本 README 只描述当前可核对的事实，不把测试或冒烟当成验收。

## 当前启用面

- 清单入口：`package.json` 的 `omp.extensions` / `pi.extensions` 都只声明 `./src/clj-main.mjs`。
- 运行时依赖：`cherry-cljs@0.6.38`。
- 工具：`clj_plan`（只读）、`clj_devops`（只读 + `call`）、`clj_review`（只读）、`clj_worker`（读写）。
- 宿主工具黑名单：`read`、`write`、`edit`、`apply_patch`、`ast_edit`、`ast_grep`、`bash`、`exec`、`eval`、`glob`、`grep`、`find`。这些工具在 `session_start` 与 `before_agent_start` 时从当前 active 集合中移除；其他工具（`task`、`todo`、`web_search`、`lsp`、`debug` 等）保持原有激活状态。
- 命令：`/clj-status`（显示 Cherry 加载状态、黑名单与工具列表）。
- 未装配：`/herd*` 命令、`advance_s1..s4`、`ask_user`、`devops` 子代理、`realign_frozen`、`board_*`、`fork_slices`/`join_slice`、`submit_case_audit`、TUI 看板、Scope 注入/裁剪、tool-gate 入口。
- 同一会话内，程序续体（`park`/`unpark`）与 VFS 按工具角色缓存；不同角色不共享续体。
- 黑名单是减法的，不是白名单：实现只从 `getActiveTools()` 过滤，不重建一个“只允许这些工具”的列表；四个 `clj_*` 工具由注册方显式激活。
- `call` 子进程使用清洗后的环境：移除 `BUN_OPTIONS`、`NODE_OPTIONS`、`BASH_ENV`、`ENV`、`PROMPT_COMMAND`，避免宿主预加载钩子改变普通命令。每次调用的期限是 `1000ms + intent UTF-8 字节数 × 50ms`，固定白送 1 秒，不按角色加码。
- 普通 VFS 不再限制路径：`..`、绝对路径、越界符号链接、盲写与覆盖 `AGENTS.md` 都允许；写锁 `$W$`、批内 VFS 与已读文件的 `stamp` 冲突检查保留。

## 启用

```bash
omp plugin link /absolute/path/to/HerdchestraLite
omp plugin list --json
```

之后启动 `omp`，四个 `clj_*` 工具即出现在工具列表中。`/clj-status` 可在交互会话中查看 Cherry 是否加载。

直接提交 REPL 输入：任意数量的顶层表达式，最后一个值作为回执返回；不需要 `(defprogram ...)` 壳。`program_name` 可选，省略时自动生成。例：

```clojure
(let [src (cat {:path "src/config.mjs"})
      [b e] (where {:content src
                    :needle #"(def timeout-ms 30000)"#})]
  (write {:path "src/config.mjs"
          :content (str (subs src 0 b)
                        "(def timeout-ms 60000)"
                        (subs src e))))
```

`where` 零匹配或多匹配会挂起程序；用 `(unpark {:name "fix-timeout" :value [b e]})` 恢复。程序正常返回时，批内 VFS 在写锁内复核 `stamp` 后原子落盘；冲突返回 `:FILE_CONFLICT`，磁盘保持外部修改。

## 已做的真实冒烟（2026-11-12，不是验收）

- 宿主：`omp 18.19.0`；模型：`ctyun/deepseek-v4.1-flash`。
- `omp plugin link` 后，自动发现的插件入口成功注册四个工具。
- 真实模型调用 `clj_worker` 写入 `LINKED_PROBE.txt`；调用 `clj_plan` 写文件被 `:CAPABILITY_DENIED` 拒绝且未创建文件；调用 `clj_devops` 的 `(call {:command "printf devops-ok"})` 返回 `:completed` 与日志路径。
- 真实模型在同一会话中先让 `where` 多匹配挂起，再 `unpark` 恢复并成功落盘。
- 最终源码在独立 `/tmp` 工作区嵌套 omp 中执行裸 REPL：无 `program_name`、写 `/tmp` 根外文件、覆盖 `AGENTS.md`，返回 `:state :completed` 与两个文件内容。
- 真实宿主 `getActiveTools()` 捕获结果：`task`、`wait`、`todo`、`web_search`、`debug` 与四个 `clj_*`；黑名单中的 `read`/`write`/`edit`/`bash`/`grep`/`glob`/`find`/`eval` 均不在集合中。
- 本地直接测试覆盖 `cat`/`write` 的受保护提交、`where` 挂起/恢复、只读拒绝、`stamp` 冲突、黑名单过滤、环境清洗、期限下限与 `stat` 类型：`tests/clj-core.test.mjs` 15 pass / 0 fail。

这些只证明最小执行器在真实宿主可调用，不构成根规格的 CASE 验收，也不证明 `/herd` 可用。

## 本地开发检查（不是验收）

```bash
bun test tests/clj-core.test.mjs
bun run check
```

`tests/clj-core.test.mjs` 只依赖 `cherry-cljs`，不需要宿主包或模型。全量 `bun test` 仍需要宿主包链接；在 `DEBT.md` 的真实宿主与全量矩阵条目关闭前，不要把全量测试结果当成验收。

## 为什么先做这一层

Gall's Law 要求先让一个简单系统真正工作。当前最小闭环是：宿主能加载插件 → 模型能发现 `clj_*` → 解释器能执行 REPL 输入 → VFS 能在写锁与 `stamp` 下安全落盘 → 冲突与挂起可观察。只有这些真实成立后，接回阶段门禁和蜂群才有可靠地基。

扩张顺序（每步都必须先真实 dogfood 通过，再进入下一步）：

1. 恢复 tool-gate 的 Scope/intent 注入与剥离，验证真实出站 schema 与工具执行参数。
2. 接回 `advance_s1..s4`、`ask_user`、`devops` 与 S1 手工批准，先跑 S1–S4 规划闭环。
3. 接回看板、单 Slice Reviewer/Worker 与 `clj_review`/`clj_worker` 角色面。
4. 接回多 worktree、K 路审计与结案批准。

## 仍未完成/未验证的主要缺口

完整队列见 `DEBT.md`；当前最关键的是：

1. `/herd` 与五阶段门禁未装配；根规格的完整流程尚不可用。
2. tool-gate、Scope、角色收窄、`devops` 子代理未装配；当前四个工具是主会话可直接调用的 dogfood 面。
3. `clj-main` 没有角色 admission；任何会话都能选择任一 `clj_*` 工具。角色边界要随使命层回来。
4. 全量宿主测试矩阵、真实 TUI、worktree join、K 路审计与批准均未验收。
5. 当前真实冒烟只覆盖 18.19.0 主会话的四个工具，不覆盖 16.x/17.x、子代理、取消树与重启恢复。
6. 禁用 `read`/`write` 同时切断了宿主的 `xd://` 传输设备；当前 clj-only 有意接受这一代价。`eval` 被禁用后，宿主的 JS 求值面也不可用。

## 文档边界

| 文档 | 作用 |
|---|---|
| 根 `AGENTS.md` | 唯一规格（SSOT）；只有人类操作员可以修改 |
| `HACK.md` | 宿主、依赖、Git、验收环境的实测事实与复检步骤 |
| `DEBT.md` | 根规格要求但当前未做到的事项；关闭即删除 |
| `HISTORY.md` | 历史取舍、被拒方案、旧产物保全记录 |
| `src/AGENTS.md` | 全局架构装配笔记与单向依赖图 |
| `docs/manual-acceptance/clean-break/` | 开发本产品的 MANUAL ACCEPTANCE 文档；不是产品运行时 `plans/<slug>/` |
| `docs/旧的方法论.md`、`docs/旧的架构.md`、`docs/旧的设计.html`、`docs/讨论纪要.md`、`docs/兄弟项目参考.md` | 用户既有历史资料，保留只读，不因 clean-break 删除或改写 |

旧模块 `src/pi-goal/`、`src/pi-context/`、`src/editor-theme/`、`src/context/`、`src/manual-acceptance/` 已从工作树删除；不要恢复或重新 import。`src/main.mjs`、`src/bootstrap-main.mjs` 与 `src/tool-gate/index.mjs` 是完整装配的保留代码，当前清单不加载它们。
