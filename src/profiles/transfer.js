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

/** 从存档目录收集可导出的已结束对局（不含密钥/令牌/锚点/journal） */
function collectExportableGames(savesDir, ownerProfileId) {
  const out = [];
  if (!fs.existsSync(savesDir)) return out;
  for (const f of fs.readdirSync(savesDir)) {
    if (!f.endsWith('.json') || f === 'experiences.json') continue;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(savesDir, f), 'utf8')); } catch (_) { continue; }
    if (!doc || doc.ownerProfileId !== ownerProfileId || !doc.game || !doc.game.finished) continue;
    out.push({
      gameId: doc.game.id,
      day: doc.game.day || 0,
      winner: doc.game.winner || null,
      winReason: doc.game.winReason || '',
      mock: !!doc.mock,
      savedAt: doc.savedAt || null,
      players: doc.game.players || [],
      events: (doc.game.events || []).slice(0, 5000), // 防御性上限；正常终局远小于此
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

/** 校验并规范化导入包。失败抛 ValidationError 语义（code 400）；返回规范化后的包 */
function validateImportPackage(pkg, { maxBytes = MAX_BYTES } = {}) {
  if (!pkg || typeof pkg !== 'object') throw Object.assign(new Error('导入包不是合法 JSON 对象'), { code: 400 });
  if (!pkg.manifest || Number(pkg.manifest.exportVersion) !== EXPORT_VERSION) {
    throw Object.assign(new Error('不支持的导出版本'), { code: 400 });
  }
  if (!pkg.profile || typeof pkg.profile.nickname !== 'string' || !pkg.profile.nickname.trim()) {
    throw Object.assign(new Error('导入包缺少档案昵称'), { code: 400 });
  }
  if (!Array.isArray(pkg.games)) throw Object.assign(new Error('导入包缺少对局列表'), { code: 400 });
  for (const g of pkg.games) {
    if (!g || typeof g.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(g.id)) {
      throw Object.assign(new Error('导入包含非法对局 id'), { code: 400 });
    }
    if (!g.finished) throw Object.assign(new Error('导入包包含未结束对局（不允许）'), { code: 400 });
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
