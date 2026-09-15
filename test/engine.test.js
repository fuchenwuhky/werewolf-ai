/**
 * engine.test.js — 引擎单元测试（node --test）
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('../src/engine/game');
const { ROLES, BOARDS, validateBoard } = require('../src/engine/roles');
const { mergeRules, describeRules } = require('../src/engine/rules');
const { runGame, validatePayload, secretVote, buildSpeechOrder, checkWinWithPending, _internals } = require('../src/engine/flow');
const { extractJson } = require('../src/ai/agent');
const { buildSystemPrompt, buildCommonPrompt, buildPersonalPrompt, taskInstruction } = require('../src/ai/prompts');
const { DEFAULT_CONFIG, migrateConfig, createConfig } = require('../src/config');
const { PERSONALITIES, resolvePersona, applyPersonalities } = require('../src/ai/personalities');
const { makeMockAgentFactory, auditIsolation } = require('../scripts/mock-agent');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeGame(opts = {}) {
  const board = opts.board || { wolf: 3, wolfking: 1, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 };
  const seatCount = Object.values(board).reduce((a, b) => a + b, 0);
  const players = [];
  for (let i = 0; i < seatCount; i++) {
    players.push({ name: `P${i + 1}`, isHuman: opts.humanSeat != null && opts.humanSeat - 1 === i });
  }
  return new Game({
    id: opts.id || 'test',
    board,
    rules: opts.rules,
    players,
    agentFactory: makeMockAgentFactory(opts.rnd || Math.random, opts.mock || {}),
    stepPauseMs: opts.stepPauseMs != null ? opts.stepPauseMs : 1,
    logger: silentLogger,
  });
}

/** 直接指派身份（不洗牌），供规则矩阵测试 */
function assignRoles(game, map) {
  for (const p of game.players) p.role = map[p.seat] || 'villager';
  const wolfSeats = game.wolves().map((p) => p.seat);
  for (const w of game.wolves()) {
    const mates = wolfSeats.filter((s) => s !== w.seat);
    game.emit('teammates', { actor: w.seat, visibleTo: [w.seat], data: { seats: mates }, text: '' });
  }
  game.started = true;
}

// ---------- roles / rules ----------
test('板子校验：合法与非法', () => {
  assert.ok(validateBoard({ wolf: 4, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 }).ok);
  assert.ok(!validateBoard({ wolf: 0, villager: 5 }).ok, '无狼应不合法');
  assert.ok(!validateBoard({ wolf: 5, villager: 1 }).ok, '狼不少于好人不合法');
  assert.ok(!validateBoard({ wolf: 2, villager: 1 }).ok, '总数不足不合法');
});

test('发牌数量正确', () => {
  const g = makeGame({});
  g.deal();
  const counts = {};
  for (const p of g.players) counts[p.role] = (counts[p.role] || 0) + 1;
  for (const [r, n] of Object.entries(g.board)) assert.strictEqual(counts[r] || 0, n, `角色 ${r} 数量不符`);
  // 每个座位的身份牌事件只对自己可见
  const deals = g.events.filter((e) => e.type === 'deal');
  for (const d of deals) assert.deepStrictEqual(d.visibleTo, [d.actor]);
});

test('mergeRules 只接受已知键且类型正确', () => {
  const r = mergeRules({ sheriff: false, bogus: 1, witchSelfSave: 'always', lastWords: { exiled: false, hack: true } });
  assert.strictEqual(r.sheriff, false);
  assert.strictEqual(r.witchSelfSave, 'always');
  assert.strictEqual(r.lastWords.exiled, false);
  assert.strictEqual(r.lastWords.night1, true);
  assert.strictEqual(r.bogus, undefined);
  assert.ok(describeRules(r).includes('全程可自救'));
});

// ---------- 可见性隔离 ----------
test('可见性过滤：私密事件不泄漏', () => {
  const g = makeGame({});
  assignRoles(g, { 1: 'seer', 2: 'witch', 3: 'wolf', 4: 'wolfking', 5: 'guard', 12: 'hunter' });
  g.day = 1;
  g.emit('seer_check', { actor: 1, visibleTo: [1], data: { target: 3, isWolf: true } });
  g.emit('wolf_kill', { visibleTo: g.wolves().map((p) => p.seat), data: { target: 5 } });
  g.emit('witch_info', { actor: 2, visibleTo: [2], data: { killTarget: 5 } });
  g.emit('night_guard', { actor: 5, visibleTo: [5], data: { target: 5 } });
  g.emit('vote_cast', { actor: 6, visibleTo: [6], data: { target: 3 } });
  g.emit('speech', { actor: 7, data: { text: '大家好', context: 'day' } });

  for (const p of g.players) {
    const vis = g.visibleEvents(p.seat).map((e) => e.type);
    if (p.seat !== 1) assert.ok(!vis.includes('seer_check'), `非预言家${p.seat}看到了查验`);
    if (p.seat !== 2) assert.ok(!vis.includes('witch_info'), `非女巫${p.seat}看到了女巫信息`);
    if (p.seat !== 5) assert.ok(!vis.includes('night_guard'), `非守卫${p.seat}看到了守护目标`);
    if (p.seat !== 6) assert.ok(!vis.includes('vote_cast'), `非投票者${p.seat}看到了他人投票`);
    if (ROLES[p.role].category !== 'wolf') assert.ok(!vis.includes('wolf_kill'), `非狼${p.seat}看到了狼刀`);
  }
  assert.strictEqual(g.visibleEvents('god').length, g.events.length);
});

test('随机满员对局隔离审计（12 局，覆盖不同人类座位外所有 AI）', async () => {
  for (let i = 0; i < 12; i++) {
    const g = makeGame({ id: `audit${i}`, rnd: Math.random, mock: { explodeRate: 0.02 } });
    await runGame(g);
    assert.ok(g.finished, '对局应正常结束');
    assert.ok(['good', 'wolf'].includes(g.winner), '必须有胜负');
    const problems = auditIsolation(g);
    assert.deepStrictEqual(problems, [], `第${i}局隔离审计失败: ${problems.join('; ')}`);
  }
});

// ---------- 夜晚结算矩阵 ----------
function setupNight(wolfKill, guardActions, saved, poisonTargets, milk = 'die') {
  const g = makeGame({ rules: { milkThrough: milk } });
  assignRoles(g, { 1: 'wolf', 2: 'guard', 3: 'seer', 4: 'witch', 5: 'hunter', 6: 'villager' });
  g.day = 1;
  g.phase = 'night';
  g.night = { guardActions, wolfKill, saved, poisonTargets };
  return g;
}

test('夜晚结算：正常刀死', () => {
  const g = setupNight(6, [{ seat: 2, target: 5 }], false, []);
  _internals.resolveNightDeaths(g);
  assert.deepStrictEqual(g.pendingDeaths.map((d) => d.seat), [6]);
  assert.strictEqual(g.pendingDeaths[0].cause, 'wolf_kill');
});

test('夜晚结算：守卫守护 → 平安', () => {
  const g = setupNight(6, [{ seat: 2, target: 6 }], false, []);
  _internals.resolveNightDeaths(g);
  assert.deepStrictEqual(g.pendingDeaths, []);
});

test('夜晚结算：女巫救 → 平安', () => {
  const g = setupNight(6, [{ seat: 2, target: 5 }], true, []);
  _internals.resolveNightDeaths(g);
  assert.deepStrictEqual(g.pendingDeaths, []);
});

test('夜晚结算：同守同救奶穿（默认）→ 死且视同被刀', () => {
  const g = setupNight(6, [{ seat: 2, target: 6 }], true, []);
  _internals.resolveNightDeaths(g);
  assert.deepStrictEqual(g.pendingDeaths.map((d) => d.seat), [6]);
  assert.strictEqual(g.pendingDeaths[0].cause, 'wolf_kill');
});

test('夜晚结算：同守同救 cancel 变体 → 存活', () => {
  const g = setupNight(6, [{ seat: 2, target: 6 }], true, [], 'cancel');
  _internals.resolveNightDeaths(g);
  assert.deepStrictEqual(g.pendingDeaths, []);
});

test('夜晚结算：同守同救 guardDies 变体（守卫自守被刀+被救）→ 守卫死', () => {
  const g = setupNight(2, [{ seat: 2, target: 2 }], true, [], 'guardDies');
  _internals.resolveNightDeaths(g);
  assert.deepStrictEqual(g.pendingDeaths.map((d) => d.seat), [2]);
});

test('夜晚结算：同守同救 guardDies 变体（目标非守卫）→ 存活', () => {
  const g = setupNight(6, [{ seat: 2, target: 6 }], true, [], 'guardDies');
  _internals.resolveNightDeaths(g);
  assert.deepStrictEqual(g.pendingDeaths, []);
});

test('夜晚结算：刀+毒同目标去重，保留毒（不可开枪）', () => {
  const g = setupNight(6, [], false, [6]);
  _internals.resolveNightDeaths(g);
  assert.strictEqual(g.pendingDeaths.length, 1);
  assert.strictEqual(g.pendingDeaths[0].cause, 'poison');
});

test('夜晚结算：空刀平安夜', () => {
  const g = setupNight(0, [], false, []);
  _internals.resolveNightDeaths(g);
  assert.deepStrictEqual(g.pendingDeaths, []);
});

// ---------- 死亡触发链 ----------
test('猎人被刀 → 触发开枪；被毒 → 不触发', async () => {
  const g = makeGame({});
  assignRoles(g, { 1: 'wolf', 5: 'hunter' });
  g._shots = [];
  await _internals.settleDeath(g, 5, 'wolf_kill', {});
  assert.ok(g._shots.includes(5), '被刀应触发开枪');
  g._shots = [];
  await _internals.settleDeath(g, 5, 'poison', {});
  assert.ok(!g._shots.includes(5), '被毒不应触发开枪');
});

test('狼王被放逐 → 开枪；白狼王被刀 → 不开枪', async () => {
  const g = makeGame({});
  assignRoles(g, { 2: 'wolfking', 3: 'whitewolfking' });
  g._shots = [];
  await _internals.settleDeath(g, 2, 'vote_out', {});
  assert.ok(g._shots.includes(2));
  g._shots = [];
  await _internals.settleDeath(g, 3, 'wolf_kill', {});
  assert.ok(!g._shots.includes(3), '白狼王无死亡开枪技能');
});

