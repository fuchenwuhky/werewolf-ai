/**
 * experience-ownership.test.js — 经验池的数据归属（M0「数据风险项关闭」硬要求）
 *
 * 原文要求（docs/next-stage-implementation-plan.md:56）：
 *   「默认档案与旧经验池必须固定归属到原 UUID。切换默认选择、归档或重建默认档案不得让另一个
 *     玩家继承旧经验池；如需迁移，必须备份、原子写、校验并具备幂等游标。」
 *
 * 缺陷复述（修复前实测；探针走真实 Api + 真实 HTTP 分发路径）：
 *   `Api.experienceFor(ownerProfileId)` 旧判据是「ownerProfileId === this.defaultProfileId → 旧池」，
 *   而 `this.defaultProfileId` 是**会变的**（归档/删除默认档案时 _repointDefaultProfile 立刻改指；
 *   启动时 ensureDefaultProfile 还可能重建一份新档案）。于是同一份 saves/experiences.json
 *   的读路径当场换主：
 *     · 归档默认档案甲 → 接任的乙开局注入的是**甲的教训**（继承）；
 *     · 甲自己（恢复可用后）读到 profiles/甲/experiences.json 这份空池（丢失）；
 *     · 默认档案文件被外部损毁后重建出的新档案同样继承旧池。
 *   修复：旧池归属改由 migrations/legacy-experience-owner（只在首次落盘的 UUID 标记）唯一决定，
 *   与"谁是当前默认"、与昵称都无关。
 *
 * 契约（本文件钉住的部分）：
 *   · 归属键只有 UUID：旧池属于归属标记里的 profileId，其余档案各自持有
 *     profiles/<id>/experiences.json；
 *   · 归档 / 删除进回收站 / 从回收站恢复 / 建新档案 / 改昵称 / 重名 / 切换默认选择 / 重启 /
 *     重建默认档案 —— 每个场景**两个方向**都要成立：原档案经验还在、别的档案没有凭空继承；
 *   · 归属标记只在首次落盘（幂等）、原子写不留临时文件、写后校验一致；
 *     标记损坏或丢失时**失败关闭**（旧池无主：宁可暂时不注入，也不交给某个档案继承）。
 *
 * 建局断言都走真实路径：POST /api/games（mock:false）→ Game.deal()（真实发牌）→
 * Game.agentFor()（真实 agentFactory + 真实 Agent 构造函数里注入 system 提示词），不联网、不驱动 AI。
 * 「同角色对照」：给两个档案的同名角色各写一条标记经验，再看目标档案的提示词出现哪一条 ——
 * 避免"发到的角色不同所以没注入"造成假绿。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const events = require('events');
const crypto = require('crypto');

const { makeDataDir, savesOf, makeApiIn, settleApi, dispose } = require('./helpers-tmpdir');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST = { host: 'localhost:3210' };
/** keyBinding 必须按服务端同一算法算（baseUrl|apiKey|apiKeys 的 SHA-256），否则真实局被拒 */
const KB = crypto.createHash('sha256').update('§k§').digest('hex');
const realConfig = { get: () => ({ apiKey: 'k', journal: false, keyBinding: KB }), save() {} };

