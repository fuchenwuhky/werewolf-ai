/**
 * profiles-avatar-transfer.test.js — M1 §4.4 自定义头像的导入导出回归
 *
 * 覆盖：
 *   · 导出：包内 `profile.customAvatar = { mime, sha256, dataBase64 }`；导出前**重新计算哈希**并与
 *     元数据核对；文件丢失/被替换/损坏 ⇒ 导出失败并指出头像问题（不许静默导出看似完整的包）；
 *     包内不含本机绝对路径、原始文件名、EXIF；
 *   · 导入：先校验（Base64 规范性 → 字节上限 → PNG 结构 → 尺寸 → 哈希）**再开始任何写盘**；
 *     新 UUID + 头像落进新档案目录；任一步失败参与整次导入回滚（档案进回收区、无残留）；
 *   · 体积账：自定义头像计入既有 20MiB 导入导出总上限（用"收紧阈值"的方式证明它确实被算进去）。
 *
 * 隔离：一律走 test/helpers-tmpdir.js 的独占 dataDir（os.tmpdir()/ww-*），绝不写仓库内或共享路径。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const events = require('node:events');

const transfer = require('../src/profiles/transfer');
const { MAX_AVATAR_BYTES, sha256Hex } = require('../src/profiles/avatar');
const { makeDataDir, makeApiIn, savesOf, terminateAfter } = require('./helpers-tmpdir');
const png = require('./helpers-png');

const GOOD = png.makePng();
const OTHER = png.makePng({ colorType: 2 });

function stubReq({ method = 'GET', headers = {}, body = null, raw = null, remote = '127.0.0.1' } = {}) {
  const req = new events.EventEmitter();
  req.method = method;
  req.headers = { host: 'localhost:3210', ...headers };
  req.socket = { remoteAddress: remote };
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

async function call(api, method, pathname, opts = {}) {
  const u = new URL(pathname, 'http://localhost');
  const box = stubRes();
  await api.handle(stubReq({ method, ...opts }), box.res, u.pathname, u.searchParams);
  const headers = {};
  for (const [k, v] of Object.entries(box.headers)) headers[k.toLowerCase()] = v;
  const raw = box.raw;
  const text = raw == null ? '' : (Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
  return { status: box.code, headers, text, bytes: Buffer.isBuffer(raw) ? raw : Buffer.from(text), body };
}

/** 一局可导出的已结束对局（字段结构照 transfer.collectExportableGames 的消费面） */
function gameOf(id, { textLen = 0 } = {}) {
  return {
    id, finished: true, day: 3, winner: 'good', winReason: '狼人全部出局', mock: true, savedAt: 1,
    players: [{ seat: 1, name: '我', isHuman: true, role: 'seer' }],
    events: textLen ? [{ seq: 1, type: 'night', text: 'x'.repeat(textLen) }] : [{ seq: 1, type: 'night' }],
    board: { wolf: 1, villager: 2 }, rules: {},
  };
}

/** 存档文件（导出按 ownerProfileId + finished 收集） */
function mkSaveDoc(id, ownerProfileId, gameOpts) {
  return {
    schemaVersion: 2, tokens: { player: 'SECRET', god: 'SECRET' }, mock: true,
    ownerProfileId, ownerNicknameSnapshot: '快照', anchor: null, review: null, savedAt: 1,
    game: gameOf(id, gameOpts),
  };
}

/** 构造导入包：可选自定义头像（data 为空则不带头像） */
function pkgFor(nickname, data, { avatar = undefined, games = [gameOf('g-imp')] } = {}) {
  const profile = { nickname, avatarId: 'scholar', bio: '' };
  if (avatar !== undefined) profile.customAvatar = avatar; // 允许传入任意反例值（string/null/缺字段对象…）
  else if (data) profile.customAvatar = { mime: 'image/png', sha256: sha256Hex(data), dataBase64: data.toString('base64') };
  return {
    manifest: {
      exportVersion: 1, packageId: `pkg-${nickname}`, createdAt: '2026-01-01T00:00:00.000Z',
      source: '测试', counts: { games: games.length, notes: 0 },
    },
    profile, games, notes: {},
  };
}

/** 整个数据目录的快照（相对名排序），用于断言"校验失败 ⇒ 零写盘" */
function snapshot(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push(`${r}/`); walk(path.join(dir, e.name), r); } else out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

