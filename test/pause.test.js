/**
 * pause.test.js — 限流/配额分类与"暂停-恢复"链路
 *
 * 设计目标：配额耗尽绝不能降级成随机票（那等于一局烂棋），必须暂停并明示原因，恢复后继续。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
// NEW-18：本文件只有最后那条 API 用例需要落盘，它自己建独占根并把清理挂在该用例的 t.after 上；
// 不再用 process.on('exit') + `WW_DATA_DIR`（saveDir 现在显式传，环境变量不再影响任何路径）。
const { makeDataDir, makeApiIn, terminateAfter } = require('./helpers-tmpdir');

const { LlmFatalError } = require('../src/errors');
const { Game } = require('../src/engine/game');
const { runGame } = require('../src/engine/flow');
const { chatCompletion, classifyFailure } = require('../src/ai/llm');
const { LlmScheduler } = require('../src/ai/scheduler');
const { makeMockAgentFactory } = require('../scripts/mock-agent');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

// ---------- 分类：瞬时限流 vs 配额耗尽 vs 套餐受限 ----------
test('错误分类：瞬时限流（1302/1305）→ 可重试，不致命', () => {
  for (const code of ['1302', '1305']) {
    const c = classifyFailure(429, JSON.stringify({ error: { code, message: '您的账户已达到速率限制' } }), null);
    assert.strictEqual(c.retryable, true, `${code} 应可重试`);
    assert.strictEqual(c.fatal, false, `${code} 不应致命`);
  }
});

test('错误分类：配额耗尽（1308/1310/1316/1317/1113）→ 致命且不重试，并解析重置时间', () => {
  for (const code of ['1308', '1310', '1316', '1317', '1113']) {
    const c = classifyFailure(429, JSON.stringify({ error: { code, message: '已达到使用上限。您的限额将在 2026-09-16 10:00:00 重置' } }), null);
    assert.strictEqual(c.fatal, true, `${code} 应致命`);
    assert.strictEqual(c.kind, 'quota', `${code} 应归类 quota`);
    assert.strictEqual(c.retryable, false, `${code} 不应重试`);
    assert.strictEqual(c.nextFlushTime, '2026-09-16 10:00:00', '应解析出重置时间');
  }
});

test('错误分类：套餐/合规（1309/1311/1313/1315）→ 致命且归类 policy', () => {
  for (const code of ['1309', '1311', '1313', '1315']) {
    const c = classifyFailure(429, JSON.stringify({ error: { code, message: '使用模式不符合公平使用策略' } }), null);
    assert.strictEqual(c.fatal, true, `${code} 应致命`);
    assert.strictEqual(c.kind, 'policy', `${code} 应归类 policy`);
  }
});

test('错误分类：鉴权失败（401/403）→ 致命 policy，而非静默降级', () => {
  for (const status of [401, 403]) {
    const c = classifyFailure(status, JSON.stringify({ error: { code: '1000', message: '身份验证失败' } }), null);
    assert.strictEqual(c.fatal, true, `HTTP ${status} 应致命`);
    assert.strictEqual(c.kind, 'policy');
  }
});

test('错误分类：无业务码的 429/5xx → 可重试；未知 4xx → 不重试且不致命', () => {
  assert.strictEqual(classifyFailure(429, '<html>gateway</html>', null).retryable, true);
  assert.strictEqual(classifyFailure(503, '', null).retryable, true);
  const bad = classifyFailure(400, JSON.stringify({ error: { message: '参数非法' } }), null);
  assert.strictEqual(bad.retryable, false);
  assert.strictEqual(bad.fatal, false, '普通参数错误不该暂停整局');
});

test('错误分类：尊重 Retry-After 头', () => {
  const headers = { get: (k) => (k.toLowerCase() === 'retry-after' ? '7' : null) };
  const c = classifyFailure(429, JSON.stringify({ error: { code: '1302' } }), headers);
  assert.strictEqual(c.retryAfterMs, 7000);
});

// ---------- llm 层：配额错误不重试，直接抛 LlmFatalError ----------
test('llm：配额耗尽立即抛 LlmFatalError，绝不重试', async () => {
  const origFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return {
      ok: false, status: 429,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error: { code: '1308', message: '已达到 5 小时的使用上限。您的限额将在 18:00 重置' } }),
    };
  };
  try {
    const s = new LlmScheduler();
    await assert.rejects(
      () => chatCompletion({ baseUrl: 'http://x', apiKey: 'k', model: 'm', retries: 3 }, [{ role: 'user', content: 'hi' }], { scheduler: s }),
      (e) => e instanceof LlmFatalError && e.kind === 'quota' && e.code === '1308' && e.nextFlushTime === '18:00',
    );
    assert.strictEqual(calls, 1, '配额错误只应发一次请求，不得重试');
  } finally { global.fetch = origFetch; }
});

test('llm：HTTP 200 但响应体带配额业务码，同样按致命处理', async () => {
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => ({ error: { code: '1310', message: '已达到每周使用上限，您的限额将在周一 00:00 重置' } }),
  });
  try {
    const s = new LlmScheduler();
    await assert.rejects(
      () => chatCompletion({ baseUrl: 'http://x', apiKey: 'k', model: 'm', retries: 0 }, [{ role: 'user', content: 'hi' }], { scheduler: s }),
      (e) => e instanceof LlmFatalError && e.kind === 'quota',
    );
  } finally { global.fetch = origFetch; }
});

test('llm：瞬时限流仍按退避重试，最终成功后正常返回', async () => {
  const origFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls < 3) {
      return {
        ok: false, status: 429,
        headers: { get: () => '0' }, // Retry-After: 0 → 不等待
        text: async () => JSON.stringify({ error: { code: '1302', message: '速率限制' } }),
      };
    }
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"target":1}' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    };
  };
  try {
    const s = new LlmScheduler();
    const out = await chatCompletion({ baseUrl: 'http://x', apiKey: 'k', model: 'm', retries: 3 }, [{ role: 'user', content: 'hi' }], { scheduler: s });
    assert.strictEqual(out.content, '{"target":1}');
    assert.strictEqual(calls, 3, '应重试到成功');
  } finally { global.fetch = origFetch; }
});

// ---------- 引擎层：致命错误 → 暂停而非降级 ----------
function makeGame(opts = {}) {
  const board = { wolf: 3, wolfking: 1, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 };
  const players = [];
  for (let i = 0; i < 12; i++) players.push({ name: `P${i + 1}`, isHuman: !!opts.humanSeat && opts.humanSeat === i + 1 });
  return new Game({
    id: opts.id || 'pause-test', board, players, rules: opts.rules,
    agentFactory: opts.agentFactory || makeMockAgentFactory(Math.random, {}),
    stepPauseMs: 1, logger: silentLogger,
  });
}

test('引擎：AI 决策遇配额致命错误 → 抛 GamePaused、置 paused、不判负', async () => {
  const game = makeGame();
  game.deal();
  const agent = {
    decide: async () => { throw new LlmFatalError({ kind: 'quota', code: '1308', message: '额度用尽', nextFlushTime: '18:00' }); },
  };
  game._agents.set(2, agent);
  await assert.rejects(() => game.ask(2, { task: 'speech' }), (e) => e.code === 'GAME_PAUSED' && e.info.kind === 'quota');
  assert.ok(game.paused, '应记录暂停态');
  assert.strictEqual(game.paused.kind, 'quota');
  assert.strictEqual(game.paused.code, '1308');
  assert.strictEqual(game.paused.nextFlushTime, '18:00');
  assert.strictEqual(game.finished, false, '暂停不是结束');
  assert.strictEqual(game.winner, null, '暂停不判负');
  assert.ok(game.events.some((e) => e.type === 'game_paused'), '应有 game_paused 事件通知前端');
});

test('引擎：runGame 遇暂停即停止驱动，状态保留且未结束', async () => {
  const game = makeGame({ id: 'pause-run' });
  let calls = 0;
  game.agentFactory = () => ({
    async decide() {
      if (++calls >= 3) throw new LlmFatalError({ kind: 'quota', code: '1310', message: '周额度用尽' });
      return { text: '过。', target: 0 };
    },
  });
  await runGame(game);
  assert.ok(game.paused, '应停在暂停态');
  assert.strictEqual(game.finished, false);
  assert.strictEqual(game.winner, null);
  assert.ok(game._anchor, '必须有锚点供恢复');
});

test('引擎：暂停后可从锚点恢复并跑到终局（记忆与天数不回退）', async () => {
  const game = makeGame({ id: 'pause-resume' });
  let calls = 0;
  game.agentFactory = () => ({
    async decide() {
      if (++calls === 5) throw new LlmFatalError({ kind: 'quota', code: '1310', message: '周额度用尽' });
      return { text: '过。', target: 0 };
    },
  });
  await runGame(game);
  assert.ok(game.paused);
  const anchor = game._anchor;
  const pausedDay = game.day;

  const g2 = Game.fromJSON(anchor, { agentFactory: makeMockAgentFactory(Math.random, {}), logger: silentLogger, stepPauseMs: 1 });
  g2.paused = null;
  await runGame(g2, { resumeFrom: anchor.nextPhase });
  assert.ok(g2.finished, '恢复后应能跑到终局');
  assert.ok(g2.day >= pausedDay, '天数不回退');
});

// ---------- API 层：暂停态下发 + resume 路由 + 暂停中可终止 ----------
// 形参刻意叫 ctx 而不叫 t：本用例体里已经有一个 `const t = capture()`（响应盒子），别撞名
test('API：暂停对局下发 paused、可从内存锚点恢复、暂停中可终止', async (ctx) => {
  const dataDir = makeDataDir('pause');
  let api = null;
  terminateAfter(ctx, () => api, dataDir); // 先挂清理：构造抛错也不漏删刚建的独占根
  api = makeApiIn(dataDir, { config: { get: () => ({ apiKey: 'k' }), save() {} } }).api;
  const board = { wolf: 1, seer: 1, witch: 1, villager: 3 };
  // 注意：全 AI 座位——真人座位会让引擎挂起等待输入（那是正确行为），测试无法自行推进
  const players = [];
  for (let i = 0; i < 6; i++) players.push({ name: `P${i + 1}`, isHuman: false });

  // 造一个真实跑到暂停态的对局（第 3 次决策触发配额错误）
  const game = new Game({ id: 'api-pause', board, players, stepPauseMs: 1, logger: silentLogger });
  let calls = 0;
  game.agentFactory = () => ({
    async decide() {
      if (++calls >= 3) throw new LlmFatalError({ kind: 'quota', code: '1308', message: '额度用尽，18:00 重置', nextFlushTime: '18:00' });
      return { text: '过。', target: 0 };
    },
  });
  await runGame(game);
  assert.ok(game.paused, '前置条件：对局应处于暂停态');

  const entry = { game, running: false, error: null, mock: true, tokens: { player: 'ptok', god: 'gtok' } };
  api.games.set(game.id, entry);

  const capture = () => { const box = {}; box.res = { writeHead(code) { box.code = code; }, end(b) { box.body = JSON.parse(b); } }; return box; };

  // 1) /view 必须下发 paused（前端据此显示横幅）
  const v = capture();
  api.view(v.res, entry, new URLSearchParams('token=gtok&after=0'));
  assert.strictEqual(v.code, 200);
  assert.ok(v.body.paused, '/view 必须下发 paused');
  assert.strictEqual(v.body.paused.kind, 'quota');
  assert.strictEqual(v.body.paused.nextFlushTime, '18:00');
  assert.strictEqual(v.body.finished, false, '暂停 ≠ 结束');

  // 2) 令牌错误时拒绝恢复
  const bad = capture();
  api.resumePaused(bad.res, entry, { token: 'wrong' });
  assert.strictEqual(bad.code, 403);

  // 3) 正确令牌 → 从内存锚点重建并继续驱动（mock 工厂，能跑到终局）
  const ok = capture();
  api.resumePaused(ok.res, entry, { token: 'gtok' });
  assert.strictEqual(ok.code, 200);
  assert.strictEqual(ok.body.resumed, true);
  const live = api.games.get(game.id);
  assert.notStrictEqual(live.game, game, '恢复应重建对局实例（从锚点重放当前阶段）');
  assert.strictEqual(live.game.paused, null, '恢复后应解除暂停标记');
  for (let i = 0; i < 400 && !live.game.finished; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(live.game.finished, '恢复后应跑到终局');

  // 4) 暂停中的对局必须允许终止，避免永远挂着
  const g2 = new Game({ id: 'api-pause-terminate', board, players, stepPauseMs: 1, logger: silentLogger });
  g2.deal();
  g2.started = true;
  g2.markAnchor('speech');
  g2.pause({ kind: 'policy', code: '1313', message: '使用模式受限' });
  const e2 = { game: g2, running: false, error: null, mock: true, tokens: { player: 'p2', god: 'g2' } };
  api.games.set(g2.id, e2);
  const t = capture();
  await api.terminateGame(t.res, e2, { token: 'g2' });
  assert.strictEqual(t.code, 200);
  assert.strictEqual(t.body.settled, true);
  assert.strictEqual(g2.finished, true, '暂停态也必须能被终止结算');
});