// ---------- 白痴 ----------
test('白痴放逐免疫一次，再被放逐死亡', async () => {
  const g = makeGame({});
  assignRoles(g, { 4: 'idiot' });
  g._shots = [];
  await _internals.exile(g, 4);
  const p = g.player(4);
  assert.ok(p.alive, '白痴应存活');
  assert.ok(p.lostVote, '白痴应失去投票权');
  assert.ok(p.revealed, '白痴应翻牌');
  await _internals.exile(g, 4);
  assert.ok(!p.alive, '再次被放逐应死亡');
});

// ---------- 胜负 ----------
test('胜负判定：屠边与清狼', () => {
  const g = makeGame({});
  assignRoles(g, { 1: 'wolf', 2: 'wolf', 3: 'seer', 4: 'villager', 5: 'villager', 6: 'witch' });
  g.player(3).alive = false;
  g.player(6).alive = false;
  assert.strictEqual(g.checkWin().winner, 'wolf', '神职全灭应屠边');
  g.player(3).alive = true;
  g.player(6).alive = true;
  assert.strictEqual(g.checkWin(), null);
  g.player(1).alive = false;
  g.player(2).alive = false;
  assert.strictEqual(g.checkWin().winner, 'good');
});

test('预判胜负（未公布的夜晚死亡）', () => {
  const g = makeGame({});
  assignRoles(g, { 1: 'wolf', 3: 'seer', 4: 'witch', 5: 'villager' });
  g.pendingDeaths = [{ seat: 1, cause: 'poison' }];
  const w = checkWinWithPending(g);
  assert.ok(w && w.winner === 'good');
});

// ---------- 发言顺序 ----------
test('发言顺序：警长压轴 + 方向', () => {
  const g = makeGame({});
  assignRoles(g, { 1: 'wolf' });
  for (const p of g.players) p.alive = p.seat <= 8;
  g.player(3).isSheriff = true;
  const cw = buildSpeechOrder(g, 2, 1, true);
  assert.strictEqual(cw[0], 4, '死者2号顺时针下家是3号，但3号警长压轴，从4号开始');
  assert.strictEqual(cw[cw.length - 1], 3, '警长压轴');
  assert.strictEqual(cw.length, 8);
  const ccw = buildSpeechOrder(g, 2, -1, false);
  assert.strictEqual(ccw[0], 1, '逆时针 2号下家是 1号');
});

// ---------- 输入校验 ----------
test('validatePayload 覆盖主要任务', () => {
  const g = makeGame({});
  assignRoles(g, {});
  for (const p of g.players) p.alive = p.seat <= 6;

  const req = { task: 'vote', candidates: [2, 3, 4], allowNone: true };
  assert.ok(validatePayload('vote', { target: 3 }, req, g, 1).ok);
  assert.ok(validatePayload('vote', { target: 0 }, req, g, 1).ok);
  assert.ok(validatePayload('vote', { abstain: true }, req, g, 1).ok);
  assert.ok(!validatePayload('vote', { target: 9 }, req, g, 1).ok);
  assert.ok(!validatePayload('vote', {}, req, g, 1).ok);

  const reqNoAbstain = { task: 'vote', candidates: [2, 3], allowNone: false };
  assert.ok(!validatePayload('vote', { target: 0 }, reqNoAbstain, g, 1).ok);

  const g2 = makeGame({ board: { wolf: 2, witch: 1, seer: 1, villager: 2 } });
  assignRoles(g2, { 1: 'witch' });
  const wreq = { task: 'witch', extra: { killTarget: 2, canAntidote: true, canPoison: true, selfSaveAllowed: false } };
  assert.ok(validatePayload('witch', { antidote: true, poison: 0 }, wreq, g2, 1).ok);
  const selfSave = validatePayload('witch', { antidote: true, poison: 0 }, wreq, g2, 2);
  assert.ok(!selfSave.ok, '目标是自己且规则禁止自救应被拒绝');
  assert.ok(!validatePayload('witch', { antidote: true, poison: 3 }, wreq, g2, 1).ok, '双药同夜应被拒绝');

  const greq = { task: 'speech', canExplode: false };
  assert.ok(!validatePayload('speech', { text: 'hi', explode: true }, greq, g2, 1).ok);
  assert.ok(validatePayload('speech', { text: '大家好' }, greq, g2, 1).ok);
  assert.ok(!validatePayload('speech', { text: '' }, greq, g2, 1).ok);
  // 狼队发言轮：可空（跳过）
  const wsay = { task: 'wolf_say' };
  const v1 = validatePayload('wolf_say', { text: '跟刀' }, wsay, g2, 1);
  assert.ok(v1.ok && v1.value.text === '跟刀' && !v1.value.skipped);
  const v2 = validatePayload('wolf_say', { text: '' }, wsay, g2, 1);
  assert.ok(v2.ok && v2.value.skipped, '空发言应视为跳过');
});

// ---------- JSON 提取 ----------
test('extractJson 容错', () => {
  assert.deepStrictEqual(extractJson('{"target":3}'), { target: 3 });
  assert.deepStrictEqual(extractJson('好的，我的回答如下：\n```json\n{"text":"大家好"}\n```'), { text: '大家好' });
  assert.deepStrictEqual(extractJson('我认为 {"target": 5} 是最佳选择'), { target: 5 });
  assert.deepStrictEqual(extractJson('{"text":"他说\\"你好\\""}'), { text: '他说"你好"' });
  assert.strictEqual(extractJson('完全没有 JSON'), null);
});

// ---------- 秘密投票 ----------
test('秘密投票：票互不可见 + 警长 1.5 票加权 + 公开亮票', async () => {
  const g = makeGame({});
  assignRoles(g, {});
  g.player(1).isSheriff = true;
  const r = await secretVote(g, { task: 'vote', voters: [1, 2, 3], candidates: [2, 3, 4], allowNone: true });
  const castEvents = g.events.filter((e) => e.type === 'vote_cast');
  assert.strictEqual(castEvents.length, 3);
  for (const e of castEvents) {
    assert.deepStrictEqual(e.visibleTo, [e.actor], '每张票只对投票者本人可见');
    assert.strictEqual(g.visibleEvents(2).filter((x) => x.type === 'vote_cast' && x.actor !== 2).length, 0, '他人投票不在别人视野');
  }
  const reveal = g.events.find((e) => e.type === 'vote_reveal');
  assert.ok(reveal, '应有公开亮票事件');
  assert.strictEqual(reveal.visibleTo, 'all');
  const sheriffVote = reveal.data.votes.find((v) => v.seat === 1);
  assert.strictEqual(sheriffVote.weight, 1.5);
  assert.ok(r.topSeats.length >= 1);
});

// ---------- 全流程（随机 mock，多规则组合） ----------
async function runFull(rules, opts = {}) {
  const g = makeGame({ rules, rnd: Math.random, mock: { explodeRate: 0.02 }, ...opts });
  await runGame(g);
  return g;
}

test('全流程：默认规则（警长+双爆吞警徽）', async () => {
  const g = await runFull({});
  assert.ok(g.finished);
  assert.ok(['good', 'wolf'].includes(g.winner));
  assert.deepStrictEqual(auditIsolation(g), []);
});

test('全流程：无警长 + 女巫全程可自救 + 允许连守', async () => {
  const g = await runFull({ sheriff: false, witchSelfSave: 'always', guardNoRepeat: false });
  assert.ok(g.finished);
  assert.deepStrictEqual(auditIsolation(g), []);
});

test('全流程：暗牌 + 单爆吞警徽 + 首夜自救', async () => {
  const g = await runFull({ revealOnDeath: false, badgeSwallow: 'single', witchSelfSave: 'firstNight' });
  assert.ok(g.finished);
  assert.deepStrictEqual(auditIsolation(g), []);
});

test('全流程：不许空刀不许自爆', async () => {
  const g = await runFull({ allowEmptyKill: false, allowSelfExplode: false });
  assert.ok(g.finished);
  assert.deepStrictEqual(auditIsolation(g), []);
});

test('全流程：10 人局（无警徽流压力）', async () => {
  const g = await runFull({}, { board: { wolf: 3, seer: 1, witch: 1, hunter: 1, villager: 4 } });
  assert.ok(g.finished);
  assert.deepStrictEqual(auditIsolation(g), []);
});

// ---------- 狼队讨论（人类插话/加轮/提前结束） ----------
const tick = () => new Promise((r) => setImmediate(r));

test('狼队讨论：轮数、人类插话、加轮立即生效、投刀结算', async () => {
  const g = makeGame({ rules: { wolfChatRounds: 1 }, humanSeat: 2 });
  assignRoles(g, { 1: 'wolf', 2: 'wolf', 3: 'seer', 4: 'witch' });
  g.day = 1; g.phase = 'night';
  g.night = { guardActions: [], wolfKill: 0, saved: false, poisonTargets: [] };
  const running = _internals.wolfStep(g);
  // 等讨论开始
  for (let i = 0; i < 200 && !(g.wolfTalk && g.wolfTalk.active); i++) await tick();
  assert.ok(g.wolfTalk && g.wolfTalk.active, '讨论应激活');
  assert.strictEqual(g.wolfTalk.rounds, 1);
  // 人类插话 + 追加一轮（立即生效）
  g.wolfTalk.queue.push({ seat: 2, text: '都听我的，刀 3 号，他肯定是女巫。' });
  g.wolfTalk.rounds += 1;
  // 人类的按序发言轮（wolf_say）与投刀（wolf_kill）到达时自动响应
  let done = false;
  const feeder = (async () => {
    for (let i = 0; i < 8000 && !done; i++) {
      await tick();
      if (!g.pending) continue;
      const t = g.pending.request.task;
      if (t === 'wolf_kill') g.resolveHuman({ target: 3 });
      else if (t === 'wolf_say') g.resolveHuman({ text: '我同意刀 3 号，跟刀。' });
    }
  })();
  await running;
  done = true;
  await feeder;
  const proposes = g.events.filter((e) => e.type === 'wolf_propose');
  assert.ok(proposes.some((e) => e.actor === 2 && e.data.text.includes('刀 3 号')), '人类插话应入频道');
  assert.ok(proposes.some((e) => e.actor === 2 && e.data.human && e.data.text.includes('跟刀')), '按序发言轮的人类发言应入频道');
  const roundsBanner = g.events.filter((e) => e.type === 'system' && (e.text || '').includes('狼队讨论'));
  assert.ok(roundsBanner.length >= 2, `应有 2 轮讨论横幅，实际 ${roundsBanner.length}`);
  assert.strictEqual(g.wolfTalk.active, false, '讨论应结束');
  assert.ok(Number.isInteger(g.night.wolfKill), '讨论后应完成投刀（具体刀口取决于 mock 狼的随机投票）');
  // 讨论事件仅狼队可见
  const vis = g.wolves().map((p) => p.seat);
  for (const e of proposes) assert.deepStrictEqual(e.visibleTo, vis);
});

