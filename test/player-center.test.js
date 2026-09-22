/**
 * player-center.test.js — 手机「我的」独立页面 + 两端玩家中心的**结构守卫**（计划书 §5 行 169-176）
 *
 * 为什么这些断言值得存在：这一批的实质是把「我的」从"点一下弹个底部弹层"改成**独立页面**，
 * 并把"个人资料 / 对局与战绩 / 外观与操作 / 数据管理"四组固定下来。最容易悄悄退化的形态有五种，
 * 全都在这里钉住：
 *   ① 手机「我的」退回成"只开弹层"（页面删掉、或 `#m-tab-me` 改回 openSheet）→ 见「独立页面」「页签接线」；
 *   ② 四组的**顺序或组名**被改（搬一个 section、或调换 PC_GROUPS 的条目）→ 见「四组顺序」；
 *   ③ 四组只剩标题、内容是空壳（没有接真实容器的 id / 没有接真实接口）→ 见「各组接真实内容」；
 *   ④ 新增的顶栏入口 `#btn-player-center` 上的 `data-ww-icon="players"` 被删掉或写错（`players` 是**复用**
 *      手机端玩家页签已有的那枚 symbol，不新造图形）→ 见「players 徽记真的渲染成 <svg>」：把**真实页面上
 *      的那个元素**喂进真实 `mount()`。注意这一处是**新建的操作控件**（icons.js 判据 ①），
 *      不是把内容里的 `👤` 换掉 —— 手机「我的」页签、桌面档案标签/按钮上的 `👤` 全部**逐字保留**，
 *      由 `test/icons.test.js` 的 CONTENT_EMOJI_PINS / 地板与 `test/emoji-preserve.test.js` 钉住；
 *   ⑤ 外观与操作的控件做成"假开关"（只改 DOM、不落档案）→ 见「两组控件写同一份偏好」。
 *
 * 判据的写法纪律（与 test/emoji-preserve.test.js 一致）：
 *   · 只钉**可以失败**的东西，并且每条关键判据都带一个"改写输入即返回不同结果"的自检
 *     （把真实的 HTML / JS 改一改，同一个提取函数必须给出**不同**答案 —— 证明它不是恒真）；
 *   · 断言一律点名文件与字段，不做"整文件 includes 就算过"式宽判定。
 *
 * 本期**刻意不做**（计划书 §5 行 203：战绩要按口径分别展示，段位/排行榜/成就/趋势图不在本轮范围）：
 * 文件末尾那条"范围"用例把这一点钉住 —— 谁把段位/排行榜/成就/趋势图塞进玩家中心，当场判红。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const WWIcons = require('../web/shared/icons.js');

/** 计划书 §5 的四组（**顺序固定**，组名逐字取自该行；两端必须一致） */
const PLAN_GROUPS = [
  { id: 'profile', title: '个人资料' },
  { id: 'games', title: '对局与战绩' },
  { id: 'appearance', title: '外观与操作' },
  { id: 'data', title: '数据管理' },
];

// ---------------------------------------------------------------- 提取函数（都带自检）

/**
 * 手机端四组：按 `data-ww-group` 的**出现次序**切分。
 * 用 split 而不是逐段正则：每组的内容一直延伸到"下一个分组的开头"，因此组内有没有真实容器
 * 也能在同一份切片里查（顺序 + 内容归属一次拿到）。
 */
