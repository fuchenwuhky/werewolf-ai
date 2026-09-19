/**
 * sw.js — 离线缓存（P2-7）
 *
 * 目标：**断网还能开局看牌局**，但绝不拿旧数据糊弄人。
 *
 * 三条策略：
 *   ① `/api/*` **一律不走缓存**。对局状态必须是最新的：把 `/view` 的响应缓存下来，
 *      断网重连后会看到一局"时间停止"的假象，而恢复后的第一个写操作又基于旧状态 —— 那是数据损坏。
 *      同理，响应里带 token 的东西不该留在磁盘缓存里。
 *   ② 导航请求（打开页面）→ 网络优先，失败退回缓存的外壳（或离线页）。
 *   ③ 静态资源（js/css/图片/清单）→ **网络优先，断网回退缓存**。
 *      曾经是"缓存优先 + 后台更新"：sw.js 自身没变时（版本号忘了升），用户会**无限期**
 *      运行缓存里的旧脚本 —— 前端修复（如升级迁移）永远到不了老用户（审核 P1-3）。
 *      本地服务延迟可忽略，在线永远拿最新；断网回退缓存，"离线还能看牌局"的目标不变。
 *
 * 更新策略：**不自动 skipWaiting**。对局中途悄悄换掉前端资源会造成
 * "页面是旧代码、接口是新行为"的错配；这里把新版本停在 waiting 状态，
 * 由页面（pwa.js）提示"新版本可用，点击刷新"，用户点了才切换。
 */
'use strict';

// 缓存版本：仅表示**结构代次**（预缓存清单/策略变更时手动升档）。
// 资源内容的新鲜度由"网络优先"策略保证，不再依赖版本号记忆 —— 忘记升版也不会跑旧脚本。
const VERSION = 'ww-v13-note'; // 档案/标注V2 + 网络优先资源策略（前代 ww-v12-note 缓存优先）
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

/** 预缓存的外壳：只有这些是"没网也要能打开"的必需品 */
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/i18n.js',
  '/card-frame.js',
  '/codex.js',
  '/rulebook.js',
  '/app.js',
  '/shared/annotations-model.js',
  '/ai-cast.js',
  '/ai-cast.html',
  '/ai-cast-page.js',
  '/ai-cast.css',
  '/pwa.js',
  '/offline.html',
  '/manifest.webmanifest',
  '/m/',
  '/m/index.html',
  '/m/m.css',
  '/m/m.js',
  '/assets/icon.svg',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll 会因为任意一个 404 整体失败 → 逐个加，缺一个不影响其余（并留下可诊断的日志）
    await Promise.all(SHELL.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); } catch (e) { console.warn('[sw] 预缓存失败', url, e && e.message); }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/** 静态资源：网络优先，断网回退缓存（审核 P1-3）。
 *  旧的「缓存优先 + 后台更新」在版本号未升时会让老用户无限期运行旧脚本；
 *  网络优先保证在线首次加载就是最新资源，离线时仍可命中缓存继续看牌。 */
async function networkFirstAsset(req) {
  const cache = await caches.open(ASSET_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (_) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw new Error('offline and not cached: ' + req.url);
  }
}

/** 导航：网络优先，失败退回缓存外壳 */
async function networkFirstNav(req) {
  try {
    return await fetch(req);
  } catch (_) {
    const cache = await caches.open(SHELL_CACHE);
    const url = new URL(req.url);
    const isMobile = url.pathname === '/m/' || url.pathname.startsWith('/m/');
    return (await cache.match(isMobile ? '/m/index.html' : '/index.html'))
      || (await cache.match('/offline.html'))
      || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // 写操作永不代理
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域交给浏览器
  if (url.pathname.startsWith('/api/')) return;    // 见文件头 ①：接口一律不进缓存
  if (req.mode === 'navigate') { event.respondWith(networkFirstNav(req)); return; }
  event.respondWith(networkFirstAsset(req));
});
