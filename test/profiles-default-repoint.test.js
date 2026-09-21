/**
 * profiles-default-repoint.test.js — 默认档案失效后的清理/重指向（FIX-11 回归）
 *
 * 缺陷复述：`ProfileMigration._clearDefaultId()` 从未被调用，且 `_persistDefaultId()` 在 defaultId 为空时
 * 直接 return —— 于是「默认档案被归档/删除」并不会清掉磁盘上的 `migrations/default-profile-id`。
 * 下次启动 `ensureDefaultProfile()` 读到这个失效 id、校验失败、按昵称又找不到可用的「默认玩家」，
 * 就**新建一个「默认玩家」**：用户凭空多出一份档案，旧默认档案的归属链断在这里。
 *
 * 契约（本文件钉住的部分）：
 *   · 归档/删除当前默认档案后，`GET /api/profiles` 的 defaultProfileId 必须**立刻**指向一份
 *     当前可用（存在且未归档）的档案，绝不能指向刚失效的那份；
 *   · 磁盘标记 `migrations/default-profile-id` 必须与内存一致（否则重启就回到老 bug）；
 *   · 重启（新 ProfileStore + 新 ProfileMigration.run()）后不得重建「默认玩家」，
 *     且默认档案仍是重指向后的那一份；
 *   · `_tagSaves` 的死形参已删除，归属昵称仍取自存档内人类玩家。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const events = require('events');

const { Api } = require('../src/api');
const { ProfileStore } = require('../src/profiles/store');
const { ProfileMigration } = require('../src/profiles/migration');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {}, query() { return []; } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

const defaultMarker = (dataDir) => path.join(dataDir, 'migrations', 'default-profile-id');

function makeApi(dataDir) {
  return new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: path.join(dataDir, 'saves') });
}

test('FIX-11：归档当前默认档案 → 默认立刻重指向可用档案（内存 + 磁盘），重启不重建「默认玩家」', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-repoint-'));
  let api = null;
  try {
    api = makeApi(dataDir);
    await api._profileMigrationReady;
    const def = api.defaultProfileId; // 迁移自动创建的「默认玩家」
    assert.match(String(def), UUID, '前置：迁移应建出默认档案');

    const b = (await call(api, 'POST', '/api/profiles', { nickname: '乙' })).body.profile;
    assert.match(String(b.id), UUID);

    // ① 归档默认档案：本请求内必须完成重指向
    const ar = await call(api, 'PATCH', `/api/profiles/${def}`, { archive: true });
    assert.strictEqual(ar.status, 200, JSON.stringify(ar.body));
    assert.strictEqual(ar.body.profile.archivedAt === null, false, '前置：该档案确实进入归档态');

    const list1 = await call(api, 'GET', '/api/profiles');
    assert.strictEqual(list1.status, 200);
    assert.notStrictEqual(list1.body.defaultProfileId, def, '默认档案已归档，defaultProfileId 不得仍指向它');
    assert.strictEqual(list1.body.defaultProfileId, b.id, '唯一可用档案是乙 → 必须重指向乙');
    const liveRow = list1.body.profiles.find((p) => p.id === list1.body.defaultProfileId);
    assert.strictEqual(liveRow.archivedAt, null, 'defaultProfileId 必须指向一份可用（未归档）档案');
    assert.strictEqual(fs.readFileSync(defaultMarker(dataDir), 'utf8').trim(), b.id, '磁盘标记必须与内存一致（否则重启就回到老 bug）');

    // ② 删除（回收）刚归档的默认档案：默认仍不得指向它
    const del = await call(api, 'DELETE', `/api/profiles/${def}`);
    assert.strictEqual(del.status, 200, JSON.stringify(del.body));
    const list2 = await call(api, 'GET', '/api/profiles');
    assert.strictEqual(list2.body.defaultProfileId, b.id, '默认档案被回收后仍必须指向乙');
    assert.strictEqual(list2.body.profiles.some((p) => p.id === def), false, '前置：被删档案已不在列表');

    // ③ 重启：新 store + 新迁移（游标已在，走重入分支）
    const store2 = new ProfileStore({ dataDir, logger: silentLogger });
    const mig2 = new ProfileMigration({ dataDir, profilesStore: store2, logger: silentLogger });
    const run2 = await mig2.run();
    assert.strictEqual(run2.defaultId, b.id, '重启后的默认档案必须还是重指向后的乙（不得重建「默认玩家」）');
    const usable2 = store2.list({ includeArchived: false });
    assert.strictEqual(usable2.filter((p) => p.nickname === '默认玩家').length, 0, '不得凭空重建「默认玩家」档案');
    assert.strictEqual(usable2.some((p) => p.id === b.id), true, '乙必须仍在可用档案里');
  } finally {
    if (api) { try { await api._profileMigrationReady; } catch (_) { /* 忽略 */ } clearInterval(api._saveTimer); clearInterval(api._streamTimer); }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('FIX-11：存量陈旧标记（defaultProfileId 指向已归档档案）在删除路径同样被清理', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-repoint2-'));
  let api = null;
  try {
    api = makeApi(dataDir);
    await api._profileMigrationReady;
    const a = (await call(api, 'POST', '/api/profiles', { nickname: '甲' })).body.profile;
    const ar = await call(api, 'PATCH', `/api/profiles/${a.id}`, { archive: true });
    assert.strictEqual(ar.status, 200, JSON.stringify(ar.body));

    // 人为把默认标记指回已归档的甲（模拟旧版本/外部改坏磁盘标记的存量状态）
    api.profileMigration.setDefaultId(a.id);
    api.defaultProfileId = a.id;
    assert.strictEqual(fs.readFileSync(defaultMarker(dataDir), 'utf8').trim(), a.id, '前置：陈旧标记已写入磁盘');

    const del = await call(api, 'DELETE', `/api/profiles/${a.id}`);
    assert.strictEqual(del.status, 200, JSON.stringify(del.body));
    assert.strictEqual(fs.existsSync(path.join(dataDir, 'profiles', a.id)), false, '前置：档案目录已进回收区');

    const list = await call(api, 'GET', '/api/profiles');
    assert.notStrictEqual(list.body.defaultProfileId, a.id, '默认标记不得指向已消失的档案');
    const row = list.body.profiles.find((p) => p.id === list.body.defaultProfileId);
    assert.strictEqual(row.archivedAt, null, '重指向目标必须是可用档案');
    assert.strictEqual(fs.readFileSync(defaultMarker(dataDir), 'utf8').trim(), list.body.defaultProfileId, '磁盘标记必须同步');

    // 重启不得重建「默认玩家」（甲被回收，自动建的那份仍在 → 不新建；数量必须仍是 1）
    const store2 = new ProfileStore({ dataDir, logger: silentLogger });
    const mig2 = new ProfileMigration({ dataDir, profilesStore: store2, logger: silentLogger });
    const run2 = await mig2.run();
    assert.strictEqual(run2.defaultId, list.body.defaultProfileId, '重启后默认档案必须与接口一致');
    assert.strictEqual(store2.list({ includeArchived: false }).filter((p) => p.nickname === '默认玩家').length, 1, '不得出现第二个「默认玩家」');
  } finally {
    if (api) { try { await api._profileMigrationReady; } catch (_) { /* 忽略 */ } clearInterval(api._saveTimer); clearInterval(api._streamTimer); }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('FIX-11：默认标记的清除真的落盘（setDefaultId(null)/_clearDefaultId 都必须删掉文件）', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-repoint3-'));
  try {
    const store = new ProfileStore({ dataDir, logger: silentLogger });
    const mig = new ProfileMigration({ dataDir, profilesStore: store, logger: silentLogger });
    const pid = '11111111-2222-3333-4444-555555555555';
    const marker = defaultMarker(dataDir);

    assert.strictEqual(mig.setDefaultId(pid), pid, 'setDefaultId 应落盘并返回该 id');
    assert.strictEqual(fs.readFileSync(marker, 'utf8').trim(), pid, '前置：标记已写盘');
    // 旧实现 _persistDefaultId 在 defaultId 为空时**直接 return** ⇒ 文件永远留着，重启又读回失效 id
    assert.strictEqual(mig.setDefaultId(null), null, 'setDefaultId(null) 等价于清除');
    assert.strictEqual(fs.existsSync(marker), false, '清除默认标记必须真正删掉磁盘文件');

    mig.setDefaultId(pid);
    mig._clearDefaultId();
    assert.strictEqual(mig.defaultId, null, '_clearDefaultId 必须清空内存值');
    assert.strictEqual(fs.existsSync(marker), false, '_clearDefaultId 必须删掉磁盘标记');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('FIX-11：_tagSaves 死形参已删除，归属昵称仍取自存档内人类玩家', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-tagsaves-'));
  const saves = path.join(dataDir, 'saves');
  try {
    fs.mkdirSync(saves, { recursive: true });
    fs.writeFileSync(path.join(saves, 'legacy-x.json'), JSON.stringify({
      schemaVersion: 2, tokens: { player: 'p' }, mock: true,
      game: { id: 'legacy-x', day: 1, phase: 'day', started: true, finished: false,
        players: [{ seat: 1, name: '我', isHuman: true }, { seat: 2, name: 'X', isHuman: false }] },
      anchor: null, review: null, savedAt: 1,
    }));

    assert.strictEqual(ProfileMigration.prototype._tagSaves.length, 1, '_tagSaves 的第二个形参 defaultNickname 是死形参，必须删除（签名 = (defaultId)）');

    const store = new ProfileStore({ dataDir, logger: silentLogger });
    const mig = new ProfileMigration({ dataDir, profilesStore: store, logger: silentLogger });
    const pid = '11111111-2222-3333-4444-555555555555';
    assert.strictEqual(mig._tagSaves(pid), 1, '一份无归属存档应被打标');
    const doc = JSON.parse(fs.readFileSync(path.join(saves, 'legacy-x.json'), 'utf8'));
    assert.strictEqual(doc.ownerProfileId, pid);
    assert.strictEqual(doc.ownerNicknameSnapshot, '我', '昵称必须取自存档里的人类玩家（旧形参从未参与计算）');
    assert.strictEqual(doc.ownerHumanSeat, 1);
    assert.strictEqual(doc.profileSchemaVersion, 1);
    // 命名统一（FIX-12 的 hunk）：迁移的原子写不得留下 .migtmp / 任何临时文件
    assert.deepStrictEqual(fs.readdirSync(saves).filter((f) => f.startsWith('.tmp-') || f.endsWith('.migtmp')), []);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
