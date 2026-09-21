/**
 * static-cache-invalidation.test.js — 图标类资源可失效 + HTML 依赖校验的 stat 短路（FIX-13 回归）
 *
 * 缺陷复述（两半，都在 `src/static.js`）：
 *   ① `cacheControlFor()` 给图片/图标 `.png/.svg/.ico` 一律 `public, max-age=86400`，而它们的 URL
 *      **不版本化**（`/assets/icon-192.png`、`/m/icon.svg`、`/favicon.ico` 都是裸路径）⇒ 改了图标，
 *      用户在最长一天里看不到新的（旧图标还被缓存按 URL 匹配一路命中）。
 *   ② `depsUnchanged()` 的注释写着"stat 快速路径"，代码里却**只有读全文哈希**：
 *      `for (const [full, ver] of deps) if (assetVersionOf(full) !== ver) return false;` ——
 *      每次导航都对每个被引用的 JS/CSS `readFileSync` + sha256（首页十几个依赖 = 十几遍全量读盘）。
 *
 * 本文件钉住：
 *   · 图标族 = 短 max-age + must-revalidate；且**必须**能用 ETag 协商拿到新字节（旧 ETag 不再 304）；
 *   · 字体等其余资源仍是长缓存（策略只收窄图标族，不顺手改别人）；
 *   · stat 未变 ⇒ 第二次导航**一次盘都不读**（用 fs.readFileSync 计数证明），且表示与第一次逐字节相同；
 *   · stat 变了但内容相同（touch）⇒ 仍不重建，且不再重复读盘（指纹里的 stat 被刷新）；
 *   · 内容真变了 ⇒ 版本哈希前进、HTML ETag 前进（"改了资源能失效"的正面证明）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  cacheControlFor, serveStatic, _resetHtmlCache, depsUnchanged, depFingerprintOf, ICON_MAX_AGE,
} = require('../src/static');

function makeWeb() {
  const web = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-static-fix13-'));
  fs.writeFileSync(path.join(web, 'index.html'),
    '<!doctype html><html><head><link rel="icon" href="favicon.ico">' +
    '<link rel="stylesheet" href="style.css"></head>' +
    '<body><img src="assets/icon-192.png" alt="icon">' +
    '<script src="app.js"></script></body></html>\n');
  fs.writeFileSync(path.join(web, 'app.js'), 'console.log("v1");\n');
  fs.writeFileSync(path.join(web, 'style.css'), 'body{color:#111}\n');
  fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(web, 'assets', 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  fs.writeFileSync(path.join(web, 'favicon.ico'), Buffer.from([0, 0, 1, 0, 9, 9, 9, 9]));
  return web;
}

async function withServer(web, fn) {
  _resetHtmlCache();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    serveStatic(req, res, decodeURIComponent(u.pathname), { webDir: web });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ get: (p, headers) => fetch(base + p, { headers }), base });
  } finally {
    await new Promise((r) => server.close(r));
    _resetHtmlCache();
  }
}

test('FIX-13①：图标族缓存可失效（短 max-age + must-revalidate + ETag 协商拿到新图）', () => {
  // 策略：图标族一律短缓存 + 过期强制回源；URL 不版本化，这是唯一能"改了就能看到"的服务端手段
  for (const [ext, base] of [['.png', 'icon-192.png'], ['.svg', 'icon.svg'], ['.ico', 'favicon.ico']]) {
    const cc = cacheControlFor(ext, base);
    assert.strictEqual(cc, `public, max-age=${ICON_MAX_AGE}, must-revalidate`, `${base} 必须是"短缓存 + 强制回源"`);
    const secs = Number(/max-age=(\d+)/.exec(cc)[1]);
    assert.strictEqual(secs <= 600, true, `${base} 的 max-age 必须短到用户能接受（实际 ${secs}s）`);
  }
  // 只收窄图标族：其余资源策略不动（避免顺手改别人）
  assert.strictEqual(cacheControlFor('.woff2', 'font.woff2'), 'public, max-age=86400', '字体等其余资源维持长缓存');
  assert.strictEqual(cacheControlFor('.js', 'app.js'), 'no-cache', 'JS 仍按 no-cache 协商');
  assert.strictEqual(cacheControlFor('.js', 'sw.js'), 'no-cache', 'sw.js 绝不缓存');
});

test('FIX-13①（真实请求）：图标改动后旧 ETag 必须 200 + 新字节（不再被长缓存钉住）', async () => {
  const web = makeWeb();
  try {
    await withServer(web, async ({ get }) => {
      const first = await get('/assets/icon-192.png');
      assert.strictEqual(first.status, 200);
      const etag1 = first.headers.get('etag');
      const body1 = Buffer.from(await first.arrayBuffer());
      assert.strictEqual(first.headers.get('cache-control'), `public, max-age=${ICON_MAX_AGE}, must-revalidate`);
      // 条件请求（缓存过期后浏览器做的就是这件事）：内容没变 → 304，不浪费流量
      const revalidated = await get('/assets/icon-192.png', { 'If-None-Match': etag1 });
      assert.strictEqual(revalidated.status, 304, '内容未变时必须 304（短缓存不等于每次都重传）');

      // 换图标（模拟设计改了品牌图）
      fs.writeFileSync(path.join(web, 'assets', 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9, 9, 9]));
      const second = await get('/assets/icon-192.png', { 'If-None-Match': etag1 });
      assert.strictEqual(second.status, 200, '图标已变 → 旧 ETag 绝不能命中 304（否则用户永远看旧图）');
      assert.notStrictEqual(second.headers.get('etag'), etag1, 'ETag 必须前进');
      const body2 = Buffer.from(await second.arrayBuffer());
      assert.notDeepStrictEqual(body2, body1, '必须真的下发新图标字节');
    });
  } finally { fs.rmSync(web, { recursive: true, force: true }); }
});

test('FIX-13②：depsUnchanged 有 stat 短路——stat 未变时不再读盘哈希（用 fs.readFileSync 计数证明）', () => {
  const web = makeWeb();
  const app = path.join(web, 'app.js');
  const css = path.join(web, 'style.css');
  const realRead = fs.readFileSync;
  const reads = [];
  try {
    const deps = new Map([
      [path.normalize(app), depFingerprintOf(app)],
      [path.normalize(css), depFingerprintOf(css)],
    ]);
    fs.readFileSync = function (p, ...rest) { reads.push(String(p)); return realRead.call(fs, p, ...rest); };
    try {
      assert.strictEqual(depsUnchanged(deps), true, '前置：依赖没变');
      assert.deepStrictEqual(reads, [], `stat 未变时一次盘都不该读（实际读了 ${reads.join('、')}）`);

      // stat 变了但内容相同（touch）⇒ 仍判定未变，且指纹里的 stat 被刷新（避免下次又白读）
      const old = depFingerprintOf(app);
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(app, future, future);
      reads.length = 0;
      assert.strictEqual(depsUnchanged(deps), true, 'touch（内容未变）不得触发表示重建');
      assert.deepStrictEqual(reads, [path.normalize(app)], '只有 stat 变了的那个依赖重读一次');
      assert.strictEqual(deps.get(path.normalize(app)).mtimeMs > old.mtimeMs, true, '重读后必须刷新指纹里的 stat');
      reads.length = 0;
      assert.strictEqual(depsUnchanged(deps), true, '刷新后再次判定仍为未变');
      assert.deepStrictEqual(reads, [], '指纹已刷新 → 又一次 stat 短路，零读盘');

      // 内容真变了 ⇒ 必须判定"已变"（否则版本化引用会一直指向旧内容）
      fs.writeFileSync(app, 'console.log("v2");\n');
      reads.length = 0;
      assert.strictEqual(depsUnchanged(deps), false, '内容变了必须重建');
      assert.deepStrictEqual(reads, [path.normalize(app)], '内容变化时重读该依赖一次');
      // 依赖文件消失 ⇒ 也必须重建（改写会退回原始引用），不能抛异常
      fs.rmSync(css);
      assert.strictEqual(depsUnchanged(deps), false, '依赖消失必须重建');
    } finally { fs.readFileSync = realRead; }
  } finally {
    fs.readFileSync = realRead;
    fs.rmSync(web, { recursive: true, force: true });
  }
});

test('FIX-13②（真实请求）：第二次导航不读盘且表示逐字节相同；改了 JS 后新哈希能生效', async () => {
  const web = makeWeb();
  const realRead = fs.readFileSync;
  try {
    await withServer(web, async ({ get }) => {
      const first = await get('/');
      assert.strictEqual(first.status, 200);
      const body1 = await first.text();
      const etag1 = first.headers.get('etag');
      const hash1 = /app\.js\?v=([0-9a-f]{12})/.exec(body1)[1];

      // 第二次导航（缓存命中路径）：除了构建响应所需的读，不得再为"依赖校验"读 web 源文件
      const reads = [];
      fs.readFileSync = function (p, ...rest) { reads.push(path.normalize(String(p))); return realRead.call(fs, p, ...rest); };
      let body2 = '';
      try {
        const second = await get('/');
        assert.strictEqual(second.status, 200);
        body2 = await second.text();
        assert.strictEqual(second.headers.get('etag'), etag1, '依赖未变 ⇒ 表示与 ETag 必须稳定');
      } finally { fs.readFileSync = realRead; }
      assert.strictEqual(body2, body1, '第二次导航必须逐字节相同');
      assert.deepStrictEqual(reads, [], `缓存命中路径不得读盘校验依赖（实际读了 ${reads.join('、')}）`);

      // 改了被引用的 JS：哈希必须前进（版本化 URL 让旧缓存必然 miss）
      fs.writeFileSync(path.join(web, 'app.js'), 'console.log("v2 — changed");\n');
      const third = await get('/');
      const body3 = await third.text();
      const hash3 = /app\.js\?v=([0-9a-f]{12})/.exec(body3)[1];
      assert.notStrictEqual(hash3, hash1, '改 app.js 后版本哈希必须前进');
      assert.notStrictEqual(third.headers.get('etag'), etag1, 'HTML ETag 必须前进');
      // 未改动的依赖版本保持稳定
      assert.strictEqual(
        /style\.css\?v=([0-9a-f]{12})/.exec(body3)[1], /style\.css\?v=([0-9a-f]{12})/.exec(body1)[1],
        '未变化的依赖版本必须稳定',
      );
    });
  } finally {
    fs.readFileSync = realRead;
    fs.rmSync(web, { recursive: true, force: true });
  }
});
