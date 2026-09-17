/**
 * flow.js — 对局流程状态机（夜晚/警长竞选/天亮/发言/投票/结算）
 * 规则依据：docs/rules.md。所有玩家输入统一走 askValidated（人类挂起等待、AI 校验重试+降级）。
 */
'use strict';
const { ROLES } = require('./roles');
const { resolveNightDamage, triggersCharm } = require('./damage');
const { claimScan, mergeClaims } = require('./claims');

// ---------- 输入校验（人类与 AI 共用同一套） ----------
/**
 * 任务 → 载荷校验器注册表（P2-1）。
 *
 * 之前这是一个 140 行的 switch，且"哪些任务共用同一段校验"只能靠 `fall through` 注释表达
 * （speech/sheriff_speech/pk_speech 三合一、night_guard/wolf_kill/vote/… 五合一）。
 * 那种写法有两个具体代价：加任务要在长 switch 里找位置、共用关系一改就容易漏改注释；
 * 而"必须从候选中选一名"这类语义会散在多处各写一遍。
 *
 * 现在共用语义有名字（pickTarget / mustPickOther / textOnly…），任务表一眼能看出谁和谁同类；
 * 未登记的任务会明确报"未知任务"（不是静默接受任意载荷）。
 */

/** 发言正文上限（字）。超长会被截断，但**必须留痕**：静默截断会让人误以为"AI 就说了这么多"。 */
const SPEECH_MAX_CHARS = 600;

/**
 * 单次决策的总时间闸（A3）。
 * 调用层的"分任务软超时"是 90s（发言）/30s（微决策），但传输层重试与校验层重试会**相乘**：
 * 一次决策最坏能拖十几分钟，玩家的观感就是"整局卡死"。宁可降级出一手平凡但合法的棋。
 */
const DECISION_TOTAL_MS = 180000;

/**
 * 截断发言并留痕（god 可见）。
 * 为什么在这里发事件而不是在调用方：校验器是唯一还知道"原始长度"的地方，
 * 值一旦被裁短，调用方就再也看不出这条发言被砍过。
 */
function clipSpeech(game, seat, raw) {
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (t.length <= SPEECH_MAX_CHARS) return t;
  game.emit('llm_error', {
    actor: seat,
    visibleTo: 'god',
    data: { task: 'speech', error: `发言超长已截断（${t.length} → ${SPEECH_MAX_CHARS} 字）`, truncated: true },
  });
  return t.slice(0, SPEECH_MAX_CHARS);
}

