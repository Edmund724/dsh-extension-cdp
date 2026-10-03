// lib/browser-paths.mjs 的失败方式清单（先列再写测试）：
// 1. 候选顺序不是 Edge -> Chrome，或路径不是各平台的标准位置；
// 2. DSH_CDP_USER_DATA_DIR 不是最高优先级，或指到 Chrome 目录时认不出品牌；
// 3. 只给 DSH_CDP_PORT_FILE 时，还被套上某个候选目录的端口文件；
// 4. 自动探测没按"哪个目录真的有 DevToolsActivePort"选（只认 Edge、漏了 Chrome）；
// 5. 两个候选都没有端口文件时没回落到第一个候选，后面的报错就说不清默认位置；
// 6. Windows 路径大小写/分隔符不同就认不出品牌；Linux 上却把大小写当等价；
// 7. 文案：有品牌时不给它的 inspect 页地址，没品牌时不给泛化的两个地址；
// 8. describeBrowser 说错来源（把 DSH_CDP_PORT_FILE 说成自动探测之类）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  PORT_FILE_NAME,
  browserCandidates,
  pickBrowser,
  remoteDebuggingHint,
  missingPortFileText,
  describeBrowser,
} from '../lib/browser-paths.mjs';

const WIN_ENV = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
const WIN_HOME = 'C:\\Users\\me';
const win = (...parts) => path.win32.join(...parts);
const posix = (...parts) => path.posix.join(...parts);

