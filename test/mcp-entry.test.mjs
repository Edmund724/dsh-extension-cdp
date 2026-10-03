// lib/mcp-entry.mjs 的失败方式清单（先列再写测试）：
// 1. package.json 不存在 / JSON 解析失败 -> 抛错，消息里点名文件；
// 2. bin 缺失、bin 为空对象、bin 对象里没有 chrome-devtools-mcp -> 抛错；
// 3. bin 是字符串但包名不是 chrome-devtools-mcp（无法确认它就是我们要的入口）-> 抛错；
// 4. bin 是字符串且包名就是 chrome-devtools-mcp -> 解析成绝对路径；
// 5. bin 的相对路径没有按 <dir> 拼成绝对路径（写死版本路径会随版本失效）；
// 6. findMcpEntry 没把 DSH_CDP_MCP_ENTRY 放在最高优先级；
// 7. searchDirs 命中时没读到 <dir>/node_modules/chrome-devtools-mcp/package.json；
// 8. 全都找不到时抛异常而不是返回 { error }。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveEntryFromPackageJson, findMcpEntry } from '../lib/mcp-entry.mjs';

const BIN = {
  'chrome-devtools-mcp': './build/src/bin/chrome-devtools-mcp.js',
  'chrome-devtools': './build/src/bin/chrome-devtools.js',
};
const DIR = path.resolve('fake', 'node_modules', 'chrome-devtools-mcp');

const reader = (pkg) => ({ readFile: () => JSON.stringify(pkg) });

test('resolveEntryFromPackageJson: 从 bin 对象推导，不写死版本路径', () => {
  const entry = resolveEntryFromPackageJson(DIR, reader({ name: 'chrome-devtools-mcp', bin: BIN }));
  assert.equal(entry, path.resolve(DIR, './build/src/bin/chrome-devtools-mcp.js'));
  assert.ok(path.isAbsolute(entry));
  // 换一个版本路径也必须跟着 bin 走
  const other = resolveEntryFromPackageJson(
    DIR,
    reader({ bin: { 'chrome-devtools-mcp': './out/cli.js' } }),
  );
  assert.equal(other, path.resolve(DIR, './out/cli.js'));
});

test('resolveEntryFromPackageJson: package.json 不存在抛错', () => {
  assert.throws(
    () => resolveEntryFromPackageJson(DIR, { readFile: () => { throw new Error('ENOENT'); } }),
    /package\.json/,
  );
});

test('resolveEntryFromPackageJson: JSON 坏了抛错', () => {
  assert.throws(
    () => resolveEntryFromPackageJson(DIR, { readFile: () => '{ not json' }),
    /package\.json/,
  );
});

test('resolveEntryFromPackageJson: bin 缺失或对不上抛错', () => {
  for (const pkg of [
    { name: 'chrome-devtools-mcp' },
    { name: 'chrome-devtools-mcp', bin: {} },
    { name: 'chrome-devtools-mcp', bin: { 'chrome-devtools': './build/src/bin/chrome-devtools.js' } },
    { name: 'chrome-devtools-mcp', bin: { 'chrome-devtools-mcp': '' } },
  ]) {
    assert.throws(() => resolveEntryFromPackageJson(DIR, reader(pkg)), /bin|入口/);
  }
});

test('resolveEntryFromPackageJson: bin 是字符串', () => {
  // 包名对得上才算，否则拒绝
  assert.equal(
    resolveEntryFromPackageJson(DIR, reader({ name: 'chrome-devtools-mcp', bin: './cli.js' })),
    path.resolve(DIR, './cli.js'),
  );
  assert.throws(() => resolveEntryFromPackageJson(DIR, reader({ name: 'other', bin: './cli.js' })), /bin|入口/);
  assert.throws(() => resolveEntryFromPackageJson(DIR, reader({ bin: './cli.js' })), /bin|入口/);
});

test('findMcpEntry: DSH_CDP_MCP_ENTRY 最高优先级', () => {
  const entry = path.resolve('C:', 'override', 'chrome-devtools-mcp.js');
  const got = findMcpEntry({
    env: { DSH_CDP_MCP_ENTRY: entry, DSH_PROFILE_DIR: 'X:/nope' },
    searchDirs: ['X:/also-nope'],
    exists: (p) => p === entry,
    readFile: () => { throw new Error('should not read'); },
    execPath: 'C:/ghost/node.exe',
  });
  assert.deepEqual(got, { entry });
});

test('findMcpEntry: DSH_CDP_MCP_ENTRY 指向不存在的文件时报错', () => {
  const got = findMcpEntry({
    env: { DSH_CDP_MCP_ENTRY: 'C:/nope/missing.js' },
    searchDirs: [],
    exists: () => false,
    readFile: () => { throw new Error('ENOENT'); },
    execPath: 'C:/ghost/node.exe',
  });
  assert.match(got.error, /DSH_CDP_MCP_ENTRY/);
});

test('findMcpEntry: searchDirs 命中 node_modules 下的包', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cdp-entry-'));
  try {
    const pkgDir = path.join(root, 'node_modules', 'chrome-devtools-mcp');
    fs.mkdirSync(path.join(pkgDir, 'build', 'src', 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'chrome-devtools-mcp', bin: BIN }),
    );
    const got = findMcpEntry({
      env: {},
      searchDirs: [root],
      execPath: path.join(root, 'ghost-node.exe'),
    });
    assert.deepEqual(got, { entry: path.join(pkgDir, 'build', 'src', 'bin', 'chrome-devtools-mcp.js') });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findMcpEntry: 从 DSH_PROFILE_DIR 命中', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cdp-profile-'));
  try {
    const pkgDir = path.join(root, 'node_modules', 'chrome-devtools-mcp');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'chrome-devtools-mcp', bin: BIN }),
    );
    const got = findMcpEntry({ env: { DSH_PROFILE_DIR: root }, searchDirs: [], execPath: 'C:/ghost/node.exe' });
    assert.ok(got.entry && got.entry.endsWith(path.join('build', 'src', 'bin', 'chrome-devtools-mcp.js')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findMcpEntry: 找不到返回 { error }，不抛异常', () => {
  const got = findMcpEntry({
    env: {},
    searchDirs: ['C:/nope-a', 'C:/nope-b'],
    exists: () => false,
    readFile: () => { throw new Error('ENOENT'); },
    execPath: 'C:/ghost/node.exe',
  });
  assert.ok(got.error, 'must return { error }');
  assert.equal(got.entry, undefined);
  assert.match(got.error, /chrome-devtools-mcp/);
});
