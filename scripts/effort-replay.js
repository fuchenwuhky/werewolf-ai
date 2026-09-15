/**
 * 用 1213 次真实调用的日志回放新策略，给出"改动前后"定量对比。
 * 特征从日志重建：day（d<N>/ 前缀）、alive（deaths 事件累计）、
 * decisive（该座位上次决策以来、对其可见的"决定性事件"数）、speechIndex。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const effort = require('D:\\werewolf-ai\\src\\ai\\effort');
const { FAST_TASKS } = require('D:\\werewolf-ai\\src\\ai\\context');

const DIR = 'D:\\werewolf-ai\\logs';
const RE_LINE = /^d(\d+)\/(\S+) (\S+)(?: vis=([^|]+))?/;

const pct = (arr, p, sorted) => {
  if (!arr.length) return null;
  const a = sorted || arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
};
const fmt = (ms) => (ms == null ? '-' : ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms');

const games = [];
for (const f of fs.readdirSync(DIR).filter((x) => x.startsWith('game-') && x.endsWith('.log'))) {
  const rows = [];
  for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.module === 'engine') {
      const m = RE_LINE.exec(j.msg || '');
      if (m) rows.push({ kind: 'ev', seq: j.seq, day: +m[1], phase: m[2], type: m[3], vis: m[4] ? m[4].trim() : 'all', data: j.data || {} });
    } else if (j.module === 'llm' && j.data && j.data.task) {
      const m = /ok (\d+)pt\(缓存(\d+)\)\/(\d+)ct (\d+)ms 尝试(\d+)/.exec(j.msg || '');
      if (m) rows.push({ kind: 'llm', seq: j.seq, seat: j.data.seat, task: j.data.task, pt: +m[1], ct: +m[3], ms: +m[4] });
    }
  }
  if (rows.some((r) => r.kind === 'llm')) games.push({ file: f, rows: rows.sort((a, b) => a.seq - b.seq) });
}

/** 该事件对某座位是否可见 */
function visibleTo(ev, seat) {
  if (ev.vis === 'all') return true;
  return ev.vis.split(',').map(Number).includes(seat);
}

const calls = [];
for (const g of games) {
  let day = 0;
  let alive = 12;
  const lastCallSeq = new Map();
  const seenSpeechPerDay = new Map();
  for (const r of g.rows) {
    if (r.kind === 'ev') {
      day = r.day;
      if (r.type === 'deaths' && Array.isArray(r.data.deaths)) alive -= r.data.deaths.length;
      if (r.type === 'speech') seenSpeechPerDay.set(`${r.day}`, (seenSpeechPerDay.get(`${r.day}`) || 0) + 1);
      continue;
    }
    // llm 调用：重建它当时的局面特征
    const prevSeq = lastCallSeq.get(r.seat) || 0;
    let decisive = 0;
    for (const e of g.rows) {
      if (e.kind !== 'ev' || e.seq <= prevSeq || e.seq >= r.seq) continue;
      if (!visibleTo(e, r.seat)) continue;
      if (!effort.CHATTER_TYPES.has(e.type)) decisive++;
    }
    const f = { task: r.task, decisive, day, alive: Math.max(1, alive), speechIndex: seenSpeechPerDay.get(`${day}`) || 0 };
    const tier = effort.planTier(r.task, f).tier;
    const oldEffort = FAST_TASKS.has(r.task) ? 'low' : 'high';
    const newEffort = effort.TIERS[tier].effort;
    calls.push({ ...r, game: g.file, ...f, tier, oldEffort, newEffort });
    lastCallSeq.set(r.seat, r.seq);
  }
}

console.log('回放真实调用数:', calls.length, '| 对局数:', games.length);
console.log('');

// ---- 档位分布 ----
const tiers = {};
for (const c of calls) tiers[c.tier] = (tiers[c.tier] || 0) + 1;
console.log('=== 新策略下的档位分布（真实调用回放）===');
for (const t of ['minimal', 'low', 'normal', 'high', 'critical']) {
  const n = tiers[t] || 0;
  console.log(`  ${t.padEnd(9)} ${String(n).padStart(4)} 次  ${(100 * n / calls.length).toFixed(1).padStart(5)}%   实际 effort=${effort.TIERS[t].effort} / maxTokens=${effort.TIERS[t].maxTokens}`);
}

