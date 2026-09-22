/**
 * static.js — 静态文件服务（transport 层）
 *
 * 从 server.js 里抽出来，一是为了能单测（原来这段逻辑藏在闭包里，只能靠起服务间接验证），
 * 二是为 PWA 补上两件必须做的事：
 *
 *   ① **缓存头**：`sw.js` 必须 `no-cache`，否则浏览器会拿旧的 service worker 一直用下去，
 *      用户永远收不到新版前端（这是 PWA 最经典的"改了没生效"事故）；
 *      HTML/JS/CSS/清单同理走 `no-cache`（靠 ETag 协商，不牺牲速度），
 *      图片字体这类不变的资源才给长缓存。
 *
 *   ② **缺失资源必须 404，不能回落成 HTML**。原来的 SPA 兜底对任何找不到的路径都返回 index.html：
 *      请求 `/sw.js` 或某个不存在的 `.js` 会拿到一个 200 + HTML，
 *      service worker 安装时拿到 HTML 会直接失败，而排查时看状态码又是 200 —— 极难定位。
 *      现在：只有"看起来像路由"（无扩展名）的路径才回落，静态资源缺失就老实 404。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

/** 需要每次校验新鲜度的类型：前端资源与清单（配合 ETag，改动立刻生效） */
const NO_CACHE_EXT = new Set(['.html', '.js', '.css', '.webmanifest', '.json']);

/**
 * FIX-13：图标/位图这类资源**URL 不版本化**，不能给长缓存。
 *
 * 背景：`/favicon.ico`、`/assets/icon-192.png`、`/m/icon.svg` 的 URL 里没有内容指纹
 * （HTML 改写只覆盖被引用的 .js/.css，图标引用散落在 HTML、manifest、CSS、SW 清单四处），
 * 给 `max-age=86400` 就等于"换了图标，用户最长一天看不到新的"。
 *
 * 两个可选方向里选了后者（改动面小、不动前端契约）：
 *   · 版本化 URL：更彻底，但要同时改 HTML/manifest/CSS/SW 的引用形态（前端契约改动，且
 *     C08 用例明确钉住"非脚本资源不走 HTML 改写"的现状）；
 *   · **缩短缓存 + 协商校验**：短 max-age + must-revalidate，过期后必须回源，
 *     ETag（size+mtime）变了就 200 拿到新图 ⇒ 改动最长 ICON_MAX_AGE 秒后生效。
 */
const REVALIDATE_EXT = new Set(['.png', '.svg', '.ico']);
const ICON_MAX_AGE = 300;

/** 静态资源的 Cache-Control 值（导出以便单测直接断言策略，不必起服务） */
function cacheControlFor(ext, basename) {
  if (basename === 'sw.js') return 'no-cache'; // service worker：绝不缓存，否则更新永远收不到
  if (NO_CACHE_EXT.has(ext)) return 'no-cache';
  if (REVALIDATE_EXT.has(ext)) return `public, max-age=${ICON_MAX_AGE}, must-revalidate`; // FIX-13：图标类
  return 'public, max-age=86400'; // 字体等其余资源
}

