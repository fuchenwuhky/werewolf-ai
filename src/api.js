/**
 * api.js — REST API 路由（零依赖，基于 node:http）
 *
 * 端点：
 *  GET  /api/meta                       角色/板子/规则开关元数据（设置页与规则书用）
 *  GET  /api/config                     读取 API 配置（key 掩码）
 *  PUT  /api/config                     保存 API 配置（config.json）
 *  POST /api/config/test                测试 LLM 连接
 *  POST /api/games                      创建对局 → {gameId, playerToken, godToken}
 *  POST /api/games/:id/start            开局（后台运行状态机）
 *  GET  /api/games/:id/view             增量拉取（token 决定可见性）
 *  POST /api/games/:id/action           人类玩家提交操作
 *  GET  /api/games/:id/logs             上帝：日志查询
 *  GET  /api/games/:id/agent            上帝：AI 上下文调试
 *  GET  /api/games/:id/replay           上帝：完整复盘 JSON
 *  GET  /api/games                      本地存档列表
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROLES, BOARDS, validateBoard } = require('./engine/roles');
const { DEFAULT_RULES, RULE_META, mergeRules } = require('./engine/rules');
const { Game } = require('./engine/game');
const { runGame } = require('./engine/flow');
const { makeAgentFactory } = require('./ai/agent');
const { applyPersonalities, PERSONALITIES } = require('./ai/personalities');
const { STRATEGY_TEMPLATES } = require('./ai/strategies');
const { makeMockAgentFactory } = require('../scripts/mock-agent');
const { testConnection } = require('./ai/llm');
const { maskKey, makeGameLogger } = require('./log');
const { ALL: NAME_POOL } = require('./names');

const APP_DATA_DIR = process.env.WW_DATA_DIR || process.env.DATADIR;
const SAVE_DIR = APP_DATA_DIR
  ? path.join(APP_DATA_DIR, 'saves')
  : path.join(__dirname, '..', 'saves');
const ROLE_ASSETS_DIR = path.join(__dirname, '..', 'web', 'assets', 'roles');

/** 扫描已存在的角色卡图片（<roleId>.png/.webp/.svg），png 优先；meta 下发后前端直接引用 */
function roleArtMap() {
  const rank = { '.png': 3, '.webp': 2, '.svg': 1 };
  const map = {};
  try {
    for (const f of fs.readdirSync(ROLE_ASSETS_DIR)) {
      const m = f.match(/^([a-z_]+)\.(png|webp|svg)$/i);
      if (m && ROLES[m[1]]) {
        const ext = '.' + m[2].toLowerCase();
        if (!map[m[1]] || rank[ext] > rank[map[m[1]]]) map[m[1]] = ext;
      }
    }
  } catch (_) { /* 目录不存在 */ }
  return map;
}

function tokenId() { return crypto.randomBytes(16).toString('hex'); }