function stubReq({ method = 'GET', body = null } = {}) {
  const req = new events.EventEmitter();
  req.method = method;
  req.headers = { ...HOST };
  req.socket = { remoteAddress: '127.0.0.1' };
  process.nextTick(() => {
    if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

/** 走 api.handle 的真实分发路径（与 test/profiles-api.test.js 同款） */
async function call(api, method, pathname, body) {
  const u = new URL(pathname, 'http://localhost');
  const box = { code: null, raw: null };
  box.res = { writeHead(c) { box.code = c; }, end(b) { box.raw = b; }, setHeader() {} };
  await api.handle(stubReq({ method, body }), box.res, u.pathname, u.searchParams);
  return { status: box.code, body: box.raw ? JSON.parse(box.raw) : null };
}

/** 建一份 Api（saveDir = <dataDir>/saves），并登记以便统一收尾（计时器 + 独占目录清理） */
function makeApi(dataDir, apis) {
  const { api } = makeApiIn(dataDir, { config: realConfig });
  apis.push(api);
  return api;
}

async function cleanup(apis, dataDir) {
  for (const api of apis) {
    if (api._saveTimer) clearInterval(api._saveTimer);
    if (api._streamTimer) clearInterval(api._streamTimer);
    await settleApi(api);
  }
  await dispose(dataDir);
}

const legacyPoolFile = (dataDir) => path.join(savesOf(dataDir), 'experiences.json');
const legacyOwnerMarker = (dataDir) => path.join(dataDir, 'migrations', 'legacy-experience-owner');
const profilePoolFile = (dataDir, pid) => path.join(dataDir, 'profiles', pid, 'experiences.json');

/**
 * 局终经验入库（走 Api 的真实路径：generateLessons → experienceFor(owner) → add）。
 * 只替换"复盘产生的那一步"（agent.generateLessons），登记与落盘全用真实实现。
 */
async function writeLessons(api, ownerProfileId, text, role) {
  await api.generateLessons({
    ownerProfileId,
    mock: false,
    game: {
      id: 'g-' + crypto.randomBytes(4).toString('hex'),
      finished: true, started: true, parallelLlm: false,
      _agents: new Map([[1, { player: { seat: 1, role }, generateLessons: async () => [{ role, text }] }]]),
    },
  });
}

/**
 * 以 `pid` 建一局真实对局（不联网、不驱动 AI）→ 真实发牌 → 给**同一角色**在 `pid` 与 `otherPid`
 * 各写一条标记经验 → 构造 1 号座真实 Agent，返回它实际注入的 system 文本与经验池文件。
 * 两个档案在同角色上都有经验，于是"注入了谁的经验"是可判定的（不是角色不同造成的假绿）。
 *
 * ⚠ 标记必须**每次调用唯一**（带随机 nonce）：同一个档案会在本文件里被探多次，而经验池是按角色
 * 累积的 —— 上一次探针留下的标记若与本次同名，就会在同角色上被一起注入，断言"没注入别人的经验"
 * 会假红（首次全量跑真的红过：甲的开局读到了乙的标记，因为那是上一轮写进甲池的自己的标记）。
 *
 * ⚠⚠ nonce 只解决了上面那一半。它保证"每次调用的两个标记彼此不同名"，所以
 * `text.includes(本轮 mine / theirs)` 这类**点名到本轮标记**的判定是可靠的；但它**不解决**
 * "同一个档案 + 同一个角色上已经积累了历次探针的标记"。因此，任何在探针**之后**对**整个角色
 * 数组**做 `deepStrictEqual` 的断言，都会把"探针自己早先合法写进去的标记"误判成"外来继承"：
 *   · `injectProbe(api, pid, markerPid, otherPid)` 会把 `目标档案标记-<tag>` 写进 markerPid、
 *     把 `对照档案标记-<tag>` 写进 otherPid，而两者用的是**发牌随机出的同一个角色** `me.role`；
 *   · 于是同一个档案在同一角色上被先后探多次时，池里会留下多条标记（这是**测试自己写的**，
 *     不是继承）；
 *   · 断言"整个角色数组等于某值"就会假红，且只在两次探针**随机撞到同一角色**时触发
 *     （`quick10` 下发牌随机 ⇒ 约 1/10，与实测 5/40 吻合）。
 * 结论（M0「新建档案/改昵称/重名」那条用例踩过这个坑，修法见该用例内的注释）：
 *   · 判"有没有继承"要用**本轮标记**（本轮 mine 必在、本轮 theirs 必不在），不要用整数组相等；
 *   · 若确实需要"整数组 == 某值"的语义，期望值必须把本轮探针合法写进该池的标记算进去，
 *     或者改用没被探过的档案。
 */
async function injectProbe(api, pid, markerPid, otherPid) {
  const players = Array.from({ length: 10 }, (_, i) => ({ name: 'P' + (i + 1), isHuman: i === 0 }));
  const created = await call(api, 'POST', '/api/games', { boardId: 'quick10', players, mock: false, profileId: pid });
  assert.strictEqual(created.status, 200, `前置：应以 ${pid} 建局成功：${JSON.stringify(created.body)}`);
  const entry = api.games.get(created.body.gameId);
  assert.ok(entry, '前置：对局应进入内存表');
  entry.game.deal(); // 真实发牌（角色分配的唯一入口），不驱动 AI
  const me = entry.game.players[0];
  const tag = crypto.randomBytes(4).toString('hex');
  const mine = `目标档案标记-${tag}`;
  const theirs = `对照档案标记-${tag}`;
  await writeLessons(api, markerPid, mine, me.role);
  await writeLessons(api, otherPid, theirs, me.role);
  const agent = entry.game.agentFor(me.seat);
  const content = agent.messages[0].content;
  const text = Array.isArray(content) ? content.map((c) => c.text || '').join('') : String(content);
  return { role: me.role, file: agent.experienceStore.file, text, mine, theirs };
}

test('M0 数据归属：归档默认档案后旧经验池仍属原 UUID，接任档案不继承（两方向 + 真实注入）', async () => {
  const dataDir = makeDataDir('exp-own-archive');
  const apis = [];
  try {
    const api = makeApi(dataDir, apis);
    await settleApi(api);
    const A = api.defaultProfileId; // 迁移自动创建的「默认玩家」
    assert.match(String(A), UUID, '前置：迁移应建出默认档案');
    assert.strictEqual(fs.readFileSync(legacyOwnerMarker(dataDir), 'utf8').trim(), A,
      '旧经验池的归属必须在迁移时钉在默认档案 UUID 上');

    await writeLessons(api, A, 'A1-原始默认档案的教训', 'seer');
    assert.strictEqual(api.experienceFor(A).file, legacyPoolFile(dataDir), '默认档案的经验池 = 旧池（零拷贝迁移）');
    assert.deepStrictEqual(api.experienceFor(A).forRole('seer'), ['A1-原始默认档案的教训']);

    const B = (await call(api, 'POST', '/api/profiles', { nickname: '乙' })).body.profile.id;
    assert.strictEqual(api.experienceFor(B).file, profilePoolFile(dataDir, B), '非默认档案各自持有独立池');
    assert.deepStrictEqual(api.experienceFor(B).forRole('seer'), [], '前置：新档案起始是空池');

    const ar = await call(api, 'PATCH', `/api/profiles/${A}`, { archive: true });
    assert.strictEqual(ar.status, 200, JSON.stringify(ar.body));
    assert.strictEqual(api.defaultProfileId, B, '前置：归档默认档案后默认指向乙');

    // 方向1：原档案的经验池还在，且没有被改指到别人名下
    assert.strictEqual(api.experienceFor(A).file, legacyPoolFile(dataDir), '默认换了之后，旧池归属不得改指别人');
    assert.deepStrictEqual(api.experienceFor(A).forRole('seer'), ['A1-原始默认档案的教训'], '原档案的经验不得丢失');
    // 方向2：接任档案没有凭空继承
    assert.strictEqual(api.experienceFor(B).file, profilePoolFile(dataDir, B));
    assert.deepStrictEqual(api.experienceFor(B).forRole('seer'), [], '接任默认档案不得凭空继承旧经验池');

    // 乙的局终经验也不得写进甲的旧池
    await writeLessons(api, B, 'B1-乙自己的教训', 'seer');
    assert.deepStrictEqual(api.experienceFor(B).forRole('seer'), ['B1-乙自己的教训']);
    assert.deepStrictEqual(api.experienceFor(A).forRole('seer'), ['A1-原始默认档案的教训'], '乙的经验不得混进甲的旧池');

    // 真实注入两方向（同角色对照）：乙的局读乙的池，甲的局读甲的池
    await call(api, 'PATCH', `/api/profiles/${A}`, { restore: true }); // 恢复到可用，才能以甲建局
    const injB = await injectProbe(api, B, B, A);
    assert.ok(injB.text.includes(injB.mine), `乙的开局应注入乙自己的经验（角色 ${injB.role}）`);
    assert.strictEqual(injB.text.includes(injB.theirs), false,
      `乙的开局不得注入甲的经验（同角色 ${injB.role} 对照）`);
    const injA = await injectProbe(api, A, A, B);
    assert.ok(injA.text.includes(injA.mine), `甲的开局应注入甲自己的经验（角色 ${injA.role}）`);
    assert.strictEqual(injA.text.includes(injA.theirs), false,
      `甲的开局不得注入乙的经验（同角色 ${injA.role} 对照）`);
    assert.strictEqual(injA.file, legacyPoolFile(dataDir), '甲的开局注入来源仍是旧池');
  } finally {
    await cleanup(apis, dataDir);
  }
});

test('M0 数据归属：删除进回收站、从回收站恢复后旧经验池仍随原 UUID（不丢、不转移）', async () => {
  const dataDir = makeDataDir('exp-own-trash');
  const apis = [];
  try {
    const api = makeApi(dataDir, apis);
    await settleApi(api);
    const A = api.defaultProfileId;
    await writeLessons(api, A, 'A1-进回收站前的教训', 'seer');

    const B = (await call(api, 'POST', '/api/profiles', { nickname: '乙' })).body.profile.id;
    await call(api, 'PATCH', `/api/profiles/${A}`, { archive: true }); // 默认 → 乙
    const del = await call(api, 'DELETE', `/api/profiles/${A}`);
    assert.strictEqual(del.status, 200, JSON.stringify(del.body));
    assert.ok(del.body.archiveId, '前置：删除返回回收区 archiveId');
    assert.strictEqual(fs.existsSync(path.join(dataDir, 'profiles', A)), false, '前置：档案目录已进回收区');

    // 方向1：档案在回收站里，凭 UUID 仍指向并读得到自己的旧池
    assert.strictEqual(api.experienceFor(A).file, legacyPoolFile(dataDir), '进回收站不改变旧池归属');
    assert.deepStrictEqual(api.experienceFor(A).forRole('seer'), ['A1-进回收站前的教训'], '回收站期间经验不得丢失');
    // 方向2：接任档案没有继承
    assert.strictEqual(api.experienceFor(B).file, profilePoolFile(dataDir, B));
    assert.deepStrictEqual(api.experienceFor(B).forRole('seer'), [], '接任档案不得继承被删档案的经验');

    const trash = await call(api, 'GET', '/api/profiles/trash');
    const row = trash.body.items.find((x) => x.id === A);
    assert.ok(row, '前置：回收区应能列出被删档案');
    const restored = await call(api, 'POST', `/api/profiles/trash/${row.archiveId}/restore`);
    assert.strictEqual(restored.status, 200, JSON.stringify(restored.body));
    assert.strictEqual(restored.body.profile.id, A, '恢复必须回到同一个 UUID（身份不得变）');
    const un = await call(api, 'PATCH', `/api/profiles/${A}`, { restore: true });
    assert.strictEqual(un.status, 200, JSON.stringify(un.body));

    assert.strictEqual(api.experienceFor(A).file, legacyPoolFile(dataDir), '恢复后旧池归属不变');
    assert.deepStrictEqual(api.experienceFor(A).forRole('seer'), ['A1-进回收站前的教训'], '恢复后经验既没丢也没重复');
    assert.strictEqual(api.experienceFor(B).file, profilePoolFile(dataDir, B));
    assert.deepStrictEqual(api.experienceFor(B).forRole('seer'), [], '接任档案始终不得继承');
  } finally {
    await cleanup(apis, dataDir);
  }
});

test('M0 数据归属：切换默认选择（setDefaultId）与重启都不得搬动旧经验池', async () => {
  const dataDir = makeDataDir('exp-own-switch');
  const apis = [];
  try {
    const api = makeApi(dataDir, apis);
    await settleApi(api);
    const A = api.defaultProfileId;
    await writeLessons(api, A, 'A1-默认档案的教训', 'seer');

    const B = (await call(api, 'POST', '/api/profiles', { nickname: '乙' })).body.profile.id;

    // 直接切换默认选择（不归档）：内存与磁盘标记一起指向乙 —— 与"归档触发重指向"是同一类突变
    api.profileMigration.setDefaultId(B);
    api.defaultProfileId = B;
    assert.strictEqual(api.experienceFor(A).file, legacyPoolFile(dataDir), '切默认后甲的旧池归属不变');
    assert.deepStrictEqual(api.experienceFor(A).forRole('seer'), ['A1-默认档案的教训'], '切默认不得让甲丢经验');
    assert.strictEqual(api.experienceFor(B).file, profilePoolFile(dataDir, B), '新默认档案拿的是自己的空池');
    assert.deepStrictEqual(api.experienceFor(B).forRole('seer'), [], '切默认不得把旧池交给新默认档案');

    // 重启（新 Api：新 ProfileStore + 新迁移重入）后归属与默认选择都不漂移
    const api2 = makeApi(dataDir, apis);
    await settleApi(api2);
    assert.strictEqual(api2.defaultProfileId, B, '重启后默认档案应是切过去的那一份');
    assert.strictEqual(fs.readFileSync(legacyOwnerMarker(dataDir), 'utf8').trim(), A, '重启不得改写旧池归属标记');
    assert.strictEqual(api2.experienceFor(A).file, legacyPoolFile(dataDir));
    assert.deepStrictEqual(api2.experienceFor(A).forRole('seer'), ['A1-默认档案的教训'], '重启后甲的经验仍在');
    assert.strictEqual(api2.experienceFor(B).file, profilePoolFile(dataDir, B));
    assert.deepStrictEqual(api2.experienceFor(B).forRole('seer'), [], '重启后乙仍不得继承');
  } finally {
    await cleanup(apis, dataDir);
  }
});

test('M0 数据归属：默认档案消失后由 ensureDefaultProfile() 重建，新档案不得继承旧经验池', async () => {
  const dataDir = makeDataDir('exp-own-rebuild');
  const apis = [];
  try {
    const api = makeApi(dataDir, apis);
    await settleApi(api);
    const A = api.defaultProfileId;
    await writeLessons(api, A, 'A1-原始默认档案的教训', 'seer');

    const B = (await call(api, 'POST', '/api/profiles', { nickname: '乙' })).body.profile.id;
    await call(api, 'PATCH', `/api/profiles/${A}`, { archive: true }); // 默认 → 乙
    // 模拟"默认档案的档案文件被外部损毁"（用户手工删目录/杀软误删）：重建路径由 ensureDefaultProfile 走
    fs.rmSync(path.join(dataDir, 'profiles', B), { recursive: true, force: true });

    const api2 = makeApi(dataDir, apis);
    await settleApi(api2);
    const C = api2.defaultProfileId;
    assert.match(String(C), UUID, '重建路径应产出新的默认档案');
    assert.notStrictEqual(C, A, '重建出的默认档案必须是新 UUID');
    assert.notStrictEqual(C, B, '重建出的默认档案不是消失的那一份');
    assert.strictEqual(fs.readFileSync(legacyOwnerMarker(dataDir), 'utf8').trim(), A,
      '重建默认档案不得改写旧池归属标记');

    // 方向2：重建出的默认档案不得继承旧池
    assert.strictEqual(api2.experienceFor(C).file, profilePoolFile(dataDir, C), '重建档案拿自己的空池');
    assert.deepStrictEqual(api2.experienceFor(C).forRole('seer'), [], '重建默认档案不得继承旧经验池');
    // 方向1：原档案（甲方，仍在归档态）的经验还在自己名下
    assert.strictEqual(api2.experienceFor(A).file, legacyPoolFile(dataDir));
    assert.deepStrictEqual(api2.experienceFor(A).forRole('seer'), ['A1-原始默认档案的教训'], '甲的旧经验不得丢');

    await call(api2, 'PATCH', `/api/profiles/${A}`, { restore: true });
    const injC = await injectProbe(api2, C, C, A);
    assert.ok(injC.text.includes(injC.mine), `重建档案的开局注入自己的经验（角色 ${injC.role}）`);
    assert.strictEqual(injC.text.includes(injC.theirs), false,
      `重建档案的开局不得注入甲的旧经验（同角色 ${injC.role} 对照）`);
  } finally {
    await cleanup(apis, dataDir);
  }
});

test('M0 数据归属：新建档案/改昵称/重名都不得转移归属（身份只认 UUID）', async () => {
  const dataDir = makeDataDir('exp-own-nickname');
  const apis = [];
  try {
    const api = makeApi(dataDir, apis);
    await settleApi(api);
    const A = api.defaultProfileId;
    assert.strictEqual((await call(api, 'GET', '/api/profiles')).body.profiles.find((p) => p.id === A).nickname,
      '默认玩家', '前置：迁移建的默认档案昵称是「默认玩家」');
    await writeLessons(api, A, 'A1-甲自己的教训', 'seer');

    // D 用与甲**原昵称**完全相同的昵称新建：不得因此继承
    const D = (await call(api, 'POST', '/api/profiles', { nickname: '默认玩家' })).body.profile.id;
    assert.notStrictEqual(D, A, '同昵称也是另一份身份（UUID 不同）');
    assert.strictEqual(api.experienceFor(D).file, profilePoolFile(dataDir, D), '同昵称新档案走自己的池');
    assert.deepStrictEqual(api.experienceFor(D).forRole('seer'), [], '同昵称新档案不得继承旧池');

    const injD = await injectProbe(api, D, D, A);
    assert.ok(injD.text.includes(injD.mine), `同昵称档案注入自己的经验（角色 ${injD.role}）`);
    assert.strictEqual(injD.text.includes(injD.theirs), false,
      `同昵称档案不得注入甲的经验（同角色 ${injD.role} 对照）`);

    // 改昵称：先改 D，再让甲改成与 D 相同的昵称 —— 两人的池都不许换主
    const dStore = api.experienceFor(D).file;
    const renD = await call(api, 'PATCH', `/api/profiles/${D}`, { nickname: '甲' });
    assert.strictEqual(renD.status, 200, JSON.stringify(renD.body));
    assert.strictEqual(api.experienceFor(D).file, dStore, '改昵称不得改变经验池归属');
    const renA = await call(api, 'PATCH', `/api/profiles/${A}`, { nickname: '甲' });
    assert.strictEqual(renA.status, 200, JSON.stringify(renA.body));
    assert.strictEqual(api.experienceFor(A).file, legacyPoolFile(dataDir), '甲改名后仍是旧池的归属者');
    // 甲改名后：自己的教训仍在，且**不得**混进别的档案的经验。
    //
    // 这里原来写的是 `deepStrictEqual(api.experienceFor(A).forRole('seer'), ['A1-甲自己的教训'])`，
    // 它是本文件唯一的间歇假红（实测改前 5/40，全部挂在用例名「…新建档案/改昵称/重名…」上）：
    // 上面那句 `injectProbe(api, D, D, A)` 里 **A 是 otherPid**，探针会合法地把本轮的
    // `对照档案标记-<tag>` 写进甲的 seer 池；发牌一旦把那次探针的角色随机到 `seer`，
    // 整数组相等就必然假红（机制/概率见 :110-127 的 ⚠⚠ 说明）。根因是"测试自己造成的池内污染"，
    // 不是产品缺陷，所以修测试——但**不降低强度**，改成下面三条定向判定：
    //   ① 甲自己的教训必须在（= 原断言"不丢"的那一半）；
    //   ② 本轮探针写给 D 的 `mine`（= D 的经验）绝不许出现在甲的池里（= "别的档案的经验被注入进来"
    //      这个真缺陷；点名到本轮 nonce，不受历史标记干扰）；
    //   ③ 甲的 seer 池仍要求**恰好**等于本轮已知写入它的多重集（唯一允许的"外来"条目就是 ②里探针
    //      合法写进甲池的那条对照标记，且仅当探针角色恰好是 seer 时存在）——任何未知条目、丢失、
    //      重复依旧判红。③ 用 sort 后的多重集比较，只看"有哪些条目"，不看顺序（forRole 是最新在前，
    //      依赖顺序只会再添一处脆弱）。
    const aSeer = api.experienceFor(A).forRole('seer');
    assert.ok(aSeer.includes('A1-甲自己的教训'), '甲改名后自己的经验仍在（不得丢失）');
    assert.strictEqual(aSeer.includes(injD.mine), false,
      `甲改名后不得注入 D 的经验（本轮同角色 ${injD.role} 处的探针标记）`);
    const aSeerExpected = injD.role === 'seer' ? [injD.theirs, 'A1-甲自己的教训'] : ['A1-甲自己的教训'];
    assert.deepStrictEqual([...aSeer].sort(), [...aSeerExpected].sort(),
      '甲改名后 seer 池只应含自己的教训（+ 本轮探针合法写进甲池的对照标记）');
    assert.strictEqual(api.experienceFor(D).file, dStore, '甲改成与 D 同名后，D 的池没被换掉');
    assert.strictEqual(fs.readFileSync(legacyOwnerMarker(dataDir), 'utf8').trim(), A, '改名不得改写旧池归属标记');

    // 再新建一个同样叫「甲」的档案：同样不得继承
    const E = (await call(api, 'POST', '/api/profiles', { nickname: '甲' })).body.profile.id;
    assert.strictEqual(api.experienceFor(E).file, profilePoolFile(dataDir, E), '第三个同名档案也走自己的池');
    assert.deepStrictEqual(api.experienceFor(E).forRole('seer'), [], '第三个同名档案不得继承旧池');
    assert.notStrictEqual(E, A, '前置：E 与 A 是不同身份');
  } finally {
    await cleanup(apis, dataDir);
  }
});

test('M0 数据归属：归属标记原子写/幂等/写后校验，损坏或丢失时失败关闭（不猜、不转移）', async () => {
  const dataDir = makeDataDir('exp-own-marker');
  const apis = [];
  try {
    const api = makeApi(dataDir, apis);
    await settleApi(api);
    const A = api.defaultProfileId;
    const marker = legacyOwnerMarker(dataDir);
    assert.strictEqual(fs.readFileSync(marker, 'utf8').trim(), A);
    // 原子写：临时文件 + rename，不留 `.tmp-*` 残渣（命名走 src/tmp-files.js）
    assert.deepStrictEqual(fs.readdirSync(path.join(dataDir, 'migrations')).filter((n) => n.startsWith('.tmp-')), [],
      '归属标记的原子写不得留下临时文件');

    // 幂等：显式再钉一次别的档案，返回原归属且不改写文件
    const attempt = api.profileMigration.pinLegacyExperienceOwner('11111111-2222-3333-4444-555555555555');
    assert.strictEqual(attempt, A, '已钉过的归属不得被改写（幂等）');
    assert.strictEqual(fs.readFileSync(marker, 'utf8').trim(), A, '磁盘上的归属标记必须原样保留');

    await writeLessons(api, A, 'A1-旧池里的教训', 'seer');
    const B = (await call(api, 'POST', '/api/profiles', { nickname: '乙' })).body.profile.id;
    await call(api, 'PATCH', `/api/profiles/${A}`, { archive: true }); // 默认 → 乙

    // ① 标记损坏 → 失败关闭：没有任何档案继承旧池，旧数据也不许被改
    fs.writeFileSync(marker, 'not-a-uuid');
    const api2 = makeApi(dataDir, apis);
    await settleApi(api2);
    assert.strictEqual(api2.legacyExperienceOwnerId(), null, '损坏的归属标记不得被当成有效归属');
    assert.strictEqual(api2.experienceFor(api2.defaultProfileId).file, profilePoolFile(dataDir, B),
      '失败关闭：当前默认档案不得继承无主的旧池');
    assert.deepStrictEqual(api2.experienceFor(api2.defaultProfileId).forRole('seer'), []);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(legacyPoolFile(dataDir), 'utf8')).byRole.seer.map((x) => x.text),
      ['A1-旧池里的教训'], '失败关闭期间旧池数据必须原样留在磁盘上');
    assert.strictEqual(fs.readFileSync(marker, 'utf8').trim(), 'not-a-uuid', '损坏标记不得被静默改写成别的归属');

    // ② 标记丢失（游标记录已钉过）→ 同样失败关闭：不重新指定归属
    fs.rmSync(marker, { force: true });
    const api3 = makeApi(dataDir, apis);
    await settleApi(api3);
    assert.strictEqual(fs.existsSync(marker), false, '标记丢失后不得凭空重钉（那等于把旧池交给当前默认档案）');
    assert.strictEqual(api3.legacyExperienceOwnerId(), null);
    assert.strictEqual(api3.experienceFor(api3.defaultProfileId).file, profilePoolFile(dataDir, B),
      '标记丢失也不得让任何档案继承旧池');
  } finally {
    await cleanup(apis, dataDir);
  }
});

/**
 * 升级路径（主控裁决 1：**采纳"当时的持久化默认档案"并立即冻结**）。
 *
 * 场景：修复前的安装没有归属标记（`migrations/legacy-experience-owner` 不存在，游标里也没有
 * exp-owner 步），但磁盘上已经有旧池 saves/experiences.json。首次启动后：
 *   ① 标记必须写成**当时持久化默认档案**的 UUID，旧池归它（不能因为"理论原主是谁"而拒绝采纳，
 *      那会让活跃玩家静默丢经验）；
 *   ② 采纳之后**立即冻结**：再切默认（setDefaultId）或重启都不得改写标记、不得搬动旧池；
 *   ③ 反复重入（多次重启）必须幂等。
 * ②③ 正是用来区分"采纳并冻结"与"每次启动同步成当前默认"（后者是反向验证里的 I4 坏形态）。
 *
 * 构造边界（如实说明）：这是**在磁盘上重建"修复前老安装"的形态**，不是手工塞内存字段 ——
 *   · 默认档案的"已被换过"由真实写点 `ProfileMigration.setDefaultId()`（与 _repointDefaultProfile
 *     同一个调用）落盘到 migrations/default-profile-id；
 *   · 缺少归属标记 = `rm` 掉标记文件；游标缺少 exp-owner 步 = 改写 migrations/profiles-v1.json
 *     （修复前的代码根本不写这个文件，所以这是老安装的真实磁盘形态）；
 *   · 旧池内容直接写成 ExperienceStore 的既有格式（老安装本来就长这样）；
 *   · "启动"用真实流程：new Api() → 构造函数里的 ProfileMigration.run()（不是手工改内存字段）。
 */
test('M0 数据归属：升级（老安装无标记）首次启动采纳当时的持久化默认并立即冻结，此后切默认/重启都不搬动', async () => {
  const dataDir = makeDataDir('exp-own-upgrade');
  const apis = [];
  try {
    const api = makeApi(dataDir, apis);
    await settleApi(api);
    const X = api.defaultProfileId; // 迁移创建的原始默认档案（"理论原主"）
    const Y = (await call(api, 'POST', '/api/profiles', { nickname: '乙' })).body.profile.id;

    // ---- 构造"修复前的老安装"磁盘形态：默认已是乙、没有归属标记、游标里没有 exp-owner ----
    api.profileMigration.setDefaultId(Y); // 真实写点：持久化默认标记 → 乙
    fs.writeFileSync(legacyPoolFile(dataDir),
      JSON.stringify({ version: 1, byRole: { seer: [{ text: 'Y1-老安装里的旧教训', createdAt: 1 }] } }));
    const marker = legacyOwnerMarker(dataDir);
    fs.rmSync(marker, { force: true });
    const cursorFile = path.join(dataDir, 'migrations', 'profiles-v1.json');
    const cursor = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
    assert.ok(cursor.done.includes('exp'), '前置：老安装的游标里有 exp 步（旧池已归属默认档案）');
    cursor.done = cursor.done.filter((s) => s !== 'exp-owner'); // 修复前的代码没有这一步
    fs.writeFileSync(cursorFile, JSON.stringify(cursor, null, 2));
    assert.strictEqual(fs.existsSync(marker), false, '前置：老安装没有归属标记');
    assert.strictEqual(X === Y, false, '前置：原始默认档案与"已被换过"的默认档案是两份身份');

    // ---- ① 首次启动（真实启动流程）⇒ 采纳当时的持久化默认档案 ----
    const up = makeApi(dataDir, apis);
    await settleApi(up);
    assert.strictEqual(up.defaultProfileId, Y, '前置：老安装的持久化默认仍是乙');
    assert.strictEqual(fs.readFileSync(marker, 'utf8').trim(), Y,
      '无标记的老安装首次启动必须采纳**当时的持久化默认档案**（而不是拒绝采纳或回溯理论原主）');
    assert.strictEqual(up.legacyExperienceOwnerId(), Y);
    assert.strictEqual(up.experienceFor(Y).file, legacyPoolFile(dataDir), '旧池归采纳到的那份档案');
    assert.deepStrictEqual(up.experienceFor(Y).forRole('seer'), ['Y1-老安装里的旧教训'], '采纳后旧池的经验可读（不丢）');
    assert.deepStrictEqual(up.experienceFor(X).forRole('seer'), [], '原默认档案不得因升级拿到别人的池');

    // ---- ② 采纳后立即冻结：再切默认 + 重启，标记与旧池都不许动 ----
    const Z = (await call(up, 'POST', '/api/profiles', { nickname: '丙' })).body.profile.id;
    up.profileMigration.setDefaultId(Z);
    up.defaultProfileId = Z;
    const up2 = makeApi(dataDir, apis);
    await settleApi(up2);
    assert.strictEqual(up2.defaultProfileId, Z, '前置：重启后默认档案是丙');
    assert.strictEqual(fs.readFileSync(marker, 'utf8').trim(), Y,
      '采纳后必须冻结：重启不得把归属同步成"当前默认档案"（那正是要禁止的继承路径）');
    assert.strictEqual(up2.experienceFor(Y).file, legacyPoolFile(dataDir), '旧池仍归乙');
    assert.deepStrictEqual(up2.experienceFor(Y).forRole('seer'), ['Y1-老安装里的旧教训']);
    assert.strictEqual(up2.experienceFor(Z).file, profilePoolFile(dataDir, Z), '丙拿自己的池');
    assert.deepStrictEqual(up2.experienceFor(Z).forRole('seer'), [], '切默认 + 重启都不得让丙继承旧池');

    // ---- ③ 反复重入（第三次启动）仍然幂等 ----
    const up3 = makeApi(dataDir, apis);
    await settleApi(up3);
    assert.strictEqual(fs.readFileSync(marker, 'utf8').trim(), Y, '反复重启也不得改写归属（幂等）');
    assert.strictEqual(up3.experienceFor(Y).file, legacyPoolFile(dataDir));
    assert.deepStrictEqual(up3.experienceFor(Y).forRole('seer'), ['Y1-老安装里的旧教训']);
    assert.deepStrictEqual(up3.experienceFor(Z).forRole('seer'), [], '第三次启动后丙仍不得继承旧池');
  } finally {
    await cleanup(apis, dataDir);
  }
});
