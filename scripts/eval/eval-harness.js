#!/usr/bin/env node
/**
 * eval-harness.js — 评测 harness（P1-6）
 *
 * 做什么：按「固定种子 × 配置矩阵」批量跑对局，产出可比较的指标表，并跟基线对比做回归门禁。
 *
 * 两种模式，用途完全不同（**不要混着看**）：
 *   · 默认 mock：脚本化随机智能体，零成本、**完全确定性**。
 *     它测的是**引擎流程与规则平衡**，以及"改动有没有把流程弄坏"。
 *     指标里的投票命中率/查验命中率此时是**随机基线**，不是 AI 强弱。
 *   · --live：真实 LLM。此时投票命中率、查验命中率、悍跳存活率、token 成本、p90 延迟才反映 AI 真实水平。
 *     单 API Key = 1 并发 → 天然串行；用 --max-calls 兜住花费。
 *
 * 用法：
 *   node scripts/eval-harness.js                          # mock，2 个引擎配置 × 8 局
 *   node scripts/eval-harness.js --games=20 --json        # 只看机器可读结果
 *   node scripts/eval-harness.js --live --games=2 --max-calls=200
 *   node scripts/eval-harness.js --update-baseline        # 把本次结果写成新基线（改引擎后要看懂差异再用）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Game } = require('../../src/engine/game');
const { runGame } = require('../../src/engine/flow');
const { BOARDS } = require('../../src/engine/roles');
const { mergeRules } = require('../../src/engine/rules');
const { makeRng } = require('../../src/engine/rng');
const { makeMockAgentFactory, auditIsolation } = require('../mock-agent');
const metrics = require('./metrics');

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * 配置矩阵。`affects` 说明这条配置在哪个模式下才有意义：
 *  - engine：改规则/流程 → mock 与 live 都能测
 *  - ai：只改 AI 层行为 → mock 局绕过了 AI 层，跑它等于重复劳动
 */
const CONFIGS = {
  base: { affects: 'engine', desc: '默认规则' },
  nosheriff: { affects: 'engine', rules: { sheriff: false }, desc: '关闭警长竞选' },
  noexplode: { affects: 'engine', rules: { allowSelfExplode: false }, desc: '禁止自爆' },
  fast: { affects: 'ai', llm: { effortPolicy: 'flat', fastEffort: 'low' }, desc: '统一低思考档' },
  noreflect: { affects: 'ai', llm: { digestMinEvents: 999 }, desc: '关闭日切反思' },
  nostruct: { affects: 'ai', llm: { structuredOutput: 'off' }, desc: '关闭结构化输出' },
};

function parseArgs(argv) {
  const args = Object.fromEntries(argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] !== undefined ? m[2] : true] : [a, true];
  }));
  return {
    games: Number(args.games || 8),
    seed: Number(args.seed || 1000),
    board: args.board || 'adv12',
    live: !!args.live,
    maxCalls: args['max-calls'] ? Number(args['max-calls']) : Infinity,
    json: !!args.json,
    updateBaseline: !!args['update-baseline'],
    baseline: args.baseline || path.join(__dirname, '..', '..', 'eval', 'baseline.json'),
    report: args.report || null,
    configs: args.configs ? String(args.configs).split(',') : null,
  };
}

/** 每局一个独立种子：同一次运行内可复现，不同局之间不相关 */
const seedFor = (base, i) => (base + i * 7919) >>> 0;

/**
 * 跑一局。**依赖注入**式设计：agentFactory 可由调用方给（测试用），
 * 也可以在 live 模式下由 harness 自己按配置构造。
 */
async function runOneGame(opts) {
  const {
    id, seed, board, rules, agentFactory, stepPauseMs = 1, logger = silent,
  } = opts;
  const boardDef = BOARDS[board] || BOARDS.adv12;
  const players = Array.from({ length: Object.values(boardDef.roles).reduce((a, b) => a + b, 0) }, (_, k) => ({ name: `P${k + 1}`, isHuman: false }));
  const game = new Game({
    id, board: boardDef.roles, rules: mergeRules(rules || {}), players,
    agentFactory, stepPauseMs, logger, seed,
  });
  await runGame(game);
  const audit = auditIsolation(game);
  return { game, audit };
}

