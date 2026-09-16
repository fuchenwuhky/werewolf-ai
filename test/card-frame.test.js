/**
 * card-frame.test.js — 手绘 SVG 卡框的契约测试
 *
 * 背景：卡框的几何是"CSS 与 SVG 两边各写一半"的：
 *   CSS 用 `padding: 7%` 给框带留位，SVG 用 viewBox(100×150) 里的 7 单位画框带。
 *   任何一边单独改动，画窗与框带就会错位 —— 而且**不会报错**，只是看起来"有点歪"。
 *   这类静默错位正是这轮踩过的坑，所以在这里钉死：
 *     ① 导出的几何常量与 SVG 标记里的实际数字一致
 *     ② CSS 里的百分比与 SVG 的单位能互相换算对得上
 *     ③ FRAME 里引用的每个 url(#id) 都能在 DEFS 里找到（写错一个字母 = 整块变黑）
 *     ④ 卡框只有一份实现（app.js / m.js 都调 window.CardFrame，不许各自内联 SVG）
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

/** 在裸环境加载 card-frame.js（它必须能在没有 DOM 时加载，才能被这样测） */
function loadFrame() {
  const sandbox = { module: { exports: {} }, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('card-frame.js'), sandbox, { filename: 'card-frame.js' });
  return sandbox.CardFrame;
}

const CF = loadFrame();

test('几何常量与 SVG 标记里的实际数字一致', () => {
  assert.deepStrictEqual({ w: CF.VIEW.w, h: CF.VIEW.h }, { w: 100, h: 150 }, 'viewBox 变了就要同步改 CSS 的百分比');
  assert.strictEqual(CF.BAND, 7, '框带单位宽度');
  // 四条斜接梯形必须按 BAND 切角：顶边 (0,0)(100,0)(100-B,B)(B,B)
  const B = CF.BAND;
  const quads = [
    `M0 0 H${CF.VIEW.w} L${CF.VIEW.w - B} ${B} H${B} Z`,
    `M0 ${CF.VIEW.h} H${CF.VIEW.w} L${CF.VIEW.w - B} ${CF.VIEW.h - B} H${B} Z`,
    `M0 0 L${B} ${B} V${CF.VIEW.h - B} L0 ${CF.VIEW.h} Z`,
    `M${CF.VIEW.w} 0 L${CF.VIEW.w - B} ${B} V${CF.VIEW.h - B} L${CF.VIEW.w} ${CF.VIEW.h} Z`,
  ];
  for (const q of quads) assert.ok(CF.FRAME.includes(q), `FRAME 缺少斜接梯形 ${q}`);
  assert.match(CF.FRAME, /preserveAspectRatio="none"/, '框层必须随卡片非等比拉伸');
  assert.match(CF.FRAME, /viewBox="0 0 100 150"/, 'FRAME 的 viewBox 与 VIEW 不一致');
  assert.match(CF.FRAME, /class="fr-svg"/, '框层需要 .fr-svg 类名（CSS 靠它定位）');
  assert.match(CF.FRAME, /aria-hidden="true"/, '装饰性 SVG 不该被读屏朗读');
});

test('CSS 的框带百分比与 SVG 单位能互相换算（错位是静默的）', () => {
  const css = read('style.css');
  // 用行首锚定：否则会先匹配到 `.mrc-art .card-frame { width: 100% }` 那条（它在前面）
  const block = css.match(/^\.card-frame\s*\{([^}]*)\}/m);
  assert.ok(block, 'style.css 里找不到 .card-frame 规则');
  const body = block[1];
  const num = (name) => {
    const m = body.match(new RegExp(`--${name}:\\s*([\\d.]+)%`));
    assert.ok(m, `.card-frame 缺少 --${name} 百分比`);
    return parseFloat(m[1]);
  };
  const band = num('band');
  const bandY = num('band-y');
  // 横向：百分比按宽度解析 → BAND / VIEW.w
  assert.ok(Math.abs(band - (CF.BAND / CF.VIEW.w) * 100) < 0.01, `--band=${band}% 与 SVG 的 ${CF.BAND}/${CF.VIEW.w} 不符`);
  // 纵向：百分比按高度解析 → BAND / VIEW.h（这就是那个坑：写 var(--band) 会算成 10.5 单位）
  assert.ok(
    Math.abs(bandY - (CF.BAND / CF.VIEW.h) * 100) < 0.01,
    `--band-y=${bandY}% 与 SVG 的 ${CF.BAND}/${CF.VIEW.h} 不符`
  );
  assert.match(body, /padding:\s*var\(--band\)/, '.card-frame 必须用 --band 留出框带宽度');
  // 画窗圆角：CSS 是 x/y 两个百分比，对应 SVG 里的 rx 单位
  const radius = css.match(/\.card-frame\s+\.role-art\s*\{[^}]*border-radius:\s*([\d.]+)%\s*\/\s*([\d.]+)%/);
  assert.ok(radius, '插画圆角必须是 x/y 两个百分比（单个百分比会按高度解析，比画窗更圆）');
  assert.ok(Math.abs(parseFloat(radius[1]) - (CF.WINDOW_RX / CF.VIEW.w) * 100) < 0.01, '圆角横向与 SVG 的 rx 不符');
  assert.ok(Math.abs(parseFloat(radius[2]) - (CF.WINDOW_RX / CF.VIEW.h) * 100) < 0.01, '圆角纵向与 SVG 的 rx 不符');
});

