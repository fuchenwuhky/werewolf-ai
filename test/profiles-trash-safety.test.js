/**
 * profiles-trash-safety.test.js — 档案删除（移入回收区）的可靠性回归（验收 P1）。
 *
 * 旧实现的顺序是：先改索引 → 再 rename 目录 → 最后写 restore.json，全程无回滚。两种中间态都会
 * 造成真实伤害：① rename 失败 → 档案从索引/界面消失，文件却还在原地；② 目录已进回收区但没有
 * restore.json → restoreFromTrash 永远找不到它，删除变得不可恢复。
 *
 * 现在锁死：先搬数据、后动索引、失败回滚；回滚也失败则标 failed 并由启动对账搬回；
 * 搬到一半被杀（无 restore.json）由启动对账把删除补完。全部用故障注入，确定性复现。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ProfileStore } = require('../src/profiles/store');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {} };
const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `trashsafe-${tag}-`));

/** 建一个"已归档、可删除"的档案（多建一份保底档案，避免触发"最后一份可用档案不可归档"） */
async function makeArchived(store, nickname = 'A') {
  const p = await store.create({ nickname });
  await store.create({ nickname: '保底' });
  await store.update(p.id, { archive: true });
  return p;
}
const has = (store, id) => { try { store.get(id); return true; } catch (_) { return false; } };
const trashDirsWithData = (dir) => {
  const trash = path.join(dir, 'profiles', 'trash');
  if (!fs.existsSync(trash)) return [];
  return fs.readdirSync(trash).filter((n) => fs.existsSync(path.join(trash, n, 'profile-dir')));
};

test('删除：rename 失败时档案与索引都完好，且不留半个回收区', async () => {
  const dir = tmpDir('rename');
  const store = new ProfileStore({ dataDir: dir, logger: silentLogger });
  const a = await makeArchived(store);
  const orig = fs.renameSync;
  fs.renameSync = () => { const e = new Error('EPERM: injected'); e.code = 'EPERM'; throw e; };
  try {
    await assert.rejects(() => store.trash(a.id), /EPERM/);
  } finally { fs.renameSync = orig; }
  assert.ok(has(store, a.id), 'rename 失败后档案必须还在（旧实现会先从索引里消失）');
  assert.ok(store.list().some((p) => p.id === a.id), '索引里必须还列着它');
  assert.ok(fs.existsSync(store.profileFile(a.id)), '档案文件必须还在原地');
  assert.deepStrictEqual(trashDirsWithData(dir), [], '不该留下半个回收区');
});

test('删除：索引写失败 → 回滚，档案照旧可用', async () => {
  const dir = tmpDir('idx');
  const store = new ProfileStore({ dataDir: dir, logger: silentLogger });
  const a = await makeArchived(store);
  const origWrite = store._writeIndex.bind(store);
  store._writeIndex = async () => { throw new Error('EIO: injected'); };
  try {
    await assert.rejects(() => store.trash(a.id), /EIO/);
  } finally { store._writeIndex = origWrite; }
  assert.ok(has(store, a.id), '索引写失败后必须把数据搬回来');
  assert.ok(store.list().some((p) => p.id === a.id));
  assert.ok(fs.existsSync(store.profileFile(a.id)));
  assert.deepStrictEqual(trashDirsWithData(dir), [], '回滚后不该留下 profile-dir');
});

