# dsh-cdp

把 DSH 的 Chrome DevTools MCP 客户端 attach 到你**正在跑的日常 Edge**（不是另开一个浏览器），
这样扩展调试类工具（`list_extensions`、扩展 Service Worker 的 `evaluate_script` 等）能像一行插件一样随开随关。

它是一个**配置型 bundle**：`cordis.patch.yml` 插入一行 `@deepseek-ai/dsh-mcp-client`，
`connect.mjs` 作为包装脚本负责"发现端点 → 校验 → 透明转发"。

## 怎么开关

- GUI：Settings → Plugins，打开/关闭 `dsh-cdp` 这一行。
- CLI：`plugin_manager set_plugin dsh-cdp --enabled true|false`（具体参数以你手里的 plugin_manager 为准）。

端点缺席时不会让激活失败（`failOnStartupError: false` + `reconnect`），所以可以先把这一行打开，
之后再去 Edge 里翻开关，它会自己连上。

## 前置条件

在 Edge 打开 `edge://inspect`，勾上 **"Allow remote debugging for this browser instance"**。

这个开关会把端口和 `/devtools/browser/<guid>` 写进
`%LOCALAPPDATA%\Microsoft\Edge\User Data\DevToolsActivePort`。注意：

- **guid 每次重开开关都会变**，所以每次启动都必须重读这个文件（不能缓存）；
- 关掉开关后文件**不会删除**，只是端口不再监听 —— 所以「文件存在」不等于「能连」；
- 用 `--remote-debugging-port=<p>` 启动的 Edge **不写**这个文件。

## `connect.mjs` 环境变量

全部可选，都有默认值：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_CDP_USER_DATA_DIR` | `%LOCALAPPDATA%\Microsoft\Edge\User Data` | Edge user data 目录 |
| `DSH_CDP_PORT_FILE` | `<user data dir>\DevToolsActivePort` | 端口文件路径 |
| `DSH_CDP_HOST` | `127.0.0.1` | DevTools 主机 |
| `DSH_CDP_MCP_ENTRY` | 自动查找 | 直接指定 chrome-devtools-mcp 入口文件 |
| `DSH_CDP_MCP_SEARCH_DIRS` | 空 | 额外搜索目录，用 `path.delimiter`（Windows 下 `;`）分隔 |
| `DSH_CDP_PROBE_TIMEOUT_MS` | `5000` | TCP 探活超时 |
| `DSH_CDP_BLOCKED_TOOLS` | `trigger_extension_action` | 屏蔽的工具名，逗号分隔；空字符串 = 不过滤 |

入口文件不写死版本路径：从 `chrome-devtools-mcp` 的 `package.json` 里 `bin['chrome-devtools-mcp']` 推导。

包装脚本**只做 TCP 探活，不自己建 CDP 连接**（原因见下一节），真正那条连接由
`chrome-devtools-mcp` 建立，全程只此一条。

## 每次打开插件都要点一次「允许」是正常的

日常 profile 走的是 Chromium 的 approval 模式
（`RemoteDebuggingServerMode::kWithApprovalOnly`，见
`chrome/browser/devtools/remote_debugging_server.cc`）：只要 `edge://inspect` 的开关是开的，
服务器就起在 9222 并写 `DevToolsActivePort`，但**每一条新的 WebSocket 连接都会弹一次
「是否允许远程调试？」的模态框**，用户手点「允许」之后这条连接才握手成功。Chromium 没有
「记住」选项（社区 issue 一直在挂），也没有配置项可以跳过。

所以本插件刻意把连接数压到最低：

- 包装脚本只探端口，不多连一次；
- 一次激活只产生一条连接，这条连接一直用到你关掉这一行为止；
- 端点缺席时（开关还没打开）包装脚本在连之前就退出，不会弹窗，靠 `reconnect` 反复重试，
  等你打开开关它才建连接、才需要你点一次。

也就是说：**每次在 DSH 里打开 `dsh-cdp` → 点一次「允许」；关掉再打开 → 再点一次；
Edge 重启后 → 再点一次。** 其余时间不会再弹。


## 为什么默认屏蔽 `trigger_extension_action`

实测：attach 模式下调用它会把 Edge **整个打崩**（`Target closed` + Crashpad dmp）。
所以默认在 `tools/list` 里把它删掉，并拦截对它的 `tools/call`（本地回 `-32601`），
避免模型顺手一调用就把你的浏览器弄没。需要时把 `DSH_CDP_BLOCKED_TOOLS` 设成空串即可恢复。

## 现场核对：`tools/mcp-probe.mjs`

装 bundle 之前先手工验一遍（`--` 之前是 MCP server 命令，之后是要发的 `tools/call` JSON）：

```powershell
node tools\mcp-probe.mjs node D:\DSH\dsh-cdp\connect.mjs --no-usage-statistics --categoryExtensions -- `
  '{\"name\":\"list_extensions\",\"arguments\":{}}' `
  '{\"name\":\"list_pages\",\"arguments\":{}}'
```

它会 `initialize`、打印工具总数与扩展相关工具名，然后逐个调用并打印结果。
想先看某个工具的入参 schema，把调用换成 `'{\"$schema\":\"evaluate_script\"}'`。

## 已知限制

- `list_pages` 里的 `sw-N` 是**会话内句柄**：每次 MCP 启动都会重新编号，不要把 `sw-2` 记到下一轮。
- MV3 的 Service Worker 睡着时**不在 `list_pages` 里**，要先用页面里的操作把它唤醒。
- 只有 Edge 里勾上那个开关时可用；关掉开关后 `connect.mjs` 会以 exit 1 报「DevToolsActivePort 是旧的」。

## 测试

```
node --test "test/*.test.mjs"
```

测试不联网、不启动浏览器、不碰真实 profile（`checkTcp` 只连本地临时 `net.createServer`，
入口查找用 `os.tmpdir()` 下的临时目录）。
