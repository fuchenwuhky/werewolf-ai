#!/usr/bin/env node
/**
 * check-guards.js — 「改前端忘了同步 pin」的秒级守卫（FIX-20）
 *
 * ## 真实事故（这个脚本就是为了不再发生）
 * 有人改了 `web/m/m.js` 就推送，但**没有**同步：
 *   ① `src/static.js` 里 CSP 的 `sha256-<base64>` 白名单（对应两个 index.html 的内联守卫脚本）；
 *   ② `design/brand/v2/export/manifest.json` 的品牌 SHA-256 pin；
 *   ③ `test/sw-shell.test.js` 里 `web/sw.js` SHELL 清单的指纹台账。
 * 这几类用例在 CI 上都会红，但作者**只跑了定向用例、没跑全量**，所以当场没发现。
 * 本脚本把"最容易被漏掉的那几条"做成秒级的推送前守卫（钩子见 scripts/install-hooks.js）。
 *
 * ## 腿 A：pin 敏感用例（两层）
 *   A1 静态复核（**行尾免疫**）：不读工作区字节算哈希，而是取"CI 会看到的字节"
 *      （`git cat-file blob HEAD:<path>`，工作区有未提交改动时退回"行尾归一为 LF 的工作区"），
 *      直接复核 CSP 白名单（**两个** HTML 的内联守卫脚本）与品牌 manifest 的 source/导出 pin。
 *      为什么必须这样：Windows 的 `core.autocrlf=true` 会让工作区变 CRLF，而这两个 pin 钉的是
 *      **字节**（LF），于是本地假红、CI（Linux/LF）真绿 —— 详见仓库根的 `.gitattributes`。
 *      若发现"工作区字节 ≠ 仓库字节（仅行尾差异）"，只提示"行尾差异，已按仓库字节校验，无需重新 pin"。
 *   A2 子进程 `node --test <pin 清单>`：真跑那些测试文件并把输出转发出来。
 *      子进程读的是工作区，所以 A2 的失败在"存在行尾差异 + 失败用例恰好只是那两条行尾敏感的 pin 用例"
 *      时会被降级为**已知假红**（不阻断），并打印醒目说明；其余任何失败照旧阻断。
 *
 * ## 腿 B：断言卫生扫描
 *   `test/**\/*.test.js` 里的恒真/宽容断言——它们会让用例失去意义（FIX-20 本体）。
 *   仓库里存在历史存量违规，本脚本**不**要求一次性修完（那会引出一大片无关改动）：
 *   历史违规登记在 `scripts/guards-baseline.json`（键 = 文件 + 规则 + 行内容指纹，行号漂移不影响匹配），
 *   只有**不在基线里**的违规才让脚本失败。基线收拾干净后用 `--update-baseline` 重新登记。
 *   确有理由的例外：在某行的注释里写 `// GUARD-ALLOW: <理由>`（或写在**上一行**）即可豁免。
 *   必须写明理由：光写标记不生效，还会被单独点名为"无效指令"。脚本会把**所有**豁免连同理由打印出来 ——
 *   豁免是"看得见的债务"，不是静默放过。（只有注释里的才算数：文档/字符串里提到 GUARD-ALLOW 不算指令。）
 *
 * ## 用法
 *   node scripts/check-guards.js                     # 两条腿都跑（推送前默认）
 *   node scripts/check-guards.js --assertions-only    # 只跑断言卫生（meta 测试用）
 *   node scripts/check-guards.js --update-baseline    # 把当前违规重新登记为基线
 *   node scripts/check-guards.js --root <dir>         # 换根目录（meta 测试用）
 *   node scripts/check-guards.js --baseline <file>    # 指定基线文件
 *
 * 出口码：0 = 通过；1 = 有失败（pin 真红 或 出现基线之外的新违规）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BASELINE_VERSION = 1;
const ALLOW_TAG = 'GUARD-ALLOW';

/**
 * pin 敏感用例清单。
 *
 * **不是猜的**：逐个读过 test/*.test.js，挑出"把某个源文件/资产的内容哈希或白名单钉死"的用例：
 *   · test/remediation.test.js —— 「CSP：index.html 的内联脚本哈希与 static.js 白名单一致」
 *     （同文件的「CSP：HTML 响应带 Content-Security-Policy」也在这里）
 *   · test/brand-v2.test.js    —— 「brand v2: manifest pins source and every raster/icon export by SHA-256」
 *   · test/sw-shell.test.js    —— SHELL_LEDGER 把 web/sw.js 的 SHELL 清单指纹写死在测试里：
 *     改了清单不升 VERSION / 不登记新指纹就红（改 web/sw.js 必看的台账）
 *
 * 刻意**不**收进来的（判定逻辑要能复核）：
 *   · test/pwa.test.js —— 它断言的 `?v=<内容哈希>` 是 src/static.js **请求时现算并改写**的
 *     （见 src/static.js 的 rewriteVersionedRefs），HTML 里并没有写死哈希，所以改 web/ 永远不会让它红，
 *     不属于 pin（跑了只是浪费时间）。
 *   · test/sw-shell / static-html-cache / keypool 里其余 createHash 都是**运行时自洽**计算，不钉源文件。
 *
 * markers = 该文件"仍然是 pin 用例"的签名。签名漂移只**警告**（pin 用例照跑不误，值不会退化）；
 * 文件整个消失才是硬失败。真正的硬校验在 test/guards.test.js 里。
 */
