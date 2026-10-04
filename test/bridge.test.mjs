// Host 半侧那座桥（配置页 → MCP 那一行 env）的失败方式清单（先列再写测试）：
// 1. 只在 Host 同时有 webServer 与 configEditor 时注册 —— headless / CLI 组合下没有 webServer，
//    桥缺席是正常的，绝不能因此让那一行激活失败；
// 2. 桥能改 profile 里的配置，所以只认本机请求：非 loopback 的 remoteAddress → 403；
// 3. Host 头不是 loopback、或 Origin 与 Host 不同源、或 sec-fetch-site: cross-site → 403
//    （本机别的页面不能借浏览器 CSRF 改配置）；
// 4. 只收 POST（其余 405）；body 不是合法 JSON、或超过 64 KiB → 400，且不能写盘；
// 5. 找不到 MCP 那一行 → row-missing；找到但没在运行 → row-inactive（页面要给出可执行的提示）；
// 6. describe 读的是那一行**已生效**的 env（`!!js` 求值之后），并报告 profile 覆盖是否存在；
// 7. 白名单里已经不存在的目录要在 missing 里报出来（上游对每个根做 realpath，会让整次调用失败）；
// 8. save 只改 env 里那一个键，raw config 里的 `!!js` 节点必须原样带回去；
// 9. 只要有一条目录不合法就整体拒绝（invalid-dirs），edit 一次都不能调用；
// 10. reset 返回下层组合结果，让 configEditor 把 profile 里那一段整段删掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

import { apply } from '../index.js';

const BRIDGE_PREFIX = '/api/dsh-extension-cdp/workspaces';
const TMP = os.tmpdir();

// 假 Host 上下文：只实现 apply 用到的那一个入口，把注册到的路由收下来。
function boot({ env = {}, override = {}, fiberState = 2, id = 'dsh-extension-cdp' } = {}) {
  const entry = { options: { id }, fiber: { state: fiberState, config: { env: { ...env } } } };
  const edits = [];
  const configEditor = {
    entries: () => [entry],
    configuration: () => (Object.keys(override).length > 0 ? [{ entry, override }] : []),
    edit: async (target, mutate) => {
      edits.push({ entry: target, mutate });
    },
  };
  const routes = [];
  const disposers = [];
  let injected;
  apply({
    inject: (names, callback) => {
      injected = names;
      callback({
        webServer: {
          register: (route) => {
            routes.push(route);
            return () => {
              route.disposed = true;
            };
          },
        },
        configEditor,
        effect: (body) => {
          const dispose = body();
          disposers.push(dispose);
          return dispose;
        },
      });
    },
  });
  const route = (action) => {
    const found = routes.find((candidate) => candidate.path === `${BRIDGE_PREFIX}/${action}`);
    assert.ok(found, `没有注册 ${action} 路由`);
    return found;
  };
  return { entry, edits, routes, route, injected, disposeAll: () => disposers.forEach((fn) => fn()) };
}

// 假的 http 请求：够 readJsonBody 的 for-await 用。
function request({ body, method = 'POST', remoteAddress = '127.0.0.1', host = '127.0.0.1:19555', headers = {} } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)];
  return {
    method,
    headers: { host, ...headers },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

function response() {
  return {
    status: 0,
    writeHead(status) {
      this.status = status;
    },
    end(text) {
      this.body = text;
    },
  };
}

async function call(route, req) {
  const res = response();
  await route.handler(req, res);
  return { status: res.status, json: res.body === undefined ? undefined : JSON.parse(res.body) };
}

test('桥只在 webServer + configEditor 齐备的组合里注册三条 exact 路由', () => {
  const host = boot();
  assert.deepEqual(host.injected, ['webServer', 'configEditor']);
  assert.deepEqual(
    host.routes.map((route) => route.path),
    ['describe', 'save', 'reset'].map((action) => `${BRIDGE_PREFIX}/${action}`),
  );
  for (const route of host.routes) assert.equal(route.kind, 'exact', 'exact 路由才会盖过 /api 网关的鉴权');
  host.disposeAll();
  for (const route of host.routes) assert.equal(route.disposed, true, 'effect 回收时必须注销路由');
});

test('只认本机请求：remoteAddress / Host / Origin / sec-fetch-site 任一不对就是 403', async () => {
  const { route } = boot();
  const describe = route('describe');

  assert.equal((await call(describe, request({ remoteAddress: '10.0.0.5' }))).status, 403);
  assert.equal((await call(describe, request({ host: 'example.com:80' }))).status, 403);
  assert.equal((await call(describe, request({ headers: { origin: 'http://evil.example' } }))).status, 403);
  assert.equal((await call(describe, request({ headers: { 'sec-fetch-site': 'cross-site' } }))).status, 403);
  // 浏览器同源请求（Origin 与 Host 一致）与本机无 Origin 请求都要放行。
  assert.equal((await call(describe, request({ headers: { origin: 'http://127.0.0.1:19555' } }))).status, 200);
  assert.equal((await call(describe, request({ host: 'localhost:19555' }))).status, 200);
});

test('方法与非 JSON body：GET 405、坏 JSON 400、超长 body 400，且都不碰配置', async () => {
  const host = boot();
  const save = host.route('save');
  assert.equal((await call(save, request({ method: 'GET' }))).status, 405);

  const malformed = await call(save, request({ body: '{oops' }));
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.code, 'malformed-json');

  const huge = await call(save, request({ body: `{"text":"${'x'.repeat(70 * 1024)}"}` }));
  assert.equal(huge.status, 400);

  assert.equal(host.edits.length, 0, '被拒的请求绝不能写配置');
});

