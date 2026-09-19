/**
 * brand-v2-lib.js — 品牌资产 v2 接线的共享底层（零依赖，只用 node:zlib / node:crypto）
 *
 * 唯一图标源是 design/brand/v2/（母版与导出包，见 design/brand/v2/README.md）。
 * 本模块提供：
 *   · PNG 解码/编码（8-bit、RGB/RGBA、非隔行，过滤 0-4 全支持，手写 unfilter）；
 *   · ICO 目录头解析（帧尺寸校验用）；
 *   · 两类"派生生产资产"的确定性生成器（v2 README 指定的做法，禁止退回旧图标源）：
 *       - ic_launcher_round：由对应 legacy 图做圆形裁切（3×3 超采样抗锯齿）；
 *       - 启动页 splash：wolf-decal-1024 等比缩放后居中合成到 #080D17 实色底；
 *   · 生产资产 → v2 源的映射表（apply 与 check 共用一份，避免两边漂移）。
 *
 * 所有派生都是纯函数：同样的 v2 输入必然得到同样的字节，因此
 * check-brand-assets.js 用同一份代码重算哈希即可做门禁比对。
 *
 * 用法：被 scripts/apply-brand-v2.js 与 scripts/check-brand-assets.js require。
 */
'use strict';
const zlib = require('zlib');
const crypto = require('crypto');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const V2_EXPORT_DIR = 'design/brand/v2/export';

// ---------- 通用 ----------
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------- PNG ----------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 解码 8-bit 非隔行 RGB(2)/RGBA(6) PNG，返回 { width, height, channels, data } */
function decodePng(buf) {
  if (buf.length < 8 + 12 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG（签名不符）');
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`不支持的位深 ${bitDepth}（只支持 8）`);
      if (colorType !== 2 && colorType !== 6) throw new Error(`不支持的色彩类型 ${colorType}（只支持 RGB/RGBA）`);
      if (data[12] !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (!idat.length || !width || !height) throw new Error('PNG 缺少 IHDR/IDAT');
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    raw.copy(row, 0, pos, pos + stride);
    pos += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      row[x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** 编码 PNG（filter 0 + deflate level 9；channels 3 → RGB，4 → RGBA） */
function encodePng(width, height, channels, data) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** 读取 IHDR 尺寸（不解码，校验用） */
function pngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG（签名不符）');
  if (buf.readUInt32BE(12) !== 0x49484452) throw new Error('PNG 首块不是 IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}

function toRgba(img) {
  if (img.channels === 4) return img;
  const n = img.width * img.height;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = img.data[i * 3];
    out[i * 4 + 1] = img.data[i * 3 + 1];
    out[i * 4 + 2] = img.data[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return { width: img.width, height: img.height, channels: 4, data: out };
}

// ---------- ICO ----------
/** 解析 ICO 目录头：返回帧清单 [{ width, height, bpp, bytes }]（0 字节宽高 = 256） */
function parseIco(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('不是 ICO（保留字/类型不符）');
  const count = buf.readUInt16LE(4);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    frames.push({
      width: buf[o] || 256,
      height: buf[o + 1] || 256,
      bpp: buf.readUInt16LE(o + 6),
      bytes: buf.readUInt32LE(o + 8),
    });
  }
  return { count, frames };
}

// ---------- 派生生成器（确定性：同输入必同字节） ----------
/** 面积平均缩放 RGBA（预乘 alpha 加权，避免透明边发暗） */
function resizeRgbaBox(img, dw, dh) {
  const sw = img.width;
  const sh = img.height;
  const data = img.data;
  const out = Buffer.alloc(dw * dh * 4);
  for (let dy = 0; dy < dh; dy++) {
    const y0 = (dy * sh) / dh;
    const y1 = ((dy + 1) * sh) / dh;
    for (let dx = 0; dx < dw; dx++) {
      const x0 = (dx * sw) / dw;
      const x1 = ((dx + 1) * sw) / dw;
      let rA = 0;
      let gA = 0;
      let bA = 0;
      let aSum = 0;
      let wsum = 0;
      for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          const wgt = wx * wy;
          const i = (sy * sw + sx) * 4;
          const a = data[i + 3];
          rA += data[i] * a * wgt;
          gA += data[i + 1] * a * wgt;
          bA += data[i + 2] * a * wgt;
          aSum += a * wgt;
          wsum += wgt;
        }
      }
      const o = (dy * dw + dx) * 4;
      out[o + 3] = Math.round(aSum / wsum);
      if (aSum > 0) {
        out[o] = Math.round(rA / aSum);
        out[o + 1] = Math.round(gA / aSum);
        out[o + 2] = Math.round(bA / aSum);
      }
    }
  }
  return { width: dw, height: dh, channels: 4, data: out };
}

/** 圆形裁切：圆外 alpha=0，边缘 3×3 超采样抗锯齿 */
function circularCropRgba(img) {
  const size = img.width;
  const data = img.data;
  const out = Buffer.alloc(size * size * 4);
  const r = size / 2;
  const SS = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const dx = px - r;
          const dy = py - r;
          if (dx * dx + dy * dy <= r * r) hit++;
        }
      }
      const i = (y * size + x) * 4;
      out[i] = data[i];
      out[i + 1] = data[i + 1];
      out[i + 2] = data[i + 2];
      out[i + 3] = Math.round((hit / (SS * SS)) * 255);
    }
  }
  return { width: size, height: size, channels: 4, data: out };
}