const V = {
  /** 白天发言（含竞选发言与 PK 发言）：可附带自爆意图 */
  speech: ({ payload, req, p, game, asInt, inCand, fail, task, seat }) => {
    const text = clipSpeech(game, seat, payload.text);
    if (!text) return fail('发言内容不能为空');
    const value = {
      text,
      explode: false,
      target: 0,
      withdraw: false,
      // 模型自报的宣称（B2）：只当补充，真正的账本由引擎扫描发言正文得到 —— 不依赖模型诚实
      claims: Array.isArray(payload.claims) ? payload.claims.slice(0, 6) : [],
    };
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
    // 退水只在允许退水的轮次生效：不该让引擎"悄悄忽略"模型以为已经生效的动作
    // （PK 轮传 canWithdraw:false，schema 也会把 withdraw 锁成 false）
    if (task === 'sheriff_speech' && req.canWithdraw) value.withdraw = !!payload.withdraw;
    return { ok: true, value };
  },
  /** 只要求一段文本（遗言 / 狼队提议） */
  textOnly: ({ payload, fail, game, seat }) => {
    const text = clipSpeech(game, seat, payload.text);
    if (!text) return fail('内容不能为空');
    return { ok: true, value: { text } };
  },
  /** 狼队讨论：发言必填，可带刀口建议（0 = 建议空刀） */
  wolfChat: ({ payload, req, asInt, inCand, fail, game, seat }) => {
    const text = clipSpeech(game, seat, payload.text);
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
  },
  /** 骑士决斗：可选，选了就必须给存活的其他玩家 */
  duelCheck: ({ payload, seat, alive, asInt, fail }) => {
    const value = { duel: !!payload.duel, target: 0 };
    if (value.duel) {
      const t = asInt(payload.target);
      if (!Number.isInteger(t) || t === seat || !alive.includes(t)) return fail('决斗目标不合法（需一名存活的其他玩家）');
      value.target = t;
    }
    return { ok: true, value };
  },
  /** 自爆请求：白狼王必须带走一名存活的其他玩家 */
  explodeCheck: ({ payload, p, seat, alive, asInt, fail }) => {
    const value = { explode: !!payload.explode, target: 0 };
    if (value.explode && p.role === 'whitewolfking') {
      const t = asInt(payload.target);
      if (!Number.isInteger(t) || t === seat || !alive.includes(t)) return fail('白狼王自爆必须带走一名存活的其他玩家');
      value.target = t;
    }
    return { ok: true, value };
  },
  /** 人类狼轮到自己说话：可发一言，也可空手跳过 */
  wolfSay: ({ payload }) => {
    const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, 600) : '';
    return { ok: true, value: { text, skipped: !text } };
  },
  /** 选一名候选（可空过）：守卫/刀人/各种投票共用 */
  pickTarget: ({ payload, noneOk, asInt, inCand, fail }) => {
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
  },
  /** 查验：不能查自己 */
  seerCheck: ({ payload, seat, asInt, inCand, fail }) => {
    const t = asInt(payload.target);
    if (!inCand(t)) return fail('查验目标不合法');
    if (t === seat) return fail('不能查验自己');
    return { ok: true, value: { target: t } };
  },
  /** 摄梦/诅咒/魅惑/暗恋：必须从候选中选一名（候选已排除自己），不允许空过 */
  mustPickOther: ({ payload, seat, asInt, inCand, fail }) => {
    const t = asInt(payload.target);
    if (!Number.isInteger(t)) return fail('缺少目标（需要 target 字段）');
    if (!inCand(t)) return fail('目标不合法');
    if (t === seat) return fail('不能选择自己');
    return { ok: true, value: { target: t } };
  },
  /** 女巫用药：每晚最多一瓶，且受板规限制（能否自救等） */
  witch: ({ payload, req, seat, alive, asInt, fail }) => {
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
  },
  sheriffRun: ({ payload }) => ({ ok: true, value: { run: !!payload.run } }),
  badgePass: ({ payload, alive, asInt, fail }) => {
    const t = asInt(payload.target || 0);
    if (!Number.isInteger(t) || t === 0) return { ok: true, value: { target: 0 } };
    if (!alive.includes(t)) return fail('警徽只能移交给存活玩家');
    return { ok: true, value: { target: t } };
  },
  direction: ({ payload, fail }) => {
    if (payload.direction !== 'cw' && payload.direction !== 'ccw') return fail('方向必须是 cw（顺时针）或 ccw（逆时针）');
    return { ok: true, value: { direction: payload.direction } };
  },
  /** 开枪：可放弃（target 0） */
  shoot: ({ payload, alive, asInt, fail }) => {
    const t = asInt(payload.target || 0);
    if (!Number.isInteger(t) || t === 0) return { ok: true, value: { target: 0 } };
    if (!alive.includes(t)) return fail('开枪目标不合法');
    return { ok: true, value: { target: t } };
  },
};

const TASK_VALIDATORS = {
  speech: V.speech,
  sheriff_speech: V.speech,
  // pk_speech 同属"白天发言阶段"（rules.md：狼人白天发言阶段可自爆）：
  // 若只返回 text，flow 里的 `if (v.explode)` 永远取不到值 → 该能力变成死代码
  pk_speech: V.speech,
  lastwords: V.textOnly,
  wolf_propose: V.textOnly,
  wolf_chat: V.wolfChat,
  duel_check: V.duelCheck,
  explode_check: V.explodeCheck,
  wolf_say: V.wolfSay,
  night_guard: V.pickTarget,
  wolf_kill: V.pickTarget,
  vote: V.pickTarget,
  pk_vote: V.pickTarget,
  sheriff_vote: V.pickTarget,
  seer_check: V.seerCheck,
  night_dream: V.mustPickOther,
  crow_curse: V.mustPickOther,
  wolfbeauty_charm: V.mustPickOther,
  admirer_crush: V.mustPickOther,
  witch: V.witch,
  sheriff_run: V.sheriffRun,
  badge_pass: V.badgePass,
  direction: V.direction,
  shoot: V.shoot,
};

function validatePayload(task, payload, req, game, seat) {
  const p = game.player(seat);
  const alive = game.aliveSeats();
  const cand = req.candidates || [];
  const ctx = {
    p, alive, cand, seat, req, task,
    game,
    noneOk: !!req.allowNone,
    payload: payload && typeof payload === 'object' ? payload : {},
    fail: (error) => ({ ok: false, error }),
    inCand: (t) => Number.isInteger(t) && cand.includes(t),
    asInt: (v) => { const n = Number(v); return Number.isInteger(n) ? n : NaN; },
  };
  const validator = TASK_VALIDATORS[task];
  if (!validator) return { ok: false, error: '未知任务 ' + task };
  return validator(ctx);
}

// ---------- 通用询问（人类挂起 / AI 校验重试 + 降级） ----------

