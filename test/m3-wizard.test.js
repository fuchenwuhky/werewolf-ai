/**
 * m3-wizard.test.js —— 三步开局的**状态机**（M3；计划书 §8.2 `:245`-`:268`、§11 U02/U03/U04）
 *
 * 本文件只测 `web/shared/setup-wizard.js` 这一层（双端复用的纯逻辑），真页面由
 * `scripts/ui-check.js` 的 M3 段验收。覆盖施工任务书 §2.2 的 B1～B9：
 *   B1 新草稿默认试玩 / B2 恢复保持原模式不静默切换 / B3 草稿不含密钥
 *   B4 切档不继承 / B5 后退保留内容 / B6 第三步之前零建局
 *   B7 提交冻结档案与全部参数 + 单次提交锁（连点只建一局）
 *   B8 建局结果不明时**先查询**已有对局，禁止盲目重建
 *   B9 缺 Key / 绑定失效 / 板子非法 ⇒ 具体原因 + 修复入口，**不得静默降级为试玩**
 * 另有 §0 第 7 条那个**概念陷阱**的防线：`mode`（mock/real）与 `participation`（play/watch）
 * 是两个维度，混用必须**响亮报错**，不能静默回落（历史上正是静默回落造成过真缺陷）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../web/shared/setup-wizard');

/** 内存版会话存储（只实现共享模块用到的三个方法） */
function store(init) {
  const map = new Map(Object.entries(init || {}));
  return {
    map,
    raw: () => JSON.stringify([...map.entries()]),
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

const BOARD = { boardId: 'adv12', boardName: '12 人预女猎白', playerCount: 12, roles: { wolf: 4, seer: 1 } };

function mk(opts) {
  return W.createWizard(Object.assign({
    storage: store(), profileId: 'profile-A', ownerNickname: '甲', board: BOARD,
  }, opts || {}));
}

test('B1/B2：新草稿默认试玩；既有草稿/对局的模式原样保留且不允许静默切换', () => {
  assert.strictEqual(mk().mode(), 'mock', '新草稿必须默认试玩');
  assert.strictEqual(mk({ existingMode: 'real' }).mode(), 'real', '恢复真实对局时不得变成试玩');
  assert.strictEqual(W.resolveParticipation({}), 'play', '参与维度缺省是"我当玩家"');
  assert.strictEqual(W.resolveParticipation({ participation: 'watch' }), 'watch');
  assert.strictEqual(W.resolveParticipation({ participation: 'mock' }), 'play',
    '把"试玩"塞进参与维度 ⇒ 回落成 play，而不是把它当成观战（两轴不许互相顶替）');
});

test('§0 陷阱防线：两轴取值域不许互相串（混用要响亮报错，不能静默回落）', () => {
  assert.throws(() => mk({ mode: 'play' }), /mode/i,
    'mode 收到 play/watch ⇒ 必须抛错：静默回落正是历史上"开局变试玩、身份遮罩不出现"的成因');
  assert.throws(() => mk({ participation: 'real' }), /participation/i);
  assert.strictEqual(W.assertAxes({ mode: 'real', participation: 'watch' }).ok, true);
  assert.strictEqual(W.assertAxes({ mode: 'mock', participation: 'play' }).ok, true);
  assert.strictEqual(W.assertAxes({ mode: 'watch', participation: 'play' }).ok, false);
});

test('B6：前两步零建局 —— set/next/back 期间 create 一次都不能被调用；第三步之前 commit 也必须拒绝', async () => {
  let created = 0;
  const w = mk();
  const deps = {
    create: async () => { created++; return { gameId: 'g1' }; },
    queryExisting: async () => ({ rows: [] }),
  };
  w.set({ playerCount: 12 }).set({ mySeat: 3 });
  w.next();                       // → 第 2 步
  w.set({ participation: 'watch' });
  assert.strictEqual(created, 0, '第 1→2 步之间绝不建局');
  const early = await w.commit(deps);
  assert.strictEqual(early.allowed, false, '第 2 步提交必须被拦住');
  assert.match(early.reason, /三步|第 ?2 ?步/);
  assert.strictEqual(created, 0, '被拦的提交不得产生任何建局请求');
  w.next();                       // → 第 3 步
  assert.strictEqual(w.step, 3);
  assert.strictEqual(created, 0, '走到第 3 步本身也不建局（要等用户按确认）');
});

test('B5：后退保留内容（三步间前后移动都不丢输入），且草案按档案落会话存储', () => {
  const ss = store();
  const w = W.createWizard({ storage: ss, profileId: 'profile-A', board: BOARD, ownerNickname: '甲' });
  w.set({ mySeat: 7, seatStrategy: 'random' });
  w.next();
  w.set({ participation: 'watch', nickname: '观战者' });
  w.back();
  assert.strictEqual(w.step, 1, '后退回到第 1 步');
  assert.deepStrictEqual(w.data.mySeat, 7, '后退不得丢第 1 步的输入');
  assert.deepStrictEqual(w.data.nickname, '观战者', '后退不得丢第 2 步的输入');
  w.next();
  assert.strictEqual(w.step, 2, '前进回到第 2 步');
  assert.deepStrictEqual(w.data.seatStrategy, 'random');
  const persisted = JSON.parse(ss.getItem(W.draftKey('profile-A')));
  assert.strictEqual(persisted.mySeat, 7, '输入必须已经落到该档案的会话草稿里');
});

test('B3/B4：草稿按档案隔离、切档不继承；序列化结果里没有 Key/令牌', () => {
  const ss = store();
  const a = W.createWizard({ storage: ss, profileId: 'profile-A', board: BOARD, ownerNickname: '甲' });
  a.set({ nickname: '甲', apiKey: 'sk-should-not-be-stored', nested: { token: 'tok', keep: 1 } });
  const raw = ss.getItem(W.draftKey('profile-A'));
  assert.doesNotMatch(raw, /sk-should-not-be-stored/, '密钥字段的值不得进草稿');
  assert.doesNotMatch(raw, /"token"/, 'token 字段名不得进草稿');
  assert.match(raw, /"keep":1/, '非密钥字段要保留（不是整块丢掉）');
  const b = W.createWizard({ storage: ss, profileId: 'profile-B', board: BOARD, ownerNickname: '乙' });
  assert.strictEqual(b.data.nickname, undefined, 'B 档案不得继承 A 的开局草稿');
  assert.notStrictEqual(W.draftKey('profile-A'), W.draftKey('profile-B'));
});

test('B7：提交冻结档案与全部参数 —— 冻结后"当前档案"再变也不影响这次建局的 owner；参数取冻结快照', async () => {
  let seen = null;
  const w = mk({ profileId: 'frozen-id', ownerNickname: '冻结时的昵称' });
  w.set({ mySeat: 5 }).next().set({ participation: 'watch' }).next();
  // 模拟"提交那一刻之后，用户切了档 / 改了昵称"：内部快照必须不受影响
  const mutable = { profileId: 'frozen-id', nickname: '冻结时的昵称' };
  const frozen = w.freeze({ ownerNickname: mutable.nickname });
  mutable.profileId = 'someone-else';
  mutable.nickname = '换了的昵称';
  const res = await w.commit({
    create: async (payload) => { seen = payload; return { gameId: 'g-1' }; },
    queryExisting: async () => ({ rows: [] }),
    hasApiKey: true, bindingValid: true, boardValid: true,
  });
  assert.strictEqual(res.allowed, true, JSON.stringify(res));
  assert.strictEqual(frozen.profileId, 'frozen-id');
  assert.strictEqual(seen.ownerProfileId, 'frozen-id', 'owner 必须用冻结时的 profileId');
  assert.strictEqual(seen.ownerNicknameSnapshot, '冻结时的昵称', 'owner 展示快照必须是冻结时的');
  assert.strictEqual(seen.mode, 'mock', '冻结快照里带上试玩/真实');
  assert.strictEqual(seen.participation, 'watch', '冻结快照里带上玩家/观战（另一条轴）');
  assert.deepStrictEqual(seen.board.boardId, 'adv12');
  assert.strictEqual(seen.mySeat, 5, '座位等全部参数都来自冻结快照');
  assert.ok(Object.isFrozen(seen), '交给建局函数的载荷本身要是冻结的');
});

test('B7：单次提交锁 —— 连点只建一局（第二次立即失败，不产生第二个请求）', async () => {
  let created = 0;
  const w = mk();
  w.next().next();
  const deps = {
    create: async () => { created++; await new Promise((r) => setTimeout(r, 20)); return { gameId: 'g-1' }; },
    queryExisting: async () => ({ rows: [] }),
    hasApiKey: true, bindingValid: true, boardValid: true,
  };
  const [r1, r2, r3] = await Promise.all([w.commit(deps), w.commit(deps), w.commit(deps)]);
  assert.strictEqual(created, 1, '连点三次只能有一次建局请求');
  assert.strictEqual([r1, r2, r3].filter((r) => r.allowed).length, 1, '只允许一次提交成功');
  assert.match([r1, r2, r3].find((r) => !r.allowed).reason, /提交中|已提交|重复/);
  assert.strictEqual(w.submitLock.locked, true, '提交成功后锁保持（单次提交）');
});

test('B8：建局结果不明 ⇒ 先查询已有对局，绝不盲目重建', async () => {
  let created = 0; let queried = 0;
  const w = mk();
  w.next().next();
  const res = await w.commit({
    create: async () => { created++; throw new Error('socket hang up'); },
    queryExisting: async () => { queried++; return { rows: [{ id: 'g-exists', ownerProfileId: 'profile-A' }] }; },
    hasApiKey: true, bindingValid: true, boardValid: true,
  });
  assert.strictEqual(created, 1, '只发一次建局请求');
  assert.strictEqual(queried, 1, '结果不明时必须去查一次已有对局');
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.unknown, true, '要如实标记"结果不明"');
  assert.strictEqual(res.existing.rows[0].id, 'g-exists', '查到的已有对局要交回上层（由用户确认继续）');
  assert.strictEqual(w.submitLock.locked, false, '结果不明要放开锁，允许用户确认后重试');
});

test('B9：缺 Key / 绑定失效 / 板子非法 ⇒ 具体原因 + 修复入口，且 mode 永远是请求的那个', async () => {
  const w = mk({ existingMode: 'real' });
  w.next().next();
  const noKey = await w.commit({ create: async () => ({ gameId: 'x' }), queryExisting: async () => ({}), hasApiKey: false, bindingValid: true, boardValid: true });
  assert.strictEqual(noKey.allowed, false);
  assert.strictEqual(noKey.fix, 'settings', '缺 Key 要指向设置里的修复入口');
  assert.strictEqual(noKey.mode, 'real', '**不得**静默降级成试玩');
  assert.match(noKey.reason, /Key/);

  const w2 = mk({ existingMode: 'real' });
  w2.next().next();
  const badBind = await w2.commit({ create: async () => ({ gameId: 'x' }), queryExisting: async () => ({}), hasApiKey: true, bindingValid: false, boardValid: true });
  assert.strictEqual(badBind.fix, 'settings');
  assert.strictEqual(badBind.mode, 'real');

  const w3 = mk();
  w3.next().next();
  const badBoard = await w3.commit({ create: async () => ({ gameId: 'x' }), queryExisting: async () => ({}), hasApiKey: true, bindingValid: true, boardValid: false, boardReason: '狼人 4 人超过 12 人板的上限' });
  assert.strictEqual(badBoard.allowed, false);
  assert.strictEqual(badBoard.fix, 'board');
  assert.match(badBoard.reason, /狼人 4 人/);
});

test('第三步汇总：档案 / 板子 / 人数 / 座位策略 / 试玩或真实 / 模型配置状态 六项都要在', () => {
  const w = mk({ existingMode: 'real' });
  w.set({ playerCount: 12, seatStrategy: 'random', mySeat: 3 });
  const rows = W.summarize(w.snapshot(), { hasApiKey: true, bindingValid: false });
  const keys = rows.map((r) => r.key);
  for (const k of ['profile', 'board', 'players', 'seats', 'mode', 'model']) {
    assert.ok(keys.includes(k), `汇总缺少 ${k}`);
  }
  const model = rows.find((r) => r.key === 'model');
  assert.match(model.text, /绑定|失效/, '模型配置状态要如实说绑定失效（不能只说"已配置"）');
  const mode = rows.find((r) => r.key === 'mode');
  assert.match(mode.text, /真实/, '模式行要写清真实/试玩');
  assert.match(mode.text, /调用|计费/, '真实模式要提示会调用模型/计费');
});
