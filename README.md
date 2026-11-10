# HerdchestraLite

一个 omp 插件包。三个入口各自独立加载：

- `src/main.mjs`：提示词、上下文投影、pi-context、pi-goal、手动验收。
- `src/tool-gate/index.mjs`：给每次工具调用加两个必填参数，执行前再剥离。
- `src/editor-theme/index.mjs`：让 pi-goal-x 的对话框在宿主 TUI 上正常渲染。

当前为骨架阶段：三个入口只导出空工厂，业务按域逐个迁入。

本 README 只写新包自身，不转述、不压缩旧版设计说明，也不把旧结论改写成新说法。旧版设计说明的原文将完整复制为 `docs/design.html`，原样保留、不做删改；两份文档互不替代。

## 安装

前置：

- omp 18.18.6（本包按此版本开发；更高版本未经验证）。`@oh-my-pi/pi-coding-agent` 与 `@oh-my-pi/pi-tui` 由宿主提供，本包不声明它们。
- Bun 1.4.4 或更高。

```bash
bun install
omp plugin link /home/kunweiz/Desktop/vibe/HerdchestraLite
omp plugin list
```

必须用 `omp plugin link` 或 `config.yml#extensions` 挂载。omp 的原生目录扫描只认 `.ts`/`.js`，本包是 `.mjs`，只把目录放进扩展目录不会被加载。

兼容性：`pi-context` 与 `pi-goal-x` 的深路径导入依赖 omp 的 `@earendil-works/*` 重写，只在 omp 扩展加载器内成立。在普通 Node 进程里直接 import 入口不保证可用。

## 目录结构

```text
HerdchestraLite/
├── package.json          # omp.extensions 与 pi.extensions 列出三个入口
├── biome.json            # 格式与 lint
├── src/
│   ├── main.mjs          # 主入口（空工厂）
│   ├── tool-gate/
│   │   └── index.mjs     # 工具门入口（空工厂）
│   ├── editor-theme/
│   │   └── index.mjs     # 主题入口（空工厂）
│   └── util/
│       ├── atomic-write.mjs  # 同目录临时文件 + rename
│       ├── errors.mjs        # messageOf / errorCode
│       └── objects.mjs       # isObject / unknownFields
└── tests/
    └── atomic-write.test.mjs
```

`src/manual-acceptance/`、`src/prompts/`、`src/host/` 等目录随对应切片的实现加入；`docs/design.html` 由迁移步骤原样加入。

## 使用

加载后，omp 依次绑定 `main`、`tool-gate`、`editor-theme` 三个工厂。工厂只注册事件、工具和命令，不在加载期发送消息或切换活动工具。

本包设计中的入口（尚未注册，不是对旧文档的转述）：

- 命令：`/goal-x`、`/acm`、`/sisyphus`。
- 工具：三个 `submit_*`、三个 `context_*`、goal 工具。
- 手动验收文档写在 `docs/manual-acceptance/<slug>/`。

骨架阶段这些均未注册。开发期检查：

```bash
bun test   # 只测纯函数与文件工具
bun run check
```
