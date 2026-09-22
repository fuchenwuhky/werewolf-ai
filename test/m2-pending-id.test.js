/**
 * m2-pending-id.test.js — M2-a：对局 view 的 pending 唯一 `pendingId` + action 的校验与防重放
 *
 * ## 要修的缺陷（计划书 §6 第 4/5 行，fix-plan 把它列为数据安全第一顺位）
 * 旧实现里 `POST /api/games/:id/action` 只判断"此刻有没有人在等操作"，不知道提交者手里的答案是
 * **当前**任务的还是上一个任务的：
 *   · 同一 action 重放两次（第二次恰逢引擎已挂起下一个任务）会被当成新任务的有效答案；
 *   · 客户端网络重试把上一任务的答案又交一次，同样可能落进新任务。
 * 两个都是"重复业务提交"。修法：引擎每次 `ask()`（人类挂起）生成新的唯一 id，随 view 的
 * `pending.pendingId` 下发；action 在**产生任何副作用之前**比对。
 *
 * ## 本文件钉住的语义（与 src/api.js 的 action() 注释一一对应）
 *   ① view 的 pending 带 id，且每次新任务换新值；
 *   ② 正确 id ⇒ 应用成功；
 *   ③ 过期/错误 id ⇒ 409 且**无副作用**（事件流、seq、pending 全不变，任务仍可带对 id 重试）；
 *   ④ 同一 action 连发两次 ⇒ 第二次被拒，且解析只发生一次（不二次执行）；
 *   ⑤ 当前没有 pending 时**不因缺 id 而拒绝** —— 仍是原来那句 409「当前没有等待中的操作」；
 *   ⑥ 老客户端（不带 pendingId）的非等待态路径逐字不变（本文件用同一请求对拍 ⑤/⑥）。
 *
 * ## 为什么这样写才不是"我以为修好了"
 *   · ③/④ 不只看状态码：每次拒绝都同时断言 `seq`、`events.length`、pending 对象**引用**没变，
 *     并再补一次带正确 id 的成功提交 —— 若实现把比对放在 resolveHuman 之后，这几条必红。
 *   · ⑤/⑥ 用**同一个请求形状**（无 payload 差异）在"无 pending"下对拍，
 *     报文必须逐字等于加固前的文案；实现若顺手把缺 id 也拒成新文案，这里会红。
 *   · 另外单钉一条"同座位同任务的新 pending 必须改变 SSE 指纹"——否则客户端永远拿不到新 id，
 *     加固就会变成"玩家发言永远被 409"。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { makeDataDir, makeApiIn, terminateApi } = require('./helpers-tmpdir');

function stubRes() {
  const box = { headers: {} };
  box.res = {
    writeHead(code) { box.code = code; },
    end(b) { box.body = b ? JSON.parse(b) : null; },
    setHeader(k, v) { box.headers[k.toLowerCase()] = v; },
  };
  return box;
}
function stubReq({ method = 'GET', body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { host: 'localhost:3210' };
  req.socket = { remoteAddress: '127.0.0.1' };
  req.url = '/';
  process.nextTick(() => {
    if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

/** 独占 dataDir + 真实 Api + 一张请求函数（与 test/new-16-existence-leak.test.js 同款形状） */
function harness() {
  const dataDir = makeDataDir('m2pid');
  const { api } = makeApiIn(dataDir, { config: { get: () => ({ apiKey: '', journal: false }), save() {} } });
  const call = async (pathAndQuery, { method = 'GET', body = null } = {}) => {
    const [p, q] = pathAndQuery.split('?');
    const box = stubRes();
    await api.handle(stubReq({ method, body }), box.res, p, new URLSearchParams(q));
    return { status: box.code, body: box.body };
  };
  return { api, dataDir, call };
}

