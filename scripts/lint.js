#!/usr/bin/env node
/**
 * lint.js — 零依赖的项目不变量检查。
 *
 * 为什么不用 ESLint 为主：这个仓库存放的是**架构约束**，而不是风格偏好。
 * 下面每条规则都对应一个真实踩过的坑或硬约束，ESLint 的任何内置规则都覆盖不到：
 *
 *   syntax            每个文件能解析（第 8 轮就有一个 `attempt is not defined` 是靠测试才发现的）
 *   no-runtime-deps   运行时零依赖：只允许相对路径与 Node 内建模块
 *   engine-rng        src/engine 里不许出现 `Math.random()`——一旦有，断点重放就会错位，
 *                     决策 journal 永不命中（P1-1/P1-2 的前提）
 *   no-parallel-llm   src/ai 里不许用 Promise.all/race——硬约束是 1 API Key = 1 并发
 *   api-no-sync-write src/api.js 里不许有同步写——4 秒一次的全量 writeFileSync 会阻塞事件循环（P1-3）
 *   no-console        src 里不许直接 console（必须走 logger，否则前端看不到）
 *   engine-no-ai      src/engine 是纯逻辑层，不许依赖 AI 层（靠 agentFactory 注入）
 *   ai-no-api         src/ai 是下层，不许反向依赖 src/api
 *
 * 用法：node scripts/lint.js [--quiet]
 * 出口码：0 = 通过，1 = 有违规
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/**
 * 去掉注释（可选再去掉字符串字面量）。
 *
 * 两种形态各有用处：
 *  - 去掉字符串：给"代码骨架"类规则用（api.js 的注释里就出现过 writeFileSync 这个词，
 *    字符串里也可能出现 Promise.all 这种文本，不该误报）。
 *  - 保留字符串：给 require 类规则用——**模块名本身就住在字符串里**，
 *    去掉字符串等于把规则废掉（这个坑在写测试时被 4 个失败用例抓出来）。
 *
 * 模板字符串整体按字符串处理：`${}` 里的代码也会被去掉，这是已知的保守取舍。
 */
function stripSource(src, { keepStrings = false } = {}) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; } i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const start = i;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        if (src[i] === '\n') out += '\n';
        i++;
      }
      out += keepStrings ? src.slice(start, i) : (quote === '`' ? '``' : '""');
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 去掉注释与字符串（"代码骨架"规则用） */
const stripCommentsAndStrings = (src) => stripSource(src);

/** 逐行扫描：返回 [{line, text}]，已剔除注释与字符串 */
function codeLines(stripped) {
  return stripped.split('\n').map((text, i) => ({ line: i + 1, text }));
}

/** 该行是否被显式豁免（必须写明理由，避免随手关规则） */
const isAllowed = (rawLine) => /lint-allow\b.*[：:—-]\s*\S/.test(rawLine) || /lint-allow-next-line\b.*[：:—-]\s*\S/.test(rawLine);

