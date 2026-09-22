/**
 * icons.test.js — 核心导航/操作图标（计划书 §3 第 78 行前半句）的结构守卫
 *
 * 这次改造的实质是把"两端各写一份 emoji"换成一个共享模块里的一份 `<symbol>` 定义。
 * 最容易悄悄退化的不是画得难看，而是下面这几类**无声回退**：
 *   ① 少写一个 symbol / id 拼错 / `ICON_IDS` 与 `MARKS`、`ICON_NAME` 不同步
 *      → 页面上出现一个空白的 `<use>`，谁也不报错；
 *   ② 徽记画到 24×24 画布外面（圆头线宽 1.6 会再向外溢 0.8px）→ 圆形裁切时被削掉一角；
 *   ③ 画里混进写死的十六进制色值或 `<text>` → 深浅底必然有一边看不见；
 *   ④ 两端 HTML 里出现模块里不存在的 `data-ww-icon` 值 → 那个按钮永远没图标；
 *   ⑤ i18n 把带 emoji 的词典文案写回元素、而元素没标 `data-ww-icon`
 *      → 切一次语言（或首次 applyI18n）图标就退回 emoji；
 *   ⑥ 忘了把模块登记进 Service Worker 预缓存 → 离线时图标整片消失（sw-shell 另有一道门）。
 *
 * 这些都钉在这里。**不**断言"页面上一个 emoji 都没有"——内容 emoji 必须保留，
 * 那条线由 test/emoji-preserve.test.js 守。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const readWeb = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');
const WWIcons = require('../web/shared/icons.js');

const EXT_PICT = /\p{Extended_Pictographic}/u;

/** 在裸环境里加载 i18n.js（与 test/i18n.test.js 同一套做法，取词典用） */
function loadI18n() {
  const sandbox = { console, localStorage: null, navigator: { language: 'zh-CN' } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readWeb('i18n.js'), sandbox, { filename: 'i18n.js' });
  return sandbox.I18N;
}

// ---------------- 计划书 §3 第 78 行的**后半句**：内容里的正常 emoji 不许被清掉 ----------------

/**
 * 第 78 行原文是两句：「核心导航和操作图标使用统一 SVG；**不要全局删除聊天内容或玩家姓名里的
 * 正常 emoji**。」前半句由上面的用例守（39 枚 symbol、两端同一份、i18n 不回退）。
 *
 * 后半句在本批里是**真实风险**：这次一共从四个文件里删掉了一百多个字形，删顺手了就会把
 * "角色图标表""状态文案""事件流""聊天/发言"里的语义字形一起扫掉。test/emoji-preserve.test.js
 * 钉的是那 7 处 `👤`、头像字形不许回到 app.js/m.js、以及 roles.js / i18n.js 的条数下限；
 * **文字流与角色/状态表**这一层没人钉，所以补在这里：
 *   · 逐字钉住几处"内容语义"字形（角色图标表、事件标签、胜利横幅、状态文案）；
 *   · 再给每个文件一个**条数下限**——单个字形的删除由前者抓，成片删除由后者抓。
 * ⚠ 不许为了让本用例变绿而下调这里的数字：这些下限就是"没有全局删除"的证据本身。
 */
