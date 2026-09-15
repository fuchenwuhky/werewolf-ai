/**
 * metrics.js — 评测指标提取与聚合（纯函数，可独立测试）
 *
 * 设计原则：
 *  1. **只从事件流与玩家终局状态推导**，不依赖任何"为了评测而加"的埋点——
 *     这样同一套指标对 mock 局（随机策略基线）与真实 LLM 局都成立。
 *  2. 每项指标都带"随机基线"概念：mock 局的价值是**流程与平衡基线 + 回归门禁**，
 *     不是 AI 强弱；真实 AI 强弱要把 `--live` 的结果跟这里的随机基线对比才有意义。
 *  3. 判定口径全部写在注释里，避免"指标看着好看但口径说不清"。
 */
'use strict';
const { ROLES } = require('../../src/engine/roles');

/** 分位数（线性插值）；空数组返回 null */
function percentile(values, q) {
  const a = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  if (a.length === 1) return a[0];
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return a[lo];
  return Math.round(a[lo] + (a[hi] - a[lo]) * (pos - lo));
}

const teamOf = (role) => (ROLES[role] ? ROLES[role].team : null);

/** 事件流的便捷过滤 */
const ofType = (events, type) => events.filter((e) => e.type === type);

/**
 * 发言里的"悍跳/起跳"启发式识别。
 * 说明：结构化输出里没有"我要跳预言家"这个字段，这里只能按文本关键词近似。
 * 因此该指标标注为 heuristic —— 它适合看**趋势**，不适合当精确真值。
 */
const CLAIM_PATTERNS = [
  { kind: 'seer', re: /我(是|就是|确实是)(个)?预言家|我是真预言家|悍跳|起跳预言家|我查验了/ },
  { kind: 'witch', re: /我是女巫|我(是|就是)巫师/ },
  { kind: 'guard', re: /我是守卫/ },
  { kind: 'hunter', re: /我是猎人/ },
];
function detectClaims(events) {
  const out = [];
  for (const e of events) {
    if (!['speech', 'sheriff_speech', 'pk_speech', 'lastwords'].includes(e.type)) continue;
    const text = (e.data && e.data.text) || e.text || '';
    for (const p of CLAIM_PATTERNS) {
      if (p.re.test(text)) out.push({ seq: e.seq, actor: e.actor, kind: p.kind, day: e.day, text });
    }
  }
  return out;
}

/**
 * 死亡台账。
 * **权威来源是玩家对象上的 deathDay/deathCause**（settleDeath 记账，覆盖狼刀/毒/放逐/自爆/枪/决斗/殉情全类）。
 * 事件流里的 `deaths` 只包含夜间死亡，放逐与自爆的死因不在其中——早期版本只看事件流，
 * 结果把"被放逐"整个类别漏掉、还把被放逐者算成"活到最后"，指标因此失真。
 * 这里保留事件流作为回退（兼容旧存档）。
 */
function deathStats(game) {
  const deaths = [];
  const byCause = {};
  const survived = {};
  const hasLedger = game.players.some((p) => p.deathCause != null);
  if (hasLedger) {
    for (const p of game.players) {
      if (p.deathCause == null) { survived[p.seat] = game.day; continue; }
      deaths.push({ seat: p.seat, cause: p.deathCause, day: p.deathDay != null ? p.deathDay : game.day });
      byCause[p.deathCause] = (byCause[p.deathCause] || 0) + 1;
      survived[p.seat] = p.deathDay != null ? p.deathDay : game.day;
    }
  } else {
    for (const e of game.events) {
      if (e.type !== 'deaths') continue;
      for (const d of (e.data && e.data.deaths) || []) deaths.push({ seat: d.seat, cause: d.cause, day: e.day, phase: e.phase });
    }
    for (const d of deaths) byCause[d.cause] = (byCause[d.cause] || 0) + 1;
    for (const p of game.players) {
      const d = deaths.find((x) => x.seat === p.seat);
      survived[p.seat] = d ? d.day : game.day;
    }
  }
  return { deaths, byCause, survived, hasLedger };
}

/**
 * 投票统计。
 * - `hitWolfRate`：所有有效投票里，投中狼人的比例（随机基线 ≈ 场上狼数/存活数）
 * - `goodHitWolfRate`：只看好人阵营的票（狼投狼是战术，会污染"准确性"口径）
 * - `abstain`：弃票数
 */
