/**
 * mock-agent.js — 用于测试与本地模拟的脚本化智能体（不调用任何网络接口）
 * 以随机策略覆盖所有任务类型，用于验证引擎闭环、隔离审计与降级路径。
 */
'use strict';

function makeMockAgentFactory(rnd = Math.random, opts = {}) {
  return (player, game) => ({
    async decide(request) {
      const r = request;
      const alive = game.aliveSeats();
      const pick = (cands) => cands[Math.floor(rnd() * cands.length)];
      const maybe = (p) => rnd() < p;
      switch (r.task) {
        case 'speech':
        case 'pk_speech':
        case 'sheriff_speech': {
          if (r.canExplode && maybe(opts.explodeRate != null ? opts.explodeRate : 0.004)) {
            const payload = { text: '懒得装了，我自爆！', explode: true };
            if (player.role === 'whitewolfking') payload.target = pick(alive.filter((s) => s !== player.seat));
            return payload;
          }
          if (r.task === 'sheriff_speech' && maybe(0.05)) return { text: '我退水，不竞选了。', withdraw: true };
          const lines = [
            `${player.seat}号我觉得场上信息还很少，先听后置位的。`,
            `我是好人，昨晚过得很平静，大家注意${pick(alive)}号的发言。`,
            `目前我倾向于从发言状态找问题，暂时不站边。`,
          ];
          return { text: lines[Math.floor(rnd() * lines.length)] };
        }
        case 'duel_check': {
          if (!maybe(0.03)) return { duel: false };
          const t = (r.candidates || []).filter((x) => x !== player.seat);
          return t.length ? { duel: true, target: pick(t) } : { duel: false };
        }
        case 'explode_check': {
          if (!maybe(opts.explodeRate != null ? opts.explodeRate : 0.02)) return { explode: false };
          const payload = { explode: true };
          if (player.role === 'whitewolfking') payload.target = pick(alive.filter((x) => x !== player.seat));
          return payload;
        }
        case 'lastwords':
          return { text: '我是好人，帮我把票找回来！' };
        case 'wolf_propose':
          return { text: '我觉得刀一个发言最差的，大家表个态。' };
        case 'wolf_chat': {
          const t = r.allowNone && maybe(0.1) ? 0 : pick(r.candidates);
          return { text: `基于目前的信息，我建议${t ? `刀 ${t} 号` : '空刀'}，理由是这个位置最像神。`, target: t };
        }
        case 'wolf_kill':
          return { target: r.allowNone && maybe(0.12) ? 0 : pick(r.candidates) };
        case 'night_guard':
          return { target: r.allowNone && maybe(0.25) ? 0 : pick(r.candidates) };
        case 'night_dream':
        case 'crow_curse':
        case 'wolfbeauty_charm':
        case 'admirer_crush':
          return { target: pick(r.candidates) };
        case 'seer_check':
          return { target: pick(r.candidates) };
        case 'witch': {
          const ex = r.extra || {};
          const payload = { antidote: false, poison: 0 };
          if (ex.canAntidote && maybe(0.7)) payload.antidote = true;
          else if (ex.canPoison && maybe(0.18)) {
            const targets = alive.filter((s) => s !== player.seat);
            payload.poison = pick(targets.length ? targets : alive);
          }
          return payload;
        }
        case 'sheriff_run':
          return { run: maybe(opts.runRate != null ? opts.runRate : 0.35) };
        case 'sheriff_vote':
          return { target: r.allowNone && maybe(0.1) ? 0 : pick(r.candidates) };
        case 'badge_pass':
          return { target: maybe(0.7) ? pick(game.aliveSeats()) : 0 };
        case 'direction':
          return { direction: maybe(0.5) ? 'cw' : 'ccw' };
        case 'vote':
        case 'pk_vote':
          return { target: maybe(0.08) ? 0 : pick(r.candidates) };
        case 'shoot':
          return { target: maybe(0.85) ? pick(game.aliveSeats()) : 0 };
        default:
          return {};
      }
    },
  });
}

/** 隔离审计：校验每条事件的可见性标签是否泄漏私密信息 */
function auditIsolation(game) {
  const problems = [];
  const { ROLES } = require('../src/engine/roles');
  const role = (s) => (game.player(s) ? game.player(s).role : null);
  const isWolfSeat = (s) => !!ROLES[role(s)] && ROLES[role(s)].team === 'wolf';
  for (const e of game.events) {
    const vis = e.visibleTo;
    const seats = Array.isArray(vis) ? vis : null;
    switch (e.type) {
      case 'deal':
        if (!seats || seats.length !== 1) problems.push(`deal 事件可见性异常 seq=${e.seq}`);
        break;
      case 'teammates':
      case 'wolf_propose':
      case 'wolf_kill':
      case 'wolf_kill_vote':
        if (!seats || seats.some((s) => !isWolfSeat(s))) {
          problems.push(`狼队私密事件泄漏 seq=${e.seq} type=${e.type} vis=${vis}`);
        }
        break;
      case 'seer_check':
        if (!seats || seats.length !== 1 || role(seats[0]) !== 'seer') problems.push(`查验结果泄漏 seq=${e.seq}`);
        break;
      case 'witch_info':
      case 'witch_action':
        if (!seats || seats.length !== 1 || role(seats[0]) !== 'witch') problems.push(`女巫信息泄漏 seq=${e.seq}`);
        break;
      case 'night_guard':
        if (!seats || seats.length !== 1 || role(seats[0]) !== 'guard') problems.push(`守卫目标泄漏 seq=${e.seq}`);
        break;
      case 'night_dream':
        if (!seats || seats.length !== 1 || role(seats[0]) !== 'dreamer') problems.push(`摄梦目标泄漏 seq=${e.seq}`);
        break;
      case 'wolfbeauty_charm':
        if (!seats || seats.length !== 1 || role(seats[0]) !== 'wolfbeauty') problems.push(`魅惑目标泄漏 seq=${e.seq}`);
        break;
      case 'crow_curse':
        if (!seats || seats.length !== 1 || role(seats[0]) !== 'crow') problems.push(`诅咒目标泄漏 seq=${e.seq}`);
        break;
      case 'admirer_crush':
        if (!seats || seats.length !== 1 || role(seats[0]) !== 'admirer') problems.push(`暗恋对象泄漏 seq=${e.seq}`);
        break;
      case 'vote_cast':
        if (!seats || seats.length !== 1 || seats[0] !== e.actor) problems.push(`投票保密性被破坏 seq=${e.seq}`);
        break;
      default:
        break;
    }
  }
  return problems;
}

module.exports = { makeMockAgentFactory, auditIsolation };