test('describe 读已生效的 env、报告覆盖状态，并列出已经不存在的目录', async () => {
  const gone = path.join(TMP, 'dsh-cdp-gone-dir');
  const host = boot({ env: { DSH_CDP_WORKSPACES: [TMP, gone].join(path.delimiter) }, override: { config: {} } });
  const result = await call(host.route('describe'), request());
  assert.equal(result.status, 200);
  assert.deepEqual(result.json.value.dirs, [TMP, gone]);
  assert.equal(result.json.value.text, [TMP, gone].join('\n'));
  assert.deepEqual(result.json.value.missing, [gone]);
  assert.equal(result.json.value.overridden, true, 'profile 里有覆盖时页面才显示"清除覆盖"');
  assert.equal(result.json.value.delimiter, path.delimiter);

  const clean = boot({ env: { DSH_CDP_WORKSPACES: '' } });
  assert.equal((await call(clean.route('describe'), request())).json.value.overridden, false);
});

test('save 只改 env 里那一个键，`!!js` 节点原样保留', async () => {
  const host = boot();
  const result = await call(host.route('save'), request({ body: JSON.stringify({ dirs: [TMP] }) }));
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);

  // 框架交给 edit 的 raw 就是当前那一行的原始 config：普通字段 + {__jsExpr} 节点。
  const raw = {
    transport: 'stdio',
    command: { __jsExpr: 'process.execPath' },
    env: { DSH_CDP_MCP_SEARCH_DIRS: { __jsExpr: "process.env.DSH_PROFILE_DIR || ''" } },
  };
  const next = host.edits[0].mutate(raw, { ...raw });
  assert.equal(next.env.DSH_CDP_WORKSPACES, TMP);
  assert.deepEqual(next.env.DSH_CDP_MCP_SEARCH_DIRS, { __jsExpr: "process.env.DSH_PROFILE_DIR || ''" }, '`!!js` 不能被求值成字面量');
  assert.deepEqual(next.command, { __jsExpr: 'process.execPath' });
  assert.equal(next.transport, 'stdio');
});

test('只要有一条目录不合法就整体拒绝，edit 一次都不调用', async () => {
  const host = boot();
  const missing = path.join(TMP, 'dsh-cdp-missing-dir');
  const result = await call(
    host.route('save'),
    request({ body: JSON.stringify({ dirs: [TMP, missing, 'relative\\dir'] }) }),
  );
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.code, 'invalid-dirs');
  assert.deepEqual(
    result.json.invalid.map((item) => item.reason),
    ['missing', 'relative'],
  );
  assert.equal(host.edits.length, 0, '一条不合法就什么都不写，避免留下半份白名单');
});

test('reset 把整段覆盖交还给下层', async () => {
  const host = boot({ override: { config: {} } });
  const inherited = { transport: 'stdio' };
  const result = await call(host.route('reset'), request({ body: '{}' }));
  assert.equal(result.json.ok, true);
  assert.equal(host.edits.length, 1);
  assert.equal(host.edits[0].mutate({ transport: 'stdio', env: {} }, inherited), inherited);
});

test('MCP 那一行不在 / 没在运行：给出可执行的错误码', async () => {
  // 插件被卸载、或那一行的 id 被改掉：id 对不上就是"不在"。
  const absent = boot({ id: 'some-other-row' });
  const absentResult = await call(absent.route('describe'), request());
  assert.equal(absentResult.json.ok, false);
  assert.equal(absentResult.json.code, 'row-missing');

  const stopped = boot({ fiberState: 3 });
  const stoppedResult = await call(stopped.route('save'), request({ body: JSON.stringify({ dirs: [TMP] }) }));
  assert.equal(stoppedResult.json.ok, false);
  assert.equal(stoppedResult.json.code, 'row-inactive');
  assert.equal(stopped.edits.length, 0);
});
