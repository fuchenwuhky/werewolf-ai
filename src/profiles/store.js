/**
 * store.js — 本机玩家档案存储（整改方案 DATA-01，docs/dual-platform-optimization-plan.md §3.3）
 *
 * 设计要点：
 *   · 零运行时依赖：JSON + 临时文件→原子替换，与 saves/ 同一套可靠性语义；
 *   · 按资源排队写（同一文件不并发写），失败不得假装成功；
 *   · revision 乐观并发：PATCH 带 expectedRevision，过期写抛 409 语义错误；
 *   · profileId 为 UUID，路径拼接前先白名单校验，拒绝路径穿越；
 *   · 归档代替删除；物理回收在 trash/，最后一份可用档案不可归档。
 *
 * 目录布局（WW_DATA_DIR 下）：
 *   profiles/index.json                    # {schemaVersion, revision, profiles:[摘要]}
 *   profiles/<id>/profile.json             # 档案与偏好（含 revision）
 *   profiles/<id>/annotations/<gid>.json   # 私人标注（AnnotationStore 管）
 *   profiles/<id>/experiences.json         # 本档案 AI 经验池
 *   profiles/trash/<archiveId>/...         # 归档删除回收区
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const MAX_NICKNAME = 20;
const MAX_BIO = 100;
const AVATARS = ['scholar', 'hunter', 'seer', 'wolf', 'witch', 'night', 'candle', 'mask'];

class ConflictError extends Error {
  constructor(msg) { super(msg); this.code = 409; }
}
class ValidationError extends Error {
  constructor(msg) { super(msg); this.code = 400; }
}
class NotFoundError extends Error {
  constructor(msg) { super(msg); this.code = 404; }
}

function newId() { return crypto.randomUUID(); }
function isValidId(id) { return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id); }

/** 昵称：去首尾空白后 1–20 个可见字符（控制字符直接拒绝） */
function cleanNickname(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s.length) throw new ValidationError('昵称不能为空');
  if (s.length > MAX_NICKNAME) throw new ValidationError(`昵称最长 ${MAX_NICKNAME} 个字符`);
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new ValidationError('昵称含非法控制字符');
  return s;
}
function cleanBio(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s.length > MAX_BIO) throw new ValidationError(`简介最长 ${MAX_BIO} 个字符`);
  return s;
}
function cleanAvatar(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 'scholar';
  if (!AVATARS.includes(s)) throw new ValidationError(`未知头像：${s}`);
  return s;
}

class ProfileStore {
  /** @param {{dataDir: string, logger?: object}} opts dataDir = WW_DATA_DIR */
  constructor({ dataDir, logger = null } = {}) {
    if (!dataDir) throw new Error('ProfileStore 需要 dataDir');
    this.root = path.join(dataDir, 'profiles');
    this.logger = logger;
    this._queues = new Map(); // 文件路径 → 上一次写 promise（同文件串行）
    // 审核 P1-3：并发创建/更新时 read-check-write 周期必须串行化，否则丢档案
    this._mutex = Promise.resolve();
    fs.mkdirSync(this.root, { recursive: true });
    // 启动对账（验收 P1 修复的配套）：把「目录已搬进回收区，但索引/restore.json 没写完」这类
    // 崩溃或异常中断留下的中间态收敛掉。数据优先：删除没走完就让它走完（数据在回收区，可恢复），
    // 回滚失败的则把它搬回来。详见 _reconcileTrash。
    this._reconcileTrash();
  }

  indexPath() { return path.join(this.root, 'index.json'); }
  profileDir(id) {
    if (!isValidId(id)) throw new ValidationError('非法 profileId');
    return path.join(this.root, id);
  }
  profileFile(id) { return path.join(this.profileDir(id), 'profile.json'); }
  trashDir() { return path.join(this.root, 'trash'); }

  /** 原子写：临时文件 → rename；同一路径排队 */
  async _atomicWrite(file, data) {
    const prev = this._queues.get(file) || Promise.resolve();
    const job = prev.catch(() => {}).then(async () => {
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      await fs.promises.writeFile(tmp, data, 'utf8');
      await fs.promises.rename(tmp, file); // 同目录 rename，原子替换
    });
    this._queues.set(file, job);
    await job;
    // 队列尾部清理，防 Map 无限增长
    if (this._queues.get(file) === job) this._queues.delete(file);
  }

