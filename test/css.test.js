/**
 * css.test.js — 样式表的三类"静默失效"守卫
 *
 * 这三条都是本次 UI 改造中真实踩到的坑，而且共同特点是**不报错、只在界面上表现为"说不清哪里不对"**：
 *
 * 1) 同一文件里同一选择器写了两次 → 后者覆盖前者。
 *    实例：给手机自定义板子的 ± 按钮改成 40px 后，文件末尾还留着旧的 26px 规则，
 *    同权重下后者胜出，改动**看起来完全没生效**（我为此多跑了一轮浏览器验证）。
 * 2) `var(--x)` 引用了没定义的变量且没写兜底 → 整条声明被丢弃（CSS 的 invalid at computed-value time）。
 *    实例：`--band` 只定义在 .card-frame 上，而角色名是它的**兄弟节点**（自定义属性不跨兄弟继承），
 *    于是 `left/bottom: var(--band)` 整条失效，角色名掉到卡外面。
 * 3) 文本文件不是合法 UTF-8 → 浏览器按 charset=utf-8 解析出乱码。
 *    实例：用 PowerShell 的 Add-Content 追加样式，在 Windows 上按 ANSI(GBK) 落盘，
 *    web/style.css 与 web/m/m.css 尾部的中文注释全成了乱码（内容恰好在注释里才没影响渲染）。
 *
 * 这些都不该靠"下次注意"，所以钉成测试。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSS_FILES = ['web/shared/tokens.css', 'web/style.css', 'web/m/m.css'];
const TEXT_EXT = new Set(['.js', '.json', '.css', '.html', '.md', '.webmanifest']);
const SKIP_DIR = new Set(['node_modules', '.git', 'saves', 'logs', 'app', 'android', 'dist', 'coverage']);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * 极简 CSS 扫描：按大括号层级记录 (上下文, 选择器, 行号, 属性集合)。
 * 上下文 = 所在 @ 块的名字（@media 条件 / @keyframes 名）——
 * 同一选择器在不同媒体查询或不同关键帧里重复是合理的（如各 @keyframes 的 from/to）。
 * 先用空格替换注释（保留换行），否则注释会被当成选择器文本的一部分，
 * 导致紧跟注释的 @media 识别不出来（踩过一次，误报 .rule-order 重复）。
 * 同时解析每个规则块设置的属性名 —— 只有**属性真正重叠**时，后写的才会覆盖前面的，
 * 否则 `* { box-sizing }` 与 `* { scrollbar-width }` 这种拆分写法会被误报。
 */
function collectSelectors(cssRaw) {
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const found = []; // { ctx, sel, line, props }
  const stack = []; // { type: 'at'|'rule', sel, line, bodyStart }
  let buf = '';
  let line = 1;
  let bufLine = 1;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '\n') line++;
    if (ch === '{') {
      const sel = buf.trim();
      if (sel.startsWith('@')) stack.push({ type: 'at', sel, line: bufLine });
      else stack.push({ type: 'rule', sel, line: bufLine, bodyStart: i + 1 });
      buf = '';
    } else if (ch === '}') {
      const top = stack.pop();
      if (top && top.type === 'rule' && top.sel) {
        const body = css.slice(top.bodyStart, i).replace(/url\([^)]*\)/g, 'url()');
        const props = new Set([...body.matchAll(/(?:^|[;{])\s*([-\w]+)\s*:/g)].map((m) => m[1]));
        found.push({
          ctx:
            stack
              .filter((s) => s.type === 'at')
              .map((s) => s.sel)
              .join(' && ') || 'root',
          sel: top.sel,
          line: top.line,
          props,
        });
      }
      buf = '';
    } else {
      if (!buf.trim() && ch.trim()) bufLine = line;
      buf += ch;
    }
  }
  return found;
}

test('样式表：同一上下文里不得重复定义同一属性（后者会静默覆盖前者）', () => {
  const problems = [];
  for (const f of CSS_FILES) {
    const seen = new Map(); // key -> [ { line, props } ]
    for (const { ctx, sel, line, props } of collectSelectors(read(f))) {
      const key = `${ctx} || ${sel.replace(/\s+/g, ' ')}`;
      for (const prev of seen.get(key) || []) {
        const overlap = [...props].filter((p) => prev.props.has(p));
        if (overlap.length) problems.push(`${f}:${line} 覆盖 :${prev.line} 的「${sel}」属性 ${overlap.join('/')}`);
      }
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push({ line, props });
    }
  }
  assert.deepStrictEqual(problems, [], `重复设置同一属性：\n${problems.join('\n')}`);
});

