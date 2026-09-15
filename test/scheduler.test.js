/**
 * scheduler.test.js — 单通道调度器与 llm 接入的并发安全测试
 *
 * 硬约束：1 API Key = 1 并发。本文件的核心断言就是"任何时刻至多 1 个在途请求"。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { LlmScheduler, PRIORITY } = require('../src/ai/scheduler');
const { chatCompletion } = require('../src/ai/llm');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('调度器：严格串行，任何时刻至多 1 个在途任务', async () => {
  const s = new LlmScheduler();
  let inFlight = 0;
  let maxInFlight = 0;
  const order = [];
  const jobs = [];
  for (let i = 1; i <= 6; i++) {
    jobs.push(s.enqueue(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      order.push(i);
      inFlight--;
      return i;
    }, { label: `job${i}` }));
  }
  const results = await Promise.all(jobs);
  assert.strictEqual(maxInFlight, 1, `并发数必须为 1，实际峰值 ${maxInFlight}`);
  assert.deepStrictEqual(results, [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(order, [1, 2, 3, 4, 5, 6], '同级任务按入队顺序（FIFO）执行');
  assert.strictEqual(s.depth, 0);
  assert.strictEqual(s.busy, false);
});

test('调度器：高优先级可越过排队中的低优先级', async () => {
  const s = new LlmScheduler();
  const done = [];
  // 先占住通道（模拟一个正在进行的发言决策）
  const blocker = s.enqueue(async () => { await sleep(20); done.push('blocker'); }, { priority: PRIORITY.decision });
  // 排队中的低优先级（反思）
  const low = s.enqueue(async () => { done.push('reflection'); }, { priority: PRIORITY.reflection });
  // 随后到达的高优先级（玩家可见决策）应插到反思前面
  await sleep(5);
  const high = s.enqueue(async () => { done.push('decision'); }, { priority: PRIORITY.decision });
  await Promise.all([blocker, low, high]);
  assert.deepStrictEqual(done, ['blocker', 'decision', 'reflection'], '决策必须优先于反思执行');
});

test('调度器：老化机制保证低优先级不被饿死', async () => {
  const s = new LlmScheduler({ agingStepMs: 20, maxAging: 2 });
  const done = [];
  // 占住通道足够久，让排队中的反思"老化"
  const blocker = s.enqueue(async () => { await sleep(70); done.push('blocker'); }, { priority: PRIORITY.decision });
  const low = s.enqueue(async () => { done.push('reflection(aged)'); }, { priority: PRIORITY.reflection });
  await sleep(60); // 反思已等待 > 2×20ms，有效优先级升到 -1，比新来的决策(0)更优先
  const high = s.enqueue(async () => { done.push('decision'); }, { priority: PRIORITY.decision });
  await Promise.all([blocker, low, high]);
  assert.strictEqual(done[1], 'reflection(aged)', `老化的低优先级应先于新决策执行，实际顺序 ${done.join(' → ')}`);
});

test('调度器：单个任务失败不影响通道，后续任务照常执行', async () => {
  const s = new LlmScheduler();
  const results = [];
  const p1 = s.enqueue(async () => { throw new Error('boom'); });
  const p2 = s.enqueue(async () => { results.push('after-failure'); return 'ok'; });
  await assert.rejects(() => p1, /boom/);
  assert.strictEqual(await p2, 'ok');
  assert.deepStrictEqual(results, ['after-failure']);
  assert.strictEqual(s.stats.failed, 1);
  assert.strictEqual(s.busy, false);
});

test('调度器：snapshot 暴露队列深度与等待时长（上帝面板用）', async () => {
  const s = new LlmScheduler();
  const p1 = s.enqueue(async () => { await sleep(10); }, { label: 'a' });
  const p2 = s.enqueue(async () => { await sleep(1); }, { label: 'b' });
  const snap = s.snapshot();
  assert.strictEqual(snap.busy, true);
  assert.strictEqual(snap.depth, 1, '已有一个在途、一个排队');
  assert.strictEqual(snap.current.label, 'a');
  await Promise.all([p1, p2]);
  const after = s.snapshot();
  assert.strictEqual(after.depth, 0);
  assert.strictEqual(after.total, 2);
  assert.strictEqual(after.recent.length, 2);
});

test('llm 接入：并发发起多个 chatCompletion，实际串行且共用一条通道', async () => {
  const s = new LlmScheduler();
  const origFetch = global.fetch;
  let inFlight = 0;
  let maxInFlight = 0;
  const started = [];
  global.fetch = async (url, opts) => {
    const label = JSON.parse(opts.body).messages[0].content;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    started.push(label);
    await sleep(10);
    inFlight--;
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ finish_reason: 'stop', index: 0, message: { content: `{"target":0}` } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      text: async () => '',
    };
  };
  try {
    const cfg = { baseUrl: 'http://x', apiKey: 'k', model: 'm', maxTokens: 100, retries: 0 };
    // 模拟"11 个 AI 同时开口"：一次性全部发起
    const outs = await Promise.all([1, 2, 3, 4, 5].map((i) => chatCompletion(
      cfg, [{ role: 'user', content: `req${i}` }], { scheduler: s, meta: { label: `seat${i}` } },
    )));
    assert.strictEqual(maxInFlight, 1, `服务商侧并发必须为 1，实际峰值 ${maxInFlight}`);
    assert.deepStrictEqual(started, ['req1', 'req2', 'req3', 'req4', 'req5']);
    assert.strictEqual(outs.length, 5);
    assert.ok(outs.every((o) => o.content === '{"target":0}'));
  } finally { global.fetch = origFetch; }
});

test('llm 接入：排队期间对局被终止，则不发请求直接失败', async () => {
  const s = new LlmScheduler();
  const origFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; throw new Error('不应被调用'); };
  try {
    const ctrl = new AbortController();
    const blocker = s.enqueue(async () => { await sleep(20); }, { priority: PRIORITY.decision });
    const queued = chatCompletion({ baseUrl: 'http://x', apiKey: 'k', model: 'm', maxTokens: 10, retries: 0 },
      [{ role: 'user', content: 'hi' }], { scheduler: s, signal: ctrl.signal, meta: { label: '等待中' } });
    ctrl.abort(); // 排队期间终止对局
    await blocker;
    await assert.rejects(() => queued, (e) => e.aborted === true);
    assert.strictEqual(fetchCalls, 0, '排队中被取消的任务不得发出任何网络请求');
  } finally { global.fetch = origFetch; }
});

test('llm 接入：反思任务优先级低于决策，不阻塞玩家可见决策', async () => {
  const s = new LlmScheduler();
  const origFetch = global.fetch;
  const order = [];
  global.fetch = async (url, opts) => {
    order.push(JSON.parse(opts.body).messages[0].content);
    await sleep(5);
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }], usage: {} }),
      text: async () => '',
    };
  };
  try {
    const cfg = { baseUrl: 'http://x', apiKey: 'k', model: 'm', maxTokens: 10, retries: 0 };
    // 先占住通道
    const running = chatCompletion(cfg, [{ role: 'user', content: 'running' }], { scheduler: s, meta: { label: 'r' } });
    // 反思先入队（低优先级），随后决策入队（高优先级）
    const refl = chatCompletion(cfg, [{ role: 'user', content: 'reflection' }], { scheduler: s, priority: PRIORITY.reflection, meta: { label: 'f' } });
    await sleep(2);
    const dec = chatCompletion(cfg, [{ role: 'user', content: 'decision' }], { scheduler: s, priority: PRIORITY.decision, meta: { label: 'd' } });
    await Promise.all([running, refl, dec]);
    assert.deepStrictEqual(order, ['running', 'decision', 'reflection']);
  } finally { global.fetch = origFetch; }
});
