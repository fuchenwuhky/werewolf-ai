/**
 * annotations-delete-count.test.js — 标注"真删除"与导出/导入计数的一致性（FIX-07 服务端收口）
 *
 * 缺陷复述（两半）：
 *   ① 客户端"清除标注"用 `PUT` 写一份**全默认值**（leaning neutral / confidence low / 空 note）来冒充删除，
 *      于是座位键还在、存储只增不减，而"删除"这件事在数据里根本没有发生；
 *   ② 导出/导入按 `Object.keys(seats).length` 计数 ⇒ 被"清除"过的局仍被算成"有笔记"，
 *      `manifest.counts.notes` 与真实笔记数不符（虚高）。
 * 服务端的 DELETE 路由（`DELETE /api/games/:gid/annotations?seat=N`）已在 FIN-07 收口时补上，
 * 本文件锁的是它的**语义与计数闭环**：真删除、不影响其它座位、导出/导入计数随之正确。
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
const { normalizeSeatAnnotation, isMeaningfulSeatAnnotation, DEFAULT_LEANING, DEFAULT_CONFIDENCE } = require('../src/annotations/store');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {}, query() { return []; } };
const BOARD5 = { wolf: 1, seer: 1, witch: 1, villager: 2 };
const players5 = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: i === 0 }));

/** 旧前端"清除标注"写出的那份东西（全部字段等于 normalize 的默认值） */
const clearedSeat = () => normalizeSeatAnnotation({ leaning: DEFAULT_LEANING, confidence: DEFAULT_CONFIDENCE, note: '' });

function stubReq({ method = 'GET', body = null } = {}) {
  const req = new events.EventEmitter();
  req.method = method;
  req.headers = { host: 'localhost:3210' };
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
  await api.handle(stubReq({ method, body }), box.res, u.pathname, u.searchParams);
  return { status: box.code, body: box.raw ? JSON.parse(box.raw) : null };
}

function makeApi(tag) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `ww-anno-count-${tag}-`));
  const saves = path.join(dataDir, 'saves');
  const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: saves });
  return { api, dataDir, saves };
}

/** 一份"已结束"的存档（导出只收已结束局） */
function finishedSaveDoc(id, pid) {
  return {
    schemaVersion: 2, tokens: {}, mock: false, ownerProfileId: pid, ownerNicknameSnapshot: '笔记客', profileSchemaVersion: 1,
    game: {
      id, day: 2, phase: 'ended', started: true, finished: true, winner: 'good', winReason: '狼人全部出局',
      players: [{ seat: 1, name: '我', isHuman: true, role: 'seer' }, { seat: 2, name: 'A', isHuman: false, role: 'wolf' }],
      events: [], board: BOARD5, rules: {},
    },
    anchor: null, review: null, savedAt: 1,
  };
}

/** 内存局（供标注路由使用；与存档文件同 id） */
function memoryEntry(api, gid, pid) {
  const g = new Game({ id: gid, board: BOARD5, players: players5.map((p) => ({ ...p })), stepPauseMs: 1, logger: silentLogger });
  g.deal();
  g.started = true;
  const entry = { game: g, running: false, error: null, mock: true, tokens: { player: 'pt-' + gid, god: 'gt-' + gid }, ownerProfileId: pid, createdAt: Date.now(), lastAccess: Date.now(), review: null };
  api.games.set(gid, entry);
  return entry;
}

