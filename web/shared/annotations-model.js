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
    out.confidence = CONFIDENCE_CN(raw.confidence) === undefined && typeof raw.confidence === 'string' && CONFIDENCE_CN[raw.confidence] ? raw.confidence : (CONFIDENCE_CN[raw.confidence] ? raw.confidence : 'low');
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

  const api = { LEANINGS, LEANING_CN, CONFIDENCE_CN, MAX_CANDIDATES, MAX_NOTE, normalizeSeatAnnotation, summarize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WWAnnotationsModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
