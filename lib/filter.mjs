// MCP 帧的按行解析与工具屏蔽。
// MCP stdio 的帧格式是换行分隔的 JSON-RPC（每行一条消息），所以行缓冲必须自己管。
const DEFAULT_BLOCKED = 'trigger_extension_action';

// 逗号分隔 -> 去空白 -> 去空项。undefined/null 落默认值，空串表示不过滤。
export function parseBlockedTools(value) {
  const raw = value === undefined || value === null ? DEFAULT_BLOCKED : String(value);
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

const stripCr = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line);

// 行缓冲：正确处理跨 chunk 的半行、一个 chunk 多行、CRLF、以及结尾没有换行。
export function createLineSplitter() {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const out = [];
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = stripCr(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        if (line.trim() !== '') out.push(line);
        idx = buffer.indexOf('\n');
      }
      return out;
    },
    flush() {
      const rest = stripCr(buffer);
      buffer = '';
      return rest.trim() === '' ? [] : [rest];
    },
  };
}

// 出方向（子进程 stdout -> 我们的 stdout）：tools/list 结果里删掉被屏蔽的工具。
// 解析失败或结构不符一律原样透传，绝不猜。
export function filterServerLine(line, blocked = []) {
  if (!Array.isArray(blocked) || blocked.length === 0) return line;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return line;
  }
  if (!msg || typeof msg !== 'object') return line;
  const tools = msg?.result?.tools;
  if (!Array.isArray(tools)) return line;

  const kept = tools.filter((tool) => !(tool && blocked.includes(tool.name)));
  if (kept.length === tools.length) return line;
  return JSON.stringify({ ...msg, result: { ...msg.result, tools: kept } });
}

// 入方向（我们的 stdin -> 子进程 stdin）：被屏蔽工具的 tools/call 不转发，本地回一条 error。
export function filterClientLine(line, blocked = []) {
  if (!Array.isArray(blocked) || blocked.length === 0) return { forward: true };
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return { forward: true };
  }
  if (!msg || typeof msg !== 'object' || msg.method !== 'tools/call') return { forward: true };

  const name = msg?.params?.name;
  if (typeof name !== 'string' || !blocked.includes(name)) return { forward: true };

  return {
    forward: false,
    reply: JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `tool '${name}' is disabled by dsh-extension-cdp` },
    }),
  };
}
