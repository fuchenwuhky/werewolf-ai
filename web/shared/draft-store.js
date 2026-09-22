/**
 * draft-store.js — 草稿的**会话存储**（按档案隔离 / 按 owner+gameId+seat 归属 / 不含密钥）
 * 计划书 §8.2 `:262`「新草稿默认试玩；恢复既有草稿或对局时保持原模式，不能静默切换」
 *          §8.2 `:263`「草稿按档案保存到会话存储，**不含密钥、令牌**；**切档不继承上一档案草稿**」
 *          §8.2 `:264`「后退保留内容；第三步之前不得调用建局 API」
 *          §8.2 `:267`「缺 Key、绑定失效、板子非法 ⇒ 显示具体原因和修复入口；**不得静默降级为试玩**」
 *          §9.3 `:302`「草稿按 **owner、gameId、seat** 保存，**不按当前浏览档案归属**」
 *
 * ── 两类草稿，两套归属键（这是本模块最容易写错的地方）────────────────────────
 *   ① **开局草稿**（三步开局里填到一半的板子/人数/座位…）：键是**档案 UUID**。
 *      「切档不继承上一档案草稿」⇒ 每个档案看自己的那一份；换档案必须换键，
 *      **绝不能**用一个全局键（那样 A 的板子会留在 B 的开局页上）。
 *   ② **局内笔记草稿**（某个座位的候选身份/备注写到一半）：键是 **owner + gameId + seat**。
 *      「不按当前浏览档案归属」⇒ 键里**不许**出现"当前选中的档案"。
 *      理由：局中允许切到别的档案去看战绩，回来时这条草稿必须还在同一个座位上；
 *      键里若带当前浏览档案，切一次档草稿就找不到了（串档 / 丢档）。
 *      这里用 **owner**（`game.ownerProfileId`，开局时固化的对局归属），
 *      它和"现在浏览器选中的是哪个档案"是两件事。
 *
 * ── 密钥纪律（原文「不含密钥、令牌」）────────────────────────────────────────
 * 会话存储是**明文**的，所以写进草稿前一律过 `sanitizeDraft()`：按字段名丢掉
 * key/token/cookie/secret/password/credential 一类字段（递归，含数组元素里的对象）。
 * 方向是"宁可多丢"：草稿丢了顶多让用户重填，密钥泄漏是不可逆的。
 * `secretFieldsOf()` 只用于**诊断/用例**（列出被丢掉的字段名），不参与写入。
 *
 * ── 模式与提交流程（`:262` / `:264` / `:267`）───────────────────────────────
 *   · `resolveMode`：新草稿默认 'mock'（试玩）；已有模式（既有草稿/恢复的对局）原样保留；
 *   · `modeDrift`：把"静默切换模式"变成可断言的返回值；
 *   · `submitGate`：第三步之前不允许建局；缺 Key / 绑定失效 / 板子非法 ⇒ 明确原因 + 修复入口，
 *     **不返回"降级成试玩"**（返回的 mode 永远是请求的那个）。
 *   · `createSubmitLock`：最终提交的单次锁（连点只产生一次业务提交，§8.2 `:265`）。
 */

