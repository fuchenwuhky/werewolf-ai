/**
 * scheduler.js — 进程级 LLM 调度器：**每个 API Key 有自己的并发上限，并按实际可用额度自适应**
 *
 * 为什么需要它：服务商按"并发数"计费限流，本项目一局有 11 个 AI、单局上百次调用，
 * 若任一处发起并行请求就会撞限流（智谱 1302）。因此**所有** LLM 请求都必须经过这一条队列，
 * 任何"后台任务"（反思、复盘）也只能排进同一队列，只是优先级更低。
 *
 * 模型：Key 池 + 每 Key 泳道
 *   · 池里有 n 把 Key（来自 config.apiKeys）；第 i 把 Key 有 `limit[i]` 条并发泳道。
 *   · 每个在途任务占用"某把 Key 的一条泳道"，`fn(slot)` 收到的 slot 就是 **Key 序号**。
 *   · 同一时刻在途总数 = Σ limit[i]，但每把 Key 自己绝不超限（这是"1 Key = 1 并发"硬约束的推广）。
 *
 * 自适应（AIMD：加性增长 / 乘性回退）—— 因为"这把 Key 实际允许几并发"只有服务商知道：
 *   · 被限流（429 / 1302 / Retry-After）→ `limit = max(1, floor(limit/2))` 并进入冷却；
 *   · 连续 N 次成功**且该 Key 当时泳道跑满**（说明 limit 正卡着瓶颈）→ `limit += 1`（上限 maxPerKey）；
 *   · 探到过上限的那一档记进 `badLimit`，10 分钟内不再试同一档，避免"每 30 秒撞一次 429"的抖动。
 *   注意"跑满"这个条件很关键：串行工作负载（同时只有 1 个在途）不会触发加档，只有真的压满才加。
 *
 * 保证的性质：
 *   1. 同一时刻每把 Key 在途数 ≤ 它的 limit；默认为 1（与从前的严格串行完全一致）
 *   2. 优先级：玩家可见决策 > 反思 > 局终复盘 > 预取
 *   3. 防饿死：低优先级任务按等待时长"老化"，保证最终一定被执行
 *   4. 可观测：depth / current / 累计与最长等待 / 每把 Key 的 limit 与在途数，供上帝面板展示
 *   5. 限流收敛点：退避与配额判定只在 llm.js 一处实现，队列统一排队
 *   6. 坏 Key 隔离：某把 Key 致命失败（配额/鉴权）时临时摘除，不让它继续吃请求
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
/** 连续成功多少次、且泳道跑满，才允许 +1 条泳道 */
const RAMP_AFTER_OK = 3;
/** 两次加档之间至少隔这么久（防过冲） */
const RAMP_MIN_GAP_MS = 5000;
/** 被限流后多久内不再加档 */
const RATE_LIMIT_COOLDOWN_MS = 30000;
/** 探到过上限的那一档，多久内不再重试（避免周期性撞 429） */
const BAD_LIMIT_TTL_MS = 600000;
/** 每把 Key 默认的泳道上限（用户可用 config.maxChannelsPerKey 覆盖） */
const DEFAULT_MAX_PER_KEY = 4;

class LlmScheduler {
  /**
   * @param opts {logger, agingStepMs, maxAging, keys, channels, maxPerKey, adaptive}
   *   - keys：Key 池大小（第 i 个槽位绑定第 i 把 Key）
   *   - channels：兼容旧调用的写法，等价于 keys（旧语义是"总通道数=Key 数"，两者本就一致）
   *   - adaptive：是否允许按实际额度加档（默认开；关掉就固定成初始 limit）
   */
  constructor({ logger = null, agingStepMs = AGING_STEP_MS, maxAging = MAX_AGING, keys = null, channels = null, maxPerKey = DEFAULT_MAX_PER_KEY, adaptive = true } = {}) {
    this.logger = logger;
    this.agingStepMs = agingStepMs;
    this.maxAging = maxAging;
    this.maxPerKey = Math.max(1, Math.floor(Number(maxPerKey)) || DEFAULT_MAX_PER_KEY);
    this.adaptive = adaptive !== false;
    this._queue = [];
    this._seq = 0;
    this._keys = [];
    const n = Math.max(1, Math.floor(Number(keys != null ? keys : channels)) || 1);
    this._resize(n, 1);
    this.stats = {
      total: 0, failed: 0, waitMsTotal: 0, waitMsMax: 0, runMsTotal: 0,
      byPriority: {}, bySlot: {}, rateLimited: 0, ramps: 0,
    };
    this._history = [];
  }

