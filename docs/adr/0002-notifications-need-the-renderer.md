# ADR-0002：通知只能在渲染进程里弹，宿主做不到

## 状态

已采纳（2026-10-04）

## 背景

用户要求通知做到两件事：**点击跳到对应 Session**，以及**用 dsh 自己的图标**而不是
Script Editor 的图标。第一版实现两条都做不到——截图里通知的图标是 Script Editor，
点击毫无反应。

原因是投递走了 `osascript -e 'display notification ...'` 这条回退路径。
`display notification` 既没有点击回调，也不能指定图标，所以这两个需求在
`osascript` 上**根本无法实现**。能做到的只有 Electron 的 `Notification` 类
（有 `click` 事件，通知归属为应用本身）。

第一版代码里有一条 `electron` 投递路径，本意就是走 Electron。它从来没成功过，
每次都在 `auto` 里静默退到 `osascript`。这一轮把它为什么失败查清楚了。

## 调查

宿主进程（跑 profile 的那个）确实是 Electron 二进制，但**不是浏览器进程**：

```
PID 22136  DeepSeek Harness                          ← Electron 浏览器进程（GUI 窗口在这里）
PID 22574    └─ DeepSeek Harness --expose-internals
                .../dsh-desktop-host/lib/index.js ... ← 宿主：profile 插件跑在这里
```

在宿主进程里 dump `import("electron")` 的实际结果：

```json
{
  "versions": { "electron": "44.0.0", "node": "24.18.1" },
  "type": null,                     ← 不是 "browser"
  "namespaceKeys": ["default", "module.exports"],
  "defaultKeys": [],                ← 空对象
  "NotificationType": "undefined"
}
```

`process.type: null` 说明 Electron 是以 **Node 模式**（`ELECTRON_RUN_AS_NODE`）
启动这个子进程的：二进制是 Electron，但整个浏览器 API 面是空的。
`import("electron")` 能解析（所以 `probe-t1` 通过），但拿到的是个空壳
（`probe-t2` 起全部失败）。

再去查浏览器进程和宿主之间的 IPC，看有没有现成的口子。协议是固定枚举的：

```
宿主 → 浏览器： ready | platform-session | shutdown-complete | fatal | { requestId, ... }
浏览器 → 宿主： { type: "shutdown" } | 控制请求
```

`isDesktopHostEvent` 只认这几种，**没有任何「弹通知」或「执行命令」的通用消息类型**，
宿主也没有 `BrowserWindow` 可以抓。此路不通。

## 决定

**宿主侧不再假装能弹 Electron 通知。** `delivery` 的默认值改为 `osascript`，
`electron` / `auto` 保留但注明它们只在「宿主真的跑在 Electron 浏览器进程里」时才有意义。

顺带修正了两处文案：默认标题改成 `会话轮次结束`，并且**只在回合不是正常完成时**
才显示状态行（`出错了 · …`）——正常完成时用户已经知道这三个字是什么意思，
第三行只会重复。

**点击跳转和自定义图标这两个需求，必须在渲染进程（Client 半）里做**，
用 Web Notifications API：它有 `onclick`，通知归属是应用本身（带应用图标），
而且渲染进程里能直接调 `ctx.uiWorkspace.openSession(sessionId)` 完成跳转。
这是后续工作的方向，见下。

## 后果

**好处**

- 投递行为终于和文档一致了，不再有一条永远失败的路径假装存在。
- 记下了 `process.type: null` 这个判据：以后想知道「宿主能不能用 Electron API」，
  看这一个字段就够，不用再试。

**代价 / 遗留**

- 当前的 `osascript` 通知**永远**是 Script Editor 的图标，且**永远**点不动。
  需求 1 和 2 在宿主侧无解。
- 要满足它们就得加一个 Client 半插件，**已经加上了**（`lib/client.js`）。
落地的过程中有四处是踩过坑才定下来的，都写在这里免得以后改回去：

**观察点必须在 `shell.overlay`，不能在 Session 行里。**
`sidebar.session.row.leading` 看着最合适——它还直接给 `sessionId`——但它明确
「只在行的主状态是 idle 时挂载」。也就是说某个 Session 一开跑，它的占位就被卸载，
**恰好在唯一有东西可看的时候消失**；侧栏里若没有别的 idle 会话，就完全没有观察者。
`shell.overlay` 是常驻的 frame-wide 层，而且 `standardProps` 里同样有
`useSessionStatus` —— 一个占位就能看住所有会话。

**「谁负责弹」的判断要反过来。**
最初的写法是「配置说 client 才出声」。问题是配置靠宿主注入到页面
（`window.__DSH_NOTIFY_ME__`），一旦注入没生效，客户端就永久沉默——
而「注入失败」和「插件正常但没话说」表现完全一样，无法区分。
现在改成**除非配置明确说 `osascript`，否则出声**，把失败模式从"静默"挪到了"重复"，
后者一眼能看见。

**失败必须可见。** 渲染进程的 console 不总是够得着，所以权限不足、
没有 Notification API 这两条静默退出会把原因渲染成左下角一个小条
（只用 `--dsw-alias-*` token 着色）。只有出问题才出现。

**子会话要自己再筛一遍。** 宿主那半是在 `turn/end` 上判 `header.origin` 的，
Client 半根本看不见 `turn/end`，它只有状态翻转；而 `useSessionStatus` 那张表
**只装 `running` / `pendingInteraction`，不装 `origin`**，子会话和普通会话
一起发布（`dsh-client-ui-session` 的 `publishStatus` 把 sessions store 的
`byId` 全量并进去）。所以子会话干完在状态表里和一次普通收工长得一模一样，
不额外查 sessions store 的 `origin`，子 agent 每收一次工就弹一条。
`parentId` 不能当判据——fork 出来的会话也带 `parentId`，而那是用户自己的对话。

## 相关

- `lib/index.js` 的 `loadElectron` / `electronBanner`
- `lib/config.js` 的 `delivery` 默认值与注释
- ADR-0001（bundle 之外的插件不 import 裸包名）