// ---------------------------------------------------------------- 导出（§4.4）

test('M1 §4.4 导出：头像进包（恰好 mime/sha256/dataBase64）、哈希与磁盘核对、不含路径/文件名/EXIF', async (t) => {
  const dataDir = makeDataDir('avt-exp');
  const { api } = makeApiIn(dataDir);
  terminateAfter(t, api, dataDir);
  await api._profileMigrationReady;
  const pid = (await call(api, 'POST', '/api/profiles', { body: { nickname: '导出带图', avatarId: 'scholar' } })).body.profile.id;
  // 上传一张**带用户元数据**的图：服务端落盘前剥离 tEXt/eXIf/tIME（原始文件名/EXIF 不进磁盘，自然也不进包）
  const uploaded = png.makePngWithUserMetadata();
  assert.strictEqual((await call(api, 'PUT', `/api/profiles/${pid}/avatar`, { method: 'PUT', raw: uploaded, headers: { 'content-type': 'image/png' } })).status, 200);
  fs.writeFileSync(path.join(savesOf(dataDir), 'g-exp.json'), JSON.stringify(mkSaveDoc('g-exp', pid)));

  const exp = await call(api, 'GET', `/api/profiles/${pid}/export`);
  assert.strictEqual(exp.status, 200);
  const ca = exp.body.profile.customAvatar;
  assert.deepStrictEqual(Object.keys(ca).sort(), ['dataBase64', 'mime', 'sha256'], '导出包头像字段集合必须与 §4.4 契约一致');
  assert.strictEqual(ca.mime, 'image/png');

  const disk = fs.readFileSync(path.join(dataDir, 'profiles', pid, 'avatar.png'));
  assert.strictEqual(ca.sha256, sha256Hex(disk), '导出前必须重新计算文件哈希，且与档案元数据一致');
  const decoded = Buffer.from(ca.dataBase64, 'base64');
  assert.ok(decoded.equals(disk), 'dataBase64 解码必须逐字节等于磁盘文件');

  // 不得包含本机绝对路径（JSON 会转义反斜杠，两种形态都查）、原始文件名、EXIF
  const escapedDir = JSON.stringify(dataDir).slice(1, -1);
  assert.strictEqual(exp.text.includes(dataDir) || exp.text.includes(escapedDir), false, '包内不得出现本机绝对路径');
  assert.strictEqual(exp.text.includes('Original-File-Name'), false, '包内不得出现原始文件名');
  assert.strictEqual(exp.text.includes('avatar.png'), false, '包内不得出现内部文件名');
  for (const type of ['tEXt', 'eXIf', 'tIME']) {
    assert.strictEqual(decoded.includes(Buffer.from(type, 'latin1')), false, `${type} 块不得随包导出`);
  }
  // 头像字节确实计入包体积
  assert.ok(Buffer.byteLength(exp.text) > ca.dataBase64.length, '头像必须真的在包的字节里（不是只写了元数据）');
});

