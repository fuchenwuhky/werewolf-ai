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

/**
 * NEW-16 替身对局的令牌哨兵（见 Api#_ghostGame）。
 *
 * `body.token !== entry.tokens.player` 这类比较的另一侧永远是**请求里的字符串**，
 * Symbol 与任何字符串永不相等 ⇒ 每条子路由的授权门都会照常拒绝，给出与该路由
 * 「存在但令牌不对」**逐字节相同**的响应。换成固定的可猜字符串（含空串）都不行：
 * 调用者只要把那个字符串当令牌发过来，就能从替身上拿到 200，「存在 / 不存在」的差异
 * 又变回探针 —— 这一条正是本缺陷要关掉的东西。
 */
const GHOST_TOKEN = Symbol('no-such-game');
/**
 * 自定义头像的缓存策略（M1 §4.3「私有缓存」）：URL 带内容哈希 ⇒ 内容变了 URL 必变，
 * 因此可长缓存；`private` 是因为它属于本机玩家的私人资料，不得被共享缓存留存。
 */
const AVATAR_CACHE_CONTROL = 'private, max-age=31536000, immutable';
/**
 * M2-b §6 的分页参数（计划书原话："对局列表默认每页 30、上限 100"、"事件默认 100、上限 200 条一批"）。
 * 超上限一律**截断到上限**，不是 400：上限是服务端的保护线，客户端多要一页不该让整次请求失败；
 * 响应里回显生效后的 limit，调用方看得见自己实际拿到多少。
 */
const GAMES_PAGE_DEFAULT = 30;
const GAMES_PAGE_MAX = 100;
const HISTORY_PAGE_DEFAULT = 100;
const HISTORY_PAGE_MAX = 200;
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
const { AuthManager, isTrustedOrigin, isLoopbackAddress } = require('./auth');
const { ProfileStore, ValidationError, isValidId, avatarUrlOf } = require('./profiles/store');
const { AnnotationStore, hasMeaningfulAnnotations } = require('./annotations/store');
const { ProfileMigration, readLegacyExperienceOwner } = require('./profiles/migration');
const { AVATAR_MIME, MAX_AVATAR_BYTES } = require('./profiles/avatar');
const transfer = require('./profiles/transfer');
const { STALE_TMP_MS, tmpPathFor, cleanupStaleTmp } = require('./tmp-files');

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
function keyBindingOf(cfg) {
  return crypto.createHash('sha256').update(
    [`${cfg.baseUrl || ''}`, String(cfg.apiKey || ''), (cfg.apiKeys || []).join('|')].join('§')
  ).digest('hex');
}

/**
 * `X-Profile-Revision`（M1 §4.3）：头像三接口的乐观并发凭据，语义与 PATCH body 的
 * `expectedRevision` 完全一致——**只有给了一个合法整数才是校验意图**；缺省不校验（与 PATCH 相同，
 * 兼容"不知道 revision 的旧客户端"）。给了但不是整数则 400：静默忽略等于悄悄放弃并发保护。
 */
function parseProfileRevisionHeader(req) {
  const raw = req.headers && req.headers['x-profile-revision'];
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 0) {
    throw Object.assign(new Error('X-Profile-Revision 必须是整数'), { code: 400 });
  }
  return n;
}

/** If-None-Match 是否命中给定 ETag（逗号分隔列表、`*` 均按 HTTP 语义处理） */
function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) return false;
  return String(ifNoneMatch).split(',').some((t) => {
    const s = t.trim();
    return s === '*' || s === etag || s === `W/${etag}`;
  });
}

// ---------- 原子写的临时文件命名（FIX-12：判据唯一，见 src/tmp-files.js）----------
// 历史教训：判据分叉过一次（这里只认 `.json.tmp`），于是导入/恢复/档案仓的 `.tmp-*` 残渣
// 永远清不掉。现在命名与判定都来自 src/tmp-files.js，本文件只负责"扫自己的 saveDir"。

class Api {
  constructor({ config, logger, saveDir = null }) {
    this.config = config;      // {get(), save(partial)}
    this.logger = logger;
    // 存档目录可注入（整改 REL-03 的测试隔离要求）；默认行为与以前完全一致
    this.saveDir = saveDir || SAVE_DIR;
    this.games = new Map();    // gameId → {game, tokens:{player,god}, running, error, saveTimer}
    this.experience = new ExperienceStore(this.saveDir, logger); // 跨局经验池（按角色沉淀 AI 复盘教训）
    // 决策 journal：恢复重放时命中磁盘答案 → 零重复 LLM 调用、逐字复现（P1-1/P1-2）
    this.journalDir = path.join(this.saveDir, 'journal');
    this.journal = new DecisionJournal(this.journalDir, {
      enabled: this.config.get().journal !== false,
      logger,
    });
    const pruned = this.journal.prune(); // 每次服务启动清一次：journal 只是缓存，删掉只损失"免费复现"
    if (pruned) this.logger.info('api', `决策 journal 清理了 ${pruned} 个过期文件`);
    if (!fs.existsSync(this.saveDir)) fs.mkdirSync(this.saveDir, { recursive: true });
    // FIX-12：启动时真正清理崩溃遗留的原子写临时文件（旧实现只在定义里存在，从未被调用）
    this._cleanupStaleTmp();
    // 本机玩家档案与私人标注（整改方案 DATA-01）：独立 Store，不在 api.js 堆持久化实现
    this.profiles = new ProfileStore({ dataDir: path.dirname(this.saveDir), logger });
    this.annotations = new AnnotationStore({ profilesRoot: this.profiles.root, logger });
    this.defaultProfileId = null;
    // 旧经验池归属（UUID；undefined = 还没解析，null = 无主）。由迁移钉死后取回，
    // 迁移未就绪/失败的路径在首次使用时直接读磁盘（见 legacyExperienceOwnerId）。
    this._legacyExpOwnerId = undefined;
    // DATA-02：迁移必须 await —— 修复前 run() 未 await 导致 defaultProfileId 竞态为 null
    this._profileMigrationReady = (async () => {
      try {
        this.profileMigration = new ProfileMigration({ dataDir: path.dirname(this.saveDir), profilesStore: this.profiles, logger });
        const mig = await this.profileMigration.run();
        this.defaultProfileId = mig.defaultId;
        this._legacyExpOwnerId = mig.legacyExpOwnerId;
        if (mig.executed.length) {
          this.logger.info('api', `档案迁移完成：${mig.executed.join('/')}，默认档案 ${mig.defaultId}，存档打标 ${mig.tagged} 局`);
        }
      } catch (e) {
        this.logger.error('api', `档案迁移失败（进入兼容模式）: ${e.message}`);
        this.defaultProfileId = null;
      }
    })();
    // 轻量限流（整改 §1.4）：远端地址+桶 → 时间戳滑窗。只保护花钱/可暴力的入口。
    this._rateBuckets = new Map();
    // 管理会话与局域网配对（整改 SEC-01）：默认关闭（本机模式、行为与旧版一致）；
    // server.js 绑定非回环地址（WW_LAN=1 / WW_HOST）时调用 auth.setEnabled(true) 启用门禁。
    this.auth = new AuthManager({ logger });
    // 密钥-地址原子绑定（审核 P0-1）：baseUrl 与 Key 必须成对可信。
    // 磁盘上没有绑定时自动绑定一次（升级路径，信任磁盘现状）；此后任何"只改地址不重输
    // Key"的保存都会让绑定失配，所有 LLM 出口（建真实局/test/probe）拒绝发凭证。
    if (!this.config.get().keyBinding && (this.config.get().apiKey || (this.config.get().apiKeys || []).length)) {
      this.config.save({ keyBinding: keyBindingOf(this.config.get()) });
      this.logger.info('api', '已建立密钥-地址绑定（升级自动绑定）');
    }
    // 定时持久化进行中的对局
    this._saveTimer = setInterval(() => this.saveActive(), 4000);
    this._saveTimer.unref && this._saveTimer.unref();
    // SSE 订阅：gameId → Set<stream>（P2-2）
    this.streams = new Map();
    this._streamTimer = setInterval(() => this.tickStreams(), STREAM_TICK_MS);
    this._streamTimer.unref && this._streamTimer.unref();
  }

  // ---------- 工具 ----------
  /**
   * 启动时清理残留的原子写临时文件（整改阶段 3.3 崩溃一致性；FIX-12 修好"从未被调用"）。
   *
   * 写入是"临时文件 + rename"，进程在任何时刻被杀，tmp 都只是半截数据——
   * 正式文件（rename 后）永远是完整份，所以陈旧 tmp 可以安全删除，绝不覆盖有效数据。
   *
   * FIX-12 之前有两个洞，缺一不可：
   *   ① 本方法**没有调用者**（只在定义里存在）→ 崩溃遗留的 tmp 永远躺在数据目录里；
   *   ② 过滤条件是 `endsWith('.json.tmp')`，只认 saveGame 的后缀式命名，认不出导入/恢复
   *      的 `.tmp-*` 与旧迁移的 `.migtmp` → 那两类残留哪怕被调用也清不掉。
   * 现在：命名与判定都来自 src/tmp-files.js（含档案仓/标注仓的中缀族），本方法只负责扫自己的
   * saveDir，并在构造函数里真正执行一次。
   *
   * @param {{maxAgeMs?: number}} opts 只有早于 maxAgeMs 的 tmp 才算"陈旧"（见 STALE_TMP_MS）
   * @returns {number} 实际删除的文件数
   */
  _cleanupStaleTmp({ maxAgeMs = STALE_TMP_MS } = {}) {
    const removed = cleanupStaleTmp(this.saveDir, { maxAgeMs });
    if (removed.length) this.logger.info('api', `清理残留临时文件 ${removed.length} 个（${removed.join('、')}）`);
    return removed.length;
  }

  /**
   * FIX-09：把"使用"落到档案的 lastUsedAt（档案列表按此字段倒序，见 store.list() 的注释）。
   *
   * 服务端可观测的"使用"有两个入口，都走这一条实现：
   *   · 用这份档案开了一局（createGame 带着 profileId）；
   *   · 客户端显式调用 `POST /api/profiles/:id/touch`（M2-b §6 第一项，见 touchProfile）。
   * 取舍（明确写下来，别让读代码的人以为是遗漏）：
   *   · await 一次小文件原子写（与一次存档同量级，毫秒级），换取确定性——测试与"失败不影响开局"
   *     都能被断言，不用 fire-and-forget 制造竞态；
   *   · **任何失败只 warn**：使用痕迹不是关键数据，绝不能让"记不上最近使用时间"导致建局失败。
   *
   * M2-b：加一个 `raise` 开关，不改默认行为。建局路径（默认 false）逐字保持"只 warn、绝不
   * 让开局失败"；`POST /profiles/:id/touch` 是用户**显式**发起的写请求，那里传 true——
   * 写盘失败必须如实回错误，不能回 200 谎称"已记录"（见 touchProfile 的注释）。
   *
   * @returns {Promise<object|null>} 更新后的档案；无 profileId / 失败且不 raise 时为 null
   */
  async _touchProfileUsage(profileId, { raise = false } = {}) {
    if (!profileId) return null;
    try {
      return await this.profiles.touch(profileId);
    } catch (e) {
      this.logger.warn('profiles', `记录最近使用失败（${profileId}）：${e.message}`);
      if (raise) throw e;
      return null;
    }
  }

  /**
   * 旧经验池（saves/experiences.json）归谁：**钉死在原 UUID 上**，与"当前默认档案"无关。
   *
   * 迁移把答案写进 `migrations/legacy-experience-owner`（见 ProfileMigration.pinLegacyExperienceOwner）。
   * 迁移还没就绪（或迁移失败降级）时直接读磁盘：即使降级运行，也不会因为
   * `defaultProfileId` 变成另一份档案（或重建出的新默认档案）就把旧池交出去。
   */
  legacyExperienceOwnerId() {
    if (this._legacyExpOwnerId !== undefined) return this._legacyExpOwnerId;
    return (this._legacyExpOwnerId = readLegacyExperienceOwner(path.dirname(this.saveDir)));
  }

  /**
   * 按对局归属解析经验池（方案 PROF-03 + M0 数据归属硬要求
   * docs/next-stage-implementation-plan.md:56）。
   *
   * **归属键只有 UUID**：旧池（saves/experiences.json）属于
   * `migrations/legacy-experience-owner` 记下的那个 profileId；其余档案各自持有
   * `profiles/<id>/experiences.json`。
   *
   * 为什么不能按"当前默认档案"判定（缺陷根因，本条要求存在的理由）：
   * 旧实现是 `ownerProfileId === this.defaultProfileId` 就返回旧池。于是默认档案一归档/
   * 一删除/一切换，内存里的 defaultProfileId 立刻改指另一份档案，**同一份旧池的读路径当场
   * 换主**：原档案的教训在新档案开局时被注入（继承），原档案自己反而读到空池（丢失）。
   * 现在归属只由"创建对局时固化在存档里的 ownerProfileId"决定，切默认/归档/删除/重建默认
   * 都不参与判定，故不存在继承路径。
   *
   * 边界（刻意保留的兼容行为）：无归属或非 UUID 的 owner（迁移失败降级模式、旧客户端）
   * 仍走旧池 —— 这类对局没有档案可归属，与"档案甲继承档案乙"不是一回事；详见本文件所在
   * 改动的报告"诚实边界"。
   */
  experienceFor(ownerProfileId) {
    if (!isValidId(ownerProfileId)) return this.experience;           // 无归属/非法 id：兼容旧池
    if (ownerProfileId === this.legacyExperienceOwnerId()) return this.experience;
    if (!this._experienceByOwner) this._experienceByOwner = new Map();
    if (!this._experienceByOwner.has(ownerProfileId)) {
      this._experienceByOwner.set(ownerProfileId, new ExperienceStore(path.join(this.profiles.root, ownerProfileId), this.logger));
    }
    return this._experienceByOwner.get(ownerProfileId);
  }

  /** 密钥-地址绑定是否有效（审核 P0-1）：baseUrl 与 Key 任一变动未重输凭证即失配 */
  keyBindingValid() {
    const c = this.config.get();
    if (!c.apiKey && !(c.apiKeys || []).length) return true; // 没配 Key 无从外带
    return !!c.keyBinding && c.keyBinding === keyBindingOf(c);
  }

