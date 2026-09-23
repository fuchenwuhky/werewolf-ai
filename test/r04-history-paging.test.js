/**
 * r04-history-paging.test.js — R04：完整历史必须能逐页读完（服务端契约面）
 *
 * 审核结论的实测部分：两端历史请求固定 limit=100，hasMore 只显示"还有更多"，没有下一页。
 * 服务端其实早就给了游标契约（GET …/history?after=<seq>&limit=<n> → rows/total/hasMore/nextAfter，
 * 只下发 visibleTo=all 的公开事件），此外 /games?offset&limit&status 也早就支持分页 ——
 * 缺的是前端接线（前端部分由 scripts/ui-check.js 的 R04 段在真页面上验）。本文件钉住**服务端面**：
 *
 *   · 65 局：逐页 offset/limit 看到最后一项，无重复、无遗漏、hasMore 在末尾恰好转 false；
 *   · 251 条**非连续 seq** 的公开事件：按 nextAfter 逐页读完，并集精确等于期望集合（去重/不丢）；
 *   · 私密事件（visibleTo 为 seat:&lt;n&gt; 或 god）与 data 一律不得出现在响应里；
 *   · 读历史**只读**：不构造 Game（api.games 保持为空）、不改动存档文件（mtime 不变）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const events = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const Api = require('../src/api').Api || require('../src/api');
const { makeDataDir, savesOf, terminateApi } = require('./helpers-tmpdir');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const BOARD5 = { wolf: 1, villager: 3, seer: 1 };

function makeApi(tag) {
  const dataDir = makeDataDir(tag);
  const savesDir = savesOf(dataDir);
  const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: savesDir });
  return { api, dataDir, savesDir };
}

async function callApi(api, method, pathname, raw) {
  const u = new URL(pathname, 'http://localhost');
  const req = new events.EventEmitter();
  req.method = method;
  req.headers = { host: 'localhost:3210' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const box = { headers: {} };
  box.res = {
    writeHead(code, h) { box.code = code; Object.assign(box.headers, h || {}); },
    end(b) { box.raw = b; },
    setHeader(k, v) { box.headers[k.toLowerCase()] = v; },
  };
  process.nextTick(() => {
    if (raw !== undefined && raw !== null) req.emit('data', raw);
    req.emit('end');
  });
  await api.handle(req, box.res, u.pathname, u.searchParams);
  const text = box.raw != null ? String(box.raw) : null;
  return { status: box.code, text, body: text ? JSON.parse(text) : null };
}
const post = (api, p, body) => callApi(api, 'POST', p, Buffer.from(JSON.stringify(body), 'utf8'));

/** 一份"已结束"的存档（形状与仓库既有夹具一致） */
function finishedSaveDoc(id, pid, { events: evs = [], savedAt = 1 } = {}) {
  return {
    schemaVersion: 2, tokens: {}, mock: false, ownerProfileId: pid, ownerNicknameSnapshot: '分页客', profileSchemaVersion: 1,
    game: {
      id, day: 2, phase: 'ended', started: true, finished: true, winner: 'good', winReason: '狼人全部出局',
      players: [{ seat: 1, name: '我', isHuman: true, role: 'seer' }, { seat: 2, name: 'A', isHuman: false, role: 'wolf' }],
      events: evs, board: BOARD5, rules: {},
    },
    anchor: null, review: null, savedAt,
  };
}

// 251 条公开事件，seq **非连续**（间隔递增的跳跃），并夹带 8 条私密事件（绝不该下发）
function buildEvents() {
  const pub = [];
  const priv = [];
  let seq = 1;
  for (let i = 0; i < 251; i++) {
    pub.push({ seq, day: 1 + (i % 3), phase: 'day', type: 'speech', actor: 2, text: `公开事件 #${i + 1}`, ts: 1000 + i, visibleTo: 'all' });
    // 每 10 条夹一条私密事件：座位私有与上帝视角各半
    if (i % 10 === 3) {
      priv.push({ seq: seq + 1, day: 1, phase: 'night', type: 'wolf_talk', actor: 2, text: `私密-狼队密谈 #${i}`, ts: 2000 + i, visibleTo: 'seat:2' });
      priv.push({ seq: seq + 2, day: 1, phase: 'night', type: 'god_note', actor: 1, text: `私密-上帝笔记 #${i}`, ts: 3000 + i, visibleTo: 'god', data: { secret: true } });
      seq += 3;
    } else {
      seq += 1 + (i % 4); // 非连续：间隔在 1–4 之间跳
    }
  }
  return { pub, priv, pubSeqs: pub.map((e) => e.seq) };
}

