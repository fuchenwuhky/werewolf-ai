/**
 * m4-annotation-layers.test.js —— D 批（M4 局中精修）契约：布局断点与"三层标注"不得混为一谈。
 *
 * 依据 docs/construction-status-and-guidance-2026-09-23.md §3.3（`:154`-`:159`）与 D 批验收（`:185`）：
 *   · 宽屏以发言阅读区为主体，右侧笔记约 320px；
 *   · **低于 960px 时玩家和笔记改抽屉**（不是"仅在 900px 把三栏堆成超长页"）；
 *   · 保留"系统公开身份 / 玩家自称 / 我的推测"三层，**不把推测绘制成系统真相**；
 *   · 复用 annotations-model、owner 绑定、草稿与冲突合并（不重写已验数据路径）。
 *
 * 这些断言全部读**真实源码**，不看注释自述：读到的每一处都必须成立，否则红。
 * 先红后绿：本文件先于实装提交，红轮原文留在仓外证据目录。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'web', 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
const mjs = fs.readFileSync(path.join(ROOT, 'web', 'm', 'm.js'), 'utf8');

test('布局①：右栏笔记宽度约 320px（不是 300px）', () => {
  const m = /\.game-layout\s*\{[^}]*grid-template-columns:\s*(\d+)px\s+minmax\(0,\s*1fr\)\s+(\d+)px/.exec(css);
  assert.ok(m, '应在 .game-layout 基础定义里读到 左 1fr 右 三列');
  const notes = Number(m[2]);
  assert.ok(notes >= 300 && notes <= 340, `右栏笔记宽度应约 320px（允许 300-340），实测 ${notes}px`);
});

test('布局②：把三栏收成两栏/单栏的那个断点必须是 960（不许更宽的断点提前收栏）', () => {
  // 上一版这条钉的是"第一个窄屏断点"，结果抓到 :1308 的 1080px（那是别的组件的断点）——瞄错了对象。
  // 正确靶子：凡是**改 .game-layout 列定义**的断点，其宽度都不得大于 960；且必须存在 960 的断点。
  const mediaRe = /@media \(max-width:\s*(\d+)px\)\s*\{/g;
  const offenders = [];
  let m;
  while ((m = mediaRe.exec(css))) {
    const w = Number(m[1]);
    // 取该断点的块体（到下一个 @media 或文件末尾），看里面有没有改 .game-layout 的列定义
    const next = css.indexOf('@media', m.index + m[0].length);
    const body = css.slice(m.index, next === -1 ? css.length : next);
    if (/\.game-layout[^{]*\{[^}]*grid-template-columns:/.test(body) && w > 960) {
      offenders.push(w);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `这些断点比 960 更早就收掉了三栏（违反"低于 960px 才改抽屉"）：${offenders.join('、')}px`);
  assert.ok(/@media \(max-width:\s*960px\)/.test(css), 'style.css 里应有 960px 的断点作为唯一收栏阈值');
});

test('布局③：<960px 时"玩家与笔记"都改抽屉，不能只有笔记', () => {
  // 抽屉化的判定必须同时覆盖左栏（玩家）与右栏（笔记）。
  const drawerHint = /低于\s*960|max-width:\s*960px/.test(css);
  assert.ok(drawerHint, 'style.css 里应有 960px 的抽屉断点');
  const playersDrawer = /(left-col|seats)[^{]*\{[^}]*(position:\s*fixed|position:\s*absolute|transform:\s*translate)/.test(css)
    || /players-drawer|left-drawer|#seats-drawer/.test(css);
  assert.ok(playersDrawer, '<960px 下玩家区（.left-col/.seats）也必须能变抽屉，现状只有笔记会回抽屉');
});

test('标注④：三层各有独立渲染行与独立类名（系统公开身份 / 玩家自称 / 我的推测）', () => {
  // 三个层标记都要出现在渲染路径里，且候选（推测）不能再与自称合并成一个字符串。
  assert.match(app, /anno-layer-system|layer-system|公开身份/, '缺"系统公开身份"层的渲染标记');
  assert.match(app, /anno-layer-claim|layer-claim|自称：/, '缺"玩家自称"层的渲染标记');
  assert.match(app, /anno-layer-guess|layer-guess|我的推测/, '缺"我的推测"层的渲染标记');
  assert.doesNotMatch(app, /candidateRoleIds\s*&&\s*a\.candidateRoleIds\[0\]\)\s*\|\|\s*a\.claimedRoleId/,
    '推测与自称不能合并成同一个 rid（这正是把推测画成真相的来源）');
});

test('标注⑤：推测层不得复用系统身份/自称的类名或文案（防"推测冒充真相"）', () => {
  const guessClasses = [...app.matchAll(/anno-layer-guess[^'"]*|layer-guess[^'"]*/g)].map((x) => x[0]);
  const systemClasses = [...app.matchAll(/anno-layer-system[^'"]*|layer-system[^'"]*/g)].map((x) => x[0]);
  for (const g of guessClasses) {
    assert.ok(!systemClasses.includes(g), `推测层与系统层共用了类名 ${g}`);
  }
  if (guessClasses.length) {
    assert.ok(!/system|公开/.test(guessClasses.join(' ')), '推测层的类名里不该出现 system/公开');
  }
});

test('标注⑥：仍复用 annotations-model 与 owner 绑定/草稿合并路径（不重写已验数据路径）', () => {
  assert.match(app, /WWAnnotationsModel|annotations-model/, 'app.js 应仍引用共享 annotations-model');
  const shared = fs.readFileSync(path.join(ROOT, 'web', 'shared', 'annotations-model.js'), 'utf8');
  assert.match(shared, /claimedRoleId/, '模型仍需保留 claimedRoleId（自称）');
  assert.match(shared, /candidateRoleIds|svCands/, '模型仍需保留候选/服务端候选（推测与公开身份）');
  assert.match(app, /owner/, '措辞与 owner 绑定相关路径不应被删');
  assert.ok(mjs.length > 0, '手机端文件应存在（双端都要覆盖）');
});

test('布局④：不得出现"仅 900px 才把三栏堆成超长页"的旧形态', () => {
  const m = /@media \(max-width:\s*900px\)/.exec(css);
  if (m) {
    // 允许 900px 断点存在，但局中布局在那里必须已经是单栏/抽屉，不能仍是三栏堆叠。
    const after = css.slice(m.index, m.index + 1200);
    assert.ok(!/grid-template-columns:\s*\d+px\s+minmax\(0,\s*1fr\)\s+\d+px/.test(after),
      '900px 断点里不能再出现三栏列定义（那就是被点名要消除的形态）');
  }
});
