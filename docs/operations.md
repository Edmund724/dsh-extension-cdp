# 运维：环境变量、现场核对、升级预检、已知限制

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

包装脚本**只做 TCP 探活，不自己建 CDP 连接**（原因见 [approval 模式](approval-mode.md)），真正那条连接由
`chrome-devtools-mcp` 建立，全程只此一条。

## 现场核对：`tools/mcp-probe.mjs`

装 bundle 之前先手工验一遍（**在仓库根目录下跑**；`--` 之前是 MCP server 命令，之后是要发的 `tools/call` JSON）：

```powershell
node tools\mcp-probe.mjs --% node connect.mjs --no-usage-statistics --categoryExtensions -- {"name":"list_extensions","arguments":{}} {"name":"list_pages","arguments":{}}
```

`--%` 是 PowerShell 的「停止解析」标记，它之后的内容原样交给 node —— 不加它，JSON 里的引号会被 PowerShell
吃掉，探针在解析参数时就报 `JSON.parse` 错。PowerShell 7 上也可以不用 `--%`，改用单引号把每段 JSON 分别包起来。

它会 `initialize`、打印工具总数与扩展相关工具名，然后逐个调用并打印结果。
想先看某个工具的入参 schema，把调用换成 `{"$schema":"evaluate_script"}`（这种调用由探针本地回答，不连浏览器）。

⚠️ **探针每笔请求的硬编码超时是 60 秒**，而一条新 CDP 连接要先在 Edge 点掉「允许远程调试？」弹窗（机制见
[approval 模式](approval-mode.md)）。所以拿它做首笔**需要浏览器**的调用时，跑起来之后马上把 Edge 窗口翻出来点
「允许」；点慢了这次调用会以 `timeout: tools/call` 结束，重跑一次即可。
不需要连浏览器的调用（工具清单、`$schema`）不受这条影响。

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
- MV3 的 Service Worker 睡着时**不在 `list_pages` 里**。用页面里的操作、或者对它 `reload_extension`，都能把它拉起来（实测后者：重载之后它的 SW 才出现在列表里）。
- 扩展工具只覆盖 **unpacked** 扩展：`list_extensions` 列出的就是这些（实测：浏览器里 4 个扩展 SW 活着，它只报了 1 个），`reload_extension` 内部是拿扩展目录路径重新 `loadUnpacked`，所以商店安装的扩展既不在列表里，也不能重载。
- 那条「等允许弹窗」的诊断走 stderr：DSH 的 MCP 客户端把子进程 stderr 设为 `inherit`
  （未在 GUI 里逐字核实是否显示），所以它更可能出现在日志／控制台里，而不是聊天窗口里。
- 只有 Edge 里勾上那个开关时可用；关掉开关后 `connect.mjs` 会以 exit 1 报「DevToolsActivePort 是旧的」。
- **不要给 `chrome-devtools-mcp` 加 `--slim`**：它会把扩展类工具整个砍掉，这一行就没意义了。
- 上下文成本：默认直出 5 个扩展调试工具 + `cdp_call` 元工具，`tools/list` 实测 **6 个 / 4,540 字节**；
  `DSH_CDP_TOOLS=all` 回到上游全量（**34 个 / 28,286 字节**，`chrome-devtools-mcp` 1.10.1 实测）。
  也就是说默认配置已经把那 84% 的常驻 schema 收进了按需加载的元工具（详见[工具面](tool-surface.md)）。
- **升级 `chrome-devtools-mcp` 前先看这条**：`--categoryExtensions` + `--wsEndpoint`（本行的核心组合）在
  **1.10.1 上是合法的**（发布包构建产物里根本没有 `CONFLICTING_ARGS`；实测 `--categoryExtensions
  --wsEndpoint` 能正常启动，扩展工具 `list_extensions` / `reload_extension` 与 SW 求值均可用）。但上游
  **main 分支已加入** `['categoryExtensions','browserUrl','wsEndpoint']` 这条互斥检查（对照：`PWA` 分类在
  1.10.1 就带 `conflicts`，实测 `--categoryPwa --wsEndpoint` 直接 exit 1）。也就是说**下一个把该检查发出来的
  版本会让这一行启动即失败**。升级后若本行起不来，先查 `chrome-devtools-mcp` 的 `CONFLICTING_ARGS` / 该分类
  是否带 `conflicts`，再决定锁旧版还是改路线。升级前先跑一次
  `node tools\check-upgrade.mjs --version <候选版本>`（见上一节）。详见调研文档
  [docs/research-cdp-extension-mcp.md](research-cdp-extension-mcp.md) 末节「实地复核」。

## 测试

```
node --test "test/*.test.mjs"
```

测试不联网、不启动浏览器、不碰真实 profile（`checkTcp` 只连本地临时 `net.createServer`，
入口查找用 `os.tmpdir()` 下的临时目录）。
