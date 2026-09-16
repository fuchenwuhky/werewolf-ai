/**
 * context-budget.test.js — 保真裁剪（B3）与事实脊柱（B1）
 *
 * 这两件事解决的是同一类"看不见的失真"：
 *   · B3：预算裁剪以前**没有约束快照**，而快照里装着"全部天数的逐条事实"。
 *         长局里它能把可用预算挤到下限 500，于是**当天的发言被裁光、十天前的死讯一条不少** ——
 *         该留的被裁、该省的留着。而且裁剪顺序也是反的：先切实录（正在讨论的现场），
 *         再压旧记忆（可检索的历史）。
 *   · B1：AI 每日自述的纪要被当成"事实与判断要点"注入（盖了事实的章）。它其实是模型的复述，
 *         错一次就会被之后每一轮当成既定事实继续推理。现在标题写明是自述、权威事实由引擎另给，
 *         且每天的**结论**压成一行"脊柱"永不裁剪 —— 事实不会因为对局长就消失。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('../src/engine/game');
const context = require('../src/ai/context');
const { estimateTokens } = require('../src/ai/tokens');
const { selectMemory, MEMORY_HEADER } = require('../src/ai/memory');
const { makeMockAgentFactory } = require('../scripts/mock-agent');

global.fetch = async (url) => {
  const err = new Error(`测试禁止真实网络请求：${url}`);
  err.retryable = false;
  throw err;
};

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeGame(id, seatCount = 12) {
  const board = seatCount === 12
    ? { wolf: 3, wolfking: 1, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 }
    : { wolf: 2, seer: 1, villager: 5 };
  const players = [];
  for (let i = 0; i < seatCount; i++) players.push({ name: `P${i + 1}` });
  const g = new Game({ id, board, players, agentFactory: makeMockAgentFactory(Math.random), stepPauseMs: 1, logger: silentLogger });
  for (const p of g.players) p.role = p.seat % 4 === 0 ? 'wolf' : p.seat % 5 === 0 ? 'seer' : 'villager';
  g.started = true;
  return g;
}

/** 造一局"很长"的对局：每天 factsPerDay 条票型 + 一条死讯 */
function makeLongGame(days = 20, factsPerDay = 20) {
  const g = makeGame('long');
  for (let d = 1; d <= days; d++) {
    g.day = d;
    g.emit('phase', { data: { title: `第${d}天 白天` } });
    for (let i = 0; i < factsPerDay; i++) {
      const seat = (i % 10) + 1;
      g.emit('vote_reveal', { data: { votes: [{ seat, target: ((i + 2) % 10) + 1, weight: 1 }], tally: { [seat]: 3 + (i % 3), 0: 1 } } });
    }
    g.emit('deaths', { data: { deaths: [{ seat: (d % 10) + 1, cause: 'wolf_kill' }] } });
  }
  return g;
}

test('B1：长局下每一天都还在"事实脊柱"里，最新一天的明细也还在，且快照有界', () => {
  const g = makeLongGame(20, 20);
  const st = { digests: new Map(), lastSeq: 0 };
  const uncapped = context.assemble(g, g.player(5), { task: 'speech' }, st);
  const uncappedTokens = estimateTokens(uncapped.sections.snapshot);
  const out = context.trimToBudget(g, g.player(5), { task: 'speech' }, st, 800);
  // ① 脊柱包含每一天：事实不能因为对局长就消失
  for (let d = 1; d <= 20; d++) {
    assert.match(out.sections.snapshot, new RegExp(`第${d}天·结论`), `第 ${d} 天从脊柱里丢了`);
  }
  // ② 最新一天的逐条明细保留（那是正在讨论的现场）
  assert.match(out.sections.snapshot, /第20天：/, '最新一天的明细被折叠了');
  // ③ 早期明细被折叠，且如实写明
  assert.match(out.sections.snapshot, /逐条明细已折叠/, '折叠时必须说明（不静默）');
  // ④ 快照有界：以前它无上界，长局里能把可用预算挤到下限。
  //    注意"有界"的正确说法是 **结构区（脊柱）+ 上限**：脊柱是刻意不裁的（事实优先），
  //    所以预算再紧也不会低于脊柱本身的体积 —— 这里就按这个不变式断言，而不是钉一个魔数。
  const ledger = context.aggregate(g, g.player(5));
  let spineFloor = estimateTokens('  每日脊柱（代码生成，永不裁剪）：');
  for (const d of [...ledger.byDay.keys()].sort((a, b) => a - b)) {
    spineFloor += estimateTokens(`  第${d}天·结论：${context.daySpine(g, ledger.byDay.get(d) || [])}`) + 1;
  }
  assert.ok(
    out.sectionTokens.snapshot <= spineFloor + 900,
    `快照 = 脊柱（不可裁）+ 有界的可选区：实际 ${out.sectionTokens.snapshot}，脊柱下限约 ${spineFloor}`,
  );
  assert.ok(
    out.sectionTokens.snapshot < uncappedTokens * 0.6,
    `快照必须有界：裁剪后 ${out.sectionTokens.snapshot} vs 无上限 ${uncappedTokens}`,
  );
});

