/**
 * reflection.test.js — 反思节流与边界化（P0-5）
 *
 * 改动前：`Agent.decide()` 内联 `await ensureDigests()`，每天首次决策被一次完整反思调用阻塞
 *         （11 个 AI 各一次）→ "某 AI 首答异常慢"。
 * 改动后：反思挪到日切边界后台排队（优先级 1），并加三道节流：
 *         ① 低信息日不发 LLM（用确定性事实骨架）
 *         ② 连续低信息日合并成一条纪要
 *         ③ 纪要总数封顶（最旧的丢弃，硬事实仍在快照时间线里）
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('../src/engine/game');
const { Agent } = require('../src/ai/agent');
const { LlmScheduler } = require('../src/ai/scheduler');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const CFG = { baseUrl: 'http://x', model: 'm', apiKey: 'k', fastEffort: 'low', scheduler: new LlmScheduler() };

/** 造一个"第 day 天有 n 条非噪音事件"的对局 */
function makeGame(days = {}) {
  const board = { wolf: 3, wolfking: 1, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 };
  const players = [];
  for (let i = 0; i < 12; i++) players.push({ name: `P${i + 1}`, isHuman: false });
  const g = new Game({ id: 'digest-test', board, players, stepPauseMs: 1, logger: silentLogger });
  g.deal();
  for (const [day, n] of Object.entries(days)) {
    g.day = Number(day);
    g.phase = 'day';
    for (let i = 0; i < n; i++) {
      // 发言属噪音事件、deaths 属决定性事件；这里混用，只关心"非噪音计数"
      if (i % 3 === 0) g.emit('deaths', { data: { deaths: [] } });
      else g.emit('speech', { actor: 1 + (i % 12), data: { text: `第${day}天发言${i}`, context: 'day' } });
    }
  }
  return g;
}

/** 拦截 LLM，返回一个反思 JSON；记录调用 */
function stubLlm(calls, summaryFor = (opts) => '纪要内容：8号可疑（置信度中）。') {
  const llm = require('../src/ai/llm');
  const orig = llm.chatCompletion;
  llm.chatCompletion = async (cfg, messages, opts) => {
    calls.push({ task: opts.meta && opts.meta.task, priority: opts.priority, content: messages[0].content });
    return { content: JSON.stringify({ summary: summaryFor(opts), suspicion: { 8: 60 } }), usage: { promptTokens: 10, cachedTokens: 0, completionTokens: 20 } };
  };
  return () => { llm.chatCompletion = orig; };
}

// ---------- ① 节流 ----------
test('节流：低信息日不发 LLM，用确定性事实骨架代替', async () => {
  const g = makeGame({ 1: 2, 2: 8 }); // 第1天只有 2 条事件 < 阈值 6
  g.day = 3;
  const calls = [];
  const restore = stubLlm(calls);
  try {
    const agent = new Agent(g.player(5), g, { ...CFG, digestMinEvents: 6 }, silentLogger);
    const text = await agent.scheduleReflection(1);
    assert.strictEqual(calls.length, 0, '低信息日不得发 LLM 调用（这是省调用的主要来源）');
    assert.ok(text && text.length > 0, '仍要有纪要（事实骨架），记忆不能断');
    assert.ok(agent.digests.has(1), '骨架也要落进 L1');
  } finally { restore(); }
});

test('节流：信息充足的日子照常调 LLM 反思', async () => {
  const g = makeGame({ 1: 9 });
  g.day = 3;
  const calls = [];
  const restore = stubLlm(calls);
  try {
    const agent = new Agent(g.player(5), g, { ...CFG, digestMinEvents: 6 }, silentLogger);
    await agent.scheduleReflection(1);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].task, '第1天反思');
    assert.ok(agent.digests.get(1).includes('8号可疑'), 'LLM 的 summary 应进入纪要');
    assert.strictEqual(agent.suspicion['8'], 60, 'suspicion 应更新');
  } finally { restore(); }
});

test('节流：digestMinEvents=0 表示关闭节流（所有日子都反思）', async () => {
  const g = makeGame({ 1: 1 });
  g.day = 3;
  const calls = [];
  const restore = stubLlm(calls);
  try {
    const agent = new Agent(g.player(5), g, { ...CFG, digestMinEvents: 0 }, silentLogger);
    await agent.scheduleReflection(1);
    assert.strictEqual(calls.length, 1, '0 = 不节流');
  } finally { restore(); }
});

