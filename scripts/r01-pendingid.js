#!/usr/bin/env node
/**
 * r01-pendingid.js — R01 验收：**人类行动的 pendingId 必须来自"当时面板武装的那个任务"**
 *
 * 为什么需要这个脚本（而不是 e2e.js / ui-check.js）：
 *   · scripts/e2e.js **自己带 pendingId**（它替前端把 ID 补上了），所以它全绿也证明不了前端接线；
 *   · scripts/ui-check.js 的 R01 段只覆盖了"一次单目标夜间动作"，四类行动 × 双端、以及
 *     旧面板 / 连点 / 响应丢失 / 任务切换 / 刷新 这些边界它都没有覆盖，也不是可单独复跑的验收脚本。
 *   本脚本补的正是这个缺口：**让页面自己去提交，然后检查浏览器真实发出的请求体**。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ 只观察、绝不注入（任务硬约束，代码级保证）
 * ─────────────────────────────────────────────────────────────────────────────
 * 1) 证据只来自 CDP 的 `Network.requestWillBeSent`：它是**浏览器网络栈**发出的原始请求体，
 *    Node 侧脚本自己的 fetch 不经过浏览器，**不可能**出现在这个事件流里 ——
 *    所以每一条被捕获的 /action 请求都可证明是页面自己发的。
 * 2) 本脚本对被测页面的所有交互都是 **CDP Input 域的真实鼠标/键盘事件**（命中测试 + 真实
 *    事件管线），不调用 `submitHumanAction` 去"代替用户提交"。
 * 3) 页面里注入的 `freezePending` 包装器是**只读记录器**：调用原函数、原样返回其返回值，
 *    仅把返回值记进 `window.__r01Armed`。它不改写任何凭据，也不参与提交。
 * 4) 唯一的例外是"测试侧模拟"（--simulate=missing-id，见下），它**故意**抹掉 ID 来证明
 *    本脚本抓得住"缺 ID"这种坏情况；那一条在日志里逐字标注为「测试侧模拟」，不是产品缺陷。
 * 5) 为了把对局推进到目标任务，脚本会用 Node 侧 API 替人类回答**之前的**任务（布景）。
 *    这些布景请求在日志里一律标 `[布景]`，且**从不计入**任何 pendingId 断言。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 覆盖（guidance 验收点）
 * ─────────────────────────────────────────────────────────────────────────────
 *   真实页面点击 × 四类人类行动 × 桌面端/手机端：① 发言 ② 投票 ③ 夜间目标（狼刀 + 守卫）
 *   ④ 女巫动作；每一条都抓浏览器真实请求体，比对"当时面板武装的 ID"。
 *   边界：旧面板（过期 ID 被拒）/ 快速连点（不重复不遗漏）/ 响应丢失（在途切任务，不自动重放）
 *         / 任务切换（新请求带新 ID）/ 刷新（旧 ID 失效）。
 *   先红后绿：--simulate=missing-id 走测试侧模拟，必须判红并给出可读原因（退出码 1）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 退出码
 * ─────────────────────────────────────────────────────────────────────────────
 *   0 全部通过 ｜ 1 有断言失败 ｜ 2 环境不满足（缺浏览器 / 端口被占 / 服务端起不来）
 *   3 需人工介入（场景构造不出来：拿不到带该任务的真实页面面板）
 *
 * 用法：
 *   node scripts/r01-pendingid.js
 *   node scripts/r01-pendingid.js --simulate=missing-id     # 先红后绿里的"红"
 *   node scripts/r01-pendingid.js --only=desktop-speech,mobile-witch
 *   WW_UI_PORT=3851 WW_CDP_PORT=9961 WW_DATA_DIR=D:\ww-probe\r01-data node scripts/r01-pendingid.js
 * 日志与截图：logs/r01/
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'logs', 'r01');
const PORT = Number(process.env.WW_UI_PORT || 3851);
const CDP_PORT = Number(process.env.WW_CDP_PORT || 9961);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = process.env.WW_DATA_DIR || path.join(os.tmpdir(), 'ww-r01-data');
const SIMULATE = (process.argv.find((a) => a.startsWith('--simulate=')) || '').split('=')[1] || null;
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

const EXIT_OK = 0, EXIT_FAIL = 1, EXIT_ENV = 2, EXIT_HUMAN = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const CHROME = process.env.WW_CHROME === 'none' ? null
  : (process.env.WW_CHROME && fs.existsSync(process.env.WW_CHROME) ? process.env.WW_CHROME
    : (process.env.WW_CHROME ? null : CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null));

// ---------------- 结果收集 ----------------
let fails = 0, blocked = 0;
const checks = [];             // 全量判据读数（落 JSON，供汇报引用）
const lines = [];
const T0 = Date.now();
const log = (...a) => {
  const l = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  lines.push(l);
  try { console.log(l); } catch (_) { /* 控制台编码问题不影响日志文件 */ }
};
const check = (label, cond, extra = '') => {
  if (!cond) fails++;
  checks.push({ label, ok: !!cond, detail: extra, at: Date.now() - T0 });
  log(`${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
};
/** 场景构造失败等"没法验"的情况：既不算过也不算产品失败，单列并最终以 3 退出 */
const blockedCheck = (label, extra = '') => {
  blocked++;
  checks.push({ label, ok: null, detail: extra, at: Date.now() - T0 });
  log(`⚠ 未验证：${label}${extra ? ' — ' + extra : ''}`);
};
const section = (t) => log(`\n=== ${t} ===`);

// ---------------- 极简 CDP 客户端（做法沿用 scripts/ui-check.js，不改它） ----------------
/**
 * 页面启动期注入的**只读**记录器：包一层 freezePending，记下"面板武装的那份凭据"。
 * 关键：调用原函数、原样返回结果、不改写任何字段。
 */
const RECORDER_SRC = `(() => {
  window.__r01Armed = [];
  window.__r01Patched = false;
  function install() {
    if (window.__r01Patched) return true;
    if (typeof window.freezePending !== 'function') return false;
    const orig = window.freezePending;
    window.freezePending = function () {
      const r = orig.apply(this, arguments);      // 只观察：原样调用
      try {
        window.__r01Armed.push({
          at: Date.now(),
          pendingId: (r && r.pendingId != null) ? r.pendingId : null,
          task: (r && r.task) || null,
        });
      } catch (e) { /* 记录失败绝不影响原流程 */ }
      return r;                                    // 原样返回：不改写凭据
    };
    window.__r01Patched = true;
    return true;
  }
  let spins = 0;
  (function spin() { if (install() || spins++ > 4000) return; setTimeout(spin, 0); })();
  setInterval(install, 200);                       // 兜底：页面脚本被推迟时也能装上
})();`;

/**
 * 测试侧模拟（**只在 --simulate=missing-id 时注入**）：模拟"前端根本没把 pendingId 接上"的坏状态
 * ——即指导文档 R01 描述的历史断点。这是测试构造，不是产品代码，也绝不是产品的现状。
 * 做法：包一层 submitHumanAction，把 pend.pendingId 置空后交给原函数（其余字节完全不变）。
 */
const SIMULATE_PATCH_SRC = `(() => {
  window.__r01Simulated = false;
  function install() {
    if (window.__r01Simulated) return true;
    if (typeof window.submitHumanAction !== 'function') return false;
    const orig = window.submitHumanAction;
    window.submitHumanAction = function (pend, payload) {
      // 测试侧模拟：抹掉 pendingId（仅此一处差异）
      return orig.call(this, Object.assign({}, pend || {}, { pendingId: null }), payload);
    };
    window.__r01Simulated = true;
    return true;
  }
  let spins = 0;
  (function spin() { if (install() || spins++ > 4000) return; setTimeout(spin, 0); })();
  setInterval(install, 200);
})();`;

class Browser {
  constructor() {
    this.id = 0; this.pending = new Map();
    this.exceptions = []; this.consoleErrors = []; this.failedRequests = [];
    this.netReqs = [];         // 只记录 /action 请求（浏览器真实发出的原始请求体）
    this.fetchFailNext = false; this.fetchFailHits = []; this.fetchEnabled = false;
  }
  static async launch(port, chrome) {
    const b = new Browser();
    b.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-r01-chrome-'));
    b.proc = spawn(chrome, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--mute-audio',
      `--remote-debugging-port=${port}`, `--user-data-dir=${b.userDataDir}`,
      '--window-size=1440,900', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let spawnError = null;
    b.proc.on('error', (e) => { spawnError = e; });
    let version = null;
    for (let i = 0; i < 60; i++) {
      if (spawnError) break;
      try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch (_) { await sleep(200); }
    }
    if (!version) throw new Error(spawnError ? `浏览器启动失败：${spawnError.message}` : 'DevTools 端口未就绪');
    await new Promise((resolve, reject) => {
      b.ws = new WebSocket(version.webSocketDebuggerUrl);
      b.ws.addEventListener('open', () => resolve());
      b.ws.addEventListener('error', () => reject(new Error('调试连接失败')));
      b.ws.addEventListener('message', (ev) => b._onMessage(JSON.parse(ev.data)));
    });
    const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
    const att = await b.send('Target.attachToTarget', { targetId, flatten: true });
    b.sessionId = att.sessionId;
    for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable']) await b.send(m, {}, b.sessionId);
    // 只读记录器（+ 可选的测试侧模拟补丁）在**任何页面脚本之前**安装
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER_SRC }, b.sessionId);
    if (SIMULATE === 'missing-id') {
      await b.send('Page.addScriptToEvaluateOnNewDocument', { source: SIMULATE_PATCH_SRC }, b.sessionId);
    }
    return b;
  }
  _onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      return;
    }
    const p = msg.params || {};
    const sid = msg.sessionId || this.sessionId;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails || {};
      this.exceptions.push(`${d.text || ''} ${(d.exception && d.exception.description) || ''}`.trim());
    } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(p.type)) {
      this.consoleErrors.push(`[${p.type}] ` + (p.args || []).map((a) => a.value || a.description || a.type).join(' '));
    } else if (msg.method === 'Network.requestWillBeSent') {
      const req = p.request || {};
      const url = String(req.url || '');
      if (/\/api\/games\/[^/]+\/action(\?|$)/.test(url)) {
        this.netReqs.push({
          i: this.netReqs.length, requestId: p.requestId, url, method: req.method,
          postData: req.postData == null ? null : String(req.postData),
          initiator: (p.initiator && p.initiator.type) || null,
          at: Date.now(), status: null, responseBody: null,
        });
      }
    } else if (msg.method === 'Network.responseReceived') {
      const hit = this.netReqs.find((x) => x.requestId === p.requestId);
      if (hit) hit.status = ((p.response || {}).status) || null;
    } else if (msg.method === 'Network.loadingFailed') {
      if (!/favicon/.test(p.requestId || '')) this.failedRequests.push(`${p.type} ${p.errorText}`);
    } else if (msg.method === 'Fetch.requestPaused') {
      // 响应阶段拦截（仅"响应丢失"边界用到）：不改请求体，只让**响应**失败
      const url = String((p.request || {}).url || '');
      if (this.fetchFailNext && /\/action/.test(url)) {
        this.fetchFailNext = false;
        this.fetchFailHits.push({ url, status: p.responseStatusCode, at: Date.now() });
        this.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionClosed' }, sid).catch(() => {});
      } else {
        this._continuePaused(p, sid);
      }
    }
  }
  _continuePaused(p, sid) {
    this.send('Fetch.continueResponse', { requestId: p.requestId }, sid)
      .catch(() => this.send('Fetch.continueRequest', { requestId: p.requestId }, sid).catch(() => {}));
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, this.sessionId);
    if (r.exceptionDetails) throw new Error('页面 JS 抛错: ' + (r.exceptionDetails.text || '') + ' ' + ((r.exceptionDetails.exception || {}).description || ''));
    return r.result && r.result.value;
  }
  async goto(url) { await this.send('Page.navigate', { url }, this.sessionId); }
  async reload() { await this.send('Page.reload', { ignoreCache: false }, this.sessionId); }
  async realClick(sel) {
    const box = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      const desc = (n) => !n ? null : (n.id ? '#' + n.id : n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\\s+/).join('.') : ''));
      return {
        x: cx, y: cy, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
        inVp: cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight,
        hitSelf: !!hit && (hit === el || el.contains(hit)),
        coveredBy: hit && !(hit === el || el.contains(hit)) ? desc(hit) : null,
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30),
      };
    })()`);
    if (!box) return 'NOT_FOUND';
    if (!(box.w > 0) || !(box.h > 0) || !box.inVp || !box.hitSelf) {
      return 'NOT_CLICKABLE:' + JSON.stringify({ w: box.w, h: box.h, inViewport: box.inVp, coveredBy: box.coveredBy });
    }
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent',
        { type, x: box.x, y: box.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 },
        this.sessionId);
    }
    return 'OK:' + JSON.stringify({ text: box.text });
  }
  /** 真实键盘输入（走 Input.insertText：Real 输入管线，不是改 DOM 属性） */
  async typeText(text) { await this.send('Input.insertText', { text }, this.sessionId); }
  setViewport(width, height, mobile) {
    return this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }, this.sessionId);
  }
  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
  setBlockedURLs(urls) { return this.send('Network.setBlockedURLs', { urls }, this.sessionId); }
  async fetchResponseFail(on) {
    if (on && !this.fetchEnabled) {
      await this.send('Fetch.enable', { patterns: [{ urlPattern: '*/action*', requestStage: 'Response' }] }, this.sessionId);
      this.fetchEnabled = true;
    } else if (!on && this.fetchEnabled) {
      this.fetchFailNext = false;
      await this.send('Fetch.disable', {}, this.sessionId);
      this.fetchEnabled = false;
    }
  }
  async getResponseBody(req) {
    if (!req || req.responseBody != null) return req && req.responseBody;
    try {
      const r = await this.send('Network.getResponseBody', { requestId: req.requestId }, this.sessionId);
      req.responseBody = r && r.body ? String(r.body).slice(0, 500) : null;
    } catch (_) { req.responseBody = '(取不到响应体)'; }
    return req.responseBody;
  }
  async close() {
    try { this.ws && this.ws.close(); } catch (_) { /* ignore */ }
    try { this.proc && this.proc.kill(); } catch (_) { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(this.userDataDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

// ---------------- 页面/服务端助手 ----------------
async function waitUntil(fn, { timeout = 8000, interval = 80, label = '条件' } = {}) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    try { last = await fn(); } catch (e) { last = { err: String((e && e.message) || e) }; }
    const ok = !!(last && typeof last === 'object' && 'ok' in last ? last.ok : last);
    if (ok) return last;
    if (Date.now() - t0 >= timeout) { last = last || {}; last.__timeout = true; return last; }
    await sleep(interval);
  }
}
const portOccupied = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  const done = (v) => { try { s.destroy(); } catch (_) { /* ignore */ } resolve(v); };
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
  s.setTimeout(1500, () => done(false));
});
async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch (_) { /* 允许空响应 */ }
  return { code: r.status, body: j };
}
const viewOf = async (g) => (await api('GET', `/api/games/${g.gameId}/view?token=${g.playerToken}&after=0`)).body || {};
const livePending = async (g) => { const v = await viewOf(g); return v.pending || null; };
/** 布景用：Node 侧替人类回答"之前的"任务。**不计入任何 pendingId 断言**（日志标 [布景]） */
async function answerAsSetup(g, p, why) {
  let payload = {};
  if (['speech', 'pk_speech', 'lastwords', 'sheriff_speech', 'wolf_propose', 'wolf_say', 'wolf_chat'].includes(p.task)) payload = { text: '过' };
  else if (p.task === 'sheriff_run') payload = { run: false };
  else if (p.task === 'explode_check') payload = { explode: false };
  else if (p.task === 'direction') payload = { direction: 'cw' };
  else if (p.task === 'witch') payload = { antidote: false, poison: 0 };
  else if (p.task === 'badge_pass' || p.task === 'shoot') payload = { target: 0 };
  else payload = { target: (p.candidates || [])[0] ?? 0 };
  let r = await api('POST', `/api/games/${g.gameId}/action`, { token: g.playerToken, pendingId: p.pendingId, payload });
  if (r.code === 409) { // 任务已在别处过期：读最新一次重试
    const fresh = await livePending(g);
    if (fresh && fresh.pendingId) r = await api('POST', `/api/games/${g.gameId}/action`, { token: g.playerToken, pendingId: fresh.pendingId, payload });
  }
  log(`  [布景] ${why}：task=${p.task} id=${p.pendingId} → ${r.code}`);
  return r.code;
}

