/**
 * game.js — 对局状态、事件日志、可见性隔离、输入等待
 * 隔离原则：任何一侧（人类前端 / AI 上下文 / 日志回放）都只能通过 visibleEvents() 取事件。
 */
'use strict';
const { ROLES, buildRoleDeck, validateBoard } = require('./roles');
const { mergeRules, describeRules } = require('./rules');

function shuffle(arr, rnd = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class ForceEnded extends Error {
  constructor() {
    super('对局被手动终止');
    this.code = 'FORCE_ENDED';
  }
}

class Game {
  /**
   * @param opts { id, board(roles map), rules, players:[{name,isHuman,personality}], agentFactory, logger }
   */
  constructor(opts) {
    const boardRoles = opts.board;
    const check = validateBoard(boardRoles);
    if (!check.ok) throw new Error('板子不合法：' + check.errors.join('；'));
    if (opts.players.length !== check.total) throw new Error(`玩家数(${opts.players.length})与板子人数(${check.total})不一致`);

    this.id = opts.id;
    this.board = boardRoles;
    this.rules = mergeRules(opts.rules);
    this.players = opts.players.map((p, i) => ({
      seat: i + 1,
      name: String(p.name || `${i + 1}号玩家`).slice(0, 20),
      isHuman: !!p.isHuman,
      personality: String(p.personality || '').slice(0, 200),
      personaName: String(p.personaName || '').slice(0, 24),
      personaTag: String(p.personaTag || '').slice(0, 12),
      role: null, alive: true, revealed: false,
      lostVote: false,        // 白痴免疫后失去投票权
      isSheriff: false,
      everRanSheriff: false,  // 曾上警（失去警长竞选投票权）
    }));
    this.agentFactory = opts.agentFactory || null;
    this.logger = opts.logger || { debug() {}, info() {}, warn() {}, error() {} };

    this.events = [];
    this.seq = 0;
    this.day = 0;            // 夜晚开始时 +1；第 1 夜后是第 1 天
    this.phase = 'setup';
    this.pending = null;     // 等待人类输入 {seat, request, resolve}
  this.explodeRequest = null; // 人类狼的“随时自爆”请求 {seat, target}（白天任意时刻写入，引擎在最近的发言间隙消费）
  this.duelRequest = null;    // 人类骑士的“随时决斗”请求 {seat, target}
    this.winner = null;
    this.winReason = null;
    this.started = false;
    this.finished = false;
    this.pendingDeaths = []; // 已结算未公布 [{seat, cause}]
    this.night = null;       // 当夜临时状态 {guardTargets, lastProtect, wolfKill, saved, poisonTargets...}
    this.badgeSwallowed = false;
    this.swallowCount = 0;   // 竞选阶段自爆次数（双爆吞警徽用）
    this.sheriffElectionPending = false;
    this.lastSpeechOrder = [];
    this.lastProtect = 0;    // 守卫上一夜守护目标（跨夜）
    this.lastDreamMap = {};  // 摄梦人上一夜摄梦目标（跨夜，seat→target）
    this.charmMap = {};      // 狼美人当前魅惑目标（wolfbeautySeat→targetSeat）
    this.crush = {};         // 暗恋者暗恋对象（seat→targetSeat，首夜后终身有效）
    this.activeCurse = [];   // 乌鸦诅咒生效中的座位（当日放逐投票 +0.5 票）
    this.witch = { antidoteUsed: false, poisonUsed: false };
    this._agents = new Map();
    this._abort = new AbortController(); // terminate() 时中断在途 LLM 调用，结束对局立即生效
    this.llmStats = { calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, errors: 0, compressions: 0 };
    this.stepPauseMs = opts.stepPauseMs != null ? opts.stepPauseMs : 2000; // 夜晚死角色步骤的固定停顿（测试可置 0）
  }

  get abortSignal() { return this._abort.signal; }

  player(seat) { return this.players[seat - 1]; }
  alivePlayers() { return this.players.filter((p) => p.alive); }
  aliveSeats() { return this.alivePlayers().map((p) => p.seat); }
  wolves() { return this.players.filter((p) => ROLES[p.role] && ROLES[p.role].category === 'wolf'); }
  aliveWolves() { return this.wolves().filter((p) => p.alive); }
  aliveOfRole(roleId) { return this.players.filter((p) => p.alive && p.role === roleId); }
  sheriff() { return this.players.find((p) => p.isSheriff) || null; }

  /** 某玩家"可见"的狼队队友：隐狼认识所有狼，但其他狼不知道隐狼（网易官方互认规则） */
  matesOf(player) {
    return this.wolves().filter((w) => {
      if (w.seat === player.seat) return false;
      if (player.role === 'hiddenwolf') return true;
      return w.role !== 'hiddenwolf';
    });
  }

  /** 夜晚参与狼队行动（讨论/刀口）的狼：不含夜里不睁眼的隐狼 */
  nightWolves() { return this.aliveWolves().filter((p) => p.role !== 'hiddenwolf'); }

  /** 玩家的有效阵营类别（暗恋者随绑定对象终身变动，用于屠边胜负判定） */
  categoryOf(p) {
    if (p.role === 'admirer' && this.crush[p.seat]) {
      const t = this.player(this.crush[p.seat]);
      if (t && t.role && ROLES[t.role]) return ROLES[t.role].category;
    }
    return (ROLES[p.role] && ROLES[p.role].category) || 'villager';
  }

  // ---------- 事件 ----------
  emit(type, { actor = null, data = {}, text = '', visibleTo = 'all' } = {}) {
    const e = {
      seq: ++this.seq, day: this.day, phase: this.phase, type, actor, data, text, visibleTo, ts: Date.now(),
    };
    this.events.push(e);
    this.logger.debug('engine', `d${this.day}/${this.phase} ${type} vis=${Array.isArray(visibleTo) ? visibleTo.join(',') : visibleTo} | ${text.slice(0, 80)}`, { seq: e.seq });
    return e;
  }

  /** 唯一的可见性入口：viewer = 座位数 或 'god' */
  visibleEvents(viewer, afterSeq = 0) {
    if (viewer === 'god') return this.events.filter((e) => e.seq > afterSeq);
    return this.events.filter((e) => e.seq > afterSeq && (e.visibleTo === 'all' || (Array.isArray(e.visibleTo) && e.visibleTo.includes(viewer))));
  }

  // ---------- 发牌 ----------
  deal() {
    const deck = shuffle(buildRoleDeck(this.board));
    this.phase = 'setup';
    this.emit('phase', { data: { title: `游戏开始（${this.players.length}人局）` }, text: '游戏开始，身份牌随机发放。' });
    this.players.forEach((p, i) => {
      p.role = deck[i];
      this.emit('deal', { actor: p.seat, visibleTo: [p.seat], data: { role: p.role }, text: `${p.seat}号获得身份` });
    });
    const wolfSeats = this.wolves().map((p) => p.seat);
    for (const w of this.wolves()) {
      const mates = this.matesOf(w).map((p) => p.seat);
      this.emit('teammates', { actor: w.seat, visibleTo: [w.seat], data: { seats: mates }, text: `${w.seat}号获知狼队` });
    }
    this.started = true;
    this.logger.info('engine', `发牌完成：${this.players.map((p) => `${p.seat}=${ROLES[p.role].name}`).join(' ')}`);
  }

  // ---------- 输入等待 ----------
  /** 向一个座位请求决策。人类挂起等待（无限时），AI 交给 agent。
   *  遗言/警徽/开枪等任务允许已出局的座位响应（request._allowDead = true）。 */
  async ask(seat, request) {
    if (this.forceEnded) throw new ForceEnded();
    const p = this.player(seat);
    if (!p || (!p.alive && !request._allowDead)) throw new Error(`座位${seat}无法响应（不存在或已出局）`);
    if (p.isHuman) {
      return new Promise((resolve, reject) => {
        this.pending = { seat, request, resolve, reject };
        this.logger.info('engine', `等待人类玩家 ${seat}号 操作：${request.task}`);
      });
    }
    const agent = this.agentFor(seat);
    this.emit('ai_thinking', { actor: seat, visibleTo: [seat], data: { task: request.task } });
    const t0 = Date.now();
    try {
      const value = await agent.decide(request);
      this.logger.debug('ai', `${seat}号 ${request.task} → ${JSON.stringify(value).slice(0, 120)} (${Date.now() - t0}ms)`);
      return value;
    } catch (err) {
      this.llmStats.errors++;
      this.logger.error('ai', `${seat}号 ${request.task} 智能体异常`, { stack: err && err.stack });
      this.emit('llm_error', { actor: seat, visibleTo: 'god', data: { task: request.task, message: String(err && err.message || err) } });
      // 终止对局时不再降级续跑：直接抛出让 runGame 优雅结算（否则还要等下一轮校验/降级才退出）
      if (this.forceEnded) throw new ForceEnded();
      return null; // 由 flow 走降级
    }
  }

  agentFor(seat) {
    if (!this._agents.has(seat)) {
      if (!this.agentFactory) throw new Error('未配置 agentFactory');
      this._agents.set(seat, this.agentFactory(this.player(seat), this));
    }
    return this._agents.get(seat);
  }

  /** 人类提交操作（API 层调用）。失败返回 {ok:false,error}，pending 保留供重试。 */
  resolveHuman(payload) {
    if (!this.pending) return { ok: false, error: '当前没有等待你的操作' };
    const { request, resolve } = this.pending;
    const { validatePayload } = require('./flow');
    const seat = this.pending.seat;
    const ctx = request._ctx || request;
    const v = validatePayload(request.task, payload, ctx, this, seat);
    if (!v.ok) return { ok: false, error: v.error };
    this.pending = null;
    resolve(v.value);
    return { ok: true };
  }

  /** 手动终止对局：中断当前等待（人类 pending 直接拒绝；在途 LLM 调用经 abortSignal 立即中止） */
  terminate(reason = '玩家手动终止对局') {
    if (this.finished) return;
    this.forceEnded = true;
    this.terminateReason = reason;
    try { this._abort.abort(); } catch (_) { /* 已 abort */ }
    const p = this.pending;
    this.pending = null;
    if (p && p.reject) p.reject(new ForceEnded());
    this.logger.info('engine', `对局被终止：${reason}`);
  }

  // ---------- 胜负 ----------
  checkWin() {
    const alive = this.alivePlayers();
    const wolves = alive.filter((p) => this.categoryOf(p) === 'wolf');
    if (wolves.length === 0) return { winner: 'good', reason: '所有狼人已出局，好人阵营获胜！' };
    const gods = alive.filter((p) => this.categoryOf(p) === 'god');
    const villagers = alive.filter((p) => this.categoryOf(p) === 'villager');
    if (gods.length === 0) return { winner: 'wolf', reason: '所有神职出局，狼人屠边成功！' };
    if (villagers.length === 0) return { winner: 'wolf', reason: '所有平民出局，狼人屠边成功！' };
    return null;
  }

  finish() {
    const w = this.checkWin() || this._lastWin;
    if (!this.finished) {
      this.phase = 'over';
      if (w) { this.winner = w.winner; this.winReason = w.reason; }
      else if (this.winner == null) {
        this.winner = 'none';
        this.winReason = this.terminateReason || '对局终止';
      }
      this.emit('game_over', { data: { winner: this.winner, reason: this.winReason } });
      // 结算全员亮牌
      for (const p of this.players) {
        if (!p.revealed) {
          p.revealed = true;
          this.emit('role_reveal', { actor: p.seat, data: { seat: p.seat, role: p.role } });
        }
      }
      this.finished = true;
      this.logger.info('engine', `对局结束：${this.winner} — ${this.winReason}`);
    }
    return this.winner;
  }

  // ---------- 序列化 ----------
  toJSON() {
    return {
      id: this.id, board: this.board, rules: this.rules,
      players: this.players, events: this.events,
      day: this.day, phase: this.phase, winner: this.winner, winReason: this.winReason,
      started: this.started, finished: this.finished, llmStats: this.llmStats,
    };
  }

  configSnapshot() {
    const roles = Object.entries(this.board).filter(([, n]) => n > 0).map(([r, n]) => `${ROLES[r].name}×${n}`).join(' ');
    return {
      board: roles, seatCount: this.players.length,
      seats: this.players.map((p) => `${p.seat}=${p.name}${p.isHuman ? '(人类)' : ''}`),
      rulesText: describeRules(this.rules),
    };
  }
}

module.exports = { Game, shuffle };
