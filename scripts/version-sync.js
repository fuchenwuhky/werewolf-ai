#!/usr/bin/env node
/**
 * version-sync.js — FIN-11 版本单一来源
 *
 * 唯一权威：release-version.json（productVersion + androidVersionCode）。
 * 派生同步点：根 package.json、app/package.json、desktop/package.json、
 * package-lock.json（根两处）、app/android/app/build.gradle（versionName/Code）。
 * Android versionCode 独立单调递增；schemaVersion/exportVersion/SW 缓存代次
 * 是独立概念，不随产品版本机械联动（计划书 §14-3）。
 *
 * 用法：
 *   node scripts/version-sync.js           校验模式：不一致 → 非零退出（CI 用）
 *   node scripts/version-sync.js --fix     同步模式：以 release-version.json 为准写回
 *
 * 注意：下一个对外版本号由发布负责人修改 release-version.json 决定，
 * 本脚本只负责"多个声明点一致"，不决定版本号本身（计划书 §14-4）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'release-version.json');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function main() {
  const fix = process.argv.includes('--fix');
  if (!fs.existsSync(SRC)) {
    console.error(`[version] 缺少权威版本文件：${SRC}`);
    process.exit(1);
  }
  const rel = readJson(SRC);
  const version = rel.productVersion;
  const code = rel.androidVersionCode;
  if (!version || !Number.isInteger(code)) {
    console.error('[version] release-version.json 需要 productVersion(string) 与 androidVersionCode(int)');
    process.exit(1);
  }

  const problems = [];
  const fixes = [];
  const check = (label, actual, expect, applyFix) => {
    if (actual === expect) return;
    problems.push(`${label}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expect)}`);
    if (fix && applyFix) { applyFix(); fixes.push(label); }
  };
  const writeJsonSorted = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');

  // package.json ×3
  for (const rel0 of ['package.json', 'app/package.json', 'desktop/package.json']) {
    const p = path.join(ROOT, rel0);
    const j = readJson(p);
    check(`${rel0} version`, j.version, version, () => { j.version = version; writeJsonSorted(p, j); });
  }

  // package-lock.json（根两处）
  const lockPath = path.join(ROOT, 'package-lock.json');
  const lock = readJson(lockPath);
  check('package-lock version', lock.version, version, () => { lock.version = version; });
  if (lock.packages && lock.packages['']) {
    check('package-lock packages[""].version', lock.packages[''].version, version, () => { lock.packages[''].version = version; });
  }
  if (fix && (problems.some((p) => p.startsWith('package-lock')))) {
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    fixes.push('package-lock.json');
  }

  // gradle
  const gradlePath = path.join(ROOT, 'app', 'android', 'app', 'build.gradle');
  let gradle = fs.readFileSync(gradlePath, 'utf8');
  const nameM = gradle.match(/versionName\s+"([^"]+)"/);
  const codeM = gradle.match(/versionCode\s+(\d+)/);
  check('gradle versionName', nameM && nameM[1], version,
    () => { gradle = gradle.replace(/versionName\s+"[^"]+"/, `versionName "${version}"`); });
  check('gradle versionCode', codeM && Number(codeM[1]), code,
    () => { gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${code}`); });
  if (fix && problems.some((p) => p.startsWith('gradle'))) {
    fs.writeFileSync(gradlePath, gradle);
    fixes.push('build.gradle');
  }

  if (problems.length && !fix) {
    console.error('[version] 版本声明不一致（运行 `node scripts/version-sync.js --fix` 以 release-version.json 为准同步）：');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  if (fix && fixes.length) {
    console.log('[version] 已同步：' + fixes.join(', '));
  } else {
    console.log(`[version] 一致：productVersion=${version} androidVersionCode=${code}`);
  }
}

main();
