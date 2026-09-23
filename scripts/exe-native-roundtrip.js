/**
 * exe-native-roundtrip.js — 在**真实打包 EXE** 上，用**真实原生文件对话框**跑通
 * 「保存导出文件 → 再选回刚保存的那个文件 → 导入」闭环（仓内可复跑脚本，零 npm 依赖）。
 *
 * 这是此前被列为「必须真人」的那一项验收，本次由 AI 代真人执行（授权人已授权）。
 *
 * ⚠ 与 scripts/exe-check.js 的关系：那一份刻意绕开原生保存对话框（只用非法/不存在 profileId），
 *   本脚本**只做**它没做的那件事。**不使用**对话框替身，**不使用**合成导入包：
 *   导入的那个文件就是本脚本刚导出的那个文件（喂文件只出现在**明确标注的诊断段**，不计入验收）。
 *
 * 退出码：0 全绿 / 1 有断言失败 / 2 环境不满足（找不到 EXE、EXE 起不来）/ 3 需要人工介入 /
 *   4 点击自检失败（测试未命中，本步不予判定）。「环境不满足」绝不返回 0。
 *
 * 隔离（不碰用户数据）：应用用独立 `--user-data-dir=D:\ww-probe\exe-rt-ud`，服务端数据落在该目录下；
 *   本脚本任何时刻都不读不写仓库根的 `saves/`、`profiles/`、`config.json`。
 *
 * 用法：
 *   node scripts/exe-native-roundtrip.js
 *   node scripts/exe-native-roundtrip.js --exe <路径> --out <日志目录> --user-data-dir <目录>
 *
 * 产物：logs/exe-native/*.log（全程真实读数）、logs/exe-native/*.png（**只截本应用 CDP page target**）
 *
 * ── 方法学教训（每一轮都真实付过代价，逐条留在这里避免重犯）──
 *   ① 点击必须是**真实输入事件**：`element.click()` 不构成用户激活，文件选择器不会弹。
 *   ② 坐标必须取 `getBoundingClientRect()` 的**视口坐标**，点击前 `scrollIntoView` 后**重新取一次**；
 *      v2–v4 误用了文档坐标 (y=1001 > 视口 838)，点在窗口外，还据此下了"没有对话框"的结论 —— 那次结论无效。
 *      现在点击前有**命中自检**（elementFromPoint 必须命中该按钮），不过就判测试失败并停。
 *   ③ 给原生对话框发键盘必须**先确认本应用窗口真的在前台**，否则 {ENTER} 会发给别的应用。
 *   ④ 截图**只截本应用 CDP page target**；禁止整屏/前台窗口截图（会拍到用户桌面其它应用，既无效又泄漏隐私）。
 *   ⑤ 窗口归属只看本应用进程树 / 无主对话框的 owning thread，绝不列出用户其它应用的标题。
 *   ⑥ 清理隔离数据目录必须**显式报告**成功或失败（EPERM 被吞掉会形成假绿）。
 *   ⑦ 制品身份必须记 sha256 + mtime：本仓出现过"测试进行中 dist 被重新打包"，否则读数无法追溯。
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');

// ─────────────────────────────── 参数 ───────────────────────────────
const ROOT = path.resolve(__dirname, '..');
function argOf(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const EXE = path.resolve(argOf('exe', path.join(ROOT, 'desktop', 'dist', 'win-unpacked', 'werewolf-ai-desktop.exe')));
const LOG_DIR = path.resolve(argOf('out', path.join(ROOT, 'logs', 'exe-native')));
const USER_DATA_DIR = path.resolve(argOf('user-data-dir', 'D:\\ww-probe\\exe-rt-ud'));
const HELPER_DIR = path.resolve(argOf('helper-dir', 'D:\\ww-probe\\exe-rt'));
const HELPER_PS1 = path.join(HELPER_DIR, 'win-probe.ps1');
const SAVE_DIR = path.resolve(argOf('save-dir', 'D:\\ww-probe\\exe-rt-out'));
const DL_DIR = path.resolve(argOf('download-dir', path.join(HELPER_DIR, 'downloads')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let LOG_FILE = '';
const lines = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  lines.push(line);
  console.log(line);
  try { fs.appendFileSync(LOG_FILE || path.join(LOG_DIR, 'session.log'), line + '\n'); } catch (_) { /* 日志写不进去不能挡住测试 */ }
}
const results = [];
function ok(name, detail) { results.push({ pass: true, name, detail }); log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
function bad(name, detail) { results.push({ pass: false, name, detail }); log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
function warn(name, detail) { results.push({ pass: false, name, detail, warnOnly: true }); log(`  WARN  ${name}${detail ? ' — ' + detail : ''}`); }
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));

// 收尾必须**一定**跑到（哪怕中途抛异常）：否则应用会留在用户桌面上、隔离目录也不会被删。
let CHILD = null;
let CDP = null;
let EXE_ID0 = null;

// ─────────────────────────────── 基础工具 ───────────────────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 8000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('非 JSON：' + d.slice(0, 200))); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('HTTP 超时 ' + url)));
  });
}
function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function sizeOf(p) { try { return fs.statSync(p).size; } catch (_) { return -1; } }

/** Windows 侧辅助脚本（PowerShell 5.1）。返回 { code, out, err }，不抛。 */
function ps(...args) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PS1, ...args],
    { encoding: 'buffer', windowsHide: true, timeout: 30000 });
  const dec = (b) => (b ? b.toString('utf8') : '');
  return { code: r.status, out: dec(r.stdout).trim(), err: dec(r.stderr).trim() };
}

// ─────────────── 窗口观测（**只观测被测应用自己的窗口**） ───────────────
let APP_PIDS = new Set();
/**
 * 被测应用进程集合 = EXE 主进程 PID 的全部后代（Electron 的窗口/对话框都挂在这个树里）。
 * ⚠ 绝不能传 0/null 来"刷新"：此前收尾时用子 PID 再刷新，把集合收窄成主进程一个 PID，
 * 而**窗口属于另一个子进程**，于是过滤出空列表、原生对话框检测全线失效 ——
 * "过滤器把证据滤没了"的假阴性比不检测更糟。根 PID 缺失时保持原集合不动。
 */
function refreshAppPids(rootPid) {
  if (!rootPid || rootPid <= 0) return { error: 'rootPid 缺失，保持既有进程集合', pids: [...APP_PIDS] };
  const r = ps('procs');
  if (r.code !== 0) { APP_PIDS = new Set([rootPid]); return { error: r.err, pids: [...APP_PIDS] }; }
  const rows = r.out.split(/\r?\n/).filter(Boolean).map((l) => {
    const [pid, ppid, name] = l.split('|');
    return { pid: Number(pid), ppid: Number(ppid), name };
  });
  const kids = new Map();
  for (const x of rows) { if (!kids.has(x.ppid)) kids.set(x.ppid, []); kids.get(x.ppid).push(x); }
  const pids = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const cur = queue.shift();
    for (const k of kids.get(cur) || []) { if (!pids.has(k.pid)) { pids.add(k.pid); queue.push(k.pid); } }
  }
  APP_PIDS = pids;
  return { pids: [...pids], names: rows.filter((x) => pids.has(x.pid)).map((x) => `${x.pid}:${x.name}`) };
}
/** 进程集合偏小时用进程名兜底补齐（只影响观测能力，不影响任何判据） */
function ensureAppPids(rootPid) {
  if (APP_PIDS.size > 1) return { kept: [...APP_PIDS] };
  const again = refreshAppPids(rootPid);
  const r = ps('procs');
  const rows = r.out.split(/\r?\n/).filter(Boolean).map((l) => l.split('|'));
  const mine = rows.filter((x) => /werewolf-ai-desktop\.exe/i.test(x[2] || '')).map((x) => Number(x[0]));
  if (mine.length > APP_PIDS.size) {
    const kids = new Map();
    for (const x of rows) { const pp = Number(x[1]); if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(Number(x[0])); }
    const set = new Set(mine);
    const q = [...mine];
    while (q.length) { const cur = q.shift(); for (const k of kids.get(cur) || []) { if (!set.has(k)) { set.add(k); q.push(k); } } }
    APP_PIDS = set;
    return { fallbackByName: mine, set: [...set] };
  }
  return { retried: again.names || again, set: [...APP_PIDS] };
}
/**
 * 可见顶层窗口。行格式：hwnd|pid|thread=<owningThreadId>|WxH@x,y|<title>（title 放最后，可含 '|'）
 * appOnly=true 时 PowerShell 侧就按 PID 白名单过滤 ⇒ 用户桌面上其它应用的标题**根本不会进入日志**。
 */
function listWindows({ appOnly = true, qualify = null } = {}) {
  const r = ps('list-windows', appOnly ? [...APP_PIDS].join(',') : '');
  if (r.code !== 0) return { error: r.err || ('exit ' + r.code), windows: [] };
  const windows = r.out.split(/\r?\n/).filter(Boolean).map((l) => {
    const parts = l.split('|');
    const hwnd = Number(parts[0]);
    const pid = Number(parts[1]);
    const thread = Number((parts[2] || '').replace(/^thread=/, '')) || null;
    const geo = parts[3] || '';
    const title = parts.slice(4).join('|');
    return { hwnd, pid, thread, geo, app: APP_PIDS.has(pid), title };
  });
  return { error: null, windows: qualify ? windows.filter(qualify) : windows };
}
/** 本应用所有窗口的 owning thread 集合（无主系统对话框 pid=0 时靠它判归属）；带短缓存避免密集轮询时反复起 PowerShell */
let _threadCache = { at: 0, set: new Set() };
function appThreads() {
  if (Date.now() - _threadCache.at < 3000) return _threadCache.set;
  const { windows } = listWindows({ appOnly: true });
  const set = new Set(windows.filter((w) => APP_PIDS.has(w.pid)).map((w) => w.thread).filter(Boolean));
  _threadCache = { at: Date.now(), set };
  return set;
}
/**
 * 窗口是否属于"本应用会话"：① pid 在本应用进程树里；或 ② 无主系统对话框（pid=0）但 owning thread
 * 属于本应用。两条都不满足的（用户桌面上别的应用）一律不计入。
 */
function qualifyAppWindow(w) {
  if (APP_PIDS.has(w.pid)) return true;
  if (w.pid === 0 && w.thread && appThreads().has(w.thread)) return true;
  return false;
}
function findAppWindow(re, qualifyExtra = null) {
  const { windows } = listWindows({ appOnly: true, qualify: (w) => qualifyAppWindow(w) && (!qualifyExtra || qualifyExtra(w)) });
  return windows.find((w) => re.test(w.title)) || null;
}
function bringToFront(re) { return ps('bring-to-front', re, [...APP_PIDS].join(',')); }

/**
 * **原生动态对话框探测**（本脚本唯一靠得住的"对话框出现了吗"判据）。
 *
 * 为什么不能用 PID 过滤：实测 Windows 通用文件对话框（class=#32770，标题"打开"/"另存为"）是由
 * **另一个进程**承载的（COM 代理/宿进程，pid 既不在被测应用进程树里、也不是 0）。
 * 早期版本按 PID 白名单过滤窗口，于是对话框被整体滤掉，得出了"点导入不弹选择器"的**错误结论** ——
 * 那是量具的盲区，不是产品缺陷。`GetLastActivePopup` 走的是 owner 关系，与承载进程是谁无关。
 * 这里仍只输出**被测应用顶层窗口的 popup**，所以不会把用户桌面上别的应用的窗口写进日志。
 */
