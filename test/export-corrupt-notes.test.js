/**
 * export-corrupt-notes.test.js — 「缺陷 B」的永久钉桩（2026-09-22，主控）
 *
 * 缺陷（主控用独立探针在真 HTTP 服务上、对**前置代码的隔离副本**做的判红验证）：
 *   同一份数据目录上，把 `profiles/<pid>/annotations/<gameId>.json` 写成坏 JSON，
 *   `GET /api/profiles/<pid>/export` 返回 **200 + manifest.counts.notes=0 + 无 error** ——
 *   损坏的笔记与"这局没有笔记"在数据上完全不可区分。
 *   前置代码实测（副本 `D:\ww-wt-headfix` @ 213a42f）：
 *     1) 没有笔记文件 ⇒ 200 {"games":1,"notes":0}
 *     2) 笔记文件损坏 ⇒ 200 {"games":1,"notes":0}     ← 【红】
 *     3) 笔记文件合法 ⇒ 200 {"games":1,"notes":1}
 *   根因两层：
 *     - `src/annotations/store.js#_readFile` 的 `catch -> return emptyDoc` 把
 *       「文件不存在」「坏 JSON」「不可读」三种情况吞成同一个结果；
 *     - `src/api.js#profileExport` 的笔记循环再吞一层（注释写着"单局笔记读取失败不阻断导出"）。
 *   违反计划书 §7：「笔记文件缺失可表示无笔记；**文件损坏或读取错误不能静默当作无笔记**」。
 *
 * 修法（opt-in，最小影响面）：`_readFile(file, pid, gid, { strict = false })`；
 *   strict 时 ENOENT 仍回空文档、坏 JSON/不可读则抛 `{code:500}` 并点名文件；
 *   `_read`/`get` 透传 opts（默认行为不变 ⇒ UI 与 `put` 的合并读零影响）；
 *   导出路由改为 `get(pid, gid, { strict: true })` 并去掉吞异常的 catch。
 *
 * 本文件钉住五件事：坏笔记 ⇒ 拒绝；**缺失**笔记 ⇒ 仍 200（不得过度拒绝）；
 * 合法笔记 ⇒ 计数正确；strict 读遇缺失**不抛错**；**默认读对坏档仍返回空文档**（UI 侧不被牵连）。
 *
 * ⚠ 假请求/假响应照 `test/profiles-api.test.js:74-110` 的已验证形状写（四参 handle、host 头、
 *   nextTick 发 body、new EventEmitter、建完 Api 先 await _profileMigrationReady）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const events = require('events');

const { makeDataDir, savesOf, makeApiIn, terminateAfter } = require('./helpers-tmpdir');

function stubReq({ method = 'GET', headers = {}, body = null } = {}) {
  const req = new events.EventEmitter();
  req.method = method;
  req.headers = headers;
  req.socket = { remoteAddress: '127.0.0.1' };
  process.nextTick(() => {
    if (body !== null && body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}
function stubRes() {
  const box = { headers: {} };
  box.res = {
    writeHead(code, headers) { box.code = code; Object.assign(box.headers, headers || {}); },
    end(b) { box.raw = b; },
    setHeader(k, v) { box.headers[k.toLowerCase()] = v; },
  };
  return box;
}
const HOST = { host: 'localhost:3210' };
async function call(api, method, pathname, body) {
  const u = new URL(pathname, 'http://localhost');
  const box = stubRes();
  await api.handle(stubReq({ method, headers: Object.assign({}, HOST), body }), box.res, u.pathname, u.searchParams);
  const headers = {};
  for (const [k, v] of Object.entries(box.headers)) headers[k.toLowerCase()] = v;
  const raw = box.raw != null ? String(box.raw) : null;
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { /* 非 JSON 时留 null */ }
  return { status: box.code, headers, raw, body: parsed };
}

const mkSave = (id, ownerProfileId, finished) => JSON.stringify({
  schemaVersion: 2, mock: true, ownerProfileId, savedAt: '2026-09-22T00:00:00.000Z',
  game: { id, players: [], started: true, finished, day: 1, winner: 'good' },
});
const mkNotes = (pid, gid) => JSON.stringify({
  schemaVersion: 2, profileId: pid, gameId: gid, revision: 1,
  seats: { '1': { phase: 'day', note: '我怀疑 3 号' } },   // phase 非空 ⇒ 被 hasMeaningfulAnnotations 认作"有意义"
});

async function mkApi(t, tag) {
  const dataDir = makeDataDir(tag);
  const dir = savesOf(dataDir);
  const ref = { api: null };
  terminateAfter(t, () => ref.api, dataDir);
  ref.api = makeApiIn(dataDir, { config: { get: () => ({ apiKey: '', journal: false }), save() {} } }).api;
  await ref.api._profileMigrationReady;
  return { api: ref.api, dir, dataDir };
}
async function newProfile(api, nickname) {
  const c = await call(api, 'POST', '/api/profiles', { nickname, avatarId: 'scholar', bio: '' });
  assert.strictEqual(c.status, 200, `创建档案失败：${c.raw}`);
  return c.body.profile.id;
}

