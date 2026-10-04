// 落盘白名单（chrome-devtools-mcp 的 --workspace 根）的纯逻辑：切分、归一、校验。
//
// 为什么校验要放在这里而不是直接交给 chrome-devtools-mcp：上游对每个根做 realpath，
// 不存在的目录会让**整次调用**失败，错误里还只说"不在已配置的 workspace 根里"，
// 看不出是哪一个路径写错了。所以入口先把用户输入逐条过一遍，一条不合法就整体拒绝。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 按分隔符切一个"路径列表"串（env 与 UI 文本共用同一套规则）：去空白、丢空串。 */
export function splitPathList(value, delimiter = path.delimiter) {
  return String(value ?? '')
    .split(delimiter)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** 目录数组 → 配置页文本域的内容（一行一个）。 */
export function formatWorkspaces(dirs = []) {
  return (dirs ?? []).join('\n');
}

function expandHome(input, home) {
  if (input === '~') return home;
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(home, input.slice(2));
  return input;
}

function unquote(input) {
  const first = input.at(0);
  if (input.length >= 2 && first === input.at(-1) && (first === '"' || first === "'")) return input.slice(1, -1).trim();
  return input;
}

/**
 * 归一 + 校验用户给的目录列表。
 * @param input 文本域内容（多行）或已经切分好的数组
 * @param options.home 用户目录（`~` 展开用）；stat/realpath 可注入以便测试
 * @returns `{ dirs, invalid }`；只要 `invalid` 非空，`dirs` 就是空的
 */
export function normalizeWorkspaces(input, options = {}) {
  const home = options.home ?? os.homedir();
  const stat = options.stat ?? ((target) => fs.statSync(target));
  const realpath = options.realpath ?? ((target) => fs.realpathSync.native(target));
  const caseInsensitive = options.caseInsensitive ?? process.platform === 'win32';

  const lines = (Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/))
    .map((line) => String(line ?? '').trim())
    .filter((line) => line !== '');
  const dirs = [];
  const invalid = [];
  const seen = new Set();
  const key = (target) => (caseInsensitive ? target.toLowerCase() : target);

  for (const line of lines) {
    const raw = unquote(line);
    const expanded = expandHome(raw, home);
    if (!path.isAbsolute(expanded)) {
      invalid.push({ input: raw, reason: 'relative' });
      continue;
    }
    let info;
    try {
      info = stat(expanded);
    } catch (error) {
      invalid.push({ input: raw, reason: error?.code === 'ENOENT' ? 'missing' : 'unreadable' });
      continue;
    }
    if (!info.isDirectory()) {
      invalid.push({ input: raw, reason: 'not-a-directory' });
      continue;
    }
    const resolved = realpath(expanded);
    if (seen.has(key(resolved))) continue;
    seen.add(key(resolved));
    dirs.push(resolved);
  }

  // 一条不合法就整体拒绝：宁可让用户改完再存，也不要写进去一半白名单。
  return invalid.length > 0 ? { dirs: [], invalid } : { dirs, invalid: [] };
}