/** 派生 Android round 图标：由 legacy 图（v2 icon-N.png）圆形裁切 */
function deriveRoundIcon(legacyPngBuf) {
  const img = toRgba(decodePng(legacyPngBuf));
  const cropped = circularCropRgba(img);
  return encodePng(cropped.width, cropped.height, 4, cropped.data);
}

// 启动页参数：v2 README —— adaptive 背景实色 #080D17；decal 适合启动页
const SPLASH_BG = [0x08, 0x0d, 0x17];
const SPLASH_FRACTION = 0.62; // 纹章宽度占启动页短边的比例

/** 派生 Android 启动页：wolf-decal-1024 等比缩放居中，合成到 #080D17 实色底（RGB 无 alpha） */
function deriveSplash(decalPngBuf, outW, outH) {
  const decal = toRgba(decodePng(decalPngBuf));
  const fit = Math.round(Math.min(outW, outH) * SPLASH_FRACTION);
  if (fit > decal.width) throw new Error(`启动页派生只支持缩小（fit ${fit} > 母版 ${decal.width}）`);
  const scaled = fit === decal.width ? decal : resizeRgbaBox(decal, fit, fit);
  const x0 = Math.floor((outW - fit) / 2);
  const y0 = Math.floor((outH - fit) / 2);
  const canvas = Buffer.alloc(outW * outH * 3);
  for (let i = 0; i < outW * outH; i++) {
    canvas[i * 3] = SPLASH_BG[0];
    canvas[i * 3 + 1] = SPLASH_BG[1];
    canvas[i * 3 + 2] = SPLASH_BG[2];
  }
  for (let y = 0; y < fit; y++) {
    for (let x = 0; x < fit; x++) {
      const s = (y * fit + x) * 4;
      const a = scaled.data[s + 3];
      if (a === 0) continue;
      const o = ((y + y0) * outW + (x + x0)) * 3;
      if (a === 255) {
        canvas[o] = scaled.data[s];
        canvas[o + 1] = scaled.data[s + 1];
        canvas[o + 2] = scaled.data[s + 2];
      } else {
        canvas[o] = Math.round((scaled.data[s] * a + SPLASH_BG[0] * (255 - a)) / 255);
        canvas[o + 1] = Math.round((scaled.data[s + 1] * a + SPLASH_BG[1] * (255 - a)) / 255);
        canvas[o + 2] = Math.round((scaled.data[s + 2] * a + SPLASH_BG[2] * (255 - a)) / 255);
      }
    }
  }
  return encodePng(outW, outH, 3, canvas);
}

/** 展开 ICO：返回每帧 { w, h, bpp, data(Buffer), hash }（目录里 0 表示 256）。
 *  FIN-09 包侧校验用：EXE 的 RT_ICON 帧字节与 ICO 帧字节逐一比对。
 *  注意 ICO 帧可能是 PNG 压缩（本仓 app.ico 7 帧全是 PNG），data 是**原始帧字节**，不是解码像素。 */
function icoFrames(buf) {
  const { frames } = parseIco(buf);
  return frames.map((f, i) => {
    // 帧数据的绝对偏移记录在每个目录项的 +12 字节处（parseIco 只读尺寸/字节长，这里补读偏移）
    const off = buf.readUInt32LE(6 + i * 16 + 12);
    const data = buf.subarray(off, off + f.bytes);
    return { w: f.width, h: f.height, bpp: f.bpp, data, hash: sha256(data) };
  });
}