test('样式表：var(--x) 引用的变量必须有定义，或写了兜底值', () => {
  const all = CSS_FILES.map(read).join('\n');
  const defined = new Set([...all.matchAll(/(^|[;{\s])(--[\w-]+)\s*:/g)].map((m) => m[2]));
  assert.ok(defined.size > 20, `解析到的变量太少（${defined.size}），解析可能失效`);
  const problems = [];
  for (const f of CSS_FILES) {
    const css = read(f);
    css.split('\n').forEach((text, i) => {
      for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
        const [, name, next] = m;
        if (next === ')') {
          // 无兜底：变量必须存在（含 :root 与继承来源）
          const localOk = css.includes(`${name}:`) || css.includes(`${name} :`);
          if (!defined.has(name) && !localOk) problems.push(`${f}:${i + 1} var(${name}) 未定义且无兜底`);
        }
      }
    });
  }
  // 允许"同文件后面才定义"的情况，但跨文件必须能找到定义
  const real = problems.filter((p) => {
    const name = p.match(/var\((--[\w-]+)\)/)[1];
    return !defined.has(name);
  });
  assert.deepStrictEqual(real, [], `未定义变量：\n${real.join('\n')}`);
});

test('文本文件必须都是合法 UTF-8（PowerShell Add-Content 曾按 GBK 落盘，中文注释全成乱码）', () => {
  const bad = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIR.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
      const buf = fs.readFileSync(p);
      if (buf.toString('utf8').includes('\uFFFD')) bad.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  assert.deepStrictEqual(bad, [], `非 UTF-8 文件：${bad.join('、')}`);
});

/**
 * 4) 简写与长写混用导致的**隐式重置** —— 两次真实故障同源，必须钉住：
 *    · 复选框"点了勾不上"：同一块里先 `background` 简写、后又 `background-image`，
 *      简写里的填充色被顶掉 → 填充透明 → 深色勾在深底上看不见；
 *    · 下拉框箭头消失：`select:hover` / `:focus` 用 `background` 简写，
 *      把上面那条内嵌金色箭头（background-image）一起重置，一悬停/一聚焦箭头就凭空没了。
 * 规则：① 同一块内不得同时出现 background 简写与 background-image 长写；
 *      ② 自身带箭头的 select，其 hover/focus 只能用 background-color。
 */
test('样式表：background 简写不得顶掉 background-image（复选框填充 / 下拉箭头两次事故同源）', () => {
  const problems = [];
  for (const f of CSS_FILES) {
    for (const { sel, line, props } of collectSelectors(read(f))) {
      // ① 同一块内简写 + 长写并存：简写会重置长写
      if (props.has('background') && props.has('background-image')) {
        problems.push(`${f}:${line} 「${sel}」同一块里同时写了 background 简写与 background-image`);
      }
      // ② 带内嵌箭头的 select（箭头规则见 style.css「下拉：去掉原生箭头」），hover/focus 不得用简写
      if (/\bselect\b/.test(sel) && /:hover|:focus/.test(sel) && props.has('background')) {
        problems.push(`${f}:${line} 「${sel}」用了 background 简写 —— 会把内嵌箭头一起重置（应用 background-color）`);
      }
    }
  }
  assert.deepStrictEqual(problems, [], `简写/长写混用：\n${problems.join('\n')}`);
});

/* ============================================================
   §3 视觉系统的防复发判据（M1 / FIX-22 收口）
   ------------------------------------------------------------
   上面三条守卫管的是"样式静默失效"；这一节管的是**计划书 §3 的硬要求不被悄悄改回去**：
     · §3 行 62-69 六色语义：只能在 web/shared/tokens.css 定义一次，
       各页面/样式表不得再写同值字面量（FIX-22 的"残留硬编码金色"就是这类字面量长出来的）；
     · §3 行 74-76：字号下限（桌面正文 14 / 手机正文 16 / 辅助文字 ≥12 / 手机输入 ≥16）
       与触区下限（桌面普通 ≥40、桌面主要 ≥44、手机常用 ≥48、手机确认 52）
       —— 判据取**解析后的计算值**（var() 链展开），所以"把令牌调低"和"就地写小值"都会红；
     · §3 行 78：下拉箭头这类共用图标只保留一份 data-URI；
     · §3 行 77：危险操作不能只靠红色表达（两端"结束本局"类条目必须带可见文案）。
   另有两条"接线"判据：任何引用了样式表的页面都必须能到达 tokens.css（直链或 @import 链）；
   离线页的内联令牌镜像必须与正本逐项一致（test/pwa.test.js 不允许它外链，镜像只能内联）。
   ============================================================ */
