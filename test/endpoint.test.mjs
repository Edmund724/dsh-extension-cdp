// lib/endpoint.mjs 的失败方式清单（先列再写测试）：
// 1. 端口文件不存在 / 读不了 -> 抛错，消息里点明文件路径；
// 2. 空文件 / 只有空白 -> 抛错（缺第一行）；
// 3. 只有一行 -> 抛错（缺第二行）；
// 4. 第一行不是十进制数字（含 `0`、`-1`、`abc`、`9222x`）-> 抛错；
// 5. 端口 0 或 > 65535 -> 抛错；
// 6. 第二行不是 `/devtools/...` -> 抛错；
// 7. 行尾 CRLF / 多余空白 -> 应被容忍；
// 8. resolveWsUrl 拼错 host/port/path 或漏掉默认 host；
// 9. checkTcp 在端口关闭时不返回 false，或永不 settle（超时未生效）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import {
  parseDevToolsActivePort,
  readDevToolsActivePort,
  resolveWsUrl,
  checkTcp,
} from '../lib/endpoint.mjs';

const GUID = '0c1f7a4e-3b2d-4f5a-9c8e-1d2b3a4c5d6e';
const GOOD = `9222\n/devtools/browser/${GUID}\n`;

test('parseDevToolsActivePort: 正常两行', () => {
  assert.deepEqual(parseDevToolsActivePort(GOOD), {
    port: 9222,
    path: `/devtools/browser/${GUID}`,
  });
});

test('parseDevToolsActivePort: CRLF 与行尾空白被容忍', () => {
  assert.deepEqual(parseDevToolsActivePort(`9222  \r\n/devtools/browser/${GUID} \r\n`), {
    port: 9222,
    path: `/devtools/browser/${GUID}`,
  });
});

test('parseDevToolsActivePort: 空内容抛错且提到第一行', () => {
  for (const text of ['', '   \n\n', '\r\n']) {
    assert.throws(() => parseDevToolsActivePort(text), /第一行/);
  }
});

test('parseDevToolsActivePort: 只有一行抛错且提到第二行', () => {
  assert.throws(() => parseDevToolsActivePort('9222\n'), /第二行/);
  assert.throws(() => parseDevToolsActivePort('9222'), /第二行/);
});

test('parseDevToolsActivePort: 端口非数字抛错', () => {
  for (const bad of ['abc', '-1', '9222x', '9 222', '0x10', '+1']) {
    assert.throws(() => parseDevToolsActivePort(`${bad}\n/devtools/browser/${GUID}\n`), /端口/);
  }
});

test('parseDevToolsActivePort: 端口越界抛错', () => {
  for (const bad of ['0', '65536', '99999']) {
    assert.throws(() => parseDevToolsActivePort(`${bad}\n/devtools/browser/${GUID}\n`), /端口/);
  }
  assert.equal(parseDevToolsActivePort(`1\n/devtools/browser/${GUID}\n`).port, 1);
  assert.equal(parseDevToolsActivePort(`65535\n/devtools/browser/${GUID}\n`).port, 65535);
});

test('parseDevToolsActivePort: 第二行不是 /devtools/... 抛错', () => {
  for (const bad of ['/json/version', 'devtools/browser/x', '/devtools', '  ', '#comment']) {
    assert.throws(
      () => parseDevToolsActivePort(`9222\n${bad}\n`),
      /第二行|devtools/,
    );
  }
});

test('readDevToolsActivePort: 文件缺失抛错且消息含路径', () => {
  const missing = path.join('C:', 'no-such-dir', 'DevToolsActivePort');
  assert.throws(
    () => readDevToolsActivePort(missing, { readFile: () => { throw new Error('ENOENT'); } }),
    (err) => /DevToolsActivePort/.test(err.message),
  );
});

test('readDevToolsActivePort: 提示文案可注入（换浏览器不用改这里）', () => {
  const boom = () => {
    throw new Error('ENOENT');
  };
  assert.throws(
    () => readDevToolsActivePort('X:/nope/DevToolsActivePort', { readFile: boom, hint: '去 Edge 的 edge://inspect 打开开关。' }),
    /去 Edge 的 edge:\/\/inspect 打开开关/,
  );
  assert.throws(
    () => readDevToolsActivePort('X:/nope/DevToolsActivePort', { readFile: boom }),
    /Allow remote debugging for this browser instance/,
  );
});

test('readDevToolsActivePort: 默认注入 readFileSync 风格签名', () => {
  const seen = [];
  const got = readDevToolsActivePort('X:/User Data/DevToolsActivePort', {
    readFile: (file, enc) => {
      seen.push([file, enc]);
      return GOOD;
    },
  });
  assert.deepEqual(got, { port: 9222, path: `/devtools/browser/${GUID}` });
  assert.equal(seen[0][0], 'X:/User Data/DevToolsActivePort');
});

test('resolveWsUrl: 默认 host 与显式 host', () => {
  assert.equal(
    resolveWsUrl({ port: 9222, path: `/devtools/browser/${GUID}` }),
    `ws://127.0.0.1:9222/devtools/browser/${GUID}`,
  );
  assert.equal(
    resolveWsUrl({ host: 'localhost', port: 1, path: '/devtools/browser/x' }),
    'ws://localhost:1/devtools/browser/x',
  );
});

test('checkTcp: 连得上本地 server 返回 true', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    assert.equal(await checkTcp({ host: '127.0.0.1', port, timeoutMs: 2000 }), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('checkTcp: 端口关闭返回 false', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await checkTcp({ host: '127.0.0.1', port, timeoutMs: 2000 }), false);
});

test('checkTcp: 超时返回 false 且销毁 socket', async () => {
  let destroyed = false;
  const fakeSocket = {
    on() {
      return this;
    },
    once() {
      return this;
    },
    destroy() {
      destroyed = true;
      return this;
    },
  };
  const ok = await checkTcp({
    host: '127.0.0.1',
    port: 9222,
    timeoutMs: 30,
    connect: () => fakeSocket,
  });
  assert.equal(ok, false);
  assert.equal(destroyed, true);
});

test('checkTcp: connect 抛错返回 false', async () => {
  const ok = await checkTcp({
    host: '127.0.0.1',
    port: 9222,
    timeoutMs: 30,
    connect: () => {
      throw new Error('boom');
    },
  });
  assert.equal(ok, false);
});
