/**
 * eslint-scope.test.js — eslint 的作用域必须与 `.gitignore` 的真值一致（缺口 5）
 *
 * ══ 被钉住的缺陷 ═══════════════════════════════════════════════════════════════
 * `npm run lint`（scripts/lint.js）早已改成"生成物以 .gitignore 为真值"，而
 * `npx --no-install eslint .` 用的仍是 eslint.config.js 里的一张**手写目录表**。
 * 两个方向都真实出过偏差（实测数据在 scripts/eslint-ignores.js 文件头）：
 *   · 漏排：`output/playwright/` 被 .gitignore 忽略，却照样被 eslint 读进去
 *     （今天不炸只因为没有 `files` 块匹配它；那里面一旦有语法错误的 .js，`eslint .` 就判红）；
 *   · 误排：`app/**` 把**被 git 跟踪的源码**也排掉了（app/ 下 56 个被跟踪文件），
 *     `android/**`、`dist/**` 则是过期条目。
 *
 * ══ 判据（为什么不是"读一遍代码觉得对"）═══════════════════════════════════════
 * ① **独立重算**：本文件不调用被测的 `ignoredGlobs()` 来生成期望值，而是自己跑
 *    `git ls-files -z` / `git ls-files --others --ignored --exclude-standard --directory -z`，
 *    用自己的一份匹配器把"哪些路径该被排掉"重算一遍，再要求 eslint 配置里的 ignores **逐条相等**
 *    （既没有漏，也没有多 —— 多出来的一条可能是排掉了源码，少掉的一条可能是漏读了生成物）。
 * ② **语义钉子**：显式钉住"必须排掉的"（output/playwright、node_modules、saves、logs…）与
 *    "必须留在作用域里的"（每一个被 git 跟踪的 .js/.cjs/.mjs —— 一个都不许少；尤其
 *    `output/review-2026-09-20/reproduce.cjs` 这类住在"半忽略"目录里的被跟踪文件，
 *    以及旧手写表误排的 `app/` 下被跟踪文件）。
 * ③ **结构钉子**：第一段配置必须**只有** `ignores` 一个键 —— flat config 里只有"纯 ignores 对象"
 *    才是全局忽略；少这一个断言，将来把 ignores 挪进带 `files` 的块里，① 仍然会绿而 eslint
 *    其实已经不排任何东西了。
 * ④ **退化路径**：git 不可用时必须退回"绝不排源码"的静态兜底（而不是空手什么都不排，
 *    也不是把源码目录一起排掉）。
 *
 * 依赖：本文件需要 `git` 可执行文件（"什么被跟踪"本身就是 git 事实，没有 git 就无法判定，
 * 判红而不是跳过 —— 跳过会让这条保护重新回到"没人证明"的状态，与 test/lint-gitscope.test.js 同约定）。
 * eslint 本身的**真实行为**（退出码）在脱离仓库的拷贝里另行演示，见验收报告；
 * 本文件钉住的是"作用域声明 ≡ git 真值"这个可随时复算的不变量。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanupAfter } = require('./helpers-tmpdir');
const scope = require('../scripts/eslint-ignores');
const config = require('../eslint.config.js');

const ROOT = path.join(__dirname, '..');

/** 跑一条 git 命令；没有 git 直接判红（见文件头"依赖"） */
function git(args, cwd = ROOT) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) throw new Error(`本用例需要 git（作用域的真值来源）：${r.error.message}`);
  assert.strictEqual(r.status, 0, `git ${args.join(' ')} 失败（exit ${r.status}）：${String(r.stderr || '').trim()}`);
  return String(r.stdout || '');
}

/** `-z` 清单 → 正斜杠路径数组（`keepSlash` 时保留目录的尾斜杠，用它判"这是目录"） */
function zList(out, keepSlash = false) {
  return out
    .split('\0')
    .map((s) => s.split('\\').join('/'))
    .map((s) => (keepSlash ? s : s.replace(/\/+$/, '')))
    .filter(Boolean);
}

/**
 * 本用例**自己**的匹配器：把一条 ignore 条目套到一条相对路径上。
 * 生成器只允许产出两种形状（`d/**` 与精确文件路径），所以匹配器可以很小 ——
 * 形状的封闭性由下面 `assert` 里的"形状必须只有两种"钉住，避免匹配器与生成器一起漂移。
 */
function covers(glob, rel) {
  const g = String(glob).split('\\').join('/').replace(/\/+$/, '');
  const p = String(rel).split('\\').join('/').replace(/\/+$/, '');
  if (g.endsWith('/**')) {
    const base = g.slice(0, -3);
    return p === base || p.startsWith(base + '/');
  }
  return p === g;
}

