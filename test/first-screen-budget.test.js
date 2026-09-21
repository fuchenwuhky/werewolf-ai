/**
 * first-screen-budget.test.js — 粗粒度性能护栏（FIX-21）
 *
 * 验收报告的原话：「性能/时长类门槛：619 条测试中没有一条会因接口变慢或卡死而红」。
 * 本文件就补这一条 —— 但**刻意做得粗**：它要能在任何正常机器（含 CI 并行跑测试时的争用）上稳定通过，
 * 只在"数量级退化"时亮红。宁可漏报细小的性能回退，也不要变成随机 flaky 的噪音（flaky 的护栏
 * 最后一定会被人加 `--test-skip` 或者放宽到没意义）。
 *
 * ## 测的是什么
 *   ① 冷启动：`spawn node server.js`（独占临时数据目录）→ 端到端拿到首个 `GET /` 的 200。
 *      覆盖"进程启动 + 模块加载 + 数据目录初始化 + 首个静态页面的版本化改写"整条真实路径。
 *   ② 首屏外壳请求：起真实 HTTP 服务的 `serveStatic`，预热后连续请求 `/index.html` 与 `/m/index.html`，
 *      对**每一次**单独计时，取最小值与中位数。这条路径每次都要 statSync + 校验/重建 HTML 表示
 *      （`src/static.js` 的 `depsUnchanged()` 会读盘哈希被引用的 js/css）。
 *
 * ## 阈值与本机实测（Windows / Node v24.14.0 / 16 核）
 *   · 冷启动：实测 140 ms（两次取最小；`LOG_LEVEL=error` 下），默认日志级别时约 0.22 s；
 *     用 15 个满载进程制造 CPU 争用时最快要 299 ms。阈值 **8000 ms** ≈ 相对争用态 27 倍余量。
 *   · 暖路径单次 HTML 请求：实测 min 2.2~2.6 ms、p50 3.3 ms；争用态下 min 3.4 ms、p50 5.7 ms。
 *     阈值 **min < 50 ms、p50 < 200 ms** ≈ 相对争用态还有 14 倍余量。
 *   · 用「最小值」而不是平均值/最大值：调度抖动只会**加**时间，不会减，所以最小值反映的是
 *     代码本身的代价，对并行测试造成的 CPU 争用天然免疫（这一点是实测选阈值时验证过的）。
 *
 * ## 拦得住什么
 *   · 首屏路径上出现"每次请求都做一遍"的重活：全量读盘哈希整个 web/ 树（22 MB，量到约 +30 ms/次）、
 *     每次导航都读盘解析 `saves/` 全部存档、把 HTML 表示缓存整个去掉并放大成多个数量级的重建成本 ——
 *     这类退化会把单次请求推到 ≥ 50 ms（相对基线 ≥ 15~25 倍），于是 min 断言亮红；
 *   · 启动路径上出现阻塞式全盘扫描 / 同步网络等待 / 一次性加载解析大量数据（冷启动 → 数十秒）。
 *
 * ## 拦不住什么（如实标注边界）
 *   · **10 倍以内的退化基本拦不住**：本机基线只有几毫秒（暖路径）与 0.14 s（冷启动），为保证
 *     慢机器与并行争用下绝不假红，阈值留到了 15~27 倍；因此 2~5 倍、乃至 10 倍的性能回退
 *     都在阈值内，**不会红**；
 *   · 间歇性回退（比如每 5 次请求才有一次重活）：min/p50 都躲得过去；
 *   · 「基线本身也一起变慢」的情形（例如 fs 整体变慢、杀软全盘扫描）：不区分，属于环境噪声；
 *   · 真实浏览器的首屏体验（解析、布局、绘制、字体）：这里只覆盖服务端交付路径。
 *   换言之：这是"防猝死"的护栏，不是性能基准，也不替代 `npm run ui:check` 与真机验收。
 *   冷启动那条比暖路径那条更钝（绝对量太小，跨机器方差大），真正有牙齿的是暖路径那条。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { serveStatic, _resetHtmlCache } = require('../src/static');
const { makeDataDir, dispose } = require('./helpers-tmpdir');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');

/** 冷启动预算：本机实测约 0.14s（争用态 0.30s）。留给"慢机器 + 并行测试争用"约 27 倍余量 */
const COLD_START_BUDGET_MS = 8000;
/** 暖路径单次 HTML 请求：最快一次的上限（本机 2~4ms，阈值约 14~25 倍余量） */
const HTML_REQUEST_MIN_BUDGET_MS = 50;
/** 暖路径中位数上限：比 min 宽，用来兜住"一半请求变慢"（本机 3~6ms） */
const HTML_REQUEST_P50_BUDGET_MS = 200;
/** 冷启动最长等待：超过它就认定"起不来了"，直接失败而不是空转到测试超时 */
const COLD_START_GIVE_UP_MS = 60000;

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/** 停掉子进程并等它真的退出（SIGKILL：不要触发 server.js 优雅关闭里的 4s 落盘等待） */
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