// ---------------- 场景定义 ----------------
/** 目标任务的候选角色（按板子裁到最小人数，便于用 seed 精确命中角色） */
const ROLE_BOARD = {
  villager: { wolf: 2, seer: 1, villager: 3 },
  guard: { wolf: 2, guard: 1, villager: 3 },
  witch: { wolf: 2, witch: 1, villager: 3 },
  wolf: { wolf: 2, witch: 1, villager: 3 },
};
const WOLF_ROLES = ['wolf', 'wolfking', 'whitewolfking', 'wolfbeauty', 'hiddenwolf'];
const roleMatches = (want, role) => (want === 'wolf' ? WOLF_ROLES.includes(role) : role === want);

const SCENARIOS = [
  { id: 'desktop-speech', surface: 'desktop', task: 'speech', role: 'villager', label: '① 发言（桌面端）' },
  { id: 'desktop-vote', surface: 'desktop', task: 'vote', role: 'villager', label: '② 投票（桌面端）' },
  { id: 'desktop-guard', surface: 'desktop', task: 'night_guard', role: 'guard', label: '③ 夜间目标·守卫（桌面端）' },
  { id: 'desktop-wolfkill', surface: 'desktop', task: 'wolf_kill', role: 'wolf', label: '③ 夜间目标·狼刀（桌面端）' },
  { id: 'desktop-witch', surface: 'desktop', task: 'witch', role: 'witch', label: '④ 女巫动作（桌面端）' },
  { id: 'mobile-speech', surface: 'mobile', task: 'speech', role: 'villager', label: '① 发言（手机端）' },
  { id: 'mobile-vote', surface: 'mobile', task: 'vote', role: 'villager', label: '② 投票（手机端）' },
  { id: 'mobile-guard', surface: 'mobile', task: 'night_guard', role: 'guard', label: '③ 夜间目标·守卫（手机端）' },
  { id: 'mobile-wolfkill', surface: 'mobile', task: 'wolf_kill', role: 'wolf', label: '③ 夜间目标·狼刀（手机端）' },
  { id: 'mobile-witch', surface: 'mobile', task: 'witch', role: 'witch', label: '④ 女巫动作（手机端）' },
];
const ONLY_LIST = ONLY ? ONLY.split(',') : null;
const selected = ONLY_LIST ? SCENARIOS.filter((s) => ONLY_LIST.includes(s.id)) : SCENARIOS;
const RUN_BOUNDARIES = !ONLY_LIST || ONLY_LIST.includes('boundaries');

// ---------------- 主页面的全局状态 ----------------
let server = null, browser = null, serverErr = '';
const captured = [];   // 每条断言的证据：真实请求体

async function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), WW_DATA_DIR: DATA_DIR, NO_OPEN: '1', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => { serverErr += String(d); });
  const res = await waitUntil(async () => {
    let ready = false;
    try { ready = (await fetch(`${BASE}/api/meta`)).ok; } catch (_) { /* 还没起来 */ }
    return { ok: ready && server.exitCode === null, ready, alive: server.exitCode === null, exitCode: server.exitCode };
  }, { label: '服务端就绪', timeout: 25000, interval: 150 });
  return res;
}

