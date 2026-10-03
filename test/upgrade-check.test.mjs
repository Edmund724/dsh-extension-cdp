// lib/upgrade-check.mjs + tools/check-upgrade.mjs 的失败方式清单（先列再写测试）：
// 1. 把 PWA 分类的 conflicts 当成 EXTENSIONS 的 —— 误报"不安全"；
// 2. 漏掉 EXTENSIONS 的 conflicts —— 漏报，升级当天这一行直接起不来（我们唯一的持续风险）；
// 3. 花括号匹配被嵌套对象/字符串里的 `}` 骗过，切块切错；
// 4. 注释掉的条目被当真（假冲突）；
// 5. 找不到 EXTENSIONS 条目时给"安全"—— 产物结构变了必须判"无法判定"，绝不能给假绿灯；
// 6. 产物里出现 CONFLICTING_ARGS 互斥表时仍给"安全"（上游 main 就是这套机制）；
// 7. conflicts: [] 被当成有问题；只跟 autoConnect 互斥（本行不传它）被当成"不安全"；
// 8. `--version` 的值没校验就拼进 npm 参数；缺值 / 未知参数没报错；
// 9. npm pack 失败时消息不可诊断、或临时目录没清理；
// 10. 退出码把"无法判定"和"不安全"混为一谈（脚本会误判）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findCategoryBlock, parseConflicts, stripComments, reconcileVerdict } from '../lib/upgrade-check.mjs';
import { parseArgs, main } from '../tools/check-upgrade.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

// 1.10.1 的真实形态：PWA 带 conflicts，EXTENSIONS 不带（所以这一行合法）。
const CATEGORY_OPTIONS_1_10_1 = `/**
 * @license
 */
import { ToolCategory } from '../tools/categories.js';
const categoryOverrides = {
    [ToolCategory.INPUT]: {
        hidden: false,
    },
    [ToolCategory.EXTENSIONS]: {
        describe: 'Set to true to include tools related to extensions. Note: This feature is currently only supported with a pipe connection.',
        hidden: false,
        offByDefault: true,
    },
    [ToolCategory.PWA]: {
        describe: 'Set to true to include tools for automating Progressive Web Apps.',
        conflicts: ['autoConnect', 'browserUrl', 'wsEndpoint'],
        hidden: false,
        offByDefault: true,
    },
};
export function categoryToFlagName(category) {
    return \`category\${category.charAt(0).toUpperCase()}\${category.slice(1)}\`;
}
`;

// 上游 main 的形态（假设）：EXTENSIONS 也被加了互斥。
const CATEGORY_OPTIONS_WITH_CONFLICT = CATEGORY_OPTIONS_1_10_1.replace(
  `        describe: 'Set to true to include tools related to extensions. Note: This feature is currently only supported with a pipe connection.',
        hidden: false,`,
  `        describe: 'Set to true to include tools related to extensions.',
        conflicts: ['autoConnect', 'browserUrl', 'wsEndpoint'],
        hidden: false,`,
);

// 只跟 autoConnect 互斥（本行不传它）：应当仍然安全，但要把差异说清楚。
const CATEGORY_OPTIONS_AUTOCONNECT_ONLY = `const categoryOverrides = {
    [ToolCategory.EXTENSIONS]: {
        describe: 'extensions',
        conflicts: ['autoConnect'],
        hidden: false,
        offByDefault: true,
    },
};
`;

// 注释里写了冲突、真条目其实没问题：不能被注释骗成"不安全"。
const CATEGORY_OPTIONS_COMMENTED = `const categoryOverrides = {
    // [ToolCategory.EXTENSIONS]: { conflicts: ['wsEndpoint'], hidden: false },
    /* [ToolCategory.EXTENSIONS]: { conflicts: ['browserUrl'] }, */
    [ToolCategory.EXTENSIONS]: {
        describe: 'safe now',
        hidden: false,
    },
};
`;

// 块里嵌套对象、属性值里带 `}` 的字符串：花括号匹配不能被骗。
const CATEGORY_OPTIONS_NESTED = `const categoryOverrides = {
    [ToolCategory.EXTENSIONS]: {
        describe: 'braces } and { and [ToolCategory.EXTENSIONS] inside a string',
        nested: { deeper: { x: '}' } },
        conflicts: [],
        hidden: false,
    },
};
`;

// 结构变了（没有 EXTENSIONS 条目）：必须"无法判定"，不能给安全。
const CATEGORY_OPTIONS_RENAMED = `const categoryOverrides = {
    [ToolCategory.SOMETHING_ELSE]: { hidden: false },
};
`;

function writePackageDir(root, { version = '9.9.9', categoryOptions = CATEGORY_OPTIONS_1_10_1, extra = {} } = {}) {
  fs.mkdirSync(path.join(root, 'build', 'src', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'chrome-devtools-mcp', version }));
  if (categoryOptions !== null) {
    fs.writeFileSync(path.join(root, 'build', 'src', 'config', 'category-options.js'), categoryOptions);
  }
  for (const [rel, text] of Object.entries(extra)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return root;
}

