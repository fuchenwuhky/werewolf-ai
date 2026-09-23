/**
 * m2d-trash-disk.test.js — M2-d：档案删除（移入回收区）的「进行中」判据必须同时看**磁盘存档**
 *
 * 缺口（改前实读）：`Api#trashProfile` 只遍历内存 `this.games` 计数。一局**只存在于存档**时
 * （服务重启过，或从锚点载入但还没 resume）数不到 ⇒ 该档案能被删掉、这局存档变成**孤儿**：
 * 没有任何一处会报错，它只是再也回不到任何档案名下（计划书 §2：发现数据丢失必须立即修复）。
 * 既有用例 `fin07-contracts.test.js` 的 R2 只覆盖内存路径（显式造内存条目、结算也改内存），
 * 所以磁盘情形此前**零覆盖** —— 本文件补的就是它。
 *
 * 覆盖四条：
 *   · 磁盘-only 未结束局 → 拒删（400 + 可读原因 + 档案与存档分毫不动）；
 *   · 同 gameId 内存与磁盘都有 → **只算一次**（与 `_profileGameRows` 的合并口径一致）；
 *   · 只拦本档案：别家档案的磁盘进行中局不连累我；
 *   · 坏档 = **保守拒绝**（fail-closed，文案点名文件），修好后立刻放行 —— 绝不当成"没有进行中"。
 * 另有一条内存路径的回归，保证这次只换计数来源、不换既有语义。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const events = require('events');

const { Api } = require('../src/api');
const { Game } = require('../src/engine/game');
const { makeDataDir, savesOf, terminateAfter } = require('./helpers-tmpdir');

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

function stubRes() {
  const box = { headers: {} };
  box.res = {
    writeHead(code, headers) { box.code = code; Object.assign(box.headers, headers || {}); },
    end(b) { box.raw = b; },
    setHeader(k, v) { box.headers[k.toLowerCase()] = v; },
  };
  return box;
}

async function call(api, method, pathname, body) {
  const u = new URL(pathname, 'http://localhost');
  const box = stubRes();
  const req = stubReq({ method, headers: { host: 'localhost:3210' }, body });
  await api.handle(req, box.res, u.pathname, u.searchParams);
  return { status: box.code, raw: box.raw != null ? String(box.raw) : null, body: box.raw ? JSON.parse(box.raw) : null };
}

const BOARD5 = { wolf: 1, seer: 1, witch: 1, villager: 2 };
const players5 = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: i === 0 }));

/** 服务端 API + 独占 dataDir（saveDir 恒为 <dataDir>/saves，绝不碰仓库的 saves/） */
function harness(t, tag) {
  const dataDir = makeDataDir(`m2d-${tag}`);
  let api = null;
  terminateAfter(t, () => api, dataDir); // 先等档案迁移收尾再删，失败路径同样生效
  api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: savesOf(dataDir) });
  return { api, dataDir, saves: savesOf(dataDir) };
}

async function mkProfile(api, nickname) {
  const r = await call(api, 'POST', '/api/profiles', { nickname });
  assert.strictEqual(r.status, 200, `建档案失败：${r.raw}`);
  return r.body.profile.id;
}

/**
 * 归档一个档案。R05 契约（docs/dual-platform-optimization-plan.md §3.1）下，
 * "有未结束局的档案"已经**不可能**通过 API 归档（服务端最终判定，前端预检只是第一道）。
 * 本文件的用例要验的是**回收站**那条规则（§5.2）在"只存在于磁盘的未结束局"场景下也成立，
 * 所以这里不把旧断言改绿，而是**两层都钉**：
 *   · 有未结束局 ⇒ API 归档必须 400（并给出可读原因）；
 *   · 然后用 store 内核（_updateInner）造出"已归档"态，继续验删除那条规则照样拦得住
 *     —— 那正是"如果有旧版本留下的非法存量态，纵深防御还在"的场景。
 * 没有未结束局时走 200，行为与从前一致。
 */
async function archive(api, pid) {
  const r = await call(api, 'PATCH', `/api/profiles/${pid}`, { archive: true });
  if (r.status === 200) return;
  assert.strictEqual(r.status, 400, `归档若被拒必须是 400（实际 ${r.status}：${r.raw}）`);
  assert.match(r.body.error, /未结束的对局/, '被拒原因必须说明还有未结束的对局');
  await api.profiles._updateInner(pid, { archive: true }); // 直接写库：造出"已归档 + 未结束局"的存量态
}

