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

const SCHEMA_VERSION = 2;
const LEANINGS = ['neutral', 'lean_good', 'lean_wolf', 'third_party', 'wolf', 'good']; // 'wolf'/'good'：方案 §4.2 示例直接使用，接受为合法值
const CONFIDENCE = ['low', 'medium', 'high'];
const MAX_CANDIDATES = 3;
const MAX_NOTE = 200;

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
  out.leaning = LEANINGS.includes(raw.leaning) ? raw.leaning : 'neutral';
  out.candidateRoleIds = Array.isArray(raw.candidateRoleIds)
    ? [...new Set(raw.candidateRoleIds.filter((r) => typeof r === 'string' && /^[a-z_]{1,32}$/.test(r)))].slice(0, MAX_CANDIDATES)
    : [];
  out.claimedRoleId = typeof raw.claimedRoleId === 'string' && /^[a-z_]{1,32}$/.test(raw.claimedRoleId) ? raw.claimedRoleId : null;
  out.confidence = CONFIDENCE.includes(raw.confidence) ? raw.confidence : 'low';
  out.note = typeof raw.note === 'string' ? raw.note.slice(0, MAX_NOTE) : '';
  out.evidenceSeq = Number.isInteger(raw.evidenceSeq) && raw.evidenceSeq > 0 ? raw.evidenceSeq : null;
  out.day = Number.isInteger(raw.day) && raw.day > 0 ? raw.day : null;
  out.phase = typeof raw.phase === 'string' && /^[a-z_]{1,16}$/.test(raw.phase) ? raw.phase : null;
  out.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 30) : null;
  return out;
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

  _read(profileId, gameId) {
    return this._readFile(this.file(profileId, gameId), profileId, gameId);
  }
  _readFile(file, profileId, gameId) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (doc && doc.schemaVersion === SCHEMA_VERSION && doc.profileId === profileId && doc.gameId === gameId) return doc;
      return emptyDoc(profileId, gameId);
    } catch (_) { return emptyDoc(profileId, gameId); }
  }

  get(profileId, gameId) {
    return this._read(profileId, gameId);
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
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      await fs.promises.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
      await fs.promises.rename(tmp, file);
      return doc;
    });
    this._queues.set(file, job);
    try {
      return await job;
    } finally {
      if (this._queues.get(file) === job) this._queues.delete(file);
    }
  }

  /** 同步保存（API 处理器用）：整体带 revision 校验；覆盖式更新指定座位 */
  putSync({ profileId, gameId, expectedRevision, seats }) {
    const doc = this._read(profileId, gameId);
    if (Number.isInteger(expectedRevision) && expectedRevision !== doc.revision) {
      throw Object.assign(new Error('另一窗口更新了笔记，请刷新后合并'), { code: 409 });
    }
    for (const seat of Object.keys(seats || {})) {
      if (!/^[0-9]{1,3}$/.test(seat)) continue;
      const norm = normalizeSeatAnnotation(seats[seat]);
      if (norm) doc.seats[seat] = norm;
    }
    doc.revision += 1;
    const file = this.file(profileId, gameId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return doc;
  }

  /** 清除某座位标注（撤销/清除当前标注） */
  async clearSeat({ profileId, gameId, seat, expectedRevision }) {
    const doc = this._read(profileId, gameId);
    if (Number.isInteger(expectedRevision) && expectedRevision !== doc.revision) {
      throw new AnnotationConflict('另一窗口更新了笔记，请刷新后合并');
    }
    delete doc.seats[String(seat)];
    doc.revision += 1;
    const file = this.file(profileId, gameId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify(doc, null, 2), 'utf8');
    return doc;
  }
}

module.exports = { AnnotationStore, normalizeSeatAnnotation, AnnotationConflict, SCHEMA_VERSION, LEANINGS, CONFIDENCE, MAX_CANDIDATES, MAX_NOTE };
