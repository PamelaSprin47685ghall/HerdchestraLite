# UFSS 标准

> 本文是 UFSS（Universal Fence-Scaled String）的唯一标准。`AGENTS.md` 只引用本文，不重复展开。实现与本文冲突时，以本文为准；宿主 API 的机械差异记录在 `HACK.md`，未实现项记录在 `DEBT.md`。

## 1 定义

UFSS 是 **ClojureScript 字符串字面量的可逆方言**，不是独立语言，也不替代 EDN。它只改变字符串字面量的表示，不改变 form 结构、注释、符号、reader macro 或求值语义。

用途：

1. 系统回执中的字符串。
2. ClojureScript 源码中的字符串字面量（由 pre-pass 展开后交给官方 reader）。

## 2 字面量形式

| 形式 | 语法 | 适用 |
|---|---|---|
| 标准字符串 | `"..."` | 无引号、无反斜杠、无换行；控制字符的唯一合法形式 |
| 单行 fence | `#"..."#`、`##"..."##`、`###"..."###` … | body 含引号、反斜杠或 `#`，不含换行 |
| 多行块 | `"""` + 换行 + body + 换行 + `"""`，可带 `#` 深度 | body 含换行 |

- body 逐字保留，不做转义、trim 或 Unicode 归一化。
- 多行块的开 fence 后必须换行；body 顶格；闭合 fence 独占一行（允许尾随文本）。
- 闭合 fence 允许尾随文本，例如 `"""} `、`""",`；reader 在 fence 处结束字符串，尾随文本继续解析。
- body 缩进按闭合 fence 的缩进剥离；短缩进不报错，尽量剥离。
- 未闭合 fence 是唯一硬错误：`:UFSS_UNCLOSED`。

## 3 围栏深度

- 深度任意：零个（裸多行块）、一个或更多 `#` 都合法。
- writer 取**最小安全深度**，不默认 `##`。
- 单行：body 中不出现 `"` + `#`×n 即可。
- 多行：body 中不出现 `"""` + `#`×n 即可。
- 正则 `#"..."` 的 body 中未转义的 `"` 会结束正则，因此 `"#` 不可能出现在合法正则 body 中；闭合 `#` 是 fence 的可靠判据。

## 4 读取语义

1. `#"..."`（无闭合 `#`）是 ClojureScript 正则，原样保留。
2. `#"..."#`（有闭合 `#`）是 fence，读取为字符串。
3. 闭合 fence 后允许尾随文本。
4. 短缩进宽容剥离。
5. 只修改字符串字面量区间；不触碰注释、符号、reader macro、form 结构。
6. 已批准公理：**不使用逐字节解析器**。解析必须复用官方 CLJS reader 的字符串边界信息；UFSS 只负责 fence 的展开与渲染。

## 5 写入与标准格式化

标准格式化流水线：

```text
ufssify(cljs) = pprint(ufss(cljs))
```

- `ufss`：把每个字符串渲染为标准字符串 / 最小 fence / 顶格三引号块。
- `pprint`：官方 `cljs.pprint` 负责集合布局、换行与缩进。
- `*print-right-margin* = 80` 是标准要求；实现必须固定该宽度，不得受调用方默认值影响。
- 多行 body 顶格；闭合 `"""` 与后续 `,` 同行。
- 字符串外的字节逐字保留。

## 6 公理

`=` 是严格相等，`~` 是语义一致。

### A 核心

| 编号 | 公理 |
|---|---|
| A1 | `ufssify(x) = pprint(ufss(x))` |
| A2 | `parse(ufssify(x)) ~ x` |
| A3 | `ufssify(parse(ufssify(x))) = ufssify(x)`（幂等） |
| A4 | `parse(format(v)) = v`（数据层严格双射） |
| A5 | `format(parse(format(v))) = format(v)`（数据层幂等） |
| A6 | 同一值的 `ufssify` 输出唯一（确定性） |

### B 表示

| 编号 | 公理 |
|---|---|
| B1 | 无引号/反斜杠/换行的 body 用标准字符串 |
| B2 | 控制字符必须用标准转义字符串 |
| B3 | 含换行的 body 用三引号块 |
| B4 | 围栏深度取最小安全值 |
| B5 | body 逐字保留 |
| B6 | 多行 body 顶格，闭合 fence 与 `,` 同行 |

### C 解析

| 编号 | 公理 |
|---|---|
| C1 | `#"..."`（无闭合 `#`）是正则 |
| C2 | `#"..."#`（有闭合 `#`）是 fence |
| C3 | 闭合 fence 后允许尾随文本 |
| C4 | 短缩进不报错，尽量剥离 |
| C5 | 未闭合 fence 是唯一硬错误 |
| C6 | 只改字符串字面量，不改 form 结构 |

### D 集成

| 编号 | 公理 |
|---|---|
| D1 | 自举内核只用标准字符串子集，官方 CLJS reader 可直接读 |
| D2 | 业务 CLJS 可含 fence，由 pre-pass 展开后交给官方 reader |
| D3 | UFSS 不改变求值语义 |
| D4 | canonical 输出固定 `*print-right-margin* = 80` |

### E 实现纪律

| 编号 | 公理 |
|---|---|
| E1 | 禁止逐字节解析器；必须复用官方 reader 的边界信息 |
| E2 | UFSS 只实现字符串字面量的展开与渲染，不实现 CLJS 语义 |
| E3 | 源码规范化不得引入新的 form 结构或改变注释 |

## 7 源码集成

- 业务 CLJS（`src/herd/prompts.cljs`、`sandbox.cljs`、`repl.cljs`、`main.cljs`）按本标准的字符串形式书写。
- `src/herd/bootstrap.cljs` 先 `unwrap` 这些文件，再交给 `nbb` 官方 reader。
- `src/herd/ufss.cljs` 与 `bootstrap.cljs` 是自举内核：其字符串字面量全部是标准字符串（无引号/反斜杠/换行），因此官方 reader 可直接读取，不需要 pre-pass。
- 自举内核不使用 fence；这是 D1 的具体形式。

## 8 已知偏差

- `nbb` 的 `cljs.pprint` 未暴露 `*print-right-margin*`（仅有 `*print-pprint-dispatch*` 等），D4 目前只能作为目标；实现需在 writer 层模拟宽度或在 `DEBT.md` 记录。
- 源码规范化不再提供逐字节 `canonicalize`；`herd.ufss/literals` 使用官方 `edamame` reader（`:deref`、`:fn`、`:regex`）读取源码并收集字符串。源码文本的自动替换仍由生成器/人工保证，不在运行时做区间改写。
- `edamame` 在 nbb 中的 `:location?`/`:postprocess` 不可用（`H.call` 错误），因此无法在解析回调中直接替换字符串；只能解析后遍历。
