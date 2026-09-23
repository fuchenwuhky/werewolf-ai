/**
 * r05-archive-contract.test.js — R05：归档规则在服务端只有**一份**定义
 *
 * 契约登记在 docs/dual-platform-optimization-plan.md §3.1「归档」那一条（先登记、后改测试）：
 *   · 有未结束（进行中／待保存）对局的档案**不可归档**，也不可进回收站；
 *   · 最终判定在服务端（前端 archiveBlockReason() 只是预检）；
 *   · 未结束局计数 = 内存 ∪ 磁盘，同 id 以**内存**为准（内存权威、磁盘快照）；
 *   · 判定与写盘在同一个档案级串行周期内 —— 与建局排同一条队，所以并发下不会出现
 *     "归档成功之后又冒出一局无归属的未结束局"。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const events = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const Api = require('../src/api').Api || require('../src/api');
const { makeDataDir, savesOf, terminateApi } = require('./helpers-tmpdir');

// 建局路径要用 logger.openGameLog()：返回一个同样静音的子 logger（与仓库既有静音夹具同形）
const quiet = () => ({ debug() {}, info() {}, warn() {}, error() {}, openGameLog: quiet });
const silentLogger = quiet();
const BOARD5 = { wolf: 1, villager: 3, seer: 1 };
const players5 = () => ([
  { seat: 1, name: '我', isHuman: true, role: 'seer' },
  { seat: 2, name: 'A', isHuman: false, role: 'wolf' },
  { seat: 3, name: 'B', isHuman: false, role: 'villager' },
  { seat: 4, name: 'C', isHuman: false, role: 'villager' },
  { seat: 5, name: 'D', isHuman: false, role: 'villager' },
]);

function makeApi(tag) {
  const dataDir = makeDataDir(tag);
  const savesDir = savesOf(dataDir);
  const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: savesDir });
  return { api, dataDir, savesDir };
}

async function callApi(api, method, pathname, raw) {
  const u = new URL(pathname, 'http://localhost');
  const req = new events.EventEmitter();
  req.method = method;
  req.headers = { host: 'localhost:3210' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const box = { headers: {} };
  box.res = {
    writeHead(code, h) { box.code = code; Object.assign(box.headers, h || {}); },
    end(b) { box.raw = b; },
    setHeader(k, v) { box.headers[k.toLowerCase()] = v; },
  };
  process.nextTick(() => {
    if (raw !== undefined && raw !== null) req.emit('data', raw);
    req.emit('end');
  });
  await api.handle(req, box.res, u.pathname, u.searchParams);
  const text = box.raw != null ? String(box.raw) : null;
  return { status: box.code, text, body: text ? JSON.parse(text) : null };
}
const patch = (api, pid, body) => callApi(api, 'PATCH', `/api/profiles/${pid}`, Buffer.from(JSON.stringify(body), 'utf8'));
const post = (api, p, body) => callApi(api, 'POST', p, Buffer.from(JSON.stringify(body), 'utf8'));

function saveDoc(id, pid, { started = true, finished = false, savedAt = 1 } = {}) {
  return {
    schemaVersion: 2, tokens: {}, mock: true, ownerProfileId: pid, ownerNicknameSnapshot: '归档客', profileSchemaVersion: 1,
    game: {
      id, day: 1, phase: finished ? 'ended' : 'night', started, finished, winner: finished ? 'good' : null, winReason: '',
      players: [{ seat: 1, name: '我', isHuman: true, role: 'seer' }, { seat: 2, name: 'A', isHuman: false, role: 'wolf' }],
      events: [], board: BOARD5, rules: {},
    },
    anchor: null, review: null, savedAt,
  };
}
const mkProfile = async (api, nickname) => (await post(api, '/api/profiles', { nickname })).body.profile.id;

test('R05：磁盘上有未结束局 ⇒ 归档被拒（服务端最终判定，文案与前端一致）', async () => {
  const { api, dataDir, savesDir } = makeApi('r05-disk');
  try {
    await api._profileMigrationReady;
    const pid = await mkProfile(api, '磁盘未结束');
    fs.writeFileSync(path.join(savesDir, 'r05-disk-1.json'), JSON.stringify(saveDoc('r05-disk-1', pid)));

    const r = await patch(api, pid, { archive: true });
    assert.strictEqual(r.status, 400, `有未结束局必须拒绝归档（实际 ${r.status}：${r.text}）`);
    assert.match(r.body.error, /未结束的对局/, '原因必须说明还有未结束的对局');
    assert.match(r.body.error, /还有 1 局未结束/, `必须报出准确局数（实际：${r.body.error}）`);
    assert.strictEqual(api.profiles.get(pid).archivedAt, null, '被拒后档案不得带上归档标记');

    // 结算后立刻放行（证明不是"一律拒归档"）
    fs.writeFileSync(path.join(savesDir, 'r05-disk-1.json'), JSON.stringify(saveDoc('r05-disk-1', pid, { finished: true })));
    const ok = await patch(api, pid, { archive: true });
    assert.strictEqual(ok.status, 200, `结算后必须放行归档（实际 ${ok.status}：${ok.text}）`);
    assert.ok(ok.body.profile.archivedAt, '归档成功必须写回 archivedAt');
  } finally { await terminateApi(api, dataDir); }
});

test('R05：内存里的未结束局同样拦住归档（内存 ∪ 磁盘）', async () => {
  const { api, dataDir } = makeApi('r05-mem');
  try {
    await api._profileMigrationReady;
    const pid = await mkProfile(api, '内存未结束');
    const created = await post(api, '/api/games', { board: BOARD5, players: players5(), mock: true, profileId: pid });
    assert.strictEqual(created.status, 200, created.text);
    const gid = created.body.gameId;
    const entry = api.games.get(gid);
    entry.game.started = true;
    entry.game.finished = false;

    const r = await patch(api, pid, { archive: true });
    assert.strictEqual(r.status, 400, `内存里有未结束局也必须拒绝归档（实际 ${r.status}：${r.text}）`);
    assert.match(r.body.error, /未结束的对局/);

    entry.game.finished = true;
    entry.game.phase = 'ended';
    const ok = await patch(api, pid, { archive: true });
    assert.strictEqual(ok.status, 200, `结算后放行（实际 ${ok.status}：${ok.text}）`);
  } finally { await terminateApi(api, dataDir); }
});

test('R05：同 id 以内存为准 —— 内存已结算、磁盘快照滞后时不算未结束', async () => {
  const { api, dataDir } = makeApi('r05-authority');
  try {
    await api._profileMigrationReady;
    const pid = await mkProfile(api, '内存权威');
    const created = await post(api, '/api/games', { board: BOARD5, players: players5(), mock: true, profileId: pid });
    const gid = created.body.gameId;
    const entry = api.games.get(gid);
    entry.game.started = true;
    entry.game.finished = false;
    await api.saveGame(entry, { force: true });           // 磁盘快照：进行中
    entry.game.finished = true;                           // 内存：已结算（快照还没跟上）
    entry.game.phase = 'ended';

    const { active } = api._activeGameCount(pid);
    assert.strictEqual(active, 0, '内存已结算 ⇒ 这局不算未结束（内存是权威、磁盘是快照）');
    const r = await patch(api, pid, { archive: true });
    assert.strictEqual(r.status, 200,
      `内存已结算时不得因为磁盘快照滞后就把档案锁死（实际 ${r.status}：${r.text}）`);
  } finally { await terminateApi(api, dataDir); }
});

test('R05：坏档按保守拒绝归档（读不出就无法排除它是本档案的未结束局）', async () => {
  const { api, dataDir, savesDir } = makeApi('r05-corrupt');
  try {
    await api._profileMigrationReady;
    const pid = await mkProfile(api, '坏档');
    fs.writeFileSync(path.join(savesDir, 'r05-broken.json'), '{"schemaVersion":2,"game":{');

    const r = await patch(api, pid, { archive: true });
    assert.strictEqual(r.status, 400, `有读不出的存档必须保守拒绝归档（实际 ${r.status}：${r.text}）`);
    assert.match(r.body.error, /读不出的存档/, '原因必须点名"读不出的存档"');
    assert.match(r.body.error, /r05-broken\.json/, '原因必须点名文件');
    assert.strictEqual(api.profiles.get(pid).archivedAt, null, '被拒后档案必须原样');

    fs.rmSync(path.join(savesDir, 'r05-broken.json'));
    const ok = await patch(api, pid, { archive: true });
    assert.strictEqual(ok.status, 200, `移走坏档后必须放行（实际 ${ok.status}：${ok.text}）`);
  } finally { await terminateApi(api, dataDir); }
});

test('R05：归档与建局/开始共用同一串行边界 —— 并发下不会"归档成功后还有未结束的局"', async () => {
  const { api, dataDir } = makeApi('r05-race');
  try {
    await api._profileMigrationReady;
    // ① 建局 vs 归档：两个请求同时出发
    for (let i = 0; i < 3; i++) {
      const pid = await mkProfile(api, `竞态-建局${i}`);
      const [arch, made] = await Promise.all([
        patch(api, pid, { archive: true }),
        post(api, '/api/games', { board: BOARD5, players: players5(), mock: true, profileId: pid }),
      ]);
      assert.ok([200, 400].includes(arch.status) && [200, 400].includes(made.status),
        `两个请求都必须给出确定结果（归档 ${arch.status} / 建局 ${made.status}）`);
      const prof = api.profiles.get(pid);
      const { active } = api._activeGameCount(pid);
      assert.ok(!(prof && prof.archivedAt && active > 0),
        `第 ${i} 轮非法终局：档案已归档但仍有 ${active} 局未结束（归档=${arch.status} / 建局=${made.status}）`);
    }
    // ② 开始对局 vs 归档：这一格才是真正会"事后才变成未结束"的窗口
    for (let i = 0; i < 3; i++) {
      const pid = await mkProfile(api, `竞态-开始${i}`);
      const made = await post(api, '/api/games', { board: BOARD5, players: players5(), mock: true, profileId: pid });
      assert.strictEqual(made.status, 200, made.text);
      const gid = made.body.gameId;
      const [arch, started] = await Promise.all([
        patch(api, pid, { archive: true }),
        callApi(api, 'POST', `/api/games/${gid}/start`, Buffer.from(JSON.stringify({ token: made.body.playerToken }), 'utf8')),
      ]);
      const prof = api.profiles.get(pid);
      const entry = api.games.get(gid);
      if (entry) entry.running = false; // 只验状态，不让 mock 局继续跑
      if (prof && prof.archivedAt) {
        assert.notStrictEqual(started.status, 200,
          `第 ${i} 轮：档案已归档，这局却被开始成功（归档=${arch.status} / 开始=${started.status}）`
          + ' ⇒ 归档后冒出一局未结束的局，它会再也回不到任何档案名下');
      }
      const { active } = api._activeGameCount(pid);
      assert.ok(!(prof && prof.archivedAt && active > 0),
        `第 ${i} 轮非法终局：档案已归档但仍有 ${active} 局未结束（归档=${arch.status} / 开始=${started.status}）`);
    }
  } finally { await terminateApi(api, dataDir); }
});

test('R05：恢复（restore）不受未结束局限制 —— 旧版本留下的"已归档+进行中"存量可救回', async () => {
  const { api, dataDir, savesDir } = makeApi('r05-restore');
  try {
    await api._profileMigrationReady;
    const pid = await mkProfile(api, '存量可救');
    fs.writeFileSync(path.join(savesDir, 'r05-legacy.json'), JSON.stringify(saveDoc('r05-legacy', pid)));
    // 直接写库造出旧版本可能留下的非法存量态（新契约下 API 已不可能产出）
    await api.profiles._updateInner(pid, { archive: true });
    assert.ok(api.profiles.get(pid).archivedAt, '前置：档案确实处于归档态');

    const back = await patch(api, pid, { restore: true });
    assert.strictEqual(back.status, 200, `恢复必须放行（实际 ${back.status}：${back.text}）`);
    assert.strictEqual(back.body.profile.archivedAt, null, '恢复后归档标记必须取消');
    // 恢复即用：能重新看到这局（而不是"档案回来了但数据看不见"）
    const list = await callApi(api, 'GET', `/api/profiles/${pid}/games?limit=10`);
    assert.strictEqual(list.status, 200, list.text);
    assert.deepStrictEqual((list.body.rows || []).map((x) => x.id), ['r05-legacy']);
  } finally { await terminateApi(api, dataDir); }
});
