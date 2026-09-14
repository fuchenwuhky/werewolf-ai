/**
 * simulate.js — mock 智能体批量模拟对局（无需 API key）
 * 用途：验证引擎闭环无死锁、胜负判定、事件隔离审计、统计天数分布。
 * 用法：node scripts/simulate.js [--n=50] [--seed=123] [--rules=JSON]
 */
'use strict';
const { Game } = require('../src/engine/game');
const { runGame } = require('../src/engine/flow');
const { makeMockAgentFactory, auditIsolation } = require('./mock-agent');
const { BOARDS } = require('../src/engine/roles');
const { mergeRules } = require('../src/engine/rules');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] !== undefined ? m[2] : true] : [a, true];
}));
const N = Number(args.n || 30);
const silent = { debug() {}, info() {}, warn() {}, error() {} };

// 简易可重置随机数（mulberry32）
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const results = { good: 0, wolf: 0, fail: 0, days: [], audits: [] };

async function main() {
  console.log(`开始模拟 ${N} 局（板子：${BOARDS.adv12.name}）...`);
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const rnd = mulberry32((Number(args.seed) || Date.now()) + i * 7919);
    const rules = mergeRules(args.rules ? JSON.parse(args.rules) : {});
    const players = Array.from({ length: 12 }, (_, k) => ({ name: `AI${k + 1}`, isHuman: false }));
    const game = new Game({
      id: `sim-${i}`, board: BOARDS.adv12.roles, rules, players,
      agentFactory: makeMockAgentFactory(rnd, { explodeRate: 0.02 }),
      stepPauseMs: 1,
      logger: silent,
    });
    try {
      await runGame(game);
      if (!game.finished || !['good', 'wolf'].includes(game.winner)) throw new Error('未正常产生胜负');
      results[game.winner]++;
      results.days.push(game.day);
      const problems = auditIsolation(game);
      if (problems.length) { results.audits.push(`第${i}局: ${problems.join('; ')}`); }
    } catch (e) {
      results.fail++;
      console.error(`✗ 第${i}局异常：`, e.stack || e.message || e);
    }
  }
  const days = results.days.sort((a, b) => a - b);
  const avg = days.length ? (days.reduce((a, b) => a + b, 0) / days.length).toFixed(1) : '-';
  console.log('———————— 统计 ————————');
  console.log(`好人胜 ${results.good} / 狼人胜 ${results.wolf} / 异常 ${results.fail}`);
  console.log(`天数：平均 ${avg}，中位 ${days[Math.floor(days.length / 2)] ?? '-'}，最长 ${days[days.length - 1] ?? '-'}，最短 ${days[0] ?? '-'}`);
  console.log(`隔离审计：${results.audits.length ? '发现问题\n' + results.audits.join('\n') : '全部通过 ✓'}`);
  console.log(`耗时 ${(Date.now() - t0) / 1000}s`);
  if (results.fail || results.audits.length) process.exitCode = 1;
}

main();
