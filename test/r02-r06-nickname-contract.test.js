/**
 * r02-r06-nickname-contract.test.js — R02（长昵称必须能回导）与 R06（长度按码点）的真实 HTTP 验收
 *
 * 依赖的两条缺陷（均已在源码中复现过）：
 *   · R02：`src/api.js` 的导入**无条件**把昵称写成 `nickname + '（导入）'` ⇒ 17–20 字昵称一导入就
 *     变成 21+ 字，被 store 的长度校验拒成 400；多轮回导还会越拼越长。
 *   · R06：客户端唯一真值 `web/shared/profile-state.js` 明写按**码点**计（否则 🐺 这类代理对被算成 2，
 *     20 字上限会变 10 字），而服务端 `store.js` 用 `s.length`（UTF-16 码元）⇒ 11 个 🐺 被拒。
 *
 * 为什么单写一个文件而不是改既有用例：既有 `import-near-limit` / `m2-ab-acceptance` 钉的是**旧行为**
 * （昵称带「（导入）」后缀），那两条已按新契约改成"原样保留"；本文件补齐评审点名的边界组合：
 * 17 字 / 20 字 / 20 码点 emoji / 21 码点仍拒 / 重名 / 多轮"导出→导入→再导出"。
 *
 * 全程走真实 `api.handle`（含 readBody 体积闸与门禁），不走 transfer 辅助函数的内部调用。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const events = require('node:events');

const Api = require('../src/api').Api || require('../src/api');
const { makeDataDir, savesOf, terminateApi } = require('./helpers-tmpdir');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

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

// ⚠ 必须发 **Buffer**：服务端 readBody 只接受 Buffer 分片，传字符串会得到 400「JSON 解析失败」
//（实测：Buffer → 200、string → 400；仓库既有用例传的也都是 Buffer）。这是测试架的事，与产品无关。
const post = (api, p, body) => callApi(api, 'POST', p, Buffer.from(JSON.stringify(body), 'utf8'));

/** 一局合法（已结束）的存档记录，作为导入包的内容 */
function game(id) {
  return {
    id, finished: true, day: 1, winner: 'good', winReason: '测试', mock: true, savedAt: 1,
    players: [{ seat: 1, name: 'a', isHuman: false, role: 'villager' }],
    events: [], board: { wolf: 1, villager: 2 }, rules: {},
  };
}

/** 造一个可导入的包（1 局已结束 + 1 条笔记） */
function pkg(nickname, gameId = 'r02-game') {
  return {
    manifest: { exportVersion: 1, packageId: '00000000-0000-4000-8000-000000000000', createdAt: '2026-09-23T00:00:00.000Z', source: '测试', counts: { games: 1, notes: 1 } },
    profile: { nickname, avatarId: 'scholar', bio: '', preferences: {}, customAvatar: null },
    notes: { [gameId]: { seats: { 1: { note: '记一笔' } } } },
    games: [game(gameId)],
  };
}

// 20 个汉字（20 码点 = 20 码元）
const N20 = '一二三四五六七八九十一二三四五六七八九十';
// 17 个汉字
const N17 = '一二三四五六七八九十一二三四五';
// 20 个码点的 emoji（UTF-16 是 40 码元 —— R06 前必被拒）
const EMOJI20 = '🐺'.repeat(20);

test('R02：17 字昵称的包必须能导入，且昵称**原样保留**（不再拼「（导入）」）', async () => {
  const { api, dataDir } = makeApi('r02-17');
  try {
    const res = await post(api, '/api/profiles/import', { package: pkg(N17) });
    assert.strictEqual(res.status, 200, `17 字昵称必须能导入（实际 ${res.status}：${JSON.stringify(res.body).slice(0, 200)}）`);
    const list = await callApi(api, 'GET', '/api/profiles');
    const made = (list.body.profiles || []).filter((p) => p.id === res.body.profileId);
    assert.strictEqual(made.length, 1, '必须真的建出这个档案');
    assert.strictEqual(made[0].nickname, N17, 'R02：昵称必须原样保留，不得追加任何后缀');
    assert.ok(!/（导入）/.test(made[0].nickname), 'R02：不得再把「（导入）」写进昵称');
  } finally { await terminateApi(api, dataDir); }
});

test('R02：20 字昵称（上限值）的包必须能导入 —— 修复前这里是 400「昵称最长 20 个字符」', async () => {
  const { api, dataDir } = makeApi('r02-20');
  try {
    assert.strictEqual([...N20].length, 20, '夹具自证：N20 恰好 20 码点');
    const res = await post(api, '/api/profiles/import', { package: pkg(N20) });
    assert.strictEqual(res.status, 200, `20 字昵称必须能导入（实际 ${res.status}：${JSON.stringify(res.body).slice(0, 200)}）`);
    const list = await callApi(api, 'GET', '/api/profiles');
    const made = (list.body.profiles || []).find((p) => p.id === res.body.profileId);
    assert.strictEqual(made.nickname, N20);
  } finally { await terminateApi(api, dataDir); }
});

