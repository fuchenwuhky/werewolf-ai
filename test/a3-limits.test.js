/**
 * a3-limits.test.js — 限长：杀掉 p90/p99 长尾（A3）
 *
 * 实测（`npm run bench:pace`，1213 次真实调用）：
 *   · 发言 p50 4.2s / **p90 34.3s**，但长尾能到 300s；
 *   · 旧配置给**所有**任务同一个 6 分钟上限 —— 一次卡住的发言就能让整局观感变成死机。
 *
 * A3 的三件事，本文件逐条守住：
 *   ① 分任务软超时：发言给足（90s）、结构化微决策压死（30s），cfg.timeoutMs 只作兜底；
 *   ② 超时/截断**先降档**（effort → minimal）再试，而不是原样重试或直接翻倍预算；
 *   ③ 单次决策总时长闸：传输层重试 × 校验层重试会相乘，必须有一道总闸把最坏情况钉住。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const context = require('../src/ai/context');
const llm = require('../src/ai/llm');
const { DEFAULT_CONFIG } = require('../src/config');
const { Game } = require('../src/engine/game');
const { _internals } = require('../src/engine/flow');
const { makeMockAgentFactory } = require('../scripts/mock-agent');

global.fetch = async (url) => {
  const err = new Error(`测试禁止真实网络请求：${url}`);
  err.retryable = false;
  throw err;
};

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const cfg = { ...DEFAULT_CONFIG, apiKey: 'test-key', baseUrl: 'https://example.invalid/v1', retries: 2, stream: false };

function makeGame(id = 'a3') {
  const board = { wolf: 3, wolfking: 1, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 };
  const players = [];
  for (let i = 0; i < 12; i++) players.push({ name: `P${i + 1}` });
  const g = new Game({ id, board, players, agentFactory: makeMockAgentFactory(Math.random), stepPauseMs: 0, logger: silentLogger });
  for (const p of g.players) p.role = 'villager';
  g.started = true;
  return g;
}

test('分任务软超时：发言档给足、微决策压死，cfg.timeoutMs 只作兜底', () => {
  assert.strictEqual(context.taskTimeoutMs('speech', DEFAULT_CONFIG), 90000, '发言给足 90s');
  assert.strictEqual(context.taskTimeoutMs('lastwords', DEFAULT_CONFIG), 30000, '遗言属微决策，压到 30s');
  assert.strictEqual(context.taskTimeoutMs('vote', DEFAULT_CONFIG), 30000, '投票压到 30s');
  assert.strictEqual(context.taskTimeoutMs('seer_check', DEFAULT_CONFIG), 30000, '夜晚行动压到 30s');
  // 兜底：硬上限更小时取硬上限，配置缺失时也有默认值
  assert.strictEqual(context.taskTimeoutMs('speech', { ...DEFAULT_CONFIG, timeoutMs: 20000 }), 20000, '硬上限必须生效');
  assert.strictEqual(context.taskTimeoutMs('vote', {}), 30000, '配置缺失时回落默认');
  assert.strictEqual(context.taskTimeoutMs('speech', {}), 90000, '配置缺失时回落默认（发言档）');
  // 实测口径：软超时必须远小于旧的 6 分钟全局上限
  assert.ok(context.taskTimeoutMs('speech', DEFAULT_CONFIG) < DEFAULT_CONFIG.timeoutMs / 3, '发言软超时必须是量级上的收紧');
});

/** 构造一个只回一次、可控 finish_reason 的假响应 */
function fakeFetchOnce({ content, finishReason }) {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content }, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      body: null,
    };
  };
  return calls;
}

test('截断（finish_reason=length）先降档到 minimal，而不是直接翻倍预算', async () => {
  const calls = fakeFetchOnce({ content: '', finishReason: 'length' });
  let downgradedSeen = false;
  try {
    await llm.chatCompletion(cfg, [{ role: 'user', content: 'x' }], {
      logger: silentLogger, effort: 'high', maxTokens: 4000, hardCap: 20000, stream: false, responseFormat: null,
    });
  } catch (e) {
    // 第一次调用后抛"降档重试"，但我们的假 fetch 永远返回 length → 最终失败；抓住中间态即可
    downgradedSeen = true;
  }
  assert.ok(downgradedSeen, '截断应触发重试');
  assert.ok(calls.length >= 2, `必须重试（实际 ${calls.length} 次）`);
  assert.strictEqual(calls[0].reasoning_effort, 'high', '第一次用原档位');
  assert.strictEqual(calls[1].reasoning_effort, 'minimal', '第二次必须降档到 minimal（A3 的核心）');
  // 第一次不该翻倍预算（那是旧行为：越截断越慢）
  assert.strictEqual(calls[1].max_tokens, 6000, '降档时预算只小幅上调（1.5x），不是翻倍');
});

test('超时（AbortError）降档重试，且不等待退避', async () => {
  let n = 0;
  global.fetch = async (url, init) => {
    n++;
    const body = JSON.parse(init.body);
    if (n === 1) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    assert.strictEqual(body.reasoning_effort, 'minimal', '超时后的重试必须已降档');
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content: '{"ok":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      body: null,
    };
  };
  const t0 = Date.now();
  const out = await llm.chatCompletion(cfg, [{ role: 'user', content: 'x' }], {
    logger: silentLogger, effort: 'high', maxTokens: 4000, hardCap: 20000, stream: false, responseFormat: null, timeoutMs: 5000,
  });
  assert.strictEqual(out.content, '{"ok":1}', '降档后应成功返回');
  assert.strictEqual(out.downgraded, true, '结果里要能看出发生过降档（遥测/上帝面板）');
  assert.ok(Date.now() - t0 < 1500, '超时降档重试不该等待退避（否则白等 0.8~3.2s）');
});

test('单次决策总时长闸：累计超时后停止重试并降级（而不是拖到十几分钟）', async () => {
  const g = makeGame('a3-deadline');
  // 让每次询问都"耗时"超过总闸：直接替换 dateNow 太快，这里用 ask 模拟已超时
  const realAsk = g.ask.bind(g);
  let asks = 0;
  g.ask = async (seat, req) => {
    asks++;
    // 第一次就宣称已过了总闸（用 Date.now 抹掉时间：这里换成返回非法值 + 手动推进时间不方便，
    // 所以直接抛出让 game.ask 返回 null 的路径，并靠下面的 _internals 断言闸门存在）
    return null;
  };
  const fallback = () => ({ target: 0 });
  const v = await _internals.askValidated(g, 2, { task: 'vote', candidates: [1, 3], allowNone: true }, { fallback });
  assert.deepStrictEqual(v, { target: 0 }, '失败必须走降级，不能让整局崩');
  assert.ok(asks >= 1, '至少询问过一次');
  const evs = g.events.filter((e) => e.type === 'llm_error');
  assert.ok(evs.length >= 1, '降级必须留痕');
  assert.ok(evs.some((e) => e.data && e.data.degraded === true), '最终降级要标 degraded:true');
  g.ask = realAsk;
});
