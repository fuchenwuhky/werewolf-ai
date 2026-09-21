/**
 * stream.test.js — 流式输出（SSE）与"打字中"直播缓冲
 *
 * 设计要点：
 *  - 流式只降低"感知延迟"，不增加并发（同一条请求）——符合 1 Key = 1 并发硬约束
 *  - 增量只进"直播缓冲"，刻意不进 events：否则会污染存档、AI 上下文与事件流
 *  - 公开发言全员可见；私密决策仅本人与上帝；内心独白（reasoning）仅上帝
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { chatCompletion, currentStreamMode, resetStreamMode } = require('../src/ai/llm');
const { Game } = require('../src/engine/game');
const { Agent } = require('../src/ai/agent');
const { LlmScheduler } = require('../src/ai/scheduler');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const enc = new TextEncoder();

/** 构造一个 SSE 假响应；chunkDelay>0 时用于观察"生成中"的中间态 */
function sseResponse(chunks, { chunkDelay = 0 } = {}) {
  let i = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) { controller.close(); return; }
      if (chunkDelay) await sleep(chunkDelay);
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
  return { ok: true, status: 200, body: stream, headers: { get: () => null }, text: async () => '' };
}

const SSE_OK = [
  'data: {"choices":[{"delta":{"reasoning_content":"先想一下"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"{\\"text\\":\\""}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"你好\\"}"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":80}}}\n\n',
  'data: [DONE]\n\n',
];

const cfg = (extra = {}) => ({ baseUrl: 'http://x', apiKey: 'k', model: 'm', maxTokens: 1000, retries: 0, ...extra });

// ---------- llm 层：SSE 解析 ----------
test('流式：SSE 增量按序回调、正文与独白分别累积、用量从尾块取出、记录首字延迟', async () => {
  resetStreamMode();
  const origFetch = global.fetch;
  const deltas = [];
  global.fetch = async () => sseResponse(SSE_OK);
  try {
    const out = await chatCompletion(cfg(), [{ role: 'user', content: 'hi' }], {
      scheduler: new LlmScheduler(), onDelta: (d) => deltas.push(d), meta: { label: '1号' },
    });
    assert.strictEqual(out.streamed, true, '应走流式');
    assert.strictEqual(out.content, '{"text":"你好"}');
    assert.strictEqual(out.reasoning, '先想一下');
    assert.strictEqual(out.usage.promptTokens, 100);
    assert.strictEqual(out.usage.cachedTokens, 80, '缓存用量必须保留（上帝面板要显示命中率）');
    assert.strictEqual(out.usage.completionTokens, 20);
    assert.strictEqual(out.usage.estimated, false);
    // TTFT 必须是从"请求发出"算起的**有限**毫秒数（src/ai/llm.js:241 `ttftMs = Date.now() - t0`）。
    // 原写法 `ttftMs != null && ttftMs >= 0` 里 `>= 0` 是恒真半边（时钟差不可能为负），等于没验证单位；
    // 改成有限值 + 真实上界：本用例的假 fetch 立刻 resolve、5 个 chunk 无延迟，实测 TTFT 恒为 0~2ms，
    // 2000ms 对最慢的 CI 也是极宽松的容差，只拦"量纲/时间基准取错"这类真缺陷（例如把 ttftMs 写成
    // Date.now() 的绝对毫秒）。合法的 0 不能排除，所以不用 `> 0`。
    assert.ok(Number.isFinite(out.ttftMs) && out.ttftMs < 2000, `应记录首字延迟 TTFT（有限且 < 2000ms；实际 ${out.ttftMs}）`);
    assert.deepStrictEqual(deltas.map((d) => d.content).filter(Boolean), ['{"text":"', '你好"}'], '增量应保持顺序');
    assert.strictEqual(deltas[0].reasoning, '先想一下');
  } finally { global.fetch = origFetch; resetStreamMode(); }
});

test('流式：请求体带 stream:true 与 stream_options.include_usage', async () => {
  resetStreamMode();
  const origFetch = global.fetch;
  let sent = null;
  global.fetch = async (url, opts) => { sent = JSON.parse(opts.body); return sseResponse(SSE_OK); };
  try {
    await chatCompletion(cfg(), [{ role: 'user', content: 'hi' }], { scheduler: new LlmScheduler(), onDelta: () => {}, meta: {} });
    assert.strictEqual(sent.stream, true);
    assert.deepStrictEqual(sent.stream_options, { include_usage: true });
  } finally { global.fetch = origFetch; resetStreamMode(); }
});

test('流式：没人消费增量时不走流式（保证用量精确、实现最简）', async () => {
  resetStreamMode();
  const origFetch = global.fetch;
  let sent = null;
  global.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"target":1}' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }),
    };
  };
  try {
    const out = await chatCompletion(cfg(), [{ role: 'user', content: 'hi' }], { scheduler: new LlmScheduler(), meta: {} });
    assert.strictEqual(sent.stream, undefined, '未传 onDelta 时不应开流式');
    assert.strictEqual(out.streamed, false);
    assert.strictEqual(out.content, '{"target":1}');
  } finally { global.fetch = origFetch; resetStreamMode(); }
});

