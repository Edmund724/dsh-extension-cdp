#!/usr/bin/env node
// dsh-cdp 包装脚本：把 DSH 的 chrome-devtools-mcp 客户端 attach 到你正在跑的 Edge。
//
// 契约：stdout 只允许出现 MCP 帧（换行分隔的 JSON-RPC），所有诊断一律走 stderr。
//
// 为什么需要这层包装：
// 1. DevToolsActivePort 的 guid 每次重开 edge://inspect 开关都会变，端点必须每次重读；
// 2. 关掉开关后文件还在，必须自己探活端口；
// 3. chrome-devtools-mcp 不校验端点（死端点上 initialize 也会"成功"），只有 tools/call
//    才报 ECONNREFUSED，所以校验只能前置到这里；
// 4. trigger_extension_action 在 attach 模式下会把 Edge 整个打崩，默认屏蔽。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import {
  checkTcp,
  readDevToolsActivePort,
  resolveWsUrl,
} from './lib/endpoint.mjs';
import { findMcpEntry } from './lib/mcp-entry.mjs';
import { createLineSplitter, filterClientLine, filterServerLine, parseBlockedTools } from './lib/filter.mjs';
import { buildServerArgs } from './lib/args.mjs';

const DEFAULT_USER_DATA_DIR = () =>
  path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Edge', 'User Data');

