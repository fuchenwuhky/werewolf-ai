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
const os = require('os');
const path = require('path');

const { createRequestHandler, decodePath } = require('../src/request-handler');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {} };

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ww-${tag}-`));
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
  const { Api } = require('../src/api');
  const { Game } = require('../src/engine/game');
  const { makeMockAgentFactory } = require('../scripts/mock-agent');
  const dir = tmpDir('rel02');
  const api = new Api({
    config: { get: () => ({ apiKey: 'k', journal: false }), save() {} },
    logger: silentLogger,
    saveDir: dir,
  });
  const board = { wolf: 1, seer: 1, witch: 1, villager: 2 };
  const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
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
  while (!g.finished && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(g.finished, 'Mock 局应能自然打完');
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
});

// ---------- REL-03：存盘失败必须可重试 ----------

test('REL-03：写盘失败时不推进 savedStamp（保持脏），障碍清除后下一次保存真正落盘', async () => {
  const { Api } = require('../src/api');
  const { Game } = require('../src/engine/game');
  const dir = tmpDir('rel03');
  const api = new Api({
    config: { get: () => ({ apiKey: 'k', journal: false }), save() {} },
    logger: silentLogger,
    saveDir: dir,
  });
  const board = { wolf: 1, seer: 1, witch: 1, villager: 2 };
  const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
  const g = new Game({ id: 'rel03-save', board, players, stepPauseMs: 1, logger: silentLogger });
  g.deal();
  g.started = true;
  const entry = { game: g, running: false, error: null, mock: true, tokens: { player: 'pt', god: 'gt' }, createdAt: Date.now(), lastAccess: Date.now() };
  api.games.set(g.id, entry);

  const file = path.join(dir, 'rel03-save.json');
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
  const { Api } = require('../src/api');
  const { Game } = require('../src/engine/game');
  const dir = tmpDir('sec01');
  const api = new Api({
    config: { get: () => ({ apiKey: 'k', journal: false }), save() {} },
    logger: silentLogger,
    saveDir: dir,
  });
  api.auth.setEnabled(true); // 模拟 WW_LAN=1

  // 远端（未配对）：配置 401、建局 401、列表 401、统计 401
  const deny = (pathname, method = 'GET', extra = {}) => {
    const box = stubRes();
    api.handle(stubReq({ method, remote: '192.168.1.5', headers: { host: '192.168.1.5:3210', ...extra }, body: method === 'POST' ? {} : null }), box.res, pathname, new URLSearchParams());
    return box;
  };
  await deny('/api/config'); // 顺序执行由 handle 内部 await 保证
  assert.strictEqual(deny && true, true);
  const r1 = await new Promise((res) => { const box = stubRes(); api.handle(stubReq({ method: 'GET', remote: '192.168.1.5', headers: { host: 'x' } }), box.res, '/api/config', new URLSearchParams()).then(() => res(box)); });
  assert.strictEqual(r1.code, 401, '未配对读配置必须 401（整改前：任何人拿到地址就能读走 API Key 明文）');
  const r2 = await new Promise((res) => { const box = stubRes(); api.handle(stubReq({ method: 'POST', remote: '192.168.1.5', headers: { host: 'x' } }, ), box.res, '/api/games', new URLSearchParams()).then(() => res(box)); });
  assert.strictEqual(r2.code, 401, '未配对创建对局必须 401（防资源滥用与不可控费用）');
  const r3 = await new Promise((res) => { const box = stubRes(); api.handle(stubReq({ method: 'GET', remote: '192.168.1.5', headers: { host: 'x' } }), box.res, '/api/stats', new URLSearchParams()).then(() => res(box)); });
  assert.strictEqual(r3.code, 401);

  // 配对码只发给本机；远端查询 pairing 拿不到码
  const rLocal = await new Promise((res) => { const box = stubRes(); api.handle(stubReq({ method: 'GET', remote: '127.0.0.1', headers: { host: 'x' } }), box.res, '/api/auth/pairing', new URLSearchParams()).then(() => res(box)); });
  assert.ok(/^\d{6}$/.test(rLocal.body.code), '本机能看到配对码');
  const rRemote = await new Promise((res) => { const box = stubRes(); api.handle(stubReq({ method: 'GET', remote: '192.168.1.5', headers: { host: 'x' } }), box.res, '/api/auth/pairing', new URLSearchParams()).then(() => res(box)); });
  assert.strictEqual(rRemote.body.code, null, '远端绝不能拿到配对码本体');

  // 远端用配对码换取会话 Cookie
  const code = rLocal.body.code;
  const rPair = await new Promise((res) => {
    const box = stubRes();
    const req = stubReq({ method: 'POST', remote: '192.168.1.5', headers: { host: 'x', origin: 'https://localhost' }, body: { code } });
    api.handle(req, box.res, '/api/auth/pair', new URLSearchParams()).then(() => res(box));
  });
  assert.strictEqual(rPair.code, 200, 'Capacitor 壳的 localhost origin 必须被信任');
  const cookie = rPair.headers['set-cookie'];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  // 带 Cookie 后管理接口放行
  const rCfg = await new Promise((res) => { const box = stubRes(); api.handle(stubReq({ method: 'GET', remote: '192.168.1.5', headers: { host: 'x', cookie } }), box.res, '/api/config', new URLSearchParams()).then(() => res(box)); });
  assert.strictEqual(rCfg.code, 200, '配对成功后配置可读');

  // 单局令牌通道不受影响：远端凭玩家令牌可看本局视图，但不能读全量令牌
  const board = { wolf: 1, seer: 1, witch: 1, villager: 2 };
  const players = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, isHuman: i === 0 }));
  const g = new Game({ id: 'sec01-game', board, players, stepPauseMs: 1, logger: silentLogger });
  g.deal(); g.started = true;
  api.games.set(g.id, { game: g, running: false, error: null, mock: true, tokens: { player: 'ptok', god: 'gtok' }, createdAt: Date.now(), lastAccess: Date.now() });
  const rView = await new Promise((res) => { const box = stubRes(); api.handle(stubReq({ method: 'GET', remote: '192.168.1.5', headers: { host: 'x' } }), box.res, '/api/games/sec01-game/view', new URLSearchParams('token=ptok&after=0')).then(() => res(box)); });
  assert.strictEqual(rView.code, 200, '玩家令牌通道（LAN 上的 APP）必须保持可用');
  const rTokens = await new Promise((res) => { const box = stubRes(); api.handle(stubReq({ method: 'GET', remote: '192.168.1.5', headers: { host: 'x' } }), box.res, '/api/games/sec01-game/tokens', new URLSearchParams('token=ptok')).then(() => res(box)); });
  assert.strictEqual(rTokens.code, 401, '全量令牌属于管理信息：即便持有玩家令牌也必须 401');
  api.games.delete(g.id);
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
