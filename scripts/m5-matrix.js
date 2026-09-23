#!/usr/bin/env node
/**
 * m5-matrix.js —— M5「断线/恢复」专项矩阵：把**既有**的仓内测试按域收敛成一份可复跑对账。
 *
 * 为什么是"收敛"而不是"再写一批新用例"：guidance §5 :192 明确"修复须有失败先例，但不能只新增
 * 更多服务端/纯函数测试"；而 :186 要求 M5/M6 交出"专项矩阵"。仓内这些域其实早已有真实覆盖
 * （SSE 续传、离线恢复、连接状态降级、死连接重试、超时降档、离线页 CSP），散在各处、没人一眼看得全，
 * 于是这里做的是：逐域调用既有文件 → 汇总逐项读数 → 明确退出码。**不新增测试、不改判据。**
 *
 * 用法：
 *   node scripts/m5-matrix.js                 # 跑全部域
 *   MATRIX_ONLY=SSE node scripts/m5-matrix.js # 只跑某一域（域名为下面的 name）
 *
 * 环境变量：
 *   MATRIX_ONLY   只跑指定域
 *   NODE_BIN      node 可执行文件（默认当前进程）
 *
 * 退出码：0 = 全部域通过；1 = 有域失败（每域都打印 pass/fail 实测数，不做"看起来还行"的判断）。
 */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NODE = process.env.NODE_BIN || process.execPath;

const DOMAINS = [
  { name: 'SSE 断线续传', files: ['test/sse.test.js'], why: '重连带 Last-Event-ID 必须续传、不重发已渲染事件' },
  { name: '离线→恢复在线', files: ['test/sw-offline-reconnect.test.js'], why: '重连后拿新资源、刷新缓存、导航恢复；/api/ 不代理不落盘' },
  { name: '连接状态与降级恢复', files: ['test/connection-state.test.js', 'test/decision-budget.test.js'], why: '看门狗 ≥2 心跳、推送降级可恢复、退出清定时器' },
  { name: '死连接与重试', files: ['test/retry.test.js'], why: 'ECONNRESET / EPIPE / UND_ERR_SOCKET 识别为可立即重试' },
  { name: '超时降档与预算闸', files: ['test/a3-limits.test.js'], why: '超时先降档再试、单次决策总时长闸' },
  { name: '离线页与 CSP', files: ['test/offline-page.test.js'], why: '白名单 ↔ 真实响应头，离线页脚本不被 CSP 静默拦掉' },
];

function runOne(files) {
  const r = spawnSync(NODE, ['--test'].concat(files), {
    cwd: ROOT, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024,
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const num = (k) => {
    const m = new RegExp('^\\u2139 ' + k + ' (\\d+)$', 'm').exec(out);
    return m ? Number(m[1]) : null;
  };
  return { code: r.status, tests: num('tests'), pass: num('pass'), fail: num('fail'), out };
}

function main() {
  const only = process.env.MATRIX_ONLY || '';
  const list = only ? DOMAINS.filter((d) => d.name === only) : DOMAINS;
  if (!list.length) {
    console.error('没有匹配的域：' + only);
    process.exit(1);
  }
  const rows = [];
  for (const d of list) {
    const r = runOne(d.files);
    const ok = r.code === 0 && r.fail === 0 && r.pass !== null && r.pass > 0;
    rows.push({ d, r, ok });
    console.log(`  ${ok ? '✓' : '✗'} ${d.name} — tests=${r.tests} pass=${r.pass} fail=${r.fail} EXIT=${r.code}`);
    console.log(`      ${d.why}`);
    if (!ok) {
      // 失败时把该域的原始失败行贴出来（不截断成一行的"失败"两个字）
      const bad = r.out.split('\n').filter((l) => /^\u2716|AssertionError|Error:/.test(l)).slice(0, 6);
      for (const l of bad) console.log('      ' + l.trim().slice(0, 160));
    }
  }
  const bad = rows.filter((x) => !x.ok);
  const totalPass = rows.reduce((n, x) => n + (x.r.pass || 0), 0);
  const totalFail = rows.reduce((n, x) => n + (x.r.fail || 0), 0);
  console.log(`\n矩阵结果：${rows.length - bad.length}/${rows.length} 个域通过；pass=${totalPass} fail=${totalFail}`);
  if (bad.length) {
    console.log('未通过域：' + bad.map((x) => x.d.name).join('；'));
    process.exit(1);
  }
  process.exit(0);
}

main();
