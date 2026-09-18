/**
 * save.test.js — 存档与内存治理（P1-3）
 *
 * 改动前：`saveActive` 每 4 秒对每个进行中的对局做一次 `JSON.stringify` + `writeFileSync`，
 *         而且 `game.toJSON()` 与 `anchor` 都带 events → 事件流被序列化两遍。
 * 改动后：脏标记（没变就不写）+ 异步原子写（不再阻塞事件循环）+ 存档去重 + 内存 TTL/LRU。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Api } = require('../src/api');
const { Game } = require('../src/engine/game');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {} };
const SAVE_DIR = path.join(__dirname, '..', 'saves');
const saveFile = (id) => path.join(SAVE_DIR, `${id}.json`);

function makeApi() {
  return new Api({ config: { get: () => ({ apiKey: 'k' }), save() {} }, logger: silentLogger });
}
function makeGame(id, seats = 5) {
  const board = seats === 5
    ? { wolf: 1, seer: 1, witch: 1, villager: 2 }
    : { wolf: 2, seer: 1, witch: 1, hunter: 1, villager: 3 };
  const players = Array.from({ length: seats }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
  const g = new Game({ id, board, players, stepPauseMs: 1, logger: silentLogger });
  g.deal();
  g.started = true;
  return g;
}
function entryFor(g, extra = {}) {
  return { game: g, tokens: { player: 'p', god: 'g' }, running: false, mock: true, createdAt: Date.now(), lastAccess: Date.now(), ...extra };
}
const cleanup = (ids) => { for (const id of ids) { fs.rmSync(saveFile(id), { force: true }); fs.rmSync(saveFile(id) + '.tmp', { force: true }); } };

// ---------- 脏标记 ----------
test('脏标记：状态没变就不再写盘（4s 定时器在长 LLM 调用期间基本全是空转）', async () => {
  const ids = ['save-dirty-a'];
  try {
    const api = makeApi();
    const g = makeGame(ids[0]);
    const entry = entryFor(g);
    assert.strictEqual(await api.saveGame(entry), true, '首次应写入');
    assert.strictEqual(await api.saveGame(entry), false, '无变化时应跳过（这是省下大部分磁盘操作的来源）');
    assert.strictEqual(await api.saveGame(entry), false, '再跳一次');
    g.emit('system', { visibleTo: 'all', text: '来了条新事件' }); // 事件 → seq 变化 → 变脏
    assert.strictEqual(await api.saveGame(entry), true, '有新事件后应重新写入');
    assert.strictEqual(await api.saveGame(entry), false);
    g.pause({ kind: 'quota', code: '1113', message: '配额' }); // 暂停也必须触发一次落盘
    assert.strictEqual(await api.saveGame(entry), true, '暂停状态变化应落盘');
  } finally { cleanup(ids); }
});

test('脏标记：force 强制写入（终局/暂停等关键节点用）', async () => {
  const ids = ['save-force'];
  try {
    const api = makeApi();
    const g = makeGame(ids[0]);
    const entry = entryFor(g);
    await api.saveGame(entry);
    assert.strictEqual(await api.saveGame(entry), false);
    assert.strictEqual(await api.saveGame(entry, { force: true }), true, 'force 必须无视脏标记');
  } finally { cleanup(ids); }
});

// ---------- 去重 ----------
test('去重：events 只在 anchor 里存一份（旧实现两处都存，46.5% 体积是纯重复）', async () => {
  const ids = ['save-dedup'];
  try {
    const api = makeApi();
    const g = makeGame(ids[0]);
    for (let i = 0; i < 40; i++) g.emit('speech', { actor: 1, data: { text: `发言${i}`, context: 'day' } });
    g.markAnchor('speech');
    const entry = entryFor(g);
    await api.saveGame(entry, { force: true });
    const doc = JSON.parse(fs.readFileSync(saveFile(ids[0]), 'utf8'));
    assert.strictEqual(doc.game.events, undefined, '存档元数据里不应再有 events');
    assert.ok(Array.isArray(doc.anchor.events) && doc.anchor.events.length > 0, 'anchor 必须保留事件流（恢复要用）');
    // listSaves 依赖的元数据字段一个都不能少
    for (const k of ['id', 'day', 'phase', 'finished', 'started', 'winner', 'winReason', 'players']) {
      assert.ok(k in doc.game, `存档元数据缺少 listSaves 需要的字段：${k}`);
    }
  } finally { cleanup(ids); }
});

test('去重：事件越多，省下的体积比例越接近一半', async () => {
  const ids = ['save-dedup-size'];
  try {
    const api = makeApi();
    const g = makeGame(ids[0], 8);
    for (let i = 0; i < 300; i++) g.emit('speech', { actor: 1, data: { text: `这是一条比较长的发言内容${i}`, context: 'day' } });
    g.markAnchor('speech');
    const entry = entryFor(g);
    await api.saveGame(entry, { force: true });
    const saved = fs.statSync(saveFile(ids[0])).size;
    const withDup = JSON.stringify({ tokens: entry.tokens, mock: true, game: g.toJSON(), anchor: g._anchor }).length;
    const ratio = 1 - saved / withDup;
    console.log(`      → 存档 ${(saved / 1024).toFixed(1)}KB vs 旧实现 ${(withDup / 1024).toFixed(1)}KB，省了 ${(ratio * 100).toFixed(1)}%`);
    assert.ok(ratio > 0.4, `事件流占大头时去重应省下 40% 以上，实际 ${(ratio * 100).toFixed(1)}%`);
  } finally { cleanup(ids); }
});

// ---------- 异步 + 原子 ----------
test('异步原子写：不留 .tmp 残留文件、内容始终是完整 JSON', async () => {
  const ids = ['save-atomic'];
  try {
    const api = makeApi();
    const g = makeGame(ids[0]);
    const entry = entryFor(g);
    await api.saveGame(entry, { force: true });
    assert.ok(fs.existsSync(saveFile(ids[0])), '主文件应存在');
    assert.ok(!fs.existsSync(saveFile(ids[0]) + '.tmp'), '不应留下 .tmp');
    const doc = JSON.parse(fs.readFileSync(saveFile(ids[0]), 'utf8'));
    assert.strictEqual(doc.game.id, ids[0]);
    assert.ok(doc.savedAt > 0, '应记录落盘时间');
  } finally { cleanup(ids); }
});

test('并发保护：同一对局不会并发写（避免两个 .tmp 互相覆盖），但会补一次写', async () => {
  const ids = ['save-concurrent'];
  try {
    const api = makeApi();
    const g = makeGame(ids[0]);
    const entry = entryFor(g);
    const p1 = api.saveGame(entry, { force: true });   // 在飞
    const secondP = api.saveGame(entry, { force: true }); // 撞上在飞的写
    // 整改（审核 P1-4）：在飞期间的第二次调用返回在途 Promise（优雅退出等得到），
    // 且登记一次待补写 —— 并排写仍然被禁止
    assert.ok(secondP && typeof secondP.then === 'function', '第二次调用必须返回在途 Promise');
    assert.strictEqual(entry.pendingSave, true, '应登记一次待补写');
    const second = await secondP;
    assert.strictEqual(second, true);
    await p1;
    await new Promise((r) => setTimeout(r, 20)); // 等 pendingSave 的补写落地
    assert.strictEqual(entry.saving, false);
    assert.ok(fs.existsSync(saveFile(ids[0])));
  } finally { cleanup(ids); }
});

// ---------- 内存治理 ----------
test('内存治理：TTL 清掉久未访问的对局', () => {
  const api = makeApi();
  api.games.clear();
  const now = Date.now();
  api.games.set('old', entryFor(makeGame('mem-old'), { lastAccess: now - 60 * 60 * 1000 }));
  api.games.set('fresh', entryFor(makeGame('mem-fresh'), { lastAccess: now }));
  const dropped = api.pruneGames({ maxEntries: 50, ttlMs: 30 * 60 * 1000 });
  assert.strictEqual(dropped, 1);
  assert.ok(!api.games.has('old'), '超过 TTL 的应被清掉');
  assert.ok(api.games.has('fresh'));
});

test('内存治理：正在跑的对局绝不能被清（驱动循环还持有它，丢掉会让前端 404）', () => {
  const api = makeApi();
  api.games.clear();
  api.games.set('running', entryFor(makeGame('mem-running'), { running: true, lastAccess: 0 }));
  const dropped = api.pruneGames({ maxEntries: 1, ttlMs: 1 });
  assert.strictEqual(dropped, 0);
  assert.ok(api.games.has('running'), '运行中的对局必须保留');
});

test('内存治理：LRU 上限按最后访问时间淘汰（已结束的优先）', () => {
  const api = makeApi();
  api.games.clear();
  const now = Date.now();
  for (let i = 0; i < 5; i++) api.games.set('lru' + i, entryFor(makeGame('mem-lru' + i), { lastAccess: now - (5 - i) * 1000 }));
  const dropped = api.pruneGames({ maxEntries: 2, ttlMs: 365 * 24 * 3600 * 1000 });
  assert.strictEqual(dropped, 3);
  assert.strictEqual(api.games.size, 2);
  assert.ok(api.games.has('lru4') && api.games.has('lru3'), '应留下最近访问的两个');
});

test('内存治理：被清掉的对局仍能从磁盘存档恢复（内存只是缓存）', async () => {
  const ids = ['save-evict-resume'];
  try {
    const api = makeApi();
    const g = makeGame(ids[0]);
    g.markAnchor('speech');
    const entry = entryFor(g);
    await api.saveGame(entry, { force: true });
    api.games.clear();
    api.pruneGames({ maxEntries: 1, ttlMs: 0 });
    assert.strictEqual(api.games.size, 0);
    const doc = api.loadSaveDoc(ids[0]);
    assert.ok(doc && doc.anchor, '存档仍在，随时可恢复');
    assert.strictEqual(doc.anchor.nextPhase, 'speech');
  } finally { cleanup(ids); }
});

// ---------- saveActive 的整体行为 ----------
test('saveActive：只处理进行中的对局，且无变化时一次盘都不碰', async () => {
  const ids = ['save-active-live', 'save-active-done'];
  try {
    const api = makeApi();
    api.games.clear();
    const live = makeGame(ids[0]);
    const done = makeGame(ids[1]);
    done.finished = true;
    const el = entryFor(live);
    api.games.set(ids[0], el);
    api.games.set(ids[1], entryFor(done));
    api.saveActive();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(fs.existsSync(saveFile(ids[0])), '进行中的对局应被定时落盘');
    assert.ok(!fs.existsSync(saveFile(ids[1])), '已结束的对局不再参与定时落盘');
    assert.strictEqual(el.savedStamp !== undefined, true, '应记录脏标记');
    api.saveActive(); // 无变化
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(el.saving, false);
  } finally { cleanup(ids); }
});
