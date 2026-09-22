/**
 * store.js — 私人标注存储（整改方案 NOTE-02，DATA-01 同款可靠性语义）
 *
 * 每档案每局一份：profiles/<pid>/annotations/<gameId>.json
 * 结构（方案 §4.2）：
 *   { schemaVersion:2, profileId, gameId, revision, seats:{ "<seat>": {
 *       leaning, candidateRoleIds[], claimedRoleId, confidence, note, evidenceSeq, day, phase, updatedAt } } }
 *
 * 安全边界：标注永不进入 Game.players、引擎事件、AI prompt、公开 SSE；
 * 写入前经 normalizeSeatAnnotation 白名单清洗（web/shared 同一份语义的 Node 侧实现）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { tmpPathFor } = require('../tmp-files');

const SCHEMA_VERSION = 2;
const LEANINGS = ['neutral', 'lean_good', 'lean_wolf', 'third_party', 'wolf', 'good']; // 'wolf'/'good'：方案 §4.2 示例直接使用，接受为合法值
const CONFIDENCE = ['low', 'medium', 'high'];
const MAX_CANDIDATES = 3;
const MAX_NOTE = 200;

/**
 * 单座位标注的**默认值**（唯一来源）：normalizeSeatAnnotation 与「是否已清空」判据
 * （isMeaningfulSeatAnnotation）共用同一组常量 —— 判据分叉过一次就会变成"计数与清洗语义不一致"
 * 这类极难排查的缺陷（FIX-07 的计数虚高正是这么来的）。
 */
const DEFAULT_LEANING = 'neutral';
const DEFAULT_CONFIDENCE = 'low';

class AnnotationConflict extends Error {
  constructor(msg) { super(msg); this.code = 409; }
}

function emptyDoc(profileId, gameId) {
  return { schemaVersion: SCHEMA_VERSION, profileId, gameId, revision: 0, seats: {} };
}

/** 单座位标注清洗：白名单 + 截断 + 类型收敛；未知字段直接丢弃 */
function normalizeSeatAnnotation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  out.leaning = LEANINGS.includes(raw.leaning) ? raw.leaning : DEFAULT_LEANING;
  out.candidateRoleIds = Array.isArray(raw.candidateRoleIds)
    ? [...new Set(raw.candidateRoleIds.filter((r) => typeof r === 'string' && /^[a-z_]{1,32}$/.test(r)))].slice(0, MAX_CANDIDATES)
    : [];
  out.claimedRoleId = typeof raw.claimedRoleId === 'string' && /^[a-z_]{1,32}$/.test(raw.claimedRoleId) ? raw.claimedRoleId : null;
  out.confidence = CONFIDENCE.includes(raw.confidence) ? raw.confidence : DEFAULT_CONFIDENCE;
  out.note = typeof raw.note === 'string' ? raw.note.slice(0, MAX_NOTE) : '';
  out.evidenceSeq = Number.isInteger(raw.evidenceSeq) && raw.evidenceSeq > 0 ? raw.evidenceSeq : null;
  out.day = Number.isInteger(raw.day) && raw.day > 0 ? raw.day : null;
  out.phase = typeof raw.phase === 'string' && /^[a-z_]{1,16}$/.test(raw.phase) ? raw.phase : null;
  out.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 30) : null;
  return out;
}

/**
 * 单座位标注「是否有意义」——导出/导入计数用（FIX-07 的"导出计数虚高"收口）。
 *
 * 判据：只要**任一**字段与"刚清空 / 从未填写"的默认形态不同，就算有意义：
 *   leaning ≠ neutral、confidence ≠ low、候选非空、有自称、笔记非空、有证据序号、有天数、有阶段。
 * 默认值复用 DEFAULT_LEANING/DEFAULT_CONFIDENCE（与 normalizeSeatAnnotation 同一来源），不另立一套。
 *
 * ⚠ 这是**有意的启发式，不是缺陷**：用户若**故意**只记录"中立 + 低置信 + 空笔记"，
 * 该座位与"已清空"在数据上无法区分，于是不计入导出计数。取舍理由：FIX-07 的原始缺陷正是
 * 旧前端用 PUT 写全默认值来"清除标注"，导致导出计数虚高、存储只增不减；宁可漏计一个语义上
 * 等于空的座位，也不能让"清除"继续留下计数痕迹。**别把这条当 bug 来"修"。**
 */