/**
 * 统一的"某人公开发言"出口：落 `speech`，并把这句话里的**宣称**记进账本（B2）。
 *
 * 为什么收口成一个函数：发言有 5 个出口（白天/警上/PK/遗言/狼聊），
 * 散着写就得改 5 处、以后加一处又漏一处；宣称的抽取（claimScan）是确定性的代码规则，
 * **不依赖模型自报**，所以模型漏报也不会让账本失真。
 * 每条 `claim` 都带 `verifiedBy: null`：引擎永远不替宣称背书，它只是"某人这样说过"的记录。
 */
function emitSpeech(game, seat, v, context) {
  const text = (v && v.text) || '';
  const data = { text, context };
  if (v && v.degraded) data.degraded = true;
  game.emit('speech', { actor: seat, data });
  // 人类玩家的发言同样走这里：他们打的"我是预言家"也会进账本，AI 侧看得到
  const claims = mergeClaims(claimScan(text, game.players.length), v && v.claims, game.players.length);
  for (const c of claims) {
    game.emit('claim', { actor: seat, data: { ...c, day: game.day, verifiedBy: null } });
  }
}
async function askValidated(game, seat, req, { fallback, maxRetries = 2 } = {}) {
  const p = game.player(seat);
  if (p.isHuman) {
    return game.ask(seat, req); // resolveHuman 内已用同一 validatePayload 校验
  }
  let note = '';
  let lastError = '';
  // 单次决策的总时间闸（A3）：调用层已有"分任务软超时"（发言 90s / 微决策 30s），
  // 但传输层重试 × 校验层重试会相乘 —— 极端情况一次决策能拖十几分钟，整局看起来就是卡死。
  // 超过这个总预算就直接走降级（宁可出一手平凡但合法的棋，也不要让全场等一个人）。
  const deadlineAt = Date.now() + DECISION_TOTAL_MS;
  for (let i = 0; i <= maxRetries; i++) {
    if (Date.now() > deadlineAt) {
      lastError = `单次决策总耗时超过 ${Math.round(DECISION_TOTAL_MS / 1000)}s（超时/失败重试累计）`;
      game.logger.warn('ai', `${seat}号 ${req.task} ${lastError}，停止重试并降级`);
      game.emit('llm_error', { actor: seat, visibleTo: 'god', data: { task: req.task, attempt: i + 1, error: lastError, timeout: true, degraded: false } });
      break;
    }
    const request = note ? { ...req, _retryNote: note } : req;
    const raw = await game.ask(seat, request);
    const v = validatePayload(req.task, raw, req, game, seat);
    if (v.ok) return v.value;
    lastError = v.error;
    note = `你上一次的输出不合法（${v.error}），请严格按照要求的 JSON 格式重新输出。`;
    game.logger.warn('ai', `${seat}号 ${req.task} 输出不合法：${JSON.stringify(raw).slice(0, 200)} — ${v.error}`);
    // 每一次非法都留痕：以前只有"最终降级"那一条，中间失败几次、失败在哪一项都看不出来
    game.emit('llm_error', {
      actor: seat,
      visibleTo: 'god',
      data: { task: req.task, attempt: i + 1, error: v.error, degraded: false },
    });
  }
  game.logger.warn('ai', `${seat}号 ${req.task} 多次输出不合法，使用降级方案`);
  const value = fallback ? fallback() : null;
  // 降级必须可见：以前只留一行"已降级处理"，玩家侧完全无感 ——
  // 于是"暗恋对象莫名其妙绑到 1 号""遗言凭空消失"这类现象看起来像 bug 却无从追查。
  game.emit('llm_error', {
    actor: seat,
    visibleTo: 'god',
    data: {
      task: req.task,
      attempts: maxRetries + 1,
      error: lastError,
      degraded: true,
      degradedTo: value == null ? 'null' : JSON.stringify(value).slice(0, 120),
    },
  });
  return value;
}