/** 建一局 mock 对局（座位 1 是人类），返回 { id, playerToken, entry, game } */
async function makeGame(call, api) {
  const created = await call('/api/games', {
    method: 'POST',
    body: {
      board: { wolf: 1, seer: 1, witch: 1, villager: 2 },
      players: [{ isHuman: true }, { isHuman: false }, { isHuman: false }, { isHuman: false }, { isHuman: false }],
      mock: true,
    },
  });
  assert.strictEqual(created.status, 200, `前置：建局必须成功：${JSON.stringify(created.body)}`);
  const id = created.body.gameId;
  const entry = api.games.get(id);
  assert.ok(entry && entry.game, '前置：建好的局必须在内存里');
  return { id, playerToken: created.body.playerToken, entry, game: entry.game };
}

/** 取玩家视角视图 */
const viewOf = (call, id, token, after = 0) =>
  call(`/api/games/${id}/view?token=${encodeURIComponent(token)}&after=${after}`);

/** 快照：用来证明"拒绝时没有任何副作用" */
function snapshot(game) {
  return { seq: game.seq, events: game.events.length, pending: game.pending, phase: game.phase, day: game.day };
}
function assertUnchanged(game, before, label) {
  assert.strictEqual(game.seq, before.seq, `${label}：事件 seq 不得前进`);
  assert.strictEqual(game.events.length, before.events, `${label}：不得产生任何新事件`);
  assert.strictEqual(game.pending, before.pending, `${label}：pending 对象（含 id）必须原样保留`);
  assert.strictEqual(game.phase, before.phase, `${label}：阶段不得变化`);
  assert.strictEqual(game.day, before.day, `${label}：天数不得变化`);
}

/** 造一个真实的"引擎正在等待人类发言"的任务：返回 { pendingId, resolvedCount(), value() } */
function hangSpeech(game, seat = 1) {
  const p = game.ask(seat, { task: 'speech' });
  const pendingId = game.pending.id;
  let resolved = 0;
  let value = null;
  p.then((v) => { resolved++; value = v; }, () => {});
  return { pendingId, resolvedCount: () => resolved, value: () => value };
}

/** 等一个微任务队列清空（resolve 的回调是 Promise 链上的，HTTP 响应先回） */
const tick = () => new Promise((r) => setTimeout(r, 0));

test('M2-a ①：view 的 pending 带唯一 pendingId，每次新任务换新值、旧值随任务结束作废', async () => {
  const { api, dataDir, call } = harness();
  try {
    const { id, playerToken, game } = await makeGame(call, api);
    const first = hangSpeech(game);

    const v1 = await viewOf(call, id, playerToken);
    assert.strictEqual(v1.status, 200);
    assert.ok(v1.body.pending, '轮到人类时 view.pending 必须存在');
    assert.strictEqual(v1.body.pending.task, 'speech');
    assert.strictEqual(typeof v1.body.pending.pendingId, 'string', 'pending 必须带 pendingId 字符串');
    assert.match(v1.body.pending.pendingId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      `pendingId 必须是唯一随机串（实测 ${JSON.stringify(v1.body.pending.pendingId)}）`);

    // 上帝视角与别的座位不得多出 pending（既有隔离行为不许被这次改动碰坏）
    const god = await call(`/api/games/${id}/view?token=${encodeURIComponent(godTokenOf(api, id))}&after=0`);
    assert.strictEqual(god.body.pending, null, '上帝视角 pending 仍必须为 null');
    const otherSeat = api.buildView(api.games.get(id), 2, 0);
    assert.strictEqual(otherSeat.pending, null, '不是等待者的座位看不到 pending（更看不到 id）');
    const same = await viewOf(call, id, playerToken, 0);
    assert.strictEqual(same.body.pending.pendingId, first.pendingId, '同一任务期间 id 必须稳定（轮询不得每拍换新）');

    // 任务结束 ⇒ view.pending 变 null（旧 id 就此作废）
    const applied = await call(`/api/games/${id}/action`, {
      method: 'POST', body: { token: playerToken, pendingId: first.pendingId, payload: { text: '我是好人' } },
    });
    assert.strictEqual(applied.status, 200, `正确 id 必须应用成功：${JSON.stringify(applied.body)}`);
    await tick();
    const v2 = await viewOf(call, id, playerToken);
    assert.strictEqual(v2.body.pending, null, '任务被消费后 view.pending 必须为 null（旧 id 作废）');

    // 新任务（同座位同任务）必须换新 id
    const second = hangSpeech(game);
    assert.notStrictEqual(second.pendingId, first.pendingId, '每次新任务必须换新 pendingId');
    const v3 = await viewOf(call, id, playerToken);
    assert.strictEqual(v3.body.pending.pendingId, second.pendingId, 'view 必须下发当前任务的 id');
  } finally {
    await terminateApi(api, dataDir);
  }
});

