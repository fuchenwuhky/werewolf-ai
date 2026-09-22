/**
 * avatar-badge.test.js — 八个内置头像徽记的唯一真值（M1 §4.1 第 1 条）
 *
 * 被两端（web/app.js、web/m/m.js）共同引用，所以这里在 Node 下直接断言契约：
 *   · 八个 id 与顺序固定（编辑页的展示顺序就是它）；
 *   · 八个徽记**一份定义**（<symbol>），使用点只有 <use> 引用，不复制路径；
 *   · 只用 currentColor —— 不写死任何色值，深浅底都跟着容器文字色，也就同时满足
 *     test/css.test.js 的六色白名单（那是全局守卫，这里是同一件事的本地判据）；
 *   · displaySource 永远给出"自定义图"或"内置徽记"之一，**没有第三种空结果**
 *     —— 删除自定义头像后必须落到档案自己的 avatarId 上，绝不回退成破图。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../web/shared/avatar-badge');

const EXPECTED_IDS = ['scholar', 'hunter', 'seer', 'wolf', 'witch', 'night', 'candle', 'mask'];

/* ---------------------------------------------------------------- 极简假 DOM
 * 只实现 renderInto/ensureDefs 真正用到的那几件事。这里测的是**控制流与产物**
 * （注入几次、回落到哪个徽记），不是 HTML 解析器；所以 innerHTML 只存字符串，
 * firstElementChild 用哨兵代替。这样不必引入任何依赖也能把"绝不破图"这条钉住。 */
class FakeEl {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this._html = '';
    this._text = '';
  }
  set className(v) { this._cls = String(v); }
  get className() { return this._cls || ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type) { for (const fn of (this.listeners[type] || [])) fn({ type }); }
  set textContent(v) { this._text = String(v); this.children = []; this._html = ''; }
  get textContent() { return this._text; }
  insertAdjacentHTML(_pos, html) { this._html += String(html); }
  appendChild(child) { this.children.push(child); return child; }
  contains(child) { return this.children.includes(child); }
  get innerHTML() { return this._html; }
}

function fakeDoc({ withBody = true } = {}) {
  const registry = new Map();
  const bodyChildren = [];
  const doc = {
    body: withBody
      ? { firstChild: null, insertBefore(node) { bodyChildren.unshift(node); if (node && node.id) registry.set(node.id, node); } }
      : null,
    _bodyChildren: bodyChildren,
    getElementById: (id) => registry.get(id) || null,
    createElement(tag) {
      const node = new FakeEl(doc, tag);
      if (String(tag) === 'div') {
        // ensureDefs 只关心 "innerHTML 里有没有一个带 id 的 svg 根"
        Object.defineProperty(node, 'innerHTML', {
          get() { return node._html; },
          set(v) {
            node._html = String(v);
            node.firstElementChild = node._html ? Object.assign(new FakeEl(doc, 'svg'), { id: B.DEFS_ID }) : null;
          },
        });
      }
      return node;
    },
  };
  return doc;
}

/* ------------------------------------------------------------------ 契约 */

test('内置头像就是那八个 id、顺序固定（编辑页展示顺序 = 这个数组）', () => {
  assert.deepStrictEqual(B.AVATAR_IDS, EXPECTED_IDS);
  assert.strictEqual(B.DEFAULT_AVATAR_ID, 'scholar', '未知 id 的回落必须与服务端 cleanAvatar 一致');
  assert.strictEqual(new Set(B.AVATAR_IDS).size, 8, '八个 id 不得重复');
});

test('八个 id 都各有可读名字与线稿（没有一个是空的/漏写的）', () => {
  for (const id of EXPECTED_IDS) {
    assert.strictEqual(typeof B.AVATAR_NAME[id], 'string');
    assert.ok(B.AVATAR_NAME[id].length > 0, `${id} 缺可读名字`);
    assert.strictEqual(typeof B.MARKS[id], 'string');
    assert.ok(B.MARKS[id].trim().length > 0, `${id} 缺线稿`);
    assert.strictEqual(B.nameOf(id), B.AVATAR_NAME[id]);
    assert.strictEqual(B.textLabel(id), B.AVATAR_NAME[id]);
  }
});

