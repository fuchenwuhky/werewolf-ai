/**
 * import-near-limit.test.js — 导入的**上限内成功路径**（FIX-21）
 *
 * 验收报告的盲区：档案导入有体积上限（`src/profiles/transfer.js` 的 `MAX_BYTES` = 20 MiB，
 * 预览与导入同一上限），而现有用例**只覆盖"超限被拒"**（test/import-rollback.test.js 的 R07b：
 * MAX_BYTES + 1024 → 413）。这是最危险的一类盲区 —— 上限判断写错一个等号（`>` 写成 `>=`、
 * 或者在 2 MiB 的默认 readBody 限额上多做一次比较），正常用户的包就会在**上限之前**被拒，
 * 而现有测试全绿。
 *
 * 本文件把边界钉在"**刚好等于上限**"这一点上：
 *   · 包体恰好 MAX_BYTES 字节 → 导入必须 200 成功，且真的落了盘（不是假成功）；
 *   · 同一份包体走预览 → 同样 200（两侧同一上限，不能一个放行一个拒绝）；
 *   · 多局多笔记的大包（但远小于体积上限）→ 全部落地，没有隐藏的"数量闸"把正常包切掉。
 *
 * 反面（超限）由 R07b 守着，与本文件合起来才把上限两侧都钉住：
 *   恰好 MAX_BYTES → 200；MAX_BYTES + 1024 → 413。
 *
 * 说明：把包体补到"恰好等于上限"用的是顶层未知字段 `pad`。为什么可以这样：
 *   ① 上限比较的是**请求体字节数**（api.readBody 累加每个 chunk 的长度），用什么字段撑起来不影响这条判断；
 *   ② 导入包里出现未知顶层字段是允许的（validateImportPackage 只校验已知字段的类型）；
 *   ③ `pad` 不会进存档（importApplyRes 只挑 game 的字段写盘），所以这条用例不会在临时目录里写 20 MiB。
 * 夹具里会**自证**字节数恰好等于上限，避免"补多了/补少了"让用例悄悄失去边界意义。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const events = require('node:events');

const Api = require('../src/api').Api || require('../src/api');
const transfer = require('../src/profiles/transfer');
const { makeDataDir, savesOf, terminateApi } = require('./helpers-tmpdir');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** 独占 dataDir + 隔离 Api（照 test/profiles-api.test.js 的基建模式，避免落到共享 %TEMP% 路径） */
function makeApi(tag) {
  const dataDir = makeDataDir(tag);
  const savesDir = savesOf(dataDir);
  const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: savesDir });
  return { api, dataDir, savesDir };
}

/** 走真实 api.handle 分发（含 readBody 的体积闸与 mgmt/origin 门禁） */
async function callApi(api, method, pathname, raw) {
  const u = new URL(pathname, 'http://localhost');
  const req = new events.EventEmitter();
  req.method = method;
  req.headers = { host: 'localhost:3210' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const box = { headers: {} };
  box.res = {
    writeHead(code, headers) { box.code = code; Object.assign(box.headers, headers || {}); },
    end(b) { box.raw = b; },
    setHeader(k, v) { box.headers[k.toLowerCase()] = v; },
  };
  process.nextTick(() => {
    if (raw !== undefined && raw !== null) req.emit('data', raw);
    req.emit('end');
  });
  await api.handle(req, box.res, u.pathname, u.searchParams);
  return { status: box.code, raw: box.raw != null ? String(box.raw) : null, body: box.raw ? JSON.parse(box.raw) : null };
}

/** 一局合法（已结束）的存档记录 */
function game(id, seatName = 'a') {
  return {
    id, finished: true, day: 1, winner: 'good', winReason: '测试', mock: true, savedAt: 1,
    players: [{ seat: 1, name: seatName, isHuman: false, role: 'villager' }],
    events: [], board: { wolf: 1, villager: 2 }, rules: {},
  };
}

/** 一份最小合法导入包 */
function basePackage(games = [game('g-near')]) {
  return {
    manifest: {
      exportVersion: 1, packageId: 'pkg-near-limit', createdAt: '2026-01-01T00:00:00.000Z',
      source: 'FIX-21 测试', counts: { games: games.length, notes: 1 },
    },
    profile: { nickname: '近上限', avatarId: 'scholar', bio: '' },
    games,
    notes: { [games[0].id]: { schemaVersion: 2, profileId: 'o', gameId: games[0].id, revision: 1, seats: { 1: { leaning: 'lean_wolf' } } } },
  };
}

/**
 * 把请求体补到**恰好** bytes 字节。
 * 注意 HTTP 层的形状：`POST /api/profiles/import` 收的是 `{ package: <导入包> }`（见 src/api.js:847），
 * 上限比较的是**整个请求体**的字节数，所以补的是包里的顶层 pad 字段、量的是信封。
 */
function padToExactBytes(pkg, bytes) {
  const envelope = (p) => JSON.stringify({ package: p });
  const base = Buffer.byteLength(envelope({ ...pkg, pad: '' }));
  const need = bytes - base;
  assert.ok(need > 0, `包体基数 ${base} 已经 ≥ 目标 ${bytes} 字节，夹具无法把它补到"恰好在上限内"`);
  const padded = { ...pkg, pad: 'x'.repeat(need) };
  const raw = Buffer.from(envelope(padded));
  assert.strictEqual(raw.length, bytes, '夹具自证：请求体字节数必须恰好等于目标值');
  return raw;
}

test('体积恰好等于上限（MAX_BYTES）的导入包必须成功落地 —— 不是"超限才拒绝"那么简单', async () => {
  const { api, dataDir, savesDir } = makeApi('fix21-near');
  try {
    const raw = padToExactBytes(basePackage(), transfer.MAX_BYTES);
    assert.strictEqual(raw.length, transfer.MAX_BYTES, '夹具自证：请求体恰好 MAX_BYTES 字节');

    const res = await callApi(api, 'POST', '/api/profiles/import', raw);
    assert.strictEqual(res.status, 200, `恰好等于上限的包必须导入成功（实际 ${res.status}：${JSON.stringify(res.body).slice(0, 200)}）`);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.imported, 1, '那一局必须真的被写进去');
    assert.strictEqual(res.body.importedNotes, 1, '随局的笔记也要落地');

    // 不是"假成功"：档案与存档都必须真的在磁盘上
    const files = fs.readdirSync(savesDir).filter((f) => f.endsWith('.json'));
    assert.strictEqual(files.length, 1, `存档目录应恰好有 1 个文件，实际 ${JSON.stringify(files)}`);
    const doc = JSON.parse(fs.readFileSync(path.join(savesDir, files[0]), 'utf8'));
    assert.strictEqual(doc.game.id, res.body.gameMap['g-near'], '落盘的对局 id 必须是与预览一致的重映射结果');
    assert.strictEqual(doc.ownerProfileId, res.body.profileId, '存档必须归属新建的导入档案');
    const list = await callApi(api, 'GET', '/api/profiles');
    const created = list.body.profiles.filter((p) => p.nickname === '近上限（导入）');
    assert.strictEqual(created.length, 1, '导入应新建一个「近上限（导入）」档案');
    assert.strictEqual(created[0].id, res.body.profileId);
  } finally {
    await terminateApi(api, dataDir);
  }
});

