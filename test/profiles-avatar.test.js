/**
 * profiles-avatar.test.js — M1 自定义头像：存储层（§4.2）与窄接口（§4.3）回归
 *
 * 验收原文：「头像上传/回退/迁移单测通过」。本文件按四组覆盖：
 *   ① 存储层：上传成功（元数据 ≡ 磁盘）、旧档案无 customAvatar 仍按 avatarId 工作（无需迁移）、
 *      非法输入逐条被拒、expectedRevision 冲突、故障注入下保留旧头像、切回内置（先元数据后清理）、
 *      归档/回收站/恢复后头像随目录移动、陈旧头像临时文件进入启动清理；
 *   ② 接口层：PUT/DELETE/GET 契约（Content-Type 精确、体积、强 ETag、私有缓存、404/500 不含 HTML）、
 *      未授权 / 错 Origin / 限流、删除后回退到 avatarId；
 *   ③ 元数据剥离：上传时剥掉 tEXt/eXIf/tIME（原始文件名/EXIF 不落盘）；
 *   ④ 顺序与故障注入的"红线"：任何一步失败都不得留下"新图片 + 旧元数据"或"旧图被清空"。
 *
 * 隔离：一律走 test/helpers-tmpdir.js 的独占 dataDir（os.tmpdir()/ww-*），绝不写仓库内或共享路径。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const events = require('node:events');
const crypto = require('node:crypto');

const { ProfileStore, avatarUrlOf } = require('../src/profiles/store');
const { AVATAR_MIME, MAX_AVATAR_BYTES, sha256Hex } = require('../src/profiles/avatar');
const { makeDataDir, makeApiIn, cleanupAfter, terminateAfter } = require('./helpers-tmpdir');
const png = require('./helpers-png');

/** 收集 logger 输出（"清理失败只记可恢复告警"这类分支必须能被断言，不能只靠眼睛） */
function loggerSink() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  const logger = { openGameLog() {}, closeGameLog() {}, query() { return []; } };
  for (const level of Object.keys(lines)) logger[level] = (scope, msg) => lines[level].push(`${scope}: ${msg}`);
  return { logger, lines };
}
const silentLogger = loggerSink().logger;

/** 合法头像（512×512 RGBA，真 zlib 压缩、真 CRC）—— 压缩后很小，可反复写盘 */
const GOOD = png.makePng();
/** 另一张合法头像（内容不同，用于"换头像"与"新旧对比"） */
const OTHER = png.makePng({ width: 512, height: 512, colorType: 2 });

