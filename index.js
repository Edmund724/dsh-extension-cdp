// Host 半侧：给 client.js 的配置页一个读写"落盘白名单"的桥。
//
// 为什么要有这个桥：白名单最终必须变成 MCP 子进程 env 里的 DSH_CDP_WORKSPACES —— 那是
// connect.mjs 唯一读的位置，也是唯一能让 chrome-devtools-mcp 收到 --workspace 的通道。
// 而 @deepseek-ai/dsh-settings 的表单只能编辑插件 Config 里标了 .volatile() 的字段，
// dsh-mcp-client 一个都没有，所以标准表单填不进这一行；官方给"编辑完整配置的调用方"留的
// 入口是 ctx.configEditor.edit()，这里就用它：把值写进 profile patch 里 MCP 那一行的 config。
//
// 写进去的是什么：完整的 raw config（configEditor 的要求，普通字段会被固定在当前值上），
// 但值里的 `!!js` 表达式会原样保留（configEditor 把 {__jsExpr} 节点还原成 !!js 标量），
// 所以 args[0] / command / DSH_CDP_MCP_SEARCH_DIRS 这些仍跟着环境变，不会写死本机路径。
// 写完 Loader 会重组那一行 —— MCP 子进程重启，新白名单立刻生效。
import fs from 'node:fs';
import path from 'node:path';

import { formatWorkspaces, normalizeWorkspaces, splitPathList } from './lib/workspaces.mjs';

// client.js 与这里必须一致：路由前缀 + 被写的那一行的 id + 那个 env 名。
const BRIDGE_PREFIX = '/api/dsh-extension-cdp/workspaces';
const MCP_ROW_ID = 'dsh-extension-cdp';
const ENV_KEY = 'DSH_CDP_WORKSPACES';
const MAX_JSON_BODY_BYTES = 64 * 1024;

function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

// MCP 那一行按 id 找：它由本包的 patch 插入，profile 根 include 拥有、id 唯一，
// 正是 configEditor 能寻址的那种条目。
function mcpRow(configEditor) {
  const entry = configEditor.entries().find((candidate) => candidate.options.id === MCP_ROW_ID);
  if (entry === undefined) return { error: { code: 'row-missing', message: `找不到 id 为 ${MCP_ROW_ID} 的插件行` } };
  if (entry.fiber === undefined || entry.fiber.state !== 2) {
    return { error: { code: 'row-inactive', message: `${MCP_ROW_ID} 这一行没在运行：先到插件页把它打开` } };
  }
  return { entry };
}

// 生效值：读那一行已经解析过的 config（`!!js` 求值之后），也就是子进程真的会收到的东西。
function effectiveDirs(entry) {
  return splitPathList(entry.fiber?.config?.env?.[ENV_KEY] ?? '');
}

function overrideOf(configEditor, entry) {
  const row = configEditor.configuration().find((candidate) => candidate.entry === entry);
  return row !== undefined && Object.keys(row.override ?? {}).length > 0;
}

function describeRow(configEditor) {
  const { entry, error } = mcpRow(configEditor);
  if (error !== undefined) return { ok: false, ...error };
  const dirs = effectiveDirs(entry);
  return {
    ok: true,
    value: {
      dirs,
      text: formatWorkspaces(dirs),
      // 白名单里已经不存在的目录：上游 realpath 会直接让那次调用失败，页面上先标出来。
      missing: dirs.filter((dir) => !isDirectory(dir)),
      // profile 覆盖存在 = 这一行的 config 被固定在这一层（"清除覆盖"才有意义）。
      overridden: overrideOf(configEditor, entry),
      delimiter: path.delimiter,
    },
  };
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function handlerFor(configEditor, action) {
  return async (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, code: 'loopback-only' });
      return;
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'post-only' });
      return;
    }
    const body = action === 'describe' ? {} : await readJsonBody(req);
    if (body === undefined) {
      writeJson(res, 400, { ok: false, code: 'malformed-json' });
      return;
    }
    try {
      writeJson(res, 200, await run(configEditor, action, body));
    } catch (error) {
      writeJson(res, 200, { ok: false, code: 'write-failed', message: error?.message ?? String(error) });
    }
  };
}

async function run(configEditor, action, body) {
  const { entry, error } = mcpRow(configEditor);
  if (error !== undefined) return { ok: false, ...error };

  if (action === 'describe') return describeRow(configEditor);

  // 清除覆盖：返回下层组合结果，configEditor 会把 profile patch 里这一段整段删掉，
  // 那一行回到 bundle 的默认值（`!!js process.env.DSH_CDP_WORKSPACES || ''`）。
  if (action === 'reset') {
    await configEditor.edit(entry, (_raw, inherited) => inherited);
    return describeRow(configEditor);
  }

  const { dirs, invalid } = normalizeWorkspaces(Array.isArray(body.dirs) ? body.dirs : String(body.text ?? ''));
  // 一条不合法就整体拒绝：宁可什么都不写，也不要留下一半白名单。
  if (invalid.length > 0) return { ok: false, code: 'invalid-dirs', invalid };

  await configEditor.edit(entry, (raw) => ({
    ...raw,
    env: { ...(raw.env ?? {}), [ENV_KEY]: dirs.join(path.delimiter) },
  }));
  return describeRow(configEditor);
}

export function apply(ctx) {
  // 只注册在真正有 Web 服务与配置编辑器的组合里；headless/CLI 下这一行照常加载，
  // 白名单仍可走 DSH_CDP_WORKSPACES 环境变量这条老路。
  ctx.inject(['webServer', 'configEditor'], (sctx) => {
    sctx.effect(() => {
      const disposers = ['describe', 'save', 'reset'].map((action) =>
        sctx.webServer.register({
          kind: 'exact',
          path: `${BRIDGE_PREFIX}/${action}`,
          handler: handlerFor(sctx.configEditor, action),
        }),
      );
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'dsh-extension-cdp: workspaces bridge');
  });
}
