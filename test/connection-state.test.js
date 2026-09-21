/**
 * connection-state.test.js — SSE 推送 / 轮询降级的浏览器端共享状态（M1 共享状态）
 *
 * 同一份实现被桌面 app.js 与手机 m.js 引用，这里在 Node 下用假 EventSource 直接断言接线与复位。
 * 契约：时长阈值（桌面 36s/4s、手机 40s/8s）与降级文案**不在模块里**，由调用方注入；
 * 模块负责 地址拼接 / 帧解析 / 四个监听器接线 / 停流复位 / 重试判据 / 看门狗一跳。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../web/shared/connection-state');

/** 假 EventSource：记录地址与监听器，由用例手动派发（浏览器里事件是异步的，这里只验证接线） */
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.closed = 0;
    FakeEventSource.made.push(this);
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  close() { this.closed++; this.readyState = 2; }
  emit(type, data) { for (const fn of (this.listeners[type] || []).slice()) fn({ data }); }
}
FakeEventSource.made = [];

/** 假定时器：只认 clearInterval，用来观察"看门狗有没有被清掉" */
function withClearInterval(fn) {
  const real = globalThis.clearInterval;
  const cleared = [];
  globalThis.clearInterval = (t) => { cleared.push(t); };
  try { fn(); } finally { globalThis.clearInterval = real; }
  return cleared;
}

test('地址拼接：view/stream 同形，after 原样透传（模块不做默认值）', () => {
  assert.strictEqual(C.POLL_MS, 1200, '轮询兜底节奏（两端原本都是 1200）');
  assert.strictEqual(C.PUSH_RETRY_MS, 30000, '降级后恢复推送的重试间隔（桌面端）');
  assert.strictEqual(C.viewUrl('g1', 'tok', 0), '/api/games/g1/view?token=tok&after=0');
  assert.strictEqual(C.streamUrl('g1', 'tok', 7), '/api/games/g1/stream?token=tok&after=7');
  assert.strictEqual(C.viewUrl('g1', undefined, undefined), '/api/games/g1/view?token=undefined&after=undefined',
    '不做默认值 —— 桌面传 `state.playerAfter || 0`、手机传 `state.playerAfter`，模块必须逐字节照搬');
});

test('帧解析：坏帧丢一帧（null），不抛、不断整条流', () => {
  assert.deepStrictEqual(C.parseFrame('{"a":1}'), { a: 1 });
  assert.strictEqual(C.parseFrame('{'), null);
  assert.strictEqual(C.parseFrame(undefined), null);
  assert.strictEqual(C.parseFrame('null'), null);
});

test('推送接线：view 先记活动再派发、坏帧只记活动、ping 记活动、end/error 分流', () => {
  FakeEventSource.made.length = 0;
  const seen = [];
  const st = C.openStream({
    kind: 'player',
    url: '/api/games/g1/stream?token=t&after=0',
    EventSource: FakeEventSource,
    onActivity: () => seen.push('activity'),
    onFrame: (kind, v) => seen.push(`frame:${kind}:${v.a}`),
    onEnd: () => seen.push('end'),
    onError: (kind) => seen.push(`error:${kind}`),
  });
  const es = FakeEventSource.made[0];
  assert.strictEqual(es.url, '/api/games/g1/stream?token=t&after=0', '地址原样交给 EventSource');
  assert.strictEqual(st.kind, 'player', '返回 { kind, es }，调用方仍需能按流区分玩家的帧');
  assert.strictEqual(st.es, es);
  es.emit('view', '{"a":1}');
  assert.deepStrictEqual(seen, ['activity', 'frame:player:1'], '先记活动时间再派发帧（解析失败不能影响看门狗）');
  es.emit('view', 'broken');
  assert.deepStrictEqual(seen, ['activity', 'frame:player:1', 'activity'], '坏帧只记活动，不派发');
  es.emit('ping');
  assert.deepStrictEqual(seen.slice(-1), ['activity'], '服务端心跳只记活动时间');
  es.emit('end');
  assert.deepStrictEqual(seen.slice(-1), ['end'], '对局结束/被清理 → 交给调用方拉终局状态');
  es.readyState = 1; // 连接中（浏览器自己在自动重连）
  es.emit('error');
  assert.strictEqual(seen.filter((x) => x.startsWith('error')).length, 0, 'readyState≠2 交给浏览器重连，不降级');
  es.readyState = 2;
  es.emit('error');
  assert.deepStrictEqual(seen.slice(-1), ['error:player'], '连接真的关闭（readyState=2）才交给调用方降级');
});