function isMeaningfulSeatAnnotation(seat) {
  if (!seat || typeof seat !== 'object') return false;
  if (seat.leaning !== DEFAULT_LEANING) return true;
  if (seat.confidence !== DEFAULT_CONFIDENCE) return true;
  if (Array.isArray(seat.candidateRoleIds) && seat.candidateRoleIds.length > 0) return true;
  if (seat.claimedRoleId) return true;
  if (typeof seat.note === 'string' && seat.note.length > 0) return true;
  if (Number.isInteger(seat.evidenceSeq)) return true;
  if (Number.isInteger(seat.day)) return true;
  return typeof seat.phase === 'string' && seat.phase.length > 0;
}

/**
 * 一份标注文档里是否存在任何"有意义"的座位（导出计数 / 导入落地判据）。
 * 全默认 / 空 seats / 非对象 一律视为"没有笔记" —— 它们不该出现在导出包的 notes 里，
 * 也不该在导入时凭空创建一个只含默认值的标注文件（存储只增不减）。
 */
function hasMeaningfulAnnotations(doc) {
  const seats = (doc && typeof doc === 'object' && doc.seats) || {};
  if (typeof seats !== 'object') return false;
  return Object.keys(seats).some((k) => isMeaningfulSeatAnnotation(seats[k]));
}

class AnnotationStore {
  /** @param {{profilesRoot: string}} opts profilesRoot = WW_DATA_DIR/profiles */
  constructor({ profilesRoot, logger = null } = {}) {
    if (!profilesRoot) throw new Error('AnnotationStore 需要 profilesRoot');
    this.root = profilesRoot;
    this.logger = logger;
    this._queues = new Map();
  }

