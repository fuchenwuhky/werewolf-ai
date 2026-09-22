/**
 * helpers-tmpdir.js — 测试用「独占 dataDir」辅助
 *
 * ⚠ 它**会**被 `node --test` 当成一个测试文件加载：默认发现规则包含 `test/` 目录下的每一个 .js。
 *   实测（Node v24.14.0）：`node --test test/helpers-tmpdir.js` → `✔ test\helpers-tmpdir.js`、`ℹ pass 1`。
 *   所以本文件必须**零副作用、可重复加载**：只在 require 时定义函数，不注册用例、不做 IO、
 *   不改 process.env。谁在这里加一句"顺手建个目录"，全量跑就会多出一份无人清理的残留。
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

/** 建一份独占 dataDir（其中 `<dataDir>/saves` 已建好，用 `savesOf(dataDir)` 取来即可当 api 的 saveDir） */
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
 *
 * `opts.config` 可覆盖默认配置（默认 `{ apiKey: 'k', journal: false }` —— 那个 Key 是假的，
 * 只有 mock 局或不触网的路由才该用默认值）。`opts` 的**其它键一律不生效**：logger 固定为上面的
 * 静默 logger、saveDir 固定为 `<dataDir>/saves`；需要自定义 logger 的用例请直接 `new Api(...)`。
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
 * 删除独占 dataDir —— **纯删除原语：它不等迁移**（等迁移是 `settleApi` 的事，见上）。
 * 刚写完的文件可能被杀软/索引器短暂占用，故只对 EPERM/EBUSY/ENOTEMPTY/EACCES 做有限次
 * （共 5 次，20ms 起的线性退避）重试，最终失败**仍抛出**（不吞错）。
 *
 * ⚠ 因此 Api 场景不要直接调它：构造函数里的档案迁移仍会写 `<dataDir>/profiles/index.json`，
 *   不等就删会落到"删目录 ↔ 迁移写文件"的竞态上（Windows 上 EPERM/ENOTEMPTY）。
 *   该场景一律用 `terminateApi` / `terminateAfter`（它们先 `settleApi` 再删）。
 *   `cleanupAfter` 走的是本函数，所以它只适合"这份临时目录与某个 Api 无关"的用例。
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

/**
 * 用例级清理：把 dir 的删除挂到**这一个用例**的 t.after（node:test）。
 *   - 断言失败 / 抛异常 / 超时都会执行（node:test 保证 after 钩子必跑），红用例不留目录；
 *   - 删除失败**只告警不抛错**：清理问题必须可见（stderr 上一条 `[TMP-LEAK]`），
 *     但不得把原本通过的用例改判为失败。取舍的兜底在套件级：`scripts/tmp-residue-check.js`
 *     给全量测试一个**私有空 TEMP**，跑完要求那里顶层新增为 0（它自己也有"诚实边界"段）。
 * 用法：用例回调签名加 t，再 `cleanupAfter(t, makeDataDir('xxx'))` —— 走 `makeDataDir` 才同时
 *   拿到独占根与 `<dataDir>/saves`；只有当"这份临时目录与 saveDir 无关"时才自己 `fs.mkdtempSync`。
 *   Api 场景请用 `terminateAfter`（要先等迁移收尾），别用本函数。
 * 刻意不用 process.on('exit')：那种"进程退出统一删"既掩盖单个用例的清理缺失，
 * 又在进程被杀（强杀/SIGKILL）时完全失效 —— 而那正是最需要清理的场景。
 */
function cleanupAfter(t, dir) {
  if (!t || typeof t.after !== 'function') {
    throw new TypeError('cleanupAfter 需要 node:test 的 TestContext：请把用例回调改成 (t) => {}');
  }
  t.after(async () => { await removeQuietly(dir); });
  return dir;
}

/**
 * Api 版用例级清理：先等档案迁移收尾（它仍会写 <dataDir>/profiles/index.json）再删，
 * 否则会落到"删目录 ↔ 迁移写文件"竞态（Windows 上 EPERM/ENOTEMPTY）。
 * 删除部分走 `removeQuietly`（失败**只告警不抛错**），这一点与 `dispose` 的"最终失败仍抛出"
 * **不同** —— 用例级清理不许把通过的用例改判为失败。
 *
 * `api` 也可以传**函数**：钩子执行时才调用它取 Api。这样调用方就能把清理**先于** Api 构造挂上，
 * 构造抛错（依赖缺失、saveDir 不可写等）时同样不会漏掉刚建好的独占根：
 *     const dataDir = makeDataDir('x'); let api = null;
 *     terminateAfter(t, () => api, dataDir); api = makeApi(dataDir);
 */
function terminateAfter(t, api, dataDir) {
  if (!t || typeof t.after !== 'function') {
    throw new TypeError('terminateAfter 需要 node:test 的 TestContext：请把用例回调改成 (t) => {}');
  }
  t.after(async () => {
    await settleApi(typeof api === 'function' ? api() : api);
    await removeQuietly(dataDir);
  });
  return dataDir;
}

/** 删除失败不抛错：留一条醒目告警（清理问题可见，但不改变用例的通过 / 失败结论） */
async function removeQuietly(dir) {
  if (!dir) return;
  try { await dispose(dir); }
  catch (e) {
    console.error(`[TMP-LEAK] 临时目录清理失败，用例结果不受影响，请人工清理：${dir} — ${(e && e.code) || e}`);
  }
}

/** 收尾一步到位：settleApi(api) → dispose(dataDir)（api/dataDir 可能因构造前抛错而为 undefined） */
async function terminateApi(api, dataDir) {
  await settleApi(api);
  await dispose(dataDir);
}

module.exports = { makeDataDir, savesOf, makeApiIn, settleApi, dispose, terminateApi, cleanupAfter, terminateAfter };
