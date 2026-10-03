// lib/spawn-shim.mjs 的失败方式清单（先列再写测试）：
// 1. 非 Windows 也返回"要走 shell"（把 Unix 的 spawn 语义搞坏）；
// 2. `npx` / `npm` 解析到 .cmd 却没识别出来 —— 直接 spawn 在 Windows 上就是 EINVAL；
// 3. 同目录同时有 foo.exe 与 foo.cmd 时选了 .cmd（无谓地引入 shell 与引号解析）；
// 4. 带路径的普通 .exe 被误判成要走 shell；
// 5. 找不到的命令抛异常（应该返回 false，让 spawn 自己去报 ENOENT）；
// 6. env 里没有 PATH / PATH 为空时崩掉；
// 7. quoteForCmd 把简单参数也加引号（平白多一层解析），或对带空格/& 的参数不加引号
//    —— 后者会让 cmd.exe 把它拆成两个参数甚至当成命令分隔符。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { needsWindowsShell, quoteForCmd, resolveOnPath } from '../lib/spawn-shim.mjs';

const WIN_ENV = { PATH: ['C:\\Windows\\System32', 'C:\\nodejs'].join(path.delimiter) };
const existingFiles = (...files) => (file) => files.map((f) => f.toLowerCase()).includes(file.toLowerCase());

test('needsWindowsShell: 非 Windows 一律 false', () => {
  assert.equal(needsWindowsShell({ command: 'npx', platform: 'darwin', env: WIN_ENV, exists: () => true }), false);
  assert.equal(needsWindowsShell({ command: 'npx.cmd', platform: 'linux', env: WIN_ENV, exists: () => true }), false);
});

test('needsWindowsShell: PATH 里解析到 .cmd/.bat 才算需要 shell', () => {
  const cmd = needsWindowsShell({
    command: 'npx',
    platform: 'win32',
    env: WIN_ENV,
    exists: existingFiles('C:\\nodejs\\npx.cmd'),
  });
  assert.equal(cmd, true);
  const exe = needsWindowsShell({
    command: 'npx',
    platform: 'win32',
    env: WIN_ENV,
    exists: existingFiles('C:\\nodejs\\npx.exe'),
  });
  assert.equal(exe, false);
  // 显式写了扩展名，不必查 PATH
  assert.equal(needsWindowsShell({ command: 'npx.cmd', platform: 'win32', env: {}, exists: () => false }), true);
  assert.equal(needsWindowsShell({ command: 'run.BAT', platform: 'win32', env: {}, exists: () => false }), true);
});

test('needsWindowsShell: 带路径的 .exe 不走 shell；找不到的命令不抛', () => {
  assert.equal(
    needsWindowsShell({ command: 'C:\\Program Files\\nodejs\\node.exe', platform: 'win32', env: {}, exists: () => true }),
    false,
  );
  assert.equal(needsWindowsShell({ command: 'definitely-not-here', platform: 'win32', env: WIN_ENV, exists: () => false }), false);
  assert.equal(needsWindowsShell({ command: 'npx', platform: 'win32', env: {}, exists: () => false }), false);
  assert.equal(needsWindowsShell({ command: undefined, platform: 'win32', env: {}, exists: () => false }), false);
});

test('resolveOnPath: 同目录里 .exe 优先于 .cmd', () => {
  const dir = 'C:\\tools';
  const env = { PATH: dir };
  const exists = existingFiles(path.join(dir, 'foo.cmd'), path.join(dir, 'foo.exe'));
  assert.equal(resolveOnPath('foo', { env, exists }), path.join(dir, 'foo.exe'));
  assert.equal(resolveOnPath('nope', { env, exists }), null);
  assert.equal(resolveOnPath('foo', { env: { PATH: '' }, exists }), null);
});

test('resolveOnPath: 无扩展名的同名文件不是可执行候选（npm 自带的 npx 就是 sh 脚本）', () => {
  const dir = 'D:\\nodejs';
  const env = { PATH: dir };
  // 真实现场：D:\nodejs 下同时有 npx（sh 脚本）、npx.cmd、npx.ps1。
  assert.equal(
    resolveOnPath('npx', { env, exists: existingFiles(path.join(dir, 'npx'), path.join(dir, 'npx.cmd')) }),
    path.join(dir, 'npx.cmd'),
  );
  // 只剩那个 sh 脚本时，cmd.exe 是不会找到它的：应当返回 null。
  assert.equal(resolveOnPath('npx', { env, exists: existingFiles(path.join(dir, 'npx')) }), null);
});

test('needsWindowsShell: npx 只有 sh 脚本时也要走 shell（真实现场的坑）', () => {
  const dir = 'D:\\nodejs';
  assert.equal(
    needsWindowsShell({
      command: 'npx',
      platform: 'win32',
      env: { PATH: dir },
      exists: existingFiles(path.join(dir, 'npx'), path.join(dir, 'npx.cmd')),
    }),
    true,
  );
});

test('quoteForCmd: 简单参数原样，危险字符加引号', () => {
  assert.equal(quoteForCmd('--no-usage-statistics'), '--no-usage-statistics');
  assert.equal(quoteForCmd('C:\\DSH\\dsh-extension-cdp\\connect.mjs'), 'C:\\DSH\\dsh-extension-cdp\\connect.mjs');
  assert.equal(quoteForCmd('D:\\src\\My Project\\dist'), '"D:\\src\\My Project\\dist"');
  assert.equal(quoteForCmd('a&b'), '"a&b"');
  assert.equal(quoteForCmd('say "hi"'), '"say ""hi"""');
});