const PIN_TESTS = [
  {
    file: 'test/remediation.test.js',
    why: 'CSP：web/index.html 内联守卫脚本的 sha256 必须在 src/static.js 的白名单里',
    markers: [/sha256-/, /static\.js/],
  },
  {
    file: 'test/brand-v2.test.js',
    why: 'brand v2 manifest：sourceSha256 + 23 个导出资产的 sha256/bytes',
    markers: [/sourceSha256/, /manifest\.files/],
  },
  {
    file: 'test/sw-shell.test.js',
    why: 'SHELL_LEDGER：web/sw.js 的 SHELL 清单指纹台账（改清单必须升 VERSION 并登记新指纹）',
    markers: [/SHELL_LEDGER/, /fingerprint\(list\)/],
  },
];

/**
 * 这两条用例把**文本文件的字节哈希**钉死了，所以工作区 CRLF（core.autocrlf=true）
 * 会让它们假红 —— 只有"它们失败 + 检测到行尾差异 + 静态复核通过"三者同时成立才降级。
 * 名字用子串匹配（node --test 的 spec reporter 会在名字后带耗时）。
 */
const CRLF_SENSITIVE_TESTS = [
  {
    file: 'test/remediation.test.js',
    name: 'CSP：index.html 的内联脚本哈希与 static.js 白名单一致',
  },
  {
    file: 'test/brand-v2.test.js',
    name: 'brand v2: manifest pins source and every raster/icon export by SHA-256',
  },
];

/** CSP pin 覆盖的页面（src/static.js 注释里的"两端的初始化守卫"） */
const CSP_PAGES = ['web/index.html', 'web/m/index.html'];
/** 品牌 pin 的根目录 */
const BRAND_DIR = 'design/brand/v2';
/** 行尾会被 git 规范化、必须按"仓库字节"算哈希的扩展名（二进制不做归一化） */
const TEXT_EXT = /\.(?:html?|js|css|svg|json|md|txt|webmanifest)$/i;

/**
 * 以 index/游标语义命名的变量：`x >= 0` 对它们是真断言（indexOf 找不到才是 -1），
 * 不能当成"恒真比较"误报。误报会让守卫失去信任，所以这里宁可保守。
 */
const INDEXISH = /^(?:i|j|k|n|m|idx|index|at|pos|found|biz|off|offset|line|col|row|seq|slot|seat|no|num)$/;

/**
 * 恒真 / 宽容断言。这些写法会让用例"永远绿"，比没有测试更糟（它给人安全感）。
 * 规则只在**代码骨架**上匹配（注释去掉、字符串字面量换成 ""、正则字面量换成 /re/），
 * 所以把 `assert.ok(true)` 写在字符串/注释里不会被误报。
 * `accept(match)` 可选：对正则命中做进一步甄别（避免误报）。
 */