test('M1 §4.4 导出前重新计算哈希并与元数据核对：不符 / 缺数据 ⇒ 抛错，绝不产出"看起来完整"的包', async (t) => {
  const dataDir = makeDataDir('avt-rehash');
  const { api } = makeApiIn(dataDir);
  terminateAfter(t, api, dataDir);
  await api._profileMigrationReady;
  const pid = (await call(api, 'POST', '/api/profiles', { body: { nickname: '重算哈希', avatarId: 'scholar' } })).body.profile.id;
  await call(api, 'PUT', `/api/profiles/${pid}/avatar`, { method: 'PUT', raw: GOOD, headers: { 'content-type': 'image/png' } });
  fs.writeFileSync(path.join(savesOf(dataDir), 'g-rehash.json'), JSON.stringify(mkSaveDoc('g-rehash', pid)));
  const prof = api.profiles.get(pid);

  // 单元层：调用方给的 avatar.data 与档案元数据哈希不符（模拟"读盘之后文件被换"的 TOCTOU）
  assert.throws(
    () => transfer.buildExportPackage({ profile: prof, games: [], notes: {}, avatar: { data: OTHER } }),
    (e) => e.code === 500 && /头像/.test(e.message) && /不一致/.test(e.message),
    '字节与元数据哈希不符时必须抛错',
  );
  // 元数据记着头像却根本没给数据（文件丢失 / 调用方没读盘）⇒ 同样失败，不许"少放一块"照常打包
  assert.throws(
    () => transfer.buildExportPackage({ profile: prof, games: [], notes: {} }),
    (e) => e.code === 500 && /头像/.test(e.message),
    '有元数据无字节时必须抛错',
  );
  // 一致时正常进包（反证：上面两条失败来自比对本身）
  const okPkg = transfer.buildExportPackage({ profile: prof, games: [], notes: {}, avatar: { data: GOOD } });
  assert.strictEqual(okPkg.profile.customAvatar.sha256, sha256Hex(GOOD));
  assert.ok(Buffer.from(okPkg.profile.customAvatar.dataBase64, 'base64').equals(GOOD));

  // API 层（真实路由）：把 readAvatar 换成"返回了另一张合法图"的桩 —— 模拟读盘后文件被换掉
  const realRead = api.profiles.readAvatar.bind(api.profiles);
  api.profiles.readAvatar = (id, opts) => ({ ...realRead(id, opts), data: OTHER });
  try {
    const exp = await call(api, 'GET', `/api/profiles/${pid}/export`);
    assert.strictEqual(exp.status, 500, '读盘后文件被换 ⇒ 导出必须失败');
    assert.match(exp.body.error, /头像/, '错误必须指出是头像问题');
    assert.ok(!exp.text.includes('"manifest"'), '失败时绝不给出一份"看起来完整"的包');
  } finally {
    api.profiles.readAvatar = realRead;
  }
  // 反证：恢复正常后同一份数据能导出，且包里的头像就是磁盘上那张
  const fine = await call(api, 'GET', `/api/profiles/${pid}/export`);
  assert.strictEqual(fine.status, 200);
  assert.strictEqual(fine.body.profile.customAvatar.sha256, sha256Hex(GOOD));
});

test('M1 §4.4 导出：文件丢失 / 被替换 / 损坏 ⇒ 导出失败并指出头像问题（不得静默导出"看似完整"的包）', async (t) => {
  const dataDir = makeDataDir('avt-exp-bad');
  const { api } = makeApiIn(dataDir);
  terminateAfter(t, api, dataDir);
  await api._profileMigrationReady;
  const pid = (await call(api, 'POST', '/api/profiles', { body: { nickname: '坏头像导出', avatarId: 'scholar' } })).body.profile.id;
  await call(api, 'PUT', `/api/profiles/${pid}/avatar`, { method: 'PUT', raw: GOOD, headers: { 'content-type': 'image/png' } });
  fs.writeFileSync(path.join(savesOf(dataDir), 'g-bad.json'), JSON.stringify(mkSaveDoc('g-bad', pid)));
  const file = path.join(dataDir, 'profiles', pid, 'avatar.png');
  const url = `/api/profiles/${pid}/export`;

  assert.strictEqual((await call(api, 'GET', url)).status, 200, '前置：完好时能导出');

  fs.writeFileSync(file, OTHER); // 合法图但哈希与元数据不符（= 文件被替换）
  const swapped = await call(api, 'GET', url);
  assert.strictEqual(swapped.status, 500);
  assert.match(swapped.body.error, /头像/, '错误必须指出是头像问题');
  assert.match(swapped.body.error, /不一致/);
  assert.ok(!swapped.text.includes('"manifest"'), '失败时不得给出任何包内容');

  fs.writeFileSync(file, png.corruptByte(GOOD)); // 结构损坏
  const corrupt = await call(api, 'GET', url);
  assert.strictEqual(corrupt.status, 500);
  assert.match(corrupt.body.error, /头像.*损坏|损坏.*头像/);

  fs.rmSync(file); // 文件丢失
  const missing = await call(api, 'GET', url);
  assert.strictEqual(missing.status, 500);
  assert.match(missing.body.error, /头像/);
  assert.match(missing.body.error, /缺失/);
  assert.ok(!missing.text.includes('"manifest"'), '失败时不得给出任何包内容');
});

// ---------------------------------------------------------------- 导入（§4.4）

