/**
 * exe-check.js — 在**打包后的 EXE** 上复跑 M2-e 桌面臂运行时断言（**已收入仓内**）
 *
 * 来源与改动：原为仓外一次性仪器 `D:\ww-probe\packaged-exe-probe.js`。按 guidance §5 :193
 * "仍在 D:\ww-probe 的浏览器 A/B、反向验证和 packaged-exe 探针，应整理为仓内可复跑脚本，
 * 隔离数据目录、动态端口、清理生命周期和明确退出码"，本文件即该探针的仓内版本，逻辑未改，
 * 只补了这段来源说明与结尾的"未覆盖"声明。逐条对 :193 的审计结论：
 *   · 隔离数据目录：mkdtempSync 两个临时目录 + WW_DATA_DIR + --user-data-dir
 *   · 动态端口：freePort() 取空闲端口给 --remote-debugging-port
 *   · 清理生命周期：退出前 rmSync 两个临时目录
 *   · 明确退出码：3 异常 / 2 找不到 EXE / 1 有判据失败 / 0 全通过
 *
 * ⚠ 未覆盖（guidance :197 明文，不得用替身关闭）：**原生"保存导出文件 → 选回刚保存的文件 → 导入"**。
 * 该路径会弹出原生模态对话框，自动化会被卡死；本脚本因此只用非法/不存在的 profileId 绕开它。
 * 所以本脚本通过 ≠ 随包交付通过：EXE 那一列在有真人完成该往返之前仍是未做。
 *
 * 用法：node scripts/exe-check.js <exe 路径> [标签]
 * 例：node scripts/exe-check.js desktop/dist/werewolf-ai-1.5.2-win-x64-portable.exe
 *
 * 隔离：WW_DATA_DIR 与 --user-data-dir 都指向临时目录。
 * 只用非法/不存在的 profileId：合法且存在的会走到原生保存对话框（模态），会卡死自动化。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');

const EXE = path.resolve(process.argv[2] || '');
const LABEL = process.argv[3] || path.basename(EXE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (n, d) => { results.push(true); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d) => { results.push(false); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WS 连接失败')), { once: true });
    });
    const c = new Cdp(ws);
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      }
    });
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时 ' + method)); } }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('页面异常：' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || JSON.stringify(r.exceptionDetails)));
    return r.result && r.result.value;
  }
  close() { try { this.ws.close(); } catch (_) { /* ignore */ } }
}

