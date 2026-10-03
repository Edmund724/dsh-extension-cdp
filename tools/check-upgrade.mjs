#!/usr/bin/env node
// 升级 chrome-devtools-mcp 之前的预检：读候选产物的分类互斥表，回答"本行还能不能起来"。
//
// 为什么需要它：`--categoryExtensions` + `--wsEndpoint` 是本行（dsh-cdp）的核心组合。
// 上游 main 已经给 EXTENSIONS 分类加了互斥表，一旦发出来，这一行会启动即失败 —— 而
// "发布版里到底有没有"必须看**产物**，不能看源码分支（1.10.1 就是源码有、产物没有）。
//
// 用法：
//   node tools/check-upgrade.mjs                         # 检查当前已装的那份
//   node tools/check-upgrade.mjs --version 1.11.0        # 检查候选版本（只读产物，不执行它）
//   node tools/check-upgrade.mjs --package-dir <目录>     # 检查已经解开的一份
//
// 退出码：0 = 安全，1 = 不安全，2 = 无法判定（要人看一眼），3 = 用法/运行错误。
//
// 安全边界：候选产物只被**读取与正则匹配**，绝不执行；下载与解包都在临时目录里完成并在
// 结束时删除。--version 走官方 registry（可用 DSH_CDP_UPGRADE_REGISTRY 换成镜像）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { PKG_NAME, dshProfileDirs, findMcpEntry } from '../lib/mcp-entry.mjs';
import { CONFLICT_TOKEN, REVIEW, SAFE, UNSAFE, UNKNOWN, reconcileVerdict } from '../lib/upgrade-check.mjs';

export const EXIT = { safe: 0, unsafe: 1, undecided: 2, error: 3 };

// 只接受 x.y.z 或带预发布后缀的版本号：它会被拼进 registry 请求。
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const USAGE = [
  'check-upgrade: chrome-devtools-mcp 升级前预检（dsh-cdp）',
  '',
  '用法：',
  '  node tools/check-upgrade.mjs                      检查当前已安装的那份',
  '  node tools/check-upgrade.mjs --version <x.y.z>    检查候选版本（下载到临时目录，只读不执行）',
  '  node tools/check-upgrade.mjs --package-dir <目录> 检查已经解开的一份产物',
  '',
  `退出码：${EXIT.safe} = 安全，${EXIT.unsafe} = 不安全，${EXIT.undecided} = 无法判定（要人看一眼），${EXIT.error} = 用法/运行错误`,
].join('\n');

export function parseArgs(argv = []) {
  const args = [...argv];
  if (args.length === 0) return { mode: 'installed' };
  if (args.includes('--help') || args.includes('-h')) return { mode: 'help' };

  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--version') {
      const value = args[i + 1];
      i += 1;
      if (value === undefined || !VERSION_RE.test(value)) {
        return { error: `--version 需要一个 x.y.z 形式的版本号，收到 ${JSON.stringify(value)}` };
      }
      parsed.version = value;
      parsed.mode = 'version';
    } else if (arg === '--package-dir') {
      const value = args[i + 1];
      i += 1;
      if (value === undefined || String(value).trim() === '') {
        return { error: '--package-dir 需要一个目录' };
      }
      parsed.packageDir = value;
      parsed.mode = 'package-dir';
    } else {
      return { error: `不认识的参数：${arg}` };
    }
  }
  if (parsed.version !== undefined && parsed.packageDir !== undefined) {
    return { error: '--version 与 --package-dir 只能给一个' };
  }
  return parsed;
}

function listJsFiles(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(path.join(current, entry.name));
        continue;
      }
      if (entry.name.endsWith('.js')) found.push(path.join(current, entry.name));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return found;
}

