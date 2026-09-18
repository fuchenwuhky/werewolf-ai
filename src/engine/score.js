/**
 * score.js — 对局评分（借鉴 AIWolfGame 的 MVP 量化体系，规则针对本项目角色调整）
 *
 * 纯函数：从终局状态 + 全量事件流计算每个玩家的得分明细。只在对局结束后调用。
 * 维度：胜负 / 存活 / 发言参与 / 放逐投票准确率 / 技能价值。
 */
'use strict';
const { ROLES } = require('./roles');

function computeScores(game) {
  const events = game.events;
  const rows = new Map();
  for (const p of game.players) {
    rows.set(p.seat, {
      // 整改 LOGIC-01：team 用最终胜负阵营（暗恋者随绑定对象变动），不再读静态 ROLES.team
      seat: p.seat, name: p.name, role: p.role, team: game.factionOf(p), alive: p.alive,
      score: 0, details: [],
      _speeches: 0, _votes: [], _checks: 0, _checksHit: 0,
      _guards: [], _kills: [],
    });
  }
  const add = (seat, pts, why) => {
    const r = rows.get(seat);
    if (!r) return;
    r.score += pts;
    if (why) r.details.push(`${pts > 0 ? '+' : ''}${pts} ${why}`);
  };

  // ---- 技能与行动明细（按事件流） ----
  const dayWolfKill = new Map(); // day -> 刀口
  const dayGuard = new Map(); // day -> 守护
  const dayDeaths = new Map(); // day -> [cause]
  for (const e of events) {
    const d = e.data || {};
    if (e.type === 'speech' && d.context === 'day') {
      const r = rows.get(e.actor);
      if (r) r._speeches++;
    } else if (e.type === 'vote_cast' && (e.phase === 'vote' || e.phase === 'pk')) {
      const r = rows.get(e.actor);
      if (r && d.target) r._votes.push(d.target);
    } else if (e.type === 'wolf_kill' && d.target) {
      dayWolfKill.set(e.day, d.target);
    } else if (e.type === 'night_guard' && d.target) {
      dayGuard.set(e.day, d.target);
    } else if (e.type === 'deaths') {
      dayDeaths.set(e.day, (d.deaths || []).map((x) => x.cause));
    } else if (e.type === 'seer_check') {
      const r = rows.get(e.actor);
      if (r) {
        r._checks++;
        if (d.isWolf) r._checksHit++;
      }
    }
  }

  // 狼刀成功次数（狼队共享加分）：按"当晚有刀口且天亮宣布了 wolf_kill 死亡"统计
  let wolfKillHits = 0;
  for (const [day, causes] of dayDeaths) {
    if (causes.includes('wolf_kill') && dayWolfKill.has(day)) wolfKillHits++;
  }

  for (const r of rows.values()) {
    // ---- 基础 ----
    const role = ROLES[r.role];
    // 平局（winner === 'draw'）：谁都不算"阵营获胜"，不给这 20 分
    const won = (game.winner === 'good' || game.winner === 'wolf') && (game.factionOf(game.player(r.seat)) === 'wolf') === (game.winner === 'wolf');
    if (won) add(r.seat, 20, '阵营获胜');
    if (r.alive) add(r.seat, 10, '存活到最后');

    // ---- 发言参与（封顶 8） ----
    if (r._speeches) add(r.seat, Math.min(8, r._speeches), `发言 ${r._speeches} 次`);

    // ---- 放逐投票准确率 ----
    let voteHits = 0;
    for (const t of r._votes) {
      const tp = game.player(t);
      if (tp && game.factionOf(tp) === 'wolf') voteHits++;
    }
    if (voteHits) add(r.seat, voteHits * 6, `投中狼 ${voteHits} 次`);

    // ---- 技能价值 ----
    if (r.role === 'seer' && r._checksHit) add(r.seat, r._checksHit * 5, `验出狼 ${r._checksHit} 次`);
    if (role.team === 'wolf' && wolfKillHits) add(r.seat, wolfKillHits * 3, `狼刀得手 ${wolfKillHits} 夜（全队共享）`);
    if (r.role === 'witch') {
      for (const e of events) {
        const d = e.data || {};
        if (e.actor !== r.seat) continue;
        if (e.type === 'witch_action' && d.antidote && d.killTarget) add(r.seat, 3, '解药救人');
        if (e.type === 'witch_action' && d.poison) {
          const tp = game.player(d.poison);
          add(r.seat, tp && game.factionOf(tp) === 'wolf' ? 10 : -10, `毒${tp && game.factionOf(tp) === 'wolf' ? '中狼' : '错人'}`);
        }
      }
    }
    if (r.role === 'hunter') {
      for (const e of events) {
        const d = e.data || {};
        if (e.type === 'shoot' && e.actor === r.seat && d.target) {
          const tp = game.player(d.target);
          add(r.seat, tp && game.factionOf(tp) === 'wolf' ? 10 : -10, `枪${tp && game.factionOf(tp) === 'wolf' ? '中狼' : '错好人'}`);
        }
      }
    }
    if (r.role === 'knight') {
      for (const e of events) {
        const d = e.data || {};
        if (e.type === 'duel' && e.actor === r.seat && d.target) {
          const tp = game.player(d.target);
          add(r.seat, tp && game.factionOf(tp) === 'wolf' ? 10 : -5, `决斗${tp && game.factionOf(tp) === 'wolf' ? '成功' : '失误'}`);
        }
      }
    }
    if (r.role === 'guard') {
      let savedNights = 0;
      for (const [day, target] of dayGuard) {
        const kill = dayWolfKill.get(day);
        const deaths = dayDeaths.get(day) || [];
        if (kill && kill === target && !deaths.includes('wolf_kill')) savedNights++;
      }
      if (savedNights) add(r.seat, savedNights * 5, `守刀成功 ${savedNights} 夜`);
    }
    if (r.role === 'whitewolfking') {
      for (const e of events) {
        if (e.type === 'explode' && e.actor === r.seat && e.data && e.data.target) add(r.seat, 8, '自爆带走一人');
      }
    }
    if (r.role === 'idiot') {
      if (events.some((e) => e.type === 'idiot_save' && e.data.seat === r.seat)) add(r.seat, 5, '白痴翻牌免死');
    }
  }

  const list = [...rows.values()].map((r) => ({
    seat: r.seat, name: r.name, role: r.role, team: r.team, alive: r.alive,
    score: r.score, details: r.details,
  }));
  list.sort((a, b) => b.score - a.score);
  const mvp = list[0] || null;
  return { rows: list, mvp, title: mvp ? `本局 MVP：${mvp.seat}号 ${mvp.name}（${ROLES[mvp.role].name}，${mvp.score} 分）` : '' };
}

module.exports = { computeScores };