const TOKENS_CSS = 'web/shared/tokens.css';

/** §3 行 62-69 六色语义（规范化比较：十六进制大小写等价，见计划书写的是大写、样式表写小写） */
const SEM_COLORS = [
  ['--sem-bg', '#06090f', '页面背景'],
  ['--sem-panel', '#0f1626', '内容面板'],
  ['--sem-ink', '#ebe4d7', '正文骨白'],
  ['--sem-gold', '#d8b25f', '主操作古金'],
  ['--sem-moon', '#dbe6ff', '焦点/月光'],
  ['--sem-danger', '#b3323f', '危险/狼性'],
];
/** §3 行 74-76 下限令牌 */
const FLOOR_TOKENS = [
  ['--fs-body-desktop', '14px'], ['--fs-body-mobile', '16px'],
  ['--fs-aux-min', '12px'], ['--fs-input-mobile', '16px'],
  ['--h-ctl-min', '40px'], ['--h-main-min', '44px'],
  ['--h-touch-min', '48px'], ['--h-touch-main', '52px'],
];
/** 触区下限接线点：选择器 → { 文件, 令牌, 下限 }（判据取解析后的计算值） */
const TOUCH_WIRING = [
  ['web/style.css', '.btn', '--h-ctl-min', 40],
  ['web/style.css', '.btn.primary', '--h-main-min', 44],
  ['web/m/m.css', '#m-app .btn', '--h-touch-min', 48],
  ['web/m/m.css', '#m-app .btn.primary, #m-app .btn.big', '--h-touch-main', 52],
  ['web/m/m.css', '.m-keys .key', '--h-touch-min', 48],
  ['web/m/m.css', '.m-keys .key[data-confirm]', '--h-touch-main', 52],
  // M1 手机触区收口（计划书 §3 行75）：下面 3 条是实测真的 <48 的触区，且各自就是胜出规则。
  // 另外 5 处（.key / .key.seat / .m-keys .btn / .m-dialog .btnrow .btn / .m-profile-row .btn）
  // 的收小声明已被上面 #m-app .btn / .m-keys .key 这类更高优先级的规则压住（实测已 48），
  // 生效规则已在本表内，故不重复接线（避免"钉住死规则"造成的假安心）。
  // .m-sheet-foot .btn 原先也在这张表里；它的 min-height 已被 #m-sheet .btn 取代并删除（§3 行81），
  // 触区下限由下面 #m-sheet .btn 那条守卫直接守住，故不再保留指向已删声明的接线。
  ['web/m/m.css', '.cdx-pager button', '--h-touch-min', 48],
  ['web/m/m.css', '.m-tabs .m-tab-btn', '--h-touch-min', 48],
  ['web/m/m.css', '.m-to-bottom', '--h-touch-min', 48],
  // M1 第二组（#m-app 之外的三个同级容器：翻牌页 / 贴底弹层 / 中部弹窗）：
  // 实测这些容器的按钮只有 40/44（#m-app .btn 那组兜底够不到），各自就地建立下限后的接线。
  // 用全局令牌 --h-touch-min(48) / --h-touch-main(52)；--hctl-m 是 #m-app 作用域别名，容器外解析不到。
  // 每条都是所在容器里**胜出**的那条（成对写：容器 .btn + 容器 .btn.primary）。
  ['web/m/m.css', '.flip-tools .btn', '--h-touch-min', 48],
  ['web/m/m.css', '.flip-tools .btn.primary', '--h-touch-main', 52],
  ['web/m/m.css', '#m-sheet .btn', '--h-touch-min', 48],
  ['web/m/m.css', '#m-sheet .btn.primary', '--h-touch-main', 52],
  ['web/m/m.css', '#m-modal .btn', '--h-touch-min', 48],
  ['web/m/m.css', '#m-modal .btn.primary', '--h-touch-main', 52],
  ['web/m/m.css', '#m-modal .gear-item', '--h-touch-min', 48],
  // M1 桌面触区收口（计划书 §3 行75：桌面普通 ≥40、主要 ≥44）——
  // 下面 4 条都是主控实测真的 <40 的**桌面**触区，且各自就是所在容器里胜出的那条规则
  // （手机端那一档 ≥48 已由上面 #m-app / #m-sheet / #m-modal 几条守住，本次不动 m.css）：
  //   · .role-row button（板子编辑器 − / +，web/app.js:351-353 生成）实测 26，且无 .btn 兜底；
  //   · .chip 实测 36（共享组件：桌面 #action-controls 选目标胶囊、桌面标注编辑器里的倾向/把握/候选身份）；
  //   · .seat-tabs .chip 实测 36（圆桌/列表切换）：特异性 (0,2,0) 高于 .chip，必须单独接线，
  //     否则"改 .chip"会被它按后者胜出压回 36（这正是本条存在的理由）；
  //   · .new-msg-pill 实测 36（局中"↓ 有新发言"胶囊，桌面独有控件）。
  // 反面钉住：.chip.av-chip（内置徽记 chip）自己的下限是 --h-touch-min（48）且特异性更高，
  // 不能被 .chip 这次改动拖低 —— 单独接线，值仍取 48（§3：不得缩小任何既有触区）。
  ['web/style.css', '.role-row button', '--h-ctl-min', 40],
  ['web/style.css', '.chip', '--h-ctl-min', 40],
  ['web/style.css', '.seat-tabs .chip', '--h-ctl-min', 40],
  ['web/style.css', '.new-msg-pill', '--h-ctl-min', 40],
  ['web/style.css', '.chip.av-chip', '--h-touch-min', 48],
];

