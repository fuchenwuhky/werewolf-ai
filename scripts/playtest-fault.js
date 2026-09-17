#!/usr/bin/env node
/**
 * playtest-fault.js — P1 故障注入跑器（零成本、确定性）。
 *
 * 做什么：起一个指向**本地假 LLM** 的应用实例（独立端口 + 独立数据目录 + WW_CONFIG 指向假配置），
 * 逐个别例注入故障、跑真对局、断言应用的行为是否符合预期。
 *
 * 为什么不让真 API 来测这些：E1（预算用尽后的轻量补救）、E3（快速任务超时降档）、配额暂停、
 * 校验失败重试 —— 全都依赖服务端侧异常。真 API 复现靠运气且花钱，这里一条命令精确注入。
 *
 * 边界（诚实说明）：浏览器侧的现象（看门狗误判、降级横幅、30s 自动重连）在这里**测不到**，
 * 它们由 scripts/playtest.js 在真实浏览器里覆盖（P4）。本跑器只看 API 层与日志。
 *
 * 用法：
 *   node scripts/playtest-fault.js              # 跑全部例
 *   node scripts/playtest-fault.js --only=quota429
 *   node scripts/playtest-fault.js --keep       # 跑完不删数据目录（排查用）
 *
 * 前置：假 LLM 未启动时本脚本会自己起一个（端口 3212），结束时一起收掉。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP_PORT = Number(process.env.P1_PORT || 3213);
const FAKE_PORT = Number(process.env.FAKE_PORT || 3212);
const DATA_DIR = path.join(os.tmpdir(), 'ww-playtest-fake');
const FAKE_CONFIG = path.join(os.tmpdir(), 'ww-playtest', 'config.fake.json');
const BASE = `http://127.0.0.1:${APP_PORT}`;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const keep = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let capEnded = false; // 本局是否因"调用次数护栏"被中止（见 resumeIfPaused）
const children = [];

// ---------- 基础设施 ----------
async function ensureFake() {
  try { await fetch(`${FAKE}/__ping`, { signal: AbortSignal.timeout(1500) }); return false; } catch (_) { /* 需要自起 */ }
  const p = spawn(process.execPath, [path.join(ROOT, 'scripts', 'fake-llm.js'), `--port=${FAKE_PORT}`], { stdio: 'ignore' });
  children.push(p);
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try { await fetch(`${FAKE}/__ping`, { signal: AbortSignal.timeout(1000) }); return true; } catch (_) { /* 再等 */ }
  }
  throw new Error('假 LLM 起不来');
}

function startApp() {
  fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
  // 假配置：端点指向假 LLM。写文件时用 Node 而不是 PowerShell —— 后者加 BOM，
  // 正好踩中刚修的 bug（这份配置从进程层面替代正式 config.json）
  fs.writeFileSync(FAKE_CONFIG, JSON.stringify({
    baseUrl: `${FAKE}/v1`, apiKey: 'sk-fake', model: 'fake-model', journal: false,
    reasoningEffort: 'medium', maxTokens: 8000, fastEffort: 'low', pace: 'standard',
  }, null, 2), 'utf8');
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), NO_OPEN: '1', WW_DATA_DIR: DATA_DIR, WW_CONFIG: FAKE_CONFIG },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(p);
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  return p;
}

async function waitApp() {
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const r = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return await r.json();
    } catch (_) { /* 再等 */ }
  }
  throw new Error(`实例起不来（${BASE}）`);
}

async function setMode(mode, delayMs) {
  const r = await fetch(`${FAKE}/__mode`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(delayMs ? { mode, delayMs } : { mode }),
  });
  if (!r.ok) throw new Error(`切模式失败：${await r.text()}`);
}

async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch (_) { /* 允许空响应 */ }
  return { code: r.status, body: j };
}

