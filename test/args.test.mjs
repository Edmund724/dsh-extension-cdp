// lib/args.mjs 的失败方式清单（先列再写测试）：
// 1. argv 顺序错（entry 不在最前、--wsEndpoint 与 wsUrl 之间隔了别的东西）；
// 2. extraArgs 没原样追加 / 被去重 / 被重新排序（用户透传的 --workspace 必须保序）；
// 3. extraArgs 缺省时混进 undefined；
// 4. workspaces 缺省/为空时凭空产出一对 `--workspace undefined`（那会让上游拿 cwd 当根）；
// 5. workspaces 与 extraArgs 的顺序颠倒（上游 yargs 里同名的可重复数组无所谓，但顺序一变
//    调用方的预期就不成立，也不好断言）；
// 6. 多个目录只产出最后一个 / 顺序被打乱。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServerArgs, workspaceFlags } from '../lib/args.mjs';

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

test('buildServerArgs: workspaces 每个产出一对 --workspace，且在 extraArgs 之前', () => {
  assert.deepEqual(
    buildServerArgs({
      entry: 'e.js',
      wsUrl: 'ws://h:1/p',
      workspaces: ['D:/shots', 'D:/ext/dist'],
      extraArgs: ['--no-usage-statistics'],
    }),
    [
      'e.js',
      '--wsEndpoint',
      'ws://h:1/p',
      '--workspace',
      'D:/shots',
      '--workspace',
      'D:/ext/dist',
      '--no-usage-statistics',
    ],
  );
});

test('buildServerArgs: workspaces 缺省或为空时一个 --workspace 都不加', () => {
  const base = ['e.js', '--wsEndpoint', 'ws://h:1/p'];
  assert.deepEqual(buildServerArgs({ entry: 'e.js', wsUrl: 'ws://h:1/p' }), base);
  assert.deepEqual(buildServerArgs({ entry: 'e.js', wsUrl: 'ws://h:1/p', workspaces: [] }), base);
  assert.deepEqual(buildServerArgs({ entry: 'e.js', wsUrl: 'ws://h:1/p', workspaces: null }), base);
  assert.equal(buildServerArgs({ entry: 'e.js', wsUrl: 'ws://h:1/p', workspaces: [] }).includes('--workspace'), false);
});

test('workspaceFlags: 空目录名要靠调用方先过滤（这里是纯拼接）', () => {
  assert.deepEqual(workspaceFlags(['D:/a']), ['--workspace', 'D:/a']);
  assert.deepEqual(workspaceFlags(), []);
});