function avatarPath(dataDir, id) { return path.join(dataDir, 'profiles', id, 'avatar.png'); }
function profileJsonPath(dataDir, id) { return path.join(dataDir, 'profiles', id, 'profile.json'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

// ---------------------------------------------------------------- 存储层（§4.2）

test('M1 §4.2 上传成功：profile.json 元数据与磁盘字节一致，URL 用内容哈希', async (t) => {
  const dir = cleanupAfter(t, makeDataDir('av-ok'));
  const store = new ProfileStore({ dataDir: dir, logger: silentLogger });
  const p = await store.create({ nickname: '砚舟', avatarId: 'hunter' });
  const out = await store.setAvatar(p.id, GOOD);

  assert.strictEqual(out.profile.avatarId, 'hunter', '自定义头像不得改动 avatarId（它仍是错误回退）');
  assert.deepStrictEqual(
    Object.keys(out.profile.customAvatar).sort(),
    ['bytes', 'mime', 'sha256', 'updatedAt', 'version'],
    'customAvatar 字段集合必须与 §4.2 的契约完全一致',
  );
  assert.strictEqual(out.profile.customAvatar.version, 1);
  assert.strictEqual(out.profile.customAvatar.mime, AVATAR_MIME);
  assert.strictEqual(out.profile.customAvatar.bytes, GOOD.length);
  assert.strictEqual(out.profile.customAvatar.sha256, sha256Hex(GOOD));
  assert.ok(!Number.isNaN(Date.parse(out.profile.customAvatar.updatedAt)), 'updatedAt 必须可解析（ISO-8601）');
  assert.strictEqual(out.profile.revision, p.revision + 1, '写头像也是档案更新，revision 必须递增');
  assert.strictEqual(out.avatarUrl, `/api/profiles/${p.id}/avatar?v=${sha256Hex(GOOD)}`, 'URL 必须用内容哈希版本化');

  const onDisk = fs.readFileSync(avatarPath(dir, p.id));
  assert.ok(onDisk.equals(GOOD), '磁盘字节必须与上传字节逐字节一致');
  assert.strictEqual(sha256Hex(onDisk), out.profile.customAvatar.sha256, '元数据哈希必须等于磁盘文件哈希');

  // 换一个 store 实例（= 重启服务）后元数据仍在 profile.json 里，且列表摘要带上 avatarUrl
  const fresh = new ProfileStore({ dataDir: dir, logger: silentLogger });
  assert.deepStrictEqual(fresh.get(p.id).customAvatar, out.profile.customAvatar);
  const row = fresh.list({ includeArchived: true }).find((x) => x.id === p.id);
  assert.strictEqual(row.avatarUrl, out.avatarUrl);
  assert.strictEqual(row.customAvatar.sha256, out.profile.customAvatar.sha256);
});

test('M1 §4.2 旧档案无 customAvatar：完全按 avatarId 工作、无需迁移、读操作不写盘', async (t) => {
  const dir = cleanupAfter(t, makeDataDir('av-legacy'));
  const id = crypto.randomUUID();
  const legacy = {
    schemaVersion: 1, id, nickname: '老档', avatarId: 'wolf', bio: '',
    preferences: { fontScale: 1, layout: 'reading', reducedMotion: false },
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    lastUsedAt: '2025-01-01T00:00:00.000Z', archivedAt: null, revision: 3,
  };
  fs.mkdirSync(path.join(dir, 'profiles', id), { recursive: true });
  fs.writeFileSync(profileJsonPath(dir, id), JSON.stringify(legacy, null, 2));
  fs.writeFileSync(path.join(dir, 'profiles', 'index.json'), JSON.stringify({
    schemaVersion: 1, revision: 1,
    profiles: [{ id, nickname: '老档', avatarId: 'wolf', archivedAt: null, updatedAt: legacy.updatedAt }],
  }, null, 2));
  const before = fs.readFileSync(profileJsonPath(dir, id));

  const store = new ProfileStore({ dataDir: dir, logger: silentLogger });
  const p = store.get(id);
  assert.strictEqual(p.customAvatar, undefined, '旧档案不得被"顺手补上" customAvatar');
  assert.strictEqual(avatarUrlOf(p), null, '没有自定义头像 ⇒ avatarUrl 必须是 null（前端按 avatarId 显示内置图）');
  const row = store.list({ includeArchived: true }).find((x) => x.id === id);
  assert.strictEqual(row.avatarId, 'wolf');
  assert.strictEqual(row.customAvatar, null);
  assert.strictEqual(row.avatarUrl, null);
  // 「无需迁移」的硬证据：只读操作之后 profile.json 逐字节不变
  assert.ok(fs.readFileSync(profileJsonPath(dir, id)).equals(before), '读路径不得改写旧档案（无需迁移）');
  // 按 avatarId 更新照常
  const upd = await store.update(id, { avatarId: 'seer' });
  assert.strictEqual(upd.avatarId, 'seer');
  assert.strictEqual(upd.customAvatar, undefined);
});

test('M1 §4.3 非法头像逐条被拒：非 PNG/截断/CRC 损坏/解压失败/尺寸/位深/色彩类型/隔行/空/超限', async (t) => {
  const dir = cleanupAfter(t, makeDataDir('av-bad'));
  const store = new ProfileStore({ dataDir: dir, logger: silentLogger });
  const p = await store.create({ nickname: '坏图', avatarId: 'scholar' });
  const before = fs.readFileSync(profileJsonPath(dir, p.id));

  const cases = [
    ['空 body（0 字节）', Buffer.alloc(0), /空（0 字节）/],
    ['非 PNG（扩展名/Content-Type 谎报不影响判定）', png.notPng(), /不是 PNG/],
    ['截断：丢掉 IEND', png.truncatePng(GOOD, 8), /截断|IEND/],
    ['截断：砍在 IDAT 中间', png.truncatePng(GOOD, 64), /截断|内容不完整/],
    ['损坏：IDAT 内有字节被翻转（CRC 不匹配）', png.corruptByte(GOOD), /校验和不匹配/],
    ['畸形：尾部拼接垃圾字节', png.appendTrailingGarbage(GOOD), /尾部有多余字节/],
    ['无法完整读取：IDAT 不是可解压的 zlib 流（CRC 重算过）', png.makePng({ idatData: Buffer.from('this is not a zlib stream') }), /无法完整读取|长度不符/],
    ['尺寸不符：256×256', png.makePng({ width: 256, height: 256 }), /尺寸必须是 512×512/],
    ['尺寸不符：512×513', png.makePng({ width: 512, height: 513 }), /尺寸必须是 512×512/],
    ['位深不是 8-bit：16-bit', png.makePng({ bitDepth: 16, colorType: 6 }), /位深必须是 8-bit/],
    ['色彩类型不支持：灰度(0)', png.makePng({ colorType: 0 }), /色彩类型不支持/],
    ['色彩类型不支持：调色板(3)', png.makePng({ colorType: 3 }), /色彩类型不支持/],
    ['色彩类型不支持：灰度+alpha(4)', png.makePng({ colorType: 4 }), /色彩类型不支持/],
    ['隔行扫描（interlace=1）', png.makePng({ interlace: 1 }), /隔行扫描/],
    ['超过 2 MiB 上限', png.makePng({ extras: [{ type: 'tEXt', data: Buffer.alloc(MAX_AVATAR_BYTES + 4096) }] }), /超过上限 2 MiB/],
  ];
  for (const [name, buf, re] of cases) {
    await assert.rejects(
      () => store.setAvatar(p.id, buf),
      (e) => e.code === 400 && re.test(e.message),
      `${name}：必须 400 且文案点明原因（实际：${name}）`,
    );
    assert.strictEqual(fs.existsSync(avatarPath(dir, p.id)), false, `${name}：被拒的输入不得留下任何 avatar.png`);
  }
  assert.ok(fs.readFileSync(profileJsonPath(dir, p.id)).equals(before), '全部被拒 ⇒ profile.json 一个字节都不该动');
});

test('M1 §4.3 expectedRevision 冲突：409，且旧头像与旧元数据都不动', async (t) => {
  const dir = cleanupAfter(t, makeDataDir('av-rev'));
  const store = new ProfileStore({ dataDir: dir, logger: silentLogger });
  const p = await store.create({ nickname: '并发', avatarId: 'scholar' });
  const first = await store.setAvatar(p.id, GOOD);
  const rev = first.profile.revision;

  await assert.rejects(
    () => store.setAvatar(p.id, OTHER, { expectedRevision: rev - 1 }),
    (e) => e.code === 409 && /revision/.test(e.message),
    '过期 revision 必须是 409',
  );
  assert.ok(fs.readFileSync(avatarPath(dir, p.id)).equals(GOOD), '冲突后的旧头像必须原封不动');
  assert.strictEqual(store.get(p.id).customAvatar.sha256, sha256Hex(GOOD));
  assert.strictEqual(store.get(p.id).revision, rev);

  // 正确 revision → 成功替换
  const second = await store.setAvatar(p.id, OTHER, { expectedRevision: rev });
  assert.strictEqual(second.profile.customAvatar.sha256, sha256Hex(OTHER));
  assert.ok(fs.readFileSync(avatarPath(dir, p.id)).equals(OTHER));

  // 删除同样受 revision 保护
  await assert.rejects(() => store.clearAvatar(p.id, { expectedRevision: rev }), (e) => e.code === 409);
  assert.ok(fs.existsSync(avatarPath(dir, p.id)), '删除冲突时图片必须还在');
});

test('M1 §4.2 故障注入：写图失败 / 改名失败 / 元数据写失败，一律保留旧文件与旧元数据', async (t) => {
  const dir = cleanupAfter(t, makeDataDir('av-fault'));
  const { logger, lines } = loggerSink();
  const store = new ProfileStore({ dataDir: dir, logger });
  const p = await store.create({ nickname: '故障', avatarId: 'scholar' });
  const first = await store.setAvatar(p.id, GOOD);
  const oldMeta = first.profile.customAvatar;
  const oldRev = first.profile.revision;

  const realWrite = fs.promises.writeFile;
  const realRename = fs.promises.rename;
  const inject = async (label, patchWrite, patchRename) => {
    fs.promises.writeFile = realWrite;
    fs.promises.rename = realRename;
    lines.warn.length = 0;
    if (patchWrite) fs.promises.writeFile = patchWrite;
    if (patchRename) fs.promises.rename = patchRename;
    try {
      await assert.rejects(() => store.setAvatar(p.id, OTHER), /注入的磁盘故障/, `${label}：故障必须抛给调用方`);
    } finally {
      fs.promises.writeFile = realWrite;
      fs.promises.rename = realRename;
    }
    assert.ok(fs.readFileSync(avatarPath(dir, p.id)).equals(GOOD), `${label}：旧头像文件必须逐字节保留`);
    assert.deepStrictEqual(store.get(p.id).customAvatar, oldMeta, `${label}：旧元数据必须保留`);
    assert.strictEqual(store.get(p.id).revision, oldRev, `${label}：revision 不得推进`);
    const leftovers = fs.readdirSync(path.join(dir, 'profiles', p.id)).filter((f) => f !== 'profile.json' && f !== 'avatar.png' && f !== 'annotations');
    assert.deepStrictEqual(leftovers, [], `${label}：不得留下临时文件残渣（实际 ${leftovers.join('、')}）`);
  };

  // ① 写临时图片失败（第②步）
  await inject('写临时图片失败',
    async (file, ...rest) => {
      if (String(file).includes('.tmp-avatar.png')) throw Object.assign(new Error('注入的磁盘故障：写临时图片失败'), { code: 'ENOSPC' });
      return realWrite(file, ...rest);
    });
  // ② 原子改名失败（第④步）
  await inject('原子改名失败', null,
    async (from, to) => {
      if (String(to).endsWith('avatar.png')) throw Object.assign(new Error('注入的磁盘故障：改名失败'), { code: 'EPERM' });
      return realRename(from, to);
    });
  // ③ 元数据写失败（第⑤步；图片已经替换成功）⇒ 必须把图片回滚成旧的
  await inject('元数据写失败',
    async (file, ...rest) => {
      if (String(file).includes('.tmp-profile.json')) throw Object.assign(new Error('注入的磁盘故障：元数据写失败'), { code: 'EIO' });
      return realWrite(file, ...rest);
    });
});

test('M1 §4.2 元数据写失败且回滚也失败：留可恢复告警，错误仍然抛给调用方（不静默）', async (t) => {
  const dir = cleanupAfter(t, makeDataDir('av-fault2'));
  const { logger, lines } = loggerSink();
  const store = new ProfileStore({ dataDir: dir, logger });
  const p = await store.create({ nickname: '双重故障', avatarId: 'scholar' });
  await store.setAvatar(p.id, GOOD);

  const realWrite = fs.promises.writeFile;
  const realRename = fs.promises.rename;
  let renameToAvatar = 0;
  try {
    fs.promises.writeFile = async (file, ...rest) => {
      if (String(file).includes('.tmp-profile.json')) throw Object.assign(new Error('注入的磁盘故障：元数据写失败'), { code: 'EIO' });
      return realWrite(file, ...rest);
    };
    // 正向改名（第 1 次，替换 avatar.png）放行；回滚时写回旧图片的那次（第 2 次）失败
    fs.promises.rename = async (from, to) => {
      if (String(to).endsWith('avatar.png') && ++renameToAvatar >= 2) {
        throw Object.assign(new Error('注入的磁盘故障：回滚也失败'), { code: 'EPERM' });
      }
      return realRename(from, to);
    };
    await assert.rejects(() => store.setAvatar(p.id, OTHER), /元数据写失败/, '元数据写失败必须抛错');
  } finally {
    fs.promises.writeFile = realWrite;
    fs.promises.rename = realRename;
  }
  assert.ok(lines.warn.some((l) => /头像回滚失败/.test(l)), '回滚失败必须留下可恢复告警（不得静默）');
  // 元数据仍是旧的（没写成）⇒ GET/导出会按哈希核对发现不一致并回落内置头像，不会静默出坏图
  assert.strictEqual(store.get(p.id).customAvatar.sha256, sha256Hex(GOOD));
});

test('M1 §4.1/§4.2 切回内置：先原子更新元数据、再清理图片；清理失败只告警不失败', async (t) => {
  const dir = cleanupAfter(t, makeDataDir('av-clear'));
  const { logger, lines } = loggerSink();
  const store = new ProfileStore({ dataDir: dir, logger });
  const p = await store.create({ nickname: '回退', avatarId: 'candle' });
  const after = await store.setAvatar(p.id, GOOD);

  const cleared = await store.clearAvatar(p.id, { expectedRevision: after.profile.revision });
  assert.strictEqual(cleared.avatarUrl, null, '删除后 avatarUrl 必须是 null（前端回退 avatarId，不回退成破图）');
  assert.strictEqual(cleared.profile.avatarId, 'candle', 'avatarId 必须保留');
  assert.ok(!('customAvatar' in readJson(profileJsonPath(dir, p.id))), 'profile.json 不得残留 customAvatar 键');
  assert.strictEqual(fs.existsSync(avatarPath(dir, p.id)), false, '不再被引用的图片必须被清理');
  assert.strictEqual(cleared.profile.revision, after.profile.revision + 1);

  // 幂等：再删一次不报错、不推进 revision
  const again = await store.clearAvatar(p.id);
  assert.strictEqual(again.avatarUrl, null);
  assert.strictEqual(again.profile.revision, cleared.profile.revision);

  // 清理失败：把 avatar.png 换成同名目录 ⇒ unlink 必然失败。元数据仍必须更新成功（顺序：先元数据后清理）
  await store.setAvatar(p.id, OTHER);
  fs.rmSync(avatarPath(dir, p.id));
  fs.mkdirSync(avatarPath(dir, p.id));
  const stubborn = await store.clearAvatar(p.id);
  assert.strictEqual(stubborn.avatarUrl, null, '清理失败不得让资料更新失败');
  assert.ok(!('customAvatar' in readJson(profileJsonPath(dir, p.id))), '元数据必须已经原子更新（先元数据、后清理）');
  assert.ok(lines.warn.some((l) => /自定义头像文件清理失败/.test(l)), '清理失败必须留可恢复告警');
  assert.ok(fs.existsSync(avatarPath(dir, p.id)), '注入场景下残留真实存在（证明"清理失败"这条分支被走到）');
});

test('M1 §4.2 归档/回收站/恢复：头像随整个档案目录移动，恢复后元数据与字节都在', async (t) => {
  const dir = cleanupAfter(t, makeDataDir('av-trash'));
  const store = new ProfileStore({ dataDir: dir, logger: silentLogger });
  const p = await store.create({ nickname: '搬家', avatarId: 'night' });
  await store.create({ nickname: '留守档案', avatarId: 'scholar' }); // 归档受"最后一份可用档案"保护，必须还有别的可用档案
  await store.setAvatar(p.id, GOOD);

  await store.update(p.id, { archive: true });
  // 已归档档案不可改头像（与其它编辑同语义）
  await assert.rejects(() => store.setAvatar(p.id, OTHER), (e) => e.code === 400 && /归档/.test(e.message));
  assert.ok(fs.readFileSync(avatarPath(dir, p.id)).equals(GOOD), '归档不动图片');

  await store.trash(p.id);
  const archiveId = fs.readdirSync(path.join(dir, 'profiles', 'trash'))[0];
  const inTrash = path.join(dir, 'profiles', 'trash', archiveId, 'profile-dir', 'avatar.png');
  assert.ok(fs.existsSync(inTrash), '回收区里的档案目录必须带着 avatar.png（整目录移动）');
  assert.ok(fs.readFileSync(inTrash).equals(GOOD));

  const restored = store.restoreFromTrash(archiveId);
  assert.strictEqual(restored.customAvatar.sha256, sha256Hex(GOOD), '恢复后元数据仍在');
  assert.ok(fs.readFileSync(avatarPath(dir, p.id)).equals(GOOD), '恢复后字节一致');
  // 恢复+取消归档（API 的 restore 路由就是这两步）后按内置头像走也正常
  await store.update(p.id, { restore: true });
  const back = await store.clearAvatar(p.id);
  assert.strictEqual(back.avatarUrl, null);
  assert.strictEqual(back.profile.avatarId, 'night');
});

test('M1 §4.2 落盘校验（③）：读回的字节被篡改 ⇒ 抛错、绝不原子替换、旧图与旧元数据原样', async (t) => {
  const dir = cleanupAfter(t, makeDataDir('av-tamper'));
  const { logger } = loggerSink();
  const store = new ProfileStore({ dataDir: dir, logger });
  const p = await store.create({ nickname: '落盘校验', avatarId: 'scholar' });
  await store.setAvatar(p.id, GOOD); // 前置：磁盘上已有一张旧头像
  const oldMeta = store.get(p.id).customAvatar;
  const oldRev = store.get(p.id).revision;
  const dirP = path.join(dir, 'profiles', p.id);

  const realRead = fs.promises.readFile;
  /** 让"读回临时文件"这一步返回被掉包的内容（写入是真的，读回的才是假的） */
  const tamper = async (label, swap, re) => {
    let hits = 0;
    fs.promises.readFile = async (file, ...rest) => {
      const buf = await realRead(file, ...rest);
      if (!String(file).includes('.tmp-avatar.png')) return buf;
      hits++;
      return swap(buf);
    };
    try {
      await assert.rejects(() => store.setAvatar(p.id, OTHER), (e) => re.test(e.message), `${label}：必须抛错且文案可读`);
    } finally {
      fs.promises.readFile = realRead;
    }
    assert.strictEqual(hits, 1, `${label}：掉包必须真的落在"读回临时文件"那一步`);
    assert.ok(fs.readFileSync(avatarPath(dir, p.id)).equals(GOOD), `${label}：被掉包的字节绝不能被 rename 成 avatar.png`);
    assert.deepStrictEqual(store.get(p.id).customAvatar, oldMeta, `${label}：元数据必须保留`);
    assert.strictEqual(store.get(p.id).revision, oldRev, `${label}：revision 不得推进`);
    assert.deepStrictEqual(fs.readdirSync(dirP).filter((f) => f.startsWith('.tmp-')), [], `${label}：不得留下临时残渣`);
  };

  // ③-a 读回后结构已不合法（字节被破坏）⇒ 结构校验这一条抓到
  await tamper('读回结构不合法', (buf) => png.corruptByte(buf), /落盘校验失败.*结构不合法/);
  // ③-b 读回的是**另一张合法 512×512 图**（结构没问题，哈希不同）⇒ 哈希比对这一条抓到。
  //     注意掉包内容必须与"本次要上传的 OTHER"不同，否则哈希恰好相等、这条分支永远走不到。
  await tamper('读回内容被掉包（合法但不同）', () => GOOD, /落盘校验失败.*SHA-256 不符/);

  // 反证：不再掉包时，同一张图能正常上传（失败来自注入，不是因为图本身不合法）
  const ok = await store.setAvatar(p.id, OTHER);
  assert.strictEqual(ok.profile.customAvatar.sha256, sha256Hex(OTHER));
  assert.ok(fs.readFileSync(avatarPath(dir, p.id)).equals(OTHER));
});

test('M1 §4.2 头像临时文件进入既有启动清理规则（A 族命名、只清陈旧、不动正式文件）', async (t) => {
  const dir = cleanupAfter(t, makeDataDir('av-tmp'));
  const store = new ProfileStore({ dataDir: dir, logger: silentLogger });
  const p = await store.create({ nickname: '临时', avatarId: 'scholar' });
  const dirP = path.join(dir, 'profiles', p.id);
  const stale = path.join(dirP, '.tmp-avatar.png-99999-1');
  const fresh = path.join(dirP, '.tmp-avatar.png-99999-2');
  fs.writeFileSync(stale, 'half-written');
  fs.writeFileSync(fresh, 'half-written');
  const old = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  await store.setAvatar(p.id, GOOD);

  const restarted = new ProfileStore({ dataDir: dir, logger: silentLogger }); // 构造即触发启动清理
  assert.strictEqual(fs.existsSync(stale), false, '陈旧的头像临时文件必须被启动清理删掉');
  assert.strictEqual(fs.existsSync(fresh), true, '新鲜的 tmp 可能是别的进程正在写，必须保留');
  assert.ok(fs.existsSync(avatarPath(dir, p.id)), '正式 avatar.png 不是 tmp，绝不能被清掉');
  assert.ok(fs.readFileSync(avatarPath(dir, p.id)).equals(GOOD));
  assert.strictEqual(restarted.get(p.id).customAvatar.sha256, sha256Hex(GOOD));
});

test('M1 §4.4 落盘前剥离元数据块：原始文件名/EXIF/tIME 不进 avatar.png', async (t) => {
  const dir = cleanupAfter(t, makeDataDir('av-strip'));
  const store = new ProfileStore({ dataDir: dir, logger: silentLogger });
  const p = await store.create({ nickname: '带 EXIF', avatarId: 'scholar' });
  const withMeta = png.makePngWithUserMetadata();
  const out = await store.setAvatar(p.id, withMeta);

  const onDisk = fs.readFileSync(avatarPath(dir, p.id));
  assert.ok(onDisk.length < withMeta.length, '剥离后必须比原图小（元数据块被去掉）');
  for (const type of ['tEXt', 'eXIf', 'tIME']) {
    assert.strictEqual(onDisk.includes(Buffer.from(type, 'latin1')), false, `${type} 块不得落盘`);
  }
  assert.strictEqual(onDisk.includes(Buffer.from('C:\\Users\\me\\Pictures', 'latin1')), false, '原始文件名/路径不得落盘');
  assert.strictEqual(out.profile.customAvatar.sha256, sha256Hex(onDisk), '元数据哈希必须指向**落盘字节**（剥离后）');
  assert.strictEqual(out.profile.customAvatar.bytes, onDisk.length);
  // 剥离后仍是合法 512×512 PNG，能出图
  const read = store.readAvatar(p.id);
  assert.strictEqual(read.sha256, out.profile.customAvatar.sha256);
  assert.strictEqual(read.data.length, onDisk.length);
});

test('M1 §4.3 readAvatar：文件缺失 404、被替换/损坏 500、版本过期 404', async (t) => {
  const dir = cleanupAfter(t, makeDataDir('av-read'));
  const store = new ProfileStore({ dataDir: dir, logger: silentLogger });
  const p = await store.create({ nickname: '读图', avatarId: 'scholar' });
  // readAvatar 是同步抛错的，必须用 async 包装：assert.rejects 只把"返回的 rejected promise"当作待断言对象
  await assert.rejects(async () => store.readAvatar(p.id), (e) => e.code === 404, '没有自定义头像 → 404');

  await store.setAvatar(p.id, GOOD);
  const sha = sha256Hex(GOOD);
  assert.strictEqual(store.readAvatar(p.id).data.length, GOOD.length);
  assert.strictEqual(store.readAvatar(p.id, { expectedSha: sha }).etag, `"${sha}"`, 'ETag 必须是内容哈希（强标签）');
  await assert.rejects(async () => store.readAvatar(p.id, { expectedSha: 'f'.repeat(64) }), (e) => e.code === 404, '旧 URL → 404');

  // 文件被换成另一张合法图（哈希与元数据不符）→ 500
  fs.writeFileSync(avatarPath(dir, p.id), OTHER);
  await assert.rejects(async () => store.readAvatar(p.id), (e) => e.code === 500 && /不一致/.test(e.message));
  // 文件被损坏（结构都不合法）→ 500
  fs.writeFileSync(avatarPath(dir, p.id), png.corruptByte(GOOD));
  await assert.rejects(async () => store.readAvatar(p.id), (e) => e.code === 500 && /损坏/.test(e.message));
  // 文件被删 → 404
  fs.rmSync(avatarPath(dir, p.id));
  await assert.rejects(async () => store.readAvatar(p.id), (e) => e.code === 404 && /缺失/.test(e.message));
});

// ---------------------------------------------------------------- 接口层（§4.3）

function stubReq({ method = 'GET', headers = {}, body = null, raw = null, remote = '127.0.0.1', hdrs = {} } = {}) {
  const req = new events.EventEmitter();
  req.method = method;
  req.headers = { host: 'localhost:3210', ...hdrs, ...headers };
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

function jsonOf(raw) {
  if (raw === undefined || raw === null) return null;
  if (Buffer.isBuffer(raw) && raw.length && raw[0] === 0x89) return null; // 图片字节不是 JSON
  try { return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); } catch (_) { return null; }
}

async function call(api, method, pathname, opts = {}) {
  const u = new URL(pathname, 'http://localhost');
  const box = stubRes();
  await api.handle(stubReq({ method, ...opts }), box.res, u.pathname, u.searchParams);
  const headers = {};
  for (const [k, v] of Object.entries(box.headers)) headers[k.toLowerCase()] = v;
  const raw = box.raw;
  return {
    status: box.code, headers, raw,
    bytes: Buffer.isBuffer(raw) ? raw : (raw != null ? Buffer.from(String(raw)) : Buffer.alloc(0)),
    text: raw == null ? '' : (Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)),
    body: jsonOf(raw),
  };
}

const PNG_HEADERS = { 'content-type': 'image/png' };

test('M1 §4.3 PUT/GET：上传成功、摘要带 avatarUrl、强 ETag + 私有缓存、If-None-Match ⇒ 304', async (t) => {
  const dataDir = makeDataDir('av-api-ok');
  const { api } = makeApiIn(dataDir);
  terminateAfter(t, api, dataDir);
  await api._profileMigrationReady;
  const created = await call(api, 'POST', '/api/profiles', { body: { nickname: '出图', avatarId: 'seer' } });
  const pid = created.body.profile.id;

  const put = await call(api, 'PUT', `/api/profiles/${pid}/avatar`, { method: 'PUT', raw: GOOD, hdrs: PNG_HEADERS });
  assert.strictEqual(put.status, 200);
  const sha = sha256Hex(GOOD);
  assert.strictEqual(put.body.avatarUrl, `/api/profiles/${pid}/avatar?v=${sha}`);
  assert.strictEqual(put.body.profile.customAvatar.sha256, sha);
  assert.strictEqual(put.body.profile.avatarId, 'seer');

  // 列表摘要（前端首页/玩家中心据此取图）
  const list = await call(api, 'GET', '/api/profiles');
  const row = list.body.profiles.find((x) => x.id === pid);
  assert.strictEqual(row.avatarUrl, put.body.avatarUrl);
  assert.strictEqual(row.customAvatar.bytes, GOOD.length);

  const got = await call(api, 'GET', `/api/profiles/${pid}/avatar?v=${sha}`);
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.headers['content-type'], 'image/png');
  assert.strictEqual(got.headers['cache-control'], 'private, max-age=31536000, immutable');
  assert.strictEqual(got.headers.etag, `"${sha}"`, '必须是强 ETag（内容哈希，无 W/ 前缀）');
  assert.strictEqual(got.headers['content-length'], String(GOOD.length));
  assert.ok(got.bytes.equals(GOOD), '出图字节必须与上传字节逐字节一致');

  // 协商缓存
  const cached = await call(api, 'GET', `/api/profiles/${pid}/avatar?v=${sha}`, { hdrs: { 'if-none-match': `"${sha}"` } });
  assert.strictEqual(cached.status, 304, 'If-None-Match 命中 → 304 不带 body');
  assert.strictEqual(cached.headers.etag, `"${sha}"`);
  const stale = await call(api, 'GET', `/api/profiles/${pid}/avatar?v=${sha}`, { hdrs: { 'if-none-match': '"deadbeef"' } });
  assert.strictEqual(stale.status, 200);

  // 无 ?v= 也允许（服务当前头像）；带过期 v → 404，前端回落 avatarId
  assert.strictEqual((await call(api, 'GET', `/api/profiles/${pid}/avatar`)).status, 200);
  assert.strictEqual((await call(api, 'GET', `/api/profiles/${pid}/avatar?v=${'a'.repeat(64)}`)).status, 404);
});