const HYGIENE_RULES = [
  {
    id: 'ok-literal-truthy',
    desc: 'assert.ok(字面真值)：条件永远为真，用例等于没写',
    re: /\bassert(?:\.ok)?\(\s*(?:true|[1-9]\d*)\s*[,)]/,
  },
  {
    id: 'always-true-compare',
    desc: 'assert.ok(x >= 0) / assert.ok(x.length >= 0)：长度、计数、时长这类量恒 ≥ 0，断言永远成立',
    re: /\bassert(?:\.ok)?\(([^;]*?)\s*>=\s*0\s*(?=[,)])/,
    accept(m) {
      // 只看 ">= 0" 左边最末尾那个操作数：a.b.c / a.b() / 字面量
      const operand = /([\w$.[\]]+(?:\([^()]*\))?)\s*$/.exec(m[1]);
      if (!operand) return false;
      const expr = operand[1];
      if (/\.(?:length|size|byteLength|count)$/.test(expr)) return true; // 长度/计数：证明得了的恒真
      if (/^\d+$/.test(expr)) return true; // 常量比较，如 assert.ok(5 >= 0)
      if (/\(/.test(expr)) return false; // 函数调用（indexOf/findIndex 系列返回 -1，>= 0 是真断言）
      const last = expr.split('.').pop();
      return !INDEXISH.test(last); // 排除 i/idx/at/offset 这类游标变量
    },
  },
  {
    id: 'equals-alternative-literal',
    desc: 'assert.strictEqual(x, 404 || 500)：`404 || 500` 求值就是 404，想放过两个状态码却只放过一个（意图与行为不符）',
    re: /\bassert\.(?:strictEqual|equal|deepStrictEqual)\(\s*[^,;]+,\s*\d+\s*\|\|\s*\d+\s*[,)]/,
  },
  {
    id: 'ok-status-disjunction',
    desc: 'assert.ok(status === 404 || status === 500)：两个状态码都算过',
    re: /\bassert\.ok\([^;]*?([\w$.[\]]+)\s*===?\s*\d{3}\s*\|\|\s*\1\s*===?\s*\d{3}[^;]*?[,)]/,
  },
  {
    id: 'ok-tautology-disjunction',
    desc: 'assert.ok(x !== 1 || x !== 2)：至少有一个不等 → 恒真',
    re: /\bassert\.ok\([^;]*?([\w$.[\]]+)\s*!==?\s*\d+\s*\|\|\s*\1\s*!==?\s*\d+[^;]*?[,)]/,
  },
  {
    id: 'ok-truthy-fallback',
    desc: 'assert.ok(x !== undefined || true) / assert.ok(true || x)：`|| true` 是恒真兜底',
    // 注意 `x === true || y` 是正常写法（断言 x 是布尔真），必须排除；只认"裸 true 作为 || 的一侧"
    re: /\bassert(?:\.ok)?\(\s*true\s*\|\||\bassert(?:\.ok)?\([^;]*?\|\|\s*true\s*[,)]/,
  },
];

/** 归一化行内容：指纹必须对缩进/空白改动免疫（只对人真的改了断言敏感） */
const normalizeText = (text) => String(text).replace(/\s+/g, ' ').trim();

/** 行内容指纹：文件 + 规则 + 归一化行内容（不含行号 → 上下挪代码不会变成"新违规"） */
const fingerprintOf = (file, rule, text) =>
  crypto.createHash('sha256').update(`${file}\n${rule}\n${normalizeText(text)}`).digest('hex').slice(0, 16);

const sha256hex = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const sha256b64 = (buffer) => `sha256-${crypto.createHash('sha256').update(buffer).digest('base64')}`;

/**
 * 把源码削成"代码骨架"：去掉注释、字符串字面量换成 ""、正则字面量换成 /re/（保留换行以保住行号）。
 * 为什么不用 scripts/lint.js 的同名工具：那个不识别正则字面量，而测试里满是 `/…"…/` 这种写法，
 * 会把后面真正的代码吞掉（假阴性）。这里多一步正则启发式。
 *
 * keepComments=true 时保留注释、但**照样清空字符串/正则**：用来找 `// GUARD-ALLOW: <理由>`。
 * 这一步是必要的：JS 标识符里不可能出现 `-`，所以字符串/正则被清空后，还留着 GUARD-ALLOW 的地方
 * 只可能是注释 —— 于是"文档里提到 GUARD-ALLOW"或"测试名里写着 GUARD-ALLOW"都不会被误当成豁免指令。
 */
function stripForScan(src, { keepComments = false } = {}) {
  let out = '';
  let i = 0;
  let prev = ''; // 上一个有意义的输出字符，用来判断 `/` 是除法还是正则
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      if (keepComments) out += src.slice(start, i);
      continue;
    }
    if (c === '/' && c2 === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n' && !keepComments) out += '\n';
        i++;
      }
      i += 2;
      if (keepComments) out += src.slice(start, i);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        if (src[i] === '\n') out += '\n';
        i++;
      }
      out += quote === '`' ? '``' : '""';
      prev = '"';
      continue;
    }
    if (c === '/' && !/[\w$)\]]/.test(prev)) {
      // 正则字面量：前一个有效字符不可能是"值"（标识符/数字/右括号）时才算
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break; // 没闭合，当普通字符处理
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { j++; closed = true; break; }
        j++;
      }
      if (closed) {
        i = j;
        out += '/re/';
        prev = '/';
        continue;
      }
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** 递归列出 test/**\/*.test.js（绝对路径，已排序） */
function listTestFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.test.js')) out.push(p);
    }
  };
  walk(path.join(root, 'test'));
  return out.sort();
}

