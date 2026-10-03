// 候选浏览器的 user data 目录。
// 默认值不能只认 Edge：attach 这条路用的是 Chromium 通用的 DevToolsActivePort + approval 开关
// （机制与品牌无关，见 docs/compatibility.md），Edge 只是排在最前面的候选。
// 每个候选自带它的 inspect 页地址，报错和诊断才能说清"去哪个浏览器的哪个页面点允许"。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PORT_FILE_NAME = 'DevToolsActivePort';
export const EDGE_INSPECT_URL = 'edge://inspect';
export const CHROME_INSPECT_URL = 'chrome://inspect#remote-debugging';

const CHECKBOX = '"Allow remote debugging for this browser instance"';

// 候选目录一律用对应平台的 path 实现拼接，不受跑测试的宿主平台影响。
const WIN = path.win32;
const POSIX = path.posix;

function winCandidates({ env, home }) {
  const localAppData = env.LOCALAPPDATA ?? WIN.join(home, 'AppData', 'Local');
  return [
    {
      id: 'edge',
      name: 'Edge',
      inspectUrl: EDGE_INSPECT_URL,
      userDataDir: WIN.join(localAppData, 'Microsoft', 'Edge', 'User Data'),
    },
    {
      id: 'chrome',
      name: 'Chrome',
      inspectUrl: CHROME_INSPECT_URL,
      userDataDir: WIN.join(localAppData, 'Google', 'Chrome', 'User Data'),
    },
  ];
}

function macCandidates({ home }) {
  return [
    {
      id: 'edge',
      name: 'Edge',
      inspectUrl: EDGE_INSPECT_URL,
      userDataDir: POSIX.join(home, 'Library', 'Application Support', 'Microsoft Edge'),
    },
    {
      id: 'chrome',
      name: 'Chrome',
      inspectUrl: CHROME_INSPECT_URL,
      userDataDir: POSIX.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
    },
  ];
}

function linuxCandidates({ home }) {
  return [
    {
      id: 'edge',
      name: 'Edge',
      inspectUrl: EDGE_INSPECT_URL,
      userDataDir: POSIX.join(home, '.config', 'microsoft-edge'),
    },
    {
      id: 'chrome',
      name: 'Chrome',
      inspectUrl: CHROME_INSPECT_URL,
      userDataDir: POSIX.join(home, '.config', 'google-chrome'),
    },
  ];
}

export function browserCandidates({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'darwin') return macCandidates({ home });
  if (platform === 'linux') return linuxCandidates({ home });
  return winCandidates({ env, home });
}

function pathOps(platform) {
  return platform === 'win32' ? WIN : POSIX;
}

// 路径等价判定：Windows / macOS 的路径大小写不敏感，Linux 敏感。
function samePath(a, b, platform) {
  const ops = pathOps(platform);
  const norm = (value) => ops.normalize(String(value)).replace(/[\\/]+$/, '');
  const left = norm(a);
  const right = norm(b);
  return platform === 'linux' ? left === right : left.toLowerCase() === right.toLowerCase();
}

const text = (value) => String(value ?? '').trim();

// 选一个浏览器目录，优先级：
// 1. DSH_CDP_USER_DATA_DIR（显式指定，最高）；
// 2. DSH_CDP_PORT_FILE（只关心端口文件，不关心目录）；
// 3. 候选里真的存在 <user data dir>/DevToolsActivePort 的那个；
// 4. 都没有 -> 回落第一个候选（后面的报错才说得清"默认位置在哪"）。
export function pickBrowser({
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  exists = fs.existsSync,
} = {}) {
  const ops = pathOps(platform);
  const candidates = browserCandidates({ platform, env, home }).map((candidate) => ({
    ...candidate,
    portFile: ops.join(candidate.userDataDir, PORT_FILE_NAME),
  }));

  const explicitDir = text(env.DSH_CDP_USER_DATA_DIR);
  const explicitPortFile = text(env.DSH_CDP_PORT_FILE);

  if (explicitDir !== '') {
    return {
      userDataDir: explicitDir,
      portFile: explicitPortFile !== '' ? explicitPortFile : ops.join(explicitDir, PORT_FILE_NAME),
      browser: candidates.find((candidate) => samePath(candidate.userDataDir, explicitDir, platform)) ?? null,
      source: 'env',
      candidates,
    };
  }

  if (explicitPortFile !== '') {
    return { userDataDir: null, portFile: explicitPortFile, browser: null, source: 'portFile', candidates };
  }

  const detected = candidates.find((candidate) => exists(candidate.portFile));
  const browser = detected ?? candidates[0];
  return {
    userDataDir: browser.userDataDir,
    portFile: browser.portFile,
    browser,
    source: detected ? 'detected' : 'fallback',
    candidates,
  };
}

// "去哪个页面点允许"：知道品牌就点名，不知道就把两个都给出来。
export function remoteDebuggingHint(browser = null) {
  const page = browser
    ? `${browser.name} 的 ${browser.inspectUrl}`
    : `浏览器的 inspect 页（Edge 的 ${EDGE_INSPECT_URL}，Chrome 的 ${CHROME_INSPECT_URL}）`;
  return `请先在${page}勾上 ${CHECKBOX}。`;
}

// 一个候选目录都没有端口文件时的报错：把试过的位置全列出来，别让人猜默认值是什么。
export function missingPortFileText(picked) {
  const tried = picked.candidates.map((candidate) => `  - ${candidate.name}: ${candidate.portFile}`).join('\n');
  return (
    `没找到 ${PORT_FILE_NAME}。已试过：\n${tried}\n` +
    remoteDebuggingHint(null) +
    '\n浏览器装在别处（Beta / Canary / 便携版）时，用 DSH_CDP_USER_DATA_DIR 指定它的 user data 目录。'
  );
}

// 启动日志里那一行：说清用的是哪个浏览器、目录是怎么来的。
export function describeBrowser(picked) {
  if (picked.source === 'portFile') return `未知（DSH_CDP_PORT_FILE：${picked.portFile}）`;
  const how = { env: 'DSH_CDP_USER_DATA_DIR', detected: '自动探测', fallback: '未发现候选浏览器，回落默认' }[picked.source];
  const who = picked.browser ? picked.browser.name : '自定义目录';
  return `${who}（${how}：${picked.userDataDir}）`;
}
