#!/usr/bin/env node
/**
 * android-native-tap.js —— 真机操作的小工具（截图 / 点击 / 滑动 / 拉文件 / 读屏），
 * 一律**走 app 自己的 adb 解析方式**，不自己手拼 adb 路径（与 scripts/device-check.js 同款默认值 + ADB 环境变量覆盖）。
 *
 * 用法：
 *   node scripts/android-native-tap.js shot   <out.png>
 *   node scripts/android-native-tap.js tap    <x> <y>
 *   node scripts/android-native-tap.js swipe  <x1> <y1> <x2> <y2> [ms]
 *   node scripts/android-native-tap.js pull   <设备路径> <本地路径>
 *   node scripts/android-native-tap.js sh     <shell 命令...>
 *   node scripts/android-native-tap.js ui     <out.xml>       # uiautomator dump（看真实控件/文字）
 *
 * 关键：截图必须 `screencap -p <设备文件>` + `adb pull`，
 * 不能用 `exec-out screencap -p > file`（PowerShell 重定向会把二进制写坏，read_image 直接报 malformed）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ADB = process.env.ADB || 'D:\\android-sdk\\platform-tools\\adb.exe';
const SERIAL = process.env.SERIAL || '';

function adb(args, opts) {
  const argv = SERIAL ? ['-s', SERIAL].concat(args) : args;
  return execFileSync(ADB, argv, Object.assign({ encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }, opts || {}));
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function shot(out) {
  const tmp = '/sdcard/__wwshot.png';
  adb(['shell', 'screencap', '-p', tmp]);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  adb(['pull', tmp, path.resolve(out)]);
  adb(['shell', 'rm', tmp]);
  const b = fs.readFileSync(out);
  const ok = b.length > 8 && b[0] === 0x89 && b[1] === 0x50;
  console.log(`shot ${out} bytes=${b.length} png=${ok}`);
}

function main(argv) {
  const [op, ...rest] = argv;
  if (op === 'shot') { shot(rest[0]); return 0; }
  if (op === 'tap') {
    adb(['shell', 'input', 'tap', String(rest[0]), String(rest[1])]);
    console.log(`tap ${rest[0]},${rest[1]}`);
    return 0;
  }
  if (op === 'swipe') {
    adb(['shell', 'input', 'swipe', String(rest[0]), String(rest[1]), String(rest[2]), String(rest[3]), String(rest[4] || 300)]);
    console.log('swipe ok');
    return 0;
  }
  if (op === 'pull') {
    adb(['pull', rest[0], path.resolve(rest[1])], { stdio: 'inherit' });
    return 0;
  }
  if (op === 'sh') {
    const out = adb(['shell', rest.join(' ')]);
    process.stdout.write(out);
    return 0;
  }
  if (op === 'ui') {
    adb(['shell', 'uiautomator', 'dump', '/sdcard/__wwui.xml']);
    const out = adb(['pull', '/sdcard/__wwui.xml', path.resolve(rest[0])]);
    process.stdout.write(out);
    adb(['shell', 'rm', '/sdcard/__wwui.xml']);
    console.log(`ui dump → ${rest[0]}`);
    return 0;
  }
  console.error('用法：shot|tap|swipe|pull|sh|ui ...');
  return 1;
}

module.exports = { adb, shot, sleep };
if (require.main === module) process.exit(main(process.argv.slice(2)));
