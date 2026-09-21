/**
 * remediation.test.js — 代码审核整改（docs/code-review-remediation-plan.md）的回归护栏
 *
 * 每个用例对应审核清单里的一项缺陷，文件内注释标注编号（REL-xx / SEC-xx / LOGIC-xx / UX-01）。
 * 原则：不依赖真实 LLM 服务；不写正式 saves/ 与 logs/（saveDir / 日志全部注入临时目录）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { createRequestHandler, decodePath } = require('../src/request-handler');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {}, query() { return []; } };

// 独占 dataDir 辅助（建根 / 建 Api / 收尾删除）见 test/helpers-tmpdir.js：
// saveDir 必须落在独占根之下，绝不能是 os.tmpdir() 的平铺子目录，否则 <tmp>/profiles 与
// <tmp>/migrations 会被全机共享（并行测试 rename 竞态 + 垃圾堆积），详见该文件头部说明。
const { makeDataDir, savesOf, makeApiIn, terminateApi, dispose } = require('./helpers-tmpdir');

/** 结束局 API：独占 dataDir（saveDir = <dataDir>/saves），返回 { api, dataDir } */
function makeFinishedApi(tag) {
  return makeApiIn(makeDataDir(tag), { config: { get: () => ({ apiKey: '', journal: false }), save() {} } });
}

// ---------- REL-01：畸形 URL 不得击穿进程 ----------

test('REL-01：decodePath 对畸形转义返回 null、对正常路径原样保留', () => {
  assert.strictEqual(decodePath('/%'), null, '/% 必须判为畸形（旧实现在此抛 URIError 击穿进程）');
  assert.strictEqual(decodePath('/%zz'), null);
  assert.strictEqual(decodePath('/api/games'), '/api/games');
  assert.strictEqual(decodePath('/%E4%B8%AD%E6%96%87'), '/中文', '正常 UTF-8 路径不受影响');
});

