/**
 * tmp-cleanup.test.js — 崩溃遗留临时文件的启动清理（FIX-12 回归）
 *
 * 背景：写入是"临时文件 → rename"，进程被杀只会留下半截 tmp，正式文件永远完整。
 * 旧实现有两个洞，缺一不可：
 *   ① `_cleanupStaleTmp()` **没有调用者**（只在 src/api.js 里定义着）→ 崩溃遗留的 tmp 永远躺在数据目录；
 *   ② 过滤条件是 `endsWith('.json.tmp')`，只认 saveGame 的后缀式命名，认不出导入/恢复的 `.tmp-*`
 *      与旧迁移的 `.migtmp` → 那两类哪怕被调用也清不掉。
 * 本文件同时钉住三件事：**构造函数真的会清**、**只清陈旧的**（新鲜 tmp 可能是别的进程正在写）、
 * **绝不碰正常存档**（它同样"很旧"，但它是数据不是残渣）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Api } = require('../src/api');
const { ProfileStore } = require('../src/profiles/store');
const { tmpPathFor } = require('../src/tmp-files');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {}, query() { return []; } };
const HOUR = 60 * 60 * 1000;

/** 把 mtime/atime 拨回 ms 毫秒之前（模拟"上一个进程崩溃时留下的"） */
function backdate(file, ms) {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(file, t, t);
}

function makeApi(saves) {
  return new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: saves });
}