/** 弱 ETag：文件大小 + mtime，足够用于协商缓存（普通静态资源继续用它） */
function etagOf(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

// ---------- HTML 表示层 ETag（FIN-01） ----------
// 旧实现用"源文件 stat"做 HTML ETag：sendHtml 会先改写资源引用再发body，
// 结果新旧两个不同表示共享同一个 ETag——浏览器拿旧 ETag 来协商时得到 304，
// 继续用没有版本化引用的旧缓存页（复审确认缺陷 C01）。
// 修复：HTML 的缓存校验必须针对**实际发送的字节**：
//   · ETag 从改写后的最终 body 计算，并加 `v2-` 命名空间与旧 stat ETag 区分
//     （旧 ETag 形如 W/"size-mtime"，永远不可能等于 v2 形态，旧缓存必然 200）；
//   · If-None-Match 在生成新表示**之后**比较；
//   · 输出缓存键 = 源内容标识 + 改写规则版本 + 每个本地 JS/CSS 的内容版本，
//     任何一个依赖变化都会重建表示并得到新 ETag（C03）。
const HTML_REWRITE_RULE_VERSION = '2';

/** 内容寻址 ETag：确定性（同内容同值，C02），命名空间与 stat ETag 隔离 */
function contentEtag(body) {
  const h = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
  return `W/"v2-${h}"`;
}

/** 请求路径是否"看起来是静态资源"（有扩展名）→ 缺失时应当 404 而不是回落 SPA */
function looksLikeAsset(pathname) {
  const base = pathname.slice(pathname.lastIndexOf('/') + 1);
  return /\.[a-z0-9]{1,8}$/i.test(base);
}

/**
 * 处理静态请求。
 * @param {object} req  http 请求
 * @param {object} res  http 响应
 * @param {string} pathname URL 路径（已解码）
 * @param {object} opts { webDir }
 */
// HTML 文档的安全响应头（整改阶段 2.2）。
// script-src 用"内联守卫脚本"的 sha256 哈希白名单（两端的初始化守卫 + 离线页），不用 unsafe-inline；
// style-src 暂需 unsafe-inline：界面大量使用 style 属性做昼夜/位置渲染 —— 已登记为迁移债务。
//
// ⚠ 离线页（web/offline.html）的那条哈希只能靠白名单放行，不能改成外链脚本：
//   test/pwa.test.js 的「离线页：不得依赖任何外部资源」明确禁止本页引用外部脚本
//   （离线页必须在"任何外部资源都取不到"时自己渲染；外链还要多依赖一份 SW 预缓存，
//    少一份都可能让按钮变成摆设）。所以这里给它的内联脚本登记哈希 ——
//   与两个 index 页的初始化守卫是同一套机制（改脚本必须同步改这里）。
//   · 同步要求：web/offline.html 必须保持 LF 行尾（.gitattributes 已钉 `text eol=lf`）——
//     命中 CSP 白名单的页面会被 brand:check 按"字节哈希路径"强制要求行尾钉版，
//     行尾一变哈希就错位（Windows 检出上会静默失效）。
//   · 曾经的误报（已修，A3c）：scripts/check-guards.js 的页面清单原先是**手写**的
//     `['web/index.html','web/m/index.html']`，于是它把离线页这条**正在被使用**的哈希报成
//     "陈旧条目，顺手删掉"（删掉就会让离线页的"重试/网络恢复回首页"再次被 CSP 静默拦掉）。
//     现在那张清单改成从 `web/**/*.html` 推导（只取带裸 `<script>` 内联块的页面，
//     见 scripts/check-guards.js 的 cspPages()），新增内联脚本页面不会再让这条误报复发。
//
// ⚠ img-src 追加 'data:' 的理由（A3c，真机 Chrome 实测）：本文件下发的 CSP 覆盖**所有** .html 响应，
//   而 web/style.css 与 web/shared/tokens.css 里有 3 处 `data:image/svg+xml` 背景
//   （.atmo-grain 噪点、checkbox 的勾、--ico-chevron-gold 下拉箭头）。
//   `img-src 'self'` 不含 data: ⇒ 这三处**一个都不渲染**：Chrome 对每个 URI 各报一条
//   "Loading the image 'data:image/svg+xml;…' violates … "img-src 'self'". The action has been blocked."
//   实测（1440×900 headless，冻结动画后同位置 A/B 像素比对）：噪点层撤掉前后 0/2304 像素有差异、
//   勾选层 0/289、下拉箭头 0/5600 —— 而同源 PNG 的阳性对照是 2304/2304，证明方法灵敏。
//   放宽到刚好够用：**只**在 img-src 追加 data:，其余指令逐字不动
//   （script-src 仍无 unsafe-inline、connect-src 仍只有 'self'，由 test/remediation.test.js 钉住）。
const HTML_SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'sha256-I43HymuDTCZT8ZYOm44OS9WzPkl7623/8xAv+p6wsOE=' 'sha256-wkqcyVTYd8Z8BWcuwv3o1BcjRMpIuKgop6GIZOedqJ4=' 'sha256-Gb59Pw8+CGFm9EYYSzaOlbqSQ2uPjA+4cFW4p5fMOuw='",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
};