  /** 同步版原子写：启动对账/回收区恢复这类不能 await 的路径用（同样是 tmp → rename） */
  _atomicWriteSync(file, data) {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
  }

  /** 串行化 read-check-write 周期（审核 P1-3）：并发创建不丢档案 */
  _serialize(fn) {
    const prev = this._mutex;
    this._mutex = prev.then(fn, fn);
    return this._mutex;
  }

  _readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { return fallback; }
  }

  /** 索引：{schemaVersion, revision, profiles:[{id,nickname,avatarId,archivedAt,updatedAt,lastUsedAt}]} */
  _readIndex() {
    const idx = this._readJson(this.indexPath(), { schemaVersion: SCHEMA_VERSION, revision: 0, profiles: [] });
    if (!Array.isArray(idx.profiles)) idx.profiles = [];
    return idx;
  }
  async _writeIndex(idx) {
    idx.revision = (idx.revision || 0) + 1;
    await this._atomicWrite(this.indexPath(), JSON.stringify(idx, null, 2));
  }

  /** 全量档案（含归档）；index 摘要与 profile.json 冲突时以 profile.json 为准修复索引 */
  list({ includeArchived = true } = {}) {
    const idx = this._readIndex();
    const out = [];
    for (const p of idx.profiles) {
      const prof = this._readJson(this.profileFile(p.id), null);
      if (!prof) continue; // profile.json 缺失：跳过并保留索引（不静默删除）
      if (!includeArchived && prof.archivedAt) continue;
      out.push({
        id: prof.id, nickname: prof.nickname, avatarId: prof.avatarId, bio: prof.bio,
        preferences: prof.preferences || { fontScale: 1, layout: 'reading', reducedMotion: false },
        createdAt: prof.createdAt, updatedAt: prof.updatedAt, revision: prof.revision,
        archivedAt: prof.archivedAt || null,
        lastUsedAt: prof.lastUsedAt || prof.updatedAt,
      });
    }
    return out;
  }

  get(id) {
    const prof = this._readJson(this.profileFile(id), null);
    if (!prof) throw new NotFoundError(`档案不存在：${id}`);
    return prof;
  }

  /** 创建档案。返回完整 profile */
  async create({ nickname, avatarId, bio = '', preferences } = {}) {
    return this._serialize(() => this._createInner({ nickname, avatarId, bio, preferences }));
  }

  async _createInner({ nickname, avatarId, bio = '', preferences } = {}) {
    const prof = {
      schemaVersion: SCHEMA_VERSION,
      id: newId(),
      nickname: cleanNickname(nickname),
      avatarId: cleanAvatar(avatarId),
      bio: cleanBio(bio),
      preferences: { fontScale: 1, layout: 'reading', reducedMotion: false },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
      revision: 1,
    };
    // 偏好继承（PROF-04 导入用）：与 _updateInner 同一套白名单，非法字段一律回落默认
    if (preferences && typeof preferences === 'object' && !Array.isArray(preferences)) {
      const p = preferences;
      prof.preferences = {
        fontScale: Number(p.fontScale) > 0 ? Math.min(Number(p.fontScale), 3) : prof.preferences.fontScale,
        layout: ['reading', 'compact'].includes(p.layout) ? p.layout : prof.preferences.layout,
        reducedMotion: typeof p.reducedMotion === 'boolean' ? p.reducedMotion : prof.preferences.reducedMotion,
      };
    }
    const idx = this._readIndex();
    idx.profiles.push({ id: prof.id, nickname: prof.nickname, avatarId: prof.avatarId, archivedAt: null, updatedAt: prof.updatedAt });
    fs.mkdirSync(this.profileDir(prof.id), { recursive: true });
    await this._atomicWrite(this.profileFile(prof.id), JSON.stringify(prof, null, 2));
    await this._writeIndex(idx);
    return prof;
  }

  /**
   * 更新档案（资料/偏好/归档恢复）。
   * @param {object} patch {expectedRevision, nickname?, avatarId?, bio?, preferences?, archive?, restore?}
   *  expectedRevision 不匹配 → ConflictError(409)
   */
  async update(id, patch = {}) {
    return this._serialize(() => this._updateInner(id, patch));
  }

  async _updateInner(id, patch = {}) {
    const prof = this.get(id);
    if (prof.archivedAt && !patch.restore) throw new ValidationError('已归档档案需先恢复才能编辑');
    if (typeof patch.expectedRevision === 'number' && patch.expectedRevision !== prof.revision) {
      throw new ConflictError(`另一窗口已更新该档案（当前 revision ${prof.revision}）`);
    }
    if (patch.nickname !== undefined) prof.nickname = cleanNickname(patch.nickname);
    if (patch.avatarId !== undefined) prof.avatarId = cleanAvatar(patch.avatarId);
    if (patch.bio !== undefined) prof.bio = cleanBio(patch.bio);
    if (patch.preferences && typeof patch.preferences === 'object' && !Array.isArray(patch.preferences)) {
      const p = patch.preferences;
      prof.preferences = {
        fontScale: Number(p.fontScale) > 0 ? Math.min(Number(p.fontScale), 3) : prof.preferences.fontScale,
        layout: ['reading', 'compact'].includes(p.layout) ? p.layout : prof.preferences.layout,
        reducedMotion: typeof p.reducedMotion === 'boolean' ? p.reducedMotion : prof.preferences.reducedMotion,
      };
    }
    const now = new Date().toISOString();
    if (patch.archive) {
      // 最后一份可用档案不可归档
      const usable = this.list({ includeArchived: false }).filter((p) => p.id !== id).length;
      if (!usable) throw new ValidationError('最后一份可用档案不可归档');
      prof.archivedAt = now;
    }
    if (patch.restore) { prof.archivedAt = null; }
    prof.revision += 1;
    prof.updatedAt = now;
    await this._atomicWrite(this.profileFile(id), JSON.stringify(prof, null, 2));
    // 同步索引摘要
    const idx = this._readIndex();
    const row = idx.profiles.find((p) => p.id === id);
    if (row) { row.nickname = prof.nickname; row.avatarId = prof.avatarId; row.archivedAt = prof.archivedAt || null; row.updatedAt = now; }
    await this._writeIndex(idx);
    return prof;
  }

  /**
   * 删除（仅归档态）：移入 trash/<archiveId>/，返回恢复信息。
   * 活动对局归属该档案时由调用方（API 层）拒绝——本层只管数据移动。
   */
  async trash(id, { activeGames = 0 } = {}) {
    return this._serialize(() => this._trashInner(id, { activeGames }));
  }

  async _trashInner(id, { activeGames = 0 } = {}) {
    const prof = this.get(id);
    if (!prof.archivedAt) throw new ValidationError('只能删除已归档的档案');
    if (activeGames > 0) throw new ValidationError(`该档案仍有 ${activeGames} 局进行中，不能删除`);
    const archiveId = `${Date.now()}-${id}`;
    const dest = path.join(this.trashDir(), archiveId);
    const srcDir = this.profileDir(id);
    const dirDest = path.join(dest, 'profile-dir');
    const restoreFile = path.join(dest, 'restore.json');
    const meta = (state) => JSON.stringify({ id, state, profile: prof, trashedAt: new Date().toISOString() }, null, 2);
    // ⚠ 顺序是关键（验收 P1）：**先把数据搬进回收区并写好 restore.json，最后才动索引**。
    // 反过来（旧实现）会留下两种不可接受的中间态：
    //   ① rename 失败 → 档案从索引和界面消失，文件却还在原地；
    //   ② 目录已进回收区但没有 restore.json → restoreFromTrash 永远找不到它，删除变得不可恢复。
    // 审核（补写反例同源问题）：目标父目录必须先建好——rename 的 dest 是 trash/<archiveId>/profile-dir，
    // 两级都不存在时 rename 会 ENOENT。
    fs.mkdirSync(dest, { recursive: true });
    try {
      fs.renameSync(srcDir, dirDest);
    } catch (e) {
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {} // 当成没发生，别留空壳
      throw e;
    }
    try {
      fs.writeFileSync(restoreFile, meta('trashed'));
    } catch (e) {
      // restore.json 写不进去 → 立刻搬回来，保持"档案还在"的原状
      try { fs.renameSync(dirDest, srcDir); fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
      throw e;
    }
    const idx = this._readIndex();
    idx.profiles = idx.profiles.filter((p) => p.id !== id);
    try {
      await this._writeIndex(idx);
    } catch (e) {
      // 索引写失败 → 把数据搬回来，让档案继续可用（否则界面与磁盘不一致）
      try {
        fs.renameSync(dirDest, srcDir);
        fs.rmSync(dest, { recursive: true, force: true });
      } catch (e2) {
        // 回滚也失败：把回收区标成 failed，启动对账会把它搬回来；错误信息必须可读
        try { fs.writeFileSync(restoreFile, meta('failed')); } catch (_) {}
        throw new Error(`删除档案失败且回滚未完成（${e2.message}）；数据仍在回收区 ${archiveId}，启动时会自动搬回`);
      }
      throw e;
    }
    return { archiveId, dest };
  }

  /** 列出回收区里可恢复的档案（供恢复入口展示） */
  listTrash() {
    const trash = this.trashDir();
    if (!fs.existsSync(trash)) return [];
    return fs.readdirSync(trash).map((archiveId) => {
      const p = path.join(trash, archiveId);
      const meta = this._readJson(path.join(p, 'restore.json'), null);
      return {
        archiveId,
        id: (meta && meta.id) || null,
        state: (meta && meta.state) || 'unknown',
        trashedAt: (meta && meta.trashedAt) || null,
        nickname: (meta && meta.profile && meta.profile.nickname) || null,
        restorable: !!(meta && meta.id) && fs.existsSync(path.join(p, 'profile-dir')),
      };
    // 只列**真正可恢复**的条目。恢复成功后目录已被搬回原位，回收区只剩 restore.json 墓碑；
    // 照目录列会让用户看到"恢复成功但回收站里还挂着一条不可恢复"的错觉（前端真机实测反馈）。
    // 墓碑仍留在磁盘上供启动对账与诊断使用，只是不再出现在接口与界面里。
    }).filter((t) => t.restorable)
      .sort((a, b) => String(b.archiveId).localeCompare(String(a.archiveId)));
  }

  /** 从回收区恢复档案目录（恢复路由 / 启动对账共用） */
  restoreFromTrash(archiveId) {
    if (!/^[0-9A-Za-z-]+$/.test(String(archiveId))) throw new ValidationError('非法 archiveId');
    const meta = this._readJson(path.join(this.trashDir(), String(archiveId), 'restore.json'), null);
    if (!meta || !meta.id) throw new NotFoundError('回收区没有该档案');
    const src = path.join(this.trashDir(), String(archiveId), 'profile-dir');
    if (!fs.existsSync(src)) throw new NotFoundError('回收区没有该档案');
    return this._restoreDir(meta.id, src, archiveId);
  }

  /**
   * 把回收区里的档案目录搬回原位并补索引（同步；路由侧请在 _serialize 内调用）。
   * 用 rename 而不是 cpSync：同盘 rename 是原子的，复制到一半被杀会留下"半个档案"。
   */
  _restoreDir(id, srcDir, archiveId) {
    const dest = this.profileDir(id);
    if (fs.existsSync(dest)) throw new ConflictError('档案位置已被占用，无法恢复（可能上次恢复未清理）');
    fs.renameSync(srcDir, dest);
    const prof = this._readJson(this.profileFile(id), null);
    if (prof) {
      const idx = this._readIndex();
      if (!idx.profiles.some((p) => p.id === prof.id)) {
        idx.profiles.push({ id: prof.id, nickname: prof.nickname, avatarId: prof.avatarId, archivedAt: prof.archivedAt || null, updatedAt: prof.updatedAt, lastUsedAt: prof.lastUsedAt || null });
        idx.revision = (idx.revision || 0) + 1;
        // 走原子写：原先 fs.writeFileSync 直写，既没有 tmp→rename 的原子性，也会和并发写互相覆盖
        this._atomicWriteSync(this.indexPath(), JSON.stringify(idx, null, 2));
      }
      if (this.logger) this.logger.warn('profiles', `已从回收区恢复档案 ${id}（${archiveId}）`);
    }
    return prof;
  }

  /**
   * 启动对账（验收 P1）：把「目录已搬进回收区，但索引/restore.json 没写完」这类中断留下的
   * 中间态收敛掉。只有"墓碑"（restore.json 在、目录已不在）的正常回收区不动。
   *   ① state=failed（删除失败、回滚也没成功）→ 搬回来，档案继续可用；
   *   ② 没有 restore.json（搬到一半被杀）→ 把删除补完：补写 restore.json（数据仍在回收区，
   *      可恢复），并确保索引不再列它；
   *   ③ 目录还在、restore.json 正常 → 同样把删除补完（索引若还列着就摘掉）。
   * 三种情况都以「数据不丢」为准：要么档案可用，要么数据完整躺在可恢复的回收区里。
   */
  _reconcileTrash() {
    const trash = this.trashDir();
    if (!fs.existsSync(trash)) return;
    let entries = [];
    try { entries = fs.readdirSync(trash); } catch (_) { return; }
    const warn = (msg) => { if (this.logger) this.logger.warn('profiles', msg); };
    for (const archiveId of entries) {
      const dir = path.join(trash, archiveId);
      const src = path.join(dir, 'profile-dir');
      if (!fs.existsSync(src)) continue;
      const metaFile = path.join(dir, 'restore.json');
      const meta = this._readJson(metaFile, null);
      const id = (meta && meta.id) || String(archiveId).replace(/^\d+-/, '');
      if (!isValidId(id)) { warn(`启动对账：回收区 ${archiveId} 无法识别归属，保持原样（需手工处理）`); continue; }
      try {
        if (meta && meta.state === 'failed') {
          this._restoreDir(id, src, archiveId);
          warn(`启动对账：回收区 ${archiveId} 上次删除失败，已把档案搬回原位（${id}）`);
          continue;
        }
        if (!meta) {
          const prof = this._readJson(path.join(src, 'profile.json'), null);
          fs.writeFileSync(metaFile, JSON.stringify({ id, state: 'trashed', profile: prof, trashedAt: new Date().toISOString(), reconciled: true }, null, 2));
        }
        const idx = this._readIndex();
        const before = idx.profiles.length;
        idx.profiles = idx.profiles.filter((p) => p.id !== id);
        if (idx.profiles.length !== before) {
          idx.revision = (idx.revision || 0) + 1;
          this._atomicWriteSync(this.indexPath(), JSON.stringify(idx, null, 2));
        }
        warn(`启动对账：回收区 ${archiveId} 的删除已补完（${id} 数据仍在回收区，可恢复）`);
      } catch (e) {
        warn(`启动对账：${archiveId} 处理失败（${e.message}），保持原样，可手工处理`);
      }
    }
  }

  /** 标记最近使用（切档/开局时调用；轻量，只动索引与 profile 的 lastUsedAt） */
  touch(id) {
    try {
      const prof = this.get(id);
      prof.lastUsedAt = new Date().toISOString();
      fs.writeFileSync(this.profileFile(id), JSON.stringify(prof, null, 2));
      const idx = this._readIndex();
      const row = idx.profiles.find((p) => p.id === id);
      if (row) { row.lastUsedAt = prof.lastUsedAt; fs.writeFileSync(this.indexPath(), JSON.stringify(idx, null, 2)); }
    } catch (e) { if (this.logger) this.logger.warn('profiles', `touch 失败：${e.message}`); }
  }
}

module.exports = { ProfileStore, ValidationError, ConflictError, NotFoundError, AVATARS, MAX_NICKNAME, MAX_BIO, SCHEMA_VERSION, newId, isValidId };