test('M1 §4.3 PUT 边界：Content-Type 精确 image/png、体积 0<n≤2MiB、X-Profile-Revision 必须合法整数', async (t) => {
  const dataDir = makeDataDir('av-api-bound');
  const { api } = makeApiIn(dataDir);
  terminateAfter(t, api, dataDir);
  await api._profileMigrationReady;
  const pid = (await call(api, 'POST', '/api/profiles', { body: { nickname: '边界', avatarId: 'scholar' } })).body.profile.id;
  const url = `/api/profiles/${pid}/avatar`;

  const cases = [
    ['缺 Content-Type', { raw: GOOD, hdrs: {} }, 415],
    ['Content-Type 是 image/jpeg', { raw: GOOD, hdrs: { 'content-type': 'image/jpeg' } }, 415],
    ['Content-Type 带参数（必须精确 image/png）', { raw: GOOD, hdrs: { 'content-type': 'image/png; charset=utf-8' } }, 415],
    ['空 body', { raw: Buffer.alloc(0), hdrs: PNG_HEADERS }, 400],
    ['非 PNG 字节', { raw: png.notPng(), hdrs: PNG_HEADERS }, 400],
    ['尺寸不符 256×256', { raw: png.makePng({ width: 256, height: 256 }), hdrs: PNG_HEADERS }, 400],
    ['色彩类型不支持（灰度）', { raw: png.makePng({ colorType: 0 }), hdrs: PNG_HEADERS }, 400],
    ['截断的 PNG', { raw: png.truncatePng(GOOD, 8), hdrs: PNG_HEADERS }, 400],
    ['超过 2 MiB', { raw: png.makePng({ extras: [{ type: 'tEXt', data: Buffer.alloc(MAX_AVATAR_BYTES + 4096) }] }), hdrs: PNG_HEADERS }, 413],
    ['X-Profile-Revision 不是整数', { raw: GOOD, hdrs: { ...PNG_HEADERS, 'x-profile-revision': 'abc' } }, 400],
    ['X-Profile-Revision 是小数', { raw: GOOD, hdrs: { ...PNG_HEADERS, 'x-profile-revision': '1.5' } }, 400],
  ];
  for (const [name, opts, expect] of cases) {
    const r = await call(api, 'PUT', url, { method: 'PUT', ...opts });
    assert.strictEqual(r.status, expect, `${name}：状态码应为 ${expect}（实际 ${r.status}，body=${r.text.slice(0, 120)}）`);
    assert.strictEqual(fs.existsSync(avatarPath(dataDir, pid)), false, `${name}：被拒的请求不得落盘`);
  }
  // 边界之内：恰好 2MiB 以下的小图可以（GOOD 本身）
  assert.strictEqual((await call(api, 'PUT', url, { method: 'PUT', raw: GOOD, hdrs: PNG_HEADERS })).status, 200);
});