test('流式：服务商不支持 stream_options（400）→ 自动降级为不带该参数并重试成功', async () => {
  resetStreamMode();
  const origFetch = global.fetch;
  const bodies = [];
  let n = 0;
  global.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    n++;
    if (n === 1) {
      return { ok: false, status: 400, headers: { get: () => null }, text: async () => JSON.stringify({ error: { code: '1214', message: 'stream_options 参数非法' } }) };
    }
    return sseResponse(SSE_OK);
  };
  try {
    const out = await chatCompletion(cfg(), [{ role: 'user', content: 'hi' }], { scheduler: new LlmScheduler(), onDelta: () => {}, meta: {} });
    assert.strictEqual(bodies.length, 2, '应降级重试一次');
    assert.deepStrictEqual(bodies[0].stream_options, { include_usage: true });
    assert.strictEqual(bodies[1].stream, true, '降级后仍是流式');
    assert.strictEqual(bodies[1].stream_options, undefined, '降级后不再带 stream_options');
    assert.strictEqual(currentStreamMode(), 'plain');
    assert.strictEqual(out.content, '{"text":"你好"}');
  } finally { global.fetch = origFetch; resetStreamMode(); }
});

test('流式：响应无可读流（网关改造）→ 退回非流式，不影响对局', async () => {
  resetStreamMode();
  const origFetch = global.fetch;
  let n = 0;
  global.fetch = async () => {
    n++;
    if (n === 1) return { ok: true, status: 200, headers: { get: () => null }, body: undefined, json: async () => ({}) };
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"target":2}' } }], usage: { prompt_tokens: 9, completion_tokens: 4 } }),
    };
  };
  try {
    const out = await chatCompletion(cfg(), [{ role: 'user', content: 'hi' }], { scheduler: new LlmScheduler(), onDelta: () => {}, meta: {} });
    assert.strictEqual(currentStreamMode(), 'off');
    assert.strictEqual(out.content, '{"target":2}');
    assert.strictEqual(out.streamed, false);
  } finally { global.fetch = origFetch; resetStreamMode(); }
});

