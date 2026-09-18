/**
 * verify-packages.js — 校验"安装包里装的到底是不是当前源码"
 *
 * 为什么必须有这一步：`assembleDebug` 成功 ≠ 包里是**这一批**代码。
 * 实测踩过：跳过 `cap sync android` 时，APK 的 assets 仍是上一次同步的快照，
 * gradle 照样退出码 0，而包里的 flow.js 是旧的（狼王加权在、僵局护栏不在）——
 * 只看构建退出码根本发现不了，必须打开包逐个比对。
 *
 * 关于读 APK：它是个 zip，但**不能用 `tar -tf` 读**（GNU tar 读 zip 会静默失败、
 * 给出空列表，看起来像"包里什么都没有"）。这里用 Node 内置 zlib 自己解中央目录，零依赖。
 *
 * 用法：node scripts/verify-packages.js [--apk=路径] [--win=目录]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
/** APK 内服务端文件的存放前缀（Capacitor 把 app/www 放进 assets/public） */
const APK_PREFIX = 'assets/public/nodejs/';

/** 读出版本号（与电脑版打包脚本同一来源，保证两边一致） */
function readVersion() {
  const g = fs.readFileSync(path.join(ROOT, 'app', 'android', 'app', 'build.gradle'), 'utf8');
  const m = g.match(/versionName\s+"([^"]+)"/);
  return m ? m[1] : '0.0.0';
}

/** 解出 zip 的全部条目 [{name, data}]（只解不压缩的与 deflate 的；其余跳过） */
function readZip(zipPath) {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`不是有效的 zip：${zipPath}`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break; // 中央目录条目签名
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // 目录项
    // 本地头的名字/扩展区长度可能与中央目录不同，必须按本地头重新算数据起点
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    try {
      out.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw) });
    } catch (_) { /* 损坏条目跳过：校验关心的是源码文件，读不出来会报"缺少" */ }
  }
  return out;
}

const TEXT_EXT = new Set(['.js', '.html', '.css', '.json', '.md']);
/** 行尾归一：Windows 工作区可能是 CRLF，而包里是 LF，不该因此判为"不是同一份" */
const norm = (s) => String(s).replace(/\r\n/g, '\n');

/** 需要跟着包走的源码清单：server.js + src/** + web/**（跳过构建产物与缓存） */
function sourceFiles() {
  const skip = new Set(['node_modules', '.git', 'release', 'app', 'logs', 'saves', 'dist', 'android']);
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name) || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  };
  for (const rel of ['server.js', 'src', 'web']) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) walk(p);
    else out.push(rel);
  }
  return out.sort();
}

/** 把"包内相对路径 → Buffer"与当前源码逐字节比对 */
function compareTree(label, map, problems) {
  let checked = 0;
  let binary = 0;
  for (const rel of sourceFiles()) {
    const packed = map.get(rel);
    if (packed === undefined) { problems.push(`${label}: 包里缺少 ${rel}`); continue; }
    if (!TEXT_EXT.has(path.extname(rel))) { binary++; continue; }
    const src = fs.readFileSync(path.join(ROOT, rel));
    if (norm(packed.toString('utf8')) !== norm(src.toString('utf8'))) {
      problems.push(`${label}: ${rel} 与当前源码不一致（包里是旧版本）`);
    }
    checked++;
  }
  return { label, checked, binary, files: map.size };
}

function verifyApk(apkPath) {
  const problems = [];
  const entries = readZip(apkPath).filter((e) => e.name.startsWith(APK_PREFIX));
  if (!entries.length) problems.push(`APK: 包里没有 ${APK_PREFIX} 下的服务端文件（打包结构变了？）`);
  const map = new Map(entries.map((e) => [e.name.slice(APK_PREFIX.length), e.data]));
  return { ...compareTree('APK', map, problems), problems };
}

function verifyWin(dir) {
  const problems = [];
  const map = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else map.set(path.relative(dir, p).split(path.sep).join('/'), fs.readFileSync(p));
    }
  };
  walk(dir);
  if (!map.has('node.exe')) problems.push('WIN: 包里缺少 node.exe（内置运行时）');
  if (![...map.keys()].some((k) => k.endsWith('.cmd'))) problems.push('WIN: 包里缺少 .cmd 启动器');
  return { ...compareTree('WIN', map, problems), problems };
}

function report(label, target, r) {
  const where = path.relative(ROOT, target);
  if (r.problems.length) {
    console.log(`✖ ${label} ${where}：发现 ${r.problems.length} 处问题`);
    for (const p of r.problems.slice(0, 10)) console.log(`    · ${p}`);
    if (r.problems.length > 10) console.log(`    · …另有 ${r.problems.length - 10} 处`);
    return false;
  }
  console.log(`✓ ${label} ${where}：与当前源码一致（比对 ${r.checked} 个文本文件，另有 ${r.binary} 个二进制只查存在）`);
  return true;
}

function main(argv) {
  const get = (k, d) => {
    const a = argv.find((x) => x.startsWith(`--${k}=`));
    return a ? a.slice(k.length + 3) : d;
  };
  const v = readVersion();
  const targets = [
    ['APK', get('apk', path.join(ROOT, 'release', `werewolf-ai-${v}-debug.apk`)), verifyApk],
    ['WIN', get('win', path.join(ROOT, 'release', `werewolf-ai-${v}-win-x64`)), verifyWin],
  ];
  let ok = true;
  let seen = 0;
  for (const [label, target, fn] of targets) {
    if (!fs.existsSync(target)) { console.log(`- ${label}：未找到 ${path.relative(ROOT, target)}（跳过）`); continue; }
    seen++;
    try { ok = report(label, target, fn(target)) && ok; } catch (e) { ok = false; console.log(`✖ ${label}：校验失败 ${e.message}`); }
  }
  if (!seen) { console.log('没有可校验的产物：先跑 npm run app:apk / npm run app:win'); return 0; }
  return ok ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { readZip, readVersion, sourceFiles, compareTree, verifyApk, verifyWin, main };
