#!/usr/bin/env node
/**
 * playtest.js — 由我扮演人类玩家的对局跑器（P3/P4 用）。
 *
 * 为什么用 API 驱动而不是逐个点界面：
 *   我要"扮演玩家"的是**决策**（说什么、投谁、刀谁、用不用药），而不是把 20 多种任务面板
 *   各点一遍。逐面板点击是纯负担，且极易假失败（选择器一改就红）。真实浏览器里的
 *   **UI 断言**（恢复卡片详情、空刀拦截、降级横幅、断网重连、手机端）留在
 *   scripts/ui-check.js —— 那里已有真实鼠标事件、断网模拟与截图设施。
 *   本脚本负责：真实对局、按策略出招、记录每一步的等待与实际提交内容。
 *
 * 用法（默认打本机 3211 测试实例，与正式 3210 无关）：
 *   node scripts/playtest.js --mock                      # 免费：验证跑器与流程
 *   node scripts/playtest.js --board=quick10             # 真实 API（会消耗额度）
 *   node scripts/playtest.js --board=adv12 --seed=2026 --max-minutes=45
 *   node scripts/playtest.js --mock --human-seat=5       # 指定我的座位
 *
 * 产物：logs/playtest/<gameId>.json（逐步决策 + 时间线），stdout 打摘要。
 * 安全：遇配额暂停/对局结束/超时即停；不写正式数据目录（请把实例指到临时目录）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const arg = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
  if (m) arg[m[1]] = m[2] === undefined ? true : m[2];
}
const PORT = Number(arg.port || 3211);
const BASE = `http://127.0.0.1:${PORT}`;
const BOARD = arg.board || 'quick10';
const MOCK = !!arg.mock;
const SEED = arg.seed ? Number(arg.seed) : Math.floor(Math.random() * 1e9);
const MAX_MINUTES = Number(arg['max-minutes'] || 60);
const MAX_DECISIONS = Number(arg['max-decisions'] || 600);
const OUT_DIR = path.join(__dirname, '..', 'logs', 'playtest');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 确定性随机（可复现：同一 seed 同一打法） */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rand = rng(SEED ^ 0x9e3779b9);
const pick = (arr) => (arr && arr.length ? arr[Math.floor(rand() * arr.length)] : null);

const SPEECH_LINES = [
  '我是好人，先过，听听后面怎么说。',
  '昨天夜里没什么动静，我倾向先听预言家报验人。',
  '我觉得前面那位发言有点飘，先记一笔。',
  '我暂不表态，等投票前再说。',
  '这轮我想压一个位置，理由是他一直在跟票不表态。',
  '我认下的好人是 1 号，理由是他发言有具体指向。',
];

async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch (_) { /* 允许空响应 */ }
  return { code: r.status, body: j };
}

/** 按当前待办任务决定"我会怎么做"（模拟真人：有跟票、有空过、有乱投） */
function decide(pending, view) {
  const p = pending || {};
  const seats = (p.candidates || []).slice();
  const task = p.task;
  if (['speech', 'pk_speech', 'lastwords', 'sheriff_speech', 'wolf_say'].includes(task)) {
    const text = pick(SPEECH_LINES);
    if (task === 'sheriff_speech') return { payload: { text, withdraw: false }, why: '上警发言，不退水' };
    return { payload: { text }, why: `发言：${text.slice(0, 12)}…` };
  }
  if (task === 'wolf_chat') return { payload: { text: pick(['今晚刀 4 号？', '我看 7 号像神，先刀他。', '别刀 1 号，留着背锅。']) }, why: '狼聊' };
  if (task === 'explode_check') return { payload: { explode: false }, why: '不自爆' };
  if (task === 'witch') {
    const ex = p.extra || {};
    if (ex.canAntidote && rand() < 0.75) return { payload: { antidote: true, poison: 0 }, why: `用解药救 ${ex.killTarget}` };
    if (ex.poisonTargets && ex.poisonTargets.length && rand() < 0.35) return { payload: { antidote: false, poison: pick(ex.poisonTargets) }, why: '用毒药' };
    return { payload: { antidote: false, poison: 0 }, why: '今夜不用药' };
  }
  // sheriff_run 的 payload 是 {run:BOOL}（schemas.js 已核实）——漏掉它人类回合会一直卡在校验失败
  if (task === 'sheriff_run') {
    const run = rand() < 0.5;
    return { payload: { run }, why: run ? '上警竞选' : '不上警' };
  }
  if (seats.length) {
    const allowNone = !!p.allowNone;
    if (allowNone && rand() < 0.15) return { payload: { target: 0 }, why: '选择"空"' };
    const t = pick(seats);
    return { payload: { target: t }, why: `${task} → ${t} 号` };
  }
  return { payload: {}, why: '无候选，空提交（预期会被校验拦住）' };
}