/** 造局（布景）：按角色要求搜 seed，必要时用 Node API 把对局推进到目标任务 */
async function prepareScenario(spec) {
  const board = ROLE_BOARD[spec.role];
  const seats = Object.values(board).reduce((a, b) => a + b, 0);
  const players = Array.from({ length: seats }, (_, k) => ({ name: k === 0 ? '我' : `AI-${k + 1}`, isHuman: k === 0 }));
  const tried = [];
  for (let seed = 1; seed <= 80; seed++) {
    const res = await api('POST', '/api/games', { mock: true, seed, players, board, rules: { sheriff: false } });
    if (res.code !== 200) return { err: `造局失败 ${res.code} ${JSON.stringify(res.body).slice(0, 160)}` };
    const g = { ...res.body, seed };
    await api('POST', `/api/games/${g.gameId}/start`, { token: g.playerToken });
    let okSeed = false;
    for (let step = 0; step < 60; step++) {
      const v = await viewOf(g);
      if (v.finished) break;
      const p = v.pending;
      if (!p) { await sleep(50); continue; }
      if (!v.me || !roleMatches(spec.role, v.me.role)) break;   // 角色不对：换 seed
      if (p.task === spec.task) {
        if (spec.task === 'witch') {
          const ex = p.extra || {};
          // 女巫这边只接受**合法的用药动作**：本板 witchSelfSave=never，若狼刀刀口正好是女巫本人，
          // 面板照样给「用解药救 N 号」，但服务端会 400 拒（自救不允许）。
          // 那属于 R01 之外的 UI/引擎口径观察（本轮实测到过，见报告），不是 pendingId 问题，
          // 所以这里换 seed 找一个"解药可合法使用"的局，避免用非法载荷污染 R01 的判据。
          const selfKill = ex.canAntidote && Number(ex.killTarget) === Number(v.me.seat);
          if (selfKill) {
            tried.push(`seed${seed} 狼刀刀口=女巫本人（自救被板规禁止）`);
            log(`  [观察] seed ${seed}：狼刀刀口=${ex.killTarget}（女巫本人），canAntidote=true —— 面板会给「用解药救 N 号」，但板规 witchSelfSave=never 下服务端会以 400 拒绝自救；换 seed`);
            await answerAsSetup(g, p, `女巫自救不可用（seed ${seed}）`);
            await sleep(60);
            continue;
          }
          if (!ex.canAntidote && !ex.canPoison) {
            tried.push(`seed${seed} witch 无可用药键`);
            await answerAsSetup(g, p, `女巫无可用药键（seed ${seed}）`);
            await sleep(60);
            continue;
          }
        }
        okSeed = true;
        return { g, seed, pending: p, role: v.me.role, view: v };
      }
      await answerAsSetup(g, p, `推进到 ${spec.task}（seed ${seed}）`);
      await sleep(60);
    }
    await api('POST', `/api/games/${g.gameId}/terminate`, { token: g.playerToken }).catch(() => {});
  }
  return { err: `80 个 seed 内没有造出 role=${spec.role} task=${spec.task} 的可复现场景`, tried };
}

/** 进局失败时的诊断（只读，用来把"布景问题"与"产品问题"分开）：服务端会话态 + 浏览器里存的句柄 */
async function logEntryDiagnosis(surface, g) {
  try {
    const sess = await api('GET', `/api/games/${g.gameId}/session?token=${g.playerToken}`);
    const rows = ((await api('GET', '/api/games')).body || {}).rows || [];
    const row = rows.find((r) => r.id === g.gameId);
    const ls = await browser.eval(`({ ww: !!(localStorage.getItem('ww_current')), mww: !!(localStorage.getItem('mww_current')) })`);
    log(`  · 诊断（${surface}）：/session=${sess.code} ${JSON.stringify(sess.body).slice(0, 180)}`);
    log(`  · 诊断（${surface}）：列表行=${JSON.stringify(row)} localStorage=${JSON.stringify(ls)}`);
  } catch (e) { log(`  · 诊断失败：${e.message}`); }
}

/** 真实点击输入框并真实键入，然后**核验 value 真的进去了**（否则空文本会被服务端 400 拒掉） */
async function typeInto(sel, text) {
  let last = null;
  for (let i = 1; i <= 4; i++) {
    await dismissOverlays(); // 身份翻牌浮层会吃掉点击：先真实点掉它（值没进去时也重试这一步）
    const click = await browser.realClick(sel);
    await browser.typeText(text);
    await sleep(180);
    const v = await browser.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.value : null; })()`);
    last = { ok: v === text, click, value: v, attempt: i };
    if (last.ok) return last;
    await sleep(300);
  }
  return last;
}

/** 进入对局屏（桌面 / 手机），并处理身份翻牌遮罩 */
async function enterGame(spec, g) {
  const isMobile = spec.surface === 'mobile';
  const url = BASE + (isMobile ? '/m/' : '/');
  if (isMobile) await browser.setViewport(390, 844, true);
  else await browser.setViewport(1440, 900, false);
  // localStorage 只能在应用源下写：先落到应用页，再写句柄，再重载进局
  await browser.goto(url);
  await waitUntil(() => browser.eval(`({ ok: document.readyState === 'complete' && !!document.body })`), { label: '首次落到应用源', timeout: 20000 });
  const handle = JSON.stringify(g);
  await browser.eval(isMobile
    ? `localStorage.setItem('mww_current', ${JSON.stringify(handle)}); localStorage.setItem('ww_current', ${JSON.stringify(handle)}); 'ok'`
    : `localStorage.setItem('ww_current', ${JSON.stringify(handle)}); 'ok'`);
  await browser.reload();
  if (isMobile) {
    // 手机端首页是**异步** loadResumeCard：必须等"继续上局"卡真的出现再点，
    // 否则会停在板子页空等（本轮初版就是这个竞态 —— 4/5 个手机场景停在了板子页）。
    // 可见性一律用 rect 判定：`#m-resume-go`/`#m-flip` 在手机端是 fixed 定位，offsetParent 恒为 null。
    const probeHome = `(() => {
      const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
      const shown = [...document.querySelectorAll('.m-screen:not(.hidden)')].map((x) => x.id);
      const go = document.getElementById('m-resume-go');
      const card = document.getElementById('m-resume-card');
      const cardShown = !!card && !card.classList.contains('hidden') && vis(card) && vis(go);
      if (cardShown) go.id = 'tmp-r01-continue';
      return { inGame: shown.includes('m-game'), shown, hasBtn: cardShown, btnText: go ? (go.textContent || '').trim() : null, cardHidden: card ? card.classList.contains('hidden') : null };
    })()`;
    const entered = await waitUntil(async () => {
      const s = await browser.eval(probeHome);
      if (s.inGame) return { ...s, ok: true };
      if (s.hasBtn) { await browser.realClick('#tmp-r01-continue'); await sleep(500); }
      return { ...s, ok: false };
    }, { timeout: 25000, interval: 250, label: '手机端进入对局屏' });
    log(`  · 手机端进局：inGame=${entered.inGame} 可见屏=${JSON.stringify(entered.shown)} 继续卡可见=${entered.hasBtn}（隐藏=${entered.cardHidden} 按钮=${JSON.stringify(entered.btnText)}）`);
    if (!entered.ok) {
      await logEntryDiagnosis('mobile', g);
      blockedCheck('手机端进入对局屏', `停在 ${JSON.stringify(entered.shown)}：继续卡 hidden=${entered.cardHidden} 可见=${entered.hasBtn}`);
      return 'BLOCKED_ENTRY';
    }
  } else {
    const entered = await waitUntil(async () => {
      const s = await browser.eval(`(() => {
        const shown = document.querySelector('.screen:not(.hidden)');
        const box = document.getElementById('resume-box');
        const btn = document.getElementById('btn-resume');
        const card = !!(box && !box.classList.contains('hidden'));
        if (card && btn && shown && shown.id !== 'screen-game') { btn.id = 'tmp-r01-resume'; return { inGame: false, screen: shown.id, hasBtn: true }; }
        return { inGame: !!shown && shown.id === 'screen-game', screen: shown && shown.id, hasBtn: false };
      })()`);
      if (s.inGame) return { ...s, ok: true };
      if (s.hasBtn) { await browser.realClick('#tmp-r01-resume'); await sleep(400); }
      return { ...s, ok: false };
    }, { timeout: 20000, interval: 250, label: '桌面端进入对局屏' });
    log(`  · 桌面端进局：inGame=${entered.inGame} 屏=${entered.screen} 点过继续卡=${entered.hasBtn}`);
    if (!entered.ok) {
      await logEntryDiagnosis('desktop', g);
      blockedCheck('桌面端进入对局屏', `停在 ${entered.screen}`);
      return 'BLOCKED_ENTRY';
    }
  }
  // 身份翻牌遮罩：真实点击收起（真实用户也必须过这一步）。它可能在进局后稍晚才弹，
  // 所以这里等一拍再收；万一还晚，clickSubmitAndCapture 会在被挡时再收一次。
  await sleep(500);
  const flip = await dismissOverlays();
  return flip;
}

/**
 * 等"面板已按目标任务渲染"且"只读记录器已记下该面板武装的凭据"。
 * 不按增量条数判定：面板常常在"进入对局屏"之前就已经武装好了（页面一拿到视图就建面板），
 * 用"必须有 ≥1 条记录 + 最后一条的任务/签名都对得上"更稳；ID 是否过期由随后的
 * 「武装 ID == 服务端当时 pending」那条断言负责抓。
 */
