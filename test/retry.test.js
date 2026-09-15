/**
 * retry.test.js — 连接与重试（P1-4）
 *
 * 改动前：每次请求都带 `Connection: close`（为规避"Windows 防火墙掐断复用连接"），
 *         于是**每次调用都要重新 TCP+TLS 握手**（实测 5 次串行调用 = 5 条连接）。
 * 改动后：默认复用连接（keep-alive），并给旧顾虑上了两道保险：
 *         ① `keepAlive:false` 可一键回到旧行为；② 复用连接失效时**不退避、立刻重试**。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const llm = require('../src/ai/llm');
const { chatCompletion } = llm;
const { LlmScheduler } = require('../src/ai/scheduler');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** 本地假服务商：统计建立的 TCP 连接数与每次请求所用的本地端口，并按 OpenAI 格式回一个最简响应 */
function startFakeProvider() {
  const state = { sockets: 0, connHeaders: [], ports: [], bodies: 0 };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      state.bodies++;
      state.connHeaders.push(req.headers.connection || '(无)');
      state.ports.push(req.socket.remotePort);
      state.lastBody = body; // 供用例检查实际发出的请求体（也避免 body 只被赋值不被读取）
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: '{"target":1}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }));
    });
  });
  srv.on('connection', () => { state.sockets++; });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      state,
      url: `http://127.0.0.1:${srv.address().port}/v1`,
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cfgBase = (url, extra = {}) => ({ baseUrl: url, apiKey: 'k', model: 'm', retries: 2, timeoutMs: 5000, ...extra });
const msgs = [{ role: 'user', content: 'hi' }];

// ---------- keep-alive：本次的核心验收 ----------
test('keep-alive：默认复用连接，6 次调用共用同一条 TCP（旧实现是 6 条）', async () => {
  const p = await startFakeProvider();
  try {
    const s = new LlmScheduler();
    for (let i = 0; i < 6; i++) {
      await chatCompletion(cfgBase(p.url), msgs, { scheduler: s, logger: silentLogger, stream: false });
      // 生产里相邻调用本就间隔数秒（单次调用耗时）；这里留一点间隔，模拟"上一次调用早已结束"
      if (i < 5) await sleep(20);
    }
    assert.strictEqual(p.state.bodies, 6);
    // 6 次请求全部落在同一个本地端口上 —— 这就是"复用连接、不再每轮 TCP+TLS 握手"的直接证据
    assert.strictEqual(new Set(p.state.ports).size, 1, `6 次调用应共用同一条连接，实际用了 ${new Set(p.state.ports).size} 条（端口 ${p.state.ports.join(',')}）`);
    // 全新进程里第一条连接由本次建立；若池中已有（同进程其他用例）则新建数为 0
    assert.ok(p.state.sockets <= 1, `最多只应新建 1 条连接，实际 ${p.state.sockets} 条`);
    assert.ok(p.state.connHeaders.every((h) => h !== 'close'), '不应再发 Connection: close');
  } finally { await p.close(); }
});

test('keep-alive：置 false 时回到旧行为（每次都发 Connection: close，每次新连接）', async () => {
  const p = await startFakeProvider();
  try {
    const s = new LlmScheduler();
    for (let i = 0; i < 3; i++) {
      await chatCompletion(cfgBase(p.url, { keepAlive: false }), msgs, { scheduler: s, logger: silentLogger, stream: false });
      if (i < 2) await sleep(20);
    }
    assert.strictEqual(p.state.bodies, 3);
    assert.ok(p.state.connHeaders.every((h) => h === 'close'), `应全部带 Connection: close，实际 ${JSON.stringify(p.state.connHeaders)}`);
    assert.strictEqual(new Set(p.state.ports).size, 3, `不复用时 3 次调用应用 3 条不同连接，实际 ${new Set(p.state.ports).size}`);
    assert.strictEqual(p.state.sockets, 3, `应新建 3 条连接，实际 ${p.state.sockets}`);
  } finally { await p.close(); }
});

// ---------- 退避：纯函数，可精确验证 ----------
test('退避：平方退避 + 抖动（0.7~1.3 倍），且随重试次数增长', () => {
  const lo = (a) => llm.backoffMs({ attempt: a, rand: () => 0 });
  const hi = (a) => llm.backoffMs({ attempt: a, rand: () => 1 });
  assert.strictEqual(lo(1), Math.round(800 * 1 * 0.7));
  assert.strictEqual(hi(1), Math.round(800 * 1 * 1.3));
  assert.strictEqual(lo(2), Math.round(3200 * 0.7));
  assert.strictEqual(hi(2), Math.round(3200 * 1.3));
  assert.ok(lo(3) > hi(2), '退避必须随次数增长（否则会形成持续高频重试）');
  // 抖动必须真的存在：同一 attempt 下不同随机值给出不同结果（避免多客户端退避同步撞点）
  const vals = new Set();
  for (let i = 0; i < 50; i++) vals.add(llm.backoffMs({ attempt: 2 }));
  assert.ok(vals.size > 20, `抖动不足：50 次只出现 ${vals.size} 种取值`);
  for (const v of vals) assert.ok(v >= 3200 * 0.7 - 1 && v <= 3200 * 1.3 + 1, `抖动越界：${v}`);
});

test('退避：服务商 Retry-After 优先，且上限 120s', () => {
  assert.strictEqual(llm.backoffMs({ attempt: 1, retryAfterMs: 5000, rand: () => 0 }), 5000, '应听服务商的');
  assert.strictEqual(llm.backoffMs({ attempt: 1, retryAfterMs: 999999 }), 120000, 'Retry-After 必须封顶，否则会被挂死');
  assert.strictEqual(llm.backoffMs({ attempt: 1, retryAfterMs: 0 }), 0, 'Retry-After: 0 → 立刻重试');
  assert.strictEqual(llm.backoffMs({ attempt: 3, noBackoff: true }), 0, 'noBackoff 一律不等待');
});

