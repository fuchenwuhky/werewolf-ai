/**
 * keypool.test.js — 多 Key 通道池（keypool P1/P2/P3）
 *
 * 先说结论（实测，见 docs/fluency-plan.md §1.4）：多 Key 的天花板约 **-23%**，不是"减半"，
 * 因为语义串行的发言链占了 73% 的耗时。所以这一层的定位是"**本来就有多个 Key 时别浪费**"，
 * 不是"买 Key 提速"。默认仍然是单通道。
 *
 * 本文件的守卫围绕两件事：
 *   ① **单 Key 零变化**：通道数 1 时，队列语义（优先级/老化/FIFO/快照字段）必须与旧版一致 ——
 *      这是敢动调度器的前提；
 *   ② **多 Key 才并行**：n 个 Key → 至多 n 个在途；坏 Key 被摘掉后不影响其他通道；
 *      而且 `game.parallelLlm` 为假时引擎**不扇出**（否则"正在思考"提示会显示错人）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { LlmScheduler, PRIORITY } = require('../src/ai/scheduler');
const { parseApiKeys, DEFAULT_CONFIG } = require('../src/config');
const { Game } = require('../src/engine/game');
const { makeMockAgentFactory } = require('../scripts/mock-agent');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('解析 Key 池：数组与字符串合并、去重、忽略脱敏占位', () => {
  assert.deepStrictEqual(parseApiKeys({ apiKey: 'a' }), ['a']);
  assert.deepStrictEqual(parseApiKeys({ apiKey: 'a,b c\nd' }), ['a', 'b', 'c', 'd'], '逗号/空格/换行都要支持');
  assert.deepStrictEqual(parseApiKeys({ apiKey: 'a', apiKeys: ['b', 'a'] }), ['a', 'b'], '合并去重');
  // 同一个 Key 填两遍会产生两条通道 = 自己撞自己的限流，必须在解析层就消掉
  assert.deepStrictEqual(parseApiKeys({ apiKey: 'x,x,x' }), ['x']);
  assert.deepStrictEqual(parseApiKeys({ apiKey: 'sk-****abcd' }), [], '脱敏占位不是真 Key');
  assert.deepStrictEqual(parseApiKeys({}), []);
  assert.deepStrictEqual(parseApiKeys(null), []);
});

test('单通道：串行语义与稳定性不变（入队即刻开跑；积压内按优先级 + FIFO）', async () => {
  const s = new LlmScheduler({ channels: 1 });
  const order = [];
  // 语义澄清（旧版就是这样，别改错）：enqueue 会立刻尝试开跑，
  // 所以"第一个入队的一定先跑"；优先级只对**积压中**的任务排序。
  const gate = s.enqueue(async () => { await sleep(15); order.push('first'); }, { label: 'gate' });
  const a = s.enqueue(async () => { order.push('reflection'); }, { priority: PRIORITY.reflection, label: 'r' });
  const b = s.enqueue(async () => { order.push('decision'); }, { priority: PRIORITY.decision, label: 'd' });
  await Promise.all([gate, a, b]);
  assert.deepStrictEqual(order, ['first', 'decision', 'reflection'], `积压内必须按优先级：${order}`);
  // 快照的旧字段必须还在（api.js 的空转检测依赖 depth/busy/current）
  const snap = s.snapshot();
  for (const k of ['depth', 'busy', 'current', 'total', 'failed', 'avgWaitMs', 'maxWaitMs', 'avgRunMs', 'byPriority', 'recent']) {
    assert.ok(k in snap, `快照缺少旧字段 ${k}（改名会让上帝面板与手机端静默失效）`);
  }
  assert.strictEqual(snap.channels, 1);
  assert.strictEqual(snap.slots.length, 1);
});

test('多通道：至多 n 个在途，且槽位与 Key 一一对应', async () => {
  const s = new LlmScheduler({ channels: 3 });
  let inFlight = 0;
  let peak = 0;
  const slots = [];
  const jobs = [];
  for (let i = 0; i < 9; i++) {
    jobs.push(s.enqueue(async (slot) => {
      slots.push(slot);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(6);
      inFlight--;
    }, { label: `j${i}` }));
  }
  await Promise.all(jobs);
  assert.strictEqual(peak, 3, `3 条通道同时最多 3 个在途（实际 ${peak}）`);
  assert.deepStrictEqual([...new Set(slots)].sort(), [0, 1, 2], '三个槽位都被用到（槽位即 Key 序号）');
  const snap = s.snapshot();
  assert.strictEqual(snap.channels, 3);
  assert.strictEqual(snap.slots.length, 3);
  assert.strictEqual(Object.values(snap.bySlot).reduce((a, b) => a + b, 0), 9, '每个任务都要归到某个槽位');
});

test('坏 Key 隔离：某通道致命失败后被临时摘除，其余通道继续干活', async () => {
  const s = new LlmScheduler({ channels: 2 });
  const fatal = new Error('配额已用尽');
  fatal.fatal = true;
  const seen = [];
  const first = s.enqueue(async (slot) => { seen.push(slot); throw fatal; }, { label: 'bad' });
  await assert.rejects(() => first, /配额已用尽/);
  const disabledSlot = seen[0];
  // 摘除后新请求只会派到另一个槽位
  const slots2 = [];
  for (let i = 0; i < 4; i++) {
    await s.enqueue(async (slot) => { slots2.push(slot); }, { label: `ok${i}` });
  }
  assert.ok(!slots2.includes(disabledSlot), `被摘除的通道 ${disabledSlot} 不应再派活：${slots2}`);
  const snap = s.snapshot();
  assert.ok(snap.slots[disabledSlot].disabled, '快照要能看出哪个通道被摘除');
  assert.match(snap.slots[disabledSlot].lastError, /配额/, '摘除原因要留档');
});

test('单 Key 时引擎不扇出（否则"正在思考"提示会显示错人）；多 Key 才开', () => {
  const board = { wolf: 1, seer: 1, villager: 4 };
  const players = [];
  for (let i = 0; i < 6; i++) players.push({ name: `P${i + 1}` });
  const mk = (parallelLlm) => new Game({ id: 'kp', board, players, agentFactory: makeMockAgentFactory(Math.random), stepPauseMs: 0, logger: { debug() {}, info() {}, warn() {}, error() {} }, parallelLlm });
  assert.strictEqual(mk(false).parallelLlm, false, '默认（单 Key）必须是 false');
  assert.strictEqual(mk(undefined).parallelLlm, false, '不传也必须是 false');
  assert.strictEqual(mk(true).parallelLlm, true, '多 Key 时才置 true');
});

test('目录一致性：默认配置必须是单通道（不能悄悄改变所有人的计费/限流行为）', () => {
  assert.deepStrictEqual(parseApiKeys(DEFAULT_CONFIG), [], '出厂默认没有 Key → 单通道');
  const s = new LlmScheduler();
  assert.strictEqual(s.channels, 1, '调度器默认 1 条通道');
});