/**
 * 解析面板签名里的**基础任务名**。
 * 两端的签名格式本来就不同（这是产品现状，不是缺陷）：
 *   桌面：`night_guard[1,2,3,4,5,6]` / `witch""2`（= task + candidates + killTarget）
 *   手机：`task:wolf_kill:[2,3,4,6]:00`（= `task:` + task + ':' + candidates + ':' + 开关位）
 * 所以这里统一取"去掉 task: 前缀后，开头的标识符"（`[a-z_]+`），再与请求体里的 task 比基础任务名；
 * 候选集合由 `freezePending` 记录里的 task 与随后的服务端视图单独核对（不做全等比较）。
 */
function baseTaskOf(sig) {
  const s = String(sig || '').replace(/^task:/, '');
  const m = /^[a-z_]+/i.exec(s);
  return m ? m[0] : '';
}

async function waitPanel(spec) {
  return waitUntil(async () => {
    const v = await browser.eval(`(() => {
      const armed = (window.__r01Armed || []);
      const last = armed.length ? armed[armed.length - 1] : null;
      const box = document.getElementById('action-controls');
      const keys = document.getElementById('m-keys');
      const host = ${JSON.stringify(spec.surface === 'mobile' ? 'keys' : 'box')} === 'keys' ? keys : box;
      const hint = document.getElementById('${spec.surface === 'mobile' ? 'm-pending-hint' : 'pending-hint'}');
      return {
        armedN: armed.length, last,
        domTask: host ? (host.dataset.task || '') : '(无宿主)',
        hostFound: !!host,
        hint: hint ? (hint.textContent || '').slice(0, 60) : '',
        installed: !!window.__r01Patched,
        allArmed: armed.slice(-3),
      };
    })()`);
    const ok = v.installed && v.hostFound && v.armedN >= 1 && !!v.last && v.last.task === spec.task
      && baseTaskOf(v.domTask) === spec.task;
    return { ...v, baseTask: baseTaskOf(v.domTask), ok };
  }, { label: `${spec.label} 面板就绪`, timeout: 20000, interval: 120 });
}

/** 在页面里按文案找控件、给临时 id（只为了能对它发真实鼠标事件；不改行为） */
async function tagControl(surface, kind, pattern) {
  return browser.eval(`(() => {
    const host = document.getElementById(${JSON.stringify(surface === 'mobile' ? 'm-keys' : 'action-controls')});
    if (!host) return { ok: false, why: '没有操作面板宿主' };
    const all = [...host.querySelectorAll('button')].filter((b) => !b.disabled);
    const re = new RegExp(${JSON.stringify(pattern)});
    const b = all.find((x) => re.test((x.textContent || '').replace(/\\s+/g, ' ')));
    if (!b) return { ok: false, why: '没找到可用控件', labels: all.map((x) => (x.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 20)) };
    b.id = 'tmp-r01-submit';
    return { ok: true, label: (b.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40), cls: b.className };
  })()`);
}

/** 点一个候选目标（桌面=胶囊；手机=玩家页座位），返回是否真的选中 */
async function chooseTarget(spec, seat) {
  let last = null;
  for (let i = 1; i <= 3; i++) {
    await dismissOverlays(); // 翻牌浮层会挡住座位/胶囊的点击
    if (spec.surface === 'mobile') {
      const tab = await browser.eval(`(() => { const b = document.getElementById('m-tabbtn-players'); if (!b) return false; b.id = 'tmp-r01-tab'; return true; })()`);
      if (tab) { await browser.realClick('#tmp-r01-tab'); await sleep(250); }
      const r = await browser.realClick(`.m-seatcol .srow[data-seat="${seat}"]`);
      const st = await browser.eval(`(() => ({ target: (typeof actionState === 'undefined' ? null : actionState.target), need: (typeof actionState === 'undefined' ? null : actionState.needTarget) }))()`);
      last = { click: r, state: st, sel: `.m-seatcol .srow[data-seat="${seat}"]`, attempt: i };
    } else {
      const r = await browser.realClick(`#action-controls .chip[data-seat="${seat}"]`);
      const st = await browser.eval(`(() => ({ target: (typeof actionState === 'undefined' ? null : actionState.target) }))()`);
      last = { click: r, state: st, sel: `#action-controls .chip[data-seat="${seat}"]`, attempt: i };
    }
    if (last.state && last.state.target === seat) return { ...last, ok: true };
    await sleep(300);
  }
  return { ...(last || {}), ok: false };
}

/** 真实点击"提交类控件"并等浏览器真发出 /action 请求（点空/节点被重绘替换时才允许重试） */
async function clickSubmitAndCapture(pattern, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const tag = await tagControl(currentSurface.v, 'submit', pattern);
    if (!tag.ok) return { err: `找不到可点的提交控件（第 ${attempt} 次）：${tag.why} 现有=${JSON.stringify(tag.labels)}` };
    const mark = browser.netReqs.length;
    const clickRes = await browser.realClick('#tmp-r01-submit');
    const got = await waitUntil(() => ({ ok: browser.netReqs.length > mark, n: browser.netReqs.length - mark }), { timeout: 1500, interval: 50 });
    if (got.ok) return { req: browser.netReqs[browser.netReqs.length - 1], clickRes, tag, attempt };
    if (/NOT_CLICKABLE/.test(clickRes) && /flip|overlay/.test(clickRes)) {
      const acts = await dismissOverlays();
      log(`  · 第 ${attempt} 次点击被浮层挡住（${clickRes}）→ 真实点击收起浮层 ${JSON.stringify(acts)} 后重试`);
      continue;
    }
    log(`  · 第 ${attempt} 次点击「${tag.label}」没有产生 /action 请求（realClick=${clickRes}），重试`);
    await sleep(250);
  }
  return { err: '连续 3 次真实点击都没有产生 /action 请求' };
}

const currentSurface = { v: 'desktop' };

/**
 * 收起挡住操作的浮层（身份翻牌 / 桌面对应浮层）——真实用户也必须先点掉它。
 * ⚠ 不能用 `offsetParent !== null` 判可见：手机端的 `#m-flip` 是 position:fixed，
 *   对 fixed 元素 offsetParent 恒为 null（本轮初版就是这么漏判的，于是点击全被 #m-flip 吃掉）。
 */
async function dismissOverlays() {
  const acts = await browser.eval(`(() => {
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const out = [];
    const mf = document.getElementById('m-flip') || document.querySelector('.m-flip');
    if (mf && !mf.classList.contains('hidden') && vis(mf)) {
      const b = document.getElementById('m-flip-done') || mf.querySelector('button');
      if (b) { b.id = 'tmp-r01-flipdone'; out.push('mobile-flip'); }
    }
    const ov = document.getElementById('role-overlay');
    if (ov && !ov.classList.contains('hidden') && vis(ov)) {
      const b = document.getElementById('btn-flip-done');
      if (b) { b.id = 'tmp-r01-flipdone'; out.push('desktop-flip'); }
    }
    return out;
  })()`);
  for (const a of acts) { await browser.realClick('#tmp-r01-flipdone'); await sleep(250); }
  return acts;
}

/** 解析并比对一条捕获到的请求 */
function judgeRequest(req, expectId, where) {
  let body = null;
  try { body = req && req.postData ? JSON.parse(req.postData) : null; } catch (_) { body = null; }
  const summary = {
    where, url: req ? req.url : null, method: req ? req.method : null,
    initiator: req ? req.initiator : null,
    rawPostData: req ? (req.postData || '').slice(0, 300) : null,
    hasPendingId: !!(body && body.pendingId),
    sentPendingId: body ? (body.pendingId === undefined ? '(无该字段)' : body.pendingId) : null,
    expectPendingId: expectId,
    match: !!(body && body.pendingId && body.pendingId === expectId),
    status: req ? req.status : null,
  };
  captured.push(summary);
  return { body, summary };
}

