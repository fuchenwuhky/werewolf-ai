/**
 * ui-check.js — 用真实无头浏览器验收界面（零依赖）
 *
 * 为什么需要它：`npm test` 只能验证"服务端 + 源码契约"，验证不了界面。这个项目里最容易骗过
 * 单元测试的恰恰是前端问题，而且都在这一轮真跑浏览器时才暴露：
 *   · service worker 首次安装时 `clients.claim()` 触发 controllerchange → 页面**自我重载**，
 *     把用户的第一下点击吞掉（"点了没反应"）；
 *   · 应用还在初始化（拉 /api/meta）时按钮已可点，点了毫无反应；
 *   · mock 标志、教练点评的降级标注是否真的显示在界面上。
 *
 * 实现方式：不装 playwright/puppeteer（本项目硬约束零运行时依赖），直接用 DevTools Protocol
 * 驱动机器上已有的 Chrome/Edge；Node ≥22 自带 WebSocket，所以整条链路没有第三方包。
 *
 * 用法：
 *   npm run ui:check            # 快速：慢启动守卫、中英文、离线横幅、手机版、控制台无异常
 *   npm run ui:check -- --full  # 追加：观战 Mock 局跑到终局 + 教练点评 + 存档 mock 标志
 *   npm run ui:check -- --strict # 严格模式（FIN-12 发布验收，见下）
 *   WW_CHROME=<浏览器路径> 可指定内核；WW_CHROME=none 可强制"无浏览器"（用于自测两种模式）。
 *
 * ── 两种退出语义（FIN-12，计划书 §15.1："缺浏览器就失败／未执行，不得绿灯放行"）──
 * · 默认宽松模式：找不到浏览器 → 打印说明并以 0 退出（不阻塞日常 CI）；运行中检查失败 → 1。
 * · --strict 严格模式：浏览器缺失 / 启动失败 / 任何规划段落未执行（中途异常中断了后续检查）
 *   → 以非零码退出：2 = 存在"未执行"项（哪怕没有任何检查失败）；1 = 检查实际执行且有失败。
 *   退出前列出全部未执行的规划段落，未执行项不得按通过计数。
 *
 * 截图输出到 logs/ui-shots/（已 gitignore 的运行时目录）。
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const FULL = process.argv.includes('--full');
const STRICT = process.argv.includes('--strict');
const SHOTS = path.join(ROOT, 'logs', 'ui-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = process.env.WW_CHROME === 'none' ? null : (process.env.WW_CHROME || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }));

// ---------- 结果收集 ----------
let fails = 0;
const lines = [];
const sectionsDone = []; // 实际执行到的段落（由 log 拦截 "=== X ===" 标题记录）
const log = (...a) => {
  const l = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  lines.push(l); console.log(l);
  const m = l.match(/===\s*(.+?)\s*===/);
  if (m) sectionsDone.push(m[1]);
};
const check = (label, cond, extra = '') => { if (!cond) fails++; log(`${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`); };

// ---------- FIX-16：预期内未捕获异常的**登记表**（条数 + 形态双钉，绝不删记录） ----------
/**
 * 背景：F5（空刀）那一段曾经在页面里真实产生未捕获的 Promise 拒绝，当时的做法是
 * `b.exceptions.splice(beforeExc)` 把这一段新增的条目**从数组里裁掉**，好让全局
 * "全程无未捕获 JS 异常"保持绿。危害：这一段里**任何其它**未捕获异常会被一并抹掉 ⇒
 * 检查在整段内失明（计划书 §11.3 明令禁止"页面异常不得从数组中删除以制造无异常"）。
 *
 * 现在改为"登记 + 精确断言"：数组一律只读；预期内的条目必须在下面逐条登记（条数上限 + 消息形态），
 * 全局断言只容忍登记表内的条目，**任何**预期外的条目（包括人为注入的）都会让全局断言变红。
 *
 * 实测基线（本次交付，连跑两次一致）：空刀段新增的未捕获异常为 **0 条**
 * —— 前端 FIX-15（web/app.js 的 pickedTarget/confirmBtn）已经把"未选目标点投刀"变成
 * 可读提示而不是未捕获拒绝（web/app.js:3435-3438 抛出、3456-3461 捕获并写进 #pending-hint）。
 * 所以下面的登记值是 0：**任何**新条目（含该拒绝若哪天退化回来）都算预期外。
 * 若将来确有必要容忍 N 条，只改这里的 max 与 shape，并在报告里写明理由与出处。
 */
const F5_EXPECT = {
  label: 'F5 空刀（真实点击）',
  max: 0, // 登记的预期条数（0 = 一条都不容忍）
  // 形态判据：万一"未选目标点投刀"退化回未捕获拒绝，其消息必须来自空刀守卫本身
  // （web/app.js:3436-3438 的 pickedTarget('刀口', '空刀') 文案）。
  shape: /请先点一个座位|刀口/,
};
const EXPECTED_UNCAUGHT = [
  { label: `${F5_EXPECT.label} ≤${F5_EXPECT.max} 条`, max: F5_EXPECT.max, shape: F5_EXPECT.shape },
];

// ---------- FIX-18：条件等待助手（把"固定 sleep 再看一眼状态"换成"等到状态成立"） ----------

/** predicate 返回值的判定：对象含 `ok` 字段时以 ok 为准（并可携带实测值），其余按真值判断。 */
function probeOk(v) { return !!(v && typeof v === 'object' && 'ok' in v ? v.ok : v); }

/**
 * 条件等待：轮询到条件成立即返回实测值；**超时则带着最后一次实测值抛错**（绝不静默继续）。
 * 给"前置条件不成立就没有继续意义"的地方用（导航就绪、辅助 target 的注入异常落地）。
 */
async function waitFor(predicate, { timeout = 5000, interval = 100, label = '条件' } = {}) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    try { last = await predicate(); } catch (e) { last = { ok: false, err: String((e && e.message) || e) }; }
    if (probeOk(last)) return last;
    if (Date.now() - t0 >= timeout) {
      const err = new Error(`等待超时（${label}，${timeout}ms 内未成立）：最后一次实测=${JSON.stringify(last)}`);
      err.measured = last;
      throw err;
    }
    await sleep(interval);
  }
}

/**
 * 条件等待 + 断言（FIX-18 的主力）：成立即 ✓（附实际耗时）；超时则 ✗ 并**打印最后一次实测值**，
 * 但不中断后续检查（后面真正的断言仍会照常跑并给出实测值）。
 * 为什么用它替换固定 sleep：sleep 太短 → 竞态变红，然后被"再加长一点"掩盖；sleep 太长 → 白等。
 * 条件化之后等待时长由页面真实状态决定，且超时诊断里带实测值。
 */
async function waitCheck(label, predicate, { timeout = 3000, interval = 100 } = {}) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    try { last = await predicate(); } catch (e) { last = { ok: false, err: String((e && e.message) || e) }; }
    if (probeOk(last)) { check(label, true, `${Date.now() - t0}ms 内成立`); return last; }
    if (Date.now() - t0 >= timeout) {
      check(label, false, `超时 ${timeout}ms，最后一次实测=${JSON.stringify(last)}`);
      return last;
    }
    await sleep(interval);
  }
}

// ---------- FIX-17：几何 / 遮挡断言 ----------
/**
 * 几何四联断言（计划书 §11.3）：可见 + 非零尺寸 + 与视口相交（必要时整个在视口内）
 * + 中心点被 elementFromPoint 命中它自己或其子孙（= 没被别的图层压住）。
 * 为什么必须量：只查 DOM 或文字时，"盒子塌成 2px""被遮罩压住点不动""整块在视口外"
 * 全都能过验收 —— 这三类恰好是本项目出过的真实事故。
 * 失败时**必须**打印实测数值（整个探针对象，含 w/h/left/top/hit/coveredBy），不接受只打"失败"。
 */
function checkGeometry(label, g, opts = {}) {
  const { minW = 1, minH = 1, requireOverlap = true, requireCenter = true, requireFull = false, requireHitSelf = true } = opts;
  const ok = !!g && g.found === true
    && g.w >= minW && g.h >= minH
    && g.display !== 'none' && g.visibility !== 'hidden' && Number(g.opacity) > 0
    && (!requireOverlap || (g.overlapW > 0 && g.overlapH > 0))
    && (!requireCenter || g.centerInViewport === true)
    && (!requireFull || g.fullyInViewport === true)
    && (!requireHitSelf || g.hitSelf === true);
  check(label, ok, JSON.stringify(g));
  return ok;
}

/**
 * 规划段落清单（严格模式的"未执行"判定依据）。
 * 维护约定：在本脚本里新增/改名 `=== 段落 ===` 标题时必须同步这里——
 * 清单里的段落没有对应标题会导致严格模式永远报"未执行"（fail-closed，需有意识地更新）。
 */
const PLANNED_SECTIONS = [
  '慢启动守卫（接口人为延迟 1.5s）',
  '设置页',
  'FIX-08 Esc 关浮层（真实按键）',
  '角色图鉴',
  '中英文切换',
  '离线',
  '离线能力',
  '档案回收区（删除后可恢复）',
  'FIX-10 偏好保存 409 自恢复',
  '手机版',
  '手机端档案回收区（390×844）',
  'FIX-08 手机端 Esc 关浮层（真实按键）',
  'FIX-10/FIX-15 手机端（409 自恢复 + 目标必选提示）',
  ...(FULL ? ['观战 Mock 局跑到终局（--full）'] : []),
  'P4-1 恢复卡片详情',
  'P4-4 终止后刷新',
  'P4-6 推送降级状态条（单例）',
  'P4-3 空刀拦截（真实点击）',
  'FIX-07 清除标注走真 DELETE',
  'P5 手机端进入对局',
  '截图矩阵（320×568 小屏与玩家中心，计划书第 83 行）',
  '触点几何门禁（真实渲染高度，计划书 §3）',
  '浏览器控制台',
];

function unexecutedSections() {
  return PLANNED_SECTIONS.filter((s) => !sectionsDone.includes(s));
}
/** 打印未执行项并返回清单（严格模式退出码判定用） */
function reportUnexecuted(prefix) {
  const missing = unexecutedSections();
  if (!missing.length) return [];
  log(`${prefix}以下规划检查未执行（未执行不得按通过计数）：`);
  for (const s of missing) log(`  · 未执行: ${s}`);
  return missing;
}

// ---------- 极简 CDP 客户端 ----------
/** CDP 异常事件 → 可读一行（主会话与辅助会话共用同一份格式化，避免两边的判据不一致） */
const fmtException = (p) => {
  const d = p.exceptionDetails || {};
  return `${d.text || ''} ${(d.exception && d.exception.description) || ''}`.trim();
};
/** CDP console 事件 → 可读一行 */
const fmtConsole = (p) => `[${p.type}] ` + (p.args || []).map((a) => a.value || a.description || a.type).join(' ');

class Browser {
  constructor() {
    this.id = 0; this.pending = new Map();
    this.exceptions = []; this.consoleErrors = []; this.failedRequests = [];
    // 辅助会话（FIX-16 检测器自证）的异常/console 桶：按 sessionId 分开，
    // 这样"在别处注入一个意外异常"不会污染主会话的验收证据。
    this.auxBySession = new Map();
  }

