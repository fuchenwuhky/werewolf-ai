/**
 * sse.test.js — SSE 推送（P2-2）
 *
 * 这一层最容易"看着像通了其实没通"：本地浏览器没代理，缓冲与心跳问题都看不出来。
 * 所以这里起**真实 HTTP 服务**、用真实 socket 读流，逐条验证：
 *   · 鉴权照旧（token 无效必须是 403 JSON，而不是挂住一个永不返回的连接）
 *   · 有变化才推帧；没变化不推（这正是替代轮询的收益来源）
 *   · 帧格式是标准 SSE；心跳按期到达
 *   · 终局先给终局帧、再给 end；客户端断开后服务端必须清理订阅（否则内存泄漏）
 *   · **推送与轮询负载逐字段一致**（前端回退轮询时行为必须一样）
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ⚠ 必须在 require('../src/api') 之前设置：SAVE_DIR 是 api.js 的模块级常量（加载时读 WW_DATA_DIR）。
// 不设它，本文件会把测试对局写成仓库 saves/ 里的存档（用户界面里就能看到）。
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-sse-'));
process.env.WW_DATA_DIR = TMP_DATA;
process.on('exit', () => { try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (_) { /* ignore */ } });

const { Api } = require('../src/api');
const { BOARDS } = require('../src/engine/roles');

const silent = { debug() {}, info() {}, warn() {}, error() {}, error2() {} };

function tmpConfig() {
  return {
    _c: { apiKey: 'test-key', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', journal: false },
    get() { return this._c; },
    save(p) { Object.assign(this._c, p); },
  };
}

/** 起一个真实服务；返回 { url, api, close } */
async function startServer() {
  const config = tmpConfig();
  const api = new Api({ config, logger: silent });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) {
      api.handle(req, res, decodeURIComponent(u.pathname), u.searchParams).catch((e) => {
        try { res.writeHead(500); res.end(String(e.message)); } catch (_) { /* ignore */ }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    api,
    server,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => { api._streamTimer && clearInterval(api._streamTimer); server.closeAllConnections && server.closeAllConnections(); server.close(r); }),
  };
}

/** 造一局不启动驱动循环的对局（直接手动推进状态即可） */
function makeEntry(api, id = 'sse-test') {
  const players = Array.from({ length: 12 }, (_, k) => ({ name: `P${k + 1}`, isHuman: k === 0 }));
  const { Game } = require('../src/engine/game');
  const game = new Game({ id, board: BOARDS.adv12.roles, players, stepPauseMs: 0, logger: silent, seed: 1234 });
  // 分配角色：真实对局一定已发牌；终局评分（computeScores）依赖它，不分配会掩盖真实缺陷
  const deck = ['wolf', 'wolf', 'wolfking', 'wolf', 'seer', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager', 'villager'];
  game.players.forEach((p, i) => { p.role = deck[i] || 'villager'; });
  game.started = true;
  const entry = {
    game, running: false, error: null,
    tokens: { player: 'ptok', god: 'gtok' },
    createdAt: Date.now(), lastAccess: Date.now(),
  };
  api.games.set(id, entry);
  return entry;
}

/** 极简 SSE 客户端：按帧解析（event:/data:） */
function openSse(url) {
  const frames = [];
  const waiters = [];
  let buf = '';
  const ctrl = new AbortController();
  const done = (async () => {
    const res = await fetch(url, { signal: ctrl.signal });
    if (res.status !== 200) return { status: res.status, body: await res.json().catch(() => null) };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done: fin } = await reader.read();
      if (fin) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = { event: 'message', data: null, raw: chunk };
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) ev.event = line.slice(6).trim();
          else if (line.startsWith('data:')) ev.data = JSON.parse(line.slice(5).trim());
        }
        frames.push(ev);
        for (const w of [...waiters]) w(); // 不能 splice 掉全部等待者：没命中的要留给下一帧
      }
    }
    return { status: res.status };
  })().catch((e) => ({ error: e.name === 'AbortError' ? 'aborted' : e.message }));
  const waitFor = (pred, ms = 4000) => new Promise((resolve, reject) => {
    const check = () => frames.find(pred);
    const hit = check();
    if (hit) return resolve(hit);
    const drop = () => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); };
    const timer = setTimeout(() => {
      drop();
      reject(new Error(`等待事件超时；已收到 ${JSON.stringify(frames.map((f) => f.event))}`));
    }, ms);
    function w() {
      const h = check();
      if (h) { clearTimeout(timer); drop(); resolve(h); }
    }
    waiters.push(w);
    return undefined;
  });
  return { frames, waitFor, close: () => ctrl.abort(), done };
}

