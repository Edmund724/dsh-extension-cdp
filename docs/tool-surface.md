# 工具面：默认只直出常用几个，其余走 `cdp_call`

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
