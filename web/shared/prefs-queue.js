/**
 * prefs-queue.js — 档案偏好写入的 **串行队列 + 连续修改合并 + 409 恢复**（计划书 §5.3）
 *
 * 计划书原文（§5.3）：
 *   · 「同一档案的偏好写入**串行化**，合并尚未发送的连续修改。」
 *   · 「**409 后重读服务端版本**：无冲突字段合并后重试一次；同字段冲突保留草稿并由用户选择。」
 *   · 「请求完成时若已切档，**只更新原档案缓存，不改变当前页面**。」
 *
 * 这个模块只负责前两条（第三条由调用方用 `web/shared/request-guard.js` 的票据判定，
 * 队列把每次结果连同 `profileId` 一起交回，调用方据此决定"写哪份缓存、画不画当前页面"）。
 *
 * ── 为什么必须是纯模块 ────────────────────────────────────────────────────────
 * 这是典型的"只有并发才暴露"的逻辑：连点三次开关、另一窗口同时改同一档案、网络丢响应——
 * 在真实浏览器里没法稳定复现，也没有人会手工点着测。所以引擎只依赖注入进来的三个函数：
 *   cfg.patch(profileId, preferences, ctx) → Promise<{ profile }>
 *   cfg.reload(profileId)                 → Promise<profile>   （重读服务端最新版本）
 *   cfg.revisionOf(profileId) / cfg.baseOf(profileId)  ← 可省：队列的起点快照
 * 单测里注入假的 patch/reload 就能精确断言"发了几次、发了什么、草稿还在不在"。
 *
 * ── 逐条对应（每条都有用例，见 test/m2d-prefs-queue.test.js）────────────────────
 *   · 串行：同一档案同一时刻只有一次在途请求（下一个批次必须等上一个批次 settle）；
 *   · 合并：同一轮同步提交的多次改动先并成一个批次再发（微任务合并窗口）；
 *   · 409：重读服务端版本 → 只把**无冲突字段**合并上去重试**一次**；
 *   · 二次 409 / 重读失败：不再重试，冲突字段留在 `outcome.draft` 里（草稿不丢）交回调用方；
 *   · 不同档案各自一条队列，互不阻塞（A 慢请求不挡 B 的保存）。
 *
 * ── 冲突判据（"同字段冲突"的唯一定义）────────────────────────────────────────
 * 以「本端这次改动**所基于的**服务端偏好」为 `base`，以「重读回来的最新偏好」为 `server`：
 *   只有「服务端这一字段相对 base 变了」**且**「本端也改了同一字段」**且**「两边值不同」
 *   才算同字段冲突；服务端值恰好等于本端想写的值（另一边也改成了同一个值）不算冲突。
 * 所以判据需要 base —— 调用方用 `baseOf` 提供（通常是"上次成功保存后内存里的 preferences"）。
 */