/** 造一局全 AI 的**真**对局（mock:false → 会真的走假 LLM）并启动 */
async function startGame(seed) {
  const players = Array.from({ length: 12 }, (_, k) => ({ name: `P${k + 1}`, isHuman: false }));
  const created = await api('POST', '/api/games', { boardId: 'adv12', mock: false, seed, players });
  if (created.code !== 200) throw new Error(`创建对局失败：${JSON.stringify(created.body)}`);
  const { gameId, godToken } = created.body;
  const started = await api('POST', `/api/games/${gameId}/start`, { token: godToken });
  if (started.code !== 200) throw new Error(`启动失败：${JSON.stringify(started.body)}`);
  return { gameId, godToken };
}

async function view(gameId, godToken, after = 0) {
  const r = await api('GET', `/api/games/${gameId}/view?token=${godToken}&after=${after}`);
  return r.body || {};
}

/** 推进指标：view 不暴露 game.seq，用事件流最后一个 seq。
 *  注意：从锚点重建后事件序号会**回退**（重新从锚点开始发），所以必须叠加天数/阶段，
 *  否则"恢复成功但序号回退"会被误判成"没有推进"（P1-7 实测踩到）。 */
function progress(v) {
  const ev = v.events || [];
  const seq = ev.length ? ev[ev.length - 1].seq : 0;
  const phaseRank = { night: 1, day: 2, vote: 3, over: 4 }[v.phase] || 0;
  return (v.day || 0) * 1e9 + phaseRank * 1e8 + seq;
}

/**
 * 故障窗口结束后，对局可能处于暂停态（配额或"调用次数上限"护栏触发），
 * 必须先恢复再断言"对局能继续推进" —— 否则测的是暂停而不是恢复。
 * 若暂停原因是 overuse，顺手记一条：这就是调用次数护栏在起作用的直接证据。
 */
async function resumeIfPaused(gameId, godToken) {
  const v = await view(gameId, godToken);
  // 护栏触发时对局是**结算**掉的（不是暂停）：记为一条显式验证，并让调用方跳过"继续推进"断言
  if (v.finished && /调用次数/.test(String(v.winReason || ''))) {
    capEnded = true;
    record('P1 调用次数护栏生效（疑似僵持/模型异常时按次兜底后结算本局）', true, `winReason=${String(v.winReason).slice(0, 70)}`);
    return v.paused || null;
  }
  if (!v.paused) return null;
  const info = v.paused;
  await api('POST', `/api/games/${gameId}/resume`, { token: godToken });
  await until(gameId, godToken, (x) => !x.paused, 15000);
  if (info.kind === 'overuse') {
    record('P1 调用次数护栏生效（疑似僵持/模型异常时按次兜底）', true, `kind=${info.kind} code=${info.code || '-'} msg=${String(info.message).slice(0, 60)}`);
  }
  return info;
}

function logOf(gameId) {
  try { return fs.readFileSync(path.join(DATA_DIR, 'logs', `game-${gameId}.log`), 'utf8'); } catch (_) { return ''; }
}

/** 轮询直到条件成立或超时 */
async function until(gameId, godToken, predicate, ms = 25000, step = 400) {
  const t0 = Date.now();
  let v = {};
  while (Date.now() - t0 < ms) {
    v = await view(gameId, godToken);
    if (predicate(v)) return { ok: true, v, waited: Date.now() - t0 };
    if (v.finished) return { ok: false, v, waited: Date.now() - t0 };
    await sleep(step);
  }
  return { ok: false, v, waited: Date.now() - t0 };
}