async function view(gameId, token) {
  const r = await api('GET', `/api/games/${gameId}/view?token=${token}&after=0`);
  return r.body || {};
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const me = { decisions: [], banners: [], errors: [], startedAt: Date.now() };
  // 人数从板子定义取，别硬编码：引擎会校验"玩家数与板子人数一致"（实测 12 人配 quick10 直接被拒）
  const { BOARDS } = require('../src/engine/roles');
  const boardDef = BOARDS[BOARD] || BOARDS.adv12;
  const seats = Object.values(boardDef.roles).reduce((a, n) => a + n, 0);
  const humanIdx = Math.max(0, Math.min(seats - 1, Number(arg['human-seat'] || 1) - 1));
  const players = Array.from({ length: seats }, (_, k) => ({ name: k === humanIdx ? '我（人类）' : `AI-${k + 1}`, isHuman: k === humanIdx }));
  const created = await api('POST', '/api/games', { boardId: BOARD, mock: MOCK, seed: SEED, players });
  if (created.code !== 200) {
    process.stdout.write(`✗ 创建对局失败：${JSON.stringify(created.body)}\n`);
    process.exit(1);
  }
  const { gameId, playerToken: token, mySeat } = created.body;
  process.stdout.write(`=== playtest：${BOARD} ${MOCK ? '（Mock 试玩，不消耗额度）' : '（真实 API，会消耗额度）'} seed=${SEED} 我的座位=${mySeat} 局号=${gameId} ===\n`);
  await api('POST', `/api/games/${gameId}/start`, { token });

  const deadline = Date.now() + MAX_MINUTES * 60000;
  let lastTask = null;
  while (Date.now() < deadline && me.decisions.length < MAX_DECISIONS) {
    const v = await view(gameId, token);
    if (v.finished) { me.ended = { finished: true, winner: v.winner, winReason: v.winReason }; break; }
    if (v.paused) {
      me.ended = { paused: v.paused };
      process.stdout.write(`⚠ 对局被暂停：${JSON.stringify(v.paused).slice(0, 140)}\n`);
      break;
    }
    const pending = v.pending;
    if (!pending || !pending.task) { await sleep(1200); continue; }
    if (pending.task === lastTask && me.decisions.length && Date.now() - me.decisions[me.decisions.length - 1].at < 300) { await sleep(800); continue; }
    const t0 = Date.now();
    const { payload, why } = decide(pending, v);
    const res = await api('POST', `/api/games/${gameId}/action`, { token, payload });
    lastTask = pending.task;
    const rec = { at: Date.now(), day: v.day, phase: v.phase, task: pending.task, payload, why, code: res.code, waitMs: Date.now() - t0, error: res.code === 200 ? null : (res.body && res.body.error) || '未知错误' };
    me.decisions.push(rec);
    if (res.code !== 200) {
      me.errors.push(rec);
      process.stdout.write(`  ✗ 第 ${me.decisions.length} 步 ${pending.task} 提交被拒：${rec.error}\n`);
    } else {
      process.stdout.write(`  ✓ ${String(v.day).padStart(2)}天/${String(v.phase).padEnd(5)} ${String(pending.task).padEnd(15)} ${why.slice(0, 34)}\n`);
    }
    // 连续被拒就停：真实额度下不能靠重试撞运气（也避免跑器自己变成死循环）
    if (me.errors.length >= 5) { me.ended = { aborted: '连续提交被拒 5 次，已停止以免空转' }; break; }
    await sleep(400);
  }

  const v = await view(gameId, token);
  me.ended = me.ended || { finished: !!v.finished, winner: v.winner, winReason: v.winReason, timeout: Date.now() >= deadline };
  // --terminate-at-end：跑器提前收工（例如冒烟局只想走几步）时必须把对局终止掉，
  // 否则对局会在后台继续跑，白烧额度（真 API 下这是真金白银）。
  if (arg['terminate-at-end'] && !me.ended.finished) {
    await api('POST', `/api/games/${gameId}/terminate`, { token });
    me.ended = { ...me.ended, terminatedByRunner: true };
  }
  me.gameId = gameId;
  me.seat = mySeat;
  me.mock = MOCK;
  me.board = BOARD;
  me.seed = SEED;
  me.wallMinutes = Number(((Date.now() - me.startedAt) / 60000).toFixed(1));
  const out = path.join(OUT_DIR, `${gameId}.json`);
  fs.writeFileSync(out, JSON.stringify(me, null, 2), 'utf8');

  const waits = me.decisions.map((d) => d.waitMs);
  process.stdout.write(`\n=== 结束 ===\n`);
  process.stdout.write(`我的决策 ${me.decisions.length} 次，被拒 ${me.errors.length} 次，墙钟 ${me.wallMinutes} 分钟\n`);
  process.stdout.write(`提交往返 p50=${waits.length ? waits.sort((a, b) => a - b)[Math.floor(waits.length / 2)] : 0}ms\n`);
  process.stdout.write(`结局：${JSON.stringify(me.ended).slice(0, 160)}\n`);
  process.stdout.write(`记录：${out}\n`);
  process.stdout.write(`（本局真实调用量与延迟：npm run playtest:report -- --dir=<实例日志目录>）\n`);
  process.exit(0);
})();
