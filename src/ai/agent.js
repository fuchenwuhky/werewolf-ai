/**
 * agent.js — AI 玩家智能体（分层记忆版）
 *
 * 架构：每次决策一次性组装 [system, L1纪要+L2实录+局面快照+任务]，
 * 不再 append-only 重放全部历史 → 上下文大小恒定，后期不再变慢。
 * 记忆：L1 每日反思纪要（跨天惰性生成，LLM 失败降级为事实骨架）；
 *      L2 昨天+今天实录（context.js 组装）；快照确定性生成（零幻觉）。
 * 缓存：system 整局稳定；L1/昨日实录在当天内逐字节稳定；快照放最后。
 */
'use strict';
const llm = require('./llm');
const { PRIORITY } = require('./scheduler');
const { buildSystemPrompt, reflectionInstruction, lessonInstruction } = require('./prompts');
const ctx = require('./context');
const effort = require('./effort');
const schemas = require('./schemas');
const journal = require('./journal');
const { renderEvent } = require('../engine/render');

/** 从模型输出中提取 JSON（容忍代码围栏/前后缀文字） */
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try { return JSON.parse(t); } catch (_) { /* 继续 */ }
  const start = t.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { if (inStr) esc = true; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(t.slice(start, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

const DIGEST_MAX_CHARS = 700;

/**
 * 轻量补救重试（E1）的输出上限：决策时间预算已经花光，这次重试必须几秒钟出结果。
 * 1200 tokens 对"给一句合法发言/一个座位号"绰绰有余，而 hardCap 封死意味着
 * 即使模型再想跑长思考，也绝不可能把等待重新拉回几分钟。
 */
const CHEAP_RETRY_MAX_TOKENS = 1200;
const CHEAP_RETRY_HARD_CAP = 2000;

/**
 * 生成中即可对全场公开的任务：只有这些才把流式增量展示给其他玩家。
 * 其余任务（狼队频道、女巫用药、查验…）一律保密——半成品文本同样是私密信息。
 * 注：flow.js 里所有 speech 事件的 context 都是公开的（day/sheriff/pk/lastwords），
 * 狼队频道走的是 wolf_propose 事件，不存在"私密 speech"。
 */
const PUBLIC_LIVE_TASKS = new Set(['speech', 'sheriff_speech', 'pk_speech', 'lastwords']);

/** 纪要生成时忽略的事件类型（与上下文组装保持一致的噪音口径） */
const DIGEST_SKIP_TYPES = new Set(['await_input', 'ai_thinking', 'llm_error', 'ai_reasoning']);

class Agent {
  constructor(player, game, llmCfg, logger, experienceStore = null, journalStore = null) {
    this.player = player;
    this.game = game;
    this.llmCfg = llmCfg;
    this.journal = journalStore || null; // 决策 journal（恢复幂等的关键；null = 不做缓存）
    this.logger = logger || game.logger;
    this.lastSeq = 0;            // 仅用于标记"自上次决策以来的新事件"（◆）
    this.turns = 0;
    this.lastPromptTokens = 0;
    this.contextTokens = 0;      // 本次决策上下文估算（上帝面板可见）
    this.lastReasoning = '';     // 最近一次的内心独白（思考模型的 reasoning 轨迹，上帝面板/复盘用）
    this.compressions = 0;       // 兼容旧统计字段名：实际为"纪要生成次数"
    this.digests = new Map();    // day -> 纪要文本（L1）
    this.suspicion = {};         // seat -> 怀疑度（-100 确定好人 ~ +100 确定是狼，随每日反思更新）
    this._reflecting = new Map(); // day -> Promise（防并发重复反思）
    this._lightDays = [];        // 信息量不足、待与后续日合并的日期
    // 反思节流参数（可在设置页调）：低于阈值不发 LLM（0 = 关闭节流）；纪要总数封顶
    this.digestMinEvents = llmCfg.digestMinEvents != null && Number(llmCfg.digestMinEvents) >= 0
      ? Number(llmCfg.digestMinEvents) : 6;
    this.digestKeep = Number(llmCfg.digestKeep) > 0 ? Number(llmCfg.digestKeep) : 6;
    this._cacheWarned = false;   // 缓存告警每座每局只报一次（服务商缓存 TTL 过期属预期，不必刷屏）
    // 跨局经验：开局时按角色从经验池检索（局内稳定，保前缀缓存）
    this.experienceStore = experienceStore;
    const expText = experienceStore ? experienceStore.forRole(player.role).map((t) => `- ${t}`).join('\n') : '';
    const sys = { role: 'system', content: buildSystemPrompt(game, player, expText) };
    if (llmCfg.cacheControl) {
      sys.content = [{ type: 'text', text: sys.content, cache_control: { type: 'ephemeral' } }];
    }
    this.messages = [sys]; // 只保留 system；决策消息单次组装
  }

  /**
   * 日切边界：后台整理"上一天"的纪要（返回 Promise，但调用方不必 await → 不阻塞流程）。
   *
   * 为什么能在边界就生成：进入第 D 天时第 D-1 天已完整结束（含它自己的夜与投票），
   * 而第 D-1 天的纪要要到第 D+1 天才被需要（L2 实录覆盖"昨天+今天"）——有一整天余量。
   * 于是"反思"从"新一天首个决策的阻塞项"变成"夜里后台跑的一次低优先级调用"。
   */
  scheduleReflection(day) {
    const g = this.game;
    if (!g || g.finished || day < 1) return null;
    if (this.digests.has(day)) return null;
    if (this._reflecting.has(day)) return this._reflecting.get(day);
    const p = this._reflectDay(day)
      .then((text) => {
        if (text) this.digests.set(day, text);
        this._pruneDigests();
        this._reflecting.delete(day);
        return text;
      })
      .catch(() => { this._reflecting.delete(day); return this.digests.get(day); });
    this._reflecting.set(day, p);
    return p;
  }

  /**
   * 补齐"确实会进入上下文"的旧日纪要（窗口 = 最近 digestKeep 天中、昨天之前的部分）。
   * 边界批处理已经把绝大多数日子的纪要提前生成好了，这里通常一次 LLM 都不发。
   */
  async ensureDigests() {
    const today = this.game.day || 0;
    const keep = this.digestKeep;
    const oldest = Math.max(1, today - 1 - keep); // 只有这个窗口内的纪要会进上下文
    for (let d = oldest; d <= today - 2; d++) {
      if (this.digests.has(d)) continue;
      if (this._reflecting.has(d)) { await this._reflecting.get(d); continue; }
      const p = this.scheduleReflection(d);
      if (p) await p; // 极端情况（断点恢复/边界任务被饿死）才走同步兜底，保证记忆不缺
    }
  }

  /** 纪要总数封顶：超出的最旧纪要丢弃（硬事实仍在局面快照的时间线里，不是信息丢失） */
  _pruneDigests() {
    const keys = [...this.digests.keys()].sort((a, b) => a - b);
    while (keys.length > this.digestKeep) this.digests.delete(keys.shift());
  }

  /**
   * 单日反思（可合并连续低信息日）。三道节流：
   *  1. 节流：该日可见事件少于 digestMinEvents → 用确定性事实骨架，不发 LLM 调用
   *  2. 合并：连续低信息日并入下一个"有信息的日子"，只出一条纪要
   *  3. 上限：见 _pruneDigests
   */
  async _reflectDay(day) {
    const g = this.game;
    const ledger = ctx.aggregate(g, this.player);
    const evsOf = (d) => (ledger.byDay.get(d) || []).filter((e) => !DIGEST_SKIP_TYPES.has(e.type));
    if (evsOf(day).length < this.digestMinEvents) {
      this._lightDays.push(day);
      this.logger.debug('ai', `${this.player.seat}号 第${day}天信息量不足（${evsOf(day).length}<${this.digestMinEvents}），用事实骨架代替，省一次 LLM 调用`);
      return ctx.skeletonDigest(g, ledger, day);
    }
    // 与之前连续的低信息日合并成一条
    const days = [...this._lightDays.filter((d) => d >= 1 && d < day), day];
    this._lightDays = this._lightDays.filter((d) => d >= day);
    for (const d of days) if (d !== day) this.digests.delete(d); // 合并后的纪要取代各低信息日的独立纪要
    try {
      const eventsText = days
        .map((d) => evsOf(d).map((e) => (days.length > 1 ? `◆ 第${d}天：` : '') + renderEvent(g, e)).filter(Boolean).join('\n'))
        .filter(Boolean).join('\n') || '（这些天没有你可见的事件）';
      const promptText = reflectionInstruction(g, this.player, day, eventsText, days);
      // 反思在后台跑（日切边界入队，完成时刻取决于调度），g.seq 是流动的 → 不能用它做 key。
      // 用 (gameId, day, 'reflect', seat) 即可唯一确定"某局某人某天的纪要"。
      const rkey = journal.keyOf({ gameId: g.id, day, phase: 'reflect', seq: 0, seat: this.player.seat, task: 'reflect' });
      const rph = journal.sha1(promptText);
      let content;
      const rhit = this._jread(rkey, rph);
      if (rhit) {
        content = (rhit.payload && rhit.payload.content) || '';
      } else {
        const out = await llm.chatCompletion(this.llmCfg,
          [{ role: 'user', content: promptText }],
          {
            logger: this.logger,
            effort: this.llmCfg.fastEffort || 'low', // 反思是账本维护，轻度即可；high 曾出现 7 分钟思考失控
            maxTokens: 2000,
            signal: g.abortSignal, // 终止对局时立即中断
            priority: PRIORITY.reflection, // 单并发通道内让位于玩家可见决策，但不许被无限饿死（调度器带老化）
            meta: { label: `${this.player.seat}号`, task: `第${day}天反思`, seat: this.player.seat },
          });
        content = out.content;
        this._jwrite(rkey, { content }, out.usage, rph, { task: `第${day}天反思`, seat: this.player.seat });
      }
      let text = (content || '').trim();
      // 反思现在输出 JSON {summary, suspicion}：纪要进 L1，怀疑度进 agent 状态（解析失败降级为纯文本纪要）
      try {
        const parsed = extractJson(text);
        if (parsed && typeof parsed.summary === 'string' && parsed.summary.trim()) {
          text = parsed.summary.trim();
          if (parsed.suspicion && typeof parsed.suspicion === 'object') {
            for (const [k, v] of Object.entries(parsed.suspicion)) {
              const s = parseInt(k, 10);
              const n = Number(v);
              if (Number.isInteger(s) && g.player(s) && s !== this.player.seat && Number.isFinite(n)) {
                this.suspicion[s] = Math.max(-100, Math.min(100, Math.round(n)));
              }
            }
          }
        }
      } catch (_) { /* 非 JSON 输出：按纯文本纪要处理 */ }
      if (text.length > DIGEST_MAX_CHARS) text = text.slice(0, DIGEST_MAX_CHARS) + '…';
      if (!text) throw new Error('empty digest');
      if (!rhit) { // journal 命中时并没有真的花一次调用，统计口径要跟着走
        this.compressions++;
        if (g.llmStats) g.llmStats.compressions = (g.llmStats.compressions || 0) + 1;
      }
      this.logger.info('ai', `${this.player.seat}号 第${days.join('~')}天纪要生成完成（${text.length}字，怀疑度 ${Object.keys(this.suspicion).length} 人）`);
      return text;
    } catch (err) {
      this.logger.warn('ai', `${this.player.seat}号 第${day}天反思失败，降级为事实骨架：${err.message}`);
      return ctx.skeletonDigest(g, ledger, day);
    }
  }

  /** journal 读：命中即计入"省下多少"（不计入实际消耗，保证恢复后 token 增量为 0） */
  _jread(key, promptHash) {
    if (!this.journal) return null;
    const e = this.journal.lookup(this.game.id, key, promptHash);
    if (!e) return null;
    const g = this.game;
    g.llmStats.journalHits = (g.llmStats.journalHits || 0) + 1;
    const u = e.usage || {};
    g.llmStats.journalSavedTokens = (g.llmStats.journalSavedTokens || 0) + (u.promptTokens || 0) + (u.completionTokens || 0);
    return e;
  }

  _jwrite(key, payload, usage, promptHash, meta) {
    if (!this.journal) return;
    this.journal.record(this.game.id, key, { payload, usage, promptHash, meta });
  }

  /** 局终复盘：对照自己的反思纪要与终局真相提炼跨局经验（供经验池入库；mock 智能体无此能力） */
  async generateLessons() {
    const g = this.game;
    const digestLines = [...this.digests.entries()].sort((a, b) => a[0] - b[0])
      .map(([d, t]) => `◆ 第${d}天：${t}`).join('\n');
    const promptText = lessonInstruction(g, this.player, digestLines);
    // 局终复盘也要进 journal：否则恢复重跑终局会重复提炼、重复入库，还多花一次调用
    const key = journal.keyOf({ gameId: g.id, day: g.day, phase: 'lessons', seq: 0, seat: this.player.seat, task: 'lessons' });
    const ph = journal.sha1(promptText);
    let content;
    const hit = this._jread(key, ph);
    if (hit) {
      content = (hit.payload && hit.payload.content) || '';
    } else {
      const out = await llm.chatCompletion(this.llmCfg,
        [{ role: 'user', content: promptText }],
        {
          logger: this.logger,
          effort: this.llmCfg.fastEffort || 'low',
          maxTokens: 2000,
          priority: PRIORITY.lesson, // 局终复盘：最低优先级，绝不与下一局的开局决策抢通道
          meta: { label: `${this.player.seat}号`, task: '局终复盘', seat: this.player.seat },
        });
      content = out.content;
      this._jwrite(key, { content }, out.usage, ph, { task: '局终复盘', seat: this.player.seat });
    }
    const parsed = extractJson(content || '');
    if (!parsed || !Array.isArray(parsed.lessons)) return [];
    const role = this.player.role;
    return parsed.lessons
      .filter((t) => typeof t === 'string' && t.trim())
      .slice(0, 3)
      .map((text) => ({ role, text: text.trim(), boardSize: g.players.length }));
  }

  async decide(request) {
    const g = this.game;
    const seat = this.player.seat;
    // 0. 跨天反思（新的一天的首次决策时最多补齐到昨天为止的纪要）
    await this.ensureDigests();
    // 1. 组装上下文（L1 + L2 + 快照 + 任务，带预算裁剪）
    const state = {
      digests: new Map(this.digests),
      lastSeq: this.lastSeq,
      transcriptDays: [g.day - 1, g.day].filter((d) => d >= 1),
      suspicion: this.suspicion,
    };
    const budget = Number(this.llmCfg.contextBudget) > 0 ? Number(this.llmCfg.contextBudget) : 12000;
    const built = ctx.trimToBudget(g, this.player, request, state, budget);
    this.contextTokens = built.tokens;
    this.lastMemory = built.memory;         // 本轮记忆检索结果（上帝面板可见：保留/省略了几条）
    this.lastSectionTokens = built.sectionTokens; // 分区体积（应用自报，避免"预算是 900 为什么用了 3000"靠猜）
    this.lastContextText = built.text;      // 上帝面板查看
    this.lastRequestTask = request.task;
    // 1.5 决策 journal：恢复重放时同一个决策点直接命中磁盘答案 → 零 LLM 调用、逐字一致
    const jkey = journal.keyOf({
      gameId: g.id, day: g.day, phase: g.phase, seq: g.seq, seat,
      task: request.task,
      // 校验失败后的带提示重问必须换 key，否则会把"上一次那份非法输出"原样还回去 → 无限重复同一次失败
      variant: String(request._retryNote || ''),
    });
    const promptHash = journal.sha1(built.text + '\u0000' + JSON.stringify(this.messages[0].content));
    if (this.journal) {
      const hitEntry = this._jread(jkey, promptHash);
      if (hitEntry) {
        this.lastSeq = g.visibleEvents(seat, 0).reduce((m, e) => Math.max(m, e.seq), 0);
        this.turns++;
        if (this.logger) this.logger.info('ai', `${seat}号 ${request.task} 命中决策 journal（省一次调用）`, { task: request.task, seat, day: g.day, phase: g.phase });
        return hitEntry.payload;
      }
    }
    // 2. 单发调用（思考预算按"信息含量"调度：常规决策降档、关键节点加档）
    const messages = [this.messages[0], { role: 'user', content: built.text }];
    const plan = effort.planEffort(g, this.player, request, { cfg: this.llmCfg, lastSeq: this.lastSeq });
    // E1 轻量补救（配合 flow.js 的校验层重试）：决策时间预算已经花光时的重试必须**又便宜又有上限**，
    // 否则等于再赌一次长思考（实测最坏 362s）——那正是 180s 总闸门当初要避免的事。
    // 几分钟的等待换来的通常只是一句合法发言，几秒钟的降档重试是明显更好的交易。
    if (request._cheapRetry) {
      plan.effort = this.llmCfg.fastEffort || 'low';
      plan.maxTokens = Math.min(plan.maxTokens, CHEAP_RETRY_MAX_TOKENS);
      plan.hardCap = Math.min(plan.hardCap, CHEAP_RETRY_HARD_CAP);
      plan.reasons = ['轻量补救重试：决策时间预算已用尽 → 最低思考 + 极小预算'];
      plan.cheap = true;
    }
    this.lastPlan = plan; // 上帝面板可见：这次为什么给了这个档位
    // 单局调用次数硬上限（P1 真实对局测试发现的护栏）。
    // 为什么必须有：既有的预算保护是**按时间**算的（decisionTotalMs 180s），而成本是**按次数**算的。
    // 实测（假 LLM 注入"狼队永远凑不出多数"这种僵持）时，秒回的模型在 25 秒内把单局调用刷到近 6000 次
    // —— 时间预算完全拦不住，真金白银的额度却按次烧掉了。这里放一道**次数**护栏：
    // 超限即按"致命"抛出，走既有的暂停路径（不判负、可恢复、留有排查现场），而不是让对局继续空转。
    const callLimit = Number(this.llmCfg && this.llmCfg.maxCallsPerGame) || 0;
    if (callLimit > 0 && g.llmStats.calls >= callLimit) {
      const msg = `本局 AI 调用次数已达上限（${callLimit} 次）——疑似僵持或模型异常，已中止本局以免继续消耗额度`;
      if (g.logger) g.logger.error('ai', msg);
      // 为什么是"中止"而不是"暂停"：暂停依赖断点锚点才能恢复，而锚点只在白天/夜晚**边界**拍摄；
      // 实测僵持发生在夜间投刀环节（没有锚点），此时暂停 = 谁也恢复不了的死局。
      // 这里走既有的 terminate → forceEnded → runGame 优雅结算（不判负、亮牌、写明原因），
      // 玩家看到的是"本局因调用异常结束"，可以直接开下一局，而不是一个永远转圈的对局。
      try { g.terminate(msg); } catch (_) { /* terminate 会抛出以解栈，交给上层结算 */ }
      throw new Error(msg);
    }
    // 直播缓冲在**请求真的开始跑**时才建（onStart）：扇出提交时不会出现"还没轮到就已经在打字"，
    // 也不会几路增量混进同一个缓冲（多 Key 下确实会同时有好几路）。
    let liveEntry = null;
    let out;
    try {
      out = await llm.chatCompletion(this.llmCfg, messages, {
        logger: this.logger,
        effort: plan.effort,
        maxTokens: plan.maxTokens,
        hardCap: plan.hardCap, // 没有它，截断后的预算翻倍会让 maxTokens 形同虚设
        // 分层模型（A2）：快速任务可换更小的模型；未配置 modelFast 时与主模型一致
        model: ctx.taskModel(request.task, this.llmCfg),
        // 分任务软超时（A3）：发言 90s / 微决策 30s，超时会在 llm 内部先降档重试一次。
        // 轻量补救则连超时也压到快速任务的档位：它本来就是"几秒钟要一份合法 JSON"。
        timeoutMs: request._cheapRetry
          ? Math.min(ctx.taskTimeoutMs(request.task, this.llmCfg), this.llmCfg.fastTimeoutMs || 30000)
          : ctx.taskTimeoutMs(request.task, this.llmCfg),
        signal: g.abortSignal, // 终止对局时立即中断在途调用
        priority: PRIORITY.decision, // 玩家可见决策：最高优先级
        meta: { label: `${seat}号`, task: request.task, seat },
        onStart: () => { liveEntry = g.beginLive({ seat, task: request.task, public: PUBLIC_LIVE_TASKS.has(request.task) }); },
        onDelta: (d) => g.updateLive(liveEntry, d),
        // 结构化输出：target 用候选座位枚举约束，模型在结构上无法吐出非法座位
        responseFormat: schemas.schemaFor(request.task, request, { aliveSeats: g.aliveSeats(), seat }),
      });
    } finally {
      g.endLive(liveEntry); // 成功/失败/暂停都必须清掉缓冲，避免残留半成品被反复下发
    }
    // 3. 更新"新事件"游标（本次调用时点之前的都算已读）
    this.lastSeq = g.visibleEvents(seat, 0).reduce((m, e) => Math.max(m, e.seq), 0);
    this.turns++;
    // 3.5 内心独白：思考模型的 reasoning 轨迹，仅上帝可见（绝不进任何 AI 上下文——NOISE_TYPES 已过滤）
    if (out.reasoning) {
      this.lastReasoning = out.reasoning;
      g.emit('ai_reasoning', { actor: seat, visibleTo: 'god', data: { task: request.task, text: out.reasoning.slice(0, 1500) } });
    }
    // 4. 遥测
    this.lastPromptTokens = out.usage.promptTokens;
    g.llmStats.calls++;
    g.llmStats.promptTokens += out.usage.promptTokens;
    g.llmStats.cachedTokens += out.usage.cachedTokens;
    g.llmStats.completionTokens += out.usage.completionTokens;
    if (out.streamed) g.llmStats.streamedCalls = (g.llmStats.streamedCalls || 0) + 1;
    // 延迟明细：上帝面板与评测 harness 都要用它算 p90（只留最近 300 次，避免存档无限膨胀）
    if (out.latencyMs != null) {
      g.llmStats.latencyMsTotal = (g.llmStats.latencyMsTotal || 0) + out.latencyMs;
      g.llmStats.latencyMsMax = Math.max(g.llmStats.latencyMsMax || 0, out.latencyMs);
      if (!g.llmStats.latencies) g.llmStats.latencies = [];
      g.llmStats.latencies.push(out.latencyMs);
      if (g.llmStats.latencies.length > 300) g.llmStats.latencies.shift();
    }
    // 档位分布：上帝面板用它回答"这局的思考预算花在哪了"
    if (plan && plan.tier) {
      if (!g.llmStats.byTier) g.llmStats.byTier = {};
      g.llmStats.byTier[plan.tier] = (g.llmStats.byTier[plan.tier] || 0) + 1;
    }
    // 结构化输出的实际生效级别（首次调用后固定，供上帝面板与日志诊断）
    if (!g.llmStats.structuredLevel) g.llmStats.structuredLevel = llm.currentStructuredMode();
    // 首字延迟（TTFT）：流式真正的体验指标——玩家多久能看到"开始打字"
    if (out.ttftMs != null) {
      g.llmStats.ttftMsTotal = (g.llmStats.ttftMsTotal || 0) + out.ttftMs;
      g.llmStats.ttftCount = (g.llmStats.ttftCount || 0) + 1;
      if (out.ttftMs > (g.llmStats.ttftMsMax || 0)) g.llmStats.ttftMsMax = out.ttftMs;
    }
    const hit = out.usage.promptTokens ? out.usage.cachedTokens / out.usage.promptTokens : 1;
    if (!this._cacheWarned && g.llmStats.calls > 4 && out.usage.promptTokens > 4000 && hit < 0.25) {
      this._cacheWarned = true;
      // 措辞依据（2026-09 实测，同一段提示词连发三次）：冷启动 0 命中 → 立刻重发 93% 命中 →
      // 60 秒后仍命中。所以 0% 一般是"前缀变了的那一次"（换天 / 换了角色的私有段 / 长时间空闲），
      // 不是缓存机制坏了。这里如实说明，避免把它读成系统性缺陷（用户实测报告里正是这么理解的）。
      this.logger.warn('ai', `${seat}号 本次未命中前缀缓存（${Math.round(hit * 100)}%，${out.usage.cachedTokens}/${out.usage.promptTokens} tokens）——常见于换天后/该角色首次调用/长时间空闲后的第一次，属正常冷启动；本局不再重复提醒`, { task: request.task, seat });
    }
    if (this.logger) {
      this.logger.debug('ai', `${seat}号 ${request.task} 模型回复：${(out.content || '').slice(0, 200)}`, {
        seat, task: request.task, contextTokens: built.tokens, trimmed: !!built.trimmed,
        promptTokens: out.usage.promptTokens, cachedTokens: out.usage.cachedTokens,
      });
    }
    // 5. 解析（失败返回 null → flow 校验失败 → 带提示重试 → 多次失败降级）
    const payload = extractJson(out.content);
    if (payload == null && this.logger) {
      this.logger.warn('ai', `${seat}号 ${request.task} 无法从回复中解析 JSON：${(out.content || '').slice(0, 200)}`);
    }
    // 5.5 落 journal：服务崩溃/配额暂停后从这里恢复，重放不会重复花钱
    this._jwrite(jkey, payload, out.usage, promptHash, { task: request.task, seat, day: g.day, phase: g.phase, tier: plan && plan.tier });
    return payload;
  }
}

/** 供 server 使用的工厂（experienceStore：跨局经验池；journal：决策 journal，均可为 null） */
function makeAgentFactory(llmCfg, logger, experienceStore = null, journalStore = null) {
  return (player, game) => new Agent(player, game, llmCfg, logger, experienceStore, journalStore);
}

module.exports = { Agent, makeAgentFactory, extractJson };