/**
 * 直接落一份"服务重启后只剩磁盘"的存档（照 saveGame 的 schema 手写）：
 * 关键是 ownerProfileId 归属 + game.started/game.finished —— 内存里**没有任何条目**。
 */
function writeDiskGame(saves, { id, owner, started, finished, file = `${id}.json` }) {
  const game = { id, day: 1, phase: 'night', started, finished, players: [{ seat: 1, isHuman: true }] };
  if (finished === undefined) delete game.finished; // 连字段都没有的旧档也必须按"未结束"算
  const doc = { schemaVersion: 2, ownerProfileId: owner, ownerNicknameSnapshot: null, tokens: { player: 'p', god: 'g' }, mock: true, game, anchor: { id, nextPhase: 'night' }, savedAt: Date.now() };
  fs.writeFileSync(path.join(saves, file), JSON.stringify(doc));
  return doc;
}

/** 造一局挂在内存里的 Mock 局（照 fin07-contracts.test.js 的成熟模式；不落盘） */
function makeMemoryGame(api, gid, ownerProfileId, { started = true, finished = false } = {}) {
  const g = new Game({ id: gid, board: BOARD5, players: players5.map((p) => ({ ...p })), stepPauseMs: 1, logger: silentLogger });
  g.deal();
  g.started = started;
  g.finished = finished;
  api.games.set(gid, { game: g, running: false, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, ownerProfileId, createdAt: Date.now(), lastAccess: Date.now(), review: null });
  return g;
}

// ---------- ① 核心：磁盘-only 的未结束局必须拦住删除（改前这里是绿的"放行"，即缺陷） ----------
test('M2-d ①磁盘-only 未结束局：拒删该档案（400 + 可读原因），档案与存档分毫不动', async (t) => {
  const { api, saves } = harness(t, 'diskonly');
  await api._profileMigrationReady;
  const pid = await mkProfile(api, '磁盘局主人');
  writeDiskGame(saves, { id: 'm2d-disk-1', owner: pid, started: true, finished: false });

  // 前置：这局确实存在、且确实归这份档案（否则后面的拒删可能只是"档案不存在"之类）
  const rows = await call(api, 'GET', `/api/profiles/${pid}/games`);
  assert.strictEqual(rows.status, 200, rows.raw);
  assert.deepStrictEqual(rows.body.rows.map((r) => r.id), ['m2d-disk-1'], '前置：仅磁盘存在的局必须被列出');
  assert.strictEqual(api.games.has('m2d-disk-1'), false, '前置：它必须只存在于磁盘（不在内存）');

  await archive(api, pid);
  const del = await call(api, 'DELETE', `/api/profiles/${pid}`);
  assert.strictEqual(del.status, 400, `磁盘上还有未结束的局，必须拒绝删除（实际 ${del.status}：${del.raw}）`);
  assert.match(del.body.error, /进行中/, '错误必须说明"仍有对局进行中"');
  assert.ok(api.profiles.get(pid), '被拒后档案必须原样保留');
  assert.deepStrictEqual(api.profiles.listTrash(), [], '被拒后回收区必须为空');
  assert.ok(fs.existsSync(path.join(saves, 'm2d-disk-1.json')), '被拒后存档必须原样在磁盘上');
});

// ---------- ② 缺 finished 字段的旧档也按"未结束"算（判据只认 finished === true） ----------
test('M2-d ②磁盘档没有 finished 字段：同样按未结束拒删（不因字段缺失就当已结算）', async (t) => {
  const { api, saves } = harness(t, 'nofin');
  await api._profileMigrationReady;
  const pid = await mkProfile(api, '旧档主人');
  writeDiskGame(saves, { id: 'm2d-nofin', owner: pid, started: true, finished: undefined });
  await archive(api, pid);
  const del = await call(api, 'DELETE', `/api/profiles/${pid}`);
  assert.strictEqual(del.status, 400, `缺 finished 字段的存档不许被当成已结算（实际 ${del.status}：${del.raw}）`);
  assert.match(del.body.error, /进行中/);
});

