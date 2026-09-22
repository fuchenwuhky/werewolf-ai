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
 *
 * M2-d（计划书 §5.1 / §5.3）：`resolveSelectedId` 从「本地有效 → 第一个未归档 → 服务端默认 → null」
 * 改成**四级回退**「本地有效 → 服务端最近使用（`lastUsedAt` 最大）→ **有效**默认档案 → 其余可用」；
 * 同级补上昵称/简介上限与"长昵称省略展示、详情可读完整"的纯函数。
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
   * `lastUsedAt` → 可比较的时间值（毫秒）。
   * 缺失 / 空串 / 非法日期一律给 null：这一级的判据是计划书 §5.1 的「**服务端最近使用**档案」，
   * 而"最近使用"必须来自真实选用或开局写下的时间。字段损坏的档案不能被当成"最近"
   * （否则一个 `lastUsedAt: 'x'` 的档案会压过真实记录），也不能让排序变成随机。
   */
  function lastUsedValue(raw) {
    if (raw == null || raw === '') return null;
    const t = typeof raw === 'number' ? raw : Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  }

  /**
   * 选中 id 的落地解析 —— 计划书 §5.1 的**四级回退**（两端共用这一份）：
   *   ① 本地保存且**仍有效**（存在且未归档）→ 用它；
   *   ② 服务端**最近使用**档案（`lastUsedAt` 最大且未归档；时间缺失/非法的不参与这一级）；
   *   ③ **有效**默认档案（`defaultProfileId` 指向的档案**在可用列表里**才算有效）；
   *   ④ 其余可用（第一个未归档）。
   *   四级都没有可用档案时返回 **null**。
   *
   * 两个容易写歪的点（本批的契约变更，见 test/profile-state.test.js）：
   *   · 归档/删除过的档案不能被悄悄选中（那样会切到用户已经收起来的档案）；
   *   · `defaultProfileId` 是"服务端给的默认档案 **id**"，**不是兜底字符串**。计划书原文是
   *     「**有效**默认档案」⇒ 列表里没有它 / 它已归档时它**无效**，必须继续往第④级回落；
   *     返回一个不在列表里的 id 会让上层拿着一个"不存在的当前档案"去发请求。
   * 判等一律用**档案 id（UUID）**，与昵称无关（计划书 §5.1「以 UUID 判断身份，允许昵称重名」）。
   */
  function resolveSelectedId(profiles, saved, defaultProfileId) {
    const list = Array.isArray(profiles) ? profiles : [];
    const usable = list.filter((p) => p && !p.archivedAt);
    // ① 本地保存且仍有效
    const cur = usable.find((p) => p.id === saved);
    if (cur) return cur.id;
    // ② 服务端最近使用（lastUsedAt 最大；缺失/非法时间不参与）
    let recent = null;
    let recentAt = null;
    for (const p of usable) {
      const t = lastUsedValue(p.lastUsedAt);
      if (t === null) continue;
      if (recentAt === null || t > recentAt) { recent = p; recentAt = t; }
    }
    if (recent) return recent.id;
    // ③ 有效默认档案：必须真的在可用列表里
    const def = usable.find((p) => p.id === defaultProfileId);
    if (def) return def.id;
    // ④ 其余可用
    const first = usable[0];
    return (first && first.id) || null;
  }

  /**
   * 昵称 / 简介的长度上限（计划书 §5.3：昵称统一遵循服务端 **20 字符**、简介沿用 **100 字符**）。
   * 客户端不再各写一个魔数：输入框 maxlength 与预填、截断都从这里取值。
   * 长度按**码点**数（不是 UTF-16 长度）：否则 `🐺` 这类代理对被算成 2，20 字上限会变 10 字。
   */
  const NICKNAME_MAX = 20;
  const BIO_MAX = 100;

  /** 超长内容按**服务端同一上限**截断（用于写进请求体之前；不打省略号，语义是"限长"） */
  function clampProfileText(text, max) {
    const s = text == null ? '' : String(text);
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : NICKNAME_MAX;
    const cps = Array.from(s);
    return cps.length > limit ? cps.slice(0, limit).join('') : s;
  }

  /**
   * 展示用昵称：长昵称**省略展示**，但详情始终能读到完整内容（计划书 §5.3）。
   * 返回 { short, full, truncated } —— `full` 永远是原文，调用方把它挂在 title / 详情里。
   */
  function displayName(text, max) {
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : NICKNAME_MAX;
    const full = text == null ? '' : String(text);
    const cps = Array.from(full);
    if (cps.length <= limit) return { short: full, full, truncated: false };
    // 省略号本身占一格：截到 limit-1 再补 '…'，总长仍然不超过上限
    return { short: `${cps.slice(0, Math.max(1, limit - 1)).join('')}…`, full, truncated: true };
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
    resolveSelectedId, lastUsedValue, NICKNAME_MAX, BIO_MAX, clampProfileText, displayName,
    prefsOf, isSelectionKey, loadProfiles, selectProfile, deselectIfCurrent,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WWProfileState = api;
})(typeof window !== 'undefined' ? window : globalThis);
