/**
 * m2-games-list.test.js — M2-b：档案对局列表（分页/筛选/合并内存+磁盘）、已结束局只读历史、
 * touch 记录"真实最近使用"。
 *
 * ## 本文件对应计划书 docs/next-stage-implementation-plan.md §6 的三行
 *   · `GET  /api/profiles/:id/games`                    可选 status/offset/limit；旧无参数调用保持兼容
 *   · `GET  /api/profiles/:id/games/:gameId/history`    已结束局只读历史，按事件游标分页，不启动引擎或模型
 *   · `POST /api/profiles/:id/touch`                    记录真实最近使用；不制造资料编辑 revision 冲突
 * 以及 §6「接口规则」六条：默认 30/上限 100 + rows/total/hasMore；筛选只支持 all/unfinished/finished；
 * 合并内存与磁盘、同一 gameId 只出现一次、状态以内存为准；日期统一解析为时间值排序；列表只返回公开
 * 摘要（不含令牌/隐藏身份/密钥/AI 内部上下文）；历史校验归属、只允许已结束局（默认 100/上限 200）；
 * 损坏数据返回明确错误而不是空列表。
 *
 * ## 为什么用"真实 HTTP"而不是直接调函数
 * 本文件**不**调 `api.profileGames(...)`，而是 `http.createServer` + `api.handle` 起真服务，
 * 客户端走 `node:http` 发真实请求（刻意不用 globalThis.fetch —— 有一条用例要把它换成探针，
 * 用来证明历史接口不发任何模型请求）。这样测到的是完整链路：路由匹配、权限门、查询参数、
 * JSON 序列化后的**真实响应字节**（脱敏判据只能在真实响应串上搜）。
 *
 * ## 反向验证（每条断言都要能红）
 * 本文件的断言不是"看起来对"：报告里逐条给出了"把实现改坏 → 该用例变红 → 逐字还原（哈希一致）"
 * 的判红原文。为此夹具刻意构造成"旧实现必错"的形态，例如：
 *   · 时间排序用 'Mon, 22 Sep 2025 10:00:00 GMT'（RFC 2822）——旧实现的
 *     `String(savedAt).localeCompare` 会把 'M' 排在 '2' 前面，顺序必然错；
 *   · 内存与磁盘对同一 gameId 给出**相反**的 finished —— 不合并、或不以内存为准都会红；
 *   · touch 之后用**旧 revision** PATCH，且紧跟一条"用过期 revision 必须 409"的反向控制 ——
 *     证明成功不是因为 PATCH 根本不校验 revision。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { makeDataDir, makeApiIn, savesOf, terminateAfter } = require('./helpers-tmpdir');
const { Game } = require('../src/engine/game');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 泄漏判据的哨兵：任何一条出现在响应原文里都算泄漏 */
const SECRETS = [
  'M2B-SECRET-PLAYER-TOKEN', 'M2B-SECRET-GOD-TOKEN', 'M2B-SECRET-JOURNAL', 'M2B-SECRET-ANCHOR',
  'M2B-SECRET-MEMORY', 'M2B-SECRET-ROLE', 'M2B-SECRET-KEY', 'M2B-SECRET-REVIEW', 'M2B-HIDDEN-TEXT',
];
/** 泄漏判据的字段名：公开摘要 / 事件白名单里都不该出现这些键 */
const SECRET_KEYS = ['"tokens"', '"god"', '"journal"', '"anchor"', '"agentStates"', '"visibleTo"',
  '"role"', '"apiKey"', '"playerToken"', '"ownerHumanSeat"', '"review"'];

/**
 * 一份最小对局存档（字段形状照 src/api.js#saveGame 的产出）。
 * tokens/journal/anchor/players[].role 里放的是哨兵串：供"响应体不得泄漏"用例**正向搜索**。
 */
function mkDoc(opts = {}) {
  const {
    id, owner, finished = true, started = true, savedAt = Date.now(), mock = true,
    anchor = null, day = 3, phase = 'ended', winner = 'good', players = [],
    events = [{ seq: 1, day: 1, phase: 'day', type: 'phase', actor: null, text: '夹具公开事件', visibleTo: 'all', ts: 1 }],
  } = opts;
  return {
    schemaVersion: 2,
    tokens: { player: 'M2B-SECRET-PLAYER-TOKEN', god: 'M2B-SECRET-GOD-TOKEN' },
    mock,
    ownerProfileId: owner,
    ownerNicknameSnapshot: '夹具昵称',
    ownerHumanSeat: 1,
    profileSchemaVersion: 1,
    apiKey: 'M2B-SECRET-KEY',
    journal: { decisions: 'M2B-SECRET-JOURNAL' },
    review: { text: 'M2B-SECRET-REVIEW' },
    anchor,
    savedAt,
    game: { id, day, phase, started, finished, winner, players, events },
  };
}

function writeDoc(saves, id, doc) {
  fs.writeFileSync(path.join(saves, `${id}.json`), JSON.stringify(doc));
}

/**
 * 真实 HTTP 夹具：独占 dataDir + 真 Api + 真 http 服务（客户端也用 node:http，
 * 这样 `globalThis.fetch` 可以被换成"模型外呼探针"而不影响本夹具自己）。
 */
