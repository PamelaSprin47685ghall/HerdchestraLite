> 2026-11-14：bwrap 已从根规格移除；以下 bwrap 记录仅作历史，不是验收要求。

# HACK.md — 宿主、nbb、park/unpark 与验收环境的实测记录

> 本文件只记录可复检的事实、复检步骤与尚未验证项。它不是规格，不替代根 `AGENTS.md`；不修改产品源码、根规格或其他文档。
>
> 记录时间：2026-11-11（初版）；2026-11-14 更新
> 记录者：DevOps 只读调查
> 记录范围：真实 `omp` 宿主（当前 18.20.0）、nbb、park/unpark、Git/worktree 历史、当前验收条件。
>
> **历史边界**：2026-11-11/12 的 `advance_*`、Scope、Cherry/CEK、worktree、Landlock 记录是旧实现的历史快照；当前行为以根 `AGENTS.md` 的 2026-11-13 生命周期修订与本文 2026-11-14 记录为准。历史记录保留用于对照，不得当作当前契约。

## 1. 环境快照

| 项 | 实测值 |
|---|---|
| 工作区 | `/home/kunweiz/Desktop/vibe/HerdchestraLite` |
| `omp` 命令 | `/home/kunweiz/.local/bin/omp`（287 MB 编译 ELF，2026-11-13） |
| `omp --version` | `omp/18.20.0`（2026-11-13；旧记录 18.16.0） |
| `omp` 实际入口 | `/home/kunweiz/.local/bin/omp`（编译宿主；旧记录指向 `node_modules/.../dist/cli.js`） |
| 实际运行时包 | `@oh-my-pi/pi-coding-agent@18.15.0`（仓库源码副本；旧记录 17.3.5 仅历史） |
| 仓库内 peer 类型包 | `node_modules/@earendil-works/pi-coding-agent@1.5.2`（**不是**当前运行时） |
| Bun | `1.4.4` |
| Node | `v26.10.0`（仅旁证；产品由 Bun/omp 加载） |
| Git | `2.56.0` |
| tmux | `3.7c` |
| uid | `1000`（非 root，权限拒绝分支可真实执行） |
| 当前 HEAD | `e25075d8703938289959cf8ebf3c6ac2916bb8fe` |

## 1.1 受控宿主补丁：ExtensionRunner capture（2026-11-13）

**目的**：默认模式 `clj_devops` 的 `(read ...)` / `(write ...)` 必须执行宿主官方
`read` / `write` 工具，禁止用 `node:fs` 绕过，也不接受“不可用就降级”的行为。宿主
`ExtensionAPI` / `ExtensionContext` 都没有公开 Runner 或 native 工具执行入口，唯一
可观察到的公开方法是 `ExtensionRunner.invokeNativeTool`。

**实现**：`src/host/native-runner.mjs`（由 `src/host/imports.mjs` 重新导出）

- 懒加载 `@oh-my-pi/pi-coding-agent/extensibility/extensions/runner`，包装
  `ExtensionRunner.prototype.createContext`；原方法先执行，返回的 ctx 记入
  `WeakMap<ctx, runner>`，同时保存最近一次 runner。
- `src/clj-main.mjs#activate` 在注册任何工具前 `await installRunnerCapture()`；
  捕获失败只记录 `unavailable`，沙箱返回 `HOST_API_MISMATCH`，绝不回退 fs。
- `detectHostTools` 用 `runner.hasNativeTool("read"/"write")`；`write` 仍在
  `.herd/locks/clj-core.cross-process.lock` 内执行 `__expectedStamp` 复核后调用
  `invokeNativeTool("write", params, {})`。
- 深路径导入只在 `native-runner.mjs`；`imports.mjs` 不因此 eager 导入宿主内部的
  runner 依赖图，sandbox-only 测试不加载宿主包。

**实测宿主**（2026-11-13）：

- `command -v omp` → `/home/kunweiz/.local/bin/omp`（287 MB 编译 ELF），
  `omp --version` → `omp/18.20.0`；仓库 `node_modules/@oh-my-pi/pi-coding-agent`
  是 18.15.0 源码副本，仅 `cherry-cljs` 为声明依赖。
- 编译宿主把扩展里的字面量动态 import 重写为
  `omp-legacy-pi-bundled:@oh-my-pi/pi-coding-agent/extensibility/extensions/runner`
  （单一模块注册表），因此补丁命中的正是宿主自己使用的 `ExtensionRunner` 类。
- 探针扩展在 `session_start` 中观察到 `captured=true`、`hasRead=true`、
  `hasWrite=true`；`invokeNativeTool("read", ...)` 读回 `package.json` 855 字节，
  `invokeNativeTool("write", ...)` 返回 `Successfully wrote 15 bytes ...`。
- 真实 `clj_devops`（`omp -p -e ./src/clj-main.mjs`）：
  `(read {:path "package.json"})` 回执含 `:host true` 与完整文件内容；
  `(write {:path ".herd/tmp-probe" :content "ok"})` 回执含 `:host true` 与宿主
  native write 成功文案，探针文件内容为 `ok`，完成后 `.herd/locks/` 为空。
  探针文件已删除。
- 本机不再全局导出 `BUN_OPTIONS`（`~/.zshrc` 注入已移除）；`omp` 的 zstd preload
  仅保留在 `~/.bashrc` 的 `alias omp=...` 中。测试需 `env -u BUN_OPTIONS`。

**测试**：`env -u BUN_OPTIONS bun test tests/clj-core.test.mjs
tests/sandbox-tools.test.mjs tests/clj-workers.test.mjs tests/ariadne.test.mjs`
→ 82 pass / 0 fail / 405 expect。新增 `delegates read to the captured native
runner` 与 `fails closed when no native runner was captured`。

**已知限制**：

- `callerContext` 不可得，native `write` 的 `toolCall` 元数据（LSP 批量刷新）不完整；
  需要宿主导出的 toolCall 才能补齐。
- worker 的 host-tool 桥没有把 `AbortSignal` 传进 `invokeNativeTool`；取消只终止
  沙箱程序，不会中止已进入 native 工具的那一步。
- `--no-tools` / 用户禁用 read/write 时 `hasNativeTool` 为 false，沙箱 fail-closed。
- 全局“最近 runner”只作为 ctx 未命中时的最后兜底；正常路径按 ctx 精确命中，避免
  多会话串用。

**回滚**：删除 `activate` 中的 `installRunnerCapture()` 调用与 `native-runner.mjs`，
`detectHostTools` 自然回到 false；禁止用 fs 作为回退路径。

## 2. 真实宿主

### 2.1 版本与加载路径

实测命令：

```bash
command -v omp
omp --version
readlink -f "$(command -v omp)"
node -e "const p=require('/home/kunweiz/node_modules/@oh-my-pi/pi-coding-agent/package.json'); console.log(p.name,p.version)"
```

实测结果：

- `omp` 是 `18.16.0`；入口解析到 `@oh-my-pi/pi-coding-agent/dist/cli.js`。
- 该包的 `package.json` 版本是 `17.3.5`。因此“CLI 版本”和“运行时包版本”不是一个数字；不得用 `18.16.0` 推算包内类型。
- 仓库 `node_modules/@earendil-works/pi-coding-agent@1.5.2` 只是旧 `pi-context`/`pi-goal-x` 的 peer 依赖；当前宿主运行时不是它。
- 本机 PATH 中没有独立的 `18.16.0` JS/types 包；不要伪造其类型。

### 2.2 插件链接现状

实测命令：

```bash
omp plugin list --json
omp plugin doctor
readlink -f ~/.omp/plugins/node_modules/herdchestra-lite
node -e "const p=require('/home/kunweiz/public/HerdchestraLite/package.json'); console.log(p.version,p.omp.extensions,p.dependencies)"
```

实测结果：

- `herdchestra-lite@1.0.0` 当前指向 `/home/kunweiz/public/HerdchestraLite`，**不是**当前工作区。
- public 副本仍是旧形态：三个入口、`pi-context`/`pi-goal-x` 依赖；其 `package.json` 的 `sha256=663a086b295bb111559f78c551cc916cb0b754e4b4bf5df9fab858b5a56433a9`。当前工作区已切换到两个入口 + `cherry-cljs@0.6.38`，两者不再逐字节相同。
- `omp plugin doctor` 对当前链接返回 `5 ok, 0 warnings, 0 errors`；它只证明旧链接健康，不证明当前工作区被加载。
- `omp plugin list` 的 manifest 仍列出 `bootstrap-editor-theme.mjs`。

**结论**：任何真实宿主测试必须先证明加载的是目标副本，而不是 `public/HerdchestraLite`。具体做法见 §6.1。

### 2.3 真实 hook 探针

在 `/tmp` 写了一个最小探针扩展（不修改产品源码），通过 `-e` 显式加载，使用 free 模型 `cline-pass/cline-free/solar-mini4` 运行：

```bash
omp --no-session --no-extensions --no-tools --no-lsp --no-pty \
  --no-context-files --no-skills --no-rules --auto-approve \
  -e /tmp/herd-host-probe.mjs -p \
  --model 'cline-pass/cline-free/solar-mini4' \
  --max-time 90 --max-cost 0.05 \
  "Call the probe_echo tool exactly once with value 'original'. Then reply exactly DONE."
```

探针注册 `session_start`、`before_agent_start`、`tool_call`、`tool_execution_end`、`agent_end`，结果写入 `/tmp/herd-host-probe.log`。

实测事实：

| 观察点 | 实测 |
|---|---|
| `ExtensionAPI` 方法 | `on`、`registerTool`、`registerCommand`、`registerShortcut`、`registerMessageRenderer`、`sendMessage`、`sendUserMessage`、`appendEntry`、`setActiveTools`、`getActiveTools`、`getAllTools`、`getCommands`、`setLabel`、`exec` 均为 function |
| Schema 工具 | `pi.typebox`、`pi.zod`、`pi.arktype` 均存在；`typebox.Type.Object` 可用 |
| `session_start` 的 `ctx` | `mode: "print"`、`hasUI: false`；`ctx.agent` **存在**，`kind: "main"`、`id: "Main"`、`name: "main"`；`ctx.signal` 为 `undefined` |
| `session_start` 的公开方法 | `getContextUsage`、`getSystemPrompt`、`ui.setWidget`、`ui.onTerminalInput` 均为 function |
| `session_start` 的 sessionManager | `getSessionId()`、`getSessionFile()`、`getArtifactsDir()`、`getBranch()`、`getEntries()` 等公开方法存在；`appendResetBoundary()` 写 `{type:"reset_boundary"}`，`appendCompaction(summary, shortSummary, firstKeptEntryId, tokensBefore, options)` 写 `compaction`；上下文从 `max(compaction, reset_boundary)+1` 开始；`context` 钩子的 ctx 可能不带 sessionManager，`session_start` 的 ctx 才可靠；`reset_boundary` 只管一回合；`hackContext` 的 `branch(parentId)` + `appendMessage` 在非空父节点处防止复发；`resetLeaf` 不工作，已删除 |
| `session_start` 的设置 | `ctx.settings` 不存在；`pi.pi.settings` 存在（旧 `settingsScope` 的 `pi.pi.settings` 路径有效） |
| `before_agent_start` 事件 | `reason: "prompt"`；`systemPrompt` 是 **string[]**（长度 2）；没有 `systemPromptOptions`；`prompt` 是 string |
| `tool_call` 事件 | 有 `input` 字段；返回 `{ input: {...} }` 后，`execute` 收到的是修改后的参数（`original` → `revised-by-tool-call`） |
| `tool_execution_end` | 有 `toolCallId`、`toolName`、`result`、`isError`；探针调用 `isError: false` |
| `agent_end` | 有 `messages`、`willContinue`、`type`；没有观察到 `awaitingAsyncWork`；本次 `stopReason: "stop"` |
| 工具注册 | 在 `--no-tools` 下，显式注册的 `probe_echo` 仍可被模型调用；`--no-tools` 只关内置工具 |

**重要**：实际运行时 18.16.0 有 `ctx.agent`，与静态源码 17.3.5 的 `ExtensionContext` 不一致。S3/S4 不得把 `ctx.agent` 当跨版本事实；如果使用，必须先做能力探测。

### 2.4 `runSubprocess` 探针（17.3.5 运行时；18.16 源码差异见下）

用另一个 `/tmp` 探针扩展，在 `session_start` 中调用真实 `runSubprocess`，显式传入：

```text
cwd=ctx.cwd
agent={name:"HerdProbe", description, systemPrompt, tools:[], spawns:undefined,
       model:["cline-pass/cline-free/solar-mini4"], thinkingLevel:"auto", source:"bundled"}
settings=Settings.instance
modelRegistry=ctx.modelRegistry
modelOverride="cline-pass/cline-free/solar-mini4"
artifactsDir="/tmp/herd-subprocess-probe"
sessionFile="/tmp/herd-subprocess-probe/parent-session.jsonl"  // 故意传假父链
restrictToolNames=true, enableMCP/Lsp/Irc=false
maxRuntimeMs=90000
```

实测结果：

- 子进程 `exitCode: 0`，`aborted: false`，`resolvedModel: "cline-pass/cline-free/solar-mini4"`，`resolvedModelIsFallback` 未出现（undefined）。
- `outputPath: /tmp/herd-subprocess-probe/<id>.md`（16 B）。
- 同目录生成 `<id>.jsonl`（11796 B）。
- 传入的假 `sessionFile` **没有被创建**；文件列表只有 `<id>.md` 与 `<id>.jsonl`。
- `settings=Settings.instance` 成功；`modelRegistry` 成功。
- `tools: []`、`spawns: undefined`、`restrictToolNames: true` 仍能完成 yield；`extractedToolData.yield` 长度为 1。
- `agent.source: "bundled"` 被接受。

**结论（17.3.5 版本范围）**：`artifactsDir` 是子会话 transcript 的实际落盘目录；17.3.5 的 `runSubprocess` 忽略 `sessionFile`。S1 CASE-23 的父链不能在 17.3.5 上按旧措辞兑现；不能伪造父链。

**18.16 源码差异（exact `/tmp/host-probe` 18.16.0）**：`src/task/executor.ts:4666-4669` 在打开 `<artifactsDir>/<id>.jsonl` 时传入 `parentSession: options.sessionFile ?? undefined`，因此 `sessionFile` 在 18.16 会写入子会话 `SessionHeader.parentSession`（前提是存在 `artifactsDir`）。H1 直接透传调用方/宿主提供的值，不做存在性/绝对路径预检（宿主自己处理失败）；无 `artifactsDir` 时仍允许内存态运行，`visibilityNote` 明示仅内存可见；`parentSessionNote` 只记录值已透传或未提供，不声称 17.x 一定建链，也不额外确认链接成功。17.x 仍会忽略该参数。

**父链公开面**：18.16 的 session 文件级父链用 `sessionFile`（→ `SessionHeader.parentSession`）；registry/Agent Hub 级父链用 `parentAgentId`（SDK 注册 `parentId`）与 `parentToolCallId`。H1 透传三者，并只报告 `parentSessionFile`/`agentLineage` 等事实字段，不另设链接成功状态。`history://` 是否能重放父链取决于宿主对 `parentSession` 的读取，不在此处承诺。

### 2.5 模型与默认值

- `omp models` 可列出可用模型；`cline-pass/cline-free/solar-mini4` 可完成短探针。
- 不指定 `--model` 时，本机默认模型解析为 `centos/claude-sonnet-5-5:medium`，随后回退到 `github-copilot/gpt-5.5`，请求返回 `400 model_not_available_for_integrator`。
- 真实验收必须显式 pin 可用的主模型与 `@task` 模型；不能依赖默认选择。

### 2.6 Readiness probe（首轮阻塞 → 修复后通过）

在隔离 `HOME` 中显式加载当前产品两个入口与一个只读探针（不加载 public 旧插件）：

```bash
H=$(mktemp -d /tmp/herd-ready-home-XXXXXX)
mkdir -p "$H/.omp"
ln -s /home/kunweiz/.omp/.env "$H/.omp/.env"   # 只共享凭据，不改用户数据
HOME="$H" omp --no-session --no-extensions --no-lsp --no-pty \
  --no-context-files --no-skills --no-rules --auto-approve \
  -e /home/kunweiz/Desktop/vibe/herdchestra-lite/src/bootstrap-main.mjs \
  -e /home/kunweiz/Desktop/vibe/herdchestra-lite/src/tool-gate/index.mjs \
  -e /tmp/herd-readiness-probe.mjs \
  -p --model 'cline-pass/cline-free/solar-mini4' --max-time 90 --max-cost 0.05 \
  'Reply with exactly READY_OK'
```

本次结果（`/tmp/herd-readiness-probe.log`）：

```json
{"entry":"main.bootstrap","status":"failed","capabilities":{"loaded":false},"degraded":true,"error":"readPendingGate is not defined: loaded"}
{"entry":"tool-gate","status":"ok","capabilities":{"hostVersion":"unknown","schemaInjector":true,"scopeLedger":true,"callMeta":true,"receiptPort":true,"roleGuard":true,"roleSurfacePort":true,"roleNarrowing":true,"hasGetActiveTools":true,"hasToolCallInput":true,"toolCallInputOverride":"auto","hasSetActiveTools":true,"workersInjection":true,"injectionReady":true,"toolCallReady":true,"toolCallGate":true,"beforeAgentStartReady":true,"turnReady":true,"agentEndReady":true,"cleanupReady":true,"missionPort":false},"degraded":false}
```

- `main.bootstrap` 失败点：`src/main.mjs` 第 997 行左右使用 `readPendingGate`，但第 23 行只从 `./stages/contract.mjs` 导入了 `createMission, listMissions, readMission`；缺 `readPendingGate`。这是 readiness 阻塞，不是测试环境错误。
- `tool-gate` 加载成功，hook 注册健康；`missionPort:false`，因为 main 未成功发布 mission 状态。
- 首轮失败时尚未启动“真实子代理 + 角色工具收敛 + hub 移除”验证；当次 `session_start` 观察到的 active tools 仍是宿主默认集（`read/bash/edit/eval/glob/grep/task/wait/todo/web_search/write/ast_edit/debug`）。修复后的子代理验证见 §2.6.1。
- 本次隔离 `HOME` 只 symlink `.env`；模型认证仍失败（`No API key found for cline-pass`），因此 readiness 判断只依赖扩展加载/health，不依赖模型回合。

主 owner 补上 `readPendingGate` 导入后，用同一命令复跑。`/tmp/herd-readiness-probe.log` 第 4 条显示：

```json
{"entry":"main","status":"ok","capabilities":{"stages":true,"scope":true,"swarm":true,"sandbox":true,"tui":true,"extensionEntries":2},"degraded":false}
{"entry":"main.bootstrap","status":"ok","capabilities":{"loaded":true},"degraded":false}
{"entry":"tool-gate","status":"ok",...}
```

