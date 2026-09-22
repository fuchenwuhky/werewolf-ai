/**
 * test/m2e-export-browser.test.js — M2-e **浏览器臂**（三态归一化 + 同源下载语义 + 服务端契约）
 *
 * 覆盖计划书 `docs/next-stage-implementation-plan.md:226-241`（§7 数据导入导出）里属于浏览器臂的部分：
 *   · 三个适配器统一区分「保存完成 / 用户取消 / 失败」——浏览器**只有"已发起下载"**，不得宣称保存成功；
 *   · 导出范围 = 档案资料 + 自定义头像 + **已结束对局** + 笔记；**进行中对局不进包**；
 *   · **不导出密钥、令牌、Cookie、日志凭证和恢复锚点**；
 *   · **笔记文件缺失可表示无笔记；文件损坏或读取错误不能静默当作无笔记**；
 *   · 保持 20MiB 上限，近上限真实文件可完成预览与导入。
 *
 * 本文件只读、只写临时目录（helpers-tmpdir 的 makeDataDir），不碰 saves/ 与 profiles/。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const H = require('./helpers-tmpdir.js');
const S = require('../web/shared/export-status.js');
const desktopCore = require('../desktop/export-core.js');
const transfer = require('../src/profiles/transfer.js');
const { AnnotationStore } = require('../src/annotations/store.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const NOOP_LOG = { info() {}, warn() {}, error() {}, debug() {} };

// ─────────────────────────────────────────── ① 三态归一化：与原生两臂同源

test('M2-e 浏览器：STATUSES 与 Electron 臂**逐字同源**（两处各写一份就会漂移）', () => {
  assert.deepStrictEqual([...S.STATUSES], [...desktopCore.STATUSES],
    'web/shared/export-status.js 的 STATUSES 与 desktop/export-core.js 不一致');
  assert.deepStrictEqual([...S.STATUSES], ['saved', 'cancelled', 'failed']);
});

test('M2-e 浏览器：浏览器臂的可达状态是 started/failed，**saved 与 cancelled 都不可能出现**', () => {
  assert.deepStrictEqual([...S.BROWSER_STATUSES], ['started', 'failed']);
  assert.ok(!S.BROWSER_STATUSES.includes('saved'),
    '浏览器拿不到落盘证据，saved 不在可达集合里');
  assert.ok(!S.BROWSER_STATUSES.includes('cancelled'),
    '浏览器也无法感知用户是否取消保存');
});

test('M2-e 浏览器：任何输入都不可能让 browserExportOutcome 返回 saved', () => {
  const inputs = [
    undefined, null, {}, true, false, 0, 1, 'saved', 'started',
    { status: 'saved' }, { status: 'saved', path: '/tmp/x' }, { path: '/tmp/x' },
    { downloadStarted: true }, { downloadStarted: 'true' }, { downloadStarted: 1 },
    { error: null }, { error: '' }, { error: 'boom' }, { status: 'cancelled' },
  ];
  for (const i of inputs) {
    const r = S.browserExportOutcome(i);
    assert.notStrictEqual(r.status, 'saved',
      `输入 ${JSON.stringify(i)} 竟然判成了 saved —— 浏览器不许宣称保存成功`);
    assert.ok(['started', 'failed'].includes(r.status), `未知状态 ${r.status}`);
  }
});

test('M2-e 浏览器：只有 downloadStarted === true 才算"已发起下载"（真值 1 / 字符串 true 都不算）', () => {
  assert.strictEqual(S.browserExportOutcome({ downloadStarted: true }).status, 'started');
  assert.strictEqual(S.browserExportOutcome({ downloadStarted: 1 }).status, 'failed');
  assert.strictEqual(S.browserExportOutcome({ downloadStarted: 'true' }).status, 'failed');
  assert.strictEqual(S.browserExportOutcome({}).status, 'failed');
});

test('M2-e 浏览器：归一化只认字面量 saved + 真实路径（ok/success/true/1 与缺路径一律 failed）', () => {
  assert.deepStrictEqual(S.normalizeResult({ status: 'saved', path: '/tmp/a.json' }),
    { status: 'saved', path: '/tmp/a.json' });
  for (const bad of [{ status: 'saved' }, { status: 'saved', path: '' }, { status: 'saved', path: '   ' }]) {
    assert.strictEqual(S.normalizeResult(bad).status, 'failed',
      `${JSON.stringify(bad)} 缺落盘路径却判成成功`);
  }
  for (const raw of [{ status: 'ok' }, { status: 'success' }, { status: true }, { status: 1 },
    true, 1, 'saved', null, undefined, []]) {
    assert.strictEqual(S.normalizeResult(raw).status, 'failed',
      `${JSON.stringify(raw)} 不该被认成成功`);
  }
  assert.strictEqual(S.normalizeResult({ status: 'cancelled' }).status, 'cancelled');
  assert.strictEqual(S.normalizeResult({ status: 'started' }).status, 'started');
});

test('M2-e 浏览器：started 的文案明说"无法确认是否已保存"，且任何状态都不出现"保存成功"', () => {
  const started = S.formatOutcome({ status: 'started' });
  assert.match(started, /已发起下载/, '文案没提"已发起下载"');
  assert.match(started, /无法确认/, '文案必须显式说明浏览器无法确认是否已保存');
  for (const st of [{ status: 'started' }, { status: 'saved', path: '/x' },
    { status: 'cancelled' }, { status: 'failed', error: 'e' }]) {
    assert.ok(!/保存成功/.test(S.formatOutcome(st)),
      '绝不允许出现"保存成功"这种未经确认的宣称');
  }
});

test('M2-e 浏览器：错误文案单行化 + 限长（不把超长报文带进 UI）', () => {
  const multi = S.formatOutcome({ status: 'failed', error: new Error('第一行\n第二行\t带\t制表') });
  assert.ok(!/[\r\n\t]/.test(multi), '错误文案里还有换行/制表符');
  const long = S.failedResult(new Error('x'.repeat(500))).error;
  assert.ok(long.length <= S.MAX_ERROR_LEN, `错误文案没有被限长：${long.length}`);
  assert.ok(!/[\r\n]/.test(S.failedResult('a\r\nb').error));
});

// ─────────────────────────────────────────── ② 服务端契约：导出不含凭证

function fakeGame(id, { finished = true, extraEvents = 0 } = {}) {
  const events = [{ t: 'day', text: '白天' }];
  for (let i = 0; i < extraEvents; i++) events.push({ t: 'talk', seat: (i % 12) + 1, text: `发言 ${i}` });
  return {
    id, finished, day: 2, winner: 'wolf', winReason: '屠边', mock: false, savedAt: '2026-09-21T00:00:00Z',
    players: [{ seat: 1, name: '甲', role: 'seer' }], events, board: { id: 'adv12' }, rules: {},
  };
}

test('M2-e 浏览器：导出包里**没有**令牌/密钥/Cookie/恢复锚点/journal', () => {
  const pkg = transfer.buildExportPackage({
    profile: { id: 'p1', nickname: '甲', revision: 1, bio: '', createdAt: null },
    games: [fakeGame('g1'), fakeGame('g2', { finished: false })],
    notes: { g1: { revision: 1, seats: { 1: { leaning: 'good', confidence: 3 } } } },
    hostLabel: '本机导出',
    avatar: null,
  });
  const s = JSON.stringify(pkg);
  for (const forbidden of ['playerToken', 'godToken', 'apiKey', 'api_key', 'cookie', 'Cookie',
    'anchor', 'journal', 'Authorization', 'Bearer ']) {
    assert.ok(!s.includes(forbidden), `导出包里出现了 ${forbidden}（凭证/锚点泄漏）`);
  }
  // 顶层键就这四个：多一个键就要有人来解释它为什么在包里（counts 在 manifest 内）
  assert.deepStrictEqual(Object.keys(pkg).sort(), ['games', 'manifest', 'notes', 'profile']);
  assert.strictEqual(typeof pkg.manifest.counts.games, 'number', 'manifest.counts.games 缺失');
});

test('M2-e 浏览器：**进行中的对局不进包**（只收 finished；且缺 owner 的不收）', (t) => {
  const dir = H.makeDataDir('m2e-browser-collect');
  H.cleanupAfter(t, dir);
  const saves = H.savesOf(dir);
  fs.mkdirSync(saves, { recursive: true });
  const w = (name, doc) => fs.writeFileSync(path.join(saves, name), JSON.stringify(doc), 'utf8');
  w('fin.json', { ownerProfileId: 'P', game: { id: 'fin', finished: true, events: [] } });
  w('unfin.json', { ownerProfileId: 'P', game: { id: 'unfin', finished: false, events: [] } });
  w('other.json', { ownerProfileId: 'Q', game: { id: 'other', finished: true, events: [] } });

  const got = transfer.collectExportableGames(saves, 'P');
  assert.deepStrictEqual(got.map((g) => g.id), ['fin'],
    '进行中对局或别的档案的对局混进导出范围了');
});

test('M2-e 浏览器：损坏存档在 strict 导出下**必须报错**，不得静默少报一局', (t) => {
  const dir = H.makeDataDir('m2e-browser-corrupt-save');
  H.cleanupAfter(t, dir);
  const saves = H.savesOf(dir);
  fs.mkdirSync(saves, { recursive: true });
  fs.writeFileSync(path.join(saves, 'ok.json'),
    JSON.stringify({ ownerProfileId: 'P', game: { id: 'ok', finished: true, events: [] } }), 'utf8');
  fs.writeFileSync(path.join(saves, 'broken.json'), '{ 这不是 JSON', 'utf8');

  // 默认（宽容）语义保持既有行为：坏文件被跳过
  assert.strictEqual(transfer.collectExportableGames(saves, 'P').length, 1);
  // strict（导出路由开启）：坏文件必须让整次导出失败
  assert.throws(() => transfer.collectExportableGames(saves, 'P', { strict: true }),
    /不是合法 JSON|拒绝生成/, '损坏存档在 strict 下没有抛错 —— 会静默导出一份"看起来完整"的包');
});

// ─────────────────────────────────────────── ③ 损坏 notes 不得静默当"没有笔记"

test('M2-e 浏览器：标注**缺失**=无笔记（不报错），**损坏**=报错（strict 才开）', (t) => {
  const dir = H.makeDataDir('m2e-browser-notes');
  H.cleanupAfter(t, dir);
  const pid = crypto.randomUUID(); // AnnotationStore 的 profileId 白名单是 UUID
  const store = new AnnotationStore({ profilesRoot: dir, logger: NOOP_LOG });

  // 缺失 ⇒ 空文档，不报错（"缺失可表示无笔记"）
  const empty = store.get(pid, 'g-none', { strict: true });
  assert.ok(empty && typeof empty === 'object', '缺失笔记应回空文档');

  // 写一份**身份字段齐全**的合法笔记：schemaVersion 取自空文档本身（不硬编码，避免版本漂移）
  const file = store.file(pid, 'g1');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: empty.schemaVersion, profileId: pid, gameId: 'g1',
    revision: 1, seats: { 1: { leaning: 'good', confidence: 3 } },
  }), 'utf8');
  const okDoc = store.get(pid, 'g1', { strict: true });
  assert.strictEqual(okDoc.seats['1'].leaning, 'good');

  // 损坏 ⇒ strict 必须抛（否则导出包看起来完整，归档后笔记再无出口）
  fs.writeFileSync(file, '{ 坏掉的 JSON', 'utf8');
  assert.throws(() => store.get(pid, 'g1', { strict: true }),
    /./, '损坏的笔记文件在 strict 下没有抛错 —— 会被静默当作"没有笔记"');
  // 且默认（UI 侧）语义不变：宽容读不抛
  assert.doesNotThrow(() => store.get(pid, 'g1'));
});

test('M2-e 浏览器：标注**身份字段不匹配**按设计回空文档（store.js:118 第 3 条，不是损坏）', (t) => {
  // 这条钉的是"设计意图"，不是缺陷：反过来若哪天改成抛错，本用例会红，提醒改的人先解释清楚。
  const dir = H.makeDataDir('m2e-browser-notes-identity');
  H.cleanupAfter(t, dir);
  const pid = crypto.randomUUID();
  const store = new AnnotationStore({ profilesRoot: dir, logger: NOOP_LOG });
  const file = store.file(pid, 'g1');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const base = store.get(pid, 'g-none', { strict: true });
  const cases = [
    ['缺 schemaVersion', { profileId: pid, gameId: 'g1', seats: { 1: { leaning: 'good' } } }],
    ['profileId 是他人的', { schemaVersion: base.schemaVersion, profileId: crypto.randomUUID(), gameId: 'g1', seats: { 1: { leaning: 'good' } } }],
    ['gameId 是别局的', { schemaVersion: base.schemaVersion, profileId: pid, gameId: 'g-other', seats: { 1: { leaning: 'good' } } }],
    ['schemaVersion 是未来版本', { schemaVersion: base.schemaVersion + 99, profileId: pid, gameId: 'g1', seats: { 1: { leaning: 'good' } } }],
  ];
  for (const [label, doc] of cases) {
    fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
    let got = null;
    assert.doesNotThrow(() => { got = store.get(pid, 'g1', { strict: true }); },
      `${label} ⇒ strict 下不该抛错（按设计是"不是本局的笔记"）`);
    assert.deepStrictEqual(got.seats, {}, `${label} ⇒ 应回空文档`);
  }
  // 而**合法 JSON 但结构坏掉**（截断）仍然必须抛：两类不能混为一谈
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: base.schemaVersion, profileId: pid, gameId: 'g1' }).slice(0, 20), 'utf8');
  assert.throws(() => store.get(pid, 'g1', { strict: true }), /损坏|不是合法 JSON/,
    '截断的 JSON 必须被判为损坏（与"身份不匹配"区分开）');
});


test('M2-e 浏览器：导出路由确实以 strict:true 读笔记与对局（源码级钉住，别处放宽即判红）', () => {
  const api = read('src/api.js');
  assert.match(api, /annotations\.get\(pid,\s*g\.id,\s*\{\s*strict:\s*true\s*\}\)/,
    'api.js 的导出路由不再以 strict:true 读笔记 —— 损坏笔记会被静默当无笔记');
  assert.match(api, /collectExportableGames\(this\.saveDir,\s*pid,\s*\{\s*strict:\s*true\s*\}\)/,
    'api.js 的导出路由不再 strict 收集对局 —— 损坏存档会被静默跳过');
});

test('M2-e 浏览器：导入路由按 20MiB 读体（不是默认的 2MiB），预览与导入用同一上限', () => {
  const api = read('src/api.js');
  const hits = api.match(/readBody\(req,\s*transfer\.MAX_BYTES\)/g) || [];
  assert.strictEqual(hits.length, 2,
    `预览与导入两处都应显式传 transfer.MAX_BYTES（实际 ${hits.length} 处）—— 用默认 2MiB 会让大于 2MiB 的包永远导不进来`);
  assert.match(api, /async readBody\(req,\s*limit = 2 \* 1024 \* 1024\)/,
    'readBody 的默认上限变了 —— 这条钉的是"导入必须显式传大上限"的前提');
});

// ─────────────────────────────────────────── ④ 20MiB 上限与近上限真实文件

test('M2-e 浏览器：上限与 transfer.js 同值（20MiB），超限必须被判失败而不是"照导"', () => {
  assert.strictEqual(S.MAX_EXPORT_BYTES, transfer.MAX_BYTES);
  assert.strictEqual(transfer.MAX_BYTES, 20 * 1024 * 1024);
  const big = {
    manifest: { exportVersion: transfer.EXPORT_VERSION },
    profile: { id: 'p', nickname: '甲' },
    games: [{ id: 'g', finished: true, events: [{ text: 'x'.repeat(1024 * 1024) }] }],
    notes: {},
  };
  // 近上限（约 2MiB）⇒ 通过
  assert.doesNotThrow(() => transfer.validateImportPackage(big));
  // 明确超限 ⇒ 报错，且是 413（不是 400/500）
  let err = null;
  try { transfer.validateImportPackage(big, { maxBytes: 1024 }); } catch (e) { err = e; }
  assert.ok(err, '超过上限的包没有被拒绝');
  assert.strictEqual(err.code, 413, `超限的错误码应是 413，实际 ${err.code}`);
  assert.match(err.message, /上限/);
});

test('M2-e 浏览器：近 20MiB 的真实包能完成**预览**（含局数/笔记数与包大小）', () => {
  // 造一个真实结构的包，靠事件文本把它顶到接近 20MiB
  const chunk = 512 * 1024;
  const events = [];
  for (let i = 0; i < Math.floor((19 * 1024 * 1024) / chunk); i++) {
    events.push({ t: 'talk', seat: 1, text: 'x'.repeat(chunk) });
  }
  const pkg = transfer.buildExportPackage({
    profile: { id: 'p1', nickname: '甲', revision: 1 },
    games: [fakeGame('g1', { extraEvents: 0 }), { ...fakeGame('g2'), events }],
    notes: { g1: { revision: 1, seats: { 1: { leaning: 'good', confidence: 3 } } } },
    hostLabel: '本机导出',
  });
  const body = JSON.stringify(pkg);
  const mb = Buffer.byteLength(body) / 1048576;
  assert.ok(mb > 10 && mb <= 20, `测试包大小应在 10～20MiB 之间，实测 ${mb.toFixed(2)}MiB`);
  assert.doesNotThrow(() => transfer.validateImportPackage(pkg), '近上限的合法包被拒了');
  // previewImport 直接返回预览对象（路由层再包一层 { preview }）
  const pv = transfer.previewImport(pkg);
  assert.strictEqual(pv.games, 2);
  assert.strictEqual(pv.notes, 1);
  assert.strictEqual(pv.finishedOnly, true);
  assert.strictEqual(pv.nickname, '甲');

  const text = S.describePreview(pv, Buffer.byteLength(body));
  assert.match(text, /包大小：/, '预览里没有"包大小"');
  assert.match(text, /已结束对局：2 局/);
  assert.match(text, /笔记：1 份/);
  assert.ok(!/超过/.test(text), '没超限却报了超限告警');
});

test('M2-e 浏览器：预览在超限时给出明确告警（但不在这里拦截，判据只留服务端一处）', () => {
  const text = S.describePreview({ nickname: '甲', games: 0, notes: 0 }, transfer.MAX_BYTES + 1);
  assert.match(text, /超过/);
  assert.match(text, /服务端/);
});

test('M2-e 浏览器：humanBytes 的边界（0 / KB / MB / 非法输入）', () => {
  assert.strictEqual(S.humanBytes(0), '0 B');
  assert.strictEqual(S.humanBytes(2048), '2.0 KB');
  assert.strictEqual(S.humanBytes(1048576), '1.00 MB');
  assert.strictEqual(S.humanBytes('x'), '未知大小');
  assert.strictEqual(S.humanBytes(-1), '未知大小');
});

// ─────────────────────────────────────────── ⑤ 前端接线：已发起下载，不再用弹窗

for (const [label, rel] of [['桌面端', 'web/app.js'], ['手机端', 'web/m/m.js']]) {
  test(`M2-e 浏览器（${label}）：导出走 browserExportProfile，不再 window.open 导出地址`, () => {
    const src = read(rel);
    assert.match(src, /function browserExportProfile\(/, `${rel} 里没有 browserExportProfile`);
    assert.ok(!/window\.open\(`?\/api\/profiles\/[^)]*\/export/.test(src),
      `${rel} 里还留着 window.open 直接打开导出地址（无状态、还可能被弹窗拦截）`);
    assert.match(src, /导出地址不合法/, `${rel} 的导出臂缺少地址前缀白名单`);
  });

  test(`M2-e 浏览器（${label}）：导出文案来自共享模块（导出臂函数体内不手写成功宣称）`, () => {
    const src = read(rel);
    assert.match(src, /WWTransferStatus/, `${rel} 没接共享三态模块`);
    // 只审 browserExportProfile 的函数体：全文件搜会命中注释里"未确认不宣称保存成功"之类的正当文字
    const i = src.indexOf('function browserExportProfile(');
    assert.ok(i > 0, `${rel} 找不到 browserExportProfile`);
    const rest = src.slice(i + 1);
    const end = rest.indexOf('\n}');
    const body = rest.slice(0, end < 0 ? undefined : end);
    assert.match(body, /formatOutcome/, `${rel} 的导出臂没有用共享文案`);
    assert.ok(!/保存成功|已保存到/.test(body),
      `${rel} 的导出臂函数体里出现了成功宣称 —— 浏览器不可能知道文件是否真的保存了`);
  });
}

test('M2-e 浏览器：两端**玩家中心**的导出按钮也都走 browserExportProfile（m.js 曾漏改过一处）', () => {
  // 档案行之外还有玩家中心那一处：桌面 #pc-export、手机 #m-pc-export。
  // 上一轮只改了两端的档案行与桌面玩家中心，手机玩家中心（m.js:1279）仍是 window.open，
  // 被本文件的断言抓出来后补修 —— 这条把它永久钉住，防止再漏。
  const app = read('web/app.js');
  const mjs = read('web/m/m.js');
  const iApp = app.indexOf("id = 'pc-export'");
  assert.ok(iApp > 0, 'app.js 找不到 #pc-export');
  assert.match(app.slice(iApp, iApp + 900), /browserExportProfile/,
    '桌面端玩家中心的导出按钮没有走 browserExportProfile');
  const iM = mjs.indexOf("id = 'm-pc-export'");
  assert.ok(iM > 0, 'm.js 找不到 #m-pc-export');
  assert.match(mjs.slice(iM, iM + 900), /browserExportProfile/,
    '手机端玩家中心的导出按钮没有走 browserExportProfile（m.js 曾在此漏改）');
});

test('M2-e 浏览器：双端页面都在入口脚本之前加载 export-status.js', () => {
  for (const [rel, ref, entry] of [['web/index.html', 'shared/export-status.js', 'app.js'],
    ['web/m/index.html', '../shared/export-status.js', 'm.js']]) {
    const html = read(rel);
    const iMod = html.indexOf(ref);
    assert.ok(iMod > 0, `${rel} 没有引入 ${ref}`);
    const iEntry = html.lastIndexOf(`<script src="${entry}"></script>`);
    assert.ok(iEntry > 0, `${rel} 找不到入口脚本 ${entry}`);
    assert.ok(iMod < iEntry, `${rel} 里 ${ref} 必须在 ${entry} 之前加载`);
  }
});

test('M2-e 浏览器：离线上限清单里登记了新模块（§10.4 新增共享模块纳入离线清单）', () => {
  const sw = read('web/sw.js');
  assert.match(sw, /'\/shared\/export-status\.js'/, 'sw.js 的预缓存清单里没有 export-status.js');
  assert.match(sw, /ww-v21-m2e/, 'sw.js 的 VERSION 没有升到 ww-v21-m2e');
});

// ─────────────────────────────────────────── ⑥ 数据目录零污染

test('M2-e 浏览器：本文件只往临时目录写（不碰 saves/profiles/config.json）', () => {
  const src = read('test/m2e-export-browser.test.js');
  assert.match(src, /H\.makeDataDir\(/, '没有用 helpers-tmpdir 的临时目录');
  assert.ok(!/writeFileSync\(path\.join\(ROOT/.test(src), '本文件直接往仓库里写文件了');
  // 所有写盘都必须以临时目录为根。这里检查的是**每个写盘调用的实参根**，而不是搜字面量 ——
  // 搜字面量会把断言自己写的字符串也算进去（本文件已在 "WWExport" 子串、注释里的"保存成功"
  // 上各踩过一次同类陷阱），也会把合法的 `fs.mkdirSync(saves, …)`（saves 来自 H.savesOf(dir)）
  // 误判成可疑写盘点。
  const writes = [...src.matchAll(/fs\.(?:mkdirSync|writeFileSync|appendFileSync|rmSync|unlinkSync)\s*\(([^)]*)/g)]
    .map((m) => m[1].trim());
  assert.ok(writes.length > 0, '没找到写盘调用 —— 正则或代码结构变了，本用例已失效，请更新');
  for (const arg of writes) {
    assert.ok(/^(?:dir|saves|file|path\.join|path\.dirname)/.test(arg),
      `可疑的写盘点（必须以临时目录为根）：${arg.slice(0, 60)}`);
  }
  assert.match(src, /const saves = H\.savesOf\(dir\)/, '临时 saves 目录必须来自 helpers-tmpdir');
  assert.match(src, /H\.cleanupAfter\(t, dir\)/, '临时目录必须挂到用例上回收');
});
