// 工具面裁剪（混合面）：默认只把扩展调试真正要用的几个工具直接列出来，其余 30 个通用浏览器
// 工具全部收进一个 cdp_call 元工具后面。动机见 docs/tool-surface.md：chrome-devtools-mcp 的 tools/list
// 实测 35 个工具 / 28,688 字节，其中扩展类只占 1.9 KB，93% 的常驻 schema 是通用浏览器工具。
//
// 两条正交的规则，别混：
//   - **裁剪 = 可见性**：被裁掉的工具只是不出现在 tools/list 里，直接调用仍然放行（会话历史里
//     的工具名不该因为改了裁剪配置就突然调不动）。
//   - **屏蔽 = 安全**：DSH_CDP_BLOCKED_TOOLS 里的工具是硬拦（lib/filter.mjs，本地回 -32601），
//     cdp_call 也绕不过去（connect.mjs 在翻译之后再过一次那道闸门）。
//
// 元工具存在的意义是"兜底 + 自描述"：它把上游全部工具名写进自己的 description，模型不认识
// 名字时可以用 schema:true 只取入参 schema —— 那 28 KB 就只在真的要调某个工具时才进上下文。
export const META_TOOL_NAME = 'cdp_call';

// 默认直出的工具：扩展调试的常规路径（列扩展 / 重载 / 列 target / 选中 sw-N / 求值）。
export const DEFAULT_RESIDENT = Object.freeze([
  'list_extensions',
  'reload_extension',
  'list_pages',
  'select_page',
  'evaluate_script',
]);

const ALL = 'all';
const NONE = 'none';

// 环境变量 -> 裁剪配置。resident === null 表示"不裁剪"（回到没这个功能时的行为）。
export function parseToolSurface(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { resident: [...DEFAULT_RESIDENT], metaTool: true };
  }
  const raw = String(value).trim();
  if (raw.toLowerCase() === ALL) return { resident: null, metaTool: false };
  if (raw.toLowerCase() === NONE) return { resident: [], metaTool: true };
  const resident = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return { resident, metaTool: true };
}

export function metaToolDefinition(availableNames = []) {
  const list = availableNames.join(', ');
  return {
    name: META_TOOL_NAME,
    description:
      'Call any chrome-devtools-mcp tool. Only the commonly used ones are listed as their own ' +
      'tools; everything else goes through here. Pass the upstream tool name in `name` and its ' +
      'arguments in `arguments`; pass `schema: true` (without arguments) to get just that ' +
      "tool's input schema first." +
      (list === '' ? '' : ` Available tools: ${list}.`),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Upstream chrome-devtools-mcp tool name.' },
        arguments: { type: 'object', description: 'Arguments for that tool; omitted means {}.' },
        schema: { type: 'boolean', description: 'true = return that tool input schema only, do not run it.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  };
}

const resultReply = (id, text, isError = false) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text }] },
  });

const isObject = (value) => typeof value === 'object' && value !== null;

export function createToolSurface({ resident = null, metaTool = false, blocked = [] } = {}) {
  // 上游报过哪些工具（含被屏蔽的：被屏蔽的名字要能走到 filter.mjs 那道闸门，
  // 而不是被这里误报成"不存在"）。
  const upstreamNames = new Set();
  const upstreamTools = new Map();
  let seen = false;

  const availableNames = () => [...upstreamNames].filter((name) => !blocked.includes(name));

  const unknownNameMessage = (name) =>
    `chrome-devtools-mcp has no tool named "${name}". Available tools: ${availableNames().join(', ')}.`;

  return {
    rewriteServerLine(line) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return line;
      }
      const tools = msg?.result?.tools;
      if (!Array.isArray(tools)) return line;

      for (const tool of tools) {
        if (isObject(tool) && typeof tool.name === 'string') {
          upstreamNames.add(tool.name);
          upstreamTools.set(tool.name, tool);
        }
      }
      seen = true;
      // 不裁剪：原样返回，但清单还是要记下来（诊断要知道上游到底报了多少个工具）。
      if (resident === null) return line;

      const kept = tools.filter(
        (tool) => isObject(tool) && resident.includes(tool.name) && !blocked.includes(tool.name),
      );
      const next = metaTool ? [...kept, metaToolDefinition(availableNames())] : kept;
      return JSON.stringify({ ...msg, result: { ...msg.result, tools: next } });
    },

    rewriteClientLine(line) {
      if (resident === null) return { forward: line, reply: null };
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return { forward: line, reply: null };
      }
      if (!isObject(msg) || msg.method !== 'tools/call' || msg?.params?.name !== META_TOOL_NAME) {
        return { forward: line, reply: null };
      }

      const params = isObject(msg.params.arguments) ? msg.params.arguments : {};
      const inner = params.name;
      if (typeof inner !== 'string' || inner === '') {
        return {
          forward: null,
          reply: resultReply(
            msg.id,
            seen
              ? `${META_TOOL_NAME} needs a string "name". Available tools: ${availableNames().join(', ')}.`
              : `${META_TOOL_NAME} needs a string "name" (an upstream chrome-devtools-mcp tool name).`,
            true,
          ),
        };
      }
      // 还没收到上游 tools/list 时不拦：宁可让上游自己报错，也不猜。
      if (!seen) return { forward: line, reply: null };
      if (!upstreamNames.has(inner)) {
        return { forward: null, reply: resultReply(msg.id, unknownNameMessage(inner), true) };
      }
      if (params.schema === true) {
        const tool = upstreamTools.get(inner);
        return { forward: null, reply: resultReply(msg.id, JSON.stringify(tool?.inputSchema ?? {})) };
      }

      const innerArgs = isObject(params.arguments) ? params.arguments : {};
      return {
        forward: JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          method: 'tools/call',
          params: { name: inner, arguments: innerArgs },
        }),
        reply: null,
      };
    },

    // 给上层的诊断用：现在直出哪些、白名单里哪些上游没有。
    // 还没收到过 tools/list 时一律报空 —— 那时我们并不知道上游有什么，不能假装知道。
    exposure() {
      if (!seen) return { seen: false, resident: [], missing: [], meta: resident !== null && metaTool };
      const present = resident === null ? availableNames() : resident.filter((name) => upstreamNames.has(name));
      return {
        seen: true,
        resident: present,
        missing: resident === null ? [] : resident.filter((name) => !upstreamNames.has(name)),
        meta: resident !== null && metaTool,
      };
    },
  };
}
