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
 * FIN-09 扩展（包侧内容实证，不只查存在）：
 *   · 全部二进制逐字节 SHA-256 与源码比对（此前 47 个二进制只查存在 —— 缩短为 0 个）；
 *   · APK 内品牌资源（launcher/round/foreground/splash）与 v2 派生期望值比对：
 *     优先字节相等；aapt2 若重编码则按像素比对（提取方法：APK 的 res/*.png 仍是标准
 *     PNG，用 brand-v2-lib 的零依赖解码器解出 RGBA 再逐字节比像素）；
 *   · EXE 图标资源段实检：零依赖解析 PE 头 → 数据目录[2] 定位 .rsrc → 资源树三层
 *     （type/id/lang）提取 RT_GROUP_ICON(14) 与 RT_ICON(3)，把 EXE 里的图标组逐帧
 *     与 design/brand/v2/export/app.ico 的帧字节比对（提取映射方法：ICO 帧字节被
 *     resedit / NSIS 原样写进 RT_ICON 条目，所以按组目录的 {宽,高} 映射回 app.ico
 *     对应帧做 SHA-256；256px 在目录项里编码为 0）；
 *   · 版本号从 release-version.json 读取（FIN-11 单一来源），build.gradle 交叉核对。
 *
 * 用法：node scripts/verify-packages.js [--apk=路径] [--win=目录] [--desktop=exe路径]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const brand = require('./brand-v2-lib.js');

const ROOT = path.join(__dirname, '..');
/** APK 内服务端文件的存放前缀（Capacitor 把 app/www 放进 assets/public） */
const APK_PREFIX = 'assets/public/nodejs/';
/** v2 已交付 ICO 的路径（EXE 图标帧比对的基准） */
const APP_ICO = brand.resolve('design/brand/v2/export/app.ico');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 读出版本号（FIN-11：release-version.json 是唯一权威）。
 *  build.gradle 是声明点之一，交叉核对：漂移说明包的运行时版本与权威版本脱节，
 *  构建出的 APK 名字/内部版本就会各说各话 —— 直接失败并指向 version-sync --fix。 */
function readVersion() {
  const rel = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-version.json'), 'utf8'));
  if (!rel.productVersion) throw new Error('release-version.json 缺少 productVersion');
  const gradlePath = path.join(ROOT, 'app', 'android', 'app', 'build.gradle');
  if (fs.existsSync(gradlePath)) {
    const m = fs.readFileSync(gradlePath, 'utf8').match(/versionName\s+"([^"]+)"/);
    if (m && m[1] !== rel.productVersion) {
      throw new Error(`build.gradle versionName=${m[1]} ≠ release-version.json productVersion=${rel.productVersion}`
        + '（先跑 node scripts/version-sync.js --fix 再构建/校验）');
    }
  }
  return rel.productVersion;
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

// ---------- PE 资源段解析（FIN-09，零依赖） ----------
const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;

/** 解析 PE 的资源表。返回 Map<type, Map<id, Buffer>>（id 层取整数 ID，忽略命名条目）。
 *  路径：DOS 头 e_lfanew → PE 可选头数据目录[2]（IMAGE_DIRECTORY_ENTRY_RESOURCE）
 *  → 按节表把 RVA 换算成文件偏移 → 资源树 type/id(lang) 三层目录 → 叶子数据项。 */
