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
const _htmlCache = new Map(); // target -> { srcKey, deps: Map<path,ver>, out, etag }

/** 引用文件的版本号：内容 sha256 前 12 位；读不到返回 null（保持原样，不改写） */
function assetVersionOf(fullPath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex').slice(0, 12);
  } catch (_) { return null; }
}

/** 解析 HTML 里的本地 .js/.css 引用（外部/内联引用原样保留）。
 *  相对引用（"m.js"、("../shared/a.js"）按 HTML 所在目录解析；根引用（"/style.css"）按站点根解析。
 *  @returns {{ out: string, deps: Map<string, string> }} deps: 绝对路径 → 内容版本 */
function renderHtmlDocument(html, baseDir, webDir) {
  const deps = new Map();
  const out = html.replace(/(src|href)="([^"#?]+?)\.(js|css)"/gi, (m, attr, ref, ext) => {
    if (/^(https?:)?\/\//i.test(ref) || /^(data|blob):/i.test(ref)) return m;
    const relFile = `${ref}.${ext}`;
    const full = relFile.startsWith('/')
      ? path.join(webDir, relFile.slice(1))
      : path.resolve(baseDir, relFile);
    const v = assetVersionOf(full);
    if (v) deps.set(path.normalize(full), v);
    return v ? `${attr}="${ref}.${ext}?v=${v}"` : m;
  });
  return { out, deps };
}

/** 兼容导出：只要改写结果（旧测试/旧调用方继续可用） */
function rewriteHtmlAssets(html, baseDir, webDir) {
  return renderHtmlDocument(html, baseDir, webDir).out;
}

/** 当前缓存键下的依赖是否都未变化（stat 快速路径：内容变化必然伴随 stat 变化；
 *  stat 未变即视为未变——键中已包含各依赖上次的内容版本，stat 变化才重读重哈希） */
function depsUnchanged(deps) {
  for (const [full, ver] of deps) {
    const v = assetVersionOf(full);
    if (v !== ver) return false;
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
  _resetHtmlCache,
};
