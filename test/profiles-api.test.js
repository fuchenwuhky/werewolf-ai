/**
 * profiles-api.test.js — 档案/标注/导入路由的 API 级集成测试（DATA-01/02/PROF/NOTE）
 * 全部走 api.handle 真实分发路径（含权限矩阵与归属校验），存档注入临时目录。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const events = require('events');

const { Api } = require('../src/api');
const { Game } = require('../src/engine/game');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {}, query() { return []; } };
const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `papi-${tag}-`));

function makeApi(tag) {
  const dir = tmpDir(tag);
  const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: dir });
  return { api, dir };
}

function stubReq({ method = 'GET', headers = {}, body = null } = {}) {
  const req = new events.EventEmitter();
  req.method = method;
  req.headers = headers;
  req.socket = { remoteAddress: '127.0.0.1' };
  process.nextTick(() => {
    if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function stubRes() {
  const box = { headers: {} };
  box.res = {
    writeHead(code) { box.code = code; },
    end(b) { box.raw = b; },
    setHeader(k, v) { box.headers[k.toLowerCase()] = v; },
  };
  return box;
}

const HOST = { host: 'localhost:3210' };

async function call(api, method, pathname, body) {
  // 分离 query：与真实 server.js 的 URL 解析行为一致
  const u = new URL(pathname, 'http://localhost');
  const q = u.searchParams;
  const cleanPath = u.pathname;
  const box = stubRes();
  const req = stubReq({ method, headers: { ...HOST }, body });
  await api.handle(req, box.res, cleanPath, q);
  return { status: box.code, body: box.raw ? JSON.parse(box.raw) : null };
}

test('档案路由：创建/列表/PATCH 409/stats/games/annotations/删除 全链', async () => {
  const { api } = makeApi('crud');

  const c1 = await call(api, 'POST', '/api/profiles', { nickname: '砚舟', avatarId: 'scholar', bio: '测试' });
  assert.strictEqual(c1.status, 200);
  const pid = c1.body.profile.id;
  assert.match(pid, /^[0-9a-f-]{36}$/);

  const list = await call(api, 'GET', '/api/profiles');
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.profiles.some((p) => p.id === pid));

  const up1 = await call(api, 'PATCH', `/api/profiles/${pid}`, { expectedRevision: 1, nickname: '砚舟二号' });
  assert.strictEqual(up1.status, 200);
  const up2 = await call(api, 'PATCH', `/api/profiles/${pid}`, { expectedRevision: 1, nickname: '过期写' });
  assert.strictEqual(up2.status, 409, '过期 revision 必须 409');

  const st = await call(api, 'GET', `/api/profiles/${pid}/stats`);
  assert.strictEqual(st.status, 200);
  const gm = await call(api, 'GET', `/api/profiles/${pid}/games`);
  assert.strictEqual(gm.status, 200);
  assert.ok(Array.isArray(gm.body.rows));

  // 标注：先建一局 Mock 局并归到该档案，再走 /api/games/:gid/annotations 真实路由
  const g = new Game({ id: 'anno-g1', board: { wolf: 1, seer: 1, witch: 1, villager: 2 }, players: Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: i === 0 })), stepPauseMs: 1, logger: silentLogger });
  g.deal(); g.started = true;
  api.games.set(g.id, { game: g, running: false, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, ownerProfileId: pid, createdAt: Date.now(), lastAccess: Date.now(), review: null });

  const put1 = await call(api, 'PUT', `/api/games/anno-g1/annotations`, { token: 'pt', expectedRevision: 0, seats: { 3: { leaning: 'lean_wolf', note: '带节奏', candidateRoleIds: ['wolf'] } } });
  assert.strictEqual(put1.status, 200, `标注 PUT 失败：${JSON.stringify(put1.body)}`);
  const get1 = await call(api, 'GET', `/api/games/anno-g1/annotations?token=pt`);
  assert.strictEqual(get1.status, 200);
  assert.strictEqual(get1.body.annotations.seats[3].leaning, 'lean_wolf');

  const put2 = await call(api, 'PUT', `/api/games/anno-g1/annotations`, { token: 'pt', expectedRevision: 0, seats: { 3: { leaning: 'neutral' } } });
  assert.strictEqual(put2.status, 409, '过期 revision 必须 409');

  await call(api, 'DELETE', `/api/profiles/${pid}`);
  const gone = await call(api, 'GET', `/api/profiles/${pid}/stats`);
  assert.ok(gone.status === 404 || gone.status === 500, '已删除档案的 stats 不应 200');
});

test('导入路由：preview 校验坏包 400 / 合法包返回预览；apply 落地档案与对局', async () => {
  const { api } = makeApi('imp');
  const bad = await call(api, 'POST', '/api/profiles/import/preview', { package: { profile: {}, games: 'not-array' } });
  assert.strictEqual(bad.status, 400);

  const good = {
    manifest: { exportVersion: 1 },
    profile: { nickname: '包内档案', avatarId: 'scholar', bio: '' },
    games: [{ id: 'g-old', day: 3, finished: true, winner: 'good', mock: false, players: [{ seat: 1, isHuman: false }], events: [], board: { wolf: 1 }, rules: {} }],
  };
  const pv = await call(api, 'POST', '/api/profiles/import/preview', { package: good });
  assert.strictEqual(pv.status, 200);
  const ap = await call(api, 'POST', '/api/profiles/import', { package: good });
  assert.strictEqual(ap.status, 200);
  assert.ok(ap.body.profileId, 'apply 返回新档案 id');
  assert.ok(ap.body.gameMap['g-old'], '旧 id → 新 id 映射存在');

  const games = await call(api, 'GET', `/api/profiles/${ap.body.profileId}/games`);
  assert.strictEqual(games.status, 200);
  assert.ok(Array.isArray(games.body.rows));
});

test('导出收集：collectExportableGames 只收已结束且归属正确的对局', async () => {
  const transfer = require('../src/profiles/transfer');
  const dir = tmpDir('exp2');
  const pid = '99999999-8888-7777-6666-555555555555';
  fs.mkdirSync(dir, { recursive: true });
  const mk = (id, owner, finished) => ({ schemaVersion: 2, tokens: {}, mock: true, ownerProfileId: owner, game: { id, players: [], started: true, finished } });
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(mk('a', pid, true)));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(mk('b', 'other', true)));
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(mk('c', pid, false)));
  const games = transfer.collectExportableGames(dir, pid);
  assert.deepStrictEqual(games.map((g) => g.gameId), ['a'], '只收集该档案已结束局');
});
