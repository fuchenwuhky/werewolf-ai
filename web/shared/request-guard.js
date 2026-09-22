/**
 * request-guard.js — 异步请求的 **档案绑定 + 代次票据**（计划书 §5.2）
 *
 * 计划书原文：「异步请求绑定发起时的 `profileId` 与请求代次；**迟到响应不得覆盖新档案页面**。」
 * 以及 §5.3：「请求完成时若已切档，**只更新原档案缓存，不改变当前页面**。」
 *
 * ── 为什么需要"代次"而不只是"比对当前档案 id" ────────────────────────────────
 * 只比 `state.profileId === 发起时的 id` 有一个真实漏洞：**A → B → A**。
 * 用户快速切回自己原来的档案时，那个"切走之前发出的、慢得离谱的响应"回来时
 * `profileId` 又等于 A 了 —— 于是它被当成"当前档案的数据"画上页面，
 * 但它发起时的页面状态（revision、进行中的对局、筛选）可能已经不是现在这一份。
 * 代次（epoch）在**每次档案真的变化时** +1，票据记下发起时的 (profileId, epoch)，
 * 因此 A→B→A 之后旧 A 票据当场作废，而"同档案期间的并发请求"（epoch 不变）仍然有效 ——
 * 后者是正常并发，不能误杀（玩家中心的五路并发取数就是这种情况）。
 *
 * 纯模块、零依赖：Node 单测里可以直接断言"迟到响应被丢弃"。
 */

'use strict';
(function (global) {
  /**
   * @param opts.profileId 初始档案 id（可省）
   */
  function createRequestGuard(opts) {
    const conf = opts || {};
    let currentProfileId = conf.profileId === undefined ? null : conf.profileId;
    let epoch = 0;
    let seq = 0;

    /** 当前 (profileId, epoch) 快照 */
    function current() {
      return { profileId: currentProfileId, epoch };
    }

    /**
     * 档案真的变化时换代。**同档案重复调用不换代** —— 否则"同一档案里的并发请求"
     * （先 begin 的会被后 setCurrent 挤掉）会被误判为过期。
     * @returns 换代后的快照
     */
    function setCurrent(profileId) {
      const next = profileId === undefined ? null : profileId;
      if (next !== currentProfileId) {
        currentProfileId = next;
        epoch += 1;
      }
      return current();
    }

    /**
     * 取一张票据：绑定**发起时**的 profileId 与代次。
     * 不传 profileId 时绑定当前档案（调用方通常直接传 `state.profileId`，避免两处读值不一致）。
     */
    function begin(profileId) {
      const pid = profileId === undefined ? currentProfileId : profileId;
      seq += 1;
      return { profileId: pid, epoch, seq };
    }

    /** 这张票据是否仍被允许写当前页面（同档案 + 同代次） */
    function isCurrent(ticket) {
      return !!ticket && ticket.epoch === epoch && ticket.profileId === currentProfileId;
    }

    /**
     * 只在票据仍有效时执行 `apply`（异步响应回来后"落笔"的那一步）。
     * @returns { applied: boolean, value?: any } —— 未执行时 value 为 undefined
     */
    function settle(ticket, apply) {
      if (!isCurrent(ticket)) return { applied: false, value: undefined };
      return { applied: true, value: apply() };
    }

    return { begin, isCurrent, settle, setCurrent, current };
  }

  const api = { createRequestGuard };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WWRequestGuard = api;
})(typeof window !== 'undefined' ? window : globalThis);
