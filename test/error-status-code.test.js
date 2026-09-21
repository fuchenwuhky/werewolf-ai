/**
 * error-status-code.test.js — 「fs 错误码被当成 HTTP 状态码写出去」缺陷的回归（验收 P2）
 *
 * 缺陷：多处 catch 写的是 `this.json(res, e.code || 500, …)`。Node 的 fs/系统错误 `.code` 是
 * **字符串**（'EPERM' / 'EBUSY' / 'ENOENT' / 'ENOTEMPTY'…），于是被直接喂给 `res.writeHead()`，
 * 客户端读到的是 `status === 'EPERM'` —— 并发测试里表现为用例随机挂，排查成本极高。
 *
 * 修法：统一走 `Api#statusOf(e, fallback)`（100–599 的整数照用，其余回落 fallback），
 * 并在唯一写 JSON 响应的出口 `json()` 再兜一次底。
 *
 * 本文件从 api.handle 的真实分发路径验证两件事：
 *   ① 注入字符串错误码 → HTTP 状态是**数字 500**，且响应体仍是结构化 JSON 错误；
 *   ② 业务语义错误（400/404/409）原样透传，绝不因归一化被改成 500。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const events = require('events');

const { Api } = require('../src/api');
const transfer = require('../src/profiles/transfer');
const { terminateAfter } = require('./helpers-tmpdir');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {}, query() { return []; } };
const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `perrcode-${tag}-`));

// 隔离布局：saveDir 嵌在独立 dataDir 下，ProfileStore 根 = <dataDir>/profiles（理由同 profiles-api.test.js）
function makeIsolatedApi(tag) {
  const dataDir = tmpDir(tag);
  const savesDir = path.join(dataDir, 'saves');
  const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: savesDir });
  return { api, dataDir, savesDir };
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
  const req = stubReq({ method, headers: { ...HOST }, body });
  await api.handle(req, box.res, u.pathname, u.searchParams);
  const headers = {};
  for (const [k, v] of Object.entries(box.headers)) headers[k.toLowerCase()] = v;
  return { status: box.code, headers, raw: box.raw != null ? String(box.raw) : null, body: box.raw ? JSON.parse(box.raw) : null };
}

/** 500 必须是"结构化 JSON 错误"：非空、可解析、带 error 文案、不是 HTML 兜底页 */
function assertStructured500(r, label) {
  assert.strictEqual(r.status, 500, `${label}：HTTP 状态必须是数字 500（实际 ${JSON.stringify(r.status)}）`);
  assert.strictEqual(typeof r.status, 'number', `${label}：状态码必须是 number，绝不能是字符串`);
  assert.ok(r.raw && r.raw.length > 0, `${label}：500 响应体不能为空`);
  assert.ok(!/^\s*</.test(r.raw), `${label}：500 响应体不能是 HTML（实际 ${r.raw.slice(0, 40)}）`);
  assert.match(String(r.headers['content-type'] || ''), /application\/json/, `${label}：Content-Type 必须是 JSON`);
  assert.ok(r.body && typeof r.body.error === 'string' && r.body.error.length > 0, `${label}：必须带 error 文案（实际 ${r.raw}）`);
}

