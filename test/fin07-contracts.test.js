/**
 * fin07-contracts.test.js — FIN-07 档案/标注契约核验（计划书 §11 十二行核验面的服务端回归）
 *
 * 定位：只锁"服务端契约与 HTTP/存储层行为"，不碰 DOM/界面细节（UI 断言归 FIN-12 主控浏览器验收）。
 * 逐行对应（§11 表）：
 *   R1  当前档案与 owner 固定      → 归属创建时锁定，后续操作不串档
 *   R2  进行中切档安全（服务端半） → activeGames 拒删已归档档案
 *   R3  多窗口迟到响应             → expectedRevision 409 + 取消路径零部分覆盖
 *   R4  偏好白名单（服务端半）     → fontScale/layout/reducedMotion 收敛；安装级字段不进档案
 *   R5  战绩分桶                   → mock/观战/终止分桶 + crush 动态阵营还原
 *   R7  三层身份信息（审计扩展）   → src/engine、src/ai 全部模块不引用私人标注
 *   R8  候选与自称（重点核验）     → 服务端无"排除自己唯一身份"限制；候选 ≤3 固化
 *   R11 笔记保存/清除不动游戏状态 → PUT 前后 seq/phase/day/pending/事件数全不变
 *   R12 视角切换不残留高权限信息  → 玩家 token 视图无上帝字段；god↔player 往返无残留
 * （R6 导入导出 20MiB → test/import-rollback.test.js 的超限包用例；R9 待确认旧标记 mergeLegacyTags
 *  → test/annotations-model.test.js 已有；R10 草稿与断网为纯前端状态，无服务端契约，登记待浏览器验收。）
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const events = require('events');

const { Api } = require('../src/api');
const { Game } = require('../src/engine/game');
const { normalizeSeatAnnotation } = require('../src/annotations/store');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {}, query() { return []; } };

function makeApi(tag) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `fin07-${tag}-`));
  const savesDir = path.join(dataDir, 'saves');
  const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: savesDir });
  return { api, dataDir, savesDir };
}

function stubReq({ method = 'GET', headers = {}, body = null, raw = null } = {}) {
  const req = new events.EventEmitter();
  req.method = method;
  req.headers = headers;
  req.socket = { remoteAddress: '127.0.0.1' };
  process.nextTick(() => {
    if (raw !== null) req.emit('data', raw);
    else if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function stubRes() {
  const box = { headers: {} };
  box.res = {
    writeHead(code, headers) { box.code = code; Object.assign(box.headers, headers || {}); },
    end(b) { box.raw = b; },
    setHeader(k, v) { box.headers[k.toLowerCase()] = v; },
  };
  return box;
}

async function call(api, method, pathname, body, raw) {
  const u = new URL(pathname, 'http://localhost');
  const box = stubRes();
  const req = stubReq({ method, headers: { host: 'localhost:3210' }, body, raw });
  await api.handle(req, box.res, u.pathname, u.searchParams);
  return { status: box.code, raw: box.raw != null ? String(box.raw) : null, body: box.raw ? JSON.parse(box.raw) : null };
}

const BOARD5 = { wolf: 1, seer: 1, witch: 1, villager: 2 };
const players5 = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: i === 0 }));

/** 造一局挂在内存里的 Mock 局（不驱动引擎）：照 profiles-api.test.js 的成熟模式 */
function makeGameEntry(api, gid, ownerProfileId) {
  const g = new Game({ id: gid, board: BOARD5, players: players5.map((p) => ({ ...p })), stepPauseMs: 1, logger: silentLogger });
  g.deal();
  g.started = true;
  const entry = { game: g, running: false, error: null, mock: true, tokens: { player: 'pt-' + gid, god: 'gt-' + gid }, ownerProfileId, createdAt: Date.now(), lastAccess: Date.now(), review: null };
  api.games.set(gid, entry);
  return entry;
}

