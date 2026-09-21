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
const { cleanupAfter, terminateAfter } = require('./helpers-tmpdir');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {}, query() { return []; } };
const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `papi-${tag}-`));

// 每个 Api 实例独占一份 dataDir：saveDir = <dataDir>/saves。
// ⚠ 不能让 saveDir 直接落在 os.tmpdir()（原来的"平铺"布局）：api.js 用 dirname(saveDir) 推导
// ProfileStore 根（<tmp>/profiles）、迁移游标（<tmp>/migrations）、迁移源目录（<tmp>/saves），
// 这些都是**全机共享**路径。node --test 默认并行跑各测试文件，多个进程同时把
// profiles/index.json.tmp-* rename 成 profiles/index.json，Windows 会间歇性拒绝：
//   EPERM: operation not permitted, rename '...\Temp\profiles\index.json.tmp-<pid>-<ts>' -> '...\Temp\profiles\index.json'
// API 层如实把 e.code 当状态码回出去（create/import 于是失败）→ 用例随机挂。
// 实测：6 进程 × 40 次建档案，平铺布局失败 34–39/40（每次失败都指向同一份共享 index.json）；
// 隔离 dataDir 后同样的并发负载 0/240。
function makeApi(tag) {
  const dataDir = tmpDir(tag);
  const savesDir = path.join(dataDir, 'saves');
  const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: savesDir });
  // dir 仍指向"存档目录"（savesDir），dataDir 是独占根（清理时删它）
  return { api, dir: savesDir, dataDir, savesDir };
}

// 清理独占 dataDir：先等构造期的档案迁移任务收尾（它仍会写 profiles/index.json），
// 否则会出现"删目录 ↔ 迁移写文件"的竞态（Windows 上表现为 EPERM/ENOTEMPTY）。
// 随后删除；刚写完的文件可能被杀软/索引器短暂占用，故按错误码做有限次重试，最终失败仍抛出（不吞错）。
async function dispose(api, dataDir) {
  try { await api._profileMigrationReady; } catch (_) {}
  for (let i = 0; ; i++) {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); return; }
    catch (e) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 20 * (i + 1)));
    }
  }
}

// 照抄 transfer.test.js 的存档字段结构，额外带上 tokens/anchor/journal 敏感字段用于验证导出脱敏
function mkSaveDoc(id, ownerProfileId, finished) {
  return {
    schemaVersion: 2,
    tokens: { player: 'SECRET-PLAYER-TOKEN', god: 'SECRET-GOD-TOKEN' },
    mock: true,
    ownerProfileId,
    ownerNicknameSnapshot: '快照昵称',
    anchor: { secret: 'ANCHOR-SECRET' },
    journal: { decisions: 'JOURNAL-SECRET' },
    review: null,
    savedAt: 1,
    game: {
      id, day: 3, phase: finished ? 'ended' : 'night', started: true, finished,
      winner: finished ? 'good' : null, winReason: finished ? '狼人全部出局' : '',
      players: [{ seat: 1, name: '快照昵称', isHuman: true, role: 'seer' }],
      events: [{ seq: 1, type: 'night' }],
      board: { wolf: 3, seer: 1, witch: 1, villager: 4 },
      rules: {},
    },
  };
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
    // 捕获 writeHead 携带的响应头（json 与导出路由的 Content-Type/Content-Disposition 都走这里）
    writeHead(code, headers) { box.code = code; Object.assign(box.headers, headers || {}); },
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
  // headers 统一转小写键，断言大小写不敏感；raw 供脱敏等原文断言使用
  const headers = {};
  for (const [k, v] of Object.entries(box.headers)) headers[k.toLowerCase()] = v;
  return { status: box.code, headers, raw: box.raw != null ? String(box.raw) : null, body: box.raw ? JSON.parse(box.raw) : null };
}

