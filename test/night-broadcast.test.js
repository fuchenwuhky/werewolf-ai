/**
 * night-broadcast.test.js — 夜晚播报与行动解耦的回归测试。
 *
 * 起因（用户实测反馈）：改成多 Key 并发后，"夜间行动播报变得奇怪"。
 * 根因在 src/engine/flow.js 的 runNightWaves：播报写在**波次**里，每一波开跑前把该波所有步骤
 * 一起发出去；而 NIGHT_DEPS 只让女巫等狼刀，于是第一波就是守卫/狼人/预言家/… 齐射，
 * 玩家看到"啪一下全出来"，而不是一条一条按顺序出来。
 *
 * 现在：nightPhase 在**开始行动之前**按 nightOrder 一次性发出整夜的 night_step
 * （事件内容与旧串行路径逐字节相同：同样的事件、同样的顺序、同样的 index/total），
 * 节奏交给客户端按固定间隔播放。
 *
 * 断言方式不看时间戳（并发下时间戳本身不可靠），而是看事件的 seq 连续性：
 * 一个夜晚的 night_step 必须**连成一段**，段长等于 total —— 旧实现里被分到第二波的女巫
 * 会落在狼人行动事件之后，段长必然小于 total，这条测试就会红。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('../src/engine/game');
const { runGame, _internals } = require('../src/engine/flow');

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** 脚本化智能体：载荷形状对齐 src/ai/schemas.js（空刀/弃票都是合法载荷），零网络、零成本 */
function scriptedFactory(player, game) {
  return {
    async decide(req) {
      const others = game.aliveSeats().filter((s) => s !== player.seat);
      const first = others.length ? others[0] : 0;
      switch (req.task) {
        case 'speech': case 'sheriff_speech': case 'pk_speech':
          return { text: '过。', explode: false, target: 0, withdraw: false, claims: [] };
        case 'wolf_chat': return { text: '过。', target: 0 };
        case 'wolf_propose': case 'wolf_say': case 'lastwords': return { text: '过。' };
        case 'wolf_kill': case 'vote': case 'pk_vote': case 'sheriff_vote': case 'badge_pass': case 'shoot':
          return { target: 0 };
        case 'witch': return { antidote: false, poison: 0 };
        case 'sheriff_run': return { run: false };
        case 'direction': return { direction: 'cw' };
        case 'duel_check': return { explode: false, duel: false, target: first };
        case 'seer_check': case 'night_guard': case 'night_dream': case 'crow_curse':
        case 'wolfbeauty_charm': case 'admirer_crush':
          return { target: first };
        default: return { text: '过。', target: 0 };
      }
    },
  };
}

/** 把事件流按"夜晚"切段：phase（天黑请闭眼）之后到下一个 phase 之前的 night_step 属同一夜 */
function nightGroups(events) {
  const groups = [];
  let cur = null;
  for (const e of events) {
    if (e.type === 'phase') {
      cur = /天黑请闭眼/.test((e.data && e.data.title) || '') ? [] : null;
      if (cur) groups.push(cur);
      continue;
    }
    if (e.type === 'night_step' && cur) cur.push(e);
  }
  return groups;
}

test('夜晚播报与行动解耦：整夜的步骤连成一段（不在波次里齐射）', async () => {
  global.fetch = async (url) => { throw new Error(`测试禁止真实网络请求：${url}`); };
  // 8 人板子里有守卫/预言家/女巫/狼：女巫依赖狼刀 → 旧实现至少两波，正是能暴露问题的形状
  const board = { wolf: 2, seer: 1, witch: 1, guard: 1, villager: 3 };
  const players = Array.from({ length: 8 }, (_, i) => ({ name: `P${i + 1}` }));
  const g = new Game({
    id: 'night-broadcast', board, players, agentFactory: scriptedFactory,
    stepPauseMs: 0, parallelLlm: true, logger: silent, // 并发路径 = 出问题的那条
  });
  await runGame(g);

  const groups = nightGroups(g.events);
  assert.ok(groups.length >= 1, '至少要跑过一个夜晚');

  for (const [i, group] of groups.entries()) {
    const total = group[0].data.total;
    assert.strictEqual(group.length, total, `第 ${i + 1} 夜应一次性播出 ${total} 条播报，实际 ${group.length} 条`);
    // 段内 seq 必须连续：中间插进任何"行动事件"就说明播报又被绑回波次了
    const seqs = group.map((e) => e.seq);
    for (let k = 1; k < seqs.length; k++) {
      assert.strictEqual(seqs[k], seqs[k - 1] + 1, `第 ${i + 1} 夜第 ${k + 1} 条播报与上一条不相邻（seq ${seqs[k - 1]} → ${seqs[k]}）：播报被行动切开了`);
    }
    // 序号连续且和 total 一致
    assert.deepStrictEqual(group.map((e) => e.data.index), group.map((_, k) => k + 1), '序号必须是 1..N');
    assert.ok(group.every((e) => e.data.total === total), '同一夜的 total 必须一致');
    // 顺序必须等于 rules.nightOrder（过滤掉本局不存在的角色）
    const order = g.rules.nightOrder.filter((s) => group.some((e) => e.data.step === s));
    assert.deepStrictEqual(group.map((e) => e.data.step), order, '播报顺序必须严格按 nightOrder');
  }
});

test('夜晚播报文案：每条都带氛围化后缀，不再是"XX行动"的流水账', () => {
  const labels = Object.values(_internals.NIGHT_STEPS).map((s) => s.label);
  assert.ok(labels.length >= 8, `八个身份步骤都要有播报文案，实际 ${labels.length} 条`);
  for (const l of labels) {
    assert.match(l, /·/, `播报文案要有"身份 · 氛围"两段：${l}`);
    assert.ok(!/行动$/.test(l), `不该退回流水账（结尾"行动"）：${l}`);
  }
});

test('检测器本身有效：旧实现的"波次齐射"事件流必须被判不合格', () => {
  // 回归测试最怕"永远绿的断言"。这里把旧实现的事件流形状人工喂进同一个判定逻辑：
  // 第 1 波（守卫/狼人/预言家）先播 → 中间夹着行动事件 → 第 2 波（女巫）后播。
  const ev = (seq, type, data) => ({ seq, type, data });
  const oldStream = [
    ev(1, 'phase', { title: '第1夜 · 天黑请闭眼' }),
    ev(2, 'night_step', { step: 'guard', total: 4, index: 1 }),
    ev(3, 'night_step', { step: 'wolf', total: 4, index: 2 }),
    ev(4, 'night_step', { step: 'seer', total: 4, index: 3 }),
    ev(5, 'night_guard', {}), // ← 行动事件插进来，把播报切成两段（旧实现的症状）
    ev(6, 'night_step', { step: 'witch', total: 4, index: 4 }),
  ];
  const g0 = nightGroups(oldStream)[0];
  const seqBroken = g0.some((e, k) => k > 0 && e.seq !== g0[k - 1].seq + 1);
  assert.ok(seqBroken, '旧形状必须被判定为"播报被行动切开"，否则这条测试守不住任何东西');
});