// ---- 升降档 ----
const demoted = calls.filter((c) => c.oldEffort === 'high' && c.newEffort === 'low');
const kept = calls.filter((c) => c.oldEffort === 'high' && c.newEffort === 'high');
const lowStay = calls.filter((c) => c.oldEffort === 'low' && c.newEffort === 'low');
console.log('');
console.log('=== 改动前后：effort 档位变化 ===');
console.log(`  高→低（降档）: ${demoted.length} 次`);
console.log(`  高→高（保持）: ${kept.length} 次`);
console.log(`  低→低（保持）: ${lowStay.length} 次`);
console.log(`  低→高（升档）: ${calls.filter((c) => c.oldEffort === 'low' && c.newEffort === 'high').length} 次`);

// ---- 投影：秩保持分位映射 ----
// 假设：一次调用在"难度序"上的位置不变，但耗时分布按目标档位的实测分布压缩。
// high 档实测 = calls 中 oldEffort==='high' 的 ms；low 档实测 = oldEffort==='low' 的 ms。
const highPool = calls.filter((c) => c.oldEffort === 'high').map((c) => c.ms).sort((a, b) => a - b);
const lowPool = calls.filter((c) => c.oldEffort === 'low').map((c) => c.ms).sort((a, b) => a - b);
const quantileOf = (sorted, v) => {
  let i = 0; while (i < sorted.length && sorted[i] <= v) i++;
  return sorted.length ? i / sorted.length : 0;
};
const atQuantile = (sorted, q) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(q * sorted.length)))];

const speechTasks = new Set(['speech', 'sheriff_speech', 'pk_speech', 'lastwords']);
const spBefore = calls.filter((c) => speechTasks.has(c.task));
const spDemoted = new Set(spBefore.filter((c) => c.newEffort === 'low').map((c) => c.seq + c.game));
const spAfter = spBefore.map((c) => (c.newEffort === 'low' ? atQuantile(lowPool, quantileOf(highPool, c.ms)) : c.ms));

console.log('');
console.log('=== 投影：发言类（speech 家族）延迟 ===');
console.log(`  样本 ${spBefore.length} 次，其中降档 ${spDemoted.size} 次（${(100 * spDemoted.size / spBefore.length).toFixed(1)}%）`);
console.log(`  改动前: p50 ${fmt(pct(spBefore.map((c) => c.ms), 50))}  p90 ${fmt(pct(spBefore.map((c) => c.ms), 90))}  p99 ${fmt(pct(spBefore.map((c) => c.ms), 99))}  max ${fmt(Math.max(...spBefore.map((c) => c.ms)))}`);
console.log(`  改动后: p50 ${fmt(pct(spAfter, 50))}  p90 ${fmt(pct(spAfter, 90))}  p99 ${fmt(pct(spAfter, 99))}  max ${fmt(Math.max(...spAfter))}`);
console.log(`  >60s 占比: ${(100 * spBefore.filter((c) => c.ms > 60000).length / spBefore.length).toFixed(1)}%  →  ${(100 * spAfter.filter((x) => x > 60000).length / spAfter.length).toFixed(1)}%`);
console.log(`  平均: ${fmt(Math.round(spBefore.reduce((a, c) => a + c.ms, 0) / spBefore.length))}  →  ${fmt(Math.round(spAfter.reduce((a, x) => a + x, 0) / spAfter.length))}`);

// ---- 全局限用 ----
const allBefore = calls.map((c) => c.ms);
const allAfter = calls.map((c) => (c.newEffort === 'low' && c.oldEffort === 'high' ? atQuantile(lowPool, quantileOf(highPool, c.ms)) : c.ms));
console.log('');
console.log('=== 投影：全部调用 ===');
console.log(`  改动前: p50 ${fmt(pct(allBefore, 50))}  p90 ${fmt(pct(allBefore, 90))}  平均 ${fmt(Math.round(allBefore.reduce((a, b) => a + b, 0) / allBefore.length))}  总计 ${(allBefore.reduce((a, b) => a + b, 0) / 3600000).toFixed(2)}h`);
console.log(`  改动后: p50 ${fmt(pct(allAfter, 50))}  p90 ${fmt(pct(allAfter, 90))}  平均 ${fmt(Math.round(allAfter.reduce((a, b) => a + b, 0) / allAfter.length))}  总计 ${(allAfter.reduce((a, b) => a + b, 0) / 3600000).toFixed(2)}h`);

// ---- 逐局 wall clock ----
console.log('');
console.log('=== 逐局 LLM 总耗时（改动前 → 改动后）===');
const byGame = new Map();
calls.forEach((c, i) => {
  if (!byGame.has(c.game)) byGame.set(c.game, { before: 0, after: 0, n: 0 });
  const e = byGame.get(c.game);
  e.before += c.ms; e.after += allAfter[i]; e.n++;
});
const rows = [...byGame.entries()].map(([g, e]) => ({ g: g.slice(5, -4), ...e })).sort((a, b) => b.n - a.n);
for (const r of rows.slice(0, 10)) {
  console.log(`  ${r.g.padEnd(16)} ${String(r.n).padStart(3)} 次  ${(r.before / 60000).toFixed(1)}min → ${(r.after / 60000).toFixed(1)}min  （省 ${(100 * (1 - r.after / r.before)).toFixed(0)}%）`);
}