function voteStats(game, wolfSeats) {
  const isWolf = new Set(wolfSeats);
  let cast = 0;
  let abstain = 0;
  let hit = 0;
  let goodCast = 0;
  let goodHit = 0;
  for (const e of game.events) {
    if (!['vote_cast', 'pk_vote_cast', 'sheriff_vote_cast'].includes(e.type)) continue;
    const target = e.data ? e.data.target : null;
    if (!target) { abstain++; continue; }
    cast++;
    const actor = game.player(e.actor);
    const actorIsWolf = actor && isWolf.has(e.actor);
    if (isWolf.has(target)) {
      hit++;
      if (!actorIsWolf) goodHit++;
    }
    if (!actorIsWolf) goodCast++;
  }
  // 随机基线：每次投票命中狼的概率 ≈ 当前存活狼数 / 可投席位（用终局近似，仅作参照）
  const alive = game.players.filter((p) => p.alive).length || game.players.length;
  const chanceBaseline = alive ? wolfSeats.filter((s) => {
    const p = game.player(s);
    return p && p.alive;
  }).length / Math.max(1, alive - 1) : 0;
  const r3 = (x) => (x == null ? null : Number(x.toFixed(3)));
  return {
    cast, abstain, hit, goodCast, goodHit,
    hitWolfRate: r3(cast ? hit / cast : null),
    goodHitWolfRate: r3(goodCast ? goodHit / goodCast : null),
    chanceBaseline: Number(chanceBaseline.toFixed(3)),
  };
}

/** 预言家查验统计：命中狼的比例（真预言家的信息质量） */
function seerStats(game, wolfSeats) {
  const isWolf = new Set(wolfSeats);
  const checks = [];
  for (const e of game.events) {
    if (e.type !== 'seer_check') continue;
    const target = e.data ? e.data.target : null;
    const actor = game.player(e.actor);
    checks.push({ day: e.day, actor: e.actor, target, isWolf: isWolf.has(target), actorRole: actor ? actor.role : null });
  }
  // 只统计真预言家的查验（假跳不会有 seer_check 事件，所以这里天然是真预言家）
  const hits = checks.filter((c) => c.isWolf).length;
  return { count: checks.length, hits, hitRate: checks.length ? Number((hits / checks.length).toFixed(3)) : null, checks };
}

/**
 * 悍跳成功率（启发式）：
 * 狼人跳预言家后，是否活过了"跳的那一天"（潜台词：骗住了票、没被当场投出去）。
 * `deathInfo` 传 deathStats 的结果以复用权威台账（旧存档则回退事件流）。
 */
function fakeClaimStats(game, claimList, deathInfo = null) {
  const info = deathInfo || deathStats(game);
  const wolfSeats = game.wolves().map((p) => p.seat);
  const isWolf = new Set(wolfSeats);
  const deathDay = {};
  if (info.hasLedger) {
    for (const p of game.players) if (p.deathCause != null) deathDay[p.seat] = p.deathDay != null ? p.deathDay : game.day;
  } else {
    for (const d of info.deaths) deathDay[d.seat] = d.day;
  }
  const out = { wolfClaims: 0, goodClaims: 0, wolfSeerClaims: 0, wolfSeerClaimSurvived: 0 };
  for (const c of claimList) {
    if (isWolf.has(c.actor)) {
      out.wolfClaims++;
      if (c.kind === 'seer') {
        out.wolfSeerClaims++;
        const died = deathDay[c.actor];
        if (died == null || died > c.day) out.wolfSeerClaimSurvived++;
      }
    } else {
      out.goodClaims++;
    }
  }
  out.wolfSeerClaimSurvivalRate = out.wolfSeerClaims ? out.wolfSeerClaimSurvived / out.wolfSeerClaims : null;
  return out;
}

/** 按角色聚合存活天数与出局率 */
function byRoleStats(game, survived) {
  const acc = {};
  for (const p of game.players) {
    const r = p.role || 'unknown';
    if (!acc[r]) acc[r] = { n: 0, team: teamOf(p.role), survivedSum: 0, died: 0 };
    acc[r].n++;
    acc[r].survivedSum += survived[p.seat] || 0;
    if (!p.alive) acc[r].died++;
  }
  for (const r of Object.keys(acc)) {
    acc[r].avgSurvived = Number((acc[r].survivedSum / acc[r].n).toFixed(2));
    acc[r].deathRate = Number((acc[r].died / acc[r].n).toFixed(3));
  }
  return acc;
}

