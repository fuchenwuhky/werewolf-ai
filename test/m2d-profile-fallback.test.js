/**
 * m2d-profile-fallback.test.js — 计划书 §5.1 的**四级回退**（M2-d 客户端批次）
 *
 * 「本地保存且仍有效 → 服务端**最近使用**（lastUsedAt 最大且未归档）→ **有效**默认档案 → 其余可用」
 * 另含 §5.3 的昵称/简介上限与"长昵称省略展示、详情可读完整"。
 *
 * 为什么单独一个文件而不是塞进 test/profile-state.test.js：那个文件的既有夹具**没有**
 * lastUsedAt、且 defaultProfileId='srv' 不在列表里 —— 它的五条期望在四级回退下仍然成立
 * （见文件末尾那条"契约未变"用例），但"最近使用"这一级需要新的夹具，
 * 混进去会让"哪几条是旧契约、哪几条是本批新增"变得看不清。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../web/shared/profile-state');

const p = (id, extra) => Object.assign({ id }, extra || {});

test('第②级：本地失效后取 lastUsedAt 最大的未归档档案（不是"第一个未归档"）', () => {
  const profiles = [
    p('a', { lastUsedAt: '2026-09-01T10:00:00.000Z' }),
    p('b', { lastUsedAt: '2026-09-03T10:00:00.000Z' }),
    p('c', { lastUsedAt: '2026-09-02T10:00:00.000Z' }),
  ];
  assert.strictEqual(M.resolveSelectedId(profiles, null, 'srv'), 'b', '最近使用（b）优先于列表顺序');
  assert.strictEqual(M.resolveSelectedId(profiles, 'a', 'srv'), 'a', '第①级：本地有效仍然最优先（哪怕 a 更旧）');
  assert.strictEqual(M.resolveSelectedId(profiles, 'gone', 'srv'), 'b', '本地失效 → 落到最近使用');
});

test('第②级：最近使用必须是**未归档**的；已归档档案的 lastUsedAt 不参与', () => {
  const profiles = [
    p('arch', { archivedAt: '2026-09-05', lastUsedAt: '2026-09-09T10:00:00.000Z' }),
    p('live', { lastUsedAt: '2026-09-01T10:00:00.000Z' }),
  ];
  assert.strictEqual(M.resolveSelectedId(profiles, null, 'srv'), 'live', '归档档案不能被悄悄选中（哪怕它更新）');
});

test('第②级：lastUsedAt 缺失/空串/非法日期一律不参与 —— 不能被当成"最近使用"', () => {
  const profiles = [
    p('broken', { lastUsedAt: 'x' }),
    p('blank', { lastUsedAt: '' }),
    p('missing'),
    p('real', { lastUsedAt: '2026-01-01T00:00:00.000Z' }),
  ];
  assert.strictEqual(M.resolveSelectedId(profiles, null, 'srv'), 'real');
  // 全是坏时间 ⇒ 第②级整级跳过，落到"其余可用"（第一个未归档），而不是随便挑一个坏档案
  assert.strictEqual(M.resolveSelectedId([p('broken', { lastUsedAt: 'x' }), p('b')], null, 'srv'), 'broken');
  assert.strictEqual(M.lastUsedValue(undefined), null);
  assert.strictEqual(M.lastUsedValue(''), null);
  assert.strictEqual(M.lastUsedValue('不是日期'), null);
  assert.strictEqual(M.lastUsedValue(NaN), null);
  assert.strictEqual(M.lastUsedValue(1758000000000), 1758000000000, '数字（ms 时间值）照收');
  assert.strictEqual(M.lastUsedValue('2026-09-01T00:00:00.000Z'), Date.parse('2026-09-01T00:00:00.000Z'));
});

test('第③级：只有**有效**（在可用列表里）的默认档案才被采用，缺席的默认不兜底', () => {
  const profiles = [p('x'), p('y')];
  assert.strictEqual(M.resolveSelectedId(profiles, null, 'y'), 'y', '默认档案存在且未归档 → 用它');
  assert.strictEqual(M.resolveSelectedId(profiles, null, 'srv'), 'x', '默认档案缺席 → 继续落到"其余可用"');
  const withArch = [p('z', { archivedAt: '2026-09-01' }), p('x')];
  assert.strictEqual(M.resolveSelectedId(withArch, null, 'z'), 'x', '默认档案已归档 ⇒ 视为无效');
});

test('第②级优先于第③级：最近使用压过"服务端默认档案"', () => {
  const profiles = [p('def'), p('recent', { lastUsedAt: '2026-09-09T00:00:00.000Z' })];
  assert.strictEqual(M.resolveSelectedId(profiles, null, 'def'), 'recent');
});

test('四级都没有可用档案 ⇒ null（绝不返回不在列表里的 id）', () => {
  assert.strictEqual(M.resolveSelectedId([], null, 'srv'), null);
  assert.strictEqual(M.resolveSelectedId([], null, undefined), null);
  assert.strictEqual(M.resolveSelectedId([p('arch', { archivedAt: 'x' })], 'arch', 'srv'), null);
  assert.strictEqual(M.resolveSelectedId(null, 'a', 'srv'), null, '列表本身缺失也必须是 null');
});

test('判等用 UUID：昵称重名的两条档案互不干扰', () => {
  const profiles = [
    p('11111111-1111-1111-1111-111111111111', { nickname: '同名' }),
    p('22222222-2222-2222-2222-222222222222', { nickname: '同名', lastUsedAt: '2026-09-09T00:00:00.000Z' }),
  ];
  assert.strictEqual(M.resolveSelectedId(profiles, '11111111-1111-1111-1111-111111111111', null),
    '11111111-1111-1111-1111-111111111111');
  assert.strictEqual(M.resolveSelectedId(profiles, null, null), '22222222-2222-2222-2222-222222222222');
});

test('§5.3 长度上限：昵称 20 码点、简介 100 码点（代理对按 1 个字符算）', () => {
  assert.strictEqual(M.NICKNAME_MAX, 20);
  assert.strictEqual(M.BIO_MAX, 100);
  assert.strictEqual(M.clampProfileText('阿'.repeat(25), M.NICKNAME_MAX).length, 20);
  const emoji = '🐺'.repeat(25);
  assert.strictEqual(Array.from(M.clampProfileText(emoji, M.NICKNAME_MAX)).length, 20, '代理对不能把上限算成 10 个');
  assert.strictEqual(M.clampProfileText('短', M.NICKNAME_MAX), '短');
  assert.strictEqual(M.clampProfileText(null, M.NICKNAME_MAX), '');
  assert.strictEqual(Array.from(M.clampProfileText('简'.repeat(150), M.BIO_MAX)).length, 100);
});

test('§5.3 长昵称：省略展示但详情可读完整内容', () => {
  const long = '阿'.repeat(30);
  const d = M.displayName(long, M.NICKNAME_MAX);
  assert.strictEqual(d.truncated, true);
  assert.strictEqual(d.full, long, '详情永远是完整内容');
  assert.strictEqual(Array.from(d.short).length, M.NICKNAME_MAX, '省略后的展示长度不超过上限');
  assert.strictEqual(d.short.endsWith('…'), true);
  const short = M.displayName('阿甲');
  assert.strictEqual(short.truncated, false);
  assert.strictEqual(short.short, '阿甲');
  assert.strictEqual(short.full, '阿甲');
  assert.strictEqual(M.displayName(null).short, '');
});

test('契约未变：test/profile-state.test.js 的五条旧期望在四级回退下依然成立（无 lastUsedAt + 默认档案缺席）', () => {
  const profiles = [
    { id: 'arch', archivedAt: '2026-09-01' },
    { id: 'a', nickname: 'A' },
    { id: 'b', nickname: 'B' },
  ];
  assert.strictEqual(M.resolveSelectedId(profiles, 'b', 'srv'), 'b');
  assert.strictEqual(M.resolveSelectedId(profiles, 'arch', 'srv'), 'a');
  assert.strictEqual(M.resolveSelectedId(profiles, 'missing', 'srv'), 'a');
  assert.strictEqual(M.resolveSelectedId(profiles, null, 'srv'), 'a');
  assert.strictEqual(M.resolveSelectedId(profiles, '', 'srv'), 'a');
});
