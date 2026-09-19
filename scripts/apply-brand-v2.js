#!/usr/bin/env node
/**
 * apply-brand-v2.js — 把 design/brand/v2 品牌母版接入生产资产（BRAND-02 / BRAND-03 施工执行器）
 *
 * 做什么（映射表唯一来源见 scripts/brand-v2-lib.js 的 MAPPING）：
 *   · 直接覆盖：web PWA 五件套（icon.svg / icon-192 / icon-512 / maskable-512 / apple-touch-icon）
 *               ← v2 export 同尺寸导出；
 *     Android legacy ic_launcher + adaptive foreground 各五档密度 ← v2 export 同尺寸导出；
 *   · 确定性派生（零依赖，见 brand-v2-lib.js）：
 *     Android ic_launcher_round ← 对应 legacy 圆形裁切；
 *     启动页 splash ×11 ← wolf-decal-1024 合成到 #080D17 实色底；
 *   · Android 自适应图标背景色 #FFFFFF → #080D17（v2 README 接入映射表指定）。
 *
 * 不做什么：不碰 web/*.js|html|css、src/、test/、docs/；不运行旧数学狼头生成器
 * （make-icons.js / gen-icon.js 是旧图标源，按 v2 README 禁止再用它们覆盖）。
 * 跑完请执行 `npm run brand:check` 做哈希门禁校验。
 *
 * 用法：node scripts/apply-brand-v2.js
 */
'use strict';
const fs = require('fs');
const brand = require('./brand-v2-lib.js');

function apply(entry) {
  if (entry.kind === 'png-copy' || entry.kind === 'svg-copy') {
    const src = fs.readFileSync(brand.v2Path(entry.v2));
    fs.writeFileSync(brand.resolve(entry.prod), src);
    return { bytes: src.length, detail: `← v2/${entry.v2}` };
  }
  if (entry.kind === 'round') {
    const src = fs.readFileSync(brand.v2Path(entry.v2));
    const out = brand.deriveRoundIcon(src);
    fs.writeFileSync(brand.resolve(entry.prod), out);
    return { bytes: out.length, detail: `← v2/${entry.v2} 圆形裁切派生` };
  }
  if (entry.kind === 'splash') {
    const src = fs.readFileSync(brand.v2Path(entry.v2));
    const out = brand.deriveSplash(src, entry.w, entry.h);
    fs.writeFileSync(brand.resolve(entry.prod), out);
    return { bytes: out.length, detail: `← v2/${entry.v2} 缩放合成 #080D17 派生` };
  }
  if (entry.kind === 'color') {
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${entry.value}</color>\n</resources>\n`;
    fs.writeFileSync(brand.resolve(entry.prod), xml);
    return { bytes: Buffer.byteLength(xml), detail: `背景色 → ${entry.value}` };
  }
  return null; // adaptive-xml：指向 @mipmap/@color 的引用文件，无需改动
}

function main() {
  const groups = [
    ['BRAND-02 · web PWA', brand.MAPPING.filter((m) => m.prod.startsWith('web/'))],
    ['BRAND-03 · Android 图标/启动页', brand.MAPPING.filter((m) => m.prod.startsWith('app/'))],
  ];
  let done = 0;
  for (const [label, entries] of groups) {
    console.log(`\n== ${label} ==`);
    for (const entry of entries) {
      const r = apply(entry);
      if (!r) {
        console.log(`  -  ${entry.prod}（引用文件，无需改动）`);
        continue;
      }
      done++;
      const extra = entry.w ? ` · ${entry.w}x${entry.h}` : '';
      console.log(`  ✓  ${entry.prod}${extra} · ${r.bytes}B · ${r.detail}`);
    }
  }
  console.log(`\n完成：覆盖/派生 ${done} 个生产资产。运行 npm run brand:check 校验哈希门禁。`);
}

if (require.main === module) {
  main();
  process.exit(0);
}

module.exports = { apply };