// ---------- ② 合并 ----------
test('合并：连续低信息日并入下一个有信息的日子，只出一条纪要', async () => {
  const g = makeGame({ 1: 2, 2: 2, 3: 10 });
  const calls = [];
  const restore = stubLlm(calls);
  try {
    const agent = new Agent(g.player(5), g, { ...CFG, digestMinEvents: 6 }, silentLogger);
    await agent.scheduleReflection(1); // 低信息 → 骨架
    await agent.scheduleReflection(2); // 低信息 → 骨架
    assert.strictEqual(calls.length, 0);
    await agent.scheduleReflection(3); // 有信息 → 合并 1~3 天，一条纪要
    assert.strictEqual(calls.length, 1, '三天只花一次调用');
    assert.ok(calls[0].content.includes('第 1 天到第 3 天'), `提示词应说明合并区间，实际：${calls[0].content.slice(0, 60)}`);
    assert.ok(calls[0].content.includes('第1天发言'), '合并后的素材应包含低信息日的实录');
    assert.ok(agent.digests.has(3));
    assert.ok(!agent.digests.has(1) && !agent.digests.has(2), '合并后应移除各低信息日的独立纪要，避免上下文重复');
  } finally { restore(); }
});

test('合并：中间有信息的日子不会被跨越合并', async () => {
  const g = makeGame({ 1: 2, 2: 10, 3: 2, 4: 10 });
  const calls = [];
  const restore = stubLlm(calls);
  try {
    const agent = new Agent(g.player(5), g, { ...CFG, digestMinEvents: 6 }, silentLogger);
    await agent.scheduleReflection(1); // 骨架
    await agent.scheduleReflection(2); // 合并 1~2
    await agent.scheduleReflection(3); // 骨架
    await agent.scheduleReflection(4); // 合并 3~4
    assert.strictEqual(calls.length, 2, '两个有信息的日子各一次');
  } finally { restore(); }
});

// ---------- ③ 上限 ----------
test('上限：纪要总数封顶，最旧的丢弃且不会被 ensureDigests 反复重建', async () => {
  const days = {};
  for (let d = 1; d <= 8; d++) days[d] = 8;
  const g = makeGame(days);
  g.day = 10;
  const calls = [];
  const restore = stubLlm(calls);
  try {
    const agent = new Agent(g.player(5), g, { ...CFG, digestMinEvents: 6, digestKeep: 3 }, silentLogger);
    for (let d = 1; d <= 8; d++) await agent.scheduleReflection(d);
    assert.strictEqual(agent.digests.size, 3, `纪要数应封顶为 3，实际 ${agent.digests.size}`);
    assert.deepStrictEqual([...agent.digests.keys()].sort((a, b) => a - b), [6, 7, 8], '保留最近的');
    const before = calls.length;
    await agent.ensureDigests(); // 窗口内的都已存在 → 不应再发调用
    assert.strictEqual(calls.length, before, '不得为了被丢弃的旧纪要反复重建（否则等于无限churn）');
  } finally { restore(); }
});

// ---------- 边界批处理 ----------
test('边界：日切统一入队，进度可观测且完成后自动清空', async () => {
  const g = makeGame({ 1: 8 });
  g.day = 2;
  g._agents.set(1, new Agent(g.player(1), g, { ...CFG, digestMinEvents: 6 }, silentLogger));
  g._agents.set(2, new Agent(g.player(2), g, { ...CFG, digestMinEvents: 6 }, silentLogger));
  g._agents.set(3, new Agent(g.player(3), g, { ...CFG, digestMinEvents: 6 }, silentLogger));
  const calls = [];
  const restore = stubLlm(calls);
  try {
    const n = g.scheduleReflection(1);
    assert.strictEqual(n, 3, '三个已创建的 AI 都应入队');
    assert.ok(g.memory, '应暴露进度供前端显示"AI 正在整理记忆…"');
    assert.strictEqual(g.memory.total, 3);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(calls.length, 3, '每个 AI 一次反思');
    assert.strictEqual(g.memory, null, '全部完成后进度应清空');
  } finally { restore(); }
});

test('边界：未创建的智能体不入队（没有记忆需要维护）', async () => {
  const g = makeGame({ 1: 8 });
  g.day = 2;
  const calls = [];
  const restore = stubLlm(calls);
  try {
    const n = g.scheduleReflection(1);
    assert.strictEqual(n, 0);
    assert.strictEqual(g.memory, undefined === g.memory ? g.memory : g.memory);
    assert.strictEqual(g.memory, null, '无人入队时不应留下进度残影');
    assert.strictEqual(calls.length, 0);
  } finally { restore(); }
});

