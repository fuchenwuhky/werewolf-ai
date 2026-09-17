/**
 * claims.js — 宣称账本（B2）
 *
 * 核心思想一句话：**"某人说了什么"是事实，"他说的内容"不是。**
 *
 * 所以宣称的抽取放在引擎侧、由代码完成（不经过模型的嘴）：模型只负责说话，
 * "这句话里包含哪些宣称"由确定性规则扫描出来 —— 模型漏报、或者故意不报，都不会让账本失真。
 * 每条宣称都自带 `verifiedBy: null`：**引擎永远不会替它背书**，
 * 后续只有"真预言家的查验结果""翻牌""终局复盘"这类硬事实才能验证它。
 *
 * 与"硬事实时间线"物理隔开（快照里是两个独立分区）：下一位 AI 读到的是
 * 「某人**声称** 5 号是狼（未经证实）」，而不是「5 号是狼」。
 *
 * 只抽"可核对的知识性宣称"（自认身份 / 查验结果 / 用药），不抽主观判断 ——
 * "我觉得 5 号像狼"是看法，不是宣称，记进账本只会变成噪声。
 */
'use strict';

/** 自认身份的说法（"我是预言家""我跳预言家""我底牌是女巫"…） */
const SELF_PATTERNS = [
  { kind: 'seer', re: /(?:我是|我跳|我认|我底牌是|我这张牌是|我真是)(?:个|一张|一张牌是)?(?:预言家|预言)/ },
  { kind: 'witch', re: /(?:我是|我跳|我认|我底牌是|我这张牌是|我真是)(?:个|一张)?(?:女巫)/ },
  { kind: 'guard', re: /(?:我是|我跳|我认|我底牌是|我这张牌是|我真是)(?:个|一张)?(?:守卫|守护者)/ },
  { kind: 'hunter', re: /(?:我是|我跳|我认|我底牌是|我这张牌是|我真是)(?:个|一张)?(?:猎人)/ },
  { kind: 'villager', re: /(?:我是|我跳|我认|我底牌是|我这张牌是|我真是)(?:个|一张)?(?:村民|平民)/ },
];

/** 知识性宣称：查验结果与用药（N号→value）。座位与结论之间不许出现否定词或标点 ——
 *  没有这个限制，"3号查杀，7号金水" 会被读成「3号查杀」+「7号查杀」+「3号金水」三条假宣称。 */
const FACT_PATTERNS = [
  { kind: 'seer', value: 'wolf', re: /(\d{1,2})\s*号[^。！？\n，,、；不没]{0,4}查杀/g },
  { kind: 'seer', value: 'wolf', re: /查杀\s*(\d{1,2})\s*号/g },
  { kind: 'seer', value: 'good', re: /(\d{1,2})\s*号[^。！？\n，,、；不没]{0,4}金水/g },
  { kind: 'seer', value: 'good', re: /金水\s*(\d{1,2})\s*号/g },
  { kind: 'seer', value: 'wolf', re: /(?:验了|查验了|验的|验过)[^。！？\n，,]{0,4}(\d{1,2})\s*号[^。！？\n，,；不没]{0,4}(?:是)?\s*(?:狼|狼人)/g },
  { kind: 'seer', value: 'good', re: /(?:验了|查验了|验的|验过)[^。！？\n，,]{0,4}(\d{1,2})\s*号[^。！？\n，,；不没]{0,4}(?:是)?\s*(?:好人|金水)/g },
  { kind: 'witch', value: 'save', re: /(?:救了|捞了|救的|救过)(?:他|她)?\s*(\d{1,2})\s*号/g },
  { kind: 'witch', value: 'poison', re: /(?:毒了|毒的|毒过)\s*(\d{1,2})\s*号/g },
];

/** 否定/假设的前缀：命中这些就当"没有宣称"（"我不是预言家""如果我是预言家"） */
const GUARD = /(?:不|没|别|非|如果|假如|要是|倘若|假设|哪怕|就算|他说|他说他|他称|自称是别人)$/;

