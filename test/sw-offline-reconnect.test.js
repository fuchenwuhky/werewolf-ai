/**
 * sw-offline-reconnect.test.js — 「离线 → 恢复在线」这段路的行为（FIX-21）
 *
 * 验收报告的盲区：断网能起页这件事已经修过（SHELL 补齐 + ignoreSearch 兜底），但**没有任何用例
 * 覆盖"从离线恢复到在线之后会怎样"**。而这里恰好藏着最贵的一类故障：
 *   · 恢复联网后还一直吃缓存里的旧脚本（旧版「缓存优先 + 后台更新」就是这样，前端修复永远到不了老用户）；
 *   · 恢复联网后导航还被钉在缓存外壳上（页面看着能开，其实是死的）；
 *   · 反过来，把该缓存的静态资源和**不该缓存**的接口响应混在一起（断网重连后拿到过期的对局状态）。
 *
 * 做法：用 test/helpers-sw-module.js 把 web/sw.js 真的跑起来，配一个**可以随时断网的可控站点桩**
 * （`online=false` 时 fetch 抛错，与浏览器断网同形），然后按「在线首拉 → 断网 → 再断网拿缓存 →
 * 恢复联网拿到新内容 → 再断网确认缓存已被刷新 → 导航恢复」逐步断言**响应体与缓存内容**。
 * 不是源码形状测试：断言看的是"这次请求到底返回了什么、缓存里到底存了什么"。
 *
 * 顺带发现（写成本文件末尾那条 todo，刻意不让它红）：`web/sw.js` 的预缓存写进 `SHELL_CACHE`，
 * 而静态资源的离线兜底只查 `ASSET_CACHE` —— "装完 SW 还没联网加载过子资源就断网"这条路径上，
 * 脚本仍然 miss。修它要改 web/sw.js（本次任务禁改），所以留成**看得见**的缺口而不是悄悄放过。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  SwResponse,
  makeCacheStorage,
  loadSw,
  makeRequest,
} = require('./helpers-sw-module');

/**
 * 可控站点桩：online=false 时所有请求都抛错（= 断网）；
 * 在线时按路径返回内容，`html`/`app` 两个版本号用来模拟"服务端换了新内容但 URL 没变"。
 */
function makeSite() {
  const state = { online: true, html: 'H1', app: 'A1' };
  const net = async (req) => {
    if (!state.online) throw new TypeError('fetch failed（离线）');
    const p = new URL(req.url).pathname;
    if (p === '/') return new SwResponse(`LIVE-ROOT:${state.html}`);
    if (p === '/index.html') return new SwResponse(`LIVE-INDEX:${state.html}`);
    if (p === '/m/index.html') return new SwResponse(`LIVE-MINDEX:${state.html}`);
    if (p === '/app.js') return new SwResponse(`APP:${state.app}`);
    if (p === '/style.css') return new SwResponse('CSS:1');
    if (p === '/opaque.png') return new SwResponse('opaque', { status: 200, type: 'opaque' });
    return new SwResponse(`ASSET:${p}`);
  };
  return { state, net };
}

/** 装好一个"已经接管页面"的 SW（走真实的 install + activate） */
async function bootedSw(site) {
  const caches = makeCacheStorage(site.net);
  const sw = loadSw({ caches, fetch: site.net });
  await sw.dispatch('install');
  await sw.dispatch('activate');
  return { sw, caches };
}

test('离线 → 恢复在线：重连后拿到新资源、缓存被刷新、导航恢复，不再卡在旧缓存', async () => {
  const site = makeSite();
  const { sw, caches } = await bootedSw(site);

  // ① 在线首拉：返回网络内容，并且**落盘**（离线才有得回退）
  const first = await sw.fetch(makeRequest('/app.js?v=aaa'));
  assert.strictEqual(first.proxied, true, '同源静态资源必须被 SW 代理');
  assert.strictEqual(first.response.body, 'APP:A1', '在线时必须返回网络内容');
  assert.strictEqual(caches._has(sw.assetCache, '/app.js?v=aaa'), true, '在线响应必须落盘，否则断网没得回退');

  // ② 断网：同 URL 从缓存拿到 v1（"离线还能看牌局"）
  site.state.online = false;
  const offline = await sw.fetch(makeRequest('/app.js?v=aaa'));
  assert.strictEqual(offline.response.body, 'APP:A1', '断网必须回退到缓存副本');

  // ②b 断网 + **换一个查询串**（URL 变了但路径相同）：忽略查询串的兜底必须命中同一份缓存
  const offlineQueried = await sw.fetch(makeRequest('/app.js?v=bbb-new-hash'));
  assert.strictEqual(offlineQueried.response.body, 'APP:A1', '离线兜底必须忽略查询串，命中同路径的已缓存副本');

  // ③ 恢复在线 + 服务端换了内容（URL 不变）：必须拿到 v2，而不是继续吃缓存里的 v1
  site.state.online = true;
  site.state.app = 'A2';
  const reconnected = await sw.fetch(makeRequest('/app.js?v=aaa'));
  assert.strictEqual(reconnected.response.body, 'APP:A2', '网络优先：恢复联网后不得继续返回缓存里的旧脚本');

  // ④ 缓存已被这次在线请求刷新：再断网应拿到 v2（而不是"永远停在 v1"）
  site.state.online = false;
  const afterRefresh = await sw.fetch(makeRequest('/app.js?v=aaa'));
  assert.strictEqual(afterRefresh.response.body, 'APP:A2', '在线请求必须把新内容写回缓存，否则下次断网又退回旧脚本');

  // ⑤ 导航：断网退回外壳；恢复联网必须回到实时页面（不能被永久钉在缓存外壳上）
  const nav = makeRequest('/', { mode: 'navigate' });
  const offlineNav = await sw.fetch(nav);
  assert.strictEqual(offlineNav.response.body, 'LIVE-INDEX:H1', '断网导航应命中预缓存的 /index.html 外壳');
  const offlineMobileNav = await sw.fetch(makeRequest('/m/game/1', { mode: 'navigate' }));
  assert.strictEqual(offlineMobileNav.response.body, 'LIVE-MINDEX:H1', '手机端路径断网应命中 /m/index.html 外壳');

  site.state.online = true;
  site.state.html = 'H2';
  const onlineNav = await sw.fetch(nav);
  assert.strictEqual(onlineNav.response.body, 'LIVE-ROOT:H2', '恢复联网后导航必须回到实时页面，而不是缓存外壳');

  // ⑥ 从未缓存过、且预缓存里没有的资源：断网时必须明确失败，不得伪造一个"能用"的响应
  site.state.online = false;
  let failed = null;
  try {
    await sw.fetch(makeRequest('/never-cached-anywhere.js'));
  } catch (e) {
    failed = e;
  }
  assert.ok(failed, '离线且无缓存时必须抛错（伪造响应会让人以为资源还在）');
  assert.match(String(failed && failed.message), /offline and not cached/, `错误信息必须点明"离线且未缓存"，实际：${String(failed && failed.message)}`);
});

