/**
 * pace-bench.js — 用**真实调用日志**回放，回答两个关于"对局丝滑度"的问题。
 *
 * 数据来源：logs/game-*.log 里 llm 模块的 "ok …pt(缓存…)…ct …ms 尝试…" 行
 * （每次真实调用都记了 prompt/completion tokens 与耗时）。无 Key 也能跑。
 *
 * 回答的两个问题：
 *   ① 切"节奏档位"（快速局/标准局/深度局）到底能省多少延迟？
 *   ② 多 Key 并行的**天花板**是多少？（把调用按"语义串行 / 可并行"分类后算 N 通道墙钟）
 *
 * 方法（与 scripts/effort-replay.js 一致，便于互相印证）：
 *   · 记录的耗时按"flat 策略下的 effort"分成 low / high 两个池子；
 *   · 目标档位的 effort 与记录不同时，用**秩保持分位映射**换算（一次调用在难度序上的位置不变，
 *     但耗时分布按目标档位的实测分布压缩）；
 *   · 这是**投影**不是实测：真实数字要用真 Key 跑（logs 只覆盖当时的配置）。
 *
 * ⚠️ 并行模型是**上界**：假设互不依赖的调用能 100% 重叠，且忽略调度、限流与上下文构造开销。
 */

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const effort = require('../src/ai/effort');
const { FAST_TASKS } = require('../src/ai/context');
const { PACES } = require('../src/config');

const ROOT = path.join(__dirname, '..');
const DIR = process.env.WW_LOG_DIR || path.join(ROOT, 'logs');

const RE_LINE = /^d(\d+)\/(\S+) (\S+)(?: vis=([^|]+))?/;
const RE_LLM = /ok (\d+)pt\(缓存(\d+)\)\/(\d+)ct (\d+)ms 尝试(\d+)/;

/** 语义上**必须按顺序**发生的调用（并行化会改变游戏，别碰） */
const SERIAL_TASKS = new Set([
  'speech', 'sheriff_speech', 'pk_speech', 'lastwords',   // 发言链：必须听到前面所有人
  'wolf_chat', 'wolf_propose', 'wolf_say',                // 狼队讨论：队内顺序发言
  'witch',                                                // 女巫必须等狼刀结果（引擎里唯一一条夜内依赖）
  'explode_check', 'duel_check', 'direction',             // 嵌在发言链里的即时询问
  'badge_pass', 'shoot',                                  // 单人一次性裁决
]);
/** 语义上互不依赖、只因单 Key 被迫串行的调用（引擎已按同一张依赖图扇出） */
const PARALLEL_TASKS = new Set([
  'vote', 'pk_vote', 'sheriff_vote',                      // 票互相保密且互不依赖
  // 上警报名与狼队投刀：引擎已改成"先问完所有人、再按座位统一公布"（真实规则就是同时举手/同时指刀），
  // 所以每个人都处于"盲选"状态 —— 调用彼此独立，可以并行。
  'sheriff_run', 'wolf_kill',
  'night_guard', 'seer_check', 'night_dream', 'crow_curse',
  'wolfbeauty_charm', 'admirer_crush',                    // 夜晚各步：选完才统一结算
]);
/** 后台任务（低优先级排队偷跑） */
const isBackground = (task) => /反思|复盘|lessons|reflect/.test(task);

const pct = (arr, p) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : null);
const fmt = (ms) => (ms == null ? '-' : ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms');
const sum = (a) => a.reduce((x, y) => x + y, 0);

// ---------- 1. 读日志，重建每次调用的局面特征 ----------
function visibleTo(ev, seat) {
  if (ev.vis === 'all') return true;
  return ev.vis.split(',').map(Number).includes(seat);
}

function loadGames(dir) {
  const games = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('game-') && x.endsWith('.log'))) {
    const rows = [];
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) {
      if (!line || line[0] !== '{') continue;
      let j;
      try { j = JSON.parse(line); } catch (_) { continue; }
      if (j.module === 'engine') {
        const m = RE_LINE.exec(j.msg || '');
        if (m) rows.push({ kind: 'ev', seq: j.seq, day: +m[1], type: m[3], vis: m[4] ? m[4].trim() : 'all', data: j.data || {} });
      } else if (j.module === 'llm' && j.data && j.data.task) {
        const m = RE_LLM.exec(j.msg || '');
        if (m) rows.push({ kind: 'llm', seq: j.seq, seat: j.data.seat, task: j.data.task, pt: +m[1], ct: +m[3], ms: +m[4] });
      }
    }
    if (rows.some((r) => r.kind === 'llm')) games.push({ file: f, rows: rows.sort((a, b) => a.seq - b.seq) });
  }
  return games;
}

