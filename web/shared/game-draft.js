/**
 * game-draft.js — 开局草稿 / 本地对局句柄的浏览器端共享实现（M1 共享状态）
 *
 * 桌面 app.js 与手机 m.js 原本各写一遍：本机对局句柄（含保存时间）的读写清理、
 * 旧版座位标记 key 的拼接与迁移读写、座位偏好（默认「随机」）的读写。
 *
 * **键名全部由调用方传入，模块内部不写死任何一个键**：
 *   桌面端 ww_current / ww_tags_ / ww_seat，手机端 mww_current / mww_tags_ / ww_seat。
 * `ww_current` 与 `mww_current`、`ww_tags_*` 与 `mww_tags_*` 是**有意分开**的两组键
 * （两端各自只恢复自己开的局）；手机端历史上误写过桌面键、导致恢复后句柄丢失
 * （见 web/m/m.js 里那条注释），所以这里绝不做"顺手合并"。
 *
 * 异常处理与调用点原来的写法逐字一致：下面每个函数**都不吞异常**（除非原调用点自己包了
 * try/catch），`readHandle/readTags` 里坏 JSON 照旧抛出，由调用方既有的 try/catch 接住 ——
 * 共享模块不改变任何一端的错误可见性。
 */
'use strict';
(function (global) {
  /** 旧版座位标记的存储键：`ww_tags_<gameId>` / `mww_tags_<gameId>`（前缀由调用方给） */
  function tagsKey(prefix, gameId) {
    return `${prefix}${gameId}`;
  }

  /**
   * 读"原始句柄文本"（没存过 → null，可能是坏 JSON）。
   * 存在的理由：进首页时的判据是**原始文本为假就整段跳过**（连解析都不做），
   * 这个"先看有没有、再决定要不要解析"的时序必须保住，所以它与 readHandle 分开。
   */
  function readHandleRaw(storage, key) {
    return storage.getItem(key);
  }

  /** 句柄文本 → 对象。空串/undefined/missing 一律得到 null（与 `JSON.parse(x || 'null')` 同义）；坏 JSON 抛出 */
  function parseHandle(raw) {
    return JSON.parse(raw || 'null');
  }

  /** 读本机对局句柄：无句柄或内容为 null → null；坏 JSON 抛出（调用方的 try/catch 照旧） */
  function readHandle(storage, key) {
    return parseHandle(storage.getItem(key));
  }

  /** 写本机对局句柄（含 savedAt 之类的本地字段）：序列化与原实现完全一致 */
  function writeHandle(storage, key, handle) {
    storage.setItem(key, JSON.stringify(handle));
  }

  /** 清本机对局句柄（已结束/从未开局/主动放弃时才允许） */
  function clearHandle(storage, key) {
    storage.removeItem(key);
  }

  /** 读旧版座位标记（{seat: roleId}）：没有时给 null —— 迁移的"有没有旧数据"判据 */
  function readLegacyTags(storage, prefix, gameId) {
    return JSON.parse(storage.getItem(tagsKey(prefix, gameId))) || null;
  }

  /** 读旧版座位标记并兜底成 {}（进局首次渲染要立刻能用，不能因为没数据就 undefined） */
  function readTags(storage, prefix, gameId) {
    return JSON.parse(storage.getItem(tagsKey(prefix, gameId))) || {};
  }

  /** 写回未解决的旧版座位标记（无损容纳失败时保留待确认记录，绝不静默丢弃） */
  function writeTags(storage, prefix, gameId, tags) {
    storage.setItem(tagsKey(prefix, gameId), JSON.stringify(tags));
  }

  /** 全部座位都确认落盘后才允许清理旧 key */
  function clearTags(storage, prefix, gameId) {
    storage.removeItem(tagsKey(prefix, gameId));
  }

  /** 座位偏好：没存过/读不到一律「随机」（老坐 1 号很难受）；storage 异常静默回落 */
  function readSeat(storage, key) {
    try { return storage.getItem(key) || 'random'; } catch (_) { return 'random'; }
  }

  /** 记座位偏好（含 'random'）：写入失败静默忽略（隐私模式里不该因此开局失败） */
  function writeSeat(storage, key, choice) {
    try { storage.setItem(key, String(choice)); } catch (_) { /* 隐私模式忽略 */ }
  }

  const api = { tagsKey, readHandleRaw, parseHandle, readHandle, writeHandle, clearHandle, readLegacyTags, readTags, writeTags, clearTags, readSeat, writeSeat };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WWGameDraft = api;
})(typeof window !== 'undefined' ? window : globalThis);
