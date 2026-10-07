# 会话结束通知（session-end notification）

`dsh-notify-me` 这个 DSH 插件的领域词汇表。

本词汇表固定**中文措辞与代码标识符之间的对应关系**。散文用中文写、代码用英文写，
中间没有映射表，"结束"到底指 `turn/end` 还是 `session/disposed` 这种漂移迟早会发生。

## 领域

### 回合（turn）

用户提交一次输入，到 agent 把控制权交回来为止。一轮里模型可能请求多次工具、
来回好几个 step，但对用户来说就是"我问了一句，它答完了"。

**这个插件通知的单位就是回合。** 用户说的"session 结束"，在 DSH 里落到的是
`turn/end`，不是会话被销毁。

_避免_: 会话、对话、任务、请求

### 回合结束事件（`turn/end`）

会话日志里**已提交**的一条事件，带 `turn` 编号和 `reason`。

选它而不是 `agent/status → idle`：状态翻转在会话加载、每次被唤醒投递时也会发生，
而 `turn/end` 一轮只提交一次，且自带结束原因。

_避免_: 完成信号、idle 事件、结束标志

### 结束原因（turn-end reason）

`turn/end` 自带的 `reason.kind`：`completed`、`error`、`max-tokens`、`blocked`、
`interrupted`、`forked`、`aborted`。本插件把它映射成通知的**状态行**。

`aborted` 还带一层 `reason.reason.kind`；为 `user` 时表示用户自己按了停止。

_避免_: 状态、结果、结局

### 手动停止（user stop）

`aborted` 且原因是 `user` 的那个回合。默认**不通知**——按停止这个动作本身
就说明用户正看着屏幕。由 `notifyAborted` 打开。

判定权在宿主：只有它看得见 `turn/end` 的 `reason`。Client 半看不出，于是每轮结束
问一次宿主（见「回合结束问答」）。

_避免_: 取消、中断、打断

### 回合结束问答（turn-end query）

Client 半每看到一次"某个会话不跑了"，就回头问宿主一句：
`GET /api/notify-me.turn-end?session=<id>` → `{"announce": true|false}`。

问的不是"发生了什么"，而是**宿主自己那条 `shouldNotify` 的结论**——子会话、手动停止、
`enabled`、`notifyAborted` 都在里面。这样策略只有一份，加规则时不会只落到能看见
`turn/end` 的那半边。路由挂在 Connection 的 Fetch 注册表上，复用页面本来就有的
Host/Origin 围栏与浏览器会话 cookie。

**问不到就照弹。** 路由缺失、超时、答非所问，一律当作"该弹"：宿主不吭声不等于
什么都没发生，多一条通知看得见，少一条看不见。

_避免_: 回调、RPC、握手

### 子会话（subagent session）

`header.origin === "subagent"` 的会话：子 agent、workflow 里每次 `agent()` 调用
各自开的会话。**一律不通知**——被派出去的子任务干完，不等于你的对话干完。

两半各自判定，因为两半手上的事实不同：宿主读会话自己的 `header.origin`；
Client 半只有 `useSessionStatus` 的状态翻转，而**状态表里没有 `origin`**
（子会话和普通会话混在同一张表里发布），所以它改读 sessions store 里的
`byId[id].origin`。两者都取不到时照常通知：多一条看得见，少一条看不见。

_避免_: 子任务、派生会话、子进程

### 横幅（banner）

macOS 通知中心里那一条。三行：**标题**（`config.title`）、**状态**（由结束原因
映射）、**正文**（由 `config.body` 决定取会话标题、回复摘要，还是留空）。

_避免_: 通知、提示、弹窗、toast

### 正文（body）

横幅第三行的内容。`config.body` 三选一：`session-title`（默认）、`reply`、`none`。

正文有一条**降级链**：回复摘要 → 会话标题 → 工作区目录名 → 会话 id。
任何一级取不到就退到下一级；标题栏空着的横幅，不如一条标题能看的横幅。

_避免_: 内容、描述、副标题

### 投递（delivery）

把横幅交给系统的路径，由 `config.delivery` 选择：

- **`electron`**：Electron 主进程的 `Notification` API。通知归属显示为
  **DeepSeek Harness**，点击能把窗口拉到前台。
- **`osascript`**：`osascript -e 'display notification ...'`。通知归属显示为
  **Script Editor**，点不了。但一定弹得出来。
- **`auto`**（默认）：先 `electron`，拿不到再用 `osascript`。

`auto` 有一个已知盲区：macOS 在应用没通知权限时**静默丢弃**，Electron 不报错，
于是无从回退。所以 `delivery` 是显式可配的——它是排查"没弹出来"的第一手段。

_避免_: 发送、推送、通道、渠道

### 单行化（single line）

把任意文本压成一行：所有空白串替换成一个空格。macOS 通知是单行界面，而
AppleScript 字符串字面量**根本不能跨行**。`appleScriptProgram` 对每个字段
都先做这一步，所以它产出的脚本永远能被 `osacompile` 接受。

_避免_: 清洗、转义、格式化

### 观察位（watcher seat）

Client 半挂载自己那个零像素组件的地方。必须是**常驻**的 slot —— 目前的取值是
`shell.overlay`。

**不能**用 `sidebar.session.row.leading` 这类"按行状态条件挂载"的座位：那种座位在行
转入 running 时会卸载占位，于是观察者恰好在唯一有东西可看的时候消失。

_避免_: 挂载点、注入位置、宿主 slot

### 出声闸门（delivery gate）

Client 半判断"这条通知该不该由我来弹"的规则。当前语义是
**除非宿主明确声明 `delivery: osascript`，否则由 Client 弹**。

方向是刻意选的：反过来的话，一旦宿主把配置注入页面失败，Client 就永久沉默，
而"注入失败"和"插件正常但没话说"无法区分。现在失败模式是"可能弹两条"，
一眼可见，而不是"一条都没有"。

闸门只管**谁出声**，所以注入里也只放这一个字段：页面活得比配置久，
放进页面的开关会在配置改了之后替你做主。**该不该出声**由「回合结束问答」
逐轮回答。

_避免_: 开关、权限判断、启用条件

### 配置归一化（config normalization）

不导出 Cordis `Config` schema 的情况下，手工把 profile 里写的 `config:` 收敛成
一份每个字段都有值、类型都对的配置。类型或枚举取值不对就退回默认值并 `warn`。

存在的原因是 bundle 之外的插件不能 import 裸包名，见 ADR-0001。

_避免_: 校验、解析、默认值填充
