/**
 * i18n.test.js — 界面文案多语言（P2-7）
 *
 * 翻译层最容易出的不是"翻错"，而是三类静默失败：
 *   ① HTML 上标了 `data-i18n="xxx"` 但字典里没有这个键 → 用户看到键名或空白；
 *   ② 中文加了新键、英文忘了加 → 切到英文时露出中文兜底或键名；
 *   ③ 缺键时把键名显示出来（比不翻译更糟）。
 * 这三条都在这里钉住。另外验证"缺键保留页面原文案"这一兜底行为本身。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

/** 在裸环境里加载 i18n.js（它必须不依赖 DOM 就能加载，否则这段测试本身就做不到） */
function loadI18n(overrides = {}) {
  const sandbox = { console, localStorage: null, navigator: { language: 'zh-CN' }, ...overrides };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('i18n.js'), sandbox, { filename: 'i18n.js' });
  return sandbox.I18N;
}

/** 从 HTML 里取出所有 data-i18n* 引用的键 */
function keysInHtml(html) {
  const keys = new Set();
  for (const m of html.matchAll(/data-i18n(?:-html|-placeholder|-title|-aria)?="([^"]+)"/g)) keys.add(m[1]);
  return keys;
}

// ---------- 字典 ----------

test('字典：中英键集合必须完全一致（少一条就会在切换语言时露馅）', () => {
  const I18N = loadI18n();
  const zh = Object.keys(I18N.DICT['zh-CN']).sort();
  const en = Object.keys(I18N.DICT.en).sort();
  const missingEn = zh.filter((k) => !I18N.DICT.en[k]);
  const missingZh = en.filter((k) => !I18N.DICT['zh-CN'][k]);
  assert.deepStrictEqual(missingEn, [], `英文缺这些键：${missingEn.join(', ')}`);
  assert.deepStrictEqual(missingZh, [], `中文缺这些键：${missingZh.join(', ')}`);
  assert.ok(zh.length >= 40, `键数量偏少（${zh.length}），可能漏标了界面文案`);
});

test('字典：不得有空值，也不得把键名当值（占位符没替换的典型症状）', () => {
  const I18N = loadI18n();
  for (const lang of I18N.LANGS) {
    for (const [k, v] of Object.entries(I18N.DICT[lang])) {
      assert.strictEqual(typeof v, 'string', `${lang}.${k} 必须是字符串`);
      assert.ok(v.trim().length > 0, `${lang}.${k} 是空值`);
      assert.notStrictEqual(v, k, `${lang}.${k} 的值就是键名，显然是没翻译`);
    }
  }
});

test('字典：HTML 上标记的每个键都必须存在（否则用户会看到键名或空白）', () => {
  const I18N = loadI18n();
  for (const page of ['index.html', 'm/index.html', 'offline.html']) {
    const keys = keysInHtml(read(page));
    const missing = [...keys].filter((k) => I18N.lookup(k, 'zh-CN') == null || I18N.lookup(k, 'en') == null);
    assert.deepStrictEqual(missing, [], `${page} 引用了字典里没有的键：${missing.join(', ')}`);
    if (page !== 'offline.html') assert.ok(keys.size >= 5, `${page} 的标记过少（${keys.size}）`);
  }
  // offline.html 用的是内联脚本取词，这里确认它引用的键确实在字典里
  const off = read('offline.html');
  for (const k of [...off.matchAll(/'((?:offline|pwa)\.[\w.]+)'/g)].map((m) => m[1])) {
    assert.ok(I18N.lookup(k, 'zh-CN') != null, `offline.html 引用了不存在的键 ${k}`);
  }
});

test('取词：t() 命中当前语言；未知键返回 null（而不是键名）', () => {
  const I18N = loadI18n();
  assert.strictEqual(I18N.getLang(), 'zh-CN');
  assert.strictEqual(I18N.t('start.button'), '🎮 开始游戏');
  assert.strictEqual(I18N.t('完全不存在.键'), null, '未知键必须返回 null，交由调用方保留原文案');
  assert.strictEqual(I18N.setLang('en'), true);
  assert.strictEqual(I18N.t('start.button'), '🎮 Start game');
  assert.strictEqual(I18N.setLang('klingon'), false, '不支持的语言不得生效');
  assert.strictEqual(I18N.t('start.button'), '🎮 Start game', '非法语言不得改变当前语言');
});