test('M1 §4.4 导入：新 UUID + 头像写入新档案目录，字节与哈希都对，GET 可出图', async (t) => {
  const dataDir = makeDataDir('avt-imp');
  const { api } = makeApiIn(dataDir);
  terminateAfter(t, api, dataDir);
  await api._profileMigrationReady;

  const pkg = pkgFor('带头像', GOOD);
  const preview = await call(api, 'POST', '/api/profiles/import/preview', { method: 'POST', body: { package: pkg } });
  assert.strictEqual(preview.status, 200);
  assert.strictEqual(preview.body.preview.avatar, true, '预览必须能看出包里带自定义头像');

  const before = snapshot(path.join(dataDir, 'profiles'));
  const imp = await call(api, 'POST', '/api/profiles/import', { method: 'POST', body: { package: pkg } });
  assert.strictEqual(imp.status, 200);
  assert.strictEqual(imp.body.imported, 1);
  const newId = imp.body.profileId;
  assert.match(newId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, '导入必须创建新 UUID');
  assert.notStrictEqual(newId, pkg.manifest.packageId);

  const onDisk = fs.readFileSync(path.join(dataDir, 'profiles', newId, 'avatar.png'));
  assert.ok(onDisk.equals(GOOD), '头像必须逐字节落进新档案目录');
  const prof = api.profiles.get(newId);
  assert.strictEqual(prof.customAvatar.sha256, sha256Hex(GOOD));
  assert.strictEqual(prof.customAvatar.bytes, GOOD.length);
  assert.strictEqual(prof.customAvatar.mime, 'image/png');
  assert.strictEqual(prof.customAvatar.version, 1);

  const got = await call(api, 'GET', `/api/profiles/${newId}/avatar?v=${sha256Hex(GOOD)}`);
  assert.strictEqual(got.status, 200);
  assert.ok(got.bytes.equals(GOOD), '导入的头像必须能原样出图');
  assert.ok(snapshot(path.join(dataDir, 'profiles')).length > before.length, '确实落盘（对照组）');
});

test('M1 §4.4 导入校验失败：坏 Base64 / 哈希不符 / 尺寸 / 色彩类型 / 超 2MiB / 缺字段 ⇒ 400 且零写盘', async (t) => {
  const dataDir = makeDataDir('avt-imp-bad');
  const { api } = makeApiIn(dataDir);
  terminateAfter(t, api, dataDir);
  await api._profileMigrationReady;

  const b64 = (buf) => buf.toString('base64');
  const cases = [
    ['customAvatar 不是对象', { avatar: 'image/png' }, /必须是对象/],
    ['mime 不是 image/png', { avatar: { mime: 'image/jpeg', sha256: sha256Hex(GOOD), dataBase64: b64(GOOD) } }, /mime/],
    ['缺 dataBase64', { avatar: { mime: 'image/png', sha256: sha256Hex(GOOD) } }, /dataBase64/],
    ['Base64 含非法字符', { avatar: { mime: 'image/png', sha256: sha256Hex(GOOD), dataBase64: '!!!not-base64!!!' } }, /Base64/],
    ['Base64 长度不整（非规范）', { avatar: { mime: 'image/png', sha256: sha256Hex(GOOD), dataBase64: b64(GOOD).slice(0, -1) } }, /Base64/],
    ['Base64 解出来不是 PNG', { avatar: { mime: 'image/png', sha256: sha256Hex(png.notPng(64)), dataBase64: b64(png.notPng(64)) } }, /不是 PNG/],
    ['声明的 sha256 与实际不符', { avatar: { mime: 'image/png', sha256: 'a'.repeat(64), dataBase64: b64(GOOD) } }, /哈希不匹配/],
    ['sha256 不是 64 位小写十六进制', { avatar: { mime: 'image/png', sha256: 'A'.repeat(64), dataBase64: b64(GOOD) } }, /sha256/],
    ['尺寸不是 512×512', { data: png.makePng({ width: 256, height: 256 }) }, /尺寸必须是 512×512/],
    ['色彩类型不支持（灰度）', { data: png.makePng({ colorType: 0 }) }, /色彩类型不支持/],
    ['PNG 截断', { data: png.truncatePng(GOOD, 8) }, /截断|IEND/],
    ['超过 2 MiB', { data: png.makePng({ extras: [{ type: 'tEXt', data: Buffer.alloc(MAX_AVATAR_BYTES + 4096) }] }) }, /超过上限 2 MiB/],
  ];
  const before = snapshot(dataDir);
  for (const [name, spec, re] of cases) {
    const pkg = pkgFor(`坏头像-${name}`, spec.data, { avatar: spec.avatar });
    // 预览与导入都必须拒绝
    const prev = await call(api, 'POST', '/api/profiles/import/preview', { method: 'POST', body: { package: pkg } });
    assert.strictEqual(prev.status, 400, `${name}：preview 必须 400`);
    const imp = await call(api, 'POST', '/api/profiles/import', { method: 'POST', body: { package: pkg } });
    assert.strictEqual(imp.status, 400, `${name}：导入必须 400（实际 ${imp.status}：${imp.text.slice(0, 120)}）`);
    assert.match(imp.body.error, re, `${name}：错误文案必须点明原因`);
    assert.deepStrictEqual(snapshot(dataDir), before, `${name}：校验失败不得写任何东西（存档/档案/回收区/临时文件）`);
  }
  const list = await call(api, 'GET', '/api/profiles');
  assert.strictEqual(list.body.profiles.filter((p) => p.nickname.includes('坏头像')).length, 0, '不得创建任何档案');
});