const CONTENT_EMOJI_PINS = [
  // 角色图标表（web/app.js）：角色语义字形，不是导航图标
  ['web/app.js', "admirer: '💗'", '角色图标表条目'],
  ['web/app.js', "guard: '🛡️'", '角色图标表条目'],
  // 事件标签 / 胜利横幅 / 私密消息：文字流语义
  ['web/app.js', "wolf: '🔒 狼聊'", '事件上下文标签'],
  ['web/app.js', "'🎉 好人阵营获胜！'", '胜利横幅'],
  ['web/app.js', '🏆 ${escapeHtml(score.title)}', '结算标题'],
  // 手机端的同一层：状态文案表 + 事件标签 + 胜利文案
  ['web/m/m.js', "night: '🌙 夜晚进行中…'", '阶段状态文案'],
  ['web/m/m.js', "lastwords: '🕯 遗言'", '事件上下文标签'],
  ['web/m/m.js', "'🎉 好人阵营获胜'", '胜利文案'],
  // 本批明确判定为"内容、不动"的几处（也是别的门禁钉住的）
  ['web/m/m.js', "'⚙ 设置'", '齿轮菜单的设置入口（scripts/ui-check.js:2891 钉 textContent）'],
  ['web/app.js', "'🎲 随机（推荐）'", '座位随机项（test/seat.test.js 钉）'],
  ['web/m/m.js', "'🎲 随机（推荐）'", '座位随机项（test/seat.test.js 钉）'],
  ['web/index.html', '👤 我的档案', '档案标签（非头像 👤）'],
  ['web/index.html', '👤 档案管理（导入 / 导出 / 战绩）', '档案管理按钮文案'],
  ['web/m/index.html', '👤 我的', '手机"我的"页签'],
  ['web/m/index.html', '⚔ 对局规则', '规则书分区小标题（内容，非控件标签）'],
  ['web/index.html', '<span class="cb-txt" data-i18n-html="overlay.flipHint">❓<br>点击翻看你的身份</span>', '卡背翻看提示'],
];

/** 只能多、不能少的条数下限（当前实测值各留了一点余量，成片删除必红） */
const CONTENT_EMOJI_FLOORS = [
  ['web/app.js', 120], ['web/m/m.js', 100], ['web/i18n.js', 70],
  ['web/index.html', 5], ['web/m/index.html', 4], ['src/engine/roles.js', 13],
];

function countEmoji(text) {
  const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
  let n = 0;
  for (const { segment } of seg.segment(String(text))) {
    if (EXT_PICT.test(segment) || segment.indexOf('\u20E3') >= 0) n++;
  }
  return n;
}

test('内容 emoji：角色/状态/事件/横幅里的语义字形必须逐字保留（第 78 行后半句）', () => {
  const missing = [];
  for (const [rel, needle, why] of CONTENT_EMOJI_PINS) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // 允许引号风格差异，但**不允许**"字形没了却只剩文字"——所以匹配里带字形本身
    if (!src.includes(needle)) missing.push(`${rel}: 找不到 ${JSON.stringify(needle)}（${why}）`);
  }
  assert.deepStrictEqual(missing, [], `内容里的正常 emoji 被删掉了：\n${missing.join('\n')}`);
});

test('内容 emoji：每个文件的条数不得低于下限（抓"全局删除"而不是单个字形）', () => {
  const low = [];
  for (const [rel, floor] of CONTENT_EMOJI_FLOORS) {
    const n = countEmoji(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    if (n < floor) low.push(`${rel}: ${n} < 下限 ${floor}`);
  }
  assert.deepStrictEqual(low, [], `下列文件的 emoji 条数低于下限（疑似成片删除）：\n${low.join('\n')}`);
});

// ---------------- ① 一份定义：id / symbol / 无障碍名三者同步 ----------------

test('图标：ICON_IDS 与 MARKS、ICON_NAME 一一对应（少一个就是页面上一个空白 <use>）', () => {
  const ids = WWIcons.ICON_IDS;
  assert.ok(Array.isArray(ids) && ids.length >= 39, `ICON_IDS 至少 39 个，实际 ${ids.length}`);
  assert.strictEqual(new Set(ids).size, ids.length, 'ICON_IDS 有重复项');
  for (const id of ids) {
    assert.ok(WWIcons.MARKS[id] && WWIcons.MARKS[id].trim(), `MARKS 缺 ${id}`);
    assert.ok(WWIcons.ICON_NAME[id], `ICON_NAME 缺 ${id}`);
  }
  assert.deepStrictEqual(Object.keys(WWIcons.MARKS).sort(), [...ids].sort(), 'MARKS 与 ICON_IDS 的键集合必须完全一致');
  assert.deepStrictEqual(Object.keys(WWIcons.ICON_NAME).sort(), [...ids].sort(), 'ICON_NAME 与 ICON_IDS 的键集合必须完全一致');
});

test('图标：defs 里每个 id 恰好一个 <symbol>，id 唯一且带 viewBox（一份定义，使用点只写 <use>）', () => {
  const html = WWIcons.defsMarkup();
  const ids = [...html.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]);
  assert.strictEqual(ids.length, WWIcons.ICON_IDS.length, `symbol 数量=${ids.length}，应为 ${WWIcons.ICON_IDS.length}`);
  assert.strictEqual(new Set(ids).size, ids.length, 'symbol id 有重复');
  for (const id of WWIcons.ICON_IDS) {
    assert.ok(ids.includes(WWIcons.symbolId(id)), `defs 缺 symbol ${WWIcons.symbolId(id)}`);
  }
  // 每个 symbol 都带自己的 viewBox：符号被 <use> 引用时不继承外层坐标系
  assert.strictEqual((html.match(/<symbol [^>]*viewBox="0 0 24 24"/g) || []).length, ids.length, '有 symbol 缺 viewBox');
  // 展示标记只引用、不复制路径
  for (const id of WWIcons.ICON_IDS) {
    const one = WWIcons.iconMarkup(id);
    assert.ok(one.includes(`<use href="#${WWIcons.symbolId(id)}"`), `${id} 的标记不是 <use> 引用`);
    assert.strictEqual((one.match(/<path|<circle|<rect/g) || []).length, 0, `${id} 把路径复制进了使用点`);
  }
});