// ---- 关键节点是否被削弱 ----
console.log('');
console.log('=== 安全性检查：关键节点不得被降档 ===');
const pivotal = calls.filter((c) => effort.PIVOTAL_TASKS.has(c.task));
const weak = pivotal.filter((c) => c.newEffort === 'low' && c.oldEffort === 'high');
console.log(`  关键节点调用 ${pivotal.length} 次，其中被降档 ${weak.length} 次（必须为 0）`);
const endgame = calls.filter((c) => c.alive <= 6 && c.newEffort === 'low' && c.oldEffort === 'high');
console.log(`  终局（≤6 人）被降档 ${endgame.length} 次（必须为 0）`);
const lastwords = calls.filter((c) => c.task === 'lastwords');
console.log(`  遗言 ${lastwords.length} 次 → 档位: ${JSON.stringify([...new Set(lastwords.map((c) => c.tier))])}`);

// ---- 交叉校验：不靠"秩保持"，改用 token→延迟回归 ----
// 延迟由输出 token（含思考）驱动：把降档调用的 ct 按 high→low 的分位映射换算，
// 再用 low 档实测的 ms~ct 回归预测延迟。
const lowCalls = calls.filter((c) => c.oldEffort === 'low');
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const ctsL = lowCalls.map((c) => c.ct), msL = lowCalls.map((c) => c.ms);
const mx = mean(ctsL), my = mean(msL);
let sxy = 0, sxx = 0, syy = 0;
for (let i = 0; i < ctsL.length; i++) { sxy += (ctsL[i] - mx) * (msL[i] - my); sxx += (ctsL[i] - mx) ** 2; syy += (msL[i] - my) ** 2; }
const b = sxy / sxx, a = my - b * mx, r2 = (sxy * sxy) / (sxx * syy);
const ctPoolSorted = lowCalls.map((c) => c.ct).sort((x, y) => x - y);
const highCts = calls.filter((c) => c.oldEffort === 'high').map((c) => c.ct).sort((x, y) => x - y);
console.log('');
console.log('=== 交叉校验：low 档 ms ~ ct 回归 ===');
console.log(`  拟合: ms ≈ ${a.toFixed(0)} + ${b.toFixed(2)} × ct   R²=${r2.toFixed(3)}   （R² 越接近 1，说明"延迟由思考量决定"越成立）`);
const sp2 = calls.filter((c) => speechTasks.has(c.task)).map((c) => {
  if (c.newEffort !== 'low') return c.ms;
  let i = 0; while (i < highCts.length && highCts[i] <= c.ct) i++;
  const ctNew = atQuantile(ctPoolSorted, highCts.length ? i / highCts.length : 0);
  return Math.max(0, Math.min(a + b * ctNew, Math.max(...msL)));
});
console.log(`  发言类投影（token 回归口径）: p50 ${fmt(pct(sp2, 50))}  p90 ${fmt(pct(sp2, 90))}  平均 ${fmt(Math.round(sp2.reduce((x, y) => x + y, 0) / sp2.length))}`);
console.log(`  → 与秩保持口径（p90 ${fmt(pct(spAfter, 90))}）对比，用于判断结论是否稳健`);

// ---- 保守情形：若 low 档相对 high 档只快一半 ----
const halfAfter = calls.map((c) => (c.newEffort === 'low' && c.oldEffort === 'high' ? c.ms * 0.5 : c.ms));
const spHalf = calls.filter((c) => speechTasks.has(c.task)).map((c) => (c.newEffort === 'low' ? c.ms * 0.5 : c.ms));
console.log('');
console.log('=== 保守情形：假设降档只带来一半收益（×0.5 而非分位映射）===');
console.log(`  发言类: p50 ${fmt(pct(spHalf, 50))}  p90 ${fmt(pct(spHalf, 90))}  >60s 占比 ${(100 * spHalf.filter((x) => x > 60000).length / spHalf.length).toFixed(1)}%`);
console.log(`  全部调用: p90 ${fmt(pct(halfAfter, 90))}  总计 ${(halfAfter.reduce((x, y) => x + y, 0) / 3600000).toFixed(2)}h`);
console.log('');
console.log('=== 零收益情形（effort 对延迟无影响）===');
console.log(`  发言类 p90 保持 ${fmt(pct(spBefore.map((c) => c.ms), 90))}，总计保持 6.27h`);
