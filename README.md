# dsh-extension-cdp

把 DSH 的 Chrome DevTools MCP 客户端 attach 到你**正在跑的日常浏览器**（不是另开一个），
这样扩展调试类工具（`list_extensions`、扩展 Service Worker 的 `evaluate_script` 等）能像一行插件一样随开随关。

默认目标是 Edge。机制上不依赖 Edge —— Chrome 144+ 以及跟随上游的 Chromium 分支是同一套做法，
细节见[兼容性](docs/compatibility.md)。

它是一个**配置型 bundle**：`cordis.patch.yml` 插入一行 `@deepseek-ai/dsh-mcp-client`，
`connect.mjs` 作为包装脚本负责「发现端点 → 校验 → 透明转发」。CDP 与工具全部来自上游
`chrome-devtools-mcp`（Google 官方），本仓库不含任何 CDP / DevTools 代码。

重心是 Chromium 系浏览器的**扩展开发**，所以默认直出的就是那几个扩展调试工具。这只是默认值，不是能力边界
—— CDP 能做的事这里都能做（唯一例外是默认屏蔽的 `trigger_extension_action`，理由见[工具面](docs/tool-surface.md)）。

在上游之上，它做五件事：端点发现（`lib/endpoint.mjs`、`lib/mcp-entry.mjs`）、参数注入（`lib/args.mjs`）、
工具面裁剪（`lib/tool-surface.mjs`）、安全拦截（`lib/filter.mjs`）、挂起诊断（`lib/hang-hint.mjs`）。

## 前置条件

1. `chrome-devtools-mcp` 已装进 DSH 的 profile（入口从它 `package.json` 的 `bin` 推导，不写死版本路径）。
2. 浏览器里勾上允许远程调试：Edge 是 `edge://inspect`，Chrome 是 `chrome://inspect#remote-debugging`，
   勾 **"Allow remote debugging for this browser instance"**。

勾选状态跨浏览器重启保留，但**每一条新的 CDP 连接都要你手动点一次「允许」，Chromium 没有「记住」选项**。
机制、授权寿命、卡住时的表现见 [approval 模式](docs/approval-mode.md)。

## 开关与验证

- GUI：Settings → Plugins，打开/关闭 `dsh-extension-cdp` 这一行。
- CLI / `plugin_manager`：要按**那个行的地址**来，不是行 id —— `action: set_plugin`、
  `target: include:dsh-extension-cdp`、`enabled: true|false`（`target: dsh-extension-cdp` 会回
  `unknown-plugin`，那是 patch id，不是可寻址的 entryId）。
- **判据**：`Tool.listTools` 里有 `mcp__chrome-devtools-mcp__*`（`cordis_inspect_query`：
  `platform: host`、`provider: Tool`、`method: listTools`）。GUI 那行显示 `fiberPhase: active`
  **不算** —— 端点缺席时它同样是 active，只是每次调用都会失败。

端点缺席不会让激活失败（`failOnStartupError: false` + `reconnect`），所以可以先开这一行，
之后再去浏览器里翻开关，它会自己连上。

## 默认工具面

直出 5 个（`list_extensions`、`reload_extension`、`list_pages`、`select_page`、`evaluate_script`），
其余 29 个收进 `cdp_call` 元工具按需取。实测 `tools/list` 是 6 个工具 / 4,540 字节，比不裁剪
（34 个 / 28,286 字节）少 84%。配置项、`cdp_call` 用法、屏蔽清单见[工具面](docs/tool-surface.md)。

## 真正稀缺的是 `reload_extension`

它从浏览器外部把你正在开发的 unpacked 扩展重新加载一遍，改完代码不用回 `edge://extensions` 点刷新。
实测：4 个扩展 SW 同时活着时，重载之后自己那个的 SW 才出现在 `list_pages` 里，且打的确实是本机那个构建目录。

桥接类路线做不到这件事：加载 / 重载扩展要用浏览器级的 `Extensions` CDP 域，而桥接扩展受 `chrome.*`
权限约束，只能操作自己够得着的标签页。逐项对照见[调研文档](docs/research-cdp-extension-mcp.md)的
「同类 DSH 插件对比」。

两个限定：**只对 unpacked 扩展有效**（商店安装的扩展不在 `list_extensions` 里，也不能重载）；
**「做不到」只指点名的那几个工具**，不是说没有别的工具能做到 —— 本插件的差异在于把它接在
**你日常那个浏览器**上。

## 三条容易踩的

- 需要重新授权的时机：MCP 子进程重启、DSH 重启、浏览器重启、开关关掉再打开。
- 升级 `chrome-devtools-mcp` 前先跑一次 `node tools\check-upgrade.mjs --version <候选版本>`：
  上游 main 已加入 `--categoryExtensions` + `--wsEndpoint` 的互斥检查，下一版可能让这一行启动即失败。
- **不要给 `chrome-devtools-mcp` 加 `--slim`**：它会把扩展类工具整个砍掉。

完整清单（`sw-N` 句柄、MV3 SW 睡眠、上下文成本等）见[已知限制](docs/operations.md#已知限制)。

## 文档

| 文档 | 讲什么 |
| --- | --- |
| [兼容性](docs/compatibility.md) | 是不是只能 Edge；Chrome / 其它 Chromium 怎么接；哪些部分与品牌无关 |
| [approval 模式](docs/approval-mode.md) | 为什么每条连接都要点一次「允许」、授权活多久、卡住时的诊断、为什么只做 TCP 探活 |
| [工具面](docs/tool-surface.md) | 默认直出哪些、`cdp_call` 怎么用、`DSH_CDP_TOOLS` / `DSH_CDP_BLOCKED_TOOLS` |
| [运维](docs/operations.md) | 环境变量、`tools/mcp-probe.mjs` 现场核对、升级预检、已知限制 |
| [调研](docs/research-cdp-extension-mcp.md) | 证据链：上游行为、Chromium 源码、每个结论的实测记录 |

## 测试

```
node --test "test/*.test.mjs"
```

测试不联网、不启动浏览器、不碰真实 profile（`checkTcp` 只连本地临时 `net.createServer`，
入口查找用 `os.tmpdir()` 下的临时目录）。
