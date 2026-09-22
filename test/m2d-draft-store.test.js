/**
 * m2d-draft-store.test.js — 草稿的归属键、密钥纪律与开局闸门（计划书 §8.2 `:262`-`:268`、§9.3 `:302`）
 *
 * 本批的硬要求（施工书 §5.5）：
 *   ① 开局草稿**按档案**保存，切档**不继承**上一档案草稿；草稿里**绝不许**出现 Key/令牌/Cookie；
 *   ② 局内笔记草稿按 **owner + gameId + seat** 保存，**不按当前浏览档案归属**
 *      ⇒ 仅切换浏览档案不得让草稿丢失或串档；
 *   ③ 新草稿默认试玩，恢复既有草稿/对局保持原模式（不能静默切换）；
 *   ④ 第三步之前不得建局；缺 Key / 绑定失效 / 板子非法 ⇒ 明确原因 + 修复入口，**不得静默降级为试玩**；
 *   ⑤ 返回首页不等于终止（由 switch-guard 钉，见 m2d-switch-guard.test.js）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../web/shared/draft-store');

/** 内存版 storage（会话存储的语义：只实现共享模块用到的方法） */
function store(init) {
  const map = new Map(Object.entries(init || {}));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

test('① 开局草稿按**档案**隔离：切档看的是新档案自己的草稿，不继承上一档案的', () => {
  const ss = store();
  D.writeSetupDraft(ss, 'profile-A', { boardId: 'adv12', mode: 'real', mySeat: 3 });
  assert.strictEqual(D.readSetupDraft(ss, 'profile-B'), null, 'B 没有草稿 ⇒ 不能读到 A 的板子');
  D.writeSetupDraft(ss, 'profile-B', { boardId: 'custom', mode: 'mock' });
  assert.deepStrictEqual(D.readSetupDraft(ss, 'profile-A').boardId, 'adv12', '两条草稿互不影响（各自的键）');
  assert.deepStrictEqual(D.readSetupDraft(ss, 'profile-B').boardId, 'custom');
  assert.strictEqual(D.setupDraftKey('profile-A') === D.setupDraftKey('profile-B'), false, '键必须按档案分叉');
});

test('① 草稿里绝不许出现 Key / 令牌 / Cookie（会话存储是明文的）', () => {
  const ss = store();
  const dirty = {
    boardId: 'adv12',
    mode: 'real',
    apiKey: 'sk-should-never-be-here',
    playerToken: 'tok-abc',
    godToken: 'tok-god',
    nested: { keyBinding: { key: 'sk-nested' }, cookie: 'a=b', keep: 'ok' },
    history: [{ token: 'tok-in-array', label: '保留' }],
  };
  assert.deepStrictEqual(D.secretFieldsOf(dirty).sort(),
    ['apiKey', 'cookie', 'godToken', 'keyBinding', 'key', 'playerToken', 'token'].sort(),
    '诊断函数要能点名被丢掉的字段（含嵌套与数组元素）');
  D.writeSetupDraft(ss, 'profile-A', dirty);
  const raw = ss.getItem(D.setupDraftKey('profile-A'));
  for (const needle of ['sk-should-never-be-here', 'tok-abc', 'tok-god', 'sk-nested', 'token', 'cookie', 'Key']) {
    assert.strictEqual(raw.includes(needle), false, `会话存储里不许出现 ${needle}`);
  }
  const back = D.readSetupDraft(ss, 'profile-A');
  assert.deepStrictEqual(back, { boardId: 'adv12', mode: 'real', nested: { keep: 'ok' }, history: [{ label: '保留' }] });
});

test('② 笔记草稿的键是 owner + gameId + seat，键里**没有**"当前浏览档案"的位置', () => {
  assert.strictEqual(D.noteDraftKey('owner1', 'g1', 3), 'ww_draft_note:owner1:g1:3');
  assert.notStrictEqual(D.noteDraftKey('owner1', 'g1', 3), D.noteDraftKey('owner1', 'g1', 4), '座位不同 ⇒ 键不同');
  assert.notStrictEqual(D.noteDraftKey('owner1', 'g1', 3), D.noteDraftKey('owner1', 'g2', 3), '对局不同 ⇒ 键不同');
  assert.notStrictEqual(D.noteDraftKey('owner1', 'g1', 3), D.noteDraftKey('owner2', 'g1', 3), 'owner 不同 ⇒ 键不同');
  assert.strictEqual(D.noteDraftKey.length, 3, '形参固定三个：想传"当前浏览档案"也没有位置可传');
});

test('② 仅切换浏览档案：同一 owner/gameId/seat 的草稿仍在（不丢档、不串档）', () => {
  const ss = store();
  const at = { ownerProfileId: 'owner-A', gameId: 'game-1', seat: 5 };
  D.writeNoteDraft(ss, at, { leaning: 'wolf', note: '写到一半的笔记' });
  // 「切到另一个档案去看了眼战绩」不会改变上面这个 key —— 键里根本没有浏览档案这一维
  assert.deepStrictEqual(D.readNoteDraft(ss, { ownerProfileId: 'owner-A', gameId: 'game-1', seat: 5 }),
    { leaning: 'wolf', note: '写到一半的笔记' });
  assert.strictEqual(D.readNoteDraft(ss, { ownerProfileId: 'owner-A', gameId: 'game-1', seat: 6 }), null,
    '别的座位不会被这条草稿串到');
  D.clearNoteDraft(ss, at);
  assert.strictEqual(D.readNoteDraft(ss, at), null, '保存成功后清掉本座位草稿');
});

test('② 笔记草稿同样过滤密钥字段', () => {
  const ss = store();
  D.writeNoteDraft(ss, { ownerProfileId: 'o', gameId: 'g', seat: 1 }, { note: '正文', token: 'tok' });
  assert.deepStrictEqual(D.readNoteDraft(ss, { ownerProfileId: 'o', gameId: 'g', seat: 1 }), { note: '正文' });
});

test('③ 新草稿默认试玩；既有草稿/恢复的对局保持原模式', () => {
  assert.strictEqual(D.resolveMode({}), 'mock', '新草稿默认试玩（流程脚本，不调用模型）');
  assert.strictEqual(D.resolveMode({ existingMode: null }), 'mock');
  assert.strictEqual(D.resolveMode({ existingMode: 'garbage' }), 'mock', '非法模式按"没有模式"处理');
  assert.strictEqual(D.resolveMode({ existingMode: 'real' }), 'real', '恢复既有草稿：保持真实');
  assert.strictEqual(D.resolveMode({ existingMode: 'mock' }), 'mock', '恢复既有草稿：保持试玩');
});

test('③ 模式漂移是可断言的（"不能静默切换"）', () => {
  assert.strictEqual(D.modeDrift('real', 'real'), null);
  assert.strictEqual(D.modeDrift(null, 'mock'), null, '原来没有模式 ⇒ 不涉及漂移');
  const reason = D.modeDrift('real', 'mock');
  assert.strictEqual(typeof reason, 'string');
  assert.strictEqual(reason.includes('不能静默切换'), true);
  assert.strictEqual(D.modeDrift('mock', 'real').includes('真实'), true);
});

test('④ 第三步之前不得建局', () => {
  const g1 = D.submitGate({ step: 1, steps: 3, mode: 'mock' });
  assert.strictEqual(g1.allowed, false);
  assert.strictEqual(g1.fix, 'step');
  assert.strictEqual(g1.reason.includes('不允许建局'), true);
  assert.strictEqual(D.submitGate({ step: 3, steps: 3, mode: 'mock' }).allowed, true, '第三步才放行');
});

test('④ 缺 Key / 绑定失效 / 板子非法：给明确原因与修复入口，且**不静默降级为试玩**', () => {
  const noKey = D.submitGate({ step: 3, mode: 'real', hasApiKey: false });
  assert.strictEqual(noKey.allowed, false);
  assert.strictEqual(noKey.fix, 'settings', '带修复入口');
  assert.strictEqual(noKey.reason.includes('API Key'), true);
  assert.strictEqual(noKey.mode, 'real', '请求的是 real 就返回 real —— 闸门只拦不改模式');

  const badBind = D.submitGate({ step: 3, mode: 'real', bindingValid: false });
  assert.strictEqual(badBind.allowed, false);
  assert.strictEqual(badBind.fix, 'settings');
  assert.strictEqual(badBind.reason.includes('绑定'), true);
  assert.strictEqual(badBind.mode, 'real');

  const badBoard = D.submitGate({ step: 3, mode: 'mock', boardValid: false, boardReason: '狼人 0 个' });
  assert.strictEqual(badBoard.allowed, false);
  assert.strictEqual(badBoard.fix, 'board');
  assert.strictEqual(badBoard.reason, '狼人 0 个', '用调用方给的具体原因（可读、能指到修复入口）');

  const ok = D.submitGate({ step: 3, mode: 'real', hasApiKey: true, bindingValid: true, boardValid: true });
  assert.deepStrictEqual(ok, { allowed: true, reason: '', fix: null, mode: 'real' });
});

test('④ 单次提交锁：连点只会有一次拿到锁（不会产生第二次建局请求）', () => {
  const lock = D.createSubmitLock();
  assert.strictEqual(lock.locked, false);
  assert.strictEqual(lock.tryLock(), true, '第一次拿到');
  assert.strictEqual(lock.tryLock(), false, '连点/重入拿不到');
  assert.strictEqual(lock.locked, true);
  lock.release();
  assert.strictEqual(lock.tryLock(), true, '释放后可以再提交（失败重试路径）');
});

test('storage 不可用时静默降级（隐私模式不该让开局/笔记报错）', () => {
  const dead = { getItem() { throw new Error('不可用'); }, setItem() { throw new Error('不可用'); }, removeItem() { throw new Error('不可用'); } };
  assert.strictEqual(D.readSetupDraft(dead, 'p'), null);
  assert.strictEqual(D.writeSetupDraft(dead, 'p', { a: 1 }), false);
  assert.strictEqual(D.clearSetupDraft(dead, 'p'), false);
  assert.strictEqual(D.readNoteDraft(dead, { ownerProfileId: 'o', gameId: 'g', seat: 1 }), null);
});

test('坏 JSON 草稿按"没有草稿"处理（不把异常抛到界面上）', () => {
  const ss = store({ [D.setupDraftKey('p')]: '{坏掉的' });
  assert.strictEqual(D.readSetupDraft(ss, 'p'), null);
});
