/**
 * annotations-concurrency.test.js — AC-01 回归（验收报告 2026-09-20）
 *
 * 契约：同一笔记文件的 PUT / DELETE（含同 revision 并发）必须共用同一条串行原语；
 * 并发同 revision 时恰好一个 200、另一个 409；成功方内容与其他座位保留。
 * 旧实现：HTTP PUT 走不入队列的 putSync()，DELETE 走入队 clearSeat() —— 并发成功后丢数据。
 * 另验证：写失败后队列仍可继续工作，tmp 不污染后续事务。
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

async function call(api, method, pathname, body) {
  const u = new URL(pathname, 'http://localhost');
  const box = { code: null, raw: null };
  box.res = { writeHead(c) { box.code = c; }, end(b) { box.raw = b; }, setHeader() {} };
  await api.handle(stubReq({ method, headers: { host: 'localhost:3210' }, body }), box.res, u.pathname, u.searchParams);
  return { status: box.code, body: box.raw ? JSON.parse(box.raw) : null };
}

async function makeGame(api, dir) {
  const prof = (await call(api, 'POST', '/api/profiles', { nickname: '并发客' })).body.profile;
  const g = new Game({ id: 'ac01-' + Math.random().toString(36).slice(2, 8), board: { wolf: 1, villager: 4 }, players: [{ name: 'P1', isHuman: true }, { name: 'P2' }, { name: 'P3' }, { name: 'P4' }, { name: 'P5' }], stepPauseMs: 1, logger: silentLogger });
  g.deal(); g.started = true;
  api.games.set(g.id, { game: g, running: false, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, ownerProfileId: prof.id, createdAt: Date.now(), lastAccess: Date.now(), review: null });
  return { prof, gid: g.id };
}

test('AC-01a 并发 PUT/PUT 同 revision：恰好一个 200 一个 409，成功方内容保留', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac01a-'));
  try {
    const savesDir = path.join(dir, 'saves');
    const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: savesDir });
    const { gid } = await makeGame(api, dir);
    const seed = await call(api, 'PUT', `/api/games/${gid}/annotations`, { token: 'pt', expectedRevision: 0, seats: { 1: { leaning: 'neutral', note: '基线' } } });
    assert.strictEqual(seed.status, 200);

    const [r1, r2] = await Promise.all([
      call(api, 'PUT', `/api/games/${gid}/annotations`, { token: 'pt', expectedRevision: 1, seats: { 2: { leaning: 'lean_wolf', note: 'A写' } } }),
      call(api, 'PUT', `/api/games/${gid}/annotations`, { token: 'pt', expectedRevision: 1, seats: { 3: { leaning: 'lean_good', note: 'B写' } } }),
    ]);
    const codes = [r1.status, r2.status].sort();
    assert.deepStrictEqual(codes, [200, 409], `并发同版本必须一胜一 409（实际 ${r1.status}/${r2.status}）`);
    const final = await call(api, 'GET', `/api/games/${gid}/annotations?token=pt`);
    const seats = final.body.annotations.seats;
    assert.ok(seats[1] && seats[1].note === '基线', '基线座位必须保留');
    const winnerNote = (r1.status === 200 ? seats[2] : seats[3]);
    assert.ok(winnerNote, '胜者写入的座位必须存在');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('AC-01b 并发 PUT/DELETE 同 revision：恰好一个成功，PUT 成功时内容不丢', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac01b-'));
  try {
    const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: dir });
    const { gid } = await makeGame(api, dir);
    const seed = await call(api, 'PUT', `/api/games/${gid}/annotations`, { token: 'pt', expectedRevision: 0, seats: { 2: { leaning: 'lean_wolf', note: '将争夺的座位' }, 5: { leaning: 'neutral', note: '旁座' } } });
    assert.strictEqual(seed.status, 200);

    const [del, put] = await Promise.all([
      call(api, 'DELETE', `/api/games/${gid}/annotations?token=pt&seat=2&expectedRevision=1`),
      call(api, 'PUT', `/api/games/${gid}/annotations`, { token: 'pt', expectedRevision: 1, seats: { 2: { leaning: 'lean_good', note: 'PUT 的覆盖' } } }),
    ]);
    const codes = [del.status, put.status].sort();
    assert.deepStrictEqual(codes, [200, 409], `PUT/DELETE 并发同版本必须一胜一 409（实际 ${del.status}/${put.status}）`);
    const final = await call(api, 'GET', `/api/games/${gid}/annotations?token=pt`);
    const seats = final.body.annotations.seats;
    if (put.status === 200) {
      assert.ok(seats[2] && seats[2].note === 'PUT 的覆盖', 'PUT 胜出时座位 2 必须是 PUT 的内容（旧实现：DELETE 后写回丢失）');
    } else {
      assert.ok(!seats[2], 'DELETE 胜出时座位 2 应不存在');
    }
    assert.ok(seats[5], '旁座 5 必须保留');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('AC-01c 并发 DELETE/DELETE 同 revision：一个 200 一个 409', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac01c-'));
  try {
    const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: dir });
    const { gid } = await makeGame(api, dir);
    await call(api, 'PUT', `/api/games/${gid}/annotations`, { token: 'pt', expectedRevision: 0, seats: { 4: { leaning: 'lean_wolf' } } });
    const [d1, d2] = await Promise.all([
      call(api, 'DELETE', `/api/games/${gid}/annotations?token=pt&seat=4&expectedRevision=1`),
      call(api, 'DELETE', `/api/games/${gid}/annotations?token=gt&seat=4&expectedRevision=1`),
    ]);
    const codes = [d1.status, d2.status].sort();
    assert.deepStrictEqual(codes, [200, 409], `DELETE/DELETE 并发同版本必须一胜一 409（实际 ${d1.status}/${d2.status}）`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('AC-01d 队列内写失败不污染后续事务：tmp 不残留、下一个写入成功', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac01d-'));
  try {
    const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: dir });
    const { gid } = await makeGame(api, dir);
    await call(api, 'PUT', `/api/games/${gid}/annotations`, { token: 'pt', expectedRevision: 0, seats: { 1: { leaning: 'neutral' } } });
    // 故障注入：让队列事务内的 rename 失败一次
    const realRename = fs.promises.rename;
    fs.promises.rename = async (from, to) => {
      const t = String(to).replace(/\\/g, '/');
      if (String(from).includes('.tmp-') && t.includes('/profiles/')) throw Object.assign(new Error('注入 rename 失败'), { code: 'EACCES' });
      return realRename(from, to);
    };
    const failed = await call(api, 'PUT', `/api/games/${gid}/annotations`, { token: 'pt', expectedRevision: 1, seats: { 2: { leaning: 'lean_wolf' } } });
    fs.promises.rename = realRename;
    assert.strictEqual(failed.status, 500, '队列内写失败应 500');
    // 后续事务照常工作
    const ok = await call(api, 'PUT', `/api/games/${gid}/annotations`, { token: 'pt', expectedRevision: 1, seats: { 3: { leaning: 'lean_good', note: '故障后写入' } } });
    assert.strictEqual(ok.status, 200, `失败后队列必须继续工作：${JSON.stringify(ok.body)}`);
    const proot = path.join(dir, 'profiles');
    const leftovers = fs.existsSync(proot)
      ? fs.readdirSync(proot).flatMap((d) => {
          const p = path.join(proot, d, 'annotations');
          return fs.existsSync(p) ? fs.readdirSync(p).filter((f) => f.includes('.tmp-')) : [];
        })
      : [];
    assert.strictEqual(leftovers.length, 0, `tmp 不得残留：${leftovers}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
