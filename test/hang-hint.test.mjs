// lib/hang-hint.mjs 的失败方式清单（先列再写测试）：
// 1. parseApprovalHintMs：undefined/空串/非法值没落到默认 10000；'0' 没被当成"关闭"；
//    负数被当成有效值；
// 2. 非 tools/call（initialize / tools/list / 通知）被当成一次调用布了点；
// 3. 第一次转发的 tools/call 挂住时到点不报告；
// 4. 报告里丢了工具名（诊断要看不出是谁挂住）；
// 5. 该次调用的响应到达后没清定时器 —— 到点还会误报；
// 6. 别人（无关 id）的响应把定时器清了 —— 真挂住的那次反而不再提醒；
// 7. 已经有过成功响应之后还在布点（每次调用都提醒，变成噪声）；
// 8. 一次挂起重复提醒（同一 id 触发多条）；
// 9. timeoutMs = 0 时仍然布点/触发（关不掉）；
// 10. 定时器没 unref（把 DSH 的子进程生命周期吊住）；
// 11. dispose 之后仍会触发。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_APPROVAL_HINT_MS,
  approvalHintText,
  createHangHint,
  parseApprovalHintMs,
} from '../lib/hang-hint.mjs';

function fakeClock() {
  const timers = new Set();
  let seq = 0;
  return {
    timers,
    setTimer(fn, ms) {
      const handle = {
        id: (seq += 1),
        ms,
        cleared: false,
        unrefCalled: false,
        unref() {
          this.unrefCalled = true;
          return this;
        },
      };
      handle.run = () => {
        if (handle.cleared) return;
        timers.delete(handle); // 真实 setTimeout 只触发一次
        fn();
      };
      timers.add(handle);
      return handle;
    },
    clearTimer(handle) {
      if (handle) {
        handle.cleared = true;
        timers.delete(handle);
      }
    },
    live() {
      return [...timers];
    },
    fire() {
      for (const handle of [...timers]) handle.run();
    },
  };
}

const call = (id, name = 'list_extensions') =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });
const reply = (id) => JSON.stringify({ jsonrpc: '2.0', id, result: { content: [] } });

test('parseApprovalHintMs: 默认值与"关闭"', () => {
  assert.equal(parseApprovalHintMs(undefined), DEFAULT_APPROVAL_HINT_MS);
  assert.equal(parseApprovalHintMs(null), DEFAULT_APPROVAL_HINT_MS);
  assert.equal(parseApprovalHintMs(''), DEFAULT_APPROVAL_HINT_MS);
  assert.equal(parseApprovalHintMs('   '), DEFAULT_APPROVAL_HINT_MS);
  assert.equal(parseApprovalHintMs('250'), 250);
  assert.equal(parseApprovalHintMs(250), 250);
  assert.equal(parseApprovalHintMs('0'), 0);
  assert.equal(parseApprovalHintMs(0), 0);
  for (const bad of ['abc', '-5', 'NaN', 'Infinity', {}]) {
    assert.equal(parseApprovalHintMs(bad), DEFAULT_APPROVAL_HINT_MS, `非法值应落默认：${String(bad)}`);
  }
});

test('首次转发的 tools/call 到点报告，并带上工具名', () => {
  const clock = fakeClock();
  const hints = [];
  const hint = createHangHint({ timeoutMs: 500, onHint: (info) => hints.push(info), ...clock });
  hint.noteForwardedRequest(call(1, 'list_extensions'));
  assert.equal(clock.live().length, 1);
  assert.equal(clock.live()[0].ms, 500);
  assert.deepEqual(hints, []);
  clock.fire();
  assert.equal(hints.length, 1);
  assert.equal(hints[0].tool, 'list_extensions');
  assert.equal(hints[0].id, 1);
});

