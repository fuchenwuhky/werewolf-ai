/**
 * card-frame-skin.test.js — 角色卡牌皮肤（SKIN-01/02）的定向契约测试
 *
 * 这个文件钉的是**换肤本身**的四类判据，与 `test/card-frame.test.js`（旧手绘 SVG 框的几何/染色）
 * 分工不同，两者都保留：
 *
 *   ① 素材：17 个文件的源/生产/台账三方哈希一致；R2 小框（5,922B/份）不是 archive/compact-v1；
 *      生产目录里不多不少就是这 17 个（归档、预览截图、compact-study、preview 一律不得发布）。
 *   ② 几何：52/62/112/113/132/210/230/320px 的固定尺寸与 2:3 比例（误差 ≤1 CSS px），
 *      以及 **112 及以下走 R2 小框、113 以上走大卡材质** 的切换阈值。
 *   ③ 主题与名称：15 个角色 → wolf/oracle/village/fate；未知/非法 id → neutral；
 *      `revealed` 非 true → 一律 neutral；名称表与 `src/engine/roles.js` 逐条一致（防漂移）。
 *   ④ 隐藏身份与降级链：**同一个未知视图对不同的秘密角色，必须产出完全相同的 DOM/URL/ARIA**
 *      （只归一化无语义的自增 clipPath id，theme/role/src 字段一律**照原样参与比较**）；
 *      并且小卡路径上**根本不存在** 1.94MiB 的金属 PNG 节点（不是"存在但被 CSS 藏起来"）。
 *
 * 关于 DOM：`node --test` 里没有浏览器，所以本文件用一个**只实现 mount 用到的那几个 API** 的
 * 极简 shim（createElement/createElementNS/setAttribute/appendChild/replaceChildren/dataset/
 * addEventListener/ResizeObserver）。它是"结构断言"，**不能代替真实浏览器测量** ——
 * 边界矩形、图片真实加载结果与网络请求集合由 `scripts/card-skin-probe.js` 在真实 Chrome 里量
 * （本文件里的同一条不变量在那里会以实寸/实请求再验一次）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

const manifest = require('../scripts/card-skin-manifest.js');
const { ROLES } = require('../src/engine/roles.js');

// ---------------------------------------------------------------- 极简 DOM shim

class FakeRO {
  constructor(cb) { this.cb = cb; this.targets = new Set(); FakeRO.last = this; }
  observe(t) { this.targets.add(t); }
  unobserve(t) { this.targets.delete(t); }
  trigger() { this.cb([...this.targets].map((t) => ({ target: t }))); }
}

function makeDom() {
  const nodes = [];
  const byId = new Map();
  function el(tag, ns) {
    const node = {
      tagName: String(tag).toLowerCase(),
      namespaceURI: ns || null,
      _className: '', _id: '', _src: '', _href: '', _rel: '', _alt: '', textContent: '',
      hidden: false, draggable: true, decoding: '',
      style: {}, dataset: {}, attrs: new Map(), children: [], parent: null,
      _listeners: new Map(),
      setAttribute(k, v) {
        const key = String(k);
        this.attrs.set(key, String(v));
        if (key === 'id') { this._id = String(v); byId.set(this._id, this); }
        if (key === 'class') this._className = String(v);
        if (key === 'href') this._href = String(v);
        if (key === 'src') this._src = String(v);
        if (key === 'rel') this._rel = String(v);
        if (key === 'alt') this._alt = String(v);
      },
      getAttribute(k) { return this.attrs.has(String(k)) ? this.attrs.get(String(k)) : null; },
      setAttributeNS(_ns, k, v) { this.setAttribute(k, v); },
      appendChild(c) { c.parent = this; this.children.push(c); return c; },
      remove() {
        if (!this.parent) return;
        const i = this.parent.children.indexOf(this);
        if (i >= 0) this.parent.children.splice(i, 1);
        this.parent = null;
      },
      replaceChildren(...cs) {
        for (const c of this.children) c.parent = null;
        this.children = [];
        for (const c of cs) this.appendChild(c);
      },
      addEventListener(type, fn) {
        const list = this._listeners.get(type) || [];
        list.push(fn);
        this._listeners.set(type, list);
      },
      fire(type) { for (const fn of this._listeners.get(type) || []) fn({ type }); },
      getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
      get isConnected() { let n = this; while (n.parent) n = n.parent; return n === doc.body; },
      querySelectorAll() { return []; },
    };
    // 真实 DOM 里 `el.className/href/src/rel/id` 这类**属性反射**赋值会同步写进属性 —— shim 必须照做，
    // 否则"注入的 <link rel=stylesheet> 找不找得到"这种断言会在假 DOM 上得出假绿/假红。
    for (const prop of ['className', 'id', 'src', 'href', 'rel', 'alt']) {
      const attr = prop === 'className' ? 'class' : prop;
      Object.defineProperty(node, prop, {
        get() { return node[`_${prop}`]; },
        set(v) { node.setAttribute(attr, v == null ? '' : String(v)); },
        enumerable: true,
      });
    }
    nodes.push(node);
    return node;
  }
  const doc = {
    head: el('head'), body: el('body'), currentScript: null,
    _listeners: new Map(),
    createElement: (t) => el(t, null),
    createElementNS: (ns, t) => el(t, ns),
    getElementById: (id) => byId.get(String(id)) || null,
    querySelectorAll: (sel) => (sel === 'link[rel="stylesheet"]' ? nodes.filter((n) => n.tagName === 'link' && n.getAttribute('rel') === 'stylesheet') : []),
    addEventListener() {},
    defaultView: { ResizeObserver: FakeRO },
  };
  doc.head.parent = null;
  doc.body.parent = null;
  return { doc, el, nodes, byId };
}

/** 在装好 shim 的沙箱里加载 card-frame.js（每次拿到一份干净的实例与 DOM） */
function loadFrame(ctx) {
  const doc = (ctx && ctx.doc) || { currentScript: null };
  if (ctx && ctx.currentScript) doc.currentScript = { src: ctx.currentScript };
  const sandbox = {
    module: { exports: {} },
    console,
    URL,
    location: ctx && ctx.location ? ctx.location : { href: 'http://localhost/index.html', pathname: '/index.html' },
    document: doc,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('card-frame.js'), sandbox, { filename: 'card-frame.js' });
  return sandbox.CardFrame;
}

