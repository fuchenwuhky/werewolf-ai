/**
 * tmp-isolation-guard.test.js — NEW-17：测试进程不得写到"共享路径"
 *
 * ## 真实缺陷（既是假红来源，也是"测试污染检出目录"）
 * `src/api.js` 的构造用 `path.dirname(saveDir)` 推导档案侧路径：
 *   `ProfileStore` 根 `<dataDir>/profiles`、迁移游标 `<dataDir>/migrations`。
 * 测试若不传 `saveDir`，`saveDir` 就落到默认值 `<repo>/saves` ⇒ `dataDir = 仓库根`，于是
 * 一份**全机共享**的 `<repo>/profiles`、`<repo>/migrations` 成了所有测试进程的公共写点：
 *   · `node --test` 默认**并行跑文件**，多个进程同时 `tmp → rename` 同一个 `profiles/index.json`
 *     会间歇性 EPERM；迁移失败会被降级（`defaultProfileId = null`），依赖"当前有档案"的用例随之假红
 *     （"哪条用例先红"带随机性：它取决于谁抢输；本文件因此不去断言"某条特定用例会红"）；
 *   · 测试产物（默认档案、迁移游标、迁移备份）真的被写进检出目录，`git status` 看不见（已 ignore）。
 * 同形态的第二种写法是**固定临时路径**：`os.tmpdir()/<常量名>` —— 它在并行全量之间也是共享的。
 *
 * ## 本文件钉住的不变量（静态三条 + 动态一条）
 *   ① 每个 `new Api(` 必须显式传 `saveDir`（隔离不能再依赖"WW_DATA_DIR 恰好在 require 之前设好"）；
 *   ② 不得硬编码仓库数据目录（`__dirname,'..','saves'|'profiles'|'migrations'`）；
 *   ③ `X.tmpdir()` 只能与 `mkdtemp` 同行（禁止把固定的 %TEMP% 子路径当数据根）；
 *   ④ **检出干净性（动态、确定性）**：把 `src/`+`scripts/`+`test/` 复制成一份"全新检出"（没有
 *      `profiles/`、`migrations/`、`saves/`），在私有 TEMP 沙箱里跑那几个曾经写仓库根的测试文件，
 *      跑完后这份检出的根目录**不得多出**任何数据目录。
 *      为什么必须是"全新检出"：仓库现在已有完整的迁移游标时，未隔离的 Api 构造**恰好**不再落盘
 *      （迁移步骤已 done）——只看现有仓库会漏检，必须用"没有游标的检出"才具备确定性。
 * ④ 的探针文件清单 = 修复前确实会写仓库根的那几个（api/save/keypool）；其余文件由 ①②③ 静态覆盖。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = __dirname;
const SELF = path.basename(__filename);
/** 仓库数据目录：SAVE_DIR=<repo>/saves，ProfileStore 根=<repo>/profiles，迁移游标=<repo>/migrations */
const DATA_DIRS = ['saves', 'profiles', 'migrations'];
/** 动态探针：修复前会因"不传 saveDir"把数据写进检出根的那几个测试文件 */
const CLEANLINESS_PROBES = ['api.test.js', 'save.test.js', 'keypool.test.js'];

/** test/**\/*.test.js（排除本文件：它自己提到 `new Api(` 与 `os.tmpdir()` 会自我命中） */
function listTestFiles() {
  return fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js') && f !== SELF).sort();
}

/** 读文件并统一成 LF（与 check-guards.js 同一口径：行号与注释判定不因 CRLF 漂移） */
function readTest(f) {
  return fs.readFileSync(path.join(TEST_DIR, f), 'utf8').replace(/\r\n?/g, '\n');
}

const isCommentLine = (line) => /^\s*(?:\*|\/\/|\/\*)/.test(line || '');