// ---------------- 单个"页面点击 → 真实请求"场景 ----------------
async function runScenario(spec) {
  section(`${spec.label}（${spec.id}）`);
  currentSurface.v = spec.surface;
  const prep = await prepareScenario(spec);
  if (prep.err) {
    blockedCheck(`${spec.label}：能构造出 role=${spec.role} / task=${spec.task} 的可点击场景`, prep.err);
    return;
  }
  const g = prep.g;
  log(`  · 场景：seed=${prep.seed} gameId=${g.gameId} 我的角色=${prep.role} 目标任务=${prep.pending.task} extra=${JSON.stringify(prep.pending.extra || null)}`);
  try {
    if (await enterGame(spec, g) === 'BLOCKED_ENTRY') return;
    const panel = await waitPanel(spec);
    check(`${spec.label}：真实页面已按该任务渲染出操作面板（面板任务=${spec.task}）`,
      panel.ok === true, `面板签名=${panel.domTask} 提示="${panel.hint}" 记录器=${panel.installed ? '已装' : '未装'} 记录数=${panel.armedN}`);
    if (!panel.ok) { blockedCheck(`${spec.label}：面板未能按目标任务渲染`, JSON.stringify(panel).slice(0, 240)); return; }

    // 「当时面板武装的那个 ID」= 页面只读记录器记下的 freezePending 返回值
    const armedId = panel.last.pendingId;
    const armedTask = panel.last.task;
    const serverPending = await livePending(g);
    const serverIdAtPanel = serverPending ? serverPending.pendingId : null;
    check(`${spec.label}：页面面板武装的 pendingId 与服务端当时的 pending 一致（面板期冻结，非临时取最新）`,
      !!armedId && armedId === serverIdAtPanel, `面板武装=${armedId} 服务端当时=${serverIdAtPanel} 服务端任务=${serverPending && serverPending.task}`);

    // ---- 真实点击：选目标（目标类任务）/ 输入文本（发言类任务） ----
    let inputNote = '';
    if (['speech', 'pk_speech', 'lastwords', 'sheriff_speech'].includes(spec.task)) {
      const taSel = spec.surface === 'mobile' ? '#m-dialog textarea' : '#action-controls textarea';
      const typed = await typeInto(taSel, 'R01 真实键盘输入');
      inputNote = `真实点击输入框+真实键入：value=${JSON.stringify(typed.value)}（第 ${typed.attempt} 次成功）`;
      check(`${spec.label}：发言文本真的进了输入框（不是空提交）`, typed.ok === true, JSON.stringify(typed));
    }
    const cands = (serverPending && serverPending.candidates) || [];
    let targetNote = '（本任务不需要选目标）';
    if (['vote', 'pk_vote', 'night_guard', 'wolf_kill', 'wild'].includes(spec.task) && cands.length) {
      const picked = cands[0];
      const t = await chooseTarget(spec, picked);
      targetNote = `真实点击选 ${picked} 号（${spec.surface === 'mobile' ? '玩家页座位' : '候选胶囊'}，click=${t.click}）→ actionState.target=${t.state && t.state.target}`;
      check(`${spec.label}：真实点击确实选中了合法目标（走的是页面自己的 click 处理器）`,
        !!(t.state && t.state.target === picked), `${t.sel} → ${JSON.stringify(t.state)}`);
    }

    // 女巫：只点**合法**的那一瓶（布景阶段已排除"自救"这种会被板规 400 拒的组合）
    let witchNote = '';
    let witchPattern = '解药|毒|空过';
    if (spec.task === 'witch') {
      const ex = (serverPending && serverPending.extra) || {};
      const mySeat = ((prep.view && prep.view.me) || {}).seat;
      const legalAntidote = !!ex.canAntidote && Number(ex.killTarget) !== Number(mySeat);
      if (legalAntidote) { witchPattern = '解药'; witchNote = `解药（救 ${ex.killTarget} 号，合法：不是自救）`; }
      else if (ex.canPoison) {
        // 毒药：先真实点一个合法目标（活着、非自己），再点毒药键
        const alive = (((await viewOf(g)).players) || []).filter((x) => x.alive && x.seat !== mySeat).map((x) => x.seat);
        const picked = alive[0];
        const t = await chooseTarget(spec, picked);
        check(`${spec.label}：毒药目标真实点击选中（${picked} 号）`, !!(t.state && t.state.target === picked), `${t.sel} → ${JSON.stringify(t.state)}`);
        witchPattern = '毒'; witchNote = `毒药（毒 ${picked} 号）`;
      } else { witchPattern = '空过'; witchNote = '空过（本夜无可用药）'; }
      targetNote = witchNote;
    }

    // ---- 真实点击提交控件 + 捕获浏览器真实请求 ----
    const pattern = /speech|pk_speech|lastwords|sheriff_speech/.test(spec.task) ? '发送发言|留下遗言|发言'
      : spec.task === 'vote' || spec.task === 'pk_vote' ? '投票'
        : spec.task === 'night_guard' ? '确认守护'
          : spec.task === 'wolf_kill' ? '投刀'
            : spec.task === 'witch' ? witchPattern
              : '确认|提交';
    const cap = await clickSubmitAndCapture(pattern, spec.label);
    if (cap.err) { check(`${spec.label}：真实点击提交并捕获到浏览器请求`, false, cap.err); return; }
    log(`  · 点击控件=「${(cap.tag && cap.tag.label) || '?'}」 realClick=${cap.clickRes}（第 ${cap.attempt} 次即捕获）`);

    const { body, summary } = judgeRequest(cap.req, armedId, spec.id);
    summary.clickedControl = (cap.tag && cap.tag.label) || null;
    summary.input = inputNote; summary.target = targetNote;
    summary.witch = witchNote || null;
    summary.panelTask = armedTask;
    summary.serverIdAtPanel = serverIdAtPanel;
    check(`${spec.label}：捕获到**页面自己**发出的 /action 请求（CDP 只记录浏览器流量，测试的布景请求不在其中）`,
      !!cap.req, `url=${cap.req.url} initiator=${cap.req.initiator} postData=${(cap.req.postData || '').slice(0, 200)}`);
    check(`${spec.label}：请求体里带 pendingId`, summary.hasPendingId, JSON.stringify(summary));
    check(`${spec.label}：请求体里的 pendingId == 当时面板武装的 ID`, summary.match, `sent=${summary.sentPendingId} 面板武装=${armedId}`);

    // 等响应码落地
    const resp = await waitUntil(() => ({ ok: cap.req.status != null, status: cap.req.status }), { timeout: 4000, interval: 80 });
    check(`${spec.label}：该次提交被服务端接受（200）`, cap.req.status === 200, `status=${cap.req.status} body=${(await browser.getResponseBody(cap.req)) || ''}`);

    const after = await waitUntil(async () => {
      const v = await viewOf(g);
      const nowId = v.pending ? v.pending.pendingId : null;
      return { ok: v.finished || nowId !== armedId, nowId, finished: !!v.finished };
    }, { timeout: 8000, interval: 150 });
    check(`${spec.label}：服务端真的消费了该任务（不是空转）`, after.ok === true, `armedId=${armedId} → 现在=${after.nowId} finished=${after.finished}`);
    await browser.shot(path.join(OUT, `${spec.id}.png`));
  } finally {
    await api('POST', `/api/games/${g.gameId}/terminate`, { token: g.playerToken }).catch(() => {});
  }
}

// ---------------- 边界项 ----------------
/** B1 旧面板：面板停在被冻结的那一刻，服务端已被别处推进 → 真实点击旧面板必须被拒且零副作用 */
async function boundaryStaleePanel() {
  section('边界 B1 旧面板（面板已过期：屏幕上还是旧面板，服务端已是新任务）');
  const spec = { id: 'boundary-stale', surface: 'desktop', task: 'speech', role: 'villager', label: 'B1 旧面板' };
  currentSurface.v = 'desktop';
  const prep = await prepareScenario(spec);
  if (prep.err) { blockedCheck('B1 旧面板：能构造出可点击的发言面板', prep.err); return; }
  const g = prep.g;
  try {
    if (await enterGame(spec, g) === 'BLOCKED_ENTRY') return;
    const panel = await waitPanel(spec);
    if (!panel.ok) { blockedCheck('B1 旧面板：面板未能渲染', JSON.stringify(panel).slice(0, 200)); return; }
    const armedId = panel.last.pendingId;
    log(`  · 屏幕上面板武装的 ID（旧）= ${armedId}`);

    // 让页面**停止接收视图更新**：调用页面自身的 stopPolling()（产品函数，正常离局也会走它）。
    // ⚠ 不能用 Network.setBlockedURLs 来"冻结"面板：它只拦**新建**请求，已经建立的 SSE 长连接照样推帧
    //   （本轮实测过：面板照样被重建成新任务，判据因此误报）。停掉推送+轮询后，屏幕上的面板才真的停在旧状态。
    const stopped = await browser.eval(`(() => { try { stopPolling(); return 'stopped'; } catch (e) { return String(e); } })()`);
    log(`  · 已让页面停止接收视图更新：stopPolling() → ${stopped}`);
    await sleep(600);
    // "别处"（Node API）把当前任务答掉，并把对局推进到下一个新任务
    await answerAsSetup(g, { ...prep.pending, pendingId: armedId }, '别处已作答（制造旧面板）');
    let newP = null;
    for (let i = 0; i < 100 && !newP; i++) {
      await sleep(100);
      const v = await viewOf(g);
      if (v.finished) break;
      if (v.pending && v.pending.pendingId !== armedId) newP = v.pending; // 就是"切了任务"：停在这个新任务上不答
    }
    const stalePanelStillThere = await browser.eval(`(() => {
      const box = document.getElementById('action-controls');
      const armed = window.__r01Armed || [];
      return { domTask: box ? (box.dataset.task || '') : '(无)', armedNow: armed.length ? armed[armed.length - 1].pendingId : null, btn: !!document.getElementById('tmp-r01-submit') };
    })()`);
    check('B1 旧面板：屏幕上仍是旧面板（页面收不到视图更新，武装的仍是旧 ID）',
      stalePanelStillThere.armedNow === armedId, `屏幕上武装=${stalePanelStillThere.armedNow} 面板签名=${stalePanelStillThere.domTask}`);
    check('B1 旧面板：服务端此刻已换成**新任务**（旧 ID 确实过期）',
      !!newP && newP.pendingId !== armedId, `新任务=${newP && newP.task} 新 ID=${newP && newP.pendingId} 旧 ID=${armedId}`);

    const actsBefore = (((await viewOf(g)).events) || []).length;
    const cap = await clickSubmitAndCapture('发送发言|留下遗言|发言', 'B1 旧面板');
    if (cap.err) { check('B1 旧面板：真实点击旧面板的提交按钮并捕获请求', false, cap.err); return; }
    const { summary } = judgeRequest(cap.req, armedId, 'boundary-stale');
    summary.note = '屏幕上旧面板的真实点击';
    check('B1 旧面板：真实点击旧面板发出的请求体里，pendingId 就是**旧面板**武装的那个（不是服务端最新任务）',
      summary.match === true, `sent=${summary.sentPendingId} 旧面板武装=${armedId} 服务端最新=${newP && newP.pendingId}`);
    await waitUntil(() => ({ ok: cap.req.status != null }), { timeout: 4000, interval: 80 });
    const rbody = await browser.getResponseBody(cap.req);
    let rjson = null; try { rjson = rbody ? JSON.parse(rbody) : null; } catch (_) { /* 非 JSON */ }
    check('B1 旧面板：服务端拒绝旧 ID（409 + PENDING_ID_STALE/PENDING_ID_REQUIRED）',
      cap.req.status === 409 && !!(rjson && /PENDING_ID_/.test(rjson.code || '')),
      `status=${cap.req.status} code=${rjson && rjson.code} error=${rjson && rjson.error}`);
    const actsAfter = (((await viewOf(g)).events) || []).length;
    const pAfter = await livePending(g);
    check('B1 旧面板：被拒的旧答案零副作用（新任务未被消耗、事件数不增）',
      actsAfter === actsBefore && !!pAfter && pAfter.pendingId === (newP && newP.pendingId),
      `事件 ${actsBefore} → ${actsAfter}；新任务 ID ${newP && newP.pendingId} → ${pAfter && pAfter.pendingId}`);
    await browser.shot(path.join(OUT, 'boundary-stale.png'));
  } finally {
    await browser.setBlockedURLs([]).catch(() => {});
    await api('POST', `/api/games/${g.gameId}/terminate`, { token: g.playerToken }).catch(() => {});
  }
}

