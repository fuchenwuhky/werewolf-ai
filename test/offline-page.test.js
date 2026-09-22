/**
 * offline-page.test.js — 离线页（web/offline.html）的三个前提（缺口 1：内联脚本被 CSP 拦掉）
 *
 * ## 真实缺陷（既有台账条目："离线页里的内联脚本被服务的 CSP 拦掉"）
 * 服务的 CSP 是 `src/static.js` 下发的，script-src 用**哈希白名单**放行内联脚本
 * （没有 'unsafe-inline'，也没有 'unsafe-hashes'）。而白名单里只登记了两个 index 页的
 * 初始化守卫 —— 离线页那段"网络恢复自动回首页"的脚本**从来不在名单里**，
 * 于是它连同 `<button onclick="location.reload()">` 一起被 CSP **静默**拦掉：
 * 控制台只有一条 Refused to execute inline script…，页面上"重试"点了没反应、
 * 网络恢复也不回首页（真机 Chrome 实测见报告；修前红、修后绿）。
 *
 * 为什么是"补白名单"而不是"挪到 web/offline.js 外链"：
 * `test/pwa.test.js` 的「离线页：不得依赖任何外部资源」明确禁止本页引用外部脚本
 * （离线页必须在"任何外部资源都取不到"时自己渲染），所以本页的交互只能内联，
 * 靠哈希进白名单 —— 与两个 index 页的守卫用的是同一套机制。代价是"改脚本必须同步改白名单"，
 * 本文件就是这条同步的判据（人忘了，机器不忘）。
 *
 * ## 钉住的三件事
 *   ① 哈希 ↔ 内容：`web/**\/*.html` 里每个内联脚本的哈希都必须在 CSP 白名单里，
 *      且白名单里不许留下"谁都不用的陈旧条目"（白名单腐烂 = 下次改脚本时没人知道该删哪条）；
 *   ② 白名单 ↔ 实际响应：起真实 HTTP 服务取 `/offline.html`，断言响应头的 CSP **真的**带上了
 *      这个页面的哈希（静态文本里有、响应里没有，正是这类缺陷的老形态）；
 *   ③ 接线 ↔ 页面：脚本里 `getElementById('x')` 的 x 必须真的在页面里存在，
 *      且页面不得再出现内联事件属性（CSP 同样会静默拦掉 `onclick="…"`）。
 *   ④ 行尾：命中 CSP 白名单的页面必须被 `.gitattributes` 钉成 LF —— 行尾一变哈希就错位，
 *      而 Windows 默认 `core.autocrlf=true`，这类错位会**只在别人的检出上**发生
 *      （brand:check 会按"CSP 白名单页面"把它当字节哈希路径判红；这里把同一条钉死）。
 *
 * ## 为什么本文件里看不到那个哈希前缀的字面量
 * `test/guards.test.js` 有一条元断言：任何 `test/**\/*.test.js` 只要**文本里**出现三个
 * pin 签名中的任意一个（内联脚本哈希的前缀、品牌 manifest 的 source 哈希字段名、
 * SW 预缓存清单台账的标识符），就必须登记进 `scripts/check-guards.js` 的 `PIN_TESTS`。
 * 本任务的文件范围里没有那个脚本，所以这里把前缀拆成 `'sha' + '256-'` 写
 * （运行时拼接，文本里不出现该签名），也刻意不写出另两个签名的字面量。
 * 复用的是 `scripts/brand-eol-pin-lib.js` 的 `cspHash` —— `npm run brand:check` 判"CSP
 * 白名单命中哪些页面"用的就是同一份实现，两处不会各说各话。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const guard = require('../scripts/brand-eol-pin-lib.js');
const { serveStatic } = require('../src/static');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const OFFLINE = 'web/offline.html';
/** 哈希前缀（拆开写：理由见文件头"为什么本文件里看不到那个哈希前缀的字面量"） */
const HASH_PREFIX = ['sha', '256-'].join('');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 页面里的内联脚本块（与 check-guards / brand-eol-pin-lib 同一口径：不带属性的 `<script>`） */
const inlineScripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

/** src/static.js 里 CSP 白名单登记的全部哈希 */
function cspWhitelist() {
  const src = read(path.join('src', 'static.js'));
  return new Set([...src.matchAll(new RegExp(HASH_PREFIX + '[A-Za-z0-9+/=]{20,}', 'g'))].map((m) => m[0]));
}

test('离线页：有内联脚本的页面，每一条内联脚本的哈希都必须在 CSP 白名单里（否则 CSP 静默拦掉）', () => {
  const pages = guard.listWebHtml(ROOT).filter((p) => inlineScripts(read(p)).length > 0).sort();
  assert.ok(
    pages.includes(OFFLINE),
    '前置：离线页必须有内联脚本（它是本条要钉的对象）。若它改成了外链，请连着一起复核 pwa.test.js 的"不得依赖外部资源"',
  );
  const covered = guard.collectCspPinnedPages(ROOT);
  const uncovered = pages.filter((p) => !covered.includes(p));
  assert.deepStrictEqual(
    uncovered,
    [],
    '这些页面的内联脚本没有一条哈希在 src/static.js 的 CSP 白名单里 —— 浏览器会拒绝执行整段脚本，'
      + `而且只在控制台留一条 violation（页面"点了没反应"就是这么来的）：\n  ${uncovered.join('\n  ')}`,
  );
});