class Api {
  constructor({ config, logger }) {
    this.config = config;      // {get(), save(partial)}
    this.logger = logger;
    this.games = new Map();    // gameId → {game, tokens:{player,god}, running, error, saveTimer}
    if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });
    // 定时持久化进行中的对局
    this._saveTimer = setInterval(() => this.saveActive(), 4000);
    this._saveTimer.unref && this._saveTimer.unref();
  }

  // ---------- 工具 ----------
  json(res, code, data) {
    const body = JSON.stringify(data);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  async readBody(req, limit = 2 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('JSON 解析失败')); }
      });
      req.on('error', reject);
    });
  }

  getGame(id) { return this.games.get(id); }

  saveGame(entry) {
    try {
      // 令牌一并存档：本地单机应用，浏览器丢失会话时可从存档恢复对局
      fs.writeFileSync(path.join(SAVE_DIR, `${entry.game.id}.json`), JSON.stringify({ tokens: entry.tokens, game: entry.game.toJSON() }));
    } catch (e) { this.logger.warn('api', `存档失败 ${entry.game.id}: ${e.message}`); }
  }

  saveActive() {
    for (const entry of this.games.values()) {
      if (entry.game.started && !entry.game.finished) this.saveGame(entry);
    }
  }

  // ---------- 路由 ----------
  async handle(req, res, pathname, query) {
    const method = req.method;
    try {
      if (pathname === '/api/meta' && method === 'GET') return this.json(res, 200, {
        roles: ROLES,
        boards: BOARDS,
        ruleMeta: RULE_META,
        defaultRules: DEFAULT_RULES,
        names: NAME_POOL,
        personas: PERSONALITIES.map((p) => ({ id: p.id, name: p.name, tag: p.tag })),
        roleStrategies: STRATEGY_TEMPLATES,
        roleArt: roleArtMap(),
      });

      if (pathname === '/api/config' && method === 'GET') {
        const c = this.config.get();
        return this.json(res, 200, {
          baseUrl: c.baseUrl, model: c.model, apiKeyMasked: maskKey(c.apiKey), hasKey: !!c.apiKey,
          temperature: c.temperature, maxTokens: c.maxTokens, cacheControl: !!c.cacheControl,
          reasoningEffort: c.reasoningEffort || 'high', fastEffort: c.fastEffort || 'low',
          fastMaxTokens: c.fastMaxTokens || 8000, contextBudget: c.contextBudget || 12000,
        });
      }
      if (pathname === '/api/config' && method === 'PUT') {
        const body = await this.readBody(req);
        const saved = this.config.save(body);
        this.logger.info('api', 'API 配置已更新', { baseUrl: saved.baseUrl, model: saved.model, key: maskKey(saved.apiKey) });
        return this.json(res, 200, { ok: true, apiKeyMasked: maskKey(saved.apiKey) });
      }
      if (pathname === '/api/config/test' && method === 'POST') {
        const c = this.config.get();
        if (!c.apiKey) return this.json(res, 400, { ok: false, error: '请先填写 API Key' });
        const r = await testConnection(c, this.logger);
        return this.json(res, r.ok ? 200 : 502, r);
      }

      const gameMatch = pathname.match(/^\/api\/games\/([^/]+)(\/.*)?$/);
      if (pathname === '/api/games' && method === 'POST') return this.createGame(res, await this.readBody(req));
      if (pathname === '/api/games' && method === 'GET') return this.listSaves(res);
      if (gameMatch) {
        const id = gameMatch[1];
        const sub = gameMatch[2] || '';
        const entry = this.getGame(id);
        if (!entry) return this.json(res, 404, { error: '对局不存在' });
        if (sub === '/start' && method === 'POST') return this.startGame(res, entry, await this.readBody(req));
        if (sub === '/terminate' && method === 'POST') return this.terminateGame(res, entry, await this.readBody(req));
        if (sub === '/view' && method === 'GET') return this.view(res, entry, query);
        if (sub === '/tokens' && method === 'GET') return this.tokens(res, entry);
        if (sub === '/action' && method === 'POST') return this.action(res, entry, await this.readBody(req));
        if (sub === '/explode' && method === 'POST') return this.explodeAction(res, entry, await this.readBody(req));
        if (sub === '/duel' && method === 'POST') return this.duelAction(res, entry, await this.readBody(req));
        if (sub === '/wolftalk' && method === 'POST') return this.wolfTalk(res, entry, await this.readBody(req));
        if (sub === '/logs' && method === 'GET') return this.logs(res, entry, query);
        if (sub === '/agent' && method === 'GET') return this.agentDebug(res, entry, query);
        if (sub === '/replay' && method === 'GET') return this.replay(res, entry, query);
      }

      return this.json(res, 404, { error: 'not found' });
    } catch (err) {
      this.logger.error('api', `接口异常 ${method} ${pathname}: ${err.message}`, { stack: err.stack });
      return this.json(res, 500, { error: String(err.message || err) });
    }
  }

  // ---------- 实现 ----------
  createGame(res, body) {
    const boardDef = body.boardId && BOARDS[body.boardId] ? BOARDS[body.boardId] : null;
    const board = boardDef ? boardDef.roles : body.board;
    const check = validateBoard(board);
    if (!check.ok) return this.json(res, 400, { error: '板子不合法：' + check.errors.join('；') });
    const players = Array.isArray(body.players) ? body.players : [];
    if (players.length !== check.total) return this.json(res, 400, { error: `玩家数(${players.length})与板子人数(${check.total})不一致` });
    const humans = players.filter((p) => p.isHuman).length;
    if (humans > 1) return this.json(res, 400, { error: '最多 1 名人类玩家' });
    // 规则优先级：用户设置 > 板子内置板规（如狼美人局女巫不可自救） > 默认值
    const rules = mergeRules({ ...(boardDef && boardDef.rules || {}), ...(body.rules || {}) });
    const useMock = !!body.mock;
    if (!useMock && !this.config.get().apiKey) return this.json(res, 400, { error: '尚未配置 API Key（或在设置中勾选 Mock 试玩）' });

    const gameId = 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    const llmCfg = { ...this.config.get() };
    // 盖 gameId 戳的对局日志器：引擎与 AI 调用的日志同时进 server.log 和 game-<id>.log
    const logger = makeGameLogger(this.logger, gameId);
    const agentFactory = useMock
      ? makeMockAgentFactory(Math.random, { explodeRate: 0.02 })
      : makeAgentFactory(llmCfg, logger);

    // 性格：玩家自定义优先，未填写的 AI 随机分配（每局不重样）
    applyPersonalities(players, Math.random);
    const game = new Game({ id: gameId, board, rules, players, agentFactory, logger });
    const entry = {
      game, running: false, error: null,
      tokens: { player: humans ? tokenId() : null, god: tokenId() },
    };
    this.games.set(gameId, entry);
    logger.openGameLog(gameId);
    logger.info('api', `对局已创建 ${gameId}（${useMock ? 'Mock' : llmCfg.model}，${check.total}人）`, { gameId });
    this.saveGame(entry);
    return this.json(res, 200, { gameId, playerToken: entry.tokens.player, godToken: entry.tokens.god, mock: useMock });
  }

  startGame(res, entry, body) {
    if (entry.running) return this.json(res, 409, { error: '对局已开始' });
    if (body.token !== entry.tokens.player && body.token !== entry.tokens.god) {
      return this.json(res, 403, { error: 'token 无效' });
    }
    entry.running = true;
    runGame(entry.game).then(() => {
      this.saveGame(entry);
      this.logger.closeGameLog(entry.game.id);
    }).catch((err) => {
      entry.error = String(err.stack || err.message || err);
      this.logger.error('engine', `对局 ${entry.game.id} 异常终止`, { stack: err.stack });
      this.saveGame(entry);
    });
    return this.json(res, 200, { ok: true });
  }

  /** 人类狼的随时自爆：校验后写入 game.explodeRequest，引擎在最近的发言间隙执行 */
  explodeAction(res, entry, body) {
    const { game } = entry;
    if (body.token !== entry.tokens.player) return this.json(res, 403, { error: '仅玩家本人可自爆' });
    if (game.finished) return this.json(res, 409, { error: '对局已结束' });
    const me = game.players.find((p) => p.isHuman);
    if (!me || !me.alive) return this.json(res, 409, { error: '你已出局，无法自爆' });
    if (!game.rules.allowSelfExplode) return this.json(res, 409, { error: '本局规则不允许自爆' });
    if (!ROLES[me.role] || !ROLES[me.role].selfExplode) return this.json(res, 409, { error: '你的身份不能自爆' });
    if (game.explodeRequest) return this.json(res, 409, { error: '自爆请求已提交，等待生效' });
    // 硬闸：引擎正等你自己的操作时，打断请求永远不会被消费（会卡死在 pending 上）——明确拒绝
    if (game.pending && game.pending.seat === me.seat) {
      const t = game.pending.request.task;
      return this.json(res, 409, { error: t === 'speech'
        ? '轮到你发言了：请在发言框勾选"自爆"直接发动'
        : '轮到你了：请先完成当前操作，之后再发动自爆' });
    }
    if (!['speech', 'vote', 'pk'].includes(game.phase)) {
      return this.json(res, 409, { error: '自爆只能在白天（发言/投票/PK 阶段）发动' });
    }
    let target = 0;
    if (me.role === 'whitewolfking') {
      target = Number(body.target);
      const tp = Number.isInteger(target) ? game.player(target) : null;
      if (!tp || !tp.alive || target === me.seat) return this.json(res, 400, { error: '白狼王自爆需要指定一名存活的其他玩家' });
    }
    game.explodeRequest = { seat: me.seat, target };
    this.logger.info('api', `${me.seat}号 提交随时自爆（阶段 ${game.phase}${target ? '，带走 ' + target + '号' : ''}）`, { gameId: game.id });
    return this.json(res, 200, { ok: true, queued: true });
  }

  /** 人类骑士的随时决斗：校验后写入 game.duelRequest，引擎在最近的发言间隙执行 */
  duelAction(res, entry, body) {
    const { game } = entry;
    if (body.token !== entry.tokens.player) return this.json(res, 403, { error: '仅玩家本人可发起决斗' });
    if (game.finished) return this.json(res, 409, { error: '对局已结束' });
    const me = game.players.find((p) => p.isHuman);
    if (!me || !me.alive) return this.json(res, 409, { error: '你已出局，无法决斗' });
    if (me.role !== 'knight') return this.json(res, 409, { error: '只有骑士能发起决斗' });
    if (game.duelRequest) return this.json(res, 409, { error: '决斗请求已提交，等待生效' });
    // 硬闸：同自爆——引擎在等你自己的操作时不接受打断请求
    if (game.pending && game.pending.seat === me.seat) {
      return this.json(res, 409, { error: '轮到你了：请先完成当前操作，之后再发起决斗' });
    }
    if (!['speech', 'vote', 'pk'].includes(game.phase)) {
      return this.json(res, 409, { error: '决斗只能在白天（发言/投票/PK 阶段）发动，警长竞选阶段不可' });
    }
    const target = Number(body.target);
    const tp = Number.isInteger(target) ? game.player(target) : null;
    if (!tp || !tp.alive || target === me.seat) return this.json(res, 400, { error: '决斗需要指定一名存活的其他玩家' });
    game.duelRequest = { seat: me.seat, target };
    this.logger.info('api', `${me.seat}号(骑士) 提交随时决斗（阶段 ${game.phase}，目标 ${target}号）`, { gameId: game.id });
    return this.json(res, 200, { ok: true, queued: true });
  }

  /** 手动终止对局（玩家或上帝令牌均可）；未开局的对局直接标记完结并落盘 */
  terminateGame(res, entry, body) {
    const { game } = entry;
    if (body.token !== entry.tokens.player && body.token !== entry.tokens.god) {
      return this.json(res, 403, { error: 'token 无效' });
    }
    if (game.finished) return this.json(res, 409, { error: '对局已结束' });
    if (!game.started) {
      // 创建后从未开始：没有驱动循环可等，直接标记完结，避免残留“永远等待”的僵尸对局
      game.finished = true;
      game.winner = null;
      game.winReason = '对局未开始即被终止';
      this.saveGame(entry);
      this.logger.info('api', `未开局对局 ${game.id} 已被终止清理`);
      return this.json(res, 200, { ok: true, settled: true });
    }
    if (!entry.running) return this.json(res, 409, { error: '对局不在进行中' });
    game.terminate('玩家手动终止对局');
    return this.json(res, 200, { ok: true });
  }

  view(res, entry, query) {
    const { game } = entry;
    const token = query.get('token');
    const after = Number(query.get('after') || 0);
    let viewer;
    if (token === entry.tokens.god) viewer = 'god';
    else if (token && token === entry.tokens.player) viewer = game.players.find((p) => p.isHuman).seat;
    else return this.json(res, 403, { error: 'token 无效' });

    const events = game.visibleEvents(viewer, after);
    const isGod = viewer === 'god';
    const players = game.players.map((p) => {
      const pub = { seat: p.seat, name: p.name, alive: p.alive, isSheriff: p.isSheriff, lostVote: p.lostVote, isHuman: p.isHuman };
      const canSeeRole = isGod || game.finished || p.revealed || (viewer !== 'god' && p.seat === viewer);
      if (canSeeRole && p.role) { pub.role = p.role; pub.revealed = p.revealed; }
      return pub;
    });
    const me = (!isGod && viewer) ? game.player(viewer) : null;
    // 狼队讨论状态：人类狼在讨论期间随时可插话/加轮/结束（上帝也能看进度）
    let wolfTalk = null;
    const wt = game.wolfTalk;
    if (wt && wt.active) {
      const iAmWolf = me && me.alive && me.role && ROLES[me.role].team === 'wolf';
      if (isGod || iAmWolf) wolfTalk = { active: true, round: wt.round, rounds: wt.rounds, canTalk: !isGod && !!iAmWolf };
    }
    const pending = (game.pending && !isGod && game.pending.seat === viewer) ? {
      task: game.pending.request.task,
      candidates: game.pending.request.candidates || null,
      allowNone: !!game.pending.request.allowNone,
      canExplode: !!game.pending.request.canExplode,
      canWithdraw: !!game.pending.request.canWithdraw,
      extra: game.pending.request.extra || null,
    } : null;
    // 已排队未生效的打断请求（自爆/决斗）：让前端常驻提示"当前发言结束后生效"，避免误以为卡死
    const isMe = !isGod && viewer;
    const queued = {
      explode: game.explodeRequest && (!isMe || game.explodeRequest.seat === viewer) ? game.explodeRequest : null,
      duel: game.duelRequest && (!isMe || game.duelRequest.seat === viewer) ? game.duelRequest : null,
    };
    return this.json(res, 200, {
      gameId: game.id, day: game.day, phase: game.phase,
      started: game.started, live: this.games.has(game.id), finished: game.finished, winner: game.winner, winReason: game.winReason,
      error: entry.error,
      players, events, pending, queued, rules: game.rules, wolfTalk,
      me: me ? { seat: me.seat, name: me.name, role: me.role, alive: me.alive, isSheriff: me.isSheriff, lostVote: me.lostVote, teammates: game.wolves().some((w) => w.seat === me.seat) ? game.wolves().filter((w) => w.alive && w.seat !== me.seat).map((w) => w.seat) : [] } : null,
      llmStats: isGod ? game.llmStats : undefined,
      board: game.board,
    });
  }

  action(res, entry, body) {
    const { game } = entry;
    if (!game.pending) return this.json(res, 409, { error: '当前没有等待中的操作' });
    if (body.token !== entry.tokens.player) return this.json(res, 403, { error: 'token 无效' });
    const result = game.resolveHuman(body.payload || {});
    return this.json(res, result.ok ? 200 : 400, result);
  }

  /**
   * 狼队夜间讨论的人类操作（无需等待 pending，随时可发）：
   *  kind=say   插话（text 必填）
   *  kind=extra 给 AI 加一轮讨论（立即生效）
   *  kind=end   提前结束讨论，进入投刀
   */
  wolfTalk(res, entry, body) {
    const { game } = entry;
    if (body.token !== entry.tokens.player) return this.json(res, 403, { error: 'token 无效' });
    const wt = game.wolfTalk;
    if (!wt || !wt.active) return this.json(res, 409, { error: '当前不在狼队讨论阶段' });
    const me = game.players.find((p) => p.isHuman);
    if (!me || !me.alive || !me.role || ROLES[me.role].team !== 'wolf') {
      return this.json(res, 403, { error: '只有存活的人类狼人可以参与狼队讨论' });
    }
    if (body.kind === 'say') {
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 600) : '';
      if (!text) return this.json(res, 400, { error: '发言不能为空' });
      wt.queue.push({ seat: me.seat, text });
      game.logger.debug('engine', `人类狼 ${me.seat} 插话（队列 ${wt.queue.length} 条）`, { gameId: game.id });
    } else if (body.kind === 'extra') {
      if (wt.rounds >= 10) return this.json(res, 400, { error: '讨论轮数已达上限（10 轮）' });
      wt.rounds += 1;
      game.emit('system', { visibleTo: game.wolves().map((p) => p.seat), text: '狼队讨论：人类队友追加了一轮发言机会。' });
    } else if (body.kind === 'end') {
      wt.endNow = true;
    } else {
      return this.json(res, 400, { error: 'kind 必须是 say/extra/end' });
    }
    return this.json(res, 200, { ok: true, wolfTalk: { round: wt.round, rounds: wt.rounds, queued: wt.queue.length } });
  }

  logs(res, entry, query) {
    if (query.get('token') !== entry.tokens.god) return this.json(res, 403, { error: '需要上帝 token' });
    return this.json(res, 200, {
      rows: this.logger.query({
        afterSeq: Number(query.get('after') || 0),
        level: query.get('level') || undefined,
        module: query.get('module') || undefined,
        limit: Number(query.get('limit') || 400),
      }),
    });
  }

  agentDebug(res, entry, query) {
    if (query.get('token') !== entry.tokens.god) return this.json(res, 403, { error: '需要上帝 token' });
    const seat = Number(query.get('seat'));
    if (!seat) return this.json(res, 400, { error: '缺少 seat' });
    const agent = entry.game._agents.get(seat);
    if (!agent) return this.json(res, 404, { error: '该座位没有智能体（人类或未开始）' });
    if (!Array.isArray(agent.messages)) {
      return this.json(res, 200, { seat, turns: agent.turns || 0, contextTokens: 0, tail: [], note: '当前为 Mock 智能体，无 LLM 上下文' });
    }
    const tail = agent.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content.slice(0, 2500) : '[cache-marked system]',
    }));
    if (agent.lastContextText) {
      tail.push({ role: 'user（最近一次组装）', content: String(agent.lastContextText).slice(0, 4000) });
    }
    return this.json(res, 200, {
      seat, turns: agent.turns, contextTokens: agent.contextTokens || 0,
      task: agent.lastRequestTask || '', digests: [...(agent.digests ? agent.digests.keys() : [])],
      tail,
    });
  }

  replay(res, entry, query) {
    if (query.get('token') !== entry.tokens.god) return this.json(res, 403, { error: '需要上帝 token' });
    return this.json(res, 200, entry.game.toJSON());
  }

  /** 本地恢复用：返回对局令牌（仅本机单机应用；浏览器丢失会话时前端自动找回） */
  tokens(res, entry) {
    this.logger.info('api', `令牌找回请求：${entry.game.id}（进行中=${!entry.game.finished}）`);
    return this.json(res, 200, entry.tokens);
  }

  listSaves(res) {
    try {
      const files = fs.readdirSync(SAVE_DIR).filter((f) => f.endsWith('.json'));
      const rows = files.map((f) => {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(SAVE_DIR, f), 'utf8'));
          const g = j.game || j; // 兼容新旧存档格式
          return {
            id: g.id, day: g.day, phase: g.phase, finished: g.finished, started: !!g.started, live: this.games.has(g.id),
            winner: g.winner, winReason: g.winReason,
            seats: g.players.length, date: fs.statSync(path.join(SAVE_DIR, f)).mtime,
          };
        } catch (_) { return null; }
      }).filter(Boolean).sort((a, b) => new Date(b.date) - new Date(a.date));
      return this.json(res, 200, { rows });
    } catch (e) { return this.json(res, 200, { rows: [] }); }
  }
}

module.exports = { Api };
