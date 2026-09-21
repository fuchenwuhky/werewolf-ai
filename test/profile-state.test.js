/**
 * profile-state.test.js — 档案选中状态的浏览器端共享模型（M1 共享状态）
 *
 * 同一份实现被桌面 app.js 与手机 m.js 引用，这里在 Node 下直接断言行为。
 * 契约：键名由调用方传入（默认 'ww_profile_id'，两端当前共用同一个键）；
 * 读/写/清一律吞掉 storage 异常（隐私模式不该让切档报错）；
 * 选中 id 的落地解析只认"存在且未归档"，其余按 第一个未归档 → 服务端默认档案 → null 回落。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../web/shared/profile-state');

/** 内存版 storage：只实现共享模型用到的三个方法（足够复现浏览器的键值语义） */
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

test('键名由调用方传入：不传走默认键，传了只动那个键（不写死任何一端）', () => {
  assert.strictEqual(M.DEFAULT_KEY, 'ww_profile_id', '两端当前共用的选中键');
  const s = store();
  M.writeSelectedId(s, null, 'p1');
  assert.strictEqual(s.getItem('ww_profile_id'), 'p1', '不传键时落在默认键上');
  M.writeSelectedId(s, 'other_key', 'p2');
  assert.strictEqual(s.getItem('ww_profile_id'), 'p1', '写显式键不得覆盖默认键');
  assert.strictEqual(s.getItem('other_key'), 'p2');
  assert.strictEqual(M.readSelectedId(s, 'other_key'), 'p2');
  M.clearSelectedId(s, 'other_key');
  assert.strictEqual(M.readSelectedId(s, 'other_key'), null);
  assert.strictEqual(M.readSelectedId(s, null), 'p1', '清另一个键不得动默认键');
});

test('storage 不可用时一律不抛：读给 null，写/清静默忽略（两端原来的 try/catch 语义）', () => {
  assert.strictEqual(M.readSelectedId(deadStore, 'ww_profile_id'), null);
  assert.doesNotThrow(() => M.writeSelectedId(deadStore, 'ww_profile_id', 'p1'));
  assert.doesNotThrow(() => M.clearSelectedId(deadStore, 'ww_profile_id'));
});

test('选中 id 落地解析：只认未归档，归档/失效按 第一个可用 → 服务端默认 → null 回落', () => {
  const profiles = [
    { id: 'arch', archivedAt: '2026-09-01' },
    { id: 'a', nickname: 'A' },
    { id: 'b', nickname: 'B' },
  ];
  assert.strictEqual(M.resolveSelectedId(profiles, 'b', 'srv'), 'b', '命中未归档档案');
  assert.strictEqual(M.resolveSelectedId(profiles, 'arch', 'srv'), 'a', '归档档案不能被悄悄选中 → 第一个未归档');
  assert.strictEqual(M.resolveSelectedId(profiles, 'missing', 'srv'), 'a');
  assert.strictEqual(M.resolveSelectedId(profiles, null, 'srv'), 'a');
  assert.strictEqual(M.resolveSelectedId(profiles, '', 'srv'), 'a', '空串与"没选过"同义');
  assert.strictEqual(M.resolveSelectedId([{ id: 'arch', archivedAt: 'x' }], 'arch', 'srv'), 'srv', '全部归档 → 服务端默认档案');
  assert.strictEqual(M.resolveSelectedId([], null, undefined), null, '什么都没有时给 null');
  assert.strictEqual(M.resolveSelectedId([], null, 'srv'), 'srv');
});

test('档案偏好：没有档案/没有偏好回落默认值，且默认值是**新对象**（改它不污染下一次）', () => {
  const fallback = { fontScale: 1, layout: 'reading', reducedMotion: false };
  assert.deepStrictEqual(M.DEFAULT_PREFS, fallback);
  assert.deepStrictEqual(M.prefsOf([], null), fallback);
  assert.deepStrictEqual(M.prefsOf([{ id: 'a' }], 'a'), fallback);
  const mine = { fontScale: 1.25, layout: 'compact', reducedMotion: true };
  assert.strictEqual(M.prefsOf([{ id: 'a', preferences: mine }], 'a'), mine, '档案自带偏好时原样返回（不拷贝、不改写）');
  const one = M.prefsOf([], null);
  one.layout = 'compact';
  assert.strictEqual(M.prefsOf([], null).layout, 'reading', '默认值每次新建');
});

