/**
 * journal.js — 决策 journal（P1-1 / P1-2）：让"断点恢复"变成幂等重放。
 *
 * 问题：恢复 = 从锚点重放整个阶段（发言/夜晚）。旧实现会把该阶段已经问过的 LLM 决策**重新问一遍**，
 *       既多花钱又多花时间，还因为模型有随机性而让"恢复后的对局"和"崩溃前的对局"走向不同。
 *
 * 解法：每次决策用一个稳定的 key 落一条 JSONL：
 *       key = sha1(PROMPT_VERSION | gameId | day | phase | seq | seat | task | variant)
 *       恢复重放时同样的决策点会算出同样的 key → 直接命中磁盘上的答案，零 LLM 调用、逐字一致。
 *
 * 三个必须做对的地方（否则 journal 会悄悄出错）：
 *  1. **seq 必须可复现**：引擎的随机性（发言首座、平票抽签、技能询问顺序）已改为可播种、进锚点快照的
 *     `game.rnd`（见 src/engine/rng.js），否则重放的决策点会错位。
 *  2. **重试必须分开**：`askValidated` 校验失败后会带 `_retryNote` 重问。若沿用同一个 key，journal 会把
 *     "上一次那个非法输出"原样还回去 → 无限重复同一次失败。故 `variant` 纳入 key。
 *  3. **提示词漂移要能看见**：key 里只有 promptVersion（结构性版本号），但每次仍记录 prompt 的哈希；
 *     命中时若哈希不同就打点计数（drift），便于发现"模板改了但版本号忘了升"。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 提示词/上下文组装发生结构性变更时递增：旧 journal 自然失效，不会拿旧格式的答案去套新上下文 */
const PROMPT_VERSION = 'p1';

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

/**
 * 决策点的稳定标识。
 * variant：重试/追问等"同一决策点的不同问法"（通常是 _retryNote），默认空串。
 */
function keyOf({ gameId, day, phase, seq, seat, task, variant = '' }) {
  return sha1([PROMPT_VERSION, gameId, day, phase, seq, seat, task, variant].join('\u0001')).slice(0, 24);
}

class DecisionJournal {
  /**
   * @param dir 存放目录（每个对局一个 <gameId>.jsonl）
   * @param opts.enabled 关闭时 lookup 恒为 null、record 不落盘（用于排查/对照实验）
   */
  constructor(dir, { enabled = true, logger = null } = {}) {
    this.dir = dir;
    this.enabled = !!enabled;
    this.logger = logger;
    this.cache = new Map(); // gameId -> Map(key -> entry)
    this.stats = { hits: 0, misses: 0, drift: 0, records: 0, disabled: 0 };
  }

  file(gameId) { return path.join(this.dir, `${gameId}.jsonl`); }

  _load(gameId) {
    let m = this.cache.get(gameId);
    if (m) return m;
    m = new Map();
    try {
      const txt = fs.readFileSync(this.file(gameId), 'utf8');
      for (const line of txt.split('\n')) {
        if (!line) continue;
        try {
          const o = JSON.parse(line);
          if (o && typeof o.k === 'string') m.set(o.k, o);
        } catch (_) { /* 崩溃时可能留下半行：跳过，不影响其余记录 */ }
      }
    } catch (_) { /* 文件不存在 = 全新对局 */ }
    this.cache.set(gameId, m);
    return m;
  }

  /** 命中返回 {payload, usage, ph}，未命中返回 null */
  lookup(gameId, key, promptHash) {
    if (!this.enabled) { this.stats.disabled++; return null; }
    const e = this._load(gameId).get(key);
    if (!e) { this.stats.misses++; return null; }
    this.stats.hits++;
    if (promptHash && e.ph && e.ph !== promptHash) {
      this.stats.drift++;
      if (this.logger) this.logger.warn('ai', `journal 命中但提示词哈希不一致（决策点 ${key}）：可能是模板改了没升 PROMPT_VERSION`);
    }
    return e;
  }

  /**
   * 落一条记录。用 appendFileSync：每次决策只有几百字节，而它前面往往是一次 3~60s 的 LLM 调用，
   * 这点同步写可以忽略；换来的是"进程在任意时刻被杀，已花钱的决策都不会丢"。
   */
  record(gameId, key, { payload, usage = null, promptHash = '', meta = null }) {
    if (!this.enabled) return;
    const entry = { k: key, t: Date.now(), ph: promptHash, payload, usage, meta };
    this._load(gameId).set(key, entry);
    this.stats.records++;
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.file(gameId), JSON.stringify(entry) + '\n');
    } catch (err) {
      // journal 是"省钱优化"，写不进去不能影响对局
      if (this.logger) this.logger.warn('ai', `journal 写入失败（不影响对局）：${err.message}`);
    }
  }

  /** 对局结束后可释放内存缓存（文件保留，仍可复现） */
  forget(gameId) { this.cache.delete(gameId); }

  size(gameId) { return this._load(gameId).size; }

  /** 清理：按数量与天数双重上限（journal 只是缓存，删掉只影响"能不能免费复现"） */
  prune({ maxFiles = 300, maxAgeMs = 7 * 24 * 3600 * 1000 } = {}) {
    let removed = 0;
    let files;
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl'));
    } catch (_) { return 0; }
    const now = Date.now();
    const stats = files.map((f) => {
      const p = path.join(this.dir, f);
      let st = null;
      try { st = fs.statSync(p); } catch (_) {}
      return { f, p, mtime: st ? st.mtimeMs : 0 };
    }).sort((a, b) => b.mtime - a.mtime);
    for (let i = 0; i < stats.length; i++) {
      const s = stats[i];
      if (i >= maxFiles || now - s.mtime > maxAgeMs) {
        try { fs.unlinkSync(s.p); this.cache.delete(s.f.replace(/\.jsonl$/, '')); removed++; } catch (_) {}
      }
    }
    return removed;
  }
}

module.exports = { DecisionJournal, keyOf, PROMPT_VERSION, sha1 };