  /**
   * 归一化 HTTP 状态码（验收 P2）。
   *
   * 业务语义错误（ValidationError 400 / NotFoundError 404 / ConflictError 409、readBody 的
   * 400/413/415）的 `.code` 是数字，必须原样透传；而 Node 的 fs/系统错误 `.code` 是**字符串**
   * （'EPERM' / 'EBUSY' / 'ENOENT' / 'ENOTEMPTY'…），直接喂给 `res.writeHead()` 会让响应状态
   * 变成字符串——并发用例里客户端读到 `status === 'EPERM'`，排查成本极高。
   *
   * 规则（分两种情况，缺一不可）：
   *  · 没有码（undefined/null/''/0 等 falsy）→ 沿用调用点自己的语义默认 fallback：
   *    原来写 `e.code || 400` 的路径仍然 400，写 `e.code || 500` 的仍然 500，行为零漂移；
   *  · **有码但不是 100–599 的整数** → 一律 500。这不是"客户端请求有问题"，而是服务端拿到了
   *    一个根本不是状态码的东西（fs 的 'EPERM'、越界的 600…），绝不能回落成 400 去指责客户端。
   *    纯数字字符串（'404'）按整数处理。
   *
   * 入参可以是错误对象（取 `.code`），也可以是裸状态码，便于 json() 做最后一道兜底。
   */
  statusOf(e, fallback = 500) {
    const raw = e && typeof e === 'object' ? e.code : e;
    if (!raw) return fallback; // 无码：按调用点的语义默认（与修复前一致）
    const n = Number(raw);
    return Number.isInteger(n) && n >= 100 && n <= 599 ? n : 500;
  }