test('上帝流与玩家流同形：kind 透传给两个回调（桌面两条流的区分点在调用方）', () => {
  FakeEventSource.made.length = 0;
  const seen = [];
  C.openStream({
    kind: 'god',
    url: '/x',
    EventSource: FakeEventSource,
    onActivity: () => {},
    onFrame: (kind) => seen.push(`frame:${kind}`),
    onEnd: () => {},
    onError: (kind) => seen.push(`error:${kind}`),
  });
  const es = FakeEventSource.made[0];
  es.emit('view', '{"a":1}');
  es.readyState = 2;
  es.emit('error');
  assert.deepStrictEqual(seen, ['frame:god', 'error:god']);
});

test('EventSource 不可用时抛错（调用方"不支持就回退轮询"的分支照旧走得到）', () => {
  assert.throws(() => C.openStream({
    url: '/x', EventSource: null, onActivity: () => {}, onFrame: () => {}, onEnd: () => {}, onError: () => {},
  }), /EventSource 不可用/);
});

test('停流复位：关掉每一路 + 字段置 null + 清看门狗（少任何一步下一轮都会以为还在推送）', () => {
  const a = { es: { closed: 0, close() { this.closed++; } } };
  const b = { es: { closed: 0, close() { this.closed++; } } };
  const watchdog = { id: 'wd' };
  const state = { stream: a, godStream: b, streamWatchdog: watchdog };
  const cleared = withClearInterval(() => C.stopStreams(state, ['stream', 'godStream']));
  assert.strictEqual(a.es.closed, 1, '玩家流必须被关闭');
  assert.strictEqual(b.es.closed, 1, '上帝流必须被关闭');
  assert.deepStrictEqual(cleared, [watchdog], '看门狗定时器必须被清掉');
  assert.strictEqual(state.stream, null);
  assert.strictEqual(state.godStream, null);
  assert.strictEqual(state.streamWatchdog, null);

  // 手机端只有一条流
  const singleEs = { closed: 0, close() { this.closed++; } };
  const single = { stream: { es: singleEs }, streamWatchdog: null };
  withClearInterval(() => C.stopStreams(single, ['stream']));
  assert.strictEqual(single.stream, null);
  assert.strictEqual(singleEs.closed, 1, '手机端唯一的一条流也要关');

  // close() 抛异常不得打断停流流程（原来包了 try/catch，且字段照样复位）
  const bad = { stream: { es: { close() { throw new Error('already closed'); } } }, streamWatchdog: null };
  assert.doesNotThrow(() => withClearInterval(() => C.stopStreams(bad, ['stream'])));
  assert.strictEqual(bad.stream, null, '关闭失败也必须把字段复位，否则重建流被跳过');
  assert.doesNotThrow(() => C.stopStreams({}, ['stream', 'godStream']), '字段缺失时也不能炸');
});

test('建流前置条件：不支持 SSE 或没有对局都不建流（两端原本逐字相同的三行）', () => {
  const withWindow = (value, fn) => {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
    const prev = globalThis.window;
    if (value === undefined) delete globalThis.window; else globalThis.window = value;
    try { return fn(); } finally { if (had) globalThis.window = prev; else delete globalThis.window; }
  };
  assert.strictEqual(C.canStream({ game: { gameId: 'g' } }), false, '没有 window（Node/非浏览器）不建流');
  assert.strictEqual(withWindow({}, () => C.canStream({ game: { gameId: 'g' } })), false, '浏览器不支持 EventSource 不建流');
  const win = { EventSource: FakeEventSource };
  assert.strictEqual(withWindow(win, () => C.canStream({ game: { gameId: 'g' } })), true);
  assert.strictEqual(withWindow(win, () => C.canStream({ game: {} })), false, '没有 gameId 不建流');
  assert.strictEqual(withWindow(win, () => C.canStream({})), false, '没有对局不建流');
});

