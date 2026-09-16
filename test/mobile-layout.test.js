/**
 * mobile-layout.test.js — 手机对局页新布局 + 规则书的契约测试
 *
 * 背景：这轮把手机对局页从「圆桌 + 舞台 + 底部操作条 + 记录抽屉」重做成
 * 「左座位列 | 中间流程 | 右座位列」+ 底部「身份牌 + 技能键 | 对话框」。
 * 旧布局**没有任何 DOM 级测试**（整页重构后 npm test 依然 359/359 全绿），
 * 所以这里补上守卫。重点钉死三类"不会报错、只会变难看/用不了"的问题：
 *
 *   ① 半途而废的重构：旧元素（圆桌/舞台/抽屉/操作条）必须真的消失，
 *      否则 m.js 里会留下指向不存在节点的选择器，点一下就抛错。
 *   ② 弹窗滚动：`.modal` 是 flex 列，正文 `.mbody` 若不写 `min-height: 0`，
 *      flex 子项默认 `min-height: auto` 会被内容撑到真实高度（规则书实测 11192px），
 *      此时它自己的 `overflow: auto` 永不触发 —— 表现就是"内容超出屏幕且滚不动"。
 *      同理，openModal 不能把调用方的容器整包塞进去，否则约束传不到正文。
 *   ③ 规则书与引擎脱节：规则书是手写文案，引擎改了角色/规则它不会自己更新。
 *      这里用引擎的 ROLES 反查角色图鉴，防止"规则书少了一个角色"这种静默漂移。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

const MHTML = read(path.join('m', 'index.html'));
const MCSS = read(path.join('m', 'm.css'));
const MJS = read(path.join('m', 'm.js'));
const HTML = read('index.html');
const APPJS = read('app.js');
const CSS = read('style.css');
const SW = read('sw.js');
const { ROLES } = require('../src/engine/roles.js');
const Rulebook = require(path.join(WEB, 'rulebook.js'));

/** 取 CSS 里某个选择器的整块声明 */
function block(css, sel) {
  const i = css.indexOf(sel);
  assert.ok(i >= 0, `CSS 里找不到选择器 ${sel}`);
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

// ---------------------------------------------------------------- ① 新布局存在、旧布局消失

test('对局页：新布局的骨架齐备（齿轮 / 左右座位列 / 中间流程 / 身份牌 / 技能键 / 对话框）', () => {
  const need = ['m-gear', 'm-seats-l', 'm-seats-r', 'm-flow', 'm-mycard', 'm-keys', 'm-dialog', 'm-to-bottom'];
  for (const id of need) {
    assert.ok(MHTML.includes(`id="${id}"`), `m/index.html 缺少 #${id}`);
    assert.ok(MJS.includes(`#${id}`), `m.js 从未引用 #${id}（要么多余，要么漏接线）`);
  }
  // 流程区必须在左右两列座位之间
  const iL = MHTML.indexOf('id="m-seats-l"');
  const iF = MHTML.indexOf('id="m-flow"');
  const iR = MHTML.indexOf('id="m-seats-r"');
  assert.ok(iL < iF && iF < iR, '中间流程区必须夹在左右座位列之间');
});

test('对局页：旧布局元素与旧代码必须彻底移除（防半途而废的重构）', () => {
  for (const dead of ['m-table', 'm-stage', 'm-drawer', 'm-controls', 'm-actionbar', 'm-top-actions', 'm-log-btn', 'm-me-btn']) {
    assert.ok(!MHTML.includes(`id="${dead}"`), `m/index.html 仍残留旧元素 #${dead}`);
    assert.ok(!MJS.includes(`#${dead}`), `m.js 仍引用已删除的 #${dead}`);
  }
  for (const fn of ['openDrawer', 'closeDrawer', 'selectDrawerTab', 'renderMeTab', 'updateStage', 'chipSeat', 'targetPicker']) {
    assert.ok(!new RegExp(`function ${fn}\\b`).test(MJS), `m.js 仍残留旧函数 ${fn}()`);
  }
  // 旧圆桌用椭圆百分比定位座位，新布局是稳定两列
  assert.ok(!/lastSeatsView/.test(MJS), 'm.js 仍有圆桌椭圆的遗留状态');
  assert.ok(!/\.tseat|\.ts-ring/.test(MCSS), 'm.css 仍有圆桌座位样式');
});

test('对局页：左侧是身份牌+技能键、右侧是对话框（用户明确要求的方位）', () => {
  const iCard = MHTML.indexOf('id="m-mycard"');
  const iKeys = MHTML.indexOf('id="m-keys"');
  const iDlg = MHTML.indexOf('id="m-dialog"');
  assert.ok(iCard < iKeys && iKeys < iDlg, '底部坞顺序应为 身份牌 → 技能键 → 对话框');
  assert.ok(/class="m-dock-l"[\s\S]*m-mycard[\s\S]*m-keys[\s\S]*<\/div>[\s\S]*m-dialog/.test(MHTML),
    '身份牌与技能键必须在同一个左侧容器里，对话框在右侧容器里');
});

// ---------------------------------------------------------------- ② 布局与滚动契约

test('布局：三栏 + 底部坞的滚动只在流程区发生', () => {
  const board = block(MCSS, '.m-board {');
  assert.match(board, /display:\s*flex/, '牌桌区必须是 flex 行（左列|流程|右列）');
  const flow = block(MCSS, '.m-flow {');
  assert.match(flow, /overflow:\s*auto/, '流程区必须可滚动（这是全页唯一的历史阅读入口）');
  const flowWrap = block(MCSS, '.m-flow-wrap {');
  assert.match(flowWrap, /min-width:\s*0/, '流程区父容器必须 min-width:0，否则长文本会撑破三栏');
  const col = block(MCSS, '.m-seatcol {');
  assert.match(col, /flex:\s*0 0 \d+px/, '座位列必须是固定宽度，不能被长名字撑开');
  assert.match(col, /overflow:\s*auto/, '座位列多于一屏时（16 人局）必须能自己滚');
  const dock = block(MCSS, '.m-dock {');
  assert.match(dock, /flex:\s*none/, '底部坞不能被内容压缩（技能键与输入框必须常驻可见）');
  const dlg = block(MCSS, '.m-dialog-wrap {');
  assert.match(dlg, /min-width:\s*0/, '对话框必须 min-width:0，否则输入框会把技能键挤出屏幕');
});

test('滚动：弹窗正文必须被约束（min-height:0）且 openModal 不得多套一层', () => {
  const mbody = block(CSS, '.modal .mbody {');
  assert.match(mbody, /min-height:\s*0/, '.modal .mbody 缺 min-height:0 —— flex 子项会被内容撑高，overflow:auto 永不触发');
  assert.match(mbody, /flex:\s*1 1 auto/, '.modal .mbody 必须 flex:1 1 auto 才能吃掉剩余高度并滚动');
  assert.match(mbody, /overflow-y:\s*auto/, '.modal .mbody 必须 overflow-y:auto');
  assert.match(block(CSS, '.modal {'), /overflow:\s*hidden/, '.modal 需要 overflow:hidden 兜底，子元素不得画出圆角边框外');
  // 两端 openModal 都必须"拆开无类名容器"，否则 .mhead/.mbody 变成孙子，约束传不到
  for (const [name, src] of [['app.js', APPJS], ['m.js', MJS]]) {
    assert.match(src, /!inner\.className && inner\.children\.length/, `${name} 的 openModal 缺少"拆开无类名容器"分支`);
  }
});

test('滚动：流程区跟随状态不能用"离底部距离"判断', () => {
  // 轮询一次可能新增几百像素，距离法会当场误判"用户已上翻"并永久停止跟随
  assert.match(MJS, /let flowPinned = true/, '需要显式的跟随状态 flowPinned');
  assert.match(MJS, /flowSelfScroll/, '程序滚动与用户滚动必须区分，否则会自我取消跟随');
  assert.match(MJS, /function onFlowScroll/, '需要 scroll 事件处理来判断用户是否主动上翻');
});

// ---------------------------------------------------------------- ③ 技能键语义

test('技能键：可用=红、不可用=灰红、次要=暗红，并且 disabled 与视觉一致', () => {
  const on = block(MCSS, '.key.on {');
  const off = block(MCSS, '.key.off {');
  const alt = block(MCSS, '.key.alt {');
  const cols = (s) => (s.match(/#[0-9a-f]{6}/gi) || []).map((h) => [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16)));
  const chroma = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b);
  // 可用：底色是明确的红（红通道显著高于绿蓝）
  assert.ok(cols(on).some(([r, g, b]) => r > 150 && r - g > 60 && r - b > 60), `.key.on 必须是红色系：${on}`);
  // 不可用：必须"灰"——所有用色的彩度都低（不是鲜红），且底色压暗
  assert.ok(cols(off).every((c) => chroma(c) < 60), `.key.off 必须是去饱和的灰红（彩度过高就不像"不可用"）：${off}`);
  assert.ok(cols(off).every(([r, g, b]) => r < 160 && g < 130), `.key.off 必须压暗：${off}`);
  assert.match(off, /cursor:\s*not-allowed/);
  // 次要但可用：介于两者之间，必须有可见的红色描边以区分"不可用"
  assert.ok(cols(alt).length >= 2, '.key.alt 需要底色与描边两色');
  assert.match(alt, /border-color:[^;]*rgba\(179,\s*46,\s*62/, '.key.alt 的描边要是血红，才能与灰红的"不可用"区分');
  // 代码侧：setKeyEnabled 必须同时改类与 disabled
  const fn = MJS.slice(MJS.indexOf('function setKeyEnabled'), MJS.indexOf('function setKeyEnabled') + 420);
  assert.match(fn, /classList\.toggle\('on'/, 'setKeyEnabled 未切换 .on');
  assert.match(fn, /classList\.toggle\('off'/, 'setKeyEnabled 未切换 .off');
  assert.match(fn, /btn\.disabled = !on/, 'setKeyEnabled 必须同步 disabled —— 否则"看着能点其实点了没用"');
});

test('技能键：有目标类任务时才让座位变成可点选目标', () => {
  assert.match(MJS, /TARGET_TASKS/, '需要任务→确认键/免选键的映射表');
  assert.match(MJS, /function onSeatTap/, '点座位必须走 onSeatTap');
  assert.match(MJS, /actionState\.needTarget/, 'onSeatTap 需要知道当前是否在选目标');
  assert.match(MJS, /function markNeedTarget/, '缺少"进入选目标状态"的入口');
  // 点座位选目标必须先校验候选范围，否则会提交非法目标
  const tap = MJS.slice(MJS.indexOf('function onSeatTap'), MJS.indexOf('function setTarget'));
  assert.match(tap, /actionState\.candidates\.includes/, 'onSeatTap 未校验候选范围');
});

// ---------------------------------------------------------------- ④ 齿轮菜单

test('齿轮菜单：两端都把设置/规则书/退出收进一处', () => {
  assert.match(MJS, /function openGear/, 'm.js 缺少齿轮菜单');
  assert.match(APPJS, /function openGearMenu/, 'app.js 缺少齿轮菜单');
  assert.ok(MHTML.includes('id="m-gear"'), '手机齿轮按钮缺失');
  assert.ok(/id="m-gear"[^>]*data-i18n-title="m\.gearTitle"/.test(MHTML.replace(/\s+/g, ' ')), '手机齿轮缺无障碍名称');
  assert.ok(HTML.includes('id="btn-gear"'), '桌面齿轮按钮缺失');
  for (const dead of ['btn-rulebook', 'btn-god"', 'btn-home', 'btn-terminate"']) {
    assert.ok(!HTML.includes(dead), `桌面顶栏仍残留旧按钮 ${dead}（应已收进齿轮）`);
  }
  // 菜单里必须有"退出/结束"类入口（用户明确要求）
  assert.match(MJS, /结束本局/, '手机齿轮菜单缺少"结束本局"');
  assert.match(MJS, /返回首页|退出到首页/, '齿轮菜单缺少退出入口');
  assert.match(APPJS, /返回首页/, '桌面齿轮菜单缺少退出入口');
});

// ---------------------------------------------------------------- ⑤ 规则书

test('规则书：结构合法、章节齐全、两端共用同一份', () => {
  const S = Rulebook.SECTIONS;
  assert.strictEqual(S.length, 8, '章节数变了要同步更新本测试');
  assert.deepStrictEqual(S.map((s) => s.id), ['flow', 'win', 'roles', 'night', 'day', 'skills', 'mistakes', 'settings']);
  const ids = new Set();
  for (const s of S) {
    assert.ok(s.title && !ids.has(s.id), `章节 ${s.id} 标题缺失或 id 重复`);
    ids.add(s.id);
    assert.ok(Array.isArray(s.blocks) && s.blocks.length, `章节 ${s.id} 没有内容块`);
    for (const b of s.blocks) {
      assert.ok(['p', 'steps', 'ul', 'table', 'note'].includes(b.t), `章节 ${s.id} 出现未知块类型 ${b.t}`);
      if (b.t === 'table') {
        assert.ok(b.head && b.rows, `章节 ${s.id} 的表格缺 head/rows`);
        for (const r of b.rows) assert.strictEqual(r.length, b.head.length, `章节 ${s.id} 表格行列数不一致`);
      } else if (b.t === 'steps' || b.t === 'ul') {
        assert.ok(Array.isArray(b.items), `章节 ${s.id} 的列表缺 items`);
      } else {
        assert.ok(typeof b.text === 'string', `章节 ${s.id} 的文本块缺 text`);
      }
    }
  }
  // 共享：两端都加载 rulebook.js 并调用同一个 render
  assert.ok(HTML.includes('rulebook.js') && MHTML.includes('rulebook.js'), '两端都要加载 rulebook.js');
  assert.ok(SW.includes("'/rulebook.js'"), 'rulebook.js 必须进离线预缓存（对局中断网还能查规则）');
  assert.match(APPJS, /Rulebook\.render/, 'app.js 必须调用共享渲染器');
  assert.match(MJS, /Rulebook\.render/, 'm.js 必须调用共享渲染器');
  assert.ok(typeof Rulebook.render === 'function', 'Rulebook.render 必须存在');
});

test('规则书：角色图鉴必须与引擎的 ROLES 一一对应（防静默漂移）', () => {
  const rolesSec = Rulebook.SECTIONS.find((s) => s.id === 'roles');
  const table = rolesSec.blocks.find((b) => b.t === 'table');
  const names = new Set(table.rows.map((r) => String(r[0])));
  const ids = Object.keys(ROLES);
  const missing = ids.filter((id) => !names.has(ROLES[id].name));
  assert.deepStrictEqual(missing, [], `规则书角色图鉴缺少这些角色：${missing.join('、')}（引擎有 ${ids.length} 个角色，规则书 ${names.size} 行）`);
  const extra = [...names].filter((n) => !ids.some((id) => ROLES[id].name === n));
  assert.deepStrictEqual(extra, [], `规则书里出现引擎不存在的角色：${extra.join('、')}`);
});

test('规则书：正文只有一份实现（各端不许再内联一套）', () => {
  // 旧规则书的特征文案，必须已经从 app.js / m.js 里清干净
  for (const [name, src] of [['app.js', APPJS], ['m.js', MJS]]) {
    assert.ok(!/同守同救（守卫\+解药同夜作用于同一人）/.test(src), `${name} 仍有旧规则书正文`);
    assert.ok(!/roleArtHtml\(r\.id\)[\s\S]{0,200}规则书/.test(src), `${name} 仍在自建角色图鉴正文`);
  }
  assert.ok(!/renderFlowTab/.test(APPJS), 'app.js 仍残留旧规则书标签实现');
});