test('browserCandidates: 顺序是 Edge -> Chrome，Windows 用 LOCALAPPDATA', () => {
  const list = browserCandidates({ platform: 'win32', env: WIN_ENV, home: WIN_HOME });
  assert.deepEqual(list.map((c) => c.id), ['edge', 'chrome']);
  assert.equal(list[0].userDataDir, win(WIN_ENV.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data'));
  assert.equal(list[1].userDataDir, win(WIN_ENV.LOCALAPPDATA, 'Google', 'Chrome', 'User Data'));
  assert.equal(list[0].inspectUrl, 'edge://inspect');
  assert.equal(list[1].inspectUrl, 'chrome://inspect#remote-debugging');
});

test('browserCandidates: 没有 LOCALAPPDATA 时回落到 home 下的 AppData\\Local', () => {
  const list = browserCandidates({ platform: 'win32', env: {}, home: WIN_HOME });
  assert.equal(list[0].userDataDir, win(WIN_HOME, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'));
});

test('browserCandidates: macOS / Linux 的标准位置', () => {
  const mac = browserCandidates({ platform: 'darwin', env: {}, home: '/Users/me' });
  assert.equal(mac[0].userDataDir, posix('/Users/me', 'Library', 'Application Support', 'Microsoft Edge'));
  assert.equal(mac[1].userDataDir, posix('/Users/me', 'Library', 'Application Support', 'Google', 'Chrome'));
  const linux = browserCandidates({ platform: 'linux', env: {}, home: '/home/me' });
  assert.equal(linux[0].userDataDir, posix('/home/me', '.config', 'microsoft-edge'));
  assert.equal(linux[1].userDataDir, posix('/home/me', '.config', 'google-chrome'));
});

test('pickBrowser: DSH_CDP_USER_DATA_DIR 优先，并认出品牌', () => {
  const chromeDir = browserCandidates({ platform: 'win32', env: WIN_ENV, home: WIN_HOME })[1].userDataDir;
  const picked = pickBrowser({
    platform: 'win32',
    env: { ...WIN_ENV, DSH_CDP_USER_DATA_DIR: chromeDir },
    home: WIN_HOME,
    exists: () => true,
  });
  assert.equal(picked.source, 'env');
  assert.equal(picked.userDataDir, chromeDir);
  assert.equal(picked.browser.id, 'chrome');
  assert.equal(picked.portFile, win(chromeDir, PORT_FILE_NAME));
});

test('pickBrowser: 自定义目录认不出品牌，端口文件仍按它拼', () => {
  const dir = win('X:', 'some', 'profile');
  const picked = pickBrowser({
    platform: 'win32',
    env: { ...WIN_ENV, DSH_CDP_USER_DATA_DIR: dir },
    home: WIN_HOME,
    exists: () => false,
  });
  assert.equal(picked.browser, null);
  assert.equal(picked.portFile, win(dir, PORT_FILE_NAME));
});

test('pickBrowser: 只给 DSH_CDP_PORT_FILE 时不套候选目录', () => {
  const picked = pickBrowser({
    platform: 'win32',
    env: { ...WIN_ENV, DSH_CDP_PORT_FILE: 'X:/tmp/DevToolsActivePort' },
    home: WIN_HOME,
    exists: () => true,
  });
  assert.equal(picked.source, 'portFile');
  assert.equal(picked.portFile, 'X:/tmp/DevToolsActivePort');
  assert.equal(picked.userDataDir, null);
  assert.equal(picked.browser, null);
});

test('pickBrowser: 自动探测挑真的有端口文件的那个（这里只有 Chrome）', () => {
  const list = browserCandidates({ platform: 'win32', env: WIN_ENV, home: WIN_HOME });
  const chromePort = win(list[1].userDataDir, PORT_FILE_NAME);
  const picked = pickBrowser({
    platform: 'win32',
    env: WIN_ENV,
    home: WIN_HOME,
    exists: (p) => p === chromePort,
  });
  assert.equal(picked.source, 'detected');
  assert.equal(picked.browser.id, 'chrome');
  assert.equal(picked.portFile, chromePort);
});

test('pickBrowser: 两个候选都有端口文件时 Edge 优先', () => {
  const picked = pickBrowser({ platform: 'win32', env: WIN_ENV, home: WIN_HOME, exists: () => true });
  assert.equal(picked.browser.id, 'edge');
  assert.equal(picked.source, 'detected');
});

test('pickBrowser: 都没有时回落到第一个候选，并记成 fallback', () => {
  const picked = pickBrowser({ platform: 'win32', env: WIN_ENV, home: WIN_HOME, exists: () => false });
  assert.equal(picked.source, 'fallback');
  assert.equal(picked.browser.id, 'edge');
});

test('pickBrowser: Windows 下大小写与分隔符不同也认得品牌，Linux 下不认', () => {
  const win = pickBrowser({
    platform: 'win32',
    env: { ...WIN_ENV, DSH_CDP_USER_DATA_DIR: 'c:/users/me/appdata/local/microsoft/edge/user data' },
    home: WIN_HOME,
    exists: () => false,
  });
  assert.equal(win.browser?.id, 'edge');

  const linux = pickBrowser({
    platform: 'linux',
    env: { DSH_CDP_USER_DATA_DIR: '/home/me/.config/Microsoft-Edge' },
    home: '/home/me',
    exists: () => false,
  });
  assert.equal(linux.browser, null);
});

test('remoteDebuggingHint: 有品牌给它的 inspect 页，没品牌给两个', () => {
  const named = remoteDebuggingHint({ name: 'Chrome', inspectUrl: 'chrome://inspect#remote-debugging' });
  assert.match(named, /Chrome/);
  assert.match(named, /chrome:\/\/inspect#remote-debugging/);
  assert.match(named, /Allow remote debugging for this browser instance/);

  const generic = remoteDebuggingHint(null);
  assert.match(generic, /edge:\/\/inspect/);
  assert.match(generic, /chrome:\/\/inspect#remote-debugging/);
  assert.match(generic, /Allow remote debugging for this browser instance/);
});

test('missingPortFileText: 列出所有候选位置并给出 env 逃逸口', () => {
  const picked = pickBrowser({ platform: 'win32', env: WIN_ENV, home: WIN_HOME, exists: () => false });
  const text = missingPortFileText(picked);
  assert.match(text, /Edge/);
  assert.match(text, /Chrome/);
  assert.match(text, new RegExp(PORT_FILE_NAME));
  assert.match(text, /DSH_CDP_USER_DATA_DIR/);
  assert.match(text, /Allow remote debugging for this browser instance/);
});

test('describeBrowser: 说清浏览器与来源', () => {
  const detected = { browser: { name: 'Chrome' }, source: 'detected', userDataDir: 'D', portFile: 'D/DevToolsActivePort' };
  assert.match(describeBrowser(detected), /Chrome/);
  assert.match(describeBrowser(detected), /自动探测/);

  const viaEnv = { browser: null, source: 'env', userDataDir: 'X:/custom', portFile: 'X:/custom/DevToolsActivePort' };
  assert.match(describeBrowser(viaEnv), /DSH_CDP_USER_DATA_DIR/);
  assert.match(describeBrowser(viaEnv), /X:\/custom/);

  const viaPortFile = { browser: null, source: 'portFile', userDataDir: null, portFile: 'X:/t/DevToolsActivePort' };
  assert.match(describeBrowser(viaPortFile), /DSH_CDP_PORT_FILE/);

  const fallback = { browser: { name: 'Edge' }, source: 'fallback', userDataDir: 'D', portFile: 'D/DevToolsActivePort' };
  assert.match(describeBrowser(fallback), /Edge/);
  assert.match(describeBrowser(fallback), /回落/);
});