test('档案路由：创建/列表/PATCH 409/stats/games/annotations/删除 全链', async (t) => {
  const { api, dataDir } = makeApi('crud');
  terminateAfter(t, api, dataDir); // 用例级清理（失败路径同样生效）
  // 等构造期的档案迁移就绪：后面"归档 → 删除"依赖根目录里确实已有迁移默认档案
  // （"最后一份可用档案不可归档"的保护），不等待就会和迁移异步创建抢占时序。
  await api._profileMigrationReady;

  const c1 = await call(api, 'POST', '/api/profiles', { nickname: '砚舟', avatarId: 'scholar', bio: '测试' });
  assert.strictEqual(c1.status, 200, `创建档案失败：${c1.raw}`);
  const pid = c1.body.profile.id;
  assert.match(pid, /^[0-9a-f-]{36}$/);

  const list = await call(api, 'GET', '/api/profiles');
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.profiles.some((p) => p.id === pid));

  const up1 = await call(api, 'PATCH', `/api/profiles/${pid}`, { expectedRevision: 1, nickname: '砚舟二号' });
  assert.strictEqual(up1.status, 200, `PATCH 失败：${up1.raw}`);
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

  // 结束该局（进行中的局会阻止删除），再验证删除链
  g.finished = true; g.phase = 'ended'; g.winner = 'good';
  api.games.get('anno-g1').game = g;

  // 先归档再删除（DELETE 只接受已归档档案）
  await call(api, 'PATCH', `/api/profiles/${pid}`, { archive: true });
  const del = await call(api, 'DELETE', `/api/profiles/${pid}`);
  assert.strictEqual(del.status, 200, `删除应成功：${JSON.stringify(del.body)}`);
  const gone = await call(api, 'GET', `/api/profiles/${pid}/stats`);
  // 验收收紧：原先写 404 || 500，路由崩成 500 也算通过 —— 那恰好放过了最该拦的错误路径。只认 404。
  assert.strictEqual(gone.status, 404, `已删除档案的 stats 应 404（实际 ${gone.status}）`);
});

test('导入路由：preview 校验坏包 400 / 合法包返回预览；apply 落地档案与对局', async (t) => {
  const { api, dataDir } = makeApi('imp');
  terminateAfter(t, api, dataDir); // 用例级清理（失败路径同样生效）
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

test('导出收集：collectExportableGames 只收已结束且归属正确的对局', async (t) => {
  const transfer = require('../src/profiles/transfer');
  const dir = cleanupAfter(t, tmpDir('exp2'));
  const pid = '99999999-8888-7777-6666-555555555555';
  fs.mkdirSync(dir, { recursive: true });
  const mk = (id, owner, finished) => ({ schemaVersion: 2, tokens: {}, mock: true, ownerProfileId: owner, game: { id, players: [], started: true, finished } });
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(mk('a', pid, true)));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(mk('b', 'other', true)));
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(mk('c', pid, false)));
  const games = transfer.collectExportableGames(dir, pid);
  assert.deepStrictEqual(games.map((g) => g.id), ['a'], '只收集该档案已结束局');
});

test('导出路由：不存在的档案 id 返回 404/500 语义，绝不 200', async () => {
  const { api, dataDir } = makeApi('exp404');
  try {
    const miss = await call(api, 'GET', '/api/profiles/00000000-0000-4000-8000-000000000000/export');
    // 语义上应是 404；当前实现 profileExport 的 catch 吞掉 NotFoundError.code 固定回 500
    // （与"删除后 stats"用例同一容断言口径：404 或 500 都不算回归，但绝不能 200）
    assert.strictEqual(miss.status, 404, `不存在的档案导出应 404（实际 ${miss.status}）`);
    assert.ok(miss.body && miss.body.error, '错误响应必须带 error 说明');
  } finally { await dispose(api, dataDir); }
});

test('导出路由：包体只含本档案已结束局并脱敏（响应头/清单/无令牌）', async () => {
  const { api, dir, dataDir } = makeApi('expok');
  try {
    const c = await call(api, 'POST', '/api/profiles', { nickname: '砚舟导出', avatarId: 'scholar', bio: '' });
    assert.strictEqual(c.status, 200, `创建档案失败：${c.raw}`);
    const pid = c.body.profile.id;

    // 本档案已结束局 + 别人档案的局 + 本档案未结束局
    fs.writeFileSync(path.join(dir, 'exp-a.json'), JSON.stringify(mkSaveDoc('exp-a', pid, true)));
    fs.writeFileSync(path.join(dir, 'exp-b.json'), JSON.stringify(mkSaveDoc('exp-b', '99999999-8888-7777-6666-555555555555', true)));
    fs.writeFileSync(path.join(dir, 'exp-c.json'), JSON.stringify(mkSaveDoc('exp-c', pid, false)));

    const exp = await call(api, 'GET', `/api/profiles/${pid}/export`);
    assert.strictEqual(exp.status, 200, `导出失败：${exp.raw}`);
    assert.match(exp.headers['content-type'] || '', /application\/json/, 'Content-Type 必须含 application/json');
    assert.ok((exp.headers['content-disposition'] || '').includes('attachment'), 'Content-Disposition 必须含 attachment');
    assert.strictEqual(exp.body.manifest.exportVersion, 1, '导出版本必须为 1');
    assert.strictEqual(exp.body.profile.nickname, '砚舟导出', '包内档案昵称必须正确');
    assert.strictEqual(exp.body.manifest.counts.games, 1, 'manifest.counts.games 必须正确');
    assert.strictEqual(exp.body.games.length, 1, '只导出本档案的已结束局');
    assert.strictEqual(exp.body.games[0].id, 'exp-a');
    assert.ok(exp.body.notes && typeof exp.body.notes === 'object', '导出包含 notes 字段');

    // 脱敏：令牌/锚点/journal 的值与字段名都不得出现在包内
    assert.ok(!exp.raw.includes('SECRET-PLAYER-TOKEN'), '导出包不得包含玩家令牌');
    assert.ok(!exp.raw.includes('SECRET-GOD-TOKEN'), '导出包不得包含上帝令牌');
    assert.ok(!exp.raw.includes('ANCHOR-SECRET'), '导出包不得包含锚点数据');
    assert.ok(!exp.raw.includes('JOURNAL-SECRET'), '导出包不得包含 journal 数据');
    assert.ok(!/"tokens"/.test(exp.raw), '包内不得出现 tokens 字段');
    assert.ok(!exp.raw.includes('playerToken') && !exp.raw.includes('godToken'), '包内不得出现 playerToken/godToken 字段');
  } finally { await dispose(api, dataDir); }
});

