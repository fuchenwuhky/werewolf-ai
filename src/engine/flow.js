/**
 * flow.js — 对局流程状态机（夜晚/警长竞选/天亮/发言/投票/结算）
 * 规则依据：docs/rules.md。所有玩家输入统一走 askValidated（人类挂起等待、AI 校验重试+降级）。
 */
'use strict';
const { ROLES } = require('./roles');

// ---------- 输入校验（人类与 AI 共用同一套） ----------
function validatePayload(task, payload, req, game, seat) {
  const p = game.player(seat);
  const alive = game.aliveSeats();
  const cand = req.candidates || [];
  const inCand = (t) => Number.isInteger(t) && cand.includes(t);
  const noneOk = !!req.allowNone;
  payload = payload && typeof payload === 'object' ? payload : {};
  const fail = (error) => ({ ok: false, error });
  const asInt = (v) => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };

  switch (task) {
    case 'speech':
    case 'sheriff_speech': {
      const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, 600) : '';
      if (!text) return fail('发言内容不能为空');
      const value = { text, explode: false, target: 0, withdraw: false };
      if (payload.explode) {
        if (!req.canExplode) return fail('当前不能自爆');
        if (!game.rules.allowSelfExplode) return fail('本局规则不允许自爆');
        value.explode = true;
        if (p.role === 'whitewolfking') {
          const t = asInt(payload.target);
          if (!inCand(t)) return fail('白狼王自爆必须选择一名带走的目标');
          value.target = t;
        }
      }
      if (task === 'sheriff_speech') value.withdraw = !!payload.withdraw;
      return { ok: true, value };
    }
    case 'lastwords':
    case 'pk_speech':
    case 'wolf_propose': {
      const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, 600) : '';
      if (!text) return fail('内容不能为空');
      return { ok: true, value: { text } };
    }
    case 'wolf_chat': {
      // 狼队讨论：发言必填，可带刀口建议（0 = 建议空刀）
      const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, 600) : '';
      if (!text) return fail('讨论发言不能为空');
      let target = 0;
      const raw = payload.target;
      if (raw !== undefined && raw !== null && raw !== 0 && raw !== '0') {
        const t = asInt(raw);
        if (!inCand(t)) return fail('建议的刀口目标不合法');
        target = t;
      } else if (!req.allowNone) {
        return fail('本局不允许空刀，请给出一名建议目标');
      }
      return { ok: true, value: { text, target } };
    }
    case 'duel_check': {
      const value = { duel: !!payload.duel, target: 0 };
      if (value.duel) {
        const t = asInt(payload.target);
        if (!Number.isInteger(t) || t === seat || !alive.includes(t)) return fail('决斗目标不合法（需一名存活的其他玩家）');
        value.target = t;
      }
      return { ok: true, value };
    }
    case 'explode_check': {
      const value = { explode: !!payload.explode, target: 0 };
      if (value.explode && p.role === 'whitewolfking') {
        const t = asInt(payload.target);
        if (!Number.isInteger(t) || t === seat || !alive.includes(t)) return fail('白狼王自爆必须带走一名存活的其他玩家');
        value.target = t;
      }
      return { ok: true, value };
    }
    case 'wolf_say': {
      // 轮到人类狼发言：可发一言，也可空手跳过
      const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, 600) : '';
      return { ok: true, value: { text, skipped: !text } };
    }
    case 'night_guard':
    case 'wolf_kill':
    case 'vote':
    case 'pk_vote':
    case 'sheriff_vote': {
      if (payload.abstain) payload.target = 0;
      const raw = payload.target;
      const t = asInt(raw);
      if (raw === undefined || raw === null || !Number.isInteger(t)) return fail('缺少目标（需要 target 字段）');
      if (t === 0) {
        if (!noneOk) return fail('不能弃票/空过，必须选择一名目标');
        return { ok: true, value: { target: 0 } };
      }
      if (!inCand(t)) return fail('目标不合法');
      return { ok: true, value: { target: t } };
    }
    case 'seer_check': {
      const t = asInt(payload.target);
      if (!inCand(t)) return fail('查验目标不合法');
      if (t === seat) return fail('不能查验自己');
      return { ok: true, value: { target: t } };
    }
    // 摄梦/诅咒/魅惑/暗恋：必须从候选中选一名（候选已排除自己），不允许空过
    case 'night_dream':
    case 'crow_curse':
    case 'wolfbeauty_charm':
    case 'admirer_crush': {
      const t = asInt(payload.target);
      if (!Number.isInteger(t)) return fail('缺少目标（需要 target 字段）');
      if (!inCand(t)) return fail('目标不合法');
      if (t === seat) return fail('不能选择自己');
      return { ok: true, value: { target: t } };
    }
    case 'witch': {
      const ex = req.extra || {};
      const value = { antidote: false, poison: 0 };
      if (payload.antidote) {
        if (!ex.canAntidote) return fail('解药不可用（已用完或今晚无人被袭击）');
        value.antidote = true;
      }
      const poison = asInt(payload.poison || 0);
      if (Number.isInteger(poison) && poison > 0) {
        if (!ex.canPoison) return fail('毒药已用完');
        if (!alive.includes(poison)) return fail('毒药目标不合法');
        value.poison = poison;
      }
      if (value.antidote && value.poison) return fail('每晚最多使用一瓶药');
      if (value.antidote && ex.killTarget === seat && !ex.selfSaveAllowed) return fail('本局规则不允许女巫自救');
      return { ok: true, value };
    }
    case 'sheriff_run':
      return { ok: true, value: { run: !!payload.run } };
    case 'badge_pass': {
      const t = asInt(payload.target || 0);
      if (!Number.isInteger(t) || t === 0) return { ok: true, value: { target: 0 } };
      if (!alive.includes(t)) return fail('警徽只能移交给存活玩家');
      return { ok: true, value: { target: t } };
    }
    case 'direction': {
      if (payload.direction !== 'cw' && payload.direction !== 'ccw') return fail('方向必须是 cw（顺时针）或 ccw（逆时针）');
      return { ok: true, value: { direction: payload.direction } };
    }
    case 'shoot': {
      const t = asInt(payload.target || 0);
      if (!Number.isInteger(t) || t === 0) return { ok: true, value: { target: 0 } };
      if (!alive.includes(t)) return fail('开枪目标不合法');
      return { ok: true, value: { target: t } };
    }
    default:
      return fail('未知任务 ' + task);
  }
}

