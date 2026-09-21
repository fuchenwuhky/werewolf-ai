/**
 * game-draft.test.js — 开局草稿 / 本地对局句柄的浏览器端共享模型（M1 共享状态）
 *
 * 同一份实现被桌面 app.js 与手机 m.js 引用，这里在 Node 下直接断言行为。
 * 契约（硬约束）：**键名全部由调用方传入**。桌面 ww_current / ww_tags_ ，手机 mww_current / mww_tags_
 * 是**有意分开**的两组键（两端各自只恢复自己开的局），模块不得合并、也不得写死；
 * 手机端历史上误写过桌面键导致恢复后句柄丢失，这些用例就是钉死这件事。
 * 模块不吞异常（坏 JSON / storage 抛错照旧冒泡），由调用点既有的 try/catch 接住。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../web/shared/game-draft');

/** 内存版 storage：只实现共享模型用到的三个方法 */
function store(init) {
  const map = new Map(Object.entries(init || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}
const boom = () => { throw new Error('storage 不可用'); };
const deadStore = { getItem: boom, setItem: boom, removeItem: boom };

test('对局句柄：桌面键与手机键落在各自的位置，互不可见、互不覆盖、互不清除', () => {
  const s = store();
  const desktop = { gameId: 'g1', playerToken: 'p', godToken: 'd', mySeat: 3 };
  M.writeHandle(s, 'ww_current', desktop);
  assert.strictEqual(s.getItem('ww_current'), JSON.stringify(desktop), '写出去的就是 JSON 文本（逐字节一致）');
  assert.strictEqual(s.getItem('mww_current'), null, '写桌面键不得产生手机键');
  assert.deepStrictEqual(M.readHandle(s, 'ww_current'), desktop);
  assert.strictEqual(M.readHandle(s, 'mww_current'), null, '另一端的键读不到（有意分开，绝不合并）');
  M.writeHandle(s, 'mww_current', { gameId: 'g2' });
  assert.strictEqual(M.readHandle(s, 'ww_current').gameId, 'g1', '两端键不得串档');
  M.clearHandle(s, 'mww_current');
  assert.strictEqual(s.getItem('mww_current'), null);
  assert.strictEqual(M.readHandle(s, 'ww_current').gameId, 'g1', '清手机键不得清掉桌面的局');
});

test('句柄解析：缺失/空串/字面 null 都给 null；坏 JSON 照旧抛出（不吞）', () => {
  assert.strictEqual(M.readHandleRaw(store(), 'ww_current'), null, '没存过 → null（首页"有没有句柄"的判据）');
  assert.strictEqual(M.readHandleRaw(store({ mww_current: '{"a":1}' }), 'mww_current'), '{"a":1}', '原始文本原样返回（不解析）');
  assert.strictEqual(M.readHandleRaw(store({ ww_current: '{"a":1}' }), 'mww_current'), null, '另一端键读不到');
  assert.strictEqual(M.parseHandle(null), null);
  assert.strictEqual(M.parseHandle(undefined), null);
  assert.strictEqual(M.parseHandle(''), null);
  assert.strictEqual(M.parseHandle('null'), null);
  assert.deepStrictEqual(M.parseHandle('{"gameId":"g"}'), { gameId: 'g' });
  assert.strictEqual(M.parseHandle('0'), 0, '与 JSON.parse(raw || \'null\') 逐字同义：非空文本一律真解析');
  assert.throws(() => M.parseHandle('{'), SyntaxError);
  assert.throws(() => M.readHandle(store({ ww_current: '{oops' }), 'ww_current'), SyntaxError, '坏句柄照旧冒泡给调用点的 try/catch');
  assert.strictEqual(M.readHandle(store(), 'ww_current'), null, '没有句柄 → null（不是 undefined，也不是异常）');
  assert.doesNotThrow(() => M.clearHandle(store(), 'ww_current'), '清一个不存在的键不是错误');
});

test('旧版座位标记 key：两端前缀不同，绝不合并', () => {
  assert.strictEqual(M.tagsKey('ww_tags_', 'g1'), 'ww_tags_g1');
  assert.strictEqual(M.tagsKey('mww_tags_', 'g1'), 'mww_tags_g1');
  assert.notStrictEqual(M.tagsKey('ww_tags_', 'g1'), M.tagsKey('mww_tags_', 'g1'), '桌面与手机的迁移键必须分开');
});

test('旧版座位标记：两种兜底（{} 给渲染、null 给迁移判据）与按 prefix+gameId 落键', () => {
  const s = store();
  assert.deepStrictEqual(M.readTags(s, 'ww_tags_', 'g1'), {}, '进局首次渲染要立刻能用 → {} 兜底');
  assert.strictEqual(M.readLegacyTags(s, 'ww_tags_', 'g1'), null, '迁移判据要能区分"没有旧数据"');
  M.writeTags(s, 'ww_tags_', 'g1', { 3: 'wolf' });
  assert.strictEqual(s.getItem('ww_tags_g1'), '{"3":"wolf"}', '写出的键是 prefix+gameId');
  assert.strictEqual(s.getItem('mww_tags_g1'), null, '写桌面前缀不得产生手机键');
  assert.deepStrictEqual(M.readTags(s, 'ww_tags_', 'g1'), { 3: 'wolf' });
  assert.deepStrictEqual(M.readLegacyTags(s, 'ww_tags_', 'g1'), { 3: 'wolf' });
  assert.deepStrictEqual(M.readTags(s, 'mww_tags_', 'g1'), {}, '另一端的键读不到（有意分开）');
  assert.deepStrictEqual(M.readTags(s, 'ww_tags_', 'g2'), {}, '换局不得读到上一局的旧标记');
  M.clearTags(s, 'ww_tags_', 'g1');
  assert.strictEqual(s.getItem('ww_tags_g1'), null);
  assert.deepStrictEqual(M.readTags(s, 'ww_tags_', 'g1'), {});
  assert.strictEqual(M.readLegacyTags(s, 'ww_tags_', 'g1'), null);
  assert.throws(() => M.readTags(store({ ww_tags_g1: 'not json' }), 'ww_tags_', 'g1'), SyntaxError);
  assert.throws(() => M.readLegacyTags(store({ ww_tags_g1: 'not json' }), 'ww_tags_', 'g1'), SyntaxError);
});

test('座位偏好：默认「随机」、统一按字符串存、storage 不可用时静默回落', () => {
  const s = store();
  assert.strictEqual(M.readSeat(s, 'ww_seat'), 'random', '没存过 → 随机（老坐 1 号很难受）');
  M.writeSeat(s, 'ww_seat', 5);
  assert.strictEqual(s.getItem('ww_seat'), '5', '与原来 setItem(String(choice)) 一致');
  assert.strictEqual(M.readSeat(s, 'ww_seat'), '5');
  M.writeSeat(s, 'ww_seat', 'random');
  assert.strictEqual(M.readSeat(s, 'ww_seat'), 'random');
  assert.strictEqual(M.readSeat(deadStore, 'ww_seat'), 'random', 'storage 抛异常时仍给随机，不冒泡');
  assert.doesNotThrow(() => M.writeSeat(deadStore, 'ww_seat', 3), '记不住偏好不该让开局失败');
});
