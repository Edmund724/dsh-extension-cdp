// 包元数据的失败方式清单（先列再写测试）：
// 1. package.json 不是合法 JSON / 缺 dsh.bundle.patch；
// 2. patch 指向的 cordis.patch.yml 不存在；
// 3. patch 里行的 id / name / serverName / command 表达式写错（写成字符串 serde 就到不了 DSH）；
// 4. files 里有哪条在仓库里匹配不到东西（发布后少文件）；
// 5. exports 暴露的子路径没被 files 覆盖（入口文件发不出去）；
// 6. 悄悄引入 npm 依赖。
// 这里不引 YAML 依赖：手写一个够用的行解析器（只支持本文件用到的子集）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepo = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(readRepo('package.json'));

// --- 极简 YAML 子集：注释、缩进块、`- key: value` 序列、标量、`!!js <expr>` ---
function parseYaml(text) {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  let pos = 0;

  const unquote = (s) => {
    if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) return s.slice(1, -1);
    return s;
  };
  const scalar = (s) => {
    const v = s.trim();
    if (v.startsWith('!!js ')) return { __jsExpr: v.slice(5).trim() };
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^-?\d+$/.test(v)) return Number(v);
    if (v === '[]') return [];
    if (v === '{}') return {};
    return unquote(v);
  };
  const KV = /^([\w.$@/-]+):(?:\s+([\s\S]*))?$/;

  const parseBlock = () => {
    if (lines[pos].text.startsWith('-')) return parseSeq(lines[pos].indent);
    return parseMap(lines[pos].indent);
  };
  const setKey = (obj, key, valueText, indent) => {
    obj[key] = valueText === undefined || valueText === '' ? parseBlock() : scalar(valueText);
  };
  const parseMap = (indent) => {
    const obj = {};
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith('-')) {
      const m = KV.exec(lines[pos].text);
      if (!m) throw new Error(`不认识的 YAML 行: ${lines[pos].text}`);
      pos += 1;
      setKey(obj, m[1], m[2], indent);
    }
    return obj;
  };
  const parseSeq = (indent) => {
    const arr = [];
    while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('-')) {
      const body = lines[pos].text.replace(/^-\s*/, '');
      pos += 1;
      if (body === '') {
        arr.push(parseBlock());
        continue;
      }
      const m = KV.exec(body);
      if (!m) {
        arr.push(scalar(body));
        continue;
      }
      const mapIndent = indent + 2;
      const obj = {};
      setKey(obj, m[1], m[2], mapIndent);
      while (pos < lines.length && lines[pos].indent === mapIndent && !lines[pos].text.startsWith('-')) {
        const mm = KV.exec(lines[pos].text);
        if (!mm) throw new Error(`不认识的 YAML 行: ${lines[pos].text}`);
        pos += 1;
        setKey(obj, mm[1], mm[2], mapIndent);
      }
      arr.push(obj);
    }
    return arr;
  };
  return parseBlock();
}

// --- 极简 glob：`**` 跨目录，`*` 不跨 `/` ---
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (pattern[i + 1] === '/') i += 1;
      } else {
        re += '[^/]*';
      }
      continue;
    }
    re += /[.+^${}()|[\]\\?]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

const repoFiles = walk(root);

test('package.json: 基本字段与 dsh.bundle.patch', () => {
  assert.equal(pkg.name, 'dsh-extension-cdp');
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.scripts.test, 'node --test "test/*.test.mjs"');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(fs.existsSync(path.join(root, pkg.dsh.bundle.patch)), 'cordis.patch.yml 必须存在');
  assert.deepEqual(pkg.dependencies ?? {}, {}, '不允许引入 npm 依赖');
  assert.equal(JSON.stringify(pkg).includes('"ws"'), false);
});