/** 取某个选择器的规则体（行首 `sel {` 起、按大括号配对收；允许缩进，@media 里的规则也能取到） */
function ruleBody(css, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hit = new RegExp('(?:^|\\n)[ \\t]*' + esc + '\\s*\\{').exec(css);
  if (!hit) return null;
  const start = css.indexOf('{', hit.index);
  let depth = 0;
  for (let j = start; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}') {
      depth--;
      if (depth === 0) return css.slice(start + 1, j);
    }
  }
  return null;
}

/** 默认作用域（tokens.css :root / style.css :root / m.css #m-app）里的自定义属性表 */
function defaultTokenTable() {
  const table = new Map();
  const scopes = [[TOKENS_CSS, ':root'], ['web/style.css', ':root'], ['web/m/m.css', '#m-app']];
  for (const [f, sel] of scopes) {
    const body = ruleBody(read(f), sel);
    if (!body) continue;
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) table.set(m[1], m[2].trim());
  }
  return table;
}

/** 展开 var() 链（含 `var(--a, fallback)` 兜底），拿到可比较的计算值 */
function resolveValue(value, table, depth = 0) {
  if (depth > 12) return value;
  const m = /var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)/.exec(value);
  if (!m) return value;
  const fallback = m[2] === undefined ? null : m[2].trim();
  const repl = table.has(m[1])
    ? resolveValue(table.get(m[1]), table, depth + 1)
    : (fallback === null ? 'undefined' : resolveValue(fallback, table, depth + 1));
  return resolveValue(value.slice(0, m.index) + repl + value.slice(m.index + m[0].length), table, depth + 1);
}

/** 取长度值里的 px 数字（拿不到就返回 null） */
function pxOf(value) {
  const m = /(-?\d+(?:\.\d+)?)px/.exec(String(value));
  return m ? parseFloat(m[1]) : null;
}

/** 规范化：hex 统一小写、RGB 三元组去掉多余空格 */
const normColor = (v) => String(v).trim().toLowerCase().replace(/\s*,\s*/g, ',');

/** 去掉注释但保留换行，行号因此不变（判据只看"真正会被浏览器读到的字节"） */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (t) => t.replace(/[^\n]/g, ' '));

/** 列出 web/ 下指定扩展名的文件（仓库相对 POSIX 路径；跳过 node_modules/打包产物等） */
function walkWeb(exts) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIR.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.some((x) => e.name.endsWith(x))) out.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  };
  walk(path.join(ROOT, 'web'));
  return out.sort();
}

const parseHex = (hex) => [
  parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
];

