/**
 * lint-gitscope.test.js — 证明 `scripts/lint.js` 的 `gitScope()` **第二层保护真的会被执行**
 * （缺口 B：这条分支此前从未被真实案例跑过）
 *
 * ══ 这条分支是什么 ══════════════════════════════════════════════════════════
 * `gitScope()` 拿两份真值：`.gitignore` 判定的被忽略项（`git ls-files --others --ignored
 * --exclude-standard --directory`）与所有被跟踪文件（`git ls-files -z`），从两者算出
 * "哪些忽略项里住着被跟踪文件"。`listFiles()` 里那条：
 *     被忽略的目录里若住着被跟踪的文件 → **绝不剪枝**
 * 的用意是"宁可多扫，绝不漏扫源码"。执行方当时如实承认：本仓库 17 个被忽略条目里 0 个含
 * 被跟踪文件（本次实测 25 个里同样 0 个），所以这条分支**从没被跑过**，且"写不出不带 .skip 的用例"。
 * （A3c 之后这份真值由 `scripts/eslint-ignores.js` 的 `gitScopeFacts()` 统一算出 ——
 *  `scripts/lint.js` 与 eslint 的 ignores 共用同一份判定，本文件考的仍是 `listFiles()` 的可观察结果。）
 *
 * ══ 本次用真实 git 仓库实测出的结论（下面每条用例都对应其中一条）═════════════
 *  ① **目录折叠只发生在 git 自己的索引查找失败时**。真实 `git init` 的临时仓库里：
 *     · 目录里有任何索引条目 → git 一律递归进去、逐条列未跟踪项，从不给出 `dir/`；
 *       （含"文件已从工作区删除但索引里还在"这种常见态 —— 索引仍算它存在）
 *     · 索引里的路径与磁盘目录名**大小写不一致**、且 `core.ignorecase=false`（POSIX 的默认行为，
 *       Windows 上也能显式配出来；成因是 POSIX 上直接 `mv Ghost ghost` 这类仓库外改名）
 *       → git 折叠成 `ghost/` 一条。
 *  ② 于是第二层保护**恰好只在①的后一种情形下**才会被触发 —— 而那正是它原先失效的情形：
 *     忽略项的键是**磁盘名**（`ghost`）、被跟踪清单的键是**索引名**（`Ghost/keep.js`），
 *     按字节比较永远不相等，"绝不剪枝"的判定为假 → 目录被剪枝 → **被跟踪的源码被静默排掉**。
 *     这是本次发现并修掉的**真缺陷**（`gitScope()` 现在两个集合都过 `pathKey()`，忽略大小写）。
 *  ③ 非 ASCII 的被忽略路径：不带 `-z` 时 git 会按 `core.quotePath`（默认 true）做 C-quote，
 *     `生成物/` 拿到的是 `"\347\224\237…/"` 这种字面量，与磁盘路径永不相等 → 被忽略项**永远剪不掉**。
 *     这也是真缺陷（同一函数里已改为 `-z`）。
 *
 * ══ 这些用例怎么"不带 .skip 还是可重复" ═════════════════════════════════════
 * 全在**系统临时目录**里 `git init` 一个全新仓库（不碰本仓库、不进 git status），把
 * `scripts/lint.js` 的**逐字副本**放进去（副本算出的 ROOT 就是那个临时仓库），
 * 再用真实 git 造出场景、直接调它的 `listFiles()`。前置条件（git 真的把目录折叠成了 `dir/`、
 * 索引里真的跟踪着那个 .js）都**先断言**：场景不再成立时判红并说明"请改构造"，而不是静默变成空用例。
 * 临时仓库在用例结束时删掉（`cleanupAfter`，失败也删）。
 * 依赖：本用例需要 `git` 可执行文件（lint 作用域本身就以 git 为真值，没有 git 时它已退回静态兜底；
 * 这里没有 git 就**判红**而不是跳过 —— 跳过会让这条保护重新回到"没人证明"的状态）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanupAfter } = require('./helpers-tmpdir');

const ROOT = path.join(__dirname, '..');
const norm = (p) => p.split(path.sep).join('/');

/** 跑一条 git 命令（找不到 git 直接抛：见文件头"依赖"） */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) throw new Error(`本用例需要 git（lint 作用域的真值来源）：${r.error.message}`);
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '').trim() };
}

