#!/usr/bin/env node
/**
 * gen-icon.js — 生成哥特血月狼头启动图标（零依赖，纯像素数学 + zlib PNG 编码）
 * 用法：node scripts/gen-icon.js
 * 输出：app/android res 下各 mipmap 目录的 ic_launcher / ic_launcher_round
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const GOLD = [201, 162, 39], GOLD_HI = [240, 223, 168], BLOOD = [138, 28, 43], BLOOD_HI = [179, 46, 62], DARK = [11, 10, 16];

/** 主图案渲染：size 画布边长，返回 RGBA buffer */
function render(size) {
  const buf = Buffer.alloc(size * size * 4, 0);
  const cx = size / 2, cy = size / 2, R = size * 0.40, ring = size * 0.035;
  const put = (x, y, c, a = 255) => {
    const i = (y * size + x) * 4;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = a;
  };
  // 超采样圆判断
  const inMoon = (x, y) => ((x - cx) ** 2 + (y - cy) ** 2) <= R * R;
  const inRing = (x, y) => {
    const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
    return Math.abs(d - (R + ring * 0.9)) <= ring * 0.55;
  };
  // 狼头多边形（比例坐标，0..1）
  const P = [[.375, .33], [.352, .21], [.42, .285], [.5, .272], [.58, .285], [.648, .21], [.625, .33],
    [.68, .47], [.655, .57], [.575, .635], [.5, .73], [.425, .635], [.345, .57], [.32, .47]];
  const inWolf = (x, y) => {
    let inside = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const xi = P[i][0] * size, yi = P[i][1] * size, xj = P[j][0] * size, yj = P[j][1] * size;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  // 眼睛（金色斜三角）
  const inEye = (x, y) => {
    const ex = x - cx, ey = y - size * 0.44;
    if (Math.abs(ex) > size * 0.09 || Math.abs(ey) > size * 0.028) return false;
    return Math.abs(ey) < size * 0.028 - Math.abs(ex) * 0.18 + size * 0.004;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inRing(x, y)) { // 镀金环：上亮下暗
        const t = (y - (cy - R)) / (2 * R);
        const c = GOLD_HI.map((v, i) => Math.round(v * (1 - t) + GOLD[i] * t));
        put(x, y, c);
      } else if (inMoon(x, y)) {
        if (inWolf(x, y)) put(x, y, DARK);          // 狼身剪影
        else if (inEye(x, y)) put(x, y, GOLD_HI);   // 狼眼
        else {                                       // 血月：左上亮
          const dx = (x - cx) / R, dy = (y - cy) / R;
          const light = Math.max(0, 0.5 - (dx * 0.35 + dy * 0.45));
          const c = BLOOD.map((v, i) => Math.min(255, Math.round(v + (BLOOD_HI[i] - v) * light * 2)));
          put(x, y, c);
        }
      } else {
        put(x, y, DARK); // 黑底
      }
    }
  }
  return buf;
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const RES = path.join(__dirname, '..', 'app', 'android', 'app', 'src', 'main', 'res');
const SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [dpi, px] of Object.entries(SIZES)) {
  const dir = path.join(RES, `mipmap-${dpi}`);
  if (!fs.existsSync(dir)) continue;
  const png = encodePNG(render(px), px);
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), png);
  fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), png);
  console.log(`✓ mipmap-${dpi}: ${px}x${px}`);
}
console.log('✓ 哥特血月狼头图标已写入');
