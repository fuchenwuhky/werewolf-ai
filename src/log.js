/**
 * log.js — 开发者日志系统
 * 双层输出：控制台（彩色）+ logs/ 目录 JSONL 文件（server.log 全局 + game-<id>.log 按局）。
 * 内存环形缓冲供上帝面板查看器使用；支持级别/模块过滤与错误堆栈定位。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_COLOR = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

class Logger {
  constructor(opts = {}) {
    this.level = LEVELS[opts.level] !== undefined ? opts.level : (process.env.LOG_LEVEL || 'debug');
    this.dir = opts.dir || path.join(process.cwd(), 'logs');
    this.ringSize = opts.ringSize || 2000;
    this.ring = [];       // 内存缓冲（上帝面板日志查看器）
    this._seq = 0;
    this._listeners = new Set();
    this.gameStreams = new Map(); // gameId → fs write stream
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.serverStream = fs.createWriteStream(path.join(this.dir, 'server.log'), { flags: 'a' });
    } catch (e) {
      this.serverStream = null;
      process.stderr.write(`[log] 无法创建日志目录：${e.message}\n`);
    }
  }

  /** moduleName, level, message, data? */
  log(moduleName, level, message, data) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const entry = {
      seq: ++this._seq,
      ts: Date.now(),
      time: new Date().toISOString(),
      level, module: moduleName, msg: String(message),
      data: data === undefined ? undefined : safeJson(data),
    };
    // 控制台
    const color = LEVEL_COLOR[level] || '';
    const line = `${color}[${entry.time.slice(11, 23)}][${level.toUpperCase()}][${moduleName}]${RESET} ${entry.msg}`;
    if (level === 'error') process.stderr.write(line + (entry.data ? `\n  data: ${JSON.stringify(entry.data).slice(0, 2000)}` : '') + '\n');
    else process.stdout.write(line + '\n');
    // 文件
    const jsonLine = JSON.stringify(entry) + '\n';
    if (this.serverStream) this.serverStream.write(jsonLine);
    const gid = entry.data && entry.data.gameId;
    if (gid && this.gameStreams.has(gid)) this.gameStreams.get(gid).write(jsonLine);
    // 内存环形缓冲
    this.ring.push(entry);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    for (const fn of this._listeners) { try { fn(entry); } catch (_) { /* ignore */ } }
  }

  debug(mod, msg, data) { this.log(mod, 'debug', msg, data); }
  info(mod, msg, data) { this.log(mod, 'info', msg, data); }
  warn(mod, msg, data) { this.log(mod, 'warn', msg, data); }
  error(mod, msg, data) { this.log(mod, 'error', msg, data); }

  /** 按局开启独立日志文件 */
  openGameLog(gameId) {
    try {
      const ws = fs.createWriteStream(path.join(this.dir, `game-${gameId}.log`), { flags: 'a' });
      this.gameStreams.set(gameId, ws);
    } catch (e) { this.warn('log', `无法创建对局日志文件 ${gameId}: ${e.message}`); }
  }

  closeGameLog(gameId) {
    const ws = this.gameStreams.get(gameId);
    if (ws) { ws.end(); this.gameStreams.delete(gameId); }
  }

  /** 上帝面板日志查询：级别/模块过滤 + 增量 */
  query({ afterSeq = 0, level, module: mod, limit = 500 } = {}) {
    let rows = this.ring.filter((r) => r.seq > afterSeq);
    if (level && LEVELS[level] !== undefined) rows = rows.filter((r) => LEVELS[r.level] >= LEVELS[level]);
    if (mod) rows = rows.filter((r) => r.module === mod);
    return rows.slice(-limit);
  }

  tail(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
}

function safeJson(data) {
  if (data instanceof Error) return { message: data.message, stack: data.stack };
  return data;
}

/** 掩码 API key 展示 */
function maskKey(key) {
  if (!key) return '(未设置)';
  if (key.length <= 8) return key.slice(0, 2) + '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

/**
 * 给日志器盖 gameId 戳：返回的包装器写入的每条日志 data 都带 gameId，
 * 从而被 Logger 路由到 game-<id>.log 分文件（server.log 不受影响）。
 * 引擎与该对局的 AI 调用都应使用包装后的日志器。
 */
function makeGameLogger(base, gameId) {
  const call = (name) => (mod, msg, data) => {
    if (typeof base[name] !== 'function') return;
    const stamped = data === undefined ? { gameId }
      : (data && typeof data === 'object' && !Array.isArray(data) ? { ...data, gameId } : { gameId, data });
    base[name](mod, msg, stamped);
  };
  return {
    debug: call('debug'), info: call('info'), warn: call('warn'), error: call('error'),
    openGameLog: typeof base.openGameLog === 'function' ? base.openGameLog.bind(base) : undefined,
    closeGameLog: typeof base.closeGameLog === 'function' ? base.closeGameLog.bind(base) : undefined,
    query: typeof base.query === 'function' ? base.query.bind(base) : undefined,
    tail: typeof base.tail === 'function' ? base.tail.bind(base) : undefined,
  };
}

module.exports = { Logger, maskKey, makeGameLogger };
