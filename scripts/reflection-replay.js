/**
 * reflection-replay.js — 用真实对局日志量化"反思节流与边界化"（P0-5）的收益。
 *
 * 用法： node scripts/reflection-replay.js
 *
 * 可重建的事实（logs/game-*.log 的 JSONL 行）：
 *  - 每次反思调用的座位、天数、耗时
 *  - 该座位在"那一天"可见的非噪音事件数 → 判断新阈值能否触发
 *  - 反思调用是否紧邻同座位的下一次决策（即旧设计里的"内联阻塞"）
 *
 * 结论（2026-09-15 实测）：
 *  - 边界化有效：13/14 次反思原本紧贴在决策前面，给"首答"额外加了 p50 20.6s / max 166.5s 的等待
 *  - 按"每日可见事件数"节流在真实数据里不触发：反思日的可见事件数为 15~63，阈值 6/8/10 全部低于最小值
 *  - 因此"单局调用数 -15%"这个验收目标无法靠反思节流达成（详见 docs/upgrade-plan.md §8）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'logs');
const RE_LINE = /^d(\d+)\/(\S+) (\S+)(?: vis=([^|]+))?/;
// 与 context.js / agent.js 保持一致的噪音口径
const SKIP = new Set(['await_input', 'ai_thinking', 'llm_error', 'ai_reasoning']);

if (!fs.existsSync(DIR)) {
  console.error('找不到 logs 目录（logs/ 是 gitignore 的运行时产物，需要在真实对局后运行）');
  process.exit(1);
}

const games = [];
for (const f of fs.readdirSync(DIR).filter((x) => x.startsWith('game-') && x.endsWith('.log'))) {
  const rows = [];
  for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.module === 'engine') {
      const m = RE_LINE.exec(j.msg || '');
      if (m) rows.push({ kind: 'ev', seq: j.seq, day: +m[1], type: m[3], vis: m[4] ? m[4].trim() : 'all' });
    } else if (j.module === 'llm' && j.data && j.data.task) {
      const m = /ok (\d+)pt\(缓存(\d+)\)\/(\d+)ct (\d+)ms 尝试(\d+)/.exec(j.msg || '');
      if (m) rows.push({ kind: 'llm', seq: j.seq, seat: j.data.seat, task: j.data.task, ms: +m[4] });
    }
  }
  if (rows.some((r) => r.kind === 'llm')) games.push({ file: f, rows: rows.sort((a, b) => a.seq - b.seq), mtime: fs.statSync(path.join(DIR, f)).mtime });
}

const visible = (ev, seat) => ev.vis === 'all' || ev.vis.split(',').map(Number).includes(seat);
const pct = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : null; };
const fmt = (ms) => (ms == null ? '-' : ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms');
const sum = (a) => a.reduce((x, y) => x + y, 0);

const reflections = [];
let totalCalls = 0;
for (const g of games) {
  for (let i = 0; i < g.rows.length; i++) {
    const r = g.rows[i];
    if (r.kind !== 'llm') continue;
    totalCalls++;
    const m = /^第(\d+)天反思$/.exec(r.task);
    if (!m) continue;
    const day = +m[1];
    let cnt = 0;
    for (const e of g.rows) {
      if (e.kind !== 'ev' || e.day !== day || SKIP.has(e.type)) continue;
      if (visible(e, r.seat)) cnt++;
    }
    let nextTask = null;
    for (let k = i + 1; k < g.rows.length; k++) {
      if (g.rows[k].kind === 'llm' && g.rows[k].seat === r.seat) { nextTask = g.rows[k].task; break; }
    }
    reflections.push({ game: g.file, seat: r.seat, day, ms: r.ms, events: cnt, nextTask });
  }
}

console.log('真实对局数:', games.length, '| 总 LLM 调用:', totalCalls, '| 反思调用:', reflections.length,
  `(${(100 * reflections.length / totalCalls).toFixed(1)}%)`);

console.log('\n=== 改动前：反思调用耗时（旧设计里它阻塞在新一天首个决策之前）===');
const ms = reflections.map((r) => r.ms);
if (ms.length) console.log(`  p50 ${fmt(pct(ms, 50))}  p90 ${fmt(pct(ms, 90))}  max ${fmt(Math.max(...ms))}  平均 ${fmt(Math.round(sum(ms) / ms.length))}`);
const inline = reflections.filter((r) => r.nextTask && !/反思$/.test(r.nextTask));
const inlineMs = inline.map((r) => r.ms);
console.log(`  其中紧随同座位决策调用（即旧设计的"内联阻塞"）: ${inline.length}/${reflections.length}`);
if (inlineMs.length) {
  console.log(`  这些内联反思给"首个决策"额外增加的等待: p50 ${fmt(pct(inlineMs, 50))}  p90 ${fmt(pct(inlineMs, 90))}  max ${fmt(Math.max(...inlineMs))}`);
  console.log('  → 改动后这些等待移到日切边界后台：决策只等决策本身，验收"首答不再异常慢"成立');
}

console.log('\n=== 改动后：按"每日可见事件数"节流会省掉哪些反思调用 ===');
for (const threshold of [4, 6, 8, 10, 12]) {
  const saved = reflections.filter((r) => r.events < threshold);
  console.log(`  阈值 ${String(threshold).padStart(2)}：省掉 ${String(saved.length).padStart(3)}/${reflections.length} 次反思`
    + `（总调用 -${(100 * saved.length / Math.max(1, totalCalls)).toFixed(1)}%）`);
}
if (reflections.length) {
  const evs = reflections.map((r) => r.events).sort((a, b) => a - b);
  console.log(`  反思日的可见事件数：min ${evs[0]} p25 ${pct(evs, 25)} 中位 ${pct(evs, 50)} p75 ${pct(evs, 75)} max ${evs[evs.length - 1]}`);
  console.log('  正常一天有 11+ 条发言，事件数天然很高 → 该阈值只能在"被自爆/决斗打断的短日"触发');
}

console.log('\n=== 逐局明细（当前代码 vs 旧日志）===');
const byGame = new Map();
for (const r of reflections) {
  if (!byGame.has(r.game)) byGame.set(r.game, []);
  byGame.get(r.game).push(r);
}
const perGame = games.map((g) => {
  const rs = byGame.get(g.file) || [];
  const calls = g.rows.filter((r) => r.kind === 'llm').length;
  const im = rs.filter((r) => r.nextTask && !/反思$/.test(r.nextTask)).map((r) => r.ms);
  return { file: g.file.slice(5, -4), mtime: g.mtime, calls, refl: rs.length, inlineMax: im.length ? Math.max(...im) : 0 };
}).sort((a, b) => b.calls - a.calls);
console.log('  对局'.padEnd(18), '调用'.padStart(5), '反思'.padStart(5), '占比'.padStart(7), '最大额外等待'.padStart(13));
for (const p of perGame.slice(0, 10)) {
  console.log(`  ${p.file.padEnd(16)} ${String(p.calls).padStart(5)} ${String(p.refl).padStart(5)} ${(100 * p.refl / p.calls).toFixed(1).padStart(6)}% ${fmt(p.inlineMax).padStart(13)}`);
}
console.log('  注：反思功能上线前（refl=0）的旧日志不能用于衡量反思开销；上表按时间可自行区分。');