/** B2 快速连点：对同一个提交控件连发两次真实鼠标点击 → 只应产生 1 条请求 */
async function boundaryRapidClick() {
  section('边界 B2 快速连点（同一控件两次真实点击）');
  const spec = { id: 'boundary-rapid', surface: 'desktop', task: 'night_guard', role: 'guard', label: 'B2 快速连点' };
  currentSurface.v = 'desktop';
  const prep = await prepareScenario(spec);
  if (prep.err) { blockedCheck('B2 快速连点：能构造出可点击的守卫面板', prep.err); return; }
  const g = prep.g;
  try {
    if (await enterGame(spec, g) === 'BLOCKED_ENTRY') return;
    const panel = await waitPanel(spec);
    if (!panel.ok) { blockedCheck('B2 快速连点：面板未能渲染', JSON.stringify(panel).slice(0, 200)); return; }
    const armedId = panel.last.pendingId;
    const cands = (prep.pending.candidates) || [];
    await chooseTarget(spec, cands[0]);
    const tag = await tagControl('desktop', 'submit', '确认守护');
    if (!tag.ok) { check('B2 快速连点：提交控件可用', false, JSON.stringify(tag)); return; }
    const markReq = browser.netReqs.length;
    const r1 = await browser.realClick('#tmp-r01-submit');
    const r2 = await browser.realClick('#tmp-r01-submit');   // 立刻再点一次（真实鼠标事件）
    log(`  · 两次真实点击：realClick#1=${r1} realClick#2=${r2}`);
    await sleep(1200);
    const sent = browser.netReqs.slice(markReq);
    check('B2 快速连点：只产生 1 条 /action 请求（不重复提交）', sent.length === 1, `实际 ${sent.length} 条：${JSON.stringify(sent.map((x) => (x.postData || '').slice(0, 120)))}`);
    if (sent.length) {
      const { summary } = judgeRequest(sent[0], armedId, 'boundary-rapid');
      check('B2 快速连点：唯一那条请求带的仍是面板武装的 ID（没有漏 ID）', summary.match === true, JSON.stringify(summary));
      await waitUntil(() => ({ ok: sent[0].status != null }), { timeout: 4000, interval: 80 });
      check('B2 快速连点：该请求被服务端接受（200）', sent[0].status === 200, `status=${sent[0].status}`);
    }
    await browser.shot(path.join(OUT, 'boundary-rapid.png'));
  } finally {
    await api('POST', `/api/games/${g.gameId}/terminate`, { token: g.playerToken }).catch(() => {});
  }
}

/** B3 响应丢失：请求已发出并被服务端处理，但**响应**被丢弃（CDP 响应阶段 failRequest，不改请求体）→ 不自动重放 */
async function boundaryLostResponse() {
  section('边界 B3 响应丢失（请求在途时对局前进：不自动重放、结果不明要明说）');
  const spec = { id: 'boundary-lost', surface: 'desktop', task: 'night_guard', role: 'guard', label: 'B3 响应丢失' };
  currentSurface.v = 'desktop';
  const prep = await prepareScenario(spec);
  if (prep.err) { blockedCheck('B3 响应丢失：能构造出可点击的守卫面板', prep.err); return; }
  const g = prep.g;
  try {
    if (await enterGame(spec, g) === 'BLOCKED_ENTRY') return;
    const panel = await waitPanel(spec);
    if (!panel.ok) { blockedCheck('B3 响应丢失：面板未能渲染', JSON.stringify(panel).slice(0, 200)); return; }
    const armedId = panel.last.pendingId;
    const cands = (prep.pending.candidates) || [];
    await chooseTarget(spec, cands[0]);
    const tag = await tagControl('desktop', 'submit', '确认守护');
    if (!tag.ok) { check('B3 响应丢失：提交控件可用', false, JSON.stringify(tag)); return; }
    const markReq = browser.netReqs.length;
    // 提示行会被随后的"新任务面板重建"覆盖，所以用 MutationObserver 记下**全过程**的提示文本，
    // 断言改为"这一串历史里确实出现过失败提示"（比只读一次更严，不是放宽）
    await browser.eval(`(() => {
      window.__r01Hints = [];
      const h = document.getElementById('pending-hint');
      if (!h) return 'NO_EL';
      const rec = () => window.__r01Hints.push({ at: Date.now(), text: (h.textContent || '').slice(0, 140) });
      rec();
      new MutationObserver(rec).observe(h, { childList: true, characterData: true, subtree: true });
      return 'OK';
    })()`);
    await browser.fetchResponseFail(true);
    browser.fetchFailNext = true;              // 只让这一条请求的**响应**失败
    await browser.realClick('#tmp-r01-submit');
    const got = await waitUntil(() => ({ ok: browser.netReqs.length > markReq }), { timeout: 3000, interval: 50 });
    check('B3 响应丢失：真实点击后浏览器确实发出了请求（响应随后被丢弃）',
      got.ok === true && browser.fetchFailHits.length > 0,
      `捕获=${browser.netReqs.length - markReq} 条｜响应丢弃记录=${JSON.stringify(browser.fetchFailHits)}`);
    const sent = browser.netReqs.slice(markReq);
    if (sent.length) {
      const { summary } = judgeRequest(sent[0], armedId, 'boundary-lost');
      check('B3 响应丢失：被丢弃响应的那条请求，请求体里的 pendingId 仍是面板武装的 ID',
        summary.match === true, JSON.stringify(summary));
    }
    await browser.fetchResponseFail(false).catch(() => {});
    // 服务端视角：这条请求到达了服务端，任务被消费 ⇒ 对局前进了（"在途时切任务"真实发生）
    const advanced = await waitUntil(async () => {
      const v = await viewOf(g);
      const nowId = v.pending ? v.pending.pendingId : null;
      return { ok: v.finished || nowId !== armedId, nowId, finished: !!v.finished, task: v.pending && v.pending.task };
    }, { timeout: 8000, interval: 150 });
    check('B3 响应丢失：服务端已按这条请求推进了对局（"响应丢失 + 任务已切换"确实发生了）',
      advanced.ok === true, `armedId=${armedId} → 现在=${advanced.nowId} task=${advanced.task} finished=${advanced.finished}`);
    // 页面不得自动重放：整个窗口内页面只发过 1 条 /action
    await sleep(1500);
    const total = browser.netReqs.length - markReq;
    check('B3 响应丢失：页面**没有**自动重放那条动作（窗口内页面只发出 1 条 /action）',
      total === 1, `窗口内 /action 条数=${total}`);
    const hints = await browser.eval(`window.__r01Hints || []`);
    const hintNow = await browser.eval(`(() => { const h = document.getElementById('pending-hint'); return h ? (h.textContent || '') : ''; })()`);
    log(`  · 提示行历史（${hints.length} 条）：${JSON.stringify(hints.map((x) => x.text.slice(0, 60)))}`);
    log(`  · 点击后当前提示：${JSON.stringify(hintNow)}`);
    const said = hints.some((x) => /网络结果不明/.test(x.text));
    check('B3 响应丢失：页面明确告知"网络结果不明，已同步最新状态"（全过程提示里出现过，不静默、不假装成功）',
      said, `全过程提示=${JSON.stringify(hints.map((x) => x.text))}｜当前提示=${JSON.stringify(hintNow)}`);
    await browser.shot(path.join(OUT, 'boundary-lost.png'));
  } finally {
    await browser.fetchResponseFail(false).catch(() => {});
    await api('POST', `/api/games/${g.gameId}/terminate`, { token: g.playerToken }).catch(() => {});
  }
}