同时 `session_start` 的 `activeTools` 已包含产品工具（`advance_s1..s4`、`board_*`、`fork/join`、`clj_*`、`submit_*` 等），证明两个入口加载成功。

**Readiness 结论**：`main.bootstrap` 与 `tool-gate` 均 `ok`，可以执行子代理启动验证。首轮 `readPendingGate` 失败记录保留，作为修复前后的对照。

#### 2.6.1 子代理启动验证（已执行）

目的：只验证“真实扩展是否加载、角色工具是否收敛、`hub` 是否被移除”，不验证 S1–S5 业务。

1. 在 `/tmp` 写一个父探针扩展：`session_start` 中调用真实宿主 `runSubprocess`（与产品 `spawnAgent` 同一底层路径），角色用 `Manual Auditor`（主模型策略，允许显式 pin 可用 free 模型），`tools:["clj_auditor","attach_case_audit","yield"]`，`artifactsDir` 指向 `/tmp`，`eventBus` 传父 `pi.events`，`preloadedExtensionPaths` 显式列为产品 `bootstrap-main.mjs`、`tool-gate/index.mjs` 和子探针。
2. 子探针扩展在 `before_agent_start`/`agent_end` 记录 `pi.getActiveTools()`；预期只含 `clj_auditor`、`attach_case_audit`、`ask_previous_scope`、`assume`、`yield` 一类角色工具，不含 `hub`、`task`、`read`、`write`、`edit`、`bash`、`grep`、`glob`、`ls`。
3. 子代理任务首行必须是 `[HERD_ROLE: <role>]`；当前 main 已删除 role-auth/nonce，H1 必须在用户任务前写入该首行，用户正文不能占据首行。主会话正文 token 不解析。
4. 主探针记录真实宿主 `runSubprocess` outcome（与产品 `spawnAgent` 同一子会话路径）和 child transcript 路径；产品 `spawnAgent` 的完整 `planSpawn` 包装未在本次探针中直接调用。
5. 判定：`main.bootstrap` 与 `tool-gate` health 均 `ok`；子活动工具列表无 `hub`/host 裸工具；角色工具存在；子代理能 yield；否则记录为 readiness/产品缺陷，不把源码当证据。
6. 不在主工作区写 `.herd/`/`plans/`；所有探针与 artifacts 放 `/tmp`；不删除已有证据。

**首轮结果（修复前，保留为对照）**：Manual Auditor 的 `yield` 被
`herd: yield is not in the Manual Auditor tool surface` 拒绝；根因是
`src/main.mjs` 的 `ROLE_SURFACES` 缺 `yield`，与 `tool-gate` 的
`COMMON_SUBAGENT_TOOLS` 冲突。owner 已修复：`ROLE_SURFACES` 的全部
subagent 角色加入 `yield`，Worker 的 `WORKER_BOARD_TOOLS` 加入
`board_take_or_die`；tool-gate 也有 `REQUIRED_ROLE_TOOLS`。

**修复后复测（真实隔离 omp，2026-11-11 16:30 左右）**：

- Reviewer（当前 main：`ROLE_SURFACES.Reviewer` 已移除 `ask_user`）：子扩展真实加载；
  `before_agent_start` active tools 为
  `["ask_previous_scope","assume","clj_review","submit_review","yield"]`；
  **不含 `ask_user`**；调用 `yield` 成功（`Result submitted.`），`exitCode=0`，
  `extractedYield=1`。非初任空账不会自动挂载 `ask_user`。
- Swarm Worker（当前 board 面）：子扩展真实加载；`before_agent_start` active tools 为
  `["ask_previous_scope","assume","board_cancel","board_claim","board_comment",
  "board_finish","board_park_slot","board_release","board_reopen","board_replace",
  "board_split","board_take_or_die","board_update","clj_worker","yield"]`；
  即 **11 个公开 board_*（含 board_take_or_die）**；`yield` 成功（`Result submitted.`），
  `exitCode=0`，`extractedYield=1`。
- 内部六个 board 动作（`board_register_actor`/`board_add_tasks`/`board_start_action`/
  `board_set_action_phase`/`board_resolve_condition`/`board_record_input`）不在
  Worker 的 `getActiveTools()`，也不在 `getAllTools()`；模型侧未注册，不能直接伪造
  调用。内部调用仍可由 `board.apply` 支持，但不在模型工具面。
- 子代理缺失 token：不发送角色首行；`before_agent_start` active tools 为 `[]`，
  `agent_end` 仍为 `[]`；fail-closed，没有角色工具。
- 子代理携带**已知角色** token（即使 nonce 未注册）：当前 main 无 nonce/role-auth，
  `before_agent_start` active tools 变为 Reviewer 面并成功 `yield`。这是当前设计
  “信任父进程首行 token”的结果；只有未知角色或缺失 token 才 `[]`。若不可信用户
  内容能占据子代理首行，存在角色自选风险；若父进程始终构造首行，则视为可接受。
  该场景与“主会话正文 token”不同，需在 S3/S4 明确威胁模型。
- 主会话正文 token：在主会话 prompt 中放入
  `[HERD_ROLE: Reviewer nonce=forged-main-token-current]`；`before_agent_start`
  与 `agent_end` 的 active tools 仍为主会话产品工具全量，没有变成 Reviewer
  角色面，也没有提权；主会话正文 token 被忽略。
- `hub` 移除：Reviewer/Worker 的 `getActiveTools()` 与 `getAllTools()` 均未出现
  `hub`；active 不含 `read`/`write`/`edit`/`bash`/`grep`/`glob`/`ls`/`task`。
- Worker `board_take_or_die` 的角色面已允许：active tools 含该工具，且真实调用
  到达工具 schema 校验（未出现 “not in ... tool surface”）。但本次没有真实
  board/slice 夹具，且 free 模型未按 schema 提交 `slug`/`slice_id`/`command`
  与 gate 字段；完整令牌竞争（T01–T13）仍需在 S5 的真实看板上验证，不能把本次
  调用当成 token 生命周期通过。
- 证据：`/tmp/herd-parent-roles.log`（Reviewer 结果）、
  `/tmp/herd-parent-worker-yield.log`（Worker yield 结果）、
  `/tmp/herd-parent-worker2.log`（Worker board_take_or_die 表面调用）、
  `/tmp/herd-parent-forged.log`（伪造子代理 token）、
  `/tmp/herd-readiness-probe.log`（主会话正文 token）、
  `/tmp/herd-child-probe.log`；artifacts 在 `/tmp/herd-role-*`。
- 父 `session_start` handler 在 30s 内完成单角色验证；Reviewer+Worker 连续两次
  spawn 仍可能触发 handler 30s 超时，因此应分角色运行；这是宿主 handler 限制，
  不是角色面失败。

**Board 路径复测**（直接加载 `src/swarm/board.mjs`，不启动模型）：

```text
openBoard('/tmp/herd-board-probe-...','probe-mission','probe-slice') -> durable=true
readBoard(handle) on missing board -> null
apply({command:{type:'registerActor',...}}) on missing durable board -> :STALE_CONTROL
createMemoryBoardStore({initial:initialBoard()}) + openBoard(...,{durable:false})
  -> readBoard -> board; apply(registerActor) -> ok, board-version=1
```

- `openBoard(root,slug,sliceId[,options])` 是唯一入口；`readBoard(handle)` 对缺失
  board 返回 `null`，不抛、不重建空 board。
- 缺失 durable board 的 `apply` 返回 `:STALE_CONTROL`，错误信息要求
  `forkSlices` 先播种 Slice board；没有静默新建空状态。
- 真实宿主 capability：`ctx.agent` 存在（main/sub 均有 `kind`），`pi.setActiveTools`
  是 function；子代理角色面实际被 `setActiveTools` 收敛，证明 `hasCtxAgent` 与
  `hasSetActiveTools` 为真。
- 当前 main（`98f42b47...`）实测试：子会话 `ctx.agent` 为
  `{type:object, kind:"sub", id:"Reviewer2-...", name:"reviewerprobe2", depth:1}`，
  `typeof pi.setActiveTools === "function"`；Reviewer active tools 收敛为
  `ask_previous_scope/assume/clj_review/submit_review/yield` 并成功 `yield`。

#### 2.6.2 `/herd` 首轮 TUI 探针（已执行）

在 tmux 中启动隔离 HOME 的真实 `omp`（TUI 模式），显式加载两个产品入口与只读探针，然后在
临时 root 输入 `/herd "S1 probe seed"`。结果：

- `before_agent_start` **确实触发**：`promptFirstLine="\"S1 probe seed\""`，`promptLength=15`。
- 首轮 active tools 恰好是 S1 面：
  `["clj_plan","advance_s1","ask_user","devops","submit_devops_report","ask_previous_scope","assume"]`。
- system prompt 长度 12709；探针检查 `advance_s2`/`advance_s3`/`advance_s4`/
  `fork_slices`/`join_slice`/`submit_review`/`attach_case_audit` 全部为 `false`。
- main 注册适配层合并 gate 字段后，以当前 `64c03055...` 复测：首轮 active tools
  仍正确为 S1 面；`clj_plan` 不再报 `:SCOPE_INVALID`，但模型调用仍只带
  `code/intent/program_name`，没有 `must_think_in`/`scope`；`intent` 到达
  sandbox 工具，后者报
  `{:code :INVALID_ARGUMENT :message "gate field reached the sandbox tool before stripping" :data {:field "intent"}}`。
  F1 仍未解决，只是错误从 tool-gate 拒收变成 sandbox 拒收；S1 首轮无法推进。
- 需要 schema/tool-gate owner 同时解决“provider 让模型看到并提交 gate 字段”与
  “execute 前真正剥离”两条路径；只在 `extensionToolApi.registerTool` 合并字段
  不足以让真实模型提交这些字段。
- `pi.getAllTools()` 的探针只看到 `parameterKeys=[]`（该宿主 API 可能不暴露
  schema），因此不能把注册表合并当作 provider 已注入的证据；以真实调用回执为准。
- **新 copy 独立复测（当前 workspace 复制到 `/tmp/herd-schema-copy-C3YJqs`，
  main sha256 与当前 workspace 同为 `1cbec656...`）**：
  - provider schema 已保留 gate 字段：`clj_plan`、`devops`、`advance_s1`、
    `submit_devops_report` 的 `properties` 含 `must_think_in`/`intent`/`scope`，
    `required` 也含三项；`ask_previous_scope` 仅 `i/query`，无 gate 字段。
  - 模型实际调用 `clj_plan`（program_name=probe, code=(defprogram probe [] 1)）；
    `tool_call` 探针在 G1 之后只看到 `code/program_name`（gate 字段已被剥离），
    `tool_execution_end` 为 `isError:false`，结果 `{:name "probe" :state :completed
    :value 1}`；未出现 `:SCOPE_INVALID` 或 “gate field reached sandbox”。
  - 因此 F1 的 schema 保留与 G1 剥离在本轮真实宿主 + 新 copy 上通过；`devops`/
    `advance_s1` 只验证了 schema 保留，未在真实 mission 中进入 handler。
- 证据：`/tmp/herd-herd-probe.log`、`/tmp/herd-herd-system.txt`；临时 root
  `/tmp/herd-herd-tui-*`、`/tmp/herd-schema-copy-C3YJqs`；未修改产品代码。

> 以上是历史快照记录。当前状态见 §2.6.3；不能把本节的 F1/F2/F3 记录直接当作当前源码的通过证据。

#### 2.6.3 当前状态（2026-11-11；本轮未运行 tmux/omp）

- **用户允许每批已知实操 bug 修完后进行一轮 tmux；发现新一批 bug 就停修，不连续跑第二轮。** 本轮只同步文档，未启动 tmux/omp。
- **F2/F3**：已在旧快照观测通过；当前源码与当前工作区尚未重新复测，不能标为当前通过。
- **F1**：仍按“修复中”处理。旧快照后来出现的 F1 记录不自动升级为当前通过；需要当前源码的真实宿主 provider payload 与 `tool_call`/execute 参数证据。
- **已源码修复、仅有窄自动化验证、未真实宿主复测**：
  1. `systemPrompt` 透传与 NUL 拒绝；
  2. `roleOf` 硬编码；
  3. `onStageChange`（阶段切换）；
  4. S5 空账问；
  5. 角色描述；
  6. `ex-message`；
  7. gate fail-open（此前的门禁静默放行）；
  8. `main` 缺 board 端口。
- **gate 字段缺失的两种原因必须分开记录**：
  - 模型实际没有提交 `must_think_in`/`intent`/`scope`（模型漏传）；
  - 旧版宿主在 G1 之前已经把字段预剥（宿主预剥）。
  前者需要修提示/调用路径；后者需要修宿主/入口顺序。不能把旧版宿主的预剥当成“G1 剥离成功”，也不能把模型漏传归因于宿主预剥。
- 本轮只更新文档，没有新增真实宿主证据；上述修复项在真实 `omp` 复测前都不能写成“已修复”或“已验收”。

#### 2.6.4 多工人修复状态（2026-11-11；未运行 tmux/omp）

- 用户允许每批已知实操 bug 修完后进行一轮 tmux；发现新一批 bug 就停修。本轮未启动 tmux/omp。
- 以下修复已有源码与窄自动化测试，但未真实宿主复测：
  1. S5 审计重试/恢复：`scheduleAuditRetry`、`auditReady`、`session_start`/`agent_end` 触发与冻结文件编辑导致的批次作废；`tests/s5-wiring.test.mjs` 是自动化集成，不是手工验收。
  2. `worktrees.edn` 作为真实 worktree 控制状态；`tests/worktree.test.mjs` 覆盖 EDN 形态。
  3. 看板 `wake-all` 与触发变更在同一 board-lock 事务内提交；`tests/board.test.mjs`/`tests/runner.test.mjs` 覆盖唤醒。
  4. 主装配的 durable board + $W$ + Holder `call` 窄场景：`writeGatePort`、`createWriteGateControl` 与 sandbox identity/claim 端口；`tests/main-consumer.test.mjs` 覆盖 durable board claim → protected write → Holder call。
  5. `call` 取消与日志：`callLogDir`、`:cancelled`/`:UPSTREAM_ABORTED`、不伪装成功；`tests/sandbox-tools.test.mjs` 覆盖。
  6. 冻结文件 human-edit realign：`realignEditedFrozen` 重读磁盘、更新 hash/revision、发对齐提示且不覆盖用户字节；`tests/main-bootstrap.test.mjs`/`tests/stages-gate-tools.test.mjs` 覆盖。
  7. Scope 准入/回合结算/归档/出站投影；`tests/scope.test.mjs` 覆盖。
- 这些测试是内部窄自动化，不是真实宿主或手工验收证据；`s5-wiring` 的自动化集成同样不能替代 CASE。
- 上述测试用例存在，不代表本轮已运行或通过；本轮未运行测试，也未运行 tmux/omp。
- `agent://evaluator` 仍有未解决限制，见 `DEBT.md` D7/D8；不能在本文写成已交付。

#### 2.6.5 Evaluator remaining-evaluator t3 与 lazy-fix t14-t18 当前交付（2026-11-12；未运行 tmux/omp）

- **t2 已修复/接入（窄测试报告）**：transducer 回调改为 LazyStream `call` 描述符，解释器 `fn`、异步 capability、异步 reducer 可参与；`transduce` 有异步 reduce 帧并支持 `reduced`/`unreduced`；`completing` 为自定义 callable；`sequence` 返回惰性 LazyStream，未消费不拉取；`eduction` 返回可重复消费的惰性描述；三参数 `into` 迁移为 HOF，支持 LazyStream/core lazy seq/异步 xform；`catch` 的 class 后缺少绑定符号在解析期 `:INVALID_ARGUMENT` 拒绝；此前 memoize/doto/多重 catch/端口 reject 语义保持。t2 报告 158 pass / 0 fail，文档更新者未重跑，不是验收证据。
- **t3 修复 halt-when 异步/最终值（窄测试报告）**：新增 `TransducerHalt` 携带命中值与 `retf`；`transducerLazy` 捕获后把 `haltValue`/`haltRetf` 写入 LazyStream 的 `transducerContext`，`sequence`/`eduction` 只停止输出；异步谓词/retf 不再返回 `:CAPABILITY_DENIED`，异步路径由 `transducerItemLazy` 调用谓词并在命中时抛 `TransducerHalt`；异步 `transduce` 结束时读取 context，走 `retf(acc, 命中值)` 或直接命中值，再走 reducer completion arity；`into` 异步路径改为 `startTransduceReduce` + 逐项 `conj`，保留 `acc` 供 `retf` 使用；同步 Cherry 与异步 LazyStream 两条路径最终值一致。t3 报告 `bun test tests/evaluator.test.mjs tests/sandbox-tools.test.mjs tests/main-consumer.test.mjs` = 159 pass / 0 fail、961 expect() calls、Biome clean；文档更新者未重跑，不是验收证据。
- **t3 行为覆盖（窄自动化）**：`(into [] (halt-when pred) coll)` 返回命中值；`(transduce (halt-when pred) + init coll)` 返回命中值；`retf` 收到当前 `acc` 与命中值并决定最终值；`(vec (sequence (halt-when pred) coll))` 返回命中前输出；`eduction` + `halt-when` 在 `into` 中传递最终值；同步 builtin 谓词与异步解释器谓词两条路径。
- **仍未实现/受限**：`sequence`/`eduction` 在需要物化的消费者上仍受 200000 `:LIMIT_EXCEEDED`；`memoize` 线性扫描、无上限/哈希分桶；callable 对象经 `ednSafe` 进 receipt 是既有问题。
- **t14 修复 D8 的 outcome-unknown 回执与迟到结算读取（窄测试报告）**：`awaitAsync` 携带 `{capability, argument}`；abort 时 `waitPending` 把未在 100ms grace 内结算（或 grace 内 reject）的 capability 记入 `program.abandonedCapabilities`（`:outcome-unknown`，保留迟到的 `settled`/`result`/`error` 更新，finish 置空防重放）；aborted receipt 新增 `:interrupted-capabilities` 数组；新增导出 `abandonedCapabilities(session,name)` 读取活记录，值形状改为 `renderReceipt` 可打印的数组/Map。程序仍 failed/aborted，迟到结果只进诊断记录、不作为程序结果；capability 只调用一次，不自动重试。测试断言 receipt 字段、`renderReceipt` 文本可见性，以及 400ms 后迟到结算可读且程序仍 failed、副作用只一次。t14 报告 evaluator 105 pass / 0 fail、724 expect；evaluator+regex-worker+sandbox-tools 172 pass / 0 fail、1051 expect（该套件在最后两条 render 断言前运行、源码未再改）；Biome clean。
- **t15 补会话级 abandoned 账本与工具回执可见性（窄测试报告）**：新增 `session.abandoned: Map<program name, live pending records>`；`waitPending` abort 时同时写 program 快照与 session 账本，同名新程序启动只替换 `session.programs`、不覆盖账本；`abandonedCapabilities(session,name)` 改读 session 账本，未知 name 返回 `[]`，迟到 settle 后再次调用可见；`tools.mjs#runExecution` 在每次 receipt 返回前调用该导出，非空则以 `abandoned-capabilities` 附加到同名程序回执，模型可在后续同名程序（failed 后可复用，§4.4.7）回执看到迟到结果，successor 代码也可直接调用导出。未新增 capability/tool，未对 generic capability 调 `markUncertain`，`call` 的既有 board 责任路径不变。测试覆盖：真实 abort pending slow capability 的 receipt 快照（`:outcome-unknown`、settled false、calls=1）；同名新程序 completed 7 后记录仍在；450ms 后 `abandonedCapabilities` 显示 settled true/result `late-result`/outcome `:completed`，程序仍 failed、副作用一次；`renderReceipt` 可见性；sandbox-tools 预置 `session.abandoned` 后同名程序回执解析出 `abandoned-capabilities`。t15 报告 evaluator 105 pass / 728 expect；evaluator+regex-worker+sandbox-tools 173 pass / 0 fail / 1063 expect；Biome clean。
- **t17/t18 端口 watchdog 撤回与 deadline park 恢复（窄测试报告）**：t17 曾新增固定 5s `PORT_WATCHDOG`，t18 已删除该常量、`settleTrackedPort` 的独立 timer race、commit 超时 `:LIMIT_EXCEEDED` 分支与 discard watchdog 参数，以及只证明新超时的测试。`commit`/`discard` 恢复为只 race port promise 与 program control；intent deadline 到期进入 ParkSignal/parked，保留 `pendingCommit`/`pendingDiscard`，unpark 继续等同一 promise；取消仍走 100ms grace → `:outcome-unknown`/`:uncertain`，不重放。t14/t15 的 abandoned capability、`:interrupted-capabilities`、`session.abandoned` 与工具回执可见性全部保留。t18 报告 evaluator 105 pass/728 expect；evaluator+regex-worker+sandbox-tools 178 pass/0 fail/1095 expect；Biome clean。
- **D8 剩余限制（t18 后）**：generic capability 没有 board `actionId`，evaluator 不能也不应代替 runner/board `markUncertain`，归责仍须 C4/上层依据 receipt/ledger 核对；账本为 session 生命周期，随 session 丢弃/进程退出清理，同名复用不覆盖，未做 TTL/逐条 dismiss（避免静默丢证），长期会话硬上限需单独设计；同名工具回执会同时出现 `interrupted-capabilities` 快照与 `abandoned-capabilities` 活记录，两者语义不同且未去重；不再有固定端口 watchdog，`call` 的内部 pre-drain 没有独立 watchdog；evaluator 无 drain 端口，D8 的 drain 明确未支持。以上均未真实宿主验证。
- 以上均不是真实宿主或手工验收证据；本轮未运行测试、tmux 或 omp。

