/**
 * m2d-prefs-queue.test.js — 偏好写入的串行 / 合并 / 409 恢复（计划书 §5.3）
 *
 * 注入假的 patch / reload，逐条钉住：
 *   · 同一轮同步提交的多次改动**合并成一个批次**（发一次请求，且中间那次的值没丢）；
 *   · **串行**：上一批 settle 之前不会发下一批（同一档案同一时刻只有一次在途）；
 *   · 409 → 重读服务端版本 → **无冲突字段合并后重试一次**；同字段冲突保留草稿交回调用方；
 *   · **二次 409 不再重试**，草稿仍在；
 *   · 不同档案各自一条队列，互不阻塞。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../web/shared/prefs-queue');

/** 一个可手动放行的 Promise（用来把"在途"这一瞬间固定住） */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 等微任务/宏任务都跑一遍（队列的合并窗口是微任务） */
const tick = () => new Promise((r) => setImmediate(r));

function fakeServer(initial) {
  const state = {
    prefs: Object.assign({ fontScale: 1, layout: 'reading', reducedMotion: false }, initial || {}),
    revision: 1,
    patchCalls: [],
    reloadCalls: 0,
  };
  return {
    state,
    patch(profileId, preferences, ctx) {
      state.patchCalls.push({ profileId, preferences: JSON.parse(JSON.stringify(preferences)), expectedRevision: ctx.expectedRevision });
      state.prefs = preferences;
      state.revision += 1;
      return Promise.resolve({ profile: { id: profileId, preferences: state.prefs, revision: state.revision } });
    },
    reload(profileId) {
      state.reloadCalls += 1;
      return Promise.resolve({ id: profileId, preferences: state.prefs, revision: state.revision });
    },
  };
}

test('串行 + 合并：一轮同步的 3 次改动只发 1 次请求，且中间那次的字段没被丢掉', async () => {
  const srv = fakeServer();
  const q = Q.createPrefsQueue({ patch: srv.patch, reload: srv.reload, baseOf: () => srv.state.prefs });
  const out = await Promise.all([
    q.submit('p1', { fontScale: 1.2 }),
    q.submit('p1', { layout: 'compact' }),
    q.submit('p1', { fontScale: 0.9 }),
  ]);
  assert.strictEqual(srv.state.patchCalls.length, 1, '合并成一批：只发 1 次');
  assert.deepStrictEqual(srv.state.patchCalls[0].preferences,
    { fontScale: 0.9, layout: 'compact', reducedMotion: false }, '合并结果：同字段取最后一次，中间字段保住');
  assert.deepStrictEqual(out.map((o) => o.status), ['saved', 'saved', 'saved']);
  assert.deepStrictEqual(q.pendingOf('p1'), {}, '发完队列里没有残留');
});

test('串行：上一批还没 settle 时不会发下一批（同一档案只有一次在途）', async () => {
  const gate = deferred();
  const calls = [];
  let n = 0;
  const q = Q.createPrefsQueue({
    baseOf: () => ({ fontScale: 1, layout: 'reading', reducedMotion: false }),
    patch: (pid, prefs) => {
      calls.push(JSON.parse(JSON.stringify(prefs)));
      n += 1;
      if (n === 1) return gate.promise.then(() => ({ profile: { preferences: prefs, revision: 2 } }));
      return Promise.resolve({ profile: { preferences: prefs, revision: n + 1 } });
    },
    reload: () => Promise.resolve({ preferences: {}, revision: 9 }),
  });
  const first = q.submit('p1', { fontScale: 1.2 });
  await tick();
  assert.strictEqual(calls.length, 1, '第一批已经发出');
  const second = q.submit('p1', { layout: 'compact' });
  await tick();
  assert.strictEqual(calls.length, 1, '第一批未 settle：第二批必须排队，不许并发发出');
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.strictEqual(calls.length, 2, '第一批 settle 后才发第二批');
  assert.strictEqual(a.status, 'saved');
  assert.strictEqual(b.status, 'saved');
  assert.deepStrictEqual(calls[1], { fontScale: 1.2, layout: 'compact', reducedMotion: false });
});

