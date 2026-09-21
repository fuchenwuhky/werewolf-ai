/**
 * avatar.js — 自定义头像的**唯一**字节判据（M1 §4.2 存储 / §4.3 接口 / §4.4 导入导出）
 *
 * 为什么单独成模块：这条判据有三个使用方（档案仓写入、导入包校验、GET 出图），
 * 判据分叉过一次的代价在这个仓库里已经付过（见 src/tmp-files.js 文件头的 FIX-12 复盘）：
 * 「上传时校验 A、导入时校验 B」的结果是**一条路径能塞进另一条路径拒绝的坏文件**。
 * 所以尺寸、色彩类型、结构完整性、哈希只在这里实现一次。
 *
 * 服务端不信任扩展名，也不信任客户端声明的 Content-Type：唯一凭据是字节本身。
 * 判定顺序（先便宜后昂贵）：体积 → PNG 签名 → 逐块结构（长度/CRC/IEND，能抓截断与损坏）
 * → IHDR 字段（位深/色彩类型/尺寸/压缩/扫描方式）→ SHA-256。
 *
 * 明确拒绝（每条都在测试里有对应反例）：
 *   · 非 PNG / 空 body / 超过 2 MiB；
 *   · 截断（块内容不完整、缺 IEND、尾部多余字节）与损坏（块 CRC 不匹配）；
 *   · 缺 IHDR、缺 IDAT（没有图像数据）、IEND 非空；
 *   · 位深非 8-bit、色彩类型不是 RGB(2)/RGBA(6)（灰度/调色板/16-bit 一律拒绝）；
 *   · 尺寸不是精确 512×512；隔行扫描（interlace=1，无法在无解码器的情况下确认可完整读取）；
 *   · 非规范 Base64（解码后重编码必须逐字符相同）与哈希不匹配（导入包）。
 *
 * 附带做的一件事（超出 §4.4 字面要求、但让"不得包含原始 EXIF"成为服务端可保证的事实）：
 * `prepareAvatar()` 会剥掉可携带用户数据的元数据块（tEXt/zTXt/iTXt/eXIf/tIME）后重建 PNG 流，
 * 保留全部关键块与色彩相关块（gAMA/sRGB/pHYs…），CRC 不需要重算（块内容未变）。
 * 落盘与哈希一律基于**剥离后**的字节，因此导出包里不可能夹带上传者塞进来的文件名/GPS/EXIF。
 */
'use strict';
const crypto = require('crypto');
const zlib = require('zlib');

/** 二进制固定落点（§4.2）：profiles/<profileId>/avatar.png —— 不保存用户原图 */
const AVATAR_FILE = 'avatar.png';
const AVATAR_MIME = 'image/png';
/** 元数据版本（§4.2 的 customAvatar.version） */
const AVATAR_VERSION = 1;
/** 唯一允许的边长（§4.3：宽高精确 512×512） */
const AVATAR_SIZE = 512;
/** 唯一允许的体积上限（§4.3：body > 0 且 ≤ 2MiB） */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 只接受常见 8-bit RGB/RGBA（§4.3）：2 = truecolor，6 = truecolor+alpha */
const SUPPORTED_COLOR_TYPES = new Set([2, 6]);
/** 可携带用户数据的元数据块：落盘前剥离（原始文件名/EXIF/GPS 都在这些块里） */
const METADATA_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
const SHA256_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** 头像相关的 400 语义错误（与档案仓 ValidationError 同码，便于路由原样透传） */
class AvatarError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'AvatarError';
    this.code = 400;
  }
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

/** PNG 块 CRC-32（多项式 0xEDB88320）。自己实现而不依赖 zlib.crc32：engines 声明 >=18.18 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 逐块遍历 PNG：返回 { ihdr, chunks }。任何结构问题都抛 AvatarError。
 * 这是"畸形/截断/无法完整读取"判定的落点：`off` 必须**恰好**走到 buffer 末尾，
 * 最后一块必须是 IEND —— 少一个字节（截断）或多一个字节（拼接垃圾）都会被抓到。
 */
