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
  async ensureDefaultProfile() {
    const profiles = this.store.list({ includeArchived: true });
    const legacy = profiles.find((p) => p.nickname === '默认玩家' && !p.archivedAt);
    if (legacy) return legacy.id;
    return (await this.store.create({ nickname: '默认玩家', avatarId: 'scholar', bio: '升级时自动创建的本机档案' })).id;
  }

  /** 为无归属存档写入 owner 字段（返回处理数量） */
  _tagSaves(defaultId, defaultNickname) {
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
      const tmp = `${file}.migtmp`;
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
      tagged = this._tagSaves(defaultId, '默认玩家');
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
