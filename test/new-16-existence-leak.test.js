/**
 * new-16-existence-leak.test.js — NEW-16：未授权调用不得用 404/403 的差异判定"资源是否存在"
 *
 * ## 真实缺陷（台账条目 NEW-16）
 * `src/api.js` 里对 `/api/games/<id>/…` 的处理有**三处**"先看存在性、再看授权"的分支：
 *   · `GET /session|/tokens`：`!doc` → 404「对局不存在」；
 *   · `POST /resume`：`!doc` → 404「存档不存在」；
 *   · 其余全部子路由共享的 `!getGame(id)` → 404「对局不存在」。
 * 而"这一局存在、但你的令牌不对"给的是 403「token 无效」（/tokens 是 401 配对串）。
 * 于是未配对的调用者只要拿到一个 gameId，就能用 404 vs 403 的差异判定
 * **这个 id 是不是一局真实对局**（也能区分"仅磁盘存在"的局）—— 信息泄漏，且这正是
 * `:2279` 那条"授权先于状态"注释要防的同一类问题（NEW-11 修的是写接口的守卫顺序）。
 *
 * ## 判据（为什么这样写才真的钉住，而不是"我以为修好了"）
 * 本文件**不硬编码**任何"应该返回什么"，而是**对拍**：同一个请求打两次 ——
 *   ① 打在"真实存在的局"上（内存局 / 仅磁盘局 / 无归属档案局三种形态），带错令牌或不带令牌；
 *   ② 打在一个**不存在**的 id（随机 UUID）上，请求形状完全相同。
 * 两者（状态码 + 完整报文）必须**严格相等**：差异本身就是探针。
 * 覆盖 20 条子路由 + 未知子路由 + 方法不匹配。这样写有三个好处：
 *   · 将来任何一条子路由改了拒绝文案而忘了同步，对拍立刻红（自维护，不靠人记文案）；
 *   · 偷懒做法"把不存在统一成一句通用串"会被抓住 —— 那些路由**存在时**的拒绝是专属串
 *     （/logs、/agent、/replay 是「需要上帝 token」，/explode 是「仅玩家本人可自爆」…），
 *     对拍必然不相等；
 *   · 反向两组钉子保证没有"为了不可区分而把授权者一起改坏"：管理会话仍是 404、
 *     持本局令牌者看到的业务语义逐字不变。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeDataDir, makeApiIn, savesOf, terminateApi } = require('./helpers-tmpdir');
const { Game } = require('../src/engine/game');

const silentLogger = {
  debug() {}, info() {}, warn() {}, error() {},
  openGameLog() {}, closeGameLog() {}, query() { return []; },
};
/** 未配对远端：不可信 Host + 非回环地址 ⇒ auth.isManagement(req) === false（与 test/remediation.test.js 同款） */
const ATTACKER = { host: 'attacker.example', remote: '192.168.1.5' };
const LOCAL = { host: 'localhost:3210', remote: '127.0.0.1' };
/** 猜错的令牌（真实令牌是 tokenId() 生成的随机串） */
const WRONG = 'not-the-real-token';

