/**
 * keepalive-bench.js — 连接复用（P1-4）的可复现测量。
 *
 * 用法： node scripts/keepalive-bench.js
 *
 * 测三件事：
 *  1. 本地假服务商上的 TCP 连接数：发 `Connection: close`（旧行为）vs 不发（默认 keep-alive）
 *  2. 真实端点上"新建连接"与"复用连接"的耗时差（用 HEAD /，不需要 API Key，不消耗额度）
 *  3. 真实对局日志里相邻两次 LLM 调用的空闲间隔分布 —— 决定 keep-alive 到底覆盖多少比例的调用
 */
'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const TICK = 4000; // undici 默认 keepAliveTimeout

async function benchLocal() {
  let sockets = 0;
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  srv.on('connection', () => { sockets++; });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/x`;
  const hit = (close) => fetch(url, {
    method: 'POST',
    headers: close ? { 'Content-Type': 'application/json', Connection: 'close' } : { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const N = 6;
  sockets = 0;
  for (let i = 0; i < N; i++) { await hit(true); await new Promise((r) => setTimeout(r, 30)); }
  const withClose = sockets;
  sockets = 0;
  for (let i = 0; i < N; i++) { await hit(false); await new Promise((r) => setTimeout(r, 30)); }
  const noClose = sockets;
  await new Promise((r) => srv.close(r));
  return { N, withClose, noClose };
}

function timeoutOf(host) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let tcp = null;
    const req = https.request({ host, port: 443, path: '/', method: 'HEAD', timeout: 15000, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve({ total: Date.now() - t0, tcp, status: res.statusCode }));
    });
    req.on('socket', (s) => { s.on('connect', () => { tcp = Date.now() - t0; }); });
    req.on('error', (e) => resolve({ err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ err: 'timeout' }); });
    req.end();
  });
}

async function benchRemote() {
  // 端点从 config.json 里读（只取 host，不读/不打印 apiKey）
  let host = 'open.bigmodel.cn';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    if (cfg.baseUrl) host = String(cfg.baseUrl).replace(/^https?:\/\//, '').split('/')[0];
  } catch (_) { /* 用默认值 */ }
  const cold = [];
  for (let i = 0; i < 4; i++) cold.push(await timeoutOf(host)); // agent:false → 每次强制新建连接
  return { host, cold };
}

function gapStats() {
  const DIR = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(DIR)) return null;
  const gaps = [];
  for (const f of fs.readdirSync(DIR).filter((x) => x.startsWith('game-') && x.endsWith('.log'))) {
    const calls = [];
    for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      let j;
      try { j = JSON.parse(line); } catch (_) { continue; }
      if (j.module !== 'llm' || !j.data || !j.data.task) continue;
      const m = /ok \d+pt\(缓存\d+\)\/\d+ct (\d+)ms/.exec(j.msg || '');
      const ts = new Date(j.ts || j.time || 0).getTime();
      if (ts && m) calls.push({ ts, ms: +m[1] });
    }
    calls.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < calls.length; i++) gaps.push((calls[i].ts - calls[i].ms) - calls[i - 1].ts);
  }
  return gaps.filter((g) => g > -5000);
}

(async () => {
  console.log('=== 1. 本地：keep-alive 对连接数的影响 ===');
  const local = await benchLocal();
  console.log(`  ${local.N} 次串行调用（间隔 30ms）`);
  console.log(`    旧行为（Connection: close）: ${local.withClose} 条连接`);
  console.log(`    默认（keep-alive）        : ${local.noClose} 条连接`);

  console.log('\n=== 2. 真实端点：全新连接的握手成本 ===');
  const remote = await benchRemote();
  const ok = remote.cold.filter((r) => !r.err);
  if (ok.length) {
    const totals = ok.map((r) => r.total).sort((a, b) => a - b);
    const med = totals[Math.floor(totals.length / 2)];
    console.log(`  ${remote.host}:443（HEAD /，无 API Key，不消耗额度）`);
    for (const r of remote.cold) console.log(`    ${r.err ? '失败: ' + r.err : `TCP ${r.tcp}ms → 完成 ${r.total}ms (HTTP ${r.status})`}`);
    console.log(`  中位：新建连接 ${med}ms（复用连接时这部分全省掉）`);
  } else {
    console.log(`  ${remote.host} 不可达（离线环境），跳过：${remote.cold[0] && remote.cold[0].err}`);
  }

  console.log('\n=== 3. 真实语料：调用间隔分布（决定 keep-alive 覆盖多少调用）===');
  const gaps = gapStats();
  if (!gaps || !gaps.length) {
    console.log('  没有可用的对局日志，跳过');
  } else {
    const s = gaps.slice().sort((a, b) => a - b);
    const q = (p) => s[Math.floor(p * (s.length - 1))];
    const under = (t) => 100 * gaps.filter((g) => g < t).length / gaps.length;
    console.log(`  样本 n=${gaps.length}（同局内相邻两次调用之间 socket 的空闲时间）`);
    console.log(`  p25=${q(0.25)}ms  中位=${q(0.5)}ms  p75=${q(0.75)}ms  p90=${q(0.9)}ms`);
    console.log(`  < ${TICK}ms（undici 默认 keepAliveTimeout 内 → 可复用）: ${under(TICK).toFixed(1)}%`);
    const med = ok.length ? ok.map((r) => r.total).sort((a, b) => a - b)[Math.floor(ok.length / 2)] : 90;
    console.log(`\n  按"新建连接 ${med}ms"折算：每局可省 ≈ ${(gaps.length / 18 * under(TICK) / 100 * med / 1000).toFixed(1)}s（18 局样本，平均每局 ${(gaps.length / 18).toFixed(0)} 次调用）`);
  }
})();