// ---------- 映射表（生产资产 ← v2 源；apply 与 check 的唯一事实来源） ----------
const ANDROID_RES = 'app/android/app/src/main/res';
// [密度, legacy 尺寸, adaptive 前景尺寸]（v2 README 接入映射表）
const ANDROID_DENSITIES = [
  ['mdpi', 48, 108],
  ['hdpi', 72, 162],
  ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324],
  ['xxxhdpi', 192, 432],
];
// [相对 ANDROID_RES 路径, 宽, 高]（与现有工程逐档实测一致）
const ANDROID_SPLASHES = [
  ['drawable/splash.png', 480, 320],
  ['drawable-land-mdpi/splash.png', 480, 320],
  ['drawable-land-hdpi/splash.png', 800, 480],
  ['drawable-land-xhdpi/splash.png', 1280, 720],
  ['drawable-land-xxhdpi/splash.png', 1600, 960],
  ['drawable-land-xxxhdpi/splash.png', 1920, 1280],
  ['drawable-port-mdpi/splash.png', 320, 480],
  ['drawable-port-hdpi/splash.png', 480, 800],
  ['drawable-port-xhdpi/splash.png', 720, 1280],
  ['drawable-port-xxhdpi/splash.png', 960, 1600],
  ['drawable-port-xxxhdpi/splash.png', 1280, 1920],
];

// kind: png-copy | svg-copy | round（派生） | splash（派生） | color | adaptive-xml
const V2_MASTER_EMBLEM = "design/brand/v2/wolf-emblem.svg"; // 母版：自为基准，不经 export/manifest
const MAPPING = [
  // —— BRAND-02：web 生产 PWA 图标（manifest / index.html / m/index.html 引用面）——
  // FIN-08：页面可见狼冠（生产派生自母版，直拷同源；首页大标识/局中顶栏/手机品牌区引用它）
  { prod: 'web/assets/brand/wolf-emblem.svg', kind: 'svg-master' },
  { prod: 'web/assets/icon.svg', v2: 'app-icon.svg', kind: 'svg-copy' },
  { prod: 'web/assets/icon-192.png', v2: 'icon-192.png', kind: 'png-copy', w: 192, h: 192 },
  { prod: 'web/assets/icon-512.png', v2: 'icon-512.png', kind: 'png-copy', w: 512, h: 512 },
  { prod: 'web/assets/icon-maskable-512.png', v2: 'icon-maskable-512.png', kind: 'png-copy', w: 512, h: 512 },
  { prod: 'web/assets/apple-touch-icon.png', v2: 'icon-180.png', kind: 'png-copy', w: 180, h: 180 },
  // —— BRAND-03：Android 自适应图标 + legacy + round + 启动页 ——
  ...ANDROID_DENSITIES.map(([dpi, legacy, fg]) => [
    { prod: `${ANDROID_RES}/mipmap-${dpi}/ic_launcher.png`, v2: `icon-${legacy}.png`, kind: 'png-copy', w: legacy, h: legacy },
    { prod: `${ANDROID_RES}/mipmap-${dpi}/ic_launcher_foreground.png`, v2: `adaptive-foreground-${fg}.png`, kind: 'png-copy', w: fg, h: fg },
    { prod: `${ANDROID_RES}/mipmap-${dpi}/ic_launcher_round.png`, v2: `icon-${legacy}.png`, kind: 'round', w: legacy, h: legacy },
  ]).flat(),
  ...ANDROID_SPLASHES.map(([rel, w, h]) => ({
    prod: `${ANDROID_RES}/${rel}`, v2: 'wolf-decal-1024.png', kind: 'splash', w, h,
  })),
  { prod: `${ANDROID_RES}/values/ic_launcher_background.xml`, kind: 'color', value: '#080D17' },
  { prod: `${ANDROID_RES}/mipmap-anydpi-v26/ic_launcher.xml`, kind: 'adaptive-xml' },
  { prod: `${ANDROID_RES}/mipmap-anydpi-v26/ic_launcher_round.xml`, kind: 'adaptive-xml' },
  // —— FIN-09：Windows EXE 图标源（desktop/package.json build.win.icon 指向它；
  //    electron-builder resedit / NSIS Icon 把它的帧写进 EXE 资源段，包侧由 app:verify 逐一比对）——
  { prod: 'desktop/build/icon.ico', v2: 'app.ico', kind: 'ico-copy' },
];

// 门禁需要的 v2 侧资产（含 ICO；逐个与 export/manifest.json 的 SHA-256 交叉核对）
const V2_ASSETS_USED = [
  ...new Set(MAPPING.filter((m) => m.v2).map((m) => m.v2)),
  'app.ico',
];

module.exports = {
  ROOT,
  V2_MASTER_EMBLEM,
  V2_EXPORT_DIR,
  V2_ASSETS_USED,
  MAPPING,
  ANDROID_RES,
  SPLASH_BG,
  SPLASH_FRACTION,
  sha256,
  decodePng,
  encodePng,
  pngSize,
  parseIco,
  icoFrames,
  toRgba,
  deriveRoundIcon,
  deriveSplash,
  resolve: (rel) => path.join(ROOT, rel),
  v2Path: (name) => path.join(ROOT, V2_EXPORT_DIR, name),
};