test('FIX-12：启动清理只删陈旧 tmp（三种历史命名），不动新鲜 tmp 与正常存档', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-tmpclean-'));
  const saves = path.join(dataDir, 'saves');
  fs.mkdirSync(saves, { recursive: true });
  let api = null;
  try {
    // 正常存档：mtime 同样很旧 —— "旧"不是删除的理由，它必须活下来
    const real = path.join(saves, 'g-real.json');
    fs.writeFileSync(real, JSON.stringify({ schemaVersion: 2, game: { id: 'g-real', players: [] } }));
    backdate(real, 6 * HOUR);
    // 陈旧 tmp：saveGame 后缀式 / 导入恢复前缀式 / 旧迁移遗留后缀式，三种命名都要被认出来
    const stale = ['g-old.json.tmp', '.tmp-g-old.json-4242-1', 'legacy.migtmp'];
    for (const n of stale) {
      fs.writeFileSync(path.join(saves, n), '{"half":');
      backdate(path.join(saves, n), HOUR); // 1 小时前 > STALE_TMP_MS(10min)
    }
    // 新鲜 tmp：可能是另一个进程**正在写**的文件，一概不动
    const fresh = ['g-live.json.tmp', '.tmp-g-live.json-999-2'];
    for (const n of fresh) fs.writeFileSync(path.join(saves, n), '{"half":');

    api = makeApi(saves); // 构造函数内必须真的执行一次清理

    for (const n of stale) {
      assert.strictEqual(fs.existsSync(path.join(saves, n)), false, `陈旧 tmp 必须被启动清理：${n}`);
    }
    for (const n of fresh) {
      assert.strictEqual(fs.existsSync(path.join(saves, n)), true, `新鲜 tmp 不得删除（可能别的进程正在写）：${n}`);
    }
    assert.strictEqual(fs.existsSync(real), true, '正常存档不得被清理');
    assert.strictEqual(
      JSON.parse(fs.readFileSync(real, 'utf8')).game.id, 'g-real',
      '正常存档内容必须原样（清理绝不触碰非 tmp 文件）',
    );

    // 幂等：再清一次没有陈旧项 → 0（不允许"第二次又删掉新鲜 tmp"这种年龄门失效）
    assert.strictEqual(api._cleanupStaleTmp(), 0, '无陈旧 tmp 时清理数必须是 0');
    assert.strictEqual(fs.existsSync(path.join(saves, fresh[0])), true, '第二次清理仍不得动新鲜 tmp');

    // 年龄门是唯一判据：把"新鲜"的拨旧，同一份代码必须删得掉它们
    for (const n of fresh) backdate(path.join(saves, n), HOUR);
    assert.strictEqual(api._cleanupStaleTmp(), fresh.length, '拨旧之后它们就是陈旧 tmp，必须被清理');
    for (const n of fresh) assert.strictEqual(fs.existsSync(path.join(saves, n)), false, `陈旧化后必须删除：${n}`);
    assert.strictEqual(fs.existsSync(real), true, '整个过程中正常存档始终不得被删');
  } finally {
    if (api) { try { await api._profileMigrationReady; } catch (_) { /* 迁移失败不影响清理 */ } }
    clearInterval(api && api._saveTimer);
    clearInterval(api && api._streamTimer);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('FIX-12：档案仓（ProfileStore）启动清理——档案/标注目录的陈旧 tmp 被清，回收站分毫未动', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-tmpclean3-'));
  try {
    // ① 先造出**真实落盘布局**（夹具必须放在代码真正写文件的位置，不是 saves/）
    const store = new ProfileStore({ dataDir, logger: silentLogger });
    const a = await store.create({ nickname: '甲' });
    const b = await store.create({ nickname: '乙' });
    await store.update(b.id, { archive: true });
    await store.trash(b.id); // → profiles/trash/<archiveId>/{restore.json, profile-dir/...}

    const trashRoot = path.join(store.root, 'trash');
    const archiveIds = fs.readdirSync(trashRoot);
    assert.strictEqual(archiveIds.length, 1, '前置：回收站里应有一条可恢复档案');
    const trashEntry = path.join(trashRoot, archiveIds[0]);
    const trashProfileDir = path.join(trashEntry, 'profile-dir');

    // 标注目录（AnnotationStore 的落盘位置）
    const annoDir = path.join(store.root, a.id, 'annotations');
    fs.mkdirSync(annoDir, { recursive: true });
    fs.writeFileSync(path.join(annoDir, 'g1.json'), JSON.stringify({ schemaVersion: 2, profileId: a.id, gameId: 'g1', revision: 1, seats: { 1: { leaning: 'lean_wolf' } } }));

    // ② 陈旧残渣：三种真实命名族，分别落在根目录 / 档案目录 / 标注目录
    const stale = [
      path.join(store.root, 'index.json.tmp-4242-1'),                  // C 族（旧档案仓中缀命名）
      path.join(store.root, a.id, 'profile.json.tmp-4242-2'),          // C 族
      path.join(annoDir, path.basename(tmpPathFor(path.join(annoDir, 'g1.json'), 4242))), // A 族（新前缀命名）
    ];
    for (const f of stale) { fs.writeFileSync(f, '{"half":'); backdate(f, HOUR); }
    // ③ 新鲜残渣：可能是别的进程正在写，不许删
    const fresh = [
      path.join(store.root, 'index.json.tmp-999-9'),
      path.join(store.root, a.id, path.basename(tmpPathFor(path.join(store.root, a.id, 'profile.json'), 999))),
    ];
    for (const f of fresh) fs.writeFileSync(f, '{"half":');
    // ④ 回收站里故意放一个"陈旧 tmp"：回收站是用户数据（等着恢复的档案），必须原封不动
    const trashTmp = path.join(trashProfileDir, 'profile.json.tmp-4242-7');
    fs.writeFileSync(trashTmp, '{"half":');
    backdate(trashTmp, HOUR);
    // ⑤ 越界哨兵：migrations/ 与 dataDir 顶层不在档案仓的清理范围内（不能在别人的目录里删东西）
    const migrations = path.join(dataDir, 'migrations');
    fs.mkdirSync(migrations, { recursive: true });
    const outsideSentinel = path.join(migrations, 'default-profile-id.tmp-4242-5');
    fs.writeFileSync(outsideSentinel, 'x');
    backdate(outsideSentinel, HOUR);

    // ⑥ 记下"用户数据"的指纹，清理后必须逐字节一致
    const trashFilesBefore = listFiles(trashEntry);
    const restoreBytesBefore = fs.readFileSync(path.join(trashEntry, 'restore.json'));
    const profileBytesBefore = fs.readFileSync(path.join(store.root, a.id, 'profile.json'));
    const indexBytesBefore = fs.readFileSync(path.join(store.root, 'index.json'));
    const annoBytesBefore = fs.readFileSync(path.join(annoDir, 'g1.json'));

    // ⑦ 重启（新实例的构造函数里应完成清理）
    new ProfileStore({ dataDir, logger: silentLogger });

    for (const f of stale) assert.strictEqual(fs.existsSync(f), false, `陈旧 tmp 必须被档案仓清理：${path.relative(dataDir, f)}`);
    for (const f of fresh) assert.strictEqual(fs.existsSync(f), true, `新鲜 tmp 不得删除：${path.relative(dataDir, f)}`);
    assert.strictEqual(fs.existsSync(trashTmp), true, '回收站里的任何文件都不得被清理触碰');
    assert.deepStrictEqual(listFiles(trashEntry), trashFilesBefore, '回收站内容必须分毫未动（含 restore.json 与 profile-dir）');
    assert.deepStrictEqual(fs.readFileSync(path.join(trashEntry, 'restore.json')), restoreBytesBefore, 'restore.json 必须逐字节一致');
    assert.deepStrictEqual(fs.readFileSync(path.join(store.root, a.id, 'profile.json')), profileBytesBefore, '真实 profile.json 必须逐字节一致');
    assert.deepStrictEqual(fs.readFileSync(path.join(store.root, 'index.json')), indexBytesBefore, '真实 index.json 必须逐字节一致');
    assert.deepStrictEqual(fs.readFileSync(path.join(annoDir, 'g1.json')), annoBytesBefore, '真实标注文件必须逐字节一致');
    assert.strictEqual(fs.existsSync(outsideSentinel), true, '档案仓不得越界清理 migrations/ 等不属于它的目录');
    // 清理后重读还是同一份数据（不能把档案读坏）
    assert.strictEqual(new ProfileStore({ dataDir, logger: silentLogger }).get(a.id).nickname, '甲');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

/** 递归列出目录下所有相对路径（用于"分毫未动"比对） */
function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

test('FIX-12：临时文件命名同族——导入/恢复写出的 tmp 必须能被启动清理识别', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-tmpclean2-'));
  const saves = path.join(dataDir, 'saves');
  fs.mkdirSync(saves, { recursive: true });
  let api = null;
  try {
    // 直接问构造函数产出的实例："按当前命名写出的 tmp，清得掉吗"
    api = makeApi(saves);
    const pkg = {
      manifest: { exportVersion: 1, packageId: 'pkg-tmp', createdAt: '2026-01-01T00:00:00.000Z', source: '测试', counts: { games: 0, notes: 0 } },
      profile: { nickname: '临时文件客', avatarId: 'scholar', bio: '' },
      games: [],
    };
    const out = await api.importApplyRes(pkg);
    assert.strictEqual(out.status, 200, `空对局导入应成功：${JSON.stringify(out.body)}`);
    // 导入成功后不得残留 tmp（正常路径）
    const leftoverOnSuccess = fs.readdirSync(saves).filter((f) => f.startsWith('.tmp-') || f.endsWith('.tmp'));
    assert.deepStrictEqual(leftoverOnSuccess, [], '导入成功后不得残留任何 tmp');

    // 人为造一个"同族命名"的陈旧 tmp（模拟导入中途被杀）：启动清理必须认出来
    const crashed = path.join(saves, '.tmp-g-crashed.json-4242-77');
    fs.writeFileSync(crashed, '{"half":');
    backdate(crashed, HOUR);
    const api2 = makeApi(saves); // 新实例 = 模拟重启
    try {
      assert.strictEqual(fs.existsSync(crashed), false, '导入族的陈旧 tmp 必须被重启清理识别并删除');
    } finally {
      clearInterval(api2._saveTimer); clearInterval(api2._streamTimer);
    }
  } finally {
    if (api) { try { await api._profileMigrationReady; } catch (_) { /* 忽略 */ } }
    clearInterval(api && api._saveTimer);
    clearInterval(api && api._streamTimer);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