function parsePeResources(buf) {
  if (buf.length < 64 || buf.toString('ascii', 0, 2) !== 'MZ') throw new Error('不是 PE（MZ 签名不符）');
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') throw new Error('不是 PE（PE 签名不符）');
  const numSections = buf.readUInt16LE(peOff + 6);
  const optSize = buf.readUInt16LE(peOff + 20);
  const optOff = peOff + 24;
  const magic = buf.readUInt16LE(optOff);
  const dataDirOff = optOff + (magic === 0x20b ? 112 : 96); // PE32+ / PE32 的数据目录起点
  const resRva = buf.readUInt32LE(dataDirOff + 2 * 8);
  if (!resRva) throw new Error('PE 没有资源段（数据目录[2] 为空）');
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const o = optOff + optSize + i * 40;
    sections.push({ va: buf.readUInt32LE(o + 12), vs: buf.readUInt32LE(o + 8), pr: buf.readUInt32LE(o + 20), ps: buf.readUInt32LE(o + 16) });
  }
  const rvaToOff = (rva) => {
    const s = sections.find((s) => rva >= s.va && rva < s.va + Math.max(s.vs, s.ps));
    if (!s) throw new Error(`RVA 未映射到任何节：0x${rva.toString(16)}`);
    return s.pr + rva - s.va;
  };
  const base = rvaToOff(resRva);
  // 资源目录项：高 31 位为名字偏移/子目录偏移，最高位区分"名字/整数 ID"与"子目录/数据项"
  const table = (off) => {
    const count = buf.readUInt16LE(off + 14);
    const items = [];
    for (let i = 0; i < count; i++) {
      const e = off + 16 + i * 8;
      items.push({ n: buf.readUInt32LE(e), d: buf.readUInt32LE(e + 4) });
    }
    return items;
  };
  const byType = new Map();
  for (const t of table(base)) {
    if (t.n & 0x80000000) continue; // 类型层一律用整数 ID
    const typeMap = new Map();
    for (const n of table(base + (t.d & 0x7fffffff))) {
      if (n.n & 0x80000000) continue; // 只取整数 ID 的条目（图标/版本都是整数 ID）
      for (const l of table(base + (n.d & 0x7fffffff))) {
        if (l.d & 0x80000000) continue; // 叶子：数据项偏移（最高位 0）
        const entry = base + l.d;
        const dataRva = buf.readUInt32LE(entry);
        const size = buf.readUInt32LE(entry + 4);
        const off = rvaToOff(dataRva);
        typeMap.set(n.n, buf.subarray(off, off + size));
      }
    }
    byType.set(t.n, typeMap);
  }
  return byType;
}

/** 解码 RT_GROUP_ICON（GRPICONDIR）：count 个 14 字节目录项 {w,h,bpp,bytes,id} */
function decodeIconGroup(gbuf) {
  if (gbuf.length < 6 || gbuf.readUInt16LE(2) !== 1) throw new Error('RT_GROUP_ICON 数据不符（type ≠ 1）');
  const count = gbuf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 14;
    if (o + 14 > gbuf.length) throw new Error('RT_GROUP_ICON 目录被截断');
    entries.push({
      w: gbuf[o] || 256, // 目录项里 0 表示 256（与 .ico 文件同约定）
      h: gbuf[o + 1] || 256,
      bpp: gbuf.readUInt16LE(o + 6),
      bytes: gbuf.readUInt32LE(o + 8),
      id: gbuf.readUInt16LE(o + 12),
    });
  }
  return entries;
}