test('FIX-07：导出只计"有意义的标注"——全默认值（旧前端清除痕迹）不得虚报为有笔记', async () => {
  const { api, dataDir, saves } = makeApi('export');
  try {
    await api._profileMigrationReady;
    const pid = (await call(api, 'POST', '/api/profiles', { nickname: '笔记客' })).body.profile.id;
    for (const id of ['g-real', 'g-cleared']) fs.writeFileSync(path.join(saves, `${id}.json`), JSON.stringify(finishedSaveDoc(id, pid)));

    const annoDir = path.join(api.profiles.root, pid, 'annotations');
    fs.mkdirSync(annoDir, { recursive: true });
    fs.writeFileSync(path.join(annoDir, 'g-real.json'), JSON.stringify({
      schemaVersion: 2, profileId: pid, gameId: 'g-real', revision: 1,
      seats: { 2: { leaning: 'lean_wolf', candidateRoleIds: ['wolf'], claimedRoleId: null, confidence: 'medium', note: '发言像倒钩', evidenceSeq: 7, day: 1, phase: 'speech', updatedAt: null } },
    }));
    // 旧前端"清除"留下的座位：键存在、值全默认
    fs.writeFileSync(path.join(annoDir, 'g-cleared.json'), JSON.stringify({
      schemaVersion: 2, profileId: pid, gameId: 'g-cleared', revision: 3, seats: { 3: clearedSeat() },
    }));

    const exp = await call(api, 'GET', `/api/profiles/${pid}/export`);
    assert.strictEqual(exp.status, 200, JSON.stringify(exp.body));
    assert.strictEqual(exp.body.manifest.counts.notes, 1, '计数只算有意义的标注（旧实现按座位键数 = 2 → 虚高）');
    assert.deepStrictEqual(Object.keys(exp.body.notes), ['g-real'], '被清除过的局不得进入 notes');
    assert.strictEqual(exp.body.notes['g-cleared'], undefined, '全默认值的座位不是笔记');
    assert.strictEqual(exp.body.notes['g-real'].seats[2].note, '发言像倒钩', '真笔记必须原样随包');
    assert.strictEqual(exp.body.games.length, 2, '两局对局照常导出（计数只影响 notes）');
  } finally {
    try { await api._profileMigrationReady; } catch (_) { /* 忽略 */ }
    clearInterval(api._saveTimer); clearInterval(api._streamTimer);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('FIX-07：DELETE 是真删除（其它座位不受影响），导出计数随之下降；PUT 全默认值不算删除', async () => {
  const { api, dataDir, saves } = makeApi('delete');
  try {
    await api._profileMigrationReady;
    const pid = (await call(api, 'POST', '/api/profiles', { nickname: '撤销客' })).body.profile.id;
    const gid = 'g-del-count';
    fs.writeFileSync(path.join(saves, `${gid}.json`), JSON.stringify(finishedSaveDoc(gid, pid)));
    memoryEntry(api, gid, pid);

    const exp = () => call(api, 'GET', `/api/profiles/${pid}/export`);
    assert.strictEqual((await exp()).body.manifest.counts.notes, 0, '前置：还没有任何笔记');

    // ① 写两个座位（都有意义）
    const put1 = await call(api, 'PUT', `/api/games/${gid}/annotations`, { token: `pt-${gid}`, expectedRevision: 0, seats: { 2: { leaning: 'lean_wolf', note: '倒钩' }, 5: { leaning: 'lean_good', confidence: 'high' } } });
    assert.strictEqual(put1.status, 200, JSON.stringify(put1.body));
    const e1 = await exp();
    assert.strictEqual(e1.body.manifest.counts.notes, 1, '有真笔记 → 计数 1');
    assert.strictEqual(Object.keys(e1.body.notes[gid].seats).length, 2, '两个座位都随包导出');

    // ② 用旧前端的"清除"方式（PUT 写全默认值）：座位键仍在 —— 这不是删除，只是把值写空
    const putClear = await call(api, 'PUT', `/api/games/${gid}/annotations`, { token: `pt-${gid}`, expectedRevision: put1.body.revision, seats: { 2: { leaning: 'neutral', note: '', confidence: 'low' } } });
    assert.strictEqual(putClear.status, 200);
    assert.strictEqual(putClear.body.annotations.seats[2] !== undefined, true, 'PUT 全默认值不会删除座位键（旧前端的"清除"本质是覆写）');
    assert.strictEqual(isMeaningfulSeatAnnotation(putClear.body.annotations.seats[2]), false, '该座位已等于"清空"形态');
    const e2 = await exp();
    assert.strictEqual(e2.body.manifest.counts.notes, 1, '座位 5 仍有真笔记 → 计数仍为 1');
    // 导出对座位载荷保持**忠实**（不替用户删数据）：被写空的座位仍原样在包里，但它不构成"笔记"
    // —— 计数与"是否进入 notes"才是本次修的东西（旧实现把全默认值也当笔记计数）。
    assert.strictEqual(isMeaningfulSeatAnnotation(e2.body.notes[gid].seats[2]), false, '被写空的座位在包里仍是"清空"形态');
    assert.strictEqual(e2.body.notes[gid].seats[5].confidence, 'high', '其它座位不受影响');

    // ③ DELETE 座位 5：真删除 + 计数下降
    const del = await call(api, 'DELETE', `/api/games/${gid}/annotations?token=pt-${gid}&seat=5&expectedRevision=${putClear.body.revision}`);
    assert.strictEqual(del.status, 200, JSON.stringify(del.body));
    assert.strictEqual(del.body.annotations.seats[5], undefined, 'DELETE 必须把座位键真的删掉（不是写默认值）');
    assert.strictEqual(del.body.annotations.seats[2] !== undefined, true, '只删指定座位，其它座位保留');
    const e3 = await exp();
    assert.strictEqual(e3.body.manifest.counts.notes, 0, '没有任何有意义标注 → 计数必须回落到 0');
    assert.strictEqual(e3.body.notes[gid], undefined, '该局必须从 notes 里消失（计数与内容一致）');
    // 磁盘上真的是空 seats，而不是被默认值填满
    const onDisk = JSON.parse(fs.readFileSync(path.join(api.profiles.root, pid, 'annotations', `${gid}.json`), 'utf8'));
    assert.deepStrictEqual(Object.keys(onDisk.seats), ['2'], '磁盘上只剩座位 2（DELETE 真的删了 5）');
    assert.strictEqual(isMeaningfulSeatAnnotation(onDisk.seats[2]), false);
  } finally {
    try { await api._profileMigrationReady; } catch (_) { /* 忽略 */ }
    clearInterval(api._saveTimer); clearInterval(api._streamTimer);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('FIX-07：导入时全默认值的笔记既不落地也不计数（存储不再只增不减）', async () => {
  const { api, dataDir } = makeApi('import');
  try {
    await api._profileMigrationReady;
    const pkg = {
      manifest: { exportVersion: 1, packageId: 'pkg-fix07', createdAt: '2026-01-01T00:00:00.000Z', source: '测试', counts: { games: 2, notes: 2 } },
      profile: { nickname: '带包客', avatarId: 'scholar', bio: '' },
      games: [
        { id: 'g-good', finished: true, day: 1, winner: 'good', winReason: 'x', mock: true, savedAt: 1, players: [{ seat: 1, name: 'a', isHuman: false, role: 'villager' }], events: [], board: BOARD5, rules: {} },
        { id: 'g-empty', finished: true, day: 1, winner: 'wolf', winReason: 'y', mock: true, savedAt: 2, players: [{ seat: 1, name: 'b', isHuman: false, role: 'villager' }], events: [], board: BOARD5, rules: {} },
      ],
      notes: {
        'g-good': { schemaVersion: 2, profileId: 'o', gameId: 'g-good', revision: 1, seats: { 1: { leaning: 'lean_wolf', note: '记一笔' } } },
        'g-empty': { schemaVersion: 2, profileId: 'o', gameId: 'g-empty', revision: 9, seats: { 4: clearedSeat() } },
      },
    };
    const imp = await call(api, 'POST', '/api/profiles/import', { package: pkg });
    assert.strictEqual(imp.status, 200, JSON.stringify(imp.body));
    assert.strictEqual(imp.body.importedNotes, 1, '只有有意义的笔记才计数（旧实现 = 2）');
    const annoDir = path.join(api.profiles.root, imp.body.profileId, 'annotations');
    assert.deepStrictEqual(fs.readdirSync(annoDir), [`${imp.body.gameMap['g-good']}.json`], '全默认值的笔记不得创建标注文件（存储只增不减的反面）');
    const exp = await call(api, 'GET', `/api/profiles/${imp.body.profileId}/export`);
    assert.strictEqual(exp.body.manifest.counts.notes, 1, '重新导出计数同样只算有意义的笔记');
  } finally {
    try { await api._profileMigrationReady; } catch (_) { /* 忽略 */ }
    clearInterval(api._saveTimer); clearInterval(api._streamTimer);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
