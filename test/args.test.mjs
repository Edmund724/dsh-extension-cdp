// lib/args.mjs 的失败方式清单（先列再写测试）：
// 1. argv 顺序错（entry 不在最前、--wsEndpoint 与 wsUrl 之间隔了别的东西）；
// 2. extraArgs 没原样追加 / 被去重 / 被重新排序（用户透传的 --workspace 必须保序）；
// 3. extraArgs 缺省时混进 undefined。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServerArgs } from '../lib/args.mjs';

test('buildServerArgs: 顺序固定，extraArgs 原样追加', () => {
  assert.deepEqual(
    buildServerArgs({
      entry: 'C:/pkg/build/src/bin/chrome-devtools-mcp.js',
      wsUrl: 'ws://127.0.0.1:9222/devtools/browser/x',
      extraArgs: ['--no-usage-statistics', '--categoryExtensions', '--workspace', 'D:/ext/dist'],
    }),
    [
      'C:/pkg/build/src/bin/chrome-devtools-mcp.js',
      '--wsEndpoint',
      'ws://127.0.0.1:9222/devtools/browser/x',
      '--no-usage-statistics',
      '--categoryExtensions',
      '--workspace',
      'D:/ext/dist',
    ],
  );
});

test('buildServerArgs: extraArgs 缺省为空数组', () => {
  assert.deepEqual(buildServerArgs({ entry: 'e.js', wsUrl: 'ws://h:1/p' }), ['e.js', '--wsEndpoint', 'ws://h:1/p']);
  assert.deepEqual(buildServerArgs({ entry: 'e.js', wsUrl: 'ws://h:1/p', extraArgs: [] }), [
    'e.js',
    '--wsEndpoint',
    'ws://h:1/p',
  ]);
});

test('buildServerArgs: 不返回 entry 之外的位置参数混入', () => {
  const args = buildServerArgs({ entry: 'e.js', wsUrl: 'ws://h:1/p', extraArgs: ['--x'] });
  assert.equal(args.length, 4);
  assert.equal(args.filter((a) => a === undefined).length, 0);
});
