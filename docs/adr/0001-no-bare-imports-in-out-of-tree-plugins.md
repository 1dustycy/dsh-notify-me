# ADR-0001：bundle 之外的插件不 import 裸包名

## 状态

已采纳（2026-10-04）

## 背景

`dsh-notify-me` 需要一份运行时配置（标题、提示音、内容行取什么、投递方式）。
DSH 里插件声明配置的惯用做法是导出 Cordis 的 `Config` schema：

```js
import z from "@deepseek-ai/schemastery";
export const Config = z.object({ title: z.string().default("DSH") });
```

Loader 会用这份 schema 校验 profile 里写的 `config:`，填默认值，并把
schema 投影到设置界面。所有随应用分发的插件都这么写。

但这个插件装在 `~/.dsh/profiles/desktop/node_modules/`，属于 **bundle 之外**。
按上面的写法挂上去之后，条目停在 `fiberPhase: null`——没有报错，没有诊断，
就是什么都不做。

用四个探针插件在同一 profile、同一次热加载里对照，变量只有一个：

| 插件里的 import | 结果 |
| --- | --- |
| 无 | ✅ `active` |
| `import z from "@deepseek-ai/schemastery"` | ❌ `fiberPhase: null` |
| `import { readFileSync } from "node:fs"` | ✅ `active` |
| `import { marker } from "./side.js"` | ✅ `active` |

结论：**dsh Desktop（Electron 主进程）不会为 bundle 之外的插件解析裸
`@deepseek-ai/*` 说明符**，而 `node:` 内置模块和相对路径不受影响。

这个坑的症状极具误导性：用户已有的 `dsh-thinking-labels` 插件也死在同一个
原因上（启动日志里一句 `dsh-thinking-labels: import failed`），很容易被当成
插件自己的 bug。

### 为什么裸 import 需要特殊解析

随应用分发的插件位于 `app.asar/dsh/node_modules/` 下，`@deepseek-ai/schemastery`
按 Node 默认的向上查找就能命中。bundle 之外的插件在
`~/.dsh/profiles/<name>/node_modules/` 下，向上走到 `/` 也没有这些包，
必须靠 DSH 装的那个解析拦截（`dsh-app-boot` 的 `installRuntimeInterception`，
经 `node-addon-require-builtin` 改写 Node 内部的 ESM/CJS 解析器）兜住。

拦截器只对「有拦截层覆盖的导入方 URL」生效
（`router.hasInterceptionLayerForUrl(parent)`）。实测结果是：在 `dsh` CLI
启动的普通 Node 宿主里拦截生效，在 Electron 主进程里对 bundle 之外的插件不生效。
具体是哪一层的差异没有继续深挖——对本插件来说，绕开它比修它便宜得多。

## 决定

**`dsh-notify-me` 不 import 任何裸包名。**

- `lib/index.js` 只 import `node:` 内置模块和同目录文件。
- 不导出 `Config` schema，改在 `lib/config.js` 里手工归一化：逐项检查类型和
  枚举取值，不对就退回默认值并 `warn` 一次。
- `test/notify.test.mjs` 里有一条用例扫 `lib/index.js` 的 import 说明符，
  发现裸包名就失败，防止以后顺手加回来。

## 后果

**好处**

- 插件在 Electron 宿主和 CLI 宿主里都能加载。这是它唯一的存在理由。
- 零依赖，不需要 pnpm 安装，`link:` 一个 symlink 就能用。

**代价**

- 丢掉 Loader 侧的校验：写错的值不再让条目加载失败，而是静默退回默认值。
  用 `warn` 补回可见性，但不如原来的报错醒目。
- 设置界面里不会为这个插件渲染配置表单（schema 不是原生 schemastery，
  Config Inspect 会报 `unsupported`）。配置走 `cordis.patch.yml`，这本来也是
  该 profile 文档指定的唯一配置源。
- 如果哪天 DSH 修好了 bundle 外插件的裸 import 解析，这里的取舍就该重新评估：
  那时可以换回 `Config` schema，代价是重新引入一个 peer 依赖。

## 相关

- `README.md` 的「为什么这个包一个依赖都不 import」一节
- `test/notify.test.mjs` 的 `the package imports nothing outside node: and its own files`
