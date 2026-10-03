# dsh-cdp

把 DSH 的 Chrome DevTools MCP 客户端 attach 到你**正在跑的日常 Edge**（不是另开一个浏览器），
这样扩展调试类工具（`list_extensions`、扩展 Service Worker 的 `evaluate_script` 等）能像一行插件一样随开随关。

它是一个**配置型 bundle**：`cordis.patch.yml` 插入一行 `@deepseek-ai/dsh-mcp-client`，
`connect.mjs` 作为包装脚本负责"发现端点 → 校验 → 透明转发"（它做的完整几件事见下一节）。

## 它是什么

`chrome-devtools-mcp`（Google 官方）的**启动适配层**，不是它的重新实现：本仓库不含任何 CDP / DevTools
代码，不自己建连接，也不重写任何一个工具 —— 工具能力全部来自上游那一个进程。

用途很具体：**调试浏览器扩展**。扩展装在日常 Edge 里，所以得 attach 日常 profile；而日常 profile 只剩
`edge://inspect` 这一条路（原因见「前置条件」一节）。

在这个前提下，它只做五件上游不做、或做得不对的事：

- **端点发现** —— 每次启动重读 `DevToolsActivePort`（guid 每次重开开关都会变）、TCP 探活、再定位上游入口：
  `lib/endpoint.mjs`、`lib/mcp-entry.mjs`
- **参数注入** —— 把 `--wsEndpoint` 顶到参数最前，用户/包配置里的参数原样追加：`lib/args.mjs`
- **工具面裁剪** —— 默认只直出 5 个扩展调试工具，其余收进 `cdp_call` 元工具按需取（见「工具面」一节）：
  `lib/tool-surface.mjs`
- **安全拦截** —— 把会把浏览器打崩的 `trigger_extension_action` 从 `tools/list` 里删掉、并硬拦对它的
  `tools/call`（`cdp_call` 也绕不过去）：`lib/filter.mjs`
- **挂起诊断** —— 首笔调用挂起超过 `DSH_CDP_APPROVAL_HINT_MS` 时，提示去看 Edge 的「允许远程调试」弹窗：
  `lib/hang-hint.mjs`

## 怎么开关

- GUI：Settings → Plugins，打开/关闭 `dsh-cdp` 这一行。
- CLI / `plugin_manager`：要按**那个行的地址**来，不是行 id ——
  `action: set_plugin`、`target: include:dsh-cdp`、`enabled: true|false`
  （`target: dsh-cdp` 会回 `unknown-plugin`，那是 patch id，不是可寻址的 entryId）。

实测：`set_plugin` 会把 `- id: dsh-cdp` + `disabled:` 的覆盖行写进 profile 的
`cordis.patch.yml`（DSH 自己的机制，不用手写）。

端点缺席时不会让激活失败（`failOnStartupError: false` + `reconnect`），所以可以先把这一行打开，
之后再去 Edge 里翻开关，它会自己连上。

**怎么确认真的生效**：看 `Tool.listTools` 里有没有 `mcp__chrome-devtools-mcp__*`
（`cordis_inspect_query`：`platform: host`、`provider: Tool`、`method: listTools`）。
GUI 里那一行显示 `fiberPhase: active` **不能**作为依据 —— 端点缺席时它同样是 active，
只是每次调用都会失败。

## 前置条件

在 Edge 打开 `edge://inspect`，勾上 **"Allow remote debugging for this browser instance"**。

这个开关会把端口和 `/devtools/browser/<guid>` 写进
`%LOCALAPPDATA%\Microsoft\Edge\User Data\DevToolsActivePort`。注意：

- **guid 每次重开开关都会变**，所以每次启动都必须重读这个文件（不能缓存）；
- 关掉开关后文件**不会删除**，只是端口不再监听 —— 所以「文件存在」不等于「能连」；
- 用 `--remote-debugging-port=<p>` 启动的 Edge **不写**这个文件。

**为什么不能干脆自己用 `--remote-debugging-port` 启动日常 Edge**：Chromium 136 起，
`--remote-debugging-port` / `--remote-debugging-pipe` 对**默认** user data dir 会被直接忽略
（防的是拿调试端口偷 cookie）。Linux 上还有 `CHROME_CONFIG_HOME` 一类的绕法，Windows 上没有。
所以日常 profile 只剩 `edge://inspect` 这一条路，也就必然要吃 approval 模式的弹窗。

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
| `DSH_CDP_APPROVAL_HINT_MS` | `10000` | 首次工具调用挂起多久后给出「可能正在等允许弹窗」的 stderr 诊断；`0` = 关掉 |
| `DSH_CDP_BLOCKED_TOOLS` | `trigger_extension_action` | 屏蔽的工具名，逗号分隔；空字符串 = 不过滤 |
| `DSH_CDP_TOOLS` | 5 个扩展调试工具 + `cdp_call` | 直出哪些工具：`all` = 不裁剪，`none` = 只留 `cdp_call`，逗号分隔 = 白名单 |

