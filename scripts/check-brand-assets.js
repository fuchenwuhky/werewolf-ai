#!/usr/bin/env node
/**
 * check-brand-assets.js — 生产品牌资产的哈希门禁（零依赖，node 直接跑）
 *
 * 校验三件事（对应 BRAND-02 / BRAND-03）：
 *   1. v2 源完整性：门禁消费的 design/brand/v2/export/ 资产逐个算 SHA-256，
 *      与交付时固化的 export/manifest.json 交叉核对；PNG 读 IHDR 核对尺寸；
 *      app.ico 解析目录头，帧尺寸必须覆盖 16/32/48/256。
 *   2. 生产资产一致性：映射表（scripts/brand-v2-lib.js 的 MAPPING）里每个生产文件——
 *      直接映射的与 v2 源哈希逐字节比对；派生的（round 圆形裁切 / splash 启动页合成）
 *      用同一份派生代码确定性重算后比对；Android 自适应 XML 的前景/背景引用与背景色
 *      #080D17 一并核对。
 *   3. 引用面核对：web/manifest.webmanifest、web/index.html、web/m/index.html 实际引用的
 *      图标必须都在映射表内且通过校验（声明尺寸 == PNG 实际尺寸）；Electron 的
 *      desktop/package.json win.icon 与 desktop/main.js 运行时窗口图标指向的文件
 *      也必须与 v2 哈希一致。
 *   4. 行尾钉版覆盖（**元断言**）：上面三节按**字节**比对的每一条路径，都必须免受 git 的
 *      行尾转换（.gitattributes 钉 `text eol=lf`，或 `-text`/`binary` 且内容确为二进制）——
 *      详见下方第 4 节的注释（2026-09-21 的真实缺陷：漏钉 ⇒ 主仓库绿、干净 clone 红）。
 *
 * 任何一项不一致：打印差异清单并以退出码 1 结束。
 *
 * 用法：node scripts/check-brand-assets.js   （npm run brand:check）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const brand = require('./brand-v2-lib.js');

const ROOT = brand.ROOT;

const failures = [];
let passed = 0;

function pass(line) {
  passed++;
  console.log(`  ✓ ${line}`);
}

function fail(prod, why) {
  failures.push({ prod, why });
  console.log(`  ✖ ${prod}\n      ${why}`);
}

function readRepo(rel) {
  return fs.readFileSync(brand.resolve(rel));
}

// ---------- 1. v2 源完整性 ----------
function checkV2Sources() {
  console.log('\n== v2 母版资产完整性（design/brand/v2/export） ==');
  const manifestAbs = brand.v2Path('manifest.json');
  if (!fs.existsSync(manifestAbs)) {
    fail('design/brand/v2/export/manifest.json', '缺少交付 manifest.json，无法交叉核对');
    return;
  }
  const delivered = JSON.parse(fs.readFileSync(manifestAbs, 'utf8'));
  const byName = new Map(delivered.files.map((f) => [f.name, f]));

  for (const name of brand.V2_ASSETS_USED) {
    const abs = brand.v2Path(name);
    const rel = `${brand.V2_EXPORT_DIR}/${name}`;
    if (!fs.existsSync(abs)) {
      fail(rel, 'v2 源资产缺失');
      continue;
    }
    const buf = fs.readFileSync(abs);
    const hash = brand.sha256(buf);
    const entry = byName.get(name);
    if (!entry) {
      fail(rel, `交付 manifest.json 未登记该文件（sha256 ${hash.slice(0, 16)}…），无法交叉核对`);
      continue;
    }
    if (entry.sha256 !== hash) {
      fail(rel, `SHA-256 与交付 manifest.json 不符：实际 ${hash} ≠ 固化 ${entry.sha256}（v2 包被改动？）`);
      continue;
    }
    if (name.endsWith('.png')) {
      const size = brand.pngSize(buf);
      if (entry.width && (size.width !== entry.width || size.height !== entry.height)) {
        fail(rel, `尺寸与交付 manifest.json 不符：实际 ${size.width}x${size.height} ≠ ${entry.width}x${entry.height}`);
        continue;
      }
      pass(`${rel} · ${size.width}x${size.height} · sha256 ${hash.slice(0, 16)}…（与交付 manifest 一致）`);
    } else if (name.endsWith('.ico')) {
      const ico = brand.parseIco(buf);
      const sizes = ico.frames.map((f) => f.width);
      const need = [16, 32, 48, 256];
      const missing = need.filter((s) => !sizes.includes(s));
      if (missing.length) {
        fail(rel, `ICO 缺少必需帧尺寸：${missing.join('/')}（实际 ${sizes.join('/')}）`);
        continue;
      }
      const badBpp = ico.frames.filter((f) => f.bpp !== 32);
      if (badBpp.length) {
        fail(rel, `ICO 存在非 32bpp 帧：${badBpp.map((f) => `${f.width}x${f.height}@${f.bpp}`).join(', ')}`);
        continue;
      }
      pass(`${rel} · ${ico.count} 帧 ${sizes.join('/')} 全 32bpp · sha256 ${hash.slice(0, 16)}…（与交付 manifest 一致）`);
    } else {
      pass(`${rel} · sha256 ${hash.slice(0, 16)}…（与交付 manifest 一致）`);
    }
  }
}

// ---------- 2. 生产资产一致性 ----------
function expectedBytes(entry) {
  if (entry.kind === 'svg-master') return fs.readFileSync(brand.resolve(brand.V2_MASTER_EMBLEM)); // svg-master 无 v2/export 对应物，必须在读 v2Buf 之前短路
  const v2Buf = readRepo(`${brand.V2_EXPORT_DIR}/${entry.v2}`);
  if (entry.kind === 'png-copy' || entry.kind === 'svg-copy' || entry.kind === 'ico-copy') return v2Buf;
  if (entry.kind === 'round') return brand.deriveRoundIcon(v2Buf);
  if (entry.kind === 'splash') return brand.deriveSplash(v2Buf, entry.w, entry.h);
  return null;
}

function checkProductionAssets() {
  console.log('\n== 生产资产哈希门禁（MAPPING 全量） ==');
  for (const entry of brand.MAPPING) {
    if (entry.kind === 'color') {
      const abs = brand.resolve(entry.prod);
      if (!fs.existsSync(abs)) {
        fail(entry.prod, '文件缺失');
        continue;
      }
      const xml = fs.readFileSync(abs, 'utf8');
      const m = xml.match(/name="ic_launcher_background"\s*>\s*#?([0-9a-fA-F]+)\s*</);
      if (!m || m[1].toUpperCase() !== entry.value.slice(1)) {
        fail(entry.prod, `自适应图标背景色应为 ${entry.value}，实际 ${m ? `#${m[1]}` : '未找到 ic_launcher_background 颜色项'}`);
        continue;
      }
      pass(`${entry.prod} · 背景色 ${entry.value.toUpperCase()}`);
      continue;
    }
    if (entry.kind === 'adaptive-xml') {
      const abs = brand.resolve(entry.prod);
      if (!fs.existsSync(abs)) {
        fail(entry.prod, '文件缺失');
        continue;
      }
      const xml = fs.readFileSync(abs, 'utf8');
      const okFg = xml.includes('@mipmap/ic_launcher_foreground');
      const okBg = xml.includes('@color/ic_launcher_background');
      if (!okFg || !okBg) {
        fail(entry.prod, `自适应图标引用不符：前景 @mipmap/ic_launcher_foreground ${okFg ? '在' : '缺'}，背景 @color/ic_launcher_background ${okBg ? '在' : '缺'}`);
        continue;
      }
      pass(`${entry.prod} · 前景→@mipmap/ic_launcher_foreground，背景→@color`);
      continue;
    }
    const abs = brand.resolve(entry.prod);
    if (!fs.existsSync(abs)) {
      fail(entry.prod, '生产文件缺失（先跑 npm run brand:apply）');
      continue;
    }
    const actual = fs.readFileSync(abs);
    let expected;
    try {
      expected = expectedBytes(entry);
    } catch (e) {
      fail(entry.prod, `v2 源派生失败：${e.message}`);
      continue;
    }
    const actualHash = brand.sha256(actual);
    if (actualHash !== brand.sha256(expected)) {
      const direct = entry.kind === 'png-copy' || entry.kind === 'svg-copy' || entry.kind === 'ico-copy';
      fail(entry.prod, `SHA-256 与 v2（${direct ? `直拷 ${entry.v2}` : `派生自 ${entry.v2}`}）不符：实际 ${actualHash}`);
      continue;
    }
    if (entry.w && !entry.prod.endsWith('.svg')) {
      const size = brand.pngSize(actual);
      if (size.width !== entry.w || size.height !== entry.h) {
        fail(entry.prod, `实际尺寸 ${size.width}x${size.height} ≠ 声明 ${entry.w}x${entry.h}`);
        continue;
      }
    }
    if (entry.kind === 'ico-copy') {
      const bad = checkIcoFrames(entry.prod, actual);
      if (bad) continue;
    }
    const how = entry.kind === 'png-copy' || entry.kind === 'svg-copy' || entry.kind === 'ico-copy'
      ? `← v2/${entry.v2}`
      : `派生 ← v2/${entry.v2}`;
    pass(`${entry.prod} · ${entry.w ? `${entry.w}x${entry.h} · ` : ''}${actual.length}B · ${how} · ${actualHash.slice(0, 16)}…`);
  }
}

/** ICO 帧校验（FIN-09）：尺寸档覆盖 16/32/48/256、全 32bpp。失败返回 true（已记入 failures）。 */
function checkIcoFrames(prod, buf) {
  let ico;
  try {
    ico = brand.parseIco(buf);
  } catch (e) {
    fail(prod, `ICO 解析失败：${e.message}`);
    return true;
  }
  const sizes = ico.frames.map((f) => f.width);
  const missing = [16, 32, 48, 256].filter((s) => !sizes.includes(s));
  if (missing.length) {
    fail(prod, `ICO 缺少必需帧尺寸：${missing.join('/')}（实际 ${sizes.join('/')}）`);
    return true;
  }
  const badBpp = ico.frames.filter((f) => f.bpp !== 32);
  if (badBpp.length) {
    fail(prod, `ICO 存在非 32bpp 帧：${badBpp.map((f) => `${f.width}x${f.height}@${f.bpp}`).join(', ')}`);
    return true;
  }
  pass(`${prod} · ${ico.count} 帧 ${sizes.join('/')} 全 32bpp`);
  return false;
}