/** 取匹配点之前的一小段，用于判断否定/假设语境 */
function guardedAt(text, index) {
  const before = text.slice(Math.max(0, index - 8), index);
  return GUARD.test(before);
}

/** 座位号合法区间（1..seatCount），过滤"2024 号"这类误匹配 */
function validSeat(n, seatCount) {
  return Number.isInteger(n) && n >= 1 && n <= seatCount;
}

/**
 * 从一段发言里扫描宣称（确定性，纯函数）
 * @param {string} text  发言正文
 * @param {number} seatCount  座位总数
 * @returns {Array<{kind,subject,value,source}>}  subject=0 表示"自认身份"
 */
function claimScan(text, seatCount = 12) {
  const s = typeof text === 'string' ? text : '';
  if (!s.trim()) return [];
  const out = [];
  const seen = new Set();
  const add = (kind, subject, value, source) => {
    const key = `${kind}|${subject}|${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, subject, value, source });
  };
  for (const p of SELF_PATTERNS) {
    const m = p.re.exec(s);
    if (m && !guardedAt(s, m.index)) add(p.kind, 0, 'self', 'engine');
  }
  for (const p of FACT_PATTERNS) {
    // 一律用 /g 迭代：非全局正则的 exec 每次都从头匹配，`continue` 会让 while 永远不前进（实测死循环）。
    const re = p.re.global ? p.re : new RegExp(p.re.source, `${p.re.flags}g`);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      if (guardedAt(s, m.index)) continue; // /g 的 exec 已推进 lastIndex，continue 是安全的
      const seat = m[1] ? Number(m[1]) : 0;
      if (seat && !validSeat(seat, seatCount)) continue;
      add(p.kind, seat, p.value, 'engine');
    }
  }
  return out;
}

/** 合并"引擎扫描"与"模型自报"：引擎优先，模型补漏（去重，来源标清） */
function mergeClaims(scanned, selfReported, seatCount = 12) {
  const out = [];
  const seen = new Set();
  const push = (c, source) => {
    if (!c || typeof c !== 'object') return;
    const kind = String(c.kind || '');
    if (!['seer', 'witch', 'guard', 'hunter', 'villager', 'other'].includes(kind)) return;
    const subject = Number(c.subject) || 0;
    if (subject && !validSeat(subject, seatCount)) return;
    const value = String(c.value || '').slice(0, 16);
    if (!value) return;
    const key = `${kind}|${subject}|${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, subject, value, source });
  };
  for (const c of Array.isArray(scanned) ? scanned : []) push(c, 'engine');
  for (const c of Array.isArray(selfReported) ? selfReported : []) push(c, 'ai');
  return out;
}

const KIND_NAME = { seer: '预言家', witch: '女巫', guard: '守卫', hunter: '猎人', villager: '村民', other: '身份' };

/** 把一条宣称渲染成人话（快照的"公开宣称"分区用，前缀由调用方补"某人声称"） */
function renderClaim(c) {
  const d = c || {};
  const kind = KIND_NAME[d.kind] || '身份';
  if (!d.subject) return `自称${kind}`;
  if (d.kind === 'seer' && d.value === 'wolf') return `声称 ${d.subject}号 是狼（查杀）`;
  if (d.kind === 'seer' && d.value === 'good') return `声称 ${d.subject}号 是好人（金水）`;
  if (d.kind === 'witch' && d.value === 'save') return `声称昨晚救了 ${d.subject}号`;
  if (d.kind === 'witch' && d.value === 'poison') return `声称昨晚毒了 ${d.subject}号`;
  return `声称与 ${d.subject}号 有关（${d.value}）`;
}

module.exports = { claimScan, mergeClaims, renderClaim, SELF_PATTERNS, FACT_PATTERNS };