test('非 tools/call 的一律不布点', () => {
  const clock = fakeClock();
  const hint = createHangHint({ timeoutMs: 500, onHint: () => assert.fail('不该报告'), ...clock });
  hint.noteForwardedRequest(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  hint.noteForwardedRequest(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
  hint.noteForwardedRequest(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  hint.noteForwardedRequest('not json');
  assert.deepEqual(clock.live(), []);
});

test('该次调用的响应到达 -> 清定时器，到点不再报告', () => {
  const clock = fakeClock();
  const hints = [];
  const hint = createHangHint({ timeoutMs: 500, onHint: (i) => hints.push(i), ...clock });
  hint.noteForwardedRequest(call(7));
  const handle = clock.live()[0];
  hint.noteResponseLine(reply(7));
  assert.equal(handle.cleared, true);
  assert.deepEqual(clock.live(), []);
  handle.run();
  assert.deepEqual(hints, []);
});

test('无关 id 的响应不清定时器（挂住的那次仍要提醒）', () => {
  const clock = fakeClock();
  const hints = [];
  const hint = createHangHint({ timeoutMs: 500, onHint: (i) => hints.push(i), ...clock });
  hint.noteForwardedRequest(call(7));
  hint.noteResponseLine(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { tools: [] } }));
  hint.noteResponseLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} }));
  assert.equal(clock.live().length, 1);
  clock.fire();
  assert.equal(hints.length, 1);
});

test('有过一次成功响应之后不再布点', () => {
  const clock = fakeClock();
  const hints = [];
  const hint = createHangHint({ timeoutMs: 500, onHint: (i) => hints.push(i), ...clock });
  hint.noteForwardedRequest(call(1));
  hint.noteResponseLine(reply(1));
  hint.noteForwardedRequest(call(2));
  assert.deepEqual(clock.live(), []);
  clock.fire();
  assert.deepEqual(hints, []);
});

test('同一次挂起只报告一次', () => {
  const clock = fakeClock();
  const hints = [];
  const hint = createHangHint({ timeoutMs: 500, onHint: (i) => hints.push(i), ...clock });
  hint.noteForwardedRequest(call(1));
  clock.fire();
  clock.fire();
  assert.equal(hints.length, 1);
  assert.deepEqual(clock.live(), []);
});

test('提醒之后又来一次调用（仍无任何响应）-> 再提醒一次', () => {
  const clock = fakeClock();
  const hints = [];
  const hint = createHangHint({ timeoutMs: 500, onHint: (i) => hints.push(i), ...clock });
  hint.noteForwardedRequest(call(1, 'list_extensions'));
  clock.fire();
  hint.noteForwardedRequest(call(2, 'list_pages'));
  assert.equal(clock.live().length, 1);
  clock.fire();
  assert.deepEqual(
    hints.map((i) => i.tool),
    ['list_extensions', 'list_pages'],
  );
});

test('提醒之后那次调用的响应终于到达 -> 之后不再布点', () => {
  const clock = fakeClock();
  const hints = [];
  const hint = createHangHint({ timeoutMs: 500, onHint: (i) => hints.push(i), ...clock });
  hint.noteForwardedRequest(call(1));
  clock.fire();
  hint.noteResponseLine(reply(1)); // 用户点了"允许"，这次调用终于回来了
  hint.noteForwardedRequest(call(2));
  assert.deepEqual(clock.live(), []);
  clock.fire();
  assert.equal(hints.length, 1);
});

test('timeoutMs = 0 -> 完全不介入', () => {
  const clock = fakeClock();
  const hint = createHangHint({ timeoutMs: 0, onHint: () => assert.fail('不该报告'), ...clock });
  hint.noteForwardedRequest(call(1));
  assert.deepEqual(clock.live(), []);
  clock.fire();
});

test('定时器 unref，且 dispose 之后不再报告', () => {
  const clock = fakeClock();
  const hints = [];
  const hint = createHangHint({ timeoutMs: 500, onHint: (i) => hints.push(i), ...clock });
  hint.noteForwardedRequest(call(1));
  const handle = clock.live()[0];
  assert.equal(handle.unrefCalled, true, '定时器必须 unref，否则会吊住子进程生命周期');
  hint.dispose();
  assert.equal(handle.cleared, true);
  handle.run();
  assert.deepEqual(hints, []);
});

test('缺少 unref 的定时器实现不报错（测试替身/浏览器环境）', () => {
  const hint = createHangHint({ timeoutMs: 500, onHint: () => {}, setTimer: () => ({}), clearTimer: () => {} });
  assert.doesNotThrow(() => hint.noteForwardedRequest(call(1)));
});

test('approvalHintText: 带上工具名、等待时长与关闭方式', () => {
  const text = approvalHintText({ tool: 'list_extensions', timeoutMs: 10000 });
  assert.match(text, /list_extensions/);
  assert.match(text, /10 秒/);
  assert.match(text, /允许/);
  assert.match(text, /DSH_CDP_APPROVAL_HINT_MS/);
  // 不能谎称调用失败：这次调用仍在等
  assert.match(text, /没有失败/);
  assert.equal(/超时|已失败|出错/.test(text), false);
});
