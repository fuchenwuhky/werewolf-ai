/**
 * scheduler.js — 进程级单通道 LLM 调度器（硬约束：1 Key = 1 并发）
 *
 * 为什么需要它：服务商按"并发数"计费限流，本项目一局有 11 个 AI、
 * 单局上百次调用，若任一处发起并行请求就会撞限流（智谱 1302）。
 * 因此**所有** LLM 请求都必须经过这唯一一条串行通道，任何"后台任务"
 * （反思、复盘）也只能排进同一条队列，只是优先级更低。
 *
 * 保证的性质：
 *   1. 同一时刻至多 1 个在途请求（无论多少 AI / 多少对局）
 *   2. 优先级：玩家可见决策 > 反思 > 局终复盘 > 预取
 *   3. 防饿死：低优先级任务按等待时长"老化"，保证最终一定被执行
 *   4. 可观测：depth / current / 累计与最长等待，供上帝面板展示
 *   5. 限流收敛点：退避与配额判定只在 llm.js 一处实现，队列统一排队
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

class LlmScheduler {
  constructor({ logger = null, agingStepMs = AGING_STEP_MS, maxAging = MAX_AGING } = {}) {
    this.logger = logger;
    this.agingStepMs = agingStepMs;
    this.maxAging = maxAging;
    this._queue = [];
    this._running = false;
    this._seq = 0;
    this.current = null;   // {label, priority, waitMs, startedAt}
    this.stats = {
      total: 0, failed: 0, waitMsTotal: 0, waitMsMax: 0, runMsTotal: 0,
      byPriority: {},
    };
    this._history = [];
  }

  get depth() { return this._queue.length; }
  get busy() { return this._running; }

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

  /**
   * 入队并串行执行。返回 job 的结果 Promise。
   * @param {Function} fn 实际工作（内部自行重试/退避）
   * @param {{priority?:number,label?:string}} opts
   */
  enqueue(fn, { priority = PRIORITY.decision, label = 'chat' } = {}) {
    return new Promise((resolve, reject) => {
      this._queue.push({ id: ++this._seq, priority, label, enqueuedAt: Date.now(), fn, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    if (this._running) return;
    const task = this._take(Date.now());
    if (!task) return;
    this._running = true;
    const startedAt = Date.now();
    const waitMs = startedAt - task.enqueuedAt;
    this.current = { label: task.label, priority: task.priority, waitMs, startedAt };
    this.stats.total++;
    this.stats.byPriority[task.priority] = (this.stats.byPriority[task.priority] || 0) + 1;
    this.stats.waitMsTotal += waitMs;
    if (waitMs > this.stats.waitMsMax) this.stats.waitMsMax = waitMs;
    if (waitMs > 1000 && this.logger) {
      this.logger.debug('llm', `排队 ${waitMs}ms 后执行：${task.label}（队列积压 ${this._queue.length}）`);
    }
    Promise.resolve()
      .then(() => task.fn())
      .then(
        (v) => { this._settle(task, startedAt, true); task.resolve(v); },
        (e) => { this._settle(task, startedAt, false); task.reject(e); },
      );
  }

  _settle(task, startedAt, ok) {
    const runMs = Date.now() - startedAt;
    this.stats.runMsTotal += runMs;
    if (!ok) this.stats.failed++;
    this._history.push({ label: task.label, priority: task.priority, waitMs: startedAt - task.enqueuedAt, runMs, ok });
    if (this._history.length > HISTORY_SIZE) this._history.splice(0, this._history.length - HISTORY_SIZE);
    this._running = false;
    this.current = null;
    this._pump();
  }

  /** 上帝面板展示用快照 */
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
    };
  }

  /** 测试/暂停用：等待队列清空且无在途任务 */
  async drain() {
    while (this._running || this._queue.length) {
      await new Promise((r) => setTimeout(r, 1));
    }
  }
}

/** 进程级单例：全项目共用这一条通道 */
const scheduler = new LlmScheduler();

module.exports = { LlmScheduler, scheduler, PRIORITY, AGING_STEP_MS };
