/**
 * transfer.js — 档案导入导出（整改方案 PROF-04，§3.5）
 *
 * 原则：
 *   · 导出为版本化 JSON：manifest + 档案 + 笔记 + 允许导出的**已结束**局；
 *     不含密钥、playerToken/godToken、管理 Cookie、锚点、决策 journal。
 *   · 导入前预览（不写盘）；导入时重映射 profileId/gameId，冲突自动改名；
 *     任何校验失败都不部分写入。
 *   · 默认上限 20 MiB，超限拒绝（可分包，不静默截断）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 20 * 1024 * 1024;
const EXPORT_VERSION = 1;

function newId() { return crypto.randomUUID(); }

/** 从存档目录收集可导出的已结束对局（不含密钥/令牌/锚点/journal）。
 *  事件流来源（审核 P1-3）：终局存档 game.events 全量保留；旧存档（game 元数据被剥过 events）
 *  回落到 anchor.events（锚点只拍在昼/夜边界，可能缺最后一段——已是存档里能拿到的最全一份）。 */
function collectExportableGames(savesDir, ownerProfileId) {
  const out = [];
  if (!fs.existsSync(savesDir)) return out;
  for (const f of fs.readdirSync(savesDir)) {
    if (!f.endsWith('.json') || f === 'experiences.json') continue;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(savesDir, f), 'utf8')); } catch (_) { continue; }
    if (!doc || doc.ownerProfileId !== ownerProfileId || !doc.game || !doc.game.finished) continue;
    const events = (Array.isArray(doc.game.events) && doc.game.events.length)
      ? doc.game.events
      : ((doc.anchor && Array.isArray(doc.anchor.events)) ? doc.anchor.events : []);
    out.push({
      id: doc.game.id,
      finished: !!doc.game.finished,
      day: doc.game.day || 0,
      winner: doc.game.winner || null,
      winReason: doc.game.winReason || '',
      mock: !!doc.mock,
      savedAt: doc.savedAt || null,
      players: doc.game.players || [],
      events,
      board: doc.game.board || null,
      rules: doc.game.rules || null,
    });
  }
  return out;
}

/** 生成导出包（对象）。notes: {gameId: annotationDoc} */
function buildExportPackage({ profile, games, notes = {}, hostLabel = '' }) {
  const manifest = {
    exportVersion: EXPORT_VERSION,
    packageId: newId(),
    createdAt: new Date().toISOString(),
    source: hostLabel,
    counts: { games: games.length, notes: Object.keys(notes).length },
  };
  return {
    manifest,
    profile: {
      nickname: profile.nickname,
      avatarId: profile.avatarId,
      bio: profile.bio || '',
      preferences: profile.preferences || {},
      createdAt: profile.createdAt || null,
    },
    games,
    notes,
  };
}

/** 校验并规范化导入包。失败抛 ValidationError 语义（code 400）；返回规范化后的包。
 *  审核 P2-4：**写入前完整校验所有记录**——任何一局/一份笔记不合法都整体拒绝，
 *  绝不允许"第一局合法第二局坏"留下半份数据。 */
function validateImportPackage(pkg, { maxBytes = MAX_BYTES } = {}) {
  if (!pkg || typeof pkg !== 'object') throw Object.assign(new Error('导入包不是合法 JSON 对象'), { code: 400 });
  if (!pkg.manifest || Number(pkg.manifest.exportVersion) !== EXPORT_VERSION) {
    throw Object.assign(new Error('不支持的导出版本'), { code: 400 });
  }
  if (!pkg.profile || typeof pkg.profile.nickname !== 'string' || !pkg.profile.nickname.trim()) {
    throw Object.assign(new Error('导入包缺少档案昵称'), { code: 400 });
  }
  if (pkg.profile.preferences !== undefined && (typeof pkg.profile.preferences !== 'object' || pkg.profile.preferences === null || Array.isArray(pkg.profile.preferences))) {
    throw Object.assign(new Error('导入包 preferences 必须是对象'), { code: 400 });
  }
  if (!Array.isArray(pkg.games)) throw Object.assign(new Error('导入包缺少对局列表'), { code: 400 });
  for (const g of pkg.games) {
    if (!g || typeof g !== 'object') throw Object.assign(new Error('导入包含非法对局记录'), { code: 400 });
    if (typeof g.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(g.id)) {
      throw Object.assign(new Error(`导入包含非法对局 id：${String(g.id).slice(0, 20)}`), { code: 400 });
    }
    if (!g.finished) throw Object.assign(new Error('导入包包含未结束对局（不允许）'), { code: 400 });
    // 记录级类型校验：players/events 必须是数组（players 里的条目必须是对象），
    // board/rules/winner/winReason 类型受限 —— 坏类型会在写入循环里半路抛错，留下半份导入。
    if (g.players !== undefined && !Array.isArray(g.players)) {
      throw Object.assign(new Error(`对局 ${g.id} 的 players 必须是数组`), { code: 400 });
    }
    for (const p of g.players || []) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        throw Object.assign(new Error(`对局 ${g.id} 的 players 含非对象条目`), { code: 400 });
      }
    }
    if (g.events !== undefined && !Array.isArray(g.events)) {
      throw Object.assign(new Error(`对局 ${g.id} 的 events 必须是数组`), { code: 400 });
    }
    for (const field of ['board', 'rules']) {
      if (g[field] !== undefined && g[field] !== null && (typeof g[field] !== 'object' || Array.isArray(g[field]))) {
        throw Object.assign(new Error(`对局 ${g.id} 的 ${field} 必须是对象`), { code: 400 });
      }
    }
    for (const field of ['winner', 'winReason']) {
      if (g[field] !== undefined && g[field] !== null && typeof g[field] !== 'string') {
        throw Object.assign(new Error(`对局 ${g.id} 的 ${field} 必须是字符串`), { code: 400 });
      }
    }
  }
  if (pkg.notes !== undefined) {
    if (typeof pkg.notes !== 'object' || pkg.notes === null || Array.isArray(pkg.notes)) {
      throw Object.assign(new Error('导入包 notes 必须是对象'), { code: 400 });
    }
    for (const [gid, doc] of Object.entries(pkg.notes)) {
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw Object.assign(new Error(`笔记 ${gid} 必须是对象`), { code: 400 });
      }
      if (doc.seats !== undefined && (typeof doc.seats !== 'object' || doc.seats === null || Array.isArray(doc.seats))) {
        throw Object.assign(new Error(`笔记 ${gid} 的 seats 必须是对象`), { code: 400 });
      }
    }
  }
  return pkg;
}

/** 生成导入预览：不写盘 */
function previewImport(pkg) {
  return {
    nickname: pkg.profile.nickname,
    games: pkg.games.length,
    finishedOnly: true,
    notes: Object.keys(pkg.notes || {}).length,
  };
}

/** 为导入包生成 ID 重映射表（旧 gameId → 新 gameId，避免与现有存档冲突） */
function buildGameIdMap(pkg) {
  const map = {};
  for (const g of pkg.games) {
    if (!g || typeof g.id !== 'string') continue;
    map[g.id] = newId();
  }
  return map;
}

module.exports = { EXPORT_VERSION, MAX_BYTES, collectExportableGames, buildExportPackage, validateImportPackage, previewImport, buildGameIdMap };