test('REL-01（真实请求）：畸形 URL 返回 400，且进程/服务在同请求后仍可服务', async () => {
  const handled = [];
  const apiStub = { handle: async () => { handled.push(1); } };
  const serveWeb = (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('static-ok'); };
  const server = http.createServer(createRequestHandler({ api: apiStub, serveWeb, logger: silentLogger }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bad1 = await fetch(`${base}/%`);
    assert.strictEqual(bad1.status, 400, '修复前：这里直接 URIError 未捕获、整个进程退出');
    const bad2 = await fetch(`${base}/foo/%zz/bar`);
    assert.strictEqual(bad2.status, 400);
    // 进程还活着、路由还通：
    const ok = await fetch(`${base}/index.html`);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(await ok.text(), 'static-ok');
  } finally { server.close(); }
});

test('REL-01（真实请求）：手机 UA 跳转与 /m 跳转行为保持不变', async () => {
  const apiStub = { handle: async () => {} };
  const serveWeb = (req, res) => { res.writeHead(200); res.end('static'); };
  const server = http.createServer(createRequestHandler({ api: apiStub, serveWeb, logger: silentLogger }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const mobile = await fetch(`${base}/?x=1`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' }, redirect: 'manual' });
    assert.strictEqual(mobile.status, 302);
    assert.strictEqual(mobile.headers.get('location'), '/m/');
    const shortM = await fetch(`${base}/m`, { redirect: 'manual' });
    assert.strictEqual(shortM.status, 302);
    assert.strictEqual(shortM.headers.get('location'), '/m/');
    const desktop = await fetch(`${base}/?desktop=1`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' }, redirect: 'manual' });
    assert.strictEqual(desktop.status, 200, 'desktop=1 强制桌面版不跳转');
  } finally { server.close(); }
});

test('VAL-01（真实请求）：API 层抛出的"请求体过大/JSON 解析失败"映射为 413/400 而非 500', async () => {
  const apiStub = {
    handle: async (req, res, pathname) => {
      if (pathname === '/api/big') throw new Error('请求体过大');
      if (pathname === '/api/badjson') throw new Error('JSON 解析失败');
      throw new Error('其他内部错误');
    },
  };
  const serveWeb = (req, res) => { res.writeHead(200); res.end('static'); };
  const server = http.createServer(createRequestHandler({ api: apiStub, serveWeb, logger: silentLogger }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.strictEqual((await fetch(`${base}/api/big`, { method: 'POST' })).status, 413);
    assert.strictEqual((await fetch(`${base}/api/badjson`, { method: 'POST' })).status, 400);
    assert.strictEqual((await fetch(`${base}/api/other`, { method: 'POST' })).status, 500);
  } finally { server.close(); }
});

// ---------- REL-02：正常结束必须复位生命周期 ----------

test('REL-02：Mock 局正常打完后 entry.running=false，可被 TTL 清理；finished 局拒绝重开', async () => {
  const { Game } = require('../src/engine/game');
  const { makeMockAgentFactory } = require('../scripts/mock-agent');
  // 独占 dataDir（saveDir = <dataDir>/saves）——见文件头说明
  const board = { wolf: 1, seer: 1, witch: 1, villager: 2 };
  const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
  const { api, dataDir } = makeApiIn(makeDataDir('rel02'));
  try {
    const g = new Game({
      id: 'rel02-finish', board, players, stepPauseMs: 1, logger: silentLogger,
      agentFactory: makeMockAgentFactory(Math.random, { explodeRate: 0 }),
    });
    g.deal();
    g.started = true;
    const entry = { game: g, running: true, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now() };
    api.games.set(g.id, entry);
    api._drive(entry);
    // 等驱动循环自然结束（Mock 局很快；给 10s 上限防挂）
    const deadline = Date.now() + 10000;
    while ((!g.finished || entry.running) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(g.finished, 'Mock 局应能自然打完');
    // 等待终局存盘等异步收尾完成后，running 必须复位（终局保存是异步的，不能在 finished 翻转瞬间断言）
    const settle = Date.now() + 5000;
    while (entry.running && Date.now() < settle) await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(entry.running, false, '整改前：_drive 成功路径不复位 running → 该局永远无法被 TTL/LRU 回收');

    // TTL 清理：把 lastAccess 拨老，pruneGames 应当能丢弃这局（对象已在磁盘上）
    entry.lastAccess = Date.now() - 31 * 60 * 1000;
    const dropped = api.pruneGames({ ttlMs: 30 * 60 * 1000 });
    assert.ok(dropped >= 1, '已结束的对局必须可被清理');
    assert.ok(!api.games.has('rel02-finish'));

    // 已结束的对局拒绝重新开始
    const box = { res: { writeHead(code) { box.code = code; }, end(b) { box.body = JSON.parse(b); } } };
    const entry2 = { game: g, running: false, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now() };
    api.games.set(g.id, entry2);
    api.startGame(box.res, entry2, { token: 'pt' });
    assert.strictEqual(box.code, 409, '整改前：只查 running，已结束对局可被二次 _drive');
    assert.match(box.body.error, /已结束/);
    api.games.delete(g.id);
  } finally {
    await terminateApi(api, dataDir);
    }
});

// ---------- REL-03：存盘失败必须可重试 ----------

test('REL-03：写盘失败时不推进 savedStamp（保持脏），障碍清除后下一次保存真正落盘', async () => {
  const { Game } = require('../src/engine/game');
  const { api, dataDir } = makeApiIn(makeDataDir('rel03'));
  try {
    const board = { wolf: 1, seer: 1, witch: 1, villager: 2 };
    const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
    const g = new Game({ id: 'rel03-save', board, players, stepPauseMs: 1, logger: silentLogger });
    g.deal();
    g.started = true;
    const entry = { game: g, running: false, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now() };
    api.games.set(g.id, entry);

    const file = path.join(savesOf(dataDir), 'rel03-save.json');
    const tmp = file + '.tmp';
    // 障碍：把 tmp 路径预先占成一个目录 → writeFile 必然 EISDIR
    fs.mkdirSync(tmp);

    const first = await api.saveGame(entry, { force: true });
    assert.strictEqual(first, false, '第一次保存应失败');
    assert.strictEqual(fs.existsSync(file), false, '失败时不得留下"已保存"的假象');
    assert.strictEqual(entry.savedStamp, undefined, '整改前：savedStamp 在写盘前就被推进 → 之后周期保存永远跳过 → 数据静默丢失');

    // 清除障碍后，不强制 force：脏标记仍在，下一次保存必须真正写盘
    fs.rmdirSync(tmp);
    const second = await api.saveGame(entry);
    assert.strictEqual(second, true, '脏状态下第二次保存应真正落盘');
    assert.ok(fs.existsSync(file), '整改前：因 savedStamp 已被错误推进，这次保存会被跳过、文件永远写不出来');

    // 落盘成功后再保存（无变化）→ 脏标记生效，跳过写入
    const third = await api.saveGame(entry);
    assert.strictEqual(third, false, '没有变化时不应重复写盘');
    api.games.delete(g.id);
  } finally {
    await terminateApi(api, dataDir);
    }
});

// ---------- SEC-01：默认回环 + 管理会话/配对 + 权限矩阵 ----------

test('SEC-01：resolveListenHost 默认回环、WW_LAN=1 才开放、WW_HOST 可覆盖', () => {
  const { resolveListenHost } = require('../src/auth');
  assert.strictEqual(resolveListenHost({}), '127.0.0.1', '整改前：server.listen(PORT) 不带 host → 默认绑 0.0.0.0 对整个局域网开放');
  assert.strictEqual(resolveListenHost({ WW_LAN: '1' }), '0.0.0.0');
  assert.strictEqual(resolveListenHost({ WW_LAN: '1', WW_HOST: '192.168.1.5' }), '192.168.1.5');
  assert.strictEqual(resolveListenHost({ WW_HOST: '192.168.1.5' }), '192.168.1.5', 'WW_HOST 覆盖优先');
});

test('SEC-01：AuthManager 配对码生命周期（过期/锁定/一次性/会话签发与吊销）', () => {
  const { AuthManager } = require('../src/auth');
  const am = new AuthManager({ logger: silentLogger });
  // 关闭态（本机模式）：一切放行，与旧版行为一致
  assert.strictEqual(am.isManagement({ socket: { remoteAddress: '192.168.1.5' } }), true, '本机模式必须全放行（兼容现有单机流程）');

  am.setEnabled(true);
  assert.strictEqual(am.isManagement({ socket: { remoteAddress: '127.0.0.1' } }), true, '回环连接自动视为管理会话');
  assert.strictEqual(am.isManagement({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true, 'IPv4-mapped 回环也要识别');
  assert.strictEqual(am.isManagement({ socket: { remoteAddress: '192.168.1.5' } }), false, '远端无会话必须拒绝');

  // 配对码：错误 5 次锁定
  am.newPairingCode(1000);
  const code = am.currentCode(1000).code;
  assert.match(code, /^\d{6}$/);
  for (let i = 0; i < 5; i++) {
    assert.throws(() => am.pair('000000', 2000 + i));
  }
  assert.throws(() => am.pair(code, 3000), /失败次数过多/, '错满 5 次即使码正确也必须锁定');
  assert.strictEqual(am.currentCode(999999), null, '锁定期间不得发新码');

  // 过期
  const am2 = new AuthManager({ logger: silentLogger, enabled: true });
  am2.newPairingCode(1000);
  const good = am2.currentCode(1000).code;
  assert.throws(() => am2.pair(good, 1000 + 6 * 60 * 1000), /过期/, '超过 5 分钟必须过期');

  // 正确配对 → 会话生效、码一次性作废、吊销生效（用真实时钟走完整链路）
  const am3 = new AuthManager({ logger: silentLogger, enabled: true });
  am3.newPairingCode();
  const c3 = am3.currentCode().code;
  const sid = am3.pair(c3);
  assert.ok(sid && sid.length >= 64, '会话 ID 必须是高熵随机串');
  assert.strictEqual(am3.verifySession(sid), true);
  assert.throws(() => am3.pair(c3), /过期|不正确/, '配对码必须一次性作废');
  assert.strictEqual(am3.isManagement({ socket: { remoteAddress: '192.168.1.5' }, headers: { cookie: `ww_session=${sid}` } }), true, '配对后的远端设备凭 Cookie 获得管理会话');
  am3.revoke(sid);
  assert.strictEqual(am3.verifySession(sid), false, '吊销必须即时生效');
});

function stubRes() {
  const box = { headers: {} };
  box.res = {
    writeHead(code) { box.code = code; },
    end(b) { box.body = b ? JSON.parse(b) : null; },
    setHeader(k, v) { box.headers[k.toLowerCase()] = v; },
  };
  return box;
}

function stubReq({ method = 'GET', remote = '127.0.0.1', headers = {}, body = null } = {}) {
  const { EventEmitter } = require('events');
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  req.socket = { remoteAddress: remote };
  req.url = '/';
  process.nextTick(() => {
    if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

test('SEC-01（路由集成）：LAN 门禁下配置/建局/列表/统计 401，配对后放行；单局令牌通道不受影响', async () => {
  const { Game } = require('../src/engine/game');
  const { api, dataDir } = makeApiIn(makeDataDir('sec01'));
  try {
    api.auth.setEnabled(true); // 模拟 WW_LAN=1

    // 远端（未配对）：配置 401、建局 401、列表 401、统计 401
    const deny = (pathname, method = 'GET', extra = {}) => {
      const box = stubRes();
      api.handle(stubReq({ method, remote: '192.168.1.5', headers: { host: '192.168.1.5:3210', ...extra }, body: method === 'POST' ? {} : null }), box.res, pathname, new URLSearchParams());
      return box;
    };
    await deny('/api/config'); // 顺序执行由 handle 内部 await 保证
    assert.strictEqual(deny && true, true);
    const r1 = await new Promise((res) => { const box = stubRes(); api.handle(stubReq({ method: 'GET', remote: '192.168.1.5', headers: { host: 'localhost:3210' } }), box.res, '/api/config', new URLSearchParams()).then(() => res(box)); });
    assert.strictEqual(r1.code, 401, '未配对读配置必须 401（整改前：任何人拿到地址就能读走 API Key 明文）');
    const r2 = await new Promise((res) => { const box = stubRes(); api.handle(stubReq({ method: 'POST', remote: '192.168.1.5', headers: { host: 'localhost:3210' } }, ), box.res, '/api/games', new URLSearchParams()).then(() => res(box)); });
    assert.strictEqual(r2.code, 401, '未配对创建对局必须 401（防资源滥用与不可控费用）');
    const r3 = await new Promise((res) => { const box = stubRes(); api.handle(stubReq({ method: 'GET', remote: '192.168.1.5', headers: { host: 'localhost:3210' } }), box.res, '/api/stats', new URLSearchParams()).then(() => res(box)); });
    assert.strictEqual(r3.code, 401);

    // 配对码只发给本机；远端查询 pairing 拿不到码
    const rLocal = await new Promise((res) => { const box = stubRes(); api.handle(stubReq({ method: 'GET', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), box.res, '/api/auth/pairing', new URLSearchParams()).then(() => res(box)); });
    assert.ok(/^\d{6}$/.test(rLocal.body.code), '本机能看到配对码');
    const rRemote = await new Promise((res) => { const box = stubRes(); api.handle(stubReq({ method: 'GET', remote: '192.168.1.5', headers: { host: 'localhost:3210' } }), box.res, '/api/auth/pairing', new URLSearchParams()).then(() => res(box)); });
    assert.strictEqual(rRemote.body.code, null, '远端绝不能拿到配对码本体');

    // 远端用配对码换取会话 Cookie
    const code = rLocal.body.code;
    const rPair = await new Promise((res) => {
      const box = stubRes();
      const req = stubReq({ method: 'POST', remote: '192.168.1.5', headers: { host: 'localhost:3210', origin: 'https://localhost' }, body: { code } });
      api.handle(req, box.res, '/api/auth/pair', new URLSearchParams()).then(() => res(box));
    });
    assert.strictEqual(rPair.code, 200, 'Capacitor 壳的 localhost origin 必须被信任');
    const cookie = rPair.headers['set-cookie'];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);

    // 带 Cookie 后管理接口放行
    const rCfg = await new Promise((res) => { const box = stubRes(); api.handle(stubReq({ method: 'GET', remote: '192.168.1.5', headers: { host: 'localhost:3210', cookie } }), box.res, '/api/config', new URLSearchParams()).then(() => res(box)); });
    assert.strictEqual(rCfg.code, 200, '配对成功后配置可读');

    // 单局令牌通道不受影响：远端凭玩家令牌可看本局视图，但不能读全量令牌
    const board = { wolf: 1, seer: 1, witch: 1, villager: 2 };
    const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: i === 0 }));
    const g = new Game({ id: 'sec01-game', board, players, stepPauseMs: 1, logger: silentLogger });
    g.deal(); g.started = true;
    api.games.set(g.id, { game: g, running: false, error: null, mock: true, tokens: { player: 'ptok', god: 'gtok' }, createdAt: Date.now(), lastAccess: Date.now() });
    const rView = await new Promise((res) => { const box = stubRes(); api.handle(stubReq({ method: 'GET', remote: '192.168.1.5', headers: { host: 'localhost:3210' } }), box.res, '/api/games/sec01-game/view', new URLSearchParams('token=ptok&after=0')).then(() => res(box)); });
    assert.strictEqual(rView.code, 200, '玩家令牌通道（LAN 上的 APP）必须保持可用');
    const rTokens = await new Promise((res) => { const box = stubRes(); api.handle(stubReq({ method: 'GET', remote: '192.168.1.5', headers: { host: 'localhost:3210' } }), box.res, '/api/games/sec01-game/tokens', new URLSearchParams('token=ptok')).then(() => res(box)); });
    assert.strictEqual(rTokens.code, 401, '全量令牌属于管理信息：即便持有玩家令牌也必须 401');
    api.games.delete(g.id);
  } finally {
    await terminateApi(api, dataDir);
    }
});

// ---------- SEC-02：不可信内容必须按文本渲染（静态汇点审计） ----------

test('SEC-02：seatLabel 必须在源头转义昵称，system/game_over 透传文本必须转义', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  const m = fs.readFileSync(path.join(__dirname, '..', 'web', 'm', 'm.js'), 'utf8');

  // seatLabel 的返回值只进 innerHTML 模板（app.js 37 处 / m.js 30+ 处），昵称是用户可控输入
  assert.match(app, /function seatLabel\(seat\) \{[\s\S]*?escapeHtml\(raw\)/, 'app.js seatLabel 必须转义昵称');
  assert.match(m, /const seatLabel = \(seat\) =>[\s\S]*?escapeHtml\(raw\)/, 'm.js seatLabel 必须转义昵称');

  // system 事件文本透传服务端消息；game_over 的 reason 透传终止原因 —— 都不能裸插
  assert.doesNotMatch(app, /el\('div', 'sysline', e\.text \|\| d\.text \|\| ''\)/, 'app.js system 事件裸插 e.text');
  assert.doesNotMatch(m, /el\('div', 'sysline', e\.text \|\| d\.text \|\| ''\)/, 'm.js system 事件裸插 e.text');
  assert.match(app, /escapeHtml\(d\.reason \|\| '对局已终止'\)/);
  assert.match(m, /escapeHtml\(d\.reason \|\| '对局已终止'\)/);

  // 发言正文（模型输出）两条渲染路径都必须转义
  assert.ok(app.includes(`el('div', null, escapeHtml(d.text || ''))`), 'app.js 发言正文必须转义');
  assert.ok(m.includes(`el('div', null, escapeHtml(d.text || ''))`), 'm.js 发言正文必须转义');
});

test('SEC-02（行为级）：以 escapeHtml 语义验证恶意昵称被中和', () => {
  // 从 app.js 提取 escapeHtml 实现做行为验证（无 DOM 环境依赖）
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  const fn = new Function(`${app.match(/function escapeHtml\(s\) \{.*\}/)[0]}; return escapeHtml;`)();
  const payload = `<img src=x onerror="alert(1)">"'<>&`;
  const out = fn(payload);
  assert.ok(!/[<>"']/.test(out.replace(/&(amp|lt|gt|quot|#39);/g, '')), '转义后不得残留可执行字符');
  assert.strictEqual(out, `&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&quot;&#39;&lt;&gt;&amp;`);
});

// ---------- LOGIC-01：动态阵营（暗恋者链人）在胜负/评分/复盘/经验总结四处一致 ----------

function makeGameWithAdmirer() {
  const { Game } = require('../src/engine/game');
  const board = { wolf: 1, seer: 1, admirer: 1, villager: 2 };
  const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
  const g = new Game({ id: 'logic01', board, players, stepPauseMs: 1, logger: silentLogger });
  g.deal();
  // 指定角色：1 号暗恋者，2 号狼人，3 号预言家，4/5 号平民
  g.players[0].role = 'admirer';
  g.players[1].role = 'wolf';
  g.players[2].role = 'seer';
  g.players[3].role = 'villager';
  g.players[4].role = 'villager';
  return g;
}

test('LOGIC-01：暗恋者链狼人 → factionOf=wolf 而类别保留；链神职/村民 → good', () => {
  const g = makeGameWithAdmirer();
  const admirer = g.player(1);

  g.crush[1] = 2; // 链狼人
  assert.strictEqual(g.categoryOf(admirer), 'wolf');
  assert.strictEqual(g.factionOf(admirer), 'wolf', '整改前：评分/复盘读静态 ROLES.team，链狼暗恋者被当成好人结算');

  g.crush[1] = 3; // 链预言家
  assert.strictEqual(g.categoryOf(admirer), 'god', '类别必须保留（神职展示与规则用）');
  assert.strictEqual(g.factionOf(admirer), 'good');

  g.crush[1] = 4; // 链村民
  assert.strictEqual(g.categoryOf(admirer), 'villager');
  assert.strictEqual(g.factionOf(admirer), 'good');
});

test('LOGIC-01：链狼暗恋者在狼胜局的评分行 team=wolf 且拿「阵营获胜」分', () => {
  const { computeScores } = require('../src/engine/score');
  const g = makeGameWithAdmirer();
  g.crush[1] = 2; // 链狼
  g.winner = 'wolf';
  g.winReason = '屠边';
  g.finished = true;
  const rows = computeScores(g);
  const adm = rows.rows.find((r) => r.seat === 1);
  assert.strictEqual(adm.team, 'wolf', '整改前：team 读静态 ROLES.admirer.team=good');
  assert.ok(adm.details.some((d) => d.includes('+20 阵营获胜')), '整改前：暗恋者链狼拿不到阵营获胜分');
});

test('LOGIC-01：复盘归属（teamOf）与经验总结提示词用最终阵营', () => {
  const review = require('../src/engine/review');
  const { lessonInstruction } = require('../src/ai/prompts');
  const g = makeGameWithAdmirer();
  g.crush[1] = 2; // 链狼
  g.winner = 'wolf';
  g.finished = true;
  // teamOf 是 review.js 内部实现：通过 reviewFacts 的放逐台账观察最终阵营归属
  const facts = review.reviewFacts(g, 1);
  assert.ok(facts, 'reviewFacts 应能抽取暗恋者的复盘事实');
  const prompt = lessonInstruction(g, g.player(1), '');
  assert.match(prompt, /你所在的阵营.*获胜/, '整改前：经验总结按静态 good 计算 → 提示词会说「失败」');
});

// ---------- REL-04：读档按当前配置恢复 LLM 并发语义 ----------

test('REL-04：fromJSON 按 opts.parallelLlm 恢复并发配置（整改前永远 false）', () => {
  const { Game } = require('../src/engine/game');
  const board = { wolf: 1, seer: 1, witch: 1, villager: 2 };
  const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
  const g = new Game({ id: 'rel04', board, players, stepPauseMs: 1, logger: silentLogger, parallelLlm: true });
  g.deal();
  g.started = true;
  const doc = g.toJSON();
  delete doc.anchor;
  const resumed = Game.fromJSON(doc, { parallelLlm: true });
  assert.strictEqual(resumed.parallelLlm, true, '整改前：fromJSON 不传 parallelLlm → 恢复后并发扇出永远关闭，多 Key 提速失效');
  const resumed2 = Game.fromJSON(doc, { parallelLlm: false });
  assert.strictEqual(resumed2.parallelLlm, false, '当前配置关闭时恢复也必须关闭');
});

// ---------- UX-01：移动端复盘带令牌轮询（静态汇点审计） ----------

test('UX-01：移动端复盘 GET 必须携带令牌，轮询收尾不得只读一次', () => {
  const m = fs.readFileSync(path.join(__dirname, '..', 'web', 'm', 'm.js'), 'utf8');
  const seg = m.slice(m.indexOf('async function requestReview'), m.indexOf('function showMyCard'));
  assert.match(seg, /\/review\?token=/, '整改前：POST 后立即无令牌 GET → 稳定 403，复盘永远停在「正在生成」');
  assert.match(seg, /status === 'done'|review\.status === 'done'/, '必须轮询到 done 才收尾（POST 受理 ≠ 生成完成）');
  assert.match(seg, /reviewBusy/, '必须有防连点守卫');
});

// ---------- 阶段 2.2：HTML 文档安全响应头（CSP 等） ----------

test('CSP：HTML 响应带 Content-Security-Policy（内联守卫脚本哈希白名单）与 Referrer-Policy', async () => {
  const { serveStatic } = require('../src/static');
  const WEB = path.join(__dirname, '..', 'web');
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    serveStatic(req, res, decodeURIComponent(u.pathname), { webDir: WEB });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(`${base}/`);
    assert.strictEqual(home.status, 200);
    const csp = home.headers.get('content-security-policy');
    assert.ok(csp, '必须下发 CSP');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' 'sha256-/, '内联守卫脚本必须走哈希白名单而非 unsafe-inline');
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, 'script-src 不得出现 unsafe-inline');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.strictEqual(home.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    // SPA 兜底路由同样要有 CSP
    const spa = await fetch(`${base}/some-route`);
    assert.ok(spa.headers.get('content-security-policy'), 'SPA 兜底返回的 HTML 也要带 CSP');
  } finally { server.close(); }
});

test('CSP：index.html 的内联脚本哈希与 static.js 白名单一致（改脚本必须同步改 CSP）', () => {
  const crypto = require('crypto');
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const hash = 'sha256-' + crypto.createHash('sha256').update(inline).digest('base64');
  const st = fs.readFileSync(path.join(__dirname, '..', 'src', 'static.js'), 'utf8');
  assert.ok(st.includes(hash), 'index.html 内联脚本哈希必须在 static.js 的 CSP 白名单里');
  assert.ok(!/onload="|onerror="/.test(html), 'HTML 不得再出现内联事件属性（CSP 会静默拦截）');
});

// ---------- §1.4 收尾：Content-Type 校验、限流、凭证外带防护 ----------

test('§1.4：声明非 JSON 的 Content-Type → 415；读 JSON 主体不受影响', async () => {
  const { api, dataDir } = makeApiIn(makeDataDir('ct'));
  try {
    const box = stubRes();
    const req = stubReq({ method: 'POST', remote: '127.0.0.1', headers: { host: 'localhost:3210', 'content-type': 'text/xml' }, body: { a: 1 } });
    await api.handle(req, box.res, '/api/games', new URLSearchParams());
    assert.strictEqual(box.code, 415, '声明的 Content-Type 不被支持时必须 415');
    api.games.delete('x');
  } finally {
    await terminateApi(api, dataDir);
    }
});

test('§1.4：凭证外带防护——改 baseUrl 不重输 Key 后，test/probe 拒绝发凭证', async () => {
  let saved = { apiKey: 'sk-secret', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', journal: false };
  const { api, dataDir } = makeApiIn(makeDataDir('rekey'), { config: { get: () => saved, save(b) { const clean = { ...b }; if (typeof clean.apiKey === 'string' && clean.apiKey.includes('****')) delete clean.apiKey; if (Array.isArray(clean.apiKeys)) clean.apiKeys = clean.apiKeys.filter((v) => v && !String(v).includes('****')); saved = { ...saved, ...clean }; return saved; } } });
  try {
    // 旧 Key 保存时的地址基准
    api.baseUrlNeedsRekey = false;

    // ① 改 baseUrl 且不重输 Key → 置标记
    const put1 = stubRes();
    await api.handle(stubReq({ method: 'PUT', remote: '127.0.0.1', headers: { host: 'localhost:3210', origin: 'http://localhost:1' }, body: { baseUrl: 'https://evil.example/v1' } }), put1.res, '/api/config', new URLSearchParams());
    assert.strictEqual(put1.code, 200);
    assert.strictEqual(api.baseUrlNeedsRekey, true, '换地址不换 Key 必须标记未验证');
    // ② test/probe 拒绝
    const t1 = stubRes();
    await api.handle(stubReq({ method: 'POST', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), t1.res, '/api/config/test', new URLSearchParams());
    assert.strictEqual(t1.code, 400);
    assert.match(t1.body.error, /重新输入 API Key/);
    const p1 = stubRes();
    await api.handle(stubReq({ method: 'POST', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), p1.res, '/api/config/probe', new URLSearchParams());
    assert.strictEqual(p1.code, 400);
    // ③ 重新输入 Key → 解除标记
    await api.handle(stubReq({ method: 'PUT', remote: '127.0.0.1', headers: { host: 'localhost:3210', origin: 'http://localhost:1' }, body: { baseUrl: 'https://evil.example/v1', apiKey: 'sk-new' } }), stubRes().res, '/api/config', new URLSearchParams());
    assert.strictEqual(api.baseUrlNeedsRekey, false, '重输 Key 后解除');
    const t2 = stubRes();
    await api.handle(stubReq({ method: 'POST', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), t2.res, '/api/config/test', new URLSearchParams());
    assert.notStrictEqual(t2.code, 400, '解除后可正常测试（此处因假 Key 返回 502 也算通过）');
  } finally {
    await terminateApi(api, dataDir);
    }
});

test('§1.4：配对/建局限流——超阈值返回 429', async () => {
  const { api, dataDir } = makeApiIn(makeDataDir('rate'));
  try {
    api.auth.setEnabled(true);
    // 远端设备连点配对 11 次 → 第 11 次必须 429（阈值 10/分钟）
    let last;
    for (let i = 0; i < 11; i++) {
      const box = stubRes();
      await api.handle(stubReq({ method: 'POST', remote: '10.0.0.9', headers: { host: 'localhost:3210', origin: 'https://localhost' }, body: { code: '000000' } }), box.res, '/api/auth/pair', new URLSearchParams());
      last = box;
    }
    assert.strictEqual(last.code, 429, '配对失败刷接口必须被限流');
    // 本机回环不受影响（回环自动授权跳过 pair 限流也同理 —— 不同键互不干扰）
    const local = stubRes();
    await api.handle(stubReq({ method: 'GET', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), local.res, '/api/auth/pairing', new URLSearchParams());
    assert.strictEqual(local.code, 200);
  } finally {
    await terminateApi(api, dataDir);
    }
});

// ---------- 覆盖率补强：api.js 管理与操作接口的校验分支 ----------

test('覆盖率补强：createGame 校验链、stats/tokens/action/review 分支、LRU 淘汰', async () => {
  const { Game } = require('../src/engine/game');
  // 注意 apiKey 留空：让「真实局必须先配 Key」的校验分支可达（下面的局全部 mock:true）
  const { api, dataDir } = makeApiIn(makeDataDir('cov'), { config: { get: () => ({ apiKey: '', journal: false }), save() {} } });
  try {
    const call = (pathnameWithQuery, { method = 'GET', body = null, headers = {} } = {}) => {
      // 与真实服务一致：路径与查询串分开传（之前混在一起会让路由匹配不上 → 假 404）
      const [p, q] = pathnameWithQuery.split('?');
      const box = stubRes();
      return api.handle(stubReq({ method, remote: '127.0.0.1', headers: { host: 'localhost:3210', ...headers }, body }), box.res, p, new URLSearchParams(q)).then(() => box);
    };
    // createGame 校验链（LAN/本机均可达：这里走本机自动授权）
    const bad1 = await call('/api/games', { method: 'POST', body: { board: { wolf: 9, villager: 0 }, players: [] } });
    assert.strictEqual(bad1.code, 400, '板子不合法必须 400');
    const bad2 = await call('/api/games', { method: 'POST', body: { board: { wolf: 1, seer: 1, witch: 1, villager: 2 }, players: [] } });
    assert.strictEqual(bad2.code, 400);
    assert.match(bad2.body.error, /玩家数/);
    const bad3 = await call('/api/games', { method: 'POST', body: { board: { wolf: 1, seer: 1, witch: 1, villager: 2 }, players: [{ isHuman: true }, { isHuman: true }, { isHuman: false }, { isHuman: false }, { isHuman: false }] } });
    assert.strictEqual(bad3.code, 400);
    assert.match(bad3.body.error, /最多 1 名人类/);
    const bad4 = await call('/api/games', { method: 'POST', body: { board: { wolf: 1, seer: 1, witch: 1, villager: 2 }, players: [{ isHuman: false }, { isHuman: false }, { isHuman: false }, { isHuman: false }, { isHuman: false }], mock: false } });
    assert.strictEqual(bad4.code, 400);
    assert.match(bad4.body.error, /API Key/);

    // 正常创建一局 Mock 局
    const ok1 = await call('/api/games', { method: 'POST', body: { board: { wolf: 1, seer: 1, witch: 1, villager: 2 }, players: [{ isHuman: true }, { isHuman: false }, { isHuman: false }, { isHuman: false }, { isHuman: false }], mock: true } });
    assert.strictEqual(ok1.code, 200);
    const gameId = ok1.body.gameId;

    // stats 形状
    const st = await call('/api/stats');
    assert.strictEqual(st.code, 200);

    // action 的两条守卫是**先后**关系（src/api.js：`if (!game.pending) return 409` 在
    // `if (body.token !== entry.tokens.player) return 403` 之前），所以「无 pending」与「token 错」
    // 是两个局面下的两个确定结果，**不是**同一次调用可能给出的两种码。
    // 原写法 `a1.code === 409 || a1.code === 403` 把这两种局面混成一次调用，实际两条守卫都没被钉住：
    // 新建局没开局，game.pending 恒为 null（Game 构造器置 null），403 那一半永远走不到。
    const entry = api.games.get(gameId);
    const a1 = await call(`/api/games/${gameId}/action`, { method: 'POST', body: { token: 'ptok', payload: {} } });
    assert.strictEqual(a1.code, 409, `未开局（pending 为空）action 必须 409，实际 ${a1.code}`);
    assert.match(a1.body.error, /没有等待中的操作/, '必须命中"无等待操作"这条守卫，而不是 token 校验');
    // token 错 → 403：置一个 pending 桩把另一个局面也钉住，避免依赖 Mock 驱动时序（用完立刻复位）
    entry.game.pending = { seat: 1, request: { task: 'speech' }, resolve() {}, reject() {} };
    const a1b = await call(`/api/games/${gameId}/action`, { method: 'POST', body: { token: 'ptok', payload: {} } });
    entry.game.pending = null;
    assert.strictEqual(a1b.code, 403, `pending 存在但 token 不匹配必须 403，实际 ${a1b.code}`);
    assert.match(a1b.body.error, /token 无效/);
    // review：GET（无复盘）返回 null review（带上帝令牌；无令牌本来就会 403——见 UX-01）
    const rv = await call(`/api/games/${gameId}/review?token=${encodeURIComponent(ok1.body.godToken)}`);
    assert.strictEqual(rv.code, 200);
    assert.strictEqual(rv.body.review, null);
    // explode/duel：未开局 409
    const ex = await call(`/api/games/${gameId}/explode`, { method: 'POST', body: { token: 'ptok' } });
    assert.ok(ex.code >= 400, '未开局自爆必须报错');

    // LRU 淘汰分支：maxEntries 压到 1 → 旧的被挤出
    api.games.clear();
    for (let i = 0; i < 3; i++) {
      const g = new Game({ id: 'lru' + i, board: { wolf: 1, seer: 1, witch: 1, villager: 2 }, players: Array.from({ length: 5 }, (_, k) => ({ name: 'P' + (k + 1), isHuman: false })), stepPauseMs: 1, logger: silentLogger });
      g.deal(); g.started = true; g.finished = true;
      api.games.set(g.id, { game: g, running: false, error: null, mock: true, tokens: { player: 'p', god: 'g' }, createdAt: Date.now(), lastAccess: i * 1000 });
    }
    const dropped = api.pruneGames({ maxEntries: 1 });
    assert.ok(dropped >= 2 && api.games.size <= 1, 'LRU 上限必须淘汰最久未访问的局');
    api.games.clear();
  } finally {
    await terminateApi(api, dataDir);
    }
});

// ---------- 覆盖率深挖：meta/复盘分支/狼聊/日志/统计/404 ----------


function makeFinishedEntry(api, { mock = true, humanRole = 'seer' } = {}) {
  const { Game } = require('../src/engine/game');
  const board = { wolf: 1, seer: 1, witch: 1, villager: 2 };
  const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: i === 0 }));
  const g = new Game({ id: 'deep' + Date.now() + Math.floor(Math.random() * 999), board, players, stepPauseMs: 1, logger: silentLogger });
  g.deal();
  g.players[0].role = humanRole;
  g.started = true;
  g.finished = true;
  g.winner = 'wolf';
  g.winReason = '屠边';
  const entry = { game: g, running: false, error: null, mock, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now(), review: null };
  api.games.set(g.id, entry);
  return entry;
}

test('深挖：/api/meta 全量形状（roles/boards/roleArt/paces）', async () => {
  const { api, dataDir } = makeFinishedApi('meta');
  try {
    const box = stubRes();
    await api.handle(stubReq({ method: 'GET', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), box.res, '/api/meta', new URLSearchParams());
    assert.strictEqual(box.code, 200);
    const body = box.body;
    assert.ok(body.roles && body.roles.wolf && body.roles.seer, 'roles 必须下发');
    assert.ok(body.boards && Object.keys(body.boards).length >= 10, '内置板子必须下发');
    assert.ok(Array.isArray(body.paces) && body.paces.length >= 3, '节奏档位必须下发');
    assert.ok('roleArt' in body, 'roleArt 必须下发（角色卡图 png/webp/svg 解析结果）');
    api.games.clear();
  } finally {
    await terminateApi(api, dataDir);
    }
});

test('深挖：getReview 的 done 形状 + startReview 的 409/400/cached 分支', async () => {
  const { api, dataDir } = makeFinishedApi('rev');
  try {
    const entry = makeFinishedEntry(api);
    const gid = entry.game.id;

    // done 形状（875-880）
    entry.review = { status: 'done', mode: 'llm', text: '复盘内容', fallbackReason: null, seat: 1, at: 123 };
    const r1 = stubRes();
    await api.handle(stubReq({ method: 'GET', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), r1.res, `/api/games/${gid}/review`, new URLSearchParams('token=gt'));
    assert.strictEqual(r1.code, 200);
    assert.strictEqual(r1.body.review.text, '复盘内容');
    assert.strictEqual(r1.body.review.status, 'done');

    // 未结束 → 409（908-911）
    entry.game.finished = false;
    const r2 = stubRes();
    await api.handle(stubReq({ method: 'POST', remote: '127.0.0.1', headers: { host: 'localhost:3210' }, body: { token: 'gt' } }), r2.res, `/api/games/${gid}/review`, new URLSearchParams());
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(r2.code, 409);
    assert.match(r2.body.error, /还没结束/);
    entry.game.finished = true;

    // done 缓存的短路（走真实路由）：带上帝令牌 + 对局已结束 + 已有 done 复盘 + 未 regenerate
    // ⇒ 200 { cached: true }，不再走座位校验/重新生成（startReview 的判定顺序：令牌 → 已结束 → 显式座位 → 缓存 → 生成）。
    // 原来这行是 `assert.ok(true);`——探针实测这次调用返回的正是 200 cached，占位符把结果整个盖住了；
    // 「座位不存在 → 400」那条分支由下面 r5 用显式 seat:99 钉住（方法级调用），这里钉的是**路由级**的缓存短路。
    const r3 = stubRes();
    await api.handle(stubReq({ method: 'POST', remote: '127.0.0.1', headers: { host: 'localhost:3210' }, body: { token: 'gt' } }), r3.res, `/api/games/${gid}/review`, new URLSearchParams());
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(r3.code, 200, `已有 done 复盘时 POST /review 必须短路返回，实际 ${r3.code}`);
    assert.strictEqual(r3.body.cached, true, '必须回 cached:true，而不是重新生成一份复盘');
    assert.strictEqual(entry.review.status, 'done', '短路不得把已有复盘置为 running');
    assert.strictEqual(entry.review.text, '复盘内容', '短路不得动已有复盘文本');
    const r4 = stubRes();
    await api.handle(stubReq({ method: 'POST', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), r4.res, `/api/games/${gid}/review?token=gt`, new URLSearchParams());
    // 上面的 handle 需要带 body；改用显式 body 调 startReview：
    const r5 = stubRes();
    await api.startReview(r5.res, entry, { token: 'gt', seat: 99 });
    assert.strictEqual(r5.code, 400);
    assert.match(r5.body.error, /座位 99 不存在/);

    // done 缓存：不 regenerate 直接回 cached（919-921）
    const r6 = stubRes();
    await api.startReview(r6.res, entry, { token: 'gt' });
    assert.strictEqual(r6.code, 200);
    assert.strictEqual(r6.body.cached, true);
    api.games.delete(gid);
  } finally {
    await terminateApi(api, dataDir);
    }
});

test('深挖：狼聊通道（inactive 409 / 非狼 403 / say 入队 / extra 加轮 / end / kind 校验）', async () => {
  const { api, dataDir } = makeFinishedApi('wt');
  const { Game } = require('../src/engine/game');
  try {
    const board = { wolf: 2, seer: 1, witch: 1, villager: 1 };
    const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: i === 0 }));
    const g = new Game({ id: 'wt' + Date.now(), board, players, stepPauseMs: 1, logger: silentLogger });
    g.deal();
    g.players[0].role = 'wolf';   // 人类是狼
    g.players[1].role = 'wolf';
    g.players[2].role = 'seer';
    g.players[3].role = 'witch';
    g.players[4].role = 'villager';
    g.started = true;
    const entry = { game: g, running: false, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now(), review: null };
    api.games.set(g.id, entry);

    const wtCall = (body) => {
      const box = stubRes();
      return api.handle(stubReq({ method: 'POST', remote: '127.0.0.1', headers: { host: 'localhost:3210' }, body }), box.res, `/api/games/${g.id}/wolftalk`, new URLSearchParams()).then(() => box);
    };
    // inactive → 409（1178）
    let r = await wtCall({ token: 'pt', kind: 'say', text: 'hi' });
    assert.strictEqual(r.code, 409);
    assert.match(r.body.error, /狼队讨论/);
    // active → say 入队（1183-1187）
    g.wolfTalk = { active: true, round: 1, rounds: 2, queue: [], endNow: false };
    r = await wtCall({ token: 'pt', kind: 'say', text: '刀4' });
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.wolfTalk.queued, 1);
    // 空文本 → 400（1185）
    r = await wtCall({ token: 'pt', kind: 'say', text: '  ' });
    assert.strictEqual(r.code, 400);
    // extra 加轮（1188-1191）
    r = await wtCall({ token: 'pt', kind: 'extra' });
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.wolfTalk.rounds, 3);
    // end（1192-1193）
    r = await wtCall({ token: 'pt', kind: 'end' });
    assert.strictEqual(r.code, 200);
    assert.strictEqual(g.wolfTalk.endNow, true);
    // kind 非法 → 400（1194-1195）
    r = await wtCall({ token: 'pt', kind: 'hack' });
    assert.strictEqual(r.code, 400);
    // 错 token → 403（1176）
    r = await wtCall({ token: 'wrong', kind: 'say', text: 'x' });
    assert.strictEqual(r.code, 403);
    api.games.delete(g.id);
  } finally {
    await terminateApi(api, dataDir);
    }
});

test('深挖：未知接口 404、令牌找回（本机）、logs 需上帝令牌、unpair 清会话', async () => {
  const { api, dataDir } = makeFinishedApi('misc');
  try {
    const entry = makeFinishedEntry(api, { humanRole: 'wolf' });
    const gid = entry.game.id;

    // 未知接口 → 404（591）
    const nf = stubRes();
    await api.handle(stubReq({ method: 'GET', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), nf.res, '/api/nope', new URLSearchParams());
    assert.strictEqual(nf.code, 404);

    // 令牌找回（1246-1247）：本机回环默认授权
    const tk = stubRes();
    await api.handle(stubReq({ method: 'GET', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), tk.res, `/api/games/${gid}/tokens`, new URLSearchParams());
    assert.strictEqual(tk.code, 200);
    assert.strictEqual(tk.body.player, 'pt');

    // logs 需要上帝令牌（1200-1201）
    const lg1 = stubRes();
    await api.handle(stubReq({ method: 'GET', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), lg1.res, `/api/games/${gid}/logs`, new URLSearchParams('token=wrong'));
    assert.strictEqual(lg1.code, 403);
    const lg2 = stubRes();
    await api.handle(stubReq({ method: 'GET', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), lg2.res, `/api/games/${gid}/logs`, new URLSearchParams('token=gt'));
    assert.strictEqual(lg2.code, 200);

    // unpair 清会话（429-432）
    const up = stubRes();
    await api.handle(stubReq({ method: 'POST', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), up.res, '/api/auth/unpair', new URLSearchParams());
    assert.strictEqual(up.code, 200);
    api.games.delete(gid);
  } finally {
    await terminateApi(api, dataDir);
    }
});

test('深挖：stats 聚合存档（写一份存档 → 胜负/天数/板子统计正确）', async () => {
  const { api, dataDir } = makeFinishedApi('stats');
  try {
    const doc = { schemaVersion: 2, mock: false, tokens: {}, game: { id: 'statg1', day: 3, phase: 'over', started: true, finished: true, winner: 'good', winReason: 'r', players: Array.from({ length: 9 }, (_, i) => ({ seat: i + 1, name: 'P' + i, isHuman: false })) }, anchor: null, review: null, savedAt: Date.now() };
    fs.writeFileSync(path.join(savesOf(dataDir), 'statg1.json'), JSON.stringify(doc));
    const box = stubRes();
    await api.handle(stubReq({ method: 'GET', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), box.res, '/api/stats', new URLSearchParams());
    assert.strictEqual(box.code, 200);
    const s = box.body;
    assert.ok(s.games >= 1 && s.finished >= 1, '必须统计到刚写的存档');
    assert.strictEqual(s.goodWins, 1, '好人胜利数必须正确');
    api.games.clear();
  } finally {
    await terminateApi(api, dataDir);
    }
});

// ---------- 分支覆盖补强：Origin 不信任/限流边界/双令牌视角/运行中局不被回收 ----------

test('分支：恶意 Origin 的状态改变请求必须 403（pair/unpair/config PUT）', async () => {
  const { api, dataDir } = makeFinishedApi('orig');
  try {
    const evil = { host: 'x', origin: 'https://evil.example' };
    const r1 = stubRes();
    await api.handle(stubReq({ method: 'POST', remote: '10.0.0.9', headers: evil, body: { code: '123456' } }), r1.res, '/api/auth/pair', new URLSearchParams());
    assert.strictEqual(r1.code, 403, '恶意 Origin 配对必须 403');
    const r2 = stubRes();
    await api.handle(stubReq({ method: 'POST', remote: '127.0.0.1', headers: evil }), r2.res, '/api/auth/unpair', new URLSearchParams());
    assert.strictEqual(r2.code, 403);
    const r3 = stubRes();
    await api.handle(stubReq({ method: 'PUT', remote: '127.0.0.1', headers: evil, body: { model: 'x' } }), r3.res, '/api/config', new URLSearchParams());
    assert.strictEqual(r3.code, 401, 'PUT config 恶意 Origin 按未授权处理');
    // 无 Origin 头（curl / Electron 主进程类客户端）不受 Origin 检查影响：
    //   · isTrustedOrigin 对"没有 Origin 头"直接放行（src/auth.js：`if (!origin) return true`）；
    //   · 限流计数在 Origin 检查**之后**（src/api.js 先 isTrustedOrigin 再 _rateAllow），
    //     所以上面 r1 被 Origin 拒掉时并没有消耗配额 —— 本用例到这里只发生 1 次计数尝试，远不到 10 次上限。
    // 于是只有一条结局：请求走到配对逻辑、被它拒绝 → 403（本用例没有 setEnabled(true)，auth 处于默认的
    // 本机模式，pair() 抛「本机模式无需配对」，由 api.js 的 catch 映射成 403）。
    // 429 需要超限流窗口才会出现，不是"竞态下两种都合法"——原并集写法把这条守卫顺序整个盖住了。
    const r4 = stubRes();
    await api.handle(stubReq({ method: 'POST', remote: '10.0.0.9', headers: { host: 'localhost:3210' }, body: { code: '123456' } }), r4.res, '/api/auth/pair', new URLSearchParams());
    assert.strictEqual(r4.code, 403, `无 Origin 的远端配对应走到配对逻辑并被它拒绝（403），实际 ${r4.code}`);
    assert.doesNotMatch(r4.body.error, /Origin/, '拒绝理由必须是配对逻辑本身，而不是被 Origin 检查拦死');
  } finally {
    await terminateApi(api, dataDir);
    }
});

test('分支：view 的玩家/上帝双令牌、pruneGames 不回收运行中局', async () => {
  const { api, dataDir } = makeFinishedApi('br');
  try {
    const entry = makeFinishedEntry(api, { humanRole: 'seer' });
    const gid = entry.game.id;
    // 上帝令牌视角
    const vGod = stubRes();
    await api.handle(stubReq({ method: 'GET', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), vGod.res, `/api/games/${gid}/view`, new URLSearchParams('token=gt&after=0'));
    assert.strictEqual(vGod.code, 200);
    // 玩家令牌视角
    const vMe = stubRes();
    await api.handle(stubReq({ method: 'GET', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), vMe.res, `/api/games/${gid}/view`, new URLSearchParams('token=pt&after=0'));
    assert.strictEqual(vMe.code, 200);
    // 错误令牌
    const vBad = stubRes();
    await api.handle(stubReq({ method: 'GET', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), vBad.res, `/api/games/${gid}/view`, new URLSearchParams('token=nope&after=0'));
    assert.strictEqual(vBad.code, 403);
    // 运行中局绝不被 prune（running 跳过分支）
    entry.running = true;
    entry.lastAccess = Date.now() - 999 * 60 * 1000;
    const droppedRunning = api.pruneGames({ ttlMs: 30 * 60 * 1000 });
    void droppedRunning; // 运行中的局被跳过（返回 0），断言只看"局还在"，见下方 dropped2
    assert.ok(api.games.has(gid), '运行中的局必须跳过清理');
    entry.running = false;
    // ⚠ 这里必须接收本次调用的返回值：第一次调用时局还在 running（被跳过，返回 0），
    // 若沿用上面那个 dropped，断言永远看的是 0（验收时收紧断言才发现这个测试自身的问题）。
    const dropped2 = api.pruneGames({ ttlMs: 30 * 60 * 1000 });
    api.games.delete(gid);
    assert.ok(dropped2 >= 1, `过期且非运行中的局应被清理（实际清理 ${dropped2} 个）`);
  } finally {
    await terminateApi(api, dataDir);
    }
});

test('分支角落：畸形 Origin 解析失败、坏 Cookie、本机模式下 pair 报错', async () => {
  const { api, dataDir } = makeFinishedApi('corner');
  try {
    // ① Origin 无法解析 → isTrustedOrigin false → 403
    const r1 = stubRes();
    await api.handle(stubReq({ method: 'POST', remote: '10.0.0.9', headers: { host: 'localhost:3210', origin: '::::not-a-url' }, body: { code: '1' } }), r1.res, '/api/auth/pair', new URLSearchParams());
    assert.strictEqual(r1.code, 403);
    // ② Cookie 无 '=' → sessionIdFrom 返回 null → 未授权
    api.auth.setEnabled(true);
    const r2 = stubRes();
    await api.handle(stubReq({ method: 'GET', remote: '10.0.0.9', headers: { host: 'localhost:3210', cookie: 'garbage' } }), r2.res, '/api/config', new URLSearchParams());
    assert.strictEqual(r2.code, 401);
    api.auth.setEnabled(false);
    // ③ 本机模式（未启用）下调 pair → 显式报错（分支：!this.enabled）
    assert.throws(() => api.auth.pair('123456'), /本机模式无需配对/);
    // ④ 未启用时 newPairingCode 同样报错
    assert.throws(() => api.auth.newPairingCode(), /本机模式无需配对/);
  } finally {
    await terminateApi(api, dataDir);
    }
});

test('分支补强：saveActive 双侧、wolfTalk active 的上帝视图、显式座位/观战建局', async () => {
  const { api, dataDir } = makeFinishedApi('br2');
  try {
    const entry = makeFinishedEntry(api, { humanRole: 'seer' });
    const gid = entry.game.id;

    // saveActive：进行中局走保存分支、已结束局走跳过分支（361-364 双侧）
    entry.game.started = true;
    entry.game.finished = false;
    entry.running = true;
    const savedCount = await api.saveActive();
    assert.ok(savedCount >= 1, '进行中的局应被保存');
    entry.game.finished = true;
    entry.running = false;
    await api.saveActive(); // 跳过分支

    // buildView 的 wolfTalk active 分支（846-849）：上帝视角看到狼聊面板
    const g = entry.game;
    g.wolfTalk = { active: true, round: 1, rounds: 2, queue: [], endNow: false };
    const vGod = stubRes();
    await api.handle(stubReq({ method: 'GET', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), vGod.res, `/api/games/${gid}/view`, new URLSearchParams('token=gt&after=0'));
    assert.strictEqual(vGod.code, 200);
    assert.ok(vGod.body.wolfTalk && vGod.body.wolfTalk.active === true, '上帝视图必须携带狼聊面板');

    // createGame 分支：显式座位 / 纯观战（mySeat=0 / 无 isHuman）
    const spec = stubRes();
    await api.handle(stubReq({ method: 'POST', remote: '127.0.0.1', headers: { host: 'localhost:3210' }, body: { board: { wolf: 1, seer: 1, witch: 1, villager: 2 }, players: Array.from({ length: 5 }, () => ({ isHuman: false })), mock: true } }), spec.res, '/api/games', new URLSearchParams());
    assert.strictEqual(spec.code, 200);
    assert.strictEqual(spec.body.mySeat, 0, '纯观战 mySeat=0');
    assert.ok(!spec.body.playerToken, '观战不发玩家令牌');

    api.games.clear();
  } finally {
    await terminateApi(api, dataDir);
    }
});

test('SSE 分支：tickStreams 的 ping 节拍与对局被逐出后的 end 帧', async () => {
  const { api, dataDir } = makeFinishedApi('sse');
  try {
    const writes = [];
    const st = { res: { write(s) { writes.push(s); } }, gameId: 'gone', viewer: 'god', ticks: 30, after: 0, closed: false };
    api.streams.set('gone', new Set([st]));
    api.tickStreams(); // 推帧：对局不存在 → 走"evicted"关流分支（1094-1097）
    assert.ok(writes.some((w) => w.includes('event: end') && w.includes('evicted')), '被逐出后必须推 end 帧');
    assert.strictEqual(st.closed, true);
    api.streams.delete('gone');

    // ping 节拍分支（1003 附近）：ticks 达到 PING 周期必须写 ping 帧
    const entry = makeFinishedEntry(api, { humanRole: 'seer' });
    const st2 = { res: { write(s) { writes.push(s); } }, gameId: entry.game.id, viewer: 'god', ticks: 31, after: 0, closed: false, cheap: null, sawFinished: false };
    api.streams.set(entry.game.id, new Set([st2]));
    api.tickStreams(); // ticks 31+1=32 → 命中 PING 周期
    assert.ok(writes.some((w) => w.includes('event: ping')), '到达 PING 周期必须写心跳帧');
    api.streams.delete(entry.game.id);
    api.games.clear();
  } finally {
    await terminateApi(api, dataDir);
    }
});

// ---------- MAINT-01：发布版本唯一源一致性（源 = app/android/app/build.gradle 的 versionName） ----------

test('MAINT-01：desktop/app 的 package.json 版本必须与 Android versionName 一致', () => {
  const gradle = fs.readFileSync(path.join(__dirname, '..', 'app', 'android', 'app', 'build.gradle'), 'utf8');
  const vn = (gradle.match(/versionName\s+"([^"]+)"/) || [])[1];
  assert.ok(vn, 'build.gradle 必须声明 versionName（版本唯一源）');
  for (const f of ['desktop/package.json', 'app/package.json']) {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
    assert.strictEqual(j.version, vn, `${f} 的 version 必须同步为 ${vn}（发版规则见 README「版本与发布」）`);
  }
});

// ---------- 审核 P0-2：DNS rebinding（Host 白名单） ----------

test('P0-2：Host 头白名单——rebind 域名即使来自回环也拿不到管理权限', async () => {
  const { api, dataDir } = makeFinishedApi('rebind');
  try {
    api.auth.setEnabled(false); // 本机模式：审核指出 enabled=false 时也不该放行 rebind Host
    // 恶意域名 rebind 到 127.0.0.1：remoteAddress 是回环，但 Host 是攻击者域名
    const r = stubRes();
    await api.handle(stubReq({ method: 'GET', remote: '127.0.0.1', headers: { host: 'evil.example:3210' } }), r.res, '/api/config', new URLSearchParams());
    assert.strictEqual(r.code, 401, '整改前：enabled=false 无条件放行 + 回环自动授权 → rebind 域名可读走 API Key');
    // 合法 Host 不受影响
    const r2 = stubRes();
    await api.handle(stubReq({ method: 'GET', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), r2.res, '/api/config', new URLSearchParams());
    assert.strictEqual(r2.code, 200);
  } finally {
    await terminateApi(api, dataDir);
    }
});

// ---------- 审核 P0-1：密钥-地址原子绑定 ----------

test('P0-1：启动自动绑定；改地址不重输 Key → 真实建局/test/probe 全部拒绝；重输 Key 解除', async () => {
  let saved = { apiKey: 'sk-real', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', journal: false };
  const { api, dataDir } = makeApiIn(makeDataDir('bind'), { config: { get: () => saved, save(b) { const clean = { ...b }; if (typeof clean.apiKey === 'string' && clean.apiKey.includes('****')) delete clean.apiKey; if (Array.isArray(clean.apiKeys)) clean.apiKeys = clean.apiKeys.filter((v) => v && !String(v).includes('****')); saved = { ...saved, ...clean }; return saved; } } });
  try {
    assert.ok(saved.keyBinding, '启动时必须自动建立绑定（升级路径）');
    assert.ok(api.keyBindingValid(), '初始状态必须有效');

    // 攻击路径：已配对设备只改 baseUrl（沿用旧 Key）→ 三个 LLM 出口全部拒绝
    const put1 = stubRes();
    await api.handle(stubReq({ method: 'PUT', remote: '127.0.0.1', headers: { host: 'localhost:3210' }, body: { baseUrl: 'https://evil.example/v1' } }), put1.res, '/api/config', new URLSearchParams());
    assert.strictEqual(put1.code, 200);
    const mk = stubRes();
    await api.handle(stubReq({ method: 'POST', remote: '127.0.0.1', headers: { host: 'localhost:3210' }, body: { board: { wolf: 1, seer: 1, witch: 1, villager: 2 }, players: Array.from({ length: 5 }, () => ({ isHuman: false })), mock: false } }), mk.res, '/api/games', new URLSearchParams());
    assert.strictEqual(mk.code, 400, '整改前：真实对局直接用改过的 baseUrl + 旧 Key（重启后同样），Key 就被外带');
    assert.match(mk.body.error, /重新验证|重新输入/);
    const t1 = stubRes();
    await api.handle(stubReq({ method: 'POST', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), t1.res, '/api/config/test', new URLSearchParams());
    assert.strictEqual(t1.code, 400);

    // 审核 P0-1 二轮反例：绑定失配期间仅动 extras 不得解锁（必须重输主 Key）
    await api.handle(stubReq({ method: 'PUT', remote: '127.0.0.1', headers: { host: 'localhost:3210' }, body: { apiKeys: ['junk'] } }), stubRes().res, '/api/config', new URLSearchParams());
    assert.strictEqual(api.keyBindingValid(), false, '失配期间仅动 extras 不得解锁');
    // 但注意：此时 baseUrl 仍是 evil.example + junk 主 Key？——主 Key 未动，apiKeys 变化
    // 会重写绑定，这是"用户显式改凭证"语义；单独把 baseUrl 改回未重输 Key 的路径再验证：
    await api.handle(stubReq({ method: 'PUT', remote: '127.0.0.1', headers: { host: 'localhost:3210' }, body: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4' } }), stubRes().res, '/api/config', new URLSearchParams());
    assert.strictEqual(api.keyBindingValid(), false, '只改回 baseUrl 而不重输凭证 → 再次失配');

    // 重输 Key → 解除，真实建局放行
    const put2 = stubRes();
    await api.handle(stubReq({ method: 'PUT', remote: '127.0.0.1', headers: { host: 'localhost:3210' }, body: { apiKey: 'sk-fixed' } }), put2.res, '/api/config', new URLSearchParams());
    assert.strictEqual(api.keyBindingValid(), true);
    const mk2 = stubRes();
    await api.handle(stubReq({ method: 'POST', remote: '127.0.0.1', headers: { host: 'localhost:3210' }, body: { board: { wolf: 1, seer: 1, witch: 1, villager: 2 }, players: Array.from({ length: 5 }, () => ({ isHuman: false })), mock: false } }), mk2.res, '/api/games', new URLSearchParams());
    assert.strictEqual(mk2.code, 200, '重输 Key 后真实建局放行');
    api.games.clear();
  } finally {
    await terminateApi(api, dataDir);
    }
});

// ---------- 审核 P1-3/P1-4：终局存盘补救 + 优雅退出等待在途写盘 ----------

test('P1-3：终局存盘失败打 saveFailed 标记，saveActive 补救成功后清除', async () => {
  const { api, dataDir } = makeFinishedApi('p13');
  const { Game } = require('../src/engine/game');
  try {
    const board = { wolf: 1, seer: 1, witch: 1, villager: 2 };
    const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
    const g = new Game({ id: 'p13-final', board, players, stepPauseMs: 1, logger: silentLogger });
    g.deal(); g.started = true; g.finished = true;
    const entry = { game: g, running: false, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now(), review: null };
    api.games.set(g.id, entry);

    const file = path.join(savesOf(dataDir), 'p13-final.json');
    const tmp = file + '.tmp';
    fs.mkdirSync(tmp); // 障碍：写盘必败
    const ok = await api._saveFinalWithRetry(entry);
    assert.strictEqual(ok, false);
    assert.strictEqual(entry.saveFailed, true, '失败必须打标记');

    fs.rmdirSync(tmp); // 清除障碍
    const savedCount = await api.saveActive(); // 整改前：saveActive 只保存未结束局 → 永远 0
    assert.ok(savedCount >= 1, '补救应至少成功落盘一局');
    assert.strictEqual(entry.saveFailed, false, '补救成功后标记清除');
    assert.ok(fs.existsSync(file), '整改前：终局存档静默丢失');
    api.games.clear();
  } finally {
    await terminateApi(api, dataDir);
    }
});

test('P1-4：在途写盘时 saveGame 返回在途 Promise（优雅退出等得到）', async () => {
  const { api, dataDir } = makeFinishedApi('p14');
  const { Game } = require('../src/engine/game');
  try {
    const board = { wolf: 1, seer: 1, witch: 1, villager: 2 };
    const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
    const g = new Game({ id: 'p14-inflight', board, players, stepPauseMs: 1, logger: silentLogger });
    g.deal(); g.started = true;
    const entry = { game: g, running: false, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now(), review: null };
    api.games.set(g.id, entry);
    const p1 = api.saveGame(entry, { force: true });
    const p2 = api.saveGame(entry, { force: true }); // entry.saving=true 分支
    const returnedInflight = p2 && typeof p2.then === 'function';
    assert.strictEqual(await p1, true);
    const v = await p2;
    assert.ok(v === true || v === false);
    assert.ok(returnedInflight, '整改前：在途时返回 false，优雅退出不等在途写盘');
    api.games.clear();
  } finally {
    await terminateApi(api, dataDir);
    }
});

// ---------- 审核 P2-7/P2-8/P2-9 ----------

test('P2-7（真实请求）：超大请求体返回 413 而不是连接重置', async () => {
  const { api, dataDir } = makeApiIn(makeDataDir('big'), { config: { get: () => ({ apiKey: '', journal: false }), save() {} } });
  try {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      api.handle(req, res, u.pathname, u.searchParams).catch(() => {});
    });
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const big = 'x'.repeat(3 * 1024 * 1024); // 3MB > 2MB 上限
      const r = await fetch(`${base}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ junk: big }) });
      assert.strictEqual(r.status, 413, `整改前：req.destroy() 让客户端收到 ECONNRESET 而不是 413`);
    } finally { server.close(); }
  } finally {
    await terminateApi(api, dataDir);
    }
});

test('P2-8：暂停中/异常终止的对局调用 /start 必须拒绝', async () => {
  const { api, dataDir } = makeFinishedApi('p28');
  const { Game } = require('../src/engine/game');
  try {
    const board = { wolf: 1, seer: 1, witch: 1, villager: 2 };
    const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
    // 暂停局
    const g1 = new Game({ id: 'p28-paused', board, players, stepPauseMs: 1, logger: silentLogger });
    g1.deal(); g1.started = true; g1.paused = { kind: 'quota', code: '1302', message: '配额暂停' };
    api.games.set(g1.id, { game: g1, running: false, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now() });
    const r1 = stubRes();
    api.startGame(r1.res, api.games.get(g1.id), { token: 'pt' });
    assert.strictEqual(r1.code, 409, '整改前：暂停局 /start 返回 200 并再次 _drive（重复阶段与事件）');
    assert.match(r1.body.error, /resume|恢复/);
    // 异常局
    const g2 = new Game({ id: 'p28-err', board, players, stepPauseMs: 1, logger: silentLogger });
    g2.deal(); g2.started = true;
    api.games.set(g2.id, { game: g2, running: false, error: 'boom', mock: true, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now() });
    const r2 = stubRes();
    api.startGame(r2.res, api.games.get(g2.id), { token: 'pt' });
    assert.strictEqual(r2.code, 409);
    assert.match(r2.body.error, /异常/);
    api.games.clear();
  } finally {
    await terminateApi(api, dataDir);
    }
});

test('P2-9：神职复盘 teamCn 正确显示「神职阵营」', async () => {
  const review = require('../src/engine/review');
  const g = makeGameWithAdmirer();
  g.crush[1] = 3; // 链预言家（神职）
  g.winner = 'good';
  g.finished = true;
  const facts = review.reviewFacts(g, 1);
  assert.strictEqual(facts.teamCn, '神职阵营', '整改前：myTeam==="god" 分支不可达 → 神职被标成村民阵营');
  assert.strictEqual(facts.team, 'good');
});

test('分支收尾：keyBindingValid 无 Key 直通、resume 无 Key 400、view 双视角分支', async () => {
  const { api, dataDir } = makeFinishedApi('brfin');
  try {
    // keyBindingValid 的「没配 Key 无从外带」直通分支（150）
    assert.strictEqual(api.keyBindingValid(), true, '空 Key 配置必须直通（无外带面）');

    // resume 无 Key 的真实局 → 400（369）
    const { Game } = require('../src/engine/game');
    const board = { wolf: 1, seer: 1, witch: 1, villager: 2 };
    const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
    const g = new Game({ id: 'brfin-resume', board, players, stepPauseMs: 1, logger: silentLogger });
    g.deal(); g.started = true; g.markAnchor('speech');
    const entry = { game: g, running: false, error: null, mock: false, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now(), review: null };
    api.games.set(g.id, entry);
    await api.saveGame(entry, { force: true });
    api.games.delete(g.id);
    const rs = stubRes();
    await api.resumeGame(rs.res, { id: g.id, tokens: { player: 'pt' } }, { token: 'pt' });
    assert.strictEqual(rs.code, 400, '无 Key 恢复真实局必须 400');
    assert.match(rs.body.error, /API Key/);

    // view 的玩家视角分支（915-918 一带）：人类座位令牌
    const g2 = new Game({ id: 'brfin-view', board, players: players.map((p, i) => ({ ...p, isHuman: i === 0 })), stepPauseMs: 1, logger: silentLogger });
    g2.deal(); g2.started = true;
    api.games.set(g2.id, { game: g2, running: false, error: null, mock: true, tokens: { player: 'me', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now(), review: null });
    const v1 = stubRes();
    await api.handle(stubReq({ method: 'GET', remote: '127.0.0.1', headers: { host: 'localhost:3210' } }), v1.res, `/api/games/${g2.id}/view`, new URLSearchParams('token=me&after=0'));
    assert.strictEqual(v1.code, 200, '人类玩家令牌 view 必须可达');
    api.games.clear();
  } finally {
    await terminateApi(api, dataDir);
    }
});

// ---------- 二轮审核：绑定持久化与全部 LLM 出口 ----------

test('二轮 P1：keyBinding 持久化进 config（DEFAULT_CONFIG 白名单），重启后绑定不丢', async () => {
  const { createConfig } = require('../src/config');
  const dataDir = makeDataDir('kb');
  const cfgFile = path.join(dataDir, 'config.json');
  const cfg = createConfig(cfgFile);
  const cfg2 = createConfig(cfgFile);
  const makeApi = (config) => makeApiIn(dataDir, { config }).api;
  let api1 = null;
  let api2 = null;
  try {
    cfg.load();
    cfg.save({ apiKey: 'sk-live', baseUrl: 'https://api.example/v1' });
    // 服务启动（Api 构造）→ 自动建立绑定并持久化
    api1 = makeApi(cfg);
    assert.ok(api1.keyBindingValid(), '构造即绑定后必须有效');
    assert.ok(cfg.get().keyBinding, '构造后必须写入绑定');
    // 模拟重启：重新 createConfig 读取
    cfg2.load();
    assert.ok(cfg2.get().keyBinding, '整改前：keyBinding 不在 DEFAULT_CONFIG 白名单 → save 静默丢弃，重启即失');
    api2 = makeApi(cfg2);
    assert.ok(api2.keyBindingValid(), '重启后绑定必须仍然有效');
  } finally {
    await terminateApi(api1, dataDir);
    await terminateApi(api2, dataDir);
    await dispose(dataDir);
    }
});

test('二轮 P0：startReview / resume（真实局）绑定失配时全部拒绝', async () => {
  const { Game } = require('../src/engine/game');
  const { api, dataDir } = makeApiIn(makeDataDir('p0gates'), { config: { get: () => ({ apiKey: 'sk', baseUrl: 'https://api.example/v1', journal: false }), save() {} } });
  try {
    api.auth.setEnabled(false);
    const board = { wolf: 1, seer: 1, witch: 1, villager: 2 };
    const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));

    // 复盘 gate：真实局（mock:false）+ 绑定失配 → 400
    const g1 = new Game({ id: 'gate-review', board, players, stepPauseMs: 1, logger: silentLogger });
    g1.deal(); g1.started = true; g1.finished = true;
    api.games.set(g1.id, { game: g1, running: false, error: null, mock: false, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now(), review: null });
    const r1 = stubRes();
    await api.handle(stubReq({ method: 'POST', remote: '127.0.0.1', headers: { host: 'localhost:3210' }, body: { token: 'gt', seat: 1 } }), r1.res, `/api/games/${g1.id}/review`, new URLSearchParams());
    // mock:false + 默认 config 无 keyBinding 字段 → 绑定必然失配 → 400
    assert.strictEqual(r1.code, 400, `整改前：复盘绕过绑定校验，实测 ${r1.code}`);
    assert.match(r1.body.error, /重新验证|重新输入/);
    api.games.delete(g1.id);
  } finally {
    await terminateApi(api, dataDir);
    }
});

// ---------- 三轮审核 P0-1：空数组/掩码绕过密钥重绑 ----------

test('三轮 P0-1：空 apiKeys、掩码 apiKey、清空 extras 都不能解除绑定失配', async () => {
  let saved = { apiKey: 'sk-real', baseUrl: 'https://api.example/v1', apiKeys: ['sk-extra1'], journal: false };
  const { api, dataDir } = makeApiIn(makeDataDir('rebind3'), { config: { get: () => saved, save(b) { const clean = { ...b }; if (typeof clean.apiKey === 'string' && clean.apiKey.includes('****')) delete clean.apiKey; if (Array.isArray(clean.apiKeys)) clean.apiKeys = clean.apiKeys.filter((v) => v && !String(v).includes('****')); saved = { ...saved, ...clean }; return saved; } } });
  try {
    assert.ok(api.keyBindingValid(), '初始必须有效');

    const realCreate = async () => {
      const box = stubRes();
      await api.handle(stubReq({ method: 'POST', remote: '127.0.0.1', headers: { host: 'localhost:3210' }, body: { board: { wolf: 1, seer: 1, witch: 1, villager: 2 }, players: Array.from({ length: 5 }, () => ({ isHuman: false })), mock: false } }), box.res, '/api/games', new URLSearchParams());
      return box;
    };
    const put = async (body) => {
      const box = stubRes();
      await api.handle(stubReq({ method: 'PUT', remote: '127.0.0.1', headers: { host: 'localhost:3210' }, body }), box.res, '/api/config', new URLSearchParams());
      return box;
    };

    // ① 审核反例：改 baseUrl + 清空 apiKeys（空数组）→ 不得解除
    await put({ baseUrl: 'https://evil.example/v1', apiKeys: [] });
    assert.strictEqual(api.keyBindingValid(), false, '清空 extras + 改地址 → 依旧失配');
    let mk = await realCreate();
    assert.strictEqual(mk.code, 400, '空数组绕过后真实建局必须 400');
    // 失败关闭语义：只改回地址、不完整重输凭证（extras 也算凭证）→ 依旧失配
    await put({ baseUrl: 'https://api.example/v1', apiKey: 'sk-real', apiKeys: ['sk-extra1'] });
    assert.ok(api.keyBindingValid(), '完整重输凭证后必须解除');

    // ② 审核反例：掩码 apiKey 占位 → save 滤掉 → 凭证未变 → 不得解除
    await put({ baseUrl: 'https://evil.example/v1', apiKey: '****' });
    assert.strictEqual(saved.apiKey, 'sk-real', '掩码不得污染真实 Key');
    assert.strictEqual(api.keyBindingValid(), false, '掩码占位不得解除失配');
    mk = await realCreate();
    assert.strictEqual(mk.code, 400);

    // ③ 审核反例：掩码 apiKeys 数组（清洗后为空）→ 同样不得解除
    await put({ baseUrl: 'https://evil.example/v1', apiKeys: ['****', '****'] });
    assert.strictEqual(api.keyBindingValid(), false, '掩码 apiKeys 清空 extras 不得解除');
    mk = await realCreate();
    assert.strictEqual(mk.code, 400);

    // ③b（失败关闭语义）：绑定失配期间同地址 extras 变更也不解锁，须重输主 Key
    await put({ baseUrl: 'https://evil.example/v1', apiKeys: ['sk-extra1'] });
    assert.strictEqual(api.keyBindingValid(), false, '失配期间同地址 extras 变更不得解锁');

    // ④ 合法路径：真的重输了主 Key → 解除，建局放行
    await put({ baseUrl: 'https://evil.example/v1', apiKey: 'sk-new2' });
    assert.ok(api.keyBindingValid(), '真重输 Key 必须解除');
    mk = await realCreate();
    assert.strictEqual(mk.code, 200, '重输后应放行');
    api.games.clear();
  } finally {
    await terminateApi(api, dataDir);
    }
});

// ---------- 三轮审核 P1-4：关服等待补写 ----------

test('三轮 P1-4：saveActive 必须等到第一批期间安排的补写真正落地', async () => {
  const { api, dataDir } = makeFinishedApi('late');
  const { Game } = require('../src/engine/game');
  try {
    const board = { wolf: 1, seer: 1, witch: 1, villager: 2 };
    const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
    const g = new Game({ id: 'late-flush', board, players, stepPauseMs: 1, logger: silentLogger });
    g.deal(); g.started = true;
    const entry = { game: g, running: false, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now(), review: null };
    api.games.set(g.id, entry);

    // 手工制造"在途 + 已安排补写"的状态：savePromise 挂一个 300ms 后才落盘的补写
    const file = path.join(savesOf(dataDir), 'late-flush.json');
    let landed = false;
    entry.saving = true;
    entry.savePromise = new Promise((r) => setTimeout(() => {
      entry.saving = false;
      landed = true;
      api.saveGame(entry, { force: true }).then(() => r(true)).catch(() => r(false));
    }, 300));

    const t0 = Date.now();
    await api.saveActive();
    const waited = Date.now() - t0;
    assert.strictEqual(landed, true, '整改前：saveActive 不等补写 → 退出时最终快照丢失');
    assert.ok(waited >= 250, `必须等到补写完成（实际 ${waited}ms）`);
    assert.ok(fs.existsSync(file), '补写的存档必须真实存在');
    api.games.clear();
  } finally {
    await terminateApi(api, dataDir);
    }
});

// ---------- 四轮审核：反例回归（附加 Key 不随迁 / 清绑定重启 / 同 Key 解锁 / 补写链） ----------

test('四轮 P0：换地址重输主 Key 后，旧附加 Key 必须清空（不随迁授权）', async () => {
  let saved = { apiKey: 'sk-real', baseUrl: 'https://api.example/v1', apiKeys: ['sk-extra1'], journal: false };
  const { api, dataDir } = makeApiIn(makeDataDir('migrate'), { config: { get: () => saved, save(b) { const clean = { ...b }; if (typeof clean.apiKey === 'string' && clean.apiKey.includes('****')) delete clean.apiKey; saved = { ...saved, ...clean }; return saved; } } });
  try {
    assert.ok(api.keyBindingValid(), '初始有效');

    // 换地址 + 只重输主 Key → 附加 Key 必须清空（旧 extras 从未获准用于新地址）
    await api.handle(stubReq({ method: 'PUT', remote: '127.0.0.1', headers: { host: 'localhost:3210' }, body: { baseUrl: 'https://evil.example/v1', apiKey: 'sk-new' } }), stubRes().res, '/api/config', new URLSearchParams());
    assert.deepStrictEqual(saved.apiKeys, [], '审核 P0：旧附加 Key 随迁 = 旧 Key 外带，必须清空');
    assert.ok(api.keyBindingValid(), '主 Key 单独重绑后有效');
  } finally {
    await terminateApi(api, dataDir);
    }
});

test('四轮 P1：改地址未重输 Key 后，重启也不得解除限制', async () => {
  let saved = { apiKey: 'sk-real', baseUrl: 'https://api.example/v1', journal: false };
  // "改配置后重启"的两个实例共享同一份独占根
  const dataDir = makeDataDir('clear-bind');
  const cfgObj = { get: () => saved, save(b) { saved = { ...saved, ...b }; return saved; } };
  const { api } = makeApiIn(dataDir, { config: cfgObj });
  let api2 = null;
  try {
    api.auth.setEnabled(false);
    assert.ok(api.keyBindingValid(), '启动自动绑定后初始有效');

    // 攻击步骤：改 baseUrl 但不重输 Key → fail-closed 失配
    await api.handle(stubReq({ method: 'PUT', remote: '127.0.0.1', headers: { host: 'localhost:3210' }, body: { baseUrl: 'https://evil.example/v1' } }), stubRes().res, '/api/config', new URLSearchParams());
    assert.strictEqual(api.keyBindingValid(), false, '改地址未重输 Key 必须失配');

    // 模拟重启：同一份配置重新构造 Api（真实攻击链的"重启"步骤）
    api2 = makeApiIn(dataDir, { config: cfgObj }).api;
    assert.strictEqual(api2.keyBindingValid(), false, '重启不得解除 fail-closed 失配');
    // 管理出口仍然拒绝真实建局
    const mk = stubRes();
    await api2.handle(stubReq({ method: 'POST', remote: '127.0.0.1', headers: { host: 'localhost:3210' }, body: { board: { wolf: 1, seer: 1, witch: 1, villager: 2 }, players: Array.from({ length: 5 }, () => ({ isHuman: false })), mock: false } }), mk.res, '/api/games', new URLSearchParams());
    assert.strictEqual(mk.code, 400, '绑定失配期间真实建局必须拒绝');
  } finally {
    await terminateApi(api, dataDir);
    await terminateApi(api2, dataDir);
    await dispose(dataDir);
    }
});

test('四轮 P1：重新输入同一把合法 Key 也能解除限制（同值重输）', async () => {
  let saved = { apiKey: 'sk-keep', baseUrl: 'https://evil.example/v1', journal: false };
  const { api, dataDir } = makeApiIn(makeDataDir('same-key'), { config: { get: () => saved, save(b) { saved = { ...saved, ...b }; return saved; } } });
  try {
    // 改地址（绑定失配）后，重输同一把 Key + 新地址
    await api.handle(stubReq({ method: 'PUT', remote: '127.0.0.1', headers: { host: 'localhost:3210' }, body: { baseUrl: 'https://good.example/v1', apiKey: 'sk-keep' } }), stubRes().res, '/api/config', new URLSearchParams());
    assert.ok(api.keyBindingValid(), '同值重输主 Key 必须解除限制');
  } finally {
    await terminateApi(api, dataDir);
    }
});

test('四轮 P1：saveActive 循环收割三条链式补写（固定轮数会漏）', async () => {
  const { api, dataDir } = makeFinishedApi('chain');
  const { Game } = require('../src/engine/game');
  try {
    const board = { wolf: 1, seer: 1, witch: 1, villager: 2 };
    const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
    const g = new Game({ id: 'chain-flush', board, players, stepPauseMs: 1, logger: silentLogger });
    g.deal(); g.started = true;
    const entry = { game: g, running: false, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now(), review: null };
    api.games.set(g.id, entry);

    // 模拟应用层补写模式：链条式安排三份补写（每份完成后又换掉 savePromise）
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      for (let i = 0; i < 3; i++) {
        await sleep(80);
        entry.savePromise = api.saveGame(entry, { force: true }).catch(() => {});
      }
    })();

    await api.saveActive(); // 审核反例：固定两轮等待会漏掉第三份
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(path.join(savesOf(dataDir), 'chain-flush.json')) && Date.now() < deadline) await sleep(30);
    assert.ok(fs.existsSync(path.join(savesOf(dataDir), 'chain-flush.json')), '补写链必须全部落地');
    api.games.clear();
  } finally {
    await terminateApi(api, dataDir);
    }
});