#### 2.6.6 Auditor per-auditor 执行器（2026-11-12；t8/t11 隔离 smoke 已跑，非验收）

- 早期仅记录源码状态、静态实验与窄测试；2026-11-12 的 t8 已跑真实 bwrap + private tmux 生命周期，t11 已在其私有 tmux 内启动嵌套 omp 18.18.8 做加载/连接 smoke。两者都不是审计验收，也不替代手工验收。
- **当前源码状态**：`src/sandbox/{bwrap,landlock,session,model-worker}.mjs` 已提供 per-auditor 的 bwrap + 两阶段 Landlock + 私有 tmux socket/session；`createAuditorSandbox` 生成 auditTmp/socket/session 并在审计开始时启动。`src/clj-sandbox/tools.mjs` 的 auditor 能力矩阵含 `call`，但 `auditorSandboxReady` 要求 `sandbox.available === true` 且 `roots.io.runCommand === sandbox.runCommand`；`CALL_FORBIDDEN_ROLES` 为空。`src/main.mjs#AUDITOR_SANDBOX = sandboxCapability()`：available=true 时 `ROLE_SURFACES` 含 `clj_auditor`、注册工具、`runMissionAudit` 放行、`attach_case_audit` 接受；不可用时 blocked/`:CAPABILITY_DENIED`，没有静默回退。隔离语义：宿主 TCP/Unix socket 不可达，框架 fixed provider relay socket 按设计可达且只转发到 pinned provider；credentials stay host-side 仅限 proxy mode，env-only provider 由 `selectAuditTransport` 拒绝。本机 `sandboxCapability()` = `{available:true, bwrap:'/usr/bin/bwrap', tmux:'/usr/bin/tmux', bun:'/home/kunweiz/.bun/bin/bun', landlockAbi:11}`。
- **nested-auditor 边界**：`src/sandbox/bwrap.mjs#validateSandboxPaths` 在 `realpath(tmpdir())` 位于 auditTmp 内时以 `:CAPABILITY_DENIED` 拒绝，错误为 “nested omp is the test subject, not the auditor”。原因是 host auditor subagent 在宿主运行，bwrap 只是它的 `clj_auditor.call`/TUI 工具面；nested omp 的 `TMPDIR=auditTmp/tmp` 不能冒充 auditor，否则会与 host auditTmp 校验冲突。host auditor 的正常 TMPDIR 不受影响。`tests/sandbox-isolation.test.mjs` 覆盖 nested 拒绝；sandbox 两文件 35 pass / 0 fail（因 `/tmp` 满，TMPDIR 用 `/home/...`），不是真实 tmux/omp 证据。
- **提示词追加**：`src/swarm/auditors.mjs#ensureIsolationPaths` 在 `buildCaseAuditorPrompt` 结果之后追加 `## Framework isolation paths`，提供实际 auditTmp/socket/session；canonical `herd-<slug>-<caseId>` 与 `/tmp/herd-audit-<slug>-<case>-<uuid>` 仍是规范模板，实际路径由 runtime 覆盖。规范原文不改写。
- **真实 bwrap + private tmux 生命周期（t8，2026-11-12）**：用真实 `createAuditorSandbox` 启动 `available:true`、`landlockAbi:11`、`landlockNetwork:true`、`landlockPathnameUnix:true` 的沙箱与私有 tmux session/socket；跨调用 `runCommand` 观察到进入同一沙箱；主工作区只读验证通过（marker 可读、写入返回 `Read-only file system`、宿主 probe 文件不存在）；关闭后 bwrap、auditTmp、socketDir 均消失且无嵌套进程残留。该轮无产品 bug，但未提交/评分/批准任何审计，不构成验收。
- **嵌套 omp 18.18.8 加载/连接 smoke（t11，2026-11-12）**：在 `createAuditorSandbox` 私有 tmux 中启动真实嵌套 omp 18.18.8（产品 main sha256 `3a05e48b1a0a4d7ac2c76de62f1762d19ff5aee70907c624b4ea1bfed50bea6f`），UI 启动、显式加载当前产品扩展，active tool surface 含 `advance_s1..s4`、`clj_plan/clj_devops/clj_review/clj_worker`、`devops`、`submit_devops_report`、`attach_case_audit`、`ask_user`、`ask_previous_scope`、`board_*`；通过固定 host-side 内存 canned responder（OpenAI-compatible `127.0.0.1:18443`）回复 `D12-NESTED-OK`，provider request 2 次、relay HTTP 4 次、toolCalls 0；工作区只读与关闭清理同 t8。fake 8k context 触发 compaction warning，归因 smoke 模型上下文不足，未判产品 bug。该轮仅 UI/连接/工具面 smoke：无真实模型、无角色审计、无工具调用、无提交/评分/批准。
- **已撤回的假阳性**：此前有一轮 plain host 运行一度报告产品扩展已加载；复查确认产品安装未实际生效，该阳性结论撤回，不作为 D12 证据。
- **仍未验证**：真实宿主 socket 不可达的破坏性证明、“fixed provider relay 可达且只转发 pinned provider”的完整语义、两阶段 Landlock 在完整审计生命周期内的强制、nested omp 的 prompt 追加顺序与真实模型 egress、`clj_auditor.call` 实际执行、K 路审计与 per-auditor 资源回收、真实 18.16.0 宿主基线（本 smoke 为 18.18.8）都未验证。不能写成“隔离已验证”或“审计已验收”。
- **线程继承（源码已确认，未运行验证）**：`model-worker.mjs` 在同一个 Worker 内先 `applyNetworkLandlock` 再 spawn bwrap，bwrap 子进程因此继承 network 域；bwrap 内 CLI 再 `applyUnixSocketLandlock` 后 exec tmux。若把 bwrap 改到主线程或其他 Worker 启动，network 域不会随子进程继承，必须保持同线程。
- **实现方解释**：用户未对 per-auditor 临时执行器作确认；实现方按任务生命周期把它解释为随审计创建、随审计回收的临时资源，而不是跨任务常驻服务。该解释需真实隔离验证；若验证发现与根 §1/§10.1 冲突，须由人类修改根规格，不由实现方自行裁决。
- **早期静态实验仍保留的教训**：整根 `--ro-bind / /` 不能阻止宿主 Unix socket `connect()`；必须用白名单挂载树 + 私有 `/tmp`/`/run`/`/proc` 隐藏宿主 socket。`--unshare-pid` 后一次性 bwrap 没有跨 `call` 的进入通道；当前源码改用每审计员一个 bwrap 内的 `tmux -D` 前置 server。t8/t11 已观察到该 server 的跨调用与清理行为，但宿主 socket 不可达仍需破坏性验证。
- **窄测试**：`tests/sandbox-isolation.test.mjs`、`tests/sandbox-network.test.mjs`、`tests/sandbox-tools.test.mjs`、`tests/audit.test.mjs`、`tests/main-bootstrap.test.mjs`、`tests/main-consumer.test.mjs` 合计 125 pass / 0 fail，Biome clean；覆盖 bwrap 参数、网络/Landlock、auditor sandbox factory 与审计启动拒绝。窄测试本身不是真实宿主或手工验收证据；t8/t11 的隔离 smoke 同样不是验收。
- **窄验证边界**：网络层只有 `sandbox-network` 的 TCP/UDP/pathname/abstract socket 测试；凭据/平台（嵌套 omp 的 `~/.omp/agent`/profiles 复制提示、平台路径假设）只有提示词/静态检查，没有真实宿主验证。不能把窄测试当成真实隔离或凭据隔离证据。
- **DEBT**：见 `DEBT.md` D12；sandbox 能力缺失时显式拒绝，能力可用时也不宣称已隔离；t8/t11 只是 smoke，真实审计验收前保持 DEBT 打开。

#### 2.6.7 S1 手工批准的隔离实测（2026-11-12；AI 模拟操作员，非人类/生产）

- **场景**：真实 18.16.0 隔离副本 `herd-real-s1-3`，根 `/home/kunweiz/.cache/herd-real-s1-3-20261112-081517`，产品 main sha256 `5cd9b46711bb2a64cba5649ce17aa2424c92ea9fcbed987320168f01c2dc2933`，slug `mission-slug-f6c216`；固定 host-side relay 以只读 SQLite handle 读取单个 Mistral `api_key` 行，密钥只存于 relay 进程内存。未复制、链接或写入真实凭据数据库；子 HOME、model seed 与子进程 env 只含 `herd-local-placeholder`，日志与 argv 不含真实密钥。
- **操作员**：AI 模拟操作员，`humanApproval:false`、`productionApproval:false`；只在本次隔离测试内有效，不冒充人类批准或生产授权。
- **面板观察**：真实自定义 overlay；文档 1884 bytes、49 body lines；`position:"1-49/49"`，标题、首末标题与全文同时可见；默认选择 reject；提示键位为 `↑/↓ PgUp/PgDn Home/End 滚动 · ←/→/Tab 选择 · Enter 确认 · Esc 取消`；实际发送 `Home`、`PgDn`、`Right`、`Enter`，用 Right 选中 `[ 批准 ]` 后 Enter。
- **结果**：`advance_s1` 的 `tool_execution_end` 为 `isError=false`（2026-11-12T00:22:17.483Z）；missionStage=`s2`；s1Frozen=true；S2 披露观察到 `James Bach`、`Glenford`、`PASS threshold`。
- **随后停止**：模型提交 `advance_s2` 被 S2 校验器以 `:INVALID_ARGUMENT` 拒绝（`s2 markdown has no "### CASE-*" headings`，00:22:29.534Z）；watchdog 按首未知错误规则停止整轮（00:22:29.925Z），kill omp/relay，保留日志，无自动重试。该拒绝是模型内容错误被产品正确拒绝，不是产品 bug。
- **历史注记（D13 迁移后）**：该轮发生在 S2 仍从 Markdown 解析 CASE 的旧实现；迁移后 `s2-manual-tests.md` 只写方法论，正文无 CASE 不再是错误，CASE 只由 `advance_s2.cases` 严格 Schema 与冻结 `cases.edn` 校验。原始观察保留，不能作为当前校验行为的说明。
- **限制**：文档 49 行恰好一屏，Home/PgDn 未产生视口变化，滚动行为未实证；旧场景 `herd-real-s1-2` 仍停在旧 S1 门禁等待（旧 relay 18443、旧 omp/watchdog 存活，未向其发送批准）。本观察只覆盖 S1 面板/批准/晋级/披露与一次 S2 校验拒绝，不是完整使命或手工验收。
- **证据**：`logs/AI-OPERATOR-APPROVAL.json`、`logs/watchdog.jsonl`、`logs/operator-panel-{initial,home,pgdn,approve-selected,after-approval}.txt`、`logs/WATCHDOG-STOP.txt`、`copy/.herd/missions/mission-slug-f6c216/mission.edn`。

#### 2.6.8 D13 阶段控制态 clean-break（2026-11-12；源码与组件窄测，非验收）

- **源码已迁移（只读核对）**：`contract.mjs` 的 `:frozen` 固定为七项 `s1`/`s1-summary`/`s2`/`s2-cases`/`s3`/`s3-modules`/`s4`；S1 summary 经 `saveS1Summary` 写入并随 S1 冻结；S2 经 `commitS2` 在同一使命事务内写/复用 `cases.edn`、保存方法论文档并冻结 `s2-cases`；S3 完整 `modules`（含 `mapped_cases`）写入 `mission.edn :s3-modules` 并以 inline 规范 EDN 哈希冻结；S4 完整 slices 写入 `:s4-slices`，覆盖校验读取冻结 CASE；`contract-line` 只从七项渲染，陈旧仅告警。`realign` 支持 `s1-summary`/`s2-cases`/`s3-modules`/`s4-slices` 目标，映射失效时必须同次给完整 modules/slices，否则 `:MAPPING_REALIGN_REQUIRED`，不等待人工。
- **审计与看板装载**：`main.caseSpecsFor` 从冻结 `cases.edn` 与 `s1-summary.md` 读取，再重读 mission 比对两哈希；`runMissionAudit` 把 `caseEdn`/`s1Summary` 的原始字节与哈希传给 `startAuditBatch`；`auditors` 在启动任何审计员前，用 contract port 返回的活 `s2-cases`/`s1-summary` 哈希再绑定一次，失配即 `:CONTRACT_HASH_MISMATCH` 且零启动。`board_finish` 的 `dependency_paths` 由 `validateDependencyPaths` 限定为工作区相对路径，`wait_for` 支持既有子任务 ID 或 `condition:<key>`；`clj_plan` 可读 `cases.edn`，`clj_auditor` 拒绝读取它。
- **组件窄测报告（未统一重跑，非验收）**：stage-parsers t15 报告 `main-bootstrap`+`main-consumer` 47 pass、`stages-gate-tools`+`parsers`+`contract` 67 pass，含真实 S1 reject→revise→approve 与 S2 `commitS2`→`readS2Cases` steps 数组；coordination 报告 contract 38 pass/552 expect、`s5-wiring` 1 pass；runner 报告 `main-bootstrap`+`runner`+`s5-wiring` 101 pass/755 expect，含 CASE-ID mapping realign E2E；audit-isolation-review 报告 audit/scores 70 pass/507，但一次组合运行出现 2 个 `main-bootstrap` structured-realign `s3-modules mapped_cases` 断言失败（发生在并行的 main/contract 编辑期间）；lazy-fix t16 报告 sandbox-tools 60 pass/286、evaluator+regex-worker+sandbox-tools 178 pass/1095，并确认 Plan/Auditor 的 `cases.edn` 边界。
- **未完成**：没有真实 `runMissionAudit → startAuditBatch` 的端到端证据，没有真实审计提交/`s5-report.md`/一次性批准；rS3 已到 S2 并在 S3 停止（见 §2.6.9），S3 修复后的真实重测尚未给出结果。没有统一全量套件收口；`realign_frozen` 在 S2–S4 的 activeTools 表面、成功 realign 的 `auditInvalidated` 与取消/接力的观察者退休仍无独立断言；真实 17.x/16.x 未逐版本验证。
- **证据**：`src/stages/contract.mjs#FROZEN_KEYS`/`commitS2`/`realign`；`src/stages/parsers.mjs#normalizeCaseSpecs`；`src/stages/gate-tools.mjs#advanceS1..s4`；`src/main.mjs#caseSpecsFor`/`runMissionAudit`/`realignEditedFrozen`；`src/swarm/auditors.mjs#startAuditBatch`；`src/swarm/board.mjs#validateDependencyPaths`；`src/clj-sandbox/tools.mjs`。详见 `DEBT.md` D13。

#### 2.6.9 真实隔离 rS3：结构化 S2 通过、S3 校验缺陷与 stage-parsers t16 修复（2026-11-12；非验收）