test('缺陷 B①：笔记文件损坏 ⇒ 导出必须 500 并点名笔记文件（不得静默 counts.notes=0）', async (t) => {
  const { api, dir, dataDir } = await mkApi(t, 'defectB-bad');
  const pid = await newProfile(api, '坏笔记导出');
  const gid = 'notegame1';
  fs.writeFileSync(path.join(dir, gid + '.json'), mkSave(gid, pid, true));
  const annDir = path.join(dataDir, 'profiles', pid, 'annotations');
  fs.mkdirSync(annDir, { recursive: true });
  fs.writeFileSync(path.join(annDir, gid + '.json'), '{ "schemaVersion": 2, "profileId": "');   // 坏 JSON

  const exp = await call(api, 'GET', `/api/profiles/${pid}/export`);
  assert.strictEqual(exp.status, 500, `损坏笔记必须拒绝导出（实际 ${exp.status}）—— 200 就是静默丢笔记`);
  assert.match(String(exp.body && exp.body.error), /笔记文件(损坏|不可读)/, '错误必须说明是笔记文件损坏/不可读');
  assert.match(String(exp.body && exp.body.error), new RegExp(gid + '\\.json'), '错误必须点名是哪份笔记文件');
  assert.ok(!(exp.body && exp.body.manifest), '被拒绝时不得返回一个"少了一份笔记"的包');
});

test('缺陷 B②：笔记文件**缺失** ⇒ 导出仍 200 且 notes=0（§7 允许，不得过度拒绝）', async (t) => {
  const { api, dir } = await mkApi(t, 'defectB-missing');
  const pid = await newProfile(api, '无笔记导出');
  fs.writeFileSync(path.join(dir, 'nogame.json'), mkSave('nogame', pid, true));

  const exp = await call(api, 'GET', `/api/profiles/${pid}/export`);
  assert.strictEqual(exp.status, 200, `没有笔记文件必须能正常导出：${exp.raw}`);
  assert.strictEqual(exp.body.manifest.counts.games, 1);
  assert.strictEqual(exp.body.manifest.counts.notes, 0, '"这局没有笔记"就该是 0');
});

test('缺陷 B③：笔记文件合法 ⇒ 导出 200 且 notes 计数正确（正向对照）', async (t) => {
  const { api, dir, dataDir } = await mkApi(t, 'defectB-good');
  const pid = await newProfile(api, '有笔记导出');
  const gid = 'notegame2';
  fs.writeFileSync(path.join(dir, gid + '.json'), mkSave(gid, pid, true));
  const annDir = path.join(dataDir, 'profiles', pid, 'annotations');
  fs.mkdirSync(annDir, { recursive: true });
  fs.writeFileSync(path.join(annDir, gid + '.json'), mkNotes(pid, gid));

  const exp = await call(api, 'GET', `/api/profiles/${pid}/export`);
  assert.strictEqual(exp.status, 200, `合法笔记必须能导出：${exp.raw}`);
  assert.strictEqual(exp.body.manifest.counts.notes, 1, '有意义的笔记必须计入 notes');
  assert.ok(exp.body.notes[gid], '包内必须带上这局的笔记');
});

test('缺陷 B④：strict 读遇**缺失**文件不抛错；默认读遇坏档仍返回空文档（UI 侧不被牵连）', async (t) => {
  const { api, dataDir } = await mkApi(t, 'defectB-unit');
  const pid = await newProfile(api, '单元检查');
  const gid = 'notegame3';
  const annDir = path.join(dataDir, 'profiles', pid, 'annotations');
  fs.mkdirSync(annDir, { recursive: true });

  // 缺失：strict 与默认都应是空文档（不抛错）
  const missStrict = api.annotations.get(pid, gid, { strict: true });
  assert.strictEqual(missStrict.seats && Object.keys(missStrict.seats).length, 0, '缺失时 strict 读仍是空文档');
  assert.strictEqual(missStrict.revision, 0, '缺失时 revision 应为 0');

  // 坏档：strict 抛 {code:500}；默认仍返回空文档（UI/put 的既有行为不变）
  fs.writeFileSync(path.join(annDir, gid + '.json'), 'not json at all');
  assert.throws(
    () => api.annotations.get(pid, gid, { strict: true }),
    (e) => {
      assert.strictEqual(e.code, 500, 'strict 读坏档必须是 500');
      assert.match(e.message, /笔记文件损坏/, '错误必须说明是笔记文件损坏');
      return true;
    },
    'strict 读坏档必须抛错',
  );
  const lenient = api.annotations.get(pid, gid);
  assert.strictEqual(lenient.revision, 0, '默认读（UI 侧）遇坏档仍回空文档 —— 既有语义不得改变');
  assert.strictEqual(lenient.seats && Object.keys(lenient.seats).length, 0);
});