function tempPackageDir(options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cdp-upgrade-'));
  return writePackageDir(root, options);
}

// --- 纯解析 ---

test('stripComments: 行注释与块注释都不再参与匹配', () => {
  const out = stripComments('a // [ToolCategory.EXTENSIONS]\nb /* x */ c');
  assert.equal(out.includes('EXTENSIONS]'), false);
  assert.match(out, /a/);
  assert.match(out, /c/);
});

test('findCategoryBlock: 只取 EXTENSIONS 那个块，不被嵌套的 } 截断', () => {
  const block = findCategoryBlock(CATEGORY_OPTIONS_NESTED, 'EXTENSIONS');
  assert.ok(block, '应当找到 EXTENSIONS 块');
  assert.match(block, /conflicts/);
  assert.match(block, /nested/);
  const pwa = findCategoryBlock(CATEGORY_OPTIONS_1_10_1, 'PWA');
  assert.match(pwa, /wsEndpoint/);
  const ext = findCategoryBlock(CATEGORY_OPTIONS_1_10_1, 'EXTENSIONS');
  assert.equal(/wsEndpoint/.test(ext), false, 'EXTENSIONS 块里不该混进 PWA 的 conflicts');
});

test('findCategoryBlock: 注释里的条目不算数', () => {
  const block = findCategoryBlock(CATEGORY_OPTIONS_COMMENTED, 'EXTENSIONS');
  assert.match(block, /safe now/);
  assert.equal(/conflicts/.test(block), false);
});

test('findCategoryBlock: 找不到就返回 null', () => {
  assert.equal(findCategoryBlock(CATEGORY_OPTIONS_RENAMED, 'EXTENSIONS'), null);
  assert.equal(findCategoryBlock('', 'EXTENSIONS'), null);
});

test('parseConflicts: 有/无/空数组', () => {
  assert.deepEqual(parseConflicts(`[ToolCategory.EXTENSIONS]: { conflicts: ['a', "b"] }`), ['a', 'b']);
  assert.deepEqual(parseConflicts(`[ToolCategory.EXTENSIONS]: { conflicts: [] }`), []);
  assert.equal(parseConflicts(`[ToolCategory.EXTENSIONS]: { hidden: false }`), null);
});

test('reconcileVerdict: 三态判定与理由', () => {
  const base = { categoryOptionsPath: 'x/category-options.js', categoryOptionsText: CATEGORY_OPTIONS_1_10_1 };

  const safe = reconcileVerdict(base);
  assert.equal(safe.verdict, 'safe');
  assert.deepEqual(safe.conflicts, []);

  const unsafe = reconcileVerdict({ ...base, categoryOptionsText: CATEGORY_OPTIONS_WITH_CONFLICT });
  assert.equal(unsafe.verdict, 'unsafe');
  assert.deepEqual(unsafe.conflicts, ['autoConnect', 'browserUrl', 'wsEndpoint']);
  assert.match(unsafe.reason, /wsEndpoint/);

  // 只跟 autoConnect 互斥：本行不传它，仍然安全，但要把差异说清楚。
  const auto = reconcileVerdict({ ...base, categoryOptionsText: CATEGORY_OPTIONS_AUTOCONNECT_ONLY });
  assert.equal(auto.verdict, 'safe');
  assert.deepEqual(auto.conflicts, ['autoConnect']);
  assert.match(auto.reason, /autoConnect/);

  const emptyConflicts = reconcileVerdict({ ...base, categoryOptionsText: CATEGORY_OPTIONS_NESTED });
  assert.equal(emptyConflicts.verdict, 'safe');

  // 结构变了：不许给绿灯。
  const renamed = reconcileVerdict({ ...base, categoryOptionsText: CATEGORY_OPTIONS_RENAMED });
  assert.equal(renamed.verdict, 'unknown');

  // 缺文件也是"无法判定"。
  assert.equal(reconcileVerdict({ categoryOptionsPath: null, categoryOptionsText: null }).verdict, 'unknown');

  // 互斥表令牌在别处出现：不敢替人判定。
  const token = reconcileVerdict({ ...base, conflictTokenPath: 'x/mcp-options.js' });
  assert.equal(token.verdict, 'review');
  assert.match(token.reason, /CONFLICTING_ARGS/);

  // 但真冲突优先于令牌提示。
  assert.equal(
    reconcileVerdict({ ...base, categoryOptionsText: CATEGORY_OPTIONS_WITH_CONFLICT, conflictTokenPath: 'x/y.js' }).verdict,
    'unsafe',
  );
});

// --- CLI 参数 ---