test('图标：未知 id 一律产出空串（白名单之外的东西进不了 DOM）', () => {
  for (const bad of ['', null, undefined, 'nope', 'SETTINGS', 'settings ', '<script>', 1]) {
    assert.strictEqual(WWIcons.iconMarkup(bad), '', `iconMarkup(${JSON.stringify(bad)}) 应为空串`);
    assert.strictEqual(WWIcons.normalizeId(bad), null);
  }
  assert.strictEqual(WWIcons.labelMarkup('nope', '📖 角色图鉴'), '角色图鉴', 'id 无效时仍应给出干净文案');
});

// ---------------- ③ 只用 currentColor、不写死色值 ----------------

test('图标：没有任何写死的颜色（只用 currentColor + opacity 降权）', () => {
  const all = WWIcons.defsMarkup();
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(all), 'defs 里出现了十六进制色值');
  assert.ok(!/rgb\(|rgba\(|hsl\(/.test(all), 'defs 里出现了函数式色值');
  assert.ok(!/\bcolor="/.test(all), 'defs 里出现了 color 属性（应靠 currentColor 继承）');
  assert.ok(!/fill="(?!none|currentColor)/.test(all), 'defs 里出现了非 none/currentColor 的 fill');
  assert.ok(!/stroke="(?!none|currentColor)/.test(all), 'defs 里出现了非 none/currentColor 的 stroke');
  assert.ok(/stroke="currentColor"/.test(WWIcons.STROKE) && /fill="none"/.test(WWIcons.STROKE), 'STROKE 必须是 currentColor 描边');
  // 展示标记同样不得带色值，且必须显式给尺寸（裸 <svg> 默认 300×150）
  for (const id of WWIcons.ICON_IDS) {
    const one = WWIcons.iconMarkup(id);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(one), `${id} 的标记里出现了色值`);
    assert.ok(/width="[^"]+" height="[^"]+"/.test(one), `${id} 的标记缺显式宽高`);
    assert.ok(/role="img"/.test(one) && /aria-label="[^"]+"/.test(one), `${id} 的标记缺无障碍名`);
  }
});

test('图标：线稿里不出现 <text>/<image>/外链（字体与外部资源都不可依赖）', () => {
  const all = WWIcons.defsMarkup();
  assert.ok(!/<text|<image|<foreignObject|href="http|url\(/.test(all), 'defs 里出现了不可依赖的节点/外链');
  assert.ok(/^<svg id="ww-icon-defs"/.test(all) && all.includes('<defs>'), 'defs 应是一段隐藏的 <svg><defs>');
});

// ---------------- ② 24×24 画布安全边距（圆头线宽 1.6 会再外溢 0.8px） ----------------

/**
 * 把一条 <path d> 的**绝对落点**逐个解出来。
 *
 * 两个必须做对的地方（第一版就在这里错了，把安全边距测成了一堆假红）：
 *   · 圆弧只取终点，rx/ry/rotation/large-arc/sweep 五个数要跳过（它们不是坐标）；
 *   · 相对命令（小写）的基准是**本段开始时**的当前点，同一段里的控制点不再互相叠加
 *     （`c dx1 dy1 dx2 dy2 dx dy` 三个点都相对段首，不是三点依次相加）。
 */
function pathPoints(d) {
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+/g) || [];
  const pts = [];
  let i = 0, cmd = null, cx = 0, cy = 0, sx = 0, sy = 0, first = true;
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/^[A-Za-z]$/.test(toks[i])) cmd = toks[i++];
    if (!cmd) { i++; continue; }
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    const bx = cx, by = cy; // 本段的基准点
    const ax = (v) => (rel ? bx + v : v);
    const ay = (v) => (rel ? by + v : v);
    switch (up) {
      case 'M': {
        // 整条路径的第一个相对 m 以 (0,0) 为基准；之后的隐式坐标对按 lineto 处理
        const ox = rel && first ? 0 : bx, oy = rel && first ? 0 : by;
        const x = num(), y = num();
        cx = rel ? ox + x : x; cy = rel ? oy + y : y;
        pts.push([cx, cy]); sx = cx; sy = cy;
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': { const x = ax(num()), y = ay(num()); cx = x; cy = y; pts.push([cx, cy]); break; }
      case 'H': { cx = ax(num()); pts.push([cx, cy]); break; }
      case 'V': { cy = ay(num()); pts.push([cx, cy]); break; }
      case 'C': case 'S': case 'Q': {
        const n = up === 'C' ? 3 : 2;
        const seg = [];
        for (let k = 0; k < n; k++) { const x = ax(num()), y = ay(num()); seg.push([x, y]); pts.push([x, y]); }
        const end = seg[seg.length - 1]; cx = end[0]; cy = end[1];
        break;
      }
      case 'T': { const x = ax(num()), y = ay(num()); cx = x; cy = y; pts.push([cx, cy]); break; }
      case 'A': {
        num(); num(); num(); num(); num(); // rx ry rotation large-arc sweep
        const x = ax(num()), y = ay(num());
        cx = x; cy = y; pts.push([cx, cy]);
        break;
      }
      case 'Z': cx = sx; cy = sy; break;
      default: i++; break;
    }
    first = false;
  }
  return pts;
}

/** 元素上的 rotate(a cx cy)（本模块只有 antidote 用了一次） */
function rotated([x, y], transform) {
  const m = /rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/.exec(transform || '');
  if (!m) return [x, y];
  const a = (Number(m[1]) * Math.PI) / 180, ox = Number(m[2]), oy = Number(m[3]);
  const dx = x - ox, dy = y - oy;
  return [ox + dx * Math.cos(a) - dy * Math.sin(a), oy + dx * Math.sin(a) + dy * Math.cos(a)];
}

test('图标：所有线稿收在 24×24 的 2px 安全边距内（线宽 1.6 再外溢 0.8px 也切不到）', () => {
  const SAFE = 2;
  const out = [];
  for (const id of WWIcons.ICON_IDS) {
    const body = WWIcons.MARKS[id];
    const check = (x, y, what) => {
      if (!(x >= SAFE && x <= 24 - SAFE && y >= SAFE && y <= 24 - SAFE)) out.push(`${id}: ${what} → (${x}, ${y})`);
    };
    for (const m of body.matchAll(/<path[^>]*\bd="([^"]+)"/g)) {
      for (const [x, y] of pathPoints(m[1])) check(x, y, 'path');
    }
    for (const m of body.matchAll(/<circle\b([^>]*)\/>/g)) {
      const at = (re) => { const g = re.exec(m[1]); return g ? Number(g[1]) : null; };
      const cx = at(/\bcx="(-?[\d.]+)"/), cy = at(/\bcy="(-?[\d.]+)"/), r = at(/\br="(-?[\d.]+)"/);
      check(cx - r, cy - r, 'circle↖'); check(cx + r, cy + r, 'circle↘');
    }
    for (const m of body.matchAll(/<rect\b([^>]*)\/>/g)) {
      const at = (re) => { const g = re.exec(m[1]); return g ? Number(g[1]) : null; };
      const x = at(/\bx="(-?[\d.]+)"/), y = at(/\by="(-?[\d.]+)"/), w = at(/\bwidth="(-?[\d.]+)"/), h = at(/\bheight="(-?[\d.]+)"/);
      const tf = (/\btransform="([^"]+)"/.exec(m[1]) || [])[1];
      for (const c of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) check(...rotated(c, tf), 'rect');
    }
  }
  assert.deepStrictEqual(out, [], `以下坐标超出安全边距：\n${out.join('\n')}`);
});

// ---------------- plainLabel 的边界（"只删标签开头那一个图标位"） ----------------

test('plainLabel：只吃掉开头的图标字形与空格，标签内部的 emoji 一个都不动', () => {
  const cases = [
    ['📖 角色图鉴', '角色图鉴'],
    ['⚙ 开局设置 · 模型与密钥', '开局设置 · 模型与密钥'],
    ['☰ 列表', '列表'],
    ['✕ 关闭', '关闭'],
    ['👁 上帝 / 开发者面板', '上帝 / 开发者面板'],
    ['🎮 开始游戏', '开始游戏'],
    ['⚔️ 随时决斗', '随时决斗'],
    ['🔍 检视卡牌', '检视卡牌'],
    ['设置', '设置'],
    ['', ''],
    [null, ''],
    ['  只有空白  ', '只有空白  '],
    // 关键性质：**内部**的 emoji 是内容，必须原样留下
    ['好人 🎉 获胜', '好人 🎉 获胜'],
    ['🐺 狼人阵营获胜！', '狼人阵营获胜！'], // 开头那个是图标位（调用点只喂控件标签/标题）
    ['战报 🃏 vs 🐺', '战报 🃏 vs 🐺'],
    // 正文里的裸箭头不是图标位（符号字形白名单只认开头的几个）
    ['第 3 天 → 投票', '第 3 天 → 投票'],
  ];
  for (const [input, want] of cases) {
    assert.strictEqual(WWIcons.plainLabel(input), want, `plainLabel(${JSON.stringify(input)})`);
  }
});

test('plainLabel：幂等（重跑一次结果不变——mount 每次都要重跑它）', () => {
  for (const s of ['📖 角色图鉴', '⚙ 设置', '', '好人 🎉 获胜', '📝 📝 双图标']) {
    const once = WWIcons.plainLabel(s);
    assert.strictEqual(WWIcons.plainLabel(once), once, `plainLabel 对 ${JSON.stringify(s)} 不幂等`);
  }
});

test('labelMarkup：徽记 + 去图标文案；未知 id 退化为纯文案（不会留下半截标记）', () => {
  const one = WWIcons.labelMarkup('settings', '⚙ 开局设置');
  assert.ok(one.startsWith('<svg class="ww-icon"'), 'labelMarkup 应以徽记开头');
  assert.ok(one.includes('开局设置') && !one.includes('⚙ 开局设置'), 'labelMarkup 没有去掉前导字形');
  assert.ok(!EXT_PICT.test(WWIcons.plainLabel('⚙ 开局设置')), '去图标后不应还有表情字形');
  assert.strictEqual(WWIcons.labelMarkup('nope', '⚙ 设置'), '设置');
  // 空文案：只给徽记，不留尾随空格
  const bare = WWIcons.labelMarkup('close', '');
  assert.ok(bare.endsWith('</svg>') && !/\s$/.test(bare), '空文案不应产生尾随空格');
});

// ---------------- ⑤ i18n 会把 emoji 写回来：标了 data-ww-icon 才不会退回去 ----------------

/** 取出 HTML 里每个**标签**的属性串（属性值内不含 '>'），便于判断"同一标签上有没有标 data-ww-icon" */
function tagAttrs(html) {
  return [...html.matchAll(/<[a-zA-Z][^>]*>/g)].map((m) => m[0]);
}

/** 本条改造**有意保留**为内容、不换成徽记的带 emoji 文案（位置判据见 icons.js 文件头） */
const CONTENT_KEYS_WITH_EMOJI = new Set([
  'overlay.flipHint', // ❓ 是卡背上的"未知/点击翻看"提示，是内容不是控件标签
  'm.rulesSection',   // ⚔ 对局规则：规则书里的分区小标题（内容）
]);

test('i18n：词典里带 emoji 的文案，只要落在 HTML 上就必须标 data-ww-icon（否则切语言就退回 emoji）', () => {
  const I18N = loadI18n();
  const unmarked = [];
  for (const rel of ['index.html', path.join('m', 'index.html')]) {
    const html = readWeb(rel);
    for (const tag of tagAttrs(html)) {
      if (!/data-i18n(?:-html|-placeholder|-title|-aria)?="/.test(tag)) continue;
      const marked = /data-ww-icon="/.test(tag);
      for (const m of tag.matchAll(/data-i18n(?:-html|-placeholder|-title|-aria)?="([^"]+)"/g)) {
        const key = m[1];
        for (const lang of I18N.LANGS) {
          const val = (I18N.DICT[lang] || {})[key];
          if (typeof val !== 'string' || !EXT_PICT.test(val)) continue;
          if (marked || CONTENT_KEYS_WITH_EMOJI.has(key)) continue;
          unmarked.push(`${rel} ${key} [${lang}] = ${JSON.stringify(val)}`);
        }
      }
    }
  }
  assert.deepStrictEqual(unmarked, [],
    `下列文案在词典里带 emoji，但所在元素没标 data-ww-icon（applyI18n 会把它写回去）：\n${unmarked.join('\n')}`);
});

test('i18n：保留为内容的带 emoji 文案必须仍然存在（不许为了"清干净"把内容也删掉）', () => {
  const I18N = loadI18n();
  for (const key of CONTENT_KEYS_WITH_EMOJI) {
    assert.ok(I18N.DICT['zh-CN'][key], `词典缺 ${key}`);
    assert.ok(EXT_PICT.test(I18N.DICT['zh-CN'][key]), `${key} 的 emoji 被删了——它是内容，不该动`);
  }
});

// ---------------- ④ 两端引用同一份定义 ----------------

test('两端：两个 index.html 都引用共享模块，且解析到同一个文件', () => {
  const desktop = readWeb('index.html');
  const mobile = readWeb(path.join('m', 'index.html'));
  const dSrc = /<script src="([^"]*shared\/icons\.js)"><\/script>/.exec(desktop);
  const mSrc = /<script src="([^"]*shared\/icons\.js)"><\/script>/.exec(mobile);
  assert.ok(dSrc, '桌面 index.html 没有引用 shared/icons.js');
  assert.ok(mSrc, '手机 m/index.html 没有引用 shared/icons.js');
  assert.strictEqual(
    path.resolve(WEB, dSrc[1]), path.resolve(WEB, 'm', mSrc[1]),
    '两端的 <script src> 必须解析到同一个文件（"两端一致"是结构事实，不是两处写得一样）'
  );
  // 模块必须在页面脚本之前加载：app.js / m.js 一解析就要用 window.WWIcons
  for (const [rel, pageScript] of [['index.html', 'app.js'], [path.join('m', 'index.html'), 'm.js']]) {
    const html = readWeb(rel);
    assert.ok(html.indexOf('shared/icons.js') < html.indexOf(`"${pageScript}"`), `${rel}：icons.js 必须在 ${pageScript} 之前`);
  }
});

