/**
 * monitor.js — 对局实时监控（开发者辅助，只读）
 * 监控内容：LLM 每次调用（模型/token/耗时）、WARN/ERROR、流程推进、停滞检测。
 * 用法：node scripts/monitor.js [最长分钟数=45]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const PORT = Number(process.env.PORT || 3210);
const MAX_MINUTES = Number(process.argv[2] || 45);
const state = new Map(); // file → { size, inode }
let lastNew = Date.now();
let waitingHuman = false;
let lastLLM = null;
let errors = 0;
const seen = new Set(); // 跨文件去重（server.log 与 game-*.log 内容重叠）
let sawActivity = false; // 本窗口是否见过任何日志活动（区分“空闲”与“活动后断流”）
let idleNoted = false;
let gameEnded = false;   // 最近一次活动以“对局结束”收尾 → 之后安静属正常
const STALL_SECS = 330;  // LLM 单次调用上限 6 分钟，阈值要盖过它
let serverDown = false; // 服务健康探针状态

async function pingServer() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(`http://localhost:${PORT}/api/meta`, { signal: ctl.signal });
    clearTimeout(t);
    if (serverDown && r.ok) console.log('[monitor] ✅ 服务已恢复响应');
    serverDown = !r.ok;
  } catch (_) {
    if (!serverDown) console.log(`[monitor] 🛑 服务无响应（http://localhost:${PORT}）——服务器可能已退出！`);
    serverDown = true;
  }
}

function files() {
  try {
    return fs.readdirSync(LOG_DIR).filter((f) => f === 'server.log' || /^game-.*\.log$/.test(f)).map((f) => path.join(LOG_DIR, f));
  } catch (_) { return []; }
}

function fmt(entry) {
  const t = new Date(entry.ts).toTimeString().slice(0, 8);
  let line = `[${t}][${entry.level}][${entry.module}] ${entry.msg.replace(/\n/g, ' ')}`;
  if (entry.data && typeof entry.data === 'object') {
    if (entry.data.model) line += ` (${entry.data.model})`;
    if (entry.data.stack) line += `\n    ${String(entry.data.stack).split('\n').slice(0, 3).join('\n    ')}`;
  }
  return line;
}

function interesting(entry) {
  if (entry.level === 'warn' || entry.level === 'error') return true;
  if (entry.module === 'llm') return true; // 每次 LLM 调用
  if (entry.module === 'engine' && entry.level === 'info') return true; // 发牌/等待人类/对局结束
  return false;
}

function check() {
  for (const f of files()) {
    let st;
    try { st = fs.statSync(f); } catch (_) { continue; }
    const prev = state.get(f);
    if (!prev) { state.set(f, { size: st.size }); continue; } // 首次只记位，不回放历史
    if (st.size === prev.size) continue;
    if (st.size < prev.size) { state.set(f, { size: st.size }); continue; }
    let added = '';
    try {
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(st.size - prev.size);
      fs.readSync(fd, buf, 0, buf.length, prev.size);
      fs.closeSync(fd);
      added = buf.toString('utf8');
    } catch (_) { continue; }
    state.get(f).size = st.size;
    for (const lineRaw of added.split('\n')) {
      if (!lineRaw.trim()) continue;
      let e;
      try { e = JSON.parse(lineRaw); } catch (_) { continue; }
      if (e.level === 'error') errors++;
      if (e.module === 'llm') lastLLM = Date.now();
      if (/等待人类玩家/.test(e.msg || '')) waitingHuman = true;
      else if (e.module === 'engine' && e.level === 'info' && !/等待人类玩家/.test(e.msg || '')) waitingHuman = false;
      if (e.module === 'engine' && /对局结束|手动终止并结算|已被手动终止/.test(e.msg || '')) { gameEnded = true; idleNoted = false; }
      if (interesting(e)) console.log(fmt(e));
    }
    lastNew = Date.now();
    sawActivity = true;
  }
}

console.log(`[monitor] 开始监控 logs/（最长 ${MAX_MINUTES} 分钟，Ctrl 语义：只读不动对局）`);
const timer = setInterval(() => {
  check();
  pingServer();
  const quiet = (Date.now() - lastNew) / 1000;
  if (gameEnded && quiet > 90) {
    if (!idleNoted) { console.log('[monitor] …对局已结束，进入空闲'); idleNoted = true; }
  } else if (quiet > STALL_SECS && !waitingHuman) {
    if (!sawActivity) {
      // 整个窗口没有任何日志：多半是没有进行中的对局（空闲），不是停滞
      if (!idleNoted) { console.log('[monitor] …无进行中对局（空闲，本窗口未见任何对局活动）'); idleNoted = true; }
    } else {
      console.log(`[monitor] ⚠️ 已 ${Math.round(quiet)}s 无新日志且非等待人类——可能停滞（LLM 卡住/引擎异常），请检查`);
    }
  } else if (quiet > 45 && waitingHuman) {
    console.log(`[monitor] …等待人类玩家操作中（${Math.round(quiet)}s，正常，无时限）`);
  }
}, 3000);
check();
setTimeout(() => { console.log(`[monitor] 监控结束，共捕获 ${errors} 条 error`); clearInterval(timer); process.exit(0); }, MAX_MINUTES * 60 * 1000);
