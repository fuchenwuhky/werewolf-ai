/**
 * effort.js — 按"信息含量"调度思考预算（替换按任务名一刀切的 FAST_TASKS）
 *
 * 为什么这样做（实测依据，1213 次真实 GLM-5.3-Flash 调用）：
 *   low 档（fastEffort）  n=958  p50 3.6s  p90 19.1s  avg  9.1s
 *   high 档（发言类）     n=255  p50 31.1s p90 134.8s avg 54.2s   → 平均慢 5.9×，p90 慢 7.0×
 *   输出 token（含思考）：low p50=75 / p90=709；high p50=1270 / p90=5123 / max=13318
 *
 * 结论：延迟不是"发言"这个动作造成的，而是"思考预算被平均撒在每一次行动上"造成的。
 * 思考预算应该花在**信息多、后果重**的决策上。因此这里用确定性、零成本的特征打分：
 *   1. 决定性事件 decisive：距我上次决策新增的"决定性事件"数（死亡/投票/翻牌/警徽…）
 *      —— 刻意不数发言：12 个人各说一句不等于 6 倍的信息量
 *   2. 存活人数 alive：终局每一次决策的后果都被放大
 *   3. 天数 day：后期信息链更长
 *   4. 关键节点 pivotal：警长竞选 / PK / 开枪 / 移交警徽
 * 全部特征来自局面快照与事件游标，可回放、可测试，不含任何随机性。
 *
 * 发言类需要**两个独立信号**才升到 high：否则"一晚的死亡+投票+翻牌"就能把
 * 每一句白天发言都推到 high，等于没做调度（实测 1213 次调用回放中确认过这一点）。
 *
 * 兼容：cfg.effortPolicy === 'flat' 时退回旧的按任务名分层（便于 A/B 与回滚）。
 */
'use strict';
const { FAST_TASKS } = require('./context');

/** 发言类任务：需要组织语言并权衡他人发言 */
const SPEECH_TASKS = new Set(['speech', 'sheriff_speech', 'pk_speech', 'lastwords']);
/** 结构化决策：答案基本由规则 + 局面快照决定，思考收益低 */
const STRUCTURED_TASKS = new Set([...FAST_TASKS].filter((t) => !SPEECH_TASKS.has(t)));
/** 关键节点：一次决策直接改变胜负手 */
const PIVOTAL_TASKS = new Set(['sheriff_run', 'sheriff_vote', 'pk_speech', 'pk_vote', 'shoot', 'badge_pass']);

/**
 * 档位表。effort 是"档位语义"，最终取值仍尊重用户在设置页配的 fastEffort/reasoningEffort；
 * hardCap 是"思考耗尽时预算翻倍的上限"——没有它的话 maxTokens 形同虚设（会一路翻到 32768）。
 */
const TIERS = {
  minimal: { effort: 'low', maxTokens: 2000, hardCap: 8000 },
  low: { effort: 'low', maxTokens: 4000, hardCap: 10000 },
  normal: { effort: 'low', maxTokens: 6000, hardCap: 14000 },
  high: { effort: 'high', maxTokens: 12000, hardCap: 24000 },
  critical: { effort: 'high', maxTokens: 16000, hardCap: 32768 },
};

/** 分数 → 档位（按任务族分别映射，读起来就是策略本身） */
const STRUCTURED_TIER = ['minimal', 'low', 'low', 'normal', 'high'];
// 发言类：基础分 2 = 常规（low）。必须"两个独立信号"才升到 high，
// 否则"一晚的死亡+投票+翻牌"就能把每一句白天发言都推到 high，等于没做调度。
const SPEECH_TIER = ['normal', 'normal', 'normal', 'normal', 'high', 'critical'];

/**
 * 个别任务的档位上限：遗言是一次性短内容。
 * 实测：遗言在 low 档 p50 22.1s / p90 95.8s / max 285.9s 已是尾部最差的一类；
 * 历史数据显示升到 high 档曾出现 7k tokens / 286s 的极差体验 → 封顶在 normal。
 */
const TIER_CEILING = { lastwords: 'normal' };

const TIER_ORDER = ['minimal', 'low', 'normal', 'high', 'critical'];

/**
 * 噪音事件：只增篇幅、不增信息。
 * 信息量按"决定性事件"计（互补集），因此新增事件类型默认算决定性——
 * 保守方向是"多给思考"，不会因为漏配而悄悄削弱 AI。
 */
const CHATTER_TYPES = new Set([
  'speech', 'wolf_propose', 'ai_thinking', 'ai_reasoning', 'phase', 'night_step',
  'system', 'direction', 'deal', 'teammates', 'llm_error', 'await_input', 'game_paused',
  'vote_progress', // 纯 UI 进度反馈，不是信息：不参与"信息量→思考预算"的打分
]);

/** 采集决策特征（全部确定性，零 LLM 成本） */
function collectFeatures(game, player, request, lastSeq) {
  const seat = player.seat;
  const day = game.day || 0;
  let decisive = 0;
  let speechIndex = 0;
  for (const e of game.visibleEvents(seat, 0)) {
    if (e.seq > lastSeq && !CHATTER_TYPES.has(e.type)) decisive++;
    if (e.type === 'speech' && e.day === day && e.actor !== seat) speechIndex++;
  }
  return {
    task: request.task,
    decisive, // 距我上次决策新增的"决定性事件"数（死亡/投票/翻牌/警徽…）
    day,
    alive: game.players.filter((p) => p.alive).length,
    speechIndex,
  };
}