入口文件不写死版本路径：从 `chrome-devtools-mcp` 的 `package.json` 里 `bin['chrome-devtools-mcp']` 推导。

包装脚本**只做 TCP 探活，不自己建 CDP 连接**（原因见下一节），真正那条连接由
`chrome-devtools-mcp` 建立，全程只此一条。

## 工具面：默认只直出常用几个，其余走 `cdp_call`

打开这一行会把 `chrome-devtools-mcp` 的**整个**工具目录带进上下文：实测 `tools/list` 报 34 个工具、
28,286 字节，而真正跟扩展调试相关的只有 5 个（约 1.9 KB）——剩下 93% 是通用浏览器工具（截图、
快照、点击、填表、性能 trace…）。所以默认只直出这几个：

`list_extensions`、`reload_extension`、`list_pages`、`select_page`、`evaluate_script`

其余全部收进一个元工具 `cdp_call`，它的说明里带着上游**全部**工具名，所以模型仍然能发现并使用它们：

```json
{ "name": "cdp_call", "arguments": { "name": "take_screenshot", "arguments": {} } }
{ "name": "cdp_call", "arguments": { "name": "take_screenshot", "schema": true } }
```

`cdp_call` 会把内层调用翻译成正常的 `tools/call` 再转发，响应原样回来；带 `schema: true` 时由包装
脚本**本地**回答（不多跑一趟上游），所以那 28 KB 只在真要调某个工具时才进上下文。实测默认这一份是
**6 个工具 / 4,540 字节**（元工具自己约 1.2 KB），比不裁剪少 **84%**。

| `DSH_CDP_TOOLS` | 效果 |
| --- | --- |
| 不设（默认） | 上面 5 个 + `cdp_call` |
| `list_extensions,list_pages,…` | 只直出这些 + `cdp_call` |
| `none` | 只留 `cdp_call` |
| `all` | 完全不裁剪，等于没有这个功能（34 个 / 28,286 字节） |

**两条规则是分开的，别混**：

- **裁剪只管可见性** —— 被裁掉的工具只是不列出来，**直接调用仍然放行**（会话历史里的工具名不该因为
  改了配置就突然调不动）；
- **`DSH_CDP_BLOCKED_TOOLS` 管安全** —— 那是硬拦（本地回 `-32601`），**`cdp_call` 也绕不过去**。

包装脚本启动时会往 stderr 打一行"工具面：直出 N 个 + cdp_call 兜底；DSH_CDP_TOOLS 里上游没有的：…"，
配错了能立刻看出来。

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
不弹窗；弹窗出现在你第一次真正要用它的那一刻。实测（重新启用 `dsh-cdp` 之后）：

| 事件 | 到 9222 的连接 | 弹窗 |
|---|---|---|
| 插件启用后 2 分钟，未调用任何工具 | 无 | 无 |
| 第 1 次 `mcp__chrome-devtools-mcp__list_extensions` | 建立，`ESTABLISHED` | **弹，点一次「允许」** |
| 第 2 次 `mcp__chrome-devtools-mcp__list_pages` | 复用同一 socket | 无 |

也就是说：**一次点击 = 一条 CDP 连接的生命周期**，弹窗落在这条连接的第一笔请求上，
之后同一条连接上的所有调用都不再问。需要重新点的情况只有：关掉插件再打开（MCP 子进程
重启）、MCP 子进程崩溃后重连、Edge 重启（旧 socket 断，下次调用新建连接）。

**挂住的时候你会拿到一条诊断**。被弹窗挂起的连接既不超时也不报错，看起来和卡死一样；
所以第一笔转发出去的 `tools/call` 超过 `DSH_CDP_APPROVAL_HINT_MS`（默认 10 秒）还没有响应时，
`connect.mjs` 会往 stderr 写一条带工具名的提醒，告诉你去看一眼 Edge 的那个框。它只写
stderr、不改动也不吞掉任何 MCP 帧，而且**不会替你去点** —— 那个框只能人点。

**为什么不必手忙脚乱地点**：DSH 的 MCP 客户端默认每次 `tools/call` 只等 **60 秒**，超过就判定
失败 —— 而 approval 模式下第一笔调用恰恰是在等人点弹窗，60 秒对"去把 Edge 窗口翻出来"太短。
所以本行在 `cordis.patch.yml` 里把 `toolCallTimeoutMs` 放宽到 **5 分钟**（真挂死的调用照样
可以像别的工具调用一样随时取消）。这也意味着：如果你在 Edge 里点了「允许」，而 DSH 这边已经
报超时，那一点是白点的，得重来一次。

所以本插件刻意把连接数压到最低：

