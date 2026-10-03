// "首次工具调用挂住"诊断：日常 profile 走 approval 模式，那条 CDP 连接要用户在浏览器里
// 点掉"是否允许远程调试？"才会建立。这段沉默只发生在**第一条真正建连的 tools/call**上，
// 表现为调用既不回结果也不报错 —— 看起来就像卡死了。
//
// 这一层看不见握手（握手由 chrome-devtools-mcp 惰性发起），只看得到一个可观测事实：
// "某个已转发的 tools/call 布点之后到点都没有响应，而且到目前为止没有任何 tools/call
// 响应回来过"。于是它只做一件事：把这段沉默翻译成人能看懂的一句话，经 stderr 交给用户。
//
// 三条硬约束：
// 1. 只写 stderr —— stdout 是 MCP 帧通道，多一个字节都算协议污染；
// 2. 绝不改动、拦截、吞掉任何帧（提示与转发是两条独立的路）；
// 3. 绝不谎报失败 —— 这次调用仍在等，只是提醒"去看一眼浏览器"。
//
// 为什么用"从没有过响应"来判定，而不是"第一次调用"：client 侧会超时并重试，重试的
// 调用同样是"还没有任何一次成功"。所以判定条件是状态（至今零响应），不是序号。
export const DEFAULT_APPROVAL_HINT_MS = 10000;

// 记忆多少个被监控过的调用 id（用于识别"这次终于回来了"）。只为在"至今零响应"阶段
// 兜住迟到的响应，正常情况下远小于这个数。
const WATCHED_ID_LIMIT = 64;

const isObject = (value) => typeof value === 'object' && value !== null;

// undefined/null/空串/非法值 -> 默认；'0' 是明确的"关掉"。
export function parseApprovalHintMs(value) {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_APPROVAL_HINT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_APPROVAL_HINT_MS;
  return parsed;
}

export function approvalHintText({ tool, timeoutMs, browserName = '浏览器' }) {
  const waited = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`;
  return (
    `首次工具调用「${tool}」已等待 ${waited}仍无响应：日常 profile 下这条 CDP 连接需要你在 ${browserName} 里` +
    '点「允许」才会建立，很可能正卡在「是否允许远程调试？」的对话框上。\n' +
    `去看一眼 ${browserName} 窗口，点掉那个框，这次调用就会继续（这条只是提醒，调用本身没有失败）。\n` +
    '别拖太久：DSH 侧对每次调用有期限，拖过了这次调用会作废、要重来。\n' +
    '不想看到这条提醒：把 DSH_CDP_APPROVAL_HINT_MS 设为 0。'
  );
}

export function createHangHint({
  timeoutMs = DEFAULT_APPROVAL_HINT_MS,
  onHint = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const watched = new Set();
  let timer = null;
  let seenCallResponse = false;
  let disposed = false;

  const clearTimerHandle = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const remember = (id) => {
    watched.add(id);
    if (watched.size > WATCHED_ID_LIMIT) watched.delete(watched.values().next().value);
  };

  return {
    // 出方向：只对真正转发给子进程的请求调用（被屏蔽的工具在本地就回了 -32601，没碰 CDP）。
    noteForwardedRequest(line) {
      if (disposed || seenCallResponse || timer !== null || !(timeoutMs > 0)) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!isObject(msg) || msg.method !== 'tools/call') return;
      if (msg.id === undefined || msg.id === null) return;

      remember(msg.id);
      const id = msg.id;
      const tool = msg?.params?.name ?? '(未命名工具)';
      timer = setTimer(() => {
        timer = null;
        onHint({ tool, id });
      }, timeoutMs);
      // 不 unref 也不会吊住进程（DSH 关掉这一行时会 kill 子进程），但没有理由为此多留一个句柄。
      if (timer !== null && typeof timer?.unref === 'function') timer.unref();
    },

    // 入方向：任何一条 tools/call 的响应都说明 CDP 连接已经通了 —— 之后不再有任何提醒。
    noteResponseLine(line) {
      if (disposed || seenCallResponse || watched.size === 0) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!isObject(msg) || msg.id === undefined || msg.id === null) return;
      if (!('result' in msg) && !('error' in msg)) return;
      if (!watched.has(msg.id)) return;

      seenCallResponse = true;
      clearTimerHandle();
    },

    dispose() {
      disposed = true;
      clearTimerHandle();
    },
  };
}
