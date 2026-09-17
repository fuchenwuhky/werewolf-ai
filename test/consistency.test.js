/**
 * consistency.test.js — 一致性审计（B5）
 *
 * 要守住的边界（每条都对应一个"审计会变成伤害"的方式）：
 *   ① **狼人撒谎不算矛盾** —— 审计是复盘，不是禁止欺骗；但狼的宣称要能出现在 rows 里供人查看；
 *   ② **好人藏身份不算矛盾** —— 神职自称村民是合法策略，只有"好人假跳神职"才要复核；
 *   ③ **只有当时有渠道知道的才谈得上"说错了"** —— 不是预言家的人报查验属于诈牌，不该被计成矛盾；
 *   ④ 纯函数：不改 game、同局两次结果必须一致（复盘工具最怕每次跑出来不一样）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('../src/engine/game');
const { BOARDS } = require('../src/engine/roles');
const { runGame } = require('../src/engine/flow');
const { makeRng } = require('../src/engine/rng');
const { reviewFacts } = require('../src/engine/review');
const { makeMockAgentFactory } = require('../scripts/mock-agent');
const { consistencyFacts } = require('../src/ai/consistency');
const { factsBlock, ruleReview, buildCoachPrompt } = require('../src/ai/coach');

// 照抄仓库既有测试的写法：任何真实出网请求都必须炸掉（审计与教练都必须是离线的）
global.fetch = async (url) => {
  const err = new Error(`测试禁止真实网络请求：${url}`);
  err.retryable = false;
  throw err;
};

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeGame(id, seatCount = 12, factory) {
  const board = seatCount === 12
    ? { wolf: 3, wolfking: 1, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 }
    : { wolf: 2, seer: 1, villager: 5 };
  const players = [];
  for (let i = 0; i < seatCount; i++) players.push({ name: `P${i + 1}` });
  const g = new Game({ id, board, players, agentFactory: factory || makeMockAgentFactory(Math.random), stepPauseMs: 0, logger: silentLogger });
  g.started = true;
  return g;
}

/** 造一条 claim 事件：与 flow.js 落账的形状保持一致（data.day + verifiedBy:null） */
function pushClaim(g, seat, data, day = 1) {
  g.emit('claim', { actor: seat, data: { source: 'engine', verifiedBy: null, ...data, day } });
}

test('(a) 真预言家报 5 号查杀、而 5 号实际是村民 → 1 条矛盾，且当时有渠道知道', () => {
  const g = makeGame('b5-a');
  g.player(3).role = 'seer';
  g.player(5).role = 'villager';
  pushClaim(g, 3, { kind: 'seer', subject: 5, value: 'wolf' }, 1);

  const { rows, contradictions } = consistencyFacts(g);
  assert.strictEqual(rows.length, 1, '每条 claim 事件都要产出一行');
  assert.deepStrictEqual(Object.keys(rows[0]).sort(), ['day', 'said', 'seat', 'truth', 'wasKnowable']);
  assert.strictEqual(rows[0].day, 1);
  assert.strictEqual(rows[0].seat, 3);
  assert.match(rows[0].said, /声称 5号 是狼（查杀）/, 'said 必须是给人看的人话');
  assert.strictEqual(rows[0].truth, '5号实际是村民');
  assert.strictEqual(rows[0].wasKnowable, true, '真预言家当时确实知道查验结果');

  assert.strictEqual(contradictions.length, 1);
  const c = contradictions[0];
  assert.deepStrictEqual(
    Object.keys(c).sort(),
    ['day', 'kind', 'reason', 'said', 'seat', 'subject', 'truth', 'value'],
    '矛盾条目必须是结构化字段，前端/复盘才能逐条渲染',
  );
  assert.strictEqual(c.day, 1);
  assert.strictEqual(c.seat, 3);
  assert.strictEqual(c.kind, 'seer');
  assert.strictEqual(c.subject, 5);
  assert.strictEqual(c.value, 'wolf');
  assert.strictEqual(c.truth, '5号实际是村民');
  assert.match(c.reason, /查验/, 'reason 要说明为什么算矛盾');
});

