// lib/filter.mjs 的失败方式清单（先列再写测试）：
// 1. parseBlockedTools：undefined 没落到默认值；空串没变成 []；空白/多余逗号没清掉；
// 2. createLineSplitter：半行被当成整行；一个 chunk 多行只吐一行；CRLF 残留 \r；
//    行序错乱；空行被当成有效行；结尾无换行时 flush 丢行；
// 3. filterServerLine：tools/list 结果没删屏蔽工具；误删其它工具或改动 JSON 结构；
//    非 JSON 输入被改写；result.tools 不是数组时被改写；屏蔽表为空时被改写；
// 4. filterClientLine：屏蔽工具的 tools/call 被放行；error 的 id/name 写错；
//    非 JSON / 非 tools/call / 未屏蔽工具被误拦。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBlockedTools,
  createLineSplitter,
  filterServerLine,
  filterClientLine,
} from '../lib/filter.mjs';

test('parseBlockedTools: 默认值与清理', () => {
  assert.deepEqual(parseBlockedTools(undefined), ['trigger_extension_action']);
  assert.deepEqual(parseBlockedTools(null), ['trigger_extension_action']);
  assert.deepEqual(parseBlockedTools(''), []);
  assert.deepEqual(parseBlockedTools('   '), []);
  assert.deepEqual(parseBlockedTools('a'), ['a']);
  assert.deepEqual(parseBlockedTools(' a , b ,, c '), ['a', 'b', 'c']);
  assert.deepEqual(parseBlockedTools(',,'), []);
});

test('createLineSplitter: 半行 -> 空数组，补齐 -> 一行', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('{"a"'), []);
  assert.deepEqual(s.push(':1}\n'), ['{"a":1}']);
});

test('createLineSplitter: 一个 chunk 多行 + 结尾半行', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('one\ntwo\nthree'), ['one', 'two']);
  assert.deepEqual(s.push('!\nfour\n'), ['three!', 'four']);
});

test('createLineSplitter: CRLF 不残留 \\r', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('a\r\nb\r\n'), ['a', 'b']);
});

test('createLineSplitter: 空行与空白行被跳过', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('\n\n  \n'), []);
  assert.deepEqual(s.push('x\n'), ['x']);
});

test('createLineSplitter: 无尾换行由 flush 兜住，不丢', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('tail-no-newline'), []);
  assert.deepEqual(s.flush(), ['tail-no-newline']);
  assert.deepEqual(s.flush(), []);
});

const TOOLS = {
  jsonrpc: '2.0',
  id: 2,
  result: {
    tools: [
      {
        name: 'list_pages',
        description: 'List pages',
        inputSchema: { type: 'object', properties: {} },
      },
      { name: 'trigger_extension_action', description: 'boom', inputSchema: { type: 'object' } },
      { name: 'list_extensions', description: 'List extensions', inputSchema: { type: 'object' } },
    ],
  },
};

test('filterServerLine: tools/list 删掉屏蔽工具，其余结构与内容不变', () => {
  const line = JSON.stringify(TOOLS);
  const out = filterServerLine(line, ['trigger_extension_action']);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, {
    jsonrpc: '2.0',
    id: 2,
    result: {
      tools: [
        {
          name: 'list_pages',
          description: 'List pages',
          inputSchema: { type: 'object', properties: {} },
        },
        { name: 'list_extensions', description: 'List extensions', inputSchema: { type: 'object' } },
      ],
    },
  });
  assert.equal(out.includes('trigger_extension_action'), false);
  assert.deepEqual(Object.keys(parsed), Object.keys(TOOLS));
});

test('filterServerLine: 非 JSON / 结构不符 / 屏蔽表为空 -> 原样', () => {
  const line = JSON.stringify(TOOLS);
  assert.equal(filterServerLine('not json at all', ['x']), 'not json at all');
  assert.equal(filterServerLine(line, []), line);
  const noTools = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } });
  assert.equal(filterServerLine(noTools, ['trigger_extension_action']), noTools);
  const toolsNotArray = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: 'nope' } });
  assert.equal(filterServerLine(toolsNotArray, ['x']), toolsNotArray);
  const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} });
  assert.equal(filterServerLine(notification, ['x']), notification);
  // 屏蔽表里没有的工具 -> 不该改动这行
  assert.equal(filterServerLine(line, ['other_tool']), line);
});

test('filterServerLine: 全部被屏蔽时 tools 为空数组', () => {
  const out = filterServerLine(JSON.stringify(TOOLS), ['trigger_extension_action', 'list_pages', 'list_extensions']);
  assert.deepEqual(JSON.parse(out).result.tools, []);
});

test('filterClientLine: 屏蔽工具的 tools/call 本地回 error 且不转发', () => {
  const line = JSON.stringify({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'trigger_extension_action', arguments: {} },
  });
  const got = filterClientLine(line, ['trigger_extension_action']);
  assert.equal(got.forward, false);
  const reply = JSON.parse(got.reply);
  assert.equal(reply.jsonrpc, '2.0');
  assert.equal(reply.id, 7);
  assert.equal(reply.error.code, -32601);
  assert.match(reply.error.message, /trigger_extension_action/);
  assert.match(reply.error.message, /dsh-cdp/);
});

test('filterClientLine: 其他 tools/call、非 JSON、非请求一律转发', () => {
  assert.deepEqual(
    filterClientLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_pages' } }), [
      'trigger_extension_action',
    ]),
    { forward: true },
  );
  assert.deepEqual(filterClientLine('garbage', ['trigger_extension_action']), { forward: true });
  assert.deepEqual(filterClientLine(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }), ['x']), {
    forward: true,
  });
  assert.deepEqual(filterClientLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), ['x']), {
    forward: true,
  });
  // 屏蔽表为空 -> 全部转发
  assert.deepEqual(
    filterClientLine(
      JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'trigger_extension_action' } }),
      [],
    ),
    { forward: true },
  );
  // 字符串 id 也要原样带回去
  const got = filterClientLine(
    JSON.stringify({ jsonrpc: '2.0', id: 'abc', method: 'tools/call', params: { name: 'x' } }),
    ['x'],
  );
  assert.equal(JSON.parse(got.reply).id, 'abc');
});