/** 跑一条 git 命令并要求成功 */
function gitOk(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败（exit ${r.status}）：${r.err}`);
  return r.out;
}

/** `-z` 清单 → 归一化后的路径数组（去掉目录条目的尾斜杠、统一分隔符） */
const zList = (out) => String(out).split('\0').map((s) => s.replace(/\/+$/, '').split('\\').join('/')).filter(Boolean);

const write = (dir, rel, content) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

/**
 * 造一个临时 git 仓库（含被测 lint.js 的逐字副本），返回测量句柄。
 * @param {string} tag  临时目录前缀（便于残留时辨认）
 * @param {object} cfg  { ignore, indexPath, diskDir, trackedAtRoot, untracked }
 *   · ignore          .gitignore 内容（真值）
 *   · indexPath       写进索引的路径（可故意与磁盘目录名大小写不同）
 *   · diskDir         磁盘上的目录名
 *   · untracked       未跟踪且被忽略的文件（必须至少一个，否则 git 不会列出被忽略目录）
 */
function makeRepo(t, tag, cfg) {
  const dir = cleanupAfter(t, fs.mkdtempSync(path.join(os.tmpdir(), `ww-${tag}-`)));
  gitOk(dir, ['init', '-q']);
  // Windows 默认 core.ignorecase=true 会让 git 自己把大小写差异当同一条路径（于是不折叠目录）；
  // 显式关掉 = POSIX 的默认行为，两个平台跑出**同一个** git 行为（用例才是可重复的）
  gitOk(dir, ['config', 'core.ignorecase', 'false']);
  write(dir, '.gitignore', cfg.ignore);
  gitOk(dir, ['add', '.gitignore']);
  write(dir, `${cfg.diskDir}/keep.js`, "'use strict';\nmodule.exports = 1;\n");
  // 用 hash-object + update-index 直接写索引：这样**索引里的路径大小写**完全由我们用例决定
  const sha = gitOk(dir, ['hash-object', '-w', `${cfg.diskDir}/keep.js`]).trim();
  gitOk(dir, ['update-index', '--add', '--cacheinfo', `100644,${sha},${cfg.indexPath}`]);
  for (const f of cfg.untracked) write(dir, f, 'junk\n');
  // 被测代码的逐字副本：它算出的 ROOT 就是本临时仓库
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'lint.js'), path.join(dir, 'scripts', 'lint.js'));
  // A3c：lint.js 不再自己跑 git —— 作用域真值委托给共享模块 scripts/eslint-ignores.js
  // （同一逻辑不许有两份实现）。副本必须把这个依赖一并带上，否则临时仓库里的 require 直接失败。
  // 这**不是**放宽断言：三条用例的断言与前置条件逐字未动，考的仍是 listFiles() 的可观察结果。
  fs.copyFileSync(path.join(ROOT, 'scripts', 'eslint-ignores.js'), path.join(dir, 'scripts', 'eslint-ignores.js'));
  const { listFiles } = require(path.join(dir, 'scripts', 'lint.js'));
  return {
    dir,
    listFiles,
    ignored: zList(gitOk(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])),
    tracked: zList(gitOk(dir, ['ls-files', '-z'])),
  };
}

test('缺口 B：被忽略目录里住着被跟踪的 .js —— git 把该目录折叠成一条时，listFiles() 仍必须扫描它', (t) => {
  // 场景：`.gitignore` 忽略 ghost/，索引里跟踪着 ghost/keep.js，但**索引名的大小写与磁盘名不同**
  // （Ghost vs ghost）——这正是 git 会折叠目录、因而第二层保护必须生效的那一种情形（见文件头①②）
  const repo = makeRepo(t, 'lint-gitscope-collapse', {
    ignore: 'ghost/\n',
    indexPath: 'Ghost/keep.js',
    diskDir: 'ghost',
    untracked: ['ghost/gen.log'],
  });

  // ---- 前置条件：场景必须真的成立，否则本用例会静默退化成空用例 ----
  assert.ok(repo.ignored.includes('ghost'),
    `前置条件不成立：git 没有把被忽略目录折叠成「ghost/」一条（实测 ignored=${JSON.stringify(repo.ignored)}）。`
    + '这条分支正是靠"目录整条被列出"才会被走到 —— 场景变了请改构造（例如换 git 版本/换折叠触发条件），'
    + '而不是删掉本用例');
  assert.ok(repo.tracked.includes('Ghost/keep.js'),
    `前置条件不成立：索引里必须在 ghost/ 下跟踪着一个 .js（实测 tracked=${JSON.stringify(repo.tracked)}）`);

  // ---- 主断言：被跟踪的源码必须在扫描范围内（第二层保护生效）----
  const scanned = repo.listFiles().map(norm);
  assert.ok(scanned.includes('ghost/keep.js'),
    `被忽略目录 ghost/ 里住着被跟踪的 ghost/keep.js，listFiles() 却把它连同目录一起剪掉了：${JSON.stringify(scanned)}`);
  assert.ok(scanned.includes('scripts/lint.js'), '没被忽略的源码照旧必须在扫描范围内（否则是遍历本身坏了）');
});

test('缺口 B（对照）：目录被忽略但索引名与磁盘名一致时也一样 —— 被跟踪的源码不许丢，被忽略的 .js 仍要剪', (t) => {
  // 这一种形态下 git **不会**折叠目录（索引里有条目就递归），所以保护实际由 git 的逐条清单承担；
  // 用例的价值是钉住可观察结果：源码在、生成物不在。它同时是上一条的对照（说明差异确实来自折叠）
  const repo = makeRepo(t, 'lint-gitscope-plain', {
    ignore: 'ghost/\n',
    indexPath: 'ghost/keep.js',
    diskDir: 'ghost',
    untracked: ['ghost/gen.js'],
  });

  assert.ok(repo.ignored.includes('ghost/gen.js'),
    `前置条件不成立：应当逐条列出被忽略的生成物（实测 ignored=${JSON.stringify(repo.ignored)}）`);
  assert.ok(!repo.ignored.includes('ghost'), '对照前提：这一形态下 git 不该折叠目录');

  const scanned = repo.listFiles().map(norm);
  assert.ok(scanned.includes('ghost/keep.js'), `被跟踪的源码必须被扫描，实测：${JSON.stringify(scanned)}`);
  assert.ok(!scanned.includes('ghost/gen.js'), `被忽略的生成物必须被剪掉，实测：${JSON.stringify(scanned)}`);
});

test('缺口 B（第二个真缺陷）：被忽略的非 ASCII 目录必须真的被剪掉（不带 -z 时 git 会 C-quote）', (t) => {
  // `core.quotePath` 默认 true：不带 -z 时 git 给出的是 "\347\224\237\346\210\220\347\211\251/gen.js"
  // 这样的 **C-quote 字面量**，与磁盘上的 `生成物/gen.js` 永不相等 —— 被忽略项因此永远剪不掉
  // （表现为多扫，属真缺陷）。这条用例钉住修好后的行为：那个 .js 不再进入扫描范围。
  // 注：这里索引名与磁盘名一致，所以 git 逐条列出的是文件（`生成物/gen.js`），不做目录折叠 ——
  // 剪枝走的是文件级比较，与上面两条的目录级比较无关，两处都受 -z 影响。
  const repo = makeRepo(t, 'lint-gitscope-nonascii', {
    ignore: '生成物/\n',
    indexPath: '生成物/keep.js',
    diskDir: '生成物',
    untracked: ['生成物/gen.js'],
  });

  assert.ok(repo.ignored.includes('生成物/gen.js'),
    `前置条件不成立：git 应当逐条列出被忽略的非 ASCII 生成物（实测 ignored=${JSON.stringify(repo.ignored)}）`);
  assert.ok(repo.tracked.includes('生成物/keep.js'), '前置条件：索引里跟踪着同目录下的源码');

  const scanned = repo.listFiles().map(norm);
  assert.ok(scanned.includes('生成物/keep.js'), `被跟踪的非 ASCII 目录里的源码必须被扫描，实测：${JSON.stringify(scanned)}`);
  assert.ok(!scanned.includes('生成物/gen.js'),
    `被忽略的非 ASCII 生成物必须被剪掉，实测：${JSON.stringify(scanned)}`
    + '（拿到带引号的 C-quote 字面量就说明 gitScope 少了 -z）');
});
