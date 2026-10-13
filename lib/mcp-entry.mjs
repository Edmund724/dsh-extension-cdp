// 定位 chrome-devtools-mcp 的入口脚本。
// 本包在 package.json 的 dependencies 里钉着 chrome-devtools-mcp，所以第一候选是本包自己的
// node_modules（见 selfPackageDirs）；profile 里别处装的那份只是兜底。
// 入口路径不要写死（版本升级会换目录）：从它 package.json 的 bin['chrome-devtools-mcp'] 推导。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_NAME = 'chrome-devtools-mcp';

// DSH 自己的 profile 目录树：<dsh home>/profiles/<name>，交回给 findMcpEntry 去拼候选。
// 这一条刻意不依赖任何 DSH_* 环境变量：MCP 客户端会给子进程做环境清洗（DSH_* 名字全部
// 丢掉），所以 DSH_PROFILE_DIR 在真实运行路径上永远拿不到 —— 只靠它就必然会"找不到入口"
// 然后无限退避重试。os.homedir() 是清洗漏不掉的锚点。
export function dshProfileDirs({ env = {}, home = os.homedir(), dshHome, readdir = fs.readdirSync } = {}) {
  const root = dshHome ?? env.DSH_HOME ?? path.join(home, '.dsh');
  const profiles = path.join(root, 'profiles');
  let entries;
  try {
    entries = readdir(profiles, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(profiles, entry.name));
}

// 读 <dir>/package.json 的 bin，拼出绝对入口路径。
export function resolveEntryFromPackageJson(dir, { readFile = fs.readFileSync } = {}) {
  const file = path.join(dir, 'package.json');
  let raw;
  try {
    raw = readFile(file, 'utf8');
  } catch (err) {
    throw new Error(`读不到 ${file}：${err?.message ?? err}`);
  }

  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} 不是合法 JSON：${err?.message ?? err}`);
  }

  const bin = pkg?.bin;
  let rel;
  if (typeof bin === 'string') {
    // 字符串 bin 只说明"这个包只有一个可执行文件"，不能证明它就是我们要的入口，
    // 只有包名对得上才认。
    if (pkg?.name !== PKG_NAME) {
      throw new Error(`${file} 的 bin 是字符串但包名是 ${JSON.stringify(pkg?.name)}，无法确认是 ${PKG_NAME} 入口`);
    }
    rel = bin;
  } else if (bin && typeof bin === 'object') {
    rel = bin[PKG_NAME];
    if (typeof rel !== 'string' || rel === '') {
      throw new Error(`${file} 的 bin 里没有 ${PKG_NAME} 入口`);
    }
  } else {
    throw new Error(`${file} 缺 bin 字段，无法推导 ${PKG_NAME} 入口`);
  }

  return path.resolve(dir, rel);
}

function ancestors(start, limit = 12) {
  const out = [];
  let dir = path.resolve(start);
  for (let i = 0; i < limit; i += 1) {
    out.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

// 本包自己的目录链：`lib/` 的上一层就是包根，再往上是它的父目录（顶到包根上面两层为止）。
// 依赖的三种落点都在这条链上：包根/node_modules（本地 `pnpm install` 与 isolated 布局）、
// 以及包根自己落在 <profile>/node_modules 里时的那个 node_modules（hoisted 布局）。
export function selfPackageDirs({ moduleUrl = import.meta.url, limit = 4 } = {}) {
  return ancestors(path.dirname(fileURLToPath(moduleUrl)), limit);
}

// 按优先级找入口，找不到返回 { error }（不抛错，交给调用方决定怎么报）。
// 优先级：DSH_CDP_MCP_ENTRY > selfDirs > searchDirs > DSH_PROFILE_DIR > 从 execPath 向上找。
export function findMcpEntry({
  env = {},
  searchDirs = [],
  selfDirs = selfPackageDirs(),
  readFile = fs.readFileSync,
  exists = fs.existsSync,
  execPath = process.execPath,
} = {}) {
  const override = String(env.DSH_CDP_MCP_ENTRY ?? '').trim();
  if (override !== '') {
    if (exists(override)) return { entry: path.resolve(override) };
    return { error: `DSH_CDP_MCP_ENTRY 指向的文件不存在：${override}` };
  }

  const candidates = [];
  const add = (dir) => {
    if (!dir) return;
    candidates.push(dir);
    candidates.push(path.join(dir, 'node_modules', PKG_NAME));
    // 目录本身就是 node_modules 时，它下面直接就是各个包（pnpm 的 isolated 布局）。
    if (path.basename(dir) === 'node_modules') candidates.push(path.join(dir, PKG_NAME));
  };

  // 本包自己的依赖树排在最前：它是本插件钉住并测过的那份；profile 里别处装的（官方
  // browser-use bundle 也会装一份）版本可能不同，只当兜底。
  for (const dir of selfDirs ?? []) add(dir);
  for (const dir of searchDirs ?? []) add(dir);
  add(env.DSH_PROFILE_DIR);
  // execPath 本身就是 node（不在 node_modules 里）时，同级 node_modules 已由 add(level) 覆盖。
  for (const level of ancestors(path.dirname(execPath))) add(level);

  const tried = [];
  for (const dir of candidates) {
    if (tried.includes(dir)) continue;
    tried.push(dir);
    const manifest = path.join(dir, 'package.json');
    if (!exists(manifest)) continue;
    try {
      return { entry: resolveEntryFromPackageJson(dir, { readFile }) };
    } catch (err) {
      // 这个候选目录不是我们要的包，继续往下找
      void err;
    }
  }

  return {
    error:
      `找不到 ${PKG_NAME} 入口。已尝试：\n` +
      tried.map((dir) => `  - ${dir}`).join('\n') +
      '\n可用 DSH_CDP_MCP_ENTRY 直接指定入口文件。',
  };
}
