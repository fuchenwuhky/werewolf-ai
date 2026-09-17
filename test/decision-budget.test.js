/**
 * E1 + P1 的回归测试。
 *
 * E1（真实对局暴露）：一次发言可能吃满 12000 tokens / 362s，把 flow.js 的 180s 决策总预算一次花光，
 *   于是**第一次**校验失败时闸门已经超了 → 直接降级（真实发生：3 号只说了"我过。"）。
 *   修法：闸门用尽后不再等于放弃，而是允许**一次轻量补救**（_cheapRetry：最低思考 + 极小预算 + 短超时），
 *   只有补救也失败才降级。这里钉住三件事：
 *     ① 预算用尽后的第一次重试必须带 _cheapRetry；
 *     ② 该重试必须真的把 effort/maxTokens/超时压下来（否则等于再赌一次六分钟）；
 *     ③ 轻量补救只能有一次 —— 不能变成无限重试。
 *
 * P1：服务端心跳约 16s（STREAM_TICK_MS × STREAM_PING_TICKS），前端看门狗原来写死 8s < 16s，
 *   正常空闲必被误判断线。这里直接读源码锁死"看门狗 ≥ 2 个心跳周期"的关系，
 *   免得以后任何一边改数字又把这条缝撕开。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Game } = require('../src/engine/game');
const flow = require('../src/engine/flow');
const { Agent } = require('../src/ai/agent');
const llm = require('../src/ai/llm');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const { askValidated } = flow._internals;

function makeGame() {
  const board = { wolf: 3, wolfking: 1, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 };
  const players = [];
  for (let i = 0; i < 12; i++) players.push({ name: `P${i + 1}`, isHuman: false });
  const g = new Game({ id: 'budget-test', board, players, stepPauseMs: 1, logger: silentLogger });
  g.deal();
  return g;
}

test('E1：决策预算用尽后的重试是"轻量补救"，且只给一次', async () => {
  const g = makeGame();
  g.decisionTotalMs = 1; // 1ms：第一次尝试后预算必然已用尽（测试注入，正式路径用 DECISION_TOTAL_MS）
  const seen = [];
  g.ask = async (seat, req) => {
    seen.push({ cheap: !!req._cheapRetry, retryNote: !!req._retryNote });
    if (seen.length === 1) { await new Promise((r) => setTimeout(r, 5)); return { text: '' }; } // 第 1 次：非法
    return { text: '我站边 5 号，理由是他敢报查验。' }; // 第 2 次（补救）：合法
  };
  const out = await askValidated(g, 3, { task: 'speech' }, { fallback: () => ({ text: '我过。' }) });
  assert.strictEqual(seen.length, 2, '必须有第二次尝试（旧行为是闸门一超就直接降级）');
  assert.strictEqual(seen[0].cheap, false, '第一次是正常档位');
  assert.strictEqual(seen[1].cheap, true, '预算用尽后的重试必须标记为轻量补救');
  assert.strictEqual(seen[1].retryNote, true, '补救重试仍要带上"上次输出不合法"的提示');
  assert.match(out.text, /站边 5 号/, '补救成功时必须用真实发言，而不是降级内容');
});

test('E1：轻量补救也失败时仍然降级（不会无限重试）', async () => {
  const g = makeGame();
  g.decisionTotalMs = 1;
  let calls = 0;
  g.ask = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return { text: '' }; }; // 永远非法
  const out = await askValidated(g, 4, { task: 'speech' }, { fallback: () => ({ text: '我过。' }) });
  assert.strictEqual(out.text, '我过。', '补救失败后走降级');
  assert.strictEqual(calls, 2, `最多"1 次正常 + 1 次轻量补救"，实际 ${calls} 次`);
});

test('E1：轻量补救真的把档位压到最低、预算封在极小上限、超时用快速档', async () => {
  const g = makeGame();
  const agent = new Agent(g.player(5), g, {
    baseUrl: 'http://127.0.0.1:9', model: 'x', apiKey: 'k', retries: 0,
    reasoningEffort: 'high', fastEffort: 'low', maxTokens: 8000, fastMaxTokens: 8000,
    slowTimeoutMs: 90000, fastTimeoutMs: 30000,
  }, silentLogger);
  const orig = llm.chatCompletion;
  const seen = [];
  llm.chatCompletion = async (cfg, messages, opts) => {
    seen.push(opts);
    return { content: '{"text":"我站边 5 号。"}', reasoning: '', usage: {}, latencyMs: 1, ttftMs: 1, attempts: 1, streamed: false };
  };
  try {
    await agent.decide({ task: 'speech', _cheapRetry: true });
    await agent.decide({ task: 'speech' });
  } finally {
    llm.chatCompletion = orig;
  }
  assert.strictEqual(seen.length, 2, '两次 decide 各一次调用');
  const cheap = seen[0];
  const normal = seen[1];
  assert.strictEqual(cheap.effort, 'low', '补救重试用 fastEffort（默认 low）');
  assert.ok(cheap.maxTokens <= 1200, `补救重试预算必须极小，实际 ${cheap.maxTokens}`);
  assert.ok(cheap.hardCap <= 2000, `补救重试的 hardCap 必须封死，实际 ${cheap.hardCap}`);
  assert.strictEqual(cheap.timeoutMs, 30000, '补救重试超时用 fastTimeoutMs');
  assert.ok(normal.maxTokens > cheap.maxTokens, '正常档位不受影响（仍是完整预算）');
  assert.ok(normal.timeoutMs > cheap.timeoutMs, '正常发言仍用慢任务超时');
});

test('P1：推送看门狗必须大于服务端心跳周期的 2 倍', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'src', 'api.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  const tick = Number(/const STREAM_TICK_MS = (\d+)/.exec(api)[1]);
  const ticks = Number(/const STREAM_PING_TICKS = (\d+)/.exec(api)[1]);
  const dead = Number(/const STREAM_DEAD_MS = (\d+)/.exec(app)[1]);
  const pingMs = tick * ticks;
  assert.ok(pingMs > 0 && dead > 0, '两端常量都要能解析出来');
  assert.ok(dead >= pingMs * 2,
    `看门狗 ${dead}ms 必须 ≥ 2 个心跳周期 ${pingMs * 2}ms（心跳 ${pingMs}ms；小于它 = 正常空闲必被误判断线）`);
  // 顺带钉住"看门狗判定的就是这条阈值"：防止有人改了常量却忘了替换 8000 字面量
  assert.ok(/Date\.now\(\) - \(state\.lastStreamAt \|\| 0\) > STREAM_DEAD_MS/.test(app),
    '看门狗比较必须使用 STREAM_DEAD_MS 常量，不能留裸数字');
});
