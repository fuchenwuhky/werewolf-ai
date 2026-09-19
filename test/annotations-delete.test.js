/**
 * annotations-delete.test.js — 座位笔记撤销/清除路由（FIN-07 缺口收口）
 * DELETE /api/games/:gid/annotations?seat=N：权限矩阵同 PUT，expectedRevision 乐观并发。
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

async function call(api, method, pathname, body, host) {
  const u = new URL(pathname, 'http://localhost');
  const box = { code: null, raw: null };
  box.res = { writeHead(c) { box.code = c; }, end(b) { box.raw = b; }, setHeader() {} };
  await api.handle(stubReq({ method, headers: { host: host || 'localhost:3210' }, body }), box.res, u.pathname, u.searchParams);
  return { status: box.code, body: box.raw ? JSON.parse(box.raw) : null };
}

test('DELETE annotations：清除座位→revision 前进→409 并发→权限矩阵与坏参数', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-del-'));
  try {
    const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: dir });
    // 建档案 + Mock 内存局
    const prof = (await call(api, 'POST', '/api/profiles', { nickname: '撤销客' })).body.profile;
    const g = new Game({ id: 'del-g1', board: { wolf: 1, villager: 4 }, players: [{ name: 'P1', isHuman: true }, { name: 'P2' }, { name: 'P3' }, { name: 'P4' }, { name: 'P5' }], stepPauseMs: 1, logger: silentLogger });
    g.deal(); g.started = true;
    api.games.set(g.id, { game: g, running: false, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, ownerProfileId: prof.id, createdAt: Date.now(), lastAccess: Date.now(), review: null });

    const put1 = await call(api, 'PUT', '/api/games/del-g1/annotations', { token: 'pt', expectedRevision: 0, seats: { 2: { leaning: 'lean_wolf', note: '先记一笔' } } });
    assert.strictEqual(put1.status, 200);

    // 坏 seat
    const bad = await call(api, 'DELETE', '/api/games/del-g1/annotations?token=pt&seat=abc');
    assert.strictEqual(bad.status, 400, '非数字 seat 必须 400');
    // 无/错 token 的非管理请求（不可信 Host 头模拟外部客户端）必须 403
    const noTok = await call(api, 'DELETE', '/api/games/del-g1/annotations?seat=2', null, 'attacker.example');
    assert.strictEqual(noTok.status, 403, '非管理请求无令牌必须 403');
    const badTok = await call(api, 'DELETE', '/api/games/del-g1/annotations?token=wrong&seat=2', null, 'attacker.example');
    assert.strictEqual(badTok.status, 403, '非管理请求错令牌必须 403');
    // 过期 revision → 409
    const stale = await call(api, 'DELETE', '/api/games/del-g1/annotations?token=pt&seat=2&expectedRevision=0');
    assert.strictEqual(stale.status, 409, '过期 revision 必须 409');

    // 正确清除：PUT 返回的 revision 是 1
    const del = await call(api, 'DELETE', '/api/games/del-g1/annotations?token=pt&seat=2&expectedRevision=1');
    assert.strictEqual(del.status, 200, JSON.stringify(del.body));
    assert.strictEqual(del.body.revision, 2);
    assert.deepStrictEqual(del.body.annotations.seats, {}, '座位 2 的笔记应被清除');

    // 重复清除（幂等）：不带 expectedRevision 跳过并发检查，仍 200
    const again = await call(api, 'DELETE', '/api/games/del-g1/annotations?token=pt&seat=2');
    assert.strictEqual(again.status, 200);
    assert.deepStrictEqual(again.body.annotations.seats, {});

    // god token 也可用（动态取 revision）；管理会话路径由既有矩阵覆盖
    const get1 = await call(api, 'GET', '/api/games/del-g1/annotations?token=gt');
    const cur = get1.body.revision;
    const putGod = await call(api, 'PUT', '/api/games/del-g1/annotations', { token: 'gt', expectedRevision: cur, seats: { 3: { leaning: 'lean_good' } } });
    assert.strictEqual(putGod.status, 200);
    const delGod = await call(api, 'DELETE', '/api/games/del-g1/annotations?token=gt&seat=3&expectedRevision=' + putGod.body.revision);
    assert.strictEqual(delGod.status, 200);

    // 管理会话（本机可信 Host）无令牌可用：与 PUT 同一访问矩阵（放最后避免干扰 revision 断言）
    const mgmt = await call(api, 'DELETE', '/api/games/del-g1/annotations?seat=2');
    assert.ok([200, 404].includes(mgmt.status), '管理会话绕过令牌与 PUT 同矩阵（实际 ' + mgmt.status + '）');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
