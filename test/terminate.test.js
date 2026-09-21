/**
 * P2-c 回归：终止**进行中**的对局必须结算并落盘。
 *
 * 真实故障：客户端刷新后被"已终止的对局"当活局自动恢复，进了死局界面（桌面/移动双端复现，
 * 用户为了清场被迫逐局终止）。根因是 api.terminateGame 的**运行中**分支只调 game.terminate()，
 * 没有 finish()/落盘 —— 暂停分支是做了的 —— 于是存在"内存里 finished=true、磁盘上还是活局"的窗口，
 * 而客户端刷新时**只按存档**判断能不能继续。
 *
 * 这里钉住整条链：终止接口 → 内存终态 → 存档终态 → 列表接口不再列为可恢复。
 * 用"1 人类 + 11 AI 的 mock 局"是为了让对局稳定停在"进行中"（等待人类操作），
 * 全 AI 的 mock 局可能在我来得及终止之前就自己打完了，断言会变成看运气。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ⚠ 必须在 require('../src/api') 之前设置：SAVE_DIR 是模块级常量，加载时读 WW_DATA_DIR
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-terminate-'));
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
const makeApi = () => new Api({
  config: { get: () => ({ apiKey: 'sk-fake', baseUrl: 'http://127.0.0.1:9/v1', model: 'm', journal: false }), save() {} },
  logger: silentLogger,
  // NEW-17：显式传 saveDir（= 本文件独占 TMP_DATA/saves），不再依赖 WW_DATA_DIR 的加载顺序前提
  saveDir: path.join(TMP_DATA, 'saves'),
});

/** 造一局"人类 + AI"的 mock 对局，并等到它真的开跑 */
async function startRunningGame(api, seed) {
  const res = capture();
  const players = Array.from({ length: 12 }, (_, k) => ({ name: `P${k + 1}`, isHuman: k === 0 }));
  await api.handle(fakeReq('POST', { boardId: 'adv12', mock: true, seed, players }), res.res, '/api/games', new URLSearchParams());
  assert.strictEqual(res.code, 200, '创建对局应当成功');
  const entry = api.games.get(res.body.gameId);
  // 对局要显式启动（POST /api/games/:id/start）才会开始驱动
  const started = capture();
  await api.handle(fakeReq('POST', { token: entry.tokens.player }), started.res, `/api/games/${res.body.gameId}/start`, new URLSearchParams());
  assert.strictEqual(started.code, 200, '启动对局应当成功');
  for (let i = 0; i < 200 && !entry.game.started; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(entry.game.started, 'mock 对局应当已经启动');
  return { entry, id: res.body.gameId };
}

test('P2-c：终止进行中的对局必须结算并落盘（否则刷新后被当活局恢复）', async () => {
  const api = makeApi();
  const { entry, id } = await startRunningGame(api, 11);
  assert.strictEqual(entry.game.finished, false, '前置条件：此刻对局仍在进行中');

  const res = capture();
  await api.handle(fakeReq('POST', { token: entry.tokens.player }), res.res, `/api/games/${id}/terminate`, new URLSearchParams());
  assert.strictEqual(res.code, 200, '终止应当成功');
  assert.strictEqual(res.body.settled, true, '运行中的对局也必须走"已结算"路径（旧行为只返回 {ok:true}）');
  assert.strictEqual(entry.game.finished, true, '内存里必须是终态');

  const doc = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'saves', `${id}.json`), 'utf8'));
  // 存档结构：{ tokens, mock, game: <game.toJSON() 去掉 events>, anchor, ... }
  assert.ok(doc.game, '存档应当含 game 快照');
  assert.strictEqual(doc.game.finished, true, '存档里的终态必须落盘 —— 客户端刷新只按存档判断能否继续');

  // 列表接口：不能再被当成"可恢复的活局"
  const list = capture();
  await api.handle(fakeReq('GET'), list.res, '/api/games', new URLSearchParams());
  const row = (list.body.rows || []).find((r) => r.id === id);
  assert.ok(row, '列表里应当还有这条（存档保留）');
  assert.strictEqual(row.finished, true, '列表行必须是已结束');
  assert.strictEqual(row.resumable, false, '不能是可恢复状态，否则客户端又会自动进死局');
});

test('P2-c：重复终止不会把它重新变回可恢复（幂等）', async () => {
  const api = makeApi();
  const { entry, id } = await startRunningGame(api, 12);
  const first = capture();
  await api.handle(fakeReq('POST', { token: entry.tokens.player }), first.res, `/api/games/${id}/terminate`, new URLSearchParams());
  const second = capture();
  await api.handle(fakeReq('POST', { token: entry.tokens.player }), second.res, `/api/games/${id}/terminate`, new URLSearchParams());
  assert.strictEqual(second.code, 409, '已结束的对局再终止应当是 409（不能反转状态）');
  const doc = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'saves', `${id}.json`), 'utf8'));
  assert.strictEqual(doc.game.finished, true, '重复终止后存档必须仍是终态');
});