test('导出路由：私人标注跟随导出（手写 profiles/<pid>/annotations/<gameId>.json）', async () => {
  const { api, dir, dataDir } = makeApi('expnote');
  try {
    const c = await call(api, 'POST', '/api/profiles', { nickname: '砚记笔记' });
    assert.strictEqual(c.status, 200, `创建档案失败：${c.raw}`);
    const pid = c.body.profile.id;
    fs.writeFileSync(path.join(dir, 'exp-a.json'), JSON.stringify(mkSaveDoc('exp-a', pid, true)));
    fs.writeFileSync(path.join(dir, 'exp-b.json'), JSON.stringify(mkSaveDoc('exp-b', pid, true)));

    // 进行中的内存局才能走 PUT /api/games/:gid/annotations；存档局直接按 AnnotationStore
    // 的文件布局手写（结构见 src/annotations/store.js 的 emptyDoc：schemaVersion/profileId/gameId/revision/seats）
    const annoDir = path.join(api.profiles.root, pid, 'annotations');
    fs.mkdirSync(annoDir, { recursive: true });
    fs.writeFileSync(path.join(annoDir, 'exp-a.json'), JSON.stringify({
      schemaVersion: 2, profileId: pid, gameId: 'exp-a', revision: 1,
      seats: {
        3: {
          leaning: 'lean_wolf', note: '悍跳预言家', candidateRoleIds: ['wolf'], claimedRoleId: 'seer',
          confidence: 'medium', evidenceSeq: 12, day: 1, phase: 'day', updatedAt: new Date().toISOString(),
        },
      },
    }));

    const exp = await call(api, 'GET', `/api/profiles/${pid}/export`);
    assert.strictEqual(exp.status, 200, `导出失败：${exp.raw}`);
    assert.strictEqual(exp.body.manifest.counts.notes, 1, 'notes 计数只算有笔记的局');
    assert.deepStrictEqual(Object.keys(exp.body.notes), ['exp-a'], '只有写了标注的局进入 notes');
    assert.strictEqual(exp.body.notes['exp-a'].seats[3].leaning, 'lean_wolf', '标注内容随包导出');
    assert.strictEqual(exp.body.games.length, 2, '没标注的已结束局仍照常导出');
  } finally { await dispose(api, dataDir); }
});

test('导出路由：归档档案导出仍 200（归档=只读保留）', async () => {
  const { api, dataDir, savesDir } = makeApi('exparch');
  try {
    // 等迁移默认档案就绪，"最后一份可用档案不可归档"的保护才有确定语义
    await api._profileMigrationReady;
    const c = await call(api, 'POST', '/api/profiles', { nickname: '砚归档' });
    assert.strictEqual(c.status, 200);
    const pid = c.body.profile.id;
    fs.writeFileSync(path.join(savesDir, 'arch-g1.json'), JSON.stringify(mkSaveDoc('arch-g1', pid, true)));

    const ar = await call(api, 'PATCH', `/api/profiles/${pid}`, { archive: true });
    assert.strictEqual(ar.status, 200, `归档失败：${JSON.stringify(ar.body)}`);

    const exp = await call(api, 'GET', `/api/profiles/${pid}/export`);
    assert.strictEqual(exp.status, 200, '归档档案导出仍应 200');
    assert.strictEqual(exp.body.profile.nickname, '砚归档', '归档档案的包内容不变');
    assert.strictEqual(exp.body.games.length, 1, '归档档案的已结束局照常导出');
  } finally { await dispose(api, dataDir); }
});