test('预览与导入同一上限：恰好等于上限的包预览也必须成功，且不写盘', async () => {
  const { api, dataDir, savesDir } = makeApi('fix21-prev');
  try {
    const res = await callApi(api, 'POST', '/api/profiles/import/preview', padToExactBytes(basePackage(), transfer.MAX_BYTES));
    assert.strictEqual(res.status, 200, `预览必须与导入同一上限（实际 ${res.status}：${JSON.stringify(res.body).slice(0, 200)}）`);
    assert.deepStrictEqual(
      res.body.preview,
      // M1 §4.4：previewImport 新增了 avatar 标记（这个包带不带自定义头像），期望键集随之更新；
      // 本用例的原意（"预览与导入同一上限、恰好等于上限也必须成功、且绝不写盘"）一个字都没改。
      { nickname: '近上限', games: 1, finishedOnly: true, notes: 1, avatar: false },
      '预览内容必须来自包本身',
    );
    assert.strictEqual(fs.readdirSync(savesDir).filter((f) => f.endsWith('.json') || f.startsWith('.tmp-')).length, 0, '预览绝不写盘');
  } finally {
    await terminateApi(api, dataDir);
  }
});

test('多局多笔记的大包（远小于体积上限）全部落地：导入路径没有隐藏的数量闸', async () => {
  const { api, dataDir, savesDir } = makeApi('fix21-bulk');
  try {
    const N = 40;
    const games = Array.from({ length: N }, (_, i) => game(`g-bulk-${i}`));
    const pkg = basePackage(games);
    pkg.notes = {};
    for (let i = 0; i < 5; i++) pkg.notes[`g-bulk-${i}`] = { schemaVersion: 2, profileId: 'o', gameId: `g-bulk-${i}`, revision: 1, seats: { 1: { leaning: 'lean_good' } } };
    pkg.manifest.counts = { games: N, notes: 5 };

    const bodyBytes = Buffer.byteLength(JSON.stringify(pkg));
    assert.ok(bodyBytes < transfer.MAX_BYTES / 100, `夹具前提：这个包应当远小于上限（${bodyBytes} 字节）`);

    const res = await callApi(api, 'POST', '/api/profiles/import', Buffer.from(JSON.stringify({ package: pkg })));
    assert.strictEqual(res.status, 200, `大包必须导入成功（实际 ${res.status}：${JSON.stringify(res.body).slice(0, 200)}）`);
    assert.strictEqual(res.body.imported, N, `${N} 局必须一局不少地导入（少于它就说明有隐藏的数量闸或多局写入被吞）`);
    assert.strictEqual(res.body.importedNotes, 5, '随局笔记数量必须如实上报');
    const mapped = Object.values(res.body.gameMap);
    assert.strictEqual(mapped.length, N);
    assert.strictEqual(new Set(mapped).size, N, '重映射后的 id 必须两两不同（否则会互相覆盖）');
    const files = fs.readdirSync(savesDir).filter((f) => f.endsWith('.json'));
    assert.strictEqual(files.length, N, `磁盘上应有 ${N} 个存档，实际 ${files.length}`);
    const onDisk = new Set(files.map((f) => f.replace(/\.json$/, '')));
    assert.deepStrictEqual(mapped.filter((id) => !onDisk.has(id)), [], '每一条重映射 id 都必须真的落盘');
  } finally {
    await terminateApi(api, dataDir);
  }
});