/** 取出每个 `new Api(` 的参数文本（按括号配对）与行号 */
function apiCallSites(code) {
  const lines = code.split('\n');
  const calls = [];
  const re = /new\s+Api\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < code.length; i++) {
      const c = code[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    const line = code.slice(0, m.index).split('\n').length;
    const lineStart = code.lastIndexOf('\n', m.index) + 1;
    const before = code.slice(lineStart, m.index);
    // 注释里的举例（行首/行尾注释、块注释内）与字符串里的标题（用例名里写 `new Api()`）都不是调用点
    const unescapedQuotes = (before.match(/(?<!\\)['"`]/g) || []).length;
    const comment = isCommentLine(lines[line - 1]) ||
      before.includes('//') ||
      (before.split('/*').length - 1) > (before.split('*/').length - 1) ||
      unescapedQuotes % 2 === 1;
    calls.push({ line, text: end > 0 ? code.slice(open, end + 1) : code.slice(open), comment });
  }
  return calls;
}

test('NEW-17：test/**/*.test.js 里每个 new Api(...) 必须显式传 saveDir（不传就写到仓库根，并行全量互抢）', () => {
  const offenders = [];
  for (const f of listTestFiles()) {
    for (const c of apiCallSites(readTest(f))) {
      if (c.comment) continue; // 注释/文档里举例的 `new Api()` 不是调用点
      if (/\bsaveDir\b/.test(c.text)) continue;
      offenders.push(`${f}:${c.line}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `这些 Api 构造没传 saveDir：不传 → saveDir 落到默认 <repo>/saves，` +
    `dirname 推导出的 <repo>/profiles 与 <repo>/migrations 就成了全机共享写点（并行全量互相抢写 / 污染检出目录）：` +
    offenders.join('、'));
});

test('NEW-17：test/**/*.test.js 不得硬编码仓库数据目录（saves/profiles/migrations）', () => {
  const offenders = [];
  // 只认"从测试文件位置拼回仓库根"的写法；`<dataDir>/saves` 这类独占路径不受影响
  const repoJoin = /__dirname\s*,\s*'\.\.'\s*,\s*'(?:saves|profiles|migrations)'/;
  for (const f of listTestFiles()) {
    readTest(f).split('\n').forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (repoJoin.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(offenders, [],
    `这些位置直接指向仓库数据目录（并行全量下是所有进程的公共写点，且会污染真实数据）：${offenders.join('、')}`);
});

test('NEW-17：X.tmpdir() 只能与 mkdtemp 同行（禁止把固定的 %TEMP% 子路径当数据根）', () => {
  const offenders = [];
  const tmpdirCall = /(?:^|[^\w$])[\w$]*\.tmpdir\s*\(/;
  for (const f of listTestFiles()) {
    readTest(f).split('\n').forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (!tmpdirCall.test(line)) return;
      if (/\bmkdtemp\w*\s*\(/.test(line)) return; // 独占：mkdtempSync(path.join(os.tmpdir(), 'x-'))
      offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepStrictEqual(offenders, [],
    `os.tmpdir() 下用常量名拼出的路径在并行全量之间是共享的（必须走 mkdtempSync 建独占目录）：${offenders.join('、')}`);
});

/** 复制一份"全新检出"：没有 profiles/、migrations/、saves/（= 迁移还没跑过的状态） */
function freshCheckout(dest) {
  for (const rel of ['src', 'scripts', 'test']) {
    fs.cpSync(path.join(ROOT, rel), path.join(dest, rel), { recursive: true });
  }
  // src 侧在**加载期**就要 require web/ai-cast（src/ai/personalities.js、src/names.js），
  // 但 web/ 下 22MB 是图片资产：只搬 .js，够加载即可（缺资产会让探针红，不会静默放过）
  fs.cpSync(path.join(ROOT, 'web'), path.join(dest, 'web'), {
    recursive: true,
    filter: (s) => fs.statSync(s).isDirectory() || s.endsWith('.js'),
  });
  for (const rel of ['package.json', 'release-version.json']) {
    const from = path.join(ROOT, rel);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dest, rel));
  }
  fs.mkdirSync(path.join(dest, 'node_modules'), { recursive: true }); // 零运行时依赖；占位避免向上找宿主 node_modules
}

test('NEW-17 检出干净性：在"全新检出"里跑那几个曾写仓库根的测试文件，检出根不得多出数据目录', () => {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-isolation-checkout-'));
  try {
    freshCheckout(sandboxRoot);
    const tempSandbox = path.join(sandboxRoot, 'tmp-sandbox');
    fs.mkdirSync(tempSandbox);
    const probeArgs = ['--test', ...CLEANLINESS_PROBES.map((f) => path.join('test', f))];
    // ⚠ 必须删掉 NODE_TEST_CONTEXT：本文件自己是 node --test 的子进程，而该变量会让**孙进程**的
    // `node --test` 认为"我只是别人的测试子进程"→ 一个用例都不跑、直接 0 退出（实测：
    // 保留时 status=0 且输出 0 字节；删掉后才真的执行）。不删，这条检查就是**假绿**。
    const env = { ...process.env, TEMP: tempSandbox, TMP: tempSandbox, TMPDIR: tempSandbox };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, probeArgs, { cwd: sandboxRoot, encoding: 'utf8', timeout: 180000, env });
    const summary = (r.stdout || '').match(/^ℹ tests (\d+)$/m);
    // 先证明"真的跑了"：否则下面的"干净"可能是"什么都没跑"得出的
    assert.ok(summary && Number(summary[1]) > 0,
      `探针没有真的执行（拿不到 "ℹ tests N"）：status=${r.status}\n${(r.stdout || '').slice(0, 1200)}`);
    assert.strictEqual(r.status, 0,
      `探针文件在全新检出里没跑绿（先修它，别让干净性检查建立在"没跑起来"上）：` +
      `${CLEANLINESS_PROBES.join('、')}\n${(r.stdout || '').split('\n').filter((l) => /^✖|^ℹ (tests|pass|fail)/.test(l)).join('\n')}`);
    // 检出根只允许有源码/测试/清单文件；出现数据目录就说明有测试把数据写到了检出里
    const leaked = DATA_DIRS.filter((d) => fs.existsSync(path.join(sandboxRoot, d)));
    assert.deepStrictEqual(leaked, [],
      `这些数据目录被测试写进了检出根（每个用例必须拿到自己的独占 dataDir）：${leaked.join('、')}`);
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});
