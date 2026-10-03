// Windows 上 spawn 一个 .cmd/.bat 会得到 EINVAL —— Node 在 CVE-2024-27980 之后禁掉了这条路径，
// 必须显式 `shell: true` 交给 cmd.exe。而 `npx` / `npm` / `pnpm` 在 Windows 上恰好就是 .cmd，
// 于是"起一个 MCP 服务器"这种最普通的用法会撞上它。
//
// 这里只做判断，不碰进程：走 shell 是有代价的（参数会被 cmd.exe 再解析一遍），所以只在真的
// 需要时才开，并且由调用方用 quoteForCmd 把参数包好。
import fs from 'node:fs';
import path from 'node:path';

// 近似 cmd.exe 的 PATHEXT 顺序：.exe 优先，.cmd/.bat 最后 —— 同目录里两者都在时不该选 .cmd。
const EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];

export function resolveOnPath(command, { env = process.env, exists = fs.existsSync } = {}) {
  const text = String(command ?? '');
  if (text === '') return null;
  const dirs = String(env?.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => dir !== '');
  const hasExtension = path.extname(text) !== '';
  for (const dir of dirs) {
    // 没有扩展名时**只**看 PATHEXT 变体：Windows 上 `npx` 这种无扩展名文件（npm 自带的
    // sh 脚本）根本不是一个可执行候选 —— cmd.exe 找的是 npx.cmd。按"先命中先返回"会把
    // 它选中，然后 spawn 直接 ENOENT。
    const candidates = hasExtension ? [text] : EXTENSIONS.map((ext) => `${text}${ext}`);
    for (const name of candidates) {
      const full = path.join(dir, name);
      try {
        if (exists(full)) return full;
      } catch {
        // 不可读的 PATH 条目直接跳过
      }
    }
  }
  return null;
}

export function needsWindowsShell({
  command,
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync,
} = {}) {
  if (platform !== 'win32') return false;
  const text = String(command ?? '');
  if (text === '') return false;
  if (/\.(cmd|bat)$/i.test(text)) return true;
  // 带路径的其它扩展名（.exe/.com）不需要 shell，也不该去查 PATH。
  if (/[\\/]/.test(text)) return false;
  const resolved = resolveOnPath(text, { env, exists });
  return resolved !== null && /\.(cmd|bat)$/i.test(resolved);
}

// shell 模式下 Node 只是把参数用空格拼起来，所以要自己保证 cmd.exe 不会把参数拆开或当成
// 命令分隔符。cmd 的转义规则晦涩，这里只做够用的一层：不安全的整体加双引号，内部双引号翻倍。
export function quoteForCmd(argument) {
  const text = String(argument ?? '');
  if (text === '') return '""';
  if (/^[A-Za-z0-9_\-.:\\/+=@,]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}
