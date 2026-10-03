# 兼容性：只能用在 Edge 上吗

不是。**机制是 Chromium 通用的，Edge 只是默认值。**

## 机制里没有 Edge 专有的东西

attach 这条路只用三样 Chromium 本身的能力：

| 用到的东西 | 出处 | 与品牌有关吗 |
| --- | --- | --- |
| `<user data dir>/DevToolsActivePort`（正文是 `port\n/devtools/browser/<guid>`） | Chromium `remote_debugging_server.cc` 写入 | 无关 |
| approval 模式的开关（inspect 页的 "Allow remote debugging for this browser instance"） | 偏好 `devtools.remote_debugging.user-enabled` + feature `kDevToolsAcceptDebuggingConnections` | 无关 |
| `Extensions` CDP 域（browser 级） | Chromium DevTools Protocol | 无关 |

源码引用与实测记录见[调研文档](research-cdp-extension-mcp.md)。

## 本仓库怎么选浏览器

没有 Edge 专有的代码路径。`lib/browser-paths.mjs` 按这个顺序决定 user data 目录：

1. `DSH_CDP_USER_DATA_DIR`（显式指定，优先级最高）；
2. `DSH_CDP_PORT_FILE`（只关心端口文件，不关心目录）；
3. 候选目录里**真的有** `DevToolsActivePort` 的那个（候选顺序 Edge → Chrome）；
4. 都没有时回落到 Edge 的默认位置，报错里列出试过的全部路径。

候选路径按平台给：Windows 用 `%LOCALAPPDATA%`，macOS 用 `~/Library/Application Support/`，
Linux 用 `~/.config/`。报错和挂起诊断按探测到的浏览器点名它自己的 inspect 页。

工具面、`DSH_CDP_TOOLS` / `DSH_CDP_BLOCKED_TOOLS` 都是上游 `chrome-devtools-mcp` 的能力，与品牌无关。

## 换浏览器要满足的前提

目标浏览器必须**有** inspect 页那个 approval 开关。这个功能在 Chromium 里由 feature
`kDevToolsAcceptDebuggingConnections` 门控（桌面默认启用、ChromeOS 禁用），Chrome 侧从 144 起可用
（[官方公告](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)）。

Chrome 会被自动探测到（Edge 没有端口文件、Chrome 有，就选 Chrome）。装在非标准位置时才需要显式指定：

```powershell
$env:DSH_CDP_USER_DATA_DIR = "$env:LOCALAPPDATA\Google\Chrome\User Data"
```

然后在 `chrome://inspect#remote-debugging` 勾上 **"Allow remote debugging for this browser instance"**。

| 浏览器 | 状态 |
| --- | --- |
| Edge（候选里的第一个，本仓库实测环境） | 可用，入口是 `edge://inspect` |
| Chrome 144+ | 机制相同，本机未实测；目录会被自动探测，也可用 env 显式指定 |
| Chrome <144 | 没有 approval 开关，这条路走不通 |
| 其它 Chromium 分支（Brave、Vivaldi 等） | 未实测；跟随上游 Chromium 版本的话会有同一个开关，去它们的 inspect 页确认 |

**实测边界**：仓库里所有标「已实测」的结论都来自 Windows 上的 Edge。Chrome 与其它分支是源码和官方文档
推断，没有本地实测记录。

上游 `chrome-devtools-mcp` 自己还有一条 `--autoConnect`（Chrome 144+，按 channel 找 user data 目录），
本插件没用它：端点校验、工具面裁剪、屏蔽闸门都得自己拿在手里，直接算 `--wsEndpoint` 更可控。