  file(profileId, gameId) {
    // 白名单校验再拼路径：profileId UUID、gameId 限制字符，拒绝路径穿越
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(profileId))) throw new Error('非法 profileId');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(gameId))) throw new Error('非法 gameId');
    return path.join(this.root, String(profileId), 'annotations', `${gameId}.json`);
  }

  _read(profileId, gameId, opts) {
    return this._readFile(this.file(profileId, gameId), profileId, gameId, opts);
  }
  /**
   * 读一份标注文档。**默认（strict=false）保持既有宽容语义**：任何失败都回空文档。
   *
   * `{ strict: true }`（只由导出这类"少一份就是丢数据"的路径开启）区分三种情况：
   *   1. 文件**不存在**（ENOENT）⇒ 仍是"这局没有笔记"，返回空文档 —— §7 明确允许；
   *   2. 文件存在但**不是合法 JSON**，或**不可读**（EACCES/EPERM/EISDIR…）⇒ 抛 { code: 500 }；
   *      §7 明文：「笔记文件缺失可表示无笔记；文件损坏或读取错误不能静默当作无笔记」。
   *   3. 解析成功但 schemaVersion/profileId/gameId 不匹配 ⇒ 仍是空文档（那是"不是本局的笔记"，不是损坏）。
   */
  _readFile(file, profileId, gameId, { strict = false } = {}) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (strict && e && e.code !== 'ENOENT') {
        throw Object.assign(new Error(`笔记文件不可读（${path.basename(file)}）：${e.code || e.message}`), { code: 500 });
      }
      return emptyDoc(profileId, gameId);
    }
    try {
      const doc = JSON.parse(raw);
      if (doc && doc.schemaVersion === SCHEMA_VERSION && doc.profileId === profileId && doc.gameId === gameId) return doc;
      return emptyDoc(profileId, gameId);
    } catch (e) {
      if (strict) {
        throw Object.assign(new Error(`笔记文件损坏（${path.basename(file)}）：不是合法 JSON：${e.message}`), { code: 500 });
      }
      return emptyDoc(profileId, gameId);
    }
  }

  get(profileId, gameId, opts) {
    return this._read(profileId, gameId, opts);
  }

  /**
   * 保存（整体替换 seats 内的指定座位，其余保留）。
   * @param opts {profileId, gameId, expectedRevision, seats: {seat: rawAnnotation}, actor: 'profile'|'god' 等}
   * expectedRevision 不匹配 → AnnotationConflict(409)
   * 读、版本校验、合并、写盘**全部在每文件串行队列内**完成（审核 P2-6）：
   * 旧实现读-校验在队列外，两次 expectedRevision:0 的并发写都能通过校验、后写整份覆盖先写。
   */
  async put({ profileId, gameId, expectedRevision, seats }) {
    const file = this.file(profileId, gameId); // 白名单/路径穿越校验先行，非法输入不进队列
    const prev = this._queues.get(file) || Promise.resolve();
    const job = prev.catch(() => {}).then(async () => {
      const doc = this._read(profileId, gameId);
      if (Number.isInteger(expectedRevision) && expectedRevision !== doc.revision) {
        throw new AnnotationConflict('另一窗口更新了笔记，请刷新后合并');
      }
      for (const seat of Object.keys(seats || {})) {
        if (!/^[0-9]{1,3}$/.test(seat)) continue;
        const norm = normalizeSeatAnnotation(seats[seat]);
        if (norm) doc.seats[seat] = norm;
      }
      doc.revision += 1;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = tmpPathFor(file); // FIX-12：命名统一（src/tmp-files.js），档案仓启动清理据此识别
      try {
        await fs.promises.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
        await fs.promises.rename(tmp, file);
      } finally { await fs.promises.unlink(tmp).catch(() => {}); }
      return doc;
    });
    this._queues.set(file, job);
    try {
      return await job;
    } finally {
      if (this._queues.get(file) === job) this._queues.delete(file);
    }
  }

  // FIX-14：这里曾有 putSync()——它在「每文件串行队列」之外同步完成读-校验-写，与入队的
  // put()/clearSeat() 并发时双方都 200、后写整份覆盖先写（审核 P2-6 同型竞态）。生产代码已无
  // 调用者（PUT 路由在 FIN-07 收口时改为 await put()），故整体删除：**写路径有且只有入队的
  // put()/clearSeat()**。防回归：test/annotations-store-contract.test.js 把"入口不存在"钉成契约。

  /** 清除某座位标注（撤销/清除当前标注） */
  async clearSeat({ profileId, gameId, seat, expectedRevision }) {
    // 与 put() 同一条每文件串行队列：读-校验-删除-写全部在锁内（P2-6 同型竞态，不能裸跑）
    const file = this.file(profileId, gameId);
    const prev = this._queues.get(file) || Promise.resolve();
    const job = prev.catch(() => {}).then(async () => {
      const doc = this._read(profileId, gameId);
      if (Number.isInteger(expectedRevision) && expectedRevision !== doc.revision) {
        throw new AnnotationConflict('另一窗口更新了笔记，请刷新后合并');
      }
      delete doc.seats[String(seat)];
      doc.revision += 1;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = tmpPathFor(file); // FIX-12：命名统一（src/tmp-files.js），档案仓启动清理据此识别
      try {
        await fs.promises.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
        await fs.promises.rename(tmp, file);
      } finally { await fs.promises.unlink(tmp).catch(() => {}); }
      return doc;
    });
    this._queues.set(file, job);
    try {
      return await job;
    } finally {
      if (this._queues.get(file) === job) this._queues.delete(file);
    }
  }
}

module.exports = {
  AnnotationStore, normalizeSeatAnnotation, AnnotationConflict, SCHEMA_VERSION, LEANINGS, CONFIDENCE,
  MAX_CANDIDATES, MAX_NOTE, DEFAULT_LEANING, DEFAULT_CONFIDENCE, isMeaningfulSeatAnnotation, hasMeaningfulAnnotations,
};
