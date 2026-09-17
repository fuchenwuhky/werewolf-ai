/**
 * scheduler.js — 进程级 LLM 调度器（默认单通道；多 Key 时按"每 Key 一条通道"放行）
 *
 * 为什么需要它：服务商按"并发数"计费限流，本项目一局有 11 个 AI、
 * 单局上百次调用，若任一处发起并行请求就会撞限流（智谱 1302）。
 * 因此**所有** LLM 请求都必须经过这一条队列，任何"后台任务"（反思、复盘）
 * 也只能排进同一队列，只是优先级更低。
 *
 * 多 Key（keypool 方案）：`setChannels(n)` 把"同时最多 1 个在途"放宽到 n 个。
 * 实现上刻意**只放开并发度**，不分叉队列：优先级、老化、FIFO 全部保持原样，
 * 于是 `channels === 1` 时行为与旧版逐字节一致（单 Key 用户零变化），
 * 而 n 条通道各自绑定一个 Key（槽位 i ↦ keys[i]），便于服务商侧缓存命中。
 * 实测收益有上限（见 docs/fluency-plan.md §1.4：可并行部分只占 30%，4 通道约 -23%），
 * 所以默认仍是 1，不要为了"看起来快"而擅自调大。
 *
 * 保证的性质：
 *   1. 同一时刻至多 `channels` 个在途请求（默认 1）
 *   2. 优先级：玩家可见决策 > 反思 > 局终复盘 > 预取
 *   3. 防饿死：低优先级任务按等待时长"老化"，保证最终一定被执行
 *   4. 可观测：depth / current / 累计与最长等待，供上帝面板展示
 *   5. 限流收敛点：退避与配额判定只在 llm.js 一处实现，队列统一排队
 *   6. 坏 Key 隔离：某个槽位的请求以致命错误（配额/鉴权）失败时，临时摘掉该槽位，
 *      不让它继续吃请求 —— 多 Key 的意义之一就是"一条通道坏了不拖垮整局"
 */
'use strict';

/** 优先级：数值越小越优先 */
const PRIORITY = {
  decision: 0,   // 玩家可见决策（发言/投票/技能/夜间行动）
  reflection: 1, // 每日反思纪要（L1 记忆维护）
  lesson: 2,     // 局终复盘（跨局经验池）
  prefetch: 3,   // 预取（保留位）
};

/** 每等待 AGING_STEP_MS 提升一级有效优先级（防低优先级饿死） */
const AGING_STEP_MS = 30000;
const MAX_AGING = 2;
const HISTORY_SIZE = 50;
/** 坏 Key 摘除时长：配额/鉴权类失败通常几分钟内不会自愈 */
const SLOT_COOLDOWN_MS = 300000;

class LlmScheduler {
  constructor({ logger = null, agingStepMs = AGING_STEP_MS, maxAging = MAX_AGING, channels = 1 } = {}) {
    this.logger = logger;
    this.agingStepMs = agingStepMs;
    this.maxAging = maxAging;
    this._queue = [];
    this._seq = 0;
    this._channels = Math.max(1, Math.floor(channels) || 1);
    // 槽位状态：槽位 i 绑定第 i 个 Key；disabledUntil 用于坏 Key 隔离
    this._slots = Array.from({ length: this._channels }, () => ({ busy: false, disabledUntil: 0, lastError: null }));
    this.stats = {
      total: 0, failed: 0, waitMsTotal: 0, waitMsMax: 0, runMsTotal: 0,
      byPriority: {}, bySlot: {},
    };
    this._history = [];
  }

  get depth() { return this._queue.length; }
  get busy() { return this._slots.some((s) => s.busy); }
  get channels() { return this._channels; }
  /** 当前在途任务的展示信息（旧字段 current 的语义：只报"第一个在跑的"） */
  get current() {
    const s = this._slots.find((x) => x.busy && x.current);
    return s ? s.current : null;
  }

  /**
   * 设置通道数（进程级）。默认 1：单 Key 用户行为与旧版完全一致。
   * 缩容时不会打断在途请求，只是不再往多余槽位派活。
   */
  setChannels(n) {
    const next = Math.max(1, Math.floor(Number(n)) || 1);
    if (next === this._channels) return this._channels;
    const old = this._slots;
    this._slots = Array.from({ length: next }, (_, i) => old[i] || { busy: false, disabledUntil: 0, lastError: null });
    this._channels = next;
    if (this.logger) this.logger.info('llm', `LLM 调度器通道数：${old.length} → ${next}`);
    this._pump();
    return next;
  }

  /** 坏 Key 隔离：某个槽位致命失败后临时停用（过期自动恢复） */
  disableSlot(slot, reason) {
    const s = this._slots[slot];
    if (!s) return;
    s.disabledUntil = Date.now() + SLOT_COOLDOWN_MS;
    s.lastError = reason || '致命错误';
    if (this.logger) this.logger.warn('llm', `通道 ${slot} 已被临时摘除（${s.lastError}），${Math.round(SLOT_COOLDOWN_MS / 1000)}s 后自动恢复`);
  }

  /** 有效优先级：基础优先级 - 老化级数（数值越小越优先） */
  _effective(task, now) {
    const aging = Math.min(this.maxAging, Math.floor((now - task.enqueuedAt) / this.agingStepMs));
    return task.priority - aging;
  }