test('M1 §4.3 未授权 / 错 Origin / 限流：沿用既有管理会话与限流规则', async (t) => {
  const dataDir = makeDataDir('av-api-auth');
  const { api } = makeApiIn(dataDir);
  terminateAfter(t, api, dataDir);
  await api._profileMigrationReady;
  const pid = (await call(api, 'POST', '/api/profiles', { body: { nickname: '门禁', avatarId: 'scholar' } })).body.profile.id;
  await call(api, 'PUT', `/api/profiles/${pid}/avatar`, { method: 'PUT', raw: GOOD, hdrs: PNG_HEADERS });
  const url = `/api/profiles/${pid}/avatar`;

  // 错 Origin（浏览器 CSRF 形状）：写操作必须被拒（既有约定：与 mgmt 失败同一个 401 出口）
  const badOrigin = await call(api, 'PUT', url, { method: 'PUT', raw: OTHER, hdrs: { ...PNG_HEADERS, origin: 'http://evil.example' } });
  assert.strictEqual(badOrigin.status, 401, '错 Origin 的写操作必须被拒');
  assert.strictEqual((await call(api, 'DELETE', url, { method: 'DELETE', hdrs: { origin: 'http://evil.example' } })).status, 401);
  assert.ok(fs.readFileSync(avatarPath(dataDir, pid)).equals(GOOD), '被拒的写操作不得改变磁盘');

  // 开启管理会话门禁（LAN 模式）：远端未配对 → 三接口全部 401
  api.auth.setEnabled(true);
  const remote = { remote: '10.0.0.9' };
  assert.strictEqual((await call(api, 'GET', `${url}?v=x`, remote)).status, 401, 'GET 只服务本机管理会话');
  assert.strictEqual((await call(api, 'PUT', url, { method: 'PUT', raw: OTHER, hdrs: PNG_HEADERS, ...remote })).status, 401);
  assert.strictEqual((await call(api, 'DELETE', url, { method: 'DELETE', ...remote })).status, 401);
  api.auth.setEnabled(false);

  // 限流：本机回环不限（上方已多次 200），远端按桶计数 → 第 21 次 429
  let last = 0;
  for (let i = 0; i < 21; i++) {
    last = (await call(api, 'PUT', url, { method: 'PUT', raw: GOOD, hdrs: PNG_HEADERS, ...remote })).status;
  }
  assert.strictEqual(last, 429, '远端第 21 次头像写操作必须被限流');
  assert.strictEqual((await call(api, 'PUT', url, { method: 'PUT', raw: OTHER, hdrs: PNG_HEADERS })).status, 200, '本机回环不受限流影响（既有约定）');
});

