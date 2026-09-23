/**
 * r07-avatar-filter-rows.test.js — R07：头像 PNG 必须**逐行**校验滤波类型字节（0–4）
 *
 * 已复现的缺陷（审核 R07 原文）：`src/profiles/avatar.js` 只检查"解压后长度 == height×(1+stride)"，
 * **没有验证每行开头的滤波类型字节**。于是"CRC 正确、512×512、解压长度正确、第一行滤波值为 255"
 * 的 PNG 仍被接受 —— 交给浏览器就是一张破图。正常裁切器不会生成这种图，但**直接上传或导入包**可以触发。
 *
 * 本文件覆盖：
 *   · 正例：每行 0；逐行循环 1/2/3/4（**真正按规范做前向滤波**的真图）—— 都必须被接受（不得误伤合法值）
 *   · 反例：第一行 255（审核复现件）、中间行 5（防止"只查第一行"的假修复）
 *   · 端到端（真实 HTTP）：坏图**覆盖**上传被拒后，原图字节、摘要元数据、导出包**逐字节不变**；
 *     坏图藏在**导入包**里同样被拒（审核指出的第二条触发路径）
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const events = require('node:events');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const Api = require('../src/api').Api || require('../src/api');
const { makeDataDir, savesOf, terminateApi } = require('./helpers-tmpdir');
const png = require('./helpers-png');
const { validateAvatarBuffer } = require('../src/profiles/avatar');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeApi(tag) {
  const dataDir = makeDataDir(tag);
  const savesDir = savesOf(dataDir);
  const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger: silentLogger, saveDir: savesDir });
  return { api, dataDir, savesDir };
}

async function callApi(api, method, pathname, raw, headers) {
  const u = new URL(pathname, 'http://localhost');
  const req = new events.EventEmitter();
  req.method = method;
  req.headers = Object.assign({ host: 'localhost:3210' }, headers || {});
  req.socket = { remoteAddress: '127.0.0.1' };
  const box = { headers: {} };
  box.res = {
    writeHead(code, h) { box.code = code; Object.assign(box.headers, h || {}); },
    end(b) { box.raw = b; },
    setHeader(k, v) { box.headers[k.toLowerCase()] = v; },
  };
  process.nextTick(() => {
    if (raw !== undefined && raw !== null) req.emit('data', raw);
    req.emit('end');
  });
  await api.handle(req, box.res, u.pathname, u.searchParams);
  const text = box.raw != null ? (Buffer.isBuffer(box.raw) ? box.raw.toString('utf8') : String(box.raw)) : null;
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; } // 导出包可能是二进制：解析失败就只留字节
  return { status: box.code, text, body, bytes: box.raw == null ? null : (Buffer.isBuffer(box.raw) ? box.raw : Buffer.from(String(box.raw))) };
}
const post = (api, p, body) => callApi(api, 'POST', p, Buffer.from(JSON.stringify(body), 'utf8'));

const S = 512; // AVATAR_SIZE
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** 合法 PNG：指定每行滤波类型的**真图**（filters 省略 = 全 0） */
function goodPng(filters) {
  const raw = png.rawImage({ width: S, height: S, colorType: 6, bitDepth: 8, filters });
  return png.makePng({ idatData: zlib.deflateSync(raw) });
}
/** 篡改第 row 行的滤波字节为 value（其余全合法、CRC 由 makePng 真算） */
function badFilterPng(row, value) {
  const raw = png.rawImage({ width: S, height: S, colorType: 6, bitDepth: 8 });
  const stride = png.strideOf({ width: S, colorType: 6, bitDepth: 8 });
  assert.strictEqual(raw[row * (stride + 1)], 0, '夹具自证：篡改前该行滤波值确实是 0');
  raw[row * (stride + 1)] = value;
  return png.makePng({ idatData: zlib.deflateSync(raw) });
}

test('R07 正例：每行滤波 0 的图被接受（基线，证明夹具本身合法）', () => {
  const info = validateAvatarBuffer(goodPng(null));
  assert.strictEqual(info.width, S);
  assert.strictEqual(info.height, S);
});

