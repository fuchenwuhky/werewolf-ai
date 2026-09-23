#!/usr/bin/env node
/**
 * card-skin-manifest.js — 角色卡牌皮肤素材的"源 → 生产"逐字节清单与核验（零依赖，node 直接跑）
 *
 * 为什么必须是**字节**清单而不是"复制过去了"：
 *   1. SKIN-01 的交付判据是"源设计与生产副本**逐字节一致**"，而设计源 `design/card-frames/v3/assets/`
 *      里同时住着两类极易被搞混的小框：
 *        · `assets/compact-<theme>.svg`  = 当前定稿的 **R2 精雕薄框**，每份 5,922 字节；
 *        · `archive/compact-v1/compact-<theme>.svg` = 第一版小框快照（2,681～2,690 字节），**不部署**。
 *      两者同名同主题，只差一个目录。拿错目录不会报错，只会让 52px 常驻牌回到素色薄边 ——
 *      这种静默降级正是本清单要挡住的（所以本文件把归档哈希也一并算出来对照打印）。
 *   2. 这批素材里有一张 1.94MiB 的透明 PNG（`reliquary-metal.png`）。透明 PNG 一旦被"顺手重压"
 *      或过了一遍画图工具，字节和哈希都会变，而肉眼看大卡几乎看不出差别 —— 只能靠哈希钉。
 *   3. 与 `scripts/check-brand-assets.js` 同一套做法：**实算** SHA-256，不比对文档里手抄的字符串；
 *      文档给的 PNG 哈希在本文件里是**独立常量**，两条路各自算出来再互相印证。
 *
 * 行尾的坑（本仓库 2026-09-21 踩过一次）：SVG 是文本，Windows 上 `core.autocrlf=true` 的全新检出
 * 会把 LF 变成 CRLF，于是"字节哈希路径"在主仓库绿、干净 clone 红。本项目既有的解法是在
 * `.gitattributes` 里逐条钉 `text eol=lf`（判定逻辑复用 `scripts/brand-eol-pin-lib.js`）。新增的这 16 份
 * SVG **目前还没有钉版**，所以本文件做三件事：
 *   · 硬失败：工作区里 **源文件与生产副本必须逐字节相等**（这条与行尾配置无关，两边一起被转换）；
 *   · 硬失败：内容哈希（LF 归一化后）必须等于台账；
 *   · 显式警告：逐条列出尚未钉版的文本路径，并给出可直接粘贴进 `.gitattributes` 的那**一行**修复；
 *     此时如果"原始字节哈希"与台账不符、但"LF 归一化哈希"相符，判定为**纯行尾差异**并只告警，
 *     不误报成素材被改（台账里同时存 raw 与 lf 两个哈希就是为了能区分这两种情况）。
 *   `.gitattributes` 不在本工作包（SKIN-00/01/02）允许改动的文件范围内，故这里只告警 + 给出修复行。
 *
 * 用法：
 *   node scripts/card-skin-manifest.js            核验（默认；退出码 0/1）
 *   node scripts/card-skin-manifest.js --sync     从设计源原样复制到生产目录，并重写台账，再核验
 *   node scripts/card-skin-manifest.js --write    只按设计源重算并重写台账（不复制）
 *   node scripts/card-skin-manifest.js --quiet    只打印失败项与汇总
 *
 * 不启动服务、不写用户数据、不碰 saves/ profiles/ config.json。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SOURCE_REL = 'design/card-frames/v3/assets';
const PROD_REL = 'web/assets/card-frames/v3';
const LEDGER_REL = 'scripts/card-skin-assets.json';
const ARCHIVE_REL = 'design/card-frames/v3/archive/compact-v1';

/** 主题名（与设计包 README 的主题映射表一致；neutral 是所有不可见身份的统一牌背） */
const THEMES = ['wolf', 'oracle', 'village', 'fate', 'neutral'];

/**
 * 生产素材清单：**恰好 17 个文件**，顺序即台账顺序（改顺序会让台账内容变化，属故意）。
 * 命名规则是死的，直接由 THEMES 派生 —— 手抄一遍文件名只会多一处漂移点。
 */
const ASSET_NAMES = [
  ...THEMES.map((t) => `frame-${t}.svg`),
  ...THEMES.map((t) => `accent-${t}.svg`),
  ...THEMES.map((t) => `compact-${t}.svg`),
  'card-back-field.svg',
  'reliquary-metal.png',
];

/**
 * 文档（施工说明 §2 / 设计包 README §1）里写的数字。它们在这里是**对照值**，不是真值来源：
 * 真值来自每次运行对磁盘字节的实算，两边不一致就报错（"实算哈希，不要只比文档里的字符串"）。
 */