function stubRes() {
  const box = { headers: {} };
  box.res = {
    writeHead(code) { box.code = code; },
    end(b) { box.body = b ? JSON.parse(b) : null; },
    setHeader(k, v) { box.headers[k.toLowerCase()] = v; },
  };
  return box;
}
function stubReq({ method = 'GET', remote = '127.0.0.1', headers = {}, body = null } = {}) {
  const { EventEmitter } = require('events');
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  req.socket = { remoteAddress: remote };
  req.url = '/';
  process.nextTick(() => {
    if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

/** 造一个"能建 mock 局"的 api + 一张请求函数 */
function harness() {
  const dataDir = makeDataDir('new16');
  const { api } = makeApiIn(dataDir, { config: { get: () => ({ apiKey: '', journal: false }), save() {} } });
  const call = async (pathAndQuery, { method = 'GET', body = null, who = LOCAL } = {}) => {
    const [p, q] = pathAndQuery.split('?');
    const box = stubRes();
    await api.handle(
      stubReq({ method, remote: who.remote, headers: { host: who.host }, body }),
      box.res, p, new URLSearchParams(q),
    );
    return { status: box.code, body: box.body };
  };
  return { api, dataDir, call };
}

/** 建一局真实的 mock 对局（人类 + AI），发牌并推进到"已开始"，返回 { id, playerToken, godToken, entry } */
async function makeRealGame(call, body) {
  const created = await call('/api/games', {
    method: 'POST',
    body: body || {
      board: { wolf: 1, seer: 1, witch: 1, villager: 2 },
      players: [{ isHuman: true }, { isHuman: false }, { isHuman: false }, { isHuman: false }, { isHuman: false }],
      mock: true,
    },
  });
  assert.strictEqual(created.status, 200, `前置：建局必须成功（否则整组对拍会空转）：${JSON.stringify(created.body)}`);
  return { id: created.body.gameId, playerToken: created.body.playerToken, godToken: created.body.godToken };
}

/** 未授权调用者在 `/api/games/<id>` 上的全部探针（覆盖 dispatch 里每一条子路由 + 未知子路由 + 错误方法） */
const PROBES = [
  ['GET', '/view?token=WRONG', null],
  ['GET', '/stream?token=WRONG', null],
  ['GET', '/session', null],
  ['GET', '/session?token=WRONG', null],
  ['GET', '/tokens', null],
  ['POST', '/action', { token: WRONG, payload: {} }],
  ['POST', '/start', { token: WRONG }],
  ['POST', '/terminate', { token: WRONG }],
  ['POST', '/resume', { token: WRONG }],
  ['POST', '/explode', { token: WRONG }],
  ['POST', '/duel', { token: WRONG, target: 2 }],
  ['POST', '/wolftalk', { token: WRONG, kind: 'end' }],
  ['POST', '/review', { token: WRONG }],
  ['GET', '/review?token=WRONG', null],
  ['GET', '/logs?token=WRONG', null],
  ['GET', '/agent?token=WRONG&seat=1', null],
  ['GET', '/replay?token=WRONG', null],
  ['GET', '/annotations?token=WRONG', null],
  ['PUT', '/annotations', { token: WRONG, expectedRevision: 0, seats: {} }],
  ['DELETE', '/annotations?token=WRONG&seat=2', null],
  ['GET', '/no-such-subroute', null],
  ['DELETE', '/view', null],
];

test('NEW-16：未授权调用下「存在的局」与「不存在的 id」必须逐字节不可区分（20 条子路由 + 未知子路由）', async () => {
  const { api, dataDir, call } = harness();
  try {
    const real = await makeRealGame(call);
    const entry = api.games.get(real.id);
    entry.game.deal();
    entry.game.started = true;
    entry.game.phase = 'speech';
    // 真实的"仅磁盘存在"局：服务重启后的形态（/session 可读、/resume 可从锚点续跑）
    const diskId = 'new16-disk-only';
    fs.writeFileSync(path.join(savesOf(dataDir), `${diskId}.json`), JSON.stringify({
      game: { id: diskId, players: [{ seat: 1, isHuman: true }], day: 1, phase: 'night', started: true, finished: false },
      anchor: { id: diskId, nextPhase: 'night' },
      tokens: { player: 'disk-player', god: 'disk-god' }, mock: true, ownerProfileId: null,
    }));
    // 真实存在但**没有归属档案**的局（NEW-11 修的正是它的标注接口顺序）
    const orphan = new Game({
      id: 'new16-orphan', board: { wolf: 1, seer: 1, witch: 1, villager: 2 },
      players: [{ name: 'P1', isHuman: true }, { name: 'P2' }, { name: 'P3' }, { name: 'P4' }, { name: 'P5' }],
      stepPauseMs: 1, logger: silentLogger,
    });
    orphan.deal();
    orphan.started = true;
    api.games.set(orphan.id, {
      game: orphan, running: false, error: null, mock: true, review: null,
      tokens: { player: 'orphan-player', god: 'orphan-god' }, createdAt: Date.now(), lastAccess: Date.now(),
    });
    const ghostId = `missing-${crypto.randomUUID()}`;
    assert.ok(!api.games.has(ghostId) && !fs.existsSync(path.join(savesOf(dataDir), `${ghostId}.json`)),
      '前置：这个 id 必须既不进内存也没有存档（否则对比的不是"不存在"）');

    const diffs = [];
    for (const [method, tail, body] of PROBES) {
      const onReal = await call(`/api/games/${real.id}${tail}`, { method, body, who: ATTACKER });
      const onMissing = await call(`/api/games/${ghostId}${tail}`, { method, body, who: ATTACKER });
      // 前置：真实局这一侧确实被拒了（否则"两边相等"可能只是"两边都 200"）
      assert.ok(onReal.status >= 400, `${method} ${tail}：未授权调用居然没被拒（${onReal.status}）—— 对拍会失去意义`);
      if (onReal.status !== onMissing.status || JSON.stringify(onReal.body) !== JSON.stringify(onMissing.body)) {
        diffs.push(
          `${method} ${tail}\n    存在的局 → ${onReal.status} ${JSON.stringify(onReal.body)}`
          + `\n    不存在   → ${onMissing.status} ${JSON.stringify(onMissing.body)}`,
        );
      }
    }
    // 仅磁盘存在的局同样不许被区分出来（/session 与 /tokens 走的是"读存档"的那条分支）
    for (const [method, tail, body] of [['GET', '/session?token=WRONG', null], ['GET', '/tokens', null], ['GET', '/view?token=WRONG', null], ['POST', '/resume', { token: WRONG }]]) {
      const onDisk = await call(`/api/games/${diskId}${tail}`, { method, body, who: ATTACKER });
      const onMissing = await call(`/api/games/${ghostId}${tail}`, { method, body, who: ATTACKER });
      if (onDisk.status !== onMissing.status || JSON.stringify(onDisk.body) !== JSON.stringify(onMissing.body)) {
        diffs.push(
          `${method} ${tail}（仅磁盘存在的局）\n    磁盘局 → ${onDisk.status} ${JSON.stringify(onDisk.body)}`
          + `\n    不存在 → ${onMissing.status} ${JSON.stringify(onMissing.body)}`,
        );
      }
    }
    // "没有归属档案"的局：老实现 404 vs 403 也能区分存在性，这里一并钉住
    for (const [method, tail, body] of [['GET', '/annotations?token=WRONG', null], ['PUT', '/annotations', { token: WRONG, seats: {} }], ['DELETE', '/annotations?token=WRONG&seat=2', null]]) {
      const onOrphan = await call(`/api/games/${orphan.id}${tail}`, { method, body, who: ATTACKER });
      const onMissing = await call(`/api/games/${ghostId}${tail}`, { method, body, who: ATTACKER });
      if (onOrphan.status !== onMissing.status || JSON.stringify(onOrphan.body) !== JSON.stringify(onMissing.body)) {
        diffs.push(
          `${method} ${tail}（无归属档案的局）\n    存在的局 → ${onOrphan.status} ${JSON.stringify(onOrphan.body)}`
          + `\n    不存在   → ${onMissing.status} ${JSON.stringify(onMissing.body)}`,
        );
      }
    }
    assert.deepStrictEqual(
      diffs,
      [],
      '未授权调用者能用响应差异判定"这个 gameId 是不是真对局"（NEW-16）：\n  ' + diffs.join('\n  '),
    );
  } finally {
    await terminateApi(api, dataDir);
  }
});

test('NEW-16 反向钉：管理会话（本机）对不存在的局的 404 语义逐字不变', async () => {
  const { api, dataDir, call } = harness();
  try {
    const ghostId = `missing-${crypto.randomUUID()}`;
    const cases = [
      ['GET', '/session', null, '对局不存在'],
      ['GET', '/tokens', null, '对局不存在'],
      ['GET', '/view?token=x', null, '对局不存在'],
      ['GET', '/annotations?token=x', null, '对局不存在'],
      // 未知子路由也走"先看存在性"那条：管理会话 + 不存在的 id 仍是 404「对局不存在」
      // （'not found' 只会在"局存在但子路由/方法不认识"时出现；两条都由对拍用例覆盖）
      ['GET', '/no-such-subroute', null, '对局不存在'],
      ['POST', '/resume', { token: 'x' }, '存档不存在'],
    ];
    for (const [method, tail, body, expected] of cases) {
      const box = await call(`/api/games/${ghostId}${tail}`, { method, body, who: LOCAL });
      assert.strictEqual(box.status, 404, `管理会话 ${method} ${tail} 必须仍是 404，实际 ${box.status}`);
      assert.strictEqual(box.body.error, expected, `管理会话 ${method} ${tail} 的报文必须逐字不变`);
    }
    // 本机恢复流的第一步（读磁盘摘要 / 读令牌）不受影响
    const diskId = 'new16-disk-local';
    fs.writeFileSync(path.join(savesOf(dataDir), `${diskId}.json`), JSON.stringify({
      game: { id: diskId, players: [{ seat: 1, isHuman: true }], day: 2, phase: 'day', started: true, finished: false },
      anchor: { id: diskId, nextPhase: 'day' },
      tokens: { player: 'disk-local-player', god: 'disk-local-god' }, mock: true, ownerProfileId: null,
    }));
    const summary = await call(`/api/games/${diskId}/session`, { who: LOCAL });
    assert.strictEqual(summary.status, 200, `管理会话读磁盘摘要必须 200，实际 ${summary.status}`);
    assert.strictEqual(summary.body.inMemory, false, '磁盘局不得被计成内存局');
    assert.strictEqual(summary.body.started, true);
    const tokens = await call(`/api/games/${diskId}/tokens`, { who: LOCAL });
    assert.strictEqual(tokens.status, 200, `管理会话读令牌必须 200，实际 ${tokens.status}`);
    assert.deepStrictEqual(tokens.body, { player: 'disk-local-player', god: 'disk-local-god' });
  } finally {
    await terminateApi(api, dataDir);
  }
});

test('NEW-16 反向钉：已授权调用者（持本局令牌）看到的业务码与文案逐字不变', async () => {
  const { api, dataDir, call } = harness();
  try {
    const real = await makeRealGame(call);
    const entry = api.games.get(real.id);
    entry.game.deal();
    entry.game.started = true;
    entry.game.phase = 'speech';
    const me = entry.game.players.find((p) => p.isHuman);
    me.role = 'wolf';
    me.alive = true;
    const who = { who: ATTACKER }; // 非管理会话：只靠单局令牌授权

    const summary = await call(`/api/games/${real.id}/session?token=${real.playerToken}`, who);
    assert.strictEqual(summary.status, 200, '持本局令牌读摘要必须 200');
    assert.strictEqual(summary.body.tokenValid, true);
    assert.strictEqual(summary.body.inMemory, true);

    const view = await call(`/api/games/${real.id}/view?token=${real.playerToken}`, who);
    assert.strictEqual(view.status, 200, `持本局令牌看视图必须 200，实际 ${view.status} ${JSON.stringify(view.body)}`);

    const noPending = await call(`/api/games/${real.id}/action`, { method: 'POST', body: { token: real.playerToken, payload: {} }, who: ATTACKER });
    assert.strictEqual(noPending.status, 409, '已授权 + pending 为空仍是 409');
    assert.strictEqual(noPending.body.error, '当前没有等待中的操作', '正常用户看到的文案不许变');

    // 「存在但你没有归属档案」这条 404 是**授权之后**才允许说的：它必须原样保留
    const orphan = new Game({
      id: 'new16-orphan-auth', board: { wolf: 1, seer: 1, witch: 1, villager: 2 },
      players: [{ name: 'P1', isHuman: true }, { name: 'P2' }, { name: 'P3' }, { name: 'P4' }, { name: 'P5' }],
      stepPauseMs: 1, logger: silentLogger,
    });
    orphan.deal();
    orphan.started = true;
    api.games.set(orphan.id, {
      game: orphan, running: false, error: null, mock: true, review: null,
      tokens: { player: 'orphan-auth-player', god: 'orphan-auth-god' }, createdAt: Date.now(), lastAccess: Date.now(),
    });
    const orphanAuthed = await call(`/api/games/${orphan.id}/annotations?token=orphan-auth-player`, who);
    assert.strictEqual(orphanAuthed.status, 404, '已授权 + 无归属档案仍必须 404');
    assert.strictEqual(orphanAuthed.body.error, '该对局没有归属档案（旧局/观战局）', '这条 404 是授权之后才允许说的，文案不许变');

    // 仅磁盘存在的局：持正确令牌照样能读摘要（恢复流第一步不许被这次加固误伤）
    const diskId = 'new16-disk-auth';
    fs.writeFileSync(path.join(savesOf(dataDir), `${diskId}.json`), JSON.stringify({
      game: { id: diskId, players: [{ seat: 1, isHuman: true }], day: 1, phase: 'night', started: true, finished: false },
      anchor: { id: diskId, nextPhase: 'night' },
      tokens: { player: 'disk-auth-player', god: 'disk-auth-god' }, mock: true, ownerProfileId: null,
    }));
    const diskSummary = await call(`/api/games/${diskId}/session?token=disk-auth-player`, who);
    assert.strictEqual(diskSummary.status, 200, '持令牌读磁盘局摘要必须 200');
    assert.strictEqual(diskSummary.body.tokenValid, true);
    assert.strictEqual(diskSummary.body.inMemory, false);
  } finally {
    await terminateApi(api, dataDir);
  }
});
