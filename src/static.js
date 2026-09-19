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

/** 静态资源的 Cache-Control 值（导出以便单测直接断言策略，不必起服务） */
function cacheControlFor(ext, basename) {
  if (basename === 'sw.js') return 'no-cache'; // service worker：绝不缓存，否则更新永远收不到
  if (NO_CACHE_EXT.has(ext)) return 'no-cache';
  return 'public, max-age=86400'; // 图片/图标等不变资源
}

/** 弱 ETag：文件大小 + mtime，足够用于协商缓存 */
function etagOf(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
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
// script-src 用"内联守卫脚本"的 sha256 哈希白名单（两端的初始化守卫），不用 unsafe-inline；
// style-src 暂需 unsafe-inline：界面大量使用 style 属性做昼夜/位置渲染 —— 已登记为迁移债务。
const HTML_SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'sha256-I43HymuDTCZT8ZYOm44OS9WzPkl7623/8xAv+p6wsOE=' 'sha256-wkqcyVTYd8Z8BWcuwv3o1BcjRMpIuKgop6GIZOedqJ4='",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self'",
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
      return sendHtml(res, index, webDir, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache', ...HTML_SECURITY_HEADERS });
    }
    const etag = etagOf(stat);
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
    const ext = path.extname(target);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControlFor(ext, path.basename(target)),
      ETag: etag,
      'X-Content-Type-Options': 'nosniff', // 防止把 HTML 当脚本执行
    };
    if (ext === '.html') {
      Object.assign(headers, HTML_SECURITY_HEADERS); // CSP 只约束文档
      return sendHtml(res, target, webDir, headers);
    }
    res.writeHead(200, headers);
    fs.readFile(target, (e3, data) => {
      if (e3) { res.writeHead(404); return res.end('not found'); }
      res.end(data);
    });
  });
}

// ---------- HTML 资源版本化（复审 P1-2） ----------
// 背景：旧 Worker（缓存优先）控制页面时，首次升级仍会执行缓存里的旧 app.js——
// HTML 是网络优先的，但它引用的脚本 URL 不变，旧缓存就能一直命中。
// 解法：服务端下发 HTML 时把本地 .js/.css 引用改写成 `?v=<内容哈希>`。
// 内容变 → URL 变 → 旧缓存（按完整 URL 匹配）必然 miss → 首次加载即新代码；
// 命中缓存 ⟺ 哈希一致 ⟺ 内容相同，缓存永远不会有"同 URL 旧内容"。
const _htmlCache = new Map(); // target -> { mtimeMs, out }

/** 引用文件的版本号：内容 sha256 前 12 位；读不到返回 null（保持原样，不改写） */
function assetVersionOf(fullPath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex').slice(0, 12);
  } catch (_) { return null; }
}

/** 把 HTML 里的本地 .js/.css 引用改写为内容哈希版本 URL（外部/内联引用原样保留）。
 *  相对引用（"m.js"、("../shared/a.js"）按 HTML 所在目录解析；根引用（"/style.css"）按站点根解析。 */
function rewriteHtmlAssets(html, baseDir, webDir) {
  return html.replace(/(src|href)="([^"#?]+?)\.(js|css)"/gi, (m, attr, ref, ext) => {
    if (/^(https?:)?\/\//i.test(ref) || /^(data|blob):/i.test(ref)) return m;
    const relFile = `${ref}.${ext}`;
    const full = relFile.startsWith('/')
      ? path.join(webDir, relFile.slice(1))
      : path.resolve(baseDir, relFile);
    const v = assetVersionOf(full);
    return v ? `${attr}="${ref}.${ext}?v=${v}"` : m;
  });
}

/** 读取并（对 HTML）版本化后发送；带 mtime 缓存，避免每个请求重复哈希 */
function sendHtml(res, target, webDir, headers) {
  let stat;
  try { stat = fs.statSync(target); } catch (_) { res.writeHead(404); return res.end('not found'); }
  const cached = _htmlCache.get(target);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    res.writeHead(200, headers);
    return res.end(cached.out);
  }
  fs.readFile(target, (e, data) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    const out = rewriteHtmlAssets(data.toString('utf8'), path.dirname(target), webDir);
    _htmlCache.set(target, { mtimeMs: stat.mtimeMs, out });
    res.writeHead(200, headers);
    res.end(out);
  });
}

module.exports = { MIME, cacheControlFor, etagOf, looksLikeAsset, serveStatic, rewriteHtmlAssets, assetVersionOf };
