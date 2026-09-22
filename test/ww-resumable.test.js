/**
 * ww-resumable.test.js — 历史遗留键 `ww_resumable` 的两条不变量（A3b）
 *
 * 背景（已实测）：该键由 37555ae 引入（`setItem`/`getItem` 配合 `resumeFromAnchor` 使用），
 * 493ec8f 把"从存档恢复"整体迁到 `SessionModel` + `ww_current` 之后，全仓库只剩下
 * `web/app.js` 里两处 `localStorage.removeItem('ww_resumable')`。这一批的结论是
 * **加注释固化、不删** —— 那两行负责清掉**老用户浏览器里那份残留值**；删掉它们不叫"清理代码"，
 * 而是让一个界面永远读不到、测试也不覆盖的值永久留在用户的 localStorage 里。
 *
 * 所以这里钉两件事（都能独立判红）：
 *   ① 该键**只允许以 `removeItem('ww_resumable')` 的清理形态出现**：任何 `setItem`/`getItem`
 *      或经存储助手读写它的写法都判红 —— 一旦有人重新启用这个键，就必须同时补行为测试，
 *      这条守卫会先把"重新启用却没有测试"的静默回归拦下来；
 *   ② `web/app.js` 里那两处兼容清理必须**还在**（少于两处 = 有人把它们删了）。
 *
 * 扫描口径：只扫**源码根**（`web/` 桌面与手机前端、`src/` 服务端、`scripts/` 验收脚本、
 * `test/` 断言本体）—— 这是 localStorage 的读写唯一可能出现的地方；`release/`、`app/android`、
 * `desktop/dist` 这些**历史构建产物/打好的分发包**里当然还留着 1.4/1.5 时代那套真机制
 * （setItem/getItem + resumeFromAnchor），把它们算进来只会让守卫永远误红。
 * 注释行不算（说明这个键"是什么"的注释是本次交付的一部分），本文件自身也不算。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SELF = path.join(__dirname, 'ww-resumable.test.js');
const KEY = 'ww_resumable';
const EXT = new Set(['.js', '.mjs', '.cjs', '.html']);
/** 源码根（相对仓库根）。只扫这里：构建产物里的历史副本不算"有人重新启用了它"。 */
const SRC_ROOTS = ['web', 'src', 'scripts', 'test'];
const SKIP_DIR = new Set(['node_modules', '.git', 'saves', 'logs', 'output', 'release', 'dist', 'coverage', 'android']);

const CLEANUP_RE = new RegExp(`\\bremoveItem\\s*\\(\\s*['"\`]${KEY}['"\`]`);
/** 注释行：`// …`、`/* …`、` * …`（说明这个键来历的注释不算"使用"） */
const COMMENT_RE = /^\s*(\/\/|\/\*|\*)/;

/** 收集源码根里的候选文本文件（相对路径 → 内容） */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIR.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (p === SELF) continue;
      if (!EXT.has(path.extname(e.name).toLowerCase())) continue;
      out.push({ rel: path.relative(ROOT, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
    }
  };
  for (const root of SRC_ROOTS) walk(path.join(ROOT, root));
  return out;
}

/** 该键在各文件里的**非注释**出现（行号 + 原文），供两条用例共用 */
function occurrences() {
  const hits = [];
  for (const { rel, text } of sources()) {
    text.split('\n').forEach((line, i) => {
      if (!line.includes(KEY)) return;
      if (COMMENT_RE.test(line)) return;
      hits.push({ rel, line: i + 1, text: line.trim() });
    });
  }
  return hits;
}

test(`遗留键 ${KEY}：只允许以 removeItem 的清理形态出现（不得 setItem/getItem 或经助手读写）`, () => {
  const bad = occurrences()
    .filter((h) => !CLEANUP_RE.test(h.text))
    .map((h) => `  ✖ ${h.rel}:${h.line} 不是清理形态：${h.text.slice(0, 120)}`);
  assert.deepStrictEqual(
    bad,
    [],
    `${KEY} 是历史遗留键：重新启用它必须同时补行为测试，不能只把读写加回来。\n`
    + `只允许「localStorage.removeItem('${KEY}')」这一种形态：\n${bad.join('\n')}`,
  );
});

test(`遗留键 ${KEY}：web/app.js 里两处向后兼容清理必须保留（删掉就是永远留下垃圾键）`, () => {
  const app = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
  const n = (app.match(new RegExp(`localStorage\\.removeItem\\(['"]${KEY}['"]\\)`, 'g')) || []).length;
  assert.ok(
    n >= 2,
    `web/app.js 里的 ${KEY} 清理只剩 ${n} 处（应为 2 处：放弃并清除草稿 / 成功恢复后）。`
    + '删掉它们不会清理代码，只会让老用户浏览器里那份残留值永远留在 localStorage。',
  );
});