/** B4/B5 任务切换 + 刷新：旧 ID 作废、新任务的新请求带新 ID */
async function boundarySwitchAndReload() {
  section('边界 B4/B5 任务切换与刷新（新面板带新 ID；旧 ID 失效）');
  const spec = { id: 'boundary-switch', surface: 'desktop', task: 'speech', role: 'villager', label: 'B4/B5 任务切换+刷新' };
  currentSurface.v = 'desktop';
  const prep = await prepareScenario(spec);
  if (prep.err) { blockedCheck('B4/B5：能构造出可点击的发言面板', prep.err); return; }
  const g = prep.g;
  try {
    if (await enterGame(spec, g) === 'BLOCKED_ENTRY') return;
    let panel = await waitPanel(spec);
    if (!panel.ok) { blockedCheck('B4/B5：面板未能渲染', JSON.stringify(panel).slice(0, 200)); return; }
    const idA = panel.last.pendingId;
    log(`  · 任务 A（发言）面板武装 ID=${idA}`);

    // 第 1 次真实点击：提交任务 A
    const typedA = await typeInto('#action-controls textarea', '第一条：任务切换前');
    check('B4 任务切换：第一条发言文本真的进了输入框', typedA.ok === true, JSON.stringify(typedA));
    const capA = await clickSubmitAndCapture('发送发言|留下遗言|发言', 'B4 任务A');
    if (capA.err) { check('B4 任务切换：第一次真实点击提交成功', false, capA.err); return; }
    const jA = judgeRequest(capA.req, idA, 'boundary-switch-A');
    check('B4 任务切换：任务 A 的请求带 A 面板的 ID', jA.summary.match === true, JSON.stringify(jA.summary));

    // 等页面上出现**新任务**的面板（真实推送/轮询重建；记录器会记下新武装的凭据）
    // ⚠ 判据用"最后一条武装记录的 ID 变了"，**不用**增量条数：面板常常在读取基准之前就已经武装好，
    //   用 `armedN > mark + 1` 会因基准本身已包含第一条而恒假（本轮初版就是踩了这个 off-by-one）。
    const newPanel = await waitUntil(async () => {
      const v = await browser.eval(`(() => {
        const armed = window.__r01Armed || [];
        const last = armed.length ? armed[armed.length - 1] : null;
        const box = document.getElementById('action-controls');
        return { armedN: armed.length, last, domTask: box ? (box.dataset.task || '') : '' };
      })()`);
      const domTask = v.domTask || '';
      return { ...v, domTask, ok: !!v.last && v.last.pendingId !== idA && !!domTask && !!v.last.task };
    }, { label: '页面上出现新任务的面板', timeout: 20000, interval: 200 });
    check('B4 任务切换：页面自己（新推送/轮询）重建了面板并武装了新任务的 ID',
      newPanel.ok === true, `旧=${idA} 新武装=${newPanel.last && newPanel.last.pendingId} 新面板签名=${newPanel.domTask}`);
    if (!newPanel.ok) { blockedCheck('B4 任务切换：新面板未出现', JSON.stringify(newPanel).slice(0, 200)); return; }
    const idB = newPanel.last.pendingId;
    const taskB = newPanel.last.task;
    const srvB = await livePending(g);
    check('B4 任务切换：新面板武装的 ID 就是服务端当前新任务的 ID',
      srvB && srvB.pendingId === idB, `面板新武装=${idB} 服务端=${srvB && srvB.pendingId} 任务=${srvB && srvB.task}`);

    // 第 2 次真实点击：提交任务 B（不带任何测试侧补丁）
    const patB = taskB === 'vote' ? '投票' : taskB === 'witch' ? '解药|毒|空过' : taskB === 'night_guard' ? '确认守护' : taskB === 'wolf_kill' ? '投刀' : '发送发言|留下遗言|发言';
    if (['vote', 'night_guard', 'wolf_kill'].includes(taskB)) {
      const c = (srvB.candidates || []);
      if (c.length) await chooseTarget(spec, c[0]);
    } else if (['speech', 'lastwords', 'pk_speech'].includes(taskB)) {
      const typedB = await typeInto('#action-controls textarea', '第二条：切换之后');
      check('B4 任务切换：第二条发言文本真的进了输入框', typedB.ok === true, JSON.stringify(typedB));
    }
    const capB = await clickSubmitAndCapture(patB, 'B4 任务B');
    if (capB.err) { check('B4 任务切换：第二次真实点击提交成功', false, capB.err); return; }
    const jB = judgeRequest(capB.req, idB, 'boundary-switch-B');
    check('B4 任务切换：切换后的新请求带的是**新任务**的 ID（≠ 旧 ID）',
      jB.summary.match === true && jB.summary.sentPendingId !== idA,
      `sent=${jB.summary.sentPendingId} 新面板=${idB} 旧面板=${idA}`);

    await browser.shot(path.join(OUT, 'boundary-switch.png'));
  } finally {
    await api('POST', `/api/games/${g.gameId}/terminate`, { token: g.playerToken }).catch(() => {});
  }
}

/**
 * B5 刷新：刷新前那份面板 ID 必须失效，刷新后面板重新武装**当前**任务的 ID。
 * 单独用一个局（不挂在 B4 后面）：B4 提交后对局常常已经结束，没有"新待办"可刷。
 * 流程：页面渲染面板(记下 idPre) → 别处作答让服务端前进 → 等到新待办 idPost ≠ idPre
 *      → 刷新页面 → 面板应武装 idPost → 真实点击提交(200) → 回放 idPre 应被 409 拒且零副作用。
 */
async function boundaryReload() {
  section('边界 B5 刷新（旧 ID 失效、刷新后面板重新武装当前任务）');
  const spec = { id: 'boundary-reload', surface: 'desktop', task: 'speech', role: 'villager', label: 'B5 刷新' };
  currentSurface.v = 'desktop';
  for (let attempt = 1; attempt <= 6; attempt++) {
    const prep = await prepareScenario(spec);
    if (prep.err) { blockedCheck('B5 刷新：能构造出可点击的发言面板', prep.err); return; }
    const g = prep.g;
    let moved = false;
    try {
      if (await enterGame(spec, g) === 'BLOCKED_ENTRY') return;
      const panel = await waitPanel(spec);
      if (!panel.ok) { blockedCheck('B5 刷新：面板未能渲染', JSON.stringify(panel).slice(0, 200)); return; }
      const idPre = panel.last.pendingId;
      // 「别处」作答（Node API 布景）：让服务端前进，这样刷新前那份 ID 就真的过期了
      await answerAsSetup(g, { ...prep.pending, pendingId: idPre }, `B5 制造刷新前旧 ID（第 ${attempt} 次尝试）`);
      const nextP = await waitUntil(async () => {
        const v = await viewOf(g);
        if (v.finished) return { ok: false, finished: true };
        const p = v.pending;
        return p && p.pendingId !== idPre ? { ok: true, pending: p } : { ok: false, task: v.pending && v.pending.task };
      }, { timeout: 10000, interval: 150 });
      if (!nextP.ok) { log(`  · 第 ${attempt} 次尝试：作答后没有新的待办（finished=${!!nextP.finished}），换 seed 重来`); continue; }
      moved = true;
      const idPost = nextP.pending.pendingId;
      const taskPost = nextP.pending.task;
      log(`  · 刷新前旧 ID=${idPre}｜服务端新任务=${taskPost} 新 ID=${idPost}`);
      await browser.reload();
      const p2 = await waitUntil(async () => {
        const v = await browser.eval(`(() => {
          const armed = window.__r01Armed || [];
          const last = armed.length ? armed[armed.length - 1] : null;
          const box = document.getElementById('action-controls');
          const shown = document.querySelector('.screen:not(.hidden)');
          return { armedN: armed.length, last, domTask: box ? (box.dataset.task || '') : '', screen: shown && shown.id };
        })()`);
        return { ...v, ok: !!v.last && v.last.pendingId === idPost && !!v.domTask };
      }, { label: '刷新后面板重新武装当前任务', timeout: 20000, interval: 200 });
      check('B5 刷新：刷新后面板重新武装了**当前**任务的 ID（不是刷新前那份旧 ID）',
        p2.ok === true, `刷新前旧 ID=${idPre} 服务端当前 ID=${idPost}（task=${taskPost}）刷新后面板武装=${p2.last && p2.last.pendingId} 屏=${p2.screen} 面板签名=${p2.domTask}`);
      if (!p2.ok) { blockedCheck('B5 刷新：刷新后面板未按当前任务重建', JSON.stringify(p2).slice(0, 200)); return; }
      // 刷新后真实点击提交（走当前面板凭据）
      if (['vote', 'pk_vote', 'night_guard', 'wolf_kill'].includes(taskPost) && (nextP.pending.candidates || []).length) await chooseTarget(spec, nextP.pending.candidates[0]);
      else if (['speech', 'lastwords', 'pk_speech'].includes(taskPost)) {
        const typedC = await typeInto('#action-controls textarea', '刷新之后');
        check('B5 刷新：刷新后的发言文本真的进了输入框', typedC.ok === true, JSON.stringify(typedC));
      } else { blockedCheck('B5 刷新：刷新后的任务类型未在脚手架内实现点击', `task=${taskPost}`); return; }
      const patC = /speech|lastwords|pk_speech/.test(taskPost) ? '发送发言|留下遗言|发言'
        : taskPost === 'vote' ? '投票' : taskPost === 'night_guard' ? '确认守护' : taskPost === 'wolf_kill' ? '投刀' : '确认|提交';
      const capC = await clickSubmitAndCapture(patC, 'B5 刷新后');
      if (capC.err) { check('B5 刷新：刷新后真实点击提交', false, capC.err); return; }
      const jC = judgeRequest(capC.req, idPost, 'boundary-reload-C');
      jC.summary.taskC = taskPost;
      check('B5 刷新：刷新后真实点击发出的请求带的是刷新后面板武装的 ID', jC.summary.match === true, JSON.stringify(jC.summary));
      await waitUntil(() => ({ ok: capC.req.status != null }), { timeout: 4000, interval: 80 });
      check('B5 刷新：刷新后的提交被服务端接受（200）', capC.req.status === 200,
        `status=${capC.req.status} body=${(await browser.getResponseBody(capC.req)) || ''}`);
      // 旧 ID 回放：用页面自身的提交函数，ID 取"刷新前面板真实武装过的那一个"（Node 侧留存，不是测试伪造）
      const markReplay = browser.netReqs.length;
      const replay = await browser.eval(`(async () => {
        try { await submitHumanAction(Object.freeze({ gameId: state.game.gameId, token: state.game.playerToken, pendingId: ${JSON.stringify(idPre)}, task: ${JSON.stringify(taskPost)} }), { text: '旧凭据回放' }); }
        catch (e) { return { status: e.status || null, message: String(e.message || '').slice(0, 160) }; }
        return { accepted: true };
      })()`);
      const replayReq = browser.netReqs.length > markReplay ? browser.netReqs[browser.netReqs.length - 1] : null;
      if (replayReq) {
        await waitUntil(() => ({ ok: replayReq.status != null }), { timeout: 4000, interval: 80 });
        replay.serverStatus = replayReq.status;
        replay.serverBody = await browser.getResponseBody(replayReq);
        replay.requestPostData = replayReq.postData;
      }
      log(`  · 旧 ID 回放（测试侧触发页面自身提交函数回放"刷新前页面武装过的 ID"）：${JSON.stringify(replay)}`);
      check('B5 刷新：刷新前那份旧 ID 再提交会被服务端拒绝（4xx）',
        !!(replay && (replay.status === 409 || (replay.serverStatus >= 400 && replay.serverStatus < 500))),
        `${JSON.stringify(replay)}｜回放请求体=${replayReq ? replayReq.postData : '(未捕获)'}（回放方式：测试侧调用页面自身 submitHumanAction；ID 是刷新前记录器记下的真实值，不是测试构造的字符串）`);
      const afterReplay = await livePending(g);
      check('B5 刷新：旧 ID 被拒后不会消耗对局状态（服务端任务不是被这次回放吃掉的）',
        !afterReplay || afterReplay.pendingId !== idPre,
        `当前任务 ID=${afterReplay && afterReplay.pendingId}（旧 ID=${idPre}）`);
      await browser.shot(path.join(OUT, 'boundary-reload.png'));
    } finally {
      await api('POST', `/api/games/${g.gameId}/terminate`, { token: g.playerToken }).catch(() => {});
    }
    if (moved) return;
  }
  blockedCheck('B5 刷新：6 次尝试内都没拿到"作答后仍有新待办"的局');
}