- 包装脚本只探端口，不多连一次（纯 TCP 探活不触发弹窗，已实测）；
- 一条连接一直复用到你关掉这一行为止；
- 端点缺席时（开关还没打开）包装脚本在连之前就退出，不会弹窗，靠 `reconnect` 反复重试，
  等你打开开关它才建连接、才需要你点一次。


## 为什么默认屏蔽 `trigger_extension_action`

实测：attach 模式下调用它会把 Edge **整个打崩**。复核记录（Edge `Edg/154.0.4258.48`，
在一个一次性 `--user-data-dir` + `--remote-debugging-port` 的实例上跑，不碰日常浏览器）：

```
Error: Protocol error (Extensions.triggerAction): Target closed
→ 之后 127.0.0.1:<port> 拒绝连接、该实例 0 个进程存活
→ Crashpad\reports\*.dmp = 10,436,899 B (≈10 MB)
```

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

## 升级前预检：`tools/check-upgrade.mjs`

「已知限制」里那条升级风险，现在有脚本兜着：

```powershell
node tools\check-upgrade.mjs                    # 检查当前已装的那份
node tools\check-upgrade.mjs --version 1.11.0   # 检查候选版本
```

它只**读**候选产物：下载到临时目录、解包、读 `EXTENSIONS` 分类有没有 `conflicts`、产物里有没有
`CONFLICTING_ARGS` 互斥表，然后删掉临时目录。**候选产物绝不执行**。

| 退出码 | 结论 | 含义 |
|---|---|---|
| 0 | 安全 | 分类没有互斥表，也没有别的互斥机制 |
| 1 | 不安全 | `--wsEndpoint`（或 `--browserUrl`）已被写进互斥表，升上去这一行会启动即失败 |
| 2 | 无法判定 | 产物结构变了，或存在这个脚本看不透的互斥机制 —— 人看一眼再决定 |
| 3 | 用法 / 运行错误 | 参数错、版本不存在、下载或解包失败 |

**预检通过不等于万事大吉**：它读的是"分类互斥表"，不是完整的行为等价性。升级后仍建议随手
调用一次 `list_extensions`，确认扩展工具真的在。

## 已知限制

- `list_pages` 里的 `sw-N` 是**会话内句柄**：每次 MCP 启动都会重新编号，不要把 `sw-2` 记到下一轮。
- MV3 的 Service Worker 睡着时**不在 `list_pages` 里**，要先用页面里的操作把它唤醒。
- 那条「等允许弹窗」的诊断走 stderr：DSH 的 MCP 客户端把子进程 stderr 设为 `inherit`
  （未在 GUI 里逐字核实是否显示），所以它更可能出现在日志／控制台里，而不是聊天窗口里。
- 只有 Edge 里勾上那个开关时可用；关掉开关后 `connect.mjs` 会以 exit 1 报「DevToolsActivePort 是旧的」。
- **不要给 `chrome-devtools-mcp` 加 `--slim`**：它会把扩展类工具整个砍掉，这一行就没意义了。
- 上下文成本：默认直出 5 个扩展调试工具 + `cdp_call` 元工具，`tools/list` 实测 **6 个 / 4,540 字节**；
  `DSH_CDP_TOOLS=all` 回到上游全量（**34 个 / 28,286 字节**，`chrome-devtools-mcp` 1.10.1 实测）。
  也就是说默认配置已经把那 84% 的常驻 schema 收进了按需加载的元工具（详见上一节）。
- **升级 `chrome-devtools-mcp` 前先看这条**：`--categoryExtensions` + `--wsEndpoint`（本行的核心组合）在
  **1.10.1 上是合法的**（发布包构建产物里根本没有 `CONFLICTING_ARGS`；实测 `--categoryExtensions
  --wsEndpoint` 能正常启动，扩展工具 `list_extensions` / `reload_extension` 与 SW 求值均可用）。但上游
  **main 分支已加入** `['categoryExtensions','browserUrl','wsEndpoint']` 这条互斥检查（对照：`PWA` 分类在
  1.10.1 就带 `conflicts`，实测 `--categoryPwa --wsEndpoint` 直接 exit 1）。也就是说**下一个把该检查发出来的
  版本会让这一行启动即失败**。升级后若本行起不来，先查 `chrome-devtools-mcp` 的 `CONFLICTING_ARGS` / 该分类
  是否带 `conflicts`，再决定锁旧版还是改路线。升级前先跑一次
  `node tools\check-upgrade.mjs --version <候选版本>`（见上一节）。详见调研文档
  [docs/research-cdp-extension-mcp.md](docs/research-cdp-extension-mcp.md) 末节「实地复核」。

## 测试

```
node --test "test/*.test.mjs"
```

测试不联网、不启动浏览器、不碰真实 profile（`checkTcp` 只连本地临时 `net.createServer`，
入口查找用 `os.tmpdir()` 下的临时目录）。