test('409：重读服务端版本 → 无冲突字段合并后重试一次；同字段冲突保留草稿', async () => {
  const calls = [];
  let reloads = 0;
  let attempt = 0;
  const q = Q.createPrefsQueue({
    // 本端改动所基于的版本：layout 是 'reading'，fontScale 已被别的窗口改成 1.5
    baseOf: () => ({ fontScale: 1, layout: 'reading', reducedMotion: false }),
    patch: (pid, prefs, ctx) => {
      attempt += 1;
      calls.push({ prefs: JSON.parse(JSON.stringify(prefs)), expectedRevision: ctx.expectedRevision, retried: ctx.retried });
      if (attempt === 1) {
        const e = new Error('版本冲突');
        e.status = 409;
        return Promise.reject(e);
      }
      return Promise.resolve({ profile: { preferences: prefs, revision: 7 } });
    },
    reload: () => {
      reloads += 1;
      // 服务端此刻：fontScale 被另一个窗口改成了 1.5（与本地要写的 0.9 同字段冲突），layout 没动
      return Promise.resolve({ preferences: { fontScale: 1.5, layout: 'reading', reducedMotion: false }, revision: 6 });
    },
  });
  const out = await q.submit('p1', { fontScale: 0.9, layout: 'compact' });
  assert.strictEqual(calls.length, 2, '恰好重试一次（首发 + 一次重试）');
  assert.strictEqual(reloads, 1, '恰好重读一次服务端版本');
  assert.strictEqual(calls[1].expectedRevision, 6, '重试用的是重读回来的 revision');
  assert.strictEqual(calls[1].prefs.fontScale, 1.5, '同字段冲突：不拿本地值覆盖服务端的 1.5');
  assert.strictEqual(calls[1].prefs.layout, 'compact', '无冲突字段：本地值照写');
  assert.strictEqual(out.status, 'conflict', '有同字段冲突 ⇒ 状态是 conflict（交回用户选择）');
  assert.deepStrictEqual(out.conflict, { fontScale: { local: 0.9, server: 1.5 } });
  assert.deepStrictEqual(out.draft, { fontScale: 0.9 }, '冲突字段保留为草稿');
  assert.deepStrictEqual(q.pendingOf('p1'), { fontScale: 0.9 }, '草稿真的还在队列里（不是只在返回值里）');
});

test('二次 409：不再重试，且草稿仍然保留（不许悄悄丢掉用户改的内容）', async () => {
  let patches = 0;
  let reloads = 0;
  const q = Q.createPrefsQueue({
    baseOf: () => ({ fontScale: 1, layout: 'reading', reducedMotion: false }),
    patch: () => {
      patches += 1;
      const e = new Error('版本冲突');
      e.status = 409;
      return Promise.reject(e);
    },
    reload: () => {
      reloads += 1;
      return Promise.resolve({ preferences: { fontScale: 1.5, layout: 'reading', reducedMotion: false }, revision: 6 });
    },
  });
  const out = await q.submit('p1', { fontScale: 0.9, layout: 'compact' });
  assert.strictEqual(patches, 2, '首发 1 次 + 重试 1 次 = 2 次，第二次 409 后不再重试');
  assert.strictEqual(reloads, 1, '一个批次只重读一次服务端版本（"重读 → 重试一次"是成对的）');
  assert.strictEqual(out.status, 'conflict');
  assert.deepStrictEqual(out.draft, { fontScale: 0.9, layout: 'compact' }, '两次都没写进去 ⇒ 两项都要留在草稿里');
  assert.deepStrictEqual(q.pendingOf('p1'), { fontScale: 0.9, layout: 'compact' });
});