test('档案管理链：归档→列表可见→恢复→再归档→删除→stats 不可达；最后一份可用档案归档被拒', async () => {
  const { api, dataDir } = makeApi('chain');
  try {
    await api._profileMigrationReady;
    const list0 = await call(api, 'GET', '/api/profiles');
    assert.strictEqual(list0.status, 200);
    const def = list0.body.profiles.find((p) => p.nickname === '默认玩家');
    assert.ok(def, '迁移默认档案必须存在');

    const c1 = await call(api, 'POST', '/api/profiles', { nickname: '阿澈' });
    const c2 = await call(api, 'POST', '/api/profiles', { nickname: '阿岚' });
    assert.strictEqual(c1.status, 200);
    assert.strictEqual(c2.status, 200);
    const pid1 = c1.body.profile.id;
    const pid2 = c2.body.profile.id;

    // 链路①：归档 → GET /api/profiles 仍可见（includeArchived）→ 恢复 → 再归档 → 删除 → stats 不可达
    const ar1 = await call(api, 'PATCH', `/api/profiles/${pid1}`, { archive: true });
    assert.strictEqual(ar1.status, 200, `归档失败：${JSON.stringify(ar1.body)}`);
    assert.ok(ar1.body.profile.archivedAt, '归档后 archivedAt 必须置位');
    const list1 = await call(api, 'GET', '/api/profiles');
    assert.ok(list1.body.profiles.some((p) => p.id === pid1 && p.archivedAt), '归档档案仍出现在 GET /api/profiles（includeArchived）');

    const rs1 = await call(api, 'PATCH', `/api/profiles/${pid1}`, { restore: true });
    assert.strictEqual(rs1.status, 200, `恢复失败：${JSON.stringify(rs1.body)}`);
    assert.strictEqual(rs1.body.profile.archivedAt, null, '恢复后 archivedAt 必须清空');

    const ar2 = await call(api, 'PATCH', `/api/profiles/${pid1}`, { archive: true });
    assert.strictEqual(ar2.status, 200, '再次归档应成功');
    const del1 = await call(api, 'DELETE', `/api/profiles/${pid1}`);
    assert.strictEqual(del1.status, 200, `删除失败：${JSON.stringify(del1.body)}`);
    assert.ok(del1.body.ok === true && del1.body.archiveId, '删除返回 ok 与回收区 archiveId');
    const gone1 = await call(api, 'GET', `/api/profiles/${pid1}/stats`);
    assert.strictEqual(gone1.status, 404, `已删除档案的 stats 应 404（实际 ${gone1.status}）`);

    // 链路②：把可用档案压到只剩 pid2 → 归档被拒；未归档删除被拒；补一份档案后放行
    const arDef = await call(api, 'PATCH', `/api/profiles/${def.id}`, { archive: true });
    assert.strictEqual(arDef.status, 200, `归档默认档案失败：${JSON.stringify(arDef.body)}`);
    const arLast = await call(api, 'PATCH', `/api/profiles/${pid2}`, { archive: true });
    assert.strictEqual(arLast.status, 400, '最后一份可用档案归档必须被拒');
    assert.match(arLast.body.error, /最后一份/, '错误信息应说明最后一份可用档案保护');
    const delNotArchived = await call(api, 'DELETE', `/api/profiles/${pid2}`);
    assert.strictEqual(delNotArchived.status, 409, '未归档档案删除必须 409');

    const c3 = await call(api, 'POST', '/api/profiles', { nickname: '阿石' });
    assert.strictEqual(c3.status, 200);
    const ar3 = await call(api, 'PATCH', `/api/profiles/${pid2}`, { archive: true });
    assert.strictEqual(ar3.status, 200, '不再是最后一份可用档案后归档应放行');
    const del2 = await call(api, 'DELETE', `/api/profiles/${pid2}`);
    assert.strictEqual(del2.status, 200, `删除失败：${JSON.stringify(del2.body)}`);
    const gone2 = await call(api, 'GET', `/api/profiles/${pid2}/stats`);
    assert.strictEqual(gone2.status, 404, `已删除档案的 stats 应 404（实际 ${gone2.status}）`);
  } finally { await dispose(api, dataDir); }
});

