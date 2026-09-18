/**
 * server.js — 入口：HTTP 服务 + 静态文件 + 配置加载
 * 启动：node server.js  （或 npm start）→ 浏览器打开 http://localhost:3210
 */
'use strict';
const http = require('http');
const path = require('path');
const { Logger, maskKey } = require('./src/log');
const { Api } = require('./src/api');
const { DEFAULT_CONFIG, createConfig } = require('./src/config');

const ROOT = __dirname;
// APP 内嵌时由 capacitor-nodejs 注入 DATADIR（应用私有持久目录），也可用 WW_DATA_DIR 覆盖
const DATA_DIR = process.env.WW_DATA_DIR || process.env.DATADIR || ROOT;
const WEB_DIR = path.join(ROOT, 'web');
// 配置与数据同目录（APP 内嵌时 DATADIR 是应用私有目录），可用 WW_CONFIG 单独指定配置文件。
// WW_CONFIG 是**测试专用**入口：真实对局测试要把某一实例指向假 LLM 端点，
// 而设置页保存写的就是这个文件 —— 没有它就只能去改正式 config.json（污染风险）。
// 缺省行为与以前完全一致（DATA_DIR/config.json）。
const CONFIG_FILE = process.env.WW_CONFIG || path.join(DATA_DIR, 'config.json');
const PORT = Number(process.env.PORT || 3210);

// ---------- 配置 ----------
const config = createConfig(CONFIG_FILE);
const loadInfo = config.load();

// ---------- 日志 ----------
const logger = new Logger({ dir: path.join(DATA_DIR, 'logs'), level: process.env.LOG_LEVEL || 'debug' });

// ---------- API ----------
const api = new Api({ config, logger });

// ---------- 静态文件 ----------
// 实现搬到 src/static.js：缓存头与"缺失资源必须 404"这两条 PWA 关键行为在那边有单测
const { serveStatic } = require('./src/static');
const serveWeb = (req, res, pathname) => serveStatic(req, res, pathname, { webDir: WEB_DIR });

// 请求入口统一包装在 src/request-handler.js：畸形 URL 解码防护（REL-01）在真实请求级测试覆盖
const { createRequestHandler } = require('./src/request-handler');
// 监听地址策略（整改 SEC-01）：默认只听本机回环；WW_LAN=1 显式开放局域网并启用配对认证
const { resolveListenHost, isLoopbackAddress } = require('./src/auth');
const HOST = resolveListenHost(process.env);
const LAN_MODE = !isLoopbackAddress(HOST); // 0.0.0.0 或具体网卡地址都视为对外暴露

const server = http.createServer(createRequestHandler({ api, serveWeb, logger }));

server.listen(PORT, HOST, () => {
  // 局域网模式：启用管理会话门禁（配置/建局/令牌/列表需要配对；单局令牌通道不受影响）
  if (LAN_MODE) api.auth.setEnabled(true);
  const c = config.get();
  logger.info('server', '=========================================');
  logger.info('server', `AI 狼人杀已启动：http://localhost:${PORT}`);
  logger.info('server', LAN_MODE
    ? `⚠ 监听 ${HOST}:${PORT} —— 局域网已开放！其他设备需用配对码换取管理会话（配对码在本页设置区查看）`
    : `监听 ${HOST}:${PORT} —— 仅本机可访问（需要局域网开黑请设 WW_LAN=1 后重启）`);
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

let closing = false;
async function shutdown() {
  if (closing) return process.exit(0); // 第二次信号：立即退出
  closing = true;
  logger.info('server', '正在关闭…（等待活动对局落盘）');
  server.close();
  try {
    const saved = await Promise.race([
      api.saveActive(),
      new Promise((r) => setTimeout(() => r(-1), 4000)), // 总闸：4s 内必须退出
    ]);
    logger.info('server', saved >= 0 ? `活动对局已落盘（${saved} 局）` : '落盘等待超时，强制退出');
  } catch (_) { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