test('M1 §4.4 导入回滚：头像写盘失败 ⇒ 整次导入回滚（档案进回收区、无残留、如实声明 rolledBack）', async (t) => {
  const dataDir = makeDataDir('avt-imp-rb');
  const { api } = makeApiIn(dataDir);
  terminateAfter(t, api, dataDir);
  await api._profileMigrationReady;

  const real = api.profiles.setAvatar.bind(api.profiles);
  const profilesRoot = path.join(dataDir, 'profiles');
  const beforeDirs = fs.readdirSync(profilesRoot); // 迁移可能已经建过「默认玩家」档案，只能比"新增"
  api.profiles.setAvatar = async () => { throw Object.assign(new Error('注入：头像写盘失败'), { code: 'EIO' }); };
  try {
    const out = await api.importApplyRes(pkgFor('回滚带头像', GOOD));
    assert.strictEqual(out.status, 500, '注入的 fs 故障必须是 500（字符串码不得当状态码）');
    assert.strictEqual(out.body.rolledBack, true);
    assert.strictEqual(out.body.cleanupComplete, true, '没有残留就必须如实声明清理完成');
    assert.strictEqual(out.body.cleanupPending, undefined);
  } finally {
    api.profiles.setAvatar = real;
  }
  const saves = fs.readdirSync(savesOf(dataDir)).filter((f) => f.endsWith('.json'));
  assert.deepStrictEqual(saves, [], '已写存档必须被回滚清理');
  const strays = fs.readdirSync(profilesRoot).filter((f) => !beforeDirs.includes(f) && f !== 'trash');
  assert.deepStrictEqual(strays, [], '不得留下半份导入档案目录（新增的档案目录必须已被回收）');
  assert.ok(api.profiles.listTrash().length >= 1, '导入创建的档案必须进回收区（可恢复，不静默丢数据）');
});

test('M1 §4.4 导入回滚：头像已写入后、后续步骤失败 ⇒ 头像随档案目录一起被回收，不留残渣', async (t) => {
  const dataDir = makeDataDir('avt-imp-rb2');
  const { api } = makeApiIn(dataDir);
  terminateAfter(t, api, dataDir);
  await api._profileMigrationReady;

  // 包里有笔记 → 写笔记这一步（在头像与存档之后）失败，触发整次导入回滚
  const pkg = pkgFor('后置失败', GOOD);
  pkg.notes = { 'g-imp': { schemaVersion: 2, profileId: 'o', gameId: 'g-imp', revision: 1, seats: { 1: { leaning: 'lean_wolf' } } } };
  const realPut = api.annotations.put.bind(api.annotations);
  api.annotations.put = async () => { throw Object.assign(new Error('注入：笔记写盘失败'), { code: 'EPERM' }); };
  try {
    const out = await api.importApplyRes(pkg);
    assert.strictEqual(out.status, 500);
    assert.strictEqual(out.body.rolledBack, true);
    assert.strictEqual(out.body.cleanupComplete, true);
  } finally {
    api.annotations.put = realPut;
  }
  assert.deepStrictEqual(fs.readdirSync(savesOf(dataDir)).filter((f) => f.endsWith('.json')), [], '存档必须被回滚');
  // 头像随着档案目录进了回收区（数据仍在、可恢复），而不是留在 categories 根或消失
  const trash = path.join(dataDir, 'profiles', 'trash');
  const archived = fs.readdirSync(trash).map((a) => path.join(trash, a, 'profile-dir', 'avatar.png'));
  assert.ok(archived.some((f) => fs.existsSync(f)), '回滚必须把带头像的档案目录整体移入回收区');
  const restored = archived.find((f) => fs.existsSync(f));
  assert.ok(fs.readFileSync(restored).equals(GOOD), '回收区里的头像字节不变（可恢复）');
});

