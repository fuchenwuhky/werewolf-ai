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
const { buildSystemPrompt, reflectionInstruction } = require('./prompts');
const ctx = require('./context');
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

class Agent {
  constructor(player, game, llmCfg, logger) {
    this.player = player;
    this.game = game;
    this.llmCfg = llmCfg;
    this.logger = logger || game.logger;
    this.lastSeq = 0;            // 仅用于标记"自上次决策以来的新事件"（◆）
    this.turns = 0;
    this.lastPromptTokens = 0;
    this.contextTokens = 0;      // 本次决策上下文估算（上帝面板可见）
    this.compressions = 0;       // 兼容旧统计字段名：实际为"纪要生成次数"
    this.digests = new Map();    // day -> 纪要文本（L1）
    this._reflecting = new Map(); // day -> Promise（防并发重复反思）
    this._cacheWarned = false;   // 缓存告警每座每局只报一次（服务商缓存 TTL 过期属预期，不必刷屏）
    const sys = { role: 'system', content: buildSystemPrompt(game, player) };
    if (llmCfg.cacheControl) {
      sys.content = [{ type: 'text', text: sys.content, cache_control: { type: 'ephemeral' } }];
    }
    this.messages = [sys]; // 只保留 system；决策消息单次组装
  }

  /** 跨天惰性反思：为"前天及更早"且没有纪要的天生成 L1（昨天留给 L2 逐字实录，不重复） */
  async ensureDigests() {
    const today = this.game.day || 0;
    for (let d = 1; d < today - 1; d++) {
      if (this.digests.has(d)) continue;
      if (this._reflecting.has(d)) { await this._reflecting.get(d); continue; }
      const p = this._reflect(d).then((text) => {
        this.digests.set(d, text);
        this._reflecting.delete(d);
        return text;
      }).catch(() => {
        this._reflecting.delete(d);
        return this.digests.get(d);
      });
      this._reflecting.set(d, p);
      await p;
    }
  }

  /** 单日反思：LLM 生成纪要；任何失败 → 确定性事实骨架 */
  async _reflect(day) {
    const g = this.game;
    try {
      const ledger = ctx.aggregate(g, this.player);
      const evs = (ledger.byDay.get(day) || []).filter((e) => !['await_input', 'ai_thinking', 'llm_error'].includes(e.type));
      const eventsText = evs.map((e) => renderEvent(g, e)).filter(Boolean).join('\n') || '（这一天没有你可见的事件）';
      const out = await llm.chatCompletion(this.llmCfg,
        [{ role: 'user', content: reflectionInstruction(g, this.player, day, eventsText) }],
        {
          logger: this.logger,
          effort: this.llmCfg.fastEffort || 'low', // 反思是账本维护，轻度即可；high 曾出现 7 分钟思考失控
          maxTokens: 2000,
          meta: { label: `${this.player.seat}号`, task: `第${day}天反思`, seat: this.player.seat },
        });
      let text = (out.content || '').trim();
      if (text.length > DIGEST_MAX_CHARS) text = text.slice(0, DIGEST_MAX_CHARS) + '…';
      if (!text) throw new Error('empty digest');
      this.compressions++;
      if (g.llmStats) g.llmStats.compressions = (g.llmStats.compressions || 0) + 1;
      this.logger.info('ai', `${this.player.seat}号 第${day}天纪要生成完成（${text.length}字）`);
      return text;
    } catch (err) {
      this.logger.warn('ai', `${this.player.seat}号 第${day}天反思失败，降级为事实骨架：${err.message}`);
      const ledger = ctx.aggregate(g, this.player);
      return ctx.skeletonDigest(g, ledger, day);
    }
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
    };
    const budget = Number(this.llmCfg.contextBudget) > 0 ? Number(this.llmCfg.contextBudget) : 12000;
    const built = ctx.trimToBudget(g, this.player, request, state, budget);
    this.contextTokens = built.tokens;
    this.lastContextText = built.text;      // 上帝面板查看
    this.lastRequestTask = request.task;
    // 2. 单发调用（任务分层思考强度与输出上限）
    const messages = [this.messages[0], { role: 'user', content: built.text }];
    const out = await llm.chatCompletion(this.llmCfg, messages, {
      logger: this.logger,
      effort: ctx.taskEffort(request.task, this.llmCfg),
      maxTokens: ctx.taskMaxTokens(request.task, this.llmCfg),
      meta: { label: `${seat}号`, task: request.task, seat },
    });
    // 3. 更新"新事件"游标（本次调用时点之前的都算已读）
    this.lastSeq = g.visibleEvents(seat, 0).reduce((m, e) => Math.max(m, e.seq), 0);
    this.turns++;
    // 4. 遥测
    this.lastPromptTokens = out.usage.promptTokens;
    g.llmStats.calls++;
    g.llmStats.promptTokens += out.usage.promptTokens;
    g.llmStats.cachedTokens += out.usage.cachedTokens;
    g.llmStats.completionTokens += out.usage.completionTokens;
    const hit = out.usage.promptTokens ? out.usage.cachedTokens / out.usage.promptTokens : 1;
    if (!this._cacheWarned && g.llmStats.calls > 4 && out.usage.promptTokens > 4000 && hit < 0.25) {
      this._cacheWarned = true;
      this.logger.warn('ai', `${seat}号 缓存命中率低（${Math.round(hit * 100)}%，${out.usage.cachedTokens}/${out.usage.promptTokens} tokens）——多为服务商缓存 TTL 过期，本局不再重复提醒`, { task: request.task, seat });
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
    return payload;
  }
}

/** 供 server 使用的工厂 */
function makeAgentFactory(llmCfg, logger) {
  return (player, game) => new Agent(player, game, llmCfg, logger);
}

module.exports = { Agent, makeAgentFactory, extractJson };