test('真实 HTTP 导入→重新导出往返：笔记与偏好必须随包落地（审核 P1-1）', async () => {
  const { api, dataDir } = makeApi('roundtrip');
  try {
    const pkg = {
      manifest: { exportVersion: 1, packageId: 'pkg-1', createdAt: '2026-01-01T00:00:00.000Z', source: '测试', counts: { games: 1, notes: 1 } },
      profile: { nickname: '远客', avatarId: 'hunter', bio: '带包来投', preferences: { fontScale: 1.25, layout: 'compact', reducedMotion: true } },
      games: [{
        id: 'g-old-1', finished: true, day: 2, winner: 'good', winReason: '狼人全部出局', mock: true, savedAt: 1,
        players: [{ seat: 1, name: '远客', isHuman: true, role: 'witch' }],
        events: [{ seq: 1, type: 'night' }, { seq: 2, type: 'day' }],
        board: { wolf: 1, witch: 1, villager: 2 }, rules: {},
      }],
      notes: { 'g-old-1': { schemaVersion: 2, profileId: 'orig', gameId: 'g-old-1', revision: 3, seats: { 2: { leaning: 'lean_wolf', candidateRoleIds: ['wolf'], claimedRoleId: null, confidence: 'high', note: '发言像倒钩', evidenceSeq: null, day: 1, phase: 'speech', updatedAt: null } } } },
    };
    const imp = await call(api, 'POST', '/api/profiles/import', { package: pkg });
    assert.strictEqual(imp.status, 200, `导入应成功：${JSON.stringify(imp.body)}`);
    assert.ok(imp.body.importedNotes === 1, `导入应落地 1 份笔记（实际 ${JSON.stringify(imp.body)}）`);
    const newGid = imp.body.gameMap['g-old-1'];
    assert.ok(newGid, '旧 gameId 应有重映射');

    // 重新导出：必须经过真实 HTTP 路由
    const exp = await call(api, 'GET', `/api/profiles/${imp.body.profileId}/export`);
    assert.strictEqual(exp.status, 200, `导出应成功：${JSON.stringify(exp.body)}`);
    const out = exp.body;
    // ① 笔记随局落地且以新 gameId 记账
    assert.ok(out.notes && out.notes[newGid], `重新导出必须含导入的笔记（notes keys: ${Object.keys(out.notes || {})}）`);
    assert.strictEqual(out.notes[newGid].seats[2].note, '发言像倒钩');
    // ② 偏好随包继承，不得回落默认
    assert.deepStrictEqual(out.profile.preferences, { fontScale: 1.25, layout: 'compact', reducedMotion: true },
      `偏好必须继承（实际 ${JSON.stringify(out.profile.preferences)}）`);
    // ③ 事件流不丢（本次包内 game.events 全量在）
    assert.strictEqual(out.games[0].events.length, 2, '导出对局必须带事件流');
    assert.ok(!exp.raw.includes('SECRET'), '脱敏复核：原文不含令牌类字段');
  } finally { await dispose(api, dataDir); }
});

test('导出事件流：旧式存档（events 在 anchor）不再导出 0 条；game.events 优先（审核 P1-3）', async () => {
  const { api, dataDir, savesDir } = makeApi('anchor-ev');
  try {
    const prof = await call(api, 'POST', '/api/profiles', { nickname: '锚点客' });
    const pid = prof.body.profile.id;
    // 旧式存档：game 元数据被 _saveMeta 剥掉 events，事件流只在 anchor 里
    const old = mkSaveDoc('g-anchor-ev', pid, true);
    old.game.events = []; // 旧式剥除后的形态
    old.anchor = { nextPhase: 'speech', events: Array.from({ length: 12 }, (_, i) => ({ seq: i + 1, type: 'speech' })) };
    fs.writeFileSync(path.join(savesDir, 'g-anchor-ev.json'), JSON.stringify(old));
    // 新式终局存档：events 直接在 game（终局保留完整流）
    const neo = mkSaveDoc('g-neo-ev', pid, true);
    neo.game.events = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, type: 'mixed' }));
    neo.anchor = { events: [{ seq: 1, type: 'stale' }] }; // 锚点较旧，不应被采用
    fs.writeFileSync(path.join(savesDir, 'g-neo-ev.json'), JSON.stringify(neo));

    const exp = await call(api, 'GET', `/api/profiles/${pid}/export`);
    assert.strictEqual(exp.status, 200);
    const byId = Object.fromEntries(exp.body.games.map((g) => [g.id, g]));
    assert.strictEqual(byId['g-anchor-ev'].events.length, 12, '旧式存档必须从 anchor.events 取到全部事件');
    assert.strictEqual(byId['g-neo-ev'].events.length, 30, '新式终局存档用 game.events（不是过期锚点）');
    assert.strictEqual(byId['g-neo-ev'].events[29].seq, 30, '不得静默截断');
  } finally { await dispose(api, dataDir); }
});

