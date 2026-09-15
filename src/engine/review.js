/**
 * review.js — 局后复盘的事实抽取（AI 教练的事实层，P2-4）
 *
 * 分层理由：**事实由确定性代码算，AI 只负责把事实讲成人话**。
 *  ① 可测：不需要任何 LLM 就能断言"第 2 天你投了 5 号，5 号是狼"；
 *  ② 不会编：模型手里只有实测出来的日子/座位/角色，没有"记错局势"的空间；
 *  ③ 省钱：事实层零成本，只有最后成文才花一次调用（单 key 单并发下这点很重要）。
 *
 * 纯函数、无 IO、无 AI 依赖（engine 层不得反向依赖 ai 层，见 scripts/lint.js）。
 */
'use strict';
const { ROLES } = require('./roles');
const { computeScores } = require('./score');

const teamOf = (game, seat) => {
  const p = game.player(seat);
  return p && p.role && ROLES[p.role] ? ROLES[p.role].team : null;
};
const roleName = (role) => (role && ROLES[role] ? ROLES[role].name : role || '未知');
const nameOf = (game, seat) => {
  const p = game.player(seat);
  return p ? p.name : `${seat}号`;
};

/** 死亡台账（P1-6 引入）：比从事件流反推更完整（放逐不一定发 deaths 事件） */
function deathInfo(game, seat) {
  const p = game.player(seat);
  if (!p) return null;
  return { day: p.deathDay || null, cause: p.deathCause || null, alive: !!p.alive };
}

const CAUSE_CN = {
  wolf_kill: '被狼刀', vote_out: '被放逐', poison: '被女巫毒', shot: '被开枪带走', explode_self: '自爆', duel: '决斗出局',
};
const causeCn = (c) => CAUSE_CN[c] || c || '出局';

/**
 * 抽取人类座位（seat）的复盘事实。
 * 对局结束后角色已公开，因此这里可以放心使用真实阵营做"事后视角"的判定。
 */