- **场景**：真实 18.16.0 隔离副本 `herd-real-s1-5`，根 `/home/kunweiz/.cache/herd-real-s1-5-20261112-124245`，产品 main sha256 `6482899b11a93a69f4ba700aaab1affcd1475b48fabf07d31fef780a1b2baefb`，slug `mission-slug-791e6f`；AI 模拟操作员，`humanApproval:false`、`productionApproval:false`。
- **S1/S2 真实结果**：S1 面板在真实可滚动 overlay 中显示 `1-57/60`（Home）、PgDn 后 `4-60/60`，默认拒绝，Right 选中批准后 Enter；`advance_s1` 成功进入 S2。S2 **首次调用即成功**：`cases.edn` 冻结 5 个结构化 CASE（`CASE-01..05`，路径为正常/错误/边界/并发/恢复；`case-id`/`path`/`threshold`/`steps`/`expected`/`rubric` 齐全，sha256 `068c37971a56a40bc9078ddecf89b1e63a62f15fcbeec29191f071583fb965c1`）；`s2-manual-tests.md` 是独立方法论文件，未作为 CASE 来源。
- **S3 缺陷**：第一次 `advance_s3` 因模型漏传 gate 字段报 `SCOPE_INVALID`（允许一次已知准入）；第二次被旧 `validateS3` 以 `INVALID_ARGUMENT` 拒绝，`data_errors` 只有 `missing 依赖图 (dependency-graph)` 与 `missing CASE 对应表 (case-mapping)`。真实 payload 的文档标题为 `## 模块契约`、`## 模块 DAG`、`## 用例到模块的映射`，`modules[].mapped_cases` 已覆盖 `CASE-01..05`，路径/DAG/`secret_owned` 合法。watchdog 按未知诊断停止，未保存、未披露 S3。该轮当场归类为“模型内容错误、未确认产品 bug”；stage-parsers t16 用同一真实 payload 复现后判定为 `validateS3` 缺陷。
- **stage-parsers t16 修复**：`S3_TOPICS` 只保留模块边界与依赖图，删除 `failure-isolation` 与 `case-mapping` 的 Markdown 标题断言；依赖图关键词增加 `模块 dag` 与 `dag`；结构化校验（模块路径/DAG/`secret_owned`/`mapped_cases` 未知、未覆盖、重复）保留。用真实 `advance_s3` payload 直接校验得到 `{ok:true,errors:[]}`；窄测 `stages-parsers`+`stages-gate-tools` 32 pass/172 expect，`main-bootstrap`+`main-consumer`+`stages-contract` 89 pass/877 expect，Biome clean；回归覆盖“接受 `模块契约`+`模块 DAG`、无 CASE 映射标题”“仍拒绝无依赖图标题”“真实 S3 payload 形状可晋级”。
- **限制**：S3 Markdown 仍要求模块边界与依赖图标题/行（根 gate 要求）；failure isolation 仍是建议内容，不是 gate 标题断言。后续 rS4 已让该修复真实执行并成功晋级 S4（见 §2.6.11）；没有 S4/S5、审计、`s5-report.md` 或批准证据。本记录不是验收。
- **证据**：`/home/kunweiz/.cache/herd-real-s1-5-20261112-124245/logs/AI-OPERATOR-S1-S2-S3-STOP.json`、`logs/WATCHDOG-STOP.txt`、`copy/.herd/missions/mission-slug-791e6f/cases.edn`、`copy/plans/mission-slug-791e6f/s2-manual-tests.md`；`agent://stage-parsers` t16 结果；`src/stages/parsers.mjs#validateS3`、`tests/stages-parsers.test.mjs`、`tests/stages-gate-tools.test.mjs`。

#### 2.6.10 真实隔离 s1-7：S2 模型路径误用与回执丢失结构化错误（stage-parsers t17；非验收）

- **场景**：真实 18.16.0 隔离副本 `herd-real-s1-7`，根 `/home/kunweiz/.cache/herd-real-s1-7-20261112-125600`，slug `mission-slug-9a836c`，产品 main sha256 `6482899b...`、parsers sha256 `c827d4fb...`、gate-tools sha256 `41afe365...`；AI 模拟操作员，非人类/生产。S1 面板 56 行全文可见，默认拒绝，Right 选中批准后 Enter，`advance_s1` 成功。
- **S2 真实过程**：模型把 `cases[].path` 全部写成文件路径（如 `/home/.../README.md`），五类 category label 一个未覆盖。第一次 `advance_s2` 返回 `:INVALID_ARGUMENT`，data 只有 `CASE_REQUIRED_PATH_MISSING`（允许一次）；第二次缺 gate 字段返回 `SCOPE_INVALID`（允许一次）；第三次同类路径错误触发 watchdog 停止；`s2-manual-tests.md` 未保存、`cases.edn` 未创建、未披露 S3。该轮当场归类为模型内容错误重复；t17 复核确认 Schema 拒绝正确，但回执包装属产品缺陷：旧 `validationFailure` 把未注册的 parser code 当 outer code 传给 `herdError`，触发 catch 回退，丢掉 `stage`/`errors`/`required`/`missing`/`received`/`next`。
- **stage-parsers t17 修复**：`validationFailure` 固定使用已注册的 `:INVALID_ARGUMENT` 作为 outer code，`data` 保留 `{stage, errors}`；S4 moduleCoverage 失败也走同一包装。`CASE_REQUIRED_PATH_MISSING` 现在给出 `field:"cases[].path"`、五类 required 列表、实际 missing 集合、received 提交值与 `next`（明确 path 是 category label，不是文件系统路径）。注册工具路径的回归测试断言回执文本包含 code、五类名称、received 与 filesystem path 纠正。
- **验证报告**：Biome clean；`stages-parsers`+`stages-gate-tools` 34 pass/194 expect；`main-bootstrap`+`main-consumer`+`stages-contract` 89 pass/877 expect；`bun -e 'import("./src/main.mjs")'` 成功。均非验收。
- **限制/后续**：该轮未到 S3；后续 rS4 已恢复原 session 并让 S3 真实成功（见 §2.6.11），但 s1-7 的 S2 仍需按 category label 重试。没有 S4/S5、审计、`s5-report.md` 或批准证据。s1-6 的失败恢复副本保留（新 omp 报“无活跃使命”），s1-5 的旧 S1/S2 冻结现场未修改。
- **证据**：`agent://stage-parsers` t17 结果；`/home/kunweiz/.cache/herd-real-s1-7-20261112-125600/logs/AI-OPERATOR-S1-S2-STOP.json`、`logs/WATCHDOG-STOP.txt`；`src/stages/gate-tools.mjs#validationFailure`、`src/stages/parsers.mjs`、`tests/stages-parsers.test.mjs`、`tests/stages-gate-tools.test.mjs`。

#### 2.6.11 rS4（`herd-real-s1-8`）：原 session 恢复、S3 成功与 S4 首次误拒（stage-parsers t18；非验收）

- **恢复**：在全新隔离副本 `herd-real-s1-8` 恢复原 session `01a1ce11-5838-71d1-a23d-4affe9335a6f`，只改 session header 的 cwd，id/branch/`herd-focus` 等其余行字节一致；`omp --resume` 直接显示 mission `791e6f` 在 S3 与新副本路径，未手工 `/herd-focus`。原 `herd-real-s1-5` 场景与 session 文件未修改。
- **S3 成功**：在恢复会话中追加新用户消息（不是批准），`advance_s3` 首次成功（`isError=false`，S3 文档 5290 bytes，revision 3，missionStage=`s4`），披露 `STAGE S3 FROZEN -> ENTERING STAGE S4`；stage-parsers t16 的 S3 修复得到真实执行。
- **S4 首次拒绝**：`advance_s4` 返回 `INVALID_ARGUMENT`，错误为缺少 `拓扑合并顺序 (merge-order)`、`slices[0..3] slice_id must be lowercase: SLICE-01..04`、`slice SLICE-04 depends_on undeclared SLICE-01/SLICE-02`。该轮当场归类为 S4 模型内容错误；watchdog 停止，未保存 S4。
- **stage-parsers t18 复核**：同一真实 payload 的文档有 `## 6. 合并拓扑`，slices 使用 uppercase `SLICE-01..04`，`SLICE-04` 精确依赖 `SLICE-01/02/03`，`mapped_cases` 覆盖 5 CASE。根 §2.3 只要求 `slice_id` 唯一合法，根 §7.2 的 worktree/branch 路径允许 uppercase；`depends_on` 报错是 uppercase ID 被误拒后的级联。t18 修复：merge-order 接受 `合并拓扑`/`合入顺序`/`merge topology`；`SLICE_ID_RE` 允许 uppercase（仍拒绝空格、斜杠、点等）；`depends_on` 保持精确大小写匹配并新增 case-mismatch 拒绝测试；错误文案从 lowercase 改为 letters。真实 payload 直接校验 `{ok:true,errors:[]}`；`stages-parsers`+`stages-gate-tools` 37 pass/204 expect，连同 `main-bootstrap`/`main-consumer`/`stages-contract` 共 126 pass/1081 expect，Biome clean。
- **限制/后续**：后续 s1-9 已真实重测 S4 并成功晋级 S5（见 §2.6.12）；worktree/board/runner 的 S4 后贯通继续排查。没有 S5、审计、`s5-report.md` 或批准证据；本记录不是验收。
- **证据**：`/home/kunweiz/.cache/herd-real-s1-8-20261112-130500/logs/AI-OPERATOR-RESUME-S3-SUCCESS-S4-STOP.json`、`logs/WATCHDOG-STOP.txt`、`copy/plans/mission-slug-791e6f/s3-dev-guide.md`、恢复后的 session JSONL；`agent://stage-parsers` t18 结果；`src/stages/parsers.mjs#validateS4`、`tests/stages-parsers.test.mjs`、`tests/stages-gate-tools.test.mjs`。

#### 2.6.12 rS5（`herd-real-s1-9`）：S4 真实成功与 S5 fork 失败清理的半提交缺陷（2026-11-12；非验收）

- **恢复**：在全新隔离副本 `herd-real-s1-9` 恢复原 session（只改 header cwd，id/branch/`herd-focus` 等其余行字节一致，old s1-8 未动）；`omp --resume` 显示 mission `791e6f` 在 S4。当前源码 main `6482899b...`、parsers `c239947f...`、gate-tools `d1fd3971...`、worktree `c6602edb...`。
- **S4 真实成功**：`advance_s4` 返回 `isError=false`（S4 文档 8264 bytes，missionStage=`s5`，s4FixVerified=true）；一次 gate 字段缺失准入被允许。t18 的 S4 修复得到真实执行，S4 保存并晋级 S5。
- **S5 fork 停止**：`fork_slices` 返回 `FF_NOT_READY`（`git show-ref --verify failed`），因为该隔离副本没有 `.git`，无法创建 worktree/ref；watchdog 按首未知停止，未进入 S5、未自动重试。无 `.git` 时先返回 `FF_NOT_READY` 合理，但后续只读复核发现并证实了失败清理的半提交缺陷。
- **worktree t5 复核（实证产品 bug）**：r9 现场 `copy/.herd/missions/mission-slug-791e6f/worktrees.edn` 先写完整 DAG（created-at 05:15:45.919Z），失败清理在 05:15:48.587Z 删掉首个失败 Slice 的 pending 行，只剩 `slice-02/03/04` 均 `:pending`；`slice-04` 的 `depends-on` 引用不存在的 `slice-01`，`queue` 为空且无 `.herd-worktrees`。代码上 `forkSlices` 先预写全部 specs，catch 调 `removeSlice(paths, deps, spec.sliceId)` 只删失败 Slice 的 pending 行后重抛；无 `.git` 时首个就绪 Slice 在 branch/worktree 检查失败，于是出现孤立拓扑。t5 修复：失败不再删除已预写 Slice；清理成功恢复 `:pending` + `:last-fork-error`，清理失败标 `:failed` + `:failure-reason`；已成功 Slice 保持 `:running`，后续失败只影响自身；容量/中途资源失败保留完整拓扑并带 `recoverable:true`；`recoverCreatingSlices` 对缺失 workspace 改为 pending + error，不伪造成功。确定性故障注入覆盖无 `.git` 全失败、首个 Slice 前失败、部分成功后失败、容量预检失败；`tests/worktree.test.mjs` 34 pass/230 expect，Biome clean。
- **worktree uppercase 贯通（agent://worktree 报告）**：`SLICE_ID` 与 parsers 新规则一致（允许 uppercase/underscore，拒绝空格、斜杠、点、前导 `_`/`-`、超 64 字符与 `..`）；workspace `.herd-worktrees/<slug>/<sliceId>`、branch `herd/<slug>/<sliceId>`、writeW/board 锁路径、`worktrees.edn` 的 slices 键与 `:slice-id`、`SliceHandle.slice_id`、`readWorktreeState` 键与 openBoard handle 匹配均逐字保留大小写。窄测 `tests/worktree.test.mjs` 30 pass/195 expect，Biome clean；未增加“仅大小写不同”的重复 Slice 拒绝（Linux 路径区分大小写，未来大小写不敏感文件系统需 collision guard）。
- **后续**：后续 s1-13 已在 Git 副本上成功 fork 3 个 worktree（见 §2.6.13）；该轮因 Reviewer 并行调用被旧监控误杀而停止。现场旧状态不会自动补回 `slice-01`，需按原 S4 slices 重新 fork 或由恢复流程决定。本记录不是验收。
- **证据**：`/home/kunweiz/.cache/herd-real-s1-9-20261112-131400/logs/AI-OPERATOR-RESUME-S4-SUCCESS-S5-FORK-STOP.json`、`logs/WATCHDOG-STOP.txt`、`copy/plans/mission-slug-791e6f/s4-coordination.md`、`copy/.herd/missions/mission-slug-791e6f/worktrees.edn`（只读现场）；`agent://worktree` t5 结果；`src/swarm/worktree.mjs`、`tests/worktree.test.mjs`。

#### 2.6.13 rS5 续测（`herd-real-s1-13`）：3 worktree fork 成功、出站 schema 四字段 required 与并行兄弟 scope 误杀（2026-11-12；非验收）

- **场景**：新 Git 副本 `herd-real-s1-13`（baseline `10bed1ee...`，main clean，S1–S4 契约字节一致）恢复原 session（仅 header cwd），UI 显示 mission `791e6f` 在 S5；源码 worktree 为 t5 修复版 `00d7404d...`。
- **出站 schema**：`provider_tools_schema` 记录 8 个工具；`fork_slices` 与所选非豁免工具的四个 gate 字段（`must_think_in`、worker count、`intent`、`scope`）均存在且在 `required` 中，探针未 abort。r12 的缺字段错误来自模型 `partialArgs` 漏传，不是出站 schema 缺字段。
- **S5 fork**：`fork_slices` `isError=false`，创建 `slice-01/02/03` 三个 worktree 和 `herd/mission-slug-791e6f/slice-0{1,2,3}` 分支（base `10bed1ee...`），`slice-04` 按依赖保持 pending；board 为 3 running/1 queued。t5 修复已加载，但其失败清理路径未触发。
- **Reviewer scope 停止**：`Reviewer-slice-03-T-1`（agent `3a7341ea...`）在同一 assistant 回合并行发出两个 `clj_review`（同一 `05:51:58.061Z`，均 `scope {kind: keepLast}`），两次都因 scope 未初始化被拒；第一次允许一次，旧探针把同一 actor 的第二个并发兄弟调用误当“重复重试”并 abort，整轮停止。两者不是先后重试，该停止是测试监控假阳性，不是 tool-gate/scope 产品 bug。turn-aware harness 已在 r14 离线验证（见 §2.6.14），但 r14 未产生子 worker，真实兄弟调用仍未实测。
- **真实产品修复**：原 `SCOPE_UNINITIALIZED` 回执只列 `kind`/`tool`，缺少 `new_scope_goal`/`new_scope_retention_budget` 与 resetScope 示例；schema t18 已在 `scope/ledger.mjs` 补 `required` 与可执行的 `next`，未改 `tool-gate/schema.mjs`/`index.mjs`。窄测 `tests/scope.test.mjs` 52 pass/190 expect、`tests/tool-gate.test.mjs` 57 pass/282 expect，Biome clean。
- **结果**：本轮没有 Reviewer 纠正回执、审计、`s5-report.md` 或批准；S5 未完成。现场保留（3 worktree/分支、slice-04 pending、old r9 场景未动），不自动重跑。本记录不是验收。
- **证据**：`/home/kunweiz/.cache/herd-real-s1-13-20261112-135000/logs/AI-OPERATOR-R13-S5-FORK-SUCCESS-SAME-AGENT-SCOPE-STOP.json`、`logs/probe.jsonl`、`copy/.herd/artifacts/mission-slug-791e6f/slice-03/3a7341ea-df62-44c2-a7f6-00391873a3a1.jsonl`；`agent://schema` t18 结果；`src/scope/ledger.mjs`、`tests/scope.test.mjs`、`tests/tool-gate.test.mjs`。

#### 2.6.14 r14（`herd-real-s1-14`）：turn-aware harness 离线验证与 resetScope.replacement 误拒（2026-11-12；非验收）

- **场景**：新 Git 副本 `herd-real-s1-14`（baseline `e25ad486...`，main clean，契约一致）恢复原 session（仅 header cwd）；`fork_slices` 出站 schema 四个 gate 字段存在且 required，探针未 abort；turn-aware harness 离线自检通过（policy key 为 `(agentId, assistant turn id, error class)`；同回合兄弟调用算一个 beat 允许，后续回合同类停止，未知产品错误首停，全局上限 3 个 beat；r13 replay 已验证）。
- **真实首错**：父会话 `fork_slices` 的 `scope` 为 `{kind:"resetScope", new_scope_goal:"...", new_scope_retention_budget:12, replacement:"S5 启动：..."}`，被旧准入以 `SCOPE_INVALID` 拒绝：`scope.replacement is not allowed for resetScope`，data 的 allowed 只有 `kind`/`new_scope_goal`/`new_scope_retention_budget`。根 §5.3/§8.5.3 的 flat scope schema 声明了 `replacement`，且没有禁止 resetScope 使用；这是准入白名单误拒，不是出站 schema 缺字段。monitor 按首未知产品错误停止；本轮没有 fork、worktree、子 worker 或兄弟回合实测，现场保留。
- **schema t19 修复**：声明字段（含 `replacement`）对 `resetScope` 与 `removeLast` 均接受；各 kind 的必需字段仍强制；`keepLast`/`meToo` 仍按 COMMON 拒绝额外字段；缺失/非法字段回执带 `kind`/`required`/`next`，额外字段错误带纠正 `next`。未增加 branch-exclusive oneOf，未改 `tool-gate/schema.mjs`/`index.mjs`。r14 原始 scope 离线 admit 成功；`tests/scope.test.mjs`+`tests/tool-gate.test.mjs` 111 pass/480 expect，Biome clean。
- **后续**：真实下一轮待测；没有 S5 fork（本轮）、Reviewer 完成、审计、`s5-report.md` 或批准证据。本记录不是验收。
- **证据**：`/home/kunweiz/.cache/herd-real-s1-14-20261112-140500/logs/AI-OPERATOR-R14-S5-SCOPE-REPLACEMENT-PRODUCT-STOP.json`、`logs/probe.jsonl`、`logs/r13-turn-replay.json`；`agent://schema` t19 结果；`src/scope/ledger.mjs`、`tests/scope.test.mjs`。

#### 2.6.15 r22：S5 activeTools 误含并执行 `clj_plan`（2026-11-12；非验收）