function mobileGroups(html) {
  const parts = html.split(/<section class="pc-group"[^>]*data-ww-group="/).slice(1);
  return parts.map((p) => {
    const q = p.indexOf('"');
    const body = p.slice(q + 1);
    const h3 = /<h3[^>]*>([^<]*)<\/h3>/.exec(body);
    return { id: p.slice(0, q), title: h3 ? h3[1].trim() : null, body };
  });
}

/** 桌面端四组：直接取 app.js 里那份唯一的 PC_GROUPS 字面量（渲染顺序由它决定） */
function desktopGroups(src) {
  const m = /const PC_GROUPS = \[([\s\S]*?)\n\];/.exec(src);
  if (!m) return null;
  return [...m[1].matchAll(/id:\s*'([^']+)'\s*,\s*title:\s*'([^']+)'/g)].map((x) => ({ id: x[1], title: x[2] }));
}

/** 从真实 HTML 里取出某个元素：标签名 + 属性表 + 起始标签原文 */
function elementById(html, id) {
  const re = new RegExp('<(button|a|span|section|label|input)\\b([^>]*\\bid="' + id + '"[^>]*)>', 'i');
  const m = re.exec(html);
  if (!m) return null;
  const attrs = {};
  for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  return { tag: m[1].toLowerCase(), attrs, open: m[0] };
}

/** 取某个"页签/按钮"的可见文字（`<button …>文字</button>` 里的文字） */
function buttonText(html, id) {
  const re = new RegExp('<button\\b[^>]*\\bid="' + id + '"[^>]*>([\\s\\S]*?)</button>');
  const m = re.exec(html);
  return m ? m[1].trim() : null;
}

/** 「我的」页签的点击接线目标（函数名）；抽不到返回 null */
function tabMeHandler(src) {
  const m = /\$\('#m-tab-me'\)\.addEventListener\('click',\s*([A-Za-z0-9_$]+)\s*\)/.exec(src);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- ① 手机「我的」是独立页面

test('手机端「我的」是**独立页面**：与 #m-boards/#m-codex/#m-rules/#m-game 同级的 section.m-screen', () => {
  const html = read('web/m/index.html');
  const screens = [...html.matchAll(/<section\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /\bclass="[^"]*\bm-screen\b/.test(tag))
    .map((tag) => (/\bid="([^"]+)"/.exec(tag) || [])[1]);
  for (const id of ['m-boards', 'm-codex', 'm-rules', 'm-game', 'm-player']) {
    assert.ok(screens.includes(id), `#${id} 不再是 section.m-screen 之一（实际：${screens.join('、')}）`);
  }
  // 顺序：玩家中心紧跟在图鉴之后（规则确认之前），并且与图鉴同为"从首页推开的一屏"
  assert.deepStrictEqual(
    screens, ['m-boards', 'm-codex', 'm-player', 'm-rules', 'm-game'],
    `五屏的顺序变了（会把"返回"和 showScreen 的语义一起带偏）：${screens.join(' → ')}`
  );
  const el = elementById(html, 'm-player');
  assert.ok(el && el.tag === 'section', '#m-player 不是一个 <section>（独立页面不能退回 <div> 或弹层）');
  assert.strictEqual(el.attrs.class, 'm-screen hidden', '#m-player 的 class 应恰好是「m-screen hidden」（初始隐藏，由 showScreen 打开）');

  // showScreen 的显隐清单里必须有它 —— 否则 openPlayerCenter 打开后其余屏不会关掉
  const mjs = read('web/m/m.js');
  const list = /\[([^\]]*'m-boards'[^\]]*)\]\.forEach\(\(s\) => \$\('#' \+ s\)\.classList\.toggle\('hidden', s !== id\)\)/.exec(mjs);
  assert.ok(list, 'm.js 的 showScreen 显隐清单写法变了，这条守卫需要同步');
  const ids = [...list[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.deepStrictEqual(ids, ['m-boards', 'm-codex', 'm-player', 'm-rules', 'm-game'],
    `showScreen 的屏清单与页面里的五屏不一致：${ids.join(' → ')}`);
});

test('「我的」页签：点它是进独立页面（退回"只开弹层"即判红）', () => {
  const html = read('web/m/index.html');
  const mjs = read('web/m/m.js');

  assert.strictEqual(tabMeHandler(mjs), 'openPlayerCenter',
    `#m-tab-me 的 click 没有接到 openPlayerCenter（实际 ${JSON.stringify(tabMeHandler(mjs))}）—— 一旦改回 openSheet(...) 就是"退回成弹层"`);
  const body = /function openPlayerCenter\(\) \{([\s\S]*?)\n\}/.exec(mjs);
  assert.ok(body, 'm.js 里找不到 openPlayerCenter()');
  assert.ok(/showScreen\('m-player'\)/.test(body[1]), 'openPlayerCenter() 没有切到独立的 m-player 屏');
  assert.ok(/trackOverlay\('screen-player'/.test(body[1]), 'openPlayerCenter() 没有进返回栈（安卓返回键会直接退出应用）');
  assert.ok(/function closePlayerCenterDom\(\)/.test(mjs), '缺少 closePlayerCenterDom()（返回栈要用）');

  // 页签文字保持 HEAD 原样（`👤 我的`）：这处 👤 是「内容里的正常 emoji」，test/icons.test.js 的
  // CONTENT_EMOJI_PINS 逐条钉着它，不许换算成徽记。本用例只钉"点了进独立页面"这件事。
  assert.strictEqual(buttonText(html, 'm-tab-me'), '👤 我的',
    `#m-tab-me 的可见文字应保持 HEAD 原样，实际 ${JSON.stringify(buttonText(html, 'm-tab-me'))}`);
  const tabMe = elementById(html, 'm-tab-me');
  assert.ok(tabMe && !('data-ww-icon' in tabMe.attrs),
    '#m-tab-me 挂上了 data-ww-icon：既会踩 test/icons.test.js 的"内容 emoji 必须还在"，也会变成徽记+emoji 两份图标');

  // 自检：同一个提取函数在"退回弹层"的源码上必须给出**别的**答案（证明这条判据真的能红）
  const reverted = mjs.replace(
    "$('#m-tab-me').addEventListener('click', openPlayerCenter);",
    "$('#m-tab-me').addEventListener('click', () => { openSheet('👤 我的档案', document.createElement('div'), null); });"
  );
  assert.notStrictEqual(reverted, mjs, '自检失效：没能把源码改写成"只开弹层"的样子');
  assert.notStrictEqual(tabMeHandler(reverted), 'openPlayerCenter', '自检失效：改回弹层后判据居然还是通过');
});

// ---------------------------------------------------------------- ② 四组顺序与组名

test('四组：顺序与组名按计划书 §5 固定，且两端一致（打乱即判红）', () => {
  const html = read('web/m/index.html');
  const app = read('web/app.js');

  const mg = mobileGroups(html).map(({ id, title }) => ({ id, title }));
  assert.deepStrictEqual(mg, PLAN_GROUPS, `手机端四组不是「个人资料 / 对局与战绩 / 外观与操作 / 数据管理」这个顺序与文案：${JSON.stringify(mg)}`);

  const dg = desktopGroups(app);
  assert.deepStrictEqual(dg, PLAN_GROUPS, `桌面端 PC_GROUPS 与手机端不同构：${JSON.stringify(dg)}`);

  // 桌面端的 DOM 顺序**由 PC_GROUPS 决定**（section 在遍历里创建并 append，没有第二处排序）
  assert.ok(/for \(const g of PC_GROUPS\) \{/.test(app), 'openPlayerCenter 没有按 PC_GROUPS 遍历建组');
  assert.ok(
    /for \(const g of PC_GROUPS\) \{[\s\S]{0,500}?body\.appendChild\(sec\)/.test(app),
    '分组 section 不是在同一个循环里按 PC_GROUPS 顺序挂上去的（顺序可能被别处改写）'
  );

  // 自检①：手机端把前两组的 data-ww-group 对调 ⇒ 提取结果必须变
  const swapped = html
    .replace('data-ww-group="profile"', 'data-ww-group="TMP"')
    .replace('data-ww-group="games"', 'data-ww-group="profile"')
    .replace('data-ww-group="TMP"', 'data-ww-group="games"');
  assert.notStrictEqual(swapped, html, '自检失效：没能对调手机端的分组标记');
  assert.notDeepStrictEqual(mobileGroups(swapped).map((g) => g.id), PLAN_GROUPS.map((g) => g.id),
    '自检失效：分组顺序被打乱后判据居然还是通过');

  // 自检②：桌面端把 PC_GROUPS 的前两条对调 ⇒ 提取结果必须变
  const dSwapped = app.replace(
    "  { id: 'profile', title: '个人资料' },\n  { id: 'games', title: '对局与战绩' },",
    "  { id: 'games', title: '对局与战绩' },\n  { id: 'profile', title: '个人资料' },"
  );
  assert.notStrictEqual(dSwapped, app, '自检失效：没能对调 PC_GROUPS 的前两条');
  assert.notDeepStrictEqual(desktopGroups(dSwapped), PLAN_GROUPS, '自检失效：PC_GROUPS 被打乱后判据居然还是通过');
});

test('四组接的是**真实内容容器**（不是四个只有标题的空壳）', () => {
  const html = read('web/m/index.html');
  const groups = mobileGroups(html);
  assert.strictEqual(groups.length, 4, `手机端分组数量应为 4，实际 ${groups.length}`);
  const anchors = {
    profile: ['id="m-pc-profile"'],
    games: ['id="m-pc-games"'],
    appearance: ['id="m-pc-pref-font"', 'id="m-pc-pref-layout"', 'id="m-pc-pref-motion"'],
    data: ['id="m-pc-data"'],
  };
  const missing = [];
  for (const g of groups) {
    for (const a of anchors[g.id] || []) {
      if (!g.body.includes(a)) missing.push(`${g.id} 组里找不到 ${a}`);
    }
  }
  assert.deepStrictEqual(missing, [], `四组的内容容器与分组对不上（顺序/归属被改动过）：\n${missing.join('\n')}`);

  // 桌面端：四组各自有填充函数，且各自填进自己的盒子
  const app = read('web/app.js');
  for (const call of [
    "fillPcProfile(boxes.get('profile'), usableCount);",
    "fillPcGames(boxes.get('games'), { stats, un, fin });",
    "fillPcAppearance(boxes.get('appearance'));",
    "fillPcData(boxes.get('data'), { trash, rec });",
  ]) {
    assert.ok(app.includes(call), `openPlayerCenter 里缺少组内容填充：${call}`);
  }
});

test('对局与战绩 / 数据管理接的是**真实接口**（无示例数据、无空壳按钮）', () => {
  const app = read('web/app.js');
  const mjs = read('web/m/m.js');
  const blockOf = (src, re) => {
    const m = re.exec(src);
    return m ? m[0] : null;
  };
  // 数据在 openPlayerCenter 里**先取好**（先取数再一次画完：打开后再长高会让④组按钮在点击前后位移），
  // 所以接口串钉在 openPlayerCenter 上；fillPcGames 只负责把取回来的东西画出来。
  const open = blockOf(app, /async function openPlayerCenter\(\)[\s\S]*?\n\}/);
  assert.ok(open, 'app.js 里找不到 openPlayerCenter()');
  for (const needle of ['/stats', 'status=unfinished&limit=5', 'status=finished&limit=5']) {
    assert.ok(open.includes(needle), `桌面端②组没有接 ${needle}（对局与战绩会变成空壳）`);
  }
  assert.ok(open.includes("pcFetch('/api/profiles/trash')"), '桌面端没有接回收站计数接口');
  assert.ok(open.includes("pcFetch('/api/import/recoveries')"), '桌面端没有接待清理恢复记录接口');
  // M2-d §5.2：保护从"只比档案 id"升级为**代次票据**（request-guard，A→B→A 绕一圈也能作废，
  // 只比 id 挡不住这一类）。判据仍是"落笔前必须再判一次"，两种写法任一存在即算通过 ——
  // 两种都没有（也就是把保护整个删掉）照样判红。
  assert.ok(/Promise\.all\(\[/.test(open)
    && (/state\.profileId !== pid/.test(open) || /getRequestGuard\(\)\.isCurrent\(ticket\)/.test(open)),
    'openPlayerCenter 没有并行取数 / 没有"取数期间切档就整份作废"的保护');

  const games = blockOf(app, /function fillPcGames\(box, res\)[\s\S]*?\n\}/);
  assert.ok(games, 'app.js 里找不到 fillPcGames(box, res)');
  assert.ok(/R\.stats\.ok/.test(games) && /statsLine\(R\.stats\.data\)/.test(games),
    '桌面端②组的统计概览不是画接口回来的数据（可能写死了示例数字）');
  assert.ok(/R\.un\.ok/.test(games) && /R\.fin\.ok/.test(games), '桌面端②组的进行中/最近完成没有各自判成败');
  assert.ok(!/加载中/.test(games), '桌面端②组又变成"先画加载中再异步填"——弹层打开后会继续长高，④组按钮会位移');

  assert.ok(/\/api\/profiles\/\$\{pid\}\/games\/\$\{encodeURIComponent\(gameId\)\}\/history\?limit=100/.test(app),
    '桌面端没有接只读历史接口（已结束对局没有"历史"可看）');
  assert.ok(app.includes('/api/profiles/${cur.id}/export'), '桌面端没有接导出接口');
  assert.ok(app.includes("id = 'pm-trash-entry'"), '回收站入口 id（#pm-trash-entry）丢了 —— scripts/ui-check.js 的整段回收区真路会断');

  const mg = blockOf(mjs, /async function renderPcGames\(\)[\s\S]*?\n\}/);
  assert.ok(mg, 'm.js 里找不到 renderPcGames()');
  for (const needle of ['/stats', 'status=unfinished&limit=5', 'status=finished&limit=5']) {
    assert.ok(mg.includes(needle), `手机端②组没有接 ${needle}`);
  }
  assert.ok(/const pid = state\.profileId;/.test(mg), '手机端②组没有记下发起请求时的档案 id');
  assert.ok(/state\.profileId === pid/.test(mg) || /state\.profileId !== pid/.test(mg),
    '手机端②组没有"切档后丢弃迟到响应"的保护（会把上一档案的战绩画到新档案下）');
});

// ---------------------------------------------------------------- ③ 桌面入口 + players 徽记

test('桌面：首页 hero、设备与数据卡、局中顶栏三个入口都进**同一个**玩家中心', () => {
  const app = read('web/app.js');
  const html = read('web/index.html');

  for (const sel of ['#btn-profiles-entry', '#btn-device-profiles', '#btn-player-center']) {
    const re = new RegExp("\\$\\('" + sel + "'\\)[\\s\\S]{0,120}?addEventListener\\('click', openPlayerCenter\\)");
    assert.ok(re.test(app), `${sel} 没有接到 openPlayerCenter()`);
  }
  assert.ok(/function openProfileManager\(\) \{ openPlayerCenter\(\); \}/.test(app),
    '旧名 openProfileManager 必须保留为别名（回收区/编辑页的"返回列表"路径都走它）');

  const btn = elementById(html, 'btn-player-center');
  assert.ok(btn, '桌面顶栏缺少 #btn-player-center');
  assert.strictEqual(btn.attrs['data-ww-icon'], 'players', '#btn-player-center 的徽记不是共享的 players');
  assert.ok(/aria-label="[^"]+"/.test(btn.open), '顶栏图标按钮缺 aria-label（只有一枚徽记、没有可读名字）');
  // 顶栏按钮必须落在 .top-actions 里（与笔记/设置同一排），而不是页脚或别处
  const top = /<div class="top-actions">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(top && top[1].includes('id="btn-player-center"'), '#btn-player-center 不在顶栏 .top-actions 里');
});

test('players 徽记真的渲染成 <svg>：真实页面元素 + 真实 mount()（属性被删/写错就画不出来）', () => {
  // 取的是 M2-c **新增**的顶栏入口（icons.js 判据 ①：可点击导航/操作控件）。
  // 它不带任何 👤 字形，所以既不碰 test/icons.test.js 的 CONTENT_EMOJI_PINS，也不用下调任何地板。
  const html = read('web/index.html');
  const btnHtml = elementById(html, 'btn-player-center');
  assert.ok(btnHtml, '桌面顶栏缺少 #btn-player-center（玩家中心的第三个入口）');
  assert.strictEqual(btnHtml.attrs['data-ww-icon'], 'players',
    `#btn-player-center 的 data-ww-icon 不是 players（实际 ${JSON.stringify(btnHtml.attrs['data-ww-icon'])}）—— 徽记画不出来`);

  const { doc, Node } = microDom();
  const btn = new Node('button');
  for (const [k, v] of Object.entries(btnHtml.attrs)) btn.setAttribute(k, v);
  btn.textContent = '';
  doc.body.appendChild(btn);

  assert.strictEqual(WWIcons.mount(doc.body, doc), 1, 'mount() 没有把带标记的元素画成徽记');
  const svg = btn.querySelector('svg.ww-icon');
  assert.ok(svg, '元素里没有出现 <svg class="ww-icon">（"图上有没有图标"这件事只能这样证明）');
  const use = svg.firstElementChild;
  assert.strictEqual(use && use.getAttribute('href'), '#wwIcPlayers',
    `<svg> 引用的不是共享 symbol #wwIcPlayers（实际 ${use && use.getAttribute('href')}）`);

  // 反向一：**同一个元素去掉标记**（等于有人把这次的接线撤了）⇒ 一个徽记都画不出来
  const bare = new Node('button');
  bare.textContent = '玩家中心';
  doc.body.appendChild(bare);
  assert.strictEqual(WWIcons.mount(bare, doc), 0, '没有标记的元素竟然也画出了徽记 —— 这条判据失效了');

  // 反向二：标记写成**不存在的名字**（拼错 id 的典型事故）⇒ 同样画不出来，而不是画出别的图标
  const bogus = new Node('button');
  bogus.setAttribute('data-ww-icon', 'playerz');
  doc.body.appendChild(bogus);
  assert.strictEqual(WWIcons.mount(bogus, doc), 0, '写错的 data-ww-icon 竟然也画出了徽记 —— 判据失效');
});

/** 极简假 DOM：只实现 icons.js 的 mount/ensureDefs 用到的那几个接口（够证明"渲染成了 <svg>"） */
function microDom() {
  const doc = {};
  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.attrs = {}; this.childNodes = []; this._text = ''; this.ownerDocument = doc;
    }
    get firstChild() { return this.childNodes[0] || null; }
    get firstElementChild() { return this.childNodes.find((c) => c.tagName) || null; }
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
    setAttribute(n, v) { this.attrs[n] = String(v); }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); this.childNodes = this.childNodes.filter((c) => !c.tagName); }
    appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
    removeChild(c) { this.childNodes = this.childNodes.filter((x) => x !== c); return c; }
    insertBefore(c) { c.parentNode = this; this.childNodes.unshift(c); return c; }
    /** 只认 mountNode 的 `afterbegin` + iconMarkup 的 <svg class="ww-icon"><use href=…> 形状 */
    insertAdjacentHTML(pos, html) {
      if (pos !== 'afterbegin') return;
      const cls = /<svg[^>]*class="([^"]+)"/.exec(html);
      if (!cls) return;
      const svg = new Node('svg');
      svg.setAttribute('class', cls[1]);
      const href = /<use[^>]*\shref="([^"]+)"/.exec(html);
      if (href) { const u = new Node('use'); u.setAttribute('href', href[1]); svg.appendChild(u); }
      this.childNodes.unshift(svg);
    }
    set innerHTML(html) {
      this.childNodes = [];
      const id = /<svg[^>]*id="([^"]+)"/.exec(html);
      if (id) { const s = new Node('svg'); s.setAttribute('id', id[1]); this.appendChild(s); }
    }
    get innerHTML() { return ''; }
    _all(out = []) { for (const c of this.childNodes) if (c.tagName) { out.push(c); c._all(out); } return out; }
    querySelector(sel) {
      const m = /^svg\.([\w-]+)$/.exec(sel);
      if (!m) return null;
      return this._all().find((c) => c.tagName === 'SVG' && (c.getAttribute('class') || '').split(/\s+/).includes(m[1])) || null;
    }
    querySelectorAll(sel) {
      const m = /^\[([^\]]+)\]$/.exec(sel);
      return m ? this._all().filter((c) => c.getAttribute(m[1]) != null) : [];
    }
  }
  doc.createElement = (t) => new Node(t);
  doc.body = new Node('body');
  doc.getElementById = (id) => doc.body._all().find((c) => c.getAttribute('id') === id) || null;
  return { doc, Node };
}

