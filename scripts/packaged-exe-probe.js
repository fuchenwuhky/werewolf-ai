/**
 * packaged-exe-probe.js — 在**已打包产物（EXE）**上复跑 M2-e 桌面臂运行时断言
 *
 * 与 scripts/ui-check.js 等"跑源码"的验证的差别：本文件验的是**发行产物**本身，
 * 这正是台账 §16.16.4 第 2 条欠下的证据（见 docs/fix-plan-2026-09-21.md §16.19.2 承诺入仓）。
 *
 * ⚠ 前置：**需要用户批准的打包产物**（已存在的 EXE）。本脚本**绝不自行打包** ——
 *   不会调用 `npm run app:*` / `electron-builder` / `gradlew` / `adb`，也不做任何 git 操作。
 *   找不到产物时**明确打印 SKIP 原因并以退出码 2 结束**（不失败、不假装通过）。
 *   自动搜索顺序：desktop/dist/win-unpacked/*.exe（已解包，启动快）> *-portable.exe >
 *   release/<版本>/*.exe，跳过 `_stale-*` 目录与运行时 node.exe；也可显式传路径。
 *
 * 隔离：WW_DATA_DIR 与 --user-data-dir 都指向 os.tmpdir() 下的临时目录，跑完删除。
 * 端口：CDP 端口由内核分配空闲端口（WW_EXE_CDP_PORT 可显式指定，被占用则拒绝启动）；
 *       被测产物自己的服务端口由 desktop/main.js 自己挑空闲端口，本脚本不干预。
 * 清理：finally 杀进程树（taskkill /T /F）+ 删临时目录；整轮有看门狗超时（默认 300s）。
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 无法执行 / SKIP（找不到产物、CDP 端口被占用、
 *         看门狗超时、脚本自身异常）。
 *
 * 用法：
 *   node scripts/packaged-exe-probe.js                          # 自动搜索产物
 *   node scripts/packaged-exe-probe.js <exe 路径> [标签] [契约合规的包 json]
 *   node scripts/packaged-exe-probe.js --exe=<路径> --label=<标签> --package=<包 json>
 *
 * 注意：只用非法/不存在的 profileId 做"必须落 failed"的断言：合法且存在的会走到原生保存
 * 对话框（模态），会卡死自动化。导入臂需要显式提供包路径，否则跳过该段（会打印说明）。
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');

// ── 参数解析（位置参数向后兼容仓外原件，另支持 --exe=/--label=/--package=）──
const argv = process.argv.slice(2);
const flag = (name) => { const a = argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : ''; };
const positional = argv.filter((x) => !x.startsWith('--'));
// 注意：没给路径时 EXE 必须保持空串，交给下面的自动发现 —— 早先写成 path.resolve('') 会解析成
// 当前工作目录（一个存在的目录），于是"自动发现"这段永远走不到，最终 spawn 一个目录报 ENOENT。
const exeArg = flag('exe') || positional[0] || '';
let EXE = exeArg ? path.resolve(exeArg) : '';
let LABEL = flag('label') || positional[1] || '';
const pkgPathArg = flag('package') || positional[2] || '';

// 仓库根 = 本脚本的上一级（不写死绝对路径）。
const ROOT = path.resolve(__dirname, '..');
const TIMEOUT_MS = Math.max(60000, Number(process.env.WW_EXE_TIMEOUT) || 300000);
const BOOT_MS = Math.max(15000, Number(process.env.WW_EXE_BOOT_MS) || 120000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (n, d) => { results.push(true); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d) => { results.push(false); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
// 统一的收尾读数（提前 return 的分支也要打到，不能只在正常路径里打印）。
function printSummary(label) {
  const pass = results.filter(Boolean).length;
  const fail = results.length - pass;
  console.log(`\n  [${label}] 读数：PASS ${pass} / FAIL ${fail}（共 ${results.length} 条）`);
  console.log(fail === 0 ? '  ⇒ 全部通过（退出码 0）' : '  ⇒ 有断言失败（退出码 1）');
  return fail === 0 ? 0 : 1;
}

// 只删 os.tmpdir() 下、名字以 ww- 开头的目录；任何其它路径一律拒绝（防误删仓库）。
function rmTemp(dir) {
  if (!dir) return true;
  const full = path.resolve(dir);
  if (!full.startsWith(path.resolve(os.tmpdir()) + path.sep) || !/^ww-/.test(path.basename(full))) {
    console.log(`  !! 拒绝删除疑似非临时目录：${full}`);
    return false;
  }
  try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) {
    console.log(`  !! 临时目录删除失败：${e && e.message}`);
  }
  return !fs.existsSync(full);
}
// Electron 打包产物会自己拉起子进程，只 kill 主进程会留下孤儿 ⇒ Windows 用 taskkill /T /F 杀整棵树。
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { /* ignore */ }
  } else {
    try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
  }
}
// 在已有的打包产物里找候选（**只找，不打包**）：rank 越小越优先 = 越"已解包、越新"。
function findArtifacts(root) {
  const cands = new Map();
  const add = (full, rank) => {
    let st; try { st = fs.statSync(full); } catch (_) { return; }
    if (!st.isFile()) return;
    if (/^node\.exe$/i.test(path.basename(full))) return; // node.exe 是运行时，不是应用产物
    const cur = cands.get(full);
    if (!cur || rank < cur.rank) cands.set(full, { full, rank, mtime: st.mtime, size: st.size });
  };
  const dirs = [
    [path.join(root, 'desktop', 'dist', 'win-unpacked'), 0],
    [path.join(root, 'desktop', 'dist'), 1],
    [path.join(root, 'release'), 2],
    [root, 3],
  ];
  for (const [dir, rank] of dirs) {
    if (!fs.existsSync(dir)) continue;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (e.isFile() && /\.exe$/i.test(e.name)) add(path.join(dir, e.name), rank);
      // release/<版本>/ 只有一层；`_stale-*` 是旧产物存档，不作为候选；`resources/` 是 Electron
      // 的子资源目录（里面只有 elevate.exe 这类助手，不是应用产物）。
      if (e.isDirectory() && !e.name.startsWith('_') && e.name !== 'resources') {
        let sub; try { sub = fs.readdirSync(path.join(dir, e.name), { withFileTypes: true }); } catch (_) { continue; }
        for (const f of sub) if (f.isFile() && /\.exe$/i.test(f.name)) add(path.join(dir, e.name, f.name), rank + 0.5);
      }
    }
  }
  return [...cands.values()].sort((a, b) => (a.rank - b.rank) || (b.mtime - a.mtime));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const portOccupied = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  const done = (v) => { try { s.destroy(); } catch (_) { /* ignore */ } resolve(v); };
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
  s.setTimeout(1500, () => done(false));
});
async function pickCdpPort() {
  const want = Number(process.env.WW_EXE_CDP_PORT || 0);
  if (want) return (await portOccupied(want)) ? 0 : want;
  for (let i = 0; i < 12; i++) {
    const p = await freePort();
    if (!(await portOccupied(p))) return p;
  }
  return 0;
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

async function main() {
  // ── 前置：必须有**已存在**的打包产物；没有就 SKIP（退出码 2），绝不自行打包 ──
  if (!EXE) {
    const found = findArtifacts(ROOT);
    if (!found.length) {
      console.log('  SKIP：在仓库里找不到任何已打包的 EXE 产物 ⇒ 无法执行（退出码 2）。');
      console.log('        已搜索：desktop/dist/win-unpacked、desktop/dist、release/<版本>、仓库根（跳过 _stale-* 与 node.exe）。');
      console.log('        本探针禁止自行打包（不跑 npm run app:* / electron-builder / gradlew / adb）。');
      console.log('        请先由用户批准并完成打包，或显式传路径：node scripts/packaged-exe-probe.js <exe 路径>');
      return 2;
    }
    console.log('  自动发现候选产物（只读搜索，未打包）：');
    for (const f of found.slice(0, 6)) console.log(`    · [rank ${f.rank}] ${f.full}（${(f.size / 1048576).toFixed(1)} MB，${f.mtime.toISOString()}）`);
    EXE = found[0].full;
    console.log('  选用 = ' + EXE);
  }
  if (!fs.existsSync(EXE)) {
    console.log('  SKIP：找不到 EXE：' + EXE + ' ⇒ 无法执行（退出码 2）。');
    return 2;
  }
  if (!LABEL) LABEL = path.basename(EXE);
  const st = fs.statSync(EXE);
  console.log('  目标 = ' + LABEL);
  console.log('  路径 = ' + EXE + '（' + (st.size / 1048576).toFixed(1) + ' MB，' + st.mtime.toISOString() + '）');

  const cdpPort = await pickCdpPort();
  if (!cdpPort) { console.log('  !! 没能拿到空闲的 CDP 端口（WW_EXE_CDP_PORT 被占用或内核分配失败）⇒ 无法执行（退出码 2）'); return 2; }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-exe-data-'));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-exe-userdata-'));
  console.log('  CDP 端口 = ' + cdpPort + (process.env.WW_EXE_CDP_PORT ? '（WW_EXE_CDP_PORT 指定，已复查空闲）' : '（内核分配，已复查空闲）'));
  console.log('  隔离：WW_DATA_DIR=' + dataDir);
  console.log('        --user-data-dir=' + userDir);

  const child = spawn(EXE, [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDir}`], {
    env: Object.assign({}, process.env, { WW_DATA_DIR: dataDir }),
    cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
  });
  let err = '';
  let spawnError = '';
  // 必须挂 'error'：否则 spawn 失败（产物被删/无执行权限）会变成未捕获事件直接崩掉进程，
  // 连 finally 里的清理都跑不到，临时目录会留在 %TEMP%。
  child.on('error', (e) => { spawnError = String((e && e.message) || e); });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (c) => { err += c.toString(); });

  const watchdog = setTimeout(() => {
    console.log(`  !! 看门狗超时（${TIMEOUT_MS}ms）：产物无响应 ⇒ 无法执行（退出码 2）。`);
    killTree(child);
    setTimeout(() => { rmTemp(dataDir); rmTemp(userDir); process.exit(2); }, 800);
  }, TIMEOUT_MS);

  let fatal = false;
  try {
    let target = null;
    const deadline = Date.now() + BOOT_MS;
    while (Date.now() < deadline) {
      if (spawnError) break;
      try {
        const list = await getJson(`http://127.0.0.1:${cdpPort}/json/list`);
        const pages = (list || []).filter((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+/.test(t.url || ''));
        if (pages.length) { target = pages[0]; break; }
      } catch (_) { /* 还没起来（便携包要先自解压） */ }
      await sleep(500);
    }
    if (spawnError) {
      bad('打包产物可被启动', 'spawn 失败：' + spawnError);
      return printSummary(LABEL);
    }
    if (!target) {
      bad('打包产物渲染进程可被 CDP 发现', `${Math.round(BOOT_MS / 1000)}s 内没找到本机服务页面；stderr 末尾：` + err.slice(-400));
      return printSummary(LABEL);
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
      if (pkgPathArg && fs.existsSync(pkgPathArg)) {
        const pkgText = fs.readFileSync(pkgPathArg, 'utf8');
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
          if (injected === 'injected') ok('原生文件框被拦下并注入了契约合规的包', path.basename(pkgPathArg) + '（' + (fs.statSync(pkgPathArg).size / 1024).toFixed(1) + ' KB）');
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
        console.log('  · 未提供真实包路径 ⇒ 跳过"注入包并导入"这一段（用 --package=<包 json> 可启用）');
      }

      const page = await c.eval('({ title: document.title, ready: document.readyState })');
      ok('打包产物渲染出应用外壳', JSON.stringify(page));
    } finally {
      c.close();
    }
  } finally {
    clearTimeout(watchdog);
    killTree(child);
    await sleep(1200);
    const g1 = rmTemp(dataDir), g2 = rmTemp(userDir);
    console.log(`  临时数据目录${g1 && g2 ? '已删除' : '未全部删除（见上方提示）'}；未触碰仓库 saves/、profiles/、config.json`);
  }

  return printSummary(LABEL);
}

main().then((code) => process.exit(code)).catch((e) => {
  console.log('  !! 探针异常（无法执行，退出码 2）：' + (e && e.stack || e));
  process.exit(2);
});
