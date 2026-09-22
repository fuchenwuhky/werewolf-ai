/**
 * export-corrupt-save.test.js — 「缺陷 A」的永久钉桩（2026-09-22，主控）
 *
 * 缺陷（主控用一个独立探针在真 HTTP 服务上实测复现）：
 *   同一份数据目录上，`GET /api/profiles/<pid>/games` 因坏档返回 **500 + 点名文件**，
 *   而 `GET /api/profiles/<pid>/export` 却返回 **200**、`manifest.counts.games` 静默少报一局、
 *   没有任何 error。
 *   根因：`src/profiles/transfer.js` 的 `collectExportableGames` 在 `JSON.parse` 失败时
 *   `catch (_) { continue; }` —— 坏档被当成"没有这一局"；而列表路由走 `_readSaveDocStrict`
 *   会明确报错，两条路由口径不一致。
 *   影响：用户看到"导出成功"，随后归档/删除该档案，这一局就再没有任何出口 —— 静默丢数据。
 *   违反计划书 §6「损坏数据返回明确错误，不能伪装成空列表」与 §2「发现数据丢失必须立即修复」。
 *
 * 修法（最小、默认不改语义）：
 *   - `collectExportableGames(savesDir, ownerProfileId, { strict = false } = {})`：strict 时抛
 *     `{ code: 500 }`，默认仍 `continue`；
 *   - `src/api.js#profileExport` 传 `{ strict: true }`。
 *
 * 本文件**两侧都钉**：① strict ⇒ 拒绝并点名文件；② 默认 ⇒ 保持既有宽容语义；
 * ③ 路由层：有坏档 ⇒ 500 且与列表口径一致；④ 路由层：没有坏档 ⇒ 仍 200 且计数正确（防过度拒绝）。
 *
 * ⚠ 假请求/假响应照 `test/profiles-api.test.js:74-110` 的**已验证形状**写，两处易错点：
 *   1) `req.headers` 必须带 `host`（缺了会在路由里 `undefined.match` 崩）；
 *   2) `api.handle` 是**四参**：`(req, res, cleanPath, query)` —— 只传两参会让 cleanPath
 *      为 undefined，路由里 `cleanPath.match(...)` 直接崩；
 *   3) body 必须在 `process.nextTick` 里 emit（同步 emit 时 api.handle 还没挂监听器）；
 *   4) 建完 Api 先 `await api._profileMigrationReady`（构造期的档案迁移仍在写 profiles/index.json，
 *      不等就与"创建档案 / 归档删除"抢占时序）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const events = require('events');

const transfer = require('../src/profiles/transfer');
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
  const req = stubReq({ method, headers: Object.assign({}, HOST), body });
  await api.handle(req, box.res, u.pathname, u.searchParams);
  const headers = {};
  for (const [k, v] of Object.entries(box.headers)) headers[k.toLowerCase()] = v;
  const raw = box.raw != null ? String(box.raw) : null;
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { /* 非 JSON 响应时留 null */ }
  return { status: box.code, headers, raw, body: parsed };
}

/** 可导出的最小已结束局存档（字段结构照 transfer.collectExportableGames 的消费面） */
function mkSave(id, ownerProfileId, finished) {
  return JSON.stringify({
    schemaVersion: 2,
    mock: true,
    ownerProfileId,
    savedAt: '2026-09-22T00:00:00.000Z',
    game: { id, players: [], started: true, finished, day: 1, winner: 'good' },
  });
}

async function mkApi(t, tag) {
  const dataDir = makeDataDir(tag);
  const dir = savesOf(dataDir);
  const ref = { api: null };
  terminateAfter(t, () => ref.api, dataDir);       // ⚠ 先挂清理，构造抛错也不漏删
  ref.api = makeApiIn(dataDir, { config: { get: () => ({ apiKey: '', journal: false }), save() {} } }).api;
  await ref.api._profileMigrationReady;            // ⚠ 不等迁移会与建档/归档抢占时序
  return { api: ref.api, dir, dataDir };
}