/** 扫一个样式表文本里所有"裸 #rrggbb"字面量（注释与 url 里的 %23 转义形式都不算） */
function hexLiterals(cssRaw) {
  const out = [];
  const css = stripComments(cssRaw);
  css.split('\n').forEach((text, i) => {
    for (const m of text.matchAll(/#[0-9a-fA-F]{6}\b/g)) out.push({ line: i + 1, hex: m[0].toLowerCase(), text: text.trim() });
  });
  return out;
}

test('§3 行62-69：六色语义只在共享令牌层定义一次，样式表里不得再写同值字面量（FIX-22 防复发）', () => {
  const tokens = read(TOKENS_CSS);
  const all = CSS_FILES.map(read).join('\n');
  const problems = [];
  for (const [name, value, label] of SEM_COLORS) {
    // ① 正本取值与计划书一致（规范化后比较：hex 大小写等价）
    const decl = tokens.match(new RegExp(name + '\\s*:\\s*([^;}]+)'));
    if (!decl) problems.push(`${TOKENS_CSS} 缺少 ${name}（${label}）`);
    else if (normColor(decl[1]) !== normColor(value)) problems.push(`${name} = ${decl[1].trim()}，§3 要求 ${value}`);
    // ② 三个样式表里只允许出现一次定义
    const defs = [...all.matchAll(new RegExp('(?:^|[;{\\s])' + name + '\\s*:', 'gm'))];
    if (defs.length !== 1) problems.push(`${name} 在三份样式表里被定义 ${defs.length} 次（应只 1 次）`);
  }
  // ③ style.css / m.css 不得再出现六色的裸 hex
  for (const f of ['web/style.css', 'web/m/m.css']) {
    for (const { line, hex, text } of hexLiterals(read(f))) {
      if (SEM_COLORS.some(([, v]) => v === hex)) problems.push(`${f}:${line} 仍写死 §3 语义色 ${hex}（应用令牌）：「${text.slice(0, 60)}」`);
    }
  }
  // ④ tokens.css 之外的词法约束：令牌层里的裸 hex 必须是"某个自定义属性的定义"
  for (const { line, hex, text } of hexLiterals(tokens)) {
    if (!/^\s*--[\w-]+\s*:/.test(text)) problems.push(`${TOKENS_CSS}:${line} 的裸 hex ${hex} 不在任何令牌定义行上`);
  }
  // ⑤ 六色的 RGB 三元组令牌必须与对应主令牌同色（否则 rgba(var(--sem-x-rgb),1) ≠ var(--sem-x)）
  for (const [name, value] of SEM_COLORS) {
    const rgbaName = name + '-rgb';
    const decl = tokens.match(new RegExp(rgbaName + '\\s*:\\s*([^;}]+)'));
    if (!decl) { problems.push(`${TOKENS_CSS} 缺少 ${rgbaName}（${name} 的半透明形式要用）`); continue; }
    if (normColor(decl[1]) !== parseHex(value).join(',')) {
      problems.push(`${rgbaName} = ${decl[1].trim()} ≠ rgb(${value}) = ${parseHex(value).join(',')}`);
    }
  }
  // ⑥ 半透明层必须走 RGB 三元组令牌，不得再散写 rgba(216,178,95,…) 这类原色。
  //    注释里的示例写法不算（注释不参与渲染，且这里要能自解释）。
  const rgbTriples = SEM_COLORS.map(([, v]) => parseHex(v).join(','));
  for (const f of CSS_FILES) {
    const css = stripComments(read(f));
    css.split('\n').forEach((text, i) => {
      for (const m of text.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*[,)]/g)) {
        const key = [m[1], m[2], m[3]].join(',');
        if (rgbTriples.includes(key)) {
          // 允许的唯一形态：rgba(var(--sem-*-rgb), …) —— 上面那条正则正是用来抓"没走令牌"的
          problems.push(`${f}:${i + 1} 半透明层仍写死 ${'rgba(' + m[0].slice(5)}（应写成 rgba(var(--sem-x-rgb), …)）`);
        }
      }
    });
  }
  assert.deepStrictEqual(problems, [], `§3 语义令牌问题：\n${problems.join('\n')}`);
});

