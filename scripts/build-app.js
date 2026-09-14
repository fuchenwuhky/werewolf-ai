#!/usr/bin/env node
/**
 * build-app.js — 同步服务端到 Capacitor APP 壳工程（app/www）
 * 用法：node scripts/build-app.js
 * 零依赖；排除日志/存档/配置等运行时数据。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP_WWW = path.join(ROOT, 'app', 'www');
const NODE_DIR = path.join(APP_WWW, 'nodejs');

const SKIP = new Set(['node_modules', '.git', 'logs', 'saves', 'config.json', 'app', 'test', 'docs', '.zcode']);

function copyRecursive(src, dest) {
  const base = path.basename(src);
  if (SKIP.has(base)) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copyRecursive(path.join(src, name), path.join(dest, name));
  } else if (st.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// 1. 服务端 → app/www/nodejs
fs.rmSync(NODE_DIR, { recursive: true, force: true });
fs.mkdirSync(NODE_DIR, { recursive: true });
for (const name of ['server.js', 'package.json', 'src', 'web', path.join('scripts', 'mock-agent.js')]) {
  copyRecursive(path.join(ROOT, name), path.join(NODE_DIR, name));
}

// 2. nodejs 目录的 package.json：指定 Node 入口
fs.writeFileSync(path.join(NODE_DIR, 'package.json'), JSON.stringify({
  name: 'werewolf-ai-server', version: '1.0.0', private: true, main: './server.js',
}, null, 2));

// 3. 壳页面：启动内嵌 Node → 等服务就绪 → 跳转
fs.writeFileSync(path.join(APP_WWW, 'index.html'), `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0a10">
<title>AI 狼人杀</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; align-items: center; justify-content: center; background: #0b0a10; color: #c9a227;
         font-family: "Microsoft YaHei", sans-serif; font-size: 15px; letter-spacing: 2px; text-align: center; }
</style>
</head>
<body>
<div id="st">🕯 正在点燃烛火…</div>
<script>
(async () => {
  const st = document.getElementById('st');
  const Cap = window.Capacitor;
  const NodeJS = Cap && Cap.Plugins && (Cap.Plugins.NodeJS || Cap.Plugins.CapacitorNodeJS);
  if (!NodeJS) { st.textContent = '⚠ 未检测到内嵌引擎'; return; }
  const withTimeout = (p, ms) => Promise.race([Promise.resolve(p), new Promise((res) => setTimeout(res, ms))]);
  try {
    let dataDir = '';
    try { const dp = await withTimeout(NodeJS.getDataPath(), 2000); dataDir = (dp && dp.path) ? dp.path : String(dp || ''); } catch (e) {}
    if (!dataDir) dataDir = '/data/data/com.werewolfai.app/files';
    await withTimeout(NodeJS.start({ env: { WW_DATA_DIR: dataDir, PORT: '3210', NO_OPEN: '1', LOG_LEVEL: 'info' } }), 8000);
  } catch (e) { /* 已在运行则忽略 */ }
  const base = 'http://127.0.0.1:3210';
  let navigated = false;
  const go = () => { if (!navigated) { navigated = true; location.replace(base + '/m/'); } };
  // 服务就绪即跳；fetch 受 WebView 混合内容策略影响时，10 秒后直接盲跳（导航不受限）
  for (let i = 0; i < 25; i++) {
    try {
      const r = await fetch(base + '/api/meta');
      if (r.ok) { go(); return; }
    } catch (e) { /* 被拦或未就绪 */ }
    st.textContent = '🕯 正在唤醒引擎… ' + '✦'.repeat((i % 6) + 1);
    await new Promise((res) => setTimeout(res, 400));
  }
  go();
})();
</script>
</body>
</html>
`);

console.log('✓ APP 工程已同步 → app/www（nodejs 服务端 + 壳页面）');
