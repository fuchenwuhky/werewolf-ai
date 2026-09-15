/**
 * memory.js — L1 长期记忆流与检索（P2-5）
 *
 * 重构前：跨天记忆（每天一段"纪要"）是**按天全量拼接**的，超预算就"丢最旧的"。
 * 两个具体问题：
 *   ① 一条"第 1 天 3 号跳预言家"可能比"第 5 天 9 号打了个哈欠"重要得多，但先被丢掉的是前者；
 *   ② 一天的纪要是一整块，无法只保留其中有用的那一句。
 *
 * 现在把纪要拆成**原子条目**，每条规定性地打两个分：
 *   · recency（新近度）：按天数指数衰减——今天的事天然更该记得；
 *   · importance（重要性）：按关键词计价——死亡、跳身份、查验、被投、狼队刀口、与我有关……
 *   · relevance（相关度）：与"此刻要做的决定"的重合度——正在盘谁的票，就该想起关于谁的记忆。
 * 三者线性加权排序（Generative Agents memory stream 的简化版，去掉其 LLM 打分以省调用）。
 *
 * 三条硬约束（都很容易被后续改动破坏，故写在这里）：
 *   1. **确定性**：打分只用 (text, day, query)，不碰 Date.now / Math.random / 对象遍历顺序。
 *      决策 journal 靠 promptHash 命中重放，上下文只要不可复现，"省调用"就会变成"两次答案不一样"。
 *   2. **装得下就不检索**：总 token 未超预算时，条目**原样按天拼接**（与重构前逐字一致），
 *      绝不因为"检索"而在短局里少给上下文。全量拼接只在长局里才会超预算。
 *   3. **不静默丢内容**：一旦发生取舍，就把"保留 N / 共 M 条"写进上下文，
 *      让 AI（和看上帝面板的人）知道记忆被裁剪过，而不是以为那就是全部。
 */
'use strict';
const { estimateTokens } = require('./tokens');

/** 重要性关键词表：命中即加分（确定性，无 LLM）。权重是"这条信息对判断局势值多少"。 */
const IMPORTANCE_HINTS = [
  { re: /(出局|死亡|被刀|倒牌|死了|阵亡)/, w: 3.0, why: '死亡事实' },
  { re: /(放逐|投票|票型|投给|归票|警徽流|警徽)/, w: 2.4, why: '票型与警徽' },
  { re: /(预言家|查验|金水|查杀|悍跳|对跳|跳)/, w: 2.4, why: '身份声明' },
  { re: /(女巫|解药|毒药|守卫|守|摄梦|狼美人|魅惑|猎人|开枪|白狼王|自爆|骑士|决斗)/, w: 1.8, why: '技能信息' },
  { re: /(我是|我自己|我的|对我|相信我|怀疑我|投我|刀我|查我)/, w: 2.0, why: '与我直接相关' },
  { re: /(狼|好人|队友|同伙|阵营)/, w: 1.2, why: '阵营判断' },
  { re: /(矛盾|破绽|可疑|不对劲|逻辑)/, w: 1.4, why: '推理结论' },
];

/** 一日纪要里以这些符号开头的行视为独立条目 */
const BULLET = /^\s*(?:[-•·*◆◇]|\d+[.、)])\s*/;
/** 超长条目的切分阈值（字符）：模型不按项目符号输出时，一整段可能几百 token，
 *  那样"检索"会退化成"全有或全无"——单条就超过预算，只能整条塞进去或整条丢掉。 */
const LONG_ENTRY_CHARS = 120;
/** 句子边界（中文标点后切）：只在超长条目上使用，正常条目不动 */
const SENTENCE = /(?<=[。！？；])/;

