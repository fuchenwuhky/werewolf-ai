/**
 * memory-wiring.test.js — 记忆检索接进上下文组装器（P2-5 的集成面）
 *
 * `memory.test.js` 测的是打分与取舍算法本身；这里测**接线**：
 * 真的用一局 Game 走 `trimToBudget`，确认检索按预期被触发、结果稳定可复现、且不越过隔离边界。
 * 接线错位的典型症状是"算法全对但线上从不发生"——那正是单测覆盖不到的地方。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const context = require('../src/ai/context');
const { Game } = require('../src/engine/game');
const { estimateTokens } = require('../src/ai/tokens');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** 造一局"已经打了 8 天"的对局：每天有发言，便于撑出足够多的记忆条目 */
function makeLongGame() {
  const players = Array.from({ length: 8 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
  const g = new Game({
    id: 'mem-wire',
    board: { wolf: 2, seer: 1, witch: 1, villager: 4 },
    rules: {},
    players,
    stepPauseMs: 0,
    logger: silentLogger,
  });
  g.deal();
  g.day = 8;
  g.phase = 'day';
  for (let d = 1; d <= 8; d++) {
    g.emit('speech', { actor: ((d * 3) % 8) + 1, visibleTo: 'all', data: { context: 'day', text: `第${d}天的公开发言，内容够长以便形成记忆条目${'补充'.repeat(10)}` } });
  }
  return g;
}

/** 造一份与 8 天对局配套的纪要（每条都够长，保证超预算） */
function longDigests() {
  const m = new Map();
  for (let d = 1; d <= 8; d++) {
    m.set(d, [
      `- 第${d}天 ${((d * 2) % 8) + 1}号跳预言家并给出查验结论${'（背景补充）'.repeat(6)}`,
      `- 第${d}天有人反复划水，没有提供任何有效信息${'（噪声）'.repeat(8)}`,
    ].join('\n'));
  }
  return m;
}

test('接线：记忆装得下时不做检索，输出与旧的 renderDigests 逐字一致', () => {
  const g = makeLongGame();
  const digests = new Map([[1, '- 昨天 3号跳预言家'], [2, '- 今天 5号被查杀']]);
  const built = context.trimToBudget(g, g.player(3), { task: 'speech' }, { digests, lastSeq: 0 }, 100000);
  assert.strictEqual(built.memory.retrieved, false, '预算充裕时不该触发检索');
  assert.strictEqual(built.memory.omitted, 0);
  assert.strictEqual(built.sections.digests, context.renderDigests(digests), '必须与旧的全量拼接逐字一致');
});

test('接线：预算紧张时按相关度检索，并在上下文里标注保留/省略条数', () => {
  const g = makeLongGame();
  const digests = longDigests();
  const full = estimateTokens(context.renderDigests(digests));
  const built = context.trimToBudget(g, g.player(3), { task: 'vote', candidates: [3, 5] }, { digests, lastSeq: 0 }, Math.round(full / 2) + 400);
  assert.strictEqual(built.memory.retrieved, true, '预算紧张时应触发检索');
  assert.ok(built.memory.omitted > 0, '应确实省略了条目');
  assert.match(built.sections.digests, /已按相关度检索/, '上下文里必须写明检索过（不静默裁剪）');
  // 记忆区必须真的变小了（检索的意义就在这里；总长度不由这里保证——快照与任务永不裁剪）
  assert.ok(estimateTokens(built.sections.digests) < full, `记忆区应小于全量（${estimateTokens(built.sections.digests)} < ${full}）`);
});

test('接线：同一决策点重复组装必须逐字一致（journal 重放的前提）', () => {
  const g = makeLongGame();
  const digests = longDigests();
  const args = [{ task: 'vote', candidates: [3, 5] }, { digests, lastSeq: 0, suspicion: { 5: 60, 7: -20 } }, 700];
  const a = context.trimToBudget(g, g.player(3), ...args);
  const b = context.trimToBudget(g, g.player(3), ...args);
  assert.strictEqual(a.text, b.text, '同样的输入必须给出逐字相同的上下文');
  assert.deepStrictEqual(a.memory, b.memory);
});

test('接线：检索线索只来自该玩家可见信息（不越权）', () => {
  const g = makeLongGame();
  // 给 5号 一条只有狼队能看到的私密事件
  g.emit('wolf_kill', { actor: 6, visibleTo: [6, 8], data: { target: 4 } });
  const digests = longDigests();
  const built = context.trimToBudget(g, g.player(3), { task: 'vote' }, { digests, lastSeq: 0 }, 600);
  // 3号 是好人，不该出现狼队私密刀口事件的内容
  assert.ok(!built.text.includes('狼人共同选择'), '不得把狼队私密事件带进好人上下文');
  assert.ok(built.text.includes('局面快照'), '快照必须完整');
});

test('接线：memoryQuery 的线索集合是确定且有限的（不会把全部座位都当成相关）', () => {
  const g = makeLongGame();
  const ledger = context.aggregate(g, g.player(3));
  const q = context.memoryQuery(g, g.player(3), { task: 'vote', candidates: [3, 5] }, ledger, { 7: 30 });
  assert.ok(q.seats.has(5), '候选座位应进入线索');
  assert.ok(q.seats.has(7), '怀疑度里的座位应进入线索');
  assert.ok(q.seats.size < g.players.length, '不应把所有座位都算成"正在盘的人"，否则相关度失去区分力');
  assert.strictEqual(q.nowDay, 8);
});