test('R07 正例：逐行循环滤波 1/2/3/4 的**真图**必须被接受（不得把合法滤波值当非法）', () => {
  // 四种值各覆盖到（512 行足够循环多轮）；这是真做前向滤波的图，解码器能正常还原
  const info = validateAvatarBuffer(goodPng([1, 2, 3, 4]));
  assert.strictEqual(info.width, S, '滤波 1–4 是合法值，不得误伤');
  const only4 = validateAvatarBuffer(goodPng([4]));
  assert.strictEqual(only4.height, S);
});

test('R07 反例（审核复现件）：第一行滤波值 255、CRC 正确、尺寸与解压长度都对 —— 必须被拒', () => {
  const bad = badFilterPng(0, 255);
  assert.throws(() => validateAvatarBuffer(bad), (e) => {
    assert.match(e.message, /滤波|filter/i, `错误文案应指出滤波问题，实际：${e.message}`);
    assert.match(e.message, /第 1 行|255/, `文案应能定位到行号与非法值，实际：${e.message}`);
    return true;
  });
});

test('R07 反例：非法滤波值出现在**中间行**（第 300 行 = 5）也必须被拒（防止只查第一行）', () => {
  const bad = badFilterPng(300, 5);
  assert.throws(() => validateAvatarBuffer(bad), (e) => {
    assert.match(e.message, /滤波|filter/i, e.message);
    assert.match(e.message, /第 300 行|5/, `文案应能定位到行号与非法值，实际：${e.message}`);
    return true;
  });
});

/** 造一个带自定义头像的导入包（头像字节由调用方指定） */
function pkgWithAvatar(avatarBytes, nickname = '滤波测试') {
  return {
    manifest: { exportVersion: 1, packageId: '00000000-0000-4000-8000-000000000000', createdAt: '2026-09-23T00:00:00.000Z', source: '测试', counts: { games: 0, notes: 0 } },
    profile: {
      nickname, avatarId: 'scholar', bio: '', preferences: {},
      customAvatar: avatarBytes ? { mime: 'image/png', sha256: sha(avatarBytes), dataBase64: avatarBytes.toString('base64') } : null,
    },
    notes: {}, games: [],
  };
}

/**
 * 取档案在**列表**里的那一行。
 * 为什么不用 GET /api/profiles/:id：实测这条路**不存在**（返回 404 {"error":"not found"}），
 * 而桌面/手机玩家中心的档案元数据本来就读列表接口 —— 列表行才是"用户看到的那份元数据"。
 */
async function profileRow(api, pid) {
  const list = await callApi(api, 'GET', '/api/profiles');
  const row = (list.body.profiles || []).find((p) => p.id === pid);
  assert.ok(row, `列表接口里应能找到档案 ${pid}`);
  return row;
}
/** 只比"一次失败上传不该改动"的字段（列表行里还有最近使用时间这类会自然变化的字段） */
function pick(row) {
  const keys = ['id', 'nickname', 'avatarId', 'customAvatar', 'avatarUrl', 'revision', 'archivedAt', 'bio'];
  const out = {};
  for (const k of keys) out[k] = row[k];
  return out;
}

