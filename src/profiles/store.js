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
const { STALE_TMP_MS, tmpPathFor, cleanupStaleTmp } = require('../tmp-files');
const {
  AVATAR_FILE, AVATAR_MIME, AVATAR_VERSION, prepareAvatar, validateAvatarBuffer,
} = require('./avatar');

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

/**
 * 自定义头像的取图 URL（§4.3）：**内容哈希版本化**，改了头像 URL 必变，缓存不可能串味。
 * 没有自定义头像 → null（前端按 avatarId 显示内置徽记；"不回退成破图"的判据就是这个 null）。
 */
function avatarUrlOf(prof) {
  const ca = prof && prof.customAvatar;
  if (!ca || !ca.sha256) return null;
  return `/api/profiles/${prof.id}/avatar?v=${ca.sha256}`;
}

/** 读文件，不存在返回 null（区分"没有旧文件"与"读失败"由调用方决定） */
function readFileOrNull(file) {
  try { return fs.readFileSync(file); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
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
    // FIX-12：启动清理本仓拥有的目录里崩溃遗留的原子写临时文件。
    // 与 api.js 共用同一套判据（src/tmp-files.js）；只扫顶层、只删常规文件、有年龄门。
    // **绝不进入 trash/**：回收站里是等待恢复的用户档案（含 restore.json 与 profile-dir），
    // 哪怕里面真躺着 tmp 也只有用户自己该决定怎么处理。
    this._cleanupStaleTmp();
    // 启动对账（验收 P1 修复的配套）：把「目录已搬进回收区，但索引/restore.json 没写完」这类
    // 崩溃或异常中断留下的中间态收敛掉。数据优先：删除没走完就让它走完（数据在回收区，可恢复），
    // 回滚失败的则把它搬回来。详见 _reconcileTrash。
    this._reconcileTrash();
  }

  /**
   * FIX-12：清理本仓各目录**顶层**的陈旧原子写临时文件（崩溃残渣）。
   *
   * 覆盖范围（一一对应真实的落盘点）：
   *   · `<root>/`                    —— index.json 的原子写残渣（`index.json.tmp-<pid>-<ts>`）
   *   · `<root>/<profileId>/`        —— profile.json / experiences.json 的原子写残渣
   *   · `<root>/<profileId>/annotations/` —— 私人标注的原子写残渣（AnnotationStore 写的就在这层）
   * 明确**不覆盖**（见方法末尾注释与报告的"诚实边界"）：
   *   · `<root>/trash/**`（用户数据，绝不动）
   *   · 不递归到更深的自定义子目录（本仓今天不产生，也没有别的生产者）
   * @param {{maxAgeMs?: number}} opts 年龄门（默认 10 分钟，见 STALE_TMP_MS）
   * @returns {number} 实际删除的文件数
   */
  _cleanupStaleTmp({ maxAgeMs = STALE_TMP_MS } = {}) {
    const dirs = [this.root];
    const trashName = path.basename(this.trashDir());
    try {
      for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === trashName) continue; // 回收站：绝不进入
        const dir = path.join(this.root, entry.name);
        dirs.push(dir);
        const anno = path.join(dir, 'annotations');
        if (fs.existsSync(anno)) dirs.push(anno);
      }
    } catch (_) { /* 根目录不可读：不影响启动 */ }
    const removed = [];
    for (const dir of dirs) {
      for (const name of cleanupStaleTmp(dir, { maxAgeMs })) removed.push(path.relative(this.root, path.join(dir, name)));
    }
    if (removed.length && this.logger) this.logger.info('profiles', `清理残留临时文件 ${removed.length} 个（${removed.join('、')}）`);
    return removed.length;
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
      const tmp = tmpPathFor(file); // FIX-12：命名统一走 src/tmp-files.js（启动清理据此识别）
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
    const tmp = tmpPathFor(file);
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
        // M1 §4.2：自定义头像元数据随档案摘要一起下发（旧档案没有该字段 → null，前端按 avatarId 工作）
        customAvatar: prof.customAvatar || null,
        avatarUrl: avatarUrlOf(prof),
        preferences: prof.preferences || { fontScale: 1, layout: 'reading', reducedMotion: false },
        createdAt: prof.createdAt, updatedAt: prof.updatedAt, revision: prof.revision,
        archivedAt: prof.archivedAt || null,
        // 排序语义（FIX-09；消费方 = web/app.js:1110 与 web/m/m.js:1185 的"按 lastUsedAt 倒序"）：
        //   lastUsedAt = **最近一次使用**（用这份档案开局时由 API 层 touch），updatedAt = 最近一次**编辑**。
        // 两者必须分开：旧实现回落 updatedAt，于是"最近改了个昵称"会冒充"最近用过"，界面排序看起来
        // 像是乱的（这正是 lastUsedAt 长期是死字段、排序实际按"最近编辑"的根因）。
        // 从未使用过的档案回落 createdAt（创建即首次可用），最后才回落 updatedAt（只在数据损坏、
        // 两个字段都缺失时才走到）。**绝不回落 updatedAt 作为常规路径。**
        lastUsedAt: prof.lastUsedAt || prof.createdAt || prof.updatedAt,
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
    // 同一时间戳给三个字段：createdAt/updatedAt/lastUsedAt 必须**严格相等**才谈得上
    // "从未使用过的档案按其创建时间排序"（分成两次 new Date() 会差 1ms，排序与断言都不确定）
    const now = new Date().toISOString();
    const prof = {
      schemaVersion: SCHEMA_VERSION,
      id: newId(),
      nickname: cleanNickname(nickname),
      avatarId: cleanAvatar(avatarId),
      bio: cleanBio(bio),
      preferences: { fontScale: 1, layout: 'reading', reducedMotion: false },
      createdAt: now,
      updatedAt: now,
      // FIX-09：创建即"首次可用"，落 lastUsedAt，让"从未使用过"的档案在排序里有确定位置
      // （否则只能回落 updatedAt，见 list() 的注释）
      lastUsedAt: now,
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

  // ---------- 自定义头像（M1 §4.2/§4.3）----------

  /**
   * 自定义头像的二进制落点：profiles/<profileId>/avatar.png（§4.2 固定的**唯一**路径）。
   * 顺带做 profileId 白名单校验（profileDir 内），非法 id 在碰盘之前就抛 400。
   */
  avatarFile(id) { return path.join(this.profileDir(id), AVATAR_FILE); }

  /**
   * 保存自定义头像（§4.2 写入顺序：**先写图片，再更新 profile.json**；任一步失败保留旧文件与旧元数据）。
   *
   * 完整步骤与每一步失败的后果：
   *   ① 预校验（体积/签名/结构/尺寸/色彩类型）——失败：一个字节都没写；
   *   ② 同目录临时文件（src/tmp-files.js 的 tmpPathFor，启动清理据此识别）写入最终字节；
   *   ③ **读回临时文件**逐字节比对并重算哈希——磁盘上真正落下的东西才是可信的（"校验完成后原子替换"）；
   *   ④ rename → avatar.png（同目录 rename，原子替换）；
   *   ⑤ 更新 profile.json 的 customAvatar（走 _atomicWrite，tmp→rename）。
   *
   * ④之后⑤之前失败（元数据没写成）必须把图片**回滚成旧字节**，否则"新图片 + 旧元数据"会让
   * GET/导出按旧哈希读新图（可检测，但用户看到的是莫名其妙的坏头像）。旧字节 ≤2MiB，留在内存里回滚，
   * 不额外产生需要清理的中间文件。
   *
   * 进程在④与⑤之间被杀是唯一的不可恢复窗口：磁盘上留下"新图片 + 旧元数据"。
   * 这一状态**不静默**——GET 与导出都按元数据哈希核对文件，核对失败会明确报错走 avatarId 兜底。
   *
   * @returns {Promise<{profile: object, avatarUrl: string}>}
   */
  async setAvatar(id, buffer, { expectedRevision } = {}) {
    return this._serialize(() => this._setAvatarInner(id, buffer, { expectedRevision }));
  }

  async _setAvatarInner(id, buffer, { expectedRevision } = {}) {
    const file = this.avatarFile(id); // 非法 id → ValidationError（不碰盘）
    const prof = this.get(id);        // 不存在 → NotFoundError
    if (prof.archivedAt) throw new ValidationError('已归档档案需先恢复才能编辑');
    this._checkRevision(prof, expectedRevision);
    const prepared = prepareAvatar(buffer); // ①（含 SHA-256：先算哈希再落盘）
    const oldBytes = readFileOrNull(file);  // 回滚用旧字节（不存在 → null）
    const tmp = tmpPathFor(file);
    let replaced = false;
    try {
      await fs.promises.writeFile(tmp, prepared.data);                          // ②
      const onDisk = await fs.promises.readFile(tmp);                           // ③
      // ③ 校验的是**从磁盘读回来的字节**（不是内存里那份 buffer）：结构再过一遍，并与内存校验
      //    得到的哈希逐位比对 —— 内容被篡改、只写了一半、写到了别处，都会在这里被抓住，随后才允许
      //    原子替换（④）。刻意**只保留这一条判据**：早先同时写了 `onDisk.equals(prepared.data)`
      //    与这行哈希比对，而"字节相等"成立时哈希必然相等 ⇒ 哈希那行是**永远不可达的死分支**
      //    （对它注入 if(false) 全绿，等于没有断言）。现在两条语义合成一条可被测试钉住的判据。
      let verified;
      try {
        verified = validateAvatarBuffer(onDisk);
      } catch (e) {
        throw new Error(`头像落盘校验失败：临时文件读回后结构不合法（${e.message}）`);
      }
      if (verified.sha256 !== prepared.sha256) {
        throw new Error('头像落盘校验失败：临时文件读回的字节与校验通过的字节不一致（SHA-256 不符）');
      }
      await fs.promises.rename(tmp, file);                                      // ④
      replaced = true;
      prof.customAvatar = {
        version: AVATAR_VERSION, mime: AVATAR_MIME,
        bytes: prepared.bytes, sha256: prepared.sha256,
        updatedAt: new Date().toISOString(),
      };
      prof.revision += 1;
      prof.updatedAt = prof.customAvatar.updatedAt;
      await this._atomicWrite(this.profileFile(id), JSON.stringify(prof, null, 2)); // ⑤
    } catch (e) {
      if (replaced) await this._rollbackAvatarFile(file, oldBytes);
      else { try { await fs.promises.unlink(tmp); } catch (_) { /* 临时文件已被启动清理兜底 */ } }
      throw e;
    }
    if (this.logger) this.logger.info('profiles', `自定义头像已更新（${id}，${prepared.bytes} 字节，sha256 ${prepared.sha256.slice(0, 12)}…）`);
    return { profile: prof, avatarUrl: avatarUrlOf(prof) };
  }

  /**
   * 删除自定义头像（§4.1「删除自定义头像」/§4.2 切回内置）：
   * **先原子更新档案元数据，再清理不再引用的图片**；清理失败只记可恢复告警，不让资料更新失败
   * （元数据已经指回 avatarId，残留文件不再被任何 URL 引用，删不掉只是占一块盘）。
   */
  async clearAvatar(id, { expectedRevision } = {}) {
    return this._serialize(() => this._clearAvatarInner(id, { expectedRevision }));
  }

  async _clearAvatarInner(id, { expectedRevision } = {}) {
    const file = this.avatarFile(id);
    const prof = this.get(id);
    if (prof.archivedAt) throw new ValidationError('已归档档案需先恢复才能编辑');
    this._checkRevision(prof, expectedRevision);
    if (!prof.customAvatar) return { profile: prof, avatarUrl: null }; // 幂等：本就没有自定义头像
    delete prof.customAvatar;
    prof.revision += 1;
    prof.updatedAt = new Date().toISOString();
    await this._atomicWrite(this.profileFile(id), JSON.stringify(prof, null, 2)); // 先更新元数据
    try {
      await fs.promises.unlink(file); // 再清理不再被引用的图片
    } catch (e) {
      if (e && e.code !== 'ENOENT' && this.logger) {
        this.logger.warn('profiles', `自定义头像文件清理失败（可恢复：${path.relative(this.root, file)}）：${e.message}`);
      }
    }
    return { profile: prof, avatarUrl: null };
  }

  /**
   * 读取自定义头像字节（GET 出图与导出共用）。三重核对，任何一环不过都不出图：
   *   ① 档案存在且带 customAvatar 元数据；② 文件在磁盘上；③ 文件结构合法 **且** 哈希等于元数据。
   * 语义码：404 = 没有/找不到/版本不匹配（前端据此回落 avatarId）；500 = 文件损坏或与元数据不一致。
   * @param {string} id profileId
   * @param {{expectedSha?: string|null}} opts expectedSha = URL 上的 ?v=（内容哈希）
   */
  readAvatar(id, { expectedSha = null } = {}) {
    const prof = this.get(id); // 不存在 → NotFoundError(404)
    const ca = prof.customAvatar;
    if (!ca || !ca.sha256) throw new NotFoundError('该档案没有自定义头像');
    if (expectedSha && expectedSha !== ca.sha256) throw new NotFoundError('该头像版本已过期（URL 内容哈希与当前头像不一致）');
    let data;
    try {
      data = fs.readFileSync(this.avatarFile(id));
    } catch (e) {
      if (e && e.code === 'ENOENT') throw new NotFoundError('自定义头像文件缺失');
      throw e;
    }
    let checked;
    try {
      checked = validateAvatarBuffer(data);
    } catch (e) {
      throw Object.assign(new Error(`自定义头像文件损坏：${e.message}`), { code: 500 });
    }
    if (checked.sha256 !== ca.sha256) {
      throw Object.assign(new Error(
        `自定义头像与档案元数据不一致（文件 ${checked.sha256.slice(0, 12)}… ≠ 档案记录 ${ca.sha256.slice(0, 12)}…）`
      ), { code: 500 });
    }
    return { data, mime: AVATAR_MIME, sha256: checked.sha256, bytes: checked.bytes, etag: `"${checked.sha256}"` };
  }

  /** expectedRevision 乐观并发（与 update 同语义：只有数字才是校验意图，缺省不校验） */
  _checkRevision(prof, expectedRevision) {
    if (typeof expectedRevision === 'number' && expectedRevision !== prof.revision) {
      throw new ConflictError(`另一窗口已更新该档案（当前 revision ${prof.revision}）`);
    }
  }

  /** 把头像文件回滚成旧字节（oldBytes=null ⇒ 旧状态是"没有文件"）。回滚失败必须留告警，不静默。 */
  async _rollbackAvatarFile(file, oldBytes) {
    try {
      if (oldBytes === null) { await fs.promises.unlink(file); return; }
      const tmp = tmpPathFor(file);
      await fs.promises.writeFile(tmp, oldBytes);
      await fs.promises.rename(tmp, file);
    } catch (e) {
      if (this.logger) {
        this.logger.warn('profiles', `头像回滚失败（${path.relative(this.root, file)}）：${e.message}；元数据未更新，GET 会按哈希核对失败并回落内置头像`);
      }
    }
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
        idx.profiles.push({ id: prof.id, nickname: prof.nickname, avatarId: prof.avatarId, archivedAt: prof.archivedAt || null, updatedAt: prof.updatedAt, lastUsedAt: prof.lastUsedAt || prof.createdAt || null });
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

  /**
   * 标记"最近使用"（FIX-09：让 lastUsedAt 真正生效）。
   *
   * 语义边界（诚实说明）：服务端能观测到的"使用"只有**用这份档案开了一局**（API 层的 createGame
   * 会带 profileId）。客户端档案管理里的"选用"按钮是纯本地状态（web/app.js 的 onSelectProfile
   * 只写 localStorage），服务端看不到，所以 lastUsedAt ≠ "用户点开过它"，而是"最近一次以它开局"。
   *
   * 可靠性（FIX-09 的第二个缺陷）：旧实现是"同步 writeFileSync 直写 + 吞掉所有异常"，既绕开
   * 原子替换（写到一半被杀 → profile.json 损坏），也绕开 create/update 的串行队列（与 PATCH 并发
   * 时互相覆盖）。现在：走 _serialize（与 create/update/trash 同一条队）+ _atomicWrite（tmp→rename）。
   *
   * 写多少：只写 profile.json 一份（索引摘要里的 lastUsedAt 只是历史快照，list() 一律以
   * profile.json 为准，故不必为了它多写一次 index.json）——即"每局开局一次小文件原子写"。
   *
   * 失败语义：**抛给调用方**（不做静默吞错）。是否让"记录使用痕迹"的失败影响主流程，
   * 由调用方按业务优先级决定：api.js 的 createGame 选择吞错 + warn（开局绝不能因为记不上
   * 使用时间而失败，见 _touchProfileUsage）。
   * @returns {Promise<object>} 更新后的 profile（归档档案直接原样返回，不写盘）
   */
  async touch(id) {
    return this._serialize(() => this._touchInner(id));
  }

  async _touchInner(id) {
    const prof = this.get(id); // 不存在 → NotFoundError，由调用方决定怎么处理
    if (prof.archivedAt) return prof; // 归档档案不算"使用"，也不该被写盘修改
    prof.lastUsedAt = new Date().toISOString();
    await this._atomicWrite(this.profileFile(id), JSON.stringify(prof, null, 2));
    return prof;
  }
}

module.exports = {
  ProfileStore, ValidationError, ConflictError, NotFoundError, AVATARS, MAX_NICKNAME, MAX_BIO, SCHEMA_VERSION,
  newId, isValidId, avatarUrlOf,
};