- **现场**：真实 18.16.0 隔离副本 `herd-real-s1-22`（根 `/home/kunweiz/.cache/herd-real-s1-22-dZtaEc`，baseline `e99572a`）。S5 主会话 `before_agent_start` 的 activeTools 为 `[ask_previous_scope, ask_user, assume, clj_plan, fork_slices, gc_worktrees, join_slice, realign_frozen]`；provider schema 为 `clj_plan` 提供完整 gate schema；随后宿主实际执行了 `clj_plan` 工具调用，返回 `CAPABILITY_DENIED`（`Symbol .getMessage is not available in the sandbox`）。fork 未发生，子 worker 为 0；watchdog 按首错停止。
- **归类修正**：该轮当时记录为“模型程序使用不可用 JS interop、尚未确认产品 bug”；runner t13 复核确认这是产品缺陷：S5 主会话/Coordinator 按根 §2.1/§4.2 不应拥有规划期 `clj_plan`，activeTools 本身错误，不是模型凭空输出，也不是旧会话恢复误挂载。模型程序中的 `.getMessage` 只是被执行后的次级错误。
- **修复与不足**：r22 时 `src/main.mjs#STAGE_SURFACES.s5` 删除 `clj_plan`，窄行为测断言 S5 activeTools 含 `fork_slices`/`realign_frozen`、不含 `clj_plan`（102 pass/763 expect）；但 r23 真实 S5 的 activeTools 仍含 `clj_plan`，证明仅移除该常量不足，根因修复进行中。
- **后续**：r23 已 fork 3 个 worktree 并启动 3 个子代理，但首个 `clj_review` 因 `ls expects an EDN map argument` 停止；没有 S5 审计/报告/批准证据。本记录不是验收。
- **证据**：`/home/kunweiz/.cache/herd-real-s1-22-dZtaEc/logs/AI-OPERATOR-R22-S5-STOP.json`、`logs/probe.jsonl`；`agent://runner` t13 结果；`src/main.mjs#STAGE_SURFACES.s5`、`tests/main-bootstrap.test.mjs`、`tests/runner.test.mjs`、`tests/s5-wiring.test.mjs`。

#### 2.6.16 r23：S5 activeTools 仍含 `clj_plan`，r22 移除不足与首个 `clj_review` 停止（2026-11-12；非验收）

- **现场**：真实 18.16.0 隔离副本 `herd-real-s1-23`（根 `/home/kunweiz/.cache/herd-real-s1-23-b6fGFi`，baseline `9921420`，main sha `d04e2b2d...`，runner sha `5e0092d9...`）恢复原 session（仅 header cwd）。S5 `before_agent_start` activeTools 仍为 `[ask_previous_scope, ask_user, assume, clj_plan, fork_slices, gc_worktrees, join_slice, realign_frozen]`，`clj_plan` 仍在，证明 r22 删除 `STAGE_SURFACES.s5` 常量的修复不足，runner 正在修根因。
- **本轮进展**：`fork_slices` 在一次缺 gate 字段重试后成功，`slice-01/02/03` 有 handle，`slice-04` pending；启动 3 个子代理。首个错误是子代理 `clj_review` 的 `INVALID_ARGUMENT`（`ls expects an EDN map argument`，模型传了位置参数）；该轮当时尚未确认是否为产品 bug，watchdog 按首错停止；另有一个 `SCOPE_UNINITIALIZED` reviewer 准入被允许一次、一个重复子事件被忽略。
- **当前源码与未完成**：当前 `STAGE_SURFACES.s5` 已不含 `clj_plan`，`publishMission` 在 S5 把 `clj_plan` 追加到 `blockedTools`；Main 实际运行 `main-bootstrap.test.mjs` 为 48 pass/0 fail。但 r23 真实宿主仍暴露 `clj_plan`，runner 因中断取消，这些改动是否真正解决尚未重测。没有 `join_slice`、S5 审计、`ask_user`、批准或结案；现场保留（3 worktree/分支、slice-04 pending），无自动重跑。本记录不是验收，S5 不可称可用。
- **证据**：`/home/kunweiz/.cache/herd-real-s1-23-b6fGFi/logs/AI-OPERATOR-R23-S5-STOP.json`、`logs/probe.jsonl`、`copy/.herd/missions/mission-slug-791e6f/worktrees.edn`；`agent://runner` 根因修复进行中。

## 3. `cherry-cljs`

### 3.1 安装与加载

实测命令（在 `/tmp/cherry-probe`，不修改产品依赖）：

```bash
mkdir -p /tmp/cherry-probe
# package.json: {"type":"module"}
cd /tmp/cherry-probe
bun add cherry-cljs@0.6.38
```

实测结果：

- 安装成功：`cherry-cljs@0.6.38`，`type: module`，`bun add` 共安装 4 个包。
- 包入口 `index.js` 只 re-export `lib/compiler.js`；实际导出为 `compileString`、`compileStringEx`。
- `cljs.core.js` 导出 500 个符号；包括 `Keyword`、`PersistentVector`、`PersistentHashMap`、`PersistentHashSet`、`map`、`mapv`、`filter`、`reduce`、`str`、`subs`、`pr_str`、`keyword`、`symbol`、`vector`、`hash_map`、`set`、`get`、`assoc`、`update`。
- `cljs.core.js` **没有**导出 `read_string`、`read` 或 EDN reader；`doseq` 也不是导出函数。
- `lib/clojure.string.js`、`lib/clojure.set.js`、`lib/clojure.walk.js` 存在且导出常用函数。

### 3.2 编译行为

用 Bun 在临时安装中实测：

```bash
bun -e "import { compileString } from 'cherry-cljs'; console.log(compileString('(defprogram p [] (+ 1 2))'))"
```

- `(defprogram p [] (+ 1 2))` 编译为 `defprogram.call(null, p, cherry_core.vector(), (1 + 2));` —— `defprogram` 被当作普通函数，不是特殊形式。
- `(let [x (cat {:path "a"})] (write ...))` 编译为普通 `cat.call(...)`，没有自动 `await`。
- `(js-await (cat ...))` 才生成 `await`。
- `(mapv (fn [x] (js-await (cat x))) ["a" "b"])` 生成 `function (x) { return (await ...); }`，这是非法 JS。
- `park`/`unpark` 只是普通函数调用，没有挂起语义。
- README 明确标注 experimental、not recommended for production、many bugs/breaking changes。

**结论**：不能把 Cherry 编译作为沙箱主路径；`defprogram`、自动 await、异步高阶函数、EDN reader 四项都不满足。当前 S2 选择“自建 Promise-CPS 解释器 + Cherry 仅作数据/纯函数运行时”与实测一致。

### 3.3 产品依赖现状

- 当前工作区 `package.json` 已收敛为两个入口，`dependencies` 只有 `cherry-cljs@0.6.38`；`node_modules/cherry-cljs` 已存在。
- 截止本记录写入时，`src/` 仍是**迁移中的混合状态**：旧 `pi-goal/`、`pi-context/`、`editor-theme/`、`context/`、`manual-acceptance/` 仍在；新模块已大量出现：
  - `src/clj-sandbox/ufss.mjs`、`where.mjs`、`evaluator.mjs`、`vfs.mjs`、`tools.mjs`；
  - `src/stages/disclosures.mjs`、`parsers.mjs`、`contract.mjs`、`gate-tools.mjs`、`scores.mjs`；
  - `src/swarm/board.mjs`、`worktree.mjs`、`runner.mjs`、`auditors.mjs`；
  - `src/tui/dashboard-model.mjs`、`dashboard-widget.mjs`；
  - `src/prompts/common.mjs`、`roles.mjs`、`runtime-wires.mjs`；
  - `src/util/atomic-write.mjs`（已修改）、`errors.mjs`（已修改）、`file-lock.mjs`（新增）；
  - `src/host/imports.mjs`（已修改）、`src/host/health.mjs`（新增）、`src/host/subprocess.mjs`（已修改）；
  - `src/tool-gate/index.mjs`、`schema.mjs`（新实现）、`src/bootstrap-main.mjs`、`src/main.mjs`。
- `main.bootstrap` 修复后为 `ok`（见 §2.6），`tool-gate` 为 `ok`；子代理启动验证已执行，但发现 `yield` 被 `main.mjs` 角色面拒绝（见 §2.6.1）。
- 因此“产品加载 Cherry”尚未发生；上述只是临时包加载与行为探针。HACK 记录的是本次观察快照；并发实施会继续改变文件，使用前必须重跑 §6 的复检。

## 4. Git 与 worktree

### 4.1 当前拓扑

实测命令：

```bash
git rev-parse --show-toplevel
git rev-parse --git-dir
git rev-parse --git-common-dir
readlink -f .git
git worktree list --porcelain
git status --porcelain=v2
```

实测结果：

- `--show-toplevel`：`/home/kunweiz/Desktop/vibe/herdchestra-lite`
- `--git-dir`：`.git`
- `--git-common-dir`：`.git`
- `.git` 是符号链接：`/home/kunweiz/.cache/herdchestra-lite/gitdir`
- `git worktree list` 的主 worktree 条目是 `/home/kunweiz/.cache/herdchestra-lite/gitdir`，不是实际检出目录。
- HEAD：`e25075d8703938289959cf8ebf3c6ac2916bb8fe`
- 工作树状态：`docs/architecture.md`、`docs/design.html`、`docs/methodology.md` 为已跟踪删除；`AGENTS.md`、`.pi/`、`docs/manual-acceptance/`、`docs/旧*`、`docs/讨论纪要.md`、`docs/兄弟项目参考.md` 未跟踪。
- 两个物理副本 `/home/kunweiz/public/HerdchestraLite` 与 `/home/kunweiz/Desktop/vibe/herdchestra-lite` 使用同一个 gitdir；`package.json` 字节相同。

### 4.2 worktree 探针

实测命令：

```bash
TMP=/tmp/herd-wt-probe-$(date +%s)-$$
git worktree add --detach "$TMP" HEAD
git -C "$TMP" rev-parse --show-toplevel
git -C "$TMP" rev-parse --git-dir
ls "$TMP/AGENTS.md"      # 预期缺失
ls "$TMP/node_modules"   # 预期缺失
git worktree remove --force "$TMP"
```

实测结果：

- `git worktree add --detach` 成功；worktree 的 `--show-toplevel` 是 `/tmp/herd-wt-probe-...`。
- worktree 的 `--git-dir` 是 `/home/kunweiz/.cache/herdchestra-lite/gitdir/worktrees/herd-wt-probe-...`。
- worktree 内没有 `AGENTS.md`，也没有 `node_modules`。
- `git worktree remove --force` 成功；移除后 `git worktree list` 只剩主 gitdir 条目。

**结论**：

- worktree 可以创建/删除，但不会自动携带未跟踪的根规格、`plans/`、`docs/manual-acceptance/` 或依赖。
- 任何把 `git worktree list` 第一条当主工作区路径的代码都会得到 gitdir，而不是检出目录。
- Slice 必须通过只读根访问主工作区契约；需要 `node_modules` 的 `call` 不能假设 worktree 已有依赖。
- `rebase`、`--ff-only`、集成锁、7 天保留尚未实测，见 §7。

## 5. 当前验收条件

### 5.1 文件状态

| 路径 | 状态 |
|---|---|
| `docs/manual-acceptance/clean-break/requirements.md` | 存在，129693 B，`sha256=7c74ea0aa8cf318e0dc9a25c2ff0c9527dd6b87396dded5dabf7f4158837c011` |
| `docs/manual-acceptance/clean-break/development-guide.md` | 存在，154672 B，`sha256=8623b3540b1b84d5f0879d0f76ba5106ae6e611cca5103610934ae8bb3b7a24a` |
| `docs/manual-acceptance/clean-break/coordination.md` | 存在，103592 B，`sha256=ab45a1cf1656a893ccf5f6dc532c343f81f60f6674cd0191dbb1e2239ab4945d` |
| `docs/manual-acceptance/clean-break/report.md` | **缺失** |
| `docs/manual-acceptance/clean-break/evidence/` | **缺失** |
| `HACK.md` | 本文件，存在 |
| `DEBT.md` | **缺失** |
| `HISTORY.md` | **缺失** |
| `src/AGENTS.md` | **缺失** |
| `plans/` | **缺失** |
| `.herd/` | **缺失** |
| `tools/dev-acceptance/` | **缺失** |
| `.pi/` | 存在；含 `goals/` 与 `.goals-pool-snapshot.json`（3864 B），不属于产品交付物 |

### 5.2 验收前置状态

| 前置 | 状态 |
|---|---|
| 当前工作区被 `omp` 加载 | **未满足**：插件仍指向 `public/HerdchestraLite` |
| 两个入口/仅 `cherry-cljs` | **已满足（清单）**：`package.json` 已收敛为两个入口，依赖只有 `cherry-cljs@0.6.38` |
| 新实现模块 | **已接线但未 ready**：`clj-sandbox/*`、`scope/*`、`stages/*`、`swarm/*`、`tui/*`、`prompts/*`、`util/*`、`host/imports`、`host/health`、`host/subprocess`、`tool-gate/*`、`bootstrap-main`、`main` 均已出现/修改；`main.bootstrap` 当前因 `readPendingGate is not defined` 失败 |
| `cherry-cljs` 产品依赖 | **已安装**：`node_modules/cherry-cljs@0.6.38` 存在；加载行为见 §3 |
| 主模型/@task 模型 | **部分**：free 模型可运行；默认模型选择失败；`@task` 角色未单独验证 |
| tmux/TUI | **部分**：tmux 存在；`ctx.ui.setWidget`/`onTerminalInput` API 存在；交互式 TUI 未验证 |
| 真实 hook 探针 | **已做**：`before_agent_start`/`tool_call`/`tool_execution_end`/`agent_end`/`session_start` |
| `runSubprocess` | **已做一次（17.3.5）**：`artifactsDir`/`settings`/`modelOverride`/`sessionFile` 忽略行为已观察；18.16 源码与 `SessionManager.open` 窄探针确认 `sessionFile` 写入子会话 `parentSession` |
| Git worktree | **部分**：创建/删除/拓扑已观察；join/rebase/ff-only 未测 |
| 手工验收执行 | **未执行**：没有 CASE 分数、没有 `report.md`、没有证据目录 |
| 故障注入 | **未提供**：429/quota/崩溃/资源不足仍需外部手段或测试注入 |
| DA 审计执行器 | **缺失**：`tools/dev-acceptance/` 不存在；当前只有旧的 `src/manual-acceptance/` |

## 6. 复检步骤

### 6.1 真实加载证明

```bash
# 1. 记录实际宿主与插件
omp --version
readlink -f "$(command -v omp)"
node -e "const p=require('/home/kunweiz/node_modules/@oh-my-pi/pi-coding-agent/package.json'); console.log(p.name,p.version)"
omp plugin list --json
omp plugin doctor

# 2. 隔离 HOME，避免污染主插件注册表
export TEST_HOME=/tmp/herd-home-$(date +%s)
mkdir -p "$TEST_HOME"
HOME="$TEST_HOME" omp plugin link /absolute/path/to/target-copy
HOME="$TEST_HOME" omp plugin list --json

# 3. 在目标副本放唯一标记，启动 omp，确认 health/realpath/日志命中该副本
# 这不使用产品源码；目标副本必须显式包含未跟踪的 AGENTS.md 与 docs/manual-acceptance/。
```

判定：`omp plugin list` 的插件路径、入口 `realpath`、标记文件命中、进程 cwd 四者必须同时指向目标副本；否则 CASE 无效。

### 6.2 Hook 探针复检

在 `/tmp` 创建一个临时扩展，注册 `session_start`、`before_agent_start`、`tool_call`、`tool_execution_end`、`agent_end`，记录：

- `ctx.agent` 是否存在、`kind`/`id`/`name`；
- `ctx.signal` 是否存在；
- `ctx.getContextUsage`、`ctx.getSystemPrompt`、`ctx.ui.setWidget`、`ctx.ui.onTerminalInput` 是否存在；
- `event.systemPrompt` 是否是 `string[]`、`reason` 是否存在；
- `tool_call.input` 是否存在、返回 `{input}` 后 `execute` 是否收到修改值；
- `agent_end` 是否有 `willContinue`/`awaitingAsyncWork`。

命令模板：

```bash
omp --no-session --no-extensions --no-tools --no-lsp --no-pty \
  --no-context-files --no-skills --no-rules --auto-approve \
  -e /tmp/herd-host-probe.mjs -p \
  --model 'cline-pass/cline-free/solar-mini4' \
  --max-time 90 --max-cost 0.05 \
  "Call the probe_echo tool exactly once with value 'original'. Then reply exactly DONE."
```

本次观察：`ctx.agent` 存在（`main`/`Main`/`main`），`ctx.signal` 为 undefined，`systemPrompt` 为 `string[]`，`tool_call` 的 `{input}` 修改生效，`agent_end` 无 `awaitingAsyncWork`。

### 6.3 `runSubprocess` 复检

在临时扩展中调用 `runSubprocess`，显式传：

- `agent` 完整定义（`name`/`description`/`systemPrompt`/`source`/`tools`/`spawns`/`model`）；
- `settings=Settings.instance`（或 `pi.pi.settings`）；
- `modelRegistry=ctx.modelRegistry`；
- `modelOverride` 指向可用模型；
- `artifactsDir=/tmp/...`；
- 故意传一个假 `sessionFile`；
- `restrictToolNames: true`、`enableMCP/Lsp/Irc: false`、`maxRuntimeMs`。

检查：

- `<id>.jsonl` 与 `<id>.md` 是否都在 `artifactsDir`；
- 假 `sessionFile` 是否没有被创建；
- `settings` 是否为 live；
- `resolvedModel`/`resolvedModelIsFallback`；
- 无 `artifactsDir` 时是否明示仅内存可见。

本次观察：`<id>.jsonl` 11796 B、`<id>.md` 16 B，假 `sessionFile` 未创建，`settings`/`modelRegistry` 成功，`resolvedModel` 为指定 free 模型。

### 6.4 `cherry-cljs` 复检

```bash
mkdir -p /tmp/cherry-probe && cd /tmp/cherry-probe
# package.json: {"type":"module"}
bun add cherry-cljs@0.6.38
bun -e "import { compileString } from 'cherry-cljs'; console.log(Object.keys(await import('cherry-cljs'))); console.log(compileString('(defprogram p [] (+ 1 2))'))"
bun -e "import('cherry-cljs/cljs.core.js').then(m=>console.log(Object.keys(m).length, typeof m.read_string, typeof m.Keyword, typeof m.mapv))"
```

检查：入口是否只有 `compileString`/`compileStringEx`；`cljs.core` 是否约 500 个导出、无 `read_string`；`defprogram` 是否被当普通函数；`js-await` 是否只在显式位置生效。

### 6.5 Git/worktree 复检

```bash
git rev-parse --show-toplevel
git rev-parse --git-dir
git rev-parse --git-common-dir
readlink -f .git
git worktree list --porcelain
TMP=/tmp/herd-wt-probe-$(date +%s)-$$
git worktree add --detach "$TMP" HEAD
git -C "$TMP" rev-parse --show-toplevel
git -C "$TMP" rev-parse --git-dir
ls "$TMP/AGENTS.md" "$TMP/node_modules" 2>&1
git worktree remove --force "$TMP"
```

检查：主 worktree 条目是否为 gitdir；worktree 是否缺 `AGENTS.md`/`node_modules`；`.git` 文件是否指向共享 gitdir；移除后是否无残留。

### 6.6 验收条件复检