function serveStatic(req, res, pathname, opts) {
  const webDir = opts.webDir;
  const file = pathname === '/' ? '/index.html' : pathname;
  const full = path.normalize(path.join(webDir, file));
  // 必须带分隔符比较：只写 startsWith(webDir) 会放行兄弟目录
  // （如 ../web-probe/secret.txt → D:\...\web-probe\... 也以 "web" 开头，可被读出）
  if (full !== webDir && !full.startsWith(webDir + path.sep)) {
    res.writeHead(403); return res.end('forbidden');
  }
  let target = full;
  try {
    if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  } catch (_) { /* 不存在则走下面的 404 / SPA 兜底 */ }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      if (looksLikeAsset(pathname)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('not found: ' + pathname);
      }
      // SPA 兜底：只有无扩展名的"路由"才回落到首页
      const index = path.join(webDir, 'index.html');
      return sendHtml(res, index, webDir,
        { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache', ...HTML_SECURITY_HEADERS },
        req.headers['if-none-match']);
    }
    const ext = path.extname(target);
    if (ext === '.html') {
      // HTML：ETag 基于"实际发送的改写后表示"，If-None-Match 在生成新表示之后比较
      return sendHtml(res, target, webDir, {
        'Content-Type': MIME['.html'],
        'Cache-Control': cacheControlFor(ext, path.basename(target)),
        'X-Content-Type-Options': 'nosniff',
        ...HTML_SECURITY_HEADERS,
      }, req.headers['if-none-match']);
    }
    // 普通资源维持 stat ETag（FIN-01 只改 HTML 表示层，不动其它响应头）
    const etag = etagOf(stat);
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControlFor(ext, path.basename(target)),
      ETag: etag,
      'X-Content-Type-Options': 'nosniff', // 防止把 HTML 当脚本执行
    };
    res.writeHead(200, headers);
    fs.readFile(target, (e3, data) => {
      if (e3) { res.writeHead(404); return res.end('not found'); }
      res.end(data);
    });
  });
}

// ---------- HTML 资源版本化（复审 P1-2；FIN-01 重做缓存与 ETag） ----------
// 背景：旧 Worker（缓存优先）控制页面时，首次升级仍会执行缓存里的旧 app.js——
// HTML 是网络优先的，但它引用的脚本 URL 不变，旧缓存就能一直命中。
// 解法：服务端下发 HTML 时把本地 .js/.css 引用改写成 `?v=<内容哈希>`。
// 内容变 → URL 变 → 旧缓存（按完整 URL 匹配）必然 miss → 首次加载即新代码；
// 命中缓存 ⟺ 哈希一致 ⟺ 内容相同，缓存永远不会有"同 URL 旧内容"。
//
// FIN-01：_htmlCache 旧键只有 HTML mtime——只改 app.js 不改 HTML 时，
// 缓存里的旧 `?v=` 哈希继续下发（C03 缺陷）。新键覆盖：源内容标识 +
// 改写规则版本 + 每个被引用 JS/CSS 的内容版本；任一变化即重建。
const _htmlCache = new Map(); // target -> { srcKey, deps: Map<path,{ver,size,mtimeMs}>, out, etag }

/** 引用文件的版本号：内容 sha256 前 12 位；读不到返回 null（保持原样，不改写） */
function assetVersionOf(fullPath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex').slice(0, 12);
  } catch (_) { return null; }
}

/**
 * FIX-13：依赖指纹 = 内容版本 + stat（size/mtimeMs）。
 * 为什么必须带上 stat：depsUnchanged() 每次导航都要判断依赖有没有变，而旧实现只能**读全文算 sha256**
 * （首页引用十几个 JS/CSS ⇒ 每次导航十几遍全量读盘）。有了 stat 才能先比 stat、只有 stat 变了才重读。
 * @returns {{ver: string, size: number, mtimeMs: number}|null}
 */
function depFingerprintOf(fullPath) {
  let stat = null;
  try { stat = fs.statSync(fullPath); } catch (_) { return null; }
  const ver = assetVersionOf(fullPath);
  if (!ver) return null;
  return { ver, size: stat.size, mtimeMs: stat.mtimeMs };
}

/** 解析 HTML 里的本地 .js/.css 引用（外部/内联引用原样保留）。
 *  相对引用（"m.js"、("../shared/a.js"）按 HTML 所在目录解析；根引用（"/style.css"）按站点根解析。
 *  @returns {{ out: string, deps: Map<string, {ver: string, size: number, mtimeMs: number}> }} deps: 绝对路径 → 依赖指纹 */