test('SSE：token 无效必须是 403 JSON，绝不能挂住连接', async () => {
  const s = await startServer();
  try {
    makeEntry(s.api);
    const res = await fetch(`${s.url}/api/games/sse-test/stream?token=bad&after=0`);
    assert.strictEqual(res.status, 403);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.match(body.error, /token 无效/);
  } finally { await s.close(); }
});

test('SSE：连上立刻收到首帧（标准 SSE 格式 + 正确响应头）', async () => {
  const s = await startServer();
  try {
    const entry = makeEntry(s.api);
    entry.game.emit('speech', { actor: 1, data: { context: '', text: '大家好' } });
    const res = await fetch(`${s.url}/api/games/sse-test/stream?token=gtok&after=0`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.match(res.headers.get('cache-control'), /no-cache/);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const head = new TextDecoder().decode(value);
    assert.match(head, /: stream open/, '首包应是注释帧，让客户端立刻确认已连接');
    assert.match(head, /event: view/, '紧接着应有一帧 view');
    assert.match(head, /data: \{/, 'data 必须是 JSON');
    await reader.cancel();
  } finally { await s.close(); }
});

test('SSE：只在真的变化时推帧，空转期间静默（这就是替代轮询的收益）', async () => {
  const s = await startServer();
  try {
    makeEntry(s.api);
    const c = openSse(`${s.url}/api/games/sse-test/stream?token=gtok&after=0`);
    await c.waitFor((f) => f.event === 'view');
    const n1 = c.frames.filter((f) => f.event === 'view').length;
    // 什么都不做，等若干个 tick：不应再有 view 帧（心跳是另一种事件，允许出现）
    await new Promise((r) => setTimeout(r, 1400));
    const n2 = c.frames.filter((f) => f.event === 'view').length;
    assert.strictEqual(n2, n1, `无变化时不应重复推帧（${n1} → ${n2}）`);

    // 产生一个新事件 → 应在下一拍内推出
    s.api.games.get('sse-test').game.emit('system', { visibleTo: 'all', text: '有变化了' });
    const frame = await c.waitFor((f) => f.event === 'view' && f.data.events.some((e) => e.text === '有变化了'));
    assert.ok(frame, '新事件必须被推出来');
    c.close();
    await c.done;
  } finally { await s.close(); }
});

test('SSE：增量游标不重复下发同一事件', async () => {
  const s = await startServer();
  try {
    const entry = makeEntry(s.api);
    const c = openSse(`${s.url}/api/games/sse-test/stream?token=gtok&after=0`);
    await c.waitFor((f) => f.event === 'view');
    entry.game.emit('system', { visibleTo: 'all', text: 'A' });
    await c.waitFor((f) => f.data && f.data.events && f.data.events.some((e) => e.text === 'A'));
    entry.game.emit('system', { visibleTo: 'all', text: 'B' });
    await c.waitFor((f) => f.data && f.data.events && f.data.events.some((e) => e.text === 'B'));
    c.close();
    await c.done;
    const seen = [];
    for (const f of c.frames) {
      if (f.event !== 'view' || !f.data || !f.data.events) continue;
      for (const e of f.data.events) seen.push(e.seq);
    }
    assert.strictEqual(new Set(seen).size, seen.length, `同一 seq 不得下发两次：${seen.join(',')}`);
    assert.ok(seen.length >= 2, `应收到至少 2 条事件（A、B），实际 ${seen.length}`);
  } finally { await s.close(); }
});

test('SSE：推送负载与轮询 /view 逐字段一致（前端回退轮询时行为必须相同）', async () => {
  const s = await startServer();
  try {
    const entry = makeEntry(s.api);
    entry.game.emit('speech', { actor: 1, data: { context: '', text: '内容' } });
    entry.game.role = undefined;
    const c = openSse(`${s.url}/api/games/sse-test/stream?token=gtok&after=0`);
    const frame = await c.waitFor((f) => f.event === 'view');
    c.close();
    await c.done;
    const poll = await (await fetch(`${s.url}/api/games/sse-test/view?token=gtok&after=0`)).json();
    const pushed = { ...frame.data };
    // 游标已推进到推送帧里最后一个 seq，所以轮询要按同一游标取，才是可比的两份数据
    const after = Math.max(0, ...pushed.events.map((e) => e.seq));
    const poll2 = await (await fetch(`${s.url}/api/games/sse-test/view?token=gtok&after=${after}`)).json();
    assert.deepStrictEqual(Object.keys(pushed).sort(), Object.keys(poll).sort(), '两条通道的字段集合必须一致');
    assert.deepStrictEqual(pushed.events, poll.events, '首帧事件应与同游标轮询一致');
    assert.deepStrictEqual(poll2.events, [], '游标之后的轮询不应再重复给事件');
    assert.strictEqual(pushed.gameId, poll.gameId);
    assert.strictEqual(pushed.phase, poll.phase);
    assert.deepStrictEqual(pushed.players, poll.players);
  } finally { await s.close(); }
});

test('SSE：心跳按期到达（客户端据此判断连接是否还活着）', async () => {
  const s = await startServer();
  try {
    makeEntry(s.api);
    const c = openSse(`${s.url}/api/games/sse-test/stream?token=gtok&after=0`);
    await c.waitFor((f) => f.event === 'view');
    // 心跳周期是 40 拍 × 400ms，测试里等不起 —— 直接驱动 tick 到心跳点
    for (let i = 0; i < 41; i++) s.api.tickStreams();
    const ping = await c.waitFor((f) => f.event === 'ping');
    assert.ok(ping.data.t > 0, '心跳应带时间戳');
    c.close();
    await c.done;
  } finally { await s.close(); }
});

test('SSE：终局先送终局帧再送 end，且完成后自动关流', async () => {
  const s = await startServer();
  try {
    const entry = makeEntry(s.api);
    const c = openSse(`${s.url}/api/games/sse-test/stream?token=gtok&after=0`);
    await c.waitFor((f) => f.event === 'view');
    entry.game.emit('game_over', { visibleTo: 'all', data: { winner: 'good', reason: '测试' } });
    entry.game.finished = true;
    entry.game.winner = 'good';
    // 第一拍：推终局帧；第二拍：送 end 并关流
    s.api.tickStreams();
    await c.waitFor((f) => f.event === 'view' && f.data && f.data.finished === true);
    s.api.tickStreams();
    await c.waitFor((f) => f.event === 'end');
    const done = await c.done;
    assert.strictEqual(done.status, 200);
    c.close();
  } finally { await s.close(); }
});

test('SSE：视图构造失败必须发 error 帧并关流，绝不静默卡死', async () => {
  const s = await startServer();
  try {
    const entry = makeEntry(s.api);
    const c = openSse(`${s.url}/api/games/sse-test/stream?token=gtok&after=0`);
    await c.waitFor((f) => f.event === 'view');
    // 制造一个构造失败（真实场景如：某玩家角色缺失导致终局评分抛错）
    for (const p of entry.game.players) p.role = undefined;
    entry.game.finished = true;
    s.api.tickStreams();
    const err = await c.waitFor((f) => f.event === 'error');
    assert.ok(err.data.error, 'error 帧必须带原因');
    assert.strictEqual(s.api.streams.size, 0, '出错后必须关流（否则连接永远挂着）');
    c.close();
    await c.done;
  } finally { await s.close(); }
});

test('SSE：断线重连带 Last-Event-ID 时必须续传，不重发已渲染过的事件', async () => {
  const s = await startServer();
  try {
    const entry = makeEntry(s.api);
    const first = openSse(`${s.url}/api/games/sse-test/stream?token=gtok&after=0`);
    await first.waitFor((f) => f.event === 'view');
    entry.game.emit('system', { visibleTo: 'all', text: 'A' });
    const frameA = await first.waitFor((f) => f.data && f.data.events && f.data.events.some((e) => e.text === 'A'));
    const cursor = Math.max(...frameA.data.events.map((e) => e.seq));
    first.close();
    await first.done;
    // 模拟浏览器重连：query 里的 after 还是旧的 0，但 Last-Event-ID 已是 cursor
    const res = await fetch(`${s.url}/api/games/sse-test/stream?token=gtok&after=0`, {
      headers: { 'Last-Event-ID': String(cursor) },
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    while (!text.includes('event: view')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    await reader.cancel();
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
    const payload = JSON.parse(dataLine.slice(6));
    assert.deepStrictEqual(payload.events, [], `重连后不应重发事件，实际 ${JSON.stringify(payload.events.map((e) => e.text))}`);
    assert.match(text, new RegExp(`id: ${cursor}`), '帧应带 id（浏览器据此续传）');
  } finally { await s.close(); }
});

test('SSE：空转拍不得调用 buildView（廉价指纹的价值就在这里，否则比轮询更费 CPU）', async () => {
  const s = await startServer();
  try {
    const entry = makeEntry(s.api);
    const c = openSse(`${s.url}/api/games/sse-test/stream?token=gtok&after=0`);
    await c.waitFor((f) => f.event === 'view');
    let builds = 0;
    const orig = s.api.buildView.bind(s.api);
    s.api.buildView = (...args) => { builds++; return orig(...args); };
    // 10 拍无变化：一次都不该构造视图
    for (let i = 0; i < 10; i++) s.api.tickStreams();
    assert.strictEqual(builds, 0, `空转拍不得构造视图，实际构造了 ${builds} 次`);

    // 一次真实变化：恰好构造一次，并且推出一帧
    entry.game.emit('system', { visibleTo: 'all', text: '变' });
    s.api.tickStreams();
    assert.strictEqual(builds, 1, `一次变化应只构造一次视图，实际 ${builds} 次`);
    await c.waitFor((f) => f.data && f.data.events && f.data.events.some((e) => e.text === '变'));
    // 再空转 5 拍：仍然不应该新增构造
    const before = builds;
    for (let i = 0; i < 5; i++) s.api.tickStreams();
    assert.strictEqual(builds, before, '变化之后的空转拍同样不得构造视图');
    c.close();
    await c.done;
  } finally { await s.close(); }
});

test('SSE：客户端断开后服务端必须清理订阅（否则长跑会泄漏）', async () => {
  const s = await startServer();
  try {
    makeEntry(s.api);
    const c = openSse(`${s.url}/api/games/sse-test/stream?token=gtok&after=0`);
    await c.waitFor((f) => f.event === 'view');
    assert.strictEqual(s.api.streams.get('sse-test').size, 1);
    c.close();
    await c.done;
    // 服务端收到 close 事件后应清理；给一个 tick 的时间
    for (let i = 0; i < 20 && s.api.streams.size; i++) {
      s.api.tickStreams();
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.strictEqual(s.api.streams.size, 0, '断开的订阅必须被移除');
  } finally { await s.close(); }
});

test('SSE：多订阅者各自维护游标；对局被逐出时收到 end(evicted)', async () => {
  const s = await startServer();
  try {
    const entry = makeEntry(s.api);
    entry.game.emit('system', { visibleTo: 'all', text: 'X' });
    const god = openSse(`${s.url}/api/games/sse-test/stream?token=gtok&after=0`);
    const player = openSse(`${s.url}/api/games/sse-test/stream?token=ptok&after=0`);
    await god.waitFor((f) => f.event === 'view');
    await player.waitFor((f) => f.event === 'view');
    assert.strictEqual(s.api.streams.get('sse-test').size, 2, '两个视角各一条连接');
    // 逐出：模拟 TTL 清理
    s.api.games.delete('sse-test');
    s.api.tickStreams();
    await god.waitFor((f) => f.event === 'end' && f.data.reason === 'evicted');
    await player.waitFor((f) => f.event === 'end' && f.data.reason === 'evicted');
    assert.strictEqual(s.api.streams.size, 0, '逐出后订阅应清空');
    god.close(); player.close();
    await god.done; await player.done;
  } finally { await s.close(); }
});

test('SSE：closeStreams 可一次性关闭某局所有连接（终止对局/关服路径）', async () => {
  const s = await startServer();
  try {
    makeEntry(s.api);
    const a = openSse(`${s.url}/api/games/sse-test/stream?token=gtok&after=0`);
    const b = openSse(`${s.url}/api/games/sse-test/stream?token=ptok&after=0`);
    await a.waitFor((f) => f.event === 'view');
    await b.waitFor((f) => f.event === 'view');
    s.api.closeStreams('sse-test', 'terminated');
    await a.waitFor((f) => f.event === 'end' && f.data.reason === 'terminated');
    await b.waitFor((f) => f.event === 'end' && f.data.reason === 'terminated');
    assert.strictEqual(s.api.streams.size, 0);
    a.close(); b.close();
    await a.done; await b.done;
  } finally { await s.close(); }
});
