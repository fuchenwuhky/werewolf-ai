#!/usr/bin/env node
/**
 * playtest-report.js — 把真实对局日志汇成指标表（对局测试计划 P0/P6 的度量工具）。
 *
 * 为什么需要它：日志是给"事后排查"用的，一行一次调用；要回答
 * "单局多少次调用 / 花了多少 token / 发言延迟 p50、p90 / 有没有触发轻量补救"
 * 只能聚合。这个脚本就是那次聚合，且**只读日志**，不产生任何调用。
 *
 * 日志行格式（JSON Lines，已核实）：
 *   {"ts":…,"level":"debug","module":"llm","msg":"4号 ok 1628pt(缓存0)/68ct 2361ms 尝试1",
 *    "data":{"model":"…","task":"wolf_chat","seat":4,…}}
 *
 * 用法：
 *   node scripts/playtest-report.js                    # 汇总仓库 logs/ 下全部对局
 *   node scripts/playtest-report.js --dir=<目录>        # 汇总测试实例的日志
 *   node scripts/playtest-report.js --json             # 机器可读
 *   node scripts/playtest-report.js --top=10           # 只列调用量最大的 N 局
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CALL_RE = /(\d+)pt\(缓存(\d+)\)\/(\d+)ct (\d+)ms(?:\s+尝试(\d+))?(.*)$/;
/** 发言类任务（延迟体验的主要来源）：其余是短结构化决策 */
const SPEECH_TASKS = new Set(['speech', 'pk_speech', 'lastwords', 'sheriff_speech']);

function parseArgs(argv) {
  const out = { dir: path.join(__dirname, '..', 'logs'), json: false, top: 0 };
  for (const a of argv.slice(2)) {
    if (a === '--json') out.json = true;
    else if (a.startsWith('--dir=')) out.dir = a.slice(6);
    else if (a.startsWith('--top=')) out.top = Number(a.slice(6)) || 0;
  }
  return out;
}

function pct(values, q) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((q / 100) * s.length) - 1));
  return s[i];
}
const avg = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const round = (n, d = 1) => Number(n.toFixed(d));

/** 汇总单个日志文件 */
function parseGame(file) {
  const g = {
    game: path.basename(file), calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0,
    latencies: [], speechLatencies: [], tasks: {}, retried: 0, cheap: 0,
    validationFailures: 0, warnings: [], ended: null, startTs: null, endTs: null,
  };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch (_) { continue; } // 日志里可能有非 JSON 的尾巴
    if (row.ts) { if (g.startTs == null) g.startTs = row.ts; g.endTs = row.ts; }
    const msg = String(row.msg || '');
    if (row.module === 'llm' && msg.includes(' ok ')) {
      const m = CALL_RE.exec(msg);
      if (!m) continue;
      const [, pt, cached, ct, ms, attempt, tail] = m;
      const task = (row.data && row.data.task) || 'unknown';
      g.calls++;
      g.promptTokens += Number(pt);
      g.cachedTokens += Number(cached);
      g.completionTokens += Number(ct);
      g.latencies.push(Number(ms));
      if (SPEECH_TASKS.has(task)) g.speechLatencies.push(Number(ms));
      const t = (g.tasks[task] = g.tasks[task] || { calls: 0, ms: [], ct: 0, cached: 0, pt: 0 });
      t.calls++; t.ms.push(Number(ms)); t.ct += Number(ct); t.cached += Number(cached); t.pt += Number(pt);
      if (attempt && Number(attempt) > 1) g.retried++;
      if (/cheap|轻量/.test(tail || '') || (row.data && row.data.cheap)) g.cheap++;
    } else if (/校验失败|校验不通过|无法从回复中解析|预算/.test(msg)) {
      g.validationFailures++;
      g.warnings.push(msg.slice(0, 80));
    } else if (/对局结束/.test(msg)) {
      g.ended = msg.replace(/\s+/g, ' ').slice(0, 60);
    } else if (/配额|余额|暂停/.test(msg) && /warn|error/.test(String(row.level))) {
      g.warnings.push(msg.slice(0, 80));
    }
  }
  return g;
}

