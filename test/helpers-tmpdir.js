/**
 * helpers-tmpdir.js — 测试用「独占 dataDir」辅助（非测试文件，不会被 node --test 发现）
 *
 * 背景（全量偶发失败的真根因）：
 *   `src/api.js` 用 `path.dirname(this.saveDir)` 推导三个**档案侧**路径 ——
 *   ProfileStore 根 `<dataDir>/profiles`、迁移游标 `<dataDir>/migrations`、
 *   迁移源目录 `<dataDir>/saves`。如果测试把 saveDir 建在 `os.tmpdir()` 下的**平铺**位置
 *   （`fs.mkdtempSync(path.join(os.tmpdir(), 'xxx-'))` 然后直接当 saveDir），那 dirname 就是
 *   `os.tmpdir()` 本身，于是 `%TEMP%\profiles`、`%TEMP%\migrations` 变成**全机共享**路径：
 *     - `node --test` 默认并行跑各测试文件，多个进程同时把 `profiles/index.json.tmp-<pid>-<ts>`
 *       rename 成 `profiles/index.json`，Windows 会间歇性 EPERM；
 *     - 每个用例都往共享目录塞一份迁移产物，垃圾持续堆积。
 *
 * 正确写法：每个用例一份独占根 `dataDir`，saveDir = `<dataDir>/saves`，收尾删 `dataDir`。
 * 本文件把"建独占根 / 收尾删除"抽出来给多个测试文件复用（同款语义见 test/profiles-api.test.js）。
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 建一份独占 dataDir（已含 <dataDir>/saves 子目录，直接可当 api 的 saveDir） */
function makeDataDir(tag) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `ww-${tag}-`));
  fs.mkdirSync(path.join(dataDir, 'saves'), { recursive: true });
  return dataDir;
}

/** 独占根下的存档目录（= src/api.js 的 saveDir；makeDataDir 已建好它） */
function savesOf(dataDir) {
  return path.join(dataDir, 'saves');
}

/** 静默 logger（各测试文件自己有同款；这里给 makeApiIn 用，避免调用方必须传） */
const silentLogger = {
  debug() {}, info() {}, warn() {}, error() {},
  openGameLog() {}, closeGameLog() {}, query() { return []; },
};

/**
 * 在给定独占根里建一个 Api（saveDir = <dataDir>/saves），返回 { api, dataDir }。
 * 多个 Api 需要共享同一份独占根时（模拟"改配置后重启"）复用它即可。
 */
function makeApiIn(dataDir, opts = {}) {
  const { Api } = require('../src/api');
  const savesDir = savesOf(dataDir);
  if (!fs.existsSync(savesDir)) fs.mkdirSync(savesDir, { recursive: true });
  const api = new Api({
    config: opts.config || { get: () => ({ apiKey: 'k', journal: false }), save() {} },
    logger: silentLogger,
    saveDir: savesDir,
  });
  return { api, dataDir };
}

/**
 * 等 Api 构造期的档案迁移收尾（它仍会写 <dataDir>/profiles/index.json）。
 * 不等就删独占根，会出现"删目录 ↔ 迁移写文件"的竞态（Windows 上 EPERM/ENOTEMPTY）。
 */
async function settleApi(api) {
  if (!api || !api._profileMigrationReady) return;
  try { await api._profileMigrationReady; } catch (_) { /* 迁移失败不影响清理 */ }
}

/**
 * 删除独占 dataDir：先等迁移就绪，再删；刚写完的文件可能被杀软/索引器短暂占用，
 * 故只对 EPERM/EBUSY/ENOTEMPTY/EACCES 做有限次退避重试，最终失败仍抛出（不吞错）。
 */
async function dispose(dataDir) {
  if (!dataDir) return;
  for (let i = 0; ; i++) {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); return; }
    catch (e) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 20 * (i + 1)));
    }
  }
}

/** 收尾一步到位：settleApi(api) → dispose(dataDir)（api/dataDir 可能因构造前抛错而为 undefined） */
async function terminateApi(api, dataDir) {
  await settleApi(api);
  await dispose(dataDir);
}

module.exports = { makeDataDir, savesOf, makeApiIn, settleApi, dispose, terminateApi };