test('§3 行74-76：字号/触区下限（判据取解析后的计算值，把值调低必须红）', () => {
  const tokens = read(TOKENS_CSS);
  const table = defaultTokenTable();
  const problems = [];
  // ① 下限令牌本身的值
  for (const [name, value] of FLOOR_TOKENS) {
    const decl = tokens.match(new RegExp(name + '\\s*:\\s*([^;}]+)'));
    if (!decl) problems.push(`${TOKENS_CSS} 缺少下限令牌 ${name}`);
    else if (decl[1].trim() !== value) problems.push(`${name} = ${decl[1].trim()}，下限要求 ${value}`);
  }
  // ② 接线的计算值（令牌被调低或就地写小值都会在这里红）
  for (const [f, sel, token, floor] of TOUCH_WIRING) {
    const body = ruleBody(read(f), sel);
    if (!body) { problems.push(`${f} 找不到规则 ${sel}`); continue; }
    const decl = body.match(/min-height\s*:\s*([^;]+)/);
    if (!decl) { problems.push(`${f} 的 ${sel} 没有 min-height`); continue; }
    const resolved = resolveValue(decl[1].trim(), table);
    const px = pxOf(resolved);
    if (px === null) problems.push(`${f} 的 ${sel} min-height 解析不出 px：${decl[1].trim()} → ${resolved}`);
    else if (px < floor) problems.push(`${f} 的 ${sel} min-height = ${px}px < ${floor}px（${token}）`);
  }
  // ③ 辅助文字令牌 ≥12，且任何 font-size / font 简写都不得低于 12px
  for (const name of ['--fs-xs', '--fs-sm']) {
    const px = pxOf(resolveValue(table.get(name) || '', table));
    if (px === null || px < 12) problems.push(`${name} 解析为 ${table.get(name)}（<12px）`);
  }
  for (const f of ['web/style.css', 'web/m/m.css']) {
    read(f).split('\n').forEach((text, i) => {
      const sizes = [
        ...[...text.matchAll(/font-size\s*:\s*([^;}]+)/g)].map((m) => m[1]),
        ...[...text.matchAll(/(?:^|[;{\s])font\s*:\s*([^;}]+)/g)].map((m) => m[1]),
      ];
      for (const raw of sizes) {
        const px = pxOf(resolveValue(raw.trim(), table));
        if (px !== null && px < 12) problems.push(`${f}:${i + 1} 文字 ${px}px < 12px（§3 行74）：「${text.trim().slice(0, 70)}」`);
      }
    });
  }
  // ④ §3 行76：缩小字号 / 紧凑布局不得改小最低触区（偏好块里不许出现 --h*令牌）
  const prefs = read('web/style.css');
  for (const sel of ['html[data-pref-font="sm"]', 'html[data-pref-font="lg"]', 'html[data-pref-layout="compact"]']) {
    const body = ruleBody(prefs, sel);
    if (!body) { problems.push(`style.css 找不到偏好块 ${sel}`); continue; }
    if (/--h[\w-]*\s*:/.test(body)) problems.push(`${sel} 改了触区令牌（§3 行76 禁止）`);
  }
  assert.deepStrictEqual(problems, [], `§3 下限问题：\n${problems.join('\n')}`);
});

test('§3 行78：下拉箭头这类共用图标只留一份 data-URI（收在共享令牌层）', () => {
  const uri = /url\("data:image\/svg\+xml[^"]*M1 1\.5 6 6\.5l5-5[^"]*"\)/g;
  const inTokens = (read(TOKENS_CSS).match(uri) || []).length;
  assert.strictEqual(inTokens, 1, `${TOKENS_CSS} 应恰好持有 1 份金色下拉箭头 data-URI（实际 ${inTokens}）`);
  for (const f of ['web/style.css', 'web/m/m.css']) {
    const n = (read(f).match(uri) || []).length;
    assert.strictEqual(n, 0, `${f} 仍内联了下拉箭头 data-URI（${n} 份），应改引 var(--ico-chevron-gold)`);
    assert.match(read(f), /background-image:\s*var\(--ico-chevron-gold\)/, `${f} 没有引用 --ico-chevron-gold`);
  }
});

