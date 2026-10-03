# 用 CDP 调试浏览器扩展：MCP 工具横向调研

调研对象：把 CDP/扩展调试能力接进 agent 的现有 MCP 工具与同类 DSH 插件。
对比基线：`D:\DSH\dsh-cdp`（DSH 插件，把 `chrome-devtools-mcp` attach 到用户正在跑的日常 Edge；只做 TCP 探活 + 透明转发，不自己建 CDP 连接；默认屏蔽 `trigger_extension_action`）。
调研日期：2026-10 初。所有结论尽量追溯到官方源码 / 官方文档 / 官方 issue，未证实的明确标注。

## TL;DR

1. ~~上游 `chrome-devtools-mcp` 已经**显式禁止**「attach 已运行浏览器」与「扩展工具」同时启用……在 v1.10.1 上会被启动期拒绝~~ **【2026-10-03 实测推翻，见文末「实地复核」】**。该禁令只存在于上游 **main 分支未发布的代码**里；**发布版 1.10.1 的构建产物中不存在 `CONFLICTING_ARGS`**，且 1.10.1 的 `EXTENSIONS` 分类选项**不带 `conflicts`**（只有 `PWA` 带）。实验：`--categoryPwa --wsEndpoint` → exit 1（被拒），`--categoryExtensions --wsEndpoint` → exit 0（正常启动）。**我方 `--categoryExtensions` attach 日常 Edge 的组合在 1.10.1 上合法且已实测可用**。[mcp-options.ts（main，未发布）](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/config/mcp-options.ts) [1.10.1 发布包实测](https://registry.npmjs.org/chrome-devtools-mcp)
2. **官方文档/issue 的说法与 1.10.1 实际行为不符，以实测为准**。maintainer 在 issue #1173 称 WebSocket 下扩展管理类 CDP 方法会返回 `Method not allowed`；但实测 1.10.1 通过 `--wsEndpoint` attach 日常 Edge 时，`list_extensions`、`reload_extension`、`trigger_extension_action` **全部调用成功**（详见「实地复核」）。官方文档那条 `--categoryExtensions` 只支持 pipe 的说明因此**在 1.10.1 上已过时**。真正的坑在别处：`trigger_extension_action` 会打崩浏览器（见第 4 条与「实地复核」）。[issue #1173](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1173#issuecomment-4055872512)
3. approval 弹窗是**故意设计**且官方明确拒绝提供「记住允许」：issue #825 被 close 为 `not_planned`，官方给的唯一出路是「用非默认 `--user-data-dir` 起浏览器 + `--browserUrl`」，官方原话「In this case, there will be no dialogs」；源码层面弹窗只有 Allow / Cancel / 「Turn off in settings」三个按钮，没有 remember 选项；Chromium 侧追踪 bug 460665929 的原文也只说「require the user to accept incoming connections」，没有任何持久化授权的计划。[issue #825](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/825#issuecomment-3800124123) [devtools_connection_dialog.cc](https://github.com/chromium/chromium/blob/main/chrome/browser/devtools/devtools_connection_dialog.cc) [crbug 460665929](https://issues.chromium.org/issues/460665929)
4. **两个被混为一谈的 Chromium 变更，我方基线的表述需要修正（此条经源码+实测双重确认，成立）**：136 变更是「默认 data dir 上忽略调试开关」，而**这个默认目录检查只对 Google Chrome 品牌无条件开启**（`#if BUILDFLAG(GOOGLE_CHROME_BRANDING)`，`remote_debugging_server.cc` L169-174）；approval 模式是 144 的另一个功能（`kDevToolsAcceptDebuggingConnections`）。实测对照：Edge 154 用**一次性 profile + `--remote-debugging-port=9333`** → `/json/version` 返回 **200**（kDefault，无弹窗）；**日常 profile + `edge://inspect` 开关** → `/json/version` 返回 **404**（approval 模式）。结论：Edge 上默认 profile 的调试开关**仍会被接受**（不受 136 限制），但你日常 profile 走的是 approval 模式，弹窗依然存在。[remote_debugging_server.cc](https://github.com/chromium/chromium/blob/main/chrome/browser/devtools/remote_debugging_server.cc)
5. 同类 DSH 插件里最接近的对照实现是 `dougen/dsh-cdp`：同样是"attach 日常浏览器 + 避免每次弹窗"，但走的是**完全相反**的路线 —— 宿主持有唯一一条常驻 CDP WebSocket + 心跳，把操作挂在回环 HTTP 路由上，**新增 0 个工具 schema**，并把「等待授权时 socket 静默」显式建模成独立状态、复用被挂起的 socket。这两点（连接复用、零工具面）是我方最值得抄的。[dsh-cdp](https://dshmp.com/en/plugins/dsh-cdp)

## 候选对比表

| 候选 | attach 已运行浏览器 | 扩展调试 / MV3 SW | 连接即弹窗的解法 | 工具集裁剪 | 上下文成本 | 最新版本 |
|---|---|---|---|---|---|---|
| chrome-devtools-mcp（Google 官方） | 支持：`--browserUrl/-u`、`--wsEndpoint/-w`、`--autoConnect --user-data-dir` | 有 5 个扩展工具；官方文档称仅限 pipe，但 **1.10.1 实测 WS attach 下扩展工具与 SW 均可用**（见「实地复核」B）。注意 `trigger_extension_action` 会打崩有头浏览器 | 官方不提供；建议改用非默认 profile。社区有自动点 Allow 的外部工具 | 11 个 `--categoryXxx` 开关；`--slim`=3 工具 | 实测 `--categoryExtensions` 下 34 个工具（过滤后）/ 28 KB；全量 59 个（tool-reference） | 1.10.1（2026-09-23） |
| Playwright MCP（microsoft） | 支持：`--cdp-endpoint`；另有 `--extension` 走扩展桥 | 未找到任何 MV3 SW 调试证据；只有 `--block-service-workers` | `--extension` 模式用 auth token 免每次批准；CDP 路线受 approval 影响 | `--caps=...`、`--config`、`--isolated` | README 列 72 个 `browser_*`，默认 core 25 个；无 slim 模式 | 0.0.83（2026-09-28） |
| puppeteer MCP 系列 | 官方 `@modelcontextprotocol/server-puppeteer` 已归档且只能 launch；fork `merajmehrabi/puppeteer-mcp-server` 要求先关掉所有 Chrome 再用调试端口重启 | 无 | 无（新起浏览器不存在该问题） | 无 | 小（少量工具） | 官方包 2025-05-12 deprecated；fork 0.7.2 |
| browser-use / Browserbase / Stagehand | MCP 层均无 attach 参数；Browserbase 走云端 session | 无 | 不适用 | 无 | 中等 | `@browserbasehq/mcp` 3.0.0 |
| hangwin/mcp-chrome（扩展桥） | 不需要 CDP：Chrome 扩展 + Native Messaging | 用 `chrome.debugger`，无「调试任意扩展 SW」能力 | 不依赖调试端口，因此没有弹窗问题 | 工具 23 个 | 中等 | `mcp-chrome-bridge` 1.0.31 |
| 专做扩展调试的 MCP | 题面点名的 6 个名字全部**不存在**；真实存在的是 [chrome-extension-testing-mcp](https://github.com/BHUVAN-RJ/chrome-extension-testing-mcp)（有 `connect_browser` 连真实浏览器）与 [chrome-extension-tester-mcp](https://github.com/heyitschien/chrome-extension-tester-mcp) | 它们做的就是扩展测试（popup/storage/badge/messaging/SW 日志） | 自起浏览器，不存在该问题 | 工具数少 | 小 | 见下节 |
| `chrome-remote-interface`（库，非 MCP） | 支持：默认 `localhost:9222`，或把 `target` 设为原始 `ws://` URL（**没有** `browserURL`/`browserWSEndpoint` 这两个选项名） | 直接用 `Target`/`ServiceWorker`/`Extensions` domain | 不解决；但它让"一条连接多会话（sessionId flat session）"容易实现 | 不适用（自己写工具） | 完全可控 | — |
| 同类 DSH 插件 `dsh-cdp` / `dsh-browser-attach` / `dsh-chrome-cdp` | 都是 attach | 未见扩展调试 | `dsh-cdp`：唯一常驻连接 + 心跳，只授权一次 | `dsh-chrome-cdp`：5 组可整组关闭 | `dsh-chrome-cdp` 全开约 2K tokens；`dsh-cdp` 0 schema | `dsh-cdp` 0.2.0/0.2.2 |

## 各候选详情

### chrome-devtools-mcp（ChromeDevTools，Google 官方）

版本：npm `latest` = **1.10.1**，发布于 2026-09-23（`registry.npmjs.org` 的 `dist-tags.latest` 与 `time` 字段）。[npm registry](https://registry.npmjs.org/chrome-devtools-mcp)

**attach 已运行浏览器的三种参数**（官方 configuration 文档原文）：

- `--browserUrl`/`--browser-url`, `-u`：`Connect to a running, debuggable Chrome instance (e.g. http://127.0.0.1:9222).`
- `--wsEndpoint`/`--ws-endpoint`, `-w`：`WebSocket endpoint to connect to a running Chrome instance (e.g., ws://127.0.0.1:9222/devtools/browser/<id>). Alternative to --browserUrl.`
- `--autoConnect`/`--auto-connect`：`If specified, automatically connects to a browser (Chrome 144+) running locally from the user data directory identified by the channel param (default channel is stable). Requires the remote debugging server to be started in the Chrome instance via chrome://inspect/#remote-debugging.`

来源：[docs/configuration.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md)

`--user-data-dir` 与 `--autoConnect` 一起用时，`BrowserManager` 会自己读 `DevToolsActivePort`，并把它拼成 `ws://127.0.0.1:${port}${rawPath}` —— 与我方包装脚本同一条技术路线，可作为「上游已内建」的证据：

```ts
const portPath = path.join(userDataDir, 'DevToolsActivePort');
const [rawPort, rawPath] = fileContent.split('\n')...
const browserWSEndpoint = `ws://127.0.0.1:${port}${rawPath}`;
connectOptions.browserWSEndpoint = browserWSEndpoint;
```

来源：[src/BrowserManager.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/BrowserManager.ts)

**`--categoryExtensions` 的确切语义与限制**（原文）：

> **`--categoryExtensions`/ `--category-extensions`** Set to true to include tools related to extensions. Note: This feature is currently only supported with a pipe connection. autoConnect, browserUrl, and wsEndpoint are not supported with this feature until 149 will be released.

来源：[docs/configuration.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md)、[src/config/category-options.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/config/category-options.ts)

不只是「不生效」，而是**启动期直接冲突报错**：

```ts
export const CONFLICTING_ARGS: Array<Array<keyof typeof mcpOptions>> = [
  ...
  ['categoryExtensions', 'autoConnect'],
  ['categoryExtensions', 'browserUrl', 'wsEndpoint'],
];
// ConfigParser.validateConflicts:
throw new Error(`Arguments ${String(arg1)} and ${String(arg2)} are mutually exclusive`);
```

来源：[src/config/mcp-options.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/config/mcp-options.ts)、[src/config/ConfigParser.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/config/ConfigParser.ts)

`--categoryExtensions` 在 MCP server 模式下默认 false（与 configuration.md 一致）。只有走 CLI（`--viaCli`）时它才被自动置 true，且**仍然要满足「不是 attach 模式」**：

```ts
if (isViaCli) {
  const connectsToExistingBrowser = resolvedArgs.autoConnect || resolvedArgs.browserUrl || resolvedArgs.wsEndpoint;
  if (resolvedArgs.categoryExtensions === undefined && !connectsToExistingBrowser) {
    resolvedArgs.categoryExtensions = true;
  }
}
```

来源：[src/config/ConfigParser.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/config/ConfigParser.ts)。另外 CLI 明确不支持扩展工具：`Thus, --categoryExtensions tools are currently not available in the CLI.`（[docs/cli.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/cli.md)）

**工具分组与裁剪语义**：11 个分类开关 `--categoryInput / Navigation / Emulation / Performance / Network / Debugging / Extensions / ExperimentalThirdParty / Memory / ExperimentalWebmcp / Pwa`。默认 true 的是 input、navigation、emulation、performance、network、debugging、memory；默认 false 的是 extensions、experimentalThirdParty、experimentalWebmcp、pwa。`--slim` 只暴露 3 个工具（`navigate` / `evaluate` / `screenshot`）。来源：[docs/slim-tool-reference.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/slim-tool-reference.md)、[src/tools/categories.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/tools/categories.ts)

**`--workspace` 的真实身份**：它就是 `--filesystemRoot` 的别名，可以重复传，默认值是 OS 临时目录；`--allowUnrestrictedPaths` 已标 `deprecated: 'Use --workspace=/ instead.'`：

```ts
filesystemRoot: {
  type: 'array', string: true, alias: 'workspace',
  default: DEFAULT_FILESYSTEM_ROOT,  // [os.tmpdir()]
  describe: 'A directory that filesystem tools are allowed to access. May be specified more than once.',
}
```

来源：[src/config/mcp-options.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/config/mcp-options.ts)

**扩展类 5 个工具**：`install_extension` / `list_extensions` / `reload_extension` / `trigger_extension_action` / `uninstall_extension`，全部带 `requires flag: --categoryExtensions=true`。来源：[docs/tool-reference.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)、[src/tools/extensions.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/tools/extensions.ts)

**`sw-N` 句柄的确切性质**（对应我方的已知限制）：它是 MCP server 进程内的自增计数器产物，前缀按 worker 类型区分（`sw`/`dw`/`shw`），注释明说「`Ids are not reused across reconnects, mirroring the page id counter in McpContext`」：

```ts
const WORKER_ID_PREFIX: Record<WorkerType, string> = {
  service_worker: 'sw', dedicated_worker: 'dw', shared_worker: 'shw',
};
let nextWorkerId = 1;
static create(type, target) { return new McpWorker(`${workerIdPrefix(type)}-${nextWorkerId++}`, type, target); }
```

来源：[src/McpWorker.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/McpWorker.ts)

`list_pages` 的描述随 `categoryExtensions` 变：`Get a list of pages${args?.categoryExtensions ? ' including extension service workers' : ''} open in the browser.` 来源：[src/tools/pages.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/tools/pages.ts)

**attach 模式下扩展 target 被过滤的具体位置**：launch 路径把 `enableExtensions` 传进 `makeTargetFilter(enableExtensions)`，connect 路径调用的是 `BrowserManager.makeTargetFilter()`（无参、false），而过滤器走 `isAllowedUrl`，其中 `if (!options.categoryExtensions && parsed.protocol === 'chrome-extension:') return false;`。来源：[src/BrowserManager.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/BrowserManager.ts)、[src/utils/url.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/utils/url.ts)

**approval/弹窗相关 issue**：

- [#825 Feature request: Allow persisting remote debugging permission approval](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/825) — 18 个 👍，2026-03-19 被 close，`state_reason: not_planned`。官方回复：`We have been discussing it a lot. There is no simple solution that also would not allow any program on the machine to easily access your data in Chrome. For now, we recommend to have longer connection sessions to avoid the reconnect dialog.` 以及绕过办法 `--remote-debugging-port=9222 --user-data-dir=/path/to/profile` + `--browserUrl=http://127.0.0.1:9222` → `In this case, there will be no dialogs.`（[comment](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/825#issuecomment-3800124123)）
- [#1794 “Allow remote debugging?” popup can trigger multiple times and stack up](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1794) — 仍 open。报告里直接点名「clients may poll `:9222` trying to connect until it's ready, or multiple subprocesses may try to connect in parallel」，每次重连各弹一个框。这条对我方 TCP 探活是**利好**：只做 TCP connect 不触发弹窗，做 CDP 握手才会。
- [#1173 支持 attach 模式下的扩展 page / SW 可见性](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1173) — 2026-04-21 close 为 completed；过程说明了为何 attach 模式拿不到扩展工具（见 TL;DR 第 2 条）。
- 社区绕过工具（第三方，非官方）：[dev-newb/yes-dev](https://github.com/dev-newb/yes-dev)（Windows/macOS，UI Automation / Accessibility 点 Allow）、[neronlux/yes-dev-linux](https://github.com/neronlux/yes-dev-linux)（Linux）。两者都明确声明「这不等价于持久化授权，它会批准任何本机进程」。
- 弹窗期间「握手被挂住」有第三方的代码级旁证：[vercel-labs/agent-browser commit 9ef6c1e](https://github.com/vercel-labs/agent-browser/commit/9ef6c1e53627b244c9a3151f4a9af545fd3d9cdf)（2026-09-29）的提交信息原文：`Chrome 144+ holds the DevToolsActivePort WebSocket handshake while it shows the remote-debugging permission prompt. The 2s verify timeout expired first, so auto-connect fell back to HTTP discovery, which triggered another prompt and then removed DevToolsActivePort from a Chrome that was still waiting. Keep the handshake open for 30s.`（Fixes [#1365](https://github.com/vercel-labs/agent-browser/issues/1365)）—— 和我方观察到的「零字节挂起」完全一致，而且它顺带证明了一个坑：**超时后回退到 HTTP 发现会再弹一次框**，所以我方宁可挂住也不要重试。
- 多客户端共享一条桥的做法（用于规避「每连接一次授权」）：[QwenLM/qwen-code#8740](https://github.com/QwenLM/qwen-code/pull/8740)「share one Chrome bridge across sessions via multi-client /cdp tunnel」（closed 未合并；同仓库的 [#8737](https://github.com/QwenLM/qwen-code/issues/8737) 记录了 `--autoConnect` 每次会话都重新弹框）、[sblattj/cdp-toolkit#9](https://github.com/sblattj/cdp-toolkit/pull/9)「Reach a Chrome that serves only the browser WebSocket」（open；作者原话：`A Chrome whose remote debugging was enabled at runtime via the chrome://inspect/#remote-debugging toggle serves neither: /json/* returns 404 and /devtools/page/<id> ...`，解法是只连 `/devtools/browser/<uuid>` 再用 `Target.attachToTarget{flatten:true}` 在同一个 socket 上复用所有 target）。

**Edge 专用配方（Microsoft 官方）**：`--autoConnect` 配合 `--user-data-dir=%LocalAppData%\Microsoft\Edge\User Data`，并说明 `the server reads the DevToolsActivePort file from that directory to discover the WebSocket endpoint of the running browser and connects to it` —— 与我方 `connect.mjs` 同一条技术路线，有官方背书。Edge 侧的授权入口是 `edge://inspect` 的 **Remote debugging** 页里勾选 `Allow remote debugging for this browser instance`。[MS Learn: devtools-mcp-server](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/devtools-mcp-server)

**官方文档页**（配合上下文）：[Debug Chrome extensions with AI agents](https://developer.chrome.com/docs/devtools/agents/extensions)（要求先开 `--categoryExtensions`，例子全是 launch 场景）、[Auto-connect](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)、[Configuration](https://developer.chrome.com/docs/devtools/agents/get-started/configuration)。

### Playwright MCP（microsoft/playwright-mcp）

版本：npm `latest` = **0.0.83**，发布于 2026-09-28。[npm registry](https://registry.npmjs.org/@playwright/mcp)

- `--cdp-endpoint <endpoint>`：README 原文 `CDP endpoint to connect to.`；`config.d.ts` 注释为 `Chrome DevTools Protocol endpoint to connect to an existing browser instance in case of Chromium family browsers.` 另有 `--cdp-header`、`--cdp-timeout`（默认 30000）。[README](https://github.com/microsoft/playwright-mcp/blob/main/README.md)
- `--extension` 的**当前**语义不是「加载扩展的持久化 context」，而是连接已运行的 Edge/Chrome：`--extension  Connect to a running browser instance (Edge/Chrome only). Requires the "Playwright Extension" to be installed.` 配套 `--profile-dir-name`。[program.ts](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/mcp/program.ts)
- 扩展桥的原理（源码级）：起本地 WebSocket relay，端点 `/cdp/<uuid>` 与 `/extension/<uuid>`，用 `chrome-extension://<id>/connect.html?mcpRelayUrl=...` 打开连接页，扩展回连后再 `playwright.chromium.connectOverCDP(relay.cdpEndpoint())`。**这条路不需要 `--remote-debugging-port`**，所以绕开了 approval 弹窗。[cdpRelay.ts](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/mcp/cdpRelay.ts)、[extensionContextFactory.ts](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/mcp/extensionContextFactory.ts)
- 扩展桥自己也有批准对话框，但可用 token 免掉：README 原文 `By default, you'll need to approve each connection when the MCP server tries to connect to your browser. To bypass this approval dialog ... use an authentication token.`（env `PLAYWRIGHT_MCP_EXTENSION_TOKEN`）。[packages/extension/README.md](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md)
- **MV3 service worker 调试：未找到证据。** 工具面没有 SW 目标选择，`browser_evaluate` 只写 `Evaluate JavaScript expression on page or element`；与 SW 有关的只有 `--block-service-workers`。
- 走 CDP 路线时同样撞 approval：[issue #1757](https://github.com/microsoft/playwright-mcp/issues/1757) 记录 `chrome://inspect` 开关打开后 `/json` 返回 404（原因见下文 Chromium 源码），且只要存在被 Memory Saver 丢弃的标签页就 30 秒超时；官方 workaround 同样是专用 `--user-data-dir`。
- 工具数与裁剪：README 列 72 个 `browser_*`，默认 core 25 个；`--caps`（vision / pdf / devtools 等）、`--config`、`--isolated`、`--snapshot-mode=none`、`--image-responses=omit`。**没有 `--slim` 之类的整体精简档**。

### puppeteer MCP 系列

- `@modelcontextprotocol/server-puppeteer` **已弃用且已归档**：npm deprecated 字段为 `Package no longer supported. ...`，官方 servers README 的 Archived 列表含 Puppeteer。官方没有为它指名替代品。[npm](https://registry.npmjs.org/@modelcontextprotocol/server-puppeteer/latest)、[servers README](https://github.com/modelcontextprotocol/servers/blob/main/README.md)
- 归档版 README 证明它只能 launch：唯一相关参数是 `launchOptions`，没有 `connect`。[archived README](https://github.com/modelcontextprotocol/servers-archived/blob/main/src/puppeteer/README.md)
- 真实存在的 fork：[merajmehrabi/puppeteer-mcp-server](https://github.com/merajmehrabi/puppeteer-mcp-server)（约 485 stars）。有 `puppeteer_connect_active_tab`（`debugPort` 默认 9222），但 README 要求 `Close any existing Chrome instances completely` 后再用 `--remote-debugging-port=9222` 启动 —— **仍然不能 attach 你此刻正在用的浏览器**。

### browser-use / Browserbase / Stagehand

- browser-use 的本地 MCP（`uvx --from 'browser-use[cli]' browser-use --mcp`）文档只列 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `BROWSER_USE_HEADLESS` / `BROWSER_USE_DISABLE_SECURITY`，**没有任何 attach/CDP 参数**；库层有 `Browser(cdp_url=...)`、`from_system_chrome()`，MCP 层没有。[browser-use MCP docs](https://docs.browser-use.com/open-source/customize/integrations/mcp-server.md)
- Browserbase 的 MCP 仓库 **已归档**（README 首行 `# Archived`），走云端 session；npm `@browserbasehq/mcp-server-browserbase` 的 deprecated 字段写着 `This package has moved to @browserbasehq/mcp`。现行 `@browserbasehq/mcp@3.0.0` 含 Stagehand，同样**不能 attach 本机浏览器**。[archived README](https://github.com/browserbase/mcp-server-browserbase/blob/main/README.md)、[npm](https://registry.npmjs.org/@browserbasehq/mcp/latest)
- 结论：这一族对本场景（调试我方日常浏览器里的扩展）没有可用价值。

### 扩展桥类：hangwin/mcp-chrome

真实存在，npm `mcp-chrome-bridge@1.0.31`（2025-12-30，desc = `Chrome Native-Messaging host (Node)`）。架构 = Chrome 扩展 + **Native Messaging**（不是「扩展连本地 WebSocket」）：AI → MCP server（HTTP/SSE）→ Native Messaging Host → 扩展 background → `chrome.*` API。扩展权限含 `nativeMessaging`、`tabs`、`scripting`、`webRequest`、`debugger`。**不要求也不使用 `--remote-debugging-port`**，所以天然没有 approval 弹窗问题；代价是必须装一个扩展。它不提供「调试任意扩展的 SW」的能力。[ARCHITECTURE.md](https://github.com/hangwin/mcp-chrome/blob/master/docs/ARCHITECTURE.md)、[wxt.config.ts](https://github.com/hangwin/mcp-chrome/blob/master/app/chrome-extension/wxt.config.ts)

### 专门做扩展调试的 MCP / 封装 `Extensions` domain 的项目

逐个在 GitHub（`in:name` 精确搜索）与 npm registry 查包的结果 —— **题面里点名的这些名字全部不存在**：

| 候选名 | GitHub 同名仓库 | npm 包 | 结论 |
|---|---|---|---|
| `chrome-extensions-mcp` | 无（in:name 唯一命中不同名的 [chrome-extensions-dom-mcp](https://github.com/webshoten/chrome-extensions-dom-mcp)） | 404 | 未找到 |
| `extension-mcp` | 无 | 404 | 未找到 |
| `chrome-extension-mcp` | 无（模糊命中 [chrome-extension-mcp-go](https://github.com/teppei22/chrome-extension-mcp-go)） | 404 | 未找到 |
| `mcp-server-chrome-extension` | 无（唯一命中 [mcp-server-for-chrome-extension](https://github.com/thaiannguyen-05/mcp-server-for-chrome-extension)，0 star、无描述） | 404 | 未找到 |
| `chrome-extension-debugging` | 无同名 MCP 仓库（命中 DataTables 的调试扩展） | 404 | 未找到 |
| `extension-devtools-mcp` | 无（模糊命中 [browser-devtools-mcp-vscode-extension](https://github.com/serkan-ozal/browser-devtools-mcp-vscode-extension)，是 VS Code 扩展） | — | 未找到 |

名字最接近且真实存在的是 fork：[arbel03/chrome-extensions-devtools-mcp](https://github.com/arbel03/chrome-extensions-devtools-mcp)（fork=true、0 star、parent=`ChromeDevTools/chrome-devtools-mcp`），源码直接发 `Extensions.triggerAction` / `getExtensions` / `getStorageItems` / `setStorageItems`（`src/McpContext.ts`）。

**真实存在、且确实在做「扩展测试/调试」的 MCP**（都不 attach 你的日常 profile，都是自己起浏览器）：

- [BHUVAN-RJ/chrome-extension-testing-mcp](https://github.com/BHUVAN-RJ/chrome-extension-testing-mcp)（npm [`chrome-extension-tester-mcp`](https://www.npmjs.com/package/chrome-extension-tester-mcp)，README 自述 13 个工具、覆盖面含 popup / storage / network / badge / messaging），有 `connect_browser` 可连真实的 Brave/Chrome 实例。3 stars。
- [heyitschien/chrome-extension-tester-mcp](https://github.com/heyitschien/chrome-extension-tester-mcp)：5 个工具，Playwright 起 headful Chromium + `--load-extension`，README 自述仅限截图/点击/console。注意 npm 上同名包属于另一个项目，README 有明确警告。
- [jonghklee/cdp-mcp](https://github.com/jonghklee/cdp-mcp)：README 声称提供 extension QA 层，但下游核对源码后**没有任何 `Extensions.*` / `ServiceWorker.*` 调用**，实际靠 service_worker 上下文 + 注入脚本，名不副实。
- `ServiceWorker` domain 的 MCP 封装：`startWorker` / `stopWorker` **未找到**任何封装。唯一找到的部分封装是 [vmoranv/jshookmcp](https://github.com/vmoranv/jshookmcp)（2019 stars），其 `service_worker_deliver_push` / `service_worker_dispatch_sync` 工具显式调用 `ServiceWorker.deliverPushMessage` / `dispatchSyncEvent`，并有 `ServiceWorker.enable`。
- 官方路径仍然是 chrome-devtools-mcp 自己的 `--categoryExtensions`（实现 PR [#1922](https://github.com/ChromeDevTools/chrome-devtools-mcp/pull/1922)，merged 2026-04-21，Closes #1173、#96）。

**真正被 MCP 封装的是 CDP 的 `Extensions` domain**，而它只存在于浏览器级连接上。官方协议定义（`devtools-protocol/json/browser_protocol.json`）里该 domain 的**全部**命令：

| 命令 | 说明（原文） |
|---|---|
| `triggerAction` | `Runs an extension default action.` |
| `loadUnpacked` | `Installs an unpacked extension from the filesystem similar to --load-extension CLI flags. Returns extension ID once the extension has been installed.` |
| `getExtensions` | `Gets a list of all unpacked extensions.` |
| `uninstall` | `Uninstalls an unpacked extension (others not supported) from the profile.` |
| `getStorageItems` / `setStorageItems` / `removeStorageItems` / `clearStorageItems` | 读写扩展 storage，带 `storageArea` 参数 |

来源：[browser_protocol.json](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json)。两个值得注意的点：`getExtensions` 只覆盖 **unpacked** 扩展；domain 里**没有** reload 命令，所以 chrome-devtools-mcp 的 `reload_extension` 是靠重新 `installExtension(extension.path)` 实现的。[src/tools/extensions.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/tools/extensions.ts)
- `ServiceWorker` domain 同样存在于浏览器级协议，命令有 `startWorker`、`stopWorker`、`stopAllWorkers`、`dispatchSyncEvent`、`dispatchPeriodicSyncEvent`、`deliverPushMessage`、`skipWaiting`、`updateRegistration`、`unregister`、`enable`、`disable`、`setForceUpdateOnPageLoad`。[browser_protocol.json](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json) —— `startWorker` 是解决「MV3 SW 睡着后不在 list_pages 里」的正规手段，但本次没有找到任何 MCP 工具把它暴露出来。
- 上游与扩展调试相关的 issue：[#265 Add a flag for loading extensions](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/265)（提出了「用 MCP 调试扩展」的需求，最终落地为 `--categoryExtensions`）、[#1173](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1173)、[#510 MCP times out when browser has MetaMask extension](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/510)（装了扩展导致工具全部超时）、[#1921 标签页极多时浏览器在首次工具调用时崩溃](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1921)。

### 非 MCP 的替代路径：IDE 与 chrome-remote-interface

**VS Code 内置 JS 调试器（js-debug）**：官方文档给 attach 的要求是

```
edge.exe --remote-debugging-port=9222 --user-data-dir=remote-debug-profile
```

并明确写：`Setting a separate --user-data-dir forces a new instance of the browser to be opened; if this flag isn't given, then the command will open a new window of any running browser and not enter debug mode.` 也就是说，VS Code 的 attach **不能**挂到你日常默认 profile 的浏览器上；attach 配置里可用的是 `url` / `port` / `address`。[Browser debugging in VS Code](https://code.visualstudio.com/docs/nodejs/browser-debugging)

**JetBrains（WebStorm 等）**：官方有「Debug Chrome extensions」章节，但流程是「用 `Attach to Node.js/Chrome` 配置 + 用自定义 user data profile 起 Chrome（`--remote-debugging-port=<port> --user-data-dir=<your profile>`）+ 手动加载 unpacked 扩展」。同样不支持 attach 到日常默认 profile。[JetBrains: debugging JavaScript in Chrome](https://www.jetbrains.com/help/webstorm/debugging-javascript-in-chrome.html)

**结论**：主流 IDE 的调试路径与 Chrome 136 的安全收紧方向一致 —— 都要求独立 profile，因此都不能替代「attach 你正在用的浏览器」这个需求。这也说明我方的场景在官方工具链里没有现成答案，只有 `chrome-devtools-mcp --autoConnect` 这一条（靠用户在 `chrome://inspect` 主动授权）是官方认可的例外。

**chrome-remote-interface（cyrus-and/chrome-remote-interface，非 MCP，是一个库）**：

- 默认连 `localhost:9222`，并提供 `CDP.List`（走 `http://host:port/json/list`）、`CDP.New`、`CDP.Activate`、`CDP.Close`、`CDP.Version`。
- **没有** `browserURL` / `browserWSEndpoint` 这两个名字；等价的写法是把 `target` 选项设成原始 WebSocket URL：`a string representing the raw WebSocket URL, in this case host and port are not used to fetch the target list`。文档也给了 `target` 为 target id / target 对象 / 函数的其它形态。
- 支持 flat session：`send(method, params, sessionId)` 与事件 `'<domain>.<method>.<sessionId>'` 都带可选 `sessionId`。
- 注意一条限制：`at most one connection can be established to the same target`。
- README 里**没有**提到 `DevToolsActivePort`（发现端口仍需自己做，和 chrome-devtools-mcp 的 `--autoConnect` 不同）。

来源：[chrome-remote-interface README](https://github.com/cyrus-and/chrome-remote-interface/blob/master/README.md)。对我方的意义：如果哪天要自己建唯一连接并复用会话，CRI 是够用的底座；但要注意它的默认发现路径是 `/json/list`，而 approval 模式下该端点会 404（见上文源码），所以必须走 `target: 'ws://...'` 直连 WebSocket。


## Chromium approval 模式现状（源码核实）

**枚举定义**：`content/public/browser/devtools_agent_host.h` —— 只有两个取值，注释把行为写得很死：

```cpp
enum RemoteDebuggingServerMode {
  // The default mode started by command-line flags like
  // --remote-debugging-port.
  // The server does not require explicit user approval for debugging.
  kDefault,
  // Each debugging connection will be rejected until the user explicitly
  // approves it.
  kWithApprovalOnly,
};
```

来源：[content/public/browser/devtools_agent_host.h](https://github.com/chromium/chromium/blob/main/content/public/browser/devtools_agent_host.h)

**136 起的默认 profile 限制（官方公告）**：`from Chrome 136 we're making changes to the behavior of --remote-debugging-port and --remote-debugging-pipe. These switches will no longer be respected if attempting to debug the default Chrome data directory. These switches must now be accompanied by the --user-data-dir switch to point to a non-standard directory.` 理由是从 Chrome Remote Debugging 端口窃取 cookie 的攻击在上升。同一篇公告还给自动化场景推荐 Chrome for Testing。[developer.chrome.com/blog/remote-debugging-port（2025-03-17）](https://developer.chrome.com/blog/remote-debugging-port)；企业版发布说明的对应条目为 `136: Custom data directory required for remote debugging`（[support.google.com/chrome/a/answer/12239814](https://support.google.com/chrome/a/answer/12239814)）

**但这条检查只对 Google Chrome 品牌生效**（源码原文，本次调研最关键的一条）：

```cpp
#if BUILDFLAG(GOOGLE_CHROME_BRANDING)
  constexpr bool default_user_data_dir_check_enabled = true;
#else
  const bool default_user_data_dir_check_enabled =
      g_enable_default_user_data_dir_check_for_chromium_branding_for_testing;
#endif
  if (default_user_data_dir_check_enabled && is_default_user_data_dir.value_or(true)) {
    return base::unexpected(RemoteDebuggingServer::NotStartedReason::kDisabledByDefaultUserDataDir);
  }
```

来源：[chrome/browser/devtools/remote_debugging_server.cc](https://github.com/chromium/chromium/blob/main/chrome/browser/devtools/remote_debugging_server.cc)。非 Google 品牌的 Chromium 构建（含 Edge）**默认不做**默认目录拒绝，只有测试开关 `EnableDefaultUserDataDirCheckForTesting()` 才打开。这是源码推断，**微软官方文档既没确认也没否认**，需要实测。

**另一个必须分清的点：136 的变更里没有任何「批准」对话框。** approval 是 M144 的独立功能，官方博文原话 `every time the Chrome DevTools MCP server requests a remote debugging session, Chrome will show a dialog to the user and ask for their permission`。[developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)。我方基线里「Chromium 136+ approval 模式」的表述应拆成这两件事。

**approval 模式从哪来**：由偏好 `devtools.remote_debugging.user-enabled` 触发（即用户在 `chrome://inspect` 打开开关），另有管理员偏好 `devtools.remote_debugging.allowed`；两者在 `remote_debugging_server.cc` 中被读取，并受 feature `kDevToolsAcceptDebuggingConnections` 门控：

```cpp
// Returns true if remote debugging is enabled via chrome://inspect
// which indicates that we should start the debugging server in the approval
// mode in which each incoming connection needs to be approved by the user.
bool isRemoteDebuggingEnabledViaPrefs(PrefService* local_state) {
  return local_state->GetBoolean(prefs::kDevToolsRemoteDebuggingEnabled);
}
...
StartHttpServer(..., content::DevToolsAgentHost::RemoteDebuggingServerMode::kWithApprovalOnly);
// 若 kDevToolsRemoteDebuggingAllowed 为 false：
//   return base::unexpected(RemoteDebuggingServer::NotStartedReason::kDisabledByPolicy);
```

来源：[chrome/browser/devtools/remote_debugging_server.cc](https://github.com/chromium/chromium/blob/main/chrome/browser/devtools/remote_debugging_server.cc)、[chrome/common/pref_names.h](https://github.com/chromium/chromium/blob/main/chrome/common/pref_names.h)（`kDevToolsRemoteDebuggingAllowed = "devtools.remote_debugging.allowed"`、`kDevToolsRemoteDebuggingEnabled = "devtools.remote_debugging.user-enabled"`）

那个 feature flag 定义在 `chrome/browser/devtools/features.cc`（不在 `chrome/common/chrome_features.*`），非 ChromeOS 默认启用：

```cpp
// If enabled, allows starting remote debugging in a running Chrome instance.
#if BUILDFLAG(IS_CHROMEOS)
// Disabled on ChromeOS due to crbug.com/552883317.
BASE_FEATURE(kDevToolsAcceptDebuggingConnections, base::FEATURE_DISABLED_BY_DEFAULT);
#else
BASE_FEATURE(kDevToolsAcceptDebuggingConnections, base::FEATURE_ENABLED_BY_DEFAULT);
#endif
```

来源：[chrome/browser/devtools/features.cc](https://github.com/chromium/chromium/blob/main/chrome/browser/devtools/features.cc)。它被改成默认启用的提交是 `80003e3`（2025-12-08，Bug: 460665929）与 M144 的 cherry-pick `9785048` —— 这与「approval 模式到 Chrome 144 才对外可用」一致。[80003e3](https://chromium.googlesource.com/chromium/src/+/80003e3e684f042b9f38b0b587b6fdd3beba8475)、[9785048](https://chromium.googlesource.com/chromium/src/+/97850487de7fb56388f52cc3de76a21a0eee7547)

设计意图的官方出处是追踪 bug [460665929](https://issues.chromium.org/issues/460665929)（页面内嵌 JSON 原文）：`...we want to add a capability to chrome://inspect page to start a local WebSocket server dynamically. This will start the DevTools remote debugging server in a special mode, that would require the user to accept incoming connections. The feature is developed behind a feature flag, pending launch approvals.` —— 通篇没有 remember / always allow / 静默方案。

**「连接即弹窗、且挂起不报错」的源码证据**：approval 模式下 HTTP 发现接口一律 404，非 browser 路径的 WebSocket 一律 403，只有 `/devtools/browser/...` 会走 `AcceptDebugging` 回调（也就是弹窗 + 挂起）：

```cpp
if (mode_ == DevToolsAgentHost::RemoteDebuggingServerMode::kWithApprovalOnly) {
  if (base::StartsWith(request.path, kBrowserUrlPrefix, base::CaseSensitive)) {
    delegate_->AcceptDebugging(base::BindOnce(&DevToolsHttpHandler::HandleDebuggingApproval, ...));
    return;
  }
  Send403(connection_id, "Connection rejected");
  return;
}
```

`OnJsonRequest` / `OnDiscoveryPageRequest` / `OnFrontendResourceRequest` 在 approval 模式下都是 `Send404(connection_id)`。来源：[content/browser/devtools/devtools_http_handler.cc](https://github.com/chromium/chromium/blob/main/content/browser/devtools/devtools_http_handler.cc) —— 这解释了两件事：Playwright MCP issue #1757 里 `/json` 404，以及我方观察到的「握手被挂起、返回零字节不报错」。

**弹窗本身没有「记住允许」**：`DevToolsConnectionDialog` 只有三个动作 —— Allow（OK 按钮）、Cancel、以及一个跳转到 `chrome://inspect#remote-debugging` 的额外按钮；`AcceptDebugging` 每次连接都会 `DevToolsConnectionDialog::Show(last_active, std::move(wrapped_callback))`。运行时还有一条 infobar（`DevToolsRemoteServerInfobarDelegate`）表示当前有活跃调试连接。

```cpp
.AddOkButton(... IDS_DEV_TOOLS_CONNECTION_DIALOG_ALLOW_TEXT ...)      // "Allow"
.AddCancelButton(...)
.AddExtraButton(... IDS_DEV_TOOLS_CONNECTION_DIALOG_DISABLE_TEXT ...) // "Turn off in settings"
```

来源：[chrome/browser/devtools/devtools_connection_dialog.cc](https://github.com/chromium/chromium/blob/main/chrome/browser/devtools/devtools_connection_dialog.cc)、[chrome/browser/devtools/chrome_devtools_manager_delegate.cc](https://github.com/chromium/chromium/blob/main/chrome/browser/devtools/chrome_devtools_manager_delegate.cc)、对话框文案在 [chrome/app/generated_resources.grd](https://github.com/chromium/chromium/blob/main/chrome/app/generated_resources.grd)：标题 `Allow remote debugging?`，正文 `An external app wants full control over this Chrome session to debug it. This includes access to your saved data, cookies and site data, and the ability to navigate to any URL.` / `Only web developers should turn on this feature, and only use it with trusted apps.`

**官方有没有静默/记住方案？没有。** 逐条排除：

- 「记住允许」：无，见上。
- 企业策略 `RemoteDebuggingAllowed`：只能**关掉**远程调试，不能免弹窗。Chrome 侧 [chromeenterprise.google/policies/remote-debugging-allowed](https://chromeenterprise.google/policies/remote-debugging-allowed/)、Edge 侧 [learn.microsoft.com/.../remotedebuggingallowed](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/remotedebuggingallowed)（`If you enable or don't configure this policy, users can use remote debugging by specifying --remote-debug-port ...`）。
- 换个非默认 `--user-data-dir`：这是官方唯一推荐的免弹窗路径，代价是丢掉日常 profile 的登录态与扩展。
- `--remote-debugging-pipe`：不受 approval 影响（approval 只作用于 HTTP server 路径，pipe handler 是另一条代码路径），但要求由自己 launch 浏览器。这是从源码结构推断，非官方明文表述。
- `--remote-allow-origins`：解决的是 WebSocket Origin 校验，和 approval 弹窗不是同一个问题（本项**未经证实**为官方文档明确表述，仅从源码分层看二者互不相干）。

**Edge 侧**：

- Microsoft Learn 明确 Edge 也支持 approval 开关与 auto-connect：`Option B: In the Inspect with Edge Developer Tools special page, enable remote debugging ... Select the "Allow remote debugging for this browser instance" checkbox`；配置为 `--autoConnect --user-data-dir=%LocalAppData%\Microsoft\Edge\User Data`。[MS Learn: devtools-mcp-server](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/devtools-mcp-server)
- **文档自相矛盾处（值得注意）**：同一页的 Option A 仍写 `msedge.exe --remote-debugging-port=9222`（不带 `--user-data-dir`）。结合上面的 `GOOGLE_CHROME_BRANDING` 判断，这一写法在 Edge 上**可能就是有效的**（而不是文档写错了）——但这一点**未经微软官方证实**，社区的 Edge 提问则显示默认 profile 下 remote debugging 不可用。[MS Q&A](https://learn.microsoft.com/en-gb/answers/questions/5976829/microsoft-edge-remote-debugging-is-not-working-whe)
- Edge 也接受同一个 `RemoteDebuggingAllowed` 策略（Windows ≥93）：`If you enable or don't configure this policy, users can use remote debugging by specifying --remote-debug-port and --remote-debug-pipe command line switches on desktop platforms`，同样没有默认目录的附加条件。[MS Learn](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/remotedebuggingallowed)
- Edge 是否对**每条新 WebSocket** 弹批准框、是否有微软侧差异：**未找到**微软官方说明。

**`DevToolsActivePort` 的格式（源码确认）**：内容是 `"<port>\n<browser_guid>"`，`browser_guid` 就是 `/devtools/browser/<guid>` 里那一段：

```cpp
std::string port_target_string = base::StringPrintf("%d\n%s", ip_address->port(), browser_guid.c_str());
base::WriteFile(output_directory.Append(kDevToolsActivePortFileName), port_target_string);
```

来源：[content/browser/devtools/devtools_http_handler.cc](https://github.com/chromium/chromium/blob/main/content/browser/devtools/devtools_http_handler.cc)

**approval 模式的引入提交**：Chromium commit `2e576ad` “Implement DevTools remote debugging approval mode”（2025-11-24），描述为「The server can now be started in "approval mode" via the chrome://inspect page, which is reflected in the `kDevToolsRemoteDebuggingEnabled` preference」。[commit](https://github.com/chromium/chromium/commit/2e576ad6c7ba4b9becbf873cf29b614ffc51f54d) —— chrome-devtools-mcp 文档与 issue 里的「Chrome 144+」与这个时间点吻合。

## 同类 DSH 插件对比

| 插件 | 架构 | 弹窗处理 | 工具面/上下文 | 扩展相关 |
|---|---|---|---|---|
| [dsh-cdp](https://dshmp.com/en/plugins/dsh-cdp) / [`@dougen/dsh-cdp`](https://dshmp.com/en/plugins/dougen-dsh-cdp) | 宿主持有**唯一一条**常驻 CDP WebSocket + 心跳；操作挂在回环 HTTP 路由 `/api/dsh-cdp`，附 `browser-cdp` skill | 唯一连接 → 只授权一次；把「等待授权时 socket 静默」建成独立状态 `awaiting-approval`；**被挂起的 socket 保留复用**，Allow 后直接接管，不再开新连接 | **新增 0 个工具 schema**（agent 用已有 shell 工具调 HTTP） | 未提及扩展调试 |
| [JackAIStudio/dsh-browser-attach](https://github.com/JackAIStudio/dsh-browser-attach) | 常驻 daemon `browserctl.mjs` 持**一条** CDP 连接，CLI 回退与插件共用同一 daemon（127.0.0.1:9223） | 「Chrome 授权弹窗每个会话点一次」 | 注册 `browser_*` 工具（doctor/tabs/open/read/shot/snapshot/click/type/eval/wait/activate/close）；审计写 `~/.config/browserctl/` | 无 |
| [xiaobai2017666/dsh-chrome-cdp](https://github.com/xiaobai2017666/dsh-chrome-cdp) | `chrome-remote-interface`；host 半边 `lib/index.js` + preset 半边 `lib/tools.mjs`，通过包根 `bridge.mjs` 单例共享连接；带 Web GUI 连接面板 | README 未描述弹窗处理（**未见相关设计**） | 11 个 `chrome_*` 工具分 5 组，`groups.<name>: false` 整组关闭 → 不注册、零 schema；全开约 **2K tokens**；`chrome_cdp` 是可发任意 CDP 命令的逃生舱 | `chrome_list_targets` 列出 worker；无扩展管理工具 |
| [caob23/dsh-browser-control](https://awesome-dsh-plugin.com/p/caob23/dsh-browser-control/) | Chrome 扩展 + 本地 WebSocket bridge | 不依赖调试端口 | `browser_*` 工具 + Settings 开关 | 无 |
| [lyd123qw2008/pi-control-chrome](https://github.com/lyd123qw2008/pi-control-chrome) | MV3 扩展 + 回环 Bridge，驱动真实 profile | 不依赖调试端口 | 原生 CDP + AX-first | 扩展即本体，但不能调试别的扩展 |
| [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) | 扩展 + Native Messaging | 同上 | 23 个工具 | 用 `chrome.debugger`，无扩展调试 |
| [wqty123/dsh-browser](https://awesome-dsh-plugin.com/p/wqty123/dsh-browser/)、[stuarthu/dsh-chrome](https://github.com/stuarthu/dsh-chrome)、[Tencent/BrowserSkill](https://awesome-dsh-plugin.com/p/Tencent/BrowserSkill--packages-dsh-plugin-browserskill/) | 自建窗口 / side panel / 专用浏览器 | 不用日常浏览器，无弹窗 | 20~N 个工具 | 无 |
| [yuzi-ska/DSH-Chrome-devtools](https://github.com/yuzi-ska/DSH-Chrome-devtools) | 直接包 `chrome-devtools-mcp` | 继承上游 | 继承上游 | 继承上游 |

`xiaobai2017666/dsh-chrome-cdp` 已被收录进 awesome-dsh-plugin 的 Browser & Web 分类（★1，Added 2026-08-31）。[awesome-dsh-plugin 条目](https://awesome-dsh-plugin.com/p/xiaobai2017666/dsh-chrome-cdp/)

补充：该仓库 README 的目录列了「Chrome 侧准备 / 面板使用 / 验证与排查」三节，但正文里没有对应内容（README 全长仅 4255 字节，正文到「开发循环」结束）——也就是说它**完全没有记录** approval 弹窗、默认 profile 限制、扩展调试这三件事。与它对比时不要假设这些设计存在。[README.md](https://github.com/xiaobai2017666/dsh-chrome-cdp/blob/master/README.md)

## 可借鉴点清单（按对我方的收益/可行性排序）

~~**先做的一件事（收益最高、成本最低）**：在 Edge 上用**默认 profile** 直接 `msedge.exe --remote-debugging-port=9222`，然后只做一次 WebSocket 握手，看是否弹框……~~

**已完成（见「实地复核」E）**：Edge 默认 profile 上 `--remote-debugging-port` 确实**不被忽略**（136 限制因非 Google 品牌而不生效），但日常 profile 走 `edge://inspect` 仍是 approval 模式、弹窗照旧。所以 connect.mjs 的整套 approval 规避设计**必须保留**，不能省。下面 10 条清单继续适用。

1. **把「等待授权」建模成独立状态，并复用被挂起的 socket**（收益高、可行性高）。`dsh-cdp` 的原文：「浏览器等待授权时，socket 既不 `open` 也不 `error`，只是沉默。插件给握手设了期限，把这段沉默归类成该状态。被挂起的 socket 会保留并复用：你点 Allow 后直接接管，不会另开连接（那会弹第二个授权框）。」这正是我方裸 WebSocket 挂起现象的独立佐证；即使我方坚持「只做 TCP 转发」，也应把"转发通道建立后握手无响应"与"浏览器没开调试端口"区分成两个不同状态返回给上层，避免上层重试放大弹窗。[dsh-cdp](https://dshmp.com/en/plugins/dsh-cdp)
2. **连接复用 / 唯一长连接，多会话在同一 socket 上用 flat session**（收益高、可行性中）。`dsh-cdp`、`dsh-browser-attach`、chrome-devtools-mcp 的 `--autoConnect` 文档都以「一条常驻连接」为核心；上游 issue #1794 的诉求也正是这个方向。具体技术做法已有开源先例：只连 `/devtools/browser/<uuid>`，再用 `Target.attachToTarget{flatten:true}` 的 `sessionId` 在同一 WebSocket 上复用所有 target —— 见 [sblattj/cdp-toolkit#9](https://github.com/sblattj/cdp-toolkit/pull/9)（理由是 `chrome://inspect` 开关打开后 `/json/*` 返回 404，只能走 browser socket）与 [QwenLM/qwen-code#8740](https://github.com/QwenLM/qwen-code/pull/8740)（daemon 的 `/cdp` 隧道对多客户端共享一条 Chrome 桥）。chrome-remote-interface 也支持 `sessionId`（事件名形如 `<domain>.<method>.<sessionId>`）。[issue #1794](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1794)、[CRI README](https://github.com/cyrus-and/chrome-remote-interface/blob/master/README.md)
3. **零新增工具面：把能力挂在回环 HTTP 路由 + skill 上**（收益高、可行性高，取决于产品形态）。`dsh-cdp` 明确「新增的模型可见工具 schema 是 0 个」，用法由随插件注册的 `browser-cdp` skill 承载、按需加载。对照 `xiaobai2017666/dsh-chrome-cdp` 的 11 工具 ≈ 2K tokens 常驻。我方目前把 chrome-devtools-mcp 整个工具面塞进上下文，这是最大且最容易改的一项。[dsh-cdp](https://dshmp.com/en/plugins/dsh-cdp)、[dsh-chrome-cdp README](https://github.com/xiaobai2017666/dsh-chrome-cdp)
4. **工具分组可整组关闭，关闭即零 schema 占用**（收益中、可行性高）。`xiaobai2017666/dsh-chrome-cdp` 的做法（preset 里 `groups.<name>: false` → 不注册）比"注册了再隐藏"干净；上游 chrome-devtools-mcp 的 `--categoryXxx` 与 `--slim` 是同类思路，但 attach 模式下扩展分类被硬禁，我方需要自己的分组层。[dsh-chrome-cdp](https://github.com/xiaobai2017666/dsh-chrome-cdp)、[categories.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/tools/categories.ts)
5. **路径白名单**（收益中、可行性高）。chrome-devtools-mcp 的 `--workspace` = `--filesystemRoot`（可重复、默认 OS 临时目录），并已把 `--allowUnrestrictedPaths` 标为 deprecated 指向 `--workspace=/`。我方的 `--workspace <dist>` 用法与官方语义一致，但要注意默认值本来就是「临时目录」而不是「无限制」，别把它当成开启权限的开关。[mcp-options.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/config/mcp-options.ts)
6. **错误自愈：结构化 `{error, hint}` 输出 + 声明可选 error 字段**（收益中、可行性高）。`xiaobai2017666/dsh-chrome-cdp` 让所有工具的输出 schema 都声明可选 `error`/`hint`，避免错误分支被 `additionalProperties: false` 判成 invalid output。这类"错误也是契约的一部分"能显著减少 agent 的重试噪声。[dsh-chrome-cdp README](https://github.com/xiaobai2017666/dsh-chrome-cdp)
7. **sw-N 句柄问题的可借鉴做法**（收益中、可行性中）。上游把 worker 句柄做成进程内自增（`sw-1`，重连不复用），并且 `list_pages` 的描述会随 `categoryExtensions` 变；它**不解决**「MV3 SW 睡着后不在列表里」——这是浏览器侧 target 生命周期问题，任何 MCP 都无法凭空列出睡着的 SW。真正可用的手段是浏览器级 `ServiceWorker.startWorker`（官方协议里存在，但没有 MCP 暴露它）。可行的借鉴是：列表接口对「已知但当前不在线的 SW」保留条目并附上唤醒方式，而不是让 agent 以为它不存在。[McpWorker.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/McpWorker.ts)、[tools/pages.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/tools/pages.ts)、[browser_protocol.json](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json)
8. **只做 TCP 探活不建 CDP 连接，是对的选择**（收益：确认既有设计，无需改动）。[issue #1794](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1794) 说明轮询式 CDP 连接会叠加弹窗；TCP 层探测不触发 approval。更强的旁证是 [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser/commit/9ef6c1e53627b244c9a3151f4a9af545fd3d9cdf)：它的 2 秒 verify 超时后**回退到 HTTP 发现，结果又触发了一个弹窗**，还把仍处在等待状态的 Chrome 的 `DevToolsActivePort` 文件删掉了。结论：握手挂住时**不要重试、不要回退到 HTTP 发现**，保持连接或直接把这个状态报给上层。可以把这个理由写进 README，避免后来者"顺手加个 /json 探活"。
9. **审计与状态落盘**（收益中、可行性高）。`dsh-browser-attach` 把 `audit.jsonl` / `state.json` / `daemon.pid` 写在 `~/.config/browserctl/`。对"驱动用户日常浏览器"这类高风险能力，可回溯的审计记录值得照抄。[dsh-browser-attach](https://github.com/JackAIStudio/dsh-browser-attach)
10. **上游的 design-principles 文档本身可借鉴**（收益低-中）。`Token-Optimized`（"LCP was 3.2s" 好过 50k 行 JSON）、`Reference over Value`（重资产只回文件路径）、`Self-Healing Errors` 三条可以直接作为我方工具设计的检查表。[design-principles.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/design-principles.md)

## 未解问题

1. ~~**我方实际锁的 `chrome-devtools-mcp` 版本未知**。~~ **已实测解决（见「实地复核」A）**：锁的是发布版 1.10.1，其中**不存在** `CONFLICTING_ARGS`，`--categoryExtensions` + `--wsEndpoint` 合法可用。
2. ~~**`trigger_extension_action` 真正的失败模式**：官方说返回 `Method not allowed`，我方实测是「Edge 崩溃」。两者不一致，未经证实。~~ **已实测解决（见「实地复核」C）**：有头 + WS attach 下确实 `Target closed` + 进程全灭 + 10.4 MB dump；headless 下则不崩。README 的屏蔽结论成立，且「旧版才崩」的假设不成立。
3. ~~**「attach 日常浏览器」与「用扩展工具」目前无法兼得**（上游硬限制）~~ **已实测推翻（见「实地复核」A/B）**：1.10.1 上二者兼得，扩展工具实测可调用。
4. **Edge 是否也执行 Chrome 136 的默认 profile 限制**：微软官方文档没写，但源码里该检查被 `#if BUILDFLAG(GOOGLE_CHROME_BRANDING)` 限定为非 Google 品牌默认关闭。这是**源码推断**，需要实测（见「可借鉴点」开头那条）。同时未经证实的是：Edge 是否对每条新 WebSocket 弹批准框、是否存在微软侧差异。
5. **`--remote-allow-origins` 与 approval 弹窗无关**：本调研只从源码分层推断，未找到官方文档把两者区分开的表述，标**未经证实**。
6. **「MV3 service worker 睡着后如何唤醒并列出来」**：官方协议里有 `ServiceWorker.startWorker`，但没有任何 MCP 暴露它；本次未找到解决该问题的现成实现。
7. **crbug 上的官方 roadmap**：issues.chromium.org 全站检索需登录，无法做 tracker 级全文检索。所以「没有静默方案」是**未找到**，不等于官方确认不存在。
8. **`chrome/browser/devtools/features.h`** 里的 `BASE_FEATURE` 声明只核到 `.cc`，未单独抓取 `.h`。

---

## 实地复核（2026-10-03，本机 Edge 154.0.4258.48 + 发布版 chrome-devtools-mcp 1.10.1）

本节的结论**优先于**上文任何与之冲突的表述；上文凡标注「未经证实 / 未找到」而在此已实测的项目，均以本节为准。所有测试在一次性 `--user-data-dir` 或只读命令上完成，日常 Edge 未受影响（复查：9222 仍在监听、`DevToolsActivePort` mtime 未变）。

### A. `--categoryExtensions` + attach 是合法的，上文 TL;DR 第 1、2 条不成立

- **发布版 1.10.1 的构建产物里不存在 `CONFLICTING_ARGS`**（对 npm tarball 与已安装产物同时 grep，均为 NONE）。org 内 `CONFLICTING_ARGS` 只出现在上游 **main 分支尚未发布**的代码里。
- 1.10.1 的 `EXTENSIONS` 分类选项**不带 `conflicts`**，只有 `PWA` 带 `conflicts: ['autoConnect','browserUrl','wsEndpoint']`。
- 行为对照（同一份发布版 1.10.1 入口）：
  - `--categoryPwa --wsEndpoint ws://…` → **exit 1**，stderr：`Arguments categoryPwa and wsEndpoint are mutually exclusive`
  - `--categoryExtensions --wsEndpoint ws://…` → **exit 0**，服务正常启动并打印免责声明
- 因此文档里那句「`--categoryExtensions` 目前只支持 pipe 连接」在 **1.10.1 上已过时**；不要据此改我方的参数组合。

### B. 扩展工具在 WS attach 下真的能用（与 maintainer 说法相反）

真实链路：日常 Edge（`edge://inspect` 开关 + 9222）← `--wsEndpoint ws://127.0.0.1:9222/devtools/browser/<guid>` ← `chrome-devtools-mcp 1.10.1 --categoryExtensions`。实测：

| 调用 | 结果 |
|---|---|
| `list_pages` | 返回 4 个页面 + **5 个扩展 Service Worker（`sw-1`…`sw-5`）** |
| `list_extensions` | `id=gkbloohhmkmmmdkojmkjchjhaplblpmd "BiliScript｜B站视频文摘" v2.4.0 Enabled` |
| `reload_extension` | **成功**，且 `sw` 列表随后多出 `sw-6`（证明是真实重载，不是假成功） |
| `evaluate_script{serviceWorkerId:"sw-1"}` | 成功进入 SW：返回 `{"href":"chrome-extension://bnlffdbcfnanfbknnlaflhlhkocccckg/background.js","kind":"ServiceWorkerGlobalScope"}` |

即 `Extensions.loadUnpacked` / `getExtensions` 在 WS 下可用，**没有**出现官方所称的 `Method not allowed`。注意 `evaluate_script` 在 SW 上**不能**同时传 `pageId`（会报 `specify either a pageId or a serviceWorkerId`），且 `chrome.runtime.getContexts()` 调用超时（不以 Promise 解析）。

### C. `trigger_extension_action` 确实会打崩浏览器 —— 屏蔽是对的

README 的屏蔽理由经 1.10.1 复现成立，且**与 headless/headful 强相关**：

| 场景 | 结果 |
|---|---|
| 一次性 profile + 显式端口 + **`--headless=new`** + WS attach | `Extension action triggered…` 返回成功，**12 → 12 进程**，端口仍监听，无 dump |
| 一次性 profile + 显式端口 + **有头** + WS attach | `Error: Protocol error (Extensions.triggerAction): Target closed`，**17 → 0 进程**，端口消失，Crashpad 产生 **10.4 MB** dump（与 README 记录的 ≈10 MB 完全吻合） |

根因线索：`McpContext.triggerExtensionAction(id)` → `extension.triggerAction(page)`，而 `Extensions.triggerAction` 需要 `targetId: page._tabId`；WS-attach 的页面对象上该内部字段不可靠，于是 `Target closed`。**结论：默认屏蔽 `trigger_extension_action` 必须保留**，本次不复现「旧版才崩」的假设。

### D. `--workspace` / 暴露给模型的工具面（1.10.1 实测）

```
TOOLS 34 bytes 28286    ← 34 个工具，schema 合计约 28 KB
EXT TOOLS install_extension, list_extensions, reload_extension, uninstall_extension
```
`trigger_extension_action` 被 `connect.mjs` 过滤掉，所以是 34 而非 35（未过滤时 35 个 / 28688 B）。与 README 记的「41 → 78」「约 28 KB」一致。

### E. Edge 的 approval 模式与 136 限制（实测 + 源码）

- 一次性 profile + `--remote-debugging-port=9333` → `/json/version` **200**（kDefault，无弹窗）
- 日常 profile + `edge://inspect` 开关 → `/json/version` **404**（approval 模式）
- `README` 的结论成立：`--remote-debugging-port` 在 Edge 默认 profile 上**不会被忽略**（`IsRemoteDebuggingAllowed` 里的默认目录检查被 `#if BUILDFLAG(GOOGLE_CHROME_BRANDING)` 限定，L169-174），但日常 profile 走 `edge://inspect` 仍是 approval 模式，弹窗照旧。

### F. 架构层的取舍结论

- **扩展桥类路线（BrowserRig、pi-control-chrome、dsh-bib、hangwin/mcp-chrome 等）不适用于本场景**：它们的桥扩展用 `chrome.debugger.attach` 只能调试**自己**能访问的 tab，Chrome 官方明确「Attaching to an extension background page is only possible when the `--silent-debugger-extension-api` switch is used」，且对 `chrome-extension://` 的**其它扩展**页面会报 `Cannot access a chrome-extension:// URL of different extension`。而本场景要调试的是**自己的扩展**（BiliScript）的 SW/扩展页，走 browser 级 CDP attach 才是正路 —— 我方路线正确。
- **`dougen/dsh-cdp` 的两点仍是最值得借鉴的**：唯一常驻连接避免重复弹窗、以及「等待授权」独立状态 + 复用被挂起的 socket。但它**不覆盖扩展调试**（`console`/`network` 都「accepted but capture nothing」，也没有扩展工具），所以它可作为「连接层」的参考，不能作为本场景的替代品。
- **浏览器级扩展管理只有 `Extensions` domain**：`getExtensions` 只覆盖 **unpacked** 扩展，且 domain 里**没有 reload 命令**——`reload_extension` 是靠重新 `loadUnpacked(extension.path)` 实现的（源码已核）。`ServiceWorker.startWorker` 是唤醒睡着 SW 的正规手段，但无任何 MCP 暴露。