const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

/**
 * 豁免指令：注释（`//` 或 `/*`）**紧跟**标记，且标记后必须写理由。
 * 传进来的必须是 keepComments 版的"代码骨架"（字符串/正则已被清空）。
 * 返回理由字符串；只是标记没理由 → null；压根不是指令（文档里提到标记）→ null。
 */
function directiveReason(codeLine) {
  const m = /(?:\/\/|\/\*)\s*GUARD-ALLOW\s*[:：—-]\s*(\S.*)$/.exec(codeLine || '');
  if (!m) return null;
  return m[1].replace(/\*\/\s*$/, '').trim() || null;
}

/** 写成了指令的样子、但没写理由（`// GUARD-ALLOW` 后面什么都没有）→ 不生效，要单独点名 */
const isBareDirective = (codeLine) => /(?:\/\/|\/\*)\s*GUARD-ALLOW\s*(?:\*\/)?\s*$/.test(codeLine || '');

/**
 * 扫描 test/**\/*.test.js 的恒真/宽容断言。
 * 返回 { violations, allowed, bareTags }：
 *   violations 未豁免的违规（含 fingerprint）
 *   allowed    生效的豁免（含理由）—— 一定要打印出来
 *   bareTags   写了 GUARD-ALLOW 却没写理由的指令（不生效，按违规处理）
 */
function scanAssertionHygiene(root = ROOT) {
  const violations = [];
  const allowed = [];
  const bareTags = [];
  for (const abs of listTestFiles(root)) {
    // 统一成 LF：这个仓库里有个别文件含裸 \r 换行（autocrlf 的历史包袱），不归一化会让行号漂移
    const raw = fs.readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n');
    const rawLines = raw.split('\n');
    const codeLines = stripForScan(raw).split('\n');
    const allowLines = stripForScan(raw, { keepComments: true }).split('\n');
    const file = toRel(root, abs);
    allowLines.forEach((line, i) => {
      if (isBareDirective(line)) bareTags.push({ file, line: i + 1, text: (rawLines[i] || '').trim() });
    });
    codeLines.forEach((text, i) => {
      const rawText = (rawLines[i] || '').trim();
      for (const rule of HYGIENE_RULES) {
        const re = rule.re.global ? rule.re : new RegExp(rule.re.source, rule.re.flags + 'g');
        let matched = false;
        for (const m of text.matchAll(re)) {
          if (rule.accept && !rule.accept(m)) continue;
          matched = true;
          break; // 同一行同一规则只报一次
        }
        if (!matched) continue;
        // 豁免可以写在同一行，也可以写在**上一行**（且必须写理由）
        const reason = directiveReason(allowLines[i]) || directiveReason(allowLines[i - 1]);
        const line = i + 1;
        if (reason) allowed.push({ file, line, rule: rule.id, reason, text: rawText });
        else violations.push({ file, line, rule: rule.id, text: rawText, fingerprint: fingerprintOf(file, rule.id, rawText) });
      }
    });
  }
  return { violations, allowed, bareTags };
}