test('M2-a ②③：正确 id 应用成功；错误/过期 id 409 且无任何副作用（任务仍可带对 id 重试）', async () => {
  const { api, dataDir, call } = harness();
  try {
    const { id, playerToken, game } = await makeGame(call, api);
    const t = hangSpeech(game);
    const before = snapshot(game);

    const stale = await call(`/api/games/${id}/action`, {
      method: 'POST', body: { token: playerToken, pendingId: 'not-the-current-id', payload: { text: '迟到的答案' } },
    });
    assert.strictEqual(stale.status, 409, `过期 id 必须 409，实际 ${stale.status} ${JSON.stringify(stale.body)}`);
    assert.match(stale.body.error, /已过期或已被处理/, '报文必须说明"该操作已过期或已被处理"');
    assert.strictEqual(stale.body.code, 'PENDING_ID_STALE');
    assertUnchanged(game, before, '过期 id 被拒');
    assert.strictEqual(t.resolvedCount(), 0, '被拒的提交不得解析任务');
    const vAfter = await viewOf(call, id, playerToken);
    assert.strictEqual(vAfter.body.pending.pendingId, t.pendingId, '被拒后当前任务与 id 必须完好');

    // 缺失 id（而确实有待处理任务）⇒ 同样拒绝，且同样无副作用
    const missing = await call(`/api/games/${id}/action`, {
      method: 'POST', body: { token: playerToken, payload: { text: '老客户端的答案' } },
    });
    assert.strictEqual(missing.status, 409, `有待处理任务时缺 pendingId 必须 409，实际 ${missing.status}`);
    assert.match(missing.body.error, /已过期或已被处理/, '缺 id 的报文同样要说明过期/已处理');
    assert.strictEqual(missing.body.code, 'PENDING_ID_REQUIRED');
    assertUnchanged(game, before, '缺 id 被拒');
    assert.strictEqual(t.resolvedCount(), 0, '缺 id 的提交不得解析任务');

    // 带对 id ⇒ 成功（证明拒绝没有消耗任务）
    const ok = await call(`/api/games/${id}/action`, {
      method: 'POST', body: { token: playerToken, pendingId: t.pendingId, payload: { text: '正确的答案' } },
    });
    assert.strictEqual(ok.status, 200, `正确 id 必须成功：${JSON.stringify(ok.body)}`);
    await tick();
    assert.strictEqual(t.resolvedCount(), 1, '成功提交必须解析任务一次');
    assert.deepStrictEqual(t.value(), { text: '正确的答案', explode: false, target: 0, withdraw: false, claims: [] });
  } finally {
    await terminateApi(api, dataDir);
  }
});