/** 为每次调用重建特征（day / alive / decisive / speechIndex），与 effort-replay 同法 */
function buildCalls(games) {
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
      const prevSeq = lastCallSeq.get(r.seat) || 0;
      let decisive = 0;
      for (const e of g.rows) {
        if (e.kind !== 'ev' || e.seq <= prevSeq || e.seq >= r.seq) continue;
        if (!visibleTo(e, r.seat)) continue;
        if (!effort.CHATTER_TYPES.has(e.type)) decisive++;
      }
      calls.push({
        ...r, game: g.file, decisive, day, alive: Math.max(1, alive),
        speechIndex: seenSpeechPerDay.get(`${day}`) || 0,
        // flat 策略（= 记录当时的分层方式）给出的 effort：用于把记录耗时分成两个池子
        recordedEffort: FAST_TASKS.has(r.task) ? 'low' : 'high',
        klass: isBackground(r.task) ? 'background' : SERIAL_TASKS.has(r.task) ? 'serial' : PARALLEL_TASKS.has(r.task) ? 'parallel' : 'serial',
      });
      lastCallSeq.set(r.seat, r.seq);
    }
  }
  return calls;
}

// ---------- 2. 秩保持分位映射：把记录耗时换算到目标 effort ----------
function makeProjector(calls) {
  const pool = { low: [], high: [] };
  for (const c of calls) (pool[c.recordedEffort] || (pool[c.recordedEffort] = [])).push(c.ms);
  pool.low.sort((a, b) => a - b);
  pool.high.sort((a, b) => a - b);
  const quantileOf = (sorted, v) => {
    let i = 0;
    while (i < sorted.length && sorted[i] <= v) i++;
    return sorted.length ? i / sorted.length : 0;
  };
  const atQuantile = (sorted, q) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(q * sorted.length)))];
  const fn = (ms, from, to) => {
    const a = pool[from];
    const b = pool[to];
    // 目标档位的 effort 可能**在日志里没有任何样本**（例如后来引入的 medium）：
    // 原来直接读 pool[to].length 会抛 TypeError 把整个工具崩掉（实测就崩在这）。
    // 做不了秩映射时原样返回记录耗时，并把"未投影"次数暴露给上层，让表格如实标注而不是假装投影过。
    if (from === to || !a || !a.length || !b || !b.length) {
      if (from !== to) fn.missCount++;
      return ms;
    }
    return atQuantile(b, quantileOf(a, ms));
  };
  fn.missCount = 0;
  return fn;
}

/** 某档位下每次调用的目标 effort（走真实的 effort.planEffort 分支，不另抄一份规则） */
function targetEffort(pace, call) {
  const cfg = { ...PACES[pace].values, maxTokens: 16000, fastMaxTokens: 8000 };
  if (cfg.effortPolicy === 'flat') {
    return effort.flatBudget(call.task, cfg).effort;
  }
  const tier = effort.planTier(call.task, { task: call.task, decisive: call.decisive, day: call.day, alive: call.alive, speechIndex: call.speechIndex }).tier;
  return effort.resolveBudget(tier, cfg).effort;
}

