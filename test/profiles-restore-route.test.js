/**
 * profiles-restore-route.test.js — 回收区列表 / 从回收区恢复 的 API 级集成测试（验收 P2）
 *
 * 背景：store.restoreFromTrash 早已实现，但没有任何 HTTP 路由暴露 —— 用户删掉档案后无法恢复。
 * 本文件只从 api.handle 真实分发路径验证两条新路由：
 *   GET  /api/profiles/trash
 *   POST /api/profiles/trash/<archiveId>/restore
 * 含"路由顺序"回归：/api/profiles/trash 绝不能被任何 /api/profiles/<id> 兜底吃掉（trash 不是 UUID）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const events = require('events');

const { Api } = require('../src/api');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {}, query() { return []; } };
const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `prestore-${tag}-`));

// 隔离布局：saveDir 嵌在独立 dataDir 下，ProfileStore 根 = <dataDir>/profiles。
// 平铺布局会让根落到共享的 os.tmpdir()/profiles，"回收区为空"这类全库断言会被别的测试污染。
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

/** 直接把 pathname 交给 api.handle（等价于 request-handler decodeURIComponent 之后的形态） */
async function callRaw(api, method, pathname, body, query = new URLSearchParams()) {
  const box = stubRes();
  const req = stubReq({ method, headers: { ...HOST }, body });
  await api.handle(req, box.res, pathname, query);
  const headers = {};
  for (const [k, v] of Object.entries(box.headers)) headers[k.toLowerCase()] = v;
  return { status: box.code, headers, raw: box.raw != null ? String(box.raw) : null, body: box.raw ? JSON.parse(box.raw) : null };
}

/** 走真实 URL 解析（含 query），与 server.js/request-handler 的入口一致 */
async function call(api, method, pathname, body) {
  const u = new URL(pathname, 'http://localhost');
  return callRaw(api, method, u.pathname, body, u.searchParams);
}

/** 建一份档案 → 归档 → 删除，返回 { pid, archiveId } */
async function makeTrashed(api, nickname) {
  const c = await call(api, 'POST', '/api/profiles', { nickname, avatarId: 'seer' });
  assert.strictEqual(c.status, 200, `建档案失败：${c.raw}`);
  const pid = c.body.profile.id;
  const ar = await call(api, 'PATCH', `/api/profiles/${pid}`, { archive: true });
  assert.strictEqual(ar.status, 200, `归档失败：${ar.raw}`);
  const del = await call(api, 'DELETE', `/api/profiles/${pid}`);
  assert.strictEqual(del.status, 200, `删除失败：${del.raw}`);
  assert.ok(del.body.archiveId, '删除必须返回 archiveId');
  assert.ok(String(del.body.archiveId).endsWith(pid), 'archiveId 应携带原档案 id（便于核对）');
  return { pid, archiveId: del.body.archiveId };
}