async function main() {
  const args = parseArgs(process.argv);
  const mode = args.live ? 'live' : 'mock';
  const boardDef = BOARDS[args.board] || BOARDS.adv12;
  const wanted = args.configs || Object.keys(CONFIGS);
  const configNames = wanted.filter((c) => CONFIGS[c] && (mode === 'live' || CONFIGS[c].affects === 'engine'));
  if (!configNames.length) {
    console.error(`没有可跑的配置（模式 ${mode}）。可选：${Object.keys(CONFIGS).join(', ')}`);
    process.exit(1);
  }

  // live 模式：读真实配置（含 apiKey），并把 journal 关掉 —— 评测要测真实成本，不能被缓存命中
  let llmCfg = null;
  if (mode === 'live') {
    const { createConfig } = require('../../src/config');
    const cfgFile = path.join(__dirname, '..', '..', 'config.json');
    if (!fs.existsSync(cfgFile)) {
      console.error('--live 需要 config.json（含 API Key）。先启动一次服务并在设置页填好。');
      process.exit(1);
    }
    llmCfg = createConfig(cfgFile).load().config;
    if (!llmCfg.apiKey) {
      console.error('config.json 里没有 apiKey，无法跑 --live。');
      process.exit(1);
    }
  }

  const runTag = mode === 'live' ? `L${Date.now().toString(36)}` : 'M';
  const results = [];
  const perConfig = {};
  let callsSoFar = 0;
  let aborted = false;
  const t0 = Date.now();

  for (const name of configNames) {
    const conf = CONFIGS[name];
    perConfig[name] = [];
    for (let i = 0; i < args.games && !aborted; i++) {
      if (callsSoFar >= args.maxCalls) { aborted = true; break; }
      const seed = seedFor(args.seed, i);
      const id = `eval-${name}-${args.seed}-${i}-${runTag}`;
      const rng = makeRng(seed);
      let agentFactory;
      if (mode === 'live') {
        const { makeAgentFactory } = require('../../src/ai/agent');
        agentFactory = makeAgentFactory({ ...llmCfg, ...(conf.llm || {}), journal: false }, silent, null, null);
      } else {
        agentFactory = makeMockAgentFactory(rng, { explodeRate: conf.rules && conf.rules.allowSelfExplode === false ? 0 : 0.02 });
      }
      try {
        const { game, audit } = await runOneGame({ id, seed, board: args.board, rules: conf.rules, agentFactory });
        if (!game.finished || !['good', 'wolf'].includes(game.winner)) throw new Error('未正常产生胜负');
        const m = metrics.extractGameMetrics(game, { seed, board: args.board, config: name, audit });
        perConfig[name].push(m);
        callsSoFar += m.llm.calls;
        if (!args.json) {
          process.stdout.write(`  ${name} #${i + 1}: ${game.winner === 'good' ? '好人胜' : '狼人胜'} · ${game.day}天 · 事件${m.events}${m.llm.calls ? ` · 调用${m.llm.calls}` : ''}\n`);
        }
      } catch (e) {
        console.error(`  ✗ ${name} #${i + 1} 异常：${e.message}`);
        results.push({ config: name, seed, error: e.message });
      }
    }
    if (aborted) break;
  }

  const aggregates = {};
  for (const name of Object.keys(perConfig)) {
    if (perConfig[name].length) aggregates[name] = metrics.aggregate(perConfig[name]);
  }
  const allGames = Object.values(perConfig).flat();
  const overall = metrics.aggregate(allGames);

  // ---- 输出 ----
  if (!args.json) {
    console.log('');
    console.log(`═══ 评测结果（模式 ${mode}，板子 ${boardDef.name}，每配置 ${args.games} 局，种子基准 ${args.seed}）═══`);
    const pct = (v) => (v == null ? '  -  ' : `${(v * 100).toFixed(1)}%`);
    console.log('配置'.padEnd(12) + '局数'.padStart(5) + '好人胜'.padStart(9) + '狼人胜'.padStart(9) + '均天数'.padStart(8) + '投票命中'.padStart(10) + '查验命中'.padStart(10) + '悍跳/局'.padStart(9) + '调用/局'.padStart(9) + 'p90延迟'.padStart(9));
    for (const [name, a] of Object.entries(aggregates)) {
      console.log(
        name.padEnd(12) + String(a.games).padStart(5) + pct(a.winRate.good).padStart(9) + pct(a.winRate.wolf).padStart(9)
        + String(a.avgDays).padStart(8) + pct(a.vote.hitWolfRate).padStart(10) + pct(a.seer.hitRate).padStart(10)
        + String(a.fakeClaim.perGame).padStart(9) + String(a.cost.callsPerGame).padStart(9)
        + String(a.latency.p90 == null ? '-' : `${a.latency.p90}ms`).padStart(9),
      );
    }
    console.log('');
    console.log(`隔离审计：${overall.isolationProblems === 0 ? '全部通过 ✓' : `发现 ${overall.isolationProblems} 处泄漏 ✗`}`);
    console.log(`死亡原因分布：${Object.entries(overall.deathCauses).map(([k, v]) => `${k}:${v}`).join('  ') || '(无)'}`);
    console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s${aborted ? `（已按 --max-calls=${args.maxCalls} 提前停止）` : ''}`);
    if (mode === 'mock') {
      console.log('提示：mock 局是随机策略，投票/查验命中率反映的是**随机基线**；要看 AI 真实水平请加 --live。');
    }
  }

  // ---- 基线对比 ----
  const baselinePayload = {
    generatedAt: new Date().toISOString(),
    mode,
    board: args.board,
    games: args.games,
    seed: args.seed,
    overall,
    configs: aggregates,
  };

  if (args.updateBaseline) {
    fs.mkdirSync(path.dirname(args.baseline), { recursive: true });
    fs.writeFileSync(args.baseline, JSON.stringify(baselinePayload, null, 2));
    console.log(`\n✓ 基线已更新：${path.relative(process.cwd(), args.baseline)}`);
  } else if (fs.existsSync(args.baseline)) {
    let base;
    try { base = JSON.parse(fs.readFileSync(args.baseline, 'utf8')); } catch (_) { base = null; }
    if (base && base.overall && base.mode === mode) {
      const cmp = metrics.compareBaseline(overall, base.overall);
      if (args.json) console.log(JSON.stringify({ mode, overall, configs: aggregates, baseline: cmp }, null, 2));
      console.log(`\n基线对比（${path.relative(process.cwd(), args.baseline)} @ ${base.generatedAt}）：`);
      for (const d of cmp.diffs) {
        const fmt = (v) => (typeof v === 'number' ? (Math.abs(v) < 1 ? v.toFixed(3) : String(v)) : String(v));
        console.log(`  ${d.ok ? '✓' : '✗'} ${d.path.padEnd(24)} 基线 ${fmt(d.baseline).padStart(8)} → 本次 ${fmt(d.current).padStart(8)}  Δ${d.delta > 0 ? '+' : ''}${fmt(d.delta)}`);
      }
      if (!cmp.ok) {
        console.error('\n✗ 指标超出容差 —— 若这是有意的改动，请确认原因后用 --update-baseline 更新基线。');
        process.exitCode = 1;
      } else {
        console.log('\n✓ 全部指标在容差内');
      }
    } else if (base) {
      console.log(`\n（基线是 ${base.mode} 模式生成的，本次是 ${mode} 模式，跳过对比）`);
    }
  } else {
    console.log(`\n（还没有基线文件：${path.relative(process.cwd(), args.baseline)}，可用 --update-baseline 生成）`);
  }

  if (args.report) {
    fs.mkdirSync(path.dirname(args.report), { recursive: true });
    fs.writeFileSync(args.report, JSON.stringify({ ...baselinePayload, raw: perConfig, errors: results }, null, 2));
    console.log(`报告已写入：${args.report}`);
  }
  if (args.json && !fs.existsSync(args.baseline)) console.log(JSON.stringify({ mode, overall, configs: aggregates }, null, 2));
}

if (require.main === module) {
  main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}

module.exports = { runOneGame, parseArgs, seedFor, CONFIGS, metrics };
