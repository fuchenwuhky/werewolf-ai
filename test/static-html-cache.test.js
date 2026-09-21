// FIN-01：HTML 条件缓存与资源哈希闭环（计划书 §5.3 C01–C08）
// 服务端可测部分全部在此自动化；C04/C06/C07 的浏览器侧（SW 接管、断网回退）
// 由 ui:check 严格模式与真机验收补证，本文件只锁定服务端契约。
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { etagOf, serveStatic, _resetHtmlCache } = require('../src/static');
const { cleanupAfter } = require('./helpers-tmpdir');

function makeWeb(t) {
  const web = cleanupAfter(t, fs.mkdtempSync(path.join(os.tmpdir(), 'ww-static-fin01-')));
  fs.mkdirSync(path.join(web, 'm'), { recursive: true });
  fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(web, 'app.js'), 'console.log("app v1");\n');
  fs.writeFileSync(path.join(web, 'style.css'), 'body{color:#e7e6e0}\n');
  fs.writeFileSync(path.join(web, 'assets', 'wolf-emblem.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
  fs.writeFileSync(path.join(web, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="style.css">' +
    '<link rel="icon" href="assets/wolf-emblem.svg"></head>' +
    '<body><img src="assets/wolf-emblem.svg" alt="logo">' +
    '<script src="app.js"></script></body></html>\n');
  fs.writeFileSync(path.join(web, 'shared.js'), '// shared v1\n');
  fs.writeFileSync(path.join(web, 'm', 'm.js'), '// m v1\n');
  fs.writeFileSync(path.join(web, 'm', 'index.html'),
    '<!doctype html><html><head></head><body>' +
    '<script src="../shared.js"></script><script src="m.js"></script></body></html>\n');
  return web;
}

async function withServer(web, fn) {
  _resetHtmlCache();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    serveStatic(req, res, decodeURIComponent(u.pathname), { webDir: web });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({
      get: (p, headers) => fetch(base + p, { headers }),
      base,
    });
  } finally {
    server.close();
    _resetHtmlCache();
  }
}

const statEtagOf = (file) => etagOf(fs.statSync(file));

test('C01 旧 stat-ETag 请求新服务：必须 200 + 版本化引用 + 新 ETag（不再 304 旧表示）', async (t) => {
  const web = makeWeb(t);
  await withServer(web, async ({ get }) => {
    const oldEtag = statEtagOf(path.join(web, 'index.html'));
    assert.match(oldEtag, /W\/"[0-9a-f]+-[0-9a-f]+"/, '旧 ETag 形态 = stat 式');
    const r = await get('/', { 'If-None-Match': oldEtag });
    assert.strictEqual(r.status, 200, '旧 stat ETag 不得命中 304（表示已改变）');
    const body = await r.text();
    assert.match(body, /app\.js\?v=[0-9a-f]{12}/, '最终 HTML 必须是版本化引用');
    const etag = r.headers.get('etag');
    assert.match(etag, /W\/"v2-[0-9a-f]{16}"/, '新 ETag 必须是内容寻址 v2 命名空间');
    assert.notStrictEqual(etag, oldEtag);
  });
});

test('C02 同内容 ETag 稳定：清缓存重算后仍一致（不得用永久随机掩盖）', async (t) => {
  const web = makeWeb(t);
  const etags = new Set();
  for (let i = 0; i < 2; i++) {
    await withServer(web, async ({ get }) => {
      const r1 = await get('/');
      const e1 = r1.headers.get('etag');
      const r2 = await get('/', { 'If-None-Match': e1 });
      assert.strictEqual(r2.status, 304, '同一表示的条件请求应 304');
      etags.add(e1);
    });
  }
  assert.strictEqual(etags.size, 1, '跨进程重建的 ETag 必须确定性一致');
});

test('C03 仅改一个本地 JS：URL 哈希变、HTML ETag 变、旧 ETag 请求 200（同进程与重置缓存两态）', async (t) => {
  const web = makeWeb(t);
  await withServer(web, async ({ get }) => {
    const first = await get('/');
    const oldEtag = first.headers.get('etag');
    const oldBody = await first.text();
    const oldHash = oldBody.match(/app\.js\?v=([0-9a-f]{12})/)[1];

    // 同进程：只改 app.js（HTML 不动）
    fs.writeFileSync(path.join(web, 'app.js'), 'console.log("app v2 — changed");\n');
    const r = await get('/', { 'If-None-Match': oldEtag });
    assert.strictEqual(r.status, 200, '依赖变化后旧 HTML ETag 必须 200');
    const newBody = await r.text();
    const newHash = newBody.match(/app\.js\?v=([0-9a-f]{12})/)[1];
    assert.notStrictEqual(newHash, oldHash, 'app.js 内容哈希必须前进');
    assert.notStrictEqual(r.headers.get('etag'), oldEtag, 'HTML ETag 必须前进');
    // style.css 未变 → 其版本应保持
    assert.strictEqual(newBody.match(/style\.css\?v=([0-9a-f]{12})/)[1],
      oldBody.match(/style\.css\?v=([0-9a-f]{12})/)[1], '未变化的资源版本应稳定');

    // 重置缓存态（模拟重启后的空缓存）：再次条件请求仍 200
    _resetHtmlCache();
    const r2 = await get('/', { 'If-None-Match': oldEtag });
    assert.strictEqual(r2.status, 200);
  });
});

test('C05 /m/ 相对与父级引用都指向正确文件，哈希可复算', async (t) => {
  const web = makeWeb(t);
  await withServer(web, async ({ get }) => {
    const r = await get('/m/');
    assert.strictEqual(r.status, 200);
    const body = await r.text();
    const sharedHash = body.match(/\.\.\/shared\.js\?v=([0-9a-f]{12})/)[1];
    const mHash = body.match(/m\.js\?v=([0-9a-f]{12})/)[1];
    const crypto = require('node:crypto');
    const expect = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12);
    assert.strictEqual(sharedHash, expect(path.join(web, 'shared.js')), '父级 shared.js 哈希可复算');
    assert.strictEqual(mHash, expect(path.join(web, 'm', 'm.js')), 'm/m.js 哈希可复算');
  });
});