// ---------- 关键验收：不再阻塞新一天的首个决策 ----------
test('验收：反思已在边界完成后，新一天的首个决策只发 1 次调用（改动前是 2 次）', async () => {
  const g = makeGame({ 1: 8 });
  g.day = 2;
  const calls = [];
  const llm = require('../src/ai/llm');
  const orig = llm.chatCompletion;
  llm.chatCompletion = async (cfg, messages, opts) => {
    const task = opts.meta && opts.meta.task;
    calls.push(task);
    if (task === 'speech') return { content: '{"text":"我的发言"}', usage: { promptTokens: 10, cachedTokens: 0, completionTokens: 5 } };
    return { content: JSON.stringify({ summary: '纪要', suspicion: {} }), usage: { promptTokens: 10, cachedTokens: 0, completionTokens: 5 } };
  };
  try {
    const agent = new Agent(g.player(5), g, { ...CFG, digestMinEvents: 6 }, silentLogger);
    g._agents.set(5, agent);
    agent.lastSeq = 0;
    // 日切边界：先后台反思
    g.scheduleReflection(1);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(calls, ['第1天反思'], '边界应已完成反思');
    calls.length = 0;
    // 新一天首个决策：不应再内联反思
    await agent.decide({ task: 'speech' });
    assert.deepStrictEqual(calls, ['speech'], `首个决策只应发决策本身，实际 ${JSON.stringify(calls)}`);
  } finally { llm.chatCompletion = orig; }
});

test('验收：边界任务尚未跑完时，决策只等它、不重复发起（不会双倍调用）', async () => {
  const g = makeGame({ 1: 8 });
  g.day = 2;
  const calls = [];
  const llm = require('../src/ai/llm');
  const orig = llm.chatCompletion;
  llm.chatCompletion = async (cfg, messages, opts) => {
    const task = opts.meta && opts.meta.task;
    calls.push(task);
    if (task !== 'speech') await new Promise((r) => setTimeout(r, 20)); // 反思故意慢
    if (task === 'speech') return { content: '{"text":"发言"}', usage: { promptTokens: 10, cachedTokens: 0, completionTokens: 5 } };
    return { content: JSON.stringify({ summary: '纪要', suspicion: {} }), usage: { promptTokens: 10, cachedTokens: 0, completionTokens: 5 } };
  };
  try {
    const agent = new Agent(g.player(5), g, { ...CFG, digestMinEvents: 6 }, silentLogger);
    g._agents.set(5, agent);
    agent.lastSeq = 0;
    const pending = agent.scheduleReflection(1); // 边界任务在飞
    await agent.decide({ task: 'speech' });      // 决策与它并发发起
    await pending;
    assert.strictEqual(calls.filter((t) => t === '第1天反思').length, 1, '反思不得因并发而重复发起');
    assert.strictEqual(calls.filter((t) => t === 'speech').length, 1);
  } finally { llm.chatCompletion = orig; }
});

// ---------- 接线：flow 真的在日切边界通知了 ----------
test('接线：flow 在进入新一天时通知已创建的 AI 整理上一天（不是只在单测里成立）', async () => {
  const { runGame } = require('../src/engine/flow');
  const { makeMockAgentFactory } = require('../scripts/mock-agent');
  const board = { wolf: 3, wolfking: 1, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 };
  const players = Array.from({ length: 12 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
  const notified = [];
  const mock = makeMockAgentFactory(Math.random, {});
  const g = new Game({
    id: 'boundary-wire', board, rules: { sheriff: false }, players, stepPauseMs: 1, logger: silentLogger,
    agentFactory: (player, game) => {
      const base = mock(player, game);
      return {
        decide: (req) => base.decide(req),
        scheduleReflection(day) { notified.push({ seat: player.seat, day }); return null; },
      };
    },
  });
  await runGame(g);
  assert.ok(g.day >= 2, `对局应至少推进到第 2 天，实际第 ${g.day} 天`);
  assert.ok(notified.some((n) => n.day === 1), `进入第 2 天时应通知整理第 1 天，实际通知：${JSON.stringify(notified)}`);
  assert.ok(notified.every((n) => n.day >= 1 && n.day < g.day), '通知的天数必须是"已完整结束"的日子（不含当天）');
});

// ---------- 记忆完整性：节流不能把记忆弄丢 ----------
test('记忆完整性：被节流/被合并/被上限丢弃后，上下文仍不缺必要信息', async () => {
  const g = makeGame({ 1: 2, 2: 9 });
  g.day = 3;
  const calls = [];
  const restore = stubLlm(calls);
  try {
    const agent = new Agent(g.player(5), g, { ...CFG, digestMinEvents: 6, digestKeep: 6 }, silentLogger);
    await agent.ensureDigests(); // 懒补齐：窗口内只有第1天需要
    assert.ok(agent.digests.has(1), '第1天必须有纪要（哪怕是骨架）');
    // 第1天是低信息日 → 走了骨架，没有 LLM 调用
    assert.strictEqual(calls.length, 0, '第1天信息量不足 → 不应有 LLM 调用');
  } finally { restore(); }
});