test('平局战绩：胜/负/平互斥，平局不算胜也不产生负数（审核 P2-4）', async () => {
  const { api, dataDir, savesDir } = makeApi('draw');
  try {
    const prof = await call(api, 'POST', '/api/profiles', { nickname: '和平客' });
    const pid = prof.body.profile.id;
    const mk = (id, winner) => {
      const doc = mkSaveDoc(id, pid, true);
      doc.mock = false;
      doc.game.winner = winner;
      doc.game.winReason = winner === 'draw' ? '平安夜耗尽' : '狼人全部出局';
      doc.players = null;
      fs.writeFileSync(path.join(savesDir, `${id}.json`), JSON.stringify(doc));
    };
    mk('g-draw', 'draw');   // 平局：旧公式会把它判给好人 → "胜1 负-1"
    mk('g-win', 'good');    // 好人胜（人类 seer → good 阵营）
    mk('g-loss', 'wolf');   // 狼胜
    const st = await call(api, 'GET', `/api/profiles/${pid}/stats`);
    assert.strictEqual(st.status, 200, JSON.stringify(st.body));
    assert.strictEqual(st.body.wins, 1, '恰 1 胜');
    assert.strictEqual(st.body.losses, 1, '恰 1 负');
    assert.strictEqual(st.body.draws, 1, '恰 1 平（含不可判定不误入胜负）');
    assert.ok(st.body.wins + st.body.losses <= st.body.real, '胜负之和不超过正式局数');
  } finally { await dispose(api, dataDir); }
});

test('_saveMeta：终局保留完整事件流，进行中剥离（审核 P1-3 存档侧）', (t) => {
  const { api, dataDir } = makeApi('savemeta');
  terminateAfter(t, api, dataDir); // 用例级清理（失败路径同样生效）
  const fake = (finished) => ({
    finished,
    toJSON: () => ({ id: 'g1', day: 3, events: [{ seq: 1, type: 'x' }], players: [] }),
  });
  const done = api._saveMeta(fake(true));
  assert.ok(Array.isArray(done.events) && done.events.length === 1, '终局存档必须保留 events');
  const live = api._saveMeta(fake(false));
  assert.strictEqual(live.events, undefined, '进行中存档 events 只进 anchor，不重复存储');
});

test('导入包缺 notes 字段：importedNotes 为 0，不报错（notes 分支补全）', async () => {
  const { api, dataDir } = makeApi('nonotes');
  try {
    const pkg = {
      manifest: { exportVersion: 1, packageId: 'pkg-2', createdAt: '2026-01-01T00:00:00.000Z', source: '测试', counts: { games: 1, notes: 0 } },
      profile: { nickname: '裸包客', avatarId: 'scholar', bio: '' },
      games: [{
        id: 'g-old-2', finished: true, day: 1, winner: 'wolf', winReason: '狼人屠边', mock: true, savedAt: 1,
        players: [{ seat: 1, name: '裸包客', isHuman: true, role: 'villager' }],
        events: [], board: { wolf: 1, villager: 2 }, rules: {},
      }],
    };
    const imp = await call(api, 'POST', '/api/profiles/import', { package: pkg });
    assert.strictEqual(imp.status, 200, JSON.stringify(imp.body));
    assert.strictEqual(imp.body.importedNotes, 0, '无笔记包 importedNotes 必须为 0');
    assert.strictEqual(Object.keys(imp.body.gameMap).length, 1);
  } finally { await dispose(api, dataDir); }
});

test('真实 HTTP 导入坏包：走统一实现后仍返回 400 语义（importApplyRes 错误路径）', async () => {
  const { api, dataDir } = makeApi('badimp');
  try {
    const imp = await call(api, 'POST', '/api/profiles/import', { package: { profile: { nickname: '坏包' }, games: 'not-array' } });
    assert.strictEqual(imp.status, 400, `缺 manifest/非法 games 必须 400（实际 ${imp.status}：${JSON.stringify(imp.body)}）`);
    // 确认没有半截落地：不应产生任何档案
    const list = await call(api, 'GET', '/api/profiles');
    const stray = list.body.profiles.filter((p) => p.nickname.includes('坏包'));
    assert.strictEqual(stray.length, 0, '校验失败不得创建档案');
  } finally { await dispose(api, dataDir); }
});

