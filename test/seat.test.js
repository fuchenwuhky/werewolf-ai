/**
 * seat.test.js — 人类座位：随机抽签 + 可自定义（含"记住选择"的前端契约）
 *
 * 起因（用户反馈）："老是 1 号座位玩的也不舒服"。原来默认写死 1 号：
 * 发言顺序固定、首夜被刀/被查的体感失衡，而且 1 号在很多板子里就是"第一个发言"的位置。
 *
 * 现在默认 `mySeat:'random'`，由**服务端**抽签（手机端 / 桌面端 / 直连 API 三条路径行为一致），
 * 也可以明确指定号数。这里把几条容易悄悄坏掉的语义钉住：
 *   · 随机后**恰好**有 1 名人类，且座位号与响应里回传的一致（前端靠它提示"你在几号"）；
 *   · 人类座位不得被分配 AI 人格（否则人类会被注入一段 AI 人设）；
 *   · 随机必须真的分散（不能因为实现写错变成"每次都 1 号"）；
 *   · 显式座位与纯观战（0 名人类）行为不得改变；
 *   · `mySeat:'random'` 与 players 里 isHuman 冲突时必须明确报错（不能猜）；
 *   · 显式 seed 时座位也要可复现（与"同种子 = 同一局"一致）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ⚠ 必须在 require('../src/api') 之前设置：SAVE_DIR 是 api.js 的模块级常量（见 mock-flag.test.js 的说明）
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-seat-'));
process.env.WW_DATA_DIR = TMP_DATA;
process.on('exit', () => { try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (_) { /* ignore */ } });

const { Api } = require('../src/api');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {} };

function capture() {
  const box = {};
  box.res = { writeHead(code) { box.code = code; }, end(b) { box.body = JSON.parse(b); } };
  return box;
}

const fakeReq = (method, body) => {
  const handlers = {};
  const req = { method, headers: {}, on(ev, fn) { handlers[ev] = fn; return req; }, destroy() {} };
  if (body !== undefined) setImmediate(() => { handlers.data(Buffer.from(JSON.stringify(body))); handlers.end(); });
  return req;
};

const makeApi = () => new Api({
  config: { get: () => ({ apiKey: 'sk-fake', baseUrl: 'http://127.0.0.1:9/v1', model: 'm', journal: false }), save() {} },
  logger: silentLogger,
  // NEW-17：显式传 saveDir（= 本文件独占 TMP_DATA/saves），不再依赖 WW_DATA_DIR 的加载顺序前提
  saveDir: path.join(TMP_DATA, 'saves'),
});

const board = (total = 12) => Array.from({ length: total }, (_, k) => ({ name: `P${k + 1}`, isHuman: false, personality: '' }));

/** 建一局，返回 { code, body, entry, human } */
async function create(api, extra = {}) {
  const res = capture();
  await api.handle(fakeReq('POST', { boardId: 'adv12', mock: true, players: board(), ...extra }), res.res, '/api/games', new URLSearchParams());
  const entry = res.body && res.body.gameId ? api.games.get(res.body.gameId) : null;
  const human = entry ? entry.game.players.find((p) => p.isHuman) : null;
  return { code: res.code, body: res.body, entry, human };
}

test('随机座位：恰好 1 名人类，座位/昵称与响应回传一致（前端靠 mySeat 提示"你在几号"）', async () => {
  const api = makeApi();
  const r = await create(api, { mySeat: 'random', myName: '随机我' });
  assert.strictEqual(r.code, 200);
  assert.ok(Number.isInteger(r.body.mySeat) && r.body.mySeat >= 1 && r.body.mySeat <= 12, `mySeat 必须是 1..12，实际 ${r.body.mySeat}`);
  const humans = r.entry.game.players.filter((p) => p.isHuman);
  assert.strictEqual(humans.length, 1, '必须恰好 1 名人类');
  assert.strictEqual(humans[0].seat, r.body.mySeat, '响应里的 mySeat 必须就是人类实际座位');
  assert.strictEqual(humans[0].name, '随机我', '人类昵称要跟着座位一起搬过去');
  assert.ok(r.body.playerToken, '随机座位也必须发玩家令牌（否则人类无法行动）');
});

