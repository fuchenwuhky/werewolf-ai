/**
 * annotations.test.js — 私人标注存储（NOTE-01/02 回归）
 * 覆盖：白名单清洗、revision 409、多座位隔离、持久化、归属字段校验、AI 不可见（静态）
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AnnotationStore, normalizeSeatAnnotation } = require('../src/annotations/store');
const { cleanupAfter } = require('./helpers-tmpdir');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {} };
const PID = '11111111-2222-3333-4444-555555555555';
const GID = 'game-n1';

function makeStore(dir) {
  return new AnnotationStore({ profilesRoot: path.join(dir, 'profiles'), logger: silentLogger });
}

test('清洗：leaning 白名单、候选截断 3 个、note 截断 200、非法类型收敛', () => {
  const n = normalizeSeatAnnotation({
    leaning: 'lean_wolf',
    candidateRoleIds: ['wolf', 'wolfking', 'seer', 'witch', 42, 'x'],
    claimedRoleId: 'seer',
    confidence: 'high',
    note: 'n'.repeat(300),
    evidenceSeq: 45,
    day: 2, phase: 'speech',
    hackerField: 'drop me',
  });
  assert.strictEqual(n.leaning, 'lean_wolf');
  assert.deepStrictEqual(n.candidateRoleIds, ['wolf', 'wolfking', 'seer'], '候选最多 3 个且只收合法 id');
  assert.strictEqual(n.claimedRoleId, 'seer');
  assert.strictEqual(n.confidence, 'high');
  assert.strictEqual(n.note.length, 200);
  assert.strictEqual(n.evidenceSeq, 45);
  assert.strictEqual(n.hackerField, undefined, '未知字段必须丢弃');
  // 非法值回落默认
  const bad = normalizeSeatAnnotation({ leaning: 'ultra', confidence: 'mega', candidateRoleIds: 'wolf' });
  assert.strictEqual(bad.leaning, 'neutral');
  assert.strictEqual(bad.confidence, 'low');
  assert.deepStrictEqual(bad.candidateRoleIds, []);
});

test('持久化：保存→重读一致；revision 递增；409 冲突', async (t) => {
  const dir = cleanupAfter(t, fs.mkdtempSync(path.join(os.tmpdir(), 'ann-')));
  const store = makeStore(dir);
  const r1 = await store.put({ profileId: PID, gameId: GID, expectedRevision: 0, seats: { 7: { leaning: 'lean_wolf', note: '带节奏', day: 1, phase: 'speech' } } });
  assert.strictEqual(r1.revision, 1);
  const got = store.get(PID, GID);
  assert.strictEqual(got.seats[7].leaning, 'lean_wolf');
  assert.strictEqual(got.seats[7].note, '带节奏');
  assert.strictEqual(got.profileId, PID);
  assert.strictEqual(got.gameId, GID);

  // 409：过期 revision（当前 revision=1，拿 0 来写必须拒）。
  // FIX-14：写入入口只有入队的 put()（putSync 已删除，见 annotations-store-contract.test.js）。
  await assert.rejects(
    () => store.put({ profileId: PID, gameId: GID, expectedRevision: 0, seats: { 7: { leaning: 'neutral' } } }),
    (e) => e.code === 409,
  );
  // 正确 revision → 更新
  const r2 = await store.put({ profileId: PID, gameId: GID, expectedRevision: 1, seats: { 7: { leaning: 'neutral', note: '改主意' } } });
  assert.strictEqual(r2.revision, 2);
  const got2 = store.get(PID, GID);
  assert.strictEqual(got2.seats[7].note, '改主意');
});

test('多座位隔离与清除：seat 互不影响', async (t) => {
  const dir = cleanupAfter(t, fs.mkdtempSync(path.join(os.tmpdir(), 'ann2-')));
  const store = makeStore(dir);
  await store.put({ profileId: PID, gameId: 'gm', seats: { 3: { leaning: 'lean_good' }, 5: { leaning: 'lean_wolf' } } });
  const d1 = store.get(PID, 'gm');
  assert.strictEqual(d1.seats[3].leaning, 'lean_good');
  assert.strictEqual(d1.seats[5].leaning, 'lean_wolf');
  await store.clearSeat({ profileId: PID, gameId: 'gm', seat: 3 });
  const d2 = store.get(PID, 'gm');
  assert.strictEqual(d2.seats[3], undefined);
  assert.strictEqual(d2.seats[5].leaning, 'lean_wolf');
});

test('归属与路径安全：非法 profileId/gameId 拒绝拼接', (t) => {
  const dir = cleanupAfter(t, fs.mkdtempSync(path.join(os.tmpdir(), 'ann3-')));
  const store = makeStore(dir);
  assert.throws(() => store.file('../../etc', 'x'), Error, 'profileId 路径穿越必须拒绝');
  assert.throws(() => store.file(PID, '../..'), Error, 'gameId 路径穿越必须拒绝');
});

test('AI 不可见（静态审计）：标注实现不得被引擎/AI 模块引用', () => {
  const root = path.join(__dirname, '..');
  for (const f of ['src/engine/game.js', 'src/engine/flow.js', 'src/ai/agent.js', 'src/ai/prompts.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!src.includes('annotations'), `${f} 不得引用私人标注模块`);
    assert.ok(!src.includes('AnnotationStore'), `${f} 不得引用标注存储`);
  }
});

test('并发：异步 put 的读-校验-写在锁内完成，两次 expectedRevision:0 并发只成功一次（审核 P2-6）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-race-'));
  try {
    const store = makeStore(dir);
    const p1 = store.put({ profileId: PID, gameId: GID, expectedRevision: 0, seats: { 1: { leaning: 'lean_wolf', note: '第一份' } } });
    const p2 = store.put({ profileId: PID, gameId: GID, expectedRevision: 0, seats: { 2: { leaning: 'lean_good', note: '第二份' } } });
    const results = await Promise.allSettled([p1, p2]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const conflict = results.filter((r) => r.status === 'rejected' && /另一窗口/.test(String(r.reason && r.reason.message)));
    assert.strictEqual(ok.length, 1, `并发同版本写入必须恰好成功一次（实际 ${ok.length}）`);
    assert.strictEqual(conflict.length, 1, `落选者必须收到 409 语义冲突（实际 ${results.map((r) => r.status + ':' + (r.reason && r.reason.message)).join(' | ')}）`);
    const doc = store.get(PID, GID);
    assert.strictEqual(doc.revision, 1, 'revision 只应前进 1');
    // 赢家写入的座位在，输家的座位绝不能出现（旧实现后者整份覆盖前者 → 第一份丢失）
    const winner = ok[0].value.seats;
    assert.ok(Object.keys(doc.seats).length >= 1, '至少保留赢家写入的座位');
    assert.deepStrictEqual(Object.keys(doc.seats), Object.keys(winner), '最终座位集必须与赢家写入一致');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