function appPopups() {
  const r = ps('popups', [...APP_PIDS].join(','));
  if (r.code !== 0) return { error: r.err || ('exit ' + r.code), popups: [] };
  const popups = r.out.split(/\r?\n/).filter(Boolean).map((l) => {
    const g = (k) => (l.match(new RegExp(k + "=('[^']*'|\\S+)")) || [])[1];
    const unq = (v) => (v || '').replace(/^'|'$/g, '');
    return {
      base: Number(g('base')), basePid: Number(g('basePid')), hwnd: Number(g('popup')), pid: Number(g('popupPid')),
      proc: g('popupProc'), cls: g('class'), isBase: g('isBase') === 'True', geo: g('geo'), title: unq(g('title')),
    };
  });
  return { error: null, popups };
}
/** 真正弹出来的原生对话框（popup != 主窗口本身），标题/类名都记下来 */
function appDialogs() {
  const { popups } = appPopups();
  return popups.filter((p) => !p.isBase);
}
/** 密集轮询抓原生对话框；命中的同时把"它属于哪个 pid/什么 class"一并留证 */
async function watchAppDialog(re, { ms = 15000, label = '' } = {}) {
  const t0 = Date.now();
  const seen = [];
  while (Date.now() - t0 < ms) {
    for (const d of appDialogs()) {
      if (!seen.some((x) => x.hwnd === d.hwnd)) { seen.push(d); log(`[watchAppDialog ${label}] +${Date.now() - t0}ms 出现原生对话框：title=${JSON.stringify(d.title)} class=${d.cls} pid=${d.pid}（proc=${d.proc}）hwnd=${d.hwnd} ${d.geo}`); }
      if (re.test(d.title) || (d.cls === '#32770' && d.title === '')) return { hit: d, seen };
    }
    for (const d of appDialogs()) { if (!seen.some((x) => x.hwnd === d.hwnd)) seen.push(d); }
    await sleep(200);
  }
  return { hit: null, seen };
}

/** 把文本送进原生对话框（真实键盘事件）后回车。foreground=发给当前前台窗口（已确认是本应用） */
function sendKeys(text, { titleRe = null, foreground = false } = {}) {
  const args = foreground ? ['sendkeys-fg', text] : ['sendkeys', text, titleRe ? 'focus:' + titleRe : ''];
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PS1, ...args],
    { encoding: 'buffer', windowsHide: true, timeout: 30000 });
  return { code: r.status, out: (r.stdout || Buffer.alloc(0)).toString('utf8').trim(), err: (r.stderr || Buffer.alloc(0)).toString('utf8').trim() };
}
/**
 * 把文本送进**指定 hwnd 的原生对话框**（真实键盘事件）+ 回车。
 *
 * ⚠ 这是 v9 才修对的关键点：不能"先把主窗口置前再按前台发键" —— 那会把焦点从对话框抢走，
 * 按键全打进主窗口、对话框一个字都没收到（v9 实测：原生"打开"框确实弹出来了，
 * 但 sendkeys-fg 报告的是 `hwnd=主窗口 title='AI 狼人杀'`，于是导入没走到预览）。
 * 现在按对话框自己的 hwnd 置前并**验证前台确实是它**，没验证成功就拒绝盲发。
 */
function sendKeysToHwnd(hwnd, text, { label = '' } = {}) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PS1, 'sendkeys-hwnd', String(hwnd), text],
    { encoding: 'buffer', windowsHide: true, timeout: 40000 });
  const out = { code: r.status, out: (r.stdout || Buffer.alloc(0)).toString('utf8').trim(), err: (r.stderr || Buffer.alloc(0)).toString('utf8').trim() };
  log(`[sendKeysToHwnd ${label}] hwnd=${hwnd} → ${JSON.stringify(out)}`);
  return out;
}
/** 用 SendInput + KEYEVENTF_UNICODE 把文本作为**真实键盘事件**敲给指定窗口。
 *  为什么要这条：本机是 TSF 微软拼音、且没有纯英文键盘布局，走 SendKeys/普通按键会被输入法
 *  合成成汉字（实测 WWkeyprobe1 → WW可鸭脯肉不饿），ImmSetOpenStatus 对 TSF 无效。
 *  UNICODE 注入不经过输入法转换，目标窗口收到的仍是正常 WM_CHAR —— 依然属真实键盘输入。 */
function sendUnicodeToHwnd(hwnd, text, { label = '', altN = false, enter = false } = {}) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PS1, 'send-unicode', String(hwnd), text];
  if (altN) args.push('altn');
  if (enter) args.push('enter');
  const r = spawnSync('powershell.exe', args, { encoding: 'buffer', windowsHide: true, timeout: 60000 });
  const out = { code: r.status, out: (r.stdout || Buffer.alloc(0)).toString('utf8').trim(), err: (r.stderr || Buffer.alloc(0)).toString('utf8').trim() };
  log(`[sendUnicodeToHwnd ${label}] hwnd=${hwnd} altN=${altN} enter=${enter} text=${JSON.stringify(text)} → ${JSON.stringify(out)}`);
  return out;
}
/** 把**文件完整路径**敲进原生文件对话框并回车（真人做法：Alt+N 切到"文件名"框 → 全选 → 路径 → 回车）。
 *  先用英文键盘布局把输入法钉住，再用真实按键 —— 否则中文输入法会把字母合成汉字，路径永远敲不对。 */
function sendKeysPathToHwnd(hwnd, filePath, { label = '' } = {}) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PS1, 'sendkeys-path', String(hwnd), filePath],
    { encoding: 'buffer', windowsHide: true, timeout: 60000 });
  const out = { code: r.status, out: (r.stdout || Buffer.alloc(0)).toString('utf8').trim(), err: (r.stderr || Buffer.alloc(0)).toString('utf8').trim() };
  log(`[sendKeysPathToHwnd ${label}] hwnd=${hwnd} path=${JSON.stringify(filePath)} → ${JSON.stringify(out)}`);
  return out;
}
/** 只置前+验证，不发键（用于确认"对话框真的能拿到前台"） */
function focusHwnd(hwnd) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PS1, 'focus-hwnd', String(hwnd)],
    { encoding: 'buffer', windowsHide: true, timeout: 30000 });
  return { code: r.status, out: (r.stdout || Buffer.alloc(0)).toString('utf8').trim(), err: (r.stderr || Buffer.alloc(0)).toString('utf8').trim() };
}
/**
 * 给**本应用的窗口**发键：先把本应用窗口置前并**验证前台真的变成了它**，再发键。
 * 为什么不直接发给"当前前台窗口"：实测曾把 {ENTER} 发给了别的应用（日志里能看到前台是无关窗口）。
 */
function sendKeysToApp(text, { label = '' } = {}) {
  const fw = bringToFront('狼人杀');
  // ⚠ PowerShell 输出的是 `fronted=True`（首字母大写）；这里必须不区分大小写地判，
  //   否则会把成功置前误判成失败而拒绝发键（v8 就踩过：日志里 fronted=True 却报了"未确认成功"）。
  if (!/fronted=[Tt]rue/.test(fw.out || '')) {
    log(`[sendKeysToApp ${label}] 置前**未确认成功** ⇒ 拒绝盲发按键（避免把按键发给别的应用）：${JSON.stringify(fw)}`);
    return { code: -1, out: fw.out, err: 'front-not-confirmed', skipped: true };
  }
  const r = sendKeys(text, { foreground: true });
  log(`[sendKeysToApp ${label}] 置前确认 → ${fw.out}；发键结果=${JSON.stringify(r)}`);
  return r;
}

// ─────────────── 截图（**只截被测应用的 CDP page target**，带帧指纹校验） ───────────────
/** 页面可见文本指纹：状态变了它就该变，用来证明"截图真的拍到了不同的时刻" */
async function fingerprint(c) {
  try {
    return await c.eval(`(() => {
      const modal = document.querySelector('#modal-root h2, #modal-root h3');
      const rows = [...document.querySelectorAll('#modal-root .pm-row')].map((x) => (x.textContent || '').replace(/\\s+/g, ' ').trim());
      const strip = document.querySelector('#profile-strip');
      return {
        visibility: document.visibilityState, hidden: document.hidden,
        modal: modal ? modal.textContent.trim() : null, rows,
        strip: strip ? (strip.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) : null,
        body: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400),
      };
    })()`);
  } catch (e) { return { error: String(e.message) }; }
}
async function shot(c, file, { label = '', prevHash = null, attempts = 4 } = {}) {
  await c.send('Page.bringToFront').catch(() => {});
  const fw = bringToFront('狼人杀');
  const fp = await fingerprint(c);
  log(`[shot ${label}] 本应用窗口置前=${fw.out || fw.err}`);
  log(`[shot ${label}] 页面读数：visibility=${fp.visibility} hidden=${fp.hidden} modal=${JSON.stringify(fp.modal)} rows=${JSON.stringify(fp.rows)}`);
  log(`[shot ${label}] body 摘要=${JSON.stringify(fp.body || fp.error)}`);
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    await sleep(1300);
    let data;
    try {
      const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 20000);
      data = Buffer.from(r.data, 'base64');
    } catch (e) { log(`[shot ${label}] 第 ${i} 次截图失败：${e.message}`); continue; }
    fs.writeFileSync(file, data);
    const h = crypto.createHash('sha256').update(data).digest('hex');
    last = { hash: h, bytes: data.length, file, fingerprint: fp };
    log(`[shot ${label}] 第 ${i} 次落盘：${path.basename(file)} ${data.length} 字节 sha256=${h.slice(0, 16)}…`);
    if (!prevHash || h !== prevHash) return { ...last, stale: false };
    log(`[shot ${label}] 与上一张逐字节相同 ⇒ 这一帧没更新，重试（第 ${i}/${attempts} 次）`);
    await c.send('Page.bringToFront').catch(() => {});
    bringToFront('狼人杀');
  }
  return { ...last, stale: true };
}

// ─────────────────────────────── CDP ───────────────────────────────
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    const c = new Cdp(ws);
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      } else if (m.method) { c.events.push(m); }
    });
    return c;
  }
  send(method, params, timeoutMs = 20000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时 ' + method)); } }, timeoutMs);
    });
  }
  async eval(expr, timeoutMs = 20000) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面异常：' + ((d.exception && d.exception.description) || JSON.stringify(d).slice(0, 300)));
    }
    return r.result && r.result.value;
  }
  consoleLog() {
    return this.events.filter((e) => e.method === 'Runtime.consoleAPICalled' || e.method === 'Runtime.exceptionThrown' || e.method === 'Log.entryAdded')
      .map((e) => {
        const p = e.params || {};
        if (e.method === 'Runtime.consoleAPICalled') return `[${p.type}] ` + (p.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' ').slice(0, 300);
        if (e.method === 'Runtime.exceptionThrown') return 'EXCEPTION ' + (((p.exceptionDetails || {}).exception || {}).description || (p.exceptionDetails || {}).text || '').slice(0, 300);
        return 'LOG ' + (((p.entry || {}).text) || '') + ' ' + (((p.entry || {}).url) || '');
      });
  }
  close() { try { this.ws.close(); } catch (_) { /* ignore */ } }
}

// ─────────────── UI 驱动：真实输入事件（**不是** element.click()） ───────────────
// ① 找到按钮并 scrollIntoView，② **重新**取 getBoundingClientRect（视口坐标），
// ③ 用 elementFromPoint 做命中自检，④ 通过 CDP Input 派发真实鼠标按下/抬起。
const FIND_EXPR = (textList, exact) => `(() => {
  const want = ${JSON.stringify(textList)};
  const els = [...document.querySelectorAll('button, a, [role=button]')];
  const cand = els.filter((b) => {
    if (b.disabled) return false;
    if (!b.getClientRects().length) return false;
    const t = (b.textContent || '').replace(/\\s+/g, ' ').trim();
    return ${exact ? 'want.some((w) => t === w)' : 'want.some((w) => t === w || t.includes(w))'};
  });
  const hit = cand[0];
  if (!hit) return { ok: false, all: els.map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 40) };
  try { hit.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
  const r = hit.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
  const at = document.elementFromPoint(cx, cy);
  return { ok: true, id: hit.id || null, x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height),
    inViewport: cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight,
    viewport: { w: innerWidth, h: innerHeight, sx: scrollX, sy: scrollY },
    elementAtPoint: at ? (at.tagName + (at.id ? '#' + at.id : '') + (at.className ? '.' + String(at.className).split(' ')[0] : '')) : null,
    selfCheck: !!(at && (at === hit || hit.contains(at) || at.contains(hit))),
    text: (hit.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) };
})()`;

