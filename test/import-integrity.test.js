/**
 * import-integrity.test.js — 导入的「数量必须是真的」与「重映射后不许互相覆盖」（NEW-08 / M0 数据风险）
 *
 * 两个缺陷都是先用**一次性探针调真实 Api** 钉死的（不是读代码推测）：
 *
 *   ① NEW-08：`POST /api/profiles/import` 的 `imported` 取的是**写循环之前**就定好的重映射表键数
 *      （`Object.keys(out.body.gameMap).length`，见 src/api.js）。写循环的数被吞掉时它会报"全部成功"：
 *      探针把 `fs.promises.rename` 从第 2 局起变成**静默失效（不抛错、不落盘）** → HTTP 200、
 *      `imported: 3`，而磁盘上 **0 局**（另一次注入：`imported: 3` vs 实际 1 局）。
 *      计划书 §2.1 明确要求"导入数量来自真正完成落盘的记录，不使用预先生成的映射数量冒充成功数"。
 *
 *   ② 包内两条对局用**同一个 gameId**：`transfer.buildGameIdMap` 把它们映射到同一个新 id，
 *      后写的那局**静默覆盖**先写的；接口返回 200 + `imported: 1`，用户看到"1 局已归入新档案"，
 *      完全不知道包里另一局被吞了（探针实测存活的是第二局）。这与本模块"任何校验失败都不部分写入、
 *      坏记录整体拒绝"的原则相悖 —— 重复 id 是**能判定的坏包**，就该在写盘之前拒绝。
 *
 * 夹具与故障注入沿用仓库既有模式：独占临时 dataDir（test/helpers-tmpdir.js，不碰正式存档）+
 * 真实 `api.handle` 分发（含 mgmt/Origin 门禁与 readBody 体积闸）+ 直调内部实现注入 fs 故障。
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

function makeApi(tag) {
  const dataDir = makeDataDir(tag);
  const savesDir = savesOf(dataDir);
  const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: savesDir });
  return { api, dataDir, savesDir };
}

/** 走真实 api.handle 分发（mgmt/Origin 门禁与体积闸都在里面） */
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
  return { status: box.code, body: box.raw ? JSON.parse(box.raw) : null };
}

/** 已落盘的存档文件（排除隐藏的临时文件与恢复记录） */
const landedGames = (savesDir) => fs.readdirSync(savesDir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));

/** 一局合法（已结束）的存档记录 */
const game = (id, seatName) => ({
  id, finished: true, day: 1, winner: 'good', winReason: '测试', mock: true, savedAt: 1,
  players: [{ seat: 1, name: seatName, isHuman: false, role: 'villager' }],
  events: [], board: { wolf: 1, villager: 2 }, rules: {},
});

function pack(games, notes = {}) {
  return {
    manifest: { exportVersion: 1, packageId: 'pkg-integrity', createdAt: '2026-01-01T00:00:00.000Z', source: 'test', counts: { games: games.length, notes: Object.keys(notes).length } },
    profile: { nickname: '完整性', avatarId: 'scholar', bio: '' },
    games,
    notes,
  };
}

const envelope = (p) => Buffer.from(JSON.stringify({ package: p }));

test('NEW-08：imported 必须等于真正落盘的局数 —— 写入被吞时不许报"全部成功"', async () => {
  const { api, dataDir, savesDir } = makeApi('new08-swallow');
  const realRename = fs.promises.rename;
  try {
    // 故障注入：**只对存档目录里的 rename** 生效，第 2 局起静默失效（不抛错、也不落盘）
    // —— 写循环"看起来全做完"了，但磁盘上只有第 1 局。这正是 imported 用映射表键数时会说假话的场景。
    // （档案/index.json 等其它原子写照常放行，否则连导入档案都建不出来，夹具前提就不成立。）
    const inSaves = (p) => path.resolve(String(p)).startsWith(path.resolve(savesDir) + path.sep);
    let gameRenames = 0;
    fs.promises.rename = async (from, to) => {
      if (!inSaves(to)) return realRename(from, to);
      gameRenames++;
      if (gameRenames === 1) return realRename(from, to);
      return undefined;
    };

    const res = await callApi(api, 'POST', '/api/profiles/import', envelope(pack([game('x1', 'A'), game('x2', 'B'), game('x3', 'C')])));
    fs.promises.rename = realRename;

    assert.strictEqual(res.status, 200, `夹具前提：注入不抛错，导入本身仍是 200（实际 ${res.status}：${JSON.stringify(res.body).slice(0, 160)}）`);
    const landed = landedGames(savesDir).length;
    assert.strictEqual(landed, 1, `夹具自证：注入后磁盘上只应有 1 局，实际 ${landed}`);
    assert.strictEqual(
      res.body.imported,
      landed,
      `imported=${res.body.imported} 但真正落盘的只有 ${landed} 局 —— 数量必须来自落盘结果，不能是重映射表的键数`,
    );
  } finally {
    fs.promises.rename = realRename;
    await terminateApi(api, dataDir);
  }
});