/** 核对 EXE 的图标资源段与 v2 app.ico 逐帧一致。问题写进 problems，返回供报告用的信息。 */
function checkExeBrandIcon(label, exePath, problems) {
  if (!fs.existsSync(exePath)) {
    problems.push(`${label}: EXE 缺失：${path.relative(ROOT, exePath)}`);
    return null;
  }
  const byType = parsePeResources(fs.readFileSync(exePath));
  const groups = byType.get(RT_GROUP_ICON) || new Map();
  const icons = byType.get(RT_ICON) || new Map();
  if (!groups.size) {
    problems.push(`${label}: EXE 没有图标组资源（RT_GROUP_ICON）—— 图标从未写进资源段`);
    return null;
  }
  // 期望帧：v2 app.ico 的帧字节哈希，按 {宽x高} 索引
  const frames = new Map(brand.icoFrames(fs.readFileSync(APP_ICO)).map((f) => [`${f.w}x${f.h}`, f]));
  const matchedGroups = [];
  const groupSummaries = [];
  for (const [gid, gbuf] of groups) {
    let entries;
    try {
      entries = decodeIconGroup(gbuf);
    } catch (e) {
      problems.push(`${label}: 图标组 #${gid} 解析失败：${e.message}`);
      return { gid, matched: false };
    }
    let okCount = 0;
    const bad = [];
    for (const e of entries) {
      const blob = icons.get(e.id);
      const f = frames.get(`${e.w}x${e.h}`);
      if (blob && f && blob.length === e.bytes && blob.length === f.data.length && sha256(blob) === f.hash) okCount++;
      else bad.push(`${e.w}x${e.h}@${e.bpp}${blob ? '' : '(缺 RT_ICON)'}`);
    }
    const complete = okCount === entries.length && entries.length === frames.size
      && entries.every((e) => frames.has(`${e.w}x${e.h}`));
    if (complete) matchedGroups.push(gid);
    groupSummaries.push(`#${gid}:${okCount}/${entries.length} 帧一致${bad.length ? `（不符：${bad.join(', ')}）` : ''}`);
  }
  if (!matchedGroups.length) {
    problems.push(`${label}: 没有任何图标组与 v2 app.ico 逐帧一致（${groupSummaries.join('; ')}）`
      + ` —— 期望帧档：${[...frames.keys()].join('/')}`);
    return { matched: false };
  }
  return { matched: true, groups: [...groups.keys()], matchedGroups, frames: frames.size, detail: groupSummaries.join('; ') };
}

/** 提取 RT_VERSION 字符串集（粗提取：整段按 UTF-16LE 解码），核对产品版本可追溯（V15）。 */
function checkExeVersion(label, exePath, version, problems) {
  const byType = parsePeResources(fs.readFileSync(exePath));
  const versions = byType.get(RT_VERSION) || new Map();
  if (!versions.size) {
    problems.push(`${label}: EXE 没有版本资源（RT_VERSION）—— 无法追溯产品版本`);
    return;
  }
  const text = [...versions.values()].map((b) => b.toString('utf16le')).join('');
  if (!text.includes(version)) {
    problems.push(`${label}: EXE 版本资源里找不到 ${version}（版本资源与 release-version.json 脱节）`);
  }
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

/** 把"包内相对路径 → Buffer"与当前源码逐字节比对。
 *  FIN-09：文本按内容比，二进制全部按 SHA-256 比（此前只查存在 —— 会放过"包里是旧图"）。 */
function compareTree(label, map, problems) {
  let checked = 0;
  for (const rel of sourceFiles()) {
    const packed = map.get(rel);
    if (packed === undefined) { problems.push(`${label}: 包里缺少 ${rel}`); continue; }
    const src = fs.readFileSync(path.join(ROOT, rel));
    if (!TEXT_EXT.has(path.extname(rel))) {
      if (sha256(packed) !== sha256(src)) {
        problems.push(`${label}: ${rel} 与当前源码不一致（二进制 SHA-256 不符，包里是旧版本）`);
      }
      checked++;
      continue;
    }
    if (norm(packed.toString('utf8')) !== norm(src.toString('utf8'))) {
      problems.push(`${label}: ${rel} 与当前源码不一致（包里是旧版本）`);
    }
    checked++;
  }
  return { checked, binary: 0, files: map.size };
}

// ---------- APK 品牌资源包侧校验（FIN-09） ----------
/** 源 res 路径 → APK 内 res 路径。aapt2 会把带限定符的目录补上 `-v4`
 *  （如 mipmap-xxxhdpi → res/mipmap-xxxhdpi-v4），无限定符的保持原名。 */
function apkResCandidates(prod) {
  const rel = prod.slice(brand.ANDROID_RES.length + 1); // mipmap-xxxhdpi/ic_launcher.png
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel);
  const cands = [`res/${dir}/${base}`];
  if (dir.includes('-')) cands.push(`res/${dir}-v4/${base}`);
  return cands;
}