/** 冷启动一次：返回 { ms, status }（ms = spawn 到首个页面 200 的墙钟时间） */
async function coldStartOnce() {
  const dataDir = makeDataDir('fix21-boot');
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    // 独占数据目录：不碰仓库里的 saves/、config.json、logs/（src/api.js 的 SAVE_DIR 也认 WW_DATA_DIR）
    env: { ...process.env, WW_DATA_DIR: dataDir, PORT: String(port), NO_OPEN: '1', LOG_LEVEL: 'error' },
    stdio: 'ignore',
  });
  child.on('error', () => {});
  const started = Date.now();
  let ms = -1;
  let status = 0;
  try {
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        await res.text();
        status = res.status;
        ms = Date.now() - started;
        break;
      } catch (_) { /* 还没起来，继续等 */ }
      if (Date.now() - started > COLD_START_GIVE_UP_MS) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await stop(child);
    await dispose(dataDir);
  }
  return { ms, status };
}

test('冷启动预算：node server.js 起到首个页面 200 不得超过 8s（拦启动期阻塞式扫描/网络等待）', async (t) => {
  const runs = [];
  for (let i = 0; i < 2; i++) runs.push(await coldStartOnce());
  for (const [i, r] of runs.entries()) {
    assert.strictEqual(r.status, 200, `第 ${i + 1} 次冷启动的首个页面响应必须是 200（实际 ${r.status}，耗时 ${r.ms}ms）`);
  }
  const best = Math.min(...runs.map((r) => r.ms));
  t.diagnostic(`冷启动实测（两次取最小）：${best}ms（预算 ${COLD_START_BUDGET_MS}ms）`);
  assert.ok(
    best < COLD_START_BUDGET_MS,
    `冷启动最快要 ${best}ms，超过 ${COLD_START_BUDGET_MS}ms 预算。` +
      '这通常意味着启动路径上出现了阻塞式全盘扫描、同步网络等待，或一次性加载/解析了大量数据。',
  );
});

test('首屏外壳请求预算：暖路径单次 HTML 请求（取最小值）不得超过 50ms（拦每次请求重活）', async (t) => {
  _resetHtmlCache();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    serveStatic(req, res, decodeURIComponent(url.pathname), { webDir: WEB });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const page of ['/index.html', '/m/index.html']) {
      // 预热一次：让 HTML 表示缓存进入"稳态"（真实用户的首屏也不是第一次请求那条路径）
      const warmup = await fetch(base + page);
      assert.strictEqual(warmup.status, 200, `${page} 预热请求必须 200（实际 ${warmup.status}）`);
      await warmup.arrayBuffer();

      const samples = [];
      for (let i = 0; i < 30; i++) {
        const t0 = process.hrtime.bigint();
        const res = await fetch(base + page);
        const body = await res.arrayBuffer();
        samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
        assert.strictEqual(res.status, 200, `${page} 第 ${i + 1} 次请求必须 200（实际 ${res.status}）`);
        assert.ok(body.byteLength > 1000, `${page} 响应体太小（${body.byteLength} 字节），计时没有意义`);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const best = sorted[0];
      const p50 = sorted[Math.floor(sorted.length / 2)];
      t.diagnostic(`${page} 暖路径单次耗时：min=${best.toFixed(1)}ms p50=${p50.toFixed(1)}ms（30 次）`);
      assert.ok(
        best < HTML_REQUEST_MIN_BUDGET_MS,
        `${page} 最快一次也要 ${best.toFixed(1)}ms，超过 ${HTML_REQUEST_MIN_BUDGET_MS}ms 预算。` +
          '首屏路径上大概率被塞进了"每次请求都做一遍"的重活（全量读盘哈希、读盘解析大量文件、同步扫描目录）。',
      );
      assert.ok(
        p50 < HTML_REQUEST_P50_BUDGET_MS,
        `${page} 中位耗时 ${p50.toFixed(1)}ms，超过 ${HTML_REQUEST_P50_BUDGET_MS}ms 预算（一半以上的请求都慢）。`,
      );
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    _resetHtmlCache();
  }
});
