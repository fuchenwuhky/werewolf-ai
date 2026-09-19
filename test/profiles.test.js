/**
 * profiles.test.js — 本机玩家档案存储（DATA-01/DATA-02 回归）
 * 覆盖：原子写、revision 409、归档/恢复/回收、最后档案保护、迁移幂等与打标
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ProfileStore, NotFoundError, ValidationError } = require('../src/profiles/store');
const { ProfileMigration } = require('../src/profiles/migration');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {} };
const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `prof-${tag}-`));

test('档案创建：昵称清洗/头像白名单/UUID/revision', async () => {
  const store = new ProfileStore({ dataDir: tmpDir('create'), logger: silentLogger });
  const p = await store.create({ nickname: '  砚舟  ', avatarId: 'scholar', bio: ' hi ' });
  assert.match(p.id, /^[0-9a-f-]{36}$/);
  assert.strictEqual(p.nickname, '砚舟');
  assert.strictEqual(p.avatarId, 'scholar');
  assert.strictEqual(p.bio, 'hi');
  assert.strictEqual(p.revision, 1);
  await assert.rejects(() => store.create({ nickname: '' }), ValidationError);
  await assert.rejects(() => store.create({ nickname: 'x'.repeat(21) }), ValidationError);
  await assert.rejects(() => store.create({ nickname: 'a', avatarId: 'nope' }), ValidationError);
});

test('档案更新：expectedRevision 乐观并发（409）+ 归档/恢复 + 最后档案保护', async () => {
  const store = new ProfileStore({ dataDir: tmpDir('update'), logger: silentLogger });
  const a = await store.create({ nickname: 'A' });
  const b = await store.create({ nickname: 'B' });

  // 409：过期 revision
  await assert.rejects(
    () => store.update(a.id, { expectedRevision: 99, nickname: 'X' }),
    (e) => e.code === 409,
  );
  // 正常更新 → revision 递增
  const upd = await store.update(a.id, { nickname: 'A2' });
  assert.strictEqual(upd.nickname, 'A2');
  assert.strictEqual(upd.revision, 2);

  // 最后一份可用档案不可归档（先归档 B，A 成为唯一可用 → 拒绝归档 A）
  await store.update(b.id, { archive: true });
  await assert.rejects(() => store.update(a.id, { archive: true }), ValidationError, '最后一份可用档案不可归档');
  await store.update(b.id, { restore: true });
  await store.update(a.id, { archive: true });
  assert.ok(store.get(a.id).archivedAt);
  // 已归档档案不能直接编辑
  await assert.rejects(() => store.update(a.id, { nickname: 'Z' }), ValidationError);
});

test('档案删除：仅归档态可移入回收区，可恢复', async () => {
  const dir = tmpDir('trash');
  const store = new ProfileStore({ dataDir: dir, logger: silentLogger });
  const a = await store.create({ nickname: 'A' });
  const b = await store.create({ nickname: 'B' });
  await assert.rejects(() => store.trash(a.id), ValidationError, '未归档不能删');
  await store.update(a.id, { archive: true });
  await store.trash(a.id);
  assert.throws(() => store.get(a.id), NotFoundError || Error);
  assert.ok(store.get(b.id), 'B 不受影响');
  // trash 目录存在档案
  const trashRoot = path.join(dir, 'profiles', 'trash');
  const entries = fs.readdirSync(trashRoot);
  assert.strictEqual(entries.length, 1);
  const restored = store.restoreFromTrash(entries[0]);
  assert.strictEqual(restored.id, a.id);
  assert.ok(store.get(a.id));
});

test('DATA-02：迁移幂等——默认档案唯一、存档打标一次、游标可重入', async () => {
  const dir = tmpDir('mig');
  const savesDir = path.join(dir, 'saves');
  fs.mkdirSync(savesDir, { recursive: true });
  // 两份旧存档（无归属）
  for (const id of ['legacy-a', 'legacy-b']) {
    fs.writeFileSync(path.join(savesDir, `${id}.json`), JSON.stringify({
      schemaVersion: 2, tokens: { player: 'p' }, mock: true,
      game: { id, day: 2, phase: 'day', started: true, finished: false, players: [{ seat: 1, name: '我', isHuman: true }, { seat: 2, name: 'X', isHuman: false }] },
      anchor: null, review: null, savedAt: 1,
    }));
  }
  const store = new ProfileStore({ dataDir: dir, logger: silentLogger });
  const mig = new ProfileMigration({ dataDir: dir, profilesStore: store, logger: silentLogger });
  const r1 = await mig.run();
  assert.ok(r1.defaultId, '应创建默认档案');
  assert.strictEqual(r1.tagged, 2, '两份无归属存档应打标');
  // 幂等：再跑一遍
  const r2 = await mig.run();
  assert.strictEqual(r2.tagged, 0, '重跑不得重复打标');
  const again = store.list({ includeArchived: true }).filter((p) => p.nickname === '默认玩家');
  assert.strictEqual(again.length, 1, '不得出现第二个默认档案');
  // 存档已带归属
  const doc = JSON.parse(fs.readFileSync(path.join(savesDir, 'legacy-a.json'), 'utf8'));
  assert.strictEqual(doc.ownerProfileId, r1.defaultId);
  assert.strictEqual(doc.profileSchemaVersion, 1);
});

test('DATA-02：迁移中的备份目录真实存在（可回滚）', async () => {
  const dir = tmpDir('bk');
  fs.mkdirSync(path.join(dir, 'saves'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'saves', 'bk-a.json'), JSON.stringify({ game: { id: 'bk-a', players: [] } }));
  const store = new ProfileStore({ dataDir: dir, logger: silentLogger });
  const mig = new ProfileMigration({ dataDir: dir, profilesStore: store, logger: silentLogger });
  await mig.run();
  const migDir = path.join(dir, 'migrations');
  const backups = fs.readdirSync(migDir).filter((d) => d.startsWith('backup-'));
  assert.strictEqual(backups.length, 1, '应有迁移备份目录');
  const files = fs.readdirSync(path.join(migDir, backups[0]));
  assert.ok(files.includes('bk-a.json'), '备份应含旧存档');
});