// ---------- R1 当前档案与 owner 固定 ----------
test('FIN-07 R1 owner 固定：归属创建时锁定；后续建局/切档不改变既有局存盘与标注归属', async () => {
  const { api, dataDir, savesDir } = makeApi('owner');
  try {
    await api._profileMigrationReady;
    const a = await call(api, 'POST', '/api/profiles', { nickname: '甲' });
    const b = await call(api, 'POST', '/api/profiles', { nickname: '乙' });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);
    const pidA = a.body.profile.id;
    const pidB = b.body.profile.id;

    // 甲建局（显式携带 profileId）
    const g1 = await call(api, 'POST', '/api/games', { board: BOARD5, mock: true, players: players5, profileId: pidA });
    assert.strictEqual(g1.status, 200, `建局失败：${JSON.stringify(g1.body)}`);
    const gid1 = g1.body.gameId;

    // 非法/不存在/已归档的 profileId 必须在建局入口被拒
    const bad = await call(api, 'POST', '/api/games', { board: BOARD5, mock: true, players: players5, profileId: 'not-a-uuid' });
    assert.strictEqual(bad.status, 400, '非法 profileId 必须 400');
    const ghost = await call(api, 'POST', '/api/games', { board: BOARD5, mock: true, players: players5, profileId: '00000000-0000-4000-8000-000000000000' });
    assert.strictEqual(ghost.status, 400, '不存在的 profileId 必须 400');

    // 随后乙建第二局（模拟"换了当前档案"）：第一局的落盘归属不得改变
    const g2 = await call(api, 'POST', '/api/games', { board: BOARD5, mock: true, players: players5, profileId: pidB });
    assert.strictEqual(g2.status, 200);
    const doc1 = JSON.parse(fs.readFileSync(path.join(savesDir, `${gid1}.json`), 'utf8'));
    const doc2 = JSON.parse(fs.readFileSync(path.join(savesDir, `${g2.body.gameId}.json`), 'utf8'));
    assert.strictEqual(doc1.ownerProfileId, pidA, '先建局的存档归属必须仍是甲（创建时锁定）');
    assert.strictEqual(doc1.ownerNicknameSnapshot, '甲');
    assert.strictEqual(doc2.ownerProfileId, pidB, '后建局归属是乙，两者不得串');

    // 标注归属 = 对局 owner 档案：乙的档案目录里不得出现甲那局笔记
    makeGameEntry(api, gid1, pidA);
    const put = await call(api, 'PUT', `/api/games/${gid1}/annotations`, { token: `pt-${gid1}`, expectedRevision: 0, seats: { 3: { leaning: 'lean_wolf', note: '甲的笔记' } } });
    assert.strictEqual(put.status, 200, `标注失败：${JSON.stringify(put.body)}`);
    const annoDirB = path.join(api.profiles.root, pidB, 'annotations');
    assert.ok(!fs.existsSync(annoDirB) || fs.readdirSync(annoDirB).length === 0, '甲局笔记绝不能落进乙的档案目录');
    assert.ok(fs.existsSync(path.join(api.profiles.root, pidA, 'annotations', `${gid1}.json`)), '笔记必须归属甲的档案目录');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

// ---------- R2 进行中切档（服务端半）：activeGames 拒删 ----------
test('FIN-07 R2 activeGames 拒删：有进行中对局的已归档档案删除被拒，结算后放行', async () => {
  const { api, dataDir } = makeApi('active');
  try {
    await api._profileMigrationReady;
    const p = await call(api, 'POST', '/api/profiles', { nickname: '进行中' });
    const pid = p.body.profile.id;
    const g = await call(api, 'POST', '/api/games', { board: BOARD5, mock: true, players: players5, profileId: pid });
    assert.strictEqual(g.status, 200);
    makeGameEntry(api, g.body.gameId, pid); // game.started=true, finished=false → 进行中

    const ar = await call(api, 'PATCH', `/api/profiles/${pid}`, { archive: true });
    assert.strictEqual(ar.status, 200, `归档失败：${JSON.stringify(ar.body)}`);

    const del = await call(api, 'DELETE', `/api/profiles/${pid}`);
    assert.strictEqual(del.status, 400, `有进行中对局必须拒绝删除（实际 ${del.status}：${JSON.stringify(del.body)}）`);
    assert.match(del.body.error, /进行中/, '错误必须说明"仍有对局进行中"');
    assert.ok(api.profiles.get(pid), '被拒后档案必须原样保留');

    // 结算该局后放行
    api.games.get(g.body.gameId).game.finished = true;
    api.games.get(g.body.gameId).game.phase = 'ended';
    const del2 = await call(api, 'DELETE', `/api/profiles/${pid}`);
    assert.strictEqual(del2.status, 200, `结算后删除应放行：${JSON.stringify(del2.body)}`);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

// ---------- R3 多窗口迟到响应：409 + 取消路径零部分覆盖 ----------
test('FIN-07 R3 迟到响应 409 后服务端原文与 revision 原样（取消/放弃路径不部分覆盖）', async () => {
  const { api, dataDir } = makeApi('late');
  try {
    const p = await call(api, 'POST', '/api/profiles', { nickname: '双窗客' });
    const pid = p.body.profile.id;
    const entry = makeGameEntry(api, 'late-g1', pid);
    void entry;

    const w1 = await call(api, 'PUT', '/api/games/late-g1/annotations', { token: 'pt-late-g1', expectedRevision: 0, seats: { 4: { leaning: 'lean_wolf', note: '窗口一已保存', confidence: 'high' } } });
    assert.strictEqual(w1.status, 200);
    const rev1 = w1.body.revision;
    assert.strictEqual(rev1, 1);

    // 窗口二拿旧版本迟到写入 → 409
    const w2 = await call(api, 'PUT', '/api/games/late-g1/annotations', { token: 'pt-late-g1', expectedRevision: 0, seats: { 4: { leaning: 'lean_good', note: '窗口二的迟到修改' } } });
    assert.strictEqual(w2.status, 409, '过期 revision 必须 409');
    assert.match(w2.body.error, /另一窗口/, '409 必须说明冲突来源');

    // 取消路径：被拒的写不得部分生效——原文与 revision 都不动
    const got = await call(api, 'GET', '/api/games/late-g1/annotations?token=pt-late-g1');
    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.body.revision, rev1, '409 后 revision 不得前进');
    assert.strictEqual(got.body.annotations.seats[4].note, '窗口一已保存', '被拒写不得覆盖原备注');
    assert.strictEqual(got.body.annotations.seats[4].leaning, 'lean_wolf', '被拒写不得改原倾向');

    // 档案 PATCH 同一语义：409 后昵称/revision 原样
    const prof = await call(api, 'GET', '/api/profiles');
    const mine = prof.body.profiles.find((x) => x.id === pid);
    const stale = await call(api, 'PATCH', `/api/profiles/${pid}`, { expectedRevision: mine.revision - 1, nickname: '迟到改名' });
    assert.strictEqual(stale.status, 409, '档案过期 PATCH 必须 409');
    const prof2 = await call(api, 'GET', '/api/profiles');
    assert.strictEqual(prof2.body.profiles.find((x) => x.id === pid).nickname, '双窗客', '被拒 PATCH 不得改名');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

// ---------- R4 偏好白名单（服务端半） ----------
test('FIN-07 R4 偏好白名单：三键收敛（fontScale≤3/layout 枚举/布尔），安装级字段绝不进档案', async () => {
  const { api, dataDir } = makeApi('pref');
  try {
    const p = await call(api, 'POST', '/api/profiles', { nickname: '设置客' });
    const pid = p.body.profile.id;
    assert.deepStrictEqual(p.body.profile.preferences, { fontScale: 1, layout: 'reading', reducedMotion: false }, '新档案偏好默认值');

    // 合法值生效
    const up = await call(api, 'PATCH', `/api/profiles/${pid}`, { preferences: { fontScale: 1.25, layout: 'compact', reducedMotion: true } });
    assert.strictEqual(up.status, 200);
    assert.deepStrictEqual(up.body.profile.preferences, { fontScale: 1.25, layout: 'compact', reducedMotion: true });

    // 非法值逐键回落 + 未知/安装级键一律丢弃（Key 不随档案走、不随包导出）
    const bad = await call(api, 'PATCH', `/api/profiles/${pid}`, { preferences: { fontScale: 99, layout: 'gamers', reducedMotion: 'yes', apiKey: 'SK-LIVE-SECRET', baseUrl: 'http://evil', theme: 'dark' } });
    assert.strictEqual(bad.status, 200, '白名单清洗是回落语义，不是整包拒绝');
    assert.strictEqual(bad.body.profile.preferences.fontScale, 3, 'fontScale 超上限必须钳到 3');
    assert.strictEqual(bad.body.profile.preferences.layout, 'compact', '非法 layout 必须保留原值');
    assert.strictEqual(bad.body.profile.preferences.reducedMotion, true, '非布尔 reducedMotion 必须保留原值');
    assert.strictEqual(bad.body.profile.preferences.apiKey, undefined, 'apiKey 绝不能进档案偏好');
    assert.strictEqual(bad.body.profile.preferences.baseUrl, undefined, 'baseUrl 绝不能进档案偏好');
    assert.strictEqual(bad.body.profile.preferences.theme, undefined, '白名单之外的字段必须丢弃');
    const list = await call(api, 'GET', '/api/profiles');
    assert.ok(!list.raw.includes('SK-LIVE-SECRET'), '安装级密钥不得经档案接口回显');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

// ---------- R5 战绩分桶 + crush 动态阵营还原 ----------
test('FIN-07 R5 战绩分桶：正式/Mock/观战/终止互斥，暗恋者按 crush 还原阵营计入胜负', async () => {
  const { api, dataDir, savesDir } = makeApi('stats');
  try {
    const p = await call(api, 'POST', '/api/profiles', { nickname: '战绩客' });
    const pid = p.body.profile.id;
    const mk = (id, doc) => {
      const base = { schemaVersion: 2, tokens: {}, ownerProfileId: pid, anchor: null, review: null, savedAt: 1, mock: false,
        game: { id, day: 2, phase: 'ended', started: true, finished: true, winner: 'wolf', winReason: '狼人全部出局', players: [], events: [], board: BOARD5, rules: {} } };
      doc(base);
      fs.writeFileSync(path.join(savesDir, `${id}.json`), JSON.stringify(base));
    };
    // ① 暗恋者绑狼（seat1 是狼）→ 阵营还原为 wolf，狼胜 = 胜
    mk('f07-cw', (d) => { d.game.players = [
      { seat: 1, name: 'A', isHuman: false, role: 'wolf' },
      { seat: 2, name: '我', isHuman: true, role: 'admirer' }]; d.game.crush = { 2: 1 }; });
    // ② 暗恋者绑民（seat3 是民）→ 阵营还原为 good，狼胜 = 负
    mk('f07-cg', (d) => { d.game.players = [
      { seat: 3, name: 'B', isHuman: false, role: 'villager' },
      { seat: 2, name: '我', isHuman: true, role: 'admirer' }]; d.game.crush = { 2: 3 }; });
    // ③ Mock 局（不进正式）
    mk('f07-mock', (d) => { d.mock = true; d.game.players = [{ seat: 1, name: '我', isHuman: true, role: 'seer' }]; });
    // ④ 观战局（无人类）
    mk('f07-spec', (d) => { d.game.players = [{ seat: 1, name: 'X', isHuman: false, role: 'wolf' }, { seat: 2, name: 'Y', isHuman: false, role: 'villager' }]; });
    // ⑤ 手动终止
    mk('f07-term', (d) => { d.game.winReason = '玩家手动终止对局'; d.game.players = [{ seat: 1, name: '我', isHuman: true, role: 'villager' }]; });

    const st = await call(api, 'GET', `/api/profiles/${pid}/stats`);
    assert.strictEqual(st.status, 200, JSON.stringify(st.body));
    assert.strictEqual(st.body.total, 5);
    assert.deepStrictEqual(st.body.byBucket, { real: 2, mock: 1, spectate: 1, terminated: 1 }, '四桶必须互斥且计数正确');
    assert.strictEqual(st.body.wins, 1, '绑狼还原成狼阵营 → 狼胜记 1 胜');
    assert.strictEqual(st.body.losses, 1, '绑民还原成好人阵营 → 狼胜记 1 负');
    assert.strictEqual(st.body.draws, 0);
    assert.ok(st.body.wins + st.body.losses <= st.body.real, '胜负只来自正式局');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

// ---------- R7 三层身份信息：静态审计扩展到全部引擎/AI 模块 ----------
test('FIN-07 R7 静态审计扩展：src/engine 与 src/ai 全部模块不得引用私人标注', () => {
  const root = path.join(__dirname, '..');
  const dirs = ['src/engine', 'src/ai'];
  let checked = 0;
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(root, d))) {
      if (!f.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(root, d, f), 'utf8');
      assert.ok(!src.includes('annotations'), `${d}/${f} 不得引用私人标注模块`);
      assert.ok(!src.includes('AnnotationStore'), `${d}/${f} 不得引用标注存储`);
      checked++;
    }
  }
  assert.ok(checked >= 20, `审计应覆盖全部引擎/AI 模块（实际 ${checked} 个）`);
});

// ---------- R8 候选与自称（§11 重点核验） ----------
test('FIN-07 R8 唯一身份自称：自己是局中唯一 seer，仍可把他人自称记录为 seer（normalize 无此限制→测试固化）', async () => {
  const { api, dataDir } = makeApi('claim');
  try {
    // 服务端存储层：normalize 对 claimedRoleId 只做格式白名单，没有"排除自己占用身份"的限制。
    // 这是刻意契约：前端 possibleRolesFor 负责候选池扣除，服务端绝不猜隐藏身份。
    const n = normalizeSeatAnnotation({ claimedRoleId: 'seer', candidateRoleIds: ['seer'] });
    assert.strictEqual(n.claimedRoleId, 'seer', '自称自己占用的唯一身份也必须能保存');

    const p = await call(api, 'POST', '/api/profiles', { nickname: '自称客' });
    const pid = p.body.profile.id;
    makeGameEntry(api, 'claim-g1', pid); // BOARD5 里 seer 恰好 1 个：玩家可能就是那唯一 seer

    // API 层：他座自称 seer（= 玩家自己可能的唯一身份）保存成功，且原文可读回
    const put = await call(api, 'PUT', '/api/games/claim-g1/annotations', {
      token: 'pt-claim-g1', expectedRevision: 0,
      seats: { 5: { claimedRoleId: 'seer', candidateRoleIds: ['seer'], note: '他跳预言家，但我才是真预言家', confidence: 'medium' } },
    });
    assert.strictEqual(put.status, 200, `自称保存失败：${JSON.stringify(put.body)}`);
    const got = await call(api, 'GET', '/api/games/claim-g1/annotations?token=pt-claim-g1');
    assert.strictEqual(got.body.annotations.seats[5].claimedRoleId, 'seer', '他人自称唯一身份必须原样持久化');
    assert.strictEqual(got.body.annotations.seats[5].note, '他跳预言家，但我才是真预言家');

    // 候选 ≤3 且去重（服务端最终防线，不信任前端）
    const cap = await call(api, 'PUT', '/api/games/claim-g1/annotations', {
      token: 'pt-claim-g1', expectedRevision: got.body.revision,
      seats: { 2: { candidateRoleIds: ['wolf', 'wolf', 'seer', 'witch', 'villager'] } },
    });
    assert.strictEqual(cap.status, 200);
    assert.deepStrictEqual(cap.body.annotations.seats[2].candidateRoleIds, ['wolf', 'seer', 'witch'], '候选必须去重并截到前 3 个');

    // 候选上限契约常量
    const { MAX_CANDIDATES } = require('../src/annotations/store');
    assert.strictEqual(MAX_CANDIDATES, 3, '候选上限常量必须为 3（§11：最多三个候选）');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

// ---------- R11 笔记保存/清除不触发游戏行动（HTTP 层） ----------
test('FIN-07 R11 标注 PUT 不触发游戏行动：seq/day/phase/pending/事件流全部不变', async () => {
  const { api, dataDir } = makeApi('noop');
  try {
    const p = await call(api, 'POST', '/api/profiles', { nickname: '笔记客' });
    const pid = p.body.profile.id;
    const entry = makeGameEntry(api, 'noop-g1', pid);
    const before = {
      seq: entry.game.seq, day: entry.game.day, phase: entry.game.phase,
      pending: entry.game.pending, events: entry.game.events.length,
    };
    assert.strictEqual(before.pending, null, '前置：局内当前无等待操作');
    // view 事件流是按可见性过滤后的（玩家视角），基线取同一视角的前值
    const viewBefore = await call(api, 'GET', '/api/games/noop-g1/view?token=pt-noop-g1&after=0');
    assert.strictEqual(viewBefore.status, 200);

    // 保存笔记
    const put = await call(api, 'PUT', '/api/games/noop-g1/annotations', { token: 'pt-noop-g1', expectedRevision: 0, seats: { 2: { leaning: 'lean_wolf', note: '记一笔' } } });
    assert.strictEqual(put.status, 200);
    // "清除"语义（前端覆写为默认值）同样只是一次标注写
    const clr = await call(api, 'PUT', '/api/games/noop-g1/annotations', { token: 'pt-noop-g1', expectedRevision: put.body.revision, seats: { 2: { leaning: 'neutral', note: '', confidence: 'low' } } });
    assert.strictEqual(clr.status, 200);

    const after = {
      seq: entry.game.seq, day: entry.game.day, phase: entry.game.phase,
      pending: entry.game.pending, events: entry.game.events.length,
    };
    assert.strictEqual(after.seq, before.seq, '标注写不得推进游戏事件序号');
    assert.strictEqual(after.day, before.day, '标注写不得推进天数');
    assert.strictEqual(after.phase, before.phase, '标注写不得改变阶段');
    assert.strictEqual(after.pending, null, '标注写不得制造等待操作（= 游戏行动）');
    assert.strictEqual(after.events, before.events, '标注写不得产生任何游戏事件');

    // 视图层同样干净：view 事件数与标注写之前一致（同一视角过滤口径）
    const v = await call(api, 'GET', '/api/games/noop-g1/view?token=pt-noop-g1&after=0');
    assert.strictEqual(v.status, 200);
    assert.strictEqual(v.body.events.length, viewBefore.body.events.length, 'view 事件流不得因标注写而增加');
    // 行动入口仍按原语义工作（没有 pending → 409），侧面证明没有笔记写入被当成行动
    const act = await call(api, 'POST', '/api/games/noop-g1/action', { token: 'pt-noop-g1', payload: {} });
    assert.strictEqual(act.status, 409, '无 pending 时 action 仍必须 409（标注写没有留下伪行动）');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

// ---------- R12 视角切换不残留高权限信息（view token 语义） ----------
test('FIN-07 R12 视角 token 语义：玩家视图无上帝字段/他人身份；god 往返后玩家视图零残留', async () => {
  const { api, dataDir } = makeApi('view');
  try {
    const p = await call(api, 'POST', '/api/profiles', { nickname: '视角客' });
    const pid = p.body.profile.id;
    const entry = makeGameEntry(api, 'view-g1', pid);
    void pid;
    const gid = 'view-g1';
    const humanSeat = entry.game.players.find((x) => x.isHuman).seat;
    const godOnly = (b) => b.llmStats !== undefined || b.scheduler !== undefined;

    // ① 玩家 token：只有自己（或已翻牌者）的身份；无上帝专属字段
    const pv = await call(api, 'GET', `/api/games/${gid}/view?token=pt-${gid}&after=0`);
    assert.strictEqual(pv.status, 200);
    assert.strictEqual(godOnly(pv.body), false, '玩家视图不得携带 llmStats/scheduler');
    assert.strictEqual(pv.body.me && pv.body.me.seat, humanSeat, 'me 必须是本人座位');
    const visibleRoles = pv.body.players.filter((x) => x.role).map((x) => x.seat);
    assert.deepStrictEqual(visibleRoles, [humanSeat], '未翻牌时玩家只能看到自己的身份');
    assert.ok(pv.body.me.role, 'me.role 必须下发（本人知情信息）');

    // ② 上帝 token：全量身份 + 上帝字段
    const gv = await call(api, 'GET', `/api/games/${gid}/view?token=gt-${gid}&after=0`);
    assert.strictEqual(gv.status, 200);
    assert.strictEqual(gv.body.players.every((x) => x.role), true, '上帝视图必须有全部身份');
    assert.strictEqual(godOnly(gv.body), true, '上帝视图才有 llmStats/scheduler');
    assert.strictEqual(gv.body.me, null, '上帝没有 me（不冒充任何座位）');

    // ③ 玩家→上帝→玩家往返：buildView 按请求即时构造，玩家视图必须与 ① 完全一致（零残留）
    const pv2 = await call(api, 'GET', `/api/games/${gid}/view?token=pt-${gid}&after=0`);
    assert.strictEqual(godOnly(pv2.body), false, '往返后玩家视图不得残留上帝字段');
    assert.deepStrictEqual(pv2.body.players.filter((x) => x.role).map((x) => x.seat), [humanSeat], '往返后身份可见性不得扩大');
    assert.deepStrictEqual(pv2.body.players, pv.body.players, '玩家视图往返后逐字段一致');

    // ④ 无效 token fail-closed
    const bad = await call(api, 'GET', `/api/games/${gid}/view?token=forged&after=0`);
    assert.strictEqual(bad.status, 403, '伪造 token 必须 403');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