// ---------------- 先红后绿 ----------------
/**
 * 测试侧模拟：在页面里把提交函数的 pendingId 抹掉，再走一次**真实点击**。
 * 预期：本脚本判红（"请求体里带 pendingId" 那条失败）并打印真实请求体 → 退出码 1。
 * ⚠ 这是测试构造，模拟的是"前端没接线"这种坏情况，**不是产品缺陷**。
 */
async function redSelfCheck() {
  section('先红自检：测试侧模拟"前端没带 pendingId"（--simulate=missing-id）');
  log('  ⚠ 本条为**测试侧模拟**：页面里的 submitHumanAction 被测试注入的补丁抹掉了 pendingId（仅此一处差异），');
  log('    模拟指导文档 R01 描述的"后端要求、前端没提交"的历史断点；这不是产品现状，也不是产品缺陷。');
  const spec = { id: 'red-simulated', surface: 'desktop', task: 'speech', role: 'villager', label: '红自检·模拟缺 ID' };
  currentSurface.v = 'desktop';
  const prep = await prepareScenario(spec);
  if (prep.err) { blockedCheck('红自检：能构造出可点击的发言面板', prep.err); return; }
  const g = prep.g;
  try {
    if (await enterGame(spec, g) === 'BLOCKED_ENTRY') return;
    const patched = await browser.eval(`!!window.__r01Simulated`);
    check('红自检：测试侧补丁确实装上了（submitHumanAction 会抹掉 pendingId）', patched === true, `__r01Simulated=${patched}`);
    const panel = await waitPanel(spec);
    if (!panel.ok) { blockedCheck('红自检：面板未能渲染', JSON.stringify(panel).slice(0, 200)); return; }
    const armedId = panel.last.pendingId;
    const typedRed = await typeInto('#action-controls textarea', '红自检：这一条故意不带 ID');
    check('红自检：文本真的进了输入框', typedRed.ok === true, JSON.stringify(typedRed));
    const cap = await clickSubmitAndCapture('发送发言|留下遗言|发言', '红自检');
    if (cap.err) { check('红自检：真实点击后捕获到请求', false, cap.err); return; }
    const { summary } = judgeRequest(cap.req, armedId, 'red-simulated');
    summary.note = '测试侧模拟：补丁抹掉 pendingId';
    log(`  · 真实请求体（模拟缺 ID）：${cap.req.postData}`);
    check('红自检：请求体里带 pendingId', summary.hasPendingId, JSON.stringify(summary));
    check('红自检：请求体里的 pendingId == 当时面板武装的 ID', summary.match, `sent=${summary.sentPendingId} 面板武装=${armedId}`);
    await waitUntil(() => ({ ok: cap.req.status != null }), { timeout: 4000, interval: 80 });
    check('红自检：服务端以 409 PENDING_ID_REQUIRED 拒绝缺 ID 的提交（说明"缺 ID"是可观测的坏情况）',
      cap.req.status === 409, `status=${cap.req.status} body=${(await browser.getResponseBody(cap.req)) || ''}`);
    await browser.shot(path.join(OUT, 'red-simulated.png'));
  } finally {
    await api('POST', `/api/games/${g.gameId}/terminate`, { token: g.playerToken }).catch(() => {});
  }
}

// ---------------- 主流程 ----------------
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  log(`R01 验收：人类行动 pendingId 是否来自"当时面板武装的任务"`);
  log(`时间=${new Date().toISOString()}｜node=${process.version}｜cwd=${process.cwd()}`);
  log(`端口：UI=${PORT} CDP=${CDP_PORT}｜数据目录=${DATA_DIR}｜截图/日志=${OUT}`);
  if (SIMULATE) log(`⚠ 运行模式：--simulate=${SIMULATE}（先红后绿里的"红"，属于测试侧模拟）`);

  // ---- 环境门槛（环境不满足 → 2，绝不当 0）----
  if (!CHROME) { log('✗ 环境不满足：未找到 Chrome/Edge（可用 WW_CHROME=<路径> 指定，WW_CHROME=none 视为缺浏览器）'); return EXIT_ENV; }
  log(`浏览器内核：${CHROME}`);
  if (await portOccupied(PORT)) { log(`✗ 环境不满足：UI 端口 ${PORT} 已被占用（占用者会冒充本次被测服务端）`); return EXIT_ENV; }
  if (await portOccupied(CDP_PORT)) { log(`✗ 环境不满足：CDP 端口 ${CDP_PORT} 已被占用（可能是残留的浏览器）`); return EXIT_ENV; }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); fs.mkdirSync(DATA_DIR, { recursive: true }); }
  catch (e) { log(`✗ 环境不满足：数据目录不可写 ${DATA_DIR}：${e.message}`); return EXIT_ENV; }

  const srv = await startServer();
  if (!srv.ok) { log(`✗ 环境不满足：服务端未就绪 exitCode=${srv.exitCode} stderr=${(serverErr || '(空)').slice(-300)}`); return EXIT_ENV; }
  log('✓ 服务端就绪（本次启动的进程持有端口）');

  try {
    browser = await Browser.launch(CDP_PORT, CHROME);
    log('✓ 浏览器已启动（headless，CDP 驱动）');

    if (SIMULATE === 'missing-id') {
      await redSelfCheck();
    } else {
      for (const spec of selected) {
        try { await runScenario(spec); }
        catch (e) { check(`${spec.label}：场景执行未抛异常`, false, String((e && e.stack) || e).slice(0, 400)); }
      }
      if (RUN_BOUNDARIES) for (const fn of [boundaryStaleePanel, boundaryRapidClick, boundaryLostResponse, boundarySwitchAndReload, boundaryReload]) {
        try { await fn(); }
        catch (e) { check(`${fn.name}：边界项执行未抛异常`, false, String((e && e.stack) || e).slice(0, 400)); }
      }
    }

    // 页面异常如实报（不删记录）
    if (browser.exceptions.length) log(`  · 页面未捕获异常 ${browser.exceptions.length} 条：${JSON.stringify(browser.exceptions.slice(0, 3))}`);
    if (browser.consoleErrors.length) log(`  · 控制台 error/warning ${browser.consoleErrors.length} 条：${JSON.stringify(browser.consoleErrors.slice(0, 3))}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server && server.exitCode === null) {
      await new Promise((res) => { const t = setTimeout(res, 8000); server.once('exit', () => { clearTimeout(t); res(); }); server.kill(); });
    }
  }

  // ---- 汇总 ----
  section('汇总');
  log(`断言：${checks.filter((c) => c.ok === true).length} 条通过 / ${fails} 条失败 / ${blocked} 项未验证`);
  for (const s of captured) log(`  · 证据 ${s.where}：${JSON.stringify(s)}`);
  const green = fails === 0 && blocked === 0;
  const code = SIMULATE === 'missing-id' ? (fails > 0 ? EXIT_FAIL : EXIT_OK)
    : (fails > 0 ? EXIT_FAIL : (blocked > 0 ? EXIT_HUMAN : EXIT_OK));
  log(green ? '结论：全绿 ✓' : `结论：${fails ? `${fails} 条断言失败` : ''}${blocked ? `${fails ? '，' : ''}${blocked} 项未验证（需人工介入）` : ''}`);
  log(SIMULATE === 'missing-id'
    ? (fails > 0 ? '红自检读数：脚本确实抓住了"缺 pendingId"这种坏情况（退出码 1）✓' : '红自检读数：**脚本没抓住缺 ID**（这本身是脚本缺陷）✗')
    : `退出码=${code}`);
  return code;
}

let exitCode = EXIT_ENV;
main().then((c) => { exitCode = c; }).catch((e) => {
  log('脚本异常：' + String((e && e.stack) || e));
  exitCode = EXIT_FAIL;
}).finally(() => {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `r01-pendingid-${ts}.log`), lines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(OUT, `r01-pendingid-${ts}.json`), JSON.stringify({
      at: new Date().toISOString(), mode: SIMULATE || 'normal', exitCode,
      fails, blocked, checks, captured,
      pageExceptions: browser ? browser.exceptions : [],
      consoleErrors: browser ? browser.consoleErrors : [],
    }, null, 2), 'utf8');
  } catch (e) { console.error('写日志失败：' + e.message); }
  // 刻意不用 process.exit：Windows 上子进程 stdio 未释放时强退会触发 libuv 断言
  process.exitCode = exitCode;
});
