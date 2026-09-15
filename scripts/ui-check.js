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
 *   WW_CHROME=<浏览器路径> 可指定内核；找不到浏览器时本脚本**跳过并以 0 退出**（不影响 CI）。
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
const SHOTS = path.join(ROOT, 'logs', 'ui-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = process.env.WW_CHROME || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });

// ---------- 结果收集 ----------
let fails = 0;
const lines = [];
const log = (...a) => { const l = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); lines.push(l); console.log(l); };
const check = (label, cond, extra = '') => { if (!cond) fails++; log(`${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`); };

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
    let version = null;
    for (let i = 0; i < 60; i++) {
      try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch (_) { await sleep(200); }
    }
    if (!version) throw new Error('DevTools 端口未就绪');
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
    const en = await b.eval(`({ lang: document.documentElement.lang, title: document.querySelector('.topbar h1')?.textContent, save: document.getElementById('btn-save-config')?.textContent })`);
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

    // ---- 7. 完整对局（观战 + Mock，无需人类作答）----
    if (FULL) {
      log('\n=== 观战 Mock 局跑到终局（--full）===');
      await b.setViewport(1440, 900, false);
      await b.goto(base + '/', 2000);
      for (let i = 0; i < 80; i++) { if (await b.eval(`(() => { const s=document.getElementById('btn-start'); return !!s && !s.disabled; })()`)) break; await sleep(250); }
      await b.click('input[name=mode][value=watch]');
      await sleep(400);
      check('切换到纯观战', await b.eval(`document.querySelector('input[name=mode]:checked').value`) === 'watch');
      await b.click('#use-mock');
      await b.click('#btn-start');
      await sleep(2500);
      check('开局进入对局页', await b.eval(`document.querySelector('.screen:not(.hidden)')?.id`) === 'screen-game');
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
    setTimeout(() => process.exit(fails ? 1 : 0), 60);
  }
})();