test('取词：{var} 占位符替换，缺变量时保留原样（不产生 undefined）', () => {
  const I18N = loadI18n();
  I18N.DICT['zh-CN']['test.var'] = '共 {n} 项，来自 {src}';
  assert.strictEqual(I18N.t('test.var', { n: 3, src: '日志' }), '共 3 项，来自 日志');
  assert.strictEqual(I18N.t('test.var', { n: 3 }), '共 3 项，来自 {src}', '缺变量时保留占位符而不是 undefined');
  delete I18N.DICT['zh-CN']['test.var'];
});

test('语言探测：localStorage > 浏览器语言 > 中文兜底', () => {
  assert.strictEqual(loadI18n({ navigator: { language: 'en-US' } }).getLang(), 'en');
  assert.strictEqual(loadI18n({ navigator: { language: 'zh-TW' } }).getLang(), 'zh-CN');
  assert.strictEqual(loadI18n({ navigator: { language: 'fr-FR' } }).getLang(), 'zh-CN', '未支持语言兜底中文（规则术语更易读）');
  const saved = loadI18n({ navigator: { language: 'zh-CN' }, localStorage: { getItem: () => 'en', setItem() {} } });
  assert.strictEqual(saved.getLang(), 'en', '用户选择必须优先于浏览器语言');
  // localStorage 抛错（隐私模式）时不得崩溃
  const broken = loadI18n({ navigator: { language: 'en' }, localStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } });
  assert.strictEqual(broken.getLang(), 'en');
  assert.strictEqual(broken.setLang('zh-CN'), true, '存储不可用时仍应能切换（只是不持久化）');
});

// ---------- DOM 应用（用最小假 DOM，断言"缺键保留原文案"） ----------

function fakeDom(entries) {
  const make = ([attr, key]) => ({
    _attrs: { [attr]: key },
    textContent: '原文案',
    innerHTML: '原文案',
    getAttribute(a) { return this._attrs[a] || null; },
    setAttribute(a, v) { this._attrs[a] = v; },
  });
  const els = entries.map(make);
  const bySel = {
    '[data-i18n]': els.filter((e) => e._attrs['data-i18n']),
    '[data-i18n-html]': els.filter((e) => e._attrs['data-i18n-html']),
    '[data-i18n-placeholder]': els.filter((e) => e._attrs['data-i18n-placeholder']),
    '[data-i18n-title]': els.filter((e) => e._attrs['data-i18n-title']),
    '[data-i18n-aria]': els.filter((e) => e._attrs['data-i18n-aria']),
  };
  const doc = {
    documentElement: { lang: '' },
    querySelectorAll: (sel) => bySel[sel] || [],
    readyState: 'complete',
  };
  return { doc, els };
}

test('DOM 应用：命中就替换，缺键就保留页面原文案（绝不显示键名）', () => {
  const I18N = loadI18n();
  const { doc, els } = fakeDom([
    ['data-i18n', 'start.button'],
    ['data-i18n', '不存在.键'],
    ['data-i18n-placeholder', 'api.key'],
    ['data-i18n-title', 'api.langSwitch'],
    ['data-i18n-aria', 'game.streamAria'],
    ['data-i18n-html', 'overlay.flipHint'],
  ]);
  const n = I18N.applyI18n(doc);
  assert.strictEqual(els[0].textContent, '🎮 开始游戏');
  assert.strictEqual(els[1].textContent, '原文案', '缺键必须保留原文案（显示键名比不翻译更糟）');
  assert.strictEqual(els[2].getAttribute('placeholder'), 'API Key');
  assert.strictEqual(els[3].getAttribute('title'), '切换界面语言');
  assert.strictEqual(els[4].getAttribute('aria-label'), '对局事件流');
  assert.strictEqual(els[5].innerHTML, '❓<br>点击翻看你的身份');
  assert.strictEqual(doc.documentElement.lang, 'zh-CN', '必须同步 <html lang>（屏幕阅读器发音）');
  assert.ok(n >= 5, `应至少替换 5 处，实际 ${n}`);
});

test('DOM 应用：切换语言会重刷已标记的元素，且 <html lang> 跟着变', () => {
  const I18N = loadI18n();
  const { doc, els } = fakeDom([['data-i18n', 'start.button'], ['data-i18n', 'game.terminate']]);
  I18N.applyI18n(doc);
  assert.strictEqual(els[0].textContent, '🎮 开始游戏');
  I18N.setLang('en', doc);
  assert.strictEqual(els[0].textContent, '🎮 Start game');
  assert.strictEqual(els[1].textContent, '⏹ End game');
  assert.strictEqual(doc.documentElement.lang, 'en');
});

// ---------- 页面接线 ----------

