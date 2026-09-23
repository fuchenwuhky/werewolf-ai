#!/usr/bin/env node
/**
 * card-skin-probe.js — 角色卡牌皮肤在**真实 Chrome** 里的实寸/实请求探针（SKIN-02 的浏览器臂）
 *
 * 为什么必须有这一份（不能只靠 test/card-frame-skin.test.js）：
 *   · 那个测试跑在 node --test 里，用一个极简 DOM shim 做**结构**断言；它量不到真实
 *     边界矩形（2:3 与 112px 切档）也量不到图片到底有没有加载成功。
 *   · "小卡不主动请求约 1.94MiB 的金属 PNG"这条，只有**网络请求集合**能证明 —— 数 DOM 节点
 *     或 grep CSS 都可能被 `display:none` 骗过去。
 *   · 降级链（PNG→完整 SVG→CSS 细边框、立绘失败→底衬）必须真的把资源打断才会发生。
 *
 * 与 SW 预缓存流量的区分（施工说明 §SKIN-02 的正文要求）：
 *   本探针在导航**之前**用 CDP 拦掉 `*sw.js*`，因此这一轮里不存在 Service Worker 的安装预缓存，
 *   记录到的每一条素材请求都是**卡牌组件自身**发出的；同时脚本会核对"确实没有 sw.js 成功注册"，
 *   避免"以为拦住了其实没拦住"导致的假绿。真实产品里的 SW 预缓存是离线能力的必需项，不在此限。
 *
 * 不写用户数据：服务端用 `WW_DATA_DIR` 指向临时目录，跑完删除；不发任何对局动作、不调模型。
 *
 * 用法：node scripts/card-skin-probe.js [--keep]
 * 退出码：0 = 全部通过；1 = 有失败项；2 = 环境不可用（找不到 Chrome / 服务端起不来，且打印原因）
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  process.env.WW_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const checks = [];
const log = (s) => console.log(s);
function check(label, ok, detail) {
  checks.push({ label, ok: !!ok, detail: detail == null ? '' : String(detail) });
  log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `｜${detail}` : ''}`);
}

// ---------------------------------------------------------------- 极简 CDP 客户端（与 scripts/ui-check.js 同一套做法）

class Browser {
  constructor() { this.id = 0; this.pending = new Map(); this.requests = []; }

  static async launch(port, chrome) {
    const b = new Browser();
    b.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-skin-probe-'));
    b.proc = spawn(chrome, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--mute-audio',
      '--force-device-scale-factor=1', '--window-size=1440,900',
      `--remote-debugging-port=${port}`, `--user-data-dir=${b.userDataDir}`, 'about:blank',
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
    if (msg.method === 'Network.requestWillBeSent') {
      const req = p.request || {};
      this.requests.push({
        requestId: p.requestId,
        url: String(req.url || ''),
        type: p.type || '',
        initiator: (p.initiator && p.initiator.type) || '',
        status: null,
      });
    } else if (msg.method === 'Network.responseReceived') {
      const hit = this.requests.find((r) => r.requestId === p.requestId && r.status == null);
      if (hit) hit.status = p.response.status;
    } else if (msg.method === 'Network.loadingFailed') {
      const hit = this.requests.find((r) => r.requestId === p.requestId && r.status == null);
      if (hit) hit.status = `failed:${p.errorText || p.blockedReason || ''}`;
    }
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); } }, 30000);
    });
  }

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, this.sessionId);
    if (r.exceptionDetails) throw new Error(`页面 JS 抛错: ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`);
    return r.result && r.result.value;
  }

  /** 记录一条"从这里开始的请求才算数"的分界线 */
  mark() { this.requests.length = 0; }

  /** 只取素材类请求（把页面外壳/接口请求分开，避免把别的流量算成卡牌流量） */
  assetRequests() {
    return this.requests.filter((r) => /\/assets\/|card-frame-kit\.css/.test(r.url));
  }

  async setBlocked(urls) { await this.send('Network.setBlockedURLs', { urls }, this.sessionId); }
  async setCacheDisabled(disabled) { await this.send('Network.setCacheDisabled', { cacheDisabled: !!disabled }, this.sessionId); }

  async close() {
    try { if (this.ws) this.ws.close(); } catch (_) { /* ignore */ }
    try { this.proc.kill(); } catch (_) { /* ignore */ }
    try { fs.rmSync(this.userDataDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

/** 页面侧助手：装一次，后面每段都用它挂卡 / 序列化 DOM */
const INSTALL_HELPERS = `(() => {
  const hosts = [];
  const waitImages = async (root) => {
    const imgs = [...root.querySelectorAll('img')];
    await Promise.all(imgs.map((img) => img.complete ? Promise.resolve()
      : new Promise((res) => { img.addEventListener('load', res, { once: true }); img.addEventListener('error', res, { once: true }); })));
    await new Promise((r) => setTimeout(r, 350)); // 给 SVG <image> / 装饰层一点解码时间
    return imgs.length;
  };
  const dump = (node) => {
    const attrs = [...node.attributes].map((a) => a.name + '=' + a.value).sort();
    const ds = Object.entries(node.dataset || {}).sort().map(([k, v]) => 'data-' + k + '=' + v);
    const kids = [...node.children].map(dump);
    return [node.tagName, node.className, ...attrs, ...ds, 'text=' + (node.textContent || ''), ...kids].join('|');
  };
  window.__wwProbe = {
    hosts,
    dump: (node) => dump(node).replace(/r3-window-\\d+/g, 'r3-window-N'),
    dumpRaw: (node) => dump(node),
    async mount(options) {
      const host = document.createElement('div');
      host.className = 'ww-probe-host';
      host.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483000;background:#06090f;opacity:0.01;';
      document.body.appendChild(host);
      hosts.push(host);
      const shell = window.CardFrame.mount(host, options);
      await waitImages(shell);
      const card = shell.querySelector('.r3-card');
      const rect = shell.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const layers = [...card.children].map((el) => {
        const cs = getComputedStyle(el);
        return {
          cls: el.className.baseVal !== undefined ? String(el.className.baseVal) : String(el.className),
          tag: el.tagName.toLowerCase(),
          display: cs.display,
          pointerEvents: cs.pointerEvents,
          src: el.tagName.toLowerCase() === 'img' ? el.currentSrc || el.src : (el.getAttribute('href') || ''),
          complete: el.tagName.toLowerCase() === 'img' ? el.complete : null,
          naturalWidth: el.tagName.toLowerCase() === 'img' ? el.naturalWidth : null,
          hidden: el.hidden === true,
          text: el.textContent || '',
        };
      });
      return {
        theme: shell.dataset.theme, detail: shell.dataset.detail, render: shell.dataset.render,
        width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100,
        cardWidth: Math.round(cardRect.width * 100) / 100, cardHeight: Math.round(cardRect.height * 100) / 100,
        flags: { ...card.dataset },
        aria: card.getAttribute('aria-label'),
        role: card.getAttribute('role'),
        layers,
        imgSrcs: layers.map((l) => l.src).filter(Boolean),
        dump: dump(shell).replace(/r3-window-\\d+/g, 'r3-window-N'),
        afterDisplay: getComputedStyle(card, '::after').display,
        afterBorder: getComputedStyle(card, '::after').borderTopWidth,
        host,
      };
    },
    hitTest() {
      const host = hosts[hosts.length - 1];
      if (!host) return { inHost: false };
      const card = host.querySelector('.r3-card');
      const r = card.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        inHost: !!el && (el === host || host.contains(el)),
        hitTag: el ? el.tagName.toLowerCase() : null,
        hitClass: el && el.className ? String(el.className.baseVal !== undefined ? el.className.baseVal : el.className) : '',
      };
    },
    reset() { for (const h of hosts.splice(0)) h.remove(); },
  };
  return true;
})()`;

async function main() {
  const chrome = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p));
  if (!chrome) {
    log(`✗ 找不到 Chrome（候选：${CHROME_CANDIDATES.join(' / ')}）；可设 WW_CHROME 指定。本探针未执行。`);
    process.exit(2);
  }
  log(`浏览器内核：${chrome}`);

  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-skin-data-'));
  const PORT = Number(process.env.WW_SKIN_PORT || 3900 + Math.floor(Math.random() * 90));
  const CDP_PORT = Number(process.env.WW_SKIN_CDP_PORT || 9900 + Math.floor(Math.random() * 90));
  const base = `http://127.0.0.1:${PORT}`;
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), WW_DATA_DIR: DIR, NO_OPEN: '1', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d; });
  let b = null;
  let exitCode = 1;
  try {
    let ready = false;
    for (let i = 0; i < 100 && server.exitCode === null; i++) {
      try { if ((await fetch(`${base}/api/meta`)).ok) { ready = true; break; } } catch (_) { /* 还没起来 */ }
      await sleep(150);
    }
    if (!ready || server.exitCode !== null) {
      throw new Error(`服务端未就绪（exitCode=${server.exitCode}）stderr=${(serverErr || '(空)').slice(-300)}`);
    }

    b = await Browser.launch(CDP_PORT, chrome);
    // 第一趟：**照常**加载，先给 SW 的安装期一次性预缓存记账（它确实是另一类流量）。
    await b.send('Page.navigate', { url: `${base}/index.html` }, b.sessionId);
    for (let i = 0; i < 60; i++) {
      const st = await b.eval('({ rs: document.readyState, cf: !!window.CardFrame })');
      if (st.rs === 'complete' && st.cf) break;
      await sleep(200);
    }
    // 把 SW 预缓存流量**显式清掉并单独记账**：
    //   · Cache Storage 里的条目 = SW 安装期的一次性预缓存（离线能力的代价，不算卡牌组件流量）；
    //   · 清掉之后再开始量卡牌流量，两类数字不会互相冒充。
    const swInfo = await b.eval(`(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      const keys = await caches.keys();
      const cached = [];
      for (const k of keys) { const c = await caches.open(k); cached.push(...(await c.keys()).map((r) => new URL(r.url).pathname)); }
      for (const r of regs) await r.unregister();
      for (const k of keys) await caches.delete(k);
      await new Promise((r) => setTimeout(r, 300));
      return {
        cacheKeys: keys, cached,
        hadPng: cached.some((p) => /reliquary-metal\\.png$/.test(p)),
        cleared: { regs: (await navigator.serviceWorker.getRegistrations()).length, caches: (await caches.keys()).length },
      };
    })()`);
    log(`  SW 预缓存流量（一次性，已清除，不计入卡牌流量）：缓存仓 ${JSON.stringify(swInfo.cacheKeys)}，共 ${swInfo.cached.length} 条，其中含金属 PNG=${swInfo.hadPng}`);
    check('SW 预缓存的条目与卡牌组件流量分开记账（缓存已清空）', swInfo.cleared.regs === 0 && swInfo.cleared.caches === 0, JSON.stringify(swInfo.cleared));

    // 第二趟：从**文档起始**就禁用 SW 注册（`addScriptToEvaluateOnNewDocument` 在页面任何脚本之前执行），
    // 于是本页既不被 SW 控制、也不会再写预缓存 —— 后面量到的每一条素材请求都是卡牌组件自己发的。
    await b.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => { try { if (navigator.serviceWorker && navigator.serviceWorker.register) { navigator.serviceWorker.register = () => Promise.reject(new Error('ww-card-skin-probe: SW disabled')); } } catch (_) {} })();`,
    }, b.sessionId);
    await b.setBlocked(['*sw.js*']);
    await b.send('Page.navigate', { url: `${base}/index.html` }, b.sessionId);
    for (let i = 0; i < 60; i++) {
      const st = await b.eval('({ rs: document.readyState, cf: !!window.CardFrame })');
      if (st.rs === 'complete' && st.cf) break;
      await sleep(200);
    }
    const boot = await b.eval('({ rs: document.readyState, cf: typeof window.CardFrame, mount: typeof (window.CardFrame && window.CardFrame.mount), kit: !!document.getElementById("ww-card-kit-css"), assetBase: window.CardFrame && window.CardFrame.assetBase(), root: location.pathname, sw: { regs: 0, controller: !!navigator.serviceWorker.controller } })');
    check('真实页面里 card-frame.js 加载并暴露 mount()，共享样式由共享层在加载时注入', boot.cf === 'object' && boot.mount === 'function' && boot.kit === true, JSON.stringify(boot));
    check('真实页面里解析出的素材目录是站点根下的 /assets/card-frames/v3/（不是相对补丁）',
      boot.assetBase === `${base}/assets/card-frames/v3/`, boot.assetBase);
    const swOff = await b.eval(`(async () => ({ regs: (await navigator.serviceWorker.getRegistrations()).length, caches: (await caches.keys()).length, controller: !!navigator.serviceWorker.controller }))()`);
    check('本轮测量环境无 Service Worker 参与（注册 0 / 缓存 0 / 无 controller）',
      swOff.regs === 0 && swOff.caches === 0 && swOff.controller === false, JSON.stringify(swOff));
    await b.eval(INSTALL_HELPERS);
    await sleep(300);

    // ---------- 1. 小卡：只挂 52/62/112，先看请求集合（此时还从没挂过大卡） ----------
    log('\n=== 1. 小卡路径的请求集合（52/62/112px，未挂过任何大卡）===');
    b.mark();
    const small = await b.eval(`(async () => {
      const out = [];
      for (const w of [52, 62, 112]) out.push(await window.__wwProbe.mount({ roleId: 'seer', revealed: true, width: w }));
      return out;
    })()`);
    await sleep(400);
    const smallReq = b.assetRequests();
    const smallUrls = [...new Set(smallReq.map((r) => r.url))];
    log(`  请求（去重）：\n${smallUrls.map((u) => `    ${u}`).join('\n')}`);
    check('小卡不请求 1.94MiB 金属 PNG（reliquary-metal.png）', !smallUrls.some((u) => /reliquary-metal\.png/.test(u)), `请求集合=${smallUrls.length} 条`);
    check('小卡不请求大卡完整 SVG / 徽记（frame-*.svg / accent-*.svg）', !smallUrls.some((u) => /frame-\w+\.svg|accent-\w+\.svg/.test(u)));
    check('小卡只请求 1 份 R2 小框素材', smallUrls.filter((u) => /compact-\w+\.svg/.test(u)).length === 1, smallUrls.filter((u) => /compact-\w+\.svg/.test(u)).join(','));
    check('小卡请求的素材都拿到了 200（无失败/无 404）', smallReq.every((r) => r.status === 200), JSON.stringify(smallReq.map((r) => [r.url.split('/').pop(), r.status])));
    for (const s of small) {
      check(`小卡 ${s.width}px 档位=data-detail:${s.detail}`,
        s.detail === 'compact' && s.layers.every((l) => !/reliquary-metal|frame-\w+\.svg|accent-\w+\.svg/.test(l.src)),
        `layers=${s.layers.map((l) => `${l.cls}:${l.display}`).join(',')}`);
    }

    // ---------- 2. 实寸几何：52/62/112/113/132/210/230/320 ----------
    log('\n=== 2. 真实边界矩形（2:3 与 112px 切档）===');
    const sizes = await b.eval(`(async () => {
      const out = [];
      for (const w of [52, 62, 112, 113, 132, 210, 230, 320]) out.push(await window.__wwProbe.mount({ roleId: 'seer', revealed: true, width: w }));
      return out.map((s) => ({ w: s.width, h: s.height, cw: s.cardWidth, ch: s.cardHeight, detail: s.detail }));
    })()`);
    const expectSizes = [[52, 78], [62, 93], [112, 168], [113, 170], [132, 198], [210, 315], [230, 345], [320, 480]];
    sizes.forEach((s, i) => {
      const [ew, eh] = expectSizes[i];
      const ratioErr = Math.abs(s.h - s.w * 1.5);
      check(`实测 ${s.w}×${s.h}（期望 ${ew}×${eh}，比例误差 ${ratioErr.toFixed(2)}px ≤1）`,
        s.w === ew && s.h === eh && ratioErr <= 1, `shell=${s.w}×${s.h} card=${s.cw}×${s.ch}`);
    });
    check('112px 走 R2 小框', sizes.find((s) => s.w === 112).detail === 'compact');
    check('113px 走大卡材质', sizes.find((s) => s.w === 113).detail === 'big');
    const bigReq = b.assetRequests().filter((r) => /reliquary-metal\.png/.test(r.url));
    check('大卡（113/132/210/230/320 共 5 张）只请求了 1 次金属 PNG（同一 URL 共享缓存，不是 base64 复制）',
      bigReq.length >= 1 && new Set(bigReq.map((r) => r.url)).size === 1, `次数=${bigReq.length}`);

    // ---------- 3. 图片真实加载结果 + 装饰层不接点击 ----------
    log('\n=== 3. 图片真实加载结果与点击穿透 ===');
    const loaded = await b.eval(`(() => {
      const out = [];
      for (const h of window.__wwProbe.hosts) {
        const shell = h.querySelector('.r3-shell');
        if (!shell) continue;
        const card = shell.querySelector('.r3-card');
        const imgs = [...card.querySelectorAll('img')].map((i) => ({ cls: i.className, ok: i.complete && i.naturalWidth > 0, nw: i.naturalWidth, src: (i.currentSrc || i.src).split('/').pop() }));
        const art = card.querySelector('.r3-art image');
        out.push({ detail: shell.dataset.detail, theme: shell.dataset.theme, imgs, artHref: art ? art.getAttribute('href').split('/').pop() : null });
      }
      return out;
    })()`);
    for (const row of loaded) {
      const bad = row.imgs.filter((i) => !i.ok && !/reliquary-metal|frame-|accent-/.test(i.cls));
      check(`已挂载卡的可见材质图片都真的解码成功（${row.detail}/${row.theme}）`, bad.length === 0, `imgs=${row.imgs.map((i) => `${i.src}:${i.ok ? 'ok' : 'FAIL'}`).join(' ')} art=${row.artHref}`);
    }
    const hiddenShown = await b.eval(`(() => {
      const out = [];
      for (const h of window.__wwProbe.hosts) {
        const card = h.querySelector('.r3-card'); if (!card) continue;
        out.push({ detail: h.querySelector('.r3-shell').dataset.detail, pe: [...card.children].map((el) => getComputedStyle(el).pointerEvents) });
      }
      return out;
    })()`);
    check('所有框层/装饰层的 pointer-events 都是 none（点击归宿主）', hiddenShown.every((r) => r.pe.every((v) => v === 'none')), JSON.stringify(hiddenShown.slice(0, 2)));
    const hit = await b.eval('window.__wwProbe.hitTest()');
    check('卡面中心的命中测试落在宿主子树里（装饰层没有吃掉点击）', hit.inHost && !/r3-(material|vector|accent|compact|art)/.test(hit.hitClass), JSON.stringify(hit));

    // ---------- 4. 隐藏身份：真实浏览器里的 DOM / ARIA / 请求集合 ----------
    log('\n=== 4. 隐藏身份（三个不同秘密角色的未知视图）===');
    await b.eval('window.__wwProbe.reset()');
    b.mark();
    const hiddenViews = await b.eval(`(async () => {
      const out = [];
      for (const rid of ['wolf', 'seer', 'guard']) out.push(await window.__wwProbe.mount({ roleId: rid, revealed: false, width: 230 }));
      return out.map((s) => ({ dump: s.dump, aria: s.aria, role: s.role, theme: s.theme, urls: s.imgSrcs.map((u) => u.split('/').slice(-2).join('/')).sort(), flags: s.flags, layers: s.layers.map((l) => l.src.split('/').slice(-2).join('/')) }));
    })()`);
    await sleep(400);
    const hiddenReq = b.assetRequests();
    const same = (k) => new Set(hiddenViews.map((v) => JSON.stringify(v[k]))).size === 1;
    check('三个秘密角色的未揭示视图 DOM 完全一致（只归一化无语义 clipPath id）', same('dump'), `长度=${hiddenViews.map((v) => v.dump.length).join('/')}`);
    check('ARIA 可访问名称一致且不含任何角色名', same('aria') && hiddenViews.every((v) => !/狼人|预言家|守卫/.test(v.aria)), hiddenViews[0].aria);
    check('主题一致且都是 neutral、都不写 data-role', hiddenViews.every((v) => v.theme === 'neutral' && !v.flags.role));
    check('加载的资源 URL 集合一致（都是同一张中性牌背）', same('urls'), hiddenViews[0].urls.join(' '));
    check('未揭示视图不请求任何本人立绘（roles/*.png）', !hiddenReq.some((r) => /\/assets\/roles\//.test(r.url)), hiddenReq.map((r) => r.url.split('/').pop()).join(','));
    check('本轮整页请求里从未出现秘密角色立绘 URL', !b.requests.some((r) => /roles\/(wolf|seer|guard)\.png/.test(r.url)));
    const flipSame = await b.eval(`(() => {
      const rows = [...document.querySelectorAll('.ww-probe-host .r3-shell')].slice(-3).map((s) => { const r = s.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
      return rows;
    })()`);
    check('未知牌背与已揭示大卡同尺寸（230×345 正反面严格相同）', flipSame.every(([w, h]) => w === 230 && h === 345), JSON.stringify(flipSame));

    // ---------- 5. 降级链：真的把资源打断 ----------
    log('\n=== 5. 降级链（真实断资源）===');
    await b.setCacheDisabled(true);
    await b.eval('window.__wwProbe.reset()');
    await b.setBlocked(['*sw.js*', '*reliquary-metal.png*']);
    const f1 = await b.eval(`window.__wwProbe.mount({ roleId: 'seer', revealed: true, width: 230 })`);
    check('金属 PNG 失败：data-material-error 打点', f1.flags.materialError === 'true', JSON.stringify(f1.flags));
    const vectorLayer = f1.layers.find((l) => /r3-vector/.test(l.cls));
    check('金属 PNG 失败：完整 SVG 顶上（computed display 不是 none）', !!vectorLayer && vectorLayer.display !== 'none', vectorLayer && vectorLayer.display);

    await b.setBlocked(['*sw.js*', '*reliquary-metal.png*', '*frame-oracle.svg*']);
    await b.eval('window.__wwProbe.reset()');
    const f2 = await b.eval(`window.__wwProbe.mount({ roleId: 'seer', revealed: true, width: 230 })`);
    check('完整 SVG 也失败：data-vector-error 打点且落到 CSS 细边框（::after display:block）',
      f2.flags.vectorError === 'true' && f2.afterDisplay === 'block', `flags=${JSON.stringify(f2.flags)} after=${f2.afterDisplay} border=${f2.afterBorder}`);

    await b.setBlocked(['*sw.js*', '*assets/roles/seer.png*']);
    await b.eval('window.__wwProbe.reset()');
    const f3 = await b.eval(`window.__wwProbe.mount({ roleId: 'seer', revealed: true, width: 230 })`);
    const title3 = f3.layers.find((l) => /r3-title/.test(l.cls));
    check('立绘失败：data-art-error 打点 + 名称仍可读（标题可见、aria 不变）',
      f3.flags.artError === 'true' && !!title3 && title3.display !== 'none' && title3.text === '预言家' && f3.aria === '预言家角色牌',
      `flags=${JSON.stringify(f3.flags)} title=${title3 && title3.text}/${title3 && title3.display}`);

    await b.setBlocked(['*sw.js*', '*compact-oracle.svg*']);
    await b.eval('window.__wwProbe.reset()');
    const f4 = await b.eval(`window.__wwProbe.mount({ roleId: 'seer', revealed: true, width: 52 })`);
    check('小框 SVG 失败：data-compact-error 打点且落到 CSS 细边框',
      f4.flags.compactError === 'true' && f4.afterDisplay === 'block', `flags=${JSON.stringify(f4.flags)} after=${f4.afterDisplay}`);
    await b.setBlocked(['*sw.js*']);
    await b.setCacheDisabled(false);

    // ---------- 6. 页面没有因为卡牌抛错 ----------
    log('\n=== 6. 失败不阻断 ===');
    const unusable = await b.eval(`(() => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      let err = null;
      try { window.CardFrame.mount(host, { roleId: 'seer', revealed: true, width: 230 }); } catch (e) { err = String(e && e.message); }
      return { err };
    })()`);
    check('挂载接口本身不抛异常（资源失败只影响外观）', unusable.err === null, JSON.stringify(unusable));

    // ---------- 7. 手机页（web/m/index.html）也走同一份共享层 ----------
    log('\n=== 7. 手机页 /m/index.html（真实小卡场景）===');
    b.mark();
    await b.send('Page.navigate', { url: `${base}/m/index.html` }, b.sessionId);
    for (let i = 0; i < 60; i++) {
      const st = await b.eval('({ rs: document.readyState, cf: !!window.CardFrame })');
      if (st.rs === 'complete' && st.cf) break;
      await sleep(200);
    }
    const mMeta = await b.eval(`(() => {
      const link = document.getElementById('ww-card-kit-css');
      const p = (u) => { try { return new URL(u, location.href).pathname; } catch (_) { return String(u); } };
      return {
        hrefPath: link ? p(link.getAttribute('href')) : null,
        assetPath: p(window.CardFrame.assetBase()),
        artPath: p(window.CardFrame.artBase()),
        href: link ? link.getAttribute('href') : null,
      };
    })()`);
    check('手机页用相对引用 ../card-frame.js 时，共享层仍解析出站点根的 /assets/ 与 /shared/（不是 /m/ 下）',
      mMeta.hrefPath === '/shared/card-frame-kit.css' && mMeta.assetPath === '/assets/card-frames/v3/' && mMeta.artPath === '/assets/roles/',
      JSON.stringify(mMeta));
    await b.eval(INSTALL_HELPERS);
    const mSmall = await b.eval(`(async () => {
      const s = await window.__wwProbe.mount({ roleId: 'villager', revealed: true, width: 62, name: '平民' });
      return { w: s.width, h: s.height, detail: s.detail, theme: s.theme, layers: s.layers.map((l) => l.src) };
    })()`);
    await sleep(400);
    const mReq = [...new Set(b.assetRequests().map((r) => r.url))];
    check('手机页 62px 小卡：53… 62×93、compact 档、village 主题，且没有请求金属 PNG',
      mSmall.w === 62 && mSmall.h === 93 && mSmall.detail === 'compact' && mSmall.theme === 'village'
      && !mReq.some((u) => /reliquary-metal\.png/.test(u)) && mReq.some((u) => /compact-village\.svg/.test(u)),
      JSON.stringify({ rect: `${mSmall.w}×${mSmall.h}`, detail: mSmall.detail, theme: mSmall.theme, req: mReq.map((u) => u.split('/').pop()) }));
  } catch (e) {
    check('探针执行完成', false, e.message);
  } finally {
    if (b) await b.close();
    try { server.kill(); } catch (_) { /* ignore */ }
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }

  const failed = checks.filter((c) => !c.ok);
  log(`\n== 汇总：${checks.length - failed.length}/${checks.length} 通过 ==`);
  for (const f of failed) log(`  ✗ ${f.label}｜${f.detail}`);
  exitCode = failed.length ? 1 : 0;
  log(exitCode === 0 ? '✓ 真实浏览器探针全部通过' : '✗ 真实浏览器探针有失败项');
  process.exit(exitCode);
}

if (require.main === module) main();