test('B3：预算紧时先压旧记忆、保住当天发言链（旧顺序会先切实录）', () => {
  const g = makeGame('tight');
  g.day = 2;
  const marks = [];
  for (let i = 0; i < 10; i++) {
    const t = `【第${i + 1}段】我怀疑 ${(i % 11) + 1} 号，理由是票型与发言立场对不上，这一轮必须先处理他。`;
    marks.push(`【第${i + 1}段】`);
    g.emit('speech', { actor: (i % 11) + 1, data: { context: '', text: t } });
  }
  // 12 条很长的旧纪要：旧顺序会先把当天实录切掉，再压它们
  const digests = new Map();
  for (let d = 0; d < 12; d++) digests.set(101 + d, `- 第${101 + d}天的纪要：${'某个座位跳了预言家并且给了警徽流。'.repeat(8)}`);
  const out = context.trimToBudget(g, g.player(3), { task: 'speech' }, { digests, lastSeq: 0, transcriptDays: [2] }, 1500);
  const missing = marks.filter((m) => !out.sections.transcript.includes(m));
  assert.deepStrictEqual(missing, [], `当天的发言被裁掉了：${missing.join('')}`);
  assert.ok(out.memory.omitted > 0, `应先牺牲可检索的旧记忆（omitted=${out.memory.omitted}）`);
  assert.ok(out.sections.digests.includes('已按相关度检索'), '压记忆必须写明（不静默）');
});

test('B1：脊柱只复述真实发生过的事 —— 没有决定性事件的一天不编造结论', () => {
  const g = makeGame('nofab');
  g.day = 1;
  g.emit('deaths', { data: { deaths: [{ seat: 4, cause: 'wolf_kill' }] } });
  g.day = 2;
  // 第 2 天只有发言，没有任何决定性事件
  for (let i = 0; i < 5; i++) g.emit('speech', { actor: i + 1, data: { context: '', text: `我第${i + 1}个发言，先过。` } });
  const ledger = context.aggregate(g, g.player(6));
  const s1 = context.daySpine(g, ledger.byDay.get(1) || []);
  const s2 = context.daySpine(g, ledger.byDay.get(2) || []);
  assert.match(s1, /4号/, '第 1 天有人出局，脊柱必须写出来');
  assert.strictEqual(s2, '', '第 2 天没有决定性事件，脊柱必须是空的（不许编造）');
  // 脊柱里的座位号必须都在引擎事件里出现过
  const seats = new Set(g.events.flatMap((e) => [e.actor, e.data && e.data.seat, e.data && e.data.target].filter(Boolean)));
  for (const m of s1.matchAll(/(\d+)号/g)) {
    assert.ok(seats.has(Number(m[1])), `脊柱出现了事件里没有的座位号：${m[1]}号`);
  }
});

test('B1：记忆区标题必须声明"这是 AI 自述、不是事实"，且只有一份实现', () => {
  const digests = new Map([[1, '- 3号跳预言家']]);
  const out = selectMemory(digests, { nowDay: 3, budgetTokens: 100000 });
  assert.ok(out.text.startsWith(MEMORY_HEADER), '记忆区必须用统一标题开头');
  assert.match(out.text, /AI 自述/, '必须写明是模型自述');
  assert.match(out.text, /可能失真/, '必须提示可能失真');
  assert.match(out.text, /权威硬事实见下方局面快照/, '必须指出权威事实在哪里');
  assert.ok(!/事实与判断要点/.test(out.text), '旧标题把 AI 的猜测盖了事实的章，不得回归');
  // renderDigests 与 selectMemory 必须逐字同源（历史上是两份各写各的标题）
  assert.strictEqual(out.text, context.renderDigests(digests), '标题必须只有一份实现');
});

test('B3：估算保守 —— 中文按 1 字 ≈ 1 token，不再低估 1.5 倍', () => {
  const zh = '三号跳预言家并给了四号金水';
  assert.strictEqual(estimateTokens(zh), zh.length, '纯中文按字数估（保守偏大）');
  assert.ok(estimateTokens(zh) > Math.ceil(zh.length / 1.5), '必须显著大于旧算法 len/1.5');
  assert.strictEqual(estimateTokens('abcdefgh'), 2, 'ASCII 4 字符 ≈ 1 token');
});
