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
const path = require('path');

// NEW-18：独占数据目录与清理都走 test/helpers-tmpdir.js —— 每个用例一份 dataDir，
// 清理挂在**该用例**的 t.after 上（断言失败/抛异常也照跑），删目录前先等档案迁移收尾。
// 不再用 process.on('exit')：那种写法只在进程正常退出时兜底，进程被强杀就完全失效，
// 而且它把"某个用例没清理干净"这件事藏到文件末尾、还习惯性吞掉删除错误（残留不可见）。
const { makeDataDir, savesOf, makeApiIn, terminateAfter } = require('./helpers-tmpdir');

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

/** 造一个"能创建对局"的 Api（不需要真 key：mock 局不走 LLM）；saveDir = 该用例独占根的 saves/ */
function makeApi(dataDir) {
  return makeApiIn(dataDir, {
    config: (() => { const cfg = { apiKey: 'sk-fake', baseUrl: 'http://127.0.0.1:9/v1', model: 'm', journal: false }; return { get: () => cfg, save(b) { Object.assign(cfg, b); } }; })(),
  }).api;
}

test('Mock 试玩：创建时必须把 mock 落到 entry 上（否则存档会写成 false）', async (t) => {
  const dataDir = makeDataDir('mockflag');
  let api = null;
  terminateAfter(t, () => api, dataDir); // 先挂清理：构造抛错也不漏删刚建的独占根
  api = makeApi(dataDir);
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

test('Mock 试玩：mock 标记必须落盘，且能在恢复时读回（这条链断了就会悄悄花钱）', async (t) => {
  const dataDir = makeDataDir('mockflag');
  let api = null;
  terminateAfter(t, () => api, dataDir); // 先挂清理：构造抛错也不漏删刚建的独占根
  api = makeApi(dataDir);
  const res = capture();
  await api.handle(fakeReq('POST', {
    boardId: 'adv12', mock: true, seed: 8,
    players: Array.from({ length: 12 }, (_, k) => ({ name: `P${k + 1}`, isHuman: false })),
  }), res.res, '/api/games', new URLSearchParams());
  const id = res.body.gameId;
  const entry = api.games.get(id);
  await api.saveGame(entry, { force: true });

  const doc = JSON.parse(fs.readFileSync(path.join(savesOf(dataDir), `${id}.json`), 'utf8'));
  assert.strictEqual(doc.mock, true, '存档里的 mock 必须是 true（恢复时按它决定用 Mock 还是真实 agentFactory）');

  // 恢复路径读的就是 doc.mock
  const rebuilt = api._rebuildFromAnchor({
    id, anchor: entry.game.toJSON(), mock: !!doc.mock, logger: silentLogger, tokens: entry.tokens,
  });
  assert.strictEqual(rebuilt.mock, true, '恢复出来的 entry 必须仍是试玩局');
});

test('Mock 试玩：真实对局不得被误标为 mock', async (t) => {
  const dataDir = makeDataDir('mockflag');
  let api = null;
  terminateAfter(t, () => api, dataDir); // 先挂清理：构造抛错也不漏删刚建的独占根
  api = makeApi(dataDir);
  const res = capture();
  await api.handle(fakeReq('POST', {
    boardId: 'adv12', mock: false, seed: 9,
    players: Array.from({ length: 12 }, (_, k) => ({ name: `P${k + 1}`, isHuman: k === 0 })),
  }), res.res, '/api/games', new URLSearchParams());
  assert.strictEqual(res.code, 200);
  assert.strictEqual(api.games.get(res.body.gameId).mock, false, '真实对局的 mock 必须为 false');
});

test('Mock 试玩：存档列表要带 mock 标记（便于排查"恢复后是否还走 Mock"）', async (t) => {
  const dataDir = makeDataDir('mockflag');
  let api = null;
  terminateAfter(t, () => api, dataDir); // 先挂清理：构造抛错也不漏删刚建的独占根
  api = makeApi(dataDir);
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
