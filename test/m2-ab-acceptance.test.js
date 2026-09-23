/**
 * m2-ab-acceptance.test.js — M2 的**头号验收判据**：「A/B 两档案全流程正确」的端到端验收
 *
 * ## 判据出处（逐字）
 * `docs/next-stage-implementation-plan.md:35`（§2 批次表 M2 行）：
 *   > | M2 | 玩家中心、切档、战绩、数据管理 | **A/B 两档案全流程正确**；浏览器、EXE、APK 均能导出再导入 |
 * 本轮只钉前半句（服务端可验证的那一半）。后半句的三环境适配器属 M2-e / M2-f，见文末「诚实边界」。
 *
 * ## 覆盖的 A/B 场景 → 计划书条目
 *   ① 归属：A 的局不进 B 的列表/历史/统计            §5.1「以 UUID 判断身份，允许昵称重名」
 *   ② 列表契约：status 白名单 / 分页 / 合并去重 / 坏档 §6「接口规则」全六条
 *   ③ 统计：四桶互斥 + 不串档案 + 胜负分母为有效胜负局  §5.3 末条
 *   ④ 未结束局的 owner 不可归档/删除，B 不受影响       §5.2 末条 + §2「发现数据丢失立即修复」
 *   ⑤ 回收站/恢复不串档案                            §5.2「进行中对局的 owner…始终固定」+ M2-d
 *   ⑥ lastUsedAt 只由真实选用/开局更新，编辑不动它      FIX-09 / §5.1
 *   ⑦ 导出/导入契约（范围/脱敏/新档案+重映射/不覆盖）    §7 前四条 + NEW-08
 *   ⑧ 笔记与经验归属固定（切档/归档/导入都不转移）       §5.2「owner、笔记、经验和战绩始终固定」
 *
 * ## 为什么每一层都用**真实 HTTP**
 * 本文件全程 `http.createServer` + `api.handle` 起真服务，客户端用 `node:http` 发真实请求：
 * 断言的是**状态码 + 真实响应字节 + 磁盘上的文件归属**三样东西。刻意不用 `globalThis.fetch`
 * （见 `test/m2-games-list.test.js` 的同款理由），也刻意不断言「某个函数被调用过」。
 *
 * ## 隔离
 * 一律走 `test/helpers-tmpdir.js` 的独占 dataDir（`os.tmpdir()/ww-m2ab-*`），
 * **绝不碰仓库里的 `saves/`**：所有档案侧路径都由 `dirname(saveDir)` 推导到同一份独占根。
 *
 * ## 诚实边界（本文件**没有**覆盖什么，以及为什么）
 *   · 纯前端行为一律不覆盖、也不伪造：切档后的「加载状态」占位、异步请求的 `profileId`/代次绑定、
 *     未保存草稿的切档确认、统计页「暂无」文案（服务端只暴露 `wins/losses/draws` 数据，
 *     「暂无」是**前端文案**，前端未落到服务端可观测面）、导出三态（下载已发起/用户取消/失败）适配器。
 *   · 浏览器 / EXE / APK 三个产物里的「真实文件保存再导入」不覆盖：本文件只证明**服务端契约**
 *     （导出包内容、导入落地、重映射、不覆盖原档案），产物链路属 M2-f（且需用户显式批准才可打包）。
 *   · 「服务重启」不覆盖真进程重启：仍用同一 dataDir 上的第二个 Api 实例（与 `m2d-trash-disk.test.js`
 *     同款手法，故本文件不重复磁盘-only 那一面，只在 A/B 语境下钉一次去重）。
 *   · 「哪些断言在改动前就已经是绿的」：本文件全部断言在**未改任何产品代码**时首跑即绿 ——
 *     它们是**回归钉**（把既有正确行为钉死），不是新修复的证据；报告里逐条登记。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { makeDataDir, makeApiIn, savesOf, terminateAfter } = require('./helpers-tmpdir');
const { sha256Hex } = require('../src/profiles/avatar');
const png = require('./helpers-png');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** A/B 档案共用同一昵称：身份只认 UUID，重名必须被允许（§5.1） */
const SAME_NICKNAME = 'AB-同名玩家';

/** 导出/列表脱敏判据的哨兵：任一条出现在真实响应字节里都算泄漏 */
const SECRETS = [
  'AB-SECRET-PLAYER-TOKEN', 'AB-SECRET-GOD-TOKEN', 'AB-SECRET-JOURNAL',
  'AB-SECRET-ANCHOR', 'AB-SECRET-API-KEY', 'AB-SECRET-REVIEW',
];
/** 字段名哨兵（公开摘要 / 导出包都不该出现这些键） */
const SECRET_KEYS = ['"tokens"', '"anchor"', '"journal"', '"apiKey"', '"review"', '"agentStates"'];

const BOARD5 = { wolf: 1, seer: 1, witch: 1, villager: 2 };
const players5 = () => Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: i === 0 }));

// ---------------------------------------------------------------- 夹具

/**
 * 一份最小对局存档（字段形状照 `src/api.js#saveGame` 的产出，外加脱敏哨兵）。
 * 默认是「正式局 + 已结束 + 好人胜」，逐条用例只覆盖自己关心的字段。
 */
function docOf(id, owner, { game = {}, ...docOver } = {}) {
  return {
    schemaVersion: 2,
    tokens: { player: 'AB-SECRET-PLAYER-TOKEN', god: 'AB-SECRET-GOD-TOKEN' },
    mock: false,
    ownerProfileId: owner,
    ownerNicknameSnapshot: 'AB-快照昵称',
    ownerHumanSeat: 1,
    apiKey: 'AB-SECRET-API-KEY',
    journal: { decisions: 'AB-SECRET-JOURNAL' },
    anchor: { secret: 'AB-SECRET-ANCHOR' },
    review: { text: 'AB-SECRET-REVIEW' },
    savedAt: Date.now(),
    ...docOver,
    game: {
      id,
      day: 3,
      phase: 'ended',
      started: true,
      finished: true,
      winner: null,
      winReason: '',
      players: [{ seat: 1, name: '我', isHuman: true, role: 'seer' }],
      events: [{ seq: 1, day: 1, phase: 'day', type: 'phase', actor: null, text: 'AB-公开事件', visibleTo: 'all', ts: 1 }],
      board: BOARD5,
      rules: {},
      ...game,
    },
  };
}

function writeDoc(saves, id, doc) {
  fs.writeFileSync(path.join(saves, `${id}.json`), JSON.stringify(doc));
  return doc;
}

function readDoc(saves, id) {
  return JSON.parse(fs.readFileSync(path.join(saves, `${id}.json`), 'utf8'));
}

/** 磁盘上归某档案所有的存档数（NEW-08「导入数量来自真正落盘」的独立复算口径） */
function filesOwnedBy(saves, pid) {
  return fs.readdirSync(saves)
    .filter((f) => f.endsWith('.json') && f !== 'experiences.json')
    .filter((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(saves, f), 'utf8')).ownerProfileId === pid; }
      catch (_) { return false; }
    });
}

/**
 * 真实 HTTP 夹具：独占 dataDir + 真 Api + 真 http 服务（客户端也用 node:http）。
 * `agent:false` ⇒ 每个请求独占连接并在响应后关闭，`server.close()` 不会挂住。
 */