  get depth() { return this._queue.length; }
  get busy() { return this._keys.some((k) => k.inFlight > 0); }
  /** 池里 Key 的个数 */
  get keyCount() { return this._keys.length; }
  /** 当前**并发容量**（Σ 每把 Key 的 limit） */
  get channels() { return this._keys.reduce((a, k) => a + k.limit, 0); }
  /** 当前在途展示信息（旧字段 current 的语义：报"最近开始的那个"） */
  get current() {
    let best = null;
    for (const k of this._keys) {
      for (const t of k.running) if (!best || t.startedAt > best.startedAt) best = t;
    }
    return best;
  }

  _newKey(index, limit) {
    return {
      index, limit: Math.max(1, Math.floor(limit) || 1), max: this.maxPerKey,
      inFlight: 0, running: [], disabledUntil: 0, lastError: null,
      okStreak: 0, lastRampAt: 0, rampBlockedUntil: 0, badLimit: 0, badUntil: 0, hadBacklog: false,
      rateLimited: 0, ok: 0, ramps: 0,
    };
  }

  /** 重建 Key 池（保留已有 Key 的自适应结果 —— 改配置不该把学到的东西清空） */
  _resize(n, perKeyLimit) {
    const old = this._keys;
    this._keys = Array.from({ length: n }, (_, i) => {
      if (old[i]) return old[i];
      return this._newKey(i, perKeyLimit);
    });
    return this._keys.length;
  }

  /**
   * 设置 Key 池与每把 Key 的初始泳道数（进程级；llm.js 每次调用按配置校对，运行中改也生效）。
   * @returns {number} 池大小
   */
  setPool({ keys = null, perKey = null, maxPerKey = null, adaptive = null } = {}) {
    const before = this.channels;
    const n = keys != null ? Math.max(1, Math.floor(Number(keys)) || 1) : this._keys.length;
    if (maxPerKey != null) this.maxPerKey = Math.max(1, Math.floor(Number(maxPerKey)) || DEFAULT_MAX_PER_KEY);
    this.maxPerKey = Math.max(1, this.maxPerKey);
    for (const k of this._keys) k.max = this.maxPerKey;
    if (adaptive != null) this.adaptive = adaptive !== false;
    this._resize(n, 1);
    // 显式指定每把 Key 的初始泳道数时，只有**用户明确要求**才抬上去（自适应仍会在其上继续加）
    if (perKey != null && Number(perKey) > 0) {
      const want = Math.max(1, Math.floor(Number(perKey)) || 1);
      for (const k of this._keys) k.limit = Math.max(k.limit, Math.min(want, k.max));
    }
    if (this.channels !== before && this.logger) {
      this.logger.info('llm', `LLM 调度器：${this._keys.length} 把 Key，当前并发容量 ${before} → ${this.channels}（每把上限 ${this.maxPerKey}${this.adaptive ? '，自适应开' : '，自适应关'}）`);
    }
    this._pump();
    return this._keys.length;
  }

  /** 兼容旧调用：channels = Key 数（旧模型里"一个槽位一把 Key"） */
  setChannels(n) { return this.setPool({ keys: n }); }