test('(a2) 真预言家报对的查验（狼人查杀 / 好人金水）不算矛盾', () => {
  const g = makeGame('b5-a2');
  g.player(3).role = 'seer';
  g.player(5).role = 'wolf';
  g.player(7).role = 'villager';
  pushClaim(g, 3, { kind: 'seer', subject: 5, value: 'wolf' }, 1);
  pushClaim(g, 3, { kind: 'seer', subject: 7, value: 'good' }, 2);
  const { rows, contradictions } = consistencyFacts(g);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].truth, '5号实际是狼人');
  assert.strictEqual(rows[1].truth, '7号实际是村民');
  assert.deepStrictEqual(contradictions, [], '报对了还被标矛盾，审计就成了噪声源');
});

test('(b) 同样的宣称由狼人说出 → 0 条矛盾（狼必须能撒谎）', () => {
  const g = makeGame('b5-b');
  g.player(3).role = 'wolf';
  g.player(5).role = 'villager';
  pushClaim(g, 3, { kind: 'seer', subject: 5, value: 'wolf' }, 1);
  pushClaim(g, 3, { kind: 'seer', subject: 0, value: 'self' }, 1); // 狼自称预言家
  const { rows, contradictions } = consistencyFacts(g);
  assert.strictEqual(rows.length, 2, '狼的宣称仍要出现在 rows 里供人查看');
  assert.deepStrictEqual(contradictions, [], '狼的任何宣称都不得计入矛盾');
  assert.strictEqual(rows[0].wasKnowable, false, '狼当时并没有查验渠道');
});

test('(c) 好人假跳神职算矛盾，好人自称村民（藏身份）不算', () => {
  const g = makeGame('b5-c');
  g.player(4).role = 'villager';
  g.player(3).role = 'seer';
  g.player(6).role = 'hunter';
  pushClaim(g, 4, { kind: 'seer', subject: 0, value: 'self' }, 1); // 村民自称预言家
  pushClaim(g, 3, { kind: 'villager', subject: 0, value: 'self' }, 1); // 真预言家自称平民：合法策略
  pushClaim(g, 6, { kind: 'seer', subject: 0, value: 'self' }, 2); // 真猎人称自己是预言家：假跳神职
  pushClaim(g, 6, { kind: 'other', subject: 0, value: 'self' }, 2); // 自称 other 一律不判
  const { rows, contradictions } = consistencyFacts(g);
  assert.strictEqual(rows.length, 4);
  assert.strictEqual(contradictions.length, 2, `只应命中两条假跳神职，实际：${JSON.stringify(contradictions)}`);
  assert.deepStrictEqual(contradictions.map((c) => c.seat), [4, 6]);
  assert.deepStrictEqual(contradictions.map((c) => c.subject), [0, 0]);
  assert.strictEqual(contradictions[0].truth, '4号实际是村民');
  assert.strictEqual(contradictions[1].truth, '6号实际是猎人');
  for (const c of contradictions) assert.match(c.reason, /假跳|必须复核/, 'reason 要写清为什么必须复核');
  // 自称平民/藏身份那两条必须在 rows 里留着，只是不算矛盾
  assert.match(rows[1].said, /自称村民/);
  assert.strictEqual(rows[1].wasKnowable, true, '自己的身份自己当然知道');
});

test('(d) 没有 claim 事件的对局 → rows 与 contradictions 都是空数组且不抛错', () => {
  const g = makeGame('b5-d');
  g.player(1).role = 'seer';
  g.emit('speech', { actor: 1, data: { context: 'day', text: '我是预言家，5号查杀。' } }); // 只是发言，没有 claim 事件
  const { rows, contradictions } = consistencyFacts(g);
  assert.deepStrictEqual(rows, []);
  assert.deepStrictEqual(contradictions, []);
  // 半个 game（未发牌/空对象/空值）也不该抛错：审计是复盘的最后一步，炸掉整份复盘得不偿失
  assert.deepStrictEqual(consistencyFacts({}), { rows: [], contradictions: [] });
  assert.deepStrictEqual(consistencyFacts(null), { rows: [], contradictions: [] });
});

test('(e) wasKnowable：狼人报查验 false、自称身份 true、真女巫报用药 true', () => {
  const g = makeGame('b5-e');
  g.player(2).role = 'wolf';
  g.player(8).role = 'witch';
  pushClaim(g, 2, { kind: 'seer', subject: 5, value: 'wolf' }, 1); // 狼报查验
  pushClaim(g, 2, { kind: 'guard', subject: 0, value: 'self' }, 1); // 狼自称身份
  pushClaim(g, 8, { kind: 'witch', subject: 5, value: 'save' }, 1); // 真女巫报用药
  pushClaim(g, 8, { kind: 'seer', subject: 5, value: 'wolf' }, 1); // 女巫报查验：她当时也无从知道
  const { rows, contradictions } = consistencyFacts(g);
  assert.deepStrictEqual(rows.map((r) => r.wasKnowable), [false, true, true, false]);
  assert.deepStrictEqual(contradictions, [], '不自知不等于矛盾（诈牌交给推理层判断）');
});

