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
  function enhanceA11y() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // 关闭可见的浮层（卡牌检视/设置弹层等统一带 .overlay 或 .modal）
        const layers = document.querySelectorAll('.overlay:not([hidden]), .modal:not([hidden]), dialog[open]');
        let closed = false;
        for (const l of layers) {
          if (l.tagName === 'DIALOG') l.close(); else l.hidden = true;
          closed = true;
        }
        if (closed) e.preventDefault();
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