function record(name, ok, detail) {
  results.push({ name, ok, detail: String(detail || '').slice(0, 200) });
  process.stdout.write(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + String(detail).slice(0, 160) : ''}\n`);
}

// ---------- 各例 ----------
const CASES = {
  /** 配额耗尽（HTTP 429 + 业务码 1113）→ 必须暂停对局，且恢复后能续跑 */
  async quota429() {
    await setMode('quota429');
    const { gameId, godToken } = await startGame(101);
    const r = await until(gameId, godToken, (v) => !!v.paused, 20000);
    const code = r.v.paused && r.v.paused.code;
    record('P1-1 配额耗尽 → 暂停对局并明示', r.ok && String(code) === '1113', `paused.code=${code} message=${(r.v.paused && r.v.paused.message) || '-'}`);
    record('P1-1 暂停的对局不得结算（可恢复）', r.v.finished === false, `finished=${r.v.finished}`);
    // 恢复：切回 ok 再调 resume，对局应继续推进
    await setMode('ok');
    // /resume 分派：内存里且已暂停 → resumePaused（需要令牌）；不在内存 → 从锚点恢复
    const resumed = await api('POST', `/api/games/${gameId}/resume`, { token: godToken });
    const after = await until(gameId, godToken, (v) => !v.paused && progress(v) > progress(r.v), 25000);
    record('P1-1 恢复后能从断点续跑', resumed.code === 200 && after.ok, `resume=${resumed.code} 事件游标 ${progress(r.v)}→${progress(after.v)} paused=${after.v.paused ? 'still' : 'cleared'}`);
    return gameId;
  },

  /** 同样的配额错误塞在 HTTP 200 的响应体里 → 也必须识别（服务商真的这么干过） */
  async quota200() {
    await setMode('quota200');
    const { gameId, godToken } = await startGame(102);
    const r = await until(gameId, godToken, (v) => !!v.paused, 20000);
    record('P1-2 200 里塞业务码 1308 → 照样暂停', r.ok && String(r.v.paused && r.v.paused.code) === '1308', `paused=${JSON.stringify(r.v.paused || null).slice(0, 90)}`);
    return gameId;
  },

  /** 慢整体：快速任务 30s 超时 → 降档重试（E3 机制），不得卡死 */
  async slowTotal() {
    await setMode('slow-total');
    const { gameId, godToken } = await startGame(103);
    const r = await until(gameId, godToken, () => false, 30000);
    const log = logOf(gameId);
    const timedOut = /超时|timeout|降档|effort/.test(log);
    record('P1-3 慢响应：不卡死（有推进或明确降级）', progress(r.v) > 0 || timedOut, `事件游标=${progress(r.v)} 超时/降级痕迹=${timedOut}`);
    await setMode('ok');
    return gameId;
  },

  /** 截断 JSON → 校验失败 → 带提示重试；切回 ok 后必须恢复 */
  async truncatedJson() {
    await setMode('truncated-json');
    const { gameId, godToken } = await startGame(104);
    await until(gameId, godToken, () => false, 12000);
    const log1 = logOf(gameId);
    const failed = /无法从回复中解析 JSON|校验/.test(log1);
    // 重试痕迹：askValidated 每次遇到非法输出记一条"输出不合法"，随后带提示重问；
    // llm 层的"尝试N"是**传输层**重试，与校验层重试不是一回事（这里要看后者）。
    const invalid = (log1.match(/输出不合法/g) || []).length;
    const degraded = /多次输出不合法|使用降级方案/.test(log1);
    record('P1-4 截断 JSON → 触发校验失败', failed, `日志命中=${failed}`);
    record('P1-4 校验失败 → 带提示重试并落降级痕', invalid >= 1 && degraded, `输出不合法=${invalid} 降级=${degraded}`);
    await setMode('ok');
    await resumeIfPaused(gameId, godToken);
    const before = progress(await view(gameId, godToken));
    const after = await until(gameId, godToken, (v) => progress(v) > before + 2, 25000);
    record('P1-4 恢复正常后对局继续推进', after.ok || capEnded, `事件游标 ${before}→${progress(after.v)}`);
    return gameId;
  },

  /** 非法 JSON / 空回复：同一类路径，确认不会死循环 */
  async badJson() {
    await setMode('bad-json');
    const { gameId, godToken } = await startGame(105);
    await until(gameId, godToken, () => false, 10000);
    await setMode('ok');
    await resumeIfPaused(gameId, godToken);
    const before = progress(await view(gameId, godToken));
    const after = await until(gameId, godToken, (v) => progress(v) > before, 25000);
    record('P1-5 非法 JSON 后仍能继续（不死循环）', after.ok || capEnded, `事件游标 ${before}→${progress(after.v)}`);
    return gameId;
  },

  /** 上游 500：重试/退避后要么成功要么优雅降级 */
  async http500() {
    await setMode('http500');
    const { gameId, godToken } = await startGame(106);
    await until(gameId, godToken, () => false, 10000);
    await setMode('ok');
    await resumeIfPaused(gameId, godToken);
    const before = progress(await view(gameId, godToken));
    const after = await until(gameId, godToken, (v) => progress(v) > before, 25000);
    record('P1-6 上游 500 → 不崩且能继续', after.ok || capEnded, `事件游标 ${before}→${progress(after.v)}`);
    return gameId;
  },

  /** 流中途断线：连接被掐 → 不能把对局拖死 */
  async dropMidStream() {
    await setMode('drop-mid-stream');
    const { gameId, godToken } = await startGame(107);
    await until(gameId, godToken, () => false, 12000);
    await setMode('ok');
    await resumeIfPaused(gameId, godToken);
    const before = progress(await view(gameId, godToken));
    const after = await until(gameId, godToken, (v) => progress(v) > before, 25000);
    record('P1-7 流中途断线 → 不拖死对局', after.ok || capEnded, `事件游标 ${before}→${progress(after.v)}`);
    return gameId;
  },

  /** E2：缓存为 0 时必须给出"冷启动"性质的告警（措辞不含误导） */
  async cacheWarn() {
    await setMode('no-cache');
    const { gameId, godToken } = await startGame(108);
    const r = await until(gameId, godToken, () => false, 30000);
    const log = logOf(gameId);
    const warned = /未命中前缀缓存/.test(log);
    const misleading = /缓存命中率低/.test(log);
    record('P1-8 缓存全 0 → 出现"未命中前缀缓存"告警', warned, `calls=${(log.match(/ ok /g) || []).length}`);
    record('P1-8 不再输出误导性的"缓存命中率低"措辞', !misleading, `旧措辞命中=${misleading}`);
    record('P1-8 该对局未被拖死', progress(r.v) > 0, `事件游标=${progress(r.v)}`);
    return gameId;
  },

  /** E2 反向：高命中时不得告警 */
  async cacheHit() {
    await setMode('cached');
    const { gameId, godToken } = await startGame(109);
    await until(gameId, godToken, () => false, 25000);
    const log = logOf(gameId);
    record('P1-9 高缓存命中 → 不告警', !/未命中前缀缓存/.test(log), `calls=${(log.match(/ ok /g) || []).length}`);
    return gameId;
  },
};

// ---------- 主流程 ----------
(async () => {
  process.stdout.write(`=== P1 故障注入（假 LLM ${FAKE}，被测实例 ${BASE}）===\n`);
  const selfStarted = await ensureFake();
  if (selfStarted) process.stdout.write('（假 LLM 由本脚本启动）\n');
  startApp();
  const cfg = await waitApp();
  process.stdout.write(`实例就绪：模型=${cfg.model} 思考=${cfg.reasoningEffort} 上限=${cfg.maxTokens}\n\n`);

  for (const [name, fn] of Object.entries(CASES)) {
    if (only && only !== name) continue;
    try {
      await setMode('ok');
      await fn();
    } catch (e) {
      record(`P1 ${name}`, false, `异常：${e && e.message}`);
    }
    process.stdout.write('');
  }

  const pass = results.filter((r) => r.ok).length;
  process.stdout.write(`\n=== 结果 ${pass}/${results.length} 通过 ===\n`);
  for (const r of results.filter((x) => !x.ok)) process.stdout.write(`  ✗ ${r.name} — ${r.detail}\n`);

  const stats = await (await fetch(`${FAKE}/__stats`)).json().catch(() => ({}));
  process.stdout.write(`\n假 LLM 累计服务 ${stats.calls || 0} 次：${JSON.stringify(stats.byMode || {})}（零真实额度）\n`);
  process.stdout.write(`日志目录：${path.join(DATA_DIR, 'logs')}\n`);

  for (const c of children) { try { c.kill(); } catch (_) { /* ignore */ } }
  if (!keep) await sleep(300);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})();
