/**
 * migration.js — 档案/归属一次性迁移（整改方案 DATA-02，§3.5）
 *
 * 幂等契约：游标文件 migrations/profiles-v1.json 记录已完成步骤；每步可重入。
 * 步骤：
 *   1 backup   把 index.json 与将触碰的 saves/*.json 复制进 migrations/backup-<ts>/
 *   2 default  创建「默认玩家」档案（UUID），重复运行不产生第二个默认档案
 *   3 own-tag  为无归属存档打 ownerProfileId/ownerNicknameSnapshot（默认档案）
 *   4 exp      旧经验池 saves/experiences.json 归属默认档案（零拷贝：默认档案经验池指向原路径）
 *   4b exp-owner 把「旧经验池归谁」**钉死到一个 UUID**（migrations/legacy-experience-owner）
 *   5 done     写完成标记
 *
 * 失败语义：任何一步抛错都保留现场，重跑从游标继续；不删除源文件。
 *
 * exp-owner（M0 数据归属硬要求，docs/next-stage-implementation-plan.md:56）：
 *   旧池在 saves/experiences.json（零拷贝，没有搬进 profiles/<id>/），"它归谁"必须有一个
 *   与「当前默认档案」无关的持久化答案——否则默认一换，旧池就跟着默认标记跑到别人名下。
 *   故把归属写成一份**只在首次**落盘的归属标记（UUID），此后任何切换/归档/删除/重建都不动它：
 *   · 幂等：已有可解析标记 → 原样返回，绝不改写（重跑/重启/换默认都不改）；
 *   · 原子写：临时文件 + rename（命名走 src/tmp-files.js，与仓库其余原子写一致）；
 *   · 校验：写完读回比对，不一致以磁盘为准并告警；
 *   · 失败关闭：标记存在但损坏、或游标说已钉过而标记丢了 → **不猜**（返回 null，旧池暂时无主），
 *     宁可旧池暂时不注入，也不把它交给某个档案继承。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { tmpPathFor } = require('../tmp-files');
const { isValidId } = require('./store');

const CURSOR = 'profiles-v1.json';
/** 旧经验池归属标记（内容 = 拥有 saves/experiences.json 的 profileId，UUID） */
const LEGACY_EXP_OWNER = 'legacy-experience-owner';

/**
 * 读旧经验池归属标记（唯一读点，Api 层与迁移层共用）。只认 UUID。
 * @param {string} dataDir WW_DATA_DIR
 * @returns {string|null} 拥有旧池的 profileId；缺失/损坏/非法一律 null（= 无主，失败关闭）
 */
function readLegacyExperienceOwner(dataDir) {
  try {
    const raw = fs.readFileSync(path.join(dataDir, 'migrations', LEGACY_EXP_OWNER), 'utf8').trim();
    return isValidId(raw) ? raw : null;
  } catch (_) { return null; }
}

class ProfileMigration {
  /** @param {{dataDir, profilesStore, logger}} opts */
  constructor({ dataDir, profilesStore, logger = null } = {}) {
    this.dataDir = dataDir;
    this.store = profilesStore;
    this.logger = logger;
    this.dir = path.join(dataDir, 'migrations');
    this.cursorFile = path.join(this.dir, CURSOR);
    this.savesDir = path.join(dataDir, 'saves');
    this.done = new Set(this._readCursor().done || []);
    // 持久化的默认档案 ID（防止改名后重复创建）
    try { this.defaultId = fs.readFileSync(path.join(this.dir, 'default-profile-id'), 'utf8').trim() || null; } catch (_) { this.defaultId = null; }
  }

