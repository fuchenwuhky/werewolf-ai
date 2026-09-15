/**
 * damage.js — 伤害事件队列与死因规则表（P2-1）
 *
 * 重构前：`resolveNightDeaths` 把"谁被刀、谁被救、谁被守、摄梦免疫、连带死亡、同座位去重"
 * 揉在一个函数里，判定顺序和优先级都藏在 if/else 的书写顺序里。
 * 想加一个新伤害源（比如新角色的夜间击杀）必须读懂整段代码，还要赌自己没改变原有顺序——
 * 而"死亡结算"恰好是全项目最容易出微妙 bug 的地方（同守同救、连摄、殉情链都在这）。
 *
 * 现在拆成三步，每步职责单一：
 *   ① `collectNightDamage` 只**采集**伤害事件，不判死活；
 *   ② `applyDreamEffects` 处理摄梦的免疫与连带；
 *   ③ `dedupeDamage` 用**规则表**里的优先级去重（同一人一夜只能死一次，死因取"根因"）。
 *
 * 规则表把死因的性质显式写出来：能不能被守护/解药挡、算不算夜间伤害、会不会触发狼美人殉情。
 * 新增伤害源 = 加一行表 + 加一处采集，不再需要在结算逻辑里插判断。
 *
 * 纯函数、无 IO、无事件（emit 由 flow.js 负责），因此可以单独测满边界。
 */
'use strict';

/**
 * 死因规则表。
 *
 * prio：同一座位同时被多个来源命中时，保留 prio 最小者作为死因。
 *   **这是与重构前完全等价的值**：原实现是 `poison=0 / dream=1 / 其余=2`，
 *   `dream_follow` 与 `wolf_kill` 同为 2（并列时靠稳定排序保持"先采集者优先"，
 *   而狼刀总是先于摄梦连带进队列）。改动这里的数值就等于改游戏语义，请三思。
 * guardable / healable：能否被守卫守护 / 女巫解药挡下（只对夜间伤害有意义）。
 * charm：该死因是否触发狼美人殉情链（原为写死数组 ['poison','vote_out','shot','dream','dream_follow']）。
 */
const DAMAGE_RULES = {
  // ---- 夜间伤害 ----
  poison: { prio: 0, night: true, guardable: false, healable: false, charm: true, label: '毒杀' },
  dream: { prio: 1, night: true, guardable: false, healable: false, charm: true, label: '连续两夜摄梦' },
  wolf_kill: { prio: 2, night: true, guardable: true, healable: true, charm: false, label: '狼刀' },
  dream_follow: { prio: 2, night: true, guardable: false, healable: false, charm: true, label: '摄梦人出局连带' },
  // ---- 白天/技能伤害 ----
  vote_out: { prio: 2, night: false, charm: true, label: '放逐' },
  shot: { prio: 2, night: false, charm: true, label: '开枪带走' },
  explode_self: { prio: 2, night: false, charm: false, label: '自爆' },
  explode_target: { prio: 2, night: false, charm: false, label: '被自爆带走' },
  duel_win: { prio: 2, night: false, charm: false, label: '决斗获胜' },
  duel_fail: { prio: 2, night: false, charm: false, label: '决斗落败' },
  charm_follow: { prio: 2, night: false, charm: false, label: '殉情' },
};

const prioOf = (cause) => (DAMAGE_RULES[cause] ? DAMAGE_RULES[cause].prio : 2);

/** 该死因是否触发狼美人殉情链 */
function triggersCharm(cause) {
  const r = DAMAGE_RULES[cause];
  return !!(r && r.charm);
}

/** 死因是否属于"夜间伤害"（摄梦免疫只对夜间伤害生效） */
function isNightDamage(cause) {
  const r = DAMAGE_RULES[cause];
  return !!(r && r.night);
}

/**
 * ① 采集夜间伤害。只产出"谁被什么打中"，不做任何存活判定。
 * 守卫/解药/同守同救的判定在这里完成（它们决定狼刀是否进入队列）。
 */
function collectNightDamage(game) {
  const n = game.night || {};
  const queue = [];
  const wolfKill = n.wolfKill || 0;
  const guardActions = n.guardActions || [];
  const poisonTargets = n.poisonTargets || [];
  if (wolfKill > 0) {
    const guarded = guardActions.some((g) => g.target === wolfKill);
    if (n.saved && guarded) {
      // 同守同救：按板规开关判定
      if (game.rules.milkThrough === 'die') {
        queue.push({ seat: wolfKill, cause: 'wolf_kill' });
      } else if (game.rules.milkThrough === 'guardDies') {
        // 只有"守卫自守被刀又被救"时才死
        const selfGuard = guardActions.some((g) => g.target === wolfKill && g.seat === wolfKill);
        if (selfGuard) queue.push({ seat: wolfKill, cause: 'wolf_kill' });
      } // cancel：无人死
    } else if (!n.saved && !guarded) {
      queue.push({ seat: wolfKill, cause: 'wolf_kill' });
    }
    // 被救未守 / 被守未救 → 存活
  }
  for (const pt of poisonTargets) queue.push({ seat: pt, cause: 'poison' });
  return queue;
}

/**
 * ② 摄梦结算（官方规则）：
 *   · 摄梦人当晚死亡 → 梦游者连带出局（不可守护、不可救治）
 *   · 摄梦人存活 → 梦游者当夜免疫夜间伤害（技能视为落空，药照耗）
 *   · 连续两晚摄梦同一人 → 梦游者死亡（女巫救不活）
 *
 * 注意这里**必须**按 dreamActions 的顺序逐个处理，且每一步都读"当前队列"：
 * 前面迭代刚加进去的连带死亡会让后面的摄梦人也变成"已死亡"，从而触发链式连带。
 * 这是原实现的既有语义（摄梦人A→摄梦人B 会连锁），不是巧合。
 */
function applyDreamEffects(game, queue) {
  const dreamActions = (game.night && game.night.dreamActions) || [];
  for (const a of dreamActions) {
    const dreamerDies = queue.some((d) => d.seat === a.seat);
    if (dreamerDies) {
      queue.push({ seat: a.target, cause: 'dream_follow' });
      continue;
    }
    // 摄梦人活着 → 该目标当夜的伤害全部落空
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].seat === a.target && isNightDamage(queue[i].cause)) queue.splice(i, 1);
    }
    if (game.lastDreamMap && game.lastDreamMap[a.seat] === a.target) {
      queue.push({ seat: a.target, cause: 'dream' });
    }
  }
  return queue;
}

/** ③ 去重：同一人一夜只死一次，死因取规则表里 prio 最小者 */
function dedupeDamage(queue) {
  const seen = new Set();
  return queue
    .slice()
    .sort((a, b) => prioOf(a.cause) - prioOf(b.cause) || a.seat - b.seat)
    .filter((d) => { if (seen.has(d.seat)) return false; seen.add(d.seat); return true; });
}

/** 完整结算：采集 → 摄梦 → 去重。返回值即"今晚谁死了、因何而死"。 */
function resolveNightDamage(game) {
  return dedupeDamage(applyDreamEffects(game, collectNightDamage(game)));
}

module.exports = {
  DAMAGE_RULES, prioOf, triggersCharm, isNightDamage,
  collectNightDamage, applyDreamEffects, dedupeDamage, resolveNightDamage,
};
