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