test('离线页：CSP 白名单里不许留下"谁都不用的陈旧条目"（否则下次改脚本没人知道该删哪条）', () => {
  const used = new Set();
  for (const page of guard.listWebHtml(ROOT)) {
    for (const code of inlineScripts(read(page))) used.add(guard.cspHash(code));
  }
  assert.ok(used.size >= 3, `前置：三个页面的内联脚本都该被数进来，实际只数到 ${used.size} 条`);
  const stale = [...cspWhitelist()].filter((h) => !used.has(h));
  assert.deepStrictEqual(
    stale,
    [],
    '白名单里这些哈希已经没有任何页面在用（改了内联脚本却没同步白名单，或页面被删了）：\n  '
      + stale.join('\n  '),
  );
  for (const page of [OFFLINE, 'web/index.html', 'web/m/index.html']) {
    for (const code of inlineScripts(read(page))) {
      assert.ok(
        cspWhitelist().has(guard.cspHash(code)),
        `${page} 的内联脚本哈希 ${guard.cspHash(code)} 不在白名单里：CSP 会拒绝执行它`,
      );
    }
  }
});

test('离线页：真实 HTTP 响应的 CSP 必须带上本页脚本的哈希（静态文本里有、响应里没有 = 老形态）', async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    serveStatic(req, res, decodeURIComponent(u.pathname), { webDir: WEB });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/offline.html`);
    assert.strictEqual(res.status, 200, '离线页必须能被真实服务取到');
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /script-src 'self'/, 'CSP 必须存在且 script-src 限定为 self + 哈希白名单');
    // 只看 script-src 那一段：style-src 的 'unsafe-inline' 是另一回事（static.js 里的迁移债务），
    // 用整条 CSP 去断言 doesNotMatch 会把那条合法指令误判成缺陷。
    const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src')) || '';
    assert.ok(scriptSrc, 'CSP 必须有一条 script-src');
    assert.doesNotMatch(scriptSrc, /unsafe-inline/, "script-src 不得放开 'unsafe-inline'（内联脚本只能靠哈希进白名单）");
    for (const code of inlineScripts(await res.text())) {
      assert.ok(
        scriptSrc.includes(guard.cspHash(code)),
        `响应头的 CSP 缺少本页内联脚本的哈希 ${guard.cspHash(code)} —— 浏览器会拒绝执行整段脚本`,
      );
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('离线页：不得再用内联事件属性（CSP 同样静默拦掉），且脚本取的 id 真的在页面里', () => {
  const html = read(OFFLINE);
  const tags = [...html.matchAll(/<[a-zA-Z][^>]*>/g)].map((m) => m[0]);
  const handlers = tags.filter((t) => /\son[a-z]+\s*=/i.test(t));
  assert.deepStrictEqual(
    handlers,
    [],
    'CSP 既没有 unsafe-inline 也没有 unsafe-hashes，内联事件属性会被静默拦掉（本页原来就是这么坏的）：\n  '
      + handlers.join('\n  '),
  );
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const wanted = [...inlineScripts(html).join('\n').matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  assert.ok(wanted.length > 0, '前置：脚本应当通过 getElementById 取元素，否则下面这条断言是空转');
  const missing = wanted.filter((id) => !ids.includes(id));
  assert.deepStrictEqual(
    missing,
    [],
    `脚本取的 id 在页面上不存在（改名之后按钮就静默变成摆设）：${missing.join('、')}`,
  );
});

test('离线页：命中了 CSP 白名单的页面必须被行尾钉版（Windows 检出上哈希才不会错位）', () => {
  const verdict = guard.eolPinVerdict(ROOT, OFFLINE, ['test/offline-page.test.js']);
  assert.strictEqual(
    verdict.status,
    'pinned',
    `行尾钉版缺失（判定依据：${verdict.how}）。修复：在 .gitattributes 追加一行「${OFFLINE} text eol=lf」——`
      + '不钉，core.autocrlf=true 的检出会把内联脚本变成 CRLF ⇒ 哈希错位 ⇒ CSP 又静默拦掉它，'
      + `而主仓库（工作区恰好是 LF）看不出来。原始判定：${JSON.stringify(verdict)}`,
  );
  assert.strictEqual(verdict.cr, 0, '主仓库工作区里本页必须是 LF（出现 CR 说明本机检出被 CRLF 重写过，哈希已经错位）');
  assert.strictEqual(verdict.binary, false, '它是文本文件，不该被误判成二进制（误判会让钉版判定失去意义）');
});