test('全部字段都是同字段冲突：没有"无冲突字段"可重试，直接保留草稿交回用户选择', async () => {
  let patches = 0;
  const q = Q.createPrefsQueue({
    baseOf: () => ({ fontScale: 1, layout: 'reading', reducedMotion: false }),
    patch: () => { patches += 1; const e = new Error('冲突'); e.status = 409; return Promise.reject(e); },
    reload: () => Promise.resolve({ preferences: { fontScale: 1.5, layout: 'compact', reducedMotion: true }, revision: 6 }),
  });
  const out = await q.submit('p1', { fontScale: 0.9, layout: 'reading' });
  assert.strictEqual(patches, 1, '两个字段都被另一边改过 ⇒ 没有无冲突字段，不发起"空重试"');
  assert.strictEqual(out.status, 'conflict');
  assert.deepStrictEqual(out.conflict, {
    fontScale: { local: 0.9, server: 1.5 },
    layout: { local: 'reading', server: 'compact' },
  }, '两边都在同一个字段上写了不同的值 ⇒ 两个字段都是同字段冲突');
  assert.deepStrictEqual(out.draft, { fontScale: 0.9, layout: 'reading' }, '本地想写的值全都留在草稿里');
  assert.deepStrictEqual(q.pendingOf('p1'), { fontScale: 0.9, layout: 'reading' });
});

test('服务端恰好也改成了同一个值 ⇒ 不算同字段冲突', async () => {
  const q = Q.createPrefsQueue({
    baseOf: () => ({ fontScale: 1 }),
    patch: (pid, prefs, ctx) => {
      if (!ctx.retried) { const e = new Error('冲突'); e.status = 409; return Promise.reject(e); }
      return Promise.resolve({ profile: { preferences: prefs, revision: 8 } });
    },
    reload: () => Promise.resolve({ preferences: { fontScale: 1.2 }, revision: 7 }),
  });
  const out = await q.submit('p1', { fontScale: 1.2 });
  assert.strictEqual(out.status, 'saved');
  assert.deepStrictEqual(out.draft, {});
  assert.deepStrictEqual(out.conflict, {});
});

test('非 409 失败：状态 error，改动仍留在队列里（草稿不丢），不重试', async () => {
  let patches = 0;
  const q = Q.createPrefsQueue({
    baseOf: () => ({}),
    patch: () => { patches += 1; return Promise.reject(new Error('离线')); },
    reload: () => { throw new Error('不该走到重读'); },
  });
  const out = await q.submit('p1', { layout: 'compact' });
  assert.strictEqual(out.status, 'error');
  assert.strictEqual(patches, 1, '非 409 不重试');
  assert.strictEqual(out.error.message, '离线');
  assert.deepStrictEqual(out.draft, { layout: 'compact' });
  assert.deepStrictEqual(q.pendingOf('p1'), { layout: 'compact' });
});

test('不同档案各自一条队列：A 的在途请求不阻塞 B 的保存', async () => {
  const gate = deferred();
  const order = [];
  const q = Q.createPrefsQueue({
    baseOf: () => ({}),
    patch: (pid, prefs) => {
      order.push(pid);
      if (pid === 'A') return gate.promise.then(() => ({ profile: { preferences: prefs, revision: 2 } }));
      return Promise.resolve({ profile: { preferences: prefs, revision: 2 } });
    },
    reload: () => Promise.resolve({ preferences: {}, revision: 1 }),
  });
  const a = q.submit('A', { fontScale: 1.2 });
  await tick();
  const b = q.submit('B', { fontScale: 0.9 });
  const outB = await b;
  assert.strictEqual(outB.status, 'saved', 'B 不必等 A 在途的请求');
  assert.deepStrictEqual(order, ['A', 'B']);
  gate.resolve();
  assert.strictEqual((await a).status, 'saved');
});

test('队列自身：缺 patch/reload 直接抛（不静默变成"什么都不发"）', () => {
  assert.throws(() => Q.createPrefsQueue({ reload: () => {} }), /cfg\.patch/);
  assert.throws(() => Q.createPrefsQueue({ patch: () => {} }), /cfg\.reload/);
});

test('splitConflicts 纯函数：以 base 为判据（服务端相对 base 变了 + 本地也改了 + 值不同）', () => {
  const { safe, conflict } = Q.splitConflicts(
    { a: 1, b: 2 },
    { a: 9, b: 2 },
    { a: 5, b: 7, c: 3 },
  );
  assert.deepStrictEqual(safe, { b: 7, c: 3 }, 'b 服务端没动、c 是新增字段 ⇒ 无冲突');
  assert.deepStrictEqual(conflict, { a: { local: 5, server: 9 } });
});