test('M2-a ③④：上一任务的答案迟到（新任务已在等）⇒ 409 无副作用；同一 action 连发两次只生效一次', async () => {
  const { api, dataDir, call } = harness();
  try {
    const { id, playerToken, game } = await makeGame(call, api);
    const first = hangSpeech(game);
    const body = { token: playerToken, pendingId: first.pendingId, payload: { text: '第一次发言' } };

    const ok = await call(`/api/games/${id}/action`, { method: 'POST', body });
    assert.strictEqual(ok.status, 200, `首次提交必须成功：${JSON.stringify(ok.body)}`);
    await tick();
    assert.strictEqual(first.resolvedCount(), 1, '首次提交解析一次');

    // ④ 同一 action 原样重放：此刻 pending 为空 ⇒ 必须被拒（不是"再应用一次"）
    const afterFirst = snapshot(game);
    const replay = await call(`/api/games/${id}/action`, { method: 'POST', body });
    assert.strictEqual(replay.status, 409, `重放必须被拒，实际 ${replay.status} ${JSON.stringify(replay.body)}`);
    assertUnchanged(game, afterFirst, '重放被拒');
    assert.strictEqual(first.resolvedCount(), 1, '重放绝不许二次执行（解析次数不得变成 2）');

    // ③ 引擎紧接着挂起**同一座位同一任务**的新任务：旧 id 必须失效
    const second = hangSpeech(game);
    assert.notStrictEqual(second.pendingId, first.pendingId, '重挂起的同座位同任务必须换新 id（否则旧答案会被当成新答案）');
    const beforeStale = snapshot(game);
    const staleReplay = await call(`/api/games/${id}/action`, { method: 'POST', body });
    assert.strictEqual(staleReplay.status, 409, `旧 id 打在新任务上必须被拒，实际 ${staleReplay.status}`);
    assert.strictEqual(staleReplay.body.code, 'PENDING_ID_STALE');
    assertUnchanged(game, beforeStale, '旧 id 迟到被拒');
    assert.strictEqual(second.resolvedCount(), 0, '旧 id 不得解析新任务');

    // 新任务仍可正常完成
    const ok2 = await call(`/api/games/${id}/action`, {
      method: 'POST', body: { token: playerToken, pendingId: second.pendingId, payload: { text: '第二次发言' } },
    });
    assert.strictEqual(ok2.status, 200, `新任务带新 id 必须成功：${JSON.stringify(ok2.body)}`);
    await tick();
    assert.strictEqual(second.resolvedCount(), 1);
  } finally {
    await terminateApi(api, dataDir);
  }
});

test('M2-a ⑤⑥：没有 pending 时不因缺 id 而拒绝 —— 报文与加固前逐字一致（老客户端路径）', async () => {
  const { api, dataDir, call } = harness();
  try {
    const { id, playerToken, game } = await makeGame(call, api);
    assert.strictEqual(game.pending, null, '前提：此局面没有等待中的操作');
    const before = snapshot(game);

    const legacy = await call(`/api/games/${id}/action`, { method: 'POST', body: { token: playerToken, payload: {} } });
    assert.strictEqual(legacy.status, 409, '无 pending 时仍是 409');
    assert.strictEqual(legacy.body.error, '当前没有等待中的操作', '这句给正常用户的文案不许变');
    assert.strictEqual(legacy.body.code, undefined, '无 pending 的路径不得出现 pendingId 相关新字段');

    const withId = await call(`/api/games/${id}/action`, {
      method: 'POST', body: { token: playerToken, pendingId: 'whatever', payload: {} },
    });
    assert.deepStrictEqual(withId, legacy, '无 pending 时"带 id"与"不带 id"的响应必须逐字一致（否则错误 id 也成了探针）');
    assertUnchanged(game, before, '无 pending 的提交');

    // 非等待态的老客户端调用：token 错的路径也逐字不变（403，不得被 id 检查截胡）
    const wrongToken = await call(`/api/games/${id}/action`, { method: 'POST', body: { token: 'nope', payload: {} } });
    assert.strictEqual(wrongToken.status, 403, '授权仍先于 id 校验（NEW-11 顺序不许动）');
    assert.strictEqual(wrongToken.body.error, 'token 无效');
  } finally {
    await terminateApi(api, dataDir);
  }
});

