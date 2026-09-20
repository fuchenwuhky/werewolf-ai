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

/**
 * 规划段落清单（严格模式的"未执行"判定依据）。
 * 维护约定：在本脚本里新增/改名 `=== 段落 ===` 标题时必须同步这里——
 * 清单里的段落没有对应标题会导致严格模式永远报"未执行"（fail-closed，需有意识地更新）。
 */
const PLANNED_SECTIONS = [
  '慢启动守卫（接口人为延迟 1.5s）',
  '设置页',
  '角色图鉴',
  '中英文切换',
  '离线',
  '离线能力',
  '手机版',
  ...(FULL ? ['观战 Mock 局跑到终局（--full）'] : []),
  'P4-1 恢复卡片详情',
  'P4-4 终止后刷新',
  'P4-6 推送降级状态条（单例）',
  'P4-3 空刀拦截（真实点击）',
  'P5 手机端进入对局',
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
class Browser {
  constructor() { this.id = 0; this.pending = new Map(); this.exceptions = []; this.consoleErrors = []; this.failedRequests = []; }

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
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails || {};
      this.exceptions.push(`${d.text || ''} ${(d.exception && d.exception.description) || ''}`.trim());
    } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(p.type)) {
      this.consoleErrors.push(`[${p.type}] ` + (p.args || []).map((a) => a.value || a.description || a.type).join(' '));
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

  async goto(url, settle = 1500) { await this.send('Page.navigate', { url }, this.sessionId); await sleep(settle); }

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, this.sessionId);
    if (r.exceptionDetails) throw new Error('页面 JS 抛错: ' + (r.exceptionDetails.text || ''));
    return r.result && r.result.value;
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

  /** 真实鼠标点击（CDP Input 事件）。 */
  async realClick(sel) {
    const box = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) return 'NOT_FOUND';
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent',
        { type, x: box.x, y: box.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 },
        this.sessionId);
    }
    return 'OK';
  }

  setViewport(width, height, mobile) { return this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }, this.sessionId); }
  setLatency(ms) { return this.send('Network.emulateNetworkConditions', { offline: false, latency: ms, downloadThroughput: -1, uploadThroughput: -1 }, this.sessionId); }
  setOffline(on) { return this.send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, this.sessionId); }

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
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), WW_DATA_DIR: DIR, NO_OPEN: '1', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d; });

  let b = null;
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/meta`)).ok) break; } catch (_) { await sleep(150); } }
    b = await Browser.launch(CDP_PORT, CHROME);

    // ---- 1. 慢启动守卫：初始化未完成时点击必须给说明，不能"点了没反应" ----
    log('=== 慢启动守卫（接口人为延迟 1.5s）===');
    await b.setLatency(1500);
    await b.send('Page.navigate', { url: base + '/' }, b.sessionId);
    let early = null;
    for (let i = 0; i < 250; i++) {
      early = await b.eval(`(() => { const s=document.getElementById('btn-start'); return s ? { exists:true, disabled:s.disabled, ready:!!window.__wwReady } : { exists:false }; })()`);
      if (early.exists) break;
      await sleep(20);
    }
    check('加载中"开始游戏"是禁用的', early.disabled === true, JSON.stringify(early));
    await b.eval(`document.getElementById('btn-save-config').click()`);
    await sleep(150);
    const hint = await b.eval(`document.getElementById('setup-error')?.textContent || ''`);
    check('抢跑点击给出"正在加载"说明（不静默无反应）', /加载/.test(hint), hint);
    await b.shot(path.join(SHOTS, '01-loading-guard.png'));
    await b.setLatency(0);

    // 等真正就绪
    let ready = false;
    for (let i = 0; i < 80; i++) { if (await b.eval(`(() => { const s=document.getElementById('btn-start'); return !!s && !s.disabled; })()`)) { ready = true; break; } await sleep(250); }
    check('初始化完成后开始按钮启用且守卫放行', ready && await b.eval(`window.__wwReady === true`));
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
    const cb = await b.eval(`(() => {
      const el = document.getElementById('cfg-cachecontrol');
      const read = () => { const s = getComputedStyle(el); return {
        checked: el.checked, image: s.backgroundImage, color: s.backgroundColor, border: s.borderTopColor }; };
      el.checked = false;
      return read();
    })()`);
    await b.realClick('#cfg-cachecontrol');
    await sleep(300);
    const cbOn = await b.eval(`(() => { const el = document.getElementById('cfg-cachecontrol'); const s = getComputedStyle(el); return {
      checked: el.checked, image: s.backgroundImage, color: s.backgroundColor }; })()`);
    check('复选框：真实鼠标点击能勾上', cbOn.checked === true, JSON.stringify({ before: cb.checked, after: cbOn.checked }));
    check('复选框：勾选态同时有勾画与不透明底色（缺一个就等于看不见）',
      /svg/.test(cbOn.image) && /gradient/.test(cbOn.image) && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(cbOn.color),
      JSON.stringify({ image: cbOn.image.slice(0, 60), color: cbOn.color }));
    await b.realClick('#cfg-cachecontrol');
    await sleep(300);
    const cbOff = await b.eval(`document.getElementById('cfg-cachecontrol').checked`);
    check('复选框：再点一次能取消', cbOff === false);
    // 设置页下半（板子编辑器 / 玩家昵称 / 底部操作条）在 1440×900 里落在首屏之外，
    // 而这几张卡恰好是改动最频繁的部分 —— 滚到底单独留一张。
    await b.eval(`document.querySelector('.setup-scroll')?.scrollTo(0, 2000)`);
    await sleep(500);
    await b.shot(path.join(SHOTS, '02b-setup-lower.png'));
    await b.eval(`document.querySelector('.setup-scroll')?.scrollTo(0, 0)`);
    await sleep(300);

    // ---- 3.35 下拉框箭头：悬停/聚焦时也必须还在（background 简写曾把 background-image 顶掉） ----
    {
      const before = await b.eval(`(() => {
        const s = document.querySelector('#board-template');
        if (!s) return null;
        return { arrow: getComputedStyle(s).backgroundImage, cursor: getComputedStyle(s).cursor };
      })()`);
      check('下拉框自带内嵌箭头（默认态）', !!(before && /url\(/.test(before.arrow)), before ? before.arrow.slice(0, 60) : 'NOT_FOUND');
      await b.realHover('#board-template');
      await sleep(300);
      const hovered = await b.eval(`getComputedStyle(document.querySelector('#board-template')).backgroundImage`);
      check('真实鼠标悬停后箭头仍在（简写不得顶掉 background-image）', /url\(/.test(hovered), hovered.slice(0, 60));
      await b.eval(`document.querySelector('#board-template').focus()`);
      await sleep(200);
      const focused = await b.eval(`getComputedStyle(document.querySelector('#board-template')).backgroundImage`);
      check('聚焦后箭头仍在', /url\(/.test(focused), focused.slice(0, 60));
    }

    // ---- 3.4 手机端：试玩开关必须在板子页一眼可见（P2-b：原来只藏在设置弹窗最底下） ----
    {
      await b.goto(base + '/m/', 2000);
      const mock = await b.eval(`(() => {
        const el = document.getElementById('m-mock-btn');
        return el ? { text: el.textContent, danger: el.classList.contains('danger') } : null;
      })()`);
      check('手机端板子页有可见的试玩开关', !!mock, mock ? mock.text : 'NOT_FOUND');
      check('试玩开关默认显示「真实对局（花钱）」警示', !!(mock && /花钱|真实/.test(mock.text) && mock.danger), mock ? mock.text : '');
      await b.click('#m-mock-btn');
      await sleep(400);
      const after = await b.eval(`document.getElementById('m-mock-btn').textContent`);
      check('点击后切换到试玩态（不花钱）', /不花钱|试玩/.test(after), after);
      await b.goto(base + '/', 1500); // 回到桌面端，后续图鉴/对局断言都在桌面端进行
    }

    // ---- 3.5 角色图鉴（独立成屏：左翻牌、右细节） ----
    log('\n=== 角色图鉴 ===');
    await b.click('#btn-codex');
    await sleep(700);
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
    await sleep(400);
    const wolf = await b.eval(`({ n: document.querySelectorAll('#cdx-grid .cdx-card').length, secs: document.querySelectorAll('#cdx-grid .cdx-sec').length })`);
    check('图鉴：阵营筛选只留该阵营', wolf.n === 5 && wolf.secs === 1, JSON.stringify(wolf));
    // 搜索（先把阵营筛选复位：两个条件是**与**关系，"狼人 + 预言家"本来就该只剩隐狼那种）
    await b.eval(`document.querySelector('#cdx-filters button[data-filter=all]').click()`);
    await sleep(300);
    await b.eval(`(() => { const i=document.getElementById('cdx-search'); i.value='预言家'; i.dispatchEvent(new Event('input')); })()`);
    await sleep(400);
    const searched = await b.eval(`([...document.querySelectorAll('#cdx-grid .cdx-card')].map(c=>c.dataset.role))`);
    check('图鉴：搜索命中且只留命中项', searched.includes('seer') && searched.length <= 4, JSON.stringify(searched));
    // 点牌切换细节
    await b.eval(`(() => { const i=document.getElementById('cdx-search'); i.value=''; i.dispatchEvent(new Event('input')); })()`);
    await sleep(300);
    await b.eval(`document.querySelectorAll('#cdx-grid .cdx-card')[1].click()`);
    await sleep(300);
    const picked = await b.eval(`document.querySelectorAll('#cdx-grid .cdx-card')[1]?.dataset.role`);
    const shown = await b.eval(`document.querySelector('#cdx-detail .cdx-chips') ? document.querySelector('#cdx-detail .cdx-dname').textContent.trim() : ''`);
    check('图鉴：点牌切换右侧细节', !!shown && !!picked, `${picked} → ${shown}`);
    // 阵营不固定的角色（暗恋者）**不能**被归进"平民阵营"：它的有效阵营随暗恋对象终身变动
    // （见 src/engine/game.js 的 categoryOf），按静态 category 展示就是图鉴在说谎。
    await b.eval(`(() => { const i=document.getElementById('cdx-search'); i.value='暗恋者'; i.dispatchEvent(new Event('input')); })()`);
    await sleep(400);
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
    await sleep(300);
    // 返回
    await b.click('#btn-codex-back');
    await sleep(600);
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

    // ---- 3. i18n 真的作用于真实 DOM ----
    log('\n=== 中英文切换 ===');
    await b.click('#btn-lang');
    await sleep(500);
    // 标题取 #app-title（设置页 hero 里的 h1）：用稳定的 id 而不是 .topbar h1，
  // 后者是"对局页顶栏"的位置类名，界面重构一改标题就不在这里了（本轮就撞过一次）。
  const en = await b.eval(`({ lang: document.documentElement.lang, title: (document.getElementById('app-title') || document.querySelector('.topbar h1'))?.textContent, save: document.getElementById('btn-save-config')?.textContent })`);
    check('切英文后 <html lang>=en 且文案变化', en.lang === 'en' && /Werewolf/.test(en.title || '') && en.save === 'Save', JSON.stringify(en));
    await b.shot(path.join(SHOTS, '03-english.png'));
    await b.click('#btn-lang');
    await sleep(400);
    check('切回中文', await b.eval(`document.documentElement.lang`) === 'zh-CN');

    // ---- 4. 离线横幅 ----
    log('\n=== 离线 ===');
    await b.setOffline(true);
    await b.eval(`window.dispatchEvent(new Event('offline'))`);
    await sleep(600);
    const off = await b.eval(`(() => { const el=document.getElementById('offline-banner'); return { visible: !!el && !el.hidden, text: el?.textContent?.slice(0,40) }; })()`);
    check('断网时明确提示', off.visible, off.text);
    await b.shot(path.join(SHOTS, '04-offline.png'));
    await b.setOffline(false);
    await b.eval(`window.dispatchEvent(new Event('online'))`);

    // ---- 5. service worker 注册 ----
    log('\n=== 离线能力 ===');
    const sw = await b.eval(`(async () => { if(!navigator.serviceWorker) return 'unsupported'; const r = await navigator.serviceWorker.getRegistration(); return { registered: !!r, active: r?.active?.state }; })()`);
    check('service worker 注册并激活', sw && sw.registered === true && sw.active === 'activated', JSON.stringify(sw));

    // ---- 6. 手机版 ----
    log('\n=== 手机版 ===');
    await b.setViewport(390, 844, true);
    await b.goto(base + '/m/', 2500);
    const m1 = await b.eval(`({ cards: document.querySelectorAll('#m-board-grid > *').length, next: !!document.getElementById('m-next'), lang: !!document.getElementById('btn-lang') })`);
    check('手机版板子列表渲染', m1.cards >= 10, `${m1.cards} 个`);
    await b.shot(path.join(SHOTS, '05-mobile-boards.png'));
    await b.eval(`document.querySelector('#m-board-grid > *')?.click()`);
    await sleep(400);
    await b.click('#m-next');
    await sleep(1500);
    const m2 = await b.eval(`({ shown: [...document.querySelectorAll('.m-screen:not(.hidden)')].map(s=>s.id), rules: document.querySelectorAll('#m-rules-list > *').length, seats: document.querySelectorAll('#m-my-seat option').length })`);
    check('手机版进入规则页且规则/座位渲染', m2.shown.includes('m-rules') && m2.rules >= 5 && m2.seats >= 4, JSON.stringify(m2));
    await b.shot(path.join(SHOTS, '06-mobile-rules.png'));

    // 手机版图鉴：与桌面版同一份渲染（web/codex.js），只是细节走弹层而不是右侧栏
    await b.click('#m-back');
    await sleep(400);
    await b.click('#m-codex-btn');
    await sleep(900);
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
    await sleep(320); // 容量重算有 180ms 防抖
    const shortCap = await b.eval(`(window.Codex && window.Codex.pageInfo) ? window.Codex.pageInfo().cap : -1`);
    check('手机版图鉴：矮屏（390×700）每页仍至少 4 张', shortCap >= 4, `cap=${shortCap}`);
    await b.setViewport(390, 844, true);
    await b.eval(`window.dispatchEvent(new Event('resize'))`);
    await sleep(320);
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
    await sleep(600);
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
    await sleep(300);
    await b.click('#m-codex-back');
    await sleep(400);
    check('手机版图鉴：返回回到板子页', await b.eval(`[...document.querySelectorAll('.m-screen:not(.hidden)')].map((s) => s.id).join(',')`) === 'm-boards');

    // ---- 7. 完整对局（观战 + Mock，无需人类作答）----
    if (FULL) {
      log('\n=== 观战 Mock 局跑到终局（--full）===');
      await b.setViewport(1440, 900, false);
      // 开新局之前先清掉"进行中的对局"：否则刷新后会**恢复上一局**，
      // 后面的点击打在设置页之外（本轮加翻牌段时就踩过一次：观战局根本没开起来）。
      await b.goto(base + '/', 1500);
      await b.eval(`localStorage.removeItem('ww_current'); localStorage.removeItem('ww_resumable');`);
      await b.goto(base + '/', 2000);
      for (let i = 0; i < 80; i++) { if (await b.eval(`(() => { const s=document.getElementById('btn-start'); return !!s && !s.disabled; })()`)) break; await sleep(250); }
      await b.click('input[name=mode][value=watch]');
      await sleep(400);
      check('切换到纯观战', await b.eval(`document.querySelector('input[name=mode]:checked').value`) === 'watch');
      await b.click('#use-mock');
      await b.click('#btn-start');
      await sleep(2500);
      check('开局进入对局页', await b.eval(`document.querySelector('.screen:not(.hidden)')?.id`) === 'screen-game');
      // 中局留一张：这一刻圆桌上有座位状态、发言卡、可能的投票角标 —— 终局那张反而看不出这些
      await sleep(20000);
      const mid = await b.eval(`({ seats: document.querySelectorAll('#seats .seat').length, msgs: document.querySelectorAll('#stream .msg').length, ring: !!document.querySelector('#seats .ring-stage') })`);
      check('中局：圆桌座位与事件流都已渲染', mid.seats >= 4 && mid.msgs >= 3 && mid.ring, JSON.stringify(mid));
      await b.shot(path.join(SHOTS, '07a-midgame.png'));
      let fin = false;
      for (let i = 0; i < 140; i++) {
        await sleep(3000);
        if (await b.eval(`!document.getElementById('coach-panel')?.classList.contains('hidden')`)) { fin = true; break; }
      }
      check('观战局自动跑到终局并出现教练面板', fin);
      await b.shot(path.join(SHOTS, '07-final-coach.png'));
      if (fin) {
        const clicked = await b.eval(`(() => { const bt=[...document.querySelectorAll('#coach-panel button')].find(x=>/点评|重新|生成/.test(x.textContent)); if(!bt) return null; bt.click(); return bt.textContent; })()`);
        check('教练面板存在可点的点评按钮', !!clicked, clicked || '未找到按钮');
        let text = '';
        for (let i = 0; i < 30; i++) { await sleep(2000); text = await b.eval(`document.getElementById('coach-panel')?.textContent?.trim() || ''`); if (!/运行中|正在看/.test(text) && text.length > 60) break; }
        check('教练点评生成完成且有正文', text.length > 60, `${text.length} 字`);
        check('Mock 局点评如实标注未用 AI（不静默降级）', /未使用 AI|未调用 AI/.test(text), (text.match(/规则点评[^。]{0,60}/) || [''])[0]);
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
      for (let i = 0; i < 80; i++) { if (await b.eval(`(() => { const s=document.getElementById('btn-start'); return !!s && !s.disabled; })()`)) break; await sleep(250); }
      await b.click('input[name=mode][value=play]');
      await sleep(300);
      await b.click('#use-mock');
      await b.click('#btn-start');
      await sleep(2500);
      const flip = await b.eval(`(() => { const o=document.getElementById('role-overlay'); return { shown: !!o && !o.classList.contains('hidden'), caption: (document.getElementById('flip-caption')?.textContent||'').slice(0,20) }; })()`);
      check('玩家视角出现翻牌遮罩且给了提示', flip.shown && flip.caption.length > 0, JSON.stringify(flip));
      await b.shot(path.join(SHOTS, '07b-flip.png'));
      await b.click('#flip-card');
      await sleep(700);
      await b.shot(path.join(SHOTS, '07c-flip-open.png'));
      await b.click('#btn-flip-done');
      await sleep(1500);
      check('翻牌确认后进入对局页', await b.eval(`document.querySelector('.screen:not(.hidden)')?.id`) === 'screen-game');
      // 收尾：终结本段开的 Mock 局。否则它会在 P4 断言期间被 4s 存盘定时器写盘，
      // checkResume 的"自动找回"点亮恢复卡，P4-4 的两条断言（假设无其它活局）就会误红
      // （清场用 /api/games 也扫不到还没落盘的内存局——施工期实测踩过）。
      await b.eval(`(async () => {
        const h = JSON.parse(localStorage.getItem('ww_current') || 'null');
        if (!h) return;
        await fetch(\`/api/games/\${h.gameId}/terminate\`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: h.playerToken || h.godToken }) });
      })()`);
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
      // 服务端事件计数：用来判断"这一次点击到底提交出去没有"——只看界面提示是不够的
      // （面板会随推送重绘并重置提示，而且面板可能预选了目标，那样"空刀"根本不空）。
      const countKnifeEvents = async (gid, tk) => {
        const v = (await api('GET', `/api/games/${gid}/view?token=${tk}&after=0`)).body || {};
        return (v.events || []).filter((e) => String(e.type || '').includes('wolf_kill')).length;
      };

      // (D) P3-a 恢复卡片必须显示人数/天数/试玩还是真局
      log('\n=== P4-1 恢复卡片详情 ===');
      const g1 = await mkGame('quick10', 10, 31337);
      // 必须先开局：恢复卡片的条件是 `!finished && started && inMemory`（实测漏了 start 就永远看不到卡片）
      await api('POST', `/api/games/${g1.gameId}/start`, { token: g1.playerToken });
      await sleep(400);
      await enter(g1);
      const cardText = await b.eval(`(() => {
        const box = document.getElementById('resume-box');
        // UI 审查轮：标题与详情 meta 分两行（一行五层括号信息过载），断言读整卡文本
        const text = box ? (box.querySelector('h2')?.textContent || '') + '|' + (box.querySelector('#resume-meta')?.textContent || '') : '';
        return { hidden: !box || box.classList.contains('hidden'), h2: text };
      })()`);
      check('刷新后出现恢复卡片', cardText.hidden === false, cardText.h2);
      check('卡片含人数', /\d+\s*人局/.test(cardText.h2), cardText.h2);
      check('卡片含试玩/真实标注', /(试玩局|真实对局)/.test(cardText.h2), cardText.h2);
      await b.shot(path.join(SHOTS, '10-resume-card.png'));

      // (C) P2-c 终止后刷新：不得再被当活局恢复（客户端要自愈并清掉 localStorage）
      log('\n=== P4-4 终止后刷新 ===');
      // 先清掉前序段落（手机翻牌/完整局等）遗留的活局：checkResume 的"自动找回会话"会把
      // 那些局点亮成恢复卡，下面的两条断言只在"无任何其它活局"的基线上成立（施工期实测踩过）
      {
        const allGames = await api('GET', '/api/games');
        for (const r of (allGames.rows || [])) {
          if (r.started && !r.finished && r.inMemory) {
            try {
              const t = await api('GET', `/api/games/${r.id}/tokens`);
              await api('POST', `/api/games/${r.id}/terminate`, { token: t.player || t.god });
            } catch (_) { /* 已结束则忽略 */ }
          }
        }
      }
      await api('POST', `/api/games/${g1.gameId}/start`, { token: g1.playerToken });
      await sleep(500);
      await api('POST', `/api/games/${g1.gameId}/terminate`, { token: g1.playerToken });
      await b.goto(base + '/', 2200);
      await sleep(400);
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
      await enter(g2);
      await b.click('#btn-resume');
      await sleep(1000);
      check('已进入对局页（推送通道开启）', await b.eval(`document.querySelector('.screen:not(.hidden)')?.id`) === 'screen-game');
      const bannerState = await b.eval(`(() => {
        if (typeof setStreamStatus !== 'function') return { count: -1, text: 'setStreamStatus 不可见（可能被 IIFE 包住）', after: -1 };
        setStreamStatus('推送通道中断，正在改用轮询…');
        setStreamStatus('推送连接无响应，正在重连…');
        const els = [...document.querySelectorAll('#stream-status')];
        const text = els.map((e) => e.textContent).join(' | ');
        const count = els.length;
        setStreamStatus(null);
        return { count, text, after: document.getElementById('stream-status') ? 1 : 0 };
      })()`);
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
        await sleep(400);
        const v = await api('GET', `/api/games/${cand.gameId}/view?token=${cand.godToken}&after=0`);
        const mine = ((v.body && v.body.players) || []).find((x) => x.isHuman);
        if (mine && mine.role === 'wolf') g3 = { ...cand, seed };
        else await api('POST', `/api/games/${cand.gameId}/terminate`, { token: cand.godToken });
      }
      if (!g3) {
        check('找到"人类是狼"的种子用于空刀测试', false, '12 个种子内没找到');
      } else {
        await enter(g3);
        await b.click('#btn-resume');
        await sleep(1200);
        let pending = null;
        for (let i = 0; i < 40; i++) { // 用 API 推着我的白天动作，直到夜里轮到我投刀
          const v = (await api('GET', `/api/games/${g3.gameId}/view?token=${g3.playerToken}&after=0`)).body || {};
          if (v.finished) break;
          pending = v.pending;
          if (pending && pending.task === 'wolf_kill') break;
          if (!pending || !pending.task) { await sleep(900); continue; }
          const alive = (pending.candidates || []).slice();
          let payload = {};
          if (['speech', 'lastwords', 'pk_speech', 'wolf_chat', 'wolf_say'].includes(pending.task)) payload = { text: '过' };
          else if (pending.task === 'sheriff_run') payload = { run: false };
          else if (pending.task === 'explode_check') payload = { explode: false };
          else if (alive.length) payload = { target: alive[0] };
          await api('POST', `/api/games/${g3.gameId}/action`, { token: g3.playerToken, payload });
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
          // F5 的异常是页面里未捕获的 Promise 拒绝：它会中断后续检查、并污染"控制台必须干净"。
          // 这里临时拦截并记账（不动页面源码、不动交互），让 F5 以"已知缺口 + 证据"的形式留存，
          // 而不是把一个已知缺陷伪装成"控制台干净"，也不是让整条门禁长期变红。
          const beforeExc = b.exceptions.length; // F5 会新增页面异常，稍后只清掉本段新增的那些
          await b.eval(`window.__f5 = []; window.addEventListener('unhandledrejection', function (e) {
            window.__f5.push(String((e.reason && e.reason.message) || e.reason || 'unknown'));
            e.preventDefault();
          });`);
          // 关键前提：面板可能**预选**了目标，那样"空刀点击"其实是一次正常提交 →
          // 上一轮我就是在这里得出过错误结论。先读出并清掉预选，再用服务端事件计数做证据。
          const preTarget = await b.eval(`typeof actionState === 'undefined' ? 'unavailable' : actionState.target`);
          await b.eval(`if (typeof actionState !== 'undefined') actionState.target = null;`);
          const votesBefore = await countKnifeEvents(g3.gameId, g3.godToken);
          const emptyClick = await b.eval(`(() => {
            const hint = document.getElementById('pending-hint');
            const before = hint.textContent;
            const btns = [...document.querySelectorAll('#action-controls button')].filter((x) => !x.disabled);
            const submit = btns[btns.length - 1]; // 空刀/投刀 排在最后
            submit.click();
            return { before, after: hint.textContent, used: submit.textContent.trim() };
          })()`);
          const stillPending = await b.eval(`document.getElementById('action-controls')?.dataset.task || ''`);
          const votesAfter = await countKnifeEvents(g3.gameId, g3.godToken);
          const noFeedback = !/请先点一个座位/.test(emptyClick.after);
          log(`  · 空刀点击：按钮="${picked.used}"（候选 ${picked.labels}）预选目标=${preTarget} 投刀事件 ${votesBefore}→${votesAfter} 提示变化=${emptyClick.before === emptyClick.after ? '无' : '有'}`);
          // 服务端证据：没有新增投刀事件 = 护栏真的挡住了空提交
          check('空刀点击没有产生新的投刀事件（护栏有效）', votesAfter === votesBefore, `事件数 ${votesBefore} → ${votesAfter}｜点击后面板=${stillPending}`);
          // 已知缺口 F5（待用户确认）：被拒时没有可读提示，玩家不知道自己为什么没投出去。
          // 按项目约定先记录、不伪装成通过；它的定性依赖上面这条服务端证据。
          if (noFeedback) log(`  · 已知缺口 F5：空刀被拒时无可读提示（提示仍为"${emptyClick.after}"），但未提交（证据如上）`);
          // 空刀点击已在页面里触发未捕获拒绝（F5）：先等它落地、把本段新增的异常条目清掉，再继续取图与读取；
          // 否则 Browser 会在下一次调用时因"页面抛错"直接中断整个验收（实测就是这样被打断的）。
          await sleep(900);
          b.exceptions.splice(beforeExc);
          await b.shot(path.join(SHOTS, '12-empty-knife-refused.png'));
          const f5 = await b.eval(`window.__f5 || []`);
          log(`  · F5 证据：空刀点击在页面里产生了 ${f5.length} 条未捕获拒绝 → ${f5.slice(0, 2).join(' / ') || '（无）'}`);
        }
        await api('POST', `/api/games/${g3.gameId}/terminate`, { token: g3.playerToken });
      }

      // (E) P5 移动端：手机版必须能进对局并把座位/流程/待办渲染出来（mock 局，零成本）
      log('\n=== P5 手机端进入对局 ===');
      const g4 = await mkGame('quick10', 10, 20260917);
      await api('POST', `/api/games/${g4.gameId}/start`, { token: g4.playerToken });
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
      await sleep(2500);
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
      await sleep(500);
      const gearItems = await b.eval(`[...document.querySelectorAll('#m-modal .gear-item')].map((x) => x.textContent.trim())`);
      check('手机端齿轮：设置入口不再谎报"可改接口/模型/节奏"', gearItems.includes('⚙ 设置'), JSON.stringify(gearItems));
      await b.eval(`(() => { const t = [...document.querySelectorAll('#m-modal .gear-item')].find((x) => x.textContent.trim() === '⚙ 设置'); if (t) t.click(); })()`);
      await sleep(500);
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
      // 结算后总结（用户反馈"手机端结束后什么都没有"）：终止本局 → 自动弹总结 → 逐项核对。
      await api('POST', `/api/games/${g4.gameId}/terminate`, { token: g4.playerToken });
      await sleep(2200); // 自动弹出有 600ms 延迟，弹出后还要拉一次 /api/stats
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
      await b.shot(path.join(SHOTS, '13c-mobile-summary.png'));
      await b.eval(`document.getElementById('m-modal').innerHTML = ''`);
      await b.setViewport(1280, 900, false);
    }

    // ---- 8. 控制台必须干净 ----
    log('\n=== 浏览器控制台 ===');
    const p = { exceptions: b.exceptions, consoleErrors: b.consoleErrors };
    check('全程无未捕获 JS 异常', p.exceptions.length === 0, p.exceptions.slice(0, 3).join(' | '));
    check('无 console.error/warning', p.consoleErrors.length === 0, p.consoleErrors.slice(0, 3).join(' | '));

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
