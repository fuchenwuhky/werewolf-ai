/**
 * helpers-png.js — 测试用 PNG 合成/破坏工具（非测试文件，不会被 node --test 发现）
 *
 * 为什么自己写合成器：头像判据要求"结构合法且**能完整读取**"，反例必须能精确控制
 * （尺寸、色彩类型、位深、隔行、CRC、zlib 流、附带元数据块）。仓库零运行时依赖，
 * 也不能引第三方图像库。这里只做一个"能让服务端校验通过"的最小真 PNG：
 * 每行 filter 0 + 可预测的字节，真正 zlib 压缩，CRC 真算 —— 服务端不解码像素，
 * 因此像素内容可以是最简单的渐变。
 */
'use strict';
const zlib = require('node:zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 每个色彩类型一个像素的通道数（8-bit）；3=调色板（索引 1 字节）用于构造"色彩类型不支持"反例 */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 组装一个 PNG 块：长度 + 类型 + 数据 + CRC（CRC 覆盖类型与数据） */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 该色彩类型/位深下每行的字节数（不含 filter 字节） */
function strideOf({ width, colorType = 6, bitDepth = 8 }) {
  return Math.ceil((width * CHANNELS[colorType] * bitDepth) / 8);
}

/** PNG 的 Paeth 预测器（滤波类型 4 用；与规范逐字对应） */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * 解压后的原始图像数据（每行 = 1 字节 filter + stride 字节像素）。
 * filters 按行循环取滤波类型，默认 [0]；传 [1,2,3,4] 时**真正按 PNG 规范做前向滤波**
 * （Sub/Up/Average/Paeth），所以产出的仍是任何解码器都能还原的真图，而不是只改标签字节的假图。
 * R07 用它造"合法 1–4 必须被接受"的正例；反例则在此结果上直接篡改某行的滤波字节（CRC 由 chunk() 真算）。
 * filters 省略时输出与旧实现**逐字节一致**，既有用例不受影响。
 */
function rawImage({ width, height, colorType = 6, bitDepth = 8, noise = false, filters = null }) {
  const stride = strideOf({ width, colorType, bitDepth });
  const bpp = Math.max(1, Math.round((CHANNELS[colorType] * bitDepth) / 8));
  const raw = Buffer.alloc((stride + 1) * height);
  const f = filters && filters.length ? filters : [0];
  // noise=true 造"不可压缩"的图（xorshift 伪随机、确定性）⇒ 落盘 PNG ≈ 原始体积 ≈ 1MB，
  // 用来验证"头像字节确实计入 20MiB 总上限"这类体积账，而不是靠一张 3KB 的渐变图蒙混过关
  let seed = 0x2545f491;
  let up = null; // 上一行的**未滤波**字节（Up/Paeth 需要）
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    const type = f[y % f.length];
    raw[row] = type;
    const cur = Buffer.alloc(stride); // 本行未滤波字节（Sub 的 left 与下一行的 up 都用它）
    for (let x = 0; x < stride; x++) {
      let v;
      if (noise) {
        seed ^= seed << 13; seed >>>= 0;
        seed ^= seed >>> 17;
        seed ^= seed << 5; seed >>>= 0;
        v = seed & 0xff;
      } else {
        v = (x * 7 + y * 13) & 0xff;
      }
      cur[x] = v;
      const left = x >= bpp ? cur[x - bpp] : 0;
      const u = up ? up[x] : 0;
      const ul = (up && x >= bpp) ? up[x - bpp] : 0;
      let out = v;
      if (type === 1) out = v - left;
      else if (type === 2) out = v - u;
      else if (type === 3) out = v - Math.floor((left + u) / 2);
      else if (type === 4) out = v - paeth(left, u, ul);
      raw[row + 1 + x] = out & 0xff;
    }
    up = cur;
  }
  return raw;
}

/**
 * 合成一张结构合法、可完整解压的 PNG。
 * @param {object} opts
 *  width/height  默认 512×512（要构造尺寸反例就传别的值）
 *  colorType     2=RGB / 6=RGBA（服务端只收这两种）；0=灰度、3=调色板用于构造"色彩类型不支持"
 *  bitDepth      默认 8（16 用于构造位深反例）
 *  interlace     默认 0
 *  extras        额外块（[{type,data}]），插在 IDAT 之前 —— 用来模拟 tEXt/eXIf/tIME 与"超大附属块"
 *  idatData      直接指定 IDAT 载荷（默认 zlib 压缩真实图像数据）；传坏 zlib 流可造"CRC 对但读不出"
 */
function makePng(opts = {}) {
  const {
    width = 512, height = 512, colorType = 6, bitDepth = 8, interlace = 0,
    extras = [], idatData = null, noise = false,
  } = opts;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = interlace;
  const parts = [PNG_SIGNATURE, chunk('IHDR', ihdr)];
  for (const e of extras) parts.push(chunk(e.type, e.data));
  parts.push(chunk('IDAT', idatData || zlib.deflateSync(rawImage({ width, height, colorType, bitDepth, noise }))));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** 一张带"用户数据"元数据块的合法 PNG：原始文件名（tEXt，含本机绝对路径）、EXIF（eXIf）、tIME */
function makePngWithUserMetadata(opts = {}) {
  return makePng({
    ...opts,
    extras: [
      { type: 'tEXt', data: Buffer.from('Software\0canvas-crop\nOriginal-File-Name\0C:\\Users\\me\\Pictures\\自拍 原图.jpg', 'latin1') },
      { type: 'eXIf', data: Buffer.from('Exif\0\0MM\0*GPS-LAT-31.23-GPS-LON-121.47', 'latin1') },
      { type: 'tIME', data: Buffer.from([0x07, 0xe9, 1, 2, 3, 4, 5]) },
      ...(opts.extras || []),
    ],
  });
}

/** 让某个字节翻一位（默认落在 IDAT 数据里）⇒ 块 CRC 必然不匹配 */
function corruptByte(png, offset = null) {
  const out = Buffer.from(png);
  const at = offset === null ? Math.min(out.length - 20, 60) : offset;
  out[at] = out[at] ^ 0xff;
  return out;
}

/** 截掉尾部 n 字节（默认 8 ⇒ 丢 IEND 收尾）；截到 zlib 流中间也用它 */
function truncatePng(png, n = 8) {
  return Buffer.from(png.subarray(0, png.length - n));
}

/** 在合法 PNG 后面拼接垃圾字节（"尾部有多余字节"反例） */
function appendTrailingGarbage(png, extra = 4) {
  return Buffer.concat([Buffer.from(png), Buffer.alloc(extra, 0x5a)]);
}

/** 完全不是 PNG 的字节串（扩展名/Content-Type 谎报时用） */
function notPng(size = 4096) {
  const buf = Buffer.alloc(size, 0x41);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 31) & 0xff;
  return buf;
}

module.exports = {
  PNG_SIGNATURE, CHANNELS, crc32, chunk, strideOf, rawImage, paeth,
  makePng, makePngWithUserMetadata, corruptByte, truncatePng, appendTrailingGarbage, notPng,
};
