/**
 * profiles-touch.test.js — lastUsedAt 真正生效 + 排序语义（FIX-09 回归）
 *
 * 缺陷复述：`touch()`/`lastUsedAt` 是**死字段**——touch 没有任何调用者，而 `list()` 把
 * `lastUsedAt: prof.lastUsedAt || prof.updatedAt` 发给前端，于是档案列表（web/app.js:1110、
 * web/m/m.js:1185 都按 lastUsedAt 倒序）实际排的是"**最近编辑**"而不是"最近使用"；
 * 顺带 touch 自己还是"同步直写 + 吞错"，绕过原子写与串行队列（写到一半被杀 = 档案损坏）。
 *
 * 本次确定的语义（服务端可观测的"使用"只有一种）：
 *   lastUsedAt = **最近一次以这份档案开局**（客户端档案管理里的"选用"是纯本地状态，服务端看不到）
 *   updatedAt  = 最近一次编辑（改名/改偏好/归档恢复）
 *   从未使用过的档案 ⇒ lastUsedAt = createdAt（绝不是 updatedAt）
 *
 * 排序契约用**前端的比较器原文**在本文件里复算（两处前端排序一字不差），
 * 所以只要 list() 的字段语义退化，这里立刻红。
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

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {}, query() { return []; } };
const BOARD5 = { wolf: 1, seer: 1, witch: 1, villager: 2 };
const players5 = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: i === 0 }));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 前端档案列表的排序比较器原文（web/app.js:1110 与 web/m/m.js:1185 完全相同） */
function clientSort(rows) {
  return [...rows].sort((a, b) => (a.archivedAt ? 1 : 0) - (b.archivedAt ? 1 : 0)
    || String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')));
}

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

test('FIX-09（存储层）：touch 走串行队列 + 原子写，改昵称不改变排序、使用才改变排序', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-touch-'));
  try {
    const store = new ProfileStore({ dataDir, logger: silentLogger });
    const a = await store.create({ nickname: '甲' });
    await delay(15);
    const b = await store.create({ nickname: '乙' });
    // 从未使用过 ⇒ lastUsedAt 恰好等于 createdAt（不是 updatedAt、也不是 null）
    assert.strictEqual(a.lastUsedAt, a.createdAt, '新建档案的 lastUsedAt 必须等于 createdAt');
    assert.strictEqual(b.lastUsedAt, b.createdAt);
    assert.deepStrictEqual(clientSort(store.list()).map((p) => p.id), [b.id, a.id], '都没用过时按创建时间倒序（乙后建 → 在前）');

    // ① 使用甲 → 甲必须排到最前（"最近使用"优先于"最近创建"）
    await delay(15);
    const touched = await store.touch(a.id);
    assert.strictEqual(touched.lastUsedAt, store.get(a.id).lastUsedAt, 'touch 必须落盘（重读一致）');
    assert.strictEqual(touched.lastUsedAt > touched.updatedAt, true, 'touch 只动 lastUsedAt，且必须晚于上次编辑时间');
    assert.strictEqual(touched.updatedAt, a.updatedAt, 'touch 绝不能改 updatedAt（使用 ≠ 编辑）');
    assert.deepStrictEqual(clientSort(store.list()).map((p) => p.id), [a.id, b.id], '用过甲之后，甲必须排在乙前面');

    // ② 编辑乙（改名）→ **不得**改变排序：改名不是"使用"
    await delay(15);
    const renamed = await store.update(b.id, { nickname: '乙改名' });
    assert.strictEqual(renamed.updatedAt > a.lastUsedAt, true, '前置：乙的编辑时间确实晚于甲的使用时间（这条断言保证②有区分度）');
    assert.strictEqual(renamed.lastUsedAt, b.createdAt, '编辑不得推进 lastUsedAt');
    assert.deepStrictEqual(clientSort(store.list()).map((p) => p.id), [a.id, b.id], '改名绝不能把"最近编辑"顶成"最近使用"（旧实现正是在这里排反）');

    // ③ 归档档案的 touch 不写盘（不算使用，也不该被修改）
    const beforeArchive = store.get(b.id);
    await store.update(b.id, { archive: true });
    const archivedTouch = await store.touch(b.id);
    assert.strictEqual(archivedTouch.lastUsedAt, beforeArchive.lastUsedAt, '归档档案的 touch 不得改 lastUsedAt');
    await store.update(b.id, { restore: true });

    // ④ 并发 touch 不互相覆盖、也不破坏档案（走同一条串行队列）
    await Promise.all([store.touch(a.id), store.touch(b.id), store.touch(a.id)]);
    assert.strictEqual(store.get(a.id).nickname, '甲', '并发 touch 不得损坏档案内容');
    assert.strictEqual(store.get(b.id).nickname, '乙改名');
    for (const p of store.list()) assert.match(p.lastUsedAt, /^\d{4}-\d{2}-\d{2}T/, `lastUsedAt 必须是 ISO 时间：${p.lastUsedAt}`);
    // 不存在的档案：抛 NotFoundError（不静默成功）
    await assert.rejects(() => store.touch('00000000-0000-4000-8000-000000000000'), (e) => e.code === 404);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('FIX-09（HTTP 层）：建局 = 使用档案 → lastUsedAt 前进；touch 失败绝不让开局失败', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-touch-http-'));
  let api = null;
  try {
    api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: path.join(dataDir, 'saves') });
    await api._profileMigrationReady;
    const a = (await call(api, 'POST', '/api/profiles', { nickname: '甲' })).body.profile;
    const b = (await call(api, 'POST', '/api/profiles', { nickname: '乙' })).body.profile;
    const rowOf = async (id) => (await call(api, 'GET', '/api/profiles')).body.profiles.find((p) => p.id === id);

    assert.strictEqual((await rowOf(a.id)).lastUsedAt, a.createdAt, '未开局的档案 lastUsedAt = createdAt');

    // 用甲开一局（Mock，不花钱）
    await delay(15);
    const g = await call(api, 'POST', '/api/games', { board: BOARD5, mock: true, players: players5, profileId: a.id });
    assert.strictEqual(g.status, 200, JSON.stringify(g.body));
    const rowA = await rowOf(a.id);
    assert.strictEqual(rowA.lastUsedAt > rowA.updatedAt, true, '开局后 lastUsedAt 必须晚于 updatedAt（真的写进去了）');
    assert.strictEqual(rowA.updatedAt, a.updatedAt, '开局不得改 updatedAt');
    assert.deepStrictEqual(clientSort((await call(api, 'GET', '/api/profiles')).body.profiles).map((p) => p.id).slice(0, 1), [a.id], '开局后甲必须排最前');

    // 让 touch 必定失败：开局仍必须成功（使用痕迹不是关键数据）
    api.profiles.touch = async () => { throw Object.assign(new Error('EPERM: 注入写盘失败'), { code: 'EPERM' }); };
    const g2 = await call(api, 'POST', '/api/games', { board: BOARD5, mock: true, players: players5, profileId: b.id });
    assert.strictEqual(g2.status, 200, `touch 失败不得让开局失败：${JSON.stringify(g2.body)}`);
    assert.match(String(g2.body.gameId), /^g/, '失败注入后仍必须返回可用 gameId');
    assert.strictEqual(fs.existsSync(path.join(dataDir, 'saves', `${g2.body.gameId}.json`)), true, '对局存档必须真的落盘');
  } finally {
    if (api) { try { await api._profileMigrationReady; } catch (_) { /* 忽略 */ } clearInterval(api._saveTimer); clearInterval(api._streamTimer); }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
