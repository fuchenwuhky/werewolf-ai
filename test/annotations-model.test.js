/**
 * annotations-model.test.js — 浏览器端共享标注模型（NOTE-01/05 回归）
 * 重点：mergeLegacyTags 旧标注 → 新存储的逐座位合并语义（审核 P1-1 升级迁移测试）。
 * 同一份实现被桌面 app.js 与手机 m.js 引用，这里在 Node 下直接断言行为。
 * 契约：返回 { fill, pending }；无法无损容纳时进 pending（调用方保留本地记录+提示确认），
 * 绝不靠截断原备注腾位置（复审 P1-1）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const M = require('../web/shared/annotations-model');

const roleOf = (rid) => ({
  wolf: { team: 'wolf', name: '狼人' }, wolfking: { team: 'wolf', name: '狼王' },
  seer: { team: 'good', name: '预言家' }, villager: { team: 'good', name: '平民' },
}[rid] || null);

const fullNote = 'x'.repeat(M.MAX_NOTE); // 200 字满备注

test('迁移：新座位整条转换（倾向按阵营，候选 [roleId]）', () => {
  const { fill, pending } = M.mergeLegacyTags({}, { 5: 'wolf', 6: 'seer' }, roleOf);
  assert.deepStrictEqual(pending, {}, '新座位永远无损');
  assert.strictEqual(fill[5].leaning, 'lean_wolf');
  assert.deepStrictEqual(fill[5].candidateRoleIds, ['wolf']);
  assert.strictEqual(fill[5].confidence, 'low');
  assert.strictEqual(fill[6].leaning, 'lean_good');
  assert.match(fill[6].note, /旧版身份标记/);
});

test('迁移：同座位冲突——服务端标"预言家"，本地旧标"狼人"→ 双方候选都保留（审核场景）', () => {
  const server = { 1: M.normalizeSeatAnnotation({ candidateRoleIds: ['seer'], leaning: 'lean_good', confidence: 'medium', note: '跳预言家' }) };
  const { fill, pending } = M.mergeLegacyTags(server, { 1: 'wolf' }, roleOf);
  assert.deepStrictEqual(pending, {});
  assert.ok(fill[1], '同座位冲突必须产出合并结果，不能跳过');
  assert.ok(fill[1].candidateRoleIds.includes('seer'), '服务端原候选保留');
  assert.ok(fill[1].candidateRoleIds.includes('wolf'), '本地旧身份并入候选');
  assert.strictEqual(fill[1].note, '跳预言家', '并入候选时备注一字不动（无截断风险）');
});

test('迁移：3 候选＋200 字备注 → pending，本地记录保留，原备注零截断（复审 P1-1 端到端回归）', () => {
  const server = { 7: M.normalizeSeatAnnotation({ candidateRoleIds: ['wolfking', 'seer', 'villager'], confidence: 'high', note: fullNote }) };
  const before = server[7].note;
  const { fill, pending } = M.mergeLegacyTags(server, { 7: 'wolf' }, roleOf);
  assert.deepStrictEqual(fill, {}, '无法无损容纳时绝不写 fill');
  assert.deepStrictEqual(pending, { 7: 'wolf' }, '座位进入待确认记录（调用方据此保留本地 key 并提示）');
  assert.strictEqual(server[7].note, before, '入参对象不得被修改，更不得被截断');
});

test('迁移：3 候选＋备注放得下 → 无损追加备注（原文完整保留在前）', () => {
  const server = { 8: M.normalizeSeatAnnotation({ candidateRoleIds: ['wolfking', 'seer', 'villager'], note: '三者之一，依据第9条发言' }) };
  const { fill, pending } = M.mergeLegacyTags(server, { 8: 'wolf' }, roleOf);
  assert.deepStrictEqual(pending, {});
  assert.ok(fill[8], '备注放得下必须写入');
  assert.ok(fill[8].note.startsWith('三者之一，依据第9条发言；旧标记：狼人'), '原文完整在前，标记追加在后');
  assert.ok(fill[8].note.length <= M.MAX_NOTE);
  assert.deepStrictEqual(fill[8].candidateRoleIds, ['wolfking', 'seer', 'villager'], '候选不动');
});

test('迁移：旧身份已在服务端候选/自称 → 无需变更；重复迁移幂等', () => {
  const server = {
    3: M.normalizeSeatAnnotation({ candidateRoleIds: ['wolf'] }),
    4: M.normalizeSeatAnnotation({ claimedRoleId: 'seer', candidateRoleIds: [] }),
  };
  assert.deepStrictEqual(M.mergeLegacyTags(server, { 3: 'wolf' }, roleOf), { fill: {}, pending: {} }, '候选已含 → 不写');
  assert.deepStrictEqual(M.mergeLegacyTags(server, { 4: 'seer' }, roleOf), { fill: {}, pending: {} }, '自称已含 → 不写');
  // 幂等：把合并结果当作"服务端现状"再合并一次 → 无新增
  const once = M.mergeLegacyTags({}, { 5: 'wolf' }, roleOf);
  const twice = M.mergeLegacyTags({ 5: once.fill[5] }, { 5: 'wolf' }, roleOf);
  assert.deepStrictEqual(twice, { fill: {}, pending: {} }, '同一旧数据迁移两次不得重复追加');
});

test('迁移：混合场景一次完成（冲突座位 + 新座位 + 满座位 pending）', () => {
  const server = {
    1: M.normalizeSeatAnnotation({ candidateRoleIds: ['seer'], leaning: 'lean_good' }),
    9: M.normalizeSeatAnnotation({ candidateRoleIds: ['wolfking', 'seer', 'villager'], note: fullNote }),
  };
  const { fill, pending } = M.mergeLegacyTags(server, { 1: 'wolf', 2: 'wolfking', 9: 'wolf' }, roleOf);
  assert.deepStrictEqual(Object.keys(fill).sort(), ['1', '2'], '座位1冲突合并、座位2新转换');
  assert.deepStrictEqual(pending, { 9: 'wolf' }, '满座位进 pending');
  assert.ok(fill[1].candidateRoleIds.includes('wolf'), '冲突座位合并');
  assert.strictEqual(fill[2].leaning, 'lean_wolf', '新座位转换');
});