  json(res, code, data) {
    const body = JSON.stringify(data);
    // 唯一写 JSON 响应的出口：再兜一次底，任何调用点（含未来新增的）都不可能把字符串码
    // 写成 HTTP 状态（规则见 statusOf）。
    res.writeHead(this.statusOf(code), { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  async readBody(req, limit = 2 * 1024 * 1024) {
    // 整改 §1.4：只接受声明支持的 Content-Type。声明了但不是 JSON → 415；
    // 没声明头但内容合法的客户端（curl 等）保持宽容。
    const ctype = String((req.headers && req.headers['content-type']) || '');
    const ctl = ctype.toLowerCase();
    if (ctype && !ctl.includes('application/json') && !ctl.includes('text/plain')) {
      throw Object.assign(new Error('Content-Type 必须是 application/json'), { code: 415 });
    }
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      let over = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit && !over) {
          // 整改（审核 P2-7）：不再 destroy 连接——那会让客户端收到 ECONNRESET 而不是
          // 承诺的 413。改为丢弃后续数据、保持连接，让上层把 413 响应真正写回去。
          over = true;
          reject(Object.assign(new Error('请求体过大'), { code: 413 }));
          return;
        }
        if (!over) chunks.push(c);
      });
      req.on('end', () => {
        if (over) return; // 已因超限 reject
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(Object.assign(new Error('JSON 解析失败'), { code: 400 })); }
      });
      req.on('error', reject);
    });
  }

  getGame(id) {
    const e = this.games.get(id);
    if (e) e.lastAccess = Date.now();
    return e;
  }

  /**
   * NEW-16：非管理会话遇到**未知 gameId** 时用的替身对局。
   *
   * ## 缺陷
   * 老实现把"这一局不存在"和"这一局存在、但你的令牌不对"给成了不同的响应
   * （404「对局不存在」 vs 403「token 无效」/ 401「需要管理会话」）。未配对的调用者
   * 只要拿到一个 gameId，就能用这个差异判定"它是不是一局真实对局" —— 泄漏存在性。
   *
   * ## 为什么不是"统一成一句通用文案"
   * 各子路由的拒绝原因本来就不同：/logs、/agent、/replay 是「需要上帝 token」，
   * /explode 是「仅玩家本人可自爆」，/duel 是「仅玩家本人可发起决斗」，/tokens 是 401 配对串……
   * 统一成一句反而会造出**新的**可区分点（改成通用串之后，那些路由的"存在"响应依旧是专属串）。
   * 所以做法是：把未知 id 交给**同一条子路由**，配一份令牌永不匹配的替身，
   * 由该路由自己的授权门给出与"存在但令牌不对"完全一致的那一条响应。
   * 这条不变量由 test/new-16-existence-leak.test.js **逐路由实测**：同一个请求打在
   * "真实存在的局"与"不存在的 id"上，状态码与报文必须严格相等（含未知子路由与错误方法）。
   *
   * ## 替身的形状
   * 只填到"授权门可能触到的最浅一层"：`viewerOf` 只在令牌等于玩家令牌时才会去读
   * `entry.game.players`，而那个等式（Symbol vs 字符串）永远不成立。万一将来有人把授权门
   * 挪到状态检查之后，这里也只会落到一个空局上，而不是抛异常变成 500 ——
   * 500 与 403 的差异本身就是探针。
   */
  _ghostGame(id) {
    return {
      game: { id, players: [], finished: false, started: false, paused: null, pending: null },
      running: false, error: null, mock: false, paused: null, review: null,
      tokens: { player: GHOST_TOKEN, god: GHOST_TOKEN },
      createdAt: 0, lastAccess: 0, ghost: true,
    };
  }

  /**
   * 读取**原始 PNG** 请求体（M1 §4.3 头像上传专用）。
   *
   * 与 readBody 的区别（不能复用）：readBody 只收 JSON/纯文本且会 JSON.parse，头像是二进制。
   * 服务端不信任扩展名，也不信任客户端声明的类型 —— 这里只做两件它能做的事：
   *   · `Content-Type` **精确**等于 `image/png`（带参数如 `image/png; charset=utf-8` 也拒绝，
   *     §4.3 原文"精确为 image/png"；宁可 415 也不猜）；
   *   · 0 < 长度 ≤ 2MiB（超限 413、空 body 400）；上限在**流式读取时**就生效，不会把超大 body 收进内存。
   * PNG 结构/尺寸/色彩类型的判定不在这里，全部在 src/profiles/avatar.js（唯一判据）。
   */
  async readAvatarBody(req) {
    const ctype = String((req.headers && req.headers['content-type']) || '').trim().toLowerCase();
    if (ctype !== AVATAR_MIME) {
      throw Object.assign(new Error(`Content-Type 必须是 ${AVATAR_MIME}`), { code: 415 });
    }
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = []; let over = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_AVATAR_BYTES && !over) {
          over = true; // 不 destroy 连接（与 readBody 同策略）：让 413 真正写回客户端
          reject(Object.assign(new Error(`头像超过上限 ${MAX_AVATAR_BYTES / 1048576} MiB`), { code: 413 }));
          return;
        }
        if (!over) chunks.push(c);
      });
      req.on('end', () => {
        if (over) return; // 已因超限 reject
        if (!size) return reject(Object.assign(new Error('头像数据为空（0 字节）'), { code: 400 }));
        resolve(Buffer.concat(chunks));
      });
      req.on('error', reject);
    });
  }

  /** 存档元数据：**不含 events**——事件流只在 anchor 里存一份（旧实现两边都存，46.5% 的体积是纯重复）。
   *  例外：**终局存档保留完整 events**（审核 P1-3）——终局只写一次盘，去重无意义；锚点只拍在昼/夜边界，
   *  最后一夜/天的结算事件只存在于 game.events，剥掉会导致导出/复盘永久丢尾。 */
  _saveMeta(game) {
    if (game.finished) return game.toJSON();
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
    if (entry.saving) {
      // 整改（审核 P1-4）：在途写盘不静默放弃 —— 返回在途 Promise 让优雅退出真正等得到；
      // pendingSave 仍会安排一次补写。
      entry.pendingSave = true;
      return entry.savePromise || false;
    }
    // 注意：savedStamp 绝不能在写盘前推进（整改 REL-03）。旧行为在这里先盖戳，
    // 一旦 writeFile/rename 失败，4s 周期保存会因"戳没变"永远跳过 → 数据静默丢失。
    entry.saving = true;
    entry.savePromise = (async () => {
    let doc;
    try {
      // 令牌一并存档：本地单机应用，浏览器丢失会话时可从存档恢复对局
      doc = JSON.stringify({
        schemaVersion: 2, // 整改阶段 3.2：v1 = 无版本号（兼容读取）；新增字段一律向后兼容
        // 归属元数据（方案 §3.3）：从创建时的 entry 固化，不从"当前档案"推导
        ownerProfileId: entry.ownerProfileId || null,
        ownerNicknameSnapshot: entry.ownerNicknameSnapshot || null,
        ownerHumanSeat: entry.ownerHumanSeat ?? null,
        profileSchemaVersion: 1,
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
    const file = path.join(this.saveDir, `${game.id}.json`);
    const tmp = `${file}.tmp`;
    try {
      await fs.promises.writeFile(tmp, doc);
      await fs.promises.rename(tmp, file); // 原子替换：读到的永远是完整存档
      entry.savedStamp = stamp; // 只有真正落盘成功才推进脏标记
      entry.saveFailed = false; // 审核 P1-3：补救成功后清除标记（saveActive 路径同样生效）
    } catch (e) {
      this.logger.warn('api', `存档失败 ${game.id}: ${e.message}`);
      return false; // 保持脏状态：savedStamp 未推进，下一轮周期保存会自动重试
    } finally {
      entry.saving = false;
      if (entry.pendingSave) {
        entry.pendingSave = false;
        // 审核 P1-4：补写任务必须挂回 savePromise —— 否则优雅退出等不到它，最终快照丢失
        const retry = this.saveGame(entry).catch(() => false);
        entry.savePromise = retry;
      }
    }
    return true;
    })();
    return entry.savePromise;
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
      return JSON.parse(fs.readFileSync(path.join(this.saveDir, `${id}.json`), 'utf8'));
    } catch (_) { return null; }
  }

  /**
   * 统一"从锚点重建"：Game.fromJSON + 回填 AI 记忆（反思纪要/怀疑度/事件游标）。
   * 服务重启续跑与配额暂停恢复共用这一条路径——两者都只是"锚点从磁盘来"还是"从内存来"的区别。
   */
  _rebuildFromAnchor({ id, anchor, mock, tokens, logger, agentFactory, review = null }) {
    // 整改 REL-04：读档/恢复按当前服务配置决定 LLM 并发语义（可并行时夜晚/投票才扇出）
    const game = Game.fromJSON(anchor, { agentFactory, logger, parallelLlm: canFanOut(this.config.get()) });
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
      await this._saveFinalWithRetry(entry);
      // 生命周期收口（整改 REL-02）：正常结束必须复位 running，否则 pruneGames/TTL 永远
      // 跳过这局（"已结束却无法回收"），且 entry.running=true 会让状态语义说谎。
      entry.running = false;
      entry.finishedAt = Date.now();
      this.logger.closeGameLog(game.id);
      // 局终复盘：AI 拿"当时的判断"对照"终局真相"提炼经验，存入跨局经验池（mock 对局/失败静默跳过）
      this.generateLessons(entry).catch((e) => {
        this.logger.warn('api', `经验生成失败（不影响对局）: ${e.message}`, { gameId: game.id });
      });
    }).catch(async (err) => {
      entry.error = String(err.stack || err.message || err);
      entry.running = false;
      this.logger.error('engine', `对局 ${game.id} 异常终止`, { stack: err.stack });
      await this._saveFinalWithRetry(entry);
    });
    return entry;
  }

  /**
   * 终局存盘：失败时有界重试（审核 P1-3）。仍失败则打 saveFailed 标记 ——
   * saveActive 会把带标记的已结束对局一并纳入补救，直到真正落盘成功。
   */
  async _saveFinalWithRetry(entry) {
    let ok = await this.saveGame(entry, { force: true });
    for (let i = 0; !ok && i < 3; i++) {
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      ok = await this.saveGame(entry, { force: true });
    }
    if (ok) { entry.saveFailed = false; }
    else { entry.saveFailed = true; this.logger.error('api', `终局存盘多次失败 ${entry.game.id}，已标记待补救`); }
    return ok;
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
    // 审核 P0-1：恢复真实局会继续产生 LLM 调用，绑定失配必须拒绝
    if (!useMock && !this.keyBindingValid()) {
      return this.json(res, 400, { error: '接口地址或密钥已变更但未重新验证：请在设置中重新保存 API Key', auth: 'rekey' });
    }
    const logger = makeGameLogger(this.logger, id);
    if (typeof logger.openGameLog === 'function') logger.openGameLog(id); // 服务重启后按局日志流需重新打开
    const newEntry = this._rebuildFromAnchor({
      id, anchor: doc.anchor, mock: useMock, logger,
      tokens: { player: tokenId(), god: tokenId() },
      agentFactory: useMock
        ? makeMockAgentFactory(Math.random, { explodeRate: 0.02 })
        : makeAgentFactory({ ...this.config.get() }, logger, this.experienceFor(doc.ownerProfileId), this.journal),
    });
    // 归属随存档恢复（方案 §3.4）：异步回调/定时存盘引用所属 entry 的 owner
    newEntry.ownerProfileId = doc.ownerProfileId || null;
    newEntry.ownerNicknameSnapshot = doc.ownerNicknameSnapshot || null;
    newEntry.ownerHumanSeat = doc.ownerHumanSeat ?? null;
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
    // 审核 P0-1：恢复真实局会继续产生 LLM 调用，绑定失配必须拒绝
    if (!entry.mock && !this.keyBindingValid()) {
      return this.json(res, 400, { error: '接口地址或密钥已变更但未重新验证：请在设置中重新保存 API Key', auth: 'rekey' });
    }
    const anchor = game._anchor;
    if (!anchor) return this.json(res, 409, { error: '没有可恢复的锚点（对局尚未到过白天/夜晚边界）' });
    const logger = makeGameLogger(this.logger, id); // 进程未重启，按局日志流仍在
    const newEntry = this._rebuildFromAnchor({
      id, anchor, mock: !!entry.mock, logger, tokens: entry.tokens,
      agentFactory: entry.mock
        ? makeMockAgentFactory(Math.random, { explodeRate: 0.02 })
        : makeAgentFactory({ ...this.config.get() }, logger, this.experienceFor(entry.ownerProfileId), this.journal),
    });
    // 归属随存档恢复（方案 §3.4）：异步回调/定时存盘引用所属 entry 的 owner
    newEntry.ownerProfileId = entry.ownerProfileId || null;
    newEntry.ownerNicknameSnapshot = entry.ownerNicknameSnapshot || null;
    newEntry.ownerHumanSeat = entry.ownerHumanSeat ?? null;
    this.games.set(id, newEntry);
    this._drive(newEntry, anchor.nextPhase);
    return this.json(res, 200, { gameId: id, playerToken: newEntry.tokens.player, godToken: newEntry.tokens.god, resumed: true });
  }

  /** 保存所有进行中的对局。返回 Promise（整改阶段 3.2：优雅退出需要等待落盘完成），
   *  兑现为成功写入的局数；脏标记在 saveGame 内部判定：没有新事件的节拍一次磁盘都不碰 */
  async saveActive() {
    this.pruneGames(); // 内存治理与定时落盘同一个节拍：4s 一次
    const jobs = [];
    for (const entry of this.games.values()) {
      // 整改（审核 P1-3）：终局存盘失败的对局（saveFailed）也要纳入补救，否则数据静默丢失
      if (entry.game.started && (!entry.game.finished || entry.saveFailed)) {
        jobs.push(this.saveGame(entry, { force: !!entry.saveFailed }).catch((e) => {
          this.logger.warn('api', `定时存档失败 ${entry.game.id}: ${e.message}`);
          return false;
        }));
      }
    }
    // 审核 P1-4：把各局在途/补写中的 savePromise 也纳入等待
    for (const entry of this.games.values()) {
      if (entry.savePromise) jobs.push(entry.savePromise.then(() => true).catch(() => false));
    }
    let results = await Promise.all(jobs);
    // 审核 P1-4 三轮反例：补写可能在等待期间**再安排**下一份补写，固定轮数会漏。
    // 改为循环收割直到无新 savePromise（补写链有限必然终止），硬上限 50 轮防失控。
    const seen = new Set();
    for (let round = 0; round < 50; round++) {
      const late = [];
      for (const entry of this.games.values()) {
        const p = entry.savePromise;
        if (p && !seen.has(p)) { seen.add(p); late.push(p.then(() => true).catch(() => false)); }
      }
      if (!late.length) break;
      const r = await Promise.allSettled(late);
      results = results.concat(r.filter((x) => x.status === 'fulfilled').map((x) => x.value).filter(Boolean));
    }
    return results.filter(Boolean).length;
  }

  // ---------- 路由 ----------
  /**
   * 管理会话门禁（SEC-01 权限矩阵）：配置读写、测试/探测、创建对局、列全部对局、
   * 取一局全部令牌、统计。单局玩家/上帝令牌通道不受此矩阵约束——令牌随请求体/查询串
   * 随行，攻击者无从伪造，天然免疫 CSRF；Capacitor 壳（origin=https://localhost）也因此不受影响。
   */
  /** 滑动窗口限流：超限返回 false。键为 远端地址+桶名，进程内计数（重启即清零，够用） */
  _rateAllow(req, bucket, max, windowMs = 60 * 1000) {
    // 本机回环不限流：限流保护的是 LAN 暴露面；本机脚本/测试连创多局是正常用法。
    // 没有 socket 地址的请求（单元测试桩）也按本机对待。
    const ra = req.socket && req.socket.remoteAddress;
    if (!ra || isLoopbackAddress(ra)) return true;
    const key = bucket + ':' + ra;
    const now = Date.now();
    const arr = (this._rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { this._rateBuckets.set(key, arr); return false; }
    arr.push(now);
    this._rateBuckets.set(key, arr);
    return true;
  }

  _denyManagement(res) {
    this.json(res, 401, { error: '需要管理会话（局域网访问请先配对）', auth: 'pairing' });
    return false;
  }

  /** 认证相关端点。返回 null 表示不是认证路由，继续走业务路由 */
  _authEndpoints(req, res, pathname) {
    const method = req.method;
    if (pathname === '/api/auth/pairing' && method === 'GET') {
      // 本机管理会话：给出可展示的配对码（给局域网设备输入用）；
      // 远端未配对：只告知"需要配对"，绝不回显配对码。
      if (this.auth.isManagement(req)) {
        try { this.auth.newPairingCode(); } catch (_) { /* 节流窗口内沿用当前有效码 */ }
        const cur = this.auth.currentCode();
        return this.json(res, 200, { needed: this.auth.enabled, code: cur ? cur.code : null, expiresInMs: cur ? cur.expiresInMs : null });
      }
      return this.json(res, 200, { needed: this.auth.enabled, code: null });
    }
    if (pathname === '/api/auth/pair' && method === 'POST') {
      if (!isTrustedOrigin(req)) return this.json(res, 403, { error: 'Origin 不受信任' });
      if (!this._rateAllow(req, 'pair', 10)) return this.json(res, 429, { error: '尝试过于频繁，请稍后再试' });
      return this.readBody(req).then((body) => {
        try {
          const sid = this.auth.pair(body.code);
          res.setHeader('Set-Cookie', this.auth.sessionCookie(sid));
          return this.json(res, 200, { ok: true });
        } catch (e) {
          return this.json(res, 403, { error: e.message, auth: 'pairing' });
        }
      });
    }
    if (pathname === '/api/auth/unpair' && method === 'POST') {
      if (!isTrustedOrigin(req)) return this.json(res, 403, { error: 'Origin 不受信任' });
      this.auth.revoke(this.auth.sessionIdFrom(req));
      res.setHeader('Set-Cookie', 'ww_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      return this.json(res, 200, { ok: true });
    }
    return null;
  }

  async handle(req, res, pathname, query) {
    const method = req.method;
    try {
      const authRoute = this._authEndpoints(req, res, pathname);
      if (authRoute !== null) return authRoute;
      const mgmt = this.auth.isManagement(req);
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
        if (!mgmt) return this._denyManagement(res);
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
        if (!mgmt || !isTrustedOrigin(req)) return this._denyManagement(res);
        const body = await this.readBody(req);
        delete body.keyBinding; // 审核 P1-2：绑定指纹只由服务端内部写入，永不接受客户端输入
        // 审核 P0-1/P1（三轮反例）最终规则：
        //   · 地址未变 → 同一已确认主机，凭证增删自由重绑（无外带风险）；
        //   · 地址变更 → 必须重输主 apiKey（非掩码且清洗后仍在）；此时附加 Key 不随迁
        //     （它们从未被授权用于新地址，随迁 = 旧 Key 外带），清空后按主 Key 单独重绑；
        //   · 其余一切（掩码占位、清空 extras、两步组合）一律 fail-closed 保持失配。
        const wasValid = this.keyBindingValid();
        const baseUrlBefore = this.config.get().baseUrl;
        const apiKeyBefore = this.config.get().apiKey;
        const apiKeysBefore = JSON.stringify(this.config.get().apiKeys || []);
        const saved = this.config.save(body);
        const after = this.config.get();
        const urlChanged = after.baseUrl !== baseUrlBefore;
        const mainKeyResupplied = typeof body.apiKey === 'string' && body.apiKey.trim() !== ''
          && !body.apiKey.includes('****') && after.apiKey === body.apiKey;
        const credsChanged = after.apiKey !== apiKeyBefore
          || JSON.stringify(after.apiKeys || []) !== apiKeysBefore;
        // 无 Key 配置（纯 Mock 试玩）没有可外带的凭证，地址变更不触发 fail-closed
        const hasKey = !!this.config.get().apiKey;
        if (urlChanged && !mainKeyResupplied && hasKey) {
          // 改地址未重输 Key：fail-closed（须重输主 Key 才能恢复）
          this.baseUrlNeedsRekey = true;
        } else if (mainKeyResupplied) {
          // 显式重输主 Key：为（可能变化了的）地址重新背书。
          // 换地址时附加 Key 不随迁（旧 extras 从未获准用于新地址，随迁 = 旧 Key 外带）；
          // 同地址则保留本请求里显式重输的 extras。
          if (urlChanged && body.apiKeys === undefined) this.config.save({ apiKeys: [] });
          this.config.save({ keyBinding: keyBindingOf(this.config.get()) });
          this.baseUrlNeedsRekey = false;
        } else if (wasValid && credsChanged) {
          // 同一已确认主机上的凭证增删：自由重绑
          this.config.save({ keyBinding: keyBindingOf(this.config.get()) });
          this.baseUrlNeedsRekey = false;
        } else {
          // 失配期间的同地址变更：保持失配，须重输主 Key 解锁
          this.baseUrlNeedsRekey = !this.keyBindingValid();
        }
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
        if (!mgmt || !isTrustedOrigin(req)) return this._denyManagement(res);
        if (!this._rateAllow(req, 'cfgtest', 6)) return this.json(res, 429, { error: '测试过于频繁，请稍后再试' });
        const c = this.config.get();
        if (!this.keyBindingValid()) return this.json(res, 400, { ok: false, error: '接口地址已变更：请重新输入 API Key 再测试（防止密钥被发往未确认的地址）' });
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
        if (!mgmt || !isTrustedOrigin(req)) return this._denyManagement(res);
        if (!this._rateAllow(req, 'probe', 3)) return this.json(res, 429, { error: '探测过于频繁，请稍后再试' });
        if (!this.keyBindingValid()) return this.json(res, 400, { ok: false, error: '接口地址已变更：请重新输入 API Key 再探测（防止密钥被发往未确认的地址）' });
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
      if (pathname === '/api/games' && method === 'POST') {
        if (!mgmt || !isTrustedOrigin(req)) return this._denyManagement(res);
        if (!this._rateAllow(req, 'create', 10)) return this.json(res, 429, { error: '创建过于频繁，请稍后再试' });
        return this.createGame(res, await this.readBody(req));
      }
      if (pathname === '/api/games' && method === 'GET') {
        if (!mgmt) return this._denyManagement(res);
        return this.listSaves(res);
      }
      if (pathname === '/api/stats' && method === 'GET') {
        if (!mgmt) return this._denyManagement(res);
        return this.stats(res);
      }
      // ---------- 本机玩家档案（方案 §3.6）----------
      if (pathname === '/api/profiles' && method === 'GET') {
        if (!mgmt) return this._denyManagement(res);
        return this.json(res, 200, { profiles: this.profiles.list({ includeArchived: true }), defaultProfileId: this.defaultProfileId });
      }
      if (pathname === '/api/profiles' && method === 'POST') {
        if (!mgmt || !isTrustedOrigin(req)) return this._denyManagement(res);
        if (!this._rateAllow(req, 'profcreate', 10)) return this.json(res, 429, { error: '创建过于频繁，请稍后再试' });
        const prof = await this.profiles.create(await this.readBody(req));
        return this.json(res, 200, { profile: prof });
      }
      // ---------- 回收区 / 恢复（验收 P2：「归档代替删除」的恢复入口）----------
      // ⚠ 顺序关键：这两条必须排在**任何** /api/profiles/<id> 形态的兜底路由之前。
      // `trash` 不是 UUID，一旦被后面的 profileMatch（/^\/api\/profiles\/([0-9a-fA-F-]{36})…/）
      // 或别的兜底吃掉，恢复能力就再次只存在于注释里 —— 这是本次修复的核心顺序约束。
      if (pathname === '/api/profiles/trash' && method === 'GET') {
        if (!mgmt) return this._denyManagement(res);
        return this.json(res, 200, { items: this.profiles.listTrash(), defaultProfileId: this.defaultProfileId });
      }
      // archiveId 段在这里故意放宽到"任意字符"（含 /），再由 restoreProfile 用与 store 完全相同的
      // 白名单收敛成 400：真实请求入口会先 decodeURIComponent（%2f→/、%2e%2e→..），路径穿越串
      // 真正到达 api.handle 时是已解码形态；若在正则里就匹配不上，非法 id 会以 404 混过去而不是 400。
      const trashRestoreMatch = pathname.match(/^\/api\/profiles\/trash\/(.+)\/restore$/);
      if (trashRestoreMatch && method === 'POST') {
        if (!mgmt || !isTrustedOrigin(req)) return this._denyManagement(res);
        if (!this._rateAllow(req, 'profrestore', 10)) return this.json(res, 429, { error: '恢复过于频繁，请稍后再试' });
        return this.restoreProfile(res, trashRestoreMatch[1]);
      }
      if (pathname === '/api/profiles/import/preview' && method === 'POST') {
        if (!mgmt || !isTrustedOrigin(req)) return this._denyManagement(res);
        try {
          const body = await this.readBody(req, transfer.MAX_BYTES); // 预览与导入同上限：先预览后导入不该在体积上双重标准
          const pkg = transfer.validateImportPackage(body.package);
          return this.json(res, 200, { ok: true, preview: transfer.previewImport(pkg) });
        } catch (e) {
          return this.json(res, this.statusOf(e, 400), { error: e.message });
        }
      }
      if (pathname === '/api/import/recoveries' && method === 'GET') {
        // AC-08：设备与数据——待清理恢复记录的可见入口（只返回相对名与原因，不含绝对路径）
        if (!mgmt) return this._denyManagement(res);
        let files = [];
        try { files = fs.readdirSync(this.saveDir).filter((f) => f.startsWith('.import-recovery-') && f.endsWith('.json')); } catch (_) {}
        const items = [];
        for (const name of files) {
          try {
            const rec = JSON.parse(fs.readFileSync(path.join(this.saveDir, name), 'utf8'));
            items.push({ file: name, profileId: rec.profileId || null, residue: rec.residue || [], error: String(rec.error || '').slice(0, 120), createdAt: rec.createdAt || null });
          } catch (_) { items.push({ file: name, reason: 'corrupt' }); }
        }
        return this.json(res, 200, { items });
      }
      if (pathname === '/api/import/recoveries/retry' && method === 'POST') {
        if (!mgmt || !isTrustedOrigin(req)) return this._denyManagement(res);
        const r = await this._retryImportRecoveries();
        return this.json(res, 200, { cleaned: r.cleaned, remaining: r.kept.length, kept: r.kept });
      }
      if (pathname === '/api/profiles/import' && method === 'POST') {
        if (!mgmt || !isTrustedOrigin(req)) return this._denyManagement(res);
        const body = await this.readBody(req, transfer.MAX_BYTES); // 20MiB：与导出包上限一致（§3.5）
        // 唯一实现：与内部 importApplyRes 共用，避免双份逻辑漂移（笔记/偏好只随这里落地）
        const out = await this.importApplyRes(body.package);
        if (out.status === 200) {
          // AC-08：成功也必须透传恢复状态白名单字段——损坏/未清完的记录不能在 HTTP 重拼时被丢掉
          // NEW-08：`imported` 由 importApplyRes **核实落盘之后**给出；这里绝不回退到
          // `Object.keys(gameMap).length` —— 那正是"用预先生成的映射键数冒充成功数"的旧缺陷。
          const clean = { ok: true, imported: out.body.imported || 0, profileId: out.body.profileId, gameMap: out.body.gameMap, importedNotes: out.body.importedNotes || 0 };
          if (Array.isArray(out.body.pendingRecoveries)) clean.pendingRecoveries = out.body.pendingRecoveries;
          return this.json(res, 200, clean);
        }
        return this.json(res, out.status, out.body);
      }
      // M2-b §6：档案对局只读历史（仅已结束局，按事件游标分页）。
      // ⚠ 顺序：必须排在下面 profileMatch 的「任意 DELETE = 移入回收站」之前 —— history 是 GET，
      // 不被那条吃到；真正的理由是同一类顺序陷阱（长路由被短兜底吃掉）：profileMatch 只允许
      // id 后面跟**一个**小写字母段，/games/<gameId>/history 不是它的形状，所以这条正则必须独立存在，
      // 否则整条路由会静默落到 404「not found」。
      const profileHistoryMatch = pathname.match(/^\/api\/profiles\/([0-9a-fA-F-]{36})\/games\/([^/]+)\/history$/);
      if (profileHistoryMatch && method === 'GET') {
        if (!mgmt) return this._denyManagement(res);
        return this.profileGameHistory(res, profileHistoryMatch[1], profileHistoryMatch[2], query);
      }
      const profileMatch = pathname.match(/^\/api\/profiles\/([0-9a-fA-F-]{36})(\/([a-z]+))?$/);
      if (profileMatch) {
        const pid = profileMatch[1];
        const psub = profileMatch[3] || '';
        if (method === 'PATCH') {
          if (!mgmt || !isTrustedOrigin(req)) return this._denyManagement(res);
          return this.updateProfile(res, pid, await this.readBody(req));
        }
        // M1 §4.3 自定义头像三接口。⚠ 必须排在下面「任意 DELETE = 移入回收站」之前，
        // 否则 DELETE /api/profiles/<id>/avatar 会被当成"删除整个档案"吃掉（与回收站路由同一类顺序陷阱）。
        if (psub === 'avatar') {
          if (method === 'GET') {
            if (!mgmt) return this._denyManagement(res);
            return this.getProfileAvatar(req, res, pid, query);
          }
          if (method === 'PUT' || method === 'DELETE') {
            if (!mgmt || !isTrustedOrigin(req)) return this._denyManagement(res);
            if (!this._rateAllow(req, 'profavatar', 20)) return this.json(res, 429, { error: '头像操作过于频繁，请稍后再试' });
            return method === 'PUT'
              ? this.putProfileAvatar(res, req, pid)
              : this.deleteProfileAvatar(res, req, pid);
          }
        }
        if (method === 'DELETE') {
          if (!mgmt || !isTrustedOrigin(req)) return this._denyManagement(res);
          return this.trashProfile(res, pid);
        }
        if (psub === 'stats' && method === 'GET') {
          if (!mgmt) return this._denyManagement(res);
          return this.profileStats(res, pid);
        }
        // M2-b §6：记录真实最近使用（客户端在档案列表里"选用"这份档案时调用）。
        // 授权门（管理会话 + Origin 可信）排在**存在性之前** —— 与 NEW-16 同一条纪律：
        // 未配对调用者对"存在"与"不存在"的档案必须拿到逐字相同的 401，否则状态码差异
        // 本身就成了"这个 id 是不是真档案"的探针。
        if (psub === 'touch' && method === 'POST') {
          if (!mgmt || !isTrustedOrigin(req)) return this._denyManagement(res);
          if (!this._rateAllow(req, 'proftouch', 60)) return this.json(res, 429, { error: '操作过于频繁，请稍后再试' });
          return this.touchProfile(res, pid);
        }
        void pid;
        if (psub === 'games' && method === 'GET') {
          if (!mgmt) return this._denyManagement(res);
          return this.profileGames(res, pid, query);
        }
        if (psub === 'export' && method === 'GET') {
          if (!mgmt) return this._denyManagement(res);
          return this.profileExport(res, pid);
        }
      }
      if (gameMatch) {
        const id = gameMatch[1];
        const sub = gameMatch[2] || '';
        // 恢复前的只读会话摘要：磁盘局也可读取，不能借此把对局提前放回运行内存。
        if ((sub === '/session' || sub === '/tokens') && method === 'GET') {
          const live = this.games.get(id);
          const doc = live || this.loadSaveDoc(id);
          const token = query.get('token');
          const tokenValid = !!doc && !!doc.game && !!token && !!doc.tokens
            && (token === doc.tokens.player || token === doc.tokens.god);
          // NEW-16：**授权先于存在性**。非管理会话先过门，再谈"这一局在不在"：
          //   · /tokens 只认管理会话 ⇒ 未配对一律 401（与"局存在"时同一条响应）；
          //   · /session 只认管理会话或本局令牌 ⇒ 其余一律 403「token 无效」。
          // 于是"不存在的局"与"存在但令牌不对"给同一状态码 + 同一报文
          //（老实现是 404「对局不存在」 vs 403/401 —— 差异即"这个 id 是不是真对局"）。
          if (sub === '/tokens') {
            if (!mgmt) return this._denyManagement(res);
          } else if (!mgmt && !tokenValid) {
            return this.json(res, 403, { error: 'token 无效' });
          }
          // 到这里的只有管理会话（或已持令牌的合法调用者），404 语义保持不变
          if (!doc || !doc.game) return this.json(res, 404, { error: '对局不存在' });
          if (sub === '/tokens') return this.json(res, 200, doc.tokens || {});
          const gm = doc.game;
          const human = (gm.players || []).find((p) => p.isHuman);
          return this.json(res, 200, { gameId: id, tokenValid, inMemory: !!live, started: !!gm.started, finished: !!gm.finished,
            ownerProfileId: doc.ownerProfileId || null, ownerNickname: doc.ownerNicknameSnapshot || null,
            mock: !!doc.mock, day: gm.day, phase: gm.phase, paused: gm.paused || null,
            me: human ? { seat: human.seat } : null });
        }
        // 断点恢复：① 内存中因配额/套餐暂停的对局 → 从内存锚点续跑
        //           ② 服务重启后已不在内存的对局 → 从存档锚点续跑
        if (sub === '/resume' && method === 'POST') {
          const body = await this.readBody(req);
          const live = this.games.get(id);
          if (live) {
            // NEW-11：授权先于状态。旧顺序把「对局仍在运行中」的 409 排在令牌检查之前
            // （令牌检查在 resumePaused 里），未授权调用者据此可判定"该局是否还活在内存里"。
            if (body.token !== live.tokens.player && body.token !== live.tokens.god) {
              return this.json(res, 403, { error: 'token 无效' });
            }
            if (!live.game.paused) return this.json(res, 409, { error: '对局仍在运行中，直接打开即可' });
            return this.resumePaused(res, live, body);
          }
          const doc = this.loadSaveDoc(id);
          if (!doc || !doc.game) {
            // NEW-16：非管理会话下"没有这份存档"必须与"有存档但令牌不对"一致
            //（后者是 resumeGame 的 403「token 无效」）。管理会话语义不变：仍是 404。
            if (!mgmt) return this.json(res, 403, { error: 'token 无效' });
            return this.json(res, 404, { error: '存档不存在' });
          }
          return this.resumeGame(res, { id, tokens: doc.tokens || {} }, body);
        }
        // 未知 id + 非管理会话 ⇒ 用"令牌永不匹配"的替身继续走**同一条子路由**，
        // 由该路由自己的授权门给出与"存在但令牌不对"完全一致的响应（详见 _ghostGame）。
        // 管理会话（本机单机应用）的语义不变：不存在仍是 404「对局不存在」。
        // 注意替身同样覆盖"未知子路由 / 方法不匹配"（会一路落到下面的 404「not found」）——
        // 老实现里 `/api/games/<存在的 id>/whatever` 是 404「not found」而未知 id 是
        // 404「对局不存在」，报文不同 ⇒ 也能判出存在性。
        const entry = this.getGame(id) || (mgmt ? null : this._ghostGame(id));
        if (!entry) return this.json(res, 404, { error: '对局不存在' });
        if (sub === '/start' && method === 'POST') return this.startGame(res, entry, await this.readBody(req));
        if (sub === '/terminate' && method === 'POST') return this.terminateGame(res, entry, await this.readBody(req));
        if (sub === '/view' && method === 'GET') return this.view(res, entry, query);
        if (sub === '/stream' && method === 'GET') return this.stream(req, res, entry, query);
        if (sub === '/action' && method === 'POST') return this.action(res, entry, await this.readBody(req));
        if (sub === '/review' && method === 'POST') return this.startReview(res, entry, await this.readBody(req));
        if (sub === '/review' && method === 'GET') return this.getReview(res, entry, query);
        if (sub === '/explode' && method === 'POST') return this.explodeAction(res, entry, await this.readBody(req));
        if (sub === '/duel' && method === 'POST') return this.duelAction(res, entry, await this.readBody(req));
        if (sub === '/wolftalk' && method === 'POST') return this.wolfTalk(res, entry, await this.readBody(req));
        if (sub === '/logs' && method === 'GET') return this.logs(res, entry, query);
        // 私人标注（方案 NOTE-02）：归属 = 对局 owner 档案；凭对局令牌或管理会话访问
        if (sub === '/annotations' && method === 'GET') {
          return this.gameAnnotationsGet(res, entry, query, req);
        }
        if (sub === '/annotations' && method === 'PUT') {
          return this.gameAnnotationsPut(res, entry, req, await this.readBody(req));
        }
        if (sub === '/annotations' && method === 'DELETE') {
          // 撤销/清除单个座位的笔记（FIN-07 缺口收口）：凭对局令牌或管理会话
          return this.gameAnnotationDelete(res, entry, req, query);
        }
        if (sub === '/agent' && method === 'GET') return this.agentDebug(res, entry, query);
        if (sub === '/replay' && method === 'GET') return this.replay(res, entry, query);
      }

      return this.json(res, 404, { error: 'not found' });
    } catch (err) {
      this.logger.error('api', `接口异常 ${method} ${pathname}: ${err.message}`, { stack: err.stack });
      // 整改 §1.4：携带语义状态码的错误（413/415/400）按码返回，其余 500。
      // statusOf 负责把 fs 的字符串码（'EPERM'…）归一成 500，绝不写进 res.writeHead。
      return this.json(res, this.statusOf(err), { error: String(err.message || err) });
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
    // 对局归属固化（方案 PROF-02）：以创建时的不可变归属为准，不从"当前档案"推导存盘归属。
    // 兼容期：缺 profileId 的请求归入默认档案并记录弃用日志（本机旧客户端）。
    // 审核 P0（三轮/四轮）：createGame 必须等待迁移完成后再解析归属，
    // 否则竞态下 defaultProfileId 为 null → 无归属对局
    await this._profileMigrationReady;
    let ownerProfileId = this.defaultProfileId;
    let ownerNicknameSnapshot = null;
    let ownerHumanSeat = null;
    if (body.profileId !== undefined) {
      if (typeof body.profileId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.profileId)) {
        return this.json(res, 400, { error: 'profileId 非法' });
      }
      let prof = null;
      try { prof = this.profiles.get(body.profileId); } catch (_) {}
      if (!prof || prof.archivedAt) return this.json(res, 400, { error: '档案不存在或已归档' });
      ownerProfileId = prof.id;
      ownerNicknameSnapshot = prof.nickname;
    } else {
      this.logger.warn('api', `请求未携带 profileId，归入默认档案（兼容期，新客户端应显式携带）`);
      if (ownerProfileId) ownerNicknameSnapshot = this.profiles.get(ownerProfileId).nickname;
    }
    const humanSeat = (players || []).find((p) => p.isHuman);
    ownerHumanSeat = humanSeat ? humanSeat.seat : null;
    // 整改（审核 P0-1）：真实对局的 LLM 出口也必须校验密钥-地址绑定（内存标记重启即失，
    // 不能作为唯一防线）
    if (!useMock && !this.keyBindingValid()) {
      return this.json(res, 400, { error: '接口地址或密钥已变更但未重新验证：请在设置中重新保存 API Key', auth: 'rekey' });
    }


    const gameId = 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    const llmCfg = { ...this.config.get() };
    // 盖 gameId 戳的对局日志器：引擎与 AI 调用的日志同时进 server.log 和 game-<id>.log
    const logger = makeGameLogger(this.logger, gameId);
    const agentFactory = useMock
      ? makeMockAgentFactory(Math.random, { explodeRate: 0.02 })
      : makeAgentFactory(llmCfg, logger, this.experienceFor(ownerProfileId), this.journal);

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
      // 对局归属固化（方案 PROF-02）：创建时锁定，存盘/恢复/异步回调全程引用
      ownerProfileId,
      ownerNicknameSnapshot,
      ownerHumanSeat,
      createdAt: Date.now(), lastAccess: Date.now(), // 内存治理（TTL/LRU）用
    };
    this.games.set(gameId, entry);
    logger.openGameLog(gameId);
    logger.info('api', `对局已创建 ${gameId}（${useMock ? 'Mock' : llmCfg.model}，${check.total}人${mySeat ? '，你在 ' + mySeat + ' 号' : '，纯观战'}）`, { gameId });
    await this.saveGame(entry, { force: true });
    // FIX-09：建局 = 服务端可观测的"使用这份档案" → 更新 lastUsedAt（档案列表排序字段）。
    // 放在存盘之后、响应之前；失败只 warn，绝不影响开局（见 _touchProfileUsage）。
    await this._touchProfileUsage(ownerProfileId);
    return this.json(res, 200, { gameId, playerToken: entry.tokens.player, godToken: entry.tokens.god, mock: useMock, mySeat });
  }

  startGame(res, entry, body) {
    // 整改 REL-02 + 审核 P2-8：完整状态守卫——running/finished/started/paused/error 都不许
    // 重复驱动。暂停局必须走 /resume（恢复锚点），直接 /start 会跳过锚点重放。
    // NEW-11：这组**状态守卫之前**必须先过授权 —— 旧顺序把它们排在 token 检查前面，
    // 未授权调用者于是能用 409 的具体文案（对局已开始/已结束/暂停/异常终止）反推对局状态。
    if (body.token !== entry.tokens.player && body.token !== entry.tokens.god) {
      return this.json(res, 403, { error: 'token 无效' });
    }
    if (entry.running) return this.json(res, 409, { error: '对局已开始' });
    if (entry.game.finished) return this.json(res, 409, { error: '对局已结束，不能重新开始' });
    if (entry.game.paused) return this.json(res, 409, { error: '对局处于暂停态，请走断点恢复（resume）' });
    if (entry.error) return this.json(res, 409, { error: '对局上次异常终止，请从存档恢复' });
    if (entry.game.started) return this.json(res, 409, { error: '对局已开始' });
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
    const ownerExperience = this.experienceFor(entry.ownerProfileId);
    if (!ownerExperience || !entry.game.finished || !entry.game.started) return;
    if (!entry.mock && !this.keyBindingValid()) {
      this.logger.warn('api', `跳过局后经验提炼：${entry.game.id} 密钥绑定失配（改地址未重输 Key）`);
      return;
    }
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
      const added = ownerExperience.add(r.lessons);
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
    // 结算与落盘必须在这里也做一次（与上面暂停路径一致）。
    // P2-c 实测：驱动循环收到 abort 后会抛出并"优雅结算"，但那发生在另一个异步分支里，
    // 于是存在一个"内存里 finished=true、磁盘上还是活局"的窗口 —— 客户端刷新后
    // 按存档把它当活局自动恢复，就进了死局界面（用户为了清场被迫逐局终止）。
    // finish() 幂等，force 落盘写的是终结状态，两条路径从此一致。
    game.finish();
    await this.saveGame(entry, { force: true });
    this.logger.info('api', `运行中的对局 ${game.id} 已被终止并结算`);
    return this.json(res, 200, { ok: true, settled: true });
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
    // M2-a：pending 里带上**当前任务的唯一 id**（引擎每次 ask 生成新值，任务结束/被替换即作废）。
    // 客户端提交 action 时必须回传它，服务端在产生任何副作用之前比对（见 action()）。
    // 兼容说明：只有手工构造的 pending 桩（老测试/内部代码）没有 id —— 那种情况取 null，
    // 服务端不做 id 比对（没有可比的基准），见 action() 的注释。
    const pending = (game.pending && !isGod && game.pending.seat === viewer) ? {
      pendingId: game.pending.id || null,
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
      // AC-04：本局实际归属快照（顶栏/恢复守卫用；客户端当前浏览档案 ≠ 本局 owner）
      ownerProfileId: entry.ownerProfileId || null,
      ownerNickname: entry.ownerNicknameSnapshot || null,
      mock: !!entry.mock,
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
    // 审核 P0-1：AI 复盘是 LLM 出口，绑定失配（改地址未重输 Key）必须拒绝
    if (!entry.mock && !this.keyBindingValid()) {
      return this.json(res, 400, { error: '接口地址或密钥已变更但未重新验证：请在设置中重新保存 API Key', auth: 'rekey' });
    }
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
      // pending 的 id 必须进指纹：同一座位同一任务的**新** pending（旧答案作废）也要推帧，
      // 否则 SSE 客户端会一直握着旧 id 提交，被服务端当成过期操作拒掉。
      g.pending ? `${g.pending.seat}:${g.pending.request.task}:${g.pending.id || ''}` : '',
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
      payload.pending ? `${payload.pending.task}:${payload.pending.pendingId || ''}` : '',
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
    // NEW-11：**授权先于状态**。token 检查必须在 pending 之前（旧顺序先查 pending）：
    // 否则未配对/未授权的调用者只要知道 gameId，就能靠「409 当前没有等待中的操作」与
    // 「403 token 无效」的差异判定"该局此刻是否在等待人类操作"（1 bit 状态泄露），
    // 并读到只该给合法玩家的业务提示串。
    // ⚠ 顺序约束：带**正确玩家令牌**时的行为必须逐字不变 —— pending 为空仍必须是
    // 409「当前没有等待中的操作」（那是给正常用户的提示，不是安全边界）。
    if (body.token !== entry.tokens.player) return this.json(res, 403, { error: 'token 无效' });
    if (!game.pending) return this.json(res, 409, { error: '当前没有等待中的操作' });
    /**
     * M2-a：等待中的任务必须带**当前** pendingId。三条语义（有意为之，勿"顺手放宽"）：
     *   ① 相等 ⇒ 正常应用（同一任务的非法载荷仍由 resolveHuman 校验拒绝，pending 与 id 都保留供改正重试）；
     *   ② 不相等、或**缺失**，而确实有待处理任务 ⇒ 409「该操作已过期或已被处理」，**在 resolveHuman 之前**返回，
     *      于是既不消耗任务也不产生任何副作用。这条同时挡住"同一 action 重放两次"（若期间已有新任务）
     *      与"网络重试把上一任务的答案又交一次"；
     *   ③ **当前没有任何 pending 时不因缺 id 而拒绝** —— 上面那行已经先行返回原来的 409
     *      「当前没有等待中的操作」（文案逐字不变）。这是刻意保留的老客户端兼容路径：
     *      非等待态的调用（未开局/未轮到你/已结束……）行为与加 pendingId 之前完全一致。
     * 唯一例外：手工构造的 pending 桩没有 id（引擎 ask 一定带 id）⇒ 没有可比的基准，退回旧行为放行，
     * 免得测试与内部代码被无意义地拒掉。真实对局走不到这条分支。
     */
    const currentId = game.pending.id;
    if (currentId) {
      // 顶层为主；payload 里也给一次机会（后续客户端批次两处都可放，顶层优先）
      const submitted = body.pendingId != null ? body.pendingId : (body.payload ? body.payload.pendingId : undefined);
      if (submitted == null || submitted === '') {
        return this.json(res, 409, {
          error: '缺少 pendingId：该操作已过期或已被处理，请刷新页面后重试',
          code: 'PENDING_ID_REQUIRED',
        });
      }
      if (String(submitted) !== String(currentId)) {
        return this.json(res, 409, {
          error: '该操作已过期或已被处理（pendingId 已失效），请刷新页面后重试',
          code: 'PENDING_ID_STALE',
        });
      }
    }
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
      const files = fs.readdirSync(this.saveDir).filter((f) => f.endsWith('.json') && f !== 'experiences.json');
      for (const f of files) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(this.saveDir, f), 'utf8'));
          const g = j.game || j;
          agg.games++;
          if (g.finished) {
            agg.finished++;
            if (g.winner === 'good') agg.goodWins++;
            else if (g.winner === 'wolf') agg.wolfWins++;
            else if (g.winner === 'draw') agg.draws = (agg.draws || 0) + 1;
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

  /**
   * FIX-11：默认档案失效（被归档/删除）时清理或重指向。
   *
   * 为什么必须有这一步：`ProfileMigration.ensureDefaultProfile()` 每次启动都会校验持久化的默认档案
   * 「存在且未归档」，一旦失效就按昵称找可用的「默认玩家」、找不到就**新建一个同名档案**。
   * 于是"用户把默认档案归档/删掉"会在下次启动后变成"凭空多出一个默认玩家"——用户视角是数据被篡改。
   * 正解不是让迁移闭嘴，而是让 `defaultProfileId` **永远指向一份当前可用的真档案**：
   *   · 内存里的 this.defaultProfileId 立刻改指（GET /api/profiles 立即反映，界面不会指向死档案）；
   *   · 磁盘标记走 ProfileMigration.setDefaultId()/_clearDefaultId()（下一步启动才不会重建）。
   * 选谁接任：与档案列表同一套排序语义（最近使用优先，其次创建顺序）里的第一份**可用**档案。
   * 失败取舍：标记落盘失败只 warn，不让已经成功的归档/删除请求失败——内存里的重指向仍然生效，
   * 且下一步启动最坏情况是重建一份「默认玩家」（可见、可归档），不会丢用户数据。
   * @returns {Promise<string|null>} 重指向后的 defaultProfileId
   */
  async _repointDefaultProfile(invalidId) {
    if (!invalidId || this.defaultProfileId !== invalidId) return this.defaultProfileId;
    try { await this._profileMigrationReady; } catch (_) { /* 迁移失败已降级记录，不阻断档案操作 */ }
    const usable = this.profiles.list({ includeArchived: false })
      .sort((a, b) => String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')));
    const next = usable.length ? usable[0].id : null;
    this.defaultProfileId = next;
    try {
      if (this.profileMigration) this.profileMigration.setDefaultId(next); // 传 null 等价于清除
    } catch (e) {
      this.logger.warn('profiles', `默认档案标记落盘失败（内存已重指向 ${next || '无'}）：${e.message}`);
    }
    this.logger.info('profiles', `默认档案 ${invalidId} 已失效，${next ? `重指向 ${next}` : '且无可用档案可指'}`);
    return next;
  }

  /** 档案更新（方案 §3.6 PATCH）：expectedRevision 乐观并发，失败 409 */
  async updateProfile(res, pid, body) {
    try {
      const prof = await this.profiles.update(pid, body);
      // FIX-11：归档动作让"默认档案"失效 → 必须同一次请求内清理/重指向
      if (prof.archivedAt) await this._repointDefaultProfile(pid);
      return this.json(res, 200, { profile: prof });
    } catch (e) {
      // 状态码经 statusOf 归一：ValidationError 400 / NotFoundError 404 / ConflictError 409
      // 原样透传，fs 的字符串码（'EPERM'…）回落 500
      return this.json(res, this.statusOf(e, 400), { error: e.message, code: e.code });
    }
  }

  /**
   * 统计某档案名下「进行中」（started 且未 finished）的对局数：**内存 ∪ 磁盘**，同 gameId 只算一次。
   *
   * 为什么磁盘侧也必须数（M2-d，计划书 §5.2「有未结束对局的 owner 档案不可进入回收站」）：
   * 旧实现只遍历 `this.games`（内存）。一局**只存在于存档**时（服务重启过，或从锚点载入但还没
   * resume），它照样占着这份 owner 档案，却数不到 ⇒ 档案被移进回收区后这局存档变成**孤儿**：
   * 没有任何一处会报错，只是它再也回不到任何档案名下。计划书 §2：发现数据丢失必须立即修复。
   *
   * 去重口径与 `_profileGameRows` 一致：内存与磁盘同 id 时只算一次（内存是权威、磁盘是快照），
   * 所以内存里已结算而磁盘快照还停在"进行中"时，不会把同一局重复计两次。
   * 磁盘档没有 gameId 的（手工夹具）：用文件名占键（绝不与内存 id 撞键），**照常计入**——
   * 判据只认 game.started / game.finished，"这局还在跑"与有没有 id 无关。
   *
   * 损坏取舍 = **保守拒绝（fail-closed）**：`_readSaveDocStrict` 读不出的存档**无法确定归属**，
   * 于是**无法排除**它就是本档案的未结束局。这里绝不把「读不出」当成「没有进行中」——那正是
   * 本项目反复出现的静默失败形态，也违反计划书 §6「损坏数据返回明确错误」——而是把坏档原因
   * 交回调用方去拒删（文案点名文件）。
   * 代价（如实声明）：`saveDir` 里**任何**一份坏档都会暂时拦住**所有**档案的删除，不只它可能
   * 属于的那一份。这是刻意取舍：误删档案不可逆，拒删只耽误一次操作，且文案已点名文件，
   * 用户修好或移走即可放行。
   *
   * @returns {{active:number, corrupt:string[]}} active = 去重后的进行中局数；corrupt = 读不出的存档原因
   */
  _activeGameCount(pid) {
    const activeIds = new Set();
    const corrupt = [];
    for (const f of this._saveFileNames()) {
      const read = this._readSaveDocStrict(path.join(this.saveDir, f));
      if (!read.ok) {
        if (!read.missing) corrupt.push(read.error); // 竞态刚被删（missing）不算损坏，不冤枉
        continue;
      }
      const doc = read.doc;
      if (doc.ownerProfileId !== pid) continue;
      const gm = (doc.game && typeof doc.game === 'object' && !Array.isArray(doc.game)) ? doc.game : {};
      if (gm.started !== true || gm.finished === true) continue;
      const id = gm.id;
      activeIds.add((id === undefined || id === null || id === '') ? `\u0000file:${f}` : String(id));
    }
    for (const [gid, entry] of this.games) {
      if (!entry || !entry.game || entry.ownerProfileId !== pid) continue;
      if (!entry.game.started || entry.game.finished) continue;
      activeIds.add(String(gid)); // 与磁盘同 id 时 Set 天然去重
    }
    return { active: activeIds.size, corrupt };
  }

  /** 删除（仅归档态）：统计该档案进行中对局数后移入回收区 */
  async trashProfile(res, pid) {
    try {
      // M2-d：进行中计数 = 内存 ∪ 磁盘（只数内存会漏掉"服务重启后仅存于存档"的局 → 孤儿存档）
      const scan = this._activeGameCount(pid);
      if (!this.profiles.list({ includeArchived: true }).some((p) => p.id === pid)) {
        return this.json(res, 404, { error: '档案不存在' });
      }
      const prof = this.profiles.get(pid);
      if (!prof.archivedAt) return this.json(res, 409, { error: '请先归档再删除' });
      // 坏档只在"404 档案不存在 / 409 未归档"之后、且没有确证的进行中局时才拦：
      //  · 放在 404/409 之前会把这两条既有语义顶掉（请求先被 400 拒，用户看不到真正的原因）；
      //  · scan.active > 0 时让 profiles.trash 抛它那句更精确的「N 局进行中」，坏档留到下次重试再说。
      if (scan.active === 0 && scan.corrupt.length) {
        throw new ValidationError(
          `存档目录有 ${scan.corrupt.length} 份读不出的存档（${scan.corrupt.join('；')}），`
          + '无法确认其中没有该档案尚未结束的对局；为避免误删档案导致存档丢失归属，已保守拒绝删除。'
          + '请先修复或移走这些文件后重试。',
        );
      }
      const info = await this.profiles.trash(pid, { activeGames: scan.active });
      // FIX-11：删除路径同样保证默认标记不指向已消失的档案（归档态在 PATCH 已重指向过；
      // 这里覆盖"标记被旧版本/外部改写成已删档案"的存量状态，避免下次启动重建「默认玩家」）
      await this._repointDefaultProfile(pid);
      return this.json(res, 200, { ok: true, archiveId: info.archiveId });
    } catch (e) {
      return this.json(res, this.statusOf(e, 400), { error: e.message });
    }
  }

  /**
   * 从回收区恢复档案（验收 P2）：把 trash/<archiveId>/ 里的档案目录搬回原位、补索引，并
   * **顺带取消归档**——「恢复即可用」：store.restoreFromTrash 只搬目录 + 补索引，档案的
   * archivedAt 原样保留（进回收区的前提就是归档态），于是恢复出来的档案 stats 仍 404、
   * 也开不了局，要能用还得再 PATCH {restore:true}。这里一步做完。
   *  · archiveId 白名单与 store.restoreFromTrash 完全一致（/^[0-9A-Za-z-]+$/），路由层绝不放宽：
   *    路径穿越串（../etc、a/b）在到达文件系统之前就被拒成 400；
   *  · 写操作：必须在 store 的串行化入口 _serialize 内执行，与 PATCH/DELETE 的
   *    read-check-write 周期排同一条队，避免恢复与并发写互相覆盖索引/档案；
   *  · 失败按 .code 透传（400 非法 id / 404 回收区没有或已恢复过 / 409 目标位置被占用）。
   */
  async restoreProfile(res, archiveId) {
    try {
      const raw = String(archiveId == null ? '' : archiveId);
      if (!/^[0-9A-Za-z-]+$/.test(raw)) {
        return this.json(res, 400, { error: '非法 archiveId' });
      }
      // 搬目录 + 取消归档必须在**同一个**串行化周期内完成，否则恢复出的中间态（归档态）会被
      // 并发的 PATCH 观察到。
      // ⚠ 这里调 store._updateInner（update 的无锁内核），不能调 store.update()：update() 会再次
      //   进 _serialize，而互斥量此刻正被本周期占用 → 自等待死锁（store 不改，故走内核入口）。
      const restored = await this.profiles._serialize(async () => {
        const prof = this.profiles.restoreFromTrash(raw);
        if (!prof || !prof.archivedAt) return { prof, unarchived: false }; // 已可用（如回收区记录被外部改过）就不动它
        const live = await this.profiles._updateInner(prof.id, { restore: true });
        return { prof: live, unarchived: true };
      });
      const prof = restored.prof;
      if (!prof) return this.json(res, 404, { error: '回收区数据已搬回，但档案文件缺失，无法恢复' });
      // 与 GET /api/profiles 的摘要字段保持一致（不把内部存储细节泄漏成新契约）
      const summary = {
        id: prof.id, nickname: prof.nickname, avatarId: prof.avatarId, bio: prof.bio,
        // M1 §4.2：恢复后前端拿到的摘要字段与 GET /api/profiles 完全一致（含自定义头像与取图 URL）
        customAvatar: prof.customAvatar || null,
        avatarUrl: avatarUrlOf(prof),
        preferences: prof.preferences || { fontScale: 1, layout: 'reading', reducedMotion: false },
        createdAt: prof.createdAt, updatedAt: prof.updatedAt, revision: prof.revision,
        archivedAt: prof.archivedAt || null, lastUsedAt: prof.lastUsedAt || prof.updatedAt,
      };
      // unarchived 只做加法：现有 { ok, profile } 契约不动
      return this.json(res, 200, { ok: true, profile: summary, unarchived: restored.unarchived });
    } catch (e) {
      return this.json(res, this.statusOf(e, 400), { error: e.message });
    }
  }

  // ---------- 自定义头像（M1 §4.3：三个窄接口）----------

  /**
   * `PUT /api/profiles/:id/avatar`：原始 PNG body（Content-Type 精确 image/png）+ `X-Profile-Revision`
   * → `{ profile, avatarUrl }`。
   *
   * 落盘顺序与失败语义全部在 ProfileStore.setAvatar 里（先写图 → 校验 → 原子替换 → 再更新 profile.json）；
   * 本方法只做 HTTP 层的事：读取并发凭据、读原始字节、把语义码原样透传。
   */
  async putProfileAvatar(res, req, pid) {
    try {
      const expectedRevision = parseProfileRevisionHeader(req);
      const buffer = await this.readAvatarBody(req);
      const out = await this.profiles.setAvatar(pid, buffer, { expectedRevision });
      return this.json(res, 200, { profile: out.profile, avatarUrl: out.avatarUrl });
    } catch (e) {
      // 415（类型）/413（超限）/400（PNG 判定或 revision 非法）/404/409 原样透传；fs 字符串码 → 500
      return this.json(res, this.statusOf(e, 400), { error: e.message });
    }
  }

  /**
   * `DELETE /api/profiles/:id/avatar`（+ `X-Profile-Revision`）→ `{ profile, avatarUrl: null }`。
   * 语义是"改用内置头像"：档案的 `avatarId` 一个字节都不动，删除后前端按 avatarId 显示内置徽记
   * （不回退成破图 —— 判据就是响应里的 avatarUrl 为 null、且 GET 该 URL 明确 404）。
   */
  async deleteProfileAvatar(res, req, pid) {
    try {
      const expectedRevision = parseProfileRevisionHeader(req);
      const out = await this.profiles.clearAvatar(pid, { expectedRevision });
      return this.json(res, 200, { profile: out.profile, avatarUrl: out.avatarUrl });
    } catch (e) {
      return this.json(res, this.statusOf(e, 400), { error: e.message });
    }
  }

  /**
   * `GET /api/profiles/:id/avatar?v=<sha256>`：PNG 字节 + **强 ETag**（内容哈希，无 W/ 前缀）+ 私有缓存。
   *  · 只服务本机管理会话（路由层门禁，与其它档案 GET 一致）；
   *  · 三重核对（档案有元数据 / 文件在 / 结构与哈希都对）见 ProfileStore.readAvatar：
   *    404 = 没有该头像、文件缺失、URL 版本过期；500 = 文件损坏或与元数据不一致；
   *  · **绝不返回 HTML 冒充图片**：任何失败都是 JSON 错误体，前端据此回落 `avatarId` 内置徽记。
   */
  getProfileAvatar(req, res, pid, query) {
    let av;
    try {
      av = this.profiles.readAvatar(pid, { expectedSha: query.get('v') || null });
    } catch (e) {
      return this.json(res, this.statusOf(e, 404), { error: e.message });
    }
    if (etagMatches(req.headers && req.headers['if-none-match'], av.etag)) {
      res.writeHead(304, { ETag: av.etag, 'Cache-Control': AVATAR_CACHE_CONTROL });
      return void res.end();
    }
    res.writeHead(200, {
      'Content-Type': av.mime,
      'Content-Length': String(av.data.length),
      ETag: av.etag, // 强 ETag：内容哈希，绝不用 W/ 弱标签
      'Cache-Control': AVATAR_CACHE_CONTROL, // URL 已由内容哈希版本化 ⇒ 私有长缓存
      'X-Content-Type-Options': 'nosniff',
    });
    return void res.end(av.data);
  }

  importPreviewRes(pkg) {
    try {
      const checked = transfer.validateImportPackage(pkg);
      return Promise.resolve({ status: 200, body: { ok: true, preview: transfer.previewImport(checked) } });
    } catch (e) { return Promise.resolve({ status: this.statusOf(e, 400), body: { error: e.message } }); }
  }

  /** 重试清理历史导入残留（复审 P2-3；FIN-02 加固）：读取 saveDir 下的 .import-recovery-*.json，
   *  再次删除清单文件并回收档案；全部成功才删除记录。逐条尽力而为，失败保留记录下次再试。
   *  FIN-02（计划书 §6.2-6/7）：恢复幂等（ENOENT=已清理，读权限错误≠不存在）；
   *  清理目标限定在 saveDir 内；损坏记录保留并上报，不得假装已处理。
   *  @returns {{ cleaned: number, kept: Array<{file:string,reason:string}> }} */
  async _retryImportRecoveries() {
    let files = [];
    try { files = fs.readdirSync(this.saveDir).filter((f) => f.startsWith('.import-recovery-') && f.endsWith('.json')); } catch (_) { return { cleaned: 0, kept: [] }; }
    const kept = [];
    let cleaned = 0;
    const saveRoot = path.join(this.saveDir) + path.sep;
    for (const name of files) {
      const full = path.join(this.saveDir, name);
      let rec = null;
      try { rec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (_) { kept.push({ file: name, reason: 'corrupt' }); continue; }
      let dirty = false;
      for (const rel of rec.files || []) {
        let target = null;
        try {
          target = path.isAbsolute(rel) ? path.normalize(rel) : path.join(this.saveDir, rel);
        } catch (_) { dirty = true; continue; }
        // 越界路径（历史绝对路径不在数据根内 / 相对名逃逸）：拒绝删除，视为脏
        if (target !== this.saveDir && !target.startsWith(saveRoot)) { dirty = true; continue; }
        try {
          fs.unlinkSync(target);
        } catch (e) {
          if (e?.code !== 'ENOENT') dirty = true; // ENOENT = 早已清理，不是失败
        }
      }
      if (rec.profileId) {
        try {
          let prof = null;
          try { prof = this.profiles.get(rec.profileId); } catch (_) { prof = null; } // 已不存在 = 早已清理干净，不是失败
          if (prof) {
            try { await this.profiles.update(rec.profileId, { archive: true }); } catch (_) { /* 已归档则直接删 */ }
            await this.profiles.trash(rec.profileId);
          }
        } catch (_) { dirty = true; }
      }
      if (!dirty) {
        try { fs.unlinkSync(full); cleaned++; } catch (_) { kept.push({ file: name, reason: 'record-unlink' }); }
      } else {
        kept.push({ file: name, reason: 'residue' });
      }
    }
    return { cleaned, kept };
  }

  importApplyRes(pkg) {
    return Promise.resolve().then(async () => {
      // 校验前移（审核 P2-4）：validateImportPackage 现在逐记录检查 players/events/board/rules/notes，
      // 任何一条不合法都在**写盘之前**整体拒绝。写入循环里的错误只剩真实 I/O 故障。
      const retry = await this._retryImportRecoveries(); // 先清理上一次失败的残留（若失败未清理完会保留记录）
      const checked = transfer.validateImportPackage(pkg);
      // M1 §4.4：头像的 Base64/体积/PNG 结构/尺寸/哈希校验在 validateImportPackage 里已经做过一次；
      // 这里再解一次只为拿到要写入的字节。**必须在 profiles.create 之前**：任何头像问题都不得
      // 先建出一份档案再回滚（"校验失败不写盘"是整次导入的承诺）。
      const avatarPayload = transfer.decodeAvatarPayload(checked.profile.customAvatar);
      const prof = await this.profiles.create({
        // R02：**原样保留昵称**。这里曾经无条件拼一个「（导入）」后缀，于是 17–20 字的合法昵称
        // 一导入就变成 21+ 字，被 store 的长度校验拒成 400；多轮回导还会越拼越长。
        // 现在：重名是允许的（身份由 create 生成的新 UUID 区分），「这是副本」只由界面说明，
        // 不写进用户原文、也不截断。
        nickname: checked.profile.nickname,
        avatarId: checked.profile.avatarId || 'scholar',
        bio: checked.profile.bio || '',
        preferences: checked.profile.preferences, // 偏好随包继承（PROF-04）
      });
      const gameMap = transfer.buildGameIdMap(checked);
      const written = []; // 已 rename 成功的存档：回滚清单
      const tmps = [];    // 已写出的 .tmp-*（rename 失败时会残留）：同样必须回收（复审 P2-3）
      try {
        // M1 §4.4：自定义头像落在**新档案目录**（prof.newId 由 create 生成的新 UUID），走与上传
        // 完全相同的存储路径（tmp → 校验 → 原子 rename → 更新 profile.json）。这一步失败参与
        // 下面整次导入的回滚（档案进回收站 + 已写存档/临时文件清理 + 恢复记录）。
        if (avatarPayload) await this.profiles.setAvatar(prof.id, avatarPayload.data);
        const notes = checked.notes || {};
        let importedNotes = 0;
        for (const g of checked.games) {
          const newId = gameMap[g.id];
          const doc = { schemaVersion: 2, tokens: {}, mock: !!g.mock,
            ownerProfileId: prof.id, ownerNicknameSnapshot: prof.nickname,
            ownerHumanSeat: (g.players || []).find((p) => p.isHuman)?.seat ?? null, profileSchemaVersion: 1,
            game: { ...g, id: newId, finished: true }, anchor: null, review: null, savedAt: Date.now() };
          const finalFile = path.join(this.saveDir, newId + '.json');
          const tmpFile = tmpPathFor(finalFile); // 命名统一（TMP_PREFIX 家族，见文件头注释）
          tmps.push(tmpFile);
          await fs.promises.writeFile(tmpFile, JSON.stringify(doc, null, 2));
          await fs.promises.rename(tmpFile, finalFile);
          written.push(finalFile);
          // 笔记随局落地（PROF-04）：旧 gameId → 新 gameId 重映射，座位经白名单规范化。
          // 审核 P1-2 复验：**不再吞掉写盘故障**——磁盘失败视为整次导入失败，走下方回滚。
          const noteDoc = notes[g.id];
          // FIX-07：判据同 profileExport —— 只有"有意义"的标注才落地/计数，
          // 全默认值（旧前端的"清除"痕迹）既不建文件也不进 importedNotes（存储不再只增不减）
          if (hasMeaningfulAnnotations(noteDoc)) {
            await this.annotations.put({ profileId: prof.id, gameId: newId, expectedRevision: 0, seats: noteDoc.seats });
            importedNotes++;
          }
        }
        // NEW-08：导入数量必须来自**真正完成落盘的记录**，不能用"写循环之前就定好的重映射表键数"
        // 冒充成功数（写入被吞/循环提前结束时，键数会报"全部成功"——实测把 rename 从第 2 局起变成
        // 静默失效，接口仍报 imported=3 而磁盘上只有 1 局）。重映射 id 两两不同（重复 id 已被
        // validateImportPackage 拒绝），这里逐个**核实文件确实在磁盘上**再计数。
        const importedGames = [...new Set(Object.values(gameMap))]
          .filter((id) => fs.existsSync(path.join(this.saveDir, `${id}.json`))).length;
        const body = { ok: true, profileId: prof.id, imported: importedGames, gameMap, importedNotes };
        // FIN-02：损坏/未清完的历史恢复记录必须如实上报，不得假装已处理
        if (retry.kept.length) body.pendingRecoveries = retry.kept;
        return { status: 200, body };
      } catch (writeErr) {
        // 事务回滚（复审 P2-3）：尽力删除已写存档与残留临时文件，然后**核实**清理结果。
        // FIN-02 状态模型（计划书 §6.2）：rolledBack 只取决于"清理是否核实完成"，
        // 与恢复记录是否写成功**解耦**——记录写不下时同样必须报 cleanupPending，
        // 绝不允许"有残留却声称已回滚"。
        const targets = [...written, ...tmps];
        const residue = [];
        for (const f of targets) {
          try {
            fs.unlinkSync(f);
          } catch (e) {
            if (e?.code !== 'ENOENT') residue.push(path.basename(f)); // ENOENT = 本就不存在，视为已清
          }
        }
        let profileCleaned = true;
        try {
          await this.profiles.update(prof.id, { archive: true });
          await this.profiles.trash(prof.id);
        } catch (_) { profileCleaned = false; }
        const cleanupComplete = residue.length === 0 && profileCleaned;
        let recoveryFile = null;
        let recoveryPersisted = false;
        if (!cleanupComplete) {
          recoveryFile = `.import-recovery-${prof.id}-${Date.now()}.json`;
          const recPath = path.join(this.saveDir, recoveryFile);
          const recTmp = tmpPathFor(recPath); // 不得匹配 .import-recovery-* 前缀，防止重试读到半截文件
          try {
            // 完整写入 + 原子落地（计划书 §6.2-5）
            await fs.promises.writeFile(recTmp, JSON.stringify({
              version: 2, profileId: prof.id,
              files: targets.map((f) => path.basename(f)), // 只存相对名：恢复记录不得携带可删任意位置的无约束路径
              residue, profileCleaned, error: String(writeErr.message), createdAt: Date.now(),
            }, null, 2));
            await fs.promises.rename(recTmp, recPath);
            recoveryPersisted = true;
          } catch (_) {
            recoveryPersisted = false; // 记录未落盘：响应必须如实说明，不得承诺重启后自动找回
            recoveryFile = null;
          }
        }
        // 只有数字语义码（4xx/5xx）才作为 HTTP 状态；真实 fs 错误的 code 是 EPERM 等字符串 → 500
        const status = this.statusOf(writeErr, 500);
        if (cleanupComplete) {
          return { status, body: { error: `导入失败，已回滚本次写入：${writeErr.message}`, rolledBack: true, cleanupComplete: true } };
        }
        const body = {
          error: recoveryPersisted
            ? `导入失败，回滚未完成（已保留恢复记录 ${recoveryFile}，可在排除故障后重试导入自动清理）：${writeErr.message}`
            : `导入失败，回滚未完成，且恢复记录写入失败（${writeErr.message}）；残留清单在 residue 字段，请人工核查保存目录后处置`,
          rolledBack: false,
          cleanupPending: true,
          cleanupComplete: false,
          recoveryPersisted,
          profileId: prof.id,
          residue,
        };
        if (recoveryPersisted) body.recoveryFile = recoveryFile;
        return { status, body };
      }
    }).catch((e) => ({ status: this.statusOf(e, 400), body: { error: e.message } }));
  }

  /** 读取 JSON 文件（供 profileStats/profileGames 使用），失败返回 fallback */
  _readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { return fallback; }
  }

  /**
   * 严格读一份存档：把"文件坏了"与"文件不存在"分开。
   *
   * 旧实现用 `_readJson(file, null)` —— 坏 JSON 与缺失**同样**退化成 null，于是
   * GET /api/profiles/:id/games 把一份损坏的存档当成"这份档案没有这一局"（甚至整页空），
   * 静默少数据。计划书 §6 接口规则最后一条（"损坏数据返回明确错误，不能伪装成空列表"）
   * 明确禁止这种伪装，所以这两条档案路由改走本方法。
   *
   * 刻意**不动** `_readJson` 的其它调用者（profileStats 等）：它们的语义（跳过坏档、
   * 继续统计其余）是既有的，本轮不重写统计（范围外）。
   *
   * @returns {{ok:true, doc:object}|{ok:false, missing:true}|{ok:false, error:string}}
   */
  _readSaveDocStrict(file) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      // 竞态（刚被删）或路径是个目录：按"不存在"处理，不冤枉成损坏
      if (e && (e.code === 'ENOENT' || e.code === 'EISDIR')) return { ok: false, missing: true };
      return { ok: false, error: `${path.basename(file)} 读取失败：${e.message}` };
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: `${path.basename(file)} 不是合法 JSON：${e.message}` };
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { ok: false, error: `${path.basename(file)} 结构损坏：顶层不是 JSON 对象` };
    }
    return { ok: true, doc };
  }

  /**
   * 存档目录里"可能是一份对局存档"的文件名。
   * 排除：`experiences.json`（经验池）、`.import-recovery-*.json` 等隐藏/中间文件
   * （导入恢复记录与 tmp 族都不以 `.json` 结尾或以 `.` 开头）。其余 `.json` 一律参与
   * 损坏检查 —— 坏档不因为"看不出属于谁"就放行。
   */
  _saveFileNames() {
    return fs.readdirSync(this.saveDir)
      .filter((f) => f.endsWith('.json') && f !== 'experiences.json' && !f.startsWith('.'));
  }

  /** 档案战绩（方案 §3.7）：Mock/观战/终止/平局分桶，正式胜率只算真实自然局（动态阵营按 crush 还原） */
  profileStats(res, pid) {
    try {
      const prof = this.profiles.get(pid);
      if (prof.archivedAt) return this.json(res, 404, { error: '该档案已归档' });
      const rows = [];
      for (const f of fs.readdirSync(this.saveDir)) {
        if (!f.endsWith('.json') || f === 'experiences.json') continue;
        const doc = this._readJson(path.join(this.saveDir, f), null);
        if (!doc || doc.ownerProfileId !== pid || !doc.game) continue;
        const gm = doc.game;
        const human = (gm.players || []).find((p) => p.isHuman) || null;
        const spectate = !(gm.players || []).some((p) => p.isHuman);
        const isTerminated = /终止/.test(gm.winReason || '');
        const bucket = doc.mock ? 'mock' : spectate ? 'spectate' : isTerminated ? 'terminated' : 'real';
        // 最终阵营：暗恋者按 crush 还原（A12 动态阵营）
        let faction = null;
        if (human && human.role) {
          if (human.role === 'admirer' && gm.crush && gm.crush[human.seat]) {
            const t = (gm.players || []).find((p) => p.seat === gm.crush[human.seat]);
            if (t && t.role && ROLES[t.role]) faction = ROLES[t.role].category === 'wolf' ? 'wolf' : 'good';
          } else if (ROLES[human.role]) {
            faction = ROLES[human.role].category === 'wolf' ? 'wolf' : 'good';
          }
        }
        rows.push({ id: gm.id, day: gm.day || 0, bucket, faction, winner: gm.winner || null, finished: !!gm.finished });
      }
      const real = rows.filter((r) => r.bucket === 'real' && r.finished);
      // 胜/负/平互斥判定（审核 P2-4，§3.7）：只有"阵营可判定 且 winner 非平局"的局才进胜负；
      // 平局（draw/none）与阵营不可判定的局单列为平，绝不允许把平局算成胜（旧公式把
      // winner!=='wolf' 的平局判给好人阵营 → 出现"胜1 负-1"）。胜率分母 = wins+losses。
      const judged = real.filter((r) => r.faction && (r.winner === 'wolf' || r.winner === 'good'));
      const wins = judged.filter((r) => (r.faction === 'wolf') === (r.winner === 'wolf')).length;
      const losses = judged.length - wins;
      const draws = real.length - judged.length;
      return this.json(res, 200, {
        profileId: pid, nickname: prof.nickname,
        total: rows.length, real: real.length,
        wins, losses, draws,
        byBucket: {
          real: real.length,
          mock: rows.filter((r) => r.bucket === 'mock').length,
          spectate: rows.filter((r) => r.bucket === 'spectate').length,
          terminated: rows.filter((r) => r.bucket === 'terminated').length,
        },
      });
    } catch (e) { return this.json(res, this.statusOf(e, 500), { error: e.message }); }
  }

  /**
   * 把任意"时间表示"归一成可比较的毫秒数（M2-b §6："日期统一解析为时间值排序，
   * 不直接比较混合数字和 ISO 字符串"）。
   *
   * 为什么必须有这一步：存档里的 `savedAt` 有两种真实来源 ——
   *   · `saveGame()` 写的是 `Date.now()`（number，ms）；
   *   · 旧文档 / 缺字段回落的是 `mtime.toISOString()`（string），还有 RFC 2822（`Date#toString()`）
   *     这类同样合法的时间串。
   * 旧实现是 `String(b.savedAt).localeCompare(String(a.savedAt))`：数字 "1758…" 与
   * ISO "2026-…" 按**字符串**比大小，'2' > '1' 就把所有 ISO 行都排在所有数字行前面 ——
   * 与真实时间无关。这里改成解析后比数值。
   *
   * 兜底（确定、不崩、不静默乱序）：解析不出来 → 用 `fallbackMs`（调用点传该文件的 mtime）；
   * 连 fallback 都没有 → 0（排最后）。相等时由调用点的次级键（文件名/gameId）定序，
   * 所以同一份数据每次请求的顺序都一样。
   */
  _timeValue(raw, fallbackMs = 0) {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (raw instanceof Date) { const t = raw.getTime(); return Number.isFinite(t) ? t : fallbackMs; }
    if (typeof raw === 'string' && raw.trim()) {
      const s = raw.trim();
      // 纯数字串按 ms 时间戳处理（与 saveGame 的 Date.now() 同一约定），再退回通用解析
      if (/^\d+$/.test(s)) { const n = Number(s); if (Number.isSafeInteger(n)) return n; }
      const t = Date.parse(s);
      if (Number.isFinite(t)) return t;
    }
    return fallbackMs;
  }

  /**
   * 分页参数解析（list / history 共用）。**只接受非负整数**，其余给 400 的可读原因：
   * 静默 clamp 非法值（'abc'、'-1'、'1.5'）会让调用方以为自己拿到了完整数据。
   * 缺省与空串都按"未提供"处理（`?offset=` 等同不传）。
   * 超出上限（`max`）时**截断到上限**（上限是服务端保护线，见文件头常量注释）。
   */
  _pagingInt(query, name, def, max) {
    const raw = query ? query.get(name) : null;
    if (raw === null || raw === '') return { value: def };
    if (!/^\d+$/.test(raw)) return { error: `${name} 必须是非负整数（收到 ${JSON.stringify(raw)}）` };
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) return { error: `${name} 超出可表示范围（收到 ${JSON.stringify(raw)}）` };
    return { value: max === undefined ? n : Math.min(n, max) };
  }

  /** 对局列表的查询参数：status 白名单 + offset/limit 边界（M2-b §6） */
  _gamesListQuery(query) {
    const rawStatus = query ? query.get('status') : null;
    // 空串 = 未提供（前端"不筛选"时常见形态）；给了非空值就必须是三个白名单值之一
    const status = rawStatus === null || rawStatus === '' ? 'all' : rawStatus;
    if (!['all', 'unfinished', 'finished'].includes(status)) {
      return { error: `status 只支持 all / unfinished / finished（收到 ${JSON.stringify(rawStatus)}）` };
    }
    const offset = this._pagingInt(query, 'offset', 0);
    if (offset.error) return { error: offset.error };
    const limit = this._pagingInt(query, 'limit', GAMES_PAGE_DEFAULT, GAMES_PAGE_MAX);
    if (limit.error) return { error: limit.error };
    return { status, offset: offset.value, limit: limit.value };
  }

  /**
   * 合并"磁盘存档 + 内存对局"的对局行（M2-b §6："合并内存和磁盘记录，同一 gameId 只出现
   * 一次，状态以内存为准"）。
   *
   * 规则（逐条对应计划书）：
   *   · 磁盘行 = saveDir 里 ownerProfileId === pid 的存档；损坏的存档**不跳过**，收集成
   *     `corrupt` 并让整次请求以明确错误结束（"不能伪装成空列表"）；
   *   · 内存行 = `this.games` 里 ownerProfileId === pid 的条目。同一 gameId 覆盖磁盘行的
   *     **状态字段**（finished/day/phase/winner/started/mock/inMemory），归属/昵称/savedAt
   *     等摘要字段沿用磁盘行（内存条目本来就不带 savedAt）；
   *   · 只有内存、没有磁盘文件的对局（写盘失败/夹具）也列出来 —— 旧实现只读磁盘，
   *     这类局会凭空消失；
   *   · 排序 = 解析后的时间值倒序（见 _timeValue），同值时按稳定次级键（gameId 或文件名）
   *     倒序定序，保证多次请求顺序一致。
   *
   * 返回值只有 [公开摘要字段]，**不含** tokens/anchor/journal/agentStates/players[].role
   * 等任何敏感或内部上下文（§6："列表只返回公开摘要"）。
   */
  _profileGameRows(pid, prof) {
    const byId = new Map(); // key → { row, t, key }
    const corrupt = [];
    for (const f of this._saveFileNames()) {
      const full = path.join(this.saveDir, f);
      const read = this._readSaveDocStrict(full);
      if (!read.ok) {
        if (!read.missing) corrupt.push(read.error);
        continue;
      }
      const doc = read.doc;
      if (doc.ownerProfileId !== pid) continue;
      const gm = (doc.game && typeof doc.game === 'object' && !Array.isArray(doc.game)) ? doc.game : {};
      const id = gm.id;
      // 没有 gameId 的档无法去重也无法定位（例如手工夹具）：用文件名当键，行照旧列出（兼容旧行为）
      const key = (id === undefined || id === null || id === '') ? `\u0000file:${f}` : String(id);
      let mtimeMs = 0;
      let haveMtime = false;
      try { mtimeMs = fs.statSync(full).mtimeMs; haveMtime = true; } catch (_) { /* 拿不到 mtime 就回落 null，不编时间 */ }
      const rawSaved = doc.savedAt || null; // 与旧实现同形：文档值优先，缺失/假值回落 mtime
      const row = {
        id, day: gm.day, phase: gm.phase, finished: !!gm.finished, winner: gm.winner || null, mock: !!doc.mock,
        started: !!gm.started, inMemory: this.games.has(id),
        resumable: !!(doc.anchor && gm.started && !gm.finished),
        ownerProfileId: doc.ownerProfileId, ownerNickname: doc.ownerNicknameSnapshot || prof.nickname,
        savedAt: rawSaved !== null ? rawSaved : (haveMtime ? new Date(mtimeMs).toISOString() : null),
      };
      // anchor 只留在内部条目里（供内存行重算 resumable），不进响应 —— 行字段集是公开摘要白名单
      byId.set(key, { row, t: this._timeValue(rawSaved, haveMtime ? mtimeMs : 0), key, anchor: !!doc.anchor });
    }
    for (const [gid, entry] of this.games) {
      if (!entry || !entry.game || entry.ownerProfileId !== pid) continue;
      const gm = entry.game;
      const base = byId.get(String(gid));
      const t = base ? base.t : this._timeValue(entry.lastAccess || entry.createdAt || 0, 0);
      const row = Object.assign({}, base ? base.row : {}, {
        id: gid,
        day: gm.day, phase: gm.phase,
        finished: !!gm.finished, // 状态以内存为准（磁盘可能是上一拍快照）
        winner: gm.winner || null,
        mock: !!entry.mock,
        started: !!gm.started,
        inMemory: true,
        // 派生字段必须跟着"以内存为准"重算，不能继承磁盘行里的旧结论：
        // 磁盘快照说 finished:true 时它的 resumable=false（旧结论），而内存说这局还在跑 ⇒ 仍可恢复。
        // 判据 = 磁盘有没有锚点（唯一的重建来源）+ 内存的权威状态。
        resumable: !!(base && base.anchor) && !!gm.started && !gm.finished,
        ownerProfileId: pid,
        ownerNickname: (base && base.row.ownerNickname) || entry.ownerNicknameSnapshot || prof.nickname,
        savedAt: base ? base.row.savedAt : new Date(t).toISOString(),
      });
      byId.set(String(gid), { row, t, key: String(gid) });
    }
    if (corrupt.length) {
      const detail = corrupt.slice(0, 3).join('；') + (corrupt.length > 3 ? `；…另有 ${corrupt.length - 3} 份损坏存档` : '');
      throw Object.assign(new Error(`存档目录存在损坏数据（${corrupt.length} 份），已拒绝返回可能不完整的对局列表：${detail}`), { code: 500 });
    }
    return [...byId.values()]
      .sort((a, b) => (b.t - a.t) || b.key.localeCompare(a.key))
      .map((x) => x.row);
  }

  /**
   * 档案对局列表（仅本档案，字段白名单；M2-b §6 分页 / 筛选 / 合并内存+磁盘）。
   *
   * 兼容性：无参数调用与旧版同形 —— `rows` 仍在（默认每页 30 条，见 §6 原文），只是多回
   * `total / hasMore / offset / limit / status` 这几个**新增**字段。旧调用方读 `rows` 不受影响。
   *
   * @param {URLSearchParams} [query] status=all|unfinished|finished、offset、limit
   */
  profileGames(res, pid, query) {
    try {
      const prof = this.profiles.get(pid);
      if (prof.archivedAt) return this.json(res, 404, { error: '该档案已归档' });
      const q = this._gamesListQuery(query);
      if (q.error) return this.json(res, 400, { error: q.error });
      const all = this._profileGameRows(pid, prof); // 损坏数据在这里抛（明确错误，不退化成空列表）
      const filtered = all.filter((r) => q.status === 'all' || (q.status === 'finished' ? r.finished : !r.finished));
      const rows = filtered.slice(q.offset, q.offset + q.limit);
      return this.json(res, 200, {
        rows,
        total: filtered.length,
        hasMore: q.offset + rows.length < filtered.length,
        offset: q.offset,
        limit: q.limit,
        status: q.status,
      });
    } catch (e) { return this.json(res, this.statusOf(e, 500), { error: e.message }); }
  }

  /**
   * GET /api/profiles/:id/games/:gameId/history（M2-b §6）：已结束对局的**只读**事件历史，
   * 按事件游标（seq）分页。
   *
   * 为什么这条路径不可能启动引擎或调用模型（逐条对应代码，不是承诺）：
   *   · 内存侧只做 `this.games.get(gameId)` —— Api#getGame 只查 Map，**不**从锚点重建
   *     （重建 = new Game + 回填 AI 记忆，那是 /resume 的事）；
   *   · 磁盘侧只 `JSON.parse` 存档文件（_readSaveDocStrict），绝不构造 Game、绝不取
   *     agentFactory / 绝不进 runGame；
   *   · 事件只做"过滤 + 截断 + 白名单映射"，没有任何写盘或续跑分支。
   *
   * 下游可见性：只下发 `visibleTo === 'all'` 的公开事件，且字段白名单
   * （seq/day/phase/type/actor/text/ts）—— 座位私有事件（发牌身份、狼队密谈、查验结果）
   * 与 `visibleTo: 'god'` 的事件、`data`（可能带内部结构）一律不出现在响应里。
   *
   * 错误语义：
   *   · 非管理会话 → 401（授权先于存在性，NEW-16）；
   *   · 档案不存在/已归档 → 404；gameId 形状非法（含路径分隔符等）→ 400；
   *   · 对局不存在 **或** 不属于该档案 → 同一条 404（不给"这个 gameId 属于谁"的探针）；
   *   · 对局未结束 → 409（与 /resume 的"仍在运行中"同一种状态冲突语义）；
   *   · 存档损坏或已结束局缺事件流 → 500 + 可读原因（绝不退化成空历史）。
   *
   * @param {URLSearchParams} [query] after（事件游标，默认 0）、limit（默认 100、上限 200）
   */
  profileGameHistory(res, pid, gameId, query) {
    try {
      const prof = this.profiles.get(pid);
      if (prof.archivedAt) return this.json(res, 404, { error: '该档案已归档' });
      // gameId 进文件名：先按白名单收敛（Windows 上 '\' 与 ':' 都能跳出 saveDir，路径穿越
      // 会让这条路由变成"读任意 .json"）。合法对局 id 是 tokenId() 的 [A-Za-z0-9] 串。
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(gameId))) {
        return this.json(res, 400, { error: 'gameId 非法' });
      }
      const after = this._pagingInt(query, 'after', 0);
      if (after.error) return this.json(res, 400, { error: after.error });
      const limit = this._pagingInt(query, 'limit', HISTORY_PAGE_DEFAULT, HISTORY_PAGE_MAX);
      if (limit.error) return this.json(res, 400, { error: limit.error });

      const file = path.join(this.saveDir, `${gameId}.json`);
      const read = this._readSaveDocStrict(file);
      const doc = read.ok ? read.doc : null;
      const live = this.games.get(gameId) || null;
      const ownedByDisk = !!doc && doc.ownerProfileId === pid;
      const ownedByMem = !!live && !!live.game && live.ownerProfileId === pid;
      if (!ownedByDisk && !ownedByMem) {
        if (!read.ok && !read.missing) {
          return this.json(res, 500, { error: `存档损坏，无法读取该对局历史：${read.error}` });
        }
        return this.json(res, 404, { error: '对局不存在或不属于该档案' });
      }
      // 状态以内存为准：内存里这局还在跑 ⇒ 即使磁盘是"已结束"的旧快照也不能当历史放开
      const finished = (live && live.game) ? !!live.game.finished : !!(doc && doc.game && doc.game.finished);
      if (!finished) return this.json(res, 409, { error: '该对局尚未结束，历史仅对已结束对局开放' });

      const eventLists = [
        live && live.game ? live.game.events : null,
        doc && doc.game ? doc.game.events : null,
        doc && doc.anchor ? doc.anchor.events : null, // 旧存档的终局事件只落在 anchor 里
      ];
      const events = eventLists.find((x) => Array.isArray(x) && x.length)
        || eventLists.find((x) => Array.isArray(x))
        || null;
      if (events === null) {
        return this.json(res, 500, { error: `存档缺少事件流（${path.basename(file)}），无法生成该对局历史` });
      }
      // 只保留公开事件，并**显式按 seq 排序**（不依赖存档里数组的物理顺序）
      const pub = events
        .filter((e) => e && e.visibleTo === 'all' && Number.isFinite(Number(e.seq)))
        .sort((a, b) => Number(a.seq) - Number(b.seq));
      const tail = pub.filter((e) => Number(e.seq) > after.value);
      const page = tail.slice(0, limit.value)
        .map((e) => ({
          seq: Number(e.seq), day: e.day, phase: e.phase, type: e.type,
          actor: e.actor === undefined ? null : e.actor, text: e.text || '', ts: e.ts,
        }));
      const nextAfter = page.length ? page[page.length - 1].seq : after.value;
      return this.json(res, 200, {
        gameId,
        finished: true,
        rows: page,
        total: tail.length,
        hasMore: page.length < tail.length,
        after: after.value,
        limit: limit.value,
        nextAfter,
      });
    } catch (e) { return this.json(res, this.statusOf(e, 500), { error: e.message }); }
  }

  /**
   * POST /api/profiles/:id/touch（M2-b §6 第一项）：记录"真实最近使用"。
   *
   * 复用建局路径的**同一条**实现（_touchProfileUsage → ProfileStore.touch），不另写一份写盘
   * 逻辑，行为不可能漂移。
   *
   * 为什么不制造资料编辑 revision 冲突（计划书原话）：`ProfileStore.touch` 只改
   * `lastUsedAt`，**不动 revision、不动 updatedAt**（使用 ≠ 编辑）。所以客户端手里的
   * 过期 expectedRevision 在 touch 之后依旧成立 —— 由真实 HTTP 用例钉住：
   * touch（可连发多次）之后，用 touch 之前的 revision PATCH 仍必须 200。
   *
   * 与建局路径**唯一**差别：那里的 touch 失败只 warn（不能让开局失败），这里是用户显式
   * 发起的写请求，失败必须如实报错，不能回 200 假装记上了（传 raise:true）。
   *
   * 已归档档案：与 stats/games 同一条语义（404「该档案已归档」）。store.touch 对归档档案是
   * "不写盘的 no-op"，若这里回 200 就等于谎称记录成功（诚实边界见本轮报告）。
   */
  async touchProfile(res, pid) {
    try {
      const prof = this.profiles.get(pid); // 不存在 → NotFoundError(404)
      if (prof.archivedAt) return this.json(res, 404, { error: '该档案已归档' });
      await this._touchProfileUsage(pid, { raise: true });
      const after = this.profiles.get(pid);
      return this.json(res, 200, { ok: true, profileId: pid, lastUsedAt: after.lastUsedAt, revision: after.revision });
    } catch (e) {
      return this.json(res, this.statusOf(e, 500), { error: e.message });
    }
  }

  /**
   * 档案导出（PROF-04，§3.5）：生成脱敏的版本化 JSON 包（用户主动下载，不联网上传）。
   * 内容 = 档案资料 + 已结束局 + 各局笔记；不含密钥/令牌/Cookie/锚点/journal。
   */
  profileExport(res, pid) {
    try {
      const prof = this.profiles.get(pid);
      const games = transfer.collectExportableGames(this.saveDir, pid, { strict: true });
      // M1 §4.4：导出前**重新读盘并重新计算哈希**与档案元数据核对（ProfileStore.readAvatar 内部三重核对）。
      // 文件丢失、结构损坏或被换过 ⇒ 整次导出失败（500 + 指明头像问题），绝不静默导出一份看似完整的包。
      let avatar = null;
      if (prof.customAvatar) {
        try {
          avatar = this.profiles.readAvatar(pid);
        } catch (e) {
          return this.json(res, 500, { error: `导出失败：${e.message}` });
        }
      }
      const notes = {};
      for (const g of games) {
        // §7：笔记文件**缺失**可以表示"没有笔记"，但**损坏或读取错误不能静默当作没有笔记** ——
        // 否则导出包看起来完整，用户归档/删除档案后这些笔记就再无出口（静默丢数据）。
        // 严格读只在这里开启；AnnotationsStore.get 的默认行为（UI 侧）不变。
        // 失败时错误冒到本函数外层 catch，成为 500 + 明确原因。
        const doc = this.annotations.get(pid, g.id, { strict: true });
        // FIX-07：计数判据是"有没有**有意义**的座位"，不是"seats 里有没有键"——
        // 旧前端用 PUT 写全默认值来"清除标注"，那些座位与"已清空"无法区分，
        // 按 `Object.keys(seats).length` 计数会让导出包虚报"这局有笔记"。
        if (doc && hasMeaningfulAnnotations(doc)) notes[g.id] = doc;
      }
      const pkg = transfer.buildExportPackage({ profile: prof, games, notes, hostLabel: '本机导出', avatar });
      const body = JSON.stringify(pkg, null, 2);
      if (Buffer.byteLength(body) > transfer.MAX_BYTES) {
        return this.json(res, 413, { error: `导出包超过上限（${Math.round(transfer.MAX_BYTES / 1048576)} MiB），请减少可导出对局后重试` });
      }
      const fname = `ww-profile-${(prof.nickname || 'player').replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
        'Cache-Control': 'no-store',
      });
      return void res.end(body);
    } catch (e) { return this.json(res, this.statusOf(e, 500), { error: e.message }); }
  }

  // ---------- 私人标注（NOTE-02）----------
  /** 访问权：管理会话 或 持有本局玩家/上帝令牌；且标注归属 = 对局 owner 档案 */
  _annotationAccess(req, entry, query, body) {
    if (this.auth.isManagement(req)) return true;
    const token = (query && query.get('token')) || (body && body.token);
    if (!token) return false;
    return token === entry.tokens.player || token === entry.tokens.god;
  }

  gameAnnotationsGet(res, entry, query, req) {
    // NEW-11：授权先于状态。旧顺序先查 ownerProfileId，未授权调用者于是能用
    // 404「该对局没有归属档案」与 403「token 无效」的差异判定该局的归属形态。
    if (!this._annotationAccess(req, entry, query)) return this.json(res, 403, { error: 'token 无效' });
    const pid = entry.ownerProfileId;
    if (!pid) return this.json(res, 404, { error: '该对局没有归属档案（旧局/观战局）' });
    return this.json(res, 200, { annotations: this.annotations.get(pid, entry.game.id), revision: this.annotations.get(pid, entry.game.id).revision });
  }

  async gameAnnotationsPut(res, entry, req, body) {
    if (!this._annotationAccess(req, entry, { get: () => body.token })) return this.json(res, 403, { error: 'token 无效' });
    const pid = entry.ownerProfileId;
    if (!pid) return this.json(res, 404, { error: '该对局没有归属档案' });
    // AC-01：必须走与 DELETE/clearSeat 同一条每文件串行队列——
    // 旧实现 putSync() 在队列外同步执行，与入队的 clearSeat 并发时双方都 200、PUT 内容丢失
    try {
      const doc = await this.annotations.put({ profileId: pid, gameId: entry.game.id, expectedRevision: body.expectedRevision, seats: body.seats || {} });
      return this.json(res, 200, { annotations: doc, revision: doc.revision });
    } catch (e) {
      if (e.code === 409 || e.name === 'AnnotationConflict') return this.json(res, 409, { error: e.message, code: 409 });
      // 数值语义码（4xx）透传；真实 IO 故障（EACCES/ENOSPC 等字符串码）按服务端错误 500
      return this.json(res, this.statusOf(e), { error: e.message });
    }
  }

  /** 清除单个座位笔记（撤销语义的存储端原语）：权限矩阵同 PUT，expectedRevision 乐观并发 */
  async gameAnnotationDelete(res, entry, req, query) {
    // NEW-11：同 GET/PUT —— 授权先于归属状态
    if (!this._annotationAccess(req, entry, query)) return this.json(res, 403, { error: 'token 无效' });
    const pid = entry.ownerProfileId;
    if (!pid) return this.json(res, 404, { error: '该对局没有归属档案' });
    const seat = query.get('seat');
    if (!/^[0-9]{1,3}$/.test(String(seat || ''))) return this.json(res, 400, { error: 'seat 必须是数字座位号' });
    const rev = query.get('expectedRevision');
    try {
      const doc = await this.annotations.clearSeat({
        profileId: pid, gameId: entry.game.id, seat: Number(seat),
        expectedRevision: rev === null ? undefined : Number(rev),
      });
      return this.json(res, 200, { annotations: doc, revision: doc.revision });
    } catch (e) {
      if (e.name === 'AnnotationConflict' || e.code === 409) return this.json(res, 409, { error: e.message, code: 409 });
      return this.json(res, this.statusOf(e), { error: e.message });
    }
  }

  listSaves(res) {
    try {
      const files = fs.readdirSync(this.saveDir).filter((f) => f.endsWith('.json') && f !== 'experiences.json');
      const rows = files.map((f) => {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(this.saveDir, f), 'utf8'));
          const g = j.game || j; // 兼容新旧存档格式
          return {
            id: g.id, day: g.day, phase: g.phase, finished: g.finished, started: !!g.started, inMemory: this.games.has(g.id),
            winner: g.winner, winReason: g.winReason,
            paused: g.paused || null,
            ownerProfileId: j.ownerProfileId || null, ownerNickname: j.ownerNicknameSnapshot || null,
            mock: !!j.mock, // 让界面能标出"试玩局"，也便于排查"恢复后是否还走 Mock"
            // 服务重启后（不在内存）或内存中处于暂停态的对局，都可以从锚点续跑
            resumable: !!(j.anchor && g.started && !g.finished && (!this.games.has(g.id) || !!g.paused)),
            seats: g.players.length, date: fs.statSync(path.join(this.saveDir, f)).mtime,
          };
        } catch (_) { return null; }
      }).filter(Boolean).sort((a, b) => new Date(b.date) - new Date(a.date));
      return this.json(res, 200, { rows });
    } catch (e) { return this.json(res, 200, { rows: [] }); }
  }
}

module.exports = { Api };