test('M1 §4.1/§4.3 DELETE：回退到 avatarId（不回退成破图），旧 URL 明确 404 且不返回 HTML', async (t) => {
  const dataDir = makeDataDir('av-api-del');
  const { api } = makeApiIn(dataDir);
  terminateAfter(t, api, dataDir);
  await api._profileMigrationReady;
  const pid = (await call(api, 'POST', '/api/profiles', { body: { nickname: '回退', avatarId: 'mask' } })).body.profile.id;
  const url = `/api/profiles/${pid}/avatar`;
  const put = await call(api, 'PUT', url, { method: 'PUT', raw: GOOD, hdrs: PNG_HEADERS });
  const oldUrl = put.body.avatarUrl;

  // 路由分离：`/avatar` 之外的子路径不能被当成头像操作（DELETE 仍走"归档后删除"的既有语义）
  assert.strictEqual((await call(api, 'DELETE', `/api/profiles/${pid}/stats`, { method: 'DELETE' })).status, 409, '未归档档案的 DELETE 仍走既有 409 语义');
  const del = await call(api, 'DELETE', url, { method: 'DELETE', hdrs: { 'x-profile-revision': String(put.body.profile.revision) } });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(del.body.avatarUrl, null, '删除后 avatarUrl 必须为 null ⇒ 前端显示内置头像');
  assert.strictEqual(del.body.profile.avatarId, 'mask', '内置头像回落值必须保留');
  assert.ok(!('customAvatar' in del.body.profile));
  assert.strictEqual(fs.existsSync(avatarPath(dataDir, pid)), false);

  const gone = await call(api, 'GET', oldUrl);
  assert.strictEqual(gone.status, 404, '旧 URL 必须明确 404');
  assert.match(gone.headers['content-type'], /application\/json/, '错误必须是 JSON，不得返回 HTML 冒充图片');
  assert.ok(!/^\s*</.test(gone.text), '错误响应不得是 HTML');
  assert.match(gone.body.error, /头像/, '错误信息必须说明是头像问题');

  const list = await call(api, 'GET', '/api/profiles');
  const row = list.body.profiles.find((x) => x.id === pid);
  assert.strictEqual(row.avatarUrl, null);
  assert.strictEqual(row.customAvatar, null);
  assert.strictEqual(row.avatarId, 'mask');
});

