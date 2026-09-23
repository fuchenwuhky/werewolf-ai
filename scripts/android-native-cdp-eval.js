#!/usr/bin/env node
/**
 * android-native-cdp-eval.js —— 从文件读一段 JS 丢给真机页面求值（避免命令行引号地狱）。
 * 用法：node scripts/android-native-cdp-eval.js <js 文件>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const file = process.argv[2];
if (!file) { console.error('用法：node scripts/android-native-cdp-eval.js <js 文件>'); process.exit(1); }
const code = fs.readFileSync(file, 'utf8');
// 包成 async IIFE：页面里可以用 await。
// 文件里如果写的是 `(async () => {...})()` 这种**表达式**（没有 return 语句），
// 直接塞进函数体会变成"没有 return 的函数"⇒ 求值结果是 undefined。
// 这里自动识别：以 `(` 开头的片段按表达式处理，其余按语句处理。
const wrapped = code.trimStart().startsWith('(')
  ? code
  : '(async()=>{' + code + '})()';
const out = execFileSync(process.execPath, [path.join(__dirname, 'android-native-cdp.js'), 'eval', wrapped], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
process.stdout.write(out);