test('每个引用了样式表的页面都必须能到达 tokens.css（直链或 @import 链）', () => {
  const pages = walkWeb(['.html']);
  assert.ok(pages.length >= 3, `扫到的页面太少（${pages.length}），解析可能失效`);
  const missing = [];
  for (const page of pages) {
    const html = read(page);
    const links = [...html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/g)]
      .map((m) => (m[0].match(/\bhref=["']([^"']+)["']/) || [])[1])
      .filter(Boolean);
    if (!links.length) {
      // 自足页面（离线页）：必须内联样式，且镜像由下一条用例比对
      if (!/<style>/.test(html)) missing.push(`${page} 既没有样式表链接、也没有内联 <style>`);
      continue;
    }
    const dir = path.posix.dirname(page);
    const abs = (href) => path.posix.normalize(path.posix.join(dir, href.split('?')[0]));
    const direct = links.map(abs).includes(TOKENS_CSS);
    const reached = direct || links.some((href) => {
      const seen = new Set();
      const stack = [abs(href)];
      while (stack.length) {
        const cur = stack.pop();
        if (seen.has(cur)) continue;
        seen.add(cur);
        if (cur === TOKENS_CSS) return true;
        if (!fs.existsSync(path.join(ROOT, cur))) continue;
        const css = read(cur);
        for (const m of css.matchAll(/@import\s+(?:url\()?["']([^"')]+)["']/g)) {
          stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(cur), m[1])));
        }
      }
      return false;
    });
    if (!reached) missing.push(`${page}（引 ${links.join('、')}）到达不了 ${TOKENS_CSS} —— 该页所有令牌都会失效`);
  }
  assert.deepStrictEqual(missing, [], `令牌层接线缺失：\n${missing.join('\n')}`);
});

test('离线页的令牌镜像必须与 web/shared/tokens.css 逐项一致（外链被禁，只能内联镜像）', () => {
  const mirror = ruleBody(read('web/offline.html'), ':root');
  assert.ok(mirror, 'offline.html 缺少内联 :root 镜像');
  const tokens = read(TOKENS_CSS);
  const problems = [];
  const names = [...SEM_COLORS.map(([n]) => n)];
  for (const m of tokens.matchAll(/(--sem-[\w-]+)\s*:\s*([^;}]+)/g)) if (!names.includes(m[1])) names.push(m[1]);
  // 另外这四个是 style.css 的既有令牌，离线页必须与那边同值
  const fromStyle = ['--muted', '--gold-bright', '--gold-dim', '--accent-dark'];
  const styleRoot = ruleBody(read('web/style.css'), ':root');
  for (const name of [...names, ...fromStyle]) {
    const src = name.startsWith('--sem-') ? tokens : styleRoot;
    const a = src.match(new RegExp(name + '\\s*:\\s*([^;}]+)'));
    const b = mirror.match(new RegExp(name + '\\s*:\\s*([^;}]+)'));
    if (!b) { problems.push(`离线页镜像缺少 ${name}`); continue; }
    if (!a) { problems.push(`正本里找不到 ${name}`); continue; }
    if (normColor(a[1]) !== normColor(b[1])) problems.push(`${name}: 镜像 ${b[1].trim()} ≠ 正本 ${a[1].trim()}`);
  }
  assert.deepStrictEqual(problems, [], `离线页令牌镜像过期：\n${problems.join('\n')}`);
});