test('隐狼/暗恋者的查验陷阱：真预言家如实报"金水"不算矛盾，真值里写明查验口径', () => {
  const g = makeGame('b5-trap');
  g.player(3).role = 'seer';
  g.player(6).role = 'hiddenwolf';
  pushClaim(g, 3, { kind: 'seer', subject: 6, value: 'good' }, 1);
  const { rows, contradictions } = consistencyFacts(g);
  assert.strictEqual(rows[0].truth, '6号实际是狼人（查验口径为好人）');
  assert.deepStrictEqual(contradictions, [], '引擎的查验裁定就是好人，如实报出来不是他说错');
});

test('纯函数：不改 game、同局两次结果一致、狼的宣称与好人只差在"矛盾"那一边', () => {
  const g = makeGame('b5-pure');
  g.player(1).role = 'wolf';
  g.player(2).role = 'villager';
  g.player(3).role = 'seer';
  pushClaim(g, 1, { kind: 'seer', subject: 2, value: 'wolf' }, 1);
  pushClaim(g, 3, { kind: 'seer', subject: 2, value: 'wolf' }, 1);
  const before = JSON.stringify(g.events);
  const first = consistencyFacts(g);
  const second = consistencyFacts(g);
  assert.deepStrictEqual(first, second, '同一局必须得到同一份审计');
  assert.strictEqual(JSON.stringify(g.events), before, '审计不得修改 game');
  assert.strictEqual(first.rows.length, 2, '两条都进 rows（狼与好人一视同仁）');
  assert.strictEqual(first.contradictions.length, 1, '只有真预言家那条算矛盾');
  assert.strictEqual(first.contradictions[0].seat, 3);
});

// ---------- 接线：教练的"一致性核查"小节 ----------

async function playGame(seed) {
  const players = Array.from({ length: 12 }, (_, k) => ({ name: `P${k + 1}` }));
  const g = new Game({
    id: `b5-coach-${seed}`, board: BOARDS.adv12.roles, players, stepPauseMs: 0, logger: silentLogger, seed,
    agentFactory: makeMockAgentFactory(makeRng(seed)),
  });
  await runGame(g);
  return g;
}

test('教练接线：有矛盾时输出"一致性核查"，没有矛盾时不输出空标题', async () => {
  const g = await playGame(31);
  // mock 局里 AI 的发言可能自带宣称，先把账本清空，保证这一条只测我注入的那句
  g.events = g.events.filter((e) => e.type !== 'claim');
  const facts = reviewFacts(g, 1);
  assert.ok(!/一致性核查/.test(factsBlock(facts, g)), '没有矛盾时不得留下空标题');
  assert.ok(!/一致性核查/.test(ruleReview(facts, g)), '没有矛盾时规则点评不得留下空标题');
  // 旧调用方式（只传 facts，api.js 的 mock 路径就是这么调的）必须继续可用
  assert.ok(factsBlock(facts).length > 100);
  assert.ok(!/一致性核查/.test(factsBlock(facts)));

  // 注入一条必定矛盾的宣称：真预言家给村民报查杀
  const seer = g.players.find((p) => p.role === 'seer');
  const villager = g.players.find((p) => p.role === 'villager' && p.seat !== seer.seat);
  pushClaim(g, seer.seat, { kind: 'seer', subject: villager.seat, value: 'wolf' }, 2);
  assert.strictEqual(consistencyFacts(g).contradictions.length, 1);

  const block = factsBlock(facts, g);
  assert.match(block, /一致性核查/, '有矛盾时事实块必须带上这一小节');
  assert.match(block, new RegExp(`第2天${seer.seat}号`), '要写明是哪一天谁说的话');
  assert.match(block, new RegExp(`${villager.seat}号实际是村民`), '要写明真值');
  assert.match(ruleReview(facts, g), /一致性核查/);
  assert.match(buildCoachPrompt(g, facts).messages[1].content, /一致性核查/, '提示词里也要有，教练才会讲到');
});
