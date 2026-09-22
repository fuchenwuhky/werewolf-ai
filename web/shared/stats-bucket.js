/**
 * stats-bucket.js — 战绩分桶与胜率的**纯函数**（计划书 §5.3）
 *
 * 计划书原文：「展示正式局**胜、负、平／不可判定**，以及**试玩、观战、终止**分桶。
 * **胜率分母为有效胜负局**，分母为零显示"**暂无**"。」「本轮不增加段位、排行榜、成就和趋势图。」
 *
 * ── 口径必须与服务端一致（`src/api.js#profileStats`，M2-b 已实现）────────────────
 *   桶判定优先级：`mock`（试玩，doc.mock 为真）→ `spectate`（没有人类玩家）→
 *                `terminated`（winReason 里含「终止」）→ `real`（正式局）；
 *   正式局再按「本人最终阵营 vs 胜方」判：只有**阵营可判定**且 winner ∈ {wolf, good}
 *   的局才进胜负；其余（平局、阵营不可判定）算作「平／不可判定」。
 *   所以胜率分母 = wins + losses，**不含**平局与不可判定局；分母为 0 ⇒ 显示「暂无」。
 *   旧公式把 `winner !== 'wolf'` 的平局判给好人阵营（出现"胜1 负-1"），这里不再重犯。
 *
 * 本模块**只做**上面这些：没有段位、排行榜、成就、趋势图（`:203` 明文禁）。
 * 两端的展示文案也收在这里（`formatAggregate`），避免"桌面端显示暂无、手机端显示 0%"这种分叉。
 */

'use strict';
(function (global) {
  /** 桶的固定顺序（界面按这个顺序展示，不按对象键顺序碰运气） */
  const BUCKETS = ['real', 'mock', 'spectate', 'terminated'];

  /** 一局的桶归属（与 src/api.js#profileStats 逐字同口径） */
  function bucketOf(row) {
    const r = row || {};
    if (r.mock) return 'mock';
    if (r.spectate === true) return 'spectate';
    if (r.terminated === true || /终止/.test(String(r.winReason || ''))) return 'terminated';
    return 'real';
  }

  /** 本人最终阵营（'wolf' | 'good' | null=不可判定）；服务端已按暗恋者等动态阵营算好 */
  function factionOf(row) {
    const f = (row || {}).faction;
    return f === 'wolf' || f === 'good' ? f : null;
  }

  /** 是否属于"有效胜负局"：正式局 + 已结束 + 阵营可判定 + winner 明确是某一方 */
  function isJudged(row) {
    const r = row || {};
    if (bucketOf(r) !== 'real' || !r.finished) return false;
    return !!factionOf(r) && (r.winner === 'wolf' || r.winner === 'good');
  }

  /**
   * 统计一批对局摘要。
   * @param rows 每项可含 { mock, spectate, terminated, winReason, faction, winner, finished }
   * @returns {{
   *   total:number, buckets:object,
   *   formal:{ total:number, wins:number, losses:number, draws:number, undecided:number, decided:number },
   *   rate:(number|null), rateText:string
   * }}
   *   `formal.draws` = 已结束的正式局里 winner 为平（draw/none）；
   *   `formal.undecided` = 已结束的正式局里阵营可判性缺失；
   *   两者合起来就是服务端 `draws` 的口径（"平／不可判定"合并展示）。
   */
  function summarize(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const buckets = { real: 0, mock: 0, spectate: 0, terminated: 0 };
    let wins = 0;
    let losses = 0;
    let draws = 0;
    let undecided = 0;
    for (const row of list) {
      const b = bucketOf(row);
      buckets[b] = (buckets[b] || 0) + 1;
      if (b !== 'real' || !(row || {}).finished) continue;
      if (isJudged(row)) {
        const win = (factionOf(row) === 'wolf') === (row.winner === 'wolf');
        if (win) wins++; else losses++;
        continue;
      }
      const w = (row || {}).winner;
      if (w === 'draw' || w === 'none') draws++;
      else undecided++;
    }
    const decided = wins + losses;
    const rate = decided > 0 ? wins / decided : null;
    return {
      total: list.length,
      buckets,
      formal: {
        total: buckets.real,
        wins, losses, draws, undecided, decided,
      },
      rate,
      rateText: rateText(rate, decided),
    };
  }

  /** 胜率文案：分母（有效胜负局）为 0 ⇒「暂无」（§5.3 明文） */
  function rateText(rate, decided) {
    const n = Number(decided || 0);
    if (!n || rate === null || rate === undefined || !Number.isFinite(Number(rate))) return '暂无';
    return `${Math.round(Number(rate) * 100)}%`;
  }

  /**
   * 把服务端 `/api/profiles/:id/stats` 的聚合结果渲染成一行文案（两端共用同一份，避免分叉）。
   * @param agg 服务端返回：{ total, real, wins, losses, draws, byBucket:{mock,spectate,terminated} }
   */
  function formatAggregate(agg) {
    const s = agg || {};
    const b = s.byBucket || {};
    const wins = Number(s.wins || 0);
    const losses = Number(s.losses || 0);
    const decided = wins + losses;
    const rate = decided > 0 ? wins / decided : null;
    const draws = Number(s.draws || 0);
    return `真实对局 ${Number(s.real || 0)} 局（胜率分母 ${decided} 局）· ${wins} 胜 ${losses} 负`
      + `${draws ? ` ${draws} 平/不可判定` : ''} · 胜率 ${rateText(rate, decided)}`
      + ` · 试玩 ${Number(b.mock || 0)} · 观战 ${Number(b.spectate || 0)}`
      + ` · 终止 ${Number(b.terminated || 0)} · 存档合计 ${Number(s.total || 0)}`;
  }

  /** 桶的中文名（两端展示同一套词） */
  const BUCKET_CN = { real: '正式局', mock: '试玩', spectate: '观战', terminated: '终止' };

  const api = { BUCKETS, BUCKET_CN, bucketOf, factionOf, isJudged, summarize, rateText, formatAggregate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WWStatsBucket = api;
})(typeof window !== 'undefined' ? window : globalThis);
