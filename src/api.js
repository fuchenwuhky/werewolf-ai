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
 *  GET  /api/games/:id/stream           SSE 推送（等价于持续 view，只在变化时推帧）
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

// SSE 推送参数。
// 500ms：比 1.2s 轮询的感知延迟低 2.4×，而"没变化就不构造视图"（cheapSignature）让空转成本≈0。
// 实测取舍（见 docs/upgrade-plan.md §8 P2-2）：空转 30s 下发字节 −95.6%、请求 25→2；
// 但事件持续饱和时，因为推送比轮询勤，总字节会高于轮询 —— 本应用跑在 localhost/局域网，带宽不是瓶颈，
// CPU（构造次数）与延迟才是，所以这个方向是对的。
const STREAM_TICK_MS = 500;
const STREAM_PING_TICKS = 32; // ≈16s 一次心跳：足够让前端发现断线，也不浪费带宽
const { ROLES, BOARDS, validateBoard } = require('./engine/roles');
const { DEFAULT_RULES, RULE_META, mergeRules } = require('./engine/rules');
const { Game } = require('./engine/game');
const { runGame } = require('./engine/flow');
const { computeScores } = require('./engine/score');
const { makeAgentFactory } = require('./ai/agent');
const { DecisionJournal } = require('./ai/journal');
const { makeRng } = require('./engine/rng');
const { scheduler } = require('./ai/scheduler');
const { ExperienceStore } = require('./ai/experience');
const { applyPersonalities, PERSONALITIES } = require('./ai/personalities');
const { STRATEGY_TEMPLATES } = require('./ai/strategies');
const { makeMockAgentFactory } = require('../scripts/mock-agent');
const { testConnection } = require('./ai/llm');
const { maskKey, makeGameLogger } = require('./log');
const { ALL: NAME_POOL } = require('./names');
const { PACES, detectPace, parseApiKeys, resolveChannels, canFanOut } = require('./config');
const { probeKeys } = require('./ai/probe');
const { scheduler: defaultScheduler } = require('./ai/scheduler');

