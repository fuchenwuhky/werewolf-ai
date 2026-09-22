/**
 * export-core.js — Electron 主进程「档案导出」的纯逻辑核心（M2-e §3.2）
 *
 * 为什么单独一份、且**零 Electron 依赖**：
 *   `desktop/main.js` 在 `require('electron')` 之后立刻读 `app.isPackaged` 并抢单实例锁，
 *   在纯 `node --test` 里根本无法加载 —— 于是"三态归一化 / 精确同源判据 / profileId 白名单 /
 *   文件名净化"这几条**能在这里真跑**的逻辑如果写在 main.js 里，就一条都测不到。
 *   抽到这里以后，main.js 与 `test/m2e-export-native.test.js` 消费**同一份**实现，
 *   不存在"测试里另写一套判据"的假绿。
 *
 * 安全边界（都是**不允许放宽**的，改动会被 test/m2e-export-native.test.js 判红）：
 *   · `buildExportUrl` 只接受 `[A-Za-z0-9_-]{1,64}` 的 profileId，自己拼 `http://127.0.0.1:<port>/…`，
 *     **不接受**调用方给的 URL / 路径 / 查询串 —— `..`、`/`、`\`、`%2f`、绝对路径、`file:` 在拼接前就被拒；
 *   · `isSameOrigin` 是 URL 解析后的**精确 origin** 比较（不是字符串 includes），
 *     与 `desktop/main.js` 窗口导航用的是同一份实现；
 *   · `normalizeResult` 只把**字面量** `'saved'` 认成成功，且必须带落盘路径 ——
 *     `'ok'`/`'success'`/`true`/`1`/缺路径一律落到 `'failed'`（"未经确认不宣称保存成功"）。
 *
 * ⚠ 不要在这里 `require('electron')`：它一旦被 preload 引用就会在沙箱里炸
 *   （Electron 沙箱 preload 的 `require` 是受限 polyfill，**不支持相对路径 require**，
 *   见 https://www.electronjs.org/docs/latest/tutorial/sandbox —— 所以 preload.js 是自包含的，
 *   通道名字面量在那边独立写死，由测试断言两边逐字相同）。
 */
'use strict';
const path = require('path');

/** 三态取值（全项目统一，不许出现布尔 / 'ok' / 'success'） */
const STATUSES = Object.freeze(['saved', 'cancelled', 'failed']);

/**
 * 档案 id 白名单 —— 与 `src/annotations/store.js` 的 gameId 校验、`src/api.js` 的档案 id 形态同源。
 * 只允许这套字符集，于是路径分隔符与 URL 元字符**在拼接之前**就被拒，
 * 不依赖任何转义/规范化（转义永远是第二道防线，不该是唯一一道）。
 */
const PROFILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 导出包字节上限。⚠ 必须与 `src/profiles/transfer.js` 的 `MAX_BYTES` 一致 ——
 * 这里不能 `require` 那份实现（它在打包态位于 resources/server/src 下，路径由 main.js 决定），
 * 所以改成**测试里对账**：`test/m2e-export-native.test.js` 断言两者相等，漂移会判红。
 */
const MAX_EXPORT_BYTES = 20 * 1024 * 1024;

/** 错误文案的长度上限：IPC 返回值会进渲染进程，不把整段 fs/HTTP 报文原样抛过去 */
const MAX_ERROR_LEN = 200;

const DEFAULT_FILE_NAME = 'ww-profile-export.json';

/**
 * 精确同源判据：URL 解析后比 `origin`，**不是**字符串 includes。
 * 旧实现用 includes 时 `http://evil.com/?127.0.0.1:3210` 这类构造会被误判为站内
 * （`desktop/main.js` 的 SEC-03 整改就是修这个）。解析失败（含 `data:`/`javascript:` 等
 * origin 为 'null' 的形态）一律 false。
 */
function isSameOrigin(url, origin) {
  try { return new URL(url).origin === origin; } catch (_) { return false; }
}

/** 只接受白名单形态的 profileId；其余（含 undefined/null/非字符串/超长/带分隔符）抛 TypeError */
function assertProfileId(profileId) {
  if (typeof profileId !== 'string') throw new TypeError('profileId 必须是字符串');
  if (!PROFILE_ID_RE.test(profileId)) {
    throw new TypeError('profileId 形态不合法（只允许 1-64 位 A-Za-z0-9_-）');
  }
  return profileId;
}

/**
 * **主进程自己**把 profileId 拼成本机同源导出 URL。
 * @param port 本机服务端口（`startServer()` 选定的空闲端口）
 * 调用方只能给 profileId + 端口，**不能**给 URL/路径 —— 这就是"不接受任意路径"的落点。
 */
function buildExportUrl(port, profileId) {
  assertProfileId(profileId);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`本机服务端口不合法：${String(port)}`);
  }
  return `http://127.0.0.1:${port}/api/profiles/${profileId}/export`;
}