// ---------- 3. 引用面核对（web manifest / HTML / Electron） ----------
function collectWebReferences() {
  const refs = [];
  const addRef = (from, href) => {
    if (!href) return;
    const clean = href.split('?')[0].split('#')[0];
    const rel = path.posix.normalize(clean.startsWith('/') ? path.posix.join('web', clean) : path.posix.join(from, clean));
    refs.push(rel.split(path.sep).join('/'));
  };
  const manifestAbs = brand.resolve('web/manifest.webmanifest');
  if (!fs.existsSync(manifestAbs)) {
    fail('web/manifest.webmanifest', '文件缺失');
    return refs;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestAbs, 'utf8'));
  for (const icon of manifest.icons || []) addRef('web', icon.src);
  for (const html of ['web/index.html', 'web/m/index.html']) {
    const text = fs.readFileSync(brand.resolve(html), 'utf8');
    const tags = text.match(/<link\b[^>]*>/gi) || [];
    for (const tag of tags) {
      const rel = (tag.match(/rel\s*=\s*"([^"]*)"/i) || [])[1] || '';
      if (!/\b(icon|apple-touch-icon)\b/i.test(rel)) continue;
      const href = (tag.match(/href\s*=\s*"([^"]*)"/i) || [])[1];
      addRef(path.posix.dirname(html), href);
    }
    // FIN-08：页面可见品牌走 <img src>（首页大标识/局中顶栏小狼冠）——同样纳入引用面核对，
    // 防止"换了文件名/删了页面"后生产品牌资产变孤儿（矢量 svg 归这里管；位图由打包哈希校验覆盖）
    const imgs = text.match(/<img\b[^>]*>/gi) || [];
    for (const tag of imgs) {
      const src = (tag.match(/src\s*=\s*"([^"]*)"/i) || [])[1];
      if (!src || /^(https?:)?\/\//i.test(src) || /^(data|blob):/i.test(src)) continue;
      if (!/\.svg$/i.test(src)) continue;
      addRef(path.posix.dirname(html), src);
    }
  }
  return [...new Set(refs)];
}