/** 逐页读完对局列表（offset/limit），返回 { ids, pages, hasMoreAtEnd } */
async function pageThroughGames(api, pid, { status = 'finished', limit = 7 } = {}) {
  const ids = [];
  const pages = [];
  let offset = 0;
  for (let guard = 0; guard < 100; guard++) {
    const r = await callApi(api, 'GET', `/api/profiles/${pid}/games?status=${status}&offset=${offset}&limit=${limit}`);
    assert.strictEqual(r.status, 200, `列表页失败：${r.status} ${r.text && r.text.slice(0, 160)}`);
    const rows = r.body.rows || [];
    pages.push({ offset, got: rows.length, hasMore: r.body.hasMore, total: r.body.total });
    for (const row of rows) ids.push(row.id);
    if (!r.body.hasMore) return { ids, pages, hasMoreAtEnd: false, total: r.body.total };
    assert.ok(rows.length > 0, 'hasMore 为真时这一页不该是空的（否则会死循环）');
    offset += rows.length;
  }
  throw new Error('分页没有终止（guard 用尽）');
}

test('R04：65 局对局列表逐页读到最后一项 —— 无重复、无遗漏、末尾 hasMore 恰好转 false', async () => {
  const { api, dataDir, savesDir } = makeApi('r04-games');
  try {
    await api._profileMigrationReady;
    const pid = (await post(api, '/api/profiles', { nickname: '分页客' })).body.profile.id;
    const want = [];
    for (let i = 0; i < 65; i++) {
      const id = `g-${String(i).padStart(2, '0')}`;
      want.push(id);
      fs.writeFileSync(path.join(savesDir, `${id}.json`),
        JSON.stringify(finishedSaveDoc(id, pid, { savedAt: 1000 + i })));
    }
    const { ids, pages, total } = await pageThroughGames(api, pid, { limit: 7 });
    assert.strictEqual(ids.length, 65, `应恰好读到 65 局（实际 ${ids.length}）`);
    assert.strictEqual(new Set(ids).size, 65, 'R04：分页结果里不得有重复对局');
    assert.deepStrictEqual([...new Set(ids)].sort(), [...want].sort(), 'R04：分页结果不得遗漏任何一局');
    assert.strictEqual(total, 65, 'total 应报告完整条数');
    assert.ok(pages.length >= 10, `7 条一页读 65 局至少 10 页（实际 ${pages.length} 页）⇒ 说明真的在分页`);
    assert.strictEqual(pages[pages.length - 1].hasMore, false, 'R04：最后一页的 hasMore 必须为 false');
    // 反向：这一轮的"已结束"筛选不能把进行中的算进来
    const un = await callApi(api, 'GET', `/api/profiles/${pid}/games?status=unfinished&limit=50`);
    assert.strictEqual((un.body.rows || []).length, 0, '全部都是已结束局时，进行中列表应为空');
  } finally { await terminateApi(api, dataDir); }
});

