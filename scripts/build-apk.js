/**
 * build-apk.js — 安卓包一键构建（Windows 上也能用，**不依赖 bash**）
 *
 * 为什么另起一个脚本：仓库原有的 `scripts/update-app.sh` 靠 `bash`，
 * 而本机的 `bash` 是 **WSL** 的 —— WSL 里没有 Windows 的 node，
 * 于是它在第 7 行 `node scripts/build-app.js` 直接 `node: command not found`，
 * **但外层拿到的退出码仍是 0**（极易误判成功）。这里用 Node 自己串流程，杜绝这类假成功。
 *
 * 四步：① 同步服务端到 app/www → ② cap sync android → ③ gradle assembleDebug
 *      → ④ 拷进 release/ 并**校验包内源码**（不是当前源码就退出码 1）。
 * 第 ④ 步是关键：实测踩过"跳过 cap sync 导致 APK 装的是上一批代码，而 gradle 退出码 0"。
 *
 * 用法：node scripts/build-apk.js [--install]
 *   --install  构建后 adb install -r 到已连接的设备（默认不装）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const ANDROID = path.join(APP, 'android');
const RELEASE = path.join(ROOT, 'release');
const APK_OUT = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

const isWin = process.platform === 'win32';
const run = (label, cmd, args, opts = {}) => {
  console.log(`── ${label} ──`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.error) throw new Error(`${label} 无法启动：${r.error.message}`);
  if (r.status !== 0) throw new Error(`${label} 失败（退出码 ${r.status}）`);
};

function main(argv) {
  // FIN-11：版本单一来源是 release-version.json（verify-packages.readVersion 负责读取，
  // 并交叉核对 build.gradle 的 versionName —— 不一致直接失败，指向 version-sync --fix）
  const version = require('./verify-packages').readVersion();
  console.log(`── 打包安卓版 ${version} ──`);

  run('1/4 同步服务端到 APP 工程', process.execPath, [path.join('scripts', 'build-app.js')]);
  // npx 在 Windows 上是 npx.cmd；用 shell 让 .cmd 能被解析
  run('2/4 cap sync android（必须做：它才把 app/www 刷进 android assets）',
    isWin ? 'npx.cmd' : 'npx', ['cap', 'sync', 'android'], { cwd: APP, shell: isWin });

  const env = {
    ...process.env,
    JAVA_HOME: process.env.JAVA_HOME || 'D:\\jdk-21.0.12.1+1',
    ANDROID_HOME: process.env.ANDROID_HOME || 'D:\\android-sdk',
  };
  if (!fs.existsSync(env.JAVA_HOME)) throw new Error(`找不到 JDK：${env.JAVA_HOME}`);
  if (!fs.existsSync(env.ANDROID_HOME)) throw new Error(`找不到 Android SDK：${env.ANDROID_HOME}`);
  // gradlew.bat 是批处理：Node 在 Windows 上必须经 shell 启动（否则直接 EINVAL）
  run('3/4 gradle assembleDebug', isWin ? 'gradlew.bat' : './gradlew', ['assembleDebug', '--no-daemon', '-q'], { cwd: ANDROID, env, shell: isWin });

  if (!fs.existsSync(APK_OUT)) throw new Error(`gradle 报告成功，但没找到产物：${APK_OUT}`);
  fs.mkdirSync(RELEASE, { recursive: true });
  const dest = path.join(RELEASE, `werewolf-ai-${version}-debug.apk`);
  fs.copyFileSync(APK_OUT, dest);
  console.log(`── 4/4 收取产物 ──\n✓ ${path.relative(ROOT, dest)}  ${(fs.statSync(dest).size / 1048576).toFixed(1)} MB`);

  // 校验：包里必须就是当前源码。这里失败要当成构建失败，而不是"提示一下"。
  const v = require('./verify-packages');
  const r = v.verifyApk(dest);
  if (r.problems.length) {
    console.error('✖ 包内容校验未通过（包里不是当前源码，先别分发）：');
    for (const p of r.problems.slice(0, 12)) console.error(`    · ${p}`);
    return 1;
  }
  console.log(`✓ 包内容校验通过：与当前源码一致（${r.checked} 个文件全部内容比对，含二进制哈希；品牌资源字节一致 ${r.brandInfo.byte} / 像素一致 ${r.brandInfo.pixel}）`);

  if (argv.includes('--install')) {
    console.log('── 安装到设备 ──');
    const r2 = spawnSync('adb', ['install', '-r', dest], { stdio: 'inherit' });
    if (r2.status !== 0) { console.error('✖ adb install 失败（设备未连接或签名冲突：debug 签名与正式包冲突时需先卸载旧版）'); return 1; }
  } else {
    console.log('（未指定 --install，跳过安装；需要时：node scripts/build-apk.js --install）');
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main };
