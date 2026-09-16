/**
 * card-frame.test.js — 手绘 SVG 卡框的契约测试
 *
 * 背景：卡框的几何是"CSS 与 SVG 两边各写一半"的：
 *   CSS 用 `padding: 11% 7% 10%` 给框带留位，SVG 用 viewBox(100×150) 里的
 *   BX/BYT/BYB 单位画框带。任何一边单独改动，画窗与框带就会错位 ——
 *   而且**不会报错**，只是看起来"有点歪"。这类静默错位正是这轮踩过的坑，所以在这里钉死：
 *     ① 导出的几何常量与 SVG 标记里的实际数字一致
 *     ② CSS 里的百分比与 SVG 的单位能互相换算对得上
 *     ③ FRAME 里引用的每个 url(#id)/use 都能在 DEFS 里找到（写错一个字母 = 整块变黑）
 *     ④ 四条边 + 四个角块必须**严丝合缝**铺满框带（漏一条缝就会透出底下的插画）
 *     ⑤ 卡框只有一份实现（app.js / m.js 都调 window.CardFrame，不许各自内联 SVG）
 *     ⑥ 每个角色 id 都要在 style.css 里有配色规则（否则那张卡会掉回默认金）
 *     ⑦ 小尺寸必须降级到"粗档"（52px 的坞内身份牌上，细档全是亚像素）
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
  assert.strictEqual(CF.BX, 7, '左右框带单位宽度');
  assert.strictEqual(CF.BYT, 11, '顶部徽记栏高度（要放得下徽记）');
  assert.strictEqual(CF.BYB, 10, '底部铭牌栏高度');
  assert.ok(CF.BYT > CF.BX && CF.BYB > CF.BX, '上下要比左右厚：卡牌游戏的框体是"顶部标题栏 + 底部铭牌"的结构');
  // 四条边 + 四个角块都要出现在 FRAME 里，且是按常量算出来的
  const q = CF.QUAD;
  assert.strictEqual(Object.keys(q).length, 8, '四条边 + 四个角块');
  for (const [name, d] of Object.entries(q)) assert.ok(CF.FRAME.includes(d), `FRAME 缺少 ${name} 的路径`);
  // 外轮廓是切角八边形：四个角都要有 ${CH} 的倒角
  for (const corner of [`M${CF.CH} 0`, `L${CF.VIEW.w} ${CF.CH}`, `L${CF.VIEW.w - CF.CH} ${CF.VIEW.h}`, `L0 ${CF.VIEW.h - CF.CH}`]) {
    assert.ok(CF.OUTER.includes(corner), `外轮廓缺少切角段 ${corner}`);
  }
  // 画窗
  assert.ok(CF.INNER.startsWith(`M${CF.BX} ${CF.BYT}`), '画窗左上角必须是 (BX, BYT)');
  assert.ok(CF.INNER.includes(`H${CF.VIEW.w - CF.BX}`), '画窗右边界 = w - BX');
  assert.ok(CF.INNER.includes(`V${CF.VIEW.h - CF.BYB}`), '画窗下边界 = h - BYB');
  // SVG 属性
  assert.match(CF.FRAME, /preserveAspectRatio="none"/, '框层必须随卡片非等比拉伸');
  assert.match(CF.FRAME, /viewBox="0 0 100 150"/, 'FRAME 的 viewBox 与 VIEW 不一致');
  assert.match(CF.FRAME, /class="fr-svg"/, '框层需要 .fr-svg 类名（CSS 靠它定位）');
  assert.match(CF.FRAME, /aria-hidden="true"/, '装饰性 SVG 不该被读屏朗读');
  // 两档细节都要画在同一个 SVG 里（粗档在下、细档在上，靠容器查询切换）
  assert.match(CF.FRAME, /class="fr-bold"/, '缺少小尺寸"粗档"分组');
  assert.match(CF.FRAME, /class="fr-fine"/, '缺少大尺寸"细档"分组');
  assert.ok(CF.FRAME.indexOf('fr-bold') < CF.FRAME.indexOf('fr-fine'), '粗档必须画在细档之前：细档才能把它整条盖住');
  // 两档各自的剖面渐变都要在 DEFS 里
  for (const id of ['frBandTop', 'frBandBottom', 'frBandLeft', 'frBandRight', 'frBoldTop', 'frBoldBottom', 'frBoldLeft', 'frBoldRight']) {
    assert.ok(CF.DEFS.includes(`id="${id}"`), `缺少剖面渐变 ${id}`);
  }
  assert.ok(CF.FRAME.includes('url(#frBoldTop)') && CF.FRAME.includes('url(#frBandTop)'), '两档都要用自己的剖面渐变');
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
  // 百分比 padding 一律按**宽度**解析 → 三个方向都能直接和 SVG 单位换算
  assert.ok(Math.abs(num('band') - (CF.BX / CF.VIEW.w) * 100) < 0.01, `--band 与 SVG 的 BX 不符`);
  assert.ok(Math.abs(num('band-t') - (CF.BYT / CF.VIEW.w) * 100) < 0.01, `--band-t 与 SVG 的 BYT 不符`);
  assert.ok(Math.abs(num('band-b') - (CF.BYB / CF.VIEW.w) * 100) < 0.01, `--band-b 与 SVG 的 BYB 不符`);
  // 纵向的 --band-y 是给绝对定位的角色名用的，按**高度**解析
  assert.ok(
    Math.abs(num('band-y') - (CF.BYB / CF.VIEW.h) * 100) < 0.01,
    `--band-y 应等于 BYB/150（这就是那个坑：写 var(--band) 会算成别的值）`
  );
  // 顶部同理：绝对定位的 top 也要一个 y 方向百分比，否则插画被框带压掉一条
  assert.ok(
    Math.abs(num('band-t-y') - (CF.BYT / CF.VIEW.h) * 100) < 0.01,
    `--band-t-y 应等于 BYT/150（写 var(--band-t) 会按高度算成 16.5 单位）`
  );
  assert.match(body, /padding:\s*var\(--band-t\)\s+var\(--band\)\s+var\(--band-b\)/, 'padding 必须按"上下不对称"的三值写法留出框带');
  // 绝对定位的插画/信息容器必须与画窗重合：三个 y 方向的值都要用 y 百分比
  for (const sel of ['.inspect-card .inner', '.inspect-card .in-body']) {
    const re = new RegExp(`${sel.replace('.', '\\.')}\\s*\\{[^}]*inset:\\s*var\\(--band-t-y\\)\\s+var\\(--band\\)\\s+var\\(--band-y\\)`);
    assert.match(css, re, `${sel} 的 inset 必须用带 -y 的百分比（var(--band-y) 那两个是横竖不同的量纲）`);
  }
  // 角色名是 .card-frame 的兄弟节点，自定义属性不跨兄弟继承：必须自己再定义一份，且值与框体同步
  const flipVars = css.match(/\.flip-front\s*\{[^}]*--band:\s*([\d.]+)%;\s*--band-y:\s*([\d.]+)%/);
  assert.ok(flipVars, '.flip-front 必须自己定义 --band 与 --band-y（兄弟节点不继承）');
  assert.ok(Math.abs(parseFloat(flipVars[2]) - (CF.BYB / CF.VIEW.h) * 100) < 0.01, `.flip-front 的 --band-y=${flipVars[2]}% 没跟上框带厚度（底部框带 = ${CF.BYB} 单位）`);
  assert.ok(Math.abs(parseFloat(flipVars[1]) - (CF.BX / CF.VIEW.w) * 100) < 0.01, '.flip-front 的 --band 与 BX 不符');
  // 画窗圆角：CSS 是 x/y 两个百分比，对应 SVG 里的 rx 单位
  const radius = css.match(/\.card-frame\s+\.role-art\s*\{[^}]*border-radius:\s*([\d.]+)%\s*\/\s*([\d.]+)%/);
  assert.ok(radius, '插画圆角必须是 x/y 两个百分比（单个百分比会按高度解析，比画窗更圆）');
  assert.ok(Math.abs(parseFloat(radius[1]) - (CF.WINDOW_RX / CF.VIEW.w) * 100) < 0.01, '圆角横向与 SVG 的 rx 不符');
  assert.ok(Math.abs(parseFloat(radius[2]) - (CF.WINDOW_RX / CF.VIEW.h) * 100) < 0.01, '圆角纵向与 SVG 的 rx 不符');
});

test('FRAME 引用的每个 url(#id) 都能在 DEFS 里找到（写错一个字母就整块变黑）', () => {
  const ids = new Set([...CF.DEFS.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  assert.ok(ids.size >= 12, `DEFS 里的 id 太少（${ids.size}），可能整段丢失`);
  const idsArr = [...ids];
  assert.strictEqual(idsArr.length, new Set(idsArr).size, 'DEFS 里有重复 id');
  const refs = [...CF.FRAME.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(refs.length >= 8, 'FRAME 里没有渐变引用？');
  for (const r of refs) assert.ok(ids.has(r), `FRAME 引用了未定义的 id: ${r}`);
  // use 引用的图形也必须在 DEFS 里
  const uses = [...CF.FRAME.matchAll(/<use[^>]*href="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(uses.length >= 8, 'FRAME 里没有 use 引用？');
  for (const u of uses) assert.ok(ids.has(u), `FRAME 的 use 引用了未定义的 id: ${u}`);
  // 徽记/铭牌/托角/铆钉四组装饰都要在
  for (const g of ['frCrest', 'frPlateOrn', 'frCorner', 'frStud']) {
    assert.ok(ids.has(g), `DEFS 缺少装饰图形 ${g}`);
    assert.ok(uses.includes(g), `FRAME 没有使用 ${g}`);
  }
  // xlink:href 也要写：老 WebView 里 href 可能不生效
  const useTags = CF.FRAME.match(/<use[^>]*>/g) || [];
  for (const t of useTags) {
    assert.match(t, /href="#/, `use 缺少 href: ${t.slice(0, 60)}`);
    assert.match(t, /xlink:href="#/, `use 缺少 xlink:href 兼容写法: ${t.slice(0, 60)}`);
  }
});

test('四条边 + 四个角块严丝合缝铺满框带（漏一条缝就透出插画）', () => {
  /** 把只含 M/L/H/V/Z 的路径解析成多边形（框体只用这几种命令） */
  const toPolys = (d) => {
    const toks = d.match(/[MLHVZmlhvz]|-?\d+(\.\d+)?/g) || [];
    const polys = [];
    let cur = [], x = 0, y = 0, sx = 0, sy = 0, cmd = 'M', i = 0;
    const num = () => Number(toks[i++]);
    while (i < toks.length) {
      if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
      const C = cmd.toUpperCase();
      const rel = cmd !== C;
      if (C === 'M') { if (cur.length) polys.push(cur); x = rel ? x + num() : num(); y = rel ? y + num() : num(); sx = x; sy = y; cur = [[x, y]]; cmd = rel ? 'l' : 'L'; }
      else if (C === 'L') { x = rel ? x + num() : num(); y = rel ? y + num() : num(); cur.push([x, y]); }
      else if (C === 'H') { x = rel ? x + num() : num(); cur.push([x, y]); }
      else if (C === 'V') { y = rel ? y + num() : num(); cur.push([x, y]); }
      else if (C === 'Z') { polys.push(cur); cur = []; x = sx; y = sy; }
    }
    if (cur.length) polys.push(cur);
    return polys;
  };
  const inPoly = (pt, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const quads = Object.values(CF.QUAD).map(toPolys);
  const outer = toPolys(CF.OUTER);
  const inner = toPolys(CF.INNER);
  let ring = 0, covered = 0, overflow = 0;
  const holes = [];
  for (let x = 0.1; x < CF.VIEW.w; x += 0.25) {
    for (let y = 0.1; y < CF.VIEW.h; y += 0.25) {
      const pt = [x, y];
      const isOut = outer.some((p) => inPoly(pt, p));
      const hit = quads.some((ps) => ps.some((p) => inPoly(pt, p)));
      if (!isOut) { if (hit) overflow++; continue; }
      if (inner.some((p) => inPoly(pt, p))) continue;  // 画窗：本来就该透出插画
      ring++;
      if (hit) covered++;
      else if (holes.length < 6) holes.push([+x.toFixed(2), +y.toFixed(2)]);
    }
  }
  assert.ok(ring > 50000, `采样点太少（${ring}），测试本身失效了`);
  assert.strictEqual(ring - covered, 0, `框带有 ${ring - covered} 个采样点没被任何边/角块覆盖，例如 ${JSON.stringify(holes)}`);
  assert.strictEqual(overflow, 0, `有 ${overflow} 个采样点画到了外轮廓之外`);
});

