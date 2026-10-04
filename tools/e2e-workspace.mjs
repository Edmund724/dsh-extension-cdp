#!/usr/bin/env node
// 端到端：DSH_CDP_WORKSPACES 给出的目录，是不是真的能成为 take_screenshot 的落盘位置。
//
// 不碰你日常那个 Edge：自己起一个 headless、独立 user-data-dir 的 Edge（走 --remote-debugging-port，
// 默认模式，不会弹「是否允许远程调试」），再把 connect.mjs 接上去，全程走 MCP 协议。
//
// 先列失败方式（据此断言）：
// 1. DSH_CDP_WORKSPACES 没被翻译成 --workspace：白名单里的目录仍被拒（isError + "not within any of the
//    configured workspace roots"）；
// 2. 对照组（不给这个变量）本该被拒 —— 若它写成功了，说明被测的那条断言并不能证明是白名单起的作用；
// 3. 白名单把不该放的也放了：白名单目录之外的路径竟然写成功了；
// 4. 落盘的产物不是 PNG（页面接错/端点接错，或文件写到了别处）。
//
// 用法：node tools/e2e-workspace.mjs [--out <目录>] [--edge <msedge.exe>] [--keep]
//
// 白名单目录刻意**不放在系统临时目录里**（临时目录本来就是上游永远允许的根），默认是仓库下的
// `.e2e/workspace`（已 gitignore）；对照组就是"同一个目录、不给 DSH_CDP_WORKSPACES"。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { findMcpEntry, dshProfileDirs } from '../lib/mcp-entry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONNECT = path.join(HERE, '..', 'connect.mjs');
const DEFAULT_EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const DENIED_RE = /not within any of the configured workspace roots/;

function parseArgs(argv) {
  const out = { out: path.join(HERE, '..', '.e2e'), edge: DEFAULT_EDGE, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--edge') out.edge = argv[++i];
    else if (argv[i] === '--keep') out.keep = true;
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 100, what = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await sleep(intervalMs);
  }
}

