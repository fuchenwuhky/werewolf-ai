/**
 * degrade-visible.test.js — "静默降级"的守卫（B4）
 *
 * 改动前的三类静默行为，每一条都会让玩家看到"莫名其妙"的现象却无从追查：
 *   ① 校验失败重试：只在最终降级时留一行"已降级处理"，中间失败几次、失败在哪一项都看不到；
 *   ② 遗言降级（text 为空）→ **一条事件都不发**，遗言凭空消失，分不清"不想说"和"AI 挂了"；
 *   ③ 发言超长 → `slice(0,600)` 静默截断，看的人以为"AI 就说了这么多"。
 * 外加一个真 bug：`withdraw` 不校验 `canWithdraw`，PK 轮里模型以为退了水、引擎却当没听见。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('../src/engine/game');
const { runGame, validatePayload, _internals } = require('../src/engine/flow');
const { askValidated } = _internals;
const { makeMockAgentFactory } = require('../scripts/mock-agent');
const { schemaFor } = require('../src/ai/schemas');

global.fetch = async (url) => {
  const err = new Error(`测试禁止真实网络请求：${url}`);
  err.retryable = false;
  throw err;
};

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeGame(id, factory) {
  const board = { wolf: 3, wolfking: 1, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 };
  const players = [];
  for (let i = 0; i < 12; i++) players.push({ name: `P${i + 1}` });
  return new Game({ id, board, players, agentFactory: factory || makeMockAgentFactory(Math.random), stepPauseMs: 0, logger: silentLogger });
}

test('校验失败：每次非法都留痕，最终降级带 degraded + 降级值', async () => {
  // 永远返回非法载荷的智能体
  const factory = () => ({ async decide() { return {}; } });
  const g = makeGame('dg1', factory);
  const seat = 1;
  const req = { task: 'vote', candidates: g.aliveSeats().filter((s) => s !== seat), allowNone: true };
  const v = await askValidated(g, seat, req, { fallback: () => ({ target: 0 }) });
  assert.deepStrictEqual(v, { target: 0 }, '降级应拿到该任务的 fallback');
  const errs = g.events.filter((e) => e.type === 'llm_error' && e.data && e.data.task === 'vote');
  const degraded = errs.filter((e) => e.data.degraded);
  const retried = errs.filter((e) => !e.data.degraded);
  assert.strictEqual(retried.length, 3, `首答 + 两次重试共 3 次失败，都该留痕（实际 ${retried.length} 条）`);
  assert.deepStrictEqual(retried.map((e) => e.data.attempt), [1, 2, 3], 'attempt 必须逐次递增');
  assert.ok(retried.every((e) => typeof e.data.error === 'string' && e.data.error), '每条重试都要带原因');
  assert.strictEqual(degraded.length, 1, '必须有且只有一条降级留痕');
  assert.strictEqual(degraded[0].data.degraded, true);
  assert.strictEqual(degraded[0].data.attempts, 3, '降级留痕要写清一共试了几次');
  assert.strictEqual(degraded[0].data.degradedTo, '{"target":0}', '降级留痕要写清降级成了什么');
  assert.ok(degraded.every((e) => e.visibleTo === 'god'), '降级留痕只给上帝看，不该进玩家视野');
});

test('遗言降级不再凭空消失：落中性占位并标记 degraded', async () => {
  // 除遗言外一切正常，遗言永远非法
  const factory = (player, game) => {
    const mock = makeMockAgentFactory(Math.random)(player, game);
    return { async decide(req) { return req.task === 'lastwords' ? {} : mock.decide(req); } };
  };
  const g = makeGame('dg2', factory);
  await runGame(g);
  const lw = g.events.filter((e) => e.type === 'speech' && e.data && e.data.context === 'lastwords');
  assert.ok(lw.length > 0, '整局竟然没有任何遗言事件（降级时遗言消失了）');
  const deg = lw.filter((e) => e.data.degraded);
  assert.ok(deg.length > 0, '遗言降级没有被标记 degraded（上帝面板无法区分"不想说"与"AI 挂了"）');
  for (const e of deg) {
    assert.ok(e.data.text && e.data.text.trim(), '降级遗言必须是中性占位文本，不能是空串');
    assert.ok(!/我是|查验|狼人/.test(e.data.text), '占位文本不得编造任何身份/技能内容');
  }
});

test('发言超长：截断到上限且留痕，短发言不留痕', () => {
  const g = makeGame('dg3');
  const req = { task: 'speech', canExplode: false, candidates: [] };
  const long = '啊'.repeat(1200);
  const v = validatePayload('speech', { text: long }, req, g, 2);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.value.text.length, 600, '必须截断到 600 字');
  const tr = g.events.filter((e) => e.type === 'llm_error' && e.data && e.data.truncated);
  assert.strictEqual(tr.length, 1, '超长截断必须留一条 god 可见的痕迹');
  assert.ok(/1200/.test(tr[0].data.error), '留痕里要写清原始长度');
  const before = g.events.length;
  const ok = validatePayload('speech', { text: '短发言' }, req, g, 2);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(g.events.length, before, '正常长度的发言不该产生任何告警');
});

test('退水只在允许退水的轮次生效（模型侧与引擎侧不许有认知分歧）', () => {
  const g = makeGame('dg4');
  const allow = { task: 'sheriff_speech', canWithdraw: true, canExplode: false, candidates: [] };
  const deny = { task: 'sheriff_speech', canWithdraw: false, canExplode: false, candidates: [] };
  assert.strictEqual(validatePayload('sheriff_speech', { text: '我退水', withdraw: true }, allow, g, 2).value.withdraw, true);
  assert.strictEqual(validatePayload('sheriff_speech', { text: '我退水', withdraw: true }, deny, g, 2).value.withdraw, false, '不允许退水时引擎必须归一化为 false（否则模型以为退了、引擎当没听见）');
  // schema 侧同步锁死：不允许退水时 withdraw 只能是 false
  const sAllow = schemaFor('sheriff_speech', allow, { seat: 2 }).json_schema.schema.properties.withdraw;
  const sDeny = schemaFor('sheriff_speech', deny, { seat: 2 }).json_schema.schema.properties.withdraw;
  assert.deepStrictEqual(sDeny.enum, [false], '不允许退水时 schema 必须把 withdraw 锁成 false');
  assert.strictEqual(sAllow.enum, undefined, '允许退水时不该锁死');
});
