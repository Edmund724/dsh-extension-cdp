// 落盘白名单目录列表的失败方式清单（先列再写测试）：
// 1. 空文本 / 只有空行 → 合法空列表（等于没有额外白名单），不能抛；
// 2. CRLF、行尾空格、前后空行 → 丢掉，不算错误；
// 3. 重复目录（Windows 大小写不敏感）→ 只留一条；
// 4. `~` / `~/Desktop` / `~\Desktop` → 展开成用户目录；
// 5. 相对路径 → 报 relative（否则会被 chrome-devtools-mcp 按 cwd 解析成别的目录）；
// 6. 目录不存在 → 报 missing（上游对每个根做 realpath，不存在的根会让整个调用失败）；
// 7. 路径指向文件 → 报 not-a-directory；
// 8. 结尾多一个分隔符 / 带 `..` → 归一后与不带时判为同一个目录；
// 9. 从资源管理器复制来的带引号路径 → 去引号，不当成路径的一部分；
// 10. 只要有一条不合法，dirs 必须是空的（整体拒绝，绝不"能写几条写几条"）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { formatWorkspaces, normalizeWorkspaces, splitPathList } from '../lib/workspaces.mjs';

// 假文件系统：只认列出来的目录（files 里的是文件），realpath 去掉结尾分隔符，
// 不认识的路径抛 ENOENT —— 与 fs.statSync 的失败方式一致。
function fakeFs(dirs, files = []) {
  const caseInsensitive = process.platform === 'win32';
  const key = (candidate) => (caseInsensitive ? candidate.toLowerCase() : candidate);
  const known = new Set(dirs.map(key));
  const fileSet = new Set(files.map(key));
  const bare = (candidate) => candidate.replace(/[\\/]+$/, '');
  return {
    home: 'C:\\Users\\tester',
    stat: (candidate) => {
      const name = key(bare(candidate));
      if (known.has(name)) return { isDirectory: () => true };
      if (fileSet.has(name)) return { isDirectory: () => false };
      const error = new Error(`ENOENT: ${candidate}`);
      error.code = 'ENOENT';
      throw error;
    },
    realpath: (candidate) => bare(candidate),
  };
}

const fsWith = fakeFs(['C:\\shots', 'C:\\Users\\tester', 'C:\\Users\\tester\\Desktop', 'd:\\ext\\dist']);

test('空输入是合法空列表', () => {
  for (const input of ['', '   ', '\n\n', [], ['', '  ']]) {
    const result = normalizeWorkspaces(input, fsWith);
    assert.deepEqual(result.dirs, []);
    assert.deepEqual(result.invalid, []);
  }
});

test('CRLF、行尾空白、前后空行都会被丢掉', () => {
  const result = normalizeWorkspaces('C:\\shots\r\n\r\n  C:\\shots  \r\n', fsWith);
  // 归一后是同一个目录，去重成一条
  assert.deepEqual(result.dirs, ['C:\\shots']);
  assert.deepEqual(result.invalid, []);
});

test('重复目录只留一条（Windows 大小写不敏感）', () => {
  const result = normalizeWorkspaces(['C:\\shots', 'c:\\SHOTS'], fsWith);
  assert.deepEqual(result.dirs, ['C:\\shots']);
  assert.equal(result.invalid.length, 0);
});

test('~ / ~/Desktop / ~\\Desktop 展开成用户目录', () => {
  const cases = [
    ['~', 'C:\\Users\\tester'],
    ['~/Desktop', 'C:\\Users\\tester\\Desktop'],
    ['~\\Desktop', 'C:\\Users\\tester\\Desktop'],
  ];
  for (const [input, expected] of cases) {
    const result = normalizeWorkspaces(input, fsWith);
    assert.deepEqual(result.dirs, [expected], `${input} 应展开成 ${expected}`);
    assert.deepEqual(result.invalid, []);
  }
});

test('相对路径被拒绝', () => {
  const result = normalizeWorkspaces(['shots', 'C:\\shots'], fsWith);
  assert.deepEqual(result.dirs, [], '有一条不合法就整体拒绝');
  assert.deepEqual(result.invalid, [{ input: 'shots', reason: 'relative' }]);
});

test('不存在的目录被拒绝', () => {
  const result = normalizeWorkspaces('C:\\shots\nC:\\nope', fsWith);
  assert.deepEqual(result.dirs, []);
  assert.deepEqual(result.invalid, [{ input: 'C:\\nope', reason: 'missing' }]);
});

test('指向文件的路径被拒绝', () => {
  const withFile = fakeFs(['C:\\shots'], ['C:\\shots\\a.txt']);
  const result = normalizeWorkspaces(['C:\\shots\\a.txt'], withFile);
  assert.deepEqual(result.dirs, []);
  assert.deepEqual(result.invalid, [{ input: 'C:\\shots\\a.txt', reason: 'not-a-directory' }]);
});

test('结尾分隔符与 .. 归一到同一个目录', () => {
  const result = normalizeWorkspaces(['C:\\shots\\', 'C:\\shots'], fsWith);
  assert.deepEqual(result.dirs, ['C:\\shots']);
  assert.deepEqual(result.invalid, []);
});

test('带引号的路径会去引号', () => {
  const result = normalizeWorkspaces('"C:\\shots"', fsWith);
  assert.deepEqual(result.dirs, ['C:\\shots']);
  assert.deepEqual(result.invalid, []);
});

test('formatWorkspaces 与 normalizeWorkspaces 互补', () => {
  assert.equal(formatWorkspaces([]), '');
  assert.equal(formatWorkspaces(['C:\\shots', 'D:\\ext\\dist']), 'C:\\shots\nD:\\ext\\dist');
});

test('splitPathList：按分隔符切、去空白、丢空串', () => {
  assert.deepEqual(splitPathList(''), []);
  assert.deepEqual(splitPathList('C:\\shots'), ['C:\\shots']);
  assert.deepEqual(splitPathList(`C:\\shots${path.delimiter}C:\\x${path.delimiter}`), ['C:\\shots', 'C:\\x']);
  assert.deepEqual(splitPathList(`  C:\\shots ${path.delimiter} `), ['C:\\shots']);
});
