/**
 * make-icons.js — 由 icon.svg 的设计生成 PNG 图标（零依赖，只用 node:zlib）
 *
 * 为什么必须要有 PNG：
 *   · Chromium/Android 的"可安装"判定要求清单里至少有 192×192 与 512×512 的 **PNG** 图标；
 *   · iOS 的 apple-touch-icon **不支持 SVG**，只给 SVG 会得到一张白图；
 *   · iOS 对透明背景处理不佳（会变白块），所以这里输出**不带 alpha 的 RGB**、满背景填充。
 *
 * 项目没有图片处理依赖，也不打算为了三张图标引入原生模块，
 * 所以这里手写最小的 PNG 编码器（zlib deflate + CRC32）与光栅化器（圆/描边圆/路径多边形 + 3×3 超采样）。
 * 设计值直接取自 web/assets/icon.svg，改设计时两边一起改。
 *
 * 用法：node scripts/make-icons.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGB（colorType 2，无 alpha）PNG 编码 */
function encodePng(width, height, rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor RGB
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 几何 ----------
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** 圆环（描边圆）：inner ≤ r ≤ outer */
const inRing = (x, y, cx, cy, rIn, rOut) => {
  const d = Math.hypot(x - cx, y - cy);
  return d >= rIn && d <= rOut;
};
const inCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) <= r;

/** 把 SVG 路径（仅 M/L/Q/Z，本项目图标用到的全部指令）展平成多边形 */
function flattenPath(d) {
  const tokens = d.match(/[MLQZ]|-?\d+(?:\.\d+)?/gi) || [];
  const polys = [];
  let cur = null;
  let i = 0;
  let x = 0, y = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M' || cmd === 'L') {
      x = num(); y = num();
      if (cmd === 'M') { cur = [[x, y]]; polys.push(cur); } else cur.push([x, y]);
    } else if (cmd === 'Q') {
      const cx = num(), cy = num(), ex = num(), ey = num();
      const x0 = x, y0 = y;
      for (let s = 1; s <= 16; s++) { // 展平成 16 段
        const t = s / 16;
        const mt = 1 - t;
        cur.push([mt * mt * x0 + 2 * mt * t * cx + t * t * ex, mt * mt * y0 + 2 * mt * t * cy + t * t * ey]);
      }
      x = ex; y = ey;
    } else if (cmd === 'Z') {
      // 闭合（光栅化按多边形处理，无需显式闭合点）
    }
  }
  return polys;
}

/** 射线法：点是否在多边形内 */
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- 设计（与 assets/icon.svg 一致） ----------
const WOLF_PATH = 'M160 150 L145 85 L215 135 L256 128 L297 135 L367 85 L352 150 Q380 210 360 260 Q340 310 295 340 L256 395 L217 340 Q172 310 152 260 Q132 210 160 150 Z';
const EYE_L = [[195, 235], [240, 250], [200, 262]];
const EYE_R = [[317, 235], [272, 250], [312, 262]];

/**
 * 画出图标。scale = 1 为满幅（用于普通图标）；maskable 用 0.8 把图形缩进安全区
 * （Android 的 adaptive icon 会按圆形/方形裁剪外圈，满幅设计会被切掉金环）。
 */
function render(size, scale = 1) {
  const S = 3; // 每轴 3 个采样 → 9 次超采样，边缘够平滑
  const px = Buffer.alloc(size * size * 3);
  const c = size / 2;
  const k = (size / 512) * scale; // SVG 坐标 → 像素坐标
  const map = (v) => c + (v - 256) * k;
  const bg = hex('#0b0a10');
  const outerRing = hex('#6b5416');
  const red = hex('#8a1c2b');
  const gold = hex('#c9a227');
  const dark = hex('#0b0a10');
  const eye = hex('#e2c979');
  const wolfPolys = flattenPath(WOLF_PATH).map((p) => p.map(([x, y]) => [map(x), map(y)]));
  const eyes = [EYE_L, EYE_R].map((p) => p.map(([x, y]) => [map(x), map(y)]));
  const rOut = 218 * k, rInner = 210 * k, rFill = 200 * k, rGoldIn = 195 * k, rGoldOut = 205 * k;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px0 = x + (sx + 0.5) / S;
          const py0 = y + (sy + 0.5) / S;
          let col = bg;
          if (inRing(px0, py0, c, c, rInner, rOut)) col = outerRing;
          if (inCircle(px0, py0, c, c, rFill)) col = red;
          if (inRing(px0, py0, c, c, rGoldIn, rGoldOut)) col = gold;
          if (wolfPolys.some((p) => inPoly(px0, py0, p))) col = dark;
          if (eyes.some((p) => inPoly(px0, py0, p))) col = eye;
          r += col[0]; g += col[1]; b += col[2];
        }
      }
      const n = S * S;
      const o = (y * size + x) * 3;
      px[o] = Math.round(r / n);
      px[o + 1] = Math.round(g / n);
      px[o + 2] = Math.round(b / n);
    }
  }
  return encodePng(size, size, px);
}

const OUT = path.join(__dirname, '..', 'web', 'assets');
const jobs = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['icon-maskable-512.png', 512, 0.8], // 缩进安全区，避免被 Android 裁掉外圈
  ['apple-touch-icon.png', 180, 1],    // iOS 主屏（不接受 SVG）
];

let total = 0;
for (const [name, size, scale] of jobs) {
  const buf = render(size, scale);
  fs.writeFileSync(path.join(OUT, name), buf);
  total += buf.length;
  console.log(`✓ ${name.padEnd(24)} ${size}×${size}  ${(buf.length / 1024).toFixed(1)} KB`);
}
console.log(`共 ${jobs.length} 个文件，${(total / 1024).toFixed(1)} KB，输出目录 web/assets/`);