/** 拼好的 URL 仍要过一遍精确同源判据才允许触网（双保险：白名单若被放松，这里拦下） */
function assertLocalExportUrl(url, port) {
  if (!isSameOrigin(url, `http://127.0.0.1:${port}`)) {
    throw new TypeError(`拒绝导出：目标不是本机服务同源地址（${String(url)}）`);
  }
  return url;
}

/** 错误 → 单行、限长的文案（IPC 返回值里不留换行/超长报文） */
function sanitizeError(err) {
  const raw = err && err.message ? String(err.message) : (err === undefined || err === null ? '' : String(err));
  const one = raw.replace(/\s+/g, ' ').trim();
  return (one || '未知错误').slice(0, MAX_ERROR_LEN);
}

/** 三态构造器：saved **必须**带真实落盘路径，否则构造不出来（不许凭空宣称保存成功） */
function savedResult(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new TypeError('savedResult 需要真实的落盘路径');
  }
  return { status: 'saved', path: filePath };
}

/** 用户主动取消 —— 是**正常结局**，不是错误（不带 error 字段） */
function cancelledResult() { return { status: 'cancelled' }; }

function failedResult(err) { return { status: 'failed', error: sanitizeError(err) }; }

/** 任意值 → 三态字符串；不认识的取值一律 'failed'（绝不默认成成功） */
function normalizeStatus(raw) {
  return STATUSES.includes(raw) ? raw : 'failed';
}

/**
 * 三态归一化：任何输入都收敛成 `{ status: 'saved' | 'cancelled' | 'failed', … }`。
 * ⚠ 判据刻意收紧：
 *   · 只有字面量 `'saved'` 才算成功 —— `'ok'`/`'success'`/`true`/`1` → `'failed'`；
 *   · 声明 `'saved'` 但**没有落盘路径** → `'failed'`（"未经确认不宣称保存成功"）；
 *   · 非对象输入（null/字符串/布尔）→ `'failed'`。
 */
function normalizeResult(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  if (r.status === 'saved') {
    return (typeof r.path === 'string' && r.path.trim())
      ? savedResult(r.path)
      : failedResult(new Error('导出结果声明 saved 但没有落盘路径（按失败处理，不宣称保存成功）'));
  }
  if (r.status === 'cancelled') return cancelledResult();
  return failedResult(r.error || new Error(`无法识别的导出结果：${JSON.stringify(r.status === undefined ? null : r.status)}`));
}

/**
 * `dialog.showSaveDialog` 的返回 → `'cancelled'` 或 `{ status: 'save', filePath }`。
 * 取消判据是 `canceled === true` **或**拿不到非空 filePath —— 两者都算"用户没选文件"，
 * 因此都归 `'cancelled'`（不是失败），与 Android 侧 SAF 的 RESULT_CANCELED 同一语义。
 */
function classifySaveDialogResult(result) {
  const noPath = !result || typeof result.filePath !== 'string' || !result.filePath;
  if (!result || result.canceled === true || noPath) return { status: 'cancelled' };
  return { status: 'save', filePath: result.filePath };
}

/**
 * 文件名净化：只取最后一段（`/` 与 `\` 都切），去掉控制字符与 Windows 非法字符，
 * 去掉前导点（防 `..`/隐藏文件），限长。**任何**输入都不会返回带路径分隔符的名字 ——
 * 保存框的 defaultPath 因此不可能被服务端头里的 `../../evil.json` 带出目录。
 */
function safeFileName(raw, fallback = DEFAULT_FILE_NAME) {
  if (typeof raw !== 'string') return fallback;
  const base = raw.split(/[\\/]/).pop() || '';
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, 128);
}

/**
 * 从服务端 `Content-Disposition` 取建议文件名（`filename*=UTF-8''…` 优先，其次 `filename=`）。
 * 服务端给的是用户可见的昵称化文件名，沿用它比在本地拼 `ww-profile-<uuid>.json` 更友好；
 * 但**必须**过 safeFileName —— 服务端头是外部输入。
 */
function suggestedFileName(contentDisposition, fallback = DEFAULT_FILE_NAME) {
  const header = String(contentDisposition || '');
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try { return safeFileName(decodeURIComponent(star[1]), fallback); } catch (_) { /* 非法百分号编码 → 退到下面的分支 */ }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  if (plain) return safeFileName(plain[1], fallback);
  return safeFileName(null, fallback);
}

/** 供 main.js 拼 defaultPath 用（与 safeFileName 同一套判据，只多包一层 path.join） */
function describeTarget(dir, fileName) {
  return path.join(dir, safeFileName(fileName));
}

module.exports = {
  STATUSES, PROFILE_ID_RE, MAX_EXPORT_BYTES, MAX_ERROR_LEN, DEFAULT_FILE_NAME,
  isSameOrigin, assertProfileId, buildExportUrl, assertLocalExportUrl,
  sanitizeError, savedResult, cancelledResult, failedResult,
  normalizeStatus, normalizeResult, classifySaveDialogResult,
  safeFileName, suggestedFileName, describeTarget,
};
