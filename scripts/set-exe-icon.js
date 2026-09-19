#!/usr/bin/env node
/**
 * set-exe-icon.js — 把 v2 app.ico 写进 EXE 的图标资源段（FIN-09）
 *
 * 背景：desktop/package.json 曾设 signAndEditExecutable:false（避免下载 winCodeSign），
 * 导致 EXE 的 .rsrc 从未被改写 —— BrowserWindow 的 icon 参数只管窗口，管不了
 * 资源管理器/任务栏看到的 EXE 图标。本脚本对**已构建出的 EXE**做图标资源替换，
 * 是 electron-builder 资源编辑链之外的显式兜底（也被 build-win.js 串接给 node.exe 用）。
 *
 * 方案选型（按优先级，输出里明示实际用了哪个）：
 *   (a) resedit（desktop/node_modules 自带，electron-builder 26 内置同款，纯 JS 零下载）
 *       —— 首选：离线、确定性、与 electron-builder 的资源写法同源；
 *   (b) npx rcedit（一次性下载运行）—— 仅当 (a) 不可用时尝试，需要网络；
 *   (c) 纯手工 PE .rsrc 改写 —— 不实现（(a) 在本机已验证可行，无需再养一份 PE 写入器；
 *       读取侧的零依赖 PE 解析见 verify-packages.js，用于改写后的自检）。
 *
 * 注意：对已签名 EXE（如 node.exe）改资源会使原 Authenticode 签名失效（pe-library 以
 * ignoreCert 读取，输出不带证书表）。签名与图标是两件事，本脚本不伪造签名状态。
 *
 * 用法：
 *   node scripts/set-exe-icon.js <exe路径> [ico路径]     # 默认 ico = design/brand/v2/export/app.ico
 *   或被 require：setExeIcon.applyTo(exePath, icoPath)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_ICO = path.join(ROOT, 'design', 'brand', 'v2', 'export', 'app.ico');

/** 在本仓的 node_modules 里找可 require 的 resedit（desktop 的 electron-builder 自带） */
function loadResedit() {
  for (const base of [path.join(ROOT, 'desktop', 'node_modules'), path.join(ROOT, 'node_modules')]) {
    const p = path.join(base, 'resedit', 'dist', 'index.js');
    if (fs.existsSync(p)) {
      return { mod: require(p), from: path.relative(ROOT, base) };
    }
  }
  return null;
}

/** 方案 (a)：resedit 纯 JS 改写。返回描述信息；抛错则调用方降级。 */
function applyWithResedit(exePath, icoPath) {
  const found = loadResedit();
  if (!found) throw new Error('resedit 不可用');
  const resedit = found.mod;
  const icoBuf = fs.readFileSync(icoPath);
  const iconFile = resedit.Data.IconFile.from(icoBuf);
  const exeBuf = fs.readFileSync(exePath);
  // ignoreCert：已签名二进制（node.exe）必须允许解析；改资源后原签名本就失效，输出不带证书表
  const exe = resedit.NtExecutable.from(exeBuf, { ignoreCert: true });
  const res = resedit.NtExecutableResource.from(exe);
  // 复用 EXE 里已有的图标组（id+lang）做替换；没有就新增 id=1、en-US
  const existing = resedit.Resource.IconGroupEntry.fromEntries(res.entries);
  const gid = existing.length ? Number(existing[0].id) : 1;
  const lang = existing.length ? existing[0].lang : 0x0409;
  resedit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, gid, lang, iconFile.icons.map((i) => i.data));
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  return `resedit（来自 ${found.from}）：替换图标组 #${gid} lang=${lang}，写入 ${iconFile.icons.length} 帧`;
}

/** 方案 (b)：npx 一次性 rcedit。需要网络下载，输出明示；失败抛错。 */
function applyWithNpxRcedit(exePath, icoPath) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const args = ['--yes', 'rcedit', exePath, '--set-icon', icoPath];
  execFileSync(npx, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  return `npx rcedit（一次性下载运行）：rcedit ${path.basename(exePath)} --set-icon ${path.basename(icoPath)}`;
}

/** 改写后自检：用 verify-packages 的零依赖 PE 解析器核对 RT_GROUP_ICON/RT_ICON 与 ICO 逐帧一致 */
function selfCheck(exePath, icoPath) {
  const { parsePeResources, decodeIconGroup } = require('./verify-packages.js');
  const byType = parsePeResources(fs.readFileSync(exePath));
  const groups = byType.get(14) || new Map(); // RT_GROUP_ICON
  const icons = byType.get(3) || new Map(); // RT_ICON
  if (!groups.size) throw new Error('自检失败：EXE 里没有图标组资源');
  const brand = require('./brand-v2-lib.js');
  const frames = new Map(brand.icoFrames(fs.readFileSync(icoPath)).map((f) => [`${f.w}x${f.h}`, f]));
  const crypto = require('crypto');
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  for (const [, gbuf] of groups) {
    const entries = decodeIconGroup(gbuf);
    if (entries.length !== frames.size) throw new Error(`自检失败：帧数 ${entries.length} ≠ ${frames.size}`);
    for (const e of entries) {
      const blob = icons.get(e.id);
      const f = frames.get(`${e.w}x${e.h}`);
      if (!blob || !f || sha(blob) !== f.hash) {
        throw new Error(`自检失败：帧 ${e.w}x${e.h} 与 ${path.basename(icoPath)} 不一致`);
      }
    }
  }
}

function applyTo(exePath, icoPath) {
  const ico = icoPath || DEFAULT_ICO;
  if (!fs.existsSync(ico)) throw new Error(`ICO 不存在：${ico}`);
  if (!fs.existsSync(exePath)) throw new Error(`EXE 不存在：${exePath}`);
  const attempts = [
    ['resedit', () => applyWithResedit(exePath, ico)],
    ['npx-rcedit', () => applyWithNpxRcedit(exePath, ico)],
  ];
  const errors = [];
  for (const [name, fn] of attempts) {
    try {
      const detail = fn();
      console.log(`  EXE 图标替换（${name}）：${detail}`);
      selfCheck(exePath, ico);
      console.log(`  EXE 图标自检通过：资源段与 ${path.relative(ROOT, ico)} 逐帧一致`);
      return name;
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
      console.warn(`  EXE 图标替换方案 ${name} 不可用：${e.message}`);
    }
  }
  throw new Error(`EXE 图标替换全部失败（详见上方）：\n  - ${errors.join('\n  - ')}`
    + '\n  建议：检查 desktop/node_modules/resedit 是否在位，或恢复网络后重试。');
}

if (require.main === module) {
  const [exe, ico] = process.argv.slice(2);
  if (!exe) {
    console.error('用法：node scripts/set-exe-icon.js <exe路径> [ico路径]');
    process.exit(2);
  }
  try {
    applyTo(path.resolve(exe), ico ? path.resolve(ico) : undefined);
  } catch (e) {
    console.error(`✖ ${e.message}`);
    process.exit(1);
  }
}

module.exports = { applyTo };