const RULES = [
  {
    id: 'no-test-suffix-outside-test',
    desc: '测试目录之外的文件名不得以 -test.js / .test.js 结尾：node --test 的自动发现规则包含 **/*-test.js，'
      + '这类文件会被当测试文件执行。事故记录：scripts/serve-test.js（测试实例启动器）被 coverage 门禁'
      + '（node --test --experimental-test-coverage，无路径参数）当测试跑，它 spawn 的常驻 server.js 永不退出，'
      + '导致 `npm run gate` 无限挂起（实测 40+ 分钟无进展）',
    scope: () => true,
    check(stripped, raw, file) {
      if (/^test[\\/]/.test(file)) return []; // test/ 目录下的 *-test.js 是正常测试文件
      const base = path.basename(file);
      if (/-test\.js$/.test(base) || /\.test\.js$/.test(base)) {
        return [{ line: 1, msg: `文件名「${base}」会命中 node --test 的自动发现规则（**/*-test.js），请改名（例如 -check.js / -harness.js）` }];
      }
      return [];
    },
  },
  {
    id: 'no-runtime-deps',
    keepStrings: true, // 模块名在字符串里，剥掉字符串等于废掉这条规则
    desc: '运行时零依赖：只能 require 相对路径或 Node 内建模块',
    scope: (f) => /^src[\\/]/.test(f) || f === 'server.js',
    check(stripped, raw, file) {
      const out = [];
      const lines = codeLines(stripped);
      for (const { line, text } of lines) {
        for (const m of text.matchAll(/require\(\s*([^)]+)\)/g)) {
          const arg = m[1].trim();
          const lit = /^['"]([^'"]+)['"]$/.exec(arg);
          if (!lit) continue; // 动态 require（如 require('./' + name)）另行判断
          const mod = lit[1];
          if (mod.startsWith('.') || mod.startsWith('node:') || Module.builtinModules.includes(mod)) continue;
          if (isAllowed(raw.split('\n')[line - 1] || '')) continue;
          out.push({ line, msg: `引入了第三方模块「${mod}」——本项目运行时必须零依赖` });
        }
      }
      return out;
    },
  },
  {
    id: 'engine-rng',
    desc: 'src/engine 内禁止调用 Math.random()（会破坏断点重放的确定性）',
    scope: (f) => /^src[\\/]engine[\\/]/.test(f),
    check(stripped, raw) {
      const out = [];
      for (const { line, text } of codeLines(stripped)) {
        // `rnd = Math.random`（无括号，默认参数）是允许的；`Math.random()` 是真调用
        if (!/Math\.random\s*\(/.test(text)) continue;
        if (isAllowed(raw.split('\n')[line - 1] || '')) continue;
        out.push({ line, msg: '调用了 Math.random()：引擎随机性必须走 game.rnd（否则锚点重放会错位，决策 journal 永不命中）。默认参数写法 `= Math.random` 是允许的' });
      }
      return out;
    },
  },
  {
    id: 'llm-must-go-through-scheduler',
    desc: 'LLM 调用必须经调度器：HTTP 只能在 src/ai/llm.js 里发（那里唯一入队 scheduler）',
    // 旧规则是"src/ai 内禁止并发原语"，问题有两个：
    //   ① 它禁止的是**手段**而不是**不变式**：真正要保证的是"每次 LLM 调用都排进 scheduler"
    //      （调度器负责'每 Key 一条通道、通道内严格串行'）。只要经过 llm.js 就自动入队了。
    //   ② 它的 scope 只覆盖 src/ai，而并行改造的主战场是 src/engine/flow.js —— 硬约束在主战场上失效。
    // 现在换成真正的不变式：
    //   · HTTP 只能在 src/ai/llm.js 里发（`fetch`）——绕过它就等于绕过调度器；
    //   · 业务层（src/ai 其余文件）不得自己开并发：它们没有"按通道扇出"的语义；
    //   · **src/engine 允许 Promise.all**：那里的扇出最终都会落到 scheduler 排队，
    //     这正是多 Key 并行需要的写法（投票/夜晚步骤并行），不要把它当成违规改回去。
    scope: (f) => /^src[\\/](ai|engine)[\\/]/.test(f),
    check(stripped, raw, file) {
      const out = [];
      const norm = String(file || '').split(path.sep).join('/');
      const isLlm = norm.endsWith('src/ai/llm.js');
      const isSched = norm.endsWith('src/ai/scheduler.js');
      const inAi = /^src\/ai\//.test(norm);
      for (const { line, text } of codeLines(stripped)) {
        if (isAllowed(raw.split('\n')[line - 1] || '')) continue;
        if (!isLlm && /\bfetch\s*\(/.test(text) && !/global\.fetch/.test(text)) {
          out.push({ line, msg: '直接调用 fetch：HTTP 只能经 src/ai/llm.js（它负责超时/重试/入队 scheduler/用量归一化）。绕过它就等于绕过调度器' });
        }
        if (inAi && !isLlm && !isSched) {
          const m = /Promise\.(all|allSettled|race|any)\s*\(/.exec(text);
          if (m) {
            out.push({ line, msg: `src/ai 业务层使用了 Promise.${m[1]}：并发扇出只能由 scheduler 决定（引擎层 src/engine 允许扇出，因为它最终仍会排进 scheduler）` });
          }
        }
      }
      return out;
    },
  },
  {
    id: 'api-no-sync-write',
    desc: 'src/api.js 内禁止同步写（4 秒一次的定时落盘不能阻塞事件循环）',
    scope: (f) => f === path.join('src', 'api.js') || f === 'src/api.js',
    check(stripped, raw) {
      const out = [];
      for (const { line, text } of codeLines(stripped)) {
        if (!/\b(writeFileSync|appendFileSync)\s*\(/.test(text)) continue;
        if (isAllowed(raw.split('\n')[line - 1] || '')) continue;
        out.push({ line, msg: '同步写文件：定时落盘路径必须用 fs.promises + 原子替换，否则阻塞事件循环' });
      }
      return out;
    },
  },
  {
    id: 'no-console',
    desc: 'src 与 server.js 内禁止直接 console（必须走 logger，否则前端/日志看不到）',
    scope: (f) => /^src[\\/]/.test(f) || f === 'server.js',
    check(stripped, raw) {
      const out = [];
      const rawLines = raw.split('\n');
      for (const { line, text } of codeLines(stripped)) {
        if (!/\bconsole\s*\.\s*(log|info|warn|error|debug)\s*\(/.test(text)) continue;
        // 允许：上一行或本行有带理由的 lint-allow
        if (isAllowed(rawLines[line - 1] || '') || isAllowed(rawLines[line - 2] || '')) continue;
        out.push({ line, msg: '直接使用 console：请改用注入的 logger（需要保留时用 `// lint-allow: no-console — 理由` 显式豁免）' });
      }
      return out;
    },
  },
  {
    id: 'engine-no-ai',
    keepStrings: true,
    desc: 'src/engine 是纯逻辑层，不得依赖 AI 层（AI 必须靠 agentFactory 注入）',
    scope: (f) => /^src[\\/]engine[\\/]/.test(f),
    check(stripped) {
      const out = [];
      for (const { line, text } of codeLines(stripped)) {
        for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
          if (/ai[\\/]/.test(m[1])) out.push({ line, msg: `引擎层依赖了 AI 层（${m[1]}）：请改用注入（agentFactory），否则引擎不再可独立测试` });
        }
      }
      return out;
    },
  },
  {
    id: 'ai-no-api',
    keepStrings: true,
    desc: 'src/ai 是下层，不得反向依赖 src/api',
    scope: (f) => /^src[\\/]ai[\\/]/.test(f),
    check(stripped) {
      const out = [];
      for (const { line, text } of codeLines(stripped)) {
        for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
          if (/api(\.js)?['"]/.test(m[1]) || /\.\.\/api/.test(m[1])) out.push({ line, msg: `AI 层反向依赖了 API 层（${m[1]}）` });
        }
      }
      return out;
    },
  },
];

/** 对一段源码做全部适用规则的检查（导出以便测试） */
function lintSource(code, file) {
  const out = [];
  try {
    new vm.Script(code, { filename: file }); // 语法
  } catch (e) {
    out.push({ rule: 'syntax', line: e.lineNumber || 0, msg: `语法错误：${e.message}` });
    return out; // 解析失败就不再跑其它规则（行号会乱）
  }
  const stripped = stripCommentsAndStrings(code);
  const noComments = stripSource(code, { keepStrings: true }); // require 类规则必须保留模块名字符串
  for (const r of RULES) {
    if (r.scope && !r.scope(file)) continue;
    const src = r.keepStrings ? noComments : stripped;
    for (const v of r.check(src, code, file)) out.push({ rule: r.id, line: v.line, msg: v.msg });
  }
  return out;
}

/**
 * 扫描范围里「不该看的生成物」集合 —— 真值取自 `.gitignore`，不再靠 skip 里的目录名硬编码。
 *
 * 为什么必须改（本次修复的直接动因）：生成物清单的真值在 `.gitignore` 里，硬编码的目录名
 * 「漏一个就漏一类」，而漏掉的那一类会让读数随「本机跑没跑过打包/验收脚本」漂移。
 * 实测：`output/playwright/verify-ux-v2.js` 被 `.gitignore:15` 忽略，却是浏览器验收脚本的产物 ——
 * 它被当源码数了进去，于是主工作树 `npm run lint` 报 **197** 个 JS 文件，干净 worktree 只有 **196** 个。
 * 而静态 skip 集**压根不认**这 6 个被忽略的生成目录：`.playwright-cli/`、`desktop/dist/`、
 * `desktop/node_modules/`、`migrations/`、`output/playwright/`、`profiles/` —— 每一个都可能复制同样的漂移。
 *
 * 为什么**不会**误排源码（本函数的核心不变式，两层保证）：
 *   ① `git ls-files --others` 只列**未跟踪**项 ⇒ 被跟踪的文件永远不在 ignored 里。
 *      反例正是 `output/`：它整体**没有**被忽略，下面还躺着被跟踪的
 *      `output/review-2026-09-20/reproduce.cjs` —— 所以「把 'output' 加进 skip」是错的修法。
 *   ② 万一某天出现「整个目录被忽略、但目录里仍有被跟踪文件」（`profiles/`、`migrations/` 这类
 *      运行时数据目录最可能变成这样），`--directory` 会把该目录整条列出来，按目录剪枝就会连
 *      **被跟踪的源码一起排掉**。所以这里同时取 `git ls-files -z` 的被跟踪清单，
 *      凡是「有被跟踪文件住在里面」的目录一律**不剪枝**（宁可多扫，绝不漏扫源码）。
 *      实测当前仓库 17 个被忽略目录条目中有 0 个含被跟踪文件，但这条不能靠"现在恰好没有"。
 *
 * git 不可用时（脱离仓库的拷贝等）返回 null，退回 skip 的静态兜底：宁可漏排生成物，也不误排源码。
 *
 * @returns {{ignored: Set<string>, trackedDirs: Set<string>}|null}
 */
function gitScope() {
  try {
    const ignoredRes = spawnSync(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
      { cwd: ROOT, encoding: 'utf8' }
    );
    if (ignoredRes.error || ignoredRes.status !== 0) return null;
    const ignored = new Set(
      String(ignoredRes.stdout || '')
        .split('\n')
        .map((l) => l.trim().replace(/\/+$/, '').split('\\').join('/'))
        .filter(Boolean)
    );
    const trackedDirs = new Set();
    const trackedRes = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
    if (!trackedRes.error && trackedRes.status === 0) {
      for (const f of String(trackedRes.stdout || '').split('\0')) {
        if (!f) continue;
        let d = f;
        for (;;) {
          const i = d.lastIndexOf('/');
          if (i < 0) break;
          d = d.slice(0, i);
          trackedDirs.add(d);
        }
      }
    }
    return { ignored, trackedDirs };
  } catch {
    return null;
  }
}

function listFiles() {
  const out = [];
  // release/ 是打包产物（内含源码副本，天生是快照）：扫它没意义，改动源码后还会产生假报错
  const skip = new Set(['node_modules', '.git', 'saves', 'logs', 'app', 'android', 'dist', 'release']);
  // 生成物/构建目录一律以 .gitignore 为准（见 gitScope 注释）；skip 只当 git 不可用时的兜底
  const scope = gitScope();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (scope) {
        const rel = path.relative(ROOT, p).split(path.sep).join('/');
        // 被忽略的目录里若住着被跟踪的文件，绝不剪枝（见 gitScope ②）
        if (scope.ignored.has(rel) && !(e.isDirectory() && scope.trackedDirs.has(rel))) continue;
      }
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  return out.sort();
}

function lintAll() {
  const results = [];
  for (const file of listFiles()) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const v of lintSource(code, file)) results.push({ file, ...v });
  }
  return results;
}

if (require.main === module) {
  const quiet = process.argv.includes('--quiet');
  const files = listFiles();
  const results = lintAll();
  if (!quiet) console.log(`检查 ${files.length} 个 JS 文件，${RULES.length + 1} 条规则`);
  if (results.length) {
    console.error(`\n✖ 发现 ${results.length} 处违规：\n`);
    for (const r of results) console.error(`  ${r.file}:${r.line}  [${r.rule}] ${r.msg}`);
    console.error('\n规则说明见 scripts/lint.js 顶部注释。');
    process.exit(1);
  }
  console.log(`✓ 全部通过（${files.length} 文件）`);
}

module.exports = { lintSource, lintAll, listFiles, stripCommentsAndStrings, stripSource, RULES };