test('狼队讨论：提前结束（endNow）跳过剩余轮次', async () => {
  const g = makeGame({ rules: { wolfChatRounds: 4 }, humanSeat: 2 });
  assignRoles(g, { 1: 'wolf', 2: 'wolf', 3: 'seer' });
  g.day = 1; g.phase = 'night';
  g.night = { guardActions: [], wolfKill: 0, saved: false, poisonTargets: [] };
  const running = _internals.wolfStep(g);
  for (let i = 0; i < 200 && !(g.wolfTalk && g.wolfTalk.round >= 1); i++) await tick();
  g.wolfTalk.endNow = true;
  let done = false;
  const feeder = (async () => {
    for (let i = 0; i < 8000 && !done; i++) {
      await tick();
      if (!g.pending) continue;
      const t = g.pending.request.task;
      if (t === 'wolf_kill') g.resolveHuman({ target: 3 });
      else if (t === 'wolf_say') g.resolveHuman({ text: '' });
    }
  })();
  await running;
  done = true;
  await feeder;
  const banners = g.events.filter((e) => e.type === 'system' && (e.text || '').includes('狼队讨论'));
  assert.ok(banners.length < 4, `提前结束应少于 4 轮，实际 ${banners.length}`);
  assert.ok(g.night.wolfKill !== undefined);
});

// ---------- 夜晚播报 / 名字库 ----------
test('夜晚固定全步骤播报：公开、每晚齐全', async () => {
  const g = makeGame({});
  await runGame(g);
  const steps = g.events.filter((e) => e.type === 'night_step');
  assert.ok(steps.length >= g.day * 3, `每晚应至少播报 3 步，实际 ${steps.length} 条 / ${g.day} 夜`);
  for (const e of steps) {
    assert.strictEqual(e.visibleTo, 'all', 'night_step 必须全员可见（防推理泄露）');
    assert.ok(e.data.label && e.data.index > 0 && e.data.total > 0);
  }
});

test('名字库：数量充足且无重复', () => {
  const { ALL } = require('../src/names');
  assert.ok(ALL.length >= 120, `名字库应不少于 120 个，实际 ${ALL.length}`);
  assert.strictEqual(new Set(ALL).size, ALL.length, '名字不应重复');
});

// ---------- 夜晚播报 / 名字库 结束 ----------

// ---------- 手动终止 ----------
test('手动终止：pending 拒绝、优雅结算为无胜者', async () => {
  const g = makeGame({ humanSeat: 3 });
  assignRoles(g, { 2: 'wolf', 3: 'seer', 4: 'witch' });
  const p = g.ask(3, { task: 'vote', candidates: [2, 4], allowNone: true });
  let rejected = null;
  p.catch((e) => { rejected = e; });
  await tick();
  g.terminate('测试终止');
  await tick(); await tick();
  assert.ok(rejected && rejected.code === 'FORCE_ENDED', '挂起的 pending 应被拒绝');
  assert.strictEqual(g.pending, null, 'pending 应清空');
  g.finish();
  assert.ok(g.finished);
  assert.strictEqual(g.winner, 'none');
  assert.strictEqual(g.winReason, '测试终止');
  assert.ok(g.events.some((e) => e.type === 'game_over' && e.data.winner === 'none'));
  await assert.rejects(
    () => g.ask(3, { task: 'vote', candidates: [2, 4], allowNone: true }),
    (e) => e.code === 'FORCE_ENDED',
    '终止后再 ask 应直接抛 FORCE_ENDED',
  );
});

// ---------- 人类输入挂起/校验（不跑主流程） ----------
test('人类座位：pending 挂起与 resolveHuman 校验', async () => {
  const g = makeGame({ humanSeat: 3 });
  assignRoles(g, {});
  const p3 = g.promise || null;
  const promise = g.ask(3, { task: 'vote', candidates: [2, 4], allowNone: true });
  assert.ok(g.pending, '应挂起等待人类输入');
  assert.strictEqual(g.pending.seat, 3);

  const bad = g.resolveHuman({ target: 5 });
  assert.ok(!bad.ok, '非法目标应被拒绝');
  assert.ok(g.pending, '非法输入后仍保持挂起');

  const ok = g.resolveHuman({ target: 4 });
  assert.ok(ok.ok);
  const value = await promise;
  assert.deepStrictEqual(value, { target: 4 });
  assert.strictEqual(g.pending, null);

  const none = g.resolveHuman({ target: 1 });
  assert.ok(!none.ok, '无人等待时应拒绝');
});

// ---------- 性格系统 ----------
test('性格库：数量、唯一性、字段完整', () => {
  assert.ok(PERSONALITIES.length >= 12, `至少 12 种性格，实际 ${PERSONALITIES.length}`);
  const ids = new Set(PERSONALITIES.map((p) => p.id));
  assert.strictEqual(ids.size, PERSONALITIES.length, 'id 应唯一');
  for (const p of PERSONALITIES) {
    assert.ok(p.name && p.tag, `name/tag 非空（${p.id}）`);
    assert.ok(p.prompt.length >= 20 && p.prompt.length <= 200, `prompt 长度合理（${p.id}:${p.prompt.length}）`);
  }
});

test('resolvePersona：库内命中 / 自定义文本 / 空', () => {
  assert.ok(resolvePersona('毒舌贵妇').prompt.includes('毒舌'));
  assert.strictEqual(resolvePersona('snarky').name, '毒舌贵妇');
  assert.strictEqual(resolvePersona('话痨但心细').name, '自定义');
  assert.strictEqual(resolvePersona('话痨但心细').prompt, '话痨但心细');
  assert.strictEqual(resolvePersona(''), null);
  assert.strictEqual(resolvePersona(null), null);
});

test('applyPersonalities：AI 随机分配、人类留空、自定义优先、池内不重复', () => {
  const players = [];
  for (let i = 0; i < 12; i++) players.push({ name: `P${i + 1}`, isHuman: i === 0 });
  players[2].personality = '沉默寡言但一击必中';
  applyPersonalities(players, Math.random);
  assert.strictEqual(players[0].personality, '', '人类玩家不留性格');
  assert.ok(players[1].personality.length >= 20, 'AI 应有随机性格');
  assert.ok(players[1].personaName && players[1].personaTag, '应产出展示字段');
  assert.strictEqual(players[2].personality, '沉默寡言但一击必中', '自定义文本优先');
  assert.strictEqual(players[2].personaName, '自定义');
  const names = players.filter((p) => !p.isHuman).map((p) => p.personaName);
  const fromPool = names.filter((n) => n !== '自定义');
  assert.strictEqual(new Set(fromPool).size, fromPool.length, '同一局池内性格不重复');
  assert.strictEqual(fromPool.length + names.filter((n) => n === '自定义').length, 11, '11 个 AI 全部有性格');
});

test('buildSystemPrompt：性格注入 + 阵营立场铁律', () => {
  const game = makeGame({ humanSeat: 1 });
  assignRoles(game, { 1: 'seer', 2: 'wolf', 3: 'wolf', 4: 'wolfking', 5: 'guard', 6: 'witch', 7: 'hunter' });
  const wolf = game.player(2);
  wolf.personality = '你是戏精，台词夸张。';
  const wp = buildSystemPrompt(game, wolf);
  assert.ok(wp.includes('## 你的性格') && wp.includes('戏精'), '性格应注入 system prompt');
  assert.ok(wp.includes('不改变你的阵营目标'), '性格不改变阵营目标的限定');
  assert.ok(wp.includes('立场铁律') && wp.includes('狼阵营胜利'), '狼人立场铁律');
  const seer = game.player(1);
  assert.ok(buildSystemPrompt(game, seer).includes('好人阵营'), '好人立场铁律');
});

test('lastwords 指令按身份与翻牌状态定制', () => {
  const game = makeGame({ humanSeat: 1 });
  assignRoles(game, { 2: 'wolf' });
  const wolf = game.player(2);
  wolf.revealed = true;
  const revealed = taskInstruction(game, wolf, { task: 'lastwords' });
  assert.ok(revealed.includes('认狼护队') && revealed.includes('真假参半') && revealed.includes('反向咬人'), '应给出完整战术菜单');
  assert.ok(revealed.includes('好人榜') && revealed.includes('参半（相差≤1）'), '好人榜应带配比规则');
  assert.ok(revealed.includes('红线'), '应有红线');
  wolf.revealed = false;
  const hidden = taskInstruction(game, wolf, { task: 'lastwords' });
  assert.ok(hidden.includes('伪装') && hidden.includes('摊牌认狼'), '未翻牌狼应可伪装或摊牌');
  assert.ok(taskInstruction(game, game.player(5), { task: 'lastwords' }).includes('查验'), '好人遗言帮好人');
});

// ---------- 配置迁移与公共前缀缓存 ----------
test('migrateConfig：仅提升历史旧默认值，自定义值不动', () => {
  assert.strictEqual(migrateConfig({ maxTokens: 600 }).maxTokens, DEFAULT_CONFIG.maxTokens, '旧默认 600 → 16000');
  assert.strictEqual(migrateConfig({ maxTokens: 2000 }).maxTokens, DEFAULT_CONFIG.maxTokens, '旧默认 2000 → 16000');
  assert.strictEqual(migrateConfig({ maxTokens: 8000 }).maxTokens, DEFAULT_CONFIG.maxTokens, '旧建议值 8000 → 16000');
  assert.strictEqual(migrateConfig({ maxTokens: 3000 }).maxTokens, 3000, '自定义 3000 保留');
  assert.strictEqual(migrateConfig({ maxTokens: 20000 }).maxTokens, 20000, '更大的值保留');
  assert.strictEqual(migrateConfig({ timeoutMs: 120000 }).timeoutMs, DEFAULT_CONFIG.timeoutMs, '旧超时 120s → 360s');
  assert.strictEqual(migrateConfig({ timeoutMs: 240000 }).timeoutMs, DEFAULT_CONFIG.timeoutMs, '过渡值 240s → 360s');
  assert.strictEqual(migrateConfig({ timeoutMs: 300000 }).timeoutMs, 300000, '自定义超时保留');
  assert.strictEqual(DEFAULT_CONFIG.reasoningEffort, 'high', '发言类默认普通思考');
  assert.strictEqual(DEFAULT_CONFIG.fastEffort, 'low', '快速任务默认最低思考');
  assert.strictEqual(migrateConfig({ reasoningEffort: 'low' }).reasoningEffort, 'low', 'low 是合法档位，保留');
  assert.strictEqual(migrateConfig({ reasoningEffort: 'high' }).reasoningEffort, 'high', 'high 保留');
  assert.strictEqual(migrateConfig({ reasoningEffort: 'max' }).reasoningEffort, 'high', 'max 档已下线 → 迁移为 high');
  assert.strictEqual(migrateConfig({ fastEffort: 'max' }).fastEffort, 'low', 'fastEffort 的 max 也迁移为默认 low');
  assert.strictEqual(migrateConfig({ maxContextTokens: 500000 }).contextBudget, DEFAULT_CONFIG.contextBudget, '旧压缩阈值 → 新上下文预算');
  assert.ok(!('maxContextTokens' in migrateConfig({ maxContextTokens: 500000 })), '旧字段删除');
  assert.strictEqual(migrateConfig({}).contextBudget, DEFAULT_CONFIG.contextBudget, '缺省补齐 contextBudget');
  assert.strictEqual(migrateConfig({}).fastMaxTokens, DEFAULT_CONFIG.fastMaxTokens, '缺省补齐 fastMaxTokens');
});