  /** 取出当前该执行的任务：有效优先级最高者；同级则先到先服务 */
  _take(now) {
    if (!this._queue.length) return null;
    let best = 0;
    for (let i = 1; i < this._queue.length; i++) {
      const cand = this._effective(this._queue[i], now);
      const cur = this._effective(this._queue[best], now);
      if (cand < cur || (cand === cur && this._queue[i].id < this._queue[best].id)) best = i;
    }
    return this._queue.splice(best, 1)[0];
  }

  /** 找一个可用槽位：优先空闲且未被摘除的；全都不可用时退化到槽位 0（保证请求总会发出） */
  _freeSlot(now) {
    for (let i = 0; i < this._slots.length; i++) {
      const s = this._slots[i];
      if (!s.busy && s.disabledUntil <= now) return i;
    }
    for (let i = 0; i < this._slots.length; i++) {
      if (!this._slots[i].busy) return i; // 全部被摘除（例如只有一个 Key 且配额耗尽）→ 照旧发
    }
    return -1;
  }

  /**
   * 入队并执行。返回 job 的结果 Promise。
   * @param {Function} fn 实际工作（内部自行重试/退避）；会收到槽位号，便于按 Key 分派
   * @param {{priority?:number,label?:string}} opts
   */
  enqueue(fn, { priority = PRIORITY.decision, label = 'chat' } = {}) {
    return new Promise((resolve, reject) => {
      this._queue.push({ id: ++this._seq, priority, label, enqueuedAt: Date.now(), fn, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    // 单通道时这个循环只会跑一轮（旧行为）；多通道时把所有空闲槽位喂满
    for (;;) {
      const now = Date.now();
      const slot = this._freeSlot(now);
      if (slot < 0) return;
      const task = this._take(now);
      if (!task) return;
      const st = this._slots[slot];
      st.busy = true;
      const startedAt = Date.now();
      const waitMs = startedAt - task.enqueuedAt;
      st.current = { label: task.label, priority: task.priority, waitMs, startedAt, slot };
      this.stats.total++;
      this.stats.byPriority[task.priority] = (this.stats.byPriority[task.priority] || 0) + 1;
      this.stats.bySlot[slot] = (this.stats.bySlot[slot] || 0) + 1;
      this.stats.waitMsTotal += waitMs;
      if (waitMs > this.stats.waitMsMax) this.stats.waitMsMax = waitMs;
      if (waitMs > 1000 && this.logger) {
        this.logger.debug('llm', `排队 ${waitMs}ms 后执行：${task.label}（队列积压 ${this._queue.length}）`);
      }
      Promise.resolve()
        .then(() => task.fn(slot))
        .then(
          (v) => { this._settle(task, slot, startedAt, true, null); task.resolve(v); },
          (e) => { this._settle(task, slot, startedAt, false, e); task.reject(e); },
        );
    }
  }

  _settle(task, slot, startedAt, ok, err) {
    const runMs = Date.now() - startedAt;
    this.stats.runMsTotal += runMs;
    if (!ok) this.stats.failed++;
    this._history.push({ label: task.label, priority: task.priority, waitMs: startedAt - task.enqueuedAt, runMs, ok, slot });
    if (this._history.length > HISTORY_SIZE) this._history.splice(0, this._history.length - HISTORY_SIZE);
    const st = this._slots[slot];
    if (st) {
      st.busy = false;
      st.current = null;
      // 致命错误（配额/鉴权）＝这条通道上的 Key 暂时没用了：摘掉它，让别的通道继续干活
      if (!ok && err && err.fatal === true) this.disableSlot(slot, err.message || String(err.kind || 'fatal'));
    }
    this._pump();
  }

  /** 上帝面板展示用快照（depth/busy/current 为旧字段，必须保留：api.js 的空转检测依赖它们） */
  snapshot() {
    return {
      depth: this.depth,
      busy: this.busy,
      current: this.current ? { label: this.current.label, priority: this.current.priority } : null,
      total: this.stats.total,
      failed: this.stats.failed,
      avgWaitMs: this.stats.total ? Math.round(this.stats.waitMsTotal / this.stats.total) : 0,
      maxWaitMs: this.stats.waitMsMax,
      avgRunMs: this.stats.total ? Math.round(this.stats.runMsTotal / this.stats.total) : 0,
      byPriority: { ...this.stats.byPriority },
      recent: this._history.slice(-10),
      // 多通道观测（新增字段，旧消费方不受影响）
      channels: this._channels,
      bySlot: { ...this.stats.bySlot },
      slots: this._slots.map((s, i) => ({ slot: i, busy: !!s.busy, disabled: s.disabledUntil > Date.now(), lastError: s.lastError })),
    };
  }

  /** 测试/暂停用：等待队列清空且无在途任务 */
  async drain() {
    while (this.busy || this._queue.length) {
      await new Promise((r) => setTimeout(r, 1));
    }
  }
}

/** 进程级单例：全项目共用这一条队列（默认 1 条通道） */
const scheduler = new LlmScheduler();

module.exports = { LlmScheduler, scheduler, PRIORITY, AGING_STEP_MS, SLOT_COOLDOWN_MS };