test('parseArgs: 三种模式与非法输入', () => {
  assert.deepEqual(parseArgs([]), { mode: 'installed' });
  assert.deepEqual(parseArgs(['--version', '1.11.0']), { mode: 'version', version: '1.11.0' });
  assert.deepEqual(parseArgs(['--package-dir', 'D:\\x']), { mode: 'package-dir', packageDir: 'D:\\x' });
  assert.equal(parseArgs(['--help']).mode, 'help');

  for (const argv of [
    ['--version'],
    ['--package-dir'],
    ['--nope'],
    ['--version', '1.11'],
    ['--version', 'v1.11.0'],
    ['--version', '1.11.0; rm -rf /'],
    ['--version', '../1.11.0'],
  ]) {
    const parsed = parseArgs(argv);
    assert.ok(parsed.error, `应当报错：${argv.join(' ')}`);
  }
});

// --- CLI 端到端（不联网：pack / fs 全部注入） ---

function cliDeps(extra = {}) {
  const out = [];
  const err = [];
  return {
    out,
    err,
    deps: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      exists: fs.existsSync,
      readFile: (file) => fs.readFileSync(file, 'utf8'),
      listFiles: (dir) => listFilesRecursive(dir),
      ...extra,
    },
  };
}

function listFilesRecursive(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return found;
}

test('CLI: 1.10.1 形态 -> exit 0', async () => {
  const dir = tempPackageDir({ version: '1.10.1' });
  const { deps, out } = cliDeps();
  try {
    const code = await main(['--package-dir', dir], deps);
    assert.equal(code, 0, out.join('\n'));
    assert.match(out.join('\n'), /1\.10\.1/);
    assert.match(out.join('\n'), /安全/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: 带互斥的候选 -> exit 1，并说清后果', async () => {
  const dir = tempPackageDir({ version: '1.11.0', categoryOptions: CATEGORY_OPTIONS_WITH_CONFLICT });
  const { deps, out } = cliDeps();
  try {
    const code = await main(['--package-dir', dir], deps);
    assert.equal(code, 1, out.join('\n'));
    const text = out.join('\n');
    assert.match(text, /不安全/);
    assert.match(text, /wsEndpoint/);
    assert.match(text, /categoryExtensions/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: 结构变了 -> exit 2（不是 0，也不是 1）', async () => {
  const dir = tempPackageDir({ categoryOptions: CATEGORY_OPTIONS_RENAMED });
  const { deps, out } = cliDeps();
  try {
    assert.equal(await main(['--package-dir', dir], deps), 2, out.join('\n'));
    assert.match(out.join('\n'), /无法判定/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: 产物里出现 CONFLICTING_ARGS -> exit 2，提示人工实测', async () => {
  const dir = tempPackageDir({
    extra: { [path.join('build', 'src', 'config', 'mcp-options.js')]: `export const CONFLICTING_ARGS = [['categoryExtensions','wsEndpoint']];` },
  });
  const { deps, out } = cliDeps();
  try {
    assert.equal(await main(['--package-dir', dir], deps), 2, out.join('\n'));
    assert.match(out.join('\n'), /CONFLICTING_ARGS/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --version 走 pack，检查完清理临时目录', async () => {
  let packed = null;
  const { deps, out } = cliDeps({
    pack: async (version, dir) => {
      packed = { version, dir };
      // 与真实解包一致：tarball 里的内容落在 <dir>/package 下。
      writePackageDir(path.join(dir, 'package'), { version, categoryOptions: CATEGORY_OPTIONS_WITH_CONFLICT });
    },
  });
  const code = await main(['--version', '1.11.0'], deps);
  assert.equal(code, 1, out.join('\n'));
  assert.equal(packed.version, '1.11.0');
  assert.equal(fs.existsSync(packed.dir), false, '临时目录必须清理');
});

test('CLI: pack 失败 -> exit 3，临时目录仍然清理，消息可诊断', async () => {
  let packed = null;
  const { deps, err } = cliDeps({
    pack: async (version, dir) => {
      packed = { dir };
      throw new Error('npm pack 退出码 1：No matching version found for chrome-devtools-mcp@9.9.9');
    },
  });
  const code = await main(['--version', '9.9.9'], deps);
  assert.equal(code, 3);
  assert.equal(fs.existsSync(packed.dir), false, '临时目录必须清理');
  assert.match(err.join('\n'), /9\.9\.9/);
});

test('CLI: 参数错误 -> exit 3 且给出用法', async () => {
  const { deps, err } = cliDeps();
  assert.equal(await main(['--nope'], deps), 3);
  assert.match(err.join('\n'), /用法|usage/i);
});

test('CLI: --help -> exit 0', async () => {
  const { deps, out } = cliDeps();
  assert.equal(await main(['--help'], deps), 0);
  assert.match(out.join('\n'), /check-upgrade/);
});

test('check-upgrade.mjs: 不写死入口文件名、不自己建 CDP 连接', () => {
  const text = fs.readFileSync(path.join(HERE, '..', 'tools', 'check-upgrade.mjs'), 'utf8');
  assert.equal(/chrome-devtools-mcp\.js/.test(text), false, '入口路径要从 bin 推导，不能写死');
  assert.equal(/new WebSocket\(/.test(text), false);
});

test('package.json: 新工具被 files 覆盖', () => {
  assert.ok(pkg.files.includes('tools/*.mjs'));
  assert.ok(pkg.files.includes('lib/**'));
});
