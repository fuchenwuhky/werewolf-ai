/**
 * pwa.js — 离线能力与可访问性的共用脚本（P2-7）
 *
 * 两件事，桌面版与手机版共用同一份（避免两套实现行为不一致）：
 *   ① 注册 service worker + "新版本可用"提示（不强制刷新，见 sw.js 的说明）
 *   ② 离线状态横幅：断网时必须**明确告诉用户**，不能让界面看起来正常却什么都推不动
 *      （本项目的一贯原则：不静默降级）
 *   ③ 键盘/屏幕阅读器辅助：`Esc` 关闭浮层、`/` 聚焦首个输入框、跳转到主内容
 *
 * 独立成文件而不是塞进 app.js/m.js：这两个文件已经很大，而且这段逻辑两者完全一致。
 */
'use strict';
(function () {
  /** 取词：有 i18n.js 就用它，没有则退回中文原文（本文件独立可用） */
  const tr = (key, zh) => {
    const v = window.I18N && window.I18N.t(key);
    return v == null ? zh : v;
  };

  // ---------- 离线横幅 ----------
  function ensureBanner() {
    let el = document.getElementById('offline-banner');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'offline-banner';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.hidden = true;
    el.textContent = tr('pwa.offline', '⚠ 已断网：AI 需要联网才能行动，对局会停在这里；网络恢复后自动继续。');
    document.body.appendChild(el);
    return el;
  }

  function syncOnline() {
    const el = ensureBanner();
    const off = navigator.onLine === false;
    el.hidden = !off;
    document.documentElement.dataset.online = off ? 'off' : 'on';
  }

  // ---------- 新版本提示 ----------
  // 只有用户点了"立即刷新"才允许重载。
  // 曾经的写法是 controllerchange 一律 location.reload()，结果 service worker 首次安装时
  // activate 里的 clients.claim() 会抢过页面控制权、触发 controllerchange → **首次打开就自我重载一次**：
  // 用户看到闪一下，而且这一瞬间的点击会被新页面吞掉（表现为"点了没反应"）。
  let wantReload = false;

  function showUpdate(reg) {
    if (document.getElementById('sw-update')) return;
    const bar = document.createElement('div');
    bar.id = 'sw-update';
    bar.setAttribute('role', 'status');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = tr('pwa.update', '新版本可用 · 立即刷新');
    btn.addEventListener('click', () => {
      wantReload = true;
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      bar.remove();
    });
    bar.appendChild(btn);
    document.body.appendChild(bar);
  }

  function registerSw() {
    // Capacitor 里资源是本地打包的（页面来自 https://localhost），不需要也不能靠 SW 离线
    if (window.Capacitor) return;
    if (!('serviceWorker' in navigator)) return;
    if (!/^https?:$/.test(location.protocol)) return; // file:// 下注册必失败，别报错刷屏
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg);
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) showUpdate(reg);
          });
        });
      }).catch((e) => console.warn('[pwa] ' + tr('pwa.swFail', '离线能力注册失败（不影响正常使用）'), e && e.message));
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (wantReload) location.reload();
      });
    });
  }

  // ---------- 键盘与屏幕阅读器 ----------
  /**
   * Esc 关浮层（FIX-08）。全页**只有这一个** Esc 监听器；关闭动作交给页面自己的统一入口
   * `window.__wwEscClose()`（web/app.js 与 web/m/m.js 各自实现），因为只有页面知道：
   *   · 关哪个才算"最上层"（检视大卡 z-index 90 > 弹窗 76 > 笔记抽屉；手机端按返回栈 LIFO）；
   *   · 关一层要连带清理什么（遮罩、软键盘/视口监听、返回栈深度、body 滚动锁、焦点归还）。
   *
   * 这里曾经自己写 `l.hidden = true`，两个问题（都在真实浏览器里复现过）：
   *   ① `.modal{display:flex}` / `.m-sheet{display:flex}` 会盖掉 UA 的 `[hidden]{display:none}`
   *      ——作者样式优先于 UA 样式——属性设了，弹层照样在屏幕上（手机端实测：Esc 后弹层不消失，
   *      或只剩一个挡满全屏、点不动的遮罩）；
   *   ② 就算隐藏成功，遮罩、body 滚动锁、返回栈这些清理全被跳过。
   * 所以：有统一入口就交给它；没有（其它独立页面）才退回"按 hidden 隐藏整层遮罩"的兜底，
   * 且兜底必须作用在**遮罩**上 —— 只藏 .modal 会留下一个挡满全屏、点不动的遮罩。
   *
   * ⚠ 有意不关的浮层：身份翻牌浮层（桌面的 #role-overlay / 手机的 #m-flip「开始游戏」）是
   * "确认看到自己身份"的必经步骤，允许 Esc 跳过意味着玩家可能没看到身份就被推进对局；
   * 上帝面板同理（"关面板 = 退上帝视角"，保持原入口操作）。
   */
  function fallbackHideLayer(l) {
    if (l.tagName === 'DIALOG') { l.close(); return true; }
    const box = l.closest('.modal-mask, .m-sheet-mask') || l;
    box.hidden = true;
    return true;
  }

  function escCloseTopLayer() {
    if (typeof window.__wwEscClose === 'function') {
      try { if (window.__wwEscClose() === true) return true; } catch (_) { /* 页面钩子自身出错：退回兜底 */ }
    }
    let closed = false;
    for (const l of document.querySelectorAll('.overlay:not([hidden]), .modal:not([hidden]), .m-sheet:not([hidden]), dialog[open]')) {
      closed = fallbackHideLayer(l) || closed;
    }
    return closed;
  }

  function enhanceA11y() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (escCloseTopLayer()) e.preventDefault();
        return;
      }
      // `/` 聚焦第一个可见输入框（不动任何会输入文字的控件）
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) {
        const box = [...document.querySelectorAll('input:not([type=hidden]):not([disabled]), textarea:not([disabled])')]
          .find((el) => el.offsetParent !== null);
        if (box) { box.focus(); e.preventDefault(); }
      }
    });
  }

  function boot() {
    syncOnline();
    window.addEventListener('online', syncOnline);
    window.addEventListener('offline', syncOnline);
    enhanceA11y();
    registerSw();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