  static async launch(port, chrome) {
    const b = new Browser();
    b.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-ui-'));
    b.proc = spawn(chrome, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--mute-audio',
      `--remote-debugging-port=${port}`, `--user-data-dir=${b.userDataDir}`,
      '--window-size=1440,900', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    // 启动失败（路径不存在/权限不足）必须走正常异常路径，不能让无人监听的 'error' 事件
    // 直接炸掉进程——严格模式要在退出前列出未执行项，宽松模式也要给出可读错误。
    let spawnError = null;
    b.proc.on('error', (e) => { spawnError = e; });
    let version = null;
    for (let i = 0; i < 60; i++) {
      if (spawnError) break;
      try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch (_) { await sleep(200); }
    }
    if (!version) throw new Error(spawnError ? `浏览器启动失败：${spawnError.message}` : 'DevTools 端口未就绪');
    b.browserWs = version.webSocketDebuggerUrl;
    await new Promise((resolve, reject) => {
      b.ws = new WebSocket(b.browserWs);
      b.ws.addEventListener('open', () => resolve());
      b.ws.addEventListener('error', () => reject(new Error('调试连接失败')));
      b.ws.addEventListener('message', (ev) => b._onMessage(JSON.parse(ev.data)));
    });
    const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
    const att = await b.send('Target.attachToTarget', { targetId, flatten: true });
    b.sessionId = att.sessionId;
    for (const m of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable']) await b.send(m, {}, b.sessionId);
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
    // 记录器按会话分桶：辅助 target（FIX-16 检测器自证）的异常进 auxBySession，
    // 绝不混进主会话的 exceptions —— 否则"自证"本身就会把门禁弄红。
    const sid = msg.sessionId;
    if (sid && sid !== this.sessionId) {
      let bucket = this.auxBySession.get(sid);
      if (!bucket) { bucket = { exceptions: [], consoleErrors: [] }; this.auxBySession.set(sid, bucket); }
      if (msg.method === 'Runtime.exceptionThrown') bucket.exceptions.push(fmtException(p));
      else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(p.type)) bucket.consoleErrors.push(fmtConsole(p));
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      this.exceptions.push(fmtException(p));
    } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(p.type)) {
      this.consoleErrors.push(fmtConsole(p));
    } else if (msg.method === 'Network.loadingFailed' && !/favicon/.test(p.requestId || '')) {
      this.failedRequests.push(`${p.type} ${p.errorText}`);
    }
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

  /**
   * 导航并等到"应用初始化放行"（FIX-18：不再固定睡 settle 毫秒）。
   * 页面里有明确就绪标志（web/index.html 与 web/m/index.html 的加载守卫都看 `window.__wwReady`），
   * 所以这里能条件化：settle 的语义从"睡多久"变成"最多等多久"。
   * 超时不让整轮中断（真正的判红交给后面各段的具体断言），但会打一行可读提示。
   */
  async goto(url, settle = 1500) {
    await this.send('Page.navigate', { url }, this.sessionId);
    try {
      await waitFor(async () => await this.evalIn(this.sessionId, `(() => {
        const st = document.readyState;
        return { ok: st === 'complete' && window.__wwReady === true, readyState: st, wwReady: window.__wwReady === true, href: location.pathname };
      })()`), { label: `导航就绪 ${url}`, timeout: settle + 3000, interval: 50 });
    } catch (e) {
      log(`  · 注意：${e.message}`);
    }
  }

  async evalIn(sessionId, expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error('页面 JS 抛错: ' + (r.exceptionDetails.text || ''));
    return r.result && r.result.value;
  }

  async eval(expr) { return this.evalIn(this.sessionId, expr); }

  /**
   * 几何 / 遮挡探针（FIX-17）：一次取回"可见、非零尺寸、与视口相交、中心点在视口内、
   * 中心点被 elementFromPoint 命中它自己或其子孙"这五件事的**实测值**。
   * elementFromPoint 命中自己或子孙 = 没被别的图层压住 —— 这正是"按钮点不动/被遮罩压住"
   * 的判据，也是 el.click() 合成事件永远测不出来的那部分。
   * scroll=true 时先滚进视口再量（量的是"滚过去之后是不是真的看得见、点得到"）。
   */
  probe(sel, { scroll = false } = {}) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return { found: false, sel: ${JSON.stringify(sel)} };
      if (${scroll ? 'true' : 'false'}) el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const vpW = window.innerWidth, vpH = window.innerHeight;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const centerInViewport = cx >= 0 && cy >= 0 && cx < vpW && cy < vpH;
      const hit = centerInViewport ? document.elementFromPoint(cx, cy) : null;
      const desc = (n) => !n ? null : (n.id ? '#' + n.id
        : n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\\s+/).join('.') : ''));
      const selfHit = !!hit && (hit === el || el.contains(hit));
      return {
        found: true, sel: ${JSON.stringify(sel)},
        w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
        left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom),
        vpW, vpH,
        overlapW: Math.round(Math.max(0, Math.min(r.right, vpW) - Math.max(r.left, 0))),
        overlapH: Math.round(Math.max(0, Math.min(r.bottom, vpH) - Math.max(r.top, 0))),
        centerInViewport, fullyInViewport: r.left >= 0 && r.top >= 0 && r.right <= vpW && r.bottom <= vpH,
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity, position: cs.position,
        center: { x: Math.round(cx), y: Math.round(cy) },
        hit: desc(hit), hitSelf: selfHit,
        coveredBy: hit && !selfHit ? desc(hit) : null,
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
      };
    })()`);
  }

  /**
   * 离线模拟助手（FIX-18）：真断网 + 状态覆盖，两件一起做，并如实回报每一步的实际结果。
   *  · Network.emulateNetworkConditions：浏览器侧所有请求真的发不出去（fetch 立刻失败）——这才是"断网"本身；
   *  · Network.overrideNetworkState：覆盖 navigator.onLine / connectionType，页面才收得到
   *    online/offline 事件（只做前者时应用完全无感，见 P4-6 段的实测注释）。
   * 返回模拟结果是为了让断言基于**实际观测到的状态**，而不是假设它生效。
   */
  async emulateOffline(on) {
    const out = { offline: on };
    try {
      await this.send('Network.emulateNetworkConditions',
        { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, this.sessionId);
      out.networkConditions = 'ok';
    } catch (e) { out.networkConditions = '失败: ' + e.message; }
    try {
      await this.send('Network.overrideNetworkState',
        { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: on ? 'none' : 'wifi' }, this.sessionId);
      out.overrideNetworkState = 'ok';
    } catch (e) { out.overrideNetworkState = '失败: ' + e.message; }
    return out;
  }

  /** 新开一个独立 target（辅助会话）：自带异常桶，不污染主会话的验收证据。 */
  async newSession(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Runtime.enable', {}, sessionId);
    return { targetId, sessionId };
  }

  /**
   * FIX-16 的**反向验证（常驻版）**：开一个辅助 target，往里注入一条预期外的未捕获异常，
   * 确认 ① 记录器抓得到它；② 用全局断言的那条判据判定它"不在登记表内"（= 会被判红）；
   * ③ 它不会污染主会话的 exceptions（分桶有效）。
   * 为什么常驻而不是一次性手工注入：手工注入只能证明"我那次跑的时候检测器活着"；
   * 常驻后每轮 ui:check 都自证"全程无未捕获异常"这条断言不是空转。
   */
  async assertUncaughtDetector() {
    const INJECTED = '注入的意外异常（FIX-16 检测器自证）';
    const mainBefore = this.exceptions.length;
    const { targetId, sessionId } = await this.newSession();
    try {
      await this.evalIn(sessionId, `(setTimeout(() => { throw new Error(${JSON.stringify(INJECTED)}); }, 0), 'armed')`);
      await waitFor(async () => {
        const bkt = this.auxBySession.get(sessionId);
        return { ok: !!(bkt && bkt.exceptions.length), caught: bkt ? bkt.exceptions.length : 0 };
      }, { label: '辅助 target 的注入异常落地', timeout: 5000, interval: 50 });
      const bucket = this.auxBySession.get(sessionId) || { exceptions: [] };
      const joined = bucket.exceptions.join(' | ');
      return {
        caught: bucket.exceptions.length,
        injectedPresent: /注入的意外异常/.test(joined),
        // 用**全局断言用的同一条判据**判定：命中登记表才不算预期外 —— 注入的这条不该命中
        matchedExpected: EXPECTED_UNCAUGHT.some((e) => e.shape.test(joined)),
        isolated: this.exceptions.length === mainBefore,
        mainCount: this.exceptions.length,
        detail: bucket.exceptions.slice(0, 2),
      };
    } finally {
      try { await this.send('Target.closeTarget', { targetId }); } catch (_) { /* 关不掉也不影响主流程 */ }
    }
  }

  click(sel) {
    return this.eval(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return 'NOT_FOUND'; el.scrollIntoView({block:'center'}); el.click(); return 'OK'; })()`);
  }

  /** 真实鼠标点击（走 CDP Input 域，会产生完整命中测试）。
   *  为什么必须有一个：click() 用的是 el.click() 合成事件，会**绕过命中测试**——
   *  被别的图层压住、pointer-events:none、坐标算错这类问题它一律测不出来。
   *  设置页复选框"点了勾不上"那次，状态其实一直是翻转的，问题在视觉上，
   *  但真被别的层挡住时也需要这个方法才能复现。 */
  /** 真实鼠标悬停（CDP Input 事件）：`:hover` 样式只对真事件生效，合成 el.dispatchEvent 查不出来 */
  async realHover(sel) {
    const box = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) return 'NOT_FOUND';
    await this.send('Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', clickCount: 0 },
      this.sessionId);
    return 'OK';
  }

  /**
   * 真实鼠标点击（CDP Input 事件）。
   * FIX-17：点之前先做**命中测试**（尺寸 / 中心点在视口内 / elementFromPoint 命中它自己或子孙）。
   * 以前只在拿不到元素时返回 NOT_FOUND，元素存在但 0×0 或整个被别层压住时，
   * 会在 (0,0) 发一次鼠标事件然后返回 OK —— 那是"假装点到了"，正是 el.click() 的老毛病换了个写法。
   * 现在这种情形返回 NOT_CLICKABLE:<实测值> 且**不发点击**：调用方的效果断言会立刻变红，
   * 而不是被一个假 OK 蒙过去。返回值 'OK' 才代表"真的把鼠标按在了它身上"。
   */
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
        x: cx, y: cy,
        w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
        inVp: cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight,
        hitSelf: !!hit && (hit === el || el.contains(hit)),
        coveredBy: hit && !(hit === el || el.contains(hit)) ? desc(hit) : null,
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
    return 'OK';
  }

  setViewport(width, height, mobile) { return this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }, this.sessionId); }
  setLatency(ms) { return this.send('Network.emulateNetworkConditions', { offline: false, latency: ms, downloadThroughput: -1, uploadThroughput: -1 }, this.sessionId); }
  /** 兼容旧调用点：断网/恢复一律走 emulateOffline（真断网 + navigator.onLine 覆盖） */
  setOffline(on) { return this.emulateOffline(on); }

  /**
   * 真实按键（走 CDP Input 域，isTrusted=true，会触发页面里的 keydown 监听）。
   * 为什么必须真实按键：`el.dispatchEvent(new KeyboardEvent('keydown',...))` 是合成事件，
   * 只能证明"监听器被调用"，证明不了"按键真的能关掉弹层"（命中测试、默认行为、preventDefault
   * 的影响都在真实输入管线里）。Esc 关弹层这条修复需要后者。
   */
  async pressKey(key) {
    const map = {
      Escape: { code: 'Escape', keyCode: 27 },
      Enter: { code: 'Enter', keyCode: 13 },
      Tab: { code: 'Tab', keyCode: 9 },
    };
    const k = map[key];
    if (!k) throw new Error(`pressKey 不支持 ${key}（按需在 ui-check 里补键码）`);
    const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: 0 };
    await this.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' }, this.sessionId);
    await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, this.sessionId);
    return 'OK';
  }

  /** 真实鼠标点击元素矩形内的**相对位置**（fx/fy ∈ 0..1）。
   *  realClick 点的是元素中心，而弹窗恰好盖住遮罩中心 —— 要测"点遮罩空白处能关"，
   *  只能点到遮罩的边角（点中心会点到弹窗上，测出来的是别的东西）。 */
  async realClickAt(sel, fx, fy) {
    const box = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width * ${Number(fx)}, y: r.top + r.height * ${Number(fy)}, w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    if (!box) return 'NOT_FOUND';
    if (!(box.w > 0 && box.h > 0)) return 'ZERO_SIZE';
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent',
        { type, x: box.x, y: box.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 },
        this.sessionId);
    }
    return 'OK';
  }

  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }

  async close() {
    try { this.ws && this.ws.close(); } catch (_) { /* ignore */ }
    try { this.proc && this.proc.kill(); } catch (_) { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(this.userDataDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

// ---------- 主流程 ----------
(async () => {
  if (!CHROME) {
    if (STRICT) {
      // 严格模式：缺浏览器不是"跳过"，是"全部未执行" → 非零退出并列出未执行项（FIN-12）
      console.log('未找到 Chrome/Edge（严格模式：不跳过。可用 WW_CHROME=<路径> 指定内核）。');
      reportUnexecuted('✗ 严格模式：浏览器缺失，');
      process.exit(2);
    }
    console.log('未找到 Chrome/Edge，跳过界面验收（可用 WW_CHROME=<路径> 指定）。');
    process.exit(0);
  }
  console.log(`浏览器内核：${CHROME}`);
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-ui-data-'));
  const PORT = Number(process.env.WW_UI_PORT || 3599);
  const CDP_PORT = Number(process.env.WW_CDP_PORT || 9799);
  const base = `http://127.0.0.1:${PORT}`;
  let server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), WW_DATA_DIR: DIR, NO_OPEN: '1', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d; });

  let b = null;
  try {
    // 服务端就绪 + **端口占用守卫**。
    // 现场实测踩到的坑（施工期第 2 轮跑出来一堆看不懂的失败）：残留的旧服务占着 3599 时，
    // spawn 出来的服务端会 EADDRINUSE 立刻退出，而"就绪"轮询会被**别人的**同名服务骗过去 ——
    // 于是整轮验收都在跟一个陌生进程对话（它用的是另一个已被删掉的数据目录），
    // 失败现象全是"存档等不到""删了回收区还能恢复"这种自相矛盾的样子。
    // 所以这里既要等就绪，也要确认**本脚本启动的那个进程**还活着；不满足就带证据中止。
    let srvExit = null;
    try {
      await waitFor(async () => {
        let ready = false;
        try { ready = (await fetch(`${base}/api/meta`)).ok; } catch (_) { /* 还没起来 */ }
        srvExit = server.exitCode;
        return { ok: ready && srvExit === null, ready, alive: srvExit === null, exitCode: srvExit };
      }, { label: `服务端就绪（端口 ${PORT} 由本脚本启动的进程持有）`, timeout: 25000, interval: 150 });
    } catch (e) {
      throw new Error(`${e.message}｜服务端 stderr=${(serverErr || '(空)').slice(-300)}`);
    }
    check('本脚本启动的服务端进程存活且端口未被残留进程占用', server.exitCode === null,
      `exitCode=${server.exitCode}${serverErr ? `｜stderr=${serverErr.slice(-160)}` : ''}`);
    b = await Browser.launch(CDP_PORT, CHROME);

    /**
     * FIX-18：页面条件等待（条件直接写成页面里的布尔表达式）。
     * 用法：`await waitExpr('设置页：复选框已勾上', `document.getElementById('x').checked === true`)`。
     * 成立即 ✓；超时则 ✗ 并打印最后一次实测值（不中断后续检查）。
     */
    const waitExpr = (label, expr, opts = {}) => waitCheck(label, async () => {
      const v = await b.eval(`(() => { try { return { ok: !!(${expr}) }; } catch (e) { return { ok: false, err: String(e && e.message) }; } })()`);
      return v;
    }, opts);

    // ---- 1. 慢启动守卫：初始化未完成时点击必须给说明，不能"点了没反应" ----
    log('=== 慢启动守卫（接口人为延迟 1.5s）===');
    await b.setLatency(1500);
    await b.send('Page.navigate', { url: base + '/' }, b.sessionId);
    let early = { exists: false };
    // FIX-18：原来是"固定 sleep(20) × 250 次"的轮询；改成带超时的条件等待（超时会打印最后一次实测值）
    await waitCheck('慢启动守卫：加载中的按钮已渲染（人为延迟 1.5s 下）', async () => {
      early = await b.eval(`(() => { const s=document.getElementById('btn-start'); return s ? { exists:true, disabled:s.disabled, ready:!!window.__wwReady } : { exists:false }; })()`);
      return { ...early, ok: early.exists === true };
    }, { timeout: 8000, interval: 40 });
    check('加载中"开始游戏"是禁用的', early.disabled === true, JSON.stringify(early));
    await b.eval(`document.getElementById('btn-save-config').click()`);
    // FIX-18：原来是固定 sleep(150) 后读提示 —— 改成等到提示行真的有内容（超时打印实测文本）
    let hint = '';
    await waitCheck('慢启动守卫：抢跑点击的提示行已落地', async () => {
      hint = await b.eval(`document.getElementById('setup-error')?.textContent || ''`);
      return { ok: hint.length > 0, hint };
    }, { timeout: 3000, interval: 50 });
    check('抢跑点击给出"正在加载"说明（不静默无反应）', /加载/.test(hint), hint);
    await b.shot(path.join(SHOTS, '01-loading-guard.png'));
    await b.setLatency(0);

    // 等真正就绪
    const readyRes = await waitCheck('慢启动守卫：初始化完成、开始按钮启用', async () => {
      const v = await b.eval(`(() => { const s=document.getElementById('btn-start'); return { ok: !!(s && !s.disabled), disabled: s ? s.disabled : null, wwReady: window.__wwReady === true }; })()`);
      return v;
    }, { timeout: 25000, interval: 200 });
    check('初始化完成后开始按钮启用且守卫放行', readyRes.ok === true && await b.eval(`window.__wwReady === true`));
    await b.shot(path.join(SHOTS, '02-setup.png'));

    // ---- 2. 关键设置项真的渲染出来了 ----
    log('\n=== 设置页 ===');
    const setup = await b.eval(`({
      paces: [...document.querySelectorAll('#cfg-pace option')].map(o=>o.textContent),
      paceHint: (document.getElementById('cfg-pace-hint')?.textContent||'').length,
      rules: document.querySelectorAll('#rules-editor input').length,
      boards: document.querySelectorAll('#board-template option').length,
    })`);
    check('节奏档位下拉有内容', setup.paces.length >= 3, setup.paces.join('/'));
    check('节奏档位说明有正文', setup.paceHint > 10, `${setup.paceHint} 字`);
    check('规则开关渲染', setup.rules >= 8, `${setup.rules} 个`);
    check('板子模板渲染', setup.boards >= 5, `${setup.boards} 个`);

    // 思考强度必须能选到中档（新默认），快速任务模型可填 —— 这两个是"发言不再等一两分钟"的入口
    const effortUi = await b.eval(`({
      efforts: [...document.querySelectorAll('#cfg-effort option')].map(o=>o.value),
      fasts: [...document.querySelectorAll('#cfg-fasteffort option')].map(o=>o.value),
      hasModelFast: !!document.getElementById('cfg-modelfast'),
      selected: document.getElementById('cfg-effort').value,
    })`);
    check('发言思考强度含 low/medium/high 三档', ['low', 'medium', 'high'].every((v) => effortUi.efforts.includes(v)), effortUi.efforts.join('/'));
    check('发言思考强度默认落在中档', effortUi.selected === 'medium', effortUi.selected);
    check('快速任务强度含 medium', effortUi.fasts.includes('medium'), effortUi.fasts.join('/'));
    check('快速任务模型输入框存在（分层模型可配）', effortUi.hasModelFast === true);

    // 复选/单选：自己画的控件必须"勾上看得出"。
    // 用户报的"点了勾不上"根因是 `background: linear-gradient(...)` 之后又写 `background-image: url(勾)`，
    // 前者被顶掉 → 底色透明 → 深色勾画在暗底上等于看不见（状态其实是翻转的，所以只测 checked 测不出来）。
    // 所以这里同时钉三件事：真实鼠标点击能翻转状态、勾选态**同时**有勾画与不透明底色、取消后回到暗底。
    // FIX-17：入口按钮先量几何（可见、非零尺寸、未被遮挡），再用**真实鼠标**点开
    const entrySettingsProbe = await b.probe('#entry-settings', { scroll: true });
    checkGeometry('FIX-17 设置页：入口按钮可见、非零尺寸、中心点未被遮挡（≥32px 触区）', entrySettingsProbe, { minW: 88, minH: 32 });
    await b.realClick('#entry-settings'); // 先经可见入口展开，不能点击 hidden 表单。
    // FIX-17：真实点击必须有**预期效果**（设置区真的展开），不是"点了个看不见的东西"
    await waitCheck('FIX-17 设置页：真实鼠标点击入口后设置区真的展开', async () => await b.eval(
      `(() => { const s = document.getElementById('setup-section'); return { ok: !!s && !s.hidden, found: !!s, hidden: s ? s.hidden : null }; })()`),
    { timeout: 3000 });
    const cb = await b.eval(`(() => {
      const el = document.getElementById('cfg-cachecontrol');
      const read = () => { const s = getComputedStyle(el); return {
        checked: el.checked, image: s.backgroundImage, color: s.backgroundColor, border: s.borderTopColor }; };
      el.checked = false;
      return read();
    })()`);
    await b.realClick('#cfg-cachecontrol');
    // FIX-18：原来是固定 sleep(300)，改成等到复选框真的勾上
    await waitCheck('设置页：复选框真实点击后已勾上', async () => await b.eval(
      `(() => { const el = document.getElementById('cfg-cachecontrol'); return { ok: el.checked === true, checked: el.checked }; })()`), { timeout: 2000 });
    const cbOn = await b.eval(`(() => { const el = document.getElementById('cfg-cachecontrol'); const s = getComputedStyle(el); return {
      checked: el.checked, image: s.backgroundImage, color: s.backgroundColor }; })()`);
    check('复选框：真实鼠标点击能勾上', cbOn.checked === true, JSON.stringify({ before: cb.checked, after: cbOn.checked }));
    check('复选框：勾选态同时有勾画与不透明底色（缺一个就等于看不见）',
      /svg/.test(cbOn.image) && /gradient/.test(cbOn.image) && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(cbOn.color),
      JSON.stringify({ image: cbOn.image.slice(0, 60), color: cbOn.color }));
    await b.realClick('#cfg-cachecontrol');
    // FIX-18：原来是固定 sleep(300)，改成等到复选框真的取消
    await waitCheck('设置页：复选框再点一次已取消', async () => await b.eval(
      `(() => { const el = document.getElementById('cfg-cachecontrol'); return { ok: el.checked === false, checked: el.checked }; })()`), { timeout: 2000 });
    const cbOff = await b.eval(`document.getElementById('cfg-cachecontrol').checked`);
    check('复选框：再点一次能取消', cbOff === false);

    // ---- FIX-17：设置页的几何/遮挡断言（计划书 §11.3：不许只有"存在 + 文字"型检查）----
    // 四条判据：宽高 > 0、与视口相交（控件要求中心点在视口内）、中心点被 elementFromPoint
    // 命中它自己或其子孙（= 没被别的图层压住）、需要点的控件已经用真实鼠标点过且有效果。
    const setupScreenProbe = await b.probe('#screen-setup');
    checkGeometry('FIX-17 设置页：设置屏本体可见且与视口相交（不是 hidden / 0 高）',
      setupScreenProbe, { minW: 600, minH: 200, requireCenter: false, requireHitSelf: false });
    const paceProbe = await b.probe('#cfg-pace', { scroll: true });
    checkGeometry('FIX-17 设置页：节奏档位下拉可见、非零尺寸、中心点未被遮挡', paceProbe, { minW: 100, minH: 24 });
    const cacheProbe = await b.probe('#cfg-cachecontrol', { scroll: true });
    checkGeometry('FIX-17 设置页：复选框可见且中心点命中它自己（上面那次真实点击点的就是这里）', cacheProbe, { minW: 12, minH: 12 });
    const startProbe = await b.probe('#btn-start', { scroll: true });
    checkGeometry('FIX-17 设置页：开始游戏按钮可见、非零尺寸、中心点未被遮挡', startProbe, { minW: 120, minH: 40 });

    // ---- 计划书第 83 行：桌面端「玩家中心」代表截图（1440×900）----
    // 位置有讲究：必须在这个时刻取。稍后一开局，桌面端会**异步自动进入对局屏**并把 #screen-setup 整个隐藏，
    // 到那时再探只会拿到 w=0/h=0 —— 实测到的形态正是"等待表达式成立（当时确有宽度）→ 紧接着 probe 归零"，
    // 换选择器治不了（诊断已确认当时 screen=screen-game、隐藏祖先是 #screen-setup 本身）。
    // 元素出处：首屏 #home-hero 内的 #home-profile / #home-avatar / #home-nick（web/index.html:107/111/112/114）。
    {
      await waitExpr('第 83 行 1440×900：桌面端首屏当前档案卡已渲染（截图前置条件）', `(() => { const s = document.getElementById('screen-setup'); const p = document.getElementById('home-profile'); const a = document.getElementById('home-avatar'); const rp = p ? p.getBoundingClientRect() : null; const ra = a ? a.getBoundingClientRect() : null; return { ok: !!s && !s.classList.contains('hidden') && !!rp && rp.width > 100 && rp.height > 20 && !!ra && ra.width > 0, profileW: rp ? Math.round(rp.width) : -1, profileH: rp ? Math.round(rp.height) : -1, avatarW: ra ? Math.round(ra.width) : -1 }; })()`, { timeout: 8000, interval: 100 });
      const dProf = await b.probe('#home-profile');
      checkGeometry('第 83 行 1440×900：桌面端玩家中心（当前档案卡 #home-profile）可见、非零尺寸', dProf, { minW: 100, minH: 20, requireCenter: false, requireHitSelf: false });
      const dAvatar = await b.probe('#home-avatar');
      checkGeometry('第 83 行 1440×900：当前档案头像可见、非零尺寸（M1 自定义头像的展示位）', dAvatar, { minW: 16, minH: 16 });
      const dNick = await b.probe('#home-nick');
      checkGeometry('第 83 行 1440×900：当前档案昵称可见、中心点未被遮挡', dNick, { minW: 24, minH: 12 });
      await b.shot(path.join(SHOTS, '18-1440x900-desktop-profile.png'));

      // §3 触点门禁（桌面端）：阈值与手机端**不同** —— 桌面常规 ≥40、主要操作 ≥44（计划书 §3）。
      // 位置同样必须在这里：这是"开局前唯一可见窗口"，稍后 #screen-setup 会被异步自动进局整个隐藏。
      // 只判高度：桌面首屏也在 1440×900 之外有内容，用 checkGeometry 默认参数会产生假红（手机端踩过一次）。
      const hOf = (pr) => (pr && pr.found && typeof pr.h === 'number' ? Math.round(pr.h) : -1);
      const dStart = await b.probe('#btn-start', { scroll: true });
      check('§3 触点门禁（桌面）：开始游戏主操作实测高度 ≥44', hOf(dStart) >= 44, `实测 h=${hOf(dStart)}（w=${dStart.w}）`);
      const dProfEntry = await b.probe('#btn-profiles-entry', { scroll: true });
      check('§3 触点门禁（桌面）：档案入口实测高度 ≥40', hOf(dProfEntry) >= 40, `实测 h=${hOf(dProfEntry)}（w=${dProfEntry.w}）`);
      const dDiscard = await b.probe('#btn-discard', { scroll: true });
      if (dDiscard.found && hOf(dDiscard) > 0) {
        check('§3 触点门禁（桌面）：丢弃草稿实测高度 ≥40', hOf(dDiscard) >= 40, `实测 h=${hOf(dDiscard)}（w=${dDiscard.w}）`);
      } else {
        // 实测事实：开局前这一刻 #btn-discard 不在场（它只在存在草稿时出现，实测 h=0）⇒ 这里量不到。
        // 恒真断言不写进断言集合（计划书第 52 行），用 log 如实记录覆盖缺口。
        log(`· §3 触点门禁（桌面）：丢弃草稿此刻不在场（实测 h=${hOf(dDiscard)}；该按钮只在有草稿时出现）—— 属已知覆盖缺口`);
      }
      // 桌面端弹窗（#modal）内的按钮：#modal 的内容由 openModal 动态生成，开局前不一定存在；
      // 不在这里用"存在性检查"冒充覆盖 —— 由 ② 的桌面实测探针与 test/css.test.js 的守卫表负责。
    }

    // 设置页下半（板子编辑器 / 玩家昵称 / 底部操作条）在 1440×900 里落在首屏之外，
    // 而这几张卡恰好是改动最频繁的部分 —— 滚到底单独留一张。
    await b.eval(`document.querySelector('.setup-scroll')?.scrollTo(0, 2000)`);
    // FIX-18：原来是固定 sleep(500)，改成等到滚动真的生效（截图必须有内容）
    await waitCheck('设置页：已滚到下半屏（截图前置条件）', async () => await b.eval(
      `(() => { const s = document.querySelector('.setup-scroll'); return { ok: !!s && s.scrollTop > 100, scrollTop: s ? Math.round(s.scrollTop) : null }; })()`), { timeout: 3000, interval: 50 });
    await b.shot(path.join(SHOTS, '02b-setup-lower.png'));
    await b.eval(`document.querySelector('.setup-scroll')?.scrollTo(0, 0)`);
    await waitCheck('设置页：已滚回首屏（后续断言前置条件）', async () => await b.eval(
      `(() => { const s = document.querySelector('.setup-scroll'); return { ok: !!s && s.scrollTop === 0, scrollTop: s ? Math.round(s.scrollTop) : null }; })()`), { timeout: 3000, interval: 50 });

    // ---- 3.35 下拉框箭头：悬停/聚焦时也必须还在（background 简写曾把 background-image 顶掉） ----
    {
      const before = await b.eval(`(() => {
        const s = document.querySelector('#board-template');
        if (!s) return null;
        return { arrow: getComputedStyle(s).backgroundImage, cursor: getComputedStyle(s).cursor };
      })()`);
      check('下拉框自带内嵌箭头（默认态）', !!(before && /url\(/.test(before.arrow)), before ? before.arrow.slice(0, 60) : 'NOT_FOUND');
      await b.realHover('#board-template');
      // FIX-18：原来是固定 sleep(300)，改成等到 hover 后的计算样式里箭头仍在（超时打印实测值）
      let hovered = '';
      await waitCheck('下拉框：hover 后的内嵌箭头已生效', async () => {
        hovered = await b.eval(`getComputedStyle(document.querySelector('#board-template')).backgroundImage`);
        return { ok: /url\(/.test(hovered), backgroundImage: String(hovered).slice(0, 80) };
      }, { timeout: 2000, interval: 50 });
      check('真实鼠标悬停后箭头仍在（简写不得顶掉 background-image）', /url\(/.test(hovered), hovered.slice(0, 60));
      await b.eval(`document.querySelector('#board-template').focus()`);
      // FIX-18：原来是固定 sleep(200)，改成等到 focus 后的计算样式读得到箭头
      let focused = '';
      await waitCheck('下拉框：focus 后的内嵌箭头已生效', async () => {
        focused = await b.eval(`getComputedStyle(document.querySelector('#board-template')).backgroundImage`);
        return { ok: /url\(/.test(focused), backgroundImage: String(focused).slice(0, 80) };
      }, { timeout: 2000, interval: 50 });
      check('聚焦后箭头仍在', /url\(/.test(focused), focused.slice(0, 60));
    }

    // ---- 3.4 手机端：试玩开关必须在板子页一眼可见（P2-b：原来只藏在设置弹窗最底下） ----
    {
      await b.goto(base + '/m/', 2000);
      // FIX-18：goto 不再固定睡 settle（只等到 __wwReady），板子页的卡片渲染单独条件等待
      await waitExpr('手机端板子页：试玩/真实模式卡已渲染', `document.getElementById('m-mock-btn') && document.getElementById('m-real-btn')`, { timeout: 6000 });
      const mock = await b.eval(`(() => {
        const el = document.getElementById('m-mock-btn');
        const real = document.getElementById('m-real-btn');
        return el ? { text: el.textContent, checked: el.getAttribute('aria-checked'), realChecked: real?.getAttribute('aria-checked'), realText: real?.textContent, height: el.getBoundingClientRect().height } : null;
      })()`);
      check('手机端板子页有可见的试玩开关', !!mock, mock ? mock.text : 'NOT_FOUND');
      check('模式卡默认选中真实对局且说明按量计费，试玩标签保持独立', !!(mock && mock.realChecked === 'true' && mock.checked === 'false' && /按用量计费/.test(mock.realText) && /试玩/.test(mock.text) && mock.height >= 48), JSON.stringify(mock));
      await b.realClick('#m-mock-btn');
      // FIX-18：原来是固定 sleep(400)，改成等到选中态真的翻转
      await waitExpr('手机端：点击后仅试玩卡被选中（aria-checked 已翻转）',
        `document.getElementById('m-mock-btn').getAttribute('aria-checked') === 'true' && document.getElementById('m-real-btn').getAttribute('aria-checked') === 'false'`, { timeout: 2500 });
      const after = await b.eval(`({mock:document.getElementById('m-mock-btn').getAttribute('aria-checked'),real:document.getElementById('m-real-btn').getAttribute('aria-checked')})`);
      check('点击后仅试玩卡被选中', after.mock === 'true' && after.real === 'false', JSON.stringify(after));
      await b.goto(base + '/', 1500); // 回到桌面端，后续图鉴/对局断言都在桌面端进行
      await waitExpr('回到桌面端：图鉴入口已就绪', `!!document.getElementById('btn-codex')`, { timeout: 6000 });
    }

    // ---- 3.5 角色图鉴（独立成屏：左翻牌、右细节） ----
    log('\n=== 角色图鉴 ===');
    await b.click('#btn-codex');
    // FIX-18：原来是固定 sleep(700)，改成等到图鉴屏与牌面真的渲染出来
    await waitExpr('角色图鉴：独立成屏且牌面已渲染',
      `(() => { const s = document.querySelector('#app > .screen:not(.hidden)'); return !!s && s.id === 'screen-codex' && document.querySelectorAll('#cdx-grid .cdx-card').length >= 15; })()`,
      { timeout: 5000 });
    const cdx = await b.eval(`({
      screen: document.querySelector('#app > .screen:not(.hidden)')?.id,
      cards: document.querySelectorAll('#cdx-grid .cdx-card').length,
      secs: document.querySelectorAll('#cdx-grid .cdx-sec').length,
      filters: document.querySelectorAll('#cdx-filters button').length,
      art: document.querySelectorAll('#cdx-grid img.role-art').length,
      detail: (document.querySelector('#cdx-detail .cdx-dname')?.textContent || '').trim(),
      chips: document.querySelectorAll('#cdx-detail .cdx-chips span').length,
      strat: document.querySelectorAll('#cdx-detail .cdx-strat div').length,
    })`);
    check('图鉴：独立成屏并列出全部身份', cdx.screen === 'screen-codex' && cdx.cards >= 15 && cdx.secs === 4, JSON.stringify(cdx));
    check('图鉴：每张牌都用真实立绘', cdx.art === cdx.cards, `${cdx.art}/${cdx.cards}`);
    check('图鉴：默认选中一张并显示细节与徽记', cdx.detail.length > 0 && cdx.chips >= 3, `${cdx.detail} / ${cdx.chips} 徽记`);
    check('图鉴：带 AI 打法模板', cdx.strat >= 2, `${cdx.strat} 条`);
    await b.shot(path.join(SHOTS, '02c-codex.png'));

    // 阵营筛选
    await b.eval(`document.querySelector('#cdx-filters button[data-filter=wolf]').click()`);
    // FIX-18：原来是固定 sleep(400)，改成等到筛选后的 DOM 真的收敛到"只留狼人一栏"
    await waitExpr('角色图鉴：阵营筛选后只剩该阵营', `document.querySelectorAll('#cdx-grid .cdx-card').length === 5 && document.querySelectorAll('#cdx-grid .cdx-sec').length === 1`, { timeout: 3000 });
    const wolf = await b.eval(`({ n: document.querySelectorAll('#cdx-grid .cdx-card').length, secs: document.querySelectorAll('#cdx-grid .cdx-sec').length })`);
    check('图鉴：阵营筛选只留该阵营', wolf.n === 5 && wolf.secs === 1, JSON.stringify(wolf));
    // 搜索（先把阵营筛选复位：两个条件是**与**关系，"狼人 + 预言家"本来就该只剩隐狼那种）
    await b.eval(`document.querySelector('#cdx-filters button[data-filter=all]').click()`);
    await waitExpr('角色图鉴：阵营筛选已复位（全部身份回来）', `document.querySelectorAll('#cdx-grid .cdx-card').length >= 15`, { timeout: 3000 });
    await b.eval(`(() => { const i=document.getElementById('cdx-search'); i.value='预言家'; i.dispatchEvent(new Event('input')); })()`);
    // FIX-18：原来是固定 sleep(400)，改成等到搜索结果真的收敛
    await waitExpr('角色图鉴：搜索"预言家"结果已收敛', `(() => { const rs = [...document.querySelectorAll('#cdx-grid .cdx-card')].map((c) => c.dataset.role); return rs.includes('seer') && rs.length <= 4; })()`, { timeout: 3000 });
    const searched = await b.eval(`([...document.querySelectorAll('#cdx-grid .cdx-card')].map(c=>c.dataset.role))`);
    check('图鉴：搜索命中且只留命中项', searched.includes('seer') && searched.length <= 4, JSON.stringify(searched));
    // 点牌切换细节
    await b.eval(`(() => { const i=document.getElementById('cdx-search'); i.value=''; i.dispatchEvent(new Event('input')); })()`);
    await waitExpr('角色图鉴：清空搜索后全部身份回来', `document.querySelectorAll('#cdx-grid .cdx-card').length >= 15`, { timeout: 3000 });
    await b.eval(`document.querySelectorAll('#cdx-grid .cdx-card')[1].click()`);
    // FIX-18：原来是固定 sleep(300)，改成等到第二张牌真的变成选中态（.on 由 codex.js:296 加）
    await waitExpr('角色图鉴：第二张牌已成为选中态（细节已切换）', `document.querySelectorAll('#cdx-grid .cdx-card')[1]?.classList.contains('on') === true`, { timeout: 3000 });
    const picked = await b.eval(`document.querySelectorAll('#cdx-grid .cdx-card')[1]?.dataset.role`);
    const shown = await b.eval(`document.querySelector('#cdx-detail .cdx-chips') ? document.querySelector('#cdx-detail .cdx-dname').textContent.trim() : ''`);
    check('图鉴：点牌切换右侧细节', !!shown && !!picked, `${picked} → ${shown}`);
    // 阵营不固定的角色（暗恋者）**不能**被归进"平民阵营"：它的有效阵营随暗恋对象终身变动
    // （见 src/engine/game.js 的 categoryOf），按静态 category 展示就是图鉴在说谎。
    await b.eval(`(() => { const i=document.getElementById('cdx-search'); i.value='暗恋者'; i.dispatchEvent(new Event('input')); })()`);
    // FIX-18：原来是固定 sleep(400)，改成等到暗恋者成为唯一一张牌
    await waitExpr('角色图鉴：搜索"暗恋者"结果已收敛', `document.querySelector('#cdx-grid .cdx-card')?.dataset.role === 'admirer'`, { timeout: 3000 });
    const dyn = await b.eval(`(() => {
      const secs = [...document.querySelectorAll('#cdx-grid .cdx-sec h2')].map((h) => h.textContent.trim());
      const card = document.querySelector('#cdx-grid .cdx-card');
      return {
        secs, role: card && card.dataset.role,
        plate: card && (card.querySelector('.cdx-cat') || {}).textContent,
        note: !!document.querySelector('#cdx-detail .cdx-note'),
        chips: (document.querySelector('#cdx-detail .cdx-chips') || {}).textContent || '',
      };
    })()`);
    check('图鉴：阵营不固定的角色不进"平民阵营"', dyn.role === 'admirer' && dyn.secs.length === 1 && /阵营随对象/.test(dyn.secs[0]) && !/平民/.test(dyn.secs[0]), JSON.stringify(dyn.secs));
    check('图鉴：暗恋者按第三方展示并说明为何阵营不固定', /第三方/.test(dyn.plate || '') && dyn.note && /暗恋/.test(dyn.chips), `${dyn.plate} / note=${dyn.note}`);
    await b.shot(path.join(SHOTS, '02d-codex-dynamic.png'));
    await b.eval(`(() => { const i=document.getElementById('cdx-search'); i.value=''; i.dispatchEvent(new Event('input')); })()`);
    await waitExpr('角色图鉴：清空搜索后全部身份回来（准备返回）', `document.querySelectorAll('#cdx-grid .cdx-card').length >= 15`, { timeout: 3000 });
    // 返回
    await b.click('#btn-codex-back');
    // FIX-18：原来是固定 sleep(600)，改成等到设置屏真的显示出来
    await waitExpr('角色图鉴：已返回设置页', `document.querySelector('#app > .screen:not(.hidden)')?.id === 'screen-setup'`, { timeout: 4000 });
    check('图鉴：返回回到设置页', await b.eval(`document.querySelector('#app > .screen:not(.hidden)')?.id`) === 'screen-setup');

    // 座位：默认随机（老坐 1 号很难受），可以自定义，且要说明"座位开局才定"
    const seat = await b.eval(`({
      value: document.getElementById('my-seat')?.value,
      first: document.getElementById('my-seat')?.options[0]?.textContent,
      count: document.getElementById('my-seat')?.options.length,
      hint: document.getElementById('seat-hint')?.textContent || '',
    })`);
    check('座位默认随机', seat.value === 'random', `${seat.value} / ${seat.first} / ${seat.count} 项`);
    check('随机时说明座位开局才定', /开局/.test(seat.hint), seat.hint.slice(0, 30));

    // ---- 2.9 FIX-08：Esc 关浮层（真实按键）+ 遮罩 / body 滚动锁 / inert 一并清理 ----
    // 这段的靶子**改前就红**（不是"注释说修好了"）：
    //   · 桌面 .inspect-stage（z-index 90，压在弹窗 76 之上）没有任何 Esc 路径能关 —— Esc 按下去毫无反应；
    //   · body 滚动锁以前根本不存在（新增行为，见报告"存疑"一节），所以"打开时锁上"同样改前就红；
    //   · 关闭路径释放锁若只写在 ✕ 那一条上，点遮罩/程序化关闭就会把页面锁死 —— 所以四条路各断言一次。
    // 这里量的是 computed display / getBoundingClientRect / getClientRects，**不是** hidden 属性：
    // `.modal{display:flex}` 会盖掉 UA 的 [hidden]{display:none}，看属性会得出错误结论。
    log('\n=== FIX-08 Esc 关浮层（真实按键）===');
    {
      const layerState = () => b.eval(`(() => {
        const modal = document.querySelector('#modal-root .modal');
        const mask = document.querySelector('#modal-root .modal-mask');
        const insp = document.querySelector('.inspect-stage');
        const rect = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return {
          w: Math.round(r.width), h: Math.round(r.height), c: n.getClientRects().length, d: getComputedStyle(n).display }; };
        const app = document.getElementById('app');
        return {
          modal: rect(modal), mask: rect(mask), inspect: rect(insp),
          rootKids: document.getElementById('modal-root').children.length,
          lock: getComputedStyle(document.body).overflow,
          inert: !!(app && app.inert),
        };
      })()`);

      await b.click('#entry-rulebook');
      // FIX-18：原来是固定 sleep(600)，改成等到弹层真的有了真实尺寸（超时打印实测几何）
      await waitExpr('FIX-08 弹窗已打开（弹层有真实尺寸）',
        `(() => { const m = document.querySelector('#modal-root .modal'); return !!m && m.getClientRects().length > 0 && m.getBoundingClientRect().height >= 120; })()`,
        { timeout: 4000 });
      let ls = await layerState();
      check('FIX-08 弹窗打开：弹层有真实尺寸（不是只设了 hidden 属性）',
        !!ls.modal && ls.modal.c > 0 && ls.modal.h >= 120 && ls.modal.d !== 'none', JSON.stringify(ls.modal));
      check('FIX-08 弹窗打开：遮罩在，且 body 上了滚动锁、背景 inert',
        !!ls.mask && ls.mask.c > 0 && ls.lock === 'hidden' && ls.inert === true,
        `锁=${ls.lock} inert=${ls.inert} 遮罩=${JSON.stringify(ls.mask)}`);

      // 弹窗之上再叠一层"检视大卡"（z-index 90 > 弹窗 76）：Esc 必须先关它，且下面的弹窗留着
      await b.eval(`(() => { const t = [...document.querySelectorAll('#modal-root .tabs button')].find((x) => x.textContent.trim() === '角色图鉴'); if (t) t.click(); })()`);
      // FIX-18：原来是固定 sleep(600)，改成等到图鉴页签渲染出可点的详情按钮
      await waitExpr('FIX-08 弹窗内已切到图鉴页签（详情按钮可点）', `!!document.querySelector('#modal-root .codex .r-card .btn')`, { timeout: 4000 });
      await b.eval(`document.querySelector('#modal-root .codex .r-card .btn')?.click()`);
      // FIX-18：原来是固定 sleep(500)，改成等到检视大卡真的叠上来
      await waitExpr('FIX-08 检视大卡已叠在弹窗之上',
        `(() => { const n = document.querySelector('.inspect-stage'); return !!n && n.getClientRects().length > 0 && n.getBoundingClientRect().height >= 200; })()`,
        { timeout: 4000 });
      ls = await layerState();
      check('FIX-08 弹窗之上叠了检视大卡（"关最上层"的前提）',
        !!ls.inspect && ls.inspect.c > 0 && ls.inspect.h >= 200, JSON.stringify(ls.inspect));

      await b.pressKey('Escape');
      // FIX-18：原来是固定 sleep(500)，改成等到检视大卡真的关掉
      await waitExpr('FIX-08 Esc 后检视大卡已关闭',
        `(() => { const n = document.querySelector('.inspect-stage'); return !n || (n.getClientRects().length === 0 && getComputedStyle(n).display === 'none'); })()`,
        { timeout: 4000 });
      ls = await layerState();
      const inspGone = ls.inspect === null || (ls.inspect.c === 0 && ls.inspect.d === 'none');
      check('FIX-08 Esc 只关最上层：检视大卡消失、下面的弹窗还在', inspGone && !!ls.modal && ls.modal.c > 0,
        `inspect=${JSON.stringify(ls.inspect)} modal=${JSON.stringify(ls.modal)}`);
      check('FIX-08 还压着一层时滚动锁保持（不能提前解锁）', ls.lock === 'hidden' && ls.inert === true,
        `锁=${ls.lock} inert=${ls.inert}`);

      await b.pressKey('Escape');
      // FIX-18：原来是固定 sleep(500)，改成等到弹层与遮罩真的从 DOM 清掉
      await waitExpr('FIX-08 Esc 后弹层与遮罩已从 DOM 清掉',
        `(() => { const r = document.getElementById('modal-root'); return r.children.length === 0 && !document.querySelector('#modal-root .modal') && !document.querySelector('#modal-root .modal-mask'); })()`,
        { timeout: 4000 });
      ls = await layerState();
      check('FIX-08 Esc 关弹窗：弹层与遮罩都从 DOM 清掉（不是只改 hidden）',
        ls.rootKids === 0 && ls.modal === null && ls.mask === null,
        `rootKids=${ls.rootKids} modal=${JSON.stringify(ls.modal)} mask=${JSON.stringify(ls.mask)}`);
      check('FIX-08 Esc 关弹窗后：body 滚动锁解除、背景恢复可交互',
        ls.lock !== 'hidden' && ls.inert === false, `锁=${ls.lock} inert=${ls.inert}`);

      // 其余三条关闭路径各断言一次：只修按钮那条 = 弹窗关了但页面再也滚不动（比不锁更糟）
      const closePaths = [
        ['点遮罩空白处', async () => b.realClickAt('#modal-root .modal-mask', 0.03, 0.04)],
        ['点 ✕ 按钮', async () => b.realClick('#modal-root .mhead .btn')],
        ['程序化 closeModal()', async () => b.eval('closeModal()')],
      ];
      for (const [name, act] of closePaths) {
        await b.click('#entry-rulebook');
        // FIX-18：原来是"固定 sleep(500) → 点 → 固定 sleep(500)"，改成两步条件等待
        await waitExpr(`FIX-08 关闭路径「${name}」前置：弹层已打开`,
          `(() => { const m = document.querySelector('#modal-root .modal'); return !!m && m.getClientRects().length > 0; })()`, { timeout: 4000 });
        await act();
        await waitExpr(`FIX-08 关闭路径「${name}」：弹层+遮罩已清掉`,
          `(() => { const r = document.getElementById('modal-root'); return r.children.length === 0; })()`, { timeout: 4000 });
        const st = await layerState();
        check(`FIX-08 关闭路径「${name}」：弹层+遮罩清掉且滚动锁释放`,
          st.rootKids === 0 && st.modal === null && st.mask === null && st.lock !== 'hidden' && st.inert === false,
          `rootKids=${st.rootKids} 锁=${st.lock} inert=${st.inert}`);
      }

      // CSS 层：".modal 写了 display:flex → 盖掉 UA 的 [hidden]{display:none}" 是本缺陷的根因之一，
      // 直接在真实页面里放一个 .modal[hidden] 探针量计算结果（改回没有这条规则 → display 会变 flex → 红）
      const hiddenProbe = await b.eval(`(() => {
        const d = document.createElement('div'); d.className = 'modal'; d.hidden = true;
        document.body.appendChild(d);
        const cs = getComputedStyle(d); const r = d.getBoundingClientRect();
        const out = { display: cs.display, h: Math.round(r.height), c: d.getClientRects().length };
        d.remove(); return out;
      })()`);
      check('FIX-08 .modal[hidden] 真的不渲染（不被 .modal{display:flex} 盖掉）',
        hiddenProbe.display === 'none' && hiddenProbe.h === 0 && hiddenProbe.c === 0, JSON.stringify(hiddenProbe));
    }

    // ---- 3. i18n 真的作用于真实 DOM ----
    log('\n=== 中英文切换 ===');
    await b.click('#btn-lang');
    // FIX-18：原来是固定 sleep(500)，改成等到 <html lang> 真的切过去
    await waitExpr('中英文切换：<html lang> 已切到 en', `document.documentElement.lang === 'en'`, { timeout: 3000 });
    // 标题取 #app-title（设置页 hero 里的 h1）：用稳定的 id 而不是 .topbar h1，
  // 后者是"对局页顶栏"的位置类名，界面重构一改标题就不在这里了（本轮就撞过一次）。
  const en = await b.eval(`({ lang: document.documentElement.lang, title: (document.getElementById('app-title') || document.querySelector('.topbar h1'))?.textContent, save: document.getElementById('btn-save-config')?.textContent })`);
    check('切英文后 <html lang>=en 且文案变化', en.lang === 'en' && /Werewolf/.test(en.title || '') && en.save === 'Save', JSON.stringify(en));
    await b.shot(path.join(SHOTS, '03-english.png'));
    await b.click('#btn-lang');
    // FIX-18：原来是固定 sleep(400)，改成等到 lang 切回中文
    await waitExpr('中英文切换：<html lang> 已切回 zh-CN', `document.documentElement.lang === 'zh-CN'`, { timeout: 3000 });
    check('切回中文', await b.eval(`document.documentElement.lang`) === 'zh-CN');

    // ---- 4. 离线横幅（FIX-18：CDP 离线模拟助手做**真实**断网；FIX-17：补几何/遮挡断言）----
    // 这一段原来只做两件事：setOffline(true) + **手动** `dispatchEvent(new Event('offline'))`，
    // 然后查一下文案在不在 DOM 里。既没验"网真的断了"，也没验横幅真的有尺寸/没被遮挡，
    // 更没验"恢复联网后横幅会消失"。
    log('\n=== 离线 ===');
    {
      // 基线：联网时横幅不该出现（否则"断网时出现"这条断言什么都没证明）
      const beforeOff = await b.eval(`(() => { const el = document.getElementById('offline-banner'); return { onLine: navigator.onLine, banner: !!el && !el.hidden }; })()`);
      check('离线横幅基线：联网时不出现', beforeOff.onLine === true && beforeOff.banner === false, JSON.stringify(beforeOff));

      // 真实断网：CDP 网络域 offline（请求真的发不出去）+ navigator.onLine 覆盖（页面才收得到 offline 事件）
      const netOff = await b.emulateOffline(true);
      // 观测量到的状态，不假设模拟生效
      const obs = await waitCheck('离线模拟生效：navigator.onLine 变 false', async () => await b.eval(
        `(() => ({ ok: navigator.onLine === false, onLine: navigator.onLine, htmlOnline: document.documentElement.dataset.online || null }))()`),
      { timeout: 5000, interval: 100 });
      check('CDP 离线模拟确实生效（不靠页面里手动 dispatchEvent 造假）',
        obs.onLine === false && netOff.networkConditions === 'ok', `模拟=${JSON.stringify(netOff)} 实测 onLine=${obs.onLine}`);
      // 真实请求失败才算"真的断了"：带时间戳 + no-store 绕开一切缓存（/api/* 本来也不走 service worker）
      const fetchOff = await b.eval(`(async () => { try { const r = await fetch('/api/meta?ts=' + Date.now(), { cache: 'no-store' }); return { failed: false, code: r.status }; } catch (e) { return { failed: true, err: String(e && e.message) }; } })()`);
      check('断网期间真实请求确实发不出去（fetch 失败，不是假设）', fetchOff.failed === true, JSON.stringify(fetchOff));

      // 横幅必须**自己**出现（pwa.js 的 offline 监听 → syncOnline），不靠测试侧补发事件
      await waitExpr('断网后离线横幅自动出现', `(() => { const el = document.getElementById('offline-banner'); return !!el && !el.hidden; })()`, { timeout: 5000 });
      const off = await b.eval(`(() => { const el=document.getElementById('offline-banner'); return { visible: !!el && !el.hidden, text: el?.textContent?.slice(0,40) }; })()`);
      check('断网时明确提示', off.visible, off.text);
      // FIX-17：横幅的几何/遮挡断言（它是 position:fixed 贴顶通栏，所以"在视口内"= 整个盒子都在视口内）
      const bannerProbe = await b.probe('#offline-banner');
      checkGeometry('FIX-17 离线横幅：可见、非零尺寸、整个盒子都在视口内、中心点命中它自己（z-index 9999 未被遮挡）',
        bannerProbe, { minW: 200, minH: 16, requireFull: true });
      check('FIX-17 离线横幅：确实是固定定位贴顶通栏（position=fixed 且 top=0、left=0、宽度=视口宽）',
        bannerProbe.position === 'fixed' && bannerProbe.top === 0 && bannerProbe.left === 0 && Math.abs(bannerProbe.w - bannerProbe.vpW) <= 1,
        JSON.stringify({ position: bannerProbe.position, top: bannerProbe.top, left: bannerProbe.left, w: bannerProbe.w, vpW: bannerProbe.vpW }));
      await b.shot(path.join(SHOTS, '04-offline.png'));

      // 恢复联网：横幅必须自己消失（原实现只测了"出现"，恢复这条根本没测）
      await b.emulateOffline(false);
      const obsOn = await waitCheck('恢复联网：navigator.onLine 变回 true', async () => await b.eval(
        `(() => ({ ok: navigator.onLine === true, onLine: navigator.onLine }))()`), { timeout: 5000, interval: 100 });
      const fetchBack = await b.eval(`(async () => { try { const r = await fetch('/api/meta?ts=' + Date.now(), { cache: 'no-store' }); return { ok: r.ok, code: r.status }; } catch (e) { return { ok: false, err: String(e && e.message) }; } })()`);
      check('恢复联网后真实请求重新可用（断网—恢复整条回路）', fetchBack.ok === true, JSON.stringify(fetchBack));
      await waitExpr('恢复联网后离线横幅自动消失', `(() => { const el = document.getElementById('offline-banner'); return !el || el.hidden === true; })()`, { timeout: 5000 });
      const offGone = await b.eval(`(() => { const el = document.getElementById('offline-banner'); return { hidden: !el || el.hidden === true, htmlOnline: document.documentElement.dataset.online || null, onLine: navigator.onLine }; })()`);
      check('恢复联网后离线横幅消失且状态回到在线', obsOn.onLine === true && offGone.hidden === true && offGone.htmlOnline === 'on', JSON.stringify(offGone));
      // 几何复验：消失后不能还留着一块 0 宽/有高度的空盒子挡在屏幕顶部
      const bannerAfter = await b.probe('#offline-banner');
      check('FIX-17 离线横幅消失后不占位（display:none / 0 高，不会挡住顶部点击）',
        bannerAfter.found !== true || (bannerAfter.h === 0 && bannerAfter.overlapH === 0), JSON.stringify(bannerAfter));
    }

    // ---- 5. service worker 注册 ----
    log('\n=== 离线能力 ===');
    const sw = await b.eval(`(async () => { if(!navigator.serviceWorker) return 'unsupported'; const r = await navigator.serviceWorker.getRegistration(); return { registered: !!r, active: r?.active?.state }; })()`);
    check('service worker 注册并激活', sw && sw.registered === true && sw.active === 'activated', JSON.stringify(sw));

    // ---- 5.5 档案回收区（FIX-04）：删除后的恢复入口必须真的存在、真的能点、真的能恢复 ----
    // 「归档代替删除」以前删掉就找不回来（没有任何恢复入口）。这里用真档案走完整条路：
    // 建 → 归档 → 删除 → 在回收区面板里点「恢复」→ 档案回到列表。
    // 造数据走服务端 API（ui:check 的服务端是本机模式：不带 Origin 的 node 请求按管理会话放行），
    // 但**点按钮、量高度、读提示**一律走真实浏览器。断言的强度要求：几何 + 服务端证据，不接受"文字在 DOM 里"。
    log('\n=== 档案回收区（删除后可恢复）===');
    {
      const j = async (method, p, body) => {
        const r = await fetch(base + p, {
          method,
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        let d = null;
        try { d = await r.json(); } catch (_) { /* 允许空响应 */ }
        return { code: r.status, body: d };
      };
      // 建 → 归档 → 删除（删除只对已归档档案开放）
      const mkTrashed = async (nickname) => {
        const c = await j('POST', '/api/profiles', { nickname });
        if (c.code !== 200) throw new Error(`建档案失败 ${nickname}：${JSON.stringify(c.body)}`);
        const id = c.body.profile.id;
        const a = await j('PATCH', `/api/profiles/${id}`, { expectedRevision: c.body.profile.revision, archive: true });
        if (a.code !== 200) throw new Error(`归档失败：${JSON.stringify(a.body)}`);
        const d = await j('DELETE', `/api/profiles/${id}`);
        if (d.code !== 200) throw new Error(`删除失败：${JSON.stringify(d.body)}`);
        return { id, archiveId: d.body.archiveId };
      };

      // 入口一：首页「管理档案…」（可见尺寸 + 真实鼠标点击，走命中测试）
      const entry = await b.eval(`(() => {
        const e = document.getElementById('btn-profiles-entry');
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), text: e.textContent.trim() };
      })()`);
      check('档案管理入口可见（真实尺寸非 0）', !!entry && entry.w > 0 && entry.h > 0, JSON.stringify(entry));
      await b.realClick('#btn-profiles-entry');
      // FIX-18：原来是固定 sleep(600)，改成等到弹层里的回收区入口渲染出来
      await waitExpr('档案管理弹层：回收区入口已渲染', `!!document.getElementById('pm-trash-entry')`, { timeout: 5000 });
      // 入口二：弹层里的回收区按钮
      const entryBtn = await b.eval(`(() => {
        const e = document.getElementById('pm-trash-entry');
        if (!e) return null;
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return { w: Math.round(r.width), h: Math.round(r.height), text: e.textContent.trim(),
          visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' };
      })()`);
      check('档案管理弹层里有回收区入口且可点（尺寸非 0、非隐藏）', !!entryBtn && entryBtn.visible === true && entryBtn.h >= 20, JSON.stringify(entryBtn));

      // 空态先测：ui:check 用的是全新临时数据目录，回收区此刻真的是空的。
      // 空态必须是**有文案的面板**，不能是一块空白（"内容在、盒子 0 高"是本项目的真实事故）。
      await b.realClick('#pm-trash-entry');
      // FIX-18：原来是"固定 sleep(150) × 40 次"的轮询，改成带超时的条件等待
      await waitExpr('回收区面板：状态已判定（empty/items/error）',
        `['empty','items','error'].includes(document.getElementById('pm-trash-list')?.dataset.state || '')`, { timeout: 6000 });
      const emptyPanel = await b.eval(`(() => {
        const modal = document.querySelector('#modal-root .modal');
        const list = document.getElementById('pm-trash-list');
        return {
          modalH: modal ? Math.round(modal.getBoundingClientRect().height) : -1,
          listH: list ? Math.round(list.getBoundingClientRect().height) : -1,
          // 量的必须是**回收区面板**的高度：只写 modalH 的话，面板压根没打开时它会量到
          // 后面那层档案管理弹层而照样通过（反向验证 A 实测到过这个洞）。
          ownsList: !!(modal && list && modal.contains(list)),
          state: list ? list.dataset.state : '',
          rows: document.querySelectorAll('#pm-trash-list .pm-row').length,
          text: (list?.querySelector('.hint') || {}).textContent || '',
        };
      })()`);
      check('空回收区渲染明确空态文案（不是空白面板）',
        emptyPanel.state === 'empty' && emptyPanel.rows === 0 && emptyPanel.text.length > 8, JSON.stringify({ state: emptyPanel.state, rows: emptyPanel.rows, text: emptyPanel.text.slice(0, 30) }));
      check('空态下面板与列表容器仍有真实高度',
        emptyPanel.modalH >= 120 && emptyPanel.listH >= 16 && emptyPanel.ownsList === true,
        `面板高度=${emptyPanel.modalH}px 列表高度=${emptyPanel.listH}px 面板持有列表=${emptyPanel.ownsList}`);
      await b.shot(path.join(SHOTS, '09-trash-empty.png'));

      // 造两条"已删除"档案（建 → 归档 → 删除），再进回收区看列表项
      await b.eval(`[...document.querySelectorAll('#modal-root .btn')].find((x) => /返回档案列表/.test(x.textContent))?.click()`);
      // FIX-18：原来是固定 sleep(400)，改成等到真的从回收区退回档案列表
      await waitExpr('回收区面板：已返回档案列表', `!!document.getElementById('pm-trash-entry') && !document.getElementById('pm-trash-list')`, { timeout: 5000 });
      const first = await mkTrashed('回收区测试甲');
      const second = await mkTrashed('回收区测试乙');
      await b.realClick('#pm-trash-entry');
      // FIX-18：原来是"固定 sleep(150) × 40 次"的轮询，改成带超时的条件等待
      await waitExpr('回收区面板：列表已渲染（items/error）',
        `['items','error'].includes(document.getElementById('pm-trash-list')?.dataset.state || '')`, { timeout: 6000 });
      const panel = await b.eval(`(() => {
        const modal = document.querySelector('#modal-root .modal');
        const list = document.getElementById('pm-trash-list');
        const rows = [...document.querySelectorAll('#pm-trash-list .pm-row')];
        return {
          modalH: modal ? Math.round(modal.getBoundingClientRect().height) : -1,
          listH: list ? Math.round(list.getBoundingClientRect().height) : -1,
          ownsList: !!(modal && list && modal.contains(list)),
          state: list ? list.dataset.state : '',
          rows: rows.length,
          restoreBtns: document.querySelectorAll('#pm-trash-list .pm-restore').length,
          names: rows.map((r) => (r.querySelector('.pm-name') || {}).textContent || ''),
          metas: rows.map((r) => (r.querySelector('.hint') || {}).textContent || ''),
        };
      })()`);
      // 几何断言：面板与列表都必须有真实高度 —— 文字在 DOM 里、盒子 0 高，玩家什么都看不到（本项目真实事故）
      check('回收区面板有真实高度（不是塌成一条线）', panel.modalH >= 120 && panel.ownsList === true,
        `面板高度=${panel.modalH}px 面板持有列表=${panel.ownsList}`);
      check('回收区列表容器有真实高度（内容真的撑开了）', panel.listH >= 40, `列表高度=${panel.listH}px`);
      check('回收区列出刚删除的档案（列表项真渲染）', panel.state === 'items' && panel.rows >= 2 && panel.restoreBtns === panel.rows,
        JSON.stringify({ state: panel.state, rows: panel.rows, btns: panel.restoreBtns }));
      check('回收区每项显示昵称 + 删除时间/状态', panel.names.includes('回收区测试甲')
        && panel.metas.some((t) => /已删除/.test(t) && /删除于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(t)), JSON.stringify(panel.metas));
      await b.shot(path.join(SHOTS, '09b-trash-list.png'));

      // 恢复（真实鼠标点那一行的「恢复」）：提示、列表、服务端数据三者都要跟着变
      await b.realClick(`#pm-trash-list .pm-restore[data-archive-id=${JSON.stringify(first.archiveId)}]`);
      // FIX-18：原来是"固定 sleep(150) × 40 次"的轮询，改成带超时的条件等待
      await waitExpr('回收区面板：恢复操作的提示已落地', `/已恢复|恢复失败/.test(document.getElementById('pm-trash-msg')?.textContent || '')`, { timeout: 6000 });
      const okMsg = await b.eval(`document.getElementById('pm-trash-msg')?.textContent || ''`);
      const afterOk = await b.eval(`(() => {
        const list = document.getElementById('pm-trash-list');
        const rows = [...document.querySelectorAll('#pm-trash-list .pm-row')];
        return { state: list ? list.dataset.state : '', rows: rows.length,
          ids: rows.map((r) => r.dataset.archiveId),
          listH: list ? Math.round(list.getBoundingClientRect().height) : -1 };
      })()`);
      const restored = ((await j('GET', '/api/profiles')).body.profiles || []).find((p) => p.id === first.id);
      check('点「恢复」后给出可读成功提示（明确"可以直接使用"）',
        /已恢复/.test(okMsg) && /回收区测试甲/.test(okMsg) && /可以直接使用/.test(okMsg), okMsg.slice(0, 70));
      // FIX-04b：恢复一步到位（搬回目录 + 取消归档），archivedAt 必须已经是 null
      check('点「恢复」后档案真的可用（服务端证据：archivedAt 已清空）',
        !!restored && restored.archivedAt === null, JSON.stringify(restored || null));
      // 「刷新了回收区列表」的可观测证据：该条从回收站**消失**（服务端 listTrash 只返回目录还在的条目），
      // 而且不是靠前端隐藏 —— 前端不做任何过滤，渲染的就是接口返回的东西。
      check('恢复后回收站里不再有该条（2 条刷成 1 条，且剩下的不是它）',
        afterOk.state === 'items' && afterOk.rows === 1
        && !afterOk.ids.includes(first.archiveId) && afterOk.ids.includes(second.archiveId),
        JSON.stringify({ rows: afterOk.rows, ids: afterOk.ids, listH: afterOk.listH }));
      await b.shot(path.join(SHOTS, '09c-trash-restored.png'));

      // 返回档案列表：恢复出来的档案必须出现在列表里且已是可用态（证明 loadProfiles 真跑了）
      await b.eval(`[...document.querySelectorAll('#modal-root .btn')].find((x) => /返回档案列表/.test(x.textContent))?.click()`);
      // FIX-18：原来是固定 sleep(500)，改成等到档案列表真的刷新出"回收区测试甲"且已不是归档态
      await waitExpr('档案列表：恢复出来的档案已回到列表（可用态）',
        `[...document.querySelectorAll('#modal-root .pm-row')].some((r) => /回收区测试甲/.test((r.querySelector('.pm-name') || {}).textContent || '') && !r.classList.contains('archived'))`,
        { timeout: 6000 });
      const backList = await b.eval(`[...document.querySelectorAll('#modal-root .pm-row')].map((r) => ({ name: (r.querySelector('.pm-name') || {}).textContent || '', archived: r.classList.contains('archived') }))`);
      check('恢复后的档案出现在档案列表（列表已刷新）', backList.some((r) => r.name.includes('回收区测试甲')), JSON.stringify(backList.map((r) => r.name)));
      check('恢复回来的档案在列表里是可用态（不再带"已归档"）',
        backList.some((r) => r.name.includes('回收区测试甲') && !r.archived), JSON.stringify(backList.filter((r) => r.name.includes('回收区测试甲'))));

      // 失败路径（不静默）：回收区目录消失后再点「恢复」→ 服务端 404 → 面板必须给出可读原因。
      // 场景就是"另一个窗口已经把它恢复了"：那条随即从回收站消失，但本窗口手里还捏着一个可点的按钮。
      await b.realClick('#pm-trash-entry');
      // FIX-18：原来是"固定 sleep(150) × 40 次"的轮询，改成带超时的条件等待
      await waitExpr('回收区面板：再次进入后列表已渲染（items）',
        `document.getElementById('pm-trash-list')?.dataset.state === 'items'`, { timeout: 6000 });
      // 失败路径的前提要**自证**：目录在 → 我们把它删掉 → 目录确实没了。
      // （施工期踩过：残留的旧服务占着端口时，这里删的是新数据目录、服务端却在读旧目录，
      //  于是"恢复失败"这条检查变成"恢复成功"，现象自相矛盾。这两条前置能把那种情况一眼说清。）
      const trashPath = path.join(DIR, 'profiles', 'trash', second.archiveId);
      check('前置：回收区目录存在（失败路径的前提成立）', fs.existsSync(trashPath), trashPath);
      fs.rmSync(trashPath, { recursive: true, force: true });
      check('前置：回收区目录已被移走（服务端随后必然找不到它）', !fs.existsSync(trashPath), trashPath);
      await b.realClick(`#pm-trash-list .pm-restore[data-archive-id=${JSON.stringify(second.archiveId)}]`);
      // FIX-18：原来是"固定 sleep(150) × 40 次"的轮询，改成带超时的条件等待
      await waitExpr('回收区面板：失败提示已落地', `/恢复失败/.test(document.getElementById('pm-trash-msg')?.textContent || '')`, { timeout: 6000 });
      const failMsg = await b.eval(`document.getElementById('pm-trash-msg')?.textContent || ''`);
      const afterFail = await b.eval(`(() => {
        const list = document.getElementById('pm-trash-list');
        return { state: list ? list.dataset.state : '', rows: document.querySelectorAll('#pm-trash-list .pm-row').length,
          text: (list?.querySelector('.hint') || {}).textContent || '',
          listH: list ? Math.round(list.getBoundingClientRect().height) : -1 };
      })()`);
      check('恢复失败给出可读原因（不静默失败）', /恢复失败/.test(failMsg) && /找不到|已恢复/.test(failMsg), failMsg.slice(0, 80));
      check('恢复失败后列表跟着回到真实状态（空态文案 + 面板没塌）',
        afterFail.state === 'empty' && afterFail.rows === 0 && afterFail.text.length > 8 && afterFail.listH >= 16, JSON.stringify(afterFail));
      check('恢复失败按 400/404/409 都能翻成人话',
        await b.eval(`(() => {
          const t = [restoreFailReason({ status: 400, message: '非法 archiveId' }),
            restoreFailReason({ status: 404, message: '回收区没有该档案' }),
            restoreFailReason({ status: 409, message: '档案位置已被占用，无法恢复（可能上次恢复未清理）' })];
          return t.every((x) => typeof x === 'string' && x.length > 6) && new Set(t).size === 3;
        })()`));
      await b.shot(path.join(SHOTS, '09d-trash-after-fail.png'));

      // 收尾：✕ 回档案列表 → 关弹层，别把模态留给后面的段落
      await b.eval(`document.querySelector('#modal-root .mhead .btn')?.click()`);
      // FIX-18：原来是固定 sleep(400)，改成等到真的退回档案列表
      await waitExpr('回收区面板：✕ 之后已退回档案列表', `!!document.getElementById('pm-trash-entry')`, { timeout: 5000 });
      check('回收区面板 ✕ 返回档案列表', await b.eval(`!!document.getElementById('pm-trash-entry')`));
      await b.eval(`closeModal()`);
      // FIX-18：原来是固定 sleep(200)，改成等到弹层真的清空（别把模态留给后面的段落）
      await waitExpr('档案管理弹层：closeModal 后 DOM 已清空', `document.getElementById('modal-root').children.length === 0`, { timeout: 4000 });
    }

    // ---- 5.6 FIX-10：偏好保存遇 409 必须重拉 revision 后重试恰好一次（否则永久自锁）----
    // 原实现 409 直接放弃 → 内存里的 revision 永远停在过期值 → 之后每次保存都 409，只能刷新页面。
    // 三段证据：① 真冲突后能自动恢复并落盘；② 之后还能继续保存（自锁已解除）；
    //          ③ 测试侧注入"PATCH 永远 409"，钉住"恰好重试一次"（1 次=没重试，>2 次=无限重试）+ 可读文案。
    log('\n=== FIX-10 偏好保存 409 自恢复 ===');
    {
      const jj = async (method, p, body) => {
        const r = await fetch(base + p, {
          method,
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        let d = null;
        try { d = await r.json(); } catch (_) { /* 允许空响应 */ }
        return { code: r.status, body: d };
      };
      const profs = ((await jj('GET', '/api/profiles')).body.profiles || []).filter((p) => !p.archivedAt);
      let pid = profs.length ? profs[0].id : null;
      if (!pid) pid = (await jj('POST', '/api/profiles', { nickname: 'FIX10 自恢复' })).body.profile.id;
      await b.eval(`loadProfiles()`); // 让页面拿最新档案列表（loadProfiles 是页面里的真实函数）
      // FIX-18：原来是固定 sleep(600)，改成等到页面内存里真的有这份档案（等待条件就是下面断言读的东西）
      await waitExpr(`FIX-10 前置：页面已加载档案 ${pid} 且带 revision`,
        `(state.profiles.find((x) => x.id === ${JSON.stringify(pid)}) || {}).revision != null`, { timeout: 5000 });
      const pre = await b.eval(`(() => {
        state.profileId = ${JSON.stringify(pid)};
        const p = state.profiles.find((x) => x.id === state.profileId);
        return p ? { rev: p.revision, nick: p.nickname } : null;
      })()`);
      check('FIX-10 前置：页面已加载该档案（有 revision 可比对）',
        !!pre && Number.isFinite(Number(pre.rev)), JSON.stringify(pre));

      // ① 造一次**真实**的过期 revision（不是 mock fetch）：服务端会真的回 409
      const rec = await b.eval(`(async () => {
        const p = state.profiles.find((x) => x.id === state.profileId);
        p.revision = Number(p.revision) + 997;
        const before = p.revision;
        await saveProfilePrefs({ fontScale: 1.2, layout: 'compact', reducedMotion: true });
        const after = state.profiles.find((x) => x.id === state.profileId);
        return { before, rev: after.revision, prefs: after.preferences,
          status: (document.getElementById('pref-status') || {}).textContent || '' };
      })()`);
      const srvAfter = ((await jj('GET', '/api/profiles')).body.profiles || []).find((p) => p.id === pid);
      check('FIX-10 409 后自动重拉 revision 并重试成功（不再永久自锁）',
        !!srvAfter && rec.rev === srvAfter.revision && /已保存/.test(rec.status)
        && rec.prefs && rec.prefs.layout === 'compact' && rec.prefs.reducedMotion === true,
        `revision ${rec.before}→${rec.rev}（服务端 ${srvAfter && srvAfter.revision}）状态="${rec.status}" 偏好=${JSON.stringify(rec.prefs)}`);

      // ② 紧接着再保存一次也必须成功（自锁的直接对照：旧实现第二次仍然 409）
      const again = await b.eval(`(async () => {
        await saveProfilePrefs({ fontScale: 1, layout: 'reading', reducedMotion: false });
        const p = state.profiles.find((x) => x.id === state.profileId);
        return { rev: p.revision, layout: p.preferences.layout,
          status: (document.getElementById('pref-status') || {}).textContent || '' };
      })()`);
      const srvAfter2 = ((await jj('GET', '/api/profiles')).body.profiles || []).find((p) => p.id === pid);
      check('FIX-10 冲突恢复之后还能继续保存（revision 真的跟上了，不是一次性的）',
        /已保存/.test(again.status) && again.layout === 'reading' && !!srvAfter2 && again.rev === srvAfter2.revision,
        `状态="${again.status}" 服务端 revision=${srvAfter2 && srvAfter2.revision}`);

      // ③ 重试次数必须**恰好一次**：注入"PATCH 一律 409"（测试侧，不改产品源码），段落结束立刻还原
      const perm = await b.eval(`(async () => {
        const orig = window.fetch;
        let patches = 0;
        window.fetch = function (u, o) {
          if (o && o.method === 'PATCH') {
            patches++;
            return Promise.resolve(new Response(JSON.stringify({ error: '另一窗口已更新该档案（当前 revision 3）' }),
              { status: 409, headers: { 'content-type': 'application/json' } }));
          }
          return orig.apply(this, arguments);
        };
        let thrown = '';
        try { await saveProfilePrefs({ fontScale: 1.2, layout: 'compact', reducedMotion: false }); }
        catch (e) { thrown = String(e && e.message); }
        finally { window.fetch = orig; }
        return { patches, restored: window.fetch === orig, thrown,
          status: (document.getElementById('pref-status') || {}).textContent || '' };
      })()`);
      check('FIX-10 始终冲突时 PATCH 恰好 2 次（不重试=1 次；无限重试>2 次）',
        perm.patches === 2, `PATCH 次数=${perm.patches}（异常=${perm.thrown || '无'}）`);
      check('FIX-10 重试仍失败：给出可读原因（不是裸状态码/异常串，也不静默吞掉）',
        perm.status.length >= 8 && /另一个窗口|版本|冲突|刷新/.test(perm.status) && !/^(409|Error)/.test(perm.status.trim()),
        `状态="${perm.status}"`);
      check('FIX-10 故障注入已还原 window.fetch（不给后面的段落串味）', perm.restored === true);
      const srvFinal = ((await jj('GET', '/api/profiles')).body.profiles || []).find((p) => p.id === pid);
      check('FIX-10 永久冲突时服务端数据没被写坏（失败是干净的失败）',
        !!srvFinal && srvFinal.preferences.layout === 'reading', JSON.stringify(srvFinal && srvFinal.preferences));
    }

    // ---- 6. 手机版 ----
    log('\n=== 手机版 ===');
    await b.setViewport(390, 844, true);
    await b.goto(base + '/m/', 2500);
    // FIX-18：goto 只等 __wwReady，板子列表单独条件等待
    await waitExpr('手机版：板子列表已渲染', `document.querySelectorAll('#m-board-grid > *').length >= 10`, { timeout: 6000 });
    const m1 = await b.eval(`({ cards: document.querySelectorAll('#m-board-grid > *').length, next: !!document.getElementById('m-next'), lang: !!document.getElementById('btn-lang') })`);
    check('手机版板子列表渲染', m1.cards >= 10, `${m1.cards} 个`);
    await b.shot(path.join(SHOTS, '05-mobile-boards.png'));
    await b.eval(`document.querySelector('#m-board-grid > *')?.click()`);
    // FIX-18：原来是固定 sleep(400)，改成等到选中板子后"下一步"可用
    await waitExpr('手机版：选择板子后下一步可用', `!!document.getElementById('m-next') && !document.getElementById('m-next').disabled`, { timeout: 4000 });
    await b.click('#m-next');
    // FIX-18：原来是固定 sleep(1500)，改成等到规则页真的显示且规则/座位渲染出来
    await waitExpr('手机版：规则页已进入且规则/座位已渲染',
      `[...document.querySelectorAll('.m-screen:not(.hidden)')].some((s) => s.id === 'm-rules') && document.querySelectorAll('#m-rules-list > *').length >= 5 && document.querySelectorAll('#m-my-seat option').length >= 4`,
      { timeout: 8000 });
    const m2 = await b.eval(`({ shown: [...document.querySelectorAll('.m-screen:not(.hidden)')].map(s=>s.id), rules: document.querySelectorAll('#m-rules-list > *').length, seats: document.querySelectorAll('#m-my-seat option').length })`);
    check('手机版进入规则页且规则/座位渲染', m2.shown.includes('m-rules') && m2.rules >= 5 && m2.seats >= 4, JSON.stringify(m2));
    await b.shot(path.join(SHOTS, '06-mobile-rules.png'));

    // 手机版图鉴：与桌面版同一份渲染（web/codex.js），只是细节走弹层而不是右侧栏
    await b.click('#m-back');
    // FIX-18：原来是固定 sleep(400)，改成等到真的退回板子页
    await waitExpr('手机版：已从规则页退回板子页', `[...document.querySelectorAll('.m-screen:not(.hidden)')].some((s) => s.id === 'm-boards')`, { timeout: 4000 });
    await b.click('#m-codex-btn');
    // FIX-18：原来是固定 sleep(900)，改成等到图鉴屏与牌面渲染出来
    await waitExpr('手机版图鉴：独立成屏且牌面已渲染',
      `[...document.querySelectorAll('.m-screen:not(.hidden)')].some((s) => s.id === 'm-codex') && document.querySelectorAll('#cdx-grid .cdx-card').length > 0 && !!document.querySelector('#cdx-grid img.role-art')`,
      { timeout: 6000 });
    const mc = await b.eval(`(() => {
      const info = window.Codex.pageInfo();
      const cards = [...document.querySelectorAll('#cdx-grid .cdx-card')];
      return {
        shown: [...document.querySelectorAll('.m-screen:not(.hidden)')].map((s) => s.id),
        cards: cards.length, art: document.querySelectorAll('#cdx-grid img.role-art').length,
        factions: cards.map((c) => c.dataset.faction),
        detail: !!document.querySelector('#m-codex #cdx-detail'),
        total: info.total, cap: info.cap, sizes: info.sizes, pageFactions: info.factions,
        title: (document.querySelector('#cdx-ptitle') || {}).textContent || '',
        meta: (document.querySelector('#cdx-pmeta') || {}).textContent || '',
        prevDisabled: document.querySelector('.cdx-prev').disabled,
      };
    })()`);
    check('手机版图鉴：独立成屏并渲染牌面', mc.shown.includes('m-codex') && mc.cards > 0 && mc.art === mc.cards, JSON.stringify({ shown: mc.shown, cards: mc.cards, art: mc.art }));
    check('手机版图鉴：一页只放一个阵营', mc.factions.length > 0 && new Set(mc.factions).size === 1, JSON.stringify(mc.factions));
    check('手机版图鉴：每页不超容量、整本可按页翻完', mc.sizes.every((n) => n <= mc.cap) && mc.total >= 4, JSON.stringify({ cap: mc.cap, sizes: mc.sizes, total: mc.total }));
    check('手机版图鉴：一页至少 4 张牌', mc.cap >= 4, `cap=${mc.cap}`);
    // 矮屏回归（用户实测机型）：旧实现按 2:3 卡框高度算容量，矮屏上只够 1 行 → 一页 2 张，翻一次只翻两张。
    await b.setViewport(390, 700, true);
    await b.eval(`window.dispatchEvent(new Event('resize'))`);
    // FIX-18（保留的固定 sleep，见报告）：容量重算走的是 180ms 防抖，而"重算完成"没有可观测标志
    // ——重算后 cap 的值可能**不变**（这正是"矮屏也必须 ≥4 张"这条断言的前提），
    // 所以这里没有任何可判定的页面条件，只能给防抖窗口留时间。断言本身仍由下一行给出实测值。
    await sleep(320); // 容量重算有 180ms 防抖
    const shortCap = await b.eval(`(window.Codex && window.Codex.pageInfo) ? window.Codex.pageInfo().cap : -1`);
    check('手机版图鉴：矮屏（390×700）每页仍至少 4 张', shortCap >= 4, `cap=${shortCap}`);
    await b.setViewport(390, 844, true);
    await b.eval(`window.dispatchEvent(new Event('resize'))`);
    // FIX-18：原来是固定 sleep(320)，改成等到页码条真的重绘出来（这是随后两条断言读的东西）
    await waitExpr('手机版图鉴：视口改回 390×844 后页码条已重绘',
      `/页/.test((document.querySelector('#cdx-pmeta') || {}).textContent || '') && /阵营|第三方/.test((document.querySelector('#cdx-ptitle') || {}).textContent || '')`,
      { timeout: 4000, interval: 80 });
    check('手机版图鉴：页码条显示阵营与进度', /阵营|第三方/.test(mc.title) && /页/.test(mc.meta) && mc.prevDisabled === true, `${mc.title} / ${mc.meta}`);
    check('手机版图鉴：小屏不放右侧细节栏（走弹层）', mc.detail === false);
    await b.shot(path.join(SHOTS, '06b-mobile-codex.png'));
    // 逐页翻完，把 15 个身份全部收齐：这才是"一页满了就放下一页"的真凭据
    const walked = await b.eval(`(() => {
      const seen = [];
      const secs = [];
      for (let i = 0; i < 40; i++) {
        const info = window.Codex.pageInfo();
        seen.push(...info.cards);
        secs.push(info.faction);
        if (info.page >= info.total - 1) break;
        window.Codex.turn(1);
      }
      return { seen, secs };
    })()`);
    const uniq = [...new Set(walked.seen)];
    check('手机版图鉴：翻完每一页能收齐全部 15 个身份', uniq.length === 15, `${uniq.length} 个 / 共 ${walked.seen.length} 张`);
    check('手机版图鉴：阵营不会被拆到两页之间（每页只属一个阵营）', walked.secs.every((f, i) => i === 0 || f != null), JSON.stringify(walked.secs));
    // 翻到"神职"的第一页：验证每个阵营确实另起一页（不是接着上一阵营继续排）
    const jump = await b.eval(`(() => {
      const info = window.Codex.pageInfo();
      const i = info.factions.indexOf('god');
      window.Codex.goPage(i);
      const after = window.Codex.pageInfo();
      return {
        found: i, page: after.page, faction: after.faction,
        title: (document.querySelector('#cdx-ptitle') || {}).textContent || '',
        meta: (document.querySelector('#cdx-pmeta') || {}).textContent || '',
        cards: document.querySelectorAll('#cdx-grid .cdx-card').length,
      };
    })()`);
    check('手机版图鉴：每个阵营各起一页（神职在自己的页上）', jump.found > 0 && jump.faction === 'god' && /神职/.test(jump.title) && jump.cards > 0, JSON.stringify(jump));
    check('手机版图鉴：多页阵营标出"本阵营第几页"', /\d\s*\/\s*\d/.test(jump.meta), jump.meta);
    await b.shot(path.join(SHOTS, '06d-mobile-codex-page2.png'));
    await b.eval(`document.querySelectorAll('#cdx-grid .cdx-card')[0].click()`);
    await waitExpr('手机版图鉴：点牌后细节弹层已弹出（含徽记与打法）',
      `(() => { const m = document.querySelector('#m-modal .modal'); return !!m && m.getBoundingClientRect().height > 200 && !!document.querySelector('#m-modal .mbody .cdx-dname') && document.querySelectorAll('#m-modal .cdx-chips span').length >= 3; })()`,
      { timeout: 5000 });
    const ms = await b.eval(`(() => {
      const box = document.querySelector('#m-modal .modal');
      return {
        sheet: !!document.querySelector('#m-modal .mbody .cdx-dname'),
        // 高度必须量：曾经因为 ".modal 套 .modal" 把弹层压成一条 4px 的线，内容在、就是看不见
        h: box ? Math.round(box.getBoundingClientRect().height) : 0,
        name: (document.querySelector('#m-modal .cdx-dname') || {}).textContent || '',
        chips: document.querySelectorAll('#m-modal .cdx-chips span').length,
        strat: document.querySelectorAll('#m-modal .cdx-strat div').length,
      };
    })()`);
    check('手机版图鉴：点牌弹出细节层（含徽记与 AI 打法）', ms.sheet && ms.h > 200 && ms.name.length > 0 && ms.chips >= 3 && ms.strat >= 2, JSON.stringify(ms));
    await b.shot(path.join(SHOTS, '06c-mobile-codex-detail.png'));
    // 细节层现在有多个 ghost 按钮（检视/规则书/关闭）：按文本找"关闭"，不能盲点第一个
    await b.eval(`[...document.querySelectorAll('#m-modal .modal .btn')].find((b) => b.textContent.includes('关闭'))?.click()`);
    // FIX-18：原来是固定 sleep(300)，改成等到细节层真的关掉
    await waitExpr('手机版图鉴：细节弹层已关闭', `!document.querySelector('#m-modal .modal')`, { timeout: 4000 });
    await b.click('#m-codex-back');
    // FIX-18：原来是固定 sleep(400)，改成等到真的退回板子页
    await waitExpr('手机版图鉴：已退回板子页', `[...document.querySelectorAll('.m-screen:not(.hidden)')].map((s) => s.id).join(',') === 'm-boards'`, { timeout: 4000 });
    check('手机版图鉴：返回回到板子页', await b.eval(`[...document.querySelectorAll('.m-screen:not(.hidden)')].map((s) => s.id).join(',')`) === 'm-boards');

    // ---- 6.5 手机端档案回收区（FIX-04，390×844）：与桌面端同一能力，同样只认几何 + 真实点击 ----
    // 手机端档案管理走**底部弹层**（openSheet → #m-sheet / .m-sheet + .m-sheet-body），不是 #m-modal/.mbody；
    // 这台设备上弹层塌成"一条线"出过真实事故，所以这里量真实高度，而不是"文字在不在 DOM 里"。
    log('\n=== 手机端档案回收区（390×844）===');
    {
      const j = async (method, p, body) => {
        const r = await fetch(base + p, {
          method,
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        let d = null;
        try { d = await r.json(); } catch (_) { /* 允许空响应 */ }
        return { code: r.status, body: d };
      };
      const del = async (nickname) => {
        const c = await j('POST', '/api/profiles', { nickname });
        if (c.code !== 200) throw new Error(`建档案失败：${JSON.stringify(c.body)}`);
        const id = c.body.profile.id;
        const a = await j('PATCH', `/api/profiles/${id}`, { expectedRevision: c.body.profile.revision, archive: true });
        const d = await j('DELETE', `/api/profiles/${id}`);
        if (a.code !== 200 || d.code !== 200) throw new Error(`归档/删除失败：${JSON.stringify({ a: a.body, d: d.body })}`);
        return { id, archiveId: d.body.archiveId };
      };
      // 清掉桌面段落留下的回收区残渣（服务端恢复成功后会清墓碑；这里兜一层，让手机段落状态可判定）
      fs.rmSync(path.join(DIR, 'profiles', 'trash'), { recursive: true, force: true });

      await b.realClick('#m-profile-chip');
      // FIX-18：原来是固定 sleep(700)，改成等到底部弹层里的回收区入口渲染出来
      await waitExpr('手机端档案弹层：回收区入口已渲染', `!!document.getElementById('m-pm-trash-entry')`, { timeout: 6000 });
      const mEntry = await b.eval(`(() => {
        const e = document.getElementById('m-pm-trash-entry');
        if (!e) return null;
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return { w: Math.round(r.width), h: Math.round(r.height), text: e.textContent.trim(),
          visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' };
      })()`);
      check('手机端：档案管理弹层里有回收区入口且可点（≥44px 触区、非隐藏）', !!mEntry && mEntry.visible === true && mEntry.h >= 44, JSON.stringify(mEntry));

      // 空态先测（此刻回收区真的是空的）
      await b.realClick('#m-pm-trash-entry');
      // FIX-18：原来是"固定 sleep(150) × 40 次"的轮询，改成带超时的条件等待
      await waitExpr('手机端回收区：状态已判定（empty/items/error）',
        `['empty','items','error'].includes(document.getElementById('m-pm-trash-list')?.dataset.state || '')`, { timeout: 6000 });
      const mEmpty = await b.eval(`(() => {
        const sheet = document.querySelector('#m-sheet .m-sheet');
        const list = document.getElementById('m-pm-trash-list');
        return { sheetH: sheet ? Math.round(sheet.getBoundingClientRect().height) : -1,
          ownsList: !!(sheet && list && sheet.contains(list)),
          state: list ? list.dataset.state : '', rows: document.querySelectorAll('#m-pm-trash-list .pm-row').length,
          text: (list?.querySelector('.hint') || {}).textContent || '' };
      })()`);
      check('手机端回收区：空态有明确文案（不是空白面板）',
        mEmpty.state === 'empty' && mEmpty.rows === 0 && mEmpty.text.length > 8, JSON.stringify({ state: mEmpty.state, text: mEmpty.text.slice(0, 30) }));
      check('手机端回收区：空态下弹层仍有真实高度', mEmpty.sheetH >= 120 && mEmpty.ownsList === true,
        `弹层高度=${mEmpty.sheetH}px 弹层持有列表=${mEmpty.ownsList}`);

      // 返回列表 → 造一条真的"已删除"档案 → 再进回收区
      await b.eval(`[...document.querySelectorAll('#m-sheet .btn')].find((x) => /返回档案列表/.test(x.textContent))?.click()`);
      // FIX-18：原来是固定 sleep(500)，改成等到真的退回档案列表
      await waitExpr('手机端档案弹层：已退回档案列表', `!!document.getElementById('m-pm-trash-entry') && !document.getElementById('m-pm-trash-list')`, { timeout: 5000 });
      const rec = await del('手机回收区丙');
      await b.realClick('#m-pm-trash-entry');
      // FIX-18：原来是"固定 sleep(150) × 40 次"的轮询，改成带超时的条件等待
      await waitExpr('手机端回收区：列表已渲染（items/error）',
        `['items','error'].includes(document.getElementById('m-pm-trash-list')?.dataset.state || '')`, { timeout: 6000 });
      const mPanel = await b.eval(`(() => {
        const sheet = document.querySelector('#m-sheet .m-sheet');
        const bodyEl = document.querySelector('#m-sheet .m-sheet-body');
        const list = document.getElementById('m-pm-trash-list');
        const rows = [...document.querySelectorAll('#m-pm-trash-list .pm-row')];
        return {
          sheetH: sheet ? Math.round(sheet.getBoundingClientRect().height) : -1,
          bodyH: bodyEl ? Math.round(bodyEl.getBoundingClientRect().height) : -1,
          listH: list ? Math.round(list.getBoundingClientRect().height) : -1,
          ownsList: !!(sheet && list && sheet.contains(list)),
          state: list ? list.dataset.state : '',
          rows: rows.length,
          name: (rows[0]?.querySelector('.pm-name') || {}).textContent || '',
          meta: (rows[0]?.querySelector('.hint') || {}).textContent || '',
          nestedModal: document.querySelectorAll('#m-sheet .modal').length,
          vpH: window.innerHeight,
        };
      })()`);
      check('手机端回收区：弹层有真实高度（不是塌成一条线）',
        mPanel.sheetH >= 120 && mPanel.sheetH <= mPanel.vpH && mPanel.ownsList === true,
        `弹层高度=${mPanel.sheetH}px（视口 ${mPanel.vpH}px）弹层持有列表=${mPanel.ownsList}`);
      check('手机端回收区：正文与列表容器都有真实高度',
        mPanel.bodyH >= 60 && mPanel.listH >= 40 && mPanel.nestedModal === 0, `正文=${mPanel.bodyH}px 列表=${mPanel.listH}px`);
      check('手机端回收区：列出被删除的档案（昵称 + 删除时间，内容真渲染）',
        mPanel.state === 'items' && mPanel.rows === 1 && mPanel.name.includes('手机回收区丙') && /删除于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(mPanel.meta),
        JSON.stringify({ state: mPanel.state, rows: mPanel.rows, name: mPanel.name, meta: mPanel.meta }));
      await b.shot(path.join(SHOTS, '06e-mobile-profile-trash.png'));

      await b.realClick(`#m-pm-trash-list .pm-restore[data-archive-id=${JSON.stringify(rec.archiveId)}]`);
      // FIX-18：原来是"固定 sleep(150) × 40 次"的轮询，改成带超时的条件等待
      await waitExpr('手机端回收区：恢复操作的提示已落地', `/已恢复|恢复失败/.test(document.getElementById('m-pm-trash-msg')?.textContent || '')`, { timeout: 6000 });
      const mMsg = await b.eval(`document.getElementById('m-pm-trash-msg')?.textContent || ''`);
      const mAfter = await b.eval(`(() => {
        const list = document.getElementById('m-pm-trash-list');
        return { state: list ? list.dataset.state : '', rows: document.querySelectorAll('#m-pm-trash-list .pm-row').length,
          ids: [...document.querySelectorAll('#m-pm-trash-list .pm-row')].map((r) => r.dataset.archiveId),
          text: (list?.querySelector('.hint') || {}).textContent || '',
          listH: list ? Math.round(list.getBoundingClientRect().height) : -1 };
      })()`);
      const mRestored = ((await j('GET', '/api/profiles')).body.profiles || []).find((x) => x.id === rec.id);
      check('手机端回收区：恢复成功给出可读提示（含"可以直接使用"）',
        /已恢复/.test(mMsg) && /手机回收区丙/.test(mMsg) && /可以直接使用/.test(mMsg), mMsg.slice(0, 70));
      check('手机端回收区：恢复后该条从回收站消失（回到空态且空态文案非空）',
        mAfter.state === 'empty' && mAfter.rows === 0 && !mAfter.ids.includes(rec.archiveId)
        && mAfter.text.length > 8 && mAfter.listH >= 16, JSON.stringify(mAfter));
      check('手机端回收区：恢复后档案立即可用（服务端证据：archivedAt 已清空）',
        !!mRestored && mRestored.archivedAt === null, JSON.stringify(mRestored || null));

      await b.eval(`[...document.querySelectorAll('#m-sheet .btn')].find((x) => /返回档案列表/.test(x.textContent))?.click()`);
      // FIX-18：原来是固定 sleep(600)，改成等到档案列表真的刷新出"手机回收区丙"且为可用态
      await waitExpr('手机端档案列表：恢复出来的档案已回到列表（可用态）',
        `[...document.querySelectorAll('#m-sheet .pm-row')].some((r) => /手机回收区丙/.test((r.querySelector('.pm-name') || {}).textContent || '') && !r.classList.contains('archived'))`,
        { timeout: 6000 });
      const mBack = await b.eval(`[...document.querySelectorAll('#m-sheet .pm-row')].map((r) => ({ name: (r.querySelector('.pm-name') || {}).textContent || '', archived: r.classList.contains('archived') }))`);
      check('手机端回收区：恢复后的档案出现在档案列表且是可用态',
        mBack.some((r) => r.name.includes('手机回收区丙') && !r.archived), JSON.stringify(mBack));
      await b.eval(`document.querySelector('#m-sheet .m-sheet-head .btn')?.click()`); // 关掉底部弹层，别留给后续段落
      // FIX-18：原来是固定 sleep(400)，改成等到底部弹层真的清空
      await waitExpr('手机端回收区：底部弹层已关闭（DOM 清空）', `document.querySelectorAll('#m-sheet > *').length === 0`, { timeout: 5000 });
      check('手机端回收区：弹层可关闭', await b.eval(`document.querySelectorAll('#m-sheet > *').length`) === 0);
    }

    // ---- 6.6 FIX-08（手机端）：Esc 关浮层 —— .m-sheet / #m-modal，遮罩与 body 滚动锁一起清 ----
    // 改前就红的三件事：① pwa.js 的 Esc 选择器里根本没有 `.m-sheet`（弹层原地不动）；
    // ② 就算把 .modal 设成 hidden，手机端遮罩 `#m-modal .modal-mask{display:flex}` 也不会消失
    //    —— 屏幕上留一块挡满全屏、点不动的暗层；③ 两端都没有 body 滚动锁（新增行为）。
    // 量 computed display / getBoundingClientRect / getClientRects，**不**看 hidden 属性。
    log('\n=== FIX-08 手机端 Esc 关浮层（真实按键）===');
    {
      const mState = () => b.eval(`(() => {
        const rect = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return {
          w: Math.round(r.width), h: Math.round(r.height), c: n.getClientRects().length, d: getComputedStyle(n).display }; };
        return {
          sheet: rect(document.querySelector('#m-sheet .m-sheet')),
          sheetMask: rect(document.querySelector('#m-sheet .m-sheet-mask')),
          modal: rect(document.querySelector('#m-modal .modal')),
          modalMask: rect(document.querySelector('#m-modal .modal-mask')),
          lock: getComputedStyle(document.body).overflow,
        };
      })()`);

      // ① 底部弹层（.m-sheet 挂在 #m-app 之外，选择器作用域写错就会漏掉它）
      await b.realClick('#m-profile-chip');
      // FIX-18：原来是固定 sleep(900)，改成等到 .m-sheet 真的有真实尺寸
      await waitExpr('FIX-08 手机端：底部弹层已打开（有真实尺寸）',
        `(() => { const n = document.querySelector('#m-sheet .m-sheet'); return !!n && n.getClientRects().length > 0 && n.getBoundingClientRect().height >= 120; })()`,
        { timeout: 5000 });
      let ms = await mState();
      const sheetWasOpen = !!ms.sheet && ms.sheet.c > 0 && ms.sheet.h >= 120;
      check('FIX-08 手机端底部弹层打开：.m-sheet 有真实尺寸且在遮罩里',
        sheetWasOpen && !!ms.sheetMask && ms.sheetMask.c > 0,
        `sheet=${JSON.stringify(ms.sheet)} mask=${JSON.stringify(ms.sheetMask)}`);
      check('FIX-08 手机端底部弹层打开：body 上了滚动锁', ms.lock === 'hidden', `锁=${ms.lock}`);
      await b.pressKey('Escape');
      // FIX-18：原来是固定 sleep(700)，改成等到 .m-sheet 与遮罩都不再渲染
      await waitExpr('FIX-08 手机端：Esc 后底部弹层与遮罩都不再渲染',
        `(() => { const s = document.querySelector('#m-sheet .m-sheet'); const m = document.querySelector('#m-sheet .m-sheet-mask'); return (!s || (s.getClientRects().length === 0 && s.getBoundingClientRect().height === 0)) && (!m || m.getClientRects().length === 0); })()`,
        { timeout: 5000 });
      ms = await mState();
      check('FIX-08 手机端 Esc 关底部弹层：.m-sheet 与遮罩都不再渲染',
        sheetWasOpen && (ms.sheet === null || (ms.sheet.c === 0 && ms.sheet.h === 0)) && (ms.sheetMask === null || ms.sheetMask.c === 0),
        `按 Esc 前已打开=${sheetWasOpen} sheet=${JSON.stringify(ms.sheet)} mask=${JSON.stringify(ms.sheetMask)}`);
      check('FIX-08 手机端 Esc 关弹层后滚动锁释放', ms.lock !== 'hidden', `锁=${ms.lock}`);

      // ② 中部弹窗（#m-modal .modal + .modal-mask）
      await b.realClick('#m-settings-btn');
      // FIX-18：原来是固定 sleep(900)，改成等到中部弹窗真的有真实尺寸
      await waitExpr('FIX-08 手机端：中部弹窗已打开（有真实尺寸）',
        `(() => { const n = document.querySelector('#m-modal .modal'); return !!n && n.getClientRects().length > 0 && n.getBoundingClientRect().height >= 120; })()`,
        { timeout: 5000 });
      ms = await mState();
      const modalWasOpen = !!ms.modal && ms.modal.c > 0 && ms.modal.h >= 120;
      check('FIX-08 手机端中部弹窗打开：.modal 有真实尺寸且在遮罩里',
        modalWasOpen && !!ms.modalMask && ms.modalMask.c > 0,
        `modal=${JSON.stringify(ms.modal)} mask=${JSON.stringify(ms.modalMask)}`);
      check('FIX-08 手机端中部弹窗打开：body 上了滚动锁', ms.lock === 'hidden', `锁=${ms.lock}`);
      await b.pressKey('Escape');
      // FIX-18：原来是固定 sleep(700)，改成等到 .modal 与遮罩一起消失
      await waitExpr('FIX-08 手机端：Esc 后中部弹窗与遮罩一起消失',
        `(() => { const s = document.querySelector('#m-modal .modal'); const m = document.querySelector('#m-modal .modal-mask'); return (!s || s.getClientRects().length === 0) && (!m || m.getClientRects().length === 0); })()`,
        { timeout: 5000 });
      ms = await mState();
      check('FIX-08 手机端 Esc 关中部弹窗：.modal 与遮罩一起消失（改前遮罩会留在屏幕上挡全屏）',
        modalWasOpen && (ms.modal === null || ms.modal.c === 0) && (ms.modalMask === null || ms.modalMask.c === 0),
        `按 Esc 前已打开=${modalWasOpen} modal=${JSON.stringify(ms.modal)} mask=${JSON.stringify(ms.modalMask)}`);
      check('FIX-08 手机端 Esc 关中部弹窗后滚动锁释放', ms.lock !== 'hidden', `锁=${ms.lock}`);

      // ③ 点遮罩关闭（手机端最常用的关闭方式）：同样要清干净并解锁
      await b.realClick('#m-settings-btn');
      // FIX-18：原来是固定 sleep(900)，改成等到中部弹窗打开
      await waitExpr('FIX-08 手机端：点遮罩前中部弹窗已打开',
        `(() => { const n = document.querySelector('#m-modal .modal'); return !!n && n.getClientRects().length > 0; })()`, { timeout: 5000 });
      const modalWasOpen2 = await b.eval(`(() => { const m = document.querySelector('#m-modal .modal'); return !!m && m.getClientRects().length > 0; })()`);
      await b.realClickAt('#m-modal .modal-mask', 0.5, 0.02); // 顶部空白：弹窗居中，点中心会点到弹窗上
      // FIX-18：原来是固定 sleep(700)，改成等到弹窗真的被点掉
      await waitExpr('FIX-08 手机端：点遮罩后中部弹窗已清掉',
        `(() => { const n = document.querySelector('#m-modal .modal'); return !n || n.getClientRects().length === 0; })()`, { timeout: 5000 });
      ms = await mState();
      check('FIX-08 手机端点遮罩关中部弹窗：清掉且滚动锁释放',
        modalWasOpen2 && (ms.modal === null || ms.modal.c === 0) && ms.lock !== 'hidden',
        `点前已打开=${modalWasOpen2} modal=${JSON.stringify(ms.modal)} 锁=${ms.lock}`);
      await b.shot(path.join(SHOTS, '13d-mobile-esc-close.png'));
    }

    // ---- 6.7 FIX-10 / FIX-15（手机端）：手机端是独立实现，两端同款行为各验一次 ----
    log('\n=== FIX-10/FIX-15 手机端（409 自恢复 + 目标必选提示）===');
    {
      const jm = async (method, p, body) => {
        const r = await fetch(base + p, {
          method, headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        let d = null;
        try { d = await r.json(); } catch (_) { /* 允许空响应 */ }
        return { code: r.status, body: d };
      };
      const mprofs = ((await jm('GET', '/api/profiles')).body.profiles || []).filter((p) => !p.archivedAt);
      let mpid = mprofs.length ? mprofs[0].id : null;
      if (!mpid) mpid = (await jm('POST', '/api/profiles', { nickname: '手机 FIX10' })).body.profile.id;
      const mrec = await b.eval(`(async () => {
        const p = state.profiles.find((x) => x.id === ${JSON.stringify(mpid)});
        if (!p) return { missing: true };
        state.profileId = p.id;
        p.revision = Number(p.revision) + 991; // 真实过期（服务端会真的回 409）
        const before = p.revision;
        await saveProfilePrefs({ fontScale: 1.2, layout: 'compact', reducedMotion: true });
        const after = state.profiles.find((x) => x.id === p.id);
        return { before, rev: after.revision, layout: after.preferences.layout,
          flash: (document.getElementById('m-flash') || {}).textContent || '' };
      })()`);
      const msrvProf = ((await jm('GET', '/api/profiles')).body.profiles || []).find((p) => p.id === mpid);
      check('FIX-10 手机端：409 后自动重拉 revision 并重试成功（不再是永久自锁）',
        mrec.missing !== true && !!msrvProf && mrec.rev === msrvProf.revision && mrec.layout === 'compact' && /已保存/.test(mrec.flash),
        `revision ${mrec.before}→${mrec.rev}（服务端 ${msrvProf && msrvProf.revision}）flash="${mrec.flash}"`);
      const mperm = await b.eval(`(async () => {
        const orig = window.fetch;
        let patches = 0;
        window.fetch = function (u, o) {
          if (o && o.method === 'PATCH') {
            patches++;
            return Promise.resolve(new Response(JSON.stringify({ error: '另一窗口已更新该档案' }),
              { status: 409, headers: { 'content-type': 'application/json' } }));
          }
          return orig.apply(this, arguments);
        };
        try { await saveProfilePrefs({ fontScale: 1, layout: 'reading', reducedMotion: false }); }
        finally { window.fetch = orig; }
        return { patches, restored: window.fetch === orig, flash: (document.getElementById('m-flash') || {}).textContent || '' };
      })()`);
      check('FIX-10 手机端：始终冲突时 PATCH 恰好 2 次（不重试=1，无限重试>2）',
        mperm.patches === 2, `PATCH 次数=${mperm.patches}`);
      check('FIX-10 手机端：重试仍失败给出可读原因（不是裸状态码）',
        mperm.flash.length >= 8 && /另一个窗口|版本|冲突|刷新/.test(mperm.flash) && mperm.restored === true, `flash="${mperm.flash}"`);

      // FIX-15（手机端）：没选目标就点确认键，必须出可读提示、且不提交。
      // 面板用页面里**真实的** buildActionUI 组装（不是手工造 DOM），只喂一个假的待办对象；
      // actionState.target 保持页面当前的自然值，不人为改（改了就测不出"没选目标"这条路径）。
      const mGuard = await b.eval(`(() => {
        const keys = document.getElementById('m-keys');
        const dlg = document.getElementById('m-dialog');
        const hint = document.getElementById('m-pending-hint');
        const natural = actionState.target;
        keys.innerHTML = ''; dlg.innerHTML = '';
        const v = { me: { seat: 1, role: 'wolf', alive: true }, players: [
          { seat: 1, name: '我', alive: true }, { seat: 2, name: '甲', alive: true }, { seat: 3, name: '乙', alive: true }] };
        buildActionUI(v, { task: 'wolf_kill', candidates: [2, 3], allowNone: true }, keys, dlg);
        const conf = [...keys.querySelectorAll('button')].find((x) => x.textContent.trim() === '投刀');
        const before = hint.textContent;
        const disabled = conf ? conf.disabled : null;
        if (conf) conf.click();
        return { found: !!conf, disabled, natural, before, after: hint.textContent };
      })()`);
      check('FIX-15 手机端：确认键可用（改前是禁用键，点了彻底没反应）',
        mGuard.found === true && mGuard.disabled === false, JSON.stringify({ found: mGuard.found, disabled: mGuard.disabled }));
      check('FIX-15 手机端：没选目标点确认 → 可读提示（含怎么选、怎么放弃）',
        /请先在「玩家」页点一个座位/.test(mGuard.after) && /刀口/.test(mGuard.after) && /空刀/.test(mGuard.after),
        `自然目标=${mGuard.natural} 提示="${mGuard.after}"`);
      await b.eval(`document.getElementById('m-keys').innerHTML = ''; document.getElementById('m-dialog').innerHTML = '';`);
    }

    // ---- 7. 完整对局（观战 + Mock，无需人类作答）----
    if (FULL) {
      log('\n=== 观战 Mock 局跑到终局（--full）===');
      await b.setViewport(1440, 900, false);
      // 开新局之前先清掉"进行中的对局"：否则刷新后会**恢复上一局**，
      // 后面的点击打在设置页之外（本轮加翻牌段时就踩过一次：观战局根本没开起来）。
      await b.goto(base + '/', 1500);
      await b.eval(`localStorage.removeItem('ww_current'); localStorage.removeItem('ww_resumable');`);
      await b.goto(base + '/', 2000);
      // FIX-18：原来是"固定 sleep(250) × 80 次"的轮询，改成带超时的条件等待
      await waitExpr('--full：开始按钮已就绪（观战局前置）', `(() => { const s = document.getElementById('btn-start'); return !!s && !s.disabled; })()`, { timeout: 25000, interval: 200 });
      await b.realClick('#entry-settings');
      await b.realClick('input[name=mode][value=watch]');
      // FIX-18：原来是固定 sleep(400)，改成等到观战模式真的被选中
      await waitExpr('--full：模式已切到纯观战', `document.querySelector('input[name=mode]:checked')?.value === 'watch'`, { timeout: 3000 });
      check('切换到纯观战', await b.eval(`document.querySelector('input[name=mode]:checked').value`) === 'watch');
      await b.click('#use-mock');
      await b.click('#btn-start');
      await b.realClick('#modal-root .start-review .btn.primary:not(:disabled)');
      // FIX-18：原来是固定 sleep(2500)，改成等到真的进入对局页
      await waitExpr('--full：已进入对局页', `document.querySelector('.screen:not(.hidden)')?.id === 'screen-game'`, { timeout: 10000 });
      check('开局进入对局页', await b.eval(`document.querySelector('.screen:not(.hidden)')?.id`) === 'screen-game');
      // 中局留一张：这一刻圆桌上有座位状态、发言卡、可能的投票角标 —— 终局那张反而看不出这些
      // FIX-18：原来是固定 sleep(20000)，改成等"圆桌上真的有了中局内容"（条件就是下面断言读的东西）
      await waitCheck('--full：中局内容已渲染（座位 + 事件流 + 圆桌）', async () => await b.eval(
        `(() => { const seats = document.querySelectorAll('#seats .seat').length; const msgs = document.querySelectorAll('#stream .msg').length; return { ok: seats >= 4 && msgs >= 3 && !!document.querySelector('#seats .ring-stage'), seats, msgs }; })()`),
      { timeout: 30000, interval: 1000 });
      const mid = await b.eval(`({ seats: document.querySelectorAll('#seats .seat').length, msgs: document.querySelectorAll('#stream .msg').length, ring: !!document.querySelector('#seats .ring-stage') })`);
      check('中局：圆桌座位与事件流都已渲染', mid.seats >= 4 && mid.msgs >= 3 && mid.ring, JSON.stringify(mid));
      await b.shot(path.join(SHOTS, '07a-midgame.png'));
      // FIX-18：原来是"固定 sleep(3000) × 140 次"的轮询，改成带超时的条件等待（最多等 7 分钟，语义不变）
      const finRes = await waitCheck('--full：观战局跑到终局（教练面板出现）', async () => await b.eval(
        `(() => { const p = document.getElementById('coach-panel'); return { ok: !!p && !p.classList.contains('hidden'), hidden: p ? p.classList.contains('hidden') : null }; })()`),
      { timeout: 420000, interval: 3000 });
      const fin = finRes.ok === true;
      check('观战局自动跑到终局并出现教练面板', fin);
      await b.shot(path.join(SHOTS, '07-final-coach.png'));
      if (fin) {
        const clicked = await b.eval(`(() => { const bt=[...document.querySelectorAll('#coach-panel button')].find(x=>/点评|重新|生成/.test(x.textContent)); if(!bt) return null; bt.click(); return bt.textContent; })()`);
        check('教练面板存在可点的点评按钮', !!clicked, clicked || '未找到按钮');
        // FIX-18：原来这里是"固定 sleep(2000) × 30 次"的轮询。⚠ 第一次转换时我只把轮询
        // 换成"立即轮询"，判据照抄旧的（`!运行中|正在看` 且面板文本 >60 字）—— 结果**当场变红**：
        // 那个判据在"点评还没出来"时就已经成立（面板里本来就有别的内容），旧代码之所以没露馅，
        // 是因为它每轮都先 sleep(2000) 再读，等于把"等点评"偷偷寄存在固定延时里。
        // 这也正是本任务要根治的东西。现在判据改成**点评真的渲染出来**：
        // `.coach-body`（正文）与 `.coach-tag`（来源标注）同时存在 —— 二者只在 status=done 时才渲染
        // （web/app.js:4061/4066；running 只有 coach-body、未点评只有 hint、失败只有 coach-body+warn）。
        const coachRes = await waitCheck('--full：教练点评生成完成（正文 + 来源标注都已渲染）', async () => await b.eval(
          `(() => { const p = document.getElementById('coach-panel'); if (!p) return { ok: false, why: '无面板' };
            const body = p.querySelector('.coach-body'); const tag = p.querySelector('.coach-tag');
            const t = ((body && body.textContent) || '').trim();
            return { ok: !!body && !!tag && t.length > 60 && !/运行中|正在看/.test(t),
              bodyLen: t.length, tag: ((tag && tag.textContent) || '').slice(0, 50), why: body ? (tag ? 'ok' : '无来源标注') : '无正文' }; })()`),
        { timeout: 60000, interval: 1000 });
        const text = await b.eval(`document.getElementById('coach-panel')?.textContent?.trim() || ''`);
        check('教练点评生成完成且有正文', coachRes.ok === true && text.length > 60,
          `${text.length} 字｜正文长度=${coachRes.bodyLen}｜来源标注=${JSON.stringify(coachRes.tag || '')}`);
        // 失败时必须打印**实测到的**文本片段，而不是一个空字符串（旧写法匹配不到就什么都不显示）
        check('Mock 局点评如实标注未用 AI（不静默降级）', /未使用 AI|未调用 AI/.test(text),
          `实测片段=${JSON.stringify((text.match(/.{0,20}(?:未使用 AI|未调用 AI).{0,44}/) || [text.slice(0, 100)])[0])}`);
        await b.shot(path.join(SHOTS, '08-coach-text.png'));
      }
      // UI 勾选的 Mock 必须落到存档（否则重启后按真实对局重建 → 意外花钱）
      const savesDir = path.join(DIR, 'saves');
      const flags = fs.existsSync(savesDir)
        ? fs.readdirSync(savesDir).filter((f) => f.endsWith('.json')).map((f) => { try { return !!JSON.parse(fs.readFileSync(path.join(savesDir, f), 'utf8')).mock; } catch (_) { return null; } })
        : [];
      check('UI 勾选的 Mock 落到存档', flags.some((x) => x === true), JSON.stringify(flags));

      // ---- 7b. 玩家视角：身份翻牌（开局第一眼）----
      // 放在最后跑：它要开一局"我参战"的 Mock 局，会和观战局抢 localStorage 的"当前对局"。
      log('\n=== 玩家视角：身份翻牌（开局第一眼）===');
      await b.goto(base + '/', 1500);
      await b.eval(`localStorage.removeItem('ww_current'); localStorage.removeItem('ww_resumable');`);
      await b.goto(base + '/', 2000);
      // FIX-18：原来是"固定 sleep(250) × 80 次"的轮询，改成带超时的条件等待
      await waitExpr('--full 7b：开始按钮已就绪（玩家视角前置）', `(() => { const s = document.getElementById('btn-start'); return !!s && !s.disabled; })()`, { timeout: 25000, interval: 200 });
      await b.realClick('#entry-settings');
      await b.realClick('input[name=mode][value=play]');
      // FIX-18：原来是固定 sleep(300)，改成等到"我参战"模式真的被选中
      await waitExpr('--full 7b：模式已切到"我参战"', `document.querySelector('input[name=mode]:checked')?.value === 'play'`, { timeout: 3000 });
      await b.click('#use-mock');
      await b.click('#btn-start');
      await b.realClick('#modal-root .start-review .btn.primary:not(:disabled)');
      // FIX-18：原来是固定 sleep(2500)，改成等到翻牌遮罩真的出现
      await waitExpr('--full 7b：身份翻牌遮罩已出现',
        `(() => { const o = document.getElementById('role-overlay'); return !!o && !o.classList.contains('hidden'); })()`, { timeout: 10000 });
      const flip = await b.eval(`(() => { const o=document.getElementById('role-overlay'); return { shown: !!o && !o.classList.contains('hidden'), caption: (document.getElementById('flip-caption')?.textContent||'').slice(0,20) }; })()`);
      check('玩家视角出现翻牌遮罩且给了提示', flip.shown && flip.caption.length > 0, JSON.stringify(flip));
      await b.shot(path.join(SHOTS, '07b-flip.png'));
      await b.click('#flip-card');
      // FIX-18：原来是固定 sleep(700)，改成等到牌真的翻开（截图前置条件）
      await waitExpr('--full 7b：身份牌已翻开（截图前置条件）',
        `(() => { const c = document.getElementById('flip-card'); return !!c && (c.classList.contains('open') || c.classList.contains('flipped') || !!c.querySelector('.card-frame')); })()`,
        { timeout: 4000 });
      await b.shot(path.join(SHOTS, '07c-flip-open.png'));
      await b.click('#btn-flip-done');
      // FIX-18：原来是固定 sleep(1500)，改成等到真的进入对局页
      await waitExpr('--full 7b：确认翻牌后已进入对局页', `document.querySelector('.screen:not(.hidden)')?.id === 'screen-game'`, { timeout: 8000 });
      check('翻牌确认后进入对局页', await b.eval(`document.querySelector('.screen:not(.hidden)')?.id`) === 'screen-game');
      // 收尾：终结本段开的 Mock 局。否则它会在 P4 断言期间被 4s 存盘定时器写盘，
      // checkResume 的"自动找回"点亮恢复卡，P4-4 的两条断言（假设无其它活局）就会误红
      // （清场用 /api/games 也扫不到还没落盘的内存局——施工期实测踩过）。
      await b.eval(`(async () => {
        const h = JSON.parse(localStorage.getItem('ww_current') || 'null');
        if (!h) return;
        await fetch(\`/api/games/\${h.gameId}/terminate\`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: h.playerToken || h.godToken }) });
      })()`);
      // FIX-18（保留的固定 sleep，见报告）：这里是等**服务端**把 terminate 落盘（本局 4s 存盘定时器 + 服务端收尾），
      // 页面里没有任何可观测的完成标志 —— 该局已被终止、界面不再变化，所以没有可判定的条件。
      await sleep(600);
    }

    // ---- 7.5 P4 断言：恢复卡片详情 / 终止后刷新 / 推送降级与重连 / 空刀拦截 ----
    // 这些都是"只有真实浏览器才能验"的修复：用 API 造局与出招（快、稳），用真实鼠标与断网验界面行为。
    {
      const api = async (method, p, body) => {
        const r = await fetch(base + p, {
          method,
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        let j = null;
        try { j = await r.json(); } catch (_) { /* 允许空响应 */ }
        return { code: r.status, body: j };
      };
      const mkGame = async (boardId, seats, seed) => {
        const players = Array.from({ length: seats }, (_, k) => ({ name: k === 0 ? '我' : `AI-${k + 1}`, isHuman: k === 0 }));
        const res = await api('POST', '/api/games', { boardId, mock: true, seed, players });
        if (res.code !== 200) throw new Error(`造局失败：${JSON.stringify(res.body)}`);
        return res.body;
      };
      const enter = async (g) => {
        await b.eval(`localStorage.setItem('ww_current', ${JSON.stringify(JSON.stringify(g))})`);
        await b.goto(base + '/', 2200);
      };
      // ⚠ 实测发现（FIX-17）：`enter()` 写下的 ww_current 指向的局只要还在**运行内存**里，
      // web/app.js:4176-4184 就会在页面初始化后**自动恢复**它 —— 页面根本没有停在首页等人点
      // 「继续对局」的机会。所以这些段落里原来那句 `b.click('#btn-resume')` 点的是一个已隐藏的卡片
      // （合成事件在 0×0 上也照样"点中"），紧接着的"已进入对局页"断言因此是空转的。
      // 统一改用下面的助手：等**页面自己**进局屏（这就是真实发生的因果），
      // "点恢复卡片"的真路只在 P4-1 覆盖 —— 那里是服务端重启后的磁盘局，卡片真的可见可点，
      // 并且已用真实鼠标 + 几何/命中断言钉住。
      const enterAndWaitGame = async (g, label) => {
        await enter(g);
        await waitExpr(label, `document.querySelector('.screen:not(.hidden)')?.id === 'screen-game'`, { timeout: 12000 });
      };
      // 服务端事件计数：用来判断"这一次点击到底提交出去没有"——只看界面提示是不够的
      // （面板会随推送重绘并重置提示，而且面板可能预选了目标，那样"空刀"根本不空）。
      const countKnifeEvents = async (gid, tk) => {
        const v = (await api('GET', `/api/games/${gid}/view?token=${tk}&after=0`)).body || {};
        return (v.events || []).filter((e) => String(e.type || '').includes('wolf_kill')).length;
      };

      // (D) P3-a 恢复卡片必须显示人数/天数/试玩还是真局
      log('\n=== P4-1 恢复卡片详情 ===');
      /**
       * FIX-17 前置：把服务端**重启**一次，制造"对局只在存档里、不在运行内存里"的真实状态。
       *
       * 为什么非这样不可（这是 FIX-17 挖出来的真实缺陷，不是为了让检查变绿）：
       * web/app.js:4176-4184 在页面初始化后会**自动恢复内存中的对局**，所以只要对局还在运行内存里，
       * 「继续上局」卡片只存在一瞬（实测 getBoundingClientRect 全 0、中心点被对局屏/翻牌浮层盖住）。
       * 也就是说：老写法 `check('刷新后出现恢复卡片', cardText.hidden === false)` 读的是一个
       * **当时根本不可见**的节点 —— 断言一直是空转的（对应计划书 §11.3"只断言存在 + 文字"）。
       * 真实用户能看到这张卡片的场景只有一个：服务重启过、对局只剩磁盘存档
       * （/session 明确不把磁盘局放回运行内存，src/api.js:906-910）→ 卡片显示「从存档恢复」，页面不再自动进局。
       * 顺带覆盖一条此前**完全没走过**的真路：从存档恢复（SessionModel.prepare → POST /api/games/:id/resume）。
       */
      const restartServer = async () => {
        const env = { ...process.env, PORT: String(PORT), WW_DATA_DIR: DIR, NO_OPEN: '1', LOG_LEVEL: 'warn' };
        await new Promise((res) => {
          if (server.exitCode !== null || server.signalCode) return res();
          let done = false;
          const fin = () => { if (!done) { done = true; clearTimeout(t); res(); } };
          const t = setTimeout(fin, 5000);
          server.once('exit', fin);
          server.kill();
        });
        server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
        server.stderr.on('data', (d) => { serverErr += d; });
        await waitFor(async () => {
          try { return { ok: (await fetch(`${base}/api/meta`)).ok }; } catch (e) { return { ok: false, err: e.message }; }
        }, { label: 'FIX-17 前置：服务端重启后在同一端口重新就绪', timeout: 20000, interval: 200 });
      };
      const g1 = await mkGame('quick10', 10, 31337);
      // 必须先开局：恢复卡片的条件是 `!finished && started`（实测漏了 start 就永远看不到卡片）
      await api('POST', `/api/games/${g1.gameId}/start`, { token: g1.playerToken });
      // FIX-18：原来是固定 sleep(400)，改成等**服务端**确认这一局真的开局了（可判定条件在 /api/games 里）
      await waitFor(async () => {
        const rows = (((await api('GET', '/api/games')).body || {}).rows) || [];
        const r = rows.find((x) => x.id === g1.gameId);
        return { ok: !!(r && r.started), row: r ? { started: r.started, finished: r.finished, inMemory: r.inMemory } : null };
      }, { label: 'P4-1 前置：g1 在服务端已开局', timeout: 6000, interval: 150 });
      // FIX-18：等这一局**真正落盘**（服务端 4s 一个节拍同时做落盘 + 内存治理，src/api.js:566-577）。
      // 判据直接看磁盘文件：重启之后，服务端只可能从这份存档把对局读回来。
      await waitFor(async () => {
        const f = path.join(DIR, 'saves', `${g1.gameId}.json`);
        return { ok: fs.existsSync(f), file: path.basename(f), saveDir: fs.existsSync(path.join(DIR, 'saves')) };
      }, { label: 'P4-1 前置：g1 已写入存档（重启后才能「从存档恢复」）', timeout: 25000, interval: 400 });
      await restartServer();
      await enter(g1);
      // FIX-18：原来是"固定 sleep 后直接断言"，改成等到恢复卡真的出现（条件就是紧接着断言读的东西）
      await waitExpr('P4-1：刷新后出现恢复卡（磁盘局，页面不再自动进局）',
        `(() => { const b = document.getElementById('resume-box'); return !!b && !b.classList.contains('hidden') && document.querySelector('.screen:not(.hidden)')?.id === 'screen-setup'; })()`,
        { timeout: 10000 });
      // ---- FIX-17：恢复卡的几何/遮挡断言（不许只有"div 里有没有文字"）----
      const resumeCardProbe = await b.probe('#resume-box', { scroll: true });
      checkGeometry('FIX-17 恢复卡：卡片可见、非零尺寸、在视口内、中心点未被遮挡', resumeCardProbe, { minW: 240, minH: 60 });
      const resumeBtnProbe = await b.probe('#btn-resume', { scroll: true });
      checkGeometry('FIX-17 恢复卡：「继续对局」按钮可见、非零尺寸、在视口内、中心点未被遮挡', resumeBtnProbe, { minW: 90, minH: 32 });
      const discardBtnProbe = await b.probe('#btn-discard', { scroll: true });
      checkGeometry('FIX-17 恢复卡：「放弃并清除」按钮可见、非零尺寸、在视口内、中心点未被遮挡', discardBtnProbe, { minW: 90, minH: 32 });
      const cardText = await b.eval(`(() => {
        const box = document.getElementById('resume-box');
        // UI 审查轮：标题与详情 meta 分两行（一行五层括号信息过载），断言读整卡文本
        const text = box ? (box.querySelector('h2')?.textContent || '') + '|' + (box.querySelector('#resume-meta')?.textContent || '') : '';
        return { hidden: !box || box.classList.contains('hidden'), h2: text };
      })()`);
      check('刷新后出现恢复卡片', cardText.hidden === false, cardText.h2);
      check('卡片含人数', /\d+\s*人局/.test(cardText.h2), cardText.h2);
      check('卡片含试玩/真实标注', /(试玩局|真实对局)/.test(cardText.h2), cardText.h2);
      // FIX-17：这一处是**只有磁盘存档**的局（服务端刚重启过），标题必须是「从存档恢复」——
      // 它同时也证明"页面没有偷偷自动进局"，所以上面的几何断言测的确实是用户能看到的那张卡。
      check('FIX-17 恢复卡：磁盘局显示「从存档恢复」而非「继续上局」（证明页面没有自动进局）',
        /从存档恢复/.test(cardText.h2), cardText.h2);
      await b.shot(path.join(SHOTS, '10-resume-card.png'));
      // FIX-17：控件必须**真的点得动**并产生预期效果 —— 真实鼠标点「继续对局」→ 从存档恢复进对局页。
      // realClick 现在自带命中测试：不可见/被遮挡会返回 NOT_CLICKABLE:<实测值>，不再"假装点到"。
      const resumeClick = await b.realClick('#btn-resume');
      check('FIX-17 恢复卡：「继续对局」的点击真实命中（真实鼠标事件 + 命中测试通过）', resumeClick === 'OK', `realClick=${resumeClick}`);
      await waitExpr('FIX-17 恢复卡：真实鼠标点「继续对局」后从存档恢复进入对局页',
        `document.querySelector('.screen:not(.hidden)')?.id === 'screen-game'`, { timeout: 15000 });
      check('FIX-17 恢复卡：「继续对局」真的生效（页面切到对局屏）',
        await b.eval(`document.querySelector('.screen:not(.hidden)')?.id`) === 'screen-game',
        `当前屏=${await b.eval(`document.querySelector('.screen:not(.hidden)')?.id`)}`);

      // (C) P2-c 终止后刷新：不得再被当活局恢复（客户端要自愈并清掉 localStorage）
      log('\n=== P4-4 终止后刷新 ===');
      // 先清掉前序段落（手机翻牌/完整局等）遗留的活局：checkResume 的"自动找回会话"会把
      // 那些局点亮成恢复卡，下面的两条断言只在"无任何其它活局"的基线上成立（施工期实测踩过）
      {
        const allGames = await api('GET', '/api/games');
        for (const r of (allGames.rows || [])) {
          // 判据只看"服务端还有没有这一局没结束"，**不看 inMemory**：checkResume 的自动找回
          // （web/app.js:843-857）连只在磁盘上的局也会点亮成恢复卡。施工期踩过：本段前面刚重启过服务端，
          // 早先建的局都掉出了运行内存，旧写法（只清 inMemory）漏掉它们 → 恢复卡又亮了、两条断言误红。
          if (r.started && !r.finished) {
            try {
              const t = await api('GET', `/api/games/${r.id}/tokens`);
              await api('POST', `/api/games/${r.id}/terminate`, { token: t.player || t.god });
            } catch (_) { /* 已结束则忽略 */ }
          }
        }
      }
      // ⚠ P4-1 里 g1 走的真路是"从存档恢复"：服务端会**重新签发对局令牌**
      // （src/api.js:516-528，注释明说它与 resumePaused 的唯一区别就是令牌轮换）——
      // 拿创建时的 playerToken 再调接口会 403「token 无效」（施工期实测就是这么红的）。
      // 所以这一段一律用服务端当前的令牌（/tokens 是管理接口）。
      const tok1 = (((await api('GET', `/api/games/${g1.gameId}/tokens`)).body) || {});
      const tok1Use = tok1.player || tok1.god || g1.playerToken;
      await api('POST', `/api/games/${g1.gameId}/start`, { token: tok1Use });
      // FIX-18：原来是固定 sleep(500)，改成等服务端确认开局（此后才 terminate，顺序不能乱）
      await waitFor(async () => {
        const rows = (((await api('GET', '/api/games')).body || {}).rows) || [];
        const r = rows.find((x) => x.id === g1.gameId);
        return { ok: !!(r && r.started && !r.finished), row: r ? { started: r.started, finished: r.finished } : null };
      }, { label: 'P4-4 前置：g1 在服务端已开局', timeout: 6000, interval: 150 });
      const termRes = await api('POST', `/api/games/${g1.gameId}/terminate`, { token: tok1Use });
      check('P4-4 前置：终止接口确认成功（不是静默失败）', termRes.code === 200,
        `POST terminate → ${termRes.code} ${JSON.stringify(termRes.body).slice(0, 120)}`);
      // FIX-18/自证：终止必须真的生效，而且**服务端不能还留着任何"已开局未结束"的活局** ——
      // 恢复卡只可能来自这种局（checkResume 的 ww_current 分支或自动找回分支）。
      // 把前提显式断言出来，比"断言红了再去猜"省一轮（施工期就为这条误红过两次）。
      const liveAfter = (((await api('GET', '/api/games')).body || {}).rows || []).filter((x) => x.started && !x.finished);
      check('P4-4 前置：服务端已无未结束的活局（恢复卡在物理上不可能出现）', liveAfter.length === 0,
        `仍有 ${liveAfter.length} 局：${JSON.stringify(liveAfter.map((x) => ({ id: x.id, inMemory: x.inMemory, mine: x.id === g1.gameId })))}｜g1=${g1.gameId}`);
      await b.goto(base + '/', 2200);
      // FIX-18：原来是固定 sleep(400)，改成等到页面里的 checkResume **已经作出判断**
      // （判断的观测标志：恢复卡显示 或 空态文案显示 —— 二者必居其一；不是空等）
      await waitExpr('P4-4：页面已完成"继续上局"检查（恢复卡或空态文案已判定）',
        `(() => { const box = document.getElementById('resume-box'); const empty = document.getElementById('resume-empty'); return (!!box && !box.classList.contains('hidden')) || (!!empty && !empty.classList.contains('hidden')); })()`,
        { timeout: 8000 });
      const afterTerm = await b.eval(`(() => {
        const box = document.getElementById('resume-box');
        return { hidden: !box || box.classList.contains('hidden'), saved: localStorage.getItem('ww_current') };
      })()`);
      check('终止后刷新不再提示可恢复', afterTerm.hidden === true, `hidden=${afterTerm.hidden}`);
      check('终止后 localStorage 里的当前对局已被清掉', !afterTerm.saved, String(afterTerm.saved).slice(0, 60));

      // (B) P2-a 降级状态条：单例 + 可读文案 + 可移除
      // 方法限制（如实标注）：CDP 的离线模拟**不影响已经建立的 SSE 长连接**（实测断网后应用完全无感），
      // 所以"真实断线 → 自动重连"这条路径在浏览器侧无法可靠触发；它由 P1-6/P1-7 的 API 层用例
      // 与源码守卫覆盖。这里验证状态条本身的行为 —— 那正是当初修的"多条堆叠"问题。
      log('\n=== P4-6 推送降级状态条（单例）===');
      const g2 = await mkGame('quick10', 10, 4242);
      await api('POST', `/api/games/${g2.gameId}/start`, { token: g2.playerToken });
      // FIX-18：原来是"click 后固定 sleep(1000)"，改成等到页面真的进入对局屏。
      // ⚠ FIX-17 实测发现（如实记录）：`enter()` 写进 ww_current 的局还在运行内存里，而
      // web/app.js:4176-4184 会**自动恢复**它 —— 所以这一步根本没有"要不要点继续"的选择：
      // 原来那句 `b.click('#btn-resume')` 点的是一个已经被隐藏的卡片（合成事件、0×0 也照样"点中"），
      // 紧接着的"已进入对局页"断言因此一直是空转的。真正的"点继续对局"现在由 P4-1 用
      // 真实鼠标 + 几何/命中断言覆盖（那里是服务端重启后的磁盘局，卡片真的可见、可点）。
      // 这里只保留本段真正要测的东西：推送降级状态条。
      await enterAndWaitGame(g2, 'P4-6：页面已进入对局屏（内存局由页面自动恢复）');
      check('已进入对局页（推送通道开启）', await b.eval(`document.querySelector('.screen:not(.hidden)')?.id`) === 'screen-game');
      // FIX-17：状态条要在**玩家真的看得见**的状态下量几何。身份翻牌浮层（#role-overlay）是开局必经的
      // 全屏层，它开着的时候状态条本来就被压在下面（第一次跑就是这样红的：hit=#role-overlay）。
      // 先按真实鼠标"我记住了，开始游戏"把它收掉 —— 收掉浮层本身也是一次真实可点击的证据。
      const ovBefore = await b.eval(`(() => { const o = document.getElementById('role-overlay'); return { shown: !!o && !o.classList.contains('hidden') }; })()`);
      let flipClick = '未开（无需收起）';
      if (ovBefore.shown) {
        flipClick = await b.realClick('#btn-flip-done');
        await waitExpr('P4-6：身份翻牌浮层已收起（此后状态条才真的可见）',
          `document.getElementById('role-overlay')?.classList.contains('hidden') === true`, { timeout: 6000 });
      }
      check('FIX-17 状态条前置：身份翻牌浮层已收起（状态条此刻真的没有被全屏层压住）',
        await b.eval(`document.getElementById('role-overlay')?.classList.contains('hidden') === true`),
        `浮层初始=${JSON.stringify(ovBefore)} realClick=${flipClick}`);
      // FIX-17：状态条（P4-6 的主角）也要量几何 + 遮挡（它在事件流里，先滚进视口再量）
      const barSet = await b.eval(`(() => {
        if (typeof setStreamStatus !== 'function') return { unavailable: true, count: -1, text: 'setStreamStatus 不可见（可能被 IIFE 包住）' };
        setStreamStatus('推送通道中断，正在改用轮询…');
        setStreamStatus('推送连接无响应，正在重连…');
        const els = [...document.querySelectorAll('#stream-status')];
        return { unavailable: false, count: els.length, text: els.map((e) => e.textContent).join(' | ') };
      })()`);
      const barProbe = barSet.unavailable ? { found: false } : await b.probe('#stream-status', { scroll: true });
      checkGeometry('FIX-17 状态条：可见、非零尺寸、滚进视口后中心点命中它自己（未被遮挡）', barProbe, { minW: 80, minH: 14 });
      const barAfterRemove = await b.eval(`(() => { setStreamStatus(null); return document.getElementById('stream-status') ? 1 : 0; })()`);
      const bannerState = { count: barSet.count, text: barSet.text, after: barAfterRemove };
      check('连续两次降级只保留一条状态条（单例）', bannerState.count === 1, `count=${bannerState.count}`);
      check('状态条文案可读（含"推送"）', /推送/.test(bannerState.text), bannerState.text.slice(0, 60));
      check('状态条可被移除（恢复后不留残影）', bannerState.after === 0, `after=${bannerState.after}`);

      // (A) P3-c 空刀拦截：人类是狼时，不选目标点"投刀"必须被拒（真实鼠标点击）
      log('\n=== P4-3 空刀拦截（真实点击）===');
      let g3 = null;
      for (let seed = 1; seed <= 12 && !g3; seed++) {
        const cand = await mkGame('adv12', 12, seed);
        // 角色是**开局时**才分配的：start 之前读 role 永远是空（我第一版就踩了这个坑）
        await api('POST', `/api/games/${cand.gameId}/start`, { token: cand.playerToken });
        // FIX-18：原来是固定 sleep(400)，改成等**服务端**把身份分配下去（可判定条件就在下面读的 view 里）
        await waitFor(async () => {
          const v0 = (await api('GET', `/api/games/${cand.gameId}/view?token=${cand.godToken}&after=0`)).body || {};
          const mine0 = ((v0.players) || []).find((x) => x.isHuman);
          return { ok: !!(mine0 && mine0.role), role: mine0 ? mine0.role : null };
        }, { label: 'P4-3 前置：人类身份已分配', timeout: 6000, interval: 150 });
        const v = await api('GET', `/api/games/${cand.gameId}/view?token=${cand.godToken}&after=0`);
        const mine = ((v.body && v.body.players) || []).find((x) => x.isHuman);
        if (mine && mine.role === 'wolf') g3 = { ...cand, seed };
        else await api('POST', `/api/games/${cand.gameId}/terminate`, { token: cand.godToken });
      }
      if (!g3) {
        check('找到"人类是狼"的种子用于空刀测试', false, '12 个种子内没找到');
      } else {
        await enterAndWaitGame(g3, 'P4-3：页面已进入对局屏（内存局由页面自动恢复）');
        let pending = null;
        for (let i = 0; i < 40; i++) { // 用 API 推着我的白天动作，直到夜里轮到我投刀
          const v = (await api('GET', `/api/games/${g3.gameId}/view?token=${g3.playerToken}&after=0`)).body || {};
          if (v.finished) break;
          pending = v.pending;
          if (pending && pending.task === 'wolf_kill') break;
          // FIX-18（保留的固定 sleep，见报告）：这里等的是**服务端流程自己推进**（AI 发言/结算节奏），
          // 不是页面状态；循环每轮都会重新读 view 并据此决定下一步，sleep 只是给服务端留节奏，
          // 没有任何"页面可判定条件"可等（等 server 就等于等这个循环本身）。
          if (!pending || !pending.task) { await sleep(900); continue; }
          const alive = (pending.candidates || []).slice();
          let payload = {};
          if (['speech', 'lastwords', 'pk_speech', 'wolf_chat', 'wolf_say'].includes(pending.task)) payload = { text: '过' };
          else if (pending.task === 'sheriff_run') payload = { run: false };
          else if (pending.task === 'explode_check') payload = { explode: false };
          else if (alive.length) payload = { target: alive[0] };
          await api('POST', `/api/games/${g3.gameId}/action`, { token: g3.playerToken, payload });
          // FIX-18（保留的固定 sleep，见报告）：同上 —— 提交后等服务端把这一步的 AI 反应推完，
          // 可判定状态在下一轮读 view 时判断（`pending.task === 'wolf_kill'`）。
          await sleep(700);
        }
        const domTask = await b.eval(`document.getElementById('action-controls')?.dataset.task || ''`);
        // 注意：app.js 会把候选座位一并写进 dataset（形如 wolf_kill[2,3,5,...]），所以用前缀判断
        check('夜里的投刀面板已渲染', !!(pending && pending.task === 'wolf_kill' && domTask.startsWith('wolf_kill')), `pending=${pending && pending.task} dom=${domTask}`);
        // 夜晚播报节奏：服务端把整夜步骤**一次性**发来（播报与行动解耦），客户端必须逐条播。
        // 旧版直接渲染 → 并发后几条同时冒出来（用户反馈的"播报变奇怪"）。此刻整夜播报还在播
        // （每步 1.1s），所以 playing/queue 必然为真；若哪天又变成"一次全出"，这里会红。
        const ni = await b.eval(`window.__nightInfo ? window.__nightInfo() : null`);
        check('夜晚播报：正在逐条播放（不是一次全出）', !!ni && (ni.playing || ni.queue > 0), JSON.stringify(ni));
        if (pending && pending.task === 'wolf_kill' && domTask.startsWith('wolf_kill')) {
          // 通用定位提交按钮：面板里的非选座按钮、文案含"投/确认/提交/确定"、且未禁用。
          // （第一版我按文案"投刀"硬找，狼队投票面板的按钮其实叫别的名字 → 找不到 → 静默没点。）
          const picked = await b.eval(`(() => {
            const all = [...document.querySelectorAll('#action-controls button')];
            const labels = all.map((x) => x.textContent.trim()).join('|');
            const cands = all.filter((x) => !x.classList.contains('chip') && !x.disabled);
            const submit = cands.find((x) => /投|确认|确定|提交/.test(x.textContent)) || cands[cands.length - 1];
            if (submit) submit.id = 'tmp-submit';
            return { labels, used: submit ? submit.textContent.trim() : '(无可用按钮)' };
          })()`);
          // 这个面板会随推送刷新重绘（重绘会换掉按钮节点、并重置提示），所以：
          // 在同一次 eval 里"点按钮 + 立刻读提示"，消除重绘窗口。用合成 click 是权衡后的选择 ——
          // 真实鼠标在这里会因节点被换掉而打空（实测 3 次都点不到），而它走的是**同一个 click 处理器**。
          //
          // ---- FIX-16：这一段**不再删除**异常记录 ----
          // 旧写法是 `b.exceptions.splice(beforeExc)`：把本段新增的未捕获异常从数组里裁掉，
          // 好让全局"全程无未捕获 JS 异常"保持绿。代价是这一段里**任何其它**未捕获异常
          // 也被一并抹掉 ⇒ 检查在整段内失明（计划书 §11.3 明令禁止"页面异常不得从数组中删除以制造无异常"）。
          // 现在改成"登记 + 精确断言"：数组只读；条数与形态分别钉死。
          //   判据原文：空刀段新增的页面未捕获异常必须**恰好 0 条**（登记值见文件上方的 F5_EXPECT）；
          //             若历史缺陷复发（pickedTarget 的 throw 逃逸成未捕获拒绝），必须**恰好 1 条**
          //             且消息来自空刀守卫本身（/请先点一个座位|刀口/，web/app.js:3435-3438）；
          //             多一条、少一条、消息不对 —— 一律算预期外，本段与全局断言同时变红。
          const beforeExc = b.exceptions.length; // 只做只读快照，本段**不做任何删除**
          await b.eval(`window.__f5 = []; window.addEventListener('unhandledrejection', function (e) {
            window.__f5.push(String((e.reason && e.reason.message) || e.reason || 'unknown'));
            e.preventDefault();
          });`);
          // 关键前提：面板可能**预选**了目标（单候选时预选），那样"空刀点击"其实是一次正常提交 →
          // 上一轮就是在这里得出过错误结论，所以先把预选目标读出来留证。
          // ⚠ 但这里**不再人为把 actionState.target 改成 null**：真实页面里它的初值是 0，
          // "什么都没选"与"显式点空刀"本来就是同一个值 —— 那正是 FIX-15 的根因。旧写法把状态
          // 改成真实用户永远造不出的 null 再点，于是"提示有变化"这条结论是假的。
          // 现在按**真实状态**点击，断言必须证明"没选目标点投刀 → 得到可读提示、且没有提交"。
          const preTarget = await b.eval(`typeof actionState === 'undefined' ? 'unavailable' : actionState.target`);
          const votesBefore = await countKnifeEvents(g3.gameId, g3.godToken);
          const emptyClick = await b.eval(`(() => {
            const hint = document.getElementById('pending-hint');
            const before = hint.textContent;
            const btns = [...document.querySelectorAll('#action-controls button')].filter((x) => !x.disabled);
            const submit = btns[btns.length - 1]; // 空刀/投刀 排在最后
            const used = submit.textContent.trim();
            submit.click();
            return { before, after: hint.textContent, used };
          })()`);
          const stillPending = await b.eval(`document.getElementById('action-controls')?.dataset.task || ''`);
          const votesAfter = await countKnifeEvents(g3.gameId, g3.godToken);
          log(`  · 空刀点击：按钮="${picked.used}"（候选 ${picked.labels}）真实目标=${preTarget} 投刀事件 ${votesBefore}→${votesAfter} 提示变化=${emptyClick.before === emptyClick.after ? '无' : '有'}`);
          // 服务端证据：没有新增投刀事件 = 护栏真的挡住了空提交
          check('空刀点击没有产生新的投刀事件（护栏有效）', votesAfter === votesBefore, `事件数 ${votesBefore} → ${votesAfter}｜点击后面板=${stillPending}`);
          // FIX-15（原 F5 缺口）：被拒时**必须**有可读提示 —— 这里断言页面上的提示文本，
          // 而不是像以前那样只打印一行"已知缺口"。面板带「空刀」键时提示要点名它（礼貌地告诉玩家怎么放弃）。
          const noneChipShown = picked.labels.includes('空刀');
          check('空刀被拒时给出可读提示（不是静默无反应）',
            /请先点一个座位/.test(emptyClick.after) && /刀口/.test(emptyClick.after) && (!noneChipShown || /空刀/.test(emptyClick.after)),
            `提示="${emptyClick.after}"（面板${noneChipShown ? '有' : '无'}「空刀」键）`);
          // 空刀点击后先让页面里的异步后果落地。
          // FIX-18（**保留的固定 sleep，见报告**）：这一等本质上是"等一件**不该发生**的事发生"
          // （未捕获拒绝），天生没有可判定的成功条件 —— 它不是等页面到达某个状态，而是给
          // 已发生的异常一个上报窗口。真正有效的门禁在跑完后的全局断言：记录**只增不删**，
          // 晚到的条目照样算数（旧写法正是在这里 splice 掉，所以晚到/其它异常全被吞掉）。
          await sleep(900);
          // FIX-16：只读快照 + 精确断言（**不** splice / pop / 改 length）
          const segExc = b.exceptions.slice(beforeExc);
          const f5 = await b.eval(`window.__f5 || []`);
          const shapeHit = segExc.length > 0 && segExc.every((m) => F5_EXPECT.shape.test(m));
          check('FIX-16 F5 空刀段：未捕获异常条数与形态符合登记（登记 0 条；形态 /请先点一个座位|刀口/）',
            segExc.length === F5_EXPECT.max && (segExc.length === 0 || shapeHit),
            `实测 ${segExc.length} 条（登记上限 ${F5_EXPECT.max} 条）｜形态匹配=${segExc.length === 0 ? '不适用（0 条）' : shapeHit}｜明细=${JSON.stringify(segExc.slice(0, 2))}`);
          check('FIX-16 F5 空刀段：CDP 记录条数与页面 unhandledrejection 记录一致（证明没有删记录）',
            segExc.length === f5.length,
            `CDP=${segExc.length} 页面=${f5.length}｜页面明细=${JSON.stringify(f5.slice(0, 2))}`);
          await b.shot(path.join(SHOTS, '12-empty-knife-refused.png'));
          log(`  · F5 证据：空刀段未捕获异常 CDP=${segExc.length} 条 / 页面 unhandledrejection=${f5.length} 条 → ${segExc.slice(0, 2).join(' / ') || '（无：空刀已由可读提示接住，不再抛未捕获拒绝）'}`);
        }
        await api('POST', `/api/games/${g3.gameId}/terminate`, { token: g3.playerToken });
      }

      // (F) FIX-07：「清除标注」必须走真 DELETE。
      // 旧实现是 PUT 一份空标注：内容清空了，但座位键仍留在 doc.seats 里 —— 存储只增不减，
      // 导出计数（src/profiles/transfer.js:59 的 counts.notes）跟着虚高。
      // 判定用**服务端证据**（seats 里那个键在不在），因为界面列表按"有内容"过滤，改前改后都看不到行。
      log('\n=== FIX-07 清除标注走真 DELETE ===');
      {
        const g5 = await mkGame('quick10', 10, 777001);
        await api('POST', `/api/games/${g5.gameId}/start`, { token: g5.playerToken });
        // FIX-18：原来是固定 sleep(400)，改成等**服务端**确认开局（后面的 PUT 标注按局状态算 revision）
        await waitFor(async () => {
          const rows = (((await api('GET', '/api/games')).body || {}).rows) || [];
          const r = rows.find((x) => x.id === g5.gameId);
          return { ok: !!(r && r.started), row: r ? { started: r.started } : null };
        }, { label: 'FIX-07 前置：g5 在服务端已开局', timeout: 6000, interval: 150 });
        const put = await api('PUT', `/api/games/${g5.gameId}/annotations`, {
          token: g5.playerToken, expectedRevision: 0, seats: { 3: { leaning: 'lean_wolf', note: '清除前先记一笔' } },
        });
        check('FIX-07 前置：服务端已写入座位 3 的标注',
          put.code === 200 && !!(put.body && put.body.annotations.seats && put.body.annotations.seats['3']),
          `PUT ${put.code} seats=${JSON.stringify(put.body && put.body.annotations && put.body.annotations.seats)}`);
        await enterAndWaitGame(g5, 'FIX-07：页面已进入对局屏（内存局由页面自动恢复）');
        // 真路：笔记区（宽屏是常驻右栏，窄屏是抽屉）里那条的「编辑」→ 编辑器里的「清除此座位笔记」
        if (await b.eval(`document.getElementById('notes-drawer').classList.contains('hidden')`)) {
          await b.click('#btn-notes');
          // FIX-18：原来是固定 sleep(500)，改成等到笔记抽屉真的打开
          await waitExpr('FIX-07：笔记抽屉已打开', `!document.getElementById('notes-drawer').classList.contains('hidden')`, { timeout: 4000 });
        }
        await b.eval(`renderNotesList()`);
        // FIX-18：原来是固定 sleep(300)，改成等到笔记列表真的渲染出座位 3 那一行
        await waitExpr('FIX-07：笔记列表已渲染座位 3 的行',
          `[...document.querySelectorAll('#notes-list .pm-row')].some((r) => /3\\s*号/.test((r.querySelector('.pm-name') || {}).textContent || ''))`, { timeout: 5000 });
        const beforeUi = await b.eval(`(() => {
          const rows = [...document.querySelectorAll('#notes-list .pm-row')];
          return {
            drawerOpen: !document.getElementById('notes-drawer').classList.contains('hidden'),
            rows: rows.map((r) => (r.querySelector('.pm-name') || {}).textContent || ''),
            h: rows.length ? Math.round(rows[0].getBoundingClientRect().height) : -1,
            seat: Object.prototype.hasOwnProperty.call(state.anno.seats || {}, '3'),
          };
        })()`);
        check('FIX-07 前置：笔记列表里能看到座位 3（界面与服务端一致）',
          beforeUi.drawerOpen === true && beforeUi.seat === true && beforeUi.rows.some((t) => /3\s*号/.test(t)) && beforeUi.h > 0,
          JSON.stringify(beforeUi));
        await b.eval(`(() => { const row = [...document.querySelectorAll('#notes-list .pm-row')].find((r) => /3\\s*号/.test((r.querySelector('.pm-name') || {}).textContent || '')); row?.querySelector('.pm-ops .btn')?.click(); })()`);
        // FIX-18：原来是固定 sleep(600)，改成等到标注编辑器真的打开（含「清除此座位笔记」按钮）
        await waitExpr('FIX-07：座位 3 的标注编辑器已打开',
          `!!document.querySelector('#modal-root .modal') && [...document.querySelectorAll('#modal-root .modal button')].some((x) => /清除此座位笔记/.test(x.textContent))`, { timeout: 5000 });
        check('FIX-07 前置：打开了座位 3 的标注编辑器',
          await b.eval(`!!document.querySelector('#modal-root .modal') && [...document.querySelectorAll('#modal-root .modal button')].some((x) => /清除此座位笔记/.test(x.textContent))`));
        await b.eval(`[...document.querySelectorAll('#modal-root .modal button')].find((x) => /清除此座位笔记/.test(x.textContent))?.click()`);
        // FIX-18：原来是固定 sleep(1200)，改成等到清除真的落地（内存里座位键没了 + 编辑器关闭）
        await waitExpr('FIX-07：清除标注已落地（内存座位键消失且编辑器关闭）',
          `(() => { return !Object.prototype.hasOwnProperty.call(state.anno.seats || {}, '3') && !document.querySelector('#modal-root .modal'); })()`, { timeout: 6000 });
        const afterUi = await b.eval(`(() => {
          const rows = [...document.querySelectorAll('#notes-list .pm-row')];
          return {
            seat: Object.prototype.hasOwnProperty.call(state.anno.seats || {}, '3'),
            rev: state.anno.rev,
            modalOpen: !!document.querySelector('#modal-root .modal'),
            // 「撤销」行（.current）会留一条：清除后仍可撤销，这是有意的；标注行必须消失
            annoRows: rows.filter((r) => !r.classList.contains('current')).length,
            undoRows: rows.filter((r) => r.classList.contains('current')).length,
          };
        })()`);
        const srv2 = await api('GET', `/api/games/${g5.gameId}/annotations?token=${g5.playerToken}`);
        const seats2 = ((srv2.body || {}).annotations || {}).seats || {};
        check('FIX-07 清除后服务端的座位键真的没了（DELETE 语义，不是 PUT 空标注）',
          !Object.prototype.hasOwnProperty.call(seats2, '3'), `seats=${JSON.stringify(seats2)}`);
        check('FIX-07 清除后前端内存与服务端一致（标注行消失、计数不虚高、编辑器关闭、留下撤销）',
          afterUi.seat === false && afterUi.annoRows === 0 && afterUi.undoRows === 1 && !afterUi.modalOpen
          && afterUi.rev === (srv2.body || {}).revision,
          `内存 seat=${afterUi.seat} 标注行=${afterUi.annoRows} 撤销行=${afterUi.undoRows} 编辑器已关=${!afterUi.modalOpen} revision=${afterUi.rev}/${(srv2.body || {}).revision}`);
        await b.shot(path.join(SHOTS, '12b-annotation-deleted.png'));
        await api('POST', `/api/games/${g5.gameId}/terminate`, { token: g5.playerToken });
      }

      // (E) P5 移动端：手机版必须能进对局并把座位/流程/待办渲染出来（mock 局，零成本）
      log('\n=== P5 手机端进入对局 ===');
      const g4 = await mkGame('quick10', 10, 20260917);
      await api('POST', `/api/games/${g4.gameId}/start`, { token: g4.playerToken });
      // FIX-07（手机端）：手机端的「清除标注」是独立实现（不是共用模块），所以两端各自端到端验一次。
      // 这里在**进局之前**写好一条座位 3 的标注，让手机页面启动时自然拉到它。
      const mput = await api('PUT', `/api/games/${g4.gameId}/annotations`, {
        token: g4.playerToken, expectedRevision: 0, seats: { 3: { leaning: 'lean_wolf', note: '手机端清除前记一笔' } },
      });
      check('FIX-07 手机端前置：服务端已写入座位 3 的标注',
        mput.code === 200 && !!(mput.body && mput.body.annotations.seats && mput.body.annotations.seats['3']),
        `PUT ${mput.code} seats=${JSON.stringify(mput.body && mput.body.annotations && mput.body.annotations.seats)}`);
      await b.setViewport(390, 844, true);
      // 手机端用自己的键 `mww_current`（桌面版是 `ww_current`，两者不共用）——
      // 只写 `ww_current` 手机会一直停在板子页（实测）。这里两个都写，模拟"手机上开的局"。
      await b.eval(`localStorage.setItem('mww_current', ${JSON.stringify(JSON.stringify(g4))}); localStorage.setItem('ww_current', ${JSON.stringify(JSON.stringify(g4))});`);
      await b.goto(base + '/m/', 2500);
      // 手机版可能直接进局，也可能先给一张"继续上局"的入口 —— 两种都兼容
      const resumed = await b.eval(`(() => {
        const btn = [...document.querySelectorAll('#m-app button')].find((x) => /继续|恢复|进入/.test(x.textContent) && x.offsetParent !== null);
        if (btn) { btn.click(); return btn.textContent.trim(); }
        return '';
      })()`);
      // FIX-18：原来是固定 sleep(2500)，改成等到手机端对局屏真的渲染出座位与流程
      await waitExpr('P5 手机端：对局屏已渲染（座位 + 流程）',
        `[...document.querySelectorAll('.m-screen:not(.hidden)')].some((s) => s.id === 'm-game') && document.querySelectorAll('#m-seats-l > *, #m-seats-r > *').length >= 8 && document.querySelectorAll('#m-flow > *').length >= 1`,
        { timeout: 10000 });
      const mobGame = await b.eval(`(() => {
        const shown = [...document.querySelectorAll('.m-screen:not(.hidden)')].map((s) => s.id);
        return {
          shown,
          day: ((document.getElementById('m-day') || {}).textContent || '').trim(),
          phase: ((document.getElementById('m-phase') || {}).textContent || '').trim(),
          seats: document.querySelectorAll('#m-seats-l > *, #m-seats-r > *').length,
          flow: document.querySelectorAll('#m-flow > *').length,
          hint: ((document.getElementById('m-pending-hint') || {}).textContent || '').trim(),
          dialogBtns: document.querySelectorAll('#m-dialog button').length,
        };
      })()`);
      check('手机端进入对局页', mobGame.shown.includes('m-game'), `入口=${resumed || '直接进局'} 可见=${mobGame.shown}`);
      check('手机端渲染座位与流程', mobGame.seats >= 8 && mobGame.flow >= 1, `座位=${mobGame.seats} 流程=${mobGame.flow} ${mobGame.day}/${mobGame.phase}`);
      check('手机端有待办面板或明确提示', mobGame.dialogBtns >= 1 || mobGame.hint.length > 0, `按钮=${mobGame.dialogBtns} 提示="${mobGame.hint.slice(0, 40)}"`);
      await b.shot(path.join(SHOTS, '13-mobile-game.png'));
      // 对局内设置：旧版点开只有一句"配置在首页改" + 两个按钮，用户反馈"设置失效、只有一条线"；
      // 而齿轮入口却写着「接口 / 模型 / 节奏」，名不副实。现在必须有本局信息 + 可用入口 + 真路。
      await b.click('#m-gear');
      // FIX-18：原来是固定 sleep(500)，改成等到齿轮弹层的条目渲染出来
      await waitExpr('P5 手机端：齿轮弹层条目已渲染', `document.querySelectorAll('#m-modal .gear-item').length > 0`, { timeout: 5000 });
      const gearItems = await b.eval(`[...document.querySelectorAll('#m-modal .gear-item')].map((x) => x.textContent.trim())`);
      check('手机端齿轮：设置入口不再谎报"可改接口/模型/节奏"', gearItems.includes('⚙ 设置'), JSON.stringify(gearItems));
      await b.eval(`(() => { const t = [...document.querySelectorAll('#m-modal .gear-item')].find((x) => x.textContent.trim() === '⚙ 设置'); if (t) t.click(); })()`);
      // FIX-18：原来是固定 sleep(500)，改成等到"本局信息"面板真的渲染出来
      await waitExpr('P5 手机端：对局内设置面板已渲染（含本局信息行）', `document.querySelectorAll('#m-modal .setinfo .set-row').length >= 3`, { timeout: 5000 });
      const setPanel = await b.eval(`(() => ({
        rows: [...document.querySelectorAll('#m-modal .setinfo .set-row')].map((r) => r.textContent.trim()),
        controls: document.querySelectorAll('#m-modal .gear-item, #m-modal .btn').length,
        hint: (document.querySelector('#m-modal .hint') || {}).textContent || '',
        home: !!([...document.querySelectorAll('#m-modal button')].find((x) => /去首页改/.test(x.textContent))),
      }))()`);
      check('手机端对局内设置：显示本局信息（对局/进度/存活/身份）', setPanel.rows.length >= 3 && /第 \d+ 天/.test(setPanel.rows.join(' ')), JSON.stringify(setPanel.rows));
      check('手机端对局内设置：入口可用（≥5 个控件）', setPanel.controls >= 5, `控件=${setPanel.controls}`);
      check('手机端对局内设置：说明为何局中改不了并给出回首页改的真路', /开局时/.test(setPanel.hint) && setPanel.home, `home=${setPanel.home} hint="${setPanel.hint.slice(0, 24)}"`);
      // 真机反馈"点开只有一条线"：弹层高度曾完全靠 flex 推导，父级 auto 高度时可能算成 0。
      // 这里量真实高度，塌了就红。
      const setH = await b.eval(`(() => { const m = document.querySelector('#m-modal .modal'); return m ? Math.round(m.getBoundingClientRect().height) : -1; })()`);
      // 这条断言就是靠上面那份诊断抓到的：弹层曾因为多套一层 .modal 而塌成 2px（"一条线"）。
      // 教训：只断言"文字在 DOM 里"不够 —— 文字在、盒子 2px 高，玩家什么都看不到。
      check('手机端对局内设置：弹层有实际高度（不是塌成一条线）', setH >= 200, `高度=${setH}px`);
      const setKids = await b.eval(`document.querySelectorAll('#m-modal .modal .modal').length`);
      check('手机端弹层：不得出现 .modal 套 .modal', setKids === 0, `嵌套层数=${setKids}`);
      await b.shot(path.join(SHOTS, '13b-mobile-gear-settings.png'));
      await b.eval(`document.getElementById('m-modal').innerHTML = ''`);

      // FIX-07（手机端续）：笔记页 → 点座位 3 → 底部弹层的「清除」→ 服务端座位键必须真的消失
      await b.click('#m-tabbtn-notes');
      // FIX-18：原来是固定 sleep(700)，改成等到笔记页真的列出座位 3（行有真实高度）
      await waitExpr('FIX-07 手机端：笔记页已列出座位 3 的行',
        `[...document.querySelectorAll('#m-notes-list > *')].some((r) => /3\\s*号/.test(r.textContent) && r.getBoundingClientRect().height > 20)`, { timeout: 6000 });
      const mNoteRow = await b.eval(`(() => {
        const row = [...document.querySelectorAll('#m-notes-list > *')].find((r) => /3\\s*号/.test(r.textContent));
        if (!row) return null;
        const r = row.getBoundingClientRect();
        return { text: row.textContent.replace(/\\s+/g, ' ').trim().slice(0, 24), h: Math.round(r.height) };
      })()`);
      check('FIX-07 手机端前置：笔记页列出座位 3（行有真实高度）',
        !!mNoteRow && mNoteRow.h > 20, JSON.stringify(mNoteRow));
      await b.eval(`(() => { const row = [...document.querySelectorAll('#m-notes-list > *')].find((r) => /3\\s*号/.test(r.textContent)); row?.click(); })()`);
      // FIX-18：原来是固定 sleep(800)，改成等到底部弹层的「清除」键真的出现在 DOM 里
      await waitExpr('FIX-07 手机端：座位 3 的标注弹层已打开（出现「清除」键）',
        `[...document.querySelectorAll('#m-sheet .btn')].some((x) => x.textContent.trim() === '清除')`, { timeout: 6000 });
      const mClearBtn = await b.eval(`(() => {
        const btn = [...document.querySelectorAll('#m-sheet .btn')].find((x) => x.textContent.trim() === '清除');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { h: Math.round(r.height), w: Math.round(r.width), zero: btn.disabled };
      })()`);
      check('FIX-07 手机端前置：座位 3 的标注弹层打开了「清除」键（可点、非 0 尺寸）',
        !!mClearBtn && mClearBtn.h > 20 && mClearBtn.w > 20 && mClearBtn.zero === false, JSON.stringify(mClearBtn));
      const mSeatBefore = await b.eval(`Object.prototype.hasOwnProperty.call(state.anno.seats || {}, '3')`);
      await b.eval(`[...document.querySelectorAll('#m-sheet .btn')].find((x) => x.textContent.trim() === '清除')?.click()`);
      // FIX-18：原来是固定 sleep(1400)，改成等到清除真的落地（内存里座位键消失，且不出现错误行）
      await waitExpr('FIX-07 手机端：清除标注已落地（内存座位键消失）',
        `!Object.prototype.hasOwnProperty.call(state.anno.seats || {}, '3')`, { timeout: 8000 });
      const mSeatAfter = await b.eval(`(() => ({ seat: Object.prototype.hasOwnProperty.call(state.anno.seats || {}, '3'),
        err: (document.getElementById('m-anno-err') || {}).textContent || '' }))()`);
      const msrv = await api('GET', `/api/games/${g4.gameId}/annotations?token=${g4.playerToken}`);
      const mseats = ((msrv.body || {}).annotations || {}).seats || {};
      check('FIX-07 手机端清除后服务端的座位键真的没了（DELETE 语义）',
        mSeatBefore === true && !Object.prototype.hasOwnProperty.call(mseats, '3') && mSeatAfter.seat === false && mSeatAfter.err === '',
        `清除前 seat=${mSeatBefore} 清除后 内存=${mSeatAfter.seat} 服务端=${JSON.stringify(mseats)} 错误行="${mSeatAfter.err}"`);
      await b.shot(path.join(SHOTS, '13e-mobile-annotation-cleared.png'));
      await b.eval(`document.getElementById('m-sheet').innerHTML = ''`);
      // 结算后总结（用户反馈"手机端结束后什么都没有"）：终止本局 → 自动弹总结 → 逐项核对。
      await api('POST', `/api/games/${g4.gameId}/terminate`, { token: g4.playerToken });
      // FIX-18：原来是固定 sleep(2200)（自动弹出有 600ms 延迟 + 拉一次 /api/stats），
      // 改成等到总结弹层真的渲染出来（条件就是紧接着断言读的东西）
      await waitExpr('P5 手机端：结算总结弹层已自动弹出',
        `(() => { const m = document.getElementById('m-modal'); return !!m && /本局总结/.test(m.textContent || '') && m.querySelectorAll('.set-row').length >= 4; })()`,
        { timeout: 10000, interval: 200 });
      const sum = await b.eval(`(() => {
        const m = document.getElementById('m-modal');
        const txt = (m && m.textContent) || '';
        return {
          title: ((m || {}).querySelector ? (m.querySelector('.mtitle') || {}).textContent : '') || '',
          rows: [...((m || {}).querySelectorAll ? m.querySelectorAll('.set-row') : [])].map((r) => r.textContent.trim()),
          truth: /终局真相/.test(txt),
          exp: /跨局经验池/.test(txt),
          review: !!document.querySelector('#m-review-box'),
          text: txt.slice(0, 160),
        };
      })()`);
      check('手机端结算后自动弹出本局总结', /本局总结/.test(sum.title), `标题="${sum.title}"`);
      check('手机端总结：给出结果/天数/身份/评分等本局信息', sum.rows.length >= 4, JSON.stringify(sum.rows.slice(0, 6)));
      check('手机端总结：含终局真相与 AI 复盘入口', sum.truth && sum.review, `真相=${sum.truth} 复盘框=${sum.review}`);
      check('手机端总结：呈现"AI 越玩越强"（跨局经验池）', sum.exp, sum.text.slice(0, 90));
      const sumH = await b.eval(`(() => { const m = document.querySelector('#m-modal .modal'); return m ? Math.round(m.getBoundingClientRect().height) : -1; })()`);
      check('手机端总结：弹层有实际高度（不是塌成一条线）', sumH >= 200, `高度=${sumH}px`);
      // 验收发现的缺陷回归：score.details 是字符串数组（src/engine/score.js:26），
      // 曾按对象取 d.points/d.label → 每行渲染成空字符串，真机截图里"我的得分构成"下面是空白。
      const sumDet = await b.eval(`(() => {
        const h = [...document.querySelectorAll('#m-modal .modal h4')].find((n) => n.textContent.includes('我的得分构成'));
        if (!h) return { header: false };
        const list = h.nextElementSibling;
        const rows = list ? [...list.querySelectorAll('.set-row')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim()) : [];
        return { header: true, rows, blank: rows.filter((t) => !t).length };
      })()`);
      check('手机端总结：得分构成每行都有内容（不许渲染成空行）', sumDet.header && sumDet.rows.length > 0 && sumDet.blank === 0, JSON.stringify(sumDet).slice(0, 120));
      await b.shot(path.join(SHOTS, '13c-mobile-summary.png'));
      await b.eval(`document.getElementById('m-modal').innerHTML = ''`);

      // ---- 计划书第 83 行：320×568 小屏的"局中"检查 ----
      // 此刻手机端正停在对局屏，做这一档不需要额外开一局（这也是把它放在这里的原因）。
      // 判据沿用 FIX-17 那四条（宽高 > 0 / 中心点在视口内 / elementFromPoint 命中自己或子孙）；
      // 时序一律条件等待，不用固定 sleep。
      await b.setViewport(320, 568, true);
      await waitCheck('第 83 行 320×568：手机端局中已按新视口重排（截图前置条件）', async () => await b.eval(
        `(() => { const g = document.getElementById('m-game'); const r = (g && !g.classList.contains('hidden')) ? g.getBoundingClientRect() : null; return { ok: !!r && r.width >= 300 && r.height >= 480, hidden: g ? g.classList.contains('hidden') : null, w: r ? Math.round(r.width) : -1, h: r ? Math.round(r.height) : -1 }; })()`), { timeout: 5000, interval: 100 });
      const game320 = await b.probe('#m-game');
      checkGeometry('第 83 行 320×568：手机端局中本体可见、非零尺寸、与视口相交', game320, { minW: 300, minH: 480, requireCenter: false, requireHitSelf: false });
      const sw320 = await b.eval('document.documentElement.scrollWidth');
      check('第 83 行 320×568：局中在 320 宽下没有横向溢出', sw320 <= 321, `scrollWidth=${sw320}`);
      // §3 触点门禁（局中部分）：趁手机端还停在局中屏量真实渲染高度 —— 比另开一局便宜得多。
      // 注意这里量到的是**更窄的 320 视口**，触点高度不应因此变小（§3 第 76 行：为紧凑缩字号时不得缩触点）。
      // 只判高度：局中屏是可滚动的，按钮常在首屏之外，用 checkGeometry 默认参数会产生假红。
      const hOf = (pr) => (pr && pr.found && typeof pr.h === 'number' ? Math.round(pr.h) : -1);
      const tabBtn = await b.probe('#m-game .m-tabs .m-tab-btn');
      check('§3 触点门禁：局中页签按钮实测高度 ≥48（320 窄屏下同样不得缩）', hOf(tabBtn) >= 48, `实测 h=${hOf(tabBtn)}（w=${tabBtn.w}）`);
      const keyBtn = await b.probe('#m-game .m-keys .key');
      if (keyBtn.found) {
        check('§3 触点门禁：局中技能键实测高度 ≥48', hOf(keyBtn) >= 48, `实测 h=${hOf(keyBtn)}（w=${keyBtn.w}）`);
        const confirmKey = await b.probe('#m-game .m-keys .key[data-confirm]');
        if (confirmKey.found) check('§3 触点门禁：局中主确认键实测高度 ≥52（§3 主操作档）', hOf(confirmKey) >= 52, `实测 h=${hOf(confirmKey)}（w=${confirmKey.w}）`);
      } else {
        // 恒真断言不写进断言集合（计划书第 52 行）：这一段跑在终局之后，动作键可能已经收走 ——
        // "量不到"是事实，用 log 记录，不用 check(…, true, …) 冒充一条通过。
        log('· §3 触点门禁：局中此刻已收走动作键（该阶段量测不适用，如实记录）');
      }
      await b.shot(path.join(SHOTS, '14-320x568-mobile-game.png'));

      await b.setViewport(1280, 900, false);
    }

    // ---- 计划书第 83 行：截图矩阵 —— 补 320×568 小屏与"玩家中心"两档代表截图 ----
    // 开工前核对过现状：1440×900 / 390×844 的首页与局中**已经**有截图，缺的是 320×568 全部与玩家中心两档。
    // 页面归属全部按真实 id（不猜，逐处都有出处）：
    //   手机首页 = #m-boards（web/m/index.html:50）、手机首页上的档案头像 = #m-profile-avatar（:61）、
    //   手机玩家中心 = #m-profile-chip（:60）点开的底部弹层 #m-sheet / .m-sheet-body（web/m/m.js:379 接线、
    //   :1084-1095 建层）、手机局中 = #m-game（:160，上面那段已覆盖 320×568）；
    //   桌面首页第一屏 = #screen-setup 的 #home-hero（web/index.html:107），
    //   桌面玩家中心 = 同一屏的 #home-profile / #home-avatar / #home-nick（:111/:112/:114）。
    log('\n=== 截图矩阵（320×568 小屏与玩家中心，计划书第 83 行）===');
    {
      await b.goto(base + '/m/', 0);
      await b.setViewport(320, 568, true);
      await waitExpr('截图矩阵：手机端首页已渲染（320×568）', `(() => { const s = document.getElementById('m-boards'); const a = document.getElementById('m-profile-avatar'); const rs = s ? s.getBoundingClientRect() : null; const ra = a ? a.getBoundingClientRect() : null; return { ok: !!s && !s.classList.contains('hidden') && !!rs && rs.width >= 300 && rs.height >= 300 && !!ra && ra.width > 0, hidden: s ? s.classList.contains('hidden') : null, w: rs ? Math.round(rs.width) : -1, h: rs ? Math.round(rs.height) : -1, avatarW: ra ? Math.round(ra.width) : -1 }; })()`, { timeout: 15000, interval: 150 });
      const mHome320 = await b.probe('#m-boards');
      checkGeometry('第 83 行 320×568：手机端首页可见、非零尺寸', mHome320, { minW: 300, minH: 300, requireCenter: false, requireHitSelf: false });
      const mAvatar320 = await b.probe('#m-profile-avatar');
      checkGeometry('第 83 行 320×568：首页上的当前档案头像可见、非零尺寸（M1 自定义头像的展示位）', mAvatar320, { minW: 16, minH: 16 });
      const mSw320 = await b.eval('document.documentElement.scrollWidth');
      check('第 83 行 320×568：首页在 320 宽下没有横向溢出', mSw320 <= 321, `scrollWidth=${mSw320}`);
      await b.shot(path.join(SHOTS, '15-320x568-mobile-home.png'));

      // 玩家中心（手机端 = 首页档案 chip 点开的底部弹层）：用**真实点击**进入，再做几何判定
      await b.realClick('#m-profile-chip');
      await waitExpr('截图矩阵：手机端玩家中心弹层已展开（320×568）', `(() => { const root = document.getElementById('m-sheet'); const panel = root ? root.querySelector('.m-sheet') : null; const r = panel ? panel.getBoundingClientRect() : null; return { ok: !!panel && r.width > 200 && r.height > 100, panelW: r ? Math.round(r.width) : -1, panelH: r ? Math.round(r.height) : -1 }; })()`, { timeout: 8000, interval: 100 });
      const mSheet320 = await b.probe('#m-sheet .m-sheet');
      checkGeometry('第 83 行 320×568：手机端玩家中心弹层可见、非零尺寸、中心点未被遮挡（上面那次真实点击点的就是它的入口 chip）', mSheet320, { minW: 200, minH: 100 });
      const mSheetHead320 = await b.probe('#m-sheet .m-sheet-head');
      checkGeometry('第 83 行 320×568：玩家中心弹层标题栏非零尺寸（不是塌成一条线）', mSheetHead320, { minW: 80, minH: 16, requireHitSelf: false });
      await b.shot(path.join(SHOTS, '16-320x568-mobile-profile.png'));

      await b.setViewport(390, 844, true);
      await waitCheck('截图矩阵：切回 390×844 后玩家中心弹层仍是同一层（截图前置条件）', async () => await b.eval(
        `(() => { const panel = document.querySelector('#m-sheet .m-sheet'); const r = panel ? panel.getBoundingClientRect() : null; return { ok: !!r && r.width > 200 && r.height > 100, panelW: r ? Math.round(r.width) : -1 }; })()`), { timeout: 5000, interval: 100 });
      await b.shot(path.join(SHOTS, '17-390x844-mobile-profile.png'));

    }

    // ---- 计划书 §3 + §11.3：触点几何门禁（只认真实渲染高度，不看 CSS 数值）----
    // 为什么必须实测：静态读 m.css 的 min-height 会得出错误结论 —— `#m-app .btn`（:26，特异性 (1,1,0)）
    // 是全局兜底，盖住了一批 .m-* 的收小声明（`.m-keys .btn` 38、`.key` 38、`.key.seat` 36、
    // `.m-profile-row .btn` 40 都是**死规则**）；而 `#m-modal` / `#m-sheet` 在 `#m-app` **之外**
    // （见 m.css:618-620 自己的注释），不受兜底约束，那里的 44/42px 是**真生效**的。
    // 所以本段一律用 probe() 的实测值判定，阈值取 §3：手机触点 ≥48。
    // 注：局中屏的 `.m-keys .key` / `.m-keys .key[data-confirm]` / `.m-tabs .m-tab-btn`
    // 在上面的截图矩阵段落里（手机端仍在局中那一刻）另行断言，避免这里为了量它们再开一局。
    log('\n=== 触点几何门禁（真实渲染高度，计划书 §3）===');
    {
      await b.goto(base + '/m/', 0);
      await b.setViewport(390, 844, true);
      await waitExpr('触点门禁：手机端首页已渲染（量测前置条件）', `(() => { const s = document.getElementById('m-boards'); const c = document.getElementById('m-profile-chip'); const rc = c ? c.getBoundingClientRect() : null; return { ok: !!s && !s.classList.contains('hidden') && !!rc && rc.height > 0, chipH: rc ? Math.round(rc.height) : -1 }; })()`, { timeout: 15000, interval: 150 });

      // 首页的次级入口（.btn.small ⇒ 走 #m-app .btn.small 的兜底）
      // 判据只认**高度**：这里量的是"触点够不够大"，不是"此刻在不在视口里"——首屏之下的按钮
      // 用 checkGeometry 的默认参数会被判成"中心点不在视口"，那是**假红**（我踩过一次）。
      const hOnly = (pr) => (pr && pr.found && typeof pr.h === 'number' ? Math.round(pr.h) : -1);
      const chip = await b.probe('#m-profile-chip');
      check('§3 触点门禁：首页「当前档案」chip 实测高度 ≥48', hOnly(chip) >= 48, `实测 h=${hOnly(chip)}（w=${chip.w}）`);
      const setBtn = await b.probe('#m-settings-btn');
      check('§3 触点门禁：首页「设置」入口实测高度 ≥48', hOnly(setBtn) >= 48, `实测 h=${hOnly(setBtn)}（w=${setBtn.w}）`);
      const cdxBtn = await b.probe('#m-codex-btn');
      check('§3 触点门禁：首页「角色图鉴」入口实测高度 ≥48', hOnly(cdxBtn) >= 48, `实测 h=${hOnly(cdxBtn)}（w=${cdxBtn.w}）`);

      // 底部弹层（#m-sheet 在 #m-app **之外**，不受全局兜底！这正是 44px 真生效的地方）
      await b.realClick('#m-profile-chip');
      await waitExpr('触点门禁：档案弹层已展开（量测前置条件）', `(() => { const root = document.getElementById('m-sheet'); const panel = root ? root.querySelector('.m-sheet') : null; const r = panel ? panel.getBoundingClientRect() : null; return { ok: !!panel && r.width > 200 && r.height > 100, panelH: r ? Math.round(r.height) : -1 }; })()`, { timeout: 8000, interval: 100 });
      const sheetFoot = await b.probe('#m-sheet .m-sheet-foot .btn');
      check('§3 触点门禁：档案弹层底部按钮实测高度 ≥48（#m-sheet 在 #m-app 之外，不受兜底）', hOnly(sheetFoot) >= 48, `实测 h=${hOnly(sheetFoot)}（w=${sheetFoot.w}）`);
      const sheetOps = await b.probe('#m-sheet .pm-ops .btn');
      check('§3 触点门禁：档案弹层档案操作按钮实测高度 ≥48', hOnly(sheetOps) >= 48, `实测 h=${hOnly(sheetOps)}（w=${sheetOps.w}）`);
      // 弹层内的删除类入口（危险操作，必须可点且够大）
      const sheetTrash = await b.probe('#m-sheet .pm-trash-entry');
      check('§3 触点门禁：档案弹层回收区入口实测高度 ≥48', hOnly(sheetTrash) >= 48, `实测 h=${hOnly(sheetTrash)}（w=${sheetTrash.w}）`);

      // 资料页翻页键（`.cdx-pager button`，m.css:517 是**元素**选择器 (0,1,1)：若按钮不带 .btn 就不吃兜底，
      // 44px 会真生效）。进入方式与真实用户一致：先把入口滚进视口，再真实点击（#m-codex-btn → openCodex）。
      await b.eval(`(() => { const el = document.getElementById('m-codex-btn'); if (el) el.scrollIntoView({ block: 'center' }); return true; })()`);
      await new Promise((r) => setTimeout(r, 250));
      await b.realClick('#m-codex-btn');
      await waitExpr('触点门禁：手机端资料页已打开（量测前置条件）', `(() => { const s = document.getElementById('m-codex'); const p = document.querySelector('#m-codex .cdx-pager button'); const r = p ? p.getBoundingClientRect() : null; return { ok: !!s && !s.classList.contains('hidden') && !!r && r.height > 0, pagerH: r ? Math.round(r.height) : -1 }; })()`, { timeout: 8000, interval: 100 });
      const pagerBtn = await b.probe('#m-codex .cdx-pager button');
      if (pagerBtn.found) {
        check('§3 触点门禁：资料页翻页按钮实测高度 ≥48', hOnly(pagerBtn) >= 48, `实测 h=${hOnly(pagerBtn)}（w=${pagerBtn.w}）`);
      } else {
        // 实测事实：资料页**首层**不渲染翻页条（.cdx-pager 只在多页条目里出现）⇒ 这里量不到。
        // 用 log 如实记录覆盖缺口，**不写成 check(…, true, …)** —— 参照计划书第 52 行
        // 「恒真和宽容断言清理后只能收缩基线」：恒真断言会污染断言集合，等于假覆盖。
        log('· §3 触点门禁：资料页首层无翻页键（该状态量测不适用）—— 属已知覆盖缺口');
      }
      // 中部弹窗（#m-modal 同样在 #m-app **之外**，index.html:211）—— 经由首页设置入口 openModal 打开。
      // 这是 ② 报告的 §6.2 发现处：这里的 .btnrow .btn 实测 40、.btn.primary 实测 44，都低于 §3。
      await b.eval(`(() => { const el = document.getElementById('m-codex-back'); if (el) el.scrollIntoView({ block: 'center' }); return true; })()`);
      await new Promise((r) => setTimeout(r, 200));
      const backBtn = await b.probe('#m-codex-back');
      if (backBtn.found) { await b.realClick('#m-codex-back'); await new Promise((r) => setTimeout(r, 300)); }
      await b.eval(`(() => { const el = document.getElementById('m-settings-btn'); if (el) el.scrollIntoView({ block: 'center' }); return true; })()`);
      await new Promise((r) => setTimeout(r, 250));
      await b.realClick('#m-settings-btn');
      await waitExpr('触点门禁：手机端设置弹窗已打开（量测前置条件）', `(() => { const m = document.querySelector('#m-modal .modal-mask'); const b2 = document.querySelector('#m-modal .modal .btnrow .btn'); const r = b2 ? b2.getBoundingClientRect() : null; return { ok: !!m && !!r && r.height > 0, btnH: r ? Math.round(r.height) : -1 }; })()`, { timeout: 8000, interval: 100 });
      const modalBtn = await b.probe('#m-modal .modal .btnrow .btn');
      if (modalBtn.found) {
        check('§3 触点门禁：中部弹窗按钮实测高度 ≥48（#m-modal 在 #m-app 之外）', hOnly(modalBtn) >= 48, `实测 h=${hOnly(modalBtn)}（w=${modalBtn.w}）`);
        const modalPrimary = await b.probe('#m-modal .modal .btnrow .btn.primary');
        if (modalPrimary.found) check('§3 触点门禁：中部弹窗主确认键实测高度 ≥52（§3 主操作档）', hOnly(modalPrimary) >= 52, `实测 h=${hOnly(modalPrimary)}（w=${modalPrimary.w}）`);
      } else {
        // 恒真断言不写进断言集合（计划书第 52 行）：此处只记录"这一状态量不到"，用 log。
        log('· §3 触点门禁：中部弹窗此刻无 .btnrow 按钮（该状态量测不适用）—— 属已知覆盖缺口；'
          + '该族按钮由 ② 的探针与 test/css.test.js 守卫表负责');
      }
      // 覆盖缺口（如实记录，不假装覆盖）：`#m-flip-done`（翻牌页主确认，44）只在牌面揭示那一刻出现，
      // 时序不可控，本段不冒充已覆盖；由 ② 的探针与 test/css.test.js 的守卫表负责。
      // 未在此量测的两处（如实记录，不假装覆盖）：`.m-dialog .btnrow .btn`（在 #m-modal 内，需要真实触发一次
      // 确认弹窗才能量）与 `.m-to-bottom`（需先把局中信息流滚到底部才可见）。它们由 ② 的交付报告与台账负责，
      // 不在这里用"存在性检查"冒充 —— §11.3 明确禁止只有"存在 + 文字"型的弱检查。
    }

    // ---- 8. 控制台必须干净 ----
    log('\n=== 浏览器控制台 ===');
    const p = { exceptions: b.exceptions, consoleErrors: b.consoleErrors };
    // FIX-16：全局断言重新变得**有效**。
    // 旧写法的前提是"某一段会把自己的异常条目从数组里删掉"，于是那一段里的**任何**未捕获异常
    // 都被一并抹掉（检查在整段内失明）。现在记录只增不删，判据换成：
    //   ① 每一条未捕获异常都必须命中 EXPECTED_UNCAUGHT 登记表（当前登记 0 条 ⇒ 任何一条都算预期外）；
    //   ② 命中登记表的条数不得超过登记配额（max）；
    //   ③ 逐条打印实测内容，超限也说清是哪一条。
    const expectedHit = (m) => EXPECTED_UNCAUGHT.some((e) => e.shape.test(m));
    const unexpectedExc = p.exceptions.filter((m) => !expectedHit(m));
    const overQuota = EXPECTED_UNCAUGHT.filter((e) => p.exceptions.filter((m) => e.shape.test(m)).length > e.max);
    check('全程无未捕获 JS 异常', unexpectedExc.length === 0 && overQuota.length === 0,
      `共 ${p.exceptions.length} 条｜预期外 ${unexpectedExc.length} 条 ${JSON.stringify(unexpectedExc.slice(0, 3))}`
      + `｜超登记配额 ${JSON.stringify(overQuota.map((e) => e.label))}`
      + `｜登记表=[${EXPECTED_UNCAUGHT.map((e) => `${e.label}（形态 ${e.shape}）`).join('、') || '（空）'}]`);
    check('无 console.error/warning', p.consoleErrors.length === 0, p.consoleErrors.slice(0, 3).join(' | '));

    // FIX-16 反向验证的**常驻版**：证明上面那条全局断言不是空转。
    // 在一个独立 target 里注入一条预期外的未捕获异常，确认记录器抓得到它、且它**不**命中登记表
    // （= 同样的判据会把它判红），同时不污染主会话的异常证据（按 sessionId 分桶）。
    let det = { caught: -1, matchedExpected: true, isolated: false, mainCount: -1, detail: ['检测器自证未执行'] };
    try { det = await b.assertUncaughtDetector(); } catch (e) { det.detail = ['检测器自证异常：' + e.message]; }
    check('FIX-16 检测器自证：注入的意外未捕获异常被抓到，且会被全局断言判红（主会话证据不被污染）',
      det.caught === 1 && det.matchedExpected === false && det.isolated === true,
      `辅助 target 抓到 ${det.caught} 条（命中登记表=${det.matchedExpected}）｜主会话异常仍为 ${det.mainCount} 条｜明细=${JSON.stringify(det.detail)}`);

    log(`\n截图：${path.relative(ROOT, SHOTS)}`);
    log(fails === 0 ? '✓ 界面验收全部通过' : `✗ ${fails} 项未通过`);
  } catch (e) {
    fails++;
    log('界面验收异常: ' + e.message);
    if (serverErr) log('服务端输出: ' + serverErr.slice(-400));
  } finally {
    if (b) await b.close();
    server.kill();
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    // 退出码语义（见文件头）：
    //   0 = 全部通过；1 = 实际执行的检查有失败（浏览器已启动成功才算"实际执行"）；
    //   2 = 严格模式下存在未执行项（浏览器缺失/启动失败/中途异常打断），即使没有检查失败。
    let exitCode = fails ? 1 : 0;
    if (STRICT) {
      if (fails) {
        // 失败退出也要如实列出被打断后没有执行的段落（启动失败时几乎所有段落都没跑）
        reportUnexecuted('严格模式附加：');
      } else {
        const missing = reportUnexecuted('✗ 严格模式：');
        if (missing.length) exitCode = 2;
      }
    }
    setTimeout(() => process.exit(exitCode), 60);
  }
})();