function walkPng(buf, { label = 'PNG' } = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new AvatarError(`${label}为空（0 字节）`);
  if (buf.length < PNG_SIGNATURE.length + 25) throw new AvatarError(`${label}数据过短（疑似截断）`);
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new AvatarError(`${label}不是 PNG（签名不匹配）`);
  const chunks = [];
  let ihdr = null;
  let sawIend = false;
  let off = 8;
  while (off < buf.length) {
    if (off + 8 > buf.length) throw new AvatarError(`${label}截断：块头不完整`);
    const length = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const dataStart = off + 8;
    const crcStart = dataStart + length;
    if (!/^[A-Za-z]{4}$/.test(type)) throw new AvatarError(`${label}块类型非法（偏移 ${off}）`);
    if (crcStart + 4 > buf.length) throw new AvatarError(`${label}截断：块 ${type} 内容不完整`);
    const declared = buf.readUInt32BE(crcStart);
    const actual = crc32(buf.subarray(off + 4, crcStart)); // CRC 覆盖「类型 + 数据」
    if (declared !== actual) throw new AvatarError(`${label}块 ${type} 校验和不匹配（文件损坏）`);
    if (!chunks.length) {
      if (type !== 'IHDR' || length !== 13) throw new AvatarError(`${label}缺少 IHDR（首个块必须是 13 字节的 IHDR）`);
      ihdr = {
        width: buf.readUInt32BE(dataStart),
        height: buf.readUInt32BE(dataStart + 4),
        bitDepth: buf[dataStart + 8],
        colorType: buf[dataStart + 9],
        compression: buf[dataStart + 10],
        filter: buf[dataStart + 11],
        interlace: buf[dataStart + 12],
      };
    }
    chunks.push({ type, start: off, end: crcStart + 4 });
    off = crcStart + 4;
    if (type === 'IEND') {
      if (length !== 0) throw new AvatarError(`${label}的 IEND 块长度必须是 0`);
      sawIend = true;
      break;
    }
  }
  if (!ihdr) throw new AvatarError(`${label}缺少 IHDR`);
  if (!sawIend) throw new AvatarError(`${label}截断：缺少 IEND 结束块`);
  if (off !== buf.length) throw new AvatarError(`${label}尾部有多余字节（畸形文件）`);
  return { ihdr, chunks };
}

/**
 * 「能否完整读取」的最强判据（无需像素解码器）：把 IDAT 解压出来，长度必须**精确**等于
 * `height × (1 + 每行字节数)`（filter 0，非隔行）。
 *
 * 只查块 CRC 是不够的：一个有 CRC 但 zlib 流损坏 / IDAT 被截断后重算过 CRC 的文件，
 * 结构看完全合法，交给浏览器就是一张破图 —— 那正是 §4.1「不能先清空再上传」要避免的结果。
 * `maxOutputLength` 兼作 zip bomb 上限：解压结果超过期望值就直接失败，不会把内存交出去。
 */
function assertImageDataReadable(buf, chunks, ihdr) {
  const idat = chunks.filter((c) => c.type === 'IDAT');
  const first = chunks.findIndex((c) => c.type === 'IDAT');
  for (let i = 0; i < idat.length; i++) {
    // PNG 规范：多个 IDAT 必须连续。不连续 ⇒ 畸形文件
    if (chunks[first + i].type !== 'IDAT') throw new AvatarError('PNG 的 IDAT 块不连续（畸形文件）');
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  const stride = Math.ceil((ihdr.width * channels * (ihdr.bitDepth / 8)));
  const expected = ihdr.height * (1 + stride);
  const parts = idat.map((c) => buf.subarray(c.start + 8, c.end - 4)); // 去掉长度/类型头与 CRC
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(parts), { maxOutputLength: expected });
  } catch (e) {
    throw new AvatarError(`PNG 图像数据无法完整读取（解压失败：${e.message}）`);
  }
  if (raw.length !== expected) {
    throw new AvatarError(`PNG 图像数据长度不符（解压后 ${raw.length} 字节 ≠ 期望 ${expected} 字节）`);
  }
}

/**
 * 校验一个候选头像字节串；通过则返回尺寸/色彩/体积/内容哈希。
 * @param {Buffer} buf 候选字节（上传 body 或导入包解码结果）
 * @param {{label?: string}} opts label 只影响错误文案（"头像"/"导入包头像"）
 */
function validateAvatarBuffer(buf, { label = '头像' } = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new AvatarError(`${label}为空（0 字节）`);
  if (buf.length > MAX_AVATAR_BYTES) {
    throw new AvatarError(`${label}超过上限 ${MAX_AVATAR_BYTES / 1048576} MiB（实际 ${buf.length} 字节）`);
  }
  const { ihdr, chunks } = walkPng(buf, { label });
  if (!chunks.some((c) => c.type === 'IDAT')) throw new AvatarError(`${label}没有图像数据（缺少 IDAT）`);
  if (ihdr.compression !== 0 || ihdr.filter !== 0) throw new AvatarError(`${label}使用了不支持的压缩/滤波方式`);
  if (ihdr.interlace !== 0) throw new AvatarError(`${label}是隔行扫描 PNG（interlace=1），请重新导出为普通 PNG`);
  if (ihdr.bitDepth !== 8) throw new AvatarError(`${label}位深必须是 8-bit（实际 ${ihdr.bitDepth}）`);
  if (!SUPPORTED_COLOR_TYPES.has(ihdr.colorType)) {
    throw new AvatarError(`${label}色彩类型不支持（colorType=${ihdr.colorType}，只接受 8-bit RGB(2)/RGBA(6)）`);
  }
  if (ihdr.width !== AVATAR_SIZE || ihdr.height !== AVATAR_SIZE) {
    throw new AvatarError(`${label}尺寸必须是 ${AVATAR_SIZE}×${AVATAR_SIZE}（实际 ${ihdr.width}×${ihdr.height}）`);
  }
  assertImageDataReadable(buf, chunks, ihdr);
  return {
    width: ihdr.width, height: ihdr.height, colorType: ihdr.colorType, bitDepth: ihdr.bitDepth,
    bytes: buf.length, sha256: sha256Hex(buf),
  };
}