const DOC = {
  pngBytes: 2033769,
  pngSha256: 'a230c9ba214ee2dfb3f20ca2f089ee625be6fb2d07ca1888205280914f0e4c4b',
  pngSize: [1024, 1536],
  compactBytes: 5922,
};

const ABS = (rel) => path.join(ROOT, rel);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** 行尾归一化哈希：latin1 往返保证非 ASCII 字节不被二次编码，只把 CRLF 变成 LF */
const lfSha256 = (buf) => sha256(Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'));
const isBinaryBuf = (buf) => buf.includes(0);

/** PNG 的 IHDR：签名 8 字节 + 长度 4 + 'IHDR' 4 + 宽 4 + 高 4（大端） */
function pngDims(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || !sig.every((b, i) => buf[i] === b)) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

function readBytes(abs) {
  try {
    return fs.readFileSync(abs);
  } catch (_) {
    return null;
  }
}

/** 收集生产目录里的实际条目（只比一层：素材是平铺的，出现子目录本身就是可疑信号） */
function prodDirEntries() {
  try {
    return fs.readdirSync(ABS(PROD_REL), { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
  } catch (_) {
    return null;
  }
}

// ------------------------------------------------------------------ 台账

function buildLedger() {
  const files = ASSET_NAMES.map((name) => {
    const buf = readBytes(path.join(ABS(SOURCE_REL), name));
    if (!buf) return { name, missing: true };
    const binary = isBinaryBuf(buf);
    const row = {
      name,
      bytes: buf.length,
      sha256: sha256(buf),
      lfSha256: binary ? null : lfSha256(buf),
      binary,
    };
    if (name === 'reliquary-metal.png') {
      const d = pngDims(buf);
      row.png = d ? { width: d[0], height: d[1] } : null;
    }
    return row;
  });
  return {
    note: '角色卡牌皮肤 V3 素材台账（源 design/card-frames/v3/assets → 生产 web/assets/card-frames/v3）。'
      + '由 node scripts/card-skin-manifest.js --sync 生成；sha256 为原始字节，lfSha256 为 CRLF→LF 归一化后的内容哈希（二进制为 null）。',
    source: SOURCE_REL,
    production: PROD_REL,
    archive: ARCHIVE_REL,
    fileCount: ASSET_NAMES.length,
    files,
  };
}

function writeLedger(quiet) {
  const ledger = buildLedger();
  const missing = ledger.files.filter((f) => f.missing).map((f) => f.name);
  if (missing.length) {
    console.error(`✗ 设计源缺少素材，无法生成台账：${missing.join('、')}`);
    process.exit(1);
  }
  fs.writeFileSync(ABS(LEDGER_REL), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  if (!quiet) console.log(`· 已重写台账 ${LEDGER_REL}（${ledger.files.length} 条）`);
  return ledger;
}

function loadLedger() {
  const raw = readBytes(ABS(LEDGER_REL));
  if (!raw) return null;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return { parseError: e.message };
  }
}

// ------------------------------------------------------------------ 复制

function syncFromSource(quiet) {
  fs.mkdirSync(ABS(PROD_REL), { recursive: true });
  for (const name of ASSET_NAMES) {
    const buf = readBytes(path.join(ABS(SOURCE_REL), name));
    if (!buf) {
      console.error(`✗ 设计源缺少 ${SOURCE_REL}/${name}`);
      process.exit(1);
    }
    // 原样字节写入：不做任何转码/重压/格式化（透明 PNG 尤其不能过图像工具）
    fs.writeFileSync(path.join(ABS(PROD_REL), name), buf);
  }
  if (!quiet) console.log(`· 已从 ${SOURCE_REL} 原样复制 ${ASSET_NAMES.length} 个文件到 ${PROD_REL}`);
}

// ------------------------------------------------------------------ 行尾钉版判定

/** 复用仓库既有的判定（.gitattributes 的匹配语义很绕，不在这里重写第二套） */
function eolPinOf(rel) {
  try {
    const lib = require('./brand-eol-pin-lib.js');
    const buf = readBytes(ABS(rel));
    if (!buf) return { status: 'missing' };
    return lib.eolPinVerdict(ROOT, rel, ['card-skin-manifest']);
  } catch (e) {
    return { status: 'unknown', error: e.message };
  }
}

// ------------------------------------------------------------------ 核验

function verify(opts) {
  const quiet = !!(opts && opts.quiet);
  const failures = [];
  const warnings = [];
  const rows = [];

  const ledger = loadLedger();
  if (!ledger) {
    failures.push(`台账缺失：${LEDGER_REL}（先跑 node scripts/card-skin-manifest.js --sync）`);
    return { failures, warnings, rows };
  }
  if (ledger.parseError) {
    failures.push(`台账不是合法 JSON：${ledger.parseError}`);
    return { failures, warnings, rows };
  }
  // 台账自身的完整性：条目集合必须与清单完全一致（多一个少一个都是漏发布/多发布）
  const ledgerNames = (ledger.files || []).map((f) => f.name);
  if (ledgerNames.length !== ASSET_NAMES.length || ASSET_NAMES.some((n) => !ledgerNames.includes(n))) {
    failures.push(`台账条目与清单不一致：台账 ${ledgerNames.length} 条 / 清单 ${ASSET_NAMES.length} 条`);
  }
  const byName = new Map((ledger.files || []).map((f) => [f.name, f]));

  // 生产目录里不得有清单之外的东西（archive/、预览截图、compact-study.*、preview.* 一律禁止）
  const entries = prodDirEntries();
  if (!entries) {
    failures.push(`生产素材目录不存在：${PROD_REL}`);
  } else {
    const extra = entries.filter((e) => !ASSET_NAMES.includes(e.name)).map((e) => e.name + (e.dir ? '/' : ''));
    const absent = ASSET_NAMES.filter((n) => !entries.some((e) => e.name === n && !e.dir));
    if (extra.length) failures.push(`生产目录出现清单外文件（设计归档/预览件不得发布）：${extra.join('、')}`);
    if (absent.length) failures.push(`生产目录缺少素材：${absent.join('、')}`);
  }

  // 归档哈希：只用于证明"生产里的 R2 不是旧小框"，不参与生产判定
  const archiveHashes = new Map();
  for (const name of fs.existsSync(ABS(ARCHIVE_REL)) ? fs.readdirSync(ABS(ARCHIVE_REL)) : []) {
    const buf = readBytes(path.join(ABS(ARCHIVE_REL), name));
    if (buf) archiveHashes.set(name, { bytes: buf.length, sha256: sha256(buf) });
  }

  const unpinned = [];
  for (const name of ASSET_NAMES) {
    const row = { name, bad: [], notes: [], ok: false };
    const srcRel = `${SOURCE_REL}/${name}`;
    const prodRel = `${PROD_REL}/${name}`;
    row.source = srcRel;
    row.production = prodRel;
    const bad = (msg) => {
      row.bad.push(msg);
      failures.push(msg);
    };
    const srcBuf = readBytes(ABS(srcRel));
    const prodBuf = readBytes(ABS(prodRel));
    if (!srcBuf) {
      bad(`设计源缺少 ${srcRel}`);
      rows.push(row);
      continue;
    }
    if (!prodBuf) {
      bad(`生产副本缺少 ${prodRel}`);
      rows.push(row);
      continue;
    }
    row.bytes = prodBuf.length;
    row.srcBytes = srcBuf.length;
    row.sha256 = sha256(prodBuf);

    // ① 工作区逐字节一致（与行尾配置无关：两边来自同一次检出，会被同等转换）
    if (!srcBuf.equals(prodBuf)) {
      bad(
        `${prodRel} 与源 ${srcRel} **不是逐字节一致**`
          + `（源 ${srcBuf.length}B / 生产 ${prodBuf.length}B，sha256 源 ${sha256(srcBuf).slice(0, 16)}… / 生产 ${row.sha256.slice(0, 16)}…）；`
          + '请用 --sync 原样重拷，不要重压透明 PNG 或格式化 SVG',
      );
      row.notes.push('源/生产字节不一致');
    }

    // ② 哈希与台账（原始字节；文本再比 LF 归一化，用来区分"行尾转换"与"内容被改"）
    const led = byName.get(name);
    if (!led || led.missing) {
      bad(`台账没有 ${name} 的条目`);
    } else {
      if (led.bytes !== prodBuf.length) bad(`${prodRel} 字节数 ${prodBuf.length} ≠ 台账 ${led.bytes}`);
      if (led.sha256 !== row.sha256) {
        const binary = isBinaryBuf(prodBuf);
        const normalized = binary ? null : lfSha256(prodBuf);
        if (!binary && led.lfSha256 && normalized === led.lfSha256) {
          row.notes.push('行尾差异（内容一致）');
          warnings.push(`${prodRel} 原始字节哈希与台账不符，但 LF 归一化哈希一致 ⇒ 只是行尾被转换（本机 core.autocrlf 检出）`);
        } else {
          bad(`${prodRel} 的 SHA-256 与台账不符（${row.sha256.slice(0, 16)}… ≠ ${String(led.sha256).slice(0, 16)}…）`);
        }
      }
    }

    // ③ 文本路径的行尾钉版：未钉版 ⇒ 干净 clone 上哈希会漂（本工作包不改 .gitattributes，只告警）
    if (!isBinaryBuf(prodBuf)) {
      const pin = eolPinOf(prodRel);
      if (pin.status === 'fail' || pin.status === 'unknown') unpinned.push(prodRel);
      row.pin = pin.status;
    }

    // ④ PNG：尺寸与文档哈希（文档值是独立常量，实算后交叉印证）
    if (name === 'reliquary-metal.png') {
      const dims = pngDims(prodBuf);
      row.png = dims ? `${dims[0]}×${dims[1]}` : '非 PNG';
      if (!dims) bad(`${prodRel} 不是合法 PNG（IHDR 解析失败）`);
      else if (dims[0] !== DOC.pngSize[0] || dims[1] !== DOC.pngSize[1]) {
        bad(`${prodRel} 尺寸 ${dims[0]}×${dims[1]} ≠ 文档 ${DOC.pngSize.join('×')}`);
      }
      if (row.sha256 !== DOC.pngSha256) bad(`${prodRel} 的实算 SHA-256 与施工说明记录的 ${DOC.pngSha256.slice(0, 16)}… 不符`);
      if (prodBuf.length !== DOC.pngBytes) bad(`${prodRel} 字节数 ${prodBuf.length} ≠ 文档 ${DOC.pngBytes}`);
      row.notes.push(`文档哈希一致 ${DOC.pngSha256.slice(0, 12)}…`);
    }

    // ⑤ 小卡：必须是 R2 精雕薄框（5,922B/份），且与 archive/compact-v1 的同名件不同
    if (name.startsWith('compact-')) {
      const archiveSame = archiveHashes.get(name);
      row.archive = archiveSame ? `${archiveSame.bytes}B ${archiveSame.sha256.slice(0, 12)}…` : '（归档无同名件）';
      if (prodBuf.length !== DOC.compactBytes) {
        bad(`${prodRel} 是 ${prodBuf.length}B，R2 精雕薄框应为 ${DOC.compactBytes}B —— 疑似拿成了 archive/compact-v1 的旧小框`);
      }
      if (archiveSame && archiveSame.sha256 === row.sha256) {
        bad(`${prodRel} 与 ${ARCHIVE_REL}/${name} 字节完全相同 —— 发布了旧归档小框`);
      }
    }

    row.ok = row.bad.length === 0;
    rows.push(row);
  }

  if (unpinned.length) {
    warnings.push(
      `以下 ${unpinned.length} 条文本路径尚未在 .gitattributes 里钉行尾（Windows 全新检出会把 LF 转成 CRLF ⇒ 原始字节哈希会漂；`
        + '内容判定已用 LF 归一化哈希兜住）。修复（每行一条，交给主控在合并时追加，本工作包不改 .gitattributes）：\n    '
        + unpinned.map((p) => `${p} text eol=lf`).join('\n    '),
    );
  }

  if (!quiet) {
    console.log(`\n== 角色卡牌素材：源 → 生产逐字节核验（${ASSET_NAMES.length} 个文件）==`);
    for (const r of rows) {
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.production}`);
      console.log(`      ${r.bytes === undefined ? '—' : r.bytes} B  sha256 ${String(r.sha256 || '').slice(0, 16)}…  源 ${r.source}`);
      if (r.png) console.log(`      PNG ${r.png}`);
      if (r.archive) console.log(`      旧归档同名件 ${r.archive}（必须不同）`);
      for (const n of r.notes) console.log(`      · ${n}`);
      for (const n of r.bad) console.log(`      ✗ ${n}`);
    }
  }

  return { failures, warnings, rows, unpinned };
}

// ------------------------------------------------------------------ CLI

function main() {
  const argv = process.argv.slice(2);
  const quiet = argv.includes('--quiet');
  if (argv.includes('--sync')) {
    syncFromSource(quiet);
    writeLedger(quiet);
  } else if (argv.includes('--write')) {
    writeLedger(quiet);
  }
  const { failures, warnings, rows } = verify({ quiet });
  if (!quiet) {
    const okCount = rows.filter((r) => r.ok).length;
    console.log(`\n  通过 ${okCount}/${ASSET_NAMES.length}`);
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }
  if (failures.length) {
    console.error(`\n✗ 素材核验失败 ${failures.length} 项：`);
    for (const f of failures) console.error(`  · ${f}`);
    process.exit(1);
  }
  console.log(`\n✓ 素材核验通过：${ASSET_NAMES.length} 个文件的源/生产/台账三方哈希一致（R2 小框未被 archive/compact-v1 替换）`);
}

if (require.main === module) main();

module.exports = {
  ASSET_NAMES, THEMES, DOC, SOURCE_REL, PROD_REL, LEDGER_REL, ARCHIVE_REL,
  sha256, lfSha256, pngDims, buildLedger, verify, syncFromSource, writeLedger, eolPinOf,
};