/** 独立重算"该被排掉的条目"：规则只有一条 —— 被忽略条目里若住着被跟踪文件，就不排它 */
function recomputeIgnored(tracked, ignored) {
  const trackedKeys = tracked.map((t) => t.toLowerCase());
  const out = [];
  for (const raw of ignored) {
    const isDir = /\/$/.test(raw);
    const rel = raw.replace(/\/+$/, '');
    if (!rel) continue;
    const key = rel.toLowerCase();
    if (trackedKeys.some((t) => t === key || t.startsWith(key + '/'))) continue;
    out.push(isDir ? `${rel}/**` : rel);
  }
  return [...new Set(out)].sort();
}

const globsOf = (cfg) => cfg[0].ignores;

test('eslint 作用域①：ignores 必须逐条等于 git 真值的重算结果（不是手写目录表）', () => {
  assert.strictEqual(git(['rev-parse', '--is-inside-work-tree']).trim(), 'true', '前置：仓库根必须是 git 工作区');
  const tracked = zList(git(['ls-files', '-z']));
  const ignored = zList(git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']), true);
  assert.ok(tracked.length > 100, `前置：被跟踪文件应当有一批（实测 ${tracked.length}）——否则本用例会空转`);
  assert.ok(ignored.length > 0, '前置：仓库里应当存在被 .gitignore 忽略的条目——否则本用例会空转');

  const globs = globsOf(config);
  for (const g of globs) {
    assert.ok(g.endsWith('/**') || !g.includes('*'), `ignore 条目形状超出匹配器覆盖范围：${g}（要么是 d/**，要么是精确路径）`);
  }
  assert.deepStrictEqual(
    globs,
    recomputeIgnored(tracked, ignored),
    'eslint 的 ignores 与 .gitignore 的真值不一致：多了=可能排掉源码（或手写表回归），少了=生成的工件仍被 eslint 读',
  );
  // 顺带钉住"真值本身是活的"：漏排的那个目录必须在里面
  assert.ok(globs.includes('output/playwright/**'), 'output/playwright/ 被 .gitignore 忽略，必须落在 eslint 作用域之外');
});

test('eslint 作用域②：不许排掉任何被 git 跟踪的文件（每个 .js/.cjs/.mjs 都要在作用域里）', () => {
  const tracked = zList(git(['ls-files', '-z']));
  const scripts = tracked.filter((f) => /\.(?:js|cjs|mjs)$/.test(f));
  assert.ok(scripts.length > 100, `前置：被跟踪的脚本文件应当有一批（实测 ${scripts.length}）`);
  const globs = globsOf(config);
  const pruned = [];
  for (const f of tracked) {
    for (const g of globs) if (covers(g, f)) pruned.push(`${g}  ←  ${f}`);
  }
  assert.deepStrictEqual(pruned, [], 'eslint 的 ignores 排掉了被 git 跟踪的文件（方向反了：手写目录表把源码一起排掉）');
  // 一个都不许少的显式钉子（住"半忽略"目录里的被跟踪文件最容易被整目录排掉）
  for (const f of ['output/review-2026-09-20/reproduce.cjs', 'app/android/app/build.gradle', 'web/app.js', 'src/api.js']) {
    assert.ok(tracked.includes(f), `前置：${f} 应当被 git 跟踪（否则这条钉子没意义）`);
    assert.ok(!globs.some((g) => covers(g, f)), `${f} 被 git 跟踪，绝不能被 eslint 的 ignores 排掉`);
  }
});

test('eslint 作用域③：作用域是"全局忽略"，且第一段配置不得夹带 files/rules', () => {
  assert.deepStrictEqual(Object.keys(config[0]), ['ignores'], 'flat config 里只有"纯 ignores 对象"才是全局忽略');
  assert.ok(Array.isArray(config[0].ignores) && config[0].ignores.length > 0, '全局 ignores 不能是空表');
});

test('eslint 作用域④：git 不可用时退回"绝不排源码"的兜底（且兜底里没有源码目录）', (t) => {
  const dir = cleanupAfter(t, fs.mkdtempSync(path.join(os.tmpdir(), 'ww-eslint-scope-')));
  // %TEMP% 里不是 git 仓库（也不会向上找到本仓库）：真跑一次退化路径
  assert.deepStrictEqual(scope.ignoredGlobs(dir), scope.FALLBACK_GLOBS, 'git 不可用时必须退回静态兜底');

  const fallback = scope.FALLBACK_GLOBS;
  for (const g of fallback) {
    for (const src of ['src/api.js', 'test/eslint-scope.test.js', 'web/app.js', 'scripts/lint.js', 'server.js', 'eslint.config.js']) {
      assert.ok(!covers(g, src), `兜底名单里 ${g} 排到了源码 ${src} —— 兜底方向必须永远是"宁可多扫"`);
    }
  }
  // 纯函数的三条边界（每条都对应一个真实踩过的坑，见 scripts/eslint-ignores.js 文件头）
  assert.deepStrictEqual(
    scope.ignoredGlobsFromLists(['output/review-2026-09-20/reproduce.cjs'], ['output/playwright/', 'output/']),
    ['output/playwright/**'],
    'output/ 里住着被跟踪文件 ⇒ 只能排 output/playwright/，不能整目录排掉 output/',
  );
  assert.deepStrictEqual(
    scope.ignoredGlobsFromLists(['Ghost/keep.js'], ['ghost/']),
    [],
    '索引名与磁盘名只差大小写时也必须认定"这里住着源码"（core.ignorecase=false 的真缺陷）',
  );
  assert.deepStrictEqual(
    scope.ignoredGlobsFromLists([], ['生成物/']),
    ['生成物/**'],
    '非 ASCII 的忽略目录必须原样出现（少一个 -z 就会拿到 C-quote 字面量）',
  );
});

/**
 * A3c：同一条判定不许有两份实现。
 *
 * 缺口：`scripts/lint.js` 的 `gitScope()` 与 `scripts/eslint-ignores.js` 原先**各写了一遍**
 * "被忽略条目里若住着被跟踪文件就不排它"（前者用"被跟踪文件的祖先目录"集合，后者用前缀匹配）。
 * 两份在方向上一致，但没有任何东西保证它们一致 —— 任一侧单独演进，`npm run lint` 与
 * `npx --no-install eslint .` 就会悄悄跑在不同的作用域上（一个绿一个红，或一起放走一个生成物）。
 *
 * 判据分两层，缺一不可：
 *   ① **结构钉子**：`scripts/lint.js` 不得再自己跑 git / 自己解析被忽略清单（"两份实现"的复发形态）；
 *   ② **逐文件等价**：把磁盘上每个 `.js` 拿两条门禁各判一次（eslint 侧 = 是否被 ignores 命中；
 *      lint 侧 = 是否出现在 `listFiles()` 里），两侧结论**逐条必须相同**。
 *      这是"可观察结果"的比对，任一侧偏离都会在这里点名 —— 不是"读一遍代码觉得对"。
 * 枚举用本文件自己的 `covers()` 匹配器与 `skip` 表（独立重算，不拿被测输出当期望值）。
 */
test('eslint 作用域⑤：lint 的扫描范围与 eslint 的 ignores 逐文件等价，且共用一份实现（A3c）', () => {
  const lint = require('../scripts/lint.js');
  // ① 结构钉子：git 真值只能来自共享模块
  const lintSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lint.js'), 'utf8');
  assert.doesNotMatch(
    lintSrc,
    /spawnSync\s*\(\s*['"]git['"]/,
    'scripts/lint.js 又自己跑 git 了 —— 作用域真值必须只来自 scripts/eslint-ignores.js（否则"两份实现"复发）',
  );
  assert.doesNotMatch(
    lintSrc,
    /--exclude-standard/,
    'scripts/lint.js 又自己解析被忽略清单了 —— 那正是"同一逻辑两份实现"的复发形态',
  );
  assert.match(
    lintSrc,
    /require\(['"]\.\/eslint-ignores['"]\)/,
    'scripts/lint.js 必须 require 共享的作用域模块',
  );

  // ② 逐文件等价：磁盘上每个 .js 走两条门禁，结论必须一致
  assert.strictEqual(git(['rev-parse', '--is-inside-work-tree']).trim(), 'true', '前置：仓库根必须是 git 工作区');
  // 与 listFiles() 的静态兜底同名的目录名集合（独立重算用，不读被测实现的这张表）
  const SKIP = new Set(['node_modules', '.git', 'saves', 'logs', 'app', 'android', 'dist', 'release']);
  const allJs = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) allJs.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  };
  walk(ROOT);
  assert.ok(allJs.length > 100, `前置：磁盘上的 .js 应当有一批（实测 ${allJs.length}）——否则本用例会空转`);

  const globs = globsOf(config);
  const lintScanned = new Set(lint.listFiles().map((f) => f.split(path.sep).join('/')));
  const offenders = [];
  for (const f of allJs) {
    const byEslint = globs.some((g) => covers(g, f)) ? 'pruned' : 'kept';
    const byLint = lintScanned.has(f) ? 'kept' : 'pruned';
    if (byEslint !== byLint) offenders.push(`${f}: eslint=${byEslint} lint=${byLint}`);
  }
  assert.deepStrictEqual(
    offenders,
    [],
    '同一个文件在两条门禁上结论不同 —— `npm run lint` 与 `eslint .` 跑在了不同的作用域上'
      + '（A3c：受保护判定的真值必须只有一份）：\n  ' + offenders.join('\n  '),
  );
});
