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
const CSS_FILES = ['web/style.css', 'web/m/m.css'];
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
  const found = [];       // { ctx, sel, line, props }
  const stack = [];       // { type: 'at'|'rule', sel, line, bodyStart }
  let buf = '';
  let line = 1;
  let bufLine = 1;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '\n') line++;
    if (ch === '{') {
      const sel = buf.trim();
      const ctx = stack.filter((s) => s.type === 'at').map((s) => s.sel).join(' && ') || 'root';
      if (sel.startsWith('@')) stack.push({ type: 'at', sel, line: bufLine });
      else stack.push({ type: 'rule', sel, line: bufLine, bodyStart: i + 1 });
      buf = '';
    } else if (ch === '}') {
      const top = stack.pop();
      if (top && top.type === 'rule' && top.sel) {
        const body = css.slice(top.bodyStart, i).replace(/url\([^)]*\)/g, 'url()');
        const props = new Set([...body.matchAll(/(?:^|[;{])\s*([-\w]+)\s*:/g)].map((m) => m[1]));
        found.push({ ctx: stack.filter((s) => s.type === 'at').map((s) => s.sel).join(' && ') || 'root', sel: top.sel, line: top.line, props });
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
      if (e.isDirectory()) { walk(p); continue; }
      if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
      const buf = fs.readFileSync(p);
      if (buf.toString('utf8').includes('\uFFFD')) bad.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  assert.deepStrictEqual(bad, [], `非 UTF-8 文件：${bad.join('、')}`);
});
