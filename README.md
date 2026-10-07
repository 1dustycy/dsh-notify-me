# dsh-notify-me

每轮回答结束时，在 macOS 上弹一条原生通知。

DSH 干完活、把控制权交回给你的那一刻（agent 转入空闲），通知就会出现在通知中心。
不需要盯着窗口，切到别的 App 也不会漏。

```
┌────────────────────────────────────┐
│ 会话轮次结束                        │
│ 重构登录模块                         │
└────────────────────────────────────┘
```

第一行是**标题**，第二行是**内容**（默认会话标题，可改成回复摘要）。
只有回合**不是**正常完成时才多一行状态，例如 `出错了 · upstream 503`——
正常完成时用户已经知道那三个字什么意思，多一行只是重复。

## 装到 dsh Desktop

已经装在 `~/.dsh/profiles/desktop` 里了。重装或换机器时用 `plugin_manager` 的
`install_bundle`，把**包目录**作为 target 传进去即可：

```
plugin_manager(action: "install_bundle", target: "/Users/<you>/local_repo/dsh-notify-me")
```

它会自己完成 pnpm 安装、把包加进 `dsh.profile.bundles`、建 symlink、更新 lockfile，
**不要**手工去写 profile 的 `package.json` 或 `cordis.patch.yml`——那是它的活，
两边都写会像 `dsh-sidebar-drawer` 之前那样把同一个插件挂载两次。

装完它会出现在**设置 → 插件**里（卡片标题和描述读 `locale/{zh,en}.json`，图标读 `icon.svg`）。

**卸载**用 `plugin_manager(action: "remove_bundle", target: "dsh-notify-me")`。

## 配置

插件自己那层（`cordis.patch.yml` 里的 bundle patch）把 `delivery` 设成了 `client`。
要改任何设置，就在 profile 自己的 `cordis.patch.yml` 里按 **id 覆盖**，改完存盘即热加载——
**不用重启应用**：

```yaml
- id: notify-me
  config:
    body: reply          # 想直接看到回答摘要
    sound: ""            # 静音
```

注意 id 覆盖会**整份替换**该行的 `config`，不是逐字段合并；没写的字段由插件自己的
默认值兜底，所以只写你要改的那几项就行。

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后插件仍然挂载，只是不弹（两半都不弹） |
| `title` | `"会话轮次结束"` | 通知标题 |
| `sound` | `"Glass"` | macOS 提示音名；空串＝静音 |
| `body` | `"session-title"` | 内容行：`session-title`｜`reply`（回复摘要）｜`none` |
| `delivery` | 包内设为 `"client"` | 谁来弹：`client`（渲染进程，带图标可点击）｜`osascript`（宿主，点不动但必弹）｜`auto`｜`electron` |
| `notifyAborted` | `false` | 你自己按停止的那一轮要不要也弹（两半都认这条） |
| `maxBodyChars` | `160` | 内容行字符上限 |

写错的值不会让插件挂掉：会退回默认值，并在日志里说明哪一项被忽略了。

### 通知长什么样，以及为什么

通知的归属应用是 **Script Editor**（左图标是它的），**点不动**。
这不是配置问题，是 `osascript -e 'display notification ...'` 的固有限制：
它既没有点击回调，也不能换图标。

之所以只能用它，是因为宿主进程用不了 Electron 的 `Notification`：

> dsh Desktop 用 Electron 二进制以 **Node 模式**（`process.type === null`）启动宿主
> 子进程。`import("electron")` 能解析成功，但拿到的是**空对象**——
> 浏览器 API 面整个不存在。GUI 窗口在另一个进程（浏览器进程）里，
> 两者之间的 IPC 只认 `ready` / `platform-session` / `shutdown-complete` / `fatal`
> 几种固定消息，没有能弹通知的口子。

详见 [ADR-0002](docs/adr/0002-notifications-need-the-renderer.md)（含实测的 dump 证据）。
**点击跳转、自定义图标这两件事只能在渲染进程里做**，那是后续工作。

### 两种投递方式

| `delivery` | 谁弹 | 归属 / 图标 | 能点击跳转 |
| --- | --- | --- | --- |
| `client` | GUI 渲染进程，Web Notifications | **DeepSeek Harness**，带 dsh 图标 | ✅ 跳到对应 session |
| `osascript` | 宿主，`osascript -e 'display notification'` | Script Editor | ❌ |

实现细节（观察点为什么必须在常驻 slot、闸门为什么反过来）见
[ADR-0002](docs/adr/0002-notifications-need-the-renderer.md)。

两者**互斥**：宿主把解析后的 `delivery` 通过页面注入告诉 Client 那半
（`window.__DSH_NOTIFY_ME__`），同一时刻只有一边出声。

判断方向是**除非明确说 `osascript`，否则由 Client 弹**。刻意如此：反过来的话，
一旦注入失败 Client 就永久沉默，而"注入失败"和"插件正常但没话说"表现完全一样，
没法区分。现在最坏情况是"可能弹两条"——一眼能看见。

注入里**只有"谁出声"**：页面活得比配置久，把 `enabled` 这类开关塞进页面，
改了配置就会有一个过期的值替你做主。

**弹什么由宿主说了算。** Client 那半能从状态表里看出"某个会话不跑了"，但看不出
**为什么**——状态表里只有 `running` / `pendingInteraction`，你按没按停止不在里面。
所以每轮结束它都回头问一句宿主：
`GET /api/notify-me.turn-end?session=<id>` → `{"announce": true|false}`，
答案是宿主自己那条 `shouldNotify` 的结论（`enabled`、子会话、手动停止、`notifyAborted`
全在里面，所以改配置对已经开着的页面也生效）。这条路由挂在 Connection 的 Fetch
注册表上，走的是页面本来就有的 Host/Origin 围栏和浏览器会话 cookie，不需要另一套凭据。
问不到就照弹：宿主不吭声不等于什么都没发生。