/**
 * 单局指标。`audit` 可选（scripts/mock-agent 的 auditIsolation 结果）。
 * 注意：mock 局没有 LLM 调用，token/延迟类指标为 null。
 */
function extractGameMetrics(game, opts = {}) {
  const wolfSeats = game.wolves().map((p) => p.seat);
  const { deaths, byCause, survived } = deathStats(game);
  const claims = detectClaims(game.events);
  const stats = game.llmStats || {};
  const votes = voteStats(game, wolfSeats);
  const seer = seerStats(game, wolfSeats);
  const fake = fakeClaimStats(game, claims, { deaths, byCause, survived });
  const teams = { good: 0, wolf: 0 };
  for (const p of game.players) {
    const t = teamOf(p.role);
    if (t) teams[t]++;
  }
  return {
    id: game.id,
    seed: opts.seed != null ? opts.seed : null,
    board: opts.board || null,
    config: opts.config || 'default',
    winner: game.winner,
    days: game.day,
    finished: !!game.finished,
    players: game.players.length,
    teams,
    votes,
    seer,
    fakeClaim: fake,
    claimCount: claims.length,
    deaths: deaths.length,
    deathsByCause: byCause,
    explodes: ofType(game.events, 'explode').length,
    duels: ofType(game.events, 'duel').length,
    sheriffElected: ofType(game.events, 'sheriff_elected').length > 0,
    badgePasses: ofType(game.events, 'badge_pass').length,
    survival: survived,
    byRole: byRoleStats(game, survived),
    avgSurvived: Number((Object.values(survived).reduce((a, b) => a + b, 0) / Math.max(1, game.players.length)).toFixed(2)),
    events: game.events.length,
    llm: {
      calls: stats.calls || 0,
      promptTokens: stats.promptTokens || 0,
      completionTokens: stats.completionTokens || 0,
      cachedTokens: stats.cachedTokens || 0,
      errors: stats.errors || 0,
      journalHits: stats.journalHits || 0,
      journalSavedTokens: stats.journalSavedTokens || 0,
      latencyP50: percentile(stats.latencies || [], 0.5),
      latencyP90: percentile(stats.latencies || [], 0.9),
      latencyP99: percentile(stats.latencies || [], 0.99),
      latencyMax: stats.latencyMsMax || null,
    },
    isolationProblems: opts.audit || [],
  };
}