/** 把一段长文本按句子聚合成若干 ≤ LONG_ENTRY_CHARS 的片段（贪心，不产生碎片） */
function splitLong(text) {
  const sentences = String(text).split(SENTENCE).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && (cur + s).length > LONG_ENTRY_CHARS) { out.push(cur); cur = s; } else cur += s;
  }
  if (cur) out.push(cur);
  // 单句本身就超长（无标点的长串）：硬切，保证条目不会无限大
  const hard = [];
  for (const piece of out) {
    if (piece.length <= LONG_ENTRY_CHARS * 2) { hard.push(piece); continue; }
    for (let i = 0; i < piece.length; i += LONG_ENTRY_CHARS) hard.push(piece.slice(i, i + LONG_ENTRY_CHARS));
  }
  return hard;
}

/** 纪要文本 → 原子条目（无项目符号时整天作为一条；超长条目再按句子切细） */
function splitDigest(text, day) {
  const raw = String(text || '');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const items = [];
  let current = null;
  for (const line of lines) {
    const isBullet = BULLET.test(line);
    const cleaned = line.replace(BULLET, '').trim();
    if (!cleaned) continue;
    if (isBullet || current === null) {
      if (current) items.push(current);
      current = cleaned;
    } else {
      current += ' ' + cleaned; // 续行并入上一条
    }
  }
  if (current) items.push(current);
  // 超长条目按句子切细：检索需要粒度，否则一条就撑爆预算
  const atoms = [];
  for (const item of items) {
    if (item.length > LONG_ENTRY_CHARS) atoms.push(...splitLong(item));
    else atoms.push(item);
  }
  return atoms.map((t, i) => ({ day, index: i, text: t }));
}

/** 一天的纪要 → 条目数组（兼容 Map<day, text> 结构） */
function toEntries(digests) {
  const entries = [];
  const days = [...digests.keys()].sort((a, b) => a - b);
  for (const d of days) entries.push(...splitDigest(digests.get(d), d));
  return entries;
}

/** 出现过的座位号（用于相关度比对） */
function seatsIn(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/(\d+)\s*号/g)) out.add(Number(m[1]));
  return out;
}

/** 重要性 0~10（确定性关键词计价；越具体的事件越重要） */
function importanceOf(text) {
  let score = 0;
  const hits = [];
  for (const h of IMPORTANCE_HINTS) {
    if (h.re.test(text)) { score += h.w; hits.push(h.why); }
  }
  // 条目越长通常信息越多，但收益递减（避免长段落靠长度霸榜）
  score += Math.min(1.5, text.length / 60);
  return { score: Math.min(10, Number(score.toFixed(3))), why: hits };
}

/** 新近度 0~1：以"当前天"为 1，每天按半衰期衰减 */
function recencyOf(day, nowDay, halfLife = 3) {
  const age = Math.max(0, nowDay - day);
  return Math.pow(0.5, age / halfLife);
}

/** 相关度 0~1：与当前决策的座位/话题重合度 */
function relevanceOf(entry, query) {
  if (!query) return 0;
  let hit = 0;
  let total = 0;
  if (query.seats && query.seats.size) {
    const s = seatsIn(entry.text);
    total += 1;
    if ([...s].some((x) => query.seats.has(x))) hit += 1;
  }
  if (query.terms && query.terms.length) {
    total += 1;
    const t = entry.text;
    if (query.terms.some((w) => w && t.includes(w))) hit += 1;
  }
  return total ? hit / total : 0;
}

const WEIGHTS = { recency: 1.0, importance: 0.6, relevance: 1.6 };

/** 综合打分（纯函数；同分时用 day/index 兜底，保证顺序稳定可复现） */
function scoreOf(entry, { nowDay, query }) {
  const imp = importanceOf(entry.text);
  const rec = recencyOf(entry.day, nowDay);
  const rel = relevanceOf(entry, query);
  return {
    score: Number((WEIGHTS.recency * rec + WEIGHTS.importance * (imp.score / 10) * 2 + WEIGHTS.relevance * rel).toFixed(6)),
    recency: Number(rec.toFixed(6)), importance: imp.score, relevance: Number(rel.toFixed(6)), why: imp.why,
  };
}