test('symbolId 命名规则：wwAv + 首字母大写（八个都唯一）', () => {
  const ids = EXPECTED_IDS.map((id) => B.symbolId(id));
  assert.deepStrictEqual(ids, ['wwAvScholar', 'wwAvHunter', 'wwAvSeer', 'wwAvWolf', 'wwAvWitch', 'wwAvNight', 'wwAvCandle', 'wwAvMask']);
  assert.strictEqual(new Set(ids).size, 8);
});

test('defsMarkup：恰好八个 <symbol>，一份定义（不是八份内联重复）', () => {
  const defs = B.defsMarkup();
  const symbols = [...defs.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(symbols, EXPECTED_IDS.map((id) => B.symbolId(id)));
  assert.strictEqual((defs.match(/<symbol /g) || []).length, 8, '多一个少一个都算风格分叉');
  assert.ok(defs.includes(`id="${B.DEFS_ID}"`), '外层 svg 必须带页面级 id，注入才能幂等');
  assert.ok(defs.includes('width="0"') && defs.includes('height="0"'), '定义容器不得占布局');
  assert.ok(defs.includes('overflow:hidden'), '定义容器不得溢出成可见元素');
  // 每个 symbol 只写一次统一样式组：八个徽记共用同一套线宽/端点
  assert.strictEqual((defs.match(/<g fill="none"/g) || []).length, 8, '每个徽记恰好一个统一笔触组');
  for (const id of EXPECTED_IDS) {
    assert.ok(defs.includes(`<symbol id="${B.symbolId(id)}" viewBox="0 0 24 24">`), `${id} 的 symbol 必须同画布（统一风格的可核对判据）`);
  }
});

test('徽记只用 currentColor，不写死任何色值（深浅底都清晰 / 六色白名单）', () => {
  const defs = B.defsMarkup();
  assert.ok(defs.includes('stroke="currentColor"'), '线稿必须跟随容器文字色');
  assert.ok(defs.includes('fill="currentColor"'), '实心细节同样走 currentColor');
  assert.deepStrictEqual(defs.match(/#[0-9a-fA-F]{6}\b/g), null, '不得出现 #rrggbb 字面量');
  assert.deepStrictEqual(defs.match(/rgba?\(/g), null, '不得出现 rgb()/rgba() 字面量');
  assert.deepStrictEqual(defs.match(/url\(/g), null, '不得引用外部资源/渐变（徽记要能独立缩放）');
});

test('badgeMarkup：<use> 引用定义，不复制路径；未知 id 回落 scholar', () => {
  const html = B.badgeMarkup('wolf');
  assert.match(html, /<svg class="ww-avatar-badge"[^>]*viewBox="0 0 24 24"/);
  assert.match(html, /<use href="#wwAvWolf" xlink:href="#wwAvWolf"\/>/, '同时给 href 与 xlink:href（旧 WebView）');
  assert.ok(!/<path/.test(html), '展示标记里不得内联路径 —— 那就是九份重复');
  assert.strictEqual((html.match(/<svg/g) || []).length, 1);
  assert.match(html, /width="1\.2em" height="1\.2em"/, 'em 尺寸：随容器 font-size 缩放');
  assert.match(html, /aria-label="狼"/, '徽记是可读的（不是纯装饰）');

  for (const bad of ['', null, undefined, 'nope', 7, {}]) {
    assert.match(B.badgeMarkup(bad), /#wwAvScholar/, `非法 id（${String(bad)}）必须回落到默认徽记，而不是空标记`);
  }
  assert.strictEqual(B.normalizeId('mask'), 'mask');
  assert.strictEqual(B.normalizeId('MASK'), 'scholar', '大小写不匹配也算未知 → 回落');
});

test('displaySource：永远是"自定义图"或"内置徽记"之一，没有空结果', () => {
  assert.deepStrictEqual(B.displaySource({ avatarId: 'wolf', avatarUrl: '/a?v=1' }), { kind: 'custom', src: '/a?v=1' });
  assert.deepStrictEqual(B.displaySource({ avatarId: 'wolf', avatarUrl: null }), { kind: 'builtin', badgeId: 'wolf' });
  // 删除自定义头像后的形状：avatarUrl=null、avatarId 原样保留（服务端确实不动 avatarId）
  assert.deepStrictEqual(B.displaySource({ avatarId: 'mask', avatarUrl: null }), { kind: 'builtin', badgeId: 'mask' });
  // 缺字段/脏数据：一律落到默认徽记，绝不返回 kind:'none'
  for (const p of [null, undefined, {}, { avatarId: 'ghost' }, { avatarUrl: '' }]) {
    const s = B.displaySource(p);
    assert.strictEqual(s.kind, 'builtin');
    assert.strictEqual(s.badgeId, 'scholar');
  }
  assert.deepStrictEqual(B.displaySource({ avatarId: 'seer', avatarUrl: '' }), { kind: 'builtin', badgeId: 'seer' }, '空串 URL 不算自定义头像');
});

test('ensureDefs：注入一次即幂等；没有 body 时静默返回 false（Node 里可直接单测字符串）', () => {
  const doc = fakeDoc();
  assert.strictEqual(B.ensureDefs(doc), true);
  assert.strictEqual(doc._bodyChildren.length, 1);
  assert.strictEqual(B.ensureDefs(doc), true, '第二次必须命中已有定义，不再注入');
  assert.strictEqual(doc._bodyChildren.length, 1, '重复调用不得再插一份（否则八份定义变十六份）');
  assert.strictEqual(B.ensureDefs(fakeDoc({ withBody: false })), false);
  assert.strictEqual(B.ensureDefs(null), false);
});

test('renderInto：无自定义头像 → 内置徽记；有 → <img>；节点缺失 → none', () => {
  const doc = fakeDoc();
  const node = new FakeEl(doc, 'span');
  assert.strictEqual(B.renderInto(node, { avatarId: 'witch', avatarUrl: null }), 'builtin');
  assert.match(node.innerHTML, /#wwAvWitch/);
  assert.strictEqual(doc._bodyChildren.length, 1, '渲染前必须先保证定义已在页面里');

  const node2 = new FakeEl(doc, 'span');
  assert.strictEqual(B.renderInto(node2, { avatarId: 'witch', avatarUrl: '/api/profiles/p/avatar?v=abc' }), 'custom');
  assert.strictEqual(node2.children.length, 1);
  assert.strictEqual(node2.children[0].tagName, 'IMG');
  assert.strictEqual(node2.children[0].src, '/api/profiles/p/avatar?v=abc', '取图必须用服务端给的 avatarUrl');
  assert.strictEqual(node2.children[0].className, B.IMG_CLASS);

  assert.strictEqual(B.renderInto(null, { avatarId: 'wolf' }), 'none');
});

test('renderInto：自定义头像加载失败 → 回落到该档案的内置徽记（绝不破图）', () => {
  const doc = fakeDoc();
  const node = new FakeEl(doc, 'span');
  const profile = { avatarId: 'mask', avatarUrl: '/api/profiles/p/avatar?v=deadbeef' };
  assert.strictEqual(B.renderInto(node, profile), 'custom');
  const img = node.children[0];
  assert.strictEqual(node.children.length, 1);
  img.dispatch('error'); // 404 / 哈希过期 / 文件损坏
  assert.strictEqual(node.children.length, 0, '失败的 <img> 必须被摘掉，不能留在页面上当破图');
  assert.match(node.innerHTML, /#wwAvMask/, '回落到档案自己的 avatarId，而不是默认值或空白');
  assert.ok(!/ww-avatar-img/.test(node.innerHTML), '回落之后不得再有 img');
});

test('renderInto：迟到的 error 不得覆盖后续渲染（旧图失败换来新头像时的串味）', () => {
  const doc = fakeDoc();
  const node = new FakeEl(doc, 'span');
  B.renderInto(node, { avatarId: 'candle', avatarUrl: '/a?v=1' });
  const staleImg = node.children[0];
  B.renderInto(node, { avatarId: 'hunter', avatarUrl: '/b?v=2' });
  const currentImg = node.children[0];
  assert.notStrictEqual(currentImg, staleImg, '第二次渲染必须换掉 img 节点（否则 error 无法区分新旧）');

  staleImg.dispatch('error'); // 上一张图的 error 迟到
  assert.strictEqual(node.children[0], currentImg, '迟到的 error 不得把新头像换掉');
  assert.ok(!/#wwAvCandle/.test(node.innerHTML), '更不能回落成上一份档案的徽记');

  currentImg.dispatch('error'); // 当前这张真失败 → 回落本次档案的徽记
  assert.match(node.innerHTML, /#wwAvHunter/);
  assert.strictEqual(node.children.length, 0, '失败之后不得留下 img（破图）');
});
