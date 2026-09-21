/**
 * tmp-files.js — 原子写临时文件的**唯一**命名判据与启动清理（FIX-12）
 *
 * 为什么要有这个模块：判据分叉过一次，结果就是"清理写了但清不掉"。
 * 上一版的 `_cleanupStaleTmp()` 只认 `endsWith('.json.tmp')`，而真正在用的临时文件有三族：
 *
 *   A. 前缀式 `.tmp-<目标名>-<pid>-<时间戳>` —— 导入/恢复/迁移（本模块 tmpPathFor 产出的形态）；
 *   B. 后缀式 `<目标名>.tmp` —— saveGame 的存档替换（**故意保留**：test/remediation.test.js 用
 *      "把 `<存档>.tmp` 预先占成目录"做 EISDIR 故障注入，改掉这个路径会让那条故障注入失效）；
 *   C. 中缀式 `<目标名>.tmp-<pid>-<时间戳>` —— 档案仓/标注仓的历史形态（`profile.json.tmp-4242-1`：
 *      既不以 `.tmp-` 开头、也不以 `.tmp` 结尾，所以前两族判据都认不出它，残渣于是无限累积）。
 *   D. 旧迁移的 `<目标名>.migtmp` —— 只在历史残留里出现，不再产生。
 *
 * 现在三处（`src/api.js`、`src/profiles/store.js`、`src/profiles/migration.js`）与标注仓
 * 共用本模块：**新写入一律走 tmpPathFor()（A 族），清理一律走 cleanupStaleTmp() + isTmpFileName()**。
 *
 * 安全边界（为什么可以"看到就删"）：
 *   · 只扫**传入目录的顶层**，不递归 —— 清理永远不会钻进用户数据目录的深处；
 *   · 只删 `isFile()` 的常规文件（目录/符号链接一律不动）；
 *   · 有年龄门（STALE_TMP_MS）：同一份数据目录可能被第二个进程同时使用，无差别删除会把
 *     **正在写**的临时文件删掉，反而制造"写了一半的存档"；
 *   · 判据只可能是"本进程族自己写出来的名字"，碰不到 `index.json` / `profile.json` /
 *     `experiences.json` / `restore.json` / `<uuid>` 这类真实数据名。
 */
'use strict';
const fs = require('fs');
const path = require('path');

/** A 族前缀：新代码统一用它 */
const TMP_PREFIX = '.tmp-';
/** B/C/D 族后缀（历史形态，只识别、不再产生） */
const LEGACY_TMP_SUFFIXES = ['.tmp', '.migtmp'];
/** 启动清理的年龄阈值：比这个更老的临时文件才认为"上一个进程崩溃留下的" */
const STALE_TMP_MS = 10 * 60 * 1000;

/** 该文件名是不是"我们的原子写临时文件"（启动清理据此判定） */
function isTmpFileName(name) {
  const s = String(name);
  if (s.startsWith(TMP_PREFIX)) return true;                 // A 族
  if (LEGACY_TMP_SUFFIXES.some((x) => s.endsWith(x))) return true; // B/D 族
  return s.includes(TMP_PREFIX);                              // C 族（`x.json.tmp-<pid>-<ts>`）
}

/** 原子写的临时文件路径（与最终文件同目录：同目录 rename 才是原子替换） */
function tmpPathFor(finalFile, stamp = Date.now()) {
  return path.join(path.dirname(finalFile), `${TMP_PREFIX}${path.basename(finalFile)}-${process.pid}-${stamp}`);
}

/**
 * 清理一个目录**顶层**的陈旧临时文件。
 * @param {string} dir 目标目录（不递归）
 * @param {{maxAgeMs?: number, now?: number}} opts 年龄门（now 仅为测试可注入）
 * @returns {string[]} 实际删除的文件名
 */
function cleanupStaleTmp(dir, { maxAgeMs = STALE_TMP_MS, now = Date.now() } = {}) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_) { return []; } // 目录不可读/不存在：不影响启动
  const removed = [];
  for (const name of entries) {
    if (!isTmpFileName(name)) continue;
    const full = path.join(dir, name);
    let stat = null;
    try { stat = fs.statSync(full); } catch (_) { continue; }
    if (!stat.isFile()) continue; // 目录/符号链接等一律不动
    if (now - stat.mtimeMs < maxAgeMs) continue; // 新鲜：可能是别的进程正在写，留着
    try { fs.rmSync(full, { force: true }); removed.push(name); } catch (_) { /* 删不掉不影响启动 */ }
  }
  return removed;
}

module.exports = { TMP_PREFIX, LEGACY_TMP_SUFFIXES, STALE_TMP_MS, isTmpFileName, tmpPathFor, cleanupStaleTmp };