test('Retry-After 解析：秒数 / HTTP-date / 缺失 / 非法', () => {
  const h = (v) => ({ get: () => v });
  assert.strictEqual(llm.parseRetryAfter(h('2')), 2000);
  assert.strictEqual(llm.parseRetryAfter(h('0')), 0);
  assert.strictEqual(llm.parseRetryAfter(h(null)), null);
  assert.strictEqual(llm.parseRetryAfter(h('一会儿')), null);
  const future = new Date(Date.now() + 3000).toUTCString();
  const ms = llm.parseRetryAfter(h(future));
  assert.ok(ms > 1500 && ms <= 3000, `HTTP-date 应解析为剩余毫秒，实际 ${ms}`);
});

// ---------- 死连接：不退避、立刻重试（这是 keep-alive 的"保险"） ----------
test('死连接识别：ECONNRESET / EPIPE / UND_ERR_SOCKET（含嵌套 cause）识别为可立即重试', () => {
  const mk = (code, nested) => {
    const e = new TypeError('fetch failed');
    e.cause = nested ? { cause: { code } } : { code };
    return e;
  };
  for (const code of ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ERR_SOCKET_CLOSED']) {
    assert.strictEqual(llm.isStaleSocketError(mk(code)), true, `${code} 应识别为死连接`);
    assert.strictEqual(llm.isStaleSocketError(mk(code, true)), true, `${code}（嵌套一层）也应识别`);
  }
  for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'CERT_HAS_EXPIRED']) {
    assert.strictEqual(llm.isStaleSocketError(mk(code)), false, `${code} 不是"连接放死了"，应走正常退避`);
  }
  assert.strictEqual(llm.isStaleSocketError(new Error('普通错误')), false);
});

test('死连接：立即重试成功，不白等 0.8s 退避（旧实现会先 sleep 再重试）', async () => {
  const origFetch = global.fetch;
  llm.resetConnErrorStats();
  let calls = 0;
  const warns = [];
  global.fetch = async () => {
    calls++;
    if (calls === 1) {
      const e = new TypeError('fetch failed');
      e.cause = { code: 'ECONNRESET' }; // 复用连接在池子里放死了
      throw e;
    }
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"target":2}' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    };
  };
  try {
    const s = new LlmScheduler();
    const t0 = Date.now();
    const out = await chatCompletion(cfgBase('http://x'), msgs, {
      scheduler: s, logger: { ...silentLogger, warn: (m, msg) => warns.push(String(msg)) },
    });
    const elapsed = Date.now() - t0;
    assert.strictEqual(out.content, '{"target":2}');
    assert.strictEqual(calls, 2, '应立刻重试一次');
    assert.ok(elapsed < 500, `死连接重试不应退避等待，实际耗时 ${elapsed}ms（旧实现 ≥800ms）`);
    assert.strictEqual(llm.connErrorStats().count, 1, '应记入遥测');
    assert.ok(warns.some((w) => /复用连接已失效/.test(w) && /keep-alive/.test(w)), '应给出一条可操作的告警（提示可关闭 keep-alive）');
  } finally { global.fetch = origFetch; llm.resetConnErrorStats(); }
});

test('限流仍走退避：429 + Retry-After 必须真的等待（不能把死连接的处理套到限流上）', async () => {
  const origFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) {
      return {
        ok: false, status: 429,
        headers: { get: (k) => (k === 'retry-after' ? '0.3' : null) },
        text: async () => JSON.stringify({ error: { code: '1302', message: '速率限制' } }),
      };
    }
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"target":3}' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    };
  };
  try {
    const s = new LlmScheduler();
    const t0 = Date.now();
    const out = await chatCompletion(cfgBase('http://x'), msgs, { scheduler: s, logger: silentLogger });
    const elapsed = Date.now() - t0;
    assert.strictEqual(out.content, '{"target":3}');
    assert.ok(elapsed >= 250, `限流应尊重 Retry-After 等待，实际仅 ${elapsed}ms`);
    assert.strictEqual(llm.connErrorStats().count, 0, '限流不是死连接，不应计入连接错误');
  } finally { global.fetch = origFetch; }
});

// ---------- 配置 ----------
test('配置：keepAlive 默认 true，且旧配置迁移时会补上', () => {
  const { DEFAULT_CONFIG, migrateConfig, createConfig } = require('../src/config');
  assert.strictEqual(DEFAULT_CONFIG.keepAlive, true, '默认必须开（否则每次调用都白花一次握手）');
  const old = { maxTokens: 2000 };
  migrateConfig(old);
  assert.strictEqual(old.keepAlive, true, '老配置缺该字段时迁移应补默认值');
  const off = { keepAlive: false };
  migrateConfig(off);
  assert.strictEqual(off.keepAlive, false, '用户显式关闭必须被尊重');
  // 设置页能保存：config.save() 只接受 DEFAULT_CONFIG 里存在的键，keepAlive 必须在白名单内
  const os = require('os');
  const path = require('path');
  const file = path.join(os.tmpdir(), `ww-cfg-${Date.now()}.json`);
  try {
    const c = createConfig(file);
    c.load();
    c.save({ keepAlive: false });
    assert.strictEqual(c.get().keepAlive, false, 'keepAlive 必须能通过 config.save 持久化（否则设置页勾选无效）');
    const reread = createConfig(file).load().config;
    assert.strictEqual(reread.keepAlive, false, '重启后仍应保持用户的选择');
  } finally { require('fs').rmSync(file, { force: true }); }
});
