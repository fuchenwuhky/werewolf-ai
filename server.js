/**
 * server.js — 入口：HTTP 服务 + 静态文件 + 配置加载
 * 启动：node server.js  （或 npm start）→ 浏览器打开 http://localhost:3210
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { Logger, maskKey } = require('./src/log');
const { Api } = require('./src/api');
const { DEFAULT_CONFIG, createConfig } = require('./src/config');

const ROOT = __dirname;
// APP 内嵌时由 capacitor-nodejs 注入 DATADIR（应用私有持久目录），也可用 WW_DATA_DIR 覆盖
const DATA_DIR = process.env.WW_DATA_DIR || process.env.DATADIR || ROOT;
const WEB_DIR = path.join(ROOT, 'web');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PORT = Number(process.env.PORT || 3210);

// ---------- 配置 ----------
const config = createConfig(CONFIG_FILE);
const loadInfo = config.load();

// ---------- 日志 ----------
const logger = new Logger({ dir: path.join(DATA_DIR, 'logs'), level: process.env.LOG_LEVEL || 'debug' });

// ---------- API ----------
const api = new Api({ config, logger });

// ---------- 静态文件 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  const full = path.normalize(path.join(WEB_DIR, file));
  if (!full.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  // 目录请求（如 /m/）自动补 index.html
  let target = full;
  try {
    if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  } catch (_) { /* 不存在则走 404/SPA */ }
  fs.readFile(target, (err, data) => {
    if (err) {
      // SPA 兜底
      fs.readFile(path.join(WEB_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(u.pathname);
  // 手机访问根路径 → 跳转 APP 端（?desktop=1 可强制桌面版）
  if (pathname === '/' && !u.searchParams.has('desktop') &&
      /Android|iPhone|iPad|Mobile|HarmonyOS/i.test(req.headers['user-agent'] || '')) {
    res.writeHead(302, { Location: '/m/' });
    return res.end();
  }
  if (pathname === '/m') {
    res.writeHead(302, { Location: '/m/' });
    return res.end();
  }
  if (pathname.startsWith('/api/')) {
    api.handle(req, res, pathname, u.searchParams).catch((e) => {
      logger.error('api', `未捕获接口错误: ${e.message}`, { stack: e.stack });
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message) }));
      } catch (_) { /* ignore */ }
    });
    return;
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  const c = config.get();
  logger.info('server', '=========================================');
  logger.info('server', `AI 狼人杀已启动：http://localhost:${PORT}`);
  logger.info('server', `生效配置快照：baseUrl=${c.baseUrl} model=${c.model} apiKey=${maskKey(c.apiKey)} temperature=${c.temperature} maxTokens=${c.maxTokens} effort=${c.reasoningEffort} cacheControl=${!!c.cacheControl}` +
    (loadInfo.migrated ? `（maxTokens 旧默认值已自动提升为 ${DEFAULT_CONFIG.maxTokens}，思考模型防截断）` : ''));
  if (loadInfo.migrated) config.save(c); // 迁移结果写回磁盘，避免每次启动重复迁移
  logger.info('server', `日志目录：${path.join(DATA_DIR, 'logs')}（server.log + 按局 game-*.log）`);
  logger.info('server', '=========================================');
  // Windows 下自动打开浏览器（APP 内嵌模式不开）
  if (!process.env.NO_OPEN && !process.env.WW_DATA_DIR) {
    const { spawn } = require('child_process');
    const url = `http://localhost:${PORT}`;
    try {
      if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    } catch (_) { /* ignore */ }
  }
});

process.on('SIGINT', () => {
  logger.info('server', '正在关闭…');
  api.saveActive();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
