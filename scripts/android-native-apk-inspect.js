#!/usr/bin/env node
/**
 * android-native-apk-inspect.js —— 只读地把 APK 当 zip 打开，列出/抽取指定条目。
 *
 * 为什么不用 `tar -tf`：GNU tar 读不了 zip，且**退出码仍为 0**（静默失败），
 * 会把"没检查"伪装成"检查通过"。这里自己解 zip 中央目录，零依赖。
 *
 * 用法：
 *   node scripts/android-native-apk-inspect.js list <apk> [子串]
 *   node scripts/android-native-apk-inspect.js extract <apk> <条目名> <输出路径>
 *   node scripts/android-native-apk-inspect.js hash <apk> <条目名>
 * 退出码：0 = 成功；1 = 出错（条目不存在 / 不是 zip）。
 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

/** 读 zip 的 End Of Central Directory → 中央目录 → 条目表（只用标准库，不依赖任何 npm 包）。 */
function readEntries(buf) {
  // EOCD 签名 0x06054b50，从尾部往回找（注释最长 64KiB）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 zip（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`中央目录第 ${i} 条签名不符`);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nlen).toString('utf8');
    entries.push({ name, method, crc, csize, usize, lho });
    off += 46 + nlen + elen + clen;
  }
  return entries;
}

/** 按中央目录里的 local header 偏移取该条目原始数据并解压。 */
function readEntry(buf, e) {
  if (buf.readUInt32LE(e.lho) !== 0x04034b50) throw new Error('local header 签名不符');
  const nlen = buf.readUInt16LE(e.lho + 26);
  const elen = buf.readUInt16LE(e.lho + 28);
  const start = e.lho + 30 + nlen + elen;
  const raw = buf.slice(start, start + e.csize);
  if (e.method === 0) return raw;
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`不支持的压缩方法 ${e.method}`);
}

function main(argv) {
  const [op, apkPath, ...rest] = argv;
  if (!op || !apkPath) { console.error('用法：list|extract|hash <apk> [args]'); return 1; }
  const buf = fs.readFileSync(apkPath);
  const entries = readEntries(buf);
  if (op === 'list') {
    const sub = rest[0] || '';
    const hit = entries.filter((e) => e.name.includes(sub));
    console.log(`APK=${apkPath}`);
    console.log(`zip 条目总数=${entries.length}  匹配 "${sub}"=${hit.length}`);
    for (const e of hit) console.log(`  ${e.usize}\t${e.name}`);
    return 0;
  }
  const want = rest[0];
  const e = entries.find((x) => x.name === want);
  if (!e) { console.error(`✗ 条目不存在：${want}`); return 1; }
  const data = readEntry(buf, e);
  if (op === 'hash') {
    console.log(`条目=${e.name} 解压后字节=${data.length} sha256=${crypto.createHash('sha256').update(data).digest('hex')}`);
    return 0;
  }
  if (op === 'extract') {
    const out = rest[1];
    if (!out) { console.error('缺少输出路径'); return 1; }
    fs.mkdirSync(require('path').dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    console.log(`✓ ${e.name} → ${out}（${data.length} 字节，sha256=${crypto.createHash('sha256').update(data).digest('hex')}）`);
    return 0;
  }
  console.error(`未知操作：${op}`);
  return 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { readEntries, readEntry };
