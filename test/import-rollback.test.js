// FIN-02：回滚状态与恢复记录写失败语义（计划书 §6.3 R03/R06 + 幂等复验）
// 复用 profiles-api.test.js 的隔离基建模式；直调 importApplyRes 注入真实 fs 故障。
// FIN-12 补全（2026-09-19）：R07 剩余变体——未来主版本 / notes 类型错误 / 超限包（20MiB 契约）。
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const events = require('node:events');

const Api = require('../src/api').Api || require('../src/api');
const transfer = require('../src/profiles/transfer');

const silentLogger = { info() {}, warn() {}, error() {} };
function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `ww-fin02-${tag}-`)); }
function makeIsolatedApi(tag) {
  const dataDir = tmpDir(tag);
  const savesDir = path.join(dataDir, 'saves');
  const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: savesDir });
  return { api, dataDir, savesDir };
}

function notePkg(id, nickname) {
  return {
    manifest: { exportVersion: 1, packageId: `pkg-${id}`, createdAt: '2026-01-01T00:00:00.000Z', source: '测试', counts: { games: 1, notes: 1 } },
    profile: { nickname, avatarId: 'scholar', bio: '' },
    games: [{ id: `g-${id}`, finished: true, day: 1, winner: 'good', winReason: 'x', mock: true, savedAt: 1,
      players: [{ seat: 1, name: 'a', isHuman: false, role: 'villager' }], events: [], board: { wolf: 1, villager: 2 }, rules: {} }],
    notes: { [`g-${id}`]: { schemaVersion: 2, profileId: 'o', gameId: `g-${id}`, revision: 1, seats: { 1: { leaning: 'lean_wolf' } } } },
  };
}