test('R06：20 个**码点**的 emoji 昵称必须接受（40 个 UTF-16 码元，按码元算就会被误拒）', async () => {
  const { api, dataDir } = makeApi('r06-emoji');
  try {
    assert.strictEqual(EMOJI20.length, 40, '夹具自证：20 个 🐺 是 40 个 UTF-16 码元');
    assert.strictEqual([...EMOJI20].length, 20, '夹具自证：20 个 🐺 是 20 个码点');
    const res = await post(api, '/api/profiles', { nickname: EMOJI20, avatarId: 'wolf' });
    assert.strictEqual(res.status, 200, `20 码点 emoji 昵称必须接受（实际 ${res.status}：${JSON.stringify(res.body).slice(0, 200)}）`);
    assert.strictEqual(res.body.profile.nickname, EMOJI20);
  } finally { await terminateApi(api, dataDir); }
});

test('R06：21 个码点必须仍然被拒 —— 口径改了，上限本身没有放宽', async () => {
  const { api, dataDir } = makeApi('r06-21');
  try {
    const res = await post(api, '/api/profiles', { nickname: '🐺'.repeat(21), avatarId: 'wolf' });
    assert.strictEqual(res.status, 400, `21 码点必须 400（实际 ${res.status}）`);
    assert.match(String(res.body && res.body.error), /昵称最长 20 个字符/);
    // 同一把尺子：21 个汉字也必须拒
    const res2 = await post(api, '/api/profiles', { nickname: N20 + '一', avatarId: 'wolf' });
    assert.strictEqual(res2.status, 400, '21 个汉字同样必须 400');
  } finally { await terminateApi(api, dataDir); }
});

test('R02+R06：重名允许（身份由 UUID 区分），且多轮「导出 → 导入 → 再导出」昵称不累加', async () => {
  const { api, dataDir } = makeApi('r02-round');
  try {
    // ① 先导入一次 ⇒ 新档案 A1，昵称 = N20（原样）
    const imp1 = await post(api, '/api/profiles/import', { package: pkg(N20, 'r02-round-1') });
    assert.strictEqual(imp1.status, 200, `第一轮导入必须成功：${JSON.stringify(imp1.body).slice(0, 160)}`);
    const a1 = imp1.body.profileId;

    // ② 走**真实导出接口**把 A1 导出来
    const exp = await callApi(api, 'GET', `/api/profiles/${a1}/export`);
    assert.strictEqual(exp.status, 200, `导出必须成功（实际 ${exp.status}）`);
    const pkg2 = exp.body;
    assert.strictEqual(pkg2.profile.nickname, N20, 'R02：导出的昵称就是原昵称');

    // ③ 再导入这份导出包 ⇒ 新档案 A2，昵称仍是 N20（不累加后缀）
    const imp2 = await post(api, '/api/profiles/import', { package: pkg2 });
    assert.strictEqual(imp2.status, 200, `第二轮导入必须成功（实际 ${imp2.status}：${JSON.stringify(imp2.body).slice(0, 200)}）`);
    const a2 = imp2.body.profileId;
    assert.notStrictEqual(a2, a1, 'R02：导入必须建新档案，不得覆盖原档案');

    const list = await callApi(api, 'GET', '/api/profiles');
    const same = (list.body.profiles || []).filter((p) => p.nickname === N20);
    assert.strictEqual(same.length, 2, `R02：两轮导入应得到两个**同名**档案（重名由 UUID 区分），实际 ${JSON.stringify((list.body.profiles || []).map((p) => p.nickname))}`);
    assert.deepStrictEqual(same.map((p) => p.id).sort(), [a1, a2].sort(), '两个同名档案的 id 必须正是两次导入的结果');
    assert.ok(!(list.body.profiles || []).some((p) => /（导入）/.test(p.nickname)), 'R02：任何档案昵称里都不该再出现「（导入）」');

    // ④ 原档案（A1）不被覆盖：它的对局仍在自己名下
    const g1 = await callApi(api, 'GET', `/api/profiles/${a1}/games`);
    assert.strictEqual(g1.status, 200);
    assert.strictEqual(g1.body.total, 1, 'A1 名下仍应有 1 局');
    const g2 = await callApi(api, 'GET', `/api/profiles/${a2}/games`);
    assert.strictEqual(g2.body.total, 1, 'A2 名下也应有 1 局（各自独立，互不覆盖）');
  } finally { await terminateApi(api, dataDir); }
});

test('R06：简介同口径 —— 100 码点接受、101 码点拒绝', async () => {
  const { api, dataDir } = makeApi('r06-bio');
  try {
    const ok = await post(api, '/api/profiles', { nickname: '简介边界', avatarId: 'scholar', bio: '🐺'.repeat(100) });
    assert.strictEqual(ok.status, 200, `100 码点简介必须接受（实际 ${ok.status}：${JSON.stringify(ok.body).slice(0, 160)}）`);
    const no = await post(api, '/api/profiles', { nickname: '简介越界', avatarId: 'scholar', bio: '🐺'.repeat(101) });
    assert.strictEqual(no.status, 400, '101 码点简介必须 400');
    assert.match(String(no.body && no.body.error), /简介最长 100 个字符/);
  } finally { await terminateApi(api, dataDir); }
});