test('M1 §4.3 GET 明确语义：无头像 404、文件被替换 500、损坏 500 —— 全部 JSON，绝不 HTML', async (t) => {
  const dataDir = makeDataDir('av-api-get');
  const { api } = makeApiIn(dataDir);
  terminateAfter(t, api, dataDir);
  await api._profileMigrationReady;
  const pid = (await call(api, 'POST', '/api/profiles', { body: { nickname: '错误语义', avatarId: 'scholar' } })).body.profile.id;
  const url = `/api/profiles/${pid}/avatar`;

  const none = await call(api, 'GET', url);
  assert.strictEqual(none.status, 404);
  assert.match(none.headers['content-type'], /application\/json/);

  await call(api, 'PUT', url, { method: 'PUT', raw: GOOD, hdrs: PNG_HEADERS });
  fs.writeFileSync(avatarPath(dataDir, pid), OTHER); // 合法图但与元数据不一致
  const mismatch = await call(api, 'GET', url);
  assert.strictEqual(mismatch.status, 500);
  assert.match(mismatch.body.error, /不一致|头像/);
  assert.ok(!/^\s*</.test(mismatch.text));

  fs.writeFileSync(avatarPath(dataDir, pid), png.corruptByte(GOOD));
  const corrupt = await call(api, 'GET', url);
  assert.strictEqual(corrupt.status, 500);
  assert.match(corrupt.body.error, /损坏/);

  fs.rmSync(avatarPath(dataDir, pid));
  const missing = await call(api, 'GET', url);
  assert.strictEqual(missing.status, 404);
  assert.match(missing.body.error, /缺失/);

  const unknown = await call(api, 'GET', `/api/profiles/${crypto.randomUUID()}/avatar`);
  assert.strictEqual(unknown.status, 404);
  assert.match(unknown.headers['content-type'], /application\/json/);
});

