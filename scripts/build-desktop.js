/**
 * build-desktop.js — 打包电脑版（Electron 桌面应用，免安装单文件 exe）
 *
 * 用法：npm run app:desktop
 *
 * 两个必须写在脚本里的环境变量：electron 与 electron-builder 默认都从 GitHub 下载
 * 预编译二进制（electron 本体、NSIS、winCodeSign），而这台机器到 github.com 的 HTTPS
 * 是超时的（实测 ETIMEDOUT 20.205.243.166:443，只有 SSH 443 通）。
 * 用 npmmirror 镜像后同样 16 秒装完，所以这里默认走镜像，且允许用同名环境变量覆盖。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');
const RELEASE = path.join(ROOT, 'release');

process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/';

function run(cmd, args, cwd, shell) {
  console.log(`$ ${path.basename(cmd)} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: process.env, shell: !!shell });
}

/** 解析某个包的 bin 入口 js 路径：Windows 上不能用 execFileSync 直接拉 .cmd/.bat
 *  （Node 从 CVE-2024-27980 起在无 shell 时对批处理文件抛 EINVAL），所以一律走 js 入口。 */
function binJs(pkg, name) {
  const dir = path.join(DESKTOP, 'node_modules', pkg);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin[name];
  return path.join(dir, rel);
}

function main() {
  if (!fs.existsSync(path.join(DESKTOP, 'node_modules', 'electron'))) {
    console.log('── 首次运行：安装桌面版依赖（走镜像）──');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    run(npm, ['install', '--no-audit', '--no-fund'], DESKTOP, true); // npm 本身是 .cmd，需要 shell
  }

  console.log('── 打包免安装 exe（electron-builder portable）──');
  run(process.execPath, [binJs('electron-builder', 'electron-builder'), '--win', 'portable', '--x64'], DESKTOP);

  // 产物统一收进 release/，与电脑版 zip、APK 放一起，方便分发
  const dist = path.join(DESKTOP, 'dist');
  const exe = fs.readdirSync(dist).find((f) => f.endsWith('.exe') && f.includes('portable'));
  if (!exe) throw new Error(`没在 ${dist} 找到 portable exe`);
  fs.mkdirSync(RELEASE, { recursive: true });
  const out = path.join(RELEASE, exe);
  fs.copyFileSync(path.join(dist, exe), out);
  const size = fs.statSync(out).size / 1048576;
  console.log(`✓ 免安装单文件：${path.relative(ROOT, out)}  ${size.toFixed(1)} MB`);
  console.log('  双击即用，自带窗口（不依赖浏览器、不弹控制台）；数据在 %APPDATA%\\werewolf-ai-desktop');
}

main();