test('M2-a 兼容：手工构造的 pending 桩没有 id ⇒ 不做比对放行；非法载荷保留任务与 id 供改正重试', async () => {
  const { api, dataDir, call } = harness();
  try {
    const { id, playerToken, game } = await makeGame(call, api);

    // (a) pending 桩（无 id，只有老测试/内部代码会这么造）⇒ 缺 id 也不得拒绝
    let stubValue = null;
    game.pending = { seat: 1, request: { task: 'speech' }, resolve(v) { stubValue = v; }, reject() {} };
    const stub = await call(`/api/games/${id}/action`, {
      method: 'POST', body: { token: playerToken, payload: { text: '桩也能提交' } },
    });
    assert.strictEqual(stub.status, 200, `无 id 的 pending 桩必须退回旧行为放行：${JSON.stringify(stub.body)}`);
    assert.deepStrictEqual(stubValue, { text: '桩也能提交', explode: false, target: 0, withdraw: false, claims: [] });
    assert.strictEqual(game.pending, null, '成功提交后 pending 被消费');

    // (b) 真实任务 + 正确 id + 非法载荷 ⇒ 400，任务与 id 都保留（同一 id 可改正重试）
    const t = hangSpeech(game);
    const bad = await call(`/api/games/${id}/action`, {
      method: 'POST', body: { token: playerToken, pendingId: t.pendingId, payload: { text: '   ' } },
    });
    assert.strictEqual(bad.status, 400, `非法载荷必须 400，实际 ${bad.status} ${JSON.stringify(bad.body)}`);
    assert.match(bad.body.error, /不能为空/);
    assert.strictEqual(game.pending && game.pending.id, t.pendingId, '校验失败不得作废 id（要能让用户改正后重试）');
    assert.strictEqual(t.resolvedCount(), 0);
    const fixed = await call(`/api/games/${id}/action`, {
      method: 'POST', body: { token: playerToken, pendingId: t.pendingId, payload: { text: '改正后的发言' } },
    });
    assert.strictEqual(fixed.status, 200, `同一个 id 改正后必须能提交：${JSON.stringify(fixed.body)}`);

    // (c) payload 里的 pendingId 别名同样可用（后续客户端批次两处都能放，顶层优先）
    const t2 = hangSpeech(game);
    const alias = await call(`/api/games/${id}/action`, {
      method: 'POST', body: { token: playerToken, payload: { text: '别名提交', pendingId: t2.pendingId } },
    });
    assert.strictEqual(alias.status, 200, `payload.pendingId 别名必须可用：${JSON.stringify(alias.body)}`);
    const aliasWrong = hangSpeech(game);
    const aliasBad = await call(`/api/games/${id}/action`, {
      method: 'POST', body: { token: playerToken, payload: { text: '过期别名', pendingId: 'stale' } },
    });
    assert.strictEqual(aliasBad.status, 409, '别名里的过期 id 同样必须被拒');
    assert.strictEqual(aliasBad.body.code, 'PENDING_ID_STALE');
    assert.strictEqual(game.pending && game.pending.id, aliasWrong.pendingId, '被拒后任务与 id 完好');
  } finally {
    await terminateApi(api, dataDir);
  }
});

test('M2-a 指纹：同座位同任务的新 pending（新 id）必须改变 SSE 廉价指纹与推帧指纹', async () => {
  const { api, dataDir, call } = harness();
  try {
    const { id, playerToken, game } = await makeGame(call, api);
    const first = hangSpeech(game);
    const cheap1 = api.cheapSignature(api.games.get(id), 1);
    const view1 = api.buildView(api.games.get(id), 1, 0);
    const sig1 = api.streamSignature(api.games.get(id), 1, view1);

    // 消费掉，再挂起同座位同任务的新任务 —— 除了 id，廉价指纹看的其它字段全都相同
    await call(`/api/games/${id}/action`, {
      method: 'POST', body: { token: playerToken, pendingId: first.pendingId, payload: { text: '占位发言' } },
    });
    await tick();
    const second = hangSpeech(game);
    const cheap2 = api.cheapSignature(api.games.get(id), 1);
    const view2 = api.buildView(api.games.get(id), 1, 0);
    const sig2 = api.streamSignature(api.games.get(id), 1, view2);

    assert.notStrictEqual(cheap2, cheap1, '新任务的 id 必须进廉价指纹，否则 SSE 不会推新 pendingId 那一帧');
    assert.notStrictEqual(sig2, sig1, '新任务的 id 必须进推帧指纹，否则客户端永远拿不到新 id（发言会被 409 卡死）');
    assert.notStrictEqual(second.pendingId, first.pendingId);
  } finally {
    await terminateApi(api, dataDir);
  }
});

/** 上帝 token（测试内部用；从 Api 的对局条目取） */
function godTokenOf(api, id) {
  return api.games.get(id).tokens.god;
}
