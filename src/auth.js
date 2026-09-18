/**
 * auth.js — 管理会话与局域网配对（整改 SEC-01）
 *
 * 信任模型（两层能力边界）：
 *   1. 管理会话：读取/修改配置、列出对局、取令牌、创建对局、统计 —— 本模块负责。
 *      · 服务只绑定回环时（默认），每个连接必然来自本机 → 自动视为管理会话，行为与旧版一致；
 *      · 显式 WW_LAN=1 开放局域网后，远端设备必须用一次性配对码换取会话 Cookie。
 *   2. 对局能力令牌：玩家/上帝令牌继续按原有方式访问单局资源（含 SSE、复盘），
 *      令牌在请求体/查询串里随行，攻击者无从伪造，天然免疫 CSRF。
 *
 * 安全细节：
 *   · 配对码 6 位数字、crypto 随机、5 分钟过期、最多 5 次失败锁定、60s 生成节流；
 *   · 会话 ID 为 32 字节高熵随机，服务端只存 SHA-256 摘要，不存明文；
 *   · Cookie 属性 HttpOnly + SameSite=Strict（本地 HTTP 场景不设 Secure，HTTPS 部署由反向代理终结）；
 *   · 会话有 TTL 与数量上限，吊销即时生效。
 */
'use strict';
const crypto = require('crypto');
const os = require('os');

