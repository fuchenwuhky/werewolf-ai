#!/usr/bin/env node
/**
 * device-check.js —— 仓内可复跑的 Android 设备验证（guidance §5 :186 的"设备"列，:193 要求把仓外探针收进仓内）。
 *
 * 为什么不只是"跑一次 adb 看点输出"：
 *   · 每条判据都由**被测设备自己的返回**决定，脚本只断言，不预置结论；
 *   · 退出码明确：任何一条判据不成立即 EXIT 1（不静默、不"看起来还行"）；
 *   · 全部路径与包名可用环境变量覆盖，**便于取红轮**（例如指向一个不存在的包名，脚本必须如实失败）。
 *
 * 用法：
 *   node scripts/device-check.js                       # 绿轮：按默认包名校验 MuMu 上的安装包
 *   PKG=com.nonexistent.org.app node scripts/device-check.js   # 红轮：包不存在，必须 EXIT 1
 *   ADB=<adb 路径> SHOTS=<截图目录> node scripts/device-check.js
 *
 * 环境变量：
 *   ADB    adb 可执行文件（默认 D:\android-sdk\platform-tools\adb.exe，找不到则退回 PATH 里的 adb）
 *   PKG    应用包名（默认 com.werewolfai.app）
 *   SHOTS  截图输出目录（默认 <仓库>/logs/device；该目录被 gitignore，属本机证据，不算交付）
 *   SERIAL 指定设备序列号（默认取第一台 state=device 的设备）
 *
 * 退出码：0 = 全部判据成立；1 = 有判据不成立（每条 ✗ 都带设备返回的原文）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ADB = process.env.ADB || 'D:\\android-sdk\\platform-tools\\adb.exe';
const PKG = process.env.PKG || 'com.werewolfai.app';
const SHOTS = process.env.SHOTS || path.join(ROOT, 'logs', 'device');
const SERIAL = process.env.SERIAL || '';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

function adb(args, opts) {
  const o = Object.assign({ encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 }, opts || {});
  const argv = SERIAL ? ['-s', SERIAL].concat(args) : args;
  try {
    return { ok: true, out: execFileSync(ADB, argv, o) };
  } catch (e) {
    return { ok: false, out: String((e && (e.stdout || e.message)) || e) };
  }
}

function main() {
  console.log(`device-check：包名 ${PKG}`);
  console.log(`  adb = ${ADB}`);
  console.log(`  截图目录 = ${SHOTS}`);

  // 1) adb 可用
  const ver = adb(['version']);
  check('adb 可执行且能报版本', ver.ok && /Android Debug Bridge/i.test(ver.out), (ver.out || '').split('\n')[0].trim());

  // 2) 有设备在线（state=device），并记录序列号
  const devs = adb(['devices']);
  const lines = (devs.out || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(1);
  const online = lines.filter((l) => /\tdevice$/.test(l)).map((l) => l.split('\t')[0]);
  check('至少一台设备处于 device 状态', online.length > 0, `在线=${online.join(',') || '无'}；全部=${lines.join(' | ') || '无'}`);

  // 3) 设备基本信息（型号 / Android 版本 / 物理分辨率）—— 作为"这是真机不是模拟输出"的旁证
  const model = adb(['shell', 'getprop', 'ro.product.model']);
  const rel = adb(['shell', 'getprop', 'ro.build.version.release']);
  const size = adb(['shell', 'wm', 'size']);
  const modelTxt = (model.out || '').trim();
  const relTxt = (rel.out || '').trim();
  const sizeTxt = (size.out || '').trim();
  check('读得到设备型号与系统版本', !!modelTxt && !!relTxt, `model=${modelTxt} android=${relTxt}`);
  check('读得到物理分辨率', /Physical size: \d+x\d+/.test(sizeTxt), sizeTxt);

  // 4) 包已安装（并且拿得到版本号 —— 制品一致性的可核部分）
  const dumpsys = adb(['shell', 'dumpsys', 'package', PKG]);
  const installed = /versionName=/.test(dumpsys.out || '');
  const vm = /versionName=([^\s]+)/.exec(dumpsys.out || '');
  const vc = /versionCode=(\d+)/.exec(dumpsys.out || '');
  check('应用包已安装在设备上', installed, installed ? `versionName=${vm ? vm[1] : '?'} versionCode=${vc ? vc[1] : '?'}` : '设备上没有这个包');

  // 5) 真启动：force-stop 后注入 LAUNCHER intent
  adb(['shell', 'am', 'force-stop', PKG]);
  const launch = adb(['shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1']);
  const injected = /Events injected: \d+/.test(launch.out || '');
  const noAct = /No activities found/i.test(launch.out || '');
  check('能对目标包注入启动事件', injected && !noAct, injected ? 'Events injected' : (noAct ? 'No activities found（包内没有该 LAUNCHER Activity）' : '未注入'));

  // 6) 前台 Activity 真的是它（这一步才叫"运行通过"，而不是"装上了"）
  let foreground = '';
  for (let i = 0; i < 20; i += 1) {
    const act = adb(['shell', 'dumpsys', 'activity', 'activities']);
    // 只在 ActivityRecord{...} 里找**含斜杠的那个 token**（形如 com.werewolfai.app/.MainActivity）。
    // 上一版用 ActivityRecord\{[^}]*\s([^\s}]+) 去取，贪婪匹配一路吃到花括号前的最后一段，抓到的是
    // 末尾的 task id（实测拿到 "t34"）而不是组件名 —— 判据因此假红，这里改成按 token 找斜杠。
    const rec = /(?:topResumedActivity|mResumedActivity)=ActivityRecord\{([^}]*)\}/.exec(act.out || '');
    const comp = rec ? (rec[1].split(/\s+/).find((t) => t.indexOf('/') > 0) || '') : '';
    foreground = comp;
    if (foreground.indexOf(PKG) === 0) break;
    // 同步等待 1.5s：上一版这里用 execFileSync(node, ['-e','setTimeout…']) 冒充 sleep，能跑但笨且慢。
    // Node 里同步等待用 Atomics.wait 最干净，不启子进程、不依赖 shell。
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  }
  check('前台 Activity 属于目标包（真运行，不是只装上）', foreground.indexOf(PKG) === 0, foreground || '读不到前台 Activity');

  // 7) 进程存活
  const ps = adb(['shell', 'ps', '-A']);
  const alive = new RegExp('\\s' + PKG.replace(/\./g, '\\.') + '\\s*$', 'm').test(ps.out || '');
  check('应用进程存活', alive, alive ? 'ps 命中' : 'ps 未命中');

  // 8) 截图非空且是 PNG（本机证据，用于人眼复核画面层）
  fs.mkdirSync(SHOTS, { recursive: true });
  const shot = path.join(SHOTS, 'emu-01-home.png');
  try {
    const buf = execFileSync(ADB, (SERIAL ? ['-s', SERIAL] : []).concat(['exec-out', 'screencap', '-p']), { maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
    fs.writeFileSync(shot, buf);
    const isPng = buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    // 交接点：同一张真机图再写一份到 logs/ui-shots/，交给 scripts/ui-capture.js 上仓核对。
    // 上一版我只给 capture 脚本登记了 EMU- 前缀，却没注意 device-check 写的是 logs/device/、
    // 而 capture 读的是 logs/ui-shots/ —— 两个目录不同，结果真机图一张也没进仓。
    // 两份都落在 gitignore 下的本机目录，进仓的是 capture 复制到 docs/evidence 的那一份。
    fs.mkdirSync(path.join(ROOT, 'logs', 'ui-shots'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'logs', 'ui-shots', 'EMU-mumu-android12-home.png'), buf);
    // 结构判据：PNG 签名 + IHDR 里的宽高应等于设备物理分辨率（这才是"截图有效"的硬证据）。
    const ihdr = isPng && buf.slice(12, 16).toString('latin1') === 'IHDR';
    const w = ihdr ? buf.readUInt32BE(16) : 0;
    const h = ihdr ? buf.readUInt32BE(20) : 0;
    const sizeM = /Physical size: (\d+)x(\d+)/.exec(sizeTxt);
    const expW = sizeM ? Number(sizeM[1]) : 0;
    const expH = sizeM ? Number(sizeM[2]) : 0;
    // 朝向要容错：实测这台 MuMu 当时是横屏（截图 1920x1080）而 wm size 报的是竖屏物理尺寸
    // （1080x1920），上一版只认一种朝向就假红了。宽高对调也算成立，并把实际朝向打出来。
    const sameOrientation = w === expW && h === expH;
    const rotated = w === expH && h === expW;
    check('真机截图是有效 PNG 且宽高等于设备物理分辨率（允许横竖对调）', isPng && ihdr && (sameOrientation || rotated),
      `png=${isPng} ihdr=${ihdr} 截图 ${w}x${h} / wm size ${expW}x${expH} → ${rotated ? '横屏（与 wm size 对调）' : (sameOrientation ? '同向' : '不符')} → ${shot}`);
    // 画面内容这条**单列且只记录**：字节数小往往意味着空白/纯黑帧，但脚本无权断言"画面正常"，
    // 上一版我拿 20000 字节当阈值，把"PNG 有效"和"画面有内容"混成一条，结果 14262 字节时假红。
    console.log(`  · 截图字节数 ${buf.length}（仅记录，不作判据）${buf.length < 40000 ? ' ⚠ 偏小，疑似空白帧，需人眼复核' : ''}`);
  } catch (e) {
    check('真机截图是有效 PNG 且宽高等于设备物理分辨率', false, String((e && e.message) || e));
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - bad.length}/${results.length} 条判据成立`);
  if (bad.length) {
    console.log('未成立：' + bad.map((r) => r.name).join('；'));
    process.exit(1);
  }
  process.exit(0);
}

main();
