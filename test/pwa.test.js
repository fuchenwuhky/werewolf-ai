/**
 * pwa.test.js — 离线能力、图标与静态服务（P2-7）
 *
 * 这一层最容易"看着像做了其实没生效"：manifest 里写个 PNG 图标但文件不存在、
 * service worker 里漏了 `/api/` 绕过、缺失资源被 SPA 兜底返回 HTML 导致 SW 安装失败……
 * 这些在浏览器里往往只表现为"离线还是打不开"或"改了代码没生效"，很难定位。
 * 所以这里逐项静态校验 + 起真实 HTTP 服务验证响应头与 404 行为。
 *
 * 依据：Chromium 的"可安装"要求清单里至少有一个 192×192 与一个 512×512 的 PNG 图标；
 * iOS 的 apple-touch-icon 不支持 SVG（只给 SVG 会得到白图）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { cacheControlFor, etagOf, looksLikeAsset, serveStatic, ICON_MAX_AGE } = require('../src/static');

const WEB = path.join(__dirname, '..', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(WEB, p));

/** 解析 PNG 的 IHDR：宽高 + 签名合法性（比"文件存在"强得多） */
function pngInfo(file) {
  const buf = fs.readFileSync(path.join(WEB, file));
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  assert.deepStrictEqual([...buf.subarray(0, 8)], sig, `${file} 不是合法 PNG`);
  assert.strictEqual(buf.subarray(12, 16).toString('ascii'), 'IHDR', `${file} 缺少 IHDR`);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    hasAlpha: buf[25] === 6,
  };
}

// ---------- 图标 ----------

test('图标：192/512 PNG 必须存在且尺寸与清单声明一致（Chromium 可安装性要求）', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  const pngs = m.icons.filter((i) => i.type === 'image/png');
  assert.ok(pngs.length >= 2, '至少要有 192 与 512 两个 PNG');
  for (const icon of pngs) {
    const file = icon.src.replace(/^\//, '');
    assert.ok(exists(file), `清单里的图标文件不存在：${icon.src}`);
    const info = pngInfo(file);
    const [w, h] = icon.sizes.split('x').map(Number);
    assert.strictEqual(info.width, w, `${file} 实际宽度 ${info.width} ≠ 声明 ${w}`);
    assert.strictEqual(info.height, h, `${file} 实际高度 ${info.height} ≠ 声明 ${h}`);
  }
  const sizes = pngs.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), '必须同时提供 192 与 512');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable' && i.type === 'image/png'), 'Android 自适应图标需要 maskable PNG');
});

test('图标：apple-touch-icon 必须是 PNG 且不含 alpha（iOS 上透明会变白块）', () => {
  const info = pngInfo('assets/apple-touch-icon.png');
  assert.strictEqual(info.width, 180, 'iOS 主屏图标按 180×180 提供');
  assert.strictEqual(info.hasAlpha, false, 'iOS 对透明背景处理不佳，必须用不透明 RGB');
  for (const page of ['index.html', 'm/index.html']) {
    const html = read(page);
    assert.match(html, /rel="apple-touch-icon"[^>]*apple-touch-icon\.png/, `${page} 必须指向 PNG 版 apple-touch-icon`);
    assert.doesNotMatch(html, /rel="apple-touch-icon"[^>]*\.svg/, `${page} 不应把 SVG 当作 apple-touch-icon（iOS 不支持）`);
  }
});

test('清单：必备字段齐全，start_url/scope 与手机端一致', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color', 'icons', 'lang']) {
    assert.ok(m[k], `清单缺少字段 ${k}`);
  }
  assert.strictEqual(m.start_url, '/m/', '手机端是主要入口');
  assert.strictEqual(m.display, 'standalone');
  assert.ok(exists('m/index.html'), 'start_url 指向的页面必须存在');
});

// ---------- service worker ----------