const CODE_TTL_MS = 5 * 60 * 1000;
const CODE_REUSE_INTERVAL_MS = 60 * 1000;
const MAX_CODE_FAILURES = 5;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 8;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/** 归一化对端地址并判断是否本机回环（兼容 ::ffff:127.0.0.1 这类 IPv4-mapped 写法） */
function isLoopbackAddress(remoteAddress) {
  if (!remoteAddress) return false;
  const addr = String(remoteAddress).replace(/^::ffff:/i, '');
  return addr === '127.0.0.1' || addr === '::1';
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // 长度不同也要做一次比较，避免用时长泄漏长度信息
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

class AuthManager {
  constructor({ logger = null, enabled = false } = {}) {
    this.logger = logger;
    this.enabled = !!enabled;          // 只有绑定非回环地址时才置 true（server.js 决定）
    this.sessions = new Map();         // sha256(sessionId) → { expiresAt, pairedAt, label }
    this.code = null;                  // { hash, digits, expiresAt }
    this.lastCodeAt = 0;
    this.failures = 0;
    this.lockedUntil = 0;
  }

  /** LAN 模式开关（server.js 按 host 判定后调用；关闭时所有请求按旧逻辑放行） */
  setEnabled(on) {
    this.enabled = !!on;
    if (!on) { this.sessions.clear(); this.code = null; this.failures = 0; this.lockedUntil = 0; }
  }

  /**
   * 请求是否具备管理会话权限。
   * @param req http.IncomingMessage（读取 socket.remoteAddress 与 cookie）
   * @param opts.forceRemote 测试注入：把回环连接也按远端对待（验证 LAN 门禁本身）
   */
  isManagement(req, { forceRemote = false } = {}) {
    // DNS rebinding 防护（审核 P0-2）：Host 头必须命中本机地址白名单。
    // 恶意域名 rebind 到 127.0.0.1 时，请求源地址确实是回环，但 Host 是攻击者域名 → 拒绝。
    if (!isTrustedHostHeader(req.headers && req.headers.host)) return false;
    if (!this.enabled) return true; // 本机模式：与旧版行为一致，全放行
    if (!forceRemote && isLoopbackAddress(req.socket && req.socket.remoteAddress)) return true;
    const sid = this.sessionIdFrom(req);
    return this.verifySession(sid);
  }

  sessionIdFrom(req) {
    const header = req.headers && req.headers.cookie;
    if (!header) return null;
    for (const part of String(header).split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      if (k === 'ww_session') return part.slice(idx + 1).trim();
    }
    return null;
  }

  /** 生成新的配对码。60s 内重复调用返回同一个码，避免被刷屏式重置 */
  newPairingCode(now = Date.now()) {
    if (!this.enabled) throw new Error('本机模式无需配对');
    if (this.code && now - this.lastCodeAt < CODE_REUSE_INTERVAL_MS && now < this.code.expiresAt) {
      return { expiresInMs: this.code.expiresAt - now };
    }
    if (now < this.lockedUntil) throw new Error('失败次数过多，请稍后再试');
    const digits = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    // digits 明文只在本机回环查询时展示（给局域网设备输入用），网络上从不回显
    this.code = { hash: sha256(digits), digits, expiresAt: now + CODE_TTL_MS };
    this.lastCodeAt = now;
    this.failures = 0;
    return { expiresInMs: CODE_TTL_MS };
  }

  /** 当前有效配对码（仅供本机管理会话展示给用户看） */
  currentCode(now = Date.now()) {
    if (!this.enabled || !this.code || now > this.code.expiresAt) return null;
    return { code: this.code.digits, expiresInMs: this.code.expiresAt - now };
  }

  /** 用配对码换取会话。返回 sessionId（调用方负责写 Cookie）；失败抛错并计数 */
  pair(code, now = Date.now()) {
    if (!this.enabled) throw new Error('本机模式无需配对');
    if (now < this.lockedUntil) throw new Error('失败次数过多，请稍后再试');
    if (!this.code || now > this.code.expiresAt) throw new Error('配对码已过期，请重新生成');
    if (!timingSafeEqualStr(sha256(String(code || '').trim()), this.code.hash)) {
      this.failures++;
      if (this.failures >= MAX_CODE_FAILURES) {
        this.lockedUntil = now + CODE_TTL_MS;
        this.code = null;
        throw new Error('失败次数过多，配对已锁定，请稍后再试');
      }
      throw new Error(`配对码不正确（剩余 ${MAX_CODE_FAILURES - this.failures} 次机会）`);
    }
    this.code = null; // 一次性：配对成功即作废
    this.failures = 0;
    return this.issueSession(now);
  }

  issueSession(now = Date.now()) {
    const sessionId = crypto.randomBytes(32).toString('hex');
    // 数量上限：最旧的先过期
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].pairedAt - b[1].pairedAt)[0];
      if (oldest) this.sessions.delete(oldest[0]);
    }
    this.sessions.set(sha256(sessionId), { expiresAt: now + SESSION_TTL_MS, pairedAt: now, label: '' });
    return sessionId;
  }

  verifySession(sessionId, now = Date.now()) {
    if (!sessionId) return false;
    const rec = this.sessions.get(sha256(String(sessionId)));
    if (!rec) return false;
    if (now > rec.expiresAt) { this.sessions.delete(sha256(String(sessionId))); return false; }
    return true;
  }

  revoke(sessionId) {
    this.sessions.delete(sha256(String(sessionId || '')));
  }

  /** 会话 Cookie 的完整 Set-Cookie 值 */
  sessionCookie(sessionId) {
    return `ww_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  }
}

/** 状态改变请求的 Origin/Host 校验：仅约束走 Cookie/回环的管理操作；
 *  携带对局令牌的请求不经 Cookie，天然免疫 CSRF，不做此检查（Capacitor 壳的 origin 是
 *  https://localhost，与 Host 头天然不同，误杀会打断 APP）。 */
function isTrustedOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true; // 非浏览器客户端（curl、Electron 主进程、同源 GET）
  let oh;
  try { oh = new URL(origin).host; } catch (_) { return false; }
  const host = req.headers.host || '';
  if (oh === host) return true;
  // Capacitor / WebView 壳固定使用 localhost origin
  const ohHostname = oh.replace(/:\d+$/, '');
  if (ohHostname === 'localhost' || ohHostname === '127.0.0.1') return true;
  return false;
}

/** Host 头白名单：localhost/回环/本机所有网卡地址（含端口剥离）。rebind 域名不在表内 */
function isTrustedHostHeader(host, now = Date.now()) {
  if (!host) return true; // 非浏览器客户端（curl、Electron 主进程、HTTP/1.0）
  let h = String(host).trim().toLowerCase();
  if (h.includes('@')) return false; // user-info 形式直接拒绝
  if (h.startsWith('[')) { const end = h.indexOf(']'); if (end !== -1) h = h.slice(1, end); }
  else h = h.replace(/:[0-9]+$/, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  // 本机网卡地址（缓存 5s，避免每请求枚举）
  if (!isTrustedHostHeader._ifs || now - isTrustedHostHeader._ifs.at > 5000) {
    const set = new Set();
    try {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const it of list || []) set.add(String(it.address).toLowerCase());
      }
    } catch (_) { /* ignore */ }
    isTrustedHostHeader._ifs = { at: now, set };
  }
  return isTrustedHostHeader._ifs.set.has(h);
}

module.exports = { AuthManager, isLoopbackAddress, isTrustedOrigin, isTrustedHostHeader, sha256, resolveListenHost };

/**
 * 监听地址解析（整改 SEC-01 的 3.1 决策）：
 *   · 默认 127.0.0.1 —— 单机使用（浏览器/Electron/本机调试）零配置即安全；
 *   · WW_LAN=1 —— 显式开放局域网（0.0.0.0），并启用配对认证；
 *   · WW_HOST —— 高级覆盖（多网卡绑定指定地址），风险由使用者自负。
 */
function resolveListenHost(env = process.env) {
  if (env.WW_HOST && String(env.WW_HOST).trim()) return String(env.WW_HOST).trim();
  if (String(env.WW_LAN) === '1') return '0.0.0.0';
  return '127.0.0.1';
}
