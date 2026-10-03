// 升级 chrome-devtools-mcp 之前的判定逻辑（纯函数，不做任何 I/O，便于注入测试）。
//
// 背景：`--categoryExtensions` + `--wsEndpoint` 是本行（dsh-cdp）的核心参数组合。上游在
// 未发布的 main 上给 EXTENSIONS 分类加了互斥表，一旦发出来，这一行会启动即失败。
// 所以升级前要看一眼候选产物：那个分类到底有没有 conflicts。
//
// 判定的分寸很重要 —— 这是一个"绿灯"工具，给错绿灯比不给绿灯危害大得多：
//   unsafe  ：EXTENSIONS 明确带上了 wsEndpoint/browserUrl 互斥 —— 这一行会坏；
//   review  ：产物里有互斥表这类机制，但这个脚本看不透它是否影响我们的参数组合；
//   unknown ：产物结构变了，连分类定义都找不到；
//   safe    ：EXTENSIONS 块读到了、没有互斥，且产物里也没有互斥表这类机制。
// 只有 safe 才是绿灯；review/unknown 都要人再看一眼。
export const SAFE = 'safe';
export const UNSAFE = 'unsafe';
export const REVIEW = 'review';
export const UNKNOWN = 'unknown';

// 本行真正会传给 chrome-devtools-mcp 的互斥相关参数（见 lib/args.mjs 与 cordis.patch.yml）。
// autoConnect 不在此列：本行走的是 connect.mjs 自己拼的 --wsEndpoint。
export const ATTACH_FLAGS = ['wsEndpoint', 'browserUrl'];

// 上游 main 上那个互斥表的名字。只做大小写敏感的整词匹配，避免误伤第三方代码。
export const CONFLICT_TOKEN = 'CONFLICTING_ARGS';

// 去掉 // 行注释与 /* */ 块注释：注释里被注释掉的条目不能参与判定。
// 不追求完整的 JS 词法分析 —— 只处理这两种注释，够用且可预测。
export function stripComments(source) {
  const text = String(source ?? '');
  let out = '';
  let i = 0;
  while (i < text.length) {
    const pair = text.slice(i, i + 2);
    if (pair === '//') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (pair === '/*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    // 字符串里的 // 与 /* 会被误当注释。产物里唯一的风险是 describe 文案，它不影响
    // conflicts 判定（conflicts 是数组字面量），所以不为它引入一个完整词法分析器。
    out += text[i];
    i += 1;
  }
  return out;
}

// 从 `[ToolCategory.<category>]:` 后面取出那个对象字面量（含花括号），用括号配对切块。
// 找不到返回 null —— 调用方必须把 null 当成"无法判定"，不能当成"没有互斥"。
export function findCategoryBlock(source, category) {
  const text = stripComments(source);
  const needle = new RegExp(`\\[\\s*(?:ToolCategory\\.)?${category}\\s*\\]\\s*:|(?:^|[\\s,{])${category}\\s*:`);
  const match = needle.exec(text);
  if (!match) return null;

  const start = text.indexOf('{', match.index + match[0].length - 1);
  if (start === -1) return null;

  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (quote !== null) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// 从块里读 `conflicts:` 的字符串数组。返回 null = 没有 conflicts 键（这类分类不互斥）。
export function parseConflicts(block) {
  const text = String(block ?? '');
  const match = /conflicts\s*:\s*\[([^\]]*)\]/.exec(text);
  if (!match) return null;
  return [...match[1].matchAll(/['"`]([^'"`]*)['"`]/g)].map((m) => m[1]);
}

// 把读到的材料合成一个判定。这是唯一决定"绿灯"的地方。
export function reconcileVerdict({
  categoryOptionsPath = null,
  categoryOptionsText = null,
  conflictTokenPath = null,
} = {}) {
  if (categoryOptionsPath === null || categoryOptionsText === null) {
    return {
      verdict: UNKNOWN,
      conflicts: null,
      reason: '没找到分类定义文件（产物结构可能变了），这个脚本不敢替你判定。',
    };
  }

  const block = findCategoryBlock(categoryOptionsText, 'EXTENSIONS');
  if (block === null) {
    return {
      verdict: UNKNOWN,
      conflicts: null,
      reason: '分类定义里找不到 EXTENSIONS 条目（产物结构可能变了），这个脚本不敢替你判定。',
    };
  }

  const conflicts = parseConflicts(block);
  const hit = (conflicts ?? []).filter((flag) => ATTACH_FLAGS.includes(flag));
  if (hit.length > 0) {
    return {
      verdict: UNSAFE,
      conflicts: conflicts ?? [],
      reason:
        `EXTENSIONS 分类带 conflicts: ${(conflicts ?? []).join(', ')}，` +
        `其中 ${hit.join('、')} 正是本行要用的参数 —— 升级后这一行会启动即失败。`,
    };
  }

  if (conflictTokenPath !== null) {
    return {
      verdict: REVIEW,
      conflicts: conflicts ?? [],
      reason:
        `产物里出现了 ${CONFLICT_TOKEN} 互斥表（${conflictTokenPath}），但分类定义里看不到 EXTENSIONS 的 conflicts。` +
        '这个脚本看不透那张表是否覆盖本行的参数组合，请在一次性 profile 上实测一次再升级。',
    };
  }

  return {
    verdict: SAFE,
    conflicts: conflicts ?? [],
    reason:
      conflicts === null || conflicts.length === 0
        ? 'EXTENSIONS 分类没有互斥表，也没有其它互斥机制 —— --categoryExtensions + --wsEndpoint 仍然合法。'
        : `EXTENSIONS 只与 ${conflicts.join('、')} 互斥，本行不传这些参数，不受影响。`,
  };
}