test('错误码归一：底层写盘抛字符串码 EPERM → HTTP 状态是数字 500，不是 "EPERM"', async () => {
  const { api, dataDir } = makeIsolatedApi('create');
  const realCreate = api.profiles.create.bind(api.profiles);
  try {
    await api._profileMigrationReady;
    // 注入：底层写盘失败的真实形态（fs 错误的 code 是字符串）
    api.profiles.create = async () => { throw Object.assign(new Error('EPERM: injected rename index.json'), { code: 'EPERM' }); };

    const r = await call(api, 'POST', '/api/profiles', { nickname: '写盘失败' });
    assert.notStrictEqual(r.status, 'EPERM', '绝不能把字符串错误码当状态码写出去（原缺陷）');
    assertStructured500(r, 'POST /api/profiles');
    assert.match(r.body.error, /EPERM/, '错误文案必须保留原始原因，便于排查');

    // 同一规则也覆盖其它字符串码
    api.profiles.create = async () => { throw Object.assign(new Error('EBUSY: injected'), { code: 'EBUSY' }); };
    const r2 = await call(api, 'POST', '/api/profiles', { nickname: '占用中' });
    assertStructured500(r2, 'POST /api/profiles（EBUSY）');
    assert.match(r2.body.error, /EBUSY/);
  } finally {
    api.profiles.create = realCreate;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('错误码归一：导出路径（catch 里是 e.code || 500）遇字符串码同样回落 500', async () => {
  const { api, dataDir } = makeIsolatedApi('export');
  const realCollect = transfer.collectExportableGames;
  try {
    await api._profileMigrationReady;
    const c = await call(api, 'POST', '/api/profiles', { nickname: '导出故障' });
    assert.strictEqual(c.status, 200, `建档案应成功：${c.raw}`);
    const pid = c.body.profile.id;

    transfer.collectExportableGames = () => { throw Object.assign(new Error('EPERM: injected readdir'), { code: 'EPERM' }); };
    const r = await call(api, 'GET', `/api/profiles/${pid}/export`);
    assert.notStrictEqual(r.status, 'EPERM', '导出路径同样不得把字符串码当状态码');
    assertStructured500(r, 'GET /api/profiles/:id/export');
  } finally {
    transfer.collectExportableGames = realCollect;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('错误码归一：恢复路由（catch 里是 e.code || 400）遇字符串码回落 500 而非 400', async () => {
  const { api, dataDir } = makeIsolatedApi('restore');
  const realRestore = api.profiles.restoreFromTrash.bind(api.profiles);
  try {
    await api._profileMigrationReady;
    const c = await call(api, 'POST', '/api/profiles', { nickname: '恢复故障' });
    const pid = c.body.profile.id;
    await call(api, 'PATCH', `/api/profiles/${pid}`, { archive: true });
    const del = await call(api, 'DELETE', `/api/profiles/${pid}`);
    assert.strictEqual(del.status, 200, `删除应成功：${del.raw}`);

    api.profiles.restoreFromTrash = () => { throw Object.assign(new Error('EBUSY: injected rename'), { code: 'EBUSY' }); };
    const r = await call(api, 'POST', `/api/profiles/trash/${del.body.archiveId}/restore`);
    assert.notStrictEqual(r.status, 'EBUSY', '恢复路径不得把字符串码当状态码');
    assertStructured500(r, 'POST /api/profiles/trash/:id/restore');
  } finally {
    api.profiles.restoreFromTrash = realRestore;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('业务语义错误原样透传：ValidationError→400、NotFoundError→404、ConflictError→409', async () => {
  const { api, dataDir } = makeIsolatedApi('semantic');
  try {
    await api._profileMigrationReady;
    const c = await call(api, 'POST', '/api/profiles', { nickname: '语义码' });
    assert.strictEqual(c.status, 200, `建档案应成功：${c.raw}`);
    const pid = c.body.profile.id;

    // ValidationError(400)：store.create 的昵称校验（走 handle 的统一 catch）
    const bad = await call(api, 'POST', '/api/profiles', { nickname: '' });
    assert.strictEqual(bad.status, 400, `ValidationError 必须仍是 400（实际 ${bad.status}：${bad.raw}）`);
    assert.ok(bad.body.error, '400 必须带错误说明');

    // ValidationError(400)：updateProfile 的 catch（走 statusOf(e, 400)）
    const badPatch = await call(api, 'PATCH', `/api/profiles/${pid}`, { avatarId: '不存在的头像' });
    assert.strictEqual(badPatch.status, 400, `PATCH 校验失败必须仍是 400（实际 ${badPatch.status}：${badPatch.raw}）`);
    assert.strictEqual(badPatch.body.code, 400, '响应体应保留语义码 400');

    // NotFoundError(404)：不存在的档案（profileStats 的 catch）
    const missing = await call(api, 'GET', '/api/profiles/11111111-2222-4333-8444-555555555555/stats');
    assert.strictEqual(missing.status, 404, `NotFoundError 必须仍是 404（实际 ${missing.status}：${missing.raw}）`);

    // ConflictError(409)：expectedRevision 过期（updateProfile 的 catch）
    const stale = await call(api, 'PATCH', `/api/profiles/${pid}`, { nickname: '改名', expectedRevision: 9999 });
    assert.strictEqual(stale.status, 409, `ConflictError 必须仍是 409（实际 ${stale.status}：${stale.raw}）`);
    assert.strictEqual(stale.body.code, 409, '响应体应保留语义码 409');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('状态码取值规则：100–599 的整数照用，越界/非数字一律 500', async () => {
  const { api, dataDir } = makeIsolatedApi('bounds');
  const realCreate = api.profiles.create.bind(api.profiles);
  try {
    await api._profileMigrationReady;

    // 越界与非法值：不是合法 HTTP 状态码 → 500（不许把 42 / 600 直接写出去）
    for (const [code, label] of [[42, '42'], [600, '600'], [-1, '-1'], [0, '0']]) {
      api.profiles.create = async () => { throw Object.assign(new Error(`injected ${label}`), { code }); };
      const r = await call(api, 'POST', '/api/profiles', { nickname: '越界' });
      assertStructured500(r, `错误码 ${label}`);
    }
    api.profiles.create = async () => { throw Object.assign(new Error('no code at all'), {}); };
    assertStructured500(await call(api, 'POST', '/api/profiles', { nickname: '无码' }), '无 code');

    // 合法范围内的数值码照用（含 5xx：上游明确给出的服务端错误码不该被吞成 500 之外的值）
    api.profiles.create = async () => { throw Object.assign(new Error('upstream down'), { code: 503 }); };
    const r503 = await call(api, 'POST', '/api/profiles', { nickname: '上游故障' });
    assert.strictEqual(r503.status, 503, `100–599 的整数状态码必须照用（实际 ${r503.status}）`);
    assert.match(r503.body.error, /upstream down/);

    // 纯数字字符串码按整数处理（'404' → 404），不是回落 500
    api.profiles.create = async () => { throw Object.assign(new Error('string numeric'), { code: '404' }); };
    const rStr = await call(api, 'POST', '/api/profiles', { nickname: '字符串数字' });
    assert.strictEqual(rStr.status, 404, `纯数字字符串码应按整数处理（实际 ${rStr.status}）`);
  } finally {
    api.profiles.create = realCreate;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('chokepoint：json() 自身也不接受非法状态码（唯一写响应出口的兜底）', async (t) => {
  const { api, dataDir } = makeIsolatedApi('json');
  terminateAfter(t, api, dataDir); // 用例级清理（失败路径同样生效）
  try {
    assert.strictEqual(api.statusOf({ code: 'EPERM' }), 500);
    assert.strictEqual(api.statusOf({ code: 'EPERM' }, 400), 500, '有非数字码时不得用调用点的 400 兜底');
    assert.strictEqual(api.statusOf({ code: 'ENOTEMPTY' }), 500);
    assert.strictEqual(api.statusOf({ code: 400 }), 400);
    assert.strictEqual(api.statusOf({ code: 404, message: 'x' }), 404);
    assert.strictEqual(api.statusOf({ code: 409 }), 409);
    assert.strictEqual(api.statusOf(undefined), 500);
    assert.strictEqual(api.statusOf(undefined, 400), 400, '无码时沿用调用点默认（与修复前一致）');
    assert.strictEqual(api.statusOf({}, 400), 400);
    assert.strictEqual(api.statusOf({ code: 600 }), 500);
    assert.strictEqual(api.statusOf(200), 200);

    // 直接喂字符串码给 json()：写出去的仍是数字 500（兜底不依赖调用方自觉）
    const box = stubRes();
    api.json(box.res, 'EPERM', { error: 'injected' });
    assert.strictEqual(box.code, 500, `json() 必须把非法状态码归一（实际 ${JSON.stringify(box.code)}）`);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