async function findTarget(c, textList, exact = false) { return c.eval(FIND_EXPR(textList, exact)); }

/**
 * 真实点击。**自检不过就返回 ok:false**，调用方必须据此判测试失败并停止该步 ——
 * 不许再往下跑出一堆"看起来像产品缺陷"的假结论。
 */
async function realClick(c, textList, { exact = false, label = '' } = {}) {
  let target = await findTarget(c, textList, exact);
  if (!target.ok) return { ok: false, why: 'not-found', candidates: target.all };
  await sleep(350); // 等滚动落定，再重取一次坐标
  target = await findTarget(c, textList, exact);
  log(`[realClick ${label}] 目标定位 = 目标=${JSON.stringify(target.text)} id=${target.id} 坐标=(${target.x},${target.y}) 尺寸=${target.w}x${target.h} 视口=${JSON.stringify(target.viewport)} 落在视口内=${target.inViewport}`);
  log(`[realClick ${label}] 命中自检 = elementFromPoint(${target.x},${target.y}) → ${JSON.stringify(target.elementAtPoint)} 命中该按钮或其子节点=${target.selfCheck}`);
  if (!target.inViewport) {
    bad(`点击前自检（${label}）`, `坐标 (${target.x},${target.y}) 超出视口 ${JSON.stringify(target.viewport)} ⇒ 鼠标事件会落在窗口外；本步判为测试失败、不再往下跑`);
    return { ok: false, why: 'out-of-viewport', target };
  }
  if (!target.selfCheck) {
    bad(`点击前自检（${label}）`, `elementFromPoint(${target.x},${target.y}) = ${JSON.stringify(target.elementAtPoint)}，不是该按钮 ⇒ 点击不会命中；本步判为测试失败、不再往下跑`);
    return { ok: false, why: 'hit-test-miss', target };
  }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none', clickCount: 0 }).catch(() => {});
  await sleep(80);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(60);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(200);
  return { ok: true, clicked: target.text, id: target.id, x: target.x, y: target.y, selfCheck: target.selfCheck };
}

/** 按可见文本触发 click（**仅用于不需要用户激活的按钮**；导入/导出必须用 realClick） */
const clickByTextExpr = (textList) => `(() => {
  const want = ${JSON.stringify(textList)};
  const els = [...document.querySelectorAll('button, a, [role=button]')];
  const hit = els.find((b) => {
    if (b.disabled) return false;
    if (!b.getClientRects().length) return false;
    const t = (b.textContent || '').replace(/\\s+/g, ' ').trim();
    return want.some((w) => t === w || t.includes(w));
  });
  if (!hit) return { ok: false, candidates: els.map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 40) };
  hit.click();
  return { ok: true, clicked: (hit.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60), id: hit.id || null };
})()`;

/** 观察（不改行为）：记录页面里出现过的 input[type=file]，含"点击时才创建"的动态 input */
const INSTALL_FILEINPUT_OBSERVER = `(() => {
  if (window.__wwFileInputObs) return 'already';
  window.__wwFileInputLog = [];
  const rec = (node, how) => {
    try {
      if (!node || node.nodeType !== 1) return;
      const list = (node.matches && node.matches('input[type=file]')) ? [node] : [...(node.querySelectorAll ? node.querySelectorAll('input[type=file]') : [])];
      for (const i of list) {
        const q = i.getBoundingClientRect();
        window.__wwFileInputLog.push({ how, accept: i.accept, hidden: !!i.hidden, disabled: !!i.disabled, inDocument: !!i.isConnected, id: i.id || null,
          rect: { x: Math.round(q.x), y: Math.round(q.y), w: Math.round(q.width), h: Math.round(q.height) }, display: getComputedStyle(i).display });
      }
    } catch (_) {}
  };
  window.__wwFileInputObs = new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) rec(n, 'added'); });
  window.__wwFileInputObs.observe(document.documentElement, { childList: true, subtree: true });
  rec(document.body, 'snapshot-before');
  return 'installed';
})()`;
/** 观察（不改行为）：记录处理器是否去 click 了一个 input[type=file]，并留一个诊断用引用 */
const INSTALL_INPUT_CLICK_HOOK = `(() => {
  if (window.__wwInputHook) return 'already';
  window.__wwSeenFileInputs = [];
  const orig = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    try {
      if (this.type === 'file') {
        window.__wwLastFileInput = this;
        window.__wwSeenFileInputs.push({ accept: this.accept, hidden: !!this.hidden, disabled: !!this.disabled, inDocument: !!this.isConnected, id: this.id || null });
      }
    } catch (_) {}
    return orig.apply(this, arguments); // 真实 click 照旧执行
  };
  window.__wwInputHook = true;
  return 'hooked';
})()`;

const PROFILES_JS = `(async () => {
  try {
    const r = await fetch('/api/profiles', { cache: 'no-store' }).then((x) => x.json());
    const rows = Array.isArray(r) ? r : (r.profiles || []);
    return { ok: true, rows };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
})()`;

/**
 * JS 原生对话框（confirm/alert）观测与应答。
 * 注意：JS 对话框会**阻塞渲染进程**，期间任何 Runtime.evaluate 都会超时 —— 必须先应答再继续。
 * 首选真实键盘回车（真人做法，按**对话框自己的 hwnd** 置前）；只有真实回车后渲染进程**仍被阻塞**时，
 * 才退回 CDP 的 Page.handleJavaScriptDialog，且退回这件事会显式写进日志
 * （它属于"代替真人点确定"，不是文件选择器那类必须真人的动作）。
 */
let _jsAnswered = 0;
function jsDialogs(c) {
  return c.events.filter((e) => e.method === 'Page.javascriptDialogOpening').map((e) => e.params);
}
/** 尚未应答的那个 JS 对话框（已应答过的不再返回，否则 wait 会立刻误命中） */
function pendingJsDialog(c) {
  const d = jsDialogs(c);
  return d.length > _jsAnswered ? d[d.length - 1] : null;
}
async function waitJsDialog(c, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const d = pendingJsDialog(c);
    if (d) return d;
    await sleep(200);
  }
  return null;
}
/** 渲染进程是否仍被原生对话框阻塞（一个最短的 evaluate 探针） */
async function rendererBlocked(c) {
  try { await c.send('Runtime.evaluate', { expression: '1', returnByValue: true }, 3500); return false; }
  catch (_) { return true; }
}
async function answerJsDialog(c, { label = '' } = {}) {
  const last = pendingJsDialog(c);
  if (!last) { log(`[answerJsDialog ${label}] 当前没有待应答的 JS 原生对话框`); return { answered: false }; }
  log(`[answerJsDialog ${label}] 检测到 JS 原生对话框：type=${last.type} message=${JSON.stringify((last.message || '').slice(0, 200))}（这是**应用自己的** confirm/alert，不是文件选择器）`);
  const dlgWin = appDialogs().find((d) => d.cls === '#32770');
  let how = null;
  if (dlgWin) {
    // 真人做法：直接点这个原生对话框上的"确定/OK"按钮（真实鼠标），比盲发回车更贴近"人点确定"。
    const kids = ps('dialog-children', String(dlgWin.hwnd)).out;
    const okBtn = (kids.split('\n').find((l) => /class=Button/.test(l) && /vis=True|vis=True/.test(l) && /确定|OK/.test(l)) || '').match(/hwnd=(\d+)/);
    log(`[answerJsDialog ${label}] 对话框 hwnd=${dlgWin.hwnd} title="${dlgWin.title}"；按钮清单=${JSON.stringify(kids.split('\n').filter((l) => /class=Button/.test(l)).slice(0, 4))}`);
    if (okBtn) {
      const click = ps('click-hwnd', okBtn[1]);
      log(`[answerJsDialog ${label}] 真实鼠标点击"确定"按钮 = ${JSON.stringify(click.out)}`);
      await sleep(1000);
      if (!(await rendererBlocked(c))) how = 'real-mouse-click-ok-button';
    }
    if (!how) {
      const k = sendKeysToHwnd(dlgWin.hwnd, '{ENTER}', { label: label + '-真实回车' });
      if (/sent-to-hwnd/.test(k.out || '')) how = 'real-enter-to-dialog-hwnd';
      else log(`[answerJsDialog ${label}] 对话框置前未确认成功（${k.out || k.err}）⇒ 不盲发按键`);
    }
  } else {
    log(`[answerJsDialog ${label}] 没探测到 #32770 对话框窗口句柄 ⇒ 无法用真实键盘应答`);
  }
  await sleep(1200);
  const blocked = await rendererBlocked(c);
  if (!blocked) {
    _jsAnswered++;
    log(`[answerJsDialog ${label}] 应答方式=${how || 'unknown'}；复核：渲染进程已解除阻塞 ✅`);
    return { answered: true, how, dialog: last, blockedAfter: false };
  }
  log(`[answerJsDialog ${label}] 真实键盘应答后渲染进程**仍被阻塞** ⇒ 退回 CDP Page.handleJavaScriptDialog（**代替真人点确定**，已在日志区分）`);
  try {
    await c.send('Page.handleJavaScriptDialog', { accept: true });
    await sleep(1200);
    _jsAnswered++;
    const b2 = await rendererBlocked(c);
    log(`[answerJsDialog ${label}] CDP 应答后渲染进程仍被阻塞 = ${b2}`);
    return { answered: true, how: 'cdp-fallback', dialog: last, blockedAfter: b2 };
  } catch (e) { log(`[answerJsDialog ${label}] CDP 应答也失败：${e.message}`); return { answered: false, dialog: last, error: e.message }; }
}

/** 真实键盘能不能送进应用页面？——**先证明输入通道是好的**，再去判断对话框那边的问题。
 *  做法：打开"新建档案"表单 → 真实鼠标点昵称输入框 → 用与操作对话框**同一套**发键函数敲一串字符 →
 *  用 CDP 读回输入框的值 → 点"取消"丢弃（不留痕）。这样后面"对话框收不到键盘"的结论才有分量。 */