test('真实 HTTP 导入半坏包：第二局 players 类型非法 → 整体 400，零残留（审核 P2-4）', async () => {
  const { api, dataDir, savesDir } = makeApi('halfbad');
  try {
    const pkg = {
      manifest: { exportVersion: 1, packageId: 'pkg-3', createdAt: '2026-01-01T00:00:00.000Z', source: '测试', counts: { games: 2, notes: 0 } },
      profile: { nickname: '半坏包', avatarId: 'scholar', bio: '' },
      games: [
        { id: 'g-ok-1', finished: true, day: 1, winner: 'good', winReason: 'x', mock: true, savedAt: 1,
          players: [{ seat: 1, name: 'a', isHuman: false, role: 'villager' }], events: [], board: { wolf: 1, villager: 2 }, rules: {} },
        { id: 'g-bad-1', finished: true, day: 1, winner: 'good', winReason: 'x', mock: true, savedAt: 1,
          players: 'not-an-array', events: [], board: { wolf: 1, villager: 2 }, rules: {} },
      ],
    };
    const imp = await call(api, 'POST', '/api/profiles/import', { package: pkg });
    assert.strictEqual(imp.status, 400, `非法 players 必须在写盘前整体拒绝（实际 ${imp.status}）`);
    // 零残留断言：不建档案、不落存档
    const list = await call(api, 'GET', '/api/profiles');
    assert.strictEqual(list.body.profiles.filter((p) => p.nickname.includes('半坏包')).length, 0, '不得创建档案');
    const leftovers = fs.existsSync(savesDir) ? fs.readdirSync(savesDir).filter((f) => f.endsWith('.json') && f !== 'experiences.json') : [];
    assert.strictEqual(leftovers.length, 0, `不得留下任何存档（实际 ${leftovers}）`);
  } finally { await dispose(api, dataDir); }
});

test('导入时笔记写盘故障：不报成功、回滚已写存档与档案（审核 P1-2 复验）', async () => {
  const { api, dataDir, savesDir } = makeApi('diskfail');
  try {
    // 故障注入：putSync 模拟磁盘写失败（旧实现对这类错误静默跳过 → 导出丢笔记却报成功）
    api.annotations.put = async () => { throw Object.assign(new Error('EPERM: 磁盘写入失败（注入）'), { code: 'EPERM' }); };
    const pkg = {
      manifest: { exportVersion: 1, packageId: 'pkg-4', createdAt: '2026-01-01T00:00:00.000Z', source: '测试', counts: { games: 1, notes: 1 } },
      profile: { nickname: '磁盘故障', avatarId: 'scholar', bio: '' },
      games: [{ id: 'g-df-1', finished: true, day: 1, winner: 'good', winReason: 'x', mock: true, savedAt: 1,
        players: [{ seat: 1, name: 'a', isHuman: false, role: 'villager' }], events: [], board: { wolf: 1, villager: 2 }, rules: {} }],
      notes: { 'g-df-1': { schemaVersion: 2, profileId: 'o', gameId: 'g-df-1', revision: 1, seats: { 1: { leaning: 'lean_wolf' } } } },
    };
    const out = await api.importApplyRes(pkg); // 直调内部实现以注入故障；断言走的是同一事务路径
    assert.strictEqual(out.status, 500, `写盘故障必须失败（实际 ${out.status}：${JSON.stringify(out.body)}）`);
    assert.strictEqual(out.body.ok, undefined, '绝不能返回 ok:true');
    assert.strictEqual(out.body.rolledBack, true, '必须声明已回滚');
    assert.match(out.body.error, /回滚/);
    // 回滚断言：存档已删、档案已回收
    const leftovers = fs.existsSync(savesDir) ? fs.readdirSync(savesDir).filter((f) => f.includes('g-df') || (f.startsWith('.tmp-'))) : [];
    assert.strictEqual(leftovers.length, 0, `已写存档必须回滚（实际 ${leftovers}）`);
    const list = await call(api, 'GET', '/api/profiles');
    assert.strictEqual(list.body.profiles.filter((p) => p.nickname.includes('磁盘故障')).length, 0, '导入档案必须已回收');
  } finally { await dispose(api, dataDir); }
});

