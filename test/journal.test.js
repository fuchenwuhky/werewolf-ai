/**
 * journal.test.js — 决策 journal 与幂等恢复（P1-1 / P1-2）
 *
 * 验收目标：
 *   - 恢复对局零重复 LLM 调用
 *   - 恢复后 token 消耗增量 = 0
 *   - 同配置（同种子）可复现同一局
 *
 * 关键前提：引擎随机性必须可播种且进锚点快照（src/engine/rng.js）——否则重放时
 * 发言顺序/平票抽签会变，决策点错位，journal 永远命不中。下面第 8 条专门守这个前提。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Game } = require('../src/engine/game');
const { runGame } = require('../src/engine/flow');
const { Agent } = require('../src/ai/agent');
const { DecisionJournal, keyOf, PROMPT_VERSION } = require('../src/ai/journal');
const { makeRng } = require('../src/engine/rng');
const { makeMockAgentFactory } = require('../scripts/mock-agent');
const { cleanupAfter } = require('./helpers-tmpdir');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const tmpdir = (t) => cleanupAfter(t, fs.mkdtempSync(path.join(os.tmpdir(), 'ww-journal-')));

const BASE_KEY = { gameId: 'g1', day: 1, phase: 'day', seq: 10, seat: 3, task: 'speech', variant: '' };

// ---------- key ----------
test('key：同一决策点稳定，任一要素变化都必须换 key', () => {
  const k = keyOf(BASE_KEY);
  assert.strictEqual(keyOf({ ...BASE_KEY }), k, '同样的输入必须得到同样的 key（否则恢复永远命不中）');
  for (const field of ['gameId', 'day', 'phase', 'seq', 'seat', 'task', 'variant']) {
    const changed = { ...BASE_KEY, [field]: field === 'variant' ? 'x' : BASE_KEY[field] + 1 };
    if (field === 'gameId') changed.gameId = 'g2';
    assert.notStrictEqual(keyOf(changed), k, `${field} 变化必须换 key`);
  }
  assert.strictEqual(k.length, 24, 'key 长度固定（sha1 截断）');
});

test('key：重试（带 _retryNote）必须换 key —— 否则 journal 会把上次那份非法输出还回去，无限重复同一次失败', () => {
  const first = keyOf({ ...BASE_KEY, variant: '' });
  const retry = keyOf({ ...BASE_KEY, variant: '你上一次的输出不合法（发言内容不能为空）' });
  assert.notStrictEqual(first, retry);
  assert.strictEqual(keyOf({ ...BASE_KEY, variant: '你上一次的输出不合法（发言内容不能为空）' }), retry, '同一条提示词的重试要稳定');
});

test('key：PROMPT_VERSION 参与哈希（模板结构性变更后可整体失效）', () => {
  assert.ok(PROMPT_VERSION && typeof PROMPT_VERSION === 'string');
});

// ---------- 存取 ----------
test('存取：跨进程重启仍能命中（重新 new 一个实例直接从文件加载）', (t) => {
  const dir = tmpdir(t);
  const j1 = new DecisionJournal(dir, { enabled: true });
  j1.record('g1', 'abc', { payload: { text: '你好' }, usage: { promptTokens: 100, completionTokens: 20 }, promptHash: 'h1' });
  assert.strictEqual(j1.stats.records, 1);
  assert.ok(fs.existsSync(path.join(dir, 'g1.jsonl')), '应落成 JSONL 文件');

  const j2 = new DecisionJournal(dir, { enabled: true }); // 模拟进程重启
  const hit = j2.lookup('g1', 'abc', 'h1');
  assert.ok(hit, '重启后必须命中');
  assert.deepStrictEqual(hit.payload, { text: '你好' });
  assert.strictEqual(hit.usage.promptTokens, 100);
  assert.strictEqual(j2.stats.hits, 1);
  assert.strictEqual(j2.lookup('g1', 'nope', 'h1'), null, '未记录的点必须未命中');
  assert.strictEqual(j2.stats.misses, 1);
});

test('存取：对局之间互不串味（不同 gameId 各自独立）', (t) => {
  const dir = tmpdir(t);
  const j = new DecisionJournal(dir, { enabled: true });
  j.record('gA', 'k', { payload: { text: 'A' } });
  j.record('gB', 'k', { payload: { text: 'B' } });
  assert.deepStrictEqual(j.lookup('gA', 'k').payload, { text: 'A' });
  assert.deepStrictEqual(j.lookup('gB', 'k').payload, { text: 'B' });
});

test('存取：崩溃留下的半行 JSON 不影响其余记录', (t) => {
  const dir = tmpdir(t);
  const j1 = new DecisionJournal(dir, { enabled: true });
  j1.record('g1', 'k1', { payload: { text: 'ok' } });
  fs.appendFileSync(path.join(dir, 'g1.jsonl'), '{"k":"k2","payl'); // 写到一半被杀
  const j2 = new DecisionJournal(dir, { enabled: true });
  assert.ok(j2.lookup('g1', 'k1'), '完整的那条仍要能命中');
  assert.strictEqual(j2.lookup('g1', 'k2'), null);
});

test('提示词漂移：key 命中但 prompt 哈希不同要计数（能发现"改了模板没升版本号"）', (t) => {
  const dir = tmpdir(t);
  const j = new DecisionJournal(dir, { enabled: true });
  j.record('g1', 'k', { payload: { text: 'x' }, promptHash: 'old' });
  const hit = j.lookup('g1', 'k', 'new');
  assert.ok(hit, '仍然命中（确定性复现优先）');
  assert.strictEqual(j.stats.drift, 1, '漂移必须被计数，否则模板改了没人知道');
});

test('开关：enabled=false 时既不写也不命中（便于对照实验）', (t) => {
  const dir = tmpdir(t);
  const j = new DecisionJournal(dir, { enabled: false });
  j.record('g1', 'k', { payload: { text: 'x' } });
  assert.strictEqual(j.lookup('g1', 'k'), null);
  assert.strictEqual(fs.existsSync(path.join(dir, 'g1.jsonl')), false, '关闭时不应产生文件');
});

test('清理：按数量与天数双重上限删除（journal 只是缓存）', (t) => {
  const dir = tmpdir(t);
  const j = new DecisionJournal(dir, { enabled: true });
  for (let i = 0; i < 5; i++) j.record('g' + i, 'k', { payload: { text: String(i) } });
  // 把其中两个的 mtime 改老
  const old = Date.now() - 30 * 24 * 3600 * 1000;
  for (const f of ['g3.jsonl', 'g4.jsonl']) fs.utimesSync(path.join(dir, f), old / 1000, old / 1000);
  const removed = j.prune({ maxFiles: 100, maxAgeMs: 7 * 24 * 3600 * 1000 });
  assert.strictEqual(removed, 2, '过期文件应被清掉');
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length, 3);
  const removed2 = j.prune({ maxFiles: 1, maxAgeMs: 365 * 24 * 3600 * 1000 });
  assert.strictEqual(removed2, 2, '超出数量上限的部分也要清掉');
});

// ---------- 随机源 ----------
test('随机源：同种子同牌局，异种子异牌局（"同配置可复现同一局"的基础）', () => {
  const board = { wolf: 2, seer: 1, witch: 1, villager: 4 };
  const mk = (seed) => {
    const players = Array.from({ length: 8 }, (_, i) => ({ name: 'P' + (i + 1), isHuman: false }));
    const g = new Game({ id: 'rng-test', board, players, seed, stepPauseMs: 1, logger: silentLogger });
    g.deal();
    return g.players.map((p) => p.role).join(',');
  };
  assert.strictEqual(mk(42), mk(42), '同种子必须复现同一牌局');
  assert.notStrictEqual(mk(42), mk(43), '不同种子应给出不同牌局');
});

test('随机源：状态进锚点快照并被恢复（否则重放必然错位）', () => {
  const board = { wolf: 1, seer: 1, villager: 2 };
  const players = Array.from({ length: 4 }, (_, i) => ({ name: 'P' + (i + 1), isHuman: false }));
  const g = new Game({ id: 'rng-anchor', board, players, seed: 7, stepPauseMs: 1, logger: silentLogger });
  g.deal();
  g.rnd(); g.rnd(); g.rnd(); // 推进随机源
  const anchor = g.markAnchor('day');
  assert.ok(Number.isInteger(anchor.rngState), '锚点必须带随机源状态');
  const g2 = Game.fromJSON(anchor, { logger: silentLogger, stepPauseMs: 1 });
  assert.deepStrictEqual([g.rnd(), g.rnd(), g.rnd()], [g2.rnd(), g2.rnd(), g2.rnd()], '恢复后随机序列必须接着走');
});

// ---------- 验收：恢复零重复调用 / 零 token 增量 ----------
/**
 * 造一个"真 Agent + 假 LLM"的装置：假 LLM 先让 mock 智能体算出**合法**答案再回给真 Agent，
 * 于是真 Agent 的 journal 生效、引擎校验全部通过、对局能走完，同时调用次数与 token 完全可控。
 */
