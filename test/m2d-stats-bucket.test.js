/**
 * m2d-stats-bucket.test.js — 战绩分桶与胜率（计划书 §5.3）
 *
 * 口径必须与 `src/api.js#profileStats` 一致（M2-b 已实现）：桶优先级 mock → spectate →
 * terminated → real；正式局里只有"阵营可判定且 winner 明确"的局进胜负；胜率分母 = wins+losses；
 * 分母为 0 ⇒「暂无」。另外逐条钉住"本轮不增加段位/排行榜/成就/趋势图"（模块里根本没有这些东西）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../web/shared/stats-bucket');

const game = (extra) => Object.assign({ finished: true, winner: 'good', faction: 'good' }, extra || {});

test('桶优先级：试玩 > 观战 > 终止 > 正式局（与服务端同口径）', () => {
  assert.strictEqual(B.bucketOf({ mock: true, spectate: true, winReason: '终止' }), 'mock');
  assert.strictEqual(B.bucketOf({ spectate: true, winReason: '终止' }), 'spectate');
  assert.strictEqual(B.bucketOf({ winReason: '手动终止对局' }), 'terminated');
  assert.strictEqual(B.bucketOf({ winReason: '狼人获胜' }), 'real');
  assert.strictEqual(B.bucketOf({ terminated: true }), 'terminated', '显式标志也认（前端摘要可能只有它）');
  assert.strictEqual(B.bucketOf({}), 'real');
});

test('正式局胜负：本人阵营 vs 胜方（好人胜且我是好人 ⇒ 胜）', () => {
  const s = B.summarize([
    game({ winner: 'good', faction: 'good' }),
    game({ winner: 'good', faction: 'wolf' }),
    game({ winner: 'wolf', faction: 'wolf' }),
  ]);
  assert.deepStrictEqual(s.formal, { total: 3, wins: 2, losses: 1, draws: 0, undecided: 0, decided: 3 });
  assert.strictEqual(s.rateText, '67%');
});

test('平局与"不可判定"分列，**不进胜率分母**（旧公式把平局算成好人胜 ⇒ 胜1负-1）', () => {
  const s = B.summarize([
    game({ winner: 'good', faction: 'good' }),
    game({ winner: 'draw', faction: 'good' }),
    game({ winner: 'none', faction: 'wolf' }),
    game({ winner: 'good', faction: null }),
  ]);
  assert.deepStrictEqual(s.formal, { total: 4, wins: 1, losses: 0, draws: 2, undecided: 1, decided: 1 });
  assert.strictEqual(s.rateText, '100%', '分母只算有效胜负局（1 局）');
  assert.strictEqual(s.formal.draws + s.formal.undecided, 3, '平／不可判定合并展示 = 4 − 1');
});

test('未结束的正式局不计入胜负平（正在进行 ≠ 战绩）', () => {
  const s = B.summarize([game({ finished: false }), game({ winner: 'wolf', faction: 'good' })]);
  assert.strictEqual(s.formal.total, 2, '桶里仍算正式局');
  assert.deepStrictEqual([s.formal.wins, s.formal.losses, s.formal.draws, s.formal.undecided], [0, 1, 0, 0],
    '只有已结束的那一局进胜负');
});

test('分母为零 ⇒「暂无」（不是 0%、不是 NaN%）', () => {
  assert.strictEqual(B.rateText(null, 0), '暂无');
  assert.strictEqual(B.rateText(0, 0), '暂无');
  assert.strictEqual(B.rateText(NaN, 0), '暂无');
  assert.strictEqual(B.summarize([]).rateText, '暂无');
  assert.strictEqual(B.summarize([game({ mock: true })]).rateText, '暂无');
  assert.strictEqual(B.summarize([]).rate, null);
});

test('四个桶各自计数，且分桶顺序固定（界面按它展示，不靠对象键顺序）', () => {
  const s = B.summarize([
    game(),
    game({ mock: true, finished: false }),
    game({ spectate: true }),
    game({ winReason: '终止' }),
  ]);
  assert.deepStrictEqual(s.buckets, { real: 1, mock: 1, spectate: 1, terminated: 1 });
  assert.deepStrictEqual(B.BUCKETS, ['real', 'mock', 'spectate', 'terminated']);
  assert.strictEqual(s.total, 4);
});

test('formatAggregate：服务端 /stats 的聚合结果 → 两端同一行文案（含"暂无"）', () => {
  const line = B.formatAggregate({ total: 9, real: 4, wins: 2, losses: 1, draws: 1, byBucket: { mock: 3, spectate: 1, terminated: 1 } });
  assert.strictEqual(line.includes('真实对局 4 局（胜率分母 3 局）'), true);
  assert.strictEqual(line.includes('2 胜 1 负'), true);
  assert.strictEqual(line.includes('1 平/不可判定'), true);
  assert.strictEqual(line.includes('胜率 67%'), true);
  assert.strictEqual(line.includes('试玩 3'), true);
  assert.strictEqual(line.includes('观战 1'), true);
  assert.strictEqual(line.includes('终止 1'), true);

  const empty = B.formatAggregate({ total: 0, real: 0, wins: 0, losses: 0, draws: 0, byBucket: {} });
  assert.strictEqual(empty.includes('胜率 暂无'), true, '分母为零显示"暂无"');
  assert.strictEqual(B.formatAggregate(null).includes('胜率 暂无'), true, '聚合结果缺失也不许崩');
});

test('本轮不做的东西：模块里没有段位/排行榜/成就/趋势图（§5.3 明文禁）', () => {
  const names = Object.keys(B);
  for (const banned of ['rank', 'leaderboard', 'achievement', 'trend']) {
    assert.strictEqual(names.some((n) => n.toLowerCase().includes(banned)), false, `不该出现 ${banned}`);
  }
});