/** 排序：分数降序 → 天降序 → 条目序升序（后两者只为消除并列时的歧义） */
function rankEntries(entries, opts) {
  return entries
    .map((e, i) => ({ ...e, _i: i, ...scoreOf(e, opts) }))
    .sort((a, b) => b.score - a.score || b.day - a.day || a.index - b.index || a._i - b._i);
}

/** 按天分组渲染（保持与既有格式一致，便于对读） */
function renderByDay(entries) {
  const byDay = new Map();
  for (const e of entries) {
    if (!byDay.has(e.day)) byDay.set(e.day, []);
    byDay.get(e.day).push(e.text);
  }
  const parts = [];
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const lines = byDay.get(day);
    parts.push(`◆ 第${day}天纪要：\n${lines.map((t) => '- ' + t).join('\n')}`);
  }
  return parts.join('\n');
}

/**
 * 记忆检索主入口。
 *
 * @param {Map<number,string>} digests  day → 纪要文本
 * @param {object} opts  { nowDay, query, budgetTokens, label }
 * @returns {{ text, kept, total, omitted, tokens, retrieved }}
 */
function selectMemory(digests, opts = {}) {
  const nowDay = opts.nowDay || 0;
  const budgetTokens = opts.budgetTokens != null ? opts.budgetTokens : Infinity;
  const entries = toEntries(digests);
  const header = '──── 早期记忆纪要（更早天数的事实与判断要点）────';
  if (!entries.length) return { text: '', kept: 0, total: 0, omitted: 0, tokens: 0, retrieved: false };

  // 约束 2：装得下就原样全给（与重构前逐字一致，短局零行为变化）
  const fullText = `${header}\n${renderByDay(entries)}`;
  const fullTokens = estimateTokens(fullText);
  if (fullTokens <= budgetTokens) {
    return { text: fullText, kept: entries.length, total: entries.length, omitted: 0, tokens: fullTokens, retrieved: false };
  }

  // 超预算 → 按相关度检索，逐条放入直到装不下
  const ranked = rankEntries(entries, { nowDay, query: opts.query });
  const costOf = (e) => estimateTokens(`- ${e.text}\n◆ 第${e.day}天纪要：\n`);
  const noteOf = (arr, noFit) => (noFit
    ? `（已按相关度检索：预算不足以容纳任何完整条目，只保留了最重要的一条；共 ${entries.length} 条记忆）`
    : `（已按相关度检索：保留 ${arr.length} / 共 ${entries.length} 条，省略 ${entries.length - arr.length} 条较不相关的记忆）`);
  const build = (arr, noFit) => `${header}\n${noteOf(arr, noFit)}\n${renderByDay(arr)}`;
  let kept = [];
  let used = estimateTokens(header);
  let noFit = false;
  for (const e of ranked) {
    if (used + costOf(e) > budgetTokens) {
      if (kept.length) break;
      noFit = true; // 第一条就装不下：保留完整的一条，总比把记忆切成半句话强
    }
    kept.push(e);
    used += costOf(e);
  }
  // 标注行本身也要占预算：逐条回退直到真的装得下
  let text = build(kept, noFit);
  while (estimateTokens(text) > budgetTokens && kept.length > 1) {
    kept = kept.slice(0, -1);
    text = build(kept, noFit);
  }
  // 一条都没省下来时不许标"已检索"——那会让人以为做了取舍（不静默降级的反面同样是"不虚报"）
  if (kept.length === entries.length) {
    return { text: fullText, kept: entries.length, total: entries.length, omitted: 0, tokens: fullTokens, retrieved: false };
  }
  const omitted = entries.length - kept.length;
  return { text, kept: kept.length, total: entries.length, omitted, tokens: estimateTokens(text), retrieved: true, noFit };
}

module.exports = {
  IMPORTANCE_HINTS, WEIGHTS,
  splitDigest, toEntries, seatsIn, importanceOf, recencyOf, relevanceOf, scoreOf, rankEntries, renderByDay, selectMemory,
};