async function harness(t, tag) {
  const dataDir = makeDataDir(tag);
  const { api } = makeApiIn(dataDir);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    api.handle(req, res, u.pathname, u.searchParams).catch((e) => {
      try {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      } catch (_) { /* 响应已发出 */ }
    });
  });
  terminateAfter(t, () => api, dataDir); // helpers-tmpdir 的机制：等迁移收尾 + 删独占根
  t.after(() => new Promise((r) => server.close(r)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const request = (method, route, { body, headers } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const head = Object.assign({}, headers || {});
    if (payload) { head['Content-Type'] = 'application/json'; head['Content-Length'] = payload.length; }
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers: head }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* 本文件的路由一律回 JSON */ }
        resolve({ status: res.statusCode, text, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  const mkProfile = async (nickname) => {
    const r = await request('POST', '/api/profiles', { body: { nickname } });
    assert.strictEqual(r.status, 200, `前置：建档案必须成功：${r.text}`);
    return r.body.profile;
  };
  const profileRow = async (id) => {
    const r = await request('GET', '/api/profiles');
    assert.strictEqual(r.status, 200, `前置：档案列表必须可读：${r.text}`);
    const row = r.body.profiles.find((p) => p.id === id);
    assert.ok(row, `前置：档案 ${id} 必须在列表里`);
    return row;
  };
  const ids = (body) => body.rows.map((x) => x.id);
  return { api, dataDir, saves: savesOf(dataDir), port, request, mkProfile, profileRow, ids };
}

const GHOST_PROFILE = '00000000-0000-4000-8000-000000000000';
/** 未配对远端：Host 不在本机白名单 ⇒ auth.isManagement(req) === false（与 test/new-16 同款手法） */
const UNPAIRED = { Host: 'attacker.example' };

test('M2-b 列表①：分页边界 0/1/刚好一页/跨页/offset 超界；无参数调用与旧版同形', async (t) => {
  const h = await harness(t, 'm2b-page');
  const p = await h.mkProfile('M2B-分页');
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  for (let i = 1; i <= 5; i++) writeDoc(h.saves, `m2p${i}`, mkDoc({ id: `m2p${i}`, owner: p.id, savedAt: base - i * 1000 }));

  // 无参数：旧调用方只读 rows，5 条全在（未满默认一页）；新增字段不应改变 rows 的含义
  const plain = await h.request('GET', `/api/profiles/${p.id}/games`);
  assert.strictEqual(plain.status, 200, plain.text);
  assert.deepStrictEqual(h.ids(plain.body), ['m2p1', 'm2p2', 'm2p3', 'm2p4', 'm2p5'], `无参数调用必须返回按时间倒序的一页：${plain.text}`);
  assert.strictEqual(plain.body.total, 5);
  assert.strictEqual(plain.body.hasMore, false);
  // 行的字段集 = 公开摘要白名单（多一个字段都算漂移：这是"只返回公开摘要"的可复核判据）
  assert.deepStrictEqual(Object.keys(plain.body.rows[0]).sort(),
    ['day', 'finished', 'id', 'inMemory', 'mock', 'ownerNickname', 'ownerProfileId', 'phase', 'resumable', 'savedAt', 'started', 'winner'],
    `列表行字段集必须是公开摘要白名单：${plain.text}`);

  // limit=0：0 条，但仍如实告知还有更多（不是"看起来没有数据"）
  const zero = await h.request('GET', `/api/profiles/${p.id}/games?limit=0`);
  assert.strictEqual(zero.status, 200, zero.text);
  assert.deepStrictEqual(zero.body.rows, []);
  assert.strictEqual(zero.body.total, 5);
  assert.strictEqual(zero.body.hasMore, true);

  // limit=1：一条 + hasMore
  const one = await h.request('GET', `/api/profiles/${p.id}/games?limit=1`);
  assert.deepStrictEqual(h.ids(one.body), ['m2p1']);
  assert.strictEqual(one.body.total, 5);
  assert.strictEqual(one.body.hasMore, true);

  // 刚好一页
  const exact = await h.request('GET', `/api/profiles/${p.id}/games?limit=5`);
  assert.deepStrictEqual(h.ids(exact.body), ['m2p1', 'm2p2', 'm2p3', 'm2p4', 'm2p5']);
  assert.strictEqual(exact.body.hasMore, false);

  // 跨页
  const cross = await h.request('GET', `/api/profiles/${p.id}/games?offset=2&limit=2`);
  assert.deepStrictEqual(h.ids(cross.body), ['m2p3', 'm2p4']);
  assert.strictEqual(cross.body.total, 5);
  assert.strictEqual(cross.body.hasMore, true);

  // 末页
  const tail = await h.request('GET', `/api/profiles/${p.id}/games?offset=4&limit=2`);
  assert.deepStrictEqual(h.ids(tail.body), ['m2p5']);
  assert.strictEqual(tail.body.hasMore, false);

  // offset 超界：空页 + hasMore=false（不是 404，也不是悄悄从头开始）
  const over = await h.request('GET', `/api/profiles/${p.id}/games?offset=99`);
  assert.strictEqual(over.status, 200, over.text);
  assert.deepStrictEqual(over.body.rows, []);
  assert.strictEqual(over.body.total, 5);
  assert.strictEqual(over.body.hasMore, false);
  assert.strictEqual(over.body.offset, 99);
});

test('M2-b 列表②：默认每页 30、上限 100（超上限截断而不是 400）', async (t) => {
  const h = await harness(t, 'm2b-cap');
  const p30 = await h.mkProfile('M2B-三十');
  const p100 = await h.mkProfile('M2B-一百');
  const base = Date.parse('2026-02-01T00:00:00.000Z');
  for (let i = 1; i <= 35; i++) {
    const id = `m2d${String(i).padStart(2, '0')}`;
    writeDoc(h.saves, id, mkDoc({ id, owner: p30.id, savedAt: base - i * 1000 }));
  }
  for (let i = 1; i <= 105; i++) {
    const id = `m2e${String(i).padStart(3, '0')}`;
    writeDoc(h.saves, id, mkDoc({ id, owner: p100.id, savedAt: base - i * 1000 }));
  }

  const def = await h.request('GET', `/api/profiles/${p30.id}/games`);
  assert.strictEqual(def.status, 200, def.text);
  assert.strictEqual(def.body.rows.length, 30, `默认每页必须是 30：${def.text}`);
  assert.strictEqual(def.body.limit, 30);
  assert.strictEqual(def.body.total, 35);
  assert.strictEqual(def.body.hasMore, true);
  assert.deepStrictEqual([h.ids(def.body)[0], h.ids(def.body)[29]], ['m2d01', 'm2d30']);

  const next = await h.request('GET', `/api/profiles/${p30.id}/games?offset=30`);
  assert.strictEqual(next.body.rows.length, 5);
  assert.strictEqual(next.body.hasMore, false);
  assert.deepStrictEqual(h.ids(next.body), ['m2d31', 'm2d32', 'm2d33', 'm2d34', 'm2d35']);

  const cap = await h.request('GET', `/api/profiles/${p100.id}/games?limit=1000`);
  assert.strictEqual(cap.status, 200, cap.text);
  assert.strictEqual(cap.body.rows.length, 100, `上限 100：要 1000 条也只能给 100（截断，不是 400）：${cap.text}`);
  assert.strictEqual(cap.body.limit, 100, '响应必须回显生效后的 limit（调用方看得见被截断）');
  assert.strictEqual(cap.body.total, 105);
  assert.strictEqual(cap.body.hasMore, true);
});

test('M2-b 列表③：筛选只支持 all/unfinished/finished；非法值与非法分页参数一律 400', async (t) => {
  const h = await harness(t, 'm2b-filter');
  const p = await h.mkProfile('M2B-筛选');
  const base = Date.parse('2026-03-01T00:00:00.000Z');
  writeDoc(h.saves, 'm2f-fin1', mkDoc({ id: 'm2f-fin1', owner: p.id, finished: true, savedAt: base }));
  writeDoc(h.saves, 'm2f-fin2', mkDoc({ id: 'm2f-fin2', owner: p.id, finished: true, savedAt: base - 1000 }));
  writeDoc(h.saves, 'm2f-unf1', mkDoc({ id: 'm2f-unf1', owner: p.id, finished: false, anchor: { events: [] }, savedAt: base - 2000 }));

  const all = await h.request('GET', `/api/profiles/${p.id}/games?status=all`);
  assert.deepStrictEqual(h.ids(all.body), ['m2f-fin1', 'm2f-fin2', 'm2f-unf1']);
  assert.strictEqual(all.body.status, 'all');

  const fin = await h.request('GET', `/api/profiles/${p.id}/games?status=finished`);
  assert.deepStrictEqual(h.ids(fin.body), ['m2f-fin1', 'm2f-fin2'], fin.text);
  assert.strictEqual(fin.body.total, 2);
  assert.strictEqual(fin.body.hasMore, false);
  assert.strictEqual(fin.body.status, 'finished');

  const unf = await h.request('GET', `/api/profiles/${p.id}/games?status=unfinished`);
  assert.deepStrictEqual(h.ids(unf.body), ['m2f-unf1'], unf.text);
  // 两个筛选桶必须恰好覆盖全量（防止"筛选条件写反/漏一类"这类静默错）
  assert.strictEqual(fin.body.total + unf.body.total, all.body.total);

  // 空串 = 未提供（前端"不筛选"形态）→ 等同 all。这是刻意语义，钉住它
  const empty = await h.request('GET', `/api/profiles/${p.id}/games?status=`);
  assert.strictEqual(empty.status, 200, empty.text);
  assert.strictEqual(empty.body.status, 'all');
  assert.deepStrictEqual(h.ids(empty.body), ['m2f-fin1', 'm2f-fin2', 'm2f-unf1']);

  // 非白名单值：明确 400 + 可读原因（绝不静默当 all）
  for (const bad of ['bogus', 'FINISHED', '1', 'all,finished', 'unfinished ']) {
    const r = await h.request('GET', `/api/profiles/${p.id}/games?status=${encodeURIComponent(bad)}`);
    assert.strictEqual(r.status, 400, `status=${JSON.stringify(bad)} 必须 400：${r.text}`);
    assert.match(r.body.error, /status 只支持 all \/ unfinished \/ finished/, r.text);
  }

  // 分页参数非法：同样是 400 + 可读原因（不静默 clamp）
  for (const q of ['limit=abc', 'limit=-1', 'limit=1.5', `limit=${'9'.repeat(30)}`, 'offset=abc', 'offset=-5', 'offset=%20']) {
    const r = await h.request('GET', `/api/profiles/${p.id}/games?${q}`);
    assert.strictEqual(r.status, 400, `${q} 必须 400：${r.text}`);
    assert.match(r.body.error, /必须是非负整数|超出可表示范围/, r.text);
  }
});

test('M2-b 列表④：合并内存+磁盘、同一 gameId 只出现一次、状态以内存为准', async (t) => {
  const h = await harness(t, 'm2b-merge');
  const p = await h.mkProfile('M2B-合并');
  const other = await h.mkProfile('M2B-别人');
  const base = Date.parse('2026-04-01T00:00:00.000Z');

  // ① 磁盘说未结束、内存说已结束
  writeDoc(h.saves, 'm2x-a', mkDoc({ id: 'm2x-a', owner: p.id, finished: false, anchor: { events: [] }, savedAt: base, day: 1, phase: 'night' }));
  h.api.games.set('m2x-a', {
    game: { id: 'm2x-a', day: 5, phase: 'ended', finished: true, winner: 'wolf', started: true, events: [] },
    running: false, mock: true, ownerProfileId: p.id, ownerNicknameSnapshot: '夹具昵称', createdAt: base, lastAccess: base,
  });
  // ② 磁盘说已结束、内存说还在跑（且磁盘有锚点）
  writeDoc(h.saves, 'm2x-b', mkDoc({ id: 'm2x-b', owner: p.id, finished: true, anchor: { events: [] }, savedAt: base - 1000 }));
  h.api.games.set('m2x-b', {
    game: { id: 'm2x-b', day: 2, phase: 'night', finished: false, winner: null, started: true, events: [] },
    running: true, mock: true, ownerProfileId: p.id, createdAt: base, lastAccess: base,
  });
  // ③ 只有内存、磁盘没有这份档（写盘失败/夹具）：旧实现只扫磁盘 ⇒ 这一局凭空消失
  h.api.games.set('m2x-c', {
    game: { id: 'm2x-c', day: 1, phase: 'day', finished: false, winner: null, started: true, events: [] },
    running: true, mock: false, ownerProfileId: p.id, createdAt: base - 500, lastAccess: base - 500,
  });
  // ④ 别人的对局（磁盘 + 内存各一份）：任何视角都不许串档
  writeDoc(h.saves, 'm2x-d', mkDoc({ id: 'm2x-d', owner: other.id, savedAt: base - 2000 }));
  h.api.games.set('m2x-e', {
    game: { id: 'm2x-e', day: 1, phase: 'day', finished: false, started: true, events: [] },
    running: true, mock: true, ownerProfileId: other.id, createdAt: base, lastAccess: base,
  });

  const all = await h.request('GET', `/api/profiles/${p.id}/games`);
  assert.strictEqual(all.status, 200, all.text);
  // 去重 + 内存独有行 + 时间倒序（a: base，c: base-500，b: base-1000）
  assert.deepStrictEqual(h.ids(all.body), ['m2x-a', 'm2x-c', 'm2x-b'], `同一 gameId 只出现一次、内存独有的局不能丢：${all.text}`);
  assert.strictEqual(all.body.total, 3);
  const byId = Object.fromEntries(all.body.rows.map((r) => [r.id, r]));
  assert.strictEqual(all.body.rows.filter((r) => r.id === 'm2x-a').length, 1, '磁盘行与内存行都有时仍只能一行');

  assert.strictEqual(byId['m2x-a'].finished, true, '状态以内存为准：磁盘未结束、内存已结束 ⇒ 已结束');
  assert.strictEqual(byId['m2x-a'].winner, 'wolf', 'winner 同样以内存为准');
  assert.strictEqual(byId['m2x-a'].day, 5);
  assert.strictEqual(byId['m2x-a'].phase, 'ended');
  assert.strictEqual(byId['m2x-a'].inMemory, true);

  assert.strictEqual(byId['m2x-b'].finished, false, '状态以内存为准：磁盘已结束、内存未结束 ⇒ 未结束');
  assert.strictEqual(byId['m2x-b'].resumable, true, '未结束 + 磁盘有锚点 ⇒ 可恢复');
  assert.strictEqual(byId['m2x-b'].started, true);

  assert.strictEqual(byId['m2x-c'].inMemory, true, '只有内存的对局也必须列出');
  assert.strictEqual(byId['m2x-c'].finished, false);
  assert.strictEqual(byId['m2x-c'].ownerProfileId, p.id);
  assert.strictEqual(byId['m2x-c'].ownerNickname, 'M2B-合并');

  // 筛选与合并不是两套逻辑：合并后的状态决定筛选结果
  const unf = await h.request('GET', `/api/profiles/${p.id}/games?status=unfinished`);
  assert.deepStrictEqual(h.ids(unf.body), ['m2x-c', 'm2x-b'], unf.text);
  const fin = await h.request('GET', `/api/profiles/${p.id}/games?status=finished`);
  assert.deepStrictEqual(h.ids(fin.body), ['m2x-a'], fin.text);

  // 别人档案的视角：只看到自己的两局
  const otherView = await h.request('GET', `/api/profiles/${other.id}/games`);
  assert.deepStrictEqual(h.ids(otherView.body), ['m2x-e', 'm2x-d'], otherView.text);
});

test('M2-b 列表⑤：混合时间格式按"解析后的时间值"排序（不是混合字符串比较）', async (t) => {
  const h = await harness(t, 'm2b-time');
  const p = await h.mkProfile('M2B-时间');
  // 三种**真实存在**的形态：number（saveGame 的 Date.now()）、ISO 串、RFC 2822（Date#toString()）
  writeDoc(h.saves, 'm2t-iso', mkDoc({ id: 'm2t-iso', owner: p.id, savedAt: '2026-09-22T10:00:00.000Z' }));
  writeDoc(h.saves, 'm2t-rfc', mkDoc({ id: 'm2t-rfc', owner: p.id, savedAt: 'Mon, 22 Sep 2025 10:00:00 GMT' }));
  writeDoc(h.saves, 'm2t-num', mkDoc({ id: 'm2t-num', owner: p.id, savedAt: Date.parse('2026-01-01T00:00:00.000Z') }));
  // 解析不了的坏值：兜底到该文件的 mtime；用 utimes 把 mtime 钉死，判据才可复核
  writeDoc(h.saves, 'm2t-bad', mkDoc({ id: 'm2t-bad', owner: p.id, savedAt: 'not-a-date' }));
  const badMtime = new Date('2026-05-05T00:00:00.000Z');
  fs.utimesSync(path.join(h.saves, 'm2t-bad.json'), badMtime, badMtime);

  const r = await h.request('GET', `/api/profiles/${p.id}/games`);
  assert.strictEqual(r.status, 200, r.text);
  // 时间值倒序：iso(2026-09-22) > bad(mtime 2026-05-05) > num(2026-01-01) > rfc(2025-09-22)
  assert.deepStrictEqual(h.ids(r.body), ['m2t-iso', 'm2t-bad', 'm2t-num', 'm2t-rfc'],
    `排序必须按解析后的时间值：${r.text}`);
  const byId = Object.fromEntries(r.body.rows.map((x) => [x.id, x]));
  // savedAt 仍原样透传（前端 new Date(x) 两种形态都能吃）；排序不依赖它的字符串形态
  assert.strictEqual(byId['m2t-num'].savedAt, Date.parse('2026-01-01T00:00:00.000Z'));
  assert.strictEqual(byId['m2t-bad'].savedAt, 'not-a-date');
  // 确定性：同一份数据连打三次，顺序必须完全一致（"坏值有确定兜底，不是静默乱序"）
  const second = await h.request('GET', `/api/profiles/${p.id}/games`);
  const third = await h.request('GET', `/api/profiles/${p.id}/games`);
  assert.deepStrictEqual(h.ids(second.body), h.ids(r.body));
  assert.deepStrictEqual(h.ids(third.body), h.ids(r.body));
});

test('M2-b 列表⑥：损坏存档返回明确错误，不伪装成空列表/少一行', async (t) => {
  const h = await harness(t, 'm2b-corrupt');
  const p = await h.mkProfile('M2B-损坏');
  writeDoc(h.saves, 'm2c-ok', mkDoc({ id: 'm2c-ok', owner: p.id, savedAt: 1 }));

  // 前置：干净数据下有 1 行 —— 后面的 500 才证明"是坏文件造成的"，不是本来就空
  const clean = await h.request('GET', `/api/profiles/${p.id}/games`);
  assert.strictEqual(clean.status, 200, clean.text);
  assert.deepStrictEqual(h.ids(clean.body), ['m2c-ok']);

  // 坏 JSON：旧实现 _readJson(file,null) 会跳过它 → 静默少一行/整页空
  fs.writeFileSync(path.join(h.saves, 'm2c-broken.json'), '{ "game": { "id": "m2c-broken", ');
  const bad = await h.request('GET', `/api/profiles/${p.id}/games`);
  assert.strictEqual(bad.status, 500, `坏档必须明确报错（不能 200 + 少一行）：${bad.text}`);
  assert.match(bad.body.error, /损坏数据/, bad.text);
  assert.match(bad.body.error, /m2c-broken\.json/, `错误必须点名是哪一份文件：${bad.text}`);
  assert.match(bad.body.error, /不是合法 JSON/, `错误必须给出可读原因：${bad.text}`);

  // 顶层不是对象（能 JSON.parse 但结构不对）同样算损坏，不许跳过
  fs.writeFileSync(path.join(h.saves, 'm2c-array.json'), '[1,2,3]');
  const bad2 = await h.request('GET', `/api/profiles/${p.id}/games`);
  assert.strictEqual(bad2.status, 500, bad2.text);
  assert.match(bad2.body.error, /m2c-array\.json/, bad2.text);
  assert.match(bad2.body.error, /结构损坏/, bad2.text);
  fs.rmSync(path.join(h.saves, 'm2c-array.json'));

  // 历史是按 gameId 精确读一份：别的档坏了不连累它（刻意的边界，不是遗漏）
  const hist = await h.request('GET', `/api/profiles/${p.id}/games/m2c-ok/history`);
  assert.strictEqual(hist.status, 200, `history 只读目标档，不该被别的坏档连累：${hist.text}`);
  assert.strictEqual(hist.body.rows.length, 1);

  // 目标档自己坏了 ⇒ 500 + 点名（不是 404「对局不存在」，也不是空历史）
  const histBad = await h.request('GET', `/api/profiles/${p.id}/games/m2c-broken/history`);
  assert.strictEqual(histBad.status, 500, histBad.text);
  assert.match(histBad.body.error, /存档损坏/, histBad.text);
  assert.match(histBad.body.error, /m2c-broken\.json/, histBad.text);

  // 还原坏档 → 列表立刻恢复（再次证明上面的 500 是坏档造成的）
  fs.rmSync(path.join(h.saves, 'm2c-broken.json'));
  const restored = await h.request('GET', `/api/profiles/${p.id}/games`);
  assert.strictEqual(restored.status, 200, restored.text);
  assert.deepStrictEqual(h.ids(restored.body), ['m2c-ok']);
});

test('M2-b 授权：未配对会话对「存在 / 不存在」资源逐字同响应（列表/历史/touch）', async (t) => {
  const h = await harness(t, 'm2b-auth');
  const p = await h.mkProfile('M2B-授权');
  writeDoc(h.saves, 'm2a-g1', mkDoc({ id: 'm2a-g1', owner: p.id, savedAt: 1 }));

  const probes = [
    ['GET', `/api/profiles/${p.id}/games`, `/api/profiles/${GHOST_PROFILE}/games`],
    ['GET', `/api/profiles/${p.id}/games/m2a-g1/history`, `/api/profiles/${GHOST_PROFILE}/games/m2a-g1/history`],
    ['POST', `/api/profiles/${p.id}/touch`, `/api/profiles/${GHOST_PROFILE}/touch`],
  ];
  for (const [method, real, fake] of probes) {
    const a = await h.request(method, real, { headers: UNPAIRED });
    const b = await h.request(method, fake, { headers: UNPAIRED });
    assert.strictEqual(a.status, 401, `${method} ${real} 未配对必须 401：${a.text}`);
    assert.strictEqual(b.status, 401, `${method} ${fake} 未配对必须 401：${b.text}`);
    assert.strictEqual(a.text, b.text,
      `${method}：授权必须**先于**存在性判定，否则状态码/报文差异就是"这个 id 是不是真档案"的探针\n真：${a.text}\n假：${b.text}`);
  }

  // 反向控制：管理会话语义不变（存在 200 / 不存在 404）—— 证明上面的 401 是授权门给的，不是路由坏了
  const okList = await h.request('GET', `/api/profiles/${p.id}/games`);
  assert.strictEqual(okList.status, 200, okList.text);
  const missList = await h.request('GET', `/api/profiles/${GHOST_PROFILE}/games`);
  assert.strictEqual(missList.status, 404, `管理会话下不存在的档案仍是 404：${missList.text}`);
});

test('M2-b 历史①：只允许已结束对局；档案与对局归属校验', async (t) => {
  const h = await harness(t, 'm2b-hist-gate');
  const p = await h.mkProfile('M2B-历史甲');
  const other = await h.mkProfile('M2B-历史乙');
  writeDoc(h.saves, 'm2g-fin', mkDoc({ id: 'm2g-fin', owner: p.id, savedAt: 3 }));
  writeDoc(h.saves, 'm2g-unf', mkDoc({ id: 'm2g-unf', owner: p.id, finished: false, anchor: { events: [] }, savedAt: 2 }));
  writeDoc(h.saves, 'm2g-other', mkDoc({ id: 'm2g-other', owner: other.id, savedAt: 1 }));

  const fin = await h.request('GET', `/api/profiles/${p.id}/games/m2g-fin/history`);
  assert.strictEqual(fin.status, 200, fin.text);
  assert.strictEqual(fin.body.finished, true);
  assert.strictEqual(fin.body.gameId, 'm2g-fin');

  // 未结束：明确 409（不是 200 + 空历史，也不是 404）
  const unf = await h.request('GET', `/api/profiles/${p.id}/games/m2g-unf/history`);
  assert.strictEqual(unf.status, 409, `未结束局必须明确拒绝：${unf.text}`);
  assert.match(unf.body.error, /尚未结束/, unf.text);

  // 状态以内存为准：磁盘写的是已结束，但内存里这局还在跑 ⇒ 仍拒绝
  h.api.games.set('m2g-fin', {
    game: { id: 'm2g-fin', day: 1, phase: 'day', finished: false, started: true, events: [] },
    running: true, mock: true, ownerProfileId: p.id, createdAt: 1, lastAccess: 1,
  });
  const memUnf = await h.request('GET', `/api/profiles/${p.id}/games/m2g-fin/history`);
  assert.strictEqual(memUnf.status, 409, `状态以内存为准（磁盘已结束也不能放开）：${memUnf.text}`);
  h.api.games.delete('m2g-fin');

  // 归属校验：别人的局在"我的档案"下读不到
  const foreign = await h.request('GET', `/api/profiles/${p.id}/games/m2g-other/history`);
  assert.strictEqual(foreign.status, 404, `别人的对局不得读：${foreign.text}`);
  // 反向：我的局在"别人的档案"下同样读不到
  const foreign2 = await h.request('GET', `/api/profiles/${other.id}/games/m2g-fin/history`);
  assert.strictEqual(foreign2.status, 404, foreign2.text);
  // 不存在的对局 / 不存在的档案
  assert.strictEqual((await h.request('GET', `/api/profiles/${p.id}/games/m2g-nope/history`)).status, 404);
  assert.strictEqual((await h.request('GET', `/api/profiles/${GHOST_PROFILE}/games/m2g-fin/history`)).status, 404);

  // 判据结构：**主判据是"必须被 4xx 拒绝且不回任何数据"这个不变量**（对整个畸形 id 族都成立，
  // 不随实现细节漂移）；下面按"4xx 是哪一种"分两组，各自注明机制，而不是把某一条钉死在某个码上。
  //   · 活到 gameId 白名单的（单个路径段，含 '%'、'\'、以 '.'/'-' 开头等）⇒ 400「gameId 非法」；
  //   · 被路由层规范化掉、压根没匹配到 history 路由的（'..'）⇒ 404「not found」。
  // 两组都安全：没碰盘、没泄漏；区别只在"谁先拒绝"。
  const badIds = ['..%5C..%5Cprofiles', '-lead', '.hidden', 'a%3Ab', 'a%2Fb', '%2e%2e'];
  for (const bad of badIds) {
    const r = await h.request('GET', `/api/profiles/${other.id}/games/${bad}/history`);
    assert.ok(r.status >= 400 && r.status < 500, `gameId=${bad} 必须是 4xx（实际 ${r.status}）：${r.text}`);
    assert.ok(r.body && typeof r.body.error === 'string', `gameId=${bad} 必须回可读错误：${r.text}`);
    assert.strictEqual(r.body.gameId, undefined, `gameId=${bad} 不得回对局数据`);
    assert.strictEqual(r.body.events, undefined, `gameId=${bad} 不得回事件流`);
    assert.strictEqual(r.body.players, undefined, `gameId=${bad} 不得回玩家列表`);
  }
  // 上面那一族的边界（实测读数，不是推断）：
  //   · '..%5C..%5Cprofiles'（解码后含 '\'）、'-lead'、'.hidden'、'a%3Ab'、'a%2Fb' ⇒ 400
  //     —— 注意 'a%2Fb'：百分号本身就不在白名单 [A-Za-z0-9._-] 里，所以它**根本不需要**解码
  //        就已被拒；穿越面是在白名单那里关死的，不依赖路由怎么处理编码。
  //   · '%2e%2e' ⇒ 404 —— '..' 被规范化掉，路由没匹配上，轮不到白名单说话。
  //（原先这里把 '%2e%2e' 期望成 400、把 'a%2Fb' 期望成 404，两条都与实测相反：规范化发生在
  //  路由匹配之前；百分号编码的 '/' 也不会被还原成路径分隔符。）
  for (const bad of ['..%5C..%5Cprofiles', '-lead', '.hidden', 'a%3Ab', 'a%2Fb']) {
    const r = await h.request('GET', `/api/profiles/${other.id}/games/${bad}/history`);
    assert.strictEqual(r.status, 400, `gameId=${bad} 必须 400：${r.text}`);
    assert.match(r.body.error, /gameId 非法/, r.text);
  }
  const dotdot = await h.request('GET', `/api/profiles/${other.id}/games/%2e%2e/history`);
  assert.strictEqual(dotdot.status, 404, `'..' 被规范化 ⇒ 路由不匹配 ⇒ 404：${dotdot.text}`);
  assert.match(dotdot.body.error, /not found/, dotdot.text);

  // 归档档案：与 stats/games 同一语义（404）
  const archived = await h.request('PATCH', `/api/profiles/${p.id}`, { body: { archive: true } });
  assert.strictEqual(archived.status, 200, archived.text);
  assert.strictEqual((await h.request('GET', `/api/profiles/${p.id}/games/m2g-fin/history`)).status, 404);
  assert.strictEqual((await h.request('GET', `/api/profiles/${p.id}/games`)).status, 404);
});

test('M2-b 历史②：事件游标分页默认 100 / 上限 200；只回公开事件与白名单字段', async (t) => {
  const h = await harness(t, 'm2b-hist-page');
  const p = await h.mkProfile('M2B-历史分页');
  const pub = [];
  for (let i = 1; i <= 250; i++) {
    pub.push({
      seq: i, day: 1 + Math.floor(i / 50), phase: 'day', type: 'speech', actor: ((i - 1) % 5) + 1,
      text: `M2B-PUB-${i}`, visibleTo: 'all', ts: 1000 + i, data: { secret: 'M2B-EVENT-DATA' },
    });
  }
  const priv = [251, 252, 253].map((seq) => ({
    seq, day: 6, phase: 'night', type: 'deal', actor: 2, text: `M2B-HIDDEN-${seq}`, visibleTo: [2], ts: 2000 + seq,
  }));
  const god = [{ seq: 254, day: 6, phase: 'night', type: 'ai_reasoning', actor: 3, text: 'M2B-GOD-ONLY', visibleTo: 'god', ts: 3000 }];
  writeDoc(h.saves, 'm2h-page', mkDoc({ id: 'm2h-page', owner: p.id, savedAt: 5, events: pub.concat(priv, god) }));
  // 数组物理顺序被打乱：必须显式按 seq 排序，不能依赖存档里的顺序
  writeDoc(h.saves, 'm2h-sort', mkDoc({
    id: 'm2h-sort', owner: p.id, savedAt: 4, events: [
      { seq: 3, day: 1, phase: 'day', type: 'phase', actor: null, text: 'C', visibleTo: 'all', ts: 3 },
      { seq: 1, day: 1, phase: 'day', type: 'phase', actor: null, text: 'A', visibleTo: 'all', ts: 1 },
      { seq: 2, day: 1, phase: 'day', type: 'phase', actor: null, text: 'B', visibleTo: 'all', ts: 2 },
    ],
  }));
  const sorted = await h.request('GET', `/api/profiles/${p.id}/games/m2h-sort/history`);
  assert.deepStrictEqual(sorted.body.rows.map((r) => r.seq), [1, 2, 3], `事件必须按 seq 升序：${sorted.text}`);

  const p1 = await h.request('GET', `/api/profiles/${p.id}/games/m2h-page/history`);
  assert.strictEqual(p1.status, 200, p1.text);
  assert.strictEqual(p1.body.rows.length, 100, `默认 100 条一批：${p1.text}`);
  assert.strictEqual(p1.body.limit, 100);
  assert.strictEqual(p1.body.total, 250, 'total = 游标之后剩余的公开事件数');
  assert.strictEqual(p1.body.hasMore, true);
  assert.strictEqual(p1.body.nextAfter, 100);
  assert.strictEqual(p1.body.after, 0);
  assert.strictEqual(p1.body.rows[0].seq, 1);
  // 事件字段白名单：data 不在其中（AI 内部上下文/内部结构没有出口）
  assert.deepStrictEqual(Object.keys(p1.body.rows[0]).sort(), ['actor', 'day', 'phase', 'seq', 'text', 'ts', 'type'],
    `事件字段必须是白名单：${p1.text}`);
  // 私密事件（visibleTo:[2]）与上帝事件、以及事件的 data，一次都不许出现
  assert.ok(!p1.text.includes('M2B-HIDDEN'), `私密事件泄漏：${p1.text.slice(0, 300)}`);
  assert.ok(!p1.text.includes('M2B-GOD-ONLY'), `上帝事件泄漏：${p1.text.slice(0, 300)}`);
  assert.ok(!p1.text.includes('M2B-EVENT-DATA'), `事件 data 不该下发：${p1.text.slice(0, 300)}`);

  const p2 = await h.request('GET', `/api/profiles/${p.id}/games/m2h-page/history?after=100&limit=100`);
  assert.strictEqual(p2.body.rows.length, 100);
  assert.strictEqual(p2.body.rows[0].seq, 101);
  assert.strictEqual(p2.body.rows[99].seq, 200);
  assert.strictEqual(p2.body.nextAfter, 200);
  assert.strictEqual(p2.body.hasMore, true);

  const p3 = await h.request('GET', `/api/profiles/${p.id}/games/m2h-page/history?after=${p2.body.nextAfter}`);
  assert.strictEqual(p3.body.rows.length, 50);
  assert.deepStrictEqual([p3.body.rows[0].seq, p3.body.rows[49].seq], [201, 250]);
  assert.strictEqual(p3.body.nextAfter, 250);
  assert.strictEqual(p3.body.hasMore, false);

  // 游标到底：空页 + hasMore=false（不是从头再来）
  const p4 = await h.request('GET', `/api/profiles/${p.id}/games/m2h-page/history?after=250`);
  assert.deepStrictEqual(p4.body.rows, []);
  assert.strictEqual(p4.body.total, 0);
  assert.strictEqual(p4.body.hasMore, false);
  assert.strictEqual(p4.body.nextAfter, 250);

  // 上限 200：要 999 条也只给 200，并回显生效值
  const cap = await h.request('GET', `/api/profiles/${p.id}/games/m2h-page/history?limit=999`);
  assert.strictEqual(cap.body.rows.length, 200, `上限 200（截断）：${cap.text}`);
  assert.strictEqual(cap.body.limit, 200);
  assert.strictEqual(cap.body.hasMore, true);
  assert.strictEqual(cap.body.nextAfter, 200);

  // limit=0：空页，但"还有更多"是事实
  const zero = await h.request('GET', `/api/profiles/${p.id}/games/m2h-page/history?limit=0`);
  assert.deepStrictEqual(zero.body.rows, []);
  assert.strictEqual(zero.body.hasMore, true);
  assert.strictEqual(zero.body.total, 250);

  // 空串游标 = 未提供（与不传等价）
  const emptyAfter = await h.request('GET', `/api/profiles/${p.id}/games/m2h-page/history?after=`);
  assert.strictEqual(emptyAfter.body.after, 0);
  assert.strictEqual(emptyAfter.body.rows.length, 100);

  // 非法分页参数 → 400 + 可读原因
  for (const q of ['after=abc', 'after=-1', 'after=1.5', `after=${'9'.repeat(30)}`, 'limit=abc', 'limit=-2']) {
    const r = await h.request('GET', `/api/profiles/${p.id}/games/m2h-page/history?${q}`);
    assert.strictEqual(r.status, 400, `${q} 必须 400：${r.text}`);
    assert.match(r.body.error, /必须是非负整数|超出可表示范围/, r.text);
  }

  // 三次翻页拼起来必须恰好是那 250 条公开事件：不重、不漏、不理私密
  const walked = p1.body.rows.concat(p2.body.rows, p3.body.rows).map((r) => r.seq);
  assert.strictEqual(walked.length, 250, '三页合计必须等于公开事件总数');
  assert.strictEqual(new Set(walked).size, 250, '分页不得重复事件');
  assert.strictEqual(Math.min(...walked), 1);
  assert.strictEqual(Math.max(...walked), 250);
});

test('M2-b 历史③：真实 mock 局——不重建引擎、不驱动引擎、不发任何模型请求', async (t) => {
  const h = await harness(t, 'm2b-no-engine');
  const p = await h.mkProfile('M2B-引擎');
  const created = await h.request('POST', '/api/games', {
    body: {
      board: { wolf: 1, seer: 1, witch: 1, villager: 2 },
      players: [{ isHuman: true }, { isHuman: false }, { isHuman: false }, { isHuman: false }, { isHuman: false }],
      mock: true, profileId: p.id,
    },
  });
  assert.strictEqual(created.status, 200, `前置：建局必须成功：${created.text}`);
  const gid = created.body.gameId;
  const entry = h.api.games.get(gid);
  assert.ok(entry, '前置：对局必须在内存表里');
  // 用**真实引擎**产生事件：一条公开、一条座位私有
  entry.game.emit('phase', { data: { title: 'M2B-real' }, text: 'M2B-REAL-PUBLIC' });
  entry.game.emit('deal', { actor: 1, visibleTo: [1], data: { role: 'M2B-SECRET-ROLE' }, text: 'M2B-REAL-HIDDEN' });
  entry.game.finished = true;
  entry.game.phase = 'ended';
  entry.game.winner = 'good';
  await h.api.saveGame(entry, { force: true });

  const sizeBefore = h.api.games.size;
  const orig = { fromJSON: Game.fromJSON, rebuild: h.api._rebuildFromAnchor, drive: h.api._drive, fetch: globalThis.fetch };
  const calls = { fromJSON: 0, rebuild: 0, drive: 0, fetch: 0 };
  Game.fromJSON = () => { calls.fromJSON++; throw new Error('ENGINE-REBUILT'); };
  h.api._rebuildFromAnchor = () => { calls.rebuild++; throw new Error('ENGINE-REBUILT'); };
  h.api._drive = () => { calls.drive++; throw new Error('ENGINE-DRIVEN'); };
  globalThis.fetch = () => { calls.fetch++; throw new Error('MODEL-CALLED'); };
  let r;
  try {
    r = await h.request('GET', `/api/profiles/${p.id}/games/${gid}/history`);
  } finally {
    Game.fromJSON = orig.fromJSON;
    h.api._rebuildFromAnchor = orig.rebuild;
    h.api._drive = orig.drive;
    globalThis.fetch = orig.fetch;
  }

  assert.strictEqual(r.status, 200, `历史必须能读，且不得触发重建/驱动/外呼：${r.text}`);
  assert.deepStrictEqual(calls, { fromJSON: 0, rebuild: 0, drive: 0, fetch: 0 },
    'history 触发了引擎重建 / 引擎驱动 / 模型外呼（探针计数不为 0）');
  assert.ok(r.text.includes('M2B-REAL-PUBLIC'), `真实引擎产生的公开事件必须在历史里：${r.text}`);
  assert.ok(!r.text.includes('M2B-REAL-HIDDEN'), `座位私有事件不得下发：${r.text}`);
  assert.strictEqual(h.api.games.size, sizeBefore, 'history 不得把对局移出/塞回内存表');
});

test('M2-b touch：记录真实最近使用、不改 revision（旧 revision 编辑仍成功）', async (t) => {
  const h = await harness(t, 'm2b-touch');
  const p = await h.mkProfile('M2B-触摸');
  const before = await h.profileRow(p.id);
  assert.strictEqual(before.lastUsedAt, before.createdAt, '前置：新建档案 lastUsedAt = createdAt');

  await delay(10);
  const t1 = await h.request('POST', `/api/profiles/${p.id}/touch`);
  assert.strictEqual(t1.status, 200, t1.text);
  assert.strictEqual(t1.body.ok, true);
  assert.strictEqual(t1.body.profileId, p.id);
  assert.strictEqual(t1.body.revision, before.revision, 'touch 不得改 revision');
  assert.ok(t1.body.lastUsedAt > before.lastUsedAt, `touch 必须推进 lastUsedAt：${t1.text}`);

  await delay(10);
  const t2 = await h.request('POST', `/api/profiles/${p.id}/touch`);
  assert.strictEqual(t2.status, 200, t2.text);
  assert.ok(t2.body.lastUsedAt > t1.body.lastUsedAt, `第二次 touch 必须再推进：${t2.text}`);

  const after = await h.profileRow(p.id);
  assert.strictEqual(after.lastUsedAt, t2.body.lastUsedAt, 'touch 必须真的落盘（列表读回一致）');
  assert.strictEqual(after.updatedAt, before.updatedAt, 'touch 不是编辑：updatedAt 不许动');
  assert.strictEqual(after.revision, before.revision, 'touch 之后 revision 必须与 touch 之前完全一致');

  // 计划书原话的证明：touch（两次）之后，用**touch 之前**的 revision 编辑资料仍然成功
  const patch = await h.request('PATCH', `/api/profiles/${p.id}`, {
    body: { expectedRevision: before.revision, nickname: 'M2B-触摸改名' },
  });
  assert.strictEqual(patch.status, 200, `touch 不得制造资料编辑 revision 冲突：${patch.text}`);
  assert.strictEqual(patch.body.profile.nickname, 'M2B-触摸改名');
  assert.strictEqual(patch.body.profile.revision, before.revision + 1, '真正推进 revision 的是编辑，不是 touch');

  // 反向控制：同一个旧 revision 现在**必须** 409 —— 证明上面那条成功不是因为 PATCH 不校验 revision
  const stale = await h.request('PATCH', `/api/profiles/${p.id}`, {
    body: { expectedRevision: before.revision, nickname: 'M2B-过期写' },
  });
  assert.strictEqual(stale.status, 409, `反向控制：编辑过的 revision 必须使旧值 409：${stale.text}`);

  // 未配对 / 不可信 Origin / 非 POST / 归档档案：都不许产生副作用
  const unpaired = await h.request('POST', `/api/profiles/${p.id}/touch`, { headers: UNPAIRED });
  assert.strictEqual(unpaired.status, 401, unpaired.text);
  const badOrigin = await h.request('POST', `/api/profiles/${p.id}/touch`, { headers: { Origin: 'http://evil.example' } });
  assert.strictEqual(badOrigin.status, 401, `不可信 Origin 的写请求必须拒绝：${badOrigin.text}`);
  const getTouch = await h.request('GET', `/api/profiles/${p.id}/touch`);
  assert.strictEqual(getTouch.status, 404, `touch 只接受 POST（GET 不许记录）：${getTouch.text}`);
  const nowRow = await h.profileRow(p.id);
  assert.strictEqual(nowRow.lastUsedAt, after.lastUsedAt, '被拒绝的请求不得改动 lastUsedAt');

  // 不存在的档案：404（不是 200 静默成功）
  const missing = await h.request('POST', `/api/profiles/${GHOST_PROFILE}/touch`);
  assert.strictEqual(missing.status, 404, missing.text);

  // 归档档案：404「该档案已归档」（与 stats/games 同一语义；store.touch 对归档是 no-op，回 200 等于谎报）
  await h.request('PATCH', `/api/profiles/${p.id}`, { body: { archive: true } });
  const archived = await h.request('POST', `/api/profiles/${p.id}/touch`);
  assert.strictEqual(archived.status, 404, archived.text);
  assert.match(archived.body.error, /已归档/, archived.text);
});

test('M2-b 脱敏：列表与历史的真实响应串里不得出现令牌/密钥/隐藏身份/AI 上下文', async (t) => {
  const h = await harness(t, 'm2b-leak');
  const p = await h.mkProfile('M2B-脱敏');
  const events = [
    { seq: 1, day: 1, phase: 'day', type: 'phase', actor: null, text: 'M2B-PUBLIC-TEXT', visibleTo: 'all', ts: 1, data: { role: 'M2B-SECRET-ROLE' } },
    { seq: 2, day: 1, phase: 'night', type: 'deal', actor: 2, text: 'M2B-HIDDEN-TEXT', visibleTo: [2], ts: 2, data: { role: 'M2B-SECRET-ROLE' } },
    { seq: 3, day: 1, phase: 'night', type: 'ai_reasoning', actor: 3, text: 'M2B-SECRET-MEMORY', visibleTo: 'god', ts: 3 },
  ];
  writeDoc(h.saves, 'm2l-1', mkDoc({
    id: 'm2l-1', owner: p.id, savedAt: 9, events,
    players: [{ seat: 1, isHuman: true, role: 'M2B-SECRET-ROLE' }],
    anchor: { secret: 'M2B-SECRET-ANCHOR', agentStates: { 2: { memory: 'M2B-SECRET-MEMORY' } }, events: [] },
  }));

  const list = await h.request('GET', `/api/profiles/${p.id}/games`);
  const hist = await h.request('GET', `/api/profiles/${p.id}/games/m2l-1/history`);
  assert.strictEqual(list.status, 200, list.text);
  assert.strictEqual(hist.status, 200, hist.text);

  // 正向控制：公开内容必须在 —— 否则"没搜到秘密"可能只是因为响应是空的
  assert.ok(list.text.includes('m2l-1'), `列表必须有这一行：${list.text}`);
  assert.ok(hist.text.includes('M2B-PUBLIC-TEXT'), `历史必须有公开事件：${hist.text}`);

  for (const [label, text] of [['列表', list.text], ['历史', hist.text]]) {
    for (const secret of SECRETS) {
      assert.ok(!text.includes(secret), `${label}响应泄漏了哨兵 ${secret}：${text.slice(0, 400)}`);
    }
    for (const key of SECRET_KEYS) {
      assert.ok(!text.includes(key), `${label}响应泄漏了字段 ${key}：${text.slice(0, 400)}`);
    }
  }
});
