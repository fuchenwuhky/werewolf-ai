#!/usr/bin/env node
/**
 * coverage-gate.js — 覆盖率门禁（零依赖）。
 *
 * 用 Node 自带的测试覆盖率（`--experimental-test-coverage`），解析 all files 行并跟阈值比较。
 * 阈值是**棘轮**：定在实测基线略下方，只拦"明显回退"，不要求为了数字去补测试。
 *
 * 实测基线（2026-09-21，全量 651 项测试）：行 94.27% / 分支 86.11% / 函数 88.19%
 * 阈值取基线下方一小截：行 92 / 分支 84 / 函数 86；另对 api.js 单文件设 85 / 75。
 *
 * 用法：node scripts/coverage-gate.js [--line=92] [--branch=84] [--funcs=86] [--report]
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 整改（审核 P2-10）：门槛对齐计划 §8.1 —— 全局 92/84/86，api.js 单文件 85/75
const DEFAULT_THRESHOLDS = { line: 92, branch: 84, funcs: 86 };
const API_THRESHOLDS = { line: 85, branch: 75 };

function argOf(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
}

/** 从覆盖率输出里解析 all files 行；不同 Node 版本列宽略有差异，按顺序取三个百分数 */
function parseCoverage(text) {
  const lines = text.split('\n').map((l) => l.replace(/^ℹ\s?/, ''));
  const all = lines.find((l) => /^all files\s*\|/.test(l));
  if (!all) return null;
  const nums = [...all.matchAll(/(\d+\.\d+)/g)].map((m) => Number(m[1]));
  if (nums.length < 3) return null;
  const [line, branch, funcs] = nums;
  // 每个文件的明细（用于指出短板）
  const perFile = [];
  for (const l of lines) {
    const m = /^\s*([\w.-]+\.js)\s*\|\s*(\d+\.\d+)\s*\|\s*(\d+\.\d+)\s*\|\s*(\d+\.\d+)\s*\|/.exec(l);
    if (m) perFile.push({ file: m[1], line: Number(m[2]), branch: Number(m[3]), funcs: Number(m[4]) });
  }
  return { line, branch, funcs, perFile };
}

const main = () => {
  const thresholds = {
    line: argOf('line', DEFAULT_THRESHOLDS.line),
    branch: argOf('branch', DEFAULT_THRESHOLDS.branch),
    funcs: argOf('funcs', DEFAULT_THRESHOLDS.funcs),
  };
  console.log('运行测试并收集覆盖率…');
  const res = spawnSync(process.execPath, ['--test', '--experimental-test-coverage'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  const cov = parseCoverage(out);
  if (!cov) {
    console.error('✖ 无法解析覆盖率输出。可能原因：Node 版本过低不支持 --experimental-test-coverage（需 18.15+ / 20+）');
    console.error(out.slice(-2000));
    process.exit(1);
  }
  // 测试本身失败了就直接失败（覆盖率再高也没意义）
  const fail = /^# fail (\d+)/m.exec(out) || /^ℹ fail (\d+)/m.exec(out);
  if (fail && Number(fail[1]) > 0) {
    console.error(`✖ 有 ${fail[1]} 项测试失败，门禁不通过`);
    process.exit(1);
  }

  const fmt = (v) => `${v.toFixed(2)}%`;
  const rows = [
    ['行覆盖率', 'line', cov.line],
    ['分支覆盖率', 'branch', cov.branch],
    ['函数覆盖率', 'funcs', cov.funcs],
  ];
  console.log('');
  let bad = 0;
  for (const [label, key, val] of rows) {
    const t = thresholds[key];
    const ok = val + 1e-9 >= t;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✖'} ${label.padEnd(6)} ${fmt(val).padStart(7)}  阈值 ${String(t).padStart(3)}%`);
  }

  // 整改（审核 P2-10）：api.js 单文件门禁（计划 §8.1：行 85 / 分支 75）
  const apiFile = (cov.perFile || []).find((f) => f.file === 'api.js');
  if (apiFile) {
    for (const [key, t] of Object.entries(API_THRESHOLDS)) {
      const val = apiFile[key];
      const ok = val + 1e-9 >= t;
      if (!ok) bad++;
      console.log(`  ${ok ? '✓' : '✖'} ${`api.js ${key === 'line' ? '行' : '分支'}`.padEnd(6)} ${fmt(val).padStart(7)}  阈值 ${String(t).padStart(3)}%`);
    }
  }

  if (process.argv.includes('--report')) {
    const weak = cov.perFile.filter((f) => f.line < 80).sort((a, b) => a.line - b.line).slice(0, 10);
    if (weak.length) {
      console.log('\n  覆盖率偏低的文件（仅供参考，不参与门禁）：');
      for (const f of weak) console.log(`    ${f.file.padEnd(18)} 行 ${fmt(f.line).padStart(7)}  分支 ${fmt(f.branch).padStart(7)}`);
    }
  }

  if (bad) {
    console.error(`\n✖ 覆盖率门禁不通过（${bad} 项低于阈值）。若是**有意**引入大量未测代码，请在本文件顶部说明后调整阈值——不要直接删断言。`);
    process.exit(1);
  }
  console.log('\n✓ 覆盖率门禁通过');
};

if (require.main === module) main();
module.exports = { parseCoverage, DEFAULT_THRESHOLDS };
