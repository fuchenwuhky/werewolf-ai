/**
 * visibility.test.js — 可见性 fail-closed 断言（P2-3）
 *
 * 被测的核心风险：`emit()` 原来的默认可见性是 `'all'`，任何私密事件只要作者忘了写
 * `visibleTo`，就会被当成公开发出去——而事件流是唯一的隔离出口，泄漏就此发生且不报错。
 * 这里把"忘了写 → 必须炸"逐条钉死。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('../src/engine/game');
const { runGame } = require('../src/engine/flow');
const { BOARDS } = require('../src/engine/roles');
const { makeRng } = require('../src/engine/rng');
const { makeMockAgentFactory } = require('../scripts/mock-agent');
const { EVENT_VISIBILITY, assertEventVisibility, auditEventSemantics } = require('../src/engine/visibility');

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function makeGame(n = 6) {
  const players = Array.from({ length: n }, (_, k) => ({ name: `P${k + 1}`, isHuman: false }));
  const board = { wolf: 2, villager: n - 2 };
  return new Game({ id: 'vis-test', board, players, stepPageMs: 0, stepPauseMs: 0, logger: silent, seed: 11 });
}

// ---------- 未登记类型 ----------
test('未登记的事件类型必须直接抛错（新增事件不能"默认公开"地溜过去）', () => {
  const g = makeGame();
  assert.throws(() => g.emit('某个还没登记的新事件', { text: 'x' }), /未声明可见性的事件类型/, '未登记类型必须报错而不是公开');
  assert.throws(() => assertEventVisibility('brand_new_type', 'all'), /未声明可见性/);
});

// ---------- 私密类型：省略即泄漏 ----------
test('私密事件省略 visibleTo 必须抛错——这正是"忘记声明就泄漏"的入口', () => {
  const g = makeGame();
  for (const type of ['seer_check', 'witch_info', 'night_guard', 'teammates', 'vote_cast', 'deal', 'wolf_kill']) {
    assert.throws(() => g.emit(type, { data: {} }), /必须显式给出座位数组/, `${type} 省略 visibleTo 必须被拒绝`);
  }
});

test('私密事件的可见性必须是"非空、合法座位"的数组', () => {
  const g = makeGame(6);
  assert.throws(() => g.emit('seer_check', { visibleTo: 'all' }), /必须显式给出座位数组/, "私密事件不能给 'all'");
  assert.throws(() => g.emit('seer_check', { visibleTo: 'god' }), /必须显式给出座位数组/);
  assert.throws(() => g.emit('seer_check', { visibleTo: [] }), /不能是空数组/, '空数组等于谁都看不到，是笔误');
  assert.throws(() => g.emit('seer_check', { visibleTo: [0] }), /非法座位/, '座位从 1 开始');
  assert.throws(() => g.emit('seer_check', { visibleTo: [7] }), /非法座位/, '越界座位必须被拦住');
  assert.throws(() => g.emit('seer_check', { visibleTo: ['3'] }), /整数座位数组/, '字符串座位是类型错误');
  assert.ok(g.emit('seer_check', { visibleTo: [3], data: {} }), '合法座位应放行');
});

// ---------- 公开 / 上帝 / 混合 ----------
test('公开事件可以省略 visibleTo（省略即公开），但不能定向投递', () => {
  const g = makeGame(6);
  const e1 = g.emit('speech', { actor: 1, text: '大家好' });
  assert.strictEqual(e1.visibleTo, 'all', '省略时应规范化为 all（保持事件结构不变）');
  assert.strictEqual(g.emit('phase', { visibleTo: 'all', text: 'x' }).visibleTo, 'all');
  assert.throws(() => g.emit('speech', { actor: 1, visibleTo: [2] }), /不允许定向可见/, '公开事件定向投递通常意味着类型登记错了');
});

test('上帝事件只能给 god，不能给普通座位', () => {
  const g = makeGame();
  assert.strictEqual(g.emit('ai_reasoning', { actor: 1, visibleTo: 'god', data: {} }).visibleTo, 'god');
  assert.throws(() => g.emit('ai_reasoning', { actor: 1, visibleTo: 'all', data: {} }), /只能 visibleTo: 'god'/);
  assert.throws(() => g.emit('llm_error', { visibleTo: [1], data: {} }), /只能 visibleTo: 'god'/);
});

test('混合类型必须显式声明（不允许走默认值），公开与定向都要放行', () => {
  const g = makeGame(6);
  assert.throws(() => g.emit('system', { text: '警徽被吞掉' }), /必须显式声明 visibleTo/, 'system 混用公开与狼队私密，必须写清楚');
  assert.throws(() => g.emit('role_reveal', { actor: 1, data: {} }), /必须显式声明 visibleTo/);
  assert.strictEqual(g.emit('system', { visibleTo: 'all', text: '公开公告' }).visibleTo, 'all');
  assert.deepStrictEqual(g.emit('system', { visibleTo: [2, 3], text: '狼队提示' }).visibleTo, [2, 3]);
  assert.deepStrictEqual(g.emit('role_reveal', { actor: 1, visibleTo: [1], data: {} }).visibleTo, [1]);
});

// ---------- 语义审计（结构与语义的分工） ----------
test('语义审计：结构合法但"给错人"的可见性必须被抓出来', () => {
  const g = makeGame(6);
  g.player(1).role = 'seer';
  g.player(2).role = 'villager';
  g.player(3).role = 'wolf';
  g.player(4).role = 'wolf';
  g.player(5).role = 'villager';
  g.player(6).role = 'villager';
  // 结构上完全合法（座位是真的、非空），但收件人错了 —— 只有语义审计能发现
  g.emit('seer_check', { actor: 1, visibleTo: [2], data: { target: 3, isWolf: true } });
  const problems = auditEventSemantics(g);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /seer_check 结果泄漏/);
  assert.match(problems[0], /应只给 seer/);
});

test('语义审计：投票保密、狼队私密、deal 只给本人；干净事件流应零问题', () => {
  const g = makeGame(6);
  const roles = { 1: 'seer', 2: 'villager', 3: 'wolf', 4: 'wolf', 5: 'villager', 6: 'villager' };
  for (const [s, r] of Object.entries(roles)) g.player(Number(s)).role = r;
  g.emit('vote_cast', { actor: 2, visibleTo: [2], data: { target: 3 } });
  g.emit('teammates', { actor: 3, visibleTo: [3], data: { seats: [4] } });
  g.emit('deal', { actor: 5, visibleTo: [5], data: { role: 'villager' } });
  g.emit('speech', { actor: 1, text: 'hi' });
  assert.deepStrictEqual(auditEventSemantics(g), [], '合法事件流不应有问题');

  // 逐个制造泄漏，必须都被抓住
  const leak = (type, opts, re) => {
    const g2 = makeGame(6);
    for (const [s, r] of Object.entries(roles)) g2.player(Number(s)).role = r;
    g2.emit(type, opts);
    const p = auditEventSemantics(g2);
    assert.strictEqual(p.length, 1, `${type} 的泄漏应被抓住，实际 ${p.length} 条`);
    assert.match(p[0], re);
  };
  leak('vote_cast', { actor: 2, visibleTo: [3], data: { target: 3 } }, /投票保密性被破坏/);
  leak('teammates', { actor: 3, visibleTo: [2], data: { seats: [4] } }, /狼队私密事件泄漏/);
  leak('deal', { actor: 5, visibleTo: [6], data: {} }, /deal 可见性异常/);
});

// ---------- 与真实对局的一致性 ----------
test('真实对局：所有被发出的事件类型都必须在表里登记（用实际跑一局反查覆盖率）', async () => {
  const seen = new Set();
  const players = Array.from({ length: 12 }, (_, k) => ({ name: `P${k + 1}`, isHuman: false }));
  const g = new Game({
    id: 'vis-real', board: BOARDS.adv12.roles, players, stepPauseMs: 1, logger: silent, seed: 2024,
    agentFactory: makeMockAgentFactory(makeRng(2024), { explodeRate: 0.05, runRate: 0.5 }),
  });
  const orig = g.emit.bind(g);
  g.emit = (type, opts) => { seen.add(type); return orig(type, opts); };
  await runGame(g);
  const undeclared = [...seen].filter((t) => !EVENT_VISIBILITY[t]);
  assert.deepStrictEqual(undeclared, [], `有事件类型没登记可见性：${undeclared.join(', ')}`);
  assert.ok(seen.size >= 20, `一局真实对局应覆盖足够多的事件类型，实际 ${seen.size} 种`);
  assert.deepStrictEqual(auditEventSemantics(g), [], '真实对局的隔离审计必须零问题');
});

test('隔离出口：visibleEvents 只能让本人看到私密事件，且不泄漏上帝事件', async () => {
  const players = Array.from({ length: 12 }, (_, k) => ({ name: `P${k + 1}`, isHuman: false }));
  const g = new Game({
    id: 'vis-exit', board: BOARDS.adv12.roles, players, stepPauseMs: 1, logger: silent, seed: 99,
    agentFactory: makeMockAgentFactory(makeRng(99), { explodeRate: 0.05 }),
  });
  await runGame(g);
  const wolfSeats = g.wolves().map((p) => p.seat);
  const inWolf = new Set(wolfSeats);
  for (const viewer of g.players.map((p) => p.seat)) {
    for (const e of g.visibleEvents(viewer)) {
      if (e.visibleTo === 'all') continue;
      if (e.visibleTo === 'god') assert.fail(`普通座位 ${viewer} 不该看到上帝事件 ${e.type}`);
      assert.ok(e.visibleTo.includes(viewer), `座位 ${viewer} 收到了不该可见的 ${e.type}`);
      if (['wolf_kill', 'wolf_kill_vote', 'wolf_propose', 'teammates'].includes(e.type)) {
        assert.ok(inWolf.has(viewer), `非狼座位 ${viewer} 看到了狼队事件 ${e.type}`);
      }
    }
  }
  // 上帝看得到全部；且私密事件数量必须 > 0（否则这个测试是空转）
  const godEvents = g.visibleEvents('god');
  assert.ok(godEvents.length >= g.events.length, '上帝视图应包含全部事件');
  assert.ok(g.events.some((e) => Array.isArray(e.visibleTo)), '本局应存在私密事件（否则隔离测试无意义）');
});
