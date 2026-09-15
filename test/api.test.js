/**
 * api.test.js — API 响应的字段语义契约（P1-5 由 ESLint 的 no-dupe-keys 牵出）
 *
 * 真实事故：`/view` 的响应对象里 `live` 被写了两次——
 *   ① `live: this.games.has(id)`（布尔：对局是否还在内存里，前端据此显示"继续对局"）
 *   ② `live: game.liveFor(viewer)`（对象：流式直播缓冲，空闲时为 null）
 * 后者静默覆盖前者。于是"AI 没在打字"时 `/view` 返回 `live: null`，
 * 前端把它当成"不可恢复"，紧接着 `localStorage.removeItem` **删掉用户令牌 → 丢档**。
 *
 * 修复方式是两个语义分开命名：`live` 只表示流式缓冲，布尔一律叫 `inMemory`。
 * 本文件把这两个字段的语义钉死，防止再次被合并或覆盖。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Api } = require('../src/api');
const { Game } = require('../src/engine/game');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {} };

function capture() {
  const box = {};
  box.res = { writeHead(code) { box.code = code; }, end(b) { box.body = JSON.parse(b); } };
  return box;
}

function makeGame(id) {
  const board = { wolf: 1, seer: 1, witch: 1, villager: 2 };
  const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
  const g = new Game({ id, board, players, stepPauseMs: 1, logger: silentLogger });
  g.deal();
  g.started = true;
  return g;
}

const makeApi = () => new Api({ config: { get: () => ({ apiKey: 'k', journal: false }), save() {} }, logger: silentLogger });

test('/view：inMemory 是布尔、live 是流式缓冲，两者不得混用（曾发生静默覆盖导致丢档）', () => {
  const api = makeApi();
  const g = makeGame('api-view-contract');
  const entry = { game: g, running: false, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now() };
  api.games.set(g.id, entry);

  // ① 空闲态：没有 AI 在流式输出（用上帝令牌，避免依赖人类玩家座位）
  const idle = capture();
  api.view(idle.res, entry, new URLSearchParams('token=gt&after=0'));
  assert.strictEqual(idle.code, 200);
  assert.strictEqual(idle.body.live, null, '空闲时 live 必须是 null（它只表示"正在流式输出的内容"）');
  assert.strictEqual(idle.body.inMemory, true, 'inMemory 必须独立存在且为 true —— 前端靠它判断"能否继续对局"');
  assert.strictEqual(typeof idle.body.inMemory, 'boolean');

  // ② 流式态：live 是对象，inMemory 仍然是布尔 true（不能被覆盖）
  g.beginLive({ seat: 1, task: 'speech', public: true });
  g.live.text = '我正在说话';
  const streaming = capture();
  api.view(streaming.res, entry, new URLSearchParams('token=gt&after=0'));
  assert.ok(streaming.body.live && typeof streaming.body.live === 'object', '流式时 live 应是缓冲对象');
  assert.strictEqual(streaming.body.live.text, '我正在说话');
  assert.strictEqual(streaming.body.inMemory, true, 'inMemory 不得被 live 覆盖');
  g.endLive();

  // ③ 对局不在内存时：inMemory 必须为 false（前端据此走"从存档找回令牌"分支）
  api.games.delete(g.id);
  const gone = capture();
  api.view(gone.res, entry, new URLSearchParams('token=gt&after=0'));
  assert.strictEqual(gone.body.inMemory, false);
});

test('/api/games 列表：用 inMemory 而不是 live 表示"是否还在内存"（同一含义全链路同名）', async () => {
  const fs = require('fs');
  const path = require('path');
  const api = makeApi();
  const g = makeGame('api-list-contract');
  const entry = { game: g, running: false, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now() };
  api.games.set(g.id, entry);
  const file = path.join(__dirname, '..', 'saves', `${g.id}.json`);
  try {
    await api.saveGame(entry, { force: true }); // listSaves 读的是磁盘上的存档
    const box = capture();
    api.listSaves(box.res);
    const row = box.body.rows.find((r) => r.id === g.id);
    assert.ok(row, '应出现在存档列表里');
    assert.strictEqual(row.inMemory, true, '列表项必须用 inMemory 表示"在内存中"');
    assert.strictEqual(row.live, undefined, '列表项不应再有 live 字段（避免与流式缓冲同名歧义）');
    assert.strictEqual(typeof row.resumable, 'boolean', 'resumable 由服务端算好，前端不该自己拼');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

/**
 * 设置项接口的契约：**读得到的必须写得进，写进去的必须读得回**。
 *
 * 真实事故：GET /api/config 曾经只返回一份手工维护的 11 字段白名单，漏掉了 keepAlive。
 * 于是设置页把 `cfg.keepAlive` 读成 undefined → `!== false` 恒为真 → 复选框永远显示"已勾选"；
 * 用户取消勾选后再改别的设置保存，前端把复选框的值一起提交，**静默把 keepAlive 改回 true**。
 * 这类"只能写、读不回来"的字段，根因是白名单要和 DEFAULT_CONFIG、前端提交字段三处手工同步。
 * 现在改成从 DEFAULT_CONFIG 派生，本用例负责防止再次漂移。
 */
test('/api/config：GET 必须能读回全部配置项（除密钥），PUT 的值必须能原样读回', async () => {
  const { DEFAULT_CONFIG } = require('../src/config');
  const data = { ...DEFAULT_CONFIG, apiKey: 'sk-secret-value' };
  const api = new Api({
    config: { get: () => data, save(partial) { Object.assign(data, partial); return data; } },
    logger: silentLogger,
  });

  // ① GET：DEFAULT_CONFIG 的每个键都必须出现（apiKey 例外，只能出掩码）
  const get = capture();
  await api.handle({ method: 'GET', headers: {} }, get.res, '/api/config', new URLSearchParams());
  assert.strictEqual(get.code, 200);
  const missing = Object.keys(DEFAULT_CONFIG).filter((k) => k !== 'apiKey' && !(k in get.body));
  assert.deepStrictEqual(missing, [], `GET /api/config 漏了这些配置项（前端会读成 undefined）：${missing.join(', ')}`);
  assert.strictEqual(get.body.apiKey, undefined, '密钥绝不能下发');
  assert.ok(get.body.apiKeyMasked && get.body.apiKeyMasked.includes('****'), '密钥应给掩码');
  assert.strictEqual(get.body.hasKey, true);

  // ② PUT → GET：布尔开关必须能读回真值（这是 keepAlive 复选框谎报的根因）
  //    假请求要实现 readBody 依赖的事件协议（data/end），否则请求体永远等不到
  const fakeReq = (method, body) => {
    const handlers = {};
    const req = {
      method, headers: {},
      on(ev, fn) { handlers[ev] = fn; return req; },
      destroy() {},
    };
    if (body !== undefined) {
      setImmediate(() => {
        handlers.data(Buffer.from(JSON.stringify(body)));
        handlers.end();
      });
    }
    return req;
  };
  for (const [key, value] of [['keepAlive', false], ['journal', false], ['effortPolicy', 'flat'], ['digestMinEvents', 99]]) {
    const put = capture();
    await api.handle(fakeReq('PUT', { [key]: value }), put.res, '/api/config', new URLSearchParams());
    assert.strictEqual(put.code, 200);
    const again = capture();
    await api.handle(fakeReq('GET'), again.res, '/api/config', new URLSearchParams());
    assert.strictEqual(again.body[key], value, `${key} 写入 ${JSON.stringify(value)} 后必须能读回同一个值`);
  }
});

