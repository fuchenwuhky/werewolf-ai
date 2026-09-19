/**
 * build-win.js — 打包 Windows 免安装版（电脑版）
 *
 * 目标：双击一个 .cmd 就能玩，不需要用户装 Node，也不需要管理员权限。
 * 所以包里带一份 node.exe（就是本机跑这个脚本的 node），服务端与网页按原样放进去，
 * config.json / saves/ / logs/ 都留在包内 —— 整个文件夹拷走就是"带着存档搬家"，删掉就是卸载。
 *
 * 为什么不用 pkg / nexe / Electron：
 *   ① 本项目刻意零运行时依赖，Electron 会把包从 100MB 级推到 300MB 级，还多一层 chromium；
 *   ② pkg 已停止维护，nexe 要下载 Node 基座二进制（构建要联网且不可复现）；
 *   ③ 现成 node.exe + 原样源码是最可复现、最容易排查的做法（出问题直接看 .cmd 窗口里的日志）。
 *
 * 用法：npm run app:win
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');

/** 版本号单一来源：release-version.json（FIN-11）。
 *  曾经从 build.gradle 抓 versionName —— 那是安卓包的声明点，不是权威；两端发同一版，
 *  都应该以 release-version.json 为准（一致性由 scripts/version-sync.js 校验）。 */
function appVersion() {
  const rel = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-version.json'), 'utf8'));
  if (!rel.productVersion) throw new Error('release-version.json 缺少 productVersion');
  return rel.productVersion;
}

const VERSION = appVersion();
const NAME = `werewolf-ai-${VERSION}-win-x64`;
const OUT = path.join(RELEASE, NAME);

/** 打进包里的东西。刻意不含 config.json（里面有用户的 API Key）、saves/、logs/、test/、app/、.git */
const INCLUDE = ['server.js', 'package.json', 'config.example.json', 'README.md', 'src', 'web', 'docs',
  path.join('scripts', 'mock-agent.js')];

function copyRecursive(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copyRecursive(path.join(src, name), path.join(dest, name));
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function main() {
  console.log(`── 打包电脑版 ${VERSION} ──`);
  // 上次踩过：直接把 release 目录删干净，会把用户自己填的 config.json 和存档一起删掉
  const keep = {};
  for (const name of ['config.json', 'saves', 'logs']) {
    const p = path.join(OUT, name);
    if (fs.existsSync(p)) keep[name] = p;
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // 1) 源码与网页
  for (const rel of INCLUDE) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) { console.warn(`  跳过（不存在）：${rel}`); continue; }
    copyRecursive(src, path.join(OUT, rel));
  }
  // package.json 里的 devDependencies / scripts 对使用者没意义，清成最小集，避免误导
  const pkg = JSON.parse(fs.readFileSync(path.join(OUT, 'package.json'), 'utf8'));
  const mini = { name: 'werewolf-ai-server', version: VERSION, private: true, main: './server.js', license: pkg.license || 'UNLICENSED' };
  fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(mini, null, 2) + '\n', 'utf8');

  // 2) Node 运行时（含它自己的 LICENSE —— 分发 Node 二进制必须带）
  const nodeExe = process.execPath;
  const nodeInPkg = path.join(OUT, 'node.exe');
  fs.copyFileSync(nodeExe, nodeInPkg);
  const nodeLicense = path.join(path.dirname(nodeExe), 'LICENSE');
  if (fs.existsSync(nodeLicense)) fs.copyFileSync(nodeLicense, path.join(OUT, 'LICENSE.node.txt'));
  console.log(`  已内置 ${path.basename(nodeExe)}（${process.version}）`);

  // 2.5) FIN-09：把 v2 app.ico 写进 node.exe 的图标资源段 —— 这是包里唯一的 EXE，
  // 控制台窗口/任务栏/资源管理器显示的图标都来自它的 .rsrc。写完自检（逐帧比对），
  // 失败即构建失败；然后才打 zip（构建 → 改图标 → 再打包）。
  console.log('  ── 写入 EXE 图标资源（FIN-09）──');
  require('./set-exe-icon.js').applyTo(nodeInPkg);

  // 3) 启动器（必须纯 ASCII）+ 4) 说明
  writeBatch(path.join(OUT, '启动 AI 狼人杀.cmd'), LAUNCHER);
  // 说明书写 UTF-8 **带 BOM**：中文 Windows 的记事本对无 BOM 的 UTF-8 会当 ANSI 打开而乱码
  fs.writeFileSync(path.join(OUT, '使用说明.txt'), '\uFEFF' + readme(), 'utf8');

  // 还原被保留的用户数据
  for (const [name, p] of Object.entries(keep)) {
    copyRecursive(p, path.join(OUT, name));
    console.log(`  保留原有的 ${name}`);
  }

  // 5) 压缩（用 PowerShell 的 Compress-Archive，避免引入 zip 依赖）
  const zip = path.join(RELEASE, `${NAME}.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${OUT}' -DestinationPath '${zip}' -CompressionLevel Optimal`], { stdio: 'inherit' });

  const dirSize = sizeOf(OUT);
  const zipSize = fs.statSync(zip).size;
  console.log(`✓ 文件夹：${path.relative(ROOT, OUT)}  ${(dirSize / 1048576).toFixed(1)} MB`);
  console.log(`✓ 压缩包：${path.relative(ROOT, zip)}  ${(zipSize / 1048576).toFixed(1)} MB`);
  console.log('  分发这个 zip：解压到任意可写目录（桌面 / D 盘都行），双击"启动 AI 狼人杀.cmd"');
}