/** 聚合多局：既给总体，也给分角色/分配置 */
function aggregate(games) {
  const n = games.length || 1;
  const wins = { good: 0, wolf: 0, other: 0 };
  let daysSum = 0;
  let votesCast = 0;
  let votesHit = 0;
  let goodCast = 0;
  let goodHit = 0;
  let seerChecks = 0;
  let seerHits = 0;
  let wolfSeerClaims = 0;
  let wolfSeerSurvived = 0;
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let isolation = 0;
  const latencies = [];
  const deathCauses = {};
  const byRole = {};
  for (const g of games) {
    if (g.winner === 'good') wins.good++;
    else if (g.winner === 'wolf') wins.wolf++;
    else wins.other++;
    daysSum += g.days;
    votesCast += g.votes.cast;
    votesHit += g.votes.hit;
    goodCast += g.votes.goodCast;
    goodHit += g.votes.goodHit;
    seerChecks += g.seer.count;
    seerHits += g.seer.hits;
    wolfSeerClaims += g.fakeClaim.wolfSeerClaims;
    wolfSeerSurvived += g.fakeClaim.wolfSeerClaimSurvived;
    calls += g.llm.calls;
    promptTokens += g.llm.promptTokens;
    completionTokens += g.llm.completionTokens;
    cachedTokens += g.llm.cachedTokens;
    isolation += g.isolationProblems.length;
    if (g.llm.latencyP90 != null) latencies.push(g.llm.latencyP90);
    for (const [c, v] of Object.entries(g.deathsByCause)) deathCauses[c] = (deathCauses[c] || 0) + v;
    for (const [r, v] of Object.entries(g.byRole)) {
      if (!byRole[r]) byRole[r] = { n: 0, team: v.team, survivedSum: 0, died: 0 };
      byRole[r].n += v.n;
      byRole[r].survivedSum += v.survivedSum;
      byRole[r].died += v.died;
    }
  }
  for (const r of Object.keys(byRole)) {
    byRole[r].avgSurvived = Number((byRole[r].survivedSum / byRole[r].n).toFixed(2));
    byRole[r].deathRate = Number((byRole[r].died / byRole[r].n).toFixed(3));
  }
  const r3 = (x) => (x == null ? null : Number(x.toFixed(3)));
  return {
    games: games.length,
    winRate: { good: r3(wins.good / n), wolf: r3(wins.wolf / n), other: r3(wins.other / n) },
    wins,
    avgDays: Number((daysSum / n).toFixed(2)),
    vote: {
      cast: votesCast,
      perGame: Number((votesCast / n).toFixed(2)),
      hitWolfRate: votesCast ? r3(votesHit / votesCast) : null,
      goodHitWolfRate: goodCast ? r3(goodHit / goodCast) : null,
    },
    seer: { checks: seerChecks, perGame: Number((seerChecks / n).toFixed(2)), hitRate: seerChecks ? r3(seerHits / seerChecks) : null },
    fakeClaim: {
      wolfSeerClaims,
      perGame: Number((wolfSeerClaims / n).toFixed(2)),
      survivalRate: wolfSeerClaims ? r3(wolfSeerSurvived / wolfSeerClaims) : null,
    },
    cost: {
      calls, callsPerGame: Number((calls / n).toFixed(1)),
      promptTokens, completionTokens, cachedTokens,
      tokensPerGame: Math.round((promptTokens + completionTokens) / n),
      cachedRatio: promptTokens ? r3(cachedTokens / promptTokens) : null,
    },
    latency: {
      p50: percentile(latencies, 0.5),
      p90: percentile(latencies, 0.9),
      max: latencies.length ? Math.max(...latencies) : null,
      note: '对每局的 p90 再取分位；空值表示本批没有真实 LLM 调用（mock 局）',
    },
    deathCauses,
    byRole,
    isolationProblems: isolation,
  };
}

/**
 * 与基线对比的容差表。
 * **必须显式区分两种量纲**（早期版本只用一个数字，结果 `avgDays ±15%` 被当成 `±0.15 天`，
 * `latency.p90 ±25%` 被当成 `±0.25ms`——门禁因此形同虚设）：
 *   · abs  —— 比率类指标（0~1），用绝对百分点
 *   · rel  —— 计数/时长类指标，用相对百分比
 *   · zero —— 零容忍（隔离泄漏）
 */
const DEFAULT_TOLERANCES = {
  'winRate.good': { abs: 0.12 },
  'winRate.wolf': { abs: 0.12 },
  avgDays: { rel: 0.15 },
  'vote.hitWolfRate': { abs: 0.10 },
  'vote.goodHitWolfRate': { abs: 0.10 },
  'seer.hitRate': { abs: 0.12 },
  'fakeClaim.perGame': { rel: 0.5 },
  'cost.callsPerGame': { rel: 0.15 },
  'latency.p90': { rel: 0.25 },
  isolationProblems: { zero: true },
};

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function compareBaseline(current, baseline, tolerances = DEFAULT_TOLERANCES) {
  const diffs = [];
  for (const [path, tol] of Object.entries(tolerances)) {
    const a = getPath(current, path);
    const b = getPath(baseline, path);
    if (a == null || b == null) continue;
    const delta = a - b;
    let ok;
    if (tol.zero) ok = a <= 0;
    else if (tol.abs != null) ok = Math.abs(delta) <= tol.abs;
    else ok = Math.abs(delta) / Math.max(1e-9, Math.abs(b)) <= tol.rel;
    diffs.push({ path, baseline: b, current: a, delta: Number(delta.toFixed(4)), tol, ok });
  }
  return { ok: diffs.every((d) => d.ok), diffs };
}

module.exports = {
  percentile, detectClaims, deathStats, voteStats, seerStats, fakeClaimStats,
  byRoleStats, extractGameMetrics, aggregate, compareBaseline, DEFAULT_TOLERANCES, teamOf,
};
