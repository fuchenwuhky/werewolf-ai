#!/usr/bin/env node
/**
 * brand-eol-pin-lib.js — 「字节哈希路径必须免受 git 行尾转换」的判定核心（零依赖，纯逻辑）
 *
 * 为什么单独成模块：这套判据的价值全在"判得准"，所以它必须能被测试逐分支钉住
 * （见 test/brand-line-endings-pin.test.js，含与 `git check-attr` 的逐条差分）。
 * 同目录的 check-brand-assets.js 是**整仓装配型**脚本：它要一整棵真实资产树才能跑，
 * 测试里加载它等于把整份 CLI 脚本拉进覆盖率分母。把判据放在这里、数据由调用方注入
 * （root / mapping / exportDir），就能既"测得到"又不用为了凑数字去伪造覆盖。
 *
 * 调用方（scripts/check-brand-assets.js）负责注入真实数据并把 io.fail 接到退出码上；
 * 本模块**不读** brand-v2-lib.js，也不持有任何仓库绝对路径。
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- 4. 行尾钉版覆盖（元断言：字节哈希路径必须免受行尾转换） ----------
/**
 * ## 这条断言是怎么来的（真实缺陷，2026-09-21）
 * 同目录脚本的那三节检查全部按**字节**做 SHA-256 比对。当时 web/assets/icon.svg 就在比对范围里，
 * 却**没有**被 .gitattributes 钉成 `text eol=lf`。Windows 的 core.autocrlf=true 会让
 * 全新检出把它写成 CRLF（实测 7659 字节 / 68 个 CR ⇒ sha256 8404ea01…），于是
 * **主仓库（工作区恰好是脚本写出的 LF）绿，任何全新 clone / CI 红** —— 门禁不可复现，
 * 而且差点被当成"manifest pin 过时"去重钉本来正确的值。第一次只补了这一份，
 * 回干净检出复验仍然红，才暴露出第二份（web/assets/brand/wolf-emblem.svg）。
 * 这类缺陷在主仓库里**永远看不见**（工作区字节是对的），只有"静态判定属性"才能当场抓住。
 *
 * ## 断言内容
 * 凡是被本守卫按字节比对的路径，必须满足其中之一：
 *   · `text eol=lf`（.gitattributes 明确钉住）；
 *   · 明确不转换（`-text`；或 git 内置宏 `binary` = `-diff -merge -text`）**且内容确为二进制**；
 *   · 内容确为二进制且没有任何规则 —— 放行（git 自己不会对二进制做行尾转换，
 *     .gitattributes 的注释里也明确要求**不要**给 PNG/ICO 写规则）——但这一条会**逐条列名**，
 *     不做静默假设；
 *   · 路径集合的推导来源见 collectByteHashedPaths()：品牌 manifest（source + files[]）、
 *     MAPPING 里真正参与哈希比对的条目、以及 src/static.js 的 CSP 白名单命中的内联脚本页面。
 * 判定只读 .gitattributes + 文件内容，**不看**工作区行尾是否恰好正确 —— 这正是它能抓住
 * "本机绿、干净检出红"的原因。
 * 匹配语义覆盖了什么、**没有**覆盖什么：见 resolveAttributes() 的注释（别把没覆盖的当覆盖）。
 */

const GITATTRIBUTES = '.gitattributes';

/** 会改写工作区字节的属性：与行尾转换同类（钉的是字节，就不能被任何过滤器/编码改写） */
const BYTE_REWRITING_ATTRS = ['filter', 'ident', 'working-tree-encoding'];

/** git 内置宏：`binary` = `-diff -merge -text`（diff/merge 与字节无关，登记它们只为展开完整） */
const BUILTIN_MACROS = Object.freeze({
  binary: [
    { name: 'diff', state: 'unset' },
    { name: 'merge', state: 'unset' },
    { name: 'text', state: 'unset' },
  ],
});

