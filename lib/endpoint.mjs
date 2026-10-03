// DevToolsActivePort 的读取与前置校验。
// 实测事实（不要"优化"掉）：
// - 该文件由 edge://inspect 的 "Allow remote debugging for this browser instance" 开关写入；
// - 第 2 行的 guid 每次重开开关都会变 => 每次 spawn 都必须重读，禁止缓存；
// - 关掉开关后文件不删除，只是端口不再监听 => 必须校验端口在听（checkTcp）；
// - chrome-devtools-mcp 自己不校验端点（死端点 initialize 也会成功），所以校验必须在这里做。
import fs from 'node:fs';
import net from 'node:net';

const DEFAULT_HOST = '127.0.0.1';

// 解析端口文件正文 -> { port, path }；不合法就抛错，消息点明是哪一行不对。
export function parseDevToolsActivePort(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim());

  const first = lines[0] ?? '';
  if (first === '') throw new Error('DevToolsActivePort 第一行是空的：没有端口号');
  if (!/^\d+$/.test(first)) {
    throw new Error(`DevToolsActivePort 第一行不是十进制端口号: ${JSON.stringify(first)}`);
  }
  const port = Number(first);
  if (port <= 0 || port > 65535) {
    throw new Error(`DevToolsActivePort 第一行端口越界: ${port}（合法范围 1-65535）`);
  }

  const second = lines[1] ?? '';
  if (second === '') {
    throw new Error('DevToolsActivePort 第二行缺失：没有 /devtools/browser/<guid> 路径');
  }
  if (!second.startsWith('/devtools/')) {
    throw new Error(`DevToolsActivePort 第二行不是 /devtools/... 路径: ${JSON.stringify(second)}`);
  }

  return { port, path: second };
}

// 读文件 + 解析；readFile 可注入（默认 fs.readFileSync）。
export function readDevToolsActivePort(file, { readFile = fs.readFileSync } = {}) {
  let text;
  try {
    text = readFile(file, 'utf8');
  } catch (err) {
    throw new Error(
      `读不到 DevToolsActivePort（${file}）：${err?.message ?? err}\n` +
        '请先在 Edge 打开 edge://inspect，勾上 "Allow remote debugging for this browser instance"。',
    );
  }
  return parseDevToolsActivePort(text);
}

export function resolveWsUrl({ host = DEFAULT_HOST, port, path: endpointPath } = {}) {
  return `ws://${host}:${port}${endpointPath}`;
}

// TCP 探活：连得上 true，连不上/超时 false（不抛错，不退出）。
export function checkTcp({ host = DEFAULT_HOST, port, timeoutMs = 5000, connect = net.connect } = {}) {
  return new Promise((resolve) => {
    let socket;
    let timer = null;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // 探活失败不值得再抛
      }
      resolve(ok);
    };

    timer = setTimeout(() => finish(false), timeoutMs);
    try {
      socket = connect({ host, port });
    } catch {
      finish(false);
      return;
    }
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
    socket.on('timeout', () => finish(false));
  });
}