test('C07 表示稳定且引用完整：反复请求同值，版本化引用的文件全部真实存在', async (t) => {
  const web = makeWeb(t);
  await withServer(web, async ({ get }) => {
    const eTags = [];
    for (let i = 0; i < 3; i++) {
      const r = await get('/');
      eTags.push(r.headers.get('etag'));
      const body = await r.text();
      for (const m of body.matchAll(/(?:src|href)="([^"#?]+?\.(?:js|css))\?v=[0-9a-f]{12}"/g)) {
        const ref = m[1];
        const full = ref.startsWith('/') ? path.join(web, ref.slice(1)) : path.join(web, ref);
        assert.ok(fs.existsSync(full), `版本化引用必须真实存在：${ref}`);
      }
    }
    assert.strictEqual(new Set(eTags).size, 1, '同 URL 表示必须稳定');
  });
});

test('C08 非脚本资源（品牌 SVG）不走 HTML 改写、靠缓存策略失效（版本化范围如实）', async (t) => {
  const web = makeWeb(t);
  await withServer(web, async ({ get }) => {
    const svg = await get('/assets/wolf-emblem.svg');
    assert.strictEqual(svg.status, 200);
    // FIX-13：SVG 不参与版本化改写 ⇒ 不能长缓存，改短 max-age + must-revalidate（过期回源、ETag 变了即换新）
    assert.match(svg.headers.get('cache-control'), /max-age=\d+/, '品牌图仍带 max-age（具体策略见 static-cache-invalidation.test.js）');
    assert.match(svg.headers.get('cache-control'), /must-revalidate/, '不版本化的资源必须强制回源校验，否则换了图用户看不到');
    const body = await (await get('/')).text();
    assert.match(body, /src="assets\/wolf-emblem\.svg"/, '<img> 引用保持原样（文档化行为）');
  });
});

test('C06 服务端半程：升级后带任何旧缓存头导航，服务器总是给最新表示（浏览器侧由 ui:check/真机补证）', async (t) => {
  const web = makeWeb(t);
  await withServer(web, async ({ get }) => {
    // 模拟"旧 HTML 的 HTTP 缓存 + 旧 ETag + 旧 SW"最不利组合下发起的导航
    const r = await get('/', {
      'If-None-Match': statEtagOf(path.join(web, 'index.html')),
      'Cache-Control': 'max-age=0',
    });
    assert.strictEqual(r.status, 200);
    const body = await r.text();
    assert.match(body, /app\.js\?v=[0-9a-f]{12}/, '首次导航即拿到版本化新代码');
  });
});