(async () => {
  if (!EXE || !fs.existsSync(EXE)) { console.log('  ✗ 找不到 EXE：' + EXE); process.exit(2); }
  const st = fs.statSync(EXE);
  console.log('  目标 = ' + LABEL);
  console.log('  路径 = ' + EXE + '（' + (st.size / 1048576).toFixed(1) + ' MB，' + st.mtime.toISOString() + '）');

  const cdpPort = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-exe-data-'));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-exe-userdata-'));
  console.log('  CDP 端口 = ' + cdpPort + '（自选空闲）');

  const child = spawn(EXE, [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDir}`], {
    env: Object.assign({}, process.env, { WW_DATA_DIR: dataDir }),
    cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
  });
  let err = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', (c) => { err += c.toString(); });

  let target = null;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const list = await getJson(`http://127.0.0.1:${cdpPort}/json/list`);
      const pages = (list || []).filter((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+/.test(t.url || ''));
      if (pages.length) { target = pages[0]; break; }
    } catch (_) { /* 还没起来（便携包要先自解压） */ }
    await sleep(500);
  }
  if (!target) {
    bad('打包产物渲染进程可被 CDP 发现', '90s 内没找到本机服务页面；stderr 末尾：' + err.slice(-400));
    try { child.kill(); } catch (_) {}
    process.exit(1);
  }
  ok('打包产物可运行：渲染进程就绪并被 CDP 发现', target.url);

  const c = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    await c.send('Runtime.enable');
    await c.send('Page.enable');

    const origin = await c.eval('location.origin');
    if (/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) ok('页面连的是本机服务', origin);
    else bad('页面连的是本机服务', String(origin));

    const shape = await c.eval('({ has: typeof window.wwExport, keys: window.wwExport ? Object.keys(window.wwExport) : null, type: window.wwExport ? typeof window.wwExport.exportProfile : null })');
    if (shape.has === 'object') ok('打包产物里 window.wwExport 已注入', 'object');
    else bad('打包产物里 window.wwExport 已注入', String(shape.has));
    if (JSON.stringify(shape.keys) === JSON.stringify(['exportProfile'])) ok('只暴露 exportProfile 一个键', JSON.stringify(shape.keys));
    else bad('只暴露 exportProfile 一个键', JSON.stringify(shape.keys));
    if (shape.type === 'function') ok('exportProfile 是函数', 'function');
    else bad('exportProfile 是函数', String(shape.type));

    const leaks = await c.eval('({ req: typeof window.require, proc: typeof window.process, buf: typeof window.Buffer, ipc: typeof window.ipcRenderer, mod: typeof window.module })');
    const leaked = Object.keys(leaks).filter((k) => leaks[k] !== 'undefined');
    if (!leaked.length) ok('打包产物没有泄漏 Node 能力', JSON.stringify(leaks));
    else bad('打包产物没有泄漏 Node 能力', leaked.join(',') + ' ⇒ ' + JSON.stringify(leaks));

    for (const [label, expr] of [
      ['路径穿越 ../../etc/passwd', "'../../etc/passwd'"],
      ['绝对路径 C:\\\\Windows\\\\win.ini', "'C:\\\\Windows\\\\win.ini'"],
      ['任意 URL https://evil.example/x', "'https://evil.example/x'"],
      ['空串', "''"], ['数字', '12345'], ['null', 'null'],
    ]) {
      const out = await c.eval(`window.wwExport.exportProfile(${expr}).then(r => r).catch(e => ({ __throw: String(e && e.message || e) }))`);
      if (out && out.status === 'failed') ok('非法 profileId 落 failed：' + label, JSON.stringify(out).slice(0, 100));
      else bad('非法 profileId 落 failed：' + label, JSON.stringify(out).slice(0, 150));
    }

    const ghost = '11111111-2222-3333-4444-555555555555';
    const g = await c.eval(`window.wwExport.exportProfile('${ghost}').then(r => r).catch(e => ({ __throw: String(e && e.message || e) }))`);
    if (g && g.status === 'failed') ok('不存在的档案 ⇒ failed（链路真实触网）', JSON.stringify(g).slice(0, 130));
    else bad('不存在的档案 ⇒ failed', JSON.stringify(g).slice(0, 150));

    // ── 导入臂：在**页面内**挂钩，把真实契约合规的包注入 `<input type=file>` 的 change 事件 ──
    // 为什么不用 CDP 的 DOM.setFileInputFiles：openProfileImport() 是**动态创建 input 且从不挂到 DOM**
    // （web/app.js 里 createElement('input') 后直接 .click()），所以 Page.fileChooserOpened 给的
    // backendNodeId 在 DOM 里查不到（实测报 "No node found for given backend id"）。
    // 改为在页面内替换 HTMLInputElement.prototype.click（文件框不弹、留引用）＋ 替换 window.confirm
    // （导入预览用原生 confirm 确认，也是模态的）。**这两个都是测试替身，已在台账如实披露。**
    const pkgPath = process.argv[4];
    if (pkgPath && fs.existsSync(pkgPath)) {
      const pkgText = fs.readFileSync(pkgPath, 'utf8');
      await c.eval(`(() => {
        const orig = HTMLInputElement.prototype.click;
        HTMLInputElement.prototype.click = function () {
          if (this.type === 'file') { window.__wwProbeInput = this; return; }
          return orig.apply(this, arguments);
        };
        window.__wwConfirmCalls = [];
        window.confirm = function (m) { window.__wwConfirmCalls.push(String(m)); return true; };
        // alert 也必须挂钩：导入成功路径最后会 alert('导入完成：…')，原生 alert 会阻塞渲染进程，
        // 导致随后的 Runtime.evaluate 直接超时（实测踩到过一次）。
        window.__wwAlertCalls = [];
        window.alert = function (m) { window.__wwAlertCalls.push(String(m)); };
        return 'hooked';
      })()`);
      ok('已挂测试替身（拦文件框 click ＋ 自动确认 confirm）', '仅作用于本探针启动的临时实例');

      const countProfiles = async () => c.eval(`(async () => {
        try { const r = await fetch('/api/profiles').then(x => x.json());
          if (Array.isArray(r)) return r.length;
          if (r && Array.isArray(r.profiles)) return r.profiles.length;
          return -1; } catch (e) { return -2; }
      })()`);
      const before = await countProfiles();
      const opened = await c.eval('(typeof openProfileImport === "function") ? (openProfileImport(), "opened") : "no-fn"');
      if (opened !== 'opened') bad('能触发导入入口 openProfileImport', String(opened));
      else {
        await sleep(400);
        const injected = await c.eval(`(() => {
          const inp = window.__wwProbeInput;
          if (!inp) return 'no-input';
          const dt = new DataTransfer();
          dt.items.add(new File([${JSON.stringify(pkgText)}], 'probe-package.json', { type: 'application/json' }));
          inp.files = dt.files;
          inp.dispatchEvent(new Event('change'));
          return 'injected';
        })()`);
        if (injected === 'injected') ok('原生文件框被拦下并注入了契约合规的包', path.basename(pkgPath) + '（' + (fs.statSync(pkgPath).size / 1024).toFixed(1) + ' KB）');
        else bad('注入包到 input.files', String(injected));
        await sleep(3000);
        const after = await countProfiles();
        const confirms = await c.eval('window.__wwConfirmCalls');
        const alerts = await c.eval('window.__wwAlertCalls');
        if (typeof before === 'number' && typeof after === 'number' && after > before) {
          ok('导入在打包 EXE 上生效：档案数 ' + before + ' → ' + after,
            '预览首行=' + String((confirms && confirms[0]) || '').split('\n')[0]
            + ' ｜ 结果提示=' + String((alerts && alerts[0]) || '').split('\n').join(' ').slice(0, 90));
        } else {
          bad('导入在打包 EXE 上生效：档案数未增加',
            'before=' + before + ' after=' + after + ' confirm=' + JSON.stringify(confirms) + ' alert=' + JSON.stringify(alerts));
        }
      }
    } else {
      console.log('  · 未提供真实包路径 ⇒ 跳过"注入包并导入"这一段');
    }

    const page = await c.eval('({ title: document.title, ready: document.readyState })');
    ok('打包产物渲染出应用外壳', JSON.stringify(page));
  } finally {
    c.close();
    try { child.kill(); } catch (_) {}
    await sleep(1200);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
  // guidance :197 要求把"没做的事"摆明，而不是让读者以为 EXE 列已被完整关闭：
  // 原生保存对话框那一步必须有真人，本脚本刻意绕开了它（只用非法 profileId）。
  console.log('  · 未覆盖（guidance :197）：原生"保存导出文件 → 选回刚保存的文件 → 导入" —— 需真人；');
  console.log('    对话框替身与合成导入包都不能关闭该项；本脚本通过仅代表"EXE 能起来且运行时断言成立"。');
  }

  const pass = results.filter(Boolean).length;
  const fail = results.length - pass;
  console.log(`\n  [${LABEL}] 读数：PASS ${pass} / FAIL ${fail}（共 ${results.length} 条）`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('  !! 探针异常：' + (e && e.stack || e)); process.exit(3); });