test('cordis.patch.yml: 解析出的行与 config 正确', () => {
  const doc = parseYaml(readRepo('cordis.patch.yml'));
  // 文档根就是补丁操作序列，`insert` 在第一条操作里
  const op = Array.isArray(doc) ? doc[0] : doc;
  assert.ok(Array.isArray(op.insert), 'patch 顶层要有 insert 序列');
  const row = op.insert[0];
  assert.equal(row.id, 'dsh-extension-cdp');
  assert.equal(row.name, '@deepseek-ai/dsh-mcp-client');
  assert.equal(row.config.transport, 'stdio');
  // 与 DSH 官方 browser-use bundle 的 serverName 一致：工具名统一成 mcp__chrome-devtools-mcp__*。
  assert.equal(row.config.serverName, 'chrome-devtools-mcp');
  assert.deepEqual(row.config.command, { __jsExpr: 'process.execPath' });
  assert.equal(row.config.failOnStartupError, false);
  // DSH 的 MCP 客户端默认每次 tools/call 只等 60 秒；approval 模式下第一笔调用要等人去点
  // Edge 的弹窗，60 秒太短（点晚了这次调用直接失败，点了也白点），所以必须放宽。
  assert.equal(row.config.toolCallTimeoutMs, 300000);
  assert.equal(row.config.reconnect.maxAttempts, 1000);
  assert.equal(row.config.reconnect.maxDelayMs, 30000);
  // args[0] 不许写死本机路径（公开仓库要能克隆即用）。这一行的 `baseUrl` 是 profile
  // 目录（root include 锚在那里），所以用 createRequire(baseUrl).resolve 解析本包入口 ——
  // 官方 dsh-web-app 的 skill-filesystem 行同款写法，2026-10-03 在本机实机验证过。
  assert.match(
    String(row.config.args[0].__jsExpr),
    /createRequire\(baseUrl\)\.resolve\('dsh-extension-cdp\/connect\.mjs'\)/,
    'args[0] 必须用 baseUrl 相对解析本包入口，不要写死绝对路径',
  );
  assert.ok(row.config.args.includes('--categoryExtensions'));
  // --workspace 只影响取路径的工具（install_extension / upload_file / trace 输出），
  // 热重载用不上它，带默认值就等于把一个机器上的构建目录写进公开仓库。
  assert.equal(
    row.config.args.includes('--workspace'),
    false,
    '不要默认带 --workspace：它会连带写死某台机器的构建目录',
  );
  for (const arg of row.config.args) {
    if (typeof arg !== 'string') continue;
    assert.equal(/^[A-Za-z]:[\\/]|^\\\\|^\//.test(arg), false, `args 里不许出现绝对路径：${arg}`);
  }
  // MCP 客户端会把子进程环境里的 DSH_* 名字全部清洗掉，所以 Host 侧的 profile 目录
  // 必须靠显式 env 转发（env 在清洗之后合并）；少了这一条，真实路径上就会
  // "找不到 chrome-devtools-mcp 入口" 然后无限退避重试。
  assert.match(
    String(row.config.env.DSH_CDP_MCP_SEARCH_DIRS.__jsExpr),
    /DSH_PROFILE_DIR/,
    'patch 必须把 DSH_PROFILE_DIR 显式转发给子进程',
  );
});

test('UI 配置页的接线：manifest / patch 行 / slot key / 桥路由', () => {
  const doc = parseYaml(readRepo('cordis.patch.yml'));
  const rows = (Array.isArray(doc) ? doc[0] : doc).insert;
  // client 半侧只能挂在「模块名 == 包名」的 Loader 行上（dsh-client-modules 的约定），
  // 少了这一行，插件页里根本不会出现"配置"控件 —— 而它看起来只是"没生效"。
  const uiRow = rows.find((row) => row.id === 'dsh-extension-cdp-ui');
  assert.ok(uiRow, 'patch 里要有承载 Client 半侧的那一行');
  assert.equal(uiRow.name, pkg.name, '承载行必须叫包名，否则浏览器半侧不挂载');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.main, './index.js');
  assert.equal(pkg.exports['.'], './index.js');
  assert.equal(pkg.exports['./client'], './client.js');

  // 配置页注册在 <包名>#<行 id> 上，行 id 必须是 MCP 那一行：控件才会长在真正被写的那一行上。
  const mcpRow = rows.find((row) => row.name === '@deepseek-ai/dsh-mcp-client');
  const client = readRepo('client.js');
  const slotKey = /key:\s*'([^']+)'/.exec(client)?.[1];
  assert.equal(slotKey, `${pkg.name}#${mcpRow.id}`, 'slot key 必须是 <包名>#<MCP 行 id>');

  // 两端写死的常量必须一致：路由前缀、env 名、被写的行 id。
  const host = readRepo('index.js');
  assert.match(host, /export function apply\(ctx\)/);
  const hostPrefix = /BRIDGE_PREFIX = '([^']+)'/.exec(host)?.[1];
  const clientPrefix = /BRIDGE = '([^']+)'/.exec(client)?.[1];
  assert.equal(hostPrefix, clientPrefix, 'index.js 与 client.js 的桥路由前缀必须一致');
  assert.match(host, /ENV_KEY = 'DSH_CDP_WORKSPACES'/);
  assert.match(host, new RegExp(`MCP_ROW_ID = '${mcpRow.id}'`));
  // 页面文案不许只看桥返回的 code 就瞎猜：reason 与 code 都要有中英词条。
  for (const locale of ['zh', 'en']) {
    assert.ok(client.includes(`${locale}: {`), `client.js 缺 ${locale} 词条`);
  }

  // 浏览器侧 apply 抛错 = 那一行 state 直接变 failed，而 Web 启动审计见到任何非 active 的
  // 条目就停在 "Failed to load plugins"，整个页面打不开（实测就是这么挂的）。locale 可能比
  // 本行晚就绪，所以注册文案必须放在 ctx.inject(['locale'], ...) 里等它，不能在 apply 顶层
  // 直接访问 ctx.locale。
  assert.match(client, /ctx\.inject\(\['locale'\]/, 'client.js 必须用 ctx.inject 等 locale 服务');
  assert.ok(
    client.slice(0, client.indexOf('ctx.locale.register')).includes("ctx.inject(['locale']"),
    'ctx.locale.register 必须发生在 ctx.inject([\'locale\']) 的回调里',
  );
});