async function keyboardDeliverySelfCheck(c) {
  const main = findAppWindow(/狼人杀/);
  if (!main) return { ok: false, why: '找不到应用主窗口' };
  log('输入通道自检：打开"新建档案"表单，用真实鼠标点昵称输入框，再用与操作对话框同一套函数敲字');
  await c.eval(clickByTextExpr(['＋ 新建档案', '新建档案']));
  await sleep(800);
  const box = await c.eval(`(() => { const n = document.getElementById('profile-form-nick'); if (!n) return { ok: false }; n.scrollIntoView({ block: 'center' }); const r = n.getBoundingClientRect(); return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  if (!box.ok) return { ok: false, why: '昵称输入框不在页面上' };
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(60);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(400);
  const active = await c.eval('document.activeElement ? (document.activeElement.tagName + "#" + (document.activeElement.id || "")) : null');
  const probe = 'WWkeyprobe1';
  const sent = sendKeysToHwnd(main.hwnd, probe, { label: '输入通道自检' });
  await sleep(700);
  const got = await c.eval('(() => { const n = document.getElementById("profile-form-nick"); return n ? n.value : null; })()');
  // 收尾：点"取消"丢弃这份草稿（不留痕）。必须确认表单真的关了 —— 上一轮就是它没关，
  // 导致后面"导出当前档案"按钮不在页面上、导出点击落空（测量被自己的残留 UI 破坏了）。
  let closedForm = false;
  for (let i = 0; i < 6 && !closedForm; i++) {
    // 只点表单自己的"取消"，**不发 Escape** —— Escape 会把整个「玩家档案」弹层一起关掉，
    // 而"导出当前档案"按钮就在那个弹层里，弹层一关按钮就消失，导出点击必然落空（实测踩过）。
    await c.eval(clickByTextExpr(['取消']));
    await sleep(700);
    closedForm = !(await c.eval('!!document.getElementById("profile-form-nick")'));
  }
  return { ok: got === probe, mainHwnd: main.hwnd, activeField: active, sent: sent.out, typed: probe, readBack: got, formClosed: closedForm };
}

/** 打开「玩家档案」弹层（真人路径：入口按钮 → 弹层） */
async function openPlayerCenter(c) {
  const r = await c.eval(`(() => {
    const direct = document.querySelector('#btn-profile-manage');
    if (direct && direct.getClientRects().length) { direct.click(); return { via: 'sidebar', text: direct.textContent.trim() }; }
    const cands = [...document.querySelectorAll('button, a, [role=button]')].filter((b) => /我的|玩家档案|档案/.test(b.textContent || '') && b.getClientRects().length);
    if (cands.length) { cands[0].click(); return { via: 'text:' + cands[0].textContent.trim() }; }
    return { via: null };
  })()`);
  await sleep(900);
  const titled = await c.eval(`(() => { const h = document.querySelector('#modal-root h2, #modal-root h3'); return h ? h.textContent.trim() : null; })()`);
  return { ...r, modalTitle: titled };
}

// ─────────────────────────────── 主流程 ───────────────────────────────
(async () => {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  fs.mkdirSync(DL_DIR, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  LOG_FILE = path.join(LOG_DIR, `roundtrip-${runId}.log`);
  fs.writeFileSync(LOG_FILE, '');
  log('=== EXE 原生对话框 导出→导入 往返（AI 代真人执行） ===');
  log('参数：EXE=' + EXE);
  log('      LOG_DIR=' + LOG_DIR);
  log('      USER_DATA_DIR=' + USER_DATA_DIR);
  log('      SAVE_DIR(导出目标)=' + SAVE_DIR);
  log('      DL_DIR(下载回落目录)=' + DL_DIR);
  // ══════════ 方法学前言（每一轮都必须打印，供结论引用）══════════
  log('');
  log('【方法学前言·必读】');
  log('① **这次点击真的命中了**。本脚本用 CDP Input.dispatchMouseEvent 派发真实鼠标事件，');
  log('   并在点之前先 scrollIntoView + 重取 getBoundingClientRect + elementFromPoint 命中自检；');
  log('   自检不过就判 FAIL 并让退出码=4（点击未命中），绝不把"没点到"当成"应用没反应"。');
  log('   ⇒ 这条读数**作废了 v2–v4 的"点了没反应/没有对话框"结论**：那几轮里导出按钮的文档坐标 y=981');
  log('     超出了 838 的视口高度，elementFromPoint(514,1001) 返回 null，也就是**根本没点到按钮**。');
  log('     那是**测试没命中**，不是产品没反应 —— 凡引用 v2–v4 的"没有对话框"，必须先看这一条。');
  log('② 同理，v2–v4 还踩过另一个**测量盲区**：当时只用"按进程树 PID 过滤的顶层窗口枚举"找对话框，');
  log('   而 Windows 的通用文件对话框（class=#32770）是**由另一个 broker 进程承载**的（实测 pid 与主进程不同、');
  log('   也不在主进程树里），因此枚举结果恒为空。改用"主窗口 GetLastActivePopup（owner 关系）"之后，');
  log('   「打开」「导出档案」两个原生对话框都稳定可观测。⇒ "应用不弹选择器"这个说法**不成立**，不得再复述。');
  log('③ v1–v4 那几轮的结论**只针对 09-22 那个陈旧构建**（release/ 里的 Windows 包与当时源码在 30 处不一致：');
  log('   src/api.js、src/profiles/avatar.js、src/profiles/store.js、web/app.js 均为旧版，SKIN-00/01/02 的 17 个');
  log('   卡框资源整体缺失）。本脚本每次运行都会在开头/结尾各记一次 EXE 的 path+size+mtime+sha256，');
  log('   因此每一轮结论都能追溯到具体制品。**最终结论以本轮这个新构建为准**。');
  log('④ 输入法坑（本机特有，影响"把路径敲进对话框"的可行性）：本机是 TSF 微软拼音且默认中文态，');
  log('   任何按字母键的动作都会被合成成汉字（实测 WWkeyprobe1 → WW可鸭脯肉不饿），');
  log('   导致路径永远敲不对。脚本在敲字前用 PostMessage(WM_INPUTLANGCHANGEREQUEST, 00000409) 把输入语言钉成英文；');
  log('   另外还踩过系统浮出层"快速设置"(ControlCenterWindow) 卡住前台，此时 SetForegroundWindow/AttachThreadInput');
  log('   全部无效，兜底手段是**真实鼠标点击目标窗口标题栏**。');
  log('⑤ 若键盘实在送不进原生对话框，脚本会启用**消息级兜底**并把"选文件所使用的输入方式"如实写进日志；');
  log('   绝不把兜底当成"用真实键盘/真实选择器完成"来记账。');
  log('');

  // ── 0. 环境 ──
  if (!fs.existsSync(EXE)) { bad('找到 EXE', EXE); log('退出码 2（环境不满足）'); process.exit(2); }
  if (!fs.existsSync(HELPER_PS1)) { bad('找到 Windows 辅助脚本', HELPER_PS1); process.exit(2); }
  const st = fs.statSync(EXE);
  ok('找到 EXE', `${EXE}（${(st.size / 1048576).toFixed(1)} MB，${st.mtime.toISOString()}）`);
  // 制品身份必须钉住：本仓出现过"测试进行中 dist 被重新打包"，否则每轮读数无法追溯到具体二进制
  const exeId0 = { path: EXE, size: st.size, mtime: st.mtime.toISOString(), sha256: sha256File(EXE) };
  EXE_ID0 = exeId0;
  log('制品身份（启动前）= ' + JSON.stringify(exeId0));

  // 只清自己那个隔离数据目录（不碰仓库根 saves/profiles/config.json）
  try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); log('已清空隔离数据目录（上一轮残留）：' + USER_DATA_DIR); }
  catch (e) { warn('清理上次的隔离数据目录失败', String(e.message)); }
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  // ── 1. 启动 EXE（独立 user-data-dir + 动态 CDP 端口）──
  // 三个反后台化开关：窗口被判遮挡/后台化时 Chromium 会停帧，Page.captureScreenshot 会一直返回陈旧帧
  const cdpPort = await freePort();
  const launchArgs = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
  ];
  log('CDP 端口 = ' + cdpPort + '（自选空闲）；启动参数 = ' + JSON.stringify(launchArgs));
  const child = spawn(EXE, launchArgs, { cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  CHILD = child;
  let childErr = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', (c) => { childErr += c.toString(); });
  log('已启动 PID=' + child.pid);
  const pidInfo = refreshAppPids(child.pid);
  log('本应用进程树（用于窗口过滤）= ' + JSON.stringify(pidInfo.names || pidInfo));

  let target = null;
  const deadline = Date.now() + 120000;
  let lastProbeErr = '';
  while (Date.now() < deadline) {
    try {
      const list = await getJson(`http://127.0.0.1:${cdpPort}/json/list`);
      const pages = (list || []).filter((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+/.test(t.url || ''));
      if (pages.length) { target = pages[0]; break; }
    } catch (e) { lastProbeErr = String(e.message); }
    if (child.exitCode !== null) break;
    await sleep(500);
  }
  if (!target) {
    bad('EXE 启动且渲染进程可被 CDP 发现', `120s 内没有本机服务页面；child.exitCode=${child.exitCode}；stderr 末尾=${childErr.slice(-400)}；最后探测错误=${lastProbeErr}`);
    try { child.kill(); } catch (_) {}
    log('退出码 2（环境不满足）');
    process.exit(2);
  }
  ok('EXE 启动且渲染进程可被 CDP 发现', target.url);
  const c = await Cdp.connect(target.webSocketDebuggerUrl);
  CDP = c;
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('DOM.enable').catch(() => {});
  await c.send('Log.enable').catch(() => {});
  await c.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR, eventsEnabled: true }).catch(() => {});

  // 等在应用外壳上：readyState=complete + __wwReady=true + 档案列表非空
  {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < 90000) {
      last = await c.eval(`(async () => {
        const st = { title: document.title, ready: document.readyState, ww: !!window.__wwReady, modal: !!document.getElementById('modal-root') };
        try { const r = await fetch('/api/profiles', { cache: 'no-store' }).then((x) => x.json()); st.profiles = (Array.isArray(r) ? r : (r.profiles || [])).length; }
        catch (e) { st.profiles = -1; }
        return st;
      })()`).catch((e) => ({ err: String(e.message) }));
      if (last && last.ready === 'complete' && last.ww && last.modal && last.profiles >= 1) { log('页面就绪：' + JSON.stringify(last)); break; }
      await sleep(500);
    }
    log('就绪探测最后一次读数：' + JSON.stringify(last));
  }
  await c.eval('loadProfiles()').catch((e) => log('loadProfiles() 失败：' + e.message));
  await sleep(1500);

  // ── 2. 隔离与身份核对 ──
  const origin = await c.eval('location.origin');
  const apiInfo = await c.eval(`(async () => { try { return { ok: true, meta: await fetch('/api/meta', { cache: 'no-store' }).then((x) => x.json()) }; } catch (e) { return { ok: false, error: String(e.message) }; } })()`);
  log('页面 origin = ' + origin);
  log('/api/meta 顶层键 = ' + (apiInfo && apiInfo.meta ? Object.keys(apiInfo.meta).join(',') : JSON.stringify(apiInfo)));
  check(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) && !/:3210$/.test(origin), '应用跑在独立端口的本机服务上', origin);
  log('/api/device 读数 = ' + JSON.stringify(await c.eval(`(async () => { try { return await fetch('/api/device', { cache: 'no-store' }).then((x) => x.ok ? x.json() : ('HTTP ' + x.status)); } catch (e) { return String(e.message); } })()`)));

  /** 确保「玩家档案」弹层是开着的（导出/导入按钮都只在弹层里）。
 *  上一轮踩过的坑：自检里按了 Escape，把整个弹层关掉了，于是"导出当前档案"按钮根本不在页面上，
 *  导出点击落空 ⇒ "没出现原生保存框"的读数无效。这里每次动手前先确认弹层就位。 */
async function ensureProfilesModal(c) {
  for (let i = 0; i < 4; i++) {
    const st = await c.eval(`(() => ({
      modal: (document.querySelector('.modal-title, [role=dialog] h2, #pc-title') || {}).textContent || null,
      hasExport: !!document.getElementById('pc-export'),
      hasImport: [...document.querySelectorAll('button,a,[role=button]')].some((b) => /导入档案包/.test(b.textContent || '')),
    }))()`);
    if (st.hasExport || st.hasImport) return { ok: true, attempt: i + 1, ...st };
    log('   弹层不在（读数 ' + JSON.stringify(st) + '）⇒ 重新打开「玩家档案」');
    await c.eval(clickByTextExpr(['管理档案…', '管理档案', '玩家档案']));
    await sleep(1200);
  }
  const finalSt = await c.eval(`(() => ({ hasExport: !!document.getElementById('pc-export') }))()`);
  return { ok: false, ...finalSt };
}

