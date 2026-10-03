// lib/tool-surface.mjs 的失败方式清单（先列再写测试）：
// 1. parseToolSurface：默认值没落到"预设白名单 + 元工具"；'all' 没关掉裁剪与元工具；
//    'none' 没变成"只留元工具"；空白/多余逗号没清掉；
// 2. 'all' 模式下没完全回到原行为（还偷偷加/删工具）；
// 3. 白名单里上游不存在的名字被当成错误，或者悄悄无声（要能报出来）；
// 4. 元工具没有把"可用工具名"带上（模型无从发现），或者把被屏蔽的工具也列出来；
// 5. cdp_call 翻译：id 没带回、arguments 丢了 / 没补 {}、把 schema/name 混进入参；
// 6. cdp_call schema:true 还去转发（多跑一趟上游）；
// 7. cdp_call 名字不存在时静默转发（模型拿到上游的模糊报错），且没告诉它有哪些工具；
// 8. cdp_call 的 name 缺失/不是字符串时崩掉而不是回可读错误；
// 9. 直接把不在白名单里的工具当"被屏蔽"拦掉 —— 可见性与安全是两件事，不能混；
// 10. 非 JSON / 结构不符的行被改写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RESIDENT,
  META_TOOL_NAME,
  createToolSurface,
  metaToolDefinition,
  parseToolSurface,
} from '../lib/tool-surface.mjs';

const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

const UPSTREAM_TOOLS = [
  { name: 'list_extensions', description: 'List extensions', inputSchema: { type: 'object', properties: {} } },
  { name: 'reload_extension', description: 'Reload', inputSchema: { type: 'object', properties: {} } },
  { name: 'evaluate_script', description: 'Eval', inputSchema: { type: 'object', properties: { fn: { type: 'string' } } } },
  { name: 'list_pages', description: 'Pages', inputSchema: { type: 'object', properties: {} } },
  { name: 'take_screenshot', description: 'Shot', inputSchema: { type: 'object', properties: {} } },
  { name: 'trigger_extension_action', description: 'Boom', inputSchema: { type: 'object', properties: {} } },
];

const listLine = (tools = UPSTREAM_TOOLS, id = 2) =>
  JSON.stringify({ jsonrpc: '2.0', id, result: { tools } });

const callLine = (name, args, id = 7) =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

const namesOf = (line) => JSON.parse(line).result.tools.map((tool) => tool.name);

test('parseToolSurface: 默认 / all / none / 白名单', () => {
  for (const value of [undefined, null, '', '   ']) {
    const parsed = parseToolSurface(value);
    assert.deepEqual(parsed.resident, DEFAULT_RESIDENT, `默认值错了：${String(value)}`);
    assert.equal(parsed.metaTool, true);
  }
  for (const value of ['all', 'ALL', ' All ']) {
    assert.deepEqual(parseToolSurface(value), { resident: null, metaTool: false }, `all 模式错了：${value}`);
  }
  assert.deepEqual(parseToolSurface('none'), { resident: [], metaTool: true });
  assert.deepEqual(parseToolSurface('a, b ,,c '), { resident: ['a', 'b', 'c'], metaTool: true });
});

