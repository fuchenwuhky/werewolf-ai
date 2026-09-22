/**
 * export-status.js — 三态归一化（**浏览器臂专用口径**）
 *
 * 为什么要有这个文件（M2-e 浏览器臂）：
 *   Electron 与 Android 两臂有原生保存框，能**确知**用户是否真的落盘，所以它们的结束态就是
 *   `'saved' | 'cancelled' | 'failed'`（见 `desktop/export-core.js` 的冻结实现）。
 *   **浏览器没有这个能力**：同源下载只能证明"我们把下载**发起**了"，无法知道用户是否保存、
 *   存到哪、有没有中途取消。按计划书 `docs/next-stage-implementation-plan.md:237`
 *   「浏览器：同源下载，UI **只提示"已发起下载"**，**未经确认不宣称保存成功**」，
 *   这里显式引入浏览器独有的第三态 `'started'`，并且**在类型层面就不给出 `saved`**。
 *
 * 铁律（与两臂同源）：**只有字面量 `'saved'` 且带真实落盘路径才算成功**；
 * `'ok'` / `'success'` / `true` / `1` / 缺路径 / 非对象 一律落 `'failed'` —— 绝不默认成功。
 *
 * 纯逻辑、零依赖：浏览器里挂 `window.WWTransferStatus`，Node 单测里直接 require。
 */
(function (global) {
  'use strict';

  /** 原生两臂的冻结三态（与 desktop/export-core.js:28 同值，漂移即判红，有测试钉住）。 */
  const STATUSES = Object.freeze(['saved', 'cancelled', 'failed']);

  /** 浏览器臂能产出的状态：**只有这两种**，`saved` 与 `cancelled` 在浏览器里不可知。 */
  const BROWSER_STATUSES = Object.freeze(['started', 'failed']);

  /** 错误文案单行化后的长度上限（同 export-core 的口径，避免把超长报文带进 UI）。 */
  const MAX_ERROR_LEN = 200;

  /** 与 `src/profiles/transfer.js:17` 的 MAX_BYTES 同值（20MiB）：浏览器侧只用于**预检提示**，
   *  真正的强制点仍在服务端，这里绝不替代服务端校验。 */
  const MAX_EXPORT_BYTES = 20 * 1024 * 1024;

  /** 任意错误 → 单行、限长的字符串（不留换行，不留超长报文）。 */
  function sanitizeError(err) {
    let s;
    if (err == null) s = '未知错误';
    else if (typeof err === 'string') s = err;
    else if (err && typeof err.message === 'string' && err.message) s = err.message;
    else {
      try { s = JSON.stringify(err); } catch (_) { s = String(err); }
    }
    s = String(s == null ? '未知错误' : s).replace(/[\r\n\t]+/g, ' ').trim();
    if (!s) s = '未知错误';
    return s.length > MAX_ERROR_LEN ? s.slice(0, MAX_ERROR_LEN - 1) + '…' : s;
  }

  function failedResult(err) { return { status: 'failed', error: sanitizeError(err) }; }

  /**
   * 浏览器导出臂的结局判定。
   *
   * 传入 `{ downloadStarted: true }` ⇒ `{ status: 'started' }`；
   * 传 `{ error }` 或**任何别的形状** ⇒ `{ status: 'failed' }`。
   *
   * ⚠ 这里**永远不可能**返回 `'saved'` —— 浏览器没有落盘证据。若将来有人想让它返回 `saved`，
   *   必须先让浏览器拿到真实落盘路径（当前 Web 平台给不出），否则就是"未经确认宣称保存成功"。
   */
  function browserExportOutcome(input) {
    const i = input || {};
    if (i.error != null && i.error !== '') return failedResult(i.error);
    if (i.downloadStarted === true) return { status: 'started' };
    return failedResult(new Error('导出未被发起（未触发下载）'));
  }

  /** 任意值 → 状态字符串；不认识的取值一律 `'failed'`（绝不默认成成功）。 */
  function normalizeStatus(raw) {
    return STATUSES.includes(raw) ? raw : 'failed';
  }

  /**
   * 归一化**任意一臂**的返回值为统一结构 `{ status, path?, error? }`。
   * 与 `desktop/export-core.js:121` 的 `normalizeResult` 同语义，额外认下浏览器独有的 `'started'`。
   */
  function normalizeResult(raw) {
    if (typeof raw === 'string') {
      if (raw === 'started') return { status: 'started' };
      return failedResult(new Error('导出结果只有状态字符串，无法确认落盘'));
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return failedResult(new Error('无法识别的导出结果（不是对象）'));
    }
    if (raw.status === 'saved') {
      const p = typeof raw.path === 'string' ? raw.path.trim() : '';
      return p ? { status: 'saved', path: p }
        : failedResult(new Error('导出结果声明 saved 但没有落盘路径（按失败处理，不宣称保存成功）'));
    }
    if (raw.status === 'cancelled') return { status: 'cancelled' };
    if (raw.status === 'started') return { status: 'started' };
    return failedResult(raw.error || new Error('无法识别的导出结果：'
      + JSON.stringify(raw.status === undefined ? null : raw.status)));
  }

  /**
   * 结局 → 给用户看的一句话。
   * ⚠ `'started'` 的文案**必须**说清"浏览器无法确认是否已保存"，不得暗示保存成功。
   */
  function formatOutcome(outcome) {
    const o = normalizeResult(outcome);
    if (o.status === 'started') {
      return '已发起下载 —— 浏览器无法确认文件是否已保存，请到浏览器的下载目录确认。';
    }
    if (o.status === 'saved') return `已保存到：${o.path}`;
    if (o.status === 'cancelled') return '已取消导出（没有写入任何文件）。';
    return `导出失败：${o.error}`;
  }

  /** 人类可读的字节数（用于预览里的"包大小"）。 */
  function humanBytes(n) {
    const b = Number(n);
    if (!Number.isFinite(b) || b < 0) return '未知大小';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1048576).toFixed(2)} MB`;
  }

  /**
   * 导入预览文案（计划书 §7）：档案名 / 已结束对局数 / 笔记数 / **包大小**。
   *
   * `bytes` 是**本地文件大小**（`File.size`），来自用户选中的那个文件；服务端预览只回内容计数，
   * 所以大小必须由调用方传进来。超过 20MiB 时**额外警告**，但不在这里拦截
   * （拦截口径仍以服务端 `validateImportPackage` 为准，避免两处判据漂移）。
   */
  function describePreview(preview, bytes) {
    const p = preview || {};
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const lines = [
      '导入预览（尚未写入任何数据）：',
      '',
      `档案：${p.nickname || '（未命名）'}`,
      `已结束对局：${n(p.games)} 局（ID 会重新生成，不覆盖现有对局）`,
      `笔记：${n(p.notes)} 份`,
      `包大小：${humanBytes(bytes)}`,
    ];
    const over = Number.isFinite(Number(bytes)) && Number(bytes) > MAX_EXPORT_BYTES;
    if (over) lines.push('', `⚠ 这个包超过 ${humanBytes(MAX_EXPORT_BYTES)} 上限，服务端多半会拒收。`);
    lines.push('', '进行中的对局不会包含在包内。确认导入？');
    return lines.join('\n');
  }

  const api = {
    STATUSES, BROWSER_STATUSES, MAX_ERROR_LEN, MAX_EXPORT_BYTES,
    sanitizeError, failedResult, browserExportOutcome,
    normalizeStatus, normalizeResult, formatOutcome, humanBytes, describePreview,
  };
  global.WWTransferStatus = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