test('两端：module 登记进 Service Worker 预缓存（否则离线时图标整片消失）', () => {
  const sw = readWeb('sw.js');
  const shell = /const SHELL = \[([\s\S]*?)\];/.exec(sw);
  assert.ok(shell, 'sw.js 里找不到 SHELL');
  const list = [...shell[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(list.includes('/shared/icons.js'), 'SHELL 缺 /shared/icons.js');
});

test('两端：HTML 里的每个 data-ww-icon 都是模块里的 id，且核心导航两端都在', () => {
  const dHtml = readWeb('index.html');
  const mHtml = readWeb(path.join('m', 'index.html'));
  const vals = (html) => [...html.matchAll(/data-ww-icon="([^"]*)"/g)].map((m) => m[1]);
  const dVals = vals(dHtml);
  const mVals = vals(mHtml);
  for (const v of [...dVals, ...mVals]) {
    assert.strictEqual(WWIcons.normalizeId(v), v, `HTML 里的 data-ww-icon="${v}" 不是合法 id`);
  }
  // 同一枚徽记在两端必须指向同一个 symbol（不是各画一份）
  for (const id of ['settings', 'codex', 'start', 'back']) {
    assert.ok(dVals.includes(id), `桌面端少了 ${id} 徽记`);
    assert.ok(mVals.includes(id), `手机端少了 ${id} 徽记`);
  }
  // 页签/齿轮/返回这类"两端都有的入口"不允许只改一边
  assert.ok(dVals.length >= 20 && mVals.length >= 15, `两端标记数偏少：桌面 ${dVals.length}、手机 ${mVals.length}`);
  // 按钮/链接类控件：徽记不能是唯一标识 —— 必须有可见文字，或有 aria-label/title
  const nameless = [];
  for (const [rel, html] of [['index.html', dHtml], [path.join('m', 'index.html'), mHtml]]) {
    for (const m of html.matchAll(/<(button|a)\b([^>]*data-ww-icon="[^"]*"[^>]*)>([\s\S]*?)<\/\1>/g)) {
      const [, tag, attrs, inner] = m;
      const named = /aria-label="|title="|data-i18n-title="/.test(attrs) || inner.trim().length > 0;
      if (!named) nameless.push(`${rel}: <${tag}${attrs.slice(0, 60)}…> 既无文字也无无障碍名`);
    }
  }
  assert.deepStrictEqual(nameless, [], `下列控件只有一枚徽记、没有可读名字：\n${nameless.join('\n')}`);
});

// ---------------- ⑥ i18n 重刷之后必须重画（这条最容易漏，且只在切语言时暴露） ----------------

test('接线：app.js / m.js 在每次 I18N.setLang 之后都会按 data-ww-icon 重画一次', () => {
  for (const rel of ['app.js', path.join('m', 'm.js')]) {
    const src = readWeb(rel);
    assert.ok(/window\.WWIcons\.ensureDefs\(document\)/.test(src), `${rel} 没有注入 defs`);
    assert.ok(/DOMContentLoaded/.test(src) && /WWIcons\.mount\(document\)/.test(src), `${rel} 没有在 DOMContentLoaded 后 mount`);
    const setLangs = [...src.matchAll(/I18N\.setLang\(/g)];
    assert.ok(setLangs.length >= 1, `${rel} 找不到 I18N.setLang 调用`);
    for (const m of setLangs) {
      const after = src.slice(m.index, m.index + 400);
      assert.ok(/WWIcons\.mount\(document\)/.test(after),
        `${rel}:${src.slice(0, m.index).split('\n').length} 的 setLang 之后 400 字符内没有重画徽记（切语言会退回 emoji）`);
    }
  }
});

// ---------------- mount 的行为（幂等 / i18n 重刷后能重画） ----------------

/** 极简假 DOM：只实现 icons.js 用到的那几个接口，够验证 mount 的行为 */
function fakeDom() {
  const doc = { defs: null };
  class Node {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.attrs = {}; this.childNodes = []; this._text = ''; this.ownerDocument = doc; }
    get firstChild() { return this.childNodes[0] || null; }
    get firstElementChild() { return this.childNodes.find((c) => c.tagName) || null; }
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
    setAttribute(n, v) { this.attrs[n] = String(v); }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); this.childNodes = this.childNodes.filter((c) => !c.tagName); }
    appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
    removeChild(c) { this.childNodes = this.childNodes.filter((x) => x !== c); return c; }
    insertBefore(c, ref) { c.parentNode = this; this.childNodes.unshift(c); void ref; return c; }
    insertAdjacentHTML(pos, html) {
      if (pos !== 'afterbegin') return;
      if (/class="ww-icon/.test(html)) {
        const svg = new Node('svg');
        svg.setAttribute('class', 'ww-icon');
        svg.setAttribute('data-fake', 'icon');
        this.childNodes.unshift(svg);
      }
    }
    set innerHTML(html) { this.childNodes = []; if (/id="ww-icon-defs"/.test(html)) { const s = new Node('svg'); s.setAttribute('id', 'ww-icon-defs'); this.appendChild(s); } }
    get innerHTML() { return ''; }
    _all(out = []) { for (const c of this.childNodes) if (c.tagName) { out.push(c); c._all(out); } return out; }
    querySelector(sel) {
      if (sel === 'svg.ww-icon') return this._all().find((c) => c.tagName === 'SVG' && /ww-icon/.test(c.getAttribute('class') || '')) || null;
      return null;
    }
    querySelectorAll(sel) {
      const key = /^\[([^\]]+)\]$/.exec(sel);
      if (!key) return [];
      return this._all().filter((c) => c.getAttribute(key[1]) != null);
    }
  }
  doc.createElement = (t) => new Node(t);
  doc.getElementById = (id) => (id === 'ww-icon-defs' ? (doc.defs = doc.defs || null) : null);
  doc.body = new Node('body');
  // getElementById 需要真的能查到已注入的 defs：用 _all 兜住
  doc.getElementById = (id) => doc.body._all().find((c) => c.getAttribute('id') === id) || null;
  return { doc, Node };
}