/** 剥掉可携带用户数据的元数据块并重建 PNG 流（未剥离时原样返回同一 Buffer） */
function stripMetadataChunks(buf) {
  const { chunks } = walkPng(buf); // 结构/CRC 已在这里过一遍
  const stripped = chunks.filter((c) => METADATA_CHUNKS.has(c.type));
  if (!stripped.length) return { data: buf, stripped: [] };
  const parts = [PNG_SIGNATURE];
  for (const c of chunks) {
    if (METADATA_CHUNKS.has(c.type)) continue;
    parts.push(buf.subarray(c.start, c.end));
  }
  return { data: Buffer.concat(parts), stripped: stripped.map((c) => c.type) };
}

/**
 * 落盘前的准备：校验 → 剥离元数据 → 再校验 → 返回最终字节与最终哈希。
 * 调用方必须用返回的 data/sha256 落盘与写元数据（"先算 SHA-256 再落盘"，URL 用内容哈希）。
 */
function prepareAvatar(buf, { label = '头像' } = {}) {
  const checked = validateAvatarBuffer(buf, { label });
  const { data, stripped } = stripMetadataChunks(buf);
  if (!stripped.length) return { ...checked, data: buf, stripped };
  const rechecked = validateAvatarBuffer(data, { label }); // 自己重建的结果必须仍然合法
  return { ...rechecked, data, stripped };
}

/**
 * 校验并解码导入包里的 `profile.customAvatar`（§4.4）：Base64 → 字节上限 → PNG 结构 → 尺寸 → 哈希。
 * 全部在**任何写盘之前**完成（validateImportPackage 与 importApplyRes 都会调它，判据唯一）。
 * @returns {{data: Buffer, sha256: string, mime: string, bytes: number}|null} 无该字段 → null
 */
function decodeAvatarPayload(raw, { label = '导入包头像' } = {}) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new AvatarError(`${label}必须是对象`);
  if (raw.mime !== AVATAR_MIME) throw new AvatarError(`${label}的 mime 必须是 ${AVATAR_MIME}（实际 ${String(raw.mime)}）`);
  const b64 = raw.dataBase64;
  if (typeof b64 !== 'string' || !b64.length) throw new AvatarError(`${label}缺少 dataBase64`);
  if (!BASE64_RE.test(b64) || b64.length % 4 !== 0) throw new AvatarError(`${label}的 dataBase64 不是合法 Base64`);
  const data = Buffer.from(b64, 'base64');
  if (!data.length) throw new AvatarError(`${label}解码后为空`);
  // 非规范编码（多余填充位、长度不整）会让"重编码"与原文不同，必须拒绝：否则声明的哈希可以指向另一串字节
  if (data.toString('base64') !== b64) throw new AvatarError(`${label}的 Base64 不是规范编码（解码后重编码不一致）`);
  const checked = validateAvatarBuffer(data, { label });
  if (!SHA256_RE.test(String(raw.sha256 || ''))) throw new AvatarError(`${label}的 sha256 必须是 64 位小写十六进制`);
  if (checked.sha256 !== raw.sha256) {
    throw new AvatarError(`${label}哈希不匹配（声明 ${String(raw.sha256).slice(0, 12)}… 实际 ${checked.sha256.slice(0, 12)}…）`);
  }
  return { data, sha256: checked.sha256, mime: AVATAR_MIME, bytes: data.length };
}

module.exports = {
  AVATAR_FILE, AVATAR_MIME, AVATAR_VERSION, AVATAR_SIZE, MAX_AVATAR_BYTES,
  SUPPORTED_COLOR_TYPES, METADATA_CHUNKS, SHA256_RE, AvatarError,
  sha256Hex, crc32, walkPng, assertImageDataReadable, validateAvatarBuffer, stripMetadataChunks, prepareAvatar, decodeAvatarPayload,
};