/** APK 内品牌 PNG 与 v2 派生期望值比对。先比字节；不等（aapt2 重编码/重压缩）则比像素。
 *  像素比对方法：包内 PNG 仍是标准 PNG，用 brand-v2-lib 零依赖解码出 RGBA 逐字节比。 */
function verifyApkBrandRes(allEntries, problems) {
  const byName = new Map(allEntries.map((e) => [e.name, e.data]));
  const list = brand.MAPPING.filter((m) => m.prod.startsWith(`${brand.ANDROID_RES}/`)
    && (m.kind === 'png-copy' || m.kind === 'round' || m.kind === 'splash'));
  let byte = 0;
  let pixel = 0;
  for (const m of list) {
    const cand = apkResCandidates(m.prod).map((c) => [c, byName.get(c)]);
    const hit = cand.find(([, d]) => d !== undefined);
    if (!hit) {
      problems.push(`APK: 包里缺少品牌资源 ${m.prod}（候选 ${cand.map(([c]) => c).join(' / ')}）`);
      continue;
    }
    let expected;
    try {
      expected = require('./check-brand-assets.js').expectedBytes(m);
    } catch (e) {
      problems.push(`APK: ${m.prod} 期望值派生失败：${e.message}`);
      continue;
    }
    const actual = hit[1];
    if (sha256(actual) === sha256(expected)) { byte++; continue; }
    // 字节不等：aapt2 可能重编码。像素级复核（同尺寸 + RGBA 数据一致才算同源）。
    try {
      const a = brand.toRgba(brand.decodePng(expected));
      const b = brand.toRgba(brand.decodePng(actual));
      if (a.width === b.width && a.height === b.height && a.data.equals(b.data)) { pixel++; continue; }
      problems.push(`APK: ${hit[0]} 像素与 v2 派生不一致（${a.width}x${a.height} vs ${b.width}x${b.height}）—— 包里不是当前品牌资产`);
    } catch (e) {
      problems.push(`APK: ${hit[0]} 无法按内容核对（${e.message}）；字节 SHA-256 也不等 —— 按失败处理`);
    }
  }
  const xmlCount = brand.MAPPING.filter((m) => m.prod.startsWith(`${brand.ANDROID_RES}/`)
    && (m.kind === 'color' || m.kind === 'adaptive-xml')).length;
  return { brandTotal: list.length, byte, pixel, xmlCount };
}

function verifyApk(apkPath) {
  const problems = [];
  const all = readZip(apkPath);
  const entries = all.filter((e) => e.name.startsWith(APK_PREFIX));
  if (!entries.length) problems.push(`APK: 包里没有 ${APK_PREFIX} 下的服务端文件（打包结构变了？）`);
  const map = new Map(entries.map((e) => [e.name.slice(APK_PREFIX.length), e.data]));
  const tree = compareTree('APK', map, problems);
  const brandInfo = verifyApkBrandRes(all, problems);
  return { ...tree, brandInfo, problems };
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
  const tree = compareTree('WIN', map, problems);
  // FIN-09：node.exe 是这个包里唯一的 EXE —— 控制台窗口/任务栏/资源管理器显示的图标
  // 来自它的资源段。这里实检 .rsrc，不是"文件存在"。
  const exeInfo = map.has('node.exe')
    ? checkExeBrandIcon('WIN', path.join(dir, 'node.exe'), problems)
    : null;
  return { ...tree, exeInfo, problems };
}

/** DESKTOP：Electron portable 单文件 EXE（NSIS 壳）。
 *  壳内 payload 是 NSIS 压缩（零依赖无法解包），但 NSIS 打包的输入
 *  desktop/dist/win-unpacked/resources/** 与壳内内容一致（electron-builder 先组目录再压缩）。
 *  AC-05：对 win-unpacked 的 server 载荷做与目录包同级的**内容核对**（web/src/server.js），
 *  并解析 app.asar 校验 main.js；再核对外壳图标与版本资源。 */