test('R07 端到端：坏图覆盖上传被拒后，原图字节、摘要元数据与导出内容都不变', async () => {
  const { api, dataDir } = makeApi('r07-cover');
  try {
    const made = await post(api, '/api/profiles/import', { package: pkgWithAvatar(null, '原图档案') });
    assert.strictEqual(made.status, 200, `建档案失败：${made.status} ${made.text && made.text.slice(0, 200)}`);
    const pid = made.body.profileId;

    const good = goodPng([1, 2, 3, 4]);
    const put = await callApi(api, 'PUT', `/api/profiles/${pid}/avatar`, good, { 'content-type': 'image/png' });
    assert.strictEqual(put.status, 200, `合法图必须上传成功（实际 ${put.status}）`);
    const goodSha = sha(good);
    assert.strictEqual(put.body.profile.customAvatar.sha256, goodSha, '摘要应等于上传字节的 sha256');

    const before = await callApi(api, 'GET', `/api/profiles/${pid}/avatar`);
    const rowBefore = await profileRow(api, pid);
    const exportBefore = await callApi(api, 'GET', `/api/profiles/${pid}/export`);

    const bad = badFilterPng(0, 255);
    const put2 = await callApi(api, 'PUT', `/api/profiles/${pid}/avatar`, bad, { 'content-type': 'image/png' });
    assert.strictEqual(put2.status, 400, `R07：非法滤波值的头像必须被 400 拒（实际 ${put2.status}）`);
    assert.ok(/滤波|filter/i.test(put2.body && put2.body.error || ''), `错误应指出滤波问题，实际：${put2.text && put2.text.slice(0, 200)}`);

    const after = await callApi(api, 'GET', `/api/profiles/${pid}/avatar`);
    const rowAfter = await profileRow(api, pid);
    const exportAfter = await callApi(api, 'GET', `/api/profiles/${pid}/export`);

    assert.ok(before.bytes && before.bytes.length > 0, '原图应能读回');
    assert.ok(before.bytes.equals(after.bytes), 'R07：被拒之后**原图字节**必须逐字节不变');
    assert.strictEqual(sha(after.bytes), goodSha, 'R07：读回的仍是那张合法图');
    assert.deepStrictEqual(pick(rowAfter), pick(rowBefore),
      'R07：摘要元数据（sha256/尺寸/avatarUrl/revision）必须不变');
    assert.ok(exportBefore.bytes && exportAfter.bytes, '导出包应能取回');
    // ⚠ 不能直接比"导出字节"：包里 manifest.packageId 每次导出都是新 UUID、createdAt 是导出时刻，
    //    所以两次导出天然不同（这是导出契约，不是失败上传造成的）。要比的是**包内容里该稳定的部分**。
    const pkgBefore = JSON.parse(exportBefore.text);
    const pkgAfter = JSON.parse(exportAfter.text);
    assert.notStrictEqual(pkgBefore.manifest.packageId, pkgAfter.manifest.packageId,
      '夹具自证：packageId 每次导出确实不同 ⇒ 直接比字节是错判据');
    assert.deepStrictEqual(pkgAfter.profile, pkgBefore.profile,
      'R07：导出包里的档案（含 customAvatar 的 sha256 与 dataBase64）必须完全一致');
    assert.strictEqual(pkgAfter.profile.customAvatar.sha256, goodSha, 'R07：导出里带的就是那张合法图的摘要');
    assert.deepStrictEqual(pkgAfter.manifest.counts, pkgBefore.manifest.counts, 'R07：导出计数不受影响');
    assert.deepStrictEqual(pkgAfter.games, pkgBefore.games, 'R07：导出对局内容不受影响');
  } finally { await terminateApi(api, dataDir); }
});

test('R07 端到端（第二条触发路径）：坏图藏在**导入包**里同样被拒，且不留下半个档案', async () => {
  const { api, dataDir } = makeApi('r07-import');
  try {
    const res = await post(api, '/api/profiles/import', { package: pkgWithAvatar(badFilterPng(0, 255), '带坏图的包') });
    assert.strictEqual(res.status, 400, `R07：包内坏图必须被 400 拒（实际 ${res.status}：${res.text && res.text.slice(0, 200)}）`);
    assert.ok(/滤波|filter/i.test(res.body && res.body.error || ''), `错误应指出滤波问题，实际：${res.text && res.text.slice(0, 200)}`);
    const list = await callApi(api, 'GET', '/api/profiles');
    const leaked = (list.body.profiles || []).filter((p) => p.nickname === '带坏图的包');
    assert.strictEqual(leaked.length, 0, 'R07：被拒的导入不得留下半个档案');
  } finally { await terminateApi(api, dataDir); }
});