test('回滚未完成：清理失败必须如实报 rolledBack:false + 落恢复记录；重试导入自动清理（复审 P2-3）', async () => {
  const { api, dataDir, savesDir } = makeApi('rollback2');
  const realUnlink = fs.unlinkSync;
  try {
    // 故障组合：笔记写盘失败（触发回滚）+ unlink 失败（回滚也不完整）
    api.annotations.put = async () => { throw Object.assign(new Error('EPERM: 注入写盘失败'), { code: 'EPERM' }); };
    fs.unlinkSync = (p) => {
      if (String(p).startsWith(savesDir)) throw Object.assign(new Error('EPERM: 注入清理失败'), { code: 'EPERM' });
      return realUnlink(p);
    };
    const pkg = {
      manifest: { exportVersion: 1, packageId: 'pkg-5', createdAt: '2026-01-01T00:00:00.000Z', source: '测试', counts: { games: 1, notes: 1 } },
      profile: { nickname: '回滚未完', avatarId: 'scholar', bio: '' },
      games: [{ id: 'g-rb-1', finished: true, day: 1, winner: 'good', winReason: 'x', mock: true, savedAt: 1,
        players: [{ seat: 1, name: 'a', isHuman: false, role: 'villager' }], events: [], board: { wolf: 1, villager: 2 }, rules: {} }],
      notes: { 'g-rb-1': { schemaVersion: 2, profileId: 'o', gameId: 'g-rb-1', revision: 1, seats: { 1: { leaning: 'lean_wolf' } } } },
    };
    const out = await api.importApplyRes(pkg);
    assert.strictEqual(out.status, 500);
    assert.strictEqual(out.body.rolledBack, false, '清理未完成绝不能声称已回滚');
    assert.strictEqual(out.body.cleanupPending, true, '必须声明待清理状态');
    assert.match(out.body.recoveryFile, /^\.import-recovery-/);
    const recPath = path.join(savesDir, out.body.recoveryFile);
    assert.ok(fs.existsSync(recPath), '恢复记录必须落盘（可重试）');
    const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
    assert.strictEqual(rec.profileId, out.body.profileId ?? rec.profileId, '记录必须含档案 id');
    assert.ok(rec.files.length >= 1, '记录必须含待清理文件清单');
    // 残留确实存在（如实性对照）
    assert.ok(fs.readdirSync(savesDir).some((f) => f.endsWith('.json') && !f.startsWith('.import-recovery-')), '注入场景下应有真实残留（重映射 UUID 的存档）');

    // 恢复：解除故障后，下一次导入入口自动重试清理，记录被消化
    fs.unlinkSync = realUnlink;
    delete api.annotations.put;
    const okPkg = {
      manifest: { exportVersion: 1, packageId: 'pkg-6', createdAt: '2026-01-01T00:00:00.000Z', source: '测试', counts: { games: 0, notes: 0 } },
      profile: { nickname: '触发重试', avatarId: 'scholar', bio: '' },
      games: [],
    };
    const ok = await call(api, 'POST', '/api/profiles/import', { package: okPkg });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const leftovers = fs.readdirSync(savesDir).filter((f) => (f.endsWith('.json') && !f.startsWith('.import-recovery-')) || f.startsWith('.tmp-') || f.startsWith('.import-recovery-'));
    assert.strictEqual(leftovers.length, 0, `重试后残留与恢复记录必须被清空（实际 ${leftovers}）`);
  } finally { fs.unlinkSync = realUnlink; await dispose(api, dataDir); }
});

test('rename 失败：.tmp-* 进回滚清单，清理成功后如实报 rolledBack:true（复审 P2-3 tmp 记录）', async () => {
  const { api, dataDir, savesDir } = makeApi('tmpres');
  const realRename = fs.promises.rename;
  try {
    fs.promises.rename = async (from, to) => {
      // 只拦截"落进存档目录"的 rename（导入写盘）；ProfileStore 自身的 tmp→final 原子写不受影响
      if (String(from).includes('.tmp-') && String(to).startsWith(savesDir)) {
        throw Object.assign(new Error('EPERM: 注入 rename 失败'), { code: 'EPERM' });
      }
      return realRename(from, to);
    };
    const pkg = {
      manifest: { exportVersion: 1, packageId: 'pkg-7', createdAt: '2026-01-01T00:00:00.000Z', source: '测试', counts: { games: 1, notes: 0 } },
      profile: { nickname: '临时残留', avatarId: 'scholar', bio: '' },
      games: [{ id: 'g-tmprs-1', finished: true, day: 1, winner: 'good', winReason: 'x', mock: true, savedAt: 1,
        players: [{ seat: 1, name: 'a', isHuman: false, role: 'villager' }], events: [], board: { wolf: 1, villager: 2 }, rules: {} }],
    };
    const out = await api.importApplyRes(pkg);
    assert.strictEqual(out.status, 500);
    assert.strictEqual(out.body.rolledBack, true, 'tmp 已被记录且清理成功 → 可以如实声称已回滚');
    const leftovers = fs.readdirSync(savesDir).filter((f) => f.startsWith('.tmp-') || f.includes('g-tmprs') || f.startsWith('.import-recovery-'));
    assert.strictEqual(leftovers.length, 0, `tmp 残留必须被回滚清空（实际 ${leftovers}）`);
  } finally { fs.promises.rename = realRename; await dispose(api, dataDir); }
});