function verifyDesktop(exePath) {
  const problems = [];
  const buf = fs.readFileSync(exePath);
  const exeInfo = checkExeBrandIcon('DESKTOP', exePath, problems);
  checkExeVersion('DESKTOP', exePath, readVersion(), problems);

  // ---- Electron payload 内容核对（win-unpacked = NSIS 打包输入）----
  const unpacked = path.join(path.dirname(exePath), '..', 'desktop', 'dist', 'win-unpacked');
  const resDir = path.join(unpacked, 'resources');
  let checked = 0;
  if (!fs.existsSync(resDir)) {
    problems.push('DESKTOP: 找不到 win-unpacked/resources（portable 的打包输入不存在，无法核对 payload）');
    return { checked: 0, binary: 1, files: 1, bytes: buf.length, hash: sha256(buf), exeInfo, problems };
  }
  // a) asar 内 main.js：零依赖解析 asar 头，提取 main.js 与源码 desktop/main.js 比对
  const asarPath = path.join(resDir, 'app.asar');
  if (fs.existsSync(asarPath)) {
    try {
      const want = fs.readFileSync(path.join(DESKTOP_SRC, 'main.js'));
      const got = readAsarFile(asarPath, 'main.js');
      if (!got) problems.push('DESKTOP: app.asar 缺少 main.js');
      else if (!got.equals(want)) problems.push('DESKTOP: app.asar 内 main.js 与源码不一致（包里是旧版本）');
      checked++;
    } catch (e) { problems.push('DESKTOP: app.asar 解析失败 ' + e.message); }
  }
  // b) extraResources：server/web、server/src、server.js 与源码全量比对（extraResources 原样拷贝）
  const map = new Map();
  const walk = (dir, prefix) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      const rel = prefix ? prefix + '/' + f.name : f.name;
      if (f.isDirectory()) walk(full, rel);
      else { map.set(rel, fs.readFileSync(full)); checked++; }
    }
  };
  const serverDir = path.join(resDir, 'server');
  if (fs.existsSync(serverDir)) {
    // 以 server/ 为根整树映射 → 键名与 sourceFiles() 的仓内相对名（web/…、src/…、server.js）一致
    walk(serverDir, '');
    const r = compareTree('DESKTOP-payload', map, problems);
    checked = r.checked;
  } else {
    problems.push('DESKTOP: payload 缺少 server/（extraResources 未随包？）');
  }
  return { checked, binary: 1, files: checked + 1, bytes: buf.length, hash: sha256(buf), exeInfo, problems };
}

const DESKTOP_SRC = path.join(ROOT, 'desktop');

/** 零依赖 asar 文件提取（AC-05）：asar = 8 字节头 + pickle(JSON 目录) + 连续文件区 */
function readAsarFile(asarPath, innerName) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    // asar 布局：[u32=4][u32 headerSize][u32 dictSize][u32 strLen][JSON 字典][对齐填充][文件区]
    // Chromium pickle 会在 JSON 前加 8 字节前缀，因此从 headerSize 区间里找第一个 '{' 起解析
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonBuf = Buffer.alloc(headerSize);
    fs.readSync(fd, jsonBuf, 0, headerSize, 8);
    const jsonStart = jsonBuf.indexOf('{');
    if (jsonStart < 0) throw new Error('asar 头里找不到 JSON 字典');
    const jsonEnd = jsonBuf.lastIndexOf('}');
    if (jsonEnd < jsonStart) throw new Error('asar 头 JSON 不完整');
    const index = JSON.parse(jsonBuf.slice(jsonStart, jsonEnd + 1).toString('utf8'));
    const entry = index.files && index.files[innerName];
    if (!entry || !entry.size) return null;
    const offset = 8 + headerSize + Number(entry.offset);
    const out = Buffer.alloc(entry.size);
    fs.readSync(fd, out, 0, entry.size, offset);
    return out;
  } finally { fs.closeSync(fd); }
}