  _readCursor() {
    try { return JSON.parse(fs.readFileSync(this.cursorFile, 'utf8')); } catch (_) { return {}; }
  }
  _mark(step) {
    this.done.add(step);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.cursorFile, JSON.stringify({ cursor: CURSOR, done: [...this.done], at: new Date().toISOString() }, null, 2));
  }
  _log(msg) { if (this.logger) this.logger.info('migration', msg); }

  /** 默认档案 id（没有则创建）。返回 profileId（异步：create 是原子写） */
  /** 默认档案 id：持久化到游标（_mark 已有的 done set），改名/重启后不重复创建 */
  async ensureDefaultProfile() {
    // ① 游标中已记录 → 验证档案存在且未归档
    if (this.defaultId) {
      try {
        const prof = this.store.get(this.defaultId);
        if (prof && !prof.archivedAt) return this.defaultId;
      } catch (_) {}
      // 已被删除或已归档 → 清除持久化标记，走下方创建逻辑。
      // FIX-11：这里必须走 _clearDefaultId()（置空内存值 + 删掉 default-profile-id 文件）。
      // 旧实现是 `this.defaultId = null; this._persistDefaultId();`，而 _persistDefaultId 在 defaultId
      // 为空时**直接 return**，那个失效的 id 原封不动留在磁盘上，每次启动都被重读一遍。
      this._clearDefaultId();
    }
    // ② 按昵称查找（兼容升级）
    const profiles = this.store.list({ includeArchived: true });
    const legacy = profiles.find((p) => p.nickname === '默认玩家' && !p.archivedAt);
    if (legacy) {
      this.defaultId = legacy.id;
      this._persistDefaultId();
      return legacy.id;
    }
    // ③ 首次创建
    const prof = await this.store.create({ nickname: '默认玩家', avatarId: 'scholar', bio: '升级时自动创建的本机档案' });
    this.defaultId = prof.id;
    this._persistDefaultId();
    return prof.id;
  }
  /**
   * 持久化默认档案 id（唯一写点）。
   * FIX-11：defaultId 为空时必须**把文件删掉**——旧实现开头是 `if (!this.defaultId) return;`，
   * 于是"清除默认档案"永远清不掉磁盘上的陈旧 id：重启后它又被读回来，比对失败 → 再建一个「默认玩家」。
   */
  _persistDefaultId() {
    const file = path.join(this.dir, 'default-profile-id');
    if (!this.defaultId) {
      try { fs.rmSync(file, { force: true }); } catch (_) { /* 删不掉不影响启动 */ }
      return;
    }
    fs.mkdirSync(this.dir, { recursive: true }); // 首次迁移由 _mark 建目录；独立调用（setDefaultId）时补建
    fs.writeFileSync(file, this.defaultId);
  }

  /** 清除默认档案标记（内存 + 磁盘）：默认档案被归档/删除，或已无可用档案可指时调用 */
  _clearDefaultId() {
    this.defaultId = null;
    this._persistDefaultId();
  }

  /** 旧经验池归属标记的磁盘路径 */
  legacyExperienceOwnerFile() { return path.join(this.dir, LEGACY_EXP_OWNER); }

  /** 旧经验池归谁（UUID）。没有答案时返回 null（= 无主，绝不用"当前默认"顶替） */
  legacyExperienceOwnerId() {
    if (this._legacyExpOwner !== undefined) return this._legacyExpOwner;
    this._legacyExpOwner = readLegacyExperienceOwner(this.dataDir);
    return this._legacyExpOwner;
  }

  /**
   * 把旧经验池钉死到原 UUID（幂等：只在**首次**落盘，之后任何调用都不改写）。
   *
   * 为什么不能"每次启动同步成当前默认"：那样默认一换，旧池的归属就跟着换 —— 正是要禁止的继承。
   * 所以只有"从未钉过"（游标里没有 exp-owner）时才写入；写过一次之后：
   *   · 标记文件丢了 → 告警 + 返回 null（旧池无主：宁可暂时不注入，也不交给别人继承）；
   *   · 标记文件损坏 → 同上（失败关闭，不猜）。
   * 「游标 + 标记文件」双记录：单份损坏不会变成一次静默的归属转移。
   * @param {string} id 候选归属（迁移/启动时的默认档案 UUID）
   * @returns {string|null} 钉住后的归属 UUID
   */
  pinLegacyExperienceOwner(id) {
    const existing = readLegacyExperienceOwner(this.dataDir);
    if (existing) { this._legacyExpOwner = existing; return existing; } // 幂等：钉过就不动
    const file = this.legacyExperienceOwnerFile();
    if (fs.existsSync(file)) {
      this._legacyExpOwner = null; // 失败关闭：损坏的标记不猜
      this._log(`旧经验池归属标记不可解析（${file}）：旧池暂时无主，不会被任何档案继承`);
      return null;
    }
    if (this.done.has('exp-owner')) {
      this._legacyExpOwner = null; // 曾钉过而标记丢失：同样不猜
      this._log(`旧经验池归属标记缺失（${file}）但游标记录已钉过：旧池暂时无主，不重新指定归属`);
      return null;
    }
    if (!isValidId(id)) return null; // 没有可钉的 UUID（迁移失败降级）→ 下次启动再试
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = tmpPathFor(file);
    fs.writeFileSync(tmp, String(id));
    fs.renameSync(tmp, file);
    const back = readLegacyExperienceOwner(this.dataDir); // 校验：以磁盘为准
    if (back !== id) this._log(`旧经验池归属标记写后校验不一致（期望 ${id}，读回 ${back}），以磁盘为准`);
    this._legacyExpOwner = back;
    if (back) this._log(`旧经验池 saves/experiences.json 归属钉死到档案 ${back}`);
    return back;
  }

  /**
   * 把默认档案重指向另一份档案（FIX-11；API 层在默认档案被归档/删除时调用）。
   * 语义：默认档案必须是**当前可用**的一份真档案。只要标记还指着失效档案，
   * 下次启动 ensureDefaultProfile() 判定失效后，若按昵称也找不到可用的「默认玩家」，
   * 就会**凭空重建一个「默认玩家」**——用户看到多出来的档案，而且旧默认档案的归属链断了。
   * 重指向（而不是仅清理）是修掉这条路径的正解：始终有一份可用档案接着当默认。
   * 传空值等价于 _clearDefaultId()。
   */
  setDefaultId(id) {
    if (!id) { this._clearDefaultId(); return null; }
    this.defaultId = String(id);
    this._persistDefaultId();
    return this.defaultId;
  }

  /** 为无归属存档写入 owner 字段（返回处理数量）。
   *  FIX-11：旧签名 `_tagSaves(defaultId, defaultNickname)` 的第二个形参**从未被使用**——
   *  ownerNicknameSnapshot 一律取自存档里的人类玩家名（见下方 human.name），传什么昵称都不影响结果，
   *  纯粹是误导读代码的人，故删除形参。 */
  _tagSaves(defaultId) {
    let n = 0;
    if (!fs.existsSync(this.savesDir)) return n;
    for (const f of fs.readdirSync(this.savesDir)) {
      if (!f.endsWith('.json') || f === 'experiences.json') continue;
      const file = path.join(this.savesDir, f);
      let doc;
      try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
      if (!doc || typeof doc !== 'object' || !doc.game) continue;
      if (doc.ownerProfileId) continue; // 已有归属：绝不清除/覆盖
      const human = (doc.game.players || []).find((p) => p.isHuman);
      doc.ownerProfileId = defaultId;
      doc.ownerNicknameSnapshot = human ? human.name : null;
      doc.ownerHumanSeat = human ? human.seat : null;
      doc.profileSchemaVersion = 1;
      // 临时文件命名统一走 src/tmp-files.js（FIX-12）：旧实现用 `<file>.migtmp`，
      // 既不在启动清理的识别范围内，也不好在数据目录里一眼看出归属。
      const tmp = tmpPathFor(file);
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
      fs.renameSync(tmp, file);
      n++;
    }
    return n;
  }

  /** 执行迁移（幂等）。返回 {steps: 实际执行列表, defaultId, taggedSaves} */
  async run() {
    const executed = [];
    let defaultId = null;
    let tagged = 0;

    if (!this.done.has('backup')) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = path.join(this.dir, `backup-${stamp}`);
      fs.mkdirSync(backupDir, { recursive: true });
      if (fs.existsSync(this.savesDir)) {
        for (const f of fs.readdirSync(this.savesDir)) {
          if (!f.endsWith('.json') || f === 'experiences.json') continue;
          fs.copyFileSync(path.join(this.savesDir, f), path.join(backupDir, f));
        }
      }
      this._mark('backup');
      executed.push('backup');
      this._log(`迁移备份完成：${backupDir}`);
    }

    if (!this.done.has('default')) {
      defaultId = await this.ensureDefaultProfile();
      this._mark('default');
      executed.push('default');
      this._log(`默认档案就绪：${defaultId}`);
    } else {
      defaultId = await this.ensureDefaultProfile(); // 重入：直接复用既有默认档案
    }

    if (!this.done.has('own-tag')) {
      tagged = this._tagSaves(defaultId); // FIX-11：死形参 defaultNickname 已删除（昵称取自存档内人类玩家）
      this._mark('own-tag');
      executed.push('own-tag');
      this._log(`无归属存档打标 ${tagged} 份 → 默认档案`);
    }

    if (!this.done.has('exp')) {
      // 零拷贝迁移：默认档案的经验池继续指向旧 saves/experiences.json（ExperienceStore 兼容路径），
      // 新档案各自持有独立池。旧文件保留 = 天然备份。
      this._mark('exp');
      executed.push('exp');
    }

    // exp-owner：把「旧池归谁」钉死到 UUID（幂等：首次写入后永不改写；不搬动任何经验数据）
    const legacyExpOwnerId = this.pinLegacyExperienceOwner(defaultId);
    if (legacyExpOwnerId && !this.done.has('exp-owner')) {
      this._mark('exp-owner');
      executed.push('exp-owner');
    }

    if (!this.done.has('done')) { this._mark('done'); executed.push('done'); }
    return { executed, defaultId, tagged, legacyExpOwnerId };
  }
}

module.exports = { ProfileMigration, readLegacyExperienceOwner, LEGACY_EXP_OWNER };