test('拉档案列表：成功按"未归档优先"落选中 id 再回调，失败置 null 并把原因交给调用方', async () => {
  const storage = store();
  const state = { profiles: null, profileId: 'stale' };
  const seen = [];
  const api = async (method, url) => {
    seen.push(`${method} ${url}`);
    return { profiles: [{ id: 'arch', archivedAt: '2026-09-01' }, { id: 'live' }], defaultProfileId: 'srv' };
  };
  await M.loadProfiles({ api, state, storage, onLoaded: () => seen.push(`loaded:${state.profileId}`), onFailed: (m) => seen.push(`failed:${m}`) });
  assert.deepStrictEqual(seen, ['GET /api/profiles', 'loaded:live'], '先拉到列表、落好选中 id，再通知调用方刷界面');
  assert.strictEqual(state.profiles.length, 2, '档案列表原样落进 state');
  assert.strictEqual(state.profileId, 'live', '第一个未归档档案');

  M.writeSelectedId(storage, null, 'live');
  await M.loadProfiles({ api, state, storage, onLoaded: () => {}, onFailed: () => {} });
  assert.strictEqual(state.profileId, 'live', '记住的选中 id 存在且未归档 → 用它');

  M.writeSelectedId(storage, null, 'arch');
  await M.loadProfiles({ api, state, storage, onLoaded: () => {}, onFailed: () => {} });
  assert.strictEqual(state.profileId, 'live', '记住的是已归档档案 → 不能被悄悄选中');

  const msgs = [];
  const bad = { profiles: [{ id: 'live' }], profileId: 'live' };
  await M.loadProfiles({
    api: async () => { throw new Error('离线'); },
    state: bad, storage,
    onLoaded: () => msgs.push('loaded'),
    onFailed: (m) => msgs.push(`failed:${m}`),
  });
  assert.deepStrictEqual(msgs, ['failed:离线'], '失败走 onFailed，带可读原因');
  assert.strictEqual(bad.profileId, null, '失败后不许留着可能串档的选中 id');
});

test('切档：写选中键 + 昵称预填（手改过就不覆盖），档案不存在也照旧写选中', () => {
  const storage = store();
  const state = { profiles: [{ id: 'a', nickname: '阿甲' }, { id: 'b', nickname: '阿乙' }], profileId: null };
  const input = { value: '手填的', dataset: {} };
  const p = M.selectProfile({ state, storage, profileId: 'a', nameInput: input });
  assert.strictEqual(state.profileId, 'a');
  assert.strictEqual(storage.getItem('ww_profile_id'), 'a');
  assert.strictEqual(input.value, '阿甲', '昵称框未被手改 → 用档案昵称预填');
  assert.strictEqual(p.id, 'a');
  input.dataset.touched = '1';
  M.selectProfile({ state, storage, profileId: 'b', nameInput: input });
  assert.strictEqual(input.value, '阿甲', '用户手改过昵称就不再覆盖');
  assert.strictEqual(state.profileId, 'b');
  assert.strictEqual(M.selectProfile({ state, storage, profileId: 'missing', nameInput: input }), null);
  assert.strictEqual(storage.getItem('ww_profile_id'), 'missing', '档案查不到也照旧写选中（与原实现一致）');
  assert.doesNotThrow(() => M.selectProfile({ state: { profiles: [] }, storage: deadStore, profileId: 'x' }));
});

test('删除当前档案后取消选中：只对"删的就是当前档案"生效', () => {
  const storage = store({ ww_profile_id: 'a' });
  const state = { profileId: 'a' };
  assert.strictEqual(M.deselectIfCurrent({ state, storage, profileId: 'b' }), false);
  assert.strictEqual(state.profileId, 'a', '删别的档案不得动选中');
  assert.strictEqual(storage.getItem('ww_profile_id'), 'a');
  assert.strictEqual(M.deselectIfCurrent({ state, storage, profileId: 'a' }), true);
  assert.strictEqual(state.profileId, null);
  assert.strictEqual(storage.getItem('ww_profile_id'), null);
  assert.doesNotThrow(() => M.deselectIfCurrent({ state: { profileId: 'x' }, storage: deadStore, profileId: 'x' }));
});

test('storage 事件判键：本端键才算（两端各写一遍的字面量比较收敛到一处）', () => {
  assert.strictEqual(M.isSelectionKey('ww_profile_id'), true, '不传期望键时按默认键判');
  assert.strictEqual(M.isSelectionKey('ww_profile_id', 'ww_profile_id'), true);
  assert.strictEqual(M.isSelectionKey('other', 'ww_profile_id'), false);
  assert.strictEqual(M.isSelectionKey('other', 'other'), true);
});
