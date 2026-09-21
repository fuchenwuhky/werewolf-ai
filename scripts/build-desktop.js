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

/** 版本号单一来源：release-version.json（FIN-11）。desktop/package.json 里的 version
 *  只是声明点（由 scripts/version-sync.js 与权威对齐）；构建时在这里显式注入权威值，
 *  electron-builder 的 ${version}（产物名、EXE 版本资源）都以注入值为准。 */
function releaseVersion() {
  const rel = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-version.json'), 'utf8'));
  if (!rel.productVersion) throw new Error('release-version.json 缺少 productVersion');
  return rel.productVersion;
}

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
  const version = releaseVersion();
  if (!fs.existsSync(path.join(DESKTOP, 'node_modules', 'electron'))) {
    console.log('── 首次运行：安装桌面版依赖（走镜像）──');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    run(npm, ['install', '--no-audit', '--no-fund'], DESKTOP, true); // npm 本身是 .cmd，需要 shell
  }

  console.log('── 打包免安装 exe（electron-builder portable）──');
  // FIN-09：desktop/package.json 已开启 win.signAndEditExecutable（electron-builder 26 用
  // 纯 JS resedit 写 EXE 资源段，不再需要下载 winCodeSign），signExecutable:false 仅跳过签名。
  // NSIS portable 的最终 EXE 图标经 NSIS Icon 指令内嵌；版本号从 release-version.json 注入。
  // 踩过：dist 里残留旧版本的 portable exe，按后缀模糊找会捞到旧包 —— 构建前先清掉旧产物，
  // 构建后按 artifactName 精确取本版文件（build.win.artifactName 与 portable.artifactName 一致）。
  const dist = path.join(DESKTOP, 'dist');
  // 干净检出、或刚清过 dist 时这个目录还不存在（dist 由 electron-builder 创建）——
  // 少了守卫会直接 ENOENT 崩在打包前（验收发现）。
  if (fs.existsSync(dist)) {
    for (const f of fs.readdirSync(dist)) {
      if (f.endsWith('.exe') && f.includes('portable')) fs.rmSync(path.join(dist, f), { force: true });
    }
  }
  run(process.execPath, [
    binJs('electron-builder', 'electron-builder'), '--win', 'portable', '--x64',
    `-c.extraMetadata.version=${version}`,
  ], DESKTOP);

  // 产物统一收进 release/，与电脑版 zip、APK 放一起，方便分发
  const exeName = `werewolf-ai-${version}-win-x64-portable.exe`;
  if (!fs.existsSync(path.join(dist, exeName))) {
    throw new Error(`没在 ${dist} 找到 ${exeName}（electron-builder 产物名与预期不符？）`);
  }
  fs.mkdirSync(RELEASE, { recursive: true });
  const out = path.join(RELEASE, exeName);
  fs.copyFileSync(path.join(dist, exeName), out);
  const size = fs.statSync(out).size / 1048576;
  console.log(`✓ 免安装单文件：${path.relative(ROOT, out)}  ${size.toFixed(1)} MB`);
  console.log('  双击即用，自带窗口（不依赖浏览器、不弹控制台）；数据在 %APPDATA%\\werewolf-ai-desktop');

  // FIN-09 收口：对刚产出的 EXE 实检图标资源段（逐帧比对 v2 app.ico）+ 版本资源可追溯。
  // 这里失败要当成构建失败 —— "打包成功但 EXE 图标没写进去"正是本任务要消灭的假通过。
  console.log('── 校验 EXE 图标资源段（FIN-09）──');
  const vp = require('./verify-packages.js');
  const problems = [];
  const info = vp.checkExeBrandIcon('DESKTOP', out, problems);
  if (info) vp.checkExeVersion('DESKTOP', out, version, problems);
  if (problems.length) {
    console.error('✖ EXE 图标资源校验未通过：');
    for (const p of problems) console.error(`    · ${p}`);
    return 1;
  }
  console.log(`✓ EXE 图标 ${info.frames} 帧与 v2 app.ico 逐帧一致（图标组 ${info.matchedGroups.join('/')}），版本资源含 ${version}`);
  return 0;
}

process.exit(main());