test('离线重连的另一半：/api/、跨域与写操作一律不代理、不落盘（否则重连后拿到过期对局状态）', async () => {
  const site = makeSite();
  const { sw, caches } = await bootedSw(site);

  const api = await sw.fetch(makeRequest('/api/games/abc/view'));
  assert.strictEqual(api.proxied, false, '接口请求必须直接放行（缓存了就会看到"时间停止"的假对局）');
  const write = await sw.fetch(makeRequest('/api/games/abc/action', { method: 'POST' }));
  assert.strictEqual(write.proxied, false, '写操作永不代理');
  const crossOrigin = await sw.fetch(makeRequest('http://example.invalid/app.js'));
  assert.strictEqual(crossOrigin.proxied, false, '跨域请求交给浏览器');

  assert.strictEqual(caches._size(sw.assetCache), 0, '接口/跨域请求不得往缓存里写任何东西');
});

test('离线兜底顺序：同路径存了多个版本时，精确命中优先于 ignoreSearch 的任意副本（顺序反了会发错版本）', async () => {
  const site = makeSite();
  const { sw } = await bootedSw(site);

  await sw.fetch(makeRequest('/app.js?v=old')); // 先缓存旧版本（A1）
  site.state.app = 'A2';
  await sw.fetch(makeRequest('/app.js?v=new')); // 再缓存新版本（A2）

  site.state.online = false;
  const byNew = await sw.fetch(makeRequest('/app.js?v=new'));
  assert.strictEqual(byNew.response.body, 'APP:A2', '按 ?v=new 精确命中时必须给新版本（先精确、后忽略查询串，顺序不能反）');
  const byOld = await sw.fetch(makeRequest('/app.js?v=old'));
  assert.strictEqual(byOld.response.body, 'APP:A1', '按 ?v=old 精确命中时必须给旧版本本身，而不是"同路径随便一份"');
});

test('非 basic（不透明）响应不得落盘：缓存里只留能验证内容的东西', async () => {
  const site = makeSite();
  const { sw, caches } = await bootedSw(site);

  const opaque = await sw.fetch(makeRequest('/opaque.png'));
  assert.strictEqual(opaque.response.type, 'opaque', '夹具前提：这条响应是不透明类型');
  assert.strictEqual(caches._has(sw.assetCache, '/opaque.png'), false, '不透明响应不得进缓存（内容不可验证，回退出来也没法用）');

  const basic = await sw.fetch(makeRequest('/style.css'));
  assert.strictEqual(basic.response.body, 'CSS:1', '普通同源响应必须照常返回网络内容');
  assert.strictEqual(caches._has(sw.assetCache, '/style.css'), true, '普通同源响应必须照常落盘');
});

/**
 * 已知缺口（写成 todo，刻意不让它红）：`web/sw.js` 的预缓存写进 `SHELL_CACHE`（sw.js:59），
 * 而静态资源的离线兜底只查 `ASSET_CACHE`（sw.js:83/96-99）。于是「装完 SW、还没联网加载过子资源
 * 就断网」时，页面外壳能打开（导航查的是 SHELL_CACHE），它引用的 `app.js?v=<哈希>` 却查不到
 * —— 注释里写的那条 P1（"装完 SW 还没再联网就断网，页面外壳在、脚本全 miss"）在这条路径上仍然成立。
 *
 * 为什么是 todo 而不是移除：修它要改 `web/sw.js`（本次任务明令禁改，且 FIX-01/02 刚定稿），
 * 所以把它留在测试里当作**看得见的缺口**：一旦有人把兜底改成同时查两个仓，这条会自动变成通过
 * （那时 todo 计数会归零，提醒把这个标记摘掉）。
 */
test('【已知缺口】装完 SW 就断网：子资源应当能从预缓存（SHELL 仓）命中', { todo: '兜底只查 ASSET_CACHE，预缓存条目在 SHELL_CACHE —— 见本文件末尾注释与验收报告' }, async () => {
  const site = makeSite();
  const { sw } = await bootedSw(site);

  // 从未联网加载过带查询串的子资源：此刻只有 install 的预缓存（无查询串）
  site.state.online = false;
  const res = await sw.fetch(makeRequest('/app.js?v=never-fetched-online'));
  assert.strictEqual(res.response.body, 'APP:A1', '应当忽略查询串命中预缓存里的 /app.js');
});
