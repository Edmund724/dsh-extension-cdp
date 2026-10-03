// Minimal MCP stdio client: spawn a server, initialize, list tools, call tools.
// Usage: node mcp-probe.mjs <serverCommand...>  -- <toolCallJson> ...
//
// Windows note: `npx` / `npm` / `pnpm` are .cmd shims, and Node refuses to spawn those without
// a shell (EINVAL since CVE-2024-27980). They are detected and routed through cmd.exe, which
// means the arguments get a second round of parsing -- lib/spawn-shim.mjs quotes them.
import { spawn, spawnSync } from 'node:child_process';
import { needsWindowsShell, quoteForCmd } from '../lib/spawn-shim.mjs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const serverArgv = sep === -1 ? argv : argv.slice(0, sep);
const calls = sep === -1 ? [] : argv.slice(sep + 1).map((s) => JSON.parse(s));

const [cmd, ...args] = serverArgv;
const shell = needsWindowsShell({ command: cmd });
const child = spawn(cmd, shell ? args.map(quoteForCmd) : args, {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
  shell,
});

// shell 模式下 child 是 cmd.exe，只 kill 它不会带走真正的服务器进程：npx 链会继续跑，留下
// 占着端口的孤儿（用同步的 taskkill 保证它真的执行完，别在退出竞态里丢掉）。
function stopChild() {
  if (process.platform === 'win32' && shell && child.pid !== undefined) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    return;
  }
  try {
    child.kill();
  } catch {
    // 已经退了
  }
}

let buf = '';
const pending = new Map();
let nextId = 1;

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + '\n');
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, 60000);
  });
}
function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error('[non-json stdout]', line);
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  }
});

const rpc = (name) => ({ name, title: name, version: '1.0.0' });

const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: { roots: { listChanged: true } },
  clientInfo: rpc('dsh-probe'),
});
console.log('INIT', JSON.stringify(init).slice(0, 400));
notify('notifications/initialized', {});

const tools = await request('tools/list', {});
console.log('TOOLS', tools.tools.length, 'bytes', JSON.stringify(tools).length);
console.log(
  'EXT TOOLS',
  tools.tools
    .map((t) => t.name)
    .filter((n) => /extension|service_worker|serviceWorker/i.test(n))
    .join(', '),
);

for (const call of calls) {
  if (call.$schema) {
    const t = tools.tools.find((x) => x.name === call.$schema);
    console.log(`SCHEMA ${call.$schema}: ${JSON.stringify(t?.inputSchema)}`);
    continue;
  }
  try {
    const res = await request('tools/call', call);
    const text = (res.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    console.log(`CALL ${call.name} OK:\n${text.slice(0, 2000)}`);
    if (!text) console.log('RAW ' + JSON.stringify(res).slice(0, 2000));
  } catch (e) {
    console.log(`CALL ${call.name} FAIL: ${e.message}`);
  }
}

// 收尾：先关 stdin —— MCP stdio 服务器看到 EOF 会自己退出，整条 cmd/npx 链随之收干净；
// 再等一拍补一刀杀整棵树（顺序和等待都是必要的，见 stopChild 的注释）。
process.on('exit', stopChild);
try {
  child.stdin.end();
} catch {
  // 已经退了
}
await new Promise((resolve) => setTimeout(resolve, 500));
stopChild();
process.exit(0);
