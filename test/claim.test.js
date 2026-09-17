/**
 * claim.test.js — 宣称账本（B2）
 *
 * 要解决的问题：AI 说"我是预言家""5 号查杀"，下一位 AI 读到的是**一句发言**，
 * 没有任何结构告诉它"这是未经证实的声称"。于是模型很自然地把它当事实继续推理 ——
 * 一局里只要有一次误信，后面整条推理链全是幻觉，而且玩家看起来像"AI 变笨了"。
 *
 * 本文件的守卫分三层：
 *   ① **抽取是确定性的**：模型漏报也不影响账本（引擎扫发言正文，不依赖模型诚实）；
 *   ② **宣称与事实物理分栏**：出现在「公开宣称」区，**绝不**出现在「公开硬事实」区；
 *   ③ **绝不泄露真值**：claim 事件不带说话者的真实身份，也不带任何查验结果，
 *      且真预言家的私密查验不会进入别人的快照。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('../src/engine/game');
const { runGame } = require('../src/engine/flow');
const { claimScan, mergeClaims, renderClaim } = require('../src/engine/claims');
const { makeMockAgentFactory, auditIsolation } = require('../scripts/mock-agent');
const context = require('../src/ai/context');

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

test('抽取是确定性的：自认身份 / 查杀 / 金水 / 用药都能扫出来，否定与假设扫不出来', () => {
  const seats = 12;
  const kinds = (t) => claimScan(t, seats).map((c) => `${c.kind}:${c.subject}:${c.value}`);
  assert.deepStrictEqual(kinds('我是预言家，昨晚验了 5 号是狼。'), ['seer:0:self', 'seer:5:wolf']);
  assert.deepStrictEqual(kinds('3号查杀，7号金水。'), ['seer:3:wolf', 'seer:7:good']);
  assert.deepStrictEqual(kinds('我跳女巫，昨晚救了 4 号。'), ['witch:0:self', 'witch:4:save']);
  assert.deepStrictEqual(kinds('我是守卫'), ['guard:0:self']);
  assert.deepStrictEqual(kinds('我是猎人，可以带走一个。'), ['hunter:0:self']);
  // 否定 / 假设 / 转述：不能记成"他宣称"
  assert.deepStrictEqual(kinds('我不是预言家，别乱猜。'), [], '否定句不得记成宣称');
  assert.deepStrictEqual(kinds('如果我是预言家，我会验 3 号。'), [], '假设句不得记成宣称');
  assert.deepStrictEqual(kinds('3号不是查杀，你们别投他。'), [], '否定式查杀不得记成宣称');
  // 不抽主观判断（那是看法，不是宣称）
  assert.deepStrictEqual(kinds('我觉得 5 号像狼，票他。'), [], '主观判断不进账本');
  // 座位越界与重复
  assert.deepStrictEqual(kinds('99号查杀，5号查杀，5号查杀'), ['seer:5:wolf'], '越界座位丢弃、重复只记一次');
});

test('合并：引擎扫描为主、模型自报补漏（去重 + 标清来源）', () => {
  const scanned = claimScan('我是预言家', 12);
  const merged = mergeClaims(scanned, [
    { kind: 'seer', subject: 0, value: 'self' }, // 与扫描重复
    { kind: 'witch', subject: 9, value: 'poison' }, // 扫描不到，补进来
    { kind: 'bogus', subject: 1, value: 'x' }, // 非法 kind，丢弃
    { kind: 'seer', subject: 99, value: 'wolf' }, // 越界座位，丢弃
  ], 12);
  assert.deepStrictEqual(merged.map((c) => `${c.kind}:${c.subject}:${c.value}|${c.source}`), [
    'seer:0:self|engine',
    'witch:9:poison|ai',
  ]);
  assert.match(renderClaim({ kind: 'seer', subject: 5, value: 'wolf' }), /声称 5号 是狼（查杀）/);
  assert.match(renderClaim({ kind: 'seer', subject: 7, value: 'good' }), /声称 7号 是好人（金水）/);
  assert.match(renderClaim({ kind: 'witch', subject: 4, value: 'save' }), /声称昨晚救了 4号/);
  assert.match(renderClaim({ kind: 'guard', subject: 0, value: 'self' }), /自称守卫/);
});

test('整局：说了就入账、事件里带 verifiedBy:null 且不含真值', async () => {
  // 所有 AI 的发言都自称预言家并按座位报查杀 —— 制造大量宣称
  const factory = (player, game) => {
    const mock = makeMockAgentFactory(Math.random)(player, game);
    return {
      async decide(req) {
        if (req.task === 'speech' || req.task === 'sheriff_speech' || req.task === 'pk_speech') {
          return { text: `我是预言家，${((player.seat % 11) + 1)}号查杀。`, explode: false, target: 0, withdraw: false };
        }
        return mock.decide(req);
      },
    };
  };
  const g = makeGame('claim1', 12, factory);
  await runGame(g);
  const claims = g.events.filter((e) => e.type === 'claim');
  assert.ok(claims.length > 0, '一局下来一条宣称都没记录（账本没接上）');
  for (const e of claims) {
    assert.strictEqual(e.data.verifiedBy, null, '引擎永远不替宣称背书');
    assert.ok(['seer', 'witch', 'guard', 'hunter', 'villager', 'other'].includes(e.data.kind), `非法 kind：${e.data.kind}`);
    // 红线：字段集合是**封闭**的 —— 多一个字段就可能把真值捎带出去
    assert.deepStrictEqual(
      Object.keys(e.data).sort(),
      ['day', 'kind', 'source', 'subject', 'value', 'verifiedBy'],
      `宣称事件的字段集合被改了，可能捎带真值：${JSON.stringify(e.data)}`,
    );
  }
  assert.strictEqual(auditIsolation(g).length, 0, '宣称破坏了可见性隔离');
});

test('分栏：宣称只出现在「公开宣称」区，绝不出现在「公开硬事实」区', async () => {
  const g = makeGame('claim2');
  g.day = 1;
  g.emit('deaths', { data: { deaths: [{ seat: 9, cause: 'wolf_kill' }] } });
  g.emit('speech', { actor: 3, data: { context: 'day', text: '我是预言家，5号查杀。' } });
  // 模拟 emitSpeech 的账本副作用（这里直接发事件，等价于引擎做的那一步）
  for (const c of claimScan('我是预言家，5号查杀。', 12)) {
    g.emit('claim', { actor: 3, data: { ...c, day: 1, verifiedBy: null } });
  }
  const snap = context.renderSnapshot(g, g.player(6), context.aggregate(g, g.player(6)), { task: 'speech' }, 0);
  const factPart = snap.split('公开宣称')[0];
  const claimPart = snap.split('公开宣称')[1] || '';
  assert.match(snap, /公开宣称（未经证实/, '必须有一个明确的"未经证实"分区');
  assert.match(claimPart, /3号 自称预言家/, '自认身份要进宣称区');
  assert.match(claimPart, /3号 声称 5号 是狼（查杀）/, '查验宣称要进宣称区');
  assert.ok(!/自称预言家|声称 5号/.test(factPart), '宣称不得出现在硬事实区（分栏失败就是幻觉源头）');
  assert.match(factPart, /9号/, '硬事实区仍要有真实死讯');
  // 真预言家的私密查验不会进别人的快照
  const seer = g.players.find((p) => p.role === 'seer');
  if (seer) {
    for (const other of g.players.filter((p) => p.seat !== seer.seat)) {
      const s2 = context.renderSnapshot(g, other, context.aggregate(g, other), { task: 'speech' }, 0);
      assert.ok(!/查验结果：/.test(s2) || other.role === 'seer', '私密查验结果泄漏给了别人');
    }
  }
});

test('宣称区有界：每个座位只留最近一次自认身份，查验宣称只留最近若干条', () => {
  const g = makeGame('claim3', 8);
  g.day = 2;
  for (let i = 0; i < 40; i++) {
    g.emit('claim', { actor: (i % 7) + 1, data: { kind: 'seer', subject: ((i % 7) + 1), value: 'wolf', day: 1 + Math.floor(i / 20), verifiedBy: null } });
  }
  g.emit('claim', { actor: 2, data: { kind: 'guard', subject: 0, value: 'self', day: 2, verifiedBy: null } });
  const snap = context.renderSnapshot(g, g.player(8), context.aggregate(g, g.player(8)), { task: 'speech' }, 0);
  const claimPart = snap.split('公开宣称')[1] || '';
  const lines = claimPart.split('\n').filter((l) => l.trim().startsWith('·'));
  assert.ok(lines.length <= 20, `宣称区必须有序上界（实际 ${lines.length} 行）`);
  assert.match(claimPart, /更早的 \d+ 条宣称已省略/, '截断必须写明（不静默）');
  assert.match(claimPart, /2号 自称守卫/, '最新的自认身份必须留下');
});