function renderHtmlDocument(html, baseDir, webDir) {
  const deps = new Map();
  const out = html.replace(/(src|href)="([^"#?]+?)\.(js|css)"/gi, (m, attr, ref, ext) => {
    if (/^(https?:)?\/\//i.test(ref) || /^(data|blob):/i.test(ref)) return m;
    const relFile = `${ref}.${ext}`;
    const full = relFile.startsWith('/')
      ? path.join(webDir, relFile.slice(1))
      : path.resolve(baseDir, relFile);
    const fp = depFingerprintOf(full);
    if (fp) deps.set(path.normalize(full), fp);
    return fp ? `${attr}="${ref}.${ext}?v=${fp.ver}"` : m;
  });
  return { out, deps };
}

/** 兼容导出：只要改写结果（旧测试/旧调用方继续可用） */
function rewriteHtmlAssets(html, baseDir, webDir) {
  return renderHtmlDocument(html, baseDir, webDir).out;
}

/**
 * 当前缓存键下的依赖是否都未变化（FIX-13：stat 短路）。
 *
 * 旧实现（注释里写着"stat 快速路径"，代码里却只有读全文哈希）：
 *   for (const [full, ver] of deps) { if (assetVersionOf(full) !== ver) return false; }
 * 即**每次导航**对每个被引用的 JS/CSS 都 readFileSync + sha256；首页十几个依赖 = 十几遍全量读盘。
 *
 * 现在：
 *   · stat 的 size+mtimeMs 都没动 ⇒ 直接判定未变（内容变**必然**伴随 stat 变），一次盘都不读；
 *   · stat 变了才重读重哈希：哈希不同 ⇒ 需要重建（false）；哈希相同（touch/同内容重写）
 *     ⇒ 把新 stat 记回指纹，避免下次导航又白读一次。
 */
function depsUnchanged(deps) {
  for (const [full, dep] of deps) {
    let stat = null;
    try { stat = fs.statSync(full); } catch (_) { return false; } // 依赖没了：必须重建
    if (dep.size === stat.size && dep.mtimeMs === stat.mtimeMs) continue; // stat 短路
    const v = assetVersionOf(full);
    if (!v || v !== dep.ver) return false;
    dep.size = stat.size;
    dep.mtimeMs = stat.mtimeMs;
  }
  return true;
}

/**
 * 读取并（对 HTML）版本化后发送。
 * @param {string} ifNoneMatch 请求头 If-None-Match（在生成新表示之后比较）
 */
function sendHtml(res, target, webDir, headers, ifNoneMatch) {
  let stat;
  try { stat = fs.statSync(target); } catch (_) { res.writeHead(404); return res.end('not found'); }
  const srcKey = `${HTML_REWRITE_RULE_VERSION}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
  const cached = _htmlCache.get(target);
  if (cached && cached.srcKey === srcKey && depsUnchanged(cached.deps)) {
    if (ifNoneMatch === cached.etag) {
      res.writeHead(304, { ETag: cached.etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    res.writeHead(200, { ...headers, ETag: cached.etag });
    return res.end(cached.out);
  }
  fs.readFile(target, (e, data) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    const { out, deps } = renderHtmlDocument(data.toString('utf8'), path.dirname(target), webDir);
    const etag = contentEtag(out);
    _htmlCache.set(target, { srcKey, deps, out, etag });
    if (ifNoneMatch === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    res.writeHead(200, { ...headers, ETag: etag });
    res.end(out);
  });
}

/** 测试钩子：清空 HTML 输出缓存（跨用例隔离） */
function _resetHtmlCache() { _htmlCache.clear(); }

module.exports = {
  MIME, cacheControlFor, etagOf, contentEtag, looksLikeAsset, serveStatic,
  rewriteHtmlAssets, renderHtmlDocument, assetVersionOf, HTML_REWRITE_RULE_VERSION,
  // FIX-13 测试钩子：直接断言"stat 未变就不读盘"的短路行为，不必起服务
  depFingerprintOf, depsUnchanged, ICON_MAX_AGE, REVALIDATE_EXT,
  _resetHtmlCache,
};