test('NEW-08：正常导入时 imported 与落盘局数、包内局数三者一致（也不许少报）', async () => {
  const { api, dataDir, savesDir } = makeApi('new08-ok');
  try {
    const res = await callApi(api, 'POST', '/api/profiles/import', envelope(pack([game('y1', 'A'), game('y2', 'B'), game('y3', 'C')])));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body).slice(0, 160));
    assert.strictEqual(landedGames(savesDir).length, 3, '三局都必须真的落盘');
    assert.strictEqual(res.body.imported, 3, 'imported 必须等于包内局数（少报同样是"接口说假话"）');
    // 重映射表与实际落盘一一对应（不能有映射出来却没落地的 id）
    const onDisk = new Set(landedGames(savesDir).map((f) => f.replace(/\.json$/, '')));
    assert.deepStrictEqual(Object.values(res.body.gameMap).filter((id) => !onDisk.has(id)), [], '每条重映射 id 都必须真的落盘');
  } finally {
    await terminateApi(api, dataDir);
  }
});

test('导入包内 gameId 重复：必须 400 整体拒绝，不许静默覆盖丢一局', async () => {
  const { api, dataDir, savesDir } = makeApi('dup-id');
  try {
    const dup = pack([game('dup', '第一局'), game('dup', '第二局')]);

    // ① 校验层直接拒绝（写盘之前）
    assert.throws(() => transfer.validateImportPackage(dup), /重复/, 'validateImportPackage 必须拒绝重复 gameId');

    // ② HTTP 预览同样拒绝（UI 在用户点"导入"之前就该知道包有问题）
    const pv = await callApi(api, 'POST', '/api/profiles/import/preview', envelope(dup));
    assert.strictEqual(pv.status, 400, `预览重复 gameId 的包必须 400（实际 ${pv.status}）`);
    assert.match(String(pv.body && pv.body.error), /重复/);

    // ③ HTTP 导入：400 + 零落盘 + 不留下半个导入档案（不许"先建档案再失败"）
    const res = await callApi(api, 'POST', '/api/profiles/import', envelope(dup));
    assert.strictEqual(res.status, 400, `重复 gameId 必须整体拒绝（实际 ${res.status}：${JSON.stringify(res.body).slice(0, 160)}）`);
    assert.match(String(res.body && res.body.error), /重复/);
    assert.strictEqual(landedGames(savesDir).length, 0, '拒绝后不得留下任何半份存档');
    assert.strictEqual(fs.readdirSync(savesDir).filter((f) => f.startsWith('.import-recovery-')).length, 0, '这不是写盘故障，不该留恢复记录');

    const list = await callApi(api, 'GET', '/api/profiles');
    assert.deepStrictEqual(
      (list.body.profiles || []).filter((p) => p.nickname === '完整性（导入）'),
      [],
      '校验在写盘之前 → 不得先建出「（导入）」档案再失败',
    );
  } finally {
    await terminateApi(api, dataDir);
  }
});

test('导入包内 gameId 重复的判定绝不能误伤：id 不同但内容相同、以及多个同前缀 id 都必须放过', async () => {
  const { api, dataDir, savesDir } = makeApi('dup-id-nofalse');
  try {
    const res = await callApi(api, 'POST', '/api/profiles/import', envelope(pack([
      game('same-1', '同名'), game('same-2', '同名'), game('same-10', '同名'),
    ])));
    assert.strictEqual(res.status, 200, `只是姓名/内容相同、id 不同 → 必须正常导入（实际 ${res.status}：${JSON.stringify(res.body).slice(0, 160)}）`);
    assert.strictEqual(res.body.imported, 3);
    assert.strictEqual(landedGames(savesDir).length, 3);
  } finally {
    await terminateApi(api, dataDir);
  }
});