function checkWebReferences() {
  console.log('\n== 引用面核对（manifest.webmanifest / index.html / m/index.html） ==');
  const refs = collectWebReferences();
  const mappingProds = new Set(brand.MAPPING.map((m) => m.prod));
  const webProds = new Set(brand.MAPPING.filter((m) => m.prod.startsWith('web/')).map((m) => m.prod));
  for (const ref of refs) {
    if (!ref.startsWith('web/')) {
      fail(ref, '引用解析后不在 web/ 下，映射表未覆盖');
      continue;
    }
    if (!mappingProds.has(ref)) fail(ref, '被引用但不在品牌映射表内（换了文件名/新增引用？）');
    else pass(`${ref} · 被 manifest/HTML 引用且在映射表内`);
  }
  for (const prod of webProds) {
    if (!refs.includes(prod)) fail(prod, '映射表内的 web 生产图标没有任何 manifest/HTML 引用（孤儿资产？）');
  }
}

function checkElectron() {
  console.log('\n== Electron（desktop/） ==');
  const pkgAbs = brand.resolve('desktop/package.json');
  if (!fs.existsSync(pkgAbs)) {
    console.log('  - desktop/package.json 不存在，跳过 Electron 检查');
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(pkgAbs, 'utf8'));
  const iconField = pkg.build && pkg.build.win && pkg.build.win.icon;
  if (!iconField) {
    fail('desktop/package.json', 'build.win.icon 未配置（exe/安装器将无自定义图标）');
  } else {
    const resolved = path.posix.normalize(path.posix.join('desktop', iconField.split(path.sep).join('/')));
    const entry = brand.MAPPING.find((m) => m.prod === resolved);
    if (!entry) {
      fail(`desktop/package.json build.win.icon → ${resolved}`, '指向的文件不在品牌映射表内');
    } else {
      const buf = readRepo(resolved);
      const v2Buf = readRepo(`${brand.V2_EXPORT_DIR}/${entry.v2}`);
      if (brand.sha256(buf) !== brand.sha256(v2Buf)) {
        fail(resolved, 'Electron builder 图标与 v2 不一致');
      } else if (resolved.endsWith('.ico')) {
        // FIN-09：EXE 图标源改为 v2 app.ico 的直拷（7 帧 16-256 全 32bpp），
        // electron-builder 26+ 用纯 JS resedit 写资源段，不再需要 winCodeSign 下载
        checkIcoFrames(resolved, buf);
      } else {
        const size = brand.pngSize(buf);
        pass(`desktop/package.json build.win.icon → ${resolved} · ${size.width}x${size.height} · 与 v2/${entry.v2} 一致`);
      }
    }
  }
  const mainAbs = brand.resolve('desktop/main.js');
  if (!fs.existsSync(mainAbs)) {
    console.log('  - desktop/main.js 不存在，跳过运行时窗口图标检查');
    return;
  }
  const text = fs.readFileSync(mainAbs, 'utf8');
  const names = [...new Set((text.match(/[\w-]+\.png|[\w-]+\.ico|[\w-]+\.svg/g) || []).map((s) => s.toLowerCase()))];
  for (const name of names) {
    const prod = `web/assets/${name}`;
    const entry = brand.MAPPING.find((m) => m.prod === prod);
    if (!entry) {
      fail(`desktop/main.js → ${prod}`, '运行时窗口图标引用了映射表之外的文件');
      continue;
    }
    const buf = readRepo(prod);
    const v2Buf = readRepo(`${brand.V2_EXPORT_DIR}/${entry.v2}`);
    if (brand.sha256(buf) !== brand.sha256(v2Buf)) fail(prod, 'Electron 运行时窗口图标与 v2 不一致');
    else pass(`desktop/main.js → ${prod} · 与 v2/${entry.v2} 一致`);
  }
  if (names.length) {
    const seFlags = `signAndEditExecutable=${JSON.stringify(pkg.build.win.signAndEditExecutable ?? null)}, signExecutable=${JSON.stringify(pkg.build.win.signExecutable ?? null)}`;
    console.log(`  - EXE 资源段写入状态：${seFlags}（signExecutable=false 只跳过代码签名，图标/版本资源仍由 electron-builder 内置 resedit 写入；包内实证由 npm run app:verify 的 DESKTOP 目标校验）`);
  }
}