test('流式：尾块无 usage 时改为估算并标记 estimated', async () => {
  resetStreamMode();
  const origFetch = global.fetch;
  global.fetch = async () => sseResponse([
    'data: {"choices":[{"delta":{"content":"{\\"text\\":\\"你好\\"}"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  try {
    const out = await chatCompletion(cfg(), [{ role: 'user', content: '你好你好你好' }], { scheduler: new LlmScheduler(), onDelta: () => {}, meta: {} });
    assert.strictEqual(out.usage.estimated, true, '无用量回流应标记为估算');
    assert.ok(out.usage.promptTokens > 0 && out.usage.completionTokens > 0);
  } finally { global.fetch = origFetch; resetStreamMode(); }
});

test('流式：TTFT 从"请求发出"起算（服务端延迟冲刷首字节也不会算成 0）', async () => {
  resetStreamMode();
  const origFetch = global.fetch;
  // 模拟服务端憋了 120ms 才吐出响应头 + 首块（真实服务商常见）
  global.fetch = async () => { await sleep(120); return sseResponse(SSE_OK); };
  try {
    const out = await chatCompletion(cfg(), [{ role: 'user', content: 'hi' }], { scheduler: new LlmScheduler(), onDelta: () => {}, meta: {} });
    assert.ok(out.ttftMs >= 100, `TTFT 应包含服务端首字节等待，实际 ${out.ttftMs}ms`);
    assert.ok(out.latencyMs >= out.ttftMs, '调用总耗时应不小于 TTFT');
  } finally { global.fetch = origFetch; resetStreamMode(); }
});

// ---------- 直播缓冲的可见性 ----------
function makeGame() {
  const board = { wolf: 3, wolfking: 1, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 };
  const players = [];
  for (let i = 0; i < 12; i++) players.push({ name: `P${i + 1}`, isHuman: false });
  return new Game({ id: 'live-test', board, players, stepPauseMs: 1, logger: silentLogger });
}

test('直播缓冲：公开发言全员可见；私密决策仅本人与上帝；独白仅上帝', () => {
  const g = makeGame();
  g.beginLive({ seat: 5, task: 'speech', public: true });
  g.updateLive({ content: '我认为', reasoning: '内心盘算' });
  assert.strictEqual(g.liveFor(7).text, '我认为', '公开发言旁观者可见');
  assert.strictEqual(g.liveFor(7).reasoning, undefined, '旁观者不得看到内心独白');
  assert.strictEqual(g.liveFor('god').reasoning, '内心盘算', '上帝可见独白');

  // 私密任务：旁观者一律看不到
  g.beginLive({ seat: 5, task: 'wolf_chat', public: false });
  g.updateLive({ content: '今晚刀3号' });
  assert.strictEqual(g.liveFor(7), null, '狼队频道不得泄漏给好人');
  assert.strictEqual(g.liveFor(5).text, '今晚刀3号', '本人可见');
  assert.strictEqual(g.liveFor(5).reasoning, undefined, '本人也不给独白');
  assert.strictEqual(g.liveFor('god').text, '今晚刀3号');
  g.endLive();
  assert.strictEqual(g.liveFor('god'), null, '结束后必须清空');
});

test('直播缓冲：绝不进入事件流（否则污染存档 / AI 上下文 / 前端事件）', () => {
  const g = makeGame();
  g.deal();
  const before = g.events.length;
  g.beginLive({ seat: 3, task: 'speech', public: true });
  g.updateLive({ content: '半成品文本' });
  g.updateLive({ content: '继续' });
  g.endLive();
  assert.strictEqual(g.events.length, before, '直播增量不得产生任何事件');
  assert.strictEqual(JSON.stringify(g.events).includes('半成品文本'), false, '半成品不得出现在事件里');
  assert.strictEqual(JSON.stringify(g.toJSON()).includes('半成品文本'), false, '半成品不得进存档');
});

// ---------- 端到端：Agent 决策期间直播、结束即清空 ----------
test('Agent 决策：生成中可观测到直播文本，结束后清空并记录 TTFT/流式计数', async () => {
  resetStreamMode();
  const origFetch = global.fetch;
  global.fetch = async () => sseResponse([
    'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"{\\"text\\":"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"\\"我过。\\"}"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":10}}\n\n',
    'data: [DONE]\n\n',
  ], { chunkDelay: 15 });
  try {
    const g = makeGame();
    g.deal();
    g.day = 1;
    const agent = new Agent(g.player(4), g, { baseUrl: 'http://x', apiKey: 'k', model: 'm', retries: 0, contextBudget: 4000 }, silentLogger);
    const eventsBefore = g.events.length;
    const p = agent.decide({ task: 'speech' });

    // 生成中：轮询等待首个正文增量（避免依赖精确时序）
    let waited = 0;
    while (waited < 500 && (!g.live || !g.live.text)) { await sleep(5); waited += 5; }
    assert.ok(g.live, '生成期间应有直播缓冲');
    assert.strictEqual(g.live.seat, 4);
    assert.strictEqual(g.live.public, true, '发言属于可公开任务');
    assert.ok(g.live.text.length > 0, '生成期间应已收到增量文本');
    assert.ok(g.live.reasoning.length > 0, '上帝视角应有内心独白增量');

    const payload = await p;
    assert.strictEqual(payload.text, '我过。', '最终仍解析出合法 JSON');
    assert.strictEqual(g.live, null, '决策结束必须清空直播缓冲');
    assert.strictEqual(g.llmStats.streamedCalls, 1);
    assert.strictEqual(g.llmStats.ttftCount, 1);
    // 该次调用的 chunkDelay=15ms：首块正文/独白到达前至少睡 15ms，所以 TTFT 必然 > 0；
    // 上界 5000ms 是慢机器容差（实测 ~16~30ms，整条流 5 块 ×15ms 也才 ~75ms）。
    // 原写法 `ttftMsTotal >= 0 && ttftMsMax >= 0` 两个半边都恒真（都源自 Date.now() 差值），
    // 换成"有限正数 + 上界"，并额外钉住不变式：ttftCount=1 时累计值必须等于最大值
    // （src/ai/agent.js:402-404 在同一分支里同时更新 total 与 max）——
    // 这一条能抓住"只累加 total、忘了更新 max"这类真缺陷，而旧的 >= 0 写法会放它过去。
    assert.ok(Number.isFinite(g.llmStats.ttftMsTotal) && g.llmStats.ttftMsTotal > 0 && g.llmStats.ttftMsTotal < 5000,
      `TTFT 累计应为有限正毫秒数（首块延迟 15ms 保证 > 0，上限 5000ms 为慢机器容差），实际 ${g.llmStats.ttftMsTotal}`);
    assert.strictEqual(g.llmStats.ttftMsMax, g.llmStats.ttftMsTotal, '只调用 1 次（ttftCount=1）时最大值必须等于累计值');
    assert.strictEqual(g.llmStats.promptTokens, 50);
    // 直播不得留下任何事件
    const newEvents = g.events.slice(eventsBefore);
    assert.strictEqual(newEvents.some((e) => JSON.stringify(e).includes('我过')), false, '半成品/增量不得进事件流');
  } finally { global.fetch = origFetch; resetStreamMode(); }
});

test('Agent 决策：LLM 失败时也必须清空直播缓冲（不留残影）', async () => {
  resetStreamMode();
  const origFetch = global.fetch;
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  try {
    const g = makeGame();
    g.deal();
    g.day = 1;
    const agent = new Agent(g.player(6), g, { baseUrl: 'http://x', apiKey: 'k', model: 'm', retries: 0, contextBudget: 4000 }, silentLogger);
    await assert.rejects(() => agent.decide({ task: 'speech' }));
    assert.strictEqual(g.live, null, '失败路径也要清空（finally 保证）');
  } finally { global.fetch = origFetch; resetStreamMode(); }
});
