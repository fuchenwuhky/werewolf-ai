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
 *
 * 任何一项不一致：打印差异清单并以退出码 1 结束。
 *
 * 用法：node scripts/check-brand-assets.js   （npm run brand:check）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const brand = require('./brand-v2-lib.js');

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
  const v2Buf = readRepo(`${brand.V2_EXPORT_DIR}/${entry.v2}`);
  if (entry.kind === 'png-copy' || entry.kind === 'svg-copy') return v2Buf;
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
      fail(entry.prod, `SHA-256 与 v2（${entry.kind === 'png-copy' || entry.kind === 'svg-copy' ? `直拷 ${entry.v2}` : `派生自 ${entry.v2}`}）不符：实际 ${actualHash}`);
      continue;
    }
    if (entry.w && !entry.prod.endsWith('.svg')) {
      const size = brand.pngSize(actual);
      if (size.width !== entry.w || size.height !== entry.h) {
        fail(entry.prod, `实际尺寸 ${size.width}x${size.height} ≠ 声明 ${entry.w}x${entry.h}`);
        continue;
      }
    }
    const how = entry.kind === 'png-copy' || entry.kind === 'svg-copy' ? `← v2/${entry.v2}` : `派生 ← v2/${entry.v2}`;
    pass(`${entry.prod} · ${entry.w ? `${entry.w}x${entry.h} · ` : ''}${actual.length}B · ${how} · ${actualHash.slice(0, 16)}…`);
  }
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
  if (names.length) console.log(`  - 注意：build.win.signAndEditExecutable=${JSON.stringify(pkg.build.win.signAndEditExecutable ?? null)}，为 false 时 exe 资源段不会改写，窗口图标正常 ≠ exe 图标已写入（见 design/brand/v2/README.md 验收节）`);
}

// ---------- main ----------
function main() {
  console.log('brand:check — 生产品牌资产哈希门禁');
  checkV2Sources();
  checkProductionAssets();
  checkWebReferences();
  checkElectron();
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

module.exports = { main };
