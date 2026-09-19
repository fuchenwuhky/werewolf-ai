/**
 * annotations-model.test.js — 浏览器端共享标注模型（NOTE-01/05 回归）
 * 重点：mergeLegacyTags 旧标注 → 新存储的逐座位合并语义（审核 P1-1 升级迁移测试）。
 * 同一份实现被桌面 app.js 与手机 m.js 引用，这里在 Node 下直接断言行为。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const M = require('../web/shared/annotations-model');

const roleOf = (rid) => ({
  wolf: { team: 'wolf', name: '狼人' }, wolfking: { team: 'wolf', name: '狼王' },
  seer: { team: 'good', name: '预言家' }, villager: { team: 'good', name: '平民' },
}[rid] || null);

test('迁移：新座位整条转换（倾向按阵营，候选 [roleId]）', () => {
  const fill = M.mergeLegacyTags({}, { 5: 'wolf', 6: 'seer' }, roleOf);
  assert.strictEqual(fill[5].leaning, 'lean_wolf');
  assert.deepStrictEqual(fill[5].candidateRoleIds, ['wolf']);
  assert.strictEqual(fill[5].confidence, 'low');
  assert.strictEqual(fill[6].leaning, 'lean_good');
  assert.match(fill[6].note, /旧版身份标记/);
});

test('迁移：同座位冲突——服务端标"预言家"，本地旧标"狼人"→ 双方候选都保留（审核场景）', () => {
  const server = { 1: M.normalizeSeatAnnotation({ candidateRoleIds: ['seer'], leaning: 'lean_good', confidence: 'medium', note: '跳预言家' }) };
  const fill = M.mergeLegacyTags(server, { 1: 'wolf' }, roleOf);
  assert.ok(fill[1], '同座位冲突必须产出合并结果，不能跳过');
  const merged = fill[1];
  assert.ok(merged.candidateRoleIds.includes('seer'), '服务端原候选保留');
  assert.ok(merged.candidateRoleIds.includes('wolf'), '本地旧身份并入候选');
  assert.match(merged.note, /跳预言家/, '原备注保留');
});

test('迁移：候选已满 3 个——旧身份降级写进备注，信息不丢', () => {
  const server = { 2: M.normalizeSeatAnnotation({ candidateRoleIds: ['wolf', 'wolfking', 'seer'], note: '三者之一' }) };
  const fill = M.mergeLegacyTags(server, { 2: 'villager' }, roleOf);
  assert.ok(fill[2], '满候选也必须产出合并结果');
  assert.deepStrictEqual(fill[2].candidateRoleIds, ['wolf', 'wolfking', 'seer'], '候选不动');
  assert.match(fill[2].note, /旧标记：平民/, '旧身份记录在备注');
  assert.match(fill[2].note, /三者之一/, '原备注保留');
});

test('迁移：旧身份已在服务端候选/自称 → 无需变更；重复迁移幂等', () => {
  const server = {
    3: M.normalizeSeatAnnotation({ candidateRoleIds: ['wolf'] }),
    4: M.normalizeSeatAnnotation({ claimedRoleId: 'seer', candidateRoleIds: [] }),
  };
  assert.deepStrictEqual(M.mergeLegacyTags(server, { 3: 'wolf' }, roleOf), {}, '候选已含 → 不写');
  assert.deepStrictEqual(M.mergeLegacyTags(server, { 4: 'seer' }, roleOf), {}, '自称已含 → 不写');
  // 幂等：把合并结果当作"服务端现状"再合并一次 → 无新增
  const once = M.mergeLegacyTags({}, { 5: 'wolf' }, roleOf);
  const twice = M.mergeLegacyTags({ 5: once[5] }, { 5: 'wolf' }, roleOf);
  assert.deepStrictEqual(twice, {}, '同一旧数据迁移两次不得重复追加');
});

test('迁移：混合场景一次完成（新座位 + 冲突座位 + 已知座位）', () => {
  const server = { 1: M.normalizeSeatAnnotation({ candidateRoleIds: ['seer'], leaning: 'lean_good' }) };
  const fill = M.mergeLegacyTags(server, { 1: 'wolf', 2: 'wolfking', 3: 'wolf' }, roleOf);
  assert.deepStrictEqual(Object.keys(fill).sort(), ['1', '2', '3'], '座位1冲突合并，座位2/3新转换');
  assert.ok(fill[1].candidateRoleIds.includes('wolf'), '冲突座位合并');
  assert.strictEqual(fill[2].leaning, 'lean_wolf', '新座位转换');
  assert.strictEqual(fill[3].leaning, 'lean_wolf', '新座位转换');
});