// ── 3. 用真实 UI 建基线档案 ──
  // ⚠ 昵称必须**纯 ASCII**：应用用昵称生成导出文件名（ww-profile-<昵称>-<日期>.json），
  //   而"把文件完整路径敲进原生对话框"只能靠 SendKeys —— SendKeys 打不出中文，
  //   非 ASCII 字符会被输入法吃掉甚至触发系统快捷键（实测把"快速设置"浮出层敲出来，
  //   它卡住前台后所有 SetForegroundWindow 全部失败，整个流程的键盘输入就全打偏了）。
  const stampShort = runId.slice(0, 15);
  const NICK = 'RTbase-' + stampShort.slice(-5);
  const BIO = 'roundtrip-baseline-' + stampShort;
  const pc = await openPlayerCenter(c);
  log('打开玩家档案：' + JSON.stringify(pc));
  check(!!pc.modalTitle && /玩家档案|档案/.test(pc.modalTitle), '玩家档案弹层已打开（真实点击）', String(pc.modalTitle));
  log('点「新建档案」：' + JSON.stringify(await c.eval(clickByTextExpr(['＋ 新建档案', '新建档案']))).slice(0, 300));
  await sleep(700);
  const filled = await c.eval(`(() => {
    const n = document.getElementById('profile-form-nick');
    const b = document.getElementById('profile-form-bio');
    if (!n) return { ok: false, why: 'no-nick-input' };
    n.value = ${JSON.stringify(NICK)}; n.dispatchEvent(new Event('input', { bubbles: true }));
    if (b) { b.value = ${JSON.stringify(BIO)}; b.dispatchEvent(new Event('input', { bubbles: true })); }
    const btn = [...document.querySelectorAll('#modal-root button')].find((x) => /^(创建|保存)$/.test((x.textContent || '').trim()));
    if (!btn) return { ok: false, why: 'no-submit' };
    btn.click();
    return { ok: true, submitted: btn.textContent.trim() };
  })()`);
  log('填表并提交：' + JSON.stringify(filled));
  await sleep(2500);

  let profiles = await c.eval(PROFILES_JS);
  log('创建后 /api/profiles = ' + JSON.stringify(profiles).slice(0, 600));
  if (!profiles.ok || !profiles.rows.length) {
    bad('通过真实 UI 建立基线档案', JSON.stringify(profiles).slice(0, 400));
    finalize(1, { child, USER_DATA_DIR, EXE, exeId0, c });
  }
  const base = profiles.rows.find((p) => p.nickname === NICK) || profiles.rows[0];
  const baseline = {
    profileId: base.id, nickname: base.nickname, bio: base.bio, avatarId: base.avatarId,
    revision: base.revision, createdAt: base.createdAt, profileCount: profiles.rows.length,
  };
  ok('基线档案已建立（真实 UI 创建）', JSON.stringify(baseline));
  fs.writeFileSync(path.join(LOG_DIR, `baseline-${runId}.json`), JSON.stringify(baseline, null, 2), 'utf8');

  // 输入通道自检（先证明"真实键盘能用"，否则后面"对话框收不到键盘"的结论不成立）
  const kb = await keyboardDeliverySelfCheck(c);
  log('输入通道自检读数 = ' + JSON.stringify(kb));
  check(kb.ok, '真实键盘能送进本应用页面（输入通道自检）',
    kb.ok ? `主窗口 hwnd=${kb.mainHwnd}；焦点=${kb.activeField}；敲入 ${JSON.stringify(kb.typed)} → 页面读回 ${JSON.stringify(kb.readBack)}；发键回执=${kb.sent}`
      : `自检失败：${kb.why || ''}；敲入 ${JSON.stringify(kb.typed)} → 读回 ${JSON.stringify(kb.readBack)}；回执=${kb.sent}`);
  await sleep(800);

  let saved = null;
  let exportClickedAt = 0;              // 本次"导出"点击的时刻：用于筛掉上一轮遗留的导出文件
  let savedMode = 'native-save-dialog'; // 应用自报的导出行为：原生保存框 / 下载回落 / 无可见效果
  let exportByDownload = false;         // 导出是否走下载回落（应用状态行自报）
  let diagImportVerdict = 'not-attempted'; // 诊断用（**不是验收结论**）

  log('（此刻**本应用**的可见窗口，按进程树过滤）' + JSON.stringify(listWindows().windows.map((w) => ({ title: w.title, pid: w.pid, thread: w.thread }))));
  let lastShot = await shot(c, path.join(LOG_DIR, `01-baseline-${runId}.png`), { label: '01-基线' });
  if (lastShot.stale) bad('基线截图是**新鲜帧**', '连续 4 次截到同一张图，说明渲染进程没有重绘');

  // ── 4. 导出：真实点击 → 是否存在原生保存对话框 ──
  log('--- 步骤 1：导出 ---');
  // 先确认「玩家档案」弹层是开着的：导出按钮就在弹层里，弹层不在 → 按钮不在 → 点击必然落空。
  const modalReady = await ensureProfilesModal(c);
  log('导出前确认弹层就位 = ' + JSON.stringify(modalReady));
  log('把本应用窗口置前：' + JSON.stringify(bringToFront('狼人杀')));
  log('导出前原生动态对话框读数（owner 关系探测）= ' + JSON.stringify(appDialogs()));
  lastShot = await shot(c, path.join(LOG_DIR, `02-before-export-${runId}.png`), { label: '02-导出前', prevHash: lastShot && lastShot.hash });
  if (lastShot.stale) bad('导出前截图是新鲜帧', '与基线截图逐字节相同');
  // 观察 input[type=file]（只观测，不改行为）
  log('装 input[type=file] 观察钩子 = ' + JSON.stringify(await c.eval(INSTALL_INPUT_CLICK_HOOK).catch((e) => 'failed:' + e.message)));
  log('装 MutationObserver = ' + JSON.stringify(await c.eval(INSTALL_FILEINPUT_OBSERVER).catch((e) => 'failed:' + e.message)));
  const beforeClick = await c.eval(`(() => {
    const b = document.getElementById('pc-export');
    const r = b ? b.getBoundingClientRect() : null;
    return { disabled: b ? b.disabled : null, rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
      viewport: { w: innerWidth, h: innerHeight, sx: scrollX, sy: scrollY }, visibility: document.visibilityState, hidden: document.hidden };
  })()`);
  log('导出按钮点击前读数 = ' + JSON.stringify(beforeClick));
  const evBefore = c.events.length;
  exportClickedAt = Date.now();
  const exportClick = await realClick(c, ['导出当前档案'], { label: '导出当前档案' });
  log('点「导出当前档案」→ ' + JSON.stringify(exportClick).slice(0, 400));
  if (!exportClick.ok) log('⚠ 导出按钮没被真正点到 ⇒ 本步"没有原生保存框"的读数**不作为**产品结论依据（属测试未命中）。');
  await sleep(2500);
  const dlAfterReal = c.events.slice(evBefore).filter((e) => /download/i.test(e.method)).map((e) => e.method);
  const statusAfterReal = await c.eval('(() => { const e = document.querySelector("#pc-export-status"); return e ? { text: e.textContent, status: e.dataset.exportStatus || null } : null; })()');
  log(`【真实鼠标点击导出】下载类事件=${JSON.stringify(dlAfterReal)} 状态行=${JSON.stringify(statusAfterReal)}`);
  exportByDownload = dlAfterReal.length > 0;
  const exportWatch = await watchAppDialog(/导出档案|另存为|Save As/, { ms: 12000, label: '导出' });
  log('点击导出后出现的原生对话框（owner 关系探测，含承载进程）= ' + JSON.stringify(exportWatch.seen));
  const exportDetail = c.events.slice(evBefore).filter((e) => /downloadProgress/i.test(e.method) && /completed/.test(JSON.stringify(e.params)))
    .map((e) => JSON.stringify(e.params).slice(0, 220));
  log('下载完成事件（含 filePath）= ' + JSON.stringify(exportDetail.slice(-1)));
  log('页面 console/异常（导出段）= ' + JSON.stringify(c.consoleLog()));
  const dialogSeen = !!exportWatch.hit;
  check(dialogSeen, '点击导出后出现**原生保存对话框**',
    dialogSeen ? `window「${exportWatch.hit.title}」class=${exportWatch.hit.cls} hwnd=${exportWatch.hit.hwnd} 承载进程 pid=${exportWatch.hit.pid}(${exportWatch.hit.proc}) ${exportWatch.hit.geo}`
      : `未出现原生保存对话框；${exportClick.ok ? '点击已通过命中自检' : '点击未命中按钮（读数无效）'}；下载类事件=${JSON.stringify(dlAfterReal)}`);
  if (!dialogSeen) {
    savedMode = exportByDownload ? 'download-fallback' : 'no-observable-effect';
    log(`导出侧口径：网页版导出按钮走的是 ${exportByDownload ? '浏览器下载回落（无路径选择）' : '无可见效果'}；` +
      '验收要求的"原生保存对话框"**在这条 UI 路径上确实没有出现** —— 但**这不等于"导出功能坏了"**：文件确实产出（见下方字节读数）。');
    log('（口径依据）应用自己的状态行写着：' + JSON.stringify(statusAfterReal && statusAfterReal.text));
    log('（根因，代码级）桌面主进程**已经实现了**原生保存对话框：desktop/main.js:175 `dialog.showSaveDialog(win, { title: "导出档案", … })`，' +
      '由 preload 暴露成 desktop/preload.js:24 `window.wwExport.exportProfile(profileId)`；' +
      '但 web/app.js 里**没有任何一处调用 `window.wwExport`**（全仓 grep 只命中 desktop/、scripts/、test/、docs/），' +
      '导出按钮走的是 web/app.js 的 browserExportProfile → `document.createElement("a").download`。' +
      '⇒ 原生保存对话框"有实现、没接线"，这是可定位的接线缺口，不是能力缺失。');
  }

  const savePath = path.join(SAVE_DIR, `ww-roundtrip-${runId}.json`);
  if (dialogSeen) {
    // 按截图纪律：原生对话框**不截图**（会拍到用户桌面其它应用），只留窗口读数 + 键盘输入 + 落盘字节
    log('按截图纪律：原生保存对话框不截图，只留窗口读数 + 落盘字节作为证据。');
    sendKeysToHwnd(exportWatch.hit.hwnd, savePath, { label: '保存框输入路径' });
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) { if (!appDialogs().some((d) => /导出档案|另存为/.test(d.title))) break; await sleep(400); }
    log('保存对话框是否仍开着 = ' + (appDialogs().some((d) => /导出档案|另存为/.test(d.title)) ? 'YES' : 'no'));
  } else {
    // ── 附加证据（**不计入验收判据**）：走桌面自己的原生保存通道，证明"原生保存对话框"本身可用 ──
    // 这一步调用的是应用**自己暴露的** desktop 桥（preload 白名单里唯一的键），
    // 不是替身、不是注入：对话框是真的系统保存框，路径也是用真实键盘敲进去的。
    log('--- 附加证据（**不计入验收判据**）：调用应用自己的 window.wwExport.exportProfile，看原生保存对话框是否真的能用 ---');
    const hasBridge = await c.eval('({ has: typeof window.wwExport, keys: window.wwExport ? Object.keys(window.wwExport) : null })');
    log('桥读数 = ' + JSON.stringify(hasBridge));
    if (hasBridge.has === 'object') {
      const nativeSavePath = path.join(SAVE_DIR, `ww-native-save-${runId}.json`);
      c.eval(`window.wwExport.exportProfile(${JSON.stringify(baseline.profileId)}).then((r) => (window.__wwExportRes = r)).catch((e) => (window.__wwExportRes = { __throw: String(e && e.message || e) }))`).catch(() => {});
      const sw = await watchAppDialog(/导出档案|另存为|Save As/, { ms: 15000, label: '附加-原生保存框' });
      log('附加证据：原生保存对话框 = ' + JSON.stringify(sw.seen));
      if (sw.hit) {
        ok('附加（不计入验收）：EXE 的原生保存对话框真的会出现', `title=${JSON.stringify(sw.hit.title)} class=${sw.hit.cls} pid=${sw.hit.pid}(${sw.hit.proc})`);
        // 真实键盘敲进**对话框自己的句柄**（按主窗口置前会把焦点抢走，v9 已踩过）
        sendKeysPathToHwnd(sw.hit.hwnd, nativeSavePath, { label: '附加-保存框输入路径' });
        await sleep(3000);
        const res = await c.eval('window.__wwExportRes || null').catch((e) => ({ error: String(e.message) }));
        log('附加证据：IPC 返回值 = ' + JSON.stringify(res));
        if (fs.existsSync(nativeSavePath)) {
          const sz = sizeOf(nativeSavePath), h = sha256File(nativeSavePath);
          log(`附加证据：文件已落盘 ${nativeSavePath}（${sz} 字节，sha256 ${h}）`);
          try {
            const pk = JSON.parse(fs.readFileSync(nativeSavePath, 'utf8'));
            log('附加证据：包内 profile.bio = ' + JSON.stringify(pk.profile && pk.profile.bio) + '；与基线一致 = ' + (pk.profile && pk.profile.bio === baseline.bio));
          } catch (e) { log('附加证据：包解析失败 ' + e.message); }
        } else {
          log('附加证据：路径上没有文件（对话框可能没被真实键盘确认）');
        }
      } else {
        bad('附加（不计入验收）：EXE 的原生保存对话框真的会出现', '调用了应用的桌面导出桥，但 15 秒内没有出现原生保存对话框');
      }
    }
  }

  // 找落地文件：只查本脚本控制的目录（不去翻用户 Downloads，避免误拿无关文件当证据）。
  // ⚠ 只认**本次点击之后**产生的文件：上一轮就是因为导出点击落空、退回"最近 30 分钟内最新文件"，
  //   结果拿到的是**上一轮**的包（bio 是上一轮的基线），把"包内容与基线一致"判成 FAIL —— 测量自伤。
  //   所以这里必须按"点击时刻"卡时间，并且允许"本 run 内已存在的文件"（下载回落可能复用同名文件）。
  const exportClickAt = (typeof exportClickedAt === 'number' ? exportClickedAt : 0);
  const searchDirs = [SAVE_DIR, DL_DIR, USER_DATA_DIR];
  const candidates = [];
  for (const d of searchDirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch (_) { continue; }
    for (const n of names) {
      if (!/\.json$/i.test(n) || !/ww-|profile/i.test(n)) continue;
      const p = path.join(d, n);
      let sx; try { sx = fs.statSync(p); } catch (_) { continue; }
      if (sx.mtimeMs < exportClickAt - 3000) continue; // 早于本次点击的一律不要（哪怕只早一点）
      if (Date.now() - sx.mtimeMs > 30 * 60 * 1000) continue;
      const fresh = { path: p, size: sx.size, mtime: sx.mtime.toISOString(), mtimeMs: sx.mtimeMs, afterClick: sx.mtimeMs >= exportClickAt - 3000 };
      candidates.push(fresh);
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  log('候选导出文件（**本次点击之后**落地，仅本脚本控制的目录）：' + JSON.stringify(candidates));
  const explicit = fs.existsSync(savePath) && fs.statSync(savePath).mtimeMs >= exportClickAt - 3000 ? { path: savePath, size: sizeOf(savePath), mtimeMs: fs.statSync(savePath).mtimeMs } : null;
  saved = explicit || candidates[0] || null;
  if (!saved) log('本次导出**没有**产出任何文件（不退回旧文件当证据）。');
  if (saved) {
    saved.sha256 = sha256File(saved.path);
    ok('导出文件真实存在于磁盘', `${saved.path}（${saved.size} 字节，sha256 ${saved.sha256}）`);
    try {
      const pkg = JSON.parse(fs.readFileSync(saved.path, 'utf8'));
      const summary = {
        exportVersion: pkg.manifest && pkg.manifest.exportVersion, packageId: pkg.manifest && pkg.manifest.packageId,
        counts: pkg.manifest && pkg.manifest.counts, profileNickname: pkg.profile && pkg.profile.nickname,
        profileBio: pkg.profile && pkg.profile.bio, profileCreatedAt: pkg.profile && pkg.profile.createdAt,
        games: Array.isArray(pkg.games) ? pkg.games.length : null,
        notes: pkg.notes ? Object.keys(pkg.notes).length : null, source: pkg.manifest && pkg.manifest.source,
      };
      log('导出包内容摘要 = ' + JSON.stringify(summary));
      check(pkg.profile && pkg.profile.bio === baseline.bio, '导出包内容与基线一致（profile.bio 逐字相同）',
        `包内 bio=${JSON.stringify(pkg.profile && pkg.profile.bio)} 基线 bio=${JSON.stringify(baseline.bio)}`);
      saved.packageSummary = summary;
    } catch (e) { bad('导出包可解析为 JSON', String(e.message)); }
    fs.writeFileSync(path.join(LOG_DIR, `export-meta-${runId}.json`), JSON.stringify(saved, null, 2), 'utf8');
  } else {
    bad('导出文件真实存在于磁盘', '候选目录都没找到这半小时内新产生的导出包：' + JSON.stringify(searchDirs));
  }
  log('基线（导入后应恢复成什么）= ' + JSON.stringify(baseline));

  // ── 5. 破坏现场（真实 UI 编辑）──
  log('--- 步骤 3：破坏现场（走真实 UI 编辑档案）---');
  const brokenBio = 'BROKEN-' + stampShort;
  const brokenNick = baseline.nickname + '-edited';
  await openPlayerCenter(c);
  const editClick = await c.eval(`(() => {
    const rows = [...document.querySelectorAll('#modal-root .pm-row')];
    const row = rows.find((r) => r.dataset.profileId === ${JSON.stringify(baseline.profileId)}) || rows[0];
    if (!row) return { ok: false, why: 'no-row', rows: rows.length };
    const btn = [...row.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '编辑');
    if (!btn) return { ok: false, why: 'no-edit-btn' };
    btn.click();
    return { ok: true };
  })()`);
  log('点该档案行的「编辑」：' + JSON.stringify(editClick));
  await sleep(800);
  const brk = await c.eval(`(() => {
    const n = document.getElementById('profile-form-nick');
    const b = document.getElementById('profile-form-bio');
    if (!n || !b) return { ok: false, why: 'no-form' };
    n.value = ${JSON.stringify(brokenNick)}; n.dispatchEvent(new Event('input', { bubbles: true }));
    b.value = ${JSON.stringify(brokenBio)}; b.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('#modal-root button')].find((x) => /^(保存)$/.test((x.textContent || '').trim()));
    if (!btn) return { ok: false, why: 'no-save' };
    btn.click();
    return { ok: true };
  })()`);
  log('改昵称/简介并保存：' + JSON.stringify(brk));
  await sleep(2500);
  profiles = await c.eval(PROFILES_JS);
  const afterBreak = profiles.rows.find((p) => p.id === baseline.profileId);
  log('破坏后该档案 = ' + JSON.stringify(afterBreak && { id: afterBreak.id, nickname: afterBreak.nickname, bio: afterBreak.bio, revision: afterBreak.revision }));
  check(!!afterBreak && afterBreak.nickname === brokenNick && afterBreak.bio === brokenBio,
    '破坏现场生效（应用内该档案的昵称/简介真的变了）',
    afterBreak ? `nickname=${JSON.stringify(afterBreak.nickname)}（基线 ${JSON.stringify(baseline.nickname)}）, bio=${JSON.stringify(afterBreak.bio)}（基线 ${JSON.stringify(baseline.bio)}）` : '档案不见了');
  lastShot = await shot(c, path.join(LOG_DIR, `03-broken-${runId}.png`), { label: '03-破坏后', prevHash: lastShot && lastShot.hash });
  if (lastShot.stale) bad('破坏后截图是**新鲜帧**', '与上一张逐字节相同 ⇒ 截图不能作为状态变化的证据');

  // ── 6. 导入：真实点击 → 原生打开对话框 → 选回刚保存的那个文件 ──
  log('--- 步骤 4：导入 ---');
  const profilesBeforeImport = (await c.eval(PROFILES_JS)).rows.length;
  const preImportIds = new Set((await c.eval(PROFILES_JS)).rows.map((p) => p.id));
  let importedByRealPath = false;
  log('装 MutationObserver = ' + JSON.stringify(await c.eval(INSTALL_FILEINPUT_OBSERVER).catch((e) => 'failed:' + e.message)));
  const inputStateBefore = await c.eval(`(() => ({
    count: document.querySelectorAll('input[type=file]').length,
    domInputs: [...document.querySelectorAll('input[type=file]')].map((i) => ({ accept: i.accept, hidden: !!i.hidden, disabled: !!i.disabled, inDocument: !!i.isConnected, id: i.id || null })),
    observedLog: window.__wwFileInputLog || [], seenOnClick: window.__wwSeenFileInputs || [],
    api: { showOpenFilePicker: typeof window.showOpenFilePicker, showSaveFilePicker: typeof window.showSaveFilePicker },
  }))()`);
  log('诊断1（点击导入前）input[type=file] 读数 = ' + JSON.stringify(inputStateBefore));
  const consoleBefore = c.consoleLog().length;
  // ★ 真实用户路径：不开启任何 CDP 选择器拦截；这一步的读数才是验收判据
  const importClick = await realClick(c, ['导入档案包'], { label: '导入档案包' });
  log('点「导入档案包」→ ' + JSON.stringify(importClick).slice(0, 500));
  const clickSelfCheckFailed = !importClick.ok;
  await sleep(2500);
  const inputStateAfter = await c.eval(`(() => ({
    count: document.querySelectorAll('input[type=file]').length,
    domInputs: [...document.querySelectorAll('input[type=file]')].map((i) => { const q = i.getBoundingClientRect(); return { accept: i.accept, hidden: !!i.hidden, disabled: !!i.disabled, inDocument: !!i.isConnected, id: i.id || null, rect: { x: Math.round(q.x), y: Math.round(q.y), w: Math.round(q.width), h: Math.round(q.height) } }; }),
    observedLog: window.__wwFileInputLog || [], seenOnClick: window.__wwSeenFileInputs || [],
  }))()`);
  log('诊断2（点击导入后）input[type=file] 读数 = ' + JSON.stringify(inputStateAfter));
  log(`诊断3：console/异常原文（共 ${c.consoleLog().length} 条，点击前 ${consoleBefore} 条）`);
  for (const line of c.consoleLog().slice(Math.max(0, consoleBefore - 2))) log('   console> ' + JSON.stringify(line).slice(0, 500));
  const importWatch = await watchAppDialog(/^打开$|^Open$|选择文件|打开文件/, { ms: 15000, label: '导入' });
  log('点击导入后出现的原生对话框（owner 关系探测，含承载进程）= ' + JSON.stringify(importWatch.seen));
  log('（备注）Page.fileChooserOpened 只在开启了 Page.setInterceptFileChooserDialog 时才会派发，' +
    '所以"本段没看到该事件"**不能**用来证明页面没有请求选择器；本段的判据是**原生对话框读数**（GetLastActivePopup）。');
  if (clickSelfCheckFailed) {
    log('⚠ 本轮点击**没有命中按钮**（自检不过）⇒ 下面这条读数**不作为产品结论**（属测试未命中）。');
    bad('导入按钮点击自检', JSON.stringify(importClick.why || importClick).slice(0, 300));
  } else {
    const openHit = importWatch.hit;
    check(!!openHit, '点击导入后出现**原生打开对话框**（点击通过命中自检，且未开启任何 CDP 拦截）',
      openHit ? `window「${openHit.title}」class=${openHit.cls} hwnd=${openHit.hwnd} 承载进程 pid=${openHit.pid}(${openHit.proc}) ${openHit.geo}`
        : '点击确实落在按钮上，但仍未出现原生打开对话框；探测到的对话框=' + JSON.stringify(importWatch.seen));
    // 三条读数（命中自检 / 页面点击事件 / 点击前后 DOM 变化）一次性打印，供结论引用
    log('【导入侧三条读数】① 命中自检：' + JSON.stringify({ 坐标: [importClick.x, importClick.y], elementFromPoint: 'BUTTON.btn', selfCheck: importClick.selfCheck }));
    log('【导入侧三条读数】② 页面是否收到点击：' + JSON.stringify({ clickedText: importClick.clicked, dispatched: 'Input.dispatchMouseEvent(mousePressed/mouseReleased)' }));
    log('【导入侧三条读数】③ 点击前后 DOM 变化：fileInputCount ' + inputStateBefore.count + ' → ' + inputStateAfter.count +
      '；动态创建 input[type=file] 记录=' + JSON.stringify(inputStateAfter.seenOnClick) +
      '；原生对话框=' + JSON.stringify(openHit || null));
  }
  if (importWatch.hit) {
    log('按截图纪律：原生打开对话框不截图（只留窗口读数 + 后续真实导入结果作为证据）。');
    // ① 验收允许的方法：真实键盘把"刚导出的那个文件"敲进对话框并回车。
    //    先 Alt+N 把焦点切到"文件名"框（现代文件对话框的输入框是 DirectUI 控件，不是 class=Edit 子窗口，
    //    只能靠助记键定位），再逐字符敲路径，最后回车。
    log('① 用真实键盘把路径敲进原生对话框（Alt+N → 路径 → 回车），敲字前先把输入语言钉成英文：');
    const kbTry = sendKeysPathToHwnd(importWatch.hit.hwnd, saved ? saved.path : '', { label: '打开框输入刚导出的文件路径' });
    let closed = false;
    for (let i = 0; i < 25; i++) { if (!appDialogs().some((d) => /^打开$|^Open$/.test(d.title))) { closed = true; break; } await sleep(400); }
    log('   真实键盘之后，打开对话框是否已关闭 = ' + closed);
    let dialogInputMethod = 'real-keyboard';
    if (!closed) {
      bad('用**真实键盘**在原生打开对话框里选回刚导出的文件', '按键送达对话框后对话框仍未关闭（控件里也没有出现路径）');
      // ② 兜底（**明确标注：不是真实键盘**，只是把文本交给真实对话框的输入框 + 真实鼠标点它的按钮）
      log('② 键盘送不进对话框 ⇒ 启用**消息级兜底**（把文本交给真实对话框自己的输入框 + 真实鼠标点它的"打开"按钮）。');
      log('   声明：这一步**不是**"用键盘操作对话框"，仅用于把往返闭环本身走完、看应用表现。');
      const ch = ps('dialog-children', String(importWatch.hit.hwnd)).out;
      const editHwnd = (ch.split('\n').find((l) => /class=Edit/.test(l) && /vis=True/.test(l)) || '').match(/hwnd=(\d+)/);
      const openBtn = (ch.split('\n').find((l) => /class=Button/.test(l) && /vis=True/.test(l) && /打开/.test(l)) || '').match(/hwnd=(\d+)/);
      log('   对话框控件：输入框=' + JSON.stringify(editHwnd && editHwnd[1]) + ' 打开按钮=' + JSON.stringify(openBtn && openBtn[1]));
      log('   对话框控件清单 = ' + JSON.stringify(ch.split('\n').slice(0, 12)));
      if (editHwnd && openBtn) {
        log('   设文本：' + JSON.stringify(ps('set-text-hwnd', editHwnd[1], saved ? saved.path : '').out));
        log('   （消息级，仅诊断；下面的闭环以真实对话框的返回值为准）');
        log('   真实鼠标点击"打开"按钮：' + JSON.stringify(ps('click-hwnd', openBtn[1]).out));
        dialogInputMethod = 'message-level-fallback';
        for (let i = 0; i < 25; i++) { if (!appDialogs().some((d) => /^打开$|^Open$/.test(d.title))) { closed = true; break; } await sleep(400); }
        log('   兜底之后，打开对话框是否已关闭 = ' + closed);
      }
    } else {
      ok('用**真实键盘**在原生打开对话框里选回刚导出的文件', '键盘送入路径后对话框已关闭');
    }
    log('   选文件所使用的输入方式 = ' + dialogInputMethod);
    log('打开对话框是否仍开着 = ' + (appDialogs().some((d) => /^打开$|^Open$/.test(d.title)) ? 'YES' : 'no'));
    // 选完文件后应用会弹原生 confirm 预览框 → 必须应答，否则渲染进程被阻塞、后续 CDP 全部超时
    const dlg = await waitJsDialog(c, 15000);
    if (dlg) {
      const ans = await answerJsDialog(c, { label: '真实路径-预览确认框' });
      log('【真实路径】预览确认框应答 = ' + JSON.stringify(ans));
      const n1 = jsDialogs(c).length;
      const dlg2 = await waitJsDialog(c, 10000);
      if (dlg2 && jsDialogs(c).length >= n1) { const ans2 = await answerJsDialog(c, { label: '真实路径-结果提示框' }); log('【真实路径】结果提示框应答 = ' + JSON.stringify(ans2)); }
    } else {
      log('【真实路径】没有出现 JS 原生 confirm 预览框（未走到预览那一步）。');
    }
    // 真实路径那一次到底有没有真的导入成功？——用档案数判断（多了一份才算）
    await sleep(1200);
    const afterReal = await c.eval(PROFILES_JS);
    importedByRealPath = !!afterReal && afterReal.rows.length > profilesBeforeImport;
    log('真实路径导入结果：档案数 ' + profilesBeforeImport + ' → ' + (afterReal ? afterReal.rows.length : 'n/a') +
      ' ⇒ 真实路径是否已导入成功 = ' + (importedByRealPath ? 'YES' : 'no'));
  } else if (!clickSelfCheckFailed) {
    bad('原生打开对话框出现', '点击已落在按钮上仍无对话框 ⇒ 无法按验收要求"选回刚保存的文件"');
    log('--- 方法学对照：同样点「导入档案包」，改用 JS element.click() 再试一次 ---');
    log('JS click() 结果 = ' + JSON.stringify(await c.eval(clickByTextExpr(['导入档案包']))).slice(0, 200));
    const jsWatch = await watchAppDialog(/^打开$|^Open$/, { ms: 12000, label: '导入-JS对照' });
    log('JS click() 后出现的原生对话框 = ' + JSON.stringify(jsWatch.seen));
    log(`【对照结论】CDP 真实鼠标事件（命中自检通过）→ 对话框=${importWatch.hit ? '出现' : '未出现'}；JS element.click() → 对话框=${jsWatch.hit ? '出现' : '未出现'}`);
    if (!jsWatch.hit) bad('两种点击方式都没有弹出原生打开对话框（已排除测试方法因素）', 'CDP Input 真实鼠标事件与 JS click() 均未产生对话框窗口');
  }

  // ═══════════ 诊断段（**不属于验收**）：导入逻辑本身能不能用 ═══════════
  // 边界声明：本段把真文件**直接喂给 input**（CDP DOM.setFileInputFiles），属诊断手段，
  // **不是**用真实文件选择器选回文件。即使成功，验收判据**仍然是 FAIL**。
  // ⚠ 若"真实路径"那一次已经真的导入成功，本段**跳过**：否则会多出第二份档案，
  //   把"导入后档案数 +1"这条验收判据自己搞成 +2（上一轮就是这么自伤的）。
  const realPathImported = importedByRealPath;
  log('--- 诊断段（不属于验收）：把真文件直接喂给 input，看导入逻辑本身通不通 ---');
  log('诊断前置：真实路径那一次是否已经导入成功 = ' + (importedByRealPath ? 'YES ⇒ 跳过诊断段（避免多出一份档案污染 +1 判据）' : 'no ⇒ 继续诊断'));
  if (importedByRealPath) {
    diagImportVerdict = 'skipped-real-path-already-imported';
    log('诊断段已跳过。');
  } else {
  const interceptOn = await c.send('Page.setInterceptFileChooserDialog', { enabled: true }).then(() => true).catch((e) => { log('开启文件选择器拦截失败：' + e.message); return false; });
  log('诊断4：CDP 文件选择器拦截已开启 = ' + interceptOn + '（开启期间原生对话框必然不弹 ⇒ 本段读数**不作为**验收判据）');
  const diagClick = await realClick(c, ['导入档案包'], { label: '导入档案包(诊断段)' });
  log('诊断4b：诊断段点击 = ' + JSON.stringify(diagClick).slice(0, 300));
  await sleep(1500);
  const intercepted = c.events.filter((e) => e.method === 'Page.fileChooserOpened').map((e) => e.params);
  log('诊断5：Page.fileChooserOpened 事件 = ' + JSON.stringify(intercepted));
  const diagPath = saved ? saved.path : null;
  const nodeIdFromEvent = intercepted && intercepted[0] && intercepted[0].backendNodeId ? intercepted[0].backendNodeId : null;
  let diagResult = 'not-attempted';
  if (!diagPath) { diagResult = 'no-exported-file-to-feed'; log('诊断6：没有第 1 步导出的文件可喂，跳过'); }
  else if (nodeIdFromEvent) {
    try {
      await c.send('DOM.setFileInputFiles', { files: [diagPath], backendNodeId: nodeIdFromEvent });
      diagResult = 'fed-via-backendNodeId';
      log('诊断6：DOM.setFileInputFiles(backendNodeId=' + nodeIdFromEvent + ', ' + diagPath + ') → 已喂入');
    } catch (e) { diagResult = 'feed-failed:' + e.message; log('诊断6：喂文件失败（backendNodeId 路径）：' + e.message); }
  } else {
    const fed = await c.eval(`(() => {
      const inp = window.__wwLastFileInput || null;
      if (!inp) return 'no-reference';
      inp.id = '__ww-diag-input';
      if (!inp.isConnected) document.body.appendChild(inp); // 只为让 CDP 能定位到这个游离节点
      return 'have-reference';
    })()`);
    log('诊断6前置：页内 input 引用 = ' + fed);
    try {
      const doc = await c.send('DOM.getDocument', { depth: -1, pierce: true });
      const q = fed === 'have-reference' ? await c.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#__ww-diag-input' }).catch(() => null) : null;
      const nid = q && q.nodeId ? q.nodeId : null;
      if (nid) {
        await c.send('DOM.setFileInputFiles', { files: [diagPath], nodeId: nid });
        diagResult = 'fed-via-nodeId';
        log('诊断6：DOM.setFileInputFiles(nodeId=' + nid + ', ' + diagPath + ') → 已喂入');
      } else { diagResult = 'no-input-node-available'; log('诊断6：拿不到可定位的 input 节点 ⇒ 无法做"喂文件"诊断'); }
    } catch (e) { diagResult = 'feed-failed:' + e.message; log('诊断6：喂文件失败：' + e.message); }
  }
  if (diagResult.startsWith('fed-')) {
    // 喂进文件后，应用的 change 处理器会读文件 → 弹原生 confirm(预览) → 再 alert(结果)。
    // 用 CDP 的 Page.javascriptDialogOpening 事件精确识别（**不要**用"窗口标题匹配"——主窗口永远匹配，
    // v7 就因此误判成"确认框已出现"）。应答优先走真实回车；置前失败才退回 CDP 应答并明确标注。
    const dlgA = await waitJsDialog(c, 12000);
    log('诊断7：喂文件后的 JS 原生对话框 = ' + JSON.stringify(dlgA ? { type: dlgA.type, message: (dlgA.message || '').slice(0, 300) } : null));
    if (dlgA) {
      const a1 = await answerJsDialog(c, { label: '诊断-预览确认框' });
      log('诊断7b：预览确认框应答 = ' + JSON.stringify(a1));
      await sleep(1500);
      const before = jsDialogs(c).length;
      const dlgB = await waitJsDialog(c, 8000);
      if (dlgB && jsDialogs(c).length >= before) {
        log('诊断7c：随后提示框 = ' + JSON.stringify({ type: dlgB.type, message: (dlgB.message || '').slice(0, 300) }));
        const a2 = await answerJsDialog(c, { label: '诊断-结果提示框' });
        log('诊断7d：结果提示框应答 = ' + JSON.stringify(a2));
      }
    } else {
      log('诊断7：喂文件后**没有**出现 JS 原生 confirm/alert（可能导入被应用拒绝或走了别的分支）。');
    }
    await sleep(2000);
    const rowsDiag = await c.eval(PROFILES_JS).catch((e) => ({ rows: null, error: String(e.message) }));
    const diagRows = rowsDiag.rows || [];
    const hitDiag = diagRows.find((p) => p.bio === baseline.bio && p.id !== baseline.profileId);
    log(`诊断8：喂文件后档案数 ${profilesBeforeImport} → ${diagRows.length}` +
      (rowsDiag.error || !rowsDiag.rows ? `（⚠ 本次读取失败，读数不可用：${rowsDiag.error || 'rows 缺失'}）` : '') +
      `；命中基线字段的新档案=${hitDiag ? JSON.stringify({ id: hitDiag.id, nickname: hitDiag.nickname, bio: hitDiag.bio }) : '无'}`);
    log('诊断9：喂文件后的 console/异常 = ' + JSON.stringify(c.consoleLog().slice(-6)));
    const readable = !!rowsDiag.rows;
    diagImportVerdict = !readable ? 'inconclusive-read-failed' : (hitDiag ? 'logic-ok-missing-picker' : 'logic-broken-or-rejected');
    log('═══ 诊断结论（**不是验收**）：导入逻辑本身 = ' + (!readable ? '本次读数失败、无法判定' : (hitDiag ? '可用（喂文件能导入成功）' : '不通（喂文件也没导入成功）')) + ' ═══');
    log('═══ 边界声明：喂文件属诊断手段，**不等于**"用真实选择器选回刚保存的文件"，故验收结论仍为 FAIL ═══');
  } else {
    log('诊断：本轮未能完成"喂文件"（diagResult=' + diagResult + '）⇒ 无法给出"导入逻辑是否可用"的结论，如实标未做。');
  }
  await c.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  log('诊断10：拦截已关闭；验收判据采用**未开拦截**的那一次点击读数（见上面那条）。');
  }

  // ── 7. 复原核对 ──
  log('--- 步骤 5：核对导入结果 ---');
  const profilesAfter = await c.eval(PROFILES_JS);
  log('导入后 /api/profiles = ' + JSON.stringify(profilesAfter.rows.map((p) => ({ id: p.id, nickname: p.nickname, bio: p.bio, createdAt: p.createdAt }))).slice(0, 900));
  // 按**昵称**认领新档案（不按 bio）：bio 可能因"导出的是哪一轮的包"而不同，
  // 上一轮就是按 bio 找、结果没找到自己这一轮导入的那份（测量口径自伤）。
  const importedRow = profilesAfter.rows.find((p) => p.nickname === baseline.nickname && p.id !== baseline.profileId)
    || profilesAfter.rows.find((p) => p.id !== baseline.profileId && p.id !== 'default' && !preImportIds.has(p.id));
  check(profilesAfter.rows.length === profilesBeforeImport + 1, '导入后档案数 +1',
    `导入前 ${profilesBeforeImport} → 导入后 ${profilesAfter.rows.length}` + (importedByRealPath ? '（真实路径导入）' : '（诊断喂文件）'));
  if (importedRow) {
    ok('导入产生了新档案，其字段与基线逐项一致',
      `nickname=${JSON.stringify(importedRow.nickname)}（基线 ${JSON.stringify(baseline.nickname)}）, bio=${JSON.stringify(importedRow.bio)}（基线 ${JSON.stringify(baseline.bio)}）, avatarId=${JSON.stringify(importedRow.avatarId)}（基线 ${JSON.stringify(baseline.avatarId)}）, createdAt=${JSON.stringify(importedRow.createdAt)}（基线 ${JSON.stringify(baseline.createdAt)}）`);
    check(importedRow.nickname === baseline.nickname, '导入档案昵称 == 基线昵称', `${JSON.stringify(importedRow.nickname)} vs ${JSON.stringify(baseline.nickname)}`);
    check(importedRow.bio === baseline.bio, '导入档案简介 == 基线简介', `${JSON.stringify(importedRow.bio)} vs ${JSON.stringify(baseline.bio)}`);
    check(importedRow.avatarId === baseline.avatarId, '导入档案头像 == 基线头像', `${JSON.stringify(importedRow.avatarId)} vs ${JSON.stringify(baseline.avatarId)}`);
    check(importedRow.id !== baseline.profileId, '导入是副本（新 UUID，不改动原档案）', `${importedRow.id} ≠ ${baseline.profileId}`);
    // createdAt：**契约就是重新生成**，不是保留。判据必须跟着契约走，不能跟着我的猜测走。
    // 依据：src/api.js:2296 importApplyRes → profiles.create({ nickname, avatarId, bio, preferences })，
    // 压根不传 createdAt；src/profiles/store.js:246 `createdAt: now` 由 create 现取时间戳。
    // 界面文案也自报"副本，原档案未改动"。所以这里断言"新的 createdAt ≠ 基线"，并另记一条**观察**：
    // 导出包其实带了 profile.createdAt（src/profiles/transfer.js:88），导入端却忽略它 —— 字段白带了。
    check(importedRow.createdAt !== baseline.createdAt, '导入档案 createdAt 按契约重新生成（副本语义）',
      `导入后 ${JSON.stringify(importedRow.createdAt)} ≠ 基线 ${JSON.stringify(baseline.createdAt)}`);
    log('（观察，非判据）导出包携带 profile.createdAt=' + JSON.stringify(saved && saved.packageSummary ? saved.packageSummary.profileCreatedAt : null) +
      `；导入后新档案 createdAt=${JSON.stringify(importedRow.createdAt)}` +
      ' ⇒ 包里的 createdAt 目前被导入端忽略（src/profiles/transfer.js:88 写入、src/api.js:2296 不消费）。');
  } else {
    bad('导入产生了与基线字段一致的新档案', '没有找到 bio == 基线的第二份档案；实际 rows=' + JSON.stringify(profilesAfter.rows.map((p) => ({ n: p.nickname, b: p.bio }))).slice(0, 400));
  }
  if (saved && saved.sha256) {
    const again = sha256File(saved.path);
    check(again === saved.sha256, '导入后导出文件字节未被改动（sha256 复核）', `${again}`);
  }
  const uiAfter = await c.eval(`(() => {
    const rows = [...document.querySelectorAll('#modal-root .pm-row')].map((r) => ({ id: r.dataset.profileId, text: (r.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) }));
    const h = document.querySelector('#modal-root h2, #modal-root h3');
    return { modal: h ? h.textContent.trim() : null, rows };
  })()`);
  log('导入后界面读数（玩家档案弹层）= ' + JSON.stringify(uiAfter).slice(0, 900));
  if (diagImportVerdict === 'logic-ok-missing-picker') {
    log('═══ 诊断（**不是验收通过**）：导入逻辑本身可用，缺的是**文件选择入口** —— EXE 下点「导入档案包」不弹任何选择器。');
    log('═══ 验收结论仍是 FAIL：验收要求"用真实选择器选回刚保存的文件"，喂文件（DOM.setFileInputFiles）不算通过。');
  } else if (diagImportVerdict === 'logic-broken-or-rejected') {
    log('═══ 诊断（**不是验收通过**）：把真文件喂给 input 后导入也没成功 ⇒ 导入链路在 EXE 上不通（见诊断8 的真实报错）。');
  } else {
    log('═══ 诊断：本轮没能完成"喂文件"这一步（verdict=' + diagImportVerdict + '）。');
  }
  lastShot = await shot(c, path.join(LOG_DIR, `07-after-import-${runId}.png`), { label: '07-导入后', prevHash: lastShot && lastShot.hash });
  if (lastShot.stale) bad('导入后截图是**新鲜帧**', '与上一张逐字节相同 ⇒ 截图不能作为状态变化的证据');
  fs.writeFileSync(path.join(LOG_DIR, `post-import-${runId}.json`), JSON.stringify({ exeId: exeId0, baseline, saved, savedMode, exportByDownload, diagImportVerdict, rows: profilesAfter.rows, ui: uiAfter }, null, 2), 'utf8');

  finalize(null, { child, USER_DATA_DIR, EXE, exeId0, c });
})().catch((e) => {
  log('!! 脚本异常：' + (e && e.stack || e));
  // 抛异常也必须收尾：否则应用会留在用户桌面上、隔离目录也删不掉（v7 就踩过）。
  log('因脚本异常，直接进入收尾流程（退出码 3：需要人工介入/测试未完成）。');
  try { finalize(3, { child: CHILD, USER_DATA_DIR, EXE, exeId0: EXE_ID0 || { sha256: '' }, c: CDP }); }
  catch (e2) { log('收尾流程本身也失败了：' + (e2 && e2.stack || e2)); process.exit(3); }
});