// ---------- 3. 报告 ----------
function main() {
  if (!fs.existsSync(DIR)) {
    console.error(`找不到日志目录 ${DIR}；用 WW_LOG_DIR 指定，或先跑几局真实对局。`);
    process.exit(1);
  }
  const games = loadGames(DIR);
  if (!games.length) {
    console.error('日志里没有真实调用记录（llm 模块的 "ok …pt…ct …ms 尝试N" 行）。');
    process.exit(1);
  }
  const calls = buildCalls(games);
  const project = makeProjector(calls);
  const totalMin = sum(calls.map((c) => c.ms)) / 60000;
  console.log(`样本：${games.length} 局 / ${calls.length} 次真实调用 / 串行累加 ${totalMin.toFixed(1)} 分钟（平均 ${(totalMin / games.length).toFixed(1)} 分钟每局）`);
  console.log('说明：这是**回放投影**，不是新实测；并行墙钟是上界（假设 100% 重叠）。\n');

  // ---- 3.1 语义分类占比（决定并行天花板） ----
  const share = {};
  for (const c of calls) share[c.klass] = (share[c.klass] || 0) + c.ms;
  const tot = sum(calls.map((c) => c.ms));
  console.log('=== 调用按"能否并行"分类（记录当时的真实耗时占比）===');
  for (const k of ['serial', 'parallel', 'background']) {
    const v = share[k] || 0;
    const label = { serial: '语义串行（并行会改变游戏）', parallel: '可并行（只因单 Key 被串行）', background: '后台（抢跑/复盘）' }[k];
    console.log(`  ${label.padEnd(22)} ${(100 * v / tot).toFixed(1).padStart(5)}%   ${fmt(v)}`);
  }

  // ---- 3.2 三档节奏对比 ----
  console.log('\n=== 节奏档位对比（同一批调用回放）===');
  const speechTasks = /^(speech|sheriff_speech|pk_speech|lastwords)$/;
  console.log('  档位'.padEnd(12) + '全部总耗时'.padStart(12) + '发言 p50'.padStart(11) + '发言 p90'.padStart(11) + '>60s 占比'.padStart(11));
  const byPace = {};
  for (const pace of ['fast', 'standard', 'deep']) {
    let unprojected = 0;
    const ms = calls.map((c) => {
      const before = project.missCount;
      const v = project(c.ms, c.recordedEffort, targetEffort(pace, c));
      if (project.missCount > before) unprojected++;
      return v;
    });
    const sp = calls.map((c, i) => (speechTasks.test(c.task) ? ms[i] : null)).filter((x) => x != null);
    byPace[pace] = ms;
    const slow = (100 * sp.filter((x) => x > 60000).length) / sp.length;
    const note = unprojected ? `   ⚠ ${unprojected} 次未能投影（该档 effort 在本批日志里无样本，已原样计入）` : '';
    console.log(
      `  ${(PACES[pace].label + '（' + pace + '）').padEnd(18)}${fmt(sum(ms)).padStart(10)}${fmt(pct(sp, 50)).padStart(11)}${fmt(pct(sp, 90)).padStart(11)}${slow.toFixed(1).padStart(10)}%${note}`
    );
  }
  const spNow = calls.map((c, i) => (speechTasks.test(c.task) ? byPace.standard[i] : null)).filter((x) => x != null);
  console.log(`\n  记录当时的基线（flat 策略）：发言 p50 ${fmt(pct(calls.filter((c) => speechTasks.test(c.task)).map((c) => c.ms), 50))} / p90 ${fmt(pct(calls.filter((c) => speechTasks.test(c.task)).map((c) => c.ms), 90))}`);
  console.log(`  当前默认（标准局）投影：     发言 p50 ${fmt(pct(spNow, 50))} / p90 ${fmt(pct(spNow, 90))}`);

  // ---- 3.3 通道数 → 每局墙钟 ----
  console.log('\n=== 每局 LLM 墙钟（上界模型：串行不变，可并行部分 ÷ 通道数）===');
  const perGame = new Map();
  calls.forEach((c, i) => {
    if (!perGame.has(c.game)) perGame.set(c.game, { serial: 0, par: 0, n: 0 });
    const e = perGame.get(c.game);
    if (c.klass === 'parallel') e.par += byPace.standard[i];
    else e.serial += byPace.standard[i];
    e.n++;
  });
  const serialAll = sum([...perGame.values()].map((e) => e.serial));
  const parAll = sum([...perGame.values()].map((e) => e.par));
  const parShareNow = parAll / (serialAll + parAll);
  console.log(`  当前默认档位下：语义串行 ${(100 * (1 - parShareNow)).toFixed(1)}% / 可并行 ${(100 * parShareNow).toFixed(1)}%`);
  console.log('  通道数'.padEnd(10) + '每局墙钟'.padStart(12) + '相对 1 通道'.padStart(14) + '（保守：只算一半收益）'.padStart(18));
  for (const ch of [1, 2, 4]) {
    const wc = (serialAll + parAll / ch) / games.length;
    const cons = (serialAll + parAll - ((parAll - parAll / ch) * 0.5)) / games.length;
    console.log(`  ${String(ch).padEnd(10)}${fmt(wc).padStart(12)}${(100 * (1 - wc / ((serialAll + parAll) / games.length))).toFixed(1).padStart(13)}%${fmt(cons).padStart(18)}`);
  }

  // ---- 3.4 结论 ----
  const std = sum(byPace.standard);
  const fast = sum(byPace.fast);
  const deep = sum(byPace.deep);
  console.log('\n=== 结论 ===');
  console.log(`  · 快速局相对标准局：${fmt(std)} → ${fmt(fast)}（省 ${(100 * (1 - fast / std)).toFixed(1)}%）—— info 策略已把绝大多数调用降到 low，再切档收益有限`);
  console.log(`  · 深度局相对标准局：${fmt(std)} → ${fmt(deep)}（+${(100 * (deep / std - 1)).toFixed(1)}%）—— 除非要极限棋力，否则别用`);
  console.log(`  · 并行天花板：可并行只占 ${(100 * parShareNow).toFixed(1)}%，4 通道最多省 ${(100 * parShareNow * 0.75).toFixed(1)}% —— 多 Key 解决不了"发言链"`);
  console.log('  · 发言类单次 p50 就是几十秒 —— 想"丝滑"，要么压单次发言（思考预算/输出长度/换快模型），要么让等待可见（私密阶段的进度反馈）');
}

if (require.main === module) main();
module.exports = { loadGames, buildCalls, makeProjector, targetEffort, SERIAL_TASKS, PARALLEL_TASKS };