// ---------- ③ 反向：磁盘上已结算的局不拦（否则就是"一律拒删"的假修复） ----------
test('M2-d ③磁盘-only 已结算：放行删除（磁盘计数不是"有档就拦"）', async (t) => {
  const { api, saves } = harness(t, 'settled');
  await api._profileMigrationReady;
  const pid = await mkProfile(api, '已结算主人');
  writeDiskGame(saves, { id: 'm2d-done', owner: pid, started: true, finished: true });
  writeDiskGame(saves, { id: 'm2d-notstarted', owner: pid, started: false, finished: false });
  await archive(api, pid);
  const del = await call(api, 'DELETE', `/api/profiles/${pid}`);
  assert.strictEqual(del.status, 200, `已结算/未开始的局不该拦删除（实际 ${del.status}：${del.raw}）`);
  assert.ok(del.body.archiveId, '删除返回回收区 archiveId');
});

// ---------- ④ 去重：同 gameId 内存与磁盘都有 ⇒ 只算一次 ----------
test('M2-d ④去重：同 gameId 内存与磁盘都是进行中 ⇒ 只算 1 局（不重复计数）', async (t) => {
  const { api, saves } = harness(t, 'dedupe');
  await api._profileMigrationReady;
  const pid = await mkProfile(api, '去重主人');
  writeDiskGame(saves, { id: 'm2d-dup', owner: pid, started: true, finished: false });
  makeMemoryGame(api, 'm2d-dup', pid); // 同一 gameId 也在内存里跑着

  await archive(api, pid);
  const del = await call(api, 'DELETE', `/api/profiles/${pid}`);
  assert.strictEqual(del.status, 400, del.raw);
  assert.match(del.body.error, /仍有 1 局进行中/, `同一局内存+磁盘必须只算一次（实际文案：${del.body.error}）`);
});

// ---------- ⑤ 只拦本档案：别家档案的磁盘进行中局不连累我 ----------
test('M2-d ⑤归属隔离：别家档案的磁盘进行中局不拦我删除；我也照样被自己的磁盘局拦住', async (t) => {
  const { api, saves } = harness(t, 'scope');
  await api._profileMigrationReady;
  const mine = await mkProfile(api, '我');
  const other = await mkProfile(api, '别家');
  writeDiskGame(saves, { id: 'm2d-other-active', owner: other, started: true, finished: false });

  await archive(api, mine);
  const delMine = await call(api, 'DELETE', `/api/profiles/${mine}`);
  assert.strictEqual(delMine.status, 200, `别家档案的进行中局不该拦住我（实际 ${delMine.status}：${delMine.raw}）`);

  // 反向：我自己也有一局仅磁盘的进行中局 ⇒ 我同样被拦（证明上一条不是因为"磁盘计数整体没用"）
  const mine2 = await mkProfile(api, '我二');
  writeDiskGame(saves, { id: 'm2d-mine-active', owner: mine2, started: true, finished: false });
  await archive(api, mine2);
  const delMine2 = await call(api, 'DELETE', `/api/profiles/${mine2}`);
  assert.strictEqual(delMine2.status, 400, delMine2.raw);
  assert.match(delMine2.body.error, /进行中/);
});

// ---------- ⑥ 坏档：保守拒绝（fail-closed），绝不"读不出 = 没有进行中" ----------
test('M2-d ⑥坏档保守拒绝：读不出的存档拦下删除并点名文件，修好后立刻放行', async (t) => {
  const { api, saves } = harness(t, 'corrupt');
  await api._profileMigrationReady;
  const pid = await mkProfile(api, '坏档在场');
  await archive(api, pid);

  // 干净数据下先放行过一次？不 —— 直接验证"坏档前 / 坏档后 / 移除后"三段，前提最省歧义
  fs.writeFileSync(path.join(saves, 'm2d-broken.json'), '{ "game": { "id": "m2d-broken", ');
  const del = await call(api, 'DELETE', `/api/profiles/${pid}`);
  assert.strictEqual(del.status, 400, `有读不出的存档时不许放行删除（实际 ${del.status}：${del.raw}）`);
  assert.match(del.body.error, /m2d-broken\.json/, `错误必须点名是哪一份文件：${del.body.error}`);
  assert.match(del.body.error, /不是合法 JSON/, `错误必须给出可读原因：${del.body.error}`);
  assert.doesNotMatch(del.body.error, /进行中/, '坏档拒删与"确有进行中局"必须是两种可区分的文案');
  assert.ok(api.profiles.get(pid), '被拒后档案必须原样保留');

  // 修好（移除）坏档 ⇒ 同一请求立刻放行：证明上面的 400 是坏档造成的，不是恒拒
  fs.rmSync(path.join(saves, 'm2d-broken.json'));
  const del2 = await call(api, 'DELETE', `/api/profiles/${pid}`);
  assert.strictEqual(del2.status, 200, `坏档移除后必须放行（实际 ${del2.status}：${del2.raw}）`);
});