test('M1 §4.2 归档/回收站/恢复后头像仍可出图（API 级）', async (t) => {
  const dataDir = makeDataDir('av-api-trash');
  const { api } = makeApiIn(dataDir);
  terminateAfter(t, api, dataDir);
  await api._profileMigrationReady;
  const pid = (await call(api, 'POST', '/api/profiles', { body: { nickname: '归档带图', avatarId: 'scholar' } })).body.profile.id;
  const sha = sha256Hex(GOOD);
  await call(api, 'PUT', `/api/profiles/${pid}/avatar`, { method: 'PUT', raw: GOOD, hdrs: PNG_HEADERS });

  const arch = await call(api, 'PATCH', `/api/profiles/${pid}`, { method: 'PATCH', body: { archive: true } });
  assert.strictEqual(arch.status, 200);
  const archived = await call(api, 'GET', `/api/profiles/${pid}/avatar?v=${sha}`);
  assert.strictEqual(archived.status, 200, '归档后头像文件随目录保留，仍可出图');
  assert.ok(archived.bytes.equals(GOOD));

  const del = await call(api, 'DELETE', `/api/profiles/${pid}`);
  assert.strictEqual(del.status, 200);
  const archiveId = del.body.archiveId;
  const restore = await call(api, 'POST', `/api/profiles/trash/${encodeURIComponent(archiveId)}/restore`);
  assert.strictEqual(restore.status, 200);
  assert.strictEqual(restore.body.profile.customAvatar.sha256, sha, '恢复摘要必须带回头像元数据');
  assert.strictEqual(restore.body.profile.avatarUrl, `/api/profiles/${pid}/avatar?v=${sha}`);
  const after = await call(api, 'GET', `/api/profiles/${pid}/avatar?v=${sha}`);
  assert.strictEqual(after.status, 200);
  assert.ok(after.bytes.equals(GOOD), '恢复后出图字节一致');
});