test('§3 行77：危险操作不能只靠红色表达 —— 两端"结束本局"类条目必须带可见文案', () => {
  // 样式层：危险色的类是 .btn.danger / .gear-item.danger（两端都有）
  assert.match(read('web/style.css'), /\.btn\.danger\b/, 'style.css 缺少 .btn.danger');
  assert.match(read('web/style.css'), /\.gear-item\.danger\b/, 'style.css 缺少 .gear-item.danger');
  // 文案层：桌面 app.js 的齿轮菜单把"结束本局"作为**带文字**的条目推入，
  // 并且 danger 类是**按文案判定**加的（不是所有红按钮都危险，也不是危险只靠红）
  const app = read('web/app.js');
  assert.match(app, /items\.push\(\['[^']*结束本局'/, 'app.js 齿轮菜单缺少带文案的"结束本局"条目');
  assert.match(app, /\/结束本局\/\.test\(label\)[\s\S]{0,80}classList\.add\('danger'\)/,
    'app.js 的 danger 类必须由条目文案判定（保证"危险的都写了字"）');
  const mjs = read('web/m/m.js');
  assert.match(mjs, /结束本局/, 'm.js 齿轮菜单缺少带文案的"结束本局"条目（test/mobile-layout.test.js 也钉了这条）');
});

/* ------------------------------------------------------------
   FIX-22 收口：六色字面量在 web/** 的**分布**判据
   ------------------------------------------------------------
   为什么还要扫一遍全局："样式表里没有"不等于"仓库里没有"——本轮实测到的漏网形态有三种：
     · `<meta name="theme-color">`（meta 读不到 CSS 变量，只能是字面量 ✔ 有理由的例外）
     · JS 里拼出来的 SVG 属性（app.js 的 stroke，见下）
     · data-URI 里的 **URL 编码**形态 `%23d8b25f`（裸十六进制扫描抓不到，第一版守卫就漏了它）
   所以这里把所有形态一起扫，并且要求：**每一个命中都必须能对上一张精确白名单里的条目**
   （文件 + 该行必须逐字包含的片段 + 理由）；反过来，白名单里**没被用到的条目也要红** ——
   这样"有理由的例外"和"没人管的残留"在机器眼里是两件事，白名单也不会腐烂成摆设。
   ------------------------------------------------------------ */
const LITERAL_ALLOW = [
  ['web/ai-cast.html', '<meta name="theme-color" content="#06090f">', 'meta theme-color 在 CSS 之前就被浏览器读走，只能是字面量'],
  ['web/offline.html', '<meta name="theme-color" content="#06090f">', '同上'],
  ['web/offline.html', '--sem-bg: #06090f; --sem-panel: #0f1626; --sem-ink: #ebe4d7;', '离线页自足内联镜像（pwa.test.js 禁止它外链，镜像与正本的一致性由"镜像"用例钉住）'],
  ['web/offline.html', '--sem-gold: #d8b25f; --sem-moon: #dbe6ff; --sem-danger: #b3323f;', '同上'],
  ['web/app.js', "'rgba(216,178,95,.3)'", 'JS 拼 SVG stroke 属性，该处取不到 CSS 变量；本轮禁改 app.js（并行工作流在改）+ 单文件内容哈希连锁，登记为例外待收敛'],
];

/** 扫 web/**（排除共享令牌层）里的全部六色命中形态：裸 hex / %23 编码 / rgba 原色 */
function scanSemanticLiterals() {
  const lows = SEM_COLORS.map(([, v]) => v);
  const triples = SEM_COLORS.map(([, v]) => parseHex(v).join(','));
  const hits = [];
  for (const rel of walkWeb(['.html', '.js', '.css', '.json', '.webmanifest', '.svg'])) {
    if (rel === TOKENS_CSS) continue;
    const raw = read(rel);
    const text = rel.endsWith('.css') || rel.endsWith('.html') ? stripComments(raw) : raw;
    text.split('\n').forEach((line, i) => {
      const found = [];
      for (const m of line.matchAll(/#[0-9a-fA-F]{6}\b/g)) if (lows.includes(m[0].toLowerCase())) found.push(m[0]);
      for (const m of line.matchAll(/%23([0-9a-fA-F]{6})/g)) if (lows.includes('#' + m[1].toLowerCase())) found.push('%23' + m[1]);
      for (const m of line.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) if (triples.includes([m[1], m[2], m[3]].join(','))) found.push('rgb(' + [m[1], m[2], m[3]].join(',') + ')');
      if (found.length) hits.push({ rel, line: i + 1, found, text: line.trim() });
    });
  }
  return { hits };
}

test('§3 六色字面量：web/** 里每个命中都必须对得上精确白名单（含 %23 编码形态），白名单过期也红', () => {
  const { hits } = scanSemanticLiterals();
  const used = new Set();
  const violations = [];
  for (const h of hits) {
    const key = LITERAL_ALLOW.findIndex(([f, snippet]) => f === h.rel && h.text.includes(snippet));
    if (key < 0) violations.push(`${h.rel}:${h.line} 出现六色字面量 ${h.found.join('/')}（无白名单条目）：「${h.text.slice(0, 90)}」`);
    else used.add(key);
  }
  assert.deepStrictEqual(violations, [], `六色字面量漏网：\n${violations.join('\n')}`);
  const stale = LITERAL_ALLOW.map(([f, snippet], i) => (used.has(i) ? null : `${f} 的白名单条目已不再命中：「${snippet.slice(0, 60)}」`)).filter(Boolean);
  assert.deepStrictEqual(stale, [], `白名单过期（应当删除对应条目或恢复用法）：\n${stale.join('\n')}`);
  // 共享令牌层自身：%23 编码形态只允许出现在图标令牌那行
  const tokenHits = read(TOKENS_CSS).split('\n')
    .map((text, i) => ({ num: i + 1, text }))
    .filter(({ text }) => /%23[0-9a-fA-F]{6}/.test(text));
  for (const { num, text } of tokenHits) {
    if (!/^\s*--ico-[\w-]+\s*:/.test(text)) violations.push(`${TOKENS_CSS}:${num} 的 %23 编码色不在图标令牌定义行上`);
  }
  assert.deepStrictEqual(violations, [], `令牌层编码色越界：\n${violations.join('\n')}`);
});