/** 启动器必须是**纯 ASCII**，并且构建时断言这一点。
 *
 *  踩坑记录（两次都栽在编码上）：
 *  ① 写成 UTF-8：cmd.exe 在中文 Windows 上用自己的 ANSI 代码页(936)解析批处理文件，
 *     中文行被读成乱码，行内字节还被当作命令分隔符 → 实测报
 *     `'鑷姩鎵撳紑' 不是内部或外部命令`（「自动打开」的 UTF-8 字节）。
 *  ② 改写成 GBK：在控制台被设成 UTF-8(65001) 的环境里又反过来被误读成
 *     `'鍚姩' is not recognized...`。而且 .cmd 内的 chcp **不影响**当前文件后续行的解析代码页，
 *     所以"文件里先 chcp 再写中文"救不了。
 *  ⇒ 只有当文件全部是 ASCII 时才与代码页无关：936 和 65001 下 ASCII 都是合法子集。
 *     中文提示改由服务端自己的日志给出（Node 输出 UTF-8，启动器先 chcp 65001 就能正确显示），
 *     以及同目录的《使用说明.txt》（UTF-8 with BOM）。
 */
function writeBatch(file, text) {
  const bad = [...text].find((ch) => ch.charCodeAt(0) > 0x7f);
  if (bad) throw new Error(`启动器含非 ASCII 字符 ${JSON.stringify(bad)} —— 会在中文 Windows 上解析失败`);
  fs.writeFileSync(file, text, 'ascii');
}

function sizeOf(dir) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    n += st.isDirectory() ? sizeOf(p) : st.size;
  }
  return n;
}

// 启动器：**只允许 ASCII**（见 writeBatch 的踩坑记录）。
// chcp 65001 放在最前面：后面所有行都是 ASCII，不受解析代码页影响；
// 而它能让 node 输出的中文日志（UTF-8）在窗口里正确显示 —— 中文提示由服务端给出。
const LAUNCHER = `@echo off
chcp 65001 >nul
title AI Werewolf
cd /d "%~dp0"
if not exist "%~dp0node.exe" goto nonode
echo.
echo   AI Werewolf 1.4  -  starting the local server ...
echo   Browser opens http://localhost:3210 automatically.
echo   Keep this window open while playing; close it to stop the server.
echo   Saves are in .\\saves\\ , config and logs are in this folder.
echo.
"%~dp0node.exe" server.js
if errorlevel 1 goto fail
goto :eof

:nonode
echo.
echo   [ERROR] node.exe not found. Please re-extract the whole folder.
echo.
pause
goto :eof

:fail
echo.
echo   [ERROR] Failed to start. The usual cause is port 3210 already in use.
echo   Try another port:  set PORT=3310   then run this file again.
echo   Details: see the output above, or logs\\server.log
echo.
pause
`;

function readme() {
  return `AI 狼人杀 ${VERSION} · Windows 免安装版
========================================

【怎么启动】
  双击「启动 AI 狼人杀.cmd」。
  会弹出一个小黑窗口（那是服务端，别关），浏览器自动打开 http://localhost:3210 开始玩。
  关掉小黑窗口 = 结束服务。
  注：小黑窗口里的提示是英文的 —— 那是刻意的，中文写进批处理文件会在不同代码页的
  命令行窗口里被读成乱码甚至当成命令执行（见下面「为什么窗口是英文」）。服务端自己的
  中文日志（如「AI 狼人杀已启动」）会正常显示在同一个窗口里。

【需要准备什么】
  · Windows 10 / 11 64 位。不需要装 Node，已内置。
  · 一个 OpenAI 兼容的接口：在首页「API 配置」里填 base_url、模型名、API Key，点「保存配置」。
    模型名可以点「拉取模型」从接口读，也可以手填。
  · 调用 AI 需要能访问你填的接口地址（公司代理 / 防火墙可能拦，日志窗口里能看到报错）。

【数据在哪】
  config.json（接口配置，含 Key）、saves\\（存档）、logs\\（日志）都在这个文件夹里。
  · 想搬家：整个文件夹拷走即可，存档与配置一起走。
  · 想卸载：直接删掉这个文件夹。
  · 注意别把它放在需要管理员权限才能写的目录里（如 C:\\Program Files），否则存档写不进去。

【想用手机一起看 / 玩】
  手机与电脑连同一个 WiFi，在手机浏览器打开：http://<电脑的局域网IP>:3210/m/
  · 查电脑 IP：在 cmd 里执行 ipconfig，看「IPv4 地址」，通常形如 192.168.x.x
  · 首次启动若弹出 Windows 防火墙提示，勾选「专用网络」并允许，手机才连得上。
  · 手机端会自动跳到移动版界面（电脑上想看移动版：http://localhost:3210/m/）。

【端口被占用】
  默认 3210。换端口：在这个文件夹里开 cmd，执行
      set PORT=3310
      node.exe server.js

【这个版本是什么】
  与安卓版 1.4 同源：同一份服务端与网页。电脑版不带安卓壳，直接跑 Node 服务端 + 浏览器。

【为什么窗口是英文】
  批处理文件（.cmd）的编码必须与控制台代码页一致，而中文 Windows 默认是 GBK(936)、
  有些终端是 UTF-8(65001)，写中文总有一边会乱码，乱码字节还可能被当成命令分隔符执行。
  所以启动器只用 ASCII（任何代码页下都合法），中文提示放到本文件与服务端日志里。
`;
}

main();