test('service worker：语法有效，且预缓存列表里的每个文件都真实存在', () => {
  const src = read('sw.js');
  assert.doesNotThrow(() => new vm.Script(src), 'sw.js 必须能被解析（浏览器里语法错误会让 SW 静默失效）');
  const list = src.match(/const SHELL = \[([\s\S]*?)\];/)[1]
    .split('\n').map((l) => (l.match(/'([^']+)'/) || [])[1]).filter(Boolean);
  assert.ok(list.length >= 10, `预缓存列表过短（${list.length}）`);
  for (const url of list) {
    const rel = url === '/' || url.endsWith('/') ? url.replace(/^\//, '') + 'index.html' : url.replace(/^\//, '');
    assert.ok(exists(rel), `预缓存里的文件不存在：${url}（会导致离线缺资源）`);
  }
});

test('service worker：必须有 install/activate/fetch/message 四个处理器与缓存版本清理', () => {
  const src = read('sw.js');
  for (const ev of ['install', 'activate', 'fetch', 'message']) {
    assert.ok(new RegExp(`addEventListener\\('${ev}'`).test(src), `缺少 ${ev} 处理器`);
  }
  assert.match(src, /caches\.keys\(\)/, 'activate 里必须清理旧缓存，否则版本越堆越多');
  assert.match(src, /\(k\) => !k\.startsWith\(VERSION\)/, '只保留当前版本的缓存');
});

test('service worker：/api/ 与跨域请求必须绕过缓存（否则会拿到过期的对局状态）', () => {
  const src = read('sw.js');
  assert.match(src, /pathname\.startsWith\('\/api\/'\)\)\s*return/, '接口请求必须直接放行、不进缓存');
  assert.match(src, /url\.origin !== self\.location\.origin\)\s*return/, '跨域请求交给浏览器');
  assert.match(src, /req\.method !== 'GET'\)\s*return/, '写操作永不代理');
  // 关键：不能把 API 响应写进 cache
  assert.doesNotMatch(src, /cache\.put\([^)]*\/api/, '不得缓存接口响应');
});

test('service worker：不自动 skipWaiting（对局中途换掉前端资源会造成前后端错配）', () => {
  const src = read('sw.js');
  const installBlock = src.slice(src.indexOf("addEventListener('install'"), src.indexOf("addEventListener('activate'"));
  assert.doesNotMatch(installBlock, /skipWaiting/, 'install 阶段不得自动 skipWaiting');
  assert.match(src, /SKIP_WAITING/, '必须由页面消息触发切换（用户点"刷新"时）');
});

test('注册脚本：controllerchange 不得无条件重载（首次安装会自我重载，吞掉用户的第一下点击）', () => {
  const pwa = read('pwa.js');
  // service worker 首次激活时 activate 里的 clients.claim() 会触发 controllerchange，
  // 若无条件 location.reload()，用户第一次打开应用就会看到闪一下重载。
  const handler = pwa.slice(pwa.indexOf("addEventListener('controllerchange'"));
  const body = handler.slice(0, handler.indexOf('}') + 2);
  assert.match(body, /wantReload/, '必须由"用户点了刷新"这一条件守着');
  assert.doesNotMatch(body.replace(/if \(wantReload\)[^\n]*/, ''), /location\.reload/,
    'controllerchange 里除条件重载外不得再出现无条件 reload');
  assert.match(pwa, /wantReload = true/, '"立即刷新"按钮必须先置位再发 SKIP_WAITING');
});

// ---------- 页面接线 ----------

test('页面接线：两个界面都注册 pwa.js、引用清单，并有跳转链接与主区域语义', () => {
  for (const page of ['index.html', 'm/index.html']) {
    const html = read(page);
    assert.match(html, /<script src="(\.\.\/)?pwa\.js"><\/script>/, `${page} 必须加载 pwa.js`);
    assert.match(html, /rel="manifest"/, `${page} 必须引用 manifest`);
    assert.match(html, /class="skip-link"/, `${page} 必须有跳转到主内容的链接（键盘用户）`);
    assert.match(html, /role="main"/, `${page} 主区域必须有 main 语义`);
    assert.match(html, /<html lang="zh-CN">/, `${page} 必须声明语言（屏幕阅读器发音）`);
  }
  const pwa = read('pwa.js');
  assert.match(pwa, /navigator\.serviceWorker\.register\('\/sw\.js'\)/, '必须注册 /sw.js');
  assert.match(pwa, /window\.Capacitor/, 'Capacitor 内嵌环境必须跳过 SW 注册');
  assert.match(pwa, /navigator\.onLine/, '必须监听在线状态');
  assert.match(pwa, /id = 'offline-banner'/, '离线横幅的 id 必须与 CSS 一致');
});

test('页面接线：两个界面引用的每个本地资源都必须真实存在（路径写错会静默白屏）', () => {
  for (const page of ['index.html', 'm/index.html']) {
    const html = read(page);
    const dir = path.dirname(page);
    const refs = [
      ...[...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]),
      ...[...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]),
      ...[...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]),
    ].filter((r) => !/^(https?:)?\/\//.test(r));
    assert.ok(refs.length >= 4, `${page} 的引用过少（${refs.length}），正则可能没匹配上`);
    for (const ref of refs) {
      const target = path.join(WEB, dir === '.' ? '' : dir, ref);
      assert.ok(fs.existsSync(target), `${page} 引用了不存在的资源：${ref}`);
    }
  }
});

