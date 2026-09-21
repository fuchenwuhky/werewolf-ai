/**
 * sw-upgrade.test.js — Service Worker **升级路径**的行为（FIX-21）
 *
 * 验收报告的盲区：现有用例只断言「清单覆盖页面引用」与「清单指纹与 VERSION 联动」，
 * 没有一条覆盖**换了新版本之后**真正发生的事：
 *   ① 新版本的 install 会把整份新清单**重新**预缓存吗？
 *   ② activate 会把旧代的缓存**真的清掉**吗（否则缓存越堆越多，升级形同虚设）？
 *   ③ 新代缓存会不会「继承」旧代条目（如果按固定名字复用缓存，旧条目会留在原地）？
 *   ④ 某个预缓存 URL 404 时，install 会不会整体失败（addAll 的经典坑）？
 *   ⑤ 新版本是停在 waiting，还是偷偷 skipWaiting 把对局中途的前端资源换掉？
 *
 * 做法：不是用正则去抄 sw.js 的形状，而是用 test/helpers-sw-module.js 把它**真的跑一遍** ——
 * 桩掉 caches/fetch/Request/Response/self，先跑一个「上一代 Worker」（只把 VERSION 常量换成旧代次
 * 并往清单里塞一条独有条目），再跑真源码，最后断言**缓存里到底剩下什么**。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  SwResponse,
  readSwSource,
  withVersion,
  withExtraShellUrl,
  makeCacheStorage,
  loadSw,
} = require('./helpers-sw-module');

/** 「什么都有」的服务器桩：任何路径都 200，内容写明是哪条路径（便于断言命中的是哪份缓存） */
const liveNet = async (req) => new SwResponse(`body:${new URL(req.url).pathname}`);

/** 上一代的代次名。必须与当前 VERSION 互不为前缀，否则 activate 的前缀清理会把它当成"本代" */
const OLD_VERSION = 'ww-v13-zz-prev';
/** 只存在于旧代清单里的条目：用来证明新代缓存不是"往同一个仓里续写" */
const LEGACY_ONLY = '/legacy-only-entry.js';

test('升级：新版本 install 重新预缓存整份清单，activate 清掉旧代缓存且新代不继承旧条目', async () => {
  const current = readSwSource();
  const caches = makeCacheStorage(liveNet);

  // ---------- 上一代 Worker：只换 VERSION 常量 + 清单里多一条独有条目，逻辑一行不改 ----------
  const old = loadSw({
    source: withExtraShellUrl(withVersion(current, OLD_VERSION), LEGACY_ONLY),
    caches,
    fetch: liveNet,
  });
  await old.dispatch('install');
  await old.dispatch('activate');
  // 注意：assets 缓存是**按需创建**的（install 只碰 shell 仓），所以此时只应存在 shell 仓
  assert.deepStrictEqual(caches._names(), [`${OLD_VERSION}-shell`], '上一代跑完应只剩下它自己那一代的缓存');
  assert.strictEqual(caches._has(`${OLD_VERSION}-shell`, LEGACY_ONLY), true, '夹具前提：旧代清单里确实有独有条目');
  assert.ok(caches._size(`${OLD_VERSION}-shell`) >= 20, `旧代的预缓存条目也太少（${caches._size(`${OLD_VERSION}-shell`)}）`);

  // ---------- 换上新版本（真源码），共享同一份 CacheStorage ----------
  const fresh = loadSw({ caches, fetch: liveNet });
  const V = fresh.version;
  assert.notStrictEqual(V, OLD_VERSION, '夹具前提：新旧代次必须不同');

  await fresh.dispatch('install');
  const notPrecached = fresh.shell.filter((url) => !caches._has(`${V}-shell`, url));
  assert.deepStrictEqual(notPrecached, [], '新版本 install 必须把整份 SHELL 重新预缓存（缺任何一条，离线打开就缺资源）');
  assert.strictEqual(
    caches._has(`${V}-shell`, LEGACY_ONLY),
    false,
    `新代缓存 ${V}-shell 里出现了只属于上一代的条目 —— 说明预缓存不是按代次重建，而是复用了旧仓`,
  );

  await fresh.dispatch('activate');
  assert.deepStrictEqual(
    caches._names(),
    [`${V}-shell`],
    'activate 必须删掉不属于本代的缓存（否则每升一次版就多留一份旧资源）',
  );
  assert.strictEqual(fresh.stats.claims, 1, 'activate 必须 clients.claim()，否则新版本要等下一次导航才接管现有页面');
  assert.strictEqual(caches._size(`${V}-shell`), fresh.shell.length, '清理只能删旧代，本代外壳条目必须一条不少');
});

test('预缓存逐个 add：某一条 404 不得让整次 install 失败（addAll 会因为一个 404 整体 reject）', async () => {
  const MISSING = '/definitely-missing-xyz.js';
  const net = async (req) => (new URL(req.url).pathname === MISSING
    ? new SwResponse('not found', { status: 404 })
    : new SwResponse(`body:${new URL(req.url).pathname}`));
  const caches = makeCacheStorage(net);
  const sw = loadSw({ source: withExtraShellUrl(readSwSource(), MISSING), caches, fetch: net });

  await sw.dispatch('install'); // 不得抛出：一个 404 不能让整份清单都装不上
  assert.strictEqual(caches._has(`${sw.version}-shell`, MISSING), false, '404 的条目当然进不了缓存');
  const missing = sw.shell.filter((url) => url !== MISSING && !caches._has(`${sw.version}-shell`, url));
  assert.deepStrictEqual(missing, [], '其余条目必须照常全部缓存（这才是"逐个 add + try/catch"的意义）');
  assert.ok(
    sw.warnings.some((w) => w.includes(MISSING)),
    `某个 URL 预缓存失败必须留下可诊断的日志，实际日志：${JSON.stringify(sw.warnings)}`,
  );
});

test('升级切换：新版本停在 waiting，只有页面发 SKIP_WAITING 才切换（对局中途不换前端资源）', async () => {
  const caches = makeCacheStorage(liveNet);
  const sw = loadSw({ caches, fetch: liveNet });
  assert.strictEqual(sw.hasListener('message'), true, '必须有 message 监听器来接 SKIP_WAITING');

  await sw.dispatch('install');
  await sw.dispatch('activate');
  assert.strictEqual(sw.stats.skipWaiting, 0, 'install/activate 全程不得自动 skipWaiting（会造成"页面是旧代码、接口是新行为"的错配）');

  await sw.dispatch('message', { type: 'SKIP_WAITING' });
  assert.strictEqual(sw.stats.skipWaiting, 1, '收到 SKIP_WAITING 必须切换');

  await sw.dispatch('message', { type: 'SOMETHING_ELSE' });
  await sw.dispatch('message', undefined);
  assert.strictEqual(sw.stats.skipWaiting, 1, '其它消息（含空消息）不得触发切换');
});