test('回收区路由：删除 → GET trash 可见且 restorable → POST restore 成功 → 档案回列表且 id 不变', async () => {
  const { api, dataDir } = makeIsolatedApi('restoreok');
  try {
    await api._profileMigrationReady; // 迁移产生的默认档案是"可归档"前提
    const { pid, archiveId } = await makeTrashed(api, '砚回收');

    // 删除后：GET /api/profiles 不再有它
    const goneList = await call(api, 'GET', '/api/profiles');
    assert.strictEqual(goneList.status, 200);
    assert.ok(!goneList.body.profiles.some((p) => p.id === pid), '已删除档案不得出现在档案列表');

    // 回收区可见（路由顺序回归：/api/profiles/trash 若被 /api/profiles/<id> 兜底吃掉会 404）
    const trash = await call(api, 'GET', '/api/profiles/trash');
    assert.strictEqual(trash.status, 200, `回收区列表应 200（实际 ${trash.status}：${trash.raw}）`);
    assert.ok(Array.isArray(trash.body.items), 'items 必须是数组');
    const hit = trash.body.items.find((t) => t.archiveId === archiveId);
    assert.ok(hit, `回收区必须列出刚删除的档案（实际 ${JSON.stringify(trash.body.items)}）`);
    assert.strictEqual(hit.restorable, true, '删完即可恢复 → restorable 必须为 true');
    assert.strictEqual(hit.id, pid, 'archiveId 必须能还原出原档案 id');
    assert.strictEqual(hit.nickname, '砚回收');
    assert.strictEqual(hit.state, 'trashed');

    // 恢复
    const rs = await call(api, 'POST', `/api/profiles/trash/${archiveId}/restore`);
    assert.strictEqual(rs.status, 200, `恢复应成功（实际 ${rs.status}：${rs.raw}）`);
    assert.strictEqual(rs.body.ok, true);
    assert.ok(rs.body.profile, '恢复必须返回档案摘要');
    assert.strictEqual(rs.body.profile.id, pid, '恢复后 id 必须不变');
    assert.strictEqual(rs.body.profile.nickname, '砚回收', '恢复后昵称必须不变');
    // 如实断言 store 的语义：restoreFromTrash 只把目录搬回原位并补索引，档案的归档状态原样保留
    // （删除前它就处于归档态）。要变成可用档案需再走一次 PATCH {restore:true} —— 下面验证这条路通。
    assert.ok(rs.body.profile.archivedAt, '恢复自动画态必须保留（删除前就是归档态）');

    // 回到档案列表
    const backList = await call(api, 'GET', '/api/profiles');
    assert.strictEqual(backList.status, 200);
    const back = backList.body.profiles.find((p) => p.id === pid);
    assert.ok(back, '恢复后档案必须回到 GET /api/profiles');
    assert.strictEqual(back.nickname, '砚回收');

    // 恢复出来的档案必须完全可用：取消归档 → stats 可达
    const unarchive = await call(api, 'PATCH', `/api/profiles/${pid}`, { restore: true });
    assert.strictEqual(unarchive.status, 200, `恢复后取消归档应成功：${unarchive.raw}`);
    assert.strictEqual(unarchive.body.profile.archivedAt, null);
    const st = await call(api, 'GET', `/api/profiles/${pid}/stats`);
    assert.strictEqual(st.status, 200, `恢复出来的档案 stats 必须可达（实际 ${st.status}）`);

    // 磁盘：目录回到原位且 profile.json 完整
    const restoredFile = path.join(api.profiles.root, pid, 'profile.json');
    assert.ok(fs.existsSync(restoredFile), '档案目录必须搬回原位');
    assert.strictEqual(JSON.parse(fs.readFileSync(restoredFile, 'utf8')).id, pid);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('恢复路由：重复恢复 404；不存在的 archiveId 404（绝不当成成功）', async () => {
  const { api, dataDir } = makeIsolatedApi('restore404');
  try {
    await api._profileMigrationReady;
    const { archiveId } = await makeTrashed(api, '砚重复');

    const first = await call(api, 'POST', `/api/profiles/trash/${archiveId}/restore`);
    assert.strictEqual(first.status, 200, `首次恢复应成功：${first.raw}`);

    const again = await call(api, 'POST', `/api/profiles/trash/${archiveId}/restore`);
    assert.strictEqual(again.status, 404, `重复恢复必须 404（实际 ${again.status}：${again.raw}）`);
    assert.strictEqual(again.body.ok, undefined, '失败响应绝不能带 ok:true');
    assert.ok(again.body.error, '错误响应必须带 error 说明');

    const missing = await call(api, 'POST', '/api/profiles/trash/1700000000000-no-such-archive/restore');
    assert.strictEqual(missing.status, 404, `不存在的 archiveId 必须 404（实际 ${missing.status}：${missing.raw}）`);
    assert.ok(missing.body.error, '错误响应必须带 error 说明');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('恢复路由：非法 archiveId（路径穿越 / 含斜杠）400，且绝不触碰文件系统', async () => {
  const { api, dataDir } = makeIsolatedApi('badid');
  try {
    await api._profileMigrationReady;
    // 诱饵：restoreFromTrash 若不做白名单，path.join(trashDir, '../etc') 会落到 <dataDir>/profiles/etc，
    // 那里放一份"看起来合法"的回收记录 —— 一旦恢复成功就说明穿越真的发生了。
    const baitId = '11111111-2222-4333-8444-555555555555';
    const bait = path.join(api.profiles.root, 'etc');
    fs.mkdirSync(path.join(bait, 'profile-dir'), { recursive: true });
    fs.writeFileSync(path.join(bait, 'restore.json'), JSON.stringify({
      id: baitId, state: 'trashed', profile: { id: baitId, nickname: '诱饵' }, trashedAt: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(bait, 'profile-dir', 'profile.json'), JSON.stringify({ id: baitId, nickname: '诱饵' }));

    const mutations = [];
    const reads = [];
    const spy = (name) => { const real = fs[name]; fs[name] = (...a) => { mutations.push({ fn: name, a: a.map(String) }); return real(...a); }; return () => { fs[name] = real; }; };
    const spyRead = (name) => { const real = fs[name]; fs[name] = (...a) => { if (a.length && String(a[0]).startsWith(dataDir)) reads.push({ fn: name, a: String(a[0]) }); return real(...a); }; return () => { fs[name] = real; }; };
    const undo = [spy('renameSync'), spy('writeFileSync'), spy('rmSync'), spy('unlinkSync'), spyRead('readFileSync'), spyRead('readdirSync')];
    let badTraversal, badSlash, badEncoded;
    try {
      // request-handler 会先 decodeURIComponent：%2e%2e%2fetc → ../etc
      badTraversal = await callRaw(api, 'POST', '/api/profiles/trash/../etc/restore');
      badSlash = await callRaw(api, 'POST', '/api/profiles/trash/a/b/restore');
      // 编码形态（真实 HTTP 请求体）；URL 不会把 %2e%2e%2f 当路径分隔符归一化
      badEncoded = await call(api, 'POST', '/api/profiles/trash/%2e%2e%2fetc/restore');
    } finally { for (const u of undo.reverse()) u(); }

    for (const [label, r] of [['../etc', badTraversal], ['a/b', badSlash], ['%2e%2e%2fetc', badEncoded]]) {
      assert.strictEqual(r.status, 400, `非法 archiveId ${label} 必须 400（实际 ${r.status}：${r.raw}）`);
      assert.match(r.body.error, /非法 archiveId/, `错误信息应说明 archiveId 非法（${label}）`);
    }
    assert.deepStrictEqual(mutations, [], '非法 archiveId 不得产生任何文件系统写/搬移/删除');
    assert.deepStrictEqual(reads, [], `非法 archiveId 不得读取数据目录下任何文件（实际 ${JSON.stringify(reads)}）`);

    // 诱饵原地未动，也没被恢复成档案
    assert.ok(fs.existsSync(path.join(bait, 'profile-dir', 'profile.json')), '诱饵目录绝不能被搬走');
    assert.ok(fs.existsSync(path.join(bait, 'restore.json')), '诱饵回收记录绝不能被消费');
    const list = await call(api, 'GET', '/api/profiles');
    assert.ok(!list.body.profiles.some((p) => p.id === baitId), '诱饵绝不能被恢复进档案列表');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('回收区列表：回收区为空时必须 200 + 空数组（不是 404，也不是 500）', async () => {
  const { api, dataDir } = makeIsolatedApi('emptytrash');
  try {
    await api._profileMigrationReady;
    assert.strictEqual(fs.existsSync(api.profiles.trashDir()), false, '前置条件：还没删过任何档案，回收区目录不存在');
    const trash = await call(api, 'GET', '/api/profiles/trash');
    assert.strictEqual(trash.status, 200, `空回收区应 200（实际 ${trash.status}：${trash.raw}）`);
    assert.deepStrictEqual(trash.body.items, [], '空回收区必须返回空数组');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
