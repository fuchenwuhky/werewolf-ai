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
 * ══ 同一条判定的另一个消费者：scripts/lint.js ══════════════════════════════════
 * 这条判定原先在仓库里有**两份实现**：`scripts/lint.js` 的 `gitScope()` 自己跑那两条 git 命令、
 * 自己解析 `-z` 清单、自己维护"被跟踪文件的祖先目录"集合，本模块再写一遍前缀匹配。
 * 两份在方向上一致，但没有任何东西保证它们一致 —— 任一侧单独演进，`npm run lint` 与
 * `npx --no-install eslint .` 就会悄悄跑在不同的作用域上（一个绿一个红，或一起放走一个生成物）。
 * 现在 `gitScope()` 只做一次转发：git 事实、归一化、`pathKey()`、受保护条目判定全部来自本模块的
 * `gitScopeFacts()`（判定本体见 `protectedEntryKeys()` 的注释）。
 * 两侧的**退化路径**仍各自保留，与修改前逐字一致：lint 拿不到被忽略清单时退回自己的静态 `skip`，
 * eslint 拿不到任一份清单时退回 `FALLBACK_GLOBS`。
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
 * 归一化忽略条目：git 的 `-z` 清单 → `{ rel, isDir }`。
 * `--directory` 用**尾斜杠**表示"这一条是一整个目录"，归一后单独放在 `isDir` 里（eslint 的 glob 形状要靠它）。
 * 反斜杠一律换成 `/`（git 在 `-z` 下本来就给正斜杠；这一段是防御性的，`scripts/lint.js` 原先也有同款）。
 */
function normalizeIgnoredEntries(ignored) {
  const out = [];
  for (const raw of ignored || []) {
    const isDir = /\/$/.test(String(raw));
    const rel = String(raw).split('\\').join('/').replace(/\/+$/, '');
    if (!rel || rel === '/') continue;
    out.push({ rel, isDir });
  }
  return out;
}

/**
 * ══ 唯一一条判定（本模块的核心理由）═══════════════════════════════════════════
 * 「一个被忽略条目，只有在它自己及其子树里都不含被跟踪文件时，才可以被排掉。」
 *
 * 这条判定以前在仓库里有**两份实现**：`scripts/lint.js` 的 `gitScope()` 用"被跟踪文件的祖先目录集合"
 * （`trackedDirs`）在目录遍历时剪枝，`scripts/eslint-ignores.js` 用前缀匹配生成 ignores。
 * 两份实现在方向上一致，但**没有任何东西保证它们一致** —— 任何一侧单独演进，两条门禁就会悄悄跑在
 * 不同的作用域上（`npm run lint` 绿而 `eslint .` 红，或反过来）。
 * 现在两侧都从这里取：`protectedEntryKeys()`（哪些忽略项受保护）+ `ignoredEntriesWithoutTracked()`（能排哪些）。
 *
 * 为什么用 `pathKey()`（小写化）比较：`core.ignorecase=false` 时索引名与磁盘名的大小写差异会让
 * "这里住着被跟踪文件"的判定失效 —— 那正是 `scripts/lint.js` 修过的真缺陷（见 test/lint-gitscope.test.js）。
 * 忽略大小写只会让判定**更保守**（更容易认定"这里有源码"⇒ 更少剪枝 ⇒ 多扫不漏扫）。
 *
 * @param {string[]|null} tracked 被跟踪文件（相对 root、正斜杠）
 * @param {Array<{rel:string,isDir:boolean}>} entries 归一化后的忽略条目
 * @returns {Set<string>} 受保护条目的 pathKey（自己是被跟踪文件，或是某个被跟踪路径的祖先目录）
 */
function protectedEntryKeys(tracked, entries) {
  const guarded = new Set();
  const trackedKeys = (tracked || []).map((t) => pathKey(String(t).replace(/\/+$/, '')));
  if (!trackedKeys.length) return guarded; // 拿不到被跟踪清单 ⇒ 不保护任何条目（调用方自己决定是否退化）
  for (const e of entries || []) {
    const key = pathKey(e.rel);
    if (trackedKeys.some((t) => t === key || t.startsWith(key + '/'))) guarded.add(key);
  }
  return guarded;
}