test('缺陷 A①：strict 模式下坏档必须抛错（点名文件、code=500）', () => {
  const dataDir = makeDataDir('defectA-unit');
  try {
    const dir = savesOf(dataDir);
    const pid = '11111111-2222-3333-4444-555555555555';
    fs.writeFileSync(path.join(dir, 'good.json'), mkSave('good', pid, true));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ "ownerProfileId": ');   // 截断的坏 JSON

    assert.throws(
      () => transfer.collectExportableGames(dir, pid, { strict: true }),
      (e) => {
        assert.strictEqual(e.code, 500, '必须是 500（与列表路由的"明确错误"同档）');
        assert.match(e.message, /broken\.json/, '错误必须点名是哪个文件');
        assert.match(e.message, /不是合法 JSON/, '错误必须说明是坏 JSON');
        return true;
      },
      'strict 模式下坏档必须抛错（否则导出会静默少数据）',
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('缺陷 A②：默认模式保持既有宽容语义（坏档被跳过，不改变其它调用方）', () => {
  const dataDir = makeDataDir('defectA-default');
  try {
    const dir = savesOf(dataDir);
    const pid = '11111111-2222-3333-4444-555555555555';
    fs.writeFileSync(path.join(dir, 'good.json'), mkSave('good', pid, true));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ "ownerProfileId": ');

    const games = transfer.collectExportableGames(dir, pid);   // 两个参数：既有调用方式
    assert.deepStrictEqual(games.map((g) => g.id), ['good'], '默认仍跳过坏档（既有语义不变）');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('缺陷 A③：导出路由遇坏档返回 500 + 明确原因，且与列表口径一致', async (t) => {
  const { api, dir } = await mkApi(t, 'defectA-route');

  const c = await call(api, 'POST', '/api/profiles', { nickname: '坏档导出', avatarId: 'scholar', bio: '' });
  assert.strictEqual(c.status, 200, `创建档案失败：${c.raw}`);
  const pid = c.body.profile.id;

  fs.writeFileSync(path.join(dir, 'ok.json'), mkSave('ok', pid, true));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ "ownerProfileId": ');

  const list = await call(api, 'GET', `/api/profiles/${pid}/games`);
  assert.ok(list.status >= 500, `列表因坏档必须拒绝（实际 ${list.status}）`);
  assert.match(String(list.body && list.body.error), /损坏数据/, '列表必须说明是损坏数据');

  const exp = await call(api, 'GET', `/api/profiles/${pid}/export`);
  assert.strictEqual(exp.status, 500, `导出遇坏档必须 500（实际 ${exp.status}）—— 200 就是静默丢数据`);
  assert.match(String(exp.body && exp.body.error), /broken\.json/, '导出的错误必须点名坏档文件');
  assert.ok(!(exp.body && Array.isArray(exp.body.games)), '被拒绝时不得返回一个"少了一局"的包');
});

test('缺陷 A④：没有坏档时导出仍 200 且计数正确（防过度拒绝）', async (t) => {
  const { api, dir } = await mkApi(t, 'defectA-clean');

  const c = await call(api, 'POST', '/api/profiles', { nickname: '干净导出', avatarId: 'scholar', bio: '' });
  assert.strictEqual(c.status, 200, `创建档案失败：${c.raw}`);
  const pid = c.body.profile.id;

  fs.writeFileSync(path.join(dir, 'ok1.json'), mkSave('ok1', pid, true));
  fs.writeFileSync(path.join(dir, 'ok2.json'), mkSave('ok2', pid, true));
  fs.writeFileSync(path.join(dir, 'other.json'), mkSave('other', '99999999-8888-7777-6666-555555555555', true));
  fs.writeFileSync(path.join(dir, 'running.json'), mkSave('running', pid, false));

  const exp = await call(api, 'GET', `/api/profiles/${pid}/export`);
  assert.strictEqual(exp.status, 200, `干净数据目录必须导出成功：${exp.raw}`);
  assert.strictEqual(exp.body.manifest.counts.games, 2, '只收本档案的已结束局（别人 1 局、未结束 1 局都不算）');
  assert.deepStrictEqual(exp.body.games.map((g) => g.id).sort(), ['ok1', 'ok2'], '包内对局不得多也不得少');
});