// ---------- ⑦ 内存路径既有语义不回退（换计数来源不许换行为） ----------
test('M2-d ⑦内存路径不回退：内存进行中局拒删并发可读原因，结算后放行', async (t) => {
  const { api } = harness(t, 'memkeep');
  await api._profileMigrationReady;
  const pid = await mkProfile(api, '内存局主人');
  makeMemoryGame(api, 'm2d-mem-1', pid);
  await archive(api, pid);

  const del = await call(api, 'DELETE', `/api/profiles/${pid}`);
  assert.strictEqual(del.status, 400, `内存进行中局必须拒删（实际 ${del.status}：${del.raw}）`);
  assert.match(del.body.error, /进行中/, '错误文案必须仍可被 /进行中/ 匹配（既有契约）');
  assert.ok(api.profiles.get(pid), '被拒后档案必须原样保留');

  api.games.get('m2d-mem-1').game.finished = true;
  api.games.get('m2d-mem-1').game.phase = 'ended';
  const del2 = await call(api, 'DELETE', `/api/profiles/${pid}`);
  assert.strictEqual(del2.status, 200, `结算后必须放行（实际 ${del2.status}：${del2.raw}）`);
});

// ---------- ⑧ 端到端"服务重启过"：存档由生产 saveGame() 写，第二个 Api 内存为空 ----------
test('M2-d ⑧端到端重启：生产 saveGame 落下的进行中存档，在内存为空的第二个 Api 上同样拒删', async (t) => {
  const dataDir = makeDataDir('m2d-restart');
  const saves = savesOf(dataDir);
  let api2 = null;
  terminateAfter(t, () => api2, dataDir); // 第一个 Api 的迁移在下面被显式等待过
  const api1 = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: saves });
  await api1._profileMigrationReady;
  const pid = await mkProfile(api1, '重启前的人');
  const g = await call(api1, 'POST', '/api/games', { board: BOARD5, mock: true, players: players5, profileId: pid });
  assert.strictEqual(g.status, 200, g.raw);
  const gid = g.body.gameId;
  const entry = api1.games.get(gid);
  entry.game.deal();
  entry.game.started = true; // 开局中、未结算
  await api1.saveGame(entry, { force: true }); // 走**生产**存档路径落盘（不是测试手写的 doc）

  // 前置：磁盘上确实是"进行中 + 归属该档案"，且这份档是上面那次 saveGame 写出来的
  const doc = JSON.parse(fs.readFileSync(path.join(saves, `${gid}.json`), 'utf8'));
  assert.strictEqual(doc.ownerProfileId, pid, '前置：存档归属该档案');
  assert.strictEqual(doc.game.started, true, '前置：存档是进行中');
  assert.strictEqual(doc.game.finished, false, '前置：存档未结算');

  // "重启服务端"：同一份数据目录上起第二个 Api —— 内存里一局都没有，这局只能在磁盘上找到
  api2 = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: saves });
  await api2._profileMigrationReady;
  assert.strictEqual(api2.games.size, 0, '前置：新进程内存为空');
  const rows = await call(api2, 'GET', `/api/profiles/${pid}/games`);
  assert.strictEqual(rows.status, 200, rows.raw);
  assert.deepStrictEqual(rows.body.rows.map((r) => r.id), [gid], '前置：重启后这局仍归属该档案（只在磁盘上）');

  // R05 契约：重启后（内存为空）这局仍被认成未结束 ⇒ **API 归档先被拒**；删除那条规则用
  // store 内核造出归档态后继续验（两层都钉，而不是把旧断言改绿）。
  const ar = await call(api2, 'PATCH', `/api/profiles/${pid}`, { archive: true });
  assert.strictEqual(ar.status, 400, `有未结束局必须拒绝归档（实际 ${ar.status}：${ar.raw}）`);
  assert.match(ar.body.error, /未结束的对局/);
  await api2.profiles._updateInner(pid, { archive: true });
  const del = await call(api2, 'DELETE', `/api/profiles/${pid}`);
  assert.strictEqual(del.status, 400, `重启后仅存于存档的进行中局必须拦住删除（实际 ${del.status}：${del.raw}）`);
  assert.match(del.body.error, /进行中/);
  assert.ok(api2.profiles.get(pid), '被拒后档案必须原样保留');
  assert.deepStrictEqual(api2.profiles.listTrash(), [], '被拒后回收区必须为空');
});