```bash
ls -la docs/manual-acceptance/clean-break
sha256sum docs/manual-acceptance/clean-break/requirements.md \
          docs/manual-acceptance/clean-break/development-guide.md \
          docs/manual-acceptance/clean-break/coordination.md
test -f docs/manual-acceptance/clean-break/report.md; echo "report=$?"
test -d docs/manual-acceptance/clean-break/evidence; echo "evidence=$?"
for f in DEBT.md HISTORY.md src/AGENTS.md plans .herd tools/dev-acceptance; do
  test -e "$f" && echo "EXISTS $f" || echo "MISSING $f"
done
```

## 7. 尚未验证项

以下项目尚未实测；不得在 S3/S4 中写成已通过：

1. **当前工作区被真实宿主加载**：尚未重新 link；当前仍是 `public/HerdchestraLite`。
2. **产品入口/工具面**：`bootstrap-main`/`main`/`host/subprocess`/`tool-gate` 已进入新实现；`main.bootstrap` 与 `tool-gate` health 均为 `ok`。Reviewer/Worker 的真实子代理验证通过：角色面收敛、`yield` 成功、`hub`/宿主裸工具被移除；Worker `board_take_or_die` 仅验证到角色面允许，完整令牌竞争仍需真实 board 夹具（见 §2.6.1）。旧 `pi-goal`/`pi-context`/`editor-theme`/`manual-acceptance` 目录、旧入口与旧 manual-acceptance 测试已删除。
3. **`cherry-cljs` 产品加载**：`package.json`/`node_modules` 已安装 0.6.38；尚未在真实 `main.bootstrap` 成功启动后验证产品运行期加载。
4. **`setActiveTools` 的角色工具面效果**：已用真实 Reviewer/Worker 复测。Reviewer active tools 为 `ask_previous_scope/assume/clj_review/submit_review/yield`（**不含 `ask_user`**）；Worker 含全部 board 工具、`clj_worker`、`yield`；两者 `yield` 均成功，`hub` 与宿主裸工具均不在 active/allTools。Worker `board_take_or_die` 仅验证到角色面允许/schema 校验；完整令牌竞争需真实 board 夹具。
5. **`restrictToolNames`/`enableMCP/Lsp/Irc`**：只在一次 `runSubprocess` 探针中使用；未验证 MCP/LSP/IRC 完全不可见。
6. **`@task` 模型**：未单独验证 `agent.model: ["@task"]` 的解析；探针使用显式 free 模型。模型 fallback 只观察到字段未出现，未测试失败/fallback 分支。
7. **无 `artifactsDir` 的 `runSubprocess`**：未测试“仅内存可见”回执。
8. **子代理超时/取消/abort 树**：父 `session_start` handler 因 `yield` 被拒在 30000ms 超时；未验证主动取消/abort 树，也未验证修复后正常完成。
9. **`agent_end` vs `turn_end` 的 Nudge 触发**：只观察 `agent_end` 形状；未实际注入 Nudge，也未验证与宿主 auto-retry 的叠加。
10. **TUI 交互**：`ctx.ui.setWidget`/`onTerminalInput` API 存在；未在 tmux 中验证组件工厂、稳定高度、窄屏、无颜色、挂载失败。
11. **Git 集成**：未测试 `rebase`、`git merge --ff-only`、集成锁、7 天保留、`abandon_slice`、共享 gitdir 下的并发 worktree。
12. **worktree 依赖**：未测试在无 `node_modules` 的 worktree 中运行 `bun test`/`call`；不要假设依赖可用。
13. **共享 gitdir 的双检出**：`public` 与 Desktop 共用 gitdir 的行为已观察，但未测试两者同时写/同时 worktree 的冲突。
14. **手工验收执行**：没有执行任何 S1 CASE，没有分数、没有 `report.md`、没有证据目录；不能声称任何 CASE 通过。§2.6.7 的 S1 面板/批准/晋级观察只是隔离测试记录，不是 CASE 验收。
15. **DA**：`tools/dev-acceptance/` 存在，但只负责开发验收文档提交；没有 K 路审计执行器/分数汇总。
16. **故障注入**：429/5xx、quota、崩溃、资源不足、K 审计排队未测试；没有默认关闭的测试注入点。
17. **`tool_call` 16.x 降级**：未在 16.1.22 上测试 `inject-only`；只在 18.16.0 实测 `{input}`。
18. **宿主 `before_subagent_spawn`**：未测试；不要依赖。
19. **`ctx.signal`**：在 print/session_start 为 undefined；未在 streaming/取消场景测试。
20. **主模型默认值**：本机默认模型选择失败；验收必须显式 pin 模型。
21. **真实宿主工具门 F1/F2/F3**：F1 仍在修复中；F2/F3 仅旧快照观测通过，当前源码未复测。缺失 gate 字段必须区分“模型漏传”与“旧版宿主预剥”，见 §2.6.3。
22. **多项源码修复项**：`systemPrompt` 透传与 NUL 拒绝、`roleOf` 硬编码、`onStageChange`、S5 空账问、角色描述、`ex-message`、gate fail-open、`main` 缺 board 端口已做源码修复和窄自动化验证，但未真实宿主复测；用户允许每批已知 bug 修完后进行一轮 tmux，发现新一批即停修。本轮未运行 tmux/omp，不能写成已修复或已验收。
23. **多工人修复项**：审计重试/恢复、`worktrees.edn`、看板原子 wake、真实 `$W$`+claim 消费、`call` 取消/日志、冻结文件 realign、Scope 已有源码和窄自动化验证，但未真实宿主复测；`tests/s5-wiring.test.mjs` 是自动化集成，不是手工验收。`agent://evaluator` 的 D7/D8 限制仍保留。
24. **Evaluator remaining-evaluator t3 / lazy-fix t14-t18**：t2 的异步 transducer 回调/reducer、惰性 sequence、可重复 eduction、三参数 into HOF、catch 缺绑定解析拒绝仍保持；t3 已修 halt-when 异步谓词/retf 与最终值向 into/transduce 的传递，并有窄行为覆盖（t3 报告 159 pass / 0 fail）；sequence/eduction 物化仍受 200000 上限，memoize 线性无上限。D8 方面 t14 提供 abort 后 `:interrupted-capabilities` 回执与 `:outcome-unknown` 记录，t15 增加 `session.abandoned` 会话账本与工具回执可见性（窄测试报告，非验收）；t17 曾加 5s 端口 watchdog，t18 已删除并恢复 deadline park（t18 报告 evaluator 105 pass/728 expect、组合 178 pass/1095 expect）；generic capability 无 board actionId，不能也不应伪造 `markUncertain`，归责仍须 C4/上层依据 receipt/ledger 核对；账本无 TTL/dismiss、与当次快照未去重，`call` 内部 pre-drain 无独立 watchdog，evaluator 无 drain 端口。见 §2.6.5，未跑 tmux/omp。
25. **Auditor per-auditor sandbox**：t8 已观察到真实 bwrap + 私有 tmux 的启动、主工作区只读、跨调用与关闭清理；t11 在私有 tmux 中启动嵌套 omp 18.18.8，显式加载产品扩展并经 host-side canned responder 回复，仅 UI/连接/工具面 smoke（无真实模型、无工具调用、无审计提交/评分/批准）。仍未证明真实隔离、宿主 socket 不可达、Landlock 全生命周期强制、prompt 追加顺序、真实模型 egress 与 18.16.0 基线；此前一轮 plain host 阳性已撤回。用户未确认 per-auditor 临时执行器；实现方按任务生命周期解释为随审计创建/回收的临时资源，需验证，若与根规格冲突须由人类修改根规格。见 §2.6.6 与 `DEBT.md` D12，非验收。
26. **`ctx.agent` 缺失时的 fail-closed 行为**：t15 已做源码与窄自动化（无 `ctx.agent` + 角色 token → 全工具拒绝、health degraded；无 token 主会话 → 正常），报告 168 pass / 0 fail、1091 expect，Biome clean；真实 16.x/17.x 未运行，独立 host-validation 复测需显式授权。见 `DEBT.md` D2，不得写成跨版本已验证或手工验收通过。
27. **D13 阶段控制态 clean-break 的真实 S5/审计 end-to-end**：源码与组件窄测已落地（S1 summary、`cases.edn`、`:s3-modules`、`:s4-slices`、七项 `:frozen`、S5 从冻结数据集装载、board `dependency_paths`/`condition:`、clj CASE 边界）。真实 rS3 完成 S1 批准与结构化 S2（5 CASE `cases.edn` 冻结），并暴露 `validateS3` 误判（t16 修复）；s1-7 暴露 S2 回执丢结构化错误（t17 修复）；rS4 恢复原 session 后 S3 成功并进 S4，S4 被旧 `validateS4` 误拒（t18 修复）；rS5 真实 `advance_s4` 成功进 S5，`fork_slices` 失败清理删除 pending Slice 留下孤立拓扑（t5 修复，34 pass/230 expect）；s1-13 在 Git 副本上真实 fork 3 个 worktree（slice-04 pending），出站 schema 四字段 required，但 Reviewer 同回合并行 `clj_review` 被旧监控误判 repeat；s1-14 的 turn-aware harness 离线验证通过，却在父 `fork_slices` 的 `resetScope.replacement` 上被旧准入误拒，schema t19 已允许声明字段并保留各 kind 必需约束（scope+tool-gate 111 pass/480 expect）；r22 的 S5 activeTools 误含并实际执行 `clj_plan`（runner t13 确认产品缺陷，r22 移除 `STAGE_SURFACES.s5` 常量并窄测 102/763）；r23 真实 S5 仍含 `clj_plan`，当前源码又增加 `publishMission.blockedTools` 并在 S5 追加 `clj_plan`，Main 实跑 main-bootstrap 48 pass/0 fail，但真实宿主未重测，runner 因中断取消，根因是否解决仍未知；r23 fork 成功、3 子代理启动，首个 `clj_review` 因 `ls expects an EDN map argument` 停止。真实 S5 Reviewer 完成、`runMissionAudit → startAuditBatch`、审计提交、`s5-report.md` 或批准均无证据；没有统一全量套件收口；audit-isolation-review 的组合运行曾在并发编辑期间报告 2 个 `main-bootstrap` structured-realign `s3-modules mapped_cases` 断言失败；`realign_frozen` 的 S2–S4 表面与 `auditInvalidated`/观察者退休仍无独立断言。见 §2.6.9–§2.6.16 与 `DEBT.md` D13。

## 8. 对 S3/S4 的直接约束

1. **按“每批修复后一轮 tmux”的节奏，下一轮 tmux 先重新 link 到目标副本**，并证明 `omp plugin list`/入口 `realpath`/标记文件三者一致；否则所有 CASE 无效。
2. **`tool_call {input}` 已实测可用**：G1 可以返回剥离后的新对象；但要测试持久化/显示/审批输入，旧 `rawToolArguments` 不能假设 gate 字段仍在 branch。
3. **`sessionFile` 在 18.16 是 session 文件级父链**：`runSubprocess` 将它作为 `SessionHeader.parentSession`（需 `artifactsDir`）；17.3.5 忽略。H1 直接透传调用方/宿主提供的值，不预检、不拒绝 memory-only，`parentSessionNote` 只记录已透传/未提供，不另设链接成功状态；另透传 `parentAgentId`/`parentToolCallId` 作为 registry/Agent Hub 级父链。`artifactsDir/<id>.jsonl` + `eventBus` 仍是 transcript/可见性来源。
4. **`ctx.agent` 在 18.16.0 运行时存在**，但 17.3.5 源码没有；不能当跨版本事实。当前 G1 用宿主报告的子会话身份 `ctx.agent` 决定是否咨询首行 role token，并查询 M0 发布的 role surfaces；没有独立 role-auth 模块。t15 起缺失 `ctx.agent` 时：`isSubagent(ctx)` 为 false 且首行为 `[HERD_ROLE:` 的会话在 `onBeforeAgentStart` 直接 deny，G1 对所有工具 fail-closed 且 health degraded；无 token 的正常主会话不阻断；H1 `planSpawn` 能力门要求 `hasCtxAgent === true`。真实 16.x/17.x 未运行，逐版本探测前不得把该行为当跨版本已验证。
5. **`Settings` 必须传 live 实例，且 18.x 没有 `.get(path)`**：18.16 的 `Settings` 读取面是 descriptor（`setting.get(settings)`）；实例公开 `getStorage()`/`getModelRoles()`/`isConfigured(setting)`，**没有 `.get`**（`/tmp/host-probe` 实测 `typeof Settings.isolated().get === "undefined"`）。`ctx.settings` 不存在；公开来源是 `pi.pi.settings`（宿主模块命名空间的 live proxy）或省略后由 H1 取 `Settings.instance`。`pi.getSettings()` 不在公开 `ExtensionAPI` 类型/源码中，可能返回 get-only facade；H1 只校验并调用 `getStorage`/`getModelRoles`，不再要求或调用 `.get`，错误 `missing` 只列这两项（若 `Settings.instance` 可用则回退并记录 `settingsSource:"instance-fallback"`）。`runSubprocess` 不传 settings 会落 `Settings.isolated()`。
6. **`artifactsDir` 是 transcript 开关**：不传会仅内存可见；子代理同 PID，锁判活必须按 `agent_id`/`term_id`。
7. **默认模型不可靠**：验收命令必须显式 `--model`；`@task` 角色需单独验证。
8. **worktree 不带规格/依赖**：C3 只读根；B1 显式 `git -C`；`call` 不假设 `node_modules`；Slice worktree 不应依赖本地未跟踪文件。
9. **Cherry 只能做数据/纯函数运行时**：`defprogram`/park/async HOF/EDN reader 必须由自建解释器提供；不要恢复 Cherry 编译主路径。
10. **验收工具边界**：`tools/dev-acceptance/` 只提供开发验收文档提交；S4 的 K 路审计执行器、分数汇总与报告所有权仍需手工/宿主流程，不能把提交工具当作审计执行器。
11. **S1 确认面板的测试授权**：根 §2.2/§2.3 已明确 S1 是唯一手工批准门禁。真实产品运行只能由人类操作员在面板明确批准或提出修改；在独立工作区或容器、非生产数据、非生产凭证且用户明确授权的隔离测试中，AI 操作员可以操作真实确认界面模拟批准或修改，但实测记录必须注明该次操作是测试模拟，不得冒充人类批准或生产授权。产品不识别操作者身份，不新增测试模式或身份字段；无法证明隔离时必须由人类操作员批准。
12. **CASE 权威**：冻结的 `.herd/missions/<slug>/cases.edn` 是 CASE 成员、阈值、路径、步骤、期望与 rubric 的唯一来源；`s2-manual-tests.md` 只写方法论，框架与审计员都不从 Markdown 解析 CASE。`clj_auditor` 不得读取 `cases.edn`，只消费框架注入的单条 CASE 记录；`clj_plan` 可按只读白名单读取冻结数据集。

## 9. 变更记录

- 2026-11-13：记录受控 `ExtensionRunner` 捕获（非验收）：新增
  `src/host/native-runner.mjs`，包装 `createContext` 取得 live runner，`clj_devops`
  的 read/write 改走 `invokeNativeTool`；删除 read/write shadow 工具与
  `hostToolOf`。真实 omp 18.20.0 已验证 `(read ...)`、`(write ...)` 回执
  `:host true` 且探针落盘；窄测 82 pass/0 fail。详见 §1.1。
