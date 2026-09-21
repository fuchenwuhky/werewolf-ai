/**
 * migration.js — 档案/归属一次性迁移（整改方案 DATA-02，§3.5）
 *
 * 幂等契约：游标文件 migrations/profiles-v1.json 记录已完成步骤；每步可重入。
 * 步骤：
 *   1 backup   把 index.json 与将触碰的 saves/*.json 复制进 migrations/backup-<ts>/
 *   2 default  创建「默认玩家」档案（UUID），重复运行不产生第二个默认档案
 *   3 own-tag  为无归属存档打 ownerProfileId/ownerNicknameSnapshot（默认档案）
 *   4 exp      旧经验池 saves/experiences.json 归属默认档案（零拷贝：默认档案经验池指向原路径）
 *   5 done     写完成标记
 *
 * 失败语义：任何一步抛错都保留现场，重跑从游标继续；不删除源文件。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CURSOR = 'profiles-v1.json';

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

  /**
   * 把默认档案重指向另一份档案（FIX-11；API 层在默认档案被归档/删除时调用）。
   * 语义：默认档案必须是**当前可用**的一份真档案。只要标记还指着失效档案，
   * 下次启动 ensureDefaultProfile() 判定失效后，若按昵称也找不到可用的「默认玩家」，
   * 就会**凭空重建一个「默认玩家」**——用户看到多出来的档案，而且旧默认档案的归属链断了。
   * 重指向（而不是仅清理）是修掉这条路径的正解：始终有一份可用档案接着当默认。
   * 传空值等价于 _clearDefaultId()。
   */
  setDefaultId(id) {
    if (!id) return this._clearDefaultId();
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
      // 临时文件命名与 api.js 的 TMP_PREFIX 家族一致（`.tmp-` 前缀 + pid + 时间戳）：
      // 旧实现用 `<file>.migtmp`，既不在 api.js 启动清理的识别范围内，也不好在数据目录里一眼看出归属。
      const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${Date.now()}`);
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

    if (!this.done.has('done')) { this._mark('done'); executed.push('done'); }
    return { executed, defaultId, tagged };
  }
}

module.exports = { ProfileMigration };
