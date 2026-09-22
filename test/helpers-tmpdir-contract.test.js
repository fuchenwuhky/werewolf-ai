/**
 * helpers-tmpdir-contract.test.js — `makeApiIn` 的 opts 契约（缺口 D：opts.logger 被静默忽略）
 *
 * ## 真实缺口
 * `makeApiIn(dataDir, opts)` 只消费 `opts.config` 与 `opts.logger` 两个键，但旧实现把 logger
 * **写死**成模块内的静默 logger：传 `{ logger }` 既不报错、也不生效，只在文档注释里写着
 * "其它键一律不生效"。调用方于是以为自己的 logger 生效了 —— "我明明打了日志怎么什么都没有"
 * 这类排查要花掉一整轮。同类的还有 `saveDir`：它必须恒等于 `<dataDir>/saves`（独占根语义）。
 *
 * ## 钉住两件事
 *   ① `opts.logger` **真的生效**：用行为判据（构造期必然写一条 `已建立密钥-地址绑定`）证明
 *      注入的 logger 收到了这条日志，而不是只看 `api.logger` 这个字段被赋值；
 *   ② 不支持的键**抛错**：`saveDir` 之类的键必须当场炸，绝不静默忽略。
 *
 * 本文件不构造 `new Api(...)`（一律走 `makeApiIn`），也不碰 `os.tmpdir()` 常量路径 ——
 * test/tmp-isolation-guard.test.js 的三条静态检查照旧成立。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDataDir, makeApiIn, terminateAfter } = require('./helpers-tmpdir');

/** 计数 logger：把每次调用记进 calls，形状与 helpers-tmpdir 的 silentLogger 一致 */
function spyLogger(calls) {
  const push = (level) => (...args) => { calls.push({ level, args }); };
  return {
    debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error'),
    openGameLog: push('openGameLog'), closeGameLog: push('closeGameLog'), query: () => [],
  };
}

test('makeApiIn：opts.logger 必须真的生效（注入的 logger 要收到构造期日志）', (t) => {
  const dataDir = makeDataDir('a3c-logger');
  let api = null;
  terminateAfter(t, () => api, dataDir);
  const calls = [];
  const logger = spyLogger(calls);
  api = makeApiIn(dataDir, { logger }).api;

  // 行为判据：默认 config 带 apiKey 且磁盘上没有 keyBinding ⇒ 构造期必然写一条 info
  const bound = calls.filter((c) => c.level === 'info' && /密钥-地址绑定/.test(String(c.args[1])));
  assert.ok(
    bound.length >= 1,
    'opts.logger 没有收到构造期日志 —— 它被静默忽略了（这正是本用例要钉住的缺口）：'
    + `实收 ${calls.length} 条 ${JSON.stringify(calls.slice(0, 3))}`,
  );
  // 同一个 logger 也必须被挂到实例上（后续调用方自己写日志时用的是它）
  assert.strictEqual(api.logger, logger, 'api.logger 必须就是注入的那个 logger');
});

test('makeApiIn：不传 opts.logger 时仍是静默 logger（不抛错、方法齐全）', (t) => {
  const dataDir = makeDataDir('a3c-silent');
  let api = null;
  terminateAfter(t, () => api, dataDir);
  api = makeApiIn(dataDir).api;
  assert.notStrictEqual(api.logger, null, '默认 logger 必须存在');
  for (const m of ['debug', 'info', 'warn', 'error', 'openGameLog', 'closeGameLog', 'query']) {
    assert.strictEqual(typeof api.logger[m], 'function', `静默 logger 缺少 ${m}()`);
  }
  assert.doesNotThrow(() => api.logger.info('api', '静默 logger 调用不得抛错'));
});

test('makeApiIn：不支持的 opts 键必须抛错，绝不静默忽略', (t) => {
  const dataDir = makeDataDir('a3c-unknown-opt');
  let api = null;
  // 先挂清理再构造：未知键那两次是在构造 Api 之前就抛了，这里用 getter 形式兼容 api 仍为 null
  terminateAfter(t, () => api, dataDir);
  assert.throws(
    () => makeApiIn(dataDir, { saveDir: 'D:\\somewhere-else' }),
    /不支持这些 opts 键：saveDir/,
    'saveDir 被静默忽略会破坏"独占根"的语义前提，必须当场抛错',
  );
  assert.throws(
    () => makeApiIn(dataDir, { loggerSilent: true }),
    /不支持这些 opts 键：loggerSilent/,
  );
  // 支持的两个键都不得被未知键检查误伤
  api = makeApiIn(dataDir, { config: { get: () => ({ apiKey: '', journal: false }), save() {} } }).api;
  assert.strictEqual(typeof api.logger.info, 'function', 'config 是支持的键，不许被未知键检查误伤');
});