// ---------- 通用询问（人类挂起 / AI 校验重试 + 降级） ----------
async function askValidated(game, seat, req, { fallback, maxRetries = 2 } = {}) {
  const p = game.player(seat);
  if (p.isHuman) {
    return game.ask(seat, req); // resolveHuman 内已用同一 validatePayload 校验
  }
  let note = '';
  for (let i = 0; i <= maxRetries; i++) {
    const request = note ? { ...req, _retryNote: note } : req;
    const raw = await game.ask(seat, request);
    const v = validatePayload(req.task, raw, req, game, seat);
    if (v.ok) return v.value;
    note = `你上一次的输出不合法（${v.error}），请严格按照要求的 JSON 格式重新输出。`;
    game.logger.warn('ai', `${seat}号 ${req.task} 输出不合法：${JSON.stringify(raw).slice(0, 200)} — ${v.error}`);
  }
  game.logger.warn('ai', `${seat}号 ${req.task} 多次输出不合法，使用降级方案`);
  game.emit('llm_error', { actor: seat, visibleTo: 'god', data: { task: req.task, message: '多次输出不合法，已降级处理' } });
  return fallback ? fallback() : null;
}

const fb = (fn) => ({ fallback: fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NIGHT_STEP_LABEL = {
  admirer: '暗恋者行动', guard: '守卫行动', dreamer: '摄梦人行动', wolf: '狼人行动',
  wolfbeauty: '狼美人行动', seer: '预言家行动', witch: '女巫行动', crow: '乌鸦行动',
};

/** 狼美人殉情触发死因：毒/放逐/枪/摄梦系死亡触发连带；骑士决斗（duel_win）不触发 */
const CHARM_TRIGGER_CAUSES = ['poison', 'vote_out', 'shot', 'dream', 'dream_follow'];

// ---------- 小工具 ----------
function wolfVis(game) { return game.nightWolves().map((p) => p.seat); }

function randomOf(arr, rnd = Math.random) { return arr[Math.floor(rnd() * arr.length)]; }

/** 从 anchor 的下家开始，沿 dir(+1顺/-1逆) 环绕存活座位 */
function buildSpeechOrder(game, anchor, dir, sheriffLast) {
  const alive = game.aliveSeats();
  if (!alive.length) return [];
  let pos = alive.indexOf(anchor);
  if (pos === -1) pos = dir === 1 ? -1 : 0;
  const n = alive.length;
  const order = [];
  for (let i = 1; i <= n; i++) order.push(alive[(((pos + dir * i) % n) + n) % n]);
  if (sheriffLast) {
    const sh = game.sheriff();
    if (sh && sh.alive) {
      const i = order.indexOf(sh.seat);
      if (i !== -1) { order.splice(i, 1); order.push(sh.seat); }
    }
  }
  return order;
}

function setWinner(game, w) {
  if (!game.winner) { game.winner = w.winner; game.winReason = w.reason; game._lastWin = w; }
}

function checkEnd(game) {
  const w = game.checkWin();
  if (w) setWinner(game, w);
  return !!w;
}

/** 夜晚死亡尚未公布时预判胜负（如毒死最后一狼） */
function checkWinWithPending(game) {
  const dead = new Set(game.pendingDeaths.map((d) => d.seat));
  const alive = game.alivePlayers().filter((p) => !dead.has(p.seat));
  const wolves = alive.filter((p) => game.categoryOf(p) === 'wolf');
  if (wolves.length === 0) return { winner: 'good', reason: '所有狼人已出局，好人阵营获胜！' };
  const gods = alive.filter((p) => game.categoryOf(p) === 'god');
  const villagers = alive.filter((p) => game.categoryOf(p) === 'villager');
  if (gods.length === 0) return { winner: 'wolf', reason: '所有神职出局，狼人屠边成功！' };
  if (villagers.length === 0) return { winner: 'wolf', reason: '所有平民出局，狼人屠边成功！' };
  return null;
}

// ---------- 死亡结算 ----------
async function settleDeath(game, seat, cause, opts = {}) {
  const p = game.player(seat);
  if (!p.alive) return;
  p.alive = false;
  // 翻牌
  if (game.rules.revealOnDeath) {
    p.revealed = true;
    game.emit('role_reveal', { actor: seat, data: { seat, role: p.role } });
  } else {
    game.emit('role_reveal', { actor: seat, visibleTo: [seat], data: { seat, role: p.role } });
  }
  // 遗言
  let lw = false;
  if (cause === 'wolf_kill' || cause === 'poison') lw = !!opts.firstNight && game.rules.lastWords.night1;
  else if (cause === 'vote_out') lw = game.rules.lastWords.exiled;
  else if (cause === 'shot' || cause === 'explode_target') lw = game.rules.lastWords.shotVictim;
  else if (cause === 'explode_self') lw = game.rules.allowSelfExplode && game.rules.explodeLastWords === 'firstDay' && !!opts.firstDay;
  if (lw) {
    const req = { task: 'lastwords', _allowDead: true };
    const v = await askValidated(game, seat, req, fb(() => ({ text: '' })));
    if (v && v.text) game.emit('speech', { actor: seat, data: { text: v.text, context: 'lastwords' } });
  }
  // 警徽
  if (p.isSheriff) await badgeResolve(game, seat);
  // 开枪触发
  const trig = ROLES[p.role].deathTrigger;
  if (trig && trig.shoot && trig.on.includes(cause)) {
    game._shots.push(seat);
    game.logger.info('engine', `${seat}号(${ROLES[p.role].name}) 因 ${cause} 触发开枪技能`);
  }
  // 狼美人殉情链：她被毒/放逐/枪/摄梦系带走时，被魅惑者殉情出局（骑士决斗死不触发，魅惑作废）
  if (p.role === 'wolfbeauty') {
    const ts = game.charmMap[seat];
    delete game.charmMap[seat];
    if (ts != null && CHARM_TRIGGER_CAUSES.includes(cause)) {
      const tp = game.player(ts);
      if (tp && tp.alive) {
        game.logger.info('engine', `${ts}号 因狼美人（${seat}号）出局而殉情`);
        await settleDeath(game, ts, 'charm_follow', {});
      }
    }
  }
}

async function badgeResolve(game, seat) {
  const p = game.player(seat);
  p.isSheriff = false;
  const aliveOthers = game.aliveSeats();
  if (!aliveOthers.length) { game.emit('badge_pass', { actor: seat, data: { to: 0 } }); return; }
  const v = await askValidated(game, seat, { task: 'badge_pass', _allowDead: true }, fb(() => ({ target: 0 })));
  if (v && v.target && game.player(v.target).alive) {
    game.player(v.target).isSheriff = true;
    game.emit('badge_pass', { actor: seat, data: { to: v.target } });
  } else {
    game.emit('badge_pass', { actor: seat, data: { to: 0 } });
  }
}

async function processShots(game) {
  while (game._shots && game._shots.length) {
    if (checkEnd(game)) return;
    const seat = game._shots.shift();
    if (!game.player(seat)) continue;
    const v = await askValidated(game, seat, { task: 'shoot', _allowDead: true }, fb(() => ({ target: 0 })));
    game.emit('shoot', { actor: seat, data: { target: v ? v.target : 0 } });
    if (v && v.target) await settleDeath(game, v.target, 'shot', {});
  }
}

// ---------- 夜晚 ----------
async function nightPhase(game) {
  game.day++;
  game.phase = 'night';
  game.night = { guardActions: [], dreamActions: [], charmActions: [], curses: [], wolfKill: 0, saved: false, poisonTargets: [] };
  game.activeCurse = []; // 乌鸦诅咒只在"次日的放逐投票"生效，新的一夜先清空
  game.emit('phase', { data: { title: `第${game.day}夜 · 天黑请闭眼` } });
  // 固定全步骤播报（防信息泄露）：角色已死也播报该步骤；板子里不存在的角色不播；暗恋者仅首夜行动
  const activeSteps = game.rules.nightOrder.filter((s) => {
    if (s === 'wolf') return game.wolves().length > 0;
    if (s === 'admirer') return game.day === 1 && (game.board.admirer || 0) > 0;
    return (game.board[s] || 0) > 0;
  });
  let idx = 0;
  for (const step of game.rules.nightOrder) {
    if (!activeSteps.includes(step)) continue;
    idx++;
    game.emit('night_step', { data: { step, label: NIGHT_STEP_LABEL[step] || step, index: idx, total: activeSteps.length } });
    if (step === 'admirer') await admirerStep(game);
    else if (step === 'guard') await guardStep(game);
    else if (step === 'dreamer') await dreamerStep(game);
    else if (step === 'wolf') await wolfStep(game);
    else if (step === 'wolfbeauty') await wolfbeautyStep(game);
    else if (step === 'seer') await seerStep(game);
    else if (step === 'witch') await witchStep(game);
    else if (step === 'crow') await crowStep(game);
    // 该角色已全员出局时步骤会"秒过"，加固定停顿避免时长推断
    const hasAliveActor = step === 'wolf'
      ? game.nightWolves().length > 0
      : game.aliveOfRole(step).length > 0;
    if (!hasAliveActor) await sleep(game.stepPauseMs != null ? game.stepPauseMs : 2000);
  }
  resolveNightDeaths(game);
}

/** 暗恋者：仅首夜最先行动，暗选一名暗恋对象（胜负阵营终身绑定） */
async function admirerStep(game) {
  if (game.day !== 1) return;
  for (const a of game.aliveOfRole('admirer')) {
    const candidates = game.aliveSeats().filter((x) => x !== a.seat);
    if (!candidates.length) continue;
    const v = await askValidated(game, a.seat, { task: 'admirer_crush', candidates }, fb(() => ({ target: candidates[0] })));
    game.crush[a.seat] = v.target;
    game.emit('admirer_crush', { actor: a.seat, visibleTo: [a.seat], data: { target: v.target } });
  }
}

async function guardStep(game) {
  const guards = game.aliveOfRole('guard');
  for (const g of guards) {
    let candidates = game.aliveSeats();
    if (game.rules.guardNoRepeat && game.lastProtectMap && game.lastProtectMap[g.seat]) {
      candidates = candidates.filter((s) => s !== game.lastProtectMap[g.seat]);
    }
    const v = await askValidated(game, g.seat, { task: 'night_guard', candidates, allowNone: true }, fb(() => ({ target: 0 })));
    game.night.guardActions.push({ seat: g.seat, target: v.target });
    game.lastProtectMap = game.lastProtectMap || {};
    if (v.target) game.lastProtectMap[g.seat] = v.target; else delete game.lastProtectMap[g.seat];
    game.emit('night_guard', { actor: g.seat, visibleTo: [g.seat], data: { target: v.target } });
  }
}

/** 摄梦人：每晚必须摄梦一人（不能自摄）。结算规则见 resolveNightDeaths */
async function dreamerStep(game) {
  for (const d of game.aliveOfRole('dreamer')) {
    const candidates = game.aliveSeats().filter((x) => x !== d.seat);
    if (!candidates.length) continue;
    const v = await askValidated(game, d.seat, { task: 'night_dream', candidates }, fb(() => ({ target: candidates[0] })));
    const consecutive = !!(game.lastDreamMap && game.lastDreamMap[d.seat] === v.target);
    game.night.dreamActions.push({ seat: d.seat, target: v.target });
    game.emit('night_dream', { actor: d.seat, visibleTo: [d.seat], data: { target: v.target, consecutive } });
  }
}

/** 狼美人：每晚魅惑一人（不能是自己或狼队成员）。殉情结算在 settleDeath */
async function wolfbeautyStep(game) {
  for (const w of game.aliveOfRole('wolfbeauty')) {
    const candidates = game.aliveSeats().filter((x) => {
      if (x === w.seat) return false;
      return ROLES[game.player(x).role].category !== 'wolf';
    });
    if (!candidates.length) continue;
    const v = await askValidated(game, w.seat, { task: 'wolfbeauty_charm', candidates }, fb(() => ({ target: candidates[0] })));
    game.night.charmActions.push({ seat: w.seat, target: v.target });
    game.emit('wolfbeauty_charm', { actor: w.seat, visibleTo: [w.seat], data: { target: v.target } });
  }
}

/** 乌鸦：每晚诅咒一人（不能自咒），次日其放逐投票 +0.5 票 */
async function crowStep(game) {
  for (const c of game.aliveOfRole('crow')) {
    const candidates = game.aliveSeats().filter((x) => x !== c.seat);
    if (!candidates.length) continue;
    const v = await askValidated(game, c.seat, { task: 'crow_curse', candidates }, fb(() => ({ target: candidates[0] })));
    game.night.curses.push({ seat: c.seat, target: v.target });
    game.emit('crow_curse', { actor: c.seat, visibleTo: [c.seat], data: { target: v.target } });
  }
}

async function wolfStep(game) {
  const wolves = game.nightWolves(); // 隐狼夜里不睁眼，不参与讨论与刀口
  if (!wolves.length) return;
  const vis = wolfVis(game);
  const prey = game.alivePlayers().filter((p) => ROLES[p.role].category !== 'wolf').map((p) => p.seat);
  if (!prey.length) return;
  const allowNone = game.rules.allowEmptyKill;

  // ---------- 狼队频道讨论 ----------
  // 每轮按座位顺序轮流发言：AI 狼给出建议刀口+理由；轮到人类狼时可发言或跳过。
  // 另可随时插话（队列）、+1 轮（立即生效）、提前结束讨论进入投刀。
  if (wolves.length > 1) {
    const baseRounds = game.rules.wolfChatRounds != null ? game.rules.wolfChatRounds : 2;
    game.wolfTalk = { active: true, round: 0, rounds: baseRounds, endNow: false, queue: [] };
    const flushHuman = () => {
      if (!game.wolfTalk.queue.length) return;
      for (const m of game.wolfTalk.queue.splice(0)) {
        game.emit('wolf_propose', { actor: m.seat, visibleTo: vis, data: { text: m.text, target: 0, human: true } });
      }
    };
    flushHuman();
    for (let r = 0; r < game.wolfTalk.rounds && !game.wolfTalk.endNow; r++) {
      game.wolfTalk.round = r + 1;
      game.emit('system', { visibleTo: vis, text: `狼队讨论：第 ${game.wolfTalk.round}/${game.wolfTalk.rounds} 轮（按座位顺序发言）` });
      flushHuman();
      for (const w of wolves) {
        if (!w.alive) continue;
        if (game.wolfTalk.endNow) break;
        if (w.isHuman) {
          // 轮到玩家：发言或跳过（无限时）
          const v = await askValidated(game, w.seat, { task: 'wolf_say' }, fb(() => ({ text: '', skipped: true })));
          if (v && v.text) {
            game.emit('wolf_propose', { actor: w.seat, visibleTo: vis, data: { text: v.text, target: 0, human: true } });
          } else {
            game.emit('system', { visibleTo: vis, text: `${w.seat}号（你）本轮选择不发话。` });
          }
        } else {
          const req = { task: 'wolf_chat', candidates: prey, allowNone };
          const v = await askValidated(game, w.seat, req, fb(() => ({ text: '', target: 0 })));
          if (v && v.text) {
            game.emit('wolf_propose', { actor: w.seat, visibleTo: vis, data: { text: v.text, target: v.target || 0 } });
          }
        }
        flushHuman();
      }
    }
    flushHuman();
    game.wolfTalk.active = false;
  }

  // ---------- 投刀（多数决，平票随机；人类狼的投票界面在收票开始时就绪，AI 逐个思考） ----------
  const killReq = { task: 'wolf_kill', candidates: prey, allowNone };
  const humanWolf = wolves.find((w) => w.isHuman);
  const humanJob = humanWolf
    ? game.ask(humanWolf.seat, killReq).then(
        (v) => ({ ok: true, v }),
        (err) => ({ ok: false, err }),
      )
    : null;
  const votes = [];
  for (const w of wolves) {
    if (w.isHuman) continue;
    const v = await askValidated(game, w.seat, killReq, fb(() => ({ target: allowNone ? 0 : prey[0] })));
    votes.push({ seat: w.seat, target: v.target });
    game.emit('wolf_kill_vote', { actor: w.seat, visibleTo: vis, data: { target: v.target } });
  }
  if (humanJob) {
    const r = await humanJob;
    if (!r.ok) {
      if (r.err && r.err.code === 'FORCE_ENDED') throw r.err;
      r.v = { target: 0 };
    }
    votes.push({ seat: humanWolf.seat, target: r.v.target });
    game.emit('wolf_kill_vote', { actor: humanWolf.seat, visibleTo: vis, data: { target: r.v.target } });
  }
  const tally = {};
  for (const v of votes) if (v.target) tally[v.target] = (tally[v.target] || 0) + 1;
  let final = 0;
  const entries = Object.entries(tally);
  if (entries.length) {
    let max = 0, tops = [];
    for (const [t, n] of entries) {
      if (n > max) { max = n; tops = [Number(t)]; }
      else if (n === max) tops.push(Number(t));
    }
    final = randomOf(tops);
  }
  game.emit('wolf_kill', { visibleTo: vis, data: { target: final } });
  game.night.wolfKill = final;
}

async function seerStep(game) {
  const seers = game.aliveOfRole('seer');
  for (const s of seers) {
    const candidates = game.aliveSeats().filter((x) => x !== s.seat);
    if (!candidates.length) continue;
    const v = await askValidated(game, s.seat, { task: 'seer_check', candidates }, fb(() => ({ target: candidates[0] })));
    const target = game.player(v.target);
    // 官方特殊裁定：隐狼与暗恋者的查验结果永远是"好人"
    const isWolf = target.role !== 'hiddenwolf' && target.role !== 'admirer' && ROLES[target.role].category === 'wolf';
    game.emit('seer_check', { actor: s.seat, visibleTo: [s.seat], data: { target: v.target, isWolf } });
  }
}

async function witchStep(game) {
  const witches = game.aliveOfRole('witch');
  for (const w of witches) {
    const killTarget = game.night.wolfKill;
    const selfSaveAllowed = game.rules.witchSelfSave === 'always' ||
      (game.rules.witchSelfSave === 'firstNight' && game.day === 1) ||
      (game.rules.witchSelfSave === 'noFirstNight' && game.day !== 1);
    const canAntidote = !game.witch.antidoteUsed && killTarget > 0;
    const canPoison = !game.witch.poisonUsed;
    game.emit('witch_info', { actor: w.seat, visibleTo: [w.seat], data: { killTarget } });
    const req = { task: 'witch', extra: { killTarget, canAntidote, canPoison, selfSaveAllowed } };
    const v = await askValidated(game, w.seat, req, fb(() => ({ antidote: false, poison: 0 })));
    if (v.antidote) { game.witch.antidoteUsed = true; game.night.saved = true; }
    if (v.poison) { game.witch.poisonUsed = true; game.night.poisonTargets.push(v.poison); }
    game.emit('witch_action', {
      actor: w.seat, visibleTo: [w.seat],
      data: { antidote: v.antidote, killTarget, poison: v.poison },
    });
  }
}

function resolveNightDeaths(game) {
  const { wolfKill, saved, guardActions, poisonTargets } = game.night;
  const dreamActions = game.night.dreamActions || [];
  const charmActions = game.night.charmActions || [];
  const curses = game.night.curses || [];
  const deaths = [];
  const guarded = guardActions.some((g) => g.target === wolfKill && wolfKill > 0);
  if (wolfKill > 0) {
    if (saved && guarded) {
      // 同守同救：按开关判定
      if (game.rules.milkThrough === 'die') {
        deaths.push({ seat: wolfKill, cause: 'wolf_kill' });
      } else if (game.rules.milkThrough === 'guardDies') {
        const selfGuard = guardActions.some((g) => g.target === wolfKill && g.seat === wolfKill);
        if (selfGuard) deaths.push({ seat: wolfKill, cause: 'wolf_kill' });
      } // cancel：无人死
    } else if (!saved && !guarded) {
      deaths.push({ seat: wolfKill, cause: 'wolf_kill' });
    }
    // 被救未守 / 被守未救 → 存活
  }
  for (const pt of poisonTargets) deaths.push({ seat: pt, cause: 'poison' });

  // ---------- 摄梦结算（官方规则） ----------
  // ① 摄梦人当晚死亡 → 梦游者连带出局（不可守护、不可救治）
  // ② 摄梦人存活 → 梦游者当夜免疫狼刀与毒杀（技能视为落空，药照耗）
  // ③ 连续两晚摄梦同一人 → 梦游者死亡（女巫救不活，死因不计入猎人/狼王开枪）
  const dreamTargets = new Set(dreamActions.map((a) => a.target));
  for (const a of dreamActions) {
    const dreamerDies = deaths.some((d) => d.seat === a.seat);
    if (dreamerDies) {
      deaths.push({ seat: a.target, cause: 'dream_follow' });
      continue;
    }
    for (let i = deaths.length - 1; i >= 0; i--) {
      if (deaths[i].seat === a.target) deaths.splice(i, 1); // 夜间伤害落空
    }
    if (game.lastDreamMap && game.lastDreamMap[a.seat] === a.target) {
      deaths.push({ seat: a.target, cause: 'dream' });
    }
  }

  // 去重（同一人只死一次；毒 > 连摄死 > 其余，同座位按原因优先级保留）
  const prio = (c) => (c === 'poison' ? 0 : c === 'dream' ? 1 : 2);
  const seen = new Set();
  game.pendingDeaths = deaths
    .sort((a, b) => prio(a.cause) - prio(b.cause) || a.seat - b.seat)
    .filter((d) => { if (seen.has(d.seat)) return false; seen.add(d.seat); return true; });
  game.lastNightDeaths = game.pendingDeaths.slice();

  // ---------- 跨夜状态更新 ----------
  game.lastDreamMap = {};
  for (const a of dreamActions) game.lastDreamMap[a.seat] = a.target;
  for (const a of charmActions) game.charmMap[a.seat] = a.target; // 最新魅惑覆盖旧的
  game.activeCurse = [...new Set(curses.map((c) => c.target))];
}

// ---------- 天亮 ----------
async function dawnPhase(game) {
  game.phase = 'dawn';
  const deaths = game.pendingDeaths;
  game.pendingDeaths = [];
  game.emit('deaths', { data: { deaths } });
  const firstNight = game.day === 1;
  for (const d of deaths) {
    await settleDeath(game, d.seat, d.cause, { firstNight });
  }
  await processShots(game);
  checkEnd(game);
}

// ---------- 自爆 ----------
async function handleExplode(game, seat, v, { inElection }) {
  game.emit('explode', { actor: seat, data: { target: v.target || 0 } });
  await settleDeath(game, seat, 'explode_self', { firstDay: game.day === 1 });
  if (inElection) {
    game.swallowCount++;
    const mode = game.rules.badgeSwallow;
    if (mode === 'single' || (mode === 'double' && game.swallowCount >= 2)) {
      game.badgeSwallowed = true;
      game.emit('system', { text: '警徽被吞掉，本局不再有警长。' });
    } else {
      game.sheriffElectionPending = true;
      game.emit('system', { text: '警长竞选被打断，今日直接天黑；警徽保留，明日重新竞选。' });
    }
    if (v.target) await settleDeath(game, v.target, 'shot', {});
    await processShots(game);
    checkEnd(game);
    return 'dayEnded';
  }
  if (v.target) await settleDeath(game, v.target, 'shot', {});
  await processShots(game);
  checkEnd(game);
  return 'dayEnded';
}

/** 人类狼的“随时自爆”：API 在白天任意时刻写入 game.explodeRequest，引擎在最近的发言间隙消费 */
async function consumeExplodeRequest(game) {
  const req = game.explodeRequest;
  if (!req) return false;
  game.explodeRequest = null;
  const p = game.player(req.seat);
  if (!p || !p.alive || game.finished || !game.rules.allowSelfExplode) return false;
  if (!ROLES[p.role] || !ROLES[p.role].selfExplode) return false;
  game.logger.info('engine', `${req.seat}号 随时自爆生效（target=${req.target || 0}）`);
  await handleExplode(game, req.seat, { text: '', explode: true, target: req.target || 0 }, { inElection: false });
  return true;
}

/** 骑士决斗：决斗狼人 → 其出局并直接天黑；决斗好人 → 骑士以死谢罪，白天继续 */
async function handleDuel(game, knightSeat, target) {
  // 发动决斗 = 翻牌：骑士身份当场公开（不受翻牌规则限制，这是技能的一部分）
  const kp = game.player(knightSeat);
  kp.revealed = true;
  game.emit('role_reveal', { actor: knightSeat, data: { seat: knightSeat, role: kp.role } });
  game.emit('duel', { actor: knightSeat, data: { target } });
  const tp = game.player(target);
  if (tp && tp.alive && ROLES[tp.role].team === 'wolf') {
    await settleDeath(game, target, 'duel_win', {});
    await processShots(game);
    checkEnd(game);
    game.emit('system', { text: `⚔️ 决斗成功：${target}号 是狼人，立即出局，天黑了。` });
    return 'dayEnded';
  }
  await settleDeath(game, knightSeat, 'duel_fail', {});
  await processShots(game);
  checkEnd(game);
  game.emit('system', { text: `⚔️ 决斗失败：${target}号 是好人，骑士以死谢罪，白天继续。` });
  return 'duelFail';
}

/** 人类骑士的“随时决斗”：API 写入 game.duelRequest，引擎在最近的发言间隙消费 */
async function consumeDuelRequest(game) {
  const req = game.duelRequest;
  if (!req) return false;
  game.duelRequest = null;
  const p = game.player(req.seat);
  if (!p || !p.alive || game.finished || p.role !== 'knight') return false;
  const tp = Number.isInteger(req.target) ? game.player(req.target) : null;
  if (!tp || !tp.alive || req.target === req.seat) return false;
  game.logger.info('engine', `${req.seat}号(骑士) 随时决斗生效（target=${req.target}）`);
  return handleDuel(game, req.seat, req.target);
}

/** 白狼王/骑士：每次发言结束后按随机顺序询问是否发动白天技能（自爆/决斗） */
async function daySkillCheck(game) {
  const actors = game.alivePlayers().filter((p) => !p.isHuman && (p.role === 'whitewolfking' || p.role === 'knight'));
  for (let i = actors.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [actors[i], actors[j]] = [actors[j], actors[i]];
  }
  for (const p of actors) {
    if (game.finished || !p.alive) continue;
    if (p.role === 'whitewolfking') {
      const v = await askValidated(game, p.seat, { task: 'explode_check' }, fb(() => ({ explode: false })));
      if (v.explode) {
        await handleExplode(game, p.seat, v, { inElection: false });
        return true; // 天黑了
      }
    } else {
      const v = await askValidated(game, p.seat, { task: 'duel_check', candidates: game.aliveSeats().filter((x) => x !== p.seat) }, fb(() => ({ duel: false })));
      if (v.duel) {
        const r = await handleDuel(game, p.seat, v.target);
        if (r === 'dayEnded') return true; // 决斗成功入夜；决斗失败白天继续
      }
    }
  }
  return false;
}

// ---------- 警长竞选 ----------
async function electionPhase(game) {
  game.phase = 'sheriff';
  if (game.badgeSwallowed) return 'ok';
  game.emit('phase', { data: { title: '警长竞选' } });
  // 1. 上警报名
  const candidates = [];
  for (const p of game.alivePlayers()) {
    const v = await askValidated(game, p.seat, { task: 'sheriff_run' }, fb(() => ({ run: false })));
    if (v.run) {
      p.everRanSheriff = true;
      candidates.push(p.seat);
    }
    game.emit('sheriff_run', { actor: p.seat, data: { run: v.run } });
  }
  game.emit('system', { text: candidates.length ? `🎩 上警名单：${candidates.join('、')} 号` : '🎩 无人上警，本局没有警长。' });
  // 2. 警上演讲（可退水/自爆）
  const campaignOrder = [];
  for (const s of candidates) {
    const p = game.player(s);
    if (!p.alive) continue;
    const canExplode = game.rules.allowSelfExplode && !!ROLES[p.role].selfExplode;
    const v = await askValidated(game, s, { task: 'sheriff_speech', canExplode, canWithdraw: true }, fb(() => ({ text: '大家好。', withdraw: false })));
    if (v.explode) {
      const r = await handleExplode(game, s, v, { inElection: true });
      if (game.badgeSwallowed) { game.emit('sheriff_none', {}); return 'ok'; }
      if (r === 'dayEnded') return 'dayEnded';
      continue;
    }
    campaignOrder.push(s);
    game.emit('speech', { actor: s, data: { text: v.text, context: 'sheriff' } });
    if (v.withdraw) {
      game.emit('withdraw', { actor: s, data: {} });
      p._withdrawn = true;
    }
  }
  let remaining = candidates.filter((s) => game.player(s).alive && !game.player(s)._withdrawn);
  for (const s of candidates) delete game.player(s)._withdrawn;
  if (!remaining.length) { game.emit('sheriff_none', {}); return 'ok'; }
  if (remaining.length === 1) { electSheriff(game, remaining[0]); return 'ok'; }
  // 3. 警下投票（秘密）
  const voters = game.alivePlayers().filter((p) => !p.everRanSheriff).map((p) => p.seat);
  let r = await secretVote(game, { task: 'sheriff_vote', voters, candidates: remaining, allowNone: true });
  if (r.allZero) { game.emit('sheriff_none', {}); return 'ok'; }
  if (r.topSeats.length === 1) { electSheriff(game, r.topSeats[0]); return 'ok'; }
  // 4. 平票 PK（与竞选发言顺序相反）后再投
  game.emit('system', { text: `警长竞选平票，${r.topSeats.join('、')} 号 PK 后重新投票。` });
  const pkOrder = campaignOrder.filter((s) => r.topSeats.includes(s)).reverse();
  for (const s of pkOrder) {
    const p = game.player(s);
    if (!p.alive) continue;
    const canExplode = game.rules.allowSelfExplode && !!ROLES[p.role].selfExplode;
    const v = await askValidated(game, s, { task: 'sheriff_speech', canExplode, canWithdraw: false }, fb(() => ({ text: '再给大家讲讲我的逻辑。' })));
    if (v.explode) {
      const r2 = await handleExplode(game, s, v, { inElection: true });
      if (game.badgeSwallowed) { game.emit('sheriff_none', {}); return 'ok'; }
      if (r2 === 'dayEnded') return 'dayEnded';
      continue;
    }
    game.emit('speech', { actor: s, data: { text: v.text, context: 'pk' } });
  }
  const aliveTops = r.topSeats.filter((s) => game.player(s).alive);
  if (!aliveTops.length) { game.emit('sheriff_none', {}); return 'ok'; }
  if (aliveTops.length === 1) { electSheriff(game, aliveTops[0]); return 'ok'; }
  const r2 = await secretVote(game, { task: 'sheriff_vote', voters, candidates: aliveTops, allowNone: true });
  if (r2.allZero || r2.topSeats.length !== 1) { game.emit('sheriff_none', {}); return 'ok'; }
  electSheriff(game, r2.topSeats[0]);
  return 'ok';
}

function electSheriff(game, seat) {
  game.player(seat).isSheriff = true;
  game.emit('sheriff_elected', { actor: seat, data: { seat } });
}

// ---------- 秘密投票（互相不可见；人类投票界面先就绪，AI 逐个思考，人与 AI 同时进行） ----------
async function secretVote(game, { task, voters, candidates, allowNone }) {
  // 乌鸦诅咒：放逐投票（含 PK 投票）中被诅咒座位额外 +0.5 票；警长竞选投票不受影响
  const curseBonus = {};
  if ((task === 'vote' || task === 'pk_vote') && Array.isArray(game.activeCurse)) {
    for (const t of game.activeCurse) {
      if (t && candidates.includes(t)) curseBonus[t] = (curseBonus[t] || 0) + 0.5;
    }
  }
  const req = { task, candidates, allowNone };
  const eligible = voters.map((s) => game.player(s)).filter((p) => p.alive && !p.lostVote);
  const human = eligible.find((p) => p.isHuman);
  // 人类先行挂起（界面立即可投，无限时）；AI 逐个思考，不互相并行（单 API key 防限流）
  const humanJob = human
    ? game.ask(human.seat, req).then(
        (v) => ({ ok: true, v }),
        (err) => ({ ok: false, err }),
      )
    : null;
  const bySeat = new Map();
  for (const p of eligible) {
    if (p.isHuman) continue;
    const v = await askValidated(game, p.seat, req, fb(() => ({ target: 0 })));
    bySeat.set(p.seat, v);
  }
  if (humanJob) {
    const r = await humanJob;
    if (!r.ok) {
      if (r.err && r.err.code === 'FORCE_ENDED') throw r.err;
      bySeat.set(human.seat, { target: 0 });
    } else {
      bySeat.set(human.seat, r.v);
    }
  }
  // 按座位顺序归集（亮票顺序确定）
  const votes = [];
  for (const p of eligible) {
    const v = bySeat.get(p.seat) || { target: 0 };
    const weight = p.isSheriff ? game.rules.sheriffVoteWeight : 1;
    votes.push({ seat: p.seat, target: v.target, weight });
    game.emit('vote_cast', { actor: p.seat, visibleTo: [p.seat], data: { target: v.target } });
  }
  // 加权票型
  const tally = {};
  for (const v of votes) {
    const key = String(v.target);
    tally[key] = (tally[key] || 0) + v.weight;
  }
  for (const [t, b] of Object.entries(curseBonus)) tally[t] = (tally[t] || 0) + b;
  game.emit('vote_reveal', { data: Object.keys(curseBonus).length ? { votes, tally, curseBonus } : { votes, tally } });
  let max = 0, topSeats = [];
  for (const [t, n] of Object.entries(tally)) {
    const ti = Number(t);
    if (ti === 0) continue; // 弃票不计入最高票
    if (n > max) { max = n; topSeats = [ti]; }
    else if (n === max) topSeats.push(ti);
  }
  const allZero = max === 0;
  return { votes, tally, topSeats, allZero };
}

// ---------- 白天发言 ----------
async function speechPhase(game) {
  game.phase = 'speech';
  game.emit('phase', { data: { title: `第${game.day}天 · 白天发言` } });
  if (await consumeExplodeRequest(game)) return 'dayEnded';
  // AI 狼的天亮自爆决策点（官方：白天随时可自爆；AI 的决策时机=天亮后）
  for (const s of game.aliveSeats()) {
    const p = game.player(s);
    if (p.isHuman || game.finished) continue;
    if (!game.rules.allowSelfExplode || !ROLES[p.role].selfExplode) continue;
    const v = await askValidated(game, s, { task: 'explode_check' }, fb(() => ({ explode: false })));
    if (v.explode) {
      await handleExplode(game, s, v, { inElection: false });
      return 'dayEnded';
    }
  }
  let order;
  const sh = game.sheriff();
  const deaths = game.lastNightDeaths || [];
  if (sh && sh.alive) {
    const v = await askValidated(game, sh.seat, { task: 'direction' }, fb(() => ({ direction: 'cw' })));
    const anchor = deaths.length ? deaths[0].seat : sh.seat;
    order = buildSpeechOrder(game, anchor, v.direction === 'cw' ? 1 : -1, game.rules.sheriffFinalSpeech);
    game.emit('direction', { actor: sh.seat, data: { by: sh.seat, direction: v.direction, startSeat: order[0] || 0 } });
  } else {
    let anchor;
    if (game.rules.noSheriffSpeechStart === 'afterDeath' && deaths.length) anchor = deaths[0].seat;
    else anchor = randomOf(game.aliveSeats());
    order = buildSpeechOrder(game, anchor, 1, false);
    game.emit('system', { text: order.length ? `今天从 ${order[0]}号 开始顺时针依次发言。` : '' });
  }
  game.lastSpeechOrder = order;
  for (const s of order) {
    if (game.winner) return 'ok';
    const p = game.player(s);
    if (!p.alive) continue;
    if (await consumeExplodeRequest(game)) return 'dayEnded'; // 当前发言者开口前
    const canExplode = game.rules.allowSelfExplode && !!ROLES[p.role].selfExplode;
    const v = await askValidated(game, s, { task: 'speech', canExplode }, fb(() => ({ text: '我过。' })));
    if (v.explode) {
      await handleExplode(game, s, v, { inElection: false });
      return 'dayEnded';
    }
    game.emit('speech', { actor: s, data: { text: v.text, context: 'day' } });
    if (await consumeExplodeRequest(game)) return 'dayEnded'; // 发言刚结束即生效（打断后续发言）
    const dr = await consumeDuelRequest(game);
    if (dr === 'dayEnded') return 'dayEnded';
    if (await daySkillCheck(game)) return 'dayEnded'; // 白狼王/骑士按随机顺序询问
  }
  return 'ok';
}

// ---------- 放逐投票 ----------
async function votePhase(game) {
  game.phase = 'vote';
  game.emit('phase', { data: { title: '放逐投票' } });
  if (await consumeExplodeRequest(game)) return;
  if (await consumeDuelRequest(game)) return;
  const voters = game.alivePlayers().filter((p) => !p.lostVote).map((p) => p.seat);
  const candidates = game.aliveSeats();
  const r = await secretVote(game, { task: 'vote', voters, candidates, allowNone: true });
  if (await consumeExplodeRequest(game)) return; // 计票完成前自爆 → 本轮投票作废
  if (await consumeDuelRequest(game)) return;
  if (r.allZero) {
    game.emit('system', { text: '全员弃票，今天无人被放逐。' });
    return;
  }
  if (r.topSeats.length === 1) {
    await exile(game, r.topSeats[0]);
    return;
  }
  // 平票 PK
  game.phase = 'pk';
  game.emit('system', { text: `平票！${r.topSeats.join('、')} 号进行 PK 发言。` });
  const pkOrder = (game.lastSpeechOrder || []).filter((s) => r.topSeats.includes(s)).reverse();
  const missing = r.topSeats.filter((s) => !pkOrder.includes(s));
  pkOrder.push(...missing);
  for (const s of pkOrder) {
    const p = game.player(s);
    if (!p.alive) continue;
    if (await consumeExplodeRequest(game)) return;
    const canExplode = game.rules.allowSelfExplode && !!ROLES[p.role].selfExplode;
    const v = await askValidated(game, s, { task: 'pk_speech', canExplode }, fb(() => ({ text: '我再说明一下，我不是狼。' })));
    if (v.explode) {
      await handleExplode(game, s, v, { inElection: false });
      return;
    }
    game.emit('speech', { actor: s, data: { text: v.text, context: 'pk' } });
    if (await consumeExplodeRequest(game)) return;
    if (await consumeDuelRequest(game)) return;
  }
  const voters2 = voters.filter((s) => !r.topSeats.includes(s));
  const r2 = await secretVote(game, { task: 'pk_vote', voters: voters2, candidates: r.topSeats, allowNone: true });
  if (r2.allZero || r2.topSeats.length !== 1) {
    game.emit('system', { text: 'PK 后仍未分出胜负，今天无人被放逐。' });
    return;
  }
  await exile(game, r2.topSeats[0]);
}

async function exile(game, seat) {
  const p = game.player(seat);
  if (p.role === 'idiot' && !p.lostVote) {
    p.revealed = true;
    p.lostVote = true;
    game.emit('idiot_save', { actor: seat, data: { seat } });
    return;
  }
  await settleDeath(game, seat, 'vote_out', {});
  await processShots(game);
  checkEnd(game);
}

// ---------- 主流程 ----------
async function runGame(game) {
  try {
    await runGameInner(game);
  } catch (err) {
    if (err && err.code === 'FORCE_ENDED') {
      game.finish();
      game.logger.info('engine', `对局已被手动终止并结算：${game.winReason}，共 ${game.day} 天`);
      return;
    }
    throw err;
  }
}

async function runGameInner(game) {
  game._shots = [];
  game.lastProtectMap = {};
  game.logger.info('engine', '========== 对局开始：配置快照 ==========');
  const snap = game.configSnapshot();
  game.logger.info('engine', `板子：${snap.board}（${snap.seatCount}人）`);
  game.logger.info('engine', `座位：${snap.seats.join('，')}`);
  game.logger.info('engine', `生效规则：\n${snap.rulesText}`);
  game.deal();
  // 首夜
  await nightPhase(game);
  const pw = checkWinWithPending(game);
  if (pw) setWinner(game, pw);
  // 警长竞选（首夜后、宣布死讯前）
  if (!game.winner && game.rules.sheriff && !game.badgeSwallowed) {
    const r = await electionPhase(game);
    if (r === 'dayEnded') game._dayEnded = true;
  }
  await dawnPhase(game);
  let dayEnded = !!game._dayEnded;
  game._dayEnded = false;
  // 主循环：每天 = 发言 → 投票 → 夜晚 → 天亮
  while (!game.winner) {
    if (game.day >= 40) {
      setWinner(game, { winner: 'good', reason: '对局超过 40 天仍未分出胜负，按存活人数判定好人阵营获胜（保险机制）。' });
      break;
    }
    if (!dayEnded && game.sheriffElectionPending && game.rules.sheriff && !game.badgeSwallowed) {
      game.sheriffElectionPending = false;
      const r = await electionPhase(game);
      if (r === 'dayEnded') dayEnded = true;
    }
    if (!dayEnded) {
      const sr = await speechPhase(game);
      if (!game.winner && sr !== 'dayEnded') await votePhase(game);
    }
    if (game.winner) break;
    dayEnded = false;
    await nightPhase(game);
    const pw2 = checkWinWithPending(game);
    if (pw2) setWinner(game, pw2);
    await dawnPhase(game);
  }
  game.finish();
  game.logger.info('engine', `对局结束：${game.winner} —— ${game.winReason}，共 ${game.day} 天`, {
    llmStats: game.llmStats,
  });
}

module.exports = { runGame, validatePayload, secretVote, buildSpeechOrder, checkWinWithPending,
  // 供单元测试直接驱动内部阶段
  _internals: { nightPhase, resolveNightDeaths, dawnPhase, settleDeath, electionPhase, speechPhase, votePhase, exile, handleExplode, consumeExplodeRequest, handleDuel, consumeDuelRequest, daySkillCheck, witchStep, guardStep, wolfStep, seerStep, admirerStep, dreamerStep, wolfbeautyStep, crowStep } };
