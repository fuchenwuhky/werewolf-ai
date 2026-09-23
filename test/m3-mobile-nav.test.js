/**
 * m3-mobile-nav.test.js — 手机端 M3 第一批（C1b）导航结构守卫
 *
 * 本批做的四件事，每一件都有一种"不会报错、只会变得点不到"的退化形态，全钉在这里：
 *   ① 「对局」升级为**独立页** `#m-games`（原来点底栏「对局」只是弹一个底部弹层）——
 *      退化成"又只弹弹层"或"屏被删了"即判红；
 *   ② 四个主入口各自指向**独立屏**：开始→m-boards / 对局→m-games / 资料→m-codex / 我的→m-player。
 *      这是 FIN-04 §8.1「至多四个主入口」的语义本身：入口点下去必须换屏，不能空转（原来的
 *      `#m-tab-start` 只把首页滚回顶部，等于点了个寂寞）；
 *   ③ 底栏 `#m-tabbar` 原来**物理上长在 `#m-boards` 内部**，于是切到别的屏时整条底栏随父一起
 *      被 `display:none` —— 用户在"资料/我的"页上根本看不到也不能用主入口。本批把它移到所有屏
 *      之外（`#m-app` 的直接子元素），四屏共用；进 m-rules（向导第 2 步）/ m-game（局内有自己的
 *      顶栏与页签）时隐藏；
 *   ④ 新草稿默认**试玩**（计划书 §8.2）：`state.mock` 原来在 state 字面量里**没有初值**（undefined），
 *      于是 `syncMockBtn()` 把「真实对局」卡置为选中，与静态 HTML 的 `sel/aria-checked="true"` 相反 ——
 *      运行期默认落到了"会花钱"的那一侧。
 *
 * 判据纪律（与 test/player-center.test.js 一致）：只钉**可以失败**的东西，关键判据带一个
 * "改写输入即返回不同结果"的自检；断言一律点名 id / 选择器，不用 pm-row 顺序、按钮下标这类脆弱判据。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------- 提取函数（都带自检）

/** 页面里的全部 `section.m-screen`（按 DOM 次序） */
function screenIds(html) {
  return [...html.matchAll(/<section\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /\bclass="[^"]*\bm-screen\b/.test(tag))
    .map((tag) => (/\bid="([^"]+)"/.exec(tag) || [])[1]);
}

/** 从真实 HTML 里取出某个元素：标签名 + 属性表（`nav` 也算，见下） */
function elementById(html, id) {
  const re = new RegExp('<([a-z][a-z0-9]*)\\b([^>]*\\bid="' + id + '"[^>]*)>', 'i');
  const m = re.exec(html);
  if (!m) return null;
  const attrs = {};
  for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  return { tag: m[1].toLowerCase(), attrs, open: m[0] };
}

/** 某个页签按钮的 click 接线：归一成"被调用的那个函数名"，或（内联箭头）箭头体原文；抽不到返回 null。
 *  `fn` 与 `() => fn()` 是等价写法（仓库里两种都在用），所以先剥一层无参箭头再判断。 */
function tabHandler(src, id) {
  const re = new RegExp("\\$\\('#" + id + "'\\)\\.addEventListener\\('click',\\s*([^;]+?)\\s*\\);");
  const m = re.exec(src);
  if (!m) return null;
  const expr = m[1];
  const wrapped = /^\(\s*\)\s*=>\s*([A-Za-z0-9_$]+)\(\s*\)$/.exec(expr);
  return wrapped ? wrapped[1] : expr;
}