// ---------------------------------------------------------------- ④ 外观与操作不是假开关

test('外观与操作：两端都写**同一份**档案偏好（不是只改 DOM 的假开关）', () => {
  const mjs = read('web/m/m.js');
  const app = read('web/app.js');

  // 手机端：静态控件的 id 与设置弹层那组"成对回显"，改了要落档案（saveProfilePrefs）
  assert.ok(/const PREF_CONTROL_PAIRS = \[\['#m-pref-font', '#m-pc-pref-font'\]/.test(mjs),
    'm.js 的 PREF_CONTROL_PAIRS 没有把玩家中心那组控件和设置弹层那组配对（回显会各写一半）');
  assert.ok(/#m-pc-pref-motion'\]/.test(mjs), 'm.js 的 PREF_CONTROL_PAIRS 缺 motion');
  assert.ok(/function onPcPrefControlChange\(\)[\s\S]{0,240}?commitPrefsFromControls\(/.test(mjs),
    '手机端玩家中心的控件没有走 commitPrefsFromControls（改完不落档案）');
  assert.ok(/function commitPrefsFromControls\(f, l, m\)[\s\S]{0,400}?saveProfilePrefs\(prefs\)/.test(mjs),
    'commitPrefsFromControls 没有调用 saveProfilePrefs');
  assert.ok(/for \(const id of \['#m-pc-pref-font', '#m-pc-pref-layout', '#m-pc-pref-motion'\]\)/.test(mjs),
    'wirePlayerCenter 没有给玩家中心那三个控件绑 change');
  assert.ok(/wirePlayerCenter\(\);/.test(mjs), 'init() 里没有调用 wirePlayerCenter()（控件会点了没反应）');

  // 桌面端：同一套结构（#pc-pref-* ↔ #pref-*）
  assert.ok(/const PREF_CONTROL_PAIRS = \[\['#pref-font', '#pc-pref-font'\]/.test(app),
    'app.js 的 PREF_CONTROL_PAIRS 没有把玩家中心那组控件和开局设置页那组配对');
  assert.ok(/function onPcPrefControlChange\(\)[\s\S]{0,240}?commitPrefsFromControls\(/.test(app),
    '桌面端玩家中心的控件没有走 commitPrefsFromControls');
  assert.ok(/for \(const id of fontIds\)/.test(app) && /for \(const id of motionIds\)/.test(app),
    'applyProfilePrefs 没有回显两组控件（同一份偏好在两个入口会显示不同值）');
  assert.ok(/'pc-pref-font'/.test(app) && /'pc-pref-layout'/.test(app) && /'pc-pref-motion'/.test(app),
    '桌面端玩家中心缺少外观与操作控件');
});

// ---------------------------------------------------------------- ⑤ 本轮范围

test('范围：本期玩家中心不含段位/排行榜/成就/趋势图（§5 行 203：留到以后）', () => {
  const hits = [];
  for (const rel of ['web/app.js', 'web/m/m.js', 'web/index.html', 'web/m/index.html']) {
    read(rel).split(/\r?\n/).forEach((line, i) => {
      if (/段位|排行榜|成就|趋势图/.test(line)) hits.push(`${rel}:${i + 1} ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepStrictEqual(hits, [],
    `本轮不做的功能被塞进了玩家中心（§5 行 203 把战绩口径/段位一类留到后续批次）：\n${hits.join('\n')}`);
});
