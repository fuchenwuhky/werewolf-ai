/**
 * metrics.test.js — 评测指标的口径测试（P1-6）
 *
 * 指标最容易出的问题是"口径悄悄错了"：早期版本只看 `deaths` 事件，
 * 而放逐/自爆的死因根本不在那个事件里 —— 结果整个"投票出局"类别消失，
 * 被放逐的人还被算成"活到最后"。所以这里用**已知真值**的合成对局把口径钉死。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('../src/engine/game');
const metrics = require('../scripts/eval/metrics');
const { makeMockAgentFactory } = require('../scripts/mock-agent');
const { runOneGame, seedFor, parseArgs, CONFIGS } = require('../scripts/eval/eval-harness');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeGame(roles) {
  const board = { wolf: 0, villager: 0 };
  for (const r of Object.values(roles)) board[r] = (board[r] || 0) + 1;
  const players = Object.keys(roles).map((s) => ({ name: `P${s}`, isHuman: false }));
  const g = new Game({ id: 'metrics-test', board, players, stepPauseMs: 1, logger: silentLogger, seed: 7 });
  for (const p of g.players) p.role = roles[p.seat];
  return g;
}

// ---------- 纯函数 ----------
test('percentile：线性插值，空数组/单元素/边界都要对', () => {
  assert.strictEqual(metrics.percentile([], 0.9), null);
  assert.strictEqual(metrics.percentile([5], 0.9), 5);
  assert.strictEqual(metrics.percentile([1, 2, 3, 4], 0.5), 3); // 位置 1.5 → 2 + 0.5*(3-2)=2.5 → round 3
  assert.strictEqual(metrics.percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9), 91);
  assert.strictEqual(metrics.percentile([1, null, undefined, 3], 1), 3, '非法值必须被过滤');
});

test('detectClaims：文本启发式能认出悍跳/起跳，且不误伤普通发言', () => {
  const ev = (actor, text) => ({ type: 'speech', actor, day: 1, seq: 1, data: { text } });
  const cases = [
    ['我是预言家，昨晚查验了3号', 'seer'],
    ['我是真预言家，2号是狼', 'seer'],
    ['悍跳一下，我是预言家', 'seer'],
    ['我是女巫，昨晚救的人是我自己', 'witch'],
    ['我是守卫，昨晚守的自己', 'guard'],
  ];
  for (const [text, kind] of cases) {
    const got = metrics.detectClaims([ev(1, text)]);
    assert.strictEqual(got.length, 1, `应识别出 1 条 claims：${text}`);
    assert.strictEqual(got[0].kind, kind);
    assert.strictEqual(got[0].actor, 1);
  }
  assert.deepStrictEqual(metrics.detectClaims([ev(1, '我是好人，昨晚很平静，先听后置位。')]), [], '普通发言不应被当成起跳');
  assert.deepStrictEqual(metrics.detectClaims([{ type: 'vote_cast', actor: 1, data: { target: 2 } }]), [], '非发言事件不参与识别');
});

// ---------- 死亡台账 ----------
test('死亡台账：死亡日与死因必须覆盖狼刀/毒/放逐/自爆/枪，且被放逐者不算"活到最后"', () => {
  const g = makeGame({ 1: 'wolf', 2: 'seer', 3: 'villager', 4: 'witch', 5: 'hunter', 6: 'villager' });
  g.day = 3;
  // 模拟 settleDeath 的记账（引擎里由 flow.settleDeath 写入）
  const kill = (seat, cause, day) => { const p = g.player(seat); p.alive = false; p.deathCause = cause; p.deathDay = day; };
  kill(2, 'wolf_kill', 1);
  kill(3, 'vote_out', 2);
  kill(4, 'poison', 2);
  kill(5, 'shot', 3);
  const st = metrics.deathStats(g);
  assert.strictEqual(st.hasLedger, true);
  assert.strictEqual(st.byCause.wolf_kill, 1);
  assert.strictEqual(st.byCause.vote_out, 1, '放逐必须被计入死因（旧口径会整类丢失）');
  assert.strictEqual(st.byCause.poison, 1);
  assert.strictEqual(st.byCause.shot, 1);
  assert.strictEqual(st.survived[3], 2, '被放逐者应记为第 2 天出局，而不是活到最后');
  assert.strictEqual(st.survived[1], 3, '存活者记为当前天数');
  assert.strictEqual(st.survived[6], 3);
});

test('死亡台账：旧存档没有台账时回退到事件流（不会崩，也不会把所有人算成存活）', () => {
  const g = makeGame({ 1: 'wolf', 2: 'seer', 3: 'villager', 4: 'villager', 5: 'villager' });
  g.day = 2;
  g.players.forEach((p) => { p.alive = true; });
  g.player(2).alive = false;
  g.emit('deaths', { data: { deaths: [{ seat: 2, cause: 'wolf_kill' }] } }); // 事件发生在第 2 天
  g.day = 3; // 对局继续到第 3 天
  const st = metrics.deathStats(g);
  assert.strictEqual(st.hasLedger, false);
  assert.strictEqual(st.byCause.wolf_kill, 1);
  assert.strictEqual(st.survived[2], 2, '死亡日取事件所在天数（而不是算成活到最后）');
  assert.strictEqual(st.survived[3], 3, '未死者按当前天数');
});

// ---------- 投票口径 ----------
test('投票口径：命中率把狼的战术票与好人的票分开算，弃票单独计', () => {
  const g = makeGame({ 1: 'wolf', 2: 'wolf', 3: 'seer', 4: 'villager', 5: 'villager', 6: 'villager' });
  const vote = (actor, target) => g.emit('vote_cast', { actor, visibleTo: [actor], data: { target } });
  vote(3, 1);   // 好人投中狼 ✓
  vote(4, 1);   // 好人投中狼 ✓
  vote(1, 3);   // 狼投好人 ✗（且不该污染"好人命中率"）
  vote(2, 0);   // 弃票
  const v = metrics.voteStats(g, [1, 2]);
  assert.strictEqual(v.cast, 3);
  assert.strictEqual(v.abstain, 1);
  assert.strictEqual(v.hit, 2);
  assert.strictEqual(v.hitWolfRate, 0.667);
  assert.strictEqual(v.goodCast, 2, '只有好人的两张票计入 goodCast');
  assert.strictEqual(v.goodHit, 2);
  assert.strictEqual(v.goodHitWolfRate, 1);
});

// ---------- 查验口径 ----------
test('查验口径：只统计 seer_check 事件，命中率按"查到狼"算', () => {
  const g = makeGame({ 1: 'wolf', 2: 'wolf', 3: 'seer', 4: 'villager', 5: 'villager', 6: 'villager' });
  g.emit('seer_check', { actor: 3, visibleTo: [3], data: { target: 1 } });   // 狼 ✓
  g.emit('seer_check', { actor: 3, visibleTo: [3], data: { target: 4 } });   // 好人 ✗
  g.emit('seer_check', { actor: 3, visibleTo: [3], data: { target: 2 } });   // 狼 ✓
  const s = metrics.seerStats(g, [1, 2]);
  assert.strictEqual(s.count, 3);
  assert.strictEqual(s.hits, 2);
  assert.strictEqual(s.hitRate, 0.667);
});

// ---------- 悍跳口径 ----------
test('悍跳口径：分开统计狼跳与人跳，并给出"跳完是否活过当天"的存活率', () => {
  const g = makeGame({ 1: 'wolf', 2: 'wolf', 3: 'seer', 4: 'villager', 5: 'villager', 6: 'villager' });
  g.day = 1;
  // 狼 2 号当天被放逐（用引擎同款台账写法）
  const p2 = g.player(2);
  p2.alive = false;
  p2.deathCause = 'vote_out';
  p2.deathDay = 1;
  g.day = 3;
  const claims = [
    { actor: 1, kind: 'seer', day: 1, seq: 1 },  // 狼跳，一直活到最后 → 成功
    { actor: 2, kind: 'seer', day: 1, seq: 2 },  // 狼跳，当天被放逐 → 失败
    { actor: 3, kind: 'seer', day: 1, seq: 3 },  // 真预言家（好人）
    { actor: 4, kind: 'guard', day: 2, seq: 4 }, // 好人跳守卫
  ];
  const f = metrics.fakeClaimStats(g, claims);
  assert.strictEqual(f.wolfSeerClaims, 2);
  assert.strictEqual(f.wolfSeerClaimSurvived, 1);
  assert.strictEqual(f.wolfSeerClaimSurvivalRate, 0.5);
  assert.strictEqual(f.goodClaims, 2);
  assert.strictEqual(f.wolfClaims, 2);
});

// ---------- 单局提取与聚合 ----------
test('extractGameMetrics：给出完整字段，mock 局（无 LLM）的 token/延迟为 0 或 null 而不是 NaN', () => {
  const g = makeGame({ 1: 'wolf', 2: 'seer', 3: 'villager', 4: 'villager' });
  g.day = 2;
  g.finished = true;
  g.winner = 'good';
  g.emit('vote_cast', { actor: 3, visibleTo: [3], data: { target: 1 } });
  const m = metrics.extractGameMetrics(g, { seed: 42, board: 'x', config: 'base' });
  assert.strictEqual(m.winner, 'good');
  assert.strictEqual(m.days, 2);
  assert.strictEqual(m.seed, 42);
  assert.strictEqual(m.llm.calls, 0);
  assert.strictEqual(m.llm.latencyP90, null, '没有调用时 p90 必须是 null');
  assert.strictEqual(m.teams.wolf, 1);
  assert.strictEqual(m.teams.good, 3);
  assert.deepStrictEqual(m.isolationProblems, []);
  assert.ok(Number.isFinite(m.avgSurvived));
});

test('aggregate：胜率/均值/分位数按局数正确汇总', () => {
  const mk = (winner, days, hit, cast, calls, p90) => ({
    winner, days,
    votes: { cast, abstain: 0, hit, goodCast: cast, goodHit: hit },
    seer: { count: 2, hits: 1 },
    fakeClaim: { wolfSeerClaims: 1, wolfSeerClaimSurvived: 1 },
    llm: { calls, promptTokens: 100, completionTokens: 50, cachedTokens: 20, latencyP90: p90 },
    deathsByCause: { wolf_kill: 1 },
    byRole: { wolf: { n: 1, team: 'wolf', survivedSum: days, died: 1 } },
    isolationProblems: [],
  });
  const agg = metrics.aggregate([mk('good', 2, 1, 2, 10, 100), mk('wolf', 4, 1, 2, 20, 300)]);
  assert.strictEqual(agg.games, 2);
  assert.strictEqual(agg.winRate.good, 0.5);
  assert.strictEqual(agg.winRate.wolf, 0.5);
  assert.strictEqual(agg.avgDays, 3);
  assert.strictEqual(agg.vote.hitWolfRate, 0.5);
  assert.strictEqual(agg.vote.perGame, 2);
  assert.strictEqual(agg.cost.calls, 30);
  assert.strictEqual(agg.cost.callsPerGame, 15);
  assert.strictEqual(agg.cost.tokensPerGame, 150);
  assert.strictEqual(agg.cost.cachedRatio, 0.2);
  assert.strictEqual(agg.isolationProblems, 0);
  assert.ok(agg.latency.p90 >= 100 && agg.latency.p90 <= 300);
});

test('aggregate：平局（winner=draw）不计入任何一方胜率，单列 wins.draw', () => {
  const mk = (winner, days) => ({
    winner, days,
    votes: { cast: 0, abstain: 0, hit: 0, goodCast: 0, goodHit: 0 },
    seer: { count: 0, hits: 0 },
    fakeClaim: { wolfSeerClaims: 0, wolfSeerClaimSurvived: 0 },
    llm: { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, latencyP90: null },
    deathsByCause: {},
    byRole: {},
    isolationProblems: [],
  });
  // 1 局好人胜 + 1 局平局：分母仍是 2，所以好人胜率被平局压低到 0.5，狼人胜率为 0
  const agg = metrics.aggregate([mk('good', 3), mk('draw', 6)]);
  assert.strictEqual(agg.wins.good, 1);
  assert.strictEqual(agg.wins.wolf, 0);
  assert.strictEqual(agg.wins.draw, 1);
  assert.strictEqual(agg.winRate.good, 0.5);
  assert.strictEqual(agg.winRate.wolf, 0);
  assert.strictEqual(agg.winRate.draw, 0.5, '平局要单列可见，而不是被并进 other');
  assert.strictEqual(agg.winRate.other, 0, 'other 只统计"既非胜负也非平局"的异常局（如对局终止）');
});

// ---------- 基线门禁 ----------
test('基线对比：容差内通过；超差必须失败；隔离泄漏是零容忍', () => {
  const base = { winRate: { good: 0.5, wolf: 0.5 }, avgDays: 4, isolationProblems: 0, latency: { p90: 1000 } };
  const ok = metrics.compareBaseline({ winRate: { good: 0.55, wolf: 0.45 }, avgDays: 4.2, isolationProblems: 0, latency: { p90: 1100 } }, base);
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.diffs));

  const badWin = metrics.compareBaseline({ winRate: { good: 0.2, wolf: 0.8 }, avgDays: 4, isolationProblems: 0, latency: { p90: 1000 } }, base);
  assert.strictEqual(badWin.ok, false, '胜率偏离 30pp 必须判为回归');

  const badDays = metrics.compareBaseline({ winRate: { good: 0.5, wolf: 0.5 }, avgDays: 6, isolationProblems: 0, latency: { p90: 1000 } }, base);
  assert.strictEqual(badDays.ok, false, '天数涨 50% 必须判为回归');

  const leak = metrics.compareBaseline({ winRate: { good: 0.5, wolf: 0.5 }, avgDays: 4, isolationProblems: 1, latency: { p90: 1000 } }, base);
  assert.strictEqual(leak.ok, false, '隔离泄漏零容忍');
});

// ---------- 端到端（注入 mock 工厂，确定性） ----------
test('harness 端到端：同种子两次运行指标必须完全一致（回归门禁的前提）', async () => {
  const run = async () => {
    const { game, audit } = await runOneGame({
      id: 'e2e-det', seed: 4242, board: 'adv12',
      agentFactory: makeMockAgentFactory(require('../src/engine/rng').makeRng(4242), { explodeRate: 0.02 }),
    });
    return { m: metrics.extractGameMetrics(game, { seed: 4242, board: 'adv12', config: 'base', audit }), audit };
  };
  const a = await run();
  const b = await run();
  assert.strictEqual(a.m.winner, b.m.winner, '同种子胜负必须一致');
  assert.strictEqual(a.m.days, b.m.days);
  assert.strictEqual(a.m.events, b.m.events);
  assert.deepStrictEqual(a.m.votes, b.m.votes);
  assert.deepStrictEqual(a.m.deathsByCause, b.m.deathsByCause);
  assert.strictEqual(a.audit.length, 0, `隔离审计必须通过：${a.audit.join('; ')}`);
  assert.strictEqual(a.m.isolationProblems.length, 0);
});

test('harness 端到端：跑完整局后指标自洽（胜率/天数/事件/死因都不是空值）', async () => {
  const { game, audit } = await runOneGame({
    id: 'e2e-sane', seed: 777, board: 'adv12',
    agentFactory: makeMockAgentFactory(require('../src/engine/rng').makeRng(777), { explodeRate: 0.02 }),
  });
  assert.ok(game.finished, '对局应正常结束');
  assert.ok(['good', 'wolf'].includes(game.winner));
  const m = metrics.extractGameMetrics(game, { seed: 777, board: 'adv12', audit });
  assert.ok(m.days >= 1);
  assert.ok(m.events > 50, `事件数偏少：${m.events}`);
  assert.ok(m.votes.cast > 0, '应产生过投票');
  assert.ok(Object.values(m.survival).every((d) => d >= 1 && d <= m.days), `存活天数必须在 [1, 总局数] 内：${JSON.stringify(m.survival)}`);
  const deaths = Object.values(m.deathsByCause).reduce((a, b) => a + b, 0);
  assert.ok(deaths > 0, '应有人出局');
  assert.deepStrictEqual(audit, []);
});

test('harness 参数与配置矩阵：种子推导稳定，engine/ai 配置分流正确', () => {
  assert.strictEqual(seedFor(1000, 0), 1000);
  assert.strictEqual(seedFor(1000, 1), (1000 + 7919) >>> 0);
  assert.strictEqual(seedFor(1000, 0), seedFor(1000, 0), '同参数必须同结果');
  const args = parseArgs(['node', 'x', '--games=3', '--live', '--max-calls=50']);
  assert.strictEqual(args.games, 3);
  assert.strictEqual(args.live, true);
  assert.strictEqual(args.maxCalls, 50);
  const engineCfgs = Object.entries(CONFIGS).filter(([, c]) => c.affects === 'engine').map(([k]) => k);
  const aiCfgs = Object.entries(CONFIGS).filter(([, c]) => c.affects === 'ai').map(([k]) => k);
  assert.ok(engineCfgs.includes('base') && engineCfgs.includes('nosheriff'));
  assert.ok(aiCfgs.includes('fast') && aiCfgs.includes('noreflect'), 'AI 层配置应被标记，mock 模式下跳过（否则是重复劳动）');
});