'use strict';
(function (global) {
  const SETUP_PREFIX = 'ww_draft_setup:';
  const NOTE_PREFIX = 'ww_draft_note:';
  const NONE = 'none';
  /** 会话存储里**绝不允许**出现的字段名（判据按字段名，不按值：值的形态千变万化，按值判断必然漏） */
  const SECRET_FIELD_RE = /(key|token|cookie|secret|password|passwd|credential|authorization)/i;
  const MODES = ['mock', 'real'];

  /** 字段名是否属于"密钥/令牌"一类（按名判定，宁可多丢） */
  function isSecretField(name) {
    return SECRET_FIELD_RE.test(String(name || ''));
  }

  /** 列出对象里会被 `sanitizeDraft` 丢掉的字段名（诊断/用例用；不参与写入） */
  function secretFieldsOf(value, out = [], depth = 0) {
    if (depth > 6 || !value || typeof value !== 'object') return out;
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
    for (const [k, v] of entries) {
      if (!Array.isArray(value) && isSecretField(k)) out.push(k);
      if (v && typeof v === 'object') secretFieldsOf(v, out, depth + 1);
    }
    return out;
  }

  /**
   * 递归去掉密钥字段并做一份可 JSON 序列化的副本。
   * 字符串**值**不做正则清洗：那会误伤正常文案（"点这里填 API Key"这种提示语），
   * 而且"值里恰好含 key 字样"与"这是密钥"是两回事 —— 判据收在字段名上。
   */
  function sanitizeDraft(value, depth = 0) {
    if (depth > 6) return undefined;
    if (value === null || typeof value !== 'object') {
      return typeof value === 'function' ? undefined : value;
    }
    if (Array.isArray(value)) return value.map((v) => sanitizeDraft(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretField(k)) continue;
      const clean = sanitizeDraft(v, depth + 1);
      if (clean !== undefined) out[k] = clean;
    }
    return out;
  }

  // ---------------- 存储原语（storage 不可用时静默降级，不影响开局/笔记本身） ----------------
  function readJson(storage, key) {
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) { return null; }
  }
  function writeJson(storage, key, value) {
    try { storage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
  }
  function removeKey(storage, key) {
    try { storage.removeItem(key); return true; } catch (_) { return false; }
  }

  // ---------------- ① 开局草稿：按**档案**隔离 ----------------
  /** 开局草稿的存储键：一个档案一个键（`profileId` 缺失时归到 'none' 桶，仍然互不串档） */
  function setupDraftKey(profileId) {
    return `${SETUP_PREFIX}${profileId || NONE}`;
  }
  function readSetupDraft(storage, profileId) {
    return readJson(storage, setupDraftKey(profileId));
  }
  function writeSetupDraft(storage, profileId, draft) {
    const clean = sanitizeDraft(draft) || {};
    return writeJson(storage, setupDraftKey(profileId), clean);
  }
  function clearSetupDraft(storage, profileId) {
    return removeKey(storage, setupDraftKey(profileId));
  }

  // ---------------- ② 局内笔记草稿：按 owner + gameId + seat 归属 ----------------
  /**
   * 笔记草稿的存储键。**刻意不接收"当前浏览档案"**（§9.3 `:302`）：
   * 形参只有 owner/gameId/seat，调用方就算想传"当前档案"也没有位置可传。
   */
  function noteDraftKey(ownerProfileId, gameId, seat) {
    return `${NOTE_PREFIX}${ownerProfileId || NONE}:${gameId || NONE}:${seat === null || seat === undefined ? NONE : seat}`;
  }
  /** @param at { ownerProfileId, gameId, seat } */
  function readNoteDraft(storage, at) {
    const a = at || {};
    return readJson(storage, noteDraftKey(a.ownerProfileId, a.gameId, a.seat));
  }
  function writeNoteDraft(storage, at, draft) {
    const a = at || {};
    const clean = sanitizeDraft(draft) || {};
    return writeJson(storage, noteDraftKey(a.ownerProfileId, a.gameId, a.seat), clean);
  }
  function clearNoteDraft(storage, at) {
    const a = at || {};
    return removeKey(storage, noteDraftKey(a.ownerProfileId, a.gameId, a.seat));
  }

  // ---------------- 模式：新草稿默认试玩，既有草稿/对局保持原模式 ----------------
  /**
   * @param input.existingMode 既有草稿 / 正在恢复的对局里的模式（'mock' | 'real' | 其它/缺失）
   * @returns 'mock' | 'real' —— 新草稿（没有既有模式）默认 'mock'（试玩：流程脚本，不调用模型）
   */
  function resolveMode(input) {
    const mode = input && input.existingMode;
    return MODES.includes(mode) ? mode : 'mock';
  }

  /**
   * 模式漂移检测（`:262`「恢复既有草稿或对局时保持原模式，**不能静默切换**」）。
   * @returns null = 一致；否则返回阻止原因字符串。
   */
  function modeDrift(originalMode, nextMode) {
    if (!MODES.includes(originalMode)) return null;          // 原来就没有模式 ⇒ 谈不上"改了"
    if (originalMode === nextMode) return null;
    return `恢复的对局/草稿原本是「${originalMode === 'mock' ? '试玩' : '真实'}」，`
      + `不能静默切换成「${nextMode === 'mock' ? '试玩' : '真实'}」：请显式选择或取消恢复。`;
  }

  /**
   * 建局前的闸门（`:264` / `:267`）。
   * @param input.step         当前第几步（三步开局；默认 1）
   * @param input.steps        总步数（默认 3）
   * @param input.mode         请求的模式（'mock' | 'real'）
   * @param input.boardValid   板子是否合法（人数/身份组成）
   * @param input.boardReason  板子非法的具体原因（由调用方给，便于显示到界面上）
   * @param input.hasApiKey    设备级 Key 是否可用（仅真实模式需要）
   * @param input.bindingValid 模型绑定是否仍有效（仅真实模式需要）
   * @returns {{allowed:boolean, reason:string, fix:(string|null), mode:string}}
   *   ⚠ `mode` **永远**是请求的那个模式：这条闸门只会"拦住并说明原因"，
   *     绝不会把 real 悄悄改成 mock（`:267` 明文禁止静默降级为试玩）。
   */
  function submitGate(input) {
    const i = input || {};
    const step = Number(i.step === undefined ? 1 : i.step);
    const steps = Number(i.steps === undefined ? 3 : i.steps);
    const mode = MODES.includes(i.mode) ? i.mode : 'mock';
    if (step < steps) {
      return { allowed: false, reason: `三步开局还没走完（当前第 ${step} 步 / 共 ${steps} 步），这一步不允许建局`, fix: 'step', mode };
    }
    if (i.boardValid === false) {
      return { allowed: false, reason: i.boardReason || '当前板子不合法（人数或身份组成有问题），无法开局', fix: 'board', mode };
    }
    if (mode === 'real' && i.hasApiKey === false) {
      return { allowed: false, reason: '缺少 API Key：真实对局需要设备级 Key（不会静默降级为试玩）', fix: 'settings', mode };
    }
    if (mode === 'real' && i.bindingValid === false) {
      return { allowed: false, reason: '模型绑定已失效：请在设置里重新测试并保存绑定（不会静默降级为试玩）', fix: 'settings', mode };
    }
    return { allowed: true, reason: '', fix: null, mode };
  }

  /**
   * 单次提交锁（`:265`「最终提交冻结档案与全部参数，并设置单次提交锁」）：
   * 连点/重入只会有一个拿到锁，其余立即失败 —— 不会产生第二次建局请求。
   */
  function createSubmitLock() {
    let locked = false;
    return {
      tryLock() { if (locked) return false; locked = true; return true; },
      release() { locked = false; },
      get locked() { return locked; },
    };
  }

  const api = {
    SETUP_PREFIX, NOTE_PREFIX, MODES,
    isSecretField, sanitizeDraft, secretFieldsOf,
    setupDraftKey, readSetupDraft, writeSetupDraft, clearSetupDraft,
    noteDraftKey, readNoteDraft, writeNoteDraft, clearNoteDraft,
    resolveMode, modeDrift, submitGate, createSubmitLock,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WWDraftStore = api;
})(typeof window !== 'undefined' ? window : globalThis);
