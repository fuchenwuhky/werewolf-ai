/**
 * sw-shell.test.js — 离线预缓存清单的两条不变量（验收发现的 P1 回归）。
 *
 * 背景：预缓存清单（web/sw.js 的 SHELL）里存的是**无查询串** URL（'/app.js'），
 * 但服务端下发 HTML 时会把本地 js/css 改写成 '/app.js?v=<内容哈希>'。
 * 曾经的匹配只用 cache.match(req)（不带 ignoreSearch）→ 预缓存条目**永远命中不了**：
 * 装完 SW 还没再联网就断网打开，页面外壳在、脚本全 miss。
 *
 * 这里锁两件事：
 *   ① 清单必须覆盖两个 HTML 实际引用的**全部本地关键子资源**（漏了 session-model.js 就是这样漏的）；
 *   ② 清单内容变了必须升 VERSION —— 否则 activate 时旧缓存不会被清，新清单也不会重新预缓存。
 *
 * 说明：这里解析 sw.js 源码取 SHELL 清单。这不是"用源码正则断言行为"，而是读取一份**配置数据**
 * （清单本身就是 SOR），行为层面由 ui-check 在真实页面里查 caches 断言。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SW = path.join(__dirname, '..', 'web', 'sw.js');
const src = fs.readFileSync(SW, 'utf8');

/** 解析 SHELL 清单 */
function shellList() {
  const m = src.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(m, 'web/sw.js 里找不到 SHELL 清单');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
const VERSION = (src.match(/const VERSION = '([^']+)'/) || [])[1];
const fingerprint = (list) => crypto.createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 16);

/**
 * 清单指纹 ↔ VERSION 的台账。
 * 改 SHELL 清单时必须：升 VERSION，并在此登记新指纹（测试会告诉你新指纹是多少）。
 * 这样"改了清单忘了升档"这种静默失效不会再发生。
 */
const SHELL_LEDGER = { 'ww-v14-note': '3f8ab596ee6fc328', 'ww-v15-tokens': '14aee7099e97a45c', 'ww-v16-shared': '29fcc29c61b83495', 'ww-v17-avatar': '0edae0c5a149f59a', 'ww-v18-icons': '1fc75ac43c20e49f' };

/** 有意不进预缓存的文件（必须显式登记并写明原因，防止无声遗漏） */
const ALLOW_MISSING = new Map([]);

/** 从一个 HTML 里抽出本地子资源路径，并归一成站点绝对路径 */
function localRefs(htmlFile) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const dir = htmlFile.endsWith(path.join('web', 'm', 'index.html')) ? '/m/' : '/';
  const out = [];
  const push = (raw) => {
    if (!raw) return;
    if (/^(https?:)?\/\//.test(raw) || /^(data|mailto|javascript):/.test(raw)) return; // 跨域/内联不算
    const clean = raw.split('#')[0].split('?')[0];
    if (!clean) return;
    const abs = clean.startsWith('/') ? clean : path.posix.resolve(dir, clean);
    if (abs.endsWith('.html') && abs !== '/index.html' && abs !== '/m/index.html') return; // 页面本身就是外壳
    out.push(abs);
  };
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)) push(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*>/g)) {
    const tag = m[0];
    if (!/\brel=["'](stylesheet|icon|apple-touch-icon|manifest|shortcut icon)["']/.test(tag)) continue;
    const href = tag.match(/\bhref=["']([^"']+)["']/);
    push(href && href[1]);
  }
  return out;
}

test('预缓存清单覆盖两个 HTML 引用的全部本地关键子资源', () => {
  const shell = new Set(shellList());
  const missing = [];
  for (const f of [path.join(__dirname, '..', 'web', 'index.html'), path.join(__dirname, '..', 'web', 'm', 'index.html')]) {
    for (const ref of localRefs(f)) {
      if (shell.has(ref)) continue;
      if (ALLOW_MISSING.has(ref)) continue;
      missing.push(`${path.basename(path.dirname(f))}/${path.basename(f)} → ${ref}`);
    }
  }
  assert.deepStrictEqual(
    missing,
    [],
    '以下子资源被 HTML 引用但不在 SHELL 清单里（离线会 miss）。要么补进清单并升 VERSION，要么登记到 ALLOW_MISSING 并写明原因：\n  ' + missing.join('\n  '),
  );
});

test('SHELL 清单内容与 VERSION 联动（改了清单必须升档）', () => {
  const list = shellList();
  assert.ok(VERSION, 'web/sw.js 里找不到 VERSION');
  assert.ok(list.length >= 20, `SHELL 条目太少（${list.length}），像是被误删了`);
  assert.ok(
    list.includes('/shared/session-model.js'),
    'SHELL 必须包含 /shared/session-model.js（两个 HTML 都引用它，漏了会导致离线打开时脚本缺失）',
  );
  const known = SHELL_LEDGER[VERSION];
  assert.ok(
    known,
    `VERSION=${VERSION} 没有登记指纹。当前清单指纹是 ${fingerprint(list)}；` +
      '请在 test/sw-shell.test.js 的 SHELL_LEDGER 里为它登记（升了档就要登记新档位）。',
  );
  assert.strictEqual(
    fingerprint(list),
    known,
    `SHELL 清单变了但 VERSION 仍是 ${VERSION}：旧缓存不会被清、新清单不会重新预缓存。` +
      `当前指纹 ${fingerprint(list)}，台账记的是 ${known} —— 请升 VERSION 并登记新指纹。`,
  );
});