test('files: 每条都能在仓库里匹配到东西', () => {
  for (const pattern of pkg.files) {
    const re = globToRegExp(pattern);
    assert.ok(repoFiles.some((f) => re.test(f)), `files 里的 ${pattern} 匹配不到任何文件`);
  }
});

test('exports: 每个子路径都被 files 覆盖', () => {
  const patterns = pkg.files.map(globToRegExp);
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const rel = target.replace(/^\.\//, '');
    // package.json 由 npm 无条件打包，不需要出现在 files 里
    if (rel === 'package.json') continue;
    assert.ok(repoFiles.some((f) => globToRegExp(rel).test(f)), `exports ${subpath} 的目标 ${rel} 在仓库里不存在`);
    assert.ok(
      patterns.some((re) => re.test(rel)),
      `exports ${subpath} -> ${rel} 没有被 files 覆盖`,
    );
  }
});

test('仓库必需文件齐备', () => {
  for (const rel of [
    'connect.mjs',
    'index.js',
    'client.js',
    'lib/workspaces.mjs',
    'lib/endpoint.mjs',
    'lib/mcp-entry.mjs',
    'lib/browser-paths.mjs',
    'lib/filter.mjs',
    'lib/hang-hint.mjs',
    'lib/upgrade-check.mjs',
    'lib/tool-surface.mjs',
    'lib/spawn-shim.mjs',
    'lib/args.mjs',
    'locale/zh.json',
    'locale/en.json',
    'icon.svg',
    'README.md',
    'LICENSE',
    '.gitignore',
    'tools/mcp-probe.mjs',
    'test/endpoint.test.mjs',
    'test/browser-paths.test.mjs',
    'test/mcp-entry.test.mjs',
    'test/filter.test.mjs',
    'test/hang-hint.test.mjs',
    'test/upgrade-check.test.mjs',
    'test/tool-surface.test.mjs',
    'test/spawn-shim.test.mjs',
    'test/args.test.mjs',
    'test/workspaces.test.mjs',
    'tools/check-upgrade.mjs',
    'test/package.test.mjs',
  ]) {
    assert.ok(repoFiles.includes(rel), `缺文件 ${rel}`);
  }
  assert.ok(readRepo('.gitignore').includes('node_modules'));
  assert.ok(JSON.parse(readRepo('locale/zh.json')).meta.title);
  assert.ok(JSON.parse(readRepo('locale/en.json')).meta.title);
});

test('package.json 与 patch 里不写死 chrome-devtools-mcp 版本路径', () => {
  const text = readRepo('cordis.patch.yml');
  assert.equal(/build\/src\/bin/.test(text), false, 'entry 路径必须从 bin 推导，不能写进 patch');
});

test('connect.mjs 不自己建 CDP 连接（approval 模式下多连一次就多弹一次窗）', () => {
  const text = readRepo('connect.mjs');
  // 日常 profile 走 RemoteDebuggingServerMode::kWithApprovalOnly：每一条新的 WebSocket
  // 连接都会让 Edge 弹一次"是否允许远程调试？"。校验必须止步于 TCP 探活；真正那条连接
  // 由 chrome-devtools-mcp 建立。有人再加回预检连接时，这里要立刻变红。
  for (const forbidden of ["resolve('ws')", 'new WebSocket(', 'Browser.getVersion', 'Upgrade: websocket']) {
    assert.equal(text.includes(forbidden), false, `connect.mjs 不该出现 ${forbidden}`);
  }
});