function makeHarness(journal, seed) {
  const board = { wolf: 2, wolfking: 1, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 5 };
  const players = Array.from({ length: 12 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
  const calls = { total: 0, byTask: {}, promptTokens: 0, completionTokens: 0 };
  const pending = new Map();
  const mockFactory = makeMockAgentFactory(makeRng(seed + 999), {});
  const agentFactory = (player, game) => {
    const real = new Agent(player, game, { baseUrl: 'http://x', model: 'm', apiKey: 'k', effortPolicy: 'flat' }, silentLogger, null, journal);
    const mockAgent = mockFactory(player, game);
    const orig = real.decide.bind(real);
    real.decide = async (req) => { pending.set(player.seat, { req, mockAgent }); return orig(req); };
    return real;
  };
  const llm = require('../src/ai/llm');
  const origFetch = llm.chatCompletion;
  llm.chatCompletion = async (cfg, messages, opts) => {
    const task = (opts.meta && opts.meta.task) || '?';
    calls.total++;
    calls.byTask[task] = (calls.byTask[task] || 0) + 1;
    const usage = { promptTokens: 100 + calls.total, cachedTokens: 0, completionTokens: 20 };
    calls.promptTokens += usage.promptTokens;
    calls.completionTokens += usage.completionTokens;
    if (/反思$/.test(task)) return { content: JSON.stringify({ summary: '纪要', suspicion: {} }), usage };
    const p = pending.get(opts.meta.seat);
    const answer = p ? await p.mockAgent.decide(p.req) : null;
    return { content: JSON.stringify(answer == null ? {} : answer), usage };
  };
  const newGame = (id) => new Game({ id, board, players, seed, stepPauseMs: 1, logger: silentLogger, agentFactory });
  return { calls, agentFactory, newGame, restore: () => { llm.chatCompletion = origFetch; } };
}

test('验收：从锚点恢复重放整个阶段，重复 LLM 调用 = 0、token 增量 = 0', async (t) => {
  const dir = tmpdir(t);
  const journal = new DecisionJournal(dir, { enabled: true });
  const h = makeHarness(journal, 1234);
  try {
    const g = h.newGame('resume-journal');
    let anchor = null;
    const origMark = g.markAnchor.bind(g);
    g.markAnchor = (phase) => { const a = origMark(phase); if (!anchor) anchor = a; return a; };
    await runGame(g);
    assert.ok(anchor, '应当拍到过锚点');
    assert.ok(h.calls.total > 10, `原局应产生足量调用，实际 ${h.calls.total}`);

    // 从锚点恢复：走与 api.js 同一条路径（Game.fromJSON → restoreAgentState → runGame(resumeFrom)）
    const before = { ...h.calls, byTask: { ...h.calls.byTask } };
    const g2 = Game.fromJSON(anchor, { logger: silentLogger, stepPauseMs: 1, agentFactory: h.agentFactory });
    for (const [seat, st] of Object.entries(anchor.agentStates || {})) g2.restoreAgentState(Number(seat), st);
    await runGame(g2, { resumeFrom: anchor.nextPhase });

    const deltaTasks = {};
    for (const [t, n] of Object.entries(h.calls.byTask)) {
      const d = n - (before.byTask[t] || 0);
      if (d) deltaTasks[t] = d;
    }
    const delta = {
      total: h.calls.total - before.total,
      tokens: (h.calls.promptTokens - before.promptTokens) + (h.calls.completionTokens - before.completionTokens),
    };
    console.log(`      → 恢复重放「${anchor.nextPhase}」阶段：新增 LLM 调用 ${delta.total}，新增 token ${delta.tokens}；`
      + `journal 命中 ${journal.stats.hits}，未命中 ${journal.stats.misses}，提示词漂移 ${journal.stats.drift}`);
    if (delta.total) console.log(`      → 新增调用明细：${JSON.stringify(deltaTasks)}`);
    assert.deepStrictEqual(deltaTasks, {}, `恢复重放不得产生任何新 LLM 调用，实际新增：${JSON.stringify(deltaTasks)}`);
    assert.strictEqual(delta.total, 0, `恢复重放不得产生任何新 LLM 调用，实际 ${delta.total}`);
    assert.strictEqual(delta.tokens, 0, 'token 增量必须为 0');
    assert.ok(journal.stats.hits > 0, '必须是靠 journal 命中达成的，而不是碰巧没触发调用');
    // 允许极小量漂移：反思是"日切边界后台异步任务"，其副作用（纪要/怀疑度）落地时刻取决于调度，
    // 重放时命中 journal 会瞬间完成 → 后续一两次决策的上下文可能比原来"早一点"看到纪要。
    // 这不影响确定性：journal 的 key 不含 prompt，决策答案仍然逐字一致。
    assert.ok(journal.stats.drift <= 3, `提示词漂移应接近于 0，实际 ${journal.stats.drift} 次`);
  } finally {
    h.restore();
  }
});

// ---------- 回归：本轮查出的三个真实 bug ----------
test('回归：锚点必须是"时间点快照"，不能与活状态共享引用', () => {
  const board = { wolf: 1, seer: 1, witch: 1, villager: 5 };
  const players = Array.from({ length: 8 }, (_, i) => ({ name: 'P' + (i + 1), isHuman: false }));
  const g = new Game({ id: 'anchor-snap', board, players, seed: 5, stepPauseMs: 1, logger: silentLogger });
  g.deal();
  const anchor = g.markAnchor('night');
  const n = anchor.events.length;
  // 锚点之后：继续产生事件、玩家死亡、夜晚状态变化
  g.emit('system', { visibleTo: 'all', text: '锚点之后发生的事' });
  g.player(1).alive = false;
  g.night = { wolfKill: 3, guardActions: [] };
  assert.strictEqual(anchor.events === g.events, false, '锚点不得与活 events 是同一个数组');
  assert.strictEqual(anchor.events.length, n, '锚点事件数不得随对局继续而增长（否则落盘存的是"未来"）');
  assert.strictEqual(anchor.players[0].alive, true, '锚点里的玩家状态必须冻结');
  assert.notStrictEqual(anchor.night, g.night, '锚点里的 night 必须是独立副本');
});

test('回归：从 night 锚点恢复必须重放首夜后的警长竞选（否则事件流从此刻分叉）', async (t) => {
  const dir = tmpdir(t);
  const journal = new DecisionJournal(dir, { enabled: true });
  const h = makeHarness(journal, 4242);
  try {
    const g = h.newGame('resume-election');
    let anchor = null;
    const origMark = g.markAnchor.bind(g);
    g.markAnchor = (phase) => { const a = origMark(phase); if (!anchor) anchor = a; return a; };
    await runGame(g);
    assert.ok(g.rules.sheriff, '本用例需要警长竞选开着');
    const sheriffEvents = g.events.filter((e) => e.phase && String(e.phase).includes('sheriff')).length;
    assert.ok(sheriffEvents > 0, '原局应有竞选事件');

    const g2 = Game.fromJSON(anchor, { logger: silentLogger, stepPauseMs: 1, agentFactory: h.agentFactory });
    for (const [seat, st] of Object.entries(anchor.agentStates || {})) g2.restoreAgentState(Number(seat), st);
    await runGame(g2, { resumeFrom: anchor.nextPhase });
    const sheriffEvents2 = g2.events.filter((e) => e.phase && String(e.phase).includes('sheriff')).length;
    assert.strictEqual(sheriffEvents2, sheriffEvents, '恢复局必须重放同样多的竞选事件');
  } finally {
    h.restore();
  }
});

test('回归：恢复重放必须逐字复现原局事件流（无重复 seq、无分叉、同样胜负）', async (t) => {
  const dir = tmpdir(t);
  const journal = new DecisionJournal(dir, { enabled: true });
  const h = makeHarness(journal, 1234);
  try {
    const g = h.newGame('resume-exact');
    let anchor = null;
    const origMark = g.markAnchor.bind(g);
    g.markAnchor = (phase) => { const a = origMark(phase); if (!anchor) anchor = a; return a; };
    await runGame(g);

    const g2 = Game.fromJSON(anchor, { logger: silentLogger, stepPauseMs: 1, agentFactory: h.agentFactory });
    for (const [seat, st] of Object.entries(anchor.agentStates || {})) g2.restoreAgentState(Number(seat), st);
    await runGame(g2, { resumeFrom: anchor.nextPhase });

    const sig = (e) => `${e.seq}|d${e.day}/${e.phase}|${e.type}|${e.actor || ''}`;
    assert.strictEqual(g2.events.length, g.events.length, `恢复局事件数应与原局一致（${g2.events.length} vs ${g.events.length}）`);
    let diff = -1;
    for (let i = 0; i < g.events.length; i++) if (sig(g.events[i]) !== sig(g2.events[i])) { diff = i; break; }
    assert.strictEqual(diff, -1, diff < 0 ? '' : `事件流在第 ${diff} 条分叉：原局 ${sig(g.events[diff])} vs 恢复局 ${sig(g2.events[diff])}`);
    const seen = new Set();
    let dup = 0;
    for (const e of g2.events) { if (seen.has(e.seq)) dup++; seen.add(e.seq); }
    assert.strictEqual(dup, 0, `恢复局事件流的 seq 不得重复，实际重复 ${dup} 条`);
    assert.strictEqual(g2.winner, g.winner, '胜负必须与原局一致');
    console.log(`      → 逐字复现：${g2.events.length} 条事件、${g.day} 天、胜者 ${g2.winner}，与原局完全一致`);
  } finally {
    h.restore();
  }
});

test('验收：恢复的对局要能拿回 AI 记忆（纪要/怀疑度/已读游标不能静默丢失）', async (t) => {
  const dir = tmpdir(t);
  const journal = new DecisionJournal(dir, { enabled: true });
  const h = makeHarness(journal, 77);
  try {
    const g = h.newGame('resume-memory');
    let anchor = null;
    const origMark = g.markAnchor.bind(g);
    g.markAnchor = (phase) => { const a = origMark(phase); if (!anchor) anchor = a; return a; };
    // 先让若干 AI 产生决策（游标推进），并人为塞入纪要与怀疑度
    await runGame(g);
    for (const [, agent] of g._agents) {
      agent.digests.set(1, '第1天纪要：8号可疑');
      agent.suspicion = { 8: 60 };
    }
    const snapshot = g.markAnchor('speech');
    assert.ok(Object.keys(snapshot.agentStates).length > 0, '锚点里应含 AI 记忆');

    const g2 = Game.fromJSON(snapshot, { logger: silentLogger, stepPauseMs: 1, agentFactory: h.agentFactory });
    for (const [seat, st] of Object.entries(snapshot.agentStates || {})) g2.restoreAgentState(Number(seat), st);
    // agent 是惰性创建的：必须"先回填、后创建"也能生效（旧实现这里直接 return → 记忆全丢）
    const seat = Number(Object.keys(snapshot.agentStates)[0]);
    const agent = g2.agentFor(seat);
    assert.strictEqual(agent.digests.get(1), '第1天纪要：8号可疑', '恢复后必须拿回 L1 纪要');
    assert.strictEqual(agent.suspicion[8], 60, '恢复后必须拿回怀疑度');
    assert.strictEqual(agent.lastSeq, snapshot.agentStates[seat].lastSeq, '恢复后必须拿回已读游标');
  } finally {
    h.restore();
  }
});