- 2026-11-12：记录 call argv-only（非验收）：`(call {:argv ["<program>" "<arg>" ...] :cwd ...})` 直接 spawn，不经系统 shell；`argc = (count argv)`，回执含 `:argv`/`:argc`，旧 `:command` 与非数组 argv 被拒。`vfs.defaultRunCommand` 删除 shell 分支，`runCall` 改收 argv；bwrap 适配器按 argv 构造目标，setup 仍保留内部 shell 启动。测试 `tests/clj-core.test.mjs` 增加 argv 直执行（`a|b` 不被解释）与旧 command 拒绝，17 pass/0 fail；sandbox-tools/vfs 164 pass/0 fail。未跑真实宿主审计路径；不是验收。
- 2026-11-12：记录 final clj dogfood（非验收）：用户授权删除 VFS 路径权限、盲写限制与 AGENTS.md 特殊保护；工具改为裸 REPL（`code` 任意顶层表达式，`program_name` 可选，内部自动生成 `repl-<id>`）；期限固定 `1000ms + intent 字节数 × 50ms`，不再按角色加码。`src/clj-sandbox/vfs.mjs` 删除 readRoots/allowWritePaths/控制路径/plans/AGENTS 保护/根包含检查，`tools.mjs` 删除 auditor 白名单与 call cwd/log 预检，`clj-main.mjs` 同步 REPL 与期限。`bun test tests/clj-core.test.mjs` 15 pass/0 fail；`tests/vfs*.test.mjs`、`tests/sandbox-tools.test.mjs`、`tests/main-consumer.test.mjs` 219 pass/0 fail；`tests/util-errors.test.mjs` 与 dev-acceptance smoke 通过。嵌套 omp 加载最终源码执行裸 REPL：无 program_name、写 `/tmp` 根外文件并覆盖 `AGENTS.md`，返回 `:state :completed`，`:written` 为 `/tmp/clj-nested-outside.txt` 与 `/tmp/clj-repl-nested/AGENTS.md`；程序名内部生成为 `repl-b7c3eb6c-9c6`。当前会话仍加载改动前模块，需要重启后生效；这不是验收。
- 2026-11-12：记录 clj-only 自 dogfood 修复（非验收）：真实会话先暴露 `clj_devops` 短 intent 在 `bun test` 启动阶段被 `:deadline` 挂起；继续用 `env -u BUN_OPTIONS` 复跑又暴露 `BUN_OPTIONS=--preload /home/kunweiz/.config/omp/zstd-preload.js` 被继承，导致 `bun test` 重复命令行并最终 E2BIG。源码已修：`vfs.defaultRunCommand` 用 `callEnvironment()` 过滤 `BUN_OPTIONS`/`NODE_OPTIONS`/`BASH_ENV`/`ENV`/`PROMPT_COMMAND`；`clj-main.deadlineFor` 给 plan/review/worker 5 秒、devops 60 秒下限；虚拟 `stat` 补齐 `is-file`/`is-dir`/`is-symlink`，`written` 去重；health 汇总不再覆盖工具注册失败/Cherry 缺失；只读角色不再创建 `.herd` 目录。`bun test tests/clj-core.test.mjs` 13 pass/0 fail、Biome clean。随后在独立 /tmp 工作区启动嵌套 omp 加载最终源码，短 intent 的 clj_devops 返回 :state :completed 与 :stdout "nested-ok"，证明期限下限与环境清洗在最终代码生效。当前宿主会话仍加载修复前模块，需要重启后新代码才生效；这不是验收。
- 2026-11-12：记录 clj-only 最小面真实宿主冒烟（`omp 18.19.0`，模型 `ctyun/deepseek-v4.1-flash`，非验收）：`omp plugin link /home/kunweiz/Desktop/vibe/HerdchestraLite` 成功；`omp plugin list --json` 显示 `herdchestra-lite` 的 manifest extensions 只有 `./src/clj-main.mjs`，symlink 指回本工作区。普通启动（未带 `-e`/`--no-extensions`，带 `--no-tools --no-session`）下模型调用 `clj_worker` 写入 `LINKED_PROBE.txt`；`clj_plan` 的 `write` 返回 `:CAPABILITY_DENIED` 且未创建文件；`clj_devops` 的 `(call {:command "printf devops-ok"})` 返回 `:completed` 与日志路径；同一真实会话先 `where` 多匹配 `:parked`，再 `unpark` 恢复并落盘。另用 `-e src/clj-main.mjs` 做了同四项冒烟。`tests/clj-core.test.mjs` 7 pass/0 fail、Biome clean。另用临时 `session_start` 探针捕获 `pi.getActiveTools()`：真实 active 为 `task, wait, todo, web_search, debug, clj_plan, clj_devops, clj_review, clj_worker`，黑名单中的 `read/write/edit/bash/grep/glob/find/eval` 等均不在集合中；`wait`/`task` 等未取代工具保持激活。该证据只覆盖 clj 执行器与主会话，不覆盖 `/herd`、Scope/tool-gate、角色收窄、子代理、取消、重启或验收。
- 2026-11-12：记录 r23 后当前源码与中断状态：`STAGE_SURFACES.s5` 已不含 `clj_plan`，`publishMission` 在 S5 把 `clj_plan` 追加到 `blockedTools`；Main 实际运行 `tests/main-bootstrap.test.mjs` 为 48 pass/0 fail。但 r23 真实宿主仍暴露 `clj_plan`，runner 因中断取消，改动是否真正解决尚未重测；DEBT 保留真实 S5 工具面风险与手工验收未完成，不称已交付或 S5 可用。
- 2026-11-12：记录 r23（`herd-real-s1-23`，18.16.0）：S5 activeTools 仍含 `clj_plan`，证明 r22 仅移除 `STAGE_SURFACES.s5` 常量不足，runner 正修根因。`fork_slices` 一次缺 gate 字段重试后成功，slice-01/02/03 有 handle、slice-04 pending，启动 3 个子代理；首个 `clj_review` 因 `ls expects an EDN map argument`（位置参数）停止，本轮未确认是否产品 bug。无 join/审计/报告/批准，现场保留；不称已交付或 S5 可用。
- 2026-11-12：记录 r22 S5 activeTools 产品缺陷：真实 18.16.0 S5 主会话 activeTools 含 `clj_plan`、provider schema 暴露其 gate 字段，宿主实际执行并返回 `CAPABILITY_DENIED`；该轮当时未确认产品 bug，runner t13 复核确认 S5 Coordinator 不应拥有规划期 `clj_plan`。`STAGE_SURFACES.s5` 已删除 `clj_plan`，窄行为测断言 S5 activeTools 含 fork/realign 且不含 clj_plan（main-bootstrap+runner+s5-wiring 102 pass/763 expect、Biome clean）。下一真实 S5 单轮正在启动，无验收。
- 2026-11-12：记录 lazy-fix t17/t18：t17 加的固定 5s 端口 watchdog 已删除（含 timer race、commit 超时分支、discard watchdog 参数与对应测试）；commit/discard 恢复只 race port promise 与 program control，intent deadline → parked 保留 pendingCommit/pendingDiscard，unpark 等同一 promise，取消 100ms grace → outcome-unknown/uncertain。t14/t15 的 abandoned capability、interrupted-capabilities、session.abandoned 与工具回执可见性保留。t18 报告 evaluator 105 pass/728 expect、组合 178 pass/1095 expect、Biome clean；`call` pre-drain 无独立 watchdog，drain 端口仍不支持。非验收。
- 2026-11-12：记录 r14（`herd-real-s1-14`，18.16.0）：turn-aware harness 离线验证通过（同回合兄弟豁免、后续回合同类停止、未知产品首停、全局 3 beat；r13 replay），fork_slices 出站 schema 四字段 required。真实首轮在父 `fork_slices` 被旧准入以 `SCOPE_INVALID` 拒绝 `resetScope.replacement`（allowed 仅 kind/new_scope_goal/new_scope_retention_budget）；根 flat scope schema 声明 replacement 且未禁止 resetScope，属准入白名单误拒。schema t19 已允许 resetScope/removeLast 的声明字段、保留各 kind 必需约束与 keepLast/meToo 的额外字段拒绝，r14 原始 scope 离线通过；scope+tool-gate 111 pass/480 expect、Biome clean；未改 schema.mjs/index.mjs。本轮无 fork/子 worker/兄弟回合实测，真实下一轮待测；无 S5/审计/报告/批准，非验收。
- 2026-11-12：记录 rS5 续测 s1-13（18.16.0，新 Git 副本）：provider 出站 schema 对 8 个工具记录到四个 gate 字段均 present+required，`fork_slices` 实际成功创建 3 个 worktree/分支，slice-04 按依赖 pending；t5 修复加载但失败路径未触发。`Reviewer-slice-03-T-1` 同一回合并行两个 `clj_review`（同一时间戳、均 `keepLast`）在 scope 未初始化时被拒，旧监控把第二个并发兄弟调用误判 repeat 并 abort；这是测试监控假阳性，不是 tool-gate/scope 产品 bug。原 `SCOPE_UNINITIALIZED` 回执缺少 `new_scope_goal`/`new_scope_retention_budget` 与 resetScope 示例，schema t18 已补 required/next，窄测 scope 52 pass/190 expect、tool-gate 57 pass/282 expect、Biome clean；未改 schema.mjs/index.mjs。新监控修复与下一轮未观察，无 Reviewer 完成/审计/报告/批准，非验收。
- 2026-11-12：记录 rS5（`herd-real-s1-9`，18.16.0）：全新隔离副本恢复原 session（仅 header cwd 改变，old s1-8 未动），UI 显示 mission `791e6f` 在 S4；`advance_s4` 真实成功（8264 bytes，进 S5，s4FixVerified=true），t18 修复得到真实执行。`fork_slices` 因隔离副本没有 `.git` 返回 `FF_NOT_READY`（git show-ref 失败），watchdog 停止，未进 S5、未重试；无 `.git` 时先拒绝合理，但 worktree t5 只读复核发现失败清理删掉首个失败 Slice 的 pending 行，留下 slice-02/03/04 孤立拓扑，属实证产品 bug。t5 修复为保留完整 DAG（pending + last-fork-error，清理失败则 failed + failure-reason；部分成功保留 running；容量失败可恢复；不伪造 handle），确定性故障注入 34 pass/230 expect、Biome clean；现场旧状态不会自动补回 slice-01。worktree uppercase 贯通窄测 30 pass/195 expect；t5 修复后真实 Git 副本 S5 新一轮待测，无审计/报告/批准结果，非验收。
- 2026-11-12：记录 rS4（`herd-real-s1-8`）：在全新隔离副本恢复原 session `01a1ce11...`（仅改 header cwd，原场景/文件未动），`omp --resume` 直接显示 mission `791e6f` 在 S3；`advance_s3` 首次成功（5290 bytes，revision 3，进 S4 并披露），t16 修复得到真实执行。`advance_s4` 首次被旧 `validateS4` 以缺少 `拓扑合并顺序`、`slice_id must be lowercase: SLICE-01..04`、`SLICE-04 depends_on undeclared` 拒绝；t18 确认真实文档的 `## 6. 合并拓扑` 与 uppercase `SLICE-01..04` 合法，依赖报错是误拒级联，修复后真实 payload `{ok:true,errors:[]}`，窄测 37 pass/204 expect 与 126 pass/1081 expect、Biome clean。真实 S4 重测未开始，worktree/board/runner 贯通排查中；无 S5/审计/报告/批准，非验收。
- 2026-11-12：记录真实隔离 s1-7（`herd-real-s1-7`，18.16.0）：S1 AI 模拟批准通过；S2 模型反复把 `cases[].path` 写成文件路径，五类 category label 未覆盖，多次 `CASE_REQUIRED_PATH_MISSING`/一次 `SCOPE_INVALID` 后 watchdog 停止，S2 未保存、`cases.edn` 未创建、未到 S3。Schema 拒绝正确，但旧回执只回 `data.code`，丢掉 `stage`/`errors`/`required`/`missing`/`received`/`next`；stage-parsers t17 修复 `validationFailure` 包装（outer `:INVALID_ARGUMENT`，data 保留结构化 errors，path 明确为 category label），窄测 34 pass/194 expect 与 89 pass/877 expect、Biome clean。S3 恢复复测进行中；无 S3/S4/S5/审计结果，非验收。
- 2026-11-12：记录真实隔离 rS3（`herd-real-s1-5`，18.16.0）：S1 AI 模拟批准、S2 首次成功并以结构化 `cases` 冻结 5 CASE 的 `cases.edn`（CASE-01..05，正常/错误/边界/并发/恢复）；随后 `advance_s3` 被旧 `validateS3` 以缺少 `依赖图`/`CASE 对应表` 拒绝，真实 payload 使用 `## 模块 DAG` 且 `mapped_cases` 已覆盖 5 CASE。stage-parsers t16 修复：只要求模块边界与依赖图标题，接受 `模块 DAG`/`dag`，删除 Markdown CASE 映射/失败隔离标题断言，保留结构化覆盖校验；真实 payload 校验通过、窄测 32 pass/172 expect 与 89 pass/877 expect、Biome clean。真实 S3 重测进行中，无 S3/S4/S5/审计结果；非验收。
- 2026-11-12：记录 D13 阶段控制态 clean-break 落源码（非验收）：`:frozen` 七项、`s1-summary.md`、`cases.edn`、`mission.edn :s3-modules`、`:s4-slices`、contract-line 纯渲染、`realign_frozen`、S5 从冻结 `cases.edn`/`s1-summary` 读取并绑定活哈希、board `dependency_paths`/`condition:` 与 clj CASE 边界。组件窄测报告：contract 38、gate/parsers/contract 67、main-bootstrap/main-consumer 47、runner/main-bootstrap/s5-wiring 101、audit/scores 70、sandbox-tools 60（组合 178）；无统一全量收口，audit-isolation 组合曾报 2 个 `main-bootstrap` structured-realign 断言失败（并发编辑期间）。主真实 tmux 轮次正在开始，尚无结果；不得写成验收。
- 2026-11-12：记录真实 18.16.0 隔离副本 `herd-real-s1-3` 的 S1 手工批准观察：AI 模拟操作员（非人类、非生产）在真实面板看到 49 行全文（`1-49/49`）、默认 reject；Home/PgDn 未产生视口变化，滚动未实证（文档恰好一屏）；Right 选中批准后 Enter，`advance_s1` 成功、进 S2 且观察到 S2 披露。随后 `advance_s2` 因无 `### CASE-*` 被正确拒绝，watchdog 停止；旧场景 `herd-real-s1-2` 仍在旧 S1 门禁等待。非完整验收。
- 2026-11-12：同步根 §2.2/§2.3 的 S1 手工批准术语：真实产品只由人类操作员批准；获授权的隔离测试中 AI 操作员可操作真实确认面板模拟并在实测记录注明，产品不识别操作者身份、不新增测试模式或身份字段。同步 `src/AGENTS.md` 的根文件修改纪律与 S1 门禁说明、`DEBT.md` D3；根 `AGENTS.md` 须经人类操作员明确批准后 AI 方可修改，未经批准不得修改，本轮根文件已由人类批准，AI 未改根文件，未启动 tmux。
- 2026-11-12：记录 agent://reuse-validation t8/t10/t11：t8 用真实 `createAuditorSandbox` 观察到 bwrap + 私有 tmux 启动、主工作区只读、跨调用 `runCommand` 与关闭清理；t11 在私有 tmux 内启动嵌套 omp 18.18.8，显式加载产品扩展，经 host-side canned responder（127.0.0.1:18443）回复 `D12-NESTED-OK`，provider request 2 次、relay HTTP 4 次、toolCalls 0，仅 UI/连接/工具面 smoke，无真实模型/角色审计/工具调用/提交评分批准。fake 8k context compaction warning 归因 smoke 模型。此前 plain host 阳性结论因产品未实际加载已撤回。宿主 socket 不可达、Landlock 全生命周期、prompt 顺序、真实模型 egress、K 路与 18.16.0 基线仍未验证；t8/t11 非验收。
- 2026-11-12：记录 agent://schema t15：`ctx.agent` 缺失且首行为 `[HERD_ROLE:` 的会话在 `onBeforeAgentStart` 直接 deny，G1 全工具 fail-closed 且 health degraded；无 token 主会话保持原工具面；`H1.planSpawn` 能力门要求 `hasCtxAgent === true`。窄测试报告 168 pass / 0 fail、1091 expect（因 `/tmp` 满改用 `/home` 下 TMPDIR），Biome clean；未新增 role-auth/nonce 注册表。真实 16.x/17.x 未运行，非验收证据，未跑 tmux/omp。
- 2026-11-12：记录 lazy-fix t15：新增 `session.abandoned` 会话账本，abort 时同时写 program 快照与 session 账本，同名新程序不覆盖；`abandonedCapabilities(session,name)` 改读账本，迟到 settle 后可见；`tools.mjs#runExecution` 在 receipt 中附加同名 `abandoned-capabilities`，模型可在后续同名程序回执看到迟到结算。未新增 capability/tool、未对 generic capability 调 `markUncertain`。evaluator 105 pass / 728 expect；evaluator+regex-worker+sandbox-tools 173 pass / 0 fail / 1063 expect；Biome clean。账本为 session 生命周期、无 TTL/dismiss，同名回执同时含当次快照与活记录未去重，generic capability 无 board actionId，短 watchdog 仅覆盖 commit/discard 与 100ms grace，无 drain 端口。未跑 tmux/omp，非验收证据。
- 2026-11-12：记录 lazy-fix t14：D8 的 abort 后 `:interrupted-capabilities` 回执、`program.abandonedCapabilities` 的 `:outcome-unknown` 记录与 `abandonedCapabilities(session,name)` 迟到结算读取已报告实现；程序仍 failed/aborted、迟到值只作诊断且不重试；evaluator 105 pass / 0 fail、724 expect，evaluator+regex-worker+sandbox-tools 172 pass / 0 fail、1051 expect（render 断言前运行），Biome clean；generic capability 无 board actionId、短 watchdog 仅覆盖 commit/discard 与 100ms grace、无 drain 端口仍受限。未跑 tmux/omp，非验收证据。
- 2026-11-12：记录 remaining-evaluator t3：halt-when 异步谓词/retf 与 halt 最终值经 `TransducerHalt`/`transducerContext` 传到 into/transduce 已报告修复，窄测试报告 159 pass / 0 fail（evaluator/sandbox-tools/main-consumer）、Biome clean；sequence/eduction 200000 物化上限与 memoize 线性仍受限；D8 outcome-unknown、迟到结算、短 watchdog、drain 端口未改动。未跑 tmux/omp。
- 2026-11-11：修正 auditor 隔离记录为当前源码状态（`src/sandbox/`、`AUDITOR_SANDBOX`、`createAuditorSandbox`、`ensureIsolationPaths`）；用户未确认 per-auditor 临时执行器，标为实现方按任务生命周期解释、需真实隔离验证，若与根规格冲突须由人类修改根规格；不宣称隔离通过。
- 2026-11-12：记录 evaluator lazy-fix：pull/lazyPull、LazyStream HOF、seq/rest/next、run!/sort/sort-by/update、hash/=/str/pr-str、some/every? 短路、tree-seq root/children、producer 输入、map/set 深物化、for/case/condp/letfn/when-* 宏、map :or、defn metadata 已有源码/测试覆盖；仍缺 transducer/memoize/doto/try 多重 catch，checkpoint/pendingCall 与 200000 上限仍受限；D8 commit/drain/discard watchdog、outcome-unknown 未解决。未跑 tmux/omp。
- 2026-11-12：记录 remaining-evaluator t1：memoize/doto/try 多重 catch/同步 transducer 族与 transduce/sequence/eduction 已报告接入；异步解释器 transducer、惰性 sequence/eduction、catchParts 边界、memoize 上限仍受限；D8 端口 reject/commit/discard 清理已修，abandoned capability :outcome-unknown、迟到结算、短 watchdog、drain 端口仍未解决。未跑 tmux/omp。
- 2026-11-12：记录 remaining-evaluator t2：异步 transducer 回调/reducer、惰性 sequence、可重复 eduction、三参数 into HOF、catch 缺绑定解析拒绝已报告接入；halt-when 异步谓词/retf 与 halt 最终值、200000 物化上限、memoize 线性仍受限；D8 outcome-unknown、迟到结算、短 watchdog、drain 端口仍未解决。未跑 tmux/omp。
- 2026-11-11：记录多工人修复（审计重试/恢复、`worktrees.edn`、看板原子 wake、真实 `$W$`+claim、`call` 取消/日志、冻结文件 realign、Scope）的源码与窄自动化状态；未真实宿主复测，`agent://evaluator` D7/D8 限制保留。
- 2026-11-11：按“每批已知 bug 修完后一轮 tmux”的政策更新 F1/F2/F3 与源码修复项；F2/F3 仅旧快照通过，F1 仍修复中，八项源码修复未真实宿主复测。本轮未运行 tmux/omp。
- 2026-11-11：首版。记录宿主 18.16.0/17.3.5、`omp plugin list` 指向 public、真实 hook 探针、`runSubprocess` 探针、cherry 0.6.38 临时安装、Git/worktree 拓扑与当前验收缺口。
- 未修改根 `AGENTS.md`、`package.json`、`src/` 或其他产品源码；本文件为新增记录。

## 2026-11-13 同步 I/O 禁令与异步化（默认面验收）

- 事实：同步 fs API 在 omp 宿主主线程或共享 sandbox worker 的事件循环上执行，会阻塞 TUI、输入与其他会话；这是 bug，不是风格问题。
- 已改：`src/util/file-lock.mjs`、`src/util/broker.mjs`、`src/util/atomic-write.mjs`、`src/clj-main.mjs`、`src/clj-sandbox/{tools,sandbox-worker,observations,cherry,vfs}.mjs`（默认面路径）全部改用 `node:fs/promises`；`acquireLock`/`inspectLock`/`releaseLock`/`withLock`/`normalizeLockPath`/`writeFileAtomic`/`writeEdnAtomic` 现为 async，调用点必须 await。
- 并发修复：`clj-main` 的 host tool 上下文从单槽改为 `hostToolContexts: Set`，并发 `clj_*` 不再互相清空 `write` 桥。
- 默认面缺陷修复：程序期限改为 `1000ms + code UTF-8 字节 * 50ms`；`time_leap` 在存在 parked 程序时拒绝；回执改用 `printUfss`（去掉 JSON.stringify）；`write` 成功后刷新 stamp 表，`rm`/`mv` 失效相关 stamp；`read` 缺失路径返回结构化错误。
- 未开启装配仍含同步 fs（`src/host/subprocess.mjs`、`src/sandbox/*`、`src/stages/*`、`src/swarm/*`、`src/main.mjs` 的部分路径）；接回完整装配前必须按同一规则异步化，见 DEBT。
- 测试：默认面 `clj-core`/`sandbox-tools`/`observations`/`file-lock`/`atomic-lock`/`atomic-write`/`broker` 全绿；完整装配 `main-bootstrap` 仍有既有失败，其中 `writeDevopsReport` 异步化的测试调用点待补 await。