/** 二进制判定：git 的 buffer_is_binary 近似（前 8000 字节内出现 NUL 就按二进制处理） */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** 数 CR 字节：失败文案里用来区分"仓库 blob 就是 CRLF"与"只是本机检出脏了" */
function countCr(buf) {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 13) n++;
  return n;
}

/**
 * gitattributes 通配符 → 正则。
 * 覆盖：`*`（不跨 `/`）、`?`（不跨 `/`）、`[...]` 字符类（含 `[!...]`）、
 *      `**` 前缀（零或多层目录）、`**` 目录后缀（目录下全部）、`**` 中间夹层（零或多层中间目录）。
 * 未覆盖：C 风格引号模式（`"a b.txt"`）；模式里的 `\` 按**字面量**处理（与 git 相同，
 *       git 不会把 `a\ b.txt` 读成含空格的模式 —— 差分用例钉住了这一点）。
 */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      const atSegmentStart = i === 0 || glob[i - 1] === '/';
      if (glob[i + 1] === '*' && atSegmentStart && glob[i + 2] === '/') { out += '(?:[^/]+/)*'; i += 2; continue; }
      if (glob[i + 1] === '*' && atSegmentStart && i + 2 === glob.length) { out += '.*'; i += 1; continue; }
      // 非法的 `**` 位置：git 的 wildmatch 按普通 `*` 处理
      if (glob[i + 1] === '*') { out += '[^/]*'; i += 1; continue; }
      out += '[^/]*';
      continue;
    }
    if (c === '?') { out += '[^/]'; continue; }
    if (c === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close > i) {
        let cls = glob.slice(i + 1, close);
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        out += `[${cls}]`;
        i = close;
        continue;
      }
      // 未闭合的 `[`：实测 git 的 wildmatch 让**整条模式不匹配任何路径**（不是当字面量用），
      // 这里返回"永不匹配"的正则 —— 宁可报红，也不虚报覆盖。
      return /(?!)/;
    }
    out += /[\\^$+.(){}|?*[\]]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${out}$`);
}

/** 解析一段属性列表（`text` / `-text` / `!text` / `eol=lf`） */
function parseAttrTokens(rest) {
  const attrs = [];
  for (const token of String(rest).trim().split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith('-')) attrs.push({ name: token.slice(1), state: 'unset' });
    else if (token.startsWith('!')) attrs.push({ name: token.slice(1), state: 'unspecified' });
    else {
      const eq = token.indexOf('=');
      if (eq > 0) attrs.push({ name: token.slice(0, eq), state: 'value', value: token.slice(eq + 1) });
      else attrs.push({ name: token, state: 'set' });
    }
  }
  return attrs;
}

/** 解析一行 .gitattributes：返回 { pattern, attrs }；空行/注释返回 null */
function parseGitAttributesLine(raw) {
  const line = String(raw).replace(/\r$/, '');
  if (!line.trim() || line.trimStart().startsWith('#')) return null;
  let pattern = '';
  // git 会跳过行首空白再取模式（实测 `  text eol=lf` 的模式是 `text`，不是空模式），
  // 所以这里也跳过；否则带缩进的规则在本断言眼里等于不存在 —— 会误报"缺规则"。
  let i = 0;
  while (i < line.length && /\s/.test(line[i])) i += 1;
  // 注意：模式里的 `\` **不做反转义** —— 与 git 一致（实测：`a\ b.txt text eol=lf` 在 git 里
  // 模式是 `a\`、`b.txt` 被当成属性名，而不是"含空格的模式"；差分用例钉住了这一点）。
  // 想在模式里写空白只能用 C 风格引号，那属于本文件明确"未覆盖"的形态。
  while (i < line.length && !/\s/.test(line[i])) {
    pattern += line[i];
    i += 1;
  }
  return { pattern, attrs: parseAttrTokens(line.slice(i)) };
}

/** `[attr]name 属性…` 宏定义行 → { name, body }；不是宏定义返回 null */
function parseMacroDefinition(raw) {
  const m = /^\[attr\]\s*([\w.-]+)\s*(.*)$/.exec(String(raw).replace(/\r$/, '').trim());
  return m ? { name: m[1], body: m[2] } : null;
}

/** 展开宏（内置 binary + 用户 [attr] 定义）；递归过深直接抛错（绝不静默不展开） */
function expandMacroAttrs(attrs, macros, depth = 0) {
  if (depth > 8) throw new Error('[attr] 宏递归过深（定义自引用？）');
  const out = [];
  for (const a of attrs) {
    const body = macros[a.name];
    out.push(...(body ? expandMacroAttrs(body, macros, depth + 1) : [a]));
  }
  return out;
}

/** 单个 glob 与路径（都相对该 .gitattributes 所在目录）匹配 */
function matchAttributeGlob(pattern, target) {
  return globToRegExp(pattern.replace(/^\/+/, '')).test(target);
}

/**
 * 一条规则是否命中该路径（git 的语义）：
 *   · 含 `/`（或以 `/` 开头）⇒ 与该 .gitattributes 所在目录起算的**完整相对路径**匹配；
 *   · 不含 `/` ⇒ 只比对**文件名**，任何目录层都能命中；
 *   · 以 `/` 结尾 ⇒ **不命中任何路径**。这一条与 .gitignore 的"目录规则"不同：
 *     实测 `git check-attr`（git 2.53）对 `plain/ text=auto` 查 plain/one.txt 得到
 *     `text: unspecified`（属性匹配时项类型未知，带 MUSTBEDIR 的模式匹配不上）。
 *     这里跟随 git 判"不命中"：宁可让裸路径报红，也不虚报覆盖。
 */
function attributePatternMatches(pattern, relFromLayer) {
  if (pattern.endsWith('/')) return false;
  if (!pattern.includes('/')) return matchAttributeGlob(pattern, relFromLayer.split('/').pop());
  return matchAttributeGlob(pattern, relFromLayer);
}

/**
 * 解析某路径的 .gitattributes **生效属性**（按 git 的匹配语义）。
 *
 * ## 覆盖（有 meta 测试逐条与 `git check-attr` 差分复核）
 *   · 仓库根 → 路径所在目录逐层的 .gitattributes（下层文件后应用，覆盖上层）；
 *   · 同一文件内**后出现的规则优先**，且**逐属性**覆盖（一行没提到的属性保持原值）；
 *   · 不含 `/` 的模式匹配任意层的文件名；含 `/` 的模式相对该 .gitattributes 所在目录；
 *     `/` 开头与不带头等价（gitattributes 的模式本来就相对该文件所在目录）；
 *   · `**` 的三种位置（目录前缀、目录后缀、路径中间夹层）、`*`、`?`、`[...]`（含 `[!...]`）；
 *   · 以 `/` 结尾的模式：跟随 git 判"不命中任何路径"（实测，见 attributePatternMatches）；
 *   · `attr`（set）、`-attr`（unset）、`!attr`（置回未指定）、`attr=value`；
 *   · `[attr]` 宏与 git 内置宏 `binary`（= `-diff -merge -text`）：按文件**预扫描**定义、
 *     递归展开；用了"本文件里稍后才定义"的宏 → 记进 problems（git 不展开它，绝不静默放过）。
 *
 * ## 未覆盖（**别当已覆盖**）
 *   · `.git/info/attributes` 与 `core.attributesFile` 指向的全局属性文件（只读仓库内文件）；
 *   · C 风格引号模式（`"a b.txt"`）不支持；模式里的 `\` 与 git 一样按字面量处理
 *     （git 不把 `a\ b.txt` 当含空格的模式 —— 差分用例钉住）。
 *   · 大小写不敏感匹配（git 的 wildmatch 是大小写敏感的，这里也敏感）；
 *   · 二进制判定只用"NUL 检测"（git 还有非可打印字符比例的启发式）。
 * 属性文件读不动、宏递归等异常一律抛出，由调用方判失败（不吞错）。
 */
function resolveAttributes(root, relPath) {
  const posix = relPath.split(path.sep).join('/');
  const parts = posix.split('/');
  const dirs = ['.'];
  for (let i = 0; i < parts.length - 1; i++) dirs.push(parts.slice(0, i + 1).join('/'));
  const layers = [];
  for (const dir of dirs) {
    const rel = dir === '.' ? GITATTRIBUTES : `${dir}/${GITATTRIBUTES}`;
    if (fs.existsSync(path.join(root, rel))) layers.push({ rel, dir });
  }
  const attrs = new Map();
  const matches = [];
  const problems = [];
  for (const layer of layers) {
    const lines = fs.readFileSync(path.join(root, layer.rel), 'utf8').split('\n');
    const macros = { ...BUILTIN_MACROS };
    const declaredMacros = new Set(Object.keys(BUILTIN_MACROS));
    for (const raw of lines) {
      const def = parseMacroDefinition(raw);
      if (def) declaredMacros.add(def.name);
    }
    const definedMacros = new Set(Object.keys(BUILTIN_MACROS));
    const relFromLayer = layer.dir === '.' ? posix : posix.slice(layer.dir.length + 1);
    lines.forEach((raw, index) => {
      const def = parseMacroDefinition(raw);
      if (def) {
        macros[def.name] = parseAttrTokens(def.body);
        definedMacros.add(def.name);
        return;
      }
      const rule = parseGitAttributesLine(raw);
      if (!rule || !rule.pattern) return;
      if (!attributePatternMatches(rule.pattern, relFromLayer)) return;
      const from = { file: layer.rel, line: index + 1, text: String(raw).replace(/\r$/, '').trim() };
      for (const a of rule.attrs) {
        // git 要求"先定义后使用"：用到本文件里稍后才定义的宏时它**不会**展开 —— 点名，不静默
        if (declaredMacros.has(a.name) && !definedMacros.has(a.name)) problems.push({ ...from, macro: a.name });
      }
      const expanded = expandMacroAttrs(rule.attrs, macros);
      matches.push({ ...from, attrs: expanded });
      for (const a of expanded) attrs.set(a.name, { ...a, from });
    });
  }
  return { attrs, matches, layers: layers.map((l) => l.rel), problems };
}

/** 属性三态取值：(set) true / (unset) false / (value) 字符串 / (unspecified) 未指定 */
function attrState(attrs, name) {
  const a = attrs.get(name);
  if (!a || a.state === 'unspecified') return { known: false, value: undefined, from: a ? a.from : null };
  if (a.state === 'set') return { known: true, value: true, from: a.from };
  if (a.state === 'unset') return { known: true, value: false, from: a.from };
  return { known: true, value: a.value, from: a.from };
}

/** 判定依据（失败文案要用）：读过哪些 .gitattributes、命中几行、最后一行是什么 */
function describeAttributeLookup(matches, layers) {
  const read = layers.length ? layers.join('、') : '（仓库内没有 .gitattributes）';
  if (!matches.length) return `查过 ${read}：0 行命中该路径 ⇒ text/eol 均未指定`;
  const last = matches[matches.length - 1];
  return `查过 ${read}：${matches.length} 行命中该路径，最后一行是 ${last.file}:${last.line}「${last.text}」`;
}

/**
 * 一条"字节被 SHA-256 比对"的路径的行尾钉版判定。
 * 返回 status：pinned（已钉）/ binary（二进制内容、无需规则）/ missing（文件不存在）/
 *              fail（有行尾转换风险 —— 调用方必须判失败）。
 */
function eolPinVerdict(root, rel, sources) {
  const base = { path: rel, sources: [...sources] };
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return { ...base, status: 'missing', detail: '文件不存在（另有「文件缺失」失败项）' };
  const buf = fs.readFileSync(abs);
  const common = {
    ...base,
    binary: looksBinary(buf),
    cr: countCr(buf),
    bytes: buf.length,
    how: '',
    fixTarget: GITATTRIBUTES,
  };
  const { attrs, matches, layers, problems } = resolveAttributes(root, rel);
  common.how = describeAttributeLookup(matches, layers);
  common.fixTarget = layers.length ? layers[layers.length - 1] : GITATTRIBUTES;
  if (problems.length) return { ...common, status: 'fail', kind: 'late-macro', problems };
  for (const name of BYTE_REWRITING_ATTRS) {
    const st = attrState(attrs, name);
    if (st.known && st.value !== false) return { ...common, status: 'fail', kind: 'byte-rewriting', attr: name, rule: st.from };
  }
  const text = attrState(attrs, 'text');
  const eol = attrState(attrs, 'eol');
  let textValue = text.known ? text.value : undefined;
  // git 文档：设置 eol 就**隐含** text（无需内容判定即生效），所以 eol=lf 单独出现也算钉住
  if (textValue === undefined && eol.known && eol.value !== undefined) textValue = true;
  if (textValue === true || textValue === 'auto') {
    if (eol.known && eol.value === 'lf') return { ...common, status: 'pinned', via: 'text eol=lf', rule: eol.from };
    const kind = textValue === 'auto' ? 'text-auto' : (eol.known && eol.value === 'crlf' ? 'eol-crlf' : 'text-no-eol');
    return { ...common, status: 'fail', kind, rule: kind === 'eol-crlf' ? eol.from : text.from };
  }
  if (textValue === false) {
    if (common.binary) return { ...common, status: 'pinned', via: '-text/binary（内容确为二进制）', rule: text.from };
    return { ...common, status: 'fail', kind: 'unset-on-text', rule: text.from };
  }
  if (common.binary) return { ...common, status: 'binary' };
  return { ...common, status: 'fail', kind: 'uncovered-text' };
}

/** 失败文案：缺规则的路径 + 判定依据 + 一句可执行的修复提示（三件都要齐） */
function eolPinFailMessage(r) {
  const content = r.binary
    ? '二进制（前 8000 字节内有 NUL）'
    : `文本（${r.bytes} 字节、无 NUL、${r.cr} 个 CR）`;
  const out = [`行尾钉版缺失：被字节哈希的路径未免受行尾转换（来源：${r.sources.join('；')}）`];
  out.push(`· 内容判定：${content}`);
  out.push(`· 属性判定：${r.how}`);
  const ruleAt = (rule) => (rule ? `${rule.file}:${rule.line}「${rule.text}」` : '来源未知');
  if (r.kind === 'late-macro') {
    out.push(`· [attr] 宏在定义之前被使用（git 不会展开，属性实际未生效）：${r.problems.map((p) => `${ruleAt(p)} 用了未定义的宏 ${p.macro}`).join('；')}`);
    out.push(`· 修复：把 ${r.problems.map((p) => p.macro).join('/')} 的 [attr] 定义移到使用它的那行**之前**`);
  } else if (r.kind === 'byte-rewriting') {
    out.push(`· ${r.attr} 属性（${ruleAt(r.rule)}）会改写工作区字节 —— 与行尾转换同类，字节哈希必然对不上`);
    out.push(`· 修复：对这条路径去掉 ${r.attr}，改成「${r.path} text eol=lf」`);
  } else if (r.kind === 'eol-crlf') {
    out.push(`· 具体判据：eol=crlf（${ruleAt(r.rule)}）⇒ 检出时 LF 会被写成 CRLF，字节哈希必变`);
    out.push(`· 修复：把这条规则的 eol 改成 lf ⇒「${r.path} text eol=lf」`);
  } else if (r.kind === 'text-auto') {
    out.push('· 具体判据：text=auto ⇒ 行尾由 core.autocrlf / 内容判定决定，**不保证**是 LF（本机为 true 时必转 CRLF）');
    out.push(`· 修复：改成显式固定 ⇒ 在 ${r.fixTarget} 追加「${r.path} text eol=lf」`);
  } else if (r.kind === 'text-no-eol') {
    out.push('· 具体判据：text 已设但没固定 eol ⇒ 检出时按 core.autocrlf 写成本地行尾（本机为 true ⇒ CRLF）');
    out.push(`· 修复：在 ${r.fixTarget} 追加/补全「${r.path} text eol=lf」`);
  } else if (r.kind === 'unset-on-text') {
    out.push(`· 具体判据：-text/binary（${ruleAt(r.rule)}），但内容**不是**二进制（无 NUL）⇒ 规则与内容不符，pin 的语义不成立`);
    out.push(`· 修复：改成「${r.path} text eol=lf」（文本文件固定 LF；要标 binary 请先确认它真是二进制）`);
  } else {
    out.push('· git 语义：text 未固定 + core.autocrlf=true（Windows 默认检出）⇒ 检出时 LF→CRLF ⇒ 字节哈希改变');
    if (r.cr > 0) out.push(`· 注意：当前工作区该文件已有 ${r.cr} 个 CR（本机检出就是 CRLF）—— 补规则后还要重新检出该文件`);
    out.push('· 后果：主仓库（工作区恰好是脚本写出的 LF）绿，但任何全新 clone / CI 必红 —— 门禁不可复现');
    out.push(`· 修复：在 ${r.fixTarget} 追加一行（文本文件固定行尾为 LF）：`);
    out.push(`      ${r.path} text eol=lf`);
  }
  return out.join('\n      ');
}

/** 递归列 root/web 下的 .html（跳过 node_modules / .git） */
function listWebHtml(root) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const next = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path.join(abs, e.name), next);
      else if (e.name.endsWith('.html')) out.push(next);
    }
  };
  walk(path.join(root, 'web'), 'web');
  return out.sort();
}

/** 内联脚本的 CSP 哈希（sha256 + base64，与 src/static.js 白名单同一形态） */
function cspHash(bytes) {
  return `sha256-${crypto.createHash('sha256').update(bytes).digest('base64')}`;
}

/**
 * CSP 钉版的页面：内联守卫脚本的哈希出现在 src/static.js 的白名单里。
 * 判据完全来自实际数据（白名单 + 页面内联脚本内容），**不写死页面清单**；
 * 工作区 CRLF 时按"行尾归一为 LF"再试一次（pin 依然成立，只是本地检出脏了）。
 */
function collectCspPinnedPages(root) {
  const staticAbs = path.join(root, 'src', 'static.js');
  if (!fs.existsSync(staticAbs)) return [];
  const whitelist = new Set(
    [...fs.readFileSync(staticAbs, 'utf8').matchAll(/sha256-[A-Za-z0-9+/=]{20,}/g)].map((m) => m[0]),
  );
  const out = [];
  for (const rel of listWebHtml(root)) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const m of text.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      const lf = m[1].replace(/\r\n?/g, '\n');
      if (whitelist.has(cspHash(m[1])) || whitelist.has(cspHash(lf))) { out.push(rel); break; }
    }
  }
  return out;
}

/**
 * 所有"字节被 SHA-256 比对"的路径 → 来源说明。**从守卫实际消费的数据推导，不写死清单**：
 *   ① 品牌 manifest：source（sourceSha256）+ 每个导出资产（files[].sha256/bytes）；
 *   ② MAPPING：真正参与哈希比对的条目（color / adaptive-xml 只做文本解析，**不算**）
 *      以及它们读取的 v2 源文件；
 *   ③ src/static.js 的 CSP 白名单命中的内联脚本页面（它们的**内联脚本字节**被钉住）。
 */
function collectByteHashedPaths(root, mapping, exportDir) {
  const out = new Map();
  const add = (rel, source) => {
    if (!out.has(rel)) out.set(rel, new Set());
    out.get(rel).add(source);
  };
  const manifestAbs = path.join(root, exportDir, 'manifest.json');
  if (fs.existsSync(manifestAbs)) {
    let delivered = null;
    try { delivered = JSON.parse(fs.readFileSync(manifestAbs, 'utf8')); } catch { delivered = null; }
    if (delivered) {
      if (delivered.source) add(delivered.source, '品牌 manifest · sourceSha256');
      for (const f of delivered.files || []) add(`${exportDir}/${f.name}`, '品牌 manifest · files[].sha256/bytes');
    }
  }
  for (const entry of mapping) {
    if (entry.kind === 'color' || entry.kind === 'adaptive-xml') continue;
    add(entry.prod, `MAPPING · ${entry.kind}`);
    if (entry.v2) add(`${exportDir}/${entry.v2}`, `MAPPING · ${entry.kind} ← v2 源`);
  }
  for (const rel of collectCspPinnedPages(root)) add(rel, 'src/static.js CSP 白名单 · 内联守卫脚本');
  return new Map([...out].sort((a, b) => a[0].localeCompare(b[0])));
}

/** 按目录分组路径（几十条二进制不用一行一条，但名字要看得见） */
function groupPathsByDir(paths, maxNames = 6) {
  const groups = new Map();
  for (const p of paths) {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.';
    if (!groups.has(dir)) groups.set(dir, []);
    // 根目录文件的 dir 是 `.`（长度 1），不能拿 dir.length + 1 去切名字 —— 那会把 icon.svg 切成 on.svg
    groups.get(dir).push(dir === '.' ? p : p.slice(dir.length + 1));
  }
  return [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([dir, names]) => {
    const sorted = [...names].sort();
    const head = sorted.slice(0, maxNames).join(', ');
    const tail = sorted.length > maxNames ? `，…共 ${sorted.length} 个` : `（共 ${sorted.length} 个）`;
    return `      ${dir}/ ⇒ ${head}${tail}`;
  });
}

/**
 * 逐条判定 + 输出（**失败必须交给调用方**：本函数只调用 io.fail，绝不自己吞掉）。
 * opts = { root, mapping, exportDir, io: { pass, fail, log? } }
 *   · root/mapping/exportDir 由调用方注入（脚本传真实仓库数据，测试传合成仓库数据）；
 *   · io.pass / io.fail **必填**：判定失败要参与调用方的退出码，缺了就直接抛，
 *     避免"忘了接退出码 ⇒ 门禁变告警"这种最危险的退化；
 *   · io.log 只影响输出（默认 console.log）。
 * 返回 { rows, failed }：rows 是逐条判定结果，failed 是需要报红的那些（供测试断言）。
 */
function checkEolPinning(opts) {
  const { root, mapping, exportDir, io = {} } = opts || {};
  if (!Array.isArray(mapping) || typeof exportDir !== 'string' || !exportDir) {
    // 忘了注入这两样，"0 条字节哈希路径"会伪装成"全绿" —— 这种退化必须当场炸，不能静默通过
    throw new TypeError('checkEolPinning 需要调用方注入 mapping（数组）与 exportDir —— 忘了传会让"0 条路径"变成假绿');
  }
  if (typeof io.pass !== 'function' || typeof io.fail !== 'function') {
    throw new TypeError('checkEolPinning 需要 io.pass / io.fail —— 判定失败必须参与调用方的退出码，绝不能在这里被吞掉');
  }
  const passIt = io.pass;
  const failIt = io.fail;
  const log = io.log || ((line) => console.log(line));
  log('\n== 行尾钉版覆盖（字节哈希路径 ⇒ .gitattributes 必须 text eol=lf，或 -text/binary 且内容为二进制） ==');
  const pathMap = collectByteHashedPaths(root, mapping, exportDir);
  const rows = [...pathMap].map(([rel, sources]) => {
    try {
      return eolPinVerdict(root, rel, sources);
    } catch (e) {
      return {
        path: rel,
        sources: [...sources],
        status: 'fail',
        kind: 'attr-error',
        error: e.message,
        binary: false,
        cr: 0,
        bytes: 0,
        how: '',
        fixTarget: GITATTRIBUTES,
      };
    }
  });
  const byStatus = (s) => rows.filter((r) => r.status === s);
  const pinned = byStatus('pinned');
  const binaryOnly = byStatus('binary');
  const missing = byStatus('missing');
  const via = new Map();
  for (const sources of pathMap.values()) {
    for (const family of new Set([...sources].map((s) => s.split(' · ')[0]))) via.set(family, (via.get(family) || 0) + 1);
  }
  log(`  · 字节哈希路径 ${rows.length} 条（按来源去重：${[...via].map(([s, n]) => `${s} ${n} 条`).join('；')}）`);
  for (const r of pinned) {
    const note = r.cr > 0 ? `，但当前工作区有 ${r.cr} 个 CR（检出早于钉版：git checkout -- ${r.path} 即可）` : '';
    // 下面 `r.rule ? … : ''` 的"无 rule"那一支**刻意留着**：eolPinVerdict 给 pinned 行一定会带 rule，
    // 所以它跑不到（覆盖率表里就是那 1 个未覆盖分支）；留着只是为了"输入真缺了也不抛错、只是不写出处"。
    passIt(`${r.path} · ${r.binary ? '二进制' : '文本'} · ${r.via}${r.rule ? `（${r.rule.file}:${r.rule.line}）` : ''}${note}`);
  }
  if (binaryOnly.length) {
    passIt(`二进制内容 ${binaryOnly.length} 条 · 无需 .gitattributes 规则（git 不会对二进制做行尾转换；判据：前 8000 字节内有 NUL）`);
    for (const line of groupPathsByDir(binaryOnly.map((r) => r.path))) log(line);
  }
  for (const r of missing) log(`  - ${r.path} · 跳过行尾判定：${r.detail}`);
  const failed = byStatus('fail');
  for (const r of failed) {
    if (r.kind === 'attr-error') failIt(r.path, `行尾钉版判定失败：${r.error}`);
    else failIt(r.path, eolPinFailMessage(r));
  }
  if (!failed.length) {
    passIt(`行尾钉版覆盖：直接钉版 ${pinned.length} 条、二进制内容 ${binaryOnly.length} 条${missing.length ? `、跳过（文件缺失）${missing.length} 条` : ''} —— 0 条存在行尾转换风险（干净检出与主仓库同结论）`);
  }
  log('  · 已知边界（别当成已覆盖）：路径集合只含品牌 manifest / MAPPING / src/static.js CSP 白名单命中的页面；'
    + 'test/sw-shell.test.js 的 SHELL_LEDGER 钉的是**清单文本**指纹而非文件字节，故不在内；'
    + '.git/info/attributes 与 core.attributesFile 不读取；[attr] 宏按文件预扫描展开；C 风格引号模式不支持。');
  return { rows, failed };
}

module.exports = {
  GITATTRIBUTES,
  BYTE_REWRITING_ATTRS,
  BUILTIN_MACROS,
  looksBinary,
  countCr,
  globToRegExp,
  parseAttrTokens,
  parseGitAttributesLine,
  parseMacroDefinition,
  expandMacroAttrs,
  matchAttributeGlob,
  attributePatternMatches,
  resolveAttributes,
  attrState,
  describeAttributeLookup,
  eolPinVerdict,
  eolPinFailMessage,
  listWebHtml,
  cspHash,
  collectCspPinnedPages,
  collectByteHashedPaths,
  groupPathsByDir,
  checkEolPinning,
};