/** 读基线（格式非法就抛错——绝不当成"空基线"静默放过） */
function loadBaseline(file) {
  if (!fs.existsSync(file)) return { version: BASELINE_VERSION, violations: [] };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || data.version !== BASELINE_VERSION || !Array.isArray(data.violations)) {
    throw new Error(`基线文件格式非法（需要 { version: ${BASELINE_VERSION}, violations: [] }）：${file}`);
  }
  for (const v of data.violations) {
    if (!v || typeof v.file !== 'string' || typeof v.rule !== 'string' || typeof v.fingerprint !== 'string') {
      throw new Error(`基线条目缺字段（需要 file/rule/fingerprint）：${JSON.stringify(v)}`);
    }
  }
  return data;
}

/** 基线文件内容（排序后写入，一眼能看懂） */
function baselineContent(violations) {
  const rows = [...violations].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return JSON.stringify({
    version: BASELINE_VERSION,
    note: '断言卫生基线（FIX-20）：登记**历史存量**的恒真/宽容断言，避免一次性大改无关文件。'
      + '键 = fingerprint（文件 + 规则 + 归一化行内容），行号只作参考。'
      + '新增违规会让 node scripts/check-guards.js 失败；确有理由的例外请改用源码里的 // GUARD-ALLOW: <理由>，'
      + '收拾干净后用 node scripts/check-guards.js --update-baseline 收缩本文件。',
    generator: 'node scripts/check-guards.js --update-baseline',
    violations: rows.map((v) => ({ file: v.file, line: v.line, rule: v.rule, text: v.text, fingerprint: v.fingerprint })),
  }, null, 2) + '\n';
}

/** 跑一条 git 命令；encoding='buffer' 时 stdout 是 Buffer */
function gitRun(root, args, { spawn = spawnSync, encoding = 'utf8' } = {}) {
  const res = spawn('git', args, { cwd: root, encoding });
  return { ok: !res.error && res.status === 0, status: res.status, stdout: res.stdout, error: res.error };
}

/**
 * 取"CI 会看到的字节"（**行尾免疫**的根基）：
 *   1. 文本文件且工作区与 HEAD 相比"按 git 的过滤器没有差异" → 用 `git cat-file blob HEAD:<path>`
 *      （这正是 CI 检出后拿到的字节；工作区是 CRLF 也只是本地假象）；
 *   2. 工作区有真实未提交改动（或文件不在 git / 没有 git）→ 退回工作区内容，
 *      文本按 LF 归一化（= git 提交时会写进 blob 的形态；二进制不做归一化，避免改坏字节）。
 * 返回 { bytes, via, drift }：drift=true 表示"工作区字节 ≠ 仓库/CI 字节（行尾差异）"。
 */
function ciViewBytes(root, rel, opts = {}) {
  const wt = fs.readFileSync(path.join(root, rel));
  if (!TEXT_EXT.test(rel)) return { bytes: wt, via: '工作区（二进制，行尾无关）', drift: false };
  const clean = gitRun(root, ['diff', '--quiet', 'HEAD', '--', rel], opts);
  if (clean.ok) {
    const blob = gitRun(root, ['cat-file', 'blob', `HEAD:${rel}`], { ...opts, encoding: 'buffer' });
    if (blob.ok && Buffer.isBuffer(blob.stdout) && blob.stdout.length) {
      return { bytes: blob.stdout, via: 'git HEAD blob（= CI 字节）', drift: !blob.stdout.equals(wt) };
    }
  }
  const lf = Buffer.from(wt.toString('binary').replace(/\r\n/g, '\n'), 'binary');
  return { bytes: lf, via: '工作区（行尾已归一为 LF）', drift: !lf.equals(wt) };
}

/**
 * 腿 A1：按"CI 字节"直接复核 CSP 白名单与品牌 manifest pin。
 * 这是腿 A2（跑测试文件）的行尾免疫替身，同时补上了 A2 **没覆盖**的一环：
 * test/remediation.test.js 只校验 web/index.html 的内联哈希，web/m/index.html 的那个没人管 ——
 * 这里两个都校验（并且会报出白名单里的陈旧条目）。
 */