test('createConfig：load 迁移旧配置且不覆盖 apiKey 掩码', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(os.tmpdir(), `ww-cfg-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ baseUrl: 'https://x.example/v1', apiKey: 'sk-test-key', maxTokens: 2000, timeoutMs: 120000 }));
  const cfg = createConfig(file);
  const r = cfg.load();
  assert.ok(r.migrated, '应报告发生了迁移');
  assert.strictEqual(cfg.get().timeoutMs, DEFAULT_CONFIG.timeoutMs, '超时同步迁移');
  assert.strictEqual(cfg.get().maxTokens, DEFAULT_CONFIG.maxTokens);
  assert.strictEqual(cfg.get().apiKey, 'sk-test-key');
  cfg.save({ apiKey: 'sk-ab****cd', maxTokens: 0.1 });
  assert.strictEqual(cfg.get().apiKey, 'sk-test-key', '掩码 key 不覆盖');
  fs.rmSync(file, { force: true });
});

test('公共前缀：全场 AI 的 system 公共段逐字节一致且位于最前', () => {
  const game = makeGame({ humanSeat: 1 });
  assignRoles(game, { 1: 'seer', 2: 'wolf', 3: 'wolf', 4: 'wolfking', 5: 'guard', 6: 'witch', 7: 'hunter' });
  game.player(2).personality = '你是戏精。';
  const common = buildCommonPrompt(game);
  assert.ok(!common.includes('你的身份'), '公共段不含玩家专属信息');
  for (const p of game.players) {
    const sys = buildSystemPrompt(game, p);
    assert.ok(sys.startsWith(common), `${p.seat}号 的 system 应以公共段开头`);
  }
  assert.notStrictEqual(
    buildPersonalPrompt(game, game.player(2)),
    buildPersonalPrompt(game, game.player(1)),
    '不同玩家个性段应不同'
  );
  assert.ok(buildPersonalPrompt(game, game.player(2)).includes('狼阵营胜利'), '狼人个性段含立场铁律');
  const wolfSys = buildPersonalPrompt(game, game.player(2));
  assert.ok(wolfSys.includes('悍跳') && wolfSys.includes('战术性伪装'), '狼人应有悍跳体系与反幻觉豁免');
  assert.ok(!buildPersonalPrompt(game, game.player(1)).includes('悍跳预言家'), '好人不应有悍跳指引');
});

// ---------- LLM 截断自愈链 ----------
test('llm 截断链：预算翻倍逐步放大直至成功', async () => {
  const { chatCompletion } = require('../src/ai/llm');
  const seen = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const budget = JSON.parse(opts.body).max_tokens;
    seen.push(budget);
    const done = budget >= 16000;
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ finish_reason: done ? 'stop' : 'length', index: 0, message: { content: done ? '{"target":3}' : '', reasoning_content: 'thinking...' } }],
        usage: { prompt_tokens: 100, completion_tokens: done ? 20 : budget },
      }),
      text: async () => '',
    };
  };
  try {
    const out = await chatCompletion({ baseUrl: 'http://x', apiKey: 'k', model: 'm', maxTokens: 1000, retries: 6 }, [{ role: 'user', content: 'hi' }]);
    assert.strictEqual(out.content, '{"target":3}');
    assert.deepStrictEqual(seen, [1000, 2000, 4000, 8000, 16000], '预算应 1000→2000→4000→8000→16000 翻倍放大');
  } finally { global.fetch = origFetch; }
});

test('llm 截断链：触顶后明确报错不再盲目重试', async () => {
  const { chatCompletion } = require('../src/ai/llm');
  const origFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ finish_reason: 'length', index: 0, message: { content: '', reasoning_content: 'x' } }], usage: {} }),
      text: async () => '',
    };
  };
  try {
    await assert.rejects(
      () => chatCompletion({ baseUrl: 'http://x', apiKey: 'k', model: 'm', maxTokens: 8000, retries: 9 }, [{ role: 'user', content: 'hi' }]),
      /最大输出预算/
    );
    assert.ok(calls <= 6, `触顶后应停止重试（实际调用 ${calls} 次）`);
  } finally { global.fetch = origFetch; }
});

// ---------- 随时自爆 ----------
test('validatePayload：explode_check', () => {
  const game = makeGame({ humanSeat: 1 });
  assignRoles(game, { 2: 'wolf', 3: 'whitewolfking', 4: 'villager' });
  game.day = 1;
  const req = {};
  const ok1 = validatePayload('explode_check', { explode: false }, req, game, 2);
  assert.ok(ok1.ok && ok1.value.explode === false && ok1.value.target === 0);
  const ok2 = validatePayload('explode_check', { explode: true, target: 4 }, req, game, 3);
  assert.ok(ok2.ok && ok2.value.target === 4, '白狼王自爆带目标');
  const bad1 = validatePayload('explode_check', { explode: true }, req, game, 3);
  assert.ok(!bad1.ok, '白狼王自爆缺目标应拒绝');
  const bad2 = validatePayload('explode_check', { explode: true, target: 3 }, req, game, 3);
  assert.ok(!bad2.ok, '白狼王不能带走自己');
  const bad3 = validatePayload('explode_check', { explode: true, target: 999 }, req, game, 3);
  assert.ok(!bad3.ok, '目标不合法应拒绝');
  const ok3 = validatePayload('explode_check', { explode: true }, req, game, 2);
  assert.ok(ok3.ok && ok3.value.target === 0, '普通狼自爆不带人');
});

test('随时自爆：consumeExplodeRequest 生效与拒绝', async () => {
  const { _internals } = require('../src/engine/flow');
  const game = makeGame({ humanSeat: 1 });
  assignRoles(game, { 2: 'wolf', 3: 'villager' });
  game.day = 1;
  // 狼人请求 → 自爆生效
  game.explodeRequest = { seat: 2, target: 0 };
  const fired = await _internals.consumeExplodeRequest(game);
  assert.ok(fired, '狼人请求应生效');
  assert.strictEqual(game.player(2).alive, false, '自爆者死亡');
  assert.ok(game.events.some((e) => e.type === 'explode'), '应有 explode 事件');
  assert.strictEqual(game.explodeRequest, null, '请求应被消费');
  // 好人请求 → 拒绝
  game.explodeRequest = { seat: 3, target: 0 };
  const fired2 = await _internals.consumeExplodeRequest(game);
  assert.ok(!fired2, '好人不能自爆');
  assert.strictEqual(game.player(3).alive, true);
});

test('随时自爆：speechPhase 中打断发言', async () => {
  const { _internals } = require('../src/engine/flow');
  const game = makeGame({ humanSeat: null });
  assignRoles(game, { 2: 'wolf' });
  game.day = 1;
  game.lastNightDeaths = [];
  game.explodeRequest = { seat: 2, target: 0 };
  const r = await _internals.speechPhase(game);
  assert.strictEqual(r, 'dayEnded', 'speechPhase 应因随时自爆提前结束');
  assert.strictEqual(game.player(2).alive, false);
  assert.strictEqual(game.speechesAfterExplode, undefined);
});

test('悍跳引导：wolf_chat 首夜协同 + sheriff_run/speech 狼人感知', () => {
  const game = makeGame({ humanSeat: 1 });
  assignRoles(game, { 2: 'wolf', 3: 'villager' });
  game.day = 1;
  const wolf = game.player(2);
  assert.ok(taskInstruction(game, wolf, { task: 'wolf_chat', candidates: [3], allowNone: true }).includes('悍跳'), '首夜狼队频道应商量悍跳');
  game.day = 2;
  assert.ok(!taskInstruction(game, wolf, { task: 'wolf_chat', candidates: [3], allowNone: true }).includes('警长竞选在即'), '非首夜不重复提醒');
  assert.ok(taskInstruction(game, wolf, { task: 'sheriff_run' }).includes('上警'), '狼人上警提示');
  const sp = taskInstruction(game, wolf, { task: 'sheriff_speech', canWithdraw: true });
  assert.ok(sp.includes('悍跳预言家') && sp.includes('警徽流'), '警上演讲悍跳指引');
});

// ---------- 职业策略模版库 ----------
test('策略模版库：覆盖全部角色、字段完整、简短', () => {
  const { STRATEGY_TEMPLATES, strategyBlockFor } = require('../src/ai/strategies');
  const roleIds = Object.keys(ROLES);
  for (const rid of roleIds) {
    const list = STRATEGY_TEMPLATES[rid];
    assert.ok(list && list.length >= 2, `${rid} 应至少 2 个模版`);
    const ids = new Set(list.map((t) => t.id));
    assert.strictEqual(ids.size, list.length, `${rid} 模版 id 应唯一`);
    for (const t of list) {
      assert.ok(t.name && t.text, `${t.id} 字段完整`);
      assert.ok(t.text.length <= 120, `${t.id} 文本应简短（${t.text.length} 字）`);
    }
    assert.ok(strategyBlockFor(rid).includes('【'), '格式化输出应含模版名');
  }
  assert.ok(STRATEGY_TEMPLATES.wolf.some((t) => t.text.includes('参半（相差≤1）')), '好人榜流应带配比规则');
});

test('推荐打法注入 system + 提示词体积守卫', () => {
  const game = makeGame({ humanSeat: 1 });
  assignRoles(game, { 2: 'wolf', 1: 'seer' });
  const wp = buildSystemPrompt(game, game.player(2));
  assert.ok(wp.includes('## 推荐打法') && wp.includes('供参考'), '狼人应注入推荐打法段');
  assert.ok(wp.includes('悍跳狼') && wp.includes('好人榜流'), '狼人应看到全部狼队模版');
  const sp = buildSystemPrompt(game, game.player(1));
  assert.ok(sp.includes('警徽流'), '预言家应看到警徽流模版');
  assert.ok(wp.length < 2400, `狼人 system 应保持精简（当前 ${wp.length} 字符）`);
  assert.ok(sp.length < 2150, `预言家 system 应保持精简（当前 ${sp.length} 字符）`);
});

test('共享前缀：职业配置/职业一览/流程常识', () => {
  const game = makeGame({ humanSeat: 1 });
  assignRoles(game, { 2: 'wolf', 5: 'guard' });
  const common = buildCommonPrompt(game);
  assert.ok(common.includes('狼人×3') && common.includes('预言家×1'), '应列出本局职业配置（含数量）');
  assert.ok(common.includes('【预言家】'), '应有一览：预言家');
  assert.ok(common.includes('【守卫】'), '应有一览：守卫');
  assert.ok(common.includes('没有任何关于结果的消息'), '应说明狼人夜里无刀口结果消息');
  assert.ok(common.includes('女巫首夜可以救人也可以不救'), '应说明女巫首夜可救可不救');
  assert.ok(!common.includes('【白痴】'), '不在板子里的职业不应出现');
  // 各玩家公共段依然逐字节一致
  assert.strictEqual(buildCommonPrompt(game), buildCommonPrompt(game));
});

// ---------- 骑士决斗与白狼王骑士场 ----------
test('白狼王骑士场板子：配置合法', () => {
  const b = BOARDS.wwknight12;
  const total = Object.values(b.roles).reduce((a, x) => a + x, 0);
  assert.strictEqual(total, 12);
  assert.ok(validateBoard(b.roles).ok);
  assert.strictEqual(b.roles.whitewolfking, 1, '恰一名白狼王');
  assert.strictEqual(b.roles.knight, 1, '恰一名骑士');
  assert.strictEqual(ROLES.knight.team, 'good');
});

test('validatePayload：duel_check', () => {
  const game = makeGame({ humanSeat: 1 });
  assignRoles(game, { 2: 'knight', 3: 'wolf' });
  game.day = 1;
  const ok1 = validatePayload('duel_check', { duel: false }, {}, game, 2);
  assert.ok(ok1.ok && ok1.value.target === 0);
  const ok2 = validatePayload('duel_check', { duel: true, target: 3 }, {}, game, 2);
  assert.ok(ok2.ok && ok2.value.target === 3);
  const bad1 = validatePayload('duel_check', { duel: true }, {}, game, 2);
  assert.ok(!bad1.ok, '决斗缺目标应拒绝');
  const bad2 = validatePayload('duel_check', { duel: true, target: 2 }, {}, game, 2);
  assert.ok(!bad2.ok, '不能决斗自己');
  const bad3 = validatePayload('duel_check', { duel: true, target: 999 }, {}, game, 2);
  assert.ok(!bad3.ok, '目标不合法应拒绝');
});

test('骑士决斗：决中狼入夜 / 决错好人自殉白天继续', async () => {
  const { _internals } = require('../src/engine/flow');
  const game = makeGame({ humanSeat: null });
  assignRoles(game, { 2: 'knight', 3: 'wolf', 4: 'villager' });
  game.day = 1;
  // 决中狼
  let r = await _internals.handleDuel(game, 2, 3);
  assert.strictEqual(r, 'dayEnded', '决斗成功应直接天黑');
  assert.strictEqual(game.player(3).alive, false, '狼人出局');
  assert.ok(game.events.some((e) => e.type === 'duel'), '应有 duel 事件');
  const reveals = game.events.filter((e) => e.type === 'role_reveal' && e.data.seat === 2);
  assert.ok(reveals.length >= 1 && reveals[0].data.role === 'knight', '发动决斗应翻牌亮明骑士身份');
  assert.strictEqual(game.player(2).revealed, true, '骑士标记为已暴露');
  // 决错好人
  r = await _internals.handleDuel(game, 2, 4);
  assert.strictEqual(r, 'duelFail', '决斗失败白天继续');
  assert.strictEqual(game.player(2).alive, false, '骑士以死谢罪');
  assert.strictEqual(game.player(4).alive, true, '好人安然无恙');
});

test('随时决斗：consumeDuelRequest 校验身份', async () => {
  const { _internals } = require('../src/engine/flow');
  const game = makeGame({ humanSeat: null });
  assignRoles(game, { 2: 'knight', 3: 'villager', 4: 'wolf' });
  game.day = 1;
  // 非骑士请求 → 拒绝
  game.duelRequest = { seat: 3, target: 4 };
  assert.strictEqual(await _internals.consumeDuelRequest(game), false);
  assert.strictEqual(game.player(3).alive, true);
  // 骑士请求 → 生效
  game.duelRequest = { seat: 2, target: 4 };
  const r = await _internals.consumeDuelRequest(game);
  assert.strictEqual(r, 'dayEnded');
  assert.strictEqual(game.player(4).alive, false);
  assert.strictEqual(game.duelRequest, null);
});

test('daySkillCheck：无白天技能角色时静默通过', async () => {
  const { _internals } = require('../src/engine/flow');
  const game = makeGame({ humanSeat: null });
  assignRoles(game, { 2: 'knight' });
  game.day = 1;
  game.lastNightDeaths = [];
  assert.strictEqual(await _internals.daySkillCheck(game), false, '骑士 mock 低概率发动，通常直接通过');
});

// ---------- 上下文架构：局面快照 / 分层记忆 / 预算 ----------
const context = require('../src/ai/context');
const { Agent } = require('../src/ai/agent');

/** 构造一个已到第 2 天、带第 1 夜/第 1 天事件的测试局 */
function makeDay2Game() {
  const g = makeGame({ humanSeat: null });
  g.deal();
  assignRoles(g, { 1: 'seer', 2: 'wolf', 3: 'wolf', 4: 'wolfking', 5: 'villager', 6: 'witch', 7: 'hunter', 8: 'guard', 9: 'villager', 10: 'villager', 11: 'villager', 12: 'villager' });
  g.day = 1; g.phase = 'night';
  g.emit('wolf_kill', { actor: 2, visibleTo: [2, 3, 4], data: { target: 9 }, text: '' });
  g.emit('seer_check', { actor: 1, visibleTo: [1], data: { target: 5, isWolf: false }, text: '' });
  g.emit('phase', { data: { title: '第 1 天 · 天亮了' }, text: '' });
  g.day = 1; g.phase = 'dawn';
  g.emit('deaths', { visibleTo: 'all', data: { deaths: [] }, text: '' });
  g.day = 1; g.phase = 'speech';
  g.emit('speech', { actor: 5, visibleTo: 'all', data: { context: '', text: '昨天平安夜，我认为8号的发言有问题。' } });
  g.day = 1; g.phase = 'vote';
  g.emit('vote_reveal', { visibleTo: 'all', data: { votes: [{ seat: 5, target: 8 }], tally: { 8: 1 } }, text: '' });
  g.day = 2; g.phase = 'night';
  g.emit('speech', { actor: 5, visibleTo: 'all', data: { context: '', text: '第2天开始，我坚持昨天的判断。' } });
  return g;
}

test('上下文：可见性隔离（查验只进预言家、刀口只进狼队）', () => {
  const g = makeDay2Game();
  const seerSnap = context.renderSnapshot(g, g.player(1), context.aggregate(g, g.player(1)), {});
  assert.ok(seerSnap.includes('查验记录'), '预言家快照含查验记录');
  assert.ok(seerSnap.includes('5号：好人'), '查验结果正确');
  const vilSnap = context.renderSnapshot(g, g.player(10), context.aggregate(g, g.player(10)), {});
  assert.ok(!vilSnap.includes('查验记录'), '平民看不到查验');
  assert.ok(!vilSnap.includes('狼队队友'), '平民看不到狼队');
  const wolfSnap = context.renderSnapshot(g, g.player(2), context.aggregate(g, g.player(2)), {});
  assert.ok(wolfSnap.includes('狼队队友'), '狼人看到队友');
  assert.ok(wolfSnap.includes('刀口'), '狼人看到历史刀口');
  assert.ok(!wolfSnap.includes('查验记录'), '狼人看不到预言家的查验');
});

test('上下文：时钟与阶段正确（防时间幻觉）', () => {
  const g = makeDay2Game();
  const built = context.assemble(g, g.player(5), { task: 'speech' }, { digests: new Map(), lastSeq: 0, transcriptDays: [1, 2] });
  assert.ok(built.text.includes('【局面快照】当前时刻：第 2 天 · 夜晚'), '快照时钟=第2天夜晚');
  assert.ok(built.text.includes('平安夜'), '第1天平安夜事实保留');
  assert.ok(built.text.includes('不要臆测'), '含防臆测常识');
});

test('上下文：缓存前缀稳定（同日内 L1+L2 不随新事件变化，快照承担易变区）', () => {
  const g = makeDay2Game();
  const cut = (t) => t.slice(0, t.indexOf('【局面快照】')).replace(/\s+$/, '');
  const before = context.assemble(g, g.player(5), { task: 'speech' }, { digests: new Map(), lastSeq: 99999, transcriptDays: [1, 2] });
  const p1 = cut(before.text);
  g.emit('speech', { actor: 7, visibleTo: 'all', data: { context: '', text: '新加入的发言。' } });
  const after = context.assemble(g, g.player(5), { task: 'speech' }, { digests: new Map(), lastSeq: 99999, transcriptDays: [1, 2] });
  const p2 = cut(after.text);
  assert.ok(p2.startsWith(p1), '新事件只做追加，前缀逐字节稳定');
  assert.ok(after.text.includes('新加入的发言'), '新事件进入实录');
  // 新事件清单出现在快照（易变区）
  const withLast = context.assemble(g, g.player(5), { task: 'speech' }, { digests: new Map(), lastSeq: 2, transcriptDays: [1, 2] });
  assert.ok(withLast.text.includes('自你上次行动后的新事件'), '快照含新事件清单');
});

test('上下文：预算裁剪（超预算时降级且仍可组装）', () => {
  const g = makeDay2Game();
  for (let i = 0; i < 40; i++) g.emit('speech', { actor: (i % 12) + 1, visibleTo: 'all', data: { context: '', text: ('填充发言填充发言填充发言填充发言填充发言填充发言'.slice(0, 36)) + i } });
  const out = context.trimToBudget(g, g.player(5), { task: 'speech' }, { digests: new Map(), lastSeq: 0, transcriptDays: [1, 2] }, 300);
  assert.ok(out.trimmed, '触发裁剪');
  assert.ok(out.text.includes('局面快照'), '快照永不裁掉');
  assert.ok(out.text.includes('当前任务'), '任务永不裁掉');
  assert.ok(out.tokens < 2000, `裁剪后总量受限（实际 ${out.tokens}）`);
});

test('任务分层：effort 与 maxTokens 映射', () => {
  const cfg = { reasoningEffort: 'high', fastEffort: 'low', maxTokens: 16000, fastMaxTokens: 8000 };
  assert.strictEqual(context.taskEffort('speech', cfg), 'high', '发言用主强度');
  assert.strictEqual(context.taskEffort('lastwords', cfg), 'low', '遗言属一次性短内容，走快速档');
  assert.strictEqual(context.taskEffort('wolf_chat', cfg), 'low', '狼聊走快速档');
  assert.strictEqual(context.taskEffort('seer_check', cfg), 'low', '夜晚行动用快速强度');
  assert.strictEqual(context.taskEffort('vote', cfg), 'low', '投票用快速强度');
  assert.strictEqual(context.taskMaxTokens('vote', cfg), 8000, '快速任务压低输出上限');
  assert.strictEqual(context.taskMaxTokens('speech', cfg), 12000, '发言档封顶 12000 压极值尾巴');
});

test('反思：LLM 失败降级为事实骨架', async () => {
  const g = makeDay2Game();
  g.day = 3; // 第1天成为"前天"，需要纪要
  const agent = new Agent(g.player(5), g, { baseUrl: 'http://127.0.0.1:9', model: 'x', apiKey: 'k', retries: 0, timeoutMs: 1 }, silentLogger);
  await agent.ensureDigests();
  const d1 = agent.digests.get(1);
  assert.ok(d1 && d1.includes('事实骨架'), '失败后使用确定性骨架');
});

test('反思：LLM 正常时生成纪要并跨天缓存', async () => {
  const g = makeDay2Game();
  g.day = 3;
  const llm = require('../src/ai/llm');
  const orig = llm.chatCompletion;
  let called = 0;
  llm.chatCompletion = async (cfg, messages, opts) => {
    called++;
    assert.ok(opts.effort === 'low', '反思用轻度思考（防思考失控）');
    assert.ok(opts.maxTokens === 2000, '反思输出上限 2000');
    return { content: '【身份判断】8号可疑（置信度中）。【我的状态】稳住。', usage: { promptTokens: 100, cachedTokens: 0, completionTokens: 30 } };
  };
  try {
    const agent = new Agent(g.player(5), g, { baseUrl: 'http://x', model: 'x', apiKey: 'k', fastEffort: 'low' }, silentLogger);
    await agent.ensureDigests();
    const first = agent.digests.get(1);
    assert.ok(first && first.includes('身份判断'), '纪要已生成');
    await agent.ensureDigests();
    assert.strictEqual(agent.digests.get(1), first, '同一天不重复生成');
    assert.strictEqual(called, 1, 'LLM 只调一次');
  } finally {
    llm.chatCompletion = orig;
  }
});

test('Agent.decide 集成：组装→单发调用→解析→游标推进', async () => {
  const g = makeDay2Game();
  const llm = require('../src/ai/llm');
  const orig = llm.chatCompletion;
  const calls = [];
  llm.chatCompletion = async (cfg, messages, opts) => {
    calls.push({ messages, opts });
    return { content: '{"text":"我觉得8号有问题。"}', usage: { promptTokens: 500, cachedTokens: 300, completionTokens: 40 } };
  };
  try {
    const agent = new Agent(g.player(5), g, { baseUrl: 'http://x', model: 'x', apiKey: 'k', reasoningEffort: 'high', fastEffort: 'low', contextBudget: 12000 }, silentLogger);
    const p1 = await agent.decide({ task: 'speech' });
    assert.deepStrictEqual(p1, { text: '我觉得8号有问题。' }, 'JSON 正常解析');
    assert.strictEqual(calls.length, 1, '单发调用');
    assert.strictEqual(calls[0].messages.length, 2, 'system + 单条 user');
    assert.strictEqual(calls[0].opts.effort, 'high', '发言任务用主强度');
    assert.ok(agent.contextTokens > 0, '上报上下文体积');
    const seqBefore = g.visibleEvents(5, 0).reduce((m, e) => Math.max(m, e.seq), 0);
    await agent.decide({ task: 'speech' });
    assert.strictEqual(agent.lastSeq, seqBefore, '决策后游标推进到最后事件');
    // 快速任务走 fastEffort + 小上限
    await agent.decide({ task: 'seer_check' });
    assert.strictEqual(calls[2].opts.effort, 'low');
    assert.strictEqual(calls[2].opts.maxTokens, 8000);
  } finally {
    llm.chatCompletion = orig;
  }
});

// ==================== 新角色与板子（摄梦人/狼美人/乌鸦/隐狼/暗恋者） ====================

test('新板子：5 个网易官方板配置合法（12 人）', () => {
  for (const id of ['wwkguard12', 'dreamer12', 'wolfbeautyknight12', 'crowhidden12', 'admirer12']) {
    const b = BOARDS[id];
    const total = Object.values(b.roles).reduce((a, x) => a + x, 0);
    assert.strictEqual(total, 12, `${id} 总人数应为 12`);
    assert.ok(validateBoard(b.roles).ok, `${id} 校验应通过`);
  }
  assert.strictEqual(BOARDS.dreamer12.roles.dreamer, 1, '摄梦人场恰一名摄梦人');
  assert.strictEqual(BOARDS.wolfbeautyknight12.roles.wolfbeauty, 1, '狼美骑士场恰一名狼美人');
  assert.deepStrictEqual(BOARDS.wolfbeautyknight12.rules, { witchSelfSave: 'never' }, '狼美骑士场板规：女巫不可自救');
  assert.strictEqual(BOARDS.crowhidden12.roles.hiddenwolf, 1, '乌鸦隐狼场恰一名隐狼');
  assert.strictEqual(BOARDS.crowhidden12.roles.crow, 1, '乌鸦隐狼场恰一名乌鸦');
  assert.strictEqual(BOARDS.admirer12.roles.admirer, 1, '暗恋者场恰一名暗恋者');
});

test('夜晚顺序：默认含新步骤 + 老配置自动迁移补齐', () => {
  const r = mergeRules({});
  for (const s of ['admirer', 'dreamer', 'wolfbeauty', 'crow']) assert.ok(r.nightOrder.includes(s), `默认顺序应含 ${s}`);
  const old = mergeRules({ nightOrder: ['guard', 'wolf', 'seer', 'witch'] });
  for (const s of ['admirer', 'dreamer', 'wolfbeauty', 'crow']) assert.ok(old.nightOrder.includes(s), `老配置应补齐 ${s}`);
  assert.strictEqual(old.nightOrder.filter((s) => s === 'guard').length, 1, '不应重复添加');
  assert.ok(describeRules(r).includes('摄梦人'), 'describeRules 应有新步骤中文名');
});

// ---------- 摄梦人 ----------
function setupDreamNight(wolfKill, guardActions, saved, poisonTargets, dreamActions, lastDreamMap = {}) {
  const g = makeGame({ rules: {} });
  assignRoles(g, { 1: 'wolf', 2: 'dreamer', 3: 'seer', 4: 'witch', 5: 'hunter', 6: 'villager' });
  g.day = 1;
  g.phase = 'night';
  g.night = { guardActions, wolfKill, saved, poisonTargets, dreamActions };
  g.lastDreamMap = lastDreamMap;
  return g;
}

test('摄梦结算：连摄两晚同一人 → 死亡且女巫救不活', () => {
  // 狼刀 6 号撞上梦游者落空，但 6 号被连摄两晚：仍死于连摄（救不活）
  const g = setupDreamNight(6, [{ seat: 2, target: 6 }], false, [], [{ seat: 2, target: 6 }], { 2: 6 });
  _internals.resolveNightDeaths(g);
  assert.deepStrictEqual(g.pendingDeaths.map((d) => d.seat), [6]);
  assert.strictEqual(g.pendingDeaths[0].cause, 'dream');
  assert.strictEqual(g.lastDreamMap[2], 6, 'lastDreamMap 应更新');
});

test('摄梦结算：梦游者免疫狼刀 → 平安夜', () => {
  const g = setupDreamNight(6, [], false, [], [{ seat: 2, target: 6 }]);
  _internals.resolveNightDeaths(g);
  assert.deepStrictEqual(g.pendingDeaths, [], '刀中梦游者应落空');
});

test('摄梦结算：毒杀梦游者 → 落空（药照耗）', () => {
  const g = setupDreamNight(0, [], false, [6], [{ seat: 2, target: 6 }]);
  _internals.resolveNightDeaths(g);
  assert.deepStrictEqual(g.pendingDeaths, [], '毒梦游者应落空');
});

test('摄梦结算：摄梦人夜里被刀 → 梦游者连带出局', () => {
  const g = setupDreamNight(2, [], false, [], [{ seat: 2, target: 6 }]);
  _internals.resolveNightDeaths(g);
  assert.deepStrictEqual(g.pendingDeaths.map((d) => d.seat), [2, 6]);
  assert.strictEqual(g.pendingDeaths.find((d) => d.seat === 6).cause, 'dream_follow');
});

test('摄梦结算：连摄死的猎人不开枪', async () => {
  const g = setupDreamNight(0, [], false, [], [{ seat: 2, target: 5 }], { 2: 5 });
  g._shots = [];
  _internals.resolveNightDeaths(g);
  assert.deepStrictEqual(g.pendingDeaths.map((d) => d.seat), [5]);
  await _internals.dawnPhase(g);
  assert.deepStrictEqual(g._shots, [], '连摄死亡的猎人不应触发开枪');
});

// ---------- 狼美人 ----------
test('狼美人：被放逐 → 被魅惑者殉情出局（不开枪）', async () => {
  const g = makeGame({});
  assignRoles(g, { 1: 'wolf', 2: 'wolfbeauty', 3: 'villager', 4: 'hunter', 5: 'villager' });
  g.charmMap = { 2: 4 }; // 魅惑猎人
  g._shots = [];
  await _internals.settleDeath(g, 2, 'vote_out', {});
  assert.strictEqual(g.player(4).alive, false, '被魅惑的猎人应殉情出局');
  assert.deepStrictEqual(g._shots, [], '殉情死亡的猎人不能开枪');
  assert.ok(g.events.some((e) => e.type === 'role_reveal' && e.data.seat === 4), '殉情者应翻牌');
});

test('狼美人：死于骑士决斗 → 魅惑失效不殉情', async () => {
  const g = makeGame({});
  assignRoles(g, { 1: 'knight', 2: 'wolfbeauty', 3: 'villager', 4: 'villager', 5: 'villager' });
  g.charmMap = { 2: 4 };
  const r = await _internals.handleDuel(g, 1, 2);
  assert.strictEqual(r, 'dayEnded', '决斗狼美人应入夜');
  assert.strictEqual(g.player(2).alive, false, '狼美人出局');
  assert.strictEqual(g.player(4).alive, true, '被魅惑者不应殉情');
  assert.strictEqual(g.charmMap[2], undefined, '魅惑记录应清除');
});

test('狼美人：毒杀触发殉情；新魅惑覆盖旧目标', async () => {
  const g = makeGame({});
  assignRoles(g, { 1: 'wolf', 2: 'wolfbeauty', 3: 'witch', 4: 'villager', 5: 'villager' });
  g.charmMap = { 2: 5 };
  await _internals.settleDeath(g, 2, 'poison', {});
  assert.strictEqual(g.player(5).alive, false, '毒杀狼美人应触发殉情');
  const g2 = makeGame({});
  assignRoles(g2, { 1: 'wolf', 2: 'wolfbeauty', 3: 'villager', 4: 'villager', 5: 'villager' });
  g2.charmMap = { 2: 4 };
  g2.night = { guardActions: [], dreamActions: [], charmActions: [{ seat: 2, target: 5 }], curses: [], wolfKill: 0, saved: false, poisonTargets: [] };
  _internals.resolveNightDeaths(g2);
  assert.strictEqual(g2.charmMap[2], 5, '最新魅惑应覆盖旧的');
});

// ---------- 乌鸦 ----------
test('乌鸦诅咒：放逐投票 +0.5 票；警长竞选投票不受影响', async () => {
  const rnd = () => 0.5; // 确定性：两候选时 mock 必投第 2 个（6号）
  const g = makeGame({ humanSeat: null, rnd });
  assignRoles(g, { 1: 'wolf', 2: 'crow', 3: 'seer', 4: 'villager', 5: 'villager', 6: 'villager' });
  g.activeCurse = [6];
  const r = await secretVote(g, { task: 'vote', voters: [1, 2, 3, 4], candidates: [5, 6], allowNone: true });
  assert.strictEqual(r.tally['6'], 4.5, '被诅咒者应 4 票+0.5');
  assert.deepStrictEqual(r.topSeats, [6]);
  const r2 = await secretVote(g, { task: 'sheriff_vote', voters: [1, 2, 3, 4], candidates: [5, 6], allowNone: true });
  assert.strictEqual(r2.tally['6'], 4, '警长竞选投票不应加诅咒票');
  const cursed = g.events.filter((e) => e.type === 'vote_reveal' && e.data.curseBonus && Object.keys(e.data.curseBonus).length).pop();
  assert.ok(cursed && cursed.data.curseBonus['6'] === 0.5, '放逐亮票应带诅咒加成标注');
  const sheriffReveal = g.events.filter((e) => e.type === 'vote_reveal').pop();
  assert.strictEqual(sheriffReveal.data.curseBonus, undefined, '警选亮票不应带诅咒标注');
});

// ---------- 隐狼 ----------
test('隐狼互认：隐狼知道狼队友，狼队不知道隐狼', () => {
  const g = makeGame({ board: { wolf: 1, hiddenwolf: 1, seer: 1, witch: 1, villager: 3 } });
  g.deal();
  const hw = g.players.find((p) => p.role === 'hiddenwolf');
  const wolf = g.players.find((p) => p.role === 'wolf');
  const hwMates = g.events.filter((e) => e.type === 'teammates' && e.actor === hw.seat).pop();
  const wolfMates = g.events.filter((e) => e.type === 'teammates' && e.actor === wolf.seat).pop();
  assert.deepStrictEqual(hwMates.data.seats, [wolf.seat], '隐狼应知道狼队友');
  assert.deepStrictEqual(wolfMates.data.seats, [], '狼队友不应知道隐狼');
  assert.deepStrictEqual(g.matesOf(hw).map((p) => p.seat), [wolf.seat]);
  assert.deepStrictEqual(g.matesOf(wolf), [], 'matesOf 对普通狼应排除隐狼');
});

test('隐狼：查验恒好人；不参与狼刀；可被决斗；参与胜负', async () => {
  const g = makeGame({ board: { wolf: 1, hiddenwolf: 1, seer: 1, witch: 1, villager: 3 }, rnd: () => 0.2 });
  assignRoles(g, { 1: 'wolf', 2: 'hiddenwolf', 3: 'seer', 4: 'witch', 5: 'villager', 6: 'villager' });
  g.day = 1;
  g.phase = 'night';
  g.night = { guardActions: [], dreamActions: [], charmActions: [], curses: [], wolfKill: 0, saved: false, poisonTargets: [] };
  assert.strictEqual(g.nightWolves().length, 1, 'nightWolves 不应含隐狼');
  await _internals.seerStep(g); // 候选[1,2,4,5,6]，rnd=0.2 → floor(1)=1 → 必验 2号（隐狼）
  const check = g.events.filter((e) => e.type === 'seer_check').pop();
  assert.strictEqual(check.data.target, 2, '确定性 rnd 应验中隐狼');
  assert.strictEqual(check.data.isWolf, false, '查验隐狼应为好人');
  // 狼全死但隐狼存活 → 好人未胜（隐狼算狼营）
  g.player(1).alive = false;
  assert.strictEqual(g.checkWin(), null, '隐狼存活时好人不应获胜');
  g.player(1).alive = true;
  // 决斗隐狼 → 隐狼出局（他是狼）
  const r = await _internals.handleDuel(g, 3, 2);
  assert.strictEqual(r, 'dayEnded', '决斗隐狼应成功入夜');
  assert.strictEqual(g.player(2).alive, false);
  g.player(1).alive = false;
  assert.strictEqual(g.checkWin().winner, 'good', '隐狼也出局后好人胜');
});

// ---------- 暗恋者 ----------
test('暗恋者：categoryOf 随绑定对象变动并驱动胜负', () => {
  const g = makeGame({ board: { wolf: 1, seer: 1, admirer: 1, villager: 2 } });
  assignRoles(g, { 1: 'wolf', 2: 'seer', 3: 'admirer', 4: 'villager', 5: 'villager' });
  assert.strictEqual(g.categoryOf(g.player(3)), 'villager', '未绑定前按默认类别');
  g.crush = { 3: 1 }; // 绑狼
  assert.strictEqual(g.categoryOf(g.player(3)), 'wolf', '绑狼后算狼营');
  g.player(1).alive = false; // 真狼出局
  assert.strictEqual(g.checkWin(), null, '绑狼暗恋者存活时好人未胜');
  g.player(3).alive = false;
  assert.strictEqual(g.checkWin().winner, 'good', '暗恋者也出局后好人胜');
  const g2 = makeGame({ board: { wolf: 1, seer: 1, admirer: 1, villager: 2 } });
  assignRoles(g2, { 1: 'wolf', 2: 'seer', 3: 'admirer', 4: 'villager', 5: 'villager' });
  g2.crush = { 3: 4 }; // 绑民
  g2.player(2).alive = false; // 神职全灭
  assert.strictEqual(g2.checkWin().winner, 'wolf', '绑民的暗恋者算民，神职出局狼人屠边');
});

test('暗恋者：查验恒好人（即使绑狼）', async () => {
  const g = makeGame({ board: { wolf: 1, seer: 1, admirer: 1, villager: 2 }, rnd: () => 0.3 });
  assignRoles(g, { 1: 'wolf', 2: 'seer', 3: 'admirer', 4: 'villager', 5: 'villager' });
  g.crush = { 3: 1 };
  g.day = 1;
  g.phase = 'night';
  g.night = { guardActions: [], dreamActions: [], charmActions: [], curses: [], wolfKill: 0, saved: false, poisonTargets: [] };
  await _internals.seerStep(g);
  const onAdmirer = g.events.filter((e) => e.type === 'seer_check').find((e) => e.data.target === 3);
  assert.ok(onAdmirer, '确定性 rnd 应让预言家验中暗恋者（候选[1,3,4,5] 取 index 1）');
  assert.strictEqual(onAdmirer.data.isWolf, false, '查验暗恋者应恒为好人（即使绑狼）');
});

// ---------- 新夜步 + 输入校验 + 提示词 ----------
test('新夜步：摄梦/诅咒/魅惑/暗恋 mock 驱动 + 校验', async () => {
  const g = makeGame({ board: { wolf: 2, wolfbeauty: 1, dreamer: 1, crow: 1, seer: 1, admirer: 1, villager: 4 } });
  assignRoles(g, { 1: 'wolf', 2: 'wolf', 3: 'wolfbeauty', 4: 'dreamer', 5: 'crow', 6: 'seer', 7: 'admirer' });
  g.day = 1;
  g.phase = 'night';
  g.night = { guardActions: [], dreamActions: [], charmActions: [], curses: [], wolfKill: 0, saved: false, poisonTargets: [] };
  await _internals.admirerStep(g);
  assert.ok(g.crush[7], '暗恋者应完成绑定');
  assert.notStrictEqual(g.crush[7], 7, '不能选自己');
  await _internals.dreamerStep(g);
  assert.strictEqual(g.night.dreamActions.length, 1, '摄梦人必须行动');
  await _internals.crowStep(g);
  assert.strictEqual(g.night.curses.length, 1, '乌鸦必须行动');
  await _internals.wolfbeautyStep(g);
  assert.strictEqual(g.night.charmActions.length, 1, '狼美人必须行动');
  const charmTarget = g.night.charmActions[0].target;
  assert.ok(![1, 2, 3].includes(charmTarget), '狼美人不能魅惑狼队');
  const req = { task: 'night_dream', candidates: [1, 2] };
  assert.ok(!validatePayload('night_dream', {}, req, g, 4).ok, '缺目标应拒绝');
  assert.ok(!validatePayload('night_dream', { target: 0 }, req, g, 4).ok, '摄梦不能空过');
  assert.ok(!validatePayload('admirer_crush', { target: 7 }, { task: 'admirer_crush', candidates: [1, 7] }, g, 7).ok, '暗恋不能选自己');
  assert.ok(validatePayload('crow_curse', { target: 1 }, { task: 'crow_curse', candidates: [1, 2] }, g, 5).ok, '诅咒合法目标');
});

test('新角色提示词：公共机制说明按板子注入 + 任务指令', () => {
  const g = makeGame({ board: { wolf: 2, wolfbeauty: 1, dreamer: 1, crow: 1, seer: 1, admirer: 1, villager: 4 } });
  assignRoles(g, { 1: 'wolf', 2: 'wolf', 3: 'wolfbeauty', 4: 'dreamer', 5: 'crow', 6: 'seer', 7: 'admirer' });
  const common = buildCommonPrompt(g);
  for (const kw of ['摄梦', '殉情', '0.5票', '暗恋者', '隐狼不在此板']) {
    if (kw === '隐狼不在此板') continue;
    assert.ok(common.includes(kw), `公共流程常识应含：${kw}`);
  }
  const g2 = makeGame({ board: { wolf: 2, wolfbeauty: 1, dreamer: 1, crow: 1, seer: 1, admirer: 1, hiddenwolf: 1, villager: 3 } });
  assignRoles(g2, { 1: 'wolf', 2: 'wolf', 3: 'wolfbeauty', 4: 'dreamer', 5: 'crow', 6: 'seer', 7: 'admirer', 8: 'hiddenwolf' });
  assert.ok(buildCommonPrompt(g2).includes('隐狼'), '隐狼在场时公共常识应说明隐狼机制');
  assert.ok(buildCommonPrompt(g).includes('【摄梦人】'), '职业一览应含新角色');
  // 任务指令
  assert.ok(taskInstruction(g, g.player(4), { task: 'night_dream', candidates: [1] }).includes('连续两晚'), '摄梦指令说明连摄');
  assert.ok(taskInstruction(g, g.player(3), { task: 'wolfbeauty_charm', candidates: [4] }).includes('殉情'), '魅惑指令说明殉情');
  assert.ok(taskInstruction(g, g.player(5), { task: 'crow_curse', candidates: [4] }).includes('0.5'), '诅咒指令说明票权');
  assert.ok(taskInstruction(g, g.player(7), { task: 'admirer_crush', candidates: [4] }).includes('绑定'), '暗恋指令说明绑定');
  // 隐狼/暗恋者个性提示词特殊立场
  const hwPrompt = buildPersonalPrompt(g2, g2.player(8));
  assert.ok(hwPrompt.includes('立场铁律（隐狼）') && hwPrompt.includes('查验你永远是'), '隐狼应注入专属立场');
  const adPrompt = buildPersonalPrompt(g, g.player(7));
  assert.ok(adPrompt.includes('立场铁律（暗恋者）'), '暗恋者应注入专属立场');
  const wbPrompt = buildPersonalPrompt(g, g.player(3));
  assert.ok(wbPrompt.includes('狼队队友'), '狼美人仍应看到狼队');
});

test('新板子全流程：4 个官方板 mock 跑通 + 隔离审计', async () => {
  for (const id of ['dreamer12', 'wolfbeautyknight12', 'crowhidden12', 'admirer12']) {
    for (let i = 0; i < 2; i++) {
      const g = makeGame({ id: `${id}-${i}`, board: BOARDS[id].roles, rules: BOARDS[id].rules, rnd: Math.random, mock: { explodeRate: 0.02 } });
      await runGame(g);
      assert.ok(g.finished, `${id} 第${i}局应正常结束`);
      assert.ok(['good', 'wolf'].includes(g.winner), `${id} 第${i}局应有胜负`);
      const problems = auditIsolation(g);
      assert.deepStrictEqual(problems, [], `${id} 第${i}局隔离审计失败: ${problems.join('; ')}`);
      // 摄梦人局的连摄记录 / 暗恋者局的绑定必须存在
      if (id === 'dreamer12') assert.ok(g.events.some((e) => e.type === 'night_dream'), '应有摄梦事件');
      if (id === 'crowhidden12') assert.ok(g.events.some((e) => e.type === 'crow_curse'), '应有诅咒事件');
      if (id === 'admirer12') assert.ok(Object.keys(g.crush).length > 0, '暗恋者应完成绑定');
      if (id === 'wolfbeautyknight12') assert.strictEqual(g.rules.witchSelfSave, 'never', '板规应生效');
    }
  }
});

// ==================== 女巫自救第四档 + 暗牌局严谨化 ====================

test('女巫自救 noFirstNight：首夜不可自救，之后可自救', async () => {
  const g = makeGame({ board: { wolf: 1, witch: 1, seer: 1, villager: 2 }, rules: { witchSelfSave: 'noFirstNight' }, rnd: () => 0 });
  assignRoles(g, { 1: 'wolf', 2: 'witch', 3: 'seer', 4: 'villager', 5: 'villager' });
  g.phase = 'night';
  const mkNight = () => ({ guardActions: [], dreamActions: [], charmActions: [], curses: [], wolfKill: 2, saved: false, poisonTargets: [] });
  // 第 1 夜：狼刀女巫自己，尝试自救 → 规则拒绝（降级为不用药）
  g.day = 1;
  g.night = mkNight();
  g.witch = { antidoteUsed: false, poisonUsed: false };
  await _internals.witchStep(g);
  assert.strictEqual(g.night.saved, false, '首夜不可自救');
  assert.strictEqual(g.witch.antidoteUsed, false, '被拒绝的自救不消耗解药');
  // 第 2 夜：再被刀 → 可自救
  g.day = 2;
  g.night = mkNight();
  await _internals.witchStep(g);
  assert.strictEqual(g.night.saved, true, '第二夜起可自救');
  assert.strictEqual(g.witch.antidoteUsed, true);
});

test('暗牌局：死因不公开（渲染与 AI 上下文均无死因）', async () => {
  const { renderEvent } = require('../src/engine/render');
  const ctx = require('../src/ai/context');
  const g = makeGame({ rules: { revealOnDeath: false } });
  assignRoles(g, { 1: 'wolf', 2: 'guard', 3: 'seer', 4: 'witch', 5: 'hunter', 6: 'villager' });
  g.phase = 'night';
  g.day = 1;
  g.night = { guardActions: [], dreamActions: [], charmActions: [], curses: [], wolfKill: 6, saved: false, poisonTargets: [] };
  _internals.resolveNightDeaths(g);
  await _internals.dawnPhase(g);
  const de = g.events.find((e) => e.type === 'deaths');
  const line = renderEvent(g, de);
  assert.ok(line.includes('6号'), '应公布死亡座位');
  assert.ok(!line.includes('被袭击') && !line.includes('被狼人'), '暗牌局不应含死因');
  // AI 上下文同样不含死因文本
  const built = ctx.assemble(g, g.player(3), { task: 'speech' }, { digests: new Map(), lastSeq: 0, transcriptDays: [1] });
  assert.ok(!built.text.includes('被袭击'), 'AI 快照/实录不应出现死因');
  // 翻牌局对照：死因公开
  const g2 = makeGame({ rules: { revealOnDeath: true } });
  assignRoles(g2, { 1: 'wolf', 2: 'guard', 3: 'seer', 4: 'witch', 5: 'hunter', 6: 'villager' });
  g2.phase = 'night';
  g2.day = 1;
  g2.night = { guardActions: [], dreamActions: [], charmActions: [], curses: [], wolfKill: 6, saved: false, poisonTargets: [] };
  _internals.resolveNightDeaths(g2);
  await _internals.dawnPhase(g2);
  const line2 = renderEvent(g2, g2.events.find((e) => e.type === 'deaths'));
  assert.ok(line2.includes('被狼人袭击'), '翻牌局应保留死因');
  // 暗牌局公共提示词含暗牌铁律
  const common = buildCommonPrompt(g);
  assert.ok(common.includes('暗牌局'), '暗牌局应注入防幻觉铁律');
});

// ==================== 警徽策略（持徽打法 + 死后流转） ====================

test('警徽策略库：覆盖全部角色，hold/pass 非空且简短', () => {
  const { BADGE_STRATEGIES, badgeHoldFor, badgePassFor } = require('../src/ai/strategies');
  for (const rid of Object.keys(ROLES)) {
    const s = BADGE_STRATEGIES[rid];
    assert.ok(s && s.hold && s.pass, `${rid} 应有持徽与流转策略`);
    assert.ok(s.hold.length <= 120 && s.pass.length <= 120, `${rid} 警徽策略应简短（${s.hold.length}/${s.pass.length}）`);
    assert.ok(badgeHoldFor(rid) === s.hold && badgePassFor(rid) === s.pass);
  }
});

test('警徽策略注入：流转/方向/投票/归票各决策点', () => {
  const g = makeGame({});
  assignRoles(g, { 1: 'wolf', 2: 'seer', 3: 'villager', 4: 'witch' });
  const seer = game_becomeSheriff(g, 2);
  const wolf = game_becomeSheriff(g, g.player(1));
  // 警徽移交：预言家→金水策略；狼→队友策略
  const bpSeer = taskInstruction(g, seer, { task: 'badge_pass', candidates: [1, 3, 4] });
  assert.ok(bpSeer.includes('警徽流转策略') && bpSeer.includes('金水'), '预言家流转应提金水');
  const bpWolf = taskInstruction(g, wolf, { task: 'badge_pass', candidates: [2, 3, 4] });
  assert.ok(bpWolf.includes('狼队友') && bpWolf.includes('撕徽'), '狼的流转应提队友与撕徽');
  // 方向选择：持徽打法注入
  const dir = taskInstruction(g, seer, { task: 'direction' });
  assert.ok(dir.includes('警徽打法'), '方向任务应注入持徽打法');
  assert.ok(!taskInstruction(g, g.player(3), { task: 'direction' }).includes('警徽打法'), '非警长不注入');
  // 投票：警长 1.5 票提醒
  assert.ok(taskInstruction(g, seer, { task: 'vote', candidates: [1, 3] }).includes('1.5 票'), '警长投票应提醒票权');
  assert.ok(!taskInstruction(g, g.player(3), { task: 'vote', candidates: [1, 2] }).includes('1.5 票'), '非警长不提醒票权');
  // 发言：归票价值 + 持徽打法
  const sp = taskInstruction(g, seer, { task: 'speech' });
  assert.ok(sp.includes('归票') && sp.includes('警徽打法'), '警长发言应含归票与持徽打法');
  // 撕徽选项说明
  assert.ok(bpSeer.includes('0 表示撕毁'), '流转指令应说明 0=撕毁');
});

/** 测试辅助：把某座位设为警长并返回 player */
function game_becomeSheriff(g, player) {
  if (typeof player === 'number') player = g.player(player);
  player.isSheriff = true;
  return player;
}