function die(message) {
  process.stderr.write(`[dsh-cdp] ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stderr.write(`[dsh-cdp] ${message}\n`);
}

function readConfig(env = process.env) {
  const userDataDir = env.DSH_CDP_USER_DATA_DIR || DEFAULT_USER_DATA_DIR();
  const portFile = env.DSH_CDP_PORT_FILE || path.join(userDataDir, 'DevToolsActivePort');
  const parsedTimeout = Number(env.DSH_CDP_PROBE_TIMEOUT_MS ?? 5000);
  return {
    portFile,
    host: env.DSH_CDP_HOST || '127.0.0.1',
    probeTimeoutMs: Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 5000,
    blocked: parseBlockedTools(env.DSH_CDP_BLOCKED_TOOLS),
    searchDirs: String(env.DSH_CDP_MCP_SEARCH_DIRS ?? '')
      .split(path.delimiter)
      .map((dir) => dir.trim())
      .filter((dir) => dir !== ''),
  };
}

// 从端口文件位置推断候选目录：user data 目录本身，以及它下面的 Default / Profile N。
function profileSearchDirs(portFile) {
  const dirs = [path.dirname(portFile)];
  try {
    for (const entry of fs.readdirSync(path.dirname(portFile), { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name))) {
        dirs.push(path.join(path.dirname(portFile), entry.name));
      }
    }
  } catch {
    // 读不到就算了，后面还有别的候选目录
  }
  return dirs;
}

// ws 只在运行时动态解析：从 chrome-devtools-mcp 的 bin 入口出发找它自己装的 ws。
// 解析不到就降级（只做 TCP 校验），绝不写进 dependencies。
async function loadWebSocket(entry) {
  const require = createRequire(entry);
  const wsPath = require.resolve('ws');
  const mod = await import(pathToFileURL(wsPath).href);
  return mod?.default ?? mod?.WebSocket ?? mod;
}

// 手写 WebSocket 升级握手在这个 server 上无响应，必须用 ws 包发 Browser.getVersion。
function probeBrowser({ WebSocket, wsUrl, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    let timer;
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // 已经关了
      }
      resolve(result);
    };

    timer = setTimeout(() => done({ ok: false, error: `Browser.getVersion 超时（${timeoutMs}ms）` }), timeoutMs);
    try {
      socket = new WebSocket(wsUrl);
    } catch (err) {
      done({ ok: false, error: err?.message ?? String(err) });
      return;
    }
    socket.on('open', () => {
      try {
        socket.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
      } catch (err) {
        done({ ok: false, error: err?.message ?? String(err) });
      }
    });
    socket.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg && msg.id === 1) {
        if (msg.result) done({ ok: true, product: msg.result.product });
        else done({ ok: false, error: msg.error?.message ?? 'Browser.getVersion 返回了错误' });
      }
    });
    socket.on('error', (err) => done({ ok: false, error: err?.message ?? String(err) }));
    socket.on('close', () => done({ ok: false, error: 'WebSocket 在收到 Browser.getVersion 响应前就关闭了' }));
  });
}

function startProxy({ entry, wsUrl, blocked }) {
  const args = buildServerArgs({ entry, wsUrl, extraArgs: process.argv.slice(2) });
  log(`启动 chrome-devtools-mcp：${process.execPath} ${args.join(' ')}`);

  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    try {
      child.kill();
    } catch {
      // 子进程可能已经退出
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
  process.on('beforeExit', stop);
  process.stdin.on('error', stop);
  process.stdin.on('end', () => {
    try {
      child.stdin.end();
    } catch {
      // 子进程可能已经退出
    }
  });

  const clientSplitter = createLineSplitter();
  process.stdin.on('data', (chunk) => {
    for (const line of clientSplitter.push(chunk.toString('utf8'))) {
      const verdict = filterClientLine(line, blocked);
      if (verdict.forward) child.stdin.write(`${line}\n`);
      else if (verdict.reply) process.stdout.write(`${verdict.reply}\n`);
    }
  });

  const serverSplitter = createLineSplitter();
  const writeServerLine = (line) => process.stdout.write(`${filterServerLine(line, blocked)}\n`);
  child.stdout.on('data', (chunk) => {
    for (const line of serverSplitter.push(chunk.toString('utf8'))) writeServerLine(line);
  });
  child.stdout.on('end', () => {
    for (const line of serverSplitter.flush()) writeServerLine(line);
  });

  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.on('error', (err) => die(`启动 chrome-devtools-mcp 失败：${err?.message ?? err}`));
  child.on('exit', (code) => process.exit(code ?? 0));

  log(`已挂上 chrome-devtools-mcp，屏蔽工具：${blocked.length > 0 ? blocked.join(', ') : '（无）'}`);
}

async function main() {
  const env = process.env;
  const cfg = readConfig(env);

  let active;
  try {
    active = readDevToolsActivePort(cfg.portFile);
  } catch (err) {
    die(err?.message ?? String(err));
  }

  const wsUrl = resolveWsUrl({ host: cfg.host, port: active.port, path: active.path });
  log(`DevToolsActivePort：${cfg.host}:${active.port}${active.path}`);

  const alive = await checkTcp({ host: cfg.host, port: active.port, timeoutMs: cfg.probeTimeoutMs });
  if (!alive) {
    die(
      `DevToolsActivePort 是旧的：${cfg.host}:${active.port} 没有在监听。\n` +
        '去 Edge 的 edge://inspect 打开 "Allow remote debugging for this browser instance"，然后重试。',
    );
  }

  const found = findMcpEntry({ env, searchDirs: [...cfg.searchDirs, ...profileSearchDirs(cfg.portFile)] });
  if (found.error) die(found.error);
  const entry = found.entry;
  log(`chrome-devtools-mcp 入口：${entry}`);

  let WebSocket = null;
  try {
    WebSocket = await loadWebSocket(entry);
  } catch (err) {
    log(`解析不到 ws 包（${err?.message ?? err}），跳过 WebSocket 校验，只保留 TCP 校验继续启动。`);
  }
  if (WebSocket) {
    const probe = await probeBrowser({ WebSocket, wsUrl, timeoutMs: cfg.probeTimeoutMs });
    if (!probe.ok) {
      die(
        `连不上 DevTools WebSocket ${wsUrl}：${probe.error}\n` +
          '去 Edge 的 edge://inspect 重新打开 "Allow remote debugging for this browser instance"，然后重试。',
      );
    }
    log(`已确认浏览器：${probe.product}`);
  }

  startProxy({ entry, wsUrl, blocked: cfg.blocked });
}

main().catch((err) => die(`未预期的错误：${err?.stack ?? err}`));
