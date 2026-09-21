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
 * 判据的宽窄（这是"会删文件"的谓词，每一族都要说清边界，别过度声称）：
 *   · A `startsWith('.tmp-')`：够窄。真实数据名不会以 `.tmp-` 开头（本仓的正式文件要么是
 *     `index.json`/`profile.json`/<uuid>.json/`g…json`，要么是用户昵称派生的文件名）。
 *   · B `endsWith('.tmp')`：**这一族天生无法区分** —— saveGame 的正式临时文件就叫 `<存档>.tmp`，
 *     一个恰好叫 `foo.tmp` 的真实文件与它同名同形。取舍：一律按临时文件清理（否则 B 族残渣
 *     永远清不掉）。因此**不要在受扫目录里放以 `.tmp` 结尾的正式数据文件**。
 *   · C 锚定 `/\.tmp-\d+-\d+$/`：只认历史真实形态 `<目标名>.tmp-<pid>-<时间戳>`。
 *     绝不写成 `includes('.tmp-')` —— 那会把 `report.tmp-final.docx`、`backup.tmp-2024.old`
 *     这类**用户文件**当成残渣，在启动时静默删除。
 *   · D `endsWith('.migtmp')`：够窄（旧迁移专用后缀，业务名字不会这么起）。
 *
 * 安全边界（为什么可以"看到就删"）：
 *   · 只扫**传入目录的顶层**，不递归 —— 清理永远不会钻进用户数据目录的深处；
 *   · 只删 `isFile()` 的常规文件（目录/符号链接一律不动）；
 *   · 有年龄门（STALE_TMP_MS）：同一份数据目录可能被第二个进程同时使用，无差别删除会把
 *     **正在写**的临时文件删掉，反而制造"写了一半的存档"；
 *   · A/C/D 三族判据碰不到 `index.json` / `profile.json` / `experiences.json` / `restore.json`
 *     这类真实数据名；B 族是**已记录的取舍**（见上），不在此列。
 */
'use strict';
const fs = require('fs');
const path = require('path');

/** A 族前缀：新代码统一用它 */
const TMP_PREFIX = '.tmp-';
/** B/C/D 族后缀（历史形态，只识别、不再产生；B 族的取舍见文件头注释） */
const LEGACY_TMP_SUFFIXES = ['.tmp', '.migtmp'];
/** C 族锚定形态：`<目标名>.tmp-<pid>-<时间戳>`（旧 store.js/annotations store.js 的真实命名） */
const LEGACY_MIDFIX_RE = /\.tmp-\d+-\d+$/;
/** 启动清理的年龄阈值：比这个更老的临时文件才认为"上一个进程崩溃留下的" */
const STALE_TMP_MS = 10 * 60 * 1000;

/** 该文件名是不是"我们的原子写临时文件"（启动清理据此判定；各族边界见文件头注释） */
function isTmpFileName(name) {
  const s = String(name);
  if (s.startsWith(TMP_PREFIX)) return true;                       // A 族
  if (LEGACY_TMP_SUFFIXES.some((x) => s.endsWith(x))) return true; // B/D 族
  return LEGACY_MIDFIX_RE.test(s);                                 // C 族（锚定，不是 includes）
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