test('R04：251 条非连续 seq 的公开事件按 nextAfter 逐页读完 —— 并集精确相等、末尾 hasMore 转 false', async () => {
  const { api, dataDir, savesDir } = makeApi('r04-hist');
  try {
    await api._profileMigrationReady;
    const pid = (await post(api, '/api/profiles', { nickname: '历史客' })).body.profile.id;
    const { pub, priv, pubSeqs } = buildEvents();
    const gid = 'g-hist';
    const file = path.join(savesDir, `${gid}.json`);
    // 打乱物理顺序：服务端必须**显式按 seq 排序**，不能依赖数组顺序（否则非连续 seq 会错页）
    const shuffled = pub.concat(priv).slice().reverse();
    fs.writeFileSync(file, JSON.stringify(finishedSaveDoc(gid, pid, { events: shuffled })));
    const before = fs.statSync(file).mtimeMs;

    const seen = [];
    let after = 0;
    let pages = 0;
    let lastHasMore = null;
    for (let guard = 0; guard < 50; guard++) {
      const url = `/api/profiles/${pid}/games/${gid}/history?limit=37${after ? `&after=${after}` : ''}`;
      const r = await callApi(api, 'GET', url);
      assert.strictEqual(r.status, 200, `历史页失败：${r.status} ${r.text && r.text.slice(0, 160)}`);
      pages++;
      const rows = r.body.rows || [];
      for (const e of rows) seen.push(e.seq);
      lastHasMore = r.body.hasMore;
      if (!r.body.hasMore) break;
      assert.ok(rows.length > 0, 'hasMore 为真时这一页不该是空的');
      assert.ok(Number.isFinite(Number(r.body.nextAfter)) && Number(r.body.nextAfter) > after,
        `nextAfter 必须是前进的游标（拿到 ${r.body.nextAfter}，当前 ${after}）`);
      after = Number(r.body.nextAfter);
    }
    assert.ok(pages >= 6, `37 条一页读 251 条至少 7 页（实际 ${pages} 页）⇒ 说明真的在用游标分页`);
    assert.strictEqual(lastHasMore, false, 'R04：读完时 hasMore 必须为 false（用户能看到最后一项）');
    assert.strictEqual(seen.length, 251, `公开事件应恰好 251 条（实际 ${seen.length}）`);
    assert.strictEqual(new Set(seen).size, 251, 'R04：分页不得重复下发同一条事件');
    assert.deepStrictEqual(seen.slice().sort((a, b) => a - b), pubSeqs.slice().sort((a, b) => a - b),
      'R04：分页并集必须精确等于全部公开事件的 seq（不丢、不串）');
    // 非连续性自证：seq 不是 1..251 的连续整数
    const gaps = pubSeqs.slice(1).filter((s, i) => s - pubSeqs[i] > 1).length;
    assert.ok(gaps > 50, `夹具自证：seq 必须是非连续的（实际有 ${gaps} 处跳跃）`);
    // 私密事件绝不下发
    const allText = JSON.stringify(seen);
    assert.ok(!/私密/.test(allText), 'R04：私密事件不得出现在历史里');
    const onePage = await callApi(api, 'GET', `/api/profiles/${pid}/games/${gid}/history?limit=200`);
    const blob = JSON.stringify(onePage.body);
    assert.ok(!/私密/.test(blob), 'R04：seat:*/god 视角的事件与 data 字段都不得下发');
    assert.ok(!/"data"/.test(blob), 'R04：事件 data（可能带内部结构）不得下发');
    // 只读自证：api.games 里不该出现这局（没有构造 Game），存档文件也没被改写
    assert.strictEqual(api.games.get(gid), undefined, 'R04：读历史不得把对局装进内存（那会连带重建 AI 记忆）');
    assert.strictEqual(api.games.size, 0, 'R04：读历史不该构造任何 Game');
    assert.strictEqual(fs.statSync(file).mtimeMs, before, 'R04：读历史不得改写存档文件');
  } finally { await terminateApi(api, dataDir); }
});

test('R04：历史契约的边界 —— 未结束局 409、别人的局 404、非法游标 400', async () => {
  const { api, dataDir, savesDir } = makeApi('r04-edge');
  try {
    await api._profileMigrationReady;
    const me = (await post(api, '/api/profiles', { nickname: '我' })).body.profile.id;
    const other = (await post(api, '/api/profiles', { nickname: '别人' })).body.profile.id;
    fs.writeFileSync(path.join(savesDir, 'g-running.json'), JSON.stringify({
      ...finishedSaveDoc('g-running', me, { events: [{ seq: 1, day: 1, phase: 'day', type: 'speech', text: 'x', visibleTo: 'all' }] }),
      game: { ...finishedSaveDoc('g-running', me).game, finished: false, phase: 'day' },
    }));
    fs.writeFileSync(path.join(savesDir, 'g-mine.json'), JSON.stringify(finishedSaveDoc('g-mine', me, { events: [] })));
    fs.writeFileSync(path.join(savesDir, 'g-theirs.json'), JSON.stringify(finishedSaveDoc('g-theirs', other, { events: [] })));

    const running = await callApi(api, 'GET', `/api/profiles/${me}/games/g-running/history`);
    assert.strictEqual(running.status, 409, 'R04：未结束局的历史应 409（状态冲突语义与 /resume 一致）');
    const theirs = await callApi(api, 'GET', `/api/profiles/${me}/games/g-theirs/history`);
    assert.strictEqual(theirs.status, 404, 'R04：不属于该档案的局应 404（不给归属探针）');
    const bad = await callApi(api, 'GET', `/api/profiles/${me}/games/g-mine/history?after=abc`);
    assert.strictEqual(bad.status, 400, 'R04：非法游标应 400');
    // ⚠ 实测更正：limit 超上限时服务端**钳制**到上限（200）而不是 400 —— 所以这里断言"真的被钳住"，
    //   而不是我以为的报错（_pagingInt 的语义是"收敛到合法区间"，与 /games 的 offset/limit 一致）。
    const bigLimit = await callApi(api, 'GET', `/api/profiles/${me}/games/g-mine/history?limit=9999`);
    assert.strictEqual(bigLimit.status, 200, 'limit 超上限应被钳制后正常返回');
    assert.ok(bigLimit.body.limit <= 200 && bigLimit.body.limit >= 1,
      `R04：limit 必须被钳制到合法上限（实际回显 ${bigLimit.body.limit}）`);
    assert.ok((bigLimit.body.rows || []).length <= bigLimit.body.limit, '返回条数不得超过钳制后的 limit');
  } finally { await terminateApi(api, dataDir); }
});
