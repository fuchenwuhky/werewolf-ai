/**
 * m2d-request-guard.test.js — 异步请求的档案绑定与**代次**（计划书 §5.2 / §5.3）
 *
 * 要证明的两件事：
 *   · 切档后，切档**之前**发出的请求回来时不得写当前页面（迟到响应被丢弃）；
 *   · **A → B → A** 之后，旧 A 票据照样作废（这正是"只比对档案 id"挡不住的那一类）；
 *   · 同一档案期间的并发请求**不能**被误杀（玩家中心五路并发取数就是这种）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../web/shared/request-guard');

test('迟到响应不得覆盖新档案页面：A 的票据在切到 B 之后作废', () => {
  const guard = G.createRequestGuard({ profileId: 'A' });
  const ticket = guard.begin();          // 发起时绑定 A
  const page = { profileId: 'A', html: '<A 的旧页面>' };
  guard.setCurrent('B');                 // 用户切到 B，页面重画
  page.profileId = 'B';
  page.html = '<B 的新页面>';
  const r = guard.settle(ticket, () => { page.html = '<迟到的 A 数据>'; });
  assert.strictEqual(r.applied, false, '迟到响应必须被丢弃');
  assert.strictEqual(page.html, '<B 的新页面>', '新档案的页面没有被覆盖');
});

test('A → B → A：旧的 A 票据仍然作废（代次的作用，不能只比 profileId）', () => {
  const guard = G.createRequestGuard({ profileId: 'A' });
  const oldTicket = guard.begin();
  guard.setCurrent('B');
  guard.setCurrent('A');                 // 转了一圈又回到 A
  assert.strictEqual(guard.current().profileId, 'A', '当前档案确实又是 A');
  assert.strictEqual(guard.isCurrent(oldTicket), false, '但代次变了 ⇒ 旧票据不许再写页面');
  const fresh = guard.begin();
  assert.strictEqual(guard.isCurrent(fresh), true, '回到 A 之后新取的票据有效');
});

test('同一档案期间的并发请求不被误杀（同档案 setCurrent 不换代）', () => {
  const guard = G.createRequestGuard({ profileId: 'A' });
  const t1 = guard.begin();
  const t2 = guard.begin();
  guard.setCurrent('A');                 // 再次落地同一个档案（例如 storage 事件重复触发）
  assert.strictEqual(guard.isCurrent(t1), true);
  assert.strictEqual(guard.isCurrent(t2), true);
});

test('票据绑定"发起时"的档案：显式传 A 之后即使当前档案是 B 也不冒充当前', () => {
  const guard = G.createRequestGuard({ profileId: 'B' });
  const t = guard.begin('A');
  assert.deepStrictEqual({ profileId: t.profileId }, { profileId: 'A' });
  assert.strictEqual(guard.isCurrent(t), false);
  assert.strictEqual(guard.settle(t, () => 'x').applied, false);
  assert.strictEqual(guard.settle(null, () => 'x').applied, false, 'null/undefined 票据一律不执行');
});

test('settle 只在票据有效时执行落笔动作，并把返回值交回调用方', () => {
  const guard = G.createRequestGuard({ profileId: 'A' });
  const t = guard.begin();
  let ran = 0;
  const ok = guard.settle(t, () => { ran += 1; return 42; });
  assert.deepStrictEqual(ok, { applied: true, value: 42 });
  assert.strictEqual(ran, 1);
});

test('票据带单调序号：同一代次里的多张票据可以区分（诊断用），但有效性判据只有 profileId + 代次', () => {
  const guard = G.createRequestGuard({ profileId: 'A' });
  const a = guard.begin();
  const b = guard.begin();
  assert.strictEqual(b.seq > a.seq, true, '序号单调递增');
  assert.strictEqual(guard.isCurrent(a), true);
  assert.strictEqual(guard.isCurrent(b), true);
});