function reviewFacts(game, seat) {
  const me = game.player(seat);
  if (!me) return null;
  const myTeam = teamOf(game, seat);
  const events = game.events || [];
  const scores = computeScores(game);
  const myRow = scores.rows.find((r) => r.seat === seat) || null;

  // 每天放逐了谁、什么阵营：用死亡台账（放逐不一定有 deaths 事件）
  const exiles = [];
  for (const p of game.players) {
    if (p.deathCause === 'vote_out' && p.deathDay) {
      exiles.push({ day: p.deathDay, seat: p.seat, name: p.name, role: p.role, team: teamOf(game, p.seat) });
    }
  }
  const exileOfDay = new Map(exiles.map((e) => [e.day, e]));
  // 当晚狼刀是否得手（守刀/解药是否生效都靠它判断）
  const killedByWolfOn = (day) => game.players.some((p) => p.deathCause === 'wolf_kill' && p.deathDay === day);
  // 当晚狼刀目标（守卫"挡刀"必须同时满足"刀的就是我守的人"且"当晚没人被刀死"）
  const wolfKillTargetOn = new Map();
  for (const e of events) {
    if (e.type === 'wolf_kill' && e.data && e.data.target) wolfKillTargetOn.set(e.day, e.data.target);
  }

  // ---- 我的放逐投票（用公开的 vote_reveal，而不是私密 vote_cast：口径与观众看到的一致）----
  // 注意 target=0 是"没投票"（弃票 / 落选警长当天不能投 / 已出局）——这本身是有意义的事实，
  // 不能当噪声丢掉：只报"投了谁"，会把"那一轮我根本没投"这段如实记录漏掉。
  const votes = [];
  for (const e of events) {
    if (e.type !== 'vote_reveal' || !e.data || !Array.isArray(e.data.votes)) continue;
    const mine = e.data.votes.find((v) => v.seat === seat);
    if (!mine) continue;
    const abstained = !mine.target;
    const tTeam = abstained ? null : teamOf(game, mine.target);
    const ex = exileOfDay.get(e.day) || null;
    votes.push({
      day: e.day,
      stage: e.phase === 'pk' ? 'PK 轮' : e.phase === 'sheriff' ? '警长竞选' : '放逐投票',
      abstained,
      target: mine.target || 0,
      targetName: abstained ? null : nameOf(game, mine.target),
      targetRole: abstained ? null : (game.player(mine.target) || {}).role,
      targetTeam: tTeam,
      hitWolf: tTeam === 'wolf',
      exiledSeat: ex ? ex.seat : null,
      exiledWasMyTarget: !!(ex && !abstained && ex.seat === mine.target),
    });
  }

  // ---- 发言 ----
  const speechesByDay = {};
  let speeches = 0;
  for (const e of events) {
    if (e.type === 'speech' && e.actor === seat && e.data && e.data.context === 'day') {
      speeches++;
      speechesByDay[e.day] = (speechesByDay[e.day] || 0) + 1;
    }
  }

  // ---- 我的技能动作（按我的角色取）----
  const checks = [];
  const witchActs = [];
  const guards = [];
  const myKills = [];
  const shots = [];
  const duels = [];
  const explodes = [];
  for (const e of events) {
    const d = e.data || {};
    if (e.type === 'seer_check' && e.actor === seat && d.target) {
      checks.push({ day: e.day, target: d.target, targetName: nameOf(game, d.target), isWolf: !!d.isWolf, targetRole: (game.player(d.target) || {}).role });
    } else if (e.type === 'witch_action' && e.actor === seat) {
      const poison = d.poison || 0;
      witchActs.push({
        day: e.day,
        antidote: !!d.antidote,
        savedSeat: d.antidote ? (d.killTarget || null) : null,
        savedName: d.antidote && d.killTarget ? nameOf(game, d.killTarget) : null,
        poisonSeat: poison || null,
        poisonName: poison ? nameOf(game, poison) : null,
        poisonTeam: poison ? teamOf(game, poison) : null,
      });
    } else if (e.type === 'night_guard' && e.actor === seat) {
      const t = d.target || 0;
      // 挡刀 = 狼刀恰好砍在我守的人身上，且当晚没人被刀死
      const blocked = !!t && wolfKillTargetOn.get(e.day) === t && !killedByWolfOn(e.day);
      guards.push({ day: e.day, target: t || null, targetName: t ? nameOf(game, t) : null, blockedKill: blocked });
    } else if (e.type === 'wolf_kill' && myTeam === 'wolf' && d.target) {
      // 注意括号：`!!(x) === 'wolf_kill'` 会先算 `!!x` 再和字符串比，恒为 false（曾因此把每次得手都写成"被挡"）
      const victim = game.player(d.target) || {};
      myKills.push({
        day: e.day,
        target: d.target,
        targetName: nameOf(game, d.target),
        targetRole: victim.role,
        succeeded: victim.deathCause === 'wolf_kill' && victim.deathDay === e.day,
      });
    } else if (e.type === 'shoot' && e.actor === seat && d.target) {
      shots.push({ day: e.day, target: d.target, targetName: nameOf(game, d.target), targetTeam: teamOf(game, d.target), hitWolf: teamOf(game, d.target) === 'wolf' });
    } else if (e.type === 'duel' && e.actor === seat && d.target) {
      duels.push({ day: e.day, target: d.target, targetName: nameOf(game, d.target), targetTeam: teamOf(game, d.target), hitWolf: teamOf(game, d.target) === 'wolf' });
    } else if (e.type === 'explode' && e.actor === seat) {
      explodes.push({ day: e.day, target: d.target || null, targetName: d.target ? nameOf(game, d.target) : null });
    }
  }

  // ---- 警长 ----
  let sheriff = { ran: false, elected: false, day: null };
  for (const e of events) {
    if (e.type === 'sheriff_run' && e.actor === seat) sheriff = { ...sheriff, ran: !!e.data.run, day: e.day };
    if (e.type === 'sheriff_elected' && e.data && e.data.seat === seat) sheriff = { ...sheriff, elected: true, day: e.day };
  }

  // ---- 事后视角的得与失（给模型做锚点，避免它泛泛而谈）----
  //
  // 关键：利弊必须**按我自己所属阵营**判定，不能一律"投中狼=好"。
  // 对狼人来说，把好人投出去才符合阵营利益；投中队友往往是卖队友（也可能是为藏身份的倒钩），
  // 这种语义模糊的情形单列到 notes，不硬判成亮点或失误 —— 教练讲错了比不讲更伤信任。
  const helpsMe = (t) => (t === 'wolf') !== (myTeam === 'wolf'); // 目标是敌方 → 对我有利
  const iAmWolf = myTeam === 'wolf';
  const allyCn = (t) => (t === 'wolf' ? '狼人' : '好人');
  const missteps = [];
  const highlights = [];
  const notes = [];
  for (const v of votes) {
    const where = `第${v.day}天${v.stage}投给 ${v.target}号${v.targetName}（${roleName(v.targetRole)}）`;
    if (v.abstained) {
      // 没投票不是"决策失误"，但要如实写出来（多半是落选警长当天不能投，或已出局）
      notes.push(`第${v.day}天${v.stage}：没有投票（弃票、失去投票权或已出局）`);
      continue;
    }
    if (helpsMe(v.targetTeam)) {
      highlights.push(iAmWolf ? `${where} —— 把${allyCn(v.targetTeam)}投了出去，符合狼队利益` : `${where} —— 投中狼人`);
    } else if (v.target === seat) {
      notes.push(`${where} —— 投给了自己`);
    } else if (iAmWolf) {
      notes.push(`${where} —— 投了自己队友${v.exiledWasMyTarget ? '，且当天被放逐的就是他' : ''}（若是为藏身份的倒钩，可能是有意为之）`);
    } else {
      missteps.push(`${where} —— 投到了好人${v.exiledWasMyTarget ? '，且当天被放逐的就是他' : ''}`);
    }
  }
  for (const c of checks) {
    const where = `第${c.day}夜查验 ${c.target}号${c.targetName}（${roleName(c.targetRole)}）`;
    // 查验不是失误：事前不可能知道结果；只有"没验到狼"这个事实值得说
    if (c.isWolf) highlights.push(`${where} —— 验出狼人`);
    else notes.push(`${where} —— 不是狼（好人/金水）`);
  }
  for (const w of witchActs) {
    if (w.antidote && w.savedSeat) {
      const savedTeam = teamOf(game, w.savedSeat);
      const where = `第${w.day}夜用解药救下 ${w.savedSeat}号${w.savedName}（${roleName((game.player(w.savedSeat) || {}).role)}）`;
      if (helpsMe(savedTeam)) highlights.push(where);
      else missteps.push(`${where} —— 救的是敌方（狼人）`);
    }
    if (w.poisonSeat) {
      const where = `第${w.day}夜毒杀 ${w.poisonSeat}号${w.poisonName}（${roleName((game.player(w.poisonSeat) || {}).role)}）`;
      if (helpsMe(w.poisonTeam)) highlights.push(`${where} —— 毒中狼人`); else missteps.push(`${where} —— 毒到了好人`);
    }
  }
  for (const gd of guards) {
    const where = `第${gd.day}夜守护 ${gd.target}号${gd.targetName}`;
    if (gd.blockedKill) highlights.push(`${where} —— 挡下了狼刀`);
    else if (gd.target) notes.push(`${where} —— 当晚狼刀不在他身上`);
  }
  for (const k of myKills) {
    const where = `第${k.day}夜狼队刀 ${k.target}号${k.targetName}（${roleName(k.targetRole)}）`;
    if (k.succeeded) highlights.push(`${where} —— 得手`);
    else notes.push(`${where} —— 被解药或守护挡下`);
  }
  for (const s of shots) {
    const where = `第${s.day}天开枪带走 ${s.target}号${s.targetName}（${roleName((game.player(s.target) || {}).role)}）`;
    if (helpsMe(s.targetTeam)) highlights.push(`${where} —— 打中狼人`); else missteps.push(`${where} —— 打到了好人`);
  }
  for (const d of duels) {
    const where = `第${d.day}天决斗 ${d.target}号${d.targetName}（${roleName((game.player(d.target) || {}).role)}）`;
    if (helpsMe(d.targetTeam)) highlights.push(`${where} —— 挑中狼人`); else missteps.push(`${where} —— 挑到了好人`);
  }
  for (const x of explodes) {
    notes.push(`第${x.day}天自爆${x.target ? `并带走 ${x.target}号${x.targetName}` : ''}`);
  }

  // ---- 全局转折点（与"我"无关也要给，模型才有局势感）----
  const turningPoints = [];
  for (const ex of exiles) {
    turningPoints.push(`第${ex.day}天放逐 ${ex.seat}号${ex.name}（${roleName(ex.role)}${ex.team === 'wolf' ? '，狼人' : '，好人'}）`);
  }
  for (const p of game.players) {
    if (p.deathCause === 'wolf_kill' && p.deathDay) turningPoints.push(`第${p.deathDay}夜 ${p.seat}号${p.name}（${roleName(p.role)}）${causeCn(p.deathCause)}`);
  }
  turningPoints.sort((a, b) => (parseInt(a.slice(1), 10) || 0) - (parseInt(b.slice(1), 10) || 0));

  const death = deathInfo(game, seat);
  return {
    gameId: game.id,
    finished: !!game.finished,
    winner: game.winner || null,
    winReason: game.winReason || null,
    days: game.day || 0,
    seat,
    name: me.name,
    role: me.role,
    roleName: roleName(me.role),
    team: myTeam,
    teamCn: myTeam === 'wolf' ? '狼人阵营' : myTeam === 'god' ? '神职阵营' : '村民阵营',
    won: !!game.winner && (myTeam === 'wolf') === (game.winner === 'wolf'),
    death,
    deathDesc: death.alive ? '存活到最后' : `第${death.day}天${causeCn(death.cause)}`,
    score: myRow ? { total: myRow.score, details: myRow.details } : null,
    mvp: scores.mvp ? { seat: scores.mvp.seat, name: scores.mvp.name, role: scores.mvp.role, roleName: roleName(scores.mvp.role), score: scores.mvp.score } : null,
    speeches,
    speechesByDay,
    sheriff,
    votes,
    checks,
    witchActs,
    guards,
    kills: myKills,
    shots,
    duels,
    explodes,
    missteps,
    highlights,
    notes,
    exiles,
    turningPoints: turningPoints.slice(0, 24),
  };
}

/** 全局唯一的人类座位（单人对局的教练对象）；找不到返回 null */
function humanSeatOf(game) {
  const p = (game.players || []).find((x) => x.isHuman);
  return p ? p.seat : null;
}

module.exports = { reviewFacts, humanSeatOf, roleName, causeCn, CAUSE_CN };