function startHeadlessEdge(edgePath, profileDir) {
  const child = spawn(
    edgePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  return { child, stderr: () => stderr };
}

// 一个最小的 MCP 客户端：给 connect.mjs 的 stdin 写帧、读 stdout 的帧。
function startAgent({ entry, portFile, workspaces, clientName }) {
  const child = spawn(process.execPath, [CONNECT, '--no-usage-statistics', '--categoryExtensions'], {
    env: {
      ...process.env,
      DSH_CDP_MCP_ENTRY: entry,
      DSH_CDP_PORT_FILE: portFile,
      DSH_CDP_PROBE_TIMEOUT_MS: '5000',
      DSH_CDP_APPROVAL_HINT_MS: '0',
      DSH_CDP_WORKSPACES: workspaces,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const messages = [];
  let buffered = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    let index;
    while ((index = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (line !== '') messages.push(JSON.parse(line));
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  let nextId = 1;
  const call = async (method, params, timeoutMs = 60000) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return waitFor(() => messages.find((message) => message.id === id), {
      timeoutMs,
      what: `${method} 的响应（connect.mjs stderr 末尾：${stderr.slice(-1500)}）`,
    });
  };

  return {
    async open() {
      await call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: clientName, version: '1.0.0' },
      });
      await call('tools/list', {}); // 元工具要先见过上游清单才敢翻译
      const text = textOf(await call('tools/call', { name: 'list_pages', arguments: {} }));
      const match = text.match(/^\s*(\d+):/m);
      if (!match) throw new Error(`list_pages 里找不到 pageId，原文：\n${text}`);
      return Number(match[1]);
    },
    shoot: (pageId, filePath) =>
      call('tools/call', { name: 'cdp_call', arguments: { name: 'take_screenshot', arguments: { pageId, filePath } } }),
    stop: () => {
      try {
        child.kill();
      } catch {
        // 进程可能已经退出
      }
    },
    stderr: () => stderr,
  };
}

function textOf(reply) {
  return (reply?.result?.content ?? []).map((part) => part.text ?? '').join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.edge)) {
    console.error(`找不到 Edge：${args.edge}（用 --edge <msedge.exe> 指定）`);
    process.exit(3);
  }
  const found = findMcpEntry({ env: process.env, searchDirs: dshProfileDirs({}) });
  if (found.error) {
    console.error(found.error);
    process.exit(3);
  }

  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cdp-e2e-run-'));
  const profileDir = path.join(runDir, 'edge-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  const allowedDir = path.join(args.out, 'workspace');
  const outsideDir = path.join(os.homedir(), 'dsh-cdp-e2e-outside');
  // 每次从干净状态开始：否则上一次留下的 shot.png 会让"文件不存在"那几条断言失去意义。
  fs.rmSync(allowedDir, { recursive: true, force: true });
  fs.mkdirSync(allowedDir, { recursive: true });

  const artifact = path.join(allowedDir, 'shot.png');
  const controlArtifact = path.join(allowedDir, 'shot-without-workspace.png');
  const outsideArtifact = path.join(outsideDir, 'shot.png');
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  };

  let edge;
  let agent;
  let control;
  try {
    console.log(`chrome-devtools-mcp 入口：${found.entry}`);
    console.log(`白名单目录：${allowedDir}`);
    edge = startHeadlessEdge(args.edge, profileDir);
    const portFile = path.join(profileDir, 'DevToolsActivePort');
    await waitFor(
      () => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').trim().split('\n').length >= 2,
      { timeoutMs: 40000, what: `Edge 写出 DevToolsActivePort（stderr: ${edge.stderr().slice(-1500)}）` },
    );

    // 处理组：给了 DSH_CDP_WORKSPACES。
    agent = startAgent({ entry: found.entry, portFile, workspaces: allowedDir, clientName: 'cdp-e2e-workspace' });
    const pageId = await agent.open();

    const shot = await agent.shoot(pageId, artifact);
    const shotText = textOf(shot);
    const saved = !shot.result?.isError && /Saved screenshot/.test(shotText) && fs.existsSync(artifact);
    check('白名单目录里的 filePath 写盘成功', saved, shotText.trim().slice(0, 400));
    const bytes = fs.existsSync(artifact) ? fs.readFileSync(artifact) : Buffer.alloc(0);
    check(
      '产物是 PNG',
      bytes.length > 8 && bytes.subarray(0, 4).equals(PNG_MAGIC),
      `${artifact} → ${bytes.length} 字节，sha256 ${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    );

    const outside = await agent.shoot(pageId, outsideArtifact);
    const outsideText = textOf(outside);
    check(
      '白名单之外的路径仍然被拒',
      outside.result?.isError === true && DENIED_RE.test(outsideText) && !fs.existsSync(outsideArtifact),
      outsideText.slice(0, 400),
    );
    agent.stop();

    // 对照组：不给 DSH_CDP_WORKSPACES，同一个目录必须被拒（否则上面的 PASS 说明不了什么）。
    control = startAgent({ entry: found.entry, portFile, workspaces: '', clientName: 'cdp-e2e-control' });
    const controlPageId = await control.open();
    const controlShot = await control.shoot(controlPageId, controlArtifact);
    const controlText = textOf(controlShot);
    check(
      '对照组（DSH_CDP_WORKSPACES 为空）同一个目录被拒',
      controlShot.result?.isError === true && DENIED_RE.test(controlText) && !fs.existsSync(controlArtifact),
      controlText.slice(0, 400),
    );
  } finally {
    // 失败时把 connect.mjs 的 stderr 留下来，省得再跑一遍
    if (results.some((result) => !result.ok) && agent) {
      console.error(`\nconnect.mjs stderr 末尾：\n${agent.stderr().slice(-3000)}`);
    }
    agent?.stop();
    control?.stop();
    try {
      edge?.child.kill();
    } catch {
      // 可能已经退出
    }
    if (!args.keep) {
      await sleep(500);
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (fs.existsSync(artifact)) {
    const bytes = fs.readFileSync(artifact);
    console.log(
      `工件：${artifact}\n  ${bytes.length} 字节，sha256 ${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    );
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`e2e 失败：${err?.stack ?? err}`);
  process.exit(1);
});