const fb = (fn) => ({ fallback: fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 夜晚步骤注册表（P2-1 能力注册表）。
 *
 * 重构前，"某个角色今晚会不会行动"这件事散落在**三处**：
 *   ① `activeSteps` 过滤（哪些步骤要播报）
 *   ② `if (step === 'admirer') … else if …` 派发链（怎么跑）
 *   ③ `hasAliveActor` 判定（全员出局时要不要补固定停顿）
 * 加一个角色必须同时改三处，漏一处就会出现"夜里没动作但也不播报"或"播报了却没人行动"这类难查的问题，
 * 而且三处的条件写法并不一致（比如 wolf 用的是狼队而不是 aliveOfRole('wolf')）。
 *
 * 现在每个步骤一行：`present`（这个步骤是否存在）、`actors`（谁算行动者）、`run`（怎么跑）、`label`（播报名）。
 * 顺序仍由 `rules.nightOrder` 决定 —— 那是可配置项，不进代码。
 */
const NIGHT_STEPS = {
  admirer: {
    label: '暗恋者行动',
    present: (g) => g.day === 1 && (g.board.admirer || 0) > 0,
    actors: (g) => g.aliveOfRole('admirer'),
    run: admirerStep,
  },
  guard: { label: '守卫行动', present: (g) => (g.board.guard || 0) > 0, actors: (g) => g.aliveOfRole('guard'), run: guardStep },
  dreamer: { label: '摄梦人行动', present: (g) => (g.board.dreamer || 0) > 0, actors: (g) => g.aliveOfRole('dreamer'), run: dreamerStep },
  wolf: { label: '狼人行动', present: (g) => g.wolves().length > 0, actors: (g) => g.nightWolves(), run: wolfStep },
  wolfbeauty: { label: '狼美人行动', present: (g) => (g.board.wolfbeauty || 0) > 0, actors: (g) => g.aliveOfRole('wolfbeauty'), run: wolfbeautyStep },
  seer: { label: '预言家行动', present: (g) => (g.board.seer || 0) > 0, actors: (g) => g.aliveOfRole('seer'), run: seerStep },
  witch: { label: '女巫行动', present: (g) => (g.board.witch || 0) > 0, actors: (g) => g.aliveOfRole('witch'), run: witchStep },
  crow: { label: '乌鸦行动', present: (g) => (g.board.crow || 0) > 0, actors: (g) => g.aliveOfRole('crow'), run: crowStep },
};

/** 小工具 */
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
  // 死亡台账：纯记账字段，不参与任何规则判定。
  // 它让"谁在第几天因何出局"变成权威数据——事件流里放逐/自爆死因是分散的，
  // 评测指标、上帝面板、赛后复盘都要用它（players 会原样进存档/锚点，故可往返）。
  p.deathDay = game.day;
  p.deathCause = cause;
  // 翻牌
  if (game.rules.revealOnDeath) {
    p.revealed = true;
    game.emit('role_reveal', { visibleTo: 'all', actor: seat, data: { seat, role: p.role } });
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
    const text = (v && v.text) || '';
    // 遗言降级不再"凭空消失"：以前 text 为空就一条事件都不发，玩家分不清
    // "他不想说"与"AI 挂了"。现在一律落一条**中性占位**（不编造内容）并标记 degraded。
    emitSpeech(game, seat, { text: text || '（他没有留下遗言。）', degraded: !text }, 'lastwords');
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
  // 触发与否由 damage.js 的死因规则表决定（原来是写死在这里的数组，P2-1 归到规则表）
  if (p.role === 'wolfbeauty') {
    const ts = game.charmMap[seat];
    delete game.charmMap[seat];
    if (ts != null && triggersCharm(cause)) {
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
  const v = await askValidated(game, seat, { task: 'badge_pass', _allowDead: true, candidates: game.aliveSeats() }, fb(() => ({ target: 0 })));
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
/**
 * 夜晚步骤依赖图：**只有女巫必须等狼刀**（她要看到"今晚谁被刀"才能决定救不救）。
 *
 * 其余步骤彼此独立，可以并发 —— 因为它们的产物全是**私密事件**（`visibleTo: [自己]`），
 * 只有自己读得到，所以并发不会改变任何 AI 看到的信息（与白天发言链不同，那条链是真的串行）。
 * 这是多 Key 场景下仅次于投票的一块收益（夜晚步骤占调用数的两成左右）。
 */
const NIGHT_DEPS = { witch: ['wolf'] };

/** 跑单个夜晚步骤：无人可行动时补固定停顿（避免用时长反推"这个角色还活着吗"） */
async function runNightStep(game, step) {
  const cap = NIGHT_STEPS[step];
  await cap.run(game);
  // 该角色已全员出局时步骤会"秒过"，加固定停顿避免时长推断
  if (!cap.actors(game).length) await sleep(game.stepPauseMs != null ? game.stepPauseMs : 2000);
}

/**
 * 夜晚并发的分波执行：依赖已满足的步骤同一波开跑。
 * 步骤的**播报顺序与序号仍按 nightOrder**，所以玩家看到的"守卫行动 → 狼人行动 → …"完全不变。
 */
async function runNightWaves(game, steps) {
  const total = steps.length;
  const done = new Set();
  const rest = [...steps];
  while (rest.length) {
    const ready = rest.filter((s) => (NIGHT_DEPS[s] || []).every((d) => done.has(d) || !steps.includes(d)));
    const wave = ready.length ? ready : [rest[0]]; // 依赖成环时退化为顺序执行（正常板子不会发生）
    for (const s of wave) {
      game.emit('night_step', { data: { step: s, label: NIGHT_STEPS[s].label, index: steps.indexOf(s) + 1, total } });
    }
    await Promise.all(wave.map((s) => runNightStep(game, s)));
    for (const s of wave) {
      done.add(s);
      rest.splice(rest.indexOf(s), 1);
    }
  }
}

async function nightPhase(game) {
  if (typeof game.markAnchor === 'function') game.markAnchor('night'); // 断点恢复锚点：夜晚可安全重放（夜事件全程私密）
  game.day++;
  game.phase = 'night';
  game.night = { guardActions: [], dreamActions: [], charmActions: [], curses: [], wolfKill: 0, saved: false, poisonTargets: [] };
  game.activeCurse = []; // 乌鸦诅咒只在"次日的放逐投票"生效，新的一夜先清空
  game.emit('phase', { data: { title: `第${game.day}夜 · 天黑请闭眼` } });
  // 日切边界：上一个白天已完整结束 → 让已创建的 AI 在后台整理纪要（优先级 1，不阻塞流程）。
  // 这样"反思"不再压在新一天的首个决策里，也就不会再出现"某 AI 首答异常慢"。
  if (game.day > 1 && typeof game.scheduleReflection === 'function') game.scheduleReflection(game.day - 1);
  // 固定全步骤播报（防信息泄露）：角色已死也播报该步骤；板子里不存在的角色不播；暗恋者仅首夜行动
  const activeSteps = game.rules.nightOrder.filter((s) => NIGHT_STEPS[s] && NIGHT_STEPS[s].present(game));
  if (game.parallelLlm && activeSteps.length > 1) {
    // 多 Key：独立步骤并发（只有女巫等狼刀），总时长明显下降
    await runNightWaves(game, activeSteps);
  } else {
    // 单 Key（默认）：逐步骤串行 —— 与旧版逐字节一致
    let idx = 0;
    for (const step of game.rules.nightOrder) {
      const cap = NIGHT_STEPS[step];
      if (!cap || !activeSteps.includes(step)) continue;
      idx++;
      game.emit('night_step', { data: { step, label: cap.label, index: idx, total: activeSteps.length } });
      await runNightStep(game, step);
    }
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
  //
  // 同样是"**同时指刀**"：讨论已经在上面结束了，最后这一票不该被队友的票带节奏。
  // 旧实现顺序询问 AI 狼、问一个公布一个（`wolf_kill_vote` 只给狼队可见，是队内信息、不算规则泄露，
  // 但会让后表态的狼"跟着前面的票走"，而且人类狼本来就是"看不到别人票"的 —— 口径不一致）。
  // 现在统一为"先收完所有票、再按座位公布"，人类狼与 AI 狼的信息条件完全一致，且可以并发。
  const killReq = { task: 'wolf_kill', candidates: prey, allowNone };
  const humanWolf = wolves.find((w) => w.isHuman);
  const humanJob = humanWolf
    ? game.ask(humanWolf.seat, killReq).then(
        (v) => ({ ok: true, v }),
        (err) => ({ ok: false, err }),
      )
    : null;
  const votes = [];
  const aiWolfVoters = wolves.filter((w) => !w.isHuman);
  const askKill = async (w) => {
    const v = await askValidated(game, w.seat, killReq, fb(() => ({ target: allowNone ? 0 : prey[0] })));
    votes.push({ seat: w.seat, target: v.target });
  };
  if (game.parallelLlm && aiWolfVoters.length > 1) {
    await Promise.all(aiWolfVoters.map(askKill));
  } else {
    for (const w of aiWolfVoters) await askKill(w);
  }
  if (humanJob) {
    const r = await humanJob;
    if (!r.ok) {
      if (r.err && r.err.code === 'FORCE_ENDED') throw r.err;
      r.v = { target: 0 };
    }
    votes.push({ seat: humanWolf.seat, target: r.v.target });
  }
  votes.sort((a, b) => a.seat - b.seat); // 公布顺序按座位
  for (const v of votes) game.emit('wolf_kill_vote', { actor: v.seat, visibleTo: vis, data: { target: v.target } });
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
    final = randomOf(tops, game.rnd);
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

/**
 * 夜晚结算：伤害清单交给 damage.js 的规则表算（P2-1），这里只负责
 * 把结果落到 game.pendingDeaths，并更新跨夜状态。
 *
 * 为什么保留这个薄封装：`_internals.resolveNightDeaths` 是既有测试与调试入口，
 * 名字也仍然准确（"结算夜晚死亡"）；真正的判定逻辑已经搬进规则表，不再藏在本文件的 if/else 顺序里。
 */
function resolveNightDeaths(game) {
  game.pendingDeaths = resolveNightDamage(game);
  game.lastNightDeaths = game.pendingDeaths.slice();

  // ---------- 跨夜状态更新 ----------
  const dreamActions = (game.night && game.night.dreamActions) || [];
  const charmActions = (game.night && game.night.charmActions) || [];
  const curses = (game.night && game.night.curses) || [];
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
      game.emit('system', { visibleTo: 'all', text: '警徽被吞掉，本局不再有警长。' });
    } else {
      game.sheriffElectionPending = true;
      game.emit('system', { visibleTo: 'all', text: '警长竞选被打断，今日直接天黑；警徽保留，明日重新竞选。' });
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
  // 排队期间目标可能已出局（如被开枪带走）：降级为不带人并公告，避免玩家以为目标被带走
  let target = req.target || 0;
  if (target && !game.player(target).alive) {
    game.emit('system', { visibleTo: 'all', text: `⚠️ ${p.seat}号（${ROLES[p.role].name}）自爆：原目标 ${target}号 已出局，本次自爆不带人，天黑了。` });
    target = 0;
  }
  game.logger.info('engine', `${req.seat}号 随时自爆生效（target=${target || 0}）`);
  await handleExplode(game, req.seat, { text: '', explode: true, target }, { inElection: false });
  return true;
}

/** 骑士决斗：决斗狼人 → 其出局并直接天黑；决斗好人 → 骑士以死谢罪，白天继续 */
async function handleDuel(game, knightSeat, target) {
  // 发动决斗 = 翻牌：骑士身份当场公开（不受翻牌规则限制，这是技能的一部分）
  const kp = game.player(knightSeat);
  kp.revealed = true;
  game.emit('role_reveal', { visibleTo: 'all', actor: knightSeat, data: { seat: knightSeat, role: kp.role } });
  game.emit('duel', { actor: knightSeat, data: { target } });
  const tp = game.player(target);
  if (tp && tp.alive && ROLES[tp.role].team === 'wolf') {
    await settleDeath(game, target, 'duel_win', {});
    await processShots(game);
    checkEnd(game);
    game.emit('system', { visibleTo: 'all', text: `⚔️ 决斗成功：${target}号 是狼人，立即出局，天黑了。` });
    return 'dayEnded';
  }
  await settleDeath(game, knightSeat, 'duel_fail', {});
  await processShots(game);
  checkEnd(game);
  game.emit('system', { visibleTo: 'all', text: `⚔️ 决斗失败：${target}号 是好人，骑士以死谢罪，白天继续。` });
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
  if (!tp || !tp.alive || req.target === req.seat) {
    // 目标在排队期间出局：公告取消（此前为静默丢弃，玩家会以为决斗没提交上）
    game.emit('system', { visibleTo: 'all', text: `⚠️ ${req.seat}号（骑士）的决斗目标已出局，本次决斗取消。` });
    return false;
  }
  game.logger.info('engine', `${req.seat}号(骑士) 随时决斗生效（target=${req.target}）`);
  return handleDuel(game, req.seat, req.target);
}

/** 白狼王/骑士：每次发言结束后按随机顺序询问是否发动白天技能（自爆/决斗） */
async function daySkillCheck(game) {
  const actors = game.alivePlayers().filter((p) => !p.isHuman && (p.role === 'whitewolfking' || p.role === 'knight'));
  for (let i = actors.length - 1; i > 0; i--) {
    const j = Math.floor(game.rnd() * (i + 1));
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
  //
  // 真实规则是"**同时举手**"：谁上警不该被别人的选择影响。但旧实现是顺序询问、问一个公布一个，
  // 于是第 12 位报名者看得到前 11 位谁上警了（`sheriff_run` 不在 NOISE_TYPES 里，是真的进了 AI 上下文）。
  // 现在**先问完所有人、再统一公布**：既符合规则，又让这些调用可以并发（多 Key 时不再排队）。
  // 单通道与多通道走同一条"先收集后公布"的路径，保证加不加 Key 都是同一套信息。
  const alive = game.alivePlayers();
  const runResults = [];
  const askRun = async (p) => {
    const v = await askValidated(game, p.seat, { task: 'sheriff_run' }, fb(() => ({ run: false })));
    runResults.push({ seat: p.seat, run: !!v.run });
  };
  if (game.parallelLlm && alive.length > 1) {
    await Promise.all(alive.map(askRun));
  } else {
    for (const p of alive) await askRun(p);
  }
  runResults.sort((a, b) => a.seat - b.seat); // 公布顺序仍按座位，保证日志与亮票顺序稳定
  const candidates = [];
  for (const r of runResults) {
    if (r.run) {
      game.player(r.seat).everRanSheriff = true;
      candidates.push(r.seat);
    }
    game.emit('sheriff_run', { actor: r.seat, data: { run: r.run } });
  }
  game.emit('system', { visibleTo: 'all', text: candidates.length ? `🎩 上警名单：${candidates.join('、')} 号` : '🎩 无人上警，本局没有警长。' });
  // 2. 警上演讲（可退水/自爆）
  const campaignOrder = [];
  for (const s of candidates) {
    const p = game.player(s);
    if (!p.alive) continue;
    const canExplode = game.rules.allowSelfExplode && !!ROLES[p.role].selfExplode;
    const v = await askValidated(game, s, { task: 'sheriff_speech', canExplode, canWithdraw: true, candidates: game.aliveSeats().filter((x) => x !== s) }, fb(() => ({ text: '大家好。', withdraw: false })));
    if (v.explode) {
      const r = await handleExplode(game, s, v, { inElection: true });
      if (game.badgeSwallowed) { game.emit('sheriff_none', {}); return 'ok'; }
      if (r === 'dayEnded') return 'dayEnded';
      continue;
    }
    campaignOrder.push(s);
    emitSpeech(game, s, v, 'sheriff');
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
  game.emit('system', { visibleTo: 'all', text: `警长竞选平票，${r.topSeats.join('、')} 号 PK 后重新投票。` });
  const pkOrder = campaignOrder.filter((s) => r.topSeats.includes(s)).reverse();
  for (const s of pkOrder) {
    const p = game.player(s);
    if (!p.alive) continue;
    const canExplode = game.rules.allowSelfExplode && !!ROLES[p.role].selfExplode;
    const v = await askValidated(game, s, { task: 'sheriff_speech', canExplode, canWithdraw: false, candidates: game.aliveSeats().filter((x) => x !== s) }, fb(() => ({ text: '再给大家讲讲我的逻辑。' })));
    if (v.explode) {
      const r2 = await handleExplode(game, s, v, { inElection: true });
      if (game.badgeSwallowed) { game.emit('sheriff_none', {}); return 'ok'; }
      if (r2 === 'dayEnded') return 'dayEnded';
      continue;
    }
    emitSpeech(game, s, v, 'pk');
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
  const aiVoters = eligible.filter((p) => !p.isHuman);
  // 进度可见：一次放逐投票要串行 8~11 次调用，期间**没有任何输出**，玩家只能盯着"正在思考"。
  // 这里只播报计数（done/total），不带任何目标或座位 —— 泄露投票方向就是泄露游戏信息。
  // 该事件同时被 context 的 NOISE_TYPES 与 effort 的 CHATTER_TYPES 排除，AI 完全感知不到。
  if (aiVoters.length) game.emit('vote_progress', { data: { done: 0, total: aiVoters.length } });
  if (game.parallelLlm && aiVoters.length > 1) {
    // 多 Key（keypool P3）：互不依赖的投票可以扇出。**提交顺序仍是座位顺序**，
    // 每条分支最终都排进同一个调度器（槽位 ↦ Key），所以：
    //   · 单 Key 时这个分支根本不会走到（parallelLlm=false），行为与旧版逐字节一致；
    //   · 多 Key 时按通道并行（实测 4 通道约 -23%）；
    //   · 无论哪种，票型归集都按座位顺序（见下方 votes 循环），亮票顺序与结果不受影响。
    let done = 0;
    await Promise.all(aiVoters.map(async (p) => {
      const v = await askValidated(game, p.seat, req, fb(() => ({ target: 0 })));
      bySeat.set(p.seat, v);
      done++;
      game.emit('vote_progress', { data: { done, total: aiVoters.length } });
    }));
  } else {
    for (const p of aiVoters) {
      const v = await askValidated(game, p.seat, req, fb(() => ({ target: 0 })));
      bySeat.set(p.seat, v);
      game.emit('vote_progress', { data: { done: bySeat.size, total: aiVoters.length } });
    }
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
  if (typeof game.markAnchor === 'function') game.markAnchor('speech'); // 断点恢复锚点：白天可整体重放
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
    else anchor = randomOf(game.aliveSeats(), game.rnd);
    order = buildSpeechOrder(game, anchor, 1, false);
    game.emit('system', { visibleTo: 'all', text: order.length ? `今天从 ${order[0]}号 开始顺时针依次发言。` : '' });
  }
  game.lastSpeechOrder = order;
  for (const s of order) {
    if (game.winner) return 'ok';
    const p = game.player(s);
    if (!p.alive) continue;
    if (await consumeExplodeRequest(game)) return 'dayEnded'; // 当前发言者开口前
    const canExplode = game.rules.allowSelfExplode && !!ROLES[p.role].selfExplode;
    // candidates 必须传：白狼王自爆带人的目标由 validatePayload 用 inCand 校验，
    // 不传则 inCand 恒为 false → 技能永远无法通过校验（等于死代码 + 每次白烧两次重试）。
    const explodeTargets = () => game.aliveSeats().filter((x) => x !== s);
    const v = await askValidated(game, s, { task: 'speech', canExplode, candidates: explodeTargets() }, fb(() => ({ text: '我过。' })));
    if (v.explode) {
      await handleExplode(game, s, v, { inElection: false });
      return 'dayEnded';
    }
    emitSpeech(game, s, v, 'day');
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
    game.emit('system', { visibleTo: 'all', text: '全员弃票，今天无人被放逐。' });
    return;
  }
  if (r.topSeats.length === 1) {
    await exile(game, r.topSeats[0]);
    return;
  }
  // 平票 PK
  game.phase = 'pk';
  game.emit('system', { visibleTo: 'all', text: `平票！${r.topSeats.join('、')} 号进行 PK 发言。` });
  const pkOrder = (game.lastSpeechOrder || []).filter((s) => r.topSeats.includes(s)).reverse();
  const missing = r.topSeats.filter((s) => !pkOrder.includes(s));
  pkOrder.push(...missing);
  for (const s of pkOrder) {
    const p = game.player(s);
    if (!p.alive) continue;
    if (await consumeExplodeRequest(game)) return;
    const canExplode = game.rules.allowSelfExplode && !!ROLES[p.role].selfExplode;
    const v = await askValidated(game, s, { task: 'pk_speech', canExplode, candidates: game.aliveSeats().filter((x) => x !== s) }, fb(() => ({ text: '我再说明一下，我不是狼。' })));
    if (v.explode) {
      await handleExplode(game, s, v, { inElection: false });
      return;
    }
    emitSpeech(game, s, v, 'pk');
    if (await consumeExplodeRequest(game)) return;
    if (await consumeDuelRequest(game)) return;
  }
  const voters2 = voters.filter((s) => !r.topSeats.includes(s));
  const r2 = await secretVote(game, { task: 'pk_vote', voters: voters2, candidates: r.topSeats, allowNone: true });
  if (r2.allZero || r2.topSeats.length !== 1) {
    game.emit('system', { visibleTo: 'all', text: 'PK 后仍未分出胜负，今天无人被放逐。' });
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
async function runGame(game, opts = {}) {
  try {
    await runGameInner(game, opts.resumeFrom || null);
  } catch (err) {
    if (err && err.code === 'FORCE_ENDED') {
      game.finish();
      game.logger.info('engine', `对局已被手动终止并结算：${game.winReason}，共 ${game.day} 天`);
      return;
    }
    // 外部原因暂停（配额/套餐/鉴权）：不判负、不置 finished，状态与锚点原样保留
    if (err && err.code === 'GAME_PAUSED') {
      game.logger.warn('engine', `对局已暂停并等待恢复：${game.paused && game.paused.message}（第 ${game.day} 天 · ${game.phase}）`);
      return;
    }
    throw err;
  }
}

/**
 * 首夜后的警长竞选。抽成函数是因为**恢复路径也必须重放它**：
 * 旧实现只在"开新局"分支里调用，从 night 锚点恢复时会整段跳过竞选 →
 * 事件流从这一刻起与原局分叉（seq 全面错位），决策 journal 全部落空，恢复局走向也变了。
 */
async function firstNightElection(game) {
  if (game.day !== 1 || game.winner) return false;
  if (!game.rules.sheriff || game.badgeSwallowed) return false;
  const r = await electionPhase(game);
  return r === 'dayEnded';
}

async function runGameInner(game, resumeFrom = null) {
  game._shots = game._shots || [];
  game.lastProtectMap = game.lastProtectMap || {};
  let dayEnded = false;
  if (resumeFrom) {
    // 断点恢复：从锚点快照继续（跳过发牌与开局流程，锚点处已含完整状态与 AI 记忆）
    game.logger.info('engine', `========== 对局恢复：从「${resumeFrom === 'night' ? '夜晚' : '白天'}」锚点继续 ==========`);
    dayEnded = resumeFrom === 'night'; // 夜晚锚点：本轮先跳过白天，直接重放夜晚
  } else {
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
    if (await firstNightElection(game)) game._dayEnded = true;
    await dawnPhase(game);
    dayEnded = !!game._dayEnded;
    game._dayEnded = false;
  }
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
    // 恢复重放到"首夜"时，这里同样要补上警长竞选（与开新局路径严格一致）
    if (resumeFrom === 'night' && await firstNightElection(game)) dayEnded = true;
    await dawnPhase(game);
  }
  game.finish();
  game.logger.info('engine', `对局结束：${game.winner} —— ${game.winReason}，共 ${game.day} 天`, {
    llmStats: game.llmStats,
  });
}

module.exports = { runGame, validatePayload, secretVote, buildSpeechOrder, checkWinWithPending,
  // 供单元测试直接驱动内部阶段
  _internals: { askValidated, nightPhase, resolveNightDeaths, dawnPhase, settleDeath, electionPhase, speechPhase, votePhase, exile, handleExplode, consumeExplodeRequest, handleDuel, consumeDuelRequest, daySkillCheck, witchStep, guardStep, wolfStep, seerStep, admirerStep, dreamerStep, wolfbeautyStep, crowStep, NIGHT_STEPS, TASK_VALIDATORS } };