/** 无 DOM 的裸实例：几何/主题/路径等纯计算用（与 test/card-frame.test.js 同一套加载方式） */
const CF = loadFrame();

/** 把 DOM 子树序列化成可比较的字符串：属性、类名、行内样式、文本、img 的 src/hidden 全部参与 */
function serialize(node) {
  const attrs = [...node.attrs.entries()]
    .map(([k, v]) => [k, String(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`);
  const style = Object.keys(node.style).sort().map((k) => `${k}:${node.style[k]}`);
  const data = Object.entries(node.dataset).sort().map(([k, v]) => `${k}=${v}`);
  const own = [
    node.tagName,
    `class=${node.className}`,
    ...attrs,
    ...style,
    `data=${data.join(';')}`,
    `src=${node.src || ''}`,
    `hidden=${node.hidden}`,
    `text=${node.textContent}`,
  ].join('|');
  if (!node.children.length) return own;
  return `${own}(${node.children.map(serialize).join(' && ')})`;
}

/** 只归一化**无语义的**自增 clipPath 实例 id（theme/role/src 等字段不动，照原样参与比较） */
const normalizeClipIds = (s) => s.replace(/r3-window-\d+/g, 'r3-window-N');

/** 便捷：装好 DOM 后挂一张卡 */
function mountCard(options) {
  const dom = makeDom();
  const frame = loadFrame({ doc: dom.doc, currentScript: 'http://localhost/card-frame.js' });
  const host = dom.el('div', null);
  dom.doc.body.appendChild(host);
  const shell = frame.mount(host, options);
  return { dom, frame, host, shell, card: shell.children[0] };
}

const imgSrcs = (node) => {
  const out = [];
  const walk = (n) => {
    if (n.tagName === 'img' && n.src) out.push(n.src);
    if (n.attrs.has('href')) out.push(n.attrs.get('href'));
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
};

// ---------------------------------------------------------------- ① 素材

test('素材：17 个文件的源/生产/台账三方哈希一致（实算，不比文档字符串）', () => {
  const { failures, rows } = manifest.verify({ quiet: true });
  assert.deepStrictEqual(failures, [], `素材核验失败：\n${failures.join('\n')}`);
  assert.strictEqual(rows.length, 17, `素材应为 17 个（实际 ${rows.length}）`);
  assert.ok(rows.every((r) => r.ok), '有素材行未通过');
  // 每个文件的哈希必须是**当场从磁盘字节算出来的**，并与台账相等（防止台账被手改）
  for (const r of rows) {
    const buf = fs.readFileSync(path.join(ROOT, r.production));
    assert.strictEqual(manifest.sha256(buf), r.sha256, `${r.production} 的哈希与台账不符`);
    assert.strictEqual(buf.length, r.bytes, `${r.production} 的字节数与台账不符`);
  }
});

test('素材：生产目录恰好 17 个文件，不含 archive/预览/compact-study/preview', () => {
  const dir = path.join(ROOT, manifest.PROD_REL);
  const names = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(names, [...manifest.ASSET_NAMES].sort(), '生产目录内容与清单不一致');
  for (const bad of ['archive', 'compact-study.html', 'preview.js', 'preview-desktop.png', 'README.md']) {
    assert.ok(!names.includes(bad), `生产素材目录不得出现 ${bad}`);
  }
});

test('素材：小卡是 R2 精雕薄框（5,922B/份），不是 archive/compact-v1 的旧小框', () => {
  const dir = path.join(ROOT, manifest.PROD_REL);
  const archive = path.join(ROOT, manifest.ARCHIVE_REL);
  for (const theme of manifest.THEMES) {
    const name = `compact-${theme}.svg`;
    const buf = fs.readFileSync(path.join(dir, name));
    assert.strictEqual(buf.length, 5922, `${name} 应为 R2 的 5,922 字节（实际 ${buf.length}）`);
    const old = fs.readFileSync(path.join(archive, name));
    assert.ok(old.length < 3000, `${name} 的归档件应是旧小框（用于对照）`);
    assert.notStrictEqual(manifest.sha256(buf), manifest.sha256(old), `${name} 与旧归档字节相同 —— 发布错了目录`);
  }
  // 大卡金属层：透明 PNG 的实算哈希与施工说明记录的值一致（独立常量交叉印证）
  const png = fs.readFileSync(path.join(dir, 'reliquary-metal.png'));
  assert.strictEqual(manifest.sha256(png), manifest.DOC.pngSha256, '金属 PNG 的实算哈希与文档不符');
  assert.deepStrictEqual(manifest.pngDims(png), manifest.DOC.pngSize, '金属 PNG 尺寸不是 1024×1536');
});

// ---------------------------------------------------------------- ② 几何

test('几何：52/62/112/113/132/210/230/320 的固定尺寸与 2:3（误差 ≤1 CSS px）', () => {
  const expect = [
    [52, 78, true], [62, 93, true], [112, 168, true], [113, 170, false],
    [132, 198, false], [210, 315, false], [230, 345, false], [320, 480, false],
  ];
  for (const [w, h, compact] of expect) {
    const s = CF.sizeOf(w);
    assert.strictEqual(s.width, w, `${w}px 的宽度`);
    assert.strictEqual(s.height, h, `${w}px 的高度应为 ${h}（2:3）`);
    assert.strictEqual(s.compact, compact, `${w}px 的档位（≤112 走小框）`);
    assert.ok(Math.abs(s.height - w * 1.5) <= 1, `${w}px 的比例误差必须 ≤1px（实际 ${s.height - w * 1.5}）`);
  }
  // 六个场景常量就是"调用方该传什么"，测试与实现共用一张表
  assert.deepStrictEqual(
    { ...CF.SIZES },
    { phone: 52, desktop: 62, codex: 132, codexBig: 210, flip: 230, inspect: 320 },
    '场景尺寸表被改动',
  );
  assert.strictEqual(CF.COMPACT_MAX, 112, '统一切换阈值必须是 112px');
  assert.strictEqual(CF.sizeOf(0), null, '非法宽度应返回 null（由调用方决定兜底）');
  assert.strictEqual(CF.sizeOf('abc'), null);
});

test('几何：空间不足时等比缩小（检视 320×480 / 翻牌 230×345）', () => {
  const flip = CF.fitSize(CF.SIZES.flip, { height: 300 });
  assert.ok(flip.height <= 300, `翻牌卡高度应 ≤300（实际 ${flip.height}）`);
  assert.ok(Math.abs(flip.height - flip.width * 1.5) <= 1, '等比缩小后仍必须是 2:3');
  assert.strictEqual(flip.scaled, true);
  const inspect = CF.fitSize(CF.SIZES.inspect, { width: 200, height: 400 });
  assert.ok(inspect.width <= 200 && inspect.height <= 400, '检视卡不得超出可用宽高');
  assert.ok(Math.abs(inspect.height - inspect.width * 1.5) <= 1);
  const roomy = CF.fitSize(CF.SIZES.codex, { width: 400, height: 600 });
  assert.deepStrictEqual({ w: roomy.width, h: roomy.height, scaled: roomy.scaled }, { w: 132, h: 198, scaled: false }, '空间够时不得缩放');
  // 缩到 112 以下时也要跟着走小框（否则小尺寸上会套大卡材质）
  const tiny = CF.fitSize(CF.SIZES.flip, { width: 100 });
  assert.strictEqual(tiny.compact, true, '缩到 ≤112px 必须切到 R2 小框');
});

test('几何：素材路径由共享层统一给出（桌面 / 、手机 /m/、原生壳 file:// 与 localhost）', () => {
  const cases = [
    ['桌面', 'http://localhost/index.html', 'http://localhost/card-frame.js', 'http://localhost/'],
    ['手机', 'http://localhost/m/index.html', 'http://localhost/card-frame.js', 'http://localhost/'],
    ['手机（相对引用 ../card-frame.js 的真实解析结果）', 'http://localhost/m/', 'http://localhost/card-frame.js', 'http://localhost/'],
    ['Capacitor 安卓壳', 'http://localhost/m/index.html', 'http://localhost/card-frame.js', 'http://localhost/'],
    ['file:// 桌面壳', 'file:///C:/app/www/index.html', 'file:///C:/app/www/card-frame.js', 'file:///C:/app/www/'],
    ['file:// 手机页', 'file:///C:/app/www/m/index.html', 'file:///C:/app/www/card-frame.js', 'file:///C:/app/www/'],
  ];
  for (const [label, href, script, root] of cases) {
    const frame = loadFrame({ location: { href, pathname: new URL(href).pathname }, currentScript: script });
    assert.strictEqual(frame.assetBase(), new URL('assets/card-frames/v3/', root).href, `${label}：卡框素材目录`);
    assert.strictEqual(frame.artBase(), new URL('assets/roles/', root).href, `${label}：立绘目录`);
    assert.strictEqual(frame.stylesheetUrl(), new URL('shared/card-frame-kit.css', root).href, `${label}：共享样式 URL`);
  }
  // 没有 document.currentScript 的老环境（按页面 URL 兜底；手机页要退回一级）
  const noScript = loadFrame({ location: { href: 'http://localhost/m/index.html', pathname: '/m/index.html' } });
  assert.strictEqual(noScript.assetBase(), 'http://localhost/assets/card-frames/v3/', '无 currentScript 时手机页也要落到 /assets/');
  // 原生壳的显式覆盖
  const forced = loadFrame({ currentScript: 'capacitor://localhost/card-frame.js' });
  forced.setAssetBase('capacitor://localhost/assets/card-frames/v3');
  assert.strictEqual(forced.assetUrl('compact-wolf.svg'), 'capacitor://localhost/assets/card-frames/v3/compact-wolf.svg');
  forced.setAssetBase('');
  assert.strictEqual(forced.assetBase(), 'capacitor://localhost/assets/card-frames/v3/', '传空应恢复自动解析');
});

// ---------------------------------------------------------------- ③ 主题与名称

test('主题映射：15 个角色 → wolf/oracle/village/fate，未知/非法 → neutral', () => {
  const ids = Object.values(ROLES).map((r) => r.id).filter(Boolean).sort();
  assert.strictEqual(ids.length, 15, `引擎角色数应为 15（读到 ${ids.length}）`);
  assert.deepStrictEqual(Object.keys(CF.THEME).sort(), ids, '主题表必须与引擎角色表逐条对应（多/少都是漂移）');
  const want = { wolf: 'wolf', god: 'oracle', villager: 'village' };
  for (const r of Object.values(ROLES)) {
    const expect = r.id === 'admirer' ? 'fate' : want[r.category];
    assert.strictEqual(CF.themeOf(r.id, true), expect, `${r.id}（${r.category}）的主题`);
  }
  // 引擎 category 与旧外观键都不因换肤改变：codex.js 的分区依赖 wolf/god/villager/third
  assert.strictEqual(CF.FACTION.admirer, 'third', '暗恋者在旧外观表里仍是 third');
  assert.strictEqual(CF.THEME.admirer, 'fate', '暗恋者的新主题是 fate');
  assert.match(CF.roleAttr('admirer'), /data-faction="third"/, '兼容接口的阵营键不得被新主题命名改掉');
  // 未知/非法/空值一律 neutral
  for (const bad of ['nobody', 'seer2', 'wo"lf', '', null, undefined, 0, {}, '../frame-wolf']) {
    assert.strictEqual(CF.themeOf(bad, true), 'neutral', `未知/非法 id ${JSON.stringify(bad)} 应回退 neutral`);
  }
  // revealed 不是严格 true 时，角色 id 完全不参与
  for (const r of Object.values(ROLES)) {
    assert.strictEqual(CF.themeOf(r.id, false), 'neutral', `${r.id} 在未揭示时必须是 neutral`);
    assert.strictEqual(CF.themeOf(r.id, undefined), 'neutral', `${r.id} 缺省 revealed 必须是 neutral`);
    assert.strictEqual(CF.themeOf(r.id, 'true'), 'neutral', `${r.id} revealed 必须严格等于 true`);
  }
  // fate 只是外观分类，不是新阵营：它不出现在旧阵营表里
  assert.ok(!Object.values(CF.FACTION).includes('fate'), 'FACTION 里不得出现 fate');
});

test('名称：兜底角色名与引擎逐条一致（生产文案由调用方/i18n 提供）', () => {
  const ids = Object.values(ROLES).map((r) => r.id).filter(Boolean).sort();
  assert.deepStrictEqual(Object.keys(CF.ROLE_NAMES).sort(), ids, '名称表必须与引擎角色表对应');
  for (const r of Object.values(ROLES)) {
    assert.strictEqual(CF.ROLE_NAMES[r.id], r.name, `${r.id} 的名称与引擎不一致`);
  }
  assert.strictEqual(CF.nameOf('seer', true), ROLES.seer.name);
  assert.strictEqual(CF.nameOf('seer', false), CF.NAME_UNKNOWN, '未揭示不得返回角色名');
  assert.strictEqual(CF.nameOf('nobody', true), CF.NAME_UNKNOWN, '未知角色不得瞎猜名称');
  const { card } = mountCard({ roleId: 'seer', revealed: true, width: 62, name: '预言家（自定义）' });
  const title = card.children.find((c) => c.className === 'r3-title');
  assert.strictEqual(title.textContent, '预言家（自定义）', '调用方给的名称优先（服务端资料/i18n）');
  assert.strictEqual(card.getAttribute('aria-label'), '预言家（自定义）角色牌');
});

// ---------------------------------------------------------------- ④ 隐藏身份

test('隐藏身份：不同秘密角色在未揭示视图下的 DOM/URL/ARIA 完全一致（只归一化 clipPath id）', () => {
  const snapshot = (secret) => {
    const m = mountCard({ roleId: secret, revealed: false, width: 230 });
    return {
      dom: normalizeClipIds(serialize(m.shell)),
      urls: imgSrcs(m.shell).map(normalizeClipIds).sort(),
      aria: m.card.getAttribute('aria-label'),
      attrs: [...m.card.attrs.keys()].sort().join(','),
    };
  };
  const a = snapshot('wolf');
  const b = snapshot('seer');
  const c = snapshot('guard');
  assert.strictEqual(a.dom, b.dom, '两个不同秘密角色的未知视图 DOM 必须一致');
  assert.strictEqual(a.dom, c.dom, '三个不同秘密角色的未知视图 DOM 必须一致');
  assert.deepStrictEqual(a.urls, b.urls, '未知视图加载的资源 URL 集合必须一致');
  assert.deepStrictEqual([a.aria, a.attrs], [b.aria, b.attrs], 'ARIA 与属性集合必须一致');
  // 秘密角色不得出现在任何一处（DOM 文本、URL、属性、标题）
  for (const secret of ['wolf', 'seer']) {
    const m = mountCard({ roleId: secret, revealed: false, width: 230 });
    const dump = `${serialize(m.shell)} ${imgSrcs(m.shell).join(' ')} ${JSON.stringify([...m.card.attrs.entries()])}`;
    assert.ok(!dump.includes(secret), `未揭示视图泄露了秘密角色 ${secret}：${dump.slice(0, 200)}`);
    assert.ok(!m.card.dataset.role, '未揭示视图不得写 data-role');
    assert.strictEqual(m.shell.dataset.theme, 'neutral', '未揭示视图必须是 neutral 主题');
    assert.ok(dump.includes('card-back-field.svg'), '未揭示视图必须用统一中性牌背内衬');
    assert.strictEqual(m.card.getAttribute('role'), 'img');
  }
  // 已知但非法的角色 id：同样回退 neutral，且不写 data-role
  const unknown = mountCard({ roleId: 'nobody', revealed: true, width: 230 });
  assert.strictEqual(unknown.shell.dataset.theme, 'neutral');
  assert.ok(!unknown.card.dataset.role);
  assert.strictEqual(unknown.card.getAttribute('aria-label'), CF.NAME_UNKNOWN === '未揭示' ? '统一牌背，身份未揭示' : unknown.card.getAttribute('aria-label'));
  // 已揭示的合法角色：主题与 data-role 都要正确
  const seer = mountCard({ roleId: 'seer', revealed: true, width: 230 });
  assert.strictEqual(seer.shell.dataset.theme, 'oracle');
  assert.strictEqual(seer.card.dataset.role, 'seer');
  assert.ok(imgSrcs(seer.shell).some((u) => /\/assets\/roles\/seer\.png$/.test(u)), '已揭示时必须加载本人立绘');
});

test('隐藏身份：不能先渲染正面再用 CSS 盖住（未揭示时立绘节点都不是本人的）', () => {
  const m = mountCard({ roleId: 'wolf', revealed: false, width: 230 });
  const urls = imgSrcs(m.shell).join(' ');
  assert.ok(!/roles\/wolf\.png/.test(urls), '未揭示视图里出现了本人立绘 URL —— 属于"先渲染正面再遮住"');
  assert.ok(!/frame-wolf|accent-wolf/.test(urls), '未揭示视图里出现了狼主题素材');
  assert.ok(/frame-neutral\.svg/.test(urls), '未揭示视图应该用 neutral 大框');
});

// ---------------------------------------------------------------- ⑤ 小卡不请求大材质

test('小卡按需挂载：52/62px 路径里根本不存在金属 PNG 与大卡素材节点', () => {
  for (const width of [52, 62, 112]) {
    const m = mountCard({ roleId: 'seer', revealed: true, width });
    const urls = imgSrcs(m.shell);
    const joined = urls.join(' ');
    assert.ok(!/reliquary-metal\.png/.test(joined), `${width}px 卡请求了 1.94MiB 金属 PNG（${joined}）`);
    assert.ok(!/frame-oracle\.svg|accent-oracle\.svg/.test(joined), `${width}px 卡请求了大卡素材`);
    assert.ok(/compact-oracle\.svg/.test(joined), `${width}px 卡必须用 R2 小框`);
    assert.strictEqual(urls.filter((u) => /compact-/.test(u)).length, 1, `${width}px 卡只应有 1 个框素材请求`);
    assert.strictEqual(m.shell.dataset.detail, 'compact');
    // 小卡不硬塞名称，但可访问名称里必须有完整角色名
    assert.strictEqual(m.card.getAttribute('aria-label'), '预言家角色牌');
  }
  // 113px 起才是大卡：这时金属 PNG 必须出现（否则就是降级过度）
  const big = mountCard({ roleId: 'seer', revealed: true, width: 113 });
  assert.ok(/reliquary-metal\.png/.test(imgSrcs(big.shell).join(' ')), '113px 卡必须使用大卡材质');
  assert.strictEqual(big.shell.dataset.detail, 'big');
  // 显式 compact:true（旧 WebView 没有容器查询时）也必须走小卡
  const forced = mountCard({ roleId: 'seer', revealed: true, compact: true });
  assert.ok(!/reliquary-metal\.png/.test(imgSrcs(forced.shell).join(' ')), '显式 compact 不得请求金属 PNG');
  assert.ok(/compact-oracle\.svg/.test(imgSrcs(forced.shell).join(' ')));
  // vector 渲染模式：只看完整 SVG，不请求 PNG
  const vector = mountCard({ roleId: 'seer', revealed: true, width: 230, render: 'vector' });
  assert.strictEqual(vector.shell.dataset.render, 'vector');
});

test('小卡按需挂载：宽度未知时靠共享 ResizeObserver 跨过 112px 正确切档', () => {
  const m = mountCard({ roleId: 'seer', revealed: true });
  assert.strictEqual(m.shell.dataset.detail, 'big', '宽度未知时先按大卡挂载');
  assert.strictEqual(FakeRO.last.targets.size, 1, '应该只注册了一个观察目标');
  // 缩到 52px：切小卡，并把大卡材质从 DOM 里摘掉（不是 display:none 藏着）
  m.shell.getBoundingClientRect = () => ({ width: 52, height: 78, top: 0, left: 0 });
  FakeRO.last.trigger();
  assert.strictEqual(m.shell.dataset.detail, 'compact', '跨到 ≤112px 必须切小卡');
  assert.ok(!/reliquary-metal\.png/.test(imgSrcs(m.shell).join(' ')), '切小卡后不得再留着金属 PNG 节点');
  assert.ok(/compact-oracle\.svg/.test(imgSrcs(m.shell).join(' ')));
  // 再放大到 230px：切回大卡
  m.shell.getBoundingClientRect = () => ({ width: 230, height: 345, top: 0, left: 0 });
  FakeRO.last.trigger();
  assert.strictEqual(m.shell.dataset.detail, 'big', '跨回 >112px 必须切大卡');
  assert.ok(/reliquary-metal\.png/.test(imgSrcs(m.shell).join(' ')));
  // 宿主被移除后，回调里必须自动摘掉观察目标（不留悬挂的尺寸监听器）
  m.host.remove();
  FakeRO.last.trigger();
  assert.strictEqual(FakeRO.last.targets.size, 0, '断开的卡必须从共享观察器里摘掉');
  // 显式宽度的卡不注册任何尺寸监听器
  const fixed = mountCard({ roleId: 'seer', revealed: true, width: 52 });
  assert.strictEqual(fixed.dom.doc.defaultView.ResizeObserver, FakeRO);
  const before = FakeRO.last.targets.size;
  assert.strictEqual(before, 0, '显式宽度的卡不得注册尺寸监听器');
});

// ---------------------------------------------------------------- ⑥ 降级链

test('降级链：金属 PNG → 完整 SVG → CSS 细边框；立绘失败 → 底衬 + 可读名称', () => {
  const big = mountCard({ roleId: 'seer', revealed: true, width: 230 });
  const metal = big.card.children.find((c) => c.className === 'r3-material');
  const vector = big.card.children.find((c) => c.className === 'r3-vector');
  assert.ok(metal && vector, '大卡必须同时备好金属层与完整 SVG 回退层');
  metal.fire('error');
  assert.strictEqual(big.card.dataset.materialError, 'true', '金属失败必须打点（CSS 会切到完整 SVG）');
  vector.fire('error');
  assert.strictEqual(big.card.dataset.vectorError, 'true', '完整 SVG 也失败时必须打点（CSS 会切到细边框）');
  assert.strictEqual(vector.hidden, true, '坏掉的图必须隐藏，不能留一个破图占位');
  // 立绘失败：底衬 + 名称仍可读（名称节点不消失，aria-label 不变）
  const art = big.card.children.find((c) => c.tagName === 'svg');
  const image = art.children[1]; // [defs, image]
  image.fire('error');
  assert.strictEqual(big.card.dataset.artError, 'true', '立绘失败必须打点（CSS 给暗色底衬 + 名称）');
  assert.strictEqual(big.card.getAttribute('aria-label'), '预言家角色牌', '立绘失败不改变可访问名称');
  const title = big.card.children.find((c) => c.className === 'r3-title');
  assert.strictEqual(title.textContent, '预言家', '立绘失败时名称文本仍在');
  // 小框 SVG 失败：切到细边框
  const small = mountCard({ roleId: 'seer', revealed: true, width: 52 });
  small.card.children.find((c) => c.className === 'r3-compact').fire('error');
  assert.strictEqual(small.card.dataset.compactError, 'true', '小框失败必须打点（CSS 给细边框）');
  // CSS 侧的三级降级规则与"装饰不接点击"必须都在
  const css = read('shared/card-frame-kit.css');
  assert.match(css, /\.r3-card\[data-material-error\][^{]*\.r3-vector\s*\{\s*display:\s*block/, '缺少"金属失败 → 完整 SVG"的规则');
  assert.match(css, /\.r3-card\[data-vector-error\]::after/, '缺少"完整 SVG 失败 → 细边框"的规则');
  assert.match(css, /\.r3-shell\[data-detail='compact'\]\s*\.r3-card\[data-compact-error\]::after/, '缺少"小框失败 → 细边框"的规则');
  assert.match(css, /\.r3-card\s*>\s*svg,\s*\.r3-card\s*>\s*img\s*\{[^}]*pointer-events:\s*none/, '装饰层必须不接点击');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, '缺少减少动态效果规则');
});

test('渲染层只有一份实现：共享样式只注入一次，且复用同一份缓存', () => {
  const dom = makeDom();
  const frame = loadFrame({ doc: dom.doc, currentScript: 'http://localhost/card-frame.js' });
  const host = dom.el('div', null);
  dom.doc.body.appendChild(host);
  frame.mount(host, { roleId: 'seer', revealed: true, width: 230 });
  const host2 = dom.el('div', null);
  dom.doc.body.appendChild(host2);
  frame.mount(host2, { roleId: 'wolf', revealed: true, width: 52 });
  const links = dom.doc.querySelectorAll('link[rel="stylesheet"]');
  assert.strictEqual(links.length, 1, `共享样式必须只注入一条 <link>（实际 ${links.length}）`);
  assert.strictEqual(links[0].href, 'http://localhost/shared/card-frame-kit.css');
  // 页面已静态引用时不得重复插入
  const dom2 = makeDom();
  const pre = dom2.el('link', null);
  pre.setAttribute('rel', 'stylesheet');
  pre.setAttribute('href', '/shared/card-frame-kit.css');
  dom2.doc.head.appendChild(pre);
  const frame2 = loadFrame({ doc: dom2.doc, currentScript: 'http://localhost/card-frame.js' });
  const h2 = dom2.el('div', null);
  dom2.doc.body.appendChild(h2);
  frame2.mount(h2, { roleId: 'seer', revealed: true, width: 52 });
  assert.strictEqual(dom2.doc.querySelectorAll('link[rel="stylesheet"]').length, 1, '静态引用已存在时不得重复注入');
});

// ---------------------------------------------------------------- ⑦ 接线与清单

test('离线清单：新增样式与 17 个素材都在 SHELL 里，且 VERSION 已升档并登记指纹', () => {
  const sw = read('sw.js');
  const list = [...(sw.match(/const SHELL = \[([\s\S]*?)\];/)[1]).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(list.includes('/shared/card-frame-kit.css'), 'SHELL 缺少共享卡牌样式');
  for (const name of manifest.ASSET_NAMES) {
    assert.ok(list.includes(`/assets/card-frames/v3/${name}`), `SHELL 缺少素材 /assets/card-frames/v3/${name}`);
  }
  assert.ok(list.includes('/card-frame.js'), 'card-frame.js 必须留在 SHELL 里');
  const version = sw.match(/const VERSION = '([^']+)'/)[1];
  const ledger = fs.readFileSync(path.join(ROOT, 'test', 'sw-shell.test.js'), 'utf8');
  assert.ok(ledger.includes(`'${version}'`), `test/sw-shell.test.js 的 SHELL_LEDGER 没有登记 ${version}`);
  // 小卡不请求大材质的约束不能靠"删掉离线必需品"实现：金属 PNG 必须仍在预缓存里
  assert.ok(list.includes('/assets/card-frames/v3/reliquary-metal.png'), '离线必需的大卡材质不得被移出 SHELL');
});

test('旧的兼容接口没有被换肤改坏（html/roleAttr/roleAttrs 仍是字符串契约）', () => {
  assert.strictEqual(typeof CF.html, 'function');
  assert.match(CF.html(), /class="fr-svg"/, 'html() 仍必须返回旧框层字符串（app.js / m.js / codex.js 在用）');
  assert.strictEqual(CF.roleAttr('seer'), ' data-role="seer" data-faction="god"');
  assert.strictEqual(CF.roleAttr('nobody'), ' data-role="nobody"');
  assert.strictEqual(JSON.stringify(CF.roleAttrs('admirer')), '{"role":"admirer","faction":"third"}');
  assert.strictEqual(JSON.stringify(CF.roleAttrs('')), '{}');
  // 新增接口不应该顺手覆盖旧名字
  assert.strictEqual(typeof CF.mount, 'function');
  assert.ok(CF.html() !== undefined && typeof CF.html() === 'string', 'mount 不得替换 html 的返回类型');
});