// ---------------------------------------------------------------- 体积账（20MiB 总上限）

test('M1 §4.4 自定义头像计入 20MiB 总上限（导入 + 导出各证一次，用收紧阈值证明它被算进去）', async (t) => {
  const dataDir = makeDataDir('avt-limit');
  const { api } = makeApiIn(dataDir);
  terminateAfter(t, api, dataDir);
  await api._profileMigrationReady;

  // ≈1MB 不可压缩头像（base64 后 ≈1.4MB）+ 一局 ≈1.5MB 的已结束对局
  const bigAvatar = png.makePng({ noise: true });
  assert.ok(bigAvatar.length > 900 * 1024, `前置：噪声图必须足够大（实际 ${bigAvatar.length} 字节）`);
  const bigGame = gameOf('g-big', { textLen: Math.round(1.5 * 1024 * 1024) });
  const pid = (await call(api, 'POST', '/api/profiles', { body: { nickname: '体积账', avatarId: 'scholar' } })).body.profile.id;
  fs.writeFileSync(path.join(savesOf(dataDir), 'g-big.json'), JSON.stringify({ ...mkSaveDoc('g-big', pid), game: bigGame }));
  await call(api, 'PUT', `/api/profiles/${pid}/avatar`, { method: 'PUT', raw: bigAvatar, headers: { 'content-type': 'image/png' } });

  const saved = transfer.MAX_BYTES;
  try {
    // 收紧到 2MiB：不含头像时通过（≈1.5MB），含头像时超限（≈2.9MB）—— 差额只能来自头像本身
    transfer.MAX_BYTES = 2 * 1024 * 1024;
    const withAvatar = await call(api, 'GET', `/api/profiles/${pid}/export`);
    assert.strictEqual(withAvatar.status, 413, '头像必须计入导出包体积（收紧阈值后应超限）');
    assert.match(withAvatar.body.error, /超过上限/);

    assert.strictEqual((await call(api, 'DELETE', `/api/profiles/${pid}/avatar`, { method: 'DELETE' })).status, 200);
    const withoutAvatar = await call(api, 'GET', `/api/profiles/${pid}/export`);
    assert.strictEqual(withoutAvatar.status, 200, '同一份对局数据去掉头像后必须能导出（证明超限来自头像）');
    assert.ok(!withoutAvatar.body.profile.customAvatar);

    // 导入侧同理：同一个包（大对局 + 头像）在读 body 阶段就 413，且零写盘
    const pkg = pkgFor('超限包', bigAvatar, { games: [gameOf('g-limit', { textLen: Math.round(1.5 * 1024 * 1024) })] });
    const before = snapshot(dataDir);
    const oversize = await call(api, 'POST', '/api/profiles/import', { method: 'POST', body: { package: pkg } });
    assert.strictEqual(oversize.status, 413, '头像必须计入导入包体积上限');
    assert.deepStrictEqual(snapshot(dataDir), before, '413 之后不得有任何写盘');

    const noAvatarPkg = pkgFor('不超限包', null, { games: [gameOf('g-limit2', { textLen: Math.round(1.5 * 1024 * 1024) })] });
    const fits = await call(api, 'POST', '/api/profiles/import', { method: 'POST', body: { package: noAvatarPkg } });
    assert.strictEqual(fits.status, 200, '去掉头像的同一份包必须能导入（证明超限来自头像）');
  } finally {
    transfer.MAX_BYTES = saved; // 阈值只在用例内收紧，绝不改仓库值（scripts/coverage-gate.js 不参与）
  }
  // 还原真实阈值后，同一份带头像的导出必须正常（没有把能力改小）
  await call(api, 'PUT', `/api/profiles/${pid}/avatar`, { method: 'PUT', raw: bigAvatar, headers: { 'content-type': 'image/png' } });
  assert.strictEqual(transfer.MAX_BYTES, 20 * 1024 * 1024);
  const real = await call(api, 'GET', `/api/profiles/${pid}/export`);
  assert.strictEqual(real.status, 200, '真实 20MiB 阈值下带头像的导出必须正常');
  assert.strictEqual(real.body.profile.customAvatar.sha256, sha256Hex(bigAvatar));
});
