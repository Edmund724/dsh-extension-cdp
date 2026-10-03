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
//
// 只准探端口，不准自己建 CDP 连接：日常 profile 走的是 Chromium 的 approval 模式
// （RemoteDebuggingServerMode::kWithApprovalOnly），**每一条新的 WebSocket 连接都会让
// Edge 弹一次"是否允许远程调试？"要用户手点**。这里多连一次，用户就要多点一次，
// 所以校验止步于 TCP，真正那条连接留给 chrome-devtools-mcp 唯一的一次。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  checkTcp,
  readDevToolsActivePort,
  resolveWsUrl,
} from './lib/endpoint.mjs';
import { findMcpEntry, dshProfileDirs } from './lib/mcp-entry.mjs';
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

  // 入口候选目录：显式 env > DSH 自己的 profile 目录树（拿不到 DSH_* 时唯一可靠的路）>
  // 端口文件旁的目录。
  const found = findMcpEntry({
    env,
    searchDirs: [...cfg.searchDirs, ...dshProfileDirs({ env }), ...profileSearchDirs(cfg.portFile)],
  });
  if (found.error) die(found.error);
  const entry = found.entry;
  log(`chrome-devtools-mcp 入口：${entry}`);

  startProxy({ entry, wsUrl, blocked: cfg.blocked });
}

main().catch((err) => die(`未预期的错误：${err?.stack ?? err}`));
