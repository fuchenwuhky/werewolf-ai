/**
 * scheduler.test.js — LLM 调度器（Key 池 + 每 Key 泳道 + 自适应并发）与 llm 接入的并发安全测试
 *
 * 硬约束：**任何时刻每把 Key 的在途请求数不得超过它自己的并发上限**；默认（1 把 Key、每把 1 条泳道）
 * 等价于从前的严格串行。自适应用于"服务商实际允许几并发只有它自己知道"这件事：
 * 忙时有人排队 + 连续成功 ⇒ 加档；撞限流 ⇒ 砍半并冷却。
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

test('llm 接入：并发发起多个 chatCompletion，全部经调度器排队且不超过实时并发容量', async () => {
  const s = new LlmScheduler();
  const origFetch = global.fetch;
  let inFlight = 0;
  let maxInFlight = 0;
  let peakChannels = 0;
  const started = [];
  global.fetch = async (url, opts) => {
    const label = JSON.parse(opts.body).messages[0].content;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    peakChannels = Math.max(peakChannels, s.channels);
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
    // 硬约束：任何时刻在途数都不得超过调度器的**实时**并发容量（自适应加档也只能加到容量为止）
    assert.ok(maxInFlight <= peakChannels, `在途 ${maxInFlight} 超过当时容量 ${peakChannels}`);
    // 起始容量 = 1 把 Key × 1 条泳道：串行启动，排队顺序即提交顺序
    assert.ok(started[0] === 'req1' && started[1] === 'req2', `起始阶段必须逐个启动，实际 ${started.slice(0, 3).join(',')}`);
    assert.deepStrictEqual([...new Set(started.slice(0, 2))], ['req1', 'req2']);
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

// ---------------- 自适应并发（AIMD）：按"服务商实际允许几并发"收敛 ----------------

test('自适应：串行负载永远停在 1 条泳道（不排队 ⇒ 没有加档证据）', async () => {
  const s = new LlmScheduler();
  s.setPool({ keys: 1, perKey: 1, maxPerKey: 4, adaptive: true });
  for (let i = 0; i < 8; i++) {
    // 一个跑完再发下一个：**没有积压**，不能因为"在途 == limit"就以为该加档
    await s.enqueue(async (slot) => { s.noteSuccess(slot); await sleep(1); });
  }
  assert.strictEqual(s.channels, 1, '串行负载不得加档，否则单 Key 用户会被莫名其妙放开并发');
  assert.strictEqual(s.snapshot().ramps, 0);
});

test('自适应：忙时有积压 → 连续成功加档；撞限流 → 砍半；冷却期内不回头再试', async () => {
  const s = new LlmScheduler();
  s.setPool({ keys: 1, perKey: 1, maxPerKey: 4, adaptive: true });
  // 一次提交 6 个 ⇒ 真积压
  await Promise.all(Array.from({ length: 6 }, () => s.enqueue(async (slot) => { s.noteSuccess(slot); await sleep(12); })));
  assert.ok(s.channels >= 2, `有积压就该加档，实际 ${s.channels}`);
  assert.ok(s.channels <= s.maxPerKey, '不得超过每把 Key 的上限');
  const before = s.channels;
  s.noteRateLimited(0); // 服务商说"你开多了"
  assert.strictEqual(s.channels, Math.max(1, Math.floor(before / 2)), `限流后应砍半：${before} → ${s.channels}`);
  // 冷却期内即使又积压也不许加档
  await Promise.all(Array.from({ length: 6 }, () => s.enqueue(async (slot) => { s.noteSuccess(slot); await sleep(8); })));
  assert.strictEqual(s.channels, Math.max(1, Math.floor(before / 2)), '冷却期内不得再次加档');
});

test('自适应：关掉后单 Key 严格串行（旧行为可原样复现）', async () => {
  const s = new LlmScheduler();
  s.setPool({ keys: 1, perKey: 1, maxPerKey: 4, adaptive: false });
  let cur = 0; let peak = 0;
  await Promise.all(Array.from({ length: 8 }, () => s.enqueue(async (slot) => {
    cur++; peak = Math.max(peak, cur);
    s.noteSuccess(slot); // 即使一直报成功也不许加档
    await sleep(4);
    cur--;
  })));
  assert.strictEqual(peak, 1, '自适应关闭时必须严格串行');
  assert.strictEqual(s.channels, 1);
});

test('自适应：每把 Key 各记各的额度（一把被限流不牵连另一把）', async () => {
  const s = new LlmScheduler();
  s.setPool({ keys: 2, perKey: 2, maxPerKey: 4, adaptive: true });
  assert.strictEqual(s.channels, 4, '两把 Key × 每把 2 条泳道');
  s.noteRateLimited(0);
  const snap = s.snapshot();
  assert.strictEqual(snap.slots[0].limit, 1, '被限流的那把砍半');
  assert.strictEqual(snap.slots[1].limit, 2, '另一把 Key 的额度不该被牵连');
  assert.strictEqual(snap.channels, 3);
});

test('自适应：泳道并发严格执行（每把 Key 各自不超限）', async () => {
  const s = new LlmScheduler();
  s.setPool({ keys: 2, perKey: 3, maxPerKey: 3, adaptive: false });
  const per = new Map();
  let over = 0;
  await Promise.all(Array.from({ length: 12 }, () => s.enqueue(async (slot) => {
    const n = (per.get(slot) || 0) + 1;
    per.set(slot, n);
    if (n > 3) over++;
    await sleep(5);
    per.set(slot, per.get(slot) - 1);
  })));
  assert.strictEqual(over, 0, '任何一把 Key 都不得超过 3 条在途');
  assert.deepStrictEqual([...per.keys()].sort(), [0, 1], '两把 Key 都应该被用上');
});