test('删除：索引写失败且回滚也失败 → 标 failed，下次启动自动搬回', async () => {
  const dir = tmpDir('failed');
  const store = new ProfileStore({ dataDir: dir, logger: silentLogger });
  const a = await makeArchived(store);
  const origWrite = store._writeIndex.bind(store);
  store._writeIndex = async () => { throw new Error('EIO: injected'); };
  const origRename = fs.renameSync;
  let n = 0;
  fs.renameSync = (from, to) => {
    n += 1;
    if (n >= 2) { const e = new Error('EBUSY: injected'); e.code = 'EBUSY'; throw e; } // 第 2 次是回滚
    return origRename(from, to);
  };
  try {
    await assert.rejects(() => store.trash(a.id), /回收区/);
  } finally { fs.renameSync = origRename; store._writeIndex = origWrite; }
  const ids = fs.readdirSync(path.join(dir, 'profiles', 'trash'));
  assert.strictEqual(ids.length, 1, '数据必须留在回收区，不能丢');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'profiles', 'trash', ids[0], 'restore.json'), 'utf8'));
  assert.strictEqual(meta.state, 'failed', '必须标 failed，否则启动对账会误当正常删除把档案"删掉"');
  const store2 = new ProfileStore({ dataDir: dir, logger: silentLogger });
  assert.ok(has(store2, a.id), '重启后档案必须回到可用状态');
  assert.ok(store2.list().some((p) => p.id === a.id), '索引必须重新列上它');
});

test('启动对账：搬到一半被杀（无 restore.json）→ 自动把删除补完且数据可恢复', async () => {
  const dir = tmpDir('crash');
  const store = new ProfileStore({ dataDir: dir, logger: silentLogger });
  const a = await makeArchived(store);
  const trash = path.join(dir, 'profiles', 'trash');
  const archiveId = `1700000000000-${a.id}`;
  fs.mkdirSync(path.join(trash, archiveId), { recursive: true });
  fs.renameSync(store.profileDir(a.id), path.join(trash, archiveId, 'profile-dir'));
  // 前置：**索引**里仍列着它（list() 会因为目录已不在而过滤掉它，所以要直接看落盘的索引）
  assert.ok(store._readIndex().profiles.some((p) => p.id === a.id), '前置：索引仍列着它（这就是中断现场）');
  const store2 = new ProfileStore({ dataDir: dir, logger: silentLogger });
  const meta = JSON.parse(fs.readFileSync(path.join(trash, archiveId, 'restore.json'), 'utf8'));
  assert.strictEqual(meta.id, a.id);
  assert.strictEqual(meta.state, 'trashed');
  assert.ok(!store2._readIndex().profiles.some((p) => p.id === a.id), '删除应被补完：索引不再列它');
  assert.ok((store2.listTrash().find((t) => t.archiveId === archiveId) || {}).restorable, '回收区里必须仍可恢复');
  const back = store2.restoreFromTrash(archiveId);
  assert.strictEqual(back.id, a.id);
  assert.ok(has(store2, a.id));
});

test('正常回收区不被启动对账误动；恢复是搬移，二次恢复报 404', async () => {
  const dir = tmpDir('normal');
  const store = new ProfileStore({ dataDir: dir, logger: silentLogger });
  const a = await makeArchived(store);
  await store.trash(a.id);
  const trash = path.join(dir, 'profiles', 'trash');
  const ids = fs.readdirSync(trash);
  assert.strictEqual(ids.length, 1);
  const store2 = new ProfileStore({ dataDir: dir, logger: silentLogger });
  assert.strictEqual(fs.readdirSync(trash).length, 1, '正常回收区不该被对账动过');
  assert.ok(!has(store2, a.id), '正常的删除结果必须保持删除');
  const back = store2.restoreFromTrash(ids[0]);
  assert.strictEqual(back.id, a.id);
  assert.ok(has(store2, a.id));
  assert.strictEqual(store2.list().filter((p) => p.id === a.id).length, 1, '索引里只能有一份');
  // 恢复成功后，回收区里只剩 restore.json 墓碑：它必须留在磁盘上（供启动对账与诊断），
  // 但**不能再出现在 listTrash()/接口/界面里** —— 否则用户看到"恢复成功却还挂着一条不可恢复"。
  assert.strictEqual(store2.listTrash().length, 0, '恢复成功后该条应从回收站列表消失');
  assert.ok(fs.existsSync(path.join(trash, ids[0], 'restore.json')), '墓碑仍保留在磁盘上');
  assert.throws(() => store2.restoreFromTrash(ids[0]), /回收区没有该档案/, '搬移后不能重复恢复');
  assert.throws(() => store2.restoreFromTrash('../etc'), /非法 archiveId/);
});