test('随机座位：人类不得被分配 AI 人格', async () => {
  const api = makeApi();
  const r = await create(api, { mySeat: 'random', myName: '我' });
  assert.strictEqual(r.human.personality, '', '人类座位不能带人格提示词（否则会被注入一段 AI 人设）');
  assert.strictEqual(r.human.personaName, '', '人类座位不能有 AI 人格名');
  // 其余座位要正常分到人格
  const ai = r.entry.game.players.filter((p) => !p.isHuman);
  assert.ok(ai.every((p) => p.personaName), 'AI 座位都应分到人格');
});

test('随机座位：必须真的分散（写错成固定 1 号会在这里暴露）', async () => {
  const api = makeApi();
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    const r = await create(api, { mySeat: 'random', myName: '我' });
    assert.strictEqual(r.code, 200);
    seen.add(r.body.mySeat);
  }
  // 30 次抽签落在 12 个座位里，全同的概率约 12^-29 —— 不可能是偶然
  assert.ok(seen.size >= 5, `30 局应覆盖多个座位，实际只出现 ${[...seen].join(',')}`);
  for (const s of seen) assert.ok(s >= 1 && s <= 12, `座位越界：${s}`);
});

test('显式座位：行为不变，且响应回传同样的号数', async () => {
  const api = makeApi();
  const players = board();
  players[4].isHuman = true;        // 5 号
  players[4].name = '显式五号';
  const res = capture();
  await api.handle(fakeReq('POST', { boardId: 'adv12', mock: true, players }), res.res, '/api/games', new URLSearchParams());
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.mySeat, 5, '没传 mySeat 时按 players 里的 isHuman 回传座位');
  const human = api.games.get(res.body.gameId).game.players.find((p) => p.isHuman);
  assert.strictEqual(human.seat, 5);
  assert.strictEqual(human.name, '显式五号');
});

test('纯观战：0 名人类 → mySeat 为 0，且不发玩家令牌（既有行为不得被改动）', async () => {
  const api = makeApi();
  const r = await create(api);
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.mySeat, 0, '观战局没有人类座位');
  assert.strictEqual(r.body.playerToken, null, '观战局不应发玩家令牌');
  assert.strictEqual(r.entry.game.players.filter((p) => p.isHuman).length, 0);
});

test('冲突配置必须明确报错：mySeat:"random" 与 players 里的 isHuman 不能同时给', async () => {
  const api = makeApi();
  const players = board();
  players[2].isHuman = true;
  const r = await create(api, { mySeat: 'random', players });
  assert.strictEqual(r.code, 400);
  assert.match(r.body.error, /random/, '错误信息要说明冲突点，而不是随便失败');
});

test('显式 seed：随机座位也可复现（同种子 = 同一局，含座位）', async () => {
  const a = await create(makeApi(), { mySeat: 'random', myName: '我', seed: 12345 });
  const b = await create(makeApi(), { mySeat: 'random', myName: '我', seed: 12345 });
  const c = await create(makeApi(), { mySeat: 'random', myName: '我', seed: 999 });
  assert.strictEqual(a.body.mySeat, b.body.mySeat, '同种子的随机座位必须一致（座位的随机源与人格分配共用 seedRng）');
  assert.ok(c.body.mySeat >= 1 && c.body.mySeat <= 12);
});

test('前端契约：两个界面都默认"随机"并能记住选择', () => {
  const root = path.join(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
  const mjs = fs.readFileSync(path.join(root, 'web', 'm', 'm.js'), 'utf8');
  assert.match(app, /mySeat: 'random'/, '桌面版默认座位必须是随机');
  assert.match(app, /🎲 随机/, '桌面版下拉要有"随机"选项');
  assert.match(mjs, /🎲 随机/, '手机版下拉要有"随机"选项');
  for (const [name, src] of [['app.js', app], ['m.js', mjs]]) {
    assert.match(src, /ww_seat/, `${name} 必须记住座位选择（否则每次回来又变回默认）`);
    assert.match(src, /mySeat = 'random'/, `${name} 选中随机时要把 'random' 传给服务端`);
  }
  // 共用同一个 localStorage 键：桌面端选好的座位，手机端打开时应一致
  assert.match(app, /'ww_seat'/, 'app.js 用 ww_seat');
  assert.match(mjs, /'ww_seat'/, 'm.js 用同一个 ww_seat');
});