test('mount：注入 defs 一次、给标记元素画上徽记，并支持 i18n 重刷后重画（幂等）', () => {
  const { doc, Node } = fakeDom();
  const btn = new Node('button');
  btn.setAttribute('data-ww-icon', 'codex');
  btn.textContent = '📖 角色图鉴';
  doc.body.appendChild(btn);

  assert.strictEqual(WWIcons.mount(doc.body, doc), 1, 'mount 应画 1 个');
  assert.ok(doc.getElementById('ww-icon-defs'), 'mount 应先注入 defs');
  assert.strictEqual(btn.textContent, '角色图鉴', `文字应去掉前导字形，实际 ${JSON.stringify(btn.textContent)}`);
  assert.ok(btn.querySelector('svg.ww-icon'), '按钮里应有徽记');

  // 幂等：再 mount 一次不应叠加徽记
  assert.strictEqual(WWIcons.mount(doc.body, doc), 1);
  assert.strictEqual((btn.childNodes.filter((c) => c.tagName === 'SVG')).length, 1, '重复 mount 叠加了徽记');
  assert.strictEqual(btn.textContent, '角色图鉴');

  // 模拟 applyI18n：把词典文案（仍带 emoji）整块写回 textContent —— 徽记被抹掉
  btn.textContent = '📖 角色图鉴';
  assert.strictEqual(btn.querySelector('svg.ww-icon'), null, '假 DOM 未按预期抹掉徽记');
  assert.strictEqual(WWIcons.mount(doc.body, doc), 1, 'i18n 之后重画应再次生效');
  assert.strictEqual(btn.textContent, '角色图鉴');
  assert.strictEqual((btn.childNodes.filter((c) => c.tagName === 'SVG')).length, 1);
});

test('mount：未标 data-ww-icon 的节点一个都不碰（内容里的 emoji 必须原样留着）', () => {
  const { doc, Node } = fakeDom();
  const p = new Node('p');
  p.textContent = '好人 🎉 获胜！';
  doc.body.appendChild(p);
  const btn = new Node('button');
  btn.setAttribute('data-ww-icon', 'nope'); // 白名单外
  btn.textContent = '🃏 随便';
  doc.body.appendChild(btn);

  assert.strictEqual(WWIcons.mount(doc.body, doc), 0, '没有合法标记时不应画任何徽记');
  assert.strictEqual(p.textContent, '好人 🎉 获胜！', '未标记节点的内容被改了');
  assert.strictEqual(btn.textContent, '🃏 随便', '非法标记的节点被改了');
});