/** 收尾：关应用 → 删隔离数据目录（**显式报告**，绝不吞）→ 汇总 → 退出码 */
function finalize(forceCode, { child, USER_DATA_DIR, EXE, exeId0, c }) {
  (async () => {
    log('--- 步骤 6：清理 ---');
    try { if (c) c.close(); } catch (_) {}
    try { if (child && child.exitCode === null) child.kill(); } catch (e) { log('child.kill 异常：' + e.message); }
    let gone = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      if (!child || child.exitCode !== null || child.signalCode) { gone = true; break; }
      await sleep(400);
    }
    log('应用进程退出 = ' + (gone ? 'yes' : 'no（仍在运行）') + `（exitCode=${child && child.exitCode}, signal=${child && child.signalCode}）`);
    if (gone) ensureAppPids(child ? child.pid : 0);
    const leftover = (listWindows({ appOnly: true, qualify: (w) => qualifyAppWindow(w) && /狼人杀|werewolf/i.test(w.title) }).windows || []);
    if (leftover.length) {
      log('本应用仍有窗口：' + JSON.stringify(leftover.map((w) => ({ title: w.title, pid: w.pid }))) + ' → 强杀这些 PID');
      for (const p of [...new Set(leftover.map((w) => w.pid))]) {
        try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p)], { windowsHide: true, timeout: 15000 }); } catch (_) {}
      }
      await sleep(2000);
    }
    await sleep(1200);
    // 删隔离数据目录必须显式报告（EPERM 被吞掉会形成假绿）
    let removed = false;
    let rmErr = null;
    const rmAttempts = [];
    for (let i = 1; i <= 5 && !removed; i++) {
      try {
        fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
        removed = !fs.existsSync(USER_DATA_DIR);
        rmAttempts.push(`第${i}次：rmSync 返回，目录已不存在=${removed}`);
      } catch (e) {
        rmErr = e;
        rmAttempts.push(`第${i}次：${(e && (e.code || e.name)) || '?'} ${String((e && e.message) || e).slice(0, 160)}`);
        await sleep(1500);
      }
    }
    log('删除隔离数据目录的尝试记录：' + JSON.stringify(rmAttempts));
    if (removed) ok('清理隔离数据目录（--user-data-dir）', USER_DATA_DIR + ' 已真正删除（existsSync=false）');
    else bad('清理隔离数据目录（--user-data-dir）失败', `原因=${String((rmErr && (rmErr.code || rmErr.message)) || '未知')}；目录仍存在=${fs.existsSync(USER_DATA_DIR)}；尝试=${JSON.stringify(rmAttempts)}`);

    // 制品身份复核：跑的过程中 dist 有没有被重新打包
    let exeId1 = null;
    try { const s2 = fs.statSync(EXE); exeId1 = { size: s2.size, mtime: s2.mtime.toISOString(), sha256: sha256File(EXE) }; } catch (e) { exeId1 = { error: String(e.message) }; }
    log('制品身份（收尾复核）= ' + JSON.stringify(exeId1));
    if (exeId0 && exeId0.sha256) {
      check(!!exeId1 && exeId1.sha256 === exeId0.sha256, '本轮全程针对同一个制品（EXE sha256 未变）',
        `前=${exeId0.sha256.slice(0, 16)}… 后=${String(exeId1 && exeId1.sha256).slice(0, 16)}…`);
    }

    const pass = results.filter((r) => r.pass).length;
    const fails = results.filter((r) => !r.pass && !r.warnOnly);
    const warns = results.filter((r) => !r.pass && r.warnOnly);
    log('=========== 汇总 ===========');
    log(`PASS ${pass} / FAIL ${fails.length} / WARN ${warns.length}（共 ${results.length} 条判据）`);
    for (const f of fails) log('  FAIL: ' + f.name + (f.detail ? ' — ' + f.detail : ''));
    for (const w of warns) log('  WARN: ' + w.name + (w.detail ? ' — ' + w.detail : ''));
    log('日志：' + LOG_FILE);
    log('截图目录：' + LOG_DIR);
    const clickMiss = fails.some((f) => /点击前自检/.test(f.name));
    const code = forceCode != null ? forceCode : (clickMiss ? 4 : (fails.length ? 1 : 0));
    log('退出码 = ' + code);
    process.exit(code);
  })();
}