test('页面接线：i18n.js 必须先于 pwa.js 与业务脚本加载（pwa 取词依赖它）', () => {
  for (const page of ['index.html', 'm/index.html']) {
    const html = read(page);
    // 按 <script src> 标签的真实顺序比较，而不是在整份 HTML 里找子串 ——
    // 后者会被注释里提到的文件名误伤（曾经就因为一句注释让这个断言误报）
    const order = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    const at = (name) => order.findIndex((s) => s === name || s.endsWith('/' + name)); // 手机版引用带 ../
    assert.ok(at('i18n.js') >= 0, `${page} 未加载 i18n.js（scripts: ${order.join(', ')}）`);
    assert.ok(at('i18n.js') < at('pwa.js'), `${page}：i18n.js 必须早于 pwa.js（${order.join(', ')}）`);
    const biz = Math.max(at('app.js'), at('m.js'));
    assert.ok(biz >= 0, `${page} 未加载业务脚本（${order.join(', ')}）`);
    assert.ok(at('i18n.js') < biz, `${page}：i18n.js 必须早于业务脚本（${order.join(', ')}）`);
  }
  assert.match(read('pwa.js'), /window\.I18N/, 'pwa.js 必须复用字典而不是硬编码文案');
  assert.match(read('sw.js'), /'\/i18n\.js'/, 'i18n.js 是外壳的一部分，必须进离线预缓存');
});

test('启动守卫：初始化完成前点击要有说明，且必须放在业务脚本之前、且能失败放行', () => {
  for (const [page, box] of [['index.html', 'setup-error'], ['m/index.html', 'm-err']]) {
    const html = read(page);
    const guardAt = html.indexOf('__wwReady = false');
    assert.ok(guardAt > 0, `${page} 缺少最先执行的初始化守卫`);
    // 守卫必须内联且早于 i18n.js/app.js：脚本还没解析完时点击同样必须给说明
    const inlineAt = html.indexOf('<script>');
    assert.ok(inlineAt >= 0 && inlineAt < guardAt, `${page} 守卫必须内联`);
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    const firstSrcAt = html.indexOf(`<script src="${scripts[0]}"`);
    assert.ok(guardAt < firstSrcAt, `${page} 守卫必须早于所有外部脚本`);
    assert.ok(html.includes(`id="${box}"`), `${page} 守卫要找得到提示框 #${box}`);
    assert.match(html, /__wwReady \|\| Date\.now\(\) > deadline/, `${page} 守卫必须有超时兜底（初始化失败也不能把界面点死）`);
  }
  // 两个界面都要在初始化完成后放行
  assert.match(read('app.js'), /window\.__wwReady = true/, 'app.js 初始化完成后必须放行');
  assert.match(read('m/m.js'), /window\.__wwReady = true/, 'm.js 初始化完成后必须放行');
});

test('端到端（无浏览器）：把真实 HTML 上的每个标记都替换一遍，不允许有一处退回原文案', () => {
  const I18N = loadI18n();
  for (const page of ['index.html', 'm/index.html']) {
    const html = read(page);
    // 用真实 HTML 里的标记构造假元素（属性名与顺序都照搬）
    const entries = [...html.matchAll(/data-i18n(-html|-placeholder|-title|-aria)?="([^"]+)"/g)]
      .map((m) => [`data-i18n${m[1] || ''}`, m[2]]);
    const els = entries.map(([attr, key]) => ({
      _attrs: { [attr]: key },
      textContent: '__原文案__', innerHTML: '__原文案__',
      getAttribute(a) { return this._attrs[a] || null; },
      setAttribute(a, v) { this._attrs[a] = v; },
    }));
    const sel = (a) => els.filter((e) => e._attrs[a]);
    const doc = {
      documentElement: { lang: '' },
      readyState: 'complete',
      querySelectorAll: (s) => sel(s.replace(/^\[|\]$/g, '')),
    };
    for (const lang of ['zh-CN', 'en']) {
      I18N.setLang(lang, doc);
      const leftOver = els.filter((e) => e.textContent === '__原文案__' && e.innerHTML === '__原文案__'
        && !e._attrs.placeholder && !e._attrs.title && !e._attrs['aria-label']);
      assert.deepStrictEqual(leftOver.map((e) => e._attrs['data-i18n'] || Object.values(e._attrs)[0]), [],
        `${page} 在 ${lang} 下有标记没被替换（说明字典缺键）`);
    }
  }
});

test('语言切换按钮：两个界面都有，且带无障碍名称', () => {
  const html = read('index.html');
  assert.match(html, /id="btn-lang"/, '桌面版需要语言切换按钮');
  assert.match(html, /id="btn-lang"[^>]*data-i18n-title=/, '切换按钮需要可读的名称');
  assert.match(read('i18n.js'), /getElementById\('btn-lang'\)/, 'i18n.js 负责绑定切换按钮');
});
