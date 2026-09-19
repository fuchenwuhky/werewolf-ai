/**
 * annotations-model.js — 标注语义的浏览器端共享实现（NOTE-01）
 *
 * 与 src/annotations/store.js 的 Node 侧 normalizeSeatAnnotation 保持同一套白名单与默认值。
 * 两端（app.js / m.js）只处理布局，标注的合法性判断统一走这里。
 */
'use strict';
(function (global) {
  const LEANINGS = ['neutral', 'lean_good', 'lean_wolf', 'third_party', 'wolf', 'good'];
  const LEANING_CN = {
    neutral: '待观察', lean_good: '偏好好人', lean_wolf: '偏狼', third_party: '第三方可能', wolf: '狼', good: '好人',
  };
  const CONFIDENCE_CN = { low: '低', medium: '中', high: '高' };
  const MAX_CANDIDATES = 3;
  const MAX_NOTE = 200;

  function normalizeSeatAnnotation(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    out.leaning = LEANINGS.includes(raw.leaning) ? raw.leaning : 'neutral';
    out.candidateRoleIds = Array.isArray(raw.candidateRoleIds)
      ? [...new Set(raw.candidateRoleIds.filter((r) => typeof r === 'string' && /^[a-z_]{1,32}$/.test(r)))].slice(0, MAX_CANDIDATES)
      : [];
    out.claimedRoleId = typeof raw.claimedRoleId === 'string' && /^[a-z_]{1,32}$/.test(raw.claimedRoleId) ? raw.claimedRoleId : null;
    out.confidence = typeof raw.confidence === 'string' && CONFIDENCE_CN[raw.confidence] ? raw.confidence : 'low';
    out.note = typeof raw.note === 'string' ? raw.note.slice(0, MAX_NOTE) : '';
    out.evidenceSeq = Number.isInteger(raw.evidenceSeq) && raw.evidenceSeq > 0 ? raw.evidenceSeq : null;
    out.day = Number.isInteger(raw.day) && raw.day > 0 ? raw.day : null;
    out.phase = typeof raw.phase === 'string' && /^[a-z_]{1,16}$/.test(raw.phase) ? raw.phase : null;
    out.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 30) : null;
    return out;
  }

  /** 展示摘要：「偏狼 · 候选：狼人/狼王 · 高把握」（供座位角标/列表） */
  function summarize(a) {
    if (!a) return '';
    const parts = [];
    if (a.leaning && a.leaning !== 'neutral') parts.push(LEANING_CN[a.leaning] || a.leaning);
    if (a.confidence) parts.push(`${CONFIDENCE_CN[a.confidence] || ''}把握`);
    return parts.join(' · ');
  }

  /**
   * 旧版 {seat: roleId} 标注 → 新版存储的**逐座位合并**（NOTE-05，审核 P1-1 复验）。
   * 返回需要 PUT 的 fill = {seat: 规范化后的标注}；调用方 PUT 成功后才允许清理本地 key。
   * 规则：
   *   · 服务端没有的座位 → 由旧标记整条转换（候选 [roleId]，倾向按阵营，把握 low）。
   *   · 同座位冲突（服务端已有）→ 绝不覆盖：旧身份若未出现在服务端的候选/自称里，
   *     候选还有空位就并入候选；没空位就写进备注（「旧标记：X」）。双方信息都保留。
   *   · 旧身份已在服务端候选/自称里 → 该座位无需变更，不进 fill。
   *
   * @param serverSeats 服务端现有 {seat: 标注}（只读，不修改）
   * @param legacy      旧格式 {seat: roleId}
   * @param roleOf      (roleId) => {team, name} | null  角色信息查询
   */
  function mergeLegacyTags(serverSeats, legacy, roleOf) {
    const fill = {};
    for (const [seat, rid] of Object.entries(legacy || {})) {
      if (typeof rid !== 'string' || !rid) continue;
      const info = roleOf ? roleOf(rid) : null;
      const sv = serverSeats && serverSeats[seat];
      if (!sv) {
        // 新座位：整条转换
        fill[seat] = normalizeSeatAnnotation({
          candidateRoleIds: [rid],
          leaning: info && info.team === 'wolf' ? 'lean_wolf' : (info && info.team ? 'lean_good' : 'neutral'),
          confidence: 'low',
          note: '（旧版身份标记自动迁移）',
        });
        continue;
      }
      // 同座位冲突：旧身份是否已被服务端记录？
      const svCands = Array.isArray(sv.candidateRoleIds) ? sv.candidateRoleIds : [];
      const alreadyKnown = svCands.includes(rid) || sv.claimedRoleId === rid;
      if (alreadyKnown) continue; // 无新增信息，保留服务端原数据
      const merged = JSON.parse(JSON.stringify(sv));
      const tag = `旧标记：${(info && info.name) || rid}`;
      if (merged.note && merged.note.includes(tag)) continue; // 已并过（幂等：迁移重试不重复追加）
      if (svCands.length < MAX_CANDIDATES) {
        merged.candidateRoleIds = [...svCands, rid];
      } else {
        // 候选满：降级写进备注，信息不丢
        merged.note = merged.note ? `${merged.note}；${tag}` : tag;
      }
      if (!merged.note || !merged.note.includes('旧版身份标记')) {
        merged.note = merged.note ? `${merged.note}；（含旧版合并标注）` : '（含旧版合并标注）';
      }
      const norm = normalizeSeatAnnotation(merged);
      if (norm) fill[seat] = norm;
    }
    return fill;
  }

  const api = { LEANINGS, LEANING_CN, CONFIDENCE_CN, MAX_CANDIDATES, MAX_NOTE, normalizeSeatAnnotation, summarize, mergeLegacyTags };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WWAnnotationsModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