test('无 DOM 时也能加载：ensureDefs 静默跳过而不是抛错', () => {
  assert.strictEqual(typeof CF.html, 'function');
  assert.strictEqual(CF.ensureDefs(), false, '没有 document 时 ensureDefs 应返回 false');
  assert.match(CF.html(), /class="fr-svg"/, '无 DOM 时 html() 仍要返回标记字符串');
  assert.match(CF.DEFS, new RegExp(`id="${CF.DEFS_ID}"`), 'defs 容器 id 与 DEFS_ID 不一致');
  assert.match(CF.DEFS, /width="0"\s+height="0"/, 'defs 容器必须是 0 尺寸（不能 display:none，有些浏览器不解析其渐变）');
});

test('roleAttr：把角色 id 带到外层 div 上，且只放行安全字符', () => {
  assert.strictEqual(typeof CF.roleAttr, 'function');
  assert.strictEqual(CF.roleAttr('seer'), ' data-role="seer"');
  assert.strictEqual(CF.roleAttr(''), '', '没有角色时不该输出空属性');
  assert.strictEqual(CF.roleAttr(undefined), '');
  assert.strictEqual(CF.roleAttr('wo"lf>x'), ' data-role="wolfx"', '非法字符必须被剔除，不能破坏属性');
  for (const f of ['app.js', 'm/m.js']) {
    const src = read(f);
    assert.match(src, /window\.CardFrame\.roleAttr\(/, `${f} 应把角色 id 交给 CardFrame.roleAttr()`);
    assert.ok(!/data-role="\$\{/.test(src), `${f} 又自己拼 data-role 了（配色表靠这个属性命中）`);
  }
});

test('每个角色都有配色规则：阵营 = 狼红 / 神金 / 民绿，且染色层只改色相', () => {
  const css = read('style.css');
  // 引擎里的角色清单：从源码里读，避免测试自己维护一份会漂移的名单
  const roles = require(path.join(__dirname, '..', 'src', 'engine', 'roles.js')).ROLES;
  const ids = Object.keys(roles);
  assert.ok(ids.length >= 15, `角色数异常（${ids.length}）`);
  for (const id of ids) {
    assert.ok(css.includes(`.card-frame[data-role='${id}']`), `style.css 缺少 ${id} 的配色规则（会掉回默认金）`);
  }
  // 阵营色按需求定死：狼=红、神=金、民=绿
  const groupOf = (cat) => {
    const re = new RegExp(`\\.card-frame\\[data-role='([^']+)'\\][^{]*\\{[^}]*--fr-tint:\\s*(#[0-9a-f]{6})`, 'g');
    const map = {};
    let m;
    while ((m = re.exec(css))) map[m[1]] = m[2];
    return Object.entries(map).filter(([id]) => roles[id] && roles[id].category === cat).map(([, c]) => c);
  };
  const hues = (hex) => {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return { r, g, b };
  };
  const wolf = groupOf('wolf'), god = groupOf('god'), villager = groupOf('villager');
  assert.ok(wolf.length && wolf.every((c) => c === wolf[0]), `狼阵营染色不统一: ${wolf}`);
  assert.ok(god.length && god.every((c) => c === god[0]), `神阵营染色不统一: ${god}`);
  assert.ok(villager.length && villager.every((c) => c === villager[0]), `民阵营染色不统一: ${villager}`);
  const w = hues(wolf[0]), g = hues(god[0]), v = hues(villager[0]);
  assert.ok(w.r > w.g + 60 && w.r > w.b + 60, `狼阵营必须是红（偏暖红）: ${wolf[0]}`);
  assert.ok(g.r > 120 && g.g > 80 && g.b < g.g, `神阵营必须是金（红绿高、蓝低）: ${god[0]}`);
  assert.ok(v.g > v.r && v.g > v.b, `民阵营必须是绿: ${villager[0]}`);
  // 染色只改色相，且必须有降级
  assert.match(css, /\.card-frame\s+\.fr-tint\s*\{[^}]*mix-blend-mode:\s*hue/, '染色层必须用色相混合（平涂会把金属染成泥）');
  assert.match(css, /@supports\s+not\s+\(mix-blend-mode:\s*hue\)\s*\{[^}]*\.card-frame\s+\.fr-tint[^}]*opacity/, '缺少不支持混合模式时的降级');
  // FRAME 里两层染色层的 class 要对得上
  assert.match(CF.FRAME, /class="fr-tint-under"/, 'FRAME 缺少导轨之下的染色层');
  assert.ok(!/class="fr-tint-under"[^>]*opacity=/.test(CF.FRAME), '染色浓度应由 CSS 决定，不要写死在标记里');
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

test('小卡降级：<100px 隐藏整个细档，露出高对比的粗档', () => {
  const css = read('style.css');
  assert.match(css, /^\.card-frame\s*\{[^}]*container-type:\s*inline-size/m, '.card-frame 需要 container-type 才能按卡宽降级');
  const cq = css.match(/@container\s*\(max-width:\s*(\d+)px\)\s*\{\s*\.card-frame\s+\.fr-fine\s*\{\s*display:\s*none/);
  assert.ok(cq, '缺少"按容器宽度隐藏细档"的容器查询');
  const limit = Number(cq[1]);
  // 移动端坞内身份牌 52px、桌面侧栏 64px 必须落到粗档；图鉴/检视的 210/230/273px 必须是细档
  assert.ok(limit >= 64, `阈值 ${limit}px 太小：64px 的侧栏身份卡仍会用细档`);
  assert.ok(limit < 104, `阈值 ${limit}px 太大：104px 的卡已经看得清托角与徽记，不该降级`);
  // 粗档和细档都要有实际内容（不能空壳）
  assert.match(CF.FRAME, /class="fr-bold">[\s\S]*url\(#frBoldTop\)/, '粗档里没有框带填充');
  assert.match(CF.FRAME, /class="fr-fine">[\s\S]*url\(#frBandTop\)/, '细档里没有框带填充');
});
