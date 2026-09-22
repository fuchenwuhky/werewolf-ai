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
const { AVATAR_MIME, sha256Hex, decodeAvatarPayload } = require('./avatar');

const MAX_BYTES = 20 * 1024 * 1024;
const EXPORT_VERSION = 1;

function newId() { return crypto.randomUUID(); }

/** 从存档目录收集可导出的已结束对局（不含密钥/令牌/锚点/journal）。
 *  事件流来源（审核 P1-3）：终局存档 game.events 全量保留；旧存档（game 元数据被剥过 events）
 *  回落到 anchor.events（锚点只拍在昼/夜边界，可能缺最后一段——已是存档里能拿到的最全一份）。 */
function collectExportableGames(savesDir, ownerProfileId, { strict = false } = {}) {
  const out = [];
  if (!fs.existsSync(savesDir)) return out;
  for (const f of fs.readdirSync(savesDir)) {
    if (!f.endsWith('.json') || f === 'experiences.json') continue;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(savesDir, f), 'utf8'));
    } catch (e) {
      // §6/§7：损坏数据必须返回明确错误，不能伪装成"没有这一局"。
      // 列表路由走 _readSaveDocStrict 会 500；导出过去在这里 catch 后 continue，
      // 于是同一份数据"列表拒绝、导出成功且少报" —— 用户看到导出成功，归档/删除档案后
      // 这一局就再无出口（静默丢数据）。strict 由导出路由开启；默认 false 保持既有语义。
      if (strict) {
        throw Object.assign(new Error(
          `存档 ${f} 不是合法 JSON，导出的对局可能不完整，已拒绝生成看似完整的包：${e.message}`
        ), { code: 500 });
      }
      continue;
    }
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

/**
 * 生成导出包（对象）。notes: {gameId: annotationDoc}
 *
 * M1 §4.4：档案带自定义头像时，包内 `profile.customAvatar` = { mime, sha256, dataBase64 }。
 *  · `avatar` 由调用方（api.profileExport）用 ProfileStore.readAvatar **读盘并核对过**后传入；
 *  · 这里仍**重新计算哈希**并与档案元数据对账（要求原文："导出前重新计算文件哈希并与元数据核对"）——
 *    文件丢失/损坏/被换过时抛错让整次导出失败，绝不静默导出一份"看起来完整"的包；
 *  · 只放这三个字段：不含原始文件名、EXIF（服务端落盘前已剥离，见 avatar.js）、本机绝对路径。
 */
function buildExportPackage({ profile, games, notes = {}, hostLabel = '', avatar = null }) {
  const manifest = {
    exportVersion: EXPORT_VERSION,
    packageId: newId(),
    createdAt: new Date().toISOString(),
    source: hostLabel,
    counts: { games: games.length, notes: Object.keys(notes).length },
  };
  const outProfile = {
    nickname: profile.nickname,
    avatarId: profile.avatarId,
    bio: profile.bio || '',
    preferences: profile.preferences || {},
    createdAt: profile.createdAt || null,
  };
  const ca = profile.customAvatar || null;
  if (ca) {
    const data = avatar && Buffer.isBuffer(avatar.data) ? avatar.data : null;
    if (!data) {
      throw Object.assign(new Error('导出失败：档案记录了自定义头像，但没有读到头像文件（文件丢失或不可读）'), { code: 500 });
    }
    const digest = sha256Hex(data);
    if (digest !== ca.sha256) {
      throw Object.assign(new Error(
        `导出失败：自定义头像哈希与档案元数据不一致（文件 ${digest.slice(0, 12)}… ≠ 记录 ${String(ca.sha256).slice(0, 12)}…），文件可能已被替换或损坏`
      ), { code: 500 });
    }
    outProfile.customAvatar = { mime: AVATAR_MIME, sha256: digest, dataBase64: data.toString('base64') };
  }
  return { manifest, profile: outProfile, games, notes };
}

/** 校验并规范化导入包。失败抛 ValidationError 语义（code 400）；返回规范化后的包。
 *  审核 P2-4：**写入前完整校验所有记录**——任何一局/一份笔记不合法都整体拒绝，
 *  绝不允许"第一局合法第二局坏"留下半份数据。
 *  NEW-08 附带：**对局 id 必须两两不同**——重复 id 在 buildGameIdMap 后会映射到同一个新 id，
 *  后写的静默覆盖先写的（接口还报 200），属于"能判定的丢数据"故与坏记录同等对待。 */
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
  // M1 §4.4：自定义头像必须在这里**完整校验**（Base64 规范性 → 字节上限 → PNG 结构 → 尺寸 → 哈希），
  // 因为整个导入的承诺是"校验失败不写盘"。写在导入循环里校验就等于已经建了档案、已经落了盘。
  decodeAvatarPayload(pkg.profile.customAvatar);
  if (!Array.isArray(pkg.games)) throw Object.assign(new Error('导入包缺少对局列表'), { code: 400 });
  // 重复 gameId 必须在这里就拒绝：`buildGameIdMap` 按 id 建表，两局同 id 会映射到**同一个新 id**，
  // 后写的那局静默覆盖先写的（用户看到 200 + "1 局已归入新档案"，实际丢了一局）。
  // 这是能判定的坏包（id 唯一标识一局），按本模块原则整体拒绝，绝不留半份/丢局。
  const seenGameIds = new Set();
  for (const g of pkg.games) {
    if (!g || typeof g !== 'object') throw Object.assign(new Error('导入包含非法对局记录'), { code: 400 });
    if (typeof g.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(g.id)) {
      throw Object.assign(new Error(`导入包含非法对局 id：${String(g.id).slice(0, 20)}`), { code: 400 });
    }
    if (seenGameIds.has(g.id)) {
      throw Object.assign(new Error(`导入包内对局 id 重复：${g.id}（重复 id 重映射后会互相覆盖，导致静默丢局）`), { code: 400 });
    }
    seenGameIds.add(g.id);
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
    // M1 §4.4：预览要能让用户看清"这个包带自定义头像"，否则导入后头像凭空出现
    avatar: !!(pkg.profile && pkg.profile.customAvatar),
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

module.exports = { EXPORT_VERSION, MAX_BYTES, collectExportableGames, buildExportPackage, validateImportPackage, previewImport, buildGameIdMap, decodeAvatarPayload };