test('起连接：先停旧再建新；推送建起来就不降级，建不起来才退回轮询', () => {
  const calls = [];
  const cfg = (ok) => ({
    stopPolling: () => calls.push('stop'),
    startStream: () => { calls.push('stream'); return ok; },
    startFallback: () => calls.push('fallback'),
  });
  assert.strictEqual(C.startConnection(cfg(true)), true);
  assert.deepStrictEqual(calls, ['stop', 'stream'], '停旧必须在建新之前，成功时不降级');
  calls.length = 0;
  assert.strictEqual(C.startConnection(cfg(false)), false);
  assert.deepStrictEqual(calls, ['stop', 'stream', 'fallback'], '推送建不起来才退回轮询');
});

test('轮询兜底幂等：已经在跑就不再叠定时器（与原来的 if (state.pollTimer) return 同义）', () => {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const made = [];
  globalThis.setInterval = (fn, ms) => { const t = { fn, ms }; made.push(t); return t; };
  globalThis.clearInterval = () => {};
  try {
    const state = {};
    const poll = () => {};
    assert.strictEqual(C.beginFallback(state, poll), true);
    assert.strictEqual(made.length, 1);
    assert.strictEqual(made[0].ms, C.POLL_MS);
    assert.strictEqual(state.pollTimer, made[0], '定时器句柄落在 state.pollTimer 上（别处也在读它）');
    assert.strictEqual(C.beginFallback(state, () => {}), false, '第二次调用必须原样返回 false，不再叠一条');
    assert.strictEqual(made.length, 1, '定时器数量不得增加');
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
});

test('停连接：清恢复推送重试 + 清轮询 + 停流复位（一键回到"什么都没在跑"）', () => {
  const realClear = globalThis.clearInterval;
  const cleared = [];
  globalThis.clearInterval = (t) => { cleared.push(t); };
  const stream = { es: { closed: 0, close() { this.closed++; } } };
  const watchdog = { id: 'wd' };
  const retry = { id: 'retry' };
  const pollTimer = { id: 'poll' };
  const state = { stream, godStream: null, streamWatchdog: watchdog, streamRetry: retry, pollTimer };
  try {
    C.stopConnection(state, ['stream', 'godStream']);
  } finally {
    globalThis.clearInterval = realClear;
  }
  assert.deepStrictEqual(cleared, [retry, pollTimer, watchdog], '重试、轮询、看门狗三个定时器都要清掉');
  assert.strictEqual(stream.es.closed, 1, '推送流必须被关闭');
  assert.strictEqual(state.stream, null);
  assert.strictEqual(state.streamRetry, null, '恢复推送的重试定时器必须清掉并置 null');
  assert.strictEqual(state.pollTimer, null, '轮询定时器必须清掉并置 null');
  assert.strictEqual(state.streamWatchdog, null, '看门狗必须清掉并置 null');
  // 手机端本来就是干净的（没有重试定时器）→ 也不能炸
  const clean = { stream: null, streamWatchdog: null };
  assert.doesNotThrow(() => C.stopConnection(clean, ['stream']));
  assert.strictEqual(clean.pollTimer, null);
});

test('降级后是否重试推送：已在推送 / 无对局 / 对局已结束都不重试', () => {
  assert.strictEqual(C.canRetryPush({ game: { gameId: 'g' } }), true);
  assert.strictEqual(C.canRetryPush({ game: { gameId: 'g' }, stream: { es: {} } }), false, '还在推送就不必重连');
  assert.strictEqual(C.canRetryPush({ game: null }), false, '没有对局不重连');
  assert.strictEqual(C.canRetryPush({}), false);
  assert.strictEqual(C.canRetryPush({ game: { gameId: 'g' }, view: { finished: true } }), false, '对局已结束不重连（建了也会被立刻 end）');
  assert.strictEqual(C.canRetryPush({ game: { gameId: 'g' }, view: { finished: false } }), true);
});

test('看门狗一跳：没流不判死、判据为假不降级、判死才回调一次', () => {
  let deaths = 0;
  const onDead = () => { deaths++; };
  assert.strictEqual(C.watchdogTick({}, () => true, onDead), false, '没有活动流时不判死');
  assert.strictEqual(deaths, 0);
  assert.strictEqual(C.watchdogTick({ stream: { es: {} } }, () => false, onDead), false);
  assert.strictEqual(deaths, 0, '阈值未到不降级（正常空闲不能被误判成断线）');
  assert.strictEqual(C.watchdogTick({ stream: { es: {} } }, () => true, onDead), true);
  assert.strictEqual(deaths, 1, '判死只回调一次，由调用方在里面停流 + 降级 + 提示');
});
