/**
 * experience.js — 跨局经验池（借鉴清华 Werewolf 框架的 critical mind / AgentVerse experience pool）
 *
 * 每局结束后，让每个 AI 拿"当时的判断与表现"对照"终局真相"复盘，提炼出可复用的经验教训，
 * 按角色持久化到 saves/experiences.json。下一局开局时按角色检索注入 system 提示词——AI 越玩越强。
 *
 * 存储结构：{ version: 1, byRole: { <roleId>: [ { text, createdAt, boardSize } ] } }
 * 每个角色保留最近 MAX_PER_ROLE 条（新经验替换最旧）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_PER_ROLE = 24;
const INJECT_LIMIT = 6; // 开局注入 system 的经验条数

class ExperienceStore {
  constructor(dir) {
    this.file = path.join(dir, 'experiences.json');
    this.data = { version: 1, byRole: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.version === 1 && raw.byRole) this.data = raw;
    } catch (_) { /* 首次或损坏：从空池开始 */ }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1));
    } catch (e) {
      console.error('[experience] 保存失败:', e.message);
    }
  }

  /** 追加经验：entries = [{role, text, boardSize?}]；同角色去重（完全相同文本不重复入库） */
  add(entries) {
    let added = 0;
    for (const e of entries || []) {
      if (!e || typeof e.role !== 'string' || typeof e.text !== 'string' || !e.text.trim()) continue;
      const role = e.role;
      const text = e.text.trim().slice(0, 200);
      if (!this.data.byRole[role]) this.data.byRole[role] = [];
      const list = this.data.byRole[role];
      if (list.some((x) => x.text === text)) continue; // 去重
      list.push({ text, createdAt: Date.now(), boardSize: e.boardSize || null });
      added++;
    }
    // 每角色只保留最近 MAX_PER_ROLE 条
    for (const role of Object.keys(this.data.byRole)) {
      const list = this.data.byRole[role];
      if (list.length > MAX_PER_ROLE) this.data.byRole[role] = list.slice(-MAX_PER_ROLE);
    }
    if (added) this._save();
    return added;
  }

  /** 某角色的经验（最新在前），最多 INJECT_LIMIT 条 */
  forRole(roleId) {
    const list = this.data.byRole[roleId] || [];
    return list.slice(-INJECT_LIMIT).reverse().map((x) => x.text);
  }

  stats() {
    const out = {};
    for (const [role, list] of Object.entries(this.data.byRole)) out[role] = list.length;
    return out;
  }
}

module.exports = { ExperienceStore, MAX_PER_ROLE, INJECT_LIMIT };