test('离线页：不得依赖任何外部资源（断网时它必须能自己渲染）', () => {
  const html = read('offline.html');
  assert.doesNotMatch(html, /<link[^>]+stylesheet/, '离线页不能引用外部样式表');
  assert.doesNotMatch(html, /<script[^>]+src=/, '离线页不能引用外部脚本');
  assert.doesNotMatch(html, /https?:\/\//, '离线页不得引用任何 http(s) 资源');
  assert.match(html, /<style>/, '样式必须内联');
});

test('样式：离线横幅/更新提示/跳转链接都有样式，且尊重"减少动态效果"', () => {
  for (const css of ['style.css', 'm/m.css']) {
    const s = read(css);
    assert.match(s, /#offline-banner/, `${css} 缺少离线横幅样式`);
    assert.match(s, /#sw-update/, `${css} 缺少更新提示样式`);
    assert.match(s, /\.skip-link/, `${css} 缺少跳转链接样式`);
    assert.match(s, /focus-visible/, `${css} 必须有可见焦点（暗色主题下默认描边几乎看不见）`);
    assert.match(s, /prefers-reduced-motion: reduce/, `${css} 必须尊重"减少动态效果"`);
  }
});

// ---------- 静态服务（真实 HTTP） ----------

test('静态服务：缓存策略——sw.js 绝不缓存，图标族短缓存可失效，字体长缓存', () => {
  assert.strictEqual(cacheControlFor('.js', 'sw.js'), 'no-cache', 'sw.js 必须 no-cache，否则更新永远收不到');
  for (const [ext, base] of [['.html', 'index.html'], ['.js', 'app.js'], ['.css', 'style.css'], ['.webmanifest', 'manifest.webmanifest']]) {
    assert.strictEqual(cacheControlFor(ext, base), 'no-cache', `${base} 需要每次校验（配合 ETag）`);
  }
  // FIX-13：图标/品牌图的 URL **不版本化**（HTML 改写只覆盖 .js/.css），长缓存会让"换了图标用户看不到"。
  // 策略改为短 max-age + must-revalidate：过期必须回源，ETag 变了就 200 拿到新图。
  for (const [ext, base] of [['.png', 'icon-512.png'], ['.svg', 'icon.svg'], ['.ico', 'favicon.ico']]) {
    assert.strictEqual(
      cacheControlFor(ext, base), `public, max-age=${ICON_MAX_AGE}, must-revalidate`,
      `${base} 必须可失效（URL 不版本化，只能靠短缓存 + 协商校验）`,
    );
  }
  assert.strictEqual(cacheControlFor('.woff2', 'font.woff2'), 'public, max-age=86400', '字体等其余资源仍长缓存');
});

test('静态服务：有扩展名的路径缺失时 404，只有"路由"才回落 SPA', () => {
  assert.strictEqual(looksLikeAsset('/sw.js'), true);
  assert.strictEqual(looksLikeAsset('/assets/icon-999.png'), true);
  assert.strictEqual(looksLikeAsset('/m/m.js'), true);
  assert.strictEqual(looksLikeAsset('/game'), false);
  assert.strictEqual(looksLikeAsset('/'), false);
});

test('静态服务（真实请求）：MIME、缓存头、ETag 304、缺失资源 404', async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    serveStatic(req, res, decodeURIComponent(u.pathname), { webDir: WEB });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, headers) => fetch(base + p, { headers });
  try {
    // service worker：no-cache + JS MIME
    const sw = await get('/sw.js');
    assert.strictEqual(sw.status, 200);
    assert.strictEqual(sw.headers.get('cache-control'), 'no-cache');
    assert.match(sw.headers.get('content-type'), /javascript/);
    assert.strictEqual(sw.headers.get('x-content-type-options'), 'nosniff');

    // 清单：专用 MIME（错成 text/plain 会导致部分浏览器拒绝安装）
    const mf = await get('/manifest.webmanifest');
    assert.strictEqual(mf.headers.get('content-type'), 'application/manifest+json; charset=utf-8');

    // 图标：FIX-13 短缓存 + 强制回源（URL 不版本化，长缓存会让新图标看不到）
    const icon = await get('/assets/icon-192.png');
    assert.strictEqual(icon.status, 200);
    assert.strictEqual(icon.headers.get('cache-control'), `public, max-age=${ICON_MAX_AGE}, must-revalidate`);

    // ETag 协商：带 If-None-Match 必须 304
    const etag = sw.headers.get('etag');
    assert.ok(etag, '必须返回 ETag');
    const again = await get('/sw.js', { 'If-None-Match': etag });
    assert.strictEqual(again.status, 304, 'ETag 命中应返回 304');

    // 缺失的静态资源 → 404（不能回落成 HTML：SW 安装时拿到 HTML 会直接失败）
    const missing = await get('/not-exist-abc.js');
    assert.strictEqual(missing.status, 404);
    assert.doesNotMatch(missing.headers.get('content-type'), /html/);

    // 缺失的"路由" → SPA 兜底返回首页
    const route = await get('/some/deep/route');
    assert.strictEqual(route.status, 200);
    assert.match(route.headers.get('content-type'), /html/);

    // 目录请求补 index.html
    const dir = await get('/m/');
    assert.strictEqual(dir.status, 200);
    assert.match(await dir.text(), /<html/);

    // 目录穿越必须被拒
    const evil = await get('/../server.js');
    assert.ok([403, 404].includes(evil.status), `目录穿越应被拒绝，实际 ${evil.status}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('静态服务：ETag 由大小与修改时间决定（可复现且随改动变化）', () => {
  const a = etagOf({ size: 100, mtimeMs: 1700000000000 });
  const b = etagOf({ size: 100, mtimeMs: 1700000000000 });
  const c = etagOf({ size: 101, mtimeMs: 1700000000000 });
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

test('service worker：静态资源必须网络优先（缓存优先会让老用户无限期运行旧脚本，审核 P1-3）', () => {
  const src = read('sw.js');
  assert.match(src, /async function networkFirstAsset/, '必须存在网络优先的资源策略');
  // 验收 P1：event 必须传进去（供 cache.put 挂 waitUntil，否则 SW 可能在写盘前被终止）
  assert.match(src, /event\.respondWith\(networkFirstAsset\(req, event\)\)/, 'fetch 处理器必须对静态资源走 networkFirstAsset 并传入 event');
  assert.doesNotMatch(src, /cacheFirst/, '缓存优先实现必须删除（防回归）');
  // 网络失败必须回退缓存（离线还能看牌局），缓存也没有才抛错
  const fn = src.slice(src.indexOf('async function networkFirstAsset'));
  assert.match(fn, /catch \(_\)/, '网络失败必须被捕获');
  assert.match(fn, /cache\.match\(req\)/, '失败时回退缓存');
  // 验收 P1：预缓存清单是无查询串 URL，而 HTML 里的 js/css 被改写成 ?v=<哈希>，
  // 少了 ignoreSearch 兜底，预缓存条目永远命中不了（"装完 SW 还没联网就断网，脚本全 miss"）。
  assert.match(fn, /cache\.match\(req, \{ ignoreSearch: true \}\)/, '离线兜底必须忽略查询串');
  assert.match(fn, /event\.waitUntil\(cache\.put/, '资源落盘必须挂 waitUntil');
});

test('静态服务：HTML 引用的本地 js/css 必须带内容哈希版本 URL（复审 P1-2 升级安全）', async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    serveStatic(req, res, decodeURIComponent(u.pathname), { webDir: WEB });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const page of ['/', '/m/']) {
      const res = await fetch(base + page);
      const html = await res.text();
      // app.js / m.js / shared 模型：必须带 ?v= 且哈希与文件内容一致
      const wanted = page === '/' ? ['app.js', 'shared/annotations-model.js', 'pwa.js'] : ['m.js', '../shared/annotations-model.js'];
      const esc = (c) => String.fromCharCode(92) + c;
      for (const ref of wanted) {
        const pat = `src="([^"]*${ref.replace(/[/.]/g, esc)})\\?v=([0-9a-f]{12})"`;
        const m = html.match(new RegExp(pat));
        assert.ok(m, `${page} 必须引用版本化的 ${ref}`);
        const fs = require('fs');
        const path = require('path');
        const crypto = require('crypto');
        const base = page === '/' ? WEB : path.join(WEB, 'm');
        const full = path.resolve(base, ref);
        const expect = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 12);
        assert.strictEqual(m[2], expect, `${ref} 的版本哈希必须等于其内容 sha256（内容变→URL 变→旧缓存必 miss）`);
      }
      // 旧 Worker 的缓存按完整 URL 匹配：带 ?v= 的请求在旧缓存里必然不存在
      assert.doesNotMatch(html, /src="(app|m)\.js"/, `${page} 不得残留无版本引用`);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