/** 走真实 api.handle 分发（照 profiles-api.test.js 模式）；raw 用于超限包这类非 JSON 载荷 */
async function callApi(api, method, pathname, body, raw) {
  const u = new URL(pathname, 'http://localhost');
  const req = new events.EventEmitter();
  req.method = method;
  req.headers = { host: 'localhost:3210' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const box = { headers: {} };
  box.res = {
    writeHead(code, headers) { box.code = code; Object.assign(box.headers, headers || {}); },
    end(b) { box.raw = b; },
    setHeader(k, v) { box.headers[k.toLowerCase()] = v; },
  };
  process.nextTick(() => {
    if (raw !== undefined && raw !== null) req.emit('data', raw);
    else if (body !== undefined && body !== null) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  await api.handle(req, box.res, u.pathname, u.searchParams);
  return { status: box.code, raw: box.raw != null ? String(box.raw) : null, body: box.raw ? JSON.parse(box.raw) : null };
}

test('R03 回滚未完成 + 恢复记录也写失败：rolledBack:false、recoveryPersisted:false、响应含残留清单与 profileId', async () => {
  const { api, dataDir, savesDir } = makeIsolatedApi('r03');
  const realWrite = fs.promises.writeFile;
  const realUnlink = fs.unlinkSync;
  try {
    // 故障叠加：笔记写失败（触发回滚）→ unlink 失败（残留）→ 恢复记录写失败（原缺陷路径）
    api.annotations.put = async () => { throw Object.assign(new Error('EPERM: 注入写盘失败'), { code: 'EPERM' }); };
    fs.unlinkSync = (p) => {
      if (String(p).startsWith(savesDir)) throw Object.assign(new Error('EPERM: 注入清理失败'), { code: 'EPERM' });
      return realUnlink(p);
    };
    fs.promises.writeFile = async (p, ...rest) => {
      // 只拦截恢复记录（含其 tmp），放行游戏存档首写——否则第一局就失败，造不出"真实残留"
      if (String(p).startsWith(savesDir) && String(p).includes('.import-recovery-')) {
        throw Object.assign(new Error('ENOSPC: 注入记录写失败'), { code: 'ENOSPC' });
      }
      return realWrite(p, ...rest);
    };
    const out = await api.importApplyRes(notePkg('r03', '三重故障'));
    assert.strictEqual(out.status, 500);
    assert.strictEqual(out.body.rolledBack, false, '有残留绝不能声称已回滚（原缺陷正是这里虚报 rolledBack:true）');
    assert.strictEqual(out.body.cleanupPending, true);
    assert.strictEqual(out.body.cleanupComplete, false);
    assert.strictEqual(out.body.recoveryPersisted, false, '恢复记录写失败必须如实声明');
    assert.strictEqual(out.body.recoveryFile, undefined, '未落盘的记录不得给出文件名');
    assert.ok(Array.isArray(out.body.residue) && out.body.residue.length >= 1, '响应必须带残留清单');
    for (const r of out.body.residue) assert.ok(!path.isAbsolute(r), '残留清单只给相对名，不暴露本机绝对路径');
    assert.ok(out.body.profileId, '响应必须带 profileId 供管理端定位');
    assert.match(out.body.error, /恢复记录写入失败|人工核查/, '错误文案必须明示自动恢复依据未落盘');
    // 残留真实存在（存档 JSON 仍在），且没有任何 .import-recovery- 记录（写失败了）
    const leftovers = fs.readdirSync(savesDir).filter((f) => f.endsWith('.json') && !f.startsWith('.import-recovery-') && !f.startsWith('.tmp-'));
    assert.ok(leftovers.length >= 1, '注入场景下应有真实残留存档');
    assert.strictEqual(fs.readdirSync(savesDir).filter((f) => f.startsWith('.import-recovery-')).length, 0);
  } finally {
    fs.promises.writeFile = realWrite;
    fs.unlinkSync = realUnlink;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('R06a 损坏恢复记录：保留并上报 pendingRecoveries，不得静默当作已处理', async () => {
  const { api, dataDir, savesDir } = makeIsolatedApi('r06a');
  try {
    fs.writeFileSync(path.join(savesDir, '.import-recovery-broken.json'), '{ not-json !!');
    const out = await api.importApplyRes({
      manifest: { exportVersion: 1, packageId: 'pkg-ok', createdAt: '2026-01-01T00:00:00.000Z', source: '测试', counts: { games: 0, notes: 0 } },
      profile: { nickname: '正常导入', avatarId: 'scholar', bio: '' },
      games: [],
    });
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    assert.ok(Array.isArray(out.body.pendingRecoveries) && out.body.pendingRecoveries.length === 1, '成功导入也必须上报未处理的损坏记录');
    assert.strictEqual(out.body.pendingRecoveries[0].reason, 'corrupt');
    assert.ok(fs.existsSync(path.join(savesDir, '.import-recovery-broken.json')), '损坏记录必须保留');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('R06b 目标已不存在：视为已清理，记录被消化（幂等）', async () => {
  const { api, dataDir, savesDir } = makeIsolatedApi('r06b');
  try {
    fs.writeFileSync(path.join(savesDir, '.import-recovery-gone.json'),
      JSON.stringify({ version: 2, profileId: 'no-such-profile', files: ['gone-save.json', 'gone-tmp.json'], createdAt: 1 }));
    await api._retryImportRecoveries();
    // 重复重试一次（R05 幂等）：无副作用、无异常
    await api._retryImportRecoveries();
    assert.strictEqual(fs.existsSync(path.join(savesDir, '.import-recovery-gone.json')), false, '已消化的记录必须从磁盘删除');
    assert.strictEqual(fs.readdirSync(savesDir).filter((f) => f.startsWith('.import-recovery-')).length, 0, '目标全不存在 → 记录应被消化');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('R06c 清理目标越界（绝对路径逃逸数据根）：拒绝删除并保留记录', async () => {
  const { api, dataDir, savesDir } = makeIsolatedApi('r06c');
  const outside = path.join(os.tmpdir(), `ww-fin02-outside-${Date.now()}.json`);
  try {
    fs.writeFileSync(outside, '{}');
    fs.writeFileSync(path.join(savesDir, '.import-recovery-escape.json'),
      JSON.stringify({ version: 1, profileId: 'p', files: [outside], createdAt: 1 })); // 旧版记录存绝对路径
    await api._retryImportRecoveries();
    assert.ok(fs.existsSync(outside), '数据根之外的路径绝不能被恢复逻辑删除');
    assert.ok(fs.existsSync(path.join(savesDir, '.import-recovery-escape.json')), '含越界目标的记录必须保留（dirty）');
  } finally {
    try { fs.unlinkSync(outside); } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('R05 幂等复验：正常重试清理后记录消化，再次重试零副作用', async () => {
  const { api, dataDir, savesDir } = makeIsolatedApi('r05');
  const realUnlink = fs.unlinkSync;
  try {
    api.annotations.put = async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
    fs.unlinkSync = (p) => {
      if (String(p).startsWith(savesDir)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return realUnlink(p);
    };
    const out = await api.importApplyRes(notePkg('r05', '幂等样本'));
    assert.strictEqual(out.body.cleanupPending, true);
    const recName = out.body.recoveryFile;
    fs.unlinkSync = realUnlink;
    delete api.annotations.put;
    const r1 = await api._retryImportRecoveries();
    assert.strictEqual(r1.cleaned, 1, '首次重试消化记录');
    assert.strictEqual(fs.readdirSync(savesDir).filter((f) => f.startsWith('.import-recovery-')).length, 0);
    const r2 = await api._retryImportRecoveries();
    assert.deepStrictEqual(r2, { cleaned: 0, kept: [] }, '再次重试零副作用');
    assert.ok(!fs.existsSync(path.join(savesDir, recName)));
    // 残留存档确已被清理（重试不是只删记录）
    assert.strictEqual(fs.readdirSync(savesDir).filter((f) => f.endsWith('.json') && f !== 'experiences.json').length, 0,
      '重试必须真实清理残留存档');
  } finally {
    fs.unlinkSync = realUnlink;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------- FIN-12 补全：R07 其余变体（写盘前拒绝，零残留） ----------
test('R07a 未来主版本 / notes 类型错误 / 笔记 seats 非法 / 笔记条目非对象 → 写盘前整体 400（零档案零存档）', async () => {
  const { api, dataDir, savesDir } = makeIsolatedApi('r07a');
  try {
    const base = {
      profile: { nickname: '版本客', avatarId: 'scholar', bio: '' },
      games: [{ id: 'g-r07', finished: true, day: 1, winner: 'good', winReason: 'x', mock: true, savedAt: 1,
        players: [{ seat: 1, name: 'a', isHuman: false, role: 'villager' }], events: [], board: { wolf: 1, villager: 2 }, rules: {} }],
    };
    const cases = [
      ['未来主版本', { ...base, manifest: { exportVersion: 99, packageId: 'p', createdAt: 'x', source: '', counts: { games: 1, notes: 0 } } }],
      ['缺 manifest', { ...base, manifest: undefined }],
      ['notes 不是对象', { manifest: { exportVersion: 1, packageId: 'p', createdAt: 'x', source: '', counts: { games: 0, notes: 0 } }, ...base, notes: 'not-an-object' }],
      ['notes 条目非对象', { manifest: { exportVersion: 1, packageId: 'p', createdAt: 'x', source: '', counts: { games: 1, notes: 1 } }, ...base, notes: { 'g-r07': 42 } }],
      ['notes.seats 是数组', { manifest: { exportVersion: 1, packageId: 'p', createdAt: 'x', source: '', counts: { games: 1, notes: 1 } }, ...base, notes: { 'g-r07': { schemaVersion: 2, seats: [] } } }],
      ['对局未结束', { manifest: { exportVersion: 1, packageId: 'p', createdAt: 'x', source: '', counts: { games: 1, notes: 0 } }, ...base, games: [{ ...base.games[0], finished: false }] }],
    ];
    for (const [name, pkg] of cases) {
      const out = await api.importApplyRes(pkg);
      assert.strictEqual(out.status, 400, `${name} 必须在写盘前 400（实际 ${out.status}：${JSON.stringify(out.body)}）`);
      assert.ok(out.body.error, `${name} 必须带错误说明`);
    }
    // 零残留：拒绝路径不得建档、不得落存档
    const list = await callApi(api, 'GET', '/api/profiles');
    assert.strictEqual(list.body.profiles.filter((p) => p.nickname.includes('版本客')).length, 0, '校验失败不得创建档案');
    const leftovers = fs.readdirSync(savesDir).filter((f) => f.endsWith('.json') || f.startsWith('.tmp-'));
    assert.strictEqual(leftovers.length, 0, `不得留下任何存档（实际 ${leftovers}）`);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('R07b 超限包（>20MiB）：读取阶段 413 拒绝，导入与预览同一上限，零落盘（两侧同一 MAX_BYTES 契约）', async () => {
  const { api, dataDir, savesDir } = makeIsolatedApi('r07b');
  try {
    assert.strictEqual(transfer.MAX_BYTES, 20 * 1024 * 1024, '导入导出契约上限必须同为 20MiB（计划书 §3.5/§11）');
    // 读阶段就会因超限被拒，无需构造合法 JSON；'{' 填充避免碰上别的解析分支
    const raw = Buffer.alloc(transfer.MAX_BYTES + 1024, 0x7b);
    const imp = await callApi(api, 'POST', '/api/profiles/import', null, raw);
    assert.strictEqual(imp.status, 413, `超限导入必须 413（实际 ${imp.status}：${String(imp.raw).slice(0, 80)}）`);
    assert.match(imp.body.error, /过大/, '错误必须说明请求体过大');
    const pv = await callApi(api, 'POST', '/api/profiles/import/preview', null, raw);
    assert.strictEqual(pv.status, 413, '预览与导入必须同一上限（不得双重标准）');
    const leftovers = fs.readdirSync(savesDir).filter((f) => f.endsWith('.json') || f.startsWith('.tmp-') || f.startsWith('.import-recovery-'));
    assert.strictEqual(leftovers.length, 0, '超限拒绝不得留下任何文件');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
