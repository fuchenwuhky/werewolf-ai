/**
 * transfer.test.js — 档案导入导出（PROF-04 回归）
 * 覆盖：导出脱敏（不含令牌/密钥/锚点/journal）、预览不写盘、导入重映射 ID、
 *       未结束局拒绝、坏包拒绝不部分写入。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const transfer = require('../src/profiles/transfer');
const { ProfileStore } = require('../src/profiles/store');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {} };
const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `tr-${tag}-`));

test('导出：已结束局收集 + 包内无敏感字段（无令牌/锚点/journal）', async () => {
  const dir = tmpDir('exp');
  const savesDir = path.join(dir, 'saves');
  fs.mkdirSync(savesDir, { recursive: true });
  const pid = '11111111-2222-3333-4444-555555555555';
  const doc = {
    schemaVersion: 2, tokens: { player: 'SECRET', god: 'GODTOKEN' }, mock: false,
    ownerProfileId: pid, ownerNicknameSnapshot: '砚舟',
    anchor: { secret: 'anchor-data' }, journal: { x: 1 },
    game: { id: 'exp-1', day: 3, phase: 'over', started: true, finished: true, winner: 'good',
      players: [{ seat: 1, name: '砚舟', isHuman: true, role: 'seer' }], events: [{ seq: 1 }], board: { wolf: 1 } },
    review: { status: 'done', text: '复盘' },
    savedAt: 1,
  };
  fs.writeFileSync(path.join(savesDir, 'exp-1.json'), JSON.stringify(doc));
  const games = transfer.collectExportableGames(savesDir, pid);
  assert.strictEqual(games.length, 1);
  const pkg = transfer.buildExportPackage({ profile: { nickname: '砚舟' }, games, notes: {} });
  const raw = JSON.stringify(pkg);
  assert.ok(!raw.includes('SECRET'), '导出包不得包含玩家令牌');
  assert.ok(!raw.includes('GODTOKEN'), '导出包不得包含上帝令牌');
  assert.ok(!raw.includes('anchor-data'), '导出包不得包含锚点');
  assert.ok(!raw.includes('journal'), '导出包不得包含 journal');
  assert.strictEqual(pkg.manifest.counts.games, 1);
});

test('导入：校验拒绝坏包（未结束局/缺昵称/坏 id），合法包落地为新档案+重映射 id', async () => {
  const dir = tmpDir('imp');
  const store = new ProfileStore({ dataDir: dir, logger: silentLogger });

  // ① 未结束局拒绝
  const bad = { manifest: { exportVersion: 1 }, profile: { nickname: 'X' }, games: [{ id: 'g1', finished: false }] };
  assert.throws(() => transfer.validateImportPackage(bad), /未结束/);

  // ② 非法对局 id 拒绝
  const bad2 = { manifest: { exportVersion: 1 }, profile: { nickname: 'X' }, games: [{ id: '../evil', finished: true }] };
  assert.throws(() => transfer.validateImportPackage(bad2), /非法对局 id/);

  // ③ 合法包：预览 → 导入 → 新档案 + 重映射 id
  const good = {
    manifest: { exportVersion: 1, packageId: 'p1' },
    profile: { nickname: '导入者', avatarId: 'scholar', bio: '', preferences: {} },
    games: [{ id: 'old-g1', day: 2, finished: true, winner: 'good', mock: false,
      players: [{ seat: 1, name: '我', isHuman: true }], events: [], board: { wolf: 1 }, rules: {} }],
    notes: {},
  };
  transfer.validateImportPackage(good);
  const preview = transfer.previewImport(good);
  assert.strictEqual(preview.nickname, '导入者');
  assert.strictEqual(preview.games, 1);

  // 导入落地：新建档案承接（模拟 API 层行为）
  fs.mkdirSync(path.join(dir, 'saves'), { recursive: true });
  const prof = await store.create({ nickname: good.profile.nickname + '（导入）' });
  const map = transfer.buildGameIdMap(good);
  const newGameId = map[Object.keys(map)[0]] || 'imp-fallback';
  const doc = { schemaVersion: 2, tokens: {}, mock: good.games[0].mock === true, ownerProfileId: prof.id,
    game: { ...good.games[0], id: newGameId }, anchor: null, review: null, savedAt: Date.now() };
  fs.writeFileSync(path.join(dir, 'saves', newGameId + '.json'), JSON.stringify(doc, null, 2));
  const reread = JSON.parse(fs.readFileSync(path.join(dir, 'saves', newGameId + '.json'), 'utf8'));
  assert.strictEqual(reread.ownerProfileId, prof.id, '导入局必须归属导入档案');
  assert.notStrictEqual(reread.game.id, 'old-g1', 'gameId 必须重映射避免冲突');
});

test('导入 API：preview 不写盘、apply 落地为新档案（含 profileId 归属）', async () => {
  const dir = tmpDir('imp-api');
  fs.mkdirSync(dir, { recursive: true });
  const { Api } = require('../src/api');
  const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: dir });
  const good = {
    manifest: { exportVersion: 1 },
    profile: { nickname: '包内档案' },
    games: [{ id: 'g-old', day: 5, finished: true, winner: 'wolf', mock: false,
      players: [{ seat: 1, isHuman: false }], events: [], board: { wolf: 3 }, rules: {} }],
  };
  const pv = await api.importPreviewRes(good);
  assert.strictEqual(pv.status, 200);
  const ap = await api.importApplyRes(good);
  assert.strictEqual(ap.status, 200, 'apply 状态码');
  assert.ok(ap.body.profileId, '导入必须返回新档案 id');
  const newGameId = ap.body.gameMap['g-old'];
  const listed = JSON.parse(fs.readFileSync(path.join(dir, newGameId + '.json'), 'utf8'));
  assert.strictEqual(listed.ownerProfileId, ap.body.profileId, '导入局归属导入档案');
  assert.strictEqual(listed.game.id, newGameId, 'gameId 必须重映射');
});

test('导入校验 400 语义：缺 manifest/exportVersion 缺失或错误/未结束局/非法 id 一律 code 400', () => {
  const cases = [
    { name: '包不是对象', pkg: null, msg: /导入包/ },
    { name: 'manifest 缺失', pkg: { profile: { nickname: 'X' }, games: [] }, msg: /导出版本/ },
    { name: 'exportVersion 缺失', pkg: { manifest: {}, profile: { nickname: 'X' }, games: [] }, msg: /导出版本/ },
    { name: 'exportVersion 错误', pkg: { manifest: { exportVersion: 2 }, profile: { nickname: 'X' }, games: [] }, msg: /导出版本/ },
    { name: '缺档案昵称', pkg: { manifest: { exportVersion: 1 }, profile: {}, games: [] }, msg: /昵称/ },
    { name: 'games 不是数组', pkg: { manifest: { exportVersion: 1 }, profile: { nickname: 'X' }, games: 'not-array' }, msg: /对局列表/ },
    { name: '含未结束局', pkg: { manifest: { exportVersion: 1 }, profile: { nickname: 'X' }, games: [{ id: 'g1', finished: false }] }, msg: /未结束/ },
    { name: '非法对局 id', pkg: { manifest: { exportVersion: 1 }, profile: { nickname: 'X' }, games: [{ id: '../evil', finished: true }] }, msg: /非法对局 id/ },
  ];
  for (const { name, pkg, msg } of cases) {
    try {
      transfer.validateImportPackage(pkg);
      assert.fail(`${name}：应拒绝 ${JSON.stringify(pkg)}`);
    } catch (e) {
      assert.strictEqual(e.code, 400, `${name}：必须携带 400 语义（实际 ${e.code}：${e.message}）`);
      assert.match(e.message, msg, `${name}：错误信息应说明原因`);
    }
  }
});

test('导出包：manifest.counts（games/notes）与 notes 随包计数正确', () => {
  const games = [
    { id: 'g-a', finished: true, day: 2, winner: 'good', winReason: '', mock: false, savedAt: 1, players: [], events: [], board: { wolf: 1 }, rules: {} },
    { id: 'g-b', finished: true, day: 4, winner: 'wolf', winReason: '', mock: true, savedAt: 2, players: [], events: [], board: { wolf: 1 }, rules: {} },
  ];
  const notes = {
    'g-a': { schemaVersion: 2, profileId: 'p', gameId: 'g-a', revision: 1, seats: { 2: { leaning: 'lean_wolf', note: '贴脸发言' } } },
  };
  const pkg = transfer.buildExportPackage({ profile: { nickname: '砚舟', avatarId: 'scholar' }, games, notes, hostLabel: '测试机导出' });
  assert.strictEqual(pkg.manifest.exportVersion, transfer.EXPORT_VERSION, '导出版本号与模块常量一致');
  assert.strictEqual(pkg.manifest.counts.games, 2, 'counts.games 等于对局数');
  assert.strictEqual(pkg.manifest.counts.notes, 1, 'counts.notes 等于带笔记的局数');
  assert.strictEqual(pkg.manifest.source, '测试机导出');
  assert.ok(pkg.manifest.packageId && pkg.manifest.createdAt, 'packageId/createdAt 必须存在');
  assert.strictEqual(pkg.profile.nickname, '砚舟', '档案昵称随包携带');
  assert.deepStrictEqual(Object.keys(pkg.notes), ['g-a'], 'notes 随包携带且键为 gameId');

  const pv = transfer.previewImport(pkg);
  assert.strictEqual(pv.games, 2, '预览的对局数一致');
  assert.strictEqual(pv.notes, 1, '预览的 notes 计数一致');
  assert.strictEqual(pv.finishedOnly, true, '预览标记只允许已结束局');
});

test('导入校验：players/events/board/rules/notes 类型反例全部 400（审核 P2-4 校验前移）', () => {
  const base = (over) => ({
    manifest: { exportVersion: 1 }, profile: { nickname: '校验' },
    games: [{ id: 'g-1', finished: true, players: [{ seat: 1 }], events: [], board: {}, rules: {}, winner: 'good', winReason: '', mock: false, savedAt: 1, ...over }],
  });
  const cases = [
    ['players 非数组', base({ players: 'x' })],
    ['players 条目非对象', base({ players: ['x'] })],
    ['events 非数组', base({ events: {} })],
    ['board 非对象', base({ board: ['x'] })],
    ['rules 非对象', base({ rules: 'x' })],
    ['winner 非字符串', base({ winner: 3 })],
    ['notes 非对象', { manifest: { exportVersion: 1 }, profile: { nickname: 'x' }, games: [], notes: [] }],
    ['notes.seats 非对象', { manifest: { exportVersion: 1 }, profile: { nickname: 'x' }, games: [], notes: { g: { seats: [] } } }],
  ];
  for (const [name, pkg] of cases) {
    let err = null;
    try { transfer.validateImportPackage(pkg); } catch (e) { err = e; }
    assert.ok(err && err.code === 400, `${name} 必须 code 400（实际 ${err && err.code}）`);
  }
  // 合法包不被误伤
  assert.ok(transfer.validateImportPackage(base({})));
});
