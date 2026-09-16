/**
 * vote-progress.test.js — 私密投票阶段的"进度可见"（A4）
 *
 * 背景：一次放逐投票要串行 8~11 次 LLM 调用（真实遥测 p50 3.2s / p90 24.2s/次），
 * 期间**没有任何输出**，玩家只能盯着"正在思考" —— 这是"对局不流畅"的主观主因，
 * 比多 Key 并行更值得治（并行天花板只有十几个百分点，见 scripts/pace-bench.js）。
 *
 * 代价必须为零：这个事件是**纯 UI 反馈**，不许泄露投票方向，也不许影响 AI 的推理与思考预算。
 * 本文件的四条断言就是这两件事的守卫。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('../src/engine/game');
const { runGame } = require('../src/engine/flow');
const { renderEvent } = require('../src/engine/render');
const { makeMockAgentFactory, auditIsolation } = require('../scripts/mock-agent');
const { NOISE_TYPES } = require('../src/ai/context');
const { CHATTER_TYPES, collectFeatures } = require('../src/ai/effort');

global.fetch = async (url) => {
  const err = new Error(`测试禁止真实网络请求：${url}`);
  err.retryable = false;
  throw err;
};

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeGame(id = 'vote-progress') {
  const board = { wolf: 3, wolfking: 1, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 };
  const players = [];
  for (let i = 0; i < 12; i++) players.push({ name: `P${i + 1}` });
  return new Game({ id, board, players, agentFactory: makeMockAgentFactory(Math.random), stepPauseMs: 0, logger: silentLogger });
}

test('整局：每次私密投票都播报进度，计数从 0 递增到 total', async () => {
  const g = makeGame('vp1');
  await runGame(g);
  const evs = g.events.filter((e) => e.type === 'vote_progress');
  assert.ok(evs.length > 0, '一局里没有任何进度播报（投票阶段仍是无反馈等待）');
  // 每一轮投票必须"从 0 开始、每次 +1、最后一条等于 total"
  let run = [];
  const rounds = [];
  for (const e of evs) {
    if (e.data.done === 0) {
      if (run.length) rounds.push(run);
      run = [e.data];
    } else {
      run.push(e.data);
    }
  }
  if (run.length) rounds.push(run);
  assert.ok(rounds.length > 0, '没有一轮完整的进度播报');
  for (const r of rounds) {
    const total = r[0].total;
    assert.ok(total > 0, `total 必须为正：${total}`);
    const dones = r.map((d) => d.done);
    assert.strictEqual(new Set(dones).size, dones.length, `同一轮里 done 重复：${dones}`);
    assert.strictEqual(dones[dones.length - 1], total, `一轮结束时 done 应等于 total：${JSON.stringify(r)}`);
    for (let i = 0; i < dones.length; i++) assert.strictEqual(dones[i], i, `done 必须逐次 +1：${dones}`);
  }
  assert.strictEqual(auditIsolation(g).length, 0, '进度事件破坏了可见性隔离');
});

test('绝不泄露投票方向：data 只有 done/total，序列化后不含座位号', async () => {
  const g = makeGame('vp2');
  await runGame(g);
  const evs = g.events.filter((e) => e.type === 'vote_progress');
  assert.ok(evs.length);
  for (const e of evs) {
    assert.deepStrictEqual(Object.keys(e.data).sort(), ['done', 'total'], `进度事件混进了别的字段：${JSON.stringify(e.data)}`);
    // 断言"没有可泄露的东西"：既没有 target，也没有任何座位号
    const s = JSON.stringify(e.data);
    assert.ok(!/target/.test(s), '进度事件里出现了 target');
    assert.ok(!/\bseat\b/.test(s), '进度事件里出现了 seat');
    assert.ok(!e.text, `进度事件不应带正文（会进别人的上下文）：${JSON.stringify(e.text)}`);
  }
});

test('对 AI 完全不可见：不进上下文、不渲染、不参与思考预算打分', async () => {
  // ① 上下文层：被 NOISE_TYPES 排除，不会进入 L2 实录/事实时间线
  assert.ok(NOISE_TYPES.has('vote_progress'), 'vote_progress 必须进 NOISE_TYPES（否则会作为噪声进 AI 上下文）');
  // ② 渲染层：即使有人绕过 NOISE_TYPES 渲染它，也必须渲染成空串
  const g = makeGame('vp3');
  const ev = { type: 'vote_progress', day: 1, seq: 1, data: { done: 3, total: 9 } };
  assert.strictEqual(renderEvent(g, ev), '', '进度事件不应渲染出任何文本');
  // ③ 思考预算层：它的存在不得抬高"信息量"打分（否则等于偷偷给 AI 加思考时间）
  assert.ok(CHATTER_TYPES.has('vote_progress'), 'vote_progress 必须进 CHATTER_TYPES');
  const g2 = makeGame('vp4');
  g2.emit('vote_progress', { data: { done: 1, total: 9 } });
  g2.emit('vote_progress', { data: { done: 2, total: 9 } });
  g2.emit('vote_progress', { data: { done: 3, total: 9 } });
  const f = collectFeatures(g2, g2.players[0], { task: 'vote' }, 0);
  assert.strictEqual(f.decisive, 0, `进度事件被当成了"决定性事件"（decisive=${f.decisive}）→ 会抬高思考预算`);
});
