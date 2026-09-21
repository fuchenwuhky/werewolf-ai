/**
 * profile-state.js — 档案（存档槽）状态的浏览器端共享实现（M1 共享状态）
 *
 * 桌面 app.js 与手机 m.js 原本各写一遍：拉档案列表 → 选中 id 落地、选中键的读写与清理、
 * 切档时的昵称预填、删除当前档案后的取消选中、当前档案偏好回落。
 * 这里收敛成一份；两端只保留**界面刷新**（画哪块 DOM、用哪个选择器）那几行差异。
 *
 * 存储键名**由调用方传入**（默认 'ww_profile_id'，两端当前共用同一个键）：
 * 模块内部不写死任何键，避免"某一端要换键"或"把另一端的键抄过来"时静默串档。
 * 异常处理与调用点原来的写法逐字一致：读/写/清都吞掉 storage 异常（隐私模式、配额满），
 * 拉列表失败的收尾（profileId 置 null + 可读提示）由模块统一做，提示文案由调用方渲染。
 */
'use strict';
(function (global) {
  const DEFAULT_KEY = 'ww_profile_id';
  const DEFAULT_PREFS = { fontScale: 1, layout: 'reading', reducedMotion: false };

  /** 读选中的档案 id：storage 不可用（隐私模式/被禁用）时报 null —— 与两端原来的 try/catch 兜底一致 */
  function readSelectedId(storage, key) {
    try { return storage.getItem(key || DEFAULT_KEY); } catch (_) { return null; }
  }

  /** 写选中的档案 id：写入失败静默忽略（无痕模式里切档不该报错） */
  function writeSelectedId(storage, key, profileId) {
    try { storage.setItem(key || DEFAULT_KEY, profileId); } catch (_) { /* 隐私模式忽略 */ }
  }

  /** 清掉选中的档案 id（删除当前档案时）：失败同样静默忽略 */
  function clearSelectedId(storage, key) {
    try { storage.removeItem(key || DEFAULT_KEY); } catch (_) { /* 隐私模式忽略 */ }
  }

  /**
   * 选中 id 的落地解析（两端原本逐字相同的一行）：
   *   存在且**未归档**的档案 → 第一个未归档档案 → 服务端给的默认档案 id → null。
   * 归档/删除过的档案不能被悄悄选中（那样会切到用户已经收起来的档案）。
   * 返回值与原来逐表达式相同：命中 `cur` 时直接返回它的 id（哪怕是空串），不再往后回落。
   */
  function resolveSelectedId(profiles, saved, defaultProfileId) {
    const list = profiles || [];
    const cur = list.find((p) => p.id === saved && !p.archivedAt);
    if (cur) return cur.id;
    const first = list.find((p) => !p.archivedAt);
    return ((first && first.id) || defaultProfileId) || null;
  }

  /** 当前档案的偏好：无档案 / 档案没有 preferences 时回落默认值；每次返回新对象，调用方改它不污染别处 */
  function prefsOf(profiles, profileId) {
    const p = (profiles || []).find((x) => x.id === profileId);
    return (p && p.preferences) || { fontScale: DEFAULT_PREFS.fontScale, layout: DEFAULT_PREFS.layout, reducedMotion: DEFAULT_PREFS.reducedMotion };
  }

  /** 跨窗口 storage 事件是否与本端的选中键相关（两端原本各写一遍的字面量比较） */
  function isSelectionKey(key, expected) {
    return key === (expected || DEFAULT_KEY);
  }

  /**
   * 拉档案列表并把选中 id 落到 state 上（两端原本逐字相同的整段，UI 由回调注入）：
   *   成功 → state.profiles / state.profileId 更新完再调 onLoaded()（两端在里面刷新界面）；
   *   失败 → state.profileId 置 null 后调 onFailed(message)（桌面/手机的错误文案都由调用方渲染）。
   * @param cfg.api    ('GET', url) => Promise<{profiles, defaultProfileId}>
   * @param cfg.state  调用方的状态对象（只写 profiles / profileId 两个字段）
   * @param cfg.storage / cfg.key  选中的存储与键名（键名仍由调用方给）
   * @param cfg.onLoaded() / cfg.onFailed(message)
   */
  async function loadProfiles(cfg) {
    try {
      const r = await cfg.api('GET', '/api/profiles');
      cfg.state.profiles = r.profiles || [];
      cfg.state.profileId = resolveSelectedId(cfg.state.profiles, readSelectedId(cfg.storage, cfg.key), r.defaultProfileId);
      cfg.onLoaded();
    } catch (e) {
      cfg.state.profileId = null;
      cfg.onFailed(e.message);
    }
  }

  /**
   * 切档（两端原本逐字相同的三行 + 昵称预填）：
   * 选中 id 写进 state 与存储，并用档案昵称预填"我的昵称"输入框（用户手改过就不覆盖）。
   * 之后的界面刷新（档案条/顶栏/首页摘要/继续上局卡）是两端各自的布局差异，留在调用方。
   * @param cfg.nameInput 本端的昵称输入框（可省）
   * @returns 命中的档案对象或 null（调用方要据此做后续 UI 时不必再 find 一次）
   */
  function selectProfile(cfg) {
    cfg.state.profileId = cfg.profileId;
    writeSelectedId(cfg.storage, cfg.key, cfg.profileId);
    const p = (cfg.state.profiles || []).find((x) => x.id === cfg.profileId);
    const input = cfg.nameInput;
    if (p && input && !input.dataset.touched) input.value = p.nickname;
    return p || null;
  }

  /** 删掉的正是当前选中的档案 → 取消选中并清存储键（两端原本逐字相同的三行） */
  function deselectIfCurrent(cfg) {
    if (cfg.state.profileId !== cfg.profileId) return false;
    cfg.state.profileId = null;
    clearSelectedId(cfg.storage, cfg.key);
    return true;
  }

  const api = {
    DEFAULT_KEY, DEFAULT_PREFS, readSelectedId, writeSelectedId, clearSelectedId,
    resolveSelectedId, prefsOf, isSelectionKey, loadProfiles, selectProfile, deselectIfCurrent,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WWProfileState = api;
})(typeof window !== 'undefined' ? window : globalThis);
