/**
 * eslint-ignores.js — 把 `.gitignore` 的**真值**翻译成 ESLint 的 ignores 条目。
 *
 * ══ 缺口：eslint 的作用域与 git 的作用域不一致 ══════════════════════════════════
 * `npm run lint`（scripts/lint.js 的 `gitScope()`/`listFiles()`）早就改成"生成物一律以
 * .gitignore 为准"，而 `npx --no-install eslint .` 用的还是 eslint.config.js 里那份**手写目录表**。
 * 两份作用域会朝两个方向漂移，而且两个方向都真的会出问题：
 *
 *   · **漏排**（该排的没排）：`output/playwright/` 被 .gitignore 忽略，却被 eslint 照读。
 *     今天看不出毛病，只是因为没有任何 `files` 块匹配它 —— 只要那目录里出现一个**语法错误**的
 *     .js（生成的打包/探针脚本完全可能），`eslint .` 就会因为一个"我们不维护、也不该看"的文件判红。
 *   · **误排**（不该排的排了）：手写表里的 `app/**` 把**被 git 跟踪的源码**也排掉了
 *     （实测 `app/` 下有 56 个被跟踪文件，含 gradle 构建脚本与 Java 源码），方向正好反了。
 *     这类"手写目录表"必然过期：它连 `*.apk`（名字里带版本号）都写不进去。
 *
 * ══ 修法：只认 git 事实，不再维护第二张表 ══════════════════════════════════════
 *   ① `git ls-files -z`                        → 被跟踪文件（真值：什么**不能**被排掉）
 *   ② `git ls-files --others --ignored --exclude-standard --directory -z`
 *                                              → .gitignore 忽略的现存条目（真值：什么**可以**排掉）
 * 规则只有一条，两个方向一起管住：
 *   **一个被忽略条目，只有在它自己及其子树里都不含被跟踪文件时，才输出成 ignore 条目。**
 * 于是 `output/playwright/**` 会被排掉，而 `output/` 本身**不会**被整目录排掉
 * （`output/review-2026-09-20/reproduce.cjs` 是被跟踪的 —— 这正是"手写 output/** 会误伤"的例子）。
 *
 * ══ 两个实测过的细节（都不是洁癖，是真会踩）════════════════════════════════════
 *   · **`-z` 不是可选项**：不带它时 git 按 `core.quotePath`（默认 true）把非 ASCII 路径
 *     C-quote 成 `"\347\224\237…/"` 这种字面量，与磁盘路径永不相等（同一个坑 scripts/lint.js
 *     的 `gitScope()` 已经踩过一次，那边的注释有完整推导）。
 *   · **比较一律走 `pathKey()`（小写化）**：`core.ignorecase=false` 时索引名与磁盘名的大小写
 *     差异会让"这里住着被跟踪文件"的判定失效 —— 那正是 scripts/lint.js 修过的真缺陷。
 *     忽略大小写只会让判定**更保守**（更容易认定"这里有源码"⇒ 更少剪枝 ⇒ 多扫不漏扫）。
 *
 * ══ git 不可用时 ═══════════════════════════════════════════════════════════════
 * 退回一份与 scripts/lint.js `listFiles()` 的 `skip` 兜底同名同义的静态名单：宁可多扫生成物，
 * 也绝不误排源码（`src/`、`test/`、`web/`、`scripts/` 任何情况下都不在兜底名单里）。
 * 仓库内的正常路径永远走 git 真值，兜底只在脱离仓库的拷贝/没装 git 时生效。
 */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/** 路径键：所有集合的键与比较都走它（忽略大小写），理由见文件头 */
const pathKey = (p) => String(p).toLowerCase();

/**
 * git 不可用时的静态兜底。
 * 与 scripts/lint.js `listFiles()` 里那个 `skip` 集合同名同义（那边是"没 git 时退回静态兜底"），
 * 目的是让两条门禁在退化路径上也不会互相打架。**不含**任何源码目录。
 */
const FALLBACK_GLOBS = [
  '.git/**', 'android/**', 'app/**', 'dist/**', 'logs/**', 'node_modules/**', 'release/**', 'saves/**',
];

/** 跑一条 git 命令并返回 `-z` 拆出的条目（保留目录的尾斜杠）；git 不可用/失败 → null */
function gitList(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || '')
    .split('\0')
    .map((s) => s.split('\\').join('/'))
    .filter((s) => s && s !== '/');
}

/** 被 git 跟踪的文件（相对 root、正斜杠）。git 不可用 → null */
function gitTrackedFiles(root = ROOT) {
  return gitList(root, ['ls-files', '-z']);
}

/** 被 .gitignore 忽略且**当前存在于磁盘上**的条目（目录带尾斜杠）。git 不可用 → null */
function gitIgnoredEntries(root = ROOT) {
  return gitList(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
}

/**
 * 纯函数版（可单独测）：把两份 git 清单翻译成 ESLint 的 ignore 条目。
 * @param {string[]} tracked  被跟踪文件路径（相对 root、正斜杠）
 * @param {string[]} ignored  被忽略条目（目录以 `/` 结尾表示"这是一整个目录"）
 * @returns {string[]} 排序后的 ignore 条目：目录 → `d/**`，文件 → 原样
 */
function ignoredGlobsFromLists(tracked, ignored) {
  const trackedKeys = (tracked || []).map((t) => pathKey(String(t).replace(/\/+$/, '')));
  const out = [];
  for (const raw of ignored || []) {
    const isDir = /\/$/.test(String(raw));
    const rel = String(raw).split('\\').join('/').replace(/\/+$/, '');
    if (!rel) continue;
    const key = pathKey(rel);
    // 绝不排掉任何被跟踪的东西：条目本身被跟踪，或是某个被跟踪路径的祖先 → 整条跳过
    if (trackedKeys.some((t) => t === key || t.startsWith(key + '/'))) continue;
    out.push(isDir ? `${rel}/**` : rel);
  }
  return [...new Set(out)].sort();
}

/**
 * 给 ESLint 用的 ignores（相对仓库根）。
 * git 不可用 → 静态兜底（见 FALLBACK_GLOBS）。
 */
function ignoredGlobs(root = ROOT) {
  const tracked = gitTrackedFiles(root);
  const ignored = gitIgnoredEntries(root);
  if (!tracked || !ignored) return FALLBACK_GLOBS.slice();
  return ignoredGlobsFromLists(tracked, ignored);
}

module.exports = { ROOT, FALLBACK_GLOBS, pathKey, gitList, gitTrackedFiles, gitIgnoredEntries, ignoredGlobsFromLists, ignoredGlobs };