function report(label, target, r) {
  const where = path.relative(ROOT, target);
  const lines = [];
  if (r.problems.length) {
    console.log(`✖ ${label} ${where}：发现 ${r.problems.length} 处问题`);
    for (const p of r.problems.slice(0, 10)) console.log(`    · ${p}`);
    if (r.problems.length > 10) console.log(`    · …另有 ${r.problems.length - 10} 处`);
    return false;
  }
  if (r.hash) {
    // FIN-13：对最后一次构建的制品留档（相对路径 + 大小 + SHA-256）
    console.log(`✓ ${label} ${where}  ${(r.bytes / 1048576).toFixed(1)} MB  sha256 ${r.hash.slice(0, 16)}…`);
  } else {
    console.log(`✓ ${label} ${where}`);
  }
  if (label === 'APK' && r.brandInfo) {
    const b = r.brandInfo;
    lines.push(`品牌资源 ${b.brandTotal} 个：字节一致 ${b.byte}，像素一致 ${b.pixel}（字节不等但解码后同源），`
      + `${b.xmlCount} 个 color/adaptive-XML 已编译进 resources.arsc 不做包侧文本核对（源侧由 brand:check 覆盖）`);
  }
  if (r.exeInfo) {
    lines.push(`EXE 图标资源段：${r.exeInfo.frames} 帧与 v2 app.ico 逐帧一致（图标组 ${r.exeInfo.matchedGroups.join('/')}）`);
  }
  if (r.exeInfo === null && label !== 'DESKTOP') lines.push('EXE 图标资源段：未检（EXE 缺失）');
  for (const l of lines) console.log(`    · ${l}`);
  if (label !== 'DESKTOP') {
    console.log(`    · 与当前源码一致（比对 ${r.checked} 个文本/二进制文件，全部内容比对，0 个只查存在）`);
  }
  return true;
}

function main(argv) {
  const get = (k, d) => {
    const a = argv.find((x) => x.startsWith(`--${k}=`));
    return a ? a.slice(k.length + 3) : d;
  };
  let v;
  try {
    v = readVersion();
  } catch (e) {
    console.error(`✖ 版本来源不可用：${e.message}`);
    return 1;
  }
  const targets = [
    ['APK', get('apk', path.join(ROOT, 'release', `werewolf-ai-${v}-debug.apk`)), verifyApk],
    ['WIN', get('win', path.join(ROOT, 'release', `werewolf-ai-${v}-win-x64`)), verifyWin],
    ['DESKTOP', get('desktop', path.join(ROOT, 'release', `werewolf-ai-${v}-win-x64-portable.exe`)), verifyDesktop],
  ];
  let ok = true;
  let seen = 0;
  // AC-05：发布模式（--release 或 REQUIRE_PACKAGES=1）下必交包缺失 = 失败，
  // 不再"全部没有也 exit 0"；日常开发默认保持跳过语义
  const releaseMode = argv.includes('--release') || process.env.REQUIRE_PACKAGES === '1';
  for (const [label, target, fn] of targets) {
    if (!fs.existsSync(target)) {
      if (releaseMode) { console.log(`✖ ${label}：发布模式必交包缺失 ${path.relative(ROOT, target)}`); ok = false; continue; }
      console.log(`- ${label}：未找到 ${path.relative(ROOT, target)}（跳过）`);
      continue;
    }
    seen++;
    try { ok = report(label, target, fn(target)) && ok; } catch (e) { ok = false; console.log(`✖ ${label}：校验失败 ${e.message}`); }
  }
  if (!seen) {
    console.log('没有可校验的产物：先跑 npm run app:apk / npm run app:win / npm run app:desktop');
    return releaseMode ? 1 : 0;
  }
  return ok ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  readZip, readVersion, sourceFiles, compareTree, verifyApk, verifyWin, verifyDesktop, main,
  parsePeResources, decodeIconGroup, checkExeBrandIcon, checkExeVersion,
};
