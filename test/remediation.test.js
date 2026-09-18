/**
 * remediation.test.js — 代码审核整改（docs/code-review-remediation-plan.md）的回归护栏
 *
 * 每个用例对应审核清单里的一项缺陷，文件内注释标注编号（REL-xx / SEC-xx / LOGIC-xx / UX-01）。
 * 原则：不依赖真实 LLM 服务；不写正式 saves/ 与 logs/（saveDir / 日志全部注入临时目录）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRequestHandler, decodePath } = require('../src/request-handler');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {} };

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ww-${tag}-`));
}

// ---------- REL-01：畸形 URL 不得击穿进程 ----------

test('REL-01：decodePath 对畸形转义返回 null、对正常路径原样保留', () => {
  assert.strictEqual(decodePath('/%'), null, '/% 必须判为畸形（旧实现在此抛 URIError 击穿进程）');
  assert.strictEqual(decodePath('/%zz'), null);
  assert.strictEqual(decodePath('/api/games'), '/api/games');
  assert.strictEqual(decodePath('/%E4%B8%AD%E6%96%87'), '/中文', '正常 UTF-8 路径不受影响');
});

test('REL-01（真实请求）：畸形 URL 返回 400，且进程/服务在同请求后仍可服务', async () => {
  const handled = [];
  const apiStub = { handle: async () => { handled.push(1); } };
  const serveWeb = (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('static-ok'); };
  const server = http.createServer(createRequestHandler({ api: apiStub, serveWeb, logger: silentLogger }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bad1 = await fetch(`${base}/%`);
    assert.strictEqual(bad1.status, 400, '修复前：这里直接 URIError 未捕获、整个进程退出');
    const bad2 = await fetch(`${base}/foo/%zz/bar`);
    assert.strictEqual(bad2.status, 400);
    // 进程还活着、路由还通：
    const ok = await fetch(`${base}/index.html`);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(await ok.text(), 'static-ok');
  } finally { server.close(); }
});

test('REL-01（真实请求）：手机 UA 跳转与 /m 跳转行为保持不变', async () => {
  const apiStub = { handle: async () => {} };
  const serveWeb = (req, res) => { res.writeHead(200); res.end('static'); };
  const server = http.createServer(createRequestHandler({ api: apiStub, serveWeb, logger: silentLogger }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const mobile = await fetch(`${base}/?x=1`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' }, redirect: 'manual' });
    assert.strictEqual(mobile.status, 302);
    assert.strictEqual(mobile.headers.get('location'), '/m/');
    const shortM = await fetch(`${base}/m`, { redirect: 'manual' });
    assert.strictEqual(shortM.status, 302);
    assert.strictEqual(shortM.headers.get('location'), '/m/');
    const desktop = await fetch(`${base}/?desktop=1`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' }, redirect: 'manual' });
    assert.strictEqual(desktop.status, 200, 'desktop=1 强制桌面版不跳转');
  } finally { server.close(); }
});

test('VAL-01（真实请求）：API 层抛出的"请求体过大/JSON 解析失败"映射为 413/400 而非 500', async () => {
  const apiStub = {
    handle: async (req, res, pathname) => {
      if (pathname === '/api/big') throw new Error('请求体过大');
      if (pathname === '/api/badjson') throw new Error('JSON 解析失败');
      throw new Error('其他内部错误');
    },
  };
  const serveWeb = (req, res) => { res.writeHead(200); res.end('static'); };
  const server = http.createServer(createRequestHandler({ api: apiStub, serveWeb, logger: silentLogger }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.strictEqual((await fetch(`${base}/api/big`, { method: 'POST' })).status, 413);
    assert.strictEqual((await fetch(`${base}/api/badjson`, { method: 'POST' })).status, 400);
    assert.strictEqual((await fetch(`${base}/api/other`, { method: 'POST' })).status, 500);
  } finally { server.close(); }
});

// ---------- REL-02：正常结束必须复位生命周期 ----------

test('REL-02：Mock 局正常打完后 entry.running=false，可被 TTL 清理；finished 局拒绝重开', async () => {
  const { Api } = require('../src/api');
  const { Game } = require('../src/engine/game');
  const { makeMockAgentFactory } = require('../scripts/mock-agent');
  const dir = tmpDir('rel02');
  const api = new Api({
    config: { get: () => ({ apiKey: 'k', journal: false }), save() {} },
    logger: silentLogger,
    saveDir: dir,
  });
  const board = { wolf: 1, seer: 1, witch: 1, villager: 2 };
  const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
  const g = new Game({
    id: 'rel02-finish', board, players, stepPauseMs: 1, logger: silentLogger,
    agentFactory: makeMockAgentFactory(Math.random, { explodeRate: 0 }),
  });
  g.deal();
  g.started = true;
  const entry = { game: g, running: true, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now() };
  api.games.set(g.id, entry);
  api._drive(entry);
  // 等驱动循环自然结束（Mock 局很快；给 10s 上限防挂）
  const deadline = Date.now() + 10000;
  while (!g.finished && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(g.finished, 'Mock 局应能自然打完');
  assert.strictEqual(entry.running, false, '整改前：_drive 成功路径不复位 running → 该局永远无法被 TTL/LRU 回收');

  // TTL 清理：把 lastAccess 拨老，pruneGames 应当能丢弃这局（对象已在磁盘上）
  entry.lastAccess = Date.now() - 31 * 60 * 1000;
  const dropped = api.pruneGames({ ttlMs: 30 * 60 * 1000 });
  assert.ok(dropped >= 1, '已结束的对局必须可被清理');
  assert.ok(!api.games.has('rel02-finish'));

  // 已结束的对局拒绝重新开始
  const box = { res: { writeHead(code) { box.code = code; }, end(b) { box.body = JSON.parse(b); } } };
  const entry2 = { game: g, running: false, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now() };
  api.games.set(g.id, entry2);
  api.startGame(box.res, entry2, { token: 'pt' });
  assert.strictEqual(box.code, 409, '整改前：只查 running，已结束对局可被二次 _drive');
  assert.match(box.body.error, /已结束/);
  api.games.delete(g.id);
});

// ---------- REL-03：存盘失败必须可重试 ----------

test('REL-03：写盘失败时不推进 savedStamp（保持脏），障碍清除后下一次保存真正落盘', async () => {
  const { Api } = require('../src/api');
  const { Game } = require('../src/engine/game');
  const dir = tmpDir('rel03');
  const api = new Api({
    config: { get: () => ({ apiKey: 'k', journal: false }), save() {} },
    logger: silentLogger,
    saveDir: dir,
  });
  const board = { wolf: 1, seer: 1, witch: 1, villager: 2 };
  const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
  const g = new Game({ id: 'rel03-save', board, players, stepPauseMs: 1, logger: silentLogger });
  g.deal();
  g.started = true;
  const entry = { game: g, running: false, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now() };
  api.games.set(g.id, entry);

  const file = path.join(dir, 'rel03-save.json');
  const tmp = file + '.tmp';
  // 障碍：把 tmp 路径预先占成一个目录 → writeFile 必然 EISDIR
  fs.mkdirSync(tmp);

  const first = await api.saveGame(entry, { force: true });
  assert.strictEqual(first, false, '第一次保存应失败');
  assert.strictEqual(fs.existsSync(file), false, '失败时不得留下"已保存"的假象');
  assert.strictEqual(entry.savedStamp, undefined, '整改前：savedStamp 在写盘前就被推进 → 之后周期保存永远跳过 → 数据静默丢失');

  // 清除障碍后，不强制 force：脏标记仍在，下一次保存必须真正写盘
  fs.rmdirSync(tmp);
  const second = await api.saveGame(entry);
  assert.strictEqual(second, true, '脏状态下第二次保存应真正落盘');
  assert.ok(fs.existsSync(file), '整改前：因 savedStamp 已被错误推进，这次保存会被跳过、文件永远写不出来');

  // 落盘成功后再保存（无变化）→ 脏标记生效，跳过写入
  const third = await api.saveGame(entry);
  assert.strictEqual(third, false, '没有变化时不应重复写盘');
  api.games.delete(g.id);
});