## 2026-11-13 KISS VFS、宿主写与令牌不变量

- VFS 不再持有写入 overlay。`write`/`mkdir`/`rm`/`mv` 逐条通过宿主 native 工具真实落盘，`path` 令牌保证同路径互斥；`call` 仍由 `global` 令牌 + 跨进程粗锁覆盖整个运行期，`:running`、`:uncertain`、`:cancelled`、`:outcome-unknown` 记账未变。
- 删除 batch 预演/commit/read-set 提交路径；`s2-cases.edn`、`plans/` 等写路径仍由各自门禁工具负责，不经过 VFS。
- `src/sandbox/bwrap.mjs` 删除 Landlock、路径包含/隐私/前缀校验与模型 seed/relay；保留 bwrap namespace、显式 bind、环境覆盖。PATH_ESCAPE 不再从 sandbox 路径抛出；`PATH_ESCAPE` 错误码仍供 evidence 校验等既有调用使用。
- `clj_*` 的 `name` 必填，`validateAndApplyFork` 对会话内已用名直接 `NAME_TAKEN`，因此每个锚点都有稳定 `toolCallId` 与唯一名称。
- `time_leap` 以 `toolCallId` 为唯一物理键；`timeLeap` 在登记前同步校验目标锚点，`resolvePendingLeap` 只按 call-id 裁剪并保留 pending 直到成功。
- 测试：dogfood 面 `bun test tests` 200 pass / 0 fail，4.4s；依赖旧 batch/完整装配的文件以 `.disabled` 停用。完整装配未验收。

## 2026-11-13 事件驱动锁等待与并行 dogfood

- `file-lock.mjs` 新增 `acquireLockWhenFree`/`withLockWhenFree`：用 `fs.watch` 等目录重命名事件，不再每 10/15ms 轮询；`timeoutMs` 可注入。`clj-main` 的宿主 `write` 锁与 `sandbox-worker` 的 global/write gate 已切换。
- `vfs.defaultRunCommand` 删除 25ms 进程组轮询，改为 `exit`/`close` 事件；`exit` 后仅做一次 `groupAlive()` 风险标记。
- `src/clj-sandbox/inline-worker.mjs` 提供 Worker 消息面，`clj-main` 支持 `workerFactory` 注入；clj-core 测试改用进程内 runtime，不再起 worker 线程。
- `tests/clj-core-wait.test.mjs` 从 `clj-core.test.mjs` 拆出 4 个计时测试，Bun 可与其他文件并行；测试内 `baseWaitMs` 与 sleep 时长显式注入/缩短。
- `package.json` 的 `test` 改为 `bun test tests --parallel`：18 个 dogfood 文件、203 tests、约 0.5s，按 CPU 核数并发；直接 `bun test tests` 仍可用但为串行调度。

## 2026-11-13 dogfood 验收修复

- `file-lock.waitForLockChange` 在安装 `fs.watch` 后立即 `stat` 锁文件，关闭“释放发生在 acquire 失败与 watcher 安装之间”的丢失唤醒竞态。
- `glob-pool.ensurePool` 按实际路径数创建 worker（上限 8），不再为 2 个路径启动 8 个线程。
- `vfs.runCall` 日志文件名改用 `basename`，避免根目录/尾随分隔符下的切片错误。
- 验证：`bun run test` 203 pass / 0 fail。

## 2026-11-13 dogfood 最终真实宿主验收

- write/cat: dogfood-probe.txt 内容 dogfood-ok，10 bytes。
- call: printf call-ok，exit 0，status completed，日志 .herd/artifacts/clj-core/。
- wait: 无后台任务时返回空闲，不误挂起。
- time_leap: 目标 dogfood-write-cat，target-call-id 生成；ask_beacon dogfood-beacon-1 返回正确内容，证明 pending 已解析并封存。
- 名称唯一: 复用 dogfood-write-cat 返回 NAME_TAKEN。
- toolFailure 改为 renderError 的 EDN+UFSS；dogfood 200 pass / 3 skip / 0 fail，约 630ms。
- 未验收: 完整 S1-S5、审计、worktree；相关测试仍 disabled。

## 10. nbb `cljs.pprint` 实测（2026-11-14）

- nbb 1.6.215 自带 `cljs.pprint`；`(require '[cljs.pprint :as pp])` 与 `(pp/pprint v)` 可用。
- SCI 版只导出 `*print-pprint-dispatch*`、`cl-format`、`code-dispatch`、`pprint`、`print-table`、`with-pprint-dispatch`；没有 `*print-right-margin*`、`*print-miser-width*`、`write`；`ns-resolve` 也拿不到宽度变量。
- 默认宽度约 72 列；实测 `{:a (vec (range 26))}` 输出 2 行（最长 71），27 个元素时退化为每元素一行。宽度不可由调用方配置。
- `herd.ufss/canonical` 的数据层现在用 `with-out-str` + `pprint`，去掉尾部换行后交给 `standard-clojure-style` 与 `wrap`。
- 复检：`./node_modules/.bin/nbb --classpath src -e "(require '[herd.ufss :as u]) (u/canonical (vec (range 40)))"` 应输出多行且可被 `u/read` 读回。
- 宿主扩展加载器解析到的 bare/bundled `nbb` 不提供 `cljs.pprint`：`nbb.loadString("(require '[cljs.pprint :as pp]) ...")` 返回 `No namespace: cljs.pprint found`，静态 `pp/pprint` 因此 unresolved。
- `src/clj-main.mjs` 现在用 `createRequire(realpath(clj-main.mjs))` 与显式 `node_modules/nbb/index.mjs` 候选加载插件自带的 1.6.215 nbb；用 `nbb.registerModule(formatter, "@chrisoakman/standard-clojure-style")` 注册 formatter。`registerModule` 的参数顺序是 `(module, name)`。
- `bootstrap.cljs` 的源码根从 `nbb.classpath/get-classpath` 与 `globalThis.__herdPluginSrc` 解析，不再依赖 `process.cwd()`；从 `~/tmp` 运行 `omp -p` 可正常加载扩展。

## 11. Bun CLI 与 `BUN_OPTIONS`（2026-11-14）

- 本机环境设置 `BUN_OPTIONS=--preload /home/kunweiz/.config/omp/zstd-preload.js`；Bun 1.4.4 在带该变量时把 `bun test` / `bun run <script>` 误解析为脚本名，输出 `Script not found "test"`。
- 复检命令：`env -u BUN_OPTIONS bun test tests --parallel`。
- 该变量属于宿主环境，不是仓库配置；不要把它写进 `package.json` 或 CI。
## 12. omp 工具输出默认展开（2026-11-14，历史）

- 宿主源码 `packages/coding-agent/src/modes/interactive-mode.ts` 把 `toolOutputExpanded` 硬编码为 `false`；`omp config list` 没有对应的 `tui.*` / `display.*` 键，所以不能靠 config 改默认值。
- 公开扩展 API `ExtensionUIContext` 暴露 `getToolsExpanded()` / `setToolsExpanded(expanded)`。
- 2026-11-14 后续修订：`herd/main.cljs` 已删除 `session_start` 的 `setToolsExpanded(true)` 调用；默认展开交给宿主与用户。非展开态保留标题、hrule 与完整多行正文，只把多行或超过 40 字符的字符串替换为 dim `$$$`；单行且不超过 40 字符的字符串正常渲染。`Ctrl+O` 仍可手动切换；插件不直接改宿主内部字段。
- 复检：重启 omp 后，默认不再强制展开；长字符串显示 `$$$`，短单行字符串保持可见。
## 13. 宿主 `@oh-my-pi/pi-tui` 高亮能力（2026-11-14）

- `src/clj-main.mjs` 的 `await import("@oh-my-pi/pi-tui")` 在宿主可解析；实测 `typeof tui.highlightCode === "function"`。
- `highlightCode(code, "clojure", theme)` 返回 ANSI 行；原生高亮器把 `clj`/`clojure` 映射到 Clojure。
- CLJS 通过 `globalThis.__herdTui` 读取该模块，不静态 `:require`；测试或无 UI 环境未注入时自动回退原文。
- 彩虹括号由 `herd.ufss/delimiter-spans` 提供深度信息，`herd.highlight` 做 ANSI overlay；不是 Neovim 插件移植。
## 14. highlight.js 内容语言识别（2026-11-14）

- 宿主 `detectLanguageId(path)` 只按路径识别；`highlightCode(text, lang, theme)` 必须显式语言，没有内容自动识别。`cat` 的结果是纯字符串，不带路径，所以不能直接使用宿主 path-based 识别。
- 工具结果正文改用 `highlight.js@11.12.0` 的 `highlightAuto` 做内容识别；只注册 `clojure` / `javascript` / `typescript` / `json` / `bash` / `markdown` / `xml` / `yaml` / `sql`，加载 `highlight.js/lib/core` 与对应 language 模块；无其他传递依赖。
- `src/host/language-detect.mjs` 负责加载与映射：`xml` → `html`，其余同名映射到宿主 `highlightCode` 的语言名；`src/clj-main.mjs` 装配后暴露 `globalThis.__herdDetectLanguage`；`herd.highlight` 只委托，不再包含手写语法规则。
- 实测：`import x from "y"; const z = 1;` → `javascript`；`(+ 1 2)` → `clojure`；`{"a": 1}` → `json`；纯文本 → `nil`；`src/clj-main.mjs` 全文 → `javascript`。
- 识别失败、模块缺失或纯文本时返回 `nil`，回退原文；不影响工具执行。高亮仍由宿主 native `highlightCode` 完成。
## 15. `context` 钩子收到深拷贝消息（2026-11-14）

- 事实：真实宿主在调用 `context` 钩子前重建消息对象；`sessionManager.getLeafEntry().message` 与 `event.messages` 末尾消息深度相等，但 `!==`。一次性 pre-hook 诊断：`identity-index: null`、`deep-index: 203`、`messages-len: 204`。
- 后果：`src/host/hack-context.mjs` 原先只按对象身份找追加点，identity 永不命中，导致每回合 `rewriteSession` 全量重写会话；`.herd/handoff-boundary.log` 的 `entries` 每回合 +2，session 文件反复重建。
- 修复：`persistedPrefixLength` 先按 identity 扫描，再按 `deepEqual` 从末尾扫描最后持久化消息；`hackContext` 用该值决定 append/rewrite。首刀仍重写一次，后续深拷贝消息只 append 或 no-op。回退：只保留 identity 扫描并把 `prefixLen` 设为 `-1` 即恢复旧行为。
- 验证：Node fake-manager 深拷贝 diag 输出 `{r1:1,r2:1,r3:1,appends1:1,appends2:1,ok:true}`；真实宿主 live wrapper 日志从 `rewrite entries 39..61` 变为 `deep-noop prefix=len`，rewrite 计数停在 40；`node --check` 与 `biome check src/host/hack-context.mjs tests/hack-context.test.mjs` 均通过；回归测试已加入 `tests/hack-context.test.mjs`。
- 未验证：源码修复需重启宿主后才加载；当前进程使用等价的 in-memory live wrapper。重启后继续观察 `.herd/handoff-boundary.log`，不应再出现每回合 `rewrite`。

## 16. 上下文机制收敛：Handoff 取代 Ariadne/Time Leap（2026-11-14）

- 人类操作员批准删除 Ariadne/Time Leap/Beacon，`handoff` 成为上下文换血的唯一入口。
- 删除：`src/herd/ariadne.cljs`、`src/scope/ariadne.mjs`、`src/scope/beacon-query.mjs`、`tests/cljs-ariadne.test.mjs`、`tests/ariadne.test.mjs.disabled`、`tests/beacon-isolation.test.mjs`、`tests/cljs-context.test.mjs`。
- `src/herd/main.cljs`：移除 `time_leap`/`ask_beacon` 工具、`ariadne` require、锚点记录与 Time Leap context 分支；默认工具面为 `clj_devops`、`wait`、`handoff`。
- 根 `AGENTS.md` 已同步：Ariadne/Time Leap/Beacon 章节改为 Handoff；scope 注解改为 `agent_state`；`$$$` 规则加入 40 字符单行例外。
- 复检：`env -u BUN_OPTIONS bun test tests/cljs-sandbox.test.mjs`（40 pass）；旧 `tests/cljs-context.test.mjs` 已删除，Handoff 由 `tests/cljs-handoff.test.mjs` 与 `tests/hack-context.test.mjs` 覆盖。
- live 宿主需重启后加载新代码；当前进程仍可能保留旧工具注册。


## 17. park/unpark 后台 Promise 语义（2026-11-14）

- 人类操作员要求：`park` 保留 Promise，后台继续执行；`unpark` 等待后台完成并取回结果；park 时增量取输出，unpark 时灌输入。
- `src/herd/sandbox.cljs`：
  - `park` 在挂起前调用 `call-snapshot`，把自上次展示以来的 `:stdout`/`:stderr` 增量合并进 payload；有活跃 `call` 时附加 `:call-active true`。
  - `notify-park!` 通知后移除 notifier，支持同一程序再次 park 时重新通知。
  - `unpark` 对活跃 `call` 先写入字符串或 `{:stdin ... :eof ...}`，同时 resolve 对应 parked Promise；两者并存时不得只做一件。
  - `abandon` 清理 notifier。
- `src/herd/repl.cljs`：
  - `mark-parked!` 保留原程序 entry 的 `:promise`，不再覆盖丢失。
  - 新增 `await-resumed`：安装 fresh notifier，`Promise.race` 原程序 Promise 与再次 park 通知；完成返回原程序结果值，再次 park 返回新的 parked 回执，失败返回 failed 回执。
  - `unpark` 对显式 park、活跃 call、deadline park、已完成/失败程序统一走 `await-resumed`；不再立即返回注入值。
  - `track!` 在完成/失败时清理 notifier。
- 测试：`env -u BUN_OPTIONS bun test tests/cljs-sandbox.test.mjs` → 44 pass / 0 fail（park 变更后）；折叠回归加入后 46 pass，见 §19；新增 `parks with incremental call output and unpark feeds stdin`，覆盖 `printf first` 增量、`:call-active true`、`(str "hello" (char 10))` 灌 stdin、`got:hello` 与 `done` 最终结果。
- 未验证：真实宿主 tmux 端到端；完整 dogfood 套件随后单独运行。

## 18. 根规格 2026-11-14 修订（人类批准）

- §1.2 宿主版本钉住更新为 `omp` 18.20.x（实测编译宿主；仓库 18.15.0 源码副本；17.3.5 仅历史）。
- §4.4.2/§4.4.6/§4.4.7 更新 park/unpark：保留后台 Promise、unpark 等待结果、增量输出、stdin 灌入、deadline park 可等待后台完成。
- §7.5 区分沙箱程序 deadline（`1000ms + code UTF-8 字节数 × 50ms`）与 `wait` 调用等待期限（`2000ms + UTF-8 字节数 × 200ms`）。
- §7.7 新增同步 fs 禁令；§9.1 增加 `MIGRATION.md`；§9.7 放行命令改为 `env -u BUN_OPTIONS bun test tests --parallel`。
- §10.4 记录 nbb 1.6.215 的 `cljs.pprint` 默认宽度约 72 列且不可配置。
- §0.4 补记禁用宿主 `read`/`write` 会切断 `xd://` 传输设备；§2.1 补记子代理首行 `[HERD_ROLE: ...]` token 与 `ctx.agent` fail-closed。
- 未验证：上述规格条文涉及的真实宿主 tmux 行为仍需按放行标准手工验收。


## 19. 非展开态字符串折叠修正（2026-11-14）

- 人类操作员要求：仅单行且不超过 40 字符的字符串在非展开预览中保留；多行字符串即使很短，以及长度超过 40 字符的字符串，一律替换为 dim `$$$`。
- 根因：`src/herd/ufss.cljs` 的 `highlight-wrap` 用 `(edn/read-string canonical)` 判定 `short?`；当多行字符串规范化为 `"""\na\nb\n"""` 时，`edn/read-string` 只读到开头的空标准字符串 `""`，于是把多行短串误判为 0 字符单行，未折叠。
- 修复：`short?` 优先使用 `(fence-at canonical 0)` 的 `:body` 判定换行与长度；只有非 fence 时才回退 `edn/read-string`。
- 测试：新增 `collapses short multiline strings to dim $$$ in previews` 与 `collapses short multiline strings in result previews`；`env -u BUN_OPTIONS bun test tests/cljs-sandbox.test.mjs` → 46 pass / 0 fail。
- 未验证：真实宿主 TUI 中的视觉确认；完整 dogfood 套件随后单独运行。


## 20. handoff 与宿主压缩的时序修复（2026-11-14）

- 风险：handoff 替换与宿主 `compaction`/`reset_boundary` 交错时，`hackContext` 的旧逻辑可能在没有可对齐前缀时调用 `rewriteSession`，整段重建 entries，删除压缩边界；也可能把旧消息追加到错误分支，导致压缩摘要与 handoff 文档顺序错乱。
- 修复：
  - `src/herd/main.cljs` 的 `consume-handoff!` 对首次消费返回 `:fresh?`，`context-handler` 输出 `handoffReplacement: true`，只在首次替换时触发。
  - `src/host/hack-context.mjs` 新增 `hasCompressionBoundary`；`lastPersistedMessageEntry` 遇到 `compaction`/`reset_boundary` 返回 undefined，不跨越边界回溯旧消息。
  - 存在压缩边界时，handoff replacement 与显式 fullRewrite 走 `appendSessionDelta(manager, after, 0)`，在边界后追加，保留边界条目；普通前缀失配只记录 `boundary-prefix-miss`，不改写宿主历史。
  - 无压缩边界时保持原行为：首次 handoff 可全量 `rewriteSession`，后续 append-only。
- 测试：`tests/hack-context.test.mjs` 新增 `appends a handoff replacement after a compression boundary without rewriting` 与 `appends ordinary tail after a compression boundary without rewriting`；相关窄测 20 pass；完整 dogfood 套件 268 pass / 1 skip / 0 fail。
- 未验证：真实 omp 在上下文超限触发压缩时的实际时序；仍需 tmux 手工验收。
