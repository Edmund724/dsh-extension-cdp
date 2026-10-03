// connect.mjs 端到端：代理、过滤，以及"只探端口、不建 CDP 连接"这条不变量。
//
// 先列失败方式（为什么这几条要测）：
// 1. 包装脚本自己建一条 CDP/WebSocket 连接 —— 日常 profile 是 approval 模式，每多一条
//    连接用户就要多点一次"是否允许远程调试？"的弹窗，所以探活必须止步于 TCP：本测试用一个
//    记录字节数的假服务端口断言"一个字节都没收到"。
// 2. 屏蔽工具没从 tools/list 里删掉 / 删错别的工具；
// 3. 对屏蔽工具的 tools/call 被转发给了子进程（而不是本地回 -32601）——那正是会把 Edge 打崩的调用；
// 4. 正常工具被误伤（没转发 / 响应没透传）；
// 5. 子进程的 --wsEndpoint 没拼出来（端点发现与拼装串不起来）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONNECT = path.join(HERE, '..', 'connect.mjs');
const GUID = 'b03526d4-53c6-40ac-9bac-fc0d0eef1e42';

// 子进程替身：一个会说 MCP 的假 server，把收到的 tools/call 参数原样回声，
// 并把 --wsEndpoint 的值记到 env 指定的文件里（证明参数确实传到了）。
const FAKE_SERVER = `
import fs from 'node:fs';
import { createInterface } from 'node:readline';
const argv = process.argv.slice(2);
const wsIndex = argv.indexOf('--wsEndpoint');
if (process.env.FAKE_ARGV_FILE) fs.writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(argv));
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'list_extensions' }, { name: 'list_pages' }, { name: 'trigger_extension_action' }] } });
  } else if (msg.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + msg.params.name }] } });
  }
});
`;

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (err) {
        reject(err);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('等待超时'));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// 起一套沙箱：记录字节的假端口 + 假 MCP server + 临时 DevToolsActivePort。
async function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cdp-proxy-'));
  const fakeServer = path.join(dir, 'fake-server.mjs');
  const argvFile = path.join(dir, 'argv.json');
  fs.writeFileSync(fakeServer, FAKE_SERVER);

  const bytes = [];
  const connections = [];
  const server = net.createServer((socket) => {
    connections.push(socket);
    socket.on('data', (chunk) => bytes.push(chunk));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const portFile = path.join(dir, 'DevToolsActivePort');
  fs.writeFileSync(portFile, `${port}\n/devtools/browser/${GUID}\n`);

  return {
    dir,
    port,
    portFile,
    fakeServer,
    argvFile,
    bytes,
    connections,
    async cleanup() {
      for (const socket of connections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function startConnect(box) {
  const child = spawn(process.execPath, [CONNECT, '--no-usage-statistics', '--categoryExtensions'], {
    env: {
      ...process.env,
      DSH_CDP_PORT_FILE: box.portFile,
      DSH_CDP_MCP_ENTRY: box.fakeServer,
      DSH_CDP_PROBE_TIMEOUT_MS: '2000',
      FAKE_ARGV_FILE: box.argvFile,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const messages = [];
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => {
    out += chunk.toString('utf8');
    let index;
    while ((index = out.indexOf('\n')) !== -1) {
      const line = out.slice(0, index).trim();
      out = out.slice(index + 1);
      if (line === '') continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        messages.push({ unparsable: line });
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    err += chunk.toString('utf8');
  });

  let nextId = 1;
  const send = (method, params) => {
    const id = nextId;
    nextId += 1;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return id;
  };
  const reply = (id) => messages.find((m) => m.id === id);

  return { child, messages, send, reply, stderr: () => err };
}

test('connect.mjs: 只探端口就转发，且屏蔽工具不外泄', async () => {
  const box = await sandbox();
  const client = startConnect(box);
  try {
    const initId = client.send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });
    const init = await waitFor(() => client.reply(initId), { timeoutMs: 15000 });
    assert.equal(init.result.serverInfo.name, 'fake', `initialize 未透传：${client.stderr()}`);

    const listId = client.send('tools/list', {});
    const list = await waitFor(() => client.reply(listId), { timeoutMs: 15000 });
    assert.deepEqual(
      list.result.tools.map((tool) => tool.name),
      ['list_extensions', 'list_pages'],
      'tools/list 应当只删掉被屏蔽的那个工具',
    );

    // 被屏蔽的工具：本地回 -32601，绝不转发给子进程（转发就会把 Edge 打崩）。
    const blockedId = client.send('tools/call', { name: 'trigger_extension_action', arguments: {} });
    const blocked = await waitFor(() => client.reply(blockedId), { timeoutMs: 15000 });
    assert.equal(blocked.error.code, -32601);
    assert.match(blocked.error.message, /trigger_extension_action/);

    // 正常工具：必须原样转发并透传结果（证明没误伤）。
    const echoId = client.send('tools/call', { name: 'list_extensions', arguments: {} });
    const echo = await waitFor(() => client.reply(echoId), { timeoutMs: 15000 });
    assert.equal(echo.result.content[0].text, 'echo:list_extensions');

    // 端点确实被拼进了子进程参数。
    const argv = await waitFor(() => {
      const raw = fs.existsSync(box.argvFile) ? fs.readFileSync(box.argvFile, 'utf8') : '';
      return raw === '' ? null : JSON.parse(raw);
    }, { timeoutMs: 15000 });
    const wsIndex = argv.indexOf('--wsEndpoint');
    assert.notEqual(wsIndex, -1);
    assert.equal(argv[wsIndex + 1], `ws://127.0.0.1:${box.port}/devtools/browser/${GUID}`);
    assert.ok(argv.includes('--categoryExtensions'));

    // 不变量：TCP 探活连接过，但一个字节都没发 —— 没有 HTTP 升级，也没有 WebSocket 握手。
    assert.ok(box.bytes.length === 0, `包装脚本不该向调试端口发送任何字节，收到：${JSON.stringify(box.bytes.map(String))}`);
  } finally {
    client.child.kill();
    await box.cleanup();
  }
});

test('connect.mjs: 端口不在听时直接退出，不建连接也不弹窗', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cdp-stale-'));
  const portFile = path.join(dir, 'DevToolsActivePort');
  // 占一个端口再立刻放掉，确保没人监听。
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const deadPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  fs.writeFileSync(portFile, `${deadPort}\n/devtools/browser/${GUID}\n`);

  const child = spawn(process.execPath, [CONNECT], {
    env: { ...process.env, DSH_CDP_PORT_FILE: portFile, DSH_CDP_PROBE_TIMEOUT_MS: '1000' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  const code = await new Promise((resolve) => child.on('exit', resolve));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(code, 1, `应当以 exit 1 结束，实际 ${code}；stderr=${stderr}`);
  assert.equal(stdout, '', 'stdout 只能是 MCP 帧，不能有诊断');
  assert.match(stderr, /DevToolsActivePort 是旧的/);
  assert.match(stderr, /edge:\/\/inspect/);
});
