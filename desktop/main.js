/**
 * main.js — AI 狼人杀 电脑版（Electron 主进程）
 *
 * 为什么改成 Electron，而不是"文件夹 + .cmd + 浏览器"：
 *   上一版是内置 node.exe + 批处理启动器，用户实测跑不起来，且排查发现**服务端从未启动**
 *   （logs/ 都没生成）—— 失败全部发生在启动器/命令行那一层：批处理文件的编码要跟控制台
 *   代码页一致（936 与 65001 二选一必翻车）、依赖用户双击的是哪个文件、依赖浏览器肯不肯开。
 *   真正的桌面软件把这些环节全删掉：一个窗口就是界面，没有控制台、没有代码页、没有浏览器依赖。
 *
 * 服务端不重写、不复用第二份：直接把项目自带的 server.js 在本进程内 require 起来
 * （server.js 被 require 时就会 listen）。这样做的好处是引擎、图鉴、存档逻辑一份都不用改，
 * 安卓版 / 网页版 / 电脑版共用同一套 src 与 web。
 *
 * 与 .cmd 版相比多修的两个坑：
 *   ① 端口不再写死 3210，启动时选一个空闲端口 —— 端口被占用是上一版最常见的失败原因之一；
 *   ② 存档/配置/日志落到用户数据目录（%APPDATA%），不写在安装目录里（那里可能只读）。
 */
'use strict';
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const http = require('http');
const net = require('net');
const fs = require('fs');

const DEV_ROOT = path.join(__dirname, '..');
const SERVER_DIR = app.isPackaged ? path.join(process.resourcesPath, 'server') : DEV_ROOT;
const DATA_DIR = app.getPath('userData');
// 窗口与任务栏图标：打包后 web/ 随资源一起进 resources/server/web，所以从 SERVER_DIR 取，
// 开发态与打包态同一条路径可用（exe 自身图标受限于未签名/无 rcedit，见 README）
const APP_ICON = path.join(SERVER_DIR, 'web', 'assets', 'icon-512.png');

let win = null;
let port = 0;
let bootError = null;

/** 找一个空闲端口：不写死 3210，避免"端口被占用"直接启动失败 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function probe(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: p, path: '/api/meta', timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitServer(p, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await probe(p)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function startServer() {
  // WW_DATA_DIR 一举两得：存档/配置/日志落到用户目录，同时让 server.js 不再自己开系统浏览器
  process.env.WW_DATA_DIR = DATA_DIR;
  process.env.NO_OPEN = '1';
  port = await freePort();
  process.env.PORT = String(port);
  require(path.join(SERVER_DIR, 'server.js')); // server.js 被 require 即开始监听
  return waitServer(port, 30000);
}

const LOADING_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>AI 狼人杀</title><style>
  html,body{height:100%;margin:0;background:radial-gradient(ellipse at 50% 30%,#141d38,#04060d 70%);
    color:#d8b25f;font-family:"Microsoft YaHei",system-ui,sans-serif;
    display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;user-select:none}
  .moon{width:64px;height:64px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#f6e7c0,#d8b25f 60%,#8a6f2e);
    box-shadow:0 0 40px rgba(216,178,95,.45);animation:pulse 2.2s ease-in-out infinite}
  @keyframes pulse{0%,100%{transform:scale(1);opacity:.92}50%{transform:scale(1.06);opacity:1}}
  h1{font-size:20px;letter-spacing:6px;margin:8px 0 0;font-weight:500}
  p{color:#8d9ab5;font-size:13px;letter-spacing:1px;margin:0}
</style></head><body><div class="moon"></div><h1>AI 狼人杀</h1><p>正在启动本地服务…</p></body></html>`;

function buildMenu() {
  const open = (hash) => () => { if (win) win.loadURL(`http://127.0.0.1:${port}/${hash || ''}`); };
  return Menu.buildFromTemplate([
    {
      label: '界面',
      submenu: [
        { label: '电脑版', accelerator: 'CmdOrCtrl+1', click: open('') },
        { label: '手机版预览', accelerator: 'CmdOrCtrl+2', click: open('m/') },
        { type: 'separator' },
        { label: '刷新', accelerator: 'F5', click: () => win && win.reload() },
        { label: '开发者工具', accelerator: 'F12', click: () => win && win.webContents.toggleDevTools() },
      ],
    },
    {
      label: '工具',
      submenu: [
        { label: '打开数据目录（存档 / 配置 / 日志）', click: () => shell.openPath(DATA_DIR) },
        { label: '在浏览器中打开', click: () => shell.openExternal(`http://127.0.0.1:${port}/`) },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: '关于',
            message: `AI 狼人杀 电脑版 ${app.getVersion()}`,
            detail: `本地服务端口：${port}\n数据目录：${DATA_DIR}\n\n`
              + '1 名人类 + N 名 AI 的狼人杀。服务端与网页与安卓版 / 网页版共用同一份代码，\n'
              + '在「API 配置」里填 base_url、模型名与 API Key 后即可开局。',
            buttons: ['好'],
          }),
        },
      ],
    },
  ]);
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#04060d',
    title: 'AI 狼人杀',
    icon: APP_ICON,
    autoHideMenuBar: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  Menu.setApplicationMenu(buildMenu());

  win.once('ready-to-show', () => win.show());
  // 站内链接留在窗口内；外链（角色图等）交给系统浏览器，别把应用窗口导航走。
  // 安全（整改 SEC-03）：可信来源用 URL 解析后的精确 origin 比较 —— 旧的字符串 includes
  // 判断可被 http://evil.com/?127.0.0.1:3210 这类构造绕过，把外链误当站内导航。
  const internalOrigin = `http://127.0.0.1:${port}`;
  const isInternalUrl = (url) => {
    try { return new URL(url).origin === internalOrigin; } catch (_) { return false; }
  };
  // 拒绝一切权限请求（通知/摄像头/定位等）：本应用用不到
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && !isInternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isInternalUrl(url)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(LOADING_HTML));

  try {
    const ok = await startServer();
    if (!ok) throw new Error('服务端在 30 秒内没有就绪');
  } catch (err) {
    bootError = err;
    return;
  }
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

// 单实例：重复双击时把已有窗口拉到前台，而不是再起一个服务
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    await createWindow();
    if (bootError) {
      const logDir = path.join(DATA_DIR, 'logs');
      const tail = (() => {
        try {
          const f = path.join(logDir, 'server.log');
          return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').slice(-20).join('\n') : '（还没有日志文件）';
        } catch (e) { return `（读日志失败：${e.message}）`; }
      })();
      dialog.showErrorBox('启动失败',
        `AI 狼人杀 没能启动本地服务。\n\n错误：${bootError.message}\n\n数据目录：${DATA_DIR}\n日志尾部：\n${tail}`);
      app.quit();
      return;
    }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => app.quit());
}