/**
 * 纯函数版（可单独测）：忽略条目里**真正可以排掉**的那些 —— 不含被跟踪文件的。
 * @param {string[]|null} tracked  被跟踪文件（相对 root、正斜杠）
 * @param {Array<{rel:string,isDir:boolean}>} entries 归一化后的忽略条目
 * @returns {Array<{rel:string,isDir:boolean}>} 可排掉的条目（保持输入顺序）
 */
function ignoredEntriesWithoutTracked(tracked, entries) {
  const guarded = protectedEntryKeys(tracked, entries);
  return (entries || []).filter((e) => !guarded.has(pathKey(e.rel)));
}

/**
 * 纯函数版（可单独测）：把两份 git 清单翻译成 ESLint 的 ignore 条目。
 * @param {string[]} tracked  被跟踪文件路径（相对 root、正斜杠）
 * @param {string[]} ignored  被忽略条目（目录以 `/` 结尾表示"这是一整个目录"）
 * @returns {string[]} 排序后的 ignore 条目：目录 → `d/**`，文件 → 原样
 */
function ignoredGlobsFromLists(tracked, ignored) {
  const entries = ignoredEntriesWithoutTracked(tracked, normalizeIgnoredEntries(ignored));
  return [...new Set(entries.map((e) => (e.isDir ? `${e.rel}/**` : e.rel)))].sort();
}

/**
 * 从 git 取一份**双方共用**的作用域事实（`scripts/lint.js` 与 eslint 的 ignores 都只认它）。
 *
 * 三个退化路径都**明确**留给调用方，而不是在这里悄悄兜底：
 *   · `ignored === null`（git 拿不到被忽略清单）⇒ lint 退回静态 skip、eslint 退回 FALLBACK_GLOBS；
 *   · `tracked === null`（git 拿不到被跟踪清单）⇒ 此时 `protectedKeys` 为空、`safeEntries` 等于全部条目。
 *     lint 照旧只按"被忽略"剪枝（与修改前一致：那时 trackedDirs 也是空的）；
 *     eslint 走 FALLBACK_GLOBS（与修改前一致）。方向都是"多扫不漏扫"。
 * @returns {{tracked: string[]|null, ignored: string[]|null, entries: Array, ignoredKeys: Set<string>,
 *            protectedKeys: Set<string>, safeEntries: Array}}
 */
function gitScopeFacts(root = ROOT) {
  const tracked = gitTrackedFiles(root);
  const ignored = gitIgnoredEntries(root);
  const entries = normalizeIgnoredEntries(ignored || []);
  const protectedKeys = protectedEntryKeys(tracked, entries);
  return {
    tracked,
    ignored,
    entries,
    ignoredKeys: new Set(entries.map((e) => pathKey(e.rel))),
    protectedKeys,
    safeEntries: entries.filter((e) => !protectedKeys.has(pathKey(e.rel))),
  };
}

/**
 * 给 ESLint 用的 ignores（相对仓库根）。
 * git 不可用 → 静态兜底（见 FALLBACK_GLOBS）。
 */
function ignoredGlobs(root = ROOT) {
  const { tracked, ignored, safeEntries } = gitScopeFacts(root);
  if (!tracked || !ignored) return FALLBACK_GLOBS.slice();
  return [...new Set(safeEntries.map((e) => (e.isDir ? `${e.rel}/**` : e.rel)))].sort();
}

module.exports = {
  ROOT, FALLBACK_GLOBS, pathKey, gitList, gitTrackedFiles, gitIgnoredEntries,
  normalizeIgnoredEntries, protectedEntryKeys, ignoredEntriesWithoutTracked,
  ignoredGlobsFromLists, gitScopeFacts, ignoredGlobs,
};
