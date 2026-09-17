/**
 * game.js — 对局状态、事件日志、可见性隔离、输入等待
 * 隔离原则：任何一侧（人类前端 / AI 上下文 / 日志回放）都只能通过 visibleEvents() 取事件。
 */
'use strict';
const { ROLES, buildRoleDeck, validateBoard } = require('./roles');
const { mergeRules, describeRules } = require('./rules');
const { makeRng, seedFrom } = require('./rng');
const { assertEventVisibility } = require('./visibility');
const { sanitizeInline } = require('./text');
const { GamePaused } = require('../errors');

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
    // 多 Key（keypool）时才允许"互不依赖的调用扇出"：单 Key 下扇出只是换个写法，
    // 却会让 beginLive/endLive 的区间重叠（"正在思考"提示会显示错人）。所以默认关，多 Key 才开。
    this.parallelLlm = !!opts.parallelLlm;
    // 确定性随机源：显式 seed 时"同种子同配置 = 同一局"；否则按 id 派生后掺入时间。
    // 它的 32 位状态会进锚点快照，恢复时精确续上（决策 journal 命中的前提）。
    // 种子显式留档：提示词校验码（spotlight）与"同种子可复现"都依赖它，恢复对局后必须一致
    this.seed = opts.seed != null ? opts.seed : (seedFrom(opts.id || 'ww') ^ (Date.now() & 0xffffffff)) >>> 0;
    this.rng = makeRng(this.seed);
    this.rnd = () => this.rng();
    this.promptNonce = null; // 提示词注入防御的本局校验码，懒生成（见 src/ai/spotlight.js）
    this.players = opts.players.map((p, i) => ({
      seat: i + 1,
      // 昵称/人格会直接嵌进提示词的结构行，必须单行化并剔除结构标记字符（玩家可自行填写这些字段）
      name: sanitizeInline(p.name || `${i + 1}号玩家`, 20),
      isHuman: !!p.isHuman,
      personality: sanitizeInline(p.personality || '', 200),
      personaName: sanitizeInline(p.personaName || '', 24),
      personaTag: sanitizeInline(p.personaTag || '', 12),
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
    this.paused = null;      // 因配额/套餐等外部原因暂停 {kind, code, message, nextFlushTime, at, seat, task}
    this.pendingDeaths = []; // 已结算未公布 [{seat, cause}]
    this.live = null;        // 流式直播缓冲（半成品文本，不进 events，见 beginLive/liveFor）
    this.memory = null;      // 日切反思进度 {day, total, done}（前端"AI 正在整理记忆…"）
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
    this._agentStates = new Map(); // 恢复对局时的待回填记忆（agent 惰性创建，见 restoreAgentState）
    this._abort = new AbortController(); // terminate() 时中断在途 LLM 调用，结束对局立即生效
    this._anchor = null;       // 断点恢复锚点（markAnchor 在白天/夜晚边界拍摄）
    this.llmStats = { calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, errors: 0, compressions: 0,
      ttftMsTotal: 0, ttftCount: 0, ttftMsMax: 0, streamedCalls: 0,
      latencyMsTotal: 0, latencyMsMax: 0, latencies: [] }; // latencies 只留最近 300 次（p90 用）
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
  /**
   * 发事件。**可见性 fail-closed**：类型未登记、私密事件没给座位、混合类型走默认值，一律抛错。
   * 详见 src/engine/visibility.js —— 事件流是唯一的隔离出口，这里不允许"忘了写就默认公开"。
   */
  emit(type, { actor = null, data = {}, text = '', visibleTo } = {}) {
    assertEventVisibility(type, visibleTo, this.players.length);
    const vis = visibleTo === undefined ? 'all' : visibleTo; // public 类型的规范化：省略即公开
    const e = {
      seq: ++this.seq, day: this.day, phase: this.phase, type, actor, data, text, visibleTo: vis, ts: Date.now(),
    };
    this.events.push(e);
    this.logger.debug('engine', `d${this.day}/${this.phase} ${type} vis=${Array.isArray(vis) ? vis.join(',') : vis} | ${text.slice(0, 80)}`, { seq: e.seq });
    return e;
  }

  /** 唯一的可见性入口：viewer = 座位数 或 'god' */
  visibleEvents(viewer, afterSeq = 0) {
    if (viewer === 'god') return this.events.filter((e) => e.seq > afterSeq);
    return this.events.filter((e) => e.seq > afterSeq && (e.visibleTo === 'all' || (Array.isArray(e.visibleTo) && e.visibleTo.includes(viewer))));
  }

  // ---------- 发牌 ----------
  deal() {
    const deck = shuffle(buildRoleDeck(this.board), this.rnd);
    this.phase = 'setup';
    this.emit('phase', { data: { title: `游戏开始（${this.players.length}人局）` }, text: '游戏开始，身份牌随机发放。' });
    this.players.forEach((p, i) => {
      p.role = deck[i];
      this.emit('deal', { actor: p.seat, visibleTo: [p.seat], data: { role: p.role }, text: `${p.seat}号获得身份` });
    });
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
      // 配额耗尽 / 套餐受限 / 鉴权失败：重试无用，降级＝一局烂棋。
      // 暂停对局并明示原因，沿流程栈解出到 runGame（不判负、不结束），等恢复后从锚点继续。
      if (err && err.fatal) {
        this.pause({
          kind: err.kind, code: err.code, message: err.message,
          nextFlushTime: err.nextFlushTime || null, seat, task: request.task,
        });
        throw new GamePaused(this.paused);
      }
      // 终止对局时不再降级续跑：直接抛出让 runGame 优雅结算（否则还要等下一轮校验/降级才退出）
      if (this.forceEnded) throw new ForceEnded();
      return null; // 由 flow 走降级
    }
  }

  /**
   * 日切边界：让已创建的 AI 智能体在后台（优先级 reflection）整理上一天纪要，不阻塞流程。
   * 只通知"已经创建过"的智能体：还没上过场的没有记忆需要维护，等它首次决策时再惰性补齐。
   */
  scheduleReflection(completedDay) {
    const agents = [...this._agents.values()].filter((a) => a && typeof a.scheduleReflection === 'function');
    if (!agents.length) return 0;
    this.memory = { day: completedDay, total: agents.length, done: 0, startedAt: Date.now() };
    for (const a of agents) {
      const p = a.scheduleReflection(completedDay);
      if (p && typeof p.then === 'function') p.then(() => this.memoryDone(), () => this.memoryDone());
      else this.memoryDone();
    }
    return agents.length;
  }

  /** 日切反思进度：全部结束后清空（前端据此显示"AI 正在整理记忆…"） */
  memoryDone() {
    if (!this.memory) return;
    this.memory.done++;
    if (this.memory.done >= this.memory.total) this.memory = null;
  }

  /**
   * 暂停对局（外部原因：配额耗尽/套餐受限）。
   * 与 terminate 的区别：不判负、不置 finished，状态与锚点原样保留，可恢复续跑。
   */
  pause(info = {}) {
    if (this.finished) return;
    this.paused = { ...info, at: Date.now() };
    this.emit('game_paused', { visibleTo: 'all', data: { ...this.paused } });
    this.logger.warn('engine', `对局暂停：${this.paused.message}（第 ${this.day} 天 · ${this.phase}）`, { paused: this.paused });
  }

  // ---------- 直播缓冲：流式生成的半成品文本 ----------
  /**
   * 刻意不进 events。events 会进存档、进 AI 上下文聚合、进前端事件流；
   * 而半成品文本既不该被 AI 看到，也不该把存档撑大（一次发言有上百个增量）。
   * 它只作为 /view 的一个瞬时字段下发，决策结束（成功/失败/暂停）立即清空。
   */
  beginLive(info = {}) {
    this.live = {
      seat: info.seat, task: info.task, public: !!info.public,
      text: '', reasoning: '', startedAt: Date.now(), updatedAt: Date.now(),
    };
  }

  updateLive(delta) {
    if (!this.live || !delta) return;
    if (delta.content) this.live.text += delta.content;
    if (delta.reasoning) this.live.reasoning += delta.reasoning;
    this.live.updatedAt = Date.now();
  }

  endLive() { this.live = null; }

  /**
   * 谁能看到这段直播：上帝看全部（含内心独白）；公开发言所有人可见；其余仅发言者本人。
   * 非上帝视角一律剥掉 reasoning——内心独白只属于上帝面板。
   */
  liveFor(viewer) {
    const l = this.live;
    if (!l) return null;
    if (viewer === 'god') return l;
    if (l.seat === Number(viewer) || l.public) {
      return { seat: l.seat, task: l.task, public: l.public, text: l.text, startedAt: l.startedAt, updatedAt: l.updatedAt };
    }
    return null;
  }

  agentFor(seat) {
    if (!this._agents.has(seat)) {
      if (!this.agentFactory) throw new Error('未配置 agentFactory');
      const agent = this.agentFactory(this.player(seat), this);
      // 恢复的对局：agent 创建时补上快照里的记忆（见 restoreAgentState 的说明）
      if (this._agentStates && this._agentStates.has(seat)) this._applyAgentState(agent, this._agentStates.get(seat));
      this._agents.set(seat, agent);
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
          this.emit('role_reveal', { visibleTo: 'all', actor: p.seat, data: { seat: p.seat, role: p.role } });
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
      paused: this.paused || null,
      // 随机种子与提示词校验码必须随存档/锚点往返：
      // journal 的命中判据包含 promptHash，若恢复后二者变了，提示词就变了 → 恢复会重新问一遍（幂等性被破坏）
      seed: this.seed, promptNonce: this.promptNonce || null,
    };
  }

  /** AI 智能体状态快照（反思纪要/怀疑度/事件游标），供断点恢复后无缝续跑 */
  serializeAgents() {
    const out = {};
    for (const [seat, agent] of this._agents) {
      if (!agent || typeof agent.digests !== 'object') continue;
      out[seat] = { digests: [...agent.digests.entries()], suspicion: agent.suspicion || {}, lastSeq: agent.lastSeq || 0 };
    }
    return out;
  }

  /**
   * 回填 AI 记忆。**必须在 agent 尚未创建时也能生效**：
   * 恢复流程是 `Game.fromJSON(anchor)` 之后立刻调用本方法，而 agent 是首次 ask 时才惰性创建的，
   * 那时 `_agents` 还是空的——旧实现直接 return，导致"恢复后 AI 记忆（纪要/怀疑度/已读游标）静默丢失"。
   * 现在先存进 `_agentStates`，等 agentFor() 创建时再套用。
   */
  restoreAgentState(seat, state) {
    if (!state) return;
    this._agentStates.set(seat, state);
    const agent = this._agents.get(seat);
    if (agent) this._applyAgentState(agent, state);
  }

  _applyAgentState(agent, state) {
    if (Array.isArray(state.digests)) agent.digests = new Map(state.digests);
    if (state.suspicion && typeof state.suspicion === 'object') agent.suspicion = state.suspicion;
    agent.lastSeq = state.lastSeq || 0;
  }

  /**
   * 断点恢复锚点：在"白天发言开始前"与"夜晚开始前"两个可安全重放的边界拍摄全量快照。
   * 从锚点恢复 = 完整重建对局（含 AI 记忆），重放锚点标记的阶段——无信息丢失、无重复发言。
   *
   * ⚠️ 必须**深拷贝**：`toJSON()` 返回的 events/players 以及下面显式补的这些字段都是**活引用**，
   * 只做 `{...toJSON()}` 浅拷贝的话，锚点会随着对局继续而"长大"——落盘时存下的是"未来"的事件，
   * 而 seq 停在拍摄时刻 → 恢复后新旧事件的 seq 大面积重复，历史被写坏、
   * 决策点错位（决策 journal 全部落空）、甚至恢复局立刻结束。
   */
  markAnchor(nextPhase) {
    const raw = {
      ...this.toJSON(),
      seq: this.seq,
      pendingDeaths: this.pendingDeaths, lastNightDeaths: this.lastNightDeaths,
      night: this.night, witch: this.witch,
      crush: this.crush, charmMap: this.charmMap, lastDreamMap: this.lastDreamMap,
      activeCurse: this.activeCurse, lastProtect: this.lastProtect, lastProtectMap: this.lastProtectMap,
      lastSpeechOrder: this.lastSpeechOrder, _shots: this._shots,
      swallowCount: this.swallowCount, badgeSwallowed: this.badgeSwallowed,
      sheriffElectionPending: this.sheriffElectionPending,
      nextPhase,
      rngState: this.rng.state(), // 随机源状态：重放阶段必须续上，否则决策点错位、journal 命不中
      agentStates: this.serializeAgents(),
    };
    this._anchor = JSON.parse(JSON.stringify(raw));
    return this._anchor;
  }

  /** 从锚点快照重建对局实例（events/players 全量恢复，agent 惰性重建后用 restoreAgentState 回填记忆） */
  static fromJSON(data, opts = {}) {
    const playersMeta = (data.players || []).map((p) => ({
      name: p.name, isHuman: !!p.isHuman, personality: p.personality || '',
      personaName: p.personaName || '', personaTag: p.personaTag || '',
    }));
    const g = new Game({
      id: data.id, board: data.board, rules: data.rules, players: playersMeta,
      agentFactory: opts.agentFactory || null, logger: opts.logger, stepPauseMs: opts.stepPauseMs,
      seed: data.seed, // 恢复种子：提示词校验码由 id+seed 派生，必须与原局一致
    });
    g.promptNonce = data.promptNonce || null;
    g.players.forEach((p, i) => { if (data.players[i]) Object.assign(p, data.players[i]); });
    if (data.rngState != null) g.rng.restore(data.rngState); // 续上锚点时的随机源位置
    g.events = data.events || [];
    g.seq = data.seq || (g.events.length ? g.events[g.events.length - 1].seq : 0);
    g.day = data.day || 0;
    g.phase = data.phase || 'setup';
    g.started = !!data.started;
    g.finished = !!data.finished;
    g.paused = data.paused || null;
    g.winner = data.winner != null ? data.winner : null;
    g.winReason = data.winReason || null;
    g.pendingDeaths = data.pendingDeaths || [];
    g.lastNightDeaths = data.lastNightDeaths || [];
    g.night = data.night || null;
    g.witch = data.witch || { antidoteUsed: false, poisonUsed: false };
    g.crush = data.crush || {};
    g.charmMap = data.charmMap || {};
    g.lastDreamMap = data.lastDreamMap || {};
    g.activeCurse = data.activeCurse || [];
    g.lastProtect = data.lastProtect || 0;
    g.lastProtectMap = data.lastProtectMap || {};
    g.lastSpeechOrder = data.lastSpeechOrder || [];
    g._shots = data._shots || [];
    g.swallowCount = data.swallowCount || 0;
    g.badgeSwallowed = !!data.badgeSwallowed;
    g.sheriffElectionPending = !!data.sheriffElectionPending;
    if (data.llmStats) g.llmStats = data.llmStats;
    // 锚点里的 AI 记忆直接进待回填表：agent 首次 ask 创建时自动补上
    for (const [seat, st] of Object.entries(data.agentStates || {})) g._agentStates.set(Number(seat), st);
    return g;
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
