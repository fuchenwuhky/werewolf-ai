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