test('FRAME 引用的每个 url(#id) 都能在 DEFS 里找到（写错一个字母就整块变黑）', () => {
  const ids = new Set([...CF.DEFS.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  assert.ok(ids.size >= 8, `DEFS 里的 id 太少（${ids.size}），可能整段丢失`);
  const idsArr = [...ids];
  assert.strictEqual(idsArr.length, new Set(idsArr).size, 'DEFS 里有重复 id');
  const refs = [...CF.FRAME.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(refs.length >= 4, 'FRAME 里没有渐变引用？');
  for (const r of refs) assert.ok(ids.has(r), `FRAME 引用了未定义的 id: ${r}`);
  // use 引用的图形也必须在 DEFS 里
  const uses = [...CF.FRAME.matchAll(/<use[^>]*href="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(uses.length >= 4, 'FRAME 里没有 use 引用？');
  for (const u of uses) assert.ok(ids.has(u), `FRAME 的 use 引用了未定义的 id: ${u}`);
});

test('无 DOM 时也能加载：ensureDefs 静默跳过而不是抛错', () => {
  assert.strictEqual(typeof CF.html, 'function');
  assert.strictEqual(CF.ensureDefs(), false, '没有 document 时 ensureDefs 应返回 false');
  assert.match(CF.html(), /class="fr-svg"/, '无 DOM 时 html() 仍要返回标记字符串');
  assert.match(CF.DEFS, new RegExp(`id="${CF.DEFS_ID}"`), 'defs 容器 id 与 DEFS_ID 不一致');
  assert.match(CF.DEFS, /width="0"\s+height="0"/, 'defs 容器必须是 0 尺寸（不能 display:none，有些浏览器不解析其渐变）');
});

test('卡框只有一份实现：两处页面都调 window.CardFrame，不许各自内联 SVG', () => {
  for (const f of ['app.js', 'm/m.js']) {
    const src = read(f);
    assert.match(src, /window\.CardFrame\.html\(\)/, `${f} 应调用共享的 CardFrame.html()`);
    assert.ok(!/class="fr-svg"/.test(src), `${f} 内联了一份框 SVG —— 必须共用 card-frame.js`);
    assert.ok(!/fr-corner|fr-gem|fr-orn/.test(src), `${f} 残留了旧版的框装饰标记`);
  }
  // 旧版的 CSS 装饰也该清干净
  const css = read('style.css');
  assert.ok(!/\.fr-corner\b/.test(css), 'style.css 残留 .fr-corner（旧版铆钉）');
  assert.ok(!/\.fr-orn\b/.test(css), 'style.css 残留 .fr-orn（旧版 ✠ 字符）');
  // 检视大卡必须复用 .card-frame，而不是再维护一份金属框 CSS
  assert.match(css, /\.inspect-card\s*\{[^}]*\}/, '缺少 .inspect-card 规则');
  const inspectBlock = css.match(/\.inspect-card\s*\{([^}]*)\}/)[1];
  assert.ok(!/linear-gradient\(168deg/.test(inspectBlock), '.inspect-card 又自己拼了一份金属渐变（应复用 .card-frame）');
});

test('页面接线：两个入口都先加载 card-frame.js，且进离线预缓存', () => {
  for (const [page, ref] of [['index.html', 'card-frame.js'], ['m/index.html', '../card-frame.js']]) {
    const html = read(page);
    const order = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(order.includes(ref), `${page} 未加载 ${ref}（scripts: ${order.join(', ')}）`);
    const biz = Math.max(order.findIndex((s) => s === 'app.js' || s === 'm.js'), order.findIndex((s) => s.endsWith('/app.js') || s.endsWith('/m.js')));
    assert.ok(order.indexOf(ref) < biz, `${page}：card-frame.js 必须早于业务脚本（业务脚本渲染时就要用它）`);
  }
  assert.match(read('sw.js'), /'\/card-frame\.js'/, 'card-frame.js 是外壳的一部分，必须进离线预缓存');
});

test('小尺寸下的降级：容器查询隐藏过细的铆钉', () => {
  const css = read('style.css');
  assert.match(css, /^\.card-frame\s*\{[^}]*container-type:\s*inline-size/m, '.card-frame 需要 container-type 才能按卡宽降级');
  assert.match(css, /@container\s*\(max-width:\s*150px\)\s*\{[^}]*\.fr-stud[^}]*display:\s*none/, '小卡应隐藏菱形铆钉（1px 级别只会糊成一团）');
  assert.match(CF.FRAME, /class="fr-stud"/, 'FRAME 里的铆钉需要 .fr-stud 类名，否则容器查询选不中');
});
