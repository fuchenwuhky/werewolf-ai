/**
 * capabilities.test.js — 能力注册表与伤害规则表（P2-1）
 *
 * 这次重构的价值不在于"代码更漂亮"，而在于**让"忘了登记"变成测试失败**：
 *   · 夜里能行动的步骤：以前条件散在三处（播报过滤 / if-else 派发 / 停顿判定），漏一处就出错；
 *   · 死因：以前"优先级"和"是否触发殉情"写在两段代码里，新增伤害源只能靠读代码猜。
 * 现在两者都是表，于是可以断言"表覆盖了所有角色/所有死因"。这一组测试就是那张网的网眼。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROLES } = require('../src/engine/roles');
const { DEFAULT_RULES } = require('../src/engine/rules');
const { _internals } = require('../src/engine/flow');
const { validatePayload } = require('../src/engine/flow');
const {
  DAMAGE_RULES, prioOf, triggersCharm, isNightDamage, collectNightDamage, applyDreamEffects, dedupeDamage, resolveNightDamage,
} = require('../src/engine/damage');
const { Game } = require('../src/engine/game');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const NIGHT_STEPS = _internals.NIGHT_STEPS;
const TASK_VALIDATORS = _internals.TASK_VALIDATORS;

function makeGame({ board = {}, rules = {}, players = 6, day = 1 } = {}) {
  const list = Array.from({ length: players }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
  const g = new Game({ id: 'cap', board, rules, players: list, stepPauseMs: 0, logger: silentLogger });
  g.day = day;
  g.night = { guardActions: [], dreamActions: [], charmActions: [], curses: [], wolfKill: 0, saved: false, poisonTargets: [] };
  g.pendingDeaths = [];
  g.lastDreamMap = {};
  g.charmMap = {};
  return g;
}

// ---------- 夜晚步骤注册表 ----------

test('能力注册表：每个角色的 nightStep 都必须有对应的执行器（roles.js 声称"只需注册能力"，这句话现在成立）', () => {
  const steps = new Set(Object.values(ROLES).map((r) => r.nightStep).filter(Boolean));
  const missing = [...steps].filter((s) => !NIGHT_STEPS[s]);
  assert.deepStrictEqual(missing, [], `这些 nightStep 没有执行器（夜里会静默跳过）：${missing.join(', ')}`);
});

test('能力注册表：注册的步骤必须在 rules.nightOrder 里（否则永远不会被执行）', () => {
  const order = new Set(DEFAULT_RULES.nightOrder);
  const orphan = Object.keys(NIGHT_STEPS).filter((s) => !order.has(s));
  assert.deepStrictEqual(orphan, [], `这些步骤注册了但不在默认夜晚顺序里：${orphan.join(', ')}`);
  // 反向：nightOrder 里的每一项都必须有执行器，否则会播报一个没人执行的步骤
  const unhandled = DEFAULT_RULES.nightOrder.filter((s) => !NIGHT_STEPS[s]);
  assert.deepStrictEqual(unhandled, [], `夜晚顺序里有未注册的步骤：${unhandled.join(', ')}`);
});

test('能力注册表：present 必须按板子/天数判定，且狼步用狼队而不是 aliveOfRole', () => {
  // 板子里没有的角色 → 不播报
  const g1 = makeGame({ board: { wolf: 1, villager: 5 } });
  assert.strictEqual(NIGHT_STEPS.guard.present(g1), false, '板子里没有守卫就不该有守卫步骤');
  assert.strictEqual(NIGHT_STEPS.wolf.present(g1), false, '没有狼的板子不该有狼步');
  // 有狼 → 播报
  const list = Array.from({ length: 6 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
  const g2 = new Game({ id: 'cap2', board: { wolf: 1, villager: 5 }, players: list, stepPauseMs: 0, logger: silentLogger });
  g2.deal();
  assert.strictEqual(NIGHT_STEPS.wolf.present(g2), true);
  // 暗恋者只在首夜行动
  const g3 = makeGame({ board: { wolf: 1, admirer: 1, villager: 4 }, day: 2 });
  assert.strictEqual(NIGHT_STEPS.admirer.present(g3), false, '暗恋者第 2 夜不该再行动');
});

test('能力注册表：隐狼不算夜间行动者（狼步的行动者必须是 nightWolves，不是全部狼）', () => {
  const list = Array.from({ length: 8 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
  const g = new Game({ id: 'cap-hidden', board: { wolf: 1, hiddenwolf: 1, villager: 6 }, players: list, stepPauseMs: 0, logger: silentLogger });
  g.deal();
  for (const p of g.players) if (p.role !== 'hiddenwolf' && p.alive) p.alive = false; // 只留隐狼活着
  const actors = NIGHT_STEPS.wolf.actors(g);
  assert.deepStrictEqual(actors.map((p) => p.seat), [], '只剩隐狼时狼步应视为"无行动者"（隐狼夜里不参与刀人）');
  // 对照：aliveOfRole('wolf') 的口径会包含隐狼以外的狼，两者不可互换
  assert.ok(actors.every((p) => p.role !== 'hiddenwolf'), 'action 列表里不得出现隐狼');
});

// ---------- 任务校验器注册表 ----------

test('任务注册表：flow.js 里发起的每个 task 都必须登记校验器（否则玩家输入会被判"未知任务"）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'flow.js'), 'utf8');
  const tasks = new Set();
  for (const m of src.matchAll(/task:\s*'([a-z_]+)'/g)) tasks.add(m[1]);
  assert.ok(tasks.size >= 15, `flow.js 里应至少出现 15 种 task，实际 ${tasks.size}`);
  const unregistered = [...tasks].filter((t) => !TASK_VALIDATORS[t]);
  assert.deepStrictEqual(unregistered, [], `这些 task 没有校验器（人类玩家会被拒）：${unregistered.join(', ')}`);
});

test('任务注册表：共用语义必须真的共用同一个校验器（避免改一处漏一处）', () => {
  // 三种发言阶段共用"发言 + 可自爆"校验（pk_speech 漏掉过一次 → 白狼王自爆变死代码）
  assert.strictEqual(TASK_VALIDATORS.speech, TASK_VALIDATORS.pk_speech);
  assert.strictEqual(TASK_VALIDATORS.speech, TASK_VALIDATORS.sheriff_speech);
  // 五处"选一名候选"共用
  for (const t of ['night_guard', 'wolf_kill', 'vote', 'pk_vote', 'sheriff_vote']) {
    assert.strictEqual(TASK_VALIDATORS[t], TASK_VALIDATORS.vote, `${t} 应与其他选目标任务共用校验器`);
  }
  // 四处"必须选一名非自己"共用
  for (const t of ['night_dream', 'crow_curse', 'wolfbeauty_charm', 'admirer_crush']) {
    assert.strictEqual(TASK_VALIDATORS[t], TASK_VALIDATORS.night_dream, `${t} 应与其他必须选目标的任务共用校验器`);
  }
  // 未登记的任务必须明确报错，不能静默放行
  const g = makeGame({ board: { wolf: 1, villager: 5 } });
  const r = validatePayload('不存在的任务', {}, {}, g, 1);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /未知任务/);
});

// ---------- 伤害规则表 ----------

test('伤害规则表：代码里出现的每个死因都必须登记（新增伤害源不能悄悄绕过规则表）', () => {
  // 结算发生在 flow.js，规则与采集在 damage.js —— 两处都要扫
  const files = ['flow.js', 'damage.js'].map((f) => path.join(__dirname, '..', 'src', 'engine', f));
  const causes = new Set();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/settleDeath\([^,]+,[^,]+,\s*'([a-z_]+)'/g)) causes.add(m[1]);
    for (const m of src.matchAll(/cause:\s*'([a-z_]+)'/g)) causes.add(m[1]);
  }
  const unregistered = [...causes].filter((c) => !DAMAGE_RULES[c]);
  assert.deepStrictEqual(unregistered, [], `这些死因没有登记到 DAMAGE_RULES：${unregistered.join(', ')}`);
  assert.ok(causes.size >= 6, `至少应识别到 6 种死因，实际 ${causes.size}：${[...causes].join(', ')}`);
});

test('伤害规则表：优先级必须保持既有语义（毒 0 < 连摄 1 < 其余 2，改动即改游戏语义）', () => {
  assert.strictEqual(prioOf('poison'), 0);
  assert.strictEqual(prioOf('dream'), 1);
  for (const c of ['wolf_kill', 'dream_follow', 'vote_out', 'shot', 'explode_self', 'charm_follow']) {
    assert.strictEqual(prioOf(c), 2, `${c} 的优先级必须是 2`);
  }
  assert.strictEqual(prioOf('完全未知的死因'), 2, '未知死因必须有安全默认值');
});

test('伤害规则表：殉情触发死因恰好是毒/放逐/枪/摄梦系（狼刀与决斗不触发）', () => {
  for (const c of ['poison', 'vote_out', 'shot', 'dream', 'dream_follow']) {
    assert.strictEqual(triggersCharm(c), true, `${c} 应触发狼美人殉情`);
  }
  for (const c of ['wolf_kill', 'duel_win', 'duel_fail', 'explode_self', 'explode_target', 'charm_follow']) {
    assert.strictEqual(triggersCharm(c), false, `${c} 不该触发殉情`);
  }
  assert.strictEqual(triggersCharm('未知死因'), false, '未知死因默认不触发');
});

test('伤害结算：采集与守卫/解药/同守同救（等价于旧实现，含三种奶穿变体）', () => {
  const base = () => makeGame({ board: { wolf: 1, guard: 1, villager: 4 }, rules: { milkThrough: 'die' } });
  // 正常刀死
  let g = base();
  g.night.wolfKill = 5;
  assert.deepStrictEqual(collectNightDamage(g).map((d) => d.seat), [5]);
  // 被守护/被救 → 不进队列
  g = base(); g.night.wolfKill = 5; g.night.guardActions = [{ seat: 2, target: 5 }];
  assert.deepStrictEqual(collectNightDamage(g), []);
  g = base(); g.night.wolfKill = 5; g.night.saved = true;
  assert.deepStrictEqual(collectNightDamage(g), []);
  // 同守同救：die / guardDies（自守才死）/ cancel
  g = base(); g.night.wolfKill = 5; g.night.saved = true; g.night.guardActions = [{ seat: 2, target: 5 }];
  assert.deepStrictEqual(collectNightDamage(g).map((d) => d.cause), ['wolf_kill']);
  g = base(); g.night.wolfKill = 2; g.night.saved = true; g.night.guardActions = [{ seat: 2, target: 2 }];
  g.rules.milkThrough = 'guardDies';
  assert.deepStrictEqual(collectNightDamage(g).map((d) => d.seat), [2], '守卫自守 + 被救 → 守卫死');
  g = base(); g.night.wolfKill = 5; g.night.saved = true; g.night.guardActions = [{ seat: 2, target: 5 }];
  g.rules.milkThrough = 'guardDies';
  assert.deepStrictEqual(collectNightDamage(g), [], '非自守的同守同救 → 存活');
  g = base(); g.night.wolfKill = 5; g.night.saved = true; g.night.guardActions = [{ seat: 2, target: 5 }];
  g.rules.milkThrough = 'cancel';
  assert.deepStrictEqual(collectNightDamage(g), []);
  // 空刀
  g = base();
  assert.deepStrictEqual(collectNightDamage(g), []);
});

test('伤害结算：摄梦免疫夜间伤害、连摄致死、摄梦人出局连带（含链式连带）', () => {
  // ① 摄梦人活着 → 目标免疫狼刀/毒
  let g = makeGame({ board: { wolf: 1, dreamer: 1, witch: 1, villager: 3 } });
  g.night.wolfKill = 3;
  g.night.poisonTargets = [3];
  g.night.dreamActions = [{ seat: 2, target: 3 }];
  assert.deepStrictEqual(resolveNightDamage(g), [], '被摄梦者当夜免疫夜间伤害');
  // ② 连摄两晚 → 死因是 dream（解药救不活）
  g = makeGame({ board: { wolf: 1, dreamer: 1, villager: 4 } });
  g.night.dreamActions = [{ seat: 2, target: 3 }];
  g.lastDreamMap = { 2: 3 };
  assert.deepStrictEqual(resolveNightDamage(g), [{ seat: 3, cause: 'dream' }]);
  // ③ 摄梦人被杀 → 梦游者连带
  g = makeGame({ board: { wolf: 1, dreamer: 1, villager: 4 } });
  g.night.wolfKill = 2;
  g.night.dreamActions = [{ seat: 2, target: 3 }];
  const dead = resolveNightDamage(g);
  assert.deepStrictEqual(dead.map((d) => `${d.seat}:${d.cause}`), ['2:wolf_kill', '3:dream_follow']);
  // ④ 链式连带：摄梦人 A 死 → 其目标（也是摄梦人 B）死 → B 的目标也连带
  g = makeGame({ board: { wolf: 1, dreamer: 2, villager: 3 } });
  g.night.wolfKill = 2;
  g.night.dreamActions = [{ seat: 2, target: 4 }, { seat: 4, target: 5 }];
  const chain = resolveNightDamage(g).map((d) => `${d.seat}:${d.cause}`).sort();
  assert.deepStrictEqual(chain, ['2:wolf_kill', '4:dream_follow', '5:dream_follow'], '摄梦人链必须连锁（既有语义）');
});

test('伤害结算：同座位多来源去重，死因取根因；排序是「先按优先级、再按座位」', () => {
  const q = [
    { seat: 5, cause: 'wolf_kill' },
    { seat: 3, cause: 'wolf_kill' },
    { seat: 5, cause: 'poison' },
    { seat: 3, cause: 'dream' },
    { seat: 3, cause: 'vote_out' },
  ];
  const out = dedupeDamage(q).map((d) => `${d.seat}:${d.cause}`);
  // 排序键是 (prio, seat)：毒(0) 排最前，其次连摄(1)，其余(2) 按座位升序
  assert.deepStrictEqual(out, ['5:poison', '3:dream']);
  assert.strictEqual(dedupeDamage([{ seat: 2, cause: 'wolf_kill' }, { seat: 2, cause: 'dream_follow' }])[0].cause,
    'wolf_kill', '狼刀与摄梦连带并列时保留狼刀（与重构前的稳定排序结果一致）');
});

test('伤害结算：非夜间伤害不受摄梦免疫影响（摄梦只挡夜间伤害）', () => {
  assert.strictEqual(isNightDamage('wolf_kill'), true);
  assert.strictEqual(isNightDamage('poison'), true);
  assert.strictEqual(isNightDamage('vote_out'), false);
  assert.strictEqual(isNightDamage('shot'), false);
  // 队列里塞一条白天死因，摄梦不该把它抹掉
  const q = [{ seat: 3, cause: 'vote_out' }];
  const g = makeGame({ board: { wolf: 1, dreamer: 1, villager: 4 } });
  g.night.dreamActions = [{ seat: 2, target: 3 }];
  assert.deepStrictEqual(applyDreamEffects(g, q).map((d) => d.cause), ['vote_out']);
});

test('伤害结算：入口不得改动 night 结构（纯结算，副作用留给 flow）', () => {
  const g = makeGame({ board: { wolf: 1, villager: 5 } });
  g.night.wolfKill = 4;
  const snapshot = JSON.stringify(g.night);
  resolveNightDamage(g);
  assert.strictEqual(JSON.stringify(g.night), snapshot, 'resolveNightDamage 不得修改 game.night');
  assert.deepStrictEqual(g.pendingDeaths, [], 'resolveNightDamage 自己不该写 pendingDeaths（那是 flow 的封装职责）');
});