  /**
   * 主动探测/人工指定某把 Key 的泳道数（设置页"探测并发额度"用）。
   * @param source 记录来源，便于日志区分"探测得到"与"自适应学到"
   */
  setKeyLimit(index, limit, source = 'manual') {
    const k = this._keys[index];
    if (!k) return null;
    k.limit = Math.max(1, Math.min(Math.floor(Number(limit)) || 1, k.max));
    k.okStreak = 0;
    k.lastRampAt = Date.now();
    if (this.logger) this.logger.info('llm', `Key ${index} 并发上限设为 ${k.limit}（${source}）`);
    this._pump();
    return k.limit;
  }

  /** 限流反馈：乘性回退（并记住这一档探不动，避免周期性重试） */
  noteRateLimited(index) {
    const k = this._keys[index];
    if (!k) return;
    const from = k.limit;
    k.rateLimited++;
    this.stats.rateLimited++;
    k.badLimit = from;
    k.badUntil = Date.now() + BAD_LIMIT_TTL_MS;
    k.limit = Math.max(1, Math.floor(from / 2));
    k.rampBlockedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    k.okStreak = 0;
    if (this.logger) {
      this.logger.warn('llm', `Key ${index} 触发限流 → 并发上限 ${from} → ${k.limit}（${Math.round(RATE_LIMIT_COOLDOWN_MS / 1000)}s 内不再加档；${Math.round(BAD_LIMIT_TTL_MS / 60000)} 分钟内不再试 ${k.badLimit} 这一档）`);
    }
  }

  /** 成功反馈：加性增长（只在"该 Key 确实有人排队"时才尝试 +1） */
  noteSuccess(index) {
    const k = this._keys[index];
    if (!k) return;
    k.ok++;
    k.okStreak++;
    if (!this.adaptive || k.limit >= k.max) return;
    const now = Date.now();
    // 加档证据：这把 Key 忙的时候**有任务在排队**（说明泳道数正卡着瓶颈）。
    // 串行负载没有排队，永远不满足 ⇒ 不会被盲目加档；真实扇出（引擎一次提交十几个调用）会满足。
    if (!k.hadBacklog) return;
    if (k.okStreak < RAMP_AFTER_OK) return;
    if (now < k.rampBlockedUntil || now - k.lastRampAt < RAMP_MIN_GAP_MS) return;
    if (k.limit + 1 === k.badLimit && now < k.badUntil) return;
    k.limit++;
    k.ramps++;
    this.stats.ramps++;
    k.okStreak = 0;
    k.hadBacklog = false; // 加档后要重新积累证据，才允许下一次 +1
    k.lastRampAt = now;
    if (this.logger) this.logger.info('llm', `Key ${index} 连续 ${RAMP_AFTER_OK} 次"有人排队仍成功" → 并发上限加到 ${k.limit}`);
    this._pump(); // 多出来的泳道立刻可用
  }