// 入口（<pkg>/build/src/bin/xxx.js）往上找包根。
function packageDirOf(entry, { exists, readFile }) {
  let dir = path.dirname(path.resolve(entry));
  for (let i = 0; i < 8; i += 1) {
    const manifest = path.join(dir, 'package.json');
    if (exists(manifest)) {
      try {
        if (JSON.parse(readFile(manifest))?.name === PKG_NAME) return dir;
      } catch {
        // package.json 坏了：继续往上找
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// 下载候选 tarball 并解包到 <dir>/package。只读，不执行候选产物。
async function downloadCandidate(version, dir) {
  const registry = (process.env.DSH_CDP_UPGRADE_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');
  const meta = await fetch(`${registry}/${PKG_NAME}/${version}`, { redirect: 'follow' });
  if (!meta.ok) throw new Error(`registry 返回 ${meta.status}（版本不存在或网络不可达）`);
  const info = await meta.json();
  const tarball = info?.dist?.tarball;
  if (typeof tarball !== 'string' || tarball === '') throw new Error('registry 元数据里没有 dist.tarball');

  const res = await fetch(tarball, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载 tarball 失败：${res.status}`);
  const file = path.join(dir, `${PKG_NAME}.tgz`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));

  try {
    execFileSync('tar', ['-xzf', file, '-C', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    throw new Error(`解包失败（Windows 10 1803+ 自带 tar）：${error?.message ?? error}`);
  }
}

function report({ target, pkgDir, out, exists, readFile, listFiles }) {
  const buildDir = path.join(pkgDir, 'build');
  let jsFiles = [];
  try {
    jsFiles = listFiles(buildDir);
  } catch {
    jsFiles = [];
  }
  const read = (file) => {
    try {
      return readFile(file);
    } catch {
      return null;
    }
  };

  let version = null;
  const manifest = read(path.join(pkgDir, 'package.json'));
  if (manifest !== null) {
    try {
      version = JSON.parse(manifest)?.version ?? null;
    } catch {
      version = null;
    }
  }

  // 分类定义：先看已知路径，找不到就在产物里搜（上游可能改目录或改成单文件打包）。
  let categoryOptionsPath = null;
  let categoryOptionsText = null;
  const known = path.join(buildDir, 'src', 'config', 'category-options.js');
  if (exists(known)) {
    categoryOptionsPath = known;
    categoryOptionsText = read(known);
  } else {
    for (const file of jsFiles) {
      const text = read(file);
      if (text !== null && /ToolCategory\.EXTENSIONS|categoryOverrides/.test(text)) {
        categoryOptionsPath = file;
        categoryOptionsText = text;
        break;
      }
    }
  }

  let conflictTokenPath = null;
  for (const file of jsFiles) {
    const text = read(file);
    if (text !== null && text.includes(CONFLICT_TOKEN)) {
      conflictTokenPath = file;
      break;
    }
  }

  const result = reconcileVerdict({ categoryOptionsPath, categoryOptionsText, conflictTokenPath });
  const conflictsText =
    result.conflicts === null ? '（没读到分类定义）' : result.conflicts.length === 0 ? '无' : result.conflicts.join(', ');

  out('dsh-cdp 升级预检');
  out(`检查对象：${target}`);
  out(`包目录：${pkgDir}`);
  out(`版本：${version ?? '读不出来'}`);
  out(`分类定义：${categoryOptionsPath ?? '在产物里没找到'}`);
  out(`EXTENSIONS 的 conflicts：${conflictsText}`);
  out(`互斥表令牌 ${CONFLICT_TOKEN}：${conflictTokenPath ?? '未出现'}`);
  out('');

  if (result.verdict === SAFE) {
    out(`结论：安全 —— ${result.reason}`);
    out('升级后仍建议随手调用一次 list_extensions 确认扩展工具真的在。');
    return EXIT.safe;
  }
  if (result.verdict === UNSAFE) {
    out(`结论：不安全 —— ${result.reason}`);
    out('这条组合（--categoryExtensions + --wsEndpoint）就是本行的核心：一旦互斥，这一行会启动即失败。');
    out('处理：要么留在当前版本，要么改走不依赖 --wsEndpoint 的路线（见 README「升级 chrome-devtools-mcp 前先看这条」）。');
    return EXIT.unsafe;
  }
  out(`结论：无法判定 —— ${result.reason}`);
  out('在没有实测确认之前，不要把这一行切到候选版本。');
  return EXIT.undecided;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.out ?? ((line) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line) => process.stderr.write(`${line}\n`));
  const exists = deps.exists ?? fs.existsSync;
  const readFile = deps.readFile ?? ((file) => fs.readFileSync(file, 'utf8'));
  const listFiles = deps.listFiles ?? listJsFiles;
  const pack = deps.pack ?? downloadCandidate;
  const env = deps.env ?? process.env;

  const parsed = parseArgs(argv);
  if (parsed.error) {
    err(`check-upgrade: ${parsed.error}`);
    err(USAGE);
    return EXIT.error;
  }
  if (parsed.mode === 'help') {
    out(USAGE);
    return EXIT.safe;
  }

  if (parsed.mode === 'version') {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cdp-upgrade-check-'));
    try {
      await pack(parsed.version, tmp);
      const pkgDir = path.join(tmp, 'package');
      if (!exists(pkgDir)) throw new Error(`解包后没有找到 package/ 目录：${tmp}`);
      return report({ target: `${PKG_NAME}@${parsed.version}`, pkgDir, out, exists, readFile, listFiles });
    } catch (error) {
      err(`check-upgrade: 预检 ${PKG_NAME}@${parsed.version} 失败：${error?.message ?? error}`);
      return EXIT.error;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  const pkgDir =
    parsed.mode === 'package-dir' ? path.resolve(parsed.packageDir) : resolveInstalledPackageDir({ env, exists, readFile });
  if (pkgDir === null) {
    err(`check-upgrade: 找不到已安装的 ${PKG_NAME}（可用 --package-dir 指定，或 --version 预检候选版本）`);
    return EXIT.error;
  }
  return report({ target: pkgDir, pkgDir, out, exists, readFile, listFiles });
}

function resolveInstalledPackageDir({ env, exists, readFile }) {
  const found = findMcpEntry({ env, searchDirs: dshProfileDirs({ env }) });
  if (found.error) return null;
  return packageDirOf(found.entry, { exists, readFile });
}

// 被测试 import 时不要自己跑起来（只有直接 `node tools/check-upgrade.mjs` 才跑）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
