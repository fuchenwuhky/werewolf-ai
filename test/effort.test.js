/**
 * effort.test.js — 按"信息含量"调度思考预算
 *
 * 设计依据（1213 次真实 GLM-5.3-Flash 调用的实测）：
 *   low 档  p50 3.6s  p90 19.1s avg  9.1s  ｜ 输出 token p50=75   p90=709
 *   high 档 p50 31.1s p90 134.8s avg 54.2s ｜ 输出 token p50=1270 p90=5123
 * 思考预算应花在"信息多、后果重"的决策上，而不是按任务名平均撒。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const effort = require('../src/ai/effort');
const { Game } = require('../src/engine/game');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const CFG = { reasoningEffort: 'high', fastEffort: 'low', maxTokens: 16000, fastMaxTokens: 8000, effortPolicy: 'info' };

function makeGame() {
  const board = { wolf: 3, wolfking: 1, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 };
  const players = [];
  for (let i = 0; i < 12; i++) players.push({ name: `P${i + 1}`, isHuman: false });
  const g = new Game({ id: 'effort-test', board, players, stepPauseMs: 1, logger: silentLogger });
  g.deal();
  return g;
}

// ---------- 任务族与档位 ----------
test('策略：结构化决策给极简档（什么都不用想），常规发言给降档', () => {
  // 夜间单点决策：无新增信息、非关键、人还多 → 极简
  assert.strictEqual(effort.planTier('seer_check', { newEvents: 0, alive: 10, day: 1 }).tier, 'minimal');
  assert.strictEqual(effort.planTier('vote', { newEvents: 0, alive: 10, day: 1 }).tier, 'minimal');
  // 常规发言（信息量一般）→ 降档到 normal（effort=low）：这是压掉 p90 尾巴的关键
  const routine = effort.planTier('speech', { newEvents: 3, alive: 10, day: 2, speechIndex: 2 });
  assert.strictEqual(routine.tier, 'normal');
  assert.strictEqual(effort.resolveBudget(routine.tier, CFG).effort, 'low');
  assert.strictEqual(effort.resolveBudget(routine.tier, CFG).maxTokens, 6000);
});

test('策略：信息越密集 / 越关键，档位越高（但单个信号不足以升档）', () => {
  const few = effort.planTier('speech', { decisive: 0, alive: 10, day: 1, speechIndex: 0 });
  assert.strictEqual(few.tier, 'normal', '常规白天发言 → 降档（low effort）');
  const medium = effort.planTier('speech', { decisive: 6, alive: 10, day: 2, speechIndex: 5 });
  assert.strictEqual(medium.tier, 'normal', '只有"信息较多"一个信号，仍不升档（否则等于没调度）');
  const surge = effort.planTier('speech', { decisive: 13, alive: 10, day: 3, speechIndex: 5 });
  assert.strictEqual(surge.tier, 'high', '局势剧变才升档');
  assert.strictEqual(effort.planTier('speech', { decisive: 13, alive: 5, day: 5, speechIndex: 5 }).tier, 'critical', '剧变+终局+后期 → 关键档');
});

test('策略：计数用"决定性事件"而非全部事件——12 个人各说一句不等于 6 倍信息量', () => {
  // 12 条发言 + 1 条死亡：决定性只有 1 条 → 常规档（low effort）
  const chatty = effort.planTier('speech', { decisive: 1, alive: 11, day: 2, speechIndex: 11 });
  assert.strictEqual(chatty.tier, 'normal');
  assert.strictEqual(effort.resolveBudget(chatty.tier, CFG).effort, 'low');
});

test('策略：终局与关键节点加档（把预算集中到真正改变胜负的地方）', () => {
  const endgame = effort.planTier('vote', { newEvents: 2, alive: 4, day: 4 });
  assert.ok(endgame.score > effort.planTier('vote', { newEvents: 2, alive: 10, day: 1 }).score, '终局每票都重，应加档');
  const pivotal = effort.planTier('shoot', { newEvents: 2, alive: 8, day: 3 });
  assert.ok(pivotal.reasons.some((r) => r.includes('关键')), '开枪属关键裁决');
  const pk = effort.planTier('pk_speech', { newEvents: 6, alive: 6, day: 3, speechIndex: 1 });
  assert.strictEqual(pk.tier, 'critical', 'PK 发言是最关键的信息输出');
});

test('策略：遗言封顶 normal（实测 low 档已是尾部最差，升档反而更差）', () => {
  const t = effort.planTier('lastwords', { newEvents: 30, alive: 4, day: 3, speechIndex: 9 });
  assert.strictEqual(t.tier, 'normal');
  assert.ok(t.reasons.some((r) => r.includes('封顶')), '应给出封顶原因');
  assert.strictEqual(effort.resolveBudget(t.tier, CFG).effort, 'low');
});

test('策略：未知任务保守取高（不能因为不认识而削弱）', () => {
  const t = effort.planTier('some_new_task', {});
  assert.strictEqual(t.tier, 'high');
  assert.ok(t.reasons[0].includes('保守'));
});

// ---------- 预算解析：仍尊重用户配置 ----------
test('预算：档位只是语义，最终取值尊重用户配置的 effort 与上限', () => {
  const lowTier = effort.resolveBudget('normal', CFG);
  assert.strictEqual(lowTier.effort, 'low', 'normal 档用 fastEffort');
  assert.strictEqual(lowTier.maxTokens, 6000);
  const highTier = effort.resolveBudget('critical', CFG);
  assert.strictEqual(highTier.effort, 'high', 'critical 档用 reasoningEffort');
  assert.strictEqual(highTier.maxTokens, 16000);
  assert.strictEqual(highTier.hardCap, 16000, 'hardCap 不得超过用户配的 maxTokens');

  // 用户把 maxTokens 压到 4000：所有档位都不得超过它
  const tight = effort.resolveBudget('critical', { ...CFG, maxTokens: 4000 });
  assert.strictEqual(tight.maxTokens, 4000);
  assert.strictEqual(tight.hardCap, 4000);
  // 用户把 fastMaxTokens 调大也不会超过 maxTokens
  const loose = effort.resolveBudget('normal', { ...CFG, fastMaxTokens: 20000 });
  assert.strictEqual(loose.maxTokens, 6000, '档位自身的上限仍然生效');
});

test('预算：hardCap 让 maxTokens 真正生效（否则截断后预算会一路翻到 32768）', () => {
  for (const tier of effort.TIER_ORDER) {
    const b = effort.resolveBudget(tier, CFG);
    assert.ok(b.hardCap >= b.maxTokens, `${tier} hardCap 不应小于初始预算`);
    assert.ok(b.hardCap <= 32768, `${tier} hardCap 不应超过全局硬上限`);
  }
  assert.ok(effort.resolveBudget('minimal', CFG).hardCap < effort.resolveBudget('critical', CFG).hardCap,
    '极简档的思考上限应显著低于关键档');
});

// ---------- flat 回退 ----------
test('flat 策略：完全保持改动前的按任务名分层（可 A/B、可回滚）', () => {
  const g = makeGame();
  const flat = { ...CFG, effortPolicy: 'flat' };
  const speech = effort.planEffort(g, g.player(2), { task: 'speech' }, { cfg: flat, lastSeq: 0 });
  assert.strictEqual(speech.effort, 'high');
  assert.strictEqual(speech.maxTokens, 12000);
  assert.strictEqual(speech.tier, 'flat');
  const night = effort.planEffort(g, g.player(2), { task: 'seer_check' }, { cfg: flat, lastSeq: 0 });
  assert.strictEqual(night.effort, 'low');
  assert.strictEqual(night.maxTokens, 8000);
});

// ---------- 特征采集：来自真实局面，确定性 ----------
test('特征采集：信息量 = 距我上次决策新增的"决定性事件"数；终局人数正确', () => {
  const g = makeGame();
  const me = g.player(2);
  const f0 = effort.collectFeatures(g, me, { task: 'speech' }, 0);
  assert.strictEqual(f0.alive, 12);
  assert.ok(f0.decisive >= 0 && typeof f0.decisive === 'number');
  // 发牌/队友这类噪音不得计入信息量
  const all = g.visibleEvents(me.seat, 0);
  const noiseOnly = all.filter((e) => effort.CHATTER_TYPES.has(e.type));
  assert.ok(noiseOnly.length > 0, '局面上确实存在噪音事件');
  assert.ok(f0.decisive <= all.length - noiseOnly.length + 0, '噪音不应计入决定性事件');
  // 游标推到最末 → 无新增
  const last = all.reduce((m, e) => Math.max(m, e.seq), 0);
  assert.strictEqual(effort.collectFeatures(g, me, { task: 'speech' }, last).decisive, 0, '游标已到最末时无新增信息');
  assert.strictEqual(effort.planTier('vote', { decisive: 0, alive: 12, day: 1 }).tier, 'minimal', '无新增信息的结构化决策走极简档');
  // 死掉 8 人 → 终局
  let killed = 0;
  for (const p of g.players) { if (p.seat !== me.seat && killed < 8) { p.alive = false; killed++; } }
  assert.strictEqual(effort.collectFeatures(g, me, { task: 'speech' }, 0).alive, 4);
});

test('端到端：全 AI 局里档位分布合理（常规决策为主，关键节点少数加档）', () => {
  const tiers = {};
  // 模拟一天：夜间结构化 + 白天发言（信息量递增）
  const tasks = [
    ['wolf_chat', { decisive: 1, alive: 12, day: 1 }],
    ['night_guard', { decisive: 2, alive: 12, day: 1 }],
    ['seer_check', { decisive: 3, alive: 12, day: 1 }],
    ['vote', { decisive: 9, alive: 11, day: 1 }],
    ['speech', { decisive: 1, alive: 11, day: 2, speechIndex: 0 }],
    ['speech', { decisive: 3, alive: 11, day: 2, speechIndex: 5 }],
    ['speech', { decisive: 9, alive: 4, day: 4, speechIndex: 8 }],
    ['shoot', { decisive: 3, alive: 4, day: 4 }],
  ];
  for (const [task, f] of tasks) {
    const { tier } = effort.planTier(task, f);
    tiers[tier] = (tiers[tier] || 0) + 1;
  }
  assert.ok(tiers.minimal || tiers.low, '存在极简/低档的常规决策');
  assert.ok(tiers.critical, '终局与开枪应进入关键档');
  // 关键档必须少数：否则等于没做调度
  const total = tasks.length;
  const criticalShare = (tiers.critical || 0) / total;
  assert.ok(criticalShare <= 0.3, `关键档占比应保持少数，实际 ${criticalShare}`);
});