function summarize(games) {
  const live = games.filter((g) => g.calls > 0);
  const allLat = live.flatMap((g) => g.latencies);
  const speech = live.flatMap((g) => g.speechLatencies);
  const byTask = {};
  for (const g of live) {
    for (const [task, t] of Object.entries(g.tasks)) {
      const b = (byTask[task] = byTask[task] || { calls: 0, ms: [], pt: 0, cached: 0, ct: 0 });
      b.calls += t.calls; b.ms.push(...t.ms); b.pt += t.pt; b.cached += t.cached; b.ct += t.ct;
    }
  }
  return {
    games: live.length,
    callsPerGame: round(avg(live.map((g) => g.calls)), 1),
    maxCallsPerGame: live.reduce((a, g) => Math.max(a, g.calls), 0),
    promptTokensPerGame: Math.round(avg(live.map((g) => g.promptTokens))),
    completionTokensPerGame: Math.round(avg(live.map((g) => g.completionTokens))),
    cacheHitRate: allLat.length
      ? round(100 * live.reduce((a, g) => a + g.cachedTokens, 0) / Math.max(1, live.reduce((a, g) => a + g.promptTokens, 0)), 1)
      : 0,
    latency: { p50: pct(allLat, 50), p90: pct(allLat, 90), max: allLat.length ? Math.max(...allLat) : 0 },
    speechLatency: { n: speech.length, p50: pct(speech, 50), p90: pct(speech, 90), max: speech.length ? Math.max(...speech) : 0 },
    retriedCalls: live.reduce((a, g) => a + g.retried, 0),
    cheapSalvage: live.reduce((a, g) => a + g.cheap, 0),
    validationFailures: live.reduce((a, g) => a + g.validationFailures, 0),
    byTask,
    perGame: live,
  };
}

function toMarkdown(s, top) {
  const L = [];
  L.push('## 汇总');
  L.push('');
  L.push('| 指标 | 值 |');
  L.push('|---|---|');
  L.push(`| 真 API 对局数 | ${s.games} |`);
  L.push(`| 单局调用次数（平均 / 最大） | ${s.callsPerGame} / ${s.maxCallsPerGame} |`);
  L.push(`| 单局 prompt tokens | ${s.promptTokensPerGame} |`);
  L.push(`| 单局 completion tokens | ${s.completionTokensPerGame} |`);
  L.push(`| 缓存命中率 | ${s.cacheHitRate}% |`);
  L.push(`| 全部调用延迟 p50 / p90 / max | ${s.latency.p50} / ${s.latency.p90} / ${s.latency.max} ms |`);
  L.push(`| 发言类延迟 p50 / p90 / max（n=${s.speechLatency.n}） | ${s.speechLatency.p50} / ${s.speechLatency.p90} / ${s.speechLatency.max} ms |`);
  L.push(`| 重试调用（尝试>1） | ${s.retriedCalls} |`);
  L.push(`| 轻量补救（cheap） | ${s.cheapSalvage} |`);
  L.push(`| 校验失败/预算警告 | ${s.validationFailures} |`);
  L.push('');
  L.push('## 按任务');
  L.push('');
  L.push('| 任务 | 次数 | p50 | p90 | max | 平均 ct | 缓存命中 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const [task, t] of Object.entries(s.byTask).sort((a, b) => b[1].calls - a[1].calls)) {
    L.push(`| ${task} | ${t.calls} | ${pct(t.ms, 50)} | ${pct(t.ms, 90)} | ${Math.max(...t.ms)} | ${round(avg(t.ms) && t.ct / t.calls, 0)} | ${round((100 * t.cached) / Math.max(1, t.pt), 1)}% |`);
  }
  const list = top ? [...s.perGame].sort((a, b) => b.calls - a.calls).slice(0, top) : s.perGame;
  L.push('');
  L.push('## 逐局');
  L.push('');
  L.push('| 对局 | 调用 | pt | 缓存 | ct | 时长 | 发言 p90 | 结束原因 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const g of list) {
    const dur = g.startTs && g.endTs ? `${round((g.endTs - g.startTs) / 60000, 1)} 分钟` : '—';
    L.push(`| ${g.game.replace(/^game-|\.log$/g, '')} | ${g.calls} | ${g.promptTokens} | ${g.cachedTokens} | ${g.completionTokens} | ${dur} | ${pct(g.speechLatencies, 90)} | ${(g.ended || '—').slice(0, 40)} |`);
  }
  return L.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const files = fs.existsSync(args.dir)
    ? fs.readdirSync(args.dir).filter((f) => /^game-.*\.log$/.test(f)).map((f) => path.join(args.dir, f))
    : [];
  const games = files.map(parseGame).filter(Boolean);
  const s = summarize(games);
  if (args.json) {
    process.stdout.write(JSON.stringify({ dir: args.dir, files: files.length, ...s }, null, 2) + '\n');
    return;
  }
  process.stdout.write(`日志目录：${args.dir}（${files.length} 个文件，其中真 API 对局 ${s.games} 个）\n\n`);
  process.stdout.write(toMarkdown(s, args.top) + '\n');
}

main();
