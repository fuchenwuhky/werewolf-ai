/**
 * mock-flag.test.js — "试玩局不得变成付费局"（P2-4 期间发现的既有缺陷）
 *
 * 真实事故：`createGame` 造 entry 时漏了 `mock: useMock`。
 * 而存档写的正是 `entry.mock`、恢复时读的也是 `doc.mock`，于是：
 *   用户勾选"Mock 试玩"→ 创建响应说 mock=true → 存档里却是 mock=false
 *   → 服务重启（或配额暂停后恢复）时按真实对局重建 → **用户以为在免费试玩，实际在调付费 API**。
 *
 * 这类 bug 不报错、不崩溃，只会悄悄花钱，所以必须有测试钉住"创建 → 落盘 → 恢复"整条链路。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ⚠ 必须在 require('../src/api') **之前**设置：SAVE_DIR 是 api.js 的模块级常量，
// 加载时读 process.env.WW_DATA_DIR。之前忘了这一步，测试把存档写进了仓库的 saves/（污染工作区）。
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-mockflag-'));
process.env.WW_DATA_DIR = TMP_DATA;
process.on('exit', () => { try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (_) { /* ignore */ } });

const { Api } = require('../src/api');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {} };

function capture() {
  const box = {};
  box.res = { writeHead(code) { box.code = code; }, end(b) { box.body = JSON.parse(b); } };
  return box;
}

const fakeReq = (method, body) => {
  const handlers = {};
  const req = { method, headers: {}, on(ev, fn) { handlers[ev] = fn; return req; }, destroy() {} };
  if (body !== undefined) setImmediate(() => { handlers.data(Buffer.from(JSON.stringify(body))); handlers.end(); });
  return req;
};

/** 造一个"能创建对局"的 Api（不需要真 key：mock 局不走 LLM）；数据目录见文件头 */
function makeApi() {
  return new Api({
    config: (() => { const cfg = { apiKey: 'sk-fake', baseUrl: 'http://127.0.0.1:9/v1', model: 'm', journal: false }; return { get: () => cfg, save(b) { Object.assign(cfg, b); } }; })(),
    logger: silentLogger,
    // NEW-17：显式传 saveDir（= 本文件独占的 TMP_DATA/saves）——不再依赖"环境变量必须在 require 之前设置"
    // 这一隐性顺序；少一个隐性前提，就少一条"哪天有人把 require 提到前面 → 写进仓库根"的路。
    saveDir: path.join(TMP_DATA, 'saves'),
  });
}

test('Mock 试玩：创建时必须把 mock 落到 entry 上（否则存档会写成 false）', async () => {
  const api = makeApi();
  const res = capture();
  await api.handle(fakeReq('POST', {
    boardId: 'adv12', mock: true, seed: 7,
    players: Array.from({ length: 12 }, (_, k) => ({ name: `P${k + 1}`, isHuman: false })),
  }), res.res, '/api/games', new URLSearchParams());

  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.mock, true, '创建响应必须说明这是试玩局');
  const entry = api.games.get(res.body.gameId);
  assert.strictEqual(entry.mock, true, 'entry.mock 必须为 true —— 存档与恢复都依赖它');
});

test('Mock 试玩：mock 标记必须落盘，且能在恢复时读回（这条链断了就会悄悄花钱）', async () => {
  const api = makeApi();
  const res = capture();
  await api.handle(fakeReq('POST', {
    boardId: 'adv12', mock: true, seed: 8,
    players: Array.from({ length: 12 }, (_, k) => ({ name: `P${k + 1}`, isHuman: false })),
  }), res.res, '/api/games', new URLSearchParams());
  const id = res.body.gameId;
  const entry = api.games.get(id);
  await api.saveGame(entry, { force: true });

  const doc = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'saves', `${id}.json`), 'utf8'));
  assert.strictEqual(doc.mock, true, '存档里的 mock 必须是 true（恢复时按它决定用 Mock 还是真实 agentFactory）');

  // 恢复路径读的就是 doc.mock
  const rebuilt = api._rebuildFromAnchor({
    id, anchor: entry.game.toJSON(), mock: !!doc.mock, logger: silentLogger, tokens: entry.tokens,
  });
  assert.strictEqual(rebuilt.mock, true, '恢复出来的 entry 必须仍是试玩局');
});

test('Mock 试玩：真实对局不得被误标为 mock', async () => {
  const api = makeApi();
  const res = capture();
  await api.handle(fakeReq('POST', {
    boardId: 'adv12', mock: false, seed: 9,
    players: Array.from({ length: 12 }, (_, k) => ({ name: `P${k + 1}`, isHuman: k === 0 })),
  }), res.res, '/api/games', new URLSearchParams());
  assert.strictEqual(res.code, 200);
  assert.strictEqual(api.games.get(res.body.gameId).mock, false, '真实对局的 mock 必须为 false');
});

test('Mock 试玩：存档列表要带 mock 标记（便于排查"恢复后是否还走 Mock"）', async () => {
  const api = makeApi();
  const res = capture();
  await api.handle(fakeReq('POST', {
    boardId: 'adv12', mock: true, seed: 10,
    players: Array.from({ length: 12 }, (_, k) => ({ name: `P${k + 1}`, isHuman: false })),
  }), res.res, '/api/games', new URLSearchParams());
  const id = res.body.gameId;
  await api.saveGame(api.games.get(id), { force: true });
  const list = capture();
  api.listSaves(list.res);
  const row = list.body.rows.find((r) => r.id === id);
  assert.ok(row, '存档列表里应有该对局');
  assert.strictEqual(row.mock, true, '列表项必须标出这是试玩局');
});
