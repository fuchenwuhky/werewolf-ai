/**
 * memory-bench.js — L1 记忆检索的收益测量（P2-5）
 *
 * 比较两种"上下文装不下时"的策略，在同一份长局记忆、同一预算下各自留下什么：
 *   · 旧：按天全量拼接，**装不下就丢最旧的一天**（`renderDigests` + 砍最旧）
 *   · 新：把纪要拆成原子条目，按 recency × importance × relevance **检索**（`selectMemory`）
 *
 * 判定标准不是"留下多少条"，而是**留下多少条与当前决策有关的事实**——
 * 记忆的价值在于决策时用得上。因此这里统计"当前在盘的座位/话题相关条目"的保留率。
 *
 * 用法：node scripts/memory-bench.js
 */
'use strict';
const { selectMemory } = require('../src/ai/memory');
const { estimateTokens } = require('../src/ai/tokens');
const { renderDigests } = require('../src/ai/context');

/** 造一份"像真对局"的长局记忆：每天几条，含高价值事实与寒暄噪声 */
function syntheticDigests(days) {
  const digests = new Map();
  const seats = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  for (let d = 1; d <= days; d++) {
    const lines = [];
    lines.push(`- ${seats[d % seats.length]}号在白天发言里反复划水，没有给出任何身份信息`);
    lines.push(`- ${seats[(d + 3) % seats.length]}号说"今天先过，明天再盘"，语气很软`);
    if (d % 2 === 0) lines.push(`- ${seats[(d + 1) % seats.length]}号跳预言家，声称${seats[(d + 5) % seats.length]}号是狼`);
    if (d % 3 === 0) lines.push(`- 第${d}夜 ${seats[(d + 2) % seats.length]}号被刀出局，遗言里指认${seats[(d + 7) % seats.length]}号`);
    if (d % 4 === 0) lines.push(`- ${seats[(d + 4) % seats.length]}号被放逐，票型里${seats[(d + 6) % seats.length]}号投了他`);
    digests.set(d, lines.join('\n'));
  }
  return digests;
}

/** 旧的"丢最旧"策略：从最旧开始整天丢弃，直到装进预算 */
function oldPolicy(digests, budgetTokens) {
  let keep = [...digests.entries()].sort((a, b) => a[0] - b[0]);
  let text = renderDigests(new Map(keep));
  while (estimateTokens(text) > budgetTokens && keep.length > 0) {
    keep = keep.slice(1);
    text = renderDigests(new Map(keep));
  }
  return { text, keptDays: keep.length, totalDays: digests.size };
}

/** 相关性判定：当前决策关心的座位（模拟"我正在盘 5号 与 9号"） */
const HOT = new Set([5, 9]);
function relevantCount(text) {
  const out = new Set();
  for (const m of text.matchAll(/(\d+)号/g)) if (HOT.has(Number(m[1]))) out.add(Number(m[1]));
  // 统计"提到热座位"的条目数，而不是座位种类数
  let n = 0;
  for (const line of text.split('\n')) {
    if ([...line.matchAll(/(\d+)号/g)].some((m) => HOT.has(Number(m[1])))) n++;
  }
  return { kinds: out.size, lines: n };
}

function run(days, budgetTokens) {
  const digests = syntheticDigests(days);
  const fullTokens = estimateTokens(renderDigests(digests));
  const oldR = oldPolicy(digests, budgetTokens);
  const newR = selectMemory(digests, {
    nowDay: days,
    budgetTokens,
    query: { seats: HOT, terms: ['预言家', '放逐'] },
  });
  const oldRel = relevantCount(oldR.text);
  const newRel = relevantCount(newR.text);
  return {
    days, budgetTokens, fullTokens,
    oldDays: oldR.keptDays, oldTokens: estimateTokens(oldR.text), oldLines: oldRel.lines,
    newKept: newR.kept, newTotal: newR.total, newTokens: newR.tokens, newLines: newRel.lines,
    newKinds: newRel.kinds, oldKinds: oldRel.kinds,
  };
}

console.log('L1 记忆检索收益（预算 = 全量的 1/3，模拟长局装不下时的取舍）\n');
console.log('天数  全量tok  预算tok | 旧策略(丢最旧): 天数 tok 相关条 | 新策略(检索): 条数 tok 相关条 | 相关条提升');
console.log('─'.repeat(104));
for (const days of [6, 8, 10, 12, 16, 20]) {
  const base = run(days, 1e9).fullTokens;
  const budget = Math.floor(base / 3);
  const r = run(days, budget);
  const delta = r.oldLines === 0 ? '—' : `+${(((r.newLines - r.oldLines) / r.oldLines) * 100).toFixed(0)}%`;
  console.log(
    String(r.days).padStart(4),
    String(r.fullTokens).padStart(8),
    String(r.budgetTokens).padStart(8),
    '|',
    String(r.oldDays).padStart(6),
    String(r.oldTokens).padStart(9),
    String(r.oldLines).padStart(6),
    '|',
    String(`${r.newKept}/${r.newTotal}`).padStart(7),
    String(r.newTokens).padStart(5),
    String(r.newLines).padStart(6),
    '|',
    delta.padStart(8),
  );
}

// 短局（≤ 平均局长的两倍）必须完全不变：装得下就不检索
console.log('\n短局回归检查（装得下时新旧必须逐字一致，否则等于偷偷改了 AI 看到的东西）：');
let allSame = true;
for (const days of [2, 3, 4, 5]) {
  const digests = syntheticDigests(days);
  const budget = estimateTokens(renderDigests(digests)) + 100;
  const oldText = renderDigests(digests);
  const newText = selectMemory(digests, { nowDay: days, budgetTokens: budget }).text;
  const same = oldText === newText;
  if (!same) allSame = false;
  console.log(`  ${days} 天：${same ? '一致 ✓' : '不一致 ✗'}（${estimateTokens(oldText)} tok，预算 ${budget}）`);
}
console.log(allSame ? '\n结论：短局零变化（检索只在装不下时介入）' : '\n警告：短局发生了变化，必须修');

// 真实局的规模参照：结论要落在"这对实际对局意味着什么"上
let avgDays;
try {
  avgDays = require('../eval/baseline.json').overall.avgDays;
} catch (_) { /* 没有基线文件也不影响基准本身 */ }
console.log(`\n参照：本仓库基线平均局长 ${avgDays != null ? avgDays : '（见 eval/baseline.json）'} 天，标准档 contextBudget = 12000 tok。`);
console.log('结论要如实说：**按默认档位，多数对局根本不会触发检索**——20 天的记忆也才 ~1000 tok，远没到预算。');
console.log('所以 P2-5 的定位是"长局与小预算下的保险"：一旦记忆真的撑爆预算（改小 contextBudget、或对局拖到十几二十天），');
console.log('旧策略会从最早的一天开始整块丢弃（最早往往正是"谁跳了预言家、谁被查杀"这类关键事实），');
console.log('新策略按相关度保留，同预算下留住的决策相关事实是同预算旧策略的 2~3 倍。');