/** 取某个函数的函数体（到下一个顶格 `}` 为止） */
function fnBody(src, name) {
  const m = new RegExp('function ' + name + '\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}').exec(src);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- ① 「对局」是独立页

test('手机端「对局」是**独立页面**：与其余屏同级的 section.m-screen，且 showScreen 认它', () => {
  const html = read('web/m/index.html');
  const mjs = read('web/m/m.js');

  const screens = screenIds(html);
  assert.ok(screens.includes('m-games'), `#m-games 不是 section.m-screen 之一（实际：${screens.join('、')}）`);
  const el = elementById(html, 'm-games');
  assert.ok(el && el.tag === 'section', '#m-games 不是一个 <section>（独立页不能退回 div 或弹层）');
  assert.strictEqual(el.attrs.class, 'm-screen hidden', '#m-games 的 class 应恰好是「m-screen hidden」（初始隐藏，由 showScreen 打开）');

  // 屏内必须有列表容器与返回键（否则页面打开是空白，也退不回来）
  const from = html.indexOf('id="m-games"');
  const body = html.slice(from, html.indexOf('</section>', from));
  assert.ok(/id="m-games-list"/.test(body), '#m-games 里缺少列表容器 #m-games-list');
  assert.ok(/id="m-games-back"/.test(body), '#m-games 里缺少返回键 #m-games-back');
  assert.ok(/#m-games-list/.test(mjs), 'm.js 从未引用 #m-games-list（页面会永远是空的）');
  assert.ok(/#m-games-back/.test(mjs), 'm.js 从未引用 #m-games-back（返回键是个死按钮）');

  // showScreen 的显隐清单：**恰好**与页面上的屏一致（多/少一个都会让某屏关不掉或打不开）
  const list = /\[([^\]]*'m-boards'[^\]]*)\]\.forEach\(\(s\) => \$\('#' \+ s\)\.classList\.toggle\('hidden', s !== id\)\)/.exec(mjs);
  assert.ok(list, 'm.js 的 showScreen 显隐清单写法变了，这条守卫需要同步');
  const ids = [...list[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.deepStrictEqual(ids.slice().sort(), screens.slice().sort(),
    `showScreen 的屏清单与页面里的 section.m-screen 不一致：${ids.join(' → ')} vs ${screens.join(' → ')}`);
  assert.ok(ids.includes('m-games'), 'showScreen 的显隐清单里没有 m-games');

  // 打开它的函数真的切屏 + 进返回栈（安卓返回键不会直接退出应用）
  const open = fnBody(mjs, 'openMyGamesPage');
  assert.ok(open, 'm.js 缺少 openMyGamesPage()');
  assert.match(open, /showScreen\('m-games'\)/, 'openMyGamesPage() 没有切到独立的 m-games 屏');
  assert.match(open, /trackOverlay\('screen-games'/, 'openMyGamesPage() 没有进返回栈');
  assert.match(open, /#m-games-list/, 'openMyGamesPage() 没有把列表渲染进 #m-games-list');
  assert.ok(/function closeMyGamesDom\(\)/.test(mjs), '缺少 closeMyGamesDom()（返回栈要用）');
  // 返回语义与 #m-player-next 同款：回到"进来之前那一屏"
  assert.match(mjs, /function closeMyGamesDom\(\) \{ showScreen\(state\.gamesFrom \|\| 'm-boards'\); \}/,
    'closeMyGamesDom() 应回到 state.gamesFrom（与 closePlayerCenterDom 同一套做法）');
  // 返回栈里的死条目要被认出来（否则按一次返回会被"已经离开的那一屏"空吃掉一按）
  assert.match(mjs, /if \(kind === 'screen-games'\) return !\$\('#m-games'\)\.classList\.contains\('hidden'\);/,
    "overlayAlive 缺少 screen-games 分支：离开某屏后它的栈条目会被当成'还活着'，白吃一次返回");
});

test('「对局」的行构建只有一份：独立页与弹层复用同一个函数（防两处各写一遍）', () => {
  const mjs = read('web/m/m.js');
  // 空态文案是"同一份数据两处渲染"的指纹：它只该出现在共用函数里
  const emptyText = '当前档案还没有对局。回「开始」页开一局吧。';
  const hits = mjs.split(emptyText).length - 1;
  assert.strictEqual(hits, 1, `空态文案应只出现 1 次（共用行构建），实际 ${hits} 次 —— 重复渲染又长回来了`);

  const build = fnBody(mjs, 'buildMyGamesRows');
  assert.ok(build, 'm.js 缺少共用的行构建函数 buildMyGamesRows()');
  assert.ok(build.includes(emptyText), '空态文案应写在共用行构建函数里');
  // 两处渲染都必须复用同一份（而不是各自拼一遍）
  assert.match(fnBody(mjs, 'openMyGamesPage') || '', /buildMyGamesRows\(/, 'openMyGamesPage() 没有复用 buildMyGamesRows()');
  assert.match(fnBody(mjs, 'showMyGamesSheet') || '', /buildMyGamesRows\(/, 'showMyGamesSheet() 没有复用 buildMyGamesRows()');
  // 自检：把共用调用换回"自己拼一遍"，判据必须给不同答案
  const reverted = mjs.replace('buildMyGamesRows(rows, body);', 'for (const r of rows) body.appendChild(el(\'div\', \'pm-row\'));');
  assert.notStrictEqual(reverted, mjs, '自检失效：没能把复用改写成自己拼');
  assert.ok(!/buildMyGamesRows\(rows, body\);/.test(reverted), '自检失效：改写后判据居然还是通过');
});

// ---------------------------------------------------------------- ② 四个主入口各指一屏

test('四个主入口：开始→m-boards / 对局→m-games / 资料→m-codex / 我的→m-player', () => {
  const mjs = read('web/m/m.js');

  // 每个入口的接线 → 它最终切到哪一屏（函数体里的 showScreen('m-xxx')）
  const wiring = (id, fn) => {
    const h = tabHandler(mjs, id);
    assert.ok(h, `m.js 里找不到 #${id} 的 click 接线`);
    if (fn) {
      assert.strictEqual(h, fn, `#${id} 的 click 应指向 ${fn}()（实际 ${JSON.stringify(h)}）`);
      const b = fnBody(mjs, fn);
      assert.ok(b, `m.js 里找不到 function ${fn}()`);
      return b;
    }
    return h;
  };

  const start = wiring('m-tab-start', null);
  assert.match(start, /showScreen\('m-boards'\)/,
    `#m-tab-start 必须真的切回首页（原来只 .m-home-scroll 滚回顶部 = 空转）：${JSON.stringify(start)}`);

  wiring('m-tab-game', 'openMyGamesPage');            // 函数体里已断言 showScreen('m-games')
  wiring('m-tab-codex', 'openCodex');
  assert.match(fnBody(mjs, 'openCodex'), /showScreen\('m-codex'\)/, 'openCodex() 没有切到 m-codex');
  wiring('m-tab-me', 'openPlayerCenter');
  assert.match(fnBody(mjs, 'openPlayerCenter'), /showScreen\('m-player'\)/, 'openPlayerCenter() 没有切到 m-player');

  // 自检：把"真导航"退化成"只滚顶"，判据必须变红
  const reverted = mjs.replace(
    "$('#m-tab-start').addEventListener('click', () => showScreen('m-boards'));",
    "$('#m-tab-start').addEventListener('click', () => { $('.m-home-scroll') && $('.m-home-scroll').scrollTo({ top: 0 }); });"
  );
  assert.notStrictEqual(reverted, mjs, '自检失效：没能把 start 页签改写成"只滚顶部"');
  assert.ok(!/showScreen\('m-boards'\)/.test(tabHandler(reverted, 'm-tab-start') || ''),
    '自检失效：改回空转后判据居然还是通过');
});

// ---------------------------------------------------------------- ③ 底栏常驻于四个主入口页

test('底栏 #m-tabbar 不在 #m-boards 内部：四屏共用，切屏同步显隐与选中态', () => {
  const html = read('web/m/index.html');
  const mjs = read('web/m/m.js');
  const mcss = read('web/m/m.css');

  const boardsFrom = html.indexOf('id="m-boards"');
  const boardsTo = html.indexOf('</section>', boardsFrom); // #m-boards 内没有嵌套 section
  const tabAt = html.indexOf('id="m-tabbar"');
  assert.ok(boardsFrom >= 0 && boardsTo > boardsFrom && tabAt > boardsTo,
    `#m-tabbar 仍在 #m-boards 内部（${tabAt} < ${boardsTo}）—— 切到别的屏时整条底栏会随父一起隐藏`);
  // 必须落在全部屏之后 = #m-app 的直接子元素（否则 flex 列里会被排到可见屏的上方）
  assert.ok(tabAt > html.lastIndexOf('</section>'),
    '#m-tabbar 应在全部 section.m-screen 之后（#m-app 的直接子元素），否则不落在屏幕底部');

  const bar = elementById(html, 'm-tabbar');
  assert.ok(bar && bar.tag === 'nav', '#m-tabbar 应是一个 <nav>');
  assert.match(mcss, /\.m-tabbar \{[\s\S]*?flex:\s*none/,
    '.m-tabbar 必须 flex:none —— 它是 #m-app 这个 flex 列里"吃掉剩余高度的那一屏之下"的固定条');

  // 切屏处同步：选中态 + 显隐（进入 m-rules / m-game 时隐藏）
  const sync = fnBody(mjs, 'syncTabbar');
  assert.ok(sync, 'm.js 缺少 syncTabbar(id)：底栏的显隐/选中态没人随切屏更新');
  assert.match(sync, /classList\.toggle\('hidden'/, 'syncTabbar() 没有随切屏显隐底栏');
  assert.match(sync, /classList\.toggle\('active'/, 'syncTabbar() 没有随切屏同步选中态');
  assert.match(fnBody(mjs, 'showScreen') || '', /syncTabbar\(id\)/, 'showScreen() 没有调用 syncTabbar(id)');

  // 四个主入口屏 ↔ 四个页签按钮的一一映射（这就是"至多四个主入口"的结构事实）
  const map = /const TAB_OF_SCREEN = \{([\s\S]*?)\};/.exec(mjs);
  assert.ok(map, 'm.js 缺少 TAB_OF_SCREEN 映射表');
  assert.deepStrictEqual([...map[1].matchAll(/'([^']+)':\s*'([^']+)'/g)].map((x) => [x[1], x[2]]), [
    ['m-boards', 'm-tab-start'], ['m-games', 'm-tab-game'], ['m-codex', 'm-tab-codex'], ['m-player', 'm-tab-me'],
  ], '四个主入口屏与四个页签按钮的对应关系变了');
  // 只有这四屏显示底栏：m-rules / m-game 不在映射里
  assert.ok(!/'m-rules'/.test(map[1]) && !/'m-game'/.test(map[1]),
    'm-rules / m-game 不应出现在 TAB_OF_SCREEN 里（局内与向导第 2 步要隐藏主入口底栏）');
});

// ---------------------------------------------------------------- ④ 新草稿默认试玩（§8.2）

test('新草稿默认试玩（计划书 §8.2）：state.mock 初值与静态 HTML 一致，syncMockBtn 不会翻成真实', () => {
  const html = read('web/m/index.html');
  const mjs = read('web/m/m.js');

  // 静态 HTML：试玩卡 = 选中，真实卡 = 未选中
  const mock = elementById(html, 'm-mock-btn');
  const real = elementById(html, 'm-real-btn');
  assert.ok(mock && real, 'm/index.html 缺少模式卡 #m-mock-btn / #m-real-btn');
  assert.match(mock.attrs.class || '', /\bsel\b/, '#m-mock-btn（免费试玩）初始应带 sel');
  assert.strictEqual(mock.attrs['aria-checked'], 'true', '#m-mock-btn 初始 aria-checked 应为 true');
  assert.ok(!/\bsel\b/.test(real.attrs.class || ''), '#m-real-btn（真实对局）初始不应带 sel');
  assert.strictEqual(real.attrs['aria-checked'], 'false', '#m-real-btn 初始 aria-checked 应为 false');

  // 运行期：state 字面量里必须**显式**给初值 true（没有初值 ⇒ undefined ⇒ 落到真实对局那一侧）
  const st = /const state = \{([\s\S]*?)\n\};/.exec(mjs);
  assert.ok(st, 'm.js 里找不到 state 字面量');
  assert.match(st[1], /mock:\s*true/, 'state 字面量缺少 mock: true（新草稿默认试玩这条契约就落空了）');

  // syncMockBtn 的两条判据都必须以 state.mock 为准，且真值方向是"true = 试玩"
  const sync = fnBody(mjs, 'syncMockBtn');
  assert.ok(sync, 'm.js 缺少 syncMockBtn()');
  assert.match(sync, /b\.classList\.toggle\('sel',\s*!!state\.mock\)/, 'syncMockBtn 没有把 state.mock 映到试玩卡的 sel');
  assert.match(sync, /aria-checked',\s*state\.mock \? 'true' : 'false'/, 'syncMockBtn 没有把 state.mock 映到试玩卡的 aria-checked');
  assert.match(sync, /rb\.classList\.toggle\('sel',\s*!state\.mock\)/, 'syncMockBtn 没有把 !state.mock 映到真实卡的 sel');

  // ui-check 的对应断言也必须是"契约升级"后的版本（旧契约 = "模式卡默认选中真实对局"）。
  // 注意：**注释里提到旧契约**是允许且应该的（要让人看出这是契约升级而非放宽），所以这里钉的是
  // 旧断言的代码形态（check 标签 + 判据），不是文件里出现过那串字。
  const uic = read('scripts/ui-check.js');
  assert.ok(!/check\('模式卡默认选中真实对局/.test(uic), 'ui-check 仍留着旧契约的断言「模式卡默认选中真实对局」');
  assert.ok(!/realChecked === 'true'/.test(uic), "ui-check 仍要求真实卡默认 aria-checked=true（§8.2 要求默认试玩）");
  assert.match(uic, /check\('模式卡默认选中试玩/, 'ui-check 的断言没有升级为"默认选中试玩"（§8.2）');
  assert.match(uic, /mock\.checked === 'true' && mock\.realChecked === 'false'/,
    'ui-check 的默认态判据没有改成"试玩卡选中、真实卡未选中"');
  assert.match(uic, /点击真实卡后仅真实卡被选中/, 'ui-check 缺少"点一次真实卡后只剩真实卡选中"这一步（互斥仍须成立）');
  assert.match(uic, /点击试玩卡后仅试玩卡被选中/, 'ui-check 缺少"再点回试玩卡"这一步');

  // 自检：把初值改回 undefined（HEAD 的形态），上述正则必须不再匹配
  const head = mjs.replace(/\n\s*mock: true,/, '');
  assert.notStrictEqual(head, mjs, '自检失效：没能把 state.mock 初值去掉');
  assert.ok(!/mock:\s*true/.test(/const state = \{([\s\S]*?)\n\};/.exec(head)[1]),
    '自检失效：去掉初值后判据居然还是通过（说明它钉的不是初值）');
});