  /** 坏 Key 隔离：某把 Key 致命失败后临时停用（过期自动恢复） */
  disableSlot(index, reason) {
    const k = this._keys[index];
    if (!k) return;
    k.disabledUntil = Date.now() + SLOT_COOLDOWN_MS;
    k.lastError = reason || '致命错误';
    if (this.logger) this.logger.warn('llm', `Key ${index} 已被临时摘除（${k.lastError}），${Math.round(SLOT_COOLDOWN_MS / 1000)}s 后自动恢复`);
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

  /**
   * 找一把还有空闲泳道、且未被摘除的 Key。
   * 顺序取第一个有空位的（"填满 Key 0 再用 Key 1"）：同一把 Key 的连续请求打同一个账号，
   * 服务商侧 prompt 缓存才不会因为换 Key 而全部落空。
   * 全都被摘除时退化到第一把（保证请求总会发出，配额耗尽自然会走暂停流程）。
   */
  _freeSlot(now) {
    let anyFree = -1;
    for (const k of this._keys) {
      if (k.inFlight >= k.limit) continue;
      if (anyFree < 0) anyFree = k.index;
      if (k.disabledUntil <= now) return k.index;
    }
    return anyFree;
  }

  /**
   * 入队并执行。返回 job 的结果 Promise。
   * @param {Function} fn 实际工作（内部自行重试/退避）；会收到 Key 序号，用于选 API Key
   * @param {{priority?:number,label?:string}} opts
   */
  enqueue(fn, { priority = PRIORITY.decision, label = 'chat' } = {}) {
    return new Promise((resolve, reject) => {
      this._queue.push({ id: ++this._seq, priority, label, enqueuedAt: Date.now(), fn, resolve, reject });
      this._pump();
      // 入队后**仍有积压** ⇒ 泳道不够用（真的有人在排队等）。这才是"该加档"的证据：
      // 串行负载（一次只有一个请求、没人排队）永远不会置上它，因此不会被盲目加档。
      // 仅凭"在途数 == limit"判断是不行的 —— limit=1 时"跑满"与"只是串行"完全同形。
      if (this._queue.length > 0) {
        for (const k of this._keys) if (k.inFlight > 0) k.hadBacklog = true;
      }
    });
  }

  _pump() {
    // 一轮循环把所有空闲泳道喂满；每把 Key 各自不超限
    for (;;) {
      const now = Date.now();
      const slot = this._freeSlot(now);
      if (slot < 0) return;
      const task = this._take(now);
      if (!task) return;
      const k = this._keys[slot];
      const startedAt = Date.now();
      const waitMs = startedAt - task.enqueuedAt;
      const info = { label: task.label, priority: task.priority, waitMs, startedAt, slot };
      k.inFlight++;
      k.running.push(info);
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
    const k = this._keys[slot];
    if (k) {
      k.inFlight = Math.max(0, k.inFlight - 1);
      const i = k.running.findIndex((t) => t.startedAt === startedAt);
      if (i >= 0) k.running.splice(i, 1);
      // 致命错误（配额/鉴权）＝这把 Key 暂时没用了：摘掉它，让别的 Key 继续干活
      if (!ok && err && err.fatal === true) this.disableSlot(slot, err.message || String(err.kind || 'fatal'));
    }
    this._pump();
  }

  /** 上帝面板展示用快照（depth/busy/current 为旧字段，必须保留：api.js 的空转检测依赖它们） */
  snapshot() {
    const cur = this.current;
    return {
      depth: this.depth,
      busy: this.busy,
      current: cur ? { label: cur.label, priority: cur.priority } : null,
      total: this.stats.total,
      failed: this.stats.failed,
      avgWaitMs: this.stats.total ? Math.round(this.stats.waitMsTotal / this.stats.total) : 0,
      maxWaitMs: this.stats.waitMsMax,
      avgRunMs: this.stats.total ? Math.round(this.stats.runMsTotal / this.stats.total) : 0,
      byPriority: { ...this.stats.byPriority },
      recent: this._history.slice(-10),
      // Key 池观测（新增字段，旧消费方不受影响）
      channels: this.channels,
      keys: this._keys.length,
      maxPerKey: this.maxPerKey,
      adaptive: this.adaptive,
      bySlot: { ...this.stats.bySlot },
      rateLimited: this.stats.rateLimited,
      ramps: this.stats.ramps,
      slots: this._keys.map((k) => ({
        slot: k.index, limit: k.limit, inFlight: k.inFlight, busy: k.inFlight > 0,
        disabled: k.disabledUntil > Date.now(), lastError: k.lastError, rateLimited: k.rateLimited,
      })),
    };
  }

  /** 测试/暂停用：等待队列清空且无在途任务 */
  async drain() {
    while (this.busy || this._queue.length) {
      await new Promise((r) => setTimeout(r, 1));
    }
  }
}

/** 进程级单例：全项目共用这一条队列（默认 1 把 Key、每把 1 条泳道 = 严格串行） */
const scheduler = new LlmScheduler();

module.exports = {
  LlmScheduler, scheduler, PRIORITY, AGING_STEP_MS, SLOT_COOLDOWN_MS,
  RAMP_AFTER_OK, RAMP_MIN_GAP_MS, RATE_LIMIT_COOLDOWN_MS, BAD_LIMIT_TTL_MS, DEFAULT_MAX_PER_KEY,
};
