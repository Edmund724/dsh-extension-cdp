# 前置条件、审批弹窗与授权寿命

## 前置条件：inspect 页那一个勾

在 Edge 打开 `edge://inspect`，勾上 **"Allow remote debugging for this browser instance"**。

这个开关会把端口和 `/devtools/browser/<guid>` 写进
`%LOCALAPPDATA%\Microsoft\Edge\User Data\DevToolsActivePort`。注意：

- **guid 每次重开开关都会变**，所以每次启动都必须重读这个文件（不能缓存）；
- 开关状态存在 Edge 的 Local State 里（`devtools.remote_debugging.user-enabled`，本机实测为 `true`），
  所以 **Edge 重启后不用重新勾选** —— 服务器会自己再起来并重写这个文件（guid 会变，这正是包装脚本
  每次 spawn 都要重读它的原因）；但每条**新的** CDP 连接仍要重新点一次「允许」（机制见下文）；
- 关掉开关后文件**不会删除**，只是端口不再监听 —— 所以「文件存在」不等于「能连」；
- 用 `--remote-debugging-port=<p>` 启动的 Edge **不写**这个文件。

**为什么不能干脆自己用 `--remote-debugging-port` 启动日常 Edge**：这个开关只在浏览器启动那一刻生效，
而日常 profile 正被你手上那个实例占着（Chromium 的 Singleton 锁），要生效得先把它关掉；换一个非默认
`--user-data-dir` 就等于把登录态和扩展一起丢掉。

另外 Chromium 136 起，`--remote-debugging-port` / `--remote-debugging-pipe` 对**默认** user data dir
会被忽略（防的是拿调试端口偷 cookie）——但这条检查只在 Google Chrome 品牌的构建里编译进去
（`#if BUILDFLAG(GOOGLE_CHROME_BRANDING)`），Edge 不受它约束（见调研文档「实地复核 E」）。
即便如此，「开关只在启动时生效」对谁都一样，所以 attach 一个**正在运行**的日常 profile，
只剩 inspect 页这条审批路。

## 「允许」对话框挂在 CDP 连接上，不在插件开关上

日常 profile 走的是 Chromium 的 approval 模式
（`RemoteDebuggingServerMode::kWithApprovalOnly`，见
`chrome/browser/devtools/remote_debugging_server.cc`）：只要 `edge://inspect` 的开关是开的，
服务器就起在 9222 并写 `DevToolsActivePort`，但**每一条新的 WebSocket 连接都会弹一次
「是否允许远程调试？」的模态框**，用户手点「允许」之后这条连接才握手成功。Chromium 没有
「记住」选项（社区 issue 一直在挂），也没有配置项可以跳过。

这个弹窗的表现形式很容易误判：被它挂起期间，**裸的 WebSocket 升级握手会返回零字节且不报错**
——不是 403、不是超时、也不是协议不匹配，看起来就像端口是死的。多带一个 `Origin:` 头才会拿到
`403`。两种情况都只是请求卡在等你点「允许」。所以包装脚本把试探止步于 TCP：连接 + 立刻关闭
不触发弹窗，发 HTTP 升级请求才会（均已实测）。

但 `chrome-devtools-mcp` 是**惰性连接**的：浏览器上下文以 thunk 传给工具处理器
（`new ToolHandler(tool, args, () => this.#getContext(), mutex)`，见 `index.js`），
`puppeteer.connect()` 只在**第一笔 `tools/call`** 时才执行。所以打开插件本身不建连接、
不弹窗；弹窗出现在你第一次真正要用它的那一刻。实测（重新启用 `dsh-extension-cdp` 之后）：

| 事件 | 到 9222 的连接 | 弹窗 |
|---|---|---|
| 插件启用后 2 分钟，未调用任何工具 | 无 | 无 |
| 第 1 次 `mcp__chrome-devtools-mcp__list_extensions` | 建立，`ESTABLISHED` | **弹，点一次「允许」** |
| 第 2 次 `mcp__chrome-devtools-mcp__list_pages` | 复用同一 socket | 无 |

也就是说：**一次点击 = 一条 CDP 连接的生命周期**，弹窗落在这条连接的第一笔请求上，
之后同一条连接上的所有调用都不再问。需要重新点的情况只有：关掉插件再打开（MCP 子进程
重启）、MCP 子进程崩溃后重连、DSH 重启、Edge 重启（旧 socket 断，下次调用新建连接）、
以及你在 `edge://inspect` 里把开关关掉再打开。

**这条授权没有时间上限。** Chromium 侧它就是「这条连接放行」的一次性回调：用户点「允许」后
握手被接受、连接登记进表，此后不再做任何检查，对话框源码里既没有计时器也没有「记住」状态
（见调研文档的源码引用）。所以它不会过几小时自己失效 —— 会断的只可能是连接本身，也就是上面那几种情况。
反过来，**关掉对话框等于拒绝**：Cancel、窗口关闭、「Turn off in settings」三个出口都回 `kDeny`，
这次握手拿到 `403 Connection rejected`，DSH 那边表现为一次失败的工具调用，重试就会重新弹窗。

## 挂住的时候有一条诊断

被弹窗挂起的连接既不超时也不报错，看起来和卡死一样；
所以第一笔转发出去的 `tools/call` 超过 `DSH_CDP_APPROVAL_HINT_MS`（默认 10 秒）还没有响应时，
`connect.mjs` 会往 stderr 写一条带工具名的提醒，告诉你去看一眼 Edge 的那个框。它只写
stderr、不改动也不吞掉任何 MCP 帧，而且**不会替你去点** —— 那个框只能人点。

**为什么不必手忙脚乱地点**：DSH 的 MCP 客户端默认每次 `tools/call` 只等 **60 秒**，超过就判定
失败 —— 而 approval 模式下第一笔调用恰恰是在等人点弹窗，60 秒对"去把 Edge 窗口翻出来"太短。
所以本行在 `cordis.patch.yml` 里把 `toolCallTimeoutMs` 放宽到 **5 分钟**（真挂死的调用照样
可以像别的工具调用一样随时取消）。这也意味着：如果你在 Edge 里点了「允许」，而 DSH 这边已经
报超时，那一点是白点的，得重来一次。

## 链接数压到最低

本插件刻意把连接数压到最低，每一次连接都要你点一次：

- 包装脚本只探端口，不多连一次（纯 TCP 探活不触发弹窗，已实测）；
- 一条连接一直复用到你关掉这一行为止；
- 端点缺席时（开关还没打开）包装脚本在连之前就退出，不会弹窗，靠 `reconnect` 反复重试，
  等你打开开关它才建连接、才需要你点一次。