/** 调度器的 Key 池快照（"实际可用并发数"的唯一可信来源，见 /api/config 的 pool 字段） */
function poolSnapshot() {
  const s = defaultScheduler.snapshot();
  return {
    channels: s.channels, keys: s.keys, maxPerKey: s.maxPerKey, adaptive: s.adaptive,
    rateLimited: s.rateLimited, ramps: s.ramps,
    slots: s.slots.map((x) => ({ slot: x.slot, limit: x.limit, inFlight: x.inFlight, disabled: x.disabled, rateLimited: x.rateLimited })),
  };
}
const { reviewFacts, humanSeatOf } = require('./engine/review');
const { generateCoachReview, ruleReview } = require('./ai/coach');
const { extractLiveText } = require('./ai/stream');

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
    this.experience = new ExperienceStore(SAVE_DIR, logger); // 跨局经验池（按角色沉淀 AI 复盘教训）
    // 决策 journal：恢复重放时命中磁盘答案 → 零重复 LLM 调用、逐字复现（P1-1/P1-2）
    this.journalDir = path.join(SAVE_DIR, 'journal');
    this.journal = new DecisionJournal(this.journalDir, {
      enabled: this.config.get().journal !== false,
      logger,
    });
    const pruned = this.journal.prune(); // 每次服务启动清一次：journal 只是缓存，删掉只损失"免费复现"
    if (pruned) this.logger.info('api', `决策 journal 清理了 ${pruned} 个过期文件`);
    if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });
    // 定时持久化进行中的对局
    this._saveTimer = setInterval(() => this.saveActive(), 4000);
    this._saveTimer.unref && this._saveTimer.unref();
    // SSE 订阅：gameId → Set<stream>（P2-2）
    this.streams = new Map();
    this._streamTimer = setInterval(() => this.tickStreams(), STREAM_TICK_MS);
    this._streamTimer.unref && this._streamTimer.unref();
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

  getGame(id) {
    const e = this.games.get(id);
    if (e) e.lastAccess = Date.now();
    return e;
  }

  /** 存档元数据：**不含 events**——事件流只在 anchor 里存一份（旧实现两边都存，46.5% 的体积是纯重复） */
  _saveMeta(game) {
    const { events, ...meta } = game.toJSON();
    return meta;
  }

  /**
   * 存档：脏标记 + 异步写 + 原子替换。
   *
   * 三处改动都有实测依据（真实语料：平均单局 42 分钟、636 次 4s 存盘、每次同步写 1.61ms）：
   *  1. **去重**：`game.toJSON()` 里的 events 不进存档（只有 anchor 需要它）→ 体积直接减半；
   *  2. **脏标记**：seq/day/phase/终局/暂停都没变就不写。LLM 调用动辄十几秒，4s 定时器大部分时间在空转；
   *  3. **异步 + 原子**：先写 `.tmp` 再 rename → 事件循环不再被 writeFileSync 阻塞，进程被杀也不会留下半截存档。
   */
  async saveGame(entry, { force = false } = {}) {
    const game = entry.game;
    const stamp = `${game.seq}|${game.day}|${game.phase}|${game.finished ? 1 : 0}|${game.paused ? 1 : 0}|${game.winner || ''}`;
    if (!force && entry.savedStamp === stamp) return false; // 脏标记：没有变化，一次磁盘都不碰
    if (entry.saving) { entry.pendingSave = true; return false; } // 同一对局不并发写（避免 tmp 互相覆盖）
    entry.savedStamp = stamp;
    entry.saving = true;
    let doc;
    try {
      // 令牌一并存档：本地单机应用，浏览器丢失会话时可从存档恢复对局
      doc = JSON.stringify({
        tokens: entry.tokens,
        mock: !!entry.mock,
        game: this._saveMeta(game),
        anchor: game._anchor || null,
        // 局后点评一并存档：点评花钱花时间，重开页面/重启服务后不该再花一次
        review: entry.review || null,
        savedAt: Date.now(),
      });
    } catch (e) {
      entry.saving = false;
      this.logger.warn('api', `存档序列化失败 ${game.id}: ${e.message}`);
      return false;
    }
    const file = path.join(SAVE_DIR, `${game.id}.json`);
    const tmp = `${file}.tmp`;
    try {
      await fs.promises.writeFile(tmp, doc);
      await fs.promises.rename(tmp, file); // 原子替换：读到的永远是完整存档
    } catch (e) {
      this.logger.warn('api', `存档失败 ${game.id}: ${e.message}`);
    } finally {
      entry.saving = false;
      if (entry.pendingSave) { entry.pendingSave = false; this.saveGame(entry).catch(() => {}); }
    }
    return true;
  }

  /**
   * 内存对局表治理：TTL 清"已结束且久未访问"，LRU 上限兜底。
   * 两者的对象都已在磁盘上，丢弃只影响内存（再次打开会从存档重建）。
   * **绝不动正在跑的对局**——驱动循环还持有它，丢掉会让前端 404。
   */
  pruneGames({ maxEntries = 50, ttlMs = 30 * 60 * 1000 } = {}) {
    const now = Date.now();
    let dropped = 0;
    for (const [id, e] of [...this.games]) {
      if (e.running) continue;
      const idle = now - (e.lastAccess || e.createdAt || now);
      if (idle > ttlMs) { this.games.delete(id); this.closeStreams(id, 'evicted'); dropped++; }
    }
    if (this.games.size > maxEntries) {
      const victims = [...this.games.entries()]
        .filter(([, e]) => !e.running)
        .sort((a, b) => (a[1].lastAccess || 0) - (b[1].lastAccess || 0)); // 最久未访问的先走
      for (const [id] of victims) {
        if (this.games.size <= maxEntries) break;
        this.games.delete(id);
        this.closeStreams(id, 'evicted');
        dropped++;
      }
    }
    if (dropped) this.logger.debug('api', `内存对局表清理 ${dropped} 个（剩 ${this.games.size}）`);
    return dropped;
  }

  loadSaveDoc(id) {
    try {
      return JSON.parse(fs.readFileSync(path.join(SAVE_DIR, `${id}.json`), 'utf8'));
    } catch (_) { return null; }
  }

  /**
   * 统一"从锚点重建"：Game.fromJSON + 回填 AI 记忆（反思纪要/怀疑度/事件游标）。
   * 服务重启续跑与配额暂停恢复共用这一条路径——两者都只是"锚点从磁盘来"还是"从内存来"的区别。
   */
  _rebuildFromAnchor({ id, anchor, mock, tokens, logger, agentFactory, review = null }) {
    const game = Game.fromJSON(anchor, { agentFactory, logger });
    for (const [seat, st] of Object.entries(anchor.agentStates || {})) {
      game.restoreAgentState(Number(seat), st);
    }
    game.paused = null; // 恢复即解除暂停标记
    game.logger.info('engine', `对局 ${id} 从锚点恢复（第 ${game.day} 天 · ${anchor.nextPhase}），记忆回填 ${Object.keys(anchor.agentStates || {}).length} 个 AI`);
    // 点评状态一并恢复；"上次跑到一半就被中断"的记录不恢复（它是残状态，恢复只会显示假的进行中）
    const keepReview = review && review.status === 'done' ? review : null;
    return { game, running: true, error: null, mock, tokens, review: keepReview, createdAt: Date.now(), lastAccess: Date.now() };
  }

  /** 统一的"驱动到终局"：暂停则保留状态等待恢复，结束时落盘 + 生成跨局经验 */
  _drive(entry, resumeFrom = null) {
    const { game } = entry;
    runGame(game, { resumeFrom }).then(async () => {
      if (game.paused) {
        entry.running = false;
        await this.saveGame(entry, { force: true });
        this.logger.warn('api', `对局 ${game.id} 已暂停（${game.paused.kind}/${game.paused.code}）：${game.paused.message}`, { gameId: game.id });
        return; // 不关按局日志、不生成经验：对局尚未结束，恢复后继续
      }
      await this.saveGame(entry, { force: true });
      this.logger.closeGameLog(game.id);
      // 局终复盘：AI 拿"当时的判断"对照"终局真相"提炼经验，存入跨局经验池（mock 对局/失败静默跳过）
      this.generateLessons(entry).catch((e) => {
        this.logger.warn('api', `经验生成失败（不影响对局）: ${e.message}`, { gameId: game.id });
      });
    }).catch(async (err) => {
      entry.error = String(err.stack || err.message || err);
      entry.running = false;
      this.logger.error('engine', `对局 ${game.id} 异常终止`, { stack: err.stack });
      await this.saveGame(entry, { force: true });
    });
    return entry;
  }

  /** 断点恢复（服务重启后）：从存档锚点重建对局，重放锚点标记的阶段并继续驱动 */
  resumeGame(res, entry, body) {
    const id = entry.id;
    if (body.token !== entry.tokens.player && body.token !== entry.tokens.god) {
      return this.json(res, 403, { error: 'token 无效' });
    }
    if (this.games.has(id)) return this.json(res, 409, { error: '对局仍在内存中，直接打开即可' });
    const doc = this.loadSaveDoc(id);
    if (!doc || !doc.anchor) return this.json(res, 404, { error: '没有可恢复的断点（对局可能从未到过白天/夜晚边界）' });
    if (doc.game && doc.game.finished) return this.json(res, 409, { error: '对局已结束' });
    const useMock = !!doc.mock;
    if (!useMock && !this.config.get().apiKey) return this.json(res, 400, { error: '尚未配置 API Key，无法恢复真实 AI 对局' });
    const logger = makeGameLogger(this.logger, id);
    if (typeof logger.openGameLog === 'function') logger.openGameLog(id); // 服务重启后按局日志流需重新打开
    const newEntry = this._rebuildFromAnchor({
      id, anchor: doc.anchor, mock: useMock, logger,
      tokens: { player: tokenId(), god: tokenId() },
      agentFactory: useMock
        ? makeMockAgentFactory(Math.random, { explodeRate: 0.02 })
        : makeAgentFactory({ ...this.config.get() }, logger, this.experience, this.journal),
    });
    this.games.set(id, newEntry);
    this._drive(newEntry, doc.anchor.nextPhase);
    return this.json(res, 200, { gameId: id, playerToken: newEntry.tokens.player, godToken: newEntry.tokens.god, resumed: true });
  }

  /**
   * 暂停恢复（进程未重启）：锚点就在内存里，沿用原令牌，前端无需重新握手。
   * 与 resumeGame 的唯一区别是锚点来源与令牌是否轮换。
   */
  resumePaused(res, entry, body) {
    const { game } = entry;
    const id = game.id;
    if (body.token !== entry.tokens.player && body.token !== entry.tokens.god) {
      return this.json(res, 403, { error: 'token 无效' });
    }
    if (!game.paused) return this.json(res, 409, { error: '对局未处于暂停状态' });
    const anchor = game._anchor;
    if (!anchor) return this.json(res, 409, { error: '没有可恢复的锚点（对局尚未到过白天/夜晚边界）' });
    const logger = makeGameLogger(this.logger, id); // 进程未重启，按局日志流仍在
    const newEntry = this._rebuildFromAnchor({
      id, anchor, mock: !!entry.mock, logger, tokens: entry.tokens,
      agentFactory: entry.mock
        ? makeMockAgentFactory(Math.random, { explodeRate: 0.02 })
        : makeAgentFactory({ ...this.config.get() }, logger, this.experience, this.journal),
    });
    this.games.set(id, newEntry);
    this._drive(newEntry, anchor.nextPhase);
    return this.json(res, 200, { gameId: id, playerToken: newEntry.tokens.player, godToken: newEntry.tokens.god, resumed: true });
  }

  saveActive() {
    this.pruneGames(); // 内存治理与定时落盘同一个节拍：4s 一次
    for (const entry of this.games.values()) {
      if (entry.game.started && !entry.game.finished) {
        // 脏标记在 saveGame 内部判定：没有新事件的节拍一次磁盘都不碰
        this.saveGame(entry).catch((e) => this.logger.warn('api', `定时存档失败 ${entry.game.id}: ${e.message}`));
      }
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
        // 节奏档位（P2-6）：设置页据此渲染选择器，并如实展示"这一档动了哪些内部参数"
        paces: Object.entries(PACES).map(([id, p]) => ({ id, label: p.label, desc: p.desc, values: p.values })),
      });

      if (pathname === '/api/config' && method === 'GET') {
        const c = this.config.get();
        // 直接下发全部配置项（只摘掉密钥），而不是手工维护一份白名单。
        // 白名单曾经漏掉 keepAlive：设置页把它读成 undefined → 复选框永远显示"已勾选"，
        // 用户取消勾选后再改别的设置保存，就会把 keepAlive 静默改回 true。
        // 从 DEFAULT_CONFIG 派生后，新增配置项不会再出现"只能写、读不回来"。
        const cfg = { ...c };
        delete cfg.apiKey;
        // 多出来的 Key（apiKeys）同样是密钥：只回"有几把"，绝不回内容。
        // 不回数量也不行 —— 前端就无从判断"留空"到底是"不修改"还是"清空"。
        delete cfg.apiKeys;
        return this.json(res, 200, {
          ...cfg,
          // 档位是**派生**的：按当前参数反查属于哪一档，都不匹配则 'custom'（前端显示"自定义"，不谎报）
          pace: detectPace(c),
          apiKeyMasked: maskKey(c.apiKey), hasKey: !!c.apiKey,
          extraKeys: (c.apiKeys || []).length,
          channels: resolveChannels(c),
          // 调度器**实时**状态：每把 Key 当前被允许几条泳道（自适应学到/探测到的结果）。
          // 这是"实际可用并发数"的唯一可信来源 —— 不要再用 resolveChannels 反推。
          pool: poolSnapshot(),
        });
      }
      if (pathname === '/api/config' && method === 'PUT') {
        const body = await this.readBody(req);
        const saved = this.config.save(body);
        // 通道数变了要对所有在跑的调度器生效：llm.js 每次调用都会校对，这里只记一条日志便于自查
        const channels = resolveChannels(saved);
        this.logger.info('api', 'API 配置已更新', {
          baseUrl: saved.baseUrl, model: saved.model, key: maskKey(saved.apiKey),
          keys: parseApiKeys(saved).length, channels,
        });
        return this.json(res, 200, {
          ok: true, apiKeyMasked: maskKey(saved.apiKey),
          extraKeys: (saved.apiKeys || []).length,
          channels,
          pool: poolSnapshot(),
        });
      }
      if (pathname === '/api/config/test' && method === 'POST') {
        const c = this.config.get();
        if (!c.apiKey) return this.json(res, 400, { ok: false, error: '请先填写 API Key' });
        const r = await testConnection(c, this.logger);
        return this.json(res, r.ok ? 200 : 502, r);
      }
      /**
       * 探测每把 Key 的**实际**并发额度，并直接写进调度器。
       * 为什么需要：自适应（撞限流砍半、有人排队就加档）最终会收敛，但收敛要赔上几次 429；
       * 主动探一次能直接把起始值放对。代价是每档 n 个 max_tokens=8 的极短请求 —— 必须由用户点击触发。
       */
      if (pathname === '/api/config/probe' && method === 'POST') {
        const c = this.config.get();
        const keys = parseApiKeys(c);
        if (!keys.length) return this.json(res, 400, { ok: false, error: '请先填写 API Key' });
        const body = await this.readBody(req).catch(() => ({}));
        const max = Math.max(1, Math.min(Number(body && body.max) || 4, 8));
        this.logger.warn('api', `开始探测并发额度（最多 ${max} 档 × ${keys.length} 把 Key 的极短请求）`);
        const results = await probeKeys(c, { max, keys });
        for (const r of results) defaultScheduler.setKeyLimit(r.index, r.limit, 'probe');
        const snap = poolSnapshot();
        this.logger.info('api', `探测完成：每把 Key 的并发额度 ${results.map((r) => r.limit).join('/')} → 当前容量 ${snap.channels}`);
        return this.json(res, 200, {
          ok: true, max,
          results: results.map((r) => ({ index: r.index, key: r.key, limit: r.limit, reason: r.reason })),
          pool: snap,
        });
      }

      const gameMatch = pathname.match(/^\/api\/games\/([^/]+)(\/.*)?$/);
      if (pathname === '/api/games' && method === 'POST') return this.createGame(res, await this.readBody(req));
      if (pathname === '/api/games' && method === 'GET') return this.listSaves(res);
      if (pathname === '/api/stats' && method === 'GET') return this.stats(res);
      if (gameMatch) {
        const id = gameMatch[1];
        const sub = gameMatch[2] || '';
        // 断点恢复：① 内存中因配额/套餐暂停的对局 → 从内存锚点续跑
        //           ② 服务重启后已不在内存的对局 → 从存档锚点续跑
        if (sub === '/resume' && method === 'POST') {
          const body = await this.readBody(req);
          const live = this.games.get(id);
          if (live) {
            if (!live.game.paused) return this.json(res, 409, { error: '对局仍在运行中，直接打开即可' });
            return this.resumePaused(res, live, body);
          }
          const doc = this.loadSaveDoc(id);
          if (!doc || !doc.game) return this.json(res, 404, { error: '存档不存在' });
          return this.resumeGame(res, { id, tokens: doc.tokens || {} }, body);
        }
        const entry = this.getGame(id);
        if (!entry) return this.json(res, 404, { error: '对局不存在' });
        if (sub === '/start' && method === 'POST') return this.startGame(res, entry, await this.readBody(req));
        if (sub === '/terminate' && method === 'POST') return this.terminateGame(res, entry, await this.readBody(req));
        if (sub === '/view' && method === 'GET') return this.view(res, entry, query);
        if (sub === '/stream' && method === 'GET') return this.stream(req, res, entry, query);
        if (sub === '/tokens' && method === 'GET') return this.tokens(res, entry);
        if (sub === '/action' && method === 'POST') return this.action(res, entry, await this.readBody(req));
        if (sub === '/review' && method === 'POST') return this.startReview(res, entry, await this.readBody(req));
        if (sub === '/review' && method === 'GET') return this.getReview(res, entry, query);
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
  async createGame(res, body) {
    const boardDef = body.boardId && BOARDS[body.boardId] ? BOARDS[body.boardId] : null;
    const board = boardDef ? boardDef.roles : body.board;
    const check = validateBoard(board);
    if (!check.ok) return this.json(res, 400, { error: '板子不合法：' + check.errors.join('；') });
    const players = Array.isArray(body.players) ? body.players : [];
    if (players.length !== check.total) return this.json(res, 400, { error: `玩家数(${players.length})与板子人数(${check.total})不一致` });
    let humans = players.filter((p) => p.isHuman).length;
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
      : makeAgentFactory(llmCfg, logger, this.experience, this.journal);

    // 性格：玩家自定义优先，未填写的 AI 随机分配（每局不重样）。
    // 显式 seed 时改用同一随机源，保证"同种子 + 同配置 = 同一局"（配合决策 journal 可完整复现）。
    const seed = Number.isInteger(body.seed) ? body.seed : null;
    const seedRng = seed == null ? Math.random : makeRng(seed);

    // 人类座位：默认由前端在 players 里标好 isHuman；mySeat:'random' 时在这里随机挑一个。
    // 为什么放在服务端而不是前端：手机端/桌面端/直接调 API 三条路径行为一致，
    // 而且随机源与性格分配共用同一个 seedRng —— 显式 seed 时"同种子 = 同一局"连座位也一起复现。
    // 注意必须在 applyPersonalities 之前：它会跳过人类座位（否则人类会被分到 AI 人格）。
    let mySeat = 0;
    if (body.mySeat === 'random') {
      if (humans === 1) return this.json(res, 400, { error: "mySeat:'random' 与 players 里的 isHuman 只能二选一" });
      const seat = 1 + Math.floor(seedRng() * players.length);
      const target = players[seat - 1];
      target.name = String(body.myName || target.name || '我');
      target.isHuman = true;      // Game 构造时会 sanitizeInline 截断，这里不重复处理
      target.personality = '';
      humans = 1;
      mySeat = seat;
    } else {
      mySeat = players.findIndex((p) => p.isHuman) + 1; // 无人类（观战）时为 0
    }

    applyPersonalities(players, seedRng);
    // 引擎是否扇出互不依赖的调用：只要**可能**跑出 >1 并发就开（单 Key + 自适应也算 ——
    // 调度器可能已经把这把 Key 的额度探到 3 条）。真正的并发度始终由调度器决定，
    // 引擎只负责表达"这些调用互不依赖"。直播缓冲已支持多路，所以扇出不会再显示错人。
    const parallelLlm = canFanOut(this.config.get());
    const game = new Game({ id: gameId, board, rules, players, agentFactory, logger, seed, parallelLlm });
    const entry = {
      game, running: false, error: null,
      // mock 必须存在 entry 上：存档写的就是 entry.mock，恢复时按 doc.mock 决定用 Mock 还是真实 agentFactory。
      // 曾经漏了这一行 → 试玩局存档里 mock=false，服务重启/暂停恢复后**会当成真实局去调付费 API**
      // （用户以为在免费试玩，实际在花钱）。这条与"不静默降级"是同一类问题：状态丢失后行为悄悄变了。
      mock: useMock,
      tokens: { player: humans ? tokenId() : null, god: tokenId() },
      createdAt: Date.now(), lastAccess: Date.now(), // 内存治理（TTL/LRU）用
    };
    this.games.set(gameId, entry);
    logger.openGameLog(gameId);
    logger.info('api', `对局已创建 ${gameId}（${useMock ? 'Mock' : llmCfg.model}，${check.total}人${mySeat ? '，你在 ' + mySeat + ' 号' : '，纯观战'}）`, { gameId });
    await this.saveGame(entry, { force: true });
    return this.json(res, 200, { gameId, playerToken: entry.tokens.player, godToken: entry.tokens.god, mock: useMock, mySeat });
  }

  startGame(res, entry, body) {
    if (entry.running) return this.json(res, 409, { error: '对局已开始' });
    if (body.token !== entry.tokens.player && body.token !== entry.tokens.god) {
      return this.json(res, 403, { error: 'token 无效' });
    }
    entry.running = true;
    this._drive(entry);
    return this.json(res, 200, { ok: true });
  }

  /**
   * 局终经验生成：每个 AI 复盘自己那局、提炼 2~3 条教训入经验池。
   *
   * 这些调用**彼此零依赖**（各看各的反思纪要、各写各的教训），所以：
   *   · 单通道时仍逐个排队（顺序不变）；
   *   · 多通道时并发跑完 —— 局后处理不影响对局本身，是最"白给"的一块并发收益（11 个 AI 各一次调用）。
   * `experience.add` 仍然**按座位顺序、串行**提交：它要落盘，并发写同一个文件是自找麻烦。
   */
  async generateLessons(entry) {
    if (!this.experience || !entry.game.finished || !entry.game.started) return;
    const { game } = entry;
    const agents = [...game._agents.values()].filter((a) => typeof a.generateLessons === 'function');
    if (!agents.length) return;
    const run = async (agent) => {
      try {
        return { agent, lessons: await agent.generateLessons() };
      } catch (e) {
        this.logger.warn('ai', `${agent.player.seat}号 局终复盘失败（跳过）：${e.message}`, { gameId: game.id });
        return null;
      }
    };
    const results = game.parallelLlm && agents.length > 1
      ? await Promise.all(agents.map(run))
      : await (async () => {
          const out = [];
          for (const a of agents) out.push(await run(a));
          return out;
        })();
    for (const r of results) {
      if (!r || !r.lessons) continue;
      const added = this.experience.add(r.lessons);
      if (added) this.logger.info('api', `${r.agent.player.seat}号（${r.agent.player.role}）沉淀 ${added} 条跨局经验`, { gameId: game.id });
    }
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
  async terminateGame(res, entry, body) {
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
      await this.saveGame(entry, { force: true });
      this.logger.info('api', `未开局对局 ${game.id} 已被终止清理`);
      return this.json(res, 200, { ok: true, settled: true });
    }
    if (!entry.running && !game.paused) return this.json(res, 409, { error: '对局不在进行中' });
    // 暂停中的对局没有驱动循环在跑，直接结算（不能让它永远挂在暂停态）
    if (game.paused) {
      game.terminate('暂停中的对局被玩家终止');
      game.finish();
      await this.saveGame(entry, { force: true });
      this.logger.info('api', `暂停中的对局 ${game.id} 已被终止并结算`);
      return this.json(res, 200, { ok: true, settled: true });
    }
    game.terminate('玩家手动终止对局');
    return this.json(res, 200, { ok: true });
  }

  view(res, entry, query) {
    const token = query.get('token');
    const after = Number(query.get('after') || 0);
    const viewer = this.viewerOf(entry, token);
    if (viewer == null) return this.json(res, 403, { error: 'token 无效' });
    return this.json(res, 200, this.buildView(entry, viewer, after));
  }

  /** token → 视角（'god' | 座位号 | null） */
  viewerOf(entry, token) {
    if (!token) return null;
    if (token === entry.tokens.god) return 'god';
    if (token === entry.tokens.player) {
      const human = entry.game.players.find((p) => p.isHuman);
      return human ? human.seat : null;
    }
    return null;
  }

  /**
   * 构造某个视角的视图负载。
   * `view()`（轮询）与 `/stream`（SSE 推送）共用这一份构造逻辑——
   * 两条通道必须给出**逐字段一致**的数据，否则前端会出现"刷新一下才对"的诡异差异。
   */
  buildView(entry, viewer, after) {
    const { game } = entry;
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
    return {
      gameId: game.id, day: game.day, phase: game.phase,
      started: game.started, inMemory: this.games.has(game.id), finished: game.finished, winner: game.winner, winReason: game.winReason,
      error: entry.error,
      // 暂停态：配额/套餐等外部原因，前端据此显示横幅与"恢复对局"
      paused: game.paused || null,
      players, events, pending, queued, rules: game.rules, wolfTalk,
      // 终局评分（MVP 体系）：对局结束后计算并缓存
      score: game.finished ? (entry.score || (entry.score = computeScores(game))) : undefined,
      // 局后 AI 教练（P2-4）：状态与文本随视图下发，SSE 会把它推给前端（无需额外轮询）
      review: entry.review ? {
        status: entry.review.status,
        mode: entry.review.mode || null,
        text: entry.review.text || '',
        fallbackReason: entry.review.fallbackReason || null,
        seat: entry.review.seat || null,
        at: entry.review.at || null,
      } : null,
      me: me ? { seat: me.seat, name: me.name, role: me.role, alive: me.alive, isSheriff: me.isSheriff, lostVote: me.lostVote, teammates: game.wolves().some((w) => w.seat === me.seat) ? game.wolves().filter((w) => w.alive && w.seat !== me.seat).map((w) => w.seat) : [] } : null,
      // 流式直播缓冲（"打字中"）：公开发言全员可见，私密决策仅本人与上帝，reasoning 仅上帝
      // 只在 AI 正在输出时才非 null，不能拿它判断"能否继续对局"
      live: this.cleanLive(game.liveFor(viewer)),
      // 日切反思进度（"AI 正在整理记忆…"）
      memory: game.memory || null,
      llmStats: isGod ? game.llmStats : undefined,
      // 单并发通道状态（队列积压/当前任务/等待时长）：只有上帝视角可见
      scheduler: isGod ? scheduler.snapshot() : undefined,
      board: game.board,
    };
  }

  // ---------- 局后 AI 教练（P2-4）----------
  /**
   * 起一次局后点评。
   *
   * 三个刻意的取舍：
   *  ① **不自动触发**：点评要花一次 LLM 调用（单 key 单并发下还会占用通道），
   *     所以由用户点按钮决定；且结果缓存在对局上，重复打开页面不会重复调用。
   *  ② **异步执行**：一次生成十几秒到几分钟，HTTP 不能挂着。状态与文本随视图下发，
   *     由 SSE 推给前端（没有 SSE 时轮询也能拿到），前端不需要额外的轮询循环。
   *  ③ **不静默降级**：调用失败时不但要能玩，还要让用户知道为什么——
   *     `generateCoachReview` 会退回规则点评并带上 `fallbackReason`，前端如实标注。
   */
  startReview(res, entry, body) {
    const viewer = this.viewerOf(entry, body.token);
    if (viewer == null) return this.json(res, 403, { error: 'token 无效' });
    const game = entry.game;
    if (!game.finished) return this.json(res, 409, { error: '对局还没结束，打完了再来点评' });
    // 显式指定座位时先校验：报"座位 99 不存在"比笼统说"没有人类玩家座位"有用得多
    const requested = body.seat === undefined || body.seat === null ? null : Number(body.seat);
    if (requested !== null) {
      if (!Number.isInteger(requested) || !game.player(requested)) return this.json(res, 400, { error: `座位 ${body.seat} 不存在` });
    }
    const seat = requested !== null ? requested : (humanSeatOf(game) || null);
    if (!seat) return this.json(res, 400, { error: '本局没有人类玩家座位；请显式指定要点评的座位号' });
    if (entry.review && entry.review.status === 'running') return this.json(res, 200, { ok: true, status: 'running' });
    if (entry.review && entry.review.status === 'done' && !body.regenerate) {
      return this.json(res, 200, { ok: true, status: 'done', cached: true });
    }
    const facts = reviewFacts(game, seat);
    if (!facts) return this.json(res, 400, { error: `座位 ${seat} 不存在` });
    // Mock 试玩按定义"不调用 API"：直接给规则点评，避免"试玩却偷偷花了一次真调用"
    if (entry.mock) {
      entry.review = {
        status: 'done', mode: 'rule', text: ruleReview(facts, game), seat, at: Date.now(), ms: 0,
        fallbackReason: '本局是 Mock 试玩（不调用 API），因此只给规则点评',
      };
      this.saveGame(entry, { force: true }).catch(() => {});
      return this.json(res, 200, { ok: true, status: 'done', mode: 'rule' });
    }
    // 新一次生成：中止上一次（用户连点/重新生成时不该有两份在跑，单并发通道更该珍惜）
    if (entry.reviewAbort) { try { entry.reviewAbort.abort(); } catch (_) { /* ignore */ } }
    const ac = new AbortController();
    entry.reviewAbort = ac;
    entry.review = { status: 'running', seat, at: Date.now() };
    this.logger.info('api', `局后点评开始：${game.id} 座位 ${seat}`);
    generateCoachReview({ game, facts, llmCfg: this.config.get(), logger: this.logger, signal: ac.signal })
      .then((r) => {
        if (entry.reviewAbort !== ac) return; // 已被新一次生成取代
        entry.review = { status: 'done', mode: r.mode, text: r.text, fallbackReason: r.fallbackReason || null, seat, at: Date.now(), ms: r.ms };
        if (r.mode === 'rule') this.logger.warn('api', `局后点评退化为规则点评：${r.fallbackReason}`);
        else this.logger.info('api', `局后点评完成：${game.id} ${r.ms}ms`);
      })
      .catch((e) => { // generateCoachReview 内部已兜底，这里只防意外
        if (entry.reviewAbort !== ac) return;
        entry.review = { status: 'error', seat, at: Date.now(), fallbackReason: e && e.message ? e.message : String(e), text: '' };
      })
      .then(() => { this.saveGame(entry, { force: true }).catch(() => {}); });
    return this.json(res, 202, { ok: true, status: 'running' });
  }

  getReview(res, entry, query) {
    const viewer = this.viewerOf(entry, query.get('token'));
    if (viewer == null) return this.json(res, 403, { error: 'token 无效' });
    return this.json(res, 200, { review: entry.review || null });
  }

  // ---------- SSE 推送（P2-2）----------
  /**
   * 用服务端推送替代前端 1.2s 轮询。
   *
   * 为什么值得做：轮询的每次请求都要重建一次视图负载（含全部增量事件的 JSON 序列化），
   * 而绝大多数轮询是"没有任何变化"的空转；SSE 只在**真的变了**的时候推一帧，
   * 并且省掉了每次往返的 TCP/头部开销。对局暂停等待人类输入时更是完全静默。
   *
   * 本轮询更关键的一点：**推送与轮询共用 buildView**，两条通道数据逐字段一致，
   * 前端即使因为环境不支持而回退轮询，行为也完全一样（这是敢改前端的底气）。
   *
   * 帧格式（标准 SSE）：
   *   event: view  → 一帧视图负载；客户端按 seq 游标增量应用
   *   event: ping  → 心跳（前端据此判断连接是否还活着）
   *   event: end   → 对局已结束/被清理，客户端应收尾并停止重连
   */
  stream(req, res, entry, query) {
    const viewer = this.viewerOf(entry, query.get('token'));
    if (viewer == null) return this.json(res, 403, { error: 'token 无效' });
    const gameId = entry.game.id;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx 等反代必须禁用缓冲，否则推送会被攒着不发
    });
    res.write(': stream open\n\n'); // 注释帧：让客户端立刻确认"连上了"（不触发 onmessage）
    // 断线重连：浏览器会自动带上 Last-Event-ID（即我们发过的最后一个 id），
    // 以它为准续传，避免重连后把已经渲染过的事件再发一遍。
    const lastId = Number(req.headers['last-event-id'] || 0);
    const st = {
      res, viewer, entry, gameId,
      after: Math.max(Number(query.get('after') || 0), Number.isFinite(lastId) ? lastId : 0),
      sig: null,
      cheap: null,
      ticks: 0,
      closed: false,
      sawFinished: false,
    };
    if (!this.streams.has(gameId)) this.streams.set(gameId, new Set());
    this.streams.get(gameId).add(st);
    this.logger.debug('api', `SSE 订阅 ${gameId} viewer=${viewer}（当前 ${this.streams.get(gameId).size} 条）`);
    const drop = () => this.dropStream(st);
    req.on('close', drop);
    req.on('error', drop);
    // 立刻推一帧：客户端不必等下一个定时器周期，也让"打开页面到看见内容"的延迟与轮询一致
    this.pushStream(st);
    return undefined;
  }

  dropStream(st) {
    if (st.closed) return;
    st.closed = true;
    const set = this.streams.get(st.gameId);
    if (set) {
      set.delete(st);
      if (!set.size) this.streams.delete(st.gameId);
    }
    try { st.res.end(); } catch (_) { /* 对端可能已断开 */ }
  }

  /** 关闭某局（或全部）的推送连接 */
  closeStreams(gameId, reason = 'end') {
    const ids = gameId ? [gameId] : [...this.streams.keys()];
    for (const id of ids) {
      const set = this.streams.get(id);
      if (!set) continue;
      for (const st of [...set]) {
        try { st.res.write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`); } catch (_) { /* ignore */ }
        this.dropStream(st);
      }
    }
  }

  /**
   * 直播缓冲里存的是**模型原始 JSON 增量**（`{"text":"我是好人…`）。
   * 直接下发的话，玩家会先看到 `{"text":"` 这种壳子，等输出完解析成事件才变正常
   * （用户反馈："先出现 text 标签，等他全部输入完才会正常消失"）。
   * 这里把 text 字段取出来，reasoning 原样保留（那是给上帝面板看的思考）。
   */
  cleanLive(live) {
    if (!live) return null;
    return Object.assign({}, live, { text: extractLiveText(live.text) });
  }

  /**
   * **廉价指纹**：只读对局状态里的几个标量，不构造视图、不序列化。
   *
   * 为什么需要它：SSE 每 400~500ms 拍一次，如果每拍都调 buildView（含 12 名玩家 + 规则 + 全量增量事件的
   * JSON 构造），那比 1.2s 轮询还费 CPU —— 推送就白做了。绝大多数拍其实是"什么都没变"，
   * 这里用几个字段的比较把它挡掉，只有真的变了才去构造视图。
   */
  cheapSignature(entry, viewer) {
    const { game: g } = entry;
    const live = g.live;
    const liveVisible = live && (viewer === 'god' || live.public || live.seat === Number(viewer));
    return [
      g.seq, g.day, g.phase, g.finished ? 1 : 0, g.winner || '',
      g.paused ? `${g.paused.kind}:${g.paused.code || ''}` : '',
      g.pending ? `${g.pending.seat}:${g.pending.request.task}` : '',
      g.wolfTalk && g.wolfTalk.active ? `wt${g.wolfTalk.round}/${g.wolfTalk.rounds}` : '',
      g.memory ? `m${g.memory.day}/${g.memory.done}` : '',
      g.explodeRequest ? 'E' : '', g.duelRequest ? 'D' : '',
      liveVisible ? `L${live.seat}:${(live.text || '').length}:${live.updatedAt || ''}` : '',
      entry.error ? 'err' : '',
      entry.review ? `R${entry.review.status}${(entry.review.text || '').length}` : '', // 教练状态/文本变化要推帧
      viewer === 'god' ? `c${(g.llmStats && g.llmStats.calls) || 0}` : '',
    ].join('|');
  }

  /** 变化指纹：只有它变了才推帧（避免空转帧把带宽和前端渲染都浪费掉） */
  streamSignature(entry, viewer, payload) {
    const { game } = entry;
    const live = payload.live;
    const sched = payload.scheduler;
    return [
      game.seq, game.day, game.phase, game.finished ? 1 : 0, game.winner || '',
      payload.paused ? `${payload.paused.kind}:${payload.paused.code || ''}` : '',
      payload.pending ? payload.pending.task : '',
      payload.memory ? `${payload.memory.day}/${payload.memory.done}` : '',
      payload.queued.explode ? 1 : 0, payload.queued.duel ? 1 : 0,
      payload.review ? `R${payload.review.status}:${(payload.review.text || '').length}` : '',
      live ? `${live.seat || ''}:${live.chars != null ? live.chars : (live.text || '').length}` : '',
      viewer === 'god' && sched ? `${sched.current ? sched.current.task : ''}|${sched.queued != null ? sched.queued : (sched.queue || []).length}|${(payload.llmStats || {}).calls || 0}` : '',
      // 座位状态（存活/警长/翻牌）变化也要推：否则头像上的"出局"标记不会更新
      payload.players.map((p) => `${p.alive ? 1 : 0}${p.isSheriff ? 's' : ''}${p.revealed ? 'r' : ''}${p.role || ''}`).join(''),
    ].join('|');
  }

  /** 推一帧（若有变化）。返回是否真的推了 */
  pushStream(st) {
    if (st.closed) return false;
    const entry = this.games.get(st.gameId);
    if (!entry) { // 对局已被清理（TTL/LRU 逐出）
      try { st.res.write(`event: end\ndata: ${JSON.stringify({ reason: 'evicted' })}\n\n`); } catch (_) { /* ignore */ }
      this.dropStream(st);
      return false;
    }
    // 先用廉价指纹挡掉没变化的拍：绝大多数拍走这条路，一次 buildView 都不做。
    // 注意：终局收尾必须在这条快路径里也能发生——否则"已完成的流"会因为状态不再变化而永远不关。
    const finishUp = () => {
      try { st.res.write(`event: end\ndata: ${JSON.stringify({ reason: 'finished' })}\n\n`); } catch (_) { /* ignore */ }
      this.dropStream(st);
    };
    const cheap = this.cheapSignature(entry, st.viewer);
    if (cheap === st.cheap && st.cheap != null) {
      if (st.sawFinished) finishUp();
      return false;
    }
    st.cheap = cheap;
    let payload;
    try {
      payload = this.buildView(entry, st.viewer, st.after);
    } catch (e) {
      // 绝不能静默卡死：轮询模式下这里会返回 500 让前端看见错误，
      // SSE 若不作为，客户端只会看到"永远没有新内容"——比报错难查得多。
      // 因此发一帧 error 并关流，前端据此回退轮询。
      this.logger.warn('api', `SSE 构造视图失败 ${st.gameId}: ${e.message}`);
      try { st.res.write(`event: error\ndata: ${JSON.stringify({ error: String(e.message || e) })}\n\n`); } catch (_) { /* ignore */ }
      this.dropStream(st);
      return false;
    }
    const sig = this.streamSignature(entry, st.viewer, payload);
    const hasNew = payload.events.length > 0;
    let pushed = false;
    if (hasNew || sig !== st.sig) {
      st.sig = sig;
      for (const e of payload.events) if (e.seq > st.after) st.after = e.seq;
      try {
        // id: 让浏览器在断线重连时用 Last-Event-ID 告诉服务端"我收到哪了"
        st.res.write(`id: ${st.after}\nevent: view\ndata: ${JSON.stringify(payload)}\n\n`);
        pushed = true;
      } catch (_) {
        this.dropStream(st);
        return false;
      }
    }
    // 终局收尾：先让客户端完整拿到终局帧（含结算分数），下一拍再送 end 关流
    if (payload.finished) {
      if (st.sawFinished) finishUp();
      else st.sawFinished = true;
    }
    return pushed;
  }

  /** 统一推进所有订阅（单一定时器：连接数再多也只有一个 timer） */
  tickStreams() {
    if (!this.streams.size) return;
    for (const set of [...this.streams.values()]) {
      for (const st of [...set]) {
        this.pushStream(st);
        st.ticks++;
        if (st.ticks % STREAM_PING_TICKS === 0 && !st.closed) {
          try { st.res.write(`event: ping\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`); } catch (_) { this.dropStream(st); }
        }
      }
    }
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
      // 记忆检索结果（P2-5）：检索了多少条、省了多少条 —— 让"上下文被裁剪过"这件事可见
      memory: agent.lastMemory || null,
      // 分区体积（应用自报）：看清楚 token 花在记忆/实录/快照/任务的哪一块
      sectionTokens: agent.lastSectionTokens || null,
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

  /** 多局统计：聚合存档（胜负/天数/板子分布）+ 经验池规模 */
  stats(res) {
    try {
      const agg = { games: 0, finished: 0, goodWins: 0, wolfWins: 0, avgDays: 0, boards: {}, experiences: this.experience.stats() };
      let daysSum = 0;
      const files = fs.readdirSync(SAVE_DIR).filter((f) => f.endsWith('.json') && f !== 'experiences.json');
      for (const f of files) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(SAVE_DIR, f), 'utf8'));
          const g = j.game || j;
          agg.games++;
          if (g.finished) {
            agg.finished++;
            if (g.winner === 'good') agg.goodWins++;
            else if (g.winner === 'wolf') agg.wolfWins++;
            daysSum += g.day || 0;
          }
          if (g.started && g.board) {
            const size = Object.values(g.board).reduce((a, b) => a + b, 0);
            agg.boards[`${size}人`] = (agg.boards[`${size}人`] || 0) + 1;
          }
        } catch (_) { /* 跳过损坏存档 */ }
      }
      agg.avgDays = agg.finished ? Math.round((daysSum / agg.finished) * 10) / 10 : 0;
      return this.json(res, 200, agg);
    } catch (e) { return this.json(res, 200, { games: 0, experiences: {} }); }
  }

  listSaves(res) {
    try {
      const files = fs.readdirSync(SAVE_DIR).filter((f) => f.endsWith('.json') && f !== 'experiences.json');
      const rows = files.map((f) => {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(SAVE_DIR, f), 'utf8'));
          const g = j.game || j; // 兼容新旧存档格式
          return {
            id: g.id, day: g.day, phase: g.phase, finished: g.finished, started: !!g.started, inMemory: this.games.has(g.id),
            winner: g.winner, winReason: g.winReason,
            paused: g.paused || null,
            mock: !!j.mock, // 让界面能标出"试玩局"，也便于排查"恢复后是否还走 Mock"
            // 服务重启后（不在内存）或内存中处于暂停态的对局，都可以从锚点续跑
            resumable: !!(j.anchor && g.started && !g.finished && (!this.games.has(g.id) || !!g.paused)),
            seats: g.players.length, date: fs.statSync(path.join(SAVE_DIR, f)).mtime,
          };
        } catch (_) { return null; }
      }).filter(Boolean).sort((a, b) => new Date(b.date) - new Date(a.date));
      return this.json(res, 200, { rows });
    } catch (e) { return this.json(res, 200, { rows: [] }); }
  }
}

module.exports = { Api };
