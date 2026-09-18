/**
 * request-handler.js — HTTP 请求入口的统一包装（从 server.js 抽出以便真实请求级测试）
 *
 * 为什么单独存在（审核 REL-01 / VAL-01）：
 *   ① `decodeURIComponent` 遇到 `/%`、`%zz` 这类畸形转义段会抛 URIError——以前这行裸奔在
 *      createServer 回调里，一个恶意/损坏的 URL 就能把整个进程带走（未捕获异常直接退出）。
 *      现在解码失败返回 400，只影响当前请求。
 *   ② 请求体大小上限与 JSON 约束在 API 层已有（readBody limit），这里负责把"解析失败"类
 *      错误映射成语义正确的状态码（413/400 而不是清一色 500）。
 */
'use strict';

/** 安全解码 URL 路径；畸形转义（/%、%zz、残缺的 UTF-8 序列）返回 null */
function decodePath(raw) {
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return null;
  }
}

/**
 * 创建请求处理器。参数：
 *   api      — Api 实例（/api/* 全部交给它）
 *   serveWeb — (req, res, pathname) => void 静态文件服务
 *   logger   — Logger
 */
function createRequestHandler({ api, serveWeb, logger }) {
  return function handle(req, res) {
    const { URL } = require('url');
    let u;
    try {
      u = new URL(req.url, 'http://localhost');
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'bad request' }));
    }
    const pathname = decodePath(u.pathname);
    if (pathname === null) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'bad request: malformed URL encoding' }));
    }
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
        const msg = String(e.message || e);
        const code = /请求体过大/.test(msg) ? 413 : /Content-Type 必须是/.test(msg) ? 415 : /JSON 解析失败/.test(msg) ? 400 : 500;
        logger.error('api', `未捕获接口错误: ${msg}`, { stack: e.stack });
        try {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: msg }));
        } catch (_) { /* ignore */ }
      });
      return;
    }
    serveWeb(req, res, pathname);
  };
}

module.exports = { createRequestHandler, decodePath };