// ---------- 4. 行尾钉版覆盖（元断言：字节哈希路径必须免受行尾转换） ----------
/**
 * ## 这条断言是怎么来的（真实缺陷，2026-09-21）
 * 下面三节全部按**字节**做 SHA-256 比对。当时 web/assets/icon.svg 就在比对范围里，
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
 * 未覆盖：C 风格引号模式（`"a b.txt"`）；模式里的 `\` 只按"反斜杠后一字面量"处理。
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
  let i = 0;
  while (i < line.length && !/\s/.test(line[i])) {
    if (line[i] === '\\' && i + 1 < line.length) { pattern += line[i + 1]; i += 2; continue; }
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
 *   · C 风格引号模式（`"a b.txt"`）与反斜杠转义的细节形态；
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
function collectByteHashedPaths(root = ROOT) {
  const out = new Map();
  const add = (rel, source) => {
    if (!out.has(rel)) out.set(rel, new Set());
    out.get(rel).add(source);
  };
  const manifestAbs = path.join(root, brand.V2_EXPORT_DIR, 'manifest.json');
  if (fs.existsSync(manifestAbs)) {
    let delivered = null;
    try { delivered = JSON.parse(fs.readFileSync(manifestAbs, 'utf8')); } catch { delivered = null; }
    if (delivered) {
      if (delivered.source) add(delivered.source, '品牌 manifest · sourceSha256');
      for (const f of delivered.files || []) add(`${brand.V2_EXPORT_DIR}/${f.name}`, '品牌 manifest · files[].sha256/bytes');
    }
  }
  for (const entry of brand.MAPPING) {
    if (entry.kind === 'color' || entry.kind === 'adaptive-xml') continue;
    add(entry.prod, `MAPPING · ${entry.kind}`);
    if (entry.v2) add(`${brand.V2_EXPORT_DIR}/${entry.v2}`, `MAPPING · ${entry.kind} ← v2 源`);
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
    groups.get(dir).push(p.slice(dir.length + 1));
  }
  return [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([dir, names]) => {
    const sorted = [...names].sort();
    const head = sorted.slice(0, maxNames).join(', ');
    const tail = sorted.length > maxNames ? `，…共 ${sorted.length} 个` : `（共 ${sorted.length} 个）`;
    return `      ${dir}/ ⇒ ${head}${tail}`;
  });
}

/** 第 4 节：逐条判定 + 失败即红（退出码由 failures 决定，绝不只打印告警） */
function checkEolPinning() {
  console.log('\n== 行尾钉版覆盖（字节哈希路径 ⇒ .gitattributes 必须 text eol=lf，或 -text/binary 且内容为二进制） ==');
  const pathMap = collectByteHashedPaths(ROOT);
  const rows = [...pathMap].map(([rel, sources]) => {
    try {
      return eolPinVerdict(ROOT, rel, sources);
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
  console.log(`  · 字节哈希路径 ${rows.length} 条（按来源去重：${[...via].map(([s, n]) => `${s} ${n} 条`).join('；')}）`);
  for (const r of pinned) {
    const note = r.cr > 0 ? `，但当前工作区有 ${r.cr} 个 CR（检出早于钉版：git checkout -- ${r.path} 即可）` : '';
    pass(`${r.path} · ${r.binary ? '二进制' : '文本'} · ${r.via}${r.rule ? `（${r.rule.file}:${r.rule.line}）` : ''}${note}`);
  }
  if (binaryOnly.length) {
    pass(`二进制内容 ${binaryOnly.length} 条 · 无需 .gitattributes 规则（git 不会对二进制做行尾转换；判据：前 8000 字节内有 NUL）`);
    for (const line of groupPathsByDir(binaryOnly.map((r) => r.path))) console.log(line);
  }
  for (const r of missing) console.log(`  - ${r.path} · 跳过行尾判定：${r.detail}`);
  for (const r of byStatus('fail')) {
    if (r.kind === 'attr-error') fail(r.path, `行尾钉版判定失败：${r.error}`);
    else fail(r.path, eolPinFailMessage(r));
  }
  if (!byStatus('fail').length) {
    pass(`行尾钉版覆盖：直接钉版 ${pinned.length} 条、二进制内容 ${binaryOnly.length} 条${missing.length ? `、跳过（文件缺失）${missing.length} 条` : ''} —— 0 条存在行尾转换风险（干净检出与主仓库同结论）`);
  }
  console.log('  · 已知边界（别当成已覆盖）：路径集合只含品牌 manifest / MAPPING / src/static.js CSP 白名单命中的页面；'
    + 'test/sw-shell.test.js 的 SHELL_LEDGER 钉的是**清单文本**指纹而非文件字节，故不在内；'
    + '.git/info/attributes 与 core.attributesFile 不读取；[attr] 宏按文件预扫描展开；C 风格引号模式不支持。');
}

// ---------- main ----------
function main() {
  console.log('brand:check — 生产品牌资产哈希门禁');
  checkV2Sources();
  checkProductionAssets();
  checkWebReferences();
  checkElectron();
  checkEolPinning();
  console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
  if (failures.length) {
    console.log('\n差异清单：');
    for (const f of failures) console.log(`  ✖ ${f.prod}\n      ${f.why}`);
    console.log('\n修复方式：node scripts/apply-brand-v2.js 重新接入 v2 资产（勿手工改图标）。');
    return 1;
  }
  console.log('brand:check 全部通过。');
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  main,
  expectedBytes,
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