async function harness(t, tag) {
  const dataDir = makeDataDir(`m2ab-${tag}`);
  const { api } = makeApiIn(dataDir);
  await api._profileMigrationReady; // 迁移（会建「默认玩家」）先收尾，之后再写盘/建档案
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    api.handle(req, res, u.pathname, u.searchParams).catch((e) => {
      try {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      } catch (_) { /* 响应已发出 */ }
    });
  });
  terminateAfter(t, () => api, dataDir); // 等迁移收尾 + 删独占根（失败路径同样生效）
  t.after(() => new Promise((resolve) => {
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const request = (method, route, { body, headers, raw } = {}) => new Promise((resolve, reject) => {
    let payload = null;
    if (raw !== undefined && raw !== null) payload = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    else if (body !== undefined) payload = Buffer.from(JSON.stringify(body));
    const head = Object.assign({}, headers || {});
    if (payload && !head['Content-Type'] && !head['content-type']) head['Content-Type'] = 'application/json';
    if (payload) head['Content-Length'] = payload.length;
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers: head, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { /* 本文件断言的路由一律回 JSON */ }
        const h = {};
        for (const [k, v] of Object.entries(res.headers)) h[k.toLowerCase()] = v;
        resolve({ status: res.statusCode, headers: h, text, body: json });
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
  const profileList = async () => {
    const r = await request('GET', '/api/profiles');
    assert.strictEqual(r.status, 200, `前置：档案列表必须可读：${r.text}`);
    return r.body.profiles;
  };
  const profileRow = async (id) => {
    const rows = await profileList();
    const row = rows.find((p) => p.id === id);
    assert.ok(row, `前置：档案 ${id} 必须在列表里`);
    return row;
  };
  const ids = (res) => res.body.rows.map((r) => r.id);

  return { api, dataDir, saves: savesOf(dataDir), profilesRoot: api.profiles.root, request, mkProfile, profileList, profileRow, ids };
}

// ================================================================ ① 归属
test('M2-AB ①归属：A 的局不进 B 的列表/历史/统计；同昵称以 UUID 判身份', async (t) => {
  const h = await harness(t, 'own');
  const A = await h.mkProfile(SAME_NICKNAME);
  const B = await h.mkProfile(SAME_NICKNAME);

  // 前置：同昵称被允许，且两份档案身份（UUID）必须不同 —— 身份不靠昵称（§5.1）
  assert.notStrictEqual(A.id, B.id, '同昵称的两份档案必须是两个 UUID');
  assert.strictEqual(A.nickname, SAME_NICKNAME);
  assert.strictEqual(B.nickname, SAME_NICKNAME);

  // A 真实开一局（POST /api/games 是生产建局入口，会真的落盘），再走生产 saveGame 结算
  const created = await h.request('POST', '/api/games', {
    body: { board: BOARD5, players: players5(), mock: true, profileId: A.id },
  });
  assert.strictEqual(created.status, 200, `前置：A 开一局必须成功：${created.text}`);
  const gid = created.body.gameId;
  const entry = h.api.games.get(gid);
  assert.ok(entry, '前置：对局必须在内存表里');
  assert.strictEqual(entry.ownerProfileId, A.id, '前置：建局时归属已固化为 A');
  entry.game.started = true;
  entry.game.finished = true;
  entry.game.phase = 'ended';
  entry.game.winner = 'good';
  await h.api.saveGame(entry, { force: true }); // 生产存档路径落盘

  // 磁盘归属是判据的一半：文件里必须写着 A
  const disk = readDoc(h.saves, gid);
  assert.strictEqual(disk.ownerProfileId, A.id, '存档归属必须是 A');
  assert.strictEqual(disk.game.finished, true);

  // A 看得到自己这一局
  const listA = await h.request('GET', `/api/profiles/${A.id}/games`);
  assert.strictEqual(listA.status, 200, listA.text);
  assert.deepStrictEqual(h.ids(listA), [gid], `A 必须看到自己这一局：${listA.text}`);
  assert.strictEqual(listA.body.rows[0].ownerProfileId, A.id);
  assert.strictEqual(listA.body.rows[0].ownerNickname, SAME_NICKNAME, '行内昵称来自 owner 快照/档案');
  assert.strictEqual(listA.body.total, 1);

  // B 看不到 —— 这是「A/B 不串档案」最核心的一条
  const listB = await h.request('GET', `/api/profiles/${B.id}/games?limit=100`);
  assert.strictEqual(listB.status, 200, listB.text);
  assert.deepStrictEqual(h.ids(listB), [], `A 的局绝不能出现在 B 名下：${listB.text}`);
  assert.strictEqual(listB.body.total, 0);
  assert.strictEqual(listB.body.hasMore, false);

  // 已结束局历史同样按归属校验：A 读得到，B 读不到（404，不给「这局属于谁」的探针）
  const histA = await h.request('GET', `/api/profiles/${A.id}/games/${gid}/history`);
  assert.strictEqual(histA.status, 200, `A 必须能读自己已结束局的历史：${histA.text}`);
  const histB = await h.request('GET', `/api/profiles/${B.id}/games/${gid}/history`);
  assert.strictEqual(histB.status, 404, `B 不得读到 A 的对局历史：${histB.text}`);

  // 统计不串档案：B 的战绩必须干净
  const statsA = await h.request('GET', `/api/profiles/${A.id}/stats`);
  const statsB = await h.request('GET', `/api/profiles/${B.id}/stats`);
  assert.strictEqual(statsA.status, 200, statsA.text);
  assert.strictEqual(statsB.status, 200, statsB.text);
  assert.strictEqual(statsA.body.total, 1, 'A 的统计含自己那一局');
  assert.strictEqual(statsB.body.total, 0, `B 的统计不得含 A 的对局：${statsB.text}`);
  assert.strictEqual(statsB.body.wins + statsB.body.losses + statsB.body.draws, 0);
});

// ================================================================ ② 列表契约
test('M2-AB ②列表契约：status 白名单 / 分页 rows-total-hasMore / 内存+磁盘去重 / 坏档明确报错', async (t) => {
  const h = await harness(t, 'list');
  const A = await h.mkProfile(SAME_NICKNAME);
  const B = await h.mkProfile(SAME_NICKNAME);
  const BASE = Date.parse('2026-06-01T00:00:00.000Z');

  // A：35 局已结束（时间递减，id 递增 ⇒ 顺序确定）
  for (let i = 1; i <= 35; i++) {
    const id = `ab2-a-${String(i).padStart(2, '0')}`;
    writeDoc(h.saves, id, docOf(id, A.id, { savedAt: BASE - i * 1000, mock: true }));
  }
  // A：1 局未结束（只存在于磁盘）
  writeDoc(h.saves, 'ab2-a-unf', docOf('ab2-a-unf', A.id, {
    savedAt: BASE - 90000, game: { started: true, finished: false, phase: 'night', winner: null, winReason: '' }, anchor: { events: [] },
  }));
  // A：同一 gameId 内存与磁盘都有，且**状态相反** ⇒ 必须只出现一次、且以内存为准
  writeDoc(h.saves, 'ab2-dup', docOf('ab2-dup', A.id, {
    savedAt: BASE - 60000, game: { started: true, finished: false, phase: 'night', winner: null, winReason: '' }, anchor: { events: [] },
  }));
  h.api.games.set('ab2-dup', {
    game: { id: 'ab2-dup', day: 9, phase: 'ended', finished: true, winner: 'wolf', started: true, events: [] },
    running: false, mock: true, ownerProfileId: A.id, createdAt: BASE - 60000, lastAccess: BASE - 60000,
  });
  // B：2 局已结束（用于证明任何视角下都不串档）
  writeDoc(h.saves, 'ab2-b-01', docOf('ab2-b-01', B.id, { savedAt: BASE - 1, mock: true }));
  writeDoc(h.saves, 'ab2-b-02', docOf('ab2-b-02', B.id, { savedAt: BASE - 2, mock: true }));

  // --- 默认分页 = 每页 30；rows/total/hasMore 三者必须自洽 ---
  const page1 = await h.request('GET', `/api/profiles/${A.id}/games`);
  assert.strictEqual(page1.status, 200, page1.text);
  assert.strictEqual(page1.body.limit, 30, '默认每页必须是 30（§6 接口规则）');
  assert.strictEqual(page1.body.offset, 0);
  assert.strictEqual(page1.body.status, 'all');
  assert.strictEqual(page1.body.rows.length, 30);
  assert.strictEqual(page1.body.total, 37, `total = 35 已结束 + 1 未结束 + 1 内存重复局（只算一次）：${page1.text}`);
  assert.strictEqual(page1.body.hasMore, true);
  assert.strictEqual(h.ids(page1)[0], 'ab2-a-01', '时间倒序：最新的一局在第一页首位');

  // --- 跨页：两页拼起来不重、不漏 ---
  const page2 = await h.request('GET', `/api/profiles/${A.id}/games?offset=30`);
  assert.strictEqual(page2.body.rows.length, 7);
  assert.strictEqual(page2.body.total, 37);
  assert.strictEqual(page2.body.hasMore, false, '最后一页 hasMore 必须为 false');
  assert.strictEqual(page2.body.hasMore, page2.body.offset + page2.body.rows.length < page2.body.total);
  const walked = h.ids(page1).concat(h.ids(page2));
  assert.strictEqual(walked.length, 37);
  assert.strictEqual(new Set(walked).size, 37, '分页不得重复任何一局');
  const expectedOrder = [
    ...Array.from({ length: 35 }, (_, i) => `ab2-a-${String(i + 1).padStart(2, '0')}`),
    'ab2-dup', // 磁盘 savedAt = BASE-60s，排在 35 局之后
    'ab2-a-unf', // 磁盘 savedAt = BASE-90s，最后一局
  ];
  assert.deepStrictEqual(walked, expectedOrder, '两页拼起来必须恰好是「按时间倒序」的全量，不重不漏不乱序');
  const again = await h.request('GET', `/api/profiles/${A.id}/games?offset=30`);
  assert.deepStrictEqual(h.ids(again), h.ids(page2), '同一份数据重复请求顺序必须一致（坏值兜底也要确定）');

  // --- 上限 100：要 1000 条也只能给 100，且**回显生效值**（截断而不是 400） ---
  const cap = await h.request('GET', `/api/profiles/${A.id}/games?limit=1000`);
  assert.strictEqual(cap.status, 200, cap.text);
  assert.strictEqual(cap.body.limit, 100, '每页上限必须是 100');
  assert.strictEqual(cap.body.rows.length, 37);
  assert.strictEqual(cap.body.hasMore, false);

  // --- status 只支持 all/unfinished/finished；非白名单值一律 400 + 可读原因 ---
  const fin = await h.request('GET', `/api/profiles/${A.id}/games?status=finished`);
  const unf = await h.request('GET', `/api/profiles/${A.id}/games?status=unfinished`);
  assert.strictEqual(fin.body.status, 'finished');
  assert.strictEqual(unf.body.status, 'unfinished');
  assert.strictEqual(fin.body.total, 36, `合并去重后「已结束」= 35 + dup（内存为准说它已结束）：${fin.text}`);
  assert.strictEqual(unf.body.total, 1);
  assert.strictEqual(fin.body.total + unf.body.total, page1.body.total, '两个筛选桶必须恰好覆盖全量');
  for (const bad of ['bogus', 'FINISHED', '1', 'all,finished', 'unfinished ']) {
    const r = await h.request('GET', `/api/profiles/${A.id}/games?status=${encodeURIComponent(bad)}`);
    assert.strictEqual(r.status, 400, `status=${JSON.stringify(bad)} 必须 400（不静默当 all）：${r.text}`);
    assert.match(r.body.error, /status 只支持 all \/ unfinished \/ finished/, r.text);
  }
  // 非法分页参数同样是 400（不静默 clamp，否则调用方以为拿到了完整数据）
  for (const q of ['limit=abc', 'limit=-1', 'limit=1.5', 'offset=abc', 'offset=-5']) {
    const r = await h.request('GET', `/api/profiles/${A.id}/games?${q}`);
    assert.strictEqual(r.status, 400, `${q} 必须 400：${r.text}`);
  }

  // --- 合并去重：同一 gameId 只出现一次，且状态以内存为准 ---
  const rows = cap.body.rows;
  assert.strictEqual(rows.filter((r) => r.id === 'ab2-dup').length, 1, '同一 gameId 内存+磁盘只能有一行');
  const dup = rows.find((r) => r.id === 'ab2-dup');
  assert.strictEqual(dup.finished, true, '状态以内存为准：磁盘说未结束、内存说已结束 ⇒ 已结束');
  assert.strictEqual(dup.winner, 'wolf', 'winner 同样以内存为准');
  assert.strictEqual(dup.day, 9);
  assert.strictEqual(dup.inMemory, true);
  // 行字段集 = 公开摘要白名单（多一个字段都算漂移，§6「只返回公开摘要」）
  assert.deepStrictEqual(Object.keys(rows[0]).sort(),
    ['day', 'finished', 'id', 'inMemory', 'mock', 'ownerNickname', 'ownerProfileId', 'phase', 'resumable', 'savedAt', 'started', 'winner']);
  for (const secret of SECRETS) assert.ok(!cap.text.includes(secret), `列表响应泄漏了哨兵 ${secret}`);

  // --- B 的视角：任何分页/筛选下都只有 B 自己的两局 ---
  const listB = await h.request('GET', `/api/profiles/${B.id}/games?limit=100`);
  assert.deepStrictEqual(h.ids(listB), ['ab2-b-01', 'ab2-b-02'], listB.text);
  assert.strictEqual(listB.body.total, 2);
  const finB = await h.request('GET', `/api/profiles/${B.id}/games?status=finished`);
  assert.strictEqual(finB.body.total, 2);
  const unfB = await h.request('GET', `/api/profiles/${B.id}/games?status=unfinished`);
  assert.strictEqual(unfB.body.total, 0, 'A 的未结束局不得进 B 的未结束桶');

  // --- 损坏数据必须明确报错，绝不伪装成空列表；移除后立刻恢复 ---
  fs.writeFileSync(path.join(h.saves, 'ab2-broken.json'), '{ "game": { "id": "ab2-broken", ');
  const badA = await h.request('GET', `/api/profiles/${A.id}/games`);
  assert.strictEqual(badA.status, 500, `坏档必须明确报错（不能 200 + 少一行/空列表）：${badA.text}`);
  assert.match(badA.body.error, /损坏数据/, badA.text);
  assert.match(badA.body.error, /ab2-broken\.json/, `错误必须点名文件：${badA.text}`);
  assert.match(badA.body.error, /不是合法 JSON/, `错误必须给出可读原因：${badA.text}`);
  // 诚实说明：坏档是**保守拒绝（fail-closed）**，它拦的是整个存档目录的列表（不只可能属于谁的那份）
  const badB = await h.request('GET', `/api/profiles/${B.id}/games`);
  assert.strictEqual(badB.status, 500, '坏档在场时 B 的列表同样明确拒绝（fail-closed，不是静默空列表）');
  fs.rmSync(path.join(h.saves, 'ab2-broken.json'));
  const recoveredA = await h.request('GET', `/api/profiles/${A.id}/games?limit=1000`);
  assert.strictEqual(recoveredA.status, 200, recoveredA.text);
  assert.strictEqual(recoveredA.body.total, 37, '坏档移除后必须立刻恢复 —— 证明上面的 500 是坏档造成的');
  assert.strictEqual((await h.request('GET', `/api/profiles/${B.id}/games`)).body.total, 2);
});

// ================================================================ ③ 统计
test('M2-AB ③统计：正式/试玩/观战/终止四桶互斥且不串档案；胜率分母为有效胜负局', async (t) => {
  const h = await harness(t, 'stats');
  const A = await h.mkProfile(SAME_NICKNAME);
  const B = await h.mkProfile(SAME_NICKNAME);

  // A：3 正式（1 胜 / 1 负 / 1 平或不可判定）+ 1 试玩 + 1 观战 + 1 终止
  writeDoc(h.saves, 'ab3-win', docOf('ab3-win', A.id, {
    game: { players: [{ seat: 1, name: '我', isHuman: true, role: 'villager' }], winner: 'good', winReason: '好人阵营获胜' },
  }));
  writeDoc(h.saves, 'ab3-loss', docOf('ab3-loss', A.id, {
    game: { players: [{ seat: 1, name: '我', isHuman: true, role: 'wolf' }], winner: 'good', winReason: '好人阵营获胜' },
  }));
  writeDoc(h.saves, 'ab3-draw', docOf('ab3-draw', A.id, {
    game: { players: [{ seat: 1, name: '我', isHuman: true, role: 'villager' }], winner: 'none', winReason: '平局' },
  }));
  writeDoc(h.saves, 'ab3-mock', docOf('ab3-mock', A.id, {
    mock: true, game: { players: [{ seat: 1, name: '我', isHuman: true, role: 'seer' }], winner: 'wolf' },
  }));
  writeDoc(h.saves, 'ab3-spec', docOf('ab3-spec', A.id, {
    game: { players: [{ seat: 1, name: 'X', isHuman: false, role: 'wolf' }, { seat: 2, name: 'Y', isHuman: false, role: 'villager' }], winner: 'wolf' },
  }));
  writeDoc(h.saves, 'ab3-term', docOf('ab3-term', A.id, {
    game: { players: [{ seat: 1, name: '我', isHuman: true, role: 'villager' }], winReason: '玩家手动终止对局', winner: null },
  }));
  // B：2 正式（1 胜 / 1 负）+ 1 试玩
  writeDoc(h.saves, 'ab3-b-win', docOf('ab3-b-win', B.id, {
    game: { players: [{ seat: 1, name: '我', isHuman: true, role: 'wolf' }], winner: 'wolf', winReason: '狼人获胜' },
  }));
  writeDoc(h.saves, 'ab3-b-loss', docOf('ab3-b-loss', B.id, {
    game: { players: [{ seat: 1, name: '我', isHuman: true, role: 'villager' }], winner: 'wolf', winReason: '狼人获胜' },
  }));
  writeDoc(h.saves, 'ab3-b-mock', docOf('ab3-b-mock', B.id, {
    mock: true, game: { players: [{ seat: 1, name: '我', isHuman: true, role: 'seer' }], winner: 'wolf' },
  }));

  const sa = await h.request('GET', `/api/profiles/${A.id}/stats`);
  const sb = await h.request('GET', `/api/profiles/${B.id}/stats`);
  assert.strictEqual(sa.status, 200, sa.text);
  assert.strictEqual(sb.status, 200, sb.text);

  assert.strictEqual(sa.body.profileId, A.id);
  assert.strictEqual(sa.body.total, 6);
  assert.deepStrictEqual(sa.body.byBucket, { real: 3, mock: 1, spectate: 1, terminated: 1 }, '四桶必须互斥且计数正确');
  assert.strictEqual(sa.body.wins, 1, '好人阵营 + 好人胜 = 胜');
  assert.strictEqual(sa.body.losses, 1, '狼阵营 + 好人胜 = 负');
  assert.strictEqual(sa.body.draws, 1, 'winner=none（不可判定）单列平，绝不算成胜');
  assert.strictEqual(sa.body.wins + sa.body.losses, 2, '胜率分母 = 有效胜负局（2），不是总场次（6）');
  assert.ok(sa.body.wins + sa.body.losses <= sa.body.real, '胜负只来自正式局');

  // 不串档案：B 的两个正式局不得进 A 的桶，A 的四个非正式局不得进 B 的桶
  assert.strictEqual(sb.body.profileId, B.id);
  assert.strictEqual(sb.body.total, 3);
  assert.deepStrictEqual(sb.body.byBucket, { real: 2, mock: 1, spectate: 0, terminated: 0 });
  assert.strictEqual(sb.body.wins, 1);
  assert.strictEqual(sb.body.losses, 1);
  assert.strictEqual(sb.body.draws, 0);
  assert.strictEqual(sa.body.byBucket.mock, 1, 'A 的试玩桶只含 A 自己的试玩局（B 也有一局试玩）');
  assert.strictEqual(sb.body.byBucket.mock, 1, 'B 的试玩桶只含 B 自己的试玩局（A 也有一局试玩）');

  // 分母为 0 的档案：「暂无」是**前端文案**，服务端只暴露数据 —— 这里只钉数据形状
  const all = await h.profileList();
  const fresh = all.find((p) => p.nickname === '默认玩家');
  assert.ok(fresh, '前置：首次启动会自动创建一份默认档案');
  const s0 = await h.request('GET', `/api/profiles/${fresh.id}/stats`);
  assert.strictEqual(s0.status, 200, s0.text);
  assert.strictEqual(s0.body.total, 0);
  assert.strictEqual(s0.body.real, 0);
  assert.strictEqual(s0.body.wins, 0);
  assert.strictEqual(s0.body.losses, 0);
  assert.strictEqual(s0.body.wins + s0.body.losses, 0, '分母为 0：页面语义「暂无」，服务端只保证分母这层数据为 0');
  assert.deepStrictEqual(s0.body.byBucket, { real: 0, mock: 0, spectate: 0, terminated: 0 },
    'A/B 的战绩不得漏进第三份档案');
});

// ================================================================ ④ 未结束局不可归档/删除
test('M2-AB ④未结束局的 owner 不可删除：A 被拒且原因明确，B 不受影响，结算后放行', async (t) => {
  const h = await harness(t, 'trashgate');
  const A = await h.mkProfile(SAME_NICKNAME);
  const B = await h.mkProfile(SAME_NICKNAME);
  writeDoc(h.saves, 'ab4-b-fin', docOf('ab4-b-fin', B.id, { savedAt: Date.now() }));

  // A 有一局进行中：生产建局 + 生产 saveGame ⇒ 内存与磁盘是**同一 gameId**（去重判据的现场）
  const created = await h.request('POST', '/api/games', {
    body: { board: BOARD5, players: players5(), mock: true, profileId: A.id },
  });
  assert.strictEqual(created.status, 200, created.text);
  const gid = created.body.gameId;
  const entry = h.api.games.get(gid);
  entry.game.started = true;
  entry.game.finished = false;
  entry.game.phase = 'night';
  await h.api.saveGame(entry, { force: true });
  const disk = readDoc(h.saves, gid);
  assert.strictEqual(disk.ownerProfileId, A.id, '前置：存档归属 A');
  assert.strictEqual(disk.game.started, true);
  assert.strictEqual(disk.game.finished, false, '前置：这局确实未结束');

  // R05 契约（docs/dual-platform-optimization-plan.md §3.1）：有未结束局的档案**连归档都不允许**。
  //   （旧契约此处允许归档、只在删除时拒 —— 那正是"前端禁止 / 后端放行 / 测试说必须成功"的三套定义。）
  const archA = await h.request('PATCH', `/api/profiles/${A.id}`, { body: { archive: true } });
  assert.strictEqual(archA.status, 400, `有未结束局必须拒绝归档（实际 ${archA.status}：${archA.text}）`);
  assert.match(archA.body.error, /未结束的对局/, '错误必须说明还有未结束的对局');
  assert.match(archA.body.error, /还有 1 局未结束/,
    `同一局内存+磁盘必须只算一次（实际文案：${archA.body.error}）`);
  assert.strictEqual(h.api.profiles.get(A.id).archivedAt, null, '被拒后档案不得带上归档标记');

  // 回收站那条规则（§5.2）依旧成立，而且是**两层**都在：
  //   ① 走 API 时先被"未结束不得归档"挡在门外（拿不到归档态，自然进不了回收站）；
  //   ② store 层的 trash() 对"已归档 + 有进行中局"独立拒绝（纵深防御，绕过 API 也拦得住）。
  const delA = await h.request('DELETE', `/api/profiles/${A.id}`);
  assert.strictEqual(delA.status, 409, `未归档就删除必须被拒（实际 ${delA.status}：${delA.text}）`);
  await h.api.profiles._updateInner(A.id, { archive: true }); // 直接写库：造出"已归档 + 有未结束局"的非法存量态
  const delArchivedA = await h.request('DELETE', `/api/profiles/${A.id}`);
  assert.strictEqual(delArchivedA.status, 400, `已归档但有进行中局必须拒绝删除（实际 ${delArchivedA.status}：${delArchivedA.text}）`);
  assert.match(delArchivedA.body.error, /进行中/, '错误必须说明「仍有对局进行中」');
  assert.match(delArchivedA.body.error, /仍有 1 局进行中/,
    `同一局内存+磁盘必须只算一次（实际文案：${delArchivedA.body.error}）`);

  // 被拒的副作用必须为零：档案在、回收区空、存档原位
  assert.ok(h.api.profiles.get(A.id), '被拒后档案必须原样保留');
  const trash = await h.request('GET', '/api/profiles/trash');
  assert.strictEqual(trash.status, 200, trash.text);
  assert.deepStrictEqual(trash.body.items, [], '被拒后回收区必须为空');
  assert.ok(fs.existsSync(path.join(h.saves, `${gid}.json`)), '被拒后存档必须原样在磁盘上');

  // B 不受影响：A 的失败不得连累 B 的列表/统计，也不得把 A 的局算到 B 头上
  const listB = await h.request('GET', `/api/profiles/${B.id}/games`);
  assert.strictEqual(listB.status, 200, listB.text);
  assert.deepStrictEqual(h.ids(listB), ['ab4-b-fin'], `A 被拦不得影响 B：${listB.text}`);
  assert.strictEqual((await h.request('GET', `/api/profiles/${B.id}/stats`)).body.total, 1);

  // 反向半边 ①：B 没有未结束局 ⇒ 归档+删除必须成功（证明上面的 400 不是「一律拒删」）
  const archB = await h.request('PATCH', `/api/profiles/${B.id}`, { body: { archive: true } });
  assert.strictEqual(archB.status, 200, archB.text);
  const delB = await h.request('DELETE', `/api/profiles/${B.id}`);
  assert.strictEqual(delB.status, 200, `B 没有进行中局，必须放行（实际 ${delB.status}：${delB.text}）`);
  assert.ok(delB.body.archiveId, '删除必须返回回收区 archiveId');

  // 反向半边 ②：A 那局结算后，A 的删除立刻放行（证明 400 是这局造成的，不是恒拒）
  entry.game.finished = true;
  entry.game.phase = 'ended';
  entry.game.winner = 'good';
  await h.api.saveGame(entry, { force: true });
  const delA2 = await h.request('DELETE', `/api/profiles/${A.id}`);
  assert.strictEqual(delA2.status, 200, `结算后必须放行（实际 ${delA2.status}：${delA2.text}）`);
  assert.ok(delA2.body.archiveId);
});

// ================================================================ ⑤ 回收站/恢复
test('M2-AB ⑤回收站与恢复不串档案：A 进回收区后其局不归 B，恢复后 A 的局回到 A', async (t) => {
  const h = await harness(t, 'trash');
  const A = await h.mkProfile(SAME_NICKNAME);
  const B = await h.mkProfile(SAME_NICKNAME);
  writeDoc(h.saves, 'ab5-a-fin', docOf('ab5-a-fin', A.id, { savedAt: Date.now() }));
  writeDoc(h.saves, 'ab5-b-fin', docOf('ab5-b-fin', B.id, { savedAt: Date.now() - 1000 }));

  const arch = await h.request('PATCH', `/api/profiles/${A.id}`, { body: { archive: true } });
  assert.strictEqual(arch.status, 200, arch.text);
  const del = await h.request('DELETE', `/api/profiles/${A.id}`);
  assert.strictEqual(del.status, 200, `A 无进行中局，删除应放行：${del.text}`);
  const archiveId = del.body.archiveId;
  assert.ok(archiveId);

  // A 已不在档案表里；其局仍在磁盘上、归属仍是 A（归属绝不改写）
  const rows = await h.profileList();
  assert.ok(!rows.some((p) => p.id === A.id), 'A 删除后不得再出现在档案列表里');
  assert.ok(rows.some((p) => p.id === B.id), 'B 必须原样在列表里');
  assert.strictEqual((await h.request('GET', `/api/profiles/${A.id}/games`)).status, 404, 'A 已删除 ⇒ 其路由 404');
  const aDoc = readDoc(h.saves, 'ab5-a-fin');
  assert.strictEqual(aDoc.ownerProfileId, A.id, '进回收区只搬档案目录，存档归属不得改写成别人');

  // 核心：A 的局不得出现在 B 名下 —— 列表、统计都不行
  const listB = await h.request('GET', `/api/profiles/${B.id}/games?limit=100`);
  assert.strictEqual(listB.status, 200, listB.text);
  assert.deepStrictEqual(h.ids(listB), ['ab5-b-fin'], `A 进回收区后其局不得归到 B 名下：${listB.text}`);
  const statsB = await h.request('GET', `/api/profiles/${B.id}/stats`);
  assert.strictEqual(statsB.body.total, 1, 'B 的统计不得吸收 A 的对局');

  // 回收区条目：可恢复、id 与昵称都对
  const trash = await h.request('GET', '/api/profiles/trash');
  assert.strictEqual(trash.status, 200, trash.text);
  assert.strictEqual(trash.body.items.length, 1);
  assert.strictEqual(trash.body.items[0].archiveId, archiveId);
  assert.strictEqual(trash.body.items[0].id, A.id);
  assert.strictEqual(trash.body.items[0].restorable, true);

  // 恢复：id 不变、局回来、B 仍然只看到自己的局
  const restored = await h.request('POST', `/api/profiles/trash/${archiveId}/restore`);
  assert.strictEqual(restored.status, 200, `恢复必须成功：${restored.text}`);
  assert.strictEqual(restored.body.profile.id, A.id, '恢复后 UUID 必须不变（身份 = UUID）');
  assert.strictEqual(restored.body.profile.archivedAt, null, '恢复即可用（归档标记一并取消）');
  const listA = await h.request('GET', `/api/profiles/${A.id}/games`);
  assert.strictEqual(listA.status, 200, listA.text);
  assert.deepStrictEqual(h.ids(listA), ['ab5-a-fin'], `恢复后 A 的局必须回到 A：${listA.text}`);
  assert.strictEqual((await h.request('GET', `/api/profiles/${A.id}/stats`)).body.total, 1);
  assert.deepStrictEqual(h.ids(await h.request('GET', `/api/profiles/${B.id}/games`)), ['ab5-b-fin'],
    '恢复 A 不得把 A 的局塞进 B 名下');
  const trash2 = await h.request('GET', '/api/profiles/trash');
  assert.deepStrictEqual(trash2.body.items, [], '已恢复的条目不该再挂在回收站里');
});

// ================================================================ ⑥ lastUsedAt
test('M2-AB ⑥lastUsedAt：只由真实选用/开局更新，编辑资料不动它，touch 不制造 revision 冲突', async (t) => {
  const h = await harness(t, 'lastused');
  const A = await h.mkProfile('AB-使用甲');
  const B = await h.mkProfile('AB-使用乙');
  const beforeA = await h.profileRow(A.id);
  const beforeB = await h.profileRow(B.id);
  assert.strictEqual(beforeA.lastUsedAt, beforeA.createdAt, '前置：新建档案 lastUsedAt = createdAt');
  assert.strictEqual(beforeA.revision, 1);

  // 编辑资料：updatedAt/revision 前进，lastUsedAt **一步都不许动**（FIX-09 / §5.1）
  await delay(10);
  const edited = await h.request('PATCH', `/api/profiles/${A.id}`, { body: { nickname: 'AB-使用甲改名' } });
  assert.strictEqual(edited.status, 200, edited.text);
  const afterEdit = await h.profileRow(A.id);
  assert.strictEqual(afterEdit.lastUsedAt, beforeA.lastUsedAt,
    `「编辑资料」绝不能冒充「使用过档案」（lastUsedAt 动了：${beforeA.lastUsedAt} → ${afterEdit.lastUsedAt}）`);
  assert.ok(afterEdit.updatedAt > beforeA.updatedAt, '编辑必须推进 updatedAt');
  assert.strictEqual(afterEdit.revision, beforeA.revision + 1, '编辑推进 revision');
  // 别人的档案一点都不能被带动
  assert.strictEqual((await h.profileRow(B.id)).lastUsedAt, beforeB.lastUsedAt, '编辑 A 不得改动 B 的 lastUsedAt');

  // 真实选用（touch）：lastUsedAt 前进，revision / updatedAt 不动
  await delay(10);
  const t1 = await h.request('POST', `/api/profiles/${A.id}/touch`);
  assert.strictEqual(t1.status, 200, t1.text);
  assert.strictEqual(t1.body.ok, true);
  assert.strictEqual(t1.body.profileId, A.id);
  assert.ok(t1.body.lastUsedAt > afterEdit.lastUsedAt, `touch 必须推进 lastUsedAt：${t1.text}`);
  assert.strictEqual(t1.body.revision, afterEdit.revision, 'touch 不是编辑：revision 不许动');
  const afterTouch = await h.profileRow(A.id);
  assert.strictEqual(afterTouch.lastUsedAt, t1.body.lastUsedAt, 'touch 必须真的落盘（列表读回一致）');
  assert.strictEqual(afterTouch.updatedAt, afterEdit.updatedAt, 'touch 不得推进 updatedAt');
  // 磁盘对账：档案文件里的 lastUsedAt 与接口读回一致
  const profFile = JSON.parse(fs.readFileSync(path.join(h.profilesRoot, A.id, 'profile.json'), 'utf8'));
  assert.strictEqual(profFile.lastUsedAt, afterTouch.lastUsedAt, 'lastUsedAt 必须落在 profile.json 里');
  assert.strictEqual((await h.profileRow(B.id)).lastUsedAt, beforeB.lastUsedAt, 'touch A 不得改动 B 的 lastUsedAt');

  // touch 不制造资料编辑 revision 冲突：用 touch 之前的 revision 编辑仍然成功（§6 第一行）
  const staleOk = await h.request('PATCH', `/api/profiles/${A.id}`, {
    body: { expectedRevision: afterEdit.revision, bio: 'AB-用旧 revision 编辑' },
  });
  assert.strictEqual(staleOk.status, 200, `touch 不得制造 revision 冲突：${staleOk.text}`);
  assert.strictEqual(staleOk.body.profile.revision, afterEdit.revision + 1);
  // 反向控制：这个 revision 现在已过期 ⇒ 必须 409（证明上一条成功不是因为 PATCH 不校验）
  const stale = await h.request('PATCH', `/api/profiles/${A.id}`, {
    body: { expectedRevision: afterEdit.revision, bio: 'AB-过期写' },
  });
  assert.strictEqual(stale.status, 409, `反向控制：过期 revision 必须 409：${stale.text}`);

  // 开局 = 使用：owner 档案的 lastUsedAt 前进；别人的档案一步不动
  await delay(10);
  const beforeGameA = (await h.profileRow(A.id)).lastUsedAt;
  const created = await h.request('POST', '/api/games', {
    body: { board: BOARD5, players: players5(), mock: true, profileId: A.id },
  });
  assert.strictEqual(created.status, 200, created.text);
  const afterGameA = await h.profileRow(A.id);
  assert.ok(afterGameA.lastUsedAt > beforeGameA, `开局必须推进 owner 档案的 lastUsedAt：${afterGameA.lastUsedAt} vs ${beforeGameA}`);
  assert.strictEqual((await h.profileRow(B.id)).lastUsedAt, beforeB.lastUsedAt, 'A 开局不得改动 B 的 lastUsedAt');
  const afterGameB = await h.profileRow(B.id);
  assert.strictEqual(beforeB.updatedAt, afterGameB.updatedAt, '记录使用不是编辑：B 的 updatedAt 也不许动');
});

// ================================================================ ⑦ 导出/导入
test('M2-AB ⑦导出/导入契约：范围=资料+头像+已结束局+笔记；新档案+gameId 重映射；原档案不覆盖', async (t) => {
  const h = await harness(t, 'transfer');
  const A = await h.mkProfile('AB-导出甲');
  const B = await h.mkProfile('AB-导出乙');
  const BASE = Date.parse('2026-07-01T00:00:00.000Z');

  // A 的自定义头像（§4.4：导出范围含自定义头像）
  const avatarBytes = png.makePng();
  const avatarSha = sha256Hex(avatarBytes);
  const putAvatar = await h.request('PUT', `/api/profiles/${A.id}/avatar`, {
    raw: avatarBytes, headers: { 'Content-Type': 'image/png' },
  });
  assert.strictEqual(putAvatar.status, 200, `前置：上传头像必须成功：${putAvatar.text}`);

  // A：1 局已结束（带笔记）+ 1 局进行中（带笔记）—— 进行中的都不该进包
  writeDoc(h.saves, 'ab7-fin', docOf('ab7-fin', A.id, {
    savedAt: BASE,
    game: {
      players: [{ seat: 1, name: '我', isHuman: true, role: 'seer' }],
      winner: 'good', winReason: '狼人全部出局',
      events: [{ seq: 1, day: 1, phase: 'day', type: 'phase', actor: null, text: 'AB7-PUBLIC-EVENT', visibleTo: 'all', ts: 1 }],
    },
  }));
  writeDoc(h.saves, 'ab7-unf', docOf('ab7-unf', A.id, {
    savedAt: BASE - 1000, anchor: { events: [] },
    game: { started: true, finished: false, phase: 'night', winner: null, winReason: '' },
  }));
  await h.api.annotations.put({ profileId: A.id, gameId: 'ab7-fin', expectedRevision: 0, seats: { 2: { leaning: 'lean_wolf', note: 'AB7-A-笔记' } } });
  await h.api.annotations.put({ profileId: A.id, gameId: 'ab7-unf', expectedRevision: 0, seats: { 3: { leaning: 'good', note: 'AB7-进行中笔记' } } });
  // B：1 局已结束 + 笔记 —— 用来证明 A 的导出不夹带别人的东西
  writeDoc(h.saves, 'ab7-b', docOf('ab7-b', B.id, { savedAt: BASE - 2000 }));
  await h.api.annotations.put({ profileId: B.id, gameId: 'ab7-b', expectedRevision: 0, seats: { 1: { leaning: 'wolf', note: 'AB7-B-笔记' } } });

  const aBefore = await h.profileRow(A.id);

  // --- 导出：真实响应字节 ---
  const exp = await h.request('GET', `/api/profiles/${A.id}/export`);
  assert.strictEqual(exp.status, 200, `导出必须成功：${exp.text.slice(0, 300)}`);
  assert.match(exp.headers['content-type'] || '', /application\/json/, '导出必须是 JSON');
  assert.match(exp.headers['content-disposition'] || '', /attachment/, '导出必须是可保存的附件');
  const pkg = exp.body;
  assert.ok(pkg && pkg.manifest && pkg.profile && Array.isArray(pkg.games) && pkg.notes, '导出包结构必须完整');

  // 范围 = 已结束局：进行中的局**不进包**（计划书 §7 第三条）
  assert.strictEqual(pkg.manifest.counts.games, 1, '只能导出已结束的局');
  assert.deepStrictEqual(pkg.games.map((g) => g.id), ['ab7-fin'], `进行中对局不得进包：${exp.text.slice(0, 400)}`);
  assert.ok(!exp.text.includes('ab7-unf'), '进行中对局的 id 不得出现在包里');
  assert.ok(!exp.text.includes('AB7-进行中笔记'), '进行中对局的笔记同样不进包');
  assert.strictEqual(pkg.manifest.counts.notes, 1);
  assert.deepStrictEqual(Object.keys(pkg.notes), ['ab7-fin']);
  assert.strictEqual(pkg.notes['ab7-fin'].seats['2'].note, 'AB7-A-笔记', '笔记必须随包');

  // 范围 = 档案资料 + 自定义头像
  assert.strictEqual(pkg.profile.nickname, A.nickname);
  assert.strictEqual(pkg.profile.id, undefined, '包内不得携带原档案 UUID（导入要建新档案）');
  assert.strictEqual(pkg.profile.customAvatar.sha256, avatarSha, '自定义头像进包，哈希必须与磁盘一致');
  assert.strictEqual(pkg.profile.customAvatar.dataBase64, avatarBytes.toString('base64'));

  // 正向控制：公开事件必须在包里（否则「没搜到秘密」可能只是因为包是空的）
  assert.ok(exp.text.includes('AB7-PUBLIC-EVENT'), '已结束局的公开事件必须在包里');

  // 脱敏：密钥/令牌/Cookie/日志凭证/恢复锚点一律不得出现（§7 第四条）
  for (const secret of SECRETS) assert.ok(!exp.text.includes(secret), `导出包泄漏了哨兵 ${secret}`);
  for (const key of SECRET_KEYS) assert.ok(!exp.text.includes(key), `导出包泄漏了字段 ${key}`);
  assert.ok(!exp.text.includes(h.dataDir), '导出包不得携带本机绝对路径');
  assert.ok(!exp.text.includes('AB-快照昵称'), '导出包不得携带存档内部快照字段');
  // 不夹带别人的东西
  assert.ok(!exp.text.includes('ab7-b'), '导出包不得含 B 的对局');
  assert.ok(!exp.text.includes('AB7-B-笔记'), '导出包不得含 B 的笔记');

  // --- 导入：创建新档案 + gameId 重映射 + 原档案不被覆盖 ---
  const imp = await h.request('POST', '/api/profiles/import', { body: { package: pkg } });
  assert.strictEqual(imp.status, 200, `导入必须成功：${imp.text.slice(0, 400)}`);
  assert.strictEqual(imp.body.ok, true);
  assert.strictEqual(imp.body.imported, 1, 'NEW-08：成功数来自真正落盘的局');
  assert.strictEqual(imp.body.importedNotes, 1, '笔记随包落地');
  assert.notStrictEqual(imp.body.profileId, A.id, '导入必须创建**新**档案，不能覆盖原档案');
  assert.deepStrictEqual(Object.keys(imp.body.gameMap), ['ab7-fin'], '重映射表键 = 包内旧 gameId');
  const newId = imp.body.gameMap['ab7-fin'];
  const newProfileId = imp.body.profileId;
  assert.notStrictEqual(newId, 'ab7-fin', 'gameId 必须被重映射（否则会覆盖原存档）');
  assert.match(newId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '新 gameId 必须是新 UUID');

  // 新档案出现在档案表里，昵称**原样保留** —— R02：不再拼「（导入）」后缀
  // （拼接会让 17–20 字昵称回导时报「昵称最长 20 个字符」，多轮还会越拼越长；重名由 UUID 区分）
  const rows = await h.profileList();
  const imported = rows.find((p) => p.id === newProfileId);
  assert.ok(imported, `导入出的档案必须在列表里：${JSON.stringify(rows.map((p) => p.nickname))}`);
  assert.strictEqual(imported.nickname, A.nickname, 'R02：导入的昵称必须原样保留');
  assert.ok(!/（导入）/.test(imported.nickname), 'R02：昵称里不得再出现「（导入）」');
  assert.notStrictEqual(newProfileId, A.id);
  assert.notStrictEqual(newProfileId, B.id);
  assert.strictEqual(rows.length, 4, '默认玩家 + A + B + 导入的新档案');

  // 落盘核实：新档案名下有 1 份存档，归属与 gameId 都指向新身份
  const owned = filesOwnedBy(h.saves, newProfileId);
  assert.deepStrictEqual(owned, [`${newId}.json`], 'NEW-08：imported 必须与磁盘上真正归属新档案的份数一致');
  assert.strictEqual(owned.length, imp.body.imported, '声称的导入数 = 真正落盘数');
  const newDoc = readDoc(h.saves, newId);
  assert.strictEqual(newDoc.ownerProfileId, newProfileId);
  assert.strictEqual(newDoc.game.id, newId, '存档内的 gameId 也必须重映射（不能只改文件名）');
  assert.strictEqual(newDoc.game.finished, true);
  const listNew = await h.request('GET', `/api/profiles/${newProfileId}/games`);
  assert.strictEqual(listNew.status, 200, listNew.text);
  assert.deepStrictEqual(h.ids(listNew), [newId], `导入的局必须挂在新档案名下：${listNew.text}`);
  assert.strictEqual(listNew.body.rows[0].ownerProfileId, newProfileId);
  // 头像随包落到新档案
  const newAvatar = h.api.profiles.readAvatar(newProfileId);
  assert.strictEqual(sha256Hex(newAvatar.data), avatarSha, '导入后自定义头像字节必须与原图一致');

  // 原档案不被覆盖：磁盘、档案元数据、对局列表三处对账
  const oldDoc = readDoc(h.saves, 'ab7-fin');
  assert.strictEqual(oldDoc.ownerProfileId, A.id, '原存档归属不得被导入覆盖');
  assert.strictEqual(oldDoc.game.id, 'ab7-fin');
  assert.strictEqual(oldDoc.tokens.player, 'AB-SECRET-PLAYER-TOKEN', '原存档内容必须逐字未变');
  const aAfter = await h.profileRow(A.id);
  assert.strictEqual(aAfter.nickname, aBefore.nickname, '原档案昵称不得被覆盖');
  assert.strictEqual(aAfter.revision, aBefore.revision, '导入不得改动原档案 revision');
  const listA = await h.request('GET', `/api/profiles/${A.id}/games`);
  assert.deepStrictEqual(h.ids(listA), ['ab7-fin', 'ab7-unf'], `原档案的对局必须原样：${listA.text}`);
  // 笔记归属：导入的笔记归新档案；A/B 的笔记分毫不动
  assert.strictEqual(h.api.annotations.get(newProfileId, newId).seats['2'].note, 'AB7-A-笔记');
  assert.strictEqual(h.api.annotations.get(A.id, 'ab7-fin').seats['2'].note, 'AB7-A-笔记');
  assert.deepStrictEqual(h.api.annotations.get(B.id, 'ab7-b').seats['1'].note, 'AB7-B-笔记');
  assert.deepStrictEqual(Object.keys(h.api.annotations.get(newProfileId, newId).seats), ['2'], '导入不得把 A 的其它笔记塞进新档案');

  // 导入侧的守卫：即便导出过滤被绕过，含未结束局的包也必须整体 400（§7 第三条的另一半）
  const badPkg = JSON.parse(JSON.stringify(pkg));
  badPkg.games.push({ id: 'ab7-unf-x', finished: false, players: [] });
  const bad = await h.request('POST', '/api/profiles/import', { body: { package: badPkg } });
  assert.strictEqual(bad.status, 400, `含未结束局的包必须整体拒绝：${bad.text}`);
  assert.match(bad.body.error, /未结束对局/, bad.text);
  assert.strictEqual((await h.profileList()).length, 4, '被拒的导入不得留下半份档案');
});

// ================================================================ ⑧ 笔记与经验归属
test('M2-AB ⑧笔记与经验归属固定：切档/归档/恢复都不转移 owner、笔记与经验池', async (t) => {
  const h = await harness(t, 'notes');
  const A = await h.mkProfile(SAME_NICKNAME);
  const B = await h.mkProfile(SAME_NICKNAME);

  // A 开一局并写笔记（走真实 HTTP 标注路由 + 对局令牌）
  const created = await h.request('POST', '/api/games', {
    body: { board: BOARD5, players: players5(), mock: true, profileId: A.id },
  });
  assert.strictEqual(created.status, 200, created.text);
  const gid = created.body.gameId;
  const entry = h.api.games.get(gid);
  assert.strictEqual(entry.ownerProfileId, A.id, '归属在建局时固化');

  const put = await h.request('PUT', `/api/games/${gid}/annotations`, {
    body: { token: created.body.playerToken, expectedRevision: 0, seats: { 3: { leaning: 'lean_wolf', note: 'AB8-甲的笔记' } } },
  });
  assert.strictEqual(put.status, 200, `前置：写笔记必须成功：${put.text}`);
  // 笔记落盘归属：只能在 A 的档案目录里（磁盘判据，不只看内存）
  const noteFileA = path.join(h.profilesRoot, A.id, 'annotations', `${gid}.json`);
  assert.ok(fs.existsSync(noteFileA), '笔记必须落在 A 的档案目录里');
  assert.strictEqual(JSON.parse(fs.readFileSync(noteFileA, 'utf8')).profileId, A.id);
  const noteDirB = path.join(h.profilesRoot, B.id, 'annotations');
  assert.ok(!fs.existsSync(noteDirB) || fs.readdirSync(noteDirB).length === 0, 'A 的笔记绝不能落进 B 的档案目录');

  // 经验池归属：按 owner UUID 分开，且路径就在各自档案目录下
  const expA = h.api.experienceFor(A.id);
  const expB = h.api.experienceFor(B.id);
  assert.notStrictEqual(expA, expB, 'A/B 的经验池必须是两个独立对象');
  assert.strictEqual(h.api.experienceFor(A.id), expA, '同一档案的经验池必须稳定（同一实例）');
  assert.strictEqual(expA.file, path.join(h.profilesRoot, A.id, 'experiences.json'));
  assert.strictEqual(expB.file, path.join(h.profilesRoot, B.id, 'experiences.json'));

  // --- 切档：默认档案改指 B，之后不带 profileId 的新局归 B；A 的旧局/笔记/经验一步不动 ---
  // 服务端没有「切档」写接口（当前档案是客户端偏好，见 §5.2），服务端可观测的形态就是
  // defaultProfileId 变化。这里直接改内存字段；**刻意不**顺带验证重启后的持久化标记
  // （那是 ProfileMigration.setDefaultId / _repointDefaultProfile 的职责，属 FIX-11 的既有覆盖）。
  h.api.defaultProfileId = B.id;
  const defaultView = await h.request('GET', '/api/profiles');
  assert.strictEqual(defaultView.body.defaultProfileId, B.id, '切换到哪份档案必须反映在档案表里');
  const created2 = await h.request('POST', '/api/games', {
    body: { board: BOARD5, players: players5(), mock: true }, // 不显式带 profileId ⇒ 走「当前档案」
  });
  assert.strictEqual(created2.status, 200, created2.text);
  const gid2 = created2.body.gameId;
  assert.strictEqual(h.api.games.get(gid2).ownerProfileId, B.id, '新局归属当前档案 B');
  assert.strictEqual(h.api.games.get(gid).ownerProfileId, A.id, '切档后 A 的进行中局 owner 必须仍然固定为 A');
  assert.strictEqual(h.api.annotations.get(A.id, gid).seats['3'].note, 'AB8-甲的笔记', '切档不得搬动笔记');
  assert.deepStrictEqual(h.api.annotations.get(B.id, gid).seats, {}, 'B 名下不得凭空出现 A 的笔记');
  assert.strictEqual(h.api.experienceFor(A.id), expA, '切档不得换掉 A 的经验池');
  assert.strictEqual(h.api.experienceFor(h.api.games.get(gid2).ownerProfileId), expB, 'B 的新局用 B 的经验池');
  // 战绩也固定：A 的对局只进 A 的统计
  assert.strictEqual((await h.request('GET', `/api/profiles/${A.id}/stats`)).body.total, 1);
  assert.strictEqual((await h.request('GET', `/api/profiles/${B.id}/stats`)).body.total, 1);
  assert.ok(!h.ids(await h.request('GET', `/api/profiles/${B.id}/games?limit=100`)).includes(gid), 'A 的局不得进 B 的列表');

  // --- 归档 A：owner / 笔记 / 经验池全部保持固定（归档 ≠ 归属转移） ---
  const arch = await h.request('PATCH', `/api/profiles/${A.id}`, { body: { archive: true } });
  assert.strictEqual(arch.status, 200, arch.text);
  assert.strictEqual(h.api.games.get(gid).ownerProfileId, A.id, '归档后对局 owner 必须仍然固定为 A');
  assert.strictEqual(h.api.annotations.get(A.id, gid).seats['3'].note, 'AB8-甲的笔记');
  assert.ok(fs.existsSync(noteFileA), '归档只是标记，笔记文件必须还在');
  assert.strictEqual(h.api.experienceFor(A.id), expA, '归档不得换掉 A 的经验池');
  assert.strictEqual((await h.request('GET', `/api/profiles/${A.id}/games`)).status, 404, '归档档案的对局接口 404（与 stats/games 同一语义）');
  // 反向：B 的列表/统计不受 A 归档影响
  assert.deepStrictEqual(h.ids(await h.request('GET', `/api/profiles/${B.id}/games?limit=100`)), [gid2]);
  assert.strictEqual((await h.request('GET', `/api/profiles/${B.id}/stats`)).body.total, 1);

  // --- 恢复 A：笔记与经验池原样回来 ---
  const restore = await h.request('PATCH', `/api/profiles/${A.id}`, { body: { restore: true } });
  assert.strictEqual(restore.status, 200, restore.text);
  const listA = await h.request('GET', `/api/profiles/${A.id}/games`);
  assert.deepStrictEqual(h.ids(listA), [gid], `恢复后 A 的对局必须回来：${listA.text}`);
  assert.strictEqual(h.api.annotations.get(A.id, gid).seats['3'].note, 'AB8-甲的笔记');
  assert.strictEqual(h.api.experienceFor(A.id), expA);
  // 归档/恢复往返之后，笔记仍然没有被 B 拿到
  assert.deepStrictEqual(h.api.annotations.get(B.id, gid).seats, {});
});

// ================================================================ 组合：走一遍「A/B 全流程」
test('M2-AB ⑨合流：A 建局→记胜→导出→导入→A 归档删除→B 全程不受影响', async (t) => {
  const h = await harness(t, 'flow');
  const A = await h.mkProfile(SAME_NICKNAME);
  const B = await h.mkProfile(SAME_NICKNAME);

  // A 开一局并结算成「正式胜」（用 mock 建局以免触网；结算后把盘上 mock 标记改成正式局语义）
  const created = await h.request('POST', '/api/games', {
    body: { board: BOARD5, players: players5(), mock: true, profileId: A.id },
  });
  assert.strictEqual(created.status, 200, `前置：A 开一局必须成功：${created.text}`);
  const gid = created.body.gameId;
  const entry = h.api.games.get(gid);
  entry.game.started = true;
  entry.game.finished = true;
  entry.game.phase = 'ended';
  entry.game.winner = 'good';
  entry.game.players = [{ seat: 1, name: '我', isHuman: true, role: 'villager' }];
  await h.api.saveGame(entry, { force: true });
  const disk = readDoc(h.saves, gid);
  disk.mock = false; // 夹具语义：这一局按「正式局」计（stats 的桶由盘上 doc.mock 决定）
  fs.writeFileSync(path.join(h.saves, `${gid}.json`), JSON.stringify(disk));
  assert.strictEqual(disk.ownerProfileId, A.id, '前置：正式局归属 A');

  // B 也开一局（进行中）
  const createdB = await h.request('POST', '/api/games', {
    body: { board: BOARD5, players: players5(), mock: true, profileId: B.id },
  });
  assert.strictEqual(createdB.status, 200, createdB.text);
  const gidB = createdB.body.gameId;
  h.api.games.get(gidB).game.started = true;

  // A 的战绩：1 胜；B 的列表只有自己那一局
  const sa = await h.request('GET', `/api/profiles/${A.id}/stats`);
  assert.strictEqual(sa.body.real, 1);
  assert.strictEqual(sa.body.wins, 1);
  assert.deepStrictEqual(h.ids(await h.request('GET', `/api/profiles/${B.id}/games?limit=100`)), [gidB]);

  // A 导出 → 导入（新档案），导入包不含 B 的局
  const exp = await h.request('GET', `/api/profiles/${A.id}/export`);
  assert.strictEqual(exp.status, 200, exp.text.slice(0, 200));
  assert.ok(!exp.text.includes(gidB), 'A 的导出包不得含 B 的局');
  assert.strictEqual(exp.body.manifest.counts.games, 1);
  const imp = await h.request('POST', '/api/profiles/import', { body: { package: exp.body } });
  assert.strictEqual(imp.status, 200, imp.text);
  assert.strictEqual(imp.body.imported, 1);
  const newId = imp.body.gameMap[gid];
  assert.notStrictEqual(newId, gid);
  // 导入出的新档案只有 1 局，B 的对局不会漏进它
  assert.deepStrictEqual(h.ids(await h.request('GET', `/api/profiles/${imp.body.profileId}/games?limit=100`)), [newId]);

  // A 归档 → 被自己的正式局放行删除（该局已结束）→ 但 B 的进行中局仍在，B 的删除照样被拒
  assert.strictEqual((await h.request('PATCH', `/api/profiles/${A.id}`, { body: { archive: true } })).status, 200);
  const delA = await h.request('DELETE', `/api/profiles/${A.id}`);
  assert.strictEqual(delA.status, 200, `A 只有已结束局，必须放行：${delA.text}`);
  // R05 契约：B 有进行中局 ⇒ **连归档都不许**（旧契约此处允许归档、只在删除时拒）。
  //   删除那条规则仍然成立，只是现在被前一道门挡住；两层都钉住（纵深防御）。
  const archB = await h.request('PATCH', `/api/profiles/${B.id}`, { body: { archive: true } });
  assert.strictEqual(archB.status, 400, `B 有未结束局，归档必须被拒（实际 ${archB.status}：${archB.text}）`);
  assert.match(archB.body.error, /未结束的对局/);
  await h.api.profiles._updateInner(B.id, { archive: true }); // 直接写库：造出"已归档 + 进行中"的非法存量态
  const delB = await h.request('DELETE', `/api/profiles/${B.id}`);
  assert.strictEqual(delB.status, 400, `B 有未结束局，删除必须被拒（实际 ${delB.status}：${delB.text}）`);
  assert.match(delB.body.error, /进行中/);

  // 收尾对账：A 的局仍归属 A（没有被转给任何人），B 的局仍归属 B
  assert.strictEqual(readDoc(h.saves, gid).ownerProfileId, A.id);
  assert.strictEqual(readDoc(h.saves, gidB).ownerProfileId, B.id);
  assert.deepStrictEqual(filesOwnedBy(h.saves, imp.body.profileId), [`${newId}.json`]);
});