/**
 * 打分：分数越高 = 这次决策要权衡的信息越多 / 后果越重。
 * 注意用"决定性事件"而不是全部事件计数：12 个人各说一句话不该等于 6 倍的信息量。
 * @returns {{tier:string, score:number, reasons:string[]}}
 */
function planTier(task, f = {}) {
  const structured = STRUCTURED_TASKS.has(task);
  const speech = SPEECH_TASKS.has(task);
  if (!structured && !speech) {
    // 未知任务（含跨天反思等）保守取高：宁可多花思考，也不要因为不认识而削弱
    return { tier: 'high', score: 3, reasons: ['未知任务→保守取高'] };
  }
  const decisive = f.decisive | 0;
  const alive = f.alive | 0;
  const day = f.day | 0;
  const reasons = [];
  let score = structured ? 0 : 2; // 发言类基础分：组织语言本身需要一定预算

  if (structured) {
    if (decisive >= 4) { score += 1; reasons.push(`新增 ${decisive} 条决定性事件`); }
    if (PIVOTAL_TASKS.has(task)) { score += 1; reasons.push('关键裁决'); }
    if (alive > 0 && alive <= 5) { score += 1; reasons.push(`终局仅剩 ${alive} 人`); }
  } else {
    if (decisive >= 12) { score += 2; reasons.push(`新增 ${decisive} 条决定性事件（局势剧变）`); }
    else if (decisive >= 5) { score += 1; reasons.push(`新增 ${decisive} 条决定性事件`); }
    if (alive > 0 && alive <= 6) { score += 2; reasons.push(`终局仅剩 ${alive} 人（每句话都定胜负）`); }
    if (day >= 5) { score += 1; reasons.push(`第 ${day} 天（后期信息链长）`); }
    if (PIVOTAL_TASKS.has(task)) { score += 2; reasons.push('关键节点'); }
  }

  const table = structured ? STRUCTURED_TIER : SPEECH_TIER;
  let tier = table[Math.max(0, Math.min(table.length - 1, score))];
  const ceil = TIER_CEILING[task];
  if (ceil && TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(ceil)) {
    tier = ceil;
    reasons.push(`任务档位封顶于 ${ceil}`);
  }
  if (!reasons.length) reasons.push('常规决策（无新增决定性事件/非关键节点）');
  return { tier, score, reasons };
}

/** 档位 → 实际调用参数（仍尊重用户配置的 effort 与 token 上限） */
function resolveBudget(tier, cfg = {}) {
  const t = TIERS[tier] || TIERS.normal;
  const hardMax = Number(cfg.maxTokens) > 0 ? Number(cfg.maxTokens) : 16000;
  const fastMax = Number(cfg.fastMaxTokens) > 0 ? Number(cfg.fastMaxTokens) : 8000;
  const cap = t.effort === 'low' ? Math.min(hardMax, fastMax) : hardMax;
  return {
    effort: t.effort === 'high' ? (cfg.reasoningEffort || 'high') : (cfg.fastEffort || 'low'),
    maxTokens: Math.min(t.maxTokens, cap),
    hardCap: Math.min(t.hardCap, hardMax),
  };
}

/** 旧的按任务名分层（effortPolicy='flat'）：保持与历史行为完全一致 */
function flatBudget(task, cfg = {}) {
  return {
    effort: FAST_TASKS.has(task) ? (cfg.fastEffort || 'low') : (cfg.reasoningEffort || 'high'),
    maxTokens: FAST_TASKS.has(task) ? (cfg.fastMaxTokens || 8000) : Math.min(cfg.maxTokens || 16000, 12000),
    hardCap: 32768,
  };
}

/**
 * 对外入口：给出本次决策的思考强度与输出预算。
 * @param {Game} game
 * @param {Player} player
 * @param {{task:string}} request
 * @param {{cfg:object, lastSeq:number}} info
 * @returns {{tier, effort, maxTokens, hardCap, score, reasons, features, policy}}
 */
function planEffort(game, player, request, info = {}) {
  const cfg = info.cfg || {};
  if (cfg.effortPolicy === 'flat') {
    const b = flatBudget(request.task, cfg);
    return { tier: 'flat', ...b, score: 0, reasons: ['effortPolicy=flat（按任务名分层）'], features: null, policy: 'flat' };
  }
  const features = collectFeatures(game, player, request, info.lastSeq || 0);
  const { tier, score, reasons } = planTier(request.task, features);
  return { tier, ...resolveBudget(tier, cfg), score, reasons, features, policy: 'info' };
}

module.exports = {
  planEffort, planTier, collectFeatures, resolveBudget, flatBudget,
  STRUCTURED_TASKS, SPEECH_TASKS, PIVOTAL_TASKS, TIERS, TIER_ORDER, TIER_CEILING, CHATTER_TYPES,
};