function pinStaticChecks(root, opts = {}) {
  const failures = [];
  const warnings = [];
  const lines = [];
  let drift = false;
  const check = (rel) => {
    const view = ciViewBytes(root, rel, opts);
    if (view.drift) drift = true;
    return view;
  };

  // ---- CSP：两个 HTML 的内联守卫脚本哈希必须在 src/static.js 的白名单里 ----
  const staticView = check('src/static.js');
  const csp = staticView.bytes.toString('utf8');
  const whitelist = new Set([...csp.matchAll(/sha256-[A-Za-z0-9+/=]{20,}/g)].map((m) => m[0]));
  const used = new Set();
  for (const page of CSP_PAGES) {
    const view = check(page);
    const inline = [...view.bytes.toString('utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    if (!inline.length) {
      failures.push(`${page} 里找不到内联守卫脚本（<script>…</script>）——CSP 白名单的语义前提变了，请复核`);
      continue;
    }
    for (const code of inline) {
      const hash = sha256b64(code);
      used.add(hash);
      if (whitelist.has(hash)) lines.push(`${page} 内联脚本 ${hash} ∈ CSP 白名单 ✓`);
      else failures.push(`${page} 内联脚本哈希 ${hash} 不在 src/static.js 的 CSP 白名单里（CSP 会静默拦截；改内联脚本必须同步白名单）`);
    }
  }
  for (const h of whitelist) {
    if (!used.has(h)) warnings.push(`CSP 白名单里的 ${h} 已没有页面在用（陈旧条目，同步白名单时顺手删掉）`);
  }

  // ---- 品牌 manifest：sourceSha256 + 每个导出资产的 sha256/bytes ----
  const manifestView = check(`${BRAND_DIR}/export/manifest.json`);
  let manifest = null;
  try {
    manifest = JSON.parse(manifestView.bytes.toString('utf8'));
  } catch (e) {
    failures.push(`品牌 manifest 解析失败：${e.message}`);
  }
  if (manifest) {
    const srcView = check(manifest.source);
    if (sha256hex(srcView.bytes) === manifest.sourceSha256) lines.push(`${manifest.source} 的 sourceSha256 ✓`);
    else failures.push(`品牌 manifest.sourceSha256 与 ${manifest.source} 的内容不符（改 SVG 必须重新 pin：npm run brand:apply）`);
    let bad = 0;
    for (const f of manifest.files || []) {
      const rel = `${BRAND_DIR}/export/${f.name}`;
      let view;
      try { view = check(rel); } catch { failures.push(`品牌导出资产读不到：${rel}`); bad++; continue; }
      if (view.bytes.length !== f.bytes || sha256hex(view.bytes) !== f.sha256) {
        failures.push(`${rel} 与 manifest pin 不符（改资产必须重新 pin：npm run brand:apply）`);
        bad++;
      }
    }
    lines.push(`品牌导出资产 ${(manifest.files || []).length} 个：${bad ? `${bad} 个不符 ✖` : '全部与 manifest pin 一致 ✓'}`);
  }
  return { failures, warnings, drift, lines };
}

/** 复核 pin 清单：文件必须存在；签名漂移只警告（pin 用例照跑，价值不退化） */
function verifyPinTests(root) {
  const warnings = [];
  for (const t of PIN_TESTS) {
    const abs = path.join(root, t.file);
    if (!fs.existsSync(abs)) {
      throw new Error(`pin 清单里的 ${t.file} 不存在 —— 测试被改名/删除了？请复核 scripts/check-guards.js 的 PIN_TESTS`);
    }
    const miss = t.markers.filter((re) => !re.test(fs.readFileSync(abs, 'utf8')));
    if (miss.length) warnings.push(`${t.file} 不再匹配 pin 签名 ${miss.map(String).join(' / ')} —— 请复核它是否还是 pin 用例`);
  }
  return warnings;
}

/** 从 node --test 输出里解析失败用例（名字 + 文件），用于把"行尾假红"和真失败分开 */
function parseFailures(output) {
  const text = String(output || '');
  const names = [...text.matchAll(/^✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?$/gm)].map((m) => m[1].trim());
  const files = [...text.matchAll(/^test at (.+?):(\d+):(\d+)$/gm)].map((m) => m[1].trim());
  const fail = Number((text.match(/^ℹ fail (\d+)$/m) || [])[1] || 0);
  return { names, files, fail, parsed: names.length > 0 && files.length > 0 };
}

/**
 * 只有"确实只失败了那两条行尾敏感的 pin 用例"才算已知假红 —— 解析不出来就**不**降级（fail-safe）。
 */
function isKnownCrlfFalseRed(parsed) {
  if (!parsed.fail || !parsed.parsed) return false;
  const knownFiles = new Set(CRLF_SENSITIVE_TESTS.map((t) => t.file));
  if (parsed.files.some((f) => !knownFiles.has(f.split(path.sep).join('/')))) return false;
  return parsed.names.every((n) => CRLF_SENSITIVE_TESTS.some((t) => n.includes(t.name)));
}

/**
 * 腿 A2：子进程跑 pin 敏感用例（输出原样转发）。
 * 受限沙箱里管道捕获子进程输出可能 EPERM，那就退回 stdio: inherit（只留出口码）。
 */
function runPinTests({ root = ROOT, spawn = spawnSync, log = console.log, logErr = console.error, eolDrift = false } = {}) {
  const warnings = verifyPinTests(root);
  const files = PIN_TESTS.map((t) => t.file);
  log(`▶ pin 敏感用例：${files.length} 个文件（改 web/ 最容易漏的就是它们）`);
  for (const t of PIN_TESTS) log(`    · ${t.file} — ${t.why}`);
  for (const w of warnings) log(`  ⚠ ${w}`);
  const started = Date.now();
  let res = spawn(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8' });
  let output = '';
  if (res.error) {
    res = spawn(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
  } else {
    output = `${res.stdout || ''}${res.stderr || ''}`;
    const text = output.replace(/\s+$/, '');
    if (text) log(text);
  }
  const ms = Date.now() - started;
  const parsed = parseFailures(output);
  let ok = res.status === 0;
  let crlfFalseRed = false;
  if (!ok && eolDrift && isKnownCrlfFalseRed(parsed)) {
    ok = true;
    crlfFalseRed = true;
    logErr('  ⚠ 上面这两条 pin 用例的失败是**本机行尾假红**，不是真缺陷：');
    logErr('    工作区字节 ≠ 仓库字节（core.autocrlf=true 检出成 CRLF），而这两条用例钉的是字节哈希。');
    logErr('    已按仓库/CI 字节（LF）复核：白名单与品牌 pin 都一致，**无需重新 pin**，以 CI 的 LF 结果为准。');
  }
  if (ok) log(`✓ pin 敏感用例通过（${files.length} 文件，${(ms / 1000).toFixed(1)}s${crlfFalseRed ? '，含行尾假红降级' : ''}）`);
  else logErr(`✖ pin 敏感用例失败（${files.length} 文件，${(ms / 1000).toFixed(1)}s）：${files.join(' ')}`);
  return { ok, status: res.status, ms, files, warnings, parsed, crlfFalseRed, captured: output.length > 0 };
}

function parseArgs(argv) {
  const opts = { root: null, baseline: null, assertionsOnly: false, updateBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--assertions-only' || a === '--no-pins') opts.assertionsOnly = true;
    else if (a === '--update-baseline') opts.updateBaseline = true;
    else if (a === '--root') opts.root = argv[++i];
    else if (a === '--baseline') opts.baseline = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

const USAGE = '用法：node scripts/check-guards.js [--assertions-only] [--update-baseline] [--root <dir>] [--baseline <file>]';

/** 主流程（导出以便测试；require 本模块不会执行它） */
function checkGuards(opts = {}) {
  const root = opts.root ? path.resolve(opts.root) : ROOT;
  const baselinePath = opts.baseline
    ? path.resolve(opts.baseline)
    : path.join(root, 'scripts', 'guards-baseline.json');
  const log = opts.log || console.log;
  const logErr = opts.logErr || console.error;
  const badge = { ok: true };

  log(`▶ 防忘记守卫（check-guards）：root=${root}`);

  // ---- 腿 A1：行尾免疫的静态 pin 复核 ----
  let staticPins = null;
  if (!opts.assertionsOnly) {
    staticPins = pinStaticChecks(root, { spawn: opts.gitSpawn });
    log('▶ pin 静态复核（按 CI 字节，逐条：CSP 白名单 / 品牌 manifest）');
    for (const l of staticPins.lines) log(`    · ${l}`);
    for (const w of staticPins.warnings) log(`  ⚠ ${w}`);
    if (staticPins.drift) {
      log('    · 行尾差异：有（工作区字节 ≠ 仓库字节）——上面已按仓库/CI 字节校验，无需重新 pin');
    } else {
      log('    · 行尾差异：无（工作区字节与仓库一致）');
    }
    for (const f of staticPins.failures) logErr(`  ✖ ${f}`);
    if (staticPins.failures.length) badge.ok = false;
  }

  // ---- 腿 A2：pin 敏感用例 ----
  let pin = null;
  if (!opts.assertionsOnly) {
    pin = runPinTests({ root, log, logErr, spawn: opts.spawn, eolDrift: staticPins.drift });
    if (!pin.ok) badge.ok = false;
  } else {
    log('▶ pin 敏感用例：已跳过（--assertions-only）');
  }

  // ---- 腿 B：断言卫生 ----
  const { violations, allowed, bareTags } = scanAssertionHygiene(root);
  const baseline = loadBaseline(baselinePath);
  const known = new Set(baseline.violations.map((v) => v.fingerprint));
  const fresh = violations.filter((v) => !known.has(v.fingerprint));
  const historical = violations.filter((v) => known.has(v.fingerprint));
  const present = new Set(violations.map((v) => v.fingerprint));
  const obsolete = baseline.violations.filter((v) => !present.has(v.fingerprint));

  log(`\n▶ 断言卫生（test/**/*.test.js，${HYGIENE_RULES.length} 条规则）`);
  log(`    当前违规 ${violations.length} 处：基线内历史 ${historical.length} 处、基线外新增 ${fresh.length} 处`);
  for (const v of fresh) {
    logErr(`  ✖ ${v.file}:${v.line}  [${v.rule}] ${v.text}`);
    logErr(`      → ${HYGIENE_RULES.find((r) => r.id === v.rule).desc}`);
    logErr('      → 修掉它，或（确有理由时）在该行/上一行写 `// GUARD-ALLOW: <理由>`');
  }
  if (historical.length) {
    log('  ℹ 基线内历史违规（本次不阻断，收拾干净后可 --update-baseline 收缩基线）：');
    for (const v of historical) log(`      · ${v.file}:${v.line}  [${v.rule}] ${v.text}`);
  }
  log(`  ℹ 豁免 ${allowed.length} 条（GUARD-ALLOW）—— 看得见的债务：`);
  if (!allowed.length) log('      （当前无豁免标记）');
  for (const a of allowed) log(`      · ${a.file}:${a.line}  [${a.rule}] 理由：${a.reason}`);
  if (bareTags.length) {
    logErr(`  ⚠ ${bareTags.length} 处 GUARD-ALLOW 没写理由 → 不生效（已按违规处理）：`);
    for (const b of bareTags) logErr(`      · ${b.file}:${b.line} ${b.text}`);
  }
  if (obsolete.length) {
    log(`  ℹ 基线里 ${obsolete.length} 条已不再命中（修好了/测试改了）——可跑 --update-baseline 清理：`);
    for (const o of obsolete) log(`      · ${o.file}:${o.line}  [${o.rule}] ${o.text}`);
  }

  if (opts.updateBaseline) {
    fs.writeFileSync(baselinePath, baselineContent(violations), 'utf8');
    log(`\n✓ 已重写基线：${baselinePath}（登记 ${violations.length} 处违规；豁免仍由源码里的 ${ALLOW_TAG} 注释负责）`);
  }

  if (fresh.length) badge.ok = false;
  log(badge.ok ? '\n✓ 守卫通过' : '\n✖ 守卫失败（见上）');
  return { ok: badge.ok, pin, staticPins, violations, fresh, historical, allowed, bareTags, obsolete, baselinePath, root };
}

function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`✖ ${e.message}\n${USAGE}`);
    return 1;
  }
  if (opts.help) { console.log(USAGE); return 0; }
  try {
    return checkGuards(opts).ok ? 0 : 1;
  } catch (e) {
    console.error(`✖ 守卫自身出错：${e.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = {
  ROOT,
  BASELINE_VERSION,
  ALLOW_TAG,
  PIN_TESTS,
  CRLF_SENSITIVE_TESTS,
  CSP_PAGES,
  BRAND_DIR,
  HYGIENE_RULES,
  stripForScan,
  normalizeText,
  fingerprintOf,
  listTestFiles,
  directiveReason,
  isBareDirective,
  scanAssertionHygiene,
  loadBaseline,
  baselineContent,
  gitRun,
  ciViewBytes,
  pinStaticChecks,
  verifyPinTests,
  parseFailures,
  isKnownCrlfFalseRed,
  runPinTests,
  parseArgs,
  checkGuards,
  main,
  USAGE,
};