'use strict';
(function (global) {
  /** 值相等判定：对象走 JSON 比较（偏好只有标量/短对象，序列化语义足够且可预测） */
  function sameValue(a, b) {
    if (a === b) return true;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; }
    }
    return false;
  }

  /** 合并两次改动：后者覆盖同名字段（"合并尚未发送的连续修改"就是这一行） */
  function mergeChanges(prev, next) {
    return Object.assign({}, prev || {}, next || {});
  }

  /**
   * 把一次改动拆成「无冲突」与「同字段冲突」两部分。
   * @param base    本端改动所基于的服务端偏好快照
   * @param server  重读回来的最新服务端偏好
   * @param changes 本端这次要写的字段
   * @returns {{safe: object, conflict: object}} conflict[字段] = { local, server }
   */
  function splitConflicts(base, server, changes) {
    const b = base || {};
    const s = server || {};
    const safe = {};
    const conflict = {};
    for (const k of Object.keys(changes || {})) {
      const hasBase = Object.prototype.hasOwnProperty.call(b, k);
      const serverChanged = !sameValue(s[k], b[k]);
      const sameAsLocal = sameValue(s[k], changes[k]);
      if (hasBase && serverChanged && !sameAsLocal) conflict[k] = { local: changes[k], server: s[k] };
      else safe[k] = changes[k];
    }
    return { safe, conflict };
  }

  /** 冲突字段 → "仍要保留的草稿"（值取本端想要的那个，等用户选择） */
  function draftOfConflicts(conflict) {
    const out = {};
    for (const k of Object.keys(conflict || {})) out[k] = conflict[k].local;
    return out;
  }

  /**
   * 建一条队列集合（按 profileId 分桶）。
   * @param cfg.patch  (profileId, preferences, { expectedRevision }) => Promise<{ profile }>
   * @param cfg.reload (profileId) => Promise<profile>（profile = { preferences, revision }）
   * @param cfg.baseOf / cfg.revisionOf 可省：队列起点的偏好/revision 快照（返回 undefined 表示未知）
   */
  function createPrefsQueue(cfg) {
    const conf = cfg || {};
    if (typeof conf.patch !== 'function') throw new TypeError('createPrefsQueue 需要 cfg.patch(profileId, preferences, ctx)');
    if (typeof conf.reload !== 'function') throw new TypeError('createPrefsQueue 需要 cfg.reload(profileId)');
    /** @type {Map<string, object>} profileId → 队列状态 */
    const queues = new Map();
    /** 测试/诊断用：每个档案实际发出的请求次数 */
    const counters = { patch: 0, reload: 0 };

    function stateOf(profileId) {
      const pid = String(profileId);
      if (!queues.has(pid)) {
        queues.set(pid, {
          pending: {},
          waiters: [],
          running: false,
          scheduled: false,
          base: (typeof conf.baseOf === 'function' ? conf.baseOf(pid) : null) || {},
          revision: typeof conf.revisionOf === 'function' ? conf.revisionOf(pid) : undefined,
        });
      }
      return queues.get(pid);
    }

    /** 发一个批次（含 409 恢复路径）。返回 outcome，绝不 reject。 */
    async function sendBatch(profileId, st, batch) {
      let retried = false;
      const attempt = (prefs) => {
        counters.patch++;
        return conf.patch(profileId, prefs, { expectedRevision: st.revision, retried });
      };
      let res;
      try {
        res = await attempt(mergeChanges(st.base, batch));
      } catch (e) {
        if (!e || e.status !== 409) {
          return { status: 'error', profileId, error: e, conflict: {}, draft: mergeChanges(batch, st.pending), profile: null };
        }
        // ---- 409：重读服务端版本 → 无冲突字段合并后**重试一次** ----
        retried = true;
        let fresh;
        try {
          counters.reload++;
          fresh = await conf.reload(profileId);
        } catch (e2) {
          return { status: 'error', profileId, error: e2, conflict: {}, draft: mergeChanges(batch, st.pending), profile: null };
        }
        const serverPrefs = (fresh && fresh.preferences) || {};
        const { safe, conflict } = splitConflicts(st.base, serverPrefs, batch);
        // 重读回来的版本就是新的基准：后续批次的 base/revision 都跟着它走
        st.base = serverPrefs;
        if (fresh && fresh.revision !== undefined) st.revision = fresh.revision;
        if (!Object.keys(safe).length) {
          // 全部字段都是同字段冲突：没有"无冲突字段"可重试，直接保留草稿交回用户选择
          return { status: 'conflict', profileId, error: null, conflict, draft: draftOfConflicts(conflict), profile: null };
        }
        try {
          res = await attempt(mergeChanges(serverPrefs, safe));
        } catch (e3) {
          const stillConflict = !!(e3 && e3.status === 409);
          return {
            status: stillConflict ? 'conflict' : 'error',
            profileId,
            error: e3,
            conflict,
            // 二次 409（或重试本身失败）：**不再重试**；这次没存进去的字段（无冲突的 safe
            // 与同字段冲突的本地值）全部回到草稿里，绝不静默丢失
            draft: mergeChanges(safe, draftOfConflicts(conflict)),
            profile: null,
          };
        }
        remember(st, res);
        return {
          status: Object.keys(conflict).length ? 'conflict' : 'saved',
          profileId, error: null, conflict, draft: draftOfConflicts(conflict),
          profile: (res && res.profile) || null,
        };
      }
      remember(st, res);
      return { status: 'saved', profileId, error: null, conflict: {}, draft: {}, profile: (res && res.profile) || null };
    }

    /** 成功返回后把服务端版本记成新基准（下一次改动就基于它算冲突） */
    function remember(st, res) {
      const p = res && res.profile;
      if (!p) return;
      if (p.preferences) st.base = p.preferences;
      if (p.revision !== undefined) st.revision = p.revision;
    }

    /** 顺序把队列里的批次发完；一个批次 settle 才发下一个（串行） */
    async function flush(profileId) {
      const st = stateOf(profileId);
      if (st.running) return;
      st.running = true;
      let last = null;
      try {
        while (Object.keys(st.pending).length) {
          const batch = st.pending;
          st.pending = {};
          last = await sendBatch(profileId, st, batch);
          if (last.status !== 'saved') {
            // 没成功写进服务端的改动一律**放回队列**：`pendingOf` 因此是"还没落盘的改动"的
            // 唯一真值（错误与同字段冲突都适用），下一次 submit 会带着它们一起重试。
            // 冲突时到此为止，等用户选择；错误时同样不自动重试（避免离线时无限打服务端）。
            st.pending = mergeChanges(st.pending, last.draft);
            break;
          }
        }
      } finally {
        st.running = false;
      }
      const waiters = st.waiters;
      st.waiters = [];
      const outcome = last || { status: 'saved', profileId, error: null, conflict: {}, draft: {}, profile: null };
      for (const w of waiters) w(outcome);
    }

    /**
     * 提交一次改动。同一轮同步调用里的多次提交会被合并成一个批次（"合并尚未发送的连续修改"）。
     * @returns Promise<outcome>：outcome = { status:'saved'|'conflict'|'error', profileId, profile, conflict, draft, error }
     *
     * ⚠ waiter 的解析时机（写清楚，别当成逐次调用一一对应）：一次 flush 循环**结束时**，
     *   当前所有在途 waiter 一起拿到本轮的最终 outcome。合并正是这个语义的必然结果
     *   （三次改动合成一次请求，就没法给三个"各自的服务端结果"）。出错/冲突而中断时，
     *   还没发出去的改动仍留在队列里（`pendingOf` / `outcome.draft`），草稿不丢。
     */
    function submit(profileId, changes) {
      const st = stateOf(profileId);
      st.pending = mergeChanges(st.pending, changes);
      const p = new Promise((resolve) => st.waiters.push(resolve));
      if (!st.running && !st.scheduled) {
        st.scheduled = true;
        // 微任务合并窗口：本轮同步的多次 submit 先并起来，只发一次请求
        Promise.resolve().then(() => {
          st.scheduled = false;
          if (!st.running) flush(profileId);
        });
      }
      return p;
    }

    /** 当前还压着没发出去的改动（诊断/用例用：证明"合并了中间值"与"草稿仍在"） */
    function pendingOf(profileId) {
      const st = queues.get(String(profileId));
      return st ? mergeChanges(st.pending) : {};
    }

    return { submit, pendingOf, splitConflicts, counters, queues };
  }

  const api = {
    sameValue, mergeChanges, splitConflicts, draftOfConflicts, createPrefsQueue,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WWPrefsQueue = api;
})(typeof window !== 'undefined' ? window : globalThis);