test('metaToolDefinition: 带出可用工具名与 schema 开关', () => {
  const tool = metaToolDefinition(['list_pages', 'take_screenshot']);
  assert.equal(tool.name, META_TOOL_NAME);
  assert.deepEqual(tool.inputSchema.required, ['name']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.ok(tool.inputSchema.properties.arguments);
  assert.ok(tool.inputSchema.properties.schema);
  assert.match(tool.description, /list_pages/);
  assert.match(tool.description, /take_screenshot/);
});

test("'all' 模式：完全不介入", () => {
  const surface = createToolSurface(parseToolSurface('all'));
  const line = listLine();
  assert.equal(surface.rewriteServerLine(line), line);
  const call = callLine('take_screenshot', {});
  assert.deepEqual(surface.rewriteClientLine(call), { forward: call, reply: null });
});

test('默认模式：只留白名单 + 元工具', () => {
  const surface = createToolSurface(parseToolSurface(undefined));
  const names = namesOf(surface.rewriteServerLine(listLine()));
  assert.deepEqual(names, ['list_extensions', 'reload_extension', 'evaluate_script', 'list_pages', META_TOOL_NAME]);
  assert.equal(names.includes('take_screenshot'), false, '白名单外的工具不该出现');
});

test('none 模式：只留元工具', () => {
  const surface = createToolSurface(parseToolSurface('none'));
  assert.deepEqual(namesOf(surface.rewriteServerLine(listLine())), [META_TOOL_NAME]);
});

test('元工具清单不列出被屏蔽的工具', () => {
  const surface = createToolSurface({ ...parseToolSurface('none'), blocked: ['trigger_extension_action'] });
  const line = surface.rewriteServerLine(listLine());
  const meta = JSON.parse(line).result.tools.find((tool) => tool.name === META_TOOL_NAME);
  assert.equal(/trigger_extension_action/.test(meta.description), false);
  assert.match(meta.description, /take_screenshot/);
});

test('白名单里上游没有的名字能被报出来（不撒谎、不静默）', () => {
  const surface = createToolSurface({ resident: ['list_extensions', 'no_such_tool'], metaTool: true });
  surface.rewriteServerLine(listLine());
  const exposure = surface.exposure();
  assert.deepEqual(exposure.missing, ['no_such_tool']);
  assert.deepEqual(exposure.resident, ['list_extensions']);
  assert.equal(exposure.seen, true);
  // 还没收到 tools/list 时不能假装知道
  assert.deepEqual(createToolSurface({ resident: ['list_extensions'], metaTool: true }).exposure().missing, []);
});

test('cdp_call：翻译成内层 tools/call，id 与参数都对', () => {
  const surface = createToolSurface(parseToolSurface(undefined));
  surface.rewriteServerLine(listLine());
  const got = surface.rewriteClientLine(callLine(META_TOOL_NAME, { name: 'take_screenshot', arguments: { fullPage: true } }));
  const inner = JSON.parse(got.forward);
  assert.equal(got.reply, null);
  assert.equal(inner.method, 'tools/call');
  assert.equal(inner.id, 7);
  assert.deepEqual(inner.params, { name: 'take_screenshot', arguments: { fullPage: true } });
});

test('cdp_call：省略 arguments 时补 {}，且不把 name/schema 混进入参', () => {
  const surface = createToolSurface(parseToolSurface(undefined));
  surface.rewriteServerLine(listLine());
  const noArgs = JSON.parse(surface.rewriteClientLine(callLine(META_TOOL_NAME, { name: 'list_pages' })).forward);
  assert.deepEqual(noArgs.params.arguments, {});
  const withSchemaFlag = JSON.parse(
    surface.rewriteClientLine(callLine(META_TOOL_NAME, { name: 'list_pages', arguments: { a: 1 }, schema: false }))
      .forward,
  );
  assert.deepEqual(withSchemaFlag.params.arguments, { a: 1 });
});

test('cdp_call：schema:true 本地回 schema，不转发', () => {
  const surface = createToolSurface(parseToolSurface(undefined));
  surface.rewriteServerLine(listLine());
  const got = surface.rewriteClientLine(callLine(META_TOOL_NAME, { name: 'evaluate_script', schema: true }));
  assert.equal(got.forward, null);
  const reply = JSON.parse(got.reply);
  assert.equal(reply.id, 7);
  assert.equal(reply.result.isError, undefined);
  assert.deepEqual(JSON.parse(reply.result.content[0].text), { type: 'object', properties: { fn: { type: 'string' } } });
});

test('cdp_call：名字不存在 -> 本地回 isError 并列出可用工具', () => {
  const surface = createToolSurface(parseToolSurface(undefined));
  surface.rewriteServerLine(listLine());
  const got = surface.rewriteClientLine(callLine(META_TOOL_NAME, { name: 'list_extension', schema: true }));
  assert.equal(got.forward, null);
  const reply = JSON.parse(got.reply);
  assert.equal(reply.id, 7);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /list_extension/);
  assert.match(reply.result.content[0].text, /take_screenshot/);
});

test('cdp_call：name 缺失/不是字符串 -> 可读错误，不崩', () => {
  const surface = createToolSurface(parseToolSurface(undefined));
  surface.rewriteServerLine(listLine());
  for (const args of [undefined, {}, { name: 42 }, { name: '' }]) {
    const got = surface.rewriteClientLine(callLine(META_TOOL_NAME, args));
    assert.equal(got.forward, null, `不该转发：${JSON.stringify(args)}`);
    assert.equal(JSON.parse(got.reply).result.isError, true);
  }
});

test('cdp_call：还没收到 tools/list 时不拦（照原样转发）', () => {
  const surface = createToolSurface(parseToolSurface('none'));
  const line = callLine(META_TOOL_NAME, { name: 'whatever' });
  assert.deepEqual(surface.rewriteClientLine(line), { forward: line, reply: null });
});

test('直接调白名单外的工具仍然放行（可见性 != 屏蔽）', () => {
  const surface = createToolSurface(parseToolSurface(undefined));
  surface.rewriteServerLine(listLine());
  const line = callLine('take_screenshot', {});
  assert.deepEqual(surface.rewriteClientLine(line), { forward: line, reply: null });
});

test('非 tools/call 与非 JSON 一律原样', () => {
  const surface = createToolSurface(parseToolSurface(undefined));
  surface.rewriteServerLine(listLine());
  for (const line of [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    'not json',
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }),
  ]) {
    assert.deepEqual(surface.rewriteClientLine(line), { forward: line, reply: null });
  }
  const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} });
  assert.equal(surface.rewriteServerLine(notification), notification);
  const noTools = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } });
  assert.equal(surface.rewriteServerLine(noTools), noTools);
});

test('每次 tools/list 都重算（工具会变），且只加一个元工具', () => {
  const surface = createToolSurface(parseToolSurface(undefined));
  surface.rewriteServerLine(listLine());
  const second = surface.rewriteServerLine(listLine([...UPSTREAM_TOOLS, { name: 'new_tool', inputSchema: {} }]));
  assert.equal(countOccurrences(second, META_TOOL_NAME), 1, '元工具不能重复出现');
});