Client 那半弹不出来时（权限不足等），界面左下角会出现一个小条说明原因，
不会静默失败。

`client` 只有在 GUI 页面活着的时候才有效——页面关了就没有通知。
`osascript` 不受这个限制。

### 没弹出通知？

1. **把 `delivery` 换成 `osascript`**（改 `cordis.patch.yml`，即时生效不用重启）。
   它一定弹得出来，可以据此判断是「client 那半没生效」还是「整个链路断了」。
2. 看「系统设置 → 通知」里 **DeepSeek Harness**（`client`）或 **Script Editor**
   （`osascript`）有没有被静音或关掉。
3. 确认 `enabled` 不是 `false`，并且这一轮不是你自己按停止的（除非
   `notifyAborted: true`）。这两条现在两半都认：Client 那半问宿主的路由
   （`/api/notify-me.turn-end`）拿答案。

## 触发时机

触发点是会话日志里**已提交**的 `turn/end` 事件，而不是 `agent/status → idle`：
后者在会话加载、以及每次被唤醒投递时也会翻一次，前者一轮只出现一次，
并且带着这一轮结束的原因。

| 结束原因 | 状态行 |
| --- | --- |
| `completed` | 不加状态行，只有标题和会话标题 |
| `error` | 出错了 ·（错误摘要） |
| `max-tokens` | 达到长度上限 |
| `blocked` / `interrupted` / `forked` | 已阻止 / 已中断 / 已分叉 |
| `aborted`（你按的停止） | 已停止（默认不弹，`notifyAborted` 打开） |
| `aborted`（其他原因） | 已中断 |

**你按的停止不弹。** 按停止这个动作本身就说明你正看着屏幕。宿主按
`reason.kind === "aborted"` 且 `reason.reason.kind === "user"` 判，Client 那半看不到
原因，就问宿主（见上一节）；问不到时照弹，所以"多一条通知"是这套设计的失败方向，
而不是"少一条"。

**子会话不弹。** 子 agent、workflow 里的每次 `agent()` 都是独立会话，它们干完活
不算你的对话干完活。两半各判各的：宿主看 `session.header.origin`，
Client 那半没有 `turn/end` 可看，只能看 `useSessionStatus` 的状态翻转——
而那张状态表里**没有** `origin`，子会话混在普通会话里一起发布，所以它另外去查
sessions store 里的 `origin === "subagent"`。查不到的 id 仍然会弹：多弹一条看得见，
少弹一条看不见。

## 开发

```bash
node test/notify.test.mjs
```

64 个用例覆盖通知文案的全部决策面：AppleScript 转义、正文降级链、
触发条件筛选、配置归一化、宿主那半的路由接线，以及 Client 那半的观察者——
用例会把 `lib/client.js` 塞进一个假的 module loader 里真的跑起来，喂进状态翻转、
替它接上宿主的回答，看它弹还是不弹（子会话不弹、手动停止不弹都是在这里守住的）。
其中一条会把生成的 AppleScript 交给 `osacompile` 真正编译一遍（只编译，不执行），
确保引号、反斜杠、换行、emoji 都不会生成非法脚本。

### 改动什么时候生效

| 改什么 | 怎么生效 |
| --- | --- |
| `cordis.patch.yml` 里的 `config:`（含 `enabled`、`delivery`） | **即时**。profile 的 patch 文件被 HMR 监听 |
| 增删那条 insert 行（装/卸插件） | **即时** |
| `lib/*.js`（插件代码本身） | **要重启 dsh Desktop** |
| `lib/client.js`（渲染进程那半） | 重启后**刷新页面**即可（它由 Host 现场组包） |
| `package.json` / `dsh.profile.bundles` | 交给 `plugin_manager`，别手改 |
| 包里的 `locale/*.json`、`icon.svg` | 重启后在设置页生效 |

代码改动要重启，是因为同进程内 Node 按 URL 缓存 ES module：把 insert 行删掉再加回来
也不行，模块缓存不会失效（实测过）。HMR 的 `ignored` 默认含 `**/node_modules`，
而插件是通过 symlink 挂在 profile 的 `node_modules` 下的，所以它的源码不在监听范围内。

排查"改了没反应"时先想这一条——很容易把旧代码的行为当成新代码的 bug。

### 为什么这个包一个依赖都不 import

`lib/index.js` 只 import `node:` 内置模块和同目录文件，**绝不 import
`@deepseek-ai/*` 这类裸包名**。这不是风格洁癖，是可用性要求：

> dsh Desktop（Electron 主进程）不会为 bundle 之外的插件解析裸 `@deepseek-ai/*`
> 说明符。这样写的插件会加载失败，条目停在 `inactive`，而且**不报错、不提示**，
> 只是安静地什么都不做。

对照组实测（同一个 profile、同一次热加载）：

| 插件里的 import | 结果 |
| --- | --- |
| 无 | ✅ 激活 |
| `import z from "@deepseek-ai/schemastery"` | ❌ 加载失败，`fiberPhase: null` |
| `import { readFileSync } from "node:fs"` | ✅ 激活 |
| `import { x } from "./side.js"` | ✅ 激活 |

所以本插件不导出 Cordis 的 `Config` schema，改在 `lib/config.js` 里手工归一化。
详见 `docs/adr/0001`。`test/notify.test.mjs` 里有一条用例守着这个约束，
防止以后有人顺手加回一个裸 import。
